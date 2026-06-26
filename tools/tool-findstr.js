// findstr - 在文件中搜索匹配行
;(function() {
    if (window.__dsagent_tools && window.__dsagent_tools._findstr_registered) return;

    window.__dsagent_tools.register({
        name: 'findstr',
        scope: '在文件中搜索匹配行',
        description: '在文本文件中搜索包含指定关键字的行，返回行号和内容。支持多个关键字（用空格分隔则为 AND 逻辑）。',
        params: [
            { name: 'path', type: '字符串', default: '—', required: true, description: '文件路径（必填）' },
            { name: 'q', type: '字符串', default: '—', required: true, description: '搜索关键字，多个用空格分隔（AND 逻辑）' },
            { name: 'max', type: '数字', default: '30', required: false, description: '最多返回行数，默认 30' }
        ],
        usage: '<tool:findstr>{"path": "main.js", "q": "inject-menu-overlay", "max": 20}</tool:findstr>',
        notes: '搜索是大小写敏感的。max 用于限制输出，避免匹配太多行。',
        handler: async function(params, body) {
            var makeResult = window.__dsagent_tools.makeResult;
            var filePath = params.path || '';
            var query = params.q || '';
            var max = parseInt(params.max) || 30;

            if (!filePath) return makeResult(false, null, '缺少 path 参数');
            if (!query) return makeResult(false, null, '缺少 q 参数');

            var res = await window.electronAPI.agentRead(filePath);
            if (!res.success) return makeResult(false, null, res.error);

            var lines = res.content.split('\n');
            var keywords = query.split(/\s+/).filter(function(k) { return k.length > 0; });
            var totalLines = lines.length;
            var matches = [];

            for (var i = 0; i < totalLines && matches.length < max; i++) {
                var match = true;
                for (var j = 0; j < keywords.length; j++) {
                    if (lines[i].indexOf(keywords[j]) === -1) {
                        match = false;
                        break;
                    }
                }
                if (match) {
                    matches.push('L' + (i + 1) + ': ' + lines[i].trim());
                }
            }

            if (matches.length === 0) {
                return makeResult(true, '(未找到匹配 "' + query + '" 的行 / 共扫描 ' + totalLines + ' 行)');
            }

            var result = matches.join('\n');
            result += '\n\n(找到 ' + matches.length + ' 处匹配' + (matches.length >= max ? '，已达 max 限制' : '') + ' / 共 ' + totalLines + ' 行)';

            return makeResult(true, result);
        }
    });
    window.__dsagent_tools._findstr_registered = true;
})();
