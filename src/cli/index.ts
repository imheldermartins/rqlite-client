#!/usr/bin/env node
import {readFileSync} from 'node:fs';
import {loadProject} from '../project.js';
export async function main(args=process.argv.slice(2)):Promise<void>{
  const help='rqlite init | generate | check [--database] | create migration <description> [--manual] | finalize migration [--data-only | --verified-url URL] | migrate [status | --dry-run] --environment NAME | watch [--apply --environment NAME --run script.ts] | prepare | wait --environment NAME\nConfiguration: --config rqlite.config.ts; --env-file loads an explicit environment file.';
  if(!args.length||args.includes('--help')||args[0]==='help'){console.log(help);return;}
  const flag=(name:string)=>args.includes(name);
  const value=(name:string)=>{const i=args.indexOf(name);if(i<0)return;const v=args[i+1];if(!v||v.startsWith('--'))throw new Error(`Missing value for ${name}`);return v;};
  const command=args[0],environment=()=>{const e=value('--environment');if(!e)throw new Error('Choose --environment explicitly');return e;};
  if(!['init','generate','check','create','finalize','migrate','watch','prepare','wait'].includes(command))throw new Error(`Unknown command: ${command}\n${help}`);
  const values=new Set(['--config','--env-file','--environment',...(command==='create'?['--renames']:[]),...(command==='finalize'?['--verified-url']:[]),...(command==='watch'?['--run']:[])]);
  const switches=new Set(({check:['--database'],create:['--manual'],finalize:['--data-only'],migrate:['--dry-run','--allow-manual','--allow-destructive'],watch:['--apply']} as Record<string,string[]>)[command]??[]);
  const positional=[command],seen=new Set<string>();
  for(let i=1;i<args.length;i++){
    const arg=args[i];if(!arg.startsWith('-')){positional.push(arg);continue;}
    if(seen.has(arg))throw new Error(`Duplicate option: ${arg}`);seen.add(arg);
    if(values.has(arg)){value(arg);i++;}else if(!switches.has(arg))throw new Error(`Unknown option: ${arg}`);
  }
  if(command==='migrate'&&(positional.length>2||(positional[1]&&positional[1]!=='status')))throw new Error('Use rqlite migrate or rqlite migrate status');
  if(command==='create'&&(positional.length!==3||positional[1]!=='migration'))throw new Error('Use rqlite create migration <description>');
  if(command==='finalize'&&(positional.length!==2||positional[1]!=='migration'))throw new Error('Use rqlite finalize migration');
  if(!['migrate','create','finalize'].includes(command)&&positional.length!==1)throw new Error(`Unexpected argument for ${command}`);
  const envFile=value('--env-file');if(envFile)process.loadEnvFile(envFile);
  const project=await loadProject(value('--config'));
  switch(command){
    case 'init':await project.init();console.log('Initialized empty migration chain');break;
    case 'generate':await project.generate();console.log('Generated typed client');break;
    case 'check':await project.check(flag('--database')?environment():undefined);console.log('Schema, generated client and migration chain verified');break;
    case 'create':{
      const renames=value('--renames');const m=await project.createMigration(positional[2],{manual:flag('--manual'),renames:renames?JSON.parse(readFileSync(renames,'utf8')):undefined});
      console.log(m?`Migration created: ${m.id} (${m.state})`:'No schema changes');break;
    }
    case 'finalize':await project.finalizeMigration({dataOnly:flag('--data-only'),verifiedUrl:value('--verified-url')});console.log('Migration finalized');break;
    case 'migrate':console.log(JSON.stringify(positional[1]==='status'||flag('--dry-run')?await project.status(environment()):await project.migrate(environment(),{allowManual:flag('--allow-manual'),allowDestructive:flag('--allow-destructive')}),null,2));break;
    case 'prepare':console.log('Prepared',await project.prepare());break;
    case 'wait':await project.wait(environment(),{attempts:Number(process.env.DATABASE_WAIT_ATTEMPTS)||30,intervalMs:Number(process.env.DATABASE_WAIT_INTERVAL_MS)||2000});console.log('Database ready');break;
    case 'watch':{const abort=new AbortController();const stop=()=>abort.abort();process.once('SIGINT',stop);process.once('SIGTERM',stop);try{await project.watch({apply:flag('--apply'),environment:value('--environment'),run:value('--run'),signal:abort.signal});}finally{process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);}break;}
  }
}
main().catch(error=>{console.error(error instanceof Error?error.message:String(error));process.exitCode=1;});
