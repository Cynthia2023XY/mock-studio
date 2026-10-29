import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn, spawnSync } from 'node:child_process';

/** 为隔离服务申请一个暂时可用的端口 */
const reservePort = () => new Promise((resolve, reject) => {
  // 临时监听器仅用于获取操作系统分配的端口。
  const socket = net.createServer();
  socket.once('error', reject);
  socket.listen(0, '127.0.0.1', () => {
    // 关闭临时监听器后由测试服务接管端口。
    const port = socket.address().port;
    socket.close(() => resolve(port));
  });
});

/** 验证场景、场景包、隔离权限及跨接口事务 */
test('管理 API 与跨接口 Mock 流程', async (t) => {
  // 测试数据和令牌使用临时目录，绝不修改用户配置或 Whistle 规则。
  const directory = await mkdtemp(path.join(tmpdir(), 'mock-studio-test-'));
  // 隔离测试服务监听端口。
  const port = await reservePort();
  // 隔离测试使用的注册表路径。
  const registryPath = path.join(directory, 'registry.json');
  // 本机管理令牌文件路径。
  const tokenPath = path.join(directory, 'token');
  await writeFile(registryPath, JSON.stringify({ version: 1, settings: { apiPort: port }, runtime: {}, projects: [] }));
  // 隔离测试启动的服务进程。
  const child = spawn(process.execPath, ['server/index.mjs'], { cwd: process.cwd(), env: { ...process.env, MOCK_STUDIO_REGISTRY: registryPath, MOCK_STUDIO_TOKEN_PATH: tokenPath, MOCK_STUDIO_NO_WHISTLE: '1' }, stdio: 'ignore' });
  t.after(async () => { child.kill('SIGTERM'); await new Promise((resolve) => child.once('exit', resolve)); await rm(directory, { recursive: true, force: true }); });
  // 等待隔离管理服务启动并读取专用令牌。
  let token;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try { token = (await readFile(tokenPath, 'utf8')).trim(); await fetch(`http://127.0.0.1:${port}/api/token`, { headers: { origin: 'http://127.0.0.1:3000' } }); break; } catch { await new Promise((resolve) => setTimeout(resolve, 30)); }
  }
  assert.ok(token);
  // 所有测试请求通过同一个受保护的管理接口。
  const call = async (route, method = 'GET', data, authenticated = true) => {
    // 本次 HTTP 请求返回的响应。
    const response = await fetch(`http://127.0.0.1:${port}${route}`, { method, headers: { 'content-type': 'application/json', ...(authenticated ? { 'x-mock-token': token } : {}) }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
    return { status: response.status, data: await response.json() };
  };
  assert.equal((await call('/api/state', 'GET', undefined, false)).status, 401);
  // 外部来源访问管理接口的验证结果。
  const denied = await fetch(`http://127.0.0.1:${port}/api/state`, { headers: { origin: 'https://untrusted.example', 'x-mock-token': token } });
  assert.equal(denied.status, 403);
  // 首页查询按项目流程状态返回不同响应，领取成功推动状态。
  const pack = { version: 1, name: '隔离流程', endpoints: [
    { id: 'query', name: '查询', method: 'POST', url: 'http://example.test/query', mode: 'state', stateVariants: { before: 'v1', after: 'v2' }, variants: [{ id: 'v1', name: '领取前', body: { phase: 'before' } }, { id: 'v2', name: '领取后', body: { phase: 'after' } }] },
    { id: 'receive', name: '领取', method: 'POST', url: 'http://example.test/receive', variants: [{ id: 'success', name: '成功', body: { success: true } }] },
  ], flow: { states: ['before', 'after'], initialState: 'before', transitions: [{ from: 'before', to: 'after', endpointId: 'receive', variantId: 'success' }] } };
  assert.equal((await call('/api/packages/preview', 'POST', { projectId: 'p', package: pack })).status, 200);
  assert.equal((await call('/api/state')).data.projects.length, 0);
  // 场景包应用及快照结果。
  const applied = await call('/api/packages/apply', 'POST', { projectId: 'p', package: pack });
  assert.equal(applied.status, 200);
  assert.equal(applied.data.project.enabled, false);
  assert.equal((await call('/api/projects/p', 'PATCH', { enabled: true })).status, 200);
  // 导入同一场景包的新项目会重映射编号，且不能同时启用重复代理规则。
  const copy = await call('/api/packages/apply', 'POST', { projectId: 'copy', package: pack });
  assert.equal(copy.status, 200);
  assert.ok(copy.data.remappedIds.query);
  assert.equal((await call('/api/projects/copy', 'PATCH', { enabled: true })).data.code, 'RULE_CONFLICT');
  assert.equal((await call('/api/packages/restore', 'POST', { snapshotId: copy.data.snapshotId })).status, 200);
  // 用于验证实际 Mock 返回的请求函数。
  const runtime = async (id) => { const response = await fetch(`http://127.0.0.1:${port}/runtime/respond/${id}`, { method: 'POST' }); return { data: await response.json(), hit: response.headers.get('x-mock-hit-id') }; };
  assert.equal((await runtime('query')).data.phase, 'before');
  await Promise.all([runtime('receive'), runtime('receive')]);
  // 流程迁移后的查询响应。
  const after = await runtime('query');
  assert.equal(after.data.phase, 'after');
  assert.ok(after.hit);
  // 按筛选条件整理的命中记录。
  const hits = await call('/api/hits?projectId=p');
  assert.equal(hits.data.hits.length, 4);
  assert.equal(hits.data.hits[0].id, after.hit);
  assert.equal((await call('/api/projects/p/reset', 'POST')).status, 200);
  assert.equal((await runtime('query')).data.phase, 'before');
  // 删除被流程引用的场景失败后，写入队列仍应可以正常工作。
  assert.equal((await call('/api/endpoints/query/variants/v1', 'DELETE')).data.code, 'VARIANT_IN_USE');
  assert.equal((await call('/api/endpoints/receive/variants', 'POST', { name: '失败', body: { success: false } })).status, 200);
  // 一批场景含非法项时，所有场景均不得写入。
  const beforeBatch = (await call('/api/state')).data.projects[0].endpoints.find((item) => item.id === 'receive').variants.length;
  assert.equal((await call('/api/endpoints/receive/variants/batch', 'POST', { variants: [{ name: '有效', body: {} }, { name: '', body: {} }] })).status, 400);
  assert.equal((await call('/api/state')).data.projects[0].endpoints.find((item) => item.id === 'receive').variants.length, beforeBatch);
  // 场景排序必须完整且唯一；失败后不能修改已有顺序。
  assert.equal((await call('/api/endpoints/receive/variants/reorder', 'POST', { ids: ['success', 'success'] })).data.code, 'INVALID_ORDER');
  assert.equal((await call('/api/packages/restore', 'POST', { snapshotId: applied.data.snapshotId })).data.code, 'RESTORE_CONFLICT');
  // 输入不合法不会损坏既有注册表。
  assert.equal((await call('/api/endpoints/receive', 'PATCH', { mode: 'invalid' })).data.code, 'INVALID_MODE');
  assert.equal((await call('/api/state')).data.projects.length, 1);
  // CLI 使用隔离令牌导出项目，并通过机器可读输出报告结果。
  const exportPath = path.join(directory, 'export.json');
  // 以独立令牌执行真实 CLI，验证导出和 JSON 输出。
  const cli = spawnSync(process.execPath, ['bin/mockctl.mjs', 'package-export', 'p', exportPath, '--json'], { cwd: process.cwd(), env: { ...process.env, MOCK_STUDIO_API: `http://127.0.0.1:${port}`, MOCK_STUDIO_TOKEN_PATH: tokenPath }, encoding: 'utf8', timeout: 5000 });
  assert.equal(cli.status, 0, cli.stderr);
  assert.equal(JSON.parse(cli.stdout).ok, true);
  assert.equal(JSON.parse(await readFile(exportPath, 'utf8')).endpoints.length, 2);
});
