// local-delete - 删除文件或目录
;(function() {
    if (window.__dsagent_tools && window.__dsagent_tools._delete_registered) return;

    window.__dsagent_tools.register({
        name: 'local-delete',
        scope: '删除文件或空目录',
        description: '删除指定路径的文件或空目录。危险操作，默认需要用户确认（取决于确认模式）。',
        params: [
            { name: 'path', type: '字符串', default: '—', required: true, description: '要删除的文件或空目录路径' }
        ],
        usage: 'path="D:\\project\\temp\\old_file.txt"',
        notes: '此操作不可逆！文件会被永久删除。支持直接写路径或 path="..." 形式。删除目录时目录必须为空。非宽松模式下始终需要用户确认。',
        handler: async function(content) {
            content = content.trim();
            var kv = (typeof window.__dsagent_parseKeyValuePairs === 'function')
                ? window.__dsagent_parseKeyValuePairs(content)
                : {};
            var targetPath = (kv.path || content).trim();
            if (!targetPath) throw new Error('Missing path');
            if (!(await window.__dsagent_confirmCommand('local-delete', targetPath))) return '(Cancelled by user)';
            var res = await window.electronAPI.agentDelete(targetPath);
            if (!res.success) throw new Error(res.error);
            return res.message;
        }
    });
    window.__dsagent_tools._delete_registered = true;
})();