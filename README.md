<table align="center">
  <tr>
    <td align="center" width="250">
      <img src="clawless_readme.png" alt="ClawLess" width="200" />
    </td>
    <td>
      <h1>ClawLess</h1>
      <p><em>No server required to run Claw Agents, use ClawLess to run on browser!</em></p>
      <p><strong>A serverless browser-based runtime for Claw AI Agents powered by WebContainers</strong></p>
      <ul>
        <li>Run Claw Agents without a Server — entirely on-browser via WebContainers (WASM)</li>
        <li>Complete Audit &amp; Policy driven sandboxing</li>
        <li>Built on <a href="https://gitagent.sh">GitAgent</a> Standard</li>
        <li>Pluggable SDK with template-based agent bootstrapping</li>
      </ul>
    </td>
  </tr>
</table>

<p align="center">
  <a href="https://www.npmjs.com/package/clawcontainer"><img src="https://img.shields.io/npm/v/clawcontainer?color=cb3837&label=npm&logo=npm" alt="npm version" /></a>
  <a href="https://github.com/open-gitagent/clawless/releases"><img src="https://img.shields.io/github/v/release/open-gitagent/clawless?color=blue&logo=github" alt="GitHub release" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg" alt="License: MIT" /></a>
  <a href="https://github.com/open-gitagent/clawless/stargazers"><img src="https://img.shields.io/github/stars/open-gitagent/clawless?style=social" alt="GitHub stars" /></a>
  <a href="https://github.com/open-gitagent/clawless/issues"><img src="https://img.shields.io/github/issues/open-gitagent/clawless?color=yellow" alt="GitHub issues" /></a>
  <a href="CONTRIBUTING.md"><img src="https://img.shields.io/badge/PRs-welcome-brightgreen.svg" alt="PRs Welcome" /></a>
  <img src="https://img.shields.io/badge/TypeScript-5.4-blue?logo=typescript&logoColor=white" alt="TypeScript" />
  <img src="https://img.shields.io/badge/WebContainers-WASM-orange?logo=webassembly&logoColor=white" alt="WebContainers" />
  <img src="https://img.shields.io/badge/platform-browser-lightgrey?logo=googlechrome&logoColor=white" alt="Platform: Browser" />
</p>

<p align="center">
  <a href="#quick-start">Quick Start</a> &middot;
  <a href="DOCS.md">Documentation</a> &middot;
  <a href="#sdk-usage">SDK Usage</a> &middot;
  <a href="CONTRIBUTING.md">Contributing</a> &middot;
  <a href="https://github.com/open-gitagent/clawless/discussions">Discussions</a>
</p>

---

Run, observe, and control AI agents entirely in the browser — no backend required. ClawLess provides a full sandboxed Node.js environment via WebContainers (WASM) with built-in editor, terminal, policy engine, and audit logging.

---

## Key Features

- **WebContainer-powered sandboxed runtime (WASM)** — full OS-level isolation in the browser
- **Monaco Editor with multi-file tabs** — rich editing experience out of the box
- **xterm.js terminal with full PTY support** — real terminal sessions, not a toy console
- **GitHub integration** — clone and push repositories via the GitHub API
- **YAML-based policy engine with glob patterns** — declarative guardrails for agent behavior
- **Complete audit logging** — process, file, network, and git events captured end-to-end
- **Plugin system with lifecycle hooks** — extend and customize every stage of execution
- **Template system for agent configurations** — bootstrap agents from reusable presets
- **Network interception** — intercepts both browser `fetch` and Node.js `http` calls
- **Multi-provider AI support** — Anthropic, OpenAI, and Google out of the box

## Quick Start

```bash
# Run locally
git clone https://github.com/open-gitagent/clawless.git
cd clawless
npm install
npm run dev
```

```bash
# Install as a dependency
npm install clawcontainer
```

## SDK Usage

```typescript
import { ClawContainer } from 'clawcontainer';

const cc = new ClawContainer('#app', {
  template: 'gitclaw',
  env: { ANTHROPIC_API_KEY: 'sk-...' }
});

await cc.start();
cc.on('ready', () => console.log('Container ready!'));
```

## Architecture

| Component | Role |
|---|---|
| **ClawContainer** | SDK facade — the single entry point for consumers |
| **ContainerManager** | WebContainer orchestration and lifecycle |
| **PolicyEngine** | YAML-based guardrails enforcing file, process, and network rules |
| **AuditLog** | Complete event trail for every action inside the container |
| **GitService** | GitHub API integration (clone, commit, push) |
| **PluginManager** | Lifecycle hooks for extending container behavior |
| **UIManager** | Monaco Editor, xterm.js terminal, and tab management |

## Tech Stack

- **Vite + TypeScript** — fast builds, type-safe codebase
- **WebContainer API** — browser-native OS environment
- **xterm.js** — full-featured terminal emulator
- **Monaco Editor** — the editor behind VS Code

## Configuration

ClawLess is configured through environment variables passed to the `ClawContainer` constructor:

| Variable | Purpose |
|---|---|
| `ANTHROPIC_API_KEY` | Anthropic API key |
| `OPENAI_API_KEY` | OpenAI API key |
| `GOOGLE_AI_API_KEY` | Google AI API key |
| `CLAWLESS_MODEL` | Model selection (e.g. `claude-sonnet-4-20250514`, `gpt-4o`) |

All runtime state is persisted to `localStorage` under the `clawchef_` prefix, so sessions survive page reloads.

## Links

## Supported Providers

| Provider | Models |
|---|---|
| **Anthropic** | Claude Sonnet, Claude Opus, Claude Haiku |
| **OpenAI** | GPT-4o, GPT-4, GPT-3.5 |
| **Google** | Gemini Pro, Gemini Flash |

## Roadmap

- [ ] Custom agent template marketplace
- [ ] Multi-agent orchestration
- [ ] Persistent filesystem across sessions
- [ ] Cloud deployment support
- [ ] Built-in agent debugging tools

## Community

- [GitHub Discussions](https://github.com/open-gitagent/clawless/discussions) — ask questions, share ideas
- [Issues](https://github.com/open-gitagent/clawless/issues) — report bugs, request features
- [Contributing Guide](CONTRIBUTING.md) — how to contribute

## Links

[Documentation](DOCS.md) | [Contributing](CONTRIBUTING.md) | [License](LICENSE) | [GitAgent Standard](https://gitagent.sh)

---

<p align="center">
  Built with care by <a href="https://github.com/shreyaskapale">Shreyas Kapale</a> / <a href="https://lyzr.ai">Lyzr</a>
</p>

<p align="center">
  <sub>If ClawLess helps you, consider giving it a star on GitHub!</sub>
</p>
