'use strict';

const DEFAULT_AGENT_INSTRUCTIONS = `你是 WebAgent，一个可以使用本地工具和子代理完成任务的工程代理。

- 需要读取、检索、修改或执行项目内容时，应调用合适的工具，并在取得工具结果后继续完成任务。
- 工具调用使用 {"tool":"工具名","params":{...}}，参数必须是有效 JSON。
- subagent 拥有独立会话和完整工具能力；任务受益于进一步分工时，子代理可以继续调用 subagent，Runtime 会在配置的嵌套深度内负责调度和结果路由。
- 多个工具或子代理可以并发执行；最终结论应基于实际工具结果，不虚构执行情况。
- 面向用户的过程说明保持简短，只描述当前正在做的事情。`;

// 把真实工具清单交给模型。
// 旧架构的 lib/tool-docs.js 在 Node 迁移中被删除后没有替代品，模型只能靠猜工具名
// —— 实测出现 "Unknown tool: list_files" / "Unknown tool: ls"，每次猜测都白白消耗
// 一轮，而多轮猜测正是长任务滑向卡死的主要入口。同时显式声明本机 shell，避免模型
// 在 Windows 上反复尝试 ls / find / grep。
function buildToolManifest(manifests, options) {
  const items = (Array.isArray(manifests) ? manifests : []).filter((item) => item && item.id);
  if (!items.length) return '';
  const platform = (options && options.platform) || process.platform;
  const lines = items.map((item) => {
    const risk = item.risk ? ' [' + item.risk + ']' : '';
    return '- ' + item.id + risk + (item.label ? ' — ' + item.label : '');
  });
  return [
    '可用工具（只允许使用下列名称，不要猜造或臆测其它工具名）:',
    ...lines,
    '',
    '调用格式: {"tool":"工具名","params":{...}}，params 必须是有效 JSON 对象。',
    platform === 'win32'
      ? '命令在本机 shell 中执行。当前是 Windows，请使用 PowerShell 语法（如 Get-ChildItem、Select-String、Measure-Object），不要使用 ls、find、grep、wc 等 Unix 命令。'
      : '命令在本机 shell 中执行，请使用与该 shell 匹配的命令语法。'
  ].join('\n');
}

module.exports = { DEFAULT_AGENT_INSTRUCTIONS, buildToolManifest };
