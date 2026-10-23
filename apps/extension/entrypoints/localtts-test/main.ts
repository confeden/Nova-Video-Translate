import { createSupertonicEngine, diag, type SelfTestReplyData } from '@nvt/core';
import { browser } from 'wxt/browser';
import { LTTS_MSG } from '@nvt/core';

/** Developer self-test: synthesizes 3 Russian sentences in the offscreen document and prints timings (also logged via diag). */
const out = document.getElementById('out')!;
const show = (x: unknown): void => void (out.textContent = typeof x === 'string' ? x : JSON.stringify(x, null, 2));
const engine = createSupertonicEngine();

document.getElementById('status')!.addEventListener('click', async () => {
  show({ available: await engine.isAvailable(), state: await engine.state() });
});

document.getElementById('run')!.addEventListener('click', async () => {
  show('идёт синтез (первый запуск: загрузка модели ~6 с + прогрев шейдеров ~8 с)…');
  const r = (await browser.runtime.sendMessage({ type: LTTS_MSG, to: 'bg', op: 'selftest' })) as { ok: boolean; error?: string } & Partial<SelfTestReplyData>;
  if (r?.ok) {
    diag.log('localtts-selftest', { loadMs: r.loadMs, warmMs: r.warmMs, runs: r.runs });
    show(r);
  } else show(r ?? 'нет ответа');
});

document.getElementById('play')!.addEventListener('click', async () => {
  show('синтез…');
  try {
    const res = await engine.synth({ text: 'Привет! Это проверка локального голоса. Всё работает.', voice: 'M1', targetSec: 5 });
    const ctx = new AudioContext({ sampleRate: res.sampleRate });
    const buf = ctx.createBuffer(1, res.samples.length, res.sampleRate);
    buf.copyToChannel(Float32Array.from(res.samples, (v) => v / 32768), 0);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(ctx.destination);
    src.start();
    show({ durationSec: res.durationSec, sampleRate: res.sampleRate, diag: diag.report().split('\n').filter((l) => l.includes('localtts')).slice(-6) });
  } catch (e) {
    show(String(e));
  }
});
