import { describe, it, expect } from 'vitest';
import { TemplateRegistry, GITCLAW_TEMPLATE, resolveTemplate } from './templates.js';

describe('TemplateRegistry', () => {
  it('has gitclaw by default', () => {
    expect(new TemplateRegistry().has('gitclaw')).toBe(true);
  });

  it('registers custom templates', () => {
    const reg = new TemplateRegistry();
    reg.register({ name: 'custom' });
    expect(reg.get('custom')?.name).toBe('custom');
  });
});

describe('GITCLAW_TEMPLATE', () => {
  it('has configRequired:true and workspace files', () => {
    expect(GITCLAW_TEMPLATE.configRequired).toBe(true);
    expect(GITCLAW_TEMPLATE.workspace?.['agent.yaml']).toContain('spec_version');
  });
});

describe('resolveTemplate', () => {
  const reg = new TemplateRegistry();
  it('defaults to gitclaw', () => expect(resolveTemplate(undefined, reg).name).toBe('gitclaw'));
  it('throws for unknown name', () => expect(() => resolveTemplate('nope', reg)).toThrow());
});
