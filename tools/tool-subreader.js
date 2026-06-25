// local-subreader - 子代理读取文件（三种模式）
;(function() {
    if (window.__dsagent_tools && window.__dsagent_tools._subreader_registered) return;

    window.__dsagent_tools.register({
        name: 'local-subreader',
        scope: '使用子代理读取和分析文件内容',
        description: '在独立对话中读取文件并由子 AI 分析总结。支持三种分析模式：\n\n'
            + '### 三种模式\n\n'
            + '- **`quick`**（快速模式）：快速提取关键信息，适合大文件快速浏览、PDF 摘要。\n'
            + '- **`professional`**（专业模式）：深度分析代码逻辑、架构、潜在问题，适合代码审查。仅文本，总大小 ≤ 159KB。\n'
            + '- **`image`**（识图模式）：分析图片内容，如 UI 截图、图表、照片。禁用深度思考，专注视觉识别。\n\n'
            + '### 可选参数\n'
            + '- `search`: on/off — 是否启用联网搜索\n'
            + '- `think`: on/off — 是否启用深度思考（image 模式强制关闭）\n'
            + '- `prompt`: 额外分析提示，如"提取所有题目"、"找出 bug"',
        params: [
            { name: 'paths', type: '字符串 / 数组', default: '—', required: true, description: '文件路径，多个用逗号分隔，或使用数组 ["path1", "path2"]' },
            { name: 'mode', type: '字符串', default: 'quick', required: false, description: '分析模式：quick（快速）/ professional（专业）/ image（识图）' },
            { name: 'search', type: '字符串', default: 'off', required: false, description: '是否启用联网搜索 on/off' },
            { name: 'think', type: '字符串', default: 'off', required: false, description: '是否启用深度思考 on/off（image 模式无效）' },
            { name: 'prompt', type: '字符串', default: '—', required: false, description: '额外分析提示，如"提取所有题目并给出答案"' }
        ],
        usage: '{"tool": "subreader", "params": {"paths": ["D:\\\\screenshot.png"], "mode": "image", "prompt": "识别图中所有按钮"}}\n\n{"tool": "subreader", "params": {"paths": "D:\\\\main.js", "mode": "professional", "prompt": "分析代码架构和潜在问题"}}',
        notes: 'quick 模式适合大文件和 PDF。professional 适合代码深度分析。image 适合截图、图表识别。',
        handler: async function(params, body) {
            var makeResult = window.__dsagent_tools.makeResult;
            // 支持字符串（逗号分隔）和数组格式
            var pathList = [];
            if (params.paths) {
                pathList = Array.isArray(params.paths) ? params.paths : params.paths.split(',').map(function(p) { return p.trim(); }).filter(Boolean);
            }
            if (pathList.length === 0 && body) {
                pathList = [body.trim()];
            }
            if (pathList.length === 0) {
                return makeResult(false, null, '请指定文件路径（paths）');
            }

            var parsed = {
                paths: pathList,
                mode: params.mode || 'quick',
                search: params.search || 'off',
                think: params.think || 'off',
                prompt: params.prompt || ''
            };

            if (typeof window.__dsagent_handleSingleRead === 'function') {
                var result = await window.__dsagent_handleSingleRead(parsed);
                return makeResult(true, result);
            }
            return makeResult(false, null, 'subreader not initialized');
        }
    });
    window.__dsagent_tools._subreader_registered = true;
})();