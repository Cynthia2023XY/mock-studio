import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, test, vi } from 'vitest';
import Home from '@/app/page';

const mock = { id: 'query', name: '首页查询', enabled: true, method: 'POST', match: { type: 'contains', value: 'queryHome' }, response: { status: 200, delayMs: 0, headers: {}, body: { ok: true } } };
const healthy = { ok: true, verified: true, checkedAt: new Date().toISOString(), desiredDigest: 'a', verifiedDigest: 'a', ruleCount: 1, syncedAt: new Date().toISOString(), message: '已验证' };
function mockApi(enabled: boolean, whistle: object = healthy) {
  const projects = [
    { id: 'first', name: '页面测试项目', enabled, description: '第一个项目', endpoints: [], mocks: [mock], combinations: [], revision: 'v1' },
    { id: 'second', name: '另一个项目', enabled: true, description: '第二个项目', endpoints: [], mocks: [], combinations: [], revision: 'v1' },
  ];
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.endsWith('/api/token')) return new Response(JSON.stringify({ token: 'isolated-ui-token' }));
    if (url.includes('/api/hits')) return new Response(JSON.stringify({ hits: [] }));
    if (url.endsWith('/api/state')) return new Response(JSON.stringify({ projects, runtime: { whistle }, snapshots: [] }));
    throw new Error(`测试不允许未声明的请求：${url}`);
  });
}

test.each([
  { enabled: false, whistle: healthy, label: '项目已关闭' },
  { enabled: true, whistle: healthy, label: '规则可用' },
  { enabled: true, whistle: { ...healthy, checkedAt: undefined }, label: '规则待验证' },
])('首页在项目开关和代理状态组合下显示 $label', async ({ enabled, whistle, label }) => {
  mockApi(enabled, whistle);
  render(<Home />);
  await screen.findByRole('heading', { name: '页面测试项目' });
  expect(within(screen.getByRole('region', { name: '项目运行状态' })).getByText(label)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: '切换到白天模式' })).toBeInTheDocument();
});

test('切换项目更新工作区和引导，不会发起配置写入', async () => {
  const user = userEvent.setup();
  const fetch = mockApi(false);
  render(<Home />);
  await screen.findByRole('heading', { name: '页面测试项目' });
  await user.click(screen.getByRole('button', { name: '另一个项目' }));
  expect(screen.getByRole('heading', { name: '另一个项目' })).toBeInTheDocument();
  expect(within(screen.getByRole('region', { name: '项目运行状态' })).getByText('尚未启用规则')).toBeInTheDocument();
  expect(screen.getByText('添加第一条 Mock，准备响应后再启用。')).toBeInTheDocument();
  for (const [, options] of fetch.mock.calls) expect(options?.method ?? 'GET').toBe('GET');
});
