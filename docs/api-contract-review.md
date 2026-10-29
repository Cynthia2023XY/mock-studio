# Mock Studio v2 接口契约审查

日期：2026-10-29。范围为本地 Mock 工具的独立规则、组合、导入导出及迁移接口。

金科规范适用于金科研发前后端新增网关接口。本次调用链为同机 React → Node/CLI，无科技网关、业务交易或 JAPI 发布，网关封装、八位业务码、POST-only 与金融首屏性能规则不适用；沿用项目既有 REST 契约，未改写被模拟的用户 JSON。

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| 调用方、服务方、网关边界 | 通过 | integration-contract.md |
| 方法、参数、类型、空值、枚举 | 通过 | rules.mjs、v2-api.mjs；JSON body 可为 null |
| 管理鉴权、来源、运行凭据隔离 | 通过 | index.mjs、dispatcher.mjs；代理覆盖伪造头的真实测试 |
| 可识别错误和保存/同步分离 | 通过 | 稳定 code、HTTP 状态、sync.ok 独立字段 |
| 数值/JSON/引用校验和原子性 | 通过 | 前端校验、validateMock/validateCombinations、串行原子写入 |
| 并发步骤推进 | 通过 | 三个并发请求分别选择三个响应，延迟移至事务外 |
| 敏感内容 | 通过 | 命中不记录请求体、Cookie、认证头；原 URL 及其查询串属于本地调试记录 |
| 超时和依赖失败 | 通过 | 页面与 CLI 25s，代理操作 8s+8s，回源 30s；同步失败用例 |
| 排序 | 通过 | 完整 ID 数组服务端验证，组合步骤顺序独立 |
| 旧数据和 CLI | 通过 | 旧状态流程保留；迁移预览/备份/指纹/幂等；新旧命令回归 |
| 模拟数据与契约测试 | 通过 | rules.test、v2-api.test、proxy-v2.test、integration.test |
| 页面安全策略 | 通过 | enable://keepAllCSP；真实 Chrome CSP 限制用例 |
| 多浏览器/真实 App | UNKNOWN [E-NONBLOCKING] | 当前真实浏览器验收仅 Chrome；未宣称其他宿主已验证 |

本地契约已写入仓库，不涉及 JAPI 发布。所有验证使用临时注册表和隔离 Whistle，没有应用真实项目迁移。
