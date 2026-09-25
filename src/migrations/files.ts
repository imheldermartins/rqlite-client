import { readFileSync, writeFileSync, mkdirSync, renameSync, openSync, closeSync, unlinkSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { hash, schemaHash } from '../canonical.js';
import type { SchemaDocument } from '../schema/types.js';
import type { Journal, Migration } from './types.js';
import { planMigration, type RenameMap } from './planner.js';
export const isMigrationModuleFile = (name: string) => !name.endsWith('.d.ts') && /\.(?:ts|js)$/.test(name);
export const migrationChecksum = ({checksum, ...payload}: Migration): string => hash(payload);
export const legacyChecksum = (m: {id: string; up: unknown[]; down?: unknown[]}) => hash({id:m.id, up:m.up, ...(m.down ? {down:m.down} : {})});
export function readJournal(dir: string): Journal { return JSON.parse(readFileSync(path.join(dir,'meta/journal.json'),'utf8')); }
export function atomicWrite(file: string, content: string): void {
  mkdirSync(path.dirname(file), {recursive:true});
  const temp = `${file}.${randomBytes(8).toString('hex')}.tmp`;
  writeFileSync(temp, content, {flag:'wx'}); renameSync(temp,file);
}
export async function withGenerationLock<T>(dir: string, task: () => Promise<T>): Promise<T> {
  mkdirSync(path.join(dir,'meta'), {recursive:true}); const lock = path.join(dir,'meta/generation.lock');
  let fd: number;
  try { fd = openSync(lock,'wx'); } catch { throw new Error('Generation lock exists; verify no generator is running before removing it'); }
  try { writeFileSync(fd, JSON.stringify({pid:process.pid, createdAt:new Date().toISOString()})); return await task(); }
  finally { closeSync(fd); unlinkSync(lock); }
}
export async function loadChain(dir: string, allowDraftEdits = false): Promise<{journal: Journal; migrations: Migration[]; schemas: SchemaDocument[]}> {
  const journal = readJournal(dir);
  if (journal.formatVersion !== 1) throw new Error('Unsupported journal format');
  let parentId: string | null = null; let before = schemaHash(journal.baseline);
  const seen = new Set<string>(); const migrations: Migration[] = []; const schemas: SchemaDocument[] = [];
  for (const entry of journal.entries) {
    if (seen.has(entry.id) || !/^[A-Za-z0-9_]+$/.test(entry.id) || path.basename(entry.file) !== entry.file || path.basename(entry.snapshot) !== entry.snapshot) throw new Error('Invalid or duplicate journal entry');
    seen.add(entry.id);
    let file = path.join(dir,entry.file);
    if (!existsSync(file) && file.endsWith('.ts')) file = file.slice(0,-3) + '.js';
    const mod = await import(pathToFileURL(file).href + `?v=${hash(readFileSync(file,'utf8'))}`);
    const m: Migration = mod.migration;
    const schema: SchemaDocument = JSON.parse(readFileSync(path.join(dir,'meta',entry.snapshot),'utf8'));
    if (m.formatVersion !== 1 || m.id !== entry.id || m.parentId !== parentId || m.beforeSchemaHash !== before) throw new Error(`Fork/dependency mismatch: ${entry.id}`);
    if ((!(allowDraftEdits && m.state === 'draft' && entry === journal.entries.at(-1)) && (migrationChecksum(m) !== m.checksum || m.checksum !== entry.checksum)) || schemaHash(schema) !== m.afterSchemaHash) throw new Error(`Checksum mismatch: ${entry.id}`);
    if (!Array.isArray(m.up) || !Array.isArray(m.requiredCapabilities) || !['safe','manual','destructive'].includes(m.risk) || !['draft','ready'].includes(m.state)) throw new Error('Invalid migration payload');
    parentId = m.id; before = m.afterSchemaHash; migrations.push(m); schemas.push(schema);
  }
  // A generated module without a journal entry is an interrupted publication or a fork.
  const known = new Set([...journal.legacy.map(e=>e.id), ...journal.entries.map(e=>e.id)]);
  for (const file of readdirSync(dir).filter(isMigrationModuleFile)) if (!known.has(file.replace(/\.(ts|js)$/,''))) throw new Error(`Unjournaled migration: ${file}`);
  return {journal,migrations,schemas};
}
export async function addMigration(dir: string, schema: SchemaDocument, description: string, options: {manual?: boolean; renames?: RenameMap} = {}): Promise<Migration | null> {
  return withGenerationLock(dir, async () => {
    const {journal,migrations,schemas} = await loadChain(dir);
    if (migrations.some(m=>m.state === 'draft')) throw new Error('Finalize the existing draft first');
    const before = schemas.at(-1) ?? journal.baseline;
    if (schemaHash(before) === schemaHash(schema) && !options.manual) return null;
    const plan = planMigration(before,schema,options.renames);
    if (plan.risk !== 'safe' && !options.manual) throw new Error(`Manual migration required:\n${plan.reasons.join('\n')}`);
    const slug = description.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,'_').replace(/^_|_$/g,'').slice(0,60) || 'migration';
    const id = new Date().toISOString().replace(/\D/g,'') + '_' + randomBytes(4).toString('hex') + '_' + slug;
    const migration: Migration = {formatVersion:1,id,description,parentId:migrations.at(-1)?.id ?? null,beforeSchemaHash:schemaHash(before),afterSchemaHash:schemaHash(schema),checksum:'',requiredCapabilities:['transactional-ddl'],risk:options.manual ? (plan.risk === 'destructive' ? 'destructive' : 'manual') : 'safe',state:options.manual ? 'draft' : 'ready',up:plan.up};
    migration.checksum = migrationChecksum(migration);
    const file = id + '.ts', snapshot = id + '.snapshot.json';
    if (existsSync(path.join(dir,file))) throw new Error('Migration already exists');
    atomicWrite(path.join(dir,file), `// Frozen migration payload. Manual drafts require rqlite finalize migration.\nexport const migration = ${JSON.stringify(migration,null,2)} as const;\n`);
    atomicWrite(path.join(dir,'meta',snapshot), JSON.stringify(schema,null,2)+'\n');
    journal.entries.push({id,file,snapshot,checksum:migration.checksum});
    atomicWrite(path.join(dir,'meta/journal.json'),JSON.stringify(journal,null,2)+'\n');
    return migration;
  });
}
