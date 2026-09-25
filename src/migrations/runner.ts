import { RqliteClient } from '../client/index.js';
import { RqliteError } from '../errors.js';
import { schemaHash } from '../canonical.js';
import { catalog, catalogExpression } from './introspection.js';
import { loadChain, legacyChecksum } from './files.js';
import { pathToFileURL } from 'node:url';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { Journal, Migration } from './types.js';
export const infrastructureSql = [
  `CREATE TABLE IF NOT EXISTS _migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
  `CREATE TABLE IF NOT EXISTS _orm_state (singleton INTEGER PRIMARY KEY CHECK(singleton=1), head TEXT, schema_hash TEXT NOT NULL, catalog TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS _orm_history (id TEXT PRIMARY KEY REFERENCES _migrations(id), parent_id TEXT, checksum TEXT NOT NULL, schema_hash TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS _orm_assert (value INTEGER NOT NULL CHECK(value=1))`,
];
type State = {head: string | null; schema_hash: string; catalog: string};
export class MigrationRunner {
  constructor(readonly client: RqliteClient, readonly directory: string) {}
  private async tableExists(name: string): Promise<boolean> { return (await this.client.query({text:"SELECT name FROM sqlite_schema WHERE type='table' AND name=?",values:[name]})).length > 0; }
  async status(): Promise<{applied: string[]; pending: string[]; head: string | null}> {
    const {journal,migrations} = await loadChain(this.directory);
    const applied = await this.tableExists('_migrations') ? (await this.client.query<{id:string}>('SELECT id FROM _migrations ORDER BY id')).map(r=>r.id) : [];
    const known = [...journal.legacy.map(m=>m.id),...migrations.map(m=>m.id)];
    if (applied.some(id=>!known.includes(id))) throw new RqliteError('HISTORY','Unknown applied migrations');
    let gap = false;
    for (const id of known) { if (!applied.includes(id)) gap = true; else if (gap) throw new RqliteError('HISTORY','Non-contiguous migration history'); }
    for (const legacy of journal.legacy) {
      const payload = await this.loadLegacy(legacy.id);
      if (legacyChecksum(payload) !== legacy.checksum) throw new RqliteError('CHECKSUM', `Legacy reference changed: ${legacy.id}`);
    }
    let committedState=false;
    if (await this.tableExists('_orm_state')) {
      const states = await this.client.query<State>('SELECT head,schema_hash,catalog FROM _orm_state');
      const state = states[0];
      if (state) {
        committedState=true;
        const history = await this.client.query<{id:string;checksum:string;schema_hash:string;parent_id:string|null}>('SELECT * FROM _orm_history');
        const appliedNew = migrations.filter(m=>applied.includes(m.id));
        if (history.length !== appliedNew.length) throw new RqliteError('HISTORY','ORM history count mismatch');
        for (const m of appliedNew) {
          const entry = history.find(h=>h.id===m.id);
          if (!entry || entry.checksum!==m.checksum || entry.schema_hash!==m.afterSchemaHash || entry.parent_id!==m.parentId) throw new RqliteError('CHECKSUM',`Applied migration mismatch: ${m.id}`);
        }
        const last = appliedNew.at(-1);
        if (state.head !== (last?.id ?? null) || state.schema_hash !== (last?.afterSchemaHash ?? schemaHash(journal.baseline))) throw new RqliteError('HISTORY','Schema head mismatch');
        if (state.catalog !== await catalog(this.client)) throw new RqliteError('DRIFT','Physical schema differs from the committed catalog');
      } else if (migrations.some(m=>applied.includes(m.id))) throw new RqliteError('HISTORY','Missing ORM state');
    } else if (migrations.some(m=>applied.includes(m.id))) throw new RqliteError('HISTORY','Missing ORM infrastructure');
    if(!committedState && journal.legacy.every(m=>applied.includes(m.id)) && await catalog(this.client)!==journal.baselineCatalog) throw new RqliteError('DRIFT','Database does not match the adopted baseline');
    return {applied,pending:known.filter(id=>!applied.includes(id)),head:migrations.filter(m=>applied.includes(m.id)).at(-1)?.id??null};
  }
  private async loadLegacy(id: string): Promise<{id:string;up:any[];down?:any[]}> {
    if (!/^[A-Za-z0-9_]+$/.test(id)) throw new RqliteError('HISTORY','Invalid legacy ID');
    let file = path.join(this.directory,id+'.ts'); if (!existsSync(file)) file = path.join(this.directory,id+'.js');
    const mod = file.endsWith('.ts')
      ? await (await import('tsx/esm/api')).tsImport(pathToFileURL(file).href, import.meta.url)
      : await import(pathToFileURL(file).href);
    return mod.migration;
  }
  private async initialize(journal: Journal): Promise<void> {
    const current = await catalog(this.client);
    const states = await this.client.query<State>('SELECT head,schema_hash,catalog FROM _orm_state');
    if (states.length) return;
    if (current !== journal.baselineCatalog) throw new RqliteError('DRIFT','Database does not match the adopted baseline');
    try {
      await this.client.batch([
        {text:`INSERT INTO _orm_assert(value) SELECT CASE WHEN ${catalogExpression} = ? THEN 1 ELSE 0 END`,values:[journal.baselineCatalog]},
        {text:'INSERT INTO _orm_state(singleton,head,schema_hash,catalog) VALUES(1,NULL,?,?)',values:[schemaHash(journal.baseline),current]},
        'DELETE FROM _orm_assert',
      ],{transaction:true});
    } catch (error) {
      const state = (await this.client.query<State>('SELECT * FROM _orm_state'))[0];
      if (!state || state.catalog!==current || state.schema_hash!==schemaHash(journal.baseline)) throw error;
    }
  }
  async up(options: {allowManual?: boolean; allowDestructive?: boolean} = {}): Promise<string[]> {
    const {journal,migrations} = await loadChain(this.directory);
    if (migrations.some(m=>m.state !== 'ready')) throw new RqliteError('DRAFT','Finalize all migration drafts before applying');
    let status = await this.status();
    if (!await this.tableExists('_migrations')) await this.client.batch([infrastructureSql[0]],{transaction:true});
    const applied: string[] = [];
    for (const legacy of journal.legacy) if (!status.applied.includes(legacy.id)) {
      const m = await this.loadLegacy(legacy.id);
      // The unique history row is claimed inside the same transaction before any DDL.
      try { await this.client.batch([{text:"INSERT INTO _migrations(id,applied_at) VALUES(?,strftime('%Y-%m-%dT%H:%M:%fZ','now'))",values:[m.id]},...m.up],{transaction:true}); applied.push(m.id); }
      catch (error) {
        const row = await this.client.query({text:'SELECT id FROM _migrations WHERE id=?',values:[m.id]});
        if (!row.length) throw error;
      }
    }
    // New packages bootstrap explicitly on rqlite migrate. Adopted apps include this SQL in an append-only legacy migration.
    if (!journal.legacy.length) await this.client.batch(infrastructureSql,{transaction:true});
    if (!await this.tableExists('_orm_state')) throw new RqliteError('HISTORY','Missing explicit ORM infrastructure migration');
    await this.initialize(journal);
    status = await this.status();
    for (const m of migrations) if (!status.applied.includes(m.id)) {
      if (m.risk === 'manual' && !options.allowManual) throw new RqliteError('MANUAL',`Explicit --allow-manual required for ${m.id}`);
      if (m.risk === 'destructive' && !options.allowDestructive) throw new RqliteError('DESTRUCTIVE',`Explicit --allow-destructive required for ${m.id}`);
      if (m.requiredCapabilities.some(c=>c!=='transactional-ddl')) throw new RqliteError('CAPABILITY',`Unsupported capability in ${m.id}`);
      await this.apply(m); applied.push(m.id);
    }
    await this.status(); return applied;
  }
  private async apply(m: Migration): Promise<void> {
    const state = (await this.client.query<State>('SELECT * FROM _orm_state'))[0];
    if (state.head !== m.parentId || state.schema_hash !== m.beforeSchemaHash) {
      const already = await this.client.query<{checksum:string}>({text:'SELECT checksum FROM _orm_history WHERE id=?',values:[m.id]});
      if (already[0]?.checksum === m.checksum) return;
      throw new RqliteError('DEPENDENCY',`Wrong predecessor for ${m.id}`);
    }
    try {
      await this.client.batch([
        {text:`INSERT INTO _orm_assert(value) SELECT CASE WHEN EXISTS (SELECT 1 FROM _orm_state WHERE singleton=1 AND head IS ? AND schema_hash=? AND catalog=${catalogExpression}) THEN 1 ELSE 0 END`,values:[m.parentId,m.beforeSchemaHash]},
        {text:"INSERT INTO _migrations(id,applied_at) VALUES(?,strftime('%Y-%m-%dT%H:%M:%fZ','now'))",values:[m.id]},
        ...m.up,
        ...(m.dataOnly ? [{text:`INSERT INTO _orm_assert(value) SELECT CASE WHEN ${catalogExpression} = ? THEN 1 ELSE 0 END`,values:[state.catalog]}] : []),
        ...(m.verifiedCatalog ? [{text:`INSERT INTO _orm_assert(value) SELECT CASE WHEN ${catalogExpression} = ? THEN 1 ELSE 0 END`,values:[m.verifiedCatalog]}] : []),
        {text:'INSERT INTO _orm_history(id,parent_id,checksum,schema_hash) VALUES(?,?,?,?)',values:[m.id,m.parentId,m.checksum,m.afterSchemaHash]},
        {text:`UPDATE _orm_state SET head=?,schema_hash=?,catalog=${catalogExpression} WHERE singleton=1`,values:[m.id,m.afterSchemaHash]},
        'DELETE FROM _orm_assert',
      ],{transaction:true});
    } catch(error) {
      // A lost response is reconciled with a strong read, never replayed blindly.
      const rows = await this.client.query<{checksum:string}>({text:'SELECT checksum FROM _orm_history WHERE id=?',values:[m.id]});
      if (rows[0]?.checksum === m.checksum) return;
      if (error instanceof RqliteError) throw new RqliteError(error.code, `Migration ${m.id}: ${error.message}`, error.statementIndex, {cause:error});
      throw error;
    }
  }
}
