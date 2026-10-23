/**
 * Splits ONE synthesized audio (several sentences voiced in a single TTS call, so the voice stays identical) back
 * into per-sentence clips. Forced alignment on silences: the energy envelope (10 ms windows) gives candidate
 * pauses; dynamic programming picks the n-1 pauses that best match the expected sentence boundaries (cumulative
 * character counts), tolerating extra pauses the model adds inside sentences. A confidence gate rejects
 * ambiguous audio so the caller can fall back to one call per sentence.
 */

export interface AlignOptions {
  /** envelope window, seconds, default 0.010 */
  windowSec?: number;
  /** a window is "quiet" below this fraction of the 90th-percentile window RMS, default 0.05 (-26 dB) */
  quietRatio?: number;
  /** shortest pause that can be a cut, seconds, default 0.06 */
  minGapSec?: number;
  /** a chosen cut needs a pause at least this long, seconds, default 0.12 */
  minCutGapSec?: number;
  /** allowed ratio of an aligned clip's speech duration to the char-count expectation, default [0.4, 2.5] */
  durationRatio?: [number, number];
}

export interface AlignResult {
  ok: boolean;
  /** 0..1, min over the cuts (1 for a single sentence) */
  confidence: number;
  /** n-1 sample indices (centre of the chosen pauses) */
  cuts: number[];
  /** n clip boundaries as [start, end) sample ranges, covering the whole input */
  ranges: [number, number][];
  /** why ok is false */
  reason?: string;
}

interface Gap {
  /** window indices [a, b) */
  a: number;
  b: number;
  durSec: number;
  /** centre, seconds from speech start */
  pos: number;
}

export function alignSentences(
  pcm: Int16Array,
  sampleRate: number,
  charCounts: number[],
  opts: AlignOptions = {},
): AlignResult {
  const n = charCounts.length;
  const whole: [number, number][] = [[0, pcm.length]];
  if (n <= 1) return { ok: true, confidence: 1, cuts: [], ranges: whole };

  const winSec = opts.windowSec ?? 0.01;
  const win = Math.max(1, Math.round(winSec * sampleRate));
  const nWin = Math.floor(pcm.length / win);
  const fail = (reason: string): AlignResult => ({ ok: false, confidence: 0, cuts: [], ranges: whole, reason });
  if (nWin < 10) return fail('too short');

  let sum = 0;
  for (let i = 0; i < pcm.length; i++) sum += pcm[i]!;
  const dc = sum / pcm.length;
  const rms = new Float64Array(nWin);
  for (let w = 0; w < nWin; w++) {
    let e = 0;
    for (let i = w * win; i < (w + 1) * win; i++) {
      const v = pcm[i]! - dc;
      e += v * v;
    }
    rms[w] = Math.sqrt(e / win);
  }
  const sorted = Array.from(rms).sort((x, y) => x - y);
  const p90 = sorted[Math.floor(sorted.length * 0.9)] ?? 0;
  if (p90 < 30) return fail('silent');
  const thr = p90 * (opts.quietRatio ?? 0.05);

  // speech span = first..last non-quiet window
  let first = 0;
  while (first < nWin && rms[first]! < thr) first++;
  let last = nWin - 1;
  while (last > first && rms[last]! < thr) last--;
  if (last - first < 10) return fail('no speech');
  const speechSec = (last - first + 1) * winSec;

  const minGapWin = Math.max(1, Math.round((opts.minGapSec ?? 0.06) / winSec));
  const gaps: Gap[] = [];
  for (let w = first; w <= last; ) {
    if (rms[w]! >= thr) {
      w++;
      continue;
    }
    let e = w;
    while (e <= last && rms[e]! < thr) e++;
    if (e - w >= minGapWin) gaps.push({ a: w, b: e, durSec: (e - w) * winSec, pos: ((w + e) / 2 - first) * winSec });
    w = e;
  }
  if (gaps.length < n - 1) return fail(`only ${gaps.length} pauses for ${n} sentences`);

  const totalChars = charCounts.reduce((a, b) => a + Math.max(1, b), 0);
  const expected: number[] = [];
  let acc = 0;
  for (let j = 0; j < n - 1; j++) {
    acc += Math.max(1, charCounts[j]!);
    expected.push((acc / totalChars) * speechSec);
  }
  const sigma = Math.max(0.5, 0.12 * speechSec);
  const gapScore = (g: Gap) => Math.min(g.durSec, 0.5) * 6; // 0.5 s pause = 3 points
  const score = (g: Gap, j: number) => gapScore(g) - ((g.pos - expected[j]!) / sigma) ** 2;

  // DP: best[j][g] = best total score choosing gap g for boundary j (gaps strictly increasing)
  const G = gaps.length;
  const NEG = -1e18;
  const best: number[][] = Array.from({ length: n - 1 }, () => new Array<number>(G).fill(NEG));
  const from: number[][] = Array.from({ length: n - 1 }, () => new Array<number>(G).fill(-1));
  for (let g = 0; g < G; g++) best[0]![g] = score(gaps[g]!, 0);
  for (let j = 1; j < n - 1; j++) {
    for (let g = 0; g < G; g++) {
      let bv = NEG;
      let bi = -1;
      for (let h = 0; h < g; h++) {
        if (best[j - 1]![h]! > bv) {
          bv = best[j - 1]![h]!;
          bi = h;
        }
      }
      if (bi >= 0) {
        best[j]![g] = bv + score(gaps[g]!, j);
        from[j]![g] = bi;
      }
    }
  }
  let bg = -1;
  let bs = NEG;
  for (let g = 0; g < G; g++) if (best[n - 2]![g]! > bs) (bs = best[n - 2]![g]!), (bg = g);
  if (bg < 0) return fail('no consistent pauses');
  const chosen: Gap[] = new Array(n - 1);
  for (let j = n - 2, g = bg; j >= 0; j--) {
    chosen[j] = gaps[g]!;
    g = from[j]![g]!;
  }

  // confidence gate
  const minCut = opts.minCutGapSec ?? 0.12;
  const [rLo, rHi] = opts.durationRatio ?? [0.4, 2.5];
  let confidence = 1;
  for (let j = 0; j < n - 1; j++) {
    const g = chosen[j]!;
    if (g.durSec < minCut) return fail(`pause ${j} too short (${(g.durSec * 1000).toFixed(0)} ms)`);
    // a boundary pause must also clearly outrank the pauses inside the neighbouring sentences: compare with the
    // longest unchosen pause nearer than the neighbours' chosen cuts (ratio test)
    const lo = j === 0 ? -Infinity : chosen[j - 1]!.pos;
    const hi = j === n - 2 ? Infinity : chosen[j + 1]!.pos;
    let rival = 0;
    for (const o of gaps) if (o !== g && o.pos > lo && o.pos < hi && !chosen.includes(o)) rival = Math.max(rival, o.durSec);
    const ratio = rival > 0 ? g.durSec / rival : 4;
    confidence = Math.min(confidence, Math.min(1, g.durSec / 0.2), Math.min(1, ratio / 1.3));
  }
  // per-sentence speech duration vs expectation
  const bounds = [first * winSec, ...chosen.map((g) => first * winSec + g.pos), (last + 1) * winSec];
  for (let j = 0; j < n; j++) {
    const exp = ((Math.max(1, charCounts[j]!) / totalChars) * speechSec);
    const got = bounds[j + 1]! - bounds[j]! - (j < n - 1 ? chosen[j]!.durSec / 2 : 0) - (j > 0 ? chosen[j - 1]!.durSec / 2 : 0);
    const ratio = got / exp;
    if (ratio < rLo || ratio > rHi) return fail(`sentence ${j} duration ratio ${ratio.toFixed(2)}`);
    confidence = Math.min(confidence, ratio < 0.6 || ratio > 1.7 ? 0.5 : 1);
  }
  const cuts = chosen.map((g) => Math.round(((g.a + g.b) / 2) * win));
  const ranges: [number, number][] = [];
  let prev = 0;
  for (const c of cuts) {
    ranges.push([prev, c]);
    prev = c;
  }
  ranges.push([prev, pcm.length]);
  return { ok: confidence >= 0.5, confidence, cuts, ranges, reason: confidence >= 0.5 ? undefined : 'low confidence' };
}
