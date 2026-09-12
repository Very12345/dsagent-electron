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
const { DeepSeekHarnessService } = require('../../src/runtime/deepseek-harness-service');
const { buildInject, authenticationProbeScript } = require('../../src/node/provider-worker-factory');
const { parseArgs } = require('../../src/node/dsh-core');
const { createQwenServer } = require('../../server-qwen');
const { dshShellHtml } = require('../../src/runtime/dsh-shell');

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

test('DSH Core shell script is valid and exposes distinct refresh and restart controls', () => {
  const document = dshShellHtml({ harnessUrl: 'http://127.0.0.1:3080' });
  const script = document.match(/<script>([\s\S]*)<\/script>/);
  assert.ok(script);
  assert.doesNotThrow(() => new Function(script[1]));
  assert.match(document, />刷新页面<\/button>/);
  assert.match(document, />重启 DSH<\/button>/);
  assert.match(document, /\/api\/dsh-shell\/restart/);
});

test('DeepSeek Harness restart preserves its current workspace and port', async () => {
  const service = new DeepSeekHarnessService({ root: process.cwd(), runtimePort: 5858, runtimeToken: 'token' });
  service.workspace = path.resolve('test-workspace');
  service.port = 3091;
  const calls = [];
  service.stop = async () => { calls.push(['stop']); };
  service.start = async (input) => { calls.push(['start', input]); return { running: true, ...input }; };
  const result = await service.restart({});
  assert.equal(result.running, true);
  assert.deepEqual(calls, [['stop'], ['start', { workspace: path.resolve('test-workspace'), port: 3091 }]]);
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

test('DSH-core exchanges a one-time browser ticket for the internal Harness cookie', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-core-ticket-'));
  const store = new SessionStore(root).init();
  const providers = { status: () => ({}), listModels: () => [], supportedWebProviders: () => ['deepseek'] };
  const api = new RuntimeApiServer({ store, providers, runs: {}, token: 'core-token', providerOnly: true, port: 0 });
  api.harness = { url: 'http://127.0.0.1:3080', browserCookie: 'dsh_session=secret' };
  try {
    const address = await api.start();
    const issued = await request(address.port, '/api/harness/browser-ticket', 'core-token', 'POST');
    assert.equal(issued.status, 201);
    const ticketPath = new URL(issued.body.url).pathname + new URL(issued.body.url).search;
    const redeemed = await new Promise((resolve, reject) => {
      const req = http.get({ hostname: '127.0.0.1', port: address.port, path: ticketPath }, (res) => { res.resume(); res.on('end', () => resolve(res)); });
      req.on('error', reject);
    });
    assert.equal(redeemed.statusCode, 303);
    assert.match(redeemed.headers.location, /\/dsh$/);
    assert.match(redeemed.headers['set-cookie'][0], /^dsh_session=secret;/);
    assert.match(redeemed.headers['set-cookie'][1], /^webagent_dsh_shell=/);
    const shellCookie = redeemed.headers['set-cookie'][1].split(';')[0];
    const shell = await new Promise((resolve, reject) => {
      const req = http.get({ hostname: '127.0.0.1', port: address.port, path: '/dsh', headers: { Cookie: shellCookie } }, (res) => {
        const chunks = []; res.on('data', (chunk) => chunks.push(chunk)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
      });
      req.on('error', reject);
    });
    assert.equal(shell.status, 200);
    assert.match(shell.body, /DSH Core/);
    assert.match(shell.body, /登录 \/ 切换/);
    assert.match(shell.body, /查看网页/);
    assert.match(shell.body, /Qianwen 生图/);
    assert.match(shell.body, /刷新页面/);
    assert.match(shell.body, /重启 DSH/);
    assert.match(shell.body, /dsh-core-toolbar-collapsed/);
    assert.match(shell.body, /resizeHandle/);
    assert.match(shell.body, /allow="clipboard-read; clipboard-write"/);
    assert.match(shell.headers['permissions-policy'], /clipboard-read/);
    api.harness.restart = async () => {
      api.harness.browserCookie = 'dsh_session=restarted';
      return { running: true, url: 'http://127.0.0.1:3080' };
    };
    const restarted = await new Promise((resolve, reject) => {
      const body = '{}';
      const req = http.request({ hostname: '127.0.0.1', port: address.port, path: '/api/dsh-shell/restart', method: 'POST', headers: { Cookie: shellCookie, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, (res) => {
        const chunks = []; res.on('data', (chunk) => chunks.push(chunk)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
      });
      req.on('error', reject); req.end(body);
    });
    assert.equal(restarted.status, 200);
    assert.equal(restarted.body.running, true);
    assert.match(restarted.headers['set-cookie'][0], /^dsh_session=restarted;/);
    const shellAfterRestart = await new Promise((resolve, reject) => {
      const req = http.get({ hostname: '127.0.0.1', port: address.port, path: '/dsh', headers: { Cookie: shellCookie } }, (res) => { res.resume(); res.on('end', () => resolve(res)); });
      req.on('error', reject);
    });
    assert.equal(shellAfterRestart.statusCode, 200);
    const repeated = await request(address.port, ticketPath, '');
    assert.equal(repeated.status, 401);
  } finally {
    await api.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('DSH-core advertises DeepSeek and the chat.qwen.ai capability models', () => {
  const resolvedBin = require.resolve('@deepseek-ai/dsh/lib/bin.js');
  const service = new DeepSeekHarnessService({ root: process.cwd(), runtimePort: 5858, runtimeToken: 'token', coreOnly: true, dshBin: resolvedBin });
  assert.deepEqual(service._webAgentProvider().models.map((model) => model.id), [
    'deepseek.web',
    'qwen.text.web.3.8-max',
    'qwen.text.web.3.7-plus'
  ]);
  assert.equal(service._bin(), resolvedBin);
  assert.ok(createQwenServer(() => null).models['qwen.image.web']);
});

test('DSH-core CLI uses a Linux-compatible browser default', () => {
  const args = parseArgs(['--workspace', process.cwd(), '--no-open']);
  assert.equal(args.noOpen, true);
  assert.equal(args.channel, process.platform === 'win32' ? 'msedge' : '');
});
