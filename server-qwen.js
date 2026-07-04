// server-qwen.js — Qwen 网页版模型服务
// 运行在主进程，通过 executeJavaScript 调用 inject-qwen.js 暴露的 DOM 协议
// 对外提供统一 invoke(modelId, op, args) 协议
'use strict';
const { clipboard } = require('electron');

function createQwenServer(qwenViewRef) {
    const getView = typeof qwenViewRef === 'function' ? qwenViewRef : () => qwenViewRef;

    // Qwen 生成状态缓存（由 sendMessage/waitForDone 更新，timer 轮询读此缓存避免戳帧）
    let _qwenGenerating = false;
    function getQwenGenerating() { return _qwenGenerating; }
    function setQwenGenerating(v) { _qwenGenerating = v; }

    // ===== 模型注册 =====
    // Qwen 网页版只有 1 个对话模型，支持文档+图片输入、图片输出
    const MODELS = {
        'qwen.default': {
            id: 'qwen.default',
            provider: 'qwen',
            displayName: 'Qwen 网页版',
            capabilities: {
                inputMaxLen: 32768,
                file: {
                    doc: { maxMB: 100, maxCount: 10, types: ['txt', 'pdf', 'docx', 'md', 'csv', 'xlsx', 'pptx', 'json', 'html', 'xml', 'yaml'] },
                    image: { maxMB: 100, maxCount: 10, types: ['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp'] }
                },
                multimodal: { input: ['image', 'text'], output: ['text', 'image'] }
            }
        }
    };

    // ===== 并行槽位：Qwen 可无限并行（移除限制） =====
    const slots = {
        max: Infinity,
        active: 0,
        queue: []
    };
    let pollTimer = null;
    let pollPaused = false;

    function acquireSlot() {
        return new Promise((resolve) => {
            if (slots.active < slots.max) { slots.active++; resolve(); return; }
            slots.queue.push(resolve);
        });
    }
    function releaseSlot() {
        slots.active = Math.max(0, slots.active - 1);
        if (slots.queue.length > 0) { const n = slots.queue.shift(); slots.active++; n(); }
    }

    // 单次执行：不探活、不重试。
    // 原因：waitForFrameAlive 用 executeJavaScript('1') 探活，帧 disposed 时该调用
    // 同步抛 "Render frame was disposed"（不被 .catch 捕获，直接刷屏），且 8 次重试放大刷屏。
    // 治本：调用方负责在帧稳定时调用；导航期间失败就快速返回，由上层 fallback DOM 提取。
    async function execJs(code) {
        const v = getView();
        if (!v || !v.webContents || v.webContents.isDestroyed()) throw new Error('Qwen view not available');
        return await v.webContents.executeJavaScript(code, true);
    }

    async function invoke(modelId, op, args) {
        args = args || {};
        const model = MODELS[modelId];
        if (!model) return { success: false, error: 'Unknown model: ' + modelId };

        // 能力校验
        if ((op === 'sendMessage' || op === 'injectHistory') && args.files && args.files.length > 0) {
            const docCap = model.capabilities.file.doc;
            const imgCap = model.capabilities.file.image;
            let docCount = 0, imgCount = 0;
            for (const f of args.files) {
                const isImg = imgCap.types.indexOf((f.ext || '').toLowerCase()) >= 0;
                if (isImg) {
                    imgCount++;
                    if (f.sizeMB > imgCap.maxMB) return { success: false, error: '图片 ' + f.name + ' 超过 ' + imgCap.maxMB + 'MB' };
                } else {
                    docCount++;
                    if (f.sizeMB > docCap.maxMB) return { success: false, error: '文档 ' + f.name + ' 超过 ' + docCap.maxMB + 'MB' };
                }
            }
            if (docCount > docCap.maxCount) return { success: false, error: '文档数量超过 ' + docCap.maxCount };
            if (imgCount > imgCap.maxCount) return { success: false, error: '图片数量超过 ' + imgCap.maxCount };
        }

        const longOps = ['newChat', 'injectHistory', 'sendMessage', 'waitForDone', 'extractResponse', 'deleteConversation'];
        const needSlot = longOps.indexOf(op) >= 0;
        if (needSlot) {
            await acquireSlot();
            if (op === 'sendMessage' || op === 'newChat') pollPaused = true;
        }
        try {
            return await dispatch(model, op, args);
        } finally {
            if (needSlot) {
                releaseSlot();
                if (op === 'sendMessage' || op === 'newChat') setTimeout(() => { pollPaused = false; }, 2000);
            }
        }
    }

    async function dispatch(model, op, args) {
        switch (op) {
            case 'getCapabilities':
                return { success: true, data: model.capabilities };

            case 'listModels':
                return { success: true, data: Object.keys(MODELS).map((k) => MODELS[k]) };

            case 'newChat': {
                setQwenGenerating(false); // 新对话开始，旧生成结束
                const userText = args.userText || '';
                const js = `(async function(){
                    // 0. 检查 inject 是否就绪
                    if (!window.__qwen) {
                        return {success:false, error:'__qwen not injected'};
                    }
                    if (!window.__qwen.newConversation) {
                        return {success:false, error:'newConversation missing'};
                    }
                    // 1. 新建对话
                    var r = await window.__qwen.newConversation();
                    if (!r.success) return r;
                    // 2. 等待编辑器就绪（编辑器存在即就绪，sendMessage 内部有 waitForEditorReady 兜底）
                    var ready = await new Promise(function(resolve){
                        var retry = 0;
                        function check(){
                            var ed = document.querySelector('[contenteditable="true"][data-slate-editor="true"]');
                            if (ed) { resolve(true); return; }
                            if (++retry > 40) { resolve(false); return; }
                            setTimeout(check, 100);
                        }
                        setTimeout(check, 100);
                    });
                    // 3. 合并发送 userText
                    var _ut = ${JSON.stringify(userText)};
                    if (ready && _ut && _ut.trim()) {
                        if (!window.__qwen.sendMessage) {
                            return {success:false, error:'sendMessage missing'};
                        }
                        // sendMessage 触发发送后 Qwen SPA 导航，JS 上下文销毁，await 永不返回
                        // 用 Promise.race 加 3s 超时：超时视为发送已发起（点击已执行），导航是正常现象
                        try {
                            var sendPromise = window.__qwen.sendMessage(_ut);
                            var result = await Promise.race([
                                sendPromise,
                                new Promise(function(resolve){ setTimeout(function(){ resolve({__timeout:true}); }, 3000); })
                            ]);
                            if (result && result.__timeout) {
                                // 超时 = 大概率已导航，属正常，不报错
                            } else if (!result || !result.success) {
                                return {success:false, error:'sendMessage failed: ' + (result && result.error || '')};
                            }
                        } catch(e) {
                            // 导航导致的异常也视为正常（发送已触发）
                        }
                    }
                    return {success:true, url: window.location.href};
                })();`;
                const r = await execJs(js);
                console.log('[server-qwen newChat] execJs returned:', JSON.stringify(r));
                if (!r || !r.success) return { success: false, error: (r && r.error) || 'newChat failed' };
                return { success: true, data: { conversationUrl: r.url || '' } };
            }

            case 'navigateToUrl': {
                const js = `window.location.href = ${JSON.stringify(args.url)}; true;`;
                await execJs(js);
                await new Promise((r) => setTimeout(r, 2000));
                return { success: true };
            }

            case 'getCurrentUrl': {
                return { success: true, data: { url: await execJs('window.location.href;') } };
            }

            case 'uploadFiles': {
                // 通过主进程 paste 机制上传（Qwen 页面 Slate 编辑器不支持直接 set files）
                // 这里仅触发上传按钮，实际文件注入由 main.js 的 qwen-paste-image/text 处理
                const js = `(async function(){
                    if (!window.__qwen || !window.__qwen.uploadImage) return {success:false};
                    return await window.__qwen.uploadImage();
                })();`;
                return await execJs(js);
            }

            case 'injectHistory': {
                const segments = args.segments || [];
                for (let i = 0; i < segments.length; i++) {
                    const js = `(async function(){
                        if (!window.__qwen || !window.__qwen.sendMessage) return {success:false};
                        return await window.__qwen.sendMessage(${JSON.stringify(segments[i])});
                    })();`;
                    const r = await execJs(js);
                    if (!r || !r.success) return { success: false, error: 'inject seg ' + i + ' failed' };
                    // 等待本段答完：复用 waitForDone op 逻辑
                    const wdr = await invoke(null, 'waitForDone', { timeout: 90000 });
                    if (!wdr || !wdr.success || !wdr.data.done) console.warn('[Qwen injectHistory] seg ' + i + ' waitForDone not done, continuing');
                }
                return { success: true };
            }

            case 'sendMessage': {
                setQwenGenerating(true); // 发送消息后预期进入生成态
                const js = `(async function(){
                    if (!window.__qwen || !window.__qwen.sendMessage) return {success:false, error:'inject not ready'};
                    return await window.__qwen.sendMessage(${JSON.stringify(args.text || '')});
                })();`;
                return await execJs(js);
            }

            case 'waitForDone': {
                // 在 inject 上下文轮询 isGeneratingNow（唯一信号：停止按钮在不在）
                // 见到停止按钮(wasGen=true) → 消失即答完。前 12s 允许等生成开始，超时即失败。
                const timeout = args.timeout || 90000;
                const js = `(async function(){
                    if (!window.__qwen || !window.__qwen.isGeneratingNow) return {success:false, error:'isGeneratingNow missing'};
                    // 置 navigating=true，阻止 MutationObserver 在 while 循环/导航期间 .click() 触发崩溃
                    if (window.__qwen._navigating !== undefined) window.__qwen._navigating = true;
                    var start = Date.now();
                    var wasGen = false;
                    try {
                    while (Date.now() - start < ${timeout}) {
                        var gen = !!window.__qwen.isGeneratingNow().generating;
                        if (gen) wasGen = true;
                        var now = Date.now();
                        // 主信号：曾经生成中，现在停止按钮消失 → 答完
                        if (wasGen && !gen) { if (window.__qwen._navigating !== undefined) window.__qwen._navigating = false; return {success:true, done:true, reason:'stop-btn-gone'}; }
                        // 检测图片生成卡片（AI 图片回复没有停止按钮，用 data-card-type 信号）
                        var imgCard = document.querySelector('[data-card-type="ai_generate_image_list"]');
                        if (imgCard && !gen) { if (window.__qwen._navigating !== undefined) window.__qwen._navigating = false; return {success:true, done:true, reason:'image-card', hasImages:true}; }
                        // 前 12s 还没见到生成 → 继续等（发送到进入生成态有延迟）
                        // 超过 12s 仍 wasGen=false → 发送可能失败，报错
                        if (!wasGen && now - start > 12000) { if (window.__qwen._navigating !== undefined) window.__qwen._navigating = false; return {success:true, done:false, reason:'never-saw-generation'}; }
                        await new Promise(function(r){ setTimeout(r, 200); });
                    }
                    } finally { if (window.__qwen._navigating !== undefined) window.__qwen._navigating = false; }
                    return {success:true, done:false, reason:'timeout'};
                })();`;
                try {
                    const r = await execJs(js);
                    setQwenGenerating(false); // waitForDone 结束，不管结果如何，生成态已结束
                    if (!r) return { success: false, error: 'waitDone execJs null' };
                    console.log('[Qwen waitDone] result:', JSON.stringify(r));
                    return { success: true, data: { stopped: true, done: !!(r.done), reason: r.reason || '' } };
                } catch (e) {
                    setQwenGenerating(false);
                    console.error('[Qwen waitDone] execJs error:', e.message);
                    return { success: false, error: e.message };
                }
            }

            case 'extractResponse': {
                // 新方式：两步菜单复制 → 点击右侧箭头 → "复制为Markdown"（不漏代码框）
                // clipboad 操作在 inject 层通过 electronAPI.clipboardReadText 完成
                const view = getView();
                if (!view || !view.webContents || view.webContents.isDestroyed()) {
                    return { success: false, error: 'Qwen view not ready' };
                }
                try {
                    const js = `(async function(){
                        if (!window.__qwen || !window.__qwen.invoke) return {success:false, error:'inject not ready'};
                        return await window.__qwen.invoke('extractViaCopyAsMarkdown', {});
                    })();`;
                    const result = await execJs(js);
                    console.log('[Qwen extract] extractViaCopyAsMarkdown result source=' + (result && result.source || '') + ' len=' + ((result && result.markdown) || '').length);
                    if (result && result.markdown) {
                        return { success: true, data: { markdown: result.markdown, images: result.images || [], source: result.source || 'clipboard-menu' } };
                    }
                    // 菜单复制失败，fallback 到旧复制按钮坐标点击
                    console.log('[Qwen extract] menu copy failed, fallback to coord click');
                    const coordJs = `(async function(){
                        if (!window.__qwen || !window.__qwen.invoke) return {success:false, error:'inject not ready'};
                        return await window.__qwen.invoke('findCopyButtonCoord', {});
                    })();`;
                    const coord = await execJs(coordJs);
                    if (!coord || !coord.success) {
                        console.log('[Qwen extract] copy btn not found, fallback DOM');
                        const fbJs = `(async function(){
                            return await window.__qwen.invoke('extractResponse', {});
                        })();`;
                        const fb = await execJs(fbJs);
                        return { success: true, data: { markdown: (fb && fb.markdown) || '', images: (fb && fb.images) || [], source: 'dom-fallback' } };
                    }
                    console.log('[Qwen extract] copy btn coord fallback:', JSON.stringify({x: coord.x, y: coord.y}));
                    const savedClipboard = clipboard.readText();
                    view.webContents.focus();
                    await new Promise(r => setTimeout(r, 50));
                    view.webContents.sendInputEvent({ type: 'mouseDown', x: coord.x, y: coord.y, button: 'left', clickCount: 1 });
                    await new Promise(r => setTimeout(r, 30));
                    view.webContents.sendInputEvent({ type: 'mouseUp', x: coord.x, y: coord.y, button: 'left', clickCount: 1 });
                    await new Promise(r => setTimeout(r, 400));
                    const markdown = clipboard.readText();
                    if (savedClipboard) clipboard.writeText(savedClipboard);
                    if (markdown) {
                        return { success: true, data: { markdown: markdown, images: [], source: 'clipboard' } };
                    }
                    console.log('[Qwen extract] clipboard empty, fallback DOM');
                    const fbJs2 = `(async function(){
                        return await window.__qwen.invoke('extractResponse', {});
                    })();`;
                    const fb2 = await execJs(fbJs2);
                    return { success: true, data: { markdown: (fb2 && fb2.markdown) || '', images: (fb2 && fb2.images) || [], source: 'dom-fallback' } };
                } catch (e) {
                    console.error('[Qwen extract] error:', e.message);
                    return { success: false, error: e.message };
                }
            }

            case 'detectResponseType': {
                const js = `(async function(){
                    if (!window.__qwen || !window.__qwen.detectResponseType) return {type:'text'};
                    return window.__qwen.detectResponseType();
                })();`;
                try {
                    const r = await execJs(js);
                    return { success: true, data: { type: (r && r.type) || 'text' } };
                } catch (e) {
                    return { success: true, data: { type: 'text' } };
                }
            }

            case 'waitForImageDone': {
                const timeout = args.timeout || 300000;
                const js = `(async function(){
                    if (!window.__qwen || !window.__qwen.waitForImageDone) return {success:false, error:'waitForImageDone missing'};
                    if (window.__qwen._navigating !== undefined) window.__qwen._navigating = true;
                    try {
                        return await window.__qwen.waitForImageDone(${timeout});
                    } finally {
                        if (window.__qwen._navigating !== undefined) window.__qwen._navigating = false;
                    }
                })();`;
                try {
                    const r = await execJs(js);
                    setQwenGenerating(false);
                    return { success: true, data: { done: !!(r && r.success) } };
                } catch (e) {
                    setQwenGenerating(false);
                    return { success: false, error: e.message };
                }
            }

            case 'extractImageResponse': {
                const js = `(async function(){
                    if (!window.__qwen || !window.__qwen.extractImageResponse) return {markdown:'', images:[]};
                    return window.__qwen.extractImageResponse();
                })();`;
                try {
                    const r = await execJs(js);
                    return { success: true, data: { markdown: (r && r.markdown) || '', images: (r && r.images) || [] } };
                } catch (e) {
                    console.error('[Qwen extractImage] error:', e.message);
                    return { success: false, error: e.message };
                }
            }

            case 'deleteConversation': {
                const js = `(async function(){
                    if (!window.__qwen || !window.__qwen.deleteConversation) return {success:false};
                    return await window.__qwen.deleteConversation();
                })();`;
                return await execJs(js);
            }

            case 'stopGeneration': {
                const js = `(function(){
                    if (!window.__qwen || !window.__qwen.stopGeneration) return {success:false};
                    return window.__qwen.stopGeneration();
                })();`;
                return await execJs(js);
            }

            case 'checkReady': {
                const js = `!!(window.__qwen && window.__qwen.ready && window.__qwen.sendMessage);`;
                return { success: true, data: { ready: !!await execJs(js) } };
            }

            case 'copyResponseToClipboard': {
                const js = `(async function(){
                    if (!window.__qwen || !window.__qwen.copyLastResponse) return {success:false};
                    return await window.__qwen.copyLastResponse();
                })();`;
                return await execJs(js);
            }

            case 'poll': {
                if (pollPaused) return { success: true, data: { paused: true } };
                const js = `(function(){
                    if (!window.__qwen) return null;
                    var stop = document.querySelector('button[aria-label*="停止"]');
                    return { generating: !!(stop && !stop.disabled) };
                })();`;
                try { return { success: true, data: await execJs(js) }; }
                catch (e) { return { success: false, error: e.message }; }
            }

            case 'interruptPoll': { pollPaused = true; return { success: true }; }
            case 'resumePoll': { pollPaused = false; return { success: true }; }

            default:
                return { success: false, error: 'Unknown op: ' + op };
        }
    }


    function startPoll(intervalMs) {
        if (pollTimer) clearInterval(pollTimer);
        pollTimer = setInterval(async () => {
            if (pollPaused || slots.active >= slots.max) return;
            try { await invoke(null, 'poll', {}); } catch (e) {}
        }, intervalMs || 5000);
    }
    function stopPoll() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }

    return {
        provider: 'qwen',
        models: MODELS,
        invoke,
        getQwenGenerating,  // timer 轮询读此缓存，避免 executeJavaScript 戳帧
        startPoll,
        stopPoll,
        getSlotStatus: () => ({ active: slots.active, max: slots.max, queued: slots.queue.length })
    };
}

module.exports = { createQwenServer };
