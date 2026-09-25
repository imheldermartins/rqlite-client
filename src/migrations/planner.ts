import type { SchemaDocument, TableDescriptor } from '../schema/types.js';
import { canonical, structural } from '../canonical.js';
import { columnSql, createTableSql, createIndexSql, identifier } from '../dialect/index.js';
import type { Statement } from '../client/index.js';
export interface MigrationPlan { up: Statement[]; risk: 'safe' | 'manual' | 'destructive'; reasons: string[] }
export interface RenameMap { tables?: Record<string,string>; columns?: Record<string,Record<string,string>> }
export function planMigration(before: SchemaDocument, after: SchemaDocument, renames: RenameMap = {}): MigrationPlan {
  const up: Statement[] = []; const reasons: string[] = []; let risk: MigrationPlan['risk'] = 'safe';
  const manual = (reason: string, destructive = false) => { reasons.push(reason); if (risk !== 'destructive') risk = destructive ? 'destructive' : 'manual'; };
  const old = structuredClone(before);
  for (const [from,to] of Object.entries(renames.tables ?? {})) {
    const table = old.tables.find(t => t.name === from);
    if (!table || old.tables.some(t => t.name === to) || !after.tables.some(t => t.name === to)) throw new Error('Invalid table rename mapping');
    if (old.opaque.length) manual('Opaque table renames require reviewed SQL');
    else { up.push(`ALTER TABLE ${identifier(from)} RENAME TO ${identifier(to)}`); table.name = to;
      for (const t of old.tables) for (const fk of t.foreignKeys) if (fk.table === from) fk.table = to; }
  }
  for (const [tableName, columns] of Object.entries(renames.columns ?? {})) {
    const table = old.tables.find(t => t.name === tableName); if (!table) throw new Error('Invalid column rename table');
    for (const [from,to] of Object.entries(columns)) {
      const column = table.columns.find(c => c.name === from);
      if (!column || table.columns.some(c => c.name === to) || !after.tables.find(t => t.name === tableName)?.columns.some(c => c.name === to)) throw new Error('Invalid column rename mapping');
      if (old.opaque.length || table.checks.length) manual('Rename involving opaque constraints requires reviewed SQL');
      else { up.push(`ALTER TABLE ${identifier(tableName)} RENAME COLUMN ${identifier(from)} TO ${identifier(to)}`); column.name = to;
        for (const index of table.indexes) index.columns = index.columns.map(c => c === from ? to : c);
        table.unique = table.unique.map(cols => cols.map(c => c === from ? to : c));
        if (table.primaryKey) table.primaryKey = table.primaryKey.map(c => c === from ? to : c);
        for (const t of old.tables) for (const fk of t.foreignKeys) {
          if (t === table) fk.columns = fk.columns.map(c => c === from ? to : c);
          if (fk.table === tableName) fk.references = fk.references.map(c => c === from ? to : c);
        }
      }
    }
  }
  if (canonical(old.opaque) !== canonical(after.opaque)) manual('Opaque objects changed; preserve and review their SQL');
  const tableShape = (t: TableDescriptor) => (structural({formatVersion:1,tables:[t],opaque:[]}) as any).tables[0];
  for (const table of old.tables) if (!after.tables.some(t => t.name === table.name)) manual(`Dropping ${table.name} requires impact assessment and recovery`, true);
  const newTables = after.tables.filter(t => !old.tables.some(o => o.name === t.name));
  const visited = new Set<string>(); const visiting = new Set<string>();
  function create(t: TableDescriptor) {
    if (visited.has(t.name)) return;
    if (visiting.has(t.name)) { manual('Cyclic foreign keys require a manual creation plan'); return; }
    visiting.add(t.name);
    for (const fk of t.foreignKeys) { const target = newTables.find(x => x.name === fk.table); if (target && target !== t) create(target); }
    visiting.delete(t.name); visited.add(t.name); up.push(createTableSql(t));
  }
  newTables.forEach(create);
  for (const table of after.tables) {
    const previous = old.tables.find(t => t.name === table.name);
    if (previous) {
      const a = tableShape(previous), b = tableShape(table);
      for (const key of ['primaryKey','foreignKeys','checks','unique']) if (canonical(a[key]) !== canonical(b[key])) manual(`${table.name}: ${key} changes require manual rebuild`);
      for (const column of previous.columns) {
        const next = table.columns.find(c => c.name === column.name);
        if (!next) manual(`${table.name}.${column.name}: destructive column removal`, true);
        else {
          const shape = (c: typeof column) => { const {property,tsType,codec,generated,managed,...rest}=c; return {...rest,...(codec==='boolean'?{booleanCheck:true}:{})}; };
          if (canonical(shape(column)) !== canonical(shape(next))) manual(`${table.name}.${column.name}: type/default/constraint change requires manual rebuild`);
        }
      }
      for (const column of table.columns.filter(c => !previous.columns.some(p => p.name === c.name))) {
        if (column.primaryKey || column.enum || column.codec === 'boolean' || column.default?.kind === 'expression' || (!column.nullable && (!column.default || column.default.value === null))) manual(`${table.name}.${column.name}: ADD COLUMN requires backfill or incompatible constraint`);
        else up.push(`ALTER TABLE ${identifier(table.name)} ADD COLUMN ${columnSql(column)}`);
      }
      for (const index of previous.indexes) if (!table.indexes.some(i => canonical(i) === canonical(index))) up.push(`DROP INDEX ${identifier(index.name)}`);
    }
    for (const index of table.indexes) if (!previous?.indexes.some(i => canonical(i) === canonical(index))) {
      up.push(createIndexSql(table.name,index));
    }
  }
  return {up, risk, reasons};
}
