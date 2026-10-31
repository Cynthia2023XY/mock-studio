import http from 'node:http';
import https from 'node:https';
import { mutateRegistry, withoutWrite } from './store.mjs';
import { newId, StudioError } from './model.mjs';
import {
  groupsFor,
  interfaceKey,
  cleanHeaders,
  MAX_BODY,
  MAX_SESSION,
} from './capture-model.mjs';
import { resolveCors, mergeCorsHeaders } from './cors.mjs';

/** 回源直连网络，避免再次经过 Whistle；流式传输不受录制大小上限影响。 */
const forward = (
  request,
  response,
  original,
  target,
  recording,
  resourceCors,
) =>
  new Promise((resolve) => {
    const url = new URL(target);
    if (
      ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) &&
      url.port === String(request.socket.localPort)
    )
      throw new StudioError('INVALID_UPSTREAM', '不能转发到管理服务本身');
    const started = Date.now();
    const requestChunks = [],
      responseChunks = [];
    let requestSize = 0,
      responseSize = 0,
      finished = false;
    const finalize = async (incoming, failed = false) => {
      if (finished) return;
      finished = true;
      if (recording)
        await mutateRegistry((registry) => {
          const session = registry.projects
            .find((project) => project.id === recording.projectId)
            ?.recordings?.find((item) => item.id === recording.id);
          if (!session) return withoutWrite(null);
          session.pending = Math.max(0, session.pending - 1);
          const body = Buffer.concat(responseChunks).toString('base64'),
            requestBody = Buffer.concat(requestChunks).toString('base64');
          const total = session.entries.reduce(
            (sum, entry) =>
              sum + entry.requestBody.length + entry.response.body.length,
            0,
          );
          if (
            failed ||
            !incoming ||
            incoming.statusCode === 304 ||
            requestSize > MAX_BODY ||
            responseSize > MAX_BODY ||
            session.entries.length >= 300 ||
            total + body.length + requestBody.length > MAX_SESSION
          ) {
            session.skipped++;
            return;
          }
          const entry = {
            id: newId('request'),
            order: recording.order,
            method: request.method,
            url: original,
            requestHeaders: cleanHeaders(request.headers, true),
            requestBody,
            response: {
              status: incoming.statusCode,
              headers: cleanHeaders(incoming.headers, true),
              body,
            },
            startedAt: new Date(started).toISOString(),
            durationMs: Date.now() - started,
          };
          session.entries.push(entry);
          session.entries.sort((a, b) => a.order - b.order);
          const key = interfaceKey(entry.method, entry.url);
          if (!session.selectedKeys.includes(key))
            session.selectedKeys.push(key);
        });
    };
    const finish = (incoming, failed = false) => {
      void finalize(incoming, failed)
        .catch((error) =>
          console.error('[Mock Studio] 保存录制失败', error.message),
        )
        .finally(() => {
          if (!failed && !response.destroyed) response.end();
          resolve();
        });
    };
    const headers = cleanHeaders(request.headers);
    if (resourceCors)
      for (const name of [
        'if-none-match',
        'if-modified-since',
        'range',
        'if-range',
      ])
        delete headers[name];
    // 资源替换跨站取文件时，不把原站点凭据传给替换服务器。
    if (new URL(original).origin !== url.origin) {
      delete headers.cookie;
      delete headers.authorization;
    }
    const upstream = (url.protocol === 'https:' ? https : http).request(
      url,
      { method: request.method, headers },
      (incoming) => {
        response.writeHead(incoming.statusCode, {
          ...(resourceCors
            ? mergeCorsHeaders(cleanHeaders(incoming.headers), resourceCors)
            : cleanHeaders(incoming.headers)),
          ...(recording || original === target
            ? {}
            : {
                'cache-control': 'no-store',
                'x-mock-source': 'mock-studio',
                'x-mock-kind': 'resource',
              }),
        });
        incoming.on('data', (chunk) => {
          if (recording) {
            responseSize += chunk.length;
            if (responseSize <= MAX_BODY) responseChunks.push(chunk);
          }
        });
        incoming.on('error', () => {
          finish(incoming, true);
          response.destroy();
        });
        incoming.on('end', () => finish(incoming));
        incoming.pipe(response, { end: false });
      },
    );
    request.on('data', (chunk) => {
      if (recording) {
        requestSize += chunk.length;
        if (requestSize <= MAX_BODY) requestChunks.push(chunk);
      }
    });
    request.on('aborted', () => upstream.destroy(new Error('客户端中断请求')));
    upstream.on('error', () => {
      finish(null, true);
      if (!response.headersSent)
        response
          .writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
          .end('目标服务不可用或响应超时');
      else response.destroy();
    });
    upstream.setTimeout(30000, () => upstream.destroy(new Error('回源超时')));
    response.on('close', () => {
      if (!response.writableEnded) {
        upstream.destroy();
        finish(null, true);
      }
    });
    request.pipe(upstream);
  });

/** 选择响应与推进各接口独立队列在同一事务内完成。 */
export const handleCaptureRuntime = async (request, response, url) => {
  const destination = new URL(url);
  if (
    ['127.0.0.1', 'localhost', '[::1]'].includes(destination.hostname) &&
    destination.port === String(request.socket.localPort)
  )
    throw new StudioError('INVALID_UPSTREAM', '不能转发到管理服务本身');
  const selection = await mutateRegistry((registry) => {
    for (const project of registry.projects.filter((item) => item.enabled)) {
      const session = project.recordings?.find(
        (item) => item.status === 'recording' && url.startsWith(item.scope),
      );
      if (session) {
        if (request.method === 'OPTIONS')
          return withoutWrite({ kind: 'forward' });
        session.pending++;
        const order = session.nextOrder++;
        return { kind: 'record', projectId: project.id, id: session.id, order };
      }
      const key = interfaceKey(request.method, url);
      const replay = project.recordings?.find(
        (item) => item.enabled && item.selectedKeys.includes(key),
      );
      if (replay) {
        const cors = resolveCors(registry, request, url);
        if (cors.denied || cors.preflight)
          return withoutWrite({ kind: 'cors', cors });
        const entries = groupsFor(replay).get(key);
        const position = replay.positions[key] ?? 0;
        const entry = entries[Math.min(position, entries.length - 1)];
        replay.positions[key] = Math.min(position + 1, entries.length);
        const hit = {
          id: newId('hit'),
          projectId: project.id,
          recordingId: replay.id,
          timestamp: new Date().toISOString(),
          method: request.method,
          actualUrl: url,
          status: entry.response.status,
          variantName: `${replay.name} · ${Math.min(position + 1, entries.length)}/${entries.length}`,
          outcome: 'mock',
          delivery: 'selected',
          sequenceIndex: Math.min(position, entries.length - 1),
          sequenceTotal: entries.length,
        };
        registry.hits = [...(registry.hits ?? []), hit].slice(-500);
        return { kind: 'replay', entry, cors, hit };
      }
      const resource =
        ['GET', 'HEAD'].includes(request.method) &&
        project.resources?.find(
          (item) =>
            item.enabled &&
            (item.ignoreQuery
              ? interfaceKey('GET', item.url) === interfaceKey('GET', url)
              : item.url === url),
        );
      if (resource) {
        const cors = resolveCors(registry, request, url);
        if (cors.denied) return withoutWrite({ kind: 'cors', cors });
        resource.hits = (resource.hits ?? 0) + 1;
        resource.lastHitAt = new Date().toISOString();
        return { kind: 'resource', resource, cors };
      }
    }
    return withoutWrite(null);
  });
  if (!selection) return false;
  if (selection.kind === 'record' || selection.kind === 'forward')
    await forward(
      request,
      response,
      url,
      url,
      selection.kind === 'record' ? selection : null,
    );
  else if (selection.kind === 'cors') {
    request.resume();
    response
      .writeHead(selection.cors.denied ? 403 : 204, selection.cors.headers)
      .end();
  } else if (selection.kind === 'replay') {
    request.resume();
    const { entry, cors, hit } = selection;
    const { trackDelivery } = await import('./delivery.mjs');
    trackDelivery(response, hit.id);
    response.writeHead(entry.response.status, {
      ...mergeCorsHeaders(cleanHeaders(entry.response.headers, true), cors),
      'cache-control': 'no-store',
      'x-mock-source': 'mock-studio',
      'x-mock-kind': 'recording',
      'x-mock-hit-id': hit.id,
      'x-mock-sequence': `${hit.sequenceIndex + 1}/${hit.sequenceTotal}`,
    });
    response.end(
      request.method === 'HEAD' ||
        [204, 205, 304].includes(entry.response.status)
        ? undefined
        : Buffer.from(entry.response.body, 'base64'),
    );
  } else if (selection.resource.type === 'url')
    await forward(
      request,
      response,
      url,
      selection.resource.targetUrl,
      undefined,
      selection.cors,
    );
  else {
    request.resume();
    response.writeHead(200, {
      ...selection.cors.headers,
      'content-type': selection.resource.contentType,
      'cache-control': 'no-store',
      'x-mock-source': 'mock-studio',
      'x-mock-kind': 'resource',
    });
    response.end(
      request.method === 'HEAD'
        ? undefined
        : Buffer.from(selection.resource.body, 'base64'),
    );
  }
  return true;
};
