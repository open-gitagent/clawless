// ─── NodepodRuntime — IRuntime impl backed by @scelar/nodepod ───────────────

import { Nodepod, NodepodTerminal, type NodepodProcess } from '@scelar/nodepod';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import type { TerminalManager } from './terminal.js';
import { buildWorkspaceFiles, GIT_STUB_JS, OPENCLAW_START_SCRIPT, OPENCLAW_SETUP_SCRIPT } from './workspace.js';
import { NATIVE_DEP_OVERRIDES } from './templates.js';
import { AuditLog } from './audit.js';
import { PolicyEngine, PolicyDeniedError, type PolicyAction } from './policy.js';
import { GitService, type GitFile } from './git-service.js';
import type { AgentConfig } from './types.js';
import type { IRuntime, ContainerStatus, ContainerEnv, BootOptions } from './runtime.js';

const NETWORK_HOOK_NODEPOD_CJS = `
// Nodepod network audit hook — matches the WebContainer hook's __NET_AUDIT__ protocol.
(function() {
  var maskHeaders = function(h) {
    if (!h) return h;
    var out = {};
    var SENSITIVE = ['authorization','x-api-key','api-key','cookie','set-cookie','x-auth-token'];
    var keys = h instanceof Headers ? Array.from(h.keys()) : Object.keys(h);
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      var v = h instanceof Headers ? h.get(k) : h[k];
      out[k] = SENSITIVE.indexOf(k.toLowerCase()) !== -1 ? '***masked***' : v;
    }
    return out;
  };
  var emit = function(obj) {
    try { process.stderr.write('__NET_AUDIT__:' + JSON.stringify(obj) + '\\n'); } catch (e) {}
  };
  var origFetch = globalThis.fetch;
  if (typeof origFetch === 'function') {
    globalThis.fetch = function(input, init) {
      var url = typeof input === 'string' ? input : (input && input.url) || '';
      var method = (init && init.method) || (input && input.method) || 'GET';
      var headers = (init && init.headers) || (input && input.headers);
      var start = Date.now();
      emit({ type: 'request', url: url, method: method, headers: maskHeaders(headers) });
      return origFetch.apply(this, arguments).then(function(res) {
        emit({ type: 'response', url: url, method: method, status: res.status, durationMs: Date.now() - start });
        return res;
      }, function(err) {
        emit({ type: 'response', url: url, method: method, error: String(err && err.message || err), durationMs: Date.now() - start });
        throw err;
      });
    };
  }
})();
`;

export class NodepodRuntime implements IRuntime {
  private np: Nodepod | null = null;
  private shellProcess: NodepodProcess | null = null;
  private nodepodTerminal: NodepodTerminal | null = null;
  private _status: ContainerStatus = 'booting';
  private onStatusChange?: (s: ContainerStatus) => void;

  private apiEnvVars: Record<string, string> = {};
  private serverUrls = new Map<number, string>();
  private fileChangeListeners: Array<(path: string) => void> = [];
  private audit: AuditLog | null = null;
  private policy: PolicyEngine | null = null;
  private activeProcessCount = 0;
  private gitService: GitService | null = null;
  private workdir = '/workspace';

  get status(): ContainerStatus { return this._status; }

  setAuditLog(a: AuditLog): void { this.audit = a; }
  setPolicy(p: PolicyEngine): void { this.policy = p; }
  setStatusListener(fn: (s: ContainerStatus) => void): void { this.onStatusChange = fn; }
  onFileChange(cb: (path: string) => void): void { this.fileChangeListeners.push(cb); }

  private setStatus(s: ContainerStatus): void {
    this._status = s;
    this.audit?.log('status.change', s, undefined, { source: 'boot' });
    this.onStatusChange?.(s);
  }

  private enforcePolicy(action: PolicyAction, subject: string, meta?: Record<string, unknown>): void {
    if (!this.policy) return;
    try {
      this.policy.enforce(action, subject, meta);
    } catch (e) {
      if (e instanceof PolicyDeniedError) {
        this.audit?.log('policy.deny', `${e.action}: ${e.subject}`, { rule: e.rule }, { source: 'policy', level: 'warn' });
      }
      throw e;
    }
  }

  // ─── Boot ────────────────────────────────────────────────────────────────

  async boot(opts?: BootOptions): Promise<void> {
    this.setStatus('booting');

    // Nodepod's resolver ignores package.json `overrides` and can't resolve
    // `git+` URLs. Its walker (`resolveFromManifest`) processes top-level deps
    // sequentially and gives the first walker of a name the root slot — so
    // listing our alias stubs BEFORE the agent package lets them claim the
    // root for names like `baileys`/`libsignal`, which short-circuits
    // gitclaw's transitive resolution when it walks the same name.
    const mergedOverrides = { ...NATIVE_DEP_OVERRIDES, ...opts?.agentOverrides };
    const agentPkg = opts?.agentPackage ?? 'gitclaw';
    const agentVer = opts?.agentVersion ?? '1.1.4';
    const packageJson = {
      name: `${agentPkg}-workspace`,
      version: '1.0.0',
      private: true,
      bin: { git: './git-stub.js' },
      dependencies: {
        ...mergedOverrides,
        [agentPkg]: agentVer,
        ...opts?.services,
      },
      overrides: mergedOverrides,
    };

    const files: Record<string, string> = {
      '/package.json': JSON.stringify(packageJson, null, 2),
      '/git-stub.js': GIT_STUB_JS,
      '/network-hook.cjs': NETWORK_HOOK_NODEPOD_CJS,
    };

    const workspaceFiles = buildWorkspaceFiles(opts?.workspace);
    for (const [name, node] of Object.entries(workspaceFiles)) {
      const contents = (node as { file?: { contents?: string } }).file?.contents;
      if (typeof contents === 'string') {
        files[`/workspace/${name}`] = contents;
      }
    }

    if (opts?.agentOverrides && Object.keys(opts.agentOverrides).length > 0) {
      files['/openclaw-start.mjs'] = OPENCLAW_START_SCRIPT;
      files['/openclaw-setup.cjs'] = OPENCLAW_SETUP_SCRIPT;
    }

    console.log('[ClawLess] Calling Nodepod.boot() with files:', Object.keys(files));
    try {
      this.np = await Nodepod.boot({
        files,
        workdir: this.workdir,
        enableSnapshotCache: true,
        serviceWorker: false,
        onServerReady: (port, url) => {
          if (this.policy) {
            const result = this.policy.check('server.bind', String(port));
            if (!result.allowed) {
              this.audit?.log('policy.deny', `server.bind: ${port}`, { rule: result.rule }, { source: 'policy', level: 'warn' });
              return;
            }
          }
          this.serverUrls.set(port, url);
          this.audit?.log('server.ready', `port ${port}`, { port, url }, { source: 'system' });
        },
      });
    } catch (e) {
      this.setStatus('error');
      const msg = (e as Error).message ?? String(e);
      this.audit?.log('status.change', `Nodepod boot failed: ${msg}`, { error: msg }, { source: 'boot', level: 'error' });
      console.error('[ClawLess] Nodepod.boot() failed:', e);
      throw new Error(`Nodepod boot failed: ${msg}`);
    }

    this.audit?.log('boot.mount', 'mounted workspace files', {
      files: Object.keys(files),
    }, { source: 'boot' });
  }

  // ─── npm install ─────────────────────────────────────────────────────────

  async runNpmInstall(terminal: TerminalManager): Promise<void> {
    if (!this.np) throw new Error('Runtime not booted');
    this.setStatus('installing');

    this.enforcePolicy('process.spawn', 'npm install (nodepod)', { activeProcesses: this.activeProcessCount });
    this.audit?.log('process.spawn', 'npm install (nodepod)', undefined, { source: 'boot' });
    this.activeProcessCount++;

    try {
      await this.np.packages.installFromManifest('/package.json', {
        onProgress: (msg) => {
          terminal.write(msg + '\r\n');
          this.audit?.logStdout(msg + '\n');
        },
      });
    } catch (e) {
      this.activeProcessCount--;
      this.setStatus('error');
      const msg = (e as Error).message;
      terminal.write(`\r\n\x1b[31m[ClawLess] npm install failed: ${msg}\x1b[0m\r\n`);
      this.audit?.log('process.exit', `npm install failed`, { error: msg }, { source: 'boot', level: 'error' });
      throw e;
    }

    this.activeProcessCount--;
    this.audit?.log('process.exit', 'npm install exited 0', { exitCode: 0 }, { source: 'boot' });

    await this.patchTransformerIncompatibilities();
  }

  /**
   * Post-install patches for files whose source trips Nodepod's regex-based
   * ESM→CJS transformer. Stainless-generated SDKs (Anthropic, OpenAI, etc.)
   * ship an `internal/uploads.js` containing a template literal with
   * `import('node:buffer')` inside a string — Nodepod's transformer rewrites
   * the substring as an import statement, producing invalid JS. We replace
   * every matching file with a shim whose exports line up for gitclaw's path.
   */
  private async patchTransformerIncompatibilities(): Promise<void> {
    if (!this.np) return;
    const UPLOADS_SHIM = `"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createForm = exports.multipartFormRequestOptions = exports.maybeMultipartFormRequestOptions = exports.isAsyncIterable = exports.checkFileSupport = void 0;
exports.makeFile = makeFile;
exports.getName = getName;
const checkFileSupport = () => {};
exports.checkFileSupport = checkFileSupport;
function makeFile(fileBits, fileName, options) {
  return new File(fileBits, fileName != null ? fileName : 'unknown_file', options);
}
function getName(value, stripPath) {
  const val = (typeof value === 'object' && value !== null &&
    (('name' in value && value.name && String(value.name)) ||
     ('url' in value && value.url && String(value.url)) ||
     ('filename' in value && value.filename && String(value.filename)) ||
     ('path' in value && value.path && String(value.path)))) || '';
  return stripPath ? val.split(/[\\\\/]/).pop() || undefined : val;
}
const isAsyncIterable = (value) => value != null && typeof value === 'object' && typeof value[Symbol.asyncIterator] === 'function';
exports.isAsyncIterable = isAsyncIterable;
const maybeMultipartFormRequestOptions = async (opts) => opts;
exports.maybeMultipartFormRequestOptions = maybeMultipartFormRequestOptions;
const multipartFormRequestOptions = async (opts) => opts;
exports.multipartFormRequestOptions = multipartFormRequestOptions;
const createForm = async (body) => body;
exports.createForm = createForm;
`;
    const matches = await this.findMatchingFiles('/node_modules', /\/internal\/uploads\.js$/);
    for (const path of matches) {
      try {
        await this.np.fs.writeFile(path, UPLOADS_SHIM);
        this.audit?.log('file.write', `patched transformer-incompat: ${path}`, undefined, { source: 'boot' });
      } catch (e) {
        this.audit?.log('status.change', `patch failed: ${path}`, { error: (e as Error).message }, { source: 'boot', level: 'warn' });
      }
    }
  }

  /** Recursively find files under `root` whose absolute path matches `pattern`. */
  private async findMatchingFiles(root: string, pattern: RegExp, depth = 0): Promise<string[]> {
    if (!this.np || depth > 6) return [];
    let entries: string[];
    try { entries = await this.np.fs.readdir(root); } catch { return []; }
    const results: string[] = [];
    for (const name of entries) {
      const abs = `${root}/${name}`;
      let stat;
      try { stat = await this.np.fs.stat(abs); } catch { continue; }
      if (stat.isDirectory) {
        results.push(...await this.findMatchingFiles(abs, pattern, depth + 1));
      } else if (pattern.test(abs)) {
        results.push(abs);
      }
    }
    return results;
  }

  // ─── Startup script ──────────────────────────────────────────────────────

  async runStartupScript(script: string, terminal: TerminalManager): Promise<void> {
    if (!this.np) throw new Error('Runtime not booted');

    this.enforcePolicy('process.spawn', 'sh -c <startup-script>', { activeProcesses: this.activeProcessCount });
    this.audit?.log('process.spawn', 'startup script', { script: script.slice(0, 200) }, { source: 'boot' });
    this.activeProcessCount++;

    const proc = await this.np.spawn('sh', ['-c', `cd ${this.workdir} && ${script}`], {
      env: this.apiEnvVars,
    });

    proc.on('output', (chunk) => { terminal.write(chunk); this.audit?.logStdout(chunk); });
    proc.on('error', (chunk) => { terminal.write(chunk); this.audit?.logStdout(chunk); });

    const { exitCode } = await proc.completion;
    this.activeProcessCount--;
    this.audit?.log('process.exit', `startup script exited ${exitCode}`, { exitCode }, { source: 'boot' });
    if (exitCode !== 0) throw new Error(`Startup script failed (exit ${exitCode})`);
  }

  // ─── configureEnv ────────────────────────────────────────────────────────

  async configureEnv(env: ContainerEnv): Promise<void> {
    if (!this.np) throw new Error('Runtime not booted');
    this.enforcePolicy('file.write', `${this.workdir}/.env`);

    this.apiEnvVars = { ...env.envVars };

    const maskedVars: Record<string, string> = {};
    for (const [k, v] of Object.entries(env.envVars)) maskedVars[k] = AuditLog.maskKey(v);
    this.audit?.log('env.configure', `provider=${env.provider} model=${env.model}`, {
      provider: env.provider,
      model: env.model,
      vars: maskedVars,
    }, { source: 'user' });

    const envLines = Object.entries(this.apiEnvVars).map(([k, v]) => `${k}=${v}`);
    await this.np.fs.writeFile(`${this.workdir}/.env`, envLines.join('\n') + '\n');
    this.audit?.log('file.write', `${this.workdir}/.env`, { keys: Object.keys(this.apiEnvVars) }, { source: 'system' });

    try {
      const yaml = await this.np.fs.readFile(`${this.workdir}/agent.yaml`, 'utf-8');
      this.audit?.log('file.read', `${this.workdir}/agent.yaml`, undefined, { source: 'system' });
      const patched = yaml.replace(/preferred:\s*"[^"]*"/, `preferred: "${env.model}"`);
      await this.np.fs.writeFile(`${this.workdir}/agent.yaml`, patched);
      this.audit?.log('file.write', `${this.workdir}/agent.yaml`, { action: 'patch-model', model: env.model }, { source: 'system' });
    } catch {
      // agent.yaml may not exist
    }
  }

  // ─── Agents ──────────────────────────────────────────────────────────────

  async startGitclaw(terminal: TerminalManager): Promise<void> {
    await this.startAgent(
      { package: 'gitclaw', entry: 'dist/index.js', args: ['--dir', '<home>/workspace'] },
      terminal,
    );
  }

  async startAgent(config: AgentConfig, terminal: TerminalManager): Promise<void> {
    if (!this.np) throw new Error('Runtime not booted');
    this.setStatus('ready');

    const entry = `/node_modules/${config.package}/${config.entry}`;
    const args = config.args?.map((a) => a.replace('<home>', '')) ?? [];

    // Wrapper forces isTTY=true on std streams before requiring the agent,
    // so gitclaw's readline / prompt libraries detect a TTY and stay alive.
    const wrapperPath = '/.agent-wrapper.cjs';
    const spawnCmd = `node ${wrapperPath} ${args.join(' ')}`;

    this.enforcePolicy('process.spawn', spawnCmd, { activeProcesses: this.activeProcessCount });
    this.audit?.log('process.spawn', spawnCmd, undefined, { source: 'agent' });

    // NodepodTerminal is needed because `np.spawn` alone doesn't provide a
    // stdin pipeline compatible with readline-based prompt libraries — they
    // exit immediately on EOF. createTerminal's shell-exec plumbing routes
    // stdin correctly. But NodepodTerminal also does its own local echo /
    // line editing which caused cascading duplicates. So we override
    // `_handleInput` to a thin passthrough: pipe every keystroke straight
    // to the child's stdin with no local echo, no line buffering, no
    // history — the running process (gitclaw) owns all display.
    const container = document.getElementById('terminal-container') as HTMLElement | null;
    if (!container) throw new Error('#terminal-container not found');
    if (this.nodepodTerminal) {
      try { this.nodepodTerminal.detach(); } catch { /* already detached */ }
    } else {
      terminal.dispose();
      container.innerHTML = '';
    }

    const nt = this.np.createTerminal({
      Terminal: XTerm,
      FitAddon: FitAddon,
      fontSize: 13,
      fontFamily: "'SF Mono', 'Fira Code', 'Cascadia Code', Menlo, monospace",
    });

    // Replace Nodepod's input handler entirely. If a child is running, pipe
    // keys straight to its stdin — gitclaw owns display, single echo. If no
    // child is running, fall back to the shell's onCommand so initial/manual
    // commands still work.
    const ntAny = nt as unknown as {
      _handleInput: (data: string) => void;
      _wiring: {
        getSendStdin: () => ((data: string) => void) | null;
        onCommand: (cmd: string) => Promise<void>;
      } | null;
    };
    let pendingCmd = '';
    ntAny._handleInput = function passthroughHandleInput(data: string) {
      const send = ntAny._wiring?.getSendStdin?.();
      if (send) {
        send(data);
        return;
      }
      // No child running — buffer the line and fire via shell onCommand on \r.
      for (const ch of data) {
        if (ch === '\r' || ch === '\n') {
          const cmd = pendingCmd;
          pendingCmd = '';
          if (cmd) void ntAny._wiring?.onCommand(cmd);
        } else if (ch.charCodeAt(0) === 127 || ch.charCodeAt(0) === 8) {
          pendingCmd = pendingCmd.slice(0, -1);
        } else if (ch.charCodeAt(0) >= 32) {
          pendingCmd += ch;
        }
      }
    };

    nt.attach(container);
    this.nodepodTerminal = nt;

    // Fit twice (once immediately, once after layout settles) so cols/rows
    // reach their final values, then write the wrapper with real dimensions
    // so gitclaw sees a correctly-sized stdout and redraws line-by-line
    // instead of wrapping/duplicating.
    setTimeout(() => {
      try { nt.fit(); } catch { /* ignore */ }
    }, 0);

    setTimeout(async () => {
      try { nt.fit(); } catch { /* ignore */ }
      const ntDims = nt as unknown as { _getCols(): number; _getRows(): number };
      const cols = ntDims._getCols() || 80;
      const rows = ntDims._getRows() || 24;
      const wrapperContent = `
try { if (process.stdin) { process.stdin.isTTY = true; process.stdin.columns = ${cols}; process.stdin.rows = ${rows}; } } catch (e) {}
try { if (process.stdout) { process.stdout.isTTY = true; process.stdout.columns = ${cols}; process.stdout.rows = ${rows}; } } catch (e) {}
try { if (process.stderr) { process.stderr.isTTY = true; process.stderr.columns = ${cols}; process.stderr.rows = ${rows}; } } catch (e) {}
require(${JSON.stringify(entry)});
`;
      await this.np!.fs.writeFile(wrapperPath, wrapperContent);
      void ntAny._wiring?.onCommand(`cd ${this.workdir} && ${spawnCmd}`);
    }, 200);
  }

  // ─── Shell / exec ────────────────────────────────────────────────────────

  async startShell(terminal: TerminalManager): Promise<void> {
    if (!this.np) throw new Error('Runtime not booted');

    this.enforcePolicy('process.spawn', 'nodepod shell', { activeProcesses: this.activeProcessCount });
    this.audit?.log('process.spawn', 'nodepod shell', undefined, { source: 'user' });

    terminal.write('\x1b[90m[ClawLess] Nodepod shell attached.\x1b[0m\r\n');
  }

  async sendToShell(data: string): Promise<void> {
    this.shellProcess?.write(data);
    this.audit?.logStdin(data);
  }

  async exec(cmd: string): Promise<string> {
    if (!this.np) throw new Error('Runtime not booted');

    this.enforcePolicy('process.spawn', cmd, { activeProcesses: this.activeProcessCount });
    this.audit?.log('process.spawn', cmd, undefined, { source: 'user' });
    this.activeProcessCount++;

    const proc = await this.np.spawn('sh', ['-c', cmd], {
      cwd: this.workdir,
      env: this.apiEnvVars,
    });

    const { stdout, exitCode } = await proc.completion;
    this.activeProcessCount--;
    this.audit?.log('process.exit', `exec exited ${exitCode}`, { exitCode, cmd }, { source: 'user' });
    return stdout.trimEnd();
  }

  // ─── Filesystem ──────────────────────────────────────────────────────────

  async readFile(path: string): Promise<string> {
    if (!this.np) throw new Error('Runtime not booted');
    const abs = toAbs(path);
    this.enforcePolicy('file.read', path);
    this.audit?.log('file.read', path, undefined, { source: 'user' });
    return this.np.fs.readFile(abs, 'utf-8');
  }

  async readFileBuffer(path: string): Promise<Uint8Array> {
    if (!this.np) throw new Error('Runtime not booted');
    const abs = toAbs(path);
    this.enforcePolicy('file.read', path);
    this.audit?.log('file.read', path, { binary: true }, { source: 'user' });
    return this.np.fs.readFile(abs) as unknown as Promise<Uint8Array>;
  }

  async writeFile(path: string, contents: string): Promise<void> {
    if (!this.np) throw new Error('Runtime not booted');
    const abs = toAbs(path);
    this.enforcePolicy('file.write', path, { size: contents.length });
    this.audit?.log('file.write', path, { length: contents.length }, { source: 'user' });
    await this.np.fs.writeFile(abs, contents);
    for (const fn of this.fileChangeListeners) fn(path);
  }

  async listWorkspaceFiles(dir = 'workspace'): Promise<string[]> {
    if (!this.np) return [];
    const rootAbs = toAbs(dir);
    try {
      return await recursiveList(this.np, rootAbs, rootAbs);
    } catch {
      return [];
    }
  }

  async mkdir(path: string): Promise<void> {
    if (!this.np) throw new Error('Runtime not booted');
    this.enforcePolicy('file.write', path);
    await this.np.fs.mkdir(toAbs(path), { recursive: true });
    this.audit?.log('file.write', `mkdir ${path}`, undefined, { source: 'user' });
  }

  async remove(path: string): Promise<void> {
    if (!this.np) throw new Error('Runtime not booted');
    this.enforcePolicy('file.write', path);
    const abs = toAbs(path);
    try {
      const stat = await this.np.fs.stat(abs);
      if (stat.isDirectory) await this.np.fs.rmdir(abs, { recursive: true });
      else await this.np.fs.unlink(abs);
    } catch {
      // Nothing to remove
    }
    this.audit?.log('file.write', `remove ${path}`, undefined, { source: 'user' });
  }

  startWatching(): void {
    if (!this.np) return;
    this.np.fs.watch(this.workdir, { recursive: true }, (_event, filename) => {
      if (filename) {
        const path = `workspace/${filename}`;
        for (const fn of this.fileChangeListeners) fn(path);
      }
    });
  }

  // ─── Git ─────────────────────────────────────────────────────────────────

  async cloneRepo(url: string, token: string): Promise<void> {
    if (!this.np) throw new Error('Runtime not booted');
    const { owner, repo } = GitService.parseRepoUrl(url);
    this.enforcePolicy('git.clone', `${owner}/${repo}`);
    this.audit?.log('git.clone', `${owner}/${repo}`, { url }, { source: 'user' });

    const svc = new GitService(token, owner, repo);
    await svc.detectDefaultBranch();
    const files = await svc.fetchRepoTree();

    for (const file of files) {
      const fullPath = `${this.workdir}/${file.path}`;
      const parts = fullPath.split('/');
      for (let i = 1; i < parts.length - 1; i++) {
        const dir = parts.slice(0, i + 1).join('/');
        try { await this.np.fs.mkdir(dir, { recursive: true }); } catch { /* exists */ }
      }
      await this.np.fs.writeFile(fullPath, file.content);
    }

    this.gitService = svc;
    this.audit?.log('git.clone', `Cloned ${files.length} files from ${owner}/${repo}@${svc.repoBranch}`, {
      owner, repo, branch: svc.repoBranch, fileCount: files.length,
    }, { source: 'system' });
  }

  async syncToRepo(message?: string): Promise<string> {
    if (!this.np) throw new Error('Runtime not booted');
    if (!this.gitService) throw new Error('No repository cloned');

    const owner = this.gitService.repoOwner;
    const repo = this.gitService.repoName;
    this.enforcePolicy('git.push', `${owner}/${repo}`);

    const IGNORED = /^(node_modules\/|\.git\/|\.env$)/;
    const allPaths = await this.listWorkspaceFiles();
    const files: GitFile[] = [];

    for (const relPath of allPaths) {
      if (relPath.endsWith('/')) continue;
      if (IGNORED.test(relPath)) continue;
      try {
        const content = await this.np.fs.readFile(`${this.workdir}/${relPath}`, 'utf-8');
        files.push({ path: relPath, content });
      } catch { /* skip unreadable */ }
    }

    const commitMsg = message ?? `Sync from ClawLess at ${new Date().toISOString()}`;
    const sha = await this.gitService.pushChanges(files, commitMsg);

    this.audit?.log('git.push', `Pushed ${files.length} files to ${owner}/${repo}`, {
      owner, repo, sha, fileCount: files.length,
    }, { source: 'user' });

    return sha;
  }

  get hasClonedRepo(): boolean { return this.gitService !== null; }

  getRawRuntime(): unknown { return this.np; }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Treat `workspace/...` from SDK callers as `/workspace/...` in the Nodepod VFS. */
function toAbs(path: string): string {
  if (path.startsWith('/')) return path;
  return '/' + path;
}

async function recursiveList(np: Nodepod, absDir: string, rootDir: string): Promise<string[]> {
  const entries = await np.fs.readdir(absDir);
  const results: string[] = [];
  for (const name of entries) {
    if (name === 'node_modules') continue;
    const abs = `${absDir}/${name}`;
    const rel = abs.replace(rootDir + '/', '');
    let stat;
    try { stat = await np.fs.stat(abs); } catch { continue; }
    if (stat.isDirectory) {
      results.push(rel + '/');
      results.push(...await recursiveList(np, abs, rootDir));
    } else {
      results.push(rel);
    }
  }
  return results;
}
