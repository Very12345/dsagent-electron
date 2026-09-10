'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const yaml = require('js-yaml');
const { DeepSeekHarnessService, availablePort } = require('../../src/runtime/deepseek-harness-service');
const { extractDshToolCallsFromReasoning, extractDshToolCallsFromText, parseDshToolCall, hasIncompleteDshToolEnvelope, isStableDeepseekCompletion, parseDeepseekRawSse } = require('../../server-deepseek');

test('DeepSeek Harness service writes an isolated WebAgent API provider without storing the bearer token', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'webagent-dsh-'));
  const home = path.join(root, 'home');
  try {
    fs.mkdirSync(path.join(root, 'node_modules', '@deepseek-ai', 'dsh', 'lib'), { recursive: true });
    fs.writeFileSync(path.join(root, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'), '', 'utf8');
    const service = new DeepSeekHarnessService({ root, home, runtimePort: 5858, runtimeToken: 'secret-token' });
    service._writeSettings();
    fs.mkdirSync(path.join(root, 'integrations', 'dsh-webagent-plugin'), { recursive: true });
    const raw = fs.readFileSync(path.join(home, 'settings.yaml'), 'utf8');
    const settings = yaml.load(raw);
    const provider = settings['llm-pi-ai'].providers.webagent;
    assert.equal(provider.baseURL, 'http://127.0.0.1:5858/api.openai.com/v1');
    assert.equal(provider.apiKeyEnv, 'WEBAGENT_DSH_TOKEN');
    assert.equal(provider.headers['X-WebAgent-Tool-Bridge'], 'dsh');
    assert.equal(provider.headers['X-WebAgent-Ephemeral'], undefined);
    assert.equal(provider.cacheRetention, 'short');
    assert.equal(provider.reasoning, 'off');
    assert.deepEqual(provider.compat, { thinkingFormat: 'deepseek', supportsReasoningEffort: true, supportsUsageInStreaming: true });
    assert.deepEqual(provider.models[0].reasoningEfforts, { off: null, high: 'high' });
    assert.deepEqual(provider.models[0].input, ['text', 'image']);
    assert.deepEqual(provider.models.map((model) => model.id), ['deepseek.web', 'qwen.3.7', 'qwen.3.8-max', 'qwen.3.7-max', 'qwen.3.6-flash', 'qwen.gateway.3.8-max', 'qwen.gateway.3.7-max', 'qwen.gateway.3.7-plus', 'qwen.gateway.3.6-plus', 'chatgpt.web']);
    assert.deepEqual(provider.models.filter((model) => model.id.startsWith('qwen.')).map((model) => model.name), [
      'Qianwen3.7-Web',
      'Qianwen3.8Max-Web',
      'Qianwen3.7Max-Web',
      'Qianwen3.6Flash-Web',
      'Qianwen3.8Max-Gate',
      'Qianwen3.7Max-Gate',
      'Qianwen3.7Plus-Gate',
      'Qianwen3.6Plus-Gate'
    ]);
    assert.deepEqual(provider.models[1].input, ['text', 'image']);
    assert.equal(provider.models[1].contextWindow, 32768);
    assert.deepEqual(provider.models[2].input, ['text', 'image']);
    assert.equal(provider.models[2].contextWindow, 32768);
    assert.deepEqual(provider.models[3].input, ['text']);
    assert.equal(provider.models[3].contextWindow, 32768);
    assert.deepEqual(provider.models[4].input, ['text', 'image']);
    assert.equal(provider.models[4].contextWindow, 32768);
    assert.deepEqual(provider.models[5].input, ['text', 'image']);
    assert.equal(provider.models[5].contextWindow, 256000);
    for (const model of provider.models.slice(5, 9)) {
      assert.deepEqual(model.input, ['text', 'image']);
      assert.equal(model.contextWindow, 256000);
      assert.deepEqual(model.reasoningEfforts, { off: null, minimal: 'low', low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' });
    }
    assert.deepEqual(provider.models[9].input, ['text']);
    assert.equal(provider.models[9].contextWindow, 128000);
    assert.equal(settings['agent-default-model'].provider, 'webagent');
    assert.equal(raw.includes('secret-token'), false);
    assert.equal(service.status().installed, true);
    assert.equal(service.status().web_models_registered, false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('DeepSeek Harness host overlay registers the WebAgent provider at boot', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'webagent-dsh-overlay-'));
  const home = path.join(root, 'home');
  const pluginRoot = path.join(root, 'integrations', 'dsh-webagent-plugin');
  try {
    fs.mkdirSync(pluginRoot, { recursive: true });
    fs.writeFileSync(path.join(pluginRoot, 'package.json'), JSON.stringify({ name: '@webagent/dsh-integration', version: '1.0.0' }), 'utf8');
    fs.mkdirSync(path.join(home, 'profiles', 'web'), { recursive: true });
    fs.writeFileSync(path.join(home, 'profiles', 'web', 'package.json'), JSON.stringify({ dependencies: { '@webagent/dsh-integration': 'link:' + pluginRoot } }), 'utf8');
    const service = new DeepSeekHarnessService({ root, home, runtimePort: 5858, runtimeToken: 'secret-token' });
    await service._ensurePlugin({});
    const raw = fs.readFileSync(service._pluginPatch(), 'utf8');
    const overlay = yaml.load(raw);
    const adapter = overlay.find((entry) => entry.id === 'llm-pi-ai');
    const defaultModel = overlay.find((entry) => entry.id === 'agent-default-model');
    assert.deepEqual(adapter.config.providers.webagent.models.map((model) => model.id), ['deepseek.web', 'qwen.3.7', 'qwen.3.8-max', 'qwen.3.7-max', 'qwen.3.6-flash', 'qwen.gateway.3.8-max', 'qwen.gateway.3.7-max', 'qwen.gateway.3.7-plus', 'qwen.gateway.3.6-plus', 'chatgpt.web']);
    assert.equal(adapter.config.providers.webagent.apiKeyEnv, 'WEBAGENT_DSH_TOKEN');
    assert.deepEqual(defaultModel.config, { provider: 'webagent', model: 'deepseek.web' });
    assert.equal(raw.includes('secret-token'), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('DeepSeek Harness removes only retired presets previously managed by WebAgent', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'webagent-dsh-presets-'));
  const home = path.join(root, 'home');
  try {
    const managedRoot = path.join(home, '.agent-presets');
    for (const id of ['anchored-standard', 'router-standard']) {
      const preset = path.join(managedRoot, id);
      fs.mkdirSync(preset, { recursive: true });
      fs.writeFileSync(path.join(preset, '.webagent-managed.json'), JSON.stringify({ product: 'WebAgent', id }), 'utf8');
      fs.writeFileSync(path.join(preset, 'preset.yml'), 'name: Retired\n', 'utf8');
    }
    const service = new DeepSeekHarnessService({ root, home, runtimePort: 5858, runtimeToken: 'secret-token' });
    assert.deepEqual(service._removeRetiredManagedPresets(), ['anchored-standard', 'router-standard']);
    assert.equal(fs.existsSync(path.join(managedRoot, 'anchored-standard')), false);
    assert.equal(fs.existsSync(path.join(managedRoot, 'router-standard')), false);
    assert.deepEqual(service.status().presets, []);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('DeepSeek Harness preserves retired presets it does not own', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'webagent-dsh-user-preset-'));
  const home = path.join(root, 'home');
  try {
    const custom = path.join(home, '.agent-presets', 'anchored-standard');
    fs.mkdirSync(custom, { recursive: true });
    fs.writeFileSync(path.join(custom, 'preset.yml'), 'name: User Custom\n', 'utf8');
    const service = new DeepSeekHarnessService({ root, home, runtimePort: 5858, runtimeToken: 'secret-token' });
    const removed = service._removeRetiredManagedPresets();
    assert.equal(fs.readFileSync(path.join(custom, 'preset.yml'), 'utf8'), 'name: User Custom\n');
    assert.deepEqual(removed, []);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
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

test('WebAgent DSH plugin contributes a provider-scoped webpage transport prompt', async () => {
  const file = path.join(__dirname, '..', '..', 'integrations', 'dsh-webagent-plugin', 'lib', 'index.js');
  const plugin = await import(pathToFileURL(file).href + '?test=' + Date.now());
  let section = null;
  let tool = null;
  const ctx = {
    systemPrompt: { section: (value) => { section = value; return () => {}; } },
    tools: { register: (value) => { tool = value; return () => {}; } },
    effect: (factory) => factory()
  };
  plugin.apply(ctx);
  assert.equal(section.complete, undefined);
  const webText = section.text({ agent: { options: { provider: 'webagent' } } });
  assert.match(webText, /WEBAGENT_DSH_BRIDGE_V2/);
  assert.match(webText, /```dsh-tool-call/);
  assert.match(webText, /Native <｜DSML｜tool_calls>/);
  assert.match(webText, /raw provider stream/);
  assert.match(webText, /Preserve arguments exactly/);
  assert.ok(webText.length < 2400);
  assert.equal(section.text({ agent: { options: { provider: 'deepseek-official' } } }), '');
  assert.equal(tool.name, 'deepseek_vision');
});

test('DeepSeek vision tool bridges a local image through the unified model', async () => {
  const file = path.join(__dirname, '..', '..', 'integrations', 'dsh-webagent-plugin', 'lib', 'index.js');
  const plugin = await import(pathToFileURL(file).href + '?vision=' + Date.now());
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'webagent-vision-'));
  const image = path.join(root, 'probe.png');
  fs.writeFileSync(image, Buffer.from('89504e470d0a1a0a', 'hex'));
  let tool = null;
  let requestBody = null;
  let requestHeaders = null;
  const oldFetch = global.fetch;
  const oldUrl = process.env.WEBAGENT_RUNTIME_URL;
  const oldToken = process.env.WEBAGENT_DSH_TOKEN;
  global.fetch = async (_url, options) => {
    requestBody = JSON.parse(options.body);
    requestHeaders = options.headers;
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'VISIBLE_UI_OK' } }] }) };
  };
  process.env.WEBAGENT_RUNTIME_URL = 'http://127.0.0.1:5858';
  process.env.WEBAGENT_DSH_TOKEN = 'test-token';
  try {
    plugin.apply({
      systemPrompt: { section: () => () => {} },
      tools: { register: (value) => { tool = value; return () => {}; } },
      effect: (factory) => factory()
    });
    const result = await tool.execute({ image_path: image, prompt: 'What is visible?' }, { signal: new AbortController().signal });
    assert.deepEqual(result, { description: 'VISIBLE_UI_OK', model: 'deepseek.web' });
    assert.equal(requestBody.model, 'deepseek.web');
    assert.equal(requestHeaders['X-WebAgent-Ephemeral'], 'true');
    assert.match(requestBody.messages[0].content[1].image_url.url, /^data:image\/png;base64,/);
  } finally {
    global.fetch = oldFetch;
    if (oldUrl === undefined) delete process.env.WEBAGENT_RUNTIME_URL; else process.env.WEBAGENT_RUNTIME_URL = oldUrl;
    if (oldToken === undefined) delete process.env.WEBAGENT_DSH_TOKEN; else process.env.WEBAGENT_DSH_TOKEN = oldToken;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('WebAgent DSH integration is host-only and leaves the upstream WebUI untouched', () => {
  const root = path.join(__dirname, '..', '..', 'integrations', 'dsh-webagent-plugin');
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.equal(manifest.dsh, undefined);
  assert.equal(manifest.exports['./client'], undefined);
  assert.equal(fs.existsSync(path.join(root, 'lib', 'client.js')), false);
});

test('DeepSeek Harness resolves the selected session to its owning workspace', async () => {
  const workspacePath = path.join(os.tmpdir(), 'webagent-current-dsh-workspace');
  const service = new DeepSeekHarnessService({ root: process.cwd(), runtimePort: 5858, runtimeToken: 'token' });
  service.url = 'http://127.0.0.1:3080';
  service._readWorkspaceBaseline = async () => ({ items: [{
      workspaceId: 'workspace-current',
      path: workspacePath,
      title: 'Current project',
      sessionIds: ['session-current', 'session-other']
    }], archivedSessionIds: [] });
  assert.deepEqual(await service.workspaceForSession('session-current'), {
    session_id: 'session-current', workspace_id: 'workspace-current', path: workspacePath, title: 'Current project'
  });
  assert.equal(service.isKnownWorkspace(workspacePath), true);
  assert.equal(await service.workspaceForSession('session-missing'), null);
});

test('Harness archive synchronization uses the official external API without a client plugin', async () => {
  const http = require('http');
  const archivedId = 'session-upstream-archive';
  const received = [];
  const runtime = http.createServer((req, res) => {
    received.push({ url: req.url, authorization: req.headers.authorization });
    req.resume();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ archived: archivedId, remote_deleted: true }));
  });
  const archived = [];
  await new Promise((resolve) => runtime.listen(0, '127.0.0.1', resolve));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'webagent-dsh-archive-'));
  const service = new DeepSeekHarnessService({ root, runtimePort: runtime.address().port, runtimeToken: 'archive-token' });
  service.url = 'http://127.0.0.1:3080';
  service._readWorkspaceBaseline = async () => ({ items: [], archivedSessionIds: [...archived] });
  try {
    service._startArchiveSync();
    const baselineDeadline = Date.now() + 3000;
    while (!service.archiveSyncInitialized && Date.now() < baselineDeadline) await new Promise((resolve) => setTimeout(resolve, 20));
    archived.push(archivedId);
    const deadline = Date.now() + 3000;
    while (!received.length && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(received.length, 1);
    assert.equal(received[0].url, '/api/harness/sessions/' + archivedId + '/archive');
    assert.equal(received[0].authorization, 'Bearer archive-token');
  } finally {
    service._stopArchiveSync();
    await new Promise((resolve) => runtime.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('DeepSeek Harness port selection stays on loopback and skips occupied ports', async () => {
  const net = require('net');
  const blocker = net.createServer();
  await new Promise((resolve) => blocker.listen(0, '127.0.0.1', resolve));
  const occupied = blocker.address().port;
  try { assert.equal(await availablePort(occupied), occupied + 1); }
  finally { await new Promise((resolve) => blocker.close(resolve)); }
});

test('DeepSeek Harness recovers a deleted requested workspace before spawning', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'webagent-dsh-workspace-recovery-'));
  const fallback = path.join(root, 'fallback');
  fs.mkdirSync(fallback, { recursive: true });
  const service = new DeepSeekHarnessService({
    root,
    defaultWorkspace: fallback,
    runtimePort: 5858,
    runtimeToken: 'token'
  });
  const missing = path.join(root, 'deleted-acceptance-project');
  assert.equal(service._isDirectory(missing), false);
  assert.equal(service._isDirectory(fallback), true);

  service.workspace = service._resolveWorkspace(missing);

  assert.equal(service.status().workspace, fallback);
  assert.deepEqual(service.status().workspace_recovery, {
    code: 'harness_workspace_recovered',
    requested: missing,
    fallback
  });
  fs.rmSync(root, { recursive: true, force: true });
});
