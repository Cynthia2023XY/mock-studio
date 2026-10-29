#!/usr/bin/env node
import { readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { homedir } from 'node:os';

/** Mock Studio 本地管理服务地址 */
const apiBase = process.env.MOCK_STUDIO_API ?? 'http://127.0.0.1:17321';
/** 命令行参数和机器可读输出开关 */
const args = process.argv.slice(2).filter((value) => value !== '--json');
/** 是否输出稳定 JSON 而非人类可读内容 */
const jsonOutput = process.argv.includes('--json');

/** 向本地管理 API 请求并保留结构化错误码 */
const request = async (pathname, method = 'GET', body) => {
  // CLI 从用户本地私有文件读取管理令牌，不输出令牌内容。
  const token = (await readFile(process.env.MOCK_STUDIO_TOKEN_PATH ?? path.join(homedir(), '.mock-studio', 'api-token'), 'utf8')).trim();
  // 管理服务的 HTTP 响应。
  const response = await fetch(`${apiBase}${pathname}`, { method, headers: { 'content-type': 'application/json', 'x-mock-token': token }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  // 管理服务返回的业务结果。
  const data = await response.json();
  if (!response.ok) throw Object.assign(new Error(data.message ?? `HTTP ${response.status}`), { code: data.code ?? 'HTTP_ERROR' });
  return data;
};

/** 读取 JSON 文件并提供明确的解析错误 */
const readJson = async (file) => {
  if (!file) throw Object.assign(new Error('缺少 JSON 文件路径'), { code: 'INVALID_ARGUMENT' });
  try { return JSON.parse(await readFile(file, 'utf8')); } catch (error) { throw Object.assign(new Error(`无法读取 JSON：${error.message}`), { code: 'INVALID_JSON' }); }
};

/** 将场景包相对文件解析为内联响应体 */
const readPackage = async (file) => {
  // 文件内的相对路径以场景包所在目录为基准。
  const pack = await readJson(file);
  // 场景包所处目录。
  const root = await realpath(path.dirname(path.resolve(file)));
  for (const endpoint of pack.endpoints ?? []) for (const variant of endpoint.variants ?? []) {
    if (variant.bodyFile) {
      // 不允许场景包通过相对路径读取目录之外的文件。
      const target = await realpath(path.resolve(root, variant.bodyFile));
      if (!target.startsWith(`${root}${path.sep}`)) throw Object.assign(new Error('bodyFile 必须位于场景包目录内'), { code: 'INVALID_PACKAGE' });
      variant.body = await readJson(target);
      delete variant.bodyFile;
    }
  }
  return pack;
};

/** 输出命令调用方式 */
const help = () => `Mock Studio CLI\n  list [--json]\n  enable|disable <接口ID>\n  mode <接口ID> fixed|sequence\n  use <接口ID> <场景ID>\n  set-body <接口ID> <场景ID> <JSON文件>\n  variant-add <接口ID> <名称> <JSON文件>\n  variant-clone|variant-delete <接口ID> <场景ID>\n  variant-order <接口ID> <场景ID,场景ID,...>\n  sequence-end <接口ID> hold-last|loop\n  reset|next <接口ID>\n  project-enable|project-disable|project-reset <项目ID>\n  flow-set <项目ID> <流程配置JSON>\n  hits [项目ID]\n  package-preview|package-apply <场景包JSON> <项目ID> [replace]\n  package-export <项目ID> <输出JSON文件>\n  package-restore <快照ID>\n  sync\n所有命令均可添加 --json。`;

/** 根据命令参数调用稳定的管理接口 */
const run = async () => {
  // 本次命令和位置参数。
  const [command, id, value, extra] = args;
  if (!command || ['help', '--help'].includes(command)) return { help: help() };
  if (command === 'list') return request('/api/state');
  if (command === 'sync') return request('/api/whistle/sync', 'POST');
  if (command === 'hits') return request(`/api/hits${id ? `?projectId=${encodeURIComponent(id)}` : ''}`);
  if (!id) throw Object.assign(new Error('缺少资源编号或文件路径'), { code: 'INVALID_ARGUMENT' });
  if (command === 'package-preview' || command === 'package-apply') {
    if (!value) throw Object.assign(new Error('缺少目标项目编号'), { code: 'INVALID_ARGUMENT' });
    return request(`/api/packages/${command === 'package-preview' ? 'preview' : 'apply'}`, 'POST', { package: await readPackage(id), projectId: value, mode: extra });
  }
  if (command === 'package-export') {
    if (!value) throw Object.assign(new Error('缺少输出文件路径'), { code: 'INVALID_ARGUMENT' });
    // 场景包只保留配置和响应，不包含历史命中与运行计数。
    const registry = await request('/api/state');
    // 待检查或更新的项目配置。
    const project = registry.projects.find((item) => item.id === id);
    if (!project) throw Object.assign(new Error('项目不存在'), { code: 'PROJECT_NOT_FOUND' });
    // 待导入或导出的场景包内容。
    const pack = { version: 1, name: project.name, description: project.description, pageUrl: project.pageUrl, flow: project.flow, endpoints: project.endpoints.map((endpoint) => ({ id: endpoint.id, name: endpoint.name, method: endpoint.method, url: endpoint.url, enabled: endpoint.enabled, mode: endpoint.mode, activeVariantId: endpoint.activeVariantId, sequence: { afterEnd: endpoint.sequence.afterEnd }, stateVariants: endpoint.stateVariants, variants: endpoint.variants })) };
    await writeFile(value, `${JSON.stringify(pack, null, 2)}\n`, { flag: 'wx' });
    return { path: path.resolve(value), projectId: id };
  }
  if (command === 'package-restore') return request('/api/packages/restore', 'POST', { snapshotId: id });
  if (command === 'project-enable' || command === 'project-disable') return request(`/api/projects/${id}`, 'PATCH', { enabled: command === 'project-enable' });
  if (command === 'project-reset') return request(`/api/projects/${id}/reset`, 'POST');
  if (command === 'flow-set') return request(`/api/projects/${id}/flow`, 'PUT', await readJson(value));
  if (command === 'enable' || command === 'disable') return request(`/api/endpoints/${id}`, 'PATCH', { enabled: command === 'enable' });
  if (command === 'mode') return request(`/api/endpoints/${id}`, 'PATCH', { mode: value });
  if (command === 'use') return request(`/api/endpoints/${id}`, 'PATCH', { mode: 'fixed', activeVariantId: value });
  if (command === 'set-body') return request(`/api/endpoints/${id}/variants/${value}`, 'PUT', { body: await readJson(extra) });
  if (command === 'variant-add') return request(`/api/endpoints/${id}/variants`, 'POST', { name: value, body: await readJson(extra) });
  if (command === 'variant-clone') return request(`/api/endpoints/${id}/variants/${value}/clone`, 'POST');
  if (command === 'variant-delete') return request(`/api/endpoints/${id}/variants/${value}`, 'DELETE');
  if (command === 'variant-order') return request(`/api/endpoints/${id}/variants/reorder`, 'POST', { ids: (value ?? '').split(',') });
  if (command === 'sequence-end') {
    // 保留当前顺序位置，只改变结束策略。
    const registry = await request('/api/state');
    // 等待处理的接口配置。
    const endpoint = registry.projects.flatMap((project) => project.endpoints).find((item) => item.id === id);
    if (!endpoint) throw Object.assign(new Error('接口不存在'), { code: 'ENDPOINT_NOT_FOUND' });
    return request(`/api/endpoints/${id}`, 'PATCH', { sequence: { ...endpoint.sequence, afterEnd: value } });
  }
  if (command === 'reset' || command === 'next') return request(`/api/endpoints/${id}/${command === 'next' ? 'advance' : 'reset'}`, 'POST');
  throw Object.assign(new Error(`未知命令：${command}`), { code: 'UNKNOWN_COMMAND' });
};

run().then((result) => {
  if (jsonOutput) console.log(JSON.stringify({ ok: true, data: result }));
  else if (result.help) console.log(result.help);
  else console.log(JSON.stringify(result, null, 2));
}).catch((error) => {
  if (jsonOutput) console.error(JSON.stringify({ ok: false, error: { code: error.code ?? 'REQUEST_FAILED', message: error.message } }));
  else console.error(`✗ ${error.message}`);
  process.exitCode = 1;
});
