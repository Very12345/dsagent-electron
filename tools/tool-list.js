// local-list - 列出目录内容
;(function() {
    if (window.__dsagent_tools && window.__dsagent_tools._list_registered) return;

    window.__dsagent_tools.register({
        name: 'local-list',
        scope: '浏览文件系统目录结构',
        description: '列出指定目录下的所有文件和子目录，显示文件名、类型（文件/目录）和大小。',
        params: [],
        usage: 'D:\\project\\src',
        notes: '不提供路径时默认为当前工作目录。结果包含文件大小和修改时间信息。',
        handler: async function(content) {
            var targetDir = content && content.trim();
            if (!targetDir) targetDir = '.';
            var res = await window.electronAPI.agentList(targetDir);
            if (!res.success) throw new Error(res.error);
            var output = res.path + '\n';
            for (var fi = 0; fi < res.files.length; fi++) {
                var f = res.files[fi];
                var sizeStr = f.size < 1024 ? f.size + ' B' : (f.size < 1024*1024 ? (f.size/1024).toFixed(1) + ' KB' : (f.size/(1024*1024)).toFixed(1) + ' MB');
                output += (f.isDirectory ? '[DIR] ' : '[FILE] ') + f.name + ' (' + sizeStr + ')\n';
            }
            return output;
        }
    });
    window.__dsagent_tools._list_registered = true;
})();