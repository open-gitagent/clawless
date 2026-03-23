// ─── NetBridge: HTTP Server Support ─────────────────────────────────────────
// Intercepts fetch requests to localhost ports and routes them to
// sandbox HTTP servers (Express, etc.) running in the VFS.

import { getAllServers } from './polyfills/http.js';

export class NetBridge {
  private portUrls = new Map<number, string>();
  private listeners: Array<(port: number, url: string) => void> = [];

  /** Start listening for server registrations. */
  start(): void {
    // Poll for new servers every 500ms
    setInterval(() => {
      const servers = getAllServers();
      for (const [port] of servers) {
        if (!this.portUrls.has(port)) {
          const url = `http://localhost:${port}`;
          this.portUrls.set(port, url);
          for (const fn of this.listeners) fn(port, url);
        }
      }
    }, 500);
  }

  /** Register a listener for server-ready events. */
  onServerReady(fn: (port: number, url: string) => void): void {
    this.listeners.push(fn);
    // Fire for already-known servers
    for (const [port, url] of this.portUrls) fn(port, url);
  }

  /** Handle a fetch request to a sandbox server. */
  async handleRequest(port: number, req: {
    method: string;
    url: string;
    headers: Record<string, string>;
    body?: string;
  }): Promise<{ status: number; headers: Record<string, string>; body: string } | null> {
    const servers = getAllServers();
    const handler = servers.get(port);
    if (!handler) return null;

    // Create a mock request/response and route through the server
    return new Promise((resolve) => {
      const http = import('./polyfills/http.js');
      http.then(() => {
        // Find the Server instance
        const serverInstances = getAllServers();
        const serverHandler = serverInstances.get(port);
        if (!serverHandler) { resolve(null); return; }

        // We need to call the handler directly
        // The http.Server class has a handleRequest method
        const fakeReq: any = {
          method: req.method,
          url: req.url,
          headers: req.headers,
          on: (event: string, cb: Function) => {
            if (event === 'data' && req.body) setTimeout(() => cb(req.body), 0);
            if (event === 'end') setTimeout(() => cb(), req.body ? 10 : 0);
          },
          pipe: () => {},
        };

        const chunks: string[] = [];
        let statusCode = 200;
        const resHeaders: Record<string, string> = {};

        const fakeRes: any = {
          statusCode: 200,
          setHeader: (k: string, v: string) => { resHeaders[k.toLowerCase()] = v; },
          getHeader: (k: string) => resHeaders[k.toLowerCase()],
          writeHead: (code: number, headers?: Record<string, string>) => {
            statusCode = code;
            if (headers) Object.entries(headers).forEach(([k, v]) => { resHeaders[k.toLowerCase()] = v; });
            return fakeRes;
          },
          write: (chunk: any) => { chunks.push(String(chunk)); return true; },
          end: (chunk?: any) => {
            if (chunk) chunks.push(String(chunk));
            resolve({ status: statusCode, headers: resHeaders, body: chunks.join('') });
          },
          on: () => fakeRes,
          once: () => fakeRes,
          emit: () => false,
        };

        try {
          serverHandler(fakeReq, fakeRes);
        } catch (e) {
          resolve({ status: 500, headers: {}, body: (e as Error).message });
        }
      });
    });
  }

  /** Get URL for a server port. */
  getUrl(port: number): string | undefined {
    return this.portUrls.get(port);
  }
}
