// ─── ClawContainer SDK ──────────────────────────────────────────────────────

import type { WebContainer } from '@webcontainer/api';
import { TerminalManager } from './terminal.js';
import { ContainerManager } from './container.js';
import { UIManager } from './ui.js';
import { AuditLog, type AuditEntry, type AuditSource, type AuditLevel, type AuditEvent } from './audit.js';
import { PolicyEngine } from './policy.js';
import { installBrowserFetchInterceptor } from './net-intercept.js';
import { TypedEventEmitter } from './event-emitter.js';
import { PluginManager } from './plugin.js';
import { TabManager } from './tab-manager.js';
import type {
  AgentConfig,
  ClawContainerOptions,
  ClawContainerPlugin,
  ClawContainerEvents,
  ClawContainerSDK,
  TabDefinition,
} from './types.js';
import {
  type ContainerTemplate,
  TemplateRegistry,
  resolveTemplate,
  mergeTemplateWithOptions,
  parseTemplateYaml,
} from './templates.js';
import { GitService } from './git-service.js';
import JSZip from 'jszip';

export class ClawContainer extends TypedEventEmitter<ClawContainerEvents> implements ClawContainerSDK {
  // ─── Static template API ─────────────────────────────────────────────────
  private static _templateRegistry = new TemplateRegistry();

  /** Registered templates (read-only). */
  static get templates(): Map<string, ContainerTemplate> {
    return ClawContainer._templateRegistry.all;
  }

  /** Register a named template for reuse. */
  static registerTemplate(template: ContainerTemplate): void {
    ClawContainer._templateRegistry.register(template);
  }

  /** Parse a YAML string into a ContainerTemplate. */
  static parseTemplate(yaml: string): ContainerTemplate {
    return parseTemplateYaml(yaml);
  }

  // ─── Instance ────────────────────────────────────────────────────────────
  private _container: ContainerManager;
  private _terminal: TerminalManager;
  private _ui: UIManager;
  private _audit: AuditLog;
  private _policy: PolicyEngine;
  private _plugins: PluginManager;
  private _tabs: TabManager;
  private _options: ClawContainerOptions;
  private _selector: string;
  private _started = false;

  constructor(selector: string, options?: ClawContainerOptions) {
    super();
    this._selector = selector;
    this._options = options ?? {};

    this._terminal = new TerminalManager();
    this._container = new ContainerManager();
    this._audit = new AuditLog();
    this._policy = new PolicyEngine();
    this._plugins = new PluginManager();

    installBrowserFetchInterceptor(this._audit);

    // Restore saved policy
    const savedPolicyYaml = localStorage.getItem('clawchef_policy');
    if (savedPolicyYaml) {
      try {
        this._policy.loadPolicy(PolicyEngine.fromYaml(savedPolicyYaml));
        this._audit.log('policy.load', 'Restored policy from localStorage', undefined, { source: 'boot' });
      } catch { /* ignore invalid */ }
    }

    this._container.setAuditLog(this._audit);
    this._container.setPolicy(this._policy);

    this._ui = new UIManager(this._container, this._audit, this._policy);
    this._tabs = new TabManager(this._ui);

    // Register plugins from options
    if (this._options.plugins) {
      for (const p of this._options.plugins) this._plugins.register(p);
    }

    // Forward audit entries as 'log' events
    this._audit.onEntry((entry) => this.emit('log', entry));

    // Forward file change events
    this._container.onFileChange((path) => this.emit('file.change', path));
  }

  // ─── Public getters ───────────────────────────────────────────────────────

  /** Raw WebContainer instance for direct access. */
  get container(): WebContainer | null {
    return this._container.getWebContainer();
  }

  /** Terminal manager instance. */
  get terminal(): TerminalManager {
    return this._terminal;
  }

  // ─── Lifecycle ────────────────────────────────────────────────────────────

  async start(): Promise<void> {
    if (this._started) return;
    this._started = true;

    // ─── Resolve template and merge with options ───────────────────────────
    const template = resolveTemplate(this._options.template, ClawContainer._templateRegistry);
    const opts = mergeTemplateWithOptions(template, this._options);

    // Dispatch plugin onInit
    this._plugins.dispatchInit(this);

    // Init UI
    this._ui.init();
    this._container.setStatusListener((s) => {
      this._ui.setStatus(s);
      this.emit('status', s);
    });

    // Mount terminal
    const terminalContainer = document.getElementById('terminal-container')
      ?? document.querySelector(this._selector)?.querySelector('#terminal-container');
    if (terminalContainer) {
      this._terminal.mount(terminalContainer as HTMLElement);
    }

    // Remove loading overlay
    const overlay = document.getElementById('loading-overlay');
    if (overlay) {
      overlay.classList.add('fade-out');
      setTimeout(() => overlay.remove(), 400);
    }

    // Open preview
    this._ui.openPreviewOnLoad();

    // Merge plugin contributions with merged options
    const extraServices = { ...this._plugins.mergedServices, ...opts.services };
    const extraWorkspace = { ...this._plugins.mergedWorkspace, ...opts.workspace };
    const extraEnv = { ...this._plugins.mergedEnv, ...opts.env };

    // Extract agent config for boot (package.json generation)
    const resolvedAgent = opts.agent !== false ? opts.agent as AgentConfig | undefined : undefined;

    // Step 1: Boot
    const runtimeName = this._options.runtime ?? 'webcontainer';
    const isWasm = runtimeName === 'wasm';
    this._terminal.write(`\x1b[90m[ClawLess] Booting ${isWasm ? 'ClawWASM' : 'WebContainer'}…\x1b[0m\r\n`);
    this._audit.log('status.change', 'boot sequence started', { runtime: runtimeName }, { source: 'boot' });

    try {
      await this._container.boot({
        workspace: Object.keys(extraWorkspace).length > 0 ? extraWorkspace : undefined,
        services: Object.keys(extraServices).length > 0 ? extraServices : undefined,
        agentPackage: resolvedAgent?.package,
        agentVersion: resolvedAgent?.version,
        agentOverrides: resolvedAgent?.overrides,
        runtime: runtimeName,
      });
      this._audit.log('status.change', `${runtimeName} booted`, undefined, { source: 'boot' });
    } catch (e) {
      this._terminal.write(`\r\n\x1b[31m[ClawLess] Boot failed: ${(e as Error).message}\x1b[0m\r\n`);
      this.emit('error', e as Error);
      return;
    }

    // Step 2: npm install
    this._terminal.write('\x1b[90m[ClawLess] Installing dependencies (npm install)…\x1b[0m\r\n\r\n');
    try {
      await this._container.runNpmInstall(this._terminal);
    } catch (e) {
      this._terminal.write(`\r\n\x1b[31m[ClawLess] npm install failed:\x1b[0m\r\n${(e as Error).message}\r\n`);
      this.emit('error', e as Error);
      return;
    }

    this._audit.log('status.change', 'npm install complete', undefined, { source: 'boot' });
    this._terminal.write('\r\n\x1b[32m[ClawLess] Installation complete.\x1b[0m\r\n\r\n');

    // Step 3: Run startup script if provided
    if (opts.startupScript) {
      this._terminal.write('\x1b[90m[ClawLess] Running startup script…\x1b[0m\r\n');
      try {
        await this._container.runStartupScript(opts.startupScript, this._terminal);
      } catch (e) {
        this._terminal.write(`\r\n\x1b[31m[ClawLess] Startup script failed:\x1b[0m\r\n${(e as Error).message}\r\n`);
        this.emit('error', e as Error);
        return;
      }
    }

    // Step 4: Inject env vars if provided
    if (Object.keys(extraEnv).length > 0) {
      await this._container.configureEnv({
        provider: 'custom',
        model: '',
        envVars: extraEnv,
      });
    }

    // Step 5: Launch agent (unless agent: false)
    const agentConfig = opts.agent;

    if (agentConfig === false) {
      // No agent — container is ready for user to do whatever they want
      this._terminal.write('\x1b[32m[ClawLess] Ready (no agent).\x1b[0m\r\n\r\n');
      this.emit('ready');
    } else {
      const config = agentConfig as AgentConfig;
      const isGitclaw = config.package === 'gitclaw';

      // Prompt for API key if not yet configured
      const savedConfig = this._ui.getSavedConfig();
      if (!savedConfig) {
        this._ui.showConfigPanel();
        this._terminal.write('\x1b[33m[ClawLess] Configure your API key in the sidebar to continue.\x1b[0m\r\n\r\n');
        await this.waitForConfig();
      }

      const envConfig = this._ui.getSavedConfig()!;
      await this._container.configureEnv(envConfig);

      if (isGitclaw) {
        this._terminal.write('\x1b[90m[ClawLess] Launching gitclaw…\x1b[0m\r\n\r\n');
        this._audit.log('status.change', 'launching gitclaw', undefined, { source: 'boot' });

        try {
          await this._container.startGitclaw(this._terminal);
        } catch (e) {
          this._terminal.write(`\r\n\x1b[31m[ClawLess] Launch failed: ${(e as Error).message}\x1b[0m\r\n`);
          this.emit('error', e as Error);
          return;
        }
      } else {
        this._terminal.write(`\x1b[90m[ClawLess] Launching agent (${config.package})…\x1b[0m\r\n\r\n`);
        this._audit.log('status.change', `launching ${config.package}`, undefined, { source: 'boot' });

        try {
          await this._container.startAgent(config, this._terminal);
        } catch (e) {
          this._terminal.write(`\r\n\x1b[31m[ClawLess] Agent launch failed: ${(e as Error).message}\x1b[0m\r\n`);
          this.emit('error', e as Error);
          return;
        }
      }

      this.emit('ready');
    }

    // Register custom tabs from plugins and merged options
    const allTabs = [...this._plugins.mergedTabs, ...(opts.tabs ?? [])];
    for (const tab of allTabs) {
      this._tabs.addTab(tab);
    }

    // Dispatch plugin onReady
    this._plugins.dispatchReady(this);
  }

  async stop(): Promise<void> {
    this._plugins.dispatchDestroy(this);
    this._started = false;
  }

  async restart(): Promise<void> {
    await this.stop();
    await this.start();
  }

  // ─── Command execution ────────────────────────────────────────────────────

  /** Run any shell command and return stdout. */
  async exec(cmd: string): Promise<string> {
    return this._container.exec(cmd);
  }

  /** Open a raw interactive shell. */
  async shell(): Promise<void> {
    await this._container.startShell(this._terminal);
  }

  /** Write data to the active process stdin. */
  async sendInput(data: string): Promise<void> {
    await this._container.sendToShell(data);
  }

  // ─── File system convenience ──────────────────────────────────────────────

  fs = {
    read: (path: string): Promise<string> => {
      return this._container.readFile(path);
    },
    write: (path: string, content: string): Promise<void> => {
      return this._container.writeFile(path, content);
    },
    list: (dir?: string): Promise<string[]> => {
      return this._container.listWorkspaceFiles(dir);
    },
    mkdir: (path: string): Promise<void> => {
      return this._container.mkdir(path);
    },
    remove: (path: string): Promise<void> => {
      return this._container.remove(path);
    },
    grep: async (pattern: string | RegExp, dir?: string): Promise<Array<{ path: string; line: number; text: string }>> => {
      const re = typeof pattern === 'string' ? new RegExp(pattern, 'i') : pattern;
      const paths = await this._container.listWorkspaceFiles(dir);
      const results: Array<{ path: string; line: number; text: string }> = [];
      for (const p of paths) {
        if (p.endsWith('/')) continue;
        try {
          const content = await this._container.readFile(`workspace/${p}`);
          const lines = content.split('\n');
          for (let i = 0; i < lines.length; i++) {
            if (re.test(lines[i])) {
              results.push({ path: p, line: i + 1, text: lines[i] });
            }
          }
        } catch { /* skip unreadable/binary files */ }
      }
      return results;
    },
  };

  // ─── Git ──────────────────────────────────────────────────────────────────

  git = {
    clone: (url: string, token?: string): Promise<void> => {
      return this._container.cloneRepo(url, token ?? '');
    },
    push: (message?: string): Promise<string> => {
      return this._container.syncToRepo(message);
    },
    checkVisibility: (owner: string, repo: string, token?: string): Promise<{ isPublic: boolean; canPush: boolean }> => {
      return GitService.checkRepoVisibility(owner, repo, token);
    },
  };

  // ─── Zip ─────────────────────────────────────────────────────────────────

  zip = {
    export: async (): Promise<Blob> => {
      const zip = new JSZip();
      const paths = await this._container.listWorkspaceFiles();
      for (const p of paths) {
        if (p.endsWith('/')) continue;
        const data = await this._container.readFileBuffer(`workspace/${p}`);
        zip.file(p, data);
      }
      return zip.generateAsync({ type: 'blob' });
    },
    import: async (data: File | ArrayBuffer): Promise<void> => {
      const zip = await JSZip.loadAsync(data);
      const entries: Promise<void>[] = [];
      zip.forEach((relativePath, entry) => {
        if (entry.dir) return;
        entries.push(
          entry.async('string').then(async (content) => {
            const fullPath = `workspace/${relativePath}`;
            const parts = fullPath.split('/');
            for (let i = 1; i < parts.length - 1; i++) {
              const dir = parts.slice(0, i + 1).join('/');
              try { await this._container.mkdir(dir); } catch { /* exists */ }
            }
            await this._container.writeFile(fullPath, content);
          }),
        );
      });
      await Promise.all(entries);
    },
  };

  // ─── Audit / Logs ─────────────────────────────────────────────────────────

  /** Get audit log entries, optionally filtered. */
  logs(filter?: { source?: AuditSource; level?: AuditLevel; event?: AuditEvent }): AuditEntry[] {
    if (filter) return this._audit.filter(filter);
    return this._audit.getEntries();
  }

  // ─── Plugin API ───────────────────────────────────────────────────────────

  /** Register a plugin. Must be called before start(). */
  use(plugin: ClawContainerPlugin): void {
    this._plugins.register(plugin);
  }

  // ─── Tab API ──────────────────────────────────────────────────────────────

  addTab(def: TabDefinition): void {
    this._tabs.addTab(def);
  }

  removeTab(id: string): void {
    this._tabs.removeTab(id);
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  private waitForConfig(): Promise<void> {
    return new Promise(resolve => {
      const interval = setInterval(() => {
        if (this._ui.getSavedConfig()) { clearInterval(interval); resolve(); }
      }, 500);
    });
  }
}
