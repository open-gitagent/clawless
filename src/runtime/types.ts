// ─── ClawKernel Runtime Interface ────────────────────────────────────────────
// Abstract interface for the container runtime. Implementations:
// - WebContainerRuntime (wraps @webcontainer/api)
// - ClawKernelRuntime (custom WASM, coming soon)

/** Directory entry returned by readdir with withFileTypes. */
export interface DirEntry {
  name: string;
  isDirectory(): boolean;
}

/** Filesystem operations. */
export interface RuntimeFS {
  readFile(path: string, encoding: 'utf-8'): Promise<string>;
  readFile(path: string): Promise<Uint8Array>;
  writeFile(path: string, content: string | Uint8Array): Promise<void>;
  mkdir(path: string, opts?: { recursive?: boolean }): Promise<void>;
  rm(path: string, opts?: { recursive?: boolean }): Promise<void>;
  readdir(path: string, opts: { withFileTypes: true }): Promise<DirEntry[]>;
  watch(
    path: string,
    opts: { recursive?: boolean },
    cb: (event: string, filename: string | null) => void,
  ): void;
}

/** A running process. */
export interface RuntimeProcess {
  readonly output: ReadableStream<string | Uint8Array>;
  readonly input: WritableStream<string>;
  readonly exit: Promise<number>;
  resize?(dims: { cols: number; rows: number }): void;
}

/** Options for spawning a process. */
export interface SpawnOptions {
  terminal?: { cols: number; rows: number };
  env?: Record<string, string>;
}

/** File tree structure for mounting. */
export type MountTree = {
  [name: string]:
    | { file: { contents: string | Uint8Array } }
    | { directory: MountTree };
};

/** The runtime contract that ContainerManager depends on. */
export interface ContainerRuntime {
  /** Boot the runtime. */
  boot(): Promise<void>;

  /** Filesystem handle. Only valid after boot(). */
  readonly fs: RuntimeFS;

  /** Mount a file tree into the runtime. */
  mount(tree: MountTree): Promise<void>;

  /** Spawn a process. */
  spawn(cmd: string, args: string[], opts?: SpawnOptions): Promise<RuntimeProcess>;

  /** Listen for server-ready events (port opened inside runtime). */
  on(event: 'server-ready', cb: (port: number, url: string) => void): void;

  /** Tear down the runtime and release resources. */
  teardown(): Promise<void>;
}
