import { test, expect } from './fixtures';

const base = '/api/projects/mock-studio-demo';

test('创建练习、控制台启用、修改响应与关闭规则，真实代理结果随配置变化', async ({
  demo,
}) => {
  const { page, origin, call } = demo;
  await page.goto(`${origin}/demo`);
  await page.getByRole('button', { name: '创建练习项目' }).click();
  await expect(page.getByText(/练习项目已创建/)).toBeVisible();
  await page.getByRole('link', { name: '打开练习配置' }).click();
  await expect(
    page.getByRole('heading', { name: 'Mock Studio 功能体验' }),
  ).toBeVisible();
  await page.getByRole('switch', { name: '项目总开关' }).click();
  const row = page
    .getByRole('row')
    .filter({ has: page.getByText('任务查询', { exact: true }) });
  await row.getByRole('switch').click();
  await expect(row.getByRole('switch')).toBeChecked();
  await page.getByRole('link', { name: '功能体验' }).click();
  await page.getByRole('button', { name: '查询任务', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: '完成第一次 Mock' }),
  ).toBeVisible();
  await expect(page.getByTestId('demo-hit-id')).toContainText('hit-');
  const state = (await call('/api/state')).data;
  const task = state.projects[0].mocks.find(
    (mock: { id: string }) => mock.id === 'demo-tasks',
  );
  await call(`${base}/mocks/demo-tasks`, 'PATCH', {
    response: {
      ...task.response,
      body: {
        ...task.response.body,
        task: { ...task.response.body.task, title: '刚刚修改的新任务' },
      },
    },
  });
  await page.getByRole('button', { name: '查询任务', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: '刚刚修改的新任务' }),
  ).toBeVisible();
  await call(`${base}/mocks/demo-tasks`, 'PATCH', { enabled: false });
  await page.getByRole('button', { name: '查询任务', exact: true }).click();
  await expect(page.getByLabel('当前请求详情')).toContainText(
    /未获取到响应|请求超时|来源未确认/,
  );
  expect(
    (await call('/api/hits?projectId=mock-studio-demo')).data.hits,
  ).toHaveLength(2);
});

test('延迟显示等待，HTTP 500 仍显示 Mock 来源并能核对命中记录', async ({
  demo,
}) => {
  const { page, origin, call, seed } = demo;
  await seed();
  await call(`${base}/mocks/demo-slow`, 'PATCH', { enabled: true });
  await call(`${base}/mocks/demo-error`, 'PATCH', { enabled: true });
  await page.goto(`${origin}/demo`);
  await page.getByRole('button', { name: /延迟与失败/ }).click();
  await page.getByRole('button', { name: '慢速查询', exact: true }).click();
  await expect(page.getByText('正在等待响应…')).toBeVisible();
  await expect(
    page.getByRole('button', { name: '慢速查询', exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole('heading', { name: '慢一点，也能准确返回' }),
  ).toBeVisible();
  await page.getByRole('button', { name: '请求失败响应', exact: true }).click();
  await expect(page.getByLabel('当前请求详情')).toContainText('HTTP 500');
  await expect(page.getByLabel('当前请求详情')).toContainText(
    '已确认 Mock 命中',
  );
  const id = await page.getByTestId('demo-hit-id').innerText();
  expect(
    (await call('/api/hits')).data.hits.some(
      (hit: { id: string; status: number }) =>
        hit.id === id && hit.status === 500,
    ),
  ).toBe(true);
});

test('组合按序执行、乱序 409，重置后回到第一步且预检不推进', async ({
  demo,
}) => {
  const { page, origin, call, seed } = demo;
  await seed();
  await call(`${base}/combinations/demo-reward-flow`, 'PATCH', {
    enabled: true,
  });
  await page.goto(`${origin}/demo`);
  await page.getByRole('button', { name: /领取组合/ }).click();
  await page.getByRole('button', { name: '查询领取状态', exact: true }).click();
  await expect(page.getByText('未领取', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '领取奖励', exact: true }).click();
  await expect(page.getByTestId('demo-response')).toContainText('领取成功');
  await page.getByRole('button', { name: '查询领取状态', exact: true }).click();
  await expect(page.getByText('已领取', { exact: true })).toBeVisible();
  expect((await call('/api/hits')).data.hits).toHaveLength(3);
  await page.getByRole('button', { name: '重新开始组合' }).click();
  await page.getByRole('button', { name: '确认重置' }).click();
  await expect(page.getByText(/组合已回到第一步/)).toBeVisible();
  await page.getByRole('button', { name: '领取奖励', exact: true }).click();
  await expect(page.getByLabel('当前请求详情')).toContainText('组合顺序不匹配');
  await expect(page.getByTestId('demo-response')).toContainText(
    'COMBINATION_ORDER_MISMATCH',
  );
  expect(
    (await call('/api/state')).data.projects[0].combinations[0].currentIndex,
  ).toBe(0);
});

test('精确与模糊匹配、参数顺序和方法限制', async ({ demo }) => {
  const { page, origin, call, seed } = demo;
  await seed();
  await call(`${base}/mocks/demo-exact`, 'PATCH', { enabled: true });
  await page.goto(`${origin}/demo`);
  await page.getByRole('button', { name: /匹配练习/ }).click();
  await page.getByRole('button', { name: '原始参数', exact: true }).click();
  await expect(page.getByTestId('demo-response')).toContainText('精确匹配成功');
  await page.getByRole('button', { name: '调换参数顺序', exact: true }).click();
  await expect(page.getByLabel('当前请求详情')).toContainText(
    /未获取到响应|请求超时|来源未确认/,
  );
  await call(`${base}/mocks/demo-exact`, 'PATCH', { enabled: false });
  await call(`${base}/mocks/demo-contains`, 'PATCH', { enabled: true });
  await page.getByRole('button', { name: '调换参数顺序', exact: true }).click();
  await expect(page.getByTestId('demo-response')).toContainText('模糊匹配成功');
  await page.getByRole('button', { name: '改为 POST', exact: true }).click();
  await expect(page.getByLabel('当前请求详情')).toContainText(
    /未获取到响应|请求超时|来源未确认/,
  );
  expect((await call('/api/hits')).data.hits).toHaveLength(2);
});

test('浏览器跨域 POST 允许与拒绝，预检不产生业务命中', async ({ demo }) => {
  const { page, origin, call, seed } = demo;
  await seed();
  await call(`${base}/mocks/demo-cors`, 'PATCH', { enabled: true });
  await page.goto(`${origin}/demo`);
  await page.getByRole('button', { name: /跨域请求/ }).click();
  await page
    .getByRole('button', { name: '提交 JSON 与自定义头', exact: true })
    .click();
  await expect(page.getByTestId('demo-response')).toContainText(
    'JSON 和自定义请求头已送达',
  );
  await expect(page.getByLabel('当前请求详情')).toContainText(
    '已确认 Mock 命中',
  );
  expect((await call('/api/hits')).data.hits).toHaveLength(1);
  await call(`${base}`, 'PATCH', {
    cors: {
      mode: 'allow-list',
      origins: [origin],
      headers: ['content-type'],
      credentials: false,
    },
  });
  await page
    .getByRole('button', { name: '提交 JSON 与自定义头', exact: true })
    .click();
  await expect(page.getByLabel('当前请求详情')).toContainText('未获取到响应');
  expect((await call('/api/hits')).data.hits).toHaveLength(1);
});

test('桌面构建入口可直达 Demo，主题恢复且窄屏无页面横向溢出', async ({
  demo,
}) => {
  const { page, origin } = demo;
  await page.goto(`${origin}/demo`);
  await expect(
    page.getByRole('heading', { name: /让每一次请求/ }),
  ).toBeVisible();
  const theme = await page.locator('html').getAttribute('data-theme');
  await page.getByRole('button', { name: /切换到/ }).click();
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute(
    'data-theme',
    theme === 'dark' ? 'light' : 'dark',
  );
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await expect(
    page.getByRole('button', { name: '查询任务', exact: true }),
  ).toBeVisible();
});
