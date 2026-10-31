import { render, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, test, vi } from 'vitest';
import { DemoPage } from '@/components/demo-page';
import {
  DEMO_ORIGIN,
  DEMO_PROJECT_ID,
  demoLessons,
  demoPackage,
  sendDemoRequest,
} from '@/lib/demo';

const urlOf = (input: RequestInfo | URL) =>
  typeof input === 'string'
    ? input
    : input instanceof URL
      ? input.href
      : input.url;
const tasks = demoLessons[0].requests[0];
function mockApi(
  project: object | null = null,
  business?: (
    input: RequestInfo | URL,
    options?: RequestInit,
  ) => Promise<Response>,
) {
  return vi
    .spyOn(globalThis, 'fetch')
    .mockImplementation(async (input, options) => {
      const url = urlOf(input);
      if (url.startsWith(DEMO_ORIGIN)) {
        if (!business) throw new TypeError('Failed to fetch');
        return business(input, options);
      }
      if (url.endsWith('/api/token'))
        return Response.json({ token: 'test-management-only' });
      if (url.endsWith('/api/state'))
        return Response.json({ projects: project ? [project] : [] });
      if (url.endsWith('/api/packages/apply'))
        return Response.json({ sync: { ok: true } });
      if (url.endsWith('/demo-reward-flow/reset'))
        return Response.json({ sync: { ok: true } });
      throw new Error(`未声明的请求：${url}`);
    });
}

test('初次进入只读取配置，不发送业务请求或写入项目', async () => {
  const fetch = mockApi();
  render(<DemoPage />);
  await screen.findByText('先创建练习项目，再到控制台启用对应规则。');
  expect(
    fetch.mock.calls.every(
      ([url, options]) =>
        !urlOf(url).startsWith(DEMO_ORIGIN) && !options?.method,
    ),
  ).toBe(true);
  expect(screen.getByRole('link', { name: '打开练习配置' })).toHaveAttribute(
    'href',
    `/?project=${DEMO_PROJECT_ID}`,
  );
});

test('已有练习不会被重新导入覆盖', async () => {
  const user = userEvent.setup();
  const fetch = mockApi({
    id: DEMO_PROJECT_ID,
    enabled: false,
    combinations: [],
  });
  render(<DemoPage />);
  await user.click(await screen.findByRole('button', { name: '继续已有练习' }));
  await screen.findByText(
    '练习项目已存在，已保留你的修改。请打开练习配置继续操作。',
  );
  expect(
    fetch.mock.calls.some(([, options]) => options?.method === 'POST'),
  ).toBe(false);
});

test('主动创建使用独立项目，网络失败不误报成某个具体配置错误', async () => {
  const user = userEvent.setup();
  const fetch = mockApi();
  render(<DemoPage />);
  await screen.findByText('先创建练习项目，再到控制台启用对应规则。');
  await user.click(screen.getByRole('button', { name: '创建练习项目' }));
  await screen.findByText(/练习项目已创建/);
  const created = fetch.mock.calls.find(([url]) =>
    urlOf(url).endsWith('/api/packages/apply'),
  );
  expect(JSON.parse(created?.[1]?.body as string)).toEqual({
    projectId: DEMO_PROJECT_ID,
    package: demoPackage,
  });
  await user.click(screen.getByRole('button', { name: '查询任务' }));
  const details = await screen.findByRole('region', { name: '当前请求详情' });
  expect(within(details).getByText('未获取到响应')).toBeInTheDocument();
  expect(
    within(details).getByText(/网络或跨域问题也可能导致此结果/),
  ).toBeInTheDocument();
});

test('请求进行中禁止重复点击，可取消；清空记录不重置组合', async () => {
  const user = userEvent.setup();
  const fetch = mockApi(
    null,
    async (_input, options) =>
      new Promise((_resolve, reject) =>
        options?.signal?.addEventListener('abort', () =>
          reject(new DOMException('cancelled', 'AbortError')),
        ),
      ),
  );
  render(<DemoPage />);
  await user.click(screen.getByRole('button', { name: '查询任务' }));
  expect(screen.getByRole('button', { name: '查询任务' })).toBeDisabled();
  expect(screen.getByRole('button', { name: /领取组合/ })).toBeDisabled();
  await user.click(screen.getByRole('button', { name: '取消请求' }));
  await screen.findByText(
    '已停止等待；请求若已到达服务端，组合进度仍可能推进。',
  );
  await user.click(screen.getByRole('button', { name: '清空本页请求记录' }));
  expect(screen.getByText('发送一次请求，从这里查看结果')).toBeInTheDocument();
  expect(
    fetch.mock.calls.filter(([url]) => urlOf(url).startsWith(DEMO_ORIGIN)),
  ).toHaveLength(1);
  expect(fetch.mock.calls.some(([url]) => urlOf(url).endsWith('/reset'))).toBe(
    false,
  );
});

test('重置共享组合需要明确确认，并使用项目版本', async () => {
  const user = userEvent.setup();
  const fetch = mockApi({
    id: DEMO_PROJECT_ID,
    enabled: true,
    revision: 'rev-a',
    combinations: [
      {
        id: 'demo-reward-flow',
        name: '领取奖励流程',
        enabled: true,
        currentIndex: 1,
        steps: [{}, {}, {}],
      },
    ],
  });
  render(<DemoPage />);
  await screen.findByText('已找到练习项目，可以继续上次的配置。');
  await user.click(screen.getByRole('button', { name: /领取组合/ }));
  await user.click(screen.getByRole('button', { name: '重新开始组合' }));
  expect(fetch.mock.calls.some(([url]) => urlOf(url).endsWith('/reset'))).toBe(
    false,
  );
  await user.click(
    within(screen.getByRole('dialog')).getByRole('button', {
      name: '确认重置',
    }),
  );
  await screen.findByText(/组合已回到第一步/);
  const reset = fetch.mock.calls.find(([url]) => urlOf(url).endsWith('/reset'));
  expect(new Headers(reset?.[1]?.headers).get('if-match')).toBe('"rev-a"');
});

test('HTTP 500 仍可确认命中，响应保留原文且管理凭据不发往测试域名', async () => {
  const fetch = mockApi(null, async () =>
    Response.json(
      { success: false, message: '服务异常' },
      {
        status: 500,
        headers: {
          'x-mock-source': 'mock-studio',
          'x-mock-hit-id': 'hit-real',
        },
      },
    ),
  );
  const result = await sendDemoRequest(
    'first',
    tasks,
    new AbortController().signal,
  );
  expect(result.outcome).toBe('mock');
  expect(result.status).toBe(500);
  expect(result.json).toEqual({ success: false, message: '服务异常' });
  const options = fetch.mock.calls[0][1]!;
  expect(new Headers(options.headers).has('x-mock-token')).toBe(false);
  expect(options.credentials).toBe('omit');
  expect(options.cache).toBe('no-store');
});

test.each([
  {
    body: { source: 'mock-studio' },
    headers: {},
    outcome: 'unconfirmed',
    status: 200,
  },
  {
    body: true,
    headers: { 'x-mock-source': 'mock-studio' },
    outcome: 'unconfirmed',
    status: 200,
  },
  {
    body: { code: 'COMBINATION_ORDER_MISMATCH', hitId: 'hit-order' },
    headers: {},
    outcome: 'order-mismatch',
    status: 409,
  },
])(
  '来源判定不依赖业务字段：$outcome',
  async ({ body, headers, outcome, status }) => {
    mockApi(null, async () =>
      Response.json(body, {
        status,
        headers: headers as Record<string, string>,
      }),
    );
    expect(
      (await sendDemoRequest('first', tasks, new AbortController().signal))
        .outcome,
    ).toBe(outcome);
  },
);

test('超时与主动取消分别记录，超时不会伪造 HTTP 状态', async () => {
  mockApi(null, async (_input, options) => {
    throw options?.signal?.reason;
  });
  const signal = new AbortController();
  signal.abort(new DOMException('timeout', 'TimeoutError'));
  const result = await sendDemoRequest('first', tasks, signal.signal);
  expect(result).toMatchObject({ outcome: 'timeout', status: null, text: '' });
});

test('JSON POST 保留请求参数和自定义头，页面卸载取消正在等待的请求', async () => {
  const fetch = mockApi(null, async () => Response.json(null));
  const request = demoLessons.find((lesson) => lesson.id === 'cors')!
    .requests[0];
  await sendDemoRequest('cors', request, new AbortController().signal);
  expect(fetch.mock.calls[0][1]).toMatchObject({
    method: 'POST',
    body: JSON.stringify({ taskId: 'demo-task' }),
  });
  expect(new Headers(fetch.mock.calls[0][1]?.headers).get('content-type')).toBe(
    'application/json',
  );
  expect(
    new Headers(fetch.mock.calls[0][1]?.headers).get('x-demo-client'),
  ).toBe('mock-studio-demo');
  const pending = mockApi(
    null,
    async (_input, options) =>
      new Promise((_resolve, reject) =>
        options?.signal?.addEventListener('abort', () =>
          reject(options.signal?.reason),
        ),
      ),
  );
  const user = userEvent.setup();
  const view = render(<DemoPage />);
  await user.click(screen.getByRole('button', { name: '查询任务' }));
  const business = pending.mock.calls
    .filter(([url]) => urlOf(url).startsWith(DEMO_ORIGIN))
    .at(-1);
  view.unmount();
  await waitFor(() => expect(business?.[1]?.signal?.aborted).toBe(true));
});
