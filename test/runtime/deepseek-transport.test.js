'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { extractDshToolCallsFromReasoning, extractDshToolCallsFromText, parseDshToolCall, hasIncompleteDshToolEnvelope, isStableDeepseekCompletion, parseDeepseekRawSse, mergeContinuationText, mergeRawResponseRecord, createRawResponseAggregate, createDeepseekServer, detectReasoningLoop, activeDeepseekHistoryMessages, reconcileDeepseekHistory } = require('../../server-deepseek');

test('DeepSeek history reconciliation follows the active branch and selects the latest exact user turn', () => {
  const payload = { data: { biz_data: {
    current_message_id: 'a2',
    chat_messages: [
      { message_id: 'u1', role: 'user', content: 'same prompt' },
      { message_id: 'a1', parent_message_id: 'u1', role: 'assistant', content: 'old answer', status: 'FINISHED' },
      { message_id: 'u2', parent_message_id: 'a1', role: 'user', content: 'same prompt' },
      { message_id: 'stale', parent_message_id: 'u2', role: 'assistant', content: 'wrong branch', status: 'FINISHED' },
      { message_id: 'a2', parent_message_id: 'u2', role: 'assistant', content: 'recovered answer', thinking_content: 'recovered thought', status: 'FINISHED' }
    ]
  } } };
  assert.deepEqual(activeDeepseekHistoryMessages(payload).map((message) => message.id), ['u1', 'a1', 'u2', 'a2']);
  assert.deepEqual(reconcileDeepseekHistory(payload, 'same prompt'), {
    matched: true,
    assistantFound: true,
    complete: true,
    markdown: 'recovered answer',
    reasoning: 'recovered thought',
    status: 'FINISHED',
    userMessageId: 'u2',
    assistantMessageId: 'a2'
  });
});

test('DeepSeek history distinguishes an unpersisted turn from a persisted turn without an answer', () => {
  const payload = { data: { biz_data: { messages: [{ id: 'u1', role: 'user', content: 'persisted' }] } } };
  assert.deepEqual(reconcileDeepseekHistory(payload, 'persisted'), {
    matched: true,
    assistantFound: false,
    complete: false,
    userMessageId: 'u1'
  });
  assert.equal(reconcileDeepseekHistory(payload, 'missing').matched, false);
});

test('DeepSeek webpage new-chat transport bypasses the legacy default prompt builder', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', '..', 'inject-deepseek.js'), 'utf8');
  assert.match(source, /__dsagent_getInitPromptText = async function\(mode\) \{[\s\S]{0,240}return '';/);
  assert.match(source, /__dsagent_sendMessage = async function\(text, promptPassthrough\)[\s\S]{0,600}fillAndSend\(text\)/);
  const start = source.indexOf('window.__dsagent_newChatAndSendInit =');
  const transport = source.slice(start, source.indexOf('// ====================', start));
  assert.match(transport, /fillAndSend\(visibleUserText\)/);
  assert.match(transport, /await setDeepThink\(!!deepthink\)/);
  assert.doesNotMatch(transport, /mode === 'image'[\s\S]{0,120}setDeepThink\(false\)/);
  assert.match(transport, /return \{ success: true, messageIncluded: true/);
  assert.ok(transport.indexOf('return { success: true, messageIncluded: true') < transport.indexOf('__dsagent_getInitPromptText'));
});

test('DeepSeek long waits fail closed instead of extracting an unfinished reasoning card', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', '..', 'server-deepseek.js'), 'utf8');
  assert.match(source, /if \(!outcome\.done\)/);
  assert.match(source, /outcome\.reason === 'timeout' \? 'provider_timeout'/);
  assert.match(source, /return \{ done: false, reason: 'timeout', continuations \}/);
  assert.match(source, /contentSeen && stablePolls >= FALLBACK_STABLE_POLLS/);
  assert.match(source, /snapshot\.text \+ ':' \+ String\(snapshot\.reasoning \|\| ''\)/);
  assert.match(source, /stopControl \|\| injectedGenerating/);
  assert.match(source, /reason: 'reasoning_only'/);
  assert.match(source, /reason: 'stalled'/);
  assert.match(source, /bodyToolStablePolls >= TOOL_STABLE_POLLS/);
  assert.match(source, /nativeIdlePolls >= NATIVE_IDLE_POLLS && stablePolls >= 2/);
  assert.match(source, /!incompleteBodyToolCall && wasGenerating && nativeIdlePolls/);
  assert.match(source, /!incompleteBodyToolCall && contentSeen && stablePolls >= FALLBACK_STABLE_POLLS/);
  assert.match(source, /reason: 'dom_tool_fallback'/);
  assert.match(source, /quietForMs >= RAW_DOM_FALLBACK_QUIET_MS/);
  assert.match(source, /!snapshot\.domGenerating/);
  assert.match(source, /isStableDeepseekCompletion\(snapshot, contentSeen, stablePolls, Date\.now\(\) - lastActivityAt\)/);
  const waitBody = source.slice(source.indexOf('async function waitForDoneInternal'), source.indexOf('async function extractResponseInternal'));
  assert.match(waitBody, /var injectedGenerating = window\.__dsagent_isGenerating/);
  assert.match(waitBody, /Date\.now\(\) - lastActivityAt >= 90000/);
  assert.match(waitBody, /reason: 'initial_response_timeout'/);
  assert.match(waitBody, /snapshot\.usageLimit && snapshot\.usageLimit\.limited/);
  assert.match(waitBody, /var usageLimit = window\.__dsagent_getUsageLimitState \? window\.__dsagent_getUsageLimitState\(\) : \{limited:false\};/);
  assert.match(waitBody, /consecutivePollErrors >= 8/);
  assert.match(waitBody, /code: 'provider_page_error'/);
  assert.match(source, /code === 'out_of_usage'/);
  assert.match(waitBody, /options\.signal && options\.signal\.aborted/);
  assert.match(source, /provider_send_unconfirmed/);
  const injection = fs.readFileSync(path.join(__dirname, '..', '..', 'inject-deepseek.js'), 'utf8');
  assert.match(injection, /waitForSendAcceptance/);
  assert.match(injection, /DeepSeek did not confirm that the message was accepted/);
  assert.match(injection, /function usageLimitState\(\)/);
  assert.match(injection, /消息发送过于频繁/);
  assert.match(injection, /code: limited \? 'out_of_usage'/);
  assert.match(injection, /window\.__dsagent_isGenerating = function\(\) \{[\s\S]{0,300}isStopGenerationControl\(control\)/);
  const stopDetector = injection.slice(injection.indexOf('function isStopGenerationControl'), injection.indexOf('async function waitForSendAcceptance'));
  assert.doesNotMatch(stopDetector, /querySelector\('svg rect'\)\s*&&\s*\(_wasAiGenerating/);
});

test('DeepSeek accepts stable completed content when only the legacy injected flag is stale', () => {
  assert.equal(isStableDeepseekCompletion({ domGenerating: false, injectedGenerating: true }, true, 20), true);
  assert.equal(isStableDeepseekCompletion({ domGenerating: false, injectedGenerating: true, newCopyButton: true }, true, 0), false);
  assert.equal(isStableDeepseekCompletion({ domGenerating: false, injectedGenerating: true, newCopyButton: true }, true, 2, 299), false);
  assert.equal(isStableDeepseekCompletion({ domGenerating: false, injectedGenerating: true, newCopyButton: true }, true, 2, 300), true);
  assert.equal(isStableDeepseekCompletion({ domGenerating: false, newCopyButton: true, text: ['```dsh-tool-call', '{"name":"pwsh"', '```'].join('\n') }, true, 20, 1000), false);
  assert.equal(isStableDeepseekCompletion({ domGenerating: false, newCopyButton: true, text: ['```dsh-tool-call', '{"name":"pwsh","arguments":{"command":"pwd"}}', '```'].join('\n') }, true, 2, 300), true);
  assert.equal(isStableDeepseekCompletion({ domGenerating: true, injectedGenerating: true, newCopyButton: true }, true, 20), false);
  assert.equal(isStableDeepseekCompletion({ domGenerating: true, injectedGenerating: true }, true, 20), false);
  assert.equal(isStableDeepseekCompletion({ domGenerating: false, injectedGenerating: true }, true, 19), false);
  assert.equal(isStableDeepseekCompletion({ domGenerating: false, injectedGenerating: true }, false, 30), false);
});

test('an unfinished DSH tool envelope blocks every early completion path', () => {
  assert.equal(hasIncompleteDshToolEnvelope(['```dsh-tool-call', '{"name":"pw', '```'].join('\n')), true);
  assert.equal(hasIncompleteDshToolEnvelope(['```dsh-tool-call', '{"name":"pwsh","arguments":{"command":"pwd"}}', '```'].join('\n')), false);
  assert.equal(hasIncompleteDshToolEnvelope('<｜｜DSML｜｜ calls>\n<｜｜DSML｜｜ invoke name="pwsh">'), true);
});

test('DeepSeek raw SSE preserves PowerShell dollar variables before DOM rendering', () => {
  const raw = [
    'data: {"v":{"response":{"status":"WIP","fragments":[{"type":"RESPONSE","content":"<｜DSML｜tool_calls>\\n<｜DSML｜invoke name=\\"pwsh\\">\\n<｜DSML｜parameter name=\\"command\\">Get-ChildItem | ForEach-Object { $"}]}}}',
    '',
    'data: {"p":"response/fragments/-1/content","o":"APPEND","v":"_.FullName }; if ($LAST"}',
    '',
    'data: {"v":"EXITCODE -ne 0) { $s = $_ }</｜DSML｜parameter>\\n</｜DSML｜invoke>\\n</｜DSML｜tool_calls>"}',
    '',
    'data: {"p":"response/status","o":"SET","v":"FINISHED"}',
    '',
    'event: close',
    'data: {"click_behavior":"none"}',
    ''
  ].join('\n');
  const parsed = parseDeepseekRawSse(raw);
  assert.equal(parsed.finished, true);
  assert.match(parsed.markdown, /\$_\.FullName/);
  assert.match(parsed.markdown, /\$LASTEXITCODE/);
  assert.match(parsed.markdown, /\$s = \$_/);
});

test('DeepSeek raw SSE treats path deltas without o as APPEND across THINK and RESPONSE fragments', () => {
  const raw = [
    'data: {"v":{"response":{"status":"WIP","fragments":[{"id":2,"type":"THINK","content":"需要"}]}}}',
    '',
    'data: {"p":"response/fragments/-1/content","o":"APPEND","v":"回答"}',
    '',
    'data: {"p":"response/fragments","o":"APPEND","v":[{"id":3,"type":"RESPONSE","content":"我是"}]}',
    '',
    'data: {"p":"response/fragments/-1/content","v":" **"}',
    '',
    'data: {"v":"WebAgent"}',
    '',
    'data: {"v":"**。"}',
    '',
    'data: {"p":"response/status","o":"SET","v":"FINISHED"}',
    '',
    'event: close',
    'data: {}',
    ''
  ].join('\n');
  const parsed = parseDeepseekRawSse(raw);
  assert.equal(parsed.reasoning, '需要回答');
  assert.equal(parsed.markdown, '我是 **WebAgent**。');
  assert.equal(parsed.finished, true);
});

test('DeepSeek continuation responses are joined without duplicating repeated prefixes', () => {
  assert.equal(mergeContinuationText('第一段。', '第二段。'), '第一段。第二段。');
  assert.equal(mergeContinuationText('第一段。', '第一段。第二段。'), '第一段。第二段。');
  assert.equal(mergeContinuationText('abcdef', 'defghi'), 'abcdefghi');
  const aggregate = createRawResponseAggregate();
  const first = mergeRawResponseRecord(aggregate, { source: 'cdp', seq: 1 }, { markdown: '第一段。', reasoning: '想法一', finished: true });
  const second = mergeRawResponseRecord(aggregate, { source: 'cdp', seq: 2 }, { markdown: '第二段。', reasoning: '想法二', finished: true });
  assert.equal(first.markdown, '第一段。');
  assert.equal(second.markdown, '第一段。第二段。');
  assert.equal(second.reasoning, '想法一想法二');
  assert.equal(second.recordKey, 'cdp:2');
});

test('an observed SSE remains authoritative when SPA navigation drops its capture record', async () => {
  let reads = 0;
  const raw = 'data: ' + JSON.stringify({ v: { response: { status: 'WIP', fragments: [{ type: 'RESPONSE', content: 'CAPTURED_BEFORE_NAVIGATION' }] } } }) + '\n\n';
  const view = {
    webContents: {
      isDestroyed: () => false,
      executeJavaScript: async (source) => source === '1'
        ? 1
        : source.includes("var labels = ['继续生成'") ? { found: false, clicked: false } : null
    },
    completionStreamAfter: async () => ++reads === 1
      ? { source: 'page-fetch', seq: 1, text: raw, done: false, logicalDone: false }
      : null
  };
  const server = createDeepseekServer(view);
  const waited = await server.invoke('deepseek.web', 'waitForDone', { timeout: 2500 });
  assert.equal(waited.success, true);
  assert.equal(waited.data.reason, 'raw_network_ended');
  const extracted = await server.invoke('deepseek.web', 'extractResponse', {});
  assert.equal(extracted.data.markdown, 'CAPTURED_BEFORE_NAVIGATION');
});

test('SSE completion automatically clicks Continue generating and waits for the next network response', async () => {
  let continued = false;
  let continueClicks = 0;
  const makeRaw = (content) => [
    'data: ' + JSON.stringify({ v: { response: { status: 'FINISHED', fragments: [{ type: 'RESPONSE', content }] } } }),
    '',
    'event: close',
    'data: {}',
    ''
  ].join('\n');
  const view = {
    webContents: {
      isDestroyed: () => false,
      executeJavaScript: async (source) => {
        if (source === '1') return 1;
        if (source.includes("var labels = ['继续生成'")) {
          if (!continued) {
            continued = true;
            continueClicks += 1;
            return { found: true, clicked: true, label: '继续生成' };
          }
          return { found: false, clicked: false };
        }
        return null;
      }
    },
    completionStreamAfter: async () => continued
      ? { source: 'cdp', seq: 2, text: makeRaw('第二段。'), done: true, logicalDone: true }
      : { source: 'cdp', seq: 1, text: makeRaw('第一段。'), done: true, logicalDone: true }
  };
  const server = createDeepseekServer(view);
  const waited = await server.invoke('deepseek.web', 'waitForDone', { timeout: 3000 });
  assert.equal(waited.success, true);
  assert.equal(waited.data.continuations, 1);
  assert.equal(continueClicks, 1);
  const peeked = await server.invoke('deepseek.web', 'peekResponse', {});
  assert.equal(peeked.data.text, '第一段。第二段。');
});

test('an interrupted pending SSE clicks Continue before CDP reports the old request closed', async () => {
  let continued = false;
  let continueClicks = 0;
  const pendingRaw = 'data: ' + JSON.stringify({ v: { response: { status: 'WIP', fragments: [{ type: 'RESPONSE', content: '中断前。' }] } } }) + '\n\n';
  const finalRaw = [
    'data: ' + JSON.stringify({ v: { response: { status: 'FINISHED', fragments: [{ type: 'RESPONSE', content: '继续后。' }] } } }),
    '', 'event: close', 'data: {}', ''
  ].join('\n');
  const view = {
    webContents: {
      isDestroyed: () => false,
      executeJavaScript: async (source) => {
        if (source === '1') return 1;
        if (source.includes("var labels = ['继续生成'")) {
          if (!continued) {
            continued = true;
            continueClicks += 1;
            return { found: true, clicked: true, label: '继续生成', tag: 'DIV', role: 'button' };
          }
          return { found: false, clicked: false };
        }
        return null;
      }
    },
    completionStreamAfter: async () => continued
      ? { source: 'cdp', seq: 2, text: finalRaw, done: true, logicalDone: true }
      : { source: 'cdp', seq: 1, text: pendingRaw, done: false, logicalDone: false }
  };
  const server = createDeepseekServer(view);
  const waited = await server.invoke('deepseek.web', 'waitForDone', { timeout: 3000 });
  assert.equal(waited.success, true);
  assert.equal(waited.data.continuations, 1);
  assert.equal(continueClicks, 1);
  const peeked = await server.invoke('deepseek.web', 'peekResponse', {});
  assert.equal(peeked.data.text, '中断前。继续后。');
});

test('reasoning-only completion keeps probing long enough for a late Continue button', async () => {
  let probes = 0;
  let continued = false;
  const reasoningCall = '<｜DSML｜tool_calls>\n<｜DSML｜invoke name="read">\n<｜DSML｜parameter name="arguments" string="false">{"file_path":"a.js"}</｜DSML｜parameter>\n</｜DSML｜invoke>\n</｜DSML｜tool_calls>';
  const makeRaw = (type, content) => ['data: ' + JSON.stringify({ v: { response: { status: 'FINISHED', fragments: [{ type, content }] } } }), '', 'event: close', 'data: {}', ''].join('\n');
  const view = {
    webContents: {
      isDestroyed: () => false,
      executeJavaScript: async (source) => {
        if (source === '1') return 1;
        if (source.includes("var labels = ['继续生成'")) {
          probes += 1;
          if (!continued && probes >= 7) { continued = true; return { found: true, clicked: true, label: '继续生成' }; }
          return { found: false, clicked: false };
        }
        return null;
      }
    },
    completionStreamAfter: async () => continued
      ? { source: 'cdp', seq: 2, text: makeRaw('RESPONSE', '续写正文'), done: true, logicalDone: true }
      : { source: 'cdp', seq: 1, text: makeRaw('THINK', reasoningCall), done: true, logicalDone: true }
  };
  const server = createDeepseekServer(view);
  const waited = await server.invoke('deepseek.web', 'waitForDone', { timeout: 4000, allowReasoningToolCall: true });
  assert.equal(waited.success, true);
  assert.equal(waited.data.continuations, 1);
  assert.ok(probes >= 7);
  const extracted = await server.invoke('deepseek.web', 'extractResponse', { allowReasoningToolCall: true });
  assert.equal(extracted.data.markdown, '续写正文');
});

test('Continue generating uses trusted pointer input when the provider host supports it', async () => {
  let continued = false;
  const pointerEvents = [];
  const makeRaw = (content) => ['data: ' + JSON.stringify({ v: { response: { status: 'FINISHED', fragments: [{ type: 'RESPONSE', content }] } } }), '', 'event: close', 'data: {}', ''].join('\n');
  const view = {
    webContents: {
      isDestroyed: () => false,
      executeJavaScript: async (source) => {
        if (source === '1') return 1;
        if (source.includes("var labels = ['继续生成'")) return continued
          ? { found: false, clicked: false }
          : { found: true, clicked: false, label: '继续生成', x: 320, y: 240 };
        return null;
      },
      sendInputEvent: async (event) => {
        pointerEvents.push(event);
        if (event.type === 'mouseUp') continued = true;
      }
    },
    completionStreamAfter: async () => continued
      ? { source: 'cdp', seq: 2, text: makeRaw('继续后的完整正文'), done: true, logicalDone: true }
      : { source: 'cdp', seq: 1, text: makeRaw('截断正文'), done: true, logicalDone: true }
  };
  const server = createDeepseekServer(view);
  const waited = await server.invoke('deepseek.web', 'waitForDone', { timeout: 3000 });
  assert.equal(waited.success, true);
  assert.equal(waited.data.continuations, 1);
  assert.deepEqual(pointerEvents.map((event) => event.type), ['mouseMove', 'mouseDown', 'mouseUp']);
  const extracted = await server.invoke('deepseek.web', 'extractResponse', {});
  assert.equal(extracted.data.markdown, '截断正文继续后的完整正文');
});

test('Continue generating retries when the first trusted click produces no newer SSE request', async () => {
  let clickAttempts = 0;
  let continued = false;
  const makeRaw = (content) => ['data: ' + JSON.stringify({ v: { response: { status: 'FINISHED', fragments: [{ type: 'RESPONSE', content }] } } }), '', 'event: close', 'data: {}', ''].join('\n');
  const view = {
    webContents: {
      isDestroyed: () => false,
      executeJavaScript: async (source) => {
        if (source === '1') return 1;
        if (source.includes("var labels = ['继续生成'")) return continued
          ? { found: false, clicked: false }
          : { found: true, clicked: false, label: '继续生成', x: 320, y: 240 };
        return null;
      },
      clickVisibleButton: async (_labels, options) => {
        if (continued) return { found: false, clicked: false };
        clickAttempts += 1;
        if (clickAttempts >= 2) continued = true;
        return { found: true, clicked: options.click !== false, label: '继续生成', trusted: true, method: 'playwright-button' };
      }
    },
    completionStreamAfter: async () => continued
      ? { source: 'cdp', seq: 2, text: makeRaw('续写已开始'), done: true, logicalDone: true }
      : { source: 'cdp', seq: 1, text: makeRaw('首段'), done: true, logicalDone: true }
  };
  const server = createDeepseekServer(view);
  const waited = await server.invoke('deepseek.web', 'waitForDone', { timeout: 5000 });
  assert.equal(waited.success, true);
  assert.equal(waited.data.continuations, 1);
  assert.equal(clickAttempts, 2);
  const extracted = await server.invoke('deepseek.web', 'extractResponse', {});
  assert.equal(extracted.data.markdown, '首段续写已开始');
});

test('newChat resets the raw SSE boundary before sending the first message', async () => {
  let resets = 0;
  const view = {
    webContents: {
      isDestroyed: () => false,
      executeJavaScript: async (source) => {
        if (source === '1') return 1;
        if (source.includes('__dsagent_newChatAndSendInit')) return { success: true, deepseekUrl: 'https://chat.deepseek.com/a/chat/s/fresh' };
        return null;
      }
    },
    resetRawCompletionStreams: async () => { resets += 1; return { cdp: 7, page: 4 }; }
  };
  const server = createDeepseekServer(view);
  const created = await server.invoke('deepseek.web', 'newChat', { userText: 'hello' });
  assert.equal(created.success, true);
  assert.equal(resets, 1);
});

test('DeepSeek new-chat transport accepts the blank root surface and English New chat label', () => {
  const injection = fs.readFileSync(path.join(__dirname, '..', '..', 'inject-deepseek.js'), 'utf8');
  const newChat = injection.slice(injection.indexOf('async function findNewChatButton'), injection.indexOf('function resetContextState'));
  const send = injection.slice(injection.indexOf('window.__dsagent_newChatAndSendInit'), injection.indexOf('window.__dsagent_getStatus'));
  assert.match(newChat, /New chat/);
  assert.match(send, /alreadyBlank = pathname === '\/'/);
  assert.match(send, /ta = getInputBox\(\)/);
  assert.match(send, /await setWebSearch\(!!enableWebSearch\)/);
  assert.match(injection, /window\.__dsagent_setWebSearch/);
  assert.match(injection, /findToggleByLabel\('Search'\)/);
  assert.match(injection, /Deep\\s\*Think/);
  assert.match(injection, /Continue generating/);
  assert.match(injection, /'Delete chat'/);
  assert.match(injection, /\[role="dialog"\]/);
  assert.match(injection, /waitForConfirmButton\(5000\)/);
});

test('DeepSeek search state does not confuse button availability with selection', () => {
  const injection = fs.readFileSync(path.join(__dirname, '..', '..', 'inject-deepseek.js'), 'utf8');
  const source = injection.slice(injection.indexOf('function toggleState('), injection.indexOf('function isToggleActive('));
  const node = (className) => ({
    className,
    querySelectorAll: () => [],
    matches: () => false,
    getAttribute: () => null
  });
  const context = { node: node('ds-toggle-button ds-toggle-button--enabled'), result: null };
  vm.runInNewContext(source + '; result=toggleState(node);', context);
  assert.equal(context.result.known, false);
  context.node = node('ds-toggle-button ds-toggle-button--selected');
  vm.runInNewContext(source + '; result=toggleState(node);', context);
  assert.equal(context.result.known, true);
  assert.equal(context.result.active, true);
});

test('DeepSeek English delete dialog selects Delete chat and never Cancel', () => {
  const injection = fs.readFileSync(path.join(__dirname, '..', '..', 'inject-deepseek.js'), 'utf8');
  const source = injection.slice(injection.indexOf('function findConfirmButton()'), injection.indexOf('function waitForConfirmButton'));
  const element = (text) => ({
    textContent: text,
    getAttribute: () => null,
    getBoundingClientRect: () => ({ width: 100, height: 36 })
  });
  const cancel = element('Cancel');
  const remove = element('Delete chat');
  const dialog = Object.assign(element("This chat can't be recovered."), {
    querySelectorAll: () => [cancel, remove]
  });
  const document = {
    querySelectorAll: (selector) => selector.includes('[role="dialog"]') ? [dialog] : [cancel, remove]
  };
  const context = { document, window: { getComputedStyle: () => ({ display: 'block', visibility: 'visible' }) }, result: null };
  vm.runInNewContext(source + '; result=findConfirmButton();', context);
  assert.equal(context.result, remove);
  assert.notEqual(context.result, cancel);
});

test('an empty DeepSeek SSE with a visible frequency limit fails over before empty-response retry', async () => {
  const emptyRaw = ['data: ' + JSON.stringify({ v: { response: { status: 'FINISHED', fragments: [] } } }), '', 'event: close', 'data: {}', ''].join('\n');
  let limitProbes = 0;
  const view = {
    webContents: {
      isDestroyed: () => false,
      executeJavaScript: async (source) => {
        if (source === '1') return 1;
        if (source.includes('__dsagent_getUsageLimitState')) {
          limitProbes += 1;
          return { limited: true, code: 'out_of_usage', reason: 'rate_limited', retryAfter: 60 };
        }
        return null;
      }
    },
    completionStreamAfter: async () => ({ source: 'cdp', seq: 1, text: emptyRaw, done: true, logicalDone: true })
  };
  const server = createDeepseekServer(view);
  const waited = await server.invoke('deepseek.web', 'waitForDone', { timeout: 3000, allowReasoningToolCall: true });
  assert.equal(waited.success, false);
  assert.equal(waited.code, 'out_of_usage');
  assert.equal(waited.retryAfter, 60);
  assert.equal(limitProbes, 1);
});

test('an empty DeepSeek SSE is recovered from the exact durable history turn after reload', async () => {
  const sentText = 'ordered DSH delta';
  const emptyRaw = ['data: ' + JSON.stringify({ v: { response: { status: 'FINISHED', fragments: [] } } }), '', 'event: close', 'data: {}', ''].join('\n');
  let reloads = 0;
  const view = {
    webContents: {
      isDestroyed: () => false,
      executeJavaScript: async (source) => {
        if (source === '1') return 1;
        if (source.includes('__dsagent_sendMessage')) return { success: true };
        if (source.includes('__dsagent_getUsageLimitState')) return null;
        if (source.includes("var labels = ['继续生成'")) return { found: false, clicked: false };
        return null;
      }
    },
    resetRawCompletionStreams: async () => ({ cdp: 0, page: 0 }),
    completionStreamAfter: async () => reloads ? null : ({ source: 'cdp', seq: 1, text: emptyRaw, done: true, logicalDone: true }),
    reloadConversationHistory: async () => {
      reloads += 1;
      return { seq: reloads, source: 'page-history', json: { data: { biz_data: { messages: [
        { id: 'u1', role: 'user', content: sentText },
        { id: 'a1', parent_id: 'u1', role: 'assistant', content: 'history recovered answer', thinking_content: 'history recovered thought', status: 'FINISHED' }
      ] } } } };
    }
  };
  const server = createDeepseekServer(view);
  assert.equal((await server.invoke('deepseek.web', 'sendMessage', { text: sentText })).success, true);
  const waited = await server.invoke('deepseek.web', 'waitForDone', {
    timeout: 5000,
    initialActivityTimeout: 1000,
    _conversationUrl: 'https://chat.deepseek.com/a/chat/s/session-1'
  });
  assert.equal(waited.success, true);
  assert.equal(waited.data.historyRecovered, true);
  assert.equal(reloads, 1);
  const extracted = await server.invoke('deepseek.web', 'extractResponse', {});
  assert.equal(extracted.success, true);
  assert.equal(extracted.data.markdown, 'history recovered answer');
  assert.equal(extracted.data.think, 'history recovered thought');
  assert.equal(extracted.data.historyRecovered, true);
  assert.equal(extracted.data.rawTransport, false);
});

test('a persisted DeepSeek user turn without an answer is not classified as safe to resend', async () => {
  const sentText = 'do not duplicate this turn';
  const emptyRaw = ['data: ' + JSON.stringify({ v: { response: { status: 'FINISHED', fragments: [] } } }), '', 'event: close', 'data: {}', ''].join('\n');
  let reloads = 0;
  const view = {
    webContents: {
      isDestroyed: () => false,
      executeJavaScript: async (source) => {
        if (source === '1') return 1;
        if (source.includes('__dsagent_sendMessage')) return { success: true };
        if (source.includes('__dsagent_getUsageLimitState')) return null;
        if (source.includes('__dsagent_isExecuting')) return false;
        if (source.includes("var labels = ['继续生成'")) return { found: false, clicked: false };
        return null;
      }
    },
    resetRawCompletionStreams: async () => ({ cdp: 0, page: 0 }),
    completionStreamAfter: async () => ({ source: 'cdp', seq: 1, text: emptyRaw, done: true, logicalDone: true }),
    reloadConversationHistory: async () => {
      reloads += 1;
      return { seq: reloads, source: 'page-history', json: { data: { biz_data: { messages: [
        { id: 'u1', role: 'user', content: sentText }
      ] } } } };
    }
  };
  const server = createDeepseekServer(view);
  await server.invoke('deepseek.web', 'sendMessage', { text: sentText });
  const waited = await server.invoke('deepseek.web', 'waitForDone', {
    timeout: 6000,
    _conversationUrl: 'https://chat.deepseek.com/a/chat/s/session-2'
  });
  assert.equal(waited.success, false);
  assert.equal(waited.code, 'provider_history_incomplete');
  assert.equal(waited.data.historyMatched, true);
  assert.equal(waited.data.originalCode, 'provider_sse_empty');
  assert.equal(reloads, 2);
});

test('the DeepSeek webpage context-limit banner becomes a canonical compaction error', async () => {
  const emptyRaw = ['data: ' + JSON.stringify({ v: { response: { status: 'FINISHED', fragments: [] } } }), '', 'event: close', 'data: {}', ''].join('\n');
  const view = {
    webContents: {
      isDestroyed: () => false,
      executeJavaScript: async (source) => {
        if (source === '1') return 1;
        if (source.includes('__dsagent_getUsageLimitState')) return {
          limited: true,
          contextWindowExceeded: true,
          code: 'context_length_exceeded',
          reason: 'context_window_exceeded'
        };
        return null;
      }
    },
    completionStreamAfter: async () => ({ source: 'cdp', seq: 1, text: emptyRaw, done: true, logicalDone: true })
  };
  const server = createDeepseekServer(view);
  const waited = await server.invoke('deepseek.web', 'waitForDone', { timeout: 3000, allowReasoningToolCall: true });
  assert.equal(waited.success, false);
  assert.equal(waited.code, 'context_length_exceeded');
  assert.match(waited.error, /compact the Harness session/);
  const injection = fs.readFileSync(path.join(__dirname, '..', '..', 'inject-deepseek.js'), 'utf8');
  assert.match(injection, /达到对话长度上限/);
});

test('provider busy detection ignores historical Markdown and tool output text', () => {
  const injection = fs.readFileSync(path.join(__dirname, '..', '..', 'inject-deepseek.js'), 'utf8');
  const detector = injection.slice(injection.indexOf('function providerErrorKind'), injection.indexOf('async function waitForSendAcceptance'));
  assert.match(detector, /captureProviderErrorBaseline/);
  assert.match(detector, /\.ds-markdown/);
  assert.match(detector, /service temporarily unavailable/);
  assert.doesNotMatch(detector, /body\.innerText/);
  assert.doesNotMatch(detector, /service unavailable\|server busy/);
});

test('a complete DSML suffix in reasoning is extracted without exposing surrounding thought', async () => {
  const reasoning = 'private analysis\n<｜DSML｜tool_calls>\n<｜DSML｜invoke name="read">\n<｜DSML｜parameter name="arguments" string="false">{"file_path":"test/headless.js","limit":12,"offset":454}</｜DSML｜parameter>\n</｜DSML｜invoke>\n</｜DSML｜tool_calls>';
  const raw = ['data: ' + JSON.stringify({ v: { response: { status: 'FINISHED', fragments: [{ type: 'THINK', content: reasoning }] } } }), '', 'event: close', 'data: {}', ''].join('\n');
  const view = { webContents: { isDestroyed: () => false, executeJavaScript: async (source) => source === '1' ? 1 : null }, completionStreamAfter: async () => ({ source: 'cdp', seq: 1, text: raw, done: true, logicalDone: true }) };
  const server = createDeepseekServer(view);
  const extracted = await server.invoke('deepseek.web', 'extractResponse', { allowReasoningToolCall: true });
  assert.equal(extracted.success, true);
  assert.match(extracted.data.markdown, /<dsh_tool_call>/);
  assert.match(extracted.data.markdown, /test\/headless\.js/);
  assert.doesNotMatch(extracted.data.markdown, /private analysis/);
  assert.equal(extracted.data.reasoningToolCall, true);
});

test('repeated reasoning phrases trigger a bounded corrective turn', async () => {
  const repeated = Array.from({ length: 5 }, () => 'Let me check.\nLet me emit.').join('\n');
  assert.ok(detectReasoningLoop(repeated));
  assert.equal(detectReasoningLoop('I checked one file and now I will inspect another distinct module.'), null);
  let recovered = false;
  let stopped = 0;
  const pendingRaw = 'data: ' + JSON.stringify({ v: { response: { status: 'WIP', fragments: [{ type: 'THINK', content: repeated }] } } }) + '\n\n';
  const finalRaw = ['data: ' + JSON.stringify({ v: { response: { status: 'FINISHED', fragments: [{ type: 'RESPONSE', content: 'LOOP_RECOVERED' }] } } }), '', 'event: close', 'data: {}', ''].join('\n');
  const view = {
    webContents: {
      isDestroyed: () => false,
      executeJavaScript: async (source) => {
        if (source === '1') return 1;
        if (source.includes('__dsagent_stopGeneration')) { stopped += 1; return { success: true }; }
        if (source.includes('LOOP_RECOVERY')) { recovered = true; return { success: true }; }
        if (source.includes("var labels = ['继续生成'")) return { found: false, clicked: false };
        return null;
      }
    },
    completionStreamAfter: async () => recovered
      ? { source: 'cdp', seq: 2, text: finalRaw, done: true, logicalDone: true }
      : { source: 'cdp', seq: 1, text: pendingRaw, done: false, logicalDone: false }
  };
  const server = createDeepseekServer(view);
  const waited = await server.invoke('deepseek.web', 'waitForDone', { timeout: 5000, allowReasoningToolCall: true });
  assert.equal(waited.success, true);
  assert.equal(waited.data.reasoningLoopRecoveries, 1);
  assert.equal(stopped, 1);
  const extracted = await server.invoke('deepseek.web', 'extractResponse', {});
  assert.equal(extracted.data.markdown, 'LOOP_RECOVERED');
});

test('parallel DSML calls are never mistaken for a prose repetition loop', () => {
  const calls = Array.from({ length: 6 }, (_, index) => [
    '<｜DSML｜invoke name="read">',
    '<｜DSML｜parameter name="arguments" string="false">{"file_path":"file-' + index + '.js"}</｜DSML｜parameter>',
    '</｜DSML｜invoke>'
  ].join('\n')).join('\n');
  const response = '<｜DSML｜tool_calls>\n' + calls + '\n</｜DSML｜tool_calls>';
  assert.equal(detectReasoningLoop(response), null);
});

test('a completed repetitive DSH response is corrected instead of accepted as final output', async () => {
  const repeated = Array.from({ length: 6 }, () => 'Let me check.\nLet me emit.').join('\n');
  let recovered = false;
  const makeRaw = (content) => ['data: ' + JSON.stringify({ v: { response: { status: 'FINISHED', fragments: [{ type: 'RESPONSE', content }] } } }), '', 'event: close', 'data: {}', ''].join('\n');
  const view = {
    webContents: {
      isDestroyed: () => false,
      executeJavaScript: async (source) => {
        if (source === '1') return 1;
        if (source.includes('__dsagent_stopGeneration')) return { success: true };
        if (source.includes('LOOP_RECOVERY')) { recovered = true; return { success: true }; }
        if (source.includes("var labels = ['继续生成'")) return { found: false, clicked: false };
        return null;
      }
    },
    completionStreamAfter: async () => recovered
      ? { source: 'cdp', seq: 2, text: makeRaw('RECOVERED_FINAL'), done: true, logicalDone: true }
      : { source: 'cdp', seq: 1, text: makeRaw(repeated), done: true, logicalDone: true }
  };
  const server = createDeepseekServer(view);
  const waited = await server.invoke('deepseek.web', 'waitForDone', { timeout: 5000, allowReasoningToolCall: true });
  assert.equal(waited.success, true);
  assert.equal(waited.data.reasoningLoopRecoveries, 1);
  const extracted = await server.invoke('deepseek.web', 'extractResponse', { allowReasoningToolCall: true });
  assert.equal(extracted.data.markdown, 'RECOVERED_FINAL');
});

test('DSH recognizes a complete fenced tool call in the rendered answer body', () => {
  assert.equal(
    extractDshToolCallsFromText('```dsh-tool-call\n{"name":"pwsh","arguments":{"command":"npm test"}}\n```'),
    '{"name":"pwsh","arguments":{"command":"npm test"}}'
  );
  assert.equal(extractDshToolCallsFromText('```dsh-tool-call\n{unfinished\n```'), '');
});

test('DSH accepts only valid trailing tool envelopes from a reasoning-only response', () => {
  const source = 'private chain of thought\n<dsh_tool_call>{"name":"pwsh","arguments":{"command":"npm test"},"description":"ignored"}</dsh_tool_call>';
  assert.equal(
    extractDshToolCallsFromReasoning(source),
    '<dsh_tool_call>{"name":"pwsh","arguments":{"command":"npm test"}}</dsh_tool_call>'
  );
  assert.equal(extractDshToolCallsFromReasoning(source + '\nnot a tool suffix'), '');
  assert.equal(extractDshToolCallsFromReasoning('<dsh_tool_call>{bad json}</dsh_tool_call>'), '');
  assert.equal(extractDshToolCallsFromReasoning('<dsh_tool_call>{"name":"pwsh","arguments":"npm test"}</dsh_tool_call>'), '');
});

test('DSH repairs malformed web-model JSON before strict tool-call validation', () => {
  const malformed = '{"name":"write","arguments":{"file_path":"backend/package.json","content":"{\n  "name": "focusflow-backend",\n  "scripts": { "test": "node --test" }\n}\n"}}';
  assert.deepEqual(parseDshToolCall(malformed), {
    name: 'write',
    arguments: {
      file_path: 'backend/package.json',
      content: '{\n  "name": "focusflow-backend",\n  "scripts": { "test": "node --test" }\n}\n'
    }
  });
  assert.equal(parseDshToolCall('{ definitely not recoverable'), null);
});

test('DeepSeek SSE transport disables legacy clipboard automation', () => {
  const injection = fs.readFileSync(path.join(__dirname, '..', '..', 'inject-deepseek.js'), 'utf8');
  assert.match(injection, /let enableAutoExec = false;/);
  const extractor = injection.slice(injection.indexOf('window.__dsagent_extractLastResponse ='), injection.indexOf('// 上传文件到当前对话'));
  assert.ok(extractor.indexOf('clipboardUsed: false') < extractor.indexOf('clipboardSave()'));
  const daemon = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'node', 'dsh-core.js'), 'utf8');
  const hostConfig = daemon.slice(daemon.indexOf('const rawHost = new PlaywrightProviderHost'), daemon.indexOf('const createWorker ='));
  assert.doesNotMatch(hostConfig, /clipboardBridge/);
});
