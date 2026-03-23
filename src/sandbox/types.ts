// ─── ClawSandbox Internal Types ─────────────────────────────────────────────

/** Inode representing a file or directory in the virtual filesystem. */
export interface VFSNode {
  type: 'file' | 'directory' | 'symlink';
  content: Uint8Array;
  children: Map<string, string>; // name → absolute path (dirs only)
  target?: string;               // symlink target
  mode: number;
  mtime: number;
  ctime: number;
  size: number;
}

/** Stats returned by stat/lstat. */
export interface VFSStat {
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
  size: number;
  mtime: Date;
  ctime: Date;
  mode: number;
}

/** Directory entry from readdir with withFileTypes. */
export interface VFSDirent {
  name: string;
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}

/** Watch event callback. */
export type WatchCallback = (eventType: string, filename: string | null) => void;

/** Audit hook — called on every operation for observability. */
export type AuditHook = (op: string, path: string, meta?: Record<string, unknown>) => void;

/** Mounted file tree format (compatible with WebContainers). */
export type MountTree = {
  [name: string]:
    | { file: { contents: string | Uint8Array } }
    | { directory: MountTree };
};

/** Spawned process handle. */
export interface SandboxProcess {
  readonly pid: number;
  readonly output: ReadableStream<string>;
  readonly input: WritableStream<string>;
  readonly exit: Promise<number>;
  resize?(dims: { cols: number; rows: number }): void;
  kill?(signal?: string): void;
}

/** Options for spawning a process. */
export interface SpawnOptions {
  terminal?: { cols: number; rows: number };
  env?: Record<string, string>;
  cwd?: string;
}
