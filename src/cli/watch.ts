import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { hash } from '../canonical.js';
export function schemaFiles(roots: string[]): string[] {
  const files: string[]=[];
  for(const root of roots) {
    if(root.endsWith('.ts')) { files.push(path.resolve(root)); continue; }
    const walk=(dir:string)=>{for(const item of readdirSync(dir,{withFileTypes:true})) {
      if(['node_modules','dist','.git'].includes(item.name)) continue;
      const full=path.join(dir,item.name);
      if(item.isDirectory()) walk(full); else if(item.name.endsWith('.schema.ts')) files.push(path.resolve(full));
    }}; walk(root);
  }
  return files.sort();
}
export function fingerprint(files:string[]):string {
  return hash([...new Set(files)].sort().map(f=>{try{return [f,readFileSync(f,'utf8')];}catch{return [f,null];}}));
}
/** Stable two-scan polling handles Windows/Linux editor rename saves and coalesces event storms. */
export async function watchFiles(options:{files:()=>string[];run:()=>Promise<void>;signal?:AbortSignal;intervalMs?:number;onError?:(error:unknown)=>void|Promise<void>}):Promise<void> {
  let previous='',completed='';
  while(!options.signal?.aborted) {
    try {
      const current=fingerprint(options.files());
      if(current===previous && current!==completed) {
        // One awaited task at a time; failures wait for a changed input before retrying.
        completed=current;
        try {await options.run();} catch(error) {await options.onError?.(error);}
      }
      previous=current;
    } catch(error) { await options.onError?.(error); }
    await new Promise<void>(resolve=>{
      const finish=()=>{clearTimeout(timer);options.signal?.removeEventListener('abort',finish);resolve();};
      const timer=setTimeout(finish,options.intervalMs??500);
      options.signal?.addEventListener('abort',finish,{once:true});
    });
  }
}
