// server-deepseek.js — DeepSeek 网页版模型服务
// 运行在主进程，通过 executeJavaScript 调用 inject-deepseek.js 暴露的 DOM 协议
// 对外提供统一 invoke(modelId, op, args) 协议，供 agent-orchestrator.js 路由
'use strict';

const { app } = require('electron');

// DeepSeek 服务单例：绑定到一个 BrowserView（main.js 中的 mainWindow/DeepSeek 页面）
function createDeepseekServer(deepseekViewRef) {
    // deepseekViewRef: 一个函数/对象，返回当前可用的 DeepSeek BrowserView
    const getView = typeof deepseekViewRef === 'function' ? deepseekViewRef : () => deepseekViewRef;

    // ===== 模型注册 =====
    // DeepSeek 网页版有 3 个模式 = 3 个模型
    const MODELS = {
        'deepseek.expert': {
            id: 'deepseek.expert',
            provider: 'deepseek',
            displayName: 'DeepSeek 专家模式',
            mode: 'professional',          // inject 层期望的 mode 值
            capabilities: {
                inputMaxLen: 65536,
                file: { maxMB: 0, maxCount: 0, types: [] },  // 专家模式不支持文件上传
                multimodal: { input: [], output: ['text'] },
                deepThink: true,
                webSearch: true
            }
        },
        'deepseek.fast': {
            id: 'deepseek.fast',
            provider: 'deepseek',
            displayName: 'DeepSeek 快速模式',
            mode: 'quick',
            capabilities: {
                inputMaxLen: 65536,
                file: { maxMB: 50, maxCount: 10, types: ['txt', 'pdf', 'docx', 'md', 'csv', 'xlsx', 'pptx', 'json', 'html', 'xml', 'yaml'] },
                multimodal: { input: [], output: ['text'] },
                deepThink: true,
                webSearch: true
            }
        },
        'deepseek.image': {
            id: 'deepseek.image',
            provider: 'deepseek',
            displayName: 'DeepSeek 识图模式',
            mode: 'image',
            capabilities: {
                inputMaxLen: 65536,
                file: { maxMB: 50, maxCount: 10, types: ['txt', 'pdf', 'docx', 'md', 'png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp'] },
                multimodal: { input: ['image'], output: ['text'] },
                deepThink: false,           // 识图模式强制关闭深度思考
                webSearch: true
            }
        }
    };

    // ===== 并行槽位自管 =====
    // DeepSeek 同一时刻最多 2 个对话并行（由 orchestator/subagent 多 URL 轮切）
    const slots = {
        max: 2,
        active: 0,
        queue: []
    };
    let pollTimer = null;
    let pollPaused = false;

    function acquireSlot() {
        return new Promise((resolve) => {
            if (slots.active < slots.max) {
                slots.active++;
                resolve();
                return;
            }
            slots.queue.push(resolve);
        });
    }
    function releaseSlot() {
        slots.active = Math.max(0, slots.active - 1);
        if (slots.queue.length > 0) {
            const next = slots.queue.shift();
            slots.active++;
            next();
        }
    }

    // ===== 页面 JS 执行封装 =====
    // 等待 render frame 存活（SPA 导航期间帧会 disposed 重建）
    async function waitForFrameAlive(v, timeoutMs) {
        timeoutMs = timeoutMs || 10000;
        const start = Date.now();
        while (Date.now() - start < timeoutMs) {
            if (v.webContents.isDestroyed()) throw new Error('view destroyed');
            try { await v.webContents.executeJavaScript('1', true); return true; }
            catch (e) {
                const msg = String(e && e.message || e);
                if (msg.indexOf('disposed') >= 0 || msg.indexOf('Render frame') >= 0) { await new Promise((r) => setTimeout(r, 300)); continue; }
                await new Promise((r) => setTimeout(r, 200));
            }
        }
        throw new Error('Frame not alive after ' + timeoutMs + 'ms');
    }

    async function execJs(code) {
        const v = getView();
        if (!v || v.webContents.isDestroyed()) {
            throw new Error('DeepSeek view not available');
        }
        await waitForFrameAlive(v, 10000);
        const MAX_RETRY = 5;
        let lastErr = null;
        for (let attempt = 0; attempt < MAX_RETRY; attempt++) {
            try { return await v.webContents.executeJavaScript(code, true); }
            catch (e) {
                lastErr = e;
                const msg = String(e && e.message || e);
                // 任何瞬时错误都重试（GPU kTransientFailure、frame disposed、Render frame 等）
                if (msg.indexOf('disposed') >= 0 || msg.indexOf('Render frame') >= 0 || msg.indexOf('kTransientFailure') >= 0 || msg.indexOf('ContextResult') >= 0) {
                    try { await waitForFrameAlive(v, 5000); } catch (e2) {}
                    continue;
                }
                if (attempt < MAX_RETRY - 1) { await new Promise((r) => setTimeout(r, 500)); continue; }
                // 确保错误消息不为空（GPU 瞬时错误可能抛空 message）
                throw new Error(lastErr && (lastErr.message || String(lastErr)) || 'executeJavaScript failed after retries');
            }
        }
        throw new Error(lastErr && (lastErr.message || String(lastErr)) || 'execJs failed after retries');
    }

    // ===== invoke 协议实现 =====
    async function invoke(modelId, op, args) {
        args = args || {};
        const model = MODELS[modelId];
        if (!model) return { success: false, error: 'Unknown model: ' + modelId };

        // 能力校验（send/inject 前检查文件能力）
        if ((op === 'sendMessage' || op === 'injectHistory') && args.files && args.files.length > 0) {
            if (model.capabilities.file.maxCount === 0) {
                return { success: false, error: '模型 ' + modelId + ' 不支持文件上传' };
            }
            for (const f of args.files) {
                if (f.sizeMB > model.capabilities.file.maxMB) {
                    return { success: false, error: '文件 ' + f.name + ' 超过单文件上限 ' + model.capabilities.file.maxMB + 'MB' };
                }
            }
            if (args.files.length > model.capabilities.file.maxCount) {
                return { success: false, error: '文件数量超过上限 ' + model.capabilities.file.maxCount };
            }
        }

        // 多模态校验
        if (op === 'sendMessage' && args.images && args.images.length > 0) {
            if (model.capabilities.multimodal.input.indexOf('image') < 0) {
                return { success: false, error: '模型 ' + modelId + ' 不支持图片输入' };
            }
        }

        // 并发控制：长操作占槽，短查询不占
        const longOps = ['newChat', 'switchModel', 'injectHistory', 'sendMessage', 'waitForDone', 'extractResponse', 'deleteConversation'];
        const needSlot = longOps.indexOf(op) >= 0;

        if (needSlot) {
            await acquireSlot();
            // 暂停轮询，避免抢焦点
            if (op === 'sendMessage' || op === 'newChat' || op === 'switchModel') pollPaused = true;
        }
        try {
            return await dispatch(model, op, args);
        } finally {
            if (needSlot) {
                releaseSlot();
                if (op === 'sendMessage' || op === 'newChat' || op === 'switchModel') {
                    // 短延迟后恢复轮询
                    setTimeout(() => { pollPaused = false; }, 2000);
                }
            }
        }
    }

    async function dispatch(model, op, args) {
        // P0: Loop Guard — 检查工具调用是否陷入循环
        if (op === 'sendMessage' || op === 'injectHistory') {
            // 通过 executeJavaScript 调用 inject 层的 loopGuardCheck
            var v = getView();
            if (v && v.webContents && !v.webContents.isDestroyed()) {
                try {
                    // 注意：sendMessage 的 text 可能是用户消息，不是工具调用结果
                    // loopGuard 在 inject 层由工具执行器调用，这里不做重复检查
                } catch(e) {}
            }
        }
        switch (op) {
            case 'getCapabilities':
                return { success: true, data: model.capabilities };

            case 'listModels':
                return { success: true, data: Object.keys(MODELS).map((k) => MODELS[k]) };

            case 'newChat': {
                // 在 DeepSeek 页面新建对话并设置模式/深度思考/联网搜索
                // 重试等待 inject 脚本就绪（最多 30 秒）
                var newChatStart = Date.now();
                var newChatTimeout = args.timeout || 30000;
                var newChatResult = null;
                while (Date.now() - newChatStart < newChatTimeout) {
                    const js = `(async function(){
                        if (!window.__dsagent_newChatAndSendInit) return {success:false, error:'inject not ready'};
                        var r = await window.__dsagent_newChatAndSendInit(${JSON.stringify(model.mode)}, ${!!args.deepThink}, ${JSON.stringify(args.userText || '')}, ${!!args.webSearch});
                        return r;
                    })();`;
                    const r = await execJs(js);
                    if (r && r.success) { newChatResult = r; break; }
                    // 'inject not ready' 说明页面还在加载，等待后重试
                    await new Promise((r2) => setTimeout(r2, 1000));
                }
                if (!newChatResult) return { success: false, error: 'newChat failed: inject not ready after timeout' };
                return { success: true, data: { conversationUrl: newChatResult.deepseekUrl || '' } };
            }

            case 'switchModel': {
                // 仅切换模式（不新建对话）
                const js = `window.__dsagent_setModelMode ? (window.__dsagent_setModelMode(${JSON.stringify(model.mode)}), {success:true}) : {success:false, error:'inject not ready'};`;
                const r = await execJs(js);
                return r;
            }

            case 'setDeepThink': {
                const js = `(async function(){
                    if (!window.__dsagent_setDeepThink) return {success:false};
                    await window.__dsagent_setDeepThink(${!!args.enable});
                    return {success:true};
                })();`;
                return await execJs(js);
            }

            case 'setWebSearch': {
                const js = args.enable
                    ? `window.__dsagent_enableWebSearch ? (window.__dsagent_enableWebSearch(), {success:true}) : {success:false, error:'enableWebSearch not available'};`
                    : `window.__dsagent_disableWebSearch ? (window.__dsagent_disableWebSearch(), {success:true}) : {success:false, error:'disableWebSearch not available'};`;
                return await execJs(js);
            }

            case 'navigateToUrl': {
                const js = `window.location.href = ${JSON.stringify(args.url)}; true;`;
                await execJs(js);
                // 等待页面加载
                await new Promise((r) => setTimeout(r, 2000));
                return { success: true };
            }

            case 'getCurrentUrl': {
                const js = `window.location.href;`;
                const url = await execJs(js);
                return { success: true, data: { url: url } };
            }

            case 'injectHistory': {
                // 历史注入：分段发送，每段发送后等待 AI 回复并丢弃（仅建立上下文）
                const segments = args.segments || [];
                for (let i = 0; i < segments.length; i++) {
                    const seg = segments[i];
                    const isLast = (i === segments.length - 1);
                    const js = `(async function(){
                        if (!window.__dsagent_sendMessage) return {success:false, error:'inject not ready'};
                        var text = ${JSON.stringify(seg)};
                        await window.__dsagent_sendMessage(text);
                        return {success:true};
                    })();`;
                    const r = await execJs(js);
                    if (!r || !r.success) return { success: false, error: 'inject seg ' + i + ' failed' };
                    // 等待本轮生成结束（非最后段需等待以便继续注入）
                    await waitForDoneInternal(120000);
                    // 非最后段：丢弃 AI 回复（仅建立上下文），最后段不丢弃
                    if (!isLast && args.discardIntermediate !== false) {
                        // 无需显式丢弃：下一段 sendMessage 会自动追加到对话
                    }
                }
                return { success: true };
            }

            case 'sendMessage': {
                // 文件上传（如果有）
                if (args.files && args.files.length > 0) {
                    const uploadJs = `(async function(){
                        if (!window.__dsagent_uploadFiles) return {success:false, error:'upload not supported'};
                        return await window.__dsagent_uploadFiles(${JSON.stringify(args.files)});
                    })();`;
                    const ur = await execJs(uploadJs);
                    if (!ur || !ur.success) return { success: false, error: 'file upload failed: ' + (ur && ur.error) };
                }
                const js = `(async function(){
                    if (!window.__dsagent_sendMessage) return {success:false, error:'inject not ready'};
                    var r = await window.__dsagent_sendMessage(${JSON.stringify(args.text || '')});
                    // 检测频率限制/服务器繁忙
                    if (r && (typeof r === 'object') && (r.rateLimited || (r.error && (String(r.error).indexOf('429') >= 0)))) {
                        return {success:false, rateLimited:true, retryAfter: (r.retryAfter || 60)};
                    }
                    return r && typeof r === 'object' ? r : {success:true};
                })();`;
                const r = await execJs(js);
                if (r && r.rateLimited) {
                    return { success: false, error: 'rate_limited', retryAfter: r.retryAfter || 60 };
                }
                // 确保返回对象（inject 脚本可能返回原始值 true）
                return r && typeof r === 'object' ? r : { success: true };
            }

            case 'waitForDone': {
                const timeout = args.timeout || 120000;
                const stopped = await waitForDoneInternal(timeout);
                return { success: true, data: { stopped: !!stopped } };
            }

            case 'isExecuting': {
                // 轻量查询：返回 inject 层 isExecuting 状态（不阻塞）
                const js = `window.__dsagent_isExecuting ? window.__dsagent_isExecuting() : false;`;
                try {
                    const executing = await execJs(js);
                    return { success: true, data: { executing: !!executing } };
                } catch (e) {
                    return { success: true, data: { executing: false } };
                }
            }

            case 'isGenerating': {
                // 轻量查询：返回 DeepSeek 页面是否正在生成（按钮 SVG path 含 M2 4.88）
                const js = `(function(){
                    var b = document.querySelector('div.ds-button--primary.ds-button--filled.ds-button--circle');
                    if (!b) return false;
                    var sp = b.querySelector('svg path');
                    var d = sp ? (sp.getAttribute('d')||'') : '';
                    return d.indexOf('M2 4.88') >= 0;
                })();`;
                try {
                    const generating = await execJs(js);
                    return { success: true, data: { generating: !!generating } };
                } catch (e) {
                    return { success: true, data: { generating: false } };
                }
            }

            case 'extractResponse': {
                // 提取最后一条 AI 回复 + 深度思考内容
                // 使用重试轮询：AI 生成完成后 DOM 可能延迟几十到几百毫秒才渲染完成
                const extractTimeout = args.timeout || 15000;
                const extractStart = Date.now();
                let extractResult = null;
                while (Date.now() - extractStart < extractTimeout) {
                    const js = `(function(){
                        if (!window.__dsagent_extractLastResponse) return {success:false, error:'inject not ready'};
                        return window.__dsagent_extractLastResponse();
                    })();`;
                    const r = await execJs(js);
                    if (!r) return { success: false, error: 'extract failed' };
                    // 有内容则返回；空内容则等一会重试（DOM 还没渲染完）
                    if (r.markdown && r.markdown.trim()) {
                        extractResult = r;
                        break;
                    }
                    await new Promise((r2) => setTimeout(r2, 500));
                }
                if (!extractResult) {
                    // 超时后使用最后一次提取结果（可能为空）
                    const js = `(function(){
                        if (!window.__dsagent_extractLastResponse) return {markdown:''};
                        return window.__dsagent_extractLastResponse();
                    })();`;
                    extractResult = await execJs(js) || { markdown: '' };
                }
                return { success: true, data: { markdown: extractResult.markdown || '', think: extractResult.think || '' } };
            }

            case 'deleteConversation': {
                const js = `(async function(){
                    if (!window.__dsagent_deleteConversation) return {success:false};
                    return await window.__dsagent_deleteConversation(${args.convid ? JSON.stringify(args.convid) : 'null'});
                })();`;
                return await execJs(js);
            }

            case 'stopGeneration': {
                const js = `window.__dsagent_stopGeneration ? window.__dsagent_stopGeneration() : {success:false};`;
                return await execJs(js);
            }

            case 'getStatus': {
                const js = `window.__dsagent_getStatus ? window.__dsagent_getStatus() : {connected:false};`;
                return await execJs(js);
            }

            case 'checkReady': {
                const js = `!!(window.__dsagent_injected && window.__dsagent_sendMessage);`;
                const ready = await execJs(js);
                return { success: true, data: { ready: !!ready } };
            }

            case 'poll': {
                // 轮询：返回当前活跃对话状态（供 orchestrator 决策）
                if (pollPaused) return { success: true, data: { paused: true } };
                const js = `window.__dsagent_getStatus ? window.__dsagent_getStatus() : null;`;
                try {
                    const st = await execJs(js);
                    return { success: true, data: st };
                } catch (e) {
                    return { success: false, error: e.message };
                }
            }

            case 'interruptPoll': {
                pollPaused = true;
                return { success: true };
            }

            case 'resumePoll': {
                pollPaused = false;
                return { success: true };
            }

            default:
                return { success: false, error: 'Unknown op: ' + op };
        }
    }

    // 内部：等待生成结束（通过 inject 暴露的状态查询）
    async function waitForDoneInternal(timeout) {
        const start = Date.now();
        let wasGenerating = false;
        while (Date.now() - start < timeout) {
            try {
                const js = `(function(){
                    var b = document.querySelector('div.ds-button--primary.ds-button--filled.ds-button--circle');
                    if (!b) return 'nobtn';
                    var dis = b.classList.contains('ds-button--disabled') || b.disabled;
                    var sp = b.querySelector('svg path');
                    var d = sp ? (sp.getAttribute('d')||'') : '';
                    if (d.indexOf('M2 4.88') >= 0) return 'generating';
                    return dis ? 'done' : 'ready';
                })();`;
                const state = await execJs(js);
                if (state === 'generating') {
                    wasGenerating = true;
                } else if (wasGenerating && (state === 'done' || state === 'ready')) {
                    return false;
                } else if (state === 'nobtn') {
                    // 页面异常，退出
                    return true;
                }
            } catch (e) {
                // 忽略瞬时错误
            }
            await new Promise((r) => setTimeout(r, 500));
        }
        return true; // 超时
    }

    // ===== 轮询循环（后台） =====
    function startPoll(intervalMs) {
        if (pollTimer) clearInterval(pollTimer);
        pollTimer = setInterval(async () => {
            if (pollPaused) return;
            if (slots.active >= slots.max) return; // 有长操作在跑，跳过
            try {
                await invoke(null, 'poll', {});
            } catch (e) {
                // 静默
            }
        }, intervalMs || 5000);
    }
    function stopPoll() {
        if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    }

    return {
        provider: 'deepseek',
        models: MODELS,
        invoke,
        startPoll,
        stopPoll,
        // 暴露给 orchestrator 的并发查询
        getSlotStatus: () => ({ active: slots.active, max: slots.max, queued: slots.queue.length })
    };
}

module.exports = { createDeepseekServer };