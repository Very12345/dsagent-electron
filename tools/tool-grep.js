// grep - 在文件/目录中搜索匹配行（正则，AtomCode 标准命名）
// 替代 findstr。支持正则 + context 上下文行 + gitignore-aware 跳过。
// 用法: {"pattern": "console\\.log\\(", "path": "src", "context": 3, "max_results": 20}
;(function() {
    if (window.__dsagent_tools && window.__dsagent_tools._grep_registered) return;

    var SKIP_DIRS = ['node_modules', '.git', 'target', '__pycache__', '.next', 'dist', 'build',
        '.cache', 'vendor', '.venv', 'venv', '.idea', '.vscode', 'datalog', 'logs', 'log',
        '.atomcode', '.claude', 'runs', 'bower_components', '.svn'];

    window.__dsagent_tools.register({
        name: ['grep', 'findstr'],
        scope: '在文件/目录中搜索匹配行（支持正则，gitignore 感知）',
        description: '在文件中搜索匹配的行。支持正则表达式（smart-case：模式含大写字母时区分大小写，否则不区分）。' +
            '`context` 参数可显示匹配行前后的上下文行。' +
            '自动跳过 node_modules/.git/target 等 build/cache 目录。',
        params: [
            { name: 'pattern', type: '字符串', default: '—', required: true, description: '搜索模式（支持正则表达式）' },
            { name: 'path', type: '字符串', default: '.', required: false, description: '搜索路径（文件或目录，默认当前工作目录）' },
            { name: 'max_results', type: '数字', default: '50', required: false, description: '最多返回匹配行数（默认 50）' },
            { name: 'context', type: '数字', default: '0', required: false, description: '上下文行数（默认 0，最高 10）' }
        ],
        usage: '{"pattern": "function hello", "path": "src"}\n\n{"pattern": "TODO|FIXME", "path": ".", "context": 2}\n\n{"pattern": "require\\(.*\\)", "path": "src/index.js", "max_results": 10}',
        notes: 'pattern 为正则表达式。特殊字符需要转义，如 `console\\.log\\(`。' +
            'context 默认为 0（只显示匹配行）。max_results 上限 200。',
        handler: async function(params, body) {
            var makeResult = window.__dsagent_tools.makeResult;
            var pattern = params.pattern || params.q || ''; // 兼容旧参数名 q
            var searchPath = params.path || '.';
            var maxResults = parseInt(params.max_results) || 50;
            var contextLines = parseInt(params.context) || 0;

            // 从 body 解析
            if (!pattern && body) {
                var trimmed = body.trim();
                try {
                    var bp = JSON.parse(trimmed);
                    pattern = pattern || bp.pattern || bp.q || '';
                    searchPath = bp.path || searchPath;
                    maxResults = parseInt(bp.max_results) || maxResults;
                    contextLines = parseInt(bp.context) || contextLines;
                } catch(e) {
                    var kv = (typeof window.__dsagent_parseKeyValuePairs === 'function')
                        ? window.__dsagent_parseKeyValuePairs(body)
                        : {};
                    pattern = pattern || kv.pattern || kv.q || trimmed;
                    searchPath = kv.path || searchPath;
                    maxResults = parseInt(kv.max_results) || maxResults;
                    contextLines = parseInt(kv.context) || contextLines;
                }
            }

            if (!pattern) return makeResult(false, null, 'Missing pattern');

            maxResults = Math.min(maxResults, 200);
            contextLines = Math.min(contextLines, 10);

            try {
                // 编译正则（smart-case）
                var flags = 'g';
                // 如果模式包含大写字母，区分大小写
                if (pattern === pattern.toLowerCase()) {
                    flags += 'i'; // 全小写 → 不区分大小写
                }
                var regex;
                try {
                    regex = new RegExp(pattern, flags);
                } catch(e) {
                    // 无效正则 → 降级为字面量搜索（转义特殊字符）
                    var escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                    regex = new RegExp(escaped, flags);
                }

                // 收集文件并搜索
                var results = [];
                var totalSearched = 0;

                // 先检查是否是单文件
                var infoRes = await window.electronAPI.agentInfo(searchPath);
                if (infoRes && infoRes.success && !infoRes.isDirectory) {
                    // 单文件搜索
                    var readRes = await window.electronAPI.agentRead(searchPath);
                    if (readRes && readRes.success) {
                        var content = readRes.content || '';
                        var lines = content.split('\n');
                        totalSearched = lines.length;
                        searchInLines(searchPath, lines, regex, contextLines, results, maxResults);
                    }
                } else {
                    // 目录搜索
                    await searchDir(searchPath, regex, contextLines, results, maxResults, 0, function(count) {
                        totalSearched += count;
                    });
                }

                if (results.length === 0) {
                    return makeResult(true, '(未找到匹配 "' + pattern + '" 的内容 / 共扫描 ' + totalSearched + ' 行)');
                }

                var output = '';
                var currentFile = '';
                for (var ri = 0; ri < results.length; ri++) {
                    var r = results[ri];
                    if (r.file !== currentFile) {
                        if (currentFile) output += '\n';
                        output += r.file + ':\n';
                        currentFile = r.file;
                    }
                    if (r.context_above) {
                        for (var ci = 0; ci < r.context_above.length; ci++) {
                            output += '  ' + r.context_above[ci] + '\n';
                        }
                    }
                    output += '> ' + r.line + ': ' + r.text + '\n';
                    if (r.context_below) {
                        for (var ci2 = 0; ci2 < r.context_below.length; ci2++) {
                            output += '  ' + r.context_below[ci2] + '\n';
                        }
                    }
                }

                output += '\n(找到 ' + results.length + ' 处匹配 / 共扫描 ' + totalSearched + ' 行' +
                    (results.length >= maxResults ? '，已达 max_results 上限' : '') + ')';

                return makeResult(true, output, null, { matches: results.length, searched: totalSearched });
            } catch (e) {
                return makeResult(false, null, 'grep 错误: ' + (e.message || e));
            }
        }
    });

    // ====== 搜索函数 ======

    function searchInLines(filePath, lines, regex, contextLines, results, maxResults) {
        if (results.length >= maxResults) return;

        for (var i = 0; i < lines.length && results.length < maxResults; i++) {
            regex.lastIndex = 0; // 重置正则状态
            if (regex.test(lines[i])) {
                var ctxAbove = [];
                var ctxBelow = [];
                for (var ci = 1; ci <= contextLines; ci++) {
                    if (i - ci >= 0) ctxAbove.push((i - ci + 1) + ': ' + lines[i - ci]);
                    if (i + ci < lines.length) ctxBelow.push((i + ci + 1) + ': ' + lines[i + ci]);
                }
                results.push({
                    file: filePath,
                    line: i + 1,
                    text: lines[i].trim().substring(0, 500),
                    context_above: ctxAbove,
                    context_below: ctxBelow
                });
            }
        }
    }

    function searchDir(dirPath, regex, contextLines, results, maxResults, depth, onLineCount) {
        return new Promise(function(resolve, reject) {
            if (depth > 8 || results.length >= maxResults) { resolve(); return; }

            window.electronAPI.agentList(dirPath).then(function(res) {
                if (!res || !res.success || !res.files) { resolve(); return; }
                var files = res.files || [];
                var promises = [];
                var totalLines = 0;

                for (var fi = 0; fi < files.length && results.length < maxResults; fi++) {
                    var f = files[fi];
                    var fullPath = dirPath + '/' + f.name;

                    if (f.isDirectory) {
                        if (SKIP_DIRS.indexOf(f.name) !== -1) continue;
                        promises.push(searchDir(fullPath, regex, contextLines, results, maxResults, depth + 1, function(count) {
                            totalLines += count;
                        }));
                    } else {
                        // 跳过二进制扩展名
                        var ext = f.name.split('.').pop().toLowerCase();
                        var binaryExts = ['exe', 'dll', 'bin', 'zip', 'rar', '7z', 'tar', 'gz', 'mp3', 'mp4',
                            'avi', 'mkv', 'mov', 'iso', 'img', 'dmg', 'apk', 'msi', 'dat', 'db', 'sqlite',
                            'mdb', 'class', 'o', 'obj', 'lib', 'a', 'so', 'dylib', 'png', 'jpg', 'jpeg',
                            'gif', 'bmp', 'webp', 'ico', 'ttf', 'otf', 'woff', 'woff2', 'pdf'];
                        if (binaryExts.indexOf(ext) !== -1) continue;

                        (function(fp, fn) {
                            var p = window.electronAPI.agentRead(fp).then(function(readRes) {
                                if (readRes && readRes.success) {
                                    var contentLines = (readRes.content || '').split('\n');
                                    totalLines += contentLines.length;
                                    searchInLines(fp, contentLines, regex, contextLines, results, maxResults);
                                }
                            }).catch(function() {});
                            promises.push(p);
                        })(fullPath, f.name);
                    }
                }

                Promise.all(promises).then(function() {
                    if (onLineCount) onLineCount(totalLines);
                    resolve();
                });
            }).catch(function() {
                resolve();
            });
        });
    }

    window.__dsagent_tools._grep_registered = true;
})();
