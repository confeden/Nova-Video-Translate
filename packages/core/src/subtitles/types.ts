import type { AudioChunk, SubtitleCue } from '../providers/types';

/** Where a layer of cues came from. Layer priority in the controller: voice > whole > chunk. */
export type SubtitleOrigin = 'voice' | 'yandex' | 'captions' | 'gemini' | 'chrome-ai';

/** A source cannot serve this video; the message is Russian and is shown in the settings panel and the button tooltip. */
export class SubtitleUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SubtitleUnavailable';
  }
}

export interface WholeLoadCtx {
  signal: AbortSignal;
  currentTime(): number;
  /** call as soon as the first Russian cues exist (and again with the grown list): that commits the chain to this source */
  onPartial(cues: SubtitleCue[]): void;
  /** refine the visible source name once known, e.g. 'субтитры YouTube + локальный перевод' */
  setLabel(label: string): void;
}

/** A source that yields the whole timeline at once (platform / Yandex subtitles). */
export interface WholeSource {
  readonly id: SubtitleOrigin;
  readonly label: string;
  /** cheap, no network */
  isAvailable(): boolean | Promise<boolean>;
  /** why isAvailable() is false (for the panel warning line) */
  unavailableReason?(): string;
  /** resolves with all Russian cues; throws SubtitleUnavailable (reason) when it cannot deliver */
  load(ctx: WholeLoadCtx): Promise<SubtitleCue[]>;
}

/** A source that transcribes+translates audio chunks one by one (videos without any captions). */
export interface ChunkSource {
  readonly id: SubtitleOrigin;
  readonly label: string;
  /** cheap, no network */
  isAvailable(): boolean | Promise<boolean>;
  unavailableReason?(): string;
  /** Russian cues on the VIDEO timeline (chunk.startSec already added); [] = no speech. Throws on failure. */
  transcribe(chunk: AudioChunk, signal: AbortSignal): Promise<SubtitleCue[]>;
}

/** Local (browser) or remote text translation of cues to Russian. */
export interface CueTranslator {
  readonly id: 'chrome-ai' | 'gemini';
  readonly label: string;
  isAvailable(sourceLang: string): boolean | Promise<boolean>;
  /** keeps timings, returns cues in the same order with Russian `text` and the original in `src` */
  translate(cues: SubtitleCue[], sourceLang: string, signal: AbortSignal): Promise<SubtitleCue[]>;
}
