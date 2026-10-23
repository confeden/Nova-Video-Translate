// @ts-nocheck
/** Opt-in live smoke: NVT_LIVE=1 npx vitest run pipeline.live (GEMINI_KEY_n in repo-root .env.local). */
import { describe, it, expect } from 'vitest';
import { TranslationEngine } from '../src/pipeline';
import { GeminiProvider } from '../src/providers/gemini/provider';
import { DEFAULT_SETTINGS } from '../src/types';

const g = globalThis as any;
const live = g.process?.env.NVT_LIVE === '1';

async function node(spec: string): Promise<any> {
  return import(/* @vite-ignore */ spec);
}

describe.skipIf(!live)('pipeline live', () => {
  it(
    'engine + Gemini on the research wav (one chunk)',
    async () => {
      const env = g.process.env;
      for (const k of ['HTTPS_PROXY', 'HTTP_PROXY', 'https_proxy', 'http_proxy', 'ALL_PROXY', 'all_proxy', 'NODE_USE_ENV_PROXY']) delete env[k];
      const fs = await node('node:fs');
      const path = await node('node:path');
      const root = path.resolve(path.dirname((await node('node:url')).fileURLToPath(import.meta.url)), '../../..');
      const keys: string[] = [];
      for (const line of fs.readFileSync(path.join(root, '.env.local'), 'utf8').split(/\r?\n/)) {
        const m = /^GEMINI_KEY_\d+=(.+)$/.exec(line.trim());
        if (m?.[1]) keys.push(m[1].trim());
      }
      expect(keys.length).toBeGreaterThan(0);
      const buf: Uint8Array = fs.readFileSync(path.join(root, 'research', 'en_gemini-3.1-flash-tts-preview.wav'));
      const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
      const sampleRate = dv.getUint32(24, true);
      let off = 12;
      let dataOff = 44;
      let dataLen = buf.length - 44;
      while (off + 8 <= buf.length) {
        const id = String.fromCharCode(buf[off], buf[off + 1], buf[off + 2], buf[off + 3]);
        const len = dv.getUint32(off + 4, true);
        if (id === 'data') {
          dataOff = off + 8;
          dataLen = Math.min(len, buf.length - dataOff);
          break;
        }
        off += 8 + len + (len & 1);
      }
      const n = dataLen >> 1;
      const pcm = new Int16Array(n);
      for (let i = 0; i < n; i++) pcm[i] = dv.getInt16(dataOff + 2 * i, true);

      const cbs = new Set<(c: unknown) => void>();
      const capture = { kind: 'direct', start: async () => {}, onChunk: (cb) => (cbs.add(cb), () => cbs.delete(cb)), stop: () => {} };
      const added: unknown[] = [];
      const scheduler = {
        addSegments: (s) => added.push(...s),
        start: () => {},
        dispose: () => {},
        setVolume: () => {},
      };
      const states: string[] = [];
      const warnings: string[] = [];
      const video = Object.assign(new EventTarget(), { currentTime: 0, volume: 1 });
      const engine = new TranslationEngine({
        video,
        audioCtx: {},
        providers: [new GeminiProvider({ keys })],
        settings: { ...DEFAULT_SETTINGS, geminiKeys: keys },
        events: {
          onState: (s, d) => states.push(`${s}${d?.provider ? ':' + d.provider : ''}`),
          onWarning: (w) => warnings.push(`${w.kind}:${w.providerId ?? ''}`),
        },
        createCapture: async () => capture,
        createScheduler: () => scheduler,
      });
      await engine.start();
      const t0 = Date.now();
      cbs.forEach((f) => f({ startSec: 0, durationSec: n / sampleRate, sampleRate, pcm }));
      while (Date.now() - t0 < 120_000 && engine.state !== 'translating' && engine.state !== 'skipped-ru') {
        await new Promise((r) => setTimeout(r, 500));
      }
      engine.stop();
      console.log(
        `tier=${engine.activeProvider} states=[${states.join(' > ')}] warnings=[${warnings.join(',')}] segments=${added.length} total=${((Date.now() - t0) / 1000).toFixed(1)}s`,
      );
      expect(added.length).toBeGreaterThan(0);
    },
    180_000,
  );
});
