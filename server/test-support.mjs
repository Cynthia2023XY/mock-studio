import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn, spawnSync } from 'node:child_process';

/** 向系统申请隔离服务端口 */
export const freePort = () => new Promise((resolve) => {
  // 临时监听器只用于系统分配端口。
  const server = net.createServer();
  server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)); });
});

/** 测试与浏览器验收共用的临时注册表服务，不访问真实用户数据 */
export const startStudio = async (t, options = {}) => {
  // 每次测试使用独立目录与令牌。
  const directory = await mkdtemp(path.join(tmpdir(), 'mock-studio-v2-'));
  // 服务监听端口。
  const port = await freePort();
  // 注册表初始路径。
  const registryPath = path.join(directory, 'registry.json');
  // 测试专用管理令牌。
  const tokenPath = path.join(directory, 'token');
  await writeFile(registryPath, JSON.stringify({ version: 1, settings: { apiPort: port }, runtime: {}, projects: [] }));
  // 所有外部连接和生成物都在隔离路径中。
  const env = { ...process.env, MOCK_STUDIO_REGISTRY: registryPath, MOCK_STUDIO_TOKEN_PATH: tokenPath, MOCK_STUDIO_NO_WHISTLE: options.syncFailure ? '0' : '1', MOCK_STUDIO_WHISTLE_CLI: path.join(directory, 'missing-cli.mjs'), MOCK_STUDIO_GENERATED_DIRECTORY: directory, MOCK_STUDIO_PROXY_KEY: 'isolated-proxy-credential' };
  // 启动真实 API 代码，而非内存替身。
  const child = spawn(process.execPath, ['server/index.mjs'], { env, stdio: ['ignore', 'ignore', 'pipe'] });
  // 启动诊断只留在测试内，不包含用户凭据。
  let output = '';
  child.stderr.on('data', (chunk) => { output += chunk; });
  // 统一回收隔离进程和临时配置。
  const cleanup = async () => { if (child.exitCode === null) { child.kill(); await new Promise((resolve) => child.once('exit', resolve)); } await rm(directory, { recursive: true, force: true }); };
  t?.after(cleanup);
  // 等待服务监听就绪。
  let token;
  for (let attempt = 0; attempt < 100; attempt++) {
    try { token = (await readFile(tokenPath, 'utf8')).trim(); await fetch(`http://127.0.0.1:${port}/api/state`); break; } catch { await new Promise((resolve) => setTimeout(resolve, 30)); }
  }
  assert.ok(token, output);
  // 测试管理 API 与运行 API 共享结构化结果。
  const call = async (route, method = 'GET', body, headers = {}) => {
    const response = await fetch(`http://127.0.0.1:${port}${route}`, { method, headers: { 'content-type': 'application/json', 'x-mock-token': token, ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, headers: response.headers, data: await response.json() };
  };
  // 模拟经过受信代理的完整请求。
  const runtime = (url, method = 'POST', key = env.MOCK_STUDIO_PROXY_KEY) => call('/runtime/dispatch', method, undefined, { 'x-mock-proxy-key': key, 'x-mock-original-url': encodeURIComponent(url) });
  // 执行旧新 CLI，检验可读错误与非零退出。
  const cli = (...args) => spawnSync(process.execPath, ['bin/mockctl.mjs', ...args, '--json'], { env: { ...env, MOCK_STUDIO_API: `http://127.0.0.1:${port}` }, encoding: 'utf8', timeout: 5000 });
  return { port, directory, registryPath, tokenPath, call, runtime, cli, cleanup };
};

/** 启动独立 Whistle 并提供规则写入接口，供代理与浏览器验收共用 */
export const startProxy = async (t, directory) => {
  // 代理监听端口独立于 API 与用户桌面代理。
  const port = await freePort();
  // 仅测试进程加载桌面应用内置库，数据目录完全隔离。
  const source = `require('/Applications/Whistle.app/Contents/Resources/app/node_modules/whistle')({port:${port},host:'127.0.0.1',baseDir:${JSON.stringify(directory)},storage:'isolated-v2',noGlobalPlugins:true},()=>console.log('READY'))`;
  // 代理进程输出只用于启动诊断。
  const child = spawn(process.execPath, ['-e', source], { stdio: ['ignore', 'pipe', 'pipe'] });
  // 等待隔离代理监听完成。
  await new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error(`Whistle 启动超时 ${output}`)), 10000);
    child.stdout.on('data', (chunk) => { output += chunk; if (output.includes('READY')) { clearTimeout(timer); resolve(); } });
    child.stderr.on('data', (chunk) => { output += chunk; });
    child.once('exit', () => { clearTimeout(timer); reject(new Error(output)); });
  });
  // 规则测试结束后统一回收。
  const cleanup = async () => { if (child.exitCode === null) { child.kill(); await new Promise((resolve) => child.once('exit', resolve)); } };
  t?.after(cleanup);
  // 提交编译结果到隔离规则组。
  const setRules = async (rules) => {
    const response = await fetch(`http://127.0.0.1:${port}/cgi-bin/rules/project`, { method: 'POST', body: new URLSearchParams({ name: 'mock-studio-managed', rules: rules || '# no active rules' }) });
    assert.equal((await response.json()).ec, 0);
  };
  return { port, setRules, cleanup };
};
