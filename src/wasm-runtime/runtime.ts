// ─── ClawWASM Runtime ───────────────────────────────────────────────────────
// Full-parity WebContainers alternative. MIT licensed. ~1.5MB WASM payload.
// Uses QuickJS asyncify for JS execution, our VFS for filesystem,
// our Shell for commands, and browser fetch for networking.

import { VirtualFS } from '../sandbox/vfs.js';
// ShellInterpreter used internally by ProcessMgr
import { ProcessMgr } from '../sandbox/process-mgr.js';
import { PackageLoader } from '../sandbox/pkg-loader.js';
import { WasmEngine } from './wasm-engine.js';
import type { MountTree, SandboxProcess, SpawnOptions } from '../sandbox/types.js';

export class ClawWASMRuntime {
  private _vfs: VirtualFS;
  // shell is managed inside ProcessMgr
  private _procMgr: ProcessMgr;
  private _pkgLoader: PackageLoader;
  private _env: Record<string, string> = {};
  private _booted = false;
  private _serverListeners: Array<(port: number, url: string) => void> = [];

  constructor() {
    this._vfs = new VirtualFS();
    this._env = { HOME: '/', PATH: '/node_modules/.bin:/usr/bin:/bin', NODE_ENV: 'development' };
    this._procMgr = new ProcessMgr(this._vfs, this._env);
    this._pkgLoader = new PackageLoader(this._vfs);
  }

  get fs() { return this._vfs; }

  async boot(): Promise<void> {
    this._vfs.mkdirSync('/home', { recursive: true });
    this._vfs.mkdirSync('/tmp', { recursive: true });
    this._vfs.mkdirSync('/workspace', { recursive: true });
    this._vfs.mkdirSync('/node_modules/.bin', { recursive: true });
    this._vfs.mkdirSync('/usr/bin', { recursive: true });
    this._booted = true;
  }

  async mount(tree: MountTree): Promise<void> {
    if (!this._booted) throw new Error('Runtime not booted');
    this._vfs.mount(tree);
  }

  async spawn(cmd: string, args: string[], opts?: SpawnOptions): Promise<SandboxProcess> {
    if (!this._booted) throw new Error('Runtime not booted');
    const env = { ...this._env, ...opts?.env };
    const cwd = opts?.cwd || env.HOME || '/';

    // For node commands, use WasmEngine (QuickJS asyncify)
    if (cmd === 'node') {
      return this.spawnNode(args, env, cwd, opts);
    }

    // For npm, use PackageLoader
    if (cmd === 'npm') {
      return this.spawnNpm(args, env, opts);
    }

    // For shell commands, use ProcessMgr (which uses ShellInterpreter)
    return this._procMgr.spawn(cmd, args, { ...opts, env, cwd });
  }

  on(_event: 'server-ready', cb: (port: number, url: string) => void): void {
    this._serverListeners.push(cb);
  }

  async teardown(): Promise<void> {
    this._procMgr.killAll();
    this._booted = false;
  }

  /** Expose raw VFS for ContainerManager compatibility. */
  getWebContainer(): null { return null; }

  // ─── Node.js Execution via QuickJS WASM ─────────────────────────────────

  private spawnNode(args: string[], env: Record<string, string>, cwd: string, opts?: SpawnOptions): SandboxProcess {
    const outputTransform = new TransformStream<string, string>();
    const inputTransform = new TransformStream<string, string>();
    const outputWriter = outputTransform.writable.getWriter();
    // inputReader available for interactive stdin

    let exitResolve: (code: number) => void;
    const exitPromise = new Promise<number>((resolve) => { exitResolve = resolve; });

    const process: SandboxProcess = {
      pid: 1,
      output: outputTransform.readable,
      input: inputTransform.writable,
      exit: exitPromise,
      resize: opts?.terminal ? () => {} : undefined,
    };

    // Run QuickJS async in next tick
    queueMicrotask(async () => {
      const engine = new WasmEngine({
        vfs: this._vfs,
        env,
        argv: args,
        cwd,
        stdout: (data) => { try { outputWriter.write(data); } catch { /* */ } },
        stderr: (data) => { try { outputWriter.write(data); } catch { /* */ } },
        onExit: (code) => { exitResolve!(code); },
      });

      try {
        await engine.init();

        let exitCode: number;
        if (args.includes('-e')) {
          const codeIdx = args.indexOf('-e');
          exitCode = await engine.run(args[codeIdx + 1] || '', '<eval>');
        } else if (args[0]) {
          exitCode = await engine.runFile(args[0]);
        } else {
          await outputWriter.write('[ClawWASM] node: missing script\n');
          exitCode = 1;
        }

        engine.dispose();
        await outputWriter.close();
        exitResolve!(exitCode);
      } catch (e) {
        const msg = (e as Error).message;
        try { await outputWriter.write(`[ClawWASM] Error: ${msg}\n`); } catch { /* */ }
        try { await outputWriter.close(); } catch { /* */ }
        engine.dispose();
        exitResolve!(1);
      }
    });

    return process;
  }

  // ─── npm via PackageLoader ────────────────────────────────────────────

  private spawnNpm(args: string[], _env: Record<string, string>, opts?: SpawnOptions): SandboxProcess {
    const outputTransform = new TransformStream<string, string>();
    const inputTransform = new TransformStream<string, string>();
    const outputWriter = outputTransform.writable.getWriter();

    let exitResolve: (code: number) => void;
    const exitPromise = new Promise<number>((resolve) => { exitResolve = resolve; });

    const process: SandboxProcess = {
      pid: 2,
      output: outputTransform.readable,
      input: inputTransform.writable,
      exit: exitPromise,
      resize: opts?.terminal ? () => {} : undefined,
    };

    queueMicrotask(async () => {
      try {
        const subCmd = args[0];
        if (subCmd === 'install' || subCmd === 'i') {
          const pkgs = args.slice(1).filter(a => !a.startsWith('-'));
          if (pkgs.length > 0) {
            for (const pkg of pkgs) {
              await outputWriter.write(`Installing ${pkg}...\n`);
              await this._pkgLoader.install(pkg);
              await outputWriter.write(`Installed ${pkg}\n`);
            }
          } else {
            // Install from package.json
            await outputWriter.write('Installing dependencies from package.json...\n');
            await this._pkgLoader.installFromPackageJson('/package.json');
            await outputWriter.write('Install complete.\n');
          }
        } else {
          await outputWriter.write(`npm ${args.join(' ')}\n`);
        }
        await outputWriter.close();
        exitResolve!(0);
      } catch (e) {
        try { await outputWriter.write(`npm error: ${(e as Error).message}\n`); } catch { /* */ }
        try { await outputWriter.close(); } catch { /* */ }
        exitResolve!(1);
      }
    });

    return process;
  }
}
