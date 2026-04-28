# ClawLess Documentation

## Table of Contents

- [Architecture Overview](#architecture-overview)
- [SDK API Reference](#sdk-api-reference)
  - [ClawContainer Class](#clawcontainer-class)
- [Plugin System](#plugin-system)
  - [ClawContainerPlugin Interface](#clawcontainerplugin-interface)
  - [TabDefinition](#tabdefinition)
- [Template System](#template-system)
- [Policy Engine](#policy-engine)
  - [Policy Structure](#policy-structure)
  - [PolicyAction Types](#policyaction-types)
  - [Rules](#rules)
  - [YAML Format](#yaml-format)
  - [Glob Matching](#glob-matching)
  - [PolicyEngine Methods](#policyengine-methods)
- [Audit Logging](#audit-logging)
  - [AuditEntry](#auditentry)
  - [AuditLog Methods](#auditlog-methods)
- [Git Service](#git-service)
  - [GitService](#gitservice)
  - [Supported URL Formats](#supported-url-formats)
- [Network Interception](#network-interception)
  - [Browser-side (net-intercept.ts)](#browser-side-net-interceptts)
  - [Container-side (network-hook.ts)](#container-side-network-hookts)
- [Configuration](#configuration)
  - [Environment Variables](#environment-variables)
  - [Supported Providers & Models](#supported-providers--models)
  - [LocalStorage Persistence](#localstorage-persistence)
- [Security Model](#security-model)

## Architecture Overview

ClawLess is a browser-based AI agent container runtime built on WebContainers. Data flow:

```
User Input → ClawContainer (SDK) → ContainerManager → WebContainer
                                  → PolicyEngine (enforce)
                                  → AuditLog (record)
                                  → GitService (sync)
                                  → TerminalManager (display)
                                  → UIManager → PluginManager
                                  → EventEmitter → Plugins
```

## SDK API Reference

### ClawContainer Class

Constructor: `new ClawContainer(selector: string, options?: ClawContainerOptions)`

**ClawContainerOptions:**

```typescript
interface ClawContainerOptions {
  agent?: AgentConfig | false;
  workspace?: Record<string, string>;
  services?: Record<string, string>;
  env?: Record<string, string>;
  startupScript?: string;
  template?: string | ContainerTemplate;
  plugins?: ClawContainerPlugin[];
  tabs?: TabDefinition[];
  runtime?: 'webcontainer' | 'nodepod';  // default: 'webcontainer'
}
```

**Runtime backends:**

- `'webcontainer'` (default): StackBlitz WebContainers (WASM Linux userspace). Best compatibility, requires COOP/COEP headers, 2–5 s cold start.
- `'nodepod'`: [@scelar/nodepod](https://github.com/ScelarOrg/Nodepod) (Web Workers + Node polyfills). MIT + Commons Clause, ~100 ms cold start, no COOP/COEP requirement. Vite users must add `nodepod()` to plugins.

**Lifecycle Methods:**

- `start(): Promise<void>` - Boot container, install deps, configure env, launch agent
- `stop(): Promise<void>` - Stop container and dispatch onDestroy to plugins
- `restart(): Promise<void>` - Stop then start

**Command Execution:**

- `exec(cmd: string): Promise<string>` - Execute command and return output
- `shell(): Promise<void>` - Open interactive shell
- `sendInput(data: string): Promise<void>` - Send input to running process

**File System (cc.fs):**

- `read(path): Promise<string>`
- `write(path, content): Promise<void>`
- `list(dir?): Promise<string[]>`
- `mkdir(path): Promise<void>`
- `remove(path): Promise<void>`

**Git (cc.git):**

- `clone(url, token): Promise<void>`
- `push(message?): Promise<string>`

**Events:**

```typescript
type ClawContainerEvents = {
  ready: [];
  error: [error: Error];
  status: [status: string];
  'file.change': [path: string];
  'process.exit': [code: number];
  'server.ready': [port: number, url: string];
  log: [entry: AuditEntry];
};
```

- `on(event, fn)`, `off(event, fn)`, `once(event, fn)`

**Plugin & Tab:**

- `use(plugin: ClawContainerPlugin): void`
- `addTab(def: TabDefinition): void`
- `removeTab(id: string): void`

**Static:**

- `ClawContainer.registerTemplate(template): void`
- `ClawContainer.parseTemplate(yaml): ContainerTemplate`

## Plugin System

### ClawContainerPlugin Interface

```typescript
interface ClawContainerPlugin {
  name: string;
  services?: Record<string, string>;
  workspace?: Record<string, string>;
  env?: Record<string, string>;
  tabs?: TabDefinition[];
  onInit?(cc: ClawContainerSDK): void;
  onReady?(cc: ClawContainerSDK): void;
  onDestroy?(cc: ClawContainerSDK): void;
}
```

Lifecycle: onInit (after register, before boot) → onReady (after container ready) → onDestroy (on stop).
Plugins can merge services, workspace files, env vars, and custom tabs.

### TabDefinition

```typescript
interface TabDefinition {
  id: string;
  label: string;
  render: string | ((container: HTMLDivElement) => void);
}
```

## Template System

Templates pre-configure agent, workspace, services, env, tabs.

```typescript
interface ContainerTemplate {
  name: string;
  description?: string;
  agent?: AgentConfig | false;
  workspace?: Record<string, string>;
  services?: Record<string, string>;
  env?: Record<string, string>;
  startupScript?: string;
  tabs?: TabDefinition[];
}
```

Built-in template: `gitclaw` (gitclaw@1.1.4 agent).

YAML template format example:

```yaml
name: my-template
description: My custom template
agent:
  package: gitclaw
  version: 1.1.4
  entry: dist/index.js
  args: ["--dir", "<home>/workspace"]
workspace:
  'src/index.ts': |
    export function hello() {}
services:
  lodash: "4.17.21"
env:
  DEBUG: "true"
startupScript: npm run build
```

Register via `ClawContainer.registerTemplate(template)` or pass template name/object in options.

## Policy Engine

YAML-based guardrails for controlling agent behavior.

### Policy Structure

```typescript
interface Policy {
  version: '1';
  mode: 'allow-all' | 'deny-all';
  files: { read: FileRule[]; write: FileRule[] };
  processes: ProcessRule[];
  ports: PortRule[];
  tools: ToolRule[];
  limits: RuntimeLimits;
}
```

### PolicyAction Types

`file.read`, `file.write`, `process.spawn`, `server.bind`, `env.configure`, `tool.use`, `git.clone`, `git.push`

### Rules

```typescript
interface FileRule { pattern: string; allow: boolean; }
interface ProcessRule { pattern: string; allow: boolean; }
interface PortRule { port: number | '*'; allow: boolean; }
interface ToolRule { name: string; allow: boolean; }
interface RuntimeLimits {
  maxFileSize: number;    // default 10MB
  maxProcesses: number;   // default 10
  maxTurns: number;       // default 50
  timeoutSec: number;     // default 120
}
```

### YAML Format

```yaml
version: "1"
mode: allow-all
files:
  read:
    - pattern: "workspace/**"
      allow: true
    - pattern: "node_modules/**"
      allow: false
  write:
    - pattern: "workspace/**"
      allow: true
processes:
  - pattern: "npm *"
    allow: true
  - pattern: "rm -rf *"
    allow: false
ports:
  - port: "*"
    allow: true
tools:
  - name: "*"
    allow: true
limits:
  maxFileSize: 10485760
  maxProcesses: 10
  maxTurns: 50
  timeoutSec: 120
```

### Glob Matching

Supports `*` (single segment), `**` (any depth), `?` (single char).

### PolicyEngine Methods

- `check(action, subject, meta?): CheckResult` - Check without throwing
- `enforce(action, subject, meta?): CheckResult` - Throws PolicyDeniedError if denied
- `loadPolicy(policy)`, `getPolicy()`, `toYaml()`, `static fromYaml(yaml)`

## Audit Logging

### AuditEntry

```typescript
interface AuditEntry {
  timestamp: string;          // ISO8601
  event: AuditEvent;
  detail: string;
  meta?: Record<string, unknown>;
  source?: AuditSource;
  level?: AuditLevel;
}
```

**Sources:** `boot`, `user`, `agent`, `system`, `policy`

**Levels:** `info`, `warn`, `error`

**Events:**
`process.spawn`, `process.exit`, `file.read`, `file.write`, `io.stdout`, `io.stdin`, `env.configure`, `server.ready`, `status.change`, `policy.deny`, `policy.load`, `boot.mount`, `net.request`, `net.response`, `git.clone`, `git.push`

### AuditLog Methods

- `log(event, detail, meta?, opts?)` - Log an entry
- `filter({ source?, level?, event? })` - Filter entries
- `toText()` - Export grouped by source
- `toJSON()` - Export as JSON
- `onEntry(fn)` - Subscribe (returns unsubscribe fn)
- `static maskKey(val)` - Mask API keys
- `static maskHeaders(headers)` - Mask sensitive headers

## Git Service

Browser-native GitHub integration using the GitHub REST API (no git binary).

### GitService

```typescript
constructor(token: string, owner: string, repo: string, branch?: string)
static parseRepoUrl(url: string): { owner: string; repo: string }
async detectDefaultBranch(): Promise<string>
async fetchRepoTree(): Promise<GitFile[]>   // batch fetch, skip >1MB, max 10 concurrent
async pushChanges(files: GitFile[], message: string): Promise<string>  // atomic: blobs→tree→commit→ref
```

### Supported URL Formats

Handles `https://github.com/owner/repo`, `https://github.com/owner/repo.git`, and other GitHub URL formats.

## Network Interception

### Browser-side (net-intercept.ts)

Patches `window.fetch` to log all outbound HTTP requests with:

- Request: method, headers (masked), body preview
- Response: status, headers, duration

### Container-side (network-hook.ts)

Node.js hook injected via `NODE_OPTIONS=--require ./network-hook.cjs`. Patches:

- `http.request()` & `http.get()`
- `https.request()` & `https.get()`
- `globalThis.fetch()` (Node 18+)

Output format: `__NET_AUDIT__:{json}` on stderr, parsed by ContainerManager.
Sensitive headers masked. Bodies truncated to 2000 chars. Skipped during npm install.

## Configuration

### Environment Variables

Configure through the UI config panel or programmatically via options.env:

- `ANTHROPIC_API_KEY` - Anthropic API key
- `OPENAI_API_KEY` - OpenAI API key
- `GOOGLE_API_KEY` - Google AI API key
- `GITHUB_TOKEN` - GitHub personal access token (for git operations)

### Supported Providers & Models

- **Anthropic:** claude-opus-4-6, claude-sonnet-4-6, claude-haiku-4-5
- **OpenAI:** gpt-4o, gpt-4o-mini, o3-mini
- **Google:** gemini-2.0-flash, gemini-2.5-pro

### LocalStorage Persistence

Config persisted with `clawchef_` prefix:

- `clawchef_provider`, `clawchef_model`, `clawchef_envVars`, `clawchef_policy`

## Security Model

- **Sandboxing:** All code runs inside a WebContainer (WASM-based). No access to host filesystem or network beyond browser APIs.
- **Policy enforcement:** Every file read/write, process spawn, and port bind is checked against the policy engine before execution.
- **Network auditing:** All HTTP requests (browser and container) are intercepted, logged, and sensitive headers masked.
- **API key masking:** Keys are masked in logs (first 7 + last 4 chars visible).
- **COOP/COEP headers:** Required for SharedArrayBuffer (WebContainer). Configured via Vite dev server.
