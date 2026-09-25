import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { RqliteClient, Repository } from '../src/index.js';
import { compile } from '../src/compiler/index.js';
import { addMigration, loadChain, MigrationRunner, migrationChecksum, catalog } from '../src/migrations/index.js';
import { emptySchema } from '../src/config.js';
const live=process.env.RUN_RQLITE_CLIENT_INTEGRATION==='1';
describe.skipIf(!live)('rqlite 10.3.3 real transaction integration',()=>{
  it('generates a pending chain, applies once under contention, reconciles lost commit responses and rolls back DDL/data/history',async()=>{
    const client=new RqliteClient({url:'http://127.0.0.1:18015'});
    expect(JSON.parse(await catalog(client))).toEqual([]);
    const dir=mkdtempSync(path.join(tmpdir(),'rqlite-client-integration-'));
    mkdirSync(path.join(dir,'meta'));
    writeFileSync(path.join(dir,'meta/journal.json'),JSON.stringify({formatVersion:1,baseline:emptySchema(),baselineCatalog:'[]',legacy:[],entries:[]}));
    const schema=compile([path.resolve('tests/fixtures/Document.schema.ts')]).schema;
    const first=await addMigration(dir,schema,'create documents');
    const next=structuredClone(schema);next.tables[0].columns.push({name:'note',property:'note',type:'TEXT',nullable:true,primaryKey:false,tsType:'string | null'});
    const second=await addMigration(dir,next,'add note');
    expect(second!.parentId).toBe(first!.id);
    expect(await addMigration(dir,next,'no-op')).toBeNull();
    const runners=[new MigrationRunner(client,dir),new MigrationRunner(client,dir)];
    const race=await Promise.allSettled(runners.map(r=>r.up()));
    expect(race.some(r=>r.status==='fulfilled')).toBe(true);
    expect((await runners[0].status()).pending).toEqual([]);
    expect(await client.query('SELECT COUNT(*) AS count FROM _orm_history')).toEqual([{count:2}]);
    await client.batch(["INSERT INTO folders(id,label) VALUES('folder','preserved')"],{transaction:true});
    next.tables[1].columns.find(c=>c.name==='label')!.name='folder_label';
    await addMigration(dir,next,'rename label',{renames:{columns:{folders:{label:'folder_label'}}}});
    await runners[0].up();
    expect(await client.query('SELECT folder_label FROM folders')).toEqual([{folder_label:'preserved'}]);
    const repo=new Repository(client,next.tables[0]);
    const row=await repo.create({title:"O'Brien%; DROP TABLE documents; --",status:'draft',data:{hello:'world'},note:null});
    expect(row.data).toEqual({hello:'world'});
    expect(row.created_at).not.toBe('CURRENT_TIMESTAMP');
    expect(await repo.update({title:'changed'},{id:row.id})).toBe(1);
    expect((await repo.find({id:row.id}))?.title).toBe('changed');
    expect(await repo.update({title:'missing'},{id:'absent'})).toBe(0);
    // Manually finalized data backfill; the runner asserts an unchanged catalog in the same batch.
    const draft=await addMigration(dir,next,'backfill',{manual:true});
    const chain=await loadChain(dir);const entry=chain.journal.entries.at(-1)!;
    const ready={...draft!,state:'ready' as const,dataOnly:true,up:[{text:'UPDATE documents SET note=?',values:['backfilled']}],checksum:''};ready.checksum=migrationChecksum(ready);
    writeFileSync(path.join(dir,entry.file),`export const migration = ${JSON.stringify(ready)};`);
    entry.checksum=ready.checksum;writeFileSync(path.join(dir,'meta/journal.json'),JSON.stringify(chain.journal));
    let lost=false;
    const losingClient=new RqliteClient({url:'http://127.0.0.1:18015',fetch:async(input,init)=>{
      const response=await fetch(input,init);
      if(!lost && String(init?.body).includes('backfilled') && new URL(String(input)).pathname==='/db/request'){lost=true;throw new Error('simulated response loss AFTER commit');}
      return response;
    }});
    await new MigrationRunner(losingClient,dir).up({allowManual:true});expect(lost).toBe(true);
    expect((await repo.find({id:row.id}))?.note).toBe('backfilled');
    const broken=await addMigration(dir,next,'fail midway',{manual:true});
    const brokenChain=await loadChain(dir);const brokenEntry=brokenChain.journal.entries.at(-1)!;
    const failed={...broken!,state:'ready' as const,up:['CREATE TABLE must_rollback(id TEXT)',"UPDATE documents SET note='should rollback'",'INSERT INTO nonexistent_table VALUES(1)'],checksum:''};failed.checksum=migrationChecksum(failed);
    writeFileSync(path.join(dir,brokenEntry.file),`export const migration = ${JSON.stringify(failed)};`);brokenEntry.checksum=failed.checksum;writeFileSync(path.join(dir,'meta/journal.json'),JSON.stringify(brokenChain.journal));
    await expect(runners[0].up({allowManual:true})).rejects.toMatchObject({code:'SQL'});
    expect(await client.query("SELECT name FROM sqlite_schema WHERE name='must_rollback'")).toEqual([]);
    expect((await repo.find({id:row.id}))?.note).toBe('backfilled');
    expect(await client.query({text:'SELECT id FROM _migrations WHERE id=?',values:[failed.id]})).toEqual([]);
    const original=readFileSync(path.join(dir,entry.file),'utf8');
    writeFileSync(path.join(dir,entry.file),original.replace('backfilled','tampered'));
    await expect(runners[0].status()).rejects.toThrow('Checksum mismatch');
    writeFileSync(path.join(dir,entry.file),original);
    await client.batch(['CREATE TABLE real_drift(id TEXT)'],{transaction:true});
    await expect(runners[0].status()).rejects.toMatchObject({code:'DRIFT'});
    await client.batch(['DROP TABLE real_drift'],{transaction:true});
    // Even a database with no ORM state must not pass an empty-baseline check
    // when it already contains unknown domain tables.
    const emptyDir=mkdtempSync(path.join(tmpdir(),'rqlite-client-empty-'));
    mkdirSync(path.join(emptyDir,'meta'));
    writeFileSync(path.join(emptyDir,'meta/journal.json'),JSON.stringify({formatVersion:1,baseline:emptySchema(),baselineCatalog:'[]',legacy:[],entries:[]}));
    await client.batch(['DELETE FROM _orm_history','DELETE FROM _orm_state','DELETE FROM _migrations'],{transaction:true});
    await expect(new MigrationRunner(client,emptyDir).status()).rejects.toMatchObject({code:'DRIFT'});
  });
});
