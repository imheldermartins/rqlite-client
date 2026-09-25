# @cubs/rqlite-client

Typed client, declarative schemas and migrations for rqlite. Node.js 24+, ESM,
TypeScript 7 consumers, isolated TypeScript 6.0.3 schema compiler. Validated against
rqlite 10.3.3 / SQLite 3.53.4.

```sh
npm install @cubs/rqlite-client@1.0.0
```

The installed executable is **rqlite**, usable as `npx rqlite` from that project.
For a one-off invocation without installation, use
`npm exec --package @cubs/rqlite-client@1.0.0 -- rqlite --help`.

## Connect immediately

```ts
import {createClient} from '@cubs/rqlite-client';

const db = createClient({connection: {url: process.env.DATABASE_URL!}});
await db.waitForDatabase();
await db.assertReady();
const rows = await db.sql.query('SELECT 1 AS value');
```

This client offers SQL and health before you define models. `createClient` itself
does not connect or migrate. Supply `DATABASE_URL` in your application's `.env`
and load it with Node's `--env-file` or your own configuration code. Add schemas
and migrations below to obtain typed `db.models` repositories.

## Define a schema

```ts
// schemas/User.schema.ts
import {MappedSuperclass, Table, Column, PrimaryKey, Generated,
  CreatedAt, UpdatedAt, Default} from '@cubs/rqlite-client/schema';

@MappedSuperclass()
abstract class Base {
  @PrimaryKey() @Generated('ulid') id!: string;
  @CreatedAt() created_at!: string;
  @UpdatedAt() updated_at!: string;
}

@Table('users')
export class User extends Base {
  @Column() name!: string;
  @Column() @Default(null) biography!: string | null;
}
```

Types infer TEXT, REAL and INTEGER for strings, numbers and booleans respectively.
Use `@Integer()` for integral numbers, `@Json()` for JSON, and `T | null` for SQL
nullability. `@CreatedAt()` and `@UpdatedAt()` already declare a persisted clock
with a database default: no additional `@Column` or `@Default` is necessary.
Managed clocks are returned as strings and excluded from generated insert/update
inputs. Field names are configurable; they need not be `created_at`/`updated_at`.

Decorators have no runtime side effects. Compilation resolves symbols, aliases,
constants and inherited fields without instantiating classes or executing field
initializers. Initializers are not SQL defaults. Optional `?:` persisted fields,
ambiguous types and implicit Date codecs are rejected. Use `@Override()` for an
explicit inherited metadata override.

`@Unique`, `@Check`, `@ForeignKey`, `@Index` and composite `@PrimaryKey([...])`
describe constraints. Index options support `unique`, `where` and `expressions`.
SQL expressions in constraints are trusted developer-authored fragments; runtime
values use binds. The generator constructs CREATE TABLE from metadata; schemas
do not contain full-table SQL overrides.

## Generate and migrate

```ts
// rqlite.config.ts
import {defineConfig} from '@cubs/rqlite-client/config';
export default defineConfig({
  schemas: ['schemas'], output: 'generated/schema.ts', migrations: 'migrations',
  environments: {
    development: {urlEnv: 'DATABASE_URL', development: true},
    production: {urlEnv: 'DATABASE_URL', development: false},
  },
});
```

```sh
npx rqlite init
npx rqlite create migration "create users"
npx rqlite migrate status --environment development
npx rqlite migrate --environment development
npx rqlite check --database --environment development
```

`create migration` generates the client as well. Use `rqlite generate` for
metadata/type-only regeneration. `rqlite check` without `--database` checks only
files. Configuration is `.ts` or `.js`; paths resolve relative to it. Use
`--config path` and optional `--env-file path`. Database operations require an
explicit configured environment. An environment needs `url`, `urlEnv`, or host/port
configuration; environment-variable references are preserved in compiled builds.

## Use the client

```ts
import {createClient} from '@cubs/rqlite-client';
import {schema} from './generated/schema.js';

const client = createClient({
  schema,
  connection: {url: process.env.DATABASE_URL!},
  migrations: {directory: 'migrations'},
});

await client.assertReady();
const user = await client.models.users.create({name: "O'Brien"});
await client.models.users.update({name: 'Updated'}, {id: user.id});
const confirmed = await client.models.users.find({id: user.id});
```

Model and input types are inferred without per-table generics. `createClient`
does no I/O. Call `client.migrations.status()`, `.up()` and `client.assertReady()`
explicitly. `client.sql.query()` and `.batch()` expose parameterized SQL and
declarative request transactions. There is no interactive transaction callback.
`connection` also accepts an injected fetch and request timeout.

Repositories support create, find/findAll, update, updateAndFind and delete.
`@Table('users', {softDelete: 'deleted_at'})` enables soft deletion. Empty mutation
lookups, unknown columns, invalid scalar values and caller-owned managed clocks
are rejected at runtime. JSON codecs apply only to marked fields. Predicates
`eq`, `like` and `isNull` are explicit; `%` in equality remains literal.

The client retains response positions including DDL and zero-row writes. A lost
write response raises `COMMIT_UNKNOWN`; it is never retried blindly. Migration
application reconciles its committed checksum with a strong read.

## Development and manual changes

```sh
npx rqlite watch
npx rqlite watch --apply --environment development --run server.ts
npx rqlite create migration "backfill" --manual
# Edit the last draft's up statements, then:
npx rqlite finalize migration --data-only
npx rqlite migrate --environment development --allow-manual
```

Watch follows schema imports and complete journal entries, coalesces editor rename
saves and serializes work. The optional server stops on pending schema/draft/error
and restarts only after migrations and descriptors are ready. Metadata-only changes
also restart it without producing a physical migration. Autoapply is restricted
to development and does not apply manual/destructive migrations. Restart the watcher
after an externally applied manual migration. Unrelated application files are not
hot-reloaded by this schema watcher.

The diff uses the latest versioned snapshot, including pending migrations, never
the developer's live database. An unchanged schema produces no migration. Renames
require `--renames map.json` with `{tables:{old:new},columns:{table:{old:new}}}`.
Checksums, predecessor/catalog guards and history writes are transactional.
Applied migrations are immutable; incomplete publication, forks and drift fail closed.

Type/constraint changes, removals, rebuilds and opaque objects require reviewed
manual SQL. For structural drafts, rehearse the canonical resulting DDL on a
disposable database and use `finalize migration --verified-url URL`; the verified
catalog becomes a transactional postcondition. Destructive application requires
`--allow-destructive`. There is no automatic rollback/data recovery command.
New clock defaults use CURRENT_TIMESTAMP; the client emits `datetime('now')` in
mutations so rqlite can rewrite the timestamp before replication. The generator
rejects strftime(now) defaults that rqlite would freeze during CREATE TABLE.

## Programmatic tools and compiled deployment

```ts
import {loadProject} from '@cubs/rqlite-client/project';
const project = await loadProject('./rqlite.config.ts');
await project.createMigration('add field');
await project.migrate('development');
await project.check('development');
```

`createProject(config, {root})` also accepts configuration directly. Init, generate,
create/finalize migration, status, migrate, check, wait, prepare and watch use the
same services as the CLI. Runtime clients do not load the schema compiler.

For deployment, add these explicit compiler-output paths to configuration:

```ts
build: {
  config: 'dist/rqlite.config.js',
  client: 'dist/generated/schema.js',
  migrations: 'dist/migrations',
}
```

Compile your generated client and migrations with TypeScript, then run
`npx rqlite prepare`. It checks compiled migrations, copies metadata and writes a
runtime config. Deploy the compiled files and installed package. Startup can run
`rqlite wait`, `rqlite migrate`, and `rqlite check --database` with
`--config dist/rqlite.config.js --environment production` before starting the app.
Compiled startup imports neither TypeScript compiler nor tsx.

Advanced exports include `/compiler`, `/migrations` and `/compat`. Compatibility
adapters reuse package SQL generation and CRUD while allowing an application to
supply its existing transactional guards and response conventions. They are not
required for a new application.
