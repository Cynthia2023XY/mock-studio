#!/usr/bin/env node

import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/** Mock Studio 项目所在目录 */
const projectDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 启动器使用的当前 Node 可执行文件 */
const runtimePath = process.execPath;

/** 快捷启动器保存运行信息的目录 */
const stateDirectory = path.join(homedir(), '.mock-studio');

/** 后台服务主进程编号文件 */
const pidPath = path.join(stateDirectory, 'mock-studio.pid');

/** 后台服务输出日志文件 */
const logPath = path.join(stateDirectory, 'mock-studio.log');

/** Mock Studio 可视化页面地址 */
const webUrl = 'http://127.0.0.1:3000/';

/** Mock Studio 管理服务端口 */
const apiPort = 17321;

/** Mock Studio 页面服务端口 */
const webPort = 3000;

/** Whistle 默认代理端口 */
const whistlePort = 8888;

/** 用户输入的启动器操作，默认执行启动 */
const command = process.argv[2] ?? 'start';

/** 检查指定本地端口当前是否已被监听 */
const isPortOpen = (port) => new Promise((resolve) => {
  /** 本次端口探测使用的 TCP 连接 */
  const socket = net.createConnection({ host: '127.0.0.1', port });
  socket.setTimeout(500);
  socket.once('connect', () => {
    socket.destroy();
    resolve(true);
  });
  socket.once('timeout', () => {
    socket.destroy();
    resolve(false);
  });
  socket.once('error', () => resolve(false));
});

/** 从状态文件读取由快捷启动器管理的主进程编号 */
const readManagedPid = () => {
  try {
    return Number(readFileSync(pidPath, 'utf8').trim());
  } catch {
    return null;
  }
};

/** 判断指定进程当前是否仍然存活 */
const isProcessAlive = (pid) => {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** 等待本地端口在限定时间内进入指定状态 */
const waitForPortState = async (port, expectedOpen, timeoutMs = 15000) => {
  /** 等待开始时间 */
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await isPortOpen(port) === expectedOpen) return true;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
};

/** 使用默认浏览器打开 Mock Studio 管理页面 */
const openDashboard = () => {
  spawnSync('open', [webUrl], { stdio: 'ignore' });
};

/** 确认 Whistle 正在运行，必要时尝试启动桌面客户端 */
const ensureWhistle = async () => {
  if (await isPortOpen(whistlePort)) return true;
  console.log('Whistle 尚未运行，正在尝试打开桌面客户端…');
  spawnSync('open', ['-a', 'Whistle'], { stdio: 'ignore' });
  /** Whistle 自动启动后的端口就绪状态 */
  const ready = await waitForPortState(whistlePort, true, 12000);
  if (!ready) console.warn('提示：Whistle 端口 8888 尚未就绪，Mock Studio 仍会启动，但页面请求暂时不会被代理。');
  return ready;
};

/** 后台启动 Mock Studio 并在就绪后打开管理页面 */
const startStudio = async () => {
  /** 管理 API 当前是否已经运行 */
  const apiRunning = await isPortOpen(apiPort);
  /** 管理页面当前是否已经运行 */
  const webRunning = await isPortOpen(webPort);
  if (apiRunning && webRunning) {
    console.log(`Mock Studio 已经运行：${webUrl}`);
    openDashboard();
    return;
  }
  if (apiRunning || webRunning) {
    throw new Error(`端口 ${apiRunning ? apiPort : webPort} 已被其他进程占用，请先关闭冲突进程。`);
  }
  await ensureWhistle();
  mkdirSync(stateDirectory, { recursive: true });
  /** 后台日志文件描述符 */
  const logDescriptor = openSync(logPath, 'a');
  /** 负责同时管理前端和 API 的后台主进程 */
  const childProcess = spawn(runtimePath, ['scripts/dev.mjs'], {
    cwd: projectDirectory,
    detached: true,
    env: { ...process.env },
    stdio: ['ignore', logDescriptor, logDescriptor],
  });
  closeSync(logDescriptor);
  if (!childProcess.pid) throw new Error('后台进程创建失败');
  writeFileSync(pidPath, String(childProcess.pid), 'utf8');
  childProcess.unref();
  /** 前端和管理 API 是否均已启动完成 */
  const ready = await Promise.all([waitForPortState(apiPort, true), waitForPortState(webPort, true)]);
  if (ready.every(Boolean)) {
    console.log(`Mock Studio 启动成功：${webUrl}`);
    console.log(`日志文件：${logPath}`);
    openDashboard();
    return;
  }
  throw new Error(`启动超时，请查看日志：${logPath}`);
};

/** 停止由快捷启动器启动的全部 Mock Studio 服务 */
const stopStudio = async () => {
  /** 快捷启动器记录的后台主进程编号 */
  const pid = readManagedPid();
  if (!isProcessAlive(pid)) {
    if (await isPortOpen(apiPort) || await isPortOpen(webPort)) {
      console.log('Mock Studio 正在运行，但不是由快捷启动器启动，请在原终端按 Ctrl+C 停止。');
      return;
    }
    if (pid) unlinkSync(pidPath);
    console.log('Mock Studio 当前未运行。');
    return;
  }
  /** 已通过存活检查的后台主进程编号 */
  const processId = Number(pid);
  process.kill(-processId, 'SIGTERM');
  await Promise.all([waitForPortState(apiPort, false, 8000), waitForPortState(webPort, false, 8000)]);
  try { unlinkSync(pidPath); } catch { /* 状态文件可能已被其他退出流程清理 */ }
  console.log('Mock Studio 已停止。');
};

/** 输出 Mock Studio、Whistle 和后台进程的当前状态 */
const printStatus = async () => {
  /** 快捷启动器记录的后台主进程编号 */
  const pid = readManagedPid();
  /** 当前服务状态汇总 */
  const status = {
    studio: await isPortOpen(apiPort) && await isPortOpen(webPort) ? '运行中' : '未运行',
    managedPid: isProcessAlive(pid) ? pid : '无',
    whistle: await isPortOpen(whistlePort) ? '已连接' : '未连接',
    dashboard: webUrl,
    log: logPath,
  };
  console.table(status);
};

/** 根据用户命令执行启动、停止、重启、状态查询或打开页面 */
const run = async () => {
  if (command === 'start') return startStudio();
  if (command === 'stop') return stopStudio();
  if (command === 'restart') {
    await stopStudio();
    return startStudio();
  }
  if (command === 'status') return printStatus();
  if (command === 'open') {
    if (!await isPortOpen(webPort)) throw new Error('Mock Studio 尚未运行，请先执行 mock-studio start');
    openDashboard();
    return;
  }
  if (command === 'logs') {
    console.log(logPath);
    return;
  }
  console.log('用法：mock-studio start|stop|restart|status|open|logs');
};

run().catch((error) => {
  console.error(`Mock Studio 操作失败：${error instanceof Error ? error.message : error}`);
  process.exitCode = 1;
});
