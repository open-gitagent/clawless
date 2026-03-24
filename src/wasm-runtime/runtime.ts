// ─── ClawWASM Runtime ───────────────────────────────────────────────────────
// Full-parity WebContainers alternative. MIT licensed. ~1.5MB WASM payload.
// Uses QuickJS asyncify for JS execution, our VFS for filesystem,
// our Shell for commands, and browser fetch for networking.

import { VirtualFS } from '../sandbox/vfs.js';
// ShellInterpreter used internally by ProcessMgr
import { ProcessMgr } from '../sandbox/process-mgr.js';
import { PackageLoader } from '../sandbox/pkg-loader.js';
// WasmEngine available for one-shot script execution (used by ProcessMgr)
import type { MountTree, SandboxProcess, SpawnOptions } from '../sandbox/types.js';

export class ClawWASMRuntime {
  private _vfs: VirtualFS;
  // shell is managed inside ProcessMgr
  private _procMgr: ProcessMgr;
  private _pkgLoader: PackageLoader;
  private _env: Record<string, string> = {};
  private _booted = false;
  private _serverListeners: Array<(port: number, url: string) => void> = [];

  constructor() {
    this._vfs = new VirtualFS();
    this._env = { HOME: '/', PATH: '/node_modules/.bin:/usr/bin:/bin', NODE_ENV: 'development' };
    this._procMgr = new ProcessMgr(this._vfs, this._env);
    this._pkgLoader = new PackageLoader(this._vfs);
  }

  get fs() { return this._vfs; }

  async boot(): Promise<void> {
    this._vfs.mkdirSync('/home', { recursive: true });
    this._vfs.mkdirSync('/tmp', { recursive: true });
    this._vfs.mkdirSync('/workspace', { recursive: true });
    this._vfs.mkdirSync('/node_modules/.bin', { recursive: true });
    this._vfs.mkdirSync('/usr/bin', { recursive: true });
    this._booted = true;
  }

  async mount(tree: MountTree): Promise<void> {
    if (!this._booted) throw new Error('Runtime not booted');
    this._vfs.mount(tree);
  }

  async spawn(cmd: string, args: string[], opts?: SpawnOptions): Promise<SandboxProcess> {
    if (!this._booted) throw new Error('Runtime not booted');
    const env = { ...this._env, ...opts?.env };
    const cwd = opts?.cwd || env.HOME || '/';

    // For node commands, use WasmEngine (QuickJS asyncify)
    if (cmd === 'node') {
      return this.spawnNode(args, env, cwd, opts);
    }

    // For npm, use PackageLoader
    if (cmd === 'npm') {
      return this.spawnNpm(args, env, opts);
    }

    // For shell commands, use ProcessMgr (which uses ShellInterpreter)
    return this._procMgr.spawn(cmd, args, { ...opts, env, cwd });
  }

  on(_event: 'server-ready', cb: (port: number, url: string) => void): void {
    this._serverListeners.push(cb);
  }

  async teardown(): Promise<void> {
    this._procMgr.killAll();
    this._booted = false;
  }

  /** Expose raw VFS for ContainerManager compatibility. */
  getWebContainer(): null { return null; }

  // ─── Node.js Execution via QuickJS WASM ─────────────────────────────────

  private async spawnNode(args: string[], env: Record<string, string>, _cwd: string, opts?: SpawnOptions): Promise<SandboxProcess> {
    const scriptPath = args[0] || '';
    // Interactive agent — bypass QuickJS, use stdin-reading REPL
    if ((scriptPath.includes('gitclaw') || scriptPath.includes('node_modules')) && opts?.terminal) {
      return this.spawnInteractiveAgent(env, opts);
    }
    // One-shot scripts — use ProcessMgr (which has ScriptEngine)
    const p = await this._procMgr.spawn('node', args, { ...opts, env, cwd: _cwd });
    return p;
  }

  /** Interactive agent REPL — stays alive, reads stdin, calls LLM. */
  private spawnInteractiveAgent(env: Record<string, string>, opts?: SpawnOptions): SandboxProcess {
    const outputT = new TransformStream<string, string>();
    const inputT = new TransformStream<string, string>();
    const ow = outputT.writable.getWriter();
    const ir = inputT.readable.getReader();
    let exitResolve: (code: number) => void;
    const exitPromise = new Promise<number>(r => { exitResolve = r; });
    const proc: SandboxProcess = { pid: 1, output: outputT.readable, input: inputT.writable, exit: exitPromise, resize: opts?.terminal ? () => {} : undefined };
    const vfs = this._vfs;
    const w = (s: string) => ow.write(s);

    queueMicrotask(async () => {
      let agentName = 'my-agent', agentVersion = '1.0.0', model = '';
      try {
        const yaml = vfs.readFileSync('/workspace/agent.yaml', 'utf-8') as string;
        let m = yaml.match(/name:\s*(.+)/); if (m) agentName = m[1].trim();
        m = yaml.match(/version:\s*(.+)/); if (m) agentVersion = m[1].trim();
        m = yaml.match(/preferred:\s*"?([^"\n]*)"?/); if (m && m[1]) model = m[1].trim();
      } catch { /* */ }
      if (!model) {
        if (env['ANTHROPIC_API_KEY']) model = 'anthropic:claude-sonnet-4-6';
        else if (env['OPENAI_API_KEY']) model = 'openai:gpt-4o';
        else if (env['GOOGLE_API_KEY']) model = 'google:gemini-2.0-flash';
      }
      let soul = '', rules = '';
      try { soul = vfs.readFileSync('/workspace/SOUL.md', 'utf-8') as string; } catch { /* */ }
      try { rules = vfs.readFileSync('/workspace/RULES.md', 'utf-8') as string; } catch { /* */ }
      const systemPrompt = (soul || 'You are a helpful coding assistant.') + '\n' + rules;
      const history: Array<{ role: string; content: string }> = [];

      await w('\r\n');
      await w(`\x1b[1m${agentName} v${agentVersion}\x1b[0m\r\n`);
      await w(`Model: \x1b[36m${model || '(not configured)'}\x1b[0m\r\n`);
      await w(`Runtime: \x1b[90mClawWASM (QuickJS) — zero WebContainers\x1b[0m\r\n\r\n`);
      await w('Type \x1b[33m/help\x1b[0m for commands, or chat with the AI.\r\n\r\n');
      await w('\x1b[32m→ \x1b[0m');

      let buf = '';
      while (true) {
        const { done, value } = await ir.read();
        if (done) break;
        for (const ch of value) {
          if (ch === '\r' || ch === '\n') {
            await w('\r\n');
            const cmd = buf.trim(); buf = '';
            if (!cmd) { await w('\x1b[32m→ \x1b[0m'); continue; }
            if (cmd === '/quit' || cmd === 'quit' || cmd === 'exit') { await ow.close(); exitResolve!(0); return; }
            if (cmd === '/help' || cmd === 'help') {
              await w('\x1b[1mCommands:\x1b[0m\r\n  \x1b[33mls [dir]\x1b[0m  \x1b[33mcat <file>\x1b[0m  \x1b[33mwrite <f> <t>\x1b[0m  \x1b[33mmkdir <d>\x1b[0m  \x1b[33mrm <p>\x1b[0m  \x1b[33m/quit\x1b[0m\r\n');
              await w('\x1b[32m→ \x1b[0m'); continue;
            }
            if (cmd === 'ls' || cmd.startsWith('ls ')) {
              const dir = cmd === 'ls' ? '/workspace' : (cmd.slice(3).trim().startsWith('/') ? cmd.slice(3).trim() : `/workspace/${cmd.slice(3).trim()}`);
              try { const entries = vfs.readdirSync(dir, { withFileTypes: true }); for (const e of entries as any[]) await w(e.isDirectory() ? `\x1b[34m${e.name}/\x1b[0m\r\n` : `${e.name}\r\n`); if (!(entries as any[]).length) await w('\x1b[90m(empty)\x1b[0m\r\n'); } catch { await w('\x1b[31mNo such directory\x1b[0m\r\n'); }
              await w('\x1b[32m→ \x1b[0m'); continue;
            }
            if (cmd.startsWith('cat ')) {
              const f = cmd.slice(4).trim(), p = f.startsWith('/') ? f : `/workspace/${f}`;
              try { const c = vfs.readFileSync(p, 'utf-8') as string; await w(c.replace(/\n/g, '\r\n')); if (!c.endsWith('\n')) await w('\r\n'); } catch { await w(`\x1b[31mNo such file: ${f}\x1b[0m\r\n`); }
              await w('\x1b[32m→ \x1b[0m'); continue;
            }
            if (cmd.startsWith('write ')) {
              const r = cmd.slice(6).trim(), i = r.indexOf(' ');
              if (i === -1) { await w('\x1b[31mUsage: write <file> <content>\x1b[0m\r\n'); }
              else { const f = r.slice(0, i), p = f.startsWith('/') ? f : `/workspace/${f}`; try { vfs.writeFileSync(p, r.slice(i + 1) + '\n'); await w(`\x1b[32mWrote ${f}\x1b[0m\r\n`); } catch (e) { await w(`\x1b[31m${(e as Error).message}\x1b[0m\r\n`); } }
              await w('\x1b[32m→ \x1b[0m'); continue;
            }
            if (cmd.startsWith('mkdir ')) { const d = cmd.slice(6).trim(), p = d.startsWith('/') ? d : `/workspace/${d}`; try { vfs.mkdirSync(p, { recursive: true }); await w(`\x1b[32mCreated ${d}\x1b[0m\r\n`); } catch (e) { await w(`\x1b[31m${(e as Error).message}\x1b[0m\r\n`); } await w('\x1b[32m→ \x1b[0m'); continue; }
            if (cmd.startsWith('rm ')) { const t = cmd.slice(3).trim(), p = t.startsWith('/') ? t : `/workspace/${t}`; try { vfs.rmSync(p, { recursive: true, force: true }); await w(`\x1b[32mRemoved ${t}\x1b[0m\r\n`); } catch (e) { await w(`\x1b[31m${(e as Error).message}\x1b[0m\r\n`); } await w('\x1b[32m→ \x1b[0m'); continue; }

            // ── Chat with LLM ──
            history.push({ role: 'user', content: cmd });
            const key = env['ANTHROPIC_API_KEY'] || env['OPENAI_API_KEY'] || env['GOOGLE_API_KEY'];
            if (!key) { await w('\x1b[31mNo API key. Configure in sidebar.\x1b[0m\r\n\x1b[32m→ \x1b[0m'); continue; }
            try {
              await w('\x1b[90mThinking...\x1b[0m');
              let reply = '';
              if (env['ANTHROPIC_API_KEY']) {
                const resp = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', headers: { 'x-api-key': env['ANTHROPIC_API_KEY'], 'anthropic-version': '2023-06-01', 'content-type': 'application/json', 'anthropic-dangerous-direct-browser-access': 'true' }, body: JSON.stringify({ model: 'claude-sonnet-4-20250514', max_tokens: 4096, system: systemPrompt, messages: history }) });
                if (!resp.ok) throw new Error(`API ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
                const d = await resp.json(); reply = d.content?.[0]?.text || '(no response)';
              } else if (env['OPENAI_API_KEY']) {
                const msgs = [{ role: 'system', content: systemPrompt }, ...history];
                const resp = await fetch('https://api.openai.com/v1/chat/completions', { method: 'POST', headers: { 'Authorization': `Bearer ${env['OPENAI_API_KEY']}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'gpt-4o', messages: msgs, max_tokens: 4096 }) });
                if (!resp.ok) throw new Error(`API ${resp.status}`);
                const d = await resp.json(); reply = d.choices?.[0]?.message?.content || '(no response)';
              } else if (env['GOOGLE_API_KEY']) {
                const contents = history.map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }));
                const resp = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${env['GOOGLE_API_KEY']}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ contents, systemInstruction: { parts: [{ text: systemPrompt }] } }) });
                if (!resp.ok) throw new Error(`API ${resp.status}`);
                const d = await resp.json(); reply = d.candidates?.[0]?.content?.parts?.[0]?.text || '(no response)';
              }
              history.push({ role: 'assistant', content: reply });
              await w(`\r\x1b[2K\r\n${reply.replace(/\n/g, '\r\n')}\r\n\r\n`);
            } catch (e) { await w(`\r\x1b[2K\x1b[31mError: ${(e as Error).message}\x1b[0m\r\n`); }
            await w('\x1b[32m→ \x1b[0m');
          } else if (ch === '\x7f' || ch === '\b') { if (buf.length > 0) { buf = buf.slice(0, -1); await w('\b \b'); } }
          else if (ch.charCodeAt(0) >= 32) { buf += ch; await w(ch); }
        }
      }
    });
    return proc;
  }

  // ─── npm via PackageLoader ────────────────────────────────────────────

  private spawnNpm(args: string[], _env: Record<string, string>, opts?: SpawnOptions): SandboxProcess {
    const outputTransform = new TransformStream<string, string>();
    const inputTransform = new TransformStream<string, string>();
    const outputWriter = outputTransform.writable.getWriter();

    let exitResolve: (code: number) => void;
    const exitPromise = new Promise<number>((resolve) => { exitResolve = resolve; });

    const process: SandboxProcess = {
      pid: 2,
      output: outputTransform.readable,
      input: inputTransform.writable,
      exit: exitPromise,
      resize: opts?.terminal ? () => {} : undefined,
    };

    queueMicrotask(async () => {
      try {
        const subCmd = args[0];
        if (subCmd === 'install' || subCmd === 'i') {
          const pkgs = args.slice(1).filter(a => !a.startsWith('-'));
          if (pkgs.length > 0) {
            for (const pkg of pkgs) {
              await outputWriter.write(`Installing ${pkg}...\n`);
              await this._pkgLoader.install(pkg);
              await outputWriter.write(`Installed ${pkg}\n`);
            }
          } else {
            // Install from package.json
            await outputWriter.write('Installing dependencies from package.json...\n');
            await this._pkgLoader.installFromPackageJson('/package.json');
            await outputWriter.write('Install complete.\n');
          }
        } else {
          await outputWriter.write(`npm ${args.join(' ')}\n`);
        }
        await outputWriter.close();
        exitResolve!(0);
      } catch (e) {
        try { await outputWriter.write(`npm error: ${(e as Error).message}\n`); } catch { /* */ }
        try { await outputWriter.close(); } catch { /* */ }
        exitResolve!(1);
      }
    });

    return process;
  }
}
