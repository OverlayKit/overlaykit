import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RestClient, RestError } from '@overlaykit/renderer/services/RestClient';

// Fake a fetch Response with the bits RestClient reads.
function res(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const api = new RestClient('http://api.test');

describe('RestClient', () => {
  it('unwraps a { data } envelope', async () => {
    fetchMock.mockResolvedValue(res(200, { data: { shows: [1, 2] } }));
    await expect(api.get('/shows')).resolves.toEqual({ shows: [1, 2] });
  });

  it('returns the raw body when there is no data envelope (auth routes)', async () => {
    fetchMock.mockResolvedValue(res(200, { user: { id: 'u1' } }));
    await expect(api.get('/auth/me')).resolves.toEqual({ user: { id: 'u1' } });
  });

  it('sends credentials and a JSON body on POST', async () => {
    fetchMock.mockResolvedValue(res(201, { data: { id: 'x' } }));
    await api.post('/shows', { name: 'S' });
    expect(fetchMock).toHaveBeenCalledWith(
      'http://api.test/shows',
      expect.objectContaining({
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'S' }),
      }),
    );
  });

  it('GET has no body and no content-type header', async () => {
    fetchMock.mockResolvedValue(res(200, { data: 1 }));
    await api.get('/x');
    const opts = fetchMock.mock.calls[0][1];
    expect(opts.body).toBeUndefined();
    expect(opts.headers).toBeUndefined();
    expect(opts.credentials).toBe('include');
  });

  it('throws a RestError carrying status/code/message on a non-2xx', async () => {
    fetchMock.mockResolvedValue(res(404, { error: { code: 'NOT_FOUND', message: 'Show not found' } }));
    await expect(api.get('/shows/x')).rejects.toMatchObject({
      name: 'RestError',
      status: 404,
      code: 'NOT_FOUND',
      message: 'Show not found',
    });
  });

  it('falls back to an HTTP message when the error body is absent', async () => {
    fetchMock.mockResolvedValue(res(500, null));
    await expect(api.get('/x')).rejects.toMatchObject({ status: 500, message: 'HTTP 500' });
  });

  it('wraps a network failure as RestError(0, NETWORK)', async () => {
    fetchMock.mockRejectedValue(new Error('offline'));
    const err = (await api.get('/x').catch((e) => e)) as RestError;
    expect(err).toBeInstanceOf(RestError);
    expect(err.status).toBe(0);
    expect(err.code).toBe('NETWORK');
  });

  it('routes put and delete verbs', async () => {
    fetchMock.mockResolvedValue(res(200, { data: true }));
    await api.put('/x', { a: 1 });
    expect(fetchMock.mock.calls[0][1].method).toBe('PUT');
    await api.del('/x');
    expect(fetchMock.mock.calls[1][1].method).toBe('DELETE');
  });
});
