import { describe, it, expect } from 'vitest';
import { buildContainerPackageJson } from './workspace.js';

describe('buildContainerPackageJson', () => {
  it('derives deps from AgentConfig', () => {
    const pkg = JSON.parse(buildContainerPackageJson({ package: 'gitclaw', version: '1.1.4', entry: 'dist/index.js' }));
    expect(pkg.dependencies.gitclaw).toBe('1.1.4');
  });

  it('defaults version to latest', () => {
    const pkg = JSON.parse(buildContainerPackageJson({ package: 'openclaw', entry: 'x.mjs' }));
    expect(pkg.dependencies.openclaw).toBe('latest');
  });

  it('produces empty deps for agent:false', () => {
    const pkg = JSON.parse(buildContainerPackageJson(false));
    expect(pkg.dependencies).toEqual({});
  });

  it('merges extraDeps', () => {
    const pkg = JSON.parse(buildContainerPackageJson({ package: 'a', entry: 'x' }, { lodash: '4' }));
    expect(pkg.dependencies).toEqual({ a: 'latest', lodash: '4' });
  });
});
