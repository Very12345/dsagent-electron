// local-break - 停止 local-interval 循环
;(function() {
    if (window.__dsagent_tools && window.__dsagent_tools._break_registered) return;

    window.__dsagent_tools.register({
        name: 'local-break',
        scope: '停止正在运行的 local-interval 循环监控',
        description: '停止当前正在执行的 local-interval 循环。直接发送此代码块即可，无需内容。',
        params: [],
        usage: '',
        notes: '不需要任何参数和内容，发送空代码块即可。相当于强制终止循环。',
        handler: async function() {
            if (typeof window.__dsagent_breakInterval === 'function') {
                window.__dsagent_breakInterval();
                return '(Interval stopped)';
            }
            return '(ignored)';
        }
    });
    window.__dsagent_tools._break_registered = true;
})();