import { describe, expect, it, vi } from 'vitest';
import { parseHTML } from 'linkedom';

async function mount(extra: Record<string, unknown>) {
  const { document, window } = parseHTML('<html><body><div id="r"></div></body></html>');
  // linkedom's <select>.value is read-only; browsers allow assigning it
  const sp = (window as unknown as { HTMLSelectElement: { prototype: object } }).HTMLSelectElement.prototype;
  Object.defineProperty(sp, 'value', {
    configurable: true,
    get() {
      const o = [...(this as Element).querySelectorAll('option')];
      return (o.find((x) => x.hasAttribute('selected')) ?? o[0])?.getAttribute('value') ?? '';
    },
    set(v: string) {
      for (const o of (this as Element).querySelectorAll('option')) o.toggleAttribute('selected', o.getAttribute('value') === v);
    },
  });
  for (let p: object | null = (window as unknown as { HTMLElement: { prototype: object } }).HTMLElement.prototype; p; p = Object.getPrototypeOf(p)) {
    const sd = Object.getOwnPropertyDescriptor(p, 'style');
    if (sd?.get && !sd.set) {
      Object.defineProperty(p, 'style', { configurable: true, get: sd.get, set(v: string) { (this as Element).setAttribute('style', String(v)); } });
      break;
    }
  }
  Object.assign(globalThis, { location: { hostname: 'example.com' }, document, window, HTMLElement: window.HTMLElement, ShadowRoot: (window as unknown as { ShadowRoot?: unknown }).ShadowRoot ?? class {} });
  const { mountSettingsPanel } = await import('../src/ui/settingsPanel');
  const { DEFAULT_SETTINGS } = await import('../src/types');
  const host = {
    getSettings: async () => DEFAULT_SETTINGS,
    saveSettings: async () => undefined,
    listGeminiModels: async () => [],
    getYandexAccount: async () => null,
    yandexLogin: async () => undefined,
    yandexLogout: async () => undefined,
    ...extra,
  };
  const root = document.getElementById('r') as unknown as HTMLElement;
  const handle = mountSettingsPanel(root, host as never);
  await handle.refresh();
  return { root, handle };
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 20));

describe('settings panel without local tiers (userscript)', () => {
  it('hides Groq key row, groq/local entries and the Chrome AI section without getLocalAsrInfo', async () => {
    const { root, handle } = await mount({});
    await tick();
    const text = root.textContent ?? '';
    expect(text).not.toContain('Нейросеть Chrome');
    expect(root.querySelector('input[placeholder^="Ключ Groq"]')).toBeNull();
    expect(root.querySelectorAll('.prov').length).toBe(3);
    handle.destroy();
  });
  it('shows them when the host advertises local tiers (extension)', async () => {
    const { root, handle } = await mount({ getLocalAsrInfo: async () => null });
    await tick();
    expect(root.textContent ?? '').toContain('Нейросеть Chrome');
    expect(root.querySelector('input[placeholder^="Ключ Groq"]')).not.toBeNull();
    expect(root.querySelectorAll('.prov').length).toBe(5);
    handle.destroy();
  });
});
