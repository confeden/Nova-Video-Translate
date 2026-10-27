/**
 * Subtitle look: size, font, weight, colour, frame, text and background transparency, alignment, line count, ticker ("прямой поток") and the
 * original-word highlight. Pure of DOM so the normalisation and the word split are unit-tested. The background stays as it
 * was (black 55% = 45% transparency). The text transparency applies to the text, the frame and the highlight.
 */

export interface SubStyle {
  /** font size, % of the default subtitle size */
  size: number;
  /** index into SUB_FONTS */
  font: number;
  /** CSS font-weight */
  weight: SubWeight;
  /** one of SUB_COLORS[].hex */
  color: string;
  /** thin frame around the line in the text colour */
  frame: boolean;
  /** transparency of the text, the frame and the highlight, % (0 = opaque) */
  textTransparency: number;
  /** transparency of the line background, % (0 = opaque black) */
  bgTransparency: number;
  align: 'left' | 'center' | 'right';
  /** visible lines when not in ticker mode */
  lines: 1 | 2 | 3;
  /** ticker ("прямой поток"): one line; the text moves left, the centre marks the audio being played now */
  ticker: boolean;
  /** in the translation, words of the original language (Latin script) get a coloured background */
  highlight: boolean;
}

export type SubWeight = 400 | 500 | 700 | 900;

/** five fonts that read well as subtitles and cover Cyrillic */
export const SUB_FONTS: ReadonlyArray<{ label: string; css: string }> = [
  { label: 'Системный', css: 'system-ui,-apple-system,"Segoe UI",Roboto,sans-serif' },
  { label: 'Arial', css: 'Arial,Helvetica,sans-serif' },
  { label: 'Verdana', css: 'Verdana,Geneva,sans-serif' },
  { label: 'Tahoma', css: 'Tahoma,Geneva,sans-serif' },
  { label: 'Georgia', css: 'Georgia,"Times New Roman",serif' },
];

export const SUB_COLORS: ReadonlyArray<{ hex: string; label: string }> = [
  { hex: '#ffffff', label: 'белый' },
  { hex: '#ffd60a', label: 'жёлтый' },
  { hex: '#5ee6ff', label: 'голубой' },
  { hex: '#b6ff5e', label: 'салатовый' },
  { hex: '#ff8fd0', label: 'розовый' },
];

export const SUB_WEIGHTS: ReadonlyArray<SubWeight> = [400, 500, 700, 900];
export const SUB_SIZE_MIN = 70;
export const SUB_SIZE_MAX = 160;
export const SUB_TEXT_TRANSP_MAX = 90;
export const SUB_BG_TRANSP_MAX = 100;
export const SUB_TRANSP_STEP = 5;

export const DEFAULT_SUB_STYLE: SubStyle = {
  size: 100,
  font: 0,
  weight: 500,
  color: '#ffffff',
  frame: true,
  textTransparency: 20,
  bgTransparency: 25,
  align: 'center',
  lines: 2,
  ticker: false,
  highlight: false,
};

/** Repairs a stored style: unknown values fall back to the defaults, numbers are clamped. */
export function normalizeSubStyle(raw: unknown): SubStyle {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const d = DEFAULT_SUB_STYLE;
  const num = (v: unknown, def: number, lo: number, hi: number): number =>
    typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.round(v))) : def;
  const font = num(r.font, d.font, 0, SUB_FONTS.length - 1);
  const weight = SUB_WEIGHTS.find((w) => w === r.weight) ?? d.weight;
  const color = SUB_COLORS.find((c) => c.hex === r.color)?.hex ?? d.color;
  const align = r.align === 'left' || r.align === 'right' ? r.align : d.align;
  const lines = num(r.lines, d.lines, 1, 3) as 1 | 2 | 3;
  return {
    size: num(r.size, d.size, SUB_SIZE_MIN, SUB_SIZE_MAX),
    font,
    weight,
    color,
    frame: typeof r.frame === 'boolean' ? r.frame : d.frame,
    textTransparency: num(r.textTransparency, d.textTransparency, 0, SUB_TEXT_TRANSP_MAX),
    bgTransparency: num(r.bgTransparency, d.bgTransparency, 0, SUB_BG_TRANSP_MAX),
    align,
    lines,
    ticker: r.ticker === true,
    highlight: r.highlight === true,
  };
}

/** `#rrggbb` + alpha (0..1) -> `rgba(...)`. */
export function hexAlpha(hex: string, alpha: number): string {
  const n = parseInt(hex.replace('#', ''), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
}

/** Words written in Latin script (the original language of most videos). Cyrillic is the translation and is not marked. */
export const ORIGINAL_WORDS = /[A-Za-zÀ-ɏ]+/g;

export interface WordPiece {
  text: string;
  /** a word matched by the pattern (highlighted) */
  hit: boolean;
}

/** Splits a line into runs matched by `re` and everything else (concatenation of `text` gives the input back). */
export function splitWords(text: string, re: RegExp = ORIGINAL_WORDS): WordPiece[] {
  const out: WordPiece[] = [];
  let last = 0;
  for (const m of text.matchAll(new RegExp(re.source, 'g'))) {
    const at = m.index ?? 0;
    if (at > last) out.push({ text: text.slice(last, at), hit: false });
    out.push({ text: m[0], hit: true });
    last = at + m[0].length;
  }
  if (last < text.length) out.push({ text: text.slice(last), hit: false });
  return out;
}
