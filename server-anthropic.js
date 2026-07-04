// server-anthropic.js — Anthropic Claude API 服务
// 支持 Claude 系列模型，使用 Messages API
// 用户自定义 endpoint (可代理) + apiKey + model name
'use strict';

const https = require('https');
const http = require('http');
const { URL } = require('url');

function createAnthropicServer(config) {
    let _config = config || { endpoint: 'https://api.anthropic.com', apiKey: '', models: [] };
    function setConfig(cfg) { _config = cfg || {}; }
    function getConfig() { return _config; }

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
    const _convStates = new Map();
    function _getConv(convUrl) {
        if (!convUrl) return null;
        if (!_convStates.has(convUrl)) {
            _convStates.set(convUrl, {
                pendingHistory: null, lastRequest: null, lastResponse: null,
                lastResponseText: '', lastThinkText: ''
            });
        }
        return _convStates.get(convUrl);
    }
    function _deleteConv(convUrl) { _convStates.delete(convUrl); }

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
                    'x-api-key': (options.apiKey || _config.apiKey),
                    'anthropic-version': options.anthropicVersion || '2023-06-01'
                }, options.headers || {})
            };
            const req = lib.request(reqOpts, (res) => {
                let data = '';
                res.setEncoding('utf8');
                res.on('data', (chunk) => { data += chunk; });
                res.on('end', () => { resolve({ statusCode: res.statusCode, headers: res.headers, body: data }); });
            });
            req.on('error', reject);
            req.setTimeout(options.timeout || 120000, () => { req.destroy(new Error('Request timeout')); });
            if (body) req.write(typeof body === 'string' ? body : JSON.stringify(body));
            req.end();
        });
    }

    async function invoke(modelId, op, args) {
        args = args || {};
        const model = _config.models && _config.models.find((m) => m.id === modelId);
        if (op !== 'listModels' && op !== 'getCapabilities' && !model) {
            return { success: false, error: 'Unknown model: ' + modelId };
        }
        if (!_config.apiKey) return { success: false, error: 'Anthropic server not configured (apiKey missing)' };

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
                return { success: true, data: model.capabilities || { inputMaxLen: 200000, file: { maxMB: 0, maxCount: 0, types: [] }, multimodal: { input: ['text', 'image'], output: ['text'] } } };

            case 'listModels':
                return { success: true, data: _config.models || [] };

            case 'newChat':
                var convUrl = 'anthropic://session/' + Date.now() + '-' + Math.random().toString(36).substring(2, 8);
                _getConv(convUrl);
                return { success: true, data: { conversationUrl: convUrl } };

            case 'switchModel':
            case 'setDeepThink':
            case 'setWebSearch':
                return { success: true };

            case 'navigateToUrl':
            case 'getCurrentUrl':
                return { success: true, data: { url: 'anthropic://inline' } };

            case 'injectHistory': {
                var conv = _getConv(args._conversationUrl);
                if (!conv) return { success: false, error: 'No conversation context' };
                if (!conv.pendingHistory) conv.pendingHistory = [];
                if (args.segments) {
                    args.segments.forEach((seg) => {
                        conv.pendingHistory.push({ role: 'user', content: seg });
                        conv.pendingHistory.push({ role: 'assistant', content: '(已接收，继续)' });
                    });
                }
                return { success: true };
            }

            case 'sendMessage': {
                var conv = _getConv(args._conversationUrl);
                if (!conv) return { success: false, error: 'No conversation context' };
                // Anthropic Messages API: system 单独传，messages 数组交替 user/assistant
                const messages = [];
                if (conv.pendingHistory && conv.pendingHistory.length > 0) {
                    messages.push.apply(messages, conv.pendingHistory);
                    conv.pendingHistory = [];
                }
                // 当前消息：Anthropic 支持 content 数组（text + image）
                const userContent = [];
                if (args.text) userContent.push({ type: 'text', text: args.text });
                if (args.images && args.images.length > 0) {
                    args.images.forEach((img) => {
                        userContent.push({
                            type: 'image',
                            source: {
                                type: 'base64',
                                media_type: img.mime || 'image/png',
                                data: img.data
                            }
                        });
                    });
                }
                if (userContent.length === 1 && userContent[0].type === 'text') {
                    messages.push({ role: 'user', content: args.text });
                } else {
                    messages.push({ role: 'user', content: userContent });
                }

                const body = {
                    model: model.apiName || model.id,
                    messages: messages,
                    max_tokens: args.maxTokens || 4096,
                    stream: !!args.stream
                };
                if (args.systemPrompt) body.system = args.systemPrompt;
                if (args.temperature !== undefined) body.temperature = args.temperature;

                conv.lastRequest = body;
                conv.lastResponse = null;
                conv.lastResponseText = '';
                conv.lastThinkText = '';

                try {
                    const endpoint = (_config.endpoint || 'https://api.anthropic.com').replace(/\/$/, '');
                    const res = await httpRequest(endpoint + '/v1/messages', {
                        method: 'POST',
                        apiKey: _config.apiKey,
                        timeout: args.timeout || 120000
                    }, body);

                    if (res.statusCode !== 200) {
                        return { success: false, error: 'Anthropic API error ' + res.statusCode + ': ' + res.body.substring(0, 500) };
                    }

                    if (args.stream) {
                        // 解析 Anthropic SSE 流：event: content_block_delta → delta.text / delta.thinking
                        const parsed = parseAnthropicSSE(res.body);
                        conv.lastResponseText = parsed.text;
                        conv.lastThinkText = parsed.thinking;
                    } else {
                        const json = JSON.parse(res.body);
                        conv.lastResponse = json;
                        // 解析 content 数组
                        const blocks = json.content || [];
                        for (const b of blocks) {
                            if (b.type === 'text') conv.lastResponseText += b.text || '';
                            else if (b.type === 'thinking') conv.lastThinkText += b.thinking || '';
                        }
                    }
                    return { success: true };
                } catch (e) {
                    return { success: false, error: e.message };
                }
            }

            case 'waitForDone':
                return { success: true, data: { stopped: false } };

            case 'extractResponse': {
                var conv2 = _getConv(args._conversationUrl);
                if (!conv2) return { success: true, data: { markdown: '', think: '' } };
                return { success: true, data: { markdown: conv2.lastResponseText || '', think: conv2.lastThinkText || '' } };
            }

            case 'deleteConversation':
                _deleteConv(args._conversationUrl);
                return { success: true };

            case 'stopGeneration':
                return { success: true };

            case 'checkReady':
                return { success: true, data: { ready: !!_config.apiKey } };

            case 'poll':
                return { success: true, data: { generating: false } };

            case 'interruptPoll':
            case 'resumePoll':
                return { success: true };

            default:
                return { success: false, error: 'Unknown op: ' + op };
        }
    }

    // Anthropic SSE 解析：event: content_block_delta / content_block_start
    function parseAnthropicSSE(body) {
        const lines = body.split('\n');
        let text = '';
        let thinking = '';
        let currentType = 'text';
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();
            if (line.indexOf('event:') === 0) {
                const ev = line.substring(6).trim();
                // content_block_start 后跟 data 含 content_block.type
                if (ev === 'content_block_start') {
                    const dataLine = (lines[i + 1] || '').trim();
                    if (dataLine.indexOf('data:') === 0) {
                        try {
                            const json = JSON.parse(dataLine.substring(5).trim());
                            if (json.content_block && json.content_block.type) {
                                currentType = json.content_block.type === 'thinking' ? 'thinking' : 'text';
                            }
                        } catch (e) {}
                    }
                } else if (ev === 'content_block_delta') {
                    const dataLine = (lines[i + 1] || '').trim();
                    if (dataLine.indexOf('data:') === 0) {
                        try {
                            const json = JSON.parse(dataLine.substring(5).trim());
                            const d = json.delta;
                            if (!d) continue;
                            if (d.type === 'text_delta' && d.text) text += d.text;
                            else if (d.type === 'thinking_delta' && d.thinking) thinking += d.thinking;
                        } catch (e) {}
                    }
                }
            }
        }
        return { text: text, thinking: thinking };
    }

    return {
        provider: 'anthropic',
        setConfig,
        getConfig,
        invoke,
        getSlotStatus: () => ({ active: slots.active, max: slots.max, queued: slots.queue.length })
    };
}

module.exports = { createAnthropicServer };
