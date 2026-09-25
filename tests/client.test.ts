import {it,expect} from 'vitest';
import {createClient,defineSchema} from '../src/index.js';
import {compile} from '../src/compiler/index.js';
import path from 'node:path';
import {createProject} from '../src/project.js';
it('creates typed repositories without I/O and requires explicit migration operations',async()=>{
  const metadata=compile([path.resolve('tests/fixtures/Document.schema.ts')]).schema;
  const schema=defineSchema<{documents:{row:{id:string};insert:{id?:string};update:{}}}>({hash:'test',tables:{documents:metadata.tables[0]}});
  let calls=0;const client=createClient({schema,connection:{url:'http://localhost:4001',fetch:async()=>{calls++;throw new Error('No I/O during construction');}}});
  expect(calls).toBe(0);expect(client.models.documents).toBeDefined();
  await expect(client.migrations.up()).rejects.toMatchObject({code:'CONFIG'});expect(calls).toBe(0);
});
it('does not silently select localhost when an explicit URL environment variable is missing',()=>{
  const project=createProject({migrations:'migrations',environments:{production:{urlEnv:'RQLITE_TEST_MISSING_URL_7F43',development:false}}});
  expect(()=>project.status('production')).toThrow('Missing configured database URL');
});
it('connects without schemas and reports health through the client',async()=>{
  let calls=0;
  const client=createClient({connection:{url:'http://localhost:4001',fetch:async input=>{
    calls++;
    expect(new URL(String(input)).pathname).toBe('/readyz');
    return new Response('ready',{status:200});
  }}});
  expect(calls).toBe(0);
  expect(client.models).toEqual({});
  await expect(client.isReady()).resolves.toBe(true);
  await expect(client.assertReady()).resolves.toBeUndefined();
  expect(calls).toBe(2);
});
