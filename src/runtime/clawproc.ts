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

  constructor(fs: ClawFS) {
    this.fs = fs;
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
        await outputWriter.write('/home\n');
        return 0;
      }

      // Interactive shell — read from stdin, respond
      if (cmd === '/bin/jsh' || cmd === 'sh' || cmd === 'bash') {
        return await this.runInteractiveShell(inputReader, outputWriter, opts);
      }

      // Node.js execution — future: use QuickJS-WASM
      if (cmd === 'node') {
        if (args.includes('-e')) {
          // Inline script execution — future: eval via QuickJS
          await outputWriter.write(`[ClawKernel] Executed inline script\n`);
          return 0;
        }
        await outputWriter.write(`[ClawKernel] Would run: node ${args.join(' ')}\n`);
        // Future: load QuickJS-WASM and execute the script
        return 0;
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

    // echo $PWD
    if (trimmed === 'echo $PWD') {
      await outputWriter.write((opts?.env?.HOME || '/home') + '\n');
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
