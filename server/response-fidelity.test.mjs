import test from 'node:test';
import assert from 'node:assert/strict';
import { startStudio } from './test-support.mjs';

test('新旧 Mock 原样返回错误响应 JSON，管理和分发错误仍有稳定错误码', async (t) => {
  const { call, runtime } = await startStudio(t);
  await call('/api/projects', 'POST', { id: 'p', name: '响应保真' });
  await call('/api/projects/p/mocks', 'POST', { id: 'mock', name: 'mock', method: 'POST', match: { type: 'exact', value: 'http://test/fidelity' } });
  await call('/api/projects/p/mocks/mock', 'PATCH', { enabled: true });
  const legacy = (await call('/api/projects/p/endpoints', 'POST', { id: 'legacy', name: 'legacy', method: 'POST', url: 'http://test/legacy' })).data;
  await call('/api/endpoints/legacy', 'PATCH', { enabled: true });

  // 错误状态不意味着可以修改业务 JSON，数组、空值及已有 code 也需保留。
  const cases = [
    [200, { message: 'ok' }],
    [400, { message: 'invalid' }],
    [500, [{ message: 'failed' }, 1]],
    [422, { code: null, message: 'invalid' }],
    [403, { code: '', message: 'denied' }],
    [401, { code: 'BUSINESS_DENIED' }],
    [404, null],
    [503, 'unavailable'],
    [400, false],
    [500, 0],
  ];
  for (const [status, body] of cases) {
    const response = { status, delayMs: 0, headers: {}, body };
    assert.equal((await call('/api/projects/p/mocks/mock', 'PATCH', { response })).status, 200);
    assert.equal((await call(`/api/endpoints/legacy/variants/${legacy.activeVariantId}`, 'PUT', response)).status, 200);
    // 兼容直连接口和统一分发器都必须遵守相同响应契约。
    for (const result of [await runtime('http://test/fidelity'), await runtime('http://test/legacy'), await call('/runtime/respond/legacy', 'POST')]) {
      assert.equal(result.status, status);
      assert.deepEqual(result.data, body);
      assert.equal(result.headers.get('x-mock-source'), 'mock-studio');
      assert.ok(result.headers.get('x-mock-hit-id'));
    }
  }
  assert.equal((await call('/api/projects/p/mocks/mock', 'PATCH', { response: { status: 204, delayMs: 0, headers: {}, body: {} } })).data.code, 'INVALID_STATUS');
  assert.equal((await runtime('http://test/fidelity', 'POST', 'forged')).data.code, 'PROXY_UNAUTHORIZED');
  assert.equal((await call('/api/missing')).data.code, 'HTTP_404');
});
