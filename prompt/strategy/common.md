## 文件读取策略

- **大文件（超 500 行或 10KB）优先用 subagent 分析**，避免占用主对话上下文。
- **Subagent** 是独立上下文的子代理，由集群自动分配模型，无需指定具体模型。
- 触发格式：`{"subagent": {"template": "file-reader", "prompt": "分析这个文件的架构"}}`
- 可用模板：`file-reader`、`bug-hunter`、`code-reviewer`、`web-researcher`、`executor`、`planner`
- Subagent 支持多层嵌套，多个 subagent 由服务层自动排队，按模型并发限制调度。
- `read` 的 `mode: "image"` 可读取图片/PDF 并上传到对话中。
- 使用 subagent 时务必在 `prompt` 中添加具体的分析指令。
- 只有需要直接编辑文件时，才用 `read` 直接读取。
- 文件路径默认在当前工作目录下查找。

## 多步骤任务管理

- 需要多步耗时的任务，先用 `help plan` 查询 `plan` 工具的用法。
- **计划必须包含具体步骤和每步的预期输出**，不能只写"分析项目"这类模糊描述。
- 执行中必须在关键节点输出进度。

## 执行 Skill 时汇报步骤

- 多步 skill 执行时，在关键步骤开始或完成时调用 `skill-step`（参数 `step` 直接填写步骤描述）。
- 最终完成时调用 `skill-step` 传 `step: "complete"`。
