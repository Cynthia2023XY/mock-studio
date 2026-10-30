# CLI、配置示例与旧版兼容

下面命令中的 `<CLI>` 表示此 skill 的 `scripts/mock-studio` 的完整路径；先安装并打开桌面版。示例中的项目、Mock、组合与场景 ID 应替换为 `list`、创建或导入返回的真实值；文件路径相对于执行目录。所有命令可加 `--json` 输出机器可读结果。

CLI 成功输出 `{ "ok": true, "data": ... }`；失败非零退出，输出 `{ "ok": false, "error": { "code": "...", "message": "..." } }`。写操作返回的 `data.sync.ok` 可能为 false，必须单独检查。配置 PATCH 中的 `response`、`match`、`steps` 是整字段替换，不是深层合并；修改延迟/响应体时应带齐当前 response 的其他字段。

## 独立 Mock

```bash
"<CLI>" list --json
"<CLI>" mock-add <项目ID> ./mock.json --json
"<CLI>" mock-update <项目ID> <MockID> ./patch.json --json
"<CLI>" mock-enable <项目ID> <MockID> --json
"<CLI>" mock-disable <项目ID> <MockID> --json
"<CLI>" mock-clone <项目ID> <MockID> --json
"<CLI>" mock-delete <项目ID> <MockID> --json
"<CLI>" mock-order <项目ID> <MockID,MockID,...> --json
```

`mock-add` 配置示例；ID 可省略，由服务生成。创建时传 enabled=true 也不会启用。`mock-update` 接收需改变的顶层字段子集。

```json
{
  "id": "home-before",
  "name": "首页查询-领取前",
  "method": "POST",
  "match": { "type": "contains", "value": "queryBullMarketFundExpHome" },
  "response": {
    "status": 200,
    "delayMs": 500,
    "headers": {},
    "body": { "phase": "before" }
  }
}
```

这里的 body 仅示范格式，实际应替换为目标接口完整 JSON 响应。支持 GET/POST/PUT/PATCH/DELETE/HEAD/OPTIONS；状态码 200–599，排除 204/205/304；延迟 0–120000ms；body 可为 null。响应头不允许覆盖 `x-mock-*`、连接或传输头。跨域预检需要时可另外配置 OPTIONS Mock；不要假定只配置 POST 就能处理所有 CORS 或凭据请求。

## 高级组合

```bash
"<CLI>" combination-add <项目ID> ./combination.json --json
"<CLI>" combination-update <项目ID> <组合ID> ./patch.json --json
"<CLI>" combination-enable <项目ID> <组合ID> --json
"<CLI>" combination-disable <项目ID> <组合ID> --json
"<CLI>" combination-reset <项目ID> <组合ID> --json
"<CLI>" combination-delete <项目ID> <组合ID> --json
"<CLI>" project-enable <项目ID> --json
"<CLI>" project-disable <项目ID> --json
"<CLI>" hits <项目ID> --json
```

先创建或找到引用的 Mock，再提交组合。下例重复引用 home-before，适合演示步骤引用；领取后需要不同数据时，应另建 home-after 并改用其 ID。

```json
{
  "id": "receive-flow",
  "name": "查询-领取-再次查询",
  "steps": [
    { "id": "step-1", "mockId": "home-before" },
    { "id": "step-2", "mockId": "receive-success" },
    { "id": "step-3", "mockId": "home-before" }
  ],
  "afterEnd": "hold-last"
}
```

创建接口自动设置 enabled=false、currentIndex=0、onUnexpectedRequest=error。不要用 combination-update 手动指定进度，重置用专用命令。

## v2 场景包

适合一次准备多条响应和组合，避免逐条创建时遗漏引用。

```json
{
  "version": 2,
  "name": "独立 Mock 组合示例",
  "mocks": [
    {
      "id": "query-response",
      "name": "查询响应",
      "method": "POST",
      "match": { "type": "contains", "value": "/demo/query" },
      "response": { "status": 200, "delayMs": 0, "headers": {}, "body": { "phase": "ready" } }
    },
    {
      "id": "receive-response",
      "name": "领取响应",
      "method": "POST",
      "match": { "type": "contains", "value": "/demo/receive" },
      "response": { "status": 200, "delayMs": 0, "headers": {}, "body": { "success": true } }
    }
  ],
  "combinations": [
    {
      "id": "query-receive-query",
      "name": "查询-领取-查询",
      "steps": [
        { "id": "first", "mockId": "query-response" },
        { "id": "second", "mockId": "receive-response" },
        { "id": "third", "mockId": "query-response" }
      ],
      "afterEnd": "hold-last",
      "onUnexpectedRequest": "error"
    }
  ]
}
```

场景包组合与 combination-add 的补全边界不同：包内明确填写 `afterEnd` 和 `onUnexpectedRequest`，引用必须有效。导入时重置执行位置，并关闭新项目、独立 Mock 和组合。`version: 2` 包还可含兼容 `endpoints/flow`；注册表 `schemaVersion` 与场景包 `version` 不混用。

```bash
"<CLI>" package-preview ./mock-package.json <项目ID> --json
"<CLI>" package-apply ./mock-package.json <项目ID> --json
# 仅在任务要求替换现有项目时使用 replace，预览和应用均带此参数。
"<CLI>" package-preview ./mock-package.json <项目ID> replace --json
"<CLI>" package-apply ./mock-package.json <项目ID> replace --json
"<CLI>" package-export <项目ID> ./exported-package.json --json
"<CLI>" package-restore <snapshotId> --json
```

包内跨项目重名编号可能重映射，组合引用会一起更新，不能继续用旧 ID 操作。保存 `snapshotId`；恢复会检查导入后配置是否修改，发生 `RESTORE_CONFLICT` 时先检查差异，不强制覆盖。导出目标已存在时 CLI 会失败，不自动覆盖文件。

浏览器导入需要内联响应 body。CLI 支持旧场景 `variants[].bodyFile` 和新版 `mocks[].response.bodyFile`，相对于包文件目录解析，实际文件必须位于该目录内；不同时维护两份响应。`mock-add` / `mock-update` 的配置文件直接使用内联 `response.body`，bodyFile 解析属于场景包能力。

## 旧版场景与状态流程

对 `endpoints` 使用旧命令，不把 Mock ID 当接口 ID；新独立 Mock 不使用 `variant-add` 或 `set-body`。

```bash
"<CLI>" enable <接口ID> --json
"<CLI>" disable <接口ID> --json
"<CLI>" mode <接口ID> fixed --json
"<CLI>" mode <接口ID> sequence --json
"<CLI>" use <接口ID> <场景ID> --json
"<CLI>" set-body <接口ID> <场景ID> ./response.json --json
"<CLI>" variant-add <接口ID> '失败场景' ./failure.json --json
"<CLI>" variant-clone <接口ID> <场景ID> --json
"<CLI>" variant-delete <接口ID> <场景ID> --json
"<CLI>" variant-order <接口ID> <场景ID,场景ID,...> --json
"<CLI>" sequence-end <接口ID> loop --json
"<CLI>" reset <接口ID> --json
"<CLI>" next <接口ID> --json
"<CLI>" flow-set <项目ID> ./flow.json --json
"<CLI>" project-reset <项目ID> --json
```

已有 `flow/state` 继续按项目状态选择场景，允许同状态多次查询；`flow-set` 可同时配置 flow 与 endpoints 的 mode/stateVariants。其格式和完整 v1 包示例见项目 README。旧 `reset` 重置单接口顺序及命中统计；`project-reset` 重置旧接口顺序、共享流程状态和新组合进度，不删除历史。只重置某个新组合时使用 combination-reset。

## 显式迁移

仅在任务要求时执行，不把迁移作为日常 Mock 配置前置条件。

```bash
"<CLI>" migration-preview <项目ID> --json
"<CLI>" migration-apply <项目ID> '<预览返回的fingerprint>' --json
```

预览只读，检查返回的 project、mapping、warnings、retainedLegacy 和 fingerprint：

- 旧固定场景转独立 Mock；旧顺序接口转引用组合，保留当前顺序位置与启用配置。原有历史仍保留，生成的新规则命中计数从零开始。
- 旧 URL 前缀匹配改为完整精确匹配，额外查询参数可能不再命中；迁移还会过滤不能用于新版响应的内部/传输头。应结合任务需要核对差异，不把它称为无损转换。
- 含 flow 或 state 的项目整体 retainedLegacy=true，保留原运行模型。多个启用的旧顺序接口会冲突，不能擅自停掉无关接口以迁移。
- 应用核对配置指纹并使用事务内最新运行进度，先备份原始注册表到 backupPath，再原子保存。保存返回的映射与备份位置；重复应用不生成副本。
- `MIGRATION_STALE` 表示配置已变，应重新预览。迁移后的旧接口写命令通常返回 `410 / MIGRATED_ENDPOINT`；按 list/mapping 改用新命令，不重建同名旧接口。CLI 的旧本地查找命令也可能直接报 ENDPOINT_NOT_FOUND。
- 迁移备份与包导入 snapshotId 不是同一恢复机制。整表备份恢复需要停止服务并保留迁移后的修改，不能直接用旧备份覆盖当前运行中的配置。
