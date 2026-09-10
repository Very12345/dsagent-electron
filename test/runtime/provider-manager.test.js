'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ProviderManager, collapseRepeatedDomText } = require('../../src/runtime/provider-manager');
const { createDeepseekServer } = require('../../server-deepseek');

test('all qwen.gateway models route only to the Rogator adapter', async () => {
  const calls = [];
  const manager = new ProviderManager({
    rogator: {
      status: () => ({ running: true, upstream: 'qwen', deepseek_enabled: false }),
      complete: async (context) => { calls.push(context.model); return { content: 'gateway ok', reasoning: '' }; },
      stopRun: () => true,
      close: async () => {}
    },
    webFactories: { deepseek: async () => ({}), qwen: async () => ({}), chatgpt: async () => ({}) },
    webModels: [{ id: 'qwen.gateway.3.8-max', provider: 'rogator', displayName: 'Qwen3.8 Max' }]
  });
  const result = await manager.complete({ model: 'qwen.gateway.3.8-max' });
  assert.equal(result.content, 'gateway ok');
  assert.deepEqual(calls, ['qwen.gateway.3.8-max']);
  assert.equal(manager.listModels()[0].owned_by, 'rogator');
  assert.equal(manager.status().qwen_gateway.deepseek_enabled, false);
  assert.equal(await manager.stop({ model: 'qwen.gateway.3.8-max', run_id: 'run-gateway' }), true);
  await manager.close();
});

test('DeepSeek unified model exposes reasoning, search and image input capability', async () => {
  const models = Object.values(createDeepseekServer(() => null).models);
  const manager = new ProviderManager({ webFactories: { deepseek: async () => ({}), qwen: async () => ({}) }, webModels: models });
  const unified = manager.listModels().find((model) => model.id === 'deepseek.web');
  assert.ok(unified);
  assert.deepEqual(unified.capabilities.multimodal.input, ['image']);
  assert.equal(unified.capabilities.deepThink, true);
  assert.equal(unified.capabilities.webSearch, true);
  assert.deepEqual(unified.capabilities.reasoningEfforts, ['none', 'high']);
  await manager.close();
});

test('hidden provider models remain callable internally but are omitted from discovery', async () => {
  const manager = new ProviderManager({ webFactories: { deepseek: async () => ({}), qwen: async () => ({}) }, webModels: [
    { id: 'deepseek.fast' }, { id: 'deepseek.image', hidden: true }
  ] });
  assert.deepEqual(manager.listModels().map((model) => model.id), ['deepseek.fast']);
  assert.equal(manager.webModels.find((model) => model.id === 'deepseek.image').hidden, true);
  await manager.close();
});

test('exact repeated DeepSeek reasoning DOM snapshots are collapsed', () => {
  const block = 'Reasoning paragraph with enough structured content. '.repeat(4);
  assert.equal(collapseRepeatedDomText(block + block), block);
  assert.equal(collapseRepeatedDomText(block + 'different suffix'), block + 'different suffix');
});

test('provider pool defaults and URL ownership validation are strict', async () => {
  const manager = new ProviderManager({
    qwenMax: 8,
    webFactories: { deepseek: async () => ({}), qwen: async () => ({}) },
    webModels: []
  });
  assert.equal(manager.status().deepseek.max, 2);
  assert.equal(manager.status().qwen.max, 8);
  assert.equal(manager.status().chatgpt.max, 2);
  assert.equal(manager._validWebUrl('deepseek', 'https://chat.deepseek.com/a/chat/s/abc'), true);
  assert.equal(manager._validWebUrl('deepseek', 'https://chat.deepseek.com.evil.test/a/chat/s/abc'), false);
  assert.equal(manager._validWebUrl('qwen', 'https://www.qianwen.com/chat/abc'), true);
  assert.equal(manager._validWebUrl('qwen', 'https://www.qianwen.com.evil.test/chat/abc'), false);
  assert.equal(manager._validWebUrl('chatgpt', 'https://chatgpt.com/c/abc'), true);
  assert.equal(manager._validWebUrl('chatgpt', 'https://chatgpt.com/c/WEB:temporary-id'), false);
  assert.equal(manager._validWebUrl('chatgpt', 'https://chatgpt.com.evil.test/c/abc'), false);
  const deleted = await manager.cleanupSession({ id: 'child', model: 'qwen.default', provider_state: { provider: 'qwen', url: 'https://evil.test/chat/abc', last_run_id: 'run-a' } }, 'run-a', 'call-a');
  assert.equal(deleted, false, 'an unowned URL must never be navigated to or deleted');
  await manager.close();
});

test('ChatGPT cleanup ignores a retired temporary WEB URL and deletes the verified conversation', async () => {
  const calls = [];
  const actualUrl = 'https://chatgpt.com/c/6a7c0fd9-81c8-83ec-813c-cb5abf32c756';
  const worker = {
    ensureAuthenticated: async () => true,
    navigate: async (url) => { calls.push(['navigate', url]); },
    assertConversation: async (url) => { calls.push(['assertConversation', url]); },
    server: { invoke: async (_model, operation, args) => {
      calls.push([operation, args]);
      return { success: true };
    } }
  };
  const manager = new ProviderManager({
    webFactories: { deepseek: async () => ({}), qwen: async () => ({}), chatgpt: async () => worker }
  });
  const deleted = await manager.cleanupSession({
    id: 'legacy-chatgpt-session', model: 'chatgpt.web',
    provider_state: {
      provider: 'chatgpt', url: actualUrl, last_run_id: 'run-legacy',
      conversations: [
        { provider: 'chatgpt', url: 'https://chatgpt.com/c/WEB:temporary-id', status: 'retiring' },
        { provider: 'chatgpt', url: actualUrl, status: 'active' }
      ]
    }
  }, 'run-legacy');
  assert.equal(deleted, true);
  assert.deepEqual(calls.filter((call) => call[0] === 'navigate'), [['navigate', actualUrl]]);
  assert.deepEqual(calls.find((call) => call[0] === 'deleteConversation'), ['deleteConversation', { convid: actualUrl, _conversationUrl: actualUrl }]);
  await manager.close();
});

test('stalled web conversations are invalidated before an external retry', async () => {
  const manager = new ProviderManager({ webFactories: { deepseek: async () => ({}), qwen: async () => ({}) } });
  const url = 'https://chat.deepseek.com/a/chat/s/stalled';
  const state = manager.invalidateConversation({
    provider: 'deepseek',
    url,
    conversations: [{ provider: 'deepseek', url, status: 'active', created_at: 'now' }]
  }, url, 'response stalled');
  assert.equal(state.url, '');
  assert.equal(state.conversations[0].status, 'pending_cleanup');
  assert.equal(state.last_failure_url, url);
  await manager.close();
});

test('an unconfirmed DeepSeek send retires the stale conversation before DSH retries', async () => {
  const url = 'https://chat.deepseek.com/a/chat/s/unconfirmed';
  const worker = {
    ensureAuthenticated: async () => true,
    navigate: async () => true,
    assertConversation: async () => true,
    server: { invoke: async (_model, method) => {
      if (method === 'setDeepThink' || method === 'setWebSearch' || method === 'sendMessage') return { success: true };
      if (method === 'waitForDone') return { success: false, code: 'provider_send_unconfirmed', error: 'no activity' };
      if (method === 'peekResponse') return { success: true, data: { text: '' } };
      throw new Error('unexpected method: ' + method);
    } }
  };
  const manager = new ProviderManager({ webFactories: { deepseek: async () => worker, qwen: async () => ({}) } });
  const state = { provider: 'deepseek', url, conversations: [{ provider: 'deepseek', url, status: 'active' }] };
  const error = await manager.complete({
    model: 'deepseek.web', session: { id: 'unconfirmed', provider_state: state }, messages: [{ role: 'user', content: 'retry me' }], instructions: '',
    run: { id: 'run-unconfirmed', prompt_passthrough: false, deep_think: false, web_search: false }, signal: new AbortController().signal, timeout: 1000
  }).then(() => null, (failure) => failure);
  assert.equal(error.code, 'provider_send_unconfirmed');
  assert.equal(error.provider_state.url, '');
  assert.equal(error.provider_state.conversations[0].status, 'pending_cleanup');
  await manager.close();
});

test('DeepSeek out-of-usage keeps the remote conversation for a later retry', async () => {
  const url = 'https://chat.deepseek.com/a/chat/s/rate-limited';
  const worker = {
    ensureAuthenticated: async () => true,
    navigate: async () => true,
    assertConversation: async () => true,
    server: { invoke: async (_model, method) => {
      if (method === 'setDeepThink' || method === 'setWebSearch' || method === 'sendMessage') return { success: true };
      if (method === 'waitForDone') return { success: false, code: 'out_of_usage', error: 'wait before retrying', retryAfter: 60 };
      if (method === 'peekResponse') return { success: true, data: { text: '' } };
      throw new Error('unexpected method: ' + method);
    } }
  };
  const manager = new ProviderManager({ webFactories: { deepseek: async () => worker, qwen: async () => ({}) } });
  const previousBridge = { version: 3, prompt_hash: 'before', tools_hash: 'tools', message_count: 1, message_signatures: ['before'] };
  const state = { provider: 'deepseek', url, dsh_bridge: previousBridge, conversations: [{ provider: 'deepseek', url, status: 'active' }] };
  const error = await manager.complete({
    model: 'deepseek.web', session: { id: 'rate-limited', provider_state: state }, messages: [{ role: 'user', content: 'retry later' }], instructions: '',
    run: { id: 'run-rate-limited', prompt_passthrough: false, deep_think: false, web_search: false }, signal: new AbortController().signal, timeout: 1000
  }).then(() => null, (failure) => failure);
  assert.equal(error.code, 'out_of_usage');
  assert.equal(error.status, 429);
  assert.equal(error.retry_after_seconds, 60);
  assert.equal(error.provider_state.url, url);
  assert.deepEqual(error.provider_state.dsh_bridge, previousBridge);
  assert.equal(error.provider_state.conversations[0].status, 'active');
  assert.ok(error.provider_state.rate_limited_until);
  await manager.close();
});

test('a known DeepSeek account cooldown fails immediately without leasing a worker', async () => {
  let workersCreated = 0;
  const manager = new ProviderManager({
    webFactories: {
      deepseek: async () => { workersCreated += 1; return {}; },
      qwen: async () => ({})
    },
    accountManager: {
      activeAccount: () => 'limited-account',
      listAccounts: () => ({
        data: [{ id: 'limited-account', limited_until: new Date(Date.now() + 30000).toISOString() }]
      })
    }
  });
  const error = await manager.complete({
    model: 'deepseek.web', session: { id: 'cooldown', provider_state: {} }, messages: [{ role: 'user', content: 'retry now' }], instructions: '',
    run: { id: 'run-cooldown', prompt_passthrough: false, deep_think: false, web_search: false }, signal: new AbortController().signal, timeout: 1000
  }).then(() => null, (failure) => failure);
  assert.equal(error.code, 'out_of_usage');
  assert.equal(error.status, 429);
  assert.ok(error.retry_after_seconds > 0 && error.retry_after_seconds <= 30);
  assert.equal(workersCreated, 0);
  await manager.close();
});

test('ChatGPT login accepts UI and model aliases', async () => {
  const opened = [];
  const manager = new ProviderManager({
    webFactories: { deepseek: async () => ({}), qwen: async () => ({}), chatgpt: async () => ({}) },
    onAuthRequired: async (provider) => { opened.push(provider); }
  });
  assert.deepEqual(manager.supportedWebProviders(), ['deepseek', 'qwen', 'chatgpt']);
  assert.deepEqual(await manager.authenticate('chatgpt'), { provider: 'chatgpt', account_id: 'default', login_opened: true });
  assert.deepEqual(await manager.authenticate('chatgpt.web'), { provider: 'chatgpt', account_id: 'default', login_opened: true });
  assert.deepEqual(await manager.authenticate('openai'), { provider: 'chatgpt', account_id: 'default', login_opened: true });
  assert.deepEqual(opened, ['chatgpt', 'chatgpt', 'chatgpt']);
  await manager.close();
});

test('Qwen maximum is clamped to the configured 1-16 range', async () => {
  const low = new ProviderManager({ qwenMax: 0, webFactories: { deepseek: async () => ({}), qwen: async () => ({}) } });
  const high = new ProviderManager({ qwenMax: 100, webFactories: { deepseek: async () => ({}), qwen: async () => ({}) } });
  assert.equal(low.status().qwen.max, 8);
  assert.equal(high.status().qwen.max, 16);
  await low.close();
  await high.close();
});

test('web progress polling forwards reasoning separately from answer text', async () => {
  const manager = new ProviderManager({ webFactories: { deepseek: async () => ({}), qwen: async () => ({}) } });
  const reasoning = [];
  const text = [];
  const worker = { server: { invoke: async () => ({ success: true, data: { reasoning: 'live thought', text: 'live answer' } }) } };
  const poll = manager._startProgressPoll(worker, {
    model: 'deepseek.fast',
    signal: new AbortController().signal,
    onReasoningProgress: (value) => reasoning.push(value),
    onProgress: (value) => text.push(value)
  }, 'https://chat.deepseek.com/a/chat/s/reasoning');
  await poll.stop(true);
  assert.deepEqual(reasoning, ['live thought', 'live thought']);
  assert.deepEqual(text, ['live answer', 'live answer']);
  await manager.close();
});

test('an incomplete DeepSeek wait never promotes reasoning to final output', async () => {
  const conversationUrl = 'https://chat.deepseek.com/a/chat/s/incomplete';
  let extracted = false;
  const boundStates = [];
  const worker = {
    ensureAuthenticated: async () => true,
    waitForConversationUrl: async () => conversationUrl,
    isDestroyed: () => false,
    server: { invoke: async (_model, method) => {
      if (method === 'newChat') return { success: true, data: { conversationUrl } };
      if (method === 'peekResponse') return { success: true, data: { reasoning: 'still thinking', text: '' } };
      if (method === 'waitForDone') return { success: false, error: 'DeepSeek response incomplete: timeout', code: 'provider_timeout' };
      if (method === 'extractResponse') { extracted = true; return { success: true, data: { markdown: 'still thinking', think: 'still thinking' } }; }
      throw new Error('unexpected method: ' + method);
    } }
  };
  const manager = new ProviderManager({ webFactories: { deepseek: async () => worker, qwen: async () => ({}) } });
  const failure = await manager.complete({
    model: 'deepseek.fast', session: { id: 'incomplete', provider_state: {} }, messages: [{ role: 'user', content: 'long task' }], instructions: '',
    run: { id: 'run-incomplete', deep_think: true }, signal: new AbortController().signal, timeout: 1000,
    onProviderState: (state) => boundStates.push(state)
  }).then(() => null, (error) => error);
  assert.match(failure.message, /incomplete: timeout/);
  assert.equal(boundStates.length, 1);
  assert.equal(boundStates[0].url, conversationUrl);
  assert.equal(boundStates[0].conversations[0].status, 'active');
  assert.equal(failure.provider_state.url, '');
  assert.equal(failure.provider_state.conversations[0].status, 'pending_cleanup');
  assert.equal(failure.provider_state.conversations[0].url, conversationUrl);
  assert.equal(extracted, false);
  await manager.close();
});

test('cancelling a web run stops only its lease-owned DeepSeek worker', async () => {
  const conversationUrl = 'https://chat.deepseek.com/a/chat/s/cancel-owned';
  const controller = new AbortController();
  const calls = [];
  let waiting;
  const waitStarted = new Promise((resolve) => { waiting = resolve; });
  const worker = {
    ensureAuthenticated: async () => true,
    waitForConversationUrl: async () => conversationUrl,
    isDestroyed: () => false,
    server: { invoke: async (_model, method, args) => {
      calls.push({ method, args });
      if (method === 'newChat') return { success: true, data: { conversationUrl } };
      if (method === 'peekResponse') return { success: true, data: {} };
      if (method === 'waitForDone') {
        waiting();
        while (!args.signal.aborted) await new Promise((resolve) => setTimeout(resolve, 2));
        return { success: false, code: 'run_cancelled', error: 'cancelled' };
      }
      if (method === 'stopGeneration') return { success: true };
      throw new Error('unexpected method: ' + method);
    } }
  };
  const manager = new ProviderManager({ webFactories: { deepseek: async () => worker, qwen: async () => ({}) } });
  const completion = manager.complete({
    model: 'deepseek.pro.web', session: { id: 'cancel-session', provider_state: {} }, messages: [{ role: 'user', content: 'long task' }], instructions: '',
    run: { id: 'cancel-run', call_id: 'cancel-call', deep_think: true }, signal: controller.signal, timeout: 60000
  });
  await waitStarted;
  controller.abort();
  assert.equal(await manager.stop({ model: 'deepseek.pro.web', run: { id: 'cancel-run' } }), true);
  await assert.rejects(completion, { code: 'run_cancelled' });
  assert.equal(calls.filter((call) => call.method === 'stopGeneration').length, 1);
  assert.equal(manager.activeWebRuns.size, 0);
  await manager.close();
});

test('a hung web stop action destroys only the cancelled run worker after a bounded timeout', async () => {
  const conversationUrl = 'https://www.qianwen.com/chat/cancel-hung';
  const controller = new AbortController();
  let waitStarted;
  const waiting = new Promise((resolve) => { waitStarted = resolve; });
  let destroyed = 0;
  const worker = {
    ensureAuthenticated: async () => true,
    waitForConversationUrl: async () => conversationUrl,
    isDestroyed: () => destroyed > 0,
    destroy: async () => { destroyed += 1; },
    server: { invoke: async (_model, method, args) => {
      if (method === 'newChat') return { success: true, data: { conversationUrl } };
      if (method === 'peekResponse') return { success: true, data: {} };
      if (method === 'waitForDone') {
        waitStarted();
        // Simulate a renderer-side executeJavaScript promise that ignores the
        // AbortSignal and settles only when its leased worker is destroyed.
        while (!destroyed) await new Promise((resolve) => setTimeout(resolve, 2));
        return { success: false, code: 'run_cancelled', error: 'cancelled' };
      }
      if (method === 'stopGeneration') return new Promise(() => {});
      throw new Error('unexpected method: ' + method);
    } }
  };
  const manager = new ProviderManager({ webFactories: { deepseek: async () => ({}), qwen: async () => worker }, webStopTimeoutMs: 20 });
  const completion = manager.complete({
    model: 'qwen.3.8-max', session: { id: 'cancel-hung-session', provider_state: {} }, messages: [{ role: 'user', content: 'long task' }], instructions: '',
    run: { id: 'cancel-hung-run', call_id: null, deep_think: false }, signal: controller.signal, timeout: 60000
  });
  const failure = completion.then(() => null, (error) => error);
  await waiting;
  controller.abort();
  assert.equal(await manager.stop({ model: 'qwen.3.8-max', run: { id: 'cancel-hung-run' } }), false);
  assert.equal((await failure).code, 'run_cancelled');
  assert.equal(destroyed, 1);
  assert.equal(manager.activeWebRuns.size, 0);
  await manager.close();
});

test('an unauthenticated web run opens login once and resumes on its original session', async () => {
  let authChecks = 0;
  let loginCalls = 0;
  let newChatArgs = null;
  const conversationUrl = 'https://chat.deepseek.com/a/chat/s/session-one';
  const worker = {
    ensureAuthenticated: async () => {
      authChecks += 1;
      if (authChecks === 1) throw Object.assign(new Error('Login required'), { code: 'provider_auth_required' });
    },
    navigate: async () => true,
    assertConversation: async () => true,
    waitForConversationUrl: async () => conversationUrl,
    isDestroyed: () => false,
    server: {
      invoke: async (_model, method, args) => {
        if (method === 'newChat') { newChatArgs = args; return { success: true, data: { conversationUrl } }; }
        if (method === 'waitForDone') return { success: true };
        if (method === 'extractResponse') return { success: true, data: { markdown: 'LOGIN_OK' } };
        throw new Error('unexpected method: ' + method);
      }
    }
  };
  const manager = new ProviderManager({
    webFactories: { deepseek: async () => worker, qwen: async () => ({}) },
    onAuthRequired: async (provider, owner) => {
      loginCalls += 1;
      assert.equal(provider, 'deepseek');
      assert.equal(owner.session_id, 'session-one');
      assert.equal(owner.run_id, 'run-one');
    }
  });
  let requiredEvents = 0;
  let authenticatedEvents = 0;
  const result = await manager.complete({
    model: 'deepseek.fast',
    session: { id: 'session-one', provider_state: {} },
    messages: [{ role: 'user', content: 'test' }],
    instructions: 'subagents support nested delegation',
    run: { id: 'run-one', call_id: 'call-one', deep_think: true, web_search: true },
    signal: new AbortController().signal,
    timeout: 1000,
    onAuthRequired: () => { requiredEvents += 1; },
    onAuthenticated: () => { authenticatedEvents += 1; }
  });
  assert.equal(result.content, 'LOGIN_OK');
  assert.equal(result.provider_state.last_run_id, 'run-one');
  assert.equal(result.provider_state.last_call_id, 'call-one');
  assert.equal(loginCalls, 1);
  assert.equal(requiredEvents, 1);
  assert.equal(authenticatedEvents, 1);
  assert.equal(authChecks, 2);
  assert.equal(newChatArgs.deepThink, true);
  assert.equal(newChatArgs.webSearch, true);
  assert.match(newChatArgs.userText, /subagents support nested delegation/);
  await manager.close();
});

test('Qwen image responses use the image extractor and preserve image URLs', async () => {
  const conversationUrl = 'https://www.qianwen.com/chat/image-one';
  const calls = [];
  const worker = {
    ensureAuthenticated: async () => true,
    waitForConversationUrl: async () => conversationUrl,
    server: {
      invoke: async (_model, method) => {
        calls.push(method);
        if (method === 'newChat') return { success: true, data: { conversationUrl } };
        if (method === 'waitForDone') return { success: true, data: { done: true, hasImages: false } };
        // Qwen can transiently replace the hydrated card between probes. The
        // durable hasImages signal from waitForDone must still select this path.
        if (method === 'detectResponseType') return { success: true, data: { type: 'text' } };
        if (method === 'waitForImageDone') return { success: true, data: { done: true } };
        if (method === 'extractImageResponse') return { success: true, data: { markdown: '图片已生成', images: ['https://example.test/generated.png'] } };
        if (method === 'peekResponse') return { success: true, data: { text: '' } };
        throw new Error('unexpected method: ' + method);
      }
    }
  };
  const manager = new ProviderManager({ webFactories: { deepseek: async () => ({}), qwen: async () => worker } });
  const result = await manager.complete({
    model: 'qwen.default',
    session: { id: 'qwen-image', provider_state: {} },
    messages: [{ role: 'user', content: '生成一张图片' }],
    instructions: '',
    run: { id: 'run-image', call_id: null, deep_think: false, web_search: false },
    signal: new AbortController().signal,
    timeout: 1000
  });
  assert.deepEqual(result.images, ['https://example.test/generated.png']);
  assert.ok(calls.includes('extractImageResponse'));
  assert.ok(!calls.includes('extractResponse'));
  await manager.close();
});

test('a web conversation created after an initial tool call receives the full task history', async () => {
  const conversationUrl = 'https://chat.deepseek.com/a/chat/s/initial-tools';
  let sentText = '';
  const worker = {
    ensureAuthenticated: async () => true,
    waitForConversationUrl: async () => conversationUrl,
    server: {
      invoke: async (_model, method, args) => {
        if (method === 'newChat') { sentText = args.userText; return { success: true, data: { conversationUrl } }; }
        if (method === 'waitForDone') return { success: true };
        if (method === 'extractResponse') return { success: true, data: { markdown: 'SUMMARY_OK' } };
        if (method === 'peekResponse') return { success: true, data: { text: '' } };
        throw new Error('unexpected method: ' + method);
      }
    }
  };
  const manager = new ProviderManager({ webFactories: { deepseek: async () => worker, qwen: async () => ({}) } });
  const result = await manager.complete({
    model: 'deepseek.fast',
    session: { id: 'initial-tools', provider_state: {} },
    messages: [
      { role: 'user', content: 'original task' },
      { role: 'assistant', content: '', tool_calls: [{ tool: 'read_file' }] },
      { role: 'tool', content: 'confirmed tool result' }
    ],
    instructions: 'runtime instructions',
    run: { id: 'run-initial-tools', call_id: null, deep_think: false, web_search: false },
    signal: new AbortController().signal,
    timeout: 1000
  });
  assert.equal(result.content, 'SUMMARY_OK');
  assert.match(sentText, /runtime instructions/);
  assert.match(sentText, /original task/);
  assert.match(sentText, /confirmed tool result/);
  await manager.close();
});

test('DSH webpage transport preserves the DSH-owned system prompt and ordered context', async () => {
  const conversationUrl = 'https://chat.deepseek.com/a/chat/s/dsh-passthrough';
  let sentText = '';
  let waitArgs = null;
  let extractArgs = null;
  const worker = {
    ensureAuthenticated: async () => true,
    waitForConversationUrl: async () => conversationUrl,
    server: {
      invoke: async (_model, method, args) => {
        if (method === 'newChat') {
          sentText = args.userText;
          return { success: true, data: { conversationUrl } };
        }
        if (method === 'waitForDone') { waitArgs = args; return { success: true }; }
        if (method === 'extractResponse') { extractArgs = args; return { success: true, data: { markdown: 'PASSTHROUGH_OK' } }; }
        if (method === 'peekResponse') return { success: true, data: { text: '' } };
        throw new Error('unexpected method: ' + method);
      }
    }
  };
  const manager = new ProviderManager({ webFactories: { deepseek: async () => worker, qwen: async () => ({}) } });
  const result = await manager.complete({
    model: 'deepseek.fast',
    session: { id: 'dsh-passthrough', provider_state: {} },
    messages: [
      { role: 'system', content: 'DSH_OWNS_THIS_SYSTEM_PROMPT' },
      { role: 'user', content: 'CALLER_OWNS_THIS_TASK' },
      { role: 'user', content: 'Current runtime context. This snapshot supersedes earlier runtime-context snapshots.\nPRIVATE_SANDBOX_CONTEXT' },
      { role: 'user', content: '<system-reminder><available_skills><skill>CORDIS_SKILL_CATALOG</skill></available_skills></system-reminder>' }
    ],
    instructions: '',
    run: {
      id: 'run-dsh-passthrough',
      call_id: null,
      deep_think: false,
      web_search: false,
      prompt_passthrough: true,
      provider_tools: [{ name: 'read_file', description: 'Read a file', parameters: { type: 'object' } }]
    },
    signal: new AbortController().signal,
    timeout: 1000
  });
  assert.equal(result.content, 'PASSTHROUGH_OK');
  assert.match(sentText, /WEBAGENT_DSH_BRIDGE_V2/);
  assert.match(sentText, /CALLER_OWNS_THIS_TASK/);
  assert.match(sentText, /PRIVATE_SANDBOX_CONTEXT/);
  assert.match(sentText, /CORDIS_SKILL_CATALOG/);
  assert.ok(sentText.indexOf('CALLER_OWNS_THIS_TASK') < sentText.indexOf('PRIVATE_SANDBOX_CONTEXT'));
  assert.ok(sentText.indexOf('PRIVATE_SANDBOX_CONTEXT') < sentText.indexOf('CORDIS_SKILL_CATALOG'));
  assert.match(sentText, /dsh_messages_json/);
  assert.doesNotMatch(sentText, /dsh_user_request_json|dsh_supplemental_context_json|dsh_runtime_context_json/);
  assert.match(sentText, /dsh_available_tools_json/);
  assert.match(sentText, /read_file/);
  assert.match(sentText, /DSH_OWNS_THIS_SYSTEM_PROMPT/);
  assert.ok(sentText.indexOf('DSH_OWNS_THIS_SYSTEM_PROMPT') < sentText.indexOf('WEBAGENT_DSH_BRIDGE_V2'));
  assert.doesNotMatch(sentText, /\[system\]|\[tools\]/);
  assert.doesNotMatch(sentText, /system_instructions|conversation_context|WebAgent Runtime tools|chat mode/i);
  assert.equal(waitArgs.allowReasoningToolCall, true);
  assert.equal(extractArgs.allowReasoningToolCall, true);
  await manager.close();
});

test('DSH vision transport converts plugin image blocks to webpage uploads without serializing bytes into text', async () => {
  const conversationUrl = 'https://chat.deepseek.com/a/chat/s/dsh-vision';
  let createdArgs = null;
  const worker = {
    ensureAuthenticated: async () => true,
    waitForConversationUrl: async () => conversationUrl,
    server: { invoke: async (_model, method, args) => {
      if (method === 'newChat') { createdArgs = args; return { success: true, data: { conversationUrl } }; }
      if (method === 'waitForDone') return { success: true };
      if (method === 'extractResponse') return { success: true, data: { markdown: 'VISION_OK' } };
      if (method === 'peekResponse') return { success: true, data: { text: '' } };
      throw new Error('unexpected method: ' + method);
    } }
  };
  const manager = new ProviderManager({ webFactories: { deepseek: async () => worker, qwen: async () => ({}) } });
  const result = await manager.complete({
    model: 'deepseek.image', session: { id: 'dsh-vision', provider_state: {} },
    messages: [{ role: 'system', content: 'PRIVATE' }, { role: 'user', content: [
      { type: 'text', text: 'Describe this image' },
      { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' }
    ] }], instructions: '',
    run: { id: 'run-dsh-vision', prompt_passthrough: true, provider_tools: [], deep_think: false, web_search: false },
    signal: new AbortController().signal, timeout: 1000
  });
  assert.equal(result.content, 'VISION_OK');
  assert.match(createdArgs.userText, /WEBAGENT_DSH_BRIDGE_V2/);
  assert.match(createdArgs.userText, /Describe this image/);
  assert.deepEqual(createdArgs.files, [{ name: 'dsh-image-1.png', mime: 'image/png', data: 'aGVsbG8=' }]);
  assert.match(createdArgs.userText, /PRIVATE/);
  assert.doesNotMatch(createdArgs.userText, /aGVsbG8/);
  await manager.close();
});

test('DSH uploads identical image bytes only once per remote conversation', async () => {
  const conversationUrl = 'https://chat.deepseek.com/a/chat/s/dsh-image-dedupe';
  const uploaded = [];
  const worker = {
    ensureAuthenticated: async () => true,
    navigate: async () => true,
    assertConversation: async () => true,
    waitForConversationUrl: async () => conversationUrl,
    server: { invoke: async (_model, method, args) => {
      if (method === 'newChat') { uploaded.push(args.files); return { success: true, data: { conversationUrl } }; }
      if (method === 'setDeepThink' || method === 'setWebSearch') return { success: true };
      if (method === 'sendMessage') { uploaded.push(args.files); return { success: true }; }
      if (method === 'waitForDone') return { success: true };
      if (method === 'extractResponse') return { success: true, data: { markdown: 'ROUND_OK' } };
      if (method === 'peekResponse') return { success: true, data: { text: '' } };
      if (method === 'getConversationMetadata') return { success: true, data: { url: conversationUrl } };
      throw new Error('unexpected method: ' + method);
    } }
  };
  const manager = new ProviderManager({ webFactories: { deepseek: async () => worker, qwen: async () => ({}) } });
  const image = { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' };
  const initialMessages = [{ role: 'system', content: 'PRIVATE' }, { role: 'user', content: [{ type: 'text', text: 'Inspect' }, image] }];
  const first = await manager.complete({
    model: 'deepseek.web', session: { id: 'dsh-image-dedupe', provider_state: {} }, messages: initialMessages, instructions: '',
    run: { id: 'run-image-first', prompt_passthrough: true, provider_tools: [], deep_think: false, web_search: false },
    signal: new AbortController().signal, timeout: 1000
  });
  await manager.complete({
    model: 'deepseek.web', session: { id: 'dsh-image-dedupe', provider_state: first.provider_state }, messages: [
      ...initialMessages,
      { role: 'assistant', content: 'read_image call' },
      { role: 'user', content: [{ type: 'text', text: 'Attached image(s) from tool result:' }, image] }
    ], instructions: '',
    run: { id: 'run-image-second', prompt_passthrough: true, provider_tools: [], deep_think: false, web_search: false },
    signal: new AbortController().signal, timeout: 1000
  });
  assert.equal(uploaded.length, 2);
  assert.equal(uploaded[0].length, 1);
  assert.deepEqual(uploaded[1], []);
  assert.equal(first.provider_state.dsh_bridge.uploaded_image_hashes.length, 1);
  await manager.close();
});

test('DSH second webpage turn sends a versioned update envelope and keeps passthrough enabled', async () => {
  const conversationUrl = 'https://chat.deepseek.com/a/chat/s/dsh-second-turn';
  let sentArgs = null;
  const modeCalls = [];
  const worker = {
    ensureAuthenticated: async () => true, navigate: async () => true, assertConversation: async () => true,
    server: { invoke: async (_model, method, args) => {
      if (method === 'setModelMode') { modeCalls.push({ model: _model, args }); return { success: true }; }
      if (method === 'setDeepThink' || method === 'setWebSearch') return { success: true };
      if (method === 'sendMessage') { sentArgs = args; return { success: true }; }
      if (method === 'waitForDone') return { success: true };
      if (method === 'extractResponse') return { success: true, data: { markdown: 'SECOND_OK' } };
      if (method === 'peekResponse') return { success: true, data: { text: '' } };
      throw new Error('unexpected method: ' + method);
    } }
  };
  const manager = new ProviderManager({ webFactories: { deepseek: async () => worker, qwen: async () => ({}) } });
  const result = await manager.complete({
    model: 'deepseek.flash.web', session: { id: 'dsh-second', provider_state: { provider: 'deepseek', url: conversationUrl } },
    messages: [{ role: 'developer', content: 'PRIVATE_DSH_PROMPT' }, { role: 'user', content: 'SECOND_VISIBLE_TURN' }], instructions: '',
    run: { id: 'run-dsh-second', prompt_passthrough: true, provider_tools: [{ name: 'rg' }], deep_think: false, web_search: false },
    signal: new AbortController().signal, timeout: 1000
  });
  assert.equal(result.content, 'SECOND_OK');
  assert.match(sentArgs.text, /SECOND_VISIBLE_TURN/);
  assert.match(sentArgs.text, /dsh_prompt_update_json|dsh_messages_json/);
  assert.equal(sentArgs.promptPassthrough, true);
  assert.deepEqual(modeCalls, []);
  assert.match(sentArgs.text, /PRIVATE_DSH_PROMPT/);
  assert.doesNotMatch(sentArgs.text, /system-reminder|行为规则/);
  await manager.close();
});

test('switching a DSH session from DeepSeek to Qianwen creates a provider-owned conversation with full context', async () => {
  const qwenUrl = 'https://www.qianwen.com/chat/qwen-switch';
  let createdArgs = null;
  let navigated = false;
  const qwenWorker = {
    ensureAuthenticated: async () => true,
    navigate: async () => { navigated = true; },
    waitForConversationUrl: async () => qwenUrl,
    server: { invoke: async (_model, method, args) => {
      if (method === 'newChat') { createdArgs = args; return { success: true, data: { conversationUrl: qwenUrl } }; }
      if (method === 'waitForDone') return { success: true, data: { done: true } };
      if (method === 'detectResponseType') return { success: true, data: { type: 'text' } };
      if (method === 'extractResponse') return { success: true, data: { markdown: 'QWEN_SWITCH_OK' } };
      if (method === 'peekResponse') return { success: true, data: { text: '' } };
      throw new Error('unexpected method: ' + method);
    } }
  };
  const manager = new ProviderManager({
    webFactories: { deepseek: async () => ({}), qwen: async () => qwenWorker, chatgpt: async () => ({}) }
  });
  const result = await manager.complete({
    model: 'qwen.default',
    session: {
      id: 'dsh-provider-switch',
      provider_state: { provider: 'deepseek', url: 'https://chat.deepseek.com/a/chat/s/old-provider' }
    },
    messages: [{ role: 'system', content: 'DSH_SWITCH_SYSTEM' }, { role: 'user', content: 'USE_QWEN_NOW' }],
    instructions: '',
    run: { id: 'run-dsh-provider-switch', prompt_passthrough: true, provider_tools: [], deep_think: false, web_search: false },
    signal: new AbortController().signal,
    timeout: 1000
  });
  assert.equal(result.content, 'QWEN_SWITCH_OK');
  assert.equal(navigated, false);
  assert.match(createdArgs.userText, /DSH_SWITCH_SYSTEM/);
  assert.match(createdArgs.userText, /USE_QWEN_NOW/);
  assert.equal(result.provider_state.provider, 'qwen');
  assert.equal(result.provider_state.url, qwenUrl);
  await manager.close();
});
