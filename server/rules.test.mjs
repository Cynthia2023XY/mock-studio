import test from 'node:test';
import assert from 'node:assert/strict';
import { makeMock, normalizeUrl, matchesRequest } from './rules.mjs';
import { dispatchSelection } from './dispatcher.mjs';

/** 生成带业务标识的独立响应样本 */
const mock = (id, value = 'query', type = 'contains') => makeMock({ id, name: id, method: 'POST', match: { type, value }, response: { status: 200, delayMs: 0, headers: {}, body: { id } } });

/** 构建同 URL 三个响应的严格顺序组合 */
const scenario = () => ({ projects: [{ id: 'p', enabled: true, name: 'p', endpoints: [], mocks: [mock('one'), mock('two'), mock('three')], combinations: [{ id: 'c', enabled: true, steps: [{ id: 's1', mockId: 'one' }, { id: 's2', mockId: 'two' }, { id: 's3', mockId: 'three' }], currentIndex: 0, afterEnd: 'hold-last' }] }] });

test('完整 URL 规范化保留路径、编码及参数顺序，方法必须一致', () => {
  assert.equal(normalizeUrl('HTTP://EXAMPLE.TEST:80/Path?a=%2f&b=2#hash'), 'http://example.test/Path?a=%2f&b=2');
  // 精确规则中的域名、默认端口按同一规则标准化。
  const rule = mock('m', 'http://EXAMPLE.TEST:80/Path?a=%2f&b=2', 'exact');
  assert.ok(matchesRequest(rule, normalizeUrl('http://example.test/Path?a=%2f&b=2'), 'POST'));
  for (const url of ['http://example.test/path?a=%2f&b=2', 'http://example.test/Path?b=2&a=%2f', 'http://example.test/Path?a=%2F&b=2']) assert.equal(matchesRequest(rule, url, 'POST'), false);
  assert.equal(matchesRequest(rule, rule.match.value, 'GET'), false);
  assert.throws(() => mock('bad', 'a\nb'), { code: 'INVALID_MATCH' });
  assert.throws(() => mock('bad', 'a'.repeat(2049)), { code: 'INVALID_MATCH' });
});

test('同 URL 三响应由当前步骤决定，末尾停留与循环、重复引用独立推进', () => {
  // 各引用自身关闭，组合仍可使用。
  const registry = scenario();
  assert.deepEqual([1, 2, 3, 4].map(() => dispatchSelection(registry, 'http://test/query', 'POST').variant.body.id), ['one', 'two', 'three', 'three']);
  registry.projects[0].combinations[0].afterEnd = 'loop';
  dispatchSelection(registry, 'http://test/query', 'POST');
  assert.equal(dispatchSelection(registry, 'http://test/query', 'POST').variant.body.id, 'one');
  registry.projects[0].combinations[0].steps[1].mockId = 'one';
  assert.equal(dispatchSelection(registry, 'http://test/query', 'POST').hit.stepId, 's2');
});

test('跨接口意外请求返回稳定调试错误，不推进或冒充成功命中', () => {
  // 第二个步骤使用另一接口。
  const registry = scenario();
  registry.projects[0].mocks[1].match.value = 'receive';
  // 初始步骤收到领取请求，必须拒绝。
  const unexpected = dispatchSelection(registry, 'http://test/receive', 'POST');
  assert.equal(unexpected.error.code, 'COMBINATION_ORDER_MISMATCH');
  assert.equal(registry.projects[0].combinations[0].currentIndex, 0);
  assert.equal(registry.hits[0].outcome, 'order-mismatch');
  assert.equal(registry.projects[0].mocks[1].stats.hits, 0);
  assert.equal(dispatchSelection(registry, 'http://test/unrelated', 'POST'), null);
  dispatchSelection(registry, 'http://test/query', 'POST');
  dispatchSelection(registry, 'http://test/receive', 'POST');
  assert.equal(dispatchSelection(registry, 'http://test/query', 'POST').variant.body.id, 'three');
});
