/** Opt-in live check: NVT_LIVE=1 npx vitest run groq.live (needs GROQ_API_KEY in repo-root .env.local). Never prints the key. */
import { describe, it, expect } from 'vitest';
import { GroqAsr, GroqChatTranslator, GroqClient, GroqModelRegistry } from '../src/providers/groq';
import type { Transport } from '../src/providers/types';

const g = globalThis as unknown as { process?: { env: Record<string, string | undefined> } };
const live = g.process?.env.NVT_LIVE === '1';
const node = (spec: string): Promise<any> => import(/* @vite-ignore */ spec);

describe.skipIf(!live)('groq live', () => {
  it(
    'transcribes + translates capture_yt.wav (latency, parsing)',
    async () => {
      const env = g.process!.env;
      for (const k of ['HTTPS_PROXY', 'HTTP_PROXY', 'https_proxy', 'http_proxy', 'ALL_PROXY', 'all_proxy', 'NODE_USE_ENV_PROXY']) delete env[k];
      const fs = await node('node:fs');
      const path = await node('node:path');
      const root = path.resolve(path.dirname((await node('node:url')).fileURLToPath(import.meta.url)), '../../..');
      let key = '';
      for (const line of fs.readFileSync(path.join(root, '.env.local'), 'utf8').split(/\r?\n/)) {
        const m = /^GROQ_API_KEY=(.+)$/.exec(line.trim());
        if (m?.[1]) key = m[1].trim();
      }
      expect(key.length).toBeGreaterThan(10);
      const buf: Uint8Array = fs.readFileSync(path.join(root, 'research', 'capture_yt.wav'));
      const pcm = new Int16Array(buf.buffer.slice(buf.byteOffset + 44, buf.byteOffset + buf.byteLength));
      const transport: Transport = async (req) => {
        const r = await fetch(req.url, { method: req.method, headers: req.headers, body: req.body as BodyInit | undefined, signal: req.signal });
        const headers: Record<string, string> = {};
        r.headers.forEach((v, k) => (headers[k] = v));
        return { status: r.status, headers, body: new Uint8Array(await r.arrayBuffer()) };
      };
      const client = new GroqClient({ transport, getKey: () => key });
      const models = new GroqModelRegistry(client, () => ({ asr: '', chat: '' }));
      const asr = new GroqAsr(client, models);
      const ac = new AbortController();
      const t0 = Date.now();
      const r = await asr.transcribe({ pcm, sampleRate: 16000, startSec: 100, durationSec: pcm.length / 16000 } as never, { signal: ac.signal });
      const ms = Date.now() - t0;
      console.log('GROQ-ASR', JSON.stringify({ ms, model: asr.model(), lang: r.sourceLang, segments: r.segments.length, first: r.segments[0] }));
      expect(r.segments.length).toBeGreaterThan(0);
      expect(r.segments[0]!.start).toBeGreaterThanOrEqual(100);
      const t1 = Date.now();
      const tr = await new GroqChatTranslator(client, models).translate(r.segments.map((s) => ({ text: s.text, maxChars: 120 })), r.sourceLang ?? 'en', ac.signal);
      console.log('GROQ-CHAT', JSON.stringify({ ms: Date.now() - t1, out: tr.slice(0, 2) }));
      expect(tr.length).toBe(r.segments.length);
      console.log('GROQ-MODELS', JSON.stringify({ chat: await models.resolve('chat'), asr: await models.resolve('asr'), all: (await client.listModels()).length }));
      // a 50-sentence batch (pre-translation of a caption track)
      const lyr = ['Were no strangers to love', 'You know the rules and so do I', 'A full commitment is what Im thinking of', 'You wouldnt get this from any other guy', 'I just wanna tell you how Im feeling'];
      const items = Array.from({ length: 50 }, (_, i) => ({ text: `${lyr[i % 5]} (${i}).`, maxChars: 60 }));
      const t2 = Date.now();
      try {
        const out = await new GroqChatTranslator(client, models).translate(items, 'en', ac.signal);
        console.log('GROQ-BATCH', JSON.stringify({ ms: Date.now() - t2, n: out.length, first: out[0] }));
      } catch (e) {
        console.log('GROQ-BATCH-FAIL', JSON.stringify({ ms: Date.now() - t2, msg: String((e as Error).message).slice(0, 400) }));
      }
    },
    60_000,
  );
});
