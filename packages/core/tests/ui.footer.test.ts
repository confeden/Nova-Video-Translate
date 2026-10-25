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

describe('settings panel footer', () => {
  it('has the Telegram link opening in a new tab', async () => {
    const { root, handle } = await mount({});
    const a = [...root.querySelectorAll('a')].find((x) => x.getAttribute('href') === 'https://t.me/nova_txt');
    expect(a).toBeTruthy();
    expect(a!.textContent).toBe('Telegram: t.me/nova_txt');
    expect(a!.getAttribute('target')).toBe('_blank');
    expect(a!.getAttribute('rel')).toBe('noopener');
    handle.destroy();
  });

  it('no clear button without host.clearLocalModels', async () => {
    const { root, handle } = await mount({});
    expect(root.querySelector('button.clear-models')).toBeNull();
    handle.destroy();
  });

  it('delete-all needs two clicks and calls the host once', async () => {
    const clearLocalModels = vi.fn(async () => ({ freedBytes: 1.2e9 }));
    const { root, handle } = await mount({ clearLocalModels });
    const btn = (): HTMLButtonElement => root.querySelector('button.clear-models') as HTMLButtonElement;
    expect(btn().textContent).toBe('Удалить все модели');
    btn().click();
    await tick();
    expect(clearLocalModels).not.toHaveBeenCalled();
    expect(btn().textContent).toBe('Точно удалить?');
    btn().click();
    await tick();
    await tick();
    expect(clearLocalModels).toHaveBeenCalledTimes(1);
    expect(btn().textContent).toBe('Удалить все модели');
    expect(root.textContent).toContain('Удалено: 1.2 ГБ');
    handle.destroy();
  });
});
