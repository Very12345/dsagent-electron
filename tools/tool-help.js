// local-help - 获取工具文档
;(function() {
    if (window.__dsagent_tools && window.__dsagent_tools._help_registered) return;

    window.__dsagent_tools.register({
        name: 'local-help',
        scope: '返回工具系统使用文档，当 AI 忘记指令用法时使用',
        description: '返回完整或单个工具的系统文档。不加参数返回所有工具的详细文档及处理逻辑说明。\n在代码块内写工具名称（如 local-exec）可返回该工具的单独介绍。',
        params: [
            { name: 'tool', type: '字符串', default: '—', required: false, description: '要查询的工具名称，如 local-exec、local-qwen 等。留空返回全部文档。' }
        ],
        usage: '# 查看全部文档\n\n# 查看单个工具\nlocal-exec',
        notes: '文档内容包含工具的说明、参数列表、使用示例和注意事项。',
        handler: async function(content) {
            var toolName = content.trim();
            if (toolName && window.__dsagent_tools.isSupported(toolName)) {
                return '# 工具文档: ' + toolName + '\n\n' + window.__dsagent_tools.doc(toolName);
            }
            // 有内容但不是有效工具名 → 尝试全文搜索
            if (toolName) {
                var tools = window.__dsagent_tools.getAll();
                for (var ti = 0; ti < tools.length; ti++) {
                    var t = tools[ti];
                    var names = Array.isArray(t.name) ? t.name : [t.name];
                    for (var ni = 0; ni < names.length; ni++) {
                        if (names[ni].indexOf(toolName) !== -1) {
                            return '# 工具文档: ' + names[ni] + '\n\n' + window.__dsagent_tools.doc(names[ni]);
                        }
                    }
                }
                return '未找到匹配工具: ' + toolName + '\n\n可用工具：\n' + window.__dsagent_tools.getAllLangs().map(function(n) { return '- `' + n + '`'; }).join('\n');
            }
            return window.__dsagent_tools.allDocs();
        }
    });
    window.__dsagent_tools._help_registered = true;
})();