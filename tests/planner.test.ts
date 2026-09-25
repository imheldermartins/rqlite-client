import { describe, it, expect } from 'vitest';
import { compile } from '../src/compiler/index.js';
import { planMigration } from '../src/migrations/planner.js';
import path from 'node:path';
describe('conservative SQLite planner',()=>{
  const schema=compile([path.resolve('tests/fixtures/Document.schema.ts')]).schema;
  it('requires reviewed plans for destructive or constraint changes',()=>{
    const removed=structuredClone(schema);removed.tables[0].columns.splice(2,1);
    expect(planMigration(schema,removed).risk).toBe('destructive');
    const required=structuredClone(schema);required.tables[0].columns.push({name:'required',property:'required',type:'TEXT',nullable:false,primaryKey:false,tsType:'string'});
    expect(planMigration(schema,required).risk).toBe('manual');
    const changed=structuredClone(schema);changed.tables[0].columns[2].type='INTEGER';
    expect(planMigration(schema,changed).risk).toBe('manual');
  });
  it('only recognizes explicit renames and preserves dependent indexes',()=>{
    const renamed=structuredClone(schema);const t=renamed.tables[0];t.columns[2].name='heading';t.columns[2].property='heading';t.indexes[0].columns=['heading'];
    expect(planMigration(schema,renamed).risk).toBe('destructive');
    const plan=planMigration(schema,renamed,{columns:{documents:{title:'heading'}}});
    expect(plan.risk).toBe('safe');expect(plan.up).toEqual(['ALTER TABLE "documents" RENAME COLUMN "title" TO "heading"']);
  });
});
