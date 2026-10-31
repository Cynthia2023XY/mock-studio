import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { startStudio } from './test-support.mjs';

const input = (id, delayMs = 0) => ({ id, name: id, method: 'POST', match: { type: 'contains', value: id }, response: { status: 200, delayMs, headers: {}, body: { id } } });

test('新旧响应和导入统一拒绝无法发送的头，合法头规范化且失败不落盘', async (t) => {
  const { call, registryPath, runtime } = await startStudio(t);
  await call('/api/projects', 'POST', { id: 'p', name: 'p' });
  await call('/api/projects/p/mocks', 'POST', input('mock'));
  const endpoint = (await call('/api/projects/p/endpoints', 'POST', { id: 'old', name: 'old', url: 'http://test/old' })).data;
  const before = await readFile(registryPath, 'utf8');
  for (const headers of [{ 'x-label': '中文' }, { 'x-label': 'a\0b' }, { 'bad name': 'x' }, { 'X-Test': 'a', 'x-test': 'b' }, { 'Content-Length': '999' }, { 'X-MOCK-source': 'fake' }]) {
    const response = { ...input('mock').response, headers };
    assert.equal((await call('/api/projects/p/mocks/mock', 'PATCH', { response })).data.code, 'INVALID_HEADERS');
    assert.equal((await call(`/api/endpoints/old/variants/${endpoint.activeVariantId}`, 'PUT', { headers })).data.code, 'INVALID_HEADERS');
    const pack = { version: 2, mocks: [{ ...input('copy'), response }] };
    assert.equal((await call('/api/packages/apply', 'POST', { projectId: 'import', package: pack })).data.code, 'INVALID_HEADERS');
    assert.equal(await readFile(registryPath, 'utf8'), before);
  }
  await call('/api/projects/p/mocks/mock', 'PATCH', { enabled: true, response: { ...input('mock').response, headers: { 'X-Test': 'caf\u00e9', 'Access-Control-Expose-Headers': 'x-test' } } });
  const hit = await runtime('http://test/mock');
  assert.equal(hit.status, 200);
  assert.equal(hit.headers.get('x-test'), 'caf\u00e9');
  assert.match(hit.headers.get('access-control-expose-headers'), /x-test/);
});

test('配置版本拦截过期编辑，命中与组合进度不改变版本', async (t) => {
  const { call, runtime } = await startStudio(t);
  await call('/api/projects', 'POST', { id: 'p', name: 'p' });
  await call('/api/projects/p/mocks', 'POST', input('mock'));
  await call('/api/projects/p/mocks/mock', 'PATCH', { enabled: true });
  const version = (await call('/api/state')).data.projects[0].revision;
  await runtime('http://test/mock');
  assert.equal((await call('/api/state')).data.projects[0].revision, version);
  const headers = { 'if-match': `"${version}"` };
  const results = await Promise.all(['first', 'second'].map((name) => call('/api/projects/p/mocks/mock', 'PATCH', { name }, headers)));
  assert.deepEqual(results.map((result) => result.status).sort((left, right) => left - right), [200, 409]);
  assert.equal(results.find((result) => result.status === 409).data.code, 'CONFIG_CONFLICT');
  // 旧接口和项目设置也需要在事务内执行版本检查。
  const endpoint = (await call('/api/projects/p/endpoints', 'POST', { id: 'old', name: 'old', url: 'http://test/old' })).data;
  assert.equal((await call(`/api/endpoints/old/variants/${endpoint.activeVariantId}`, 'PUT', { body: {} }, headers)).status, 409);
  assert.equal((await call('/api/projects/p', 'PATCH', { enabled: false }, headers)).status, 409);
});

test('跨域自动预检和拒绝不推进组合，409 使用相同策略，显式 OPTIONS 优先', async (t) => {
  const { call, port, registryPath } = await startStudio(t);
  await call('/api/projects', 'POST', { id: 'p', name: 'p' });
  for (const id of ['query', 'receive']) await call('/api/projects/p/mocks', 'POST', input(id));
  await call('/api/projects/p/combinations', 'POST', { id: 'c', name: 'c', steps: [{ id: 's1', mockId: 'query' }, { id: 's2', mockId: 'receive' }] });
  await call('/api/projects/p/combinations/c', 'PATCH', { enabled: true });
  const cors = { mode: 'allow-list', origins: ['https://page.test'], credentials: true, headers: ['content-type', 'authorization'] };
  assert.equal((await call('/api/projects/p', 'PATCH', { cors })).status, 200);
  const invoke = async (url, method, headers = {}) => {
    const response = await fetch(`http://127.0.0.1:${port}/runtime/dispatch`, { method, headers: { 'x-mock-proxy-key': 'isolated-proxy-credential', 'x-mock-original-url': encodeURIComponent(url), origin: 'https://page.test', ...headers } });
    const text = await response.text();
    return { status: response.status, headers: response.headers, data: text ? JSON.parse(text) : null };
  };
  const before = await readFile(registryPath, 'utf8');
  const preflight = await invoke('http://test/query', 'OPTIONS', { 'access-control-request-method': 'POST', 'access-control-request-headers': 'Content-Type, Authorization' });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-origin'), 'https://page.test');
  assert.equal(preflight.headers.get('access-control-allow-credentials'), 'true');
  assert.match(preflight.headers.get('vary'), /Origin/);
  assert.equal(preflight.headers.get('access-control-max-age'), '0');
  assert.equal((await invoke('http://test/query', 'OPTIONS', { 'access-control-request-method': 'POST', 'access-control-request-headers': 'x-secret' })).status, 403);
  assert.equal((await invoke('http://test/query', 'OPTIONS', { 'access-control-request-method': 'DELETE' })).status, 403);
  const denied = await invoke('http://test/query', 'POST', { origin: 'https://denied.test' });
  assert.equal(denied.status, 403);
  assert.equal(denied.headers.get('access-control-allow-origin'), null);
  assert.equal(await readFile(registryPath, 'utf8'), before);
  const mismatch = await invoke('http://test/receive', 'POST');
  assert.equal(mismatch.status, 409);
  assert.equal(mismatch.headers.get('access-control-allow-origin'), 'https://page.test');
  assert.equal(mismatch.headers.get('access-control-allow-credentials'), 'true');
  await call('/api/projects/p/mocks', 'POST', { ...input('explicit'), method: 'OPTIONS', match: { type: 'contains', value: 'query' } });
  await call('/api/projects/p/mocks/explicit', 'PATCH', { enabled: true });
  const explicit = await invoke('http://test/query', 'OPTIONS', { 'access-control-request-method': 'POST' });
  assert.equal(explicit.status, 200);
  assert.equal(explicit.data.id, 'explicit');
  assert.equal((await call('/api/state')).data.projects[0].combinations[0].currentIndex, 0);
  const pack = (await call('/api/projects/p/export')).data;
  assert.deepEqual(pack.cors, cors);
  assert.deepEqual((await call('/api/packages/preview', 'POST', { projectId: 'copy', package: pack })).data.project.cors, cors);
});

test('发送完成、失败和客户端断开分别记录，失败不回滚已匹配进度', async (t) => {
  const { call, runtime, port, registryPath } = await startStudio(t);
  await call('/api/projects', 'POST', { id: 'p', name: 'p' });
  await call('/api/projects/p/mocks', 'POST', input('slow', 200));
  await call('/api/projects/p/mocks/slow', 'PATCH', { enabled: true });
  await call('/api/projects/p/combinations', 'POST', { id: 'c', name: 'c', steps: [0, 1, 2].map((index) => ({ id: `step-${index}`, mockId: 'slow' })) });
  await call('/api/projects/p/combinations/c', 'PATCH', { enabled: true });
  const finished = await runtime('http://test/slow');
  const waitHit = async (predicate) => {
    for (let attempt = 0; attempt < 100; attempt++) {
      const state = (await call('/api/state')).data;
      const hit = state.hits.find(predicate);
      if (hit) return hit;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.fail('等待发送状态超时');
  };
  await waitHit((hit) => hit.id === finished.headers.get('x-mock-hit-id') && hit.delivery === 'finished');
  const controller = new AbortController();
  const pending = fetch(`http://127.0.0.1:${port}/runtime/dispatch`, { method: 'POST', signal: controller.signal, headers: { 'x-mock-proxy-key': 'isolated-proxy-credential', 'x-mock-original-url': encodeURIComponent('http://test/slow') } }).catch(() => null);
  await waitHit((hit) => hit.delivery === 'selected');
  controller.abort();
  await pending;
  await waitHit((hit) => hit.delivery === 'aborted');
  const state = (await call('/api/state')).data;
  assert.equal(state.projects[0].mocks[0].stats.hits, 2);
  assert.equal(state.projects[0].combinations[0].currentIndex, 2);
  // 模拟旧文件中已有的非法头，运行时仍应将发送失败与匹配记录区分。
  state.projects[0].mocks[0].response.headers = { 'x-invalid': '中文' };
  await writeFile(registryPath, JSON.stringify(state));
  assert.equal((await runtime('http://test/slow')).status, 500);
  await waitHit((hit) => hit.delivery === 'failed');
  const afterFailure = (await call('/api/state')).data.projects[0];
  assert.equal(afterFailure.mocks[0].stats.hits, 3);
  assert.equal(afterFailure.combinations[0].currentIndex, 2);
});
