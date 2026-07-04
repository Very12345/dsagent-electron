// memory_append - 保存一条持久化记忆（AtomCode /remember 等效）
// 用法: {"content": "记住这个项目使用 Vue 3 + TypeScript", "scope": "project"}
;(function() {
    if (window.__dsagent_tools && window.__dsagent_tools._memory_append_registered) return;

    window.__dsagent_tools.register({
        name: 'memory_append',
        scope: '保存一条持久化记忆（global/project 两级）',
        description: '将一条信息保存到持久化记忆，下次对话时自动注入到系统提示词中。' +
            '分为全局记忆（所有项目可用）和项目记忆（仅当前项目可用）。' +
            '记忆条目保存后不可修改，但可以通过 memory_clear 清除。',
        params: [
            { name: 'content', type: '字符串', default: '—', required: true, description: '要记住的内容' },
            { name: 'scope', type: '字符串', default: 'project', required: false, description: '保存范围：global=全局, project=当前项目' }
        ],
        usage: '{"content": "用户偏好使用 pnpm 而非 npm", "scope": "project"}\n\n{"content": "我的 API Key 保存在 ~/.secrets", "scope": "global"}',
        notes: '保存后的记忆在下次对话时自动注入 system prompt。最多保留 50 条。',
        handler: async function(params, body) {
            var makeResult = window.__dsagent_tools.makeResult;
            var content = params.content || body || '';
            var scope = params.scope || 'project';
            if (!content) return makeResult(false, null, 'Missing content');
            try {
                var res = await window.electronAPI.agentMemoryAppend(content, scope);
                if (!res || !res.success) return makeResult(false, null, (res && res.error) || 'Failed to save memory');
                return makeResult(true, '✅ 已保存' + (scope === 'global' ? '全局' : '项目') + '记忆: ' + content.substring(0, 100));
            } catch (e) {
                return makeResult(false, null, 'memory_append 错误: ' + (e.message || e));
            }
        }
    });

    window.__dsagent_tools._memory_append_registered = true;
})();
