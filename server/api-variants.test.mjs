import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn, spawnSync } from 'node:child_process';

/** 为每个测试服务申请临时端口 */
const reservePort = () => new Promise((resolve, reject) => {
  // 临时服务仅负责让操作系统选择端口。
  const socket = net.createServer();
  socket.once('error', reject);
  socket.listen(0, '127.0.0.1', () => {
    // 关闭占位监听器后启动隔离管理服务。
    const port = socket.address().port;
    socket.close(() => resolve(port));
  });
});

/** 启动与现有注册表、代理规则和令牌完全隔离的服务 */
const createHarness = async (t) => {
  // 所有测试文件都在专属临时目录。
  const dir = await mkdtemp(path.join(tmpdir(), 'mock-studio-variants-'));
  // 测试服务专用的监听端口。
  const port = await reservePort();
  // 隔离服务的本地令牌文件。
  const tokenPath = path.join(dir, 'token');
  // 隔离服务的注册表文件。
  const registryPath = path.join(dir, 'registry.json');
  await writeFile(registryPath, JSON.stringify({ version: 1, settings: { apiPort: port }, runtime: {}, projects: [] }));
  // 测试启动的独立后台进程。
  const child = spawn(process.execPath, ['server/index.mjs'], { cwd: process.cwd(), env: { ...process.env, MOCK_STUDIO_REGISTRY: registryPath, MOCK_STUDIO_TOKEN_PATH: tokenPath, MOCK_STUDIO_NO_WHISTLE: '1' }, stdio: 'ignore' });
  t.after(async () => { if (child.exitCode === null) { child.kill('SIGTERM'); await new Promise((resolve) => child.once('exit', resolve)); } await rm(dir, { recursive: true, force: true }); });
  // 启动期间等待令牌生成和监听端口就绪。
  let token;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try { token = (await readFile(tokenPath, 'utf8')).trim(); await fetch(`http://127.0.0.1:${port}/api/token`, { headers: { origin: 'http://127.0.0.1:3000' } }); break; } catch { await new Promise((resolve) => setTimeout(resolve, 30)); }
  }
  assert.ok(token);
  // 模拟页面与 CLI 向本机管理接口发起调用。
  const api = async (route, method = 'GET', data) => {
    // 响应包含状态码与 JSON，用于分别断言结果和错误码。
    const response = await fetch(`http://127.0.0.1:${port}${route}`, { method, headers: { 'content-type': 'application/json', 'x-mock-token': token }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
    return { status: response.status, data: await response.json() };
  };
  // 在隔离服务上执行 CLI，保留退出码与结构化输出。
  const cli = (...args) => spawnSync(process.execPath, ['bin/mockctl.mjs', ...args, '--json'], { cwd: process.cwd(), env: { ...process.env, MOCK_STUDIO_API: `http://127.0.0.1:${port}`, MOCK_STUDIO_TOKEN_PATH: tokenPath }, encoding: 'utf8', timeout: 5000 });
  return { api, cli, dir };
};

test('场景编辑、排序和删除保持有效引用', async (t) => {
  // 在隔离项目中准备固定命名场景，避免改变用户现有配置。
  const { api } = await createHarness(t);
  assert.equal((await api('/api/projects', 'POST', { id: 'p', name: '测试' })).status, 201);
  // 新建接口后的服务端结果。
  const created = await api('/api/projects/p/endpoints', 'POST', { id: 'query', name: '查询', method: 'POST', url: 'http://example.test/query' });
  // 首次响应或创建的默认场景编号。
  const first = created.data.variants[0].id;
  assert.equal(created.data.enabled, false);
  await api('/api/endpoints/query/variants', 'POST', { id: 'second', name: '第二个', body: { step: 2 } });
  await api('/api/endpoints/query/variants', 'POST', { id: 'third', name: '第三个', body: { step: 3 } });
  assert.equal((await api('/api/endpoints/query', 'PATCH', { activeVariantId: 'second', mode: 'sequence', sequence: { currentIndex: 1, afterEnd: 'loop' } })).status, 200);
  // 按指定顺序调整后的接口。
  const reordered = await api('/api/endpoints/query/variants/reorder', 'POST', { ids: ['third', first, 'second'] });
  assert.equal(reordered.data.variants[reordered.data.sequence.currentIndex].id, 'second');
  // 复制场景后的接口配置。
  const cloned = await api('/api/endpoints/query/variants/second/clone', 'POST');
  assert.equal(cloned.data.variants.at(-1).body.step, 2);
  // 删除场景后的接口配置。
  const deleted = await api('/api/endpoints/query/variants/second', 'DELETE');
  assert.equal(deleted.status, 200);
  assert.equal(deleted.data.activeVariantId, 'third');
  assert.ok(deleted.data.sequence.currentIndex < deleted.data.variants.length);
  assert.equal((await api('/api/endpoints/query/variants/missing', 'DELETE')).data.code, 'VARIANT_NOT_FOUND');
  // 删除失败后继续读取，验证串行写入队列没有卡住。
  assert.equal((await api('/api/state')).status, 200);
});

test('场景包预览无副作用，恢复旧项目并阻止配置冲突', async (t) => {
  // 同一项目替换前后的接口使用不同配置，便于检验精确恢复。
  const { api } = await createHarness(t);
  await api('/api/projects', 'POST', { id: 'p', name: '原项目' });
  // 用于验证导入和恢复的场景包。
  const pack = { version: 1, name: '新项目', endpoints: [{ id: 'query', name: '查询', method: 'GET', url: 'http://example.test/query', variants: [{ id: 'v1', name: '首个', body: { n: 1 } }] }] };
  assert.equal((await api('/api/packages/preview', 'POST', { projectId: 'p', package: pack, mode: 'replace' })).status, 200);
  assert.equal((await api('/api/state')).data.projects[0].name, '原项目');
  // 应用场景包产生的结果与快照。
  const imported = await api('/api/packages/apply', 'POST', { projectId: 'p', package: pack, mode: 'replace' });
  assert.equal(imported.status, 200);
  assert.equal((await api('/api/packages/restore', 'POST', { snapshotId: imported.data.snapshotId })).status, 200);
  assert.equal((await api('/api/state')).data.projects[0].name, '原项目');
  // 输入不合法时的样本或执行结果。
  const invalid = structuredClone(pack);
  invalid.endpoints[0].variants[0].body = undefined;
  assert.equal((await api('/api/packages/apply', 'POST', { projectId: 'p', package: invalid, mode: 'replace' })).status, 400);
  assert.equal((await api('/api/state')).data.projects[0].name, '原项目');
});

test('CLI 为错误参数、无效 JSON 和缺失资源返回非零与结构化错误', async (t) => {
  // CLI 访问隔离服务，错误不会触及用户配置。
  const { cli, dir } = await createHarness(t);
  // 未知状态或命令的测试样本。
  const unknown = cli('unknown', 'x');
  assert.equal(unknown.status, 1);
  assert.equal(JSON.parse(unknown.stderr).error.code, 'UNKNOWN_COMMAND');
  // 缺少必要配置的测试样本。
  const missing = cli('enable', 'missing');
  assert.equal(missing.status, 1);
  assert.equal(JSON.parse(missing.stderr).ok, false);
  // 用于测试 JSON 格式错误的临时文件。
  const file = path.join(dir, 'bad.json');
  await writeFile(file, '{invalid');
  // 输入不合法时的样本或执行结果。
  const invalid = cli('package-preview', file, 'p');
  assert.equal(invalid.status, 1);
  assert.equal(JSON.parse(invalid.stderr).error.code, 'INVALID_JSON');
});
