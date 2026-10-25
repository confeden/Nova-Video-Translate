/**
 * Whisper language detection for the multilingual checkpoints. transformers.js 3.7.6 does NOT detect the language (it falls
 * back to English with a console warning, so Danish speech comes out as garbage), therefore we run the decoder for ONE step
 * from <|startoftranscript|> and read which language token the model puts first. Pure: the model is injected.
 */

/** the slice of a transformers.js Whisper pipeline this needs */
export interface DetectPipe {
  processor: (audio: Float32Array) => Promise<{ input_features: unknown }>;
  model: {
    generation_config?: { decoder_start_token_id?: number; lang_to_id?: Record<string, number> };
    generate(o: Record<string, unknown>): Promise<unknown>;
  };
}

/** token id -> ISO code from lang_to_id ("<|da|>": 50285) */
export function languageTokenMap(lang_to_id: Record<string, number> | undefined): Map<number, string> {
  const m = new Map<number, string>();
  for (const [k, id] of Object.entries(lang_to_id ?? {})) {
    const code = /^<\|([a-z]{2,3})\|>$/.exec(k)?.[1];
    if (code) m.set(Number(id), code);
  }
  return m;
}

/** last token of a generate() result: Tensor-like with tolist(), or nested arrays */
function lastToken(out: unknown): number | undefined {
  let v: unknown = out;
  const o = out as { tolist?: () => unknown } | undefined;
  if (o && typeof o.tolist === 'function') v = o.tolist();
  while (Array.isArray(v) && Array.isArray(v[0])) v = v[0];
  if (!Array.isArray(v) || v.length === 0) return undefined;
  const t = v[v.length - 1];
  return typeof t === 'number' ? t : typeof t === 'bigint' ? Number(t) : undefined;
}

/** ISO code of the spoken language of `audio` (16 kHz float), undefined when the model does not answer with a language token */
export async function detectWhisperLanguage(pipe: DetectPipe, audio: Float32Array): Promise<string | undefined> {
  const gc = pipe.model.generation_config;
  const sot = gc?.decoder_start_token_id;
  const langs = languageTokenMap(gc?.lang_to_id);
  if (sot === undefined || langs.size === 0) return undefined;
  const { input_features } = await pipe.processor(audio);
  const out = await pipe.model.generate({ inputs: input_features, decoder_input_ids: [sot], max_new_tokens: 1, return_timestamps: false, num_beams: 1, do_sample: false });
  const t = lastToken(out);
  return t === undefined ? undefined : langs.get(t);
}
