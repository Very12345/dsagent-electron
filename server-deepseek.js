// server-deepseek.js — DeepSeek 网页版模型服务
// 运行在主进程，通过 executeJavaScript 调用 inject-deepseek.js 暴露的 DOM 协议
// 对外提供统一 invoke(modelId, op, args) 协议，供 Node ProviderManager 路由
'use strict';

const dirtyJson = require('dirty-json');
const { parseDsmlCalls, completeDsmlSuffix } = require('./src/runtime/deepseek-dsml');

const COMPLETION_POLL_MS = 100;
const NATIVE_IDLE_POLLS = 3;
const FALLBACK_STABLE_POLLS = 20;
const TOOL_STABLE_POLLS = 3;
const COPY_QUIET_MS = 300;

function applyDeepseekPatch(response, pathValue, operation, value) {
    const parts = String(pathValue || '').split('/').filter(Boolean);
    if (parts[0] === 'response') parts.shift();
    if (!parts.length) return response;
    let target = response;
    for (let index = 0; index < parts.length - 1; index += 1) {
        let key = parts[index];
        if (key === '-1' && Array.isArray(target)) key = target.length - 1;
        else if (/^\d+$/.test(key) && Array.isArray(target)) key = Number(key);
        if (target[key] == null) target[key] = /^\d+$|^-1$/.test(parts[index + 1]) ? [] : {};
        target = target[key];
    }
    let key = parts[parts.length - 1];
    if (key === '-1' && Array.isArray(target)) key = target.length - 1;
    else if (/^\d+$/.test(key) && Array.isArray(target)) key = Number(key);
    if (operation === 'APPEND') {
        if (Array.isArray(target[key])) {
            if (Array.isArray(value)) target[key].push(...value); else target[key].push(value);
        } else target[key] = String(target[key] == null ? '' : target[key]) + String(value == null ? '' : value);
    } else target[key] = value;
    return response;
}

function parseDeepseekRawSse(raw) {
    let response = null;
    let lastPath = '';
    let lastOperation = 'APPEND';
    let closed = false;
    const blocks = String(raw || '').replace(/\r\n?/g, '\n').split(/\n\n+/);
    function patch(value, prefix, defaultOperation) {
        if (!value || typeof value !== 'object') return;
        const path = [prefix, value.p].filter(Boolean).join('/');
        if (value.o === 'BATCH' && Array.isArray(value.v)) {
            value.v.forEach((item) => patch(item, path, 'SET'));
            return;
        }
        if (!response || !path) return;
        // DeepSeek omits `o` for ordinary token deltas. In that form the
        // operation is APPEND, not SET; treating it as SET leaves only the
        // final punctuation of a response fragment.
        const operation = value.o || defaultOperation || 'APPEND';
        applyDeepseekPatch(response, path, operation, value.v);
        lastPath = path;
        lastOperation = operation;
    }
    for (const block of blocks) {
        const lines = block.split('\n');
        const event = lines.filter((line) => line.startsWith('event:')).map((line) => line.slice(6).trim()).slice(-1)[0] || '';
        if (event === 'close') closed = true;
        const data = lines.filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).join('\n');
        if (!data) continue;
        let payload = null;
        try { payload = JSON.parse(data); } catch (_) { continue; }
        if (payload && payload.v && payload.v.response) {
            response = JSON.parse(JSON.stringify(payload.v.response));
            continue;
        }
        if (payload && payload.p) patch(payload, '', 'APPEND');
        else if (response && lastPath && payload && Object.prototype.hasOwnProperty.call(payload, 'v')) {
            applyDeepseekPatch(response, lastPath, lastOperation, payload.v);
        }
    }
    const fragments = response && Array.isArray(response.fragments) ? response.fragments : [];
    const reasoning = fragments.filter((fragment) => /THINK|REASON/i.test(String(fragment && fragment.type || ''))).map((fragment) => String(fragment.content || '')).join('');
    const markdown = fragments.filter((fragment) => !/THINK|REASON|SEARCH/i.test(String(fragment && fragment.type || ''))).map((fragment) => String(fragment.content || '')).join('');
    const status = String(response && (response.status || response.quasi_status) || '');
    return { markdown, reasoning, status, finished: closed || /FINISHED|COMPLETE|DONE/i.test(status), response };
}

function parseDshToolCall(raw) {
    try {
        return JSON.parse(raw);
    } catch (_) {
        // Web models occasionally omit escaping for quotes inside a tool
        // argument string. Repair syntax only; callers still validate the
        // normalized object and the Runtime validates it against the tool
        // manifest before execution.
        try { return dirtyJson.parse(raw); } catch (_) { return null; }
    }
}

function normalizeDshToolCall(call) {
    if (!call || typeof call !== 'object' || Array.isArray(call)) return null;
    const name = String(call.name || call.tool || '').trim();
    if (!name) return null;
    let args = call.arguments !== undefined ? call.arguments : call.params;
    if (args === undefined) {
        args = {};
        for (const [key, value] of Object.entries(call)) {
            if (!['name', 'tool', 'arguments', 'params', 'type', 'id'].includes(key)) args[key] = value;
        }
    }
    if (!args || typeof args !== 'object' || Array.isArray(args)) return null;
    return { name, arguments: args };
}

// DeepSeek occasionally emits a Harness tool envelope at the very end of its
// reasoning card and leaves the normal answer card empty. Only accept a
// contiguous suffix of complete, valid DSH envelopes. This preserves the
// reasoning/body boundary while still allowing Harness to execute the call.
function extractDshToolCallsFromReasoning(text) {
    const source = String(text || '').trim();
    if (!source) return '';
    const dsmlCalls = completeDsmlSuffix(source);
    if (dsmlCalls.length) return dsmlCalls.map((call) => '<dsh_tool_call>' + JSON.stringify({ name: call.name, arguments: call.arguments }) + '</dsh_tool_call>').join('\n');
    const matches = Array.from(source.matchAll(/<dsh[-_]tool[-_]call>\s*([\s\S]*?)\s*<\/dsh[-_]tool[-_]call>/gi));
    if (!matches.length) return '';
    const accepted = [];
    let boundary = source.length;
    for (let index = matches.length - 1; index >= 0; index -= 1) {
        const match = matches[index];
        const end = match.index + match[0].length;
        if (source.slice(end, boundary).trim()) break;
        const call = normalizeDshToolCall(parseDshToolCall(match[1]));
        if (!call) break;
        accepted.unshift('<dsh_tool_call>' + JSON.stringify(call) + '</dsh_tool_call>');
        boundary = match.index;
    }
    return accepted.join('\n');
}

// Detect complete Harness calls in the normal answer channel.  This is used
// only as a completion signal; the Runtime bridge remains responsible for
// parsing, schema validation and execution.
function extractDshToolCallsFromText(text) {
    const source = String(text || '');
    if (!source.trim()) return '';
    const payloads = [];
    for (const call of parseDsmlCalls(source)) payloads.push(JSON.stringify({ name: call.name, arguments: call.arguments }));
    for (const match of source.matchAll(/<dsh[-_]tool[-_]call>\s*([\s\S]*?)\s*<\/dsh[-_]tool[-_]call>/gi)) payloads.push(match[1]);
    for (const match of source.matchAll(/(?:^|\n)(`{3,}|~{3,})dsh[-_]tool[-_]call[^\n]*\n([\s\S]*?)\n\1(?=\n|$)/gi)) payloads.push(match[2]);
    const accepted = [];
    for (const payload of payloads) {
        const call = normalizeDshToolCall(parseDshToolCall(payload));
        if (!call) continue;
        accepted.push(JSON.stringify(call));
    }
    return accepted.join('\n');
}

function structurallyClosedJson(raw) {
    const source = String(raw || '').trim();
    const stack = [];
    let quoted = false;
    let escaped = false;
    let sawContainer = false;
    for (const character of source) {
        if (escaped) { escaped = false; continue; }
        if (quoted && character === '\\') { escaped = true; continue; }
        if (character === '"') { quoted = !quoted; continue; }
        if (quoted) continue;
        if (character === '{' || character === '[') { stack.push(character); sawContainer = true; continue; }
        if (character === '}' || character === ']') {
            const expected = character === '}' ? '{' : '[';
            if (stack.pop() !== expected) return false;
        }
    }
    return sawContainer && !quoted && !escaped && stack.length === 0;
}

function hasIncompleteDshToolEnvelope(text) {
    const source = String(text || '');
    const fenceMarkers = source.match(/(?:```|~~~)dsh[-_]tool[-_]call/gi) || [];
    const fencedPayloads = Array.from(source.matchAll(/(?:^|\n)(`{3,}|~{3,})dsh[-_]tool[-_]call[^\n]*\n([\s\S]*?)\n\1(?=\n|$)/gi)).map((match) => match[2]);
    if (fencedPayloads.length < fenceMarkers.length || fencedPayloads.some((payload) => !structurallyClosedJson(payload))) return true;
    const xmlOpen = source.match(/<dsh[-_]tool[-_]call>/gi) || [];
    const xmlClosed = Array.from(source.matchAll(/<dsh[-_]tool[-_]call>\s*([\s\S]*?)\s*<\/dsh[-_]tool[-_]call>/gi));
    if (xmlClosed.length < xmlOpen.length || xmlClosed.some((match) => !structurallyClosedJson(match[1]))) return true;
    const hasDsmlMarker = /(?:[|｜]\s*){1,3}DSML\s*(?:[|｜]\s*){1,3}(?:tool_calls|function_calls|calls|invoke)|<dsml_(?:tool_calls?|function_calls?|calls|invoke)\b/i.test(source);
    if (hasDsmlMarker && !parseDsmlCalls(source).length) return true;
    return false;
}

function isStableDeepseekCompletion(snapshot, contentSeen, stablePolls, quietForMs) {
    // DeepSeek mounts the assistant action toolbar (including Copy) before the
    // final Markdown/code block has necessarily finished streaming.  Treating
    // the new button alone as completion truncates JSON tool envelopes.
    if (!snapshot || !contentSeen || snapshot.domGenerating) return false;
    const text = String(snapshot.text || '');
    const hasToolMarker = /(?:```|~~~)dsh[-_]tool[-_]call|<dsh[-_]tool[-_]call>|<｜DSML｜/i.test(text);
    if (hasIncompleteDshToolEnvelope(text)) return false;
    if (hasToolMarker && !extractDshToolCallsFromText(text)) return false;
    // Use the toolbar as a low-latency hint only after the actual answer DOM
    // has been quiet briefly. This is a time-based debounce, not a fixed delay.
    return !!((snapshot.newCopyButton && stablePolls >= 1 && Number(quietForMs) >= COPY_QUIET_MS)
        || stablePolls >= FALLBACK_STABLE_POLLS);
}

// DeepSeek 服务单例：绑定到一个 BrowserView（main.js 中的 mainWindow/DeepSeek 页面）
function createDeepseekServer(deepseekViewRef) {
    // deepseekViewRef: 一个函数/对象，返回当前可用的 DeepSeek BrowserView
    const getView = typeof deepseekViewRef === 'function' ? deepseekViewRef : () => deepseekViewRef;

    // ===== 模型注册 =====
    // DeepSeek 网页版已合并为一个模型；思考、搜索和图片是独立能力。
    const MODELS = {
        'deepseek.web': {
            id: 'deepseek.web',
            provider: 'deepseek',
            displayName: 'DeepSeek Web',
            mode: 'unified',
            capabilities: {
                inputMaxLen: 1000000,
                file: { maxMB: 50, maxCount: 10, types: ['txt', 'pdf', 'docx', 'md', 'csv', 'xlsx', 'pptx', 'json', 'html', 'xml', 'yaml', 'png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp'] },
                multimodal: { input: ['image'], output: ['text'] },
                deepThink: true,
                webSearch: true,
                reasoningEfforts: ['none', 'high']
            }
        }
    };
    const MODEL_ALIASES = {
        'deepseek.fast': 'deepseek.web',
        'deepseek.expert': 'deepseek.web',
        'deepseek.image': 'deepseek.web',
        'deepseek.flash.web': 'deepseek.web',
        'deepseek.pro.web': 'deepseek.web',
        'deepseek.vision.web': 'deepseek.web'
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
    let rawResponseCursor = { host: 0, stream: 0 };

    async function resetRawResponseCursor() {
        const view = getView();
        rawResponseCursor = {
            host: view && typeof view.rawResponseCursor === 'function' ? view.rawResponseCursor() : 0,
            stream: view && typeof view.resetRawCompletionStreams === 'function'
                ? await view.resetRawCompletionStreams()
                : view && typeof view.rawStreamCursor === 'function' ? await view.rawStreamCursor() : 0
        };
    }

    async function currentRawResponse() {
        const view = getView();
        if (!view) return null;
        if (typeof view.completionStreamAfter === 'function') {
            const streamed = await view.completionStreamAfter(rawResponseCursor.stream);
            if (streamed && streamed.text) {
                const parsed = parseDeepseekRawSse(streamed.text);
                return Object.assign({ pending: !streamed.done && !streamed.logicalDone }, parsed);
            }
            if (streamed) return { pending: !streamed.done, finished: false, error: streamed.error || '' };
        }
        if (typeof view.completionResponseAfter !== 'function') return null;
        const record = view.completionResponseAfter(rawResponseCursor.host);
        if (!record) return null;
        if (!record.done) return { pending: true, finished: false };
        if (!record.text) return { pending: false, finished: false, error: record.error || '' };
        return Object.assign({ pending: false }, parseDeepseekRawSse(record.text));
    }

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
        const model = MODELS[MODEL_ALIASES[modelId] || modelId];
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
                    window.__dsagent_assistantBaseline = {count:0, text:'', reasoning:'', copyCount:0};
                        var r = await window.__dsagent_newChatAndSendInit(${JSON.stringify(model.mode)}, ${!!args.deepThink}, ${JSON.stringify(args.userText || '')}, ${!!args.webSearch}, ${JSON.stringify(args.files || [])});
                        return r;
                    })();`;
                    const r = await execJs(js);
                    if (r && r.success) { newChatResult = r; break; }
                    if (r && (r.code === 'out_of_usage' || r.code === 'provider_busy' || r.rateLimited)) {
                        return { success: false, code: r.code || 'out_of_usage', error: r.error || 'DeepSeek webpage rate limit reached', retryAfter: r.retryAfter || 60 };
                    }
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
                // 先检查当前 URL 是否已是目标 URL，避免不必要的页面重载打断 AI 生成
                // 如果目标 URL 为空，跳过导航（防止缓存空 URL 导致页面不断重载）
                if (!args.url) {
                    return { success: true };
                }
                const curUrl = await execJs(`window.location.href;`);
                // 规范化比较：去掉尾部斜杠和查询参数，避免 DeepSeek 页面 URL 细微差异导致不断重载
                var normalizeUrl = function(u) {
                    if (!u) return '';
                    return u.replace(/\/+$/, '').split('?')[0].split('#')[0];
                };
                if (curUrl && normalizeUrl(curUrl) === normalizeUrl(args.url)) {
                    // URL 未变，无需导航（AI 生成不会被中断）
                    return { success: true };
                }
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
                await resetRawResponseCursor();
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
                    var bodies = document.querySelectorAll('.ds-markdown.ds-assistant-message-main-content, [class*="assistant-message-main-content"]');
                    window.__dsagent_assistantBaseline = {
                        count: bodies.length,
                        text: window.__dsagent_extractCurrentAnswerMarkdown ? window.__dsagent_extractCurrentAnswerMarkdown(true) : '',
                        reasoning: window.__dsagent_extractCurrentThinking ? window.__dsagent_extractCurrentThinking() : '',
                        copyCount: window.__dsagent_getAssistantCopyButtonCount ? window.__dsagent_getAssistantCopyButtonCount() : 0
                    };
                    var r = await window.__dsagent_sendMessage(${JSON.stringify(args.text || '')}, ${!!args.promptPassthrough});
                    // 检测频率限制/服务器繁忙
                    if (r && (typeof r === 'object') && (r.code === 'out_of_usage' || r.code === 'provider_busy' || r.rateLimited || (r.error && (String(r.error).indexOf('429') >= 0)))) {
                        return {success:false, code:r.code || 'out_of_usage', error:r.error || 'DeepSeek webpage rate limit reached', rateLimited:r.code !== 'provider_busy', retryAfter: (r.retryAfter || 60)};
                    }
                    return r && typeof r === 'object' ? r : {success:true};
                })();`;
                const r = await execJs(js);
                if (r && (r.rateLimited || r.code === 'out_of_usage' || r.code === 'provider_busy')) {
                    return { success: false, code: r.code || 'out_of_usage', error: r.error || 'DeepSeek webpage rate limit reached', retryAfter: r.retryAfter || 60 };
                }
                // 确保返回对象（inject 脚本可能返回原始值 true）
                return r && typeof r === 'object' ? r : { success: true };
            }

            case 'waitForDone': {
                const timeout = args.timeout || 120000;
                const outcome = await waitForDoneInternal(timeout, {
                    allowReasoningToolCall: !!args.allowReasoningToolCall,
                    signal: args.signal,
                    initialActivityTimeout: args.initialActivityTimeout
                });
                if (!outcome.done) {
                    const code = outcome.code || (outcome.reason === 'cancelled'
                        ? 'run_cancelled'
                        : outcome.reason === 'timeout' ? 'provider_timeout'
                        : outcome.reason === 'initial_response_timeout' ? 'provider_send_unconfirmed'
                        : 'provider_incomplete');
                    const message = code === 'out_of_usage'
                        ? 'DeepSeek webpage is rate limited (out of usage); retry after ' + String(outcome.retryAfter || 60) + ' seconds'
                        : code === 'provider_busy'
                          ? 'DeepSeek webpage is temporarily busy; retry after ' + String(outcome.retryAfter || 30) + ' seconds'
                          : 'DeepSeek response incomplete: ' + outcome.reason;
                    return { success: false, error: message, code, retryAfter: outcome.retryAfter, data: outcome };
                }
                return { success: true, data: outcome };
            }

            case 'peekResponse': {
                // A short, non-blocking DOM read used by the unified Runtime to
                // forward text while the page is still generating.
                const js = `(function(){
                    var baseline = window.__dsagent_assistantBaseline || {count:0,text:'',reasoning:'',copyCount:0};
                    var bodies = document.querySelectorAll('.ds-markdown.ds-assistant-message-main-content, [class*="assistant-message-main-content"]');
                    var text = window.__dsagent_extractCurrentAnswerMarkdown ? window.__dsagent_extractCurrentAnswerMarkdown(true) : '';
                    var reasoning = window.__dsagent_extractCurrentThinking ? window.__dsagent_extractCurrentThinking() : '';
                    var injectedGenerating = window.__dsagent_isGenerating ? !!window.__dsagent_isGenerating() : false;
                    var usageLimit = window.__dsagent_getUsageLimitState ? window.__dsagent_getUsageLimitState() : {limited:false};
                    if (text === String(baseline.text || '')) text = '';
                    if (reasoning === String(baseline.reasoning || '')) reasoning = '';
                    return {text:text, reasoning:reasoning};
                })();`;
                try {
                    const current = await execJs(js);
                    return { success: true, data: current || { text: '', reasoning: '' } };
                } catch (e) {
                    return { success: false, error: e.message };
                }
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

            case 'checkDone': {
                // 非阻塞单次检查：供 api-server 调度器交错轮询使用
                // 返回 { done: true/false, hasImages: false, _wasGenerating: bool }
                // 通过调度器传入的 _wasGenerating 状态跟踪 AI 是否曾进入生成态，
                // 避免"按钮 disabled = 输入框为空"被误判为"AI 已完成"
                // 注意：不依赖 SVG path 判断，因为 DeepSeek 可能改 UI 导致 path 失效
                try {
                    // 1. 检查 inject 是否就绪，等待页面加载（最多 5 秒）
                    //    防止页面重载时调度器在两个 URL 间无限轮切
                    var readyTimeout = Date.now() + 5000;
                    var ready = false;
                    while (Date.now() < readyTimeout) {
                        const readyJs = `!!(window.__dsagent_injected && window.__dsagent_sendMessage);`;
                        ready = await execJs(readyJs);
                        if (ready) break;
                        await new Promise(function(r) { setTimeout(r, 200); });
                    }
                    if (!ready) {
                        // 页面加载超时，返回 done=true 让调度器移除条目，避免循环卡死
                        return { success: true, data: { done: true, hasImages: false, _wasGenerating: false } };
                    }
                    // 2. 检查发送/停止按钮状态
                    //    按钮可用 + 停止图标 → 生成中
                    //    按钮可用 + 发送图标 → 空闲
                    //    按钮禁用 + loading 动画 → 正在发送（AI 还没开始）
                    //    按钮禁用 + 无 loading → 未开始/已结束（靠 _wasGenerating 区分）
                    const btnJs = `(function(){
                        var b = document.querySelector('div.ds-button--primary.ds-button--filled.ds-button--circle');
                        if (!b) return null;
                        var sp = b.querySelector('svg path');
                        var d = sp ? (sp.getAttribute('d')||'') : '';
                        var isStop = d.indexOf('M2 4.88') >= 0;
                        var dis = b.classList.contains('ds-button--disabled') || b.disabled;
                        // 检查是否有 loading spinner（发送中状态，不是完成）
                        var isLoading = !!b.querySelector('.ds-loading');
                        // 也检查是否有 AI 回复消息在 DOM 中（辅助判断）
                        var hasAiMsg = !!document.querySelector('.ds-message .ds-markdown, .ds-markdown.ds-assistant-message-main-content');
                        return { isStop: isStop, disabled: dis, isLoading: isLoading, hasAiMsg: hasAiMsg };
                    })();`;
                    const btnState = await execJs(btnJs);
                    // 按钮不存在 → 状态未知，继续轮询
                    if (!btnState) {
                        return { success: true, data: { done: false, hasImages: false, _wasGenerating: !!args._wasGenerating } };
                    }
                    const wasGenerating = !!args._wasGenerating;
                    // 停止图标 → AI 正在生成
                    if (btnState.isStop) {
                        return { success: true, data: { done: false, hasImages: false, _wasGenerating: true } };
                    }
                    // 非停止图标 + 按钮可用 → 空闲（有 AI 回复则已完成）
                    if (!btnState.disabled) {
                        // hasAiMsg=true 且按钮可用（非停止图标）= AI 已生成完毕，按钮恢复可用
                        var idleDone = !!btnState.hasAiMsg;
                        return { success: true, data: { done: idleDone, hasImages: false, _wasGenerating: false } };
                    }
                    // 按钮禁用 + loading 动画 → 正在发送，AI 还没开始
                    if (btnState.isLoading) {
                        return { success: true, data: { done: false, hasImages: false, _wasGenerating: false } };
                    }
                    // 非停止图标 + 按钮禁用（无 loading）：
                    //   以前生成过 → AI 已完成
                    //   没生成过 → 尚未开始（输入框为空），继续等
                    if (wasGenerating) {
                        return { success: true, data: { done: true, hasImages: false, _wasGenerating: true } };
                    }
                    return { success: true, data: { done: false, hasImages: false, _wasGenerating: false } };
                } catch (e) {
                    return { success: true, data: { done: false, hasImages: false, _wasGenerating: !!args._wasGenerating } };
                }
            }

            case 'extractResponse': {
                // The DeepSeek SSE is the only lossless source. Its raw chunks
                // preserve PowerShell variables and protocol markup before the
                // page's Markdown/KaTeX/link renderer mutates the visible DOM.
                for (let rawAttempt = 0; rawAttempt < 8; rawAttempt += 1) {
                    const raw = await currentRawResponse();
                    if (raw && raw.finished && (raw.markdown || raw.reasoning)) {
                        return { success: true, data: { markdown: raw.markdown || '', think: raw.reasoning || '', answerConfirmed: !!String(raw.markdown || '').trim(), rawTransport: true } };
                    }
                    await new Promise((resolve) => setTimeout(resolve, 50));
                }
                // 提取最后一条 AI 回复 + 深度思考内容
                // 使用重试轮询：AI 生成完成后 DOM 可能延迟几十到几百毫秒才渲染完成
                const extractTimeout = args.timeout || 15000;
                const allowReasoningToolCall = !!args.allowReasoningToolCall;
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
                    const reasoningToolCall = allowReasoningToolCall ? extractDshToolCallsFromReasoning(r.think) : '';
                    if (reasoningToolCall) {
                        r.markdown = reasoningToolCall;
                        r.answerConfirmed = true;
                        r.reasoningToolCall = true;
                    }
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
                    const reasoningToolCall = allowReasoningToolCall ? extractDshToolCallsFromReasoning(extractResult.think) : '';
                    if (reasoningToolCall) {
                        extractResult.markdown = reasoningToolCall;
                        extractResult.answerConfirmed = true;
                        extractResult.reasoningToolCall = true;
                    }
                }
                return { success: true, data: { markdown: extractResult.markdown || '', think: extractResult.think || '', answerConfirmed: extractResult.answerConfirmed !== false && !!String(extractResult.markdown || '').trim(), reasoningToolCall: !!extractResult.reasoningToolCall } };
            }

            case 'getConversationMetadata': {
                const js = `(function(){
                    var here=(location.pathname||'').replace(/\\/$/,'');
                    var links=Array.from(document.querySelectorAll('a[href*="/chat/"]'));
                    var active=links.find(function(a){try{return new URL(a.href,location.href).pathname.replace(/\\/$/,'')===here;}catch(e){return false;}});
                    var title=active&&((active.querySelector('[class*="title"],[class*="name"]')||active).textContent||'').trim();
                    return {success:true,title:title.slice(0,120),url:location.href};
                })();`;
                const result = await execJs(js);
                return { success: true, data: { title: result && result.title || '', url: result && result.url || '' } };
            }

            case 'listConversations': {
                const rows = await execJs(`(function(){
                    if (window.__dsagent_listConversations) return window.__dsagent_listConversations();
                    return Array.from(document.querySelectorAll('a[href*="/chat/"]')).map(function(a){return {title:(a.textContent||'').trim(),href:a.href};});
                })();`);
                return { success: true, data: (Array.isArray(rows) ? rows : []).map(function(row) {
                    var href = row && (row.url || row.href) || '';
                    try { href = new URL(href, 'https://chat.deepseek.com').href; } catch (_) {}
                    return { title: row && row.title || '', url: href };
                }) };
            }

            case 'deleteConversation': {
                var deleteTarget = args.convid || args._conversationUrl || null;
                if (deleteTarget) {
                    try { deleteTarget = new URL(deleteTarget).pathname.split('/').filter(Boolean).pop(); }
                    catch (_) { deleteTarget = String(deleteTarget).split('/').filter(Boolean).pop(); }
                }
                const js = `(async function(){
                    if (!window.__dsagent_deleteConversation) return {success:false};
                    return await window.__dsagent_deleteConversation(${deleteTarget ? JSON.stringify(deleteTarget) : 'null'});
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
    async function waitForDoneInternal(timeout, options) {
        options = options || {};
        const start = Date.now();
        const initialActivityTimeout = Math.max(5000, Number(options.initialActivityTimeout) || 20000);
        let wasGenerating = false;
        let contentSeen = false;
        let lastSignature = '';
        let stablePolls = 0;
        let missingButtonPolls = 0;
        let continuations = 0;
        let reasoningToolSignature = '';
        let reasoningToolStablePolls = 0;
        let reasoningSignature = '';
        let reasoningStablePolls = 0;
        let bodyToolSignature = '';
        let bodyToolStablePolls = 0;
        let nativeIdlePolls = 0;
        let activitySignature = '';
        let lastActivityAt = Date.now();
        let consecutivePollErrors = 0;
        while (Date.now() - start < timeout) {
            if (options.signal && options.signal.aborted) return { done: false, reason: 'cancelled', continuations };
            try {
                const raw = await currentRawResponse();
                if (raw && raw.finished) return { done: true, reason: 'raw_network_finished', continuations, rawTransport: true };
                const rawPending = !!(raw && raw.pending);
                const js = `(function(){
                    var baseline = window.__dsagent_assistantBaseline || {count:0,text:'',reasoning:''};
                    var bodies = document.querySelectorAll('.ds-markdown.ds-assistant-message-main-content, [class*="assistant-message-main-content"]');
                    var lastText = window.__dsagent_extractCurrentAnswerMarkdown ? window.__dsagent_extractCurrentAnswerMarkdown(true) : '';
                    var reasoning = window.__dsagent_extractCurrentThinking ? window.__dsagent_extractCurrentThinking() : '';
                    var controls = Array.from(document.querySelectorAll('button, [role="button"]'));
                    var stopControl = controls.some(function(control) {
                        var label = [control.getAttribute('aria-label'), control.getAttribute('title'), control.getAttribute('data-testid'), control.textContent].filter(Boolean).join(' ');
                        return /(?:stop|cancel|\u505c\u6b62|\u4e2d\u6b62).*(?:generat|respond|\u751f\u6210|\u56de\u7b54)|^(?:stop|\u505c\u6b62)$/i.test(label.trim());
                    });
                    var continueControl = controls.some(function(control) {
                        return /(?:continue generating|continue response|\u7ee7\u7eed\u751f\u6210|\u7ee7\u7eed\u56de\u7b54)/i.test(String(control.textContent || control.getAttribute('aria-label') || '').trim());
                    });
                    var injectedGenerating = window.__dsagent_isGenerating ? !!window.__dsagent_isGenerating() : false;
                    var usageLimit = window.__dsagent_getUsageLimitState ? window.__dsagent_getUsageLimitState() : {limited:false};
                    var b = document.querySelector('div.ds-button--primary.ds-button--filled.ds-button--circle');
                    var copyCount = window.__dsagent_getAssistantCopyButtonCount ? window.__dsagent_getAssistantCopyButtonCount() : 0;
                    var newCopyButton = copyCount > Number(baseline.copyCount || 0);
                    if (!b) return {state:stopControl || injectedGenerating ? 'generating' : 'nobtn', domGenerating:stopControl, injectedGenerating:injectedGenerating, canContinue:continueControl, count:bodies.length, text:lastText, reasoning:reasoning, copyCount:copyCount, newCopyButton:newCopyButton, usageLimit:usageLimit, baseline:baseline};
                    var dis = b.classList.contains('ds-button--disabled') || b.disabled;
                    var loading = !!b.querySelector('.ds-loading');
                    var sp = b.querySelector('svg path');
                    var d = sp ? (sp.getAttribute('d') || '') : '';
                    var stopped = d.indexOf('M2 4.88') >= 0;
                    if (!dis) {
                        return {state:stopped || stopControl || injectedGenerating ? 'generating' : 'idle', domGenerating:stopped || stopControl || loading, injectedGenerating:injectedGenerating, canContinue:continueControl, count:bodies.length, text:lastText, reasoning:reasoning, copyCount:copyCount, newCopyButton:newCopyButton, usageLimit:usageLimit, baseline:baseline};
                    }
                    return {state:loading || stopControl || injectedGenerating ? 'generating' : 'disabled', domGenerating:loading || stopControl || stopped, injectedGenerating:injectedGenerating, canContinue:continueControl, count:bodies.length, text:lastText, reasoning:reasoning, copyCount:copyCount, newCopyButton:newCopyButton, usageLimit:usageLimit, baseline:baseline};
                })();`;
                const snapshot = await execJs(js);
                consecutivePollErrors = 0;
                if (snapshot && snapshot.usageLimit && snapshot.usageLimit.limited) {
                    return { done: false, reason: snapshot.usageLimit.reason || 'rate_limited', code: snapshot.usageLimit.code || 'out_of_usage', retryAfter: snapshot.usageLimit.retryAfter || 60, continuations };
                }
                const state = snapshot && snapshot.state;
                const nextActivitySignature = snapshot
                    ? String(snapshot.text || '') + '\u0000' + String(snapshot.reasoning || '')
                    : '';
                if (nextActivitySignature !== activitySignature) {
                    activitySignature = nextActivitySignature;
                    lastActivityAt = Date.now();
                }
                const baseline = snapshot && snapshot.baseline || { count: 0, text: '', reasoning: '' };
                // A count-only change is not sufficient: DeepSeek can remount or
                // duplicate the previous assistant node while accepting the next
                // user message. Wait until the last assistant content itself moves
                // past the captured baseline, otherwise extraction lags one turn.
                const textChanged = snapshot && snapshot.text && snapshot.text !== String(baseline.text || '');
                if (textChanged) {
                    contentSeen = true;
                    // DeepSeek reasoning can keep extending while the body
                    // card remains unchanged. Include both channels so a stable
                    // provisional body never ends the stream early.
                    const signature = snapshot.count + ':' + snapshot.text + ':' + String(snapshot.reasoning || '');
                    stablePolls = signature === lastSignature ? stablePolls + 1 : 0;
                    lastSignature = signature;
                }
                nativeIdlePolls = snapshot && contentSeen && !snapshot.domGenerating
                    ? nativeIdlePolls + 1
                    : 0;
                const reasoningToolCall = options.allowReasoningToolCall && snapshot
                    ? extractDshToolCallsFromReasoning(snapshot.reasoning)
                    : '';
                const bodyToolCall = options.allowReasoningToolCall && snapshot
                    ? extractDshToolCallsFromText(snapshot.text)
                    : '';
                const incompleteBodyToolCall = snapshot
                    ? hasIncompleteDshToolEnvelope(snapshot.text)
                    : false;
                const rawReasoning = String(snapshot && snapshot.reasoning || '');
                // An old completed Think card may remain mounted while the next
                // turn is idle. It is not activity unless it differs from the
                // baseline captured immediately before sending.
                const currentReasoning = rawReasoning && rawReasoning !== String(baseline.reasoning || '') ? rawReasoning : '';
                const acceptedActivity = state === 'generating' || contentSeen || !!currentReasoning;
                if (!acceptedActivity && Date.now() - start >= initialActivityTimeout) {
                    return { done: false, reason: 'initial_response_timeout', continuations };
                }
                if (currentReasoning) {
                    reasoningStablePolls = currentReasoning === reasoningSignature ? reasoningStablePolls + 1 : 0;
                    reasoningSignature = currentReasoning;
                } else {
                    reasoningStablePolls = 0;
                    reasoningSignature = '';
                }
                if (reasoningToolCall) {
                    reasoningToolStablePolls = reasoningToolCall === reasoningToolSignature ? reasoningToolStablePolls + 1 : 0;
                    reasoningToolSignature = reasoningToolCall;
                } else {
                    reasoningToolStablePolls = 0;
                    reasoningToolSignature = '';
                }
                if (bodyToolCall) {
                    bodyToolStablePolls = bodyToolCall === bodyToolSignature ? bodyToolStablePolls + 1 : 0;
                    bodyToolSignature = bodyToolCall;
                } else {
                    bodyToolStablePolls = 0;
                    bodyToolSignature = '';
                }
                if (snapshot && snapshot.canContinue && continuations < 8) {
                    const continued = await execJs(`(function(){var controls=Array.from(document.querySelectorAll('button,[role="button"]'));var control=controls.find(function(item){return /(?:continue generating|continue response|\u7ee7\u7eed\u751f\u6210|\u7ee7\u7eed\u56de\u7b54)/i.test(String(item.textContent||item.getAttribute('aria-label')||'').trim());});if(control){control.click();return true;}return false;})();`);
                    if (continued) { continuations += 1; wasGenerating = true; stablePolls = 0; nativeIdlePolls = 0; await new Promise((r) => setTimeout(r, 750)); continue; }
                }
                // The injected DOM observer can occasionally leave its
                // generating bit set after DeepSeek has restored the native
                // send arrow. A complete, stable DSH envelope plus no native
                // stop/loading control is authoritative and prevents a
                // finished webpage response from hanging for the full timeout.
                if (!rawPending && bodyToolCall && bodyToolStablePolls >= TOOL_STABLE_POLLS && snapshot && !snapshot.domGenerating) {
                    return { done: true, reason: 'body_tool_call', continuations, bodyToolCall: true };
                } else if (!rawPending && isStableDeepseekCompletion(snapshot, contentSeen, stablePolls, Date.now() - lastActivityAt)) {
                    return { done: true, reason: 'completed', continuations };
                // The native stop/loading control is the authoritative live
                // signal. Once it has disappeared for three 250 ms samples and
                // the answer itself stayed unchanged, do not wait several more
                // seconds for DeepSeek's action toolbar animation to mount the
                // copy button. The reasoning-only phase cannot satisfy this
                // branch because it has no distinct answer body.
                } else if (!rawPending && !incompleteBodyToolCall && wasGenerating && nativeIdlePolls >= NATIVE_IDLE_POLLS && stablePolls >= 2) {
                    return { done: true, reason: 'native_idle', continuations };
                } else if (state === 'generating') {
                    if (Date.now() - lastActivityAt >= 90000) {
                        return { done: false, reason: 'stalled', continuations };
                    }
                    wasGenerating = true;
                    // Reset stability only for an authoritative native
                    // stop/loading control. An injected-only generating state
                    // may be stale; retaining the signature counter lets the
                    // stable-content branch above finish the turn.
                    if (snapshot && snapshot.domGenerating) {
                        stablePolls = 0;
                        reasoningStablePolls = 0;
                    }
                    missingButtonPolls = 0;
                } else if (!rawPending && reasoningToolCall && reasoningToolStablePolls >= 2) {
                    return { done: true, reason: 'reasoning_tool_call', continuations, reasoningToolCall: true };
                // Completion requires a distinct answer, not merely stable
                // reasoning. This is the conservative fallback when the native
                // generating transition was too fast to observe.
                } else if (!rawPending && !incompleteBodyToolCall && contentSeen && stablePolls >= FALLBACK_STABLE_POLLS) {
                    return { done: true, reason: 'completed', continuations };
                } else if (!rawPending && !contentSeen && currentReasoning && reasoningStablePolls >= FALLBACK_STABLE_POLLS) {
                    // Finish extraction promptly so the provider can report a
                    // reasoning-only incomplete response instead of hanging
                    // until the full long-task timeout.
                    return { done: true, reason: 'reasoning_only', continuations };
                } else if (state === 'nobtn') {
                    missingButtonPolls += 1;
                    if (missingButtonPolls >= 20 && wasGenerating) return { done: false, reason: 'page_context_lost', continuations };
                } else {
                    missingButtonPolls = 0;
                }
            } catch (e) {
                consecutivePollErrors += 1;
                if (consecutivePollErrors >= 8) {
                    return { done: false, reason: 'page_context_error', code: 'provider_page_error', error: e && e.message || String(e), continuations };
                }
            }
            await new Promise((r) => setTimeout(r, COMPLETION_POLL_MS));
        }
        return { done: false, reason: 'timeout', continuations };
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

module.exports = { createDeepseekServer, extractDshToolCallsFromReasoning, extractDshToolCallsFromText, parseDshToolCall, normalizeDshToolCall, hasIncompleteDshToolEnvelope, isStableDeepseekCompletion, parseDeepseekRawSse };
