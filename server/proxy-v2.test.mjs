import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import { existsSync } from 'node:fs';
import { startStudio, startProxy } from './test-support.mjs';
import { compileWhistleRules } from './whistle.mjs';

/** 经真实 HTTP 或 CONNECT 隧道发起完整原始请求 */
const proxyRequest = (port, url, method = 'POST', body = '', headers = {}) => new Promise((resolve, reject) => {
  // 所有请求都通过隔离代理。
  const target = new URL(url);
  // 收集响应供测试检查原始 URL、状态和内部标记。
  const receive = (response) => {
    const chunks = [];
    response.on('data', (chunk) => chunks.push(chunk));
    response.on('end', () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString(), headers: response.headers }));
    response.on('error', reject);
  };
  if (target.protocol === 'https:') {
    // CONNECT 后仅在隔离测试中接受 Whistle 的测试证书。
    const tunnel = http.request({ host: '127.0.0.1', port, method: 'CONNECT', path: target.host });
    tunnel.on('connect', (_response, socket) => {
      const secure = tls.connect({ socket, servername: target.hostname, rejectUnauthorized: false }, () => {
        // 使用已建立的 TLS 隧道，禁止 HTTPS 客户端重新解析目标域名。
        const agent = new https.Agent();
        agent.createConnection = () => secure;
        const request = https.request(url, { method, agent, rejectUnauthorized: false, headers: { connection: 'close', 'content-length': Buffer.byteLength(body), ...headers } }, receive);
        request.on('error', reject); request.end(body);
      });
      secure.on('error', reject);
    });
    tunnel.on('error', reject); tunnel.end();
  } else {
    // HTTP 使用绝对地址，由 Whistle 还原并编码传递。
    const request = http.request({ host: '127.0.0.1', port, path: url, method, headers: { 'content-length': Buffer.byteLength(body), connection: 'close', ...headers } }, receive);
    request.setTimeout(5000, () => request.destroy(new Error('proxy timeout')));
    request.on('error', reject); request.end(body);
  }
});

test('隔离 Whistle：精确/模糊/重叠、元数据覆盖、错误顺序与旧规则回源', { skip: !existsSync('/Applications/Whistle.app'), timeout: 20000 }, async (t) => {
  // 真实 API 与代理都使用临时目录。
  const studio = await startStudio(t);
  // 模拟回源，响应正文包含收到的完整方法、地址、正文和内部头是否泄漏。
  const origin = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ origin: true, url: request.url, method: request.method, body: Buffer.concat(chunks).toString(), leaked: Object.keys(request.headers).some((name) => name.startsWith('x-mock-')) }));
  });
  await new Promise((resolve) => origin.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => origin.close(resolve)));
  const proxy = await startProxy(t, `${studio.directory}/whistle`);
  const url = `http://127.0.0.1:${origin.address().port}/Path?a=%2f&b=2`;
  await studio.call('/api/projects', 'POST', { id: 'p', name: 'p' });
  for (const [id, type, value] of [['exact', 'exact', url], ['contains', 'contains', 'Path'], ['full', 'contains', url]]) {
    await studio.call('/api/projects/p/mocks', 'POST', { id, name: id, method: 'PUT', match: { type, value }, response: { status: 200, delayMs: 0, headers: {}, body: { id } } });
    await studio.call(`/api/projects/p/mocks/${id}`, 'PATCH', { enabled: true });
  }
  // 托管规则全部指向相同分发器，规则重叠不改变应用层顺序。
  await proxy.setRules(compileWhistleRules((await studio.call('/api/state')).data, 'isolated-proxy-credential'));
  assert.equal(JSON.parse((await proxyRequest(proxy.port, url, 'PUT', '', { 'x-mock-original-url': 'forged', 'x-mock-proxy-key': 'forged' })).body).id, 'exact');
  assert.equal(JSON.parse((await proxyRequest(proxy.port, url.replace('a=%2f&b=2', 'b=2&a=%2f'), 'PUT')).body).id, 'contains');
  assert.equal(JSON.parse((await proxyRequest(proxy.port, url.replace('/Path', '/path'), 'PUT')).body).origin, true);
  assert.equal(JSON.parse((await proxyRequest(proxy.port, url, 'GET')).body).origin, true);
  // 保留过期代理规则，停用后的分发器必须安全回源而非误报命中。
  for (const id of ['exact', 'contains', 'full']) await studio.call(`/api/projects/p/mocks/${id}`, 'PATCH', { enabled: false });
  const forwarded = JSON.parse((await proxyRequest(proxy.port, url, 'PUT', 'real-body')).body);
  assert.deepEqual(forwarded, { origin: true, url: '/Path?a=%2f&b=2', method: 'PUT', body: 'real-body', leaked: false });
  // 包含完整协议前缀的模糊条件同样能经代理命中。
  await studio.call('/api/projects/p/mocks/full', 'PATCH', { enabled: true });
  await proxy.setRules(compileWhistleRules((await studio.call('/api/state')).data, 'isolated-proxy-credential'));
  const full = await proxyRequest(proxy.port, url, 'PUT');
  assert.equal(full.status, 200, full.body);
  assert.equal(JSON.parse(full.body).id, 'full');
  // HTTPS 用隔离 Whistle 的 CONNECT 解密执行同一分发入口。
  await studio.call('/api/projects/p/mocks', 'POST', { id: 'secure', name: 'secure', method: 'POST', match: { type: 'exact', value: 'https://secure.mock.test/query?x=%2f' }, response: { status: 200, delayMs: 0, headers: {}, body: { secure: true } } });
  await studio.call('/api/projects/p/mocks/secure', 'PATCH', { enabled: true });
  await proxy.setRules(compileWhistleRules((await studio.call('/api/state')).data, 'isolated-proxy-credential') + '\n* enable://capture');
  const secure = await proxyRequest(proxy.port, 'https://secure.mock.test/query?x=%2f');
  assert.equal(secure.status, 200);
  assert.equal(JSON.parse(secure.body).secure, true);
  // 实际命中记录包含原始地址，绝非本地分发地址。
  assert.equal((await studio.call('/api/hits?projectId=p')).data.hits[0].actualUrl, 'https://secure.mock.test/query?x=%2f');
});
