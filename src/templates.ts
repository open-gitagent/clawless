// ─── Template System for ClawContainer ──────────────────────────────────────

import type { AgentConfig, ClawContainerOptions, TabDefinition } from './types.js';

/** A named, reusable container configuration preset. */
export interface ContainerTemplate {
  name: string;
  description?: string;
  agent?: AgentConfig | false;
  workspace?: Record<string, string>;
  services?: Record<string, string>;
  env?: Record<string, string>;
  startupScript?: string;
  tabs?: TabDefinition[];
}

/** Built-in gitclaw template — mirrors the previous hardcoded defaults. */
export const GITCLAW_TEMPLATE: ContainerTemplate = {
  name: 'gitclaw',
  description: 'Default gitclaw agent template',
  agent: {
    package: 'gitclaw',
    version: '1.1.4',
    entry: 'dist/index.js',
    args: ['--dir', '<home>/workspace'],
  },
};

/** Native deps that cannot run inside WebContainer's WASM sandbox. */
const OPENCLAW_NATIVE_OVERRIDES: Record<string, string> = {
  'sharp': 'npm:is-number@7.0.0',
  'playwright-core': 'npm:is-number@7.0.0',
  '@lydell/node-pty': 'npm:is-number@7.0.0',
  'sqlite-vec': 'npm:is-number@7.0.0',
  'node-llama-cpp': 'npm:is-number@7.0.0',
  '@napi-rs/canvas': 'npm:is-number@7.0.0',
  'pdfjs-dist': 'npm:is-number@7.0.0',
  // baileys' libsignal dep uses a git-SSH URL unreachable in WebContainer
  'libsignal': 'npm:is-number@7.0.0',
};

/** Built-in openclaw template — OpenClaw personal AI agent in WebContainer. */
export const OPENCLAW_TEMPLATE: ContainerTemplate = {
  name: 'openclaw',
  description: 'OpenClaw personal AI agent template',
  agent: {
    package: 'openclaw',
    version: '2026.3.13',
    entry: '../../openclaw-start.mjs',
    args: [],
    env: {
      OPENCLAW_PROFILE: 'default',
      OPENCLAW_GATEWAY_MODE: 'local',
      OPENCLAW_DISABLE_BONJOUR: '1',
      OPENCLAW_GATEWAY_TOKEN: 'clawless-local-token',
    },
    overrides: OPENCLAW_NATIVE_OVERRIDES,
  },
  startupScript: 'node ../openclaw-setup.cjs',
  workspace: {
    'IDENTITY.md': '# Identity\n\nYou are a helpful AI assistant running inside ClawLess.\n',
    'USER.md': '# User\n\nDefault user.\n',
    'TOOLS.md': '# Tools\n\nNo custom tools configured.\n',
  },
};

// ─── Template Registry ────────────────────────────────────────────────────────

export class TemplateRegistry {
  private templates = new Map<string, ContainerTemplate>();

  constructor() {
    // Seed with built-in templates
    this.register(GITCLAW_TEMPLATE);
    this.register(OPENCLAW_TEMPLATE);
  }

  register(template: ContainerTemplate): void {
    this.templates.set(template.name, template);
  }

  get(name: string): ContainerTemplate | undefined {
    return this.templates.get(name);
  }

  has(name: string): boolean {
    return this.templates.has(name);
  }

  list(): string[] {
    return [...this.templates.keys()];
  }

  /** Expose the internal map (read-only use). */
  get all(): Map<string, ContainerTemplate> {
    return this.templates;
  }
}

// ─── Resolution & merging ─────────────────────────────────────────────────────

/**
 * Resolve a template input to a concrete ContainerTemplate.
 * - string → lookup by name in registry
 * - object → use directly
 * - undefined → default to 'gitclaw'
 */
export function resolveTemplate(
  input: string | ContainerTemplate | undefined,
  registry: TemplateRegistry,
): ContainerTemplate {
  if (input === undefined) {
    return registry.get('gitclaw')!;
  }
  if (typeof input === 'string') {
    const tpl = registry.get(input);
    if (!tpl) throw new Error(`Unknown template: "${input}". Registered: ${registry.list().join(', ')}`);
    return tpl;
  }
  return input;
}

/**
 * Merge a resolved template with user-supplied ClawContainerOptions.
 * Options win for conflicts. Record fields (workspace, services, env) are merged per-key.
 * Scalar fields (agent, startupScript) are replaced when present in options.
 */
export function mergeTemplateWithOptions(
  template: ContainerTemplate,
  options: ClawContainerOptions,
): ClawContainerOptions {
  const merged: ClawContainerOptions = {};

  // Agent: options.agent takes precedence if explicitly set (including false)
  if (options.agent !== undefined) {
    merged.agent = options.agent;
  } else if (template.agent !== undefined) {
    merged.agent = template.agent;
  }

  // Record fields: template first, options overlay
  merged.workspace = { ...template.workspace, ...options.workspace };
  merged.services = { ...template.services, ...options.services };
  merged.env = { ...template.env, ...options.env };

  // Scalar: options win
  merged.startupScript = options.startupScript ?? template.startupScript;

  // Tabs: concat template tabs + options tabs (dedup by id, options win)
  const templateTabs = template.tabs ?? [];
  const optionTabs = options.tabs ?? [];
  if (templateTabs.length > 0 || optionTabs.length > 0) {
    const tabMap = new Map<string, TabDefinition>();
    for (const t of templateTabs) tabMap.set(t.id, t);
    for (const t of optionTabs) tabMap.set(t.id, t);
    merged.tabs = [...tabMap.values()];
  }

  // Pass through non-template fields
  if (options.plugins) merged.plugins = options.plugins;

  return merged;
}

// ─── YAML Parsing (hand-rolled, no deps) ──────────────────────────────────────

/**
 * Parse a YAML string into a ContainerTemplate.
 * Supports the simple subset needed for template definitions:
 * - Top-level scalar keys (name, description, startupScript)
 * - Top-level `agent:` with nested scalar keys + args/env
 * - Top-level Record sections (workspace, services, env)
 * - `agent: false` to skip agent launch
 */
export function parseTemplateYaml(yaml: string): ContainerTemplate {
  const lines = yaml.split('\n');
  const template: ContainerTemplate = { name: '' };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    // Skip blank lines and comments
    if (trimmed === '' || trimmed.startsWith('#')) { i++; continue; }

    // Top-level key: value
    const kvMatch = trimmed.match(/^(\w+):\s*(.*)$/);
    if (!kvMatch) { i++; continue; }

    const key = kvMatch[1];
    const value = kvMatch[2].trim();

    if (key === 'name') {
      template.name = stripQuotes(value);
      i++;
    } else if (key === 'description') {
      template.description = stripQuotes(value);
      i++;
    } else if (key === 'startupScript') {
      template.startupScript = stripQuotes(value);
      i++;
    } else if (key === 'agent') {
      if (value === 'false') {
        template.agent = false;
        i++;
      } else if (value === '' || value === undefined) {
        // Nested agent block
        const agent: AgentConfig = { package: '', entry: '' };
        i++;
        while (i < lines.length) {
          const aLine = lines[i];
          const aTrimmed = aLine.trim();
          if (aTrimmed === '' || aTrimmed.startsWith('#')) { i++; continue; }
          // Check if we've left the agent block (no leading whitespace)
          if (/^\S/.test(aLine)) break;

          const aKv = aTrimmed.match(/^(\w+):\s*(.*)$/);
          if (!aKv) { i++; continue; }

          const aKey = aKv[1];
          const aVal = aKv[2].trim();

          if (aKey === 'package') { agent.package = stripQuotes(aVal); i++; }
          else if (aKey === 'version') { agent.version = stripQuotes(aVal); i++; }
          else if (aKey === 'entry') { agent.entry = stripQuotes(aVal); i++; }
          else if (aKey === 'args') {
            agent.args = parseYamlInlineArray(aVal);
            i++;
          } else if (aKey === 'env') {
            // Nested env block under agent
            agent.env = {};
            i++;
            while (i < lines.length) {
              const eLine = lines[i];
              const eTrimmed = eLine.trim();
              if (eTrimmed === '' || eTrimmed.startsWith('#')) { i++; continue; }
              // Must be indented deeper than agent keys (at least 4 spaces)
              const indent = eLine.length - eLine.trimStart().length;
              if (indent < 4) break;
              const eKv = eTrimmed.match(/^(\w+):\s*(.*)$/);
              if (eKv) {
                agent.env[eKv[1]] = stripQuotes(eKv[2].trim());
              }
              i++;
            }
          } else { i++; }
        }
        template.agent = agent;
      } else { i++; }
    } else if (key === 'workspace' || key === 'services' || key === 'env') {
      const record: Record<string, string> = {};
      i++;
      while (i < lines.length) {
        const rLine = lines[i];
        const rTrimmed = rLine.trim();
        if (rTrimmed === '' || rTrimmed.startsWith('#')) { i++; continue; }
        if (/^\S/.test(rLine)) break;

        // key: value or key: | (block scalar)
        const rKv = rTrimmed.match(/^(.+?):\s*(.*)$/);
        if (!rKv) { i++; continue; }

        const rKey = rKv[1].trim();
        const rVal = rKv[2].trim();

        if (rVal === '|') {
          // Block scalar — collect indented lines
          i++;
          const blockLines: string[] = [];
          const baseIndent = i < lines.length ? (lines[i].length - lines[i].trimStart().length) : 4;
          while (i < lines.length) {
            const bLine = lines[i];
            if (bLine.trim() === '') { blockLines.push(''); i++; continue; }
            const bIndent = bLine.length - bLine.trimStart().length;
            if (bIndent < baseIndent) break;
            blockLines.push(bLine.slice(baseIndent));
            i++;
          }
          record[rKey] = blockLines.join('\n') + '\n';
        } else {
          record[rKey] = stripQuotes(rVal);
          i++;
        }
      }
      (template as any)[key] = record;
    } else {
      i++;
    }
  }

  if (!template.name) throw new Error('Template YAML must include a "name" field');
  return template;
}

/** Strip surrounding quotes from a YAML value. */
function stripQuotes(s: string): string {
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
}

/** Parse a YAML inline array like ["--dir", "<home>/workspace"] */
function parseYamlInlineArray(s: string): string[] {
  const trimmed = s.trim();
  if (!trimmed.startsWith('[') || !trimmed.endsWith(']')) return [];
  const inner = trimmed.slice(1, -1);
  return inner.split(',').map(item => stripQuotes(item.trim())).filter(Boolean);
}
