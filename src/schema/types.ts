export interface SqlStatement { text: string; values: unknown[] }
export type SqlDefault = { kind: 'literal'; value: string | number | boolean | null } | { kind: 'expression'; value: string };
export interface ColumnDescriptor {
  property: string; name: string; type: string; nullable: boolean; primaryKey: boolean;
  tsType: string; codec?: 'json' | 'boolean'; default?: SqlDefault; generated?: string;
  managed?: 'created' | 'updated'; enum?: (string | number)[];
}
export interface IndexDescriptor { name: string; columns: string[]; expressions?: string[]; unique?: boolean; where?: string }
export interface ForeignKeyDescriptor {
  columns: string[]; table: string; references: string[];
  onDelete?: 'CASCADE' | 'RESTRICT' | 'SET NULL' | 'SET DEFAULT' | 'NO ACTION';
  onUpdate?: 'CASCADE' | 'RESTRICT' | 'SET NULL' | 'SET DEFAULT' | 'NO ACTION';
}
export interface TableDescriptor {
  name: string; className: string; columns: ColumnDescriptor[]; indexes: IndexDescriptor[];
  foreignKeys: ForeignKeyDescriptor[]; checks: string[]; unique: string[][]; primaryKey?: string[];
  softDelete?: string;
}
export interface SchemaDocument { formatVersion: 1; tables: TableDescriptor[]; opaque: { name: string; type: string; sql: string }[] }
export interface Diagnostic { code: string; file: string; message: string }
