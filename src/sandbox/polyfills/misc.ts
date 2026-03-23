// ─── Miscellaneous Node.js module polyfills ─────────────────────────────────

import { EventEmitter } from './events.js';

// ─── os ─────────────────────────────────────────────────────────────────────
export const os = {
  platform: () => 'linux',
  arch: () => 'x64',
  type: () => 'Linux',
  release: () => '5.15.0-sandbox',
  homedir: () => '/home',
  tmpdir: () => '/tmp',
  hostname: () => 'clawsandbox',
  userInfo: () => ({ uid: 1000, gid: 1000, username: 'sandbox', homedir: '/home', shell: '/bin/sh' }),
  cpus: () => [{ model: 'ClawSandbox vCPU', speed: 2400, times: { user: 0, nice: 0, sys: 0, idle: 0, irq: 0 } }],
  totalmem: () => 536870912,
  freemem: () => 268435456,
  uptime: () => Math.floor(performance.now() / 1000),
  loadavg: () => [0, 0, 0],
  networkInterfaces: () => ({}),
  endianness: () => 'LE',
  EOL: '\n',
};

// ─── url ────────────────────────────────────────────────────────────────────
export const url = {
  URL: globalThis.URL,
  URLSearchParams: globalThis.URLSearchParams,
  parse: (urlStr: string) => {
    try {
      const u = new URL(urlStr);
      return { protocol: u.protocol, hostname: u.hostname, port: u.port, pathname: u.pathname, search: u.search, hash: u.hash, href: u.href, host: u.host };
    } catch {
      return { href: urlStr, pathname: urlStr, protocol: null, hostname: null, port: null, search: null, hash: null, host: null };
    }
  },
  format: (obj: any) => {
    if (typeof obj === 'string') return obj;
    return `${obj.protocol || 'http:'}//${obj.hostname || ''}${obj.port ? ':' + obj.port : ''}${obj.pathname || '/'}${obj.search || ''}`;
  },
  resolve: (from: string, to: string) => new URL(to, from).href,
};

// ─── querystring ────────────────────────────────────────────────────────────
export const querystring = {
  parse: (str: string) => {
    const params = new URLSearchParams(str);
    const obj: Record<string, string> = {};
    params.forEach((v, k) => { obj[k] = v; });
    return obj;
  },
  stringify: (obj: Record<string, any>) => {
    return Object.entries(obj).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
  },
  encode: undefined as any,
  decode: undefined as any,
};
querystring.encode = querystring.stringify;
querystring.decode = querystring.parse;

// ─── util ───────────────────────────────────────────────────────────────────
export const util = {
  promisify: (fn: Function) => (...args: any[]) => new Promise((resolve, reject) => {
    args.push((err: any, result: any) => { if (err) reject(err); else resolve(result); });
    fn(...args);
  }),
  callbackify: (fn: Function) => (...args: any[]) => {
    const cb = args.pop();
    fn(...args).then((r: any) => cb(null, r)).catch((e: any) => cb(e));
  },
  inherits: (ctor: any, superCtor: any) => {
    ctor.super_ = superCtor;
    ctor.prototype = Object.create(superCtor.prototype, { constructor: { value: ctor } });
  },
  inspect: (obj: any, _opts?: any) => {
    try { return JSON.stringify(obj, null, 2); } catch { return String(obj); }
  },
  format: (fmt: string, ...args: any[]) => {
    let i = 0;
    return fmt.replace(/%[sdj%]/g, (m) => {
      if (m === '%%') return '%';
      if (i >= args.length) return m;
      const val = args[i++];
      if (m === '%s') return String(val);
      if (m === '%d') return Number(val).toString();
      if (m === '%j') return JSON.stringify(val);
      return m;
    });
  },
  deprecate: (fn: Function, _msg: string) => fn,
  isArray: Array.isArray,
  isBuffer: (obj: any) => obj instanceof Uint8Array,
  isFunction: (obj: any) => typeof obj === 'function',
  isString: (obj: any) => typeof obj === 'string',
  isNumber: (obj: any) => typeof obj === 'number',
  isObject: (obj: any) => obj !== null && typeof obj === 'object',
  types: {
    isPromise: (obj: any) => obj instanceof Promise,
    isDate: (obj: any) => obj instanceof Date,
    isRegExp: (obj: any) => obj instanceof RegExp,
  },
  TextEncoder: globalThis.TextEncoder,
  TextDecoder: globalThis.TextDecoder,
};

// ─── crypto (basic) ─────────────────────────────────────────────────────────
export const crypto = {
  randomBytes: (size: number) => {
    const buf = new Uint8Array(size);
    globalThis.crypto.getRandomValues(buf);
    return Object.assign(new Uint8Array(buf), {
      toString: (enc?: string) => {
        if (enc === 'hex') return Array.from(buf).map(b => b.toString(16).padStart(2, '0')).join('');
        if (enc === 'base64') { let s = ''; for (const b of buf) s += String.fromCharCode(b); return btoa(s); }
        return String.fromCharCode(...buf);
      },
    });
  },
  randomUUID: () => globalThis.crypto.randomUUID(),
  createHash: (_algo: string) => {
    let data = '';
    return {
      update(input: string) { data += input; return this; },
      digest(encoding?: string) {
        // Simple non-cryptographic hash for polyfill purposes
        let hash = 0;
        for (let i = 0; i < data.length; i++) {
          hash = ((hash << 5) - hash + data.charCodeAt(i)) | 0;
        }
        const hex = Math.abs(hash).toString(16).padStart(8, '0');
        if (encoding === 'hex') return hex;
        if (encoding === 'base64') return btoa(hex);
        return hex;
      },
    };
  },
  createHmac: (_algo: string, key: string) => {
    let data = '';
    return {
      update(input: string) { data += input; return this; },
      digest(encoding?: string) {
        let hash = 0;
        const combined = key + data;
        for (let i = 0; i < combined.length; i++) hash = ((hash << 5) - hash + combined.charCodeAt(i)) | 0;
        const hex = Math.abs(hash).toString(16).padStart(8, '0');
        if (encoding === 'hex') return hex;
        return hex;
      },
    };
  },
};

// ─── stream (basic) ─────────────────────────────────────────────────────────
export class Readable extends EventEmitter {
  readable = true;
  read(_size?: number): any { return null; }
  pipe(dest: any): any { return dest; }
  unpipe(): this { return this; }
  destroy(): this { this.readable = false; return this; }
  push(_chunk: any): boolean { return true; }
  setEncoding(): this { return this; }
  resume(): this { return this; }
  pause(): this { return this; }
}

export class Writable extends EventEmitter {
  writable = true;
  write(_chunk: any, _enc?: any, _cb?: Function): boolean { if (typeof _enc === 'function') _enc(); else _cb?.(); return true; }
  end(_chunk?: any, _enc?: any, _cb?: Function): this { if (typeof _chunk === 'function') _chunk(); else if (typeof _enc === 'function') _enc(); else _cb?.(); return this; }
  destroy(): this { this.writable = false; return this; }
}

export class Transform extends Readable {
  writable = true;
  _transform(_chunk: any, _enc: string, cb: Function) { cb(); }
  write(chunk: any, enc?: any, cb?: Function): boolean { this._transform(chunk, enc, cb || (() => {})); return true; }
  end(): this { this.emit('end'); return this; }
}

export class PassThrough extends Transform {
  _transform(chunk: any, _enc: string, cb: Function) { this.push(chunk); cb(); }
}

export const stream = { Readable, Writable, Transform, PassThrough, pipeline: (...args: any[]) => { const cb = args.pop(); cb(null); } };

// ─── child_process (stub) ───────────────────────────────────────────────────
export const child_process = {
  exec: (_cmd: string, _opts: any, cb?: Function) => {
    if (typeof _opts === 'function') { cb = _opts; }
    cb?.(new Error('child_process.exec not supported in sandbox'));
    return new EventEmitter();
  },
  execSync: (_cmd: string) => { throw new Error('child_process.execSync not supported in sandbox'); },
  spawn: (_cmd: string, _args?: string[]) => {
    const proc = new EventEmitter();
    (proc as any).stdin = new Writable();
    (proc as any).stdout = new Readable();
    (proc as any).stderr = new Readable();
    (proc as any).pid = 0;
    setTimeout(() => proc.emit('exit', 1), 0);
    return proc;
  },
  fork: () => { throw new Error('child_process.fork not supported in sandbox'); },
};

// ─── readline ───────────────────────────────────────────────────────────────
export const readline = {
  createInterface: (opts: any) => {
    const rl = new EventEmitter();
    (rl as any).question = (prompt: string, cb: Function) => {
      opts?.output?.write?.(prompt);
      cb('');
    };
    (rl as any).close = () => { (rl as any).emit('close'); };
    (rl as any).prompt = () => { opts?.output?.write?.('> '); };
    (rl as any).setPrompt = () => {};
    (rl as any).write = () => {};
    return rl;
  },
};

// ─── assert ─────────────────────────────────────────────────────────────────
export const assert = Object.assign(
  (val: any, msg?: string) => { if (!val) throw new Error(msg || 'Assertion failed'); },
  {
    ok: (val: any, msg?: string) => { if (!val) throw new Error(msg || 'Assertion failed'); },
    equal: (a: any, b: any, msg?: string) => { if (a != b) throw new Error(msg || `${a} != ${b}`); },
    strictEqual: (a: any, b: any, msg?: string) => { if (a !== b) throw new Error(msg || `${a} !== ${b}`); },
    deepEqual: (a: any, b: any, msg?: string) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(msg || 'Not deep equal'); },
    deepStrictEqual: (a: any, b: any, msg?: string) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(msg || 'Not deep strict equal'); },
    notEqual: (a: any, b: any, msg?: string) => { if (a == b) throw new Error(msg || `${a} == ${b}`); },
    throws: (fn: Function, msg?: string) => { try { fn(); throw new Error(msg || 'Expected to throw'); } catch { /* ok */ } },
    doesNotThrow: (fn: Function, msg?: string) => { try { fn(); } catch { throw new Error(msg || 'Did not expect to throw'); } },
    fail: (msg?: string) => { throw new Error(msg || 'Failed'); },
  },
);
