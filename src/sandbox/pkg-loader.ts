// ─── PackageLoader: npm CDN Fetch + Install ─────────────────────────────────
// Fetches packages from jsDelivr/unpkg, resolves deps, writes to VFS.

import type { VirtualFS } from './vfs.js';
import * as pathModule from './polyfills/path.js';

const CDN_BASE = 'https://cdn.jsdelivr.net/npm';
const REGISTRY = 'https://registry.npmjs.org';

export class PackageLoader {
  private vfs: VirtualFS;
  private installed = new Set<string>();
  private onProgress?: (msg: string) => void;

  constructor(vfs: VirtualFS, onProgress?: (msg: string) => void) {
    this.vfs = vfs;
    this.onProgress = onProgress;
  }

  /** Install a package and its dependencies. */
  async install(name: string, version = 'latest'): Promise<void> {
    const key = `${name}@${version}`;
    if (this.installed.has(key)) return;
    this.installed.add(key);

    this.onProgress?.(`Installing ${key}...`);

    try {
      // Fetch package metadata to get resolved version + deps
      const meta = await this.fetchMeta(name, version);
      const resolvedVersion = meta.version;
      const deps = meta.dependencies || {};

      // Fetch package files from CDN
      await this.fetchPackageFiles(name, resolvedVersion);

      // Recursively install dependencies (limit depth to avoid infinite loops)
      const depEntries = Object.entries(deps).slice(0, 50); // cap deps
      for (const [depName, depVersion] of depEntries) {
        if (!this.installed.has(`${depName}@${depVersion}`)) {
          try {
            await this.install(depName, depVersion as string);
          } catch {
            // Non-fatal — some deps may not be available via CDN
          }
        }
      }
    } catch (e) {
      this.onProgress?.(`Warning: Could not install ${key}: ${(e as Error).message}`);
    }
  }

  /** Fetch package metadata from npm registry. */
  private async fetchMeta(name: string, version: string): Promise<any> {
    const url = version === 'latest'
      ? `${REGISTRY}/${encodeURIComponent(name)}/latest`
      : `${REGISTRY}/${encodeURIComponent(name)}/${version}`;

    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`Registry ${resp.status}`);
    return resp.json();
  }

  /** Fetch key files of a package from CDN. */
  private async fetchPackageFiles(name: string, version: string): Promise<void> {
    const baseDir = `/node_modules/${name}`;
    this.vfs.mkdirSync(baseDir, { recursive: true });

    // Fetch package.json first
    try {
      const pkgResp = await fetch(`${CDN_BASE}/${name}@${version}/package.json`);
      if (pkgResp.ok) {
        const pkgText = await pkgResp.text();
        this.vfs.writeFileSync(`${baseDir}/package.json`, pkgText);

        // Determine the main entry and fetch it
        const pkg = JSON.parse(pkgText);
        const entries = [
          pkg.main,
          pkg.module,
          pkg.browser,
          'index.js',
          'dist/index.js',
          'lib/index.js',
        ].filter(Boolean);

        for (const entry of entries) {
          if (typeof entry !== 'string') continue;
          try {
            const entryResp = await fetch(`${CDN_BASE}/${name}@${version}/${entry}`);
            if (entryResp.ok) {
              const content = await entryResp.text();
              const entryPath = `${baseDir}/${entry}`;
              const dir = pathModule.dirname(entryPath);
              this.vfs.mkdirSync(dir, { recursive: true });
              this.vfs.writeFileSync(entryPath, content);
              break; // Got the main entry
            }
          } catch { /* try next */ }
        }
      }
    } catch {
      // Fallback: try to fetch index.js directly
      try {
        const resp = await fetch(`${CDN_BASE}/${name}@${version}`);
        if (resp.ok) {
          const content = await resp.text();
          this.vfs.writeFileSync(`${baseDir}/index.js`, content);
          this.vfs.writeFileSync(`${baseDir}/package.json`, JSON.stringify({ name, version, main: 'index.js' }));
        }
      } catch { /* give up */ }
    }
  }

  /** Install all dependencies from a package.json in the VFS. */
  async installFromPackageJson(path = '/package.json'): Promise<void> {
    try {
      const content = this.vfs.readFileSync(path, 'utf-8') as string;
      const pkg = JSON.parse(content);
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };
      for (const [name, version] of Object.entries(deps)) {
        await this.install(name, version as string);
      }
    } catch (e) {
      this.onProgress?.(`Could not read package.json: ${(e as Error).message}`);
    }
  }
}
