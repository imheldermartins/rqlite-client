import { ulid } from 'ulid';
import { RqliteClient } from '../client/index.js';
import { identifier, defaultSql } from '../dialect/index.js';
import type { ColumnDescriptor, SqlStatement, TableDescriptor } from '../schema/types.js';
import { RqliteError } from '../errors.js';
export type Predicate = { column: string; op: 'eq' | 'like' | 'isNull'; value?: unknown };
export const eq = (column: string, value: unknown): Predicate => ({column, op: 'eq', value});
export const like = (column: string, value: string): Predicate => ({column, op: 'like', value});
export const isNull = (column: string): Predicate => ({column, op: 'isNull'});
export type Lookup<Row extends object = Record<string,unknown>> = Partial<Row> | Predicate[];
export class Repository<Row extends object = Record<string, unknown>, Insert extends object = Partial<Row>, Update extends object = Partial<Row>> {
  constructor(readonly client: RqliteClient, readonly descriptor: TableDescriptor,
    private readonly generators: Record<string, () => unknown> = {ulid}) {}
  private column(property: string): ColumnDescriptor {
    const c = this.descriptor.columns.find(c => c.property === property);
    if (!c) throw new RqliteError('INPUT', `Unknown property ${property}`); return c;
  }
  private encode(c: ColumnDescriptor, value: unknown): unknown {
    if (value === undefined) throw new RqliteError('INPUT', `Undefined value: ${c.property}`);
    if (value === null) { if (!c.nullable) throw new RqliteError('INPUT', `${c.property} cannot be null`); return null; }
    if (c.codec === 'json') return JSON.stringify(value);
    if (c.codec === 'boolean') { if (typeof value !== 'boolean') throw new RqliteError('INPUT', 'Expected boolean'); return value ? 1 : 0; }
    if (c.type === 'INTEGER' && (typeof value !== 'number' || !Number.isInteger(value))) throw new RqliteError('INPUT', 'Expected integer');
    if (c.tsType.startsWith('number') && (typeof value !== 'number' || !Number.isFinite(value))) throw new RqliteError('INPUT', 'Expected finite number');
    if (c.tsType.startsWith('string') && typeof value !== 'string') throw new RqliteError('INPUT', 'Expected string');
    if (c.enum && !c.enum.includes(value as string | number)) throw new RqliteError('INPUT', 'Invalid enum value');
    return value;
  }
  private decode(row: Record<string, unknown>): Row {
    return Object.fromEntries(this.descriptor.columns.map(c => {
      let value = row[c.name];
      if (value !== null && value !== undefined) {
        if (c.codec === 'json' && typeof value === 'string') value = JSON.parse(value);
        if (c.codec === 'boolean') value = value === 1;
      }
      return [c.property, value];
    })) as Row;
  }
  private where(lookup: Lookup<Row> = {}, required = false): SqlStatement {
    const predicates = Array.isArray(lookup) ? lookup : Object.entries(lookup).map(([column, value]) => eq(column, value));
    if (required && !predicates.length) throw new RqliteError('INPUT', 'Mutation requires at least one criterion');
    const values: unknown[] = [];
    const clauses = predicates.map(p => {
      const c = this.column(p.column); const name = identifier(c.name);
      if (p.op === 'isNull' || (p.op === 'eq' && p.value === null)) return `${name} IS NULL`;
      if (!['eq','like'].includes(p.op)) throw new RqliteError('INPUT', 'Unsupported predicate');
      values.push(this.encode(c, p.value)); return `${name} ${p.op === 'like' ? 'LIKE' : '='} ?`;
    });
    if (this.descriptor.softDelete) clauses.push(`${identifier(this.descriptor.softDelete)} IS NULL`);
    return {text: clauses.length ? ' WHERE ' + clauses.join(' AND ') : '', values};
  }
  readStatement(lookup: Lookup<Row> = {}, limit?: number): SqlStatement {
    const where = this.where(lookup);
    if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1)) throw new RqliteError('INPUT', 'Invalid limit');
    return {text: `SELECT * FROM ${identifier(this.descriptor.name)}${where.text}${limit ? ' LIMIT ?' : ''}`, values: [...where.values, ...(limit ? [limit] : [])]};
  }
  async findAll(lookup: Lookup<Row> = {}): Promise<Row[]> { return (await this.client.query(this.readStatement(lookup))).map(r => this.decode(r)); }
  async find(lookup: Lookup<Row>): Promise<Row | null> { const rows = await this.client.query(this.readStatement(lookup, 1)); return rows[0] ? this.decode(rows[0]) : null; }
  async create(data: Insert): Promise<Row> {
    const input = {...data} as Record<string, unknown>;
    for (const key of Object.keys(input)) this.column(key);
    for (const c of this.descriptor.columns) {
      if (c.managed && c.property in input) throw new RqliteError('INPUT', `Managed field ${c.property}`);
      if (input[c.property] === undefined && c.generated) {
        const generator = this.generators[c.generated]; if (!generator) throw new RqliteError('CONFIG', `Missing generator ${c.generated}`); input[c.property] = generator();
      }
      if (input[c.property] === undefined && !c.default && !c.managed) throw new RqliteError('INPUT', `Missing field ${c.property}`);
    }
    const entries = Object.entries(input).filter(([,v]) => v !== undefined);
    const columns = entries.map(([p]) => identifier(this.column(p).name));
    const values = entries.map(([p,v]) => this.encode(this.column(p), v));
    const placeholders = entries.map(() => '?');
    // Evaluate clocks in the replicated write, not independently through table defaults.
    for (const c of this.descriptor.columns) if (input[c.property] === undefined && c.default?.kind === 'expression') {
      columns.push(identifier(c.name)); placeholders.push(defaultSql(c.default));
    }
    const primary = this.descriptor.primaryKey ?? this.descriptor.columns.filter(c => c.primaryKey).map(c => c.name);
    if (!primary.length) throw new RqliteError('SCHEMA', 'Create requires a primary key for confirmed reading');
    const lookup = Object.fromEntries(primary.map(name => { const c = this.descriptor.columns.find(c => c.name === name)!; if (input[c.property] === undefined) throw new RqliteError('INPUT', 'Primary key must be supplied or generated'); return [c.property, input[c.property]]; }));
    const text = `INSERT INTO ${identifier(this.descriptor.name)} ${columns.length ? `(${columns.join(', ')}) VALUES (${placeholders.join(', ')})` : 'DEFAULT VALUES'}`;
    const results = await this.client.batch([{text, values}, this.readStatement(lookup as Lookup<Row>, 1)], {transaction: true});
    const read = results[1]; if (read.kind !== 'query' || !read.rows[0]) throw new RqliteError('PROTOCOL', 'Missing confirmed row');
    return this.decode(read.rows[0]);
  }
  private updateStatement(data: Update, lookup: Lookup<Row>): SqlStatement {
    const where = this.where(lookup, true); const values: unknown[] = []; const fields: string[] = [];
    for (const [property,value] of Object.entries(data)) {
      const c = this.column(property);
      if (c.managed || c.primaryKey || this.descriptor.primaryKey?.includes(c.name)) throw new RqliteError('INPUT', `Managed field ${property}`);
      fields.push(`${identifier(c.name)} = ?`); values.push(this.encode(c, value));
    }
    if (!fields.length) throw new RqliteError('INPUT', 'Empty update');
    for (const c of this.descriptor.columns) if (c.managed === 'updated') fields.push(`${identifier(c.name)} = ${defaultSql(c.default ?? {kind:'expression', value:'CURRENT_TIMESTAMP'})}`);
    return {text: `UPDATE ${identifier(this.descriptor.name)} SET ${fields.join(', ')}${where.text}`, values: [...values,...where.values]};
  }
  async update(data: Update, lookup: Lookup<Row>): Promise<number> {
    const [r] = await this.client.batch([this.updateStatement(data, lookup)], {transaction:true}); return r.kind === 'execute' ? r.rowsAffected : 0;
  }
  async updateAndFind(data: Update, lookup: Lookup<Row>): Promise<Row | null> {
    const results = await this.client.batch([this.updateStatement(data, lookup), this.readStatement(lookup, 1)], {transaction:true});
    const read = results[1]; return read.kind === 'query' && read.rows[0] ? this.decode(read.rows[0]) : null;
  }
  async delete(lookup: Lookup<Row>): Promise<number> {
    const where = this.where(lookup, true);
    let text = `DELETE FROM ${identifier(this.descriptor.name)}${where.text}`;
    if (this.descriptor.softDelete) {
      const fields = [`${identifier(this.descriptor.softDelete)} = CURRENT_TIMESTAMP`];
      for (const c of this.descriptor.columns) if (c.managed === 'updated') fields.push(`${identifier(c.name)} = ${defaultSql(c.default ?? {kind:'expression',value:'CURRENT_TIMESTAMP'})}`);
      text = `UPDATE ${identifier(this.descriptor.name)} SET ${fields.join(', ')}${where.text}`;
    }
    const [r] = await this.client.batch([{text,values:where.values}], {transaction:true}); return r.kind === 'execute' ? r.rowsAffected : 0;
  }
}
