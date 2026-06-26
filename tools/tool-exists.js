// exists - 检查文件或目录是否存在
;(function() {
    if (window.__dsagent_tools && window.__dsagent_tools._exists_registered) return;

    window.__dsagent_tools.register({
        name: 'exists',
        scope: '检查文件或目录是否存在',
        description: '检查指定路径的文件或目录是否存在，返回 true 或 false。',
        params: [
            { name: 'path', type: '字符串', default: '—', required: true, description: '要检查的文件或目录路径' }
        ],
        usage: '<tool:exists>{"path": "D:\\\\project\\\\config.json"}</tool:exists>',
        notes: '只检查存在性，不区分文件还是目录。如需详细信息请使用 info。',
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
            var res = await window.electronAPI.agentExists(targetPath);
            if (!res.success) return makeResult(false, null, res.error);
            return makeResult(true, res.exists ? 'Exists' : 'Not found');
        }
    });
    window.__dsagent_tools._exists_registered = true;
})();