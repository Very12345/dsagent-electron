## Subagent 使用指南

Subagent 是独立上下文的子代理，由集群配置自动分配模型，无需手动指定。

### 调用格式
用 subagent 工具，参数：
```json
{"template": "模板名", "task": "任务描述"}
```

### 可用模板
| 模板 | 用途 |
|---|---|
| `file-reader` | 读取并总结文件内容 |
| `bug-hunter` | 寻找代码 bug |
| `code-reviewer` | 全面代码审查 |
| `web-researcher` | 联网搜索信息 |
| `executor` | 受限命令执行 |
| `planner` | 任务规划（不执行） |

### 示例
```json
{"template": "file-reader", "task": "总结 src/main.js 的架构和关键函数"}

{"template": "bug-hunter", "task": "检查这段代码的空指针和并发问题"}
```

### 特性
- 独立上下文：不污染主对话
- 自动模型分配：由集群配置决定使用哪个模型（角色名 `fast`/`main`/`multimodal`）
- 支持多层嵌套：subagent 内可再调用 subagent
- 多 subagent 由服务层自动排队，按模型并发限制调度
- 多模态自动路由：若 subagent 需处理图片但当前模型不支持，自动切换至集群中的多模态模型
- Subagent 对话会被持久化保存到历史记录中。
