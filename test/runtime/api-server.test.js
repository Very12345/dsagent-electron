'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { SessionStore } = require('../../src/runtime/session-store');
const { RunService } = require('../../src/runtime/run-service');
const { RuntimeApiServer, parseBridgeCall, bridgeCallPayloads, bridgedToolCalls, normalizeBridgeArguments, stableMarkdownPrefixLength } = require('../../src/runtime/api-server');
const { stateFor } = require('../../src/runtime/dsh-web-codec');

function request(port, route, options) {
  options = options || {};
  return new Promise((resolve, reject) => {
    const body = options.body == null ? null : JSON.stringify(options.body);
    const req = http.request({ hostname: '127.0.0.1', port, path: route, method: options.method || (body ? 'POST' : 'GET'), headers: Object.assign({ Authorization: 'Bearer test-token', 'Content-Type': 'application/json' }, options.headers || {}) }, (res) => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => {
        let data = raw;
        if (!String(res.headers['content-type'] || '').includes('text/event-stream')) {
          try { data = raw ? JSON.parse(raw) : null; } catch (_) {}
        }
        resolve({ status: res.statusCode, headers: res.headers, raw, data });
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function fixture(providerOverrides) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsagent-api-'));
  const store = new SessionStore(root).init();
  const providers = {
    listModels: () => [{ id: 'mock', object: 'model' }], status: () => ({ mock: { active: 0 } }), cleanupSession: async () => false,
    supportedWebProviders: () => ['deepseek', 'qwen', 'chatgpt'],
    authenticate: async (provider) => ({ provider, login_opened: true }),
    complete: async (context) => ({ content: 'answer:' + context.messages[context.messages.length - 1].content })
  };
  Object.assign(providers, providerOverrides || {});
  const runs = new RunService({ store, providers });
  const api = new RuntimeApiServer({ store, runs, providers, token: 'test-token', port: 0 });
  const address = await api.start();
  return { root, store, runs, api, port: address.port };
}

test('Runtime issues a fresh browser bootstrap ticket only through its authenticated API', async () => {
  const f = await fixture();
  try {
    let issued = 0;
    f.api.webapp = {
      status: () => ({ running: true, origin: 'http://127.0.0.1:7000' }),
      issueBootstrapTicket: () => ({ ticket: 'ticket-' + (++issued), url: 'http://127.0.0.1:7000/auth/bootstrap?ticket=' + issued })
    };
    const status = await request(f.port, '/api/webapp');
    assert.equal(status.status, 200);
    assert.equal(status.data.running, true);
    const first = await request(f.port, '/api/webapp/ticket', { method: 'POST', body: {} });
    const second = await request(f.port, '/api/webapp/ticket', { method: 'POST', body: {} });
    assert.equal(first.status, 201);
    assert.notEqual(first.data.ticket, second.data.ticket);
    const unauthorized = await request(f.port, '/api/webapp/ticket', { method: 'POST', headers: { Authorization: 'Bearer wrong' }, body: {} });
    assert.equal(unauthorized.status, 401);
  } finally { await f.api.close(); fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('OpenAI Chat Completions and Responses share the runtime session core', async () => {
  const f = await fixture();
  try {
    const chat = await request(f.port, '/v1/chat/completions', { method: 'POST', body: { model: 'mock', messages: [{ role: 'user', content: 'hello' }] } });
    assert.equal(chat.status, 200);
    assert.equal(chat.data.object, 'chat.completion');
    assert.equal(chat.data.choices[0].message.content, 'answer:hello');
    assert.equal(chat.headers['x-webagent-usage-estimated'], 'true');
    assert.ok(chat.data.usage.prompt_tokens > 0);
    assert.ok(chat.data.usage.completion_tokens > 0);
    assert.equal(chat.data.usage.total_tokens, chat.data.usage.prompt_tokens + chat.data.usage.completion_tokens);
    const sessionId = chat.headers['x-dsagent-session-id'];
    assert.ok(sessionId);

    const response = await request(f.port, '/v1/responses', { method: 'POST', headers: { 'X-DSAgent-Session-Id': sessionId }, body: { model: 'mock', input: 'again' } });
    assert.equal(response.status, 200);
    assert.equal(response.data.object, 'response');
    assert.equal(response.data.output[0].content[0].text, 'answer:again');
    assert.ok(response.data.usage.input_tokens > 0);
    assert.ok(response.data.usage.output_tokens > 0);
    assert.equal(f.store.get(sessionId).messages.filter((message) => message.role === 'user').length, 2);
  } finally { await f.api.close(); fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('a concurrent OpenAI request receives structured session_busy instead of an unhandled rejection', async () => {
  let releaseProvider;
  let providerStarted;
  const started = new Promise((resolve) => { providerStarted = resolve; });
  const blocked = new Promise((resolve) => { releaseProvider = resolve; });
  const f = await fixture({
    complete: async (context) => {
      providerStarted();
      await blocked;
      return { content: 'answer:' + context.messages[context.messages.length - 1].content };
    }
  });
  try {
    const session = f.store.create({ title: 'busy test', model: 'mock', mode: 'chat' });
    const headers = { 'X-WebAgent-Session-Id': session.id };
    const first = request(f.port, '/v1/chat/completions', {
      method: 'POST', headers,
      body: { model: 'mock', messages: [{ role: 'user', content: 'first' }] }
    });
    await started;

    const second = await request(f.port, '/v1/chat/completions', {
      method: 'POST', headers,
      body: { model: 'mock', messages: [{ role: 'user', content: 'second' }] }
    });
    assert.equal(second.status, 409);
    assert.equal(second.data.error.code, 'session_busy');
    assert.match(second.data.error.message, /active run/i);
    assert.ok(f.runs.activeRunForSession(session.id));

    releaseProvider();
    const completed = await first;
    assert.equal(completed.status, 200);
  } finally {
    releaseProvider();
    await f.api.close();
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test('DeepSeek webpage rate limiting is exposed as out_of_usage without a generic 500', async () => {
  const f = await fixture({ complete: async () => { throw Object.assign(new Error('DeepSeek webpage rate limit reached; wait before retrying'), { code: 'out_of_usage', status: 429, retry_after_seconds: 60 }); } });
  try {
    const response = await request(f.port, '/v1/chat/completions', { method: 'POST', body: { model: 'deepseek.web', messages: [{ role: 'user', content: 'hello' }] } });
    assert.equal(response.status, 429);
    assert.equal(response.headers['retry-after'], '60');
    assert.equal(response.data.error.code, 'out_of_usage');
    assert.equal(response.data.error.retry_after_seconds, 60);
  } finally { await f.api.close(); fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('DeepSeek webpage busy errors carry HTTP 503 for the DSH pi-ai classifier', async () => {
  const f = await fixture({ complete: async () => { throw Object.assign(new Error('DeepSeek webpage is temporarily busy; wait before retrying'), { code: 'provider_busy', status: 503, retry_after_seconds: 30 }); } });
  try {
    const response = await request(f.port, '/v1/chat/completions', { method: 'POST', body: { model: 'deepseek.web', messages: [{ role: 'user', content: 'hello' }] } });
    assert.equal(response.status, 503);
    assert.equal(response.data.error.code, 'provider_busy');
    assert.match(response.data.error.message, /HTTP 503/);
  } finally { await f.api.close(); fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('streaming rate-limit failures expose out_of_usage and terminate with DONE', async () => {
  const f = await fixture({ complete: async () => { throw Object.assign(new Error('DeepSeek webpage usage limit reached'), { code: 'out_of_usage', status: 429, retry_after_seconds: 60 }); } });
  try {
    const response = await request(f.port, '/v1/chat/completions', { method: 'POST', body: { model: 'deepseek.web', stream: true, messages: [{ role: 'user', content: 'hello' }] } });
    assert.equal(response.status, 200);
    assert.match(response.raw, /"code":"out_of_usage"/);
    assert.match(response.raw, /"retry_after_seconds":60/);
    assert.match(response.raw, /data: \[DONE\]/);
  } finally { await f.api.close(); fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('webpage context overflow is exposed in the form DSH compaction recognizes', async () => {
  const f = await fixture({ complete: async () => { throw Object.assign(new Error('DeepSeek webpage context window exceeded; compact the Harness session'), { code: 'context_length_exceeded', status: 400 }); } });
  try {
    const response = await request(f.port, '/v1/chat/completions', { method: 'POST', body: { model: 'deepseek.web', messages: [{ role: 'user', content: 'continue' }] } });
    assert.equal(response.status, 400);
    assert.equal(response.data.error.code, 'context_length_exceeded');
    assert.match(response.data.error.message, /context window exceeded/);
  } finally { await f.api.close(); fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('streaming webpage context overflow preserves the compaction error code', async () => {
  const f = await fixture({ complete: async () => { throw Object.assign(new Error('DeepSeek webpage context window exceeded; compact the Harness session'), { code: 'context_length_exceeded', status: 400 }); } });
  try {
    const response = await request(f.port, '/v1/chat/completions', { method: 'POST', body: { model: 'deepseek.web', stream: true, messages: [{ role: 'user', content: 'continue' }] } });
    assert.equal(response.status, 200);
    assert.match(response.raw, /"code":"context_length_exceeded"/);
    assert.match(response.raw, /context window exceeded/);
    assert.match(response.raw, /data: \[DONE\]/);
  } finally { await f.api.close(); fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('DSH title generation does not race the writable first turn for the same session affinity', async () => {
  let titleStarted;
  const started = new Promise((resolve) => { titleStarted = resolve; });
  const f = await fixture({
    complete: async (context) => {
      if (context.messages.some((message) => String(message.content || '').includes('Generate the session title'))) {
        titleStarted();
        await new Promise((resolve) => setTimeout(resolve, 80));
        return { content: '图片问候' };
      }
      return { content: 'MAIN_OK' };
    }
  });
  const headers = { 'X-WebAgent-Tool-Bridge': 'dsh' };
  const prompt_cache_key = 'session-image-first-turn';
  try {
    const title = request(f.port, '/v1/chat/completions', { method: 'POST', headers, body: {
      model: 'mock', prompt_cache_key, max_tokens: 64,
      messages: [
        { role: 'system', content: 'Create a concise title for an AI coding-assistant session from the supplied human messages.' },
        { role: 'user', content: 'Generate the session title from this JSON array of human messages:\n[{"text":"你好"}]' }
      ]
    } });
    await started;
    const main = request(f.port, '/v1/chat/completions', { method: 'POST', headers, body: {
      model: 'mock', prompt_cache_key,
      messages: [{ role: 'system', content: 'Harness prompt' }, { role: 'user', content: '你好' }]
    } });
    const [titleResponse, mainResponse] = await Promise.all([title, main]);
    assert.equal(titleResponse.status, 200);
    assert.equal(mainResponse.status, 200);
    assert.notEqual(titleResponse.headers['x-webagent-session-id'], mainResponse.headers['x-webagent-session-id']);
    assert.equal(mainResponse.data.choices[0].message.content, 'MAIN_OK');
  } finally { await f.api.close(); fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('estimated webpage usage counts image content instead of base64 transport bytes', async () => {
  const f = await fixture();
  try {
    const image = 'data:image/png;base64,' + 'a'.repeat(180000);
    const result = await request(f.port, '/v1/chat/completions', { method: 'POST', body: {
      model: 'deepseek.web', messages: [{ role: 'user', content: [
        { type: 'text', text: '图片里是什么？' },
        { type: 'image_url', image_url: { url: image } },
        { type: 'image_url', image_url: { url: image } }
      ] }]
    } });
    assert.equal(result.status, 200);
    assert.ok(result.data.usage.prompt_tokens >= 800);
    assert.ok(result.data.usage.prompt_tokens < 1200);
  } finally { await f.api.close(); fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('Chat Completions stream is real SSE and terminates with DONE', async () => {
  const f = await fixture();
  try {
    const streamed = await request(f.port, '/v1/chat/completions', { method: 'POST', body: { model: 'mock', stream: true, stream_options: { include_usage: true }, messages: [{ role: 'user', content: 'stream' }] } });
    assert.equal(streamed.status, 200);
    assert.match(String(streamed.headers['content-type']), /text\/event-stream/);
    assert.match(streamed.raw, /answer:stream/);
    assert.match(streamed.raw, /"choices":\[\],"usage":\{"prompt_tokens":\d+,"completion_tokens":\d+,"total_tokens":\d+,"prompt_tokens_details":\{"cached_tokens":0\}\}/);
    assert.match(streamed.raw, /data: \[DONE\]/);
  } finally { await f.api.close(); fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('disconnecting a DSH SSE request cancels its Runtime run and provider request', async () => {
  let providerStopped = 0;
  let runStarted;
  const started = new Promise((resolve) => { runStarted = resolve; });
  const f = await fixture({
    stop: async () => { providerStopped += 1; return true; },
    complete: async (context) => {
      runStarted();
      await new Promise((resolve, reject) => {
        const abort = () => reject(Object.assign(new Error('cancelled'), { name: 'AbortError', code: 'run_cancelled' }));
        if (context.signal.aborted) abort();
        else context.signal.addEventListener('abort', abort, { once: true });
      });
      return { content: 'unreachable' };
    }
  });
  try {
    const body = JSON.stringify({ model: 'mock', stream: true, messages: [{ role: 'user', content: 'cancel me' }] });
    const requestClosed = new Promise((resolve, reject) => {
      const req = http.request({ hostname: '127.0.0.1', port: f.port, path: '/v1/chat/completions', method: 'POST', headers: { Authorization: 'Bearer test-token', 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), 'X-WebAgent-Tool-Bridge': 'dsh' } }, (res) => {
        res.once('data', () => { res.destroy(); resolve(); });
      });
      req.on('error', (error) => error.code === 'ECONNRESET' ? resolve() : reject(error));
      req.end(body);
    });
    await runStarted;
    await requestClosed;
    const deadline = Date.now() + 2000;
    let run;
    while (Date.now() < deadline) {
      run = Array.from(f.runs.runs.values())[0];
      if (run && run.status === 'cancelled') break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(run && run.status, 'cancelled');
    assert.equal(providerStopped, 1);
  } finally { await f.api.close(); fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('DSH receives webpage reasoning as incremental reasoning_content SSE chunks', async () => {
  let deepThink = false;
  let reasoningEffort = '';
  const reasoning = 'First inspect the constraints, compare every available source, preserve structured evidence, and verify the conclusion before answering. '.repeat(10);
  const f = await fixture({ complete: async (context) => {
    deepThink = context.run.deep_think;
    reasoningEffort = context.run.reasoning_effort;
    context.onReasoningProgress(reasoning.slice(0, 500));
    context.onReasoningProgress(reasoning);
    context.onProgress('verified answer');
    return { content: 'verified answer', reasoning };
  } });
  try {
    const streamed = await request(f.port, '/v1/chat/completions', {
      method: 'POST',
      headers: { 'X-WebAgent-Tool-Bridge': 'dsh' },
      body: { model: 'mock', stream: true, thinking: { type: 'enabled' }, reasoning_effort: 'high', messages: [{ role: 'user', content: 'reason' }] }
    });
    const chunks = streamed.raw.split(/\r?\n/).filter((line) => line.startsWith('data: {')).map((line) => JSON.parse(line.slice(6)));
    const reasoningChunks = chunks.map((chunk) => chunk.choices?.[0]?.delta?.reasoning_content || '').filter(Boolean);
    const content = chunks.map((chunk) => chunk.choices?.[0]?.delta?.content || '').join('');
    assert.equal(deepThink, true);
    assert.equal(reasoningEffort, 'high');
    assert.ok(reasoningChunks.length >= 2, 'reasoning should be sent before completion in multiple chunks');
    assert.equal(reasoningChunks.join(''), reasoning);
    assert.equal(content, 'verified answer');
    assert.ok(streamed.raw.indexOf('reasoning_content') < streamed.raw.indexOf('verified answer'));
    assert.match(streamed.raw, /data: \[DONE\]/);
  } finally { await f.api.close(); fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('non-streaming Chat Completions preserves final reasoning_content', async () => {
  const f = await fixture({ complete: async () => ({ content: 'answer', reasoning: 'reasoning' }) });
  try {
    const result = await request(f.port, '/v1/chat/completions', { method: 'POST', body: { model: 'mock', reasoning_effort: 'high', messages: [{ role: 'user', content: 'reason' }] } });
    assert.equal(result.data.choices[0].message.reasoning_content, 'reasoning');
  } finally { await f.api.close(); fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('OpenAI stream buffers replace events and emits authoritative final text', async () => {
  const f = await fixture({ complete: async (context) => {
    context.onProgress('ACCEPTED_LI_');
    context.onProgress('ACCEPTED_LIVE_1');
    return { content: 'ACCEPTED_LIVE_1' };
  } });
  try {
    const streamed = await request(f.port, '/v1/chat/completions', { method: 'POST', body: { model: 'mock', stream: true, messages: [{ role: 'user', content: 'replace' }] } });
    const text = streamed.raw.split(/\r?\n/).filter((line) => line.startsWith('data: {')).map((line) => JSON.parse(line.slice(6)).choices && JSON.parse(line.slice(6)).choices[0]?.delta?.content || '').join('');
    assert.equal(text, 'ACCEPTED_LIVE_1');
    assert.match(streamed.raw, /data: \[DONE\]/);
  } finally { await f.api.close(); fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('OpenAI stream reports mutable DOM desynchronization instead of silently truncating output', async () => {
  const first = 'A'.repeat(1000);
  const second = first + 'B'.repeat(300);
  const final = 'A'.repeat(100) + 'CHANGED' + 'C'.repeat(1200);
  const f = await fixture({ complete: async (context) => {
    context.onProgress(first);
    context.onProgress(second);
    context.onProgress(final);
    return { content: final };
  } });
  try {
    const streamed = await request(f.port, '/v1/chat/completions', { method: 'POST', body: { model: 'mock', stream: true, messages: [{ role: 'user', content: 'mutable' }] } });
    assert.match(streamed.raw, /stream_desync/);
    assert.doesNotMatch(streamed.raw, /data: \[DONE\]/);
  } finally { await f.api.close(); fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('Markdown stream holds an open code or display-math block until it is structurally closed', () => {
  const openFence = 'Intro\n\n```text\nproject root/\n' + 'file.js\n'.repeat(80);
  assert.equal(stableMarkdownPrefixLength(openFence, openFence.length), 'Intro\n\n'.length);
  const closedFence = openFence + '```\n\n### Verified\n- item';
  assert.equal(stableMarkdownPrefixLength(closedFence, closedFence.length), closedFence.length);

  const openMath = 'Proof\n\n$$\nx^2 + y^2';
  assert.equal(stableMarkdownPrefixLength(openMath, openMath.length), 'Proof\n\n'.length);
  const closedMath = openMath + '\n$$\n\n| A | B |\n| --- | --- |\n| 1 | 2 |';
  assert.equal(stableMarkdownPrefixLength(closedMath, closedMath.length), closedMath.length);
});

test('DSH stream does not commit a provisional unclosed DOM fence that is closed before later prose', async () => {
  const intro = 'Checking the project. '.repeat(20) + '\n\n';
  const code = 'project root/\n' + 'file.js\n'.repeat(90);
  const provisional = intro + '```text\n' + code + '\n### This heading is temporarily inside the DOM fence';
  const final = intro + '```text\n' + code + '```\n\n### This heading is outside\n\n| Check | Result |\n| --- | --- |\n| render | pass |';
  const f = await fixture({
    complete: async (context) => {
      context.onProgress(provisional);
      await new Promise((resolve) => setTimeout(resolve, 20));
      context.onProgress(final);
      return { content: final };
    }
  });
  try {
    const result = await request(f.port, '/v1/chat/completions', {
      method: 'POST',
      headers: { 'X-WebAgent-Tool-Bridge': 'dsh' },
      body: { model: 'mock', stream: true, messages: [{ role: 'user', content: 'render markdown' }] }
    });
    const chunks = result.raw.split(/\r?\n/).filter((line) => line.startsWith('data: {')).map((line) => JSON.parse(line.slice(6)));
    const content = chunks.map((chunk) => chunk.choices?.[0]?.delta?.content || '').join('');
    assert.equal(content, final);
    assert.doesNotMatch(result.raw, /stream_desync/);
    assert.match(result.raw, /data: \[DONE\]/);
  } finally { await f.api.close(); fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('Qwen DSH stream defers mutable webpage answer text until the authoritative completed Run', async () => {
  const provisional = 'A'.repeat(900) + ' provisional';
  const final = 'B'.repeat(900) + ' authoritative';
  const f = await fixture({ complete: async (context) => {
    context.onProgress(provisional);
    context.onProgress(final);
    return { content: final, reasoning: 'reasoning remains streamable' };
  } });
  try {
    const result = await request(f.port, '/v1/chat/completions', {
      method: 'POST',
      headers: { 'X-WebAgent-Tool-Bridge': 'dsh' },
      body: {
        model: 'qwen.text.web.3.8-max', stream: true,
        messages: [{ role: 'user', content: 'mutable qwen output' }],
        tools: [{ type: 'function', function: { name: 'read', parameters: { type: 'object', properties: {} } } }]
      }
    });
    const chunks = result.raw.split(/\r?\n/).filter((line) => line.startsWith('data: {')).map((line) => JSON.parse(line.slice(6)));
    const content = chunks.map((chunk) => chunk.choices?.[0]?.delta?.content || '').join('');
    assert.equal(content, final);
    assert.doesNotMatch(result.raw, /stream_desync|provisional/);
    assert.match(result.raw, /data: \[DONE\]/);
  } finally { await f.api.close(); fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('OpenAI stream freezes a mutable reasoning channel without losing the final answer', async () => {
  const first = 'R'.repeat(1000);
  const second = first + 'S'.repeat(300);
  const final = 'R'.repeat(100) + 'CHANGED' + 'T'.repeat(1200);
  const f = await fixture({ complete: async (context) => {
    context.onReasoningProgress(first);
    context.onReasoningProgress(second);
    context.onReasoningProgress(final);
    return { content: 'final answer', reasoning: final };
  } });
  try {
    const streamed = await request(f.port, '/v1/chat/completions', { method: 'POST', body: { model: 'mock', stream: true, reasoning_effort: 'high', messages: [{ role: 'user', content: 'mutable reasoning' }] } });
    assert.doesNotMatch(streamed.raw, /stream_desync|CHANGED/);
    assert.match(streamed.raw, /final answer/);
    assert.match(streamed.raw, /data: \[DONE\]/);
  } finally { await f.api.close(); fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('DSH tool bridge returns native OpenAI tool calls without executing Runtime tools', async () => {
  let observed = null;
  const f = await fixture({
    cleanupSession: async () => true,
    complete: async (context) => {
      observed = context;
      return { content: '<dsh_tool_call>{"name":"read_file","arguments":{"path":"package.json"}}</dsh_tool_call>' };
    }
  });
  try {
    const result = await request(f.port, '/v1/chat/completions', {
      method: 'POST',
      headers: { 'X-WebAgent-Tool-Bridge': 'dsh', 'X-WebAgent-Agent-Mode': 'false', 'X-WebAgent-Ephemeral': 'true' },
      body: {
        model: 'mock',
        messages: [{ role: 'system', content: 'DSH_OWNS_THIS_SYSTEM_PROMPT' }, { role: 'user', content: 'inspect package' }],
        tools: [{ type: 'function', function: { name: 'read_file', description: 'Read a file', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } }]
      }
    });
    assert.equal(result.status, 200);
    assert.equal(result.data.choices[0].finish_reason, 'tool_calls');
    assert.equal(result.data.choices[0].message.tool_calls[0].function.name, 'read_file');
    assert.equal(result.data.choices[0].message.tool_calls[0].function.arguments, '{"path":"package.json"}');
    assert.equal(observed.run.agent_mode, false);
    assert.equal(observed.instructions, '');
    assert.equal(observed.run.prompt_passthrough, true);
    assert.equal(observed.timeout, 30 * 60 * 1000);
    assert.deepEqual(observed.run.provider_tools.map((tool) => tool.name), ['read_file']);
    assert.deepEqual(observed.messages.map((message) => message.role), ['system', 'user']);
    assert.equal(observed.messages.filter((message) => message.content === 'DSH_OWNS_THIS_SYSTEM_PROMPT').length, 1);
    assert.equal(observed.messages.some((message) => String(message.content).includes('WebAgent Runtime tools are disabled')), false);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(f.store.list({ includeHidden: true }).length, 0);
  } finally { await f.api.close(); fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('DSH bridge repairs unescaped quotes from webpage tool envelopes as data', () => {
  const malformed = '{"name":"pwsh","arguments":{"command":"New-Item -Path "backend","frontend" -Force","description":"Create dirs"}}';
  assert.deepEqual(parseBridgeCall(malformed), {
    name: 'pwsh',
    arguments: {
      command: 'New-Item -Path "backend","frontend" -Force',
      description: 'Create dirs'
    }
  });
});

test('DSH bridge recovers complete calls when Markdown DOM consumes closing custom tags', () => {
  const output = 'Starting.\n<dsh_tool_call>{"name":"write","arguments":{"file_path":"a.txt","content":"A"}}'
    + '<dsh_tool_call>{"name":"write","arguments":{"file_path":"b.txt","content":"B"}}';
  assert.deepEqual(bridgeCallPayloads(output).map(parseBridgeCall), [
    { name: 'write', arguments: { file_path: 'a.txt', content: 'A' } },
    { name: 'write', arguments: { file_path: 'b.txt', content: 'B' } }
  ]);
});

test('DSH bridge accepts consecutive hyphenated custom-tag calls from DeepSeek', () => {
  const output = 'Starting implementation.\n<dsh-tool-call>{"name":"todo_write","arguments":{"todos":[]}}</dsh-tool-call>'
    + '<dsh-tool-call>{"name":"write","arguments":{"file_path":"package.json","content":"{}"}}</dsh-tool-call>';
  assert.deepEqual(bridgeCallPayloads(output).map(parseBridgeCall), [
    { name: 'todo_write', arguments: { todos: [] } },
    { name: 'write', arguments: { file_path: 'package.json', content: '{}' } }
  ]);
});

test('DSH bridge preserves ordered fenced calls that contain HTML and JavaScript', () => {
  const output = 'Starting.\n```dsh-tool-call\n{"name":"write","arguments":{"file_path":"index.html","content":"<main>${value}</main>"}}\n```\n'
    + '```dsh-tool-call\n{"name":"write","arguments":{"file_path":"app.js","content":"const value = `ok`;"}}\n```';
  assert.deepEqual(bridgeCallPayloads(output).map(parseBridgeCall), [
    { name: 'write', arguments: { file_path: 'index.html', content: '<main>${value}</main>' } },
    { name: 'write', arguments: { file_path: 'app.js', content: 'const value = `ok`;' } }
  ]);
});

test('DSH bridge accepts renderer-expanded fences with Markdown fences inside JSON arguments', () => {
  const call = {
    name: 'write',
    arguments: {
      file_path: 'README.md',
      content: '# Demo\n\n```bash\nnpm test\n```\n'
    }
  };
  const output = '````dsh-tool-call\n' + JSON.stringify(call) + '\n````';
  assert.deepEqual(bridgeCallPayloads(output).map(parseBridgeCall), [call]);
});

test('DSH bridge repairs invalid regex escapes instead of silently dropping a tool call', () => {
  const output = ['```dsh-tool-call',
    String.raw`{"name":"edit","arguments":{"file_path":"tests/api.test.js","new_string":"content.match(/createTaskCard\$task\$ \{[^}]*\}/s)"}}`,
    '```'].join('\n');
  assert.deepEqual(bridgeCallPayloads(output).map(parseBridgeCall), [{
    name: 'edit',
    arguments: {
      file_path: 'tests/api.test.js',
      new_string: String.raw`content.match(/createTaskCard\$task\$ \{[^}]*\}/s)`
    }
  }]);
});

test('DSH bridge removes only surplus trailing closers from flattened calls', () => {
  const repaired = parseBridgeCall('{"command":"Get-ChildItem | ForEach-Object { $_.FullName }","name":"pwsh"}}');
  assert.deepEqual(repaired, { command: 'Get-ChildItem | ForEach-Object { $_.FullName }', name: 'pwsh' });
  assert.equal(parseBridgeCall('{"command":"dir"} trailing }'), null);
});

test('DSH bridge repairs the Qwen skill_name alias only when Skill schema requires name', () => {
  const definition = {
    name: 'skill',
    parameters: {
      type: 'object',
      required: ['name'],
      properties: { name: { type: 'string' } },
      additionalProperties: false
    }
  };
  assert.deepEqual(normalizeBridgeArguments('skill', { skill_name: 'cordis-plugin-development' }, definition), {
    name: 'cordis-plugin-development'
  });
  const calls = bridgedToolCalls(
    '```dsh-tool-call\n{"name":"skill","arguments":{"skill_name":"cordis-plugin-development"}}\n```',
    [{ type: 'function', function: definition }]
  );
  assert.equal(calls.length, 1);
  assert.deepEqual(JSON.parse(calls[0].function.arguments), { name: 'cordis-plugin-development' });
});

test('DSH bridge does not invent missing Skill arguments or accept unknown tools', () => {
  const tools = [{ type: 'function', function: {
    name: 'skill',
    parameters: { type: 'object', required: ['name'], properties: { name: { type: 'string' } } }
  } }];
  assert.deepEqual(JSON.parse(bridgedToolCalls(
    '```dsh-tool-call\n{"name":"skill","arguments":{}}\n```', tools
  )[0].function.arguments), {});
  assert.deepEqual(bridgedToolCalls(
    '```dsh-tool-call\n{"name":"cordis_inspect_slots","arguments":{"query":"background"}}\n```', tools
  ), []);
});

test('DSH tool bridge accepts the webpage inline Markdown call variant', async () => {
  const f = await fixture({
    complete: async () => ({ content: '**Calling** `read` with `{"file_path":"package.json"}`' })
  });
  try {
    const response = await request(f.port, '/v1/chat/completions', {
      method: 'POST',
      headers: { 'X-WebAgent-Tool-Bridge': 'dsh' },
      body: {
        model: 'deepseek.fast',
        messages: [{ role: 'user', content: 'Read package.json' }],
        tools: [{ type: 'function', function: { name: 'read', parameters: { type: 'object' } } }]
      }
    });
    assert.equal(response.data.choices[0].finish_reason, 'tool_calls');
    assert.equal(response.data.choices[0].message.tool_calls[0].function.name, 'read');
    assert.deepEqual(JSON.parse(response.data.choices[0].message.tool_calls[0].function.arguments), { file_path: 'package.json' });
  } finally { await f.api.close(); fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('DSH tool bridge streams tool call deltas and tool_calls finish reason', async () => {
  const f = await fixture({
    cleanupSession: async () => true,
    complete: async () => ({ content: 'Calling: rg\n```json\n{"pattern":"Harness"}\n```' })
  });
  try {
    const result = await request(f.port, '/v1/chat/completions', {
      method: 'POST',
      headers: { 'X-WebAgent-Tool-Bridge': 'dsh', 'X-WebAgent-Ephemeral': 'true' },
      body: { model: 'mock', stream: true, messages: [{ role: 'user', content: 'search' }], tools: [{ type: 'function', function: { name: 'rg', parameters: { type: 'object' } } }] }
    });
    assert.match(result.raw, /"tool_calls"/);
    assert.match(result.raw, /"name":"rg"/);
    assert.match(result.raw, /"finish_reason":"tool_calls"/);
    assert.match(result.raw, /data: \[DONE\]/);
  } finally { await f.api.close(); fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('DSH long tool-enabled responses stream narrative before completion and keep tool syntax out of content', async () => {
  const narrative = 'Working through the repository. '.repeat(30);
  const f = await fixture({
    complete: async (context) => {
      context.onProgress(narrative.slice(0, 500));
      await new Promise((resolve) => setTimeout(resolve, 20));
      context.onProgress(narrative + '\nCalling: rg\n```json\n{"pattern":"stream"}\n```');
      return { content: narrative + '\nCalling: rg\n```json\n{"pattern":"stream"}\n```' };
    }
  });
  try {
    const result = await request(f.port, '/v1/chat/completions', {
      method: 'POST', headers: { 'X-WebAgent-Tool-Bridge': 'dsh' },
      body: { model: 'mock', stream: true, messages: [{ role: 'user', content: 'long task' }], tools: [{ type: 'function', function: { name: 'rg', parameters: { type: 'object' } } }] }
    });
    const chunks = result.raw.split(/\r?\n/).filter((line) => line.startsWith('data: {')).map((line) => JSON.parse(line.slice(6)));
    const contents = chunks.map((chunk) => chunk.choices?.[0]?.delta?.content || '').filter(Boolean);
    assert.ok(contents.length >= 2, 'expected progressive content chunks');
    assert.equal(contents.join('').trim(), narrative.trim());
    assert.doesNotMatch(contents.join(''), /Calling:|"pattern"/);
    assert.match(result.raw, /"tool_calls"/);
  } finally { await f.api.close(); fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('DSH High streams reasoning but defers mutable body until the final tool envelope', async () => {
  const provisional = 'provisional answer text '.repeat(60);
  const toolEnvelope = '<dsh_tool_call>{"name":"rg","arguments":{"pattern":"stable"}}</dsh_tool_call>';
  const f = await fixture({
    complete: async (context) => {
      context.onReasoningProgress('Inspecting the workspace. '.repeat(30));
      context.onProgress(provisional);
      context.onProgress('rewritten provisional body');
      return { content: toolEnvelope, reasoning: 'Inspecting the workspace. '.repeat(30) };
    }
  });
  try {
    const result = await request(f.port, '/v1/chat/completions', {
      method: 'POST', headers: { 'X-WebAgent-Tool-Bridge': 'dsh' },
      body: { model: 'mock', stream: true, reasoning_effort: 'high', messages: [{ role: 'user', content: 'high task' }], tools: [{ type: 'function', function: { name: 'rg', parameters: { type: 'object' } } }] }
    });
    assert.match(result.raw, /reasoning_content/);
    assert.match(result.raw, /"tool_calls"/);
    assert.match(result.raw, /"name":"rg"/);
    assert.doesNotMatch(result.raw, /provisional answer text|stream_desync/);
    assert.match(result.raw, /data: \[DONE\]/);
  } finally { await f.api.close(); fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('DSH releases the guarded reasoning tail when tool output starts', async () => {
  const reasoningStart = 'Inspecting '.repeat(40);
  const reasoning = reasoningStart + 'REASONING_TAIL_BEFORE_TOOL';
  const toolEnvelope = '<dsh-tool-call>{"name":"rg","arguments":{"pattern":"boundary"}}</dsh-tool-call>';
  let streamed = '';
  let observedBeforeCompletion = false;
  const f = await fixture({
    complete: async (context) => {
      context.onReasoningProgress(reasoningStart);
      context.onReasoningProgress(reasoning);
      context.onProgress(toolEnvelope);
      await new Promise((resolve) => setTimeout(resolve, 30));
      observedBeforeCompletion = streamed.includes('REASONING_TAIL_BEFORE_TOOL');
      return { content: toolEnvelope, reasoning };
    }
  });
  try {
    await new Promise((resolve, reject) => {
      const body = JSON.stringify({ model: 'mock', stream: true, reasoning_effort: 'high', messages: [{ role: 'user', content: 'boundary' }], tools: [{ type: 'function', function: { name: 'rg', parameters: { type: 'object' } } }] });
      const req = http.request({ hostname: '127.0.0.1', port: f.port, path: '/v1/chat/completions', method: 'POST', headers: { Authorization: 'Bearer test-token', 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), 'X-WebAgent-Tool-Bridge': 'dsh' } }, (res) => {
        res.setEncoding('utf8');
        res.on('data', (chunk) => { streamed += chunk; });
        res.on('end', resolve);
      });
      req.on('error', reject);
      req.end(body);
    });
    assert.equal(observedBeforeCompletion, true, 'reasoning tail should arrive while the tool body is still generating');
    assert.match(streamed, /"tool_calls"/);
  } finally { await f.api.close(); fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('DSH session affinity keeps one hidden Runtime and remote conversation across turns', async () => {
  let cleaned = 0;
  const f = await fixture({
    cleanupSession: async () => { cleaned += 1; return true; },
    complete: async (context) => ({
      content: 'answer:' + context.messages[context.messages.length - 1].content,
      provider_state: Object.assign({}, context.session.provider_state, {
        provider: 'deepseek',
        url: context.session.provider_state.url || 'https://chat.deepseek.com/a/chat/s/dsh-stable',
        last_run_id: context.run.id,
        conversations: [{ provider: 'deepseek', url: 'https://chat.deepseek.com/a/chat/s/dsh-stable', status: 'active' }]
      })
    })
  });
  try {
    const headers = { 'X-WebAgent-Tool-Bridge': 'dsh', 'X-WebAgent-Agent-Mode': 'false' };
    const first = await request(f.port, '/api.openai.com/v1/chat/completions', { method: 'POST', headers, body: { model: 'mock', prompt_cache_key: 'dsh-session-stable', messages: [{ role: 'user', content: 'one' }] } });
    const second = await request(f.port, '/api.openai.com/v1/chat/completions', { method: 'POST', headers, body: { model: 'mock', prompt_cache_key: 'dsh-session-stable', messages: [{ role: 'user', content: 'one' }, { role: 'assistant', content: 'answer:one' }, { role: 'user', content: 'two' }] } });
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.equal(first.headers['x-webagent-session-id'], second.headers['x-webagent-session-id']);
    const sessions = f.store.list({ includeHidden: true });
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].integration_origin, 'dsh');
    assert.equal(sessions[0].external_session_id, 'dsh-session-stable');
    assert.equal(sessions[0].ephemeral, false);
    assert.equal(cleaned, 0);

    const archived = await request(f.port, '/api/harness/sessions/dsh-session-stable/archive', { method: 'POST', body: {} });
    assert.equal(archived.status, 200);
    assert.equal(archived.data.remote_deleted, true);
    assert.equal(cleaned, 1);
    assert.equal(f.store.list({ includeHidden: true }).length, 0);
  } finally { await f.api.close(); fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('different DSH cache keys create different hidden sessions while the same key is a cache hit', async () => {
  const seen = [];
  const f = await fixture({ complete: async (context) => {
    seen.push({ session: context.session.id, url: context.session.provider_state.url || '' });
    return { content: 'ok', provider_state: { provider: 'deepseek', url: context.session.provider_state.url || 'https://chat.deepseek.com/a/chat/s/' + context.session.id } };
  } });
  try {
    const headers = { 'X-WebAgent-Tool-Bridge': 'dsh' };
    const call = (key, text) => request(f.port, '/v1/chat/completions', { method: 'POST', headers, body: { model: 'mock', prompt_cache_key: key, messages: [{ role: 'user', content: text }] } });
    const first = await call('cache-a', 'one');
    const hit = await call('cache-a', 'two');
    const miss = await call('cache-b', 'three');
    assert.equal(first.headers['x-webagent-session-id'], hit.headers['x-webagent-session-id']);
    assert.notEqual(first.headers['x-webagent-session-id'], miss.headers['x-webagent-session-id']);
    assert.equal(seen[0].url, '');
    assert.match(seen[1].url, /cache|harness_/);
    assert.equal(seen[2].url, '');
  } finally { await f.api.close(); fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('DSH continuation reports its unchanged logical prefix as estimated cached tokens', async () => {
  const f = await fixture({ complete: async (context) => ({
    content: 'ok',
    provider_state: {
      provider: 'deepseek',
      url: 'https://chat.deepseek.com/a/chat/s/cache-estimate',
      dsh_bridge: stateFor(context.messages, context.run.provider_tools)
    }
  }) });
  const headers = { 'X-WebAgent-Tool-Bridge': 'dsh' };
  const system = 'WEBAGENT_DSH_BRIDGE_V2\n' + 'Stable harness instructions. '.repeat(80);
  const tools = [{ type: 'function', function: { name: 'read', description: 'Read a file', parameters: { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'] } } }];
  try {
    const first = await request(f.port, '/v1/chat/completions', { method: 'POST', headers, body: {
      model: 'deepseek.web', prompt_cache_key: 'cache-estimate', messages: [{ role: 'system', content: system }, { role: 'user', content: 'one' }], tools
    } });
    const second = await request(f.port, '/v1/chat/completions', { method: 'POST', headers, body: {
      model: 'deepseek.web', prompt_cache_key: 'cache-estimate', messages: [
        { role: 'system', content: system }, { role: 'user', content: 'one' }, { role: 'assistant', content: 'ok' }, { role: 'user', content: 'two' }
      ], tools
    } });
    assert.equal(first.data.usage.prompt_tokens_details.cached_tokens, 0);
    assert.ok(second.data.usage.prompt_tokens_details.cached_tokens > 0);
    assert.ok(second.data.usage.prompt_tokens_details.cached_tokens < second.data.usage.prompt_tokens);
  } finally { await f.api.close(); fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('trashing a normal web session deletes its remote conversation first', async () => {
  let cleaned = 0;
  const f = await fixture({ cleanupSession: async () => { cleaned += 1; return true; } });
  try {
    const session = f.store.create({ title: 'archive test', model: 'deepseek.fast' });
    f.store.update(session.id, { provider_state: { provider: 'deepseek', url: 'https://chat.deepseek.com/a/chat/s/archive-test', last_run_id: 'run-archive' } });
    const result = await request(f.port, '/api/sessions/' + session.id, { method: 'DELETE' });
    assert.equal(result.status, 200);
    assert.equal(cleaned, 1);
    assert.ok(f.store.get(session.id).deleted_at);
  } finally { await f.api.close(); fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('DeepSeek Harness lifecycle is exposed through the authenticated Runtime API', async () => {
  const calls = [];
  const harness = {
    status: () => ({ installed: true, running: false, version: 'test' }),
    start: async (input) => { calls.push(['start', input]); return { installed: true, running: true, url: 'http://127.0.0.1:3080' }; },
    stop: async () => { calls.push(['stop']); return { installed: true, running: false }; },
    restart: async (input) => { calls.push(['restart', input]); return { installed: true, running: true, url: 'http://127.0.0.1:3080' }; }
  };
  const f = await fixture();
  f.api.harness = harness;
  try {
    assert.equal((await request(f.port, '/api/harness')).data.version, 'test');
    assert.equal((await request(f.port, '/api/harness/start', { method: 'POST', body: { workspace: 'D:/Code' } })).data.running, true);
    assert.equal((await request(f.port, '/api/harness/stop', { method: 'POST', body: {} })).data.running, false);
    assert.equal((await request(f.port, '/api/harness/restart', { method: 'POST', body: {} })).data.running, true);
    assert.deepEqual(calls, [['start', { workspace: 'D:/Code' }], ['stop'], ['restart', {}]]);
  } finally { await f.api.close(); fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('runtime rejects unauthenticated private routes', async () => {
  const f = await fixture();
  try {
    const result = await request(f.port, '/api/sessions', { headers: { Authorization: 'Bearer wrong' } });
    assert.equal(result.status, 401);
    assert.equal(result.data.error.code, 'invalid_api_key');
  } finally { await f.api.close(); fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('provider login is exposed through the shared local API', async () => {
  const f = await fixture();
  try {
    const result = await request(f.port, '/api/providers/deepseek/login', { method: 'POST', body: {} });
    assert.equal(result.status, 200);
    assert.deepEqual(result.data, { provider: 'deepseek', login_opened: true });
  } finally { await f.api.close(); fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('provider account API supports create, select, login and delete', async () => {
  const f = await fixture();
  const calls = [];
  f.api.providers.listAccounts = (provider) => ({ provider, active_account_id: 'default', data: [{ id: 'default', active: true }] });
  f.api.providers.createAccount = (provider, name) => { calls.push(['create', provider, name]); return { id: 'account-two', name }; };
  f.api.providers.selectAccount = async (provider, id) => { calls.push(['select', provider, id]); return { provider, active_account_id: id, data: [] }; };
  f.api.providers.setAccountOrder = (provider, order) => { calls.push(['order', provider, order]); return { provider, active_account_id: 'default', failover_order: order, data: [] }; };
  f.api.providers.setBrowserVisibility = async (provider, visible) => { calls.push(['visibility', provider, visible]); return { provider, browser_visible: visible, data: [] }; };
  f.api.providers.authenticate = async (provider, input) => { calls.push(['login', provider, input.account_id]); return { provider, account_id: input.account_id, login_opened: true }; };
  f.api.providers.removeAccount = async (provider, id) => { calls.push(['delete', provider, id]); return { provider, active_account_id: 'default', data: [] }; };
  try {
    assert.equal((await request(f.port, '/api/providers/deepseek/accounts')).data.active_account_id, 'default');
    assert.equal((await request(f.port, '/api/providers/deepseek/accounts', { method: 'POST', body: { name: '备用' } })).status, 201);
    assert.equal((await request(f.port, '/api/providers/deepseek/accounts/account-two/select', { method: 'POST', body: {} })).data.active_account_id, 'account-two');
    assert.deepEqual((await request(f.port, '/api/providers/deepseek/accounts/order', { method: 'PATCH', body: { order: ['account-two', 'default'] } })).data.failover_order, ['account-two', 'default']);
    assert.equal((await request(f.port, '/api/providers/deepseek/browser-visibility', { method: 'PATCH', body: { visible: true } })).data.browser_visible, true);
    assert.equal((await request(f.port, '/api/providers/deepseek/accounts/account-two/login', { method: 'POST', body: {} })).data.login_opened, true);
    assert.equal((await request(f.port, '/api/providers/deepseek/accounts/account-two', { method: 'DELETE' })).status, 200);
    assert.deepEqual(calls, [['create', 'deepseek', '备用'], ['select', 'deepseek', 'account-two'], ['order', 'deepseek', ['account-two', 'default']], ['visibility', 'deepseek', true], ['login', 'deepseek', 'account-two'], ['delete', 'deepseek', 'account-two']]);
  } finally { await f.api.close(); fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('runtime advertises ChatGPT as an available web provider', async () => {
  const f = await fixture();
  try {
    const result = await request(f.port, '/api/providers');
    assert.equal(result.status, 200);
    assert.deepEqual(result.data.data.map((item) => item.id), ['deepseek', 'qwen', 'chatgpt']);
  } finally { await f.api.close(); fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('permanent trash deletion removes the remote web conversation before the local record', async () => {
  let cleaned = null;
  const f = await fixture({ cleanupSession: async (session) => { cleaned = session.id; return true; } });
  try {
    const session = f.store.create({ title: 'remote test', model: 'chatgpt.web' });
    f.store.update(session.id, { provider_state: { provider: 'chatgpt', url: 'https://chatgpt.com/c/test-id', last_run_id: 'run-test' } });
    f.store.trash(session.id);
    const result = await request(f.port, '/api/sessions/' + session.id + '?permanent=1&remote=1', { method: 'DELETE' });
    assert.equal(result.status, 200);
    assert.equal(cleaned, session.id);
    assert.equal(f.store.get(session.id), null);
  } finally { await f.api.close(); fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('failed remote deletion preserves the trashed local record', async () => {
  const f = await fixture({ cleanupSession: async () => false });
  try {
    const session = f.store.create({ title: 'remote test', model: 'deepseek.fast' });
    f.store.update(session.id, { provider_state: { provider: 'deepseek', url: 'https://chat.deepseek.com/a/chat/s/test-id', last_run_id: 'run-test' } });
    f.store.trash(session.id);
    const result = await request(f.port, '/api/sessions/' + session.id + '?permanent=1&remote=1', { method: 'DELETE' });
    assert.equal(result.status, 502);
    assert.equal(result.data.error.code, 'remote_delete_failed');
    assert.ok(f.store.get(session.id));
  } finally { await f.api.close(); fs.rmSync(f.root, { recursive: true, force: true }); }
});
