import test from 'node:test';
import assert from 'node:assert/strict';
import { makeEndpoint, preparePackage, projectFingerprint, selectRuntime, validateEndpoint, validateProject, validateVariant } from './model.mjs';

/** 生成可复用的固定响应接口配置 */
const createEndpoint = () => makeEndpoint({ id: 'query', name: '查询', method: 'POST', url: 'http://example.test/query' });

/** 判断操作是否按约定返回指定业务错误码 */
const hasCode = (code) => (error) => error?.code === code;

/** 生成包含两种业务状态与响应映射的项目 */
const createFlowProject = () => {
  // 为查询接口设置领取前后的固定业务数据。
  const endpoint = createEndpoint();
  endpoint.variants = [
    { id: 'before', name: '领取前', status: 200, delayMs: 0, headers: {}, body: { phase: 'before' } },
    { id: 'after', name: '领取后', status: 200, delayMs: 0, headers: {}, body: { phase: 'after' } },
  ];
  endpoint.activeVariantId = 'before';
  endpoint.mode = 'state';
  endpoint.stateVariants = { before: 'before', after: 'after' };
  // 状态迁移引用当前接口的特定场景。
  const project = { id: 'p', name: '测试项目', enabled: true, endpoints: [endpoint], flow: { states: ['before', 'after'], initialState: 'before', currentState: 'before', transitions: [{ from: 'before', to: 'after', endpointId: 'query', variantId: 'before' }] } };
  return { project, endpoint };
};

test('新接口默认关闭且响应场景引用有效', () => {
  // 新接口不应在数据准备期间拦截请求。
  const endpoint = createEndpoint();
  assert.equal(endpoint.enabled, false);
  assert.equal(endpoint.activeVariantId, endpoint.variants[0].id);
  assert.equal(validateEndpoint(endpoint), endpoint);
});

test('接口方法、网址和场景编号必须有效', () => {
  // 无效配置应在进入运行期之前返回稳定错误码。
  const endpoint = createEndpoint();
  assert.throws(() => validateEndpoint({ ...endpoint, method: 'TRACE' }), hasCode('INVALID_METHOD'));
  assert.throws(() => validateEndpoint({ ...endpoint, url: 'javascript:alert(1)' }), hasCode('INVALID_URL'));
  assert.throws(() => validateEndpoint({ ...endpoint, activeVariantId: 'missing' }), hasCode('INVALID_VARIANT'));
  assert.throws(() => validateEndpoint({ ...endpoint, variants: [...endpoint.variants, endpoint.variants[0]] }), hasCode('DUPLICATE_ID'));
});

test('响应场景拒绝无效状态码、延迟和危险响应头', () => {
  // 有效场景提供其余必填字段，逐一检查错误边界。
  const variant = createEndpoint().variants[0];
  for (const status of [199, 204, 304, 600]) assert.throws(() => validateVariant({ ...variant, status }), hasCode('INVALID_STATUS'));
  for (const delayMs of [-1, 120001, NaN]) assert.throws(() => validateVariant({ ...variant, delayMs }), hasCode('INVALID_DELAY'));
  assert.throws(() => validateVariant({ ...variant, headers: { 'x-test': 'x\r\ny' } }), hasCode('INVALID_HEADERS'));
  assert.throws(() => validateVariant({ ...variant, body: undefined }), hasCode('INVALID_BODY'));
  assert.equal(validateVariant({ ...variant, body: null }).body, null);
});

test('顺序响应按命中推进并在末尾停留或循环', () => {
  // 按序返回两个场景，末尾策略在同一接口上切换。
  const endpoint = createEndpoint();
  endpoint.variants.push({ ...endpoint.variants[0], id: 'second', name: '第二次' });
  endpoint.mode = 'sequence';
  // 用于验证状态或导入配置的项目。
  const project = { endpoints: [endpoint] };
  assert.equal(selectRuntime(project, endpoint).index, 0);
  assert.equal(selectRuntime(project, endpoint).index, 1);
  assert.equal(selectRuntime(project, endpoint).index, 1);
  endpoint.sequence.afterEnd = 'loop';
  assert.equal(selectRuntime(project, endpoint).index, 1);
  assert.equal(selectRuntime(project, endpoint).index, 0);
});

test('流程依据当前状态返回响应并仅在命中迁移条件时切换', () => {
  // 模拟首次命中领取前场景推动状态迁移。
  const { project, endpoint } = createFlowProject();
  validateProject(project);
  // 首次响应或创建的默认场景编号。
  const first = selectRuntime(project, endpoint);
  assert.equal(first.variant.id, 'before');
  assert.equal(first.stateBefore, 'before');
  assert.equal(first.stateAfter, 'after');
  // 状态切换后的下一次响应。
  const second = selectRuntime(project, endpoint);
  assert.equal(second.variant.id, 'after');
  assert.equal(second.stateAfter, 'after');
});

test('流程校验拒绝缺失映射、未知状态和重复迁移', () => {
  // 修改独立样本，避免错误场景之间相互污染。
  const { project } = createFlowProject();
  // 缺少必要配置的测试样本。
  const missing = structuredClone(project);
  delete missing.endpoints[0].stateVariants.after;
  assert.throws(() => validateProject(missing), hasCode('INVALID_STATE_MAPPING'));
  // 未知状态或命令的测试样本。
  const unknown = structuredClone(project);
  unknown.flow.transitions[0].to = 'unknown';
  assert.throws(() => validateProject(unknown), hasCode('INVALID_FLOW'));
  // 包含重复配置的测试样本。
  const duplicate = structuredClone(project);
  duplicate.flow.transitions.push({ ...duplicate.flow.transitions[0] });
  assert.throws(() => validateProject(duplicate), hasCode('INVALID_FLOW'));
});

test('场景包导入初始化状态并拒绝未解析文件', () => {
  // 场景包中的业务状态由初始状态决定，不沿用历史运行位置。
  const pack = { version: 1, name: '流程包', endpoints: [{ id: 'a', name: '接口', url: 'http://example.test/a', variants: [{ id: 'v', name: '响应', body: {} }] }], flow: { states: ['init'], initialState: 'init', currentState: 'stale', transitions: [] } };
  // 用于验证状态或导入配置的项目。
  const project = preparePackage(pack, 'project');
  assert.equal(project.enabled, false);
  assert.equal(project.flow.currentState, 'init');
  // 尚未解析本地响应文件的场景包。
  const unresolved = structuredClone(pack);
  unresolved.endpoints[0].variants[0].bodyFile = '../x.json';
  assert.throws(() => preparePackage(unresolved, 'project'), hasCode('INVALID_PACKAGE'));
});

test('恢复指纹忽略运行统计但识别响应配置修改', () => {
  // 运行过程中的状态和计数不应阻止恢复，响应修改则应阻止。
  const { project } = createFlowProject();
  // 未变更时的项目配置指纹。
  const baseline = projectFingerprint(project);
  // 仅修改运行态数据的项目副本。
  const runtime = structuredClone(project);
  runtime.enabled = false;
  runtime.flow.currentState = 'after';
  runtime.endpoints[0].stats.hits = 3;
  assert.equal(projectFingerprint(runtime), baseline);
  runtime.endpoints[0].variants[0].body.phase = 'edited';
  assert.notEqual(projectFingerprint(runtime), baseline);
});
