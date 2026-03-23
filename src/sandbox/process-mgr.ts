// ─── ProcessMgr: Process Management ─────────────────────────────────────────
// Spawns "processes" that run JS via ScriptEngine or shell commands via ShellInterpreter.

import type { VirtualFS } from './vfs.js';
import type { SandboxProcess, SpawnOptions } from './types.js';
import { ScriptEngine } from './script-engine.js';
import { ShellInterpreter } from './shell.js';

interface ProcessEntry {
  pid: number;
  proc: SandboxProcess;
  cmd: string;
}

export class ProcessMgr {
  private vfs: VirtualFS;
  private processes = new Map<number, ProcessEntry>();
  private nextPid = 1;
  private shell: ShellInterpreter;

  constructor(vfs: VirtualFS, env: Record<string, string>) {
    this.vfs = vfs;
    this.shell = new ShellInterpreter(vfs, env);
  }

  async spawn(cmd: string, args: string[], opts?: SpawnOptions): Promise<SandboxProcess> {
    const pid = this.nextPid++;
    const env = { HOME: '/', PATH: '/node_modules/.bin:/usr/bin:/bin', ...opts?.env };
    const cwd = opts?.cwd || env.HOME || '/';

    const outputTransform = new TransformStream<string, string>();
    const inputTransform = new TransformStream<string, string>();
    const outputWriter = outputTransform.writable.getWriter();
    const inputReader = inputTransform.readable.getReader();

    let exitResolve: (code: number) => void;
    const exitPromise = new Promise<number>((resolve) => { exitResolve = resolve; });

    const process: SandboxProcess = {
      pid,
      output: outputTransform.readable,
      input: inputTransform.writable,
      exit: exitPromise,
      resize: opts?.terminal ? () => {} : undefined,
      kill: () => { this.processes.delete(pid); exitResolve!(137); },
    };

    this.processes.set(pid, { pid, proc: process, cmd });

    // Run in next microtask to allow caller to attach listeners
    queueMicrotask(async () => {
      try {
        let exitCode = 0;

        if (cmd === 'node') {
          exitCode = await this.runNode(args, env, cwd, inputReader, outputWriter);
        } else if (cmd === 'npm' || cmd === 'npx') {
          exitCode = await this.runNpm(args, outputWriter);
        } else if (cmd === 'sh' || cmd === '/bin/sh' || cmd === '/bin/jsh' || cmd === 'bash') {
          if (args[0] === '-c' && args[1]) {
            exitCode = await this.runShellCommand(args[1], outputWriter);
          } else {
            exitCode = await this.runInteractiveShell(inputReader, outputWriter, env);
          }
        } else {
          // Try as shell command
          exitCode = await this.runShellCommand(`${cmd} ${args.join(' ')}`, outputWriter);
        }

        await outputWriter.close();
        this.processes.delete(pid);
        exitResolve!(exitCode);
      } catch (e) {
        const err = e as Error;
        if (err.message?.startsWith('__SANDBOX_EXIT__:')) {
          const code = parseInt(err.message.split(':')[1], 10);
          await outputWriter.close();
          this.processes.delete(pid);
          exitResolve!(code);
        } else {
          try { await outputWriter.write(`Error: ${err.message}\n`); } catch { /* */ }
          try { await outputWriter.close(); } catch { /* */ }
          this.processes.delete(pid);
          exitResolve!(1);
        }
      }
    });

    return process;
  }

  private async runNode(
    args: string[],
    env: Record<string, string>,
    cwd: string,
    _inputReader: ReadableStreamDefaultReader<string>,
    outputWriter: WritableStreamDefaultWriter<string>,
  ): Promise<number> {
    const engine = new ScriptEngine({
      vfs: this.vfs,
      env,
      argv: args,
      cwd,
      stdout: (data) => { outputWriter.write(data); },
      stderr: (data) => { outputWriter.write(data); },
    });

    if (args.includes('-e')) {
      const codeIdx = args.indexOf('-e');
      const code = args[codeIdx + 1] || '';
      engine.eval(code);
      return 0;
    }

    const script = args[0];
    if (!script) {
      await outputWriter.write('node: missing script\n');
      return 1;
    }

    engine.run(script);
    return 0;
  }

  private async runNpm(args: string[], outputWriter: WritableStreamDefaultWriter<string>): Promise<number> {
    const subCmd = args[0];
    if (subCmd === 'install' || subCmd === 'i') {
      await outputWriter.write('[sandbox] Installing packages...\n');
      // Package installation handled by sandbox.ts boot
      await outputWriter.write('[sandbox] Install complete.\n');
      return 0;
    }
    if (subCmd === 'run') {
      await outputWriter.write(`[sandbox] npm run ${args[1] || ''}\n`);
      return 0;
    }
    await outputWriter.write(`[sandbox] npm ${args.join(' ')}\n`);
    return 0;
  }

  private async runShellCommand(cmdLine: string, outputWriter: WritableStreamDefaultWriter<string>): Promise<number> {
    const result = await this.shell.exec(cmdLine);
    if (result.stdout) await outputWriter.write(result.stdout);
    if (result.stderr) await outputWriter.write(result.stderr);
    return result.exitCode;
  }

  private async runInteractiveShell(
    inputReader: ReadableStreamDefaultReader<string>,
    outputWriter: WritableStreamDefaultWriter<string>,
    _env: Record<string, string>,
  ): Promise<number> {
    await outputWriter.write(`\x1b[90m[ClawSandbox Shell]\x1b[0m\r\n$ `);
    let buffer = '';

    while (true) {
      const { done, value } = await inputReader.read();
      if (done) break;

      for (const char of value) {
        if (char === '\r' || char === '\n') {
          await outputWriter.write('\r\n');
          const cmd = buffer.trim();
          buffer = '';
          if (cmd === 'exit') return 0;
          if (cmd) {
            const result = await this.shell.exec(cmd);
            if (result.stdout) await outputWriter.write(result.stdout.replace(/\n/g, '\r\n'));
            if (result.stderr) await outputWriter.write(result.stderr.replace(/\n/g, '\r\n'));
          }
          await outputWriter.write('$ ');
        } else if (char === '\x7f' || char === '\b') {
          if (buffer.length > 0) { buffer = buffer.slice(0, -1); await outputWriter.write('\b \b'); }
        } else if (char.charCodeAt(0) >= 32) {
          buffer += char;
          await outputWriter.write(char);
        }
      }
    }
    return 0;
  }

  kill(pid: number): void {
    const entry = this.processes.get(pid);
    entry?.proc.kill?.();
  }

  killAll(): void {
    for (const [, entry] of this.processes) entry.proc.kill?.();
    this.processes.clear();
  }

  get count(): number { return this.processes.size; }
}
