// ─── Runtime abstraction ────────────────────────────────────────────────────
// Decouples ClawContainer from any specific Node-in-browser implementation.
// Current impls: WebContainerRuntime (StackBlitz WASM) and NodepodRuntime
// (@scelar/nodepod Web Workers).

import type { TerminalManager } from './terminal.js';
import type { AuditLog } from './audit.js';
import type { PolicyEngine } from './policy.js';
import type { AgentConfig } from './types.js';

export type ContainerStatus = 'booting' | 'installing' | 'ready' | 'error';

export interface ContainerEnv {
  provider: string;
  model: string;
  envVars: Record<string, string>;
}

export interface BootOptions {
  workspace?: Record<string, string>;
  services?: Record<string, string>;
  agentPackage?: string;
  agentVersion?: string;
  agentOverrides?: Record<string, string>;
}

/**
 * Common surface every runtime must implement. Exactly the set of methods
 * ClawContainer and UIManager call on the runtime today — no more, no less.
 */
export interface IRuntime {
  // ─── Wiring ──────────────────────────────────────────────────────────────
  setAuditLog(a: AuditLog): void;
  setPolicy(p: PolicyEngine): void;
  setStatusListener(fn: (s: ContainerStatus) => void): void;
  onFileChange(cb: (path: string) => void): void;

  // ─── Lifecycle ───────────────────────────────────────────────────────────
  boot(opts?: BootOptions): Promise<void>;
  runNpmInstall(terminal: TerminalManager): Promise<void>;
  runStartupScript(script: string, terminal: TerminalManager): Promise<void>;
  configureEnv(env: ContainerEnv): Promise<void>;
  startGitclaw(terminal: TerminalManager): Promise<void>;
  startAgent(config: AgentConfig, terminal: TerminalManager): Promise<void>;

  // ─── Shell / exec ────────────────────────────────────────────────────────
  startShell(terminal: TerminalManager): Promise<void>;
  sendToShell(data: string): Promise<void>;
  exec(cmd: string): Promise<string>;

  // ─── Filesystem ──────────────────────────────────────────────────────────
  readFile(path: string): Promise<string>;
  readFileBuffer(path: string): Promise<Uint8Array>;
  writeFile(path: string, content: string): Promise<void>;
  listWorkspaceFiles(dir?: string): Promise<string[]>;
  mkdir(path: string): Promise<void>;
  remove(path: string): Promise<void>;
  startWatching(): void;

  // ─── Git ─────────────────────────────────────────────────────────────────
  cloneRepo(url: string, token: string): Promise<void>;
  syncToRepo(message?: string): Promise<string>;
  readonly hasClonedRepo: boolean;

  // ─── Raw runtime escape hatch ────────────────────────────────────────────
  /** Expose the underlying runtime instance for advanced use. */
  getRawRuntime(): unknown;
}
