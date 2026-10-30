import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';

test('首次读取创建空注册表，重复读取保留用户数据，显式路径缺失时报错', async (t) => {
  // 在独立目录运行真实存储模块，不触碰用户的注册表。
  const directory = await mkdtemp(path.join(tmpdir(), 'mock-studio-init-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(path.join(directory, 'server'));
  await mkdir(path.join(directory, 'desktop'));
  await mkdir(path.join(directory, 'data'));
  await Promise.all(['store.mjs', 'model.mjs', 'rules.mjs'].map((file) => copyFile(new URL(file, import.meta.url), path.join(directory, 'server', file))));
  await copyFile(new URL('../desktop/empty-registry.json', import.meta.url), path.join(directory, 'desktop/empty-registry.json'));
  // 子进程避免模块缓存和当前环境影响默认路径测试。
  const environment = { ...process.env };
  delete environment.MOCK_STUDIO_REGISTRY;
  const run = (env = environment) => spawnSync(process.execPath, ['--input-type=module', '-e', "import { readRegistry } from './server/store.mjs'; await readRegistry()"], { cwd: directory, env, encoding: 'utf8' });
  assert.equal(run().status, 0);
  const registryPath = path.join(directory, 'data/registry.json');
  const registry = JSON.parse(await readFile(registryPath, 'utf8'));
  assert.deepEqual(registry.projects, []);
  registry.projects.push({ id: 'preserved', endpoints: [], mocks: [], combinations: [] });
  await writeFile(registryPath, JSON.stringify(registry));
  assert.equal(run().status, 0);
  assert.equal(JSON.parse(await readFile(registryPath, 'utf8')).projects[0].id, 'preserved');
  assert.notEqual(run({ ...environment, MOCK_STUDIO_REGISTRY: path.join(directory, 'missing.json') }).status, 0);
});
