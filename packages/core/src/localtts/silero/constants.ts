/**
 * Silero TTS v5_ru (snakers4/silero-models) ported to ONNX for onnxruntime-web WASM (CPU): speakers eugene + xenia only.
 * Files produced by research/silero_onnx/convert_*.py from the official v5_ru.pt (see research/silero_onnx/README.md); sizes and
 * sha256 measured on the produced files 2026-10-22. Keep dependency-free.
 */
import type { LocalTtsVoiceInfo } from '../types';
import type { ModelFile } from '../supertonic/constants';
import { MODEL_MIRROR_BASE } from '../../localasr/mirror';

/** version tag of the converted set (bump when the files change) */
export const SILERO_REVISION = 'v5_ru-onnx-2026-10-22';

/**
 * Base URL the files are fetched from (path appended): the public-read S3 model mirror (localasr/mirror.ts). Licence of the
 * files: CC BY-NC-SA 4.0 (NOTICE.txt is stored next to them).
 */
export const SILERO_BASE_URL = `${MODEL_MIRROR_BASE}silero/`;
/** fallback while the mirror is new: nginx on the owner's VPS (see kb/server.md), plain HTTP, port 8081; drop once the mirror is proven */
export const SILERO_FALLBACK_BASE_URL = 'http://212.116.115.237:8081/silero/';

export const SILERO_ACOUSTIC = 'silero_v5_acoustic.onnx';
export const SILERO_VOCODER = 'silero_v5_vocoder_fp16w.onnx';
export const SILERO_ACCENTOR = 'silero_v5_accentor.onnx';
export const SILERO_HOMOSOLVER = 'silero_v5_homosolver_fp16w.onnx';
export const SILERO_NGRAMS = 'silero_v5_ngrams.txt';
export const SILERO_EXCEPTIONS = 'silero_v5_exceptions.txt';
export const SILERO_BERT_VOCAB = 'silero_v5_bert_vocab.txt';
export const SILERO_HOMODICT = 'silero_v5_homodict.json';

export const SILERO_FILES: readonly ModelFile[] = [
  { path: SILERO_ACOUSTIC, size: 26763653, sha256: '3cb20771ffc6a27ac6d5ed5c245e28b35ab54213a2af730e5091980cc32c1351' },
  { path: SILERO_VOCODER, size: 29290974, sha256: 'fc400f3eed5dcb3404ff14cf19730625d9a7f32c7b3f2565b79a2a4f7660f3ac' },
  { path: SILERO_HOMOSOLVER, size: 22420713, sha256: '2c398a4363c42701ddd0a80dac7a7949f1574fc4e54bef2b8d2666d336888c76' },
  { path: SILERO_ACCENTOR, size: 2173171, sha256: '2735b2c9ec7cf146969bc990b05ced434cbaec400ffbdf983766acb0484d46d8' },
  { path: SILERO_NGRAMS, size: 1087501, sha256: 'dc298d0c05a79d4f7d6f013e5093e23d26d154b82409ce274a080c1d448f702b' },
  { path: SILERO_EXCEPTIONS, size: 444305, sha256: 'fae88ef2ffc2cb22494b94367d4f5d92f4972944694f2f9f2900fadcd2c0fc22' },
  { path: SILERO_BERT_VOCAB, size: 806422, sha256: '8d00d860a9cae2d57315d2ef35a97b2961e3ad3f7b919c5a2fee5ccdd0c15949' },
  { path: SILERO_HOMODICT, size: 101321, sha256: '9a9ca3d7c3afc62f7739997576158c9a4c65dcca9aa66ae0d7b3b2a66216e29e' },
];

export const SILERO_VOICES: LocalTtsVoiceInfo[] = [
  { id: 'eugene', label: 'Евгений', gender: 'm' },
  { id: 'xenia', label: 'Ксения', gender: 'f' },
];
export const SILERO_DEFAULT_VOICE = 'eugene';
/** speaker row in the converted acoustic model (the other v5_ru speakers were dropped) */
export const SILERO_SPEAKER_INDEX: Readonly<Record<string, number>> = { eugene: 0, xenia: 1 };

/** output rate: the model's own 24 kHz path (48 kHz iSTFT + PQMF band 0), as apply_tts(sample_rate=24000) */
export const SILERO_SAMPLE_RATE = 24000;
/** acoustic frame = 600 samples at 48 kHz = 12.5 ms = 300 samples at 24 kHz */
export const SILERO_HOP_24K = 300;
export const SILERO_MAX_CHUNK_CHARS = 220;
export const SILERO_CHUNK_GAP_SEC = 0.25;
export const SILERO_SPEED_MIN = 0.8;
export const SILERO_SPEED_MAX = 1.5;
/** relative duration miss tolerated before a corrective pass */
export const SILERO_FIT_TOLERANCE = 0.01;

/** the model's symbol table (symbol_to_id = index in this string) */
export const SILERO_SYMBOLS = '_~|!+,-.:;?абвгдежзийклмнопрстуфхцчшщъыьэюяё–… ';
export const SILERO_SOS = '|';
export const SILERO_EOS = '~';
