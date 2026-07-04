// bash - 执行系统命令（AtomCode 标准命名）
// 用法: {"command": "echo hello", "timeout": 60}
;// 注意：exec 和 cmd 作为别名保留在 tool-exec.js 中（向后兼容）
;(function() {
    if (window.__dsagent_tools && window.__dsagent_tools._bash_registered) return;

    window.__dsagent_tools.register({
        name: 'bash',
        scope: '执行系统命令（支持超时，危险命令需要确认）',
        description: '在工作目录中执行系统命令，返回合并的 stdout/stderr 和退出码。' +
            '默认超时 60 秒（最高 300 秒）。' +
            '危险命令（递归强制删除、sudo、dd、历史重写等）会标记为高风险并需要用户确认。' +
            '需要持久化终端的场景请使用 exec 的 terminal 模式。',
        params: [
            { name: 'command', type: '字符串', default: '—', required: true, description: '要执行的 shell 命令' },
            { name: 'timeout', type: '数字', default: '60', required: false, description: '超时秒数（默认 60，最高 300）' }
        ],
        usage: '{"command": "node -v"}\n\n{"command": "python script.py --input data.csv", "timeout": 120}\n\n// 需要持久化终端/管理员权限的场景，使用 exec 替代',
        notes: '命令放在 command 字段。timeout 单位为秒。危险命令需要用户确认。需要持久化终端时请使用 exec（terminal 模式）。',
        handler: async function(params, body) {
            var makeResult = window.__dsagent_tools.makeResult;
            var cmd = params.command || '';
            var timeoutSecs = parseInt(params.timeout) || 60;
            timeoutSecs = Math.min(Math.max(timeoutSecs, 1), 300);

            // 从 body 解析
            if (!cmd && body) {
                var trimmed = body.trim();
                try {
                    var bp = JSON.parse(trimmed);
                    cmd = cmd || bp.command || '';
                    timeoutSecs = Math.min(Math.max(parseInt(bp.timeout) || timeoutSecs, 1), 300);
                } catch(e) {
                    cmd = trimmed;
                }
            }

            if (!cmd) return makeResult(false, null, 'Missing command');

            // 确认危险命令
            if (!(await window.__dsagent_confirmCommand('bash', cmd))) {
                return makeResult(false, null, 'Cancelled by user');
            }

            try {
                var res = await window.electronAPI.agentExec(cmd, timeoutSecs * 1000);
                if (!res) return makeResult(false, null, 'Execution failed (no response)');
                var output = '';
                if (res.stdout) output += res.stdout;
                if (res.stderr) {
                    if (output) output += '\n';
                    output += res.stderr;
                }
                if (res.code !== undefined && res.code !== 0) {
                    output += '\n[Exit code: ' + res.code + ']';
                }
                if (!output) output = '(command produced no output)';
                return makeResult(true, output, null, { exitCode: res.code, pid: res.pid });
            } catch (e) {
                return makeResult(false, null, 'bash 错误: ' + (e.message || e));
            }
        }
    });

    window.__dsagent_tools._bash_registered = true;
})();
