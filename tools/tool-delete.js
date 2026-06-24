// local-delete - 删除文件或目录
;(function() {
    if (window.__dsagent_tools && window.__dsagent_tools._delete_registered) return;

    window.__dsagent_tools.register({
        name: 'local-delete',
        scope: '删除文件或空目录',
        description: '删除指定路径的文件或空目录。危险操作，默认需要用户确认。',
        params: [
            { name: 'path', type: '字符串', default: '—', required: true, description: '要删除的文件或空目录路径' }
        ],
        usage: '{"tool": "delete", "params": {"path": "D:\\\\project\\\\temp\\\\old_file.txt"}}',
        notes: '此操作不可逆！文件会被永久删除。非宽松模式下始终需要用户确认。',
        handler: async function(params, body) {
            var makeResult = window.__dsagent_tools.makeResult;
            var targetPath = (params.path || body || '').trim();
            // Backward compat
            if (!params.path && body) {
                var kv = (typeof window.__dsagent_parseKeyValuePairs === 'function')
                    ? window.__dsagent_parseKeyValuePairs(body)
                    : {};
                targetPath = (kv.path || body).trim();
            }
            if (!targetPath) return makeResult(false, null, 'Missing path');
            if (!(await window.__dsagent_confirmCommand('local-delete', targetPath))) return makeResult(false, null, 'Cancelled by user');
            var res = await window.electronAPI.agentDelete(targetPath);
            if (!res.success) return makeResult(false, null, res.error);
            return makeResult(true, res.message);
        }
    });
    window.__dsagent_tools._delete_registered = true;
})();