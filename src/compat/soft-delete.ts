import type {LookupsConfig,LookupValues,SqlStatement} from './types.js';
import type { SQLBuilder } from './sql-builder.js';
import type { DeleteSolution } from './model-types.js';
export type { DeleteSolution } from './model-types.js';

/**
 * Estratégia de exclusão de um `Model`.
 *
 * Além de produzir o statement de delete, a solução decide o escopo padrão
 * de leitura/update. Isso impede que um registro já enviado à lixeira volte a
 * aparecer ou continue aceitando escrita por acidente.
 */
/** Exclusão física padrão, preservada para models que não têm lixeira. */
export class HardDeleteSolution<T> implements DeleteSolution<T> {
  scopeRead(lookup?: LookupsConfig<T>): LookupsConfig<T> | undefined {
    return lookup;
  }

  scopeLookup(lookup: LookupValues<T>): LookupValues<T> {
    return lookup;
  }

  statement(sql: SQLBuilder<T>, lookup: LookupValues<T>): SqlStatement {
    return sql.delete(lookup);
  }
}

/**
 * Soft delete por timestamp nullable (normalmente `deleted_at`).
 *
 * O `NULL` é anexado depois do lookup do caller e, portanto, não pode ser
 * sobrescrito por ele. O segundo delete da mesma entidade afeta zero linhas e
 * continua idempotente na fronteira HTTP.
 */
export class SoftDeleteSolution<T> implements DeleteSolution<T> {
  public constructor(private readonly deletedAtColumn: Extract<keyof T, string>) {}

  scopeRead(lookup?: LookupsConfig<T>): LookupsConfig<T> {
    return {
      ...(lookup ?? {}),
      [this.deletedAtColumn]: null,
    } as LookupsConfig<T>;
  }

  scopeLookup(lookup: LookupValues<T>): LookupValues<T> {
    return {
      ...lookup,
      [this.deletedAtColumn]: null,
    } as LookupValues<T>;
  }

  statement(sql: SQLBuilder<T>, lookup: LookupValues<T>): SqlStatement {
    return sql.softDelete(lookup, this.deletedAtColumn);
  }
}
