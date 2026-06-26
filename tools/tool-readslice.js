// readslice - 按行号范围读取文件片段
;(function() {
    if (window.__dsagent_tools && window.__dsagent_tools._readslice_registered) return;

    window.__dsagent_tools.register({
        name: 'readslice',
        scope: '读取文件的指定行范围',
        description: '按行号范围读取文本文件片段。适合大文件中只关心特定行的情况，避免占用上下文。'
            + 'offset 为起始行号（1-based），limit 为读取行数。',
        params: [
            { name: 'path', type: '字符串', default: '—', required: true, description: '文件路径（必填）' },
            { name: 'offset', type: '数字', default: '1', required: true, description: '起始行号（1-based）' },
            { name: 'limit', type: '数字', default: '50', required: false, description: '读取行数，默认 50' }
        ],
        usage: '<tool:readslice>{"path": "main.js", "offset": 140, "limit": 30}</tool:readslice>',
        notes: '适合大文件中只关心特定行。offset 从 1 开始计数。',
        handler: async function(params, body) {
            var makeResult = window.__dsagent_tools.makeResult;
            var filePath = params.path || '';
            var offset = parseInt(params.offset) || 1;
            var limit = parseInt(params.limit) || 50;

            if (!filePath) return makeResult(false, null, '缺少 path 参数');
            if (offset < 1) offset = 1;
            if (limit < 1) limit = 50;

            var res = await window.electronAPI.agentRead(filePath);
            if (!res.success) return makeResult(false, null, res.error);

            var lines = res.content.split('\n');
            var totalLines = lines.length;
            var start = offset - 1;
            var end = Math.min(start + limit, totalLines);

            if (start >= totalLines) {
                return makeResult(true, '(文件共 ' + totalLines + ' 行，offset=' + offset + ' 超出范围)');
            }

            var slice = [];
            for (var i = start; i < end; i++) {
                slice.push('L' + (i + 1) + ': ' + lines[i]);
            }
            var result = slice.join('\n');
            result += '\n\n(第 ' + (start + 1) + '-' + end + ' 行 / 共 ' + totalLines + ' 行)';

            return makeResult(true, result);
        }
    });
    window.__dsagent_tools._readslice_registered = true;
})();
