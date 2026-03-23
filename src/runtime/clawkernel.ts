// ─── ClawKernel: Custom WASM Runtime ────────────────────────────────────────
// Assembled kernel: ClawFS + ClawProc + ClawNet + ClawPkg
// Drop-in replacement for WebContainerRuntime via ContainerRuntime interface.

import type { ContainerRuntime, RuntimeFS, RuntimeProcess, SpawnOptions, MountTree } from './types.js';
import { ClawFS } from './clawfs.js';
import { ClawProc } from './clawproc.js';
import { ClawNet } from './clawnet.js';
import { ClawPkg } from './clawpkg.js';

export class ClawKernelRuntime implements ContainerRuntime {
  private _fs: ClawFS;
  private _proc: ClawProc;
  private _net: ClawNet;
  private _pkg: ClawPkg;
  private _serverListeners: Array<(port: number, url: string) => void> = [];
  private _booted = false;

  constructor() {
    this._fs = new ClawFS();
    this._net = new ClawNet();
    this._proc = new ClawProc(this._fs, this._net);
    this._pkg = new ClawPkg(this._fs);
  }

  get fs(): RuntimeFS {
    if (!this._booted) throw new Error('Runtime not booted');
    return this._fs;
  }

  /** Access the package manager. */
  get pkg(): ClawPkg {
    return this._pkg;
  }

  /** Access the network layer (for audit wiring). */
  get net(): ClawNet {
    return this._net;
  }

  async boot(): Promise<void> {
    // Create default directory structure
    await this._fs.mkdir('/home', { recursive: true });
    await this._fs.mkdir('/tmp', { recursive: true });
    await this._fs.mkdir('/workspace', { recursive: true });
    await this._fs.mkdir('/node_modules/.bin', { recursive: true });

    this._booted = true;
  }

  async mount(tree: MountTree): Promise<void> {
    if (!this._booted) throw new Error('Runtime not booted');
    await this._fs.mountTree(tree as Record<string, any>);
  }

  async spawn(cmd: string, args: string[], opts?: SpawnOptions): Promise<RuntimeProcess> {
    if (!this._booted) throw new Error('Runtime not booted');

    // Merge default env
    const env = {
      HOME: '/home',
      PATH: '/node_modules/.bin:/usr/local/bin:/usr/bin:/bin',
      ...opts?.env,
    };

    return this._proc.spawn(cmd, args, { ...opts, env });
  }

  on(event: 'server-ready', cb: (port: number, url: string) => void): void {
    if (event === 'server-ready') {
      this._serverListeners.push(cb);
    }
  }

  /** Emit a server-ready event (called by agent processes when they start listening). */
  emitServerReady(port: number, url: string): void {
    for (const cb of this._serverListeners) {
      cb(port, url);
    }
  }

  async teardown(): Promise<void> {
    this._proc.killAll();
    this._serverListeners = [];
    this._booted = false;
  }
}
