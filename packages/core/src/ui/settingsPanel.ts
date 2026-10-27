/**
 * Framework-free settings panel (Russian UI), shared by the extension options page and, later, the userscript.
 * The host supplies persistence and the few operations that need privileged HTTP (ListModels) or account flows.
 * API keys are shown masked and are never logged.
 */
import type { ModelInfo } from '../models';
import type { ProviderId } from '../providers/types';
import type { TokenCheck } from '../providers/yandex/oauth';
import type { VoiceReport } from './videoController';
import { SOURCE_LANG_OPTIONS } from '../lang/names';
import { isActiveState, stateText, voiceLine, type TranslateStatus } from './status';
import { DEFAULT_SETTINGS, type Settings } from '../types';
import { normHost } from '../settings';
import { GEMINI_KEYS_URL, GROQ_KEYS_URL, openKeyPage } from './keyLinks';
import { localAsrSection, type LocalAsrPanelHost } from './localAsrSection';
import { localTtsSection, type LocalTtsPanelHost } from './localTtsSection';
import { SUB_BG_TRANSP_MAX, SUB_COLORS, SUB_FONTS, SUB_SIZE_MAX, SUB_SIZE_MIN, SUB_TEXT_TRANSP_MAX, SUB_TRANSP_STEP, SUB_WEIGHTS, type SubStyle } from './subtitleStyle';
import { isReleasePageUrl, type UpdateCheckResult, type UpdateInfo } from '../update';

export interface YandexAccountInfo {
  login?: string;
  /** ms epoch, 0 / absent = unknown */
  expiresAt?: number;
}

export interface VoiceStatus {
  /** latest attempt of the Yandex tiers */
  live?: VoiceReport;
  /** latest chunk that was actually voiced (any tier) */
  voiced?: VoiceReport;
}

export interface SettingsPanelHost extends LocalTtsPanelHost, LocalAsrPanelHost {
  getSettings(): Promise<Settings>;
  saveSettings(patch: Partial<Settings>): Promise<void>;
  /** ListModels with this key; rejects when the key is invalid / unreachable */
  listGeminiModels(key: string): Promise<ModelInfo[]>;
  /** null = signed out */
  getYandexAccount(): Promise<YandexAccountInfo | null>;
  yandexLogin(): Promise<void>;
  yandexLogout(): Promise<void>;
  /** asks login.yandex.ru whether the stored token is accepted; omitted = no check button */
  yandexCheck?(): Promise<TokenCheck>;
  /** why the last login attempt failed (cleared on success) */
  getYandexLoginError?(): Promise<string | undefined>;
  getVoiceStatus?(): Promise<VoiceStatus>;
  /** result cache statistics / reset; omitted = the cache block shows only the settings */
  cacheStats?(): Promise<{ entries: number; bytes: number }>;
  cacheClear?(): Promise<void>;
  /** deletes every downloaded local model (Whisper cache, TTS packs, calibrations); omitted = no button */
  clearLocalModels?(): Promise<{ freedBytes: number }>;
  /** build version shown at the bottom ("Версия X.Y.Z") */
  version?: string;
  /** state of the video this panel controls; null = no video here; omitted = no translate block at all */
  getTranslateStatus?(): Promise<TranslateStatus | null>;
  /** starts / stops translation of that video and returns the fresh status */
  toggleTranslate?(): Promise<TranslateStatus | null>;
  /** translate the video although it was detected as Russian ("Всё равно перевести") */
  forceTranslate?(): Promise<TranslateStatus | null>;
  /** diagnostics text of the page (content-script world); null = nothing reachable */
  getDiagReport?(): Promise<{ text: string; source?: string } | null>;
  clearDiag?(): Promise<void>;
  /** shows a test subtitle on the page's player; false = no player */
  showTestCue?(text: string): Promise<boolean>;
  /** the stored newer release (shown as a banner only when present); omitted = no update notice */
  getUpdate?(): Promise<UpdateInfo | null>;
  /** user click: checks GitHub now and returns the outcome */
  checkUpdateNow?(): Promise<UpdateCheckResult>;
  /** opens the release page (https://github.com/confeden/Nova-Video-Translate/ only); omitted = window.open */
  openUpdatePage?(url: string): Promise<void>;
  /** opens an API-key page (GEMINI_KEYS_URL / GROQ_KEYS_URL only) in a new tab; omitted = window.open */
  openKeyPage?(url: string): Promise<void>;
}

export interface SettingsPanelHandle {
  refresh(): Promise<void>;
  destroy(): void;
}

export const PROVIDER_LABELS: Record<ProviderId, string> = {
  'yandex-live': 'Яндекс — живые голоса',
  yandex: 'Яндекс — обычные',
  groq: 'Groq (распознавание и перевод) + локальный голос',
  local: 'Локальные модели (без интернета-сервисов)',
  gemini: 'Gemini',
};


const NOT_TRANSLATE = /tts|live|audio|image|transcribe|embed|imagen|veo|aqa/i;

const STYLE_ID = 'nvt-settings-style';
const CSS = `
.nvt-sp{--bg:#181a1c;--fg:#f1f1f1;--mut:#9aa0a6;--line:#2b2f33;--ctl:#3c4043;--acc:#35d477;--card:#181a1c;--bad:#ff8a80;--inp:#222528;
 font:13px/1.4 "Segoe UI",Roboto,Arial,sans-serif;color:var(--fg);background:var(--bg);padding:12px;box-sizing:border-box;color-scheme:dark}
.nvt-sp h1{font-size:14px;margin:0 0 8px;padding-right:24px}
.nvt-sp h2{font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.04em;color:var(--mut);margin:0}
.nvt-sp section{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:8px 10px;margin:0 0 8px}
.nvt-sp .row{display:flex;align-items:center;gap:6px;margin:6px 0;flex-wrap:wrap}
.nvt-sp .row>label{flex:1 1 auto;color:#c9cdd1;font-size:12px}
.nvt-sp .row:has(>input[type=checkbox]){flex-wrap:nowrap}
.nvt-sp .row:has(>input[type=checkbox])>label{min-width:0}
.nvt-sp .grow{flex:1 1 auto;min-width:0}
.nvt-sp input[type=text],.nvt-sp input[type=password],.nvt-sp input[type=number],.nvt-sp select{background:var(--inp);color:var(--fg);border:1px solid var(--ctl);
 border-radius:6px;padding:3px 6px;font:inherit;font-size:12px;min-width:0;max-width:100%}
.nvt-sp button{background:transparent;color:#c9cdd1;border:1px solid var(--ctl);border-radius:6px;padding:3px 8px;font:inherit;font-size:12px;cursor:pointer}
.nvt-sp button:hover:not(:disabled){background:var(--inp);border-color:var(--acc)}
.nvt-sp button:disabled{opacity:.4;cursor:default}
.nvt-sp button.primary{background:var(--acc);color:#08361d;border-color:var(--acc);font-weight:600}
.nvt-sp button.primary:hover:not(:disabled){background:#4ade87}
.nvt-sp input[type=checkbox]{accent-color:var(--acc);width:14px;height:14px;margin:0}
.nvt-sp .prov{display:flex;align-items:center;gap:6px;padding:3px 0;border-top:1px solid #232629}
.nvt-sp .prov:first-child{border-top:0}
.nvt-sp .prov .name{flex:1;font-size:12px}
.nvt-sp .prov button{padding:0 6px;line-height:18px}
.nvt-sp .sub-row{display:flex;align-items:center;gap:6px;margin:2px 0 6px 20px;flex-wrap:wrap;font-size:12px}
.nvt-sp .hint{color:#7c8288;font-size:11px;line-height:1.35;margin:3px 0}
.nvt-sp .key{font-family:ui-monospace,Consolas,monospace;flex:1}
.nvt-sp .ok{color:var(--acc)}.nvt-sp .bad{color:var(--bad)}
.nvt-sp input[type=range]{flex:1;min-width:70px;accent-color:var(--acc)}
.nvt-sp .val{width:36px;text-align:right;font-size:12px}
.nvt-sp details>summary{cursor:pointer;list-style:none;display:flex;align-items:center;gap:6px;user-select:none}
.nvt-sp details>summary::-webkit-details-marker{display:none}
.nvt-sp details>summary::before{content:"\\25B8";color:var(--mut);transition:transform .12s}
.nvt-sp details[open]>summary::before{transform:rotate(90deg)}
.nvt-sp details[open]>summary{margin-bottom:6px}
.nvt-sp .top{border:1px solid var(--line);border-radius:8px;padding:8px 10px;margin:0 0 8px;background:#222528}
.nvt-sp .top .big{width:100%;padding:7px 10px;font-size:13px;font-weight:600;border-radius:6px}
.nvt-sp .top .big.on{background:#d33;border-color:#d33;color:#fff}
.nvt-sp .top .st{margin-top:6px;font-weight:600;font-size:12px}
.nvt-sp .top .sub{color:var(--mut);margin-top:2px;font-size:12px}
.nvt-sp .top .sub.bad{color:var(--bad)}
.nvt-sp .top .sub.ok{color:var(--acc)}
.nvt-sp .ver{color:var(--mut);font-size:11px;text-align:center;margin:2px 0 0}
.nvt-sp .foot{display:flex;justify-content:space-between;align-items:center;gap:8px;margin:6px 0 0;font-size:11px;color:var(--mut)}
.nvt-sp .foot a{color:var(--mut);text-decoration:underline;margin-left:auto}
.nvt-sp .foot a:hover{color:var(--acc)}
.nvt-sp .upd{border:1px solid var(--acc);background:#16301f;border-radius:8px;padding:8px 10px;margin:0 0 8px}
.nvt-sp .upd .upd-t{font-weight:600;margin-bottom:6px}
.nvt-sp button.link{border:0;background:none;color:var(--acc);padding:0;font-size:11px;text-decoration:underline}
.nvt-sp button.link:hover:not(:disabled){background:none;border:0;text-decoration:none}
.nvt-sp textarea{width:100%;box-sizing:border-box;height:80px;font:11px ui-monospace,Consolas,monospace;background:var(--inp);color:var(--fg);border:1px solid var(--ctl);border-radius:6px}
`;

type Child = Node | string | null | undefined | false;

function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Record<string, unknown> = {},
  ...kids: Child[]
): HTMLElementTagNameMap[K] {
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

function maskKey(k: string): string {
  return k.length <= 10 ? '••••' : `${k.slice(0, 4)}…${k.slice(-4)}`;
}

function debounce<A extends unknown[]>(fn: (...a: A) => void, ms: number): (...a: A) => void {
  let t: ReturnType<typeof setTimeout> | undefined;
  return (...a) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
}

export function mountSettingsPanel(root: HTMLElement, host: SettingsPanelHost): SettingsPanelHandle {
  const doc = root.ownerDocument;
  // inside a Shadow DOM (userscript modal) the stylesheet must live in the shadow root, not in <head>
  const rn = root.getRootNode();
  const styleHost: ParentNode = typeof ShadowRoot !== 'undefined' && rn instanceof ShadowRoot ? rn : doc;
  if (!styleHost.querySelector(`#${STYLE_ID}`)) {
    const st = doc.createElement('style');
    st.id = STYLE_ID;
    st.textContent = CSS;
    (styleHost instanceof ShadowRoot ? styleHost : (doc.head ?? doc.documentElement)).appendChild(st);
  }
  root.classList.add('nvt-sp');

  let s: Settings = structuredClone(DEFAULT_SETTINGS);
  let models: ModelInfo[] = [];
  let modelsMsg = '';
  const keyStatus = new Map<string, { ok: boolean; text: string }>();
  let yandex: YandexAccountInfo | null = null;
  let yandexCheck: { text: string; ok: boolean; avatarUrl?: string } | null = null;
  let loginError: string | undefined;
  let voiceStatus: VoiceStatus = {};
  let destroyed = false;
  const openSet = new Set<string>(['mix']);
  let status: TranslateStatus | null | undefined;
  let statusBusy = false;
  let diagMsg = '';
  let diagText = '';
  let update: UpdateInfo | null = null;
  let updateMsg = '';
  let updateBusy = false;

  const save = async (patch: Partial<Settings>): Promise<void> => {
    s = { ...s, ...patch };
    await host.saveSettings(patch);
  };
  const saveSoon = debounce((patch: Partial<Settings>) => void host.saveSettings(patch), 250);

  const loadModels = async (): Promise<void> => {
    models = [];
    modelsMsg = '';
    const key = s.geminiKeys[0];
    if (!key) return;
    try {
      models = await host.listGeminiModels(key);
    } catch {
      modelsMsg = 'Не удалось получить список моделей';
    }
  };

  // ---- sections ----

  /** collapsible section; the open/closed state survives re-renders */
  const sec = (id: string, title: string, ...kids: Child[]): HTMLElement => {
    const d = h('details', { open: openSet.has(id), ontoggle: () => (d.open ? openSet.add(id) : openSet.delete(id)) });
    d.append(h('summary', {}, h('h2', {}, title)));
    for (const k of kids) if (k) d.append(k);
    return h('section', {}, d);
  };

  /** 0.3.0: the look of the subtitle line (the same controls as the hover panel on the video) */
  const subsStyleSection = (): HTMLElement => {
    const st = s.subStyle;
    const put = (patch: Partial<SubStyle>): void => void save({ subStyle: { ...s.subStyle, ...patch } });
    const select = (options: Array<[string, string]>, value: string, onPick: (v: string) => void): HTMLElement => {
      const el = h('select', { onchange: (e: Event) => onPick((e.target as HTMLSelectElement).value) });
      for (const [v, label] of options) el.append(h('option', { value: v }, label));
      (el as HTMLSelectElement).value = value;
      return el;
    };
    const swatches = h('div', { class: 'row' });
    for (const c of SUB_COLORS) {
      const b = h('button', { type: 'button', title: c.label, onclick: () => put({ color: c.hex }) });
      b.style.background = c.hex;
      b.style.width = '22px';
      b.style.height = '22px';
      b.style.borderRadius = '50%';
      b.style.border = st.color === c.hex ? '2px solid #fff' : '2px solid transparent';
      swatches.append(b);
    }
    /** the value label follows the thumb while dragging; the setting is saved shortly after the last move */
    const transparencySlider = (label: string, key: 'textTransparency' | 'bgTransparency', max: number, value: number): HTMLElement => {
      const out = h('span', {}, value + '%');
      const input = h('input', {
        type: 'range', min: '0', max: String(max), step: String(SUB_TRANSP_STEP), value: String(value),
        oninput: (e: Event) => {
          const v = Number((e.target as HTMLInputElement).value);
          out.textContent = v + '%';
          s = { ...s, subStyle: { ...s.subStyle, [key]: v } };
          saveSoonStyle({ subStyle: s.subStyle });
        },
      });
      return h('div', { class: 'row' }, h('label', {}, label), input, out);
    };
    const saveSoonStyle = debounce((patch: Partial<Settings>) => void host.saveSettings(patch), 200);
    const weightName = (w: number): string => (w === 400 ? 'обычный' : w === 500 ? 'средний' : w === 700 ? 'жирный' : 'очень жирный');
    return sec(
      'subs-style',
      'Субтитры: вид',
      h('p', { class: 'hint' }, 'Меняется сразу. На самом видео: наведите на субтитры и нажмите ⚙.'),
      (() => {
        const sel = h('select', { onchange: () => void save({ subtitleLang: sel.value === 'translation' ? 'translation' : 'original' }) },
          h('option', { value: 'original' }, 'Оригинал'), h('option', { value: 'translation' }, 'Перевод'));
        sel.value = s.subtitleLang === 'translation' ? 'translation' : 'original';
        return h('div', { class: 'row' }, h('label', {}, 'Язык субтитров'), sel);
      })(),
      h('div', { class: 'row' }, h('label', {}, 'Размер'),
        h('input', { type: 'range', min: String(SUB_SIZE_MIN), max: String(SUB_SIZE_MAX), step: '10', value: String(st.size), onchange: (e: Event) => put({ size: Number((e.target as HTMLInputElement).value) }) }),
        h('span', {}, `${st.size}%`)),
      h('div', { class: 'row' }, h('label', {}, 'Шрифт'),
        select(SUB_FONTS.map((f, i): [string, string] => [String(i), f.label]), String(st.font), (v) => put({ font: Number(v) }))),
      h('div', { class: 'row' }, h('label', {}, 'Жирность'),
        select(SUB_WEIGHTS.map((w): [string, string] => [String(w), weightName(w)]), String(st.weight), (v) => put({ weight: Number(v) as SubStyle['weight'] }))),
      h('div', { class: 'row' }, h('label', {}, 'Цвет'), swatches),
      h('div', { class: 'row' }, h('label', {}, 'Выравнивание'),
        select([['left', 'слева'], ['center', 'по центру'], ['right', 'справа']], st.align, (v) => put({ align: v as SubStyle['align'] }))),
      h('div', { class: 'row' }, h('label', {}, 'Строк'),
        select([['1', '1'], ['2', '2'], ['3', '3']], String(st.lines), (v) => put({ lines: Number(v) as SubStyle['lines'] }))),
      transparencySlider('Прозрачность текста', 'textTransparency', SUB_TEXT_TRANSP_MAX, st.textTransparency),
      transparencySlider('Прозрачность фона', 'bgTransparency', SUB_BG_TRANSP_MAX, st.bgTransparency),
      toggle('Рамка вокруг строки', st.frame, (v) => put({ frame: v })),
      toggle('Бегущая строка', st.ticker, (v) => put({ ticker: v })),
      toggle('Неон звучащего слова (в оригинале)', st.highlight, (v) => put({ highlight: v })),
    );
  };

  const voicesSection = (): HTMLElement => {
    const list = h('div');
    // no getLocalAsrInfo => no local tiers on this host (userscript): Groq and the on-device tier are not offered
    const order = host.getLocalAsrInfo ? s.voiceOrder : s.voiceOrder.filter((id) => id !== 'groq' && id !== 'local');
    order.forEach((id, i) => {
      const cb = h('input', {
        type: 'checkbox',
        checked: s.voiceEnabled[id] !== false,
        onchange: () => void save({ voiceEnabled: { ...s.voiceEnabled, [id]: cb.checked } }),
      });
      const move = (d: number) => async (): Promise<void> => {
        const o = [...order];
        const j = i + d;
        if (j < 0 || j >= o.length) return;
        [o[i], o[j]] = [o[j]!, o[i]!];
        await save({ voiceOrder: host.getLocalAsrInfo ? o : [...o, ...s.voiceOrder.filter((x) => !o.includes(x))] });
        render();
      };
      list.append(
        h(
          'div',
          { class: 'prov' },
          cb,
          h('span', { class: 'name' }, `${i + 1}. ${PROVIDER_LABELS[id]}`),
          h('button', { title: 'Выше', disabled: i === 0, onclick: move(-1) }, '↑'),
          h('button', { title: 'Ниже', disabled: i === order.length - 1, onclick: move(1) }, '↓'),
        ),
      );
      if (id === 'yandex-live') list.append(yandexRow());
      if (id === 'groq') list.append(groqRow());
    });
    return sec(
      'src',
      'Источники озвучки',
      list,
    );
  };

  const slider = (label: string, value: number, key: 'originalVolume' | 'translationVolume'): HTMLElement => {
    const val = h('span', { class: 'val' }, `${Math.round(value * 100)}%`);
    const inp = h('input', {
      type: 'range',
      min: '0',
      max: '100',
      step: '1',
      value: String(Math.round(value * 100)),
      oninput: () => {
        const v = Number(inp.value) / 100;
        val.textContent = `${inp.value}%`;
        s = { ...s, [key]: v };
        saveSoon({ [key]: v });
      },
    });
    return h('div', { class: 'row' }, h('label', {}, label), inp, val);
  };

  const toggle = (label: string, on: boolean, onChange: (v: boolean) => void): HTMLElement => {
    const cb = h('input', { type: 'checkbox', checked: on, onchange: () => onChange(cb.checked) });
    return h('div', { class: 'row' }, h('label', {}, label), cb);
  };

  const mixSection = (): HTMLElement =>
    sec(
      'mix',
      'Звук и перевод',
      slider('Громкость оригинала', s.originalVolume, 'originalVolume'),
      slider('Громкость перевода', s.translationVolume, 'translationVolume'),
      h(
        'div',
        { class: 'row' },
        h('label', {}, 'Язык перевода'),
        h('select', { disabled: true }, h('option', {}, 'Русский')),
      ),
      toggle('Субтитры', s.subtitles === 'on', (v) => void save({ subtitles: v ? 'on' : 'off' })),
      toggle('Использовать родной русский дубляж, если есть', s.preferNativeDub !== false, (v) => void save({ preferNativeDub: v })),
      toggle('Не переводить видео на русском', s.skipRussian !== 'off', (v) => void save({ skipRussian: v ? 'on' : 'off' })),
      (() => {
        const sel = h('select', { class: 'grow', onchange: () => void save({ sourceLang: sel.value }) });
        for (const [code, label] of SOURCE_LANG_OPTIONS) sel.append(h('option', { value: code }, label));
        if (!SOURCE_LANG_OPTIONS.some(([c]) => c === s.sourceLang)) sel.append(h('option', { value: s.sourceLang }, s.sourceLang));
        sel.value = s.sourceLang;
        return h('div', { class: 'row' }, h('label', {}, 'Язык оригинала'), sel);
      })(),
      toggle('Переводить автоматически', s.autoTranslate === 'on', (v) => void save({ autoTranslate: v ? 'on' : 'off' })),
      (() => {
        const host = normHost(status?.page || location.hostname);
        if (!host) return h('div');
        return toggle(`Не переводить автоматически на ${host}`, s.autoTranslateExcluded.includes(host), (v) =>
          void save({ autoTranslateExcluded: v ? [...new Set([...s.autoTranslateExcluded, host])] : s.autoTranslateExcluded.filter((x) => x !== host) }));
      })(),
      (() => {
        const inp = h('input', { type: 'number', min: '-1', max: '60', step: '1', value: String(s.liveDelaySec ?? -1), onchange: () => void save({ liveDelaySec: Math.max(-1, Math.min(60, Math.round(Number(inp.value) || 0))) }) }) as HTMLInputElement;
        return h('div', { class: 'row' }, h('label', {}, 'Задержка эфира, с (-1 авто)'), inp);
      })(),
      (() => {
        const inp = h('input', { type: 'number', min: '0', max: '6', step: '0.5', value: String(s.dubLagSec ?? 1), onchange: () => void save({ dubLagSec: Math.max(0, Math.min(6, Number(inp.value) || 0)) }) }) as HTMLInputElement;
        return h('div', { class: 'row' }, h('label', {}, 'Задержка озвучки, с'), inp);
      })(),
      toggle('Пауза, пока не готов первый фрагмент', s.prerollPause === 'on', (v) => void save({ prerollPause: v ? 'on' : 'off' })),
      (() => {
        const sel = h('select', { class: 'grow', onchange: () => void save({ clickAction: sel.value === 'toggle' ? 'toggle' : 'settings' }) },
          h('option', { value: 'settings' }, 'открывать настройки'),
          h('option', { value: 'toggle' }, 'сразу включать перевод'),
        );
        sel.value = s.clickAction;
        return h('div', { class: 'row' }, h('label', {}, 'Клик по кнопке на плеере'), sel);
      })(),
    );

  const modelSelect = (role: 'translate' | 'tts'): HTMLSelectElement => {
    const cur = s.geminiModels[role];
    const ids = models
      .filter((m) => m.supportedGenerationMethods.includes('generateContent'))
      .map((m) => m.id)
      .filter((id) => (role === 'tts' ? /tts/i.test(id) : !NOT_TRANSLATE.test(id)));
    if (cur && !ids.includes(cur)) ids.unshift(cur);
    const sel = h('select', {
      class: 'grow',
      onchange: () => void save({ geminiModels: { ...s.geminiModels, [role]: sel.value } }),
    });
    sel.append(h('option', { value: '' }, 'Авто'));
    for (const id of ids) sel.append(h('option', { value: id }, id));
    sel.value = cur;
    return sel;
  };

  const geminiSection = (): HTMLElement => {
    const keysBox = h('div');
    s.geminiKeys.forEach((k, i) => {
      const st = keyStatus.get(k);
      const status = h('span', { class: st?.ok ? 'ok' : 'bad' }, st?.text ?? '');
      const check = h('button', {
        onclick: async () => {
          check.disabled = true;
          status.className = '';
          status.textContent = 'Проверка…';
          try {
            const m = await host.listGeminiModels(k);
            keyStatus.set(k, { ok: true, text: `Ключ работает (моделей: ${m.length})` });
            if (i === 0) models = m;
          } catch {
            keyStatus.set(k, { ok: false, text: 'Ключ не принят' });
          }
          render();
        },
      }, 'Проверить ключ');
      keysBox.append(
        h(
          'div',
          { class: 'prov' },
          h('span', { class: 'key' }, maskKey(k)),
          status,
          check,
          h('button', {
            title: 'Удалить ключ',
            onclick: async () => {
              keyStatus.delete(k);
              await save({ geminiKeys: s.geminiKeys.filter((x) => x !== k) });
              await loadModels();
              render();
            },
          }, 'Удалить'),
        ),
      );
    });
    const newKey = h('input', { type: 'password', class: 'grow', placeholder: 'Вставьте API-ключ Google AI Studio', autocomplete: 'off' });
    const add = async (): Promise<void> => {
      const v = newKey.value.trim();
      if (!v || s.geminiKeys.includes(v)) return;
      newKey.value = '';
      await save({ geminiKeys: [...s.geminiKeys, v] });
      await loadModels();
      render();
    };
    newKey.addEventListener('keydown', (e) => {
      if ((e as KeyboardEvent).key === 'Enter') void add();
    });
    return sec(
      'gem',
      'Gemini',
      keysBox,
      h('div', { class: 'row' }, newKey, h('button', { class: 'primary', onclick: () => void add() }, 'Добавить'), h('button', { onclick: () => void openKeyPage(host, GEMINI_KEYS_URL) }, 'Получить ключ')),
      h('div', { class: 'row' }, h('label', {}, 'Модель перевода'), modelSelect('translate')),
      h('div', { class: 'row' }, h('label', {}, 'Модель озвучки'), modelSelect('tts')),
      modelsMsg ? h('div', { class: 'hint bad' }, modelsMsg) : null,
    );
  };

  // ---- Chrome built-in AI (Gemini Nano audio ASR + Translator en->ru): status and an explicit, click-only download ----
  type AiApi = { availability(o?: unknown): Promise<string>; create(o?: unknown): Promise<unknown> };
  const aiEnv = (): { LanguageModel?: AiApi; Translator?: AiApi } => globalThis as unknown as { LanguageModel?: AiApi; Translator?: AiApi };
  const AI_LM_OPTS = { expectedInputs: [{ type: 'audio' }, { type: 'text', languages: ['en'] }], expectedOutputs: [{ type: 'text', languages: ['en'] }] };
  const AI_TR_OPTS = { sourceLanguage: 'en', targetLanguage: 'ru' };
  const AI_STATE: Record<string, string> = { available: 'установлена', downloadable: 'можно скачать', downloading: 'скачивается', unavailable: 'недоступна' };
  let aiInfo: { lm: string; tr: string } | null = null;
  let aiBusy = '';
  const aiProbe = async (): Promise<void> => {
    const e = aiEnv();
    const ask = async (api: AiApi | undefined, o: unknown): Promise<string> => {
      if (!api) return 'absent';
      try {
        return await api.availability(o);
      } catch {
        return 'unavailable';
      }
    };
    aiInfo = { lm: await ask(e.LanguageModel, AI_LM_OPTS), tr: await ask(e.Translator, AI_TR_OPTS) };
    if (!destroyed) render();
  };
  const aiDownload = async (): Promise<void> => {
    const e = aiEnv();
    const run = async (name: string, api: AiApi | undefined, o: Record<string, unknown>): Promise<void> => {
      if (!api) return;
      aiBusy = `${name}: 0%`;
      render();
      const monitor = (m: EventTarget): void =>
        m.addEventListener('downloadprogress', (ev) => {
          aiBusy = `${name}: ${Math.round(((ev as Event & { loaded?: number }).loaded ?? 0) * 100)}%`;
          if (!destroyed) render();
        });
      const created = (await api.create({ ...o, monitor })) as { destroy?: () => void };
      created.destroy?.();
    };
    try {
      if (aiInfo?.tr === 'downloadable' || aiInfo?.tr === 'downloading') await run('Переводчик', e.Translator, AI_TR_OPTS);
      if (aiInfo?.lm === 'downloadable' || aiInfo?.lm === 'downloading') await run('Распознавание речи', e.LanguageModel, AI_LM_OPTS);
    } catch (err) {
      aiBusy = `ошибка: ${err instanceof Error ? err.message : 'не удалось скачать'}`;
      render();
      return;
    }
    aiBusy = '';
    await aiProbe();
  };
  const chromeAiSection = (): HTMLElement => {
    if (!aiInfo && !aiBusy) void aiProbe();
    const st = (v: string | undefined): string => (v === 'absent' ? 'нет в этом браузере' : (v && AI_STATE[v]) || '…');
    const need = !!aiInfo && (aiInfo.lm === 'downloadable' || aiInfo.tr === 'downloadable');
    return sec('chromeai', 'Нейросеть Chrome (встроенная)',
      h('div', { class: 'hint' }, `Распознавание речи: ${st(aiInfo?.lm)}; переводчик: ${st(aiInfo?.tr)}`),
      need || aiBusy
        ? h('div', { class: 'row' },
            h('button', { class: 'primary', disabled: !!aiBusy && !aiBusy.startsWith('ошибка'), onclick: () => void aiDownload() }, 'Скачать модели Chrome'),
            aiBusy ? h('span', { class: aiBusy.startsWith('ошибка') ? 'bad' : 'hint', style: 'margin-left:8px' }, aiBusy) : null)
        : null,
    );
  };

  const groqRow = (): HTMLElement => {
    const input = h('input', { type: 'password', class: 'grow', placeholder: 'Ключ Groq (вставьте сюда)', autocomplete: 'off', value: s.groqApiKey });
    const getBtn = h('button', { onclick: () => void openKeyPage(host, GROQ_KEYS_URL) }, 'Получить ключ');
    const saved = h('span', { class: 'ok' }, '✓');
    const sync = (): void => {
      const has = input.value.trim() !== '';
      getBtn.hidden = has;
      saved.hidden = !has;
    };
    sync();
    const commit = (): void => void save({ groqApiKey: input.value.trim() });
    input.addEventListener('input', sync);
    input.addEventListener('change', commit);
    input.addEventListener('paste', () => setTimeout(() => { sync(); commit(); }, 0));
    return h('div', { class: 'sub-row' }, input, saved, getBtn);
  };

  const when = (t: number): string => new Date(t).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  const outcomeText = (r: VoiceReport): { text: string; good: boolean } => {
    switch (r.outcome) {
      case 'ok':
        return { text: `озвучено: ${r.label ?? ''}`, good: true };
      case 'declined':
        return { text: 'живые голоса недоступны для этого видео или языка — использованы обычные', good: false };
      case 'auth-rejected':
        return { text: 'вход не принят Яндексом — войдите снова', good: false };
      case 'no-token':
        return { text: 'вы не вошли в Яндекс — живые голоса не использовались', good: false };
      default:
        return { text: `ошибка${r.detail ? `: ${r.detail}` : ''}`, good: false };
    }
  };

  const yandexRow = (): HTMLElement => {
    const expired = !!yandex && !!yandex.expiresAt && yandex.expiresAt <= Date.now();
    const last = voiceStatus.live ? outcomeText(voiceStatus.live) : null;
    if (!yandex) {
      return h('div', { class: 'sub-row' },
        h('button', { class: 'primary', onclick: () => void host.yandexLogin() }, 'Войти в Яндекс'),
        loginError ? h('span', { class: 'bad' }, loginError) : null);
    }
    return h('div', { class: 'sub-row' },
      h('span', { class: expired ? 'bad' : 'ok' }, expired ? 'Вход истёк — войдите снова' : `Вы вошли${yandex.login ? `: ${yandex.login}` : ''}`),
      h('button', {
        onclick: async () => {
          await host.yandexLogout();
          yandex = null;
          yandexCheck = null;
          render();
        },
      }, expired ? 'Войти снова' : 'Выйти'),
      last && !last.good && voiceStatus.live ? h('span', { class: 'bad' }, last.text) : null);
  };

  const cacheSection = (): HTMLElement => {
    const info = h('div', { class: 'hint' }, host.cacheStats ? 'В кэше: …' : '');
    const showStats = async (): Promise<void> => {
      if (!host.cacheStats) return;
      try {
        const st = await host.cacheStats();
        info.textContent = `В кэше: ${st.entries} фрагментов, ${(st.bytes / 1048576).toFixed(1)} МБ`;
      } catch {
        info.textContent = 'В кэше: нет данных';
      }
    };
    void showStats();
    const num = (label: string, value: number, min: number, max: number, key: 'cacheDays' | 'cacheMaxMB'): HTMLElement => {
      const inp = h('input', {
        type: 'number',
        min: String(min),
        max: String(max),
        value: String(value),
        style: 'width:90px',
        onchange: () => {
          const v = Math.min(max, Math.max(min, Math.round(Number(inp.value) || value)));
          inp.value = String(v);
          void save({ [key]: v } as Partial<Settings>);
        },
      });
      return h('div', { class: 'row' }, h('label', {}, label), inp);
    };
    const clear = h('button', {
      disabled: !host.cacheClear,
      onclick: async () => {
        clear.disabled = true;
        try {
          await host.cacheClear?.();
        } finally {
          clear.disabled = false;
          await showStats();
        }
      },
    }, 'Очистить кэш');
    return sec(
      'cache',
      'Кэш переводов',
      toggle('Кэшировать готовые переводы', s.cacheEnabled && s.cacheProviders.includes('gemini'), (v) =>
        void save({ cacheEnabled: v, cacheProviders: v ? [...new Set<ProviderId>([...s.cacheProviders, 'gemini', 'groq', 'local'])] : s.cacheProviders }),
      ),
      num('Хранить, дней', s.cacheDays, 1, 30, 'cacheDays'),
      num('Максимальный размер, МБ', s.cacheMaxMB, 10, 5000, 'cacheMaxMB'),
      h('div', { class: 'row' }, clear),
      info,
    );
  };

  // ---- translate toggle + status (top of the panel) ----

  const topBox = h('div', { class: 'top' });
  let lastTopSig = '';
  const renderTop = (): void => {
    const st = status;
    const active = !!st && (isActiveState(st.state) || st.state === 'native-dub');
    const forceable = !!st?.canForce;
    const btn = h(
      'button',
      {
        class: `big ${active ? 'on' : 'primary'}`,
        disabled: !st || statusBusy,
        onclick: async () => {
          statusBusy = true;
          renderTop();
          try {
            status = (await (forceable ? (host.forceTranslate ?? host.toggleTranslate)?.call(host) : host.toggleTranslate?.())) ?? status;
          } catch {
            /* the next poll shows the real state */
          }
          statusBusy = false;
          renderTop();
        },
      },
      st ? (active ? 'Перевод: Выключить' : forceable ? 'Всё равно перевести' : 'Перевод: Включить') : st === undefined ? 'Перевод: проверяю страницу…' : 'Перевод: нет видео на странице',
    );
    const lines: Child[] = [];
    if (st) {
      lines.push(h('div', { class: 'st' }, stateText(st.state, st.slow, { etaSec: st.etaSec, source: st.etaSource })));
      if (st.language) lines.push(h('div', { class: st.state === 'skipped-ru' ? 'sub' : 'hint' }, st.language));
      if (st.voice) lines.push(h('div', { class: 'sub ok' }, voiceLine(st.voice, st.later)));
      if (st.subtitles) lines.push(h('div', { class: 'sub ok' }, st.subtitles));
      // problem / warning lines are NOT shown here (owner decision): they live in the diagnostics report only.
      // The one exception is the first blocking reason of the local tier (nothing audible yet): one line, no banner
      if (st.reason) lines.push(h('div', { class: 'sub bad', 'data-reason': '1' }, st.reason));
    } else if (st === null) {
      lines.push(h('div', { class: 'hint' }, 'Нет видео на странице'));
    }
    const kids = [btn, ...(lines.filter(Boolean) as Node[])];
    // identical render (the 1 s poll with an unchanged status) must not swap the nodes: no twitch, hover / focus kept
    const sig = kids.map((k) => (k as Element).outerHTML ?? k.textContent ?? '').join('');
    if (sig === lastTopSig && topBox.childNodes.length === kids.length) return;
    lastTopSig = sig;
    topBox.replaceChildren(...kids);
  };
  const pollStatus = async (): Promise<void> => {
    if (destroyed || statusBusy || !host.getTranslateStatus) return;
    try {
      status = await host.getTranslateStatus();
    } catch {
      status = null;
    }
    if (!destroyed) renderTop();
  };
  const pollTimer = host.getTranslateStatus ? setInterval(() => void pollStatus(), 1000) : undefined;

  // ---- diagnostics ----

  /** Writes the report to a file: the save dialog opens on the Desktop where the browser supports it, else a normal download. Returns the file name. */
  const saveReport = async (text: string): Promise<string | null> => {
    const name = `nvt-report-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.txt`;
    try {
      const pick = (globalThis as unknown as { showSaveFilePicker?: (o: unknown) => Promise<{ name: string; createWritable(): Promise<{ write(d: string): Promise<void>; close(): Promise<void> }> }> }).showSaveFilePicker;
      if (pick) {
        const fh = await pick({ suggestedName: name, startIn: 'desktop', types: [{ description: 'Текст', accept: { 'text/plain': ['.txt'] } }] });
        const w = await fh.createWritable();
        await w.write(text);
        await w.close();
        return fh.name;
      }
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') return null;
    }
    try {
      const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
      const a = h('a', { href: url, download: name });
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
      return `${name} (папка «Загрузки»)`;
    } catch {
      return null;
    }
  };

  const copyText = async (text: string): Promise<boolean> => {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      /* fall through to the legacy path (focus rules of iframes / permission policy) */
    }
    try {
      const ta = doc.createElement('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;left:-9999px;top:0';
      (doc.body ?? doc.documentElement).appendChild(ta);
      ta.select();
      const ok = doc.execCommand('copy');
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  };

  const diagSection = (): HTMLElement => {
    const msg = h('div', { class: 'hint' }, diagMsg);
    const set = (m: string, text = ''): void => {
      diagMsg = m;
      diagText = text;
      render();
    };
    return sec(
      'diag',
      'Диагностика',
      h(
        'div',
        { class: 'row' },
        host.getDiagReport
          ? h('button', {
              class: 'primary',
              onclick: async () => {
                let r: { text: string; source?: string } | null = null;
                try {
                  r = (await host.getDiagReport?.()) ?? null;
                } catch {
                  r = null;
                }
                if (!r) return set('Нет данных: откройте страницу с видео.');
                const lines = r.text.split('\n').length;
                const from = r.source ? ` (вкладка ${r.source})` : '';
                const saved = await saveReport(r.text);
                if (saved) set(`Отчёт сохранён: ${saved}${from}.`);
                else set(`Не удалось сохранить файл${from} — выделите текст ниже и скопируйте вручную.`, r.text);
              },
            }, 'Сохранить отчёт на рабочий стол')
          : null,
        host.clearDiag
          ? h('button', {
              onclick: async () => {
                await host.clearDiag?.().catch(() => {});
                set('Журнал очищен.');
              },
            }, 'Очистить журнал')
          : null,
        host.showTestCue
          ? h('button', {
              onclick: async () => {
                const ok = await host.showTestCue?.('Тестовый субтитр: так выглядят субтитры NVT').catch(() => false);
                set(ok ? 'Субтитр показан.' : 'На странице нет плеера с видео.');
              },
            }, 'Показать тестовый субтитр')
          : null,
      ),
      msg,
      diagText ? h('textarea', { readOnly: true, value: diagText, onfocus: (e: Event) => (e.target as HTMLTextAreaElement).select() }) : null,
    );
  };

  const openUpdate = async (url: string): Promise<void> => {
    if (!isReleasePageUrl(url)) return;
    if (host.openUpdatePage) await host.openUpdatePage(url).catch(() => window.open(url, '_blank', 'noopener'));
    else window.open(url, '_blank', 'noopener');
  };

  const checkNow = async (): Promise<void> => {
    if (!host.checkUpdateNow || updateBusy) return;
    updateBusy = true;
    updateMsg = 'Проверяем…';
    render();
    try {
      const r = await host.checkUpdateNow();
      update = r.update;
      updateMsg = r.failed ? 'Не удалось проверить, попробуйте позже' : r.update ? '' : 'Установлена последняя версия';
    } catch {
      updateMsg = 'Не удалось проверить, попробуйте позже';
    } finally {
      updateBusy = false;
      render();
    }
  };

  /** prominent row at the top, only while a newer release is stored */
  const updateBanner = (): Node | null => {
    if (!update) return null;
    const cur = update;
    return h(
      'div',
      { class: 'upd' },
      h('div', { class: 'upd-t' }, `Доступна новая версия ${cur.version} (у вас ${host.version ?? '—'})`),
      h('button', { class: 'primary', onclick: () => void openUpdate(cur.url) }, 'Открыть страницу релиза'),
    );
  };

  /** version line with the forced-check link (only when the host can check) */
  const versionLine = (): Node | null => {
    const kids: Child[] = [];
    if (host.version) kids.push(`Версия ${host.version}`);
    if (host.checkUpdateNow) {
      kids.push(
        host.version ? ' · ' : null,
        h('button', { class: 'link', disabled: updateBusy, onclick: () => void checkNow() }, 'Проверить обновления'),
        updateMsg ? ` ${updateMsg}` : null,
      );
    }
    return kids.length ? h('div', { class: 'ver' }, ...kids) : null;
  };

  // two-step wipe of the local models: 1st click arms for 4 s, 2nd click runs it (no dialog)
  let clearStep: 'idle' | 'armed' | 'busy' = 'idle';
  let clearMsg = '';
  let clearTimer: ReturnType<typeof setTimeout> | undefined;
  const fmtBytes = (n: number): string => (n >= 1e9 ? `${(n / 1e9).toFixed(1)} ГБ` : `${Math.max(0, Math.round(n / 1e6))} МБ`);
  const onClear = async (): Promise<void> => {
    if (clearStep === 'busy' || !host.clearLocalModels) return;
    if (clearStep === 'idle') {
      clearStep = 'armed';
      clearMsg = '';
      clearTimer = setTimeout(() => {
        clearStep = 'idle';
        render();
      }, 4000);
      render();
      return;
    }
    clearTimeout(clearTimer);
    clearStep = 'busy';
    render();
    try {
      const r = await host.clearLocalModels();
      clearMsg = `Удалено: ${fmtBytes(r.freedBytes)}`;
    } catch {
      clearMsg = 'Ошибка';
    }
    clearStep = 'idle';
    render();
  };
  const footer = (): Node => {
    const kids: Child[] = [];
    if (host.clearLocalModels) {
      kids.push(
        h('button', { class: 'clear-models', disabled: clearStep === 'busy', onclick: () => void onClear() }, clearStep === 'armed' ? 'Точно удалить?' : 'Удалить все модели'),
        clearMsg ? h('span', {}, clearMsg) : null,
      );
    }
    kids.push(h('a', { href: 'https://t.me/nova_txt', target: '_blank', rel: 'noopener' }, 'Telegram: t.me/nova_txt'));
    return h('div', { class: 'foot' }, ...kids);
  };

  function render(): void {
    if (destroyed) return;
    renderTop();
    const kids: Child[] = [
      h('h1', {}, 'Nova Video Translate'),
      updateBanner(),
      host.getTranslateStatus ? topBox : null,
      mixSection(),
      subsStyleSection(),
      voicesSection(),
      geminiSection(),
      host.getLocalAsrInfo ? chromeAiSection() : null,
      host.getLocalTtsInfo ? localTtsSection(host) : null,
      host.getLocalAsrInfo ? localAsrSection(host) : null,
      cacheSection(),
      diagSection(),
      versionLine(),
      footer(),
    ];
    root.replaceChildren(...(kids.filter(Boolean) as Node[]));
  }

  const refresh = async (): Promise<void> => {
    s = await host.getSettings();
    yandex = await host.getYandexAccount();
    loginError = (await host.getYandexLoginError?.().catch(() => undefined)) ?? undefined;
    voiceStatus = (await host.getVoiceStatus?.().catch(() => ({}))) ?? {};
    update = (await host.getUpdate?.().catch(() => null)) ?? null;
    render();
    await loadModels();
    render();
  };
  void refresh();
  void pollStatus();

  return {
    refresh,
    destroy() {
      destroyed = true;
      if (pollTimer) clearInterval(pollTimer);
      root.replaceChildren();
    },
  };
}
