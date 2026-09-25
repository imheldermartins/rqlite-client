import type { ColumnDescriptor, TableDescriptor, SqlDefault, IndexDescriptor } from '../schema/types.js';
export function identifier(name: string): string {
  if (typeof name !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`Invalid SQL identifier: ${name}`);
  return `"${name}"`;
}
export function defaultSql(value: SqlDefault, forDdl = false): string {
  if (value.kind === 'expression') {
    if (!['CURRENT_TIMESTAMP', "strftime('%Y-%m-%dT%H:%M:%fZ','now')"].includes(value.value)) throw new Error('Unsupported SQL default expression');
    // rqlite rewrites 'now' even inside DDL, freezing a strftime default.
    // Keep it available for mutations/legacy metadata, never generate that DDL.
    if (forDdl && value.value !== 'CURRENT_TIMESTAMP') throw new Error('rqlite DDL supports only CURRENT_TIMESTAMP clock defaults; strftime(now) is frozen by SQL rewriting');
    // Bare CURRENT_TIMESTAMP is the form validated against rqlite 10.3.3.
    // datetime('now') has the same text format and is explicitly rewritten by
    // rqlite before replication, whereas CURRENT_TIMESTAMP defaults are local.
    return value.value === 'CURRENT_TIMESTAMP' ? (forDdl ? value.value : "datetime('now')") : `(${value.value})`;
  }
  return literalSql(value.value);
}
export function literalSql(value: string | number | boolean | null): string {
  if (value === null) return 'NULL';
  if (typeof value === 'string') return "'" + value.replaceAll("'", "''") + "'";
  if (typeof value === 'boolean') return value ? '1' : '0';
  if (!Number.isFinite(value)) throw new Error('Invalid numeric default');
  return String(value);
}
export function columnSql(c: ColumnDescriptor): string {
  if (!/^[A-Za-z0-9_ ()]*$/.test(c.type)) throw new Error('Invalid physical type');
  return [identifier(c.name), c.type, c.primaryKey ? 'PRIMARY KEY' : '', c.nullable ? '' : 'NOT NULL',
    c.default ? `DEFAULT ${defaultSql(c.default, true)}` : '',
    c.enum ? `CHECK (${identifier(c.name)} IN (${c.enum.map(literalSql).join(', ')}))` : '',
    c.codec === 'boolean' ? `CHECK (${identifier(c.name)} IN (0, 1))` : ''].filter(Boolean).join(' ');
}
export function createIndexSql(table: string, index: IndexDescriptor): string {
  return `CREATE ${index.unique ? 'UNIQUE ' : ''}INDEX ${identifier(index.name)} ON ${identifier(table)} (${[...index.columns.map(identifier),...(index.expressions??[])].join(', ')})${index.where ? ' WHERE ' + index.where : ''}`;
}
export function createTableSql(t: TableDescriptor): string {
  const parts = t.columns.map(columnSql);
  if (t.primaryKey) parts.push(`PRIMARY KEY (${t.primaryKey.map(identifier).join(', ')})`);
  for (const unique of t.unique) parts.push(`UNIQUE (${unique.map(identifier).join(', ')})`);
  for (const check of t.checks) parts.push(`CHECK (${check})`);
  for (const fk of t.foreignKeys) {
    let sql = `FOREIGN KEY (${fk.columns.map(identifier).join(', ')}) REFERENCES ${identifier(fk.table)} (${fk.references.map(identifier).join(', ')})`;
    for (const [action, value] of [['DELETE', fk.onDelete], ['UPDATE', fk.onUpdate]]) if (value) {
      if (!['CASCADE','RESTRICT','SET NULL','SET DEFAULT','NO ACTION'].includes(value)) throw new Error('Invalid FK action');
      sql += ` ON ${action} ${value}`;
    }
    parts.push(sql);
  }
  return `CREATE TABLE ${identifier(t.name)} (${parts.join(', ')})`;
}
