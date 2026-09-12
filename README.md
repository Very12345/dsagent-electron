# WebAgent DSH Core

On a host where the optional TUI profile is installed, launch the terminal UI
against the active WebAgent Runtime with:

```sh
webagent-dsh-tui
```

WebAgent DSH Core 是官方 DeepSeek Harness 的本地网页模型传输层。DSH
负责会话、规划、工具、Skill、审批、子代理、上下文压缩和工作区策略；本项目只负责：

- 维护隔离的 DeepSeek 网页登录 Profile；
- 从网页原始 SSE 获取思考、正文和工具协议；
- 向 DSH 提供本地 OpenAI 兼容模型 `deepseek.web`；
- 处理继续生成、限速重试、多账号切换和远端对话清理；
- 使用 DeepSeek 网页原生搜索替代计费 API 搜索。
- 通过当前 `chat.qwen.ai` 网页协议提供 Qwen 文本、原生搜索、生图和语音转写 API。

新入口不会加载旧 WebAgent 内置 Agent、工具执行器、工作记忆、Bot、移动网关、
旧 Qwen DOM/ChatGPT 适配器或 React 工作台。完整旧版保存在 Git 分支
`archive/pre-dsh-core-20260912` 和标签 `pre-dsh-core-20260912`。

## 环境

- Node.js 20 或更高版本；
- Microsoft Edge、Google Chrome，或 Playwright 安装的 Chromium；
- 首次登录需要可见图形会话。无桌面 Linux 可以使用 Xvfb + VNC/noVNC。

## 启动

Windows（默认使用系统 Edge）：

```powershell
npm install
npm run launch -- --workspace D:\Work\WAWorkSpace
```

Linux（使用 Playwright Chromium）：

```bash
npm install
npx playwright-core install chromium
npm run launch -- --workspace "$HOME/workspace" --no-open
```

如果使用系统 Chrome：

```bash
npm run launch -- --browser-channel chrome --workspace "$HOME/workspace" --no-open
```

启动后终端会输出两个仅绑定 `127.0.0.1` 的地址：Provider API 和带一次性认证
Token 的 DSH WebUI。远程机器请使用 SSH 端口转发，不要把 DSH 或 Runtime 直接暴露
到公网：

```bash
ssh -L 3080:127.0.0.1:3080 -L 5858:127.0.0.1:5858 -L 6080:127.0.0.1:6080 user@server
```

后台服务运行时可随时生成一个五分钟内有效、仅可使用一次的 DSH 登录地址：

```bash
webagent-dsh-url
```

打开该地址后，Runtime 只负责把内部 DSH 会话 Cookie 写入 `127.0.0.1`，随即
跳转到 DSH WebUI；Cookie 不会显示在命令行或 URL 中。

无桌面服务器安装 noVNC 后，首次模型请求触发登录窗口时，可在 SSH 转发已建立的
前提下打开 `http://127.0.0.1:6080/vnc.html` 完成登录。VNC 和 noVNC 都只监听
远端 loopback，不能绕过 SSH 隧道访问。

## 账号

浏览器账号保存在 `$WEBAGENT_HOME/browser-profiles`，默认沿用
`~/.webagent/browser-profiles`。示例 Linux systemd 服务显式使用隔离目录
`~/.webagent-dsh`。Windows 浏览器 Profile 不应复制到 Linux；
首次部署需要在 Linux Profile 中重新登录。多账号顺序、网页限速重试和循环切换仍由
Provider 传输层负责。

## 安全边界

- Runtime 和 DSH 只监听 loopback；
- Runtime Bearer Token 只写入用户目录下的 `runtime.json` 并通过子进程环境传给 DSH；
- 网页模型不执行本地工具，工具调用转换后由 DSH 校验和执行；
- DeepSeek 正文和思考全部来自原始 SSE，不读取或修改系统剪贴板；
- 付费 `web-search-deepseek` provider 被禁用；DSH 原生 `web_search` 保留，并可在“插件 → 插件配置 → 网页搜索”中选择 DeepSeek 或 Qwen 网页账号。

## Qwen 网页能力

Qwen 使用独立的 `chat.qwen.ai` 浏览器 Profile；首次使用时在可见浏览器或
noVNC 中完成登录。DSH 会得到四个显式工具，普通模式可用，极简模式保持原生工具集
不变：

- `qianwen_text`：关闭 Qwen 云端工具的纯文本回复，可选择 Qwen3.8-Max 或 Qwen3.7-Plus；
- `qianwen_search`：仅本次请求启用原生网页搜索；
- `qianwen_image`：选择 Qwen-Image 3.0/2.0 和画面比例，下载成品到工作区；
- `qianwen_voice`：把工作区中的 WAV/MP3/M4A/AAC/OGG/OPUS 转成文字。

DSH 模型选择器提供 `qwen.text.web.3.8-max` 和
`qwen.text.web.3.7-plus`。旧 `qwen.text.web` 仅作为已有会话的隐藏兼容
别名保留。两个文本模型都使用 SSE，并将思考增量作为 `reasoning_content`
传给 DSH；可选档位为关闭、低、中、高。`qwen.search.web` 与
`qwen.image.web` 仅是插件调用 Runtime 时使用的内部能力端点，不进入
DSH 的 LLM 模型选择器。生图的非流式响应会同时在顶层
`images` 和 `choices[0].message.images` 返回图片 URL；流式响应在最终
`delta.images` 中返回。语音输入使用认证后的
`POST /api/qwen/voice/transcriptions`，JSON 字段为 `audio_base64`、
`filename`、`content_type` 和可选 `language`。

该传输层按真实网页的当前字段发送 `t2t`、`search` 或 `t2i` 请求；不会通过
提示词伪装搜索/生图，也不会在普通文本请求中偷偷打开网页搜索。

## 验证

```bash
npm test
npm run smoke
```
