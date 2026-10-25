import { describe, expect, it } from 'vitest';
import { parseHTML } from 'linkedom';

// a periodic tick with unchanged data must keep the very same DOM nodes (no replace => no twitch)
const snapshot = (root: Element): Element[] => [...root.querySelectorAll('*')];

describe('settings panel periodic updates', () => {
  it('local ASR section: repeated identical ticks replace no nodes', async () => {
    const { document, window } = parseHTML('<html><body></body></html>');
    // linkedom's <select>.value is read-only; browsers allow assigning it
    const sp = (window as unknown as { HTMLSelectElement: { prototype: object } }).HTMLSelectElement.prototype;
    const d = Object.getOwnPropertyDescriptor(sp, 'value');
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
    void d;
    // same for `el.style = 'css text'` (PutForwards in browsers)
    for (let p: object | null = (window as unknown as { HTMLElement: { prototype: object } }).HTMLElement.prototype; p; p = Object.getPrototypeOf(p)) {
      const sd = Object.getOwnPropertyDescriptor(p, 'style');
      if (sd?.get && !sd.set) {
        Object.defineProperty(p, 'style', { configurable: true, get: sd.get, set(v: string) { (this as Element).setAttribute('style', String(v)); } });
        break;
      }
    }
    Object.assign(globalThis, { document, window, HTMLElement: window.HTMLElement });
    const { localAsrSection } = await import('../src/ui/localAsrSection');
    const info = { units: {}, env: { gpu: false, f16: false } } as never;
    const host = {
      getLocalAsrInfo: async () => info,
      getLocalTtsInfo: async () => null,
      getSettings: async () => undefined,
    };
    const sec = localAsrSection(host as never);
    document.body.append(sec);
    await new Promise((r) => setTimeout(r, 1700)); // >= two 700 ms ticks after the initial paint
    const before = snapshot(sec);
    const text = sec.textContent;
    await new Promise((r) => setTimeout(r, 1500));
    const after = snapshot(sec);
    expect(after.length).toBe(before.length);
    expect(after.every((n, i) => n === before[i])).toBe(true);
    expect(sec.textContent).toBe(text);
  }, 10000);
});
