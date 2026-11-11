import { afterEach, expect, it } from 'vitest';
import { diag } from '../src/diag';

afterEach(() => diag.clear());
it('redacts nested credentials and URL queries before truncating or forwarding', () => {
  diag.log('test', { nested: { authorization: 'fake-secret', apiKey: 'fake-key', safe: 'ok' }, message: `https://example.com/${'x'.repeat(250)}?key=fake-query-secret`, pool: [{ token: 'fake-token' }] });
  const report = diag.report();
  expect(report).not.toMatch(/fake-secret|fake-key|fake-query-secret|fake-token/);
  expect(report).toContain('ok');
  expect(report).toContain('[hidden]');
});
