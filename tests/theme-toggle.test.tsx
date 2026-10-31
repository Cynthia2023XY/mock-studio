import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, test, vi } from 'vitest';
import { ThemeToggle } from '@/components/theme-toggle';

test('主题切换同时更新页面、按钮和持久化选择', async () => {
  const user = userEvent.setup();
  render(<ThemeToggle />);
  await user.click(screen.getByRole('button', { name: '切换到白天模式' }));
  expect(document.documentElement).toHaveAttribute('data-theme', 'light');
  expect(document.documentElement).not.toHaveClass('dark');
  expect(localStorage.getItem('mock-studio-theme')).toBe('light');
  await user.click(screen.getByRole('button', { name: '切换到黑夜模式' }));
  expect(document.documentElement).toHaveClass('dark');
  expect(localStorage.getItem('mock-studio-theme')).toBe('dark');
});

test('读取启动脚本恢复的主题，并响应其他窗口的主题变化', () => {
  document.documentElement.dataset.theme = 'light';
  render(<ThemeToggle />);
  expect(screen.getByRole('button', { name: '切换到黑夜模式' })).toBeInTheDocument();
  fireEvent(window, new StorageEvent('storage', { key: 'mock-studio-theme', newValue: 'dark' }));
  expect(screen.getByRole('button', { name: '切换到白天模式' })).toBeInTheDocument();
  expect(document.documentElement.style.colorScheme).toBe('dark');
});

test('存储受限时仍可在当前页面切换主题', async () => {
  const user = userEvent.setup();
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('Storage denied'); });
  render(<ThemeToggle />);
  await user.click(screen.getByRole('button', { name: '切换到白天模式' }));
  expect(document.documentElement).toHaveAttribute('data-theme', 'light');
  expect(screen.getByRole('button', { name: '切换到黑夜模式' })).toBeInTheDocument();
});
