import {describe,expect,it} from 'vitest';
import {RqliteClient} from '../src/index.js';
const url='http://127.0.0.1:18017';
const auth={username:'cubs_user',password:'writer-test-only'};
describe.runIf(process.env.RUN_RQLITE_CLIENT_INTEGRATION==='1')('authenticated rqlite 10.3.3',()=>{
  it('enforces the two profiles across read/write/status/ready endpoints',async()=>{
    const writer=new RqliteClient({url,auth});
    await writer.waitUntilReady({attempts:40,intervalMs:250});
    await writer.batch(['CREATE TABLE IF NOT EXISTS auth_fixture(id INTEGER PRIMARY KEY,value TEXT)', "INSERT OR REPLACE INTO auth_fixture VALUES(1,'preserved')"],{transaction:true});
    const reader=new RqliteClient({url,auth:{username:'cubs_reader',password:'reader-test-only'}});
    expect(await reader.isReady()).toBe(true);
    expect(await reader.query('SELECT value FROM auth_fixture WHERE id=1')).toEqual([{value:'preserved'}]);
    await expect(reader.batch(["UPDATE auth_fixture SET value='denied' WHERE id=1"],{endpoint:'execute'})).rejects.toMatchObject({code:'AUTH'});
    await expect(reader.query('DELETE FROM auth_fixture')).rejects.toBeDefined();
    await expect(reader.batch(['SELECT 1'])).rejects.toMatchObject({code:'AUTH'});
    expect(await writer.query('SELECT value FROM auth_fixture WHERE id=1')).toEqual([{value:'preserved'}]);
    for(const path of ['/readyz','/status','/db/query?q=SELECT%201']) {
      expect((await fetch(url+path)).status).toBe(401);
      expect((await fetch(url+path,{headers:{Authorization:`Basic ${Buffer.from('cubs_reader:reader-test-only').toString('base64')}`}})).ok).toBe(true);
    }
    expect(await new RqliteClient({url,auth:{username:'cubs_user',password:'wrong'}}).isReady()).toBe(false);
  },30_000);
});
