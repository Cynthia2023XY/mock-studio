import { test as base, expect, type Page } from '@playwright/test';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { startStudio, startProxy } from '../server/test-support.mjs';
import { compileWhistleRules } from '../server/whistle.mjs';
import examplePackage from '../distribution/examples/demo-package.json' with { type: 'json' };

type DemoFixture = {
  page: Page;
  origin: string;
  studio: Awaited<ReturnType<typeof startStudio>>;
  call: (
    route: string,
    method?: string,
    body?: unknown,
  ) => Promise<
    Awaited<ReturnType<Awaited<ReturnType<typeof startStudio>>['call']>>
  >;
  seed: () => Promise<void>;
};

/** 构建产物和真实代理全部使用临时端口，不占用开发页面或用户代理。 */
export const test = base.extend<{ demo: DemoFixture }>({
  demo: async ({ browser }, runFixture) => {
    if (
      !existsSync(
        '/Applications/Whistle.app/Contents/Resources/app/node_modules/whistle',
      )
    )
      throw new Error(
        '完整 Demo 回归需要安装 Whistle.app；未执行代理测试不能算作通过。',
      );
    if (!existsSync('desktop-dist/index.html'))
      throw new Error('请先构建桌面页面：npm run build:desktop-ui');
    const cleanup: (() => Promise<unknown>)[] = [];
    const lifecycle = {
      after: (callback: () => Promise<unknown>) => cleanup.push(callback),
    };
    try {
      const studio = await startStudio(lifecycle);
      const proxy = await startProxy(
        lifecycle,
        path.join(studio.directory, 'proxy'),
      );
      const syncRules = async () =>
        proxy.setRules(
          compileWhistleRules(
            (await studio.call('/api/state')).data,
            'isolated-proxy-credential',
          ),
        );
      let origin = '';
      const packageForTest = () => ({
        ...structuredClone(examplePackage),
        cors: {
          ...examplePackage.cors,
          origins: [...examplePackage.cors.origins, origin],
        },
      });
      const server = createServer(async (request, response) => {
        const pathname = new URL(request.url ?? '/', 'http://localhost')
          .pathname;
        if (pathname.startsWith('/__test-api__/api/')) {
          try {
            response.setHeader('content-type', 'application/json');
            const url = new URL(
              request.url!.replace('/__test-api__', ''),
              'http://localhost',
            );
            if (url.pathname === '/api/token') {
              response.end(
                JSON.stringify({
                  token: (await readFile(studio.tokenPath, 'utf8')).trim(),
                }),
              );
              return;
            }
            const chunks: Buffer[] = [];
            for await (const chunk of request) chunks.push(chunk);
            const text = Buffer.concat(chunks).toString();
            const body = text ? JSON.parse(text) : undefined;
            if (url.pathname === '/api/packages/apply' && body?.package)
              body.package = packageForTest();
            const result = await studio.call(
              `${url.pathname}${url.search}`,
              request.method,
              body,
              request.headers['if-match']
                ? { 'if-match': request.headers['if-match'] }
                : {},
            );
            if (request.method !== 'GET') await syncRules();
            response.statusCode = result.status;
            response.end(JSON.stringify(result.data));
          } catch (error) {
            response
              .writeHead(500)
              .end(JSON.stringify({ message: String(error) }));
          }
          return;
        }
        const relative = ['/', '/demo', '/demo/'].includes(pathname)
          ? 'index.html'
          : pathname.slice(1);
        if (!/^(index\.html|assets\/[a-zA-Z0-9_.-]+)$/.test(relative)) {
          response.writeHead(404).end();
          return;
        }
        try {
          const data = await readFile(path.join('desktop-dist', relative));
          response.setHeader(
            'content-type',
            (
              {
                '.html': 'text/html',
                '.js': 'text/javascript',
                '.css': 'text/css',
              } as Record<string, string>
            )[path.extname(relative)] ?? 'application/octet-stream',
          );
          response.end(data);
        } catch {
          response.writeHead(404).end();
        }
      });
      cleanup.push(
        () =>
          new Promise<void>((resolve) => {
            server.closeAllConnections();
            server.close(() => resolve());
          }),
      );
      await new Promise<void>((resolve) =>
        server.listen(0, '127.0.0.1', resolve),
      );
      const address = server.address();
      if (!address || typeof address === 'string')
        throw new Error('测试页面端口无效');
      origin = `http://127.0.0.1:${address.port}`;
      const context = await browser.newContext({
        proxy: {
          server: `http://127.0.0.1:${proxy.port}`,
          bypass: '127.0.0.1,localhost',
        },
      });
      cleanup.push(() => context.close());
      const call = async (route: string, method = 'GET', body?: unknown) => {
        const result = await studio.call(route, method, body);
        if (method !== 'GET')
          await proxy.setRules(
            compileWhistleRules(
              (await studio.call('/api/state')).data,
              'isolated-proxy-credential',
            ),
          );
        return result;
      };
      // 只重定向管理地址到隔离服务，业务请求仍使用浏览器原生 fetch。
      // 不使用 context.route：DevTools 请求拦截会影响 Chromium 的预检行为。
      await context.addInitScript(() => {
        const nativeFetch = window.fetch.bind(window);
        window.fetch = (input, options) => {
          if (
            typeof input === 'string' &&
            input.startsWith('http://127.0.0.1:17321/api/')
          ) {
            const url = new URL(input);
            input = `${window.location.origin}/__test-api__${url.pathname}${url.search}`;
          }
          return nativeFetch(input, options);
        };
      });
      const page = await context.newPage();
      const seed = async () => {
        expect(
          (
            await call('/api/packages/apply', 'POST', {
              projectId: 'mock-studio-demo',
              package: packageForTest(),
            })
          ).status,
        ).toBe(200);
        expect(
          (
            await call('/api/projects/mock-studio-demo', 'PATCH', {
              enabled: true,
            })
          ).status,
        ).toBe(200);
      };
      await runFixture({ page, origin, studio, call, seed });
    } finally {
      for (const callback of cleanup.reverse()) await callback();
    }
  },
});
export { expect };
