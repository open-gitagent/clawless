// ─── events polyfill (EventEmitter) ─────────────────────────────────────────

export class EventEmitter {
  private _events: Record<string, Function[]> = {};
  private _maxListeners = 10;

  on(event: string, fn: Function): this {
    if (!this._events[event]) this._events[event] = [];
    this._events[event].push(fn);
    return this;
  }

  addListener(event: string, fn: Function): this { return this.on(event, fn); }

  once(event: string, fn: Function): this {
    const wrapper = (...args: any[]) => { this.removeListener(event, wrapper); fn.apply(this, args); };
    (wrapper as any)._original = fn;
    return this.on(event, wrapper);
  }

  off(event: string, fn: Function): this { return this.removeListener(event, fn); }

  removeListener(event: string, fn: Function): this {
    const list = this._events[event];
    if (!list) return this;
    this._events[event] = list.filter(f => f !== fn && (f as any)._original !== fn);
    return this;
  }

  removeAllListeners(event?: string): this {
    if (event) delete this._events[event];
    else this._events = {};
    return this;
  }

  emit(event: string, ...args: any[]): boolean {
    const list = this._events[event];
    if (!list || list.length === 0) return false;
    for (const fn of [...list]) { try { fn.apply(this, args); } catch { /* */ } }
    return true;
  }

  listenerCount(event: string): number {
    return this._events[event]?.length ?? 0;
  }

  listeners(event: string): Function[] {
    return [...(this._events[event] || [])];
  }

  rawListeners(event: string): Function[] { return this.listeners(event); }

  eventNames(): string[] {
    return Object.keys(this._events).filter(k => this._events[k].length > 0);
  }

  setMaxListeners(n: number): this { this._maxListeners = n; return this; }
  getMaxListeners(): number { return this._maxListeners; }

  prependListener(event: string, fn: Function): this {
    if (!this._events[event]) this._events[event] = [];
    this._events[event].unshift(fn);
    return this;
  }

  prependOnceListener(event: string, fn: Function): this {
    const wrapper = (...args: any[]) => { this.removeListener(event, wrapper); fn.apply(this, args); };
    (wrapper as any)._original = fn;
    return this.prependListener(event, wrapper);
  }
}

export default EventEmitter;
