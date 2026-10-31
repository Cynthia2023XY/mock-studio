# 测试与持续维护

## 运行环境和命令

推荐使用 `.nvmrc` 中的 Node.js 24，安装依赖后执行：

```bash
npm ci
npm run test:all
npm run lint
npx tsc --noEmit
```

| 命令 | 作用 |
| --- | --- |
| `npm test` | 前端交互测试，开发时监听变更 |
| `npm run test:run` | 一次性运行前端测试 |
| `npm run test:coverage` | 前端测试及 V8 覆盖率报告 |
| `npm run test:api` | 现有 Node 后端、CLI、存储及代理回归 |
| `npm run test:all` | 先运行后端，再运行前端 |
| `npm run lint` | 检查服务端、页面、业务组件、UI 模型和测试 |

覆盖率 HTML 位于 `coverage/index.html`，同时输出 `lcov.info` 与 JSON 汇总。`coverage/` 已忽略，不提交生成文件。流水线可分别运行后端测试与 `test:coverage`，避免重复执行同一组前端测试。

## 框架与目录

前端使用 Vitest 5.0.5、React Testing Library、user-event、jest-dom 和 jsdom。新增开发依赖均固定精确版本，`@vitest/coverage-v8` 与 Vitest 版本一致。

- `vitest.config.ts`：独立测试配置，复用已有 React 插件与 `@/` 路径，不启动 vinext、Cloudflare 或 Whistle。
- `tests/setup.ts`：组件清理、主题环境重置，以及 jsdom 所需的 matchMedia / ResizeObserver 适配。
- `tests/*.test.tsx`：React 用户交互测试。
- `tests/ui-model.test.ts`：项目状态优先级、JSON 错误位置、URL 展示和主题启动脚本的纯逻辑测试。
- `server/*.test.mjs`：保留现有 Node 测试方式，不混入 Vitest 的自动发现范围。

## 优先覆盖的回归风险

1. **状态不可误报**：项目关闭、没有启用规则、配置保存中、验证过期时，不显示规则可用。历史同步成功不代表当前浏览器已经使用代理。
2. **编辑内容不可丢失**：全屏内的修改返回原草稿；Escape 只退出当前全屏；取消放弃未保存修改时保留编辑器。
3. **JSON 输入可靠**：错误行列和定位、格式化、缩进、禁用态，以及用户文本不会被当作 HTML 执行。
4. **主题可持续使用**：记忆选择、首次跟随系统、其他窗口同步、存储受限时仍可操作。
5. **信息可核对**：复制完整地址与失败反馈、命中详情展开、低频操作菜单和组合流程示例。

测试优先通过角色、标签和用户操作断言行为，不依赖整页快照。网络调用在边界处模拟，未声明的请求应报错，不能访问用户注册表或修改真实代理规则。

当前覆盖率是持续补充的基线，覆盖范围包含整个首页和业务组件，未通过排除旧页面来抬高比例。尚未全面覆盖旧场景 CRUD、导入恢复和迁移 UI；这些服务端能力由既有 API 测试覆盖。后续新增 UI 行为应同时补对应组件回归，再依据实际基线设置覆盖率门槛。

## 浏览器和桌面验证

2026-10-31 验证记录：Node.js 24.22.2，前端 22 项、后端 40 项通过；lint、TypeScript 检查、Web 构建和桌面页面构建通过。真实浏览器已验证浅色/深色切换与刷新恢复、错误定位、全屏格式化后保留草稿、完整地址复制反馈及命中详情展开；390×844 视口下全屏编辑器无页面横向溢出，退出按钮可见。未进行桌面安装包与真机验收。

jsdom 不计算真实布局，不能证明两种主题的对比度、侧栏宽度、滚动对齐或移动端显示正确。这些需要真实浏览器补充验证：

- 白天／黑夜模式下的列表、菜单、侧栏、错误提示和全屏编辑器。
- 刷新后恢复主题，输入区着色与光标对齐，全屏退出后草稿保留。
- 桌面及 390px 窄屏布局，无页面横向溢出，保存与退出按钮可见。
- 涉及代理链路时执行真实 Whistle 回归；未安装指定 Whistle 的机器会跳过对应测试，不能把跳过解释为代理验证通过。

发版前同时运行 `npm run build` 与 `npm run build:desktop-ui`。桌面 UI 通过 `public/assets/theme-init.js` 在渲染前恢复主题，Vite 会复制到 `desktop-dist/assets/`；这个路径也在桌面静态服务允许的资源范围内。
