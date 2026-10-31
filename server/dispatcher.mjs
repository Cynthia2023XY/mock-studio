import { handleCaptureRuntime } from './capture-runtime.mjs';
import { resolveCors, mergeCorsHeaders } from './cors.mjs';
import { trackDelivery } from './delivery.mjs';
import http from 'node:http';
import https from 'node:https';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mutateRegistry, withoutWrite } from './store.mjs';
import { newId, selectRuntime, StudioError } from './model.mjs';
import { matchesRequest, normalizeUrl } from './rules.mjs';

/** 仅供当前服务与托管代理规则共享的运行凭据，不复用管理令牌 */
export const proxyKey = process.env.MOCK_STUDIO_PROXY_KEY || randomBytes(32).toString('hex');

/** 按组合优先、单条数组顺序、旧接口顺序选取并在同一事务推进 */
export const dispatchSelection = (registry, url, method) => {
  for (const project of registry.projects.filter((item) => item.enabled)) {
    // 项目中至多有一个启用组合。
    const combination = (project.combinations ?? []).find((item) => item.enabled);
    if (combination) {
      // 当前步骤和等待的规则来自同一个事务快照。
      const step = combination.steps[combination.currentIndex];
      // 当前步骤允许引用自身关闭的独立规则。
      const expected = project.mocks.find((item) => item.id === step.mockId);
      if (matchesRequest(expected, url, method)) {
        // 先记录响应所处位置，再计算下一步。
        const index = combination.currentIndex;
        combination.currentIndex = index + 1 < combination.steps.length ? index + 1 : combination.afterEnd === 'loop' ? 0 : index;
        return recordSelection(registry, project, expected, expected.response, url, method, { combinationId: combination.id, stepId: step.id, sequenceIndex: index, sequenceTotal: combination.steps.length });
      }
      if (combination.steps.some((item) => matchesRequest(project.mocks.find((mock) => mock.id === item.mockId), url, method))) {
        // 顺序错误独立记账，不增加规则成功命中次数，也不推进。
        const hit = { id: newId('hit'), timestamp: new Date().toISOString(), projectId: project.id, combinationId: combination.id, outcome: 'order-mismatch', actualUrl: url, method, status: 409, expected: { stepId: step.id, mockId: expected.id, name: expected.name, method: expected.method, match: expected.match, index: combination.currentIndex } };
        registry.hits = [...(registry.hits ?? []), hit].slice(-500);
        return { error: { code: 'COMBINATION_ORDER_MISMATCH', message: `顺序不匹配，等待第 ${combination.currentIndex + 1} 步：${expected.name}`, expected: hit.expected, actual: { url, method }, hitId: hit.id } };
      }
    }
  }
  for (const project of registry.projects.filter((item) => item.enabled)) {
    // 所有同项目单条竞争均按可见数组顺序决定。
    const mock = (project.mocks ?? []).find((item) => item.enabled && matchesRequest(item, url, method));
    if (mock) return recordSelection(registry, project, mock, mock.response, url, method);
    // 旧接口保留原来的 URL 前缀及固定、顺序、状态逻辑。
    const endpoint = (project.endpoints ?? []).find((item) => item.enabled && matchesRequest({ ...item, match: { type: 'legacy', value: item.url } }, url, method));
    if (endpoint) {
      // 场景选择与状态迁移仍在注册表串行事务内完成。
      const selected = selectRuntime(project, endpoint);
      return recordSelection(registry, project, endpoint, selected.variant, url, method, { endpointId: endpoint.id, variantId: selected.variant.id, variantName: selected.variant.name, sequenceIndex: selected.index, sequenceTotal: endpoint.variants.length, stateBefore: selected.stateBefore, stateAfter: selected.stateAfter });
    }
  }
  return null;
};

/** 记录成功返回的实际请求与响应，排除认证头和请求体 */
const recordSelection = (registry, project, mock, variant, url, method, detail = {}) => {
  // 成功计数与进度、命中记录一并持久化。
  mock.stats ??= { hits: 0, lastHitAt: null };
  mock.stats.hits += 1;
  mock.stats.lastHitAt = new Date().toISOString();
  // 详情保留配置匹配值，同时单独记录实际地址。
  const hit = { id: newId('hit'), timestamp: mock.stats.lastHitAt, projectId: project.id, mockId: mock.id, method, configuredUrl: mock.match?.value ?? mock.url, actualUrl: url, variantName: mock.name, outcome: 'mock', delivery: 'selected', status: variant.status, delayMs: variant.delayMs, ...detail };
  registry.hits = [...(registry.hits ?? []), hit].slice(-500);
  return { project, mock, variant, hit };
};

/** 删除代理内部元数据和逐跳头，保证回源不泄漏运行凭据 */
const forwardHeaders = (headers) => {
  // Connection 指定的额外逐跳头也需要剔除。
  const connectionHeaders = String(headers.connection ?? '').toLowerCase().split(',').map((item) => item.trim());
  return Object.fromEntries(Object.entries(headers).filter(([name]) => !name.startsWith('x-mock-') && !name.startsWith('x-whistle-') && !['host', 'connection', 'proxy-connection', 'proxy-authorization', 'keep-alive', 'te', 'trailer', 'transfer-encoding', 'upgrade', ...connectionHeaders].includes(name)));
};

/** 在旧代理规则尚未更新时将未匹配请求直接回源并保持正文流 */
const passthrough = (request, response, url) => {
  // 本地管理服务不得成为可循环调用自身的回源目标。
  const target = new URL(url);
  if (['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname) && target.port === String(request.socket.localPort)) throw new StudioError('INVALID_UPSTREAM', '不能回源到管理服务本身');
  // 回源绕过 Whistle，避免重复进入分发器。
  const upstream = (target.protocol === 'https:' ? https : http).request(target, { method: request.method, headers: forwardHeaders(request.headers) }, (incoming) => {
    response.writeHead(incoming.statusCode, forwardHeaders(incoming.headers));
    incoming.pipe(response);
    incoming.on('error', () => response.destroy());
  });
  upstream.setTimeout(30000, () => upstream.destroy(new Error('原接口响应超时')));
  upstream.on('error', () => { if (!response.headersSent) { response.writeHead(502, { 'content-type': 'application/json' }); response.end(JSON.stringify({ code: 'UPSTREAM_UNAVAILABLE', message: '原接口不可用或响应超时' })); } else response.destroy(); });
  request.on('aborted', () => upstream.destroy());
  response.on('close', () => { if (!response.writableEnded) upstream.destroy(); });
  request.pipe(upstream);
};

/** 验证代理凭据后分发原始请求，普通客户端不能伪造分发信息 */
export const handleDispatch = async (request, response, sendMockJson) => {
  // 使用固定长度比较，不接受由 URL 查询串提供的元数据。
  const provided = Buffer.from(String(request.headers['x-mock-proxy-key'] ?? ''));
  // 按字节长度比较，避免非 ASCII 伪造头触发比较器异常。
  const expected = Buffer.from(proxyKey);
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) throw new StudioError('PROXY_UNAUTHORIZED', '请求缺少有效的代理分发凭据', 403);
  // Whistle 对完整原始 URL 编码，避免引号破坏请求头 JSON。
  let url;
  try { url = normalizeUrl(decodeURIComponent(String(request.headers['x-mock-original-url'] ?? ''))); } catch { throw new StudioError('INVALID_ORIGINAL_URL', '代理原始地址无效'); }
  if (await handleCaptureRuntime(request, response, url)) return;
  // 跨域判定与业务选择使用同一个事务快照，设置变更不能穿插其中。
  const { cors, selection } = await mutateRegistry((registry) => {
    const cors = resolveCors(registry, request, url);
    if (cors.denied || cors.preflight) return withoutWrite({ cors });
    const selection = dispatchSelection(registry, url, request.method);
    return selection ? { cors, selection } : withoutWrite({ cors, selection });
  });
  if (cors.denied) { request.resume(); return sendMockJson(response, 403, { code: 'CORS_DENIED', message: '页面来源或请求头不在允许列表内' }, cors.headers); }
  if (cors.preflight) { request.resume(); return sendMockJson(response, 204, null, cors.headers); }
  // 响应延迟与回源在事务外执行，不阻塞后续请求的状态选择。
  if (!selection) return passthrough(request, response, url);
  request.resume();
  if (selection.error) return sendMockJson(response, 409, selection.error, { ...cors.headers, 'x-mock-outcome': 'order-mismatch', 'cache-control': 'no-store' });
  // 客户端自定义跨域头可以保留，内部标记最后写入。
  const { variant, mock, project, hit } = selection;
  const failDelivery = trackDelivery(response, hit.id);
  if (variant.delayMs) await new Promise((resolve) => setTimeout(resolve, variant.delayMs));
  if (response.destroyed) return;
  try {
    sendMockJson(response, variant.status, variant.body, { ...mergeCorsHeaders(variant.headers, cors), 'access-control-expose-headers': [...new Set(['x-mock-source', 'x-mock-project', 'x-mock-endpoint', 'x-mock-variant', 'x-mock-sequence', 'x-mock-hit-id', ...String(variant.headers['access-control-expose-headers'] ?? '').split(',').map((name) => name.trim()).filter(Boolean)])].join(', '), 'cache-control': 'no-store', 'x-mock-source': 'mock-studio', 'x-mock-project': encodeURIComponent(project.name), 'x-mock-endpoint': encodeURIComponent(mock.name), 'x-mock-variant': encodeURIComponent(hit.variantName), 'x-mock-hit-id': hit.id, 'x-mock-sequence': `${(hit.sequenceIndex ?? 0) + 1}/${hit.sequenceTotal ?? 1}` });
  } catch (error) { failDelivery(); throw error; }
};
