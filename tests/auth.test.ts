import {afterEach, describe, expect, it, vi} from 'vitest';
import {basicAuthFromEnv, RqliteClient} from '../src/index.js';
import {createProject} from '../src/project.js';

afterEach(() => {vi.unstubAllEnvs(); vi.unstubAllGlobals();});
describe('Basic Auth', () => {
  const auth = {username:'cubs_user', password:'test-only-密碼:with-symbols'};
  const header = `Basic ${Buffer.from(`${auth.username}:${auth.password}`).toString('base64')}`;
  it('authenticates readiness, query, execute and mixed batches through an injected fetch', async () => {
    const calls: {url:URL; init?:RequestInit}[] = [];
    const client = new RqliteClient({url:'http://localhost:4001', auth, fetch:async (url, init) => {
      calls.push({url:new URL(String(url)),init});
      return new Response(new URL(String(url)).pathname === '/readyz' ? 'ready' : JSON.stringify({results:[{columns:['value'],values:[[1]]}]}));
    }});
    expect(await client.isReady()).toBe(true);
    await client.query('SELECT 1'); await client.batch(['SELECT 1']); await client.batch(['INSERT INTO fixture VALUES (1)'], {endpoint:'execute'});
    expect(calls.map(c=>c.url.pathname)).toEqual(['/readyz','/db/query','/db/request','/db/execute']);
    for (const {url,init} of calls) {
      expect(new Headers(init?.headers).get('Authorization')).toBe(header);
      expect(url.username).toBe(''); expect(url.password).toBe('');
      expect(init?.redirect).toBe('error');
    }
  });
  it.each([401,403])('reports permission failure %s without retrying or disclosing credentials/SQL', async status => {
    const fetcher = vi.fn(async () => new Response('private server diagnostics', {status}));
    const client = new RqliteClient({url:'http://localhost:4001',auth,fetch:fetcher});
    const failure = await client.batch(['SECRET SQL']).catch(error=>error);
    expect(failure.code).toBe(status===401?'AUTH':'FORBIDDEN');
    expect(String(failure)).not.toContain(auth.password); expect(String(failure)).not.toContain('SECRET');
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(await client.isReady()).toBe(false);
  });
  it('keeps unauthenticated behavior and rejects partial, empty or URL credentials', async () => {
    const fetcher = vi.fn(async (_url:unknown, init?:RequestInit) => {expect(new Headers(init?.headers).has('Authorization')).toBe(false); return new Response('ok');});
    expect(await new RqliteClient({url:'http://localhost:4001',fetch:fetcher}).isReady()).toBe(true);
    for (const invalid of [{username:'',password:'secret'}, {username:'user',password:''}, {username:'bad:user',password:'secret'}])
      expect(()=>new RqliteClient({url:'http://localhost:4001',auth:invalid})).toThrow(expect.objectContaining({code:'CONFIG'}));
    expect(()=>new RqliteClient({url:'http://user:secret@localhost:4001'})).toThrow(expect.objectContaining({code:'CONFIG'}));
    expect(basicAuthFromEnv('U','P',{})).toBeUndefined();
    expect(()=>basicAuthFromEnv('U','P',{U:'user'})).toThrow(expect.objectContaining({code:'CONFIG'}));
  });
  it('resolves credentials for CLI environments at runtime and fails closed when missing', async () => {
    const config = {migrations:'migrations',environments:{production:{url:'http://localhost:4001',auth:{usernameEnv:'TEST_RQLITE_USER',passwordEnv:'TEST_RQLITE_PASS'},development:false}}};
    const project = createProject(config);
    expect(()=>project.wait('production',{attempts:1})).toThrow('Missing configured database credentials');
    vi.stubEnv('TEST_RQLITE_USER',auth.username); vi.stubEnv('TEST_RQLITE_PASS',auth.password);
    const fetcher=vi.fn(async (_url:unknown,init?:RequestInit)=>{expect(new Headers(init?.headers).get('Authorization')).toBe(header);return new Response('ready');});
    vi.stubGlobal('fetch',fetcher);
    await project.wait('production',{attempts:1});
    expect(JSON.stringify(config)).not.toContain(auth.password);
  });
  it('rejects literal credentials in JavaScript configuration before generating runtime artifacts',()=>{
    const config=JSON.parse('{"migrations":"migrations","environments":{"production":{"url":"http://localhost:4001","development":false,"auth":{"usernameEnv":"USER","passwordEnv":"PASSWORD","password":"do-not-persist"}}}}');
    expect(()=>createProject(config)).toThrow('only usernameEnv and passwordEnv');
    delete config.environments.production.auth;
    config.environments.production.url='http://user:secret@localhost:4001';
    expect(()=>createProject(config)).toThrow('must not contain credentials');
  });
});
