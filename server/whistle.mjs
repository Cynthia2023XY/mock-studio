import { mkdir, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import http from 'node:http';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** 当前模块所在目录 */
const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));

/** 自动生成的 Whistle 规则文件目录 */
const generatedDirectory = path.resolve(moduleDirectory, '../data/generated');

/** 自动生成的 Whistle JS 配置文件 */
const generatedRulesPath = path.join(generatedDirectory, 'mock-studio.whistle.js');

/** Whistle 桌面客户端内置的命令行入口 */
const whistleCliPath = '/Applications/Whistle.app/Contents/Resources/app/node_modules/whistle/bin/whistle.js';

/** Whistle 客户端提供的连接配置与认证工具 */
const requireModule = createRequire(import.meta.url);

/** 注入业务页面的命中提示脚本 */
const noticeScriptPath = path.resolve(moduleDirectory, 'mock-notice.js');

/** 将接口 URL 转义为 Whistle 规则中的安全文本 */
const escapeRuleValue = (value) => String(value).replace(/\s/g, encodeURIComponent);

/** 根据注册表生成所有启用接口的 Whistle 转发规则 */
export const compileWhistleRules = (registry) => registry.projects
  .filter((project) => project.enabled)
  .flatMap((project) => {
    // 仅在配置了页面地址且存在启用接口时注入提示脚本。
    const endpoints = project.endpoints.filter((endpoint) => endpoint.enabled);
    // 接口拦截规则与页面提示规则共享项目开关。
    const rules = endpoints.map((endpoint) => `${escapeRuleValue(endpoint.url)} http://127.0.0.1:${registry.settings.apiPort}/runtime/respond/${endpoint.id} includeFilter://m:${endpoint.method}`);
    if (endpoints.length && project.pageUrl) rules.push(`${escapeRuleValue(project.pageUrl)} jsPrepend://${escapeRuleValue(noticeScriptPath)} includeFilter://m:GET`);
    return rules;
  })
  .join('\n');

/** 生成 Whistle 可覆盖旧规则的配置，空规则使用无副作用的注释占位 */
export const renderWhistleConfig = (rules) => {
  // Whistle 的 project 接口忽略空字符串，因此空配置也必须发送非空文本。
  const content = rules || '# Mock Studio: 当前没有启用的规则';
  return `/** Mock Studio 自动生成规则，请勿手工编辑 */\nexports.name = 'mock-studio-managed'\n\n/** 当前已启用接口的转发规则 */\nexports.rules = \`${content}\`\n`;
};

/** 从 Whistle 客户端回读托管规则，确认旧规则确实已被覆盖 */
const readManagedRules = async () => {
  // 复用客户端配置，确保回读的是 add --client 使用的同一个代理。
  const client = requireModule('/Applications/Whistle.app/Contents/Resources/app/node_modules/whistle/bin/use.js');
  const config = await new Promise((resolve, reject) => client.getConfig(true, (error, value) => error ? reject(error) : resolve(value)));
  // 请求只读取当前工具管理的规则组，不影响用户其他规则。
  const options = client.getReqOpts(config.options, 'rules/value?name=mock-studio-managed');
  return new Promise((resolve, reject) => {
    // 使用客户端内部配置的本机连接及认证头读取规则内容。
    const request = http.get(options, (response) => {
      // 合并规则管理接口的响应正文。
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('error', reject);
      response.on('end', () => {
        try {
          // 服务端返回的规则正文与启用状态。
          const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (response.statusCode !== 200 || !result.value) throw new Error('无法读取 Whistle 托管规则');
          resolve(result.value);
        } catch (error) { reject(error); }
      });
    });
    request.setTimeout(8000, () => request.destroy(new Error('回读 Whistle 规则超时')));
    request.on('error', reject);
  });
};

/** 生成规则文件，并尝试同步到已运行的 Whistle 桌面客户端 */
export const syncWhistleRules = async (registry) => {
  if (process.env.MOCK_STUDIO_NO_WHISTLE === '1') return { ok: true, rulesPath: '', ruleCount: 0, message: '测试环境未同步 Whistle' };
  /** 本次生成的规则正文 */
  const rules = compileWhistleRules(registry);
  /** 可被 w2 add 识别的 JS 配置内容 */
  const source = renderWhistleConfig(rules);
  await mkdir(generatedDirectory, { recursive: true });
  await writeFile(generatedRulesPath, source, 'utf8');
  /** Whistle CLI 同步执行结果 */
  const result = spawnSync(process.execPath, [whistleCliPath, 'add', generatedRulesPath, '--client', '--force'], {
    encoding: 'utf8',
    timeout: 8000,
  });
  /** 同步失败时用于界面展示的错误文本 */
  const errorMessage = result.error?.message || result.stderr?.trim() || result.stdout?.trim() || '';
  if (result.status === 0) {
    try {
      // 将实际保存的规则与本次期望内容比较，禁止把静默失败显示为同步成功。
      const actual = await readManagedRules();
      const expected = rules || '# Mock Studio: 当前没有启用的规则';
      if (actual.value.trim() !== expected.trim() || !actual.selected) throw new Error('Whistle 托管规则内容或启用状态不一致');
    } catch (error) {
      return { ok: false, rulesPath: generatedRulesPath, ruleCount: rules ? rules.split('\n').length : 0, message: `规则已提交，但验证 Whistle 失败：${error instanceof Error ? error.message : String(error)}` };
    }
  }
  return {
    ok: result.status === 0,
    rulesPath: generatedRulesPath,
    ruleCount: rules ? rules.split('\n').length : 0,
    message: result.status === 0 ? '规则已同步到 Whistle 客户端' : `规则文件已生成，Whistle 同步失败：${errorMessage}`,
  };
};
