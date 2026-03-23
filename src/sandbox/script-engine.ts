// ─── ScriptEngine: JavaScript Execution with require() ──────────────────────
// Executes JS with full CJS require() support, module caching, and built-in routing.

import type { VirtualFS } from './vfs.js';
import { createBuiltinModules, type PolyfillContext } from './polyfills/index.js';
import { BufferPolyfill } from './polyfills/buffer.js';
import * as pathModule from './polyfills/path.js';

export interface ScriptContext {
  vfs: VirtualFS;
  env: Record<string, string>;
  argv: string[];
  cwd: string;
  stdout: (data: string) => void;
  stderr: (data: string) => void;
  onExit?: (code: number) => void;
}

export class ScriptEngine {
  private vfs: VirtualFS;
  private builtins: Record<string, any>;
  private moduleCache = new Map<string, any>();
  private ctx: ScriptContext;
  private processModule: any;

  constructor(ctx: ScriptContext) {
    this.ctx = ctx;
    this.vfs = ctx.vfs;

    const polyfillCtx: PolyfillContext = {
      vfs: ctx.vfs,
      env: ctx.env,
      argv: ctx.argv,
      cwd: ctx.cwd,
      stdout: ctx.stdout,
      stderr: ctx.stderr,
      onExit: ctx.onExit,
    };

    this.builtins = createBuiltinModules(polyfillCtx);
    this.processModule = this.builtins['process'];
  }

  /** Execute a script file from the VFS. */
  run(filePath: string): any {
    const absPath = pathModule.isAbsolute(filePath)
      ? filePath
      : pathModule.resolve(this.ctx.cwd, filePath);

    return this.requireModule(absPath);
  }

  /** Execute inline code. */
  eval(code: string, filename = '<eval>'): any {
    return this.executeModule(code, filename, pathModule.dirname(filename));
  }

  /** The require() function — resolves and executes modules. */
  private requireModule(requestPath: string): any {
    // Check built-in modules first
    if (this.builtins[requestPath]) return this.builtins[requestPath];

    // Resolve the full path
    const resolved = this.resolveModule(requestPath);
    if (!resolved) throw new Error(`Cannot find module '${requestPath}'`);

    // Check cache
    if (this.moduleCache.has(resolved)) return this.moduleCache.get(resolved);

    // Read and execute
    let content: string;
    try {
      content = this.vfs.readFileSync(resolved, 'utf-8') as string;
    } catch {
      throw new Error(`Cannot find module '${requestPath}' (resolved: ${resolved})`);
    }

    // JSON files
    if (resolved.endsWith('.json')) {
      const json = JSON.parse(content);
      this.moduleCache.set(resolved, json);
      return json;
    }

    return this.executeModule(content, resolved, pathModule.dirname(resolved));
  }

  /** Resolve a module specifier to an absolute VFS path. */
  private resolveModule(spec: string): string | null {
    // Built-in
    if (this.builtins[spec]) return spec;

    // Relative path
    if (spec.startsWith('./') || spec.startsWith('../') || spec.startsWith('/')) {
      const base = spec.startsWith('/') ? spec : pathModule.resolve(this.ctx.cwd, spec);
      return this.resolveFile(base);
    }

    // node_modules lookup
    return this.resolveNodeModule(spec);
  }

  /** Try file extensions and index.js. */
  private resolveFile(base: string): string | null {
    const candidates = [
      base,
      base + '.js',
      base + '.mjs',
      base + '.cjs',
      base + '.json',
      base + '/index.js',
      base + '/index.mjs',
      base + '/index.json',
    ];

    for (const c of candidates) {
      if (this.vfs.existsSync(c)) {
        try {
          const stat = this.vfs.statSync(c);
          if (stat.isFile()) return c;
        } catch { /* */ }
      }
    }

    // Check package.json main field
    const pkgPath = base + '/package.json';
    if (this.vfs.existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(this.vfs.readFileSync(pkgPath, 'utf-8') as string);
        const main = pkg.main || pkg.module || 'index.js';
        return this.resolveFile(pathModule.resolve(base, main));
      } catch { /* */ }
    }

    return null;
  }

  /** Walk up directories looking for node_modules/{spec}. */
  private resolveNodeModule(spec: string): string | null {
    // Split scoped packages: @scope/pkg → [@scope/pkg]
    // Split deep imports: express/lib/router → [express, lib/router]
    let pkgName: string;
    let subpath = '';

    if (spec.startsWith('@')) {
      const parts = spec.split('/');
      pkgName = parts.slice(0, 2).join('/');
      subpath = parts.slice(2).join('/');
    } else {
      const parts = spec.split('/');
      pkgName = parts[0];
      subpath = parts.slice(1).join('/');
    }

    // Look in /node_modules
    const candidates = [
      `/node_modules/${pkgName}`,
      `${this.ctx.cwd}/node_modules/${pkgName}`,
    ];

    for (const base of candidates) {
      if (this.vfs.existsSync(base)) {
        if (subpath) {
          const resolved = this.resolveFile(`${base}/${subpath}`);
          if (resolved) return resolved;
        }
        const resolved = this.resolveFile(base);
        if (resolved) return resolved;
      }
    }

    return null;
  }

  /** Execute JS source as a CJS module. */
  private executeModule(source: string, filename: string, dirname: string): any {
    const module = { exports: {} as any, id: filename, filename, loaded: false, children: [] as any[], paths: [] as string[] };
    const exports = module.exports;

    // Pre-set cache to handle circular deps
    this.moduleCache.set(filename, exports);

    // Build require function scoped to this module
    const require = (spec: string): any => {
      // Built-in first
      if (this.builtins[spec]) return this.builtins[spec];
      // Relative to this module's directory
      if (spec.startsWith('./') || spec.startsWith('../')) {
        return this.requireModule(pathModule.resolve(dirname, spec));
      }
      return this.requireModule(spec);
    };
    require.resolve = (spec: string) => this.resolveModule(spec) || spec;
    require.cache = Object.fromEntries(this.moduleCache);
    require.main = module;

    // Create console bound to stdout/stderr
    const console = {
      log: (...args: any[]) => this.ctx.stdout(args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ') + '\n'),
      info: (...args: any[]) => this.ctx.stdout(args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ') + '\n'),
      debug: (...args: any[]) => this.ctx.stdout(args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ') + '\n'),
      warn: (...args: any[]) => this.ctx.stderr(args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ') + '\n'),
      error: (...args: any[]) => this.ctx.stderr(args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ') + '\n'),
      trace: (...args: any[]) => this.ctx.stderr('Trace: ' + args.join(' ') + '\n'),
      table: (data: any) => this.ctx.stdout(JSON.stringify(data, null, 2) + '\n'),
      dir: (obj: any) => this.ctx.stdout(JSON.stringify(obj, null, 2) + '\n'),
      time: () => {},
      timeEnd: () => {},
      timeLog: () => {},
      assert: (cond: boolean, ...args: any[]) => { if (!cond) this.ctx.stderr('Assertion failed: ' + args.join(' ') + '\n'); },
      clear: () => {},
      count: () => {},
      countReset: () => {},
      group: () => {},
      groupEnd: () => {},
    };

    try {
      // Wrap in a function to provide module scope
      const wrappedSource = `(function(exports, require, module, __filename, __dirname, process, console, Buffer, global, globalThis, setTimeout, setInterval, clearTimeout, clearInterval, setImmediate, queueMicrotask, URL, URLSearchParams, TextEncoder, TextDecoder, fetch, AbortController) {\n${source}\n})`;

      const fn = (0, eval)(wrappedSource);
      fn(
        exports,
        require,
        module,
        filename,
        dirname,
        this.processModule,
        console,
        BufferPolyfill,
        globalThis,
        globalThis,
        globalThis.setTimeout,
        globalThis.setInterval,
        globalThis.clearTimeout,
        globalThis.clearInterval,
        (fn: Function) => globalThis.setTimeout(fn, 0),
        globalThis.queueMicrotask,
        globalThis.URL,
        globalThis.URLSearchParams,
        globalThis.TextEncoder,
        globalThis.TextDecoder,
        globalThis.fetch,
        globalThis.AbortController,
      );

      module.loaded = true;
    } catch (e) {
      const err = e as Error;
      // Rethrow exit signal
      if (err.message?.startsWith('__SANDBOX_EXIT__:')) throw e;
      // Add filename context
      if (!err.message?.includes(filename)) {
        err.message = `${err.message} (in ${filename})`;
      }
      throw e;
    }

    // Update cache with final exports
    this.moduleCache.set(filename, module.exports);
    return module.exports;
  }
}
