import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
const npmCli=process.env.npm_execpath??process.env.NPM_CLI;
if(!npmCli)throw new Error('Run via npm run rqlite:test:package or set NPM_CLI');
const artifactDir=path.resolve(process.env.RQLITE_ARTIFACT_DIR??'artifacts/rqlite-validation');mkdirSync(artifactDir,{recursive:true});
function node(args,cwd,expected=0){
  const result=spawnSync(process.execPath,args,{cwd,encoding:'utf8',env:process.env});
  if(result.error)throw result.error;
  assert.equal(result.status,expected,result.stdout+'\n'+result.stderr);
  return result.stdout.trim();
}
let tarball=process.argv[2];
const packResult=text=>{const result=JSON.parse(text);return Array.isArray(result)?result[0]:result.files?result:result[Object.keys(result)[0]];};
if(!tarball){
  const inspection=packResult(node([npmCli,'pack','--dry-run','--json'],process.cwd()));
  for(const file of inspection.files)assert.match(file.path,/^(dist\/|README\.md$|LICENSE$|package\.json$)/);
  writeFileSync(path.join(artifactDir,'pack-inspection.json'),JSON.stringify(inspection,null,2));
  const packed=packResult(node([npmCli,'pack','--pack-destination',artifactDir,'--json'],process.cwd()));
  tarball=path.join(artifactDir,packed.filename);
}
tarball=path.resolve(tarball);
const consumer=mkdtempSync(path.join(tmpdir(),'rqlite-client-consumer-'));
writeFileSync(path.join(consumer,'package.json'),JSON.stringify({name:'orm-external-consumer',version:'1.0.0',private:true,type:'module'}));
node([npmCli,'install','--ignore-scripts','--no-audit','--no-fund',tarball,'typescript@7.0.2'],consumer);
const cli=path.join(consumer,'node_modules/@cubs/rqlite-client/dist/cli/index.js');
const url=process.env.RQLITE_CONSUMER_URL??'http://127.0.0.1:18016';
writeFileSync(path.join(consumer,'bare.mjs'),`import {createClient} from '@cubs/rqlite-client';
const db=createClient({connection:{url:${JSON.stringify(url)}}});
if(Object.keys(db.models).length||!await db.isReady())throw new Error('Bare client is not ready');
await db.assertReady();
const rows=await db.sql.query('SELECT 1 AS value');
if(rows[0]?.value!==1)throw new Error('Bare client query failed');`);
node(['bare.mjs'],consumer);
writeFileSync(path.join(consumer,'rqlite.config.js'),`export default {schemas:['schemas'],output:'generated/schema.ts',migrations:'migrations',build:{config:'dist/rqlite.config.js',client:'dist/generated/schema.js',migrations:'dist/migrations'},environments:{test:{url:${JSON.stringify(url)},development:true},production:{url:${JSON.stringify(url)},development:false}}};`);
mkdirSync(path.join(consumer,'schemas'));
writeFileSync(path.join(consumer,'schemas/Base.schema.ts'),`import {MappedSuperclass,Column,PrimaryKey,Generated,CreatedAt,UpdatedAt,Default,sql} from '@cubs/rqlite-client/schema';
@MappedSuperclass() export abstract class Base {
 @Column() @PrimaryKey() @Generated('ulid') id!: string;
 @CreatedAt() created_on!: string;
 @UpdatedAt() changed_on!: string;
 constructor(){throw new Error('Schema constructors must not execute');}
}`);
let item=`import {Table,Column,Default,Json,Integer} from '@cubs/rqlite-client/schema'; import {Base} from './Base.schema.js';
@Table('items',{softDelete:'deleted_at'}) export class Item extends Base {
 @Column() @Default('untitled') title!: string | null;
 @Column() @Json() @Default('{}') data!: Record<string,unknown>;
 @Column() @Default(true) active!: boolean;
 @Column() @Integer() @Default(0) count!: number;
 @Column() @Default(null) deleted_at!: string | null;
}`;
const schemaFile=path.join(consumer,'schemas/Item.schema.ts');writeFileSync(schemaFile,item);
const command=(...args)=>node([npmCli,'exec','--offline','--','rqlite',...args],consumer);
command('init');command('create','migration','create items');
item=item.replace(/}\s*$/," @Column() @Default(null) note!: string | null;\n}");writeFileSync(schemaFile,item);
writeFileSync(path.join(consumer,'project.mjs'),`import {loadProject} from '@cubs/rqlite-client/project';const project=await loadProject();const m=await project.createMigration('add note');if(!m)throw new Error('Expected programmatic migration');`);
node(['project.mjs'],consumer);
assert.equal(command('create','migration','no change'),'No schema changes');
node([cli,'migrate','sttaus','--environment','test'],consumer,1);
node([cli,'migrate','--unknown','--environment','test'],consumer,1);
node([cli,'migration:up','--environment','test'],consumer,1);
assert.deepEqual(JSON.parse(command('migrate','--dry-run','--environment','test')).applied,[]);
// Both independent processes reach the same pending state before either applies it.
writeFileSync(path.join(consumer,'race.mjs'),`import {writeFileSync,existsSync} from 'node:fs';
import {RqliteClient} from '@cubs/rqlite-client';import {MigrationRunner} from '@cubs/rqlite-client/migrations';
const runner=new MigrationRunner(new RqliteClient({url:${JSON.stringify(url)}}),'migrations');
const status=runner.status.bind(runner);let calls=0;
runner.status=async()=>{const result=await status();if(++calls===2){if(result.pending.length!==2)throw new Error('Expected both migrations pending');writeFileSync('race-'+process.pid+'.ready','');const limit=Date.now()+30000;while(!existsSync('race.go')){if(Date.now()>limit)throw new Error('Race barrier timed out');await new Promise(r=>setTimeout(r,25));}}return result;};
await runner.up();`);
const race=[0,1].map(()=>new Promise(resolve=>{const child=spawn(process.execPath,['race.mjs'],{cwd:consumer,stdio:['ignore','pipe','pipe']});let output='';child.stdout.on('data',c=>output+=c);child.stderr.on('data',c=>output+=c);child.on('error',e=>resolve({code:-1,output:String(e)}));child.once('exit',code=>resolve({code,output}));}));
const raceDeadline=Date.now()+30000;
while(readdirSync(consumer).filter(f=>/^race-.*\.ready$/.test(f)).length!==2){if(Date.now()>raceDeadline)throw new Error('Concurrent runners did not reach barrier');await new Promise(r=>setTimeout(r,100));}
writeFileSync(path.join(consumer,'race.go'),'');
const raceResults=await Promise.all(race);assert(raceResults.some(r=>r.code===0),JSON.stringify(raceResults));
assert.deepEqual(JSON.parse(command('migrate','status','--environment','test')).pending,[]);
command('check','--database','--environment','test');
writeFileSync(path.join(consumer,'tsconfig.json'),JSON.stringify({compilerOptions:{target:'ES2022',module:'NodeNext',moduleResolution:'NodeNext',outDir:'dist',strict:true,skipLibCheck:true},include:['schemas/*.ts','generated/*.ts','migrations/*.ts','smoke.ts']}));
writeFileSync(path.join(consumer,'smoke.ts'),`import {createClient} from '@cubs/rqlite-client';
import {schema} from './generated/schema.js';
import './schemas/Item.schema.js';
const client=createClient({schema,connection:{url:${JSON.stringify(url)}},migrations:{directory:'migrations'}});
await client.assertReady();
const repo=client.models.items;
if(false){
 // @ts-expect-error managed clocks must not be creation inputs
 await repo.create({created_on:'caller value'});
 // @ts-expect-error wrong scalar type
 await repo.update({count:'invalid'},{id:'id'});
 // @ts-expect-error unknown lookup property
 await repo.find({missing:'id'});
}
const first=await repo.create({});
if(first.title!=='untitled'||!first.active||first.count!==0||first.id.length!==26||first.created_on==='CURRENT_TIMESTAMP')throw new Error('Defaults or generators failed');
const second=await repo.create({id:'explicit-id',title:null,active:false,data:{quote:"O'Brien"}});
if(second.title!==null||second.active!==false||second.data.quote!=="O'Brien")throw new Error('Null/boolean/JSON codec failed');
await new Promise(resolve=>setTimeout(resolve,1100));
await repo.update({count:2},{id:first.id});
const updated=await repo.find({id:first.id});
if(updated?.count!==2||updated.changed_on===first.changed_on)throw new Error('Managed update clock failed');
if(await repo.delete({id:second.id})!==1||await repo.find({id:second.id})!==null)throw new Error('Soft delete failed');
if(await repo.delete({id:second.id})!==0)throw new Error('Repeated soft delete changed rows');
console.log('Typed external CRUD, defaults, JSON, boolean, clocks and soft delete passed');`);
node([path.join(consumer,'node_modules/typescript/bin/tsc'),'--project','tsconfig.json'],consumer);
console.log(node(['dist/smoke.js'],consumer));
node([cli,'watch','--apply','--environment','production'],consumer,1);
writeFileSync(path.join(consumer,'watch-server.mjs'),`import {writeFileSync} from 'node:fs';
import {RqliteClient} from '@cubs/rqlite-client';
const client=new RqliteClient({url:${JSON.stringify(url)}});
await client.query('SELECT * FROM items LIMIT 1');
writeFileSync('watch-server.pid',String(process.pid));
console.log('server:ready');setInterval(()=>{},1000);`);
const watcher=spawn(process.execPath,[cli,'watch','--apply','--environment','test','--run','watch-server.mjs'],{cwd:consumer,stdio:['ignore','pipe','pipe']});
let output='';watcher.stdout.on('data',chunk=>output+=chunk);watcher.stderr.on('data',chunk=>output+=chunk);
async function until(condition){const deadline=Date.now()+20000;while(!condition()){if(watcher.exitCode!==null||Date.now()>deadline)throw new Error('Watch failed: '+output);await new Promise(r=>setTimeout(r,100));}}
try{
  await until(()=>output.includes('server:ready'));
  let firstServer=Number(readFileSync(path.join(consumer,'watch-server.pid'),'utf8'));
  const alive=pid=>{try{process.kill(pid,0);return true;}catch{return false;}};
  // Metadata-only changes still require fresh descriptors and a server restart.
  item=item.replace('Record<string,unknown>','{quote?: string}');writeFileSync(schemaFile,item);
  await until(()=>output.split('server:ready').length>=3);
  assert.equal(alive(firstServer),false);
  assert.equal(JSON.parse(command('migrate','status','--environment','test')).applied.length,2);
  node([path.join(consumer,'node_modules/typescript/bin/tsc'),'--project','tsconfig.json'],consumer);
  firstServer=Number(readFileSync(path.join(consumer,'watch-server.pid'),'utf8'));
  item=item.replace(/}\s*$/," @Column() @Default(null) extra!: string | null;\n}");writeFileSync(schemaFile+'.tmp',item);
  const {renameSync}=await import('node:fs');renameSync(schemaFile+'.tmp',schemaFile);
  await until(()=>output.includes('Schema changes pending'));
  await until(()=>!alive(firstServer));
  command('create','migration','watch addition');
  await until(()=>output.split('server:ready').length>=4);
  const secondServer=Number(readFileSync(path.join(consumer,'watch-server.pid'),'utf8'));
  command('check','--database','--environment','test');
  command('create','migration','manual data check','--manual');
  await until(()=>output.includes('Draft migration blocks'));
  await until(()=>!alive(secondServer));
  const journal=JSON.parse(readFileSync(path.join(consumer,'migrations/meta/journal.json'),'utf8'));
  const last=journal.entries.at(-1),file=path.join(consumer,'migrations',last.file);
  const source=readFileSync(file,'utf8');const migration=JSON.parse(source.slice(source.indexOf('=')+1,source.lastIndexOf(' as const;')).trim());
  migration.up=[{text:'UPDATE items SET count=? WHERE deleted_at IS NULL',values:[3]}];
  writeFileSync(file,'export const migration = '+JSON.stringify(migration)+' as const;');
  command('finalize','migration','--data-only');
  command('migrate','--environment','test','--allow-manual');
  command('check','--database','--environment','test');
}finally{watcher.kill();await new Promise(resolve=>{if(watcher.exitCode!==null)resolve();else watcher.once('exit',resolve);});}
node([path.join(consumer,'node_modules/typescript/bin/tsc'),'--project','tsconfig.json'],consumer);
command('prepare');
writeFileSync(path.join(consumer,'no-compiler.mjs'),`import {registerHooks} from 'node:module';registerHooks({resolve(s,c,next){if(s==='typescript-compiler'||s.startsWith('typescript-compiler/')||s==='tsx'||s.startsWith('tsx/'))throw new Error('Unexpected compiler import');return next(s,c);}});`);
node(['--import','./no-compiler.mjs',cli,'check','--config','dist/rqlite.config.js','--database','--environment','test'],consumer);
const report={platform:process.platform,node:process.version,consumer,tarball,checks:['tarball allowlist','npx rqlite executable','TypeScript 7 inferred client and rejected invalid inputs','modern decorators in emitted Node JS','CLI and programmatic generation','two pending migrations and two processes at the same predecessor','typed CRUD/codecs/automatic clocks','watch metadata-only regeneration and restart without migration','watch atomic rename and apply','server stops on pending schema and restarts after migration','draft blocking and server shutdown','manual finalization','production autoapply refusal','prepare and compiled readiness without compiler/tsx']};
writeFileSync(path.join(artifactDir,'consumer-'+process.platform+'.json'),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report,null,2));
