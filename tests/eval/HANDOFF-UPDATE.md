# 交接更新：AI开发（2026-11-06）

> 2026-11-07 补充：旧 AI PR #10 已合入 main，F1/F2 冲突已由 #11 解决；下文是原交付快照。本地重复查询、记忆来源、时间与范围修复见 [LOCAL-MODEL-FIX.md](LOCAL-MODEL-FIX.md)，分支 `ai/local-loop-memory-fix`，源码提交 `cd43023`，[草稿 PR #16](https://github.com/sjy0630/personal-assistant-fudaner/pull/16) 已推送，419 项测试与两条本机复测通过，待界面确认后正式审核，未合并。

分支：ai/competition-ready。基线：origin/f1/main-chat 的 ceb7f9b。代码提交：f28eefd94be2038bdaf2e75f629e10ed6782dc78。

## 当前交付状态

| 任务 | 已完成 | 未完成/依赖 |
| --- | --- | --- |
| T1 | 五类工具真实MCP回归；本机真实模型逐项运行并保存工具、卡片、结果；错误参数/ID不再静默写入 | 最后一轮本机五类4/5，GRE父ID错误被拒绝；指定DeepSeek验收待用户本人配置。用户已选择先交付本地结果 |
| T2 | 接续F1 ChatRun快照协议；流式/非流式完整结束、JSON参数、取消/断流成果保护回归；保留原UI与接口 | 本轮不宣称重新完成Electron界面验收；F1原有人工测试见其文档 |
| T3 | 本机生成48.15token/s；16封分类平均14.39秒/8封；RTX4060 Laptop GPU驻留正常 | 分类与多步工具行为不稳定，结论为本地“已支持、可选”，暂不作为正式主线 |
| T4 | 独立评测配置、16封AI演示标注、指标/错例/来源/回退/耗时和报告输出 | M的正式20/40封独立人工标注未到；演示集不能作为正式达标准确率 |
| T5 | 日期证据提取与2022年纠正；分类校验/回退；早安/研判/记忆约束及四场景真实本机smoke通过 | 最终小样本模型分类68.75%，未达目标；自然语言体验与不该记比例仍需用户评估 |
| T6 | 必须查询来源、保存真实非空资源且正常结束才完成；失败报告、步骤耗尽与模板路径测试通过 | 最后一轮交换工单通过，复习工单未成功保存；真实模型两类稳定验收仍未完成 |
| T7 | 后台增量摘要、稳定游标、300字、CAS/并发/wipe保护；60消息单测与真实50轮回忆通过 | 50轮为虚构场景且关闭独立记忆表/工具的隔离测试，不是通用记忆准确率 |
| T8 | results/性能/runtime/摘要/提示词JSON、材料说明与方法文字齐全 | 正式说明书数据须待M人工集和云端验收后更新 |

## 修改范围

- AI：agent.ts、llm.ts、mail.ts、prompts.ts；新增deadline.ts、summary.ts、tool-policy.ts、validation.ts。
- AI拥有的执行模块：engine/assess.ts、engine/executor.ts、local-tools/server.ts。
- **[接口]：仅 src/main/db/repo.ts** 追加摘要读取、批次和原子保存方法；保留F1全部分页/撤销方法，不改schema、不重排。
- 新增AI测试及tests/eval、tests/fixtures；未修改既有测试、渲染层、shared、app-context、平台packages、package.json或锁文件。
- 云端未授权时屏蔽读取邮件正文/全文片段的工具，检查get_assignment真实类型，防止邮箱ID别名绕过。

## 验证命令

```powershell
npm run check
# 28文件315项测试 + 类型检查 + 构建，通过；不会调用真实模型。
npx vitest run --config tests/eval/vitest.config.ts tests/eval/metrics.eval.ts
# 只验证计分。
$env:EVAL_KIND='local'
$env:EVAL_BASE_URL='http://127.0.0.1:11434/v1'
$env:EVAL_MODEL='qwen2.5:7b'
npx vitest run --config tests/eval/vitest.config.ts tests/eval/mail.eval.ts
$env:EVAL_RUNTIME='1'
npx vitest run --config tests/eval/vitest.config.ts tests/eval/runtime.eval.ts
# 实际模型有未通过项时按设计返回非零，结果已保存，不要改成假通过。
$env:EVAL_SUMMARY='1'
npx vitest run --config tests/eval/vitest.config.ts tests/eval/summary.eval.ts
$env:EVAL_PROMPTS='1'
npx vitest run --config tests/eval/vitest.config.ts tests/eval/prompts.eval.ts
```

## Git与PR交接

源码已经提交，评测证据另一个提交。本分支需作为[接口]PR交L审核，建议PR基线f1/main-chat（ceb7f9b），避免把F1整条未合并链误算为AI新增代码。PR标题/正文见PR-DRAFT.md；本轮提供创建链接，不冒称已经创建GitHub PR。没有合并main，没有改F2六处冲突。

完整评测口径见EVALUATION-NOTES.md与MATERIALS-REPORT.md。没有调用云端，没有读取或提交真实API Key。模型实际失败已保留；代码交付不等于所有真实模型质量目标已达标。
