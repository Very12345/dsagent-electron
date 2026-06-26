## 工具调用格式

所有工具使用 `<tool:工具名>` 标签调用。标签内的内容是一个单层 JSON 对象，包含所有参数。

```
<tool:exec>
{"body": "命令内容", "timeout": 60000}
</tool:exec>
```

或单行：
```
<tool:exec>{"body": "命令内容", "timeout": 60000}</tool:exec>
```

- `body`：命令内容或文件内容等（多数工具必填）
- 其他参数（如 `path`、`timeout`、`force` 等）：按需提供
- 路径和 URL 直接写，不要加 Markdown 反引号

## 返回格式

所有工具返回统一 JSON 结构：
```json
{
  "success": true,
  "data": "结果数据",
  "error": null,
  "meta": { "tool": "exec" }
}
```

## 可用工具

（此部分由系统动态生成，加载时自动替换为当前可用工具列表）

## 新工具提示

（此部分由系统动态生成，如果有新增工具，会在此标注）
