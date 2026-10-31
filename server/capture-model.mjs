import { checkId, checkUrl, newId, StudioError } from './model.mjs';
import { validateHeaderName, validateHeaderValue } from 'node:http';

export const MAX_BODY = 2 * 1024 * 1024;
export const MAX_SESSION = 6 * 1024 * 1024;
export const interfaceKey = (method, value) => {
  const url = new URL(value);
  return `${method} ${url.origin}${url.pathname}`;
};
export const cleanHeaders = (headers, privateValues = false) => {
  const connection = String(headers.connection ?? '')
    .toLowerCase()
    .split(',')
    .map((name) => name.trim());
  return Object.fromEntries(
    Object.entries(headers).filter(
      ([name]) =>
        !/^(x-mock-|x-whistle-|host$|connection$|proxy-connection$|proxy-authorization$|keep-alive$|te$|trailer$|transfer-encoding$|upgrade$|content-length$)/i.test(
          name,
        ) &&
        !connection.includes(name.toLowerCase()) &&
        (!privateValues || !/^(cookie|set-cookie|authorization)$/i.test(name)),
    ),
  );
};
const fail = (message) => {
  throw new StudioError('INVALID_CAPTURE', message);
};
export const validateBase64 = (value, limit = MAX_BODY) => {
  if (
    typeof value !== 'string' ||
    value.length > Math.ceil(limit / 3) * 4 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      value,
    ) ||
    Buffer.from(value, 'base64').length > limit
  )
    fail('文件或响应内容无效，单份内容不能超过 2MB');
};
const validateHeaders = (headers) => {
  if (!headers || typeof headers !== 'object' || Array.isArray(headers))
    fail('响应头格式无效');
  for (const [name, value] of Object.entries(headers)) {
    try {
      validateHeaderName(name);
      for (const item of Array.isArray(value) ? value : [value]) {
        if (typeof item !== 'string') throw Error();
        validateHeaderValue(name, item);
      }
    } catch {
      fail('响应头名称或值无效');
    }
  }
};
export const groupsFor = (session) => {
  const groups = new Map();
  for (const entry of [...session.entries].sort((a, b) => a.order - b.order)) {
    const key = interfaceKey(entry.method, entry.url);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(entry);
  }
  return groups;
};
export const validateCaptureTools = (project) => {
  if (
    !Array.isArray(project.recordings ?? []) ||
    !Array.isArray(project.resources ?? [])
  )
    fail('录制或资源列表无效');
  const ids = new Set();
  for (const item of [
    ...(project.recordings ?? []),
    ...(project.resources ?? []),
  ]) {
    checkId(item.id);
    if (ids.has(item.id)) fail('录制或资源编号重复');
    ids.add(item.id);
    if (
      typeof item.name !== 'string' ||
      !item.name.trim() ||
      item.name.length > 160 ||
      typeof item.enabled !== 'boolean'
    )
      fail('名称或开关无效');
  }
  for (const session of project.recordings ?? []) {
    checkUrl(session.scope);
    if (
      !['recording', 'stopped'].includes(session.status) ||
      !Array.isArray(session.entries) ||
      session.entries.length > 300 ||
      !Array.isArray(session.selectedKeys) ||
      !session.positions ||
      typeof session.positions !== 'object' ||
      Array.isArray(session.positions)
    )
      fail('录制配置无效');
    let size = 0;
    const entryIds = new Set();
    for (const entry of session.entries) {
      checkId(entry.id);
      checkUrl(entry.url);
      if (entryIds.has(entry.id)) fail('录制请求编号重复');
      entryIds.add(entry.id);
      if (
        !['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'].includes(
          entry.method,
        ) ||
        !Number.isSafeInteger(entry.order) ||
        entry.order < 0 ||
        !entry.response ||
        !Number.isInteger(entry.response.status) ||
        entry.response.status < 200 ||
        entry.response.status > 599
      )
        fail('录制响应状态或请求方法无效');
      validateBase64(entry.requestBody);
      validateBase64(entry.response.body);
      validateHeaders(entry.response.headers);
      validateHeaders(entry.requestHeaders);
      entry.response.headers = cleanHeaders(entry.response.headers, true);
      entry.requestHeaders = cleanHeaders(entry.requestHeaders, true);
      size += entry.requestBody.length + entry.response.body.length;
    }
    if (size > MAX_SESSION) fail('单个录制包不能超过 6MB');
    const groups = groupsFor(session);
    if (
      session.selectedKeys.some((key) => !groups.has(key)) ||
      new Set(session.selectedKeys).size !== session.selectedKeys.length
    )
      fail('选择的接口不存在或重复');
    if (
      session.enabled &&
      (session.status !== 'stopped' ||
        !session.selectedKeys.length ||
        session.pending > 0)
    )
      fail('停止录制并等待请求完成、选择接口后才能回放');
    for (const [key, value] of Object.entries(session.positions))
      if (
        !groups.has(key) ||
        !Number.isSafeInteger(value) ||
        value < 0 ||
        value > groups.get(key).length
      )
        fail('回放进度无效');
  }
  for (const resource of project.resources ?? []) {
    checkUrl(resource.url);
    if (
      !['file', 'url'].includes(resource.type) ||
      typeof resource.ignoreQuery !== 'boolean'
    )
      fail('资源替换配置无效');
    if (resource.type === 'url') {
      checkUrl(resource.targetUrl);
      if (new URL(resource.url).href === new URL(resource.targetUrl).href)
        fail('替换地址不能指向相同资源');
    } else {
      validateBase64(resource.body);
      if (typeof resource.fileName !== 'string' || !resource.fileName)
        fail('请选择本地文件');
      if (
        typeof resource.contentType !== 'string' ||
        !/^(text\/(javascript|css)|application\/(javascript|octet-stream)|image\/[a-zA-Z0-9.+-]+)$/.test(
          resource.contentType,
        )
      )
        fail('请选择 JS、CSS 或图片');
    }
  }
};

/** 录制范围、回放接口和资源与已有 Mock 共用冲突检查与代理入口。 */
export const captureRules = (project) => {
  const entries = [];
  for (const session of project.recordings ?? []) {
    if (session.status === 'recording')
      for (const method of [
        'GET',
        'POST',
        'PUT',
        'PATCH',
        'DELETE',
        'HEAD',
        'OPTIONS',
      ])
        entries.push({
          method,
          match: { type: 'prefix', value: session.scope },
        });
    if (session.enabled)
      for (const key of session.selectedKeys) {
        const space = key.indexOf(' ');
        entries.push({
          method: key.slice(0, space),
          match: { type: 'path', value: key.slice(space + 1) },
        });
      }
  }
  for (const resource of (project.resources ?? []).filter(
    (item) => item.enabled,
  ))
    for (const method of ['GET', 'HEAD'])
      entries.push({
        method,
        match: {
          type: resource.ignoreQuery ? 'path' : 'exact',
          value: resource.url,
        },
      });
  return entries;
};

export const importRecording = (input) => {
  if (
    input?.format !== 'mock-studio-recording' ||
    input.version !== 1 ||
    !input.recording
  )
    fail('请选择 Mock Studio 录制包（v1）');
  const source = input.recording;
  const session = {
    id: newId('recording'),
    name: source.name,
    scope: source.scope,
    status: 'stopped',
    enabled: false,
    entries: source.entries,
    selectedKeys: source.selectedKeys,
    positions: {},
    pending: 0,
    skipped: 0,
    nextOrder: source.entries?.length ?? 0,
  };
  validateCaptureTools({ recordings: [session] });
  session.entries = session.entries.map((entry) => ({
    ...entry,
    id: newId('request'),
  }));
  return session;
};
