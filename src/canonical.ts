import { createHash } from 'node:crypto';
import type { SchemaDocument } from './schema/types.js';
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.entries(value)
    .filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b, 'en'))
    .map(([k, v]) => JSON.stringify(k) + ':' + canonical(v)).join(',') + '}';
  return JSON.stringify(value);
}
export const hash = (value: unknown): string => createHash('sha256').update(canonical(value)).digest('hex');
export function structural(schema: SchemaDocument): unknown {
  return { formatVersion: schema.formatVersion, opaque: [...schema.opaque].sort((a,b) => a.name.localeCompare(b.name, 'en')),
    tables: [...schema.tables].sort((a,b) => a.name.localeCompare(b.name, 'en')).map(({ className, softDelete, ...table }) => ({
      ...table, columns: [...table.columns].sort((a,b) => a.name.localeCompare(b.name, 'en')).map(({ property, tsType, codec, generated, managed, ...c }) => ({...c,...(codec === 'boolean' ? {booleanCheck:true} : {})})),
      indexes: [...table.indexes].sort((a,b) => a.name.localeCompare(b.name, 'en')),
    })) };
}
export const schemaHash = (schema: SchemaDocument): string => hash(structural(schema));
