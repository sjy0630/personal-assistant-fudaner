# Fudaner

住在你电脑里、懂复旦的 AI 私人助理（复旦版 Muse / Dots）。主对话为中心，配合动态、目标、资源库、搜索四个副页面；通过 MCP 连接 eLearning、复旦学生邮箱（之后还有 iCourse）；主动引擎参考 DeepSeek 开源的 dsh-superagent，做到「有依据、可验证、懂学期节奏、不浪费注意力」。隐私任务交给本地模型，复杂推理交给你自己接入的云端模型。

参赛作品：2026 复旦大学未来智造智能体大赛（智慧学习与科研助手赛道）。

> 学生自制，非官方产品。对所有校内平台只读，不保存 UIS 密码。

- 产品需求文档：[docs/PRD.md](docs/PRD.md)
- 开发说明与分工：[docs/DEVELOPMENT.md](docs/DEVELOPMENT.md)
- 材料工作手册：[docs/MATERIALS.md](docs/MATERIALS.md)
- 演示剧本（录视频用）：[docs/DEMO.md](docs/DEMO.md)
- **真实账号试用指南**：[docs/TRIAL.md](docs/TRIAL.md)

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

然后在「设置 → 模型」填写云端模型（DeepSeek / 通义 / Kimi / 智谱等 OpenAI 兼容接口）和可选的本地模型（Ollama），在「设置 → 复旦账号」登录 UIS、配置学生邮箱。

## macOS 真实接入验证

在 Mac 上运行 `npm ci`、`npm run check`，然后用 `npm run dev` 启动。
若本机尚未安装 Electron 运行时，执行 `node node_modules/electron/install.js` 后重试。
如果之前运行过演示模式，请在「设置 → 开发者」关闭演示模式。演示内容与真实内容共用本地数据库，建议在首次真实接入前清除演示数据（会删除应用内已有数据，请先确认无需保留）。

1. 在「设置 → 复旦账号」打开登录窗口，在官方页面自行输入 UIS 密码和验证码。应用用 eLearning 身份接口核实登录成功，已存在的有效会话也可直接使用。关闭未完成的窗口不会报告登录成功。
2. 点击「立即同步」，在目标页核对课程、作业、截止时间及提交状态。首次同步只对最近 48 小时发布的内容生成新事件，历史作业仍会导入。课程名册不开放时，教师或助教邮箱可能缺失，不影响课程和作业同步。
3. 学生邮箱使用独立的 IMAP 认证。在网页邮箱开启客户端协议并获取客户端专用密码，将完整邮箱地址和专用密码填入设置。默认 `imap.exmail.qq.com`，端口 `993`，使用 TLS。官方依据见[复旦信息化校园指南](https://icampus.fudan.edu.cn/_upload/article/files/74/dd/699f121a4803aa79d828ba217813/3d72ab07-a11d-44df-b61d-61f8c5079b19.pdf)，具体授权方式以当前网页邮箱提示为准。
4. 保存邮箱配置后再次同步，核对最近 14 天收件箱邮件。设置里的「已配置，待验证」仅表示已保存配置，不代表收信已成功。读取使用只读 INBOX，不改变邮件已读状态。
5. 再次同步，确认任务和动态未重复。真实平台的提交闭环请使用正常发生的作业提交验证，应用不会代交作业。

网络超时请先检查校园网或学校提供的 VPN。出现登录过期时重新登录；邮箱认证失败时检查客户端协议和专用密码。macOS 钥匙串不可用时会拒绝保存邮箱密码，请解锁后重试。

本轮已在 macOS 上由用户完成 UIS 登录、eLearning 同步、学生邮箱同步及邮件正文问答验证。其他账号、网络环境和更多课程数据仍需验证，接口模拟测试不代表所有真实场景都已验收。iCourse 当前仅保留认证入口，尚未实现回放数据接入，不参与同步，其会话复用、回放接口及校外可达性尚未验证。Windows 安装包须另在 Windows 上验证。

## 常用命令

| 命令 | 作用 |
|---|---|
| `npm run dev` / `npm run dev:demo` | 开发模式启动（真实 / 演示） |
| `npm test` | 运行测试（主动引擎、课程匹配、演示端到端流程） |
| `npm run typecheck` | 类型检查 |
| `npm run check` | 类型检查 + 测试 + 构建 |
| `npm run dist` | 打包 Windows 安装包（需在 Windows 上运行） |
| `npm run dist:dir` | 打包为当前系统的免安装目录（用于验证打包） |
| `npm run dist:mac` | 打包 macOS 安装包 dmg（需在 Mac 上运行） |

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
resources/                    应用图标
demo-assets/                  演示用的虚构材料（复习讲义）
```
