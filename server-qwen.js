// server-qwen.js — Qwen 网页版模型服务
// 运行在主进程，通过 executeJavaScript 调用 inject-qwen.js 暴露的 DOM 协议
// 对外提供统一 invoke(modelId, op, args) 协议
'use strict';

function appendQwenDelta(current, value) {
    const next = String(value || '');
    if (!next) return current;
    if (!current) return next;
    if (next.startsWith(current)) return next;
    if (current.endsWith(next)) return current;
    const max = Math.min(current.length, next.length);
    for (let overlap = max; overlap >= 8; overlap -= 1) {
        if (current.slice(-overlap) === next.slice(0, overlap)) return current + next.slice(overlap);
    }
    return current + next;
}

function parseQwenSse(text, transportDone) {
    const source = String(text || '');
    const payloads = [];
    for (const block of source.split(/\r?\n\r?\n/)) {
        const data = block.split(/\r?\n/)
            .filter((line) => /^data:\s*/i.test(line))
            .map((line) => line.replace(/^data:\s*/i, ''))
            .join('\n').trim();
        if (data) payloads.push(data);
        else if (/^\s*\{[\s\S]*\}\s*$/.test(block)) payloads.push(block.trim());
    }
    let stopped = false;
    let error = '';
	const responseIndexes = new Map();
	const candidatesById = new Map();
	const candidateFor = (id) => {
		const key = String(id || 'default');
		if (!candidatesById.has(key)) candidatesById.set(key, { id: key, content: '', reasoning: '', images: [] });
		return candidatesById.get(key);
	};
    for (const raw of payloads) {
        if (raw === '[DONE]') { stopped = true; continue; }
        let event;
        try { event = JSON.parse(raw); } catch (_) { continue; }
        if (event && event.success === false) {
            error = JSON.stringify(event).slice(0, 1000);
            continue;
        }
        if (event && event.error) {
            error = String(event.error.details || event.error.message || event.error).slice(0, 1000);
            continue;
        }
        if (event && event['response.stopped']) stopped = true;
		if (event && event['response.created']) {
			const created = event['response.created'];
			if (created.response_id != null) responseIndexes.set(String(created.response_id), Number(created.response_index));
		}
        const delta = event && event.choices && event.choices[0] && event.choices[0].delta || {};
		const candidate = candidateFor(event && event.response_id);
        const value = typeof delta.content === 'string' ? delta.content : '';
		if (delta.phase === 'answer' || (!delta.phase && delta.role === 'assistant')) candidate.content = appendQwenDelta(candidate.content, value);
		else if (['think', 'web_search'].includes(String(delta.phase || ''))) candidate.reasoning = appendQwenDelta(candidate.reasoning, value);
        const extra = delta.extra || {};
		if (delta.phase === 'thinking_summary') {
			const title = extra.summary_title && extra.summary_title.content;
			const thought = extra.summary_thought && extra.summary_thought.content;
			const summary = [...(Array.isArray(title) ? title : []), ...(Array.isArray(thought) ? thought : [])].filter(Boolean).join('\n');
			if (summary) candidate.reasoning = summary;
		}
        const candidates = extra.image_list || extra.tool_result || [];
        for (const item of Array.isArray(candidates) ? candidates : []) {
            const url = item && (item.image || item.url);
			if (url && !candidate.images.includes(String(url))) candidate.images.push(String(url));
        }
    }
	const choices = Array.from(candidatesById.values()).filter((item) => item.content || item.reasoning || item.images.length);
	choices.sort((a, b) => {
		const ai = responseIndexes.has(a.id) ? responseIndexes.get(a.id) : Number.MAX_SAFE_INTEGER;
		const bi = responseIndexes.has(b.id) ? responseIndexes.get(b.id) : Number.MAX_SAFE_INTEGER;
		return ai - bi;
	});
	const selected = choices[0] || { content: '', reasoning: '', images: [] };
	return { content: selected.content, reasoning: selected.reasoning, images: selected.images, error, done: stopped || !!transportDone };
}

function createQwenServer(qwenViewRef) {
    const getView = typeof qwenViewRef === 'function' ? qwenViewRef : () => qwenViewRef;

    // Qwen 生成状态缓存（由 sendMessage/waitForDone 更新，timer 轮询读此缓存避免戳帧）
    let _qwenGenerating = false;
	let _qwenRawCursor = { cdp: 0, page: 0 };
	let _qwenLastParsed = null;
    function getQwenGenerating() { return _qwenGenerating; }
    function setQwenGenerating(v) { _qwenGenerating = v; }

    // ===== 模型注册 =====
    // Keep qwen.default as a hidden compatibility alias. Concrete web models
    // are selected through the same picker shown at the top-left of Qianwen.
    const QWEN_CAPABILITIES = {
        inputMaxLen: 32768,
        file: {
            doc: { maxMB: 100, maxCount: 10, types: ['txt', 'pdf', 'docx', 'md', 'csv', 'xlsx', 'pptx', 'json', 'html', 'xml', 'yaml'] },
            image: { maxMB: 100, maxCount: 10, types: ['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp'] }
        },
        multimodal: { input: ['image', 'text'], output: ['text', 'image'] }
    };
    function webModel(id, displayName, webLabel, description, hidden) {
        return { id, provider: 'qwen', displayName, webLabel, description, hidden: !!hidden, capabilities: QWEN_CAPABILITIES };
    }
    const MODELS = {
        'qwen.image.web': webModel('qwen.image.web', 'Qianwen Image - Web', 'Qwen3.8-Max', '网页生图专用模型；返回生成图片 URL'),
		'qwen.text.web': webModel('qwen.text.web', 'Qwen Text - Page（兼容）', 'Qwen3.7-Plus', '页面文本模型兼容别名', true),
		'qwen.text.web.3.8-max': webModel('qwen.text.web.3.8-max', 'Qwen3.8-Max - Page', 'Qwen3.8-Max', '通过真实 chat.qwen.ai 页面发送并从原始 SSE 读取'),
		'qwen.text.web.3.7-plus': webModel('qwen.text.web.3.7-plus', 'Qwen3.7-Plus - Page', 'Qwen3.7-Plus', '通过真实 chat.qwen.ai 页面发送并从原始 SSE 读取'),
        'qwen.default': webModel('qwen.default', 'Qwen3.7 千问（兼容）', 'Qwen3.7-千问', '原 qwen.default 兼容别名', true),
        'qwen.3.7': webModel('qwen.3.7', 'Qwen3.7 千问', 'Qwen3.7-千问', '综合 AI 助手，适合工作、学习与生活问答'),
        'qwen.3.8-max': webModel('qwen.3.8-max', 'Qwen3.8 Max', 'Qwen3.8-Max', '最新 Max 旗舰模型，支持视觉理解'),
        'qwen.3.7-max': webModel('qwen.3.7-max', 'Qwen3.7 Max', 'Qwen3.7-Max', '擅长代码编写与复杂任务'),
        'qwen.3.6-flash': webModel('qwen.3.6-flash', 'Qwen3.6 Flash', 'Qwen3.6-Flash', '适用于简单任务，响应速度快')
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

	async function resetRawCapture() {
		const view = getView();
		_qwenLastParsed = null;
		_qwenRawCursor = view && typeof view.resetRawCompletionStreams === 'function'
			? await view.resetRawCompletionStreams()
			: { cdp: 0, page: 0 };
	}

	async function readRawCapture() {
		const view = getView();
		if (!view || typeof view.completionStreamAfter !== 'function') return null;
		const record = await view.completionStreamAfter(_qwenRawCursor);
		if (!record) return null;
		const parsed = parseQwenSse(record.text, record.done || record.logicalDone);
		if (record.error && !parsed.error) parsed.error = String(record.error);
		_qwenLastParsed = parsed;
		return parsed;
	}

    async function invoke(modelId, op, args) {
        args = args || {};
        const model = MODELS[modelId];
        if (!model) return { success: false, error: 'Unknown model: ' + modelId };

        // 能力校验
        if ((op === 'newChat' || op === 'sendMessage' || op === 'injectHistory' || op === 'uploadFiles') && args.files && args.files.length > 0) {
            const docCap = model.capabilities.file.doc;
            const imgCap = model.capabilities.file.image;
            let docCount = 0, imgCount = 0;
            for (const f of args.files) {
                const isImg = String(f.mime || '').toLowerCase().startsWith('image/')
                    || imgCap.types.indexOf((f.ext || '').toLowerCase()) >= 0;
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

            case 'setModelMode': {
                const selected = await execJs(`(async function(){
                    if (!window.__qwen || !window.__qwen.selectModel) return {success:false,error:'Qwen model selector is unavailable'};
                    return await window.__qwen.selectModel(${JSON.stringify(model.id)});
                })();`);
                return selected && selected.success
                    ? { success: true, data: selected }
                    : { success: false, error: selected && selected.error || 'Unable to select Qwen model' };
            }

			case 'setReasoningMode': {
				const selected = await execJs(`(async function(){
					if (!window.__qwen || !window.__qwen.selectReasoningMode) return {success:false,error:'Qwen reasoning selector is unavailable'};
					return await window.__qwen.selectReasoningMode(${JSON.stringify(args.reasoningEffort || 'none')});
				})();`);
				return selected && selected.success
					? { success: true, data: selected }
					: { success: false, error: (selected && selected.error || 'Unable to select Qwen reasoning mode') + (selected && selected.available && selected.available.length ? '; available=' + selected.available.join(' | ') : '') };
			}

            case 'newChat': {
                setQwenGenerating(false); // 新对话开始，旧生成结束
				await resetRawCapture();
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
                    window.__dsagent_qwenBaseline = '';
                    // 2. 等待编辑器就绪（编辑器存在即就绪，sendMessage 内部有 waitForEditorReady 兜底）
                    var ready = await new Promise(function(resolve){
                        var retry = 0;
                        function check(){
							var ed = document.querySelector('[contenteditable="true"][data-slate-editor="true"], textarea[placeholder], [contenteditable="true"][role="textbox"]');
                            if (ed) { resolve(true); return; }
                            if (++retry > 40) { resolve(false); return; }
                            setTimeout(check, 100);
                        }
                        setTimeout(check, 100);
                    });
                    // 3. Select the requested web model before the first turn.
                    // The page persists its last choice, so this must be asserted
                    // for every newly leased worker rather than inferred.
                    if (!window.__qwen.selectModel) return {success:false,error:'Qwen model selector is unavailable'};
                    var selectedModel = await window.__qwen.selectModel(${JSON.stringify(model.id)});
                    if (!selectedModel || !selectedModel.success) return selectedModel || {success:false,error:'Qwen model selection failed'};
					if (!window.__qwen.selectReasoningMode) return {success:false,error:'Qwen reasoning selector is unavailable'};
                    var selectedReasoning = await window.__qwen.selectReasoningMode(${JSON.stringify(args.reasoningEffort || 'none')});
					if (!selectedReasoning || !selectedReasoning.success) return selectedReasoning || {success:false,error:'Qwen reasoning selection failed'};
                    var _files = ${JSON.stringify(args.files || [])};
                    if (_files.length) {
                        if (!window.__qwen.uploadFiles) return {success:false,error:'Qwen file upload bridge is unavailable'};
                        var uploadResult = await window.__qwen.uploadFiles(_files);
                        if (!uploadResult || !uploadResult.success) return uploadResult || {success:false,error:'Qwen file upload failed'};
                    }
                    // 4. 合并发送 userText
                    var _ut = ${JSON.stringify(userText)};
                    if (ready && _ut && _ut.trim()) {
                        window.__dsagent_qwenLastUserText = _ut;
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
                const js = `(async function(){
                    if (!window.__qwen || !window.__qwen.uploadFiles) return {success:false,error:'Qwen file upload bridge is unavailable'};
                    return await window.__qwen.uploadFiles(${JSON.stringify(args.files || [])});
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
				await resetRawCapture();
                const js = `(async function(){
                    if (!window.__qwen || !window.__qwen.sendMessage) return {success:false, error:'inject not ready'};
                    window.__dsagent_qwenBaseline = window.__qwen.getLastResponseText ? window.__qwen.getLastResponseText() : '';
                    window.__dsagent_qwenLastUserText = ${JSON.stringify(args.text || '')};
                    var _files = ${JSON.stringify(args.files || [])};
                    if (_files.length) {
                        if (!window.__qwen.uploadFiles) return {success:false,error:'Qwen file upload bridge is unavailable'};
                        var uploadResult = await window.__qwen.uploadFiles(_files);
                        if (!uploadResult || !uploadResult.success) return uploadResult || {success:false,error:'Qwen file upload failed'};
                    }
                    return await window.__qwen.sendMessage(window.__dsagent_qwenLastUserText);
                })();`;
                return await execJs(js);
            }

            case 'peekResponse': {
				if (model.id.startsWith('qwen.text.web.')) {
					try {
						const parsed = await readRawCapture();
						return { success: true, data: parsed ? { text: parsed.content, reasoning: parsed.reasoning } : { text: '', reasoning: '' } };
					} catch (e) {
						return { success: false, error: e.message };
					}
				}
                const js = `(function(){
                    if (!window.__qwen || !window.__qwen.getLastResponseText) return {text:''};
                    var text = (window.__qwen.getLastResponseText() || '').trim();
                    if (!text || text === String(window.__dsagent_qwenBaseline || '')) return {text:''};
                    return {text:text};
                })();`;
                try {
                    const current = await execJs(js);
                    return { success: true, data: current || { text: '' } };
                } catch (e) {
                    return { success: false, error: e.message };
                }
            }

            case 'waitForDone': {
				if (model.id.startsWith('qwen.text.web.')) {
					const timeout = Math.max(1000, Number(args.timeout) || 180000);
					const initialActivityTimeout = Math.max(1000, Number(args.initialActivityTimeout) || 20000);
					const startedAt = Date.now();
					let sawStream = false;
					while (Date.now() - startedAt < timeout) {
						if (args.signal && args.signal.aborted) return { success: false, code: 'run_cancelled', error: 'Run cancelled' };
						const parsed = await readRawCapture();
						if (parsed) {
							sawStream = true;
							if (parsed.error) {
								const limited = /Baxia|FAIL_SYS_USER_VALIDATE|RGV587|ParallelLimited|RateLimited/i.test(parsed.error);
								return { success: false, code: limited ? 'provider_busy' : 'provider_request_failed', error: parsed.error, retryAfter: limited ? 30 : undefined };
							}
							if (parsed.done) {
								setQwenGenerating(false);
								if (!parsed.content.trim() && !parsed.reasoning.trim()) return { success: false, code: 'provider_sse_empty', error: 'Qianwen page SSE completed without content' };
								return { success: true, data: { done: true, reason: 'qwen-page-sse' } };
							}
						}
						if (!sawStream && Date.now() - startedAt > initialActivityTimeout) return { success: false, code: 'provider_send_unconfirmed', error: 'Qianwen page produced no completion SSE' };
						await new Promise((resolve) => setTimeout(resolve, 120));
					}
					return { success: false, code: 'provider_timeout', error: 'Qianwen page SSE timed out' };
				}
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
                        // 检测图片生成卡片。新版单图模式不再保证使用
                        // ai_generate_image_list，交给注入层的作用域解析器判断。
                        var imgCard = window.__qwen.getLastImageUrls && window.__qwen.getLastImageUrls().length > 0;
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
                    return { success: true, data: { stopped: true, done: !!(r.done), reason: r.reason || '', hasImages: !!r.hasImages } };
                } catch (e) {
                    setQwenGenerating(false);
                    console.error('[Qwen waitDone] execJs error:', e.message);
                    return { success: false, error: e.message };
                }
            }

            case 'extractResponse': {
				if (model.id.startsWith('qwen.text.web.')) {
					const parsed = await readRawCapture() || _qwenLastParsed;
					if (!parsed || !parsed.content.trim()) return { success: false, code: 'provider_sse_empty', error: 'Qianwen page SSE contained no final answer' };
					return { success: true, data: { markdown: parsed.content, think: parsed.reasoning, images: parsed.images, source: 'qwen-page-sse' } };
				}
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
                    const savedClipboard = await execJs(`window.electronAPI && window.electronAPI.clipboardSave ? window.electronAPI.clipboardSave() : null;`);
                    let markdown = '';
                    try {
                        view.webContents.focus();
                        await new Promise(r => setTimeout(r, 50));
                        view.webContents.sendInputEvent({ type: 'mouseDown', x: coord.x, y: coord.y, button: 'left', clickCount: 1 });
                        await new Promise(r => setTimeout(r, 30));
                        view.webContents.sendInputEvent({ type: 'mouseUp', x: coord.x, y: coord.y, button: 'left', clickCount: 1 });
                        await new Promise(r => setTimeout(r, 400));
                        markdown = await execJs(`window.electronAPI && window.electronAPI.clipboardReadText ? window.electronAPI.clipboardReadText() : '';`);
                        const copiedUserMessage = await execJs(`!!(window.__qwen && window.__qwen.isLastUserEcho && window.__qwen.isLastUserEcho(${JSON.stringify(markdown)}));`);
                        if (copiedUserMessage) markdown = '';
                    } finally {
                        if (savedClipboard) await execJs(`window.electronAPI && window.electronAPI.clipboardRestore ? window.electronAPI.clipboardRestore(${JSON.stringify(savedClipboard)}, ${JSON.stringify(markdown)}) : null;`).catch(() => {});
                    }
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

            case 'getConversationMetadata': {
                const result = await execJs(`(function(){
                    var here=(location.pathname||'').replace(/\\/$/,'');
                    var links=Array.from(document.querySelectorAll('a[href*="/chat/"]'));
                    var active=links.find(function(a){try{return new URL(a.href,location.href).pathname.replace(/\\/$/,'')===here;}catch(e){return false;}});
                    var title=active&&((active.querySelector('[class*="title"],[class*="font-500"],[class*="text-title"]')||active).textContent||'').trim();
                    return {title:(title||'').slice(0,120),url:location.href};
                })();`);
                return { success: true, data: { title: result && result.title || '', url: result && result.url || '' } };
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

module.exports = { createQwenServer, parseQwenSse, appendQwenDelta };
