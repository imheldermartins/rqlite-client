import { it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { watchFiles } from '../src/cli/watch.js';
it('serializes scans, recovers atomic saves, retries after changed input and stops cleanly',async()=>{
  const dir=mkdtempSync(path.join(tmpdir(),'rqlite-client-watch-'));
  const file=path.join(dir,'schema.ts');writeFileSync(file,'first');
  const abort=new AbortController();let calls=0,running=0,max=0,errors=0;
  const task=watchFiles({files:()=>[file],intervalMs:15,signal:abort.signal,onError:()=>errors++,run:async()=>{
    calls++;running++;max=Math.max(max,running);await new Promise(r=>setTimeout(r,25));running--;
    if(calls===2)throw new Error('partial input');
  }});
  const wait=async(condition:()=>boolean)=>{const limit=Date.now()+5000;while(!condition()){if(Date.now()>limit)throw new Error('watch timeout');await new Promise(r=>setTimeout(r,10));}};
  await wait(()=>calls===1&&running===0);
  writeFileSync(file,'partial');await wait(()=>errors===1);
  writeFileSync(file+'.tmp','complete');renameSync(file+'.tmp',file);await wait(()=>calls===3&&running===0);
  unlinkSync(file);await wait(()=>calls===4&&running===0);
  abort.abort();await task;expect(max).toBe(1);expect(errors).toBe(1);
});
