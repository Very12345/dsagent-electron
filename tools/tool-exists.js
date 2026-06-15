// local-exists - 检查文件或目录是否存在
;(function() {
    if (window.__dsagent_tools && window.__dsagent_tools._exists_registered) return;

    window.__dsagent_tools.register({
        name: 'local-exists',
        scope: '检查文件或目录是否存在',
        description: '检查指定路径的文件或目录是否存在，返回"Exists"或"Not found"。',
        params: [],
        usage: 'D:\\project\\config.json',
        notes: '只检查存在性，不区分文件还是目录。如需详细信息请使用 local-info。',
        handler: async function(content) {
            var path = content.trim();
            if (!path) throw new Error('Missing path');
            var res = await window.electronAPI.agentExists(path);
            if (!res.success) throw new Error(res.error);
            return res.exists ? 'Exists' : 'Not found';
        }
    });
    window.__dsagent_tools._exists_registered = true;
})();