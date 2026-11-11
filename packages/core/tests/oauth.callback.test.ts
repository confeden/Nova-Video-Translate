import { afterEach, expect, it, vi } from 'vitest';
import { oauthCallback } from '../../../apps/userscript/src/oauth';
import { OAUTH_PENDING_KEY } from '../../../apps/userscript/src/storage';
import type { Transport } from '../src/index';

afterEach(() => vi.unstubAllGlobals());
it('a callback with another state leaves the current PKCE attempt intact', async () => {
  const pending = { verifier: 'test-verifier', state: 'current-state', at: Date.now() };
  const values = new Map<string, unknown>([[OAUTH_PENDING_KEY, pending]]);
  vi.stubGlobal('GM_getValue', (k: string) => values.get(k));
  vi.stubGlobal('GM_setValue', (k: string, v: unknown) => values.set(k, v));
  const loc = { search: '?code=test-code&state=old-state', hash: '' } as Location;
  expect(await oauthCallback({} as Transport, loc)).toBe(false);
  expect(values.get(OAUTH_PENDING_KEY)).toBe(pending);
});
