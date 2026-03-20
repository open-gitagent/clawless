/**
 * Default workspace files mounted into the WebContainer /workspace directory.
 */

export const DEFAULT_AGENT_YAML = `spec_version: "0.1.0"
name: my-agent
version: 1.0.0
model:
  preferred: ""   # set via API config panel
  fallback: []
tools: [cli, read, write, memory]
plugins:
  - "@gitagent/plugin-github"
  - "@gitagent/plugin-exa"
runtime:
  max_turns: 50
  timeout: 120
`;

export const DEFAULT_SOUL_MD = `# Agent Soul

You are a helpful, thoughtful AI assistant running inside ClawLess.
You can read and write files, run commands, and remember things.
`;

export const DEFAULT_RULES_MD = `# Agent Rules

1. Be concise and accurate.
2. Ask for clarification before taking irreversible actions.
3. Prefer small, focused changes over large rewrites.
4. Always explain what you are doing and why.
`;

export const DEFAULT_MEMORY_MD = `# Memory Index

No memories saved yet.
`;

/**
 * Node.js script that acts as a git stub.
 * npm will create node_modules/.bin/git → ../../git-stub.js with execute bit set.
 */
export const GIT_STUB_JS = `#!/usr/bin/env node
const [,, cmd, ...args] = process.argv;
if (cmd === 'init') {
  const fs = require('fs');
  if (!fs.existsSync('.git')) {
    fs.mkdirSync('.git/objects', { recursive: true });
    fs.mkdirSync('.git/refs/heads', { recursive: true });
    fs.writeFileSync('.git/HEAD', 'ref: refs/heads/main\\n');
    fs.writeFileSync('.git/config', '[core]\\n\\trepositoryformatversion = 0\\n\\tbare = false\\n');
  }
  console.log('Initialized empty Git repository in ' + process.cwd() + '/.git/');
} else if (cmd === '--version' || cmd === 'version') {
  console.log('git version 2.39.0');
} else if (cmd === 'rev-parse') {
  if (args.includes('--show-toplevel')) process.stdout.write(process.cwd() + '\\n');
  else process.stdout.write('\\n');
}
// add, commit, status, log, etc. silently succeed (exit 0)
process.exit(0);
`;

/** Returns the FileSystem tree to mount under /workspace inside WebContainer. */
export function buildWorkspaceFiles(extra?: Record<string, string>) {
  const tree: Record<string, any> = {
    'agent.yaml': { file: { contents: DEFAULT_AGENT_YAML } },
    'SOUL.md':    { file: { contents: DEFAULT_SOUL_MD } },
    'RULES.md':   { file: { contents: DEFAULT_RULES_MD } },
    'memory': {
      directory: {
        'MEMORY.md': { file: { contents: DEFAULT_MEMORY_MD } },
      },
    },
  };

  // Merge user-provided flat files (e.g. 'src/index.ts': '...')
  if (extra) {
    for (const [path, content] of Object.entries(extra)) {
      const parts = path.split('/');
      let node = tree;
      for (let i = 0; i < parts.length - 1; i++) {
        if (!node[parts[i]]) node[parts[i]] = { directory: {} };
        node = node[parts[i]].directory;
      }
      node[parts[parts.length - 1]] = { file: { contents: content } };
    }
  }

  return tree;
}

/** Returns the inner-container package.json that requests gitclaw. */
export function buildContainerPackageJson(extraDeps?: Record<string, string>) {
  return JSON.stringify({
    name: 'gitclaw-workspace',
    version: '1.0.0',
    private: true,
    // npm creates node_modules/.bin/git → ../../git-stub.js with execute bit
    bin: { git: './git-stub.js' },
    dependencies: {
      gitclaw: '1.1.4',
      ...extraDeps,
    },
    // baileys has a git-SSH dep (libsignal-node) unreachable in WebContainer
    overrides: {
      'baileys': 'npm:is-number@7.0.0',
    },
  }, null, 2);
}
