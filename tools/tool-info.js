// local-info - 获取文件或目录详细信息
;(function() {
    if (window.__dsagent_tools && window.__dsagent_tools._info_registered) return;

    window.__dsagent_tools.register({
        name: 'local-info',
        scope: '获取文件或目录的详细信息',
        description: '返回文件或目录的详细信息，包括路径、大小、修改时间和类型（文件/目录）。',
        params: [],
        usage: 'D:\\project\\config.json',
        notes: '返回信息包含：路径、大小（自动格式化）、最后修改时间、类型。',
        handler: async function(content) {
            var path = content.trim();
            if (!path) throw new Error('Missing path');
            var res = await window.electronAPI.agentInfo(path);
            if (!res.success) throw new Error(res.error);
            var sizeStr = res.size < 1024 ? res.size + ' B' : (res.size < 1024*1024 ? (res.size/1024).toFixed(1) + ' KB' : (res.size/(1024*1024)).toFixed(1) + ' MB');
            return 'Path: ' + path + '\nSize: ' + sizeStr + '\nModified: ' + res.mtime + '\nType: ' + (res.isDirectory ? 'Directory' : 'File');
        }
    });
    window.__dsagent_tools._info_registered = true;
})();