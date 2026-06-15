// local-qwen-draw - Qwen 绘图
;(function() {
    if (window.__dsagent_tools && window.__dsagent_tools._qwen_draw_registered) return;

    window.__dsagent_tools.register({
        name: 'local-qwen-draw',
        scope: '调用 Qwen 绘制图片',
        description: '使用 Qwen 的 AI 绘图功能生成图片。支持指定保存目录和附加说明文字。\n图片会自动下载到本地，并且返回本地文件路径。',
        params: [
            { name: 'savepath', type: '字符串', default: '系统下载目录', required: false, description: '图片保存目录（可选）' },
            { name: 'desc', type: '字符串', default: '—', required: false, description: '附加说明文字（可选），用于补充绘图意图' },
            { name: 'ref', type: '字符串', default: '—', required: false, description: '参考图片路径（可选），Qwen 会参考该图片进行绘制' }
        ],
        usage: 'savepath="D:\\myimages" desc="水墨风格"\n一只熊猫在竹林里吃竹子',
        notes: '主体内容为绘图描述词（必填）。支持参考图片（ref 参数），Qwen 会参考其内容进行绘制，也可以用于图片二次绘制。图片文件自动保存到指定目录或系统下载目录。',
        handler: async function(content) {
            if (typeof window.__dsagent_qwenDraw === 'function') {
                return await window.__dsagent_qwenDraw(content);
            }
            throw new Error('qwenDraw not initialized');
        }
    });
    window.__dsagent_tools._qwen_draw_registered = true;
})();