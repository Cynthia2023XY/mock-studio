# Mock Studio v2 本地接口契约

调用方为本机控制台（127.0.0.1:3000）和 mockctl CLI，提供方为 server/index.mjs。系统为本地开发工具，无科技网关或金融交易服务；保持现有 HTTP/JSON、状态码和鉴权方式。

管理请求需要 `x-mock-token`，浏览器 Origin 与 Host 继续校验。配置 JSON 上限 10MB，页面/CLI 超时均为 25 秒；Whistle CLI 同步超时 8 秒，回读超时 8 秒。原接口回源连接/读取无活动超时 30 秒。

## 项目内资源

基础路径 `/api/projects/:projectId`，编号 1–120 位字母、数字、下划线、连字符。

| 路由 | 方法 | 请求 | 成功结果 |
| --- | --- | --- | --- |
| /mocks | POST | name, method, match, response，可选 id | 默认关闭的新规则及 sync |
| /mocks/:id | PATCH | name/method/match/response/enabled 子集 | 完整规则及 sync |
| /mocks/:id | DELETE | 无 | deleted、id、sync |
| /mocks/:id/clone | POST | 无 | 默认关闭且计数清零的副本及 sync |
| /mocks/reorder | POST | ids：完整不重复 ID 数组 | ids、sync |
| /combinations | POST | name、steps、afterEnd，可选 id | 默认关闭且 currentIndex=0 的组合及 sync |
| /combinations/:id | PATCH | name/enabled/steps/afterEnd 子集 | 完整组合及 sync |
| /combinations/:id | DELETE | 无 | deleted、id、sync |
| /combinations/:id/reset | POST | 无 | currentIndex=0 的组合及 sync |
| /migration/preview | POST | 无 | project、mapping、fingerprint、warnings 或 retainedLegacy/message |
| /migration/apply | POST | fingerprint | project、mapping、backupPath、sync；重复操作 unchanged=true |
| /export | GET | 无 | version=2 的完整项目场景包 |

配置变更成功状态码 200，校验失败 400，资源缺失 404，冲突或引用错误 409。所有失败返回 `{code,message}`。写入成功但代理失败仍返回 200，且 `sync.ok=false`，页面显示「配置已保存；Whistle 同步失败」，不得显示已生效。导出不触发同步。

`match={type:'exact'|'contains',value:string}`；`response={status:number,delayMs:number,headers:Record<string,string>,body:JSON}`，body 可以为 null。状态码 200–599，排除 204/205/304；延迟 0–120000ms。响应头不能覆盖内部标记和传输头。规则方法支持 GET/POST/PUT/PATCH/DELETE/HEAD/OPTIONS。

`steps=[{id,mockId}]` 至少一项，步骤 ID 唯一，引用限当前项目；同一 Mock 可多次引用。`afterEnd='hold-last'|'loop'`。`onUnexpectedRequest='error'` 固定。每个项目最多一个启用组合。编辑 steps 或从关闭切换到启用会重置进度。

## 运行态分发

Whistle 将候选请求转到 `/runtime/dispatch`，覆盖写入独立运行凭据及编码后的完整原 URL；方法保留原方法。运行凭据不使用管理令牌。缺少/伪造凭据返回 `403 / PROXY_UNAUTHORIZED`。禁止通过 URL 参数提供分发元数据。

匹配：先启用组合、再普通 mocks 数组顺序、再兼容 endpoints 顺序。组合选择、推进、成功/错误记录在同一注册表串行事务内完成；响应延迟在事务外。与组合无关且无普通规则匹配时，直接回源并删除内部头与逐跳头。

顺序错误返回 409：

```json
{
  "code": "COMBINATION_ORDER_MISMATCH",
  "message": "顺序不匹配，等待第 1 步：首页查询",
  "expected": { "stepId": "s1", "mockId": "query", "name": "首页查询", "method": "POST", "match": { "type": "contains", "value": "query" }, "index": 0 },
  "actual": { "url": "http://example.test/receive", "method": "POST" },
  "hitId": "hit-..."
}
```

错误无 x-mock-source，日志 outcome=order-mismatch；成功日志 outcome=mock，含 actualUrl、mockId、combinationId/stepId（如适用）。保留最近 500 条，不记录请求体、Cookie 和认证头。时间为 ISO 字符串。进度按项目全局共享。

## 版本与错误

旧注册表内存补齐集合，schemaVersion 缺失视为 1；新资源写入升级为 2。旧 endpoints 的直接运行路由及 CLI 保留；显式迁移后的旧接口命令返回 `410 / MIGRATED_ENDPOINT`。旧包 version=1 可继续导入，v2 包引用必须有效，跨项目重名 Mock 做稳定映射并更新组合步骤。迁移预览只读，应用先备份原文再原子写入。

其他稳定错误码包括 INVALID_MATCH、INVALID_STATUS、INVALID_DELAY、INVALID_HEADERS、INVALID_REFERENCE、INVALID_ORDER、MOCK_IN_USE、RULE_CONFLICT、COMBINATION_CONFLICT、MIGRATION_STALE、MIGRATION_CONFLICT、UPSTREAM_UNAVAILABLE。无分页新 API，规则排序由服务端校验完整列表；命中沿用已有 limit 最大 500。
