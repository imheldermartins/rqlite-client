export type * from './types.js';
import type { ForeignKeyDescriptor, IndexDescriptor, SqlDefault } from './types.js';

// Decorators deliberately have no runtime side effects. The compiler resolves their symbols.
const marker = (..._args: unknown[]): void => {};
export const Table = (_name: string, _options?: { softDelete?: string }) => marker;
export const MappedSuperclass = () => marker;
export const Column = (_options?: { name?: string; type?: string; nullable?: boolean; inferChecks?: boolean }) => marker;
export const NotNull = () => marker;
export const PrimaryKey = (_columns?: string[]) => marker;
export const Generated = (_generator: string) => marker;
export const CreatedAt = () => marker;
export const UpdatedAt = () => marker;
export const Default = (_value: string | number | boolean | null | SqlDefault) => marker;
export const Json = () => marker;
export const Integer = () => marker;
export const Transient = () => marker;
export const Override = () => marker;
export const Index = (_name: string, _columns: string[], _options?: Omit<IndexDescriptor, 'name' | 'columns'>) => marker;
export const Unique = (_columns: string[]) => marker;
export const Check = (_expression: string) => marker;
export const ForeignKey = (_definition: ForeignKeyDescriptor) => marker;
export const sql = {
  currentTimestamp: (): SqlDefault => ({ kind: 'expression', value: 'CURRENT_TIMESTAMP' }),
  isoTimestamp: (): SqlDefault => ({ kind: 'expression', value: "strftime('%Y-%m-%dT%H:%M:%fZ','now')" }),
};
