// local-exec / local-cmd - 本地命令执行
;(function() {
    if (window.__dsagent_tools && window.__dsagent_tools._exec_registered) return;

    window.__dsagent_tools.register({
        name: ['local-exec', 'local-cmd'],
        scope: '执行系统命令、运行脚本、启动程序',
        description: '在用户电脑上执行系统命令（shell/cmd）。支持超时设置、管理员权限运行、多终端持久化执行。\n\n'
            + '### 多终端（terminal）使用说明\n\n'
            + '通过 `terminal=名称` 参数可以创建并使用持久化终端（类似 VS Code 的集成终端）。\n'
            + '终端是独立的 cmd.exe 进程，在后台持续运行，适合：\n'
            + '- 启动 Web 服务器（`python app.py`、`npm run dev`）\n'
            + '- 运行长时间任务（`ffmpeg ...`、`wget ...`）\n'
            + '- 并行执行多个独立任务\n\n'
            + '**重要：对于服务器类命令，核心是"启动成功"而非即时输出，因此请使用 `mode=async`：**\n'
            + '```\nterminal=web-server\nmode=async\npython app.py\n```\n'
            + '然后通过 `local-term action=output name=web-server lines=20` 查看启动日志。\n'
            + '确认服务器正常运行后即可继续其他工作，服务器在后台保持运行。\n\n'
            + '**终端生命周期：**\n'
            + '- 使用 `terminal=名称` 时，如果终端不存在会自动创建\n'
            + '- 终端不会超时结束，会一直在后台运行\n'
            + '- 使用 `local-term action=stop name=xxx` 停止并清理终端\n'
            + '- 使用 `local-term action=list` 查看所有活跃终端\n\n'
            + '详细终端管理操作请参考 `local-term` 工具文档。',
        params: [
            { name: 'timeout', type: '数字', default: '30000（30秒）', required: false, description: '命令超时时间（毫秒），如 timeout=60000' },
            { name: 'runas', type: '字符串', default: '—', required: false, description: '以管理员身份运行，设置 runas=admin' },
            { name: 'terminal', type: '字符串', default: '—', required: false, description: '指定持久化终端名称。终端会自动创建，适合后台/长时间任务。服务器类命令务必使用此参数' },
            { name: 'mode', type: '字符串', default: 'sync', required: false, description: 'async=不等待结果直接返回（terminal 模式下推荐）；sync=等待结果' }
        ],
        usage: '# 基本命令\necho "Hello World"\n\n# 带超时\ntimeout=60000\nping 8.8.8.8\n\n# 管理员权限\nrunas=admin\nnetstat -ano\n\n# 在终端中启动服务器（推荐方式）\nterminal=web-server\nmode=async\npython app.py',
        notes: '危险命令需要用户确认。terminal 模式下创建的是持久化 cmd 进程，不会超时结束。mode=async 时不返回命令结果，需通过 local-term 查看输出。对于 Web 服务器、数据库等"一直运行"的程序，务必使用 terminal + mode=async。',
        handler: async function(content) {
            var lines = content.split('\n');
            var timeoutMs;
            var isAdmin = false;
            var terminalName = null;
            var asyncMode = false;
            var paramLineCount = 0;
            var parsedLines = [];
            for (var li = 0; li < lines.length; li++) {
                var line = lines[li].trim();
                var kvMatch = line.match(/^(\w+)\s*=\s*(.+)$/);
                if (kvMatch) {
                    var key = kvMatch[1].toLowerCase();
                    var val = kvMatch[2].trim();
                    if (key === 'timeout') {
                        timeoutMs = parseInt(val, 10);
                        if (isNaN(timeoutMs) || timeoutMs <= 0) timeoutMs = undefined;
                        paramLineCount++;
                        continue;
                    }
                    if (key === 'runas' && val.toLowerCase() === 'admin') {
                        isAdmin = true;
                        paramLineCount++;
                        continue;
                    }
                    if (key === 'terminal') {
                        terminalName = val;
                        paramLineCount++;
                        continue;
                    }
                    if (key === 'mode' && val.toLowerCase() === 'async') {
                        asyncMode = true;
                        paramLineCount++;
                        continue;
                    }
                }
                parsedLines.push(lines[li]);
            }
            
            var actualCmd = parsedLines.join('\n').trim();
            if (!actualCmd) throw new Error('Missing command');

            // 使用 inject.js 的确认机制
            if (!(await window.__dsagent_confirmCommand('local-exec', actualCmd))) return '(Cancelled by user)';

            // === 终端模式（mode=async 时自动创建） ===
            if (terminalName || asyncMode) {
                var termName = terminalName || ('async_' + Date.now());
                // 自动创建终端（如果不存在）
                var termList = await window.electronAPI.terminalList();
                var exists = (termList.terminals || []).some(function(t) { return t.name === termName; });
                if (!exists) {
                    await window.electronAPI.terminalCreate(termName, null);
                }
                // 写入命令
                await window.electronAPI.terminalWrite(termName, actualCmd);
                if (asyncMode) {
                    return '✅ 命令已发送到终端 `' + termName + '`（异步模式，不等待结果）。\n使用以下命令查看输出：\n\n```local-term\naction=output\nname=' + termName + '\nlines=100\n```';
                }
                // 同步模式：等待 3 秒后返回当前输出
                await new Promise(function(r) { setTimeout(r, 3000); });
                var out = await window.electronAPI.terminalOutput(termName, 50);
                return '📟 终端 `' + termName + '` 输出（最近 50 行）：\n\n' + (out || '(空)');
            }

            // === 普通模式（一次性执行） ===
            var res;
            if (isAdmin) {
                res = await window.electronAPI.agentExecAdmin(actualCmd);
            } else {
                res = await window.electronAPI.agentExec(actualCmd, timeoutMs);
            }
            if (!res.success) throw new Error(res.error || 'Execution failed');
            var parts = [];
            if (res.stdout) parts.push(res.stdout);
            if (res.stderr) parts.push('[stderr] ' + res.stderr);
            return parts.join('\n').trim() || '(Executed, no output)';
        }
    });
    window.__dsagent_tools._exec_registered = true;
})();