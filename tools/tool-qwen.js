// local-qwen - Qwen 通用问答（支持文件上传、图片分析）
;(function() {
    if (window.__dsagent_tools && window.__dsagent_tools._qwen_general_registered) return;

    window.__dsagent_tools.register({
        name: 'local-qwen',
        scope: '调用 Qwen 进行通用问答、文件分析、复杂图片识别等',
        description: '向 Qwen 发送问题或指令，支持上传文件供 Qwen 分析。\n支持上传图片进行视觉分析（截图、图表、手写文字、照片等复杂图片均可识别）。\n比 DeepSeek 更擅长处理多语言、创意写作、代码生成等任务。\n对话完成后会自动清理。',
        params: [
            { name: 'path', type: '字符串', default: '—', required: false, description: '要上传的文件路径（支持图片、文本文件、CSV 等各类文件）' }
        ],
        usage: '# 纯文本问题\n帮我写一个 Python 脚本处理 JSON 文件\n\n# 上传图片进行视觉分析\npath="D:\\screenshot.png"\n这张截图里有什么问题？\n\n# 上传文件分析\npath="D:\\data.csv"\n分析这个 CSV 文件的内容',
        notes: '支持上传图片、文档、文本等文件，图片支持复杂视觉分析（图表、手写、截图等）。对话内容会在完成后自动删除清理。',
        handler: async function(content) {
            if (typeof window.__dsagent_qwenGeneral === 'function') {
                return await window.__dsagent_qwenGeneral(content);
            }
            throw new Error('qwenGeneral not initialized');
        }
    });
    window.__dsagent_tools._qwen_general_registered = true;
})();