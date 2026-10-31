import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { startStudio } from './test-support.mjs';

test('慢 Whistle CLI 不阻塞状态读取或 Mock，失败后同步队列仍可继续', async (t) => {
  const { call, runtime, directory, port, tokenPath } = await startStudio(t, { syncFailure: true });
  await call('/api/projects', 'POST', { id: 'p', name: '异步同步' });
  await call('/api/projects/p/mocks', 'POST', { id: 'mock', name: 'mock', method: 'POST', match: { type: 'exact', value: 'http://test/async' }, response: { status: 200, delayMs: 0, headers: {}, body: { success: true } } });
  await call('/api/projects/p/mocks/mock', 'PATCH', { enabled: true });
  const cliPath = path.join(directory, 'missing-cli.mjs');
  const releasePath = path.join(directory, 'release');
  // 用文件握手控制慢 CLI；不依赖电脑速度猜测同步是否已经开始。
  await writeFile(cliPath, `
    import { existsSync, appendFileSync } from 'node:fs';
    appendFileSync(new URL('./started', import.meta.url), '1');
    while (!existsSync(new URL('./release', import.meta.url))) await new Promise(resolve => setTimeout(resolve, 10));
    console.error('isolated sync failure');
    process.exitCode = 1;
  `);
  let settled = false;
  let queued;
  const pending = call('/api/whistle/sync', 'POST').finally(() => { settled = true; });
  try {
    let started = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      try { await readFile(path.join(directory, 'started')); started = true; break; } catch { await new Promise((resolve) => setTimeout(resolve, 20)); }
    }
    assert.ok(started, 'CLI 应进入等待状态');
    queued = call('/api/whistle/sync', 'POST');
    const token = (await readFile(tokenPath, 'utf8')).trim();
    const state = await fetch(`http://127.0.0.1:${port}/api/state`, { headers: { 'x-mock-token': token }, signal: AbortSignal.timeout(1500) });
    assert.equal(state.status, 200);
    await state.json();
    const mock = await fetch(`http://127.0.0.1:${port}/runtime/dispatch`, { method: 'POST', headers: { 'x-mock-proxy-key': 'isolated-proxy-credential', 'x-mock-original-url': encodeURIComponent('http://test/async') }, signal: AbortSignal.timeout(1500) });
    assert.equal(mock.status, 200);
    assert.equal((await mock.json()).success, true);
    assert.equal(settled, false, 'Mock 应在 CLI 释放前完成');
    assert.equal(await readFile(path.join(directory, 'started'), 'utf8'), '1', '同一时刻只能执行一个同步 CLI');
  } finally {
    await writeFile(releasePath, '1');
    await pending;
    if (queued) await queued;
  }
  const failed = await pending;
  assert.equal(failed.data.ok, false);
  assert.match(failed.data.message, /isolated sync failure/);
  assert.equal((await call('/api/state')).data.runtime.whistle.ok, false);
  assert.equal((await queued).data.ok, false);
  assert.equal(await readFile(path.join(directory, 'started'), 'utf8'), '11');
  assert.equal((await runtime('http://test/async')).status, 200);
  // 已释放的 CLI 会立即失败，验证前一次失败没有卡住串行同步队列。
  const retry = await call('/api/whistle/sync', 'POST');
  assert.equal(retry.status, 200);
  assert.equal(retry.data.ok, false);
});

test('异步 CLI 成功后仍需回读并验证 Whistle 规则内容与启用状态', async (t) => {
  const { call, directory } = await startStudio(t, { syncFailure: true });
  // 先等待启动同步完成，再替换隔离 CLI 和客户端适配模块。
  await call('/api/whistle/sync', 'POST');
  const expected = '# Mock Studio: 当前没有启用的规则';
  let actual = { value: expected, selected: true };
  const proxy = http.createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ value: actual }));
  });
  await new Promise((resolve) => proxy.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => proxy.close(resolve)));
  await writeFile(path.join(directory, 'missing-cli.mjs'), "import { appendFileSync } from 'node:fs'; appendFileSync(new URL('./calls', import.meta.url), '1'); process.exitCode = 0;");
  await writeFile(path.join(directory, 'use.js'), `
    exports.getConfig = (_client, callback) => callback(null, { options: {} });
    exports.getReqOpts = () => ({ hostname: '127.0.0.1', port: ${proxy.address().port}, path: '/rules' });
  `);
  assert.equal((await call('/api/whistle/sync', 'POST')).data.ok, true);
  actual = { value: 'stale rules', selected: true };
  const stale = await call('/api/whistle/sync', 'POST');
  assert.equal(stale.data.ok, false);
  assert.match(stale.data.message, /验证 Whistle 失败/);
  actual = { value: expected, selected: false };
  assert.equal((await call('/api/whistle/sync', 'POST')).data.ok, false);
  actual = { value: expected, selected: true };
  assert.equal((await call('/api/whistle/sync', 'POST')).data.ok, true);
  assert.equal((await call('/api/state')).data.runtime.whistle.ok, true);
  const calls = await readFile(path.join(directory, 'calls'), 'utf8');
  await call('/api/projects', 'POST', { id: 'p', name: 'p' });
  const saved = await call('/api/projects/p/mocks', 'POST', { id: 'm', name: 'm', method: 'POST', match: { type: 'contains', value: 'query' } });
  assert.equal(saved.data.sync.skipped, true);
  assert.equal(await readFile(path.join(directory, 'calls'), 'utf8'), calls);
  await call('/api/projects/p/mocks/m', 'PATCH', { name: '改名' });
  assert.equal(await readFile(path.join(directory, 'calls'), 'utf8'), calls);
  assert.equal((await call('/api/whistle/sync', 'POST')).data.ok, true);
  assert.equal(await readFile(path.join(directory, 'calls'), 'utf8'), `${calls}1`, '手动同步必须绕过缓存');
});

test('健康回读修复外部规则改写，失败后不沿用成功缓存', async (t) => {
  const { call, directory } = await startStudio(t, { syncFailure: true });
  await call('/api/whistle/sync', 'POST');
  const appliedPath = path.join(directory, 'applied.json');
  const cliPath = path.join(directory, 'missing-cli.mjs');
  const cli = `
    import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
    import vm from 'node:vm';
    const context = { exports: {} };
    vm.runInNewContext(readFileSync(process.argv[3], 'utf8'), context);
    writeFileSync(new URL('./applied.json', import.meta.url), JSON.stringify({ value: context.exports.rules, selected: true }));
    appendFileSync(new URL('./calls', import.meta.url), '1');
  `;
  const proxy = http.createServer(async (_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ value: JSON.parse(await readFile(appliedPath, 'utf8')) }));
  });
  await new Promise((resolve) => proxy.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => proxy.close(resolve)));
  await writeFile(cliPath, cli);
  await writeFile(path.join(directory, 'use.js'), `
    exports.getConfig = (_client, callback) => callback(null, { options: {} });
    exports.getReqOpts = () => ({ hostname: '127.0.0.1', port: ${proxy.address().port}, path: '/rules' });
  `);
  const initial = await call('/api/whistle/sync', 'POST');
  assert.equal(initial.data.ok, true);
  assert.equal((await call('/api/whistle/check', 'POST')).data.skipped, true);
  assert.equal(await readFile(path.join(directory, 'calls'), 'utf8'), '1');
  await writeFile(appliedPath, JSON.stringify({ value: 'external change', selected: false }));
  const repaired = await call('/api/whistle/check', 'POST');
  assert.equal(repaired.data.ok, true);
  assert.equal(await readFile(path.join(directory, 'calls'), 'utf8'), '11');
  await writeFile(cliPath, "console.error('isolated failure'); process.exitCode = 1;");
  await writeFile(appliedPath, JSON.stringify({ value: 'external change', selected: false }));
  assert.equal((await call('/api/whistle/check', 'POST')).data.ok, false);
  const failedState = (await call('/api/state')).data.runtime.whistle;
  assert.equal(failedState.verified, false);
  assert.ok(failedState.lastSuccessAt);
  await writeFile(cliPath, cli);
  assert.equal((await call('/api/whistle/check', 'POST')).data.ok, true);
});
