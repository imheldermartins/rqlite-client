import { RqliteClient, type ConnectionOptions } from './client/index.js';
import { Repository } from './repository/index.js';
import type { TableDescriptor } from './schema/types.js';
import { RqliteError } from './errors.js';

export interface ModelTypes { row: object; insert: object; update: object }
export interface ClientSchema<Models extends Record<string, ModelTypes>> {
  hash: string;
  tables: { [K in keyof Models]: TableDescriptor };
  /** Type-only carrier emitted by the generator; never persisted or serialized. */
  readonly modelTypes?: Models;
}
export const defineSchema = <Models extends Record<string, ModelTypes>>(schema: ClientSchema<Models>): ClientSchema<Models> => schema;
export interface ClientOptions<Models extends Record<string, ModelTypes>> {
  schema?: ClientSchema<Models>;
  connection: ConnectionOptions;
  migrations?: { directory: string };
  generators?: Record<string, () => unknown>;
}
export function createClient<Models extends Record<string, ModelTypes> = Record<never, never>>(options: ClientOptions<Models>) {
  const sql = new RqliteClient(options.connection);
  const models = Object.fromEntries(Object.entries(options.schema?.tables ?? {}).map(([name, table]) =>
    [name, new Repository(sql, table, options.generators)])) as {
      [K in keyof Models]: Repository<Models[K]['row'], Models[K]['insert'], Models[K]['update']>
    };
  const runner = async () => {
    if (!options.migrations) throw new RqliteError('CONFIG', 'Configure a migration directory for this operation');
    const { MigrationRunner } = await import('./migrations/runner.js');
    return new MigrationRunner(sql, options.migrations.directory);
  };
  return {
    models, sql,
    isReady: () => sql.isReady(),
    migrations: {
      status: async () => (await runner()).status(),
      up: async (flags: {allowManual?: boolean; allowDestructive?: boolean} = {}) => (await runner()).up(flags),
    },
    async assertReady(): Promise<void> {
      if (!await sql.isReady()) throw new RqliteError('UNAVAILABLE', 'Database is not ready');
      if (!options.schema && !options.migrations) return;
      const r = await runner();
      const { loadChain } = await import('./migrations/files.js');
      const { schemaHash } = await import('./canonical.js');
      const chain = await loadChain(r.directory);
      if (options.schema && schemaHash(chain.schemas.at(-1) ?? chain.journal.baseline) !== options.schema.hash)
        throw new RqliteError('SCHEMA', 'Artifact schema differs from its migration chain');
      if (chain.migrations.some(m => m.state !== 'ready')) throw new RqliteError('DRAFT', 'Draft migrations are incomplete');
      if ((await r.status()).pending.length) throw new RqliteError('PENDING', 'Database migrations are pending');
    },
    waitForDatabase: (options?: {attempts?: number; intervalMs?: number}) => sql.waitUntilReady(options),
  };
}
