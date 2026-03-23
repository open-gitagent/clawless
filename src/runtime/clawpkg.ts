// ─── ClawPkg: Package/Agent Loader ──────────────────────────────────────────
// Replaces npm install for ClawKernel. Loads pre-bundled agents from a CDN
// or inline bundle, unpacks them into ClawFS.

import type { ClawFS } from './clawfs.js';

export interface AgentBundle {
  /** npm package name */
  name: string;
  /** Package version */
  version: string;
  /** Entry file relative to package root */
  entry: string;
  /** Bundled files: relative path → content */
  files: Record<string, string | Uint8Array>;
}

/** Default CDN base URL for pre-built agent bundles. */
const DEFAULT_CDN = 'https://cdn.clawless.dev/bundles';

export class ClawPkg {
  private fs: ClawFS;
  private cdnBase: string;

  constructor(fs: ClawFS, cdnBase?: string) {
    this.fs = fs;
    this.cdnBase = cdnBase ?? DEFAULT_CDN;
  }

  /**
   * Install an agent bundle into the filesystem.
   * Files are placed at /node_modules/{name}/.
   */
  async installBundle(bundle: AgentBundle): Promise<void> {
    const baseDir = `/node_modules/${bundle.name}`;
    await this.fs.mkdir(baseDir, { recursive: true });

    // Write package.json
    await this.fs.writeFile(`${baseDir}/package.json`, JSON.stringify({
      name: bundle.name,
      version: bundle.version,
      main: bundle.entry,
    }, null, 2));

    // Write all bundled files
    for (const [relPath, content] of Object.entries(bundle.files)) {
      const fullPath = `${baseDir}/${relPath}`;
      // Ensure parent dirs
      const parts = fullPath.split('/');
      for (let i = 1; i < parts.length - 1; i++) {
        const dir = parts.slice(0, i + 1).join('/');
        try { await this.fs.mkdir(dir, { recursive: true }); } catch { /* exists */ }
      }
      await this.fs.writeFile(fullPath, content);
    }
  }

  /**
   * Fetch and install an agent from the CDN.
   * Expects a JSON manifest at {cdn}/{name}@{version}/manifest.json.
   */
  async installFromCDN(name: string, version = 'latest'): Promise<AgentBundle> {
    const manifestUrl = `${this.cdnBase}/${name}@${version}/manifest.json`;

    const resp = await fetch(manifestUrl);
    if (!resp.ok) {
      throw new Error(`Failed to fetch agent manifest: ${resp.status} ${resp.statusText}`);
    }

    const manifest = await resp.json() as {
      name: string;
      version: string;
      entry: string;
      files: string[]; // relative paths to fetch
    };

    // Fetch each file
    const files: Record<string, string> = {};
    const baseUrl = `${this.cdnBase}/${name}@${manifest.version}`;

    await Promise.all(
      manifest.files.map(async (relPath) => {
        const fileResp = await fetch(`${baseUrl}/${relPath}`);
        if (fileResp.ok) {
          files[relPath] = await fileResp.text();
        }
      }),
    );

    const bundle: AgentBundle = {
      name: manifest.name,
      version: manifest.version,
      entry: manifest.entry,
      files,
    };

    await this.installBundle(bundle);
    return bundle;
  }

  /**
   * Create a bundle from inline JavaScript code.
   * Useful for embedding small agents without a CDN.
   */
  static inlineBundle(name: string, code: string, version = '1.0.0'): AgentBundle {
    return {
      name,
      version,
      entry: 'dist/index.js',
      files: {
        'dist/index.js': code,
      },
    };
  }
}
