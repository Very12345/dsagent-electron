// todo - 会话任务列表（AtomCode 等效工具）
// AI 管理多步骤任务的轻量追踪，无需持久化到磁盘
// 用法: {"action": "add", "content": "编写测试"}, {"action": "update", "id": 1, "status": "completed"}
;(function() {
    if (window.__dsagent_tools && window.__dsagent_tools._todo_registered) return;

    // 状态池（与 AtomCode 一致）
    var STATUS = { pending: 'pending', in_progress: 'in_progress', completed: 'completed' };
    var STATUS_ICON = { pending: '[ ]', in_progress: '[>]', completed: '[x]' };

    // 会话内的任务列表（内存状态，非持久化）
    var tasks = [];
    var nextId = 1;

    window.__dsagent_tools.register({
        name: 'todo',
        scope: '管理会话任务列表，追踪多步骤工作进度',
        description: '管理当前会话中的任务列表，支持添加、更新状态、查看进度。' +
            '任务列表保存在会话内存中，不会持久化到磁盘。' +
            'action: add=添加任务, update=更新状态(默认completed), list=查看全部。',
        params: [
            { name: 'action', type: '字符串', default: 'list', required: false, description: '操作：add / update / list' },
            { name: 'content', type: '字符串', default: '—', required: false, description: '任务描述（add 时必填）' },
            { name: 'id', type: '数字', default: '—', required: false, description: '任务 ID（update 时需要）' },
            { name: 'status', type: '字符串', default: 'completed', required: false, description: '新状态：pending / in_progress / completed' }
        ],
        usage: '{"action": "add", "content": "分析项目结构"}\n\n{"action": "update", "id": 1, "status": "in_progress"}\n\n{"action": "list"}',
        notes: '任务列表仅在当前会话有效。每个任务有唯一 ID。add 后可一次添加多个任务（后续行一行一个）。',
        handler: async function(params, body) {
            var makeResult = window.__dsagent_tools.makeResult;
            var action = params.action || 'list';
            var content = params.content || '';
            var id = parseInt(params.id);
            var status = params.status || 'completed';

            // 从 body 解析（向后兼容）
            if ((!action || action === 'list') && body && !params.action) {
                var lines = body.trim().split('\n');
                var kv = {};
                var extraLines = [];
                for (var li = 0; li < lines.length; li++) {
                    var line = lines[li].trim();
                    if (!line) continue;
                    var m = line.match(/^(\w+)\s*=\s*(?:"([^"]*)"|'([^']*)'|(\S+))\s*$/);
                    if (m) {
                        var key = m[1].toLowerCase();
                        var val = m[2] !== undefined ? m[2] : (m[3] !== undefined ? m[3] : m[4]);
                        kv[key] = val;
                    } else {
                        extraLines.push(line);
                    }
                }
                action = kv.action || 'add';
                content = content || kv.content || extraLines.join('\n');
                id = parseInt(kv.id) || id;
                status = kv.status || status;
            }

            switch (action) {
                case 'add': {
                    if (!content) return makeResult(false, null, 'add 操作需要 content 参数');
                    var newTasks = content.split('\n').filter(function(t) { return t.trim(); });
                    var added = [];
                    for (var ti = 0; ti < newTasks.length; ti++) {
                        var taskContent = newTasks[ti].trim();
                        if (!taskContent) continue;
                        // 去掉行首数字编号（如 "1. xxx"、"1) xxx"）
                        taskContent = taskContent.replace(/^\d+[\.\)]\s*/, '');
                        tasks.push({ id: nextId++, content: taskContent, status: STATUS.pending });
                        added.push(taskContent);
                    }
                    var summary = 'Added ' + added.length + ' task' + (added.length > 1 ? 's' : '') + ':\n';
                    for (var ai = 0; ai < added.length; ai++) {
                        summary += '  #' + (nextId - added.length + ai) + ' ' + added[ai] + '\n';
                    }
                    return makeResult(true, summary);
                }

                case 'update': {
                    if (!id) return makeResult(false, null, 'update 操作需要 id 参数');
                    if (STATUS[status] === undefined) {
                        return makeResult(false, null, '无效状态: ' + status + '（可选: pending / in_progress / completed）');
                    }
                    var found = false;
                    for (var ui = 0; ui < tasks.length; ui++) {
                        if (tasks[ui].id === id) {
                            tasks[ui].status = status;
                            found = true;
                            return makeResult(true, 'Task #' + id + ' [' + tasks[ui].content + '] → ' +
                                STATUS_ICON[status] + ' ' + status);
                        }
                    }
                    if (!found) return makeResult(false, null, 'Task #' + id + ' not found');
                    break;
                }

                case 'list':
                default: {
                    if (tasks.length === 0) {
                        return makeResult(true, '(暂无任务。使用 todo add 添加任务)');
                    }
                    var output = '📋 Task List (' + tasks.length + ' total):\n\n';
                    var pendingCount = 0;
                    for (var li2 = 0; li2 < tasks.length; li2++) {
                        var t = tasks[li2];
                        var icon = STATUS_ICON[t.status] || '[?]';
                        output += icon + ' #' + t.id + ' ' + t.content + '\n';
                        if (t.status === STATUS.pending) pendingCount++;
                    }
                    var doneCount = tasks.filter(function(t) { return t.status === STATUS.completed; }).length;
                    output += '\n' + doneCount + '/' + tasks.length + ' done' +
                        (pendingCount > 0 ? ', ' + pendingCount + ' pending' : '');
                    return makeResult(true, output);
                }
            }
            return makeResult(true, '');
        }
    });

    window.__dsagent_tools._todo_registered = true;
})();
