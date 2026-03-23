// ─── path polyfill ──────────────────────────────────────────────────────────

export const sep = '/';
export const delimiter = ':';

export function normalize(p: string): string {
  const parts = p.split('/').filter(Boolean);
  const res: string[] = [];
  for (const part of parts) {
    if (part === '.') continue;
    if (part === '..') { res.pop(); continue; }
    res.push(part);
  }
  const result = res.join('/');
  return p.startsWith('/') ? '/' + result : result || '.';
}

export function join(...parts: string[]): string {
  return normalize(parts.filter(Boolean).join('/'));
}

export function resolve(...parts: string[]): string {
  let resolved = '';
  for (let i = parts.length - 1; i >= 0; i--) {
    resolved = parts[i] + (resolved ? '/' + resolved : '');
    if (parts[i].startsWith('/')) break;
  }
  return normalize(resolved);
}

export function dirname(p: string): string {
  const idx = p.lastIndexOf('/');
  if (idx <= 0) return p.startsWith('/') ? '/' : '.';
  return p.slice(0, idx);
}

export function basename(p: string, ext?: string): string {
  let base = p.slice(p.lastIndexOf('/') + 1);
  if (ext && base.endsWith(ext)) base = base.slice(0, -ext.length);
  return base;
}

export function extname(p: string): string {
  const base = basename(p);
  const idx = base.lastIndexOf('.');
  return idx <= 0 ? '' : base.slice(idx);
}

export function isAbsolute(p: string): boolean {
  return p.startsWith('/');
}

export function relative(from: string, to: string): string {
  const f = resolve(from).split('/').filter(Boolean);
  const t = resolve(to).split('/').filter(Boolean);
  let common = 0;
  while (common < f.length && common < t.length && f[common] === t[common]) common++;
  const ups = f.length - common;
  return [...Array(ups).fill('..'), ...t.slice(common)].join('/') || '.';
}

export function parse(p: string) {
  const dir = dirname(p);
  const base = basename(p);
  const ext = extname(p);
  const name = base.slice(0, base.length - ext.length);
  return { root: p.startsWith('/') ? '/' : '', dir, base, ext, name };
}

export function format(obj: { dir?: string; root?: string; base?: string; name?: string; ext?: string }): string {
  const base = obj.base || (obj.name || '') + (obj.ext || '');
  return obj.dir ? obj.dir + '/' + base : base;
}

export const posix = { sep, delimiter, normalize, join, resolve, dirname, basename, extname, isAbsolute, relative, parse, format };
export const win32 = posix; // no windows support

export default { sep, delimiter, normalize, join, resolve, dirname, basename, extname, isAbsolute, relative, parse, format, posix, win32 };
