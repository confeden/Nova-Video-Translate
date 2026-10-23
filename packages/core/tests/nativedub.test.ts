import { beforeEach, describe, expect, it } from 'vitest';
import { diag } from '../src/diag';
import { TranslationEngine, type EngineState } from '../src/pipeline';
import {
  createAudioTracksBridgeClient,
  findRussianDub,
  installAudioTracksMain,
  isRussianTrack,
  readAudioTracks,
  selectAudioTrack,
  type AudioTracksController,
  type AudioTracksState,
} from '../src/nativedub';
import { normalizeSettings } from '../src/settings';
import { FakeCapture, FakeProvider, FakeScheduler, FakeVideo, flush, instantSleep, settings } from './helpers/pipelineFakes';

// ---------- fake page API ----------

interface FakeTrack {
  id: string;
  displayName?: string;
  audioIsDefault?: boolean;
}

function fakePlayer(tracks: FakeTrack[], current: string, opts: { throwSet?: boolean; noSet?: boolean; listThrows?: boolean; videoId?: string } = {}) {
  let cur = current;
  const objs = tracks.map((t) => ({ id: t.id, displayName: t.displayName, audioIsDefault: t.audioIsDefault, getLanguageInfo: () => ({ id: t.id, name: t.displayName }) }));
  const player: Record<string, unknown> = {
    getAvailableAudioTracks: () => {
      if (opts.listThrows) throw new Error('nope');
      return objs;
    },
    getAudioTrack: () => objs.find((o) => o.id === cur),
    getVideoData: () => ({ video_id: opts.videoId ?? 'vid' }),
    getPlayerResponse: () => ({
      videoDetails: { videoId: opts.videoId ?? 'vid' },
      streamingData: { adaptiveFormats: tracks.map((t) => ({ audioTrack: { id: t.id, displayName: t.displayName, audioIsDefault: !!t.audioIsDefault } })) },
    }),
  };
  if (!opts.noSet) {
    player.setAudioTrack = (t: { id: string }) => {
      if (opts.throwSet) throw new Error('set failed');
      cur = t.id;
    };
  }
  return { player, doc: { getElementById: (id: string) => (id === 'movie_player' ? player : null) }, setCurrent: (id: string) => (cur = id), get current() { return cur; } };
}

const EN_RU: FakeTrack[] = [
  { id: 'en.4', displayName: 'English (original)', audioIsDefault: true },
  { id: 'ru.10', displayName: 'Russian' },
  { id: 'de.10', displayName: 'German' },
];

describe('audio track reader (page API)', () => {
  it('lists tracks, marks original and Russian, reads the active one', () => {
    const f = fakePlayer(EN_RU, 'en.4');
    const st = readAudioTracks(f.doc, {})!;
    expect(st.tracks.map((t) => [t.id, t.ru, t.original])).toEqual([
      ['en.4', false, true],
      ['ru.10', true, false],
      ['de.10', false, false],
    ]);
    expect(st.currentId).toBe('en.4');
    expect(st.canSelect).toBe(true);
    expect(findRussianDub(st)?.id).toBe('ru.10');
  });

  it('detects Russian by id prefix or by display name (Russian / русский)', () => {
    expect(isRussianTrack('ru.10', undefined)).toBe(true);
    expect(isRussianTrack('ru-RU.2', undefined)).toBe(true);
    expect(isRussianTrack('fr.1', 'Russian')).toBe(true);
    expect(isRussianTrack('xx.1', 'русский')).toBe(true);
    expect(isRussianTrack('en.4', 'English')).toBe(false);
    expect(isRussianTrack('rum.1', undefined)).toBe(false);
  });

  it('a Russian original (default) track is not a dub; a single track is not a choice', () => {
    const orig = readAudioTracks(fakePlayer([{ id: 'ru.4', displayName: 'русский (оригинал)', audioIsDefault: true }, { id: 'en.10', displayName: 'English' }], 'ru.4').doc, {})!;
    expect(findRussianDub(orig)).toBeUndefined();
    const single = readAudioTracks(fakePlayer([{ id: 'ru.4', displayName: 'Russian' }], 'ru.4').doc, {})!;
    expect(findRussianDub(single)).toBeUndefined();
  });

  it('works from the player response alone and survives a throwing / missing API', () => {
    const f = fakePlayer(EN_RU, 'en.4', { listThrows: true });
    const st = readAudioTracks(f.doc, {})!;
    expect(st.tracks).toHaveLength(3);
    expect(st.canSelect).toBe(false);
    expect(readAudioTracks({ getElementById: () => null }, {})).toBeNull();
    expect(readAudioTracks({ getElementById: () => ({ getAvailableAudioTracks: () => { throw new Error('x'); }, getAudioTrack: () => { throw new Error('y'); } }) }, {})).toBeNull();
    expect(readAudioTracks({ getElementById: () => null }, { ytInitialPlayerResponse: { streamingData: { adaptiveFormats: [{ audioTrack: { id: 'ru.1', displayName: 'Russian' } }, { audioTrack: { id: 'en.1', displayName: 'English' } }] } } })?.tracks).toHaveLength(2);
  });

  it('ignores a lingering response of another video', () => {
    const f = fakePlayer(EN_RU, 'en.4');
    (f.player.getVideoData as () => unknown) = () => ({ video_id: 'other' });
    f.player.getAvailableAudioTracks = () => [];
    const st = readAudioTracks(f.doc, {});
    expect(st?.tracks ?? []).toHaveLength(0);
  });

  it('selectAudioTrack switches via setAudioTrack(track); false on throw / missing API / unknown id', () => {
    const f = fakePlayer(EN_RU, 'en.4');
    expect(selectAudioTrack(f.doc, 'ru.10')).toBe(true);
    expect(f.current).toBe('ru.10');
    expect(selectAudioTrack(f.doc, 'zz.1')).toBe(false);
    expect(selectAudioTrack(fakePlayer(EN_RU, 'en.4', { throwSet: true }).doc, 'ru.10')).toBe(false);
    expect(selectAudioTrack(fakePlayer(EN_RU, 'en.4', { noSet: true }).doc, 'ru.10')).toBe(false);
  });
});

// ---------- live YouTube track objects: language info under a minified key ----------

const b64 = (s: string): string => btoa(s).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
function liveTrack(lang: string, name: string, o: { isDefault?: boolean; auto?: boolean; kind?: 'original' | 'dubbed'; key?: string } = {}) {
  const id = `251;${b64(`

acont${o.kind ?? 'dubbed'}`)}${lang}`;
  return { id, [o.key ?? 'Nb']: { name, id: lang, isDefault: !!o.isDefault, isAutoDubbed: !!o.auto }, captionTracks: [{ languageCode: 'en' }], C: 1 };
}
function livePlayer(tracks: ReturnType<typeof liveTrack>[], current: ReturnType<typeof liveTrack>) {
  const player = {
    getAvailableAudioTracks: () => tracks,
    getAudioTrack: () => current,
    setAudioTrack: (t: unknown) => {
      current = t as typeof current;
    },
    getVideoData: () => ({ video_id: 'aircAruvnKk' }),
    getPlayerResponse: () => undefined,
  };
  return { player, doc: { getElementById: (i: string) => (i === 'movie_player' ? player : null) } };
}
const NINE = () => [
  liveTrack('en-US.4', 'Английский (US) (оригинальная)', { kind: 'original' }),
  liveTrack('ar.3', 'Арабский'),
  liveTrack('es.3', 'Испанский'),
  liveTrack('de.3', 'Немецкий'),
  liveTrack('ru.3', 'Русский', { isDefault: true }),
  liveTrack('th.3', 'Тайский'),
  liveTrack('uz.3', 'Узбекский'),
  liveTrack('fr.3', 'Французский'),
  liveTrack('hi.3', 'Хинди'),
];

describe('audio tracks: live objects with a minified language-info key', () => {
  it('9-track list: language ids and names, Russian dub found even though it is the viewer default; current matched to ru.3', () => {
    const t = NINE();
    const f = livePlayer(t, t[4]!);
    const st = readAudioTracks(f.doc, {})!;
    expect(st.tracks.map((x) => x.id)).toEqual(['en-US.4', 'ar.3', 'es.3', 'de.3', 'ru.3', 'th.3', 'uz.3', 'fr.3', 'hi.3']);
    expect(st.tracks[4]).toMatchObject({ id: 'ru.3', name: 'Русский', ru: true, original: false });
    expect(st.tracks[0]).toMatchObject({ original: true, ru: false });
    expect(st.currentId).toBe('ru.3');
    expect(st.canSelect).toBe(true);
    expect(findRussianDub(st)?.id).toBe('ru.3');
  });

  it('the key name does not matter (any own property shaped like language info); selecting by language id calls setAudioTrack with the live object', () => {
    const t = NINE().map((_, i, a) => a[i]!);
    const renamed = [liveTrack('en.4', 'English (original)', { kind: 'original', key: 'Zq' }), liveTrack('ru.10', 'Russian', { key: 'Zq' })];
    const f = livePlayer(renamed, renamed[0]!);
    const st = readAudioTracks(f.doc, {})!;
    expect(st.tracks.map((x) => [x.id, x.ru, x.original])).toEqual([['en.4', false, true], ['ru.10', true, false]]);
    expect(st.currentId).toBe('en.4');
    expect(selectAudioTrack(f.doc, 'ru.10')).toBe(true);
    expect(readAudioTracks(f.doc, {})!.currentId).toBe('ru.10');
    expect(t).toHaveLength(9);
  });

  it('an auto-dubbed Russian track is a dub; a Russian ORIGINAL track (named / encoded original) is not', () => {
    const dub = [liveTrack('en.4', 'English (original)', { kind: 'original' }), liveTrack('ru.3', 'Русский (авто)', { auto: true, isDefault: true })];
    expect(findRussianDub(readAudioTracks(livePlayer(dub, dub[0]!).doc, {}))?.id).toBe('ru.3');
    const orig = [liveTrack('ru.4', 'Русский (оригинальная)', { kind: 'original', isDefault: true }), liveTrack('en.3', 'Английский')];
    const st = readAudioTracks(livePlayer(orig, orig[0]!).doc, {})!;
    expect(st.tracks[0]).toMatchObject({ id: 'ru.4', original: true, ru: true });
    expect(findRussianDub(st)).toBeUndefined();
  });

  it('without any original marker the old default flag still marks the original', () => {
    const tr = [
      { id: 'a', Nb: { name: 'English', id: 'en.4', isDefault: true, isAutoDubbed: false } },
      { id: 'b', Nb: { name: 'Русский', id: 'ru.3', isDefault: false, isAutoDubbed: false } },
    ];
    const f = livePlayer(tr as never, tr[0] as never);
    const st = readAudioTracks(f.doc, {})!;
    expect(st.tracks.map((x) => [x.id, x.original])).toEqual([['en.4', true], ['ru.3', false]]);
  });
});

describe('audio track postMessage bridge', () => {
  it('round-trips list and select between an isolated client and a MAIN-world installer', async () => {
    const listeners = new Set<(e: MessageEvent) => void>();
    const win = {
      addEventListener: (_t: 'message', fn: (e: MessageEvent) => void) => listeners.add(fn),
      removeEventListener: (_t: 'message', fn: (e: MessageEvent) => void) => listeners.delete(fn),
      postMessage(msg: unknown) {
        for (const l of [...listeners]) queueMicrotask(() => l({ source: win, data: msg } as unknown as MessageEvent));
      },
    };
    const f = fakePlayer(EN_RU, 'en.4');
    const main = installAudioTracksMain({ win, doc: f.doc });
    const client = createAudioTracksBridgeClient(win);
    const st = await client.list(200);
    expect(st?.tracks.map((t) => t.id)).toEqual(['en.4', 'ru.10', 'de.10']);
    expect(await client.select('ru.10', 200)).toBe(true);
    expect(f.current).toBe('ru.10');
    client.dispose?.();
    main.dispose();
  });

  it('list resolves null and select false when nothing answers', async () => {
    const win = { addEventListener() {}, removeEventListener() {}, postMessage() {} };
    const c = createAudioTracksBridgeClient(win);
    expect(await c.list(10)).toBeNull();
    expect(await c.select('ru.10', 10)).toBe(false);
  });
});

describe('settings', () => {
  it('preferNativeDub defaults to true and is repaired', () => {
    expect(normalizeSettings({}).preferNativeDub).toBe(true);
    expect(normalizeSettings({ preferNativeDub: false }).preferNativeDub).toBe(false);
    expect(normalizeSettings({ preferNativeDub: 'x' }).preferNativeDub).toBe(true);
  });
});

// ---------- engine ----------

class FakeTracks implements AudioTracksController {
  listCalls = 0;
  selected: string[] = [];
  constructor(public state: AudioTracksState | null, public selectResult: boolean | Error = true, public applySelect = true) {}
  async list(): Promise<AudioTracksState | null> {
    this.listCalls++;
    return this.state && { ...this.state };
  }
  async select(id: string): Promise<boolean> {
    this.selected.push(id);
    if (this.selectResult instanceof Error) throw this.selectResult;
    if (this.selectResult && this.applySelect && this.state) this.state.currentId = id;
    return this.selectResult;
  }
}

const state = (currentId: string, tracks = EN_RU): AudioTracksState => ({
  tracks: tracks.map((t) => ({ id: t.id, name: t.displayName, original: !!t.audioIsDefault, ru: isRussianTrack(t.id, t.displayName) })),
  currentId,
  canSelect: true,
});

function setup(tracks: FakeTracks | undefined, over: { prefer?: boolean; key?: string; lang?: string } = {}) {
  const video = new FakeVideo() as FakeVideo & { duration?: number };
  video.duration = 600;
  const providers = [new FakeProvider('yandex-live'), new FakeProvider('yandex'), new FakeProvider('gemini')];
  const caps: FakeCapture[] = [];
  const states: EngineState[] = [];
  const polls: Array<() => void> = [];
  const engine = new TranslationEngine({
    video: video as unknown as HTMLVideoElement,
    audioCtx: {} as AudioContext,
    providers,
    settings: settings({ preferNativeDub: over.prefer ?? true }),
    events: { onState: (s) => states.push(s) },
    createCapture: (async () => {
      const c = new FakeCapture();
      caps.push(c);
      return c;
    }) as never,
    createScheduler: ((_v: unknown, _c: unknown, o: any) => new FakeScheduler(o)) as never,
    now: () => 0,
    sleep: instantSleep(),
    hintSleep: () => new Promise(() => {}),
    retryDelayMs: 10,
    videoKey: () => over.key ?? 'yt:aircAruvnKk',
    audioTracks: tracks,
    detectLanguage: async () => ({ lang: over.lang ?? 'en', confidence: 0.95, how: 'test', signals: [] }) as never,
    // each poll waits until the test releases it
    nativePoll: () => new Promise<void>((res) => polls.push(res)),
  });
  const tick = async (): Promise<void> => {
    const p = polls.splice(0);
    p.forEach((r) => r());
    await flush();
    await flush();
  };
  return { engine, providers, caps, states, tick, video };
}

const evs = (name: string) => diag.entries().filter((e) => e.ev === name);

describe('engine: native Russian dub', () => {
  beforeEach(() => diag.clear());

  it('switches to the Russian track, enters native-dub and starts no providers, capture or ducking', async () => {
    const t = new FakeTracks(state('en.4'));
    const e = setup(t);
    await e.engine.start();
    await flush();
    expect(t.selected).toEqual(['ru.10']);
    expect(e.engine.state).toBe('native-dub');
    expect(e.caps).toHaveLength(0);
    expect(e.providers.every((p) => p.calls.length === 0)).toBe(true);
    expect(evs('native-dub-probe')[0]!.data).toMatchObject({ tracks: ['en.4', 'ru.10', 'de.10'], hasRu: true });
    expect(evs('native-dub-switch')[0]!.data).toMatchObject({ ok: true, from: 'en.4', to: 'ru.10' });
    expect(evs('engine-start')).toHaveLength(0);
    e.engine.stop();
    expect(e.engine.state).toBe('stopped');
  });

  it('already on the Russian track: native-dub without switching', async () => {
    const t = new FakeTracks(state('ru.10'));
    const e = setup(t);
    await e.engine.start();
    expect(t.selected).toEqual([]);
    expect(e.engine.state).toBe('native-dub');
    expect(evs('native-dub-switch')).toHaveLength(0);
    e.engine.stop();
  });

  it('no Russian track: normal translation', async () => {
    const t = new FakeTracks(state('en.4', EN_RU.filter((x) => x.id !== 'ru.10')));
    const e = setup(t);
    await e.engine.start();
    await flush();
    expect(e.engine.state).not.toBe('native-dub');
    expect(evs('native-dub-probe')[0]!.data).toMatchObject({ hasRu: false });
    expect(e.caps).toHaveLength(1);
    e.engine.stop();
  });

  it('setAudioTrack throws or is refused: native-dub-miss and normal translation', async () => {
    for (const res of [new Error('boom'), false] as const) {
      diag.clear();
      const e = setup(new FakeTracks(state('en.4'), res));
      await e.engine.start();
      await flush();
      expect(e.engine.state).not.toBe('native-dub');
      expect(e.caps).toHaveLength(1);
      expect(evs('native-dub-miss').map((x) => x.data?.reason)).toContain('set-failed');
      e.engine.stop();
    }
  });

  it('track list cannot be read: native-dub-miss and normal translation', async () => {
    const e = setup(new FakeTracks(null));
    await e.engine.start();
    await flush();
    expect(e.caps).toHaveLength(1);
    expect(evs('native-dub-miss')[0]!.data).toMatchObject({ reason: 'no-tracks' });
    e.engine.stop();
  });

  it('setting off: the feature is not even probed', async () => {
    const t = new FakeTracks(state('en.4'));
    const e = setup(t, { prefer: false });
    await e.engine.start();
    await flush();
    expect(t.listCalls).toBe(0);
    expect(e.caps).toHaveLength(1);
    e.engine.stop();
  });

  it('not YouTube: not probed', async () => {
    const t = new FakeTracks(state('en.4'));
    const e = setup(t, { key: 'u:https://vimeo.com/1' });
    await e.engine.start();
    await flush();
    expect(t.listCalls).toBe(0);
    e.engine.stop();
  });

  it('the language gate still wins: a Russian-spoken video is skipped as before', async () => {
    const t = new FakeTracks(state('en.4'));
    const e = setup(t, { lang: 'ru' });
    await e.engine.start();
    await flush();
    expect(e.engine.state).toBe('skipped-ru');
    expect(t.listCalls).toBe(0);
    expect(t.selected).toEqual([]);
  });

  it('the user switches back to another track: the normal translation starts, nobody fights the user', async () => {
    const t = new FakeTracks(state('en.4'));
    const e = setup(t);
    await e.engine.start();
    await e.tick(); // still Russian
    expect(e.engine.state).toBe('native-dub');
    t.state!.currentId = 'de.10';
    await e.tick();
    await flush();
    expect(e.engine.state).not.toBe('native-dub');
    expect(e.caps).toHaveLength(1);
    expect(t.selected).toEqual(['ru.10']); // never re-selected
    expect(evs('native-dub-left')).toHaveLength(1);
    e.engine.stop();
  });

  it('the media reload after our own switch (readyState < 2) does not count: watcher stays, then the user leaving Russian still fires native-dub-left', async () => {
    const t = new FakeTracks(state('en.4'));
    const e = setup(t);
    await e.engine.start();
    expect(evs('native-dub-switch')[0]?.data).toMatchObject({ ok: true });
    const v = e.video as unknown as { readyState: number };
    v.readyState = 0; // reloading: player reports a transient track
    t.state!.currentId = 'en.4';
    await e.tick();
    await e.tick();
    await flush();
    expect(e.engine.state).toBe('native-dub');
    expect(evs('native-dub-left')).toHaveLength(0);
    v.readyState = 4;
    t.state!.currentId = 'ru.10';
    await e.tick();
    expect(e.engine.state).toBe('native-dub');
    t.state!.currentId = 'de.10';
    await e.tick();
    await flush();
    expect(evs('native-dub-left')).toHaveLength(1);
    expect(e.engine.state).not.toBe('native-dub');
    e.engine.stop();
  });

  it('a slow player: not-yet-applied switch is tolerated for two polls, then translation starts', async () => {
    const t = new FakeTracks(state('en.4'), true, false); // select ok, but the player keeps reporting en.4
    const e = setup(t);
    await e.engine.start();
    await e.tick();
    await e.tick();
    expect(e.engine.state).toBe('native-dub');
    await e.tick();
    await flush();
    expect(e.engine.state).not.toBe('native-dub');
    expect(evs('native-dub-miss').map((x) => x.data?.reason)).toContain('switch-not-applied');
    e.engine.stop();
  });

  it('stop() ends the watcher', async () => {
    const t = new FakeTracks(state('en.4'));
    const e = setup(t);
    await e.engine.start();
    e.engine.stop();
    const n = t.listCalls;
    t.state!.currentId = 'de.10';
    await e.tick();
    expect(t.listCalls).toBe(n);
    expect(e.caps).toHaveLength(0);
  });
});
