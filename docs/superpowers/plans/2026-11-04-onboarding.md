# 首次使用引导 Implementation Plan

**Goal:** 首次启动显示四步引导，重启记住完成状态，设置可重新打开且保留原配置。

**Architecture:** 沿用现有 React / Electron IPC 和 SQLite 设置。App 控制引导入口；Onboarding 页面负责四步表单；独立辅助模块验证模型输入并保证画像保存成功后才标记完成。

**Tech Stack:** React 19、TypeScript、CSS Modules、Vitest、现有 FudanerApi。

## Global Constraints

- 仅做引导及其入口；不做流式、Markdown、卡片和通知改造。
- 保持现有视觉和公共样式，新增页面使用独立 CSS Module。
- 不提交密钥；读取现有模型配置；用户提供的网关仅存在本机应用设置。
- Settings 增加可选 onboardingCompleted 字段，不改数据库结构；共享类型改动交 L 审核。
- 真实 UIS / 邮箱为可选连接；演示数据与云端模型是独立选项。

## Task 1: 完成状态和配置校验

Files: tests/onboarding.test.ts; src/renderer/src/pages/onboarding-state.ts; src/shared/types.ts。

- [x] 编写测试覆盖无效模型地址、空模型名、画像保存失败、配置保存后重启、既有模型与提醒设置保留。
- [x] 运行测试确认新增功能缺失，再实现验证与完成函数。
- [x] 完成函数先保存非空、去首尾空格的助理名及画像，再只写 onboardingCompleted 标记。

## Task 2: 四步页面和入口

Files: src/renderer/src/pages/Onboarding.tsx; Onboarding.module.css; App.tsx; Settings.tsx。

- [x] 模型：读取已有配置；支持自定义兼容端点和可选本地模型；保存并测试；区分未测试、成功、失败。
- [x] 账号：明确演示 / 真实连接；UIS 登录由用户操作；邮箱可选；保存和同步有忙碌状态与错误反馈。
- [x] 画像：昵称、院系、年级、学历、一句话介绍；可跳过；前后切换不丢输入。
- [x] 助理：名字、三种风格、示例回复；完成后进入主对话。
- [x] App 先加载持久化设置，加载失败允许重试；已完成则不强制引导；设置页按钮重新打开。
- [x] 重新打开期间关闭返回设置，保留之前配置；首次引导只能完成退出。

## Task 3: 验证和交付

- [x] npm run check。
- [x] 实际应用验证首次引导、返回修改、模型连接、完成、刷新后不再强制出现、从设置重开。
- [x] 本机模型连通测试，不在截图和日志中暴露密钥。
- [x] 检查差异与敏感内容，保持本地分支，不自动发布或合并。

验证结果：npm run check 通过（66 项测试）；独立 Electron 测试覆盖真实网关连通、四步流程、错误提示、可选邮箱跳过、重启保留配置及 900×600 深色布局。
复核修正：演示初始化跳过已完成引导的个人画像；该 src/main/demo/demo.ts 小改动及共享类型需由对应负责人审核。
