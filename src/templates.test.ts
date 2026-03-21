import { describe, it, expect } from 'vitest';
import {
  TemplateRegistry,
  GITCLAW_TEMPLATE,
  resolveTemplate,
  mergeTemplateWithOptions,
  parseTemplateYaml,
  type ContainerTemplate,
} from './templates.js';

// ─── TemplateRegistry ────────────────────────────────────────────────────────

describe('TemplateRegistry', () => {
  it('seeds gitclaw by default', () => {
    const reg = new TemplateRegistry();
    expect(reg.has('gitclaw')).toBe(true);
    expect(reg.list()).toContain('gitclaw');
  });

  it('registers and retrieves a custom template', () => {
    const reg = new TemplateRegistry();
    reg.register({ name: 'custom', description: 'test' });
    expect(reg.get('custom')?.description).toBe('test');
  });

  it('overwrites existing template on re-register', () => {
    const reg = new TemplateRegistry();
    reg.register({ name: 'gitclaw', description: 'overridden' });
    expect(reg.get('gitclaw')?.description).toBe('overridden');
  });

  it('exposes all templates via all getter', () => {
    const reg = new TemplateRegistry();
    expect(reg.all.size).toBeGreaterThanOrEqual(1);
    expect(reg.all.get('gitclaw')).toBeDefined();
  });
});

// ─── GITCLAW_TEMPLATE ────────────────────────────────────────────────────────

describe('GITCLAW_TEMPLATE', () => {
  it('has configRequired:true', () => {
    expect(GITCLAW_TEMPLATE.configRequired).toBe(true);
  });

  it('includes workspace files for agent.yaml, SOUL.md, RULES.md, memory/MEMORY.md', () => {
    const ws = GITCLAW_TEMPLATE.workspace!;
    expect(ws['agent.yaml']).toContain('spec_version');
    expect(ws['SOUL.md']).toContain('Agent Soul');
    expect(ws['RULES.md']).toContain('Agent Rules');
    expect(ws['memory/MEMORY.md']).toContain('Memory Index');
  });

  it('targets gitclaw package at version 1.1.4', () => {
    const agent = GITCLAW_TEMPLATE.agent;
    expect(agent).not.toBe(false);
    expect((agent as any).package).toBe('gitclaw');
    expect((agent as any).version).toBe('1.1.4');
  });
});

// ─── resolveTemplate ─────────────────────────────────────────────────────────

describe('resolveTemplate', () => {
  it('defaults to gitclaw when undefined', () => {
    expect(resolveTemplate(undefined, new TemplateRegistry()).name).toBe('gitclaw');
  });

  it('resolves by name string', () => {
    expect(resolveTemplate('gitclaw', new TemplateRegistry()).name).toBe('gitclaw');
  });

  it('throws for unknown name with registered names in message', () => {
    expect(() => resolveTemplate('nope', new TemplateRegistry())).toThrow(/Unknown template.*gitclaw/);
  });

  it('returns object template directly', () => {
    const inline: ContainerTemplate = { name: 'inline' };
    expect(resolveTemplate(inline, new TemplateRegistry())).toBe(inline);
  });
});

// ─── mergeTemplateWithOptions ────────────────────────────────────────────────

describe('mergeTemplateWithOptions', () => {
  const base: ContainerTemplate = {
    name: 'test',
    agent: { package: 'test-pkg', entry: 'index.js' },
    workspace: { 'a.txt': 'a' },
    services: { lodash: '4' },
    env: { FOO: 'bar' },
    startupScript: 'echo hi',
  };

  it('uses template agent when options.agent is undefined', () => {
    const result = mergeTemplateWithOptions(base, {});
    expect((result.agent as any).package).toBe('test-pkg');
  });

  it('options.agent=false overrides template agent', () => {
    const result = mergeTemplateWithOptions(base, { agent: false });
    expect(result.agent).toBe(false);
  });

  it('merges workspace per-key (options override)', () => {
    const result = mergeTemplateWithOptions(base, { workspace: { 'a.txt': 'overridden', 'b.txt': 'new' } });
    expect(result.workspace).toEqual({ 'a.txt': 'overridden', 'b.txt': 'new' });
  });

  it('merges env per-key', () => {
    const result = mergeTemplateWithOptions(base, { env: { BAZ: 'qux' } });
    expect(result.env).toEqual({ FOO: 'bar', BAZ: 'qux' });
  });

  it('options.startupScript overrides template', () => {
    const result = mergeTemplateWithOptions(base, { startupScript: 'echo bye' });
    expect(result.startupScript).toBe('echo bye');
  });

  it('falls back to template startupScript when options omits it', () => {
    const result = mergeTemplateWithOptions(base, {});
    expect(result.startupScript).toBe('echo hi');
  });

  it('deduplicates tabs by id with options winning', () => {
    const tplTab = { id: 'x', label: 'Template', render: '' };
    const optTab = { id: 'x', label: 'Options', render: '' };
    const result = mergeTemplateWithOptions(
      { ...base, tabs: [tplTab] },
      { tabs: [optTab] },
    );
    expect(result.tabs).toHaveLength(1);
    expect(result.tabs![0].label).toBe('Options');
  });
});

// ─── parseTemplateYaml ───────────────────────────────────────────────────────

describe('parseTemplateYaml', () => {
  it('parses minimal template with name only', () => {
    const tpl = parseTemplateYaml('name: my-template');
    expect(tpl.name).toBe('my-template');
  });

  it('throws when name is missing', () => {
    expect(() => parseTemplateYaml('description: no name here')).toThrow(/must include a "name"/);
  });

  it('strips quotes from values', () => {
    const tpl = parseTemplateYaml('name: "quoted-name"\ndescription: \'single-quoted\'');
    expect(tpl.name).toBe('quoted-name');
    expect(tpl.description).toBe('single-quoted');
  });

  it('skips comments and blank lines', () => {
    const tpl = parseTemplateYaml('# comment\n\nname: test\n# another');
    expect(tpl.name).toBe('test');
  });

  it('parses agent: false', () => {
    const tpl = parseTemplateYaml('name: test\nagent: false');
    expect(tpl.agent).toBe(false);
  });

  it('parses nested agent block', () => {
    const yaml = `name: test
agent:
  package: my-pkg
  version: 2.0.0
  entry: dist/main.js
  args: ["--dir", "/workspace"]`;
    const tpl = parseTemplateYaml(yaml);
    const agent = tpl.agent as any;
    expect(agent.package).toBe('my-pkg');
    expect(agent.version).toBe('2.0.0');
    expect(agent.entry).toBe('dist/main.js');
    expect(agent.args).toEqual(['--dir', '/workspace']);
  });

  it('parses agent env block', () => {
    const yaml = `name: test
agent:
  package: pkg
  entry: x.js
  env:
    FOO: bar
    BAZ: qux`;
    const tpl = parseTemplateYaml(yaml);
    const agent = tpl.agent as any;
    expect(agent.env).toEqual({ FOO: 'bar', BAZ: 'qux' });
  });

  it('parses workspace record section', () => {
    const yaml = `name: test
workspace:
  readme.md: hello
  config.json: "{}"`;
    const tpl = parseTemplateYaml(yaml);
    expect(tpl.workspace).toEqual({ 'readme.md': 'hello', 'config.json': '{}' });
  });

  it('parses block scalar values with |', () => {
    const yaml = `name: test
workspace:
  script.sh: |
    #!/bin/bash
    echo hello`;
    const tpl = parseTemplateYaml(yaml);
    expect(tpl.workspace!['script.sh']).toContain('#!/bin/bash');
    expect(tpl.workspace!['script.sh']).toContain('echo hello');
  });

  it('parses startupScript scalar', () => {
    const tpl = parseTemplateYaml('name: test\nstartupScript: "npm run setup"');
    expect(tpl.startupScript).toBe('npm run setup');
  });
});
