import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { mutateRegistry, readRegistry, registryPath } from './store.mjs';
import { newId, StudioError, validateProject, projectFingerprint } from './model.mjs';
import { checkConflicts, makeMock, validateMock } from './rules.mjs';

/** 为场景包导出移除命中计数和共享执行位置 */
export const exportProject = (project) => ({ version: 2, name: project.name, description: project.description, pageUrl: project.pageUrl, flow: project.flow ? { ...project.flow, currentState: project.flow.initialState } : undefined, endpoints: project.endpoints.map(({ stats: _stats, updatedAt: _updatedAt, sequence, ...endpoint }) => ({ ...endpoint, sequence: { afterEnd: sequence.afterEnd } })), mocks: (project.mocks ?? []).map(({ stats: _stats, ...mock }) => mock), combinations: (project.combinations ?? []).map((item) => ({ ...item, currentIndex: 0 })) });

/** 预览旧固定和顺序接口迁移，旧状态流程整体保留 */
export const previewMigration = (project) => {
  // 有共享状态的项目继续完整沿用原模型，避免破坏状态迁移引用。
  const candidate = structuredClone(project);
  // 稳定映射允许重复预览，重复应用不会生成副本。
  const mapping = {};
  if (project.flow || project.endpoints.some((item) => item.mode === 'state')) return { project: candidate, mapping, retainedLegacy: true, message: '含旧版状态流程，保留原运行模型' };
  candidate.mocks ??= [];
  candidate.combinations ??= [];
  for (const endpoint of project.endpoints) {
    // 原前缀规则无法无损转为完整精确匹配，预览明确列出这一语义变化。
    const ids = endpoint.variants.map((variant) => `mock-${createHash('sha256').update(`${project.id}:${endpoint.id}:${variant.id}`).digest('hex').slice(0, 24)}`);
    mapping[endpoint.id] = Object.fromEntries(endpoint.variants.map((variant, index) => [variant.id, ids[index]]));
    for (const [index, variant] of endpoint.variants.entries()) {
      candidate.mocks.push(validateMock({ id: ids[index], name: `${endpoint.name} · ${variant.name}`, enabled: endpoint.enabled && endpoint.mode === 'fixed' && variant.id === endpoint.activeVariantId, method: endpoint.method, match: { type: 'exact', value: endpoint.url }, response: { status: variant.status, delayMs: variant.delayMs, headers: Object.fromEntries(Object.entries(variant.headers).filter(([name]) => !/^(x-mock-|connection$|transfer-encoding$|content-length$|content-encoding$)/i.test(name))), body: variant.body }, stats: { hits: 0, lastHitAt: null } }));
    }
    if (endpoint.mode === 'sequence') candidate.combinations.push({ id: `combination-${createHash('sha256').update(`${project.id}:${endpoint.id}`).digest('hex').slice(0, 24)}`, name: endpoint.name, enabled: endpoint.enabled, steps: ids.map((id, index) => ({ id: `step-${index}`, mockId: id })), currentIndex: endpoint.sequence.currentIndex, afterEnd: endpoint.sequence.afterEnd, onUnexpectedRequest: 'error' });
  }
  // 多条启用顺序接口无法满足一个项目一个组合的约束，要求用户先调整。
  if (candidate.combinations.filter((item) => item.enabled).length > 1) throw new StudioError('MIGRATION_CONFLICT', '多个旧顺序接口已启用，请先停用至最多一个再迁移', 409);
  candidate.endpoints = [];
  candidate.migration = { ...project.migration, ...mapping };
  validateProject(candidate);
  return { project: candidate, mapping, retainedLegacy: false, warnings: ['旧 URL 前缀匹配迁为精确匹配，额外查询参数将不再命中；请确认预览中的匹配值。', '旧接口命令会返回 MIGRATED_ENDPOINT，使用新 Mock 或组合命令。'] };
};

/** 处理独立 Mock、排序、高级组合和显式迁移的管理路由 */
export const handleV2Api = async (request, response, pathname, { readJsonBody, sendJson, syncAndRecord }) => {
  // 新资源限定在项目内，避免不同项目的同名编号互相影响。
  const route = /^\/api\/projects\/([^/]+)\/(mocks|combinations|migration|export)(?:\/([^/]+))?(?:\/(clone|reset))?$/.exec(pathname);
  if (!route) return false;
  // 路由的每一级均使用已校验的稳定编号。
  const [, projectId, resource, id, action] = route;
  // 导出不写入注册表，也不触发代理同步。
  if (resource === 'export' && request.method === 'GET') {
    // 最新项目配置。
    const project = (await readRegistry()).projects.find((item) => item.id === projectId);
    if (!project) throw new StudioError('PROJECT_NOT_FOUND', '项目不存在', 404);
    sendJson(response, 200, exportProject(project));
    return true;
  }
  // 请求 JSON 先完整解析，失败不进入事务。
  const payload = await readJsonBody(request);
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new StudioError('INVALID_BODY', '管理操作需要 JSON 对象');
  if (resource === 'migration' && id === 'preview' && request.method === 'POST') {
    // 预览保持注册表字节内容不变。
    const project = (await readRegistry()).projects.find((item) => item.id === projectId);
    if (!project) throw new StudioError('PROJECT_NOT_FOUND', '项目不存在', 404);
    sendJson(response, 200, { ...previewMigration(project), fingerprint: projectFingerprint(project) });
    return true;
  }
  // 运行进度、配置变更与迁移全部共用存储串行队列。
  const result = await mutateRegistry(async (registry) => {
    // 目标项目不存在时不创建隐式项目。
    const project = registry.projects.find((item) => item.id === projectId);
    if (!project) throw new StudioError('PROJECT_NOT_FOUND', '项目不存在', 404);
    // 所有引用在最终提交前整体校验。
    let value;
    if (resource === 'migration' && id === 'apply' && request.method === 'POST') {
      if (payload.fingerprint !== projectFingerprint(project)) throw new StudioError('MIGRATION_STALE', '项目配置已变化，请重新预览', 409);
      // 在同一事务内读取当前进度，避免预览期间请求推进被回滚。
      const migration = previewMigration(project);
      if (!Object.keys(migration.mapping).length) return { ...migration, unchanged: true };
      checkConflicts(registry, migration.project);
      // 先备份原始字节；写入或后续校验失败不会覆盖原注册表。
      const backupPath = `${registryPath}.backup-${newId('migration')}.json`;
      await writeFile(backupPath, await readFile(registryPath), { flag: 'wx', mode: 0o600 });
      Object.assign(project, migration.project);
      value = { ...migration, backupPath };
    } else if (resource === 'mocks') {
      // 当前被操作的独立规则。
      const mock = project.mocks.find((item) => item.id === id);
      if (!id && request.method === 'POST') {
        value = makeMock(payload);
        project.mocks.push(value);
      } else if (id === 'reorder' && !action && request.method === 'POST') {
        if (!Array.isArray(payload.ids) || payload.ids.length !== project.mocks.length || new Set(payload.ids).size !== project.mocks.length || payload.ids.some((key) => !project.mocks.some((item) => item.id === key))) throw new StudioError('INVALID_ORDER', '排序需包含全部 Mock 且不得重复');
        project.mocks = payload.ids.map((key) => project.mocks.find((item) => item.id === key));
        value = { ids: payload.ids };
      } else {
        if (!mock) throw new StudioError('MOCK_NOT_FOUND', 'Mock 不存在', 404);
        if (action === 'clone' && request.method === 'POST') {
          value = { ...structuredClone(mock), id: newId('mock'), name: `${mock.name} · 副本`, enabled: false, stats: { hits: 0, lastHitAt: null } };
          project.mocks.push(value);
        } else if (!action && request.method === 'PATCH') {
          for (const key of ['name', 'method', 'match', 'response', 'enabled']) if (Object.hasOwn(payload, key)) mock[key] = payload[key];
          value = validateMock(mock);
        } else if (!action && request.method === 'DELETE') {
          // 停用的组合仍保留引用，删除前同样需要移除步骤。
          const references = project.combinations.filter((item) => item.steps.some((step) => step.mockId === id));
          if (references.length) throw new StudioError('MOCK_IN_USE', `被以下组合引用：${references.map((item) => item.name).join('、')}，请先移除引用`, 409);
          project.mocks.splice(project.mocks.indexOf(mock), 1);
          value = { deleted: true, id };
        } else throw new StudioError('ROUTE_NOT_FOUND', '操作不存在', 404);
      }
    } else if (resource === 'combinations') {
      // 组合编号只在当前项目内解析。
      const combination = project.combinations.find((item) => item.id === id);
      if (!id && request.method === 'POST') {
        value = { id: payload.id || newId('combination'), name: payload.name, enabled: false, steps: payload.steps, currentIndex: 0, afterEnd: payload.afterEnd ?? 'hold-last', onUnexpectedRequest: 'error' };
        project.combinations.push(value);
      } else {
        if (!combination) throw new StudioError('COMBINATION_NOT_FOUND', '组合不存在', 404);
        if (action === 'reset' && request.method === 'POST') {
          combination.currentIndex = 0;
          value = combination;
        } else if (!action && request.method === 'PATCH') {
          // 启用与重新编排都从第一步开始，普通改名不重置进度。
          if ((payload.enabled === true && !combination.enabled) || (Object.hasOwn(payload, 'steps') && JSON.stringify(payload.steps) !== JSON.stringify(combination.steps))) combination.currentIndex = 0;
          for (const key of ['name', 'enabled', 'steps', 'afterEnd']) if (Object.hasOwn(payload, key)) combination[key] = payload[key];
          value = combination;
        } else if (!action && request.method === 'DELETE') {
          project.combinations.splice(project.combinations.indexOf(combination), 1);
          value = { deleted: true, id };
        } else throw new StudioError('ROUTE_NOT_FOUND', '操作不存在', 404);
      }
    } else throw new StudioError('ROUTE_NOT_FOUND', '操作不存在', 404);
    validateProject(project);
    checkConflicts(registry, project);
    project.updatedAt = new Date().toISOString();
    registry.schemaVersion = 2;
    return value;
  });
  // 配置持久化成功与代理同步失败必须分别返回。
  const sync = await syncAndRecord();
  sendJson(response, 200, { ...result, sync });
  return true;
};
