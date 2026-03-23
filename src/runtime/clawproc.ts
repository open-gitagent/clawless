// ─── ClawProc: Process Manager ──────────────────────────────────────────────
// Runs agent code in Web Workers. For the WebContainer runtime this is unused;
// it's the foundation for the ClawKernel runtime.
//
// Architecture:
// - Each "process" is a Web Worker
// - stdin/stdout piped via MessageChannel
// - Worker runs WASI binaries or JS via QuickJS-WASM

import type { RuntimeProcess, SpawnOptions } from './types.js';
import type { ClawFS } from './clawfs.js';
import type { ClawNet } from './clawnet.js';
import { QuickJSEngine } from './quickjs-engine.js';

interface ProcessEntry {
  pid: number;
  worker: Worker;
  process: RuntimeProcess;
  cmd: string;
}

export class ClawProc {
  private processes = new Map<number, ProcessEntry>();
  private nextPid = 1;
  private fs: ClawFS;
  private net: ClawNet | null = null;

  constructor(fs: ClawFS, net?: ClawNet) {
    this.fs = fs;
    this.net = net ?? null;
  }

  /** Spawn a new process. */
  async spawn(cmd: string, args: string[], opts?: SpawnOptions): Promise<RuntimeProcess> {
    const pid = this.nextPid++;

    // Create paired streams for stdin/stdout
    const outputTransform = new TransformStream<string, string>();
    const inputTransform = new TransformStream<string, string>();

    const outputWriter = outputTransform.writable.getWriter();
    const inputReader = inputTransform.readable.getReader();

    // For now, create a simple process that handles built-in commands
    // In the future, this will launch a Web Worker with WASI/QuickJS
    const exitPromise = this.runBuiltinOrWorker(
      cmd, args, opts,
      inputReader, outputWriter, pid,
    );

    const process: RuntimeProcess = {
      output: outputTransform.readable,
      input: inputTransform.writable,
      exit: exitPromise,
      resize: opts?.terminal ? (_dims) => {
        // PTY resize — notify worker (future: send SIGWINCH)
      } : undefined,
    };

    this.processes.set(pid, { pid, worker: null as any, process, cmd });

    return process;
  }

  private async runBuiltinOrWorker(
    cmd: string,
    args: string[],
    opts: SpawnOptions | undefined,
    inputReader: ReadableStreamDefaultReader<string>,
    outputWriter: WritableStreamDefaultWriter<string>,
    pid: number,
  ): Promise<number> {
    try {
      // Handle built-in shell commands
      if (cmd === 'sh' && args[0] === '-c') {
        const shellCmd = args[1];
        return await this.execShellCommand(shellCmd, opts, outputWriter);
      }

      if (cmd === 'echo') {
        await outputWriter.write(args.join(' ') + '\n');
        return 0;
      }

      if (cmd === 'cat') {
        for (const file of args) {
          try {
            const content = await this.fs.readFile(file, 'utf-8');
            await outputWriter.write(content);
          } catch (e) {
            await outputWriter.write(`cat: ${file}: No such file or directory\n`);
            return 1;
          }
        }
        return 0;
      }

      if (cmd === 'ls') {
        const dir = args[0] || '.';
        try {
          const entries = await this.fs.readdir(dir, { withFileTypes: true });
          for (const entry of entries) {
            await outputWriter.write(entry.name + (entry.isDirectory() ? '/' : '') + '\n');
          }
        } catch {
          await outputWriter.write(`ls: cannot access '${dir}': No such file or directory\n`);
          return 1;
        }
        return 0;
      }

      if (cmd === 'mkdir') {
        const recursive = args.includes('-p');
        const dirs = args.filter(a => a !== '-p');
        for (const dir of dirs) {
          await this.fs.mkdir(dir, { recursive });
        }
        return 0;
      }

      if (cmd === 'pwd') {
        await outputWriter.write('/\n');
        return 0;
      }

      // Interactive shell — read from stdin, respond
      if (cmd === '/bin/jsh' || cmd === 'sh' || cmd === 'bash') {
        return await this.runInteractiveShell(inputReader, outputWriter, opts);
      }

      // Node.js execution — check if it's the built-in agent (interactive)
      if (cmd === 'node') {
        const scriptPath = args[0] || '';
        if (scriptPath.includes('gitclaw') || scriptPath.includes('node_modules')) {
          return await this.runBuiltinAgent(inputReader, outputWriter, opts);
        }
        return await this.runNode(args, opts, inputReader, outputWriter);
      }

      // npm — future: use ClawPkg
      if (cmd === 'npm') {
        if (args[0] === 'install') {
          await outputWriter.write('[ClawKernel] Installing packages via ClawPkg...\n');
          // Future: delegate to ClawPkg
          await outputWriter.write('[ClawKernel] Install complete.\n');
          return 0;
        }
        return 0;
      }

      // Unknown command
      await outputWriter.write(`clawkernel: command not found: ${cmd}\n`);
      return 127;
    } finally {
      await outputWriter.close();
      this.processes.delete(pid);
    }
  }

  private async execShellCommand(
    shellCmd: string,
    opts: SpawnOptions | undefined,
    outputWriter: WritableStreamDefaultWriter<string>,
  ): Promise<number> {
    // Parse simple shell commands
    const trimmed = shellCmd.trim();

    // echo $PWD — return root since mount tree is at /
    if (trimmed === 'echo $PWD') {
      await outputWriter.write('/\n');
      return 0;
    }

    // cd && command chains
    if (trimmed.includes('&&')) {
      const cmds = trimmed.split('&&').map(c => c.trim());
      for (const c of cmds) {
        if (c.startsWith('cd ')) continue; // cd is a no-op in subshell
        // Recursively execute
        const result = await this.execShellCommand(c, opts, outputWriter);
        if (result !== 0) return result;
      }
      return 0;
    }

    // Simple command parsing
    const parts = trimmed.split(/\s+/);
    const cmd = parts[0];
    const args = parts.slice(1);

    const subOutputTransform = new TransformStream<string, string>();
    const subReader = subOutputTransform.readable.getReader();
    const subWriter = subOutputTransform.writable.getWriter();

    const resultPromise = this.runBuiltinOrWorker(
      cmd, args, opts,
      null as any, subWriter, -1,
    );

    // Pipe sub-process output to our output
    (async () => {
      while (true) {
        const { done, value } = await subReader.read();
        if (done) break;
        await outputWriter.write(value);
      }
    })();

    return await resultPromise;
  }

  private async runInteractiveShell(
    inputReader: ReadableStreamDefaultReader<string>,
    outputWriter: WritableStreamDefaultWriter<string>,
    opts?: SpawnOptions,
  ): Promise<number> {
    await outputWriter.write('\x1b[90m[ClawKernel Shell]\x1b[0m\r\n$ ');

    let buffer = '';
    while (true) {
      const { done, value } = await inputReader.read();
      if (done) break;

      for (const char of value) {
        if (char === '\r' || char === '\n') {
          await outputWriter.write('\r\n');
          const cmd = buffer.trim();
          buffer = '';

          if (cmd === 'exit' || cmd === 'quit') return 0;
          if (cmd === '') { await outputWriter.write('$ '); continue; }

          // Execute the command
          const subOutput = new TransformStream<string, string>();
          const subWriter = subOutput.writable.getWriter();
          const subReader = subOutput.readable.getReader();

          const exitCode = this.execShellCommand(cmd, opts, subWriter);

          // Read output
          (async () => {
            while (true) {
              const { done, value } = await subReader.read();
              if (done) break;
              await outputWriter.write(value);
            }
          })();

          await exitCode;
          await outputWriter.write('$ ');
        } else if (char === '\x7f' || char === '\b') {
          // Backspace
          if (buffer.length > 0) {
            buffer = buffer.slice(0, -1);
            await outputWriter.write('\b \b');
          }
        } else {
          buffer += char;
          await outputWriter.write(char);
        }
      }
    }
    return 0;
  }

  /** Run the built-in interactive agent (long-running REPL). */
  private async runBuiltinAgent(
    inputReader: ReadableStreamDefaultReader<string>,
    outputWriter: WritableStreamDefaultWriter<string>,
    opts?: SpawnOptions,
  ): Promise<number> {
    const env = opts?.env ?? {};
    const w = (s: string) => outputWriter.write(s);
    const chatHistory: Array<{ role: string; content: string }> = [];

    // Read agent config from workspace template
    let agentName = 'my-agent';
    let agentVersion = '1.0.0';
    let model = '';
    let tools = 'cli, read, write, memory';
    try {
      const yaml = await this.fs.readFile('/workspace/agent.yaml', 'utf-8');
      const nameMatch = yaml.match(/name:\s*(.+)/);
      const versionMatch = yaml.match(/version:\s*(.+)/);
      const modelMatch = yaml.match(/preferred:\s*"?([^"\n]*)"?/);
      const toolsMatch = yaml.match(/tools:\s*\[([^\]]*)\]/);
      if (nameMatch) agentName = nameMatch[1].trim();
      if (versionMatch) agentVersion = versionMatch[1].trim();
      if (modelMatch && modelMatch[1]) model = modelMatch[1].trim();
      if (toolsMatch) tools = toolsMatch[1].trim();
    } catch { /* no agent.yaml */ }

    // Detect configured model from env
    if (!model) {
      if (env['ANTHROPIC_API_KEY']) model = 'anthropic:claude-sonnet-4-6';
      else if (env['OPENAI_API_KEY']) model = 'openai:gpt-4o';
      else if (env['GOOGLE_API_KEY']) model = 'google:gemini-2.0-flash';
    }

    await w('\r\n');
    await w(`\x1b[1m${agentName} v${agentVersion}\x1b[0m\r\n`);
    await w(`Model: \x1b[36m${model || '(not configured)'}\x1b[0m\r\n`);
    await w(`Tools: \x1b[90m${tools}\x1b[0m\r\n`);
    await w(`Runtime: \x1b[90mClawKernel (WASM) — zero WebContainers\x1b[0m\r\n\r\n`);
    await w('Type \x1b[33m/help\x1b[0m for commands, or type a message to chat.\r\n\r\n');
    await w('\x1b[32m→ \x1b[0m');

    let buffer = '';

    while (true) {
      const { done, value } = await inputReader.read();
      if (done) break;

      for (const char of value) {
        if (char === '\r' || char === '\n') {
          await w('\r\n');
          const cmd = buffer.trim();
          buffer = '';

          if (!cmd) { await w('\x1b[32m→ \x1b[0m'); continue; }

          if (cmd === 'quit' || cmd === 'exit' || cmd === '/quit') {
            await w('\x1b[90mGoodbye.\x1b[0m\r\n');
            return 0;
          }

          if (cmd === 'help' || cmd === '/help') {
            await w('\x1b[1mCommands:\x1b[0m\r\n');
            await w('  \x1b[33mls [dir]\x1b[0m          — list files\r\n');
            await w('  \x1b[33mcat <file>\x1b[0m        — show file contents\r\n');
            await w('  \x1b[33mwrite <f> <text>\x1b[0m  — write text to file\r\n');
            await w('  \x1b[33mmkdir <dir>\x1b[0m       — create directory\r\n');
            await w('  \x1b[33mrm <path>\x1b[0m         — delete file/dir\r\n');
            await w('  \x1b[33mpwd\x1b[0m               — print working directory\r\n');
            await w('  \x1b[33m/skills\x1b[0m           — list available skills\r\n');
            await w('  \x1b[33m/memory\x1b[0m           — view memory\r\n');
            await w('  \x1b[33m/quit\x1b[0m             — exit agent\r\n');
            await w('\r\nOr just type a message to chat with the AI.\r\n');
            await w('\x1b[32m→ \x1b[0m');
            continue;
          }

          if (cmd === '/skills') {
            await w('\x1b[1mAvailable skills:\x1b[0m\r\n');
            await w('  \x1b[36mcli\x1b[0m      — execute shell commands\r\n');
            await w('  \x1b[36mread\x1b[0m     — read files from workspace\r\n');
            await w('  \x1b[36mwrite\x1b[0m    — write/create files\r\n');
            await w('  \x1b[36mmemory\x1b[0m   — persistent memory across sessions\r\n');
            await w('\x1b[32m→ \x1b[0m');
            continue;
          }

          if (cmd === '/memory') {
            try {
              const mem = await this.fs.readFile('/workspace/memory/MEMORY.md', 'utf-8');
              await w(`\x1b[1mMemory:\x1b[0m\r\n${mem.replace(/\n/g, '\r\n')}\r\n`);
            } catch {
              await w('\x1b[90mNo memories saved yet.\x1b[0m\r\n');
            }
            await w('\x1b[32m→ \x1b[0m');
            continue;
          }

          if (cmd === 'pwd') {
            await w('/workspace\r\n');
            await w('\x1b[32m→ \x1b[0m');
            continue;
          }

          if (cmd === 'ls' || cmd.startsWith('ls ')) {
            const dir = cmd === 'ls' ? '/workspace' : cmd.slice(3).trim();
            const lookupDir = dir.startsWith('/') ? dir : `/workspace/${dir}`;
            try {
              const entries = await this.fs.readdir(lookupDir, { withFileTypes: true });
              if (entries.length === 0) {
                await w('\x1b[90m(empty)\x1b[0m\r\n');
              }
              for (const e of entries) {
                if (e.isDirectory()) {
                  await w(`\x1b[34m${e.name}/\x1b[0m\r\n`);
                } else {
                  await w(`${e.name}\r\n`);
                }
              }
            } catch {
              await w(`\x1b[31mNo such directory: ${dir}\x1b[0m\r\n`);
            }
            await w('\x1b[32m→ \x1b[0m');
            continue;
          }

          if (cmd.startsWith('cat ')) {
            const file = cmd.slice(4).trim();
            const path = file.startsWith('/') ? file : `/workspace/${file}`;
            try {
              const content = await this.fs.readFile(path, 'utf-8');
              await w(content.replace(/\n/g, '\r\n'));
              if (!content.endsWith('\n')) await w('\r\n');
            } catch {
              await w(`\x1b[31mNo such file: ${file}\x1b[0m\r\n`);
            }
            await w('\x1b[32m→ \x1b[0m');
            continue;
          }

          if (cmd.startsWith('write ')) {
            const rest = cmd.slice(6).trim();
            const spaceIdx = rest.indexOf(' ');
            if (spaceIdx === -1) {
              await w('\x1b[31mUsage: write <file> <content>\x1b[0m\r\n');
            } else {
              const file = rest.slice(0, spaceIdx);
              const content = rest.slice(spaceIdx + 1);
              const path = file.startsWith('/') ? file : `/workspace/${file}`;
              try {
                await this.fs.writeFile(path, content + '\n');
                await w(`\x1b[32mWrote ${content.length + 1} bytes to ${file}\x1b[0m\r\n`);
              } catch (e) {
                await w(`\x1b[31mError: ${(e as Error).message}\x1b[0m\r\n`);
              }
            }
            await w('\x1b[32m→ \x1b[0m');
            continue;
          }

          if (cmd.startsWith('mkdir ')) {
            const dir = cmd.slice(6).trim();
            const path = dir.startsWith('/') ? dir : `/workspace/${dir}`;
            try {
              await this.fs.mkdir(path, { recursive: true });
              await w(`\x1b[32mCreated ${dir}\x1b[0m\r\n`);
            } catch (e) {
              await w(`\x1b[31mError: ${(e as Error).message}\x1b[0m\r\n`);
            }
            await w('\x1b[32m→ \x1b[0m');
            continue;
          }

          if (cmd.startsWith('rm ')) {
            const target = cmd.slice(3).trim();
            const path = target.startsWith('/') ? target : `/workspace/${target}`;
            try {
              await this.fs.rm(path, { recursive: true });
              await w(`\x1b[32mRemoved ${target}\x1b[0m\r\n`);
            } catch (e) {
              await w(`\x1b[31mError: ${(e as Error).message}\x1b[0m\r\n`);
            }
            await w('\x1b[32m→ \x1b[0m');
            continue;
          }

          // Chat — send to LLM via ClawNet
          await this.handleChat(cmd, chatHistory, env, w);

        } else if (char === '\x7f' || char === '\b') {
          if (buffer.length > 0) {
            buffer = buffer.slice(0, -1);
            await w('\b \b');
          }
        } else if (char.charCodeAt(0) >= 32) {
          buffer += char;
          await w(char);
        }
      }
    }
    return 0;
  }

  /** Send a chat message to the configured LLM. */
  private async handleChat(
    message: string,
    history: Array<{ role: string; content: string }>,
    env: Record<string, string>,
    w: (s: string) => Promise<void>,
  ): Promise<void> {
    // Detect provider from env vars
    const anthropicKey = env['ANTHROPIC_API_KEY'];
    const openaiKey = env['OPENAI_API_KEY'];
    const googleKey = env['GOOGLE_API_KEY'];

    // Build system prompt with workspace context
    let soulContent = '';
    try { soulContent = await this.fs.readFile('/workspace/SOUL.md', 'utf-8'); } catch { /* ok */ }
    let rulesContent = '';
    try { rulesContent = await this.fs.readFile('/workspace/RULES.md', 'utf-8'); } catch { /* ok */ }

    const systemPrompt = [
      soulContent || 'You are a helpful coding assistant running inside ClawKernel, a browser-based WASM runtime.',
      rulesContent ? `\n${rulesContent}` : '',
      '\nYou can ask the user to run commands like `ls`, `cat <file>`, `write <file> <content>` to interact with the workspace.',
      '\nBe concise and helpful.',
    ].join('');

    history.push({ role: 'user', content: message });

    try {
      if (anthropicKey) {
        await this.chatAnthropic(anthropicKey, history, w, systemPrompt);
      } else if (openaiKey) {
        await this.chatOpenAI(openaiKey, history, w, systemPrompt);
      } else if (googleKey) {
        await this.chatGoogle(googleKey, history, w, systemPrompt);
      } else {
        await w('\x1b[31mNo API key found. Configure in the sidebar (Anthropic, OpenAI, or Google).\x1b[0m\r\n');
        await w('\x1b[32m→ \x1b[0m');
        return;
      }
    } catch (e) {
      await w(`\x1b[31mAPI error: ${(e as Error).message}\x1b[0m\r\n`);
    }
    await w('\x1b[32m→ \x1b[0m');
  }

  private async chatAnthropic(
    key: string,
    history: Array<{ role: string; content: string }>,
    w: (s: string) => Promise<void>,
    systemPrompt: string,
  ): Promise<void> {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 4096,
        system: systemPrompt,
        messages: history,
      }),
    });
    if (!resp.ok) {
      const err = await resp.text();
      throw new Error(`Anthropic ${resp.status}: ${err.slice(0, 200)}`);
    }
    const data = await resp.json();
    const text = data.content?.[0]?.text || '(no response)';
    history.push({ role: 'assistant', content: text });
    await w(`\r\n${text.replace(/\n/g, '\r\n')}\r\n\r\n`);
  }

  private async chatOpenAI(
    key: string,
    history: Array<{ role: string; content: string }>,
    w: (s: string) => Promise<void>,
    systemPrompt: string,
  ): Promise<void> {
    const messages = [
      { role: 'system', content: systemPrompt },
      ...history,
    ];
    const resp = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ model: 'gpt-4o', messages, max_tokens: 1024 }),
    });
    if (!resp.ok) {
      const err = await resp.text();
      throw new Error(`OpenAI ${resp.status}: ${err.slice(0, 200)}`);
    }
    const data = await resp.json();
    const text = data.choices?.[0]?.message?.content || '(no response)';
    history.push({ role: 'assistant', content: text });
    await w(`\r\n${text.replace(/\n/g, '\r\n')}\r\n\r\n`);
  }

  private async chatGoogle(
    key: string,
    history: Array<{ role: string; content: string }>,
    w: (s: string) => Promise<void>,
    systemPrompt: string,
  ): Promise<void> {
    const contents = history.map(m => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }],
    }));
    const resp = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${key}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents,
          systemInstruction: { parts: [{ text: systemPrompt }] },
        }),
      },
    );
    if (!resp.ok) {
      const err = await resp.text();
      throw new Error(`Google ${resp.status}: ${err.slice(0, 200)}`);
    }
    const data = await resp.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '(no response)';
    history.push({ role: 'assistant', content: text });
    await w(`\r\n${text.replace(/\n/g, '\r\n')}\r\n\r\n`);
  }

  /** Run a Node.js script via QuickJS-WASM. */
  private async runNode(
    args: string[],
    opts: SpawnOptions | undefined,
    _inputReader: ReadableStreamDefaultReader<string> | null,
    outputWriter: WritableStreamDefaultWriter<string>,
  ): Promise<number> {
    let code: string;

    if (args.includes('-e')) {
      // Inline script: node -e "code"
      code = args[args.indexOf('-e') + 1] || '';
    } else {
      // Script file: node path/to/script.js
      const scriptPath = args[0];
      if (!scriptPath) {
        await outputWriter.write('[ClawKernel] Error: no script specified\n');
        return 1;
      }
      try {
        code = await this.fs.readFile(scriptPath, 'utf-8');
      } catch {
        // Try with leading slash
        try {
          code = await this.fs.readFile('/' + scriptPath, 'utf-8');
        } catch {
          await outputWriter.write(`[ClawKernel] Error: cannot read ${scriptPath}\n`);
          return 1;
        }
      }
    }

    const engine = new QuickJSEngine({
      fs: this.fs,
      net: this.net!,
      env: opts?.env ?? {},
      args,
      cwd: opts?.env?.HOME || '/home',
      stdout: (data) => { outputWriter.write(data); },
      stderr: (data) => { outputWriter.write(data); },
    });

    try {
      await engine.init();
      const exitCode = await engine.run(code, args[0] || 'inline.js');
      return exitCode;
    } catch (e) {
      await outputWriter.write(`[ClawKernel] Runtime error: ${(e as Error).message}\n`);
      return 1;
    } finally {
      engine.dispose();
    }
  }

  /** Kill a process by PID. */
  kill(pid: number): void {
    const entry = this.processes.get(pid);
    if (entry?.worker) {
      entry.worker.terminate();
    }
    this.processes.delete(pid);
  }

  /** Kill all processes. */
  killAll(): void {
    for (const [pid] of this.processes) {
      this.kill(pid);
    }
  }

  /** Number of active processes. */
  get count(): number {
    return this.processes.size;
  }
}
