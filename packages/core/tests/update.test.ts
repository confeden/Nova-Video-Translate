import { describe, expect, it } from 'vitest';
import {
  UPDATE_CHECK_INTERVAL_MS,
  UPDATE_RETRY_INTERVAL_MS,
  applyCheckOutcome,
  checkForUpdate,
  checkResultFromState,
  compareVersions,
  isCheckDue,
  isNewerVersion,
  isReleasePageUrl,
  normalizeVersion,
  parseLatestRelease,
  parseVersion,
  updateFromState,
  type JsonFetch,
  type UpdateState,
} from '../src/update';

const PAGE = 'https://github.com/confeden/Nova-Video-Translate/releases/tag/v0.3.0';
const H = 3600_000;

describe('update: semver', () => {
  it('compares newer / older / equal', () => {
    expect(compareVersions('0.3.0', '0.2.27')).toBe(1);
    expect(compareVersions('0.2.27', '0.3.0')).toBe(-1);
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0);
    expect(isNewerVersion('0.2.28', '0.2.27')).toBe(true);
    expect(isNewerVersion('0.2.27', '0.2.27')).toBe(false);
    expect(isNewerVersion('0.2.9', '0.2.10')).toBe(false);
    expect(isNewerVersion('1.0.0', '0.99.99')).toBe(true);
  });
  it('strips a leading v', () => {
    expect(parseVersion('v0.2.28')).toEqual([0, 2, 28]);
    expect(normalizeVersion('v1.2.3')).toBe('1.2.3');
    expect(isNewerVersion('v0.3.0', '0.2.27')).toBe(true);
  });
  it('rejects garbage and pre-release suffixes instead of throwing', () => {
    const bad: unknown[] = ['', 'x', '1.2', '1.2.3.4', '1.2.x', 'v', '0.3.0-beta.1', '0.3.0+build', ' ', '01.2.3', 42, null, undefined, {}];
    for (const b of bad) {
      expect(parseVersion(b)).toBeNull();
      expect(isNewerVersion(b, '0.2.27')).toBe(false);
      expect(isNewerVersion('0.3.0', b)).toBe(false);
    }
    expect(compareVersions('garbage', '0.1.0')).toBeNull();
  });
});

describe('update: release parsing', () => {
  it('reads a normal release', () => {
    expect(parseLatestRelease({ tag_name: 'v0.3.0', html_url: PAGE, draft: false, prerelease: false })).toEqual({
      kind: 'release',
      release: { version: '0.3.0', url: PAGE },
    });
  });
  it('skips drafts and pre-releases', () => {
    expect(parseLatestRelease({ tag_name: 'v0.3.0', html_url: PAGE, draft: true }).kind).toBe('skip');
    expect(parseLatestRelease({ tag_name: 'v0.3.0', html_url: PAGE, prerelease: true }).kind).toBe('skip');
  });
  it('treats garbage bodies as invalid', () => {
    expect(parseLatestRelease(null).kind).toBe('invalid');
    expect(parseLatestRelease('html error page').kind).toBe('invalid');
    expect(parseLatestRelease({ message: 'Not Found' }).kind).toBe('invalid');
    expect(parseLatestRelease({ tag_name: 'nightly', html_url: PAGE }).kind).toBe('invalid');
    expect(parseLatestRelease({ tag_name: 'v0.3.0', html_url: 'https://evil.example/x' }).kind).toBe('invalid');
    expect(parseLatestRelease({ tag_name: 'v0.3.0' }).kind).toBe('invalid');
  });
  it('accepts only this repository pages', () => {
    expect(isReleasePageUrl(PAGE)).toBe(true);
    expect(isReleasePageUrl('https://github.com/confeden/Nova-Video-Translate-fork/releases')).toBe(false);
    expect(isReleasePageUrl('http://github.com/confeden/Nova-Video-Translate/releases')).toBe(false);
    expect(isReleasePageUrl('https://github.com/confeden/Nova-Video-Translate/releases/x y')).toBe(false);
    expect(isReleasePageUrl(undefined)).toBe(false);
  });
});

describe('update: due check', () => {
  const now = 1_000_000_000_000;
  it('is due when nothing was checked or the clock went backwards', () => {
    expect(isCheckDue(undefined, now)).toBe(true);
    expect(isCheckDue({ checkedAt: NaN }, now)).toBe(true);
    expect(isCheckDue({ checkedAt: now + H }, now)).toBe(true);
  });
  it('waits 8 h after a successful check', () => {
    const st: UpdateState = { checkedAt: now };
    expect(isCheckDue(st, now + UPDATE_CHECK_INTERVAL_MS - 1)).toBe(false);
    expect(isCheckDue(st, now + UPDATE_CHECK_INTERVAL_MS)).toBe(true);
    expect(UPDATE_CHECK_INTERVAL_MS).toBe(8 * H);
  });
  it('retries no sooner than 1 h after a failure', () => {
    const st: UpdateState = { checkedAt: now, failed: true };
    expect(isCheckDue(st, now + H - 1)).toBe(false);
    expect(isCheckDue(st, now + UPDATE_RETRY_INTERVAL_MS)).toBe(true);
    expect(UPDATE_RETRY_INTERVAL_MS).toBe(H);
  });
});

describe('update: state transitions', () => {
  const now = 5_000;
  it('stores a newer release', () => {
    expect(applyCheckOutcome(undefined, { kind: 'answer', release: { version: '0.3.0', url: PAGE } }, '0.2.27', now)).toEqual({
      checkedAt: now,
      version: '0.3.0',
      url: PAGE,
    });
  });
  it('an equal or older release stores no update (and drops a stale one)', () => {
    const prev: UpdateState = { checkedAt: 1, version: '0.3.0', url: PAGE };
    expect(applyCheckOutcome(prev, { kind: 'answer', release: { version: '0.2.27', url: PAGE } }, '0.2.27', now)).toEqual({ checkedAt: now });
    expect(applyCheckOutcome(prev, { kind: 'answer', release: null }, '0.3.0', now)).toEqual({ checkedAt: now });
  });
  it('a failure keeps a still-valid previous update and marks the check failed', () => {
    const prev: UpdateState = { checkedAt: 1, version: '0.3.0', url: PAGE };
    expect(applyCheckOutcome(prev, { kind: 'failed' }, '0.2.27', now)).toEqual({ checkedAt: now, failed: true, version: '0.3.0', url: PAGE });
    // the user already runs 0.3.0: the old notice is no longer valid
    expect(applyCheckOutcome(prev, { kind: 'failed' }, '0.3.0', now)).toEqual({ checkedAt: now, failed: true });
  });
  it('updateFromState ignores foreign URLs and non-newer versions', () => {
    expect(updateFromState({ checkedAt: 1, version: '0.3.0', url: 'https://evil.example/' }, '0.2.27')).toBeNull();
    expect(updateFromState({ checkedAt: 1, version: '0.2.27', url: PAGE }, '0.2.27')).toBeNull();
    expect(updateFromState({ checkedAt: 1, version: '0.3.0', url: PAGE }, '0.2.27')).toEqual({ version: '0.3.0', url: PAGE });
    expect(checkResultFromState({ checkedAt: 1, failed: true }, '0.2.27')).toEqual({ update: null, failed: true });
  });
});

describe('update: checkForUpdate (fake transport)', () => {
  const now = 9_000;
  const fake =
    (status: number, body: unknown, seen?: Array<{ url: string; headers: Record<string, string> }>): JsonFetch =>
    async (url, headers) => {
      seen?.push({ url, headers });
      return { status, body };
    };

  it('sends one GET to /releases/latest with the Accept header only', async () => {
    const seen: Array<{ url: string; headers: Record<string, string> }> = [];
    await checkForUpdate({ fetchJson: fake(200, { tag_name: 'v0.3.0', html_url: PAGE }, seen), current: '0.2.27', now });
    expect(seen).toEqual([
      { url: 'https://api.github.com/repos/confeden/Nova-Video-Translate/releases/latest', headers: { Accept: 'application/vnd.github+json' } },
    ]);
  });
  it('newer release is stored', async () => {
    expect(await checkForUpdate({ fetchJson: fake(200, { tag_name: 'v0.3.0', html_url: PAGE }), current: '0.2.27', now })).toEqual({
      checkedAt: now,
      version: '0.3.0',
      url: PAGE,
    });
  });
  it('404, rate limit and server errors are silent failures that keep the previous update', async () => {
    const prev: UpdateState = { checkedAt: 1, version: '0.3.0', url: PAGE };
    for (const status of [404, 403, 429, 500]) {
      expect(await checkForUpdate({ fetchJson: fake(status, { message: 'x' }), current: '0.2.27', prev, now })).toEqual({
        checkedAt: now,
        failed: true,
        version: '0.3.0',
        url: PAGE,
      });
    }
  });
  it('a network error never throws and counts as a failure', async () => {
    const boom: JsonFetch = async () => {
      throw new TypeError('Failed to fetch');
    };
    expect(await checkForUpdate({ fetchJson: boom, current: '0.2.27', now })).toEqual({ checkedAt: now, failed: true });
  });
  it('an invalid 200 body counts as a failure', async () => {
    expect(await checkForUpdate({ fetchJson: fake(200, 'nope'), current: '0.2.27', now })).toEqual({ checkedAt: now, failed: true });
  });
  it('a pre-release answer is a successful check with no update', async () => {
    expect(await checkForUpdate({ fetchJson: fake(200, { tag_name: 'v0.9.0', html_url: PAGE, prerelease: true }), current: '0.2.27', now })).toEqual({
      checkedAt: now,
    });
  });
});
