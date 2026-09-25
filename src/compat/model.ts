import {SQLBuilder} from './sql-builder.js';
import {ulid} from 'ulid';
import {HardDeleteSolution,SoftDeleteSolution} from './soft-delete.js';
import type {TableDescriptor} from '../schema/types.js';
import type {CreateValues,UpdateValues,LookupValues,LookupsConfig} from './types.js';
import type {DeleteSolution,ModelOptions,MutationOptions,ModelExecutor} from './model-types.js';
export class CompatibilityModel<T> {
  private sql: SQLBuilder<T>;
  // Colunas JSON: gravadas como texto (ver SQLBuilder.toSetValue) e
  // desserializadas de volta para objeto na leitura (ver deserialize).
  private jsonColumns: (keyof T)[];
  private deleteSolution: DeleteSolution<T>;

  public constructor(table: string | TableDescriptor, private readonly executor: ModelExecutor, options?: ModelOptions<T>) {
    const descriptor = typeof table === 'string' ? undefined : table;
    this.sql = new SQLBuilder(table);
    this.jsonColumns = options?.jsonColumns ?? descriptor?.columns.filter(c => c.codec === 'json').map(c => c.property as keyof T) ?? [];
    this.deleteSolution = options?.deleteSolution ?? (descriptor?.softDelete
      ? new SoftDeleteSolution<T>(descriptor.softDelete as Extract<keyof T, string>)
      : new HardDeleteSolution<T>());
  }

  /**
   * Converte as colunas JSON (string vinda do rqlite) de volta para objeto.
   * Tolerante: se o valor não for JSON válido, mantém o texto original.
   */
  private deserialize(row: T | null): T | null {
    if (!row || this.jsonColumns.length === 0) return row;

    const out = { ...row } as Record<string, unknown>;
    for (const column of this.jsonColumns) {
      const value = out[column as string];
      if (typeof value === "string") {
        try {
          out[column as string] = JSON.parse(value);
        } catch {
          /* não é JSON válido -- deixa como está */
        }
      }
    }

    return out as T;
  }

  public async create(data: CreateValues<T>, options?: MutationOptions): Promise<T | null> {
    const id = ulid();

    // `data` pode trazer um id explícito (ex.: page_root usa o id da workspace);
    // como ele vem depois no spread, sobrescreve o ULID gerado. `insertedId` é,
    // portanto, o id que de fato foi para o banco.
    const insertedId = (data as { id?: unknown }).id ?? id;

    const payload = { id, ...data } as CreateValues<T>;

    const stmt = this.sql.create(payload);
    const read = this.sql.read({
      ...this.deleteSolution.scopeLookup({ id: insertedId } as unknown as LookupValues<T>),
      limit: 1,
    });
    return this.deserialize(await this.executor.mutateAndRead<T>(stmt, read, 'Create', options));
  }

  /** Criação com identidade definida pelo domínio, sem espalhar casts de `id`. */
  public async createWithId(
    id: string,
    data: CreateValues<T>,
    options?: MutationOptions,
  ): Promise<T | null> {
    const payload = Object.assign({}, data, { id });
    return this.create(payload, options);
  }

  public async find(lookup: LookupValues<T>): Promise<T | null> {
    const stmt = this.sql.read({ ...this.deleteSolution.scopeLookup(lookup), limit: 1 });

    const [row] = await this.executor.query<T>(stmt) as T[];

    return this.deserialize(row ?? null);
  }

  public async findAll(lookup?: LookupsConfig<T>): Promise<T[] | null> {
    const stmt = this.sql.read(this.deleteSolution.scopeRead(lookup));

    const rows = await this.executor.query<T>(stmt) as T[];

    return rows.map((row) => this.deserialize(row) as T);
  }

  public async update(values: UpdateValues<T>, lookup: LookupValues<T>, options?: MutationOptions): Promise<boolean> {
    const stmt = this.sql.update(values, this.deleteSolution.scopeLookup(lookup));

    const result = await this.executor.mutate(stmt, options);

    return !!result;
  }

  /**
   * Atualiza e devolve a linha confirmada dentro do mesmo `/db/request`.
   * Isso impede um falso 404 quando o UPDATE foi confirmado pelo líder, mas
   * uma leitura subsequente alcançaria uma réplica ainda atrasada.
   */
  public async updateAndFind(
    values: UpdateValues<T>,
    lookup: LookupValues<T>,
    options?: MutationOptions,
  ): Promise<T | null> {
    const scopedLookup = this.deleteSolution.scopeLookup(lookup);
    const stmt = this.sql.update(values, scopedLookup);
    const read = this.sql.read({ ...scopedLookup, limit: 1 });

    return this.deserialize(await this.executor.mutateAndRead<T>(stmt, read, 'Update', options));
  }

  public async delete(lookup: LookupValues<T>, options?: MutationOptions): Promise<boolean> {
    const scopedLookup = this.deleteSolution.scopeLookup(lookup);
    const stmt = this.deleteSolution.statement(this.sql, scopedLookup);

    const result = await this.executor.mutate(stmt, options);

    return !!result;
  }

}
