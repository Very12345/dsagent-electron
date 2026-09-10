# WebAgent

WebAgent 是共享同一本地 Runtime 的多 Provider 工作台。当前架构由纯 Node
Runtime、浏览器/PWA 工作台与系统 Edge Provider Worker 组成；`webagent` CLI
和 PWA 是地位相同的客户端。DeepSeek、Qwen、ChatGPT 与任意 OpenAI 兼容
端点只是模型 Provider，不再打包 Electron 或额外 Chromium。

## 启动

```powershell
npm install

# 日常启动已构建的 Renderer，不重新构建；自动打开默认浏览器
npm run launch

# 修改前端源码后才使用（会先重新构建 Renderer）
npm start
```

Provider Worker 默认使用无头系统 Edge，不会为每次请求或审批弹出额外浏览器。
只有检测到 Provider 未登录时，WebAgent 才使用同一隔离配置目录临时打开登录页；
登录成功后窗口自动关闭，原 Run 在无头 Worker 中恢复。调试 DOM 时可显式使用
`npm run launch -- --headed-workers` 恢复可见 Worker。

也可以只启动共享 Runtime，不打开工作台：

```powershell
npm run start:runtime
```

## DeepSeek Harness

项目固定使用官方 `@deepseek-ai/dsh` 依赖，并在 WebAgent 内管理它的 WebUI
sidecar。打开 Activity Bar 中的 **DeepSeek Harness**，WebAgent 会自动：

1. 在 `127.0.0.1` 的空闲端口启动 `dsh web`；
2. 将官方 DSH WebUI 嵌入工作台；
3. 为 DSH 注册 `WebAgent · DeepSeek Web` OpenAI 兼容 Provider；
4. 将模型请求转发给已登录的 DeepSeek 网页；
5. 把网页返回的 `Calling:` 协议转换为原生 OpenAI `tool_calls`，工具仍由
   DSH 自己执行，WebAgent 不会重复执行；
6. 每轮安全清理临时 WebAgent/DeepSeek 远端会话，避免测试对话堆积。

Runtime Token 只通过子进程环境变量传递，不写入 DSH 的 `settings.yaml`。
DSH WebUI 没有对外认证，因此始终只绑定 loopback，不开放到局域网。

官方源码参考：[deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)。

## Qianwen 网关模型

`qwen.gateway`（界面显示 **Qianwen 网关模型**）使用 WebAgent 管理的
[Rogator](https://github.com/nichengfuben/rogator) 侧车。账户与模型服务页可完成
固定版本安装、Qwen 账号配置、启动和停止。该侧车始终绑定 `127.0.0.1`，并把
Rogator 的 `[upstream].enabled` 锁定为 `["qwen"]`；WebAgent 不接入 Rogator 的
DeepSeek 网页逆向实现。

WebAgent/DSH 继续拥有消息顺序、工具和 Agent 循环，发往 Rogator 的请求不携带
工具清单，避免 entml 与 DSH 双重注入。Qwen 原生思考和正文会分别流式返回，
取消 Run 会同步中止侧车请求。账号密码由操作系统 CredentialVault 加密保存（Windows
使用 DPAPI），只有
侧车运行期间才临时生成 Rogator 所需的账号 CSV，停止时立即清除。

## 浏览器 Worker 与登录

网页 Provider 使用系统安装的 Microsoft Edge。WebAgent 为 DeepSeek、Qwen、
ChatGPT 和 Qwen Gateway 分别建立 `~/.webagent/browser-profiles/` 下的专属
持久 Profile；不会读取或接管用户日常 Edge Profile。每个 Provider 共享登录态，
每个活跃 Run 独占一个 Page。由 Electron 5.x 迁移到 Node 6.x 后，各网页平台需
在新的专属 Profile 中重新登录一次，旧 Electron 登录目录不会被自动删除。

PWA 与 Runtime 通过同源代理通信。启动器生成一次性票据并换取
`HttpOnly; SameSite=Strict` Cookie，Runtime Bearer Token 不会写入浏览器 URL、
localStorage 或前端构建产物。

## 三种会话模式

- `chat`：普通对话。服务端强制关闭文件、Runtime 工具、Skill、MCP、
  Subagent 和记忆写入；支持 Provider 原生思考/搜索以及 Renderer 离线
  Mermaid、KaTeX、`wa-plot`、Typst/CeTZ 预览。
- `project`：绑定项目目录，开放工程工具、审批、Skill、项目记忆、
  Subagent 和 Agent Cluster。
- `work`：默认在 `D:\Work\WAWorkSpace` 中完成日常办公，按回合写入每日
  记录并提炼 `MEMORY.md`，产物自动归档到安全的工作子目录。

有消息的会话不能原地提升权限；转换模式会创建新会话并携带确认后的摘要。

CLI 示例：

```powershell
webagent --mode chat -m chatgpt.web -p "你好"
webagent --project D:\Code\Project\Example -m deepseek.expert -p "分析并验证项目"
webagent --mode work --work-root D:\Work\WAWorkSpace -p "整理今天的会议记录"
```

新 Runtime 信息与数据位于 `~/.webagent`。过渡版本继续兼容 `dsagent`
命令、`window.dsagent`、`.dsa` 只读回退和 `X-DSAgent-*` 请求头；新入口为
`window.webagent` 与 `X-WebAgent-*`。

## 验证

```powershell
npm test
npm run typecheck
npm run build:renderer
npm run test:e2e
npm run smoke:cli
```

大型隔离验收项目可通过以下命令生成；脚本拒绝覆盖非空目录：

```powershell
node scripts/generate-large-test-project.js D:\Code\Project\WebAgentLargeTest
```
