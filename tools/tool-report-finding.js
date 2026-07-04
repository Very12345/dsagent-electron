// report_finding - 代码审查的结构化发现（AtomCode 等效工具）
// AI 在代码审查时逐条上报问题，聚合后供用户查阅
// 用法: {"title": "潜在的内存泄漏", "body": "...", "priority": "P1", "file_path": "src/main.js", "line_start": 42, "line_end": 45}
;(function() {
    if (window.__dsagent_tools && window.__dsagent_tools._report_finding_registered) return;

    // 会话内累积的发现列表（内存状态，非持久化）
    var findings = [];

    window.__dsagent_tools.register({
        name: 'report_finding',
        scope: '上报代码审查发现的问题（供用户查看和参考）',
        description: '在代码审查过程中记录一条结构化的问题发现。每条发现包含标题、描述、优先级、' +
            '置信度、文件位置和建议修复方向。记录后可通过 list 操作查看已上报的全部发现。',
        params: [
            { name: 'title', type: '字符串', default: '—', required: true, description: '问题标题（简短描述）' },
            { name: 'body', type: '字符串', default: '—', required: false, description: '详细描述' },
            { name: 'priority', type: '字符串', default: 'P2', required: false, description: '优先级：P0(严重) / P1(高) / P2(中) / P3(低)' },
            { name: 'confidence', type: '数字', default: '0.8', required: false, description: '置信度：0.0~1.0' },
            { name: 'file_path', type: '字符串', default: '—', required: false, description: '问题所在文件路径' },
            { name: 'line_start', type: '数字', default: '—', required: false, description: '起始行号' },
            { name: 'line_end', type: '数字', default: '—', required: false, description: '结束行号' },
            { name: 'suggestion', type: '字符串', default: '—', required: false, description: '建议修复方向' },
            { name: 'action', type: '字符串', default: 'add', required: false, description: '操作：add=添加(默认), list=查看全部, clear=清空' }
        ],
        usage: '{"title": "未处理的Promise拒绝", "body": "async函数内缺少catch", "priority": "P1", "file_path": "src/api.js", "line_start": 15, "line_end": 20, "suggestion": "添加.catch()处理"}\n\n{"action": "list"}',
        notes: 'findings 仅在当前会话有效。list 操作可查看所有已上报发现。clear 操作清空全部。建议在审查最后使用 list 汇总。',
        handler: async function(params, body) {
            var makeResult = window.__dsagent_tools.makeResult;
            var action = params.action || 'add';

            // 从 body 解析
            if (!params.action && body) {
                try {
                    var bp = JSON.parse(body);
                    if (bp.action) action = bp.action;
                } catch(e) {}
            }

            if (action === 'list') {
                if (findings.length === 0) {
                    return makeResult(true, '(暂无发现。使用 report_finding 添加发现)');
                }
                var output = '📋 Code Review Findings (' + findings.length + ' total):\n\n';
                var priorityOrder = { 'P0': 0, 'P1': 1, 'P2': 2, 'P3': 3 };
                findings.sort(function(a, b) {
                    return (priorityOrder[a.priority] || 99) - (priorityOrder[b.priority] || 99);
                });
                for (var fi = 0; fi < findings.length; fi++) {
                    var f = findings[fi];
                    var severity = f.priority === 'P0' ? '🔴' : (f.priority === 'P1' ? '🟠' : (f.priority === 'P2' ? '🟡' : '🔵'));
                    output += severity + ' [' + f.priority + '] ' + f.title + '\n';
                    if (f.file_path) {
                        output += '    File: ' + f.file_path;
                        if (f.line_start) output += ':' + f.line_start + (f.line_end && f.line_end !== f.line_start ? '-' + f.line_end : '');
                        output += '\n';
                    }
                    if (f.body) {
                        var bodyPreview = f.body.length > 200 ? f.body.substring(0, 200) + '…' : f.body;
                        output += '    ' + bodyPreview + '\n';
                    }
                    if (f.suggestion) {
                        output += '    💡 ' + f.suggestion + '\n';
                    }
                    output += '\n';
                }
                return makeResult(true, output);
            }

            if (action === 'clear') {
                findings = [];
                return makeResult(true, '已清空全部发现');
            }

            // add (默认)
            var title = params.title || '';
            var body_content = params.body || '';
            var priority = params.priority || 'P2';
            var confidence = parseFloat(params.confidence);
            if (isNaN(confidence)) confidence = 0.8;
            var filePath = params.file_path || '';
            var lineStart = parseInt(params.line_start) || 0;
            var lineEnd = parseInt(params.line_end) || 0;
            var suggestion = params.suggestion || '';

            if (!title) return makeResult(false, null, 'report_finding 需要 title 参数');

            // 从 body 提取（向后兼容）
            if (!body_content && body) {
                try {
                    var bp = JSON.parse(body);
                    title = title || bp.title || '';
                    body_content = body_content || bp.body || '';
                    priority = bp.priority || priority;
                    confidence = bp.confidence !== undefined ? parseFloat(bp.confidence) : confidence;
                    filePath = filePath || bp.file_path || '';
                    lineStart = parseInt(bp.line_start) || lineStart;
                    lineEnd = parseInt(bp.line_end) || lineEnd;
                    suggestion = suggestion || bp.suggestion || '';
                } catch(e) {
                    body_content = body;
                }
            }

            // 验证优先级
            if (['P0', 'P1', 'P2', 'P3'].indexOf(priority) === -1) priority = 'P2';
            confidence = Math.max(0, Math.min(1, confidence));

            findings.push({
                title: title,
                body: body_content,
                priority: priority,
                confidence: confidence,
                file_path: filePath,
                line_start: lineStart,
                line_end: lineEnd,
                suggestion: suggestion,
                timestamp: new Date().toISOString()
            });

            var loc = '';
            if (filePath) {
                loc = filePath;
                if (lineStart) loc += ':' + lineStart + (lineEnd && lineEnd !== lineStart ? '-' + lineEnd : '');
            }
            var summary = '✅ Recorded finding [' + priority + '] ' + title;
            if (loc) summary += ' (' + loc + ')';

            return makeResult(true, summary, null, {
                total: findings.length,
                priority: priority,
                title: title,
                file_path: filePath,
                line_start: lineStart,
                line_end: lineEnd
            });
        }
    });

    window.__dsagent_tools._report_finding_registered = true;
})();
