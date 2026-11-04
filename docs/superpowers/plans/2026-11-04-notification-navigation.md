# 通知消息定位修复

目标：系统通知点击后恢复主窗口，切到对话并定位对应消息。首次订阅前的导航不丢失；重复点击可再次定位；历史通知超出最近 200 条也可找到；已清理或读取失败时给出提示和返回最新消息入口。设置未保存的离开确认继续生效。

已确认根因：App 丢弃 navigate.id；Chat 无目标状态且总是滚到底部；历史接口仅返回最新消息；preload 在页面订阅前不接收导航。

- [x] 先编写并观察失败测试：历史上下文与启动缓冲。
- [x] 兼容扩展 chat.history(limit?, aroundId?)，增加有边界的相邻上下文查询。
- [x] 接通 App 目标与 Chat 定位、高亮、焦点、返回最新消息及错误提示。
- [x] preload 缓冲首次订阅前的最后一次导航，兼容 React StrictMode。
- [x] 完整检查、实际 Electron 通知回调及页面定位验证。
- [x] 独立代码复核并修正问题。

验证结果：新增 8 项回归测试（历史上下文与 preload 订阅缓冲）；完整 93 项测试、类型检查及生产构建通过。隔离数据库的 Electron 验证覆盖旧消息、重复/快速点击、焦点与滚动、草稿、窗口唤回、设置未保存确认、非法事件、已清理消息，以及 renderer 正在重新加载时点击实际 Notification 对象的回调。系统通知展示在此自动验证中被拦截，未依赖 Windows 通知中心设置。

复核发现并修复：重复目标的 effect 不能在旧 DOM 上提前登记聚焦完成；主进程等待 did-stop-loading 后再发送加载期间暂存的最后一次点击（did-finish-load 时 isLoadingMainFrame 仍可能为 true）。

共享/后台改动：src/shared/ipc.ts、src/main/ipc.ts、src/main/db/repo.ts、src/main/index.ts。后续 PR 使用 [接口] 标题并交 L 审核；本次不合并远端分支。
