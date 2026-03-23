import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

// ─── sharp ───────────────────────────────────────────────────────────────────

describe('sharp stub', () => {
  const sharp = require(path.join(__dirname, 'stubs/sharp/index.cjs'));

  it('exports a callable function', () => {
    expect(typeof sharp).toBe('function');
  });

  it('returns a chainable builder', () => {
    const builder = sharp(Buffer.alloc(0));
    expect(builder.resize()).toBe(builder);
    expect(builder.jpeg()).toBe(builder);
    expect(builder.png()).toBe(builder);
  });

  it('toBuffer resolves to an empty Buffer', async () => {
    const buf = await sharp().resize().toBuffer();
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf.length).toBe(0);
  });

  it('metadata includes hasAlpha and channels', async () => {
    const meta = await sharp().metadata();
    expect(meta).toHaveProperty('hasAlpha', false);
    expect(meta).toHaveProperty('channels', 0);
    expect(meta).toHaveProperty('width', 0);
    expect(meta).toHaveProperty('height', 0);
  });

  it('has static methods', () => {
    expect(typeof sharp.cache).toBe('function');
    expect(typeof sharp.concurrency).toBe('function');
  });
});

// ─── @lydell/node-pty ────────────────────────────────────────────────────────

describe('node-pty stub', () => {
  const pty = require(path.join(__dirname, 'stubs/lydell-node-pty/index.cjs'));

  it('exports spawn function', () => {
    expect(typeof pty.spawn).toBe('function');
  });

  it('spawn throws with descriptive error', () => {
    expect(() => pty.spawn('bash', [])).toThrow(/unavailable/i);
  });
});

// ─── playwright-core ─────────────────────────────────────────────────────────

describe('playwright-core stub', () => {
  const pw = require(path.join(__dirname, 'stubs/playwright-core/index.cjs'));

  it('exports browser types', () => {
    expect(pw.chromium).toBeDefined();
    expect(pw.firefox).toBeDefined();
    expect(pw.webkit).toBeDefined();
  });

  it('chromium.launch rejects with descriptive error', async () => {
    await expect(pw.chromium.launch()).rejects.toThrow(/unavailable/i);
  });

  it('exports devices as empty object', () => {
    expect(pw.devices).toEqual({});
  });

  it('exports TimeoutError class', () => {
    expect(pw.errors.TimeoutError).toBeDefined();
    expect(new pw.errors.TimeoutError()).toBeInstanceOf(Error);
  });
});

// ─── sqlite-vec ──────────────────────────────────────────────────────────────

describe('sqlite-vec stub', () => {
  const sv = require(path.join(__dirname, 'stubs/sqlite-vec/index.cjs'));

  it('exports load as no-op', () => {
    expect(typeof sv.load).toBe('function');
    expect(sv.load()).toBeUndefined();
  });

  it('exports getLoadablePath returning empty string', () => {
    expect(sv.getLoadablePath()).toBe('');
  });
});

// ─── node-llama-cpp ──────────────────────────────────────────────────────────

describe('node-llama-cpp stub', () => {
  const llama = require(path.join(__dirname, 'stubs/node-llama-cpp/index.cjs'));

  it('getLlama rejects with descriptive error', async () => {
    await expect(llama.getLlama()).rejects.toThrow(/unavailable/i);
  });

  it('LlamaModel constructor throws', () => {
    expect(() => new llama.LlamaModel()).toThrow(/unavailable/i);
  });

  it('exports resolveModelFile', async () => {
    expect(typeof llama.resolveModelFile).toBe('function');
    await expect(llama.resolveModelFile()).rejects.toThrow(/unavailable/i);
  });

  it('exports LlamaLogLevel with expected levels', () => {
    expect(llama.LlamaLogLevel).toBeDefined();
    expect(typeof llama.LlamaLogLevel.error).toBe('number');
    expect(typeof llama.LlamaLogLevel.warn).toBe('number');
  });
});
