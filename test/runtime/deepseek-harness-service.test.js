'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { pathToFileURL } = require('url');
const yaml = require('js-yaml');
const { DeepSeekHarnessService, availablePort } = require('../../src/runtime/deepseek-harness-service');
const { extractDshToolCallsFromReasoning, extractDshToolCallsFromText, parseDshToolCall, hasIncompleteDshToolEnvelope, isStableDeepseekCompletion, parseDeepseekRawSse, mergeContinuationText, mergeRawResponseRecord, createRawResponseAggregate, createDeepseekServer, detectReasoningLoop } = require('../../server-deepseek');

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
    const web = overlay.find((entry) => entry.id === 'web');
    const paidSearch = overlay.find((entry) => entry.id === 'web-search-deepseek');
    const webTool = overlay.find((entry) => entry.id === 'tool-web');
    assert.deepEqual(adapter.config.providers.webagent.models.map((model) => model.id), ['deepseek.web', 'qwen.3.7', 'qwen.3.8-max', 'qwen.3.7-max', 'qwen.3.6-flash', 'qwen.gateway.3.8-max', 'qwen.gateway.3.7-max', 'qwen.gateway.3.7-plus', 'qwen.gateway.3.6-plus', 'chatgpt.web']);
    assert.equal(adapter.config.providers.webagent.apiKeyEnv, 'WEBAGENT_DSH_TOKEN');
    assert.deepEqual(defaultModel.config, { provider: 'webagent', model: 'deepseek.web' });
    assert.deepEqual(web.config, { searchProvider: 'webagent-web-search', fetchProvider: 'http' });
    assert.equal(paidSearch.disabled, true);
    assert.deepEqual(webTool.config, { fetch: true, searchTimeoutMs: 180000, searchMaxQueries: 2 });
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

test('Linux cleanup removes only the WebAgent-owned redundant minimal preset', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'webagent-dsh-linux-minimal-'));
  const home = path.join(root, 'home');
  try {
    const preset = path.join(home, '.agent-presets', 'webagent-minimal-stable');
    fs.mkdirSync(preset, { recursive: true });
    fs.writeFileSync(path.join(preset, '.webagent-managed.json'), JSON.stringify({ product: 'WebAgent', id: 'webagent-minimal-stable' }), 'utf8');
    fs.writeFileSync(path.join(preset, 'preset.yml'), 'name: managed\n', 'utf8');
    const service = new DeepSeekHarnessService({ root, home, runtimePort: 5858, runtimeToken: 'token' });
    const removed = service._removeRetiredManagedPresets(['webagent-minimal-stable']);
    assert.ok(removed.includes('webagent-minimal-stable'));
    assert.equal(fs.existsSync(preset), false);
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

test('WebAgent installs a managed minimal preset backed by fresh-process pwsh', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'webagent-dsh-stable-minimal-'));
  const service = new DeepSeekHarnessService({ root: path.join(__dirname, '..', '..'), runtimePort: 5858, runtimeToken: 'test-token', home });
  try {
    assert.equal(service._installStableMinimalPreset(), true);
    const presetRoot = path.join(home, '.agent-presets', 'webagent-minimal-stable');
    const composition = fs.readFileSync(path.join(presetRoot, 'agent.cordis.yml'), 'utf8');
    assert.match(composition, /@deepseek-ai\/dsh-tool-pwsh'/);
    assert.doesNotMatch(composition, /pwsh-persistent/);
    assert.equal(JSON.parse(fs.readFileSync(path.join(presetRoot, '.webagent-managed.json'), 'utf8')).product, 'WebAgent');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
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

test('WebAgent DSH plugin contributes a provider-scoped webpage transport prompt', async () => {
  const file = path.join(__dirname, '..', '..', 'integrations', 'dsh-webagent-plugin', 'lib', 'index.js');
  const plugin = await import(pathToFileURL(file).href + '?test=' + Date.now());
  let section = null;
  const tools = [];
  let searchProvider = null;
  const ctx = {
    systemPrompt: { section: (value) => { section = value; return () => {}; } },
    tools: { register: (value) => { tools.push(value); return () => {}; } },
    web: { registerSearchProvider: (value) => { searchProvider = value; return () => {}; } },
    effect: (factory) => factory()
  };
  plugin.apply(ctx);
  assert.equal(section.complete, undefined);
  const webText = section.text({ agent: { options: { provider: 'webagent', model: 'deepseek.web' } } });
  assert.match(webText, /WEBAGENT_DSH_BRIDGE_V3/);
  assert.match(webText, /<｜DSML｜tool_calls>/);
  assert.doesNotMatch(webText, /dsh-tool-call/);
  assert.match(webText, /no alternative tool protocol/);
  assert.match(webText, /Preserve arguments exactly/);
  assert.ok(webText.length < 2400);
  const qwenText = section.text({ agent: { options: { provider: 'webagent', model: 'qwen.text.web.3.8-max' } } });
  assert.match(qwenText, /WEBAGENT_QWEN_NATIVE_TOOLS_V1/);
  assert.match(qwenText, /<tool_call>/);
  assert.match(qwenText, /native JSON tool-call form/);
  assert.doesNotMatch(qwenText, /<｜DSML｜tool_calls>/);
  assert.equal(section.text({ agent: { options: { provider: 'deepseek-official' } } }), '');
  assert.deepEqual(tools.map((tool) => tool.name), ['qianwen_text', 'qianwen_search', 'qianwen_image', 'qianwen_voice']);
  assert.equal(searchProvider.id, 'webagent-web-search');
});

test('WebAgent image tools are hidden only from minimal preset scopes', async () => {
  const file = path.join(__dirname, '..', '..', 'integrations', 'dsh-webagent-plugin', 'lib', 'index.js');
  const plugin = await import(pathToFileURL(file).href + '?minimal-scope=' + Date.now());
  let createdHandler = null;
  let preset = 'minimal';
  const restrictions = [];
  const agent = { ctx: { tools: { restrict: (value) => { restrictions.push(value); return () => {}; } } } };
  plugin.apply({
    systemPrompt: { section: () => () => {} },
    tools: { register: () => () => {}, get: () => ({}) },
    web: { registerSearchProvider: () => () => {} },
    effect: (factory) => factory(),
    get: (name) => name === 'agentPresets' ? { composedPreset: () => preset } : undefined,
    on: (event, handler) => { if (event === 'agent/created') createdHandler = handler; return () => {}; }
  });
  createdHandler({ agent });
  assert.deepEqual(restrictions, [{ deny: ['qianwen_text', 'qianwen_search', 'qianwen_image', 'qianwen_voice'] }]);
  preset = 'standard';
  createdHandler({ agent });
  assert.equal(restrictions.length, 1);
});

test('WebAgent DSH web search uses an ephemeral native webpage search and returns source URLs', async () => {
  const file = path.join(__dirname, '..', '..', 'integrations', 'dsh-webagent-plugin', 'lib', 'index.js');
  const plugin = await import(pathToFileURL(file).href + '?search=' + Date.now());
  let searchProvider = null;
  let requestBody = null;
  let requestHeaders = null;
  const oldFetch = global.fetch;
  const oldUrl = process.env.WEBAGENT_RUNTIME_URL;
  const oldToken = process.env.WEBAGENT_DSH_TOKEN;
  global.fetch = async (_url, options) => {
    requestBody = JSON.parse(options.body);
    requestHeaders = options.headers;
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'Official docs: [Harness](https://github.com/deepseek-ai/deepseek-harness). More at https://deepseek-harness.github.io/deepseek-harness/.' } }] }) };
  };
  process.env.WEBAGENT_RUNTIME_URL = 'http://127.0.0.1:5858';
  process.env.WEBAGENT_DSH_TOKEN = 'test-token';
  try {
    plugin.apply({
      systemPrompt: { section: () => () => {} },
      tools: { register: () => () => {} },
      web: { registerSearchProvider: (value) => { searchProvider = value; return () => {}; } },
      effect: (factory) => factory()
    });
    assert.equal(searchProvider.available(), true);
    const result = await searchProvider.search({ query: 'DeepSeek Harness repository', maxResults: 4 }, new AbortController().signal);
    assert.equal(requestBody.web_search, true);
    assert.equal(requestBody.stream, false);
    assert.equal(requestHeaders['X-WebAgent-Ephemeral'], 'true');
    assert.deepEqual(result.sources, [
      { url: 'https://github.com/deepseek-ai/deepseek-harness', title: 'Harness' },
      { url: 'https://deepseek-harness.github.io/deepseek-harness/' }
    ]);
    assert.equal(result.truncated, false);
  } finally {
    global.fetch = oldFetch;
    if (oldUrl === undefined) delete process.env.WEBAGENT_RUNTIME_URL; else process.env.WEBAGENT_RUNTIME_URL = oldUrl;
    if (oldToken === undefined) delete process.env.WEBAGENT_DSH_TOKEN; else process.env.WEBAGENT_DSH_TOKEN = oldToken;
  }
});

test('DSH native web search routes through Qianwen when selected in settings', async () => {
  const file = path.join(__dirname, '..', '..', 'integrations', 'dsh-webagent-plugin', 'lib', 'index.js');
  const plugin = await import(pathToFileURL(file).href + '?qwen-native-search=' + Date.now());
  let searchProvider = null;
  let requestBody = null;
  const oldFetch = global.fetch;
  const oldUrl = process.env.WEBAGENT_RUNTIME_URL;
  const oldToken = process.env.WEBAGENT_DSH_TOKEN;
  global.fetch = async (_url, options) => {
    requestBody = JSON.parse(options.body);
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'Qwen result [source](https://example.test/qwen)' } }] }) };
  };
  process.env.WEBAGENT_RUNTIME_URL = 'http://127.0.0.1:5858';
  process.env.WEBAGENT_DSH_TOKEN = 'test-token';
  try {
    plugin.apply({
      systemPrompt: { section: () => () => {} },
      tools: { register: () => () => {} },
      web: { registerSearchProvider: (value) => { searchProvider = value; return () => {}; } },
      effect: (factory) => factory(),
      inject: (_services, callback) => callback({ settings: { installSection: (_owner, _namespace, _schema, _base, hooks) => hooks.setSource(() => ({ provider: 'qianwen' })) } })
    });
    const result = await searchProvider.search({ query: 'Qwen route', maxResults: 3 });
    assert.equal(requestBody.model, 'qwen.search.web');
    assert.equal(requestBody.web_search, undefined);
    assert.equal(requestBody.messages[0].content, 'Qwen route');
    assert.deepEqual(result.sources, [{ url: 'https://example.test/qwen', title: 'source' }]);
  } finally {
    global.fetch = oldFetch;
    if (oldUrl === undefined) delete process.env.WEBAGENT_RUNTIME_URL; else process.env.WEBAGENT_RUNTIME_URL = oldUrl;
    if (oldToken === undefined) delete process.env.WEBAGENT_DSH_TOKEN; else process.env.WEBAGENT_DSH_TOKEN = oldToken;
  }
});

test('Qianwen image tool uses the webpage model and saves generated images in the workspace', async () => {
  const file = path.join(__dirname, '..', '..', 'integrations', 'dsh-webagent-plugin', 'lib', 'index.js');
  const plugin = await import(pathToFileURL(file).href + '?qwen-image=' + Date.now());
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'webagent-qwen-image-'));
  const tools = [];
  let requestBody = null;
  const oldFetch = global.fetch;
  const oldUrl = process.env.WEBAGENT_RUNTIME_URL;
  const oldToken = process.env.WEBAGENT_DSH_TOKEN;
  const oldCwd = process.cwd();
  global.fetch = async (url, options) => {
    if (String(url).startsWith('http://127.0.0.1:5858/')) {
      requestBody = JSON.parse(options.body);
      return { ok: true, status: 200, json: async () => ({ images: ['https://workspace-zb-cdn.qianwen.com/generated.png'], choices: [{ message: { content: '图片已生成', images: ['https://workspace-zb-cdn.qianwen.com/generated.png'] } }] }) };
    }
    return { ok: true, status: 200, headers: { get: (name) => String(name).toLowerCase() === 'content-type' ? 'image/png' : '' }, arrayBuffer: async () => Uint8Array.from([137, 80, 78, 71]).buffer };
  };
  process.env.WEBAGENT_RUNTIME_URL = 'http://127.0.0.1:5858';
  process.env.WEBAGENT_DSH_TOKEN = 'test-token';
  process.chdir(root);
  try {
    plugin.apply({
      systemPrompt: { section: () => () => {} },
      tools: { register: (value) => { tools.push(value); return () => {}; }, get: () => ({}) },
      web: { registerSearchProvider: () => () => {} },
      effect: (factory) => factory()
    });
    const tool = tools.find((item) => item.name === 'qianwen_image');
    assert.ok(tool);
    const result = await tool.execute({ prompt: 'A clean 16:9 blue technology illustration', output_dir: 'assets', filename_prefix: 'cover' }, { signal: new AbortController().signal });
    assert.equal(requestBody.model, 'qwen.image.web');
    assert.match(requestBody.messages[0].content, /<webagent_qwen_image model="qwen-image-3\.0-pro" size="auto">/);
    assert.equal(result.model, 'qwen.image.web');
    assert.equal(result.files.length, 1);
    assert.ok(fs.existsSync(result.files[0]));
    assert.ok(path.resolve(result.files[0]).startsWith(path.join(root, 'assets') + path.sep));
  } finally {
    process.chdir(oldCwd);
    global.fetch = oldFetch;
    if (oldUrl === undefined) delete process.env.WEBAGENT_RUNTIME_URL; else process.env.WEBAGENT_RUNTIME_URL = oldUrl;
    if (oldToken === undefined) delete process.env.WEBAGENT_DSH_TOKEN; else process.env.WEBAGENT_DSH_TOKEN = oldToken;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Qianwen text, search and voice tools call their isolated chat.qwen.ai capabilities', async () => {
  const file = path.join(__dirname, '..', '..', 'integrations', 'dsh-webagent-plugin', 'lib', 'index.js');
  const plugin = await import(pathToFileURL(file).href + '?qwen-capabilities=' + Date.now());
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'webagent-qwen-capabilities-'));
  const tools = [];
  const requests = [];
  const oldFetch = global.fetch;
  const oldUrl = process.env.WEBAGENT_RUNTIME_URL;
  const oldToken = process.env.WEBAGENT_DSH_TOKEN;
  const oldCwd = process.cwd();
  global.fetch = async (url, options) => {
    const body = JSON.parse(options.body);
    requests.push({ url: String(url), body });
    if (String(url).endsWith('/api/qwen/voice/transcriptions')) return { ok: true, status: 200, json: async () => ({ text: '转写完成', model: 'qwen-asr' }) };
    const content = body.model === 'qwen.search.web' ? '结果 [来源](https://example.test/source)' : '普通文本结果';
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content } }] }) };
  };
  process.env.WEBAGENT_RUNTIME_URL = 'http://127.0.0.1:5858';
  process.env.WEBAGENT_DSH_TOKEN = 'test-token';
  process.chdir(root);
  fs.writeFileSync(path.join(root, 'voice.wav'), Buffer.from('RIFF-test'));
  try {
    plugin.apply({
      systemPrompt: { section: () => () => {} },
      tools: { register: (value) => { tools.push(value); return () => {}; }, get: () => ({}) },
      web: { registerSearchProvider: () => () => {} },
      effect: (factory) => factory()
    });
    const textTool = tools.find((tool) => tool.name === 'qianwen_text');
    const searchTool = tools.find((tool) => tool.name === 'qianwen_search');
    const voiceTool = tools.find((tool) => tool.name === 'qianwen_voice');
    assert.equal(await textTool.execute({ prompt: '你好', model: 'Qwen3.8-Max' }, {}), '普通文本结果');
    const searched = await searchTool.execute({ query: '测试', max_results: 4 }, {});
    assert.deepEqual(searched.sources, [{ url: 'https://example.test/source', title: '来源' }]);
    const voice = await voiceTool.execute({ audio_path: 'voice.wav', language: 'zh-CN' }, {});
    assert.equal(voice.text, '转写完成');
    assert.deepEqual(requests.slice(0, 2).map((item) => item.body.model), ['qwen.text.web.3.8-max', 'qwen.search.web']);
    assert.match(requests[2].url, /\/api\/qwen\/voice\/transcriptions$/);
    assert.equal(requests[2].body.filename, 'voice.wav');
  } finally {
    process.chdir(oldCwd);
    global.fetch = oldFetch;
    if (oldUrl === undefined) delete process.env.WEBAGENT_RUNTIME_URL; else process.env.WEBAGENT_RUNTIME_URL = oldUrl;
    if (oldToken === undefined) delete process.env.WEBAGENT_DSH_TOKEN; else process.env.WEBAGENT_DSH_TOKEN = oldToken;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('WebAgent DSH integration contributes a native web-search settings card', () => {
  const root = path.join(__dirname, '..', '..', 'integrations', 'dsh-webagent-plugin');
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.equal(manifest.dsh.client.platform, 'web');
  assert.equal(manifest.exports['./client'], './lib/client.js');
  const client = fs.readFileSync(path.join(root, 'lib', 'client.js'), 'utf8');
  assert.match(client, /webagent-search/);
  assert.match(client, /DeepSeek 网页搜索/);
  assert.match(client, /Qwen 网页搜索/);
});

test('DeepSeek SSE transport disables legacy clipboard automation', () => {
  const injection = fs.readFileSync(path.join(__dirname, '..', '..', 'inject-deepseek.js'), 'utf8');
  assert.match(injection, /let enableAutoExec = false;/);
  const extractor = injection.slice(injection.indexOf('window.__dsagent_extractLastResponse ='), injection.indexOf('// 上传文件到当前对话'));
  assert.ok(extractor.indexOf('clipboardUsed: false') < extractor.indexOf('clipboardSave()'));
  const daemon = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'node', 'daemon.js'), 'utf8');
  const hostConfig = daemon.slice(daemon.indexOf('const rawHost = new PlaywrightProviderHost'), daemon.indexOf('const createWorker ='));
  assert.doesNotMatch(hostConfig, /clipboardBridge/);
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
