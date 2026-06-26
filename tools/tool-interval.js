// interval - 后台定时任务管理
;(function() {
    if (window.__dsagent_tools && window.__dsagent_tools._interval_registered) return;

    // ==================== 创建定时任务 ====================
    window.__dsagent_tools.register({
        name: 'interval',
        scope: '创建后台定时任务，定时执行命令或发送固定消息',
        description: '创建后台定时任务，不会阻塞对话。支持两种模式：\n\n'
            + '- **command 模式**（默认）：每 N 毫秒执行一次命令，结果会注入到 AI 提示词中\n'
            + '- **trigger 模式**：每 N 毫秒向 AI 发送固定消息，用于定时提醒\n\n'
            + '创建后返回成功，对话可继续正常使用。定时消息会标注 `【定时信息】`。\n\n'
            + '停止任务：`{"tool": "break", "params": {"taskName": "任务名"}}`',
        params: [
            { name: 'taskName', type: '字符串', default: '—', required: true, description: '任务名称（创建和停止时使用）' },
            { name: 'interval', type: '数字', default: '5000', required: false, description: '执行间隔（毫秒）' },
            { name: 'mode', type: '字符串', default: 'command', required: false, description: "任务模式：'command'（执行命令）或 'trigger'（定时发送消息）" },
            { name: 'message', type: '字符串', default: '—', required: false, description: 'trigger 模式下定时发送的消息内容' },
            { name: 'command', type: '字符串', default: '—', required: false, description: 'command 模式下执行的命令（放在 body 中）' }
        ],
        usage: '<tool:interval>{"taskName": "监控CPU", "interval": 10000, "mode": "command", "body": "wmic cpu get loadpercentage"}</tool:interval>\n\n// trigger 模式：每 30 秒发送提醒\n<tool:interval>{"taskName": "定时提醒", "interval": 30000, "mode": "trigger", "message": "记得检查服务器状态"}</tool:interval>',
        notes: '使用 taskName 创建和停止任务。不会阻塞对话。停止用 break 工具。',
        handler: async function(params, body) {
            var makeResult = window.__dsagent_tools.makeResult;
            
            var taskName = params.taskName || '';
            var intervalMs = parseInt(params.interval) || 5000;
            var mode = params.mode || 'command';
            var message = params.message || '';
            var command = params.command || body || '';

            if (!taskName) return makeResult(false, null, '缺少 taskName 参数（任务名称）');
            if (mode !== 'command' && mode !== 'trigger') return makeResult(false, null, "mode 必须是 'command' 或 'trigger'");
            if (mode === 'command' && !command) return makeResult(false, null, 'command 模式需要提供命令（body 或 command 参数）');
            if (mode === 'trigger' && !message) return makeResult(false, null, 'trigger 模式需要提供 message 参数');

            try {
                var result = await window.electronAPI.intervalCreate({
                    taskName: taskName,
                    interval: intervalMs,
                    mode: mode,
                    message: message,
                    command: command
                });
                if (result && result.success) {
                    return makeResult(true, result.result || '✅ 已创建');
                }
                return makeResult(false, null, (result && result.error) || '创建失败');
            } catch(e) {
                return makeResult(false, null, 'IPC 错误: ' + e.message);
            }
        }
    });

    // ==================== 列出活跃定时任务 ====================
    window.__dsagent_tools.register({
        name: 'interval-list',
        scope: '列出所有活跃的后台定时任务',
        description: '查看当前所有正在运行的后台定时任务，包括任务名称、模式、间隔等信息。',
        params: [],
        usage: '<tool:interval-list></tool:interval-list>',
        notes: '只返回活跃任务列表。',
        handler: async function(params, body) {
            var makeResult = window.__dsagent_tools.makeResult;
            try {
                var result = await window.electronAPI.intervalList();
                if (!result || !result.success) return makeResult(false, null, '获取失败');
                var tasks = result.tasks || [];
                if (tasks.length === 0) return makeResult(true, '当前无活跃后台定时任务');
                var lines = ['## 活跃后台定时任务 (' + tasks.length + ' 个)\n'];
                tasks.forEach(function(t) {
                    lines.push('- **' + t.taskName + '** [' + t.mode + '] 每 ' + (t.interval/1000).toFixed(1) + ' 秒');
                });
                return makeResult(true, lines.join('\n'));
            } catch(e) {
                return makeResult(false, null, 'IPC 错误: ' + e.message);
            }
        }
    });

    window.__dsagent_tools._interval_registered = true;
})();