import {existsSync,readFileSync,readdirSync,cpSync,mkdirSync} from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {spawn,type ChildProcess} from 'node:child_process';
import {RqliteClient,basicAuthFromEnv} from './client/index.js';
import {createClient,type ClientSchema,type ModelTypes} from './runtime.js';
import {emptySchema,type RqliteConfig} from './config.js';
import {addMigration,atomicWrite,catalog,loadChain,MigrationRunner,migrationChecksum,schemaHash,withGenerationLock} from './migrations/index.js';
import {createTableSql,createIndexSql} from './dialect/index.js';
import {schemaFiles,watchFiles} from './cli/watch.js';
import {hash} from './canonical.js';
import type {RenameMap} from './migrations/planner.js';

export async function loadProject(file = existsSync('rqlite.config.ts') ? 'rqlite.config.ts' : 'rqlite.config.js') {
  const absolute=path.resolve(file);
  const config=(await import(pathToFileURL(absolute).href)).default as RqliteConfig;
  return createProject(config,{root:path.dirname(absolute),configFile:absolute});
}
export function createProject(config:RqliteConfig,options:{root?:string;configFile?:string}={}) {
  // JS config files do not have TypeScript's excess-property checks. Reject
  // literal credentials before prepare can copy them into a runtime artifact.
  for(const environment of Object.values(config.environments)) {
    if(environment.auth && (Object.keys(environment.auth).some(key=>!['usernameEnv','passwordEnv'].includes(key))
      || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(environment.auth.usernameEnv??'')
      || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(environment.auth.passwordEnv??'')))
      throw new Error('Database auth configuration must contain only usernameEnv and passwordEnv references');
    if(environment.url) {
      const url=new URL(environment.url);
      if(url.username||url.password)throw new Error('Database config URLs must not contain credentials');
    }
  }
  const resolve=(f:string)=>path.resolve(options.root??process.cwd(),f);
  const directory=resolve(config.migrations);
  let dependencies:string[]=[];
  const connection=(environment:string)=>{
    const e=config.environments[environment];if(!e)throw new Error('Choose a configured environment explicitly');
    if(e.urlEnv&&!process.env[e.urlEnv]&&!e.url&&!e.host&&!e.hostEnv)throw new Error(`Missing configured database URL: ${e.urlEnv}`);
    const url=(e.urlEnv&&process.env[e.urlEnv])||e.url||`http://${(e.hostEnv&&process.env[e.hostEnv])||e.host||'127.0.0.1'}:${(e.portEnv&&process.env[e.portEnv])||e.port||'4001'}`;
    const auth=e.auth?basicAuthFromEnv(e.auth.usernameEnv,e.auth.passwordEnv):undefined;
    if(e.auth&&!auth)throw new Error('Missing configured database credentials');
    return {url,...(auth?{auth}:{})};
  };
  const runner=(environment:string)=>new MigrationRunner(new RqliteClient(connection(environment)),directory);
  const compile=async()=>{
    if(!config.schemas||!config.output)throw new Error('Source schemas/output are required for this development operation');
    const compiler=await import('./compiler/index.js');
    const result=compiler.compile(schemaFiles(config.schemas.map(resolve)));dependencies=result.dependencies;
    if(result.diagnostics.length)throw new Error(result.diagnostics.map(d=>`${d.code}: ${d.message}`).join('\n'));
    if(config.opaqueObjects)result.schema.opaque=JSON.parse(readFileSync(resolve(config.opaqueObjects),'utf8'));
    return {schema:result.schema,emit:(check=false)=>compiler.emitDescriptors(result.schema,resolve(config.output!),check)};
  };
  const artifact=async()=>{
    if(!config.client)throw new Error('Compiled client path is required for runtime readiness');
    return (await import(pathToFileURL(resolve(config.client)).href)).schema as ClientSchema<Record<string,ModelTypes>>;
  };
  const api={
    async init(){await withGenerationLock(directory,async()=>{
      const file=path.join(directory,'meta/journal.json');if(existsSync(file))throw new Error('Journal already exists');
      if(readdirSync(directory).some(f=>/\.(ts|js)$/.test(f)))throw new Error('Existing migrations require an explicit history adoption');
      atomicWrite(file,JSON.stringify({formatVersion:1,baseline:emptySchema(),baselineCatalog:'[]',legacy:[],entries:[]},null,2)+'\n');
    });},
    async generate(){const result=await compile();result.emit();return result.schema;},
    async check(environment?:string){
      if(config.schemas){const result=await compile();result.emit(true);const chain=await loadChain(directory);
        if(schemaHash(result.schema)!==schemaHash(chain.schemas.at(-1)??chain.journal.baseline))throw new Error('Schemas have changes without a generated migration');
        if(chain.migrations.some(m=>m.state!=='ready'))throw new Error('Draft migrations are incomplete');
        if(environment&&(await runner(environment).status()).pending.length)throw new Error('Database migrations are pending');
      }else{if(!environment)throw new Error('Runtime readiness requires an explicit environment');await createClient({schema:await artifact(),connection:connection(environment),migrations:{directory}}).assertReady();}
    },
    async createMigration(description:string,flags:{manual?:boolean;renames?:RenameMap}={}){const result=await compile();const migration=await addMigration(directory,result.schema,description,flags);result.emit();return migration;},
    async finalizeMigration(flags:{dataOnly?:boolean;verifiedUrl?:string}={}){
      await withGenerationLock(directory,async()=>{
        const {journal,migrations,schemas}=await loadChain(directory,true);const m=migrations.at(-1);
        if(!m||m.state!=='draft')throw new Error('No editable draft');if(!m.up.length)throw new Error('Draft has no statements');
        if(flags.dataOnly){if(m.beforeSchemaHash!==m.afterSchemaHash)throw new Error('Data-only migration changes schema');m.dataOnly=true;}
        else{
          if(!flags.verifiedUrl)throw new Error('Use --data-only, or rehearse structural SQL and provide --verified-url');
          const verified=await catalog(new RqliteClient({url:flags.verifiedUrl}));
          const physical=JSON.parse(verified) as {name:string;type:string;sql:string}[];const expected=schemas.at(-1)!;
          for(const table of expected.tables){
            if(physical.find(o=>o.type==='table'&&o.name===table.name)?.sql!==createTableSql(table))throw new Error(`Verification SQL differs for ${table.name}; rehearse canonical DDL before finalizing`);
            for(const index of table.indexes)if(physical.find(o=>o.type==='index'&&o.name===index.name)?.sql!==createIndexSql(table.name,index))throw new Error(`Verification index differs for ${index.name}`);
          }
          for(const o of expected.opaque)if(physical.find(p=>p.name===o.name)?.sql!==o.sql)throw new Error(`Verification differs for ${o.name}`);
          const allowed=new Set([...expected.tables.map(t=>t.name),...expected.tables.flatMap(t=>t.indexes.map(i=>i.name)),...expected.opaque.map(o=>o.name)]);
          if(physical.some(o=>!allowed.has(o.name)))throw new Error('Unexpected verification objects');m.verifiedCatalog=verified;
        }
        m.state='ready';m.checksum=migrationChecksum(m);const entry=journal.entries.at(-1)!;entry.checksum=m.checksum;
        atomicWrite(path.join(directory,entry.file),`export const migration = ${JSON.stringify(m,null,2)} as const;\n`);
        atomicWrite(path.join(directory,'meta/journal.json'),JSON.stringify(journal,null,2)+'\n');
      });
    },
    status:(environment:string)=>runner(environment).status(),
    migrate:(environment:string,flags:{allowManual?:boolean;allowDestructive?:boolean}={})=>runner(environment).up(flags),
    wait:(environment:string,flags?:{attempts?:number;intervalMs?:number})=>new RqliteClient(connection(environment)).waitUntilReady(flags),
    async prepare(){
      await api.check();if(!config.build)throw new Error('Configure compiled build paths');
      const target=resolve(config.build.migrations),source=path.resolve(directory);
      if(target===source)throw new Error('Compiled migrations must have a separate destination');
      mkdirSync(target,{recursive:true});const chain=await loadChain(directory);
      for(const id of [...chain.journal.legacy.map(m=>m.id),...chain.migrations.map(m=>m.id)])if(!existsSync(path.join(target,id+'.js')))throw new Error(`Compile migration before prepare: ${id}`);
      cpSync(path.join(directory,'meta'),path.join(target,'meta'),{recursive:true});
      if(!existsSync(resolve(config.build.client)))throw new Error('Compile generated client before prepare');
      const targetConfig=resolve(config.build.config),base=path.dirname(targetConfig);
      const runtime={migrations:path.relative(base,target).replaceAll('\\','/'),client:path.relative(base,resolve(config.build.client)).replaceAll('\\','/'),environments:config.environments};
      atomicWrite(targetConfig,'export default '+JSON.stringify(runtime,null,2)+';\n');
      await loadChain(target);return targetConfig;
    },
    async watch(flags:{apply?:boolean;environment?:string;run?:string;signal?:AbortSignal;log?:(message:string)=>void}={}){
      if(!config.schemas)throw new Error('Watch requires source schemas');
      if(flags.apply&&(!flags.environment||!config.environments[flags.environment]?.development))throw new Error('Watch --apply requires a configured development target');
      if(flags.run&&!flags.apply)throw new Error('--run requires --apply');
      const log=flags.log??console.log;let child:ChildProcess|undefined,readyHash='';
      const stopChild=async()=>{const c=child;child=undefined;readyHash='';if(c&&c.exitCode===null)await new Promise<void>(r=>{c.once('exit',()=>r());c.kill();});};
      try{await watchFiles({signal:flags.signal,files:()=>{
        const files=[...(options.configFile?[options.configFile]:[]),...schemaFiles(config.schemas!.map(resolve)),...dependencies,path.join(directory,'meta/journal.json')];
        if(config.opaqueObjects)files.push(resolve(config.opaqueObjects));
        try{const j=JSON.parse(readFileSync(path.join(directory,'meta/journal.json'),'utf8'));for(const e of j.entries)files.push(path.join(directory,e.file),path.join(directory,'meta',e.snapshot));for(const e of j.legacy)files.push(path.join(directory,e.id+'.ts'));}catch{}
        return files;
      },run:async()=>{
        const result=await compile(),chain=await loadChain(directory);
        if(schemaHash(result.schema)!==schemaHash(chain.schemas.at(-1)??chain.journal.baseline)){log('Schema changes pending: run rqlite create migration');if(flags.apply){await stopChild();return;}}
        if(chain.migrations.some(m=>m.state!=='ready'))throw new Error('Draft migration blocks application');
        const targetHash=hash(result.schema)+':'+(chain.migrations.at(-1)?.checksum??'baseline');
        if(flags.run&&targetHash!==readyHash)await stopChild();
        if(flags.apply)await api.migrate(flags.environment!);result.emit();
        if(flags.run&&targetHash!==readyHash){child=spawn(process.execPath,['--import','tsx',resolve(flags.run)],{stdio:'inherit',env:process.env});readyHash=targetHash;}
        log('watch:ready');
      },onError:async e=>{log(String(e));await stopChild();}});}finally{await stopChild();}
    },
  };
  return api;
}
