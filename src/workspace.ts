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

/**
 * Setup script that writes openclaw config and pre-generates device identity.
 * Runs as a CJS startup script before the agent launches.
 */
export const OPENCLAW_SETUP_SCRIPT = `
const fs = require("fs");
const path = require("path");
const home = process.env.HOME || "/root";
const dir = path.join(home, ".openclaw");

// Ensure directory exists
fs.mkdirSync(dir, { recursive: true });

// Write config — point agent workspace to /workspace so ClawLess file tree sees it
const config = {
  gateway: {
    mode: "local",
    auth: { token: "clawless-local-token" },
    http: { endpoints: { chatCompletions: { enabled: true } } }
  },
  agents: { defaults: { workspace: path.join(home, "workspace") } },
  discovery: { mdns: { mode: "off" } }
};
fs.writeFileSync(path.join(dir, "openclaw.json"), JSON.stringify(config, null, 2) + "\\n");
console.log("[setup] Wrote openclaw.json");

// Write a static device identity (crypto.generateKeyPairSync is broken in WebContainer)
// Path must match resolveDefaultIdentityPath(): ~/.openclaw/identity/device.json
const idDir = path.join(dir, "identity");
fs.mkdirSync(idDir, { recursive: true });
const idPath = path.join(idDir, "device.json");
if (!fs.existsSync(idPath)) {
  const data = {
    version: 1,
    deviceId: "aa0ef697bf8e01ef",
    publicKeyPem: "-----BEGIN PUBLIC KEY-----\\nMCowBQYDK2VwAyEA9WrKqHMOSXwyfx1cAy65VUoQvKlZ6ODIgrA7++NsW8k=\\n-----END PUBLIC KEY-----\\n",
    privateKeyPem: "-----BEGIN PRIVATE KEY-----\\nMC4CAQAwBQYDK2VwBCIEIBFOZhkEv+AzipXxQqvtHYAUjPQVGatt7iRZTtcA97Mc\\n-----END PRIVATE KEY-----\\n",
    createdAtMs: Date.now()
  };
  fs.writeFileSync(idPath, JSON.stringify(data, null, 2) + "\\n", { mode: 384 });
  console.log("[setup] Wrote static device identity");
}

`;

/**
 * OpenClaw TUI — starts gateway in background, then provides a streaming
 * chat interface with file change detection over the HTTP chat completions API.
 *
 * Features:
 * - SSE streaming for real-time response rendering
 * - Filesystem watcher to detect tool activity (file read/write/create)
 * - Spinner animation during agent "thinking" pauses
 * - Abort support (Ctrl+C cancels current request)
 * - /quit, /clear, /help commands
 */
export const OPENCLAW_START_SCRIPT = `
import { spawn } from 'node:child_process';
import { resolve, join } from 'node:path';
import { createInterface } from 'node:readline';
import { readFileSync, watch, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';

// ─── ANSI Colors (matching ClawLess theme) ──────────────────────────────────
const C = {
  reset: '\\x1b[0m', dim: '\\x1b[90m', bold: '\\x1b[1m',
  red: '\\x1b[31m', green: '\\x1b[32m', yellow: '\\x1b[33m',
  blue: '\\x1b[34m', magenta: '\\x1b[35m', cyan: '\\x1b[36m',
  bCyan: '\\x1b[96m', bYellow: '\\x1b[93m', bGreen: '\\x1b[92m',
  orange: '\\x1b[38;2;247;129;102m',
};

const clawBin = resolve(process.cwd(), 'node_modules/openclaw/openclaw.mjs');
const workspaceDir = resolve(process.cwd(), 'workspace');

// ─── Gateway Launch ─────────────────────────────────────────────────────────
const gw = spawn('node', [clawBin, 'gateway', 'run', '--bind', 'loopback', '--allow-unconfigured'], {
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env },
});
gw.stderr.on('data', (c) => process.stderr.write(c));

let launched = false;
gw.stdout.on('data', (chunk) => {
  const text = chunk.toString();
  if (!launched) process.stdout.write(C.dim + text + C.reset);
  if (!launched && text.includes('listening on')) {
    launched = true;
    setTimeout(startTui, 1500);
  }
});
gw.on('exit', (code) => {
  if (!launched) {
    process.stderr.write(C.red + '[openclaw] Gateway exited before ready (code ' + code + ')' + C.reset + '\\n');
    process.exit(code ?? 1);
  }
});

// ─── Helpers ────────────────────────────────────────────────────────────────
function getToken() {
  try {
    const cfg = JSON.parse(readFileSync(resolve(homedir(), '.openclaw/openclaw.json'), 'utf8'));
    return cfg?.gateway?.auth?.token || 'clawless-local-token';
  } catch { return 'clawless-local-token'; }
}

// ─── File Watcher ───────────────────────────────────────────────────────────
const fileChanges = [];
let changeFlushTimer = null;
let isStreaming = false;

function startFileWatcher() {
  try {
    watch(workspaceDir, { recursive: true }, (eventType, filename) => {
      if (!filename || filename.startsWith('node_modules') || filename.startsWith('.git')) return;
      fileChanges.push({ event: eventType, file: filename, time: Date.now() });
      clearTimeout(changeFlushTimer);
      changeFlushTimer = setTimeout(flushFileChanges, 800);
    });
  } catch {
    // fs.watch may not support recursive in WebContainer — fallback to polling
    let lastSnapshot = {};
    setInterval(() => {
      try {
        const snap = {};
        const scan = (dir, prefix) => {
          for (const e of readdirSync(dir)) {
            if (e === 'node_modules' || e === '.git') continue;
            const full = join(dir, e);
            const rel = prefix ? prefix + '/' + e : e;
            try {
              const st = statSync(full);
              if (st.isDirectory()) { scan(full, rel); continue; }
              snap[rel] = st.mtimeMs;
            } catch {}
          }
        };
        scan(workspaceDir, '');
        for (const [file, mtime] of Object.entries(snap)) {
          if (!lastSnapshot[file] || lastSnapshot[file] !== mtime) {
            if (Object.keys(lastSnapshot).length > 0) {
              fileChanges.push({ event: lastSnapshot[file] ? 'change' : 'rename', file, time: Date.now() });
            }
          }
        }
        lastSnapshot = snap;
        if (fileChanges.length > 0) {
          clearTimeout(changeFlushTimer);
          changeFlushTimer = setTimeout(flushFileChanges, 500);
        }
      } catch {}
    }, 3000);
  }
}

function flushFileChanges() {
  if (fileChanges.length === 0) return;
  const unique = [...new Set(fileChanges.map(c => c.file))];
  fileChanges.length = 0;
  if (!isStreaming) return; // only show during active responses
  const w = process.stdout.columns || 60;
  process.stdout.write('\\n');
  process.stdout.write(C.dim + '  ┌─ ' + C.cyan + '🔧 File Changes' + C.dim + ' ' + '─'.repeat(Math.max(0, w - 25)) + '┐' + C.reset + '\\n');
  for (const f of unique.slice(0, 10)) {
    const padded = f.length > w - 8 ? '…' + f.slice(-(w - 9)) : f;
    process.stdout.write(C.dim + '  │  ' + C.bCyan + padded + C.reset + '\\n');
  }
  if (unique.length > 10) {
    process.stdout.write(C.dim + '  │  … and ' + (unique.length - 10) + ' more' + C.reset + '\\n');
  }
  process.stdout.write(C.dim + '  └' + '─'.repeat(Math.max(0, w - 4)) + '┘' + C.reset + '\\n');
}

// ─── Spinner ────────────────────────────────────────────────────────────────
const spinFrames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
let spinTimer = null;
let spinIdx = 0;
let spinActive = false;

function startSpinner(label) {
  if (spinActive) return;
  spinActive = true;
  spinIdx = 0;
  spinTimer = setInterval(() => {
    const frame = spinFrames[spinIdx++ % spinFrames.length];
    process.stdout.write('\\r' + C.orange + frame + ' ' + C.dim + label + C.reset + '  ');
  }, 80);
}

function stopSpinner() {
  if (!spinActive) return;
  spinActive = false;
  clearInterval(spinTimer);
  process.stdout.write('\\r\\x1b[2K'); // clear spinner line
}

// ─── SSE Stream Parser ──────────────────────────────────────────────────────
async function* streamChat(messages, token, signal) {
  const res = await fetch('http://127.0.0.1:18789/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
    body: JSON.stringify({ model: 'openclaw', messages, stream: true }),
    signal,
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error('HTTP ' + res.status + ': ' + body.slice(0, 200));
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split('\\n');
    buf = lines.pop() || '';
    for (const line of lines) {
      const t = line.trim();
      if (!t || t.startsWith(':')) continue;
      if (t === 'data: [DONE]') return;
      if (t.startsWith('data: ')) {
        try {
          const json = JSON.parse(t.slice(6));
          const delta = json.choices?.[0]?.delta;
          const finish = json.choices?.[0]?.finish_reason;
          if (delta?.content) yield { type: 'content', text: delta.content };
          if (finish) yield { type: 'finish', reason: finish };
        } catch {}
      }
    }
  }
}

// ─── Main TUI ───────────────────────────────────────────────────────────────
async function startTui() {
  const token = getToken();
  const messages = [];
  let abortCtl = null;

  startFileWatcher();

  const w = process.stdout.columns || 80;
  process.stdout.write('\\n');
  process.stdout.write(C.dim + '─'.repeat(w) + C.reset + '\\n');
  process.stdout.write(C.orange + C.bold + '  🦞 OpenClaw Agent' + C.reset + C.dim + '  •  streaming chat with tool support' + C.reset + '\\n');
  process.stdout.write(C.dim + '  /help for commands  •  Ctrl+C to interrupt  •  /quit to exit' + C.reset + '\\n');
  process.stdout.write(C.dim + '─'.repeat(w) + C.reset + '\\n\\n');

  const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: C.green + C.bold + '❯ ' + C.reset });
  rl.prompt();

  rl.on('line', async (line) => {
    const input = line.trim();
    if (!input) { rl.prompt(); return; }

    // Commands
    if (input === '/quit' || input === '/exit') { gw.kill(); process.exit(0); }
    if (input === '/clear') { messages.length = 0; process.stdout.write(C.dim + '(conversation cleared)' + C.reset + '\\n'); rl.prompt(); return; }
    if (input === '/help') {
      process.stdout.write([
        C.cyan + '  /quit' + C.dim + '   — exit',
        C.cyan + '  /clear' + C.dim + '  — clear conversation',
        C.cyan + '  /help' + C.dim + '   — show commands',
        C.cyan + '  Ctrl+C' + C.dim + ' — interrupt current response',
        '',
      ].join('\\n') + C.reset + '\\n');
      rl.prompt(); return;
    }

    messages.push({ role: 'user', content: input });
    process.stdout.write('\\n');

    // Stream the response
    abortCtl = new AbortController();
    isStreaming = true;
    let reply = '';
    let lastChunkAt = Date.now();
    let thinkingShown = false;

    // Thinking timeout — show spinner if no content for 3s
    const thinkingCheck = setInterval(() => {
      if (Date.now() - lastChunkAt > 3000 && !thinkingShown) {
        thinkingShown = true;
        startSpinner('thinking…');
      }
    }, 500);

    try {
      process.stdout.write(C.orange + '🦞 ' + C.reset);
      for await (const evt of streamChat(messages, token, abortCtl.signal)) {
        if (evt.type === 'content') {
          if (thinkingShown) { stopSpinner(); thinkingShown = false; flushFileChanges(); }
          lastChunkAt = Date.now();
          reply += evt.text;
          process.stdout.write(evt.text);
        }
      }
    } catch (err) {
      if (err.name === 'AbortError') {
        process.stdout.write('\\n' + C.dim + '(interrupted)' + C.reset);
      } else {
        process.stdout.write('\\n' + C.red + '[error] ' + err.message + C.reset);
      }
    } finally {
      stopSpinner();
      clearInterval(thinkingCheck);
      isStreaming = false;
      abortCtl = null;
      if (reply) messages.push({ role: 'assistant', content: reply });
      // Flush any remaining file changes
      setTimeout(() => { flushFileChanges(); process.stdout.write('\\n\\n'); rl.prompt(); }, 300);
    }
  });

  // Ctrl+C handling
  rl.on('SIGINT', () => {
    if (abortCtl) {
      abortCtl.abort();
    } else {
      process.stdout.write('\\n' + C.dim + '(press /quit to exit)' + C.reset + '\\n');
      rl.prompt();
    }
  });

  rl.on('close', () => { gw.kill(); process.exit(0); });
}
`.trim();

/**
 * Build the register script (--import entrypoint) that installs the stub loader hooks.
 */
export function buildStubLoaderRegister(_packages: string[]): string {
  return `import { register } from 'node:module';
register('./stub-loader-hooks.mjs', import.meta.url);
`;
}

/**
 * Build ESM loader hooks that intercept imports of stubbed native packages.
 *
 * resolve: any bare specifier matching a stubbed package (including deep paths
 *          like 'libsignal/src/curve.js') is redirected to a stub-noop: URL.
 * load:    stub-noop: URLs return a synthetic CJS module that explicitly defines
 *          every possible export name as undefined. We scan the consumer's
 *          node_modules to discover required names at startup.
 *
 * Uses format:'commonjs' so Node's cjs-module-lexer can statically detect
 * the "exports.NAME = undefined" assignments and expose them as ESM named exports.
 */
export function buildStubLoaderHooks(packages: string[]): string {
  // Build the raw regex pattern (as it would appear in new RegExp(pattern)):
  // import\s*\{([^}]+)\}\s*from\s*['"]((<pkgs>)(/[^'"]*)?)['"
  const escapedPkgs = packages.map(s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const rawPattern = `import\\s*\\{([^}]+)\\}\\s*from\\s*['"]((${ escapedPkgs.join('|') })(/[^'"]*)?)['"` + ']';
  // JSON.stringify will properly escape this for embedding in JS source
  const patternJson = JSON.stringify(rawPattern);

  return [
    'import { readFileSync, readdirSync, statSync } from "node:fs";',
    'import { join, resolve as pathResolve } from "node:path";',
    '',
    'const STUBBED = ' + JSON.stringify(packages) + ';',
    '',
    'function isStubbed(specifier) {',
    '  for (const pkg of STUBBED) {',
    '    if (specifier === pkg || specifier.startsWith(pkg + "/")) return true;',
    '  }',
    '  return false;',
    '}',
    '',
    '// Scan .js/.mjs files under node_modules for import names from stubbed packages.',
    'const exportNames = new Map();',
    'function scanDir(dir, depth) {',
    '  if (depth > 5) return;',
    '  try {',
    '    for (const entry of readdirSync(dir)) {',
    '      if (entry === ".cache" || entry === ".package-lock.json") continue;',
    '      const full = join(dir, entry);',
    '      try {',
    '        const st = statSync(full);',
    '        if (st.isDirectory()) { scanDir(full, depth + 1); continue; }',
    '        if (!entry.endsWith(".js") && !entry.endsWith(".mjs")) continue;',
    '        const src = readFileSync(full, "utf8");',
    '        const re = new RegExp(' + patternJson + ', "g");',
    '        let m;',
    '        while ((m = re.exec(src)) !== null) {',
    '          const spec = m[2];',
    '          const pkg = STUBBED.find(p => spec === p || spec.startsWith(p + "/"));',
    '          if (!pkg) continue;',
    '          if (!exportNames.has(pkg)) exportNames.set(pkg, new Set());',
    '          const names = m[1].split(",").map(n => n.trim().split(/\\s+as\\s+/)[0].trim()).filter(Boolean);',
    '          for (const n of names) exportNames.get(pkg).add(n);',
    '        }',
    '      } catch {}',
    '    }',
    '  } catch {}',
    '}',
    '',
    'const root = pathResolve(process.cwd());',
    'scanDir(join(root, "node_modules"), 0);',
    '',
    '// Pre-build CJS source for each stubbed package',
    'const cjsSources = new Map();',
    'for (const pkg of STUBBED) {',
    '  const names = exportNames.get(pkg) || new Set();',
    '  const lines = ["\\\"use strict\\\";", "module.exports.__esModule = true;", "module.exports.default = module.exports;"];',
    '  for (const name of names) {',
    '    lines.push("module.exports." + name + " = undefined;");',
    '  }',
    '  cjsSources.set(pkg, lines.join("\\n"));',
    '}',
    '',
    'export async function resolve(specifier, context, nextResolve) {',
    '  if (isStubbed(specifier)) {',
    '    const pkg = STUBBED.find(p => specifier === p || specifier.startsWith(p + "/"));',
    '    return { shortCircuit: true, url: "stub-noop:///" + encodeURIComponent(pkg) };',
    '  }',
    '  return nextResolve(specifier, context);',
    '}',
    '',
    'export async function load(url, context, nextLoad) {',
    '  if (url.startsWith("stub-noop:///")) {',
    '    const pkg = decodeURIComponent(url.slice("stub-noop:///".length));',
    '    return {',
    '      shortCircuit: true,',
    '      format: "commonjs",',
    '      source: cjsSources.get(pkg) || "\\\"use strict\\\"; module.exports = {};",',
    '    };',
    '  }',
    '  return nextLoad(url, context);',
    '}',
  ].join('\n');
}

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

/** Returns the inner-container package.json for the resolved agent. */
export function buildContainerPackageJson(opts?: {
  agentPackage?: string;
  agentVersion?: string;
  extraDeps?: Record<string, string>;
  extraOverrides?: Record<string, string>;
}) {
  const pkg = opts?.agentPackage ?? 'gitclaw';
  const ver = opts?.agentVersion ?? '1.1.4';
  return JSON.stringify({
    name: `${pkg}-workspace`,
    version: '1.0.0',
    private: true,
    // npm creates node_modules/.bin/git → ../../git-stub.js with execute bit
    bin: { git: './git-stub.js' },
    dependencies: {
      [pkg]: ver,
      ...opts?.extraDeps,
    },
    overrides: {
      // baileys has a git-SSH dep (libsignal-node) unreachable in WebContainer
      'baileys': 'npm:is-number@7.0.0',
      ...opts?.extraOverrides,
    },
  }, null, 2);
}
