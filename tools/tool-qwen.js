// local-qwen - Qwen 通用问答 + 绘图 + PPT 生成（合并 local-qwen-draw）
// callback=picture 启用绘图模式，callback=ppt 启用 PPT 生成模式，async=true 启动异步任务不等待
;(function() {
    if (window.__dsagent_tools && window.__dsagent_tools._qwen_merged_registered) return;

    window.__dsagent_tools.register({
        name: ['local-qwen', 'local-qwen-draw'],
        scope: '调用 Qwen 进行通用问答/文件分析/图片识别/AI 绘图/PPT 生成',
        description: '向 Qwen 发送问题或指令，支持上传文件、图片分析、AI 绘图、PPT 生成。\n'
            + '使用 callback=picture 进入绘图模式，生成图片保存到本地。\n'
            + '使用 callback=ppt 进入 PPT 生成模式，自动下载保存到本地。\n'
            + '使用 async=true 启动异步任务（绘图/PPT时推荐），不阻塞主流程，后续轮次自动获取结果。\n'
            + '比 DeepSeek 更擅长处理多语言、创意写作、代码生成等任务。',
        params: [
            { name: 'callback', type: '字符串', default: '—', required: false, description: 'picture=绘图模式, ppt=PPT生成模式（默认普通问答）' },
            { name: 'async', type: '布尔', default: 'false', required: false, description: 'true=异步执行不等待（绘图/PPT时推荐）' },
            { name: 'path', type: '字符串', default: '—', required: false, description: '要上传的文件路径（普通模式），多文件时每行写一个 path=...' },
            { name: 'savepath', type: '字符串', default: '系统下载目录', required: false, description: '图片/PPT保存目录（绘图/PPT模式）' },
            { name: 'desc', type: '字符串', default: '—', required: false, description: '附加说明文字（绘图/PPT模式）' },
            { name: 'ref', type: '字符串', default: '—', required: false, description: '参考图片/文件路径（绘图/PPT模式）' }
        ],
        usage: '# 普通问答\n帮我写一个 Python 脚本\n\n# 图片分析\npath="D:\\screenshot.png"\n这张截图里有什么问题？\n\n# 多文件\npath="D:\\img1.png"\npath="D:\\img2.jpg"\n分析这两张图片的异同\n\n# 同步绘图\ncallback=picture\nsavepath="D:\\images"\ndesc="水墨风格"\n一只熊猫在竹林里吃竹子\n\n# 异步绘图（推荐）\ncallback=picture\nasync=true\nsavepath="D:\\images"\n一只熊猫在竹林里吃竹子\n\n# PPT 生成\ncallback=ppt\nsavepath="D:\\ppt"\n请生成一份关于固体物理学的 PPT',
        notes: 'callback=picture 启用绘图模式；callback=ppt 启用 PPT 生成模式；async=true 不阻塞等待，后续轮次自动获取结果。对话内容会在完成后自动清理。',
        handler: async function(content) {
            var lines = content.trim().split('\n');
            var firstLine = lines[0].trim();
            var kv = (typeof window.__dsagent_parseKeyValuePairs === 'function')
                ? window.__dsagent_parseKeyValuePairs(firstLine)
                : {};

            var isPicture = (kv.callback || '').toLowerCase() === 'picture';
            var isPPT = (kv.callback || '').toLowerCase() === 'ppt';
            var isAsync = (kv.async || '').toLowerCase() === 'true' || kv.async === true;

            if (isPicture) {
                // 绘图模式
                if (typeof window.__dsagent_qwenDraw !== 'function') {
                    throw new Error('qwenDraw not initialized');
                }
                if (isAsync) {
                    var taskId = 'qwen_draw_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6);
                    var promise = window.__dsagent_qwenDraw(content);
                    if (!window.__dsagent_pendingAsyncTasks) {
                        window.__dsagent_pendingAsyncTasks = [];
                    }
                    window.__dsagent_pendingAsyncTasks.push({
                        id: taskId,
                        lang: 'local-qwen',
                        promise: promise,
                        startedAt: Date.now(),
                        desc: 'Qwen 绘图'
                    });
                    promise.catch(function(e) {});
                    console.log('[AsyncQwen] Started async draw task:', taskId);
                    return '⏳ Qwen 绘图任务已启动（' + taskId + '），正在后台生成图片...\n（后续轮次将自动获取结果）';
                } else {
                    return await window.__dsagent_qwenDraw(content);
                }
            } else if (isPPT) {
                // PPT 生成模式
                if (typeof window.__dsagent_qwenPPT !== 'function') {
                    throw new Error('qwenPPT not initialized');
                }
                if (isAsync) {
                    var taskId3 = 'qwen_ppt_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6);
                    var promise3 = window.__dsagent_qwenPPT(content);
                    if (!window.__dsagent_pendingAsyncTasks) {
                        window.__dsagent_pendingAsyncTasks = [];
                    }
                    window.__dsagent_pendingAsyncTasks.push({
                        id: taskId3,
                        lang: 'local-qwen',
                        promise: promise3,
                        startedAt: Date.now(),
                        desc: 'Qwen PPT 生成'
                    });
                    promise3.catch(function(e) {});
                    console.log('[AsyncQwen] Started async PPT task:', taskId3);
                    return '⏳ Qwen PPT 生成任务已启动（' + taskId3 + '），正在后台生成...\n（后续轮次将自动获取结果）';
                } else {
                    return await window.__dsagent_qwenPPT(content);
                }
            } else {
                // 普通问答模式
                if (typeof window.__dsagent_qwenGeneral !== 'function') {
                    throw new Error('qwenGeneral not initialized');
                }
                if (isAsync) {
                    var taskId2 = 'qwen_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6);
                    var promise2 = window.__dsagent_qwenGeneral(content);
                    if (!window.__dsagent_pendingAsyncTasks) {
                        window.__dsagent_pendingAsyncTasks = [];
                    }
                    window.__dsagent_pendingAsyncTasks.push({
                        id: taskId2,
                        lang: 'local-qwen',
                        promise: promise2,
                        startedAt: Date.now(),
                        desc: 'Qwen 问答'
                    });
                    promise2.catch(function(e) {});
                    console.log('[AsyncQwen] Started async general task:', taskId2);
                    return '⏳ Qwen 问答任务已启动（' + taskId2 + '），正在后台运行...\n（后续轮次将自动获取结果）';
                } else {
                    return await window.__dsagent_qwenGeneral(content);
                }
            }
        }
    });
    window.__dsagent_tools._qwen_merged_registered = true;
})();