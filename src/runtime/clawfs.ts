// ─── ClawFS: In-Memory POSIX-like Filesystem ────────────────────────────────
// Zero dependencies. Paths are always forward-slash separated.
// Content stored as Uint8Array; text encoding at the API boundary.

import type { RuntimeFS, DirEntry } from './types.js';

interface INode {
  type: 'file' | 'directory';
  content: Uint8Array;       // file data (empty for dirs)
  children: Set<string>;     // child names (dirs only)
  mtime: number;
}

type WatchCallback = (event: string, filename: string | null) => void;

/** Normalize a path: strip trailing slashes, collapse //, resolve . and .. */
function normalizePath(p: string): string {
  const parts = p.split('/').filter(Boolean);
  const resolved: string[] = [];
  for (const part of parts) {
    if (part === '.') continue;
    if (part === '..') { resolved.pop(); continue; }
    resolved.push(part);
  }
  return '/' + resolved.join('/');
}

/** Get parent path */
function parentPath(p: string): string {
  const idx = p.lastIndexOf('/');
  return idx <= 0 ? '/' : p.slice(0, idx);
}

/** Get basename */
function baseName(p: string): string {
  const idx = p.lastIndexOf('/');
  return p.slice(idx + 1);
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export class ClawFS implements RuntimeFS {
  private inodes = new Map<string, INode>();
  private watchers = new Map<string, Set<WatchCallback>>();

  constructor() {
    // Create root directory
    this.inodes.set('/', {
      type: 'directory',
      content: new Uint8Array(0),
      children: new Set(),
      mtime: Date.now(),
    });
  }

  // ─── Core helpers ──────────────────────────────────────────────────────

  private ensureParent(path: string): void {
    const parent = parentPath(path);
    const node = this.inodes.get(parent);
    if (!node) throw new Error(`ENOENT: parent directory not found: ${parent}`);
    if (node.type !== 'directory') throw new Error(`ENOTDIR: not a directory: ${parent}`);
  }

  private notifyWatchers(path: string, event: string): void {
    // Walk up the path tree and notify any recursive watchers
    let current = normalizePath(path);
    const filename = current.startsWith('/') ? current.slice(1) : current;

    while (current !== '') {
      const callbacks = this.watchers.get(current);
      if (callbacks) {
        for (const cb of callbacks) {
          try { cb(event, filename); } catch { /* ignore */ }
        }
      }
      if (current === '/') break;
      current = parentPath(current);
    }
  }

  // ─── RuntimeFS implementation ──────────────────────────────────────────

  readFile(path: string, encoding: 'utf-8'): Promise<string>;
  readFile(path: string): Promise<Uint8Array>;
  async readFile(path: string, encoding?: 'utf-8'): Promise<string | Uint8Array> {
    const norm = normalizePath(path);
    const node = this.inodes.get(norm);
    if (!node) throw new Error(`ENOENT: no such file: ${norm}`);
    if (node.type !== 'file') throw new Error(`EISDIR: is a directory: ${norm}`);
    if (encoding === 'utf-8') return decoder.decode(node.content);
    return node.content;
  }

  async writeFile(path: string, content: string | Uint8Array): Promise<void> {
    const norm = normalizePath(path);
    this.ensureParent(norm);

    const bytes = typeof content === 'string' ? encoder.encode(content) : content;
    const existing = this.inodes.get(norm);

    if (existing) {
      if (existing.type !== 'file') throw new Error(`EISDIR: cannot write to directory: ${norm}`);
      existing.content = bytes;
      existing.mtime = Date.now();
    } else {
      this.inodes.set(norm, {
        type: 'file',
        content: bytes,
        children: new Set(),
        mtime: Date.now(),
      });
      // Add to parent's children
      const parent = this.inodes.get(parentPath(norm))!;
      parent.children.add(baseName(norm));
    }

    this.notifyWatchers(norm, 'change');
  }

  async mkdir(path: string, opts?: { recursive?: boolean }): Promise<void> {
    const norm = normalizePath(path);

    if (this.inodes.has(norm)) {
      const node = this.inodes.get(norm)!;
      if (node.type === 'directory') return; // already exists
      throw new Error(`EEXIST: file exists at path: ${norm}`);
    }

    if (opts?.recursive) {
      // Create all intermediate dirs
      const parts = norm.split('/').filter(Boolean);
      let current = '';
      for (const part of parts) {
        current += '/' + part;
        if (!this.inodes.has(current)) {
          this.inodes.set(current, {
            type: 'directory',
            content: new Uint8Array(0),
            children: new Set(),
            mtime: Date.now(),
          });
          const parentNode = this.inodes.get(parentPath(current));
          if (parentNode) parentNode.children.add(part);
        }
      }
    } else {
      this.ensureParent(norm);
      this.inodes.set(norm, {
        type: 'directory',
        content: new Uint8Array(0),
        children: new Set(),
        mtime: Date.now(),
      });
      const parent = this.inodes.get(parentPath(norm))!;
      parent.children.add(baseName(norm));
    }

    this.notifyWatchers(norm, 'rename');
  }

  async rm(path: string, opts?: { recursive?: boolean }): Promise<void> {
    const norm = normalizePath(path);
    const node = this.inodes.get(norm);
    if (!node) throw new Error(`ENOENT: no such file or directory: ${norm}`);

    if (node.type === 'directory') {
      if (!opts?.recursive && node.children.size > 0) {
        throw new Error(`ENOTEMPTY: directory not empty: ${norm}`);
      }
      // Recursively delete all children
      if (opts?.recursive) {
        const toDelete: string[] = [];
        this.collectPaths(norm, toDelete);
        for (const p of toDelete) {
          this.inodes.delete(p);
        }
      }
    }

    this.inodes.delete(norm);
    // Remove from parent's children
    const parent = this.inodes.get(parentPath(norm));
    if (parent) parent.children.delete(baseName(norm));

    this.notifyWatchers(norm, 'rename');
  }

  private collectPaths(dirPath: string, result: string[]): void {
    const node = this.inodes.get(dirPath);
    if (!node || node.type !== 'directory') return;
    for (const child of node.children) {
      const childPath = dirPath === '/' ? `/${child}` : `${dirPath}/${child}`;
      result.push(childPath);
      this.collectPaths(childPath, result);
    }
  }

  async readdir(_path: string, opts: { withFileTypes: true }): Promise<DirEntry[]> {
    const norm = normalizePath(_path);
    const node = this.inodes.get(norm);
    if (!node) throw new Error(`ENOENT: no such directory: ${norm}`);
    if (node.type !== 'file' || opts) { /* ok */ }
    if (node.type !== 'directory') throw new Error(`ENOTDIR: not a directory: ${norm}`);

    const entries: DirEntry[] = [];
    for (const name of node.children) {
      const childPath = norm === '/' ? `/${name}` : `${norm}/${name}`;
      const childNode = this.inodes.get(childPath);
      if (!childNode) continue;
      entries.push({
        name,
        isDirectory: () => childNode.type === 'directory',
      });
    }
    return entries;
  }

  watch(
    path: string,
    _opts: { recursive?: boolean },
    cb: (event: string, filename: string | null) => void,
  ): void {
    const norm = normalizePath(path);
    if (!this.watchers.has(norm)) {
      this.watchers.set(norm, new Set());
    }
    this.watchers.get(norm)!.add(cb);
  }

  // ─── Mount utility ─────────────────────────────────────────────────────

  /** Mount a file tree into the filesystem. */
  async mountTree(tree: Record<string, any>, basePath = '/'): Promise<void> {
    for (const [name, value] of Object.entries(tree)) {
      const fullPath = basePath === '/' ? `/${name}` : `${basePath}/${name}`;

      if ('file' in value) {
        const content = value.file.contents;
        // Ensure parent exists
        await this.mkdir(parentPath(fullPath), { recursive: true });
        await this.writeFile(fullPath, content);
      } else if ('directory' in value) {
        await this.mkdir(fullPath, { recursive: true });
        await this.mountTree(value.directory, fullPath);
      }
    }
  }

  // ─── Debug ─────────────────────────────────────────────────────────────

  /** List all paths (for debugging). */
  dump(): string[] {
    return Array.from(this.inodes.keys()).sort();
  }
}
