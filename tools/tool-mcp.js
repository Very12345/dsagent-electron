// mcp - 调用 MCP 服务器工具
;(function() {
    if (window.__dsagent_tools && window.__dsagent_tools._mcp_registered) return;

    window.__dsagent_tools.register({
        name: 'mcp',
        scope: '调用 MCP (Model Context Protocol) 服务器提供的工具',
        description: '调用通过 MCP 协议连接的外部工具。\n\n参数说明：\n- `server`: MCP 服务器名称（必填）\n- `tool`: 工具名称（必填）\n- 其他参数：工具所需的参数\n\n可用 `mcp-list` 查看所有已连接的 MCP 服务器和工具。',
        params: [
            { name: 'server', type: '字符串', default: '—', required: true, description: 'MCP 服务器名称' },
            { name: 'tool', type: '字符串', default: '—', required: true, description: '工具名称' }
        ],
        usage: '<tool:mcp>{"server": "adk-docs-mcp", "tool": "fetch_docs", "query": "如何创建 agent"}</tool:mcp>',
        notes: 'MCP 工具由外部进程提供，超时时间 30 秒。请先使用 mcp-list 查看可用工具。',
        handler: async function(params, body) {
            var makeResult = window.__dsagent_tools.makeResult;
            var server = params.server || '';
            var tool = params.tool || '';

            // Backward compat: parse from body
            if ((!server || !tool) && body) {
                var trimmed = body.trim();
                try {
                    var bp = JSON.parse(trimmed);
                    server = server || bp.server || '';
                    tool = tool || bp.tool || '';
                } catch(e) {
                    var kvRegex = /(\w+)\s*=\s*(?:"([^"]*)"|'([^']*)'|(\S+?))(?:\s|$)/g;
                    var match;
                    while ((match = kvRegex.exec(trimmed)) !== null) {
                        var val = match[2] || match[3] || match[4];
                        if (match[1] === 'server' && !server) server = val;
                        else if (match[1] === 'tool' && !tool) tool = val;
                    }
                    if (!server && !tool) {
                        var lines = trimmed.split('\n');
                        if (lines.length >= 2) {
                            server = server || lines[0].trim();
                            tool = tool || lines[1].trim();
                        }
                    }
                }
            }

            if (!server) return makeResult(false, null, '请指定 MCP 服务器名称（server）');
            if (!tool) return makeResult(false, null, '请指定工具名称（tool）');

            var toolArgs = {};
            for (var key in params) {
                if (key !== 'server' && key !== 'tool') {
                    toolArgs[key] = params[key];
                }
            }

            try {
                var res = await window.electronAPI.mcpCallTool(server, tool, toolArgs);
                if (res.success) {
                    var result = res.result;
                    if (result && result.content && Array.isArray(result.content)) {
                        result = result.content.map(function(c) {
                            if (c.type === 'text') return c.text;
                            if (c.type === 'resource') return '[Resource: ' + (c.resource && c.resource.uri || 'unknown') + ']';
                            return JSON.stringify(c);
                        }).join('\n');
                    } else if (result && typeof result === 'object') {
                        result = JSON.stringify(result, null, 2);
                    }
                    return makeResult(true, result || '(空结果)');
                }
                return makeResult(false, null, res.error || 'MCP 工具调用失败');
            } catch (e) {
                return makeResult(false, null, e.message || 'MCP 调用异常');
            }
        }
    });

    // mcp-list — 列出 MCP 服务器和工具（支持多级获取）
    window.__dsagent_tools.register({
        name: 'mcp-list',
        scope: '列出 MCP 服务器和工具，支持按服务器获取',
        description: '查看当前通过 MCP 协议连接的所有服务器及其工具列表。\n\n'
            + '### 多级获取\n\n'
            + '1. **无参数** — 返回所有 MCP 服务器概览（名称 + 工具数）\n'
            + '2. **`server=名称`** — 返回该服务器的工具列表（名称 + 描述）\n'
            + '3. **`server=名称&detail=工具名`** — 返回单个工具的完整 schema（参数定义）\n\n'
            + '这样你可以先看有哪些服务器，再看某个服务器的工具，最后查看某个工具的详细参数。',
        params: [
            { name: 'server', type: '字符串', default: '—', required: false, description: 'MCP 服务器名称。不填则返回所有服务器概览' },
            { name: 'detail', type: '字符串', default: '—', required: false, description: '工具名称。需配合 server 使用，返回该工具的完整参数 schema' }
        ],
        usage: '<tool:mcp-list></tool:mcp-list>\n\n<tool:mcp-list>{"server": "chrome-devtools"}</tool:mcp-list>\n\n<tool:mcp-list>{"server": "chrome-devtools", "detail": "navigate_page"}</tool:mcp-list>',
        notes: '仅返回已缓存的工具列表，不会主动连接。如果列表为空，请使用 mcp-init 初始化连接。',
        handler: async function(params, body) {
            var makeResult = window.__dsagent_tools.makeResult;
            var server = params.server || '';
            var detail = params.detail || '';

            // Backward compat: parse from body
            if ((!server || !detail) && body) {
                var kvRegex = /(\w+)\s*=\s*(?:"([^"]*)"|'([^']*)'|(\S+?))(?:\s|$)/g;
                var match;
                while ((match = kvRegex.exec(body.trim())) !== null) {
                    var val = match[2] || match[3] || match[4];
                    if (match[1] === 'server' && !server) server = val;
                    else if (match[1] === 'detail' && !detail) detail = val;
                }
            }

            try {
                var res = await window.electronAPI.mcpGetTools();
                if (!res.success || !res.tools || res.tools.length === 0) {
                    return makeResult(true, '当前没有已连接的 MCP 服务器。使用 `mcp-init` 初始化连接。');
                }

                // 获取工具启用状态
                var statesRes = await window.electronAPI.mcpGetToolStates();
                var states = (statesRes && statesRes.states) || {};

                var byServer = {};
                res.tools.forEach(function(t) {
                    var s = t._mcpServer || 'unknown';
                    if (!byServer[s]) byServer[s] = [];
                    byServer[s].push(t);
                });

                // Level 3: 获取单个工具的详细 schema
                if (server && detail) {
                    var serverTools = byServer[server];
                    if (!serverTools) return makeResult(false, null, '未找到 MCP 服务器: ' + server);
                    var tool = null;
                    for (var i = 0; i < serverTools.length; i++) {
                        if (serverTools[i].name === detail) { tool = serverTools[i]; break; }
                    }
                    if (!tool) return makeResult(false, null, '未找到工具: ' + detail + ' (在服务器 ' + server + ' 中)');

                    var result = '## 工具详情: ' + server + ' / ' + detail + '\n\n';
                    result += '**描述**: ' + (tool.description || '(无)') + '\n\n';
                    if (tool.inputSchema) {
                        result += '**参数 Schema**:\n\n```json\n' + JSON.stringify(tool.inputSchema, null, 2) + '\n```\n\n';
                    } else {
                        result += '**参数 Schema**: (无)\n\n';
                    }
                    result += '> 使用 `mcp` 调用：`{"tool": "mcp", "params": {"server": "' + server + '", "tool": "' + detail + '", ...其他参数}}`';
                    return makeResult(true, result);
                }

                // Level 2: 获取某个服务器的工具列表
                if (server) {
                    var serverTools2 = byServer[server];
                    if (!serverTools2) return makeResult(false, null, '未找到 MCP 服务器: ' + server + '\n\n可用服务器: ' + Object.keys(byServer).join(', '));

                    var enabledCount2 = serverTools2.filter(function(t) { return states[server + '/' + t.name] !== false; }).length;
                    var result2 = '## ' + server + ' (' + enabledCount2 + '/' + serverTools2.length + ' 已启用)\n\n';
                    serverTools2.forEach(function(t) {
                        var isDisabled = states[server + '/' + t.name] === false;
                        result2 += '- **`' + t.name + '`**' + (isDisabled ? ' ~~(已禁用)~~' : '');
                        if (t.description) result2 += ': ' + t.description;
                        result2 += '\n';
                    });
                    result2 += '\n> 使用 `mcp-list` 的 `detail` 参数查看某个工具的完整参数：\n';
                    result2 += '> `{"tool": "mcp-list", "params": {"server": "' + server + '", "detail": "工具名"}}`';
                    return makeResult(true, result2);
                }

                // Level 1: 返回所有服务器概览
                var result1 = '## MCP 服务器概览\n\n';
                for (var s in byServer) {
                    var en = byServer[s].filter(function(t) { return states[s + '/' + t.name] !== false; }).length;
                    result1 += '- **' + s + '**: ' + en + '/' + byServer[s].length + ' 个工具已启用\n';
                }
                result1 += '\n> 使用 `mcp-list` 的 `server` 参数查看某个服务器的工具列表：\n';
                result1 += '> `{"tool": "mcp-list", "params": {"server": "服务器名"}}`';
                return makeResult(true, result1);
            } catch (e) {
                return makeResult(false, null, e.message || '获取 MCP 工具列表失败');
            }
        }
    });

    // mcp-init — 显式初始化 MCP 连接
    window.__dsagent_tools.register({
        name: 'mcp-init',
        scope: '初始化/重新连接所有 MCP 服务器',
        description: '强制重新加载所有配置的 MCP 服务器并获取工具列表。',
        params: [],
        usage: '<tool:mcp-init></tool:mcp-init>',
        notes: '通常在 mcp-list 返回空时使用。',
        handler: async function(params, body) {
            var makeResult = window.__dsagent_tools.makeResult;
            try {
                var initRes = await window.electronAPI.mcpInit(true);
                if (initRes.success && initRes.tools && initRes.tools.length > 0) {
                    var result = '## MCP 初始化成功\n\n';
                    var byServer = {};
                    initRes.tools.forEach(function(t) {
                        var s = t._mcpServer || 'unknown';
                        if (!byServer[s]) byServer[s] = [];
                        byServer[s].push(t);
                    });
                    for (var server in byServer) {
                        result += '- **' + server + '**: ' + byServer[server].length + ' 个工具\n';
                    }
                    result += '\n共 ' + initRes.tools.length + ' 个工具。';
                    return makeResult(true, result);
                }
                return makeResult(true, 'MCP 初始化完成，但没有发现工具。请检查 MCP 服务器配置。');
            } catch (e) {
                return makeResult(false, null, e.message || 'MCP 初始化失败');
            }
        }
    });

    window.__dsagent_tools._mcp_registered = true;
})();