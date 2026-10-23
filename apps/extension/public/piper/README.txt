Vendored executables for the 'piper-wasm' local TTS engine (phonemizer only; the neural model is a runtime download).

Origin: npm package @diffusionstudio/piper-wasm@1.0.0 (tarball integrity sha512-4Hgh7wJ1PuGEVgVi1CpducESnyXwjFRJN4zXjYRpxgquM+Zh6Eqq8ZaiGpCKm4yXvT1Y2SPQXbv0dEckFD9NaQ==),
repository https://github.com/diffusion-studio/piper-wasm . Built (Emscripten 3.1.47) from rhasspy/piper-phonemize + rhasspy/espeak-ng.
Package license: MIT. Linked espeak-ng: GPL-3.0-or-later (this project is GPL-3, compatible). piper-phonemize: MIT. Piper: MIT.

Files here (sha256):
  piper_phonemize.js    fef0c2fc442d24fdef5c7c7cc37d5da2314407640fe11ab1bfe347c723dff19b   Emscripten glue (classic script, defines global createPiperPhonemize)
  piper_phonemize.wasm  b777cd107a91d2bcc6a1ea46f2c26a662a7407394fe84589198aeaa83dd7a9d6   espeak-ng + piper-phonemize (635 KB)

NOT vendored (data, runtime-downloaded on user click, pinned):
  piper_phonemize.data  29f1025eb23a5b5c192cd14a6efbce4509402ff265405072ee6f7d1a09b78f8c   18077249 bytes, espeak-ng-data (all languages) packed by Emscripten
    https://cdn.jsdelivr.net/npm/@diffusionstudio/piper-wasm@1.0.0/build/piper_phonemize.data  (identical to the npm tarball file)
  Voice models (ONNX VITS, rhasspy/piper-voices @ 5041a7a49ae5b3a0f30e6837769eb03fdbb231bd): see packages/core/src/localtts/piper/constants.ts.
    Voice dataset licenses are per voice (see each MODEL_CARD in the HF repo); the models are MIT-licensed Piper checkpoints.

Voice dataset licenses (HF MODEL_CARD @ the pinned revision): denis CC0; dmitri CC0; irina = RHVoice dataset, license UNKNOWN;
ruslan = Ruslan corpus, CC BY-NC-SA 4.0 (NON-COMMERCIAL, share-alike). Decide before shipping irina/ruslan in a public release.
