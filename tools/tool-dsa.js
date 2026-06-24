// local-dsa - 管理 MCP 服务器和技能系统
;(function() {
    if (window.__dsagent_tools && window.__dsagent_tools._dsa_registered) return;

    window.__dsagent_tools.register({
        name: 'local-dsa',
        scope: '管理 MCP 服务器和技能系统',
        description: '管理 dsagent 的 MCP 服务器和技能系统。\n\n'
            + '### MCP 管理\n\n'
            + '- `action=mcp-list`: 列出所有 MCP 服务器及工具\n'
            + '- `action=mcp-reload`: 重新加载所有 MCP 服务器\n'
            + '- `action=mcp-tool-toggle`: 启用/禁用某个 MCP 工具（需 `server` + `tool` + `enabled`）\n'
            + '- `action=mcp-tool-state`: 查看某个 MCP 工具的启用状态（需 `server` + `tool`）\n\n'
            + '### 技能管理\n\n'
            + '- `action=skill-list`: 列出所有已加载的技能\n'
            + '- `action=skill-sync`: 将技能从仓库同步到工作目录（需 `name`）\n'
            + '- `action=skill-unsync`: 取消同步，恢复为仓库链接（需 `name`）\n'
            + '- `action=skill-delete`: 删除技能（需 `name`）\n'
            + '- `action=skill-toggle`: 启用/禁用技能（需 `name` + `enabled`）\n'
            + '- `action=skill-path`: 获取技能存储路径\n'
            + '- `action=skill-path-set`: 设置技能存储路径（需 `path`）\n\n'
            + '### 注意事项\n\n'
            + '- `mcp-reload` 和 `skill-path-set` 会影响全局配置，请谨慎操作\n'
            + '- `skill-delete` 会永久删除技能文件，不可恢复\n'
            + '- `skill-sync` 会将技能复制到工作目录，占用额外磁盘空间\n'
            + '- `skill-unsync` 会删除工作目录副本，恢复为仓库链接',
        params: [
            { name: 'action', type: '字符串', default: '—', required: true, description: '操作类型，见上方说明' },
            { name: 'server', type: '字符串', default: '—', required: false, description: 'MCP 服务器名称（mcp-tool-toggle/mcp-tool-state 需要）' },
            { name: 'tool', type: '字符串', default: '—', required: false, description: 'MCP 工具名称（mcp-tool-toggle/mcp-tool-state 需要）' },
            { name: 'enabled', type: '布尔', default: 'true', required: false, description: '启用/禁用（mcp-tool-toggle/skill-toggle 需要）' },
            { name: 'name', type: '字符串', default: '—', required: false, description: '技能名称（skill-sync/unsync/delete/toggle 需要）' },
            { name: 'path', type: '字符串', default: '—', required: false, description: '技能存储路径（skill-path-set 需要）' }
        ],
        usage: '{"tool": "dsa", "params": {"action": "mcp-list"}}\n\n{"tool": "dsa", "params": {"action": "skill-list"}}\n\n{"tool": "dsa", "params": {"action": "mcp-tool-toggle", "server": "chrome-devtools", "tool": "navigate_page", "enabled": false}}\n\n{"tool": "dsa", "params": {"action": "skill-sync", "name": "my-skill"}}',
        notes: '此工具用于管理 MCP 和技能系统配置。mcp-reload 和 skill-path-set 会影响全局配置。',
        handler: async function(params, body) {
            var makeResult = window.__dsagent_tools.makeResult;
            var action = params.action || '';

            // 向后兼容：从 body 解析
            if (!action && body) {
                var lines = body.split('\n');
                for (var i = 0; i < lines.length; i++) {
                    var line = lines[i].trim();
                    var m = line.match(/^(\w+)\s*=\s*(.+)$/);
                    if (m) {
                        var key = m[1].toLowerCase();
                        var val = m[2].trim().replace(/^["']|["']$/g, '');
                        if (key === 'action' && !action) action = val;
                        else if (key === 'server' && !params.server) params.server = val;
                        else if (key === 'tool' && !params.tool) params.tool = val;
                        else if (key === 'name' && !params.name) params.name = val;
                        else if (key === 'path' && !params.path) params.path = val;
                        else if (key === 'enabled' && params.enabled === undefined) {
                            params.enabled = val === 'true' || val === '1' || val === 'yes';
                        }
                    }
                }
            }

            if (!action) return makeResult(false, null, '缺少 action 参数');

            // ==================== MCP 管理 ====================

            if (action === 'mcp-list') {
                try {
                    var toolsRes = await window.electronAPI.mcpGetTools();
                    var statesRes = await window.electronAPI.mcpGetToolStates();
                    if (!toolsRes || !toolsRes.success) return makeResult(false, null, '获取 MCP 工具失败');
                    var tools = toolsRes.tools || [];
                    var states = (statesRes && statesRes.states) || {};
                    if (tools.length === 0) return makeResult(true, '当前无已连接的 MCP 服务器');

                    // 按服务器分组
                    var byServer = {};
                    tools.forEach(function(t) {
                        var s = t._mcpServer || 'unknown';
                        if (!byServer[s]) byServer[s] = [];
                        byServer[s].push(t);
                    });

                    var lines = ['MCP 服务器列表 (' + Object.keys(byServer).length + ' 个服务器, ' + tools.length + ' 个工具):\n'];
                    for (var srv in byServer) {
                        var srvTools = byServer[srv];
                        var enabledCount = srvTools.filter(function(t) {
                            return states[srv + '/' + t.name] !== false;
                        }).length;
                        lines.push('[' + srv + '] ' + enabledCount + '/' + srvTools.length + ' 已启用:');
                        srvTools.forEach(function(t) {
                            var isEnabled = states[srv + '/' + t.name] !== false;
                            var desc = t.description || '';
                            if (desc.length > 50) desc = desc.substring(0, 47) + '...';
                            lines.push('  ' + (isEnabled ? '[x]' : '[ ]') + ' ' + t.name + (desc ? ' — ' + desc : ''));
                        });
                        lines.push('');
                    }
                    return makeResult(true, lines.join('\n'));
                } catch(e) {
                    return makeResult(false, null, 'mcp-list 失败: ' + e.message);
                }
            }

            if (action === 'mcp-reload') {
                try {
                    var res = await window.electronAPI.mcpInit(true);
                    if (res && res.success) {
                        var count = res.tools ? res.tools.length : 0;
                        return makeResult(true, 'MCP 重载完成: ' + count + ' 个工具已加载');
                    } else {
                        return makeResult(false, null, 'MCP 重载失败: ' + (res && res.error ? res.error : '未知错误'));
                    }
                } catch(e) {
                    return makeResult(false, null, 'mcp-reload 失败: ' + e.message);
                }
            }

            if (action === 'mcp-tool-toggle') {
                var server = params.server;
                var tool = params.tool;
                var enabled = params.enabled !== false;
                if (!server || !tool) return makeResult(false, null, 'mcp-tool-toggle 需要 server 和 tool 参数');
                try {
                    await window.electronAPI.mcpSetToolEnabled(server, tool, enabled);
                    return makeResult(true, 'MCP 工具 ' + server + '/' + tool + ' 已' + (enabled ? '启用' : '禁用'));
                } catch(e) {
                    return makeResult(false, null, 'mcp-tool-toggle 失败: ' + e.message);
                }
            }

            if (action === 'mcp-tool-state') {
                var sName = params.server;
                var tName = params.tool;
                if (!sName || !tName) return makeResult(false, null, 'mcp-tool-state 需要 server 和 tool 参数');
                try {
                    var stRes = await window.electronAPI.mcpGetToolStates();
                    var st = (stRes && stRes.states) || {};
                    var key = sName + '/' + tName;
                    var isEnabled = st[key] !== false;
                    return makeResult(true, sName + '/' + tName + ': ' + (isEnabled ? '已启用' : '已禁用'));
                } catch(e) {
                    return makeResult(false, null, 'mcp-tool-state 失败: ' + e.message);
                }
            }

            // ==================== 技能管理 ====================

            if (action === 'skill-list') {
                try {
                    var skillsRes = await window.electronAPI.agentSkillsLoad();
                    if (!skillsRes || !skillsRes.success) return makeResult(false, null, '获取技能列表失败');
                    var skills = skillsRes.skills || [];
                    if (skills.length === 0) return makeResult(true, '当前无已加载的技能');

                    var disabledRes = await window.electronAPI.agentSkillGetDisabled();
                    var disabled = (disabledRes && disabledRes.disabled) || [];

                    var lines = ['技能列表 (' + skills.length + ' 个):\n'];
                    skills.forEach(function(s) {
                        var isDisabled = disabled.indexOf(s.name) !== -1;
                        var isSynced = s.synced === true;
                        var status = isDisabled ? '[禁用]' : '[启用]';
                        var sync = isSynced ? '[已同步]' : '[仓库]';
                        lines.push(status + ' ' + sync + ' ' + s.name);
                        if (s.description) lines.push('  ' + s.description);
                    });
                    return makeResult(true, lines.join('\n'));
                } catch(e) {
                    return makeResult(false, null, 'skill-list 失败: ' + e.message);
                }
            }

            if (action === 'skill-sync') {
                var skillName = params.name;
                if (!skillName) return makeResult(false, null, 'skill-sync 需要 name 参数');
                try {
                    var syncRes = await window.electronAPI.agentSkillSync(skillName);
                    if (syncRes && syncRes.success) {
                        return makeResult(true, '技能 ' + skillName + ' 已同步到工作目录，可自由修改');
                    } else {
                        return makeResult(false, null, '同步失败: ' + (syncRes && syncRes.error ? syncRes.error : '未知错误'));
                    }
                } catch(e) {
                    return makeResult(false, null, 'skill-sync 失败: ' + e.message);
                }
            }

            if (action === 'skill-unsync') {
                var uName = params.name;
                if (!uName) return makeResult(false, null, 'skill-unsync 需要 name 参数');
                try {
                    var uRes = await window.electronAPI.agentSkillUnsync(uName);
                    if (uRes && uRes.success) {
                        return makeResult(true, '技能 ' + uName + ' 已取消同步，恢复为仓库版本');
                    } else {
                        return makeResult(false, null, '取消同步失败: ' + (uRes && uRes.error ? uRes.error : '未知错误'));
                    }
                } catch(e) {
                    return makeResult(false, null, 'skill-unsync 失败: ' + e.message);
                }
            }

            if (action === 'skill-delete') {
                var dName = params.name;
                if (!dName) return makeResult(false, null, 'skill-delete 需要 name 参数');
                try {
                    var dRes = await window.electronAPI.agentSkillDelete(dName);
                    if (dRes && dRes.success) {
                        return makeResult(true, '技能 ' + dName + ' 已删除');
                    } else {
                        return makeResult(false, null, '删除失败: ' + (dRes && dRes.error ? dRes.error : '未知错误'));
                    }
                } catch(e) {
                    return makeResult(false, null, 'skill-delete 失败: ' + e.message);
                }
            }

            if (action === 'skill-toggle') {
                var tName2 = params.name;
                var tEnabled = params.enabled !== false;
                if (!tName2) return makeResult(false, null, 'skill-toggle 需要 name 参数');
                try {
                    var tgRes = await window.electronAPI.agentSkillToggleDisabled(tName2);
                    if (tgRes && tgRes.success) {
                        // toggleSkillDisabled 是切换状态，返回的 disabled 表示切换后的状态
                        var nowDisabled = tgRes.disabled;
                        return makeResult(true, '技能 ' + tName2 + ' 已' + (nowDisabled ? '禁用' : '启用'));
                    } else {
                        return makeResult(false, null, '切换失败: ' + (tgRes && tgRes.error ? tgRes.error : '未知错误'));
                    }
                } catch(e) {
                    return makeResult(false, null, 'skill-toggle 失败: ' + e.message);
                }
            }

            if (action === 'skill-path') {
                try {
                    var pRes = await window.electronAPI.agentSkillsStoragePath();
                    if (pRes && pRes.success) {
                        return makeResult(true, '技能存储路径: ' + pRes.path);
                    } else {
                        return makeResult(false, null, '获取路径失败');
                    }
                } catch(e) {
                    return makeResult(false, null, 'skill-path 失败: ' + e.message);
                }
            }

            if (action === 'skill-path-set') {
                var newPath = params.path;
                if (!newPath) return makeResult(false, null, 'skill-path-set 需要 path 参数');
                try {
                    var spRes = await window.electronAPI.agentSkillsSetStoragePath(newPath);
                    if (spRes && spRes.success) {
                        return makeResult(true, '技能存储路径已设置为: ' + newPath);
                    } else {
                        return makeResult(false, null, '设置路径失败: ' + (spRes && spRes.error ? spRes.error : '未知错误'));
                    }
                } catch(e) {
                    return makeResult(false, null, 'skill-path-set 失败: ' + e.message);
                }
            }

            return makeResult(false, null, '未知 action: ' + action + '\n\n可用 action:\n'
                + 'MCP: mcp-list, mcp-reload, mcp-tool-toggle, mcp-tool-state\n'
                + 'Skill: skill-list, skill-sync, skill-unsync, skill-delete, skill-toggle, skill-path, skill-path-set');
        }
    });
    window.__dsagent_tools._dsa_registered = true;
})();
