// exec / cmd - 本地命令执行
;(function() {
    if (window.__dsagent_tools && window.__dsagent_tools._exec_registered) return;

    window.__dsagent_tools.register({
        name: ['exec', 'cmd'],
        scope: '执行系统命令、运行脚本、启动程序',
        description: '在用户电脑上执行系统命令（shell/cmd）。Windows 下使用 cmd.exe，输出会自动处理中文编码。支持超时设置、管理员权限运行、多终端持久化执行。\n\n'
            + '### 多终端（terminal）使用说明\n\n'
            + '通过 `terminal=名称` 参数可以创建并使用持久化终端（类似 VS Code 的集成终端）。\n'
            + '终端是独立的 cmd.exe 进程，在后台持续运行，适合：\n'
            + '- 启动 Web 服务器（`python app.py`、`npm run dev`）\n'
            + '- 运行长时间任务（`ffmpeg ...`、`wget ...`）\n'
            + '- 并行执行多个独立任务\n\n'
            + '**重要：对于服务器类命令，核心是"启动成功"而非即时输出，因此请使用 `mode=async`：**\n'
            + '```\nterminal=web-server\nmode=async\npython app.py\n```\n'
            + '然后通过 `term` 工具查看启动日志（`{"tool": "term", "params": {"action": "output", "name": "web-server", "lines": 20}}`）。\n'
            + '确认服务器正常运行后即可继续其他工作，服务器在后台保持运行。\n\n'
            + '**终端生命周期：**\n'
            + '- 使用 `terminal=名称` 时，如果终端不存在会自动创建\n'
            + '- 终端不会超时结束，会一直在后台运行\n'
            + '- 使用 `term` 工具停止（`{"tool": "term", "params": {"action": "stop", "name": "xxx"}}`）并清理终端\n'
            + '- 使用 `term` 工具查看所有活跃终端（`{"tool": "term", "params": {"action": "list"}}`）\n\n'
            + '详细终端管理操作请参考 `term` 工具文档。',
        params: [
            { name: 'timeout', type: '数字', default: '30000', required: false, description: '命令超时时间（毫秒），如 60000' },
            { name: 'runas', type: '布尔', default: 'false', required: false, description: '以管理员身份运行' },
            { name: 'terminal', type: '字符串', default: '—', required: false, description: '指定持久化终端名称' },
            { name: 'mode', type: '字符串', default: 'sync', required: false, description: 'async=不等待结果直接返回，sync=等待结果' }
        ],
        usage: '<tool:exec>{"timeout": 60000, "body": "echo Hello World"}</tool:exec>\n\n// Terminal mode\n<tool:exec>{"terminal": "web-server", "mode": "async", "body": "python app.py"}</tool:exec>\n\n// Admin mode\n<tool:exec>{"runas": true, "body": "netstat -ano"}</tool:exec>',
        notes: '命令放在 body 中。危险命令需要用户确认。terminal 模式下创建的是持久化 cmd 进程。',
        handler: async function(params, body) {
            var makeResult = window.__dsagent_tools.makeResult;
            var actualCmd = params.command || body || '';
            var timeoutMs = params.timeout;
            var isAdmin = params.runas === true;
            var terminalName = params.terminal || null;
            var asyncMode = params.mode === 'async';

            // Backward compat: if params is empty, parse from body string (old format)
            if (!actualCmd && body) {
                var lines = body.split('\n');
                var parsedLines = [];
                for (var li = 0; li < lines.length; li++) {
                    var line = lines[li].trim();
                    var kvMatch = line.match(/^(\w+)\s*=\s*(.+)$/);
                    if (kvMatch) {
                        var key = kvMatch[1].toLowerCase();
                        var val = kvMatch[2].trim();
                        if (key === 'timeout' && !timeoutMs) {
                            timeoutMs = parseInt(val, 10);
                            if (isNaN(timeoutMs) || timeoutMs <= 0) timeoutMs = undefined;
                            continue;
                        }
                        if (key === 'runas' && val.toLowerCase() === 'admin') {
                            isAdmin = true;
                            continue;
                        }
                        if (key === 'terminal' && !terminalName) {
                            terminalName = val;
                            continue;
                        }
                        if (key === 'mode' && val.toLowerCase() === 'async') {
                            asyncMode = true;
                            continue;
                        }
                    }
                    parsedLines.push(lines[li]);
                }
                actualCmd = parsedLines.join('\n').trim();
            }

            if (!actualCmd) return makeResult(false, null, 'Missing command');

            if (!(await window.__dsagent_confirmCommand('exec', actualCmd))) return makeResult(false, null, 'Cancelled by user');

            // === 终端模式 ===
            if (terminalName || asyncMode) {
                var termName = terminalName || ('async_' + Date.now());
                var termList = await window.electronAPI.terminalList();
                var exists = (termList.terminals || []).some(function(t) { return t.name === termName; });
                if (!exists) {
                    await window.electronAPI.terminalCreate(termName, null);
                }
                await window.electronAPI.terminalWrite(termName, actualCmd);
                if (asyncMode) {
                    return makeResult(true, '命令已发送到终端 `' + termName + '`（异步模式）。使用 term action=output name=' + termName + ' 查看输出。');
                }
                await new Promise(function(r) { setTimeout(r, 3000); });
                var out = await window.electronAPI.terminalOutput(termName, 50);
                return makeResult(true, '终端 `' + termName + '` 输出（最近 50 行）：\n\n' + (out || '(空)'));
            }

            // === 普通模式 ===
            var res;
            if (isAdmin) {
                res = await window.electronAPI.agentExecAdmin(actualCmd);
            } else {
                res = await window.electronAPI.agentExec(actualCmd, timeoutMs);
            }
            if (res.timedOut) {
                var partialParts = [];
                if (res.stdout) partialParts.push(res.stdout);
                if (res.stderr) partialParts.push('[stderr] ' + res.stderr);
                var partialOut = partialParts.join('\n').trim();
                return makeResult(true, partialOut || '(无输出)', '执行超时');
            }
            if (!res.success) {
                var errParts = [];
                if (res.stdout) errParts.push(res.stdout);
                if (res.stderr) errParts.push('[stderr] ' + res.stderr);
                if (res.error) errParts.push('[error] ' + res.error);
                return makeResult(false, null, errParts.join('\n').trim() || res.error || 'Execution failed');
            }
            var parts = [];
            if (res.stdout) parts.push(res.stdout);
            if (res.stderr) parts.push('[stderr] ' + res.stderr);
            return makeResult(true, parts.join('\n').trim() || '(Executed, no output)');
        }
    });
    window.__dsagent_tools._exec_registered = true;
})();