// local-term - 终端管理（创建、查看输出、停止）
;(function() {
    if (window.__dsagent_tools && window.__dsagent_tools._term_registered) return;

    window.__dsagent_tools.register({
        name: 'local-term',
        scope: '管理持久化终端（查看输出、停止终端、列出终端）',
        description: '管理通过 local-exec 创建的持久化终端。可以查看终端输出、停止终端、清空输出等。',
        params: [
            { name: 'action', type: '字符串', default: '—', required: true, description: '操作类型：output / list / clear / stop / create' },
            { name: 'name', type: '字符串', default: '—', required: false, description: '终端名称' },
            { name: 'lines', type: '数字', default: '50', required: false, description: '返回的行数（action=output 时有效）' }
        ],
        usage: '{"tool": "term", "params": {"action": "list"}}\n\n{"tool": "term", "params": {"action": "output", "name": "my-server", "lines": 100}}',
        notes: '终端是持久化 cmd.exe 进程。使用完毕后请通过 action=stop 清理。',
        handler: async function(params, body) {
            var makeResult = window.__dsagent_tools.makeResult;
            var action = (params.action || '').toLowerCase();
            var name = params.name || '';
            var lines = parseInt(params.lines) || 50;

            // Backward compat: parse from body
            if (!action && body) {
                var kv = (typeof window.__dsagent_parseKeyValuePairs === 'function')
                    ? window.__dsagent_parseKeyValuePairs(body)
                    : {};
                action = (kv.action || '').toLowerCase();
                name = name || kv.name || '';
                lines = parseInt(kv.lines) || 50;
            }

            if (action === 'list') {
                var res = await window.electronAPI.terminalList();
                if (!res.success) return makeResult(false, null, res.error);
                var list = res.terminals || [];
                if (list.length === 0) return makeResult(true, '(暂无活跃终端)');
                var parts = ['📟 活跃终端：\n'];
                list.forEach(function(t, i) {
                    parts.push((i + 1) + '. `' + t.name + '` — ' + (t.running ? '✅ 运行中' : '⏹ 已停止')
                        + ' | 输出: ' + t.stdoutLen + ' 字符'
                        + ' | 创建: ' + new Date(t.createdAt).toLocaleTimeString());
                });
                return makeResult(true, parts.join('\n'));
            }

            if (action === 'output') {
                if (!name) return makeResult(false, null, '请指定终端名称 name');
                var res = await window.electronAPI.terminalOutput(name, lines);
                if (!res.success) return makeResult(false, null, res.error);
                var out = res.output || '';
                if (!out.trim()) return makeResult(true, '终端 `' + name + '`：输出为空');
                var lineCount = out.split('\n').length;
                var preview = out.length > 3000 ? out.substring(0, 3000) + '\n\n...（输出过长，截断显示前 3000 字符）' : out;
                return makeResult(true, '📟 终端 `' + name + '` 输出（' + lineCount + ' 行）：\n\n' + preview);
            }

            if (action === 'clear') {
                if (!name) return makeResult(false, null, '请指定终端名称 name');
                var res = await window.electronAPI.terminalClear(name);
                if (!res.success) return makeResult(false, null, res.error);
                return makeResult(true, '✅ 已清空终端 `' + name + '` 的输出缓存');
            }

            if (action === 'stop') {
                if (!name) return makeResult(false, null, '请指定终端名称 name');
                await window.electronAPI.terminalKill(name);
                return makeResult(true, '✅ 已停止终端 `' + name + '`');
            }

            if (action === 'create') {
                if (!name) return makeResult(false, null, '请指定终端名称 name');
                var res = await window.electronAPI.terminalCreate(name, null);
                if (!res.success) return makeResult(false, null, res.error);
                return makeResult(true, '✅ 已创建终端 `' + res.name + '`');
            }

            return makeResult(false, null, '未知操作: ' + action + '。可用操作: output / list / clear / stop / create');
        }
    });
    window.__dsagent_tools._term_registered = true;
})();