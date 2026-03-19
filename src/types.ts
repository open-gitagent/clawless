// ─── ClawContainer SDK Types ────────────────────────────────────────────────

import type { WebContainer } from '@webcontainer/api';
import type { AuditEntry, AuditSource, AuditLevel, AuditEvent } from './audit.js';
import type { ContainerTemplate } from './templates.js';

/** Configuration for launching an agent inside the container. */
export interface AgentConfig {
  /** npm package name (e.g. 'gitclaw') */
  package: string;
  /** Package version (e.g. '1.1.4'). Defaults to 'latest'. */
  version?: string;
  /** Entry file relative to the package directory (e.g. 'dist/index.js') */
  entry: string;
  /** Extra CLI args passed to node */
  args?: string[];
  /** Extra environment variables for the agent process */
  env?: Record<string, string>;
}

/** Options for creating a ClawContainer instance. */
export interface ClawContainerOptions {
  /** Agent to launch. Pass `false` to skip agent launch entirely. Default: gitclaw. */
  agent?: AgentConfig | false;
  /** Extra workspace files to mount: flat map of relative path → content */
  workspace?: Record<string, string>;
  /** Extra npm dependencies to install: package → version */
  services?: Record<string, string>;
  /** Environment variables injected into the container */
  env?: Record<string, string>;
  /** Shell script to run after install, before agent launch */
  startupScript?: string;
  /** Template to use: name of a registered template, or a ContainerTemplate object. Default: 'gitclaw'. */
  template?: string | ContainerTemplate;
  /** Plugins to register before start */
  plugins?: ClawContainerPlugin[];
  /** Custom tabs to add on start */
  tabs?: TabDefinition[];
}

/** Definition for a custom UI tab. */
export interface TabDefinition {
  /** Unique identifier for the tab */
  id: string;
  /** Display label in the tab bar */
  label: string;
  /** HTML content or a callback that receives the content container */
  render: string | ((container: HTMLDivElement) => void);
}

/** Plugin lifecycle hooks. All are optional. */
export interface ClawContainerPlugin {
  /** Plugin name (for debugging) */
  name: string;
  /** Extra npm deps this plugin needs */
  services?: Record<string, string>;
  /** Extra workspace files to merge */
  workspace?: Record<string, string>;
  /** Extra env vars to inject */
  env?: Record<string, string>;
  /** Custom tabs to register */
  tabs?: TabDefinition[];
  /** Called after plugin is registered, before container boot */
  onInit?(cc: ClawContainerSDK): void;
  /** Called after container is ready */
  onReady?(cc: ClawContainerSDK): void;
  /** Called when container is stopped */
  onDestroy?(cc: ClawContainerSDK): void;
}

/** Payload for injecting file context into a running agent. */
export interface ContextPayload {
  type: 'file';
  name: string;
  content: string;
  mime?: string;
}

/** Event map for ClawContainer typed events. */
export type ClawContainerEvents = {
  ready: [];
  error: [error: Error];
  status: [status: string];
  'file.change': [path: string];
  'file.upload': [path: string, size: number];
  'context.inject': [name: string];
  'process.exit': [code: number];
  'server.ready': [port: number, url: string];
  log: [entry: AuditEntry];
};

/**
 * Public surface of the SDK passed to plugins.
 * This is the same as ClawContainer but expressed as an interface
 * so plugins don't depend on the concrete class.
 */
export interface ClawContainerSDK {
  readonly container: WebContainer | null;
  start(): Promise<void>;
  stop(): Promise<void>;
  restart(): Promise<void>;
  exec(cmd: string): Promise<string>;
  shell(): Promise<void>;
  sendInput(data: string): Promise<void>;
  fs: {
    read(path: string): Promise<string>;
    write(path: string, content: string): Promise<void>;
    list(dir?: string): Promise<string[]>;
    mkdir(path: string): Promise<void>;
    remove(path: string): Promise<void>;
    grep(pattern: string | RegExp, dir?: string): Promise<Array<{ path: string; line: number; text: string }>>;
    writeBytes(path: string, content: Uint8Array): Promise<void>;
    upload(files: FileList | File[], targetDir?: string): Promise<string[]>;
  };
  sendContext(ctx: ContextPayload): Promise<void>;
  git: {
    clone(url: string, token?: string): Promise<void>;
    push(message?: string): Promise<string>;
    checkVisibility(owner: string, repo: string, token?: string): Promise<{ isPublic: boolean; canPush: boolean }>;
  };
  zip: {
    export(): Promise<Blob>;
    import(data: File | ArrayBuffer): Promise<void>;
  };
  logs(filter?: { source?: AuditSource; level?: AuditLevel; event?: AuditEvent }): AuditEntry[];
  use(plugin: ClawContainerPlugin): void;
  addTab(def: TabDefinition): void;
  removeTab(id: string): void;
  on<K extends keyof ClawContainerEvents>(event: K, fn: (...args: ClawContainerEvents[K]) => void): void;
  off<K extends keyof ClawContainerEvents>(event: K, fn: (...args: ClawContainerEvents[K]) => void): void;
  once<K extends keyof ClawContainerEvents>(event: K, fn: (...args: ClawContainerEvents[K]) => void): void;
}
