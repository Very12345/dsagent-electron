// server-deepseek.js — DeepSeek 网页版模型服务
// 运行在主进程，通过 executeJavaScript 调用 inject-deepseek.js 暴露的 DOM 协议
// 对外提供统一 invoke(modelId, op, args) 协议，供 Node ProviderManager 路由
'use strict';

const dirtyJson = require('dirty-json');
const { parseDsmlCalls, dsmlMarkerIndex, completeDsmlSuffix } = require('./src/runtime/deepseek-dsml');

const COMPLETION_POLL_MS = 100;
const NATIVE_IDLE_POLLS = 3;
const FALLBACK_STABLE_POLLS = 20;
const TOOL_STABLE_POLLS = 3;
const COPY_QUIET_MS = 300;
const RAW_DOM_FALLBACK_QUIET_MS = 1500;
const REASONING_ONLY_CONTINUE_GRACE_MS = 5000;
const MAX_REASONING_LOOP_RECOVERIES = 2;

function detectReasoningLoop(value) {
    const source = String(value || '');
    if (source.length < 80) return null;
    // Repeated protocol tags are normal in a batch of parallel tool calls.
    // Detecting the repeated <invoke>/<parameter> lines as prose previously
    // stopped a valid DSML response and injected LOOP_RECOVERY into a turn
    // even when Deep Think was disabled. Tool syntax has its own structural
    // validation and repair path, so the prose-loop detector must not touch it.
    if (dsmlMarkerIndex(source) >= 0 || /(?:```|~~~)dsh[-_]tool[-_]call|<dsh[-_]tool[-_]call>/i.test(source)) return null;
    const segments = source
        .split(/(?:\r?\n)+|(?<=[.!?。！？])\s+/)
        .map((part) => part.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').replace(/\s+/g, ' ').trim().toLowerCase())
        .filter((part) => part.length >= 4 && part.length <= 160)
        .slice(-24);
    if (segments.length < 8) return null;
    const counts = new Map();
    segments.forEach((part) => counts.set(part, (counts.get(part) || 0) + 1));
    const repeated = Array.from(counts.entries()).filter(([, count]) => count >= 3).sort((a, b) => b[1] - a[1]);
    const repeatedHits = repeated.reduce((sum, entry) => sum + entry[1], 0);
    if (!repeated.length || repeatedHits < 6 || counts.size / segments.length > 0.65) return null;
    return { segments: segments.length, unique: counts.size, repeated: repeated.slice(0, 4).map(([text, count]) => ({ text, count })) };
}

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

function deepseekHistoryMessageArray(payload) {
    const root = payload && payload.data && payload.data.biz_data || payload && payload.biz_data || payload;
    if (!root || typeof root !== 'object') return [];
    for (const key of ['chat_messages', 'messages']) {
        if (Array.isArray(root[key])) return root[key];
    }
    return [];
}

function deepseekHistoryCurrentMessageId(payload) {
    const roots = [payload, payload && payload.data, payload && payload.data && payload.data.biz_data, payload && payload.biz_data];
    for (const root of roots) {
        if (!root || typeof root !== 'object') continue;
        for (const key of ['current_message_id', 'currentMessageId', 'current_id']) {
            if (root[key] != null) return String(root[key]);
        }
    }
    return '';
}

function deepseekHistoryContent(value) {
    if (value == null) return '';
    if (typeof value === 'string') return value;
    if (Array.isArray(value)) return value.map(deepseekHistoryContent).join('');
    if (typeof value !== 'object') return String(value);
    for (const key of ['text', 'content', 'value']) {
        if (typeof value[key] === 'string') return value[key];
    }
    return '';
}

function normalizeDeepseekHistoryMessage(message, order) {
    if (!message || typeof message !== 'object') return null;
    const fragments = Array.isArray(message.fragments)
        ? message.fragments
        : message.response && Array.isArray(message.response.fragments) ? message.response.fragments : [];
    const fragmentReasoning = fragments.filter((fragment) => /THINK|REASON/i.test(String(fragment && fragment.type || '')))
        .map((fragment) => deepseekHistoryContent(fragment && (fragment.content !== undefined ? fragment.content : fragment))).join('');
    const fragmentAnswer = fragments.filter((fragment) => !/THINK|REASON|SEARCH/i.test(String(fragment && fragment.type || '')))
        .map((fragment) => deepseekHistoryContent(fragment && (fragment.content !== undefined ? fragment.content : fragment))).join('');
    const roleValue = String(message.role || message.message_role || message.sender || message.type || '').toLowerCase();
    const role = /assistant|bot|model/.test(roleValue) ? 'assistant' : /user|human/.test(roleValue) ? 'user' : '';
    const directContent = deepseekHistoryContent(message.content !== undefined ? message.content : message.text);
    const reasoning = deepseekHistoryContent(message.thinking_content !== undefined ? message.thinking_content
        : message.reasoning_content !== undefined ? message.reasoning_content
          : message.thinking !== undefined ? message.thinking : message.reasoning);
    return {
        raw: message,
        order,
        id: String(message.message_id || message.id || message.messageId || ''),
        parentId: String(message.parent_message_id || message.parent_id || message.parentId || ''),
        role,
        content: directContent || fragmentAnswer,
        reasoning: reasoning || fragmentReasoning,
        status: String(message.status || message.quasi_status || message.response && message.response.status || '')
    };
}

function activeDeepseekHistoryMessages(payload) {
    const normalized = deepseekHistoryMessageArray(payload).map(normalizeDeepseekHistoryMessage).filter(Boolean);
    const currentId = deepseekHistoryCurrentMessageId(payload);
    if (!currentId || !normalized.some((message) => message.id === currentId)) return normalized;
    const byId = new Map(normalized.filter((message) => message.id).map((message) => [message.id, message]));
    const branch = [];
    const visited = new Set();
    let current = byId.get(currentId);
    while (current && !visited.has(current.id)) {
        branch.push(current);
        visited.add(current.id);
        current = current.parentId && byId.get(current.parentId);
    }
    return branch.length ? branch.reverse() : normalized;
}

function reconcileDeepseekHistory(payload, sentText) {
    const expected = String(sentText == null ? '' : sentText).replace(/\r\n?/g, '\n').trim();
    if (!expected) return { matched: false, reason: 'missing_sent_text' };
    const messages = activeDeepseekHistoryMessages(payload);
    let userIndex = -1;
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index];
        if (message.role !== 'user') continue;
        const actual = String(message.content || '').replace(/\r\n?/g, '\n').trim();
        if (actual === expected) { userIndex = index; break; }
    }
    if (userIndex < 0) return { matched: false, reason: 'user_turn_not_found', messageCount: messages.length };
    for (let index = userIndex + 1; index < messages.length; index += 1) {
        const message = messages[index];
        if (message.role === 'user') break;
        if (message.role !== 'assistant') continue;
        const markdown = String(message.content || '');
        const reasoning = String(message.reasoning || '');
        const terminal = !message.status || /FINISHED|COMPLETE|DONE/i.test(message.status);
        return {
            matched: true,
            assistantFound: true,
            complete: terminal && !!(markdown.trim() || reasoning.trim()),
            markdown,
            reasoning,
            status: message.status,
            userMessageId: messages[userIndex].id,
            assistantMessageId: message.id
        };
    }
    return { matched: true, assistantFound: false, complete: false, userMessageId: messages[userIndex].id };
}

function createRawResponseAggregate() {
    return {
        recordKey: '',
        baseMarkdown: '',
        baseReasoning: '',
        markdown: '',
        reasoning: ''
    };
}

function rawResponseRecordKey(record) {
    if (!record) return '';
    return String(record.source || 'stream') + ':' + String(record.seq == null ? '' : record.seq);
}

// A continuation request can contain either only the newly generated suffix
// or the complete answer-so-far. Preserve both forms and remove only the
// literal boundary overlap, so the public stream remains one coherent reply.
function mergeContinuationText(base, next) {
    base = String(base || '');
    next = String(next || '');
    if (!base) return next;
    if (!next) return base;
    if (next.startsWith(base)) return next;
    if (base.startsWith(next) || base.endsWith(next)) return base;
    const limit = Math.min(base.length, next.length, 8192);
    for (let size = limit; size > 0; size -= 1) {
        if (base.slice(-size) === next.slice(0, size)) return base + next.slice(size);
    }
    return base + next;
}

function mergeRawResponseRecord(aggregate, record, parsed) {
    const key = rawResponseRecordKey(record);
    if (aggregate.recordKey !== key) {
        aggregate.baseMarkdown = aggregate.markdown;
        aggregate.baseReasoning = aggregate.reasoning;
        aggregate.recordKey = key;
    }
    aggregate.markdown = mergeContinuationText(aggregate.baseMarkdown, parsed.markdown);
    aggregate.reasoning = mergeContinuationText(aggregate.baseReasoning, parsed.reasoning);
    return Object.assign({}, parsed, {
        markdown: aggregate.markdown,
        reasoning: aggregate.reasoning,
        recordKey: key,
        source: record && record.source || '',
        seq: record && record.seq
    });
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
    let rawResponseAggregate = createRawResponseAggregate();
    let lastRawResponse = null;
    let lastSentMessage = '';

    async function resetRawResponseCursor() {
        const view = getView();
        rawResponseAggregate = createRawResponseAggregate();
        lastRawResponse = null;
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
                lastRawResponse = mergeRawResponseRecord(rawResponseAggregate, streamed, Object.assign({ pending: !streamed.done && !streamed.logicalDone }, parsed));
                return lastRawResponse;
            }
            if (streamed) return {
                pending: !streamed.done,
                finished: false,
                error: streamed.error || '',
                recordKey: rawResponseRecordKey(streamed)
            };
        }
        return null;
    }

    async function recoverFromConversationHistory(conversationUrl) {
        const view = getView();
        if (!view || typeof view.reloadConversationHistory !== 'function' || !lastSentMessage || !conversationUrl) return null;
        let lastReconciliation = null;
        let historyCaptured = false;
        for (let attempt = 0; attempt < 2; attempt += 1) {
            if (attempt) await new Promise((resolve) => setTimeout(resolve, 1500));
            let record = null;
            try { record = await view.reloadConversationHistory(conversationUrl, { timeout: 12000 }); }
            catch (_) { record = null; }
            if (!record || record.error || (!record.json && !record.text)) continue;
            historyCaptured = true;
            let payload = record.json;
            if (!payload) {
                try { payload = JSON.parse(record.text); } catch (_) { continue; }
            }
            const reconciled = reconcileDeepseekHistory(payload, lastSentMessage);
            lastReconciliation = Object.assign({ source: record.source || 'page-history' }, reconciled);
            if (!reconciled.matched) return lastReconciliation;
            if (!reconciled.complete) continue;
            if (typeof view.resetRawCompletionStreams === 'function') {
                try { rawResponseCursor.stream = await view.resetRawCompletionStreams(); } catch (_) {}
            }
            rawResponseAggregate = createRawResponseAggregate();
            rawResponseAggregate.recordKey = 'history:' + String(record.seq || Date.now());
            rawResponseAggregate.markdown = reconciled.markdown || '';
            rawResponseAggregate.reasoning = reconciled.reasoning || '';
            lastRawResponse = {
                markdown: rawResponseAggregate.markdown,
                reasoning: rawResponseAggregate.reasoning,
                status: reconciled.status || 'FINISHED',
                finished: true,
                pending: false,
                response: null,
                recordKey: rawResponseAggregate.recordKey,
                source: 'page-history',
                seq: record.seq,
                recoveredFromHistory: true
            };
            return Object.assign({}, lastReconciliation, { recovered: true, raw: lastRawResponse });
        }
        return lastReconciliation || {
            attempted: true,
            matched: false,
            historyUnavailable: !historyCaptured,
            reason: historyCaptured ? 'history_payload_invalid' : 'history_response_unavailable'
        };
    }

    async function clickContinueGenerating(allowClick) {
        const labels = ['继续生成', '继续回答', 'Continue', 'Continue generating', 'Continue response'];
        const view = getView();
        const webContents = view && view.webContents;
        // Use the accessible button role first. Never use an unrestricted text
        // locator here: assistant content itself may legitimately be exactly
        // "Continue" and must not be clicked.
        if (webContents && typeof webContents.clickVisibleButton === 'function') {
            try {
                const nativeButton = await webContents.clickVisibleButton(labels, { timeout: 1500, click: allowClick !== false });
                if (nativeButton && nativeButton.found) return nativeButton;
            } catch (_) {}
        }
        const match = await execJs(`(function(){
            var allowClick = ${allowClick === false ? 'false' : 'true'};
            var labels = ['继续生成','继续回答','Continue','Continue generating','Continue response'];
            var nodes = Array.from(document.querySelectorAll('span.ds-button__content,button,[role="button"],.ds-button'));
            var match = null;
            for (var i = nodes.length - 1; i >= 0; i -= 1) {
                var node = nodes[i];
                var label = String(node.getAttribute && node.getAttribute('aria-label') || node.textContent || '').replace(/\\s+/g, ' ').trim();
                if (labels.indexOf(label) < 0) continue;
                var control = node.closest && node.closest('button,[role="button"],.ds-button') || node;
                if (control.disabled || control.getAttribute && control.getAttribute('aria-disabled') === 'true') continue;
                var rect = control.getBoundingClientRect();
                var style = window.getComputedStyle(control);
                if (rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden') { match = {control:control,label:label}; break; }
            }
            var control = match && match.control;
            if (!control) return {found:false,clicked:false};
            var label = match.label;
            var rect = control.getBoundingClientRect();
            return {found:true,clicked:false,label:label,x:rect.left+rect.width/2,y:rect.top+rect.height/2,tag:String(control.tagName||''),role:String(control.getAttribute&&control.getAttribute('role')||''),className:String(control.className||'')};
        })();`);
        if (!match || !match.found || allowClick === false || match.clicked) return match || { found: false, clicked: false };
        if (webContents && typeof webContents.sendInputEvent === 'function' && Number.isFinite(match.x) && Number.isFinite(match.y)) {
            await Promise.resolve(webContents.sendInputEvent({ type: 'mouseMove', x: match.x, y: match.y }));
            await Promise.resolve(webContents.sendInputEvent({ type: 'mouseDown', x: match.x, y: match.y, button: 'left', clickCount: 1 }));
            await Promise.resolve(webContents.sendInputEvent({ type: 'mouseUp', x: match.x, y: match.y, button: 'left', clickCount: 1 }));
            return Object.assign({}, match, { clicked: true, trusted: true });
        }
        const fallback = await execJs(`(function(){
            var labels=['继续生成','继续回答','Continue','Continue generating','Continue response'];
            var nodes=Array.from(document.querySelectorAll('span.ds-button__content,button,[role="button"],.ds-button'));
            for(var i=nodes.length-1;i>=0;i-=1){var label=String(nodes[i].getAttribute&&nodes[i].getAttribute('aria-label')||nodes[i].textContent||'').replace(/\\s+/g,' ').trim();if(labels.indexOf(label)<0)continue;var control=nodes[i].closest&&nodes[i].closest('button,[role="button"],.ds-button')||nodes[i];control.click();return {found:true,clicked:true,label:label,trusted:false};}return {found:false,clicked:false};
        })();`);
        return fallback || match;
    }

    async function currentUsageLimit() {
        try {
            const limit = await execJs(`window.__dsagent_getUsageLimitState ? window.__dsagent_getUsageLimitState() : {limited:false};`);
            return limit && limit.limited ? limit : null;
        } catch (_) { return null; }
    }

    async function recoverReasoningLoop(loop, attempt) {
        try {
            await execJs(`window.__dsagent_stopGeneration ? window.__dsagent_stopGeneration() : {success:false};`);
        } catch (_) {}
        await new Promise((resolve) => setTimeout(resolve, 650));
        await resetRawResponseCursor();
        const repeated = loop && Array.isArray(loop.repeated)
            ? loop.repeated.map((item) => item.text).slice(0, 3).join(' / ')
            : 'repeated reasoning';
        const channel = loop && loop.channel === 'response' ? 'response' : 'reasoning';
        const instruction = 'LOOP_RECOVERY ' + String(attempt) + ': Your ' + channel + ' is repeating (' + repeated + '). Do not restate analysis or announce an action. Emit the pending valid DSML tool call now; if no tool is needed, give the concise final answer.';
        const sent = await execJs(`(async function(){
            if(!window.__dsagent_sendMessage)return {success:false,error:'inject not ready'};
            return await window.__dsagent_sendMessage(${JSON.stringify(instruction)}, true);
        })();`);
        return !!(sent && sent.success);
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
                // Workers are reused across sessions. Establish a fresh raw
                // response boundary before the first request of this chat.
                await resetRawResponseCursor();
                lastSentMessage = String(args.userText || '');
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
                    if (r && (r.code === 'out_of_usage' || r.code === 'provider_busy' || r.code === 'context_length_exceeded' || r.rateLimited)) {
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
                const view = getView();
                const webContents = view && view.webContents;
                if (webContents && typeof webContents.setVisibleToggle === 'function') {
                    return await webContents.setVisibleToggle(
                        ['联网搜索', '智能搜索', '搜索', 'Search', 'Web Search', 'Web search'],
                        !!args.enable,
                        { retries: 3 }
                    );
                }
                const js = `(async function(){
                    if (!window.__dsagent_setWebSearch) return {success:false,error:'setWebSearch not available'};
                    return await window.__dsagent_setWebSearch(${!!args.enable});
                })();`;
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
                lastSentMessage = String(args.text || '');
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
                    if (r && (typeof r === 'object') && (r.code === 'out_of_usage' || r.code === 'provider_busy' || r.code === 'context_length_exceeded' || r.rateLimited || (r.error && (String(r.error).indexOf('429') >= 0)))) {
                        return {success:false, code:r.code || 'out_of_usage', error:r.error || 'DeepSeek webpage rate limit reached', rateLimited:r.code !== 'provider_busy', retryAfter: (r.retryAfter || 60)};
                    }
                    return r && typeof r === 'object' ? r : {success:true};
                })();`;
                const r = await execJs(js);
                if (r && (r.rateLimited || r.code === 'out_of_usage' || r.code === 'provider_busy' || r.code === 'context_length_exceeded')) {
                    return { success: false, code: r.code || 'out_of_usage', error: r.error || 'DeepSeek webpage rate limit reached', retryAfter: r.retryAfter || 60 };
                }
                // 确保返回对象（inject 脚本可能返回原始值 true）
                return r && typeof r === 'object' ? r : { success: true };
            }

            case 'waitForDone': {
                const timeout = args.timeout || 120000;
                const outcome = await waitForDoneSse(timeout, {
                    allowReasoningToolCall: !!args.allowReasoningToolCall,
                    signal: args.signal,
                    initialActivityTimeout: args.initialActivityTimeout,
                    conversationUrl: args._conversationUrl
                });
                if (!outcome.done) {
                    const code = outcome.code || (outcome.reason === 'cancelled'
                        ? 'run_cancelled'
                        : outcome.reason === 'timeout' ? 'provider_timeout'
                        : outcome.reason === 'initial_response_timeout' ? 'provider_send_unconfirmed'
                        : 'provider_incomplete');
                    const message = code === 'out_of_usage'
                        ? 'DeepSeek webpage is rate limited (out of usage); retry after ' + String(outcome.retryAfter || 60) + ' seconds'
                        : code === 'context_length_exceeded'
                          ? 'DeepSeek webpage context window exceeded; compact the Harness session and continue in a new conversation'
                        : code === 'provider_busy'
                          ? 'DeepSeek webpage is temporarily busy; retry after ' + String(outcome.retryAfter || 30) + ' seconds'
                        : code === 'provider_sse_unavailable'
                          ? 'DeepSeek accepted the page action but no matching completion SSE stream was captured within ' + String(Math.ceil((args.initialActivityTimeout || 20000) / 1000)) + ' seconds'
                          : 'DeepSeek response incomplete: ' + outcome.reason;
                    return { success: false, error: message, code, retryAfter: outcome.retryAfter, data: outcome };
                }
                return { success: true, data: outcome };
            }

            case 'peekResponse': {
                try {
                    const raw = await currentRawResponse();
                    return { success: true, data: raw ? { text: raw.markdown || '', reasoning: raw.reasoning || '', rawTransport: true } : { text: '', reasoning: '', rawTransport: true } };
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
                for (let rawAttempt = 0; rawAttempt < 40; rawAttempt += 1) {
                    const raw = await currentRawResponse() || lastRawResponse;
                    if (raw && (raw.finished || raw.pending === false) && (raw.markdown || raw.reasoning)) {
                        const reasoningToolCall = args.allowReasoningToolCall && !String(raw.markdown || '').trim()
                            ? extractDshToolCallsFromReasoning(raw.reasoning)
                            : '';
                        return { success: true, data: {
                            markdown: raw.markdown || reasoningToolCall || '',
                            think: raw.reasoning || '',
                            answerConfirmed: !!String(raw.markdown || reasoningToolCall || '').trim(),
                            reasoningToolCall: !!reasoningToolCall,
                            rawTransport: !raw.recoveredFromHistory,
                            historyRecovered: !!raw.recoveredFromHistory
                        } };
                    }
                    await new Promise((resolve) => setTimeout(resolve, 50));
                }
                return { success: false, code: 'provider_sse_unavailable', error: 'DeepSeek original SSE was not available; DOM fallback is disabled' };
            }

            case 'getConversationMetadata': {
                const js = `(function(){
                    var here=(location.pathname||'').replace(/\\/$/,'');
                    var links=Array.from(document.querySelectorAll('a[href*="/chat/"],a[href*="/a/chat/s/"]'));
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
                    return Array.from(document.querySelectorAll('a[href*="/chat/"],a[href*="/a/chat/s/"]')).map(function(a){return {title:(a.textContent||'').trim(),href:a.href};});
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

    // Live DeepSeek answer/reasoning comes from the provider SSE. If that
    // volatile stream is lost, a same-conversation reload may recover the
    // durable turn from history_messages. DOM is consulted only for provider
    // controls; it never supplies model content/completion.
    async function waitForDoneSse(timeout, options) {
        options = options || {};
        const start = Date.now();
        let initialActivityStartedAt = start;
        const initialActivityTimeout = Math.max(15000, Number(options.initialActivityTimeout) || 45000);
        let rawSeen = false;
        let lastRaw = null;
        let rawMissingSince = 0;
        let lastSignature = '';
        let lastActivityAt = start;
        let continuations = 0;
        let waitingAfterRecord = '';
        let continuationClickedAt = 0;
        let lastContinuationClickAt = 0;
        let continuationClickAttempts = 0;
        let finishedRecord = '';
        let finishedSeenAt = 0;
        let lastContinueProbeAt = 0;
        let reasoningLoopRecoveries = 0;
        let lastReasoningLoopFingerprint = '';
        let lastUsageLimitProbeAt = 0;
        async function historyRecoveryOutcome(reason, code) {
            const history = await recoverFromConversationHistory(options.conversationUrl);
            if (!history) return null;
            if (history.historyUnavailable || history.reason === 'history_payload_invalid') return {
                done: false,
                reason: history.reason,
                code: 'provider_history_unavailable',
                originalCode: code,
                continuations
            };
            // A valid snapshot that does not contain the exact submitted user
            // turn proves that resending is safe. Only this case may flow back
            // to the existing empty-response retry policy.
            if (!history.matched) return null;
            if (history.recovered) return {
                done: true,
                reason: 'history_recovered_after_' + reason,
                rawTransport: false,
                historyRecovered: true,
                continuations,
                reasoningLoopRecoveries
            };
            let continuation = null;
            try { continuation = await clickContinueGenerating(true); } catch (_) {}
            if (continuation && continuation.clicked) return { resume: true, continuationClicked: true };
            let executing = false;
            try { executing = !!(await execJs('window.__dsagent_isExecuting ? window.__dsagent_isExecuting() : false;')); } catch (_) {}
            if (executing) return { resume: true, generating: true };
            return {
                done: false,
                reason: history.assistantFound ? 'history_response_incomplete' : 'history_user_turn_without_response',
                code: 'provider_history_incomplete',
                historyMatched: true,
                originalCode: code,
                continuations
            };
        }
        while (Date.now() - start < timeout) {
            if (options.signal && options.signal.aborted) return { done: false, reason: 'cancelled' };
            let raw = null;
            try { raw = await currentRawResponse(); }
            catch (error) { return { done: false, reason: 'sse_capture_error', code: 'provider_sse_error', error: error.message }; }
            if (raw) {
                lastRaw = raw;
                rawMissingSince = 0;
            } else if (rawSeen && lastRaw) {
                // A SPA navigation can discard the page-fetch record between
                // two polls after we have already streamed its content. Never
                // rewrite that observed response as "SSE unavailable". Keep
                // the last authoritative bytes; after a short consecutive
                // absence, the old document/request is necessarily over.
                if (!rawMissingSince) rawMissingSince = Date.now();
                raw = Object.assign({}, lastRaw, {
                    pending: Date.now() - rawMissingSince < 500 ? !!lastRaw.pending : false,
                    captureRecordMissing: true
                });
            }
            if (raw) {
                rawSeen = true;
                const recordKey = String(raw.recordKey || '');
                const signature = String(raw.markdown || '') + '\u0000' + String(raw.reasoning || '') + '\u0000' + String(raw.status || '');
                if (signature !== lastSignature) { lastSignature = signature; lastActivityAt = Date.now(); }
                // A throttled webpage often closes an otherwise empty SSE
                // placeholder. Classify the visible provider control state
                // before the generic empty-response retry path, so account
                // failover happens immediately instead of resending 3 times.
                if (!String(raw.markdown || '').trim() && !String(raw.reasoning || '').trim()
                    && Date.now() - lastUsageLimitProbeAt >= 200) {
                    lastUsageLimitProbeAt = Date.now();
                    const limit = await currentUsageLimit();
                    if (limit) return { done: false, reason: limit.reason || 'rate_limited', code: limit.code || 'out_of_usage', retryAfter: limit.retryAfter || 60, continuations };
                }
                if (waitingAfterRecord && recordKey && recordKey !== waitingAfterRecord) {
                    waitingAfterRecord = '';
                    continuationClickedAt = 0;
                    lastContinuationClickAt = 0;
                    continuationClickAttempts = 0;
                    finishedRecord = '';
                    finishedSeenAt = 0;
                }
                if (waitingAfterRecord && recordKey === waitingAfterRecord) {
                    // A coordinate click can resolve even when the SPA ignores
                    // it. If the same Continue control is still visible and no
                    // newer SSE request appeared, retry with the trusted text
                    // locator a few times instead of waiting inertly for 20s.
                    if (continuationClickAttempts < 4 && Date.now() - lastContinuationClickAt >= 700) {
                        let retried = null;
                        try { retried = await clickContinueGenerating(true); }
                        catch (_) { retried = null; }
                        if (retried && retried.clicked) {
                            continuationClickAttempts += 1;
                            lastContinuationClickAt = Date.now();
                        }
                    }
                    if (Date.now() - continuationClickedAt >= 20000) {
                        const limit = await currentUsageLimit();
                        if (limit) return { done: false, reason: limit.reason || 'rate_limited', code: limit.code || 'out_of_usage', retryAfter: limit.retryAfter || 60, continuations };
                        return { done: false, reason: 'continuation_not_started', code: 'provider_continuation_unconfirmed', continuations };
                    }
                    await new Promise((resolve) => setTimeout(resolve, COMPLETION_POLL_MS));
                    continue;
                }
                if (options.allowReasoningToolCall) {
                    const reasoningLoop = detectReasoningLoop(raw.reasoning);
                    const responseLoop = reasoningLoop ? null : detectReasoningLoop(raw.markdown);
                    const loop = reasoningLoop
                        ? Object.assign({ channel: 'reasoning' }, reasoningLoop)
                        : responseLoop ? Object.assign({ channel: 'response' }, responseLoop) : null;
                    const loopFingerprint = loop ? loop.channel + ':' + JSON.stringify(loop.repeated) : '';
                    if (loop && loopFingerprint !== lastReasoningLoopFingerprint) {
                        lastReasoningLoopFingerprint = loopFingerprint;
                        if (reasoningLoopRecoveries >= MAX_REASONING_LOOP_RECOVERIES) {
                            return { done: false, reason: 'reasoning_loop', code: 'provider_reasoning_loop', reasoningLoopRecoveries, loop };
                        }
                        reasoningLoopRecoveries += 1;
                        const recovered = await recoverReasoningLoop(loop, reasoningLoopRecoveries);
                        if (!recovered) return { done: false, reason: 'reasoning_loop_recovery_failed', code: 'provider_reasoning_loop', reasoningLoopRecoveries, loop };
                        lastSignature = '';
                        lastReasoningLoopFingerprint = '';
                        lastActivityAt = Date.now();
                        waitingAfterRecord = '';
                        continuationClickedAt = 0;
                        finishedRecord = '';
                        finishedSeenAt = 0;
                        await new Promise((resolve) => setTimeout(resolve, COMPLETION_POLL_MS));
                        continue;
                    }
                }
                // A user stop can expose “Continue generating” before CDP has
                // marked the interrupted response stream as closed. Probe the
                // control after a brief network quiet period as well as after
                // an authoritative SSE finish; never use DOM response text.
                const shouldProbeContinue = !!recordKey && (raw.finished || Date.now() - lastActivityAt >= 250);
                if (shouldProbeContinue && Date.now() - lastContinueProbeAt >= 150) {
                    lastContinueProbeAt = Date.now();
                    let continuation = null;
                    try { continuation = await clickContinueGenerating(continuations < 8); }
                    catch (_) { continuation = null; }
                    if (continuation && continuation.found && continuations >= 8) {
                        return { done: false, reason: 'continuation_limit', code: 'provider_continuation_limit', continuations };
                    }
                    if (continuation && continuation.clicked) {
                        continuations += 1;
                        waitingAfterRecord = recordKey;
                        continuationClickedAt = Date.now();
                        lastContinuationClickAt = continuationClickedAt;
                        continuationClickAttempts = 1;
                        lastActivityAt = continuationClickedAt;
                        finishedRecord = '';
                        finishedSeenAt = 0;
                        await new Promise((resolve) => setTimeout(resolve, COMPLETION_POLL_MS));
                        continue;
                    }
                }
                const streamEnded = raw.finished || raw.pending === false;
                if (streamEnded) {
                    lastRawResponse = raw;
                    if (finishedRecord !== recordKey) {
                        finishedRecord = recordKey;
                        finishedSeenAt = Date.now();
                    }
                    // DeepSeek mounts the continuation control just after the
                    // closing SSE frame on some builds. Give only the control
                    // a short grace period; model content still comes from SSE.
                    const continuationGrace = !String(raw.markdown || '').trim() && String(raw.reasoning || '').trim()
                        ? REASONING_ONLY_CONTINUE_GRACE_MS
                        : 400;
                    if (Date.now() - finishedSeenAt < continuationGrace) {
                        await new Promise((resolve) => setTimeout(resolve, COMPLETION_POLL_MS));
                        continue;
                    }
                    if (!String(raw.markdown || '').trim() && !String(raw.reasoning || '').trim()) {
                        // Immediately after a DSH tool result DeepSeek can
                        // close an empty placeholder completion and start the
                        // real request shortly afterwards. Allow a newer raw
                        // SSE record to supersede that placeholder first.
                        if (Date.now() - finishedSeenAt < 1200) {
                            await new Promise((resolve) => setTimeout(resolve, COMPLETION_POLL_MS));
                            continue;
                        }
                        const recovered = await historyRecoveryOutcome('empty_sse', 'provider_sse_empty');
                        if (recovered && recovered.resume) {
                            initialActivityStartedAt = Date.now();
                            rawSeen = false;
                            lastRaw = null;
                            finishedRecord = '';
                            finishedSeenAt = 0;
                            if (recovered.continuationClicked) continuations += 1;
                            await new Promise((resolve) => setTimeout(resolve, COMPLETION_POLL_MS));
                            continue;
                        }
                        if (recovered) return recovered;
                        return { done: false, reason: 'empty_sse_response', code: 'provider_sse_empty', continuations };
                    }
                    return { done: true, reason: raw.finished ? 'raw_network_finished' : 'raw_network_ended', rawTransport: true, continuations, reasoningLoopRecoveries };
                }
                if (raw.error && !raw.pending) return { done: false, reason: 'sse_capture_error', code: 'provider_sse_error', error: raw.error, continuations };
                if (Date.now() - lastActivityAt >= 90000) return { done: false, reason: 'sse_stalled', code: 'provider_stream_stalled', continuations };
            } else if (!rawSeen && Date.now() - initialActivityStartedAt >= initialActivityTimeout) {
                const limit = await currentUsageLimit();
                if (limit) return { done: false, reason: limit.reason || 'rate_limited', code: limit.code || 'out_of_usage', retryAfter: limit.retryAfter || 60 };
                const recovered = await historyRecoveryOutcome('missing_sse', 'provider_sse_unavailable');
                if (recovered && recovered.resume) {
                    initialActivityStartedAt = Date.now();
                    if (recovered.continuationClicked) continuations += 1;
                    await new Promise((resolve) => setTimeout(resolve, COMPLETION_POLL_MS));
                    continue;
                }
                if (recovered) return recovered;
                return { done: false, reason: 'sse_unavailable', code: 'provider_sse_unavailable' };
            }
            await new Promise((resolve) => setTimeout(resolve, COMPLETION_POLL_MS));
        }
        return { done: false, reason: 'timeout', code: 'provider_timeout', continuations };
    }

    // Legacy DOM completion implementation retained only for compatibility
    // helpers and tests; live DeepSeek Runs use waitForDoneSse above.
    async function waitForDoneInternal(timeout, options) {
        options = options || {};
        const start = Date.now();
        const initialActivityTimeout = Math.max(15000, Number(options.initialActivityTimeout) || 45000);
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
        let finalBodyToolSignature = '';
        let finalBodyToolStablePolls = 0;
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
                    var finalText = window.__dsagent_extractCurrentAnswerMarkdown ? window.__dsagent_extractCurrentAnswerMarkdown(false) : lastText;
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
                    if (!b) return {state:stopControl || injectedGenerating ? 'generating' : 'nobtn', domGenerating:stopControl, injectedGenerating:injectedGenerating, canContinue:continueControl, count:bodies.length, text:lastText, finalText:finalText, reasoning:reasoning, copyCount:copyCount, newCopyButton:newCopyButton, usageLimit:usageLimit, baseline:baseline};
                    var dis = b.classList.contains('ds-button--disabled') || b.disabled;
                    var loading = !!b.querySelector('.ds-loading');
                    var sp = b.querySelector('svg path');
                    var d = sp ? (sp.getAttribute('d') || '') : '';
                    var stopped = d.indexOf('M2 4.88') >= 0;
                    if (!dis) {
                        return {state:stopped || stopControl || injectedGenerating ? 'generating' : 'idle', domGenerating:stopped || stopControl || loading, injectedGenerating:injectedGenerating, canContinue:continueControl, count:bodies.length, text:lastText, finalText:finalText, reasoning:reasoning, copyCount:copyCount, newCopyButton:newCopyButton, usageLimit:usageLimit, baseline:baseline};
                    }
                    return {state:loading || stopControl || injectedGenerating ? 'generating' : 'disabled', domGenerating:loading || stopControl || stopped, injectedGenerating:injectedGenerating, canContinue:continueControl, count:bodies.length, text:lastText, finalText:finalText, reasoning:reasoning, copyCount:copyCount, newCopyButton:newCopyButton, usageLimit:usageLimit, baseline:baseline};
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
                const finalBodyToolCall = options.allowReasoningToolCall && snapshot
                    ? extractDshToolCallsFromText(snapshot.finalText)
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
                if (finalBodyToolCall) {
                    finalBodyToolStablePolls = finalBodyToolCall === finalBodyToolSignature ? finalBodyToolStablePolls + 1 : 0;
                    finalBodyToolSignature = finalBodyToolCall;
                } else {
                    finalBodyToolStablePolls = 0;
                    finalBodyToolSignature = '';
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
                const quietForMs = Date.now() - lastActivityAt;
                if (rawPending && finalBodyToolCall && finalBodyToolStablePolls >= TOOL_STABLE_POLLS && snapshot && snapshot.newCopyButton && !snapshot.domGenerating) {
                    return { done: true, reason: 'dom_tool_fallback', continuations, bodyToolCall: true, rawFallback: true };
                } else if (!rawPending && bodyToolCall && bodyToolStablePolls >= TOOL_STABLE_POLLS && snapshot && !snapshot.domGenerating) {
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
                } else if (rawPending && snapshot && snapshot.newCopyButton && !snapshot.domGenerating && stablePolls >= 5 && quietForMs >= RAW_DOM_FALLBACK_QUIET_MS) {
                    return { done: true, reason: 'dom_idle_fallback', continuations, rawFallback: true };
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

module.exports = { createDeepseekServer, extractDshToolCallsFromReasoning, extractDshToolCallsFromText, parseDshToolCall, normalizeDshToolCall, hasIncompleteDshToolEnvelope, isStableDeepseekCompletion, parseDeepseekRawSse, mergeContinuationText, mergeRawResponseRecord, createRawResponseAggregate, detectReasoningLoop, activeDeepseekHistoryMessages, reconcileDeepseekHistory };
