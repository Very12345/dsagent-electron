// local-singleread - 子代理文件读取（新建独立对话读取文件）
;(function() {
    if (window.__dsagent_tools && window.__dsagent_tools._singleread_registered) return;

    window.__dsagent_tools.register({
        name: 'local-singleread',
        scope: '通过子代理读取大文件、多文件、PDF等。新建独立对话读取，不污染主对话上下文。',
        description: '创建独立的 DeepSeek 子对话来读取文件，读取完毕后自动清理临时对话。\n支持多文件同时读取、快速模式（上传文件）和专家模式（文本粘贴）。\nPDF 等二进制文件必须使用快速模式（mode=quick）。',
        params: [
            { name: 'path', type: '字符串', default: '—', required: true, description: '文件路径（必填），多个文件用逗号分隔' },
            { name: 'paths', type: '字符串', default: '—', required: false, description: '多文件路径，用逗号分隔（与 path 同义）' },
            { name: 'mode', type: '字符串', default: 'quick', required: false, description: '模式：quick（快速模式，上传文件，适合大文件和PDF）或 professional（专家模式，文本粘贴，有大小限制）' },
            { name: 'search', type: '字符串', default: 'off', required: false, description: '是否启用联网搜索：on 或 off' },
            { name: 'think', type: '字符串', default: 'off', required: false, description: '是否启用深度思考：on 或 off' },
            { name: 'prompt', type: '字符串', default: '—', required: false, description: '额外的分析指令，在换行后直接写也行' }
        ],
        usage: 'path="D:\\report.pdf"\n提取报告中的核心数据和结论\n\n# 多文件\npaths="D:\\file1.txt,D:\\file2.pdf" mode=quick\n比较两个文件的内容差异',
        notes: 'PDF 文件只能用 mode=quick。图片文件建议使用 local-qwen-vision 进行视觉分析。完成后会自动清理临时对话。extraPrompt 可以直接写在换行后。',
        handler: async function(content) {
            // 委托给 inject.js 中的 handleSingleRead
            if (typeof window.__dsagent_handleSingleRead === 'function') {
                var params = window.__dsagent_parseSingleReadParams(content);
                return await window.__dsagent_handleSingleRead(params);
            }
            throw new Error('handleSingleRead not initialized');
        }
    });
    window.__dsagent_tools._singleread_registered = true;
})();