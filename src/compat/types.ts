export type AtLeastOne<T,U={[K in keyof T]:Pick<T,K>}>=Partial<T>&U[keyof U];
/**
 * Statement pronto para o rqlite, PARAMETRIZADO: `text` com placeholders `?` e
 * `values` com os valores ligados (bind). É o formato que o SQLBuilder produz
 * e o Model repassa -- nenhum valor de usuário é concatenado no SQL (defesa
 * contra SQL injection). Equivale ao `ParamString` do squel.
 */
export type SqlStatement = { text: string; values: unknown[] };

/**
 * Formato aceito pelo endpoint do rqlite: uma string SQL simples OU um array
 * `[sql, ...params]` para statement parametrizado.
 */
export type RqliteStatement = string | unknown[];

/**
 * Campos que o CHAMADOR nunca informa -- a camada de dados cuida deles:
 * `id` e `created_at` nascem no INSERT (ULID e DEFAULT do schema), e
 * `updated_at` é recarimbado a CADA update pelo SQLBuilder. Por isso ficam
 * fora de `CreateValues`/`UpdateValues`: passar um deles à mão seria
 * contradizer a automação, não configurá-la.
 */
export type AutoManagedFields = 'id' | 'created_at' | 'updated_at' | 'deleted_at';

export type CreateValues<T> = Omit<T, AutoManagedFields>;

export type UpdateValues<T> = Partial<Omit<T, AutoManagedFields>>;

export type LookupValues<T> = AtLeastOne<T>;

export type LookupWhere<T> = {
  and?: Partial<T>;
  or?: Partial<T>;
};

export type LookupsConfig<T> = {
  where?: LookupWhere<T>;
  limit?: number;
} & Partial<T>;
