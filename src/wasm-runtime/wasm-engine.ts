// ─── WasmEngine: QuickJS Asyncify Execution Engine ──────────────────────────
// Runs JavaScript via QuickJS WASM with async host function support.
// The asyncify variant allows synchronous JS code to call async browser APIs
// (fetch, setTimeout, etc.) — this is the key to Node.js compat.

// @ts-ignore — quickjs-emscripten types resolve at runtime
import { newQuickJSAsyncWASMModule } from 'quickjs-emscripten';
// @ts-ignore
import type { QuickJSWASMModule, QuickJSAsyncContext, QuickJSAsyncRuntime, QuickJSHandle } from 'quickjs-emscripten-core';
import type { VirtualFS } from '../sandbox/vfs.js';
import { createBuiltinModules, type PolyfillContext } from '../sandbox/polyfills/index.js';
// import { BufferPolyfill } from '../sandbox/polyfills/buffer.js';
import * as pathModule from '../sandbox/polyfills/path.js';

let moduleCache: QuickJSWASMModule | null = null;

export interface WasmEngineOptions {
  vfs: VirtualFS;
  env: Record<string, string>;
  argv: string[];
  cwd: string;
  stdout: (data: string) => void;
  stderr: (data: string) => void;
  onExit?: (code: number) => void;
}

export class WasmEngine {
  private module: QuickJSWASMModule | null = null;
  private rt: QuickJSAsyncRuntime | null = null;
  private ctx: QuickJSAsyncContext | null = null;
  private opts: WasmEngineOptions;
  private builtins: Record<string, any>;
  
  private exitCode = 0;

  constructor(opts: WasmEngineOptions) {
    this.opts = opts;
    const polyfillCtx: PolyfillContext = {
      vfs: opts.vfs,
      env: opts.env,
      argv: opts.argv,
      cwd: opts.cwd,
      stdout: opts.stdout,
      stderr: opts.stderr,
      onExit: opts.onExit,
    };
    this.builtins = createBuiltinModules(polyfillCtx);
  }

  /** Initialize QuickJS async runtime. */
  async init(): Promise<void> {
    if (!moduleCache) {
      moduleCache = await newQuickJSAsyncWASMModule();
    }
    this.module = moduleCache;
    this.rt = this.module.newRuntime();
    this.rt.setMemoryLimit(256 * 1024 * 1024); // 256MB
    this.rt.setMaxStackSize(1024 * 1024); // 1MB stack

    // Set module loader for require/import
    this.rt.setModuleLoader(
      (moduleName: string) => {
        // Try to load from VFS
        try {
          const resolved = this.resolveModule(moduleName);
          if (resolved) {
            return this.opts.vfs.readFileSync(resolved, 'utf-8') as string;
          }
        } catch { /* */ }
        return { error: new Error(`Cannot find module '${moduleName}'`) };
      },
      (baseModuleName: string, requestedName: string) => {
        if (requestedName.startsWith('./') || requestedName.startsWith('../')) {
          const dir = pathModule.dirname(baseModuleName);
          return pathModule.resolve(dir, requestedName);
        }
        return requestedName;
      },
    );

    this.ctx = this.rt.newContext();
    await this.installGlobals();
  }

  /** Execute JavaScript code asynchronously. */
  async run(code: string, filename = 'index.js'): Promise<number> {
    if (!this.ctx) throw new Error('Engine not initialized');

    try {
      const result = await this.ctx.evalCodeAsync(code, filename);
      if (result.error) {
        const err = this.ctx.dump(result.error);
        result.error.dispose();
        this.opts.stderr(`${err?.message || String(err)}\n${err?.stack || ''}\n`);
        return 1;
      }
      result.value.dispose();

      // Execute pending jobs (timers, promises)
      while (this.rt!.hasPendingJob()) {
        const jobResult = this.rt!.executePendingJobs();
        if ('error' in jobResult) {
          const err = this.ctx.dump(jobResult.error);
          jobResult.error.dispose();
          this.opts.stderr(`Async error: ${err?.message || String(err)}\n`);
        }
      }

      return this.exitCode;
    } catch (e) {
      const msg = (e as Error).message;
      if (msg?.startsWith('__SANDBOX_EXIT__:')) {
        return parseInt(msg.split(':')[1], 10);
      }
      this.opts.stderr(`Runtime error: ${msg}\n`);
      return 1;
    }
  }

  /** Execute a file from the VFS. */
  async runFile(filePath: string): Promise<number> {
    const absPath = pathModule.isAbsolute(filePath)
      ? filePath
      : pathModule.resolve(this.opts.cwd, filePath);

    let code: string;
    try {
      code = this.opts.vfs.readFileSync(absPath, 'utf-8') as string;
    } catch {
      this.opts.stderr(`Cannot read: ${absPath}\n`);
      return 1;
    }
    return this.run(code, absPath);
  }

  dispose(): void {
    this.ctx?.dispose();
    this.rt?.dispose();
    this.ctx = null;
    this.rt = null;
  }

  // ─── Module Resolution ────────────────────────────────────────────────

  private resolveModule(spec: string): string | null {
    if (this.builtins[spec]) return null; // built-in, no file needed

    // Relative path
    if (spec.startsWith('./') || spec.startsWith('../') || spec.startsWith('/')) {
      const base = spec.startsWith('/') ? spec : pathModule.resolve(this.opts.cwd, spec);
      return this.resolveFile(base);
    }

    // node_modules lookup
    const candidates = [
      `/node_modules/${spec}`,
      `${this.opts.cwd}/node_modules/${spec}`,
    ];
    for (const base of candidates) {
      const resolved = this.resolveFile(base);
      if (resolved) return resolved;
    }
    return null;
  }

  private resolveFile(base: string): string | null {
    const exts = ['', '.js', '.mjs', '.cjs', '.json', '/index.js', '/index.mjs', '/index.json'];
    for (const ext of exts) {
      const candidate = base + ext;
      if (this.opts.vfs.existsSync(candidate)) {
        try {
          if (this.opts.vfs.statSync(candidate).isFile()) return candidate;
        } catch { /* */ }
      }
    }
    // Check package.json main
    const pkgPath = base + '/package.json';
    if (this.opts.vfs.existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(this.opts.vfs.readFileSync(pkgPath, 'utf-8') as string);
        const main = pkg.main || pkg.module || 'index.js';
        return this.resolveFile(pathModule.resolve(base, main));
      } catch { /* */ }
    }
    return null;
  }

  // ─── Global Installation ──────────────────────────────────────────────

  private async installGlobals(): Promise<void> {
    const ctx = this.ctx!;

    // console
    this.installHostFn('__stdout', (...args) => {
      const parts = args.map(a => { const v = ctx.dump(a); return typeof v === 'string' ? v : JSON.stringify(v); });
      this.opts.stdout(parts.join(' ') + '\n');
    });
    this.installHostFn('__stderr', (...args) => {
      const parts = args.map(a => { const v = ctx.dump(a); return typeof v === 'string' ? v : JSON.stringify(v); });
      this.opts.stderr(parts.join(' ') + '\n');
    });

    // fs operations (sync, host-side)
    this.installHostFn('__fs_readFileSync', (...args) => {
      const path = ctx.getString(args[0]);
      const enc = args[1] ? ctx.dump(args[1]) : undefined;
      try {
        const content = this.opts.vfs.readFileSync(path, enc);
        return ctx.newString(typeof content === 'string' ? content : new TextDecoder().decode(content));
      } catch (e) {
        return ctx.throw(ctx.newError((e as Error).message));
      }
    });

    this.installHostFn('__fs_writeFileSync', (...args) => {
      const path = ctx.getString(args[0]);
      const content = ctx.getString(args[1]);
      try {
        this.opts.vfs.writeFileSync(path, content);
      } catch (e) {
        return ctx.throw(ctx.newError((e as Error).message));
      }
    });

    this.installHostFn('__fs_existsSync', (...args) => {
      return this.opts.vfs.existsSync(ctx.getString(args[0])) ? ctx.true : ctx.false;
    });

    this.installHostFn('__fs_mkdirSync', (...args) => {
      try {
        this.opts.vfs.mkdirSync(ctx.getString(args[0]), { recursive: true });
      } catch { /* */ }
    });

    this.installHostFn('__fs_readdirSync', (...args) => {
      const path = ctx.getString(args[0]);
      try {
        const entries = this.opts.vfs.readdirSync(path) as string[];
        const arr = ctx.newArray();
        entries.forEach((name, i) => {
          const val = ctx.newString(name as string);
          ctx.setProp(arr, i, val);
          val.dispose();
        });
        return arr;
      } catch (e) {
        return ctx.throw(ctx.newError((e as Error).message));
      }
    });

    this.installHostFn('__fs_statSync', (...args) => {
      const path = ctx.getString(args[0]);
      try {
        const stat = this.opts.vfs.statSync(path);
        const obj = ctx.newObject();
        const isFile = ctx.newFunction('isFile', () => stat.isFile() ? ctx.true : ctx.false);
        const isDir = ctx.newFunction('isDirectory', () => stat.isDirectory() ? ctx.true : ctx.false);
        const size = ctx.newNumber(stat.size);
        ctx.setProp(obj, 'isFile', isFile);
        ctx.setProp(obj, 'isDirectory', isDir);
        ctx.setProp(obj, 'size', size);
        isFile.dispose(); isDir.dispose(); size.dispose();
        return obj;
      } catch (e) {
        return ctx.throw(ctx.newError((e as Error).message));
      }
    });

    this.installHostFn('__fs_unlinkSync', (...args) => {
      try { this.opts.vfs.unlinkSync(ctx.getString(args[0])); } catch { /* */ }
    });

    this.installHostFn('__fs_rmSync', (...args) => {
      try { this.opts.vfs.rmSync(ctx.getString(args[0]), { recursive: true, force: true }); } catch { /* */ }
    });

    // Async fetch — the magic of asyncify!
    const fetchFn = ctx.newAsyncifiedFunction('__fetch_async', async (...args: QuickJSHandle[]) => {
      const url = ctx.getString(args[0]);
      const optsHandle = args[1];
      const fetchOpts: RequestInit = {};

      if (optsHandle) {
        const opts = ctx.dump(optsHandle);
        if (opts?.method) fetchOpts.method = opts.method;
        if (opts?.headers) fetchOpts.headers = opts.headers;
        if (opts?.body) fetchOpts.body = opts.body;
      }

      try {
        const resp = await fetch(url, fetchOpts);
        const body = await resp.text();

        const result = ctx.newObject();
        const statusHandle = ctx.newNumber(resp.status);
        const okHandle = resp.ok ? ctx.true : ctx.false;
        const bodyHandle = ctx.newString(body);

        // json() method
        const jsonFn = ctx.newFunction('json', () => {
          try {
            const parsed = JSON.parse(body);
            return this.jsToQuickJS(parsed);
          } catch {
            return ctx.throw(ctx.newError('Invalid JSON'));
          }
        });

        // text() method
        const textFn = ctx.newFunction('text', () => ctx.newString(body));

        ctx.setProp(result, 'status', statusHandle);
        ctx.setProp(result, 'ok', okHandle);
        ctx.setProp(result, 'body', bodyHandle);
        ctx.setProp(result, 'json', jsonFn);
        ctx.setProp(result, 'text', textFn);

        statusHandle.dispose(); bodyHandle.dispose(); jsonFn.dispose(); textFn.dispose();
        return result;
      } catch (e) {
        return ctx.throw(ctx.newError(`fetch failed: ${(e as Error).message}`));
      }
    });
    ctx.setProp(ctx.global, '__fetch_async', fetchFn);
    fetchFn.dispose();

    // Install the JS-side shims (require, console, process, Buffer, etc.)
    this.evalSetup(this.buildShimCode());
  }

  private installHostFn(name: string, impl: (...args: QuickJSHandle[]) => QuickJSHandle | void): void {
    const fn = this.ctx!.newFunction(name, impl);
    this.ctx!.setProp(this.ctx!.global, name, fn);
    fn.dispose();
  }

  private evalSetup(code: string): void {
    if (!this.ctx) return;
    const result = this.ctx.evalCode(code, '<setup>');
    if ('error' in result) {
      const err = this.ctx.dump(result.error);
      result.error.dispose();
      console.warn('[WasmEngine setup error]', err);
    } else {
      result.value.dispose();
    }
  }

  private jsToQuickJS(val: any): QuickJSHandle {
    const ctx = this.ctx!;
    if (val === null || val === undefined) return ctx.undefined;
    if (typeof val === 'string') return ctx.newString(val);
    if (typeof val === 'number') return ctx.newNumber(val);
    if (typeof val === 'boolean') return val ? ctx.true : ctx.false;
    if (Array.isArray(val)) {
      const arr = ctx.newArray();
      val.forEach((item, i) => {
        const h = this.jsToQuickJS(item);
        ctx.setProp(arr, i, h);
        h.dispose();
      });
      return arr;
    }
    if (typeof val === 'object') {
      const obj = ctx.newObject();
      for (const [k, v] of Object.entries(val)) {
        const h = this.jsToQuickJS(v);
        ctx.setProp(obj, k, h);
        h.dispose();
      }
      return obj;
    }
    return ctx.undefined;
  }

  // ─── JS Shim Code (runs inside QuickJS) ───────────────────────────────

  private buildShimCode(): string {
    const env = JSON.stringify(this.opts.env);
    const argv = JSON.stringify(['node', ...this.opts.argv]);
    const cwd = JSON.stringify(this.opts.cwd);

    return `
// ── Console ──
globalThis.console = {
  log: function() { __stdout.apply(null, arguments); },
  info: function() { __stdout.apply(null, arguments); },
  debug: function() { __stdout.apply(null, arguments); },
  warn: function() { __stderr.apply(null, arguments); },
  error: function() { __stderr.apply(null, arguments); },
  trace: function() { __stderr.apply(null, arguments); },
  dir: function(o) { __stdout(JSON.stringify(o, null, 2)); },
  table: function(o) { __stdout(JSON.stringify(o, null, 2)); },
  assert: function(c) { if (!c) __stderr('Assertion failed'); },
  time: function(){}, timeEnd: function(){}, timeLog: function(){},
  clear: function(){}, count: function(){}, countReset: function(){},
  group: function(){}, groupEnd: function(){},
};

// ── Process ──
globalThis.process = {
  env: ${env},
  argv: ${argv},
  cwd: function() { return ${cwd}; },
  exit: function(code) { throw new Error('__SANDBOX_EXIT__:' + (code || 0)); },
  stdout: { write: function(d) { __stdout(String(d)); return true; }, isTTY: true, columns: 80, rows: 24 },
  stderr: { write: function(d) { __stderr(String(d)); return true; }, isTTY: true },
  stdin: { isTTY: true, on: function(){}, read: function(){ return null; } },
  platform: 'linux',
  arch: 'x64',
  version: 'v20.0.0',
  versions: { node: '20.0.0' },
  pid: 1,
  ppid: 0,
  nextTick: function(fn) { Promise.resolve().then(fn); },
  hrtime: function() { return [0, 0]; },
  memoryUsage: function() { return { rss: 0, heapTotal: 0, heapUsed: 0 }; },
  uptime: function() { return 0; },
  umask: function() { return 0o022; },
};

// ── Buffer ──
globalThis.Buffer = {
  from: function(d, enc) {
    if (typeof d === 'string') return { toString: function() { return d; }, length: d.length };
    return { toString: function() { return ''; }, length: 0 };
  },
  alloc: function(n) { return { toString: function() { return ''; }, length: n, fill: function(){} }; },
  isBuffer: function() { return false; },
  concat: function(bufs) { return { toString: function() { return bufs.map(function(b){return b.toString()}).join(''); } }; },
  byteLength: function(s) { return s.length; },
};

// ── Fetch (async via asyncify) ──
globalThis.fetch = async function(url, opts) {
  return __fetch_async(String(url), opts ? JSON.stringify(opts) : undefined);
};

// ── FS module ──
var __fs = {
  readFileSync: function(p, opts) {
    var enc = (typeof opts === 'string') ? opts : (opts && opts.encoding);
    return __fs_readFileSync(p, enc || 'utf-8');
  },
  writeFileSync: function(p, d) { __fs_writeFileSync(p, String(d)); },
  existsSync: function(p) { return __fs_existsSync(p); },
  mkdirSync: function(p, opts) { __fs_mkdirSync(p); },
  readdirSync: function(p) { return __fs_readdirSync(p); },
  statSync: function(p) { return __fs_statSync(p); },
  unlinkSync: function(p) { __fs_unlinkSync(p); },
  rmSync: function(p) { __fs_rmSync(p); },
  chmodSync: function(){},
  symlinkSync: function(){},
  readFile: function(p, opts, cb) {
    if (typeof opts === 'function') { cb = opts; opts = undefined; }
    try { var r = __fs.readFileSync(p, opts); cb(null, r); } catch(e) { cb(e); }
  },
  writeFile: function(p, d, opts, cb) {
    if (typeof opts === 'function') { cb = opts; }
    try { __fs.writeFileSync(p, d); if(cb) cb(null); } catch(e) { if(cb) cb(e); }
  },
  mkdir: function(p, opts, cb) {
    if (typeof opts === 'function') { cb = opts; }
    try { __fs.mkdirSync(p, opts); if(cb) cb(null); } catch(e) { if(cb) cb(e); }
  },
  readdir: function(p, opts, cb) {
    if (typeof opts === 'function') { cb = opts; }
    try { var r = __fs.readdirSync(p); cb(null, r); } catch(e) { cb(e); }
  },
  watch: function() { return { close: function(){} }; },
  promises: {
    readFile: async function(p, opts) { return __fs.readFileSync(p, opts); },
    writeFile: async function(p, d) { __fs.writeFileSync(p, d); },
    mkdir: async function(p, opts) { __fs.mkdirSync(p, opts); },
    readdir: async function(p) { return __fs.readdirSync(p); },
    stat: async function(p) { return __fs.statSync(p); },
    unlink: async function(p) { __fs.unlinkSync(p); },
    rm: async function(p) { __fs.rmSync(p); },
  },
  constants: { F_OK: 0, R_OK: 4, W_OK: 2, X_OK: 1 },
};

// ── Path module ──
var __path = {
  join: function() { return Array.prototype.slice.call(arguments).join('/').replace(/\\/\\/+/g, '/'); },
  resolve: function() { return Array.prototype.slice.call(arguments).join('/').replace(/\\/\\/+/g, '/'); },
  dirname: function(p) { var i = p.lastIndexOf('/'); return i <= 0 ? '/' : p.substring(0, i); },
  basename: function(p, e) { var b = p.substring(p.lastIndexOf('/') + 1); if (e && b.endsWith(e)) b = b.slice(0, -e.length); return b; },
  extname: function(p) { var i = p.lastIndexOf('.'); return i === -1 ? '' : p.substring(i); },
  sep: '/',
  normalize: function(p) { return p.replace(/\\/\\/+/g, '/'); },
  isAbsolute: function(p) { return p.charAt(0) === '/'; },
  posix: { sep: '/' },
};

// ── Events ──
function EventEmitter() { this._e = {}; }
EventEmitter.prototype.on = function(n, f) { if(!this._e[n]) this._e[n]=[]; this._e[n].push(f); return this; };
EventEmitter.prototype.once = function(n, f) { var s=this; function w(){ f.apply(this,arguments); s.removeListener(n,w); } this.on(n,w); return this; };
EventEmitter.prototype.emit = function(n) { var a=Array.prototype.slice.call(arguments,1), l=this._e[n]||[]; for(var i=0;i<l.length;i++) l[i].apply(this,a); return l.length>0; };
EventEmitter.prototype.removeListener = function(n, f) { this._e[n]=(this._e[n]||[]).filter(function(x){return x!==f}); return this; };
EventEmitter.prototype.removeAllListeners = function(n) { if(n) delete this._e[n]; else this._e={}; return this; };
EventEmitter.prototype.off = EventEmitter.prototype.removeListener;
EventEmitter.prototype.addListener = EventEmitter.prototype.on;
EventEmitter.prototype.listenerCount = function(n) { return (this._e[n]||[]).length; };
EventEmitter.prototype.setMaxListeners = function() { return this; };

// ── Module registry ──
var __modules = {
  fs: __fs,
  'node:fs': __fs,
  'fs/promises': __fs.promises,
  'node:fs/promises': __fs.promises,
  path: __path,
  'node:path': __path,
  events: { EventEmitter: EventEmitter, default: EventEmitter },
  'node:events': { EventEmitter: EventEmitter },
  os: { platform: function(){return 'linux'}, homedir: function(){return '/home'}, tmpdir: function(){return '/tmp'}, EOL: '\\n', cpus: function(){return [{}]}, totalmem: function(){return 536870912}, freemem: function(){return 268435456}, hostname: function(){return 'clawwasm'} },
  'node:os': null,
  url: { URL: typeof URL !== 'undefined' ? URL : function(s){this.href=s}, parse: function(s){return {href:s}} },
  'node:url': null,
  util: { promisify: function(f){return function(){var a=Array.prototype.slice.call(arguments);return new Promise(function(r,j){a.push(function(e,v){if(e)j(e);else r(v)});f.apply(null,a)})}}, inspect: function(o){return JSON.stringify(o)}, format: function(){return Array.prototype.slice.call(arguments).join(' ')}, inherits: function(c,s){c.prototype=Object.create(s.prototype)}, deprecate: function(f){return f} },
  'node:util': null,
  stream: { Readable: EventEmitter, Writable: EventEmitter, Transform: EventEmitter, PassThrough: EventEmitter, pipeline: function(){var cb=arguments[arguments.length-1];cb(null)} },
  'node:stream': null,
  crypto: { randomBytes: function(n){return {toString:function(){return Math.random().toString(36).substring(2)}}}, createHash: function(){return{update:function(){return this},digest:function(){return ''}}}, randomUUID: function(){return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g,function(c){var r=Math.random()*16|0;return(c=='x'?r:r&0x3|0x8).toString(16)})} },
  'node:crypto': null,
  http: { createServer: function(h){return{listen:function(p,cb){if(typeof cb==='function')cb()},close:function(){},address:function(){return{port:0}}}}, request: function(){return{on:function(){return this},end:function(){}}}, STATUS_CODES: {200:'OK',404:'Not Found',500:'Error'} },
  'node:http': null,
  https: null,
  readline: { createInterface: function(o){var rl=new EventEmitter();rl.question=function(p,cb){process.stdout.write(p);cb('')};rl.close=function(){rl.emit('close')};rl.prompt=function(){};rl.setPrompt=function(){};return rl} },
  'node:readline': null,
  child_process: { exec: function(c,o,cb){if(typeof o==='function'){cb=o}if(cb)cb(new Error('Not supported'))} },
  'node:child_process': null,
  assert: function(v,m){if(!v)throw new Error(m||'Assertion failed')},
  'node:assert': null,
  querystring: { parse: function(s){var o={};s.split('&').forEach(function(p){var kv=p.split('=');if(kv[0])o[decodeURIComponent(kv[0])]=decodeURIComponent(kv[1]||'')});return o}, stringify: function(o){return Object.keys(o).map(function(k){return encodeURIComponent(k)+'='+encodeURIComponent(o[k])}).join('&')} },
  net: { createServer: function(){return new EventEmitter()}, Socket: EventEmitter },
  tls: { createServer: function(){return new EventEmitter()} },
  dns: { resolve: function(h,cb){cb(null,['127.0.0.1'])}, lookup: function(h,cb){cb(null,'127.0.0.1',4)} },
  zlib: { createGzip: function(){return new EventEmitter()}, gzipSync: function(b){return b} },
  string_decoder: { StringDecoder: function(){this.write=function(b){return String(b)};this.end=function(){return ''}} },
  timers: { setTimeout: setTimeout, setInterval: setInterval, clearTimeout: clearTimeout, clearInterval: clearInterval },
  'timers/promises': { setTimeout: function(ms){return new Promise(function(r){setTimeout(r,ms)})} },
  buffer: { Buffer: globalThis.Buffer },
  'node:buffer': { Buffer: globalThis.Buffer },
  module: { createRequire: function(){return function(){return {}}}, register: function(){} },
  'node:module': null,
  worker_threads: { isMainThread: true, parentPort: null },
  perf_hooks: { performance: { now: function(){return Date.now()} } },
};

// Fill node: aliases
for (var k in __modules) {
  if (k.startsWith('node:') && __modules[k] === null) {
    __modules[k] = __modules[k.replace('node:', '')] || {};
  }
}

// ── require() ──
var __require_cache = {};
globalThis.require = function(name) {
  if (__modules[name]) return __modules[name];
  throw new Error("Cannot find module '" + name + "'");
};
globalThis.require.resolve = function(name) { return name; };
globalThis.require.cache = __require_cache;

globalThis.module = { exports: {} };
globalThis.exports = globalThis.module.exports;
globalThis.global = globalThis;
globalThis.TextEncoder = typeof TextEncoder !== 'undefined' ? TextEncoder : function(){};
globalThis.TextDecoder = typeof TextDecoder !== 'undefined' ? TextDecoder : function(){};
globalThis.AbortController = typeof AbortController !== 'undefined' ? AbortController : function(){this.signal={};this.abort=function(){}};
globalThis.URL = typeof URL !== 'undefined' ? URL : function(s){this.href=s;this.toString=function(){return s}};
globalThis.URLSearchParams = typeof URLSearchParams !== 'undefined' ? URLSearchParams : function(){};
globalThis.queueMicrotask = function(fn) { Promise.resolve().then(fn); };
globalThis.setImmediate = function(fn) { setTimeout(fn, 0); };
globalThis.clearImmediate = clearTimeout;
`;
  }
}
