import { describe, expect, it } from 'vitest';
import { parseResults, RqliteClient } from '../src/client/index.js';
import { Repository, eq, like } from '../src/repository/index.js';
import { compile } from '../src/compiler/index.js';
import path from 'node:path';
import { defaultSql } from '../src/dialect/index.js';
describe('client and runtime contracts',()=>{
  it('uses supported DDL defaults and evaluates clocks in the mutation',async()=>{
    expect(defaultSql({kind:'expression',value:'CURRENT_TIMESTAMP'},true)).toBe('CURRENT_TIMESTAMP');
    expect(()=>defaultSql({kind:'expression',value:"strftime('%Y-%m-%dT%H:%M:%fZ','now')"},true)).toThrow('frozen');
    const schema=compile([path.resolve('tests/fixtures/Document.schema.ts')]).schema.tables[0];
    let body:any;
    const client=new RqliteClient({url:'http://localhost:4001',fetch:async(_url,init)=>{
      body=JSON.parse(String(init?.body));
      return new Response(JSON.stringify({results:[{rows_affected:1},{types:{id:'text'},rows:[{id:'explicit',created_at:'2026-09-24 00:00:00'}]}]}));
    }});
    await new Repository(client,schema).create({id:'explicit',title:'example',status:'draft',data:null});
    expect(body[0][0]).toMatch(/"created_at".*datetime\('now'\)/);
    expect(body[0].slice(1)).not.toContain('CURRENT_TIMESTAMP');
  });
  it('preserves mixed DDL, zero rows and query indexes',()=>{
    expect(parseResults([{}, {rows_affected:0}, {last_insert_id:1,rows:null}, {types:{id:'text'},rows:[]}]).map(r=>[r.index,r.kind])).toEqual([[0,'ddl'],[1,'execute'],[2,'execute'],[3,'query']]);
    expect(()=>parseResults([{}, {error:'constraint failed'}])).toThrow(expect.objectContaining({code:'CONSTRAINT',statementIndex:1}));
  });
  it('does not retry writes after a transport failure or disclose SQL values',async()=>{
    let calls=0;const client=new RqliteClient({url:'http://localhost:4001',fetch:async()=>{calls++;throw new Error('password=secret');}});
    await expect(client.batch(['INSERT INTO a VALUES(1)'])).rejects.toMatchObject({code:'COMMIT_UNKNOWN'});
    expect(calls).toBe(1);
  });
  it('binds explicit predicates and refuses unscoped writes and managed fields',async()=>{
    const schema=compile([path.resolve('tests/fixtures/Document.schema.ts')]).schema.tables[0];
    const client=new RqliteClient({url:'http://localhost:4001',fetch:async()=>{throw new Error('must not fetch');}});
    const repo=new Repository(client,schema);
    const value="O'Brien%'; DROP TABLE documents; --";
    expect(repo.readStatement([eq('title',value)])).toEqual({text:'SELECT * FROM "documents" WHERE "title" = ?',values:[value]});
    expect(repo.readStatement([like('title','%hi%')]).text).toContain(' LIKE ?');
    await expect(repo.update({title:'a'},{})).rejects.toMatchObject({code:'INPUT'});
    await expect(repo.delete({})).rejects.toMatchObject({code:'INPUT'});
    await expect(repo.update({created_at:'x'},{id:'x'})).rejects.toMatchObject({code:'INPUT'});
    await expect(repo.create({title:null,status:'draft',data:null,created_at:'CURRENT_TIMESTAMP'})).rejects.toMatchObject({code:'INPUT'});
  });
});
