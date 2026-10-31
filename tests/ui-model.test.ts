import { test } from 'vitest';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { describeAddress, inspectJson, jsonTokens, projectStatus } from '../lib/ui-model.mjs';

test('项目关闭、无规则、保存中、过期验证均不冒充规则可用', () => {
  const now = Date.parse('2026-10-31T12:00:00Z');
  const healthy = { connected: true, enabled: true, count: 2, pending: false, now, whistle: { ok: true, verified: true, checkedAt: new Date(now).toISOString(), desiredDigest: 'a', verifiedDigest: 'a' } };
  assert.equal(projectStatus(healthy).label, '规则可用');
  assert.equal(projectStatus({ ...healthy, enabled: false }).label, '项目已关闭');
  assert.equal(projectStatus({ ...healthy, count: 0 }).label, '尚未启用规则');
  assert.equal(projectStatus({ ...healthy, pending: true }).label, '正在保存并同步');
  assert.equal(projectStatus({ ...healthy, connected: false }).label, '本地服务未连接');
  assert.equal(projectStatus({ ...healthy, whistle: { ok: false } }).label, '规则待同步');
  for (const whistle of [{ ok: true }, { ...healthy.whistle, verified: false }, { ...healthy.whistle, verifiedDigest: 'old' }, { ...healthy.whistle, checkedAt: new Date(now - 61000).toISOString() }]) assert.equal(projectStatus({ ...healthy, whistle }).label, '规则待验证');
});

test('JSON 着色不改变文本，错误定位涵盖多行、空值和未完成内容', () => {
  for (const source of ['null', '0', 'false', '[1,2]', '{\n  "名称": "<script> & \\\"",\n  "count": -1.2e3\n}']) {
    assert.equal(inspectJson(source).valid, true);
    assert.equal(jsonTokens(source).map((token) => token.text).join(''), source);
  }
  const source = '{\n  "ok": true,\n}';
  const error = inspectJson(source);
  assert.equal(error.valid, false);
  assert.equal(error.line, 3);
  assert.equal(source[error.offset], '}');
  assert.equal(inspectJson('').valid, false);
  assert.equal(inspectJson('{\n  "a":').line, 2);
  assert.ok(jsonTokens('{"key":"value","n":42,"ok":true}').some((token) => token.kind === 'key'));
});

test('长 URL 保留关键接口名，地址中的编码和查询参数仍能完整复制', () => {
  const url = 'https://api.example.test/gw/generic/h5/m/queryHome?token=a%2Fb&x=1';
  const result = describeAddress(url);
  assert.equal(result.name, 'queryHome');
  assert.match(result.context, /token=a%2Fb&x=1$/);
  assert.equal(describeAddress('queryHome').name, 'queryHome');
  assert.equal(describeAddress('https://test/abc%ZZ').name, 'abc%ZZ');
});

test('主题启动脚本优先恢复选择，无选择时跟随系统，存储受限仍可打开页面', async () => {
  const script = await readFile(resolve('public/assets/theme-init.js'), 'utf8');
  const run = (saved: string | null, systemDark: boolean, denied = false) => {
    const calls: Array<[string, boolean]> = [];
    const root = { dataset: {} as Record<string, string>, style: {} as Record<string, string>, classList: { toggle: (name: string, enabled: boolean) => calls.push([name, enabled]) } };
    vm.runInNewContext(script, { document: { documentElement: root }, localStorage: { getItem: () => { if (denied) throw new Error('denied'); return saved; } }, window: { matchMedia: () => ({ matches: systemDark }) } });
    return { theme: root.dataset.theme, scheme: root.style.colorScheme, calls };
  };
  assert.equal(run('light', true).theme, 'light');
  assert.equal(run('dark', false).theme, 'dark');
  assert.equal(run(null, false).theme, 'light');
  assert.equal(run(null, true).theme, 'dark');
  assert.equal(run('invalid', false).theme, 'light');
  assert.equal(run(null, false, true).scheme, 'dark');
});
