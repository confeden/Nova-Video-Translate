import { afterEach, expect, it, vi } from 'vitest';
const fake = vi.hoisted(() => ({ drain: vi.fn(), log: vi.fn() }));
vi.mock('@nvt/core', () => ({ diag: { drainUnsent: fake.drain, log: fake.log } }));
vi.mock('../../../apps/extension/utils/version', () => ({ NVT_DEVLOG: true, NVT_VERSION: 'test' }));
vi.mock('wxt/browser', () => ({ browser: {} }));
import { startDevLog } from '../../../apps/extension/utils/devlog';

afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); });
it('retains a failed batch until acknowledgment and does not resend an acknowledged batch', async () => {
  vi.useFakeTimers();
  vi.stubGlobal('addEventListener', vi.fn());
  const event = { ev: 'model-error', t: 0 };
  fake.drain.mockReturnValueOnce([event]).mockReturnValue([]);
  const send = vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true);
  startDevLog('test', send);
  await vi.advanceTimersByTimeAsync(0);
  expect(send).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(3000);
  expect(send).toHaveBeenCalledTimes(2);
  expect(send.mock.calls[1]![0]).toEqual([event]);
  await vi.advanceTimersByTimeAsync(3000);
  expect(send).toHaveBeenCalledTimes(2);
});
