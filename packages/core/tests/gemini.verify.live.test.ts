/** Opt-in live verification (quota!): NVT_LIVE=1 NVT_STAGE=A NVT_OUT=<dir> npx vitest run gemini.verify.live */
import { describe, it } from 'vitest';
import { KeyPool } from '../src/keypool';
import { diag } from '../src/diag';
import { GeminiProvider } from '../src/providers/gemini/provider';
import { GeminiClient, responseText } from '../src/providers/gemini/client';
import { readResearchWav } from './helpers/wavFile';
import { synthesizeRun, synthesize } from '../src/providers/gemini/tts';
import { estimateF0 } from '../src/audio/pitch';

const g = globalThis as unknown as { process?: { env: Record<string, string | undefined> } };
const live = g.process?.env.NVT_LIVE === '1';
async function node(spec: string): Promise<any> {
  return import(/* @vite-ignore */ spec);
}
function wavBytes(pcm: Int16Array, rate: number): Uint8Array {
  const b = new Uint8Array(44 + pcm.length * 2);
  const dv = new DataView(b.buffer);
  const s = (o: number, t: string) => [...t].forEach((c, i) => (b[o + i] = c.charCodeAt(0)));
  s(0, 'RIFF'); dv.setUint32(4, 36 + pcm.length * 2, true); s(8, 'WAVEfmt ');
  dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
  dv.setUint32(24, rate, true); dv.setUint32(28, rate * 2, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);
  s(36, 'data'); dv.setUint32(40, pcm.length * 2, true);
  new Int16Array(b.buffer, 44, pcm.length).set(pcm);
  return b;
}

const SETS: Record<string, string[]> = {
  s1: ['Сегодня мы поговорим о том, как устроены современные нейронные сети.', 'Это важно.', 'Представьте себе обычную функцию, которая принимает число и возвращает другое число.', 'Звучит просто, правда?', 'Но на практике таких функций миллиарды, и все они связаны между собой.'],
  s2: ['Начнём с самого простого примера, чтобы вы сразу поняли идею.', 'Допустим, у нас есть набор фотографий кошек и собак.', 'Нужно научить программу отличать одних от других.', 'Для этого мы показываем ей тысячи примеров.'],
  s3: ['Первый шаг — собрать данные.', 'Второй — разметить их вручную.', 'Третий шаг самый долгий, потому что модель учится медленно и постепенно, шаг за шагом.', 'Потом мы проверяем результат.', 'Если ошибок слишком много, возвращаемся назад.', 'И так повторяем до тех пор, пока качество нас не устроит.'],
};
function peakDb(p: Int16Array, from: number, to: number) { let m = 0; for (let i = Math.max(0, from); i < Math.min(p.length, to); i++) m = Math.max(m, Math.abs(p[i]!)); return m ? +(20 * Math.log10(m / 32768)).toFixed(1) : -99; }

describe.skipIf(!live)('gemini verify live', () => {
  it('stage B runs', async () => {
    const env = g.process!.env;
    for (const k of ['HTTPS_PROXY', 'HTTP_PROXY', 'https_proxy', 'http_proxy', 'ALL_PROXY', 'all_proxy', 'NODE_USE_ENV_PROXY']) delete env[k];
    if (!env.NVT_JOBS) return;
    const fs = await node('node:fs');
    const path = await node('node:path');
    const root = path.resolve(path.dirname((await node('node:url')).fileURLToPath(import.meta.url)), '../../..');
    const out = env.NVT_OUT!;
    fs.mkdirSync(out, { recursive: true });
    const keys: string[] = [];
    for (const line of fs.readFileSync(path.join(root, '.env.local'), 'utf8').split(String.fromCharCode(10))) {
      const m = /^GEMINI_KEY_\d+=(.+)$/.exec(line.trim());
      if (m?.[1]) keys.push(m[1].trim());
    }
    const client = new GeminiClient({ keys: new KeyPool(keys) });
    // job spec: model:voice:set[:seed][:single] comma separated
    for (const job of env.NVT_JOBS.split(',')) {
      const [model, voice, set, seedS, single] = job.split(':');
      const name = `B_${model!.replace(/gemini-|-preview/g, '')}_${voice}_${set}_${seedS ?? 1}`;
      const rec: any = { job };
      const t0 = Date.now();
      try {
        const opts: any = { voice, seed: Number(seedS ?? 1) };
        if (single) {
          const r = await synthesize(client, model!, SETS[set!]![0]!, opts);
          rec.sec = r.seconds; rec.wall = (Date.now() - t0) / 1000; rec.f0 = estimateF0(r.pcm, r.sampleRate).f0;
          rec.tailPeak = peakDb(r.pcm, r.pcm.length - 2400, r.pcm.length); rec.maxPeak = peakDb(r.pcm, 0, r.pcm.length); rec.suspicious = r.suspicious;
          fs.writeFileSync(path.join(out, name + '.wav'), wavBytes(r.pcm, r.sampleRate));
        } else {
          const r = await synthesizeRun(client, model!, SETS[set!]!, opts);
          rec.wall = (Date.now() - t0) / 1000; rec.wholeSec = r.whole.seconds; rec.f0 = estimateF0(r.whole.pcm, r.whole.sampleRate).f0;
          rec.ok = !!r.clips; rec.conf = r.align.confidence; rec.reason = r.align.reason; rec.cuts = r.align.cuts.map((c) => +(c / r.whole.sampleRate).toFixed(2));
          rec.suspicious = r.whole.suspicious;
          rec.wholeTailPeak = peakDb(r.whole.pcm, r.whole.pcm.length - 2400, r.whole.pcm.length);
          fs.writeFileSync(path.join(out, name + '.whole.wav'), wavBytes(r.whole.pcm, r.whole.sampleRate));
          rec.clips = r.clips?.map((c, i) => { fs.writeFileSync(path.join(out, `${name}.c${i}.wav`), wavBytes(c.pcm, c.sampleRate)); return { sec: +c.seconds.toFixed(2), tailPeak: peakDb(c.pcm, c.pcm.length - 2400, c.pcm.length), chars: SETS[set!]![i]!.length }; });
        }
      } catch (e) { rec.error = String(e).slice(0, 200); }
      fs.appendFileSync(path.join(out, 'B.jsonl'), JSON.stringify(rec) + String.fromCharCode(10));
      if (rec.error && /quota|429/i.test(rec.error)) break;
    }
  }, 600_000);

  it('stage A end to end', async () => {
    if (g.process!.env.NVT_STAGE !== 'A') return;
    const env = g.process!.env;
    for (const k of ['HTTPS_PROXY', 'HTTP_PROXY', 'https_proxy', 'http_proxy', 'ALL_PROXY', 'all_proxy', 'NODE_USE_ENV_PROXY']) delete env[k];
    const fs = await node('node:fs');
    const path = await node('node:path');
    const root = path.resolve(path.dirname((await node('node:url')).fileURLToPath(import.meta.url)), '../../..');
    const out = env.NVT_OUT!;
    fs.mkdirSync(out, { recursive: true });
    const keys: string[] = [];
    for (const line of fs.readFileSync(path.join(root, '.env.local'), 'utf8').split(/\r?\n/)) {
      const m = /^GEMINI_KEY_\d+=(.+)$/.exec(line.trim());
      if (m?.[1]) keys.push(m[1].trim());
    }
    const calls: unknown[] = [];
    const cfetch = async (url: any, init: any) => {
      const t0 = Date.now();
      const r = await fetch(url, init);
      const u = String(url);
      calls.push({ m: /models\/([^:?]+)/.exec(u)?.[1], ms: Date.now() - t0, status: r.status });
      return r;
    };
    const files = (env.NVT_FILES ?? 'capture_yt.wav,en_gemini-3.1-flash-tts-preview.wav').split(',');
    const provider = new GeminiProvider({ keys, fetch: cfetch as any });
    const report: any = {};
    for (const f of files) {
      const w = (await readResearchWav(f))!;
      const dur = w.pcm.length / w.sampleRate;
      const n0 = calls.length;
      const t0 = Date.now();
      const r = await provider.translateChunk({ startSec: 0, durationSec: dur, sampleRate: w.sampleRate, pcm: w.pcm }, { signal: new AbortController().signal, sourceLang: undefined, wantSubtitles: true } as any);
      report[f] = {
        sec: (Date.now() - t0) / 1000, dur, sampleRate: w.sampleRate, lang: r.sourceLang, failed: r.failedSegments,
        calls: calls.slice(n0),
        segs: r.segments.map((s: any) => ({ s: s.start, e: s.end, slot: +(s.end - s.start).toFixed(2), tts: +(s.audio.samples.length / s.audio.sampleRate).toFixed(2), rate: s.rate, ruChars: s.text.length, cps: +(s.text.length / (s.end - s.start)).toFixed(1), text: s.text, src: s.src })),
      };
      r.segments.forEach((s: any, i: number) => fs.writeFileSync(path.join(out, `${f}.seg${i}.wav`), wavBytes(s.audio.samples, s.audio.sampleRate)));
    }
    report.diag = diag.entries().filter((e: any) => /gemini/.test(e.ev)).map((e: any) => ({ ev: e.ev, ...e.data }));
    report.totalCalls = calls.length;
    fs.writeFileSync(path.join(out, 'A.json'), JSON.stringify(report, null, 1));
  }, 400_000);
});
