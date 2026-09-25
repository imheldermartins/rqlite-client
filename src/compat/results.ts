import type {Result,ErrorQuerying,QuerySuccess,ExecuteSuccess,SQLResponse,SuccessResult} from './response-types.js';
const isError = <T = any>(res: Result<T>): res is ErrorQuerying => 'error' in res;

function isQuery<T>(res: Result<T>): res is QuerySuccess<T> {
  return res && !isError(res) && 'rows' in res && 'types' in res;
}

function isExecute<T = never>(res: Result<T>): res is ExecuteSuccess {
  // O rqlite só devolve `last_insert_id` em INSERT. UPDATE e DELETE bem
  // sucedidos trazem apenas `rows_affected` (e, em versões recentes,
  // `rows: null`). Em `/db/request`, um INSERT condicional sem efeito também
  // pode vir como `{ last_insert_id, rows: null }`, sem `rows_affected`.
  return res && !isError(res) && (
    typeof (res as { rows_affected?: unknown }).rows_affected === 'number'
    || (
      typeof (res as { last_insert_id?: unknown }).last_insert_id === 'number'
      && (res as { rows?: unknown }).rows === null
    )
  );
}

/**
 * Normaliza a resposta heterogênea do rqlite para o contrato usado pelo Model.
 *
 * Cada resposta reconhecida ocupa uma posição, preservando o alinhamento de
 * batches mistos. Escrita é sucesso quando atingiu ao menos uma linha;
 * `last_insert_id` sozinho só identifica uma escrita válida sem efeito.
 */
export function parseRqliteResults<T>(
  results: SQLResponse<T>["results"] | null | undefined,
): SuccessResult<T>[] {
  if (!results || !Array.isArray(results))
    throw new Error('Results is invalid.', { cause: 'SQLERROR' });

  const validRows: SuccessResult<T>[] = [];
  const errors: string[] = [];

  for (const result of results) {
    if (isError(result)) {
      errors.push(result.error);
    } else if (isExecute(result)) {
      validRows.push(typeof result.rows_affected === 'number' && result.rows_affected > 0);
    } else if (isQuery<T>(result)) {
      validRows.push(result.rows);
    }
  }

  if (errors.length > 0)
    throw new Error(errors.map(err => `[${err}]`).join('\n'), { cause: 'SQLERROR' });

  return validRows;
}
