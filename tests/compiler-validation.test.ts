import { it, expect } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { compile, descriptorSource } from '../src/compiler/index.js';
const dir=mkdtempSync(path.resolve('tests/compiler-case-'));
function run(source:string){const file=path.join(dir,'Entity.schema.ts');writeFileSync(file,source);return compile([file]);}
const imports="import {Table,Column,MappedSuperclass,Override,NotNull,Default,Json} from '@cubs/rqlite-client/schema';\n";
it('rejects ambiguous types, optional columns, dynamic definitions and contradictory nullability',()=>{
  for(const source of [
    "@Table('a') class A { @Column() value?: string }",
    "@Table('a') class A { @Column() value!: Date }",
    "@Table('a') class A { @Column() @NotNull() value!: string | null }",
    "const name=(()=> 'a')(); @Table(name) class A { @Column() value!: string }",
  ])expect(run(imports+source).diagnostics.length).toBeGreaterThan(0);
});
it('requires explicit inherited overrides and does not modify sibling metadata',()=>{
  const base="@MappedSuperclass() abstract class Base { @Column() title!: string }\n";
  expect(run(imports+base+"@Table('a') class A extends Base { @Column() title!: string }").diagnostics.some(d=>d.message.includes('@Override'))).toBe(true);
  const result=run(imports+base+"@Table('a') class A extends Base { @Column() @Override() @Default('a') override title: string = '' } @Table('b') class B extends Base {} ");
  expect(result.diagnostics).toEqual([]);
  expect(result.schema.tables[0].columns[0].default).toEqual({kind:'literal',value:'a'});
  expect(result.schema.tables[1].columns[0].default).toBeUndefined();
});
it('emits structural JSON types without leaking local aliases',()=>{
  const result=run(imports+"type Data={name:string;count?:number}; @Table('json') class JsonTable { @Column() @Json() data!: Data | null }");
  expect(result.diagnostics).toEqual([]);
  expect(descriptorSource(result.schema)).toContain('"name": string');
  expect(descriptorSource(result.schema)).not.toContain(': Data');
});
it('propagates a changed base through three levels to both subclasses',()=>{
  const source=imports+"@MappedSuperclass() abstract class Identity { @Column() id!: string } @MappedSuperclass() abstract class Base extends Identity { @Column() @Default('old') label!: string } @Table('a') class A extends Base {} @Table('b') class B extends Base {}";
  const before=run(source),after=run(source.replace("@Default('old')","@Default('new')"));
  expect(after.diagnostics).toEqual([]);
  for(let i=0;i<2;i++){
    expect(before.schema.tables[i].columns[1].default?.value).toBe('old');
    expect(after.schema.tables[i].columns[1].default?.value).toBe('new');
  }
});
