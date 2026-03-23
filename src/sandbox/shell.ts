// ─── Shell Interpreter ──────────────────────────────────────────────────────
// Bash-like shell with pipes, redirects, and 35+ built-in commands.

import type { VirtualFS } from './vfs.js';
import * as pathModule from './polyfills/path.js';

export class ShellInterpreter {
  private vfs: VirtualFS;
  private env: Record<string, string>;
  private cwd: string;

  constructor(vfs: VirtualFS, env: Record<string, string>) {
    this.vfs = vfs;
    this.env = env;
    this.cwd = env['HOME'] || '/';
  }

  getCwd(): string { return this.cwd; }

  /** Execute a command string and return { stdout, stderr, exitCode }. */
  async exec(cmdLine: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const trimmed = cmdLine.trim();
    if (!trimmed) return { stdout: '', stderr: '', exitCode: 0 };

    // Handle && chains
    if (trimmed.includes('&&')) {
      const parts = trimmed.split('&&').map(s => s.trim());
      let stdout = '', stderr = '';
      for (const part of parts) {
        const result = await this.exec(part);
        stdout += result.stdout;
        stderr += result.stderr;
        if (result.exitCode !== 0) return { stdout, stderr, exitCode: result.exitCode };
      }
      return { stdout, stderr, exitCode: 0 };
    }

    // Handle || chains
    if (trimmed.includes('||') && !trimmed.includes("'") && !trimmed.includes('"')) {
      const parts = trimmed.split('||').map(s => s.trim());
      for (const part of parts) {
        const result = await this.exec(part);
        if (result.exitCode === 0) return result;
      }
      return { stdout: '', stderr: '', exitCode: 1 };
    }

    // Handle pipes
    if (trimmed.includes('|') && !trimmed.includes("'|") && !trimmed.includes('"|')) {
      const stages = trimmed.split('|').map(s => s.trim());
      let input = '';
      let lastResult = { stdout: '', stderr: '', exitCode: 0 };
      for (const stage of stages) {
        lastResult = await this.execSingle(stage, input);
        input = lastResult.stdout;
      }
      return lastResult;
    }

    // Handle output redirect
    if (trimmed.includes('>')) {
      const appendMatch = trimmed.match(/^(.+?)>>(.+)$/);
      const overwriteMatch = trimmed.match(/^(.+?)>(.+)$/);
      if (appendMatch) {
        const result = await this.execSingle(appendMatch[1].trim());
        const file = this.resolvePath(appendMatch[2].trim());
        try { this.vfs.appendFileSync(file, result.stdout); } catch (e) { return { stdout: '', stderr: (e as Error).message, exitCode: 1 }; }
        return { stdout: '', stderr: result.stderr, exitCode: result.exitCode };
      }
      if (overwriteMatch) {
        const result = await this.execSingle(overwriteMatch[1].trim());
        const file = this.resolvePath(overwriteMatch[2].trim());
        try { this.vfs.writeFileSync(file, result.stdout); } catch (e) { return { stdout: '', stderr: (e as Error).message, exitCode: 1 }; }
        return { stdout: '', stderr: result.stderr, exitCode: result.exitCode };
      }
    }

    return this.execSingle(trimmed);
  }

  /** Execute a single command (no pipes/redirects). */
  private async execSingle(cmdLine: string, stdin = ''): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    // Variable expansion
    const expanded = cmdLine.replace(/\$(\w+)/g, (_, name) => this.env[name] || '');

    const args = this.parseArgs(expanded);
    if (args.length === 0) return { stdout: '', stderr: '', exitCode: 0 };

    const cmd = args[0];
    const params = args.slice(1);

    try {
      switch (cmd) {
        case 'echo': return { stdout: params.join(' ') + '\n', stderr: '', exitCode: 0 };
        case 'printf': return { stdout: params.join(' '), stderr: '', exitCode: 0 };
        case 'pwd': return { stdout: this.cwd + '\n', stderr: '', exitCode: 0 };
        case 'cd': return this.cmdCd(params);
        case 'ls': return this.cmdLs(params);
        case 'cat': return this.cmdCat(params, stdin);
        case 'head': return this.cmdHead(params, stdin);
        case 'tail': return this.cmdTail(params, stdin);
        case 'wc': return this.cmdWc(params, stdin);
        case 'grep': return this.cmdGrep(params, stdin);
        case 'sort': return this.cmdSort(stdin);
        case 'uniq': return this.cmdUniq(stdin);
        case 'mkdir': return this.cmdMkdir(params);
        case 'rmdir': return this.cmdRmdir(params);
        case 'rm': return this.cmdRm(params);
        case 'cp': return this.cmdCp(params);
        case 'mv': return this.cmdMv(params);
        case 'touch': return this.cmdTouch(params);
        case 'which': return { stdout: `/usr/bin/${params[0] || ''}\n`, stderr: '', exitCode: params.length ? 0 : 1 };
        case 'whoami': return { stdout: 'sandbox\n', stderr: '', exitCode: 0 };
        case 'hostname': return { stdout: 'clawsandbox\n', stderr: '', exitCode: 0 };
        case 'uname': return { stdout: 'ClawSandbox 1.0.0 x86_64\n', stderr: '', exitCode: 0 };
        case 'date': return { stdout: new Date().toISOString() + '\n', stderr: '', exitCode: 0 };
        case 'env': case 'printenv':
          return { stdout: Object.entries(this.env).map(([k, v]) => `${k}=${v}`).join('\n') + '\n', stderr: '', exitCode: 0 };
        case 'export': {
          for (const p of params) {
            const [k, ...rest] = p.split('=');
            if (k && rest.length) this.env[k] = rest.join('=');
          }
          return { stdout: '', stderr: '', exitCode: 0 };
        }
        case 'unset': { for (const k of params) delete this.env[k]; return { stdout: '', stderr: '', exitCode: 0 }; }
        case 'true': return { stdout: '', stderr: '', exitCode: 0 };
        case 'false': return { stdout: '', stderr: '', exitCode: 1 };
        case 'exit': return { stdout: '', stderr: '', exitCode: parseInt(params[0] || '0', 10) };
        case 'clear': return { stdout: '\x1b[2J\x1b[H', stderr: '', exitCode: 0 };
        case 'sleep': return { stdout: '', stderr: '', exitCode: 0 }; // instant
        case 'tee': {
          if (params[0]) {
            this.vfs.writeFileSync(this.resolvePath(params[0]), stdin);
          }
          return { stdout: stdin, stderr: '', exitCode: 0 };
        }
        case 'tr': return this.cmdTr(params, stdin);
        case 'sed': return { stdout: stdin, stderr: 'sed: not fully implemented\n', exitCode: 0 };
        case 'awk': return { stdout: stdin, stderr: 'awk: not fully implemented\n', exitCode: 0 };
        case 'find': return this.cmdFind(params);
        case 'xargs': return { stdout: stdin, stderr: '', exitCode: 0 };
        case 'node': case 'npm': case 'npx':
          return { stdout: '', stderr: '', exitCode: 0 }; // Handled by ProcessMgr
        default:
          return { stdout: '', stderr: `sh: command not found: ${cmd}\n`, exitCode: 127 };
      }
    } catch (e) {
      return { stdout: '', stderr: `${cmd}: ${(e as Error).message}\n`, exitCode: 1 };
    }
  }

  private resolvePath(p: string): string {
    return pathModule.isAbsolute(p) ? pathModule.normalize(p) : pathModule.resolve(this.cwd, p);
  }

  private parseArgs(input: string): string[] {
    const args: string[] = [];
    let current = '';
    let inSingle = false, inDouble = false;
    for (const ch of input) {
      if (ch === "'" && !inDouble) { inSingle = !inSingle; continue; }
      if (ch === '"' && !inSingle) { inDouble = !inDouble; continue; }
      if (ch === ' ' && !inSingle && !inDouble) {
        if (current) { args.push(current); current = ''; }
        continue;
      }
      current += ch;
    }
    if (current) args.push(current);
    return args;
  }

  // ─── Built-in commands ────────────────────────────────────────────────

  private cmdCd(params: string[]): { stdout: string; stderr: string; exitCode: number } {
    const target = params[0] || this.env['HOME'] || '/';
    const resolved = this.resolvePath(target);
    if (!this.vfs.existsSync(resolved)) return { stdout: '', stderr: `cd: ${target}: No such file or directory\n`, exitCode: 1 };
    this.cwd = resolved;
    return { stdout: '', stderr: '', exitCode: 0 };
  }

  private cmdLs(params: string[]): { stdout: string; stderr: string; exitCode: number } {
    const showAll = params.includes('-a') || params.includes('-la') || params.includes('-al');
    const longFormat = params.includes('-l') || params.includes('-la') || params.includes('-al');
    const dir = this.resolvePath(params.filter(p => !p.startsWith('-'))[0] || '.');
    const entries = this.vfs.readdirSync(dir, { withFileTypes: true }) as any[];
    let output = '';
    for (const e of entries) {
      if (!showAll && e.name.startsWith('.')) continue;
      if (longFormat) {
        const isDir = e.isDirectory();
        output += `${isDir ? 'd' : '-'}rwxr-xr-x  1 sandbox sandbox  0  ${e.name}${isDir ? '/' : ''}\n`;
      } else {
        output += e.name + (e.isDirectory() ? '/' : '') + '\n';
      }
    }
    return { stdout: output, stderr: '', exitCode: 0 };
  }

  private cmdCat(params: string[], stdin: string): { stdout: string; stderr: string; exitCode: number } {
    if (params.length === 0) return { stdout: stdin, stderr: '', exitCode: 0 };
    let output = '';
    for (const p of params) {
      try {
        output += this.vfs.readFileSync(this.resolvePath(p), 'utf-8') as string;
      } catch {
        return { stdout: output, stderr: `cat: ${p}: No such file or directory\n`, exitCode: 1 };
      }
    }
    return { stdout: output, stderr: '', exitCode: 0 };
  }

  private cmdHead(params: string[], stdin: string): { stdout: string; stderr: string; exitCode: number } {
    const n = parseInt(params.find(p => p.startsWith('-'))?.slice(1) || '10', 10);
    const file = params.find(p => !p.startsWith('-'));
    const content = file ? this.vfs.readFileSync(this.resolvePath(file), 'utf-8') as string : stdin;
    return { stdout: content.split('\n').slice(0, n).join('\n') + '\n', stderr: '', exitCode: 0 };
  }

  private cmdTail(params: string[], stdin: string): { stdout: string; stderr: string; exitCode: number } {
    const n = parseInt(params.find(p => p.startsWith('-'))?.slice(1) || '10', 10);
    const file = params.find(p => !p.startsWith('-'));
    const content = file ? this.vfs.readFileSync(this.resolvePath(file), 'utf-8') as string : stdin;
    const lines = content.split('\n');
    return { stdout: lines.slice(-n).join('\n') + '\n', stderr: '', exitCode: 0 };
  }

  private cmdWc(params: string[], stdin: string): { stdout: string; stderr: string; exitCode: number } {
    const file = params.find(p => !p.startsWith('-'));
    const content = file ? this.vfs.readFileSync(this.resolvePath(file), 'utf-8') as string : stdin;
    const lines = content.split('\n').length - 1;
    const words = content.split(/\s+/).filter(Boolean).length;
    const chars = content.length;
    return { stdout: `  ${lines}  ${words}  ${chars}${file ? ' ' + file : ''}\n`, stderr: '', exitCode: 0 };
  }

  private cmdGrep(params: string[], stdin: string): { stdout: string; stderr: string; exitCode: number } {
    const pattern = params[0];
    if (!pattern) return { stdout: '', stderr: 'grep: missing pattern\n', exitCode: 2 };
    const file = params[1];
    const content = file ? this.vfs.readFileSync(this.resolvePath(file), 'utf-8') as string : stdin;
    const re = new RegExp(pattern, params.includes('-i') ? 'i' : '');
    const matched = content.split('\n').filter(l => re.test(l));
    return { stdout: matched.join('\n') + (matched.length ? '\n' : ''), stderr: '', exitCode: matched.length ? 0 : 1 };
  }

  private cmdSort(stdin: string): { stdout: string; stderr: string; exitCode: number } {
    return { stdout: stdin.split('\n').sort().join('\n'), stderr: '', exitCode: 0 };
  }

  private cmdUniq(stdin: string): { stdout: string; stderr: string; exitCode: number } {
    const lines = stdin.split('\n');
    return { stdout: lines.filter((l, i) => i === 0 || l !== lines[i - 1]).join('\n'), stderr: '', exitCode: 0 };
  }

  private cmdMkdir(params: string[]): { stdout: string; stderr: string; exitCode: number } {
    const recursive = params.includes('-p');
    for (const p of params.filter(x => !x.startsWith('-'))) {
      this.vfs.mkdirSync(this.resolvePath(p), { recursive });
    }
    return { stdout: '', stderr: '', exitCode: 0 };
  }

  private cmdRmdir(params: string[]): { stdout: string; stderr: string; exitCode: number } {
    for (const p of params) this.vfs.rmdirSync(this.resolvePath(p));
    return { stdout: '', stderr: '', exitCode: 0 };
  }

  private cmdRm(params: string[]): { stdout: string; stderr: string; exitCode: number } {
    const recursive = params.some(p => p.includes('r'));
    const force = params.some(p => p.includes('f'));
    for (const p of params.filter(x => !x.startsWith('-'))) {
      this.vfs.rmSync(this.resolvePath(p), { recursive, force });
    }
    return { stdout: '', stderr: '', exitCode: 0 };
  }

  private cmdCp(params: string[]): { stdout: string; stderr: string; exitCode: number } {
    if (params.length < 2) return { stdout: '', stderr: 'cp: missing operand\n', exitCode: 1 };
    const src = this.resolvePath(params[params.length - 2]);
    const dest = this.resolvePath(params[params.length - 1]);
    this.vfs.copyFileSync(src, dest);
    return { stdout: '', stderr: '', exitCode: 0 };
  }

  private cmdMv(params: string[]): { stdout: string; stderr: string; exitCode: number } {
    if (params.length < 2) return { stdout: '', stderr: 'mv: missing operand\n', exitCode: 1 };
    const src = this.resolvePath(params[0]);
    const dest = this.resolvePath(params[1]);
    this.vfs.renameSync(src, dest);
    return { stdout: '', stderr: '', exitCode: 0 };
  }

  private cmdTouch(params: string[]): { stdout: string; stderr: string; exitCode: number } {
    for (const p of params) {
      const resolved = this.resolvePath(p);
      if (!this.vfs.existsSync(resolved)) {
        this.vfs.writeFileSync(resolved, '');
      }
    }
    return { stdout: '', stderr: '', exitCode: 0 };
  }

  private cmdTr(params: string[], stdin: string): { stdout: string; stderr: string; exitCode: number } {
    if (params.length < 2) return { stdout: stdin, stderr: '', exitCode: 0 };
    const from = params[0], to = params[1];
    let output = stdin;
    for (let i = 0; i < from.length && i < to.length; i++) {
      output = output.split(from[i]).join(to[i]);
    }
    return { stdout: output, stderr: '', exitCode: 0 };
  }

  private cmdFind(params: string[]): { stdout: string; stderr: string; exitCode: number } {
    const dir = this.resolvePath(params[0] || '.');
    const results: string[] = [];
    this.findRecursive(dir, results);
    return { stdout: results.join('\n') + '\n', stderr: '', exitCode: 0 };
  }

  private findRecursive(dir: string, results: string[]): void {
    results.push(dir);
    try {
      const entries = this.vfs.readdirSync(dir, { withFileTypes: true }) as any[];
      for (const e of entries) {
        const full = dir === '/' ? `/${e.name}` : `${dir}/${e.name}`;
        if (e.isDirectory()) this.findRecursive(full, results);
        else results.push(full);
      }
    } catch { /* */ }
  }
}
