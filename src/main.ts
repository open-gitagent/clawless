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
    const inner = document.createElement('div');
    const nameEl = document.createElement('div');
    nameEl.className = 'template-card-name';
    nameEl.textContent = template.name;
    const descEl = document.createElement('div');
    descEl.className = 'template-card-desc';
    descEl.textContent = template.description ?? '';
    inner.appendChild(nameEl);
    inner.appendChild(descEl);
    card.appendChild(inner);
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
