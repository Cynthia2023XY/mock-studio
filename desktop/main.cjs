const { app, BrowserWindow, dialog, shell } = require('electron');
const { spawn, spawnSync } = require('node:child_process');
const { mkdirSync, existsSync, copyFileSync, writeFileSync, openSync, closeSync } = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');

/** 已打包的应用代码目录 */
const sourceDirectory = path.join(__dirname, '..');
/** 用户可写且升级后保留的应用数据目录 */
const dataDirectory = app.getPath('userData');
/** 本地管理页面端口 */
const webPort = 3000;
/** 本地 Mock 服务端口 */
const apiPort = 17321;
/** Whistle 客户端内置命令路径 */
const whistleCli = '/Applications/Whistle.app/Contents/Resources/app/node_modules/whistle/bin/whistle.js';
/** 当前应用管理的服务进程 */
let apiProcess;
/** 管理页面的本地静态服务 */
let webServer;
/** 主应用窗口 */
let mainWindow;

/** 检查本地端口是否可以由本应用独占使用 */
const checkPort = (port) => new Promise((resolve, reject) => {
  // 先探测再关闭，真正启动失败时仍由监听错误处理端口竞争。
  const probe = net.createServer();
  probe.once('error', () => reject(new Error(`端口 ${port} 已被占用，请关闭冲突程序后重试。`)));
  probe.listen(port, '127.0.0.1', () => probe.close(resolve));
});

/** 初始化独立注册表、令牌和规则存储目录 */
const prepareData = () => {
  // 用户的已有数据不会在更新或重复启动时被覆盖。
  const generated = path.join(dataDirectory, 'generated');
  const registry = path.join(dataDirectory, 'registry.json');
  mkdirSync(generated, { recursive: true, mode: 0o700 });
  if (!existsSync(registry)) copyFileSync(path.join(__dirname, 'empty-registry.json'), registry);
  writeFileSync(path.join(generated, 'package.json'), '{"type":"commonjs"}\n');
  return { generated, registry };
};

/** 引导安装 Whistle 并在必要时启动已安装的客户端 */
const prepareWhistle = async () => {
  if (!existsSync(whistleCli)) {
    // 没有 Whistle 时仍可打开控制台准备或导入数据。
    const answer = await dialog.showMessageBox({ type: 'info', title: '安装 Whistle', message: '未找到 Whistle 桌面客户端', detail: '请将 Whistle 安装到“应用程序”目录。安装后重新打开 Mock Studio，并在 Whistle 中配置代理和 HTTPS 证书。', buttons: ['打开下载页面', '稍后安装'], defaultId: 0 });
    if (answer.response === 0) await shell.openExternal('https://github.com/avwo/whistle-client/releases');
    return;
  }
  // 首次使用时说明代理和证书仍需在 Whistle 中完成配置。
  const guidePath = path.join(dataDirectory, 'whistle-guide-shown');
  if (!existsSync(guidePath)) {
    await dialog.showMessageBox({ type: 'info', title: '首次使用', message: '请在 Whistle 中完成代理和 HTTPS 配置', detail: '启动后请在 Whistle 中设置浏览器或系统代理，并按需要安装、信任根证书。Mock Studio 显示规则已同步后，还需确认目标浏览器实际经过该代理。', buttons: ['知道了'] });
    mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
    writeFileSync(guidePath, '1\n', { mode: 0o600 });
  }
  // macOS 的 open 会复用已运行的客户端，不创建第二个代理实例。
  spawnSync('open', ['-a', '/Applications/Whistle.app'], { stdio: 'ignore' });
  // 给客户端时间建立本地代理，实际同步结果仍由管理服务校验。
  // 限制等待次数，避免客户端无法启动时一直阻塞应用。
  for (let attempt = 0; attempt < 40; attempt += 1) {
    // 探测代理是否已开始监听，不把端口就绪当成规则同步成功。
    const ready = await new Promise((resolve) => {
      // 与本机默认代理端口建立短连接。
      const socket = net.connect(8888, '127.0.0.1');
      socket.setTimeout(300);
      socket.once('connect', () => { socket.destroy(); resolve(true); });
      socket.once('error', () => resolve(false));
      socket.once('timeout', () => { socket.destroy(); resolve(false); });
    });
    if (ready) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
};

/** 等待管理 API 就绪，同时检查子进程是否提前退出 */
const waitForApi = async () => {
  // 等待服务监听，超时后报告启动失败。
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (apiProcess.exitCode !== null) throw new Error('Mock 服务启动失败，请检查应用日志。');
    // 管理接口返回 401 也代表本机服务已经开始监听。
    const ready = await new Promise((resolve) => {
      // 本机健康探测不携带管理令牌。
      const request = http.get(`http://127.0.0.1:${apiPort}/api/state`, (response) => { response.resume(); resolve(response.statusCode === 401); });
      request.on('error', () => resolve(false));
      request.setTimeout(300, () => request.destroy());
    });
    if (ready) return;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error('Mock 服务启动超时，请检查 Whistle 和应用日志。');
};

/** 启动生产构建后的本地页面和 Mock 管理服务 */
const startServices = async () => {
  await checkPort(webPort);
  await checkPort(apiPort);
  // 仅将当前用户数据路径传给子进程，避免修改源码目录。
  const locations = prepareData();
  // 将启动和同步错误保存在当前用户的数据目录，方便排查。
  const logDescriptor = openSync(path.join(dataDirectory, 'service.log'), 'a', 0o600);
  apiProcess = spawn(process.execPath, [path.join(sourceDirectory, 'server', 'index.mjs')], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', MOCK_STUDIO_REGISTRY: locations.registry, MOCK_STUDIO_TOKEN_PATH: path.join(dataDirectory, 'api-token'), MOCK_STUDIO_GENERATED_DIRECTORY: locations.generated, MOCK_STUDIO_WHISTLE_CLI: whistleCli, MOCK_STUDIO_CLEAR_ON_EXIT: '1' },
    stdio: ['ignore', logDescriptor, logDescriptor],
  });
  closeSync(logDescriptor);
  await waitForApi();
  // 只提供已构建的固定静态资源，拒绝目录穿越和其他本地文件。
  const staticRoot = path.join(sourceDirectory, 'desktop-dist');
  webServer = http.createServer((request, response) => {
    // 解析请求路径并将首页映射到构建入口。
    const pathname = new URL(request.url, 'http://127.0.0.1').pathname;
    // 仅允许访问构建生成的页面和静态资源。
    const relative = ['/', '/demo', '/demo/'].includes(pathname) ? 'index.html' : pathname.slice(1);
    if (!/^(index\.html|assets\/[a-zA-Z0-9_.-]+)$/.test(relative)) { response.writeHead(404).end(); return; }
    // 构建目录内的实际资源文件。
    const file = path.join(staticRoot, relative);
    // 根据资源类型设置浏览器可识别的内容类型。
    const extension = path.extname(file);
    response.setHeader('Content-Type', ({ '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' })[extension] || 'application/octet-stream');
    require('node:fs').createReadStream(file).on('error', () => response.writeHead(404).end()).pipe(response);
  });
  await new Promise((resolve, reject) => { webServer.once('error', reject); webServer.listen(webPort, '127.0.0.1', resolve); });
};

/** 创建受限的桌面窗口并加载本地管理界面 */
const openWindow = async () => {
  mainWindow = new BrowserWindow({ width: 1440, height: 900, minWidth: 900, minHeight: 650, title: 'Mock Studio', webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true } });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event, url) => { if (!url.startsWith('http://127.0.0.1:3000/')) event.preventDefault(); });
  await mainWindow.loadURL('http://127.0.0.1:3000/');
};

/** 防止重复启动的实例与已有本地端口发生冲突 */
const ownsLock = app.requestSingleInstanceLock();
if (!ownsLock) app.quit();
else {
  app.on('second-instance', () => { if (mainWindow) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.focus(); } });
  app.whenReady().then(async () => { await prepareWhistle(); await startServices(); await openWindow(); }).catch((error) => { dialog.showErrorBox('Mock Studio 启动失败', error.message); app.quit(); });
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', () => { if (webServer) webServer.close(); if (apiProcess && apiProcess.exitCode === null) apiProcess.kill('SIGTERM'); });
}
