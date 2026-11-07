# 本地查询与记忆修复交接（2026-11-07）

初始基线：main `752d737`；交付已同步 main `8b9c377`（新增 Mac 打包配置，与本次 AI 修复无冲突）。工作分支：`ai/local-loop-memory-fix`。本次针对用户在 Windows 应用中遇到的“查询重复到步骤上限”“无关演示记忆被再次写入”，并修正复测发现的 UTC 展示和查询日期范围问题。

## 实现与范围

- `src/main/ai/agent.ts`：主对话成功只读查询在单轮内复用；重复且没有新进展时仅给一次无工具收尾机会，收尾提出的写操作不执行。写操作、明确 refresh、失败查询不会被当成缓存命中。原有取消、结果卡片与步骤上限仍保留。
- 本地明确查询请求隐藏写工具并在执行前再次检查。独立、范围明确的课程/DDL问句先由程序通过真实 MCP 查询，再让模型整理答案；日期范围、查询次数与工具卡片如实记录。这是程序辅助的本地查询流程，不能称为纯模型自主工具调用成绩。依赖“刚才/这门课”等上下文的查询保留历史；其他日期范围交给原工具循环，不擅自改成七天。
- `src/main/ai/query-context.ts`：区分校历本周（周日到周六）与未来七天；原始 ISO 保留，给模型附上海时间和课程结束状态。参数校正仅用于明确本地课程/DDL查询。
- `src/main/ai/memory-policy.ts`、`agent.ts`、`prompts.ts`：自动提取只输入本轮用户原话；落库及 remember 工具均检查原话依据，拦截问题/假设/助理建议，按空白、大小写和全半角去重。采用保守的原句匹配，部分改写后的真实偏好可能不自动保存。
- `src/main/mcp/hub.ts`：保留服务注册的只读标记供循环判断，不把此元信息发送给模型。
- `src/main/local-tools/server.ts`：`list_deadlines` 增加可选 `pending_only`，支持明确要求只查未完成作业。
- 新增 `tests/local-loop-memory.test.ts`、`tests/eval/local-guards.eval.ts` 与 JSON 结果。没有改 shared、数据库接口、界面、平台包、依赖或已有测试；本次没有需单列的 `[接口]` 文件。

## 验证与证据

完整检查：`npm run check` 通过，37 个文件、419 项测试、类型检查及生产构建。新增 30 项测试涵盖真实 MCP 只读缓存、写后失效、刷新/重试、收尾不执行写操作、取消、原话记忆、否定与数值、查询权限、时区和范围。

本机真实模型：`qwen2.5:7b`，固定参考时间上海 2026-11-07 16:21，使用独立内存数据库与虚构演示资料，启用本地记忆提取，不读取应用设置、应用数据库、真实邮件或任何 Key。

最终 `local-guards-after.json`：两条问题均满足自动检查，实际 MCP 调用分别 1 次、2 次；没有新写入记忆或擅自写入目标/任务。Lab 5 截止正确显示 23:59，第二条正确列出两节课时间与“已结束”。耗时分别约 6.95 秒、11.18 秒，包含模型记忆提取；不是通用推理性能基准。

完整失败记录保留：`local-guards-before.json`（原代码）、`local-guards-first-fix.json`（模型输出原始工具文字）、`local-guards-timezone-failure.json`（UTC误作本地）、`local-guards-history-failure.json`（沿用旧回答）、`local-guards-scope-failure.json`（意图判定漏掉原始问句）。原代码快照的 generatedAt 使用固定测试时间；最终快照已改为真实墙钟时间。不同迭代增加了事实检查项，不能将它们视为同一正式准确率基准。

复测命令：

```powershell
npm run check
$env:EVAL_LOCAL_GUARDS='1'
$env:EVAL_PHASE='after'
npx vitest run --config tests/eval/vitest.config.ts tests/eval/local-guards.eval.ts
```

局限：仅两条固定场景；尚待用户在 Electron 界面重启后确认。旧 T1/T6 的 GRE、复习工单失败，本地分类 68.75%、M 正式人工集与 DeepSeek 云端验收均未被本次替代。既有错误记忆未自动删除，可在对应提示中撤销。

## 交接更新

本地代码与修复前后证据已就绪。提交、推送与 PR 状态以本次交付回复和 GitHub 为准。L 已合并旧 AI PR #10；F1/F2 冲突已由 #11 解决，旧交付文档中对应待办已经过时。本次后续重点：用户界面复测、M 正式数据与剩余真实模型验收。
