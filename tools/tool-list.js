// list - 列出目录内容
;(function() {
    if (window.__dsagent_tools && window.__dsagent_tools._list_registered) return;

    window.__dsagent_tools.register({
        name: 'list',
        scope: '浏览文件系统目录结构',
        description: '列出指定目录下的所有文件和子目录，显示文件名、类型（文件/目录）和大小。',
        params: [
            { name: 'path', type: '字符串', default: '.', required: false, description: '要列出的目录路径，省略时默认为当前工作目录' }
        ],
        usage: '<tool:list>{"path": "D:\\\\project\\\\src"}</tool:list>',
        notes: '省略路径时默认为当前工作目录。结果包含文件大小和修改时间信息。',
        handler: async function(params, body) {
            var makeResult = window.__dsagent_tools.makeResult;
            var targetDir = (params.path || (body ? body.trim() : '') || '.').trim();
            // Backward compat: parse key=value from body
            if (!params.path && body) {
                var kv = (typeof window.__dsagent_parseKeyValuePairs === 'function')
                    ? window.__dsagent_parseKeyValuePairs(body)
                    : {};
                targetDir = (kv.path || body).trim();
            }
            var res = await window.electronAPI.agentList(targetDir);
            if (!res.success) return makeResult(false, null, res.error);
            var output = res.path + '\n';
            for (var fi = 0; fi < res.files.length; fi++) {
                var f = res.files[fi];
                var sizeStr = f.size < 1024 ? f.size + ' B' : (f.size < 1024*1024 ? (f.size/1024).toFixed(1) + ' KB' : (f.size/(1024*1024)).toFixed(1) + ' MB');
                output += (f.isDirectory ? '[DIR] ' : '[FILE] ') + f.name + ' (' + sizeStr + ')\n';
            }
            return makeResult(true, output);
        }
    });
    window.__dsagent_tools._list_registered = true;
})();