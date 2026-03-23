// ─── http/https polyfill ────────────────────────────────────────────────────
// Supports createServer (for Express) and request/get (for outbound HTTP).

import { EventEmitter } from './events.js';
import { Readable, Writable } from './misc.js';

type ServerHandler = (req: any, res: any) => void;

/** Registry of active HTTP servers — NetBridge reads from this. */
const servers = new Map<number, ServerHandler>();

export function getServerHandler(port: number): ServerHandler | undefined {
  return servers.get(port);
}

export function getAllServers(): Map<number, ServerHandler> {
  return servers;
}

class IncomingMessage extends Readable {
  method = 'GET';
  url = '/';
  headers: Record<string, string> = {};
  httpVersion = '1.1';
  statusCode = 200;
  statusMessage = 'OK';
  _body = '';

  constructor(init?: Partial<IncomingMessage>) {
    super();
    Object.assign(this, init);
  }

  read() { return this._body || null; }
}

class ServerResponse extends Writable {
  statusCode = 200;
  statusMessage = 'OK';
  private _headers: Record<string, string> = {};
  private _body: string[] = [];
  private _ended = false;
  headersSent = false;
  _onFinish?: (res: { statusCode: number; headers: Record<string, string>; body: string }) => void;

  setHeader(name: string, value: string): this { this._headers[name.toLowerCase()] = value; return this; }
  getHeader(name: string): string | undefined { return this._headers[name.toLowerCase()]; }
  removeHeader(name: string): void { delete this._headers[name.toLowerCase()]; }
  getHeaders(): Record<string, string> { return { ...this._headers }; }
  hasHeader(name: string): boolean { return name.toLowerCase() in this._headers; }

  writeHead(statusCode: number, headers?: Record<string, string>): this {
    this.statusCode = statusCode;
    if (headers) for (const [k, v] of Object.entries(headers)) this.setHeader(k, v);
    this.headersSent = true;
    return this;
  }

  write(chunk: any): boolean {
    this._body.push(typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk));
    return true;
  }

  end(chunk?: any, _enc?: any, _cb?: Function): this {
    if (this._ended) return this;
    if (chunk) this.write(chunk);
    this._ended = true;
    this.headersSent = true;
    this._onFinish?.({
      statusCode: this.statusCode,
      headers: this._headers,
      body: this._body.join(''),
    });
    this.emit('finish');
    return this;
  }
}

class Server extends EventEmitter {
  private _handler: ServerHandler;
  private _port = 0;
  private _listening = false;

  constructor(handler: ServerHandler) {
    super();
    this._handler = handler;
  }

  listen(port: number, hostOrCb?: string | Function, cb?: Function): this {
    this._port = port;
    this._listening = true;
    servers.set(port, this._handler);

    const callback = typeof hostOrCb === 'function' ? hostOrCb : cb;
    setTimeout(() => {
      this.emit('listening');
      callback?.();
    }, 0);
    return this;
  }

  close(cb?: Function): this {
    this._listening = false;
    servers.delete(this._port);
    cb?.();
    this.emit('close');
    return this;
  }

  address(): { port: number; address: string; family: string } | null {
    if (!this._listening) return null;
    return { port: this._port, address: '127.0.0.1', family: 'IPv4' };
  }

  /** Handle an incoming request (called by NetBridge). */
  handleRequest(reqInit: { method: string; url: string; headers: Record<string, string>; body?: string }): Promise<{ statusCode: number; headers: Record<string, string>; body: string }> {
    return new Promise((resolve) => {
      const req = new IncomingMessage({
        method: reqInit.method,
        url: reqInit.url,
        headers: reqInit.headers,
        _body: reqInit.body || '',
      });
      const res = new ServerResponse();
      res._onFinish = resolve;

      // If handler doesn't call res.end within 30s, timeout
      const timeout = setTimeout(() => {
        if (!res.headersSent) {
          res.writeHead(504, { 'content-type': 'text/plain' });
          res.end('Gateway Timeout');
        }
      }, 30000);

      res.on('finish', () => clearTimeout(timeout));
      this._handler(req, res);

      // Emit 'data' and 'end' on req for body reading
      if (reqInit.body) {
        setTimeout(() => {
          req.emit('data', reqInit.body);
          req.emit('end');
        }, 0);
      } else {
        setTimeout(() => req.emit('end'), 0);
      }
    });
  }
}

export const http = {
  createServer: (handler: ServerHandler) => new Server(handler),
  request: (opts: any, cb?: Function) => {
    const req = new EventEmitter();
    (req as any).write = () => req;
    (req as any).end = () => {
      // Fire outbound HTTP via browser fetch
      const url = typeof opts === 'string' ? opts : `${opts.protocol || 'http:'}//${opts.hostname || opts.host}${opts.port ? ':' + opts.port : ''}${opts.path || '/'}`;
      fetch(url, { method: opts.method || 'GET', headers: opts.headers })
        .then(async (resp) => {
          const incoming = new IncomingMessage({ statusCode: resp.status, headers: Object.fromEntries(resp.headers) });
          cb?.(incoming);
          const text = await resp.text();
          incoming.emit('data', text);
          incoming.emit('end');
        })
        .catch((err) => (req as any).emit('error', err));
    };
    return req;
  },
  get: (opts: any, cb?: Function) => {
    const req = http.request(opts, cb);
    (req as any).end();
    return req;
  },
  Server,
  IncomingMessage,
  ServerResponse,
  STATUS_CODES: { 200: 'OK', 201: 'Created', 204: 'No Content', 301: 'Moved Permanently', 302: 'Found', 304: 'Not Modified', 400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found', 500: 'Internal Server Error' },
  METHODS: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'],
};

export const https = {
  ...http,
  createServer: http.createServer,
  request: (opts: any, cb?: Function) => http.request({ ...opts, protocol: 'https:' }, cb),
  get: (opts: any, cb?: Function) => https.request(opts, cb),
};
