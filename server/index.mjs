import { handleCaptureApi } from './capture-api.mjs';
import { resolveCors, mergeCorsHeaders } from './cors.mjs';
import { trackDelivery } from './delivery.mjs';
import { handleV2Api } from './v2-api.mjs';
import { checkConflicts } from './rules.mjs';
import { handleDispatch } from './dispatcher.mjs';
import http from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { findEndpoint, getNextSequenceIndex, mutateRegistry, readRegistry, withRevision, withoutWrite } from './store.mjs';
import { syncWhistleRules, compileWhistleRules } from './whistle.mjs';
import { makeEndpoint, newId, preparePackage, projectFingerprint, selectRuntime, StudioError, validateEndpoint, validateProject, validateVariant } from './model.mjs';

/** 本地 API 监听地址 */
const host = '127.0.0.1';

/** 本机管理接口访问令牌文件 */
const tokenPath = process.env.MOCK_STUDIO_TOKEN_PATH ?? path.join(homedir(), '.mock-studio', 'api-token');
/** 服务启动时读取或创建的本机管理令牌 */
const managementToken = await (async () => {
  await mkdir(path.dirname(tokenPath), { recursive: true, mode: 0o700 });
  try { return (await readFile(tokenPath, 'utf8')).trim(); } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    // 本机管理接口的访问凭据。
    const token = randomBytes(32).toString('hex');
    await writeFile(tokenPath, token, { mode: 0o600, flag: 'wx' });
    return token;
  }
})();

/** 发送 JSON，不改写业务 Mock 配置的响应体 */
const sendMockJson = (response, statusCode, body, extraHeaders = {}) => {
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    ...extraHeaders,
  });
  response.end(JSON.stringify(body));
};

/** 管理及分发诊断错误保留稳定错误码，业务响应不使用该封装 */
const sendJson = (response, statusCode, body, extraHeaders = {}) => {
  const payload = statusCode >= 400 && body && typeof body === 'object' && !body.code ? { ...body, code: `HTTP_${statusCode}` } : body;
  sendMockJson(response, statusCode, payload, { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET,POST,PATCH,PUT,DELETE,HEAD,OPTIONS', 'access-control-allow-headers': 'content-type, x-mock-token, if-match', ...extraHeaders });
};

/** 读取并解析请求 JSON，空请求体按空对象处理 */
const readJsonBody = async (request) => {
  /** 请求体数据块集合 */
  const chunks = [];
  // 限制配置请求体，避免错误文件耗尽本地服务内存。
  let size = 0;
  for await (const chunk of request) { size += chunk.length; if (size > 10 * 1024 * 1024) throw new StudioError('PAYLOAD_TOO_LARGE', '配置 JSON 不能超过 10MB', 413); chunks.push(chunk); }
  /** 合并后的请求体文本 */
  const bodyText = Buffer.concat(chunks).toString('utf8').trim();
  return bodyText ? JSON.parse(bodyText) : {};
};

/** 从路径中提取指定位置的资源编号 */
const getPathPart = (pathname, index) => pathname.split('/').filter(Boolean)[index];

/** 按调用顺序串行同步代理规则，避免旧配置覆盖新配置 */
let syncQueue = Promise.resolve();

/** 将尚未开始的同步合并；调用方等待包含本次变更的最新一轮结果 */
let pendingSync = null;
let syncActive = false;
const syncAndRecord = (options = {}) => {
  if (pendingSync) {
    pendingSync.options.force ||= Boolean(options.force);
    pendingSync.options.verify ||= Boolean(options.verify);
    return pendingSync.promise;
  }
  const batch = { options: { ...options }, promise: null };
  pendingSync = batch;
  syncQueue = syncQueue.catch(() => {}).then(async () => {
    pendingSync = null;
    syncActive = true;
    try {
      const registry = await readRegistry();
      const result = await syncWhistleRules(registry, batch.options).catch((error) => ({ ok: false, verified: false, checkedAt: new Date().toISOString(), message: `配置已保存，Whistle 同步失败：${error.message}`, ruleCount: 0 }));
      await mutateRegistry((nextRegistry) => {
        const previous = nextRegistry.runtime.whistle;
        const desiredDigest = result.digest ? createHash('sha256').update(compileWhistleRules(nextRegistry)).digest('hex') : null;
        const current = !result.digest || result.digest === desiredDigest;
        nextRegistry.runtime.whistle = {
          ...result,
          ok: result.ok && current,
          verified: Boolean(result.verified && current),
          desiredDigest,
          verifiedDigest: result.ok ? result.digest ?? null : previous?.verifiedDigest ?? null,
          message: current ? result.message : '配置已更新，等待下一轮代理同步',
          syncedAt: result.skipped ? previous?.syncedAt ?? null : new Date().toISOString(),
          lastSuccessAt: result.ok ? result.checkedAt ?? new Date().toISOString() : previous?.lastSuccessAt ?? null,
        };
      });
      return result;
    } finally { syncActive = false; }
  });
  batch.promise = syncQueue;
  return batch.promise;
};

/** 防止两个启用规则同时匹配同一完整地址与方法 */
const checkRuleConflicts = checkConflicts;

/** 处理被 Whistle 转发过来的真实 Mock 请求 */
const handleRuntimeResponse = async (endpointId, request, response) => {
  /** 本次运行态命中的响应信息 */
  const selection = await mutateRegistry((registry) => {
    /** 接口及所属项目定位结果 */
    const match = findEndpoint(registry, endpointId);
    if (!match || !match.project.enabled || !match.endpoint.enabled) return withoutWrite(null);
    const cors = resolveCors(registry, { method: match.endpoint.method, headers: request.headers }, match.endpoint.url);
    if (cors.denied) return withoutWrite({ denied: true, cors });
    /** 本次应使用的场景 */
    const selected = selectRuntime(match.project, match.endpoint);
    /** 响应发出前的顺序位置 */
    const sequenceIndex = selected.index;
    match.endpoint.stats.hits += 1;
    match.endpoint.stats.lastHitAt = new Date().toISOString();
    // 命中记录不保存请求体、Cookie 或认证信息。
    const hit = { id: newId('hit'), delivery: 'selected', timestamp: match.endpoint.stats.lastHitAt, projectId: match.project.id, endpointId, method: request.method, configuredUrl: match.endpoint.url, variantId: selected.variant.id, variantName: selected.variant.name, status: selected.variant.status, delayMs: selected.variant.delayMs, sequenceIndex, stateBefore: selected.stateBefore, stateAfter: selected.stateAfter };
    registry.hits = [...(registry.hits ?? []), hit].slice(-500);
    return { endpoint: match.endpoint, project: match.project, variant: selected.variant, sequenceIndex, hitId: hit.id, cors };
  });
  if (!selection) {
    sendJson(response, 404, { success: false, message: 'Mock 接口未启用或不存在' });
    return;
  }
  if (selection.denied) return sendMockJson(response, 403, { code: 'CORS_DENIED', message: '页面来源不在允许列表内' }, selection.cors.headers);
  /** 响应场景配置的延迟时间 */
  const delayMs = Math.max(0, Number(selection.variant.delayMs ?? selection.endpoint.delayMs ?? 0));
  const failDelivery = trackDelivery(response, selection.hitId);
  if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
  if (response.destroyed) return;
  try {
    sendMockJson(response, selection.variant.status, selection.variant.body, {
    ...mergeCorsHeaders(selection.variant.headers, selection.cors),
    'access-control-expose-headers': 'x-mock-source, x-mock-project, x-mock-endpoint, x-mock-variant, x-mock-sequence, x-mock-hit-id',
    'x-mock-source': 'mock-studio',
    'x-mock-project': encodeURIComponent(selection.project.name),
    'x-mock-endpoint': encodeURIComponent(selection.endpoint.name),
    'x-mock-hit-id': selection.hitId,
    'x-mock-variant': encodeURIComponent(selection.variant.name),
    'x-mock-sequence': `${selection.sequenceIndex + 1}/${selection.endpoint.variants.length}`,
  });
  } catch (error) { failDelivery(); throw error; }
};

/** 处理 Mock Studio 的管理 API 请求 */
const handleRequest = async (request, response) => {
  /** 解析后的请求地址 */
  const requestUrl = new URL(request.url ?? '/', `http://${host}`);
  /** 当前请求路径 */
  const pathname = requestUrl.pathname;
  // 管理接口只接受本机控制台来源或没有浏览器 Origin 的本地客户端。
  if (pathname.startsWith('/api/')) {
    // 浏览器请求的来源。
    const origin = request.headers.origin;
    if (origin && origin !== 'http://127.0.0.1:3000' && origin !== 'http://localhost:3000') return sendJson(response, 403, { code: 'ORIGIN_DENIED', message: '管理接口不允许该页面来源' });
    if (![`${host}:${registry.settings.apiPort}`, `localhost:${registry.settings.apiPort}`].includes(request.headers.host)) return sendJson(response, 403, { code: 'HOST_DENIED', message: '管理接口仅支持本机地址' });
    if (pathname === '/api/token' && request.method === 'GET' && origin) return sendJson(response, 200, { token: managementToken });
    if (request.method !== 'OPTIONS' && request.headers['x-mock-token'] !== managementToken) return sendJson(response, 401, { code: 'UNAUTHORIZED', message: '缺少或无效的本机管理令牌' });
  }
  if (pathname === '/runtime/dispatch') return handleDispatch(request, response, sendMockJson);
  // 管理预检先返回，避免被资源变更路由误当成配置操作。
  if (request.method === 'OPTIONS') return sendJson(response, 204, null);
  if (await handleCaptureApi(request, response, pathname, { readJsonBody, sendJson, syncAndRecord })) return;
  if (await handleV2Api(request, response, pathname, { readJsonBody, sendJson, syncAndRecord })) return;
  // 迁移后旧 CLI 明确报错，避免无效操作被显示为成功。
  if (pathname.startsWith('/api/endpoints/')) {
    // 原始接口到独立规则的映射保存在项目中。
    const state = await readRegistry();
    if (!findEndpoint(state, getPathPart(pathname, 2)) && state.projects.some((project) => project.migration?.[getPathPart(pathname, 2)])) throw new StudioError('MIGRATED_ENDPOINT', '旧接口已迁移，请使用 mock-* 或 combination-* 命令及项目编号', 410);
  }
  if (request.method === 'GET' && pathname === '/api/state') {
    sendJson(response, 200, await readRegistry());
    return;
  }
  if (request.method === 'GET' && pathname === '/api/hits') {
    // 按项目和接口过滤最近命中，默认最多返回 100 条。
    const registry = await readRegistry();
    // 允许返回的最大记录数。
    const limit = Math.min(500, Math.max(1, Number(requestUrl.searchParams.get('limit')) || 100));
    // 按筛选条件整理的命中记录。
    const hits = (registry.hits ?? []).filter((hit) => (!requestUrl.searchParams.get('projectId') || hit.projectId === requestUrl.searchParams.get('projectId')) && (!requestUrl.searchParams.get('endpointId') || hit.endpointId === requestUrl.searchParams.get('endpointId'))).slice(-limit).reverse();
    return sendJson(response, 200, { hits });
  }
  if (request.method === 'POST' && pathname === '/api/whistle/sync') {
    sendJson(response, 200, await syncAndRecord({ force: true }));
    return;
  }
  if (request.method === 'POST' && pathname === '/api/whistle/check') {
    sendJson(response, 200, await syncAndRecord({ verify: true }));
    return;
  }
  if (request.method === 'POST' && ['/api/packages/preview', '/api/packages/apply'].includes(pathname)) {
    // 预览与应用使用同一校验逻辑，避免预览通过但应用数据不同。
    const payload = await readJsonBody(request);
    // 目标项目的稳定编号。
    const projectId = payload.projectId || newId('project');
    // 待检查或更新的项目配置。
    const project = preparePackage(payload.package, projectId);
    // 当前操作是否实际应用场景包。
    const apply = pathname.endsWith('/apply');
    // 预览和应用共用的场景包校验流程。
    const prepare = (registry) => {
      // 已有的目标项目。
      const existing = registry.projects.find((item) => item.id === projectId);
      if (existing && payload.mode !== 'replace') throw new StudioError('PROJECT_EXISTS', '项目已存在，请明确选择替换', 409);
      // 已被其他项目使用的接口编号按目标项目稳定映射，保留流程引用。
      const remappedIds = {};
      for (const endpoint of project.endpoints) {
        // 其他项目中占用该接口编号的配置。
        const duplicate = findEndpoint(registry, endpoint.id);
        if (duplicate && duplicate.project.id !== projectId) {
          // 重映射之前的接口编号。
          const original = endpoint.id;
          endpoint.id = `endpoint-${createHash('sha256').update(`${projectId}:${original}`).digest('hex').slice(0, 24)}`;
          remappedIds[original] = endpoint.id;
          if (findEndpoint(registry, endpoint.id)) throw new StudioError('DUPLICATE_ID', '生成的接口编号已存在', 409);
        }
      }
      // 新版场景包对占用编号做稳定映射，并同步修正每个组合步骤。
      for (const mock of project.mocks ?? []) {
        if (registry.projects.some((item) => item.id !== projectId && (item.mocks ?? []).some((entry) => entry.id === mock.id))) {
          // 相同包导入到另一个项目时不会与原引用混淆。
          const original = mock.id;
          mock.id = `mock-${createHash('sha256').update(`${projectId}:${original}`).digest('hex').slice(0, 24)}`;
          remappedIds[original] = mock.id;
        }
      }
      for (const combination of project.combinations ?? []) for (const step of combination.steps) step.mockId = remappedIds[step.mockId] ?? step.mockId;
      for (const transition of project.flow?.transitions ?? []) transition.endpointId = remappedIds[transition.endpointId] ?? transition.endpointId;
      validateProject(project);
      if (!apply) return { valid: true, project, remappedIds, replacesExisting: Boolean(existing) };
      // 保存受影响项目的配置快照，并标记应用后的配置供恢复冲突检测。
      const snapshot = { id: newId('snapshot'), projectId, previous: existing ? structuredClone(existing) : null, fingerprint: projectFingerprint(project) };
      registry.snapshots = [...(registry.snapshots ?? []), snapshot].slice(-20);
      if (payload.package.version === 2) registry.schemaVersion = 2;
      if (existing) registry.projects[registry.projects.indexOf(existing)] = project;
      else registry.projects.push(project);
      return { project, remappedIds, snapshotId: snapshot.id };
    };
    // 本次管理操作的执行结果。
    const result = apply ? await mutateRegistry(prepare) : prepare(await readRegistry());
    if (apply) result.sync = await syncAndRecord();
    return sendJson(response, 200, result);
  }
  if (request.method === 'POST' && pathname === '/api/packages/restore') {
    // 恢复前检查配置是否被再次修改，避免覆盖用户后续工作。
    const payload = await readJsonBody(request);
    // 本次管理操作的执行结果。
    const result = await mutateRegistry((registry) => {
      // 可恢复导入前项目的配置快照。
      const snapshot = (registry.snapshots ?? []).find((item) => item.id === payload.snapshotId);
      if (!snapshot) throw new StudioError('SNAPSHOT_NOT_FOUND', '恢复快照不存在', 404);
      // 目标资源在当前集合中的位置。
      const index = registry.projects.findIndex((item) => item.id === snapshot.projectId);
      if (index < 0 || projectFingerprint(registry.projects[index]) !== snapshot.fingerprint) throw new StudioError('RESTORE_CONFLICT', '项目配置已变化，不能自动恢复', 409);
      if (snapshot.previous) {
        checkRuleConflicts(registry, snapshot.previous);
        for (const endpoint of snapshot.previous.endpoints) {
          // 其他项目中占用该接口编号的配置。
          const duplicate = findEndpoint(registry, endpoint.id);
          if (duplicate && duplicate.project.id !== snapshot.projectId) throw new StudioError('RESTORE_CONFLICT', '原接口编号已被其他项目使用', 409);
        }
      }
      if (snapshot.previous) registry.projects[index] = snapshot.previous;
      else registry.projects.splice(index, 1);
      registry.snapshots = registry.snapshots.filter((item) => item.id !== snapshot.id);
      return { restored: true, projectId: snapshot.projectId };
    });
    result.sync = await syncAndRecord();
    return sendJson(response, 200, result);
  }
  if (request.method === 'POST' && pathname.startsWith('/api/projects/') && pathname.endsWith('/reset')) {
    // 将项目所有顺序计数和共享流程状态恢复初始值。
    const projectId = getPathPart(pathname, 2);
    // 待检查或更新的项目配置。
    const project = await mutateRegistry((registry) => {
      // 按编号定位到的项目或接口。
      const match = registry.projects.find((item) => item.id === projectId);
      if (!match) throw new StudioError('PROJECT_NOT_FOUND', '项目不存在', 404);
      for (const endpoint of match.endpoints) endpoint.sequence.currentIndex = 0;
      for (const combination of match.combinations ?? []) combination.currentIndex = 0;
      if (match.flow) match.flow.currentState = match.flow.initialState;
      return match;
    });
    return sendJson(response, 200, project);
  }
  if (request.method === 'PUT' && pathname.startsWith('/api/projects/') && pathname.endsWith('/flow')) {
    // 流程和接口映射必须在同一事务中验证并保存。
    const projectId = getPathPart(pathname, 2);
    // 客户端提交的配置内容。
    const payload = await readJsonBody(request);
    // 待检查或更新的项目配置。
    const project = await mutateRegistry((registry) => {
      // 按编号定位到的项目或接口。
      const match = registry.projects.find((item) => item.id === projectId);
      if (!match) throw new StudioError('PROJECT_NOT_FOUND', '项目不存在', 404);
      // 等待校验后提交的配置副本。
      const candidate = structuredClone(match);
      candidate.flow = payload.flow;
      for (const update of payload.endpoints ?? []) {
        // 等待处理的接口配置。
        const endpoint = candidate.endpoints.find((item) => item.id === update.id);
        if (!endpoint) throw new StudioError('ENDPOINT_NOT_FOUND', '流程引用的接口不存在', 404);
        endpoint.mode = update.mode;
        endpoint.stateVariants = update.stateVariants;
      }
      candidate.updatedAt = new Date().toISOString();
      validateProject(candidate);
      checkRuleConflicts(registry, candidate);
      Object.assign(match, candidate);
      return match;
    });
    return sendJson(response, 200, project);
  }
  if (request.method === 'POST' && pathname === '/api/projects') {
    /** 新项目基础信息 */
    const payload = await readJsonBody(request);
    /** 新建后的项目 */
    const project = await mutateRegistry((registry) => {
      /** 根据名称生成的项目编号 */
      const projectId = payload.id || newId('project');
      /** 待加入注册表的新项目 */
      const newProject = { id: projectId, name: payload.name || '未命名项目', description: payload.description || '本地 Mock 项目', enabled: true, updatedAt: new Date().toISOString(), endpoints: [], mocks: [], combinations: [] };
      validateProject(newProject);
      if (registry.projects.some((item) => item.id === projectId)) throw new StudioError('DUPLICATE_ID', '项目编号已存在', 409);
      registry.projects.push(newProject);
      return newProject;
    });
    sendJson(response, 201, project);
    return;
  }
  if (request.method === 'POST' && pathname.startsWith('/api/projects/') && pathname.endsWith('/endpoints')) {
    /** 新接口所属的项目编号 */
    const projectId = getPathPart(pathname, 2);
    /** 新接口基础信息 */
    const payload = await readJsonBody(request);
    /** 新建后的接口 */
    const endpoint = await mutateRegistry((registry) => {
      /** 当前命中的项目 */
      const project = registry.projects.find((item) => item.id === projectId);
      if (!project) return null;
      /** 新接口的默认响应场景编号 */
      const newEndpoint = makeEndpoint(payload);
      if (findEndpoint(registry, newEndpoint.id)) throw new StudioError('DUPLICATE_ID', '接口编号已存在', 409);
      project.endpoints.push(newEndpoint);
      checkRuleConflicts(registry, project);
      return newEndpoint;
    });
    if (!endpoint) return sendJson(response, 404, { message: '项目不存在' });
    await syncAndRecord();
    sendJson(response, 201, endpoint);
    return;
  }
  if (request.method === 'POST' && pathname.startsWith('/api/endpoints/') && pathname.endsWith('/clone')) {
    /** 待克隆的接口编号 */
    const endpointId = getPathPart(pathname, 2);
    /** 克隆后的接口 */
    const clonedEndpoint = await mutateRegistry((registry) => {
      /** 当前命中的接口与项目 */
      const match = findEndpoint(registry, endpointId);
      if (!match) return null;
      /** 深复制得到的新接口 */
      const clone = structuredClone(match.endpoint);
      clone.id = `${match.endpoint.id}-copy-${Date.now()}`;
      clone.name = `${match.endpoint.name} · 副本`;
      clone.enabled = false;
      clone.stats = { hits: 0, lastHitAt: null };
      match.project.endpoints.push(clone);
      return clone;
    });
    sendJson(response, clonedEndpoint ? 201 : 404, clonedEndpoint ?? { message: '接口不存在' });
    return;
  }
  if (pathname.startsWith('/api/endpoints/') && pathname.includes('/variants') && request.method !== 'GET') {
    // 场景管理操作先在副本中完成，校验成功后才一次性写入。
    const endpointId = getPathPart(pathname, 2);
    // 当前响应场景的稳定编号。
    const variantId = getPathPart(pathname, 4);
    // 客户端提交的配置内容。
    const payload = await readJsonBody(request);
    // 本次管理操作的执行结果。
    const result = await mutateRegistry((registry) => {
      // 按编号定位到的项目或接口。
      const match = findEndpoint(registry, endpointId);
      if (!match) throw new StudioError('ENDPOINT_NOT_FOUND', '接口不存在', 404);
      // 等待处理的接口配置。
      const endpoint = structuredClone(match.endpoint);
      if (request.method === 'POST' && !variantId) {
        // 当前需要处理的响应场景。
        const variant = validateVariant({ id: payload.id || newId('response'), name: payload.name || '新场景', status: payload.status ?? 200, delayMs: payload.delayMs ?? 0, headers: payload.headers ?? { 'cache-control': 'no-store' }, body: Object.hasOwn(payload, 'body') ? payload.body : {} });
        endpoint.variants.push(variant);
      } else if (request.method === 'POST' && variantId === 'batch') {
        // 批量文件先全部校验，通过后在同一事务中加入。
        if (!Array.isArray(payload.variants) || !payload.variants.length) throw new StudioError('INVALID_VARIANT', '请选择至少一个场景');
        for (const item of payload.variants) endpoint.variants.push(validateVariant({ id: item.id || newId('response'), name: item.name, status: item.status ?? 200, delayMs: item.delayMs ?? 0, headers: item.headers ?? { 'cache-control': 'no-store' }, body: item.body }));
      } else if (request.method === 'POST' && variantId === 'reorder') {
        if (!Array.isArray(payload.ids) || payload.ids.length !== endpoint.variants.length || new Set(payload.ids).size !== endpoint.variants.length || payload.ids.some((id) => !endpoint.variants.some((variant) => variant.id === id))) throw new StudioError('INVALID_ORDER', '排序必须包含所有场景且不可重复');
        // 顺序模式当前场景的稳定编号。
        const currentId = endpoint.variants[endpoint.sequence.currentIndex].id;
        endpoint.variants = payload.ids.map((id) => endpoint.variants.find((variant) => variant.id === id));
        endpoint.sequence.currentIndex = endpoint.variants.findIndex((variant) => variant.id === currentId);
      } else if (request.method === 'POST' && pathname.endsWith('/clone')) {
        // 被复制的原始场景。
        const source = endpoint.variants.find((item) => item.id === variantId);
        if (!source) throw new StudioError('VARIANT_NOT_FOUND', '场景不存在', 404);
        endpoint.variants.push({ ...structuredClone(source), id: newId('response'), name: `${source.name} · 副本` });
      } else if (request.method === 'DELETE' && variantId) {
        if (endpoint.variants.length === 1) throw new StudioError('LAST_VARIANT', '至少保留一个场景');
        // 目标资源在当前集合中的位置。
        const index = endpoint.variants.findIndex((item) => item.id === variantId);
        if (index < 0) throw new StudioError('VARIANT_NOT_FOUND', '场景不存在', 404);
        if (Object.values(endpoint.stateVariants ?? {}).includes(variantId) || match.project.flow?.transitions?.some((item) => item.endpointId === endpointId && item.variantId === variantId)) throw new StudioError('VARIANT_IN_USE', '场景被流程引用，请先调整流程');
        // 顺序模式当前场景的稳定编号。
        const currentId = endpoint.variants[endpoint.sequence.currentIndex].id;
        endpoint.variants.splice(index, 1);
        if (endpoint.activeVariantId === variantId) endpoint.activeVariantId = endpoint.variants[0].id;
        endpoint.sequence.currentIndex = Math.max(0, endpoint.variants.findIndex((item) => item.id === currentId));
      } else if (request.method === 'PUT' && variantId) {
        // 当前需要处理的响应场景。
        const variant = endpoint.variants.find((item) => item.id === variantId);
        if (!variant) throw new StudioError('VARIANT_NOT_FOUND', '场景不存在', 404);
        for (const key of ['name', 'status', 'delayMs', 'headers', 'body']) if (Object.hasOwn(payload, key)) variant[key] = payload[key];
      } else throw new StudioError('ROUTE_NOT_FOUND', '路由不存在', 404);
      endpoint.updatedAt = new Date().toISOString();
      validateEndpoint(endpoint);
      Object.assign(match.endpoint, endpoint);
      return endpoint;
    });
    return sendJson(response, 200, result);
  }
  if (request.method === 'PATCH' && pathname.startsWith('/api/projects/')) {
    /** 待更新的项目编号 */
    const projectId = getPathPart(pathname, 2);
    /** 项目字段更新内容 */
    const patch = await readJsonBody(request);
    /** 更新后的项目 */
    const project = await mutateRegistry((registry) => {
      /** 当前命中的项目 */
      const matchedProject = registry.projects.find((item) => item.id === projectId);
      if (!matchedProject) return null;
      // 在副本中更新并校验项目，避免非法输入覆盖已有配置。
      const candidate = structuredClone(matchedProject);
      for (const key of ['name', 'description', 'enabled', 'pageUrl', 'flow', 'cors']) if (Object.hasOwn(patch, key)) candidate[key] = patch[key];
      candidate.updatedAt = new Date().toISOString();
      validateProject(candidate);
      checkRuleConflicts(registry, candidate);
      Object.assign(matchedProject, candidate);
      return matchedProject;
    });
    if (!project) return sendJson(response, 404, { message: '项目不存在' });
    // 返回规则同步结果，让调用者区分配置已保存和代理已生效。
    const sync = await syncAndRecord();
    sendJson(response, 200, { ...project, sync });
    return;
  }
  if (request.method === 'PATCH' && pathname.startsWith('/api/endpoints/')) {
    /** 待更新的接口编号 */
    const endpointId = getPathPart(pathname, 2);
    /** 接口字段更新内容 */
    const patch = await readJsonBody(request);
    /** 更新后的接口 */
    const endpoint = await mutateRegistry((registry) => {
      /** 当前命中的接口 */
      const match = findEndpoint(registry, endpointId);
      if (!match) return null;
      // 校验接口以及项目状态引用后再替换原配置。
      const candidate = structuredClone(match.endpoint);
      for (const key of ['name', 'method', 'url', 'enabled', 'mode', 'activeVariantId', 'sequence', 'stateVariants']) if (Object.hasOwn(patch, key)) candidate[key] = patch[key];
      candidate.updatedAt = new Date().toISOString();
      validateEndpoint(candidate);
      // 待检查或更新的项目配置。
      const project = structuredClone(match.project);
      project.endpoints[project.endpoints.findIndex((item) => item.id === endpointId)] = candidate;
      validateProject(project);
      checkRuleConflicts(registry, project);
      Object.assign(match.endpoint, candidate);
      return match.endpoint;
    });
    if (!endpoint) return sendJson(response, 404, { message: '接口不存在' });
    // 返回规则同步结果，让调用者能发现 Whistle 不可用。
    const sync = await syncAndRecord();
    sendJson(response, 200, { ...endpoint, sync });
    return;
  }
  if (request.method === 'POST' && pathname.endsWith('/reset') && pathname.startsWith('/api/endpoints/')) {
    /** 待重置的接口编号 */
    const endpointId = getPathPart(pathname, 2);
    /** 重置后的接口 */
    const endpoint = await mutateRegistry((registry) => {
      /** 当前命中的接口 */
      const match = findEndpoint(registry, endpointId);
      if (!match) return null;
      match.endpoint.sequence.currentIndex = 0;
      match.endpoint.stats.hits = 0;
      match.endpoint.stats.lastHitAt = null;
      return match.endpoint;
    });
    sendJson(response, endpoint ? 200 : 404, endpoint ?? { message: '接口不存在' });
    return;
  }
  if (request.method === 'POST' && pathname.endsWith('/advance') && pathname.startsWith('/api/endpoints/')) {
    /** 待前进一步的接口编号 */
    const endpointId = getPathPart(pathname, 2);
    /** 前进后的接口 */
    const endpoint = await mutateRegistry((registry) => {
      /** 当前命中的接口 */
      const match = findEndpoint(registry, endpointId);
      if (!match) return null;
      match.endpoint.sequence.currentIndex = getNextSequenceIndex(match.endpoint);
      return match.endpoint;
    });
    sendJson(response, endpoint ? 200 : 404, endpoint ?? { message: '接口不存在' });
    return;
  }
  if (['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method) && pathname.startsWith('/runtime/respond/')) {
    await handleRuntimeResponse(getPathPart(pathname, 2), request, response);
    return;
  }
  sendJson(response, 404, { message: '路由不存在' });
};

/** 创建本地 Mock 管理与响应服务 */
const server = http.createServer((request, response) => {
  withRevision(request, () => handleRequest(request, response)).catch((error) => {
    console.error('[Mock Studio] request failed', error);
    if (response.destroyed) return;
    if (response.headersSent) { response.destroy(); return; }
    sendJson(response, error instanceof StudioError ? error.status : error instanceof SyntaxError ? 400 : 500, { code: error instanceof StudioError ? error.code : error instanceof SyntaxError ? 'INVALID_JSON' : 'INTERNAL_ERROR', message: error instanceof Error ? error.message : '未知服务错误' });
  });
});

/** 启动服务时读取的监听端口 */
const registry = await readRegistry();
// 重启后录制自动停止，防止无意继续采集；已录制内容保留。
if (registry.projects.some((project) => project.recordings?.some((item) => item.status === 'recording' || item.pending))) await mutateRegistry((next) => { for (const project of next.projects) for (const session of project.recordings ?? []) { session.status = 'stopped'; session.pending = 0; } });

server.listen(registry.settings.apiPort, host, async () => {
  /** 初次启动时的 Whistle 同步结果 */
  const result = await syncAndRecord({ force: true });
  console.log(`[Mock Studio] API running at http://${host}:${registry.settings.apiPort}`);
  console.log(`[Mock Studio] ${result.message}`);
});

// 定期回读托管规则，连接恢复或外部改写后重新提交；繁忙时不叠加任务。
const healthTimer = process.env.MOCK_STUDIO_NO_WHISTLE === '1' ? null : setInterval(() => {
  if (!syncActive && !pendingSync) void syncAndRecord({ verify: true }).catch((error) => console.error('[Mock Studio] 代理健康检查失败', error));
}, 15000);
healthTimer?.unref();

// 桌面版退出前清除自身托管规则，避免代理继续指向已停止的服务。
if (process.env.MOCK_STUDIO_CLEAR_ON_EXIT === '1') {
  process.once('SIGTERM', async () => {
    clearInterval(healthTimer);
    try {
      await syncQueue.catch(() => {});
      await syncWhistleRules({ settings: registry.settings, projects: [] });
    } catch (error) {
      console.error('[Mock Studio] 清理代理规则失败', error);
    }
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 10000).unref();
  });
}
