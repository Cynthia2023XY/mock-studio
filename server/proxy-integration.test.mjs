import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { compileWhistleRules, renderWhistleConfig } from './whistle.mjs';
import vm from 'node:vm';

/** 本机 Whistle 安装路径；不修改桌面客户端配置 */
const whistleEntry = '/Applications/Whistle.app/Contents/Resources/app/node_modules/whistle';

/** 在随机端口启动仅供本次测试使用的 HTTP 服务器 */
const listenLocal = (handler) => new Promise((resolve, reject) => {
  // 服务器模拟原始接口或本地 Mock 服务。
  const server = http.createServer(handler);
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => resolve(server));
});

/** 获取系统分配的临时代理端口 */
const freePort = () => new Promise((resolve, reject) => {
  // 短暂监听后由独立 Whistle 进程接管。
  const server = net.createServer();
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => {
    // 记录临时分配的端口。
    const port = server.address().port;
    server.close(() => resolve(port));
  });
});

/** 通过独立代理发起完整 URL 的 HTTP 请求 */
const requestProxy = (port, url, body = '', options = {}) => new Promise((resolve, reject) => {
  // 请求发送到隔离代理，绝不使用系统代理设置。
  const request = http.request({ host: '127.0.0.1', port, path: url, method: options.method || 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'content-length': Buffer.byteLength(body), connection: 'close', ...options.headers } }, (response) => {
    // 收集代理最终返回的正文与状态。
    const chunks = [];
    response.on('data', (chunk) => chunks.push(chunk));
    response.on('error', reject);
    response.on('end', () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString(), headers: response.headers }));
  });
  request.setTimeout(5000, () => request.destroy(new Error('代理请求超时')));
  request.on('error', reject);
  request.end(body);
});

/** 在独立 Whistle 上验证启用、覆盖空规则及关闭后的真实透传 */
test('独立 Whistle：启用时命中，关闭时透传原接口', { skip: !existsSync(whistleEntry), timeout: 25000 }, async (t) => {
  // 每个实例使用临时目录，不修改用户桌面 Whistle 的规则。
  const directory = await mkdtemp(path.join(tmpdir(), 'mock-studio-whistle-'));
  // 模拟真实接口的独立 HTTP 服务。
  const origin = await listenLocal((request, response) => { if (request.url === '/page' || request.url === '/csp') { response.writeHead(200, { 'content-type': 'text/html', ...(request.url === '/csp' ? { 'content-security-policy': "script-src 'self'" } : {}) }); response.end('<html><body>page</body></html>'); return; } response.writeHead(200, { 'x-test-source': 'origin' }); response.end('origin'); });
  // 模拟 Mock 响应的独立 HTTP 服务。
  const mock = await listenLocal((_request, response) => { response.writeHead(200, { 'x-test-source': 'mock' }); response.end('mock'); });
  // 测试专用 Whistle 的本地端口。
  const proxyPort = await freePort();
  // 通过独立子进程加载 Whistle，指定临时数据目录与随机端口。
  const source = `const whistle = require(${JSON.stringify(whistleEntry)}); whistle({ port: ${proxyPort}, host: '127.0.0.1', baseDir: ${JSON.stringify(directory)}, storage: 'isolated-test', noGlobalPlugins: true }, () => console.log('READY'));`;
  // 测试启动的独立后台进程。
  const child = spawn(process.execPath, ['-e', source], { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(async () => {
    if (child.exitCode === null) { child.kill('SIGTERM'); await new Promise((resolve) => child.once('exit', resolve)); }
    await Promise.all([new Promise((resolve) => origin.close(resolve)), new Promise((resolve) => mock.close(resolve))]);
    await rm(directory, { recursive: true, force: true });
  });
  // 等待独立代理启动，失败时返回子进程诊断。
  await new Promise((resolve, reject) => {
    // 独立代理启动时的诊断输出。
    let output = '';
    // 限制独立代理启动等待时间的定时器。
    const timer = setTimeout(() => reject(new Error(`Whistle 启动超时：${output}`)), 15000);
    child.stderr.on('data', (chunk) => { output += chunk; });
    child.stdout.on('data', (chunk) => { output += chunk; if (output.includes('READY')) { clearTimeout(timer); resolve(); } });
    child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`Whistle 提前退出 ${code}：${output}`)); });
  });
  // 使用真实的规则编译结果和 Whistle 项目规则管理端点。
  const originalUrl = `http://127.0.0.1:${origin.address().port}/api/query`;
  // 用于编译代理规则的最小注册表。
  const registry = { settings: { apiPort: mock.address().port }, projects: [{ enabled: true, endpoints: [{ id: 'query', enabled: true, method: 'POST', url: originalUrl }] }] };
  // 将编译后的规则提交给隔离代理。
  const writeRules = async () => {
    // 读取项目生成的 Whistle 配置正文。
    const sandbox = { exports: {} };
    vm.runInNewContext(renderWhistleConfig(compileWhistleRules(registry)), sandbox);
    // Whistle 的管理接口以非空规则覆盖同名项目。
    const form = new URLSearchParams({ name: sandbox.exports.name, rules: sandbox.exports.rules }).toString();
    // 服务或浏览器返回的响应。
    const response = await requestProxy(proxyPort, `http://127.0.0.1:${proxyPort}/cgi-bin/rules/project`, form);
    assert.equal(response.status, 200);
    assert.equal(JSON.parse(response.body).ec, 0);
  };
  await writeRules();
  // 实际文档请求被注入提示脚本，普通请求不受影响。
  const pageUrl = `http://127.0.0.1:${origin.address().port}/page`;
  const page = await requestProxy(proxyPort, pageUrl, '', { method: 'GET', headers: { 'sec-fetch-dest': 'document' } });
  assert.match(page.body, /__mockStudioNoticeInstalled/);
  // Whistle 默认注入可能删除 CSP，托管规则必须明确保留原策略。
  const protectedPage = await requestProxy(proxyPort, pageUrl.replace('/page', '/csp'), '', { method: 'GET', headers: { 'sec-fetch-dest': 'document' } });
  assert.equal(protectedPage.headers['content-security-policy'], "script-src 'self'");
  const plainPage = await requestProxy(proxyPort, pageUrl, '', { method: 'GET' });
  assert.doesNotMatch(plainPage.body, /__mockStudioNoticeInstalled/);
  // 开启规则后经过代理的响应。
  const intercepted = await requestProxy(proxyPort, originalUrl);
  assert.equal(intercepted.headers['x-test-source'], 'mock');
  assert.equal(intercepted.body, 'mock');
  registry.projects[0].endpoints[0].enabled = false;
  await writeRules();
  // 关闭规则后回源的响应。
  const forwarded = await requestProxy(proxyPort, originalUrl);
  assert.equal(forwarded.headers['x-test-source'], 'origin');
  assert.equal(forwarded.body, 'origin');
});
