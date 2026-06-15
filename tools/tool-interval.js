// local-interval - 循环监控执行
;(function() {
    if (window.__dsagent_tools && window.__dsagent_tools._interval_registered) return;

    window.__dsagent_tools.register({
        name: 'local-interval',
        scope: '定时循环执行命令，持续监控系统状态或文件变化',
        description: '每 N 毫秒执行一次指定的命令，每次结果自动发回对话。\n循环会持续运行直到收到 local-break 指令或 AI 回复中包含 "local-break"。\n监控期间会占用对话，不建议在需要其他操作的场景使用。',
        params: [
            { name: 'interval', type: '数字', default: '5000（5秒）', required: false, description: '执行间隔（毫秒），如 interval=10000' }
        ],
        usage: 'interval=10000\necho "checking..."',
        notes: 'interval 参数必须在第 1 行。使用 local-break 停止循环。长时间运行可能导致上下文过大。',
        handler: async function(content) {
            if (typeof window.__dsagent_execInterval === 'function') {
                return await window.__dsagent_execInterval(content);
            }
            throw new Error('execInterval not initialized');
        }
    });
    window.__dsagent_tools._interval_registered = true;
})();