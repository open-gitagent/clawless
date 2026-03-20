import type { ContainerManager, ContainerStatus } from './container.js';
import { createEditorInstance, openFileModel, getModelContent, closeFileModel, disposeAll, initMonacoTheme } from './monaco-editor.js';
import type { AuditLog } from './audit.js';
import { PolicyEngine } from './policy.js';
import type { TabDefinition } from './types.js';

// ─── Provider → env var key ──────────────────────────────────────────────────
function providerEnvKey(provider: string): string {
  switch (provider) {
    case 'openai':  return 'OPENAI_API_KEY';
    case 'google':  return 'GOOGLE_API_KEY';
    default:        return 'ANTHROPIC_API_KEY';
  }
}

// ─── Provider → models ───────────────────────────────────────────────────────
const PROVIDER_MODELS: Record<string, string[]> = {
  anthropic: ['anthropic:claude-opus-4-6', 'anthropic:claude-sonnet-4-6', 'anthropic:claude-haiku-4-5'],
  openai:    ['openai:gpt-4o', 'openai:gpt-4o-mini', 'openai:o3-mini'],
  google:    ['google:gemini-2.0-flash', 'google:gemini-2.5-pro'],
};

const LS_PREFIX = 'clawchef_';
const PREVIEW_TAB_PATH = '__preview__';
const AUDIT_TAB_PATH = '__audit__';
const POLICY_TAB_PATH = '__policy__';
const CLOUD_BROWSER_TAB_PATH = '__cloud_browser__';

interface Tab {
  filePath: string;
  filename: string;
}

export class UIManager {
  private container: ContainerManager;
  private audit: AuditLog;
  private policy: PolicyEngine;
  private activePanelId: string | null = null;
  private refreshTimer: ReturnType<typeof setInterval> | null = null;

  // Tab state
  private tabs: Tab[] = [];
  private activeTabPath: string | null = null;

  // Audit tab state
  private auditUnsubscribe: (() => void) | null = null;

  // Git sync state
  private syncInProgress = false;
  private autoSyncTimer: ReturnType<typeof setTimeout> | null = null;
  private cloneInProgress = false;

  // Custom tab tracking
  private customTabPaths = new Set<string>();

  constructor(container: ContainerManager, audit: AuditLog, policy: PolicyEngine) {
    this.container = container;
    this.audit = audit;
    this.policy = policy;
  }

  init(): void {
    initMonacoTheme();
    this.bindTopbarButtons();
    this.bindConfigPanel();
    this.bindPolicyPanel();
    this.bindFileTree();
    this.bindKeyboard();
    this.bindResizeHandles();
    this.populateModelOptions();
    this.restoreConfig();
    this.bindRepoControls();
  }

  /** Auto-open the browser preview tab on initial load. */
  openPreviewOnLoad(): void {
    this.openPreviewTab();
  }

  /** Navigate the preview iframe to a URL and switch to the preview tab. */
  navigatePreview(url: string): void {
    this.openPreviewTab().then(() => {
      const iframe = document.getElementById('preview-iframe') as HTMLIFrameElement;
      const urlInput = document.getElementById('preview-url') as HTMLInputElement;
      const loading = document.getElementById('preview-loading')!;
      if (iframe) {
        iframe.src = url;
        urlInput.value = url;
        loading.classList.remove('hidden');
        iframe.style.visibility = 'hidden';
      }
    });
  }

  setStatus(status: ContainerStatus): void {
    const badge = document.getElementById('container-status')!;
    badge.className = 'status-badge';
    badge.classList.add(`status-${status}`);
    const labels: Record<ContainerStatus, string> = {
      booting: 'booting', installing: 'installing', ready: 'ready', error: 'error',
    };
    badge.textContent = labels[status] ?? status;

    if (status === 'ready') {
      this.startFileTreeRefresh();
      this.startHtmlFileWatcher();
    }
  }

  getSavedConfig() {
    const provider = localStorage.getItem(`${LS_PREFIX}provider`);
    const model    = localStorage.getItem(`${LS_PREFIX}model`);
    const envJson  = localStorage.getItem(`${LS_PREFIX}envVars`);

    // New format
    if (provider && model && envJson) {
      try {
        const envVars = JSON.parse(envJson) as Record<string, string>;
        if (Object.keys(envVars).length > 0) return { provider, model, envVars };
      } catch { /* fall through */ }
    }

    // Migrate old format
    const apiKey = localStorage.getItem(`${LS_PREFIX}apiKey`);
    if (provider && apiKey && model) {
      const envVars: Record<string, string> = { [providerEnvKey(provider)]: apiKey };
      const voiceKey = localStorage.getItem(`${LS_PREFIX}openaiVoiceKey`);
      if (voiceKey) envVars['OPENAI_API_KEY'] = voiceKey;
      return { provider, model, envVars };
    }

    return null;
  }

  showConfigPanel(): void {
    this.openPanel('config-panel');
    document.getElementById('btn-config')!.classList.add('active');
  }

  // ─── Keyboard shortcuts ───────────────────────────────────────────────────

  private bindKeyboard(): void {
    document.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        if (this.activeTabPath) {
          e.preventDefault();
          this.saveActiveFile();
        }
      }
    });
  }

  // ─── Resize handles ───────────────────────────────────────────────────────

  private bindResizeHandles(): void {
    // Filetree ↔ main-content (horizontal)
    this.initHResize('resize-filetree', 'filetree', 'before', 120, 600);

    // Editor ↔ Terminal (vertical)
    this.initVResize('resize-editor-terminal', 'editor-panel', 'terminal-panel', 80, 80);

    // Main-content ↔ sidebar (horizontal)
    this.initHResize('resize-sidebar', 'sidebar', 'after', 150, 600);
  }

  private initHResize(handleId: string, targetId: string, side: 'before' | 'after', min: number, max: number): void {
    const handle = document.getElementById(handleId)!;
    const target = document.getElementById(targetId)!;

    let startX = 0;
    let startW = 0;

    const onMove = (e: MouseEvent) => {
      const delta = e.clientX - startX;
      const newW = Math.min(max, Math.max(min, side === 'before' ? startW + delta : startW - delta));
      target.style.width = `${newW}px`;
    };

    const onUp = () => {
      handle.classList.remove('active');
      document.body.classList.remove('resizing-col');
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };

    handle.addEventListener('mousedown', (e) => {
      e.preventDefault();
      startX = e.clientX;
      startW = target.getBoundingClientRect().width;
      handle.classList.add('active');
      document.body.classList.add('resizing-col');
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  }

  private initVResize(handleId: string, topId: string, _bottomId: string, minTop: number, minBottom: number): void {
    const handle = document.getElementById(handleId)!;
    const topEl = document.getElementById(topId)!;
    const parent = topEl.parentElement!;

    let startY = 0;
    let startH = 0;

    const onMove = (e: MouseEvent) => {
      const parentH = parent.getBoundingClientRect().height;
      const delta = e.clientY - startY;
      const maxH = parentH - minBottom - handle.offsetHeight;
      const newH = Math.min(maxH, Math.max(minTop, startH + delta));
      topEl.style.height = `${newH}px`;
    };

    const onUp = () => {
      handle.classList.remove('active');
      document.body.classList.remove('resizing-row');
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };

    handle.addEventListener('mousedown', (e) => {
      e.preventDefault();
      startY = e.clientY;
      startH = topEl.getBoundingClientRect().height;
      handle.classList.add('active');
      document.body.classList.add('resizing-row');
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  }

  // ─── File Tree ─────────────────────────────────────────────────────────────

  private bindFileTree(): void {
    document.getElementById('btn-refresh-tree')!.addEventListener('click', () =>
      this.refreshFileTree());
  }

  private htmlWatcherStarted = false;

  private startHtmlFileWatcher(): void {
    if (this.htmlWatcherStarted) return;
    this.htmlWatcherStarted = true;

    this.container.onFileChange((path: string) => {
      if (/\.html?$/i.test(path)) {
        this.openHtmlInPreview(path);
      }
    });

    // Also start the native fs watcher in the container
    this.container.startWatching();
  }

  private async openHtmlInPreview(filePath: string): Promise<void> {
    try {
      const content = await this.container.readFile(filePath);
      // Open or switch to the preview tab
      await this.openPreviewTab();
      const iframe = document.getElementById('preview-iframe') as HTMLIFrameElement;
      const urlInput = document.getElementById('preview-url') as HTMLInputElement;
      const loading = document.getElementById('preview-loading')!;
      iframe.srcdoc = content;
      urlInput.value = filePath;
      loading.classList.add('hidden');
      iframe.style.visibility = 'visible';
    } catch {
      // file may have been deleted or unreadable — ignore
    }
  }

  private startFileTreeRefresh(): void {
    this.refreshFileTree();
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    this.refreshTimer = setInterval(() => this.refreshFileTree(), 4000);
  }

  private async refreshFileTree(): Promise<void> {
    const files = await this.container.listWorkspaceFiles();
    const list = document.getElementById('filetree-list')!;
    list.innerHTML = '';

    for (const f of files) {
      const isDir  = f.endsWith('/');
      const name   = f.replace(/\/$/, '').split('/').pop() ?? f;
      const depth  = f.split('/').length - 1;
      const item = document.createElement('div');
      item.className = `ft-item${isDir ? ' is-dir' : ''}`;
      item.dataset['depth'] = String(Math.min(depth, 3));

      const icon = isDir ? svgIcon('folder') : fileIcon(name);
      item.innerHTML = `
        <span class="ft-icon">${icon}</span>
        <span class="ft-name" title="${f}">${name}</span>
      `;

      if (!isDir) {
        item.addEventListener('click', () => this.openFile(f, name));
      }
      list.appendChild(item);
    }

    if (files.length === 0) {
      list.innerHTML = '<div style="padding:12px;color:var(--text-dim);font-size:11px;">No files yet</div>';
    }
  }

  // ─── Tab management ─────────────────────────────────────────────────────────

  private static readonly BINARY_EXTENSIONS = new Set([
    '.pdf', '.ppt', '.pptx', '.doc', '.docx', '.xls', '.xlsx',
    '.zip', '.tar', '.gz', '.rar', '.7z',
    '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico', '.webp', '.svg',
    '.mp3', '.mp4', '.wav', '.avi', '.mov', '.mkv',
    '.exe', '.dll', '.so', '.dylib', '.bin', '.dat',
    '.woff', '.woff2', '.ttf', '.eot', '.otf',
  ]);

  private isBinaryFile(filename: string): boolean {
    const ext = filename.substring(filename.lastIndexOf('.')).toLowerCase();
    return UIManager.BINARY_EXTENSIONS.has(ext);
  }

  private showBinaryDownloadPopup(filename: string, fullPath: string): void {
    const overlay = document.createElement('div');
    overlay.className = 'binary-popup-overlay';
    overlay.innerHTML = `
      <div class="binary-popup">
        <p>Cannot open <strong>${filename}</strong> in the editor.</p>
        <p class="binary-popup-hint">This file type is not supported for preview.</p>
        <div class="binary-popup-actions">
          <button class="btn-primary" id="btn-binary-download">Download to Host</button>
          <button class="btn-secondary" id="btn-binary-cancel">Cancel</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    overlay.querySelector('#btn-binary-cancel')!.addEventListener('click', () => overlay.remove());
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });

    overlay.querySelector('#btn-binary-download')!.addEventListener('click', async () => {
      try {
        const buffer = await this.container.readFileBuffer(fullPath);
        const blob = new Blob([buffer]);
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        a.click();
        URL.revokeObjectURL(url);
      } catch (e) {
        alert(`Failed to download: ${(e as Error).message}`);
      }
      overlay.remove();
    });
  }

  private async openFile(relativePath: string, filename: string): Promise<void> {
    const fullPath = `workspace/${relativePath}`;

    // Binary files: show download popup instead of opening in editor
    if (this.isBinaryFile(filename)) {
      this.showBinaryDownloadPopup(filename, fullPath);
      return;
    }

    // If tab already exists, just switch to it
    if (this.tabs.some(t => t.filePath === fullPath)) {
      this.switchTab(fullPath);
      return;
    }

    // Create new tab
    this.tabs.push({ filePath: fullPath, filename });

    // Show editor panel if hidden
    const editorPanel = document.getElementById('editor-panel')!;
    if (editorPanel.classList.contains('hidden')) {
      editorPanel.classList.remove('hidden');
    }

    // Create editor instance if this is the first file tab
    const editorContainer = document.getElementById('editor-container')!;
    createEditorInstance(editorContainer); // no-op if already created

    // Load file content
    let content = '';
    try {
      content = await this.container.readFile(fullPath) || '(empty)';
    } catch (e) {
      content = `Error: ${(e as Error).message}`;
    }

    openFileModel(fullPath, filename, content);
    this.activeTabPath = fullPath;
    this.updateContentVisibility();
    this.renderTabBar();
  }

  private closeTab(filePath: string): void {
    const idx = this.tabs.findIndex(t => t.filePath === filePath);
    if (idx === -1) return;

    if (filePath === AUDIT_TAB_PATH) {
      if (this.auditUnsubscribe) { this.auditUnsubscribe(); this.auditUnsubscribe = null; }
      document.getElementById('audit-log-list')!.innerHTML = '';
    } else if (filePath !== PREVIEW_TAB_PATH && filePath !== POLICY_TAB_PATH && filePath !== CLOUD_BROWSER_TAB_PATH && !this.customTabPaths.has(filePath)) {
      closeFileModel(filePath);
    }
    this.tabs.splice(idx, 1);

    // Check if any file tabs remain (need editor instance)
    const isSpecial = (p: string) => p === PREVIEW_TAB_PATH || p === AUDIT_TAB_PATH || p === POLICY_TAB_PATH || p === CLOUD_BROWSER_TAB_PATH || this.customTabPaths.has(p);
    const hasFileTabs = this.tabs.some(t => !isSpecial(t.filePath));

    if (this.tabs.length === 0) {
      this.activeTabPath = null;
      disposeAll();
      document.getElementById('editor-panel')!.classList.add('hidden');
    } else if (this.activeTabPath === filePath) {
      const newIdx = Math.min(idx, this.tabs.length - 1);
      this.switchTab(this.tabs[newIdx].filePath);
      return; // switchTab already renders tab bar
    }

    // If no file tabs left, dispose the editor instance
    if (!hasFileTabs) {
      disposeAll();
    }

    this.renderTabBar();
  }

  private switchTab(filePath: string): void {
    const tab = this.tabs.find(t => t.filePath === filePath);
    if (!tab) return;

    this.activeTabPath = filePath;
    if (filePath !== PREVIEW_TAB_PATH && filePath !== AUDIT_TAB_PATH && filePath !== POLICY_TAB_PATH && filePath !== CLOUD_BROWSER_TAB_PATH && !this.customTabPaths.has(filePath)) {
      openFileModel(filePath, tab.filename, ''); // model already cached, content ignored
    }
    if (filePath === AUDIT_TAB_PATH) {
      this.renderAuditLog();
    }
    this.updateContentVisibility();
    this.renderTabBar();
  }

  private renderTabBar(): void {
    const bar = document.getElementById('tab-bar')!;
    bar.innerHTML = '';

    for (const tab of this.tabs) {
      const el = document.createElement('div');
      el.className = `tab${tab.filePath === this.activeTabPath ? ' active' : ''}`;

      const nameSpan = document.createElement('span');
      const isCustom = this.customTabPaths.has(tab.filePath);
      if (isCustom) {
        const id = tab.filePath.replace('__custom_', '').replace('__', '');
        el.setAttribute('data-custom-tab-id', id);
      }
      nameSpan.innerHTML = tab.filePath === PREVIEW_TAB_PATH
        ? `${svgIcon('globe')} Browser`
        : tab.filePath === AUDIT_TAB_PATH
        ? `${svgIcon('activity')} Audit Log`
        : tab.filePath === POLICY_TAB_PATH
        ? `${svgIcon('shield')} Policy`
        : tab.filePath === CLOUD_BROWSER_TAB_PATH
        ? `${svgIcon('cloud')} Cloud Browser`
        : tab.filename;
      el.appendChild(nameSpan);

      const closeBtn = document.createElement('button');
      closeBtn.className = 'tab-close';
      closeBtn.textContent = '×';
      closeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.closeTab(tab.filePath);
      });
      el.appendChild(closeBtn);

      el.addEventListener('click', () => this.switchTab(tab.filePath));
      bar.appendChild(el);
    }
  }

  private async saveActiveFile(): Promise<void> {
    if (!this.activeTabPath || this.activeTabPath === PREVIEW_TAB_PATH || this.activeTabPath === AUDIT_TAB_PATH || this.activeTabPath === POLICY_TAB_PATH || this.activeTabPath === CLOUD_BROWSER_TAB_PATH || this.customTabPaths.has(this.activeTabPath)) return;
    const content = getModelContent(this.activeTabPath);
    try {
      await this.container.writeFile(this.activeTabPath, content);
    } catch {
      // silent fail for now
    }
  }

  // ─── Preview tab ──────────────────────────────────────────────────────────

  private previewBound = false;

  private async openPreviewTab(): Promise<void> {
    // If already open, switch to it
    if (this.tabs.some(t => t.filePath === PREVIEW_TAB_PATH)) {
      this.switchTab(PREVIEW_TAB_PATH);
      return;
    }

    this.tabs.push({ filePath: PREVIEW_TAB_PATH, filename: 'Browser' });

    // Show editor panel if hidden
    const editorPanel = document.getElementById('editor-panel')!;
    if (editorPanel.classList.contains('hidden')) {
      editorPanel.classList.remove('hidden');
    }

    this.activeTabPath = PREVIEW_TAB_PATH;
    this.updateContentVisibility();
    this.renderTabBar();

    const urlInput = document.getElementById('preview-url') as HTMLInputElement;
    const iframe = document.getElementById('preview-iframe') as HTMLIFrameElement;
    const loading = document.getElementById('preview-loading')!;

    if (!this.previewBound) {
      this.previewBound = true;

      // Navigate on Enter
      urlInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          let val = urlInput.value.trim();
          if (val && !val.startsWith('http')) val = 'https://' + val;
          if (val) {
            iframe.src = val;
            loading.classList.remove('hidden');
            iframe.style.visibility = 'hidden';
          }
        }
      });

      // Nav buttons
      document.getElementById('preview-reload')!.addEventListener('click', () => {
        if (iframe.src) iframe.src = iframe.src;
      });
      document.getElementById('preview-back')!.addEventListener('click', () => {
        try { iframe.contentWindow?.history.back(); } catch { /* cross-origin */ }
      });
      document.getElementById('preview-forward')!.addEventListener('click', () => {
        try { iframe.contentWindow?.history.forward(); } catch { /* cross-origin */ }
      });

      // Sync URL bar on iframe load
      iframe.addEventListener('load', () => {
        loading.classList.add('hidden');
        iframe.style.visibility = 'visible';
        try { urlInput.value = iframe.contentWindow?.location.href ?? ''; } catch { /* cross-origin */ }
      });
    }

    // Show welcome page immediately instead of waiting for a server
    iframe.srcdoc = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { background: #0d1117; color: #e6edf3; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif; display: flex; align-items: center; justify-content: center; min-height: 100vh; padding-top: 2.5rem; }
  .welcome { text-align: center; max-width: 480px; padding: 2rem; }
  .welcome-logo { width: 80px; height: 80px; margin-bottom: 0.25rem; border-radius: 16px; }
  h1 { font-size: 1.8rem; margin-bottom: 0.5rem; }
  h1 span { color: #f78166; }
  p.tagline { color: #8b949e; margin-bottom: 1.5rem; font-size: 1rem; }
  ul { list-style: none; text-align: left; }
  ul li { padding: 0.4rem 0; color: #e6edf3; }
  ul li::before { content: '▸ '; color: #f78166; }
  .note-bar { background: #161b22; border-bottom: 1px solid #30363d; padding: 0.5rem 1rem; text-align: center; font-size: 0.8rem; color: #8b949e; position: fixed; top: 0; left: 0; right: 0; z-index: 10; }
  .note-bar span { color: #f78166; }
</style>
</head>
<body>
  <div class="note-bar">Please wait while the Claw Agent gets installed — by default it installs <span>GitClaw</span>, a variant of <span>OpenClaw</span>, but better :)</div>
  <div class="welcome">
    <img class="welcome-logo" src="${window.location.origin}/logo.png" alt="ClawLess logo" />
    <h1>Welcome to <span>ClawLess</span></h1>
    <p class="tagline" style="margin-bottom:0.5rem;font-size:0.75rem;">MIT Licensed | Made with ❤️ by Shreyas Kapale @ <span style="color:#f78166;">Lyzr</span></p>
    <p class="tagline">A ClawContainer — serverless AI agent runtime, entirely in your browser.</p>
    <ul>
      <li>Powered by WebAssembly</li>
      <li>Secure sandboxed execution</li>
      <li>Full auditability of every action</li>
      <li>No remote servers required</li>
      <li>MIT Licensed</li>
    </ul>
    <p class="tagline" style="margin-top:1.5rem;font-size:0.85rem;">Use the address bar above to navigate to any URL.</p>
  </div>
</body>
</html>`;
    loading.classList.add('hidden');
    iframe.style.visibility = 'visible';
  }

  // ─── Cloud Browser tab ──────────────────────────────────────────────────

  private cloudBrowserBound = false;

  private async openCloudBrowserTab(): Promise<void> {
    // If already open, switch to it
    if (this.tabs.some(t => t.filePath === CLOUD_BROWSER_TAB_PATH)) {
      this.switchTab(CLOUD_BROWSER_TAB_PATH);
      return;
    }

    this.tabs.push({ filePath: CLOUD_BROWSER_TAB_PATH, filename: 'Cloud Browser' });

    const editorPanel = document.getElementById('editor-panel')!;
    if (editorPanel.classList.contains('hidden')) {
      editorPanel.classList.remove('hidden');
    }

    this.activeTabPath = CLOUD_BROWSER_TAB_PATH;
    this.updateContentVisibility();
    this.renderTabBar();

    const iframe = document.getElementById('cloud-browser-iframe') as HTMLIFrameElement;
    const loading = document.getElementById('cloud-browser-loading')!;
    const status = document.getElementById('cloud-browser-status')!;
    const urlInput = document.getElementById('cloud-browser-url') as HTMLInputElement;

    if (!this.cloudBrowserBound) {
      this.cloudBrowserBound = true;

      document.getElementById('cloud-browser-reload')!.addEventListener('click', () => {
        if (iframe.src) iframe.src = iframe.src;
      });

      const navigateCloud = () => {
        const val = urlInput.value.trim();
        if (!val) return;
        // The Browserbase live view is interactive — user navigates directly in the iframe.
        // The URL bar here is informational; navigation happens inside the session.
        status.textContent = 'Navigate inside the cloud browser directly.';
      };

      document.getElementById('cloud-browser-go')!.addEventListener('click', navigateCloud);
      urlInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') navigateCloud();
      });

      // Scale iframe to fit viewport
      const viewport = document.getElementById('cloud-browser-viewport')!;
      const scaleIframe = () => {
        const vw = viewport.clientWidth;
        const vh = viewport.clientHeight;
        if (vw === 0 || vh === 0) return;
        const scale = Math.min(vw / 1920, vh / 1080);
        iframe.style.transform = `scale(${scale})`;
        iframe.style.width = '1920px';
        iframe.style.height = '1080px';
      };
      const resizeObserver = new ResizeObserver(scaleIframe);
      resizeObserver.observe(viewport);
      scaleIframe();
    }

    // Read API credentials from localStorage env vars
    const envJson = localStorage.getItem(`${LS_PREFIX}envVars`);
    let apiKey = '';
    let projectId = '';
    if (envJson) {
      try {
        const envVars = JSON.parse(envJson) as Record<string, string>;
        apiKey = envVars['BROWSERBASE_API_KEY'] || '';
        projectId = envVars['BROWSERBASE_PROJECT_ID'] || '';
      } catch { /* ignore */ }
    }

    if (!apiKey || !projectId) {
      loading.textContent = 'Missing BROWSERBASE_API_KEY or BROWSERBASE_PROJECT_ID. Add them in Config panel.';
      status.textContent = 'Not configured';
      return;
    }

    // Create Browserbase session
    loading.textContent = 'Starting cloud browser…';
    loading.classList.remove('hidden');
    iframe.style.visibility = 'hidden';
    status.textContent = 'Connecting…';

    try {
      let res: Response;
      try {
        res = await fetch('/api/browserbase/v1/sessions', {
          method: 'POST',
          headers: {
            'X-BB-API-Key': apiKey,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ projectId }),
        });
      } catch (fetchErr) {
        throw new Error(
          `Network error calling Browserbase API: ${(fetchErr as Error).message}. ` +
          'Check the browser console (F12 → Console) for details.'
        );
      }

      if (!res.ok) {
        let errBody = '';
        try { errBody = await res.text(); } catch { /* ignore */ }
        const detail = errBody ? `: ${errBody}` : '';
        if (res.status === 401 || res.status === 403) {
          throw new Error(`Authentication failed (${res.status})${detail}. Check your BROWSERBASE_API_KEY.`);
        } else if (res.status === 404) {
          throw new Error(`Not found (${res.status})${detail}. Check your BROWSERBASE_PROJECT_ID.`);
        } else if (res.status === 429) {
          throw new Error(`Rate limited (${res.status})${detail}. Try again in a moment.`);
        }
        throw new Error(`Session creation failed (${res.status})${detail}`);
      }

      const session = await res.json();
      if (!session.id) {
        throw new Error(`Unexpected response — no session ID returned: ${JSON.stringify(session)}`);
      }

      // Get debug/live view URL
      let debugRes: Response;
      try {
        debugRes = await fetch(`/api/browserbase/v1/sessions/${session.id}/debug`, {
          headers: { 'X-BB-API-Key': apiKey },
        });
      } catch (fetchErr) {
        throw new Error(
          `Network error fetching debug URL: ${(fetchErr as Error).message}. ` +
          'Check the browser console (F12 → Console) for details.'
        );
      }

      if (!debugRes.ok) {
        let errBody = '';
        try { errBody = await debugRes.text(); } catch { /* ignore */ }
        throw new Error(`Debug URL fetch failed (${debugRes.status})${errBody ? ': ' + errBody : ''}`);
      }

      const debug = await debugRes.json();
      const liveUrl = debug.debuggerFullscreenUrl;

      if (!liveUrl) {
        throw new Error(`No debuggerFullscreenUrl in response: ${JSON.stringify(debug)}`);
      }

      iframe.src = liveUrl;
      urlInput.value = liveUrl;
      status.textContent = 'Connected';

      iframe.addEventListener('load', () => {
        loading.classList.add('hidden');
        iframe.style.visibility = 'visible';
      }, { once: true });
    } catch (e) {
      const errMsg = (e as Error).message;
      loading.textContent = errMsg;
      status.textContent = 'Error';
      console.error('[Cloud Browser]', e);
    }
  }

  /** Show editor-container, preview-container, audit-container, policy-container, cloud-browser-container, or custom tab based on active tab type. */
  private updateContentVisibility(): void {
    const editorContainer = document.getElementById('editor-container')!;
    const previewContainer = document.getElementById('preview-container')!;
    const auditContainer = document.getElementById('audit-container')!;
    const policyContainer = document.getElementById('policy-container')!;
    const cloudBrowserContainer = document.getElementById('cloud-browser-container')!;

    editorContainer.classList.add('hidden');
    previewContainer.classList.add('hidden');
    auditContainer.classList.add('hidden');
    policyContainer.classList.add('hidden');
    cloudBrowserContainer.classList.add('hidden');

    // Hide all custom tab content
    for (const path of this.customTabPaths) {
      const id = path.replace('__custom_', '').replace('__', '');
      document.getElementById(`custom-tab-${id}`)?.classList.add('hidden');
    }

    if (this.activeTabPath === PREVIEW_TAB_PATH) {
      previewContainer.classList.remove('hidden');
    } else if (this.activeTabPath === AUDIT_TAB_PATH) {
      auditContainer.classList.remove('hidden');
    } else if (this.activeTabPath === POLICY_TAB_PATH) {
      policyContainer.classList.remove('hidden');
    } else if (this.activeTabPath === CLOUD_BROWSER_TAB_PATH) {
      cloudBrowserContainer.classList.remove('hidden');
    } else if (this.activeTabPath && this.customTabPaths.has(this.activeTabPath)) {
      const id = this.activeTabPath.replace('__custom_', '').replace('__', '');
      document.getElementById(`custom-tab-${id}`)?.classList.remove('hidden');
    } else {
      editorContainer.classList.remove('hidden');
    }
  }

  // ─── Audit tab ───────────────────────────────────────────────────────────

  private openAuditTab(): void {
    // If already open, switch to it
    if (this.tabs.some(t => t.filePath === AUDIT_TAB_PATH)) {
      this.switchTab(AUDIT_TAB_PATH);
      return;
    }

    this.tabs.push({ filePath: AUDIT_TAB_PATH, filename: 'Audit Log' });

    // Show editor panel if hidden
    const editorPanel = document.getElementById('editor-panel')!;
    if (editorPanel.classList.contains('hidden')) {
      editorPanel.classList.remove('hidden');
    }

    this.activeTabPath = AUDIT_TAB_PATH;
    this.updateContentVisibility();
    this.renderTabBar();
    this.renderAuditLog();
    this.bindAuditFilters();

    // Subscribe to live entries
    this.auditUnsubscribe = this.audit.onEntry((entry) => {
      if (this.activeTabPath !== AUDIT_TAB_PATH) return;
      if (!this.matchesAuditFilters(entry)) return;
      const list = document.getElementById('audit-log-list')!;
      const wasAtBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 30;
      list.appendChild(this.createAuditRow(entry));
      if (wasAtBottom) list.scrollTop = list.scrollHeight;
    });
  }

  private bindAuditFilters(): void {
    const ids = ['audit-search', 'audit-filter-source', 'audit-filter-level', 'audit-filter-event', 'audit-date-from', 'audit-date-to'];
    for (const id of ids) {
      const el = document.getElementById(id)!;
      el.addEventListener('input', () => this.renderAuditLog());
      el.addEventListener('change', () => this.renderAuditLog());
    }

    document.getElementById('btn-audit-download')!.addEventListener('click', () => {
      const json = this.audit.toJSON();
      const blob = new Blob([json], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = 'audit.json'; a.click();
      URL.revokeObjectURL(url);
    });
  }

  private matchesAuditFilters(e: import('./audit.js').AuditEntry): boolean {
    const source = (document.getElementById('audit-filter-source') as HTMLSelectElement).value;
    const level = (document.getElementById('audit-filter-level') as HTMLSelectElement).value;
    const event = (document.getElementById('audit-filter-event') as HTMLSelectElement).value;
    const search = (document.getElementById('audit-search') as HTMLInputElement).value.toLowerCase();
    const dateFrom = (document.getElementById('audit-date-from') as HTMLInputElement).value;
    const dateTo = (document.getElementById('audit-date-to') as HTMLInputElement).value;

    if (source && e.source !== source) return false;
    if (level && e.level !== level) return false;
    if (event && e.event !== event) return false;
    if (dateFrom && e.timestamp < new Date(dateFrom).toISOString()) return false;
    if (dateTo && e.timestamp > new Date(dateTo).toISOString()) return false;
    if (search) {
      const hay = `${e.detail} ${e.event} ${e.source ?? ''} ${e.meta ? JSON.stringify(e.meta) : ''}`.toLowerCase();
      if (!hay.includes(search)) return false;
    }
    return true;
  }

  private renderAuditLog(): void {
    const list = document.getElementById('audit-log-list')!;
    list.innerHTML = '';
    const entries = this.audit.getEntries().filter(e => this.matchesAuditFilters(e));
    for (const entry of entries) {
      list.appendChild(this.createAuditRow(entry));
    }
    list.scrollTop = list.scrollHeight;
  }

  private createAuditRow(e: import('./audit.js').AuditEntry): HTMLElement {
    const row = document.createElement('div');
    row.className = 'audit-row';

    const ts = e.timestamp.slice(11, 23); // HH:mm:ss.mmm
    const lvl = (e.level ?? 'info');
    const src = e.source ?? 'system';

    row.innerHTML =
      `<span class="audit-ts">${ts}</span>` +
      `<span class="audit-level audit-level-${lvl}">${lvl}</span>` +
      `<span class="audit-source">${src}</span>` +
      `<span class="audit-event">${e.event}</span>` +
      `<span class="audit-detail" title="${this.escHtml(e.detail)}">${this.escHtml(e.detail)}</span>` +
      (e.meta ? `<span class="audit-meta">${this.escHtml(JSON.stringify(e.meta))}</span>` : '');

    return row;
  }

  private escHtml(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // ─── Topbar ────────────────────────────────────────────────────────────────

  private bindTopbarButtons(): void {
    document.getElementById('btn-preview')!.addEventListener('click', () =>
      this.openPreviewTab());

    document.getElementById('btn-config')!.addEventListener('click', () =>
      this.togglePanel('config-panel', 'btn-config'));

    document.getElementById('btn-policy')!.addEventListener('click', () =>
      this.openPolicyTab());

    document.getElementById('btn-audit')!.addEventListener('click', () =>
      this.openAuditTab());

    document.getElementById('btn-cloud-browser')!.addEventListener('click', () =>
      this.openCloudBrowserTab());
  }

  // ─── Repo controls (clone / sync / auto-sync) ────────────────────────────

  private bindRepoControls(): void {
    const urlInput = document.getElementById('repo-url-input') as HTMLInputElement;
    const btnClone = document.getElementById('btn-clone')!;
    const btnSync = document.getElementById('btn-sync')!;
    const autoSyncCb = document.getElementById('auto-sync-checkbox') as HTMLInputElement;

    btnClone.addEventListener('click', () => this.handleClone(urlInput));
    btnSync.addEventListener('click', () => this.handleSync(btnSync));

    autoSyncCb.addEventListener('change', () => {
      if (autoSyncCb.checked && this.container.hasClonedRepo) {
        this.startAutoSync();
      } else {
        this.stopAutoSync();
      }
    });
  }

  private async handleClone(urlInput: HTMLInputElement): Promise<void> {
    if (this.cloneInProgress) return;
    const url = urlInput.value.trim();
    if (!url) { urlInput.focus(); return; }

    // Get GITHUB_TOKEN from saved env vars
    const config = this.getSavedConfig();
    const token = config?.envVars?.['GITHUB_TOKEN'] ?? '';
    if (!token) {
      alert('Please add a GITHUB_TOKEN in API Keys & Config before cloning.');
      return;
    }

    this.cloneInProgress = true;
    const btnClone = document.getElementById('btn-clone')!;
    btnClone.classList.add('syncing');

    try {
      await this.container.cloneRepo(url, token);
      document.getElementById('btn-sync')!.removeAttribute('disabled');
      this.refreshFileTree();
    } catch (e) {
      alert(`Clone failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      this.cloneInProgress = false;
      btnClone.classList.remove('syncing');
    }
  }

  private async handleSync(btnSync: HTMLElement): Promise<void> {
    if (this.syncInProgress || !this.container.hasClonedRepo) return;
    this.syncInProgress = true;
    btnSync.classList.add('syncing');

    try {
      await this.container.syncToRepo();
    } catch (e) {
      alert(`Sync failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      this.syncInProgress = false;
      btnSync.classList.remove('syncing');
    }
  }

  private startAutoSync(): void {
    if (!this.container.hasClonedRepo) return;
    // Listen for file changes with debounce
    this.container.onFileChange((path: string) => {
      // Skip ignored paths
      if (/node_modules\/|\.git\/|\.env$/.test(path)) return;
      if (this.cloneInProgress || this.syncInProgress) return;

      if (this.autoSyncTimer) clearTimeout(this.autoSyncTimer);
      this.autoSyncTimer = setTimeout(() => {
        this.autoSyncTimer = null;
        const btnSync = document.getElementById('btn-sync')!;
        this.handleSync(btnSync);
      }, 3000);
    });
  }

  private stopAutoSync(): void {
    if (this.autoSyncTimer) {
      clearTimeout(this.autoSyncTimer);
      this.autoSyncTimer = null;
    }
  }

  // ─── Config panel ──────────────────────────────────────────────────────────

  private bindConfigPanel(): void {
    const providerSel = document.getElementById('provider-select') as HTMLSelectElement;
    providerSel.addEventListener('change', () => {
      this.populateModelOptions();
      this.syncDefaultEnvKey();
    });
    document.getElementById('btn-add-env')!.addEventListener('click', () =>
      this.addEnvRow('', ''));
    document.getElementById('btn-save-config')!.addEventListener('click', () =>
      this.saveConfig());
  }

  private populateModelOptions(): void {
    const provider = (document.getElementById('provider-select') as HTMLSelectElement).value;
    const modelSel = document.getElementById('model-select') as HTMLSelectElement;
    modelSel.innerHTML = '';
    for (const m of PROVIDER_MODELS[provider] ?? []) {
      const opt = document.createElement('option');
      opt.value = m; opt.textContent = m.split(':')[1];
      modelSel.appendChild(opt);
    }
  }

  /** Ensure the first env row key matches the selected provider. */
  private syncDefaultEnvKey(): void {
    const provider = (document.getElementById('provider-select') as HTMLSelectElement).value;
    const keyName = providerEnvKey(provider);
    const rows = document.getElementById('env-rows')!;
    const firstKey = rows.querySelector('.env-key') as HTMLInputElement | null;
    if (firstKey) firstKey.value = keyName;
  }

  private addEnvRow(key: string, value: string): HTMLDivElement {
    const rows = document.getElementById('env-rows')!;
    const row = document.createElement('div');
    row.className = 'env-row';

    const keyInput = document.createElement('input');
    keyInput.type = 'text';
    keyInput.className = 'env-key';
    keyInput.placeholder = 'KEY_NAME';
    keyInput.value = key;

    const valInput = document.createElement('input');
    valInput.type = 'password';
    valInput.className = 'env-val';
    valInput.placeholder = 'value';
    valInput.value = value;

    const removeBtn = document.createElement('button');
    removeBtn.className = 'btn-remove-env';
    removeBtn.textContent = '\u00d7';
    removeBtn.title = 'Remove';
    removeBtn.addEventListener('click', () => row.remove());

    row.appendChild(keyInput);
    row.appendChild(valInput);
    row.appendChild(removeBtn);
    rows.appendChild(row);
    return row;
  }

  private getEnvRows(): Record<string, string> {
    const vars: Record<string, string> = {};
    const rows = document.querySelectorAll('#env-rows .env-row');
    for (const row of rows) {
      const k = (row.querySelector('.env-key') as HTMLInputElement).value.trim();
      const v = (row.querySelector('.env-val') as HTMLInputElement).value.trim();
      if (k && v) vars[k] = v;
    }
    return vars;
  }

  private restoreConfig(): void {
    const provider = localStorage.getItem(`${LS_PREFIX}provider`);
    const model    = localStorage.getItem(`${LS_PREFIX}model`);
    const envJson  = localStorage.getItem(`${LS_PREFIX}envVars`);

    if (provider) {
      (document.getElementById('provider-select') as HTMLSelectElement).value = provider;
      this.populateModelOptions();
    }
    if (model) setTimeout(() => {
      (document.getElementById('model-select') as HTMLSelectElement).value = model;
    }, 0);

    // Restore env var rows
    let envVars: Record<string, string> = {};
    if (envJson) {
      try { envVars = JSON.parse(envJson); } catch { /* ignore */ }
    }

    // Migrate from old format if no envVars saved yet
    if (!envJson) {
      const oldKey = localStorage.getItem(`${LS_PREFIX}apiKey`);
      const oldVoice = localStorage.getItem(`${LS_PREFIX}openaiVoiceKey`);
      const prov = provider ?? 'anthropic';
      if (oldKey) envVars[providerEnvKey(prov)] = oldKey;
      if (oldVoice) envVars['OPENAI_API_KEY'] = oldVoice;
    }

    if (Object.keys(envVars).length === 0) {
      // Add a default empty row for the selected provider
      const prov = provider ?? 'anthropic';
      this.addEnvRow(providerEnvKey(prov), '');
    } else {
      for (const [k, v] of Object.entries(envVars)) {
        this.addEnvRow(k, v);
      }
    }
  }

  private async saveConfig(): Promise<void> {
    const provider = (document.getElementById('provider-select') as HTMLSelectElement).value;
    const model    = (document.getElementById('model-select') as HTMLSelectElement).value;
    const envVars  = this.getEnvRows();
    const msg      = document.getElementById('config-message')!;

    if (Object.keys(envVars).length === 0) {
      showMsg(msg, 'At least one environment variable is required.', 'error');
      return;
    }

    localStorage.setItem(`${LS_PREFIX}provider`, provider);
    localStorage.setItem(`${LS_PREFIX}model`,    model);
    localStorage.setItem(`${LS_PREFIX}envVars`,  JSON.stringify(envVars));

    try {
      await this.container.configureEnv({ provider, model, envVars });
      showMsg(msg, 'Saved. Restart gitclaw (/quit) to apply.', 'success');
    } catch (e) {
      showMsg(msg, `Error: ${(e as Error).message}`, 'error');
    }
  }

  // ─── Policy tab ───────────────────────────────────────────────────────────

  private openPolicyTab(): void {
    if (this.tabs.some(t => t.filePath === POLICY_TAB_PATH)) {
      this.switchTab(POLICY_TAB_PATH);
      return;
    }

    this.tabs.push({ filePath: POLICY_TAB_PATH, filename: 'Policy' });

    const editorPanel = document.getElementById('editor-panel')!;
    if (editorPanel.classList.contains('hidden')) {
      editorPanel.classList.remove('hidden');
    }

    this.loadPolicyYaml();
    this.activeTabPath = POLICY_TAB_PATH;
    this.updateContentVisibility();
    this.renderTabBar();
  }

  private bindPolicyPanel(): void {
    document.getElementById('btn-apply-policy')!.addEventListener('click', () =>
      this.applyPolicyYaml());
    document.getElementById('btn-reset-policy')!.addEventListener('click', () =>
      this.resetPolicy());
  }

  private loadPolicyYaml(): void {
    (document.getElementById('policy-yaml-editor') as HTMLTextAreaElement).value =
      this.policy.toYaml();
  }

  private applyPolicyYaml(): void {
    const yaml = (document.getElementById('policy-yaml-editor') as HTMLTextAreaElement).value;
    const msg = document.getElementById('policy-message')!;
    try {
      const parsed = PolicyEngine.fromYaml(yaml);
      this.policy.loadPolicy(parsed);
      localStorage.setItem('clawchef_policy', yaml);
      this.audit.log('policy.load', 'Policy updated from UI', undefined, { source: 'user' });
      showMsg(msg, 'Policy applied.', 'success');
    } catch (e) {
      showMsg(msg, `Invalid policy: ${(e as Error).message}`, 'error');
    }
  }

  private resetPolicy(): void {
    const defaultPolicy = PolicyEngine.defaultPolicy();
    this.policy.loadPolicy(defaultPolicy);
    localStorage.removeItem('clawchef_policy');
    this.audit.log('policy.load', 'Policy reset to default', undefined, { source: 'user' });
    this.loadPolicyYaml();
    const msg = document.getElementById('policy-message')!;
    showMsg(msg, 'Policy reset to default.', 'success');
  }

  // ─── Panel helpers ─────────────────────────────────────────────────────────

  private togglePanel(panelId: string, btnId: string): void {
    const sidebar = document.getElementById('sidebar')!;
    const btn     = document.getElementById(btnId)!;

    if (this.activePanelId === panelId) {
      sidebar.classList.add('sidebar-hidden');
      btn.classList.remove('active');
      this.activePanelId = null;
    } else {
      this.openPanel(panelId);
      document.querySelectorAll('.btn-icon').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
    }
  }

  private openPanel(panelId: string): void {
    document.getElementById('sidebar')!.classList.remove('sidebar-hidden');
    document.querySelectorAll('.panel').forEach(p => p.classList.add('hidden'));
    document.getElementById(panelId)!.classList.remove('hidden');
    this.activePanelId = panelId;
  }

  // ─── Custom tab API ─────────────────────────────────────────────────────────

  /** Add a custom tab with user-defined content. */
  addCustomTab(def: TabDefinition): void {
    const tabPath = `__custom_${def.id}__`;

    // If tab already open, switch to it
    if (this.tabs.some(t => t.filePath === tabPath)) {
      this.switchTab(tabPath);
      return;
    }

    // Create content container inside editor-panel
    const editorPanel = document.getElementById('editor-panel')!;
    const contentDiv = document.createElement('div');
    contentDiv.id = `custom-tab-${def.id}`;
    contentDiv.className = 'custom-tab-content hidden';
    contentDiv.style.cssText = 'position:absolute;inset:0;overflow:auto;padding:1rem;';

    if (typeof def.render === 'string') {
      contentDiv.innerHTML = def.render;
    } else {
      def.render(contentDiv);
    }

    editorPanel.appendChild(contentDiv);

    // Track as custom
    this.customTabPaths.add(tabPath);

    // Add tab
    this.tabs.push({ filePath: tabPath, filename: def.label });

    if (editorPanel.classList.contains('hidden')) {
      editorPanel.classList.remove('hidden');
    }

    this.activeTabPath = tabPath;
    this.updateContentVisibility();
    this.renderTabBar();
  }

  /** Remove a custom tab by its definition id. */
  removeCustomTab(id: string): void {
    const tabPath = `__custom_${id}__`;
    this.customTabPaths.delete(tabPath);

    // Remove content div
    const contentDiv = document.getElementById(`custom-tab-${id}`);
    contentDiv?.remove();

    // Close the tab
    this.closeTab(tabPath);
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function showMsg(el: HTMLElement, text: string, type: 'success'|'error'|'info'): void {
  el.textContent = text;
  el.className = `message ${type}`;
}

function fileIcon(name: string): string {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  if (ext === 'md')                        return svgIcon('file-text');
  if (ext === 'yaml' || ext === 'yml')     return svgIcon('settings');
  if (ext === 'json')                      return svgIcon('braces');
  if (ext === 'ts' || ext === 'tsx')       return svgIcon('file-code');
  if (ext === 'js' || ext === 'jsx')       return svgIcon('file-code');
  if (ext === 'sh' || ext === 'bash')      return svgIcon('terminal');
  if (ext === 'py')                        return svgIcon('file-code');
  if (['png','jpg','jpeg','gif','svg'].includes(ext)) return svgIcon('image');
  if (['pdf','pptx','ppt'].includes(ext))  return svgIcon('file-text');
  if (['xlsx','xls','csv'].includes(ext))  return svgIcon('table');
  if (['zip','tar','gz'].includes(ext))    return svgIcon('package');
  if (['mp4','mp3'].includes(ext))         return svgIcon('film');
  return svgIcon('file');
}

/** Inline SVG icons — no external dependency needed. */
function svgIcon(name: string): string {
  const s = `width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"`;
  const icons: Record<string, string> = {
    folder:      `<svg ${s}><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>`,
    globe:       `<svg ${s}><circle cx="12" cy="12" r="10"/><path d="M2 12h20"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>`,
    file:        `<svg ${s}><path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><polyline points="13 2 13 9 20 9"/></svg>`,
    'file-text': `<svg ${s}><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>`,
    'file-code': `<svg ${s}><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><polyline points="10 15.5 8 13.5 10 11.5"/><polyline points="14 11.5 16 13.5 14 15.5"/></svg>`,
    settings:    `<svg ${s}><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1.08-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>`,
    braces:      `<svg ${s}><path d="M8 3H7a2 2 0 0 0-2 2v5a2 2 0 0 1-2 2 2 2 0 0 1 2 2v5a2 2 0 0 0 2 2h1"/><path d="M16 3h1a2 2 0 0 1 2 2v5a2 2 0 0 0 2 2 2 2 0 0 0-2 2v5a2 2 0 0 1-2 2h-1"/></svg>`,
    terminal:    `<svg ${s}><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>`,
    image:       `<svg ${s}><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>`,
    table:       `<svg ${s}><path d="M9 3H5a2 2 0 0 0-2 2v4m6-6h10a2 2 0 0 1 2 2v4M9 3v18m0 0h10a2 2 0 0 0 2-2V9M9 21H5a2 2 0 0 1-2-2V9m0 0h18"/></svg>`,
    package:     `<svg ${s}><line x1="16.5" y1="9.4" x2="7.5" y2="4.21"/><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></svg>`,
    film:        `<svg ${s}><rect x="2" y="2" width="20" height="20" rx="2.18" ry="2.18"/><line x1="7" y1="2" x2="7" y2="22"/><line x1="17" y1="2" x2="17" y2="22"/><line x1="2" y1="12" x2="22" y2="12"/><line x1="2" y1="7" x2="7" y2="7"/><line x1="2" y1="17" x2="7" y2="17"/><line x1="17" y1="7" x2="22" y2="7"/><line x1="17" y1="17" x2="22" y2="17"/></svg>`,
    activity:    `<svg ${s}><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>`,
    shield:      `<svg ${s}><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>`,
    cloud:       `<svg ${s}><path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z"/></svg>`,
  };
  return icons[name] ?? icons['file'];
}
