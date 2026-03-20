import { ClawContainer } from './sdk.js';

// ─── Template Selection → Boot ──────────────────────────────────────────────

function waitForTemplateSelection(): Promise<string> {
  return new Promise((resolve) => {
    // Pre-select the last used template (but still require a click)
    const saved = localStorage.getItem('clawchef_template');
    const buttons = document.querySelectorAll<HTMLButtonElement>('.tpl-btn');
    if (saved) {
      buttons.forEach((btn) => {
        if (btn.dataset['template'] === saved) btn.classList.add('tpl-btn-last');
      });
    }

    buttons.forEach((btn) => {
      btn.addEventListener('click', () => {
        const template = btn.dataset['template'] ?? 'gitclaw';
        localStorage.setItem('clawchef_template', template);
        resolve(template);
      });
    });
  });
}

async function boot() {
  const template = await waitForTemplateSelection();

  // Hide picker, show loading status
  const picker = document.getElementById('template-picker');
  const status = document.getElementById('loading-status');
  const progressBar = status?.nextElementSibling as HTMLElement | null;
  if (picker) picker.style.display = 'none';
  if (status) status.style.display = '';
  if (progressBar) progressBar.style.display = '';

  const cc = new ClawContainer('#app', { template });
  cc.start().catch(console.error);

  // Expose SDK globally for console access and external scripts
  (window as any).clawcontainer = cc;
}

boot();
