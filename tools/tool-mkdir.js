// local-mkdir - 创建目录
;(function() {
    if (window.__dsagent_tools && window.__dsagent_tools._mkdir_registered) return;

    window.__dsagent_tools.register({
        name: 'local-mkdir',
        scope: '创建新目录',
        description: '创建新目录。支持创建多级目录，如果父目录不存在会一并创建。',
        params: [
            { name: 'path', type: '字符串', default: '—', required: true, description: '要创建的目录路径' }
        ],
        usage: 'path="D:\\project\\new\\subdir"',
        notes: '如果目录已存在，操作仍然成功（不报错）。支持直接写路径或 path="..." 形式。路径中的父目录会自动创建。',
        handler: async function(content) {
            content = content.trim();
            var kv = (typeof window.__dsagent_parseKeyValuePairs === 'function')
                ? window.__dsagent_parseKeyValuePairs(content)
                : {};
            var targetPath = (kv.path || content).trim();
            if (!targetPath) throw new Error('Missing path');
            var res = await window.electronAPI.agentMkdir(targetPath);
            if (!res.success) throw new Error(res.error);
            return res.message;
        }
    });
    window.__dsagent_tools._mkdir_registered = true;
})();