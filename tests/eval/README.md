# 邮件评测（T4 / T8）

独立于 `npm test`。全部使用内存数据库与虚构邮件，不读取应用数据库、账号、真实邮件或应用设置。

## 一条命令

```powershell
npx vitest run --config tests/eval/vitest.config.ts
```

没有显式配置 `EVAL_*` 时，只评估规则，云端、本地行显示未运行。不会因没有模型而假报模型准确率。

本机 Ollama（无需 Key）：

```powershell
$env:EVAL_KIND = 'local'
$env:EVAL_BASE_URL = 'http://127.0.0.1:11434/v1'
$env:EVAL_MODEL = 'qwen2.5:7b'
npx vitest run --config tests/eval/vitest.config.ts
```

可选设置 `$env:EVAL_PERF = '1'`，同一命令额外运行一次本机 Ollama 生成速度探针，输出 `ollama-performance.json`。用 `eval_count / eval_duration` 计算 token/s，另外记录加载与墙钟时间；这是单次固定提示，不是批量邮件分类耗时。默认不运行此探针，云端模式禁止运行。评测文件顺序不保证模型处于冷启动或热启动，结果会保留实际 `loadMs`。

本机真实工具/工单 smoke（五类对话、两类工单，单独开启，失败逐项记录后返回非零）：

```powershell
$env:EVAL_RUNTIME = '1'
npx vitest run --config tests/eval/vitest.config.ts tests/eval/runtime.eval.ts
```

需要上述 local 三项配置。只操作独立内存数据库和虚构课程、邮件、复习资料；每类60秒、单次请求30秒、回答上限1000token，关闭模型记忆提取以避免GPU争用。结果写 `runtime-results.json`，包含实际工具、卡片、回复和成果。自动检查调用、持久化及顺序；内容完整性仍需人工看结果。这不是 DeepSeek 云端验证，也不是 Electron 界面验收。

云端由用户自己在本机设置 `EVAL_KIND=cloud`、`EVAL_BASE_URL`、`EVAL_MODEL`、`EVAL_API_KEY` 后运行同一命令。密钥只在云端运行器内部传入客户端，结果不保存密钥，也不保存服务端原始报错、原始响应或地址；不要将密钥贴到对话、代码、命令历史或仓库。本地评测不会读取 `EVAL_API_KEY`。

输出 `tests/eval/results.json` 和 `tests/eval/MATERIALS-REPORT.md`。每次覆盖为本次运行结果，未配置模式保持未运行，不拼接旧模型成绩。

## 样本与口径

当前 `tests/fixtures/mails.json` 共16封，元数据见 `mails.meta.json`：前11封来自仓库演示邮件，其余为相同课程下的补充难例。固定参考时间为 `2026-11-06T10:00:00+08:00`，**由AI作演示标注，不是M的正式20/40封人工标注数据**，不能据此声称正式达标。

- 分类是五选一，统计总体与各类准确率。
- 截止字段在规则行与模型行中均使用生产代码共用的确定性 `extractDeadline`，不是独立模型日期抽取准确率。统一为 `Asia/Shanghai` 后精确到分钟；双方为空计对，非法时间计错。分别报告有截止与无截止样本。只给月日的截止按当日23:59标注，属于已公开评测约定；活动举行时间不是截止。只写“截止不变”不从作业标签补出截止。
- 关联始终调用生产代码 `linkMail` 规则，模型行仅可能额外提供 `courseHint`。总体指标要求课程、作业同时正确；另报课程、作业、关联正例、负例和精确率。**不是模型版作业关联**。
- 分开保存每项 `source`、模型/规则数量和分类器 diagnostics。流水线成绩含回退，`modelOnlyMetrics` 仅统计有效模型输出；全部回退不代表模型准确率。
- 分类器按8封分批。记录每次 API 调用耗时与每逻辑批次平均墙钟耗时，包含首次加载、回退与重试；不是 token/s，不说明GPU驻留。
- 评测断言检查数据、调用链及计分正确性，不把当前小样本是否达到产品目标准确率作为测试是否通过的依据。

M 提供正式标注后，按同一格式替换邮件数组，同时更新元数据来源、样本数、标签政策与人工复核状态；先核对课程/作业名称，再运行。不要把演示标注改个文件名充作人工集。

## 验证

```powershell
# 只验证计分规则，不调用任何模型
npx vitest run --config tests/eval/vitest.config.ts tests/eval/metrics.eval.ts
# 类型检查（不会调用模型）
npm run typecheck
```

正式提交仍需负责人运行 `npm run check`。本目录的 `*.eval.ts` 不符合主配置 `tests/**/*.test.ts`，不会被默认测试收录。

## T7 真实50轮摘要回忆（单独开启）

```powershell
$env:EVAL_BASE_URL = 'http://127.0.0.1:11434/v1'
$env:EVAL_MODEL = 'qwen2.5:7b'
$env:EVAL_SUMMARY = '1'
npx vitest run --config tests/eval/vitest.config.ts tests/eval/summary.eval.ts
```

使用内存数据库、生产ChatAgent和滚动摘要模块，真实调用本地模型50轮。关闭工具与独立记忆提取，避免把记忆表效果当作摘要效果；最后检查早期目标分数、固定安排和未完成状态。输出summary-results.json并保留失败，不是通用记忆准确率基准。正式应用仍保留所有工具与记忆能力。

T5四场景提示词实测可单独运行（只允许显式local）：

```powershell
$env:EVAL_KIND = 'local'
$env:EVAL_BASE_URL = 'http://127.0.0.1:11434/v1'
$env:EVAL_MODEL = 'qwen2.5:7b'
$env:EVAL_PROMPTS = '1'
npx vitest run --config tests/eval/vitest.config.ts tests/eval/prompts.eval.ts
```

结果保存prompt-results.json，分别记录早安事实、一般邮件研判、稳定安排记忆、闲聊不记忆。自动检查只覆盖已声明的条件，不取代自然语言内容的人工审阅；不据此声称“不该记比例≤20%”已通过正式评估。
