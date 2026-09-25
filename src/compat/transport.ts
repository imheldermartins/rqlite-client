import type { RqliteClient } from '../client/index.js';
import type { SqlStatement, RqliteStatement } from './types.js';
import type { SuccessResult } from './response-types.js';

export type RqliteEndpoint = 'query' | 'execute' | 'request';
export interface RqliteOptions { transaction?: boolean }

/** Preserves the older positional batch contract while the new client owns I/O. */
export function createLegacyTransport(client: RqliteClient) {
  function rqlite<T>(queries: RqliteStatement[], endpoint: 'query', options?: RqliteOptions): Promise<T[][]>;
  function rqlite<T = never>(queries: RqliteStatement[], endpoint: 'execute', options?: RqliteOptions): Promise<boolean[]>;
  function rqlite<T>(queries: RqliteStatement[], endpoint: 'request', options?: RqliteOptions): Promise<SuccessResult<T>[]>;
  function rqlite<T>(queries: RqliteStatement[], endpoint: RqliteEndpoint, options?: RqliteOptions): Promise<SuccessResult<T>[]>;
  async function rqlite<T>(queries: RqliteStatement[], endpoint: RqliteEndpoint, options: RqliteOptions = {}): Promise<SuccessResult<T>[]> {
    const statements = queries.map(statement => {
      if (typeof statement === 'string') return statement;
      if (typeof statement[0] !== 'string') throw new Error('Invalid SQL statement');
      return {text: statement[0], values: statement.slice(1)};
    });
    const results = await client.batch<T>(statements, {endpoint, transaction: options.transaction ?? false});
    return results.map(result => result.kind === 'query' ? result.rows
      : result.kind === 'ddl' ? true : result.rowsAffected > 0);
  }
  async function sql<T>(statement: string | SqlStatement, endpoint: RqliteEndpoint = 'request'): Promise<SuccessResult<T> | null> {
    const wire: RqliteStatement = typeof statement === 'string' ? statement : [statement.text, ...statement.values];
    const [rows] = await rqlite<T>([wire], endpoint);
    return rows ?? null;
  }
  return {rqlite, sql};
}
