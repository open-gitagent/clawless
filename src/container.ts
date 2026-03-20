import { WebContainer, type WebContainerProcess } from '@webcontainer/api';
import type { TerminalManager } from './terminal.js';
import { buildWorkspaceFiles, buildContainerPackageJson, buildStubLoaderRegister, buildStubLoaderHooks, GIT_STUB_JS, OPENCLAW_START_SCRIPT, OPENCLAW_SETUP_SCRIPT } from './workspace.js';
import { AuditLog, type AuditSource } from './audit.js';
import { NETWORK_HOOK_CJS } from './network-hook.js';
import { PolicyEngine, PolicyDeniedError, type PolicyAction } from './policy.js';
import { GitService, type GitFile } from './git-service.js';
import type { AgentConfig } from './types.js';

export type ContainerStatus = 'booting' | 'installing' | 'ready' | 'error';

export interface ContainerEnv {
  provider: string;
  model: string;
  envVars: Record<string, string>;
}

export class ContainerManager {
  private wc: WebContainer | null = null;
  private shellProcess: WebContainerProcess | null = null;
  private shellWriter: WritableStreamDefaultWriter<string> | null = null;
  private _status: ContainerStatus = 'booting';
  private onStatusChange?: (s: ContainerStatus) => void;

  // Stored after configureEnv() so startShell() can inject them directly
  private apiEnvVars: Record<string, string> = {};
  private serverUrls = new Map<number, string>();
  private serverListeners: Array<(port: number, url: string) => void> = [];
  private fileChangeListeners: Array<(path: string) => void> = [];
  private audit: AuditLog | null = null;
  private policy: PolicyEngine | null = null;
  private activeProcessCount = 0;
  private outputLineBuf = '';
  private outputFlushTimer: ReturnType<typeof setTimeout> | null = null;
  private gitService: GitService | null = null;

  get status(): ContainerStatus { return this._status; }

  setAuditLog(a: AuditLog): void { this.audit = a; }
  setPolicy(p: PolicyEngine): void { this.policy = p; }

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

  setStatusListener(fn: (s: ContainerStatus) => void): void {
    this.onStatusChange = fn;
  }

  private setStatus(s: ContainerStatus): void {
    this._status = s;
    this.audit?.log('status.change', s, undefined, { source: 'boot' });
    this.onStatusChange?.(s);
  }

  /**
   * Process an output chunk: strip __NET_AUDIT__ markers and log them,
   * pass clean output to terminal and audit stdout buffer.
   */
  private scheduleFlush(terminal: TerminalManager, _source: AuditSource): void {
    if (this.outputFlushTimer) return; // already scheduled
    this.outputFlushTimer = setTimeout(() => {
      this.outputFlushTimer = null;
      if (this.outputLineBuf.length === 0) return;
      // No __NET_AUDIT__ marker possible in a partial line (no newline) — safe to write directly
      terminal.write(this.outputLineBuf);
      this.audit?.logStdout(this.outputLineBuf);
      this.outputLineBuf = '';
    }, 30);
  }

  private processOutputChunk(
    chunk: string,
    terminal: TerminalManager,
    source: AuditSource,
  ): void {
    const buf = this.outputLineBuf + chunk;
    const lastNewline = buf.lastIndexOf('\n');

    // No complete line yet — buffer and schedule a flush
    if (lastNewline === -1) {
      this.outputLineBuf = buf;
      this.scheduleFlush(terminal, source);
      return;
    }

    // We have a complete line — cancel any pending flush
    if (this.outputFlushTimer) {
      clearTimeout(this.outputFlushTimer);
      this.outputFlushTimer = null;
    }

    // Split into complete lines + remainder
    const complete = buf.slice(0, lastNewline);
    this.outputLineBuf = buf.slice(lastNewline + 1);

    const lines = complete.split('\n');
    const cleanLines: string[] = [];

    const MARKER = '__NET_AUDIT__:';
    for (const line of lines) {
      const idx = line.indexOf(MARKER);
      if (idx !== -1) {
        const jsonStr = line.slice(idx + MARKER.length);
        try {
          const data = JSON.parse(jsonStr);
          if (data.type === 'request' || data.type === 'request.body') {
            this.audit?.log('net.request', data.url ?? '', {
              origin: 'container',
              method: data.method,
              ...(data.headers ? { headers: data.headers } : {}),
              ...(data.bodyPreview ? { bodyPreview: data.bodyPreview } : {}),
            }, { source });
          } else if (data.type === 'response') {
            this.audit?.log('net.response', data.url ?? '', {
              origin: 'container',
              method: data.method,
              ...(data.status != null ? { status: data.status } : {}),
              ...(data.error ? { error: data.error } : {}),
              ...(data.headers ? { headers: data.headers } : {}),
              ...(data.durationMs != null ? { durationMs: data.durationMs } : {}),
            }, { source });
          }
        } catch {
          // Malformed marker — ignore
        }
      } else {
        cleanLines.push(line);
      }
    }

    const cleanOutput = cleanLines.join('\n') + '\n';
    if (cleanLines.length > 0) {
      terminal.write(cleanOutput);
      this.audit?.logStdout(cleanOutput);
    }
  }

  /** Boot the WebContainer and mount all workspace files. */
  async boot(opts?: {
    workspace?: Record<string, string>;
    services?: Record<string, string>;
    agentPackage?: string;
    agentVersion?: string;
    agentOverrides?: Record<string, string>;
  }): Promise<void> {
    this.setStatus('booting');
    this.wc = await WebContainer.boot();

    this.wc.on('server-ready', (port: number, url: string) => {
      if (this.policy) {
        const result = this.policy.check('server.bind', String(port));
        if (!result.allowed) {
          this.audit?.log('policy.deny', `server.bind: ${port}`, { rule: result.rule }, { source: 'policy', level: 'warn' });
          return; // skip URL storage and listeners
        }
      }
      this.serverUrls.set(port, url);
      this.audit?.log('server.ready', `port ${port}`, { port, url }, { source: 'system' });
      for (const fn of this.serverListeners) fn(port, url);
    });

    const mountTree: Record<string, any> = {
      'package.json':     { file: { contents: buildContainerPackageJson({
        agentPackage: opts?.agentPackage,
        agentVersion: opts?.agentVersion,
        extraDeps: opts?.services,
        extraOverrides: opts?.agentOverrides,
      }) } },
      'git-stub.js':      { file: { contents: GIT_STUB_JS } },
      'network-hook.cjs': { file: { contents: NETWORK_HOOK_CJS } },
      workspace: { directory: buildWorkspaceFiles(opts?.workspace) },
    };

    // Mount stub loader hooks when native deps are stubbed via overrides
    if (opts?.agentOverrides && Object.keys(opts.agentOverrides).length > 0) {
      const pkgs = Object.keys(opts.agentOverrides);
      mountTree['stub-loader.mjs'] = { file: { contents: buildStubLoaderRegister(pkgs) } };
      mountTree['stub-loader-hooks.mjs'] = { file: { contents: buildStubLoaderHooks(pkgs) } };
      mountTree['openclaw-start.mjs'] = { file: { contents: OPENCLAW_START_SCRIPT } };
      mountTree['openclaw-setup.cjs'] = { file: { contents: OPENCLAW_SETUP_SCRIPT } };
    }

    await this.wc.mount(mountTree);

    this.audit?.log('boot.mount', 'mounted workspace files', {
      files: ['package.json', 'git-stub.js', 'network-hook.cjs', 'workspace/'],
    }, { source: 'boot' });
  }

  /**
   * Use Node.js to chmod git-stub.js and symlink it into node_modules/.bin/git.
   * Node.js fs.chmod works regardless of mount permissions.
   */
  private async linkGitStub(): Promise<void> {
    const script = [
      "const fs = require('fs');",
      "fs.chmodSync('git-stub.js', 0o755);",
      "try { fs.unlinkSync('node_modules/.bin/git'); } catch {}",
      "fs.symlinkSync('../../git-stub.js', 'node_modules/.bin/git');",
    ].join('\n');
    this.audit?.log('process.spawn', 'node -e <link-git-stub>', undefined, { source: 'boot' });
    const proc = await this.wc!.spawn('node', ['-e', script]);
    proc.output.pipeTo(new WritableStream());
    const exitCode = await proc.exit;
    this.audit?.log('process.exit', `link-git-stub exited ${exitCode}`, { exitCode }, { source: 'boot' });
  }

  /** Run `npm install` inside the container. All output goes to terminal. */
  async runNpmInstall(terminal: TerminalManager): Promise<void> {
    if (!this.wc) throw new Error('Container not booted');
    this.setStatus('installing');

    this.enforcePolicy('process.spawn', 'npm install --legacy-peer-deps --ignore-scripts', { activeProcesses: this.activeProcessCount });
    this.audit?.log('process.spawn', 'npm install --legacy-peer-deps --ignore-scripts', undefined, { source: 'boot' });
    this.activeProcessCount++;
    const proc = await this.wc.spawn('npm', [
      'install',
      '--legacy-peer-deps',
      '--ignore-scripts',
      '--cache', '/tmp/npm-cache',
    ], {
      env: {
        HOME: '/root',
        PATH: '/tmp/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
        NODE_OPTIONS: '--require ./network-hook.cjs',
      },
    });

    const outputChunks: string[] = [];
    const reader = proc.output.getReader();
    const decoder = new TextDecoder();

    (async () => {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const text = typeof value === 'string' ? value : decoder.decode(value);
        outputChunks.push(text);
        this.processOutputChunk(text, terminal, 'boot');
      }
    })();

    const exitCode = await proc.exit;
    this.activeProcessCount--;
    this.audit?.log('process.exit', `npm install exited ${exitCode}`, { exitCode }, { source: 'boot', level: exitCode !== 0 ? 'error' : 'info' });
    if (exitCode !== 0) {
      this.setStatus('error');
      const tail = outputChunks.join('').slice(-800);
      terminal.write(`\r\n\x1b[31m[ClawLess] npm install failed (exit ${exitCode})\x1b[0m\r\n`);
      throw new Error(`npm install failed (exit ${exitCode}):\n${tail}`);
    }

    // Link git-stub.js into node_modules/.bin/git with proper execute bit
    await this.linkGitStub();
  }

  /**
   * Store API key and patch agent.yaml with the chosen model.
   * The key is injected directly into the shell env when startShell() is called.
   */
  async configureEnv(env: ContainerEnv): Promise<void> {
    if (!this.wc) throw new Error('Container not booted');
    this.enforcePolicy('file.write', 'workspace/.env');

    // Use all user-supplied env vars directly
    this.apiEnvVars = { ...env.envVars };

    // If we have an OpenAI key, fetch an ephemeral realtime token from the
    // browser side (WebContainer's fetch drops Authorization headers)
    const openaiKey = this.apiEnvVars['OPENAI_API_KEY'];
    if (openaiKey) {
      try {
        const resp = await fetch('https://api.openai.com/v1/realtime/sessions', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${openaiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ model: 'gpt-4o-realtime-preview' }),
        });
        if (resp.ok) {
          const session = await resp.json() as { client_secret?: { value?: string } };
          const ephemeralKey = session.client_secret?.value;
          if (ephemeralKey) {
            this.apiEnvVars['OPENAI_EPHEMERAL_KEY'] = ephemeralKey;
            console.log('[ClawLess] Fetched ephemeral realtime token from browser');
          }
        }
      } catch {
        // Non-fatal — gitclaw will try its own auth
      }
    }

    // Log env config with masked keys
    const maskedVars: Record<string, string> = {};
    for (const [k, v] of Object.entries(env.envVars)) {
      maskedVars[k] = AuditLog.maskKey(v);
    }
    this.audit?.log('env.configure', `provider=${env.provider} model=${env.model}`, {
      provider: env.provider,
      model: env.model,
      vars: maskedVars,
    }, { source: 'user' });

    // Write .env file so gitclaw (and its voice server) can read keys
    const envLines: string[] = [];
    for (const [key, val] of Object.entries(this.apiEnvVars)) {
      envLines.push(`${key}=${val}`);
    }
    await this.wc.fs.writeFile('workspace/.env', envLines.join('\n') + '\n');
    this.audit?.log('file.write', 'workspace/.env', { keys: Object.keys(this.apiEnvVars) }, { source: 'system' });

    // Patch agent.yaml with the chosen model
    try {
      const yaml = await this.wc.fs.readFile('workspace/agent.yaml', 'utf-8');
      this.audit?.log('file.read', 'workspace/agent.yaml', undefined, { source: 'system' });
      const patched = yaml.replace(
        /preferred:\s*"[^"]*"/,
        `preferred: "${env.model}"`,
      );
      await this.wc.fs.writeFile('workspace/agent.yaml', patched);
      this.audit?.log('file.write', 'workspace/agent.yaml', { action: 'patch-model', model: env.model }, { source: 'system' });
    } catch {
      // agent.yaml might be custom — leave it
    }
  }

  /** Discover the container's home/project directory via $PWD. */
  private async getHomeDir(): Promise<string> {
    this.audit?.log('process.spawn', 'sh -c "echo $PWD"', undefined, { source: 'system' });
    const proc = await this.wc!.spawn('sh', ['-c', 'echo $PWD']);
    const reader = proc.output.getReader();
    const decoder = new TextDecoder();
    let out = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      out += typeof value === 'string' ? value : decoder.decode(value);
    }
    await proc.exit;
    return out.trim();
  }

  /**
   * Spawn gitclaw DIRECTLY with a PTY — not inside jsh.
   * jsh doesn't forward the PTY to child processes, breaking interactive REPLs.
   */
  async startGitclaw(terminal: TerminalManager): Promise<void> {
    if (!this.wc) throw new Error('Container not booted');
    this.setStatus('ready');

    const { cols, rows } = terminal.dimensions;
    const homeDir = await this.getHomeDir();

    const spawnCmd = `node ${homeDir}/node_modules/gitclaw/dist/index.js --dir ${homeDir}/workspace`;
    this.enforcePolicy('process.spawn', spawnCmd, { activeProcesses: this.activeProcessCount });
    this.audit?.log('process.spawn', spawnCmd, undefined, { source: 'agent' });
    this.activeProcessCount++;

    this.shellProcess = await this.wc.spawn(
      'node',
      [`${homeDir}/node_modules/gitclaw/dist/index.js`, '--dir', `${homeDir}/workspace`],
      {
        terminal: { cols, rows },
        env: {
          ...this.apiEnvVars,
          PATH: `${homeDir}/node_modules/.bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`,
          HOME: homeDir,
          NODE_OPTIONS: `--require ${homeDir}/network-hook.cjs`,
        },
      },
    );

    // Wire output → terminal (with audit + network marker parsing)
    this.shellProcess.output.pipeTo(
      new WritableStream({
        write: (chunk) => {
          this.processOutputChunk(chunk, terminal, 'agent');
        },
      }),
    );

    // Wire keystrokes directly to gitclaw stdin (no jsh in between)
    this.shellWriter = this.shellProcess.input.getWriter();
    terminal.onData((data) => {
      this.shellWriter?.write(data);
      this.audit?.logStdin(data);
    });

    window.addEventListener('resize', () => this.resizeShell(terminal));

    // Restart gitclaw when it exits (e.g. user types /quit)
    this.shellProcess.exit.then((code) => {
      this.activeProcessCount--;
      this.audit?.log('process.exit', `gitclaw exited`, { exitCode: code }, { source: 'agent' });
      terminal.write('\r\n\x1b[90m[ClawLess] gitclaw exited. Restarting in 2s…\x1b[0m\r\n');
      setTimeout(() => this.startGitclaw(terminal), 2000);
    });
  }

  /**
   * Start a raw jsh shell for file exploration / debugging.
   * Note: interactive Node.js REPLs won't work inside jsh — use startGitclaw() instead.
   */
  async startShell(terminal: TerminalManager): Promise<void> {
    if (!this.wc) throw new Error('Container not booted');

    const { cols, rows } = terminal.dimensions;
    const homeDir = await this.getHomeDir();

    this.enforcePolicy('process.spawn', '/bin/jsh --osc', { activeProcesses: this.activeProcessCount });
    this.audit?.log('process.spawn', '/bin/jsh --osc', undefined, { source: 'user' });
    this.activeProcessCount++;

    this.shellProcess = await this.wc.spawn('/bin/jsh', ['--osc'], {
      terminal: { cols, rows },
      env: {
        ...this.apiEnvVars,
        PATH: `${homeDir}/node_modules/.bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`,
        HOME: homeDir,
        NODE_OPTIONS: `--require ${homeDir}/network-hook.cjs`,
      },
    });

    this.shellProcess.output.pipeTo(
      new WritableStream({
        write: (chunk) => {
          this.processOutputChunk(chunk, terminal, 'user');
        },
      }),
    );

    this.shellWriter = this.shellProcess.input.getWriter();
    terminal.onData((data) => {
      this.shellWriter?.write(data);
      this.audit?.logStdin(data);
    });

    await this.shellWriter.write('cd workspace\nclear\n');
    window.addEventListener('resize', () => this.resizeShell(terminal));
  }

  private resizeShell(terminal: TerminalManager): void {
    if (!this.shellProcess) return;
    const { cols, rows } = terminal.dimensions;
    this.shellProcess.resize({ cols, rows });
  }

  async sendToShell(command: string): Promise<void> {
    await this.shellWriter?.write(command);
  }

  /** Get the URL for a server running on a given port inside the container. */
  getServerUrl(port: number): Promise<string> {
    const existing = this.serverUrls.get(port);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve) => {
      const listener = (p: number, url: string) => {
        if (p === port) {
          this.serverListeners = this.serverListeners.filter(l => l !== listener);
          resolve(url);
        }
      };
      this.serverListeners.push(listener);
    });
  }

  async listWorkspaceFiles(dir = 'workspace'): Promise<string[]> {
    if (!this.wc) return [];
    try {
      return await recursiveList(this.wc, dir, dir);
    } catch {
      return [];
    }
  }

  async readFile(path: string): Promise<string> {
    if (!this.wc) throw new Error('Container not booted');
    this.enforcePolicy('file.read', path);
    this.audit?.log('file.read', path, undefined, { source: 'user' });
    return this.wc.fs.readFile(path, 'utf-8');
  }

  /** Read a file as raw bytes (for binary download). */
  async readFileBuffer(path: string): Promise<Uint8Array> {
    if (!this.wc) throw new Error('Container not booted');
    this.enforcePolicy('file.read', path);
    this.audit?.log('file.read', path, { binary: true }, { source: 'user' });
    return this.wc.fs.readFile(path);
  }

  async writeFile(path: string, contents: string): Promise<void> {
    if (!this.wc) throw new Error('Container not booted');
    this.enforcePolicy('file.write', path, { size: contents.length });
    this.audit?.log('file.write', path, { length: contents.length }, { source: 'user' });
    await this.wc.fs.writeFile(path, contents);
    for (const fn of this.fileChangeListeners) fn(path);
  }

  /** Register a callback fired whenever a file is written. */
  onFileChange(fn: (path: string) => void): void {
    this.fileChangeListeners.push(fn);
  }

  /** Clone a GitHub repo into /workspace via the GitHub API. */
  async cloneRepo(url: string, token: string): Promise<void> {
    if (!this.wc) throw new Error('Container not booted');
    const { owner, repo } = GitService.parseRepoUrl(url);
    this.enforcePolicy('git.clone', `${owner}/${repo}`);
    this.audit?.log('git.clone', `${owner}/${repo}`, { url }, { source: 'user' });

    const svc = new GitService(token, owner, repo);
    await svc.detectDefaultBranch();
    const files = await svc.fetchRepoTree();

    // Write files to /workspace
    for (const file of files) {
      const fullPath = `workspace/${file.path}`;
      // Ensure parent directories exist
      const parts = fullPath.split('/');
      for (let i = 1; i < parts.length - 1; i++) {
        const dir = parts.slice(0, i + 1).join('/');
        try { await this.wc.fs.mkdir(dir); } catch { /* exists */ }
      }
      await this.wc.fs.writeFile(fullPath, file.content);
    }

    this.gitService = svc;
    this.audit?.log('git.clone', `Cloned ${files.length} files from ${owner}/${repo}@${svc.repoBranch}`, {
      owner, repo, branch: svc.repoBranch, fileCount: files.length,
    }, { source: 'system' });
  }

  /** Read all workspace files and push changes to GitHub. */
  async syncToRepo(message?: string): Promise<string> {
    if (!this.wc) throw new Error('Container not booted');
    if (!this.gitService) throw new Error('No repository cloned');

    const owner = this.gitService.repoOwner;
    const repo = this.gitService.repoName;
    this.enforcePolicy('git.push', `${owner}/${repo}`);

    // Collect all workspace files (excluding ignored paths)
    const IGNORED = /^(node_modules\/|\.git\/|\.env$)/;
    const allPaths = await this.listWorkspaceFiles();
    const files: GitFile[] = [];

    for (const relPath of allPaths) {
      if (relPath.endsWith('/')) continue; // skip directories
      if (IGNORED.test(relPath)) continue;
      try {
        const content = await this.wc.fs.readFile(`workspace/${relPath}`, 'utf-8');
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

  /** Check if a repo has been cloned. */
  get hasClonedRepo(): boolean { return this.gitService !== null; }

  /** Expose the raw WebContainer instance for direct user access. */
  getWebContainer(): WebContainer | null { return this.wc; }

  /** Launch a generic agent process with PTY, similar to startGitclaw(). */
  async startAgent(config: AgentConfig, terminal: TerminalManager): Promise<void> {
    if (!this.wc) throw new Error('Container not booted');
    this.setStatus('ready');

    const { cols, rows } = terminal.dimensions;
    const homeDir = await this.getHomeDir();

    const entry = `${homeDir}/node_modules/${config.package}/${config.entry}`;
    const args = config.args?.map(a => a.replace('<home>', homeDir)) ?? [];
    const spawnCmd = `node ${entry} ${args.join(' ')}`;

    this.enforcePolicy('process.spawn', spawnCmd, { activeProcesses: this.activeProcessCount });
    this.audit?.log('process.spawn', spawnCmd, undefined, { source: 'agent' });
    this.activeProcessCount++;

    const nodeOptions = [`--require ${homeDir}/network-hook.cjs`];
    if (config.overrides && Object.keys(config.overrides).length > 0) {
      nodeOptions.push(`--import ${homeDir}/stub-loader.mjs`);
    }

    this.shellProcess = await this.wc.spawn('node', [entry, ...args], {
      terminal: { cols, rows },
      env: {
        ...this.apiEnvVars,
        ...config.env,
        PATH: `${homeDir}/node_modules/.bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`,
        HOME: homeDir,
        NODE_OPTIONS: nodeOptions.join(' '),
      },
    });

    this.shellProcess.output.pipeTo(
      new WritableStream({
        write: (chunk) => {
          this.processOutputChunk(chunk, terminal, 'agent');
        },
      }),
    );

    this.shellWriter = this.shellProcess.input.getWriter();
    terminal.onData((data) => {
      this.shellWriter?.write(data);
      this.audit?.logStdin(data);
    });

    window.addEventListener('resize', () => this.resizeShell(terminal));

    this.shellProcess.exit.then((code) => {
      this.activeProcessCount--;
      this.audit?.log('process.exit', `agent exited`, { exitCode: code }, { source: 'agent' });
      terminal.write(`\r\n\x1b[90m[ClawLess] agent exited. Restarting in 2s…\x1b[0m\r\n`);
      setTimeout(() => this.startAgent(config, terminal), 2000);
    });
  }

  /** Run an arbitrary startup script inside the container shell. */
  async runStartupScript(script: string, terminal: TerminalManager): Promise<void> {
    if (!this.wc) throw new Error('Container not booted');
    const homeDir = await this.getHomeDir();

    this.enforcePolicy('process.spawn', `sh -c <startup-script>`, { activeProcesses: this.activeProcessCount });
    this.audit?.log('process.spawn', 'startup script', { script: script.slice(0, 200) }, { source: 'boot' });
    this.activeProcessCount++;

    const proc = await this.wc.spawn('sh', ['-c', `cd workspace && ${script}`], {
      env: {
        ...this.apiEnvVars,
        PATH: `${homeDir}/node_modules/.bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`,
        HOME: homeDir,
      },
    });

    proc.output.pipeTo(
      new WritableStream({
        write: (chunk) => {
          this.processOutputChunk(chunk, terminal, 'boot');
        },
      }),
    );

    const exitCode = await proc.exit;
    this.activeProcessCount--;
    this.audit?.log('process.exit', `startup script exited ${exitCode}`, { exitCode }, { source: 'boot' });
    if (exitCode !== 0) {
      throw new Error(`Startup script failed (exit ${exitCode})`);
    }
  }

  /** Execute a command and return stdout as a string. */
  async exec(cmd: string): Promise<string> {
    if (!this.wc) throw new Error('Container not booted');

    this.enforcePolicy('process.spawn', cmd, { activeProcesses: this.activeProcessCount });
    this.audit?.log('process.spawn', cmd, undefined, { source: 'user' });
    this.activeProcessCount++;

    const proc = await this.wc.spawn('sh', ['-c', cmd]);
    const reader = proc.output.getReader();
    const decoder = new TextDecoder();
    let output = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      output += typeof value === 'string' ? value : decoder.decode(value);
    }

    const exitCode = await proc.exit;
    this.activeProcessCount--;
    this.audit?.log('process.exit', `exec exited ${exitCode}`, { exitCode, cmd }, { source: 'user' });

    return output.trimEnd();
  }

  /** Create a directory inside the container. */
  async mkdir(path: string): Promise<void> {
    if (!this.wc) throw new Error('Container not booted');
    this.enforcePolicy('file.write', path);
    await this.wc.fs.mkdir(path, { recursive: true });
    this.audit?.log('file.write', `mkdir ${path}`, undefined, { source: 'user' });
  }

  /** Remove a file inside the container. */
  async remove(path: string): Promise<void> {
    if (!this.wc) throw new Error('Container not booted');
    this.enforcePolicy('file.write', path);
    await this.wc.fs.rm(path, { recursive: true });
    this.audit?.log('file.write', `remove ${path}`, undefined, { source: 'user' });
  }

  /** Start watching the workspace directory for file-system events. */
  startWatching(): void {
    if (!this.wc) return;
    this.wc.fs.watch('/workspace', { recursive: true }, (_event, filename) => {
      if (filename) {
        const path = `workspace/${filename}`;
        for (const fn of this.fileChangeListeners) fn(path);
      }
    });
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

async function recursiveList(
  wc: WebContainer,
  absDir: string,
  rootDir: string,
): Promise<string[]> {
  const entries = await wc.fs.readdir(absDir, { withFileTypes: true });
  const results: string[] = [];

  for (const entry of entries) {
    if (entry.name === 'node_modules') continue;
    const abs = `${absDir}/${entry.name}`;
    const rel = abs.replace(rootDir + '/', '');

    if (entry.isDirectory()) {
      results.push(rel + '/');
      const children = await recursiveList(wc, abs, rootDir);
      results.push(...children);
    } else {
      results.push(rel);
    }
  }

  return results;
}
