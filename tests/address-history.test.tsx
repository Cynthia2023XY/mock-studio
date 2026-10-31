import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, test, vi } from 'vitest';
import { RequestAddress } from '@/components/request-address';
import { HitHistory } from '@/components/hit-history';

test('地址突出接口名，复制保留完整 URL 和查询参数', async () => {
  const user = userEvent.setup();
  const url = 'https://api.example.test/gw/generic/queryHome?x=a%2Fb&y=2';
  const write = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue();
  const notify = vi.fn();
  render(<RequestAddress value={url} notify={notify} />);
  expect(screen.getByText('queryHome')).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: '复制完整地址' }));
  expect(write).toHaveBeenCalledWith(url);
  expect(notify).toHaveBeenCalledWith('完整地址已复制');
  expect(screen.getByRole('button', { name: '完整地址已复制' })).toBeInTheDocument();
});

test('剪贴板失败时提示手动复制，不显示成功', async () => {
  const user = userEvent.setup();
  vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValue(new Error('denied'));
  const notify = vi.fn();
  render(<RequestAddress value="queryHome" notify={notify} />);
  await user.click(screen.getByRole('button', { name: '复制完整地址' }));
  expect(notify).toHaveBeenCalledWith('复制失败，请手动选择并复制内容');
  expect(screen.queryByRole('button', { name: '完整地址已复制' })).not.toBeInTheDocument();
});

test('命中详情按需展开，提供原始请求、场景和命中编号', async () => {
  const user = userEvent.setup();
  render(<HitHistory notify={vi.fn()} hits={[{ id: 'hit-1', timestamp: '2026-10-31T12:00:00Z', method: 'POST', actualUrl: 'https://test/queryHome', configuredUrl: 'queryHome', status: 200, variantName: '领取前', delivery: 'finished' }]} />);
  expect(screen.getByText('命中编号')).not.toBeVisible();
  await user.click(screen.getByText('queryHome', { selector: 'summary span' }));
  expect(screen.getByText('命中编号')).toBeVisible();
  expect(screen.getByText('POST https://test/queryHome')).toBeVisible();
  expect(screen.getByRole('button', { name: '复制命中编号' })).toBeVisible();
});
