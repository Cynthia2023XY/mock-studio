# AI 配置说明（Codex / macOS）

本套件包含两个 Skill；Mock Studio 安装包包含可由 Skill 脚本调用的本地 CLI。Chrome DevTools MCP 是独立工具，需要另外安装和配置。以下以本机 Codex 为例，其他 AI 客户端请参考其 Skill 与 MCP 文档。

## 1. 安装应用与 Skill

先按《安装与使用说明.md》安装并启动 Mock Studio 和 Whistle。在 Finder 中打开分享包的 `skills` 文件夹，将 `mock-studio` 与 `page-analysis` 两个文件夹复制到当前用户的 `~/.codex/skills/`；如果已有同名 Skill，请先比较并备份，不要直接覆盖。目录不存在时可先创建。重启或新建 Codex 会话，按实际界面确认能够发现这两个 Skill。

在终端验证安装版 CLI（不会输出管理令牌）：

```bash
"$HOME/.codex/skills/mock-studio/scripts/mock-studio" help --json
"$HOME/.codex/skills/mock-studio/scripts/mock-studio" list --json
```

CLI 默认读取 `/Applications/Mock Studio.app` 的程序和当前用户的桌面版令牌。需要先打开应用；若安装到其他位置，可通过 `MOCK_STUDIO_APP_PATH` 指向该 `.app`。CLI 报错时先检查应用是否运行，不要复制别人的令牌。CLI 的结果包含项目配置，请勿将敏感内容公开。

## 2. 配置 Chrome DevTools MCP

按 [Chrome DevTools MCP 官方说明](https://github.com/ChromeDevTools/chrome-devtools-mcp) 准备兼容版本的 Node.js、npm 和 Chrome。注意：使用桌面应用和它自带的 Mock CLI 不要求另装 Node；运行下面的 `npx` 方式则需要本机 Node.js 和 npm，以及访问 npm 的网络。

在本机 Codex CLI 中，先用 `codex mcp list` 检查是否已有同名或可用的 Chrome DevTools MCP，避免重复配置。没有时可执行：

```bash
codex mcp add chrome-devtools -- npx -y chrome-devtools-mcp@latest
codex mcp list
```

安装包不包含 MCP 服务或 Node；上面的命令会从 npm 获取 MCP，`@latest` 会随时间更新。重启相关 Codex 会话后，让 AI 列出浏览器页面验证工具能否使用。其他 AI 客户端请参考 [MCP 客户端配置](https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/main/docs/client-configurations.md)。

在目标浏览器中完成 Whistle 代理和 HTTPS 证书设置，确认 MCP 实际连接到该浏览器；如果 MCP 自己启动了新的浏览器实例，不能假设它已经继承代理或登录状态。详见 [Chrome MCP 浏览器和代理选项](https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/main/docs/configuration.md)。不要为连接而关闭其他人的浏览器，或复用不属于自己的登录配置。

## 3. 试用

可向 AI 提出：

> 使用 mock-studio Skill 和 Chrome DevTools MCP，先只读检查我本机 Mock Studio、Whistle 与浏览器配置。确认后，帮我导入示例场景包并验证示例接口是否命中。

AI 应确认用户提供的包路径，预览后导入新项目，再按授权启用。每次检查返回的 `sync.ok`、请求响应和命中记录。没有代理的浏览器、未信任证书或 URL 不匹配都可能导致未命中。不要将示例的 `demo.mock-studio.test` 地址替换为真实交易接口来做测试。

本包尚未在另一台全新 Mac 上端到端验证；本说明不代表 MCP、Whistle 和目标浏览器在任意环境下已配置成功。
