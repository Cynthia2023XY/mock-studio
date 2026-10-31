import { useState } from 'react';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, test } from 'vitest';
import { JsonEditor } from '@/components/json-editor';

function Editor({ initial = '{"ok":true}', disabled = false }) {
  const [value, setValue] = useState(initial);
  return <JsonEditor label="响应 JSON" value={value} onChange={setValue} disabled={disabled} />;
}

test('错误提示包含行列，定位按钮将焦点和选择移动到出错字符', async () => {
  const user = userEvent.setup();
  render(<Editor />);
  const input = screen.getByRole('textbox', { name: '响应 JSON' }) as HTMLTextAreaElement;
  await user.clear(input);
  await user.paste('{\n  "ok": true,\n}');
  expect(input).toHaveAttribute('aria-invalid', 'true');
  expect(screen.getByText(/第 3 行，第 1 列/)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: '格式化' })).toBeDisabled();
  await user.click(screen.getByRole('button', { name: '定位错误' }));
  expect(input).toHaveFocus();
  expect(input.selectionStart).toBe(input.value.lastIndexOf('}'));
});

test('全屏中编辑和格式化保留到草稿，Escape 仅退出全屏', async () => {
  const user = userEvent.setup();
  render(<Editor />);
  await user.click(screen.getByRole('button', { name: '全屏编辑响应 JSON' }));
  const dialog = await screen.findByRole('dialog', { name: '响应 JSON · 全屏编辑' });
  const input = within(dialog).getByRole('textbox', { name: '响应 JSON（全屏）' });
  await waitFor(() => expect(input).toHaveFocus());
  await user.clear(input);
  await user.paste('{"value":42,"name":"中文"}');
  await user.click(within(dialog).getByRole('button', { name: '格式化 JSON' }));
  expect(input).toHaveValue('{\n  "value": 42,\n  "name": "中文"\n}');
  await user.keyboard('{Escape}');
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  expect(screen.getByRole('textbox', { name: '响应 JSON' })).toHaveValue('{\n  "value": 42,\n  "name": "中文"\n}');
});

test('着色层只显示文本，不执行用户 JSON 中的 HTML', () => {
  const { container } = render(<Editor initial={'{"html":"<img src=x onerror=alert(1)>","n":42}'} />);
  expect(container.querySelector('img')).toBeNull();
  expect(container.querySelector('.json-highlight')?.textContent).toContain('<img src=x onerror=alert(1)>');
  expect(container.querySelector('.json-token-number')).toHaveTextContent('42');
});

test('禁用编辑时不允许输入、格式化或打开全屏', () => {
  render(<Editor disabled />);
  expect(screen.getByRole('textbox')).toBeDisabled();
  expect(screen.getByRole('button', { name: '格式化' })).toBeDisabled();
  expect(screen.getByRole('button', { name: '全屏编辑响应 JSON' })).toBeDisabled();
});

test('Tab 插入缩进，Shift+Tab 允许离开编辑区', async () => {
  const user = userEvent.setup();
  render(<Editor initial="{}" />);
  const input = screen.getByRole('textbox', { name: '响应 JSON' }) as HTMLTextAreaElement;
  await user.click(input);
  input.setSelectionRange(2, 2);
  await user.keyboard('{Tab}');
  expect(input).toHaveValue('{}  ');
  await waitFor(() => expect(input.selectionStart).toBe(4));
  await user.keyboard('{Shift>}{Tab}{/Shift}');
  expect(input).not.toHaveFocus();
});
