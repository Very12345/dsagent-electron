// list_directory - 列出目录树（AtomCode 标准命名 + depth 控制 + skip dirs）
// 别名 list 保留向后兼容。跳过 build/cache 目录。支持递归深度控制。
// 用法: {"path": "src", "depth": 3}
;(function() {
    if (window.__dsagent_tools && window.__dsagent_tools._list_directory_registered) return;

    // 跳过目录（与 AtomCode SKIP_DIRS 保持一致）
    var SKIP_DIRS = ['node_modules', '.git', 'target', '__pycache__', '.next', 'dist', 'build',
        '.cache', 'vendor', '.venv', 'venv', '.idea', '.vscode', 'datalog', 'logs', 'log',
        '.atomcode', '.claude', 'runs', 'bower_components', '.svn'];

    window.__dsagent_tools.register({
        name: ['list_directory', 'list'],
        scope: '浏览文件系统目录结构（跳过 build/cache 目录）',
        description: '列出指定目录下的文件和子目录，支持 depth 控制递归深度（默认 2，最高 5）。' +
            '自动跳过 node_modules、.git、target、__pycache__ 等 build/cache 目录。' +
            '返回树形缩进结构，目录名后带 "/"。',
        params: [
            { name: 'path', type: '字符串', default: '.', required: false, description: '要列出的目录路径（省略时默认为当前工作目录）' },
            { name: 'depth', type: '数字', default: '2', required: false, description: '递归深度（默认 2，最高 5）' }
        ],
        usage: '{"path": "src"}\n\n{"path": ".", "depth": 1}\n\n{"depth": 3}',
        notes: '超出 depth 的子目录不会展开。自动跳过 node_modules/.git/target 等目录。',
        handler: async function(params, body) {
            var makeResult = window.__dsagent_tools.makeResult;
            var targetDir = params.path || '.';
            var depth = parseInt(params.depth);
            if (isNaN(depth) || depth < 0) depth = 2;
            depth = Math.min(depth, 5);

            // 从 body 解析
            if (body && !params.path && !params.depth) {
                var trimmed = body.trim();
                var kv = (typeof window.__dsagent_parseKeyValuePairs === 'function')
                    ? window.__dsagent_parseKeyValuePairs(body)
                    : {};
                targetDir = kv.path || trimmed;
                if (kv.depth) depth = Math.min(parseInt(kv.depth) || 2, 5);
            }

            targetDir = targetDir.trim();

            try {
                var result = await listTree(targetDir, depth, 0);
                var output = result.path + '\n';
                for (var i = 0; i < result.entries.length; i++) {
                    output += result.entries[i] + '\n';
                }
                if (result.truncated) {
                    output += '\n(结果已截断：显示前 ' + result.truncatedAt + ' 项)';
                }
                return makeResult(true, output);
            } catch (e) {
                return makeResult(false, null, 'list_directory 错误: ' + (e.message || e));
            }
        }
    });

    // ====== 递归目录遍历 ======

    function listTree(dirPath, maxDepth, currentDepth) {
        return new Promise(function(resolve, reject) {
            var entries = [];
            var MAX_ENTRIES = 200;
            var truncated = false;

            window.electronAPI.agentList(dirPath).then(function(res) {
                if (!res || !res.success) {
                    reject(new Error(res ? res.error : 'agentList failed'));
                    return;
                }
                var files = res.files || [];
                var promises = [];

                // 先处理文件，再处理目录（文件排前面）
                for (var fi = 0; fi < files.length && entries.length < MAX_ENTRIES; fi++) {
                    var f = files[fi];
                    var prefix = '  '.repeat(currentDepth);
                    if (f.isDirectory) {
                        if (SKIP_DIRS.indexOf(f.name) !== -1) continue;
                        entries.push(prefix + f.name + '/');
                        if (currentDepth + 1 < maxDepth) {
                            // 递归遍历子目录
                            (function(subDir) {
                                var p = listTree(subDir, maxDepth, currentDepth + 1);
                                promises.push(p.then(function(subResult) {
                                    if (!subResult.truncated) {
                                        for (var si = 0; si < subResult.entries.length && entries.length < MAX_ENTRIES; si++) {
                                            entries.push(subResult.entries[si]);
                                        }
                                        if (entries.length >= MAX_ENTRIES) truncated = true;
                                    } else {
                                        // 父目录已截断，子目录结果追加
                                        for (var si2 = 0; si2 < subResult.entries.length && entries.length < MAX_ENTRIES; si2++) {
                                            entries.push(subResult.entries[si2]);
                                        }
                                        if (entries.length >= MAX_ENTRIES) truncated = true;
                                    }
                                }));
                            })(dirPath + '/' + f.name);
                        }
                    } else {
                        var sizeStr = '';
                        if (f.size !== undefined) {
                            sizeStr = f.size < 1024 ? ' (' + f.size + ' B)' :
                                (f.size < 1024 * 1024 ? ' (' + (f.size / 1024).toFixed(1) + ' KB)' :
                                    ' (' + (f.size / (1024 * 1024)).toFixed(1) + ' MB)');
                        }
                        entries.push(prefix + f.name + sizeStr);
                    }
                }

                if (entries.length >= MAX_ENTRIES) truncated = true;

                Promise.all(promises).then(function() {
                    resolve({
                        path: dirPath,
                        entries: entries,
                        truncated: truncated,
                        truncatedAt: truncated ? MAX_ENTRIES : 0
                    });
                });
            }).catch(function(err) {
                reject(err);
            });
        });
    }

    window.__dsagent_tools._list_directory_registered = true;
})();
