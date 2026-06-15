// local-mkdir - 创建目录
;(function() {
    if (window.__dsagent_tools && window.__dsagent_tools._mkdir_registered) return;

    window.__dsagent_tools.register({
        name: 'local-mkdir',
        scope: '创建新目录',
        description: '创建新目录。支持创建多级目录，如果父目录不存在会一并创建。',
        params: [],
        usage: 'D:\\project\\new\\subdir',
        notes: '如果目录已存在，操作仍然成功（不报错）。路径中的父目录会自动创建。',
        handler: async function(content) {
            var path = content.trim();
            if (!path) throw new Error('Missing path');
            var res = await window.electronAPI.agentMkdir(path);
            if (!res.success) throw new Error(res.error);
            return res.message;
        }
    });
    window.__dsagent_tools._mkdir_registered = true;
})();