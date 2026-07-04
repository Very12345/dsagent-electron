// delete - 删除文件或目录
;(function() {
    if (window.__dsagent_tools && window.__dsagent_tools._delete_registered) return;

    window.__dsagent_tools.register({
        name: 'delete',
        scope: '删除文件或空目录',
        description: '删除指定路径的文件或空目录。危险操作，默认需要用户确认。' +
            '源码文件（.js/.ts/.rs/.py 等）即使 loose 模式也需要确认。',
        params: [
            { name: 'path', type: '字符串', default: '—', required: true, description: '要删除的文件或空目录路径' }
        ],
        usage: '<tool:delete>{"path": "D:\\\\project\\\\temp\\\\old_file.txt"}</tool:delete>',
        notes: '此操作不可逆！文件会被永久删除。源码文件即使宽松模式也需要确认。',
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
            // 源码文件始终需要确认（即使 loose 模式）
            var E = window.__dsagent_engine;
            var isSourceCode = E && E.isSourceCodeFile && E.isSourceCodeFile(targetPath);
            if (isSourceCode) {
                if (!(await window.__dsagent_confirmCommand('delete-source', targetPath))) return makeResult(false, null, 'Cancelled by user');
            } else {
                if (!(await window.__dsagent_confirmCommand('delete', targetPath))) return makeResult(false, null, 'Cancelled by user');
            }
            var res = await window.electronAPI.agentDelete(targetPath);
            if (!res.success) return makeResult(false, null, res.error);
            return makeResult(true, res.message);
        }
    });
    window.__dsagent_tools._delete_registered = true;
})();