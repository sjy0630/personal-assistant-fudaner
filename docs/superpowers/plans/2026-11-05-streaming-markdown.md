# 真实流式回复与 Markdown 实现计划

目标：模型实际返回的正文增量和工具进度立即显示；完成后同一消息持久化；停止或断线保留已收到的文字。Markdown 兼容暖色宋体，支持基本语法和 GFM 表格。

架构：OpenAI 兼容客户端在 onDelta 存在时使用 SSE，重组分片工具调用；ChatAgent 持有单次运行及 AbortController，通过 chat:delta 推送带版本号的运行快照。chat.state 恢复离开页面期间的运行，chat.cancel 停止指定运行。前端独立 hook 管理进行中消息，Markdown 组件只渲染安全的 React 元素。

约束：不伪造打字动画或思考内容；不把工具参数分片当成正文；后台工单与敏感任务保留原来的非流式调用；仅主对话流式。新增后台及共享接口变更留在独立分支，后续交 AI/L 审核，暂不发布 PR。

- [x] 客户端：先验证真实 SSE 分片在请求结束前到达、工具参数重组、取消、截断及断流，再实现可选 onDelta/signal。
- [x] 智能体：测试并实现稳定消息 ID、单次运行保护、跨工具轮正文、工具调用标识、停止与失败保留部分内容、运行快照恢复。
- [x] IPC：接通 chat:delta、chat.state、chat.cancel；chat.send 等待并传播接收失败，避免未处理的异步错误。
- [x] 对话：实现运行快照 hook、停止按钮、明确状态；新主动消息不清掉正在生成的回复；用户上滚时不强制滚底。
- [x] Markdown：react-markdown + remark-gfm；禁用原始 HTML、危险链接及自动远程图片；验证未闭合代码块、长代码和深色小窗口。
- [x] 完整检查、独立代码审查、真实 Electron SSE 端到端验证、已有通知跳转回归；打开软件供试用。

参考：已安装 openai@6.49.0 的 README、src/lib/ChatCompletionStream.ts（SSE 与工具分片）；https://github.com/remarkjs/react-markdown（skipHtml、组件替换、安全约束）；https://github.com/remarkjs/remark-gfm（GFM）。


验证结果：npm run check 通过（106 项测试、类型检查、生产构建）；Electron 验证真实 SSE 逐段显示、Markdown/GFM、跨页面及刷新恢复、旧快照不复活、主动提醒不清除运行、2px 慢速上滚保持位置、停止与断流保留内容、实际 MCP 查询状态和 900×600 深色布局。已回归通知点击、加载期间点击、历史消息和未保存设置保护。独立代码审查发现的上滚问题已修复并复核。

真实模型：使用本机已有的 DeepSeek-V4.1-Flash 配置，在固定演示提示下收到 17 段正文，首段约 5.3 秒、完成约 5.7 秒；没有把密钥写入仓库或测试配置。试用软件已启动。
