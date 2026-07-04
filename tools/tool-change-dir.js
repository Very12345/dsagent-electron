// change_dir - 切换工作目录（AtomCode 等效工具）
// 影响后续工具调用的相对路径解析。不修改文件系统，仅改变上下文路径。
// 用法: {"path": "src"}, {"path": "/absolute/path"}
;(function() {
    if (window.__dsagent_tools && window.__dsagent_tools._change_dir_registered) return;

    // 当前工作目录（初始为 '.'，由 change_dir 更新）
    // 其他工具可通过 window.__dsagent_cwd 读取
    if (window.__dsagent_cwd === undefined) {
        window.__dsagent_cwd = '.';
    }

    window.__dsagent_tools.register({
        name: 'change_dir',
        scope: '切换工作目录（影响后续工具的相对路径解析）',
        description: '更改后续工具调用的工作目录。路径可以是绝对路径或相对于当前工作目录的相对路径。' +
            '目录必须存在。返回新的工作目录路径。' +
            '注意：此切换仅对后续工具调用有效，不会改变实际文件系统位置。',
        params: [
            { name: 'path', type: '字符串', default: '—', required: true, description: '要切换到的目录（绝对或相对路径）' }
        ],
        usage: '{"path": "src/utils"}\n\n{"path": "/home/user/project"}',
        notes: 'change_dir 只影响支持相对路径的工具。当前工作目录默认为项目根目录。',
        handler: async function(params, body) {
            var makeResult = window.__dsagent_tools.makeResult;
            var targetPath = params.path || '';

            if (!targetPath && body) {
                var trimmed = body.trim();
                var kv = (typeof window.__dsagent_parseKeyValuePairs === 'function')
                    ? window.__dsagent_parseKeyValuePairs(body)
                    : {};
                targetPath = kv.path || trimmed;
            }

            if (!targetPath) return makeResult(false, null, 'Missing path');

            // 解析为目标路径：如果是绝对路径直接用，否则相对于当前 cwd 拼接
            var resolvedPath = targetPath;
            if (targetPath.indexOf('/') !== 0 && targetPath.indexOf(':') !== 1) {
                // 相对路径
                var cwd = window.__dsagent_cwd || '.';
                // Windows: C:/ 开头的是绝对路径
                if (!/^[a-zA-Z]:[/\\]/.test(targetPath)) {
                    resolvedPath = (cwd === '.' ? '' : cwd) + '/' + targetPath;
                    // 规范化路径（去除 ../ 等）
                    resolvedPath = normalizePath(resolvedPath);
                }
            }

            // 验证目录是否存在
            try {
                var infoRes = await window.electronAPI.agentInfo(resolvedPath);
                if (!infoRes || !infoRes.success) {
                    return makeResult(false, null, '目录不存在: ' + resolvedPath);
                }
                if (!infoRes.isDirectory) {
                    return makeResult(false, null, '路径不是目录: ' + resolvedPath);
                }
                window.__dsagent_cwd = resolvedPath;
                // 同步更新服务器端 BASE_DIR，使 exec/read 等工具使用新目录
                try {
                    if (window.electronAPI && window.electronAPI.changeDir) {
                        window.electronAPI.changeDir(resolvedPath);
                    }
                } catch(e) { /* 非关键：仅同步服务器端 */ }
                return makeResult(true, '工作目录已切换为: ' + resolvedPath);
            } catch (e) {
                return makeResult(false, null, 'change_dir 错误: ' + (e.message || e));
            }
        }
    });

    // 路径规范化（去除 ./ ../ 多余分隔符）
    function normalizePath(p) {
        var isAbsolute = p.indexOf('/') === 0 || /^[a-zA-Z]:[/\\]/.test(p);
        var parts = p.replace(/\\/g, '/').split('/');
        var result = [];
        for (var i = 0; i < parts.length; i++) {
            if (parts[i] === '.' || parts[i] === '') continue;
            if (parts[i] === '..') {
                if (result.length > 0) result.pop();
                continue;
            }
            result.push(parts[i]);
        }
        var path = result.join('/');
        if (isAbsolute) path = '/' + path;
        // Windows drive letter
        if (/^[a-zA-Z]:/.test(p)) {
            path = p.substring(0, 2) + '/' + result.join('/');
        }
        return path || '.';
    }

    window.__dsagent_tools._change_dir_registered = true;
})();
