/**
 * Settings-panel block "Перевод live-трансляций" (local Whisper models, GPU upgrade, translator pair, recommended set, live mode + live ASR choice): model dropdown (Auto + checkpoints with their state), a status
 * row per model with the download / cancel / delete buttons. Follows the Supertonic block (localTtsSection.ts); a model is NEVER
 * downloaded without a click on its button.
 */
import { WHISPER_MODELS, pickWhisperModel, whisperBytes, whisperModelInfo, type LocalAsrModelChoice, type WhisperModelInfo } from '../localasr/whisperModels';
import { missingPieces, pairKey, recommendedLocalSetup, type InstalledPieces, type MissingPiece, type RecommendedSetup } from '../localasr/recommended';
import { AUTO_ENGINE_ORDER, engineInfo, resolveVoice } from '../localtts/catalog';
import { cachedDtypes, type LasrEnv, type LasrState } from '../localasr/whisperProtocol';
import { langName, TRANSLATOR_SOURCE_LANGS } from '../lang/names';
import { getResolvedSourceLang } from '../localasr/sourceLang';
import { PAIR_TEXT, downloadPair, pairAvailability, type PairAvailability } from '../localasr/translatorPair';
import type { Settings } from '../types';
import { GROQ_KEYS_URL, openKeyPage } from './keyLinks';
import { voicePicker } from './voicePicker';
import { engineState, panelStateFrom, stateWord, statusText, type LocalTtsPanelHost, type LocalTtsPanelInfo, type LocalTtsPanelState } from './localTtsSection';

let localAsrOpen = false;
/** the language the user picked in the Chrome Translator row (survives panel re-renders) */
let pairSrcPicked: string | undefined;

/** persisted download states of all models + browser capabilities */
export interface LocalAsrPanelInfo {
  env: LasrEnv;
  units: Record<string, LasrState | undefined>;
}

export interface LocalAsrPanelHost {
  getLocalAsrInfo?(): Promise<LocalAsrPanelInfo | null>;
  localAsrDownload?(model: string): Promise<void>;
  /** user click: download the gpu-mixed (fp32 encoder + q4 decoder) files of a ready CPU/q8 model and switch it to WebGPU after the session check */
  localAsrUpgrade?(model: string): Promise<void>;
  localAsrCancel?(model: string): Promise<void>;
  localAsrDelete?(model: string): Promise<void>;
}

/** which pieces of a recommendation are on this computer, from the panel's persisted states (same checks as the rows below) */
export function installedFrom(asr: LocalAsrPanelInfo | null, tts: LocalTtsPanelInfo | null, voice: string, pairs: InstalledPieces['pairs']): InstalledPieces {
  const a: InstalledPieces['asr'] = {};
  for (const m of WHISPER_MODELS) a[m.id] = asrModelState(m, asr).state.phase === 'ready' ? cachedDtypes(asr?.units[m.id]) : [];
  const t = new Set<string>();
  for (const id of AUTO_ENGINE_ORDER) {
    const info = engineInfo(id);
    if (info && engineState(info, voice, tts).state.phase === 'ready') t.add(id);
  }
  return { asr: a, tts: t, pairs };
}

/** the one line about the model the automatic mode uses right now (exported for tests); same chooser as the engine (pickWhisperModel) */
export function activeAutoText(info: LocalAsrPanelInfo | null, lang: string | undefined): string {
  const ready = new Set<string>();
  const gpu = new Set<string>();
  for (const m of WHISPER_MODELS) {
    if (asrModelState(m, info).state.phase !== 'ready') continue;
    ready.add(m.id);
    if (info?.units[m.id]?.device === 'webgpu') gpu.add(m.id);
  }
  const id = pickWhisperModel('auto', lang, ready, gpu);
  const ln = lang && lang !== 'auto' ? langName(lang) : '';
  if (!id) return ready.size ? `Сейчас активной модели нет: скачанные модели не подходят для языка «${ln || 'не определён'}» (английские понимают только английский)` : 'Сейчас активной модели нет: ни одна не скачана';
  const why = ln ? `лучшая из скачанных для языка «${ln}»` : 'лучшая из скачанных (язык ещё не определён, нужна многоязычная)';
  return `Сейчас активна: ${whisperModelInfo(id)?.label ?? id} — ${why}`;
}

const mb = (b: number): string => `${Math.round(b / 1e6)}`;

/** what the GPU-upgrade line of one model shows (exported for tests); null = nothing to offer */
export function asrUpgradeState(m: WhisperModelInfo, s: LasrState | undefined, env: LasrEnv | undefined): { kind: 'offer' | 'running' | 'failed'; bytes: number; loaded?: number; total?: number; error?: string } | null {
  if (!s || s.model !== 'ready') return null;
  const bytes = m.bytes['gpu-mixed'];
  if (s.upgrade) return { kind: 'running', bytes, loaded: s.upgrade.loaded, total: s.upgrade.total };
  const cached = cachedDtypes(s);
  const onCpu = s.device !== 'webgpu';
  if (!onCpu) return null;
  // the real failure (download or WebGPU session) of the last attempt: shown instead of an offer to repeat it blindly
  const haveGpu = cached.includes('gpu-mixed');
  if (s.upgradeError && (haveGpu || !env?.gpu || !env.f16)) return { kind: 'failed', bytes, error: s.upgradeError };
  if (!(env?.gpu && env.f16)) return null;
  if (haveGpu) return s.upgradeError ? { kind: 'failed', bytes, error: s.upgradeError } : null;
  return { kind: 'offer', bytes, error: s.upgradeError };
}

/** state of one model for the panel (exported for tests); WASM covers a missing WebGPU, so the engine is never "unsupported" for the GPU */
export function asrModelState(m: WhisperModelInfo, info: LocalAsrPanelInfo | null): { state: LocalTtsPanelState; total: number } {
  const total = whisperBytes(m, info?.env);
  return { state: panelStateFrom(info?.units[m.id], { env: { offscreen: info?.env.offscreen }, needsGpu: false, total, rev: m.revision }), total };
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

/** Replace the children of `box` only when their serialized form changed (a no-op tick must not touch the DOM: no flicker, hover/focus kept). */
function setKids(box: HTMLElement, kids: Node[]): boolean {
  const sig = kids.map((k) => (k as Element).outerHTML ?? k.textContent ?? '').join('');
  if ((box as unknown as { _sig?: string })._sig === sig && box.childNodes.length === kids.length) return false;
  (box as unknown as { _sig?: string })._sig = sig;
  box.replaceChildren(...kids);
  return true;
}
function setText(el: HTMLElement, t: string): void {
  if (el.textContent !== t) el.textContent = t;
}
function setDisplay(el: HTMLElement, v: string): void {
  if (el.style.display !== v) el.style.display = v;
}

type SettingsAccess = { getSettings(): Promise<Settings>; saveSettings(patch: Partial<Settings>): Promise<void>; openKeyPage(url: string): Promise<void> };

export function localAsrSection(host: LocalAsrPanelHost & Partial<LocalTtsPanelHost> & Partial<SettingsAccess>): HTMLElement {
  let choice: LocalAsrModelChoice = 'auto';
  let pi: LocalAsrPanelInfo | null = null;
  let ti: LocalTtsPanelInfo | null = null;
  let sourceLangSetting: string | undefined;
  let ttsVoice = '';

  const sel = h('select', { style: 'width:100%' });
  const rows = h('div', {});
  const det = h('details', {}, h('summary', {}, h('h2', {}, 'Перевод live-трансляций')));
  det.open = localAsrOpen;
  det.addEventListener('toggle', () => (localAsrOpen = det.open));
  const sec = h('section', {}, det);
  // ---- Chrome Translator pack for the source language -> Russian (download = user gesture) ----
  let pairSrc = pairSrcPicked ?? 'en';
  let pairState: PairAvailability = 'unavailable';
  let pairBusy = false;
  let pairPct = 0;
  let pairErr = '';
  const pairSel = h('select', {});
  const pairHead = h('div', {}, h('b', {}, 'Перевод Chrome'));
  const pairStatus = h('div', { class: 'hint' });
  const pairBar = h('progress', { max: 100, value: 0, style: 'width:100%;display:none' });
  const pairBtn = h('button', { class: 'primary', style: 'display:none' }, 'Скачать языковой пакет');
  const pairBox = h('div', { style: 'margin:10px 0', 'data-pair': '1' }, pairHead, h('div', { class: 'row' }, h('label', {}, 'Язык оригинала: '), pairSel), pairStatus, pairBar, h('div', { class: 'row' }, pairBtn));
  const paintPair = (): void => {
    setText(pairHead, `Перевод Chrome: ${langName(pairSrc)} → русский`);
    const codes = [...new Set([pairSrc, ...TRANSLATOR_SOURCE_LANGS])];
    if (pairSel.options.length !== codes.length || pairSel.value !== pairSrc) {
      pairSel.replaceChildren(...codes.map((c) => h('option', { value: c }, langName(c))));
      pairSel.value = pairSrc;
    }
    const pairCls = pairState === 'available' ? 'hint ok' : pairState === 'downloadable' || pairState === 'downloading' ? 'hint' : 'hint bad';
    if (pairStatus.className !== pairCls) pairStatus.className = pairCls;
    setText(pairStatus, pairErr ? `Не удалось скачать: ${pairErr}` : pairBusy ? `Скачивание языкового пакета… ${Math.round(pairPct)}%` : PAIR_TEXT[pairState]);
    setDisplay(pairBar, pairBusy ? '' : 'none');
    if (pairBar.value !== pairPct) pairBar.value = pairPct;
    setDisplay(pairBtn, pairState === 'downloadable' && !pairBusy ? '' : 'none');
  };
  const refreshPair = async (): Promise<void> => {
    if (pairBusy) return;
    pairState = await pairAvailability(pairSrc, 'ru');
    paintPair();
  };
  pairSel.addEventListener('change', () => {
    pairSrc = pairSrcPicked = pairSel.value;
    pairErr = '';
    void refreshPair();
  });
  pairBtn.addEventListener('click', () => {
    // Translator.create() for a 'downloadable' pair needs this click's transient user activation: it is called synchronously here
    if (pairBusy) return;
    pairBusy = true;
    pairPct = 0;
    pairErr = '';
    paintPair();
    downloadPair(pairSrc, 'ru', (f) => {
      pairPct = f * 100;
      paintPair();
    })
      .catch((e) => void (pairErr = String((e as Error)?.message ?? e).slice(0, 120)))
      .finally(() => {
        pairBusy = false;
        void refreshPair();
      });
  });
  // ---- recommendation + one-click download of exactly what is missing (the click is the consent, D31) ----
  const activeLine = h('div', { class: 'hint', 'data-active': '1' });
  const recProg = h('div', { class: 'hint' });
  const recBtn = h('button', { class: 'primary', style: 'display:none' }, 'Скачать рекомендуемое');
  let rec: RecommendedSetup | null = null;
  let recMissing: MissingPiece[] = [];
  let recBusy = false;
  let recMsg = '';
  const curLang = (): string | undefined => (sourceLangSetting && sourceLangSetting !== 'auto' ? sourceLangSetting : getResolvedSourceLang());
  const recBox = h('div', { style: 'margin:10px 0' }, activeLine, recProg, h('div', { class: 'row' }, recBtn));
  const paintRec = (): void => {
    setText(activeLine, choice === 'auto' ? activeAutoText(pi, curLang()) : '');
    setDisplay(activeLine, choice === 'auto' ? '' : 'none');
    setText(recProg, recMsg || (recMissing.length ? `Не скачано: ${recMissing.map((p) => p.label).join(', ')}` : rec ? 'Всё рекомендуемое уже скачано' : ''));
    setDisplay(recBtn, recMissing.length && !recBusy ? '' : 'none');
  };
  const refreshRec = async (): Promise<void> => {
    if (recBusy || !pi) return;
    const lang = curLang();
    const caps = { webgpu: !!pi.env.gpu, f16: !!pi.env.f16 };
    let r = recommendedLocalSetup(caps, lang, false);
    const pairs: InstalledPieces['pairs'] = {};
    if (r.translator) {
      const [s, t] = r.translator.pair;
      pairs[pairKey(s, t)] = await pairAvailability(s, t);
      if (s !== 'en' && pairs[pairKey(s, t)] === 'unavailable') {
        r = recommendedLocalSetup({ ...caps, pairs: { [pairKey(s, t)]: 'unavailable' } }, lang, false);
        pairs[pairKey(s, 'en')] = await pairAvailability(s, 'en');
        pairs[pairKey('en', t)] = await pairAvailability('en', t);
      }
    }
    rec = r;
    ttsVoice = resolveVoice(r.tts.engine, ttsVoice);
    recMissing = missingPieces(r, installedFrom(pi, ti, ttsVoice, pairs));
    paintRec();
  };
  recBtn.addEventListener('click', () => {
    // Translator.create() needs this click's user activation, so the translator packs go first (before any other await)
    if (recBusy || !rec) return;
    const todo = [...recMissing];
    recBusy = true;
    recMsg = '';
    paintRec();
    void (async () => {
      const errs: string[] = [];
      for (const p of todo) {
        try {
          recMsg = `Скачиваю: ${p.label}…`;
          paintRec();
          if (p.kind === 'translator') {
            await downloadPair(p.src, p.tgt, (f) => {
              recMsg = `Скачиваю: ${p.label} — ${Math.round(f * 100)}%`;
              paintRec();
            });
          } else if (p.kind === 'tts') await host.localTtsDownload?.(p.engine, ttsVoice);
          else if (p.dtype === 'gpu-mixed' && pi?.units[p.modelId]?.model === 'ready') await host.localAsrUpgrade?.(p.modelId);
          else await host.localAsrDownload?.(p.modelId);
          recMsg = `Готово: ${p.label}`;
        } catch (e) {
          errs.push(`${p.label}: ${String((e as Error)?.message ?? e).slice(0, 100)}`);
        }
        paintRec();
      }
      recBusy = false;
      recMsg = errs.length ? `Не удалось скачать — ${errs.join('; ')}` : 'Загрузка запущена';
      await tick();
      paintRec();
    })();
  });
  // ---- live mode + live speech recognition (these rows belong to this block) ----
  let liveMode: Settings['liveMode'] = 'fast';
  let liveAsr: Settings['liveAsr'] = 'auto';
  let hasGroqKey = false;
  const liveSel = h('select', { class: 'grow' },
    h('option', { value: 'fast' }, 'Быстрый (локально)'),
    h('option', { value: 'quality' }, 'Качественный (Яндекс, опыт)'),
  );
  liveSel.addEventListener('change', () => {
    liveMode = liveSel.value === 'quality' ? 'quality' : 'fast';
    void host.saveSettings?.({ liveMode });
  });
  const asrSel = h('select', { class: 'grow' },
    h('option', { value: 'auto' }, 'Авто (Groq, если есть ключ)'),
    h('option', { value: 'local' }, 'Локально'),
    h('option', { value: 'groq' }, 'Groq'),
  );
  asrSel.addEventListener('change', () => {
    liveAsr = asrSel.value === 'local' || asrSel.value === 'groq' ? asrSel.value : 'auto';
    void host.saveSettings?.({ liveAsr });
  });
  const asrKeyBtn = h('button', { onclick: () => void openKeyPage(host as { openKeyPage?(url: string): Promise<void> }, GROQ_KEYS_URL) }, 'Получить ключ');
  const paintLive = (): void => {
    if (liveSel.value !== liveMode) liveSel.value = liveMode;
    if (asrSel.value !== liveAsr) asrSel.value = liveAsr;
    if (asrSel.disabled !== !hasGroqKey) asrSel.disabled = !hasGroqKey;
    if (asrKeyBtn.hidden !== hasGroqKey) asrKeyBtn.hidden = hasGroqKey;
  };
  paintLive();
  const liveBox = h('div', { 'data-live': '1' },
    h('div', { class: 'row' }, h('label', {}, 'Режим прямых эфиров'), liveSel),
    h('div', { class: 'row' }, h('label', {}, 'Распознавание речи'), asrSel, asrKeyBtn),
  );
  const vp = voicePicker(host, () => ti);
  det.append(
    liveBox,
    recBox,
    vp.el,
    h('div', { class: 'row' }, h('label', {}, 'Модель: '), sel),
    rows,
    pairBox);

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

  const fillSelect = (): void => {
    const opts: HTMLElement[] = [h('option', { value: 'auto' }, 'Автоматически')];
    for (const m of WHISPER_MODELS) {
      const es = asrModelState(m, pi);
      opts.push(h('option', { value: m.id }, `${m.label} — ${stateWord(es.state)}`));
    }
    if (setKids(sel, opts) || sel.value !== choice) sel.value = choice;
  };

  const fillRows = (): void => {
    setKids(rows, WHISPER_MODELS.map((m) => {
        const { state: st, total } = asrModelState(m, pi);
        const pct = st.total ? Math.min(100, (st.loaded / st.total) * 100) : 0;
        const btns: HTMLElement[] = [];
        if (st.phase === 'none' || st.phase === 'error') btns.push(h('button', { class: 'primary', onclick: act(() => host.localAsrDownload?.(m.id)) }, st.loaded > 0 ? `Докачать (${mb(st.total - st.loaded)} МБ)` : `Скачать модель (${mb(total)} МБ)`));
        if (st.phase === 'downloading') btns.push(h('button', { onclick: act(() => host.localAsrCancel?.(m.id)) }, 'Отмена'));
        const up = asrUpgradeState(m, pi?.units[m.id], pi?.env);
        if (up?.kind === 'offer') btns.push(h('button', { class: 'primary', onclick: act(() => host.localAsrUpgrade?.(m.id)) }, `Ускорить на видеокарте (${mb(up.bytes)} МБ)`));
        if (up?.kind === 'running') btns.push(h('button', { onclick: act(() => host.localAsrCancel?.(m.id)) }, 'Отмена'));
        if (st.phase === 'ready') btns.push(h('button', { onclick: act(() => host.localAsrDelete?.(m.id)) }, 'Удалить'));
        const us = pi?.units[m.id];
        const upLines: Array<HTMLElement | null> = [];
        if (up?.kind === 'offer') upLines.push(h('div', { class: 'hint' }, `Работает на процессоре`));
        if (up?.kind === 'running') upLines.push(h('div', { class: 'hint' }, `Скачивание версии для видеокарты… ${mb(up.loaded ?? 0)} / ${mb(up.total ?? up.bytes)} МБ`), h('progress', { max: 100, value: up.total ? Math.min(100, ((up.loaded ?? 0) / up.total) * 100) : 0, style: 'width:100%' }));
        if (up?.kind === 'failed' || (up?.kind === 'offer' && up.error)) upLines.push(h('div', { class: 'hint bad' }, `Видеокарта не подошла: ${up.error}`));
        return h('div', { style: 'margin:6px 0', 'data-model': m.id },
          h('div', {}, h('b', {}, m.label), ` — ${m.note}`),
          h('div', { class: st.phase === 'ready' ? 'hint ok' : st.phase === 'error' || st.phase === 'unsupported' ? 'hint bad' : 'hint' }, statusText(st) + (st.phase === 'ready' && us && us.device !== 'webgpu' ? ' · работает на процессоре (q8)' : st.phase === 'ready' && us ? ' · работает на видеокарте' : '')),
          ...upLines,
          st.phase === 'downloading' ? h('progress', { max: 100, value: pct, style: 'width:100%' }) : null,
          h('div', { class: 'row' }, ...btns));
      }),
    );
  };

  const repaint = (): void => {
    fillSelect();
    fillRows();
    paintRec();
    void refreshRec();
  };

  sel.addEventListener('change', () => {
    choice = sel.value as LocalAsrModelChoice;
    repaint();
    void host.saveSettings?.({ localAsrModel: choice });
  });

  let last = '';
  const tick = async (): Promise<void> => {
    void refreshPair();
    try {
      const next = (await host.getLocalAsrInfo?.()) ?? null;
      if (!next) return;
      pi = next;
      try {
        ti = (await host.getLocalTtsInfo?.()) ?? ti;
      } catch {
        /* keep the last TTS info */
      }
      void vp.sync();
      const key = JSON.stringify(Object.entries(next.units).map(([k, st]) => [k, st?.model, st?.error, st?.cpu, st?.device, st?.dtype, !!st?.upgrade, st?.upgradeError])) + JSON.stringify(next.env) + choice;
      if (key !== last) {
        last = key;
        repaint();
      } else if (Object.values(next.units).some((st) => st?.model === 'downloading' || st?.upgrade)) fillRows(); // progress only: keep the open dropdown alone
      void refreshRec(); // TTS / translator pack states change without touching the ASR key
    } catch {
      /* keep the last paint */
    }
  };

  void (async () => {
    try {
      const s = await host.getSettings?.();
      if (s) {
        choice = s.localAsrModel;
        sourceLangSetting = s.sourceLang;
        liveMode = s.liveMode;
        liveAsr = s.liveAsr;
        hasGroqKey = s.groqApiKey.trim() !== '';
        paintLive();
      }
      // the translator row starts from the language the tier resolved (setting > Twitch > detection), else the setting, else English
      if (!pairSrcPicked) pairSrc = (s?.sourceLang && s.sourceLang !== 'auto' ? s.sourceLang : getResolvedSourceLang()) ?? 'en';
    } catch {
      /* defaults */
    }
    repaint();
    void vp.sync();
    await refreshPair();
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
