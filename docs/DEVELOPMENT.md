# 开发说明

本文档面向团队 4 人，说明代码骨架的结构、各自负责的部分，以及接下来要做的事。产品设计见 [PRD.md](PRD.md)。

## 1. 现在能跑什么

`npm run dev:demo` 启动后，**不需要任何账号和模型**就能走通：

| 功能 | 状态 | 说明 |
|---|---|---|
| 主对话 + 「今天」边栏 | ✅ 可用 | 没有模型时只能回答 DDL、待回复邮件这类问题；配置模型后走完整的工具调用循环 |
| 早安消息 | ✅ 可用 | 无模型时用模板；有模型时由模型用助理的口吻写 |
| 动态 | ✅ 可用 | 新作业、公告、课程邮件、匹配兴趣的通知、建议工单；可引用到对话、不感兴趣 |
| 目标 | ✅ 可用 | 课程目标自动生成，作业自动成为任务；长期目标由智能体在对话中创建 |
| 资源库 | ✅ 可用 | 拖入 PDF / Word / Markdown；后台工单的成果自动存入 |
| 搜索 | ✅ 可用 | FTS5 trigram 全文搜索，`Ctrl+K` |
| 主动引擎 | ✅ 可用 | 事件 → 准入 → 研判 → 注意力预算 → 写回；闭环验证；建议工单 |
| 主动决策记录 | ✅ 可用 | 设置 → 主动决策 |
| 后台工单 | ✅ 可用 | 无模型时生成模板结果 |
| MCP 连接层 | ✅ 可用 | 4 个服务进程内运行，智能体通过 MCP 调用 |
| UIS 登录 / Canvas API / IMAP | ⚠️ 已写、未实测 | 需要真实账号验证，见下文 |
| 本地 / 云端模型路由 | ⚠️ 已写、未实测 | 需要 API Key 和本地 Ollama 验证 |

演示时用「设置 → 开发者」里的按钮触发关键场景：助教发来 Lab 5 补充邮件（跨平台关联）、在 eLearning 上交掉最近的作业（闭环）、切换到「考试周前」（学期节奏）。

## 2. 架构速览

```
来源（sources/ + engine/clock.ts）
  └─ 事件 triggers 表（幂等去重）
       └─ 主动引擎 engine/engine.ts（每 10 秒一次）
            ├─ 线程归并（同一门课 / 同一封邮件的事件合并成一批）
            ├─ 准入 engine/gate.ts（确定性规则）
            ├─ 研判 engine/assess.ts（本地模型；无模型时用规则表）
            ├─ 注意力预算 engine/budget.ts（学期阶段调整）
            └─ 写回：对话消息 / 系统通知 / 动态卡片 / 并入早安 / 建议工单 / 只记录
                       └─ 工单 → engine/executor.ts（受限工具集的独立智能体循环）→ 资源库
对话 ai/agent.ts ──MCP──> mcp/hub.ts ──> packages/mcp-fudan-* + local-tools/server.ts
```

设计原则（来自 PRD）：

- **业务逻辑不依赖 Electron**：`AppContext` 及以下的模块都能在 Node 测试中直接运行。只有 `index.ts`、`ipc.ts`、`auth/` 依赖 Electron。
- **所有 SQL 都在 `db/repo.ts`**：其他模块只调用 Repo 方法。
- **对校内平台只读**：MCP 工具都带 `readOnlyHint`；写操作只写本地数据。
- **外部内容是数据，不是指令**：工具结果和引用内容都用 `<external_data>` 包裹后再交给模型。
- **演示客户端和真实客户端实现同一个接口**：演示模式走的是和真实环境完全相同的流程。

## 3. 分工与下一步

### A · 前端 / 产品体验（`src/renderer/`）

- [ ] 首次使用引导页（模型 → 复旦账号 / 演示模式 → 画像 → 起名选风格）。现在只能在设置页配置。
- [ ] 对话流式输出（需要 C 在 `llm.ts` 增加流式接口）。
- [ ] 消息里的卡片可点击打开（作业 → 打开 eLearning 链接；资源 → 跳转资源库）。
- [ ] 动态「不感兴趣」改成选项弹层（现在用的是 `window.prompt`）。
- [ ] 资源库 Markdown 渲染。
- [ ] 界面打磨、深色模式检查、图标；**录制演示视频**。

### B · 认证与连接层（`src/main/auth/`、`packages/`、`src/main/sources/`）

- [ ] **今天实测**：UIS 内嵌登录能否成功、成功后跳回的 URL（修正 `auth-manager.ts` 的登录成功判定）。
- [ ] **今天实测**：登录后 `CanvasClient` 的四个接口是否可用、课程代码 `course_code` 的真实格式。
- [ ] **今天实测**：学生邮箱 IMAP 服务器（目前假设 `imap.exmail.qq.com:993`）和客户端专用密码。
- [ ] 实测 iCourse 能否复用同一个登录会话、校外是否需要 WebVPN。
- [ ] Canvas 分页（`Link` 头）；助教邮箱（`/courses/:id/users?enrollment_type[]=ta`）。
- [ ] 会话过期时，推送「需要重新登录」的系统通知。
- [ ] （P1）`packages/mcp-fudan-icourse`。

### C · 智能体 / 模型（`src/main/ai/`、`engine/assess.ts`、`engine/executor.ts`）

- [ ] 用真实模型跑通对话工具调用循环；调提示词（`ai/prompts.ts`）。
- [ ] 在酷睿 Ultra 电脑上跑通本地模型（Ollama / OpenVINO），记录邮件分类耗时。
- [ ] 研判提示词调优：对比规则和模型的决策，在「主动决策」页检查理由是否合理。
- [ ] 早期对话的滚动摘要（`conversation_summaries` 表已建好）。
- [ ] 邮件 ↔ 作业关联的模型兜底（规则判断不出来时）。
- [ ] 测试样例：邮件分类、截止时间抽取、关联各约 20 条标注数据，统计准确率（放 `tests/fixtures/`）。

### D · 队长 / 集成 / 材料（`engine/`、`local-tools/`、`demo/`、打包）

- [ ] **按教务处校历修正 `engine/calendar.ts`**（现在是示例日期）。
- [ ] 观察模式的开关界面（`settings.observeRules` 已支持）。
- [ ] 演示数据按演示脚本细调（`demo/demo.ts`）。
- [ ] `npm run dist` 在 Windows 上打包测试；托盘图标。
- [ ] 报名问卷、项目说明书、代码运行说明、提交压缩包。

## 4. 约定

- 分支：每人在自己的分支开发，合并前跑 `npm run check`。
- 新增数据表：改 `db/schema.ts` 和 `shared/types.ts`，并在 `db/repo.ts` 加访问方法。
- 新增 MCP 工具：平台相关的放进对应的 `packages/mcp-fudan-*`；只操作本地数据的放进 `local-tools/server.ts`。工具描述用中文写清楚「什么时候用」。
- 新增主动规则：在 `engine/assess.ts` 的规则表里加一行，并在测试里覆盖。
- 不要提交任何真实的账号、Cookie、邮件内容或 API Key。

## 5. 已知问题

- `node:sqlite` 在 Node 22 中仍标记为实验性功能，运行时会打印一条警告，不影响使用。
- Electron 二进制下载在部分网络环境下较慢，可以设置 `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/`。
- 开发依赖中的 vitest 子依赖有 `npm audit` 提示，只影响测试环境，不影响打包产物。
