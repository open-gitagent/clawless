// ─── process polyfill ───────────────────────────────────────────────────────

import { EventEmitter } from './events.js';

export function createProcessModule(opts: {
  env: Record<string, string>;
  argv: string[];
  cwd: string;
  stdout: (data: string) => void;
  stderr: (data: string) => void;
  onExit?: (code: number) => void;
}) {
  const proc = Object.assign(new EventEmitter(), {
    env: { ...opts.env },
    argv: ['node', ...opts.argv],
    argv0: 'node',
    execPath: '/usr/local/bin/node',
    execArgv: [] as string[],
    version: 'v20.0.0',
    versions: { node: '20.0.0', v8: '0.0.0', modules: '115' },
    platform: 'linux' as string,
    arch: 'x64' as string,
    pid: 1,
    ppid: 0,
    title: 'node',
    release: { name: 'node' },
    _cwd: opts.cwd,

    cwd: () => proc._cwd,
    chdir: (dir: string) => { proc._cwd = dir; },

    exit: (code?: number) => {
      opts.onExit?.(code ?? 0);
      throw new Error(`__SANDBOX_EXIT__:${code ?? 0}`);
    },

    stdout: {
      write: (data: any) => { opts.stdout(String(data)); return true; },
      isTTY: true,
      columns: 80,
      rows: 24,
      on: () => {},
      once: () => {},
      emit: () => false,
    },

    stderr: {
      write: (data: any) => { opts.stderr(String(data)); return true; },
      isTTY: true,
      on: () => {},
      once: () => {},
      emit: () => false,
    },

    stdin: {
      isTTY: true,
      readable: true,
      on: () => {},
      once: () => {},
      emit: () => false,
      read: () => null,
      resume: () => {},
      pause: () => {},
      setEncoding: () => {},
    },

    hrtime: Object.assign(
      (prev?: [number, number]): [number, number] => {
        const now = performance.now();
        const sec = Math.floor(now / 1000);
        const nsec = Math.floor((now % 1000) * 1e6);
        if (prev) return [sec - prev[0], nsec - prev[1]];
        return [sec, nsec];
      },
      { bigint: () => BigInt(Math.floor(performance.now() * 1e6)) },
    ),

    memoryUsage: () => ({
      rss: 50 * 1024 * 1024,
      heapTotal: 30 * 1024 * 1024,
      heapUsed: 20 * 1024 * 1024,
      external: 0,
      arrayBuffers: 0,
    }),

    uptime: () => performance.now() / 1000,

    nextTick: (fn: Function, ...args: any[]) => {
      queueMicrotask(() => fn(...args));
    },

    umask: (_mask?: number) => 0o022,

    cpuUsage: () => ({ user: 0, system: 0 }),

    kill: () => {},
    abort: () => { throw new Error('process.abort()'); },

    config: { variables: {} },
    features: { inspector: false, debug: false, uv: false, tls: true },
  });

  return proc;
}
