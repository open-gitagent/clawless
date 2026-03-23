// ─── WebContainer Runtime Adapter ────────────────────────────────────────────
// Wraps @webcontainer/api behind the ContainerRuntime interface.
// This is a mechanical adapter — no behavior changes from the original code.

import { WebContainer, type WebContainerProcess } from '@webcontainer/api';
import type {
  ContainerRuntime,
  RuntimeFS,
  RuntimeProcess,
  SpawnOptions,
  MountTree,
  DirEntry,
} from './types.js';

/** Adapt a WebContainerProcess to RuntimeProcess. */
function adaptProcess(proc: WebContainerProcess): RuntimeProcess {
  return {
    output: proc.output,
    input: proc.input,
    exit: proc.exit,
    resize: proc.resize ? (dims) => proc.resize(dims) : undefined,
  };
}

/** Adapt WebContainer fs to RuntimeFS. */
function adaptFS(wc: WebContainer): RuntimeFS {
  return {
    readFile(path: string, encoding?: 'utf-8'): Promise<any> {
      if (encoding === 'utf-8') return wc.fs.readFile(path, 'utf-8');
      return wc.fs.readFile(path);
    },
    writeFile(path: string, content: string | Uint8Array): Promise<void> {
      return wc.fs.writeFile(path, content as any);
    },
    mkdir(path: string, opts?: { recursive?: boolean }): Promise<void> {
      return wc.fs.mkdir(path, opts as any);
    },
    rm(path: string, opts?: { recursive?: boolean }): Promise<void> {
      return wc.fs.rm(path, opts);
    },
    async readdir(path: string, opts: { withFileTypes: true }): Promise<DirEntry[]> {
      const entries = await wc.fs.readdir(path, opts);
      return entries.map((e: any) => ({
        name: e.name,
        isDirectory: () => e.isDirectory(),
      }));
    },
    watch(
      path: string,
      opts: { recursive?: boolean },
      cb: (event: string, filename: string | null) => void,
    ): void {
      wc.fs.watch(path, opts, cb as any);
    },
  };
}

export class WebContainerRuntime implements ContainerRuntime {
  private wc: WebContainer | null = null;
  private _fs: RuntimeFS | null = null;

  get fs(): RuntimeFS {
    if (!this._fs) throw new Error('Runtime not booted');
    return this._fs;
  }

  async boot(): Promise<void> {
    this.wc = await WebContainer.boot();
    this._fs = adaptFS(this.wc);
  }

  async mount(tree: MountTree): Promise<void> {
    if (!this.wc) throw new Error('Runtime not booted');
    await this.wc.mount(tree as any);
  }

  async spawn(cmd: string, args: string[], opts?: SpawnOptions): Promise<RuntimeProcess> {
    if (!this.wc) throw new Error('Runtime not booted');
    const proc = await this.wc.spawn(cmd, args, opts);
    return adaptProcess(proc);
  }

  on(_event: 'server-ready', cb: (port: number, url: string) => void): void {
    if (!this.wc) throw new Error('Runtime not booted');
    this.wc.on('server-ready', cb);
  }

  async teardown(): Promise<void> {
    this.wc?.teardown();
    this.wc = null;
    this._fs = null;
  }

  /** Expose the raw WebContainer for SDK's `container` getter. */
  getWebContainer(): WebContainer | null {
    return this.wc;
  }
}
