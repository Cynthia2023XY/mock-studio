---
name: mock-studio
description: 使用 macOS 桌面版 Mock Studio 管理本地 JSON Mock、组合与场景包，调试网页接口并验证命中；不用于真实交易。
---

# Mock Studio 桌面版

先确认 Mock Studio 和独立 Whistle 已启动。管理 API 位于 `127.0.0.1:17321`。桌面版数据和管理令牌位于当前用户的 `~/Library/Application Support/Mock Studio/`；不要读取或打印令牌，也不要直接修改注册表或 Whistle 托管文件。

将本 skill 目录下的 `scripts/mock-studio` 作为 CLI，以下称为 `<CLI>`。它使用 `/Applications/Mock Studio.app` 自带运行时，无需本机 Node。先运行 `"<CLI>" help --json` 和 `"<CLI>" list --json`，以当前命令和配置为准。缺少应用、令牌或服务时，说明情况，不假定开发版路径或运行 `npm run mock`。需要完整命令、场景包和兼容行为时读 [CLI 与场景包](references/cli-and-packages.md)。

## 工作流程

1. 如需分析真实页面，先用当前会话可用的浏览器工具确认 URL、请求方法、完整响应与触发时机。Chrome DevTools MCP 可用于检查页面，但不是本 skill 自带的工具。确认目标浏览器经过 Whistle，HTTPS 已配置证书和解密。
2. 单条请求使用独立 Mock；多条严格顺序请求使用引用已有 Mock 的高级组合。共享状态旧流程继续使用原 flow/state，不把它机械替换为严格组合。匹配时方法相同；精确匹配完整规范化 URL（含查询串），模糊匹配为大小写敏感的字面包含。优先级是启用组合、普通 Mock 顺序、旧接口。
3. 先检查现有项目和冲突，保留无关配置。新建项目、Mock、组合默认关闭；按用户授权启用项目和目标规则。一个项目至多启用一个组合；组合进度在项目内共享，其他请求仍可能透传。组合步骤不匹配时返回 409，不推进进度。
4. 检查写操作返回的 `sync.ok`；配置已保存不等于 Whistle 同步成功。通过 CLI `hits <项目ID> --json`、响应头 `x-mock-source`、`x-mock-hit-id` 和浏览器实际响应验证命中。没有角标不能单独证明失败；Mock 命中不代表真实业务成功。
5. 场景包先预览再应用；新项目及 v2 规则默认关闭。保留返回的 `snapshotId` 和 ID 映射，避免覆盖已有项目；显式替换前检查影响。分享前检查 URL、响应及截图中的敏感数据。

未获授权且未确认目标写接口被接管时，不触发真实购买、支付、领取等写操作。组合无关请求、方法或 URL 不匹配时可能透传。说明实际测试覆盖和未验证环节。
