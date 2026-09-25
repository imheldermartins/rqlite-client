import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { compile, descriptorSource, schemaHash } from '../src/compiler/index.js';
describe('static compiler', () => {
  it('resolves symbols, constants, inherited fields and independent siblings deterministically', () => {
    const file = path.resolve('tests/fixtures/Document.schema.ts');
    const first = compile([file]);
    expect(first.diagnostics).toEqual([]);
    const [document, folder] = first.schema.tables;
    expect(document.columns.map(c => c.name)).toEqual(['id','created_at','title','status','data']);
    expect(folder.columns.map(c => c.name)).toEqual(['id','created_at','label']);
    expect(document.columns[2].nullable).toBe(true);
    expect(document.columns[4].codec).toBe('json');
    expect(descriptorSource(first.schema)).toContain('"id"?: string');
    expect(schemaHash(first.schema)).toBe(schemaHash(compile([file]).schema));
  });
});
