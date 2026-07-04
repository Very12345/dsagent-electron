// glob - 按通配符模式查找文件（AtomCode 等效工具）
// 用法: {"pattern": "**/*.rs", "path": "src"}
;(function() {
    if (window.__dsagent_tools && window.__dsagent_tools._glob_registered) return;

    // 跳过目录（build/VCS/cache，与 AtomCode SKIP_DIRS 保持一致）
    var SKIP_DIRS = ['node_modules', '.git', 'target', '__pycache__', '.next', 'dist', 'build',
        '.cache', 'vendor', '.venv', 'venv', '.idea', '.vscode', 'datalog', 'logs', 'log',
        '.atomcode', '.claude', 'runs', 'bower_components', '.svn'];

    window.__dsagent_tools.register({
        name: 'glob',
        scope: '按通配符模式查找文件（如 **/*.js）',
        description: '按 glob 通配符模式查找文件，gitignore 感知，跳过 build/cache 目录。' +
            '`**` 跨目录，`*` 不跨目录。结果排序，上限 100 条。',
        params: [
            { name: 'pattern', type: '字符串', default: '—', required: true, description: 'Glob 模式，如 **/*.rs、src/**/*.ts' },
            { name: 'path', type: '字符串', default: '.', required: false, description: '搜索根目录（省略默认为当前工作目录）' }
        ],
        usage: '{"pattern": "**/*.js", "path": "src"}\n\n{"pattern": "*.json"}',
        notes: '结果最多返回 100 条。路径相对于当前工作目录。',
        handler: async function(params, body) {
            var makeResult = window.__dsagent_tools.makeResult;
            var pattern = params.pattern || '';
            var basePath = params.path || '.';

            // 从 body 解析（向后兼容）
            if (!pattern && body) {
                var kv = (typeof window.__dsagent_parseKeyValuePairs === 'function')
                    ? window.__dsagent_parseKeyValuePairs(body)
                    : {};
                pattern = pattern || kv.pattern || (body.trim());
                basePath = kv.path || basePath;
            }

            if (!pattern) return makeResult(false, null, 'Missing pattern');

            try {
                var results = await globWalk(basePath, pattern);
                if (results.length === 0) {
                    return makeResult(true, '(未找到匹配 "' + pattern + '" 的文件)');
                }
                var output = 'Found ' + results.length + ' file' + (results.length > 1 ? 's' : '') +
                    ' matching "' + pattern + '":\n\n';
                for (var i = 0; i < results.length; i++) {
                    output += results[i] + '\n';
                }
                return makeResult(true, output, null, { count: results.length });
            } catch (e) {
                return makeResult(false, null, 'glob 错误: ' + (e.message || e));
            }
        }
    });

    // ====== 递归目录遍历 + 通配符匹配 ======

    function globWalk(rootDir, pattern) {
        return new Promise(function(resolve, reject) {
            var matches = [];
            // 分解 pattern 为目录部分和文件名模式
            var parts = pattern.replace(/\\/g, '/').split('/');
            var filePattern = parts.pop(); // 最后一个部分：文件名模式
            var dirPattern = parts.join('/'); // 前面的部分：目录模式

            // 检查是否包含 ** — 递归搜索
            var recursive = pattern.indexOf('**') !== -1;

            walkDir(rootDir, dirPattern, recursive, function(filePath, isDir) {
                if (isDir) return;
                var relPath = filePath.replace(/\\/g, '/');
                // 匹配整个路径
                if (matchGlob(relPath, pattern)) {
                    matches.push(relPath);
                }
            }, function(err, fullList) {
                if (err) { reject(err); return; }
                // 排序 + 截断
                matches.sort();
                if (matches.length > 100) matches = matches.slice(0, 100);
                resolve(matches);
            });
        });
    }

    // 遍历目录（递归或非递归）
    function walkDir(dirPath, dirFilter, recursive, onFile, done) {
        var pending = 1; // 初始计数
        var errors = [];

        function collect() {
            pending--;
            if (pending === 0) done(errors.length > 0 ? errors[0] : null);
        }

        function processDir(dir, depth) {
            if (depth > 10) { collect(); return; } // 防止无限递归
            pending++;
            window.electronAPI.agentList(dir).then(function(res) {
                if (!res || !res.success) {
                    if (depth === 0) { errors.push(res ? res.error : 'agentList failed'); }
                    collect(); return;
                }
                var entries = res.files || [];
                for (var i = 0; i < entries.length; i++) {
                    var e = entries[i];
                    var fullPath = dir + '/' + e.name;
                    if (e.isDirectory) {
                        // 跳过 build/cache 目录
                        if (SKIP_DIRS.indexOf(e.name) !== -1) continue;
                        onFile(fullPath, true);
                        if (recursive) {
                            processDir(fullPath, depth + 1);
                        }
                    } else {
                        onFile(fullPath, false);
                    }
                }
                collect();
            }).catch(function(e) {
                if (depth === 0) errors.push(e);
                collect();
            });
        }

        processDir(dirPath, 0);
        collect(); // 释放初始计数
    }

    // 简单 glob 匹配（支持 * 和 **）
    function matchGlob(str, pattern) {
        // 将 glob 模式转为正则
        var regexStr = '';
        var i = 0;
        while (i < pattern.length) {
            var ch = pattern[i];
            if (ch === '*' && pattern[i + 1] === '*') {
                // ** 匹配任意目录层级
                regexStr += '.*';
                i += 2;
                if (pattern[i] === '/') i++; // 跳过 **/ 后的 /
            } else if (ch === '*') {
                // * 匹配非路径分隔符
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
        try {
            var re = new RegExp('^' + regexStr + '$');
            return re.test(str);
        } catch(e) {
            return str.indexOf(pattern) !== -1; // 降级到简单包含匹配
        }
    }

    window.__dsagent_tools._glob_registered = true;
})();
