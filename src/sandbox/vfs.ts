// ─── VirtualFS: In-Memory POSIX Filesystem ──────────────────────────────────
// Pure browser implementation. No WASM. ~100ms boot.

import type { VFSNode, VFSStat, VFSDirent, WatchCallback, AuditHook, MountTree } from './types.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function normalize(p: string): string {
  const parts = p.split('/').filter(Boolean);
  const resolved: string[] = [];
  for (const part of parts) {
    if (part === '.') continue;
    if (part === '..') { resolved.pop(); continue; }
    resolved.push(part);
  }
  return '/' + resolved.join('/');
}

function parent(p: string): string {
  const idx = p.lastIndexOf('/');
  return idx <= 0 ? '/' : p.slice(0, idx);
}

function basename(p: string): string {
  return p.slice(p.lastIndexOf('/') + 1);
}

function makeStat(node: VFSNode): VFSStat {
  return {
    isFile: () => node.type === 'file',
    isDirectory: () => node.type === 'directory',
    isSymbolicLink: () => node.type === 'symlink',
    size: node.size,
    mtime: new Date(node.mtime),
    ctime: new Date(node.ctime),
    mode: node.mode,
  };
}

function makeNode(type: VFSNode['type'], content?: Uint8Array): VFSNode {
  const now = Date.now();
  const c = content ?? new Uint8Array(0);
  return {
    type,
    content: c,
    children: new Map(),
    mode: type === 'directory' ? 0o755 : 0o644,
    mtime: now,
    ctime: now,
    size: c.byteLength,
  };
}

export class VirtualFS {
  private inodes = new Map<string, VFSNode>();
  private watchers = new Map<string, Set<WatchCallback>>();
  private auditHook: AuditHook | null = null;

  constructor() {
    this.inodes.set('/', makeNode('directory'));
  }

  /** Set an audit hook to observe all operations. */
  onAudit(hook: AuditHook): void { this.auditHook = hook; }

  private audit(op: string, path: string, meta?: Record<string, unknown>): void {
    this.auditHook?.(op, path, meta);
  }

  private notify(path: string, event: string): void {
    let cur = normalize(path);
    const rel = cur.startsWith('/') ? cur.slice(1) : cur;
    while (cur) {
      const cbs = this.watchers.get(cur);
      if (cbs) for (const cb of cbs) { try { cb(event, rel); } catch { /* */ } }
      if (cur === '/') break;
      cur = parent(cur);
    }
  }

  private resolve(path: string): string {
    const norm = normalize(path);
    const node = this.inodes.get(norm);
    if (node?.type === 'symlink' && node.target) return normalize(node.target);
    return norm;
  }

  // ─── File Operations ──────────────────────────────────────────────────

  readFileSync(path: string, encoding?: string): string | Uint8Array {
    const p = this.resolve(path);
    const node = this.inodes.get(p);
    if (!node) throw Object.assign(new Error(`ENOENT: no such file: ${p}`), { code: 'ENOENT' });
    if (node.type !== 'file') throw Object.assign(new Error(`EISDIR: is a directory: ${p}`), { code: 'EISDIR' });
    this.audit('read', p);
    if (encoding === 'utf-8' || encoding === 'utf8') return decoder.decode(node.content);
    return node.content;
  }

  writeFileSync(path: string, data: string | Uint8Array, options?: { mode?: number }): void {
    const p = normalize(path);
    const bytes = typeof data === 'string' ? encoder.encode(data) : data;
    const existing = this.inodes.get(p);
    if (existing) {
      if (existing.type === 'directory') throw Object.assign(new Error(`EISDIR: ${p}`), { code: 'EISDIR' });
      existing.content = bytes;
      existing.size = bytes.byteLength;
      existing.mtime = Date.now();
      if (options?.mode) existing.mode = options.mode;
    } else {
      // Ensure parent
      const par = parent(p);
      if (!this.inodes.has(par)) throw Object.assign(new Error(`ENOENT: parent not found: ${par}`), { code: 'ENOENT' });
      const node = makeNode('file', bytes);
      if (options?.mode) node.mode = options.mode;
      this.inodes.set(p, node);
      this.inodes.get(par)!.children.set(basename(p), p);
    }
    this.audit('write', p, { size: bytes.byteLength });
    this.notify(p, 'change');
  }

  appendFileSync(path: string, data: string | Uint8Array): void {
    const p = normalize(path);
    const existing = this.inodes.get(p);
    const bytes = typeof data === 'string' ? encoder.encode(data) : data;
    if (existing && existing.type === 'file') {
      const merged = new Uint8Array(existing.content.byteLength + bytes.byteLength);
      merged.set(existing.content);
      merged.set(bytes, existing.content.byteLength);
      existing.content = merged;
      existing.size = merged.byteLength;
      existing.mtime = Date.now();
    } else {
      this.writeFileSync(path, data);
    }
  }

  unlinkSync(path: string): void {
    const p = normalize(path);
    const node = this.inodes.get(p);
    if (!node) throw Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' });
    if (node.type === 'directory') throw Object.assign(new Error(`EISDIR: ${p}`), { code: 'EISDIR' });
    this.inodes.delete(p);
    const par = this.inodes.get(parent(p));
    par?.children.delete(basename(p));
    this.audit('unlink', p);
    this.notify(p, 'rename');
  }

  // ─── Directory Operations ─────────────────────────────────────────────

  mkdirSync(path: string, options?: { recursive?: boolean; mode?: number }): void {
    const p = normalize(path);
    if (this.inodes.has(p)) {
      if (this.inodes.get(p)!.type === 'directory') return;
      throw Object.assign(new Error(`EEXIST: ${p}`), { code: 'EEXIST' });
    }
    if (options?.recursive) {
      const parts = p.split('/').filter(Boolean);
      let cur = '';
      for (const part of parts) {
        cur += '/' + part;
        if (!this.inodes.has(cur)) {
          const node = makeNode('directory');
          if (options?.mode) node.mode = options.mode;
          this.inodes.set(cur, node);
          const par = this.inodes.get(parent(cur));
          par?.children.set(part, cur);
        }
      }
    } else {
      const par = parent(p);
      if (!this.inodes.has(par)) throw Object.assign(new Error(`ENOENT: ${par}`), { code: 'ENOENT' });
      const node = makeNode('directory');
      if (options?.mode) node.mode = options.mode;
      this.inodes.set(p, node);
      this.inodes.get(par)!.children.set(basename(p), p);
    }
    this.audit('mkdir', p);
    this.notify(p, 'rename');
  }

  rmdirSync(path: string): void {
    const p = normalize(path);
    const node = this.inodes.get(p);
    if (!node) throw Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' });
    if (node.type !== 'directory') throw Object.assign(new Error(`ENOTDIR: ${p}`), { code: 'ENOTDIR' });
    if (node.children.size > 0) throw Object.assign(new Error(`ENOTEMPTY: ${p}`), { code: 'ENOTEMPTY' });
    this.inodes.delete(p);
    const par = this.inodes.get(parent(p));
    par?.children.delete(basename(p));
    this.audit('rmdir', p);
  }

  rmSync(path: string, options?: { recursive?: boolean; force?: boolean }): void {
    const p = normalize(path);
    const node = this.inodes.get(p);
    if (!node) {
      if (options?.force) return;
      throw Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' });
    }
    if (node.type === 'directory' && options?.recursive) {
      this.removeRecursive(p);
    } else if (node.type === 'directory') {
      this.rmdirSync(path);
    } else {
      this.unlinkSync(path);
    }
  }

  private removeRecursive(dirPath: string): void {
    const node = this.inodes.get(dirPath);
    if (!node) return;
    if (node.type === 'directory') {
      for (const [, childPath] of node.children) {
        this.removeRecursive(childPath);
      }
    }
    this.inodes.delete(dirPath);
    const par = this.inodes.get(parent(dirPath));
    par?.children.delete(basename(dirPath));
    this.notify(dirPath, 'rename');
  }

  readdirSync(path: string, options?: { withFileTypes?: boolean }): (string | VFSDirent)[] {
    const p = normalize(path);
    const node = this.inodes.get(p);
    if (!node) throw Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' });
    if (node.type !== 'directory') throw Object.assign(new Error(`ENOTDIR: ${p}`), { code: 'ENOTDIR' });
    this.audit('readdir', p);
    if (options?.withFileTypes) {
      const entries: VFSDirent[] = [];
      for (const [name, childPath] of node.children) {
        const child = this.inodes.get(childPath);
        if (!child) continue;
        entries.push({
          name,
          isFile: () => child.type === 'file',
          isDirectory: () => child.type === 'directory',
          isSymbolicLink: () => child.type === 'symlink',
        });
      }
      return entries;
    }
    return Array.from(node.children.keys());
  }

  // ─── Stat / Access ────────────────────────────────────────────────────

  statSync(path: string): VFSStat {
    const p = this.resolve(path);
    const node = this.inodes.get(p);
    if (!node) throw Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' });
    return makeStat(node);
  }

  lstatSync(path: string): VFSStat {
    const p = normalize(path);
    const node = this.inodes.get(p);
    if (!node) throw Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' });
    return makeStat(node);
  }

  existsSync(path: string): boolean {
    return this.inodes.has(normalize(path));
  }

  accessSync(path: string, _mode?: number): void {
    if (!this.existsSync(path)) throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
  }

  // ─── Copy / Rename / Symlink ──────────────────────────────────────────

  renameSync(oldPath: string, newPath: string): void {
    const op = normalize(oldPath);
    const np = normalize(newPath);
    const node = this.inodes.get(op);
    if (!node) throw Object.assign(new Error(`ENOENT: ${op}`), { code: 'ENOENT' });
    this.inodes.set(np, node);
    this.inodes.delete(op);
    const oldPar = this.inodes.get(parent(op));
    oldPar?.children.delete(basename(op));
    const newPar = this.inodes.get(parent(np));
    newPar?.children.set(basename(np), np);
    this.audit('rename', `${op} → ${np}`);
    this.notify(op, 'rename');
    this.notify(np, 'rename');
  }

  copyFileSync(src: string, dest: string): void {
    const content = this.readFileSync(src) as Uint8Array;
    this.writeFileSync(dest, new Uint8Array(content));
    this.audit('copy', `${src} → ${dest}`);
  }

  symlinkSync(target: string, linkPath: string): void {
    const p = normalize(linkPath);
    const node = makeNode('symlink');
    node.target = target;
    this.inodes.set(p, node);
    const par = this.inodes.get(parent(p));
    par?.children.set(basename(p), p);
    this.audit('symlink', `${linkPath} → ${target}`);
  }

  readlinkSync(path: string): string {
    const p = normalize(path);
    const node = this.inodes.get(p);
    if (!node || node.type !== 'symlink') throw Object.assign(new Error(`EINVAL: not a symlink: ${p}`), { code: 'EINVAL' });
    return node.target!;
  }

  chmodSync(path: string, mode: number): void {
    const p = normalize(path);
    const node = this.inodes.get(p);
    if (!node) throw Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' });
    node.mode = mode;
  }

  // ─── Watch ────────────────────────────────────────────────────────────

  watch(path: string, _options: { recursive?: boolean }, callback: WatchCallback): { close: () => void } {
    const p = normalize(path);
    if (!this.watchers.has(p)) this.watchers.set(p, new Set());
    this.watchers.get(p)!.add(callback);
    return {
      close: () => { this.watchers.get(p)?.delete(callback); },
    };
  }

  // ─── Mount / Snapshot ─────────────────────────────────────────────────

  mount(tree: MountTree, basePath = '/'): void {
    for (const [name, value] of Object.entries(tree)) {
      const fullPath = basePath === '/' ? `/${name}` : `${basePath}/${name}`;
      if ('file' in value) {
        const par = parent(fullPath);
        if (!this.inodes.has(par)) this.mkdirSync(par, { recursive: true });
        const content = value.file.contents;
        this.writeFileSync(fullPath, content);
      } else if ('directory' in value) {
        this.mkdirSync(fullPath, { recursive: true });
        this.mount(value.directory, fullPath);
      }
    }
  }

  snapshot(): Map<string, { type: string; content?: Uint8Array; target?: string }> {
    const snap = new Map<string, { type: string; content?: Uint8Array; target?: string }>();
    for (const [path, node] of this.inodes) {
      snap.set(path, {
        type: node.type,
        content: node.type === 'file' ? new Uint8Array(node.content) : undefined,
        target: node.target,
      });
    }
    return snap;
  }

  restore(snap: Map<string, { type: string; content?: Uint8Array; target?: string }>): void {
    this.inodes.clear();
    this.inodes.set('/', makeNode('directory'));
    for (const [path, data] of snap) {
      if (path === '/') continue;
      if (data.type === 'directory') {
        this.mkdirSync(path, { recursive: true });
      } else if (data.type === 'file' && data.content) {
        const par = parent(path);
        if (!this.inodes.has(par)) this.mkdirSync(par, { recursive: true });
        this.writeFileSync(path, data.content);
      } else if (data.type === 'symlink' && data.target) {
        this.symlinkSync(data.target, path);
      }
    }
  }

  /** Get all paths (for debugging). */
  dump(): string[] {
    return Array.from(this.inodes.keys()).sort();
  }

  // ─── Async wrappers (for ContainerRuntime compat) ─────────────────────

  async readFile(path: string, encoding?: string): Promise<string | Uint8Array> {
    return this.readFileSync(path, encoding);
  }
  async writeFile(path: string, content: string | Uint8Array): Promise<void> {
    this.writeFileSync(path, content);
  }
  async mkdir(path: string, opts?: { recursive?: boolean }): Promise<void> {
    this.mkdirSync(path, opts);
  }
  async rm(path: string, opts?: { recursive?: boolean }): Promise<void> {
    this.rmSync(path, opts);
  }
  async readdir(path: string, opts: { withFileTypes: true }): Promise<VFSDirent[]> {
    return this.readdirSync(path, opts) as VFSDirent[];
  }
}
