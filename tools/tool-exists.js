// local-exists - 检查文件或目录是否存在
;(function() {
    if (window.__dsagent_tools && window.__dsagent_tools._exists_registered) return;

    window.__dsagent_tools.register({
        name: 'local-exists',
        scope: '检查文件或目录是否存在',
        description: '检查指定路径的文件或目录是否存在，返回"Exists"或"Not found"。',
        params: [
            { name: 'path', type: '字符串', default: '—', required: true, description: '要检查的文件或目录路径' }
        ],
        usage: 'path="D:\\project\\config.json"',
        notes: '只检查存在性，不区分文件还是目录。支持直接写路径或 path="..." 形式。如需详细信息请使用 local-info。',
        handler: async function(content) {
            content = content.trim();
            var kv = (typeof window.__dsagent_parseKeyValuePairs === 'function')
                ? window.__dsagent_parseKeyValuePairs(content)
                : {};
            var targetPath = (kv.path || content).trim();
            if (!targetPath) throw new Error('Missing path');
            var res = await window.electronAPI.agentExists(targetPath);
            if (!res.success) throw new Error(res.error);
            return res.exists ? 'Exists' : 'Not found';
        }
    });
    window.__dsagent_tools._exists_registered = true;
})();