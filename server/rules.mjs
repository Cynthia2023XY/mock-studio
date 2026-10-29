import { StudioError, checkId, newId, validateVariant } from './model.mjs';

/** 将请求地址规范化，保留路径大小写、百分号编码及查询参数顺序 */
export const normalizeUrl = (value) => {
  if (typeof value !== 'string') throw new StudioError('INVALID_URL', '地址必须为字符串');
  // 拒绝凭据、控制字符和非网络协议，避免隐藏的匹配差异。
  let url;
  try { url = new URL(value); } catch { throw new StudioError('INVALID_URL', '精确匹配需要完整 HTTP 或 HTTPS 地址'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || Array.from(value).some((character) => character.charCodeAt(0) <= 32 || character.charCodeAt(0) === 127)) throw new StudioError('INVALID_URL', '请求地址包含无效字符或协议');
  url.hash = '';
  return url.href;
};

/** 校验单条规则并统一精确地址的协议、域名和默认端口 */
export const validateMock = (mock) => {
  if (!mock || typeof mock !== 'object') throw new StudioError('INVALID_MOCK', 'Mock 必须为对象');
  checkId(mock.id);
  if (typeof mock.name !== 'string' || !mock.name.trim() || typeof mock.enabled !== 'boolean') throw new StudioError('INVALID_MOCK', 'Mock 名称和开关无效');
  if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'].includes(mock.method)) throw new StudioError('INVALID_METHOD', '请求方法无效');
  if (!['exact', 'contains'].includes(mock.match?.type) || typeof mock.match.value !== 'string' || !mock.match.value.trim() || mock.match.value.length > 2048 || Array.from(mock.match.value).some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) throw new StudioError('INVALID_MATCH', '匹配值需为 1–2048 字符，不得含控制字符');
  if (mock.match.type === 'exact') mock.match.value = normalizeUrl(mock.match.value);
  validateVariant({ ...mock.response, id: mock.id, name: mock.name });
  // 运行响应不能覆盖内部命中标记或改变传输协议。
  if (Object.keys(mock.response.headers).some((name) => /^(x-mock-|connection$|transfer-encoding$|content-length$|content-encoding$)/i.test(name))) throw new StudioError('INVALID_HEADERS', '响应头不能覆盖 Mock 标记或传输头');
  return mock;
};

/** 为编辑器创建一个默认关闭的独立响应 */
export const makeMock = (input) => validateMock({ id: input.id || newId('mock'), name: input.name ?? '新 Mock', enabled: false, method: input.method ?? 'POST', match: input.match, response: input.response ?? { status: 200, delayMs: 0, headers: {}, body: {} }, stats: { hits: 0, lastHitAt: null } });

/** 校验组合的独立步骤编号、引用及共享进度 */
export const validateCombinations = (project) => {
  // 规则和组合编号只要求在项目内唯一。
  if (!Array.isArray(project.mocks ?? []) || !Array.isArray(project.combinations ?? [])) throw new StudioError('INVALID_PROJECT', 'Mock 与组合必须为数组');
  const mockIds = new Set();
  for (const mock of project.mocks ?? []) {
    validateMock(mock);
    if (mockIds.has(mock.id)) throw new StudioError('DUPLICATE_ID', 'Mock 编号重复', 409);
    mockIds.add(mock.id);
  }
  // 每个项目只允许一个组合开启，即使项目总开关关闭也保持明确配置。
  const combinationIds = new Set();
  if ((project.combinations ?? []).filter((item) => item?.enabled).length > 1) throw new StudioError('COMBINATION_CONFLICT', '同一项目只能启用一个高级组合', 409);
  for (const combination of project.combinations ?? []) {
    if (!combination || typeof combination !== 'object') throw new StudioError('INVALID_COMBINATION', '组合必须为对象');
    checkId(combination.id);
    if (combinationIds.has(combination.id)) throw new StudioError('DUPLICATE_ID', '组合编号重复', 409);
    combinationIds.add(combination.id);
    if (typeof combination.name !== 'string' || !combination.name.trim() || typeof combination.enabled !== 'boolean' || !Array.isArray(combination.steps) || !combination.steps.length || !['hold-last', 'loop'].includes(combination.afterEnd) || combination.onUnexpectedRequest !== 'error' || !Number.isInteger(combination.currentIndex) || combination.currentIndex < 0 || combination.currentIndex >= combination.steps.length) throw new StudioError('INVALID_COMBINATION', '组合名称、步骤、结束策略或进度无效');
    // 相同 Mock 可多次引用，每次引用需要独立步骤编号。
    const stepIds = new Set();
    for (const step of combination.steps) {
      if (!step || typeof step !== 'object') throw new StudioError('INVALID_REFERENCE', '步骤必须为对象');
      checkId(step.id);
      if (stepIds.has(step.id) || !mockIds.has(step.mockId)) throw new StudioError('INVALID_REFERENCE', '步骤编号重复或引用的 Mock 不存在');
      stepIds.add(step.id);
    }
  }
};

/** 列出组合接管、普通独立规则与兼容接口的有效匹配范围 */
export const activeRules = (project) => {
  if (!project.enabled) return [];
  // 被组合引用的 Mock 不受自身开关影响。
  const controlled = new Set((project.combinations ?? []).filter((item) => item.enabled).flatMap((item) => item.steps.map((step) => step.mockId)));
  return [...(project.mocks ?? []).filter((mock) => mock.enabled || controlled.has(mock.id)), ...(project.endpoints ?? []).filter((endpoint) => endpoint.enabled).map((endpoint) => ({ ...endpoint, match: { type: 'legacy', value: endpoint.url } }))];
};

/** 按明确的大小写和编码语义检查完整地址与请求方法 */
export const matchesRequest = (mock, url, method) => mock.method === method && (mock.match.type === 'exact' ? normalizeUrl(mock.match.value) === url : mock.match.type === 'contains' ? url.includes(mock.match.value) : url.startsWith(mock.match.value));

/** 判定跨项目规则可能重叠，模糊规则相互重叠时保守拒绝 */
export const rulesOverlap = (left, right) => {
  if (left.method !== right.method) return false;
  if (left.match.type === 'exact') return matchesRequest(right, normalizeUrl(left.match.value), left.method);
  if (right.match.type === 'exact') return matchesRequest(left, normalizeUrl(right.match.value), right.method);
  if (left.match.type === 'legacy' && right.match.type === 'legacy') return left.match.value.startsWith(right.match.value) || right.match.value.startsWith(left.match.value);
  // 两个包含条件可能出现在同一 URL 中；不依赖样本猜测互斥。
  return true;
};

/** 在启用或修改规则时阻止跨项目竞争，同时保持旧接口重复检查 */
export const checkConflicts = (registry, candidate) => {
  validateCombinations(candidate);
  // 候选项目未开启时不会接管请求。
  const rules = activeRules(candidate);
  for (const other of registry.projects.filter((item) => item.id !== candidate.id)) {
    for (const left of rules) for (const right of activeRules(other)) {
      if (rulesOverlap(left, right)) throw new StudioError('RULE_CONFLICT', `项目「${candidate.name}」的「${left.name}」与「${other.name} / ${right.name}」匹配范围重叠`, 409);
    }
  }
  // 兼容旧 CLI 对同项目重复地址的报错行为。
  const legacyKeys = new Set();
  for (const endpoint of (candidate.endpoints ?? []).filter((item) => candidate.enabled && item.enabled)) {
    // 原版接口以方法和配置地址区分。
    const key = `${endpoint.method} ${endpoint.url}`;
    if (legacyKeys.has(key)) throw new StudioError('RULE_CONFLICT', `启用的旧版接口重复：${key}`, 409);
    legacyKeys.add(key);
  }
};
