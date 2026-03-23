import { describe, it, expect } from 'vitest';
import { STUB_FILES, INSTALL_STUBS_SCRIPT } from './stubs.js';

const PACKAGES = ['sharp', 'lydell-node-pty', 'playwright-core', 'sqlite-vec', 'node-llama-cpp'];

describe('STUB_FILES', () => {
  it('has exactly 15 entries (5 packages x 3 files)', () => {
    expect(Object.keys(STUB_FILES)).toHaveLength(15);
  });

  it.each(PACKAGES)('%s has package.json, index.cjs, index.mjs', (pkg) => {
    const prefix = `.openclaw-stubs/${pkg}`;
    expect(STUB_FILES[`${prefix}/package.json`]).toBeDefined();
    expect(STUB_FILES[`${prefix}/index.cjs`]).toBeDefined();
    expect(STUB_FILES[`${prefix}/index.mjs`]).toBeDefined();
  });

  it.each(PACKAGES)('%s package.json has dual exports', (pkg) => {
    const parsed = JSON.parse(STUB_FILES[`.openclaw-stubs/${pkg}/package.json`]);
    expect(parsed.exports['.']).toHaveProperty('import');
    expect(parsed.exports['.']).toHaveProperty('require');
    expect(parsed.main).toBe('./index.cjs');
  });

  it.each(PACKAGES)('%s index.cjs uses explicit module.exports', (pkg) => {
    const cjs = STUB_FILES[`.openclaw-stubs/${pkg}/index.cjs`];
    expect(cjs).toContain('module.exports');
    expect(cjs).toContain('__esModule');
  });

  it.each(PACKAGES)('%s index.mjs re-exports from cjs', (pkg) => {
    const mjs = STUB_FILES[`.openclaw-stubs/${pkg}/index.mjs`];
    expect(mjs).toContain("from './index.cjs'");
    expect(mjs).toContain('export');
  });
});

describe('INSTALL_STUBS_SCRIPT', () => {
  it('copies all 5 packages to node_modules', () => {
    expect(INSTALL_STUBS_SCRIPT).toContain('cp -r workspace/.openclaw-stubs/sharp node_modules/sharp');
    expect(INSTALL_STUBS_SCRIPT).toContain('cp -r workspace/.openclaw-stubs/playwright-core node_modules/playwright-core');
    expect(INSTALL_STUBS_SCRIPT).toContain('cp -r workspace/.openclaw-stubs/sqlite-vec node_modules/sqlite-vec');
    expect(INSTALL_STUBS_SCRIPT).toContain('cp -r workspace/.openclaw-stubs/node-llama-cpp node_modules/node-llama-cpp');
    expect(INSTALL_STUBS_SCRIPT).toContain('cp -r workspace/.openclaw-stubs/lydell-node-pty node_modules/@lydell/node-pty');
  });

  it('creates @lydell scope dir', () => {
    expect(INSTALL_STUBS_SCRIPT).toContain('mkdir -p node_modules/@lydell');
  });

  it('guards against missing node_modules', () => {
    expect(INSTALL_STUBS_SCRIPT).toContain('[ -d node_modules ]');
  });

  it('removes existing packages before copying', () => {
    expect(INSTALL_STUBS_SCRIPT).toContain('rm -rf node_modules/sharp');
    expect(INSTALL_STUBS_SCRIPT).toContain('rm -rf node_modules/@lydell/node-pty');
  });
});
