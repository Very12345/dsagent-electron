# DSH 网页模型传输后端

此仓库为独立插件 [@very12345/dsh-webagent-integration](https://github.com/Very12345/dsh-webagent-integration) 提供 DeepSeek / Qwen 浏览器传输。历史目录 `dsagent-electron` 和 npm 包名 `webagent-dsh-core` 暂时保留，便于已有安装衔接。

旧 WebAgent 独立应用已退出维护。当前入口只启动 provider API；DSH 使用官方桌面版或 CLI 单独运行，并通过独立插件接入。后端不捆绑 DSH，不安装插件、不写 DSH profile、不执行本地 Agent 工具。工作区的插件分别维护，职责如下：

| 插件 | 仓库 |
| --- | --- |
| 网页模型、搜索、Qwen 工具与账号设置 | [dsh-webagent-integration](https://github.com/Very12345/dsh-webagent-integration) |
| 飞书/Lark 桥接 | [dsh-lark-link](https://github.com/Very12345/dsh-lark-link) |
| 已归档会话删除 | [dsh-archive-delete](https://github.com/Very12345/dsh-archive-delete) |
| Windows Git Bash 终端及会话 preset | [dsh-bash-windows](https://github.com/Very12345/dsh-bash-windows) |

项目总体关系、兼容目标和各仓库的验证入口见 [项目总览](https://github.com/Very12345/dsagent-electron/blob/main/docs/WORKSPACE.md)。

## 能力与职责

- 隔离的浏览器登录 Profile、多账号顺序、限速重试和 Worker 调度。
- DeepSeek 原始 SSE：正文、思考、DSML；实时流丢失时可从同一会话的持久历史恢复已提交的回复。
- Qwen 页面文本及思考 SSE、自然工具调用协议；搜索、生图、语音转写使用专用 Rogator 通道。
- OpenAI 兼容 `/v1/models`、`/v1/chat/completions`、`/v1/responses`，以及插件使用的账号管理和转写接口。
- 工具协议转换和传输校验；实际工具执行、审批、工作区策略和会话编排属于 DSH。

DeepSeek 每账号最多两路并发，账号满载时按配置借用健康账号；Qwen 页面池默认两路。

## 启动

需要 Node.js >= 20，以及 Edge、Chrome 或 Playwright Chromium。首次登录需要图形会话。

Windows：

```powershell
npm install
npm run start -- --port 5859 --workspace D:\Work\WAWorkSpace
```

Linux：

```sh
npm install
npx playwright-core install chromium
npm run start -- --port 5858 --workspace "$HOME/workspace"
```

默认端口为 `5858`，Windows 默认使用系统 Edge。使用 Chrome 可加 `--browser-channel chrome`，使用特定 Chromium 可加 `--browser-executable <path>`。`--headed-workers` 显示浏览器 Worker。

`webagent-runtime` 是新的 CLI 名称；`webagent-dsh` 仍指向同一入口。旧启动脚本中的 `--runtime-only`、`--no-open` 作为兼容参数接受，后端始终只提供模型 API。旧 `--harness-port` 和 DSH 登录票据入口已移除。

## 与独立插件连接

在官方 DSH 的目标 profile 中安装 `@very12345/dsh-webagent-integration`，把插件的 `runtimeUrl` 和模型 provider 的 `baseURL` 指向同一个后端端口，凭据引用使用 `WEBAGENT_DSH_TOKEN`。完整步骤见 [插件 README](https://github.com/Very12345/dsh-webagent-integration#readme)。

可选择的文本模型为 `deepseek.web`、`qwen.text.web.3.8-max`、`qwen.text.web.3.7-plus`。搜索、生图及转写作为插件工具提供，能力端点不应重复填入 DSH 模型选择器。

API 只监听 `127.0.0.1`，模型及账号接口需要 Bearer Token。远程使用采用 SSH 转发，并在远端同机连接 DSH 与后端；两者分别部署和验证。

## 数据

`WEBAGENT_HOME` 默认是 `~/.webagent`：

| 路径 | 内容 |
| --- | --- |
| `browser-profiles/` | DeepSeek / Qwen 登录状态 |
| `provider-accounts.json` | 账号顺序、登录记录和冷却状态 |
| `runtime-token` | 持久化 Bearer Token，重启复用 |
| `runtime.json` | 当前后端 PID、端口和连接信息，包含 Token |
| `transport/` | 网页传输会话映射与事件 |
| `qwen-gateway/` | Qwen 专用网关状态 |

`WEBAGENT_RUNTIME_TOKEN` 可覆盖持久 Token；`WEBAGENT_RUNTIME_TOKEN_FILE` 可改变 Token 文件位置。这些运行数据不进入源码仓库。

## 源码与验证

| 位置 | 内容 |
| --- | --- |
| `src/node/dsh-core.js` | 传输后端 CLI，沿用历史文件名 |
| `src/runtime/dsh-core-runtime.js` | 组装 Provider、会话映射及 API |
| `src/node/playwright-provider-host.js` | 浏览器、账号与网络捕获 |
| `src/runtime/provider-manager.js` | 调度、协议修复和模型路由 |
| `server-*.js`、`inject-*.js` | DeepSeek / Qwen 网页适配 |
| `tools/tool-parser.js`、`tool-loop.js` | 传输协议解析；不执行本地工具 |
| `integrations/rogator-qwen/` | Qwen 专用网关适配 |
| `test/runtime/` | 当前传输后端的回归测试 |

```sh
npm run verify
npm pack --dry-run
```

自动测试使用隔离状态和模拟页面；实际账号登录及模型回复需要在浏览器中联调。旧 WebAgent 源码、内嵌 DSH 插件及宿主管理测试保存在 本地工作区的 `_archive/`，不参与本仓库发布。
