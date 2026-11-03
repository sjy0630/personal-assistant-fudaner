# Fudaner

住在你电脑里、懂复旦的 AI 私人助理（复旦版 Muse / Dots）。主对话为中心，配合动态、目标、资源库、搜索四个副页面；通过 MCP 连接 eLearning、复旦学生邮箱（之后还有 iCourse）；主动引擎参考 DeepSeek 开源的 dsh-superagent，做到「有依据、可验证、懂学期节奏、不浪费注意力」。隐私任务交给本地模型，复杂推理交给你自己接入的云端模型。

参赛作品：2026 复旦大学未来智造智能体大赛（智慧学习与科研助手赛道 + 英特尔混合 AI Agent 专项）。

> 学生自制，非官方产品。对所有校内平台只读，不保存 UIS 密码。

- 产品需求文档：[docs/PRD.md](docs/PRD.md)
- 开发说明与分工：[docs/DEVELOPMENT.md](docs/DEVELOPMENT.md)

## 快速开始

需要 Node.js ≥ 22.12（使用内置的 `node:sqlite`，无原生依赖）。

```bash
npm install
```

```bash
npm run dev:demo
```

`dev:demo` 以演示模式启动：使用内置的虚构课程、作业和邮件，不需要复旦账号，也不需要模型 API Key（没有模型时，智能体和主动引擎会退回规则处理）。

真实使用：

```bash
npm run dev
```

然后在「设置 → 模型」填写云端模型（DeepSeek / 通义 / Kimi / 智谱等 OpenAI 兼容接口）和本地模型（Ollama），在「设置 → 复旦账号」登录 UIS、配置学生邮箱。

## 常用命令

| 命令 | 作用 |
|---|---|
| `npm run dev` / `npm run dev:demo` | 开发模式启动（真实 / 演示） |
| `npm test` | 运行测试（主动引擎、课程匹配、演示端到端流程） |
| `npm run typecheck` | 类型检查 |
| `npm run check` | 类型检查 + 测试 + 构建 |
| `npm run dist` | 打包 Windows 安装包 |

## 目录结构

```
packages/                     平台连接层：每个都是独立的 MCP 服务，以后可以单独发布
  fudan-auth/                 UIS 统一认证接口
  mcp-fudan-elearning/        eLearning（Canvas）客户端 + MCP 工具
  mcp-fudan-mail/             学生邮箱（IMAP 只读）客户端 + MCP 工具
  mcp-fudan-courses/          课程总表与跨平台匹配
src/main/                     Electron 主进程
  app-context.ts              组装根：创建并连接所有部件
  auth/                       AuthManager：内嵌 UIS 登录窗口、共享会话
  sources/                    同步：平台数据 → 事项 + 事件
  engine/                     主动引擎：时钟、准入、研判、注意力预算、写回、闭环、后台工单
  ai/                         模型路由、提示词、对话智能体、邮件分类
  local-tools/                fudaner-local MCP 服务：记忆、目标、跟进、动态、资源库、搜索
  mcp/                        进程内 MCP 集线器
  db/                         SQLite 结构与 Repo
  demo/                       演示数据与演示客户端
src/renderer/                 React 界面：对话 / 动态 / 目标 / 资源 / 搜索 / 设置
src/shared/                   前后端共享类型与 IPC 接口
tests/                        测试
```
