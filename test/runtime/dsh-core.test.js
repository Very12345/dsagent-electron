'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { SessionStore } = require('../../src/runtime/session-store');
const { TransportRunService } = require('../../src/runtime/transport-run-service');
const { RuntimeApiServer } = require('../../src/runtime/api-server');
const { buildInject, authenticationProbeScript } = require('../../src/node/provider-worker-factory');
const { parseArgs } = require('../../src/node/dsh-core');
const { createQwenServer } = require('../../server-qwen');

function request(port, route, token, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path: route, method, headers: token ? { Authorization: 'Bearer ' + token, 'Content-Length': '0' } : {} }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('DSH-core injection excludes the retired webpage agent and tool bundle', () => {
  const source = buildInject(path.join(__dirname, '..', '..'), 'deepseek', { transportOnly: true });
  assert.match(source, /window\.__dsagent_injected/);
  assert.doesNotMatch(source, /DS Agent Engine/);
  assert.doesNotMatch(source, /Tool System -/);
});

test('provider authentication probe preserves regular-expression escapes for Playwright', () => {
  const source = authenticationProbeScript('textarea[placeholder]');
  assert.doesNotThrow(() => new Function(source));
  assert.match(source, /split\(\/\\r\?\\n\/\)/);
  assert.match(source, /replace\(\/\\s\+\/g/);
});

test('transport run service forwards one provider completion without executing an internal agent', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-core-run-'));
  try {
    const store = new SessionStore(root).init();
    const session = store.create({ model: 'deepseek.web', mode: 'chat', hidden: true });
    let received = null;
    const providers = {
      async complete(context) {
        received = context;
        context.onProgress('provider output');
        return { content: '<dsh_tool_call>{"name":"read","arguments":{"file_path":"README.md"}}</dsh_tool_call>', reasoning: 'reasoning', images: ['https://example.test/image.png'], provider_state: { provider: 'deepseek', url: 'https://chat.deepseek.com/chat/test' } };
      },
      stop: async () => true,
      retryPendingCleanup: async (state) => state
    };
    const runs = new TransportRunService({ store, providers });
    const started = await runs.startRun(session.id, { model: 'deepseek.web', messages: [{ role: 'user', content: 'inspect' }], prompt_passthrough: true, provider_tools: [{ name: 'read' }], agent_mode: true });
    const completed = await runs.waitForRun(started.id);
    assert.equal(runs.runs.get(started.id).agent_mode, false);
    assert.equal(received.run.provider_tools[0].name, 'read');
    assert.match(completed.output, /dsh_tool_call/);
    assert.equal(completed.status, 'completed');
    assert.deepEqual(completed.images, ['https://example.test/image.png']);
    assert.equal(store.get(session.id).messages.filter((message) => message.role === 'tool').length, 0);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('DSH-core API hides built-in agent session routes', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-core-api-'));
  const store = new SessionStore(root).init();
  const providers = { status: () => ({ deepseek: {} }), listModels: () => [], supportedWebProviders: () => ['deepseek'], listAccounts: () => ({ active_account_id: 'default', data: [{ id: 'default', name: '默认账号' }] }) };
  const api = new RuntimeApiServer({ store, providers, runs: {}, token: 'core-token', providerOnly: true, port: 0 });
  try {
    const address = await api.start();
    const response = await request(address.port, '/api/sessions', 'core-token');
    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, 'dsh_core_only');
  } finally {
    await api.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('DSH-core CLI uses a Linux-compatible browser default', () => {
  const args = parseArgs(['--workspace', process.cwd(), '--no-open']);
  assert.equal(args.noOpen, true);
  assert.equal(args.channel, process.platform === 'win32' ? 'msedge' : '');
});

test('the provider runtime starts without a bundled DSH and exposes no Harness manager', async () => {
  const { createDshCoreRuntime } = require('../../src/runtime/dsh-core-runtime');
  const { createDeepseekServer } = require('../../server-deepseek');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-provider-only-'));
  let runtime;
  try {
    runtime = await createDshCoreRuntime({ home, port: 0, createDeepseekServer,
      providerHost: { createWorker: async () => { throw new Error('no browser should be opened'); }, close: async () => {} }
    });
    const health = await request(runtime.info.port, '/health', '');
    assert.equal(health.body.product, 'DSH Web Model Runtime');
    assert.equal((await request(runtime.info.port, '/api/harness', runtime.info.token)).status, 404);
    assert.equal((await request(runtime.info.port, '/api/harness/start', runtime.info.token, 'POST')).status, 404);
    assert.equal(parseArgs([]).runtimeOnly, true);
  } finally { if (runtime) await runtime.close(); fs.rmSync(home, { recursive: true, force: true }); }
});
