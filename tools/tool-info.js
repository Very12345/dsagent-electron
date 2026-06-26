// info - 获取文件或目录详细信息
;(function() {
    if (window.__dsagent_tools && window.__dsagent_tools._info_registered) return;

    window.__dsagent_tools.register({
        name: 'info',
        scope: '获取文件或目录的详细信息',
        description: '返回文件或目录的详细信息，包括路径、大小、修改时间和类型。',
        params: [
            { name: 'path', type: '字符串', default: '—', required: true, description: '要查看的文件或目录路径' }
        ],
        usage: '<tool:info>{"path": "D:\\\\project\\\\config.json"}</tool:info>',
        notes: '返回信息包含：路径、大小、最后修改时间、类型。',
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
            var res = await window.electronAPI.agentInfo(targetPath);
            if (!res.success) return makeResult(false, null, res.error);
            var sizeStr = res.size < 1024 ? res.size + ' B' : (res.size < 1024*1024 ? (res.size/1024).toFixed(1) + ' KB' : (res.size/(1024*1024)).toFixed(1) + ' MB');
            var typeStr = res.isDirectory ? 'Directory' : (res.isFile ? 'File' : 'Other');
            var data = 'Path: ' + targetPath + '\nSize: ' + sizeStr + '\nModified: ' + res.mtime + '\nType: ' + typeStr;
            return makeResult(true, data);
        }
    });
    window.__dsagent_tools._info_registered = true;
})();