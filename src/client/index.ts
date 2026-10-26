import { RqliteError } from '../errors.js';
import type { SqlStatement } from '../schema/types.js';
export type Statement = string | SqlStatement | [string, ...unknown[]];
export type BatchResult<T = Record<string, unknown>> =
  | { kind: 'query'; index: number; rows: T[] }
  | { kind: 'execute'; index: number; rowsAffected: number; lastInsertId?: number }
  | { kind: 'ddl'; index: number };
export interface RequestOptions { endpoint?: 'query' | 'execute' | 'request'; transaction?: boolean; consistency?: 'strong' | 'weak' | 'linearizable' | 'none' }
export interface BasicAuthCredentials { username: string; password: string }
export interface ConnectionOptions { url: string; auth?: BasicAuthCredentials; fetch?: typeof fetch; timeoutMs?: number }
/** Read an optional credential pair without placing secrets in URLs or config artifacts. */
export function basicAuthFromEnv(usernameEnv: string, passwordEnv: string, env: Readonly<Record<string, string | undefined>> = process.env): BasicAuthCredentials | undefined {
  const username = env[usernameEnv], password = env[passwordEnv];
  if (username === undefined && password === undefined) return undefined;
  return validateAuth({username: username ?? '', password: password ?? ''});
}
function validateAuth(auth: BasicAuthCredentials): BasicAuthCredentials {
  if (typeof auth.username !== 'string' || !auth.username || /[:\r\n]/.test(auth.username) || typeof auth.password !== 'string' || !auth.password)
    throw new RqliteError('CONFIG', 'Basic authentication requires a valid username and a nonempty password');
  return {username: auth.username, password: auth.password};
}
export function parseResults<T>(results: unknown): BatchResult<T>[] {
  if (!Array.isArray(results)) throw new RqliteError('PROTOCOL', 'Missing rqlite results');
  return results.map((r, index) => {
    if (!r || typeof r !== 'object') throw new RqliteError('PROTOCOL', 'Invalid rqlite result', index);
    if ('error' in r) throw new RqliteError(/constraint/i.test(r.error) ? 'CONSTRAINT' : 'SQL', 'rqlite rejected statement ' + index, index);
    if ('types' in r || 'columns' in r) {
      const rows = r.rows ?? (r.values ?? []).map((values: unknown[]) => Object.fromEntries(r.columns.map((c: string, i: number) => [c, values[i]])));
      return {kind: 'query', index, rows: rows ?? []};
    }
    if ('rows_affected' in r || 'last_insert_id' in r || 'rows' in r) return {
      kind: 'execute', index, rowsAffected: r.rows_affected ?? 0, ...(r.last_insert_id !== undefined ? {lastInsertId: r.last_insert_id} : {}),
    };
    return {kind: 'ddl', index};
  });
}
export class RqliteClient {
  private readonly url: URL;
  private readonly fetcher: typeof fetch;
  private readonly timeout: number;
  private readonly authorization?: string;
  constructor(options: ConnectionOptions) {
    this.url = new URL(options.url);
    if (!['http:', 'https:'].includes(this.url.protocol) || this.url.username || this.url.password) throw new RqliteError('CONFIG', 'Use an HTTP(S) URL without embedded credentials');
    this.fetcher = options.fetch ?? fetch; this.timeout = options.timeoutMs ?? 30000;
    if (options.auth) {
      const auth = validateAuth(options.auth);
      this.authorization = `Basic ${Buffer.from(`${auth.username}:${auth.password}`, 'utf8').toString('base64')}`;
    }
  }
  private requestOptions(): RequestInit {
    return this.authorization ? {headers: {Authorization: this.authorization}, redirect: 'error'} : {};
  }
  private checkAuth(response: Response): void {
    if (response.status === 401 || response.status === 403)
      throw new RqliteError(response.status === 401 ? 'AUTH' : 'FORBIDDEN', `rqlite HTTP ${response.status}: authentication or permission denied`);
  }
  async isReady(): Promise<boolean> {
    try {
      const response = await this.fetcher(new URL('/readyz', this.url), {...this.requestOptions(), signal: AbortSignal.timeout(Math.min(this.timeout, 3000))});
      return response.ok;
    } catch {
      return false;
    }
  }
  async waitUntilReady(options: {attempts?: number; intervalMs?: number} = {}): Promise<void> {
    const attempts = options.attempts ?? 30, interval = options.intervalMs ?? 2000;
    if (!Number.isInteger(attempts) || attempts < 1 || interval < 0) throw new RqliteError('CONFIG', 'Invalid readiness retry options');
    for (let attempt = 0; attempt < attempts; attempt++) {
      if (await this.isReady()) return;
      if (attempt + 1 < attempts) await new Promise(resolve => setTimeout(resolve, interval));
    }
    throw new RqliteError('UNAVAILABLE', 'Database did not become ready');
  }
  async batch<T = Record<string, unknown>>(statements: readonly Statement[], options: RequestOptions = {}): Promise<BatchResult<T>[]> {
    if (!statements.length) return [];
    const endpoint = options.endpoint ?? 'request';
    const url = new URL(`/db/${endpoint}`, this.url);
    url.searchParams.set('associative', '');
    if (options.transaction) url.searchParams.set('transaction', '');
    if (endpoint !== 'execute') url.searchParams.set('level', options.consistency ?? 'strong');
    const body = JSON.stringify(statements.map(s => typeof s === 'string' || Array.isArray(s) ? s : [s.text, ...s.values]));
    let response: Response;
    let payload: any;
    try {
      const authOptions = this.requestOptions();
      response = await this.fetcher(url, {...authOptions, method: 'POST', headers: {...authOptions.headers, 'Content-Type': 'application/json'}, body, signal: AbortSignal.timeout(this.timeout)});
      this.checkAuth(response);
      if (!response.ok) throw new RqliteError(endpoint === 'query' ? 'HTTP' : 'COMMIT_UNKNOWN', `rqlite HTTP ${response.status}`);
      payload = await response.json();
    } catch (error) {
      if (error instanceof RqliteError) throw error;
      throw new RqliteError(endpoint === 'query' ? 'TRANSPORT' : 'COMMIT_UNKNOWN', endpoint === 'query' ? 'rqlite read failed' : 'Write outcome unknown; do not retry blindly');
    }
    if (payload.error) throw new RqliteError(endpoint === 'query' ? 'SQL' : 'COMMIT_UNKNOWN', 'rqlite rejected request');
    const parsed = parseResults<T>(payload.results);
    if (parsed.length !== statements.length) throw new RqliteError(endpoint === 'query' ? 'PROTOCOL' : 'COMMIT_UNKNOWN', 'Incomplete rqlite response');
    return parsed;
  }
  async query<T = Record<string, unknown>>(statement: Statement): Promise<T[]> {
    const [result] = await this.batch<T>([statement], {endpoint: 'query'});
    if (result.kind !== 'query') throw new RqliteError('PROTOCOL', 'Expected query result');
    return result.rows;
  }
}
