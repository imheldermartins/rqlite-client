import type { RqliteClient } from '../client/index.js';
import { identifier } from '../dialect/index.js';
export interface CatalogObject { name: string; type: string; tbl_name: string; sql: string }
export interface PhysicalSchema {
  catalog: CatalogObject[];
  tables: { name: string; columns: Record<string, any>[]; indexes: {detail: Record<string, any>; columns: Record<string, any>[]}[]; foreignKeys: Record<string, any>[] }[];
}
// Same representation is computed inside the migration transaction, closing the drift race.
export const catalogExpression = `(SELECT COALESCE(json_group_array(json_object('name',name,'type',type,'tbl_name',tbl_name,'sql',sql)), '[]') FROM (SELECT name,type,tbl_name,sql FROM sqlite_schema WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' AND name <> '_migrations' AND substr(name,1,5) <> '_orm_' ORDER BY name))`;
export async function catalog(client: RqliteClient): Promise<string> {
  const rows = await client.query<{catalog: string}>(`SELECT ${catalogExpression} AS catalog`); return rows[0].catalog;
}
export async function introspect(client: RqliteClient): Promise<PhysicalSchema> {
  const objects = JSON.parse(await catalog(client)) as CatalogObject[];
  const tables: PhysicalSchema['tables'] = [];
  for (const table of objects.filter(o => o.type === 'table')) {
    const columns = await client.query<Record<string, any>>(`PRAGMA table_xinfo(${identifier(table.name)})`);
    const indexes = [];
    for (const detail of await client.query<Record<string, any>>(`PRAGMA index_list(${identifier(table.name)})`)) {
      indexes.push({detail, columns: await client.query<Record<string,any>>(`PRAGMA index_xinfo(${identifier(detail.name)})`)});
    }
    tables.push({name:table.name, columns, indexes, foreignKeys: await client.query(`PRAGMA foreign_key_list(${identifier(table.name)})`)});
  }
  return {catalog: objects, tables};
}
