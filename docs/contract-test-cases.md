# Mock Studio v2 契约验收用例

运行 `npm run test:api`，包含模型、API、旧兼容、CLI 和真实隔离 Whistle 测试。

| 用例 | 预期 | 自动证据 |
| --- | --- | --- |
| 新规则/组合创建时传 enabled=true | 仍默认关闭 | v2-api.test.mjs |
| 同 URL 三个响应 | 按三个步骤依次返回 | rules.test.mjs、v2-api.test.mjs |
| 查询→领取→查询 | 返回当前步骤引用内容 | rules.test.mjs |
| 请求其他步骤 | 409，预期步骤明确，进度/成功计数不变 | rules.test.mjs、v2-api.test.mjs |
| 并发三个请求 | 不重复使用同一个步骤位置 | v2-api.test.mjs |
| 无关请求 | 单条规则命中或原接口透传 | rules.test.mjs、proxy-v2.test.mjs |
| 停留/循环/重复引用 | 独立步骤正确推进 | rules.test.mjs |
| 修改被引用响应 | 下次步骤使用新内容 | v2-api.test.mjs |
| 删除被引用规则 | 409 并列出组合 | v2-api.test.mjs |
| 关闭组合 | 单条原开关不变 | v2-api.test.mjs |
| 第二组合/跨项目重叠 | 明确冲突，失败不落盘 | v2-api.test.mjs |
| 列表排序/重叠规则 | 顺序稳定；非法排序原子拒绝 | v2-api.test.mjs、proxy-v2.test.mjs |
| 路径大小写、编码、查询顺序 | 精确比较保留差异 | rules.test.mjs、proxy-v2.test.mjs |
| 伪造内部头/无凭据 | 代理覆盖伪造头；直接访问返回 403 | proxy-v2.test.mjs、v2-api.test.mjs |
| 过期规则仍转发到服务 | 按原 URL/方法/正文回源，不泄漏内部头 | proxy-v2.test.mjs |
| HTTP/HTTPS | 完整 URL 和方法不丢失 | proxy-v2.test.mjs |
| Whistle 不可用 | 配置成功，sync.ok=false | v2-api.test.mjs |
| 无效状态码/延迟/响应头/空引用 | 稳定校验错误，不覆盖配置 | model.test.mjs、v2-api.test.mjs |
| 迁移预览/备份/重复应用 | 预览无写入，原文备份，进度保留，不生成副本 | v2-api.test.mjs |
| 旧状态流程 | 保留原运行模型 | integration.test.mjs、v2-api.test.mjs |
| v1/v2 包与新旧 CLI | 引用映射正确，旧接口迁移后明确报错 | integration.test.mjs、v2-api.test.mjs |
| 页面无 charset 与 CSP | ASCII 注入脚本可解析，CSP 原样保留 | whistle.test.mjs、proxy-integration.test.mjs |
| XHR 复用、域名重名、提示异常 | 去重正确，不改变原响应 | mock-notice.test.mjs |

真实 Chrome 的额外验收结果见 implementation-verification.md。回源无响应的 30 秒超时、其他浏览器、真实 App 和桌面客户端整体同步未作端到端承诺。
