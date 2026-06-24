// local-subreader - 子代理读取文件
;(function() {
    if (window.__dsagent_tools && window.__dsagent_tools._subreader_registered) return;

    window.__dsagent_tools.register({
        name: 'local-subreader',
        scope: '使用子代理读取和分析文件内容',
        description: '在独立对话中读取文件并由 AI 分析总结，适合大文件或需要深度分析的文件。',
        params: [
            { name: 'paths', type: '字符串', default: '—', required: true, description: '文件路径，多个用逗号分隔' },
            { name: 'mode', type: '字符串', default: 'quick', required: false, description: 'quick 或 professional 模式' },
            { name: 'search', type: '字符串', default: 'off', required: false, description: '是否启用联网搜索 on/off' },
            { name: 'think', type: '字符串', default: 'off', required: false, description: '是否启用深度思考 on/off' },
            { name: 'prompt', type: '字符串', default: '—', required: false, description: '额外分析提示' }
        ],
        usage: '{"tool": "subreader", "params": {"paths": "D:\\\\file1.txt, D:\\\\file2.txt", "mode": "quick"}}',
        notes: '适合大文件和 PDF 文件。支持多个文件同时读取。',
        handler: async function(params, body) {
            var makeResult = window.__dsagent_tools.makeResult;
            // Build content for backward compat
            var content = '';
            if (params.paths) content += 'paths=' + params.paths + '\n';
            if (params.mode) content += 'mode=' + params.mode + '\n';
            if (params.search) content += 'search=' + params.search + '\n';
            if (params.think) content += 'think=' + params.think + '\n';
            if (params.prompt) content += 'prompt=' + params.prompt + '\n';
            if (!content && body) content = body;

            if (typeof window.__dsagent_parseSingleReadParams === 'function' && typeof window.__dsagent_handleSingleRead === 'function') {
                var parsed = window.__dsagent_parseSingleReadParams(content);
                var result = await window.__dsagent_handleSingleRead(parsed);
                return makeResult(true, result);
            }
            return makeResult(false, null, 'subreader not initialized');
        }
    });
    window.__dsagent_tools._subreader_registered = true;
})();