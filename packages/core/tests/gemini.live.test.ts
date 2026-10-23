/** Opt-in live check: NVT_LIVE=1 npx vitest run gemini.live (needs GEMINI_KEY_1/2 in repo-root .env.local). */
import { describe, it } from 'vitest';
import { GeminiProvider } from '../src/providers/gemini/provider';
import { fitSegments } from '../src/providers/gemini/sync';

// No @types/node in this workspace: reach Node through untyped handles.
const g = globalThis as unknown as { process?: { env: Record<string, string | undefined> } };
const live = g.process?.env.NVT_LIVE === '1';

async function node(spec: string): Promise<any> {
  return import(/* @vite-ignore */ spec);
}

describe.skipIf(!live)('gemini live', () => {
  it(
    'full provider on research wav',
    async () => {
      const env = g.process!.env;
      for (const k of ['HTTPS_PROXY', 'HTTP_PROXY', 'https_proxy', 'http_proxy', 'ALL_PROXY', 'all_proxy', 'NODE_USE_ENV_PROXY']) {
        delete env[k];
      }
      const fs = await node('node:fs');
      const path = await node('node:path');
      const root = path.resolve(path.dirname((await node('node:url')).fileURLToPath(import.meta.url)), '../../..');
      const keys: string[] = [];
      for (const line of fs.readFileSync(path.join(root, '.env.local'), 'utf8').split(/\r?\n/)) {
        const m = /^GEMINI_KEY_\d+=(.+)$/.exec(line.trim());
        if (m?.[1]) keys.push(m[1].trim());
      }
      const buf: Uint8Array = fs.readFileSync(path.join(root, 'research', 'en_gemini-3.1-flash-tts-preview.wav'));
      const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
      const sampleRate = dv.getUint32(24, true);
      let off = 12;
      let dataOff = 44;
      let dataLen = buf.length - 44;
      while (off + 8 <= buf.length) {
        const id = String.fromCharCode(buf[off]!, buf[off + 1]!, buf[off + 2]!, buf[off + 3]!);
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

      const provider = new GeminiProvider({ keys });
      const t0 = Date.now();
      const res = await provider.translateChunk(
        { startSec: 0, durationSec: n / sampleRate, sampleRate, pcm },
        { signal: new AbortController().signal, targetLang: 'ru', wantSubtitles: true },
      );
      const lines = [`sourceLang=${res.sourceLang} segments=${res.segments.length} total=${((Date.now() - t0) / 1000).toFixed(1)}s`];
      for (const s of res.segments) {
        if (s.audio.kind !== 'pcm') continue;
        const tts = s.audio.samples.length / s.audio.sampleRate;
        const orig = res.subtitles?.find((c) => c.text === s.text);
        const slotEnd = orig?.end ?? s.end;
        const slot = slotEnd - s.start;
        const fit = fitSegments([{ start: s.start, end: slotEnd, ttsSeconds: tts, text: s.text ?? '' }], { limitEnd: n / sampleRate })[0]!;
        lines.push(
          `[${s.start.toFixed(2)}-${slotEnd.toFixed(2)}] slot=${slot.toFixed(2)}s tts=${tts.toFixed(2)}s rate=${(s.rate ?? 1).toFixed(2)} borrowed=${fit.borrowed.toFixed(2)}s | ${s.text}`,
        );
      }
      console.log(lines.join('\n'));
    },
    240_000,
  );
});
