// ─── ClawNet: Network Layer ─────────────────────────────────────────────────
// Provides fetch() capabilities to processes running inside ClawKernel.
// All requests are proxied through the main thread's fetch(), giving us
// automatic audit logging without needing network-hook.cjs.

export interface NetRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

export interface NetResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
  durationMs: number;
}

export type NetAuditCallback = (type: 'request' | 'response', data: NetRequest | NetResponse & { url: string; method: string }) => void;

export class ClawNet {
  private auditCallback: NetAuditCallback | null = null;

  /** Set the audit callback for network request logging. */
  onAudit(cb: NetAuditCallback): void {
    this.auditCallback = cb;
  }

  /**
   * Proxy a fetch request from a process.
   * This runs on the main thread, so browser fetch() works normally.
   */
  async proxyFetch(req: NetRequest): Promise<NetResponse> {
    // Audit the request
    this.auditCallback?.('request', {
      url: req.url,
      method: req.method,
      headers: req.headers,
    });

    const start = performance.now();

    try {
      const resp = await fetch(req.url, {
        method: req.method,
        headers: req.headers,
        body: req.body || undefined,
      });

      const durationMs = Math.round(performance.now() - start);
      const respHeaders: Record<string, string> = {};
      resp.headers.forEach((v, k) => { respHeaders[k] = v; });

      let body = '';
      try {
        body = await resp.text();
      } catch {
        body = '[binary or unreadable]';
      }

      const result: NetResponse = {
        status: resp.status,
        headers: respHeaders,
        body: body.length > 8192 ? body.slice(0, 8192) + '...[truncated]' : body,
        durationMs,
      };

      // Audit the response
      this.auditCallback?.('response', {
        ...result,
        url: req.url,
        method: req.method,
      });

      return result;
    } catch (e) {
      const durationMs = Math.round(performance.now() - start);
      const result: NetResponse = {
        status: 0,
        headers: {},
        body: `Network error: ${(e as Error).message}`,
        durationMs,
      };

      this.auditCallback?.('response', {
        ...result,
        url: req.url,
        method: req.method,
      });

      return result;
    }
  }
}
