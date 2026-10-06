import { ApiError } from './errors.js';
export type Fetch = typeof globalThis.fetch;
export class HttpClient {
  constructor(private timeout: number, private fetcher: Fetch = globalThis.fetch) {}
  async request(base: string, path: string, headers: Record<string, string>, body?: unknown, method?: string): Promise<any> {
    let response: Response;
    try {
      response = await this.fetcher(base.replace(/\/$/, '') + path, {
        method: method ?? (body === undefined ? 'GET' : 'POST'),
        headers: { 'Content-Type': 'application/json', ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeout),
        redirect: 'error',
      });
    } catch {
      throw new ApiError(504, 'UPSTREAM_OUTCOME_UNKNOWN', 'The supplier did not return a response. Inspect the operation before retrying.', undefined, true);
    }
    let data: any;
    try { data = await response.json(); }
    catch {
      if (response.ok) throw new ApiError(502, 'UPSTREAM_INVALID_RESPONSE', 'The supplier returned an invalid response.', undefined, true);
      data = {};
    }
    if (!response.ok) {
      // Supplier messages can contain traveler data. Return codes only.
      const codes = Array.isArray(data?.errors) ? data.errors.map((e: any) => e.code).filter((v: unknown) => typeof v === 'string') : [];
      throw new ApiError(response.status === 429 ? 429 : 502, 'UPSTREAM_REJECTED', `Supplier HTTP ${response.status}.`, {
        upstream_status: response.status, codes,
      }, response.status >= 500 || response.status === 408);
    }
    return data;
  }
}
