// break - 停止后台定时任务
;(function() {
    if (window.__dsagent_tools && window.__dsagent_tools._break_registered) return;

    window.__dsagent_tools.register({
        name: 'break',
        scope: '停止正在运行的后台定时任务',
        description: '停止指定的后台定时任务。\n\n'
            + '- 无参数：停止正在执行的循环任务（向后兼容）\n'
            + '- `taskName=任务名`：停止指定名称的后台定时任务\n\n'
            + '使用 `interval-list` 查看所有活跃任务。',
        params: [
            { name: 'taskName', type: '字符串', default: '—', required: false, description: '要停止的任务名称' }
        ],
        usage: '<tool:break>{"taskName": "监控CPU"}</tool:break>\n\n// 停止所有任务\n<tool:break>{"taskName": "*"}</tool:break>',
        notes: '指定 taskName 停止特定任务，不指定时向后兼容旧版循环。',
        handler: async function(params, body) {
            var makeResult = window.__dsagent_tools.makeResult;
            var taskName = params && params.taskName;

            if (taskName === '*') {
                try {
                    await window.electronAPI.intervalStopAllForce();
                    return makeResult(true, '已停止所有后台定时任务');
                } catch(e) {
                    return makeResult(true, '(no interval system)');
                }
            }

            if (taskName) {
                try {
                    var result = await window.electronAPI.intervalStop(taskName);
                    return makeResult(true, (result && result.result) || '已停止');
                } catch(e) {
                    return makeResult(true, '(no interval system)');
                }
            }

            // 向后兼容：停止旧版循环
            if (typeof window.__dsagent_breakInterval === 'function') {
                window.__dsagent_breakInterval();
                return makeResult(true, '(Interval stopped)');
            }
            return makeResult(true, '(ignored)');
        }
    });
    window.__dsagent_tools._break_registered = true;
})();