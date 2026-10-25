/**
 * Settings-panel block "Локальный голос": engine dropdown (GPU / CPU groups), voice dropdown, per-engine download buttons with
 * progress, and "Проверить голос" (synthesises a fixed sample and plays it here). Self-contained (own tiny DOM helper, reuses the
 * panel's CSS classes) so settingsPanel.ts only needs one line. A model is NEVER downloaded without a click on its button.
 */
import { AUTO_ENGINE_ORDER, LOCAL_TTS_ENGINES, engineInfo, resolveVoice, unitFor, type LocalTtsChoice, type LocalTtsEngineInfo } from '../localtts/catalog';
import { stressedSample } from '../localtts/stress';
import { MODEL_TOTAL_BYTES } from '../localtts/supertonic/constants';
import type { LttsEnv, LttsState } from '../localtts/supertonic/protocol';
import { b64ToInt16 } from '../localtts/supertonic/pcm';
import type { LocalTtsEngineId } from '../localtts/types';
import type { Settings } from '../types';

/** the block is rebuilt on every panel render: remember whether the user left it open */
let localTtsOpen = false;

export type LocalTtsPhase = 'unsupported' | 'none' | 'downloading' | 'ready' | 'error';

export interface LocalTtsPanelState {
  phase: LocalTtsPhase;
  loaded: number;
  total: number;
  /** why unsupported / what failed (Russian) */
  message?: string;
}

/** persisted states of all download units + browser capabilities */
export interface LocalTtsPanelInfo {
  env: LttsEnv;
  units: Record<string, LttsState | undefined>;
  /** measured f0 of the engine's voices (calibration cache), keyed by engine@revision */
  calib?: Record<string, { f0: Record<string, number> }>;
}

export interface LocalTtsTestResult {
  sampleRate: number;
  pcmB64: string;
  durationSec: number;
  /** compute time in the offscreen document (ms), model load excluded */
  ms: number;
  loadMs?: number;
  warmMs?: number;
}

/** host operations (all optional on the panel host; the block is hidden when getLocalTtsInfo is absent) */
export interface LocalTtsPanelHost {
  getLocalTtsInfo?(): Promise<LocalTtsPanelInfo | null>;
  localTtsDownload?(engine: LocalTtsEngineId, voice: string): Promise<void>;
  localTtsCancel?(engine: LocalTtsEngineId, voice: string): Promise<void>;
  localTtsDelete?(engine: LocalTtsEngineId, voice: string): Promise<void>;
  localTtsTest?(engine: LocalTtsEngineId, voice: string, text: string): Promise<LocalTtsTestResult>;
}

interface PanelStateOptions {
  env?: LttsEnv;
  /** the engine needs WebGPU (default true: the original Supertonic block) */
  needsGpu?: boolean;
  total?: number;
  /** revision the files must match; a state of another revision counts as not downloaded */
  rev?: string;
  /** the unit cannot be fetched yet (no published URL) */
  published?: boolean;
}

export function panelStateFrom(s: LttsState | undefined, o: PanelStateOptions = {}): LocalTtsPanelState {
  const total = o.total || s?.total || MODEL_TOTAL_BYTES;
  const needsGpu = o.needsGpu ?? true;
  const gpu = o.env?.gpu ?? s?.gpu;
  const offscreen = o.env?.offscreen ?? s?.offscreen;
  const stale = !!s && !!o.rev && s.rev !== o.rev;
  if (offscreen === false) return { phase: 'unsupported', loaded: 0, total, message: 'фоновые документы не поддерживаются этим браузером' };
  if (needsGpu && gpu === false) return { phase: 'unsupported', loaded: s?.model === 'ready' ? total : 0, total, message: 'WebGPU недоступен' };
  if (o.published === false && (!s || s.model !== 'ready')) return { phase: 'unsupported', loaded: 0, total, message: 'модель ещё не опубликована' };
  if (!s || stale) return { phase: 'none', loaded: 0, total };
  return { phase: s.model === 'error' ? 'error' : s.model, loaded: s.loaded, total, message: s.error };
}

const mb = (b: number): string => `${Math.round(b / 1e6)}`; // decimal MB, like the download sizes browsers show
export const downloadButtonLabel = (total: number = MODEL_TOTAL_BYTES): string => `Скачать модель (${mb(total)} МБ)`;

/** Pure text of the status line for a state (exported for tests). */
export function statusText(st: LocalTtsPanelState): string {
  const pct = st.total ? Math.min(100, Math.floor((st.loaded / st.total) * 100)) : 0;
  switch (st.phase) {
    case 'unsupported':
      return st.message ?? 'недоступно';
    case 'downloading':
      return `Скачивание: ${pct}% (${mb(st.loaded)} из ${mb(st.total)} МБ)`;
    case 'ready':
      return 'Готово: модель скачана';
    case 'error':
      return `Ошибка: ${st.message ?? 'не удалось скачать'}`;
    default:
      return st.loaded > 0 ? `Не скачано (докачка с ${pct}%)` : 'Не скачано';
  }
}

/** short state word for the dropdown entry: «не скачана» / «37%» / «готова» / reason */
export function stateWord(st: LocalTtsPanelState): string {
  switch (st.phase) {
    case 'ready':
      return 'готова';
    case 'downloading':
      return `${st.total ? Math.min(100, Math.floor((st.loaded / st.total) * 100)) : 0}%`;
    case 'unsupported':
      return st.message ?? 'недоступна';
    case 'error':
      return 'ошибка';
    default:
      return 'не скачана';
  }
}

/** dropdown entry: «Название — 398 МБ — скорость — состояние» */
export function engineOptionLabel(info: LocalTtsEngineInfo, total: number, st: LocalTtsPanelState): string {
  return `${info.label} — ${mb(total)} МБ — ${info.speedNote} — ${stateWord(st)}`;
}

/** state of one engine for a voice, from the persisted info (exported for tests) */
export function engineState(info: LocalTtsEngineInfo, voice: string, pi: LocalTtsPanelInfo | null): { unitId: string; total: number; state: LocalTtsPanelState } {
  const u = unitFor(info.id, resolveVoice(info.id, voice))!;
  const st = panelStateFrom(pi?.units[u.id], { env: pi?.env, needsGpu: info.needsGpu, total: u.total, rev: u.rev, published: u.published });
  return { unitId: u.id, total: u.total, state: st };
}

/** the engine the automatic mode would use right now: first of the registry order whose model is downloaded and supported */
export function autoEngine(voices: { voice: string }, pi: LocalTtsPanelInfo | null): LocalTtsEngineId | undefined {
  for (const id of AUTO_ENGINE_ORDER) {
    const info = engineInfo(id);
    if (info && engineState(info, voices.voice, pi).state.phase === 'ready') return id;
  }
  return undefined;
}

/** 0.1 s ramps on both ends keep the test sample from clicking */
export function playPcm(pcmB64: string, sampleRate: number): { stop(): void; done: Promise<void> } {
  const pcm = b64ToInt16(pcmB64);
  const AC = (globalThis as unknown as { AudioContext?: typeof AudioContext }).AudioContext;
  if (!AC) throw new Error('AudioContext недоступен');
  const ctx = new AC({ sampleRate });
  const buf = ctx.createBuffer(1, pcm.length, sampleRate);
  const ch = buf.getChannelData(0);
  for (let i = 0; i < pcm.length; i++) ch[i] = pcm[i]! / 32768;
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.connect(ctx.destination);
  const done = new Promise<void>((res) => {
    src.onended = () => {
      void ctx.close().catch(() => {});
      res();
    };
  });
  void ctx.resume().catch(() => {});
  src.start();
  return { stop: () => src.stop(), done };
}

function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, unknown> = {}, ...kids: Array<Node | string | null>): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === false) continue;
    if (k === 'class') el.className = String(v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
    else if (k in el) (el as unknown as Record<string, unknown>)[k] = v;
    else el.setAttribute(k, String(v));
  }
  for (const c of kids) if (c) el.append(c);
  return el;
}

type SettingsAccess = Pick<{ getSettings(): Promise<Settings>; saveSettings(patch: Partial<Settings>): Promise<void> }, 'getSettings' | 'saveSettings'>;

export function localTtsSection(host: LocalTtsPanelHost & Partial<SettingsAccess>): HTMLElement {
  let choice: LocalTtsChoice = 'auto';
  let voice = '';
  let pi: LocalTtsPanelInfo | null = null;

  const engineSel = h('select', { style: 'width:100%' });
  const voiceSel = h('select', { style: 'width:100%' });
  const voiceRow = h('div', { class: 'row' }, h('label', {}, 'Голос модели: '), voiceSel);
  const rows = h('div', {});
  const testBtn = h('button', {}, 'Проверить голос');
  const stopBtn = h('button', { style: 'display:none' }, 'Стоп');
  const testOut = h('div', { class: 'hint' }, '');
  const det = h('details', {}, h('summary', {}, h('h2', {}, 'Локальный голос')));
  det.open = localTtsOpen;
  det.addEventListener('toggle', () => (localTtsOpen = det.open));
  const sec = h('section', {}, det);
  det.append(
    h('div', { class: 'row' }, h('label', {}, 'Локальный голос: '), engineSel),
    voiceRow, rows,
    h('div', { class: 'row' }, testBtn, stopBtn), testOut);

  const effectiveEngine = (): LocalTtsEngineId | undefined => (choice === 'auto' ? autoEngine({ voice }, pi) : choice);
  const infoOf = (id: LocalTtsEngineId): LocalTtsEngineInfo => engineInfo(id)!;

  const fillEngines = (): void => {
    const opts: HTMLElement[] = [h('option', { value: 'auto' }, 'Автоматически (лучший доступный)')];
    for (const [group, title] of [['gpu', 'GPU (WebGPU)'], ['cpu', 'CPU']] as const) {
      const og = h('optgroup', { label: title });
      for (const e of LOCAL_TTS_ENGINES.filter((x) => x.group === group)) {
        const es = engineState(e, voice, pi);
        og.append(h('option', { value: e.id }, engineOptionLabel(e, es.total, es.state)));
      }
      opts.push(og);
    }
    engineSel.replaceChildren(...opts);
    engineSel.value = choice;
  };

  const fillVoices = (): void => {
    // only a per-voice-download engine (Piper) needs this picker: it selects WHICH voice file to download. The speaker voices
    // (male / female) are chosen in the lists of the block "Перевод live-трансляций" (voicePicker). It used to be hidden for
    // the default 'auto' engine, which is why the owner could not pick a voice at all.
    const id = choice === 'auto' ? undefined : choice;
    voiceRow.style.display = id && infoOf(id).perVoiceUnit ? '' : 'none';
    if (!id || !infoOf(id).perVoiceUnit) return;
    const info = infoOf(id);
    voiceSel.replaceChildren(...info.voices.map((v) => h('option', { value: v.id }, v.label)));
    voiceSel.value = resolveVoice(id, voice);
  };

  let busy = false;
  const act = (fn: () => Promise<void> | undefined) => async (): Promise<void> => {
    if (busy) return;
    busy = true;
    try {
      await fn();
    } catch {
      /* the next poll shows the real state */
    } finally {
      busy = false;
      void tick();
    }
  };

  const fillRows = (): void => {
    rows.replaceChildren(
      ...LOCAL_TTS_ENGINES.map((e) => {
        const es = engineState(e, voice, pi);
        const st = es.state;
        const pct = st.total ? Math.min(100, (st.loaded / st.total) * 100) : 0;
        const vId = resolveVoice(e.id, voice);
        const btns: HTMLElement[] = [];
        if (st.phase === 'none' || st.phase === 'error') btns.push(h('button', { class: 'primary', onclick: act(() => host.localTtsDownload?.(e.id, vId)) }, st.loaded > 0 ? `Докачать (${mb(st.total - st.loaded)} МБ)` : `Скачать (${mb(es.total)} МБ)`));
        if (st.phase === 'downloading') btns.push(h('button', { onclick: act(() => host.localTtsCancel?.(e.id, vId)) }, 'Отмена'));
        if (st.phase === 'ready') btns.push(h('button', { onclick: act(() => host.localTtsDelete?.(e.id, vId)) }, 'Удалить'));
        const title = e.perVoiceUnit ? `${e.label} (${e.voices.find((v) => v.id === vId)?.label ?? vId})` : e.label;
        return h('div', { style: 'margin:6px 0', 'data-engine': e.id },
          h('div', {}, h('b', {}, title), ` — ${e.speedNote}`),
          h('div', { class: st.phase === 'ready' ? 'hint ok' : st.phase === 'error' || st.phase === 'unsupported' ? 'hint bad' : 'hint' }, statusText(st)),
          st.phase === 'downloading' ? h('progress', { max: 100, value: pct, style: 'width:100%' }) : null,
          h('div', { class: 'row' }, ...btns));
      }),
    );
  };

  const repaint = (): void => {
    fillEngines();
    fillVoices();
    fillRows();
  };

  const saveChoice = async (patch: Partial<Settings> = {}): Promise<void> => {
    await host.saveSettings?.({ localTtsEngine: choice, localTtsVoice: voice, ...patch });
  };

  engineSel.addEventListener('change', () => {
    choice = engineSel.value as LocalTtsChoice;
    voice = '';
    repaint();
    void saveChoice({ localTtsVoiceMale: 'auto', localTtsVoiceFemale: 'auto' }); // voices belong to the engine
  });
  voiceSel.addEventListener('change', () => {
    voice = voiceSel.value;
    repaint();
    const g = engineInfo(choice === 'auto' ? 'piper-wasm' : choice)?.voices.find((v) => v.id === voice)?.gender;
    void saveChoice(g === 'm' ? { localTtsVoiceMale: voice } : g === 'f' ? { localTtsVoiceFemale: voice } : {});
  });

  let player: { stop(): void } | undefined;
  stopBtn.addEventListener('click', () => player?.stop());
  testBtn.addEventListener('click', async () => {
    if (!host.localTtsTest) return;
    const id = effectiveEngine();
    if (!id) {
      testOut.className = 'hint bad';
      testOut.textContent = 'Сначала скачайте хотя бы одну модель.';
      return;
    }
    const v = resolveVoice(id, voice);
    if (engineState(infoOf(id), v, pi).state.phase !== 'ready') {
      testOut.className = 'hint bad';
      testOut.textContent = 'Эта модель не скачана.';
      return;
    }
    testBtn.disabled = true;
    testOut.className = 'hint';
    testOut.textContent = `Синтез (${infoOf(id).label}, первый запуск дольше: загрузка модели)…`;
    try {
      const t0 = Date.now();
      const r = await host.localTtsTest(id, v, stressedSample(id).long);
      const wall = (Date.now() - t0) / 1000;
      const rtf = r.durationSec > 0 ? r.ms / 1000 / r.durationSec : 0;
      testOut.className = 'hint ok';
      testOut.textContent = `Синтез: ${(r.ms / 1000).toFixed(2)} с на ${r.durationSec.toFixed(1)} с звука, RTF ${rtf.toFixed(2)}${r.loadMs !== undefined ? `; загрузка модели ${(r.loadMs / 1000).toFixed(1)} с` : ''}${r.warmMs !== undefined ? `, прогрев ${(r.warmMs / 1000).toFixed(1)} с` : ''} (всего ${wall.toFixed(1)} с). Воспроизведение…`;
      const p = playPcm(r.pcmB64, r.sampleRate);
      player = p;
      stopBtn.style.display = '';
      await p.done;
      testOut.textContent = testOut.textContent.replace(' Воспроизведение…', '');
    } catch (e) {
      testOut.className = 'hint bad';
      testOut.textContent = `Ошибка: ${String((e as Error)?.message ?? e)}`;
    } finally {
      player = undefined;
      stopBtn.style.display = 'none';
      testBtn.disabled = false;
    }
  });

  let last = '';
  const tick = async (): Promise<void> => {
    try {
      const next = (await host.getLocalTtsInfo?.()) ?? null;
      if (!next) return;
      pi = next;
      const key = JSON.stringify(Object.entries(next.units).map(([k, st]) => [k, st?.model, st?.error])) + JSON.stringify(next.env) + choice + voice;
      if (key !== last) {
        last = key;
        repaint();
      } else if (Object.values(next.units).some((st) => st?.model === 'downloading')) fillRows(); // progress only: keep the open dropdowns alone
    } catch {
      /* keep the last paint */
    }
  };

  void (async () => {
    try {
      const s = await host.getSettings?.();
      if (s) {
        choice = s.localTtsEngine;
        voice = s.localTtsVoice;
      }
    } catch {
      /* defaults */
    }
    repaint();
    await tick();
  })();

  // poll while the block is on screen; stop once it was attached and then removed (panel re-render) or never attached
  let seen = false;
  let idle = 0;
  const timer = setInterval(() => {
    if (sec.isConnected) {
      seen = true;
      void tick();
    } else if (seen || ++idle > 5) clearInterval(timer);
  }, 700);
  return sec;
}
