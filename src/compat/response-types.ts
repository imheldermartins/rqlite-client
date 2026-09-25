export type ErrorQuerying = { error: string; };

export type DBTypes = 'integer' | 'text';

export type QuerySuccess<T> = {
    types: Record<keyof T, DBTypes>;
    rows: T[];
};

export type ExecuteSuccess = {
    rows_affected: number;
    last_insert_id?: number;
    rows?: null;
} | {
    /**
     * O `/db/request` pode representar uma escrita válida sem efeito (como o
     * guard baseado em `changes()`) sem `rows_affected`.
     */
    last_insert_id: number;
    rows: null;
    rows_affected?: never;
};

export type SuccessResult<T> = T[] | boolean;

export type QueryResult<T> = QuerySuccess<T> | ErrorQuerying;

export type ExecuteResult = ExecuteSuccess | ErrorQuerying;

export type Result<T> = QueryResult<T> | ExecuteResult;

export type SQLResponse<T> = {
	results: Result<T>[];
};
