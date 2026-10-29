# Mock Studio

一个面向页面联调的本地 Mock 控制台。它把项目分组、接口开关、响应场景、顺序响应和 CLI 放在同一份本地配置上，再让 Whistle 仅承担 HTTP/HTTPS 代理与转发。

## 启动

在任意目录使用全局命令启动，启动器会检查 Whistle、启动服务并打开管理页面：

```bash
mock-studio start
mock-studio stop
mock-studio restart
mock-studio status
mock-studio open
mock-studio logs
```

需要以前台开发模式运行时，再进入项目执行：

```bash
cd /Users/dingxinyi.2/Documents/practice/mock-studio
npm run dev
```

控制台地址：<http://127.0.0.1:3000/>

本地管理 API：<http://127.0.0.1:17321/>

项目已固定使用 Codex 内置 Node 24 运行时，不会修改全局 Node 版本。

## 已实现能力

- 按项目分组、项目总开关与接口独立开关
- 固定响应与顺序响应策略切换
- 响应 JSON、场景名称、延迟时间实时编辑
- 顺序响应手动重置、前进，以及末尾停留/循环能力
- 新增项目、新增接口、克隆接口
- 命中次数、最近命中时间和当前顺序位置实时刷新
- 自动生成并同步 Whistle 规则
- Mock 响应自动附带 `x-mock-source`、`x-mock-variant`、`x-mock-sequence` 响应头
- 为项目配置「页面提示」地址后，页面的 fetch 或 XHR 实际命中 Mock Studio 响应时显示提示；刷新页面后生效

页面提示依赖请求经过 Whistle、HTML 脚本注入和浏览器可读取 Mock 响应头；页面的 CSP、缓存、HTTPS 代理配置或其他拦截插件可能影响提示。提示只代表该页面至少一个请求命中了 Mock，不代表全部接口都被接管。

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

- 项目、接口及响应数据：`data/registry.json`
- 自动生成的 Whistle 配置：`data/generated/mock-studio.whistle.js`
- Mock 管理与响应服务：`server/index.mjs`
- CLI：`bin/mockctl.mjs`

接口被关闭时不会生成对应 Whistle 规则，请求会继续访问原始线上地址。接口启用后，Whistle 会将请求转发到本地响应服务；顺序计数与场景选择均由本项目维护。

## 验证

```bash
npm run lint
npm run test:api
npm run build
```

`test:api` 包含场景校验、状态迁移、场景管理、场景包、CLI、页面提示脚本和代理回归测试。代理回归会启动独立 Whistle 进程，使用临时目录和随机端口，不修改桌面客户端规则；若本机未安装项目指定路径的 Whistle，该项会显示为跳过。该测试直接使用隔离 Whistle 的规则管理接口，不代表已经覆盖桌面客户端 CLI 的所有同步失败情形。

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

场景包版本为 1。例如下面的共享状态会在领取接口命中 `success` 时从 `before` 变为 `after`，之后查询接口返回对应场景。状态按项目全局共享；领取 Mock 命中不代表真实领取成功：

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

CLI 将 `bodyFile` 相对于场景包目录解析；浏览器导入场景包时请使用内联的 `body`。也可以在项目中通过「流程配置」编辑 `flow` 和 `endpoints` 状态映射，或使用 `flow-set <项目ID> <JSON文件>` 原子保存。流程 JSON 格式为 `{ "flow": { "states": [], "initialState": "", "currentState": "", "transitions": [] }, "endpoints": [{ "id": "接口ID", "mode": "state", "stateVariants": { "状态": "场景ID" } }] }`。

场景包只负责准备数据；若页面使用了其他拦截插件、代理没有命中，或浏览器拦截了跨域响应，仍需查看 Whistle 与浏览器网络记录。页面 Toast 受脚本注入及页面 CSP 等因素影响，不能替代响应头和命中记录。
