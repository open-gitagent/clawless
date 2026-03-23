// ─── Buffer polyfill ────────────────────────────────────────────────────────

const enc = new TextEncoder();
const dec = new TextDecoder();

export const BufferPolyfill = {
  from(data: string | Uint8Array | number[] | ArrayBuffer, encoding?: string): Uint8Array & { toString(enc?: string): string } {
    let bytes: Uint8Array;
    if (typeof data === 'string') {
      if (encoding === 'base64') {
        const binary = atob(data);
        bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      } else if (encoding === 'hex') {
        bytes = new Uint8Array(data.length / 2);
        for (let i = 0; i < data.length; i += 2) bytes[i / 2] = parseInt(data.slice(i, i + 2), 16);
      } else {
        bytes = enc.encode(data);
      }
    } else if (data instanceof ArrayBuffer) {
      bytes = new Uint8Array(data);
    } else if (Array.isArray(data)) {
      bytes = new Uint8Array(data);
    } else {
      bytes = new Uint8Array(data);
    }
    return Object.assign(bytes, {
      toString(encoding?: string): string {
        if (encoding === 'base64') { let s = ''; for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]); return btoa(s); }
        if (encoding === 'hex') return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
        return dec.decode(bytes);
      },
      toJSON: () => ({ type: 'Buffer' as const, data: Array.from(bytes) }),
      equals: (other: Uint8Array) => {
        if (bytes.length !== other.length) return false;
        for (let i = 0; i < bytes.length; i++) if (bytes[i] !== other[i]) return false;
        return true;
      },
      copy: (target: Uint8Array, targetStart?: number, sourceStart?: number, sourceEnd?: number) => {
        const slice = bytes.subarray(sourceStart ?? 0, sourceEnd ?? bytes.length);
        target.set(slice, targetStart ?? 0);
        return slice.length;
      },
      write: (str: string, offset?: number) => {
        const encoded = enc.encode(str);
        const o = offset ?? 0;
        bytes.set(encoded.subarray(0, bytes.length - o), o);
        return Math.min(encoded.length, bytes.length - o);
      },
    });
  },

  alloc(size: number, fill?: number): Uint8Array & { toString(enc?: string): string } {
    const buf = new Uint8Array(size);
    if (fill !== undefined) buf.fill(fill);
    return BufferPolyfill.from(buf);
  },

  allocUnsafe(size: number) { return BufferPolyfill.alloc(size); },

  concat(list: Uint8Array[], totalLength?: number) {
    const len = totalLength ?? list.reduce((s, b) => s + b.byteLength, 0);
    const result = new Uint8Array(len);
    let offset = 0;
    for (const buf of list) { result.set(buf, offset); offset += buf.byteLength; }
    return BufferPolyfill.from(result);
  },

  isBuffer(obj: any): boolean { return obj instanceof Uint8Array; },
  isEncoding(e: string): boolean { return ['utf8', 'utf-8', 'ascii', 'base64', 'hex', 'binary', 'latin1'].includes(e.toLowerCase()); },
  byteLength(str: string): number { return enc.encode(str).byteLength; },
};

export default BufferPolyfill;
