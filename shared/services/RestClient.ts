// Small REST client shared by OverlayKit apps.
// Responses are unwrapped: { data: X } -> X, otherwise the raw body.

export class RestError extends Error {
  constructor(
    public status: number,
    public code: string | undefined,
    message: string,
  ) {
    super(message);
    this.name = 'RestError';
  }
}

type Method = 'GET' | 'POST' | 'PUT' | 'DELETE';

export class RestClient {
  constructor(private baseUrl: string) {}

  private async request<T>(method: Method, path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await fetch(this.baseUrl + path, {
        method,
        headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
        credentials: 'include',
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch (e) {
      throw new RestError(0, 'NETWORK', `Network error: ${String(e)}`);
    }
    const json = await res.json().catch(() => null);
    if (!res.ok) {
      throw new RestError(res.status, json?.error?.code, json?.error?.message || `HTTP ${res.status}`);
    }
    return (json && json.data !== undefined ? json.data : json) as T;
  }

  get<T>(path: string): Promise<T> {
    return this.request<T>('GET', path);
  }
  post<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>('POST', path, body);
  }
  put<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>('PUT', path, body);
  }
  del<T>(path: string): Promise<T> {
    return this.request<T>('DELETE', path);
  }
}
