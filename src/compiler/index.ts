import ts from 'typescript-compiler';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { ColumnDescriptor, Diagnostic, SchemaDocument, TableDescriptor } from '../schema/types.js';
import { canonical, schemaHash } from '../canonical.js';
import { identifier } from '../dialect/index.js';

export interface CompileResult { schema: SchemaDocument; diagnostics: Diagnostic[]; dependencies: string[] }
export function compile(files: string[]): CompileResult {
  const program = ts.createProgram(files.map(f => path.resolve(f)), {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext,
    strict: true, skipLibCheck: true, noEmit: true, types: [],
  });
  const checker = program.getTypeChecker();
  function outputType(type: ts.Type, seen = new Set<ts.Type>()): string {
    if (seen.has(type)) return 'unknown';
    seen = new Set(seen).add(type);
    if (type.isUnion()) return type.types.map(t=>outputType(t,seen)).join(' | ');
    if (type.isStringLiteral() || type.isNumberLiteral()) return JSON.stringify(type.value);
    if (type.flags & ts.TypeFlags.StringLike) return 'string';
    if (type.flags & ts.TypeFlags.NumberLike) return 'number';
    if (type.flags & ts.TypeFlags.BooleanLike) return 'boolean';
    if (type.flags & ts.TypeFlags.Null) return 'null';
    if (type.flags & ts.TypeFlags.Undefined) return 'undefined';
    if (checker.isArrayType(type)) return `Array<${outputType(checker.getTypeArguments(type as ts.TypeReference)[0],seen)}>`;
    if (checker.isTupleType(type)) return `[${checker.getTypeArguments(type as ts.TypeReference).map(t=>outputType(t,seen)).join(', ')}]`;
    const index = checker.getIndexTypeOfType(type,ts.IndexKind.String);
    if (index) return `Record<string, ${outputType(index,seen)}>`;
    const properties = checker.getPropertiesOfType(type);
    if (properties.length) return '{ '+properties.map(p=>`${JSON.stringify(p.name)}${p.flags & ts.SymbolFlags.Optional ? '?' : ''}: ${outputType(checker.getTypeOfSymbol(p),seen)}`).join('; ')+' }';
    return 'unknown';
  }
  const diagnostics: Diagnostic[] = ts.getPreEmitDiagnostics(program).map(d => ({
    code: `TS${d.code}`, file: d.file?.fileName ?? '', message: ts.flattenDiagnosticMessageText(d.messageText, '\n'),
  }));
  const fail = (node: ts.Node, message: string): never => { throw new Error(`${node.getSourceFile().fileName}:${node.getStart()}: ${message}`); };
  function symbol(node: ts.Node): ts.Symbol | undefined {
    const s = checker.getSymbolAtLocation(node);
    return s && (s.flags & ts.SymbolFlags.Alias) ? checker.getAliasedSymbol(s) : s;
  }
  function exportedName(node: ts.Node): string | undefined {
    const s = symbol(node);
    const decl = s?.declarations?.[0];
    if (!decl) return;
    // Resolve actual exported symbols, not the spelling chosen by the consumer.
    const file = decl.getSourceFile().fileName.replaceAll('\\', '/');
    if (!/\/rqlite-client\/(?:src|dist)\/schema\/index\.(?:d\.)?ts$/.test(file)) return;
    return s?.getName();
  }
  function literal(node: ts.Expression, seen = new Set<ts.Node>()): any {
    if (seen.has(node)) return fail(node, 'Cyclic structural constant');
    seen = new Set(seen).add(node);
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
    if (ts.isNumericLiteral(node)) return Number(node.text);
    if (node.kind === ts.SyntaxKind.NullKeyword) return null;
    if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
    if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
    if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.MinusToken) return -literal(node.operand, seen);
    if (ts.isAsExpression(node) || ts.isSatisfiesExpression(node) || ts.isParenthesizedExpression(node)) return literal(node.expression, seen);
    if (ts.isArrayLiteralExpression(node)) return node.elements.map(e => literal(e as ts.Expression, seen));
    if (ts.isObjectLiteralExpression(node)) return Object.fromEntries(node.properties.map(p => {
      if (!ts.isPropertyAssignment(p) || ts.isComputedPropertyName(p.name)) return fail(p, 'Only literal object properties are supported');
      return [p.name.getText().replace(/^['"]|['"]$/g, ''), literal(p.initializer, seen)];
    }));
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && exportedName(node.expression.expression) === 'sql' && node.arguments.length === 0) {
      if (node.expression.name.text === 'currentTimestamp') return { kind: 'expression', value: 'CURRENT_TIMESTAMP' };
      if (node.expression.name.text === 'isoTimestamp') return { kind: 'expression', value: "strftime('%Y-%m-%dT%H:%M:%fZ','now')" };
    }
    if (ts.isIdentifier(node)) {
      const decl = symbol(node)?.valueDeclaration;
      if (decl && ts.isVariableDeclaration(decl) && decl.initializer
        && ts.isVariableDeclarationList(decl.parent) && (decl.parent.flags & ts.NodeFlags.Const)) return literal(decl.initializer, seen);
    }
    return fail(node, 'Structural arguments must be literals, const values or known sql helpers');
  }
  function decorators(node: ts.Node): Map<string, any[]> {
    const result = new Map<string, any[]>();
    for (const d of ts.canHaveDecorators(node) ? ts.getDecorators(node) ?? [] : []) {
      if (!ts.isCallExpression(d.expression)) continue;
      const name = exportedName(d.expression.expression);
      if (name) {
        const args = d.expression.arguments.map(a => literal(a));
        if (['Index', 'Unique', 'Check', 'ForeignKey'].includes(name)) result.set(name, [...(result.get(name) ?? []), args]);
        else { if (result.has(name)) fail(d, `Duplicate @${name}`); result.set(name, args); }
      }
    }
    return result;
  }
  const cache = new Map<ts.ClassDeclaration, TableDescriptor>();
  function describe(node: ts.ClassDeclaration, chain = new Set<ts.Node>()): TableDescriptor {
    if (chain.has(node)) return fail(node, 'Inheritance cycle');
    const cached = cache.get(node); if (cached) return structuredClone(cached);
    chain = new Set(chain).add(node);
    const ds = decorators(node);
    if (!ds.has('Table') && !ds.has('MappedSuperclass')) fail(node, 'Schema bases require @MappedSuperclass');
    let table: TableDescriptor = { name: '', className: node.name?.text ?? '', columns: [], indexes: [], foreignKeys: [], checks: [], unique: [] };
    for (const h of node.heritageClauses ?? []) if (h.token === ts.SyntaxKind.ExtendsKeyword) for (const base of h.types) {
      const decl = symbol(base.expression)?.declarations?.find(ts.isClassDeclaration);
      if (!decl) return fail(base, 'Schema base class cannot be resolved');
      table = describe(decl, chain);
      if (decorators(decl).has('Table')) fail(base, 'Inherit from @MappedSuperclass, not a concrete table');
    }
    table.className = node.name?.text ?? '';
    if (ds.has('Table')) { table.name = ds.get('Table')![0]; Object.assign(table, ds.get('Table')![1] ?? {}); identifier(table.name); if(table.name === '_migrations' || table.name.startsWith('_orm_')) fail(node,'Reserved infrastructure table name'); }
    table.indexes.push(...(ds.get('Index') ?? []).map(([name, columns, options]) => ({ name, columns, ...options })));
    table.unique.push(...(ds.get('Unique') ?? []).map(([columns]) => columns));
    table.checks.push(...(ds.get('Check') ?? []).map(([expression]) => expression));
    table.foreignKeys.push(...(ds.get('ForeignKey') ?? []).map(([definition]) => definition));
    if (ds.has('PrimaryKey')) table.primaryKey = ds.get('PrimaryKey')![0];
    for (const member of node.members) {
      if (!ts.isPropertyDeclaration(member) || !member.name || ts.isPrivateIdentifier(member.name)) continue;
      const md = decorators(member);
      if (md.has('Transient') || !md.size) continue;
      const modifiers = ts.getModifiers(member) ?? [];
      if (modifiers.some(m => [ts.SyntaxKind.StaticKeyword, ts.SyntaxKind.PrivateKeyword, ts.SyntaxKind.ProtectedKeyword].includes(m.kind))) continue;
      if (ts.isComputedPropertyName(member.name)) fail(member, 'Computed columns are unsupported');
      if (member.questionToken) fail(member, 'Optional persisted properties are unsupported; use T | null or a default');
      const property = member.name.getText().replace(/^['"]|['"]$/g, '');
      const opts = md.get('Column')?.[0] ?? {};
      const type = checker.getTypeAtLocation(member);
      const parts = type.isUnion() ? type.types : [type];
      const nullable = parts.some(t => t.flags & ts.TypeFlags.Null);
      if (nullable && md.has('NotNull')) fail(member, '@NotNull contradicts T | null');
      const values = parts.filter(t => !(t.flags & ts.TypeFlags.Null));
      if (!values.length) fail(member, 'A persisted property needs a non-null value type');
      const isString = values.every(t => t.flags & ts.TypeFlags.StringLike);
      const isNumber = values.every(t => t.flags & ts.TypeFlags.NumberLike);
      const isBoolean = values.every(t => t.flags & ts.TypeFlags.BooleanLike);
      if (!isString && !isNumber && !isBoolean && !md.has('Json')) fail(member, 'Ambiguous persisted type requires @Json or an explicit supported scalar type');
      const column: ColumnDescriptor = {
        property, name: opts.name ?? property, type: opts.type ?? (md.has('Json') || isString ? 'TEXT' : md.has('Integer') || isBoolean ? 'INTEGER' : 'REAL'),
        nullable: opts.nullable ?? nullable, primaryKey: md.has('PrimaryKey'),
        tsType: outputType(type),
      };
      if (md.has('NotNull')) column.nullable = false;
      if (column.primaryKey && opts.nullable === undefined && nullable) fail(member,'Primary keys require non-null types; explicit physical nullable is legacy-only');
      if (md.has('Json')) column.codec = 'json'; else if (isBoolean) column.codec = 'boolean';
      if (md.has('Default')) { const v = md.get('Default')![0]; column.default = v && typeof v === 'object' ? v : { kind: 'literal', value: v }; }
      if (md.has('Generated')) column.generated = md.get('Generated')![0];
      if (md.has('CreatedAt') && md.has('UpdatedAt')) fail(member, 'A column cannot have two clock roles');
      if (md.has('CreatedAt')) column.managed = 'created';
      if (md.has('UpdatedAt')) column.managed = 'updated';
      if (column.managed) {
        if (!isString) fail(member, 'Managed clocks use serialized string timestamps');
        column.default ??= {kind:'expression',value:'CURRENT_TIMESTAMP'};
        if (column.default.kind !== 'expression') fail(member, 'Managed clocks require a SQL clock expression');
      }
      if (opts.inferChecks !== false && values.length && values.every(t => t.isStringLiteral() || t.isNumberLiteral())) {
        column.enum = values.map(t => (t as ts.LiteralType & {value: string | number}).value).sort();
        column.tsType = column.enum.map(v => JSON.stringify(v)).join(' | ') + (nullable ? ' | null' : '');
      }
      identifier(column.name);
      if (!/^[A-Za-z0-9_ ()]*$/.test(column.type)) fail(member, 'Invalid physical type');
      const previous = table.columns.findIndex(c => c.property === property);
      if (previous >= 0) { if (!md.has('Override')) fail(member, 'Inherited columns require @Override'); table.columns[previous] = column; }
      else table.columns.push(column);
    }
    cache.set(node, structuredClone(table)); return table;
  }
  const tables: TableDescriptor[] = [];
  for (const source of program.getSourceFiles()) {
    if (source.isDeclarationFile || source.fileName.includes('node_modules')) continue;
    for (const node of source.statements) if (ts.isClassDeclaration(node)) {
      try { if (decorators(node).has('Table')) tables.push(describe(node)); }
      catch (error) { diagnostics.push({ code: 'SCHEMA', file: source.fileName, message: String(error) }); }
    }
  }
  const duplicates = (names: string[]) => names.filter((n,i) => names.indexOf(n) !== i);
  for (const name of duplicates(tables.map(t => t.name))) diagnostics.push({code: 'DUPLICATE_TABLE', file: '', message: name});
  const indexNames = new Set<string>();
  for (const table of tables) {
    try {
      if (duplicates(table.columns.map(c => c.name)).length) throw new Error('Duplicate columns');
      if (table.columns.filter(c => c.primaryKey).length > 1 && !table.primaryKey) throw new Error('Use a table-level composite primary key');
      const checkColumns = (cols: string[]) => { if (!cols?.length || cols.some(c => !table.columns.some(x => x.name === c))) throw new Error('Missing constraint columns'); };
      for (const index of table.indexes) { identifier(index.name); if(index.columns.length)checkColumns(index.columns);else if(!index.expressions?.length)throw new Error('Empty index'); if (indexNames.has(index.name)) throw new Error(`Duplicate index ${index.name}`); indexNames.add(index.name); }
      for (const cols of table.unique) checkColumns(cols);
      if (table.primaryKey) checkColumns(table.primaryKey);
      if (table.softDelete) checkColumns([table.softDelete]);
      for (const fk of table.foreignKeys) {
        checkColumns(fk.columns); const target = tables.find(t => t.name === fk.table);
        if (!target || fk.references.length !== fk.columns.length || fk.references.some(c => !target.columns.some(x => x.name === c))) throw new Error('Invalid foreign key target');
      }
    } catch(error) { diagnostics.push({code: 'CONSTRAINT', file: table.className, message: String(error)}); }
  }
  return { schema: {formatVersion: 1, tables: tables.sort((a,b) => a.name.localeCompare(b.name, 'en')), opaque: []}, diagnostics,
    dependencies: program.getSourceFiles().filter(f => !f.fileName.includes('node_modules')).map(f => path.resolve(f.fileName)).sort() };
}
export function descriptorSource(schema: SchemaDocument): string {
  const lines = ['// Generated by @cubs/rqlite-client. Do not edit.', "import { defineSchema } from '@cubs/rqlite-client';", "import type { TableDescriptor } from '@cubs/rqlite-client/schema';",
    `export const schemaHash = ${JSON.stringify(schemaHash(schema))};`,
    `export const schemaRegistry = ${JSON.stringify(Object.fromEntries(schema.tables.map(t => [t.name, t])), null, 2)} satisfies Record<string, TableDescriptor>;`];
  for (const table of schema.tables) for (const kind of ['Row', 'Insert', 'Update']) {
    lines.push(`export interface ${table.className}${kind} {`);
    for (const c of table.columns) {
      if (kind === 'Insert' && c.managed) continue;
      if (kind === 'Update' && (c.managed || c.primaryKey || table.primaryKey?.includes(c.name))) continue;
      const optional = kind === 'Update' || (kind === 'Insert' && (c.default || c.generated || c.managed));
      lines.push(`  ${JSON.stringify(c.property)}${optional ? '?' : ''}: ${c.tsType};`);
    }
    lines.push('}');
  }
  lines.push('export type SchemaModels = {');
  for (const table of schema.tables) lines.push(`  ${JSON.stringify(table.name)}: { row: ${table.className}Row; insert: ${table.className}Insert; update: ${table.className}Update };`);
  lines.push('};', 'export const schema = defineSchema<SchemaModels>({hash: schemaHash, tables: schemaRegistry});');
  return lines.join('\n') + '\n';
}
export function emitDescriptors(schema: SchemaDocument, output: string, check = false): void {
  const content = descriptorSource(schema);
  let old = ''; try { old = readFileSync(output, 'utf8'); } catch {}
  if (check && old !== content) throw new Error('Generated descriptors are stale');
  if (!check && old !== content) { mkdirSync(path.dirname(output), {recursive: true}); writeFileSync(output, content); }
}
export { canonical, schemaHash };
