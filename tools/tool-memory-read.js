// memory_read - 读取持久化记忆（AtomCode /remember 等效）
// 用法: {"scope": "project"}   // global | project（默认 project）
;(function() {
    if (window.__dsagent_tools && window.__dsagent_tools._memory_read_registered) return;

    window.__dsagent_tools.register({
        name: 'memory_read',
        scope: '读取持久化记忆（global/project 两级）',
        description: '读取 AI 保存的持久化记忆，分为全局记忆（所有项目共享）和项目记忆（当前项目专属）。' +
            '返回结果包含所有记忆条目及其记录时间。',
        params: [
            { name: 'scope', type: '字符串', default: 'project', required: false, description: '记忆范围：global=全局记忆, project=当前项目记忆' }
        ],
        usage: '{"scope": "global"}\n\n{"scope": "project"}',
        notes: '记忆保存在 .dsa/memory.json 中。global 对所有项目可见，project 仅当前项目可见。',
        handler: async function(params) {
            var makeResult = window.__dsagent_tools.makeResult;
            var scope = params.scope || 'project';
            try {
                var res = await window.electronAPI.agentMemoryRead(scope);
                if (!res || !res.success) return makeResult(false, null, (res && res.error) || 'Failed to read memory');
                var entries = (scope === 'global' ? res.global : res.project) || [];
                if (entries.length === 0) return makeResult(true, '暂无记忆。');
                var output = '## ' + (scope === 'global' ? '全局' : '项目') + '记忆 (' + entries.length + ' 条)\n\n';
                for (var i = 0; i < entries.length; i++) {
                    var e = entries[i];
                    output += (i + 1) + '. ' + e.content + ' — ' + (e.timestamp || '').substring(0, 10) + '\n';
                }
                return makeResult(true, output);
            } catch (e) {
                return makeResult(false, null, 'memory_read 错误: ' + (e.message || e));
            }
        }
    });

    window.__dsagent_tools._memory_read_registered = true;
})();
