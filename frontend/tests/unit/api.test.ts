import { api, ApiError, getAll, setAccessToken, setSessionLostHandler } from '../../src/lib/api';

const json = (status: number, body: unknown) => new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
let calls: { url: string; init: RequestInit }[] = [];
const mockFetch = (...responses: (Response | ((url: string) => Response))[]) => {
  calls = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const r = responses.shift();
    if (!r) throw new Error('unexpected request ' + url);
    return typeof r === 'function' ? r(url) : r;
  }));
};
afterEach(() => { vi.unstubAllGlobals(); setAccessToken(null); });

describe('api client', () => {
  it('sends the bearer token, web headers and a JSON body', async () => {
    setAccessToken('abc');
    mockFetch(json(200, { ok: 1 }));
    await api('POST', '/x', { body: { a: 1 }, query: { q: 'v', empty: '' } });
    expect(calls[0].url).toBe('/api/v1/x?q=v');
    const h = calls[0].init.headers as Record<string, string>;
    expect(h.Authorization).toBe('Bearer abc');
    expect(h['X-Client']).toBe('web');
    expect(h['X-Requested-With']).toBe('XMLHttpRequest');
    expect(calls[0].init.body).toBe('{"a":1}');
    expect(calls[0].init.credentials).toBe('include');
  });

  it('turns the error envelope into an ApiError with code, details and extras', async () => {
    mockFetch(json(401, { error: { code: 'INVALID_PIN', message: 'wrong', attemptsLeft: 3 } }));
    const e = (await api('POST', '/kiosk/verify', { device: true }).catch((x) => x)) as ApiError;
    expect(e).toBeInstanceOf(ApiError);
    expect(e).toMatchObject({ status: 401, code: 'INVALID_PIN', message: 'wrong', extra: { attemptsLeft: 3 } });
  });

  it('refreshes once on TOKEN_EXPIRED and retries with the new token', async () => {
    setAccessToken('old');
    mockFetch(json(401, { error: { code: 'TOKEN_EXPIRED', message: 'x' } }), json(200, { accessToken: 'new' }), json(200, { done: true }));
    expect(await api('GET', '/me')).toEqual({ done: true });
    expect(calls.map((c) => c.url)).toEqual(['/api/v1/me', '/api/v1/auth/refresh', '/api/v1/me']);
    expect((calls[2].init.headers as Record<string, string>).Authorization).toBe('Bearer new');
  });

  it('single-flights concurrent refreshes', async () => {
    setAccessToken('old');
    const expired = () => json(401, { error: { code: 'TOKEN_EXPIRED', message: 'x' } });
    mockFetch(expired(), expired(), json(200, { accessToken: 'new' }), json(200, { n: 1 }), json(200, { n: 2 }));
    const [a, b] = await Promise.all([api('GET', '/a'), api('GET', '/b')]);
    expect([a, b]).toEqual([{ n: 1 }, { n: 2 }]);
    expect(calls.filter((c) => c.url.endsWith('/auth/refresh'))).toHaveLength(1);
  });

  it('ends the session when the refresh fails', async () => {
    const lost = vi.fn();
    setSessionLostHandler(lost);
    setAccessToken('old');
    mockFetch(json(401, { error: { code: 'TOKEN_EXPIRED', message: 'x' } }), json(401, { error: { code: 'UNAUTHENTICATED', message: 'x' } }));
    await expect(api('GET', '/me')).rejects.toMatchObject({ code: 'TOKEN_EXPIRED' });
    expect(lost).toHaveBeenCalled();
  });

  it('does not refresh for wrong credentials', async () => {
    mockFetch(json(401, { error: { code: 'INVALID_CREDENTIALS', message: 'no' } }));
    await expect(api('POST', '/auth/login', { noAuth: true, body: {} })).rejects.toMatchObject({ code: 'INVALID_CREDENTIALS' });
    expect(calls).toHaveLength(1);
  });

  it('handles 204 and pages through list endpoints', async () => {
    mockFetch(json(204, null));
    expect(await api('DELETE', '/x')).toBeUndefined();
    mockFetch(json(200, { data: [1, 2], meta: { total: 3 } }), json(200, { data: [3], meta: { total: 3 } }));
    expect(await getAll('/things')).toEqual([1, 2, 3]);
    expect(calls[1].url).toContain('page=2');
  });
});
