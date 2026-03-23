// ─── ClawSandbox: Browser-Native Node.js Runtime ────────────────────────────
// Drop-in replacement for WebContainers. Pure JS, no WASM, ~100ms boot.

import { VirtualFS } from './vfs.js';
import { ProcessMgr } from './process-mgr.js';
import { PackageLoader } from './pkg-loader.js';
import { NetBridge } from './net-bridge.js';
import type { MountTree, SandboxProcess, SpawnOptions, AuditHook } from './types.js';

export class ClawSandbox {
  private _vfs: VirtualFS;
  private _proc: ProcessMgr;
  private _pkg: PackageLoader;
  private _net: NetBridge;
  private _booted = false;
  private _env: Record<string, string> = {};

  constructor() {
    this._vfs = new VirtualFS();
    this._env = { HOME: '/', PATH: '/node_modules/.bin:/usr/bin:/bin', NODE_ENV: 'development' };
    this._proc = new ProcessMgr(this._vfs, this._env);
    this._pkg = new PackageLoader(this._vfs);
    this._net = new NetBridge();
  }

  /** The virtual filesystem. */
  get fs() { return this._vfs; }

  /** The package loader. */
  get pkg() { return this._pkg; }

  /** The network bridge. */
  get net() { return this._net; }

  /** Set an audit hook for all filesystem operations. */
  onAudit(hook: AuditHook): void { this._vfs.onAudit(hook); }

  /** Boot the sandbox runtime. */
  async boot(): Promise<void> {
    // Create default directory structure
    this._vfs.mkdirSync('/home', { recursive: true });
    this._vfs.mkdirSync('/tmp', { recursive: true });
    this._vfs.mkdirSync('/workspace', { recursive: true });
    this._vfs.mkdirSync('/node_modules/.bin', { recursive: true });
    this._vfs.mkdirSync('/usr/bin', { recursive: true });

    // Start network bridge
    this._net.start();

    this._booted = true;
  }

  /** Mount a file tree (WebContainers-compatible format). */
  async mount(tree: MountTree): Promise<void> {
    if (!this._booted) throw new Error('Sandbox not booted');
    this._vfs.mount(tree);
  }

  /** Spawn a process (node, npm, sh, etc.). */
  async spawn(cmd: string, args: string[], opts?: SpawnOptions): Promise<SandboxProcess> {
    if (!this._booted) throw new Error('Sandbox not booted');
    return this._proc.spawn(cmd, args, {
      ...opts,
      env: { ...this._env, ...opts?.env },
    });
  }

  /** Listen for server-ready events (Express, etc.). */
  on(_event: 'server-ready', cb: (port: number, url: string) => void): void {
    this._net.onServerReady(cb);
  }

  /** Tear down the sandbox. */
  async teardown(): Promise<void> {
    this._proc.killAll();
    this._booted = false;
  }

  /** Take a filesystem snapshot. */
  snapshot() { return this._vfs.snapshot(); }

  /** Restore a filesystem snapshot. */
  restore(snap: ReturnType<VirtualFS['snapshot']>) { this._vfs.restore(snap); }
}
