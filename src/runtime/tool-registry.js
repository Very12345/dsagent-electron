'use strict';

const MANIFESTS = [
  ['read_file', '读取文件', 'read', 'filesystem'], ['list_directory', '列出目录', 'read', 'filesystem'],
  ['info', '文件信息', 'read', 'filesystem'], ['exists', '检查路径', 'read', 'filesystem'],
  ['rg', '搜索文本', 'read', 'search'], ['glob', '匹配文件', 'read', 'search'],
  ['find_symbols', '查找符号', 'read', 'search'], ['find_references', '查找引用', 'read', 'search'],
  ['apply_patch', '应用补丁', 'workspace_write', 'filesystem'], ['write_file', '写入文件', 'workspace_write', 'filesystem'],
  ['copy_path', '复制路径', 'workspace_write', 'filesystem'], ['move_path', '移动路径', 'workspace_write', 'filesystem'],
  ['delete_path', '删除路径', 'delete', 'filesystem'], ['mkdir', '创建目录', 'workspace_write', 'filesystem'],
  ['exec_command', '执行命令', 'command', 'process'], ['start_process', '启动持续进程', 'command', 'process'], ['write_stdin', '写入进程', 'command', 'process'],
  ['wait_process', '等待进程', 'read', 'process'], ['terminate_process', '终止进程', 'command', 'process'],
  ['git_status', 'Git 状态', 'read', 'git'], ['git_diff', 'Git 差异', 'read', 'git'], ['git_log', 'Git 日志', 'read', 'git'],
  ['git_branch', 'Git 分支', 'git_write', 'git'], ['git_worktree', 'Git Worktree', 'git_write', 'git'],
  ['git_stage', 'Git 暂存', 'git_write', 'git'], ['git_commit', 'Git 提交', 'git_write', 'git'],
  ['web_search', '联网搜索', 'network', 'web'], ['browser_open', '打开网页', 'network', 'web'],
  ['browser_screenshot', '网页截图', 'network', 'web'], ['view_image', '查看图片', 'read', 'media'],
  ['memory_read', '读取记忆', 'read', 'memory'], ['memory_append', '追加记忆', 'workspace_write', 'memory'],
  ['use_skill', '使用技能', 'workspace_write', 'extension'], ['mcp', 'MCP 工具', 'network', 'mcp'],
  ['mcp_list_tools', '列出 MCP 工具', 'read', 'mcp'], ['mcp_list_resources', '列出 MCP 资源', 'read', 'mcp'],
  ['mcp_read_resource', '读取 MCP 资源', 'network', 'mcp'], ['mcp_get_prompt', '读取 MCP Prompt', 'network', 'mcp'],
  ['plan', '更新计划', 'workspace_write', 'agent'], ['interval', '周期任务', 'workspace_write', 'agent'], ['request_user_input', '请求用户输入', 'ask', 'agent'],
  ['subagent', '子代理', 'workspace_write', 'agent'], ['agent_cluster', '代理集群', 'workspace_write', 'agent']
].map(([id, label, risk, category]) => ({
  id, label, risk, category, source: 'runtime', enabled: true,
  input_schema: { type: 'object', additionalProperties: true }
}));

class ToolRegistry {
  constructor(options) { this.config = options && options.config; this.manifests = new Map(MANIFESTS.map((item) => [item.id, item])); }
  list(projectId) {
    const settings = this.config ? this.config.getSettings(projectId) : { tools: {} };
    return Array.from(this.manifests.values()).map((item) => Object.assign({}, item, {
      policy: item.risk === 'read' ? 'allow' : settings.tools && settings.tools[item.risk] || 'ask'
    }));
  }
  get(name, projectId) { return this.list(projectId).find((item) => item.id === name) || null; }
  aliases(name) {
    return ({ read: 'read_file', list: 'list_directory', grep: 'rg', exec: 'exec_command', bash: 'exec_command', save: 'write_file', edit: 'apply_patch', edit_file: 'apply_patch' })[name] || name;
  }
}

module.exports = { ToolRegistry, TOOL_MANIFESTS: MANIFESTS };
