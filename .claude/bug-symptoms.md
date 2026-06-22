# 白屏 Bug 现象清单

## 现象 1
1 个 AI browser 窗口存在时，Agent → DeepSeek → Agent 切换后，Agent 页面全白，永远不恢复。

## 现象 2
1 个 AI browser 窗口存在时，Qwen → DeepSeek → Qwen 切换后，Qwen 页面全白，永远不恢复。

## 现象 3
Qwen ↔ Agent 之间切换，无论有无 browser，始终正常，从不白屏。

## 现象 4
2 个 AI browser 窗口存在时，即使不切换到 DeepSeek，Agent 和 Qwen 也会白屏。

## 现象 5
无论何种情况白屏，关掉所有 browser 窗口后，白屏自动恢复正常。

## 现象 6
ViewBar、FileBrowser、ControlBar 从不白屏，始终正常。

## 现象 7
没有任何 browser 窗口时，DeepSeek ↔ Agent ↔ Qwen 三者之间切换毫无问题。

## 现象 8
之前尝试添加一个新的菜单栏页面（非新建窗口），也触发了同样的白屏问题。

## 现象 9
与 GPU 无关，禁用 GPU 硬件加速后问题依旧。

## 现象 10
不能靠强制刷新（reload）解决白屏。

## 现象 11
电脑显存、内存、算力均充足，不是资源不足问题。

## 现象 12 (新发现)
打开开发者工具（DevTools）后，白屏页面左侧白屏，右侧开发者工具正常显示。
说明渲染进程仍在运行（DOM 正确），但页面内容没有被绘制到屏幕上。

## 现象 13 (新发现)
`webContents.reload()` 无法恢复白屏。说明问题不在渲染进程，而在合成器帧槽位。

## 现象 14 (新发现)
`removeBrowserView()` + `addBrowserView()` 无法恢复白屏。
说明这个操作不会创建新的 CompositorFrameSink，只是重新挂载同一个。

## 现象 15 (新发现 - 第3次尝试)
z-order 方案（所有视图放在可见区域，用 setTopBrowserView 控制显示）：
- 仍会白屏（被遮挡的视图帧槽位仍被驱逐）
- 会导致视觉混乱（错误页面短暂显示）

## 根因分析

Chromium Viz 合成器管理 CompositorFrameSink（帧槽位）。当 BrowserWindow（local-browser）
存在时，合成器资源紧张，会驱逐"不贡献可见输出"的视图的帧槽位：
- 移出屏幕的视图（x: -10000）
- 被完全遮挡的视图（z-order 方案中）

一旦帧槽位被驱逐，以下操作均无法恢复：
- `webContents.invalidate()` — 无效
- `webContents.reload()` — 无效
- `removeBrowserView()` + `addBrowserView()` — 无效
- `setBounds` 变换 — 无效

唯一已知的恢复方式：关闭所有 BrowserWindow（释放合成器资源）。

## 修复方案 v5 (当前)

### 放弃的方案
- **capturePage() 保活**: 在屏幕外视图上调用 capturePage 可能反而触发合成器驱逐帧槽位
- **about:blank 中转导航**: 导航不会创建新的 RenderWidgetHost/帧槽位，只是复用已驱逐的帧槽位

### 当前方案：forcefullyCrashRenderer 恢复
`recoverFromWhiteScreen()` 在视图从隐藏切换到可见时检测白屏，若检测到则：
1. 调用 `view.webContents.forcefullyCrashRenderer()` 杀死渲染进程
2. 监听 `render-process-gone` 事件
3. 在事件回调中 `loadURL`/`loadFile` 重新加载页面
4. 新的渲染进程会创建新的 CompositorFrameSink

原理：只有杀死渲染进程才能强制创建新的 RenderWidgetHost 和帧槽位。
普通 reload() 和导航都复用在同一个 RenderWidgetHost 上，无法重建帧槽位。