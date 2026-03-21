import { describe, it, expect } from 'vitest';
import { buildContainerPackageJson, buildWorkspaceFiles } from './workspace.js';

describe('buildContainerPackageJson', () => {
  it('derives deps from AgentConfig', () => {
    const pkg = JSON.parse(buildContainerPackageJson({ package: 'gitclaw', version: '1.1.4', entry: 'dist/index.js' }));
    expect(pkg.dependencies.gitclaw).toBe('1.1.4');
  });

  it('defaults version to latest', () => {
    const pkg = JSON.parse(buildContainerPackageJson({ package: 'openclaw', entry: 'x.mjs' }));
    expect(pkg.dependencies.openclaw).toBe('latest');
  });

  it.each([
    ['false', false as const],
    ['undefined', undefined],
  ])('produces empty deps for agent:%s', (_label, input) => {
    const pkg = JSON.parse(buildContainerPackageJson(input));
    expect(pkg.dependencies).toEqual({});
  });

  it('merges extraDeps with agent deps', () => {
    const pkg = JSON.parse(buildContainerPackageJson({ package: 'a', entry: 'x' }, { lodash: '4' }));
    expect(pkg.dependencies).toEqual({ a: 'latest', lodash: '4' });
  });

  it('uses clawless-workspace as package name', () => {
    const pkg = JSON.parse(buildContainerPackageJson(false));
    expect(pkg.name).toBe('clawless-workspace');
  });

  it('includes baileys override', () => {
    const pkg = JSON.parse(buildContainerPackageJson(false));
    expect(pkg.overrides.baileys).toBe('npm:is-number@7.0.0');
  });

  it('includes git stub bin entry', () => {
    const pkg = JSON.parse(buildContainerPackageJson(false));
    expect(pkg.bin.git).toBe('./git-stub.js');
  });
});

describe('buildWorkspaceFiles', () => {
  it('returns empty tree when no extra files', () => {
    expect(buildWorkspaceFiles()).toEqual({});
  });

  it('returns empty tree for empty extra', () => {
    expect(buildWorkspaceFiles({})).toEqual({});
  });

  it('creates flat file entry', () => {
    const tree = buildWorkspaceFiles({ 'README.md': '# Hello' });
    expect(tree['README.md']).toEqual({ file: { contents: '# Hello' } });
  });

  it('creates nested directory structure from path separators', () => {
    const tree = buildWorkspaceFiles({ 'src/index.ts': 'console.log("hi")' });
    expect(tree.src.directory['index.ts']).toEqual({ file: { contents: 'console.log("hi")' } });
  });

  it('handles deeply nested paths', () => {
    const tree = buildWorkspaceFiles({ 'a/b/c/d.txt': 'deep' });
    expect(tree.a.directory.b.directory.c.directory['d.txt']).toEqual({ file: { contents: 'deep' } });
  });

  it('merges multiple files into same directory', () => {
    const tree = buildWorkspaceFiles({
      'src/a.ts': 'a',
      'src/b.ts': 'b',
    });
    expect(tree.src.directory['a.ts']).toEqual({ file: { contents: 'a' } });
    expect(tree.src.directory['b.ts']).toEqual({ file: { contents: 'b' } });
  });

  it('merges files across flat and nested paths', () => {
    const tree = buildWorkspaceFiles({
      'root.txt': 'r',
      'dir/nested.txt': 'n',
    });
    expect(tree['root.txt']).toEqual({ file: { contents: 'r' } });
    expect(tree.dir.directory['nested.txt']).toEqual({ file: { contents: 'n' } });
  });
});
