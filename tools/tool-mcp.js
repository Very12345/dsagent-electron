// local-mcp - 调用 MCP 服务器工具
;(function() {
    if (window.__dsagent_tools && window.__dsagent_tools._mcp_registered) return;

    window.__dsagent_tools.register({
        name: 'local-mcp',
        scope: '调用 MCP (Model Context Protocol) 服务器提供的工具',
        description: '调用通过 MCP 协议连接的外部工具。\n\n'
            + '参数说明：\n'
            + '- `server`: MCP 服务器名称（必填）\n'
            + '- `tool`: 工具名称（必填）\n'
            + '- 其他参数：工具所需的参数，使用 `key=value` 格式\n\n'
            + '可用 `local-mcp-list` 查看所有已连接的 MCP 服务器和工具。',
        params: [
            { name: 'server', type: '字符串', default: '—', required: true, description: 'MCP 服务器名称' },
            { name: 'tool', type: '字符串', default: '—', required: true, description: '工具名称' }
        ],
        usage: 'server="adk-docs-mcp"\ntool="fetch_docs"\nquery="如何创建 agent"',
        notes: 'MCP 工具由外部进程提供，超时时间 30 秒。请先使用 local-mcp-list 查看可用工具。',
        handler: async function(content) {
            var params = parseMCPParams(content);
            if (!params.server) return '请指定 MCP 服务器名称（server="xxx"）';
            if (!params.tool) return '请指定工具名称（tool="xxx"）';

            var toolArgs = {};
            for (var key in params) {
                if (key !== 'server' && key !== 'tool') {
                    toolArgs[key] = params[key];
                }
            }

            try {
                var res = await window.electronAPI.mcpCallTool(params.server, params.tool, toolArgs);
                if (res.success) {
                    return formatMCPResult(res.result);
                }
                return 'MCP 工具调用失败: ' + (res.error || '未知错误');
            } catch (e) {
                return 'MCP 调用异常: ' + (e.message || '未知错误');
            }
        }
    });

    // 同时注册 local-mcp-list
    window.__dsagent_tools.register({
        name: 'local-mcp-list',
        scope: '列出所有已连接的 MCP 服务器和工具',
        description: '查看当前通过 MCP 协议连接的所有服务器及其提供的工具列表。',
        params: [],
        usage: '# 无参数，直接调用\n',
        notes: '返回所有 MCP 服务器的工具概览。',
        handler: async function() {
            try {
                var res = await window.electronAPI.mcpGetTools();
                if (res.success && res.tools && res.tools.length > 0) {
                    var result = '## MCP 工具列表\n\n';
                    var byServer = {};
                    res.tools.forEach(function(t) {
                        var s = t._mcpServer || 'unknown';
                        if (!byServer[s]) byServer[s] = [];
                        byServer[s].push(t);
                    });
                    for (var server in byServer) {
                        result += '### ' + server + ' (' + byServer[server].length + ' 个工具)\n\n';
                        byServer[server].forEach(function(t) {
                            result += '- **`' + t.name + '`**';
                            if (t.description) result += ': ' + t.description;
                            result += '\n';
                        });
                        result += '\n';
                    }
                    result += '> 使用 `local-mcp server="服务器名" tool="工具名"` 调用。';
                    return result;
                }
                return '当前没有已连接的 MCP 服务器。';
            } catch (e) {
                return '获取 MCP 工具列表失败: ' + (e.message || '未知错误');
            }
        }
    });

    function parseMCPParams(content) {
        var trimmed = content.trim();
        var kvRegex = /(\w+)\s*=\s*(?:"([^"]*)"|'([^']*)'|(\S+?))(?:\s|$)/g;
        var params = {};
        var match;
        while ((match = kvRegex.exec(trimmed)) !== null) {
            params[match[1]] = match[2] || match[3] || match[4];
        }

        // 兼容无参数格式：第一行 server，第二行 tool
        if (!params.server && !params.tool) {
            var lines = trimmed.split('\n');
            if (lines.length >= 2) {
                params.server = lines[0].trim();
                params.tool = lines[1].trim();
            }
        }
        return params;
    }

    function formatMCPResult(result) {
        if (!result) return '(空结果)';
        if (result.content && Array.isArray(result.content)) {
            return result.content.map(function(c) {
                if (c.type === 'text') return c.text;
                if (c.type === 'resource') return '[Resource: ' + (c.resource?.uri || 'unknown') + ']';
                return JSON.stringify(c);
            }).join('\n');
        }
        if (typeof result === 'string') return result;
        try {
            return JSON.stringify(result, null, 2);
        } catch (e) {
            return String(result);
        }
    }

    window.__dsagent_tools._mcp_registered = true;
})();