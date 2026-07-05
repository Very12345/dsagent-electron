// list-symbols — 列出文件中的符号（轻量版，正则匹配无 LSP）
// 参考 atomcode list_symbols 工具设计
// 用正则解析函数/类/变量定义，支持常见语言
;(function() {
    if (window.__dsagent_tools && window.__dsagent_tools._list_symbols_registered) return;

    // 语言 → 符号匹配正则
    var LANG_PATTERNS = {
        js: { def: /(?:function\s+(\w+)|const\s+(\w+)\s*=|let\s+(\w+)\s*=|var\s+(\w+)\s*=|class\s+(\w+)|(\w+)\s*=\s*(?:async\s*)?\(|module\.exports\s*=\s*(\w+))/g, comment: '//' },
        ts: { def: /(?:function\s+(\w+)|const\s+(\w+)\s*=|let\s+(\w+)\s*=|class\s+(\w+)|interface\s+(\w+)|type\s+(\w+)\s*=|enum\s+(\w+)|abstract\s+class\s+(\w+))/g, comment: '//' },
        py: { def: /(?:def\s+(\w+)|class\s+(\w+))/g, comment: '#' },
        rs: { def: /(?:fn\s+(\w+)|struct\s+(\w+)|enum\s+(\w+)|trait\s+(\w+)|impl\s+(\w+)(?:\s+for)?|pub\s+(?:fn|struct|enum|trait|type|const)\s+(\w+))/g, comment: '//' },
        go: { def: /(?:func\s+(\w+)|type\s+(\w+)\s+struct|type\s+(\w+)\s+interface|const\s+(\w+)\s+)/g, comment: '//' },
        java: { def: /(?:public|private|protected)?\s*(?:static\s+)?(?:class|interface|enum)\s+(\w+)|(?:public|private|protected)?\s+\w+\s+(\w+)\s*\(/g, comment: '//' },
    };

    window.__dsagent_tools.register({
        name: 'list_symbols',
        scope: '列出指定文件中的函数、类、变量等符号定义',
        description: '解析源文件中的符号定义。支持 JS/TS/Python/Rust/Go/Java 等语言。返回符号名和所在行号。',
        params: [
            { name: 'path', type: '字符串', default: '—', required: true, description: '文件路径（必填）' }
        ],
        usage: '{"path": "src/main.js"}\n\n{"path": "src/lib.rs"}',
        notes: '基于正则匹配，不依赖 LSP。仅列出定义（函数/类/接口/结构体），不列出调用。' +
            '不支持动态语言中的运行时构造。',
        handler: async function(params) {
            var makeResult = window.__dsagent_tools.makeResult;
            var filePath = (params.path || '').trim();
            if (!filePath) return makeResult(false, null, '缺少 path 参数');

            try {
                // 读文件内容
                var res = await window.electronAPI.agentRead(filePath);
                if (!res || !res.success) return makeResult(false, null, '文件读取失败: ' + (res && res.error || filePath));
                var content = res.data || '';
                if (!content) return makeResult(true, '（文件为空）');

                var ext = (filePath.split('.').pop() || '').toLowerCase();
                var pattern = LANG_PATTERNS[ext] || LANG_PATTERNS.js;
                var lines = content.split('\n');
                var symbols = [];
                var commentLine = pattern.comment;

                for (var li = 0; li < lines.length; li++) {
                    var line = lines[li];
                    var trimmed = line.trim();
                    // 跳过空行和注释行
                    if (!trimmed || trimmed.startsWith(commentLine)) continue;
                    // 重置正则
                    pattern.def.lastIndex = 0;
                    var m;
                    while ((m = pattern.def.exec(line)) !== null) {
                        for (var gi = 1; gi < m.length; gi++) {
                            if (m[gi]) {
                                symbols.push({ name: m[gi], line: li + 1, text: trimmed.substring(0, 80) });
                                break;
                            }
                        }
                    }
                }

                if (symbols.length === 0) return makeResult(true, '文件 ' + filePath + ' 中未发现已知符号定义。');
                var result = '符号列表 (' + symbols.length + ' 个):\n';
                symbols.forEach(function(s) {
                    result += '  ' + s.line + ': ' + s.name + '  // ' + s.text + '\n';
                });
                return makeResult(true, result);
            } catch (e) {
                return makeResult(false, null, 'list_symbols 错误: ' + (e.message || e));
            }
        }
    });
    window.__dsagent_tools._list_symbols_registered = true;
})();
