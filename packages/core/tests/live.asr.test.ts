import { beforeEach, describe, expect, it } from 'vitest';
import { diag } from '../src/diag';
import { DEFAULT_SETTINGS } from '../src/types';
import { normalizeSettings } from '../src/settings';
import { GROQ_ASR_COOLDOWN_MS, HybridLiveAsr, LOCAL_PREFERRED_MS, type LiveAsrMode } from '../src/providers/local/liveAsr';
import type { AsrStage } from '../src/providers/cascade/provider';
import { ProviderUnavailableError, type AudioChunk } from '../src/providers/types';

const chunk: AudioChunk = { startSec: 0, durationSec: 8, sampleRate: 16000, pcm: new Int16Array(10) };
const sig = (): { signal: AbortSignal; live: boolean } => ({ signal: new AbortController().signal, live: true });

type Fake = AsrStage & { calls: number };
function fakeStage(id: string, clock: { t: number }, o: { ms?: number | (() => number); fail?: () => unknown; hang?: boolean } = {}): Fake {
  const st: Fake = {
    id,
    calls: 0,
    available: async () => true,
    model: () => id,
    transcribe: async (_c, ctx) => {
      st.calls++;
      if (o.hang) await new Promise((_, rej) => ctx.signal.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError'))));
      clock.t += typeof o.ms === 'function' ? o.ms() : (o.ms ?? 100);
      const f = o.fail?.();
      if (f) throw f;
      return { segments: [{ start: 0, end: 1, text: id }], sourceLang: 'en' };
    },
  };
  return st;
}

describe('HybridLiveAsr', () => {
  let clock: { t: number };
  let mode: LiveAsrMode;
  let key: boolean;
  const make = (groq: AsrStage, local: AsrStage, timeoutMs?: number) => new HybridLiveAsr({ local, groq, hasKey: () => key, mode: () => mode, now: () => clock.t, timeoutMs });
  const events = (ev: string) => diag.entries().filter((e) => e.ev === ev).map((e) => e.data as Record<string, unknown>);
  beforeEach(() => {
    clock = { t: 1_000_000 };
    mode = 'auto';
    key = true;
    diag.clear();
  });

  it('defaults to auto', () => {
    expect(DEFAULT_SETTINGS.liveAsr).toBe('auto');
    expect(normalizeSettings({}).liveAsr).toBe('auto');
    expect(normalizeSettings({ liveAsr: 'local' }).liveAsr).toBe('local');
    expect(normalizeSettings({ liveAsr: 'bogus' }).liveAsr).toBe('auto');
  });

  it('auto with a key: live chunks go to Groq, VOD chunks stay local', async () => {
    const g = fakeStage('groq', clock);
    const l = fakeStage('local', clock);
    const a = make(g, l);
    expect((await a.transcribe(chunk, sig())).segments[0]!.text).toBe('groq');
    expect((await a.transcribe(chunk, { signal: sig().signal, live: false })).segments[0]!.text).toBe('local');
    expect(g.calls).toBe(1);
  });

  it('no key => local and no audio ever goes to Groq; setting local => local', async () => {
    const g = fakeStage('groq', clock);
    const l = fakeStage('local', clock);
    key = false;
    const a = make(g, l);
    expect((await a.transcribe(chunk, sig())).segments[0]!.text).toBe('local');
    key = true;
    mode = 'local';
    expect((await a.transcribe(chunk, sig())).segments[0]!.text).toBe('local');
    expect(g.calls).toBe(0);
  });

  it('available(): a key lets the tier work without a local model', async () => {
    const g = fakeStage('groq', clock);
    const l = { ...fakeStage('local', clock), available: async () => false };
    expect(await make(g, l).available()).toBe(true);
    key = false;
    expect(await make(g, l).available()).toBe(false);
  });

  it('a Groq error falls back to local for that chunk and logs groq-asr-fallback', async () => {
    const g = fakeStage('groq', clock, { fail: () => new ProviderUnavailableError('Groq HTTP 429', 'groq', 'quota', 5000) });
    const l = fakeStage('local', clock);
    const r = await make(g, l).transcribe(chunk, sig());
    expect(r.segments[0]!.text).toBe('local');
    expect(events('groq-asr-fallback')).toEqual([{ reason: '429', cooldownSec: 0 }]);
  });

  it('timeout falls back; two failures in a row start a 2 min cooldown, then Groq is tried again', async () => {
    const g = fakeStage('groq', clock, { hang: true });
    const l = fakeStage('local', clock);
    const a = make(g, l, 20);
    expect((await a.transcribe(chunk, sig())).segments[0]!.text).toBe('local');
    expect((await a.transcribe(chunk, sig())).segments[0]!.text).toBe('local');
    expect(events('groq-asr-fallback').map((e) => [e.reason, e.cooldownSec])).toEqual([['timeout', 0], ['timeout', GROQ_ASR_COOLDOWN_MS / 1000]]);
    expect(g.calls).toBe(2);
    await a.transcribe(chunk, sig());
    expect(g.calls).toBe(2); // cooldown: not even tried
    clock.t += GROQ_ASR_COOLDOWN_MS + 1;
    await a.transcribe(chunk, sig());
    expect(g.calls).toBe(3);
  });

  it('a success resets the failure counter (fail, ok, fail does not start a cooldown)', async () => {
    let bad = true;
    const g = fakeStage('groq', clock, { fail: () => (bad ? new Error('x') : undefined) });
    const l = fakeStage('local', clock);
    const a = make(g, l);
    await a.transcribe(chunk, sig());
    bad = false;
    await a.transcribe(chunk, sig());
    bad = true;
    await a.transcribe(chunk, sig());
    expect(events('groq-asr-fallback').filter((e) => e.cooldownSec).length).toBe(0);
  });

  it('latency: Groq slower than local by more than 1.5 s for 5 chunks in a row => local for 5 min, logged as asr-choice', async () => {
    const g = fakeStage('groq', clock, { ms: 3000 });
    const l = fakeStage('local', clock, { ms: 500 });
    const a = make(g, l);
    mode = 'local'; // one local measurement first
    await a.transcribe(chunk, sig());
    mode = 'auto';
    for (let i = 0; i < 5; i++) await a.transcribe(chunk, sig());
    expect(g.calls).toBe(5);
    await a.transcribe(chunk, sig());
    expect(g.calls).toBe(5); // now local
    const ch = events('asr-choice');
    expect(ch.at(-1)).toMatchObject({ chosen: 'local' });
    expect(ch.at(-1)!.groqMs).toBeGreaterThan(2500);
    clock.t += LOCAL_PREFERRED_MS + 1;
    await a.transcribe(chunk, sig());
    expect(g.calls).toBe(6);
  });

  it('latency: a fast chunk resets the slow streak', async () => {
    let slow = true;
    const g = fakeStage('groq', clock, { ms: () => (slow ? 3000 : 400) });
    const l = fakeStage('local', clock, { ms: 500 });
    const a = make(g, l);
    mode = 'local';
    await a.transcribe(chunk, sig());
    mode = 'auto';
    for (const s of [1, 1, 1, 1, 0, 1, 1, 1, 1]) {
      slow = s === 1;
      await a.transcribe(chunk, sig());
    }
    expect(g.calls).toBe(9);
  });

  it('a user abort is not a Groq failure', async () => {
    const ac = new AbortController();
    const g: AsrStage = {
      ...fakeStage('groq', clock),
      transcribe: async () => {
        ac.abort();
        throw new DOMException('aborted', 'AbortError');
      },
    };
    const l = fakeStage('local', clock);
    await expect(make(g, l).transcribe(chunk, { signal: ac.signal, live: true })).rejects.toBeTruthy();
    expect(events('groq-asr-fallback')).toHaveLength(0);
    expect(l.calls).toBe(0);
  });
});
