import { StudioError } from './model.mjs';
import { constants } from 'node:fs';
import { copyFile, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** 当前模块所在目录 */
const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));

/** Mock 注册表的持久化文件 */
export const registryPath = process.env.MOCK_STUDIO_REGISTRY ?? path.resolve(moduleDirectory, '../data/registry.json');

/** 首次运行时使用的空项目模板 */
const emptyRegistryPath = path.resolve(moduleDirectory, '../desktop/empty-registry.json');

/** 串行化写入队列，避免连续切换状态时覆盖数据 */
let writeQueue = Promise.resolve();

/** 读取当前完整 Mock 注册表 */
export const readRegistry = async () => {
  // 仅为默认路径初始化；显式指定的文件必须由调用方准备，避免掩盖路径错误。
  if (!process.env.MOCK_STUDIO_REGISTRY) {
    try {
      await copyFile(emptyRegistryPath, registryPath, constants.COPYFILE_EXCL);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
  }
  // 只在内存补齐集合，读取旧数据不会触发迁移或落盘。
  const registry = JSON.parse(await readFile(registryPath, 'utf8'));
  registry.schemaVersion ??= 1;
  if (![1, 2].includes(registry.schemaVersion)) throw new StudioError('UNSUPPORTED_SCHEMA', '注册表版本高于当前服务支持范围，请使用兼容版本，禁止自动降级', 409);
  registry.runtime ??= {};
  for (const project of registry.projects) {
    project.endpoints ??= [];
    project.mocks ??= [];
    project.combinations ??= [];
  }
  return registry;
};

/** 使用临时文件原子更新 Mock 注册表 */
export const writeRegistry = async (registry) => {
  /** 本次写入使用的临时文件 */
  const temporaryPath = `${registryPath}.tmp`;
  writeQueue = writeQueue.catch(() => {}).then(async () => {
    await writeFile(temporaryPath, `${JSON.stringify(registry, null, 2)}\n`, 'utf8');
    await rename(temporaryPath, registryPath);
  });
  await writeQueue;
  return registry;
};

/** 在同一写入队列中读取、变更并保存注册表 */
export const mutateRegistry = async (mutator) => {
  /** 待返回给调用方的更新结果 */
  let mutationResult;
  writeQueue = writeQueue.catch(() => {}).then(async () => {
    /** 变更前的最新注册表 */
    const registry = await readRegistry();
    mutationResult = await mutator(registry);
    /** 本次写入使用的临时文件 */
    const temporaryPath = `${registryPath}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(registry, null, 2)}\n`, 'utf8');
    await rename(temporaryPath, registryPath);
  });
  await writeQueue;
  return mutationResult;
};

/** 根据接口编号在所有项目中定位接口及其所属项目 */
export const findEndpoint = (registry, endpointId) => {
  for (const project of registry.projects) {
    /** 当前项目中命中的接口 */
    const endpoint = project.endpoints.find((item) => item.id === endpointId);
    if (endpoint) return { project, endpoint };
  }
  return null;
};

/** 根据固定或顺序模式选择本次应返回的响应场景 */
export const selectVariant = (endpoint) => {
  if (endpoint.mode !== 'sequence') {
    return endpoint.variants.find((item) => item.id === endpoint.activeVariantId) ?? endpoint.variants[0];
  }
  /** 顺序响应允许访问的最大下标 */
  const lastIndex = Math.max(endpoint.variants.length - 1, 0);
  /** 当前请求命中的安全下标 */
  const selectedIndex = Math.min(endpoint.sequence.currentIndex, lastIndex);
  return endpoint.variants[selectedIndex];
};

/** 计算一次顺序响应完成后的下一下标 */
export const getNextSequenceIndex = (endpoint) => {
  /** 顺序响应允许访问的最大下标 */
  const lastIndex = Math.max(endpoint.variants.length - 1, 0);
  if (endpoint.sequence.currentIndex < lastIndex) return endpoint.sequence.currentIndex + 1;
  if (endpoint.sequence.afterEnd === 'loop') return 0;
  return lastIndex;
};
