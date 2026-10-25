/**
 * Voice lists "Мужской голос" / "Женский голос" of the active local TTS engine (v0.2.45, block "Перевод live-трансляций").
 * Every voice of that gender is a row: radio + id + measured pitch + its OWN play button that speaks a fixed Russian sample
 * through the engine (sample audio is cached in memory: a repeat click is instant). The first row "Авто (рекомендуется)" = the
 * calibrated adult-sounding voice. The lists are ALWAYS visible; while the engine model is missing the rows are disabled and one
 * download button is shown (a model is downloaded only on that click). Settings: localTtsVoiceMale / localTtsVoiceFemale.
 */
import { engineInfo } from '../localtts/catalog';
import { mapVoice, pickCalibrated, calibKey, type TtsGender } from '../localtts/voiceMap';
import type { LocalTtsEngineId, LocalTtsVoiceInfo } from '../localtts/types';
import type { Settings } from '../types';
import { stressedSample } from '../localtts/stress';
import { autoEngine, engineState, playPcm, type LocalTtsPanelHost, type LocalTtsPanelInfo, type LocalTtsTestResult } from './localTtsSection';

export const VOICE_SAMPLE_TEXT = 'Привет, это проверка голоса.';

type SettingsAccess = { getSettings(): Promise<Settings>; saveSettings(patch: Partial<Settings>): Promise<void> };

/** the f0 table measured for an engine (panel info) */
export const calibF0 = (id: LocalTtsEngineId, pi: LocalTtsPanelInfo | null): Record<string, number> => pi?.calib?.[calibKey(id)]?.f0 ?? {};

/** row text: "M3 · 100 Гц" when measured, else the catalog label */
export function voiceRowLabel(v: LocalTtsVoiceInfo, f0: number | undefined): string {
  return f0 ? `${v.id} · ${f0} Гц` : v.label;
}

/** the voice 'auto' resolves to right now (calibrated / measured prior / engine default) */
export function autoVoice(id: LocalTtsEngineId, g: TtsGender, pi: LocalTtsPanelInfo | null): string | undefined {
  return mapVoice(id, g, { calibrated: pickCalibrated(id, calibF0(id, pi)) });
}

export interface VoiceListsState {
  /** engine the lists describe: the chosen one, else the best downloaded, else the default GPU engine (never hidden) */
  engine: LocalTtsEngineId;
  /** model of that engine is downloaded and usable: rows are enabled */
  ready: boolean;
  /** why the rows are disabled (Russian), when not ready */
  note?: string;
  /** the one download button is offered */
  canDownload: boolean;
  voices: Record<TtsGender, LocalTtsVoiceInfo[]>;
  /** voice 'auto' resolves to, per gender */
  auto: Partial<Record<TtsGender, string>>;
}

/** Pure visibility / enable logic of the lists (exported for tests): always returns lists, never "hidden". */
export function voiceListsState(engineChoice: string, pi: LocalTtsPanelInfo | null): VoiceListsState {
  const chosen = engineChoice !== 'auto' && engineInfo(engineChoice as LocalTtsEngineId) ? (engineChoice as LocalTtsEngineId) : undefined;
  const engine = chosen ?? autoEngine({ voice: '' }, pi) ?? 'supertonic-webgpu';
  const info = engineInfo(engine)!;
  const st = engineState(info, '', pi).state;
  const ready = st.phase === 'ready';
  const note = ready ? undefined : st.phase === 'unsupported' ? (st.message ?? 'недоступно') : st.phase === 'downloading' ? 'модель скачивается…' : 'модель не скачана';
  return {
    engine,
    ready,
    note,
    canDownload: st.phase === 'none' || st.phase === 'error',
    voices: { m: info.voices.filter((v) => v.gender === 'm'), f: info.voices.filter((v) => v.gender === 'f') },
    auto: { m: autoVoice(engine, 'm', pi), f: autoVoice(engine, 'f', pi) },
  };
}

/** selection -> settings patch ('auto' stays 'auto') */
export function selectionPatch(g: TtsGender, value: string): Partial<Settings> {
  return g === 'm' ? { localTtsVoiceMale: value } : { localTtsVoiceFemale: value };
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

export interface VoicePicker {
  el: HTMLElement;
  /** re-reads the settings and the panel info and repaints when anything changed */
  sync(): Promise<void>;
}

const samples = new Map<string, LocalTtsTestResult>();
let groupSeq = 0;

export function voicePicker(host: LocalTtsPanelHost & Partial<SettingsAccess>, getInfo: () => LocalTtsPanelInfo | null): VoicePicker {
  const uid = ++groupSeq;
  let engineChoice = 'auto';
  const picked: Record<TtsGender, string> = { m: 'auto', f: 'auto' };
  const out = h('div', { class: 'hint' }, '');
  const dl = h('button', { class: 'primary', style: 'display:none' }, '');
  const lists: Record<TtsGender, HTMLElement> = { m: h('div', { 'data-gender': 'm' }), f: h('div', { 'data-gender': 'f' }) };
  const el = h('div', { 'data-voices': '1', style: 'margin:8px 0' },
    h('div', {}, h('b', {}, 'Мужской голос')), lists.m,
    h('div', { style: 'margin-top:6px' }, h('b', {}, 'Женский голос')), lists.f,
    dl, out);

  let playing: { stop(): void } | undefined;
  let busyKey = '';

  const play = async (st: VoiceListsState, voice: string): Promise<void> => {
    if (playing) {
      playing.stop();
      return;
    }
    if (!host.localTtsTest || !st.ready) return;
    const key = `${st.engine}|${voice}`;
    out.className = 'hint';
    try {
      let r = samples.get(key);
      if (!r) {
        busyKey = key;
        out.textContent = 'Синтез…';
        paint();
        r = await host.localTtsTest(st.engine, voice, stressedSample(st.engine).short);
        samples.set(key, r);
      }
      busyKey = '';
      const p = playPcm(r.pcmB64, r.sampleRate);
      playing = p;
      out.textContent = `Играет ${voice}…`;
      paint();
      await p.done;
      out.textContent = '';
    } catch (e) {
      out.className = 'hint bad';
      out.textContent = `Ошибка: ${String((e as Error)?.message ?? e)}`;
    } finally {
      playing = undefined;
      busyKey = '';
      paint();
    }
  };

  const choose = (g: TtsGender, value: string): void => {
    picked[g] = value;
    void host.saveSettings?.(selectionPatch(g, value));
  };

  const row = (st: VoiceListsState, g: TtsGender, value: string, label: string, sampleVoice: string | undefined): HTMLElement => {
    const radio = h('input', { type: 'radio', name: `nvt-voice-${g}-${uid}`, value, checked: picked[g] === value, disabled: !st.ready });
    radio.addEventListener('change', () => choose(g, value));
    const sk = `${st.engine}|${sampleVoice}`;
    const b = h('button', { title: 'Прослушать образец', disabled: !st.ready || !sampleVoice || !host.localTtsTest }, playing ? '■' : busyKey === sk ? '…' : '▶');
    b.addEventListener('click', () => sampleVoice && void play(st, sampleVoice));
    return h('div', { class: 'row', 'data-voice': value, style: 'align-items:center;gap:6px' }, h('label', { style: 'flex:1;min-width:0;display:flex;gap:6px;align-items:center' }, radio, label), b);
  };

  const paint = (): void => {
    const pi = getInfo();
    const st = voiceListsState(engineChoice, pi);
    const f0 = calibF0(st.engine, pi);
    for (const g of ['m', 'f'] as const) {
      const a = st.auto[g];
      const rows: HTMLElement[] = [];
      if (st.voices[g].length === 0) rows.push(h('div', { class: 'hint' }, 'У этого движка нет голоса такого пола.'));
      else {
        rows.push(row(st, g, 'auto', `Авто (рекомендуется)${a ? ` — ${a}${f0[a] ? ` · ${f0[a]} Гц` : ''}` : ''}`, a));
        for (const v of st.voices[g]) rows.push(row(st, g, v.id, voiceRowLabel(v, f0[v.id]), v.id));
      }
      lists[g].replaceChildren(...rows);
    }
    const info = engineInfo(st.engine)!;
    dl.style.display = st.canDownload ? '' : 'none';
    dl.textContent = `Скачать «${info.label}», чтобы слушать образцы`;
    if (!st.ready && !playing && !busyKey) {
      out.className = 'hint';
      out.textContent = `Выбор доступен после загрузки модели: ${st.note}.`;
    } else if (st.ready && out.textContent?.startsWith('Выбор доступен')) out.textContent = '';
  };
  dl.addEventListener('click', () => {
    const st = voiceListsState(engineChoice, getInfo());
    void host.localTtsDownload?.(st.engine, '');
  });

  let lastKey = '';
  const sync = async (): Promise<void> => {
    try {
      const s = await host.getSettings?.();
      if (s) {
        engineChoice = s.localTtsEngine;
        picked.m = s.localTtsVoiceMale;
        picked.f = s.localTtsVoiceFemale;
      }
    } catch {
      /* keep */
    }
    const pi = getInfo();
    const st = voiceListsState(engineChoice, pi);
    const key = JSON.stringify([st.engine, st.ready, st.note, picked, calibF0(st.engine, pi)]);
    if (key !== lastKey && !playing) {
      lastKey = key;
      paint();
    }
  };
  paint();
  return { el, sync };
}
