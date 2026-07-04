# DSAgent Electron — 项目记忆快照 (2026-07-02)

## 项目架构

三层结构：Agentview (前端) → Orchestrator (编排) → Server (服务层) → Inject (页面脚本)

### 关键文件

| 文件 | 角色 |
|---|---|
| `main.js` | Electron 主进程，BrowserView管理，IPC，`execJs`→`safeExecJs` |
| `agentview.html` | Agent UI，聊天区/预览栏/历史管理/模型选择 |
| `agent-engine.js` | 渲染层引擎，工具执行/命令解析（旧Qwen函数已删除） |
| `agent-orchestrator.js` | 主进程编排层，路由 sendMessage→waitForDone→extractResponse |
| `model-registry.js` | 模型注册表，统一 invoke 路由 |
| `server-qwen.js` | Qwen 服务，`execJs`(单次)，`invoke`(newChat/sendMessage/waitForDone/extractResponse/detectResponseType/waitForImageDone/extractImageResponse) |
| `inject-qwen.js` | Qwen 页面注入脚本，`Q.*` DOM 操作协议 |
| `inject-deepseek.js` | DeepSeek 页面注入 |
| `server-deepseek.js` | DeepSeek 服务 |
| `cluster-templates.js` | 集群配置模板 |
| `subagent-manager.js` | Subagent 管理 |
| `history-manager.js` | 历史记录管理 |

## 已完成的关键修复

### 崩溃修复（完成 ✅）
- **Qwen SPA 导航崩溃**: `main.js` Qwen View 改 `contextIsolation: false, preload: null`（根因：`contextIsolation:true+preload.js` 在 SPA 导航时 V8 isolate 冲突 → segfault）
- **execJs 探活崩溃**: `server-qwen.js` 删 `waitForFrameAlive` 探活+8次重试，改单次执行
- **extractResponse 三段式崩溃**: 恢复 clipboard 三段式（clipboard 操作在主进程直接 `require('electron').clipboard`，不依赖 preload）
- **MutationObserver 崩溃**: `inject-qwen.js` 加 1s 节流 + try-catch + `_navigating` 守卫
- **forceRepaint 触发 GPU 崩**: `main.js` forceRepaint 定时器移除 Qwen
- **定时轮询戳帧**: 改读 `qwenServer.getQwenGenerating()` 缓存

### 功能修复（完成 ✅）
- **历史恢复卡同步**: `agentview.html` Qwen 跳过 URL 同步校验
- **删除提示文案**: 改为「是否清除关联缓存」
- **Qwen 第二条消息建新对话**: `agent-orchestrator.js` waitForDone 后 `getCurrentUrl` 更新 `ctx.conversationUrl`
- **Qwen 输出预览条**: agentview.html 发送时显示 "Qwen: 输出中..."，响应到达时隐藏
- **发送按钮→停止按钮**: 状态变量 `isTaskChainActive` 移到 `await` 前设置
- **无会话缓存提示**: 去掉 URL 保存的 `indexOf('chat')` 限制
- **Qwen 图片生成管道**: inject-qwen 加 `detectResponseType`/`waitForImageDone`/`extractImageResponse`，server-qwen 加对应 case + waitForDone 检测 `data-card-type="ai_generate_image_list"`，orchestrator 图片/文字分流

### 已删除
- `tools/tool-qwen.js`（清空）
- `agent-engine.js` 中 ~590 行旧 Qwen 函数（E.qwenGeneral/Draw/PPT/Vision 等 + SendOnly/WaitAndExtract 变体 + __dsagent_qwen 赋值）

## 待办/已知问题

1. **Qwen 图片生成** 管道已搭好，但 extractImageResponse 的图片下载回填 agentview 有待测试
2. **DeepSeek 页面显示 Qwen 内容** — 待排查（可能模型选择/URL路由问题）
3. **Qwen 删除限速** 询问是否清除关联缓存逻辑可优化

## 当前状态

Qwen 已完全整合为与 DeepSeek 同级的模型（都通过 orchestrator.handleRequest → registry.invoke 调用），不再是旧工具路径（tool-qwen.js → __dsagent_qwenGeneral 等）。使用方式：在 agentview 选择 Qwen 模型 → 发消息 → 文字回复走 clipboard 提取 → 图片回复走 detectResponseType→waitForImageDone→extractImageResponse。
