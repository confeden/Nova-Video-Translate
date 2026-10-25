/**
 * "Best local setup for this computer": which Whisper checkpoint + dtype, which local TTS engine and which Chrome Translator
 * pair to use, and which of those pieces are not downloaded yet (D29/D31). Pure and dependency-light: the settings panel feeds it
 * the capabilities and the installed pieces; nothing here downloads anything (a click on the panel button is the consent).
 */
import { engineInfo } from '../localtts/catalog';
import type { LocalTtsEngineId } from '../localtts/types';
import type { PairAvailability } from './translatorPair';
import { baseLang, planDtype, whisperModelInfo, type WhisperDtype, type WhisperModelId } from './whisperModels';

export interface RecommendCaps {
  /** WebGPU adapter available */
  webgpu: boolean;
  /** the adapter has shader-f16 (needed for the GPU Whisper dtype) */
  f16?: boolean;
  /** Chrome Translator availability by pair key `${src}-${tgt}`; absent key = unknown (treated as usable) */
  pairs?: Record<string, PairAvailability>;
}

export interface RecommendedSetup {
  asr: { modelId: WhisperModelId; dtype: WhisperDtype };
  tts: { engine: LocalTtsEngineId };
  /** null when the source is already Russian (nothing to translate) */
  translator: { pair: [string, string]; pivot?: 'en'; viaChrome: true } | null;
  /** short Russian why-lines */
  reasons: string[];
}

export const pairKey = (src: string, tgt: string): string => `${src}-${tgt}`;

const SMALL_EN: WhisperModelId = 'onnx-community/whisper-small.en';
const SMALL_MULTI: WhisperModelId = 'onnx-community/whisper-small';
const BASE_EN: WhisperModelId = 'onnx-community/whisper-base.en';
const BASE_MULTI: WhisperModelId = 'onnx-community/whisper-base';

/** `lang` = detected / chosen source language code (undefined = not known yet), `live` = the video is a live stream */
export function recommendedLocalSetup(caps: RecommendCaps, lang: string | undefined, live: boolean): RecommendedSetup {
  const l = baseLang(lang);
  const english = l === 'en';
  const { dtype } = planDtype({ gpu: caps.webgpu, f16: caps.f16 });
  const fastGpu = dtype === 'gpu-mixed';
  const modelId = fastGpu ? (english ? SMALL_EN : SMALL_MULTI) : english ? BASE_EN : BASE_MULTI;
  const engine: LocalTtsEngineId = caps.webgpu ? 'supertonic-webgpu' : 'silero-cpu';

  const reasons: string[] = [];
  if (fastGpu) reasons.push('Есть видеокарта с WebGPU: распознавание на ней, модель small точнее base');
  else if (caps.webgpu) reasons.push('Видеокарта без поддержки fp16: распознавание на процессоре (q8), модель base');
  else reasons.push('Нет WebGPU: распознавание на процессоре (q8), модель base');
  if (!english) reasons.push(l ? 'Язык не английский: нужна многоязычная модель' : 'Язык ещё не определён: взята многоязычная модель (английские понимают только английский)');
  reasons.push(caps.webgpu ? 'Голос Supertonic работает на видеокарте и очень быстро' : 'Без видеокарты голос Silero идёт в реальном времени на процессоре');

  let translator: RecommendedSetup['translator'] = null;
  if (l !== 'ru') {
    const src = l ?? 'en';
    const direct = caps.pairs?.[pairKey(src, 'ru')];
    const pivot = src !== 'en' && direct === 'unavailable';
    translator = { pair: [src, 'ru'], ...(pivot ? { pivot: 'en' as const } : {}), viaChrome: true };
    reasons.push(pivot ? `Chrome не переводит «${src} → ru» напрямую: перевод через английский` : 'Перевод встроенным переводчиком Chrome (бесплатно, на устройстве)');
  }
  if (live) {
    reasons.push('Прямой эфир: только локальный конвейер' + (fastGpu ? '' : ' (без видеокарты возможно отставание)'));
  }
  return { asr: { modelId, dtype }, tts: { engine }, translator, reasons };
}

/** what is already on this computer; the panel builds it from its persisted states */
export interface InstalledPieces {
  /** model id -> dtypes whose files are complete in the cache */
  asr: Record<string, readonly WhisperDtype[] | undefined>;
  /** TTS engines whose model is downloaded */
  tts: ReadonlySet<string>;
  /** Chrome Translator pair availability by `${src}-${tgt}` */
  pairs: Record<string, PairAvailability | undefined>;
}

export type MissingPiece =
  | { kind: 'asr'; modelId: WhisperModelId; dtype: WhisperDtype; label: string }
  | { kind: 'tts'; engine: LocalTtsEngineId; label: string }
  | { kind: 'translator'; src: string; tgt: string; label: string };

/** the pieces of the recommendation that are not downloaded yet, in download order: translator pack, voice, recognition model */
export function missingPieces(rec: RecommendedSetup, installed: InstalledPieces): MissingPiece[] {
  const out: MissingPiece[] = [];
  const t = rec.translator;
  if (t) {
    const pairs: Array<[string, string]> = t.pivot ? [[t.pair[0], t.pivot], [t.pivot, t.pair[1]]] : [[t.pair[0], t.pair[1]]];
    for (const [src, tgt] of pairs) {
      const a = installed.pairs[pairKey(src, tgt)];
      if (a === 'downloadable' || a === 'downloading') out.push({ kind: 'translator', src, tgt, label: `языковой пакет Chrome ${src} → ${tgt}` });
    }
  }
  if (!installed.tts.has(rec.tts.engine)) out.push({ kind: 'tts', engine: rec.tts.engine, label: `голос ${engineInfo(rec.tts.engine)?.label ?? rec.tts.engine}` });
  if (!installed.asr[rec.asr.modelId]?.includes(rec.asr.dtype)) {
    out.push({ kind: 'asr', modelId: rec.asr.modelId, dtype: rec.asr.dtype, label: `${whisperModelInfo(rec.asr.modelId)?.label ?? rec.asr.modelId}` });
  }
  return out;
}
