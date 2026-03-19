// ─── Generic WebContainer Audit Log ─────────────────────────────────────────

export type AuditSource = 'boot' | 'user' | 'agent' | 'system' | 'policy';
export type AuditLevel = 'info' | 'warn' | 'error';

export type AuditEvent =
  | 'process.spawn'
  | 'process.exit'
  | 'file.read'
  | 'file.write'
  | 'io.stdout'
  | 'io.stdin'
  | 'env.configure'
  | 'server.ready'
  | 'status.change'
  | 'policy.deny'
  | 'policy.load'
  | 'boot.mount'
  | 'net.request'
  | 'net.response'
  | 'git.clone'
  | 'git.push'
  | 'file.upload'
  | 'context.inject';

export interface AuditEntry {
  timestamp: string;
  event: AuditEvent;
  detail: string;
  meta?: Record<string, unknown>;
  source?: AuditSource;
  level?: AuditLevel;
}

const IO_BUFFER_MS = 500;
const IO_MAX_CHARS = 2000;
const NET_BODY_MAX_CHARS = 4000;

const SENSITIVE_HEADER_KEYS = /^(authorization|x-api-key|api-key|x-goog-api-key)$/i;
const SENSITIVE_HEADER_PARTIAL = /secret|token/i;

/** Order in which source sections appear in toText(). */
const SOURCE_ORDER: AuditSource[] = ['boot', 'system', 'policy', 'user', 'agent'];

export class AuditLog {
  private entries: AuditEntry[] = [];
  private listeners: Array<(entry: AuditEntry) => void> = [];

  // Throttle buffers for stdout/stdin
  private stdoutBuf = '';
  private stdinBuf = '';
  private stdoutTimer: ReturnType<typeof setTimeout> | null = null;
  private stdinTimer: ReturnType<typeof setTimeout> | null = null;

  /** Return a snapshot of all entries. */
  getEntries(): AuditEntry[] {
    return this.entries;
  }

  /** Subscribe to new entries. Returns unsubscribe function. */
  onEntry(fn: (entry: AuditEntry) => void): () => void {
    this.listeners.push(fn);
    return () => { this.listeners = this.listeners.filter(l => l !== fn); };
  }

  /** Append an audit entry. */
  log(
    event: AuditEvent,
    detail: string,
    meta?: Record<string, unknown>,
    opts?: { source?: AuditSource; level?: AuditLevel },
  ): void {
    const entry: AuditEntry = {
      timestamp: new Date().toISOString(),
      event,
      detail,
      ...(meta ? { meta } : {}),
      source: opts?.source ?? 'system',
      level: opts?.level ?? 'info',
    };
    this.entries.push(entry);
    for (const fn of this.listeners) fn(entry);
  }

  /** Buffer stdout data; flushes after 500ms of quiet. */
  logStdout(data: string): void {
    this.stdoutBuf += data;
    if (this.stdoutTimer) clearTimeout(this.stdoutTimer);
    this.stdoutTimer = setTimeout(() => {
      const text = this.stdoutBuf.slice(0, IO_MAX_CHARS);
      this.stdoutBuf = '';
      this.stdoutTimer = null;
      this.log('io.stdout', text.length < this.stdoutBuf.length + text.length
        ? text + '…[truncated]' : text, undefined, { source: 'agent' });
    }, IO_BUFFER_MS);
  }

  /** Buffer stdin data; flushes after 500ms of quiet. */
  logStdin(data: string): void {
    this.stdinBuf += data;
    if (this.stdinTimer) clearTimeout(this.stdinTimer);
    this.stdinTimer = setTimeout(() => {
      const text = this.stdinBuf.slice(0, IO_MAX_CHARS);
      this.stdinBuf = '';
      this.stdinTimer = null;
      this.log('io.stdin', text.length < this.stdinBuf.length + text.length
        ? text + '…[truncated]' : text, undefined, { source: 'agent' });
    }, IO_BUFFER_MS);
  }

  /** Format all entries as downloadable text, grouped by source. */
  toText(): string {
    if (this.entries.length === 0) return '=== AUDIT LOG (empty) ===';

    const first = this.entries[0].timestamp;
    const last = this.entries[this.entries.length - 1].timestamp;

    const lines: string[] = [];
    lines.push(`=== AUDIT LOG (${first} — ${last}) ===`);
    lines.push(`Total entries: ${this.entries.length}`);

    // Group entries by source
    const grouped = new Map<AuditSource, AuditEntry[]>();
    for (const entry of this.entries) {
      const src = entry.source ?? 'system';
      if (!grouped.has(src)) grouped.set(src, []);
      grouped.get(src)!.push(entry);
    }

    for (const source of SOURCE_ORDER) {
      const entries = grouped.get(source);
      if (!entries || entries.length === 0) continue;

      const label = source.toUpperCase();
      lines.push('');
      lines.push(`── ${label} ${'─'.repeat(Math.max(0, 40 - label.length - 4))}`);

      for (const e of entries) {
        const time = e.timestamp.slice(11, 19); // HH:mm:ss
        const lvl = (e.level ?? 'info').toUpperCase().padEnd(5);
        let line = `[${time}] ${lvl} ${e.event.padEnd(16)} ${e.detail}`;
        if (e.meta) line += `  ${JSON.stringify(e.meta)}`;
        lines.push(line);
      }
    }

    return lines.join('\n');
  }

  /** Export all entries as indented JSON. */
  toJSON(): string {
    return JSON.stringify(
      {
        exported: new Date().toISOString(),
        count: this.entries.length,
        entries: this.entries,
      },
      null,
      2,
    );
  }

  /** Filter entries by source, level, and/or event type. */
  filter(opts: { source?: AuditSource; level?: AuditLevel; event?: AuditEvent }): AuditEntry[] {
    return this.entries.filter(e => {
      if (opts.source && e.source !== opts.source) return false;
      if (opts.level && e.level !== opts.level) return false;
      if (opts.event && e.event !== opts.event) return false;
      return true;
    });
  }

  /** Mask a secret key: show first 7 + last 4 chars. */
  static maskKey(val: string): string {
    if (val.length <= 12) return '****';
    return `${val.slice(0, 7)}…${val.slice(-4)}`;
  }

  /** Mask sensitive header values (authorization, api-key, tokens, etc.). */
  static maskHeaders(headers: Record<string, string>): Record<string, string> {
    const masked: Record<string, string> = {};
    for (const [k, v] of Object.entries(headers)) {
      if (SENSITIVE_HEADER_KEYS.test(k) || SENSITIVE_HEADER_PARTIAL.test(k)) {
        masked[k] = AuditLog.maskKey(v);
      } else {
        masked[k] = v;
      }
    }
    return masked;
  }

  /** Truncate a request/response body for audit logging. */
  static truncateBody(body: string | undefined): string | undefined {
    if (!body) return body;
    if (body.length <= NET_BODY_MAX_CHARS) return body;
    return body.slice(0, NET_BODY_MAX_CHARS) + '…[truncated]';
  }
}
