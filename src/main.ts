import { ClawContainer } from './sdk.js';

async function main() {
  const registry = ClawContainer.templates;

  if (registry.size <= 1) {
    const cc = new ClawContainer('#app');
    cc.start().catch(console.error);
    (window as any).clawcontainer = cc;
    return;
  }

  const overlay = document.getElementById('template-picker-overlay')!;
  const list = document.getElementById('template-picker-list')!;
  const loadingOverlay = document.getElementById('loading-overlay');

  overlay.classList.remove('hidden');
  if (loadingOverlay) loadingOverlay.style.display = 'none';

  for (const [name, template] of registry) {
    const card = document.createElement('div');
    card.className = 'template-card';
    card.innerHTML = `<div>
      <div class="template-card-name">${template.name}</div>
      <div class="template-card-desc">${template.description ?? ''}</div>
    </div>`;
    card.addEventListener('click', () => {
      overlay.classList.add('hidden');
      if (loadingOverlay) { loadingOverlay.style.display = ''; loadingOverlay.classList.remove('fade-out'); }
      const cc = new ClawContainer('#app', { template: name });
      cc.start().catch(console.error);
      (window as any).clawcontainer = cc;
    });
    list.appendChild(card);
  }
}

main();
