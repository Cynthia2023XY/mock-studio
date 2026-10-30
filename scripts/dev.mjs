import { spawn } from 'node:child_process';
import net from 'node:net';
import { readRegistry } from '../server/store.mjs';

/** 启动前检查固定端口，避免页面失败后仍修改 Whistle 规则 */
const checkPort = (port) => new Promise((resolve, reject) => {
  // 监听失败时报告冲突；真正启动仍需处理端口竞争。
  const probe = net.createServer();
  probe.once('error', (error) => reject(new Error(`无法监听 127.0.0.1:${port}：${error.message}`)));
  probe.listen(port, '127.0.0.1', () => probe.close(resolve));
});

/** 注册表中的本地服务配置 */
const registry = await readRegistry();
try {
  await checkPort(3000);
  await checkPort(registry.settings.apiPort);
} catch (error) {
  console.error(`[Mock Studio] 启动失败：${error.message}`);
  process.exit(1);
}

/** 本地 Mock API 服务进程 */
const apiProcess = spawn(process.execPath, ['server/index.mjs'], {
  stdio: 'inherit',
});

/** 可视化前端开发服务进程 */
const webProcess = spawn(process.execPath, ['node_modules/vinext/dist/cli.js', 'dev', '--host', '127.0.0.1'], {
  stdio: 'inherit',
});

/** 需要在退出时统一回收的子进程 */
const childProcesses = [apiProcess, webProcess];

/** 关闭本地开发服务并透传退出信号 */
const stopChildren = (signal) => {
  childProcesses.forEach((childProcess) => childProcess.kill(signal));
};

process.on('SIGINT', () => stopChildren('SIGINT'));
process.on('SIGTERM', () => stopChildren('SIGTERM'));

/** 监听子进程异常退出，避免留下半运行状态 */
const watchChild = (childProcess, label) => {
  childProcess.on('exit', (code, signal) => {
    if (code !== 0 && signal === null) {
      console.error(`[Mock Studio] ${label} exited with code ${code}`);
      stopChildren('SIGTERM');
      process.exitCode = code ?? 1;
    }
  });
};

watchChild(apiProcess, 'API');
watchChild(webProcess, 'Web');
