import { YoutubeCaptionTimeline, censoredInRange } from './cascade/captions';
import { CaptionPretranslator } from './cascade/pretranslate';
import { ChromeTextTranslator } from './cascade/translate';
import { ChromePromptAudioAsr } from '../localasr/chromePrompt';
import { createWhisperAsr, type LasrTransport } from '../localasr/whisperClient';
import { localAsrRegistry } from '../localasr/registry';
import type { CaptionsReader } from '../subtitles/captionsBridge';
import { GroqAsr } from './groq/asr';
import { GroqChatTranslator } from './groq/translate';
import { createGroqProvider } from './groq';
import { createLocalProvider } from './local';
import { LiveGemini } from '../ui/videoController';
import { createYandexProviders } from './yandex';
import { transportFetch } from './transportFetch';
import type { Transport } from './types';
import type { Settings } from '../types';
import type { DubProvider } from './types';

/** The provider chain and caption shortcut are identical in both delivery formats. */
export function createPageProviders(o: {
  transport: Transport;
  getSettings(): Settings;
  reader: CaptionsReader;
  localTts: { warmUp(): Promise<void> };
  whisperTransport?: LasrTransport;
}) {
  const { transport, getSettings } = o;
  const timeline = new YoutubeCaptionTimeline({ reader: o.reader });
  let timelineVid = '';
  const youtubeCaptions = () => {
    if (!/(^|\.)youtube\.com$/.test(location.hostname)) return undefined;
    const vid = new URLSearchParams(location.search).get('v') ?? location.pathname;
    if (vid !== timelineVid) {
      timelineVid = vid;
      timeline.reset();
    }
    return timeline;
  };
  const y = createYandexProviders(transport, { getToken: () => getSettings().yandexToken });
  localAsrRegistry.register(createWhisperAsr(o.whisperTransport, () => getSettings().localAsrModel));
  localAsrRegistry.register(new ChromePromptAudioAsr());
  const chrome = new ChromeTextTranslator();
  let groqChat: GroqChatTranslator | undefined;
  const translators = () => groqChat ? [chrome, groqChat] : [chrome];
  const pretranslate = new CaptionPretranslator({ translators, tier: 'groq' });
  const groq = createGroqProvider({ transport, getSettings, captions: youtubeCaptions, pretranslate });
  groqChat = new GroqChatTranslator(groq.client, groq.models);
  const local = createLocalProvider({ captions: youtubeCaptions, translators, pretranslate, getSourceLang: () => getSettings().sourceLang, liveAsr: { groq: new GroqAsr(groq.client, groq.models), hasKey: () => groq.client.hasKey(), mode: () => getSettings().liveAsr } });
  const s = getSettings();
  if (s.voiceEnabled.groq !== false || s.voiceEnabled.local !== false) void o.localTts.warmUp();
  return {
    providers: [y.yandexLive, y.yandex, groq, local, new LiveGemini(getSettings, transportFetch(transport))] satisfies DubProvider[],
    fullTrack: y.fullTrack,
    censored(startSec: number, durSec: number): boolean {
      const p = youtubeCaptions()?.peek();
      return !!p && censoredInRange(p.sentences, startSec, durSec);
    },
  };
}
