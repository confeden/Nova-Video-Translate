/**
 * Opt-in live check (quota!): NVT_LIVE=1 NVT_OUT=<file> npx vitest run gemini.chunk.live
 * Stage 1: translate prompt on research/capture_yt.wav + en_gemini-3.1-flash-tts-preview.wav (2 calls): chars/sec.
 * Stage 2 (only if stage 1 worked): one multi-sentence TTS call, alignment result, f0 of the output.
 * Writes a JSON report to NVT_OUT; never prints keys.
 */
import { describe, it } from 'vitest';
import { KeyPool } from '../src/keypool';
import { diag } from '../src/diag';
import { GeminiClient } from '../src/providers/gemini/client';
import { translateChunkAudio } from '../src/providers/gemini/translate';
import { synthesizeRun } from '../src/providers/gemini/tts';
import { estimateF0 } from '../src/audio/pitch';
import { readResearchWav } from './helpers/wavFile';

const g = globalThis as unknown as { process?: { env: Record<string, string | undefined> } };
const live = g.process?.env.NVT_LIVE === '1';
async function node(spec: string): Promise<any> {
  return import(/* @vite-ignore */ spec);
}

describe.skipIf(!live)('gemini chunk live', () => {
  it(
    'translate budget + multi-sentence TTS alignment',
    async () => {
      const env = g.process!.env;
      for (const k of ['HTTPS_PROXY', 'HTTP_PROXY', 'https_proxy', 'http_proxy', 'ALL_PROXY', 'all_proxy', 'NODE_USE_ENV_PROXY']) delete env[k];
      const fs = await node('node:fs');
      const path = await node('node:path');
      const root = path.resolve(path.dirname((await node('node:url')).fileURLToPath(import.meta.url)), '../../..');
      const keys: string[] = [];
      for (const line of fs.readFileSync(path.join(root, '.env.local'), 'utf8').split(/\r?\n/)) {
        const m = /^GEMINI_KEY_\d+=(.+)$/.exec(line.trim());
        if (m?.[1]) keys.push(m[1].trim());
      }
      const client = new GeminiClient({ keys: new KeyPool(keys) });
      const report: Record<string, unknown> = {};
      const save = () => fs.writeFileSync(env.NVT_OUT!, JSON.stringify(report, null, 1));
      const models = (await client.listModels()).filter((m) => m.supportedGenerationMethods.includes('generateContent')).map((m) => m.id);
      const cands = models.filter((m) => /flash/.test(m) && !/tts|live|audio|image|transcribe|embed/.test(m));
      let tr = cands[0] ?? 'unknown';
      report.candidates = cands;
      for (const name of ['capture_yt.wav', 'en_gemini-3.1-flash-tts-preview.wav']) {
        const w = await readResearchWav(name);
        if (!w) continue;
        for (const m of [tr, ...cands.filter((c) => c !== tr)].slice(0, 4)) {
        try {
          tr = m;
          report.translateModel = m;
          const r = await translateChunkAudio(client, m, { startSec: 0, durationSec: w.pcm.length / w.sampleRate, sampleRate: w.sampleRate, pcm: w.pcm });
          report[name] = {
            sourceLang: r.sourceLang,
            reason: r.reason,
            segments: r.segments.map((s) => ({ start: s.start, end: s.end, chars: s.ru.length, src: s.src.length, gender: s.gender })),
            ru: r.segments.map((s) => s.ru),
            src: r.segments.map((s) => s.src),
          };
          break;
        } catch (e) {
          report[name] = { error: String(e).slice(0, 200) };
        }
        }
        save();
      }
      report.diag = diag.entries().filter((e) => e.ev === 'gemini-translate').map((e) => e.data);
      save();
      const ttsModels = models.filter((m) => /3\.1-flash-tts/.test(m));
      const sentences = [
        'Сегодня мы посмотрим, как на самом деле обучаются нейросети.',
        'Сначала представьте простую функцию с одним входом и одним выходом.',
        'Затем мы добавим ещё слои и посмотрим, что получится.',
      ];
      try {
        const run = await synthesizeRun(client, ttsModels[0] ?? 'gemini-3.1-flash-tts-preview', sentences, { voice: 'Orus', guard: false });
        report.tts = {
          model: ttsModels[0],
          sec: run.whole.seconds,
          aligned: !!run.clips,
          confidence: run.align.confidence,
          reason: run.align.reason,
          cutsSec: run.align.cuts.map((c) => c / run.whole.sampleRate),
          clipSec: run.clips?.map((c) => c.seconds),
          f0: estimateF0(run.whole.pcm, run.whole.sampleRate).f0,
        };
      } catch (e) {
        report.tts = { error: String(e).slice(0, 200) };
      }
      save();
    },
    240_000,
  );
});
