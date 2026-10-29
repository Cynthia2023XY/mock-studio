import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { compileWhistleRules, renderWhistleConfig } from './whistle.mjs';

/** 验证所有接口关闭时仍能覆盖 Whistle 中此前保存的转发规则 */
test('关闭接口后生成非空的无操作规则，覆盖旧转发', () => {
  // 含一个已关闭接口的最小项目，模拟用户关闭 Mock。
  const registry = { settings: { apiPort: 17321 }, projects: [{ enabled: true, endpoints: [{ id: 'home', enabled: false, method: 'POST', url: 'http://example.test/api/home' }] }] };
  // 编译后的有效规则应为空，不能继续转发到本地服务。
  const rules = compileWhistleRules(registry);
  assert.equal(rules, '');
  // 加载生成的配置，模拟 Whistle 读取项目规则。
  const sandbox = { exports: {} };
  vm.runInNewContext(renderWhistleConfig(rules), sandbox);
  assert.equal(sandbox.exports.name, 'mock-studio-managed');
  assert.ok(sandbox.exports.rules.trim().startsWith('#'));
  assert.ok(!sandbox.exports.rules.includes('/runtime/respond/'));
});

/** 验证只生成开启接口的转发，不改变其他项目的规则 */
test('仅启用的接口生成转发规则', () => {
  // 同项目中一个接口启用，另一个已关闭。
  const registry = { settings: { apiPort: 17321 }, projects: [{ enabled: true, endpoints: [{ id: 'a', enabled: true, method: 'POST', url: 'http://example.test/a' }, { id: 'b', enabled: false, method: 'POST', url: 'http://example.test/b' }] }] };
  // 保证已关闭接口不会出现在规则正文中。
  const rules = compileWhistleRules(registry);
  assert.match(rules, /runtime\/dispatch/);
  assert.doesNotMatch(rules, /example\.test\/b/);
});


test('模糊输入仅作为字面值，生成脚本保持 ASCII 且页面 CSP 被保留', async () => {
  // 包含模板、空格和正则符号的条件不能注入 Whistle 语法。
  const registry = { settings: { apiPort: 17321 }, projects: [{ enabled: true, endpoints: [], mocks: [{ id: 'm', enabled: true, method: 'POST', match: { type: 'contains', value: '${url} ` (a+b) #' } }] }] };
  // 编译输出可被 JavaScript 安全加载，不执行输入模板。
  const rules = compileWhistleRules(registry, 'test-proxy-key');
  const sandbox = { exports: {} };
  vm.runInNewContext(renderWhistleConfig(rules), sandbox);
  assert.equal(sandbox.exports.rules, rules);
  assert.ok(rules.includes('enable://keepAllCSP'));
  // 注入资源为 ASCII，即使宿主页缺少 charset 也不会误解析中文字符串。
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(new URL('../data/generated/mock-notice.inject.js', import.meta.url), 'utf8');
  assert.ok([...source].every((character) => character.charCodeAt(0) < 128));
  assert.doesNotThrow(() => new vm.Script(source));
});
