import { mutateRegistry, readRegistry } from './store.mjs';
import { newId, StudioError, validateProject } from './model.mjs';
import { normalizeUrl, checkConflicts } from './rules.mjs';
import {
  groupsFor,
  importRecording,
  cleanHeaders,
  interfaceKey,
} from './capture-model.mjs';

const missing = () => {
  throw new StudioError('NOT_FOUND', '录制或资源不存在', 404);
};
export const handleCaptureApi = async (
  request,
  response,
  pathname,
  { readJsonBody, sendJson, syncAndRecord },
) => {
  const route =
    /^\/api\/projects\/([^/]+)\/(recordings|resources)(?:\/([^/]+))?(?:\/(stop|reset|export|responses))?$/.exec(
      pathname,
    );
  if (!route) return false;
  const [, projectId, type, id, action] = route;
  if (request.method === 'GET') {
    const project = (await readRegistry()).projects.find(
      (item) => item.id === projectId,
    );
    if (!project) missing();
    const item = project[type]?.find((item) => item.id === id);
    if (action === 'export' && type === 'recordings' && item) {
      if (item.status !== 'stopped' || item.pending > 0)
        throw new StudioError(
          'RECORDING_BUSY',
          '请停止录制并等待请求完成后导出',
          409,
        );
      if (!item.selectedKeys.length)
        throw new StudioError('EMPTY_SELECTION', '请先选择要导出的接口');
      sendJson(response, 200, {
        format: 'mock-studio-recording',
        version: 1,
        recording: {
          name: item.name,
          scope: item.scope,
          entries: item.entries
            .filter((entry) =>
              item.selectedKeys.includes(interfaceKey(entry.method, entry.url)),
            )
            .map((entry) => ({
              ...entry,
              requestHeaders: cleanHeaders(entry.requestHeaders, true),
              response: {
                ...entry.response,
                headers: cleanHeaders(entry.response.headers, true),
              },
            })),
          selectedKeys: item.selectedKeys,
        },
      });
    } else if (!id) sendJson(response, 200, project[type] ?? []);
    else missing();
    return true;
  }
  const payload = await readJsonBody(request);
  if (!payload || typeof payload !== 'object' || Array.isArray(payload))
    throw new StudioError('INVALID_BODY', '操作需要 JSON 对象');
  const result = await mutateRegistry((registry) => {
    const project = registry.projects.find((item) => item.id === projectId);
    if (!project) missing();
    project.recordings ??= [];
    project.resources ??= [];
    const list = project[type];
    const item = list.find((entry) => entry.id === id);
    let value;
    if (!id && request.method === 'POST') {
      if (type === 'recordings') {
        if (payload.package) value = importRecording(payload.package);
        else {
          if (!project.enabled)
            throw new StudioError(
              'PROJECT_DISABLED',
              '请先开启项目总开关，再开始录制',
              409,
            );
          if (
            registry.projects.some((project) =>
              project.recordings?.some((item) => item.status === 'recording'),
            )
          )
            throw new StudioError('RECORDING_BUSY', '请先停止当前录制', 409);
          const scope = new URL(normalizeUrl(payload.scope));
          scope.search = '';
          scope.hash = '';
          value = {
            id: newId('recording'),
            name: payload.name,
            scope: scope.href,
            status: 'recording',
            enabled: false,
            entries: [],
            selectedKeys: [],
            positions: {},
            pending: 0,
            skipped: 0,
            nextOrder: 0,
          };
        }
      } else
        value = {
          ...payload,
          id: newId('resource'),
          url: normalizeUrl(payload.url),
          ignoreQuery: payload.ignoreQuery ?? true,
          enabled: false,
          hits: 0,
        };
      list.push(value);
    } else {
      if (!item) missing();
      value = item;
      if (
        action === 'stop' &&
        type === 'recordings' &&
        request.method === 'POST'
      )
        item.status = 'stopped';
      else if (
        action === 'reset' &&
        type === 'recordings' &&
        request.method === 'POST'
      )
        item.positions = {};
      else if (
        action === 'responses' &&
        type === 'recordings' &&
        request.method === 'PATCH'
      ) {
        if (item.enabled || item.status !== 'stopped' || item.pending)
          throw new StudioError(
            'RECORDING_BUSY',
            '先关闭回放并等待录制完成后再整理响应',
            409,
          );
        const groups = groupsFor(item);
        const entries = groups.get(payload.key);
        if (
          !entries ||
          !Array.isArray(payload.ids) ||
          !payload.ids.length ||
          new Set(payload.ids).size !== payload.ids.length ||
          payload.ids.some((id) => !entries.some((entry) => entry.id === id))
        )
          throw new StudioError(
            'INVALID_ORDER',
            '响应排序需引用当前接口已有的响应，至少保留一条',
          );
        const others = item.entries.filter(
          (entry) => !entries.some((current) => current.id === entry.id),
        );
        item.entries = [
          ...others,
          ...payload.ids.map((id) => entries.find((entry) => entry.id === id)),
        ].map((entry, order) => ({ ...entry, order }));
        item.positions = {};
      } else if (!action && request.method === 'PATCH') {
        if (type === 'recordings') {
          if (item.status !== 'stopped' || item.pending)
            throw new StudioError(
              'RECORDING_BUSY',
              '请先停止录制并等待请求完成',
              409,
            );
          for (const key of ['name', 'enabled', 'selectedKeys'])
            if (Object.hasOwn(payload, key)) item[key] = payload[key];
          if (payload.enabled === true || payload.selectedKeys)
            item.positions = {};
        } else
          for (const key of [
            'name',
            'url',
            'ignoreQuery',
            'enabled',
            'type',
            'targetUrl',
            'body',
            'fileName',
            'contentType',
          ])
            if (Object.hasOwn(payload, key)) item[key] = payload[key];
      } else if (!action && request.method === 'DELETE') {
        if (item.status === 'recording' || item.pending)
          throw new StudioError(
            'RECORDING_BUSY',
            '请先停止录制并等待请求完成',
            409,
          );
        list.splice(list.indexOf(item), 1);
        value = { deleted: true };
      } else throw new StudioError('METHOD_NOT_ALLOWED', '不支持该操作', 405);
    }
    if (type === 'resources' && value?.url) {
      value.url = normalizeUrl(value.url);
      if (value.type === 'url') value.targetUrl = normalizeUrl(value.targetUrl);
    }
    validateProject(project);
    checkConflicts(registry, project);
    return value;
  });
  sendJson(response, 200, { ...result, sync: await syncAndRecord() });
  return true;
};
