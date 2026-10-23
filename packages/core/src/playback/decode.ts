import type { DubAudio } from '../providers/types';

/** Turn a provider's audio payload into an AudioBuffer on the given context. Environment-neutral. */
export async function decodeDubAudio(ctx: BaseAudioContext, audio: DubAudio): Promise<AudioBuffer> {
  if (audio.kind === 'pcm') {
    const { samples, sampleRate } = audio;
    const buffer = ctx.createBuffer(1, Math.max(1, samples.length), sampleRate);
    const channel = buffer.getChannelData(0);
    for (let i = 0; i < samples.length; i++) channel[i] = samples[i]! / 32768;
    return buffer;
  }
  // decodeAudioData detaches the ArrayBuffer it is given, so hand it a private copy.
  const copy = new Uint8Array(audio.data.byteLength);
  copy.set(audio.data);
  const decoded = await ctx.decodeAudioData(copy.buffer);
  if (!audio.skipSec) return decoded;
  const skip = Math.round((audio.skipSec ?? 0) * decoded.sampleRate);
  if (skip <= 0 || skip >= decoded.length) return decoded;
  const out = ctx.createBuffer(decoded.numberOfChannels, decoded.length - skip, decoded.sampleRate);
  for (let c = 0; c < decoded.numberOfChannels; c++) out.copyToChannel(decoded.getChannelData(c).subarray(skip), c);
  return out;
}
