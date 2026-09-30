# DSH 插件项目总览

这组项目维护五个独立的 DeepSeek Harness 插件，以及网页模型插件所需的浏览器传输后端。DSH 由官方桌面版或 CLI 提供；这些仓库不维护 DSH 本体，旧 WebAgent 独立应用已退出维护。

## 仓库与职责

| 仓库 | 维护内容 |
| --- | --- |
| [dsh-webagent-integration](https://github.com/Very12345/dsh-webagent-integration) | 网页模型、原生搜索、Qwen 工具及账号设置页 |
| [dsh-lark-link](https://github.com/Very12345/dsh-lark-link) | 飞书/Lark 桥接、流式卡片、多应用隔离及会话管理 |
| [dsh-archive-delete](https://github.com/Very12345/dsh-archive-delete) | 已归档会话的查看、删除及归档登记同步 |
| [dsh-bash-windows](https://github.com/Very12345/dsh-bash-windows) | Windows Git Bash 终端执行器及会话 preset |
| [dsh-computer-use-windows](https://github.com/Very12345/dsh-computer-use-windows) | Windows 桌面应用操作、窗口绑定、截图及输入验证；不包含浏览器操作 |
| [dsagent-electron](https://github.com/Very12345/dsagent-electron) | DeepSeek/Qwen 网页模型传输后端；沿用历史目录及 npm 包名 |

每个插件都有自己的 Git 仓库、依赖清单和分发文件，分别维护版本。它们不组成 npm monorepo，也不要求安装旧 WebAgent 应用。

## 运行关系

```text
官方 DSH 桌面版 / CLI
  ├─ dsh-webagent-integration → loopback HTTP → 浏览器传输后端 → DeepSeek / Qwen 网页
  ├─ dsh-lark-link            → 飞书 / Lark
  ├─ dsh-archive-delete       → DSH 会话存储
  └─ dsh-bash-windows         → Windows Git Bash
```

网页模型插件需要单独运行传输后端；其他插件可独立使用，Bash 插件限定 Windows。后端只启动 provider API，不捆绑、启动或管理 DSH，也不执行本地 Agent 工具。

当前插件接口以 DSH 0.2 系列为兼容目标。DSH 宿主版本、源码插件版本、profile 中安装的插件版本和传输后端版本分别核实，不能从历史常量或开发依赖推断实际宿主版本。

## 安装

使用 DSH 官方插件管理器从 GitHub 或本地 tarball 安装。示例：

```sh
dsh plugin --profile desktop add github:Very12345/dsh-lark-link
# CLI WebUI 使用自己的 profile，例如 --profile web。
```

在源码仓库执行 `npm pack` 后，也可用 `dsh plugin --profile <name> add file:/absolute/path/package.tgz` 安装。私有 GitHub 仓库需要相应 Git 访问权限。当前 npm 公共仓库没有可直接安装的这些 scoped 包，不应把 GitHub 源码推送当成 npm 发布。

各插件的连接配置、凭据引用、宿主要求和使用步骤以相应仓库 README 为准。网页模型传输后端的启动步骤见 [后端 README](../README.md)。

## 开发与验证

| 仓库 | 本地检查 |
| --- | --- |
| dsagent-electron | `npm install`、`npm run verify` |
| dsh-webagent-integration | `npm install`、`npm test` |
| dsh-lark-link | `npm install`、`npm run check`、`npm test`、`npm run build` |
| dsh-archive-delete | `npm test` |
| dsh-bash-windows | `npm test`；宿主集成测试需要当前 DSH 0.2 SDK |

分发前在相应仓库执行 `npm pack --dry-run`，核对宿主入口、客户端文件及 bundle patch。Lark 插件提交 `dist/` 以支持 Git URL 安装，修改源码后须重新构建。

自动测试验证传输协议、临时存储、工具链和插件接口；真实账号登录、飞书消息及 DSH 设置页仍需在实际宿主中联调。源码推送与宿主安装、远端部署分别处理。

## 历史与运行数据

旧 WebAgent 应用、内嵌 DSH 插件及旧启动器可在 Git 历史中追溯；本地归档仅用于恢复，不进入当前分发内容，也不作为版本判断依据。浏览器登录 Profile、会话和凭据属于运行环境，不放入源码仓库或公共文档。
