// mkdir - 创建目录
;(function() {
    if (window.__dsagent_tools && window.__dsagent_tools._mkdir_registered) return;

    window.__dsagent_tools.register({
        name: 'mkdir',
        scope: '创建新目录',
        description: '创建新目录。支持创建多级目录，如果父目录不存在会一并创建。',
        params: [
            { name: 'path', type: '字符串', default: '—', required: true, description: '要创建的目录路径' }
        ],
        usage: '<tool:mkdir>{"path": "D:\\\\project\\\\new\\\\subdir"}</tool:mkdir>',
        notes: '如果目录已存在，操作仍然成功。路径中的父目录会自动创建。',
        handler: async function(params, body) {
            var makeResult = window.__dsagent_tools.makeResult;
            var targetPath = (params.path || body || '').trim();
            if (!params.path && body) {
                var kv = (typeof window.__dsagent_parseKeyValuePairs === 'function')
                    ? window.__dsagent_parseKeyValuePairs(body)
                    : {};
                targetPath = (kv.path || body).trim();
            }
            if (!targetPath) return makeResult(false, null, 'Missing path');
            var res = await window.electronAPI.agentMkdir(targetPath);
            if (!res.success) return makeResult(false, null, res.error);
            return makeResult(true, res.message);
        }
    });
    window.__dsagent_tools._mkdir_registered = true;
})();