import { randomUUID } from 'node:crypto';

/** 生成可稳定引用的本地资源编号 */
export const newId = (prefix) => `${prefix}-${randomUUID()}`;

/** 带稳定错误码的配置异常 */
export class StudioError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

/** 验证资源标识不会破坏管理路由或代理规则 */
export const checkId = (id) => {
  if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,120}$/.test(id)) throw new StudioError('INVALID_ID', '编号仅允许字母、数字、下划线和连字符');
};

/** 验证项目页面和接口使用的 HTTP 地址 */
export const checkUrl = (value, optional = false) => {
  if (optional && !value) return;
  try {
    // 代理规则只接受普通 HTTP 地址，避免注入规则控制字符。
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || /[\s`\\]/.test(value) || url.username || url.password) throw Error();
  } catch { throw new StudioError('INVALID_URL', '请输入有效的 HTTP 或 HTTPS 地址'); }
};

/** 校验响应场景及其可由 Node 正常发送的状态与响应头 */
export const validateVariant = (variant) => {
  checkId(variant.id);
  if (typeof variant.name !== 'string' || !variant.name.trim()) throw new StudioError('INVALID_VARIANT', '场景名称不能为空');
  if (!Number.isInteger(variant.status) || variant.status < 200 || variant.status > 599 || [204, 205, 304].includes(variant.status)) throw new StudioError('INVALID_STATUS', '状态码需为可携带 JSON 的 200–599');
  if (!Number.isFinite(variant.delayMs) || variant.delayMs < 0 || variant.delayMs > 120000) throw new StudioError('INVALID_DELAY', '延迟需在 0–120000 毫秒之间');
  if (!variant.headers || typeof variant.headers !== 'object' || Array.isArray(variant.headers)) throw new StudioError('INVALID_HEADERS', '响应头必须为对象');
  for (const [name, value] of Object.entries(variant.headers)) {
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) || typeof value !== 'string' || /[\r\n]/.test(value)) throw new StudioError('INVALID_HEADERS', '响应头名称或值无效');
  }
  if (!Object.hasOwn(variant, 'body') || variant.body === undefined) throw new StudioError('INVALID_BODY', '场景必须包含 JSON 响应体');
  return variant;
};

/** 校验接口配置和场景之间的引用关系 */
export const validateEndpoint = (endpoint) => {
  checkId(endpoint.id);
  checkUrl(endpoint.url);
  if (typeof endpoint.name !== 'string' || !endpoint.name.trim()) throw new StudioError('INVALID_ENDPOINT', '接口名称不能为空');
  if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(endpoint.method)) throw new StudioError('INVALID_METHOD', '不支持该请求方法');
  if (!['fixed', 'sequence', 'state'].includes(endpoint.mode)) throw new StudioError('INVALID_MODE', '响应模式无效');
  if (typeof endpoint.enabled !== 'boolean') throw new StudioError('INVALID_ENDPOINT', '接口开关必须为布尔值');
  if (!Array.isArray(endpoint.variants) || !endpoint.variants.length) throw new StudioError('INVALID_VARIANT', '接口至少需要一个场景');
  // 场景编号在接口内部必须唯一，避免选择和编辑指向错误场景。
  const ids = new Set();
  for (const variant of endpoint.variants) {
    validateVariant(variant);
    if (ids.has(variant.id)) throw new StudioError('DUPLICATE_ID', '场景编号重复', 409);
    ids.add(variant.id);
  }
  if (!ids.has(endpoint.activeVariantId)) throw new StudioError('INVALID_VARIANT', '固定场景不存在');
  if (!endpoint.sequence || !Number.isInteger(endpoint.sequence.currentIndex) || endpoint.sequence.currentIndex < 0 || endpoint.sequence.currentIndex >= endpoint.variants.length || !['hold-last', 'loop'].includes(endpoint.sequence.afterEnd)) throw new StudioError('INVALID_SEQUENCE', '顺序响应配置无效');
  if (endpoint.mode === 'state' && (!endpoint.stateVariants || typeof endpoint.stateVariants !== 'object' || Object.values(endpoint.stateVariants).some((id) => !ids.has(id)))) throw new StudioError('INVALID_STATE_MAPPING', '流程状态映射必须引用有效场景');
  return endpoint;
};

/** 创建一个可直接投入使用的接口默认配置 */
export const makeEndpoint = (input) => {
  // 新建接口默认关闭，避免数据准备期间拦截真实请求。
  const variant = { id: newId('response'), name: '默认响应', status: 200, delayMs: 0, headers: { 'cache-control': 'no-store' }, body: { success: true, data: {} } };
  return validateEndpoint({ id: input.id || newId('endpoint'), name: input.name || '未命名接口', method: String(input.method || 'GET').toUpperCase(), url: input.url, matchType: 'exact', enabled: input.enabled ?? false, mode: 'fixed', activeVariantId: variant.id, delayMs: 0, sequence: { currentIndex: 0, afterEnd: 'hold-last' }, stats: { hits: 0, lastHitAt: null }, updatedAt: new Date().toISOString(), variants: [variant] });
};

/** 校验流程状态定义及接口对状态的引用 */
export const validateFlow = (project) => {
  if (!project.flow) {
    if (project.endpoints.some((endpoint) => endpoint.mode === 'state')) throw new StudioError('INVALID_FLOW', '状态模式需要先配置流程');
    return;
  }
  // 流程状态是项目级共享状态，所有可引用状态必须预先声明。
  const { states, initialState, currentState, transitions = [] } = project.flow;
  if (!Array.isArray(states) || !states.length || states.some((state) => typeof state !== 'string' || !state.trim()) || new Set(states).size !== states.length || !states.includes(initialState) || !states.includes(currentState) || !Array.isArray(transitions)) throw new StudioError('INVALID_FLOW', '流程状态定义无效');
  for (const endpoint of project.endpoints) {
    if (endpoint.mode === 'state' && states.some((state) => !endpoint.stateVariants?.[state])) throw new StudioError('INVALID_STATE_MAPPING', `接口 ${endpoint.id} 缺少状态场景映射`);
    if (endpoint.mode === 'state' && Object.keys(endpoint.stateVariants).some((state) => !states.includes(state))) throw new StudioError('INVALID_STATE_MAPPING', `接口 ${endpoint.id} 包含未知状态`);
  }
  // 同一状态和命中条件只能有一个目标，避免迁移结果依赖排列顺序。
  const transitionKeys = new Set();
  for (const transition of transitions) {
    // 迁移只能引用当前项目中存在的接口与场景。
    const endpoint = project.endpoints.find((item) => item.id === transition.endpointId);
    if (!endpoint || !endpoint.variants.some((variant) => variant.id === transition.variantId) || !states.includes(transition.from) || !states.includes(transition.to)) throw new StudioError('INVALID_FLOW', '流程迁移引用了不存在的状态、接口或场景');
    // 用于判定重复规则或状态迁移的条件。
    const key = JSON.stringify([transition.from, transition.endpointId, transition.variantId]);
    if (transitionKeys.has(key)) throw new StudioError('INVALID_FLOW', '同一命中条件不能对应多个状态迁移');
    transitionKeys.add(key);
  }
};

/** 验证整个项目，保证批量导入不会写入半成品 */
export const validateProject = (project) => {
  checkId(project.id);
  if (typeof project.name !== 'string' || !project.name.trim() || typeof project.enabled !== 'boolean' || !Array.isArray(project.endpoints)) throw new StudioError('INVALID_PROJECT', '项目配置无效');
  checkUrl(project.pageUrl, true);
  // 项目内的接口编号必须唯一。
  const ids = new Set();
  for (const endpoint of project.endpoints) {
    validateEndpoint(endpoint);
    if (ids.has(endpoint.id)) throw new StudioError('DUPLICATE_ID', '接口编号重复', 409);
    ids.add(endpoint.id);
  }
  validateFlow(project);
  return project;
};

/** 在一个注册表事务中选择响应并推进项目流程 */
export const selectRuntime = (project, endpoint) => {
  // 记录请求进入时的状态以确保选择和状态迁移来自同一事务。
  const stateBefore = project.flow?.currentState ?? null;
  // 状态模式通过映射选择场景，其余模式沿用原有行为。
  const index = endpoint.mode === 'sequence' ? endpoint.sequence.currentIndex : endpoint.variants.findIndex((variant) => variant.id === (endpoint.mode === 'state' ? endpoint.stateVariants?.[stateBefore] : endpoint.activeVariantId));
  // 当前需要处理的响应场景。
  const variant = endpoint.variants[index];
  if (!variant) throw new StudioError('INVALID_VARIANT', '当前响应场景不存在');
  if (endpoint.mode === 'sequence') endpoint.sequence.currentIndex = index + 1 < endpoint.variants.length ? index + 1 : endpoint.sequence.afterEnd === 'loop' ? 0 : index;
  // 仅在当前状态、接口和场景完全匹配时迁移。
  const transition = project.flow?.transitions?.find((item) => item.from === stateBefore && item.endpointId === endpoint.id && item.variantId === variant.id);
  if (transition) project.flow.currentState = transition.to;
  return { variant, index, stateBefore, stateAfter: project.flow?.currentState ?? null };
};

/** 将场景包转成独立项目配置，所有响应数据都必须已内联 */
export const preparePackage = (pack, projectId) => {
  if (!pack || pack.version !== 1 || !Array.isArray(pack.endpoints)) throw new StudioError('INVALID_PACKAGE', '场景包版本或接口列表无效');
  // 批量导入默认关闭，激活由调用者显式决定。
  const project = { id: projectId, name: pack.name || '导入的场景包', description: pack.description || '导入的本地 Mock 项目', pageUrl: pack.pageUrl || '', enabled: false, updatedAt: new Date().toISOString(), endpoints: [] };
  for (const input of pack.endpoints) {
    // 按统一默认值补全场景包中的接口配置。
    const endpoint = makeEndpoint({ ...input, enabled: input.enabled ?? true });
    if (!Array.isArray(input.variants) || !input.variants.length) throw new StudioError('INVALID_PACKAGE', '每个接口都必须包含场景');
    endpoint.variants = input.variants.map((variant) => {
      if (Object.hasOwn(variant, 'bodyFile')) throw new StudioError('INVALID_PACKAGE', '请先将 bodyFile 解析为响应 JSON');
      return { id: variant.id || newId('response'), name: variant.name || '响应场景', status: variant.status ?? 200, delayMs: variant.delayMs ?? 0, headers: variant.headers ?? { 'cache-control': 'no-store' }, body: variant.body };
    });
    endpoint.mode = input.mode || 'fixed';
    endpoint.activeVariantId = input.activeVariantId || endpoint.variants[0].id;
    endpoint.sequence = { currentIndex: 0, afterEnd: input.sequence?.afterEnd || 'hold-last' };
    if (input.stateVariants) endpoint.stateVariants = input.stateVariants;
    project.endpoints.push(endpoint);
  }
  if (pack.flow) project.flow = { ...pack.flow, currentState: pack.flow.initialState };
  return validateProject(project);
};

/** 对项目配置生成快照比较值，排除运行中变化的计数和状态 */
export const projectFingerprint = (project) => {
  // 仅忽略运行数据，用户对配置的修改必须阻止无意覆盖。
  const copy = structuredClone(project);
  delete copy.updatedAt;
  delete copy.enabled;
  if (copy.flow) delete copy.flow.currentState;
  for (const endpoint of copy.endpoints) {
    delete endpoint.stats;
    delete endpoint.updatedAt;
    delete endpoint.sequence.currentIndex;
  }
  return JSON.stringify(copy);
};
