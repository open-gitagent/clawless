// ─── Polyfill Registry ──────────────────────────────────────────────────────
// Returns built-in module implementations wired to the sandbox's VirtualFS.

import type { VirtualFS } from '../vfs.js';
import { createFsModule } from './fs.js';
import * as pathModule from './path.js';
import { EventEmitter } from './events.js';
import { BufferPolyfill } from './buffer.js';
import { createProcessModule } from './process.js';
import { http, https } from './http.js';
import { os, url, querystring, util, crypto, stream, child_process, readline, assert, Readable, Writable, Transform, PassThrough } from './misc.js';

export interface PolyfillContext {
  vfs: VirtualFS;
  env: Record<string, string>;
  argv: string[];
  cwd: string;
  stdout: (data: string) => void;
  stderr: (data: string) => void;
  onExit?: (code: number) => void;
}

/** Build the map of built-in module names → module objects. */
export function createBuiltinModules(ctx: PolyfillContext): Record<string, any> {
  const fsModule = createFsModule(ctx.vfs);
  const processModule = createProcessModule({
    env: ctx.env,
    argv: ctx.argv,
    cwd: ctx.cwd,
    stdout: ctx.stdout,
    stderr: ctx.stderr,
    onExit: ctx.onExit,
  });

  return {
    fs: fsModule,
    'fs/promises': fsModule.promises,
    'node:fs': fsModule,
    'node:fs/promises': fsModule.promises,
    path: pathModule.default,
    'path/posix': pathModule.posix,
    'node:path': pathModule.default,
    events: { EventEmitter, default: EventEmitter },
    'node:events': { EventEmitter, default: EventEmitter },
    buffer: { Buffer: BufferPolyfill },
    'node:buffer': { Buffer: BufferPolyfill },
    process: processModule,
    'node:process': processModule,
    os,
    'node:os': os,
    url,
    'node:url': { ...url, URL: globalThis.URL, URLSearchParams: globalThis.URLSearchParams },
    querystring,
    'node:querystring': querystring,
    util,
    'node:util': util,
    crypto,
    'node:crypto': crypto,
    stream: { ...stream, Readable, Writable, Transform, PassThrough },
    'node:stream': { ...stream, Readable, Writable, Transform, PassThrough },
    http,
    'node:http': http,
    https,
    'node:https': https,
    child_process,
    'node:child_process': child_process,
    readline,
    'node:readline': readline,
    assert,
    'node:assert': assert,
    // Stubs for modules that are commonly imported but have no browser equivalent
    net: { createServer: () => new EventEmitter(), connect: () => new EventEmitter(), Socket: EventEmitter },
    'node:net': { createServer: () => new EventEmitter(), connect: () => new EventEmitter(), Socket: EventEmitter },
    tls: { createServer: () => new EventEmitter(), connect: () => new EventEmitter() },
    'node:tls': { createServer: () => new EventEmitter(), connect: () => new EventEmitter() },
    dns: { resolve: (_h: string, cb: Function) => cb(null, ['127.0.0.1']), lookup: (_h: string, cb: Function) => cb(null, '127.0.0.1', 4) },
    'node:dns': { resolve: (_h: string, cb: Function) => cb(null, ['127.0.0.1']), lookup: (_h: string, cb: Function) => cb(null, '127.0.0.1', 4) },
    zlib: { createGzip: () => new PassThrough(), createGunzip: () => new PassThrough(), createDeflate: () => new PassThrough(), createInflate: () => new PassThrough(), gzipSync: (b: any) => b, gunzipSync: (b: any) => b },
    'node:zlib': { createGzip: () => new PassThrough(), createGunzip: () => new PassThrough() },
    string_decoder: { StringDecoder: class { write(buf: any) { return new TextDecoder().decode(buf); } end() { return ''; } } },
    'node:string_decoder': { StringDecoder: class { write(buf: any) { return new TextDecoder().decode(buf); } end() { return ''; } } },
    timers: { setTimeout, setInterval, setImmediate: (fn: Function) => setTimeout(fn, 0), clearTimeout, clearInterval, clearImmediate: clearTimeout },
    'node:timers': { setTimeout, setInterval, setImmediate: (fn: Function) => setTimeout(fn, 0) },
    'timers/promises': { setTimeout: (ms: number) => new Promise(r => setTimeout(r, ms)) },
    module: { createRequire: () => () => ({}) },
    'node:module': { createRequire: () => () => ({}), register: () => {} },
    worker_threads: { isMainThread: true, parentPort: null, Worker: class {} },
    'node:worker_threads': { isMainThread: true, parentPort: null },
    perf_hooks: { performance: globalThis.performance },
    'node:perf_hooks': { performance: globalThis.performance },
    constants: {},
    _process: processModule,
    _buffer: { Buffer: BufferPolyfill },
  };
}
