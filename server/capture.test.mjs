import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { gzipSync } from 'node:zlib';
import { startStudio, startProxy } from './test-support.mjs';
import { compileWhistleRules } from './whistle.mjs';

const upstreamFor = async (t) => {
  const counts = {};
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const server = http.createServer(async (request, response) => {
    const pathname = new URL(request.url, 'http://localhost').pathname;
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    counts[pathname] = (counts[pathname] ?? 0) + 1;
    const body = JSON.stringify({
      path: pathname,
      count: counts[pathname],
      request: Buffer.concat(chunks).toString(),
      cookie: request.headers.cookie ?? null,
      authorization: request.headers.authorization ?? null,
    });
    if (request.url.includes('hold=1')) await gate;
    response.setHeader('access-control-allow-origin', '*');
    if (pathname === '/large') {
      response.end(Buffer.alloc(2 * 1024 * 1024 + 1, 65));
      return;
    }
    if (pathname === '/image.png') {
      response.setHeader('content-type', 'image/png');
      response.end(Buffer.from([137, 80, 78, 71, 0, 255]));
    } else if (pathname === '/gzip') {
      response.setHeader('content-type', 'application/json');
      response.setHeader('content-encoding', 'gzip');
      response.setHeader('set-cookie', 'private=session');
      response.end(gzipSync(body));
    } else if (pathname === '/app.js') {
      response.setHeader('content-type', 'text/javascript');
      response.end('window.replaced = true;');
    } else {
      response.setHeader('content-type', 'application/json');
      response.end(body);
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(
    () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  );
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    counts,
    release,
  };
};
const setup = async (t) => {
  const studio = await startStudio(t);
  assert.equal(
    (
      await studio.call('/api/projects', 'POST', {
        id: 'capture-test',
        name: '录制测试',
      })
    ).status,
    201,
  );
  assert.equal(
    (
      await studio.call('/api/projects/capture-test', 'PATCH', {
        enabled: true,
      })
    ).status,
    200,
  );
  const base = '/api/projects/capture-test';
  const send = (url, method = 'GET', body, extra = {}) =>
    fetch(`http://127.0.0.1:${studio.port}/runtime/dispatch`, {
      method,
      headers: {
        'x-mock-proxy-key': 'isolated-proxy-credential',
        'x-mock-original-url': encodeURIComponent(url),
        ...extra,
      },
      ...(body === undefined ? {} : { body }),
    });
  return { ...studio, base, send };
};

test('真实录制出入参、导出导入关闭、各接口独立回放、末尾停留、重置、开关与顺序整理', async (t) => {
  const studio = await setup(t);
  const upstream = await upstreamFor(t);
  const recording = await studio.call(`${studio.base}/recordings`, 'POST', {
    name: '问题现场',
    scope: upstream.origin + '/',
  });
  assert.equal(recording.status, 200);
  const id = recording.data.id;
  assert.equal((await studio.send(upstream.origin + '/query?t=1')).status, 200);
  await (
    await studio.send(upstream.origin + '/claim', 'POST', '{"claim":true}', {
      'content-type': 'application/json',
      cookie: 'a=b',
      authorization: 'Bearer private',
    })
  ).text();
  await (await studio.send(upstream.origin + '/query?t=2')).text();
  assert.equal(
    (await studio.call(`${studio.base}/recordings/${id}/stop`, 'POST')).status,
    200,
  );
  const exported = await studio.call(`${studio.base}/recordings/${id}/export`);
  assert.equal(exported.status, 200);
  assert.equal(exported.data.recording.entries.length, 3);
  assert.equal(
    Buffer.from(
      exported.data.recording.entries[1].requestBody,
      'base64',
    ).toString(),
    '{"claim":true}',
  );
  assert.equal(
    exported.data.recording.entries[1].requestHeaders.cookie,
    undefined,
  );
  assert.equal(
    exported.data.recording.entries[1].requestHeaders.authorization,
    undefined,
  );
  const imported = await studio.call(`${studio.base}/recordings`, 'POST', {
    package: exported.data,
  });
  assert.equal(imported.status, 200);
  assert.equal(imported.data.enabled, false);
  const replayId = imported.data.id;
  assert.equal(
    (
      await studio.call(`${studio.base}/recordings/${replayId}`, 'PATCH', {
        enabled: true,
      })
    ).status,
    200,
  );
  assert.equal(
    (await (await studio.send(upstream.origin + '/query?random=9')).json())
      .count,
    1,
  );
  assert.equal(
    (
      await (
        await studio.send(upstream.origin + '/claim', 'POST', 'different')
      ).json()
    ).count,
    1,
  );
  assert.equal(
    (await (await studio.send(upstream.origin + '/query')).json()).count,
    2,
  );
  const last = await studio.send(upstream.origin + '/query');
  assert.equal(last.headers.get('x-mock-sequence'), '2/2');
  assert.equal((await last.json()).count, 2);
  assert.equal(upstream.counts['/query'], 2);
  await studio.call(`${studio.base}/recordings/${replayId}/reset`, 'POST');
  assert.equal(
    (await (await studio.send(upstream.origin + '/query')).json()).count,
    1,
  );
  await studio.call(`${studio.base}/recordings/${replayId}`, 'PATCH', {
    enabled: false,
  });
  const entries = imported.data.entries.filter((entry) =>
    entry.url.includes('/query'),
  );
  const key = `GET ${upstream.origin}/query`;
  assert.equal(
    (
      await studio.call(
        `${studio.base}/recordings/${replayId}/responses`,
        'PATCH',
        { key, ids: entries.map((entry) => entry.id).reverse() },
      )
    ).status,
    200,
  );
  await studio.call(`${studio.base}/recordings/${replayId}`, 'PATCH', {
    enabled: true,
  });
  assert.equal(
    (await (await studio.send(upstream.origin + '/query')).json()).count,
    2,
  );
  await studio.call(`${studio.base}/recordings/${replayId}`, 'PATCH', {
    enabled: false,
  });
  assert.equal(
    (await (await studio.send(upstream.origin + '/query')).json()).count,
    3,
  );
});

test('本地 JS/CSS/图片字节、URL 替换、HEAD、查询参数设置及凭据隔离', async (t) => {
  const studio = await setup(t),
    upstream = await upstreamFor(t);
  for (const [extension, contentType, content] of [
    ['js', 'text/javascript', Buffer.from('window.test = "中文";')],
    ['css', 'text/css', Buffer.from('body { color: red; }')],
    ['png', 'image/png', Buffer.from([0, 255, 137, 80])],
  ]) {
    const url = `https://cdn.example.test/app.${extension}`;
    const result = await studio.call(`${studio.base}/resources`, 'POST', {
      name: extension,
      url,
      type: 'file',
      body: content.toString('base64'),
      contentType,
      fileName: `app.${extension}`,
      ignoreQuery: true,
    });
    assert.equal(result.status, 200);
    assert.equal(result.data.enabled, false);
    assert.equal(
      (
        await studio.call(
          `${studio.base}/resources/${result.data.id}`,
          'PATCH',
          { enabled: true },
        )
      ).status,
      200,
    );
    const response = await studio.send(url + '?v=2');
    assert.equal(response.headers.get('content-type'), contentType);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), content);
    const head = await studio.send(url, 'HEAD');
    assert.equal(head.status, 200);
    assert.equal((await head.arrayBuffer()).byteLength, 0);
  }
  const url = 'https://cdn.example.test/remote';
  const remote = await studio.call(`${studio.base}/resources`, 'POST', {
    name: '远程资源',
    url,
    type: 'url',
    targetUrl: upstream.origin + '/echo',
    ignoreQuery: false,
  });
  assert.equal(remote.status, 200);
  await studio.call(`${studio.base}/resources/${remote.data.id}`, 'PATCH', {
    enabled: true,
  });
  const response = await studio.send(url, 'GET', undefined, {
    cookie: 'private=yes',
    authorization: 'Bearer private',
  });
  assert.equal(response.headers.get('x-mock-kind'), 'resource');
  const data = await response.json();
  assert.equal(data.cookie, null);
  assert.equal(data.authorization, null);
  assert.equal(
    (
      await studio.call(`${studio.base}/resources`, 'POST', {
        name: '损坏文件',
        url: url + '/bad',
        type: 'file',
        body: '@@@',
        fileName: 'bad.js',
        contentType: 'text/javascript',
      })
    ).status,
    400,
  );
});

test('压缩响应和图片录制回放保持原始内容，导出不带会话头', async (t) => {
  const studio = await setup(t),
    upstream = await upstreamFor(t);
  const session = (
    await studio.call(`${studio.base}/recordings`, 'POST', {
      name: '压缩与图片',
      scope: upstream.origin + '/',
    })
  ).data;
  const gzip = await studio.send(upstream.origin + '/gzip');
  assert.equal((await gzip.json()).count, 1);
  const image = Buffer.from(
    await (await studio.send(upstream.origin + '/image.png')).arrayBuffer(),
  );
  await studio.call(`${studio.base}/recordings/${session.id}/stop`, 'POST');
  const pack = (
    await studio.call(`${studio.base}/recordings/${session.id}/export`)
  ).data;
  assert.equal(
    pack.recording.entries[0].response.headers['set-cookie'],
    undefined,
  );
  await studio.call(`${studio.base}/recordings/${session.id}`, 'PATCH', {
    enabled: true,
  });
  const replay = await studio.send(upstream.origin + '/gzip');
  assert.equal(replay.headers.get('content-encoding'), 'gzip');
  assert.equal((await replay.json()).count, 1);
  assert.deepEqual(
    Buffer.from(
      await (await studio.send(upstream.origin + '/image.png')).arrayBuffer(),
    ),
    image,
  );
});

test('真实 Whistle 资源规则支持查询参数并返回本地脚本', async (t) => {
  const studio = await setup(t);
  const proxy = await startProxy(t, studio.directory + '/proxy');
  const resource = (
    await studio.call(`${studio.base}/resources`, 'POST', {
      name: 'Whistle JS',
      url: 'http://assets.capture.test/app.js',
      type: 'file',
      body: Buffer.from('window.proxyHit=true;').toString('base64'),
      contentType: 'text/javascript',
      fileName: 'app.js',
    })
  ).data;
  await studio.call(`${studio.base}/resources/${resource.id}`, 'PATCH', {
    enabled: true,
  });
  await proxy.setRules(
    compileWhistleRules(
      (await studio.call('/api/state')).data,
      'isolated-proxy-credential',
    ),
  );
  const response = await new Promise((resolve, reject) => {
    const req = http.get(
      {
        hostname: '127.0.0.1',
        port: proxy.port,
        path: 'http://assets.capture.test/app.js?v=10',
        headers: { host: 'assets.capture.test' },
      },
      (res) => {
        let body = '';
        res.on('data', (chunk) => {
          body += chunk;
        });
        res.on('end', () =>
          resolve({ status: res.statusCode, body, headers: res.headers }),
        );
      },
    );
    req.on('error', reject);
  });
  assert.equal(response.status, 200);
  assert.equal(response.body, 'window.proxyHit=true;');
  assert.equal(response.headers['x-mock-kind'], 'resource');
  const rules = compileWhistleRules(
    (await studio.call('/api/state')).data,
    'test',
  );
  assert.match(rules, /app\\\.js/);
});

test('真实 Whistle 完成前缀录制和跨查询参数回放，记录原始 URL 而不拼接分发路径', async (t) => {
  const studio = await setup(t),
    upstream = await upstreamFor(t);
  const proxy = await startProxy(t, studio.directory + '/proxy');
  const sync = async () =>
    proxy.setRules(
      compileWhistleRules(
        (await studio.call('/api/state')).data,
        'isolated-proxy-credential',
      ),
    );
  const send = (pathname) =>
    new Promise((resolve, reject) => {
      const req = http.get(
        {
          hostname: '127.0.0.1',
          port: proxy.port,
          path: upstream.origin + pathname,
          headers: { host: new URL(upstream.origin).host },
        },
        (res) => {
          const chunks = [];
          res.on('data', (chunk) => chunks.push(chunk));
          res.on('end', () =>
            resolve({
              status: res.statusCode,
              body: Buffer.concat(chunks).toString(),
              headers: res.headers,
            }),
          );
        },
      );
      req.on('error', reject);
    });
  const session = (
    await studio.call(`${studio.base}/recordings`, 'POST', {
      name: '真实代理录制',
      scope: upstream.origin + '/',
    })
  ).data;
  await sync();
  assert.equal(JSON.parse((await send('/query?t=1')).body).count, 1);
  assert.equal(JSON.parse((await send('/other')).body).count, 1);
  assert.equal(JSON.parse((await send('/query?t=2')).body).count, 2);
  await studio.call(`${studio.base}/recordings/${session.id}/stop`, 'POST');
  await sync();
  const pack = (
    await studio.call(`${studio.base}/recordings/${session.id}/export`)
  ).data;
  assert.equal(pack.recording.entries.length, 3);
  assert.equal(pack.recording.entries[0].url, upstream.origin + '/query?t=1');
  await studio.call(`${studio.base}/recordings/${session.id}`, 'PATCH', {
    enabled: true,
  });
  await sync();
  assert.equal(JSON.parse((await send('/query?t=99')).body).count, 1);
  assert.equal(JSON.parse((await send('/other')).body).count, 1);
  assert.equal(JSON.parse((await send('/query')).body).count, 2);
  assert.equal(upstream.counts['/query'], 2);
});

test('并发录制按请求到达顺序保存，停止后等待在途请求，超限只跳过录制而不破坏真实响应', async (t) => {
  const studio = await setup(t),
    upstream = await upstreamFor(t);
  const recording = (
    await studio.call(`${studio.base}/recordings`, 'POST', {
      name: '并发现场',
      scope: upstream.origin + '/',
    })
  ).data;
  const first = studio.send(upstream.origin + '/query?hold=1');
  for (let index = 0; index < 50 && !upstream.counts['/query']; index++)
    await new Promise((resolve) => setTimeout(resolve, 2));
  assert.equal(
    (await (await studio.send(upstream.origin + '/query')).json()).count,
    2,
  );
  await studio.call(`${studio.base}/recordings/${recording.id}/stop`, 'POST');
  assert.equal(
    (await studio.call(`${studio.base}/recordings/${recording.id}/export`))
      .status,
    409,
  );
  upstream.release();
  assert.equal((await (await first).json()).count, 1);
  const pack = (
    await studio.call(`${studio.base}/recordings/${recording.id}/export`)
  ).data;
  assert.equal(
    pack.recording.entries[0].url,
    upstream.origin + '/query?hold=1',
  );
  await studio.call(`${studio.base}/recordings/${recording.id}`, 'PATCH', {
    enabled: true,
  });
  assert.equal(
    (await (await studio.send(upstream.origin + '/query')).json()).count,
    1,
  );
  await studio.call(`${studio.base}/recordings/${recording.id}`, 'PATCH', {
    enabled: false,
  });
  const large = (
    await studio.call(`${studio.base}/recordings`, 'POST', {
      name: '大小限制',
      scope: upstream.origin + '/large',
    })
  ).data;
  assert.equal(
    (await (await studio.send(upstream.origin + '/large')).arrayBuffer())
      .byteLength,
    2 * 1024 * 1024 + 1,
  );
  const state = (await studio.call('/api/state')).data;
  const session = state.projects[0].recordings.find(
    (item) => item.id === large.id,
  );
  assert.equal(session.entries.length, 0);
  assert.equal(session.skipped, 1);
  assert.equal(session.pending, 0);
});

test('资源应用项目跨域策略，冲突或损坏包不会覆盖已有配置，整包导入关闭新功能', async (t) => {
  const studio = await setup(t);
  const input = {
    name: '模块脚本',
    url: 'https://assets.test/app.js',
    type: 'file',
    body: Buffer.from('export default 1;').toString('base64'),
    fileName: 'app.js',
    contentType: 'text/javascript',
  };
  const resource = (
    await studio.call(`${studio.base}/resources`, 'POST', input)
  ).data;
  await studio.call(`${studio.base}/resources/${resource.id}`, 'PATCH', {
    enabled: true,
  });
  assert.equal(
    (await studio.send(input.url)).headers.get('access-control-allow-origin'),
    '*',
  );
  await studio.call(studio.base, 'PATCH', {
    cors: {
      mode: 'allow-list',
      origins: ['https://page.test'],
      headers: ['content-type'],
      credentials: true,
    },
  });
  const rejected = await studio.send(input.url, 'GET', undefined, {
    origin: 'https://other.test',
  });
  assert.equal(rejected.status, 403);
  const allowed = await studio.send(input.url, 'GET', undefined, {
    origin: 'https://page.test',
  });
  assert.equal(
    allowed.headers.get('access-control-allow-origin'),
    'https://page.test',
  );
  const duplicate = (
    await studio.call(`${studio.base}/resources`, 'POST', input)
  ).data;
  assert.equal(
    (
      await studio.call(`${studio.base}/resources/${duplicate.id}`, 'PATCH', {
        enabled: true,
      })
    ).status,
    409,
  );
  const exported = (await studio.call(`${studio.base}/export`)).data;
  const imported = await studio.call('/api/packages/apply', 'POST', {
    projectId: 'imported-tools',
    package: exported,
  });
  assert.equal(imported.status, 200);
  const project = (await studio.call('/api/state')).data.projects.find(
    (item) => item.id === 'imported-tools',
  );
  assert.equal(project.enabled, false);
  assert.ok(project.resources.every((item) => !item.enabled));
  assert.equal(
    (
      await studio.call(`${studio.base}/recordings`, 'POST', {
        package: {
          format: 'mock-studio-recording',
          version: 1,
          recording: {
            name: '损坏',
            scope: 'javascript:alert(1)',
            entries: [],
            selectedKeys: [],
          },
        },
      })
    ).status,
    400,
  );
});
