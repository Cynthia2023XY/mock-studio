# Mock Studio

一个面向页面联调的本地 Mock 控制台。它以独立 JSON Mock 为主对象，用引用规则的高级组合编排严格执行步骤；固定、顺序和共享状态的旧版接口仍可兼容运行。Whistle 负责候选请求转发，统一分发器负责最终匹配与进度。

## 独立规则与高级组合（schemaVersion 2）

- 「添加 Mock」在同一个侧栏编辑名称、方法、精确/模糊匹配、状态码、延迟、响应头和 JSON；支持文件导入、校验和未保存提醒。
- 行顺序决定普通规则的优先级，支持拖拽与上下移动。新规则默认关闭。
- 「新建高级组合 Mock」只引用已有规则，允许同一规则被多个独立步骤重复引用；新组合默认关闭。
- 每个项目至多启用一个组合，组合先于普通规则；被引用规则可以自身关闭。关闭组合不改写单条规则原有开关。
- 组合按项目全局共享进度，多个页面会共同推进。只有当前步骤匹配才推进；请求匹配其他步骤时返回 `409 / COMBINATION_ORDER_MISMATCH` 并记录实际与预期步骤，不冒充成功命中。
- 完全无关的请求继续匹配普通规则，没有命中则回源；过期代理规则指向分发器时也支持回源，不泄漏内部头。
- 跨项目精确、模糊或旧前缀规则有重叠时阻止启用。两个模糊条件可能同时出现在一个 URL 中，因此跨项目模糊规则保守判为潜在冲突。
- 删除被引用规则会列出组合并阻止删除；编辑时显示影响范围，组合下一次请求使用修改后的响应。
- 首页移除了同步、重置项目、流程配置和页面提示按钮；代理继续自动同步。场景包导入/导出与旧数据迁移位于项目菜单。

**匹配规则**：方法必须相同。URL 用 `new URL().href` 规范化，协议/域名小写、移除默认端口及片段，路径大小写、百分号编码大小写和查询参数顺序保留。精确匹配比较整个规范化 URL（含查询串）；模糊匹配为大小写敏感的完整 URL 字符串包含。匹配文本最长 2048 字符，拒绝控制字符，不提供自定义正则。

```bash
npm run mock -- mock-add <项目ID> ./mock.json --json
npm run mock -- mock-update <项目ID> <MockID> ./patch.json --json
npm run mock -- mock-enable <项目ID> <MockID> --json
npm run mock -- mock-clone <项目ID> <MockID> --json
npm run mock -- mock-order <项目ID> <MockID,MockID,...> --json
npm run mock -- combination-add <项目ID> ./combination.json --json
npm run mock -- combination-update <项目ID> <组合ID> ./patch.json --json
npm run mock -- combination-enable <项目ID> <组合ID> --json
npm run mock -- combination-reset <项目ID> <组合ID> --json
```

Mock 配置示例：

```json
{
  "name": "首页查询-领取前",
  "method": "POST",
  "match": { "type": "contains", "value": "queryBullMarketFundExpHome" },
  "response": { "status": 200, "delayMs": 500, "headers": {}, "body": { "status": "未领取" } }
}
```

组合配置示例（`mockId` 替换为已有规则编号）：

```json
{
  "name": "领取流程",
  "steps": [
    { "id": "step-1", "mockId": "home-before" },
    { "id": "step-2", "mockId": "receive-success" },
    { "id": "step-3", "mockId": "home-after" }
  ],
  "afterEnd": "hold-last"
}
```

## 旧数据迁移与恢复

读取旧注册表只在内存补齐集合，不自动把旧场景转换成新规则。旧版固定/顺序/state 接口与原 CLI 继续可用；含 `flow` 或 `state` 的项目保持旧版运行，不机械迁移。

固定/顺序项目可在项目菜单预览迁移，或使用：

```bash
npm run mock -- migration-preview <项目ID> --json
npm run mock -- migration-apply <项目ID> '<预览返回的fingerprint>' --json
```

预览列出稳定 ID 映射、开关、顺序位置及语义差异。旧代理使用 URL 前缀，迁移后改为完整精确匹配，额外参数会改变命中结果，因此必须明确检查预览。启用的多个旧顺序接口需要先停用至最多一个。应用时校验预览指纹、使用最新运行进度，并先把原始注册表备份到返回的 `backupPath`，再原子替换；重复迁移不会生成副本。迁移后的旧接口命令返回 `410 / MIGRATED_ENDPOINT`，避免无效操作显示成功。恢复整个备份文件前应停止服务并自行保留迁移后的修改；场景包导入仍使用原有快照恢复机制。

新版场景包 `version: 2` 同时包含 `mocks`、`combinations` 和兼容的 `endpoints/flow`；导入进行引用校验与编号映射，新规则和组合默认关闭，旧版 `version: 1` 包仍可导入。

## 从源码启动（macOS）

适合可以使用终端和 Git 的开发者。首次使用需要 Node.js、npm 和 Whistle；后续只需打开 Whistle、进入项目运行 `npm run dev`。当前尚未完成 Windows 和 Intel macOS 的新设备验收。

### 首次安装

1. 安装 Node.js 24（项目要求 Node.js >= 22.13.0）和 Git。执行 `node -v`、`npm -v` 确认终端可以找到它们。
2. 下载 [Whistle 桌面客户端](https://github.com/avwo/whistle-client/releases)，将 `Whistle.app` 放入 `/Applications` 并打开。源码版默认从该路径调用客户端内置的 Whistle CLI；需要自定义路径时，可在启动前设置 `MOCK_STUDIO_WHISTLE_CLI` 为其 `bin/whistle.js` 的绝对路径。
3. 确保账号有仓库访问权限，执行：

   ```bash
   git clone https://github.com/Cynthia2023XY/mock-studio.git
   cd mock-studio
   npm ci
   npm run dev
   ```

4. 在浏览器打开 <http://127.0.0.1:3000/>。管理 API 使用 `127.0.0.1:17321`，Whistle 默认代理端口为 `8888`。源码版不会自动启动 Whistle；应先打开客户端，并确认控制台显示规则同步成功。

首次启动从 `desktop/empty-registry.json` 创建空的 `data/registry.json`。该文件和迁移备份只保存在本地，重复启动不会覆盖。可以在项目菜单导入场景包，也可以自行创建项目和 Mock；首次使用不会自动获得其他人的配置。

从曾经跟踪 `data/registry.json` 的旧版本升级前，请先将该文件复制到项目目录之外备份：Git 拉取删除跟踪文件的提交时可能移除旧文件。升级后可在服务停止时将备份恢复到 `data/registry.json`。停止跟踪只影响后续提交，旧 Git 历史中已有的数据仍然存在；公开或分享历史前应检查其内容。

### 验证代理是否命中

1. 在控制台新建项目，添加一条 `GET`、精确匹配 `http://mock-studio.test/api/check` 的 Mock，响应 JSON 填写 `{"ok":true}`，启用这条规则和项目总开关，并检查规则同步成功。
2. 在本机另开终端执行（将 `8888` 改为 Whistle 实际端口）：

   ```bash
   curl -i --noproxy '' -x http://127.0.0.1:8888 http://mock-studio.test/api/check
   ```

   应看到 JSON 响应和 `x-mock-source` 响应头，控制台应出现命中记录。这是通过显式代理发送的 HTTP 测试；目标域名用于测试，不需要请求真实业务接口。
3. 调试浏览器时，还要将浏览器或系统代理指向 Whistle，确认实际请求经过该代理。HTTPS 需要按 Whistle 指引安装并信任根证书、启用 HTTPS 解析；之后用目标 HTTPS 请求再次检查响应头和命中记录。手机需要能连接电脑的局域网地址及代理端口；浏览器命中不代表 App 一定使用该代理。
4. 结束调试前，在控制台关闭项目或规则并确认同步成功，再在启动终端按 `Ctrl+C`。源码模式停止时不会自动清除 Whistle 托管规则；异常退出后请检查 Whistle 中的 `mock-studio-managed` 规则。

### 常见问题

- **端口占用**：执行 `lsof -nP -iTCP:3000 -iTCP:17321 -iTCP:8888 -sTCP:LISTEN`，确认占用进程后再决定如何处理。不要直接关闭不明进程。管理页面固定使用 3000，管理 API 默认使用 17321；端口被占用时请处理冲突后重试。
- **页面打开但规则同步失败**：确认 Whistle 客户端正在运行、安装路径正确，并查看页面状态和启动终端日志；保存 Mock 成功不等于代理同步成功。
- **规则已同步但请求未命中**：检查请求是否经过正确的代理、方法和完整 URL 是否匹配、项目和规则是否启用；HTTPS 再检查证书及 HTTPS 解析。页面角标可能受 CSP 等限制，优先检查响应头和命中记录。
- **需要命令行管理**：在项目目录执行 `npm run mock -- list`。源码仓库不会自动安装全局 `mock-studio` 命令。

### macOS 桌面安装版

桌面安装版当前面向 Apple Silicon，仍需单独安装 Whistle。应用数据保存在 `~/Library/Application Support/Mock Studio/`，与源码版独立。在开发环境安装 Node.js 24 和依赖后，可运行 `npm run package:mac`，产物位于 `release/`。未签名、公证的开发包可能受到 macOS 安全提示；向他人发布前需要签名、公证及全新设备验证。

## 已实现能力

- 按项目分组、项目总开关与接口独立开关
- 固定响应与顺序响应策略切换
- 响应 JSON、场景名称、延迟时间实时编辑
- 顺序响应手动重置、前进，以及末尾停留/循环能力
- 新增项目、新增接口、克隆接口
- 命中次数、最近命中时间和当前顺序位置实时刷新
- 自动生成并同步 Whistle 规则
- Mock 响应自动附带 `x-mock-source`、`x-mock-variant`、`x-mock-sequence` 响应头
- 文档请求具备 `Sec-Fetch-Dest` 条件时自动注入角标，实际成功返回 Mock 后才显示；支持折叠、按接口去重和最近命中时间

页面提示依赖请求经过 Whistle、`Sec-Fetch-Dest: document/iframe`、HTML 脚本注入和浏览器可读取 Mock 响应头；普通 HTTP 域名可能缺少此头。注入明确保留页面 CSP，不绕过策略；生成的 ASCII 脚本可避免页面字符集导致语法错误。页面的 CSP、缓存、HTTPS 代理配置或其他拦截插件可能影响提示。提示只代表该页面至少一个请求命中了 Mock，不代表全部接口都被接管。

## CLI

```bash
# 查看全部接口
npm run mock -- list

# 启用/关闭接口
npm run mock -- enable query-growth-task
npm run mock -- disable query-growth-task

# 切换固定或顺序模式
npm run mock -- mode query-growth-task sequence

# 固定使用指定场景
npm run mock -- use query-growth-task growth-step-2

# 重置或手动推进顺序
npm run mock -- reset query-growth-task
npm run mock -- next query-growth-task

# 用本地 JSON 文件替换某个响应场景
npm run mock -- set-body query-growth-task growth-step-1 ./response.json

# 手动重新同步 Whistle 规则
npm run mock -- sync
```

CLI 与页面都调用同一个本地管理 API，因此变更会立刻互相可见。

## 数据与规则

- 项目、接口及响应数据：`data/registry.json`（首次运行时创建，不提交到 Git）
- 空注册表模板：`desktop/empty-registry.json`
- 自动生成的 Whistle 配置：`data/generated/mock-studio.whistle.js`
- Mock 管理与响应服务：`server/index.mjs`
- CLI：`bin/mockctl.mjs`

接口被关闭时不会生成对应 Whistle 规则，请求会继续访问原始线上地址。接口启用后，Whistle 会将请求转发到本地响应服务；顺序计数与场景选择均由本项目维护。

## 页面交互

- 顶栏提供白天／黑夜模式切换。首次跟随系统，手动选择后记忆；列表、菜单、侧栏和 JSON 编辑器一起切换。
- 项目状态区区分项目关闭、无启用规则、同步中、待验证和规则可用。规则可用仍需实际浏览器请求经过代理。
- 新旧响应编辑器支持 JSON 着色、行号、错误行列定位、格式化与全屏编辑；全屏修改保留在草稿，保存后才应用。
- 长地址突出接口名并支持复制完整 URL；最近命中可展开查看请求、配置匹配值、响应场景和命中编号。
- 高级组合提供“查询 → 领取 → 再查询”示例；克隆、排序和删除收进「更多操作」菜单。

## 验证

已完成修复与后续优化方案见 [优化记录与实施计划](docs/optimization-roadmap.md)。Mock 业务 JSON 原样返回；Whistle CLI 异步同步期间仍可处理其他请求，发起变更的操作继续等待同步结果。有效规则未变化时自动跳过重复提交，手动同步强制提交；服务每 15 秒回读托管规则并尝试恢复。页面显示最近验证结果，不代表浏览器代理或证书配置已完成。

工作区的「跨域设置」支持手动响应头与指定页面来源模式。自动预检不计命中、不推进组合，显式 OPTIONS Mock 优先。编辑器保护未保存草稿，并在检测到其他窗口配置变更时拒绝过期保存；CLI 等未携带版本的旧调用保持兼容。响应头保存前会进行完整校验，命中日志区分已匹配、服务端已发送、发送失败及客户端断开。

```bash
npm run lint
npm run test:all
npm run test:coverage
npm run build
```

前端测试使用 Vitest 与 React Testing Library，后端保留原有 Node 测试。命令、目录、覆盖率及浏览器验收边界见 [测试与持续维护](docs/testing.md)。

`test:api` 包含独立规则、严格组合、并发事务、状态迁移、迁移备份、场景包、旧新 CLI、页面提示脚本以及 HTTP/HTTPS 代理回归测试。代理回归会启动独立 Whistle 进程，使用临时目录和随机端口，不修改桌面客户端规则；若本机未安装项目指定路径的 Whistle，该项会显示为跳过。该测试直接使用隔离 Whistle 的规则管理接口，不代表已经覆盖桌面客户端 CLI 的所有同步失败情形。

## 场景管理与命中记录

在项目中新增接口后，接口默认关闭；先编辑或导入 JSON，再启用。点击当前响应打开编辑器，可新增、复制、删除、上下移动场景，批量导入 JSON 文件，指定固定场景，并切换顺序结束策略。批量文件会先全部解析，随后由服务端一次性校验保存。项目的「最近命中」列出最近 20 条；本地最多保留 500 条，不记录 Cookie、Token 或请求体。`configuredUrl` 是规则配置地址，不是经过验证的实际请求地址；可用响应头 `x-mock-hit-id` 与记录关联。

API 的管理操作需要本机令牌并校验请求来源；CLI 自动从 `~/.mock-studio/api-token` 读取令牌，页面通过本机服务获取。跨域 Mock 响应与管理鉴权分开。其他同机进程可能读取当前用户的令牌，本地令牌并非多用户隔离方案。

```bash
npm run mock -- list --json
npm run mock -- variant-add query-growth-task '失败' ./failure.json --json
npm run mock -- variant-clone query-growth-task growth-step-1 --json
npm run mock -- variant-order query-growth-task growth-step-1,growth-step-2 --json
npm run mock -- variant-delete query-growth-task growth-step-2 --json
npm run mock -- sequence-end query-growth-task loop --json
npm run mock -- hits gold-bean --json
npm run mock -- project-enable gold-bean --json
npm run mock -- project-disable gold-bean --json
npm run mock -- project-reset gold-bean --json
```

所有命令均可使用 `--json`，成功输出 `{ "ok": true, "data": ... }`，失败输出包含 `code` 和 `message` 的 JSON 并返回非零退出码。`reset` 重置单接口顺序及计数；`project-reset` 重置项目中所有接口顺序及共享流程状态，不删除命中历史。

## 场景包与流程

页面可导入、导出包含内联 `body` 的 JSON 场景包。导入先预览、再创建默认关闭的项目；「恢复导入」可在对应项目中使用。如果导入后改动项目配置，恢复会报冲突，避免覆盖后续工作。CLI 支持从场景包目录读取 `bodyFile`，并可通过返回的 `snapshotId` 恢复：

```bash
npm run mock -- package-preview ./mock-package.json my-project --json
npm run mock -- package-apply ./mock-package.json my-project --json
# 替换已有项目需要显式传入 replace
npm run mock -- package-apply ./mock-package.json my-project replace --json
npm run mock -- package-export my-project ./exported-package.json --json
npm run mock -- package-restore <snapshotId> --json
```

以下是兼容的版本 1 场景包示例。例如下面的共享状态会在领取接口命中 `success` 时从 `before` 变为 `after`，之后查询接口返回对应场景。状态按项目全局共享；领取 Mock 命中不代表真实领取成功：

```json
{
  "version": 1,
  "name": "领取流程",
  "pageUrl": "http://example.test/home/",
  "endpoints": [
    {
      "id": "home-query",
      "name": "首页查询",
      "method": "POST",
      "url": "http://example.test/api/query",
      "mode": "state",
      "stateVariants": { "before": "before", "after": "after" },
      "variants": [
        { "id": "before", "name": "领取前", "bodyFile": "./before.json" },
        { "id": "after", "name": "领取后", "bodyFile": "./after.json" }
      ]
    },
    {
      "id": "receive",
      "name": "领取",
      "method": "POST",
      "url": "http://example.test/api/receive",
      "variants": [{ "id": "success", "name": "成功", "body": { "success": true } }]
    }
  ],
  "flow": {
    "states": ["before", "after"],
    "initialState": "before",
    "transitions": [{ "from": "before", "to": "after", "endpointId": "receive", "variantId": "success" }]
  }
}
```

CLI 将 `bodyFile` 相对于场景包目录解析；浏览器导入场景包时请使用内联的 `body`。旧状态流程可继续使用 `flow-set <项目ID> <JSON文件>` 原子保存。流程 JSON 格式为 `{ "flow": { "states": [], "initialState": "", "currentState": "", "transitions": [] }, "endpoints": [{ "id": "接口ID", "mode": "state", "stateVariants": { "状态": "场景ID" } }] }`。

场景包只负责准备数据；若页面使用了其他拦截插件、代理没有命中，或浏览器拦截了跨域响应，仍需查看 Whistle 与浏览器网络记录。页面 Toast 受脚本注入及页面 CSP 等因素影响，不能替代响应头和命中记录。
