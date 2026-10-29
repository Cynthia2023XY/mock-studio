import test from 'node:test';
import assert from 'node:assert/strict';
import { getNextSequenceIndex, selectVariant } from './store.mjs';

/** 用于验证顺序响应的最小接口样本 */
const endpoint = {
  mode: 'sequence',
  activeVariantId: 'second',
  variants: [{ id: 'first' }, { id: 'second' }, { id: 'third' }],
  sequence: { currentIndex: 0, afterEnd: 'hold-last' },
};

test('顺序模式按当前下标选择响应', () => {
  assert.equal(selectVariant(endpoint).id, 'first');
  endpoint.sequence.currentIndex = 1;
  assert.equal(selectVariant(endpoint).id, 'second');
});

test('顺序结束后支持停留或循环', () => {
  endpoint.sequence.currentIndex = 2;
  endpoint.sequence.afterEnd = 'hold-last';
  assert.equal(getNextSequenceIndex(endpoint), 2);
  endpoint.sequence.afterEnd = 'loop';
  assert.equal(getNextSequenceIndex(endpoint), 0);
});
