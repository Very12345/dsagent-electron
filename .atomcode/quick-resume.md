# DSAgent Electron 项目引导

## 一句话
Electron 应用，控制 AI 网页(DeepSeek/Qwen)的 BrowserView，通过 inject 脚本 + server 编排实现自动化问答/绘图/Subagent。

## 当前进度
- Qwen SPA 导航崩溃已修（`contextIsolation:false, preload:null`）
- Qwen 已完全整合为与 DeepSeek 同级的模型（同走 orchestrator.handleRequest）
- 旧 tools/tool-qwen.js + agent-engine.js 旧 Qwen 函数已删除
- Qwen 图片生成检测/提取管道已搭好（detectResponseType→waitForImageDone→extractImageResponse）
- extractResponse 恢复三段式 clipboard 提取（主进程 `require('electron').clipboard`）
- 所有 executor/retry 戳帧逻辑改为单次执行
- 还有 3 个待办（见 session-memory.md）

## 快速开始
1. 先读 `.atomcode/session-memory.md` 获取完整记忆
2. 所有 key files 列在 memory 的架构表中
3. 当前待办在 memory 末尾
