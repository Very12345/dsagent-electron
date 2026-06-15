// local-edit - 文件查找替换
;(function() {
    if (window.__dsagent_tools && window.__dsagent_tools._edit_registered) return;

    window.__dsagent_tools.register({
        name: 'local-edit',
        scope: '在文件中执行文本查找替换',
        description: '在文件中查找指定文本并替换为新的内容。支持普通文本查找和正则表达式匹配。',
        params: [
            { name: 'path', type: '字符串', default: '—', required: true, description: '文件路径（必填）' },
            { name: 'find', type: '字符串', default: '—', required: true, description: '要查找的文本（必填）' },
            { name: 'regex', type: '字符串', default: '—', required: false, description: '设为 true 以启用正则匹配' },
            { name: 'replace', type: '字符串', default: '—', required: true, description: '替换为的文本（必填）' }
        ],
        usage: 'path="config.json" find="旧文本" replace="新文本"',
        notes: '默认使用普通文本匹配，设 regex=true 启用正则匹配。替换次数为第一个匹配。',
        handler: async function(content) {
            var kv = window.__dsagent_parseKeyValuePairs(content);
            if (!kv.path) throw new Error('Missing path=');
            var res = await window.electronAPI.agentEdit(kv.path.trim(), kv.find, kv.regex, kv.replace || '');
            if (!res.success) throw new Error(res.error);
            return res.message + (res.changed ? ' (Modified)' : ' (No match)');
        }
    });
    window.__dsagent_tools._edit_registered = true;
})();