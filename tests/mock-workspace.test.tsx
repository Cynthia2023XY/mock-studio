import type { ComponentProps } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, test, vi } from 'vitest';
import { MockWorkspace } from '@/components/mock-workspace';

const project = { id: 'p', name: 'project', revision: 'v1', enabled: false, mocks: [{ id: 'query', name: '首页查询', enabled: true, method: 'POST', match: { type: 'contains' as const, value: 'queryHome' }, response: { status: 200, delayMs: 0, headers: {}, body: { ok: true } } }], combinations: [] };
const props = () => ({ project, proxyReady: true, search: '', hits: [], request: vi.fn(async () => ({ sync: { ok: true, message: 'ok' } })) as ComponentProps<typeof MockWorkspace>['request'], refresh: vi.fn(async () => {}), notify: vi.fn(), onGuardChange: vi.fn() });

test('项目关闭的规则明确提示未生效，并给出组合示例', () => {
  render(<MockWorkspace {...props()} />);
  expect(screen.getByText('项目已关闭')).toBeInTheDocument();
  expect(screen.queryByText('规则可用')).not.toBeInTheDocument();
  expect(screen.getByText('查询 · 返回领取前')).toBeVisible();
  expect(screen.getByText('领取 · 返回成功')).toBeVisible();
  expect(screen.getByText('再查询 · 返回领取后')).toBeVisible();
});

test('低频操作收进更多菜单，首行不能上移', async () => {
  const user = userEvent.setup();
  render(<MockWorkspace {...props()} />);
  expect(screen.queryByRole('menuitem', { name: '删除规则' })).not.toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: '更多操作：首页查询' }));
  expect(await screen.findByRole('menuitem', { name: '删除规则' })).toBeVisible();
  expect(screen.getByRole('menuitem', { name: '上移规则' })).toHaveAttribute('aria-disabled', 'true');
});

test('取消放弃修改时保留草稿，确认后才关闭编辑器', async () => {
  const user = userEvent.setup();
  const dependencies = props();
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
  render(<MockWorkspace {...dependencies} />);
  await user.click(screen.getByRole('button', { name: '编辑' }));
  const name = await screen.findByRole('textbox', { name: 'Mock 名称' });
  await user.clear(name);
  await user.type(name, '未保存的草稿');
  await waitFor(() => expect(dependencies.onGuardChange).toHaveBeenCalledWith({ dirty: true, busy: false }));
  await user.click(screen.getByRole('button', { name: '取消' }));
  expect(confirm).toHaveBeenCalled();
  expect(name).toHaveValue('未保存的草稿');
  confirm.mockReturnValue(true);
  await user.click(screen.getByRole('button', { name: '取消' }));
  await waitFor(() => expect(screen.queryByRole('dialog', { name: '编辑 Mock' })).not.toBeInTheDocument());
  expect(dependencies.request).not.toHaveBeenCalled();
});
