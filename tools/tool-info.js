// local-info - 获取文件或目录详细信息
;(function() {
    if (window.__dsagent_tools && window.__dsagent_tools._info_registered) return;

    window.__dsagent_tools.register({
        name: 'local-info',
        scope: '获取文件或目录的详细信息',
        description: '返回文件或目录的详细信息，包括路径、大小、修改时间和类型（文件/目录）。支持文件夹路径。',
        params: [
            { name: 'path', type: '字符串', default: '—', required: true, description: '要查看的文件或目录路径' }
        ],
        usage: 'path="D:\\project\\config.json"',
        notes: '返回信息包含：路径、大小（自动格式化）、最后修改时间、类型。支持直接写路径或 path="..." 形式。目录会显示其自身占用大小（不含子文件）。',
        handler: async function(content) {
            content = content.trim();
            var kv = (typeof window.__dsagent_parseKeyValuePairs === 'function')
                ? window.__dsagent_parseKeyValuePairs(content)
                : {};
            var targetPath = (kv.path || content).trim();
            if (!targetPath) throw new Error('Missing path');
            var res = await window.electronAPI.agentInfo(targetPath);
            if (!res.success) throw new Error(res.error);
            var sizeStr = res.size < 1024 ? res.size + ' B' : (res.size < 1024*1024 ? (res.size/1024).toFixed(1) + ' KB' : (res.size/(1024*1024)).toFixed(1) + ' MB');
            var typeStr = res.isDirectory ? 'Directory' : (res.isFile ? 'File' : 'Other');
            return 'Path: ' + targetPath + '\nSize: ' + sizeStr + '\nModified: ' + res.mtime + '\nType: ' + typeStr;
        }
    });
    window.__dsagent_tools._info_registered = true;
})();