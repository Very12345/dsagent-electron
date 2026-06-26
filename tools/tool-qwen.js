// qwen - Qwen 通用问答 + 绘图 + PPT 生成（合并 qwen-draw）
// callback=picture 启用绘图模式，callback=ppt 启用 PPT 生成模式，async=true 启动异步任务不等待
;(function() {
    if (window.__dsagent_tools && window.__dsagent_tools._qwen_merged_registered) return;

    window.__dsagent_tools.register({
        name: ['qwen', 'qwen-draw'],
        scope: '调用 Qwen 进行通用问答/文件分析/图片识别/AI 绘图/PPT 生成',
        description: '向 Qwen 发送问题或指令，支持上传文件、图片分析、AI 绘图、PPT 生成。\n'
            + '使用 callback=picture 进入绘图模式，生成图片保存到本地。\n'
            + '使用 callback=ppt 进入 PPT 生成模式，自动下载保存到本地。\n'
            + '使用 async=true 启动异步任务（绘图/PPT时推荐），不阻塞主流程，后续轮次自动获取结果。\n'
            + '比 DeepSeek 更擅长处理多语言、创意写作、代码生成等任务。',
        params: [
            { name: 'callback', type: '字符串', default: '—', required: false, description: 'picture=绘图模式, ppt=PPT生成模式（默认普通问答）' },
            { name: 'async', type: '布尔', default: 'false', required: false, description: 'true=异步执行不等待（绘图/PPT时推荐）' },
            { name: 'message', type: '字符串', default: '—', required: false, description: '要发送给 Qwen 的消息（也可放在 body 中）' },
            { name: 'paths', type: '字符串 / 数组', default: '—', required: false, description: '要上传的文件路径，支持数组格式 ["path1", "path2"]' },
            { name: 'savepath', type: '字符串', default: '系统下载目录', required: false, description: '图片/PPT保存目录（绘图/PPT模式）' },
            { name: 'desc', type: '字符串', default: '—', required: false, description: '附加说明文字（绘图/PPT模式）' },
            { name: 'ref', type: '字符串', default: '—', required: false, description: '参考图片/文件路径（绘图/PPT模式）' }
        ],
        usage: '<tool:qwen>{"message": "帮我写一个 Python 脚本"}</tool:qwen>\n\n// 图片分析\n<tool:qwen>{"paths": ["D:\\\\screenshot.png"], "body": "这张截图里有什么问题？"}</tool:qwen>\n\n// 绘图\n<tool:qwen>{"callback": "picture", "savepath": "D:\\\\images", "body": "一只熊猫在竹林里吃竹子"}</tool:qwen>\n\n// PPT\n<tool:qwen>{"callback": "ppt", "savepath": "D:\\\\ppt", "body": "请生成一份关于固体物理学的 PPT"}</tool:qwen>',
        notes: 'callback=picture 启用绘图模式；callback=ppt 启用 PPT 生成模式；async=true 不阻塞等待，后续轮次自动获取结果。对话内容会在完成后自动清理。',
        handler: async function(params, body) {
            var makeResult = window.__dsagent_tools.makeResult;
            var content;

            // Check if new params format is being used
            var hasNewParams = params.callback || params.async || params.message || params.paths || params.savepath || params.desc || params.ref;
            if (hasNewParams) {
                // Build content string for backward compat with old functions
                var parts = [];
                if (params.callback) parts.push('callback=' + params.callback);
                if (params.async) parts.push('async=' + params.async);
                if (params.paths) {
                    // 支持字符串（逗号分隔）和数组格式
                    var pathList = Array.isArray(params.paths) ? params.paths : params.paths.split(',').map(function(p) { return p.trim(); }).filter(Boolean);
                    pathList.forEach(function(p) { parts.push('path=' + p); });
                }
                if (params.savepath) parts.push('savepath=' + params.savepath);
                if (params.desc) parts.push('desc=' + params.desc);
                if (params.ref) parts.push('ref=' + params.ref);
                content = parts.join('\n') + '\n' + (params.message || body || '');
            } else {
                // Old format: body IS the full content (first line has key=value pairs)
                content = body || '';
            }

            var lines = content.trim().split('\n');
            var firstLine = lines[0].trim();
            var kv = (typeof window.__dsagent_parseKeyValuePairs === 'function')
                ? window.__dsagent_parseKeyValuePairs(firstLine)
                : {};

            var isPicture = (kv.callback || '').toLowerCase() === 'picture';
            var isPPT = (kv.callback || '').toLowerCase() === 'ppt';
            var isAsync = (kv.async || '').toLowerCase() === 'true' || kv.async === true;

            try {
                if (isPicture) {
                    // 绘图模式
                    if (typeof window.__dsagent_qwenDraw !== 'function') {
                        return makeResult(false, null, 'qwenDraw not initialized');
                    }
                    if (isAsync) {
                        var taskId = 'qwen_draw_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6);
                        var promise = window.__dsagent_qwenDraw(content);
                        if (!window.__dsagent_pendingAsyncTasks) {
                            window.__dsagent_pendingAsyncTasks = [];
                        }
                        window.__dsagent_pendingAsyncTasks.push({
                            id: taskId,
                            lang: 'qwen',
                            promise: promise,
                            startedAt: Date.now(),
                            desc: 'Qwen 绘图'
                        });
                        promise.catch(function(e) {});
                        console.log('[AsyncQwen] Started async draw task:', taskId);
                        return makeResult(true, '⏳ Qwen 绘图任务已启动（' + taskId + '），正在后台生成图片...\n（后续轮次将自动获取结果）');
                    } else {
                        var result = await window.__dsagent_qwenDraw(content);
                        return makeResult(true, result);
                    }
                } else if (isPPT) {
                    // PPT 生成模式
                    if (typeof window.__dsagent_qwenPPT !== 'function') {
                        return makeResult(false, null, 'qwenPPT not initialized');
                    }
                    if (isAsync) {
                        var taskId3 = 'qwen_ppt_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6);
                        var promise3 = window.__dsagent_qwenPPT(content);
                        if (!window.__dsagent_pendingAsyncTasks) {
                            window.__dsagent_pendingAsyncTasks = [];
                        }
                        window.__dsagent_pendingAsyncTasks.push({
                            id: taskId3,
                            lang: 'qwen',
                            promise: promise3,
                            startedAt: Date.now(),
                            desc: 'Qwen PPT 生成'
                        });
                        promise3.catch(function(e) {});
                        console.log('[AsyncQwen] Started async PPT task:', taskId3);
                        return makeResult(true, '⏳ Qwen PPT 生成任务已启动（' + taskId3 + '），正在后台生成...\n（后续轮次将自动获取结果）');
                    } else {
                        var result3 = await window.__dsagent_qwenPPT(content);
                        return makeResult(true, result3);
                    }
                } else {
                    // 普通问答模式
                    if (typeof window.__dsagent_qwenGeneral !== 'function') {
                        return makeResult(false, null, 'qwenGeneral not initialized');
                    }
                    if (isAsync) {
                        var taskId2 = 'qwen_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6);
                        var promise2 = window.__dsagent_qwenGeneral(content);
                        if (!window.__dsagent_pendingAsyncTasks) {
                            window.__dsagent_pendingAsyncTasks = [];
                        }
                        window.__dsagent_pendingAsyncTasks.push({
                            id: taskId2,
                            lang: 'qwen',
                            promise: promise2,
                            startedAt: Date.now(),
                            desc: 'Qwen 问答'
                        });
                        promise2.catch(function(e) {});
                        console.log('[AsyncQwen] Started async general task:', taskId2);
                        return makeResult(true, '⏳ Qwen 问答任务已启动（' + taskId2 + '），正在后台运行...\n（后续轮次将自动获取结果）');
                    } else {
                        var result2 = await window.__dsagent_qwenGeneral(content);
                        return makeResult(true, result2);
                    }
                }
            } catch(e) {
                return makeResult(false, null, e.message || 'qwen 调用异常');
            }
        }
    });
    window.__dsagent_tools._qwen_merged_registered = true;
})();