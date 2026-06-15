// local-term - 终端管理（创建、查看输出、停止）
;(function() {
    if (window.__dsagent_tools && window.__dsagent_tools._term_registered) return;

    window.__dsagent_tools.register({
        name: 'local-term',
        scope: '管理持久化终端（查看输出、停止终端、列出终端）',
        description: '管理通过 `local-exec terminal=xxx` 创建的持久化终端。可以查看终端输出、停止终端、清空输出等。\n\n'
            + '子命令：\n'
            + '- `action=output name=xxx [lines=50]` — 查看终端最近的输出\n'
            + '- `action=list` — 列出所有活跃终端\n'
            + '- `action=clear name=xxx` — 清空终端缓存\n'
            + '- `action=stop name=xxx` — 停止并删除终端\n'
            + '- `action=create name=xxx` — 手动创建新终端',
        params: [
            { name: 'action', type: '字符串', default: '—', required: true, description: '操作类型：output / list / clear / stop / create' },
            { name: 'name', type: '字符串', default: '—', required: false, description: '终端名称（output/clear/stop/create 时需要）' },
            { name: 'lines', type: '数字', default: '50', required: false, description: '返回的行数（action=output 时有效）' }
        ],
        usage: '# 查看终端输出\nlocal-term\naction=output\nname=my-server\nlines=100\n\n# 列出所有终端\nlocal-term\naction=list\n\n# 停止终端\nlocal-term\naction=stop\nname=my-server\n\n# 清空终端缓存\nlocal-term\naction=clear\nname=my-server\n\n# 创建新终端\nlocal-term\naction=create\nname=my-server',
        notes: '终端是持久化 cmd.exe 进程，不会自动结束。使用完毕后请通过 action=stop 清理，避免残留进程。',
        handler: async function(content) {
            var kv = window.__dsagent_parseKeyValuePairs(content);
            var action = (kv.action || '').toLowerCase();
            var name = kv.name || '';
            var lines = parseInt(kv.lines) || 50;

            if (action === 'list') {
                var res = await window.electronAPI.terminalList();
                if (!res.success) throw new Error(res.error);
                var list = res.terminals || [];
                if (list.length === 0) return '(暂无活跃终端)';
                var parts = ['📟 活跃终端：\n'];
                list.forEach(function(t, i) {
                    parts.push((i + 1) + '. `' + t.name + '` — ' + (t.running ? '✅ 运行中' : '⏹ 已停止')
                        + ' | 输出: ' + t.stdoutLen + ' 字符'
                        + ' | 创建: ' + new Date(t.createdAt).toLocaleTimeString());
                });
                return parts.join('\n');
            }

            if (action === 'output') {
                if (!name) throw new Error('请指定终端名称 name=xxx');
                var res = await window.electronAPI.terminalOutput(name, lines);
                if (!res.success) throw new Error(res.error);
                var out = res.output || '';
                if (!out.trim()) return '📟 终端 `' + name + '`：输出为空';
                var lineCount = out.split('\n').length;
                var preview = out.length > 3000 ? out.substring(0, 3000) + '\n\n...（输出过长，截断显示前 3000 字符）' : out;
                return '📟 终端 `' + name + '` 输出（' + lineCount + ' 行）：\n\n' + preview;
            }

            if (action === 'clear') {
                if (!name) throw new Error('请指定终端名称 name=xxx');
                var res = await window.electronAPI.terminalClear(name);
                if (!res.success) throw new Error(res.error);
                return '✅ 已清空终端 `' + name + '` 的输出缓存';
            }

            if (action === 'stop') {
                if (!name) throw new Error('请指定终端名称 name=xxx');
                await window.electronAPI.terminalKill(name);
                return '✅ 已停止终端 `' + name + '`';
            }

            if (action === 'create') {
                if (!name) throw new Error('请指定终端名称 name=xxx');
                var res = await window.electronAPI.terminalCreate(name, null);
                if (!res.success) throw new Error(res.error);
                return '✅ 已创建终端 `' + res.name + '`，使用以下命令执行：\n\n```local-exec\nterminal=' + res.name + '\nmode=async\n命令\n```';
            }

            throw new Error('未知操作: ' + action + '。可用操作: output / list / clear / stop / create');
        }
    });
    window.__dsagent_tools._term_registered = true;
})();