import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { startStudio } from './test-support.mjs';

/** 为 API 测试生成默认关闭的独立 Mock 输入 */
const input = (id, value = 'query', body = { id }) => ({ id, name: id, method: 'POST', match: { type: 'contains', value }, response: { status: 200, delayMs: 0, headers: {}, body } });

/** 为不同样本构造允许重复引用的组合配置 */
const combination = (id, ids) => ({ id, name: id, steps: ids.map((mockId, index) => ({ id: `s${index}`, mockId })), afterEnd: 'hold-last' });

test('新模型 CRUD、串行组合运行、关闭恢复开关及引用保护', async (t) => {
  // 全程在独立临时服务中运行。
  const { call, runtime, port } = await startStudio(t);
  await call('/api/projects', 'POST', { id: 'p', name: 'p' });
  // 浏览器控制台与 API 端口不同，真实预检必须先于资源路由处理。
  const preflight = await fetch(`http://127.0.0.1:${port}/api/projects/p/mocks`, { method: 'OPTIONS', headers: { origin: 'http://127.0.0.1:3000', 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type,x-mock-token' } });
  assert.equal(preflight.status, 204);
  assert.match(preflight.headers.get('access-control-allow-methods'), /POST/);
  assert.equal((await call('/api/projects/p/mocks', 'POST', null)).data.code, 'INVALID_BODY');
  for (const id of ['one', 'two', 'three']) assert.equal((await call('/api/projects/p/mocks', 'POST', { ...input(id), enabled: true })).data.enabled, false);
  await call('/api/projects/p/combinations', 'POST', combination('c', ['one', 'two', 'three']));
  assert.equal((await call('/api/projects/p/combinations/c', 'PATCH', { enabled: true })).status, 200);
  // 并发请求每个只使用一次当前位置。
  const responses = await Promise.all([runtime('http://test/query'), runtime('http://test/query'), runtime('http://test/query')]);
  assert.deepEqual(responses.map((item) => item.data.id).sort((left, right) => left.localeCompare(right)), ['one', 'three', 'two']);
  // 同样步骤的保存或改名不会悄悄重置正在共享的进度。
  await call('/api/projects/p/combinations/c', 'PATCH', { ...combination('c', ['one', 'two', 'three']), name: '已改名组合' });
  assert.equal((await call('/api/state')).data.projects[0].combinations[0].currentIndex, 2);
  assert.equal((await call('/api/projects/p/mocks/two', 'DELETE')).data.code, 'MOCK_IN_USE');
  await call('/api/projects/p/mocks/one', 'PATCH', { enabled: true });
  await call('/api/projects/p/combinations/c', 'PATCH', { enabled: false });
  assert.equal((await runtime('http://test/query')).data.id, 'one');
  assert.equal((await call('/api/state')).data.projects[0].mocks[1].enabled, false);
  // 普通同 URL 规则按列表顺序匹配。
  await call('/api/projects/p/mocks/two', 'PATCH', { enabled: true });
  await call('/api/projects/p/mocks/reorder', 'POST', { ids: ['two', 'one', 'three'] });
  assert.equal((await runtime('http://test/query')).data.id, 'two');
  await call('/api/projects/p/combinations', 'POST', combination('other', ['one']));
  await call('/api/projects/p/combinations/c', 'PATCH', { enabled: true });
  assert.equal((await call('/api/projects/p/combinations/other', 'PATCH', { enabled: true })).data.code, 'COMBINATION_CONFLICT');
  // 修改被引用响应后下一次组合请求实时使用新内容。
  await call('/api/projects/p/mocks/one', 'PATCH', { response: { status: 201, delayMs: 0, headers: {}, body: { changed: true } } });
  assert.equal((await runtime('http://test/query')).data.changed, true);
  await call('/api/projects/p/combinations/c/reset', 'POST');
  assert.equal((await runtime('http://test/query')).status, 201);
  // 非法排序、重复编号、无效引用原子拒绝。
  assert.equal((await call('/api/projects/p/mocks/reorder', 'POST', { ids: ['one'] })).data.code, 'INVALID_ORDER');
  assert.equal((await call('/api/projects/p/mocks', 'POST', input('one'))).data.code, 'DUPLICATE_ID');
  assert.equal((await call('/api/projects/p/combinations', 'POST', combination('broken', ['missing']))).data.code, 'INVALID_REFERENCE');
  assert.equal((await call('/api/state')).data.projects[0].combinations.length, 2);
  assert.equal((await runtime('http://test/query', 'POST', 'forged')).data.code, 'PROXY_UNAUTHORIZED');
});

test('顺序错误不推进，跨项目重叠拒绝，包导入引用映射及新 CLI', async (t) => {
  // 包与 CLI 共享真实受保护管理路由。
  const { call, runtime, cli, directory } = await startStudio(t);
  await call('/api/projects', 'POST', { id: 'p', name: 'p' });
  await call('/api/projects/p/mocks', 'POST', input('query'));
  await call('/api/projects/p/mocks', 'POST', input('receive', 'receive'));
  await call('/api/projects/p/combinations', 'POST', combination('c', ['query', 'receive', 'query']));
  await call('/api/projects/p/combinations/c', 'PATCH', { enabled: true });
  // 组合中的其他步骤请求不能回退到单条规则。
  const error = await runtime('http://test/receive');
  assert.equal(error.status, 409);
  assert.equal(error.headers.get('x-mock-source'), null);
  assert.equal(error.data.expected.index, 0);
  assert.equal((await call('/api/state')).data.projects[0].combinations[0].currentIndex, 0);
  // v2 场景包包含全部规则与引用，导入后默认停用。
  const pack = (await call('/api/projects/p/export')).data;
  assert.equal(pack.version, 2);
  const imported = await call('/api/packages/apply', 'POST', { projectId: 'copy', package: pack });
  assert.ok(imported.data.remappedIds.query);
  assert.equal(imported.data.project.combinations[0].steps[0].mockId, imported.data.remappedIds.query);
  assert.equal(imported.data.project.mocks[0].enabled, false);
  assert.equal(imported.data.project.combinations[0].enabled, false);
  await call('/api/projects/copy', 'PATCH', { enabled: true });
  assert.equal((await call('/api/projects/copy/combinations/c', 'PATCH', { enabled: true })).data.code, 'RULE_CONFLICT');
  // CLI 不需要迁移旧命令即可使用新规则和组合。
  assert.equal(cli('combination-reset', 'p', 'c').status, 0);
  assert.equal(cli('mock-clone', 'p', 'query').status, 0);
  assert.equal(cli('mock-enable', 'p', 'missing').status, 1);
  const file = `${directory}/mock.json`;
  await writeFile(file, JSON.stringify(input('from-cli', 'other')));
  assert.equal(cli('mock-add', 'p', file).status, 0);
  assert.equal((await call('/api/state')).data.schemaVersion, 2);
});

test('迁移先预览、备份原文、保留进度且重复应用不生成副本，旧状态流程保留', async (t) => {
  // 含旧版数据的隔离注册表。
  const { call, registryPath, cli } = await startStudio(t);
  await call('/api/projects', 'POST', { id: 'p', name: 'p' });
  await call('/api/projects/p/endpoints', 'POST', { id: 'old', name: 'old', method: 'POST', url: 'http://test/query' });
  await call('/api/endpoints/old/variants', 'POST', { id: 'after', name: 'after', body: { after: true } });
  await call('/api/endpoints/old', 'PATCH', { mode: 'sequence', enabled: true, sequence: { currentIndex: 1, afterEnd: 'loop' } });
  // 预览不落盘，进度、引用、开关均明确列出。
  const before = await readFile(registryPath, 'utf8');
  const preview = await call('/api/projects/p/migration/preview', 'POST');
  assert.equal(await readFile(registryPath, 'utf8'), before);
  assert.equal(preview.data.project.combinations[0].currentIndex, 1);
  const migrated = await call('/api/projects/p/migration/apply', 'POST', { fingerprint: preview.data.fingerprint });
  assert.equal(migrated.status, 200);
  assert.equal(await readFile(migrated.data.backupPath, 'utf8'), before);
  assert.equal((await call('/api/state')).data.projects[0].endpoints.length, 0);
  assert.equal(JSON.parse(cli('enable', 'old').stderr).error.code, 'MIGRATED_ENDPOINT');
  const again = await call('/api/projects/p/migration/preview', 'POST');
  assert.equal((await call('/api/projects/p/migration/apply', 'POST', { fingerprint: again.data.fingerprint })).data.unchanged, true);
  assert.equal((await call('/api/state')).data.projects[0].mocks.length, 2);
  // 状态流程不能机械转为严格顺序模型。
  await call('/api/projects', 'POST', { id: 'legacy', name: 'legacy' });
  await call('/api/projects/legacy/endpoints', 'POST', { id: 'state-query', name: 'state', url: 'http://test/state' });
  await call('/api/projects/legacy/flow', 'PUT', { flow: { states: ['before'], initialState: 'before', currentState: 'before', transitions: [] } });
  assert.equal((await call('/api/projects/legacy/migration/preview', 'POST')).data.retainedLegacy, true);
});

test('配置成功但 Whistle 失败时返回独立同步失败，错误输入不覆盖已有数据', async (t) => {
  // 使用不存在的 CLI 和临时生成目录，绝不操作桌面代理。
  const { call } = await startStudio(t, { syncFailure: true });
  await call('/api/projects', 'POST', { id: 'p', name: 'p' });
  const saved = await call('/api/projects/p/mocks', 'POST', input('saved'));
  assert.equal(saved.status, 200);
  assert.equal(saved.data.sync.ok, false);
  assert.match(saved.data.sync.message, /失败/);
  assert.equal((await call('/api/state')).data.projects[0].mocks.length, 1);
  assert.equal((await call('/api/projects/p/mocks/saved', 'PATCH', { response: { status: 204, delayMs: 0, headers: {}, body: {} } })).data.code, 'INVALID_STATUS');
  assert.equal((await call('/api/projects/p/mocks/saved', 'PATCH', { name: 12 })).data.code, 'INVALID_MOCK');
  assert.equal((await call('/api/state')).data.projects[0].mocks[0].response.status, 200);
});
