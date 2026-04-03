import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';

export class TerminalManager {
  readonly xterm: Terminal;
  private readonly fitAddon: FitAddon;
  private resizeObserver: ResizeObserver | null = null;
  private dataHandler: ((data: string) => void) | null = null;

  constructor() {
    this.xterm = new Terminal({
      convertEol: true,
      cursorBlink: true,
      fontSize: 13,
      fontFamily: "'SF Mono', 'Fira Code', 'Cascadia Code', Menlo, monospace",
      theme: {
        background:  '#0d1117',
        foreground:  '#e6edf3',
        cursor:      '#f78166',
        selectionBackground: '#264f78',
        black:       '#484f58',
        brightBlack: '#6e7681',
        red:         '#ff7b72',
        brightRed:   '#ffa198',
        green:       '#3fb950',
        brightGreen: '#56d364',
        yellow:      '#d29922',
        brightYellow:'#e3b341',
        blue:        '#58a6ff',
        brightBlue:  '#79c0ff',
        magenta:     '#bc8cff',
        brightMagenta:'#d2a8ff',
        cyan:        '#39c5cf',
        brightCyan:  '#56d4dd',
        white:       '#b1bac4',
        brightWhite: '#f0f6fc',
      },
      scrollback: 5000,
    });

    this.fitAddon = new FitAddon();
    this.xterm.loadAddon(this.fitAddon);

    // Register onData once in constructor to prevent duplicate handlers on restart
    this.xterm.onData((data: string) => {
      this.dataHandler?.(data);
    });
  }

  /** Mount the terminal into a DOM element and start auto-resize. */
  mount(container: HTMLElement): void {
    this.xterm.open(container);
    this.fitAddon.fit();

    this.resizeObserver = new ResizeObserver(() => {
      try { this.fitAddon.fit(); } catch { /* ignore */ }
    });
    this.resizeObserver.observe(container);

    window.addEventListener('resize', () => {
      try { this.fitAddon.fit(); } catch { /* ignore */ }
    });
  }

  /** Write text/bytes to the terminal display (not to stdin). */
  write(data: string | Uint8Array): void {
    this.xterm.write(data);
  }

  /** Register a handler for user keystrokes (sent to shell stdin).
   * Only one handler can be registered at a time; subsequent calls replace the previous handler.
   */
  onData(handler: (data: string) => void): void {
    this.dataHandler = handler;
  }

  /** Current terminal dimensions for pty resize. */
  get dimensions(): { cols: number; rows: number } {
    return { cols: this.xterm.cols, rows: this.xterm.rows };
  }

  dispose(): void {
    this.resizeObserver?.disconnect();
    this.xterm.dispose();
  }
}
