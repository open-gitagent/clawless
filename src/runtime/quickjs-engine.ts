// ─── QuickJS Engine: JavaScript Execution via WASM ──────────────────────────
// Runs JS code inside QuickJS-WASM with Node.js API shims wired to ClawKernel
// subsystems (ClawFS for fs, ClawNet for fetch, etc.)

import { getQuickJS } from 'quickjs-emscripten';
import type { QuickJSWASMModule, QuickJSContext } from 'quickjs-emscripten';
import type { ClawFS } from './clawfs.js';

export interface QuickJSEngineOptions {
  fs: ClawFS;
  net: { proxyFetch: (req: any) => Promise<any> };
  env: Record<string, string>;
  args: string[];
  cwd: string;
  stdout: (data: string) => void;
  stderr: (data: string) => void;
  stdin?: () => Promise<string>;
}

let moduleCache: QuickJSWASMModule | null = null;

async function getModule(): Promise<QuickJSWASMModule> {
  if (!moduleCache) {
    moduleCache = await getQuickJS();
  }
  return moduleCache;
}

export class QuickJSEngine {
  private ctx: QuickJSContext | null = null;
  private opts: QuickJSEngineOptions;
  private exitCode = 0;

  constructor(opts: QuickJSEngineOptions) {
    this.opts = opts;
  }

  /** Initialize the QuickJS context with Node.js API shims. */
  async init(): Promise<void> {
    const mod = await getModule();
    this.ctx = mod.newContext();
    this.installConsole();
    this.installProcess();
    this.installFS();
    this.installFetch();
    this.installTimers();
    this.installBuffer();
    this.installRequire();
    this.installGlobals();
  }

  /** Evaluate code and dispose the result handle (for setup scripts). */
  private evalSetup(code: string): void {
    if (!this.ctx) return;
    const result = this.ctx.evalCode(code, '<setup>');
    if (result.error) {
      const err = this.ctx.dump(result.error);
      result.error.dispose();
      console.warn('[QuickJS setup error]', err);
    } else {
      result.value.dispose();
    }
  }

  /** Run JavaScript code and return exit code. */
  async run(code: string, filename = 'index.js'): Promise<number> {
    if (!this.ctx) throw new Error('Engine not initialized');

    const result = this.ctx.evalCode(code, filename);
    if (result.error) {
      const err = this.ctx.dump(result.error);
      result.error.dispose();
      this.opts.stderr(`${err?.message || err}\n${err?.stack || ''}\n`);
      return 1;
    }
    result.value.dispose();
    return this.exitCode;
  }

  /** Clean up the context. */
  dispose(): void {
    this.ctx?.dispose();
    this.ctx = null;
  }

  // ─── Node.js API Shims ──────────────────────────────────────────────────

  private installConsole(): void {
    const ctx = this.ctx!;
    const console = ctx.newObject();

    const methods = ['log', 'info', 'debug', 'warn', 'error'] as const;
    for (const method of methods) {
      const fn = ctx.newFunction(method, (...args) => {
        const parts = args.map(a => {
          const val = ctx.dump(a);
          return typeof val === 'string' ? val : JSON.stringify(val);
        });
        const output = parts.join(' ') + '\n';
        if (method === 'error' || method === 'warn') {
          this.opts.stderr(output);
        } else {
          this.opts.stdout(output);
        }
      });
      ctx.setProp(console, method, fn);
      fn.dispose();
    }

    ctx.setProp(ctx.global, 'console', console);
    console.dispose();
  }

  private installProcess(): void {
    const ctx = this.ctx!;
    const process = ctx.newObject();

    // process.env
    const env = ctx.newObject();
    for (const [k, v] of Object.entries(this.opts.env)) {
      const val = ctx.newString(v);
      ctx.setProp(env, k, val);
      val.dispose();
    }
    ctx.setProp(process, 'env', env);
    env.dispose();

    // process.argv
    const argv = ctx.newObject();
    const argv0 = ctx.newString('node');
    ctx.setProp(argv, '0', argv0);
    argv0.dispose();
    for (let i = 0; i < this.opts.args.length; i++) {
      const val = ctx.newString(this.opts.args[i]);
      ctx.setProp(argv, String(i + 1), val);
      val.dispose();
    }
    const lenVal = ctx.newNumber(this.opts.args.length + 1);
    ctx.setProp(argv, 'length', lenVal);
    lenVal.dispose();
    ctx.setProp(process, 'argv', argv);
    argv.dispose();

    // process.cwd()
    const cwdFn = ctx.newFunction('cwd', () => {
      return ctx.newString(this.opts.cwd);
    });
    ctx.setProp(process, 'cwd', cwdFn);
    cwdFn.dispose();

    // process.exit()
    const exitFn = ctx.newFunction('exit', (...args) => {
      this.exitCode = args[0] ? ctx.dump(args[0]) : 0;
    });
    ctx.setProp(process, 'exit', exitFn);
    exitFn.dispose();

    // process.stdout.write
    const stdout = ctx.newObject();
    const stdoutWrite = ctx.newFunction('write', (dataHandle) => {
      const data = ctx.getString(dataHandle);
      this.opts.stdout(data);
    });
    ctx.setProp(stdout, 'write', stdoutWrite);
    stdoutWrite.dispose();
    ctx.setProp(process, 'stdout', stdout);
    stdout.dispose();

    // process.stderr.write
    const stderr = ctx.newObject();
    const stderrWrite = ctx.newFunction('write', (dataHandle) => {
      const data = ctx.getString(dataHandle);
      this.opts.stderr(data);
    });
    ctx.setProp(stderr, 'write', stderrWrite);
    stderrWrite.dispose();
    ctx.setProp(process, 'stderr', stderr);
    stderr.dispose();

    // process.platform, process.version
    const platform = ctx.newString('clawkernel');
    ctx.setProp(process, 'platform', platform);
    platform.dispose();

    const version = ctx.newString('v20.0.0');
    ctx.setProp(process, 'version', version);
    version.dispose();

    ctx.setProp(ctx.global, 'process', process);
    process.dispose();
  }

  private installFS(): void {
    const ctx = this.ctx!;
    const fs = this.opts.fs;

    // We install __clawfs_* host functions, then wrap them in a `require('fs')` shim
    const readFileSync = ctx.newFunction('__clawfs_readFileSync', (...args) => {
      const pathHandle = args[0];
      const encodingHandle = args[1];
      const path = ctx.getString(pathHandle);
      const encoding = encodingHandle ? ctx.dump(encodingHandle) : undefined;
      // Synchronous read from the in-memory fs (it's all sync under the hood)
      try {
        // Access the ClawFS internals synchronously
        const node = (fs as any).inodes?.get(path.startsWith('/') ? path : `/${path}`);
        if (!node || node.type !== 'file') {
          throw new Error(`ENOENT: no such file: ${path}`);
        }
        if (encoding === 'utf-8' || encoding === 'utf8') {
          return ctx.newString(new TextDecoder().decode(node.content));
        }
        return ctx.newString(new TextDecoder().decode(node.content));
      } catch (e) {
        throw e;
      }
    });
    ctx.setProp(ctx.global, '__clawfs_readFileSync', readFileSync);
    readFileSync.dispose();

    const writeFileSync = ctx.newFunction('__clawfs_writeFileSync', (...args) => {
      const path = ctx.getString(args[0]);
      const content = ctx.getString(args[1]);
      try {
        const encoder = new TextEncoder();
        const normPath = path.startsWith('/') ? path : `/${path}`;
        const bytes = encoder.encode(content);
        // Direct sync write to ClawFS inodes
        const inodes = (fs as any).inodes as Map<string, any>;
        const parentParts = normPath.split('/').filter(Boolean);
        parentParts.pop();
        // Ensure parent exists
        let cur = '';
        for (const p of parentParts) {
          cur += '/' + p;
          if (!inodes.has(cur)) {
            inodes.set(cur, { type: 'directory', content: new Uint8Array(0), children: new Set(), mtime: Date.now() });
          }
        }
        const existing = inodes.get(normPath);
        if (existing) {
          existing.content = bytes;
          existing.mtime = Date.now();
        } else {
          inodes.set(normPath, { type: 'file', content: bytes, children: new Set(), mtime: Date.now() });
          const parentPath = '/' + parentParts.join('/') || '/';
          const parent = inodes.get(parentPath);
          if (parent) parent.children.add(normPath.split('/').pop());
        }
      } catch (e) {
        throw e;
      }
    });
    ctx.setProp(ctx.global, '__clawfs_writeFileSync', writeFileSync);
    writeFileSync.dispose();

    const existsSync = ctx.newFunction('__clawfs_existsSync', (...args) => {
      const path = ctx.getString(args[0]);
      const normPath = path.startsWith('/') ? path : `/${path}`;
      const inodes = (fs as any).inodes as Map<string, any>;
      return inodes.has(normPath) ? ctx.true : ctx.false;
    });
    ctx.setProp(ctx.global, '__clawfs_existsSync', existsSync);
    existsSync.dispose();

    const mkdirSync = ctx.newFunction('__clawfs_mkdirSync', (...args) => {
      const path = ctx.getString(args[0]);
      const normPath = path.startsWith('/') ? path : `/${path}`;
      const inodes = (fs as any).inodes as Map<string, any>;
      if (!inodes.has(normPath)) {
        const parts = normPath.split('/').filter(Boolean);
        let cur = '';
        for (const p of parts) {
          cur += '/' + p;
          if (!inodes.has(cur)) {
            inodes.set(cur, { type: 'directory', content: new Uint8Array(0), children: new Set(), mtime: Date.now() });
            const parentPath = cur.split('/').slice(0, -1).join('/') || '/';
            const parent = inodes.get(parentPath);
            if (parent) parent.children.add(p);
          }
        }
      }
    });
    ctx.setProp(ctx.global, '__clawfs_mkdirSync', mkdirSync);
    mkdirSync.dispose();

    const readdirSync = ctx.newFunction('__clawfs_readdirSync', (...args) => {
      const path = ctx.getString(args[0]);
      const normPath = path.startsWith('/') ? path : `/${path}`;
      const inodes = (fs as any).inodes as Map<string, any>;
      const node = inodes.get(normPath);
      if (!node || node.type !== 'directory') {
        throw new Error(`ENOENT: no such directory: ${path}`);
      }
      const arr = ctx.newArray();
      let i = 0;
      for (const child of node.children) {
        const val = ctx.newString(child);
        ctx.setProp(arr, i, val);
        val.dispose();
        i++;
      }
      return arr;
    });
    ctx.setProp(ctx.global, '__clawfs_readdirSync', readdirSync);
    readdirSync.dispose();
  }

  private installFetch(): void {
    const ctx = this.ctx!;

    const fetchSync = ctx.newFunction('__clawnet_fetchSync', (...args) => {
      const url = ctx.getString(args[0]);

      // We can't truly do async in sync QuickJS, so we return a
      // serialized result. The JS-side shim will parse it.
      // For now, log the attempt and return an error indicating async needed.
      this.opts.stderr(`[ClawKernel] fetch() called: ${url} (sync mode — limited)\n`);

      const result = ctx.newObject();
      const status = ctx.newNumber(0);
      const body = ctx.newString('{"error":"fetch() requires async runtime. Use ClawKernel async mode."}');
      ctx.setProp(result, 'status', status);
      ctx.setProp(result, 'body', body);
      status.dispose();
      body.dispose();
      return result;
    });
    ctx.setProp(ctx.global, '__clawnet_fetchSync', fetchSync);
    fetchSync.dispose();
  }

  private installTimers(): void {
    const ctx = this.ctx!;

    // setTimeout — immediate execution in sync mode (no real delay)
    const setTimeout = ctx.newFunction('setTimeout', (...args) => {
      if (args[0]) {
        ctx.callFunction(args[0], ctx.global);
      }
      return ctx.newNumber(0);
    });
    ctx.setProp(ctx.global, 'setTimeout', setTimeout);
    setTimeout.dispose();

    const clearTimeout = ctx.newFunction('clearTimeout', () => {});
    ctx.setProp(ctx.global, 'clearTimeout', clearTimeout);
    clearTimeout.dispose();

    const setInterval = ctx.newFunction('setInterval', () => ctx.newNumber(0));
    ctx.setProp(ctx.global, 'setInterval', setInterval);
    setInterval.dispose();

    const clearInterval = ctx.newFunction('clearInterval', () => {});
    ctx.setProp(ctx.global, 'clearInterval', clearInterval);
    clearInterval.dispose();
  }

  private installBuffer(): void {
    // Minimal Buffer.from() shim
    this.evalSetup(`
      globalThis.Buffer = {
        from: function(data, encoding) {
          if (typeof data === 'string') {
            return { toString: () => data, length: data.length };
          }
          return { toString: () => '', length: 0 };
        },
        alloc: function(size) {
          return { toString: () => '', length: size, fill: () => {} };
        },
        isBuffer: function(obj) { return false; },
      };
    `);
  }

  private installRequire(): void {
    // require() shim that returns built-in module stubs
    this.evalSetup(`
      globalThis.__modules = {};

      globalThis.__modules['fs'] = {
        readFileSync: function(path, opts) {
          var enc = (typeof opts === 'string') ? opts : (opts && opts.encoding) || undefined;
          return __clawfs_readFileSync(path, enc);
        },
        writeFileSync: function(path, content) {
          return __clawfs_writeFileSync(path, typeof content === 'string' ? content : String(content));
        },
        existsSync: function(path) {
          return __clawfs_existsSync(path);
        },
        mkdirSync: function(path, opts) {
          return __clawfs_mkdirSync(path);
        },
        readdirSync: function(path) {
          return __clawfs_readdirSync(path);
        },
        readdir: function(path, opts, cb) {
          if (typeof opts === 'function') { cb = opts; }
          try { var result = __clawfs_readdirSync(path); cb(null, result); }
          catch(e) { cb(e); }
        },
        readFile: function(path, opts, cb) {
          if (typeof opts === 'function') { cb = opts; opts = undefined; }
          try {
            var enc = (typeof opts === 'string') ? opts : (opts && opts.encoding) || undefined;
            var result = __clawfs_readFileSync(path, enc);
            cb(null, result);
          } catch(e) { cb(e); }
        },
        writeFile: function(path, content, opts, cb) {
          if (typeof opts === 'function') { cb = opts; }
          try { __clawfs_writeFileSync(path, String(content)); if(cb) cb(null); }
          catch(e) { if(cb) cb(e); }
        },
        chmodSync: function() {},
        unlinkSync: function() {},
        symlinkSync: function() {},
        statSync: function(path) {
          var exists = __clawfs_existsSync(path);
          if (!exists) throw new Error('ENOENT: ' + path);
          return { isFile: function(){ return true; }, isDirectory: function(){ return false; }, size: 0 };
        },
      };

      globalThis.__modules['path'] = {
        join: function() {
          var parts = [];
          for (var i = 0; i < arguments.length; i++) parts.push(arguments[i]);
          return parts.join('/').replace(/\\/\\/+/g, '/');
        },
        resolve: function() {
          var parts = [];
          for (var i = 0; i < arguments.length; i++) parts.push(arguments[i]);
          return parts.join('/').replace(/\\/\\/+/g, '/');
        },
        dirname: function(p) { var i = p.lastIndexOf('/'); return i <= 0 ? '/' : p.substring(0, i); },
        basename: function(p) { var i = p.lastIndexOf('/'); return p.substring(i + 1); },
        extname: function(p) { var i = p.lastIndexOf('.'); return i === -1 ? '' : p.substring(i); },
        sep: '/',
        posix: { sep: '/' },
      };

      globalThis.__modules['os'] = {
        platform: function() { return 'clawkernel'; },
        homedir: function() { return '/home'; },
        tmpdir: function() { return '/tmp'; },
        EOL: '\\n',
        cpus: function() { return [{ model: 'ClawKernel WASM', speed: 1000 }]; },
        totalmem: function() { return 536870912; },
        freemem: function() { return 268435456; },
      };

      globalThis.__modules['events'] = {
        EventEmitter: function() {
          this._events = {};
          this.on = function(name, fn) {
            if (!this._events[name]) this._events[name] = [];
            this._events[name].push(fn);
            return this;
          };
          this.emit = function(name) {
            var args = Array.prototype.slice.call(arguments, 1);
            var fns = this._events[name] || [];
            for (var i = 0; i < fns.length; i++) fns[i].apply(this, args);
            return fns.length > 0;
          };
          this.removeListener = function(name, fn) {
            var fns = this._events[name] || [];
            this._events[name] = fns.filter(function(f) { return f !== fn; });
            return this;
          };
          this.once = function(name, fn) {
            var self = this;
            function wrapper() { fn.apply(this, arguments); self.removeListener(name, wrapper); }
            this.on(name, wrapper);
            return this;
          };
          this.removeAllListeners = function(name) {
            if (name) delete this._events[name];
            else this._events = {};
            return this;
          };
        },
      };

      globalThis.__modules['util'] = {
        inherits: function(ctor, superCtor) { ctor.prototype = Object.create(superCtor.prototype); },
        inspect: function(obj) { return JSON.stringify(obj); },
        promisify: function(fn) { return function() { var args = Array.prototype.slice.call(arguments); return new Promise(function(resolve, reject) { args.push(function(err, result) { if(err) reject(err); else resolve(result); }); fn.apply(null, args); }); }; },
        format: function() { return Array.prototype.slice.call(arguments).join(' '); },
      };

      globalThis.__modules['stream'] = {
        Readable: globalThis.__modules['events'].EventEmitter,
        Writable: globalThis.__modules['events'].EventEmitter,
        Transform: globalThis.__modules['events'].EventEmitter,
        PassThrough: globalThis.__modules['events'].EventEmitter,
      };

      globalThis.__modules['readline'] = {
        createInterface: function(opts) {
          var rl = new (globalThis.__modules['events'].EventEmitter)();
          rl.question = function(prompt, cb) {
            process.stdout.write(prompt);
            cb('');
          };
          rl.close = function() { rl.emit('close'); };
          rl.prompt = function() { process.stdout.write('> '); };
          rl.setPrompt = function() {};
          return rl;
        },
      };

      globalThis.__modules['url'] = {
        URL: typeof URL !== 'undefined' ? URL : function(s) { this.href = s; this.toString = function(){ return s; }; },
        parse: function(s) { return { href: s, hostname: '', pathname: s, protocol: 'https:' }; },
      };

      globalThis.__modules['http'] = { request: function() { return { on: function(){return this;}, end: function(){} }; } };
      globalThis.__modules['https'] = globalThis.__modules['http'];
      globalThis.__modules['child_process'] = { exec: function(cmd, cb) { if(cb) cb(new Error('Not supported in ClawKernel')); } };
      globalThis.__modules['crypto'] = { randomBytes: function(n) { return { toString: function(e) { return Math.random().toString(36).substring(2); } }; }, createHash: function() { return { update: function() { return this; }, digest: function() { return ''; } }; } };

      globalThis.require = function(name) {
        if (globalThis.__modules[name]) return globalThis.__modules[name];
        throw new Error('Cannot find module \\'' + name + '\\' — not available in ClawKernel');
      };

      globalThis.module = { exports: {} };
      globalThis.exports = globalThis.module.exports;
    `);
  }

  private installGlobals(): void {
    // TextEncoder / TextDecoder stubs
    this.evalSetup(`
      if (typeof globalThis.TextEncoder === 'undefined') {
        globalThis.TextEncoder = function() {};
        globalThis.TextEncoder.prototype.encode = function(s) { return s; };
      }
      if (typeof globalThis.TextDecoder === 'undefined') {
        globalThis.TextDecoder = function() {};
        globalThis.TextDecoder.prototype.decode = function(b) { return String(b); };
      }
    `);
  }
}
