// search_replace - 跨文件批量查找替换（AtomCode 等效工具）
// 用法: {"search": "旧文本", "replace": "新文本", "glob": "*.js", "path": "src"}
;(function() {
    if (window.__dsagent_tools && window.__dsagent_tools._search_replace_registered) return;

    // 跳过目录（与 glob 一致）
    var SKIP_DIRS = ['node_modules', '.git', 'target', '__pycache__', '.next', 'dist', 'build',
        '.cache', 'vendor', '.venv', 'venv', '.idea', '.vscode', 'datalog', 'logs', 'log',
        '.atomcode', '.claude', 'runs', 'bower_components', '.svn'];

    var MAX_RESULTS = 50; // 最多修改 50 个文件

    window.__dsagent_tools.register({
        name: 'search_replace',
        scope: '跨文件批量查找替换文本',
        description: '在多个文件中查找并替换文本。支持正则表达式，可用 glob 限定文件范围。' +
            '适用于项目级重命名（CSS 类名、import 路径、配置键等）。单文件替换请用 edit_file。',
        params: [
            { name: 'search', type: '字符串', default: '—', required: true, description: '要查找的文本或正则模式' },
            { name: 'replace', type: '字符串', default: '—', required: true, description: '替换文本（正则时可用 $1/$2 捕获组）' },
            { name: 'glob', type: '字符串', default: '—', required: false, description: '限定文件范围的 glob 模式，如 "*.rs"、"src/**/*.ts"' },
            { name: 'path', type: '字符串', default: '.', required: false, description: '搜索根目录（默认当前工作目录）' },
            { name: 'regex', type: '布尔', default: 'false', required: false, description: '是否将 search 视为正则表达式' }
        ],
        usage: '{"search": "旧类名", "replace": "新类名", "glob": "*.css"}\n\n{"search": "require\\((.*?)\\)", "replace": "import $1 from", "glob": "src/**/*.js", "regex": true}',
        notes: '危险操作！此不可逆。最多修改 ' + MAX_RESULTS + ' 个文件。建议先不带 replace 预览匹配结果。',
        handler: async function(params, body) {
            var makeResult = window.__dsagent_tools.makeResult;
            var search = params.search || '';
            var replace = params.replace || '';
            var globPattern = params.glob || '';
            var rootPath = params.path || '.';
            var useRegex = params.regex === true;

            // 从 body 解析
            if (!search && body) {
                try {
                    var bp = JSON.parse(body);
                    search = search || bp.search || '';
                    replace = replace || bp.replace || '';
                    globPattern = globPattern || bp.glob || '';
                    rootPath = bp.path || rootPath;
                    if (!useRegex) useRegex = bp.regex === true;
                } catch(e) {}
            }

            if (!search) return makeResult(false, null, 'Missing search pattern');

            try {
                // 1. 收集匹配的文件
                var allFiles = await collectFiles(rootPath, globPattern);
                if (allFiles.length === 0) {
                    return makeResult(false, null, '未找到匹配 "' + (globPattern || '*') + '" 的文件');
                }

                // 2. 逐文件搜索/替换
                var matchedFiles = [];
                var replacedFiles = [];
                var totalMatches = 0;
                var previewOnly = !replace;

                for (var fi = 0; fi < allFiles.length && matchedFiles.length < MAX_RESULTS; fi++) {
                    var filePath = allFiles[fi];
                    var readRes = await window.electronAPI.agentRead(filePath);
                    if (!readRes || !readRes.success) continue;
                    var content = readRes.content || '';

                    // 搜索
                    var matches = findMatches(content, search, useRegex);
                    if (matches.length === 0) continue;
                    matchedFiles.push({ path: filePath, count: matches.length, lines: matches });

                    // 如果提供了 replace，执行替换
                    if (replace) {
                        var newContent = doReplace(content, search, replace, useRegex);
                        if (newContent !== content) {
                            // 备份
                            try {
                                if (typeof window.__dsagent_fileHistoryBackup === 'function') {
                                    window.__dsagent_fileHistoryBackup(filePath);
                                }
                            } catch(e) {}
                            var editRes = await window.electronAPI.agentEdit(filePath, search, useRegex, replace);
                            if (editRes && editRes.success) {
                                replacedFiles.push({ path: filePath, count: matches.length });
                                totalMatches += matches.length;
                            }
                        }
                    } else {
                        totalMatches += matches.length;
                    }
                }

                // 3. 输出结果
                if (previewOnly) {
                    var output = 'Preview — ' + matchedFiles.length + ' file' +
                        (matchedFiles.length > 1 ? 's' : '') + ' match "' + search + '":\n\n';
                    for (var mi = 0; mi < Math.min(matchedFiles.length, 20); mi++) {
                        var mf = matchedFiles[mi];
                        output += mf.path + ' (' + mf.count + ' matches)\n';
                        var lines = mf.lines;
                        for (var li = 0; li < Math.min(lines.length, 5); li++) {
                            output += '  L' + lines[li].line + ': ' + lines[li].text.substring(0, 120) + '\n';
                        }
                        if (lines.length > 5) output += '  ... (+' + (lines.length - 5) + ' more)\n';
                        output += '\n';
                    }
                    if (matchedFiles.length > 20) {
                        output += '... (+' + (matchedFiles.length - 20) + ' more files)\n';
                    }
                    output += '(共 ' + matchedFiles.length + ' 个文件，' + totalMatches + ' 处匹配。再次调用时加上 replace 参数执行替换)';
                    return makeResult(true, output, null, { matchedFiles: matchedFiles.length, totalMatches: totalMatches });
                } else {
                    var summary = 'Replaced in ' + replacedFiles.length + ' file' +
                        (replacedFiles.length > 1 ? 's' : '') + ', ' + totalMatches + ' occurrence' +
                        (totalMatches > 1 ? 's' : '') + '.\n\n';
                    for (var ri = 0; ri < Math.min(replacedFiles.length, 30); ri++) {
                        summary += replacedFiles[ri].path + ' (' + replacedFiles[ri].count + ')\n';
                    }
                    if (matchedFiles.length > replacedFiles.length) {
                        summary += '\n(Warning: ' + (matchedFiles.length - replacedFiles.length) +
                            ' matched files were not modified — agentEdit may have failed or content changed)';
                    }
                    return makeResult(true, summary, null, { replacedFiles: replacedFiles.length, totalMatches: totalMatches });
                }
            } catch (e) {
                return makeResult(false, null, 'search_replace 错误: ' + (e.message || e));
            }
        }
    });

    // ====== 辅助函数 ======

    // 收集文件
    function collectFiles(rootDir, globPattern) {
        return new Promise(function(resolve, reject) {
            var allFiles = [];

            function walk(dir, depth) {
                if (depth > 8) return Promise.resolve();
                return window.electronAPI.agentList(dir).then(function(res) {
                    if (!res || !res.success || !res.files) return;
                    var entries = res.files || [];
                    var promises = [];
                    for (var i = 0; i < entries.length; i++) {
                        var e = entries[i];
                        var fullPath = dir + '/' + e.name;
                        if (SKIP_DIRS.indexOf(e.name) !== -1) continue;
                        if (e.isDirectory) {
                            promises.push(walk(fullPath, depth + 1));
                        } else {
                            var relPath = fullPath.replace(/\\/g, '/');
                            if (!globPattern || matchGlob(relPath, globPattern)) {
                                allFiles.push(fullPath);
                            }
                        }
                    }
                    return Promise.all(promises);
                }).catch(function() {});
            }

            walk(rootDir, 0).then(function() {
                allFiles.sort();
                resolve(allFiles);
            }).catch(reject);
        });
    }

    // 简单 glob 匹配
    function matchGlob(str, pattern) {
        var regexStr = '';
        var i = 0;
        while (i < pattern.length) {
            var ch = pattern[i];
            if (ch === '*' && pattern[i + 1] === '*') {
                regexStr += '.*';
                i += 2;
                if (pattern[i] === '/') i++;
            } else if (ch === '*') {
                regexStr += '[^/]*';
                i++;
            } else if (ch === '?') {
                regexStr += '[^/]';
                i++;
            } else if (ch === '.') {
                regexStr += '\\.';
                i++;
            } else if (ch === '/') {
                regexStr += '/';
                i++;
            } else {
                regexStr += ch;
                i++;
            }
        }
        try { return new RegExp('^' + regexStr + '$').test(str); }
        catch(e) { return str.indexOf(pattern) !== -1; }
    }

    // 查找匹配
    function findMatches(content, search, useRegex) {
        var results = [];
        var lines = content.split('\n');
        for (var i = 0; i < lines.length; i++) {
            var match = useRegex
                ? (function() { try { return lines[i].match(new RegExp(search, 'g')); } catch(e) { return null; } })()
                : (lines[i].indexOf(search) !== -1);
            if (match) {
                results.push({ line: i + 1, text: lines[i].trim() });
            }
        }
        return results;
    }

    // 执行替换
    function doReplace(content, search, replace, useRegex) {
        try {
            if (useRegex) {
                return content.replace(new RegExp(search, 'g'), replace);
            } else {
                // 全文替换（不是逐行）
                return content.split(search).join(replace);
            }
        } catch(e) {
            return content;
        }
    }

    window.__dsagent_tools._search_replace_registered = true;
})();
