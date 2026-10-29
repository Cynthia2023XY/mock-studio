import { spawn } from 'node:child_process';

/** 项目要求的 Node 24 可执行文件目录 */
const runtimeBin = '/Users/dingxinyi.2/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin';

/** 子进程统一使用的运行环境 */
const childEnvironment = { ...process.env, PATH: `${runtimeBin}:${process.env.PATH ?? ''}` };

/** 本地 Mock API 服务进程 */
const apiProcess = spawn(process.execPath, ['server/index.mjs'], {
  env: childEnvironment,
  stdio: 'inherit',
});

/** 可视化前端开发服务进程 */
const webProcess = spawn(process.execPath, ['node_modules/vinext/dist/cli.js', 'dev', '--host', '127.0.0.1'], {
  env: childEnvironment,
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
