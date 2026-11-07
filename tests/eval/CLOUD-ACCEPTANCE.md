# DeepSeek 云端验收（2026-11-07）

模型：`deepseek-chat`（服务端当前映射到 `deepseek-flash` 非思考模式，应用预设无需修改），地址 `https://api.deepseek.com`。Key 只在本机环境变量中传入，结果文件不含 Key。全部使用演示模式虚构数据和内存数据库，不读取应用设置、账号或真实邮件。

## 1. 演示剧本回放（`cloud-demo.eval.ts`）

按 `docs/DEMO.md` 镜头顺序，在同一个演示库里连续回放需要模型的镜头 3–8，走应用真实的 AppContext、ModelRouter、ChatAgent、TicketExecutor 和主动引擎；时间模拟为录制时刻 2026-11-08（周日）10:00。

| 配置 | 结果 |
| --- | --- |
| 修复前，未授权隐私任务走云端 | 6/9：就差报告无具体时段、交换工单搜不到邮件后失败、复习计划工单步数耗尽 |
| **修复后，未授权（推荐录制配置）** | **连续两轮 9/9**（`cloud-demo-results.json` 为第二轮） |
| 修复后，授权隐私任务走云端 | 5/9（`cloud-demo-results-sensitive.json`）：研判改由云端模型决定，交换建议卡片、交作业确认、考试周主动询问均未按剧本出现 |

**录制建议**：保持「设置 → 模型 → 隐私任务的云端授权」**关闭**，不配置本地模型也可以。此时镜头 5 的交换材料清单因无法读取邮件正文，会如实标注“信息不完整”并说明是隐私设置所致；这是隐私设计的真实表现，可在配音中说明，不要为录制临时打开授权（会改变后续镜头的主动引擎行为）。

## 2. 邮件分类（`mail.eval.ts`，16 封 AI 演示标注）

| 模式 | 分类 | 截止 | 关联（规则） | 每批 8 封耗时 |
| --- | --- | --- | --- | --- |
| 规则 | 100% | 100% | 93.75% | 0.01 秒 |
| 云端 deepseek-chat | **100% (16/16)** | 100% | 93.75% | 3.86 秒 |
| 本地 qwen2.5:7b | 75% (12/16) | 100% | 93.75% | 22.6 秒 |

仍不是 M 的正式人工标注集，不能写成正式达标；完整口径见 `MATERIALS-REPORT.md`。`mail.eval.ts` 现支持在 `EVAL_KIND=cloud` 时另设 `EVAL_LOCAL_BASE_URL`、`EVAL_LOCAL_MODEL`，一次输出三行，避免覆盖掉另一种模型的结果。

## 3. 本次修复

- `src/main/db/repo.ts`（**[接口]**）：`listItems` 的 `query` 按空格拆词、每个词都要命中，修复“新加坡国立大学 交换 2027”这类多词查询返回空；`search` 多词同时命中为空时退回任一词命中。新增 `tests/search-terms.test.ts`。
- `src/main/ai/agent.ts`：`runAgentLoop` 新增可选 `maxSteps` 与 `finishNotice`（只剩两轮时提示一次），对话默认行为不变。
- `src/main/engine/executor.ts`：后台工单步数 8 → 12，步数将尽时提示立即保存，系统提示要求查询有针对性。`tests/ai-runtime.test.ts` 步数上限用例按 12 步更新，新增“提示后保存成功”用例。
- `src/main/ai/prompts.ts`：用户说作业还差一部分时，结合今天空闲时段给出具体时段建议。

`npm run check`：39 个文件、443 项测试、类型检查、构建通过。本地 Qwen `named-goal.eval.ts` 回归通过。

## 4. 局限

每种配置只跑 1–2 轮，模型输出有波动；自动检查只覆盖工具调用、持久化与可见消息，措辞质量需人工看 JSON 里的回复与成果。不是 Electron 界面验收，录制前仍应按 DEMO.md 彩排一遍。

```powershell
$env:EVAL_API_KEY = (Get-Content ..\.secrets\deepseek.key.txt -Raw).Trim()
$env:EVAL_CLOUD_DEMO = '1'; $env:EVAL_BASE_URL = 'https://api.deepseek.com'; $env:EVAL_MODEL = 'deepseek-chat'
npx vitest run --config tests/eval/vitest.config.ts tests/eval/cloud-demo.eval.ts
```
