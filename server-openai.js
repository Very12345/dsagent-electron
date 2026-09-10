// server-openai.js — OpenAI 兼容 API 服务
// 支持 OpenAI / DeepSeek API / Qwen API / 任何 OpenAI 兼格 endpoint
// 用户自定义 endpoint + apiKey + model name
'use strict';

const https = require('https');
const http = require('http');
const { URL } = require('url');

function createOpenAIServer(config) {
    let _config = config || { endpoint: '', apiKey: '', models: [] };

    function setConfig(cfg) { _config = cfg || {}; }
    function getConfig() { return _config; }

    // ===== 并行槽位：API 可高并发 =====
    const slots = { max: 8, active: 0, queue: [] };
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

    // ===== per-conversation 状态（并发安全） =====
    // key: conversationUrl, value: { pendingHistory, lastRequest, lastResponse, lastResponseText, streaming }
    const _convStates = new Map();

    function _getConv(convUrl) {
        if (!convUrl) return null;
        if (!_convStates.has(convUrl)) {
            _convStates.set(convUrl, {
                pendingHistory: null,
                lastRequest: null,
                lastResponse: null,
                lastResponseText: '',
                streaming: false
            });
        }
        return _convStates.get(convUrl);
    }

    function _deleteConv(convUrl) {
        _convStates.delete(convUrl);
    }

    // ===== HTTP 请求封装 =====
    function httpRequest(url, options, body) {
        return new Promise((resolve, reject) => {
            const u = new URL(url);
            const isHttps = u.protocol === 'https:';
            const lib = isHttps ? https : http;
            const reqOpts = {
                hostname: u.hostname,
                port: u.port || (isHttps ? 443 : 80),
                path: u.pathname + u.search,
                method: options.method || 'POST',
                headers: Object.assign({
                    'Content-Type': 'application/json',
                    'Authorization': 'Bearer ' + (options.apiKey || _config.apiKey)
                }, options.headers || {})
            };
            const req = lib.request(reqOpts, (res) => {
                let data = '';
                res.setEncoding('utf8');
                res.on('data', (chunk) => { data += chunk; if (options.onData) options.onData(chunk); });
                res.on('end', () => {
                    resolve({ statusCode: res.statusCode, headers: res.headers, body: data });
                });
            });
            req.on('error', reject);
            if (options.signal) {
                if (options.signal.aborted) req.destroy(Object.assign(new Error('Request cancelled'), { code: 'run_cancelled', name: 'AbortError' }));
                else options.signal.addEventListener('abort', function(){ req.destroy(Object.assign(new Error('Request cancelled'), { code: 'run_cancelled', name: 'AbortError' })); }, { once: true });
            }
            req.setTimeout(options.timeout || 120000, () => { req.destroy(new Error('Request timeout')); });
            if (body) req.write(typeof body === 'string' ? body : JSON.stringify(body));
            req.end();
        });
    }

    // ===== invoke 协议 =====
    async function invoke(modelId, op, args) {
        args = args || {};
        const model = _config.models && _config.models.find((m) => m.id === modelId);
        if (op !== 'listModels' && op !== 'getCapabilities' && !model) {
            return { success: false, error: 'Unknown model: ' + modelId };
        }
        if (!_config.endpoint || !_config.apiKey) {
            return { success: false, error: 'OpenAI server not configured (endpoint/apiKey missing)' };
        }

        const longOps = ['injectHistory', 'sendMessage', 'waitForDone'];
        const needSlot = longOps.indexOf(op) >= 0;
        if (needSlot) await acquireSlot();
        try {
            return await dispatch(model, op, args);
        } finally {
            if (needSlot) releaseSlot();
        }
    }

    async function dispatch(model, op, args) {
        switch (op) {
            case 'getCapabilities':
                return { success: true, data: model.capabilities || { inputMaxLen: 128000, file: { maxMB: 0, maxCount: 0, types: [] }, multimodal: { input: ['text'], output: ['text'] } } };

            case 'listModels':
                return { success: true, data: _config.models || [] };

            case 'newChat':
                // API 模式无"新建对话"概念，每次 sendMessage 即独立调用；url 用伪 URL 标记
                var convUrl = 'openai://session/' + Date.now() + '-' + Math.random().toString(36).substring(2, 8);
                _getConv(convUrl); // 预创建状态
                return { success: true, data: { conversationUrl: convUrl } };

            case 'switchModel':
            case 'setDeepThink':
            case 'setWebSearch':
                return { success: true }; // API 模式无页面状态

            case 'navigateToUrl':
            case 'getCurrentUrl':
                return { success: true, data: { url: 'openai://inline' } };

            case 'injectHistory': {
                // API 模式：历史注入 = 把历史 messages 拼到下次 sendMessage 的 messages 数组前
                var conv = _getConv(args._conversationUrl);
                if (!conv) return { success: false, error: 'No conversation context' };
                if (!conv.pendingHistory) conv.pendingHistory = [];
                if (args.segments) {
                    args.segments.forEach(function(seg) {
                        conv.pendingHistory.push({ role: 'user', content: seg });
                        conv.pendingHistory.push({ role: 'assistant', content: '(已接收，继续)' });
                    });
                }
                return { success: true };
            }

            case 'sendMessage': {
                // 组装 OpenAI Chat Completions 请求
                var conv = _getConv(args._conversationUrl);
                if (!conv) return { success: false, error: 'No conversation context' };
                const messages = [];
                // 系统提示
                if (args.systemPrompt) messages.push({ role: 'system', content: args.systemPrompt });
                // 历史
                if (conv.pendingHistory && conv.pendingHistory.length > 0) {
                    messages.push.apply(messages, conv.pendingHistory);
                    conv.pendingHistory = [];
                }
                // 当前消息
                const userContent = [];
                if (args.text) userContent.push({ type: 'text', text: args.text });
                if (args.images && args.images.length > 0) {
                    args.images.forEach(function(img) {
                        userContent.push({ type: 'image_url', image_url: { url: img.dataUrl || ('data:' + (img.mime || 'image/png') + ';base64,' + img.data) } });
                    });
                }
                if (userContent.length === 1 && userContent[0].type === 'text') {
                    messages.push({ role: 'user', content: args.text });
                } else {
                    messages.push({ role: 'user', content: userContent });
                }

                const protocol = (model.protocol || _config.protocol || 'auto') === 'responses' ? 'responses' : 'chat_completions';
                const body = {
                    model: model.apiName || model.id,
                    messages: messages,
                    stream: !!args.stream,
                    temperature: args.temperature !== undefined ? args.temperature : 0.7
                };
                if (Array.isArray(args.tools) && args.tools.length) body.tools = args.tools.map(function(tool) { return { type: 'function', function: { name: tool.name, description: tool.description || '', parameters: tool.parameters || { type: 'object' } } }; });
                if (args.maxTokens) body.max_tokens = args.maxTokens;

                // 缓存到 per-conversation 状态
                conv.lastRequest = body;
                conv.lastResponse = null;
                conv.lastResponseText = '';
                conv.streaming = !!args.stream;

                try {
                    let streamBuffer = '';
                    let streamText = '';
                    const streamCalls = {};
                    const onData = args.stream ? function(chunk) {
                        streamBuffer += chunk;
                        var lines = streamBuffer.split(/\r?\n/);
                        streamBuffer = lines.pop() || '';
                        lines.forEach(function(line) {
                            if (line.indexOf('data:') !== 0) return;
                            var raw = line.slice(5).trim();
                            if (!raw || raw === '[DONE]') return;
                            try {
                                var event = JSON.parse(raw);
                                var delta = protocol === 'responses'
                                    ? (event.type === 'response.output_text.delta' ? event.delta || '' : '')
                                    : event.choices && event.choices[0] && event.choices[0].delta && event.choices[0].delta.content || '';
                                if (protocol === 'responses') {
                                    if (event.type === 'response.output_item.added' && event.item && event.item.type === 'function_call') streamCalls[event.output_index || event.item.id || 0] = { name: event.item.name || '', arguments: event.item.arguments || '' };
                                    if (event.type === 'response.function_call_arguments.delta') { var rc = streamCalls[event.output_index || event.item_id || 0] || (streamCalls[event.output_index || event.item_id || 0] = { name: event.name || '', arguments: '' }); rc.arguments += event.delta || ''; }
                                    if (event.type === 'response.function_call_arguments.done') { var rd = streamCalls[event.output_index || event.item_id || 0] || (streamCalls[event.output_index || event.item_id || 0] = { name: event.name || '', arguments: '' }); rd.name = event.name || rd.name; rd.arguments = event.arguments || rd.arguments; }
                                } else {
                                    var choiceDelta = event.choices && event.choices[0] && event.choices[0].delta;
                                    (choiceDelta && choiceDelta.tool_calls || []).forEach(function(call) { var cc = streamCalls[call.index || 0] || (streamCalls[call.index || 0] = { name: '', arguments: '' }); if (call.function) { cc.name = call.function.name || cc.name; cc.arguments += call.function.arguments || ''; } });
                                }
                                if (delta) { streamText += delta; conv.lastResponseText = streamText; if (args.onDelta) args.onDelta(streamText); }
                            } catch (_) {}
                        });
                    } : null;
                    const requestBody = protocol === 'responses'
                        ? { model: body.model, input: messages, stream: body.stream, tools: Array.isArray(args.tools) ? args.tools.map(function(tool) { return { type: 'function', name: tool.name, description: tool.description || '', parameters: tool.parameters || { type: 'object' }, strict: false }; }) : undefined }
                        : body;
                    const res = await httpRequest(_config.endpoint + (protocol === 'responses' ? '/responses' : '/chat/completions'), {
                        method: 'POST',
                        apiKey: _config.apiKey,
                        timeout: args.timeout || 120000,
                        signal: args.signal,
                        onData: onData
                    }, requestBody);

                    if (res.statusCode !== 200) {
                        return { success: false, error: 'OpenAI API error ' + res.statusCode + ': ' + res.body.substring(0, 500) };
                    }

                    if (args.stream) {
                        conv.lastResponseText = streamText || parseSSEStream(res.body, protocol) || toolProtocol(Object.keys(streamCalls).map(function(key) { return streamCalls[key]; }));
                    } else {
                        const json = JSON.parse(res.body);
                        conv.lastResponse = json;
                        conv.lastResponseText = protocol === 'responses'
                            ? extractResponsesText(json)
                            : extractChatText(json);
                    }
                    return { success: true };
                } catch (e) {
                    return { success: false, error: e.message, code: e.code || (e.name === 'AbortError' ? 'run_cancelled' : 'provider_request_failed') };
                }
            }

            case 'waitForDone':
                // API 模式：sendMessage 已同步返回，无需等待
                return { success: true, data: { stopped: false } };

            case 'extractResponse': {
                var conv2 = _getConv(args._conversationUrl);
                if (!conv2) return { success: true, data: { markdown: '', think: '' } };
                return { success: true, data: { markdown: conv2.lastResponseText || '', think: '' } };
            }

            case 'deleteConversation':
                _deleteConv(args._conversationUrl);
                return { success: true };

            case 'stopGeneration':
                return { success: true }; // API 同步，无中途停止

            case 'checkReady':
                return { success: true, data: { ready: !!(_config.endpoint && _config.apiKey) } };

            case 'poll':
                return { success: true, data: { generating: false } };

            case 'interruptPoll':
            case 'resumePoll':
                return { success: true };

            default:
                return { success: false, error: 'Unknown op: ' + op };
        }
    }

    // SSE 流式解析：累积所有 delta.content
    function parseSSEStream(body, protocol) {
        const lines = body.split('\n');
        let text = '';
        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.indexOf('data:') !== 0) continue;
            const data = trimmed.substring(5).trim();
            if (data === '[DONE]') break;
            try {
                const json = JSON.parse(data);
                const delta = protocol === 'responses'
                    ? (json.type === 'response.output_text.delta' ? json.delta : '')
                    : json.choices && json.choices[0] && json.choices[0].delta && json.choices[0].delta.content;
                if (delta) text += delta;
            } catch (e) { /* skip */ }
        }
        return text;
    }

    function toolProtocol(calls) {
        return (calls || []).map(function(call) {
            var fn = call.function || call;
            return 'Calling: ' + (fn.name || call.name || 'tool') + '\n```json\n' + (fn.arguments || call.arguments || '{}') + '\n```';
        }).join('\n\n');
    }
    function extractChatText(json) {
        var message = json.choices && json.choices[0] && json.choices[0].message || {};
        return message.content || toolProtocol(message.tool_calls);
    }
    function extractResponsesText(json) {
        if (json.output_text) return json.output_text;
        var text = [], calls = [];
        (json.output || []).forEach(function(item) {
            if (item.type === 'function_call') calls.push({ name: item.name, arguments: item.arguments });
            (item.content || []).forEach(function(part) { if (part.type === 'output_text' && part.text) text.push(part.text); });
        });
        return text.join('') || toolProtocol(calls);
    }

    return {
        provider: 'openai',
        setConfig,
        getConfig,
        invoke,
        getSlotStatus: () => ({ active: slots.active, max: slots.max, queued: slots.queue.length })
    };
}

module.exports = { createOpenAIServer };
