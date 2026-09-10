'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { RogatorService, ROGATOR_REVISION, dshGatewayMessages, runtimeGatewayMessages, residualQwenToolFence, dshTextToolFences, gatewayModels, toolCallFences, providerToolCompatibility, compileProviderToolCall, compactExecutedMutationArguments } = require('../../src/runtime/rogator-service');

// Unit tests should not inherit the production account-protection delay.
// Individual limiter/retry tests below opt into small deterministic values.
process.env.WEBAGENT_QWEN_MIN_INTERVAL_MS = '0';
process.env.WEBAGENT_QWEN_AUTOMATIC_RETRIES = '0';

function temporaryHome() { return fs.mkdtempSync(path.join(os.tmpdir(), 'webagent-rogator-test-')); }

test('Rogator gateway configuration is loopback and Qwen-only', () => {
  const home = temporaryHome();
  const source = path.join(home, 'source');
  fs.mkdirSync(path.join(source, 'config', 'upstream', 'qwen'), { recursive: true });
  fs.writeFileSync(path.join(source, 'config', 'upstream', 'qwen', 'config.toml'), '[limits]\nqwen_send_max_chars = 10240\n', 'utf8');
  const service = new RogatorService({ home, source });
  service._writeLockedConfig(18932);
  const config = fs.readFileSync(service.configFile, 'utf8');
  assert.match(config, /host = "127\.0\.0\.1"/);
  assert.match(config, /enabled = \["qwen"\]/);
  assert.doesNotMatch(config, /enabled\s*=.*deepseek/);
  assert.match(fs.readFileSync(service.qwenUpstreamConfigFile, 'utf8'), /qwen_send_max_chars = 65536/);
  assert.equal(service.status().deepseek_enabled, false);
  assert.equal(service.status().revision, ROGATOR_REVISION);
});

test('Qianwen gateway streams reasoning and answer separately when no agent tools are available', async () => {
  const home = temporaryHome();
  let requestBody;
  const service = new RogatorService({
    home,
    fetch: async (_url, options) => {
      requestBody = JSON.parse(options.body);
      return new Response([
        'data: {"choices":[{"delta":{"reasoning":"先分析"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"答案"}}]}\n\n',
        'data: [DONE]\n\n'
      ].join(''), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    }
  });
  service.process = { exitCode: null };
  service.port = 18932;
  const reasoning = [];
  const answer = [];
  const result = await service.complete({
    messages: [{ role: 'system', content: '保持顺序' }, { role: 'user', content: '任务' }],
    instructions: '',
    run: { id: 'run-gateway', deep_think: true },
    onReasoningProgress: (value) => reasoning.push(value),
    onProgress: (value) => answer.push(value)
  });
  assert.deepEqual(reasoning, ['先分析']);
  assert.deepEqual(answer, ['答案']);
  assert.equal(result.reasoning, '先分析');
  assert.equal(result.content, '答案');
  assert.deepEqual(requestBody.messages, [{ role: 'system', content: '保持顺序' }, { role: 'user', content: '任务' }]);
  assert.deepEqual(requestBody.tools, []);
  assert.equal(requestBody.reasoning_effort, 'low');
  assert.equal(requestBody.model, 'qwen3-7-max');
});

test('Qianwen gateway preserves DSH tool history as native ordered messages', async () => {
  const home = temporaryHome();
  let requestBody;
  const service = new RogatorService({
    home,
    fetch: async (_url, options) => {
      requestBody = JSON.parse(options.body);
      return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), { status: 200 });
    }
  });
  service.process = { exitCode: null };
  service.port = 18932;
  const context = {
    messages: [
      { role: 'developer', content: 'Harness owns the tool loop.' },
      { role: 'user', content: 'Inspect files.' },
      { role: 'assistant', content: '', tool_calls: [{ id: 'call_glob', type: 'function', function: { name: 'glob', arguments: '{"pattern":"*"}' } }] },
      { role: 'tool', tool_call_id: 'call_glob', content: 'a.js\nb.js' }
    ],
    instructions: '',
    run: {
      id: 'run-dsh-gateway',
      prompt_passthrough: true,
      provider_tools: [{ name: 'glob', parameters: { type: 'object', required: ['pattern'], properties: { pattern: { type: 'string' } } } }]
    }
  };
  const normalized = dshGatewayMessages(context);
  assert.equal(normalized.length, 4);
  assert.equal(normalized[0].role, 'system');
  assert.equal(normalized[0].content, 'Harness owns the tool loop.');
  assert.equal(normalized[1].role, 'user');
  assert.equal(normalized[2].role, 'assistant');
  assert.equal(normalized[3].role, 'tool');
  assert.equal(normalized[3].tool_call_id, 'call_glob');
  await service.complete(context);
  assert.equal(requestBody.messages.length, 4);
  assert.equal(requestBody.messages[0].role, 'system');
  assert.deepEqual(requestBody.messages, normalized);
  assert.equal(requestBody.messages.some((message) => message.role === 'tool'), true);
  assert.equal(requestBody.tools.length, 1);
  assert.equal(requestBody.tools[0].function.name, 'list_directory');
  assert.equal(requestBody.stream, false);
});

test('Qianwen DSH preserves selected reasoning effort across tool-result continuations', async () => {
  const efforts = [];
  const service = new RogatorService({
    home: temporaryHome(),
    fetch: async (_url, options) => {
      efforts.push(JSON.parse(options.body).reasoning_effort);
      return new Response(JSON.stringify({ choices: [{ message: { content: 'done' } }] }));
    }
  });
  service.process = { exitCode: null };
  service.port = 18932;
  const providerTools = [{ name: 'read', parameters: { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'] } }];
  await service.complete({
    messages: [{ role: 'developer', content: 'Harness prompt' }, { role: 'user', content: 'Task' }],
    run: { id: 'initial-max', prompt_passthrough: true, reasoning_effort: 'max', provider_tools: providerTools }
  });
  await service.complete({
    messages: [{ role: 'user', content: 'Task' }, { role: 'assistant', content: '', tool_calls: [] }, { role: 'tool', content: 'result' }],
    run: { id: 'continuation', prompt_passthrough: true, reasoning_effort: 'max', provider_tools: providerTools }
  });
  assert.deepEqual(efforts, ['max', 'max']);
});

test('Qianwen gateway uses Rogator function transport but returns DSH fences for Harness execution', async () => {
  let requestBody;
  const service = new RogatorService({
    home: temporaryHome(),
    fetch: async (_url, options) => {
      requestBody = JSON.parse(options.body);
      return new Response(JSON.stringify({ choices: [{ message: { content: '', tool_calls: [
        { id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"src/stats.js"}' } }
      ] } }] }));
    }
  });
  service.process = { exitCode: null };
  service.port = 18932;
  const result = await service.complete({
    messages: [{ role: 'user', content: 'Read the file.' }],
    run: {
      id: 'run-tool-stream',
      prompt_passthrough: true,
      provider_tools: [{ name: 'read_file', description: 'Read file', parameters: { type: 'object', required: ['path'], properties: { path: { type: 'string' } } } }]
    }
  });
  assert.equal(requestBody.tools.length, 1);
  assert.equal(requestBody.tools[0].function.name, 'read_file');
  assert.equal(requestBody.stream, false);
  assert.match(result.content, /```dsh-tool-call/);
  assert.match(result.content, /"name":"read_file"/);
  assert.match(result.content, /"path":"src\/stats\.js"/);
});

test('Qianwen reasoning-only tool turn automatically continues into an action turn', async () => {
  const efforts = [];
  const service = new RogatorService({
    home: temporaryHome(),
    fetch: async (_url, options) => {
      const body = JSON.parse(options.body);
      efforts.push(body.reasoning_effort);
      if (efforts.length === 1) return new Response(JSON.stringify({ choices: [{ message: { content: '', reasoning_content: '规划完成' } }] }));
      return new Response(JSON.stringify({ choices: [{ message: { content: '', tool_calls: [
        { id: 'call_1', type: 'function', function: { name: 'read', arguments: '{"file_path":"README.md"}' } }
      ] } }] }));
    }
  });
  service.process = { exitCode: null };
  service.port = 18932;
  const statuses = [];
  const result = await service.complete({
    messages: [{ role: 'user', content: 'Inspect.' }],
    run: { id: 'run-reasoning-action', prompt_passthrough: true, reasoning_effort: 'max', provider_tools: [
      { name: 'read', parameters: { type: 'object', required: ['file_path'], properties: { file_path: { type: 'string' } } } }
    ] },
    onStatus: (value) => statuses.push(value)
  });
  assert.deepEqual(efforts, ['max', 'none']);
  assert.match(statuses.at(-1), /工具动作/);
  assert.match(result.content, /"name":"read"/);
});

test('Qianwen native DSH calls are deduplicated and structured arguments are repaired', () => {
  const calls = new Map([
    [0, { id: 'one', name: 'todo_write', arguments: '{"todos":"[{\\"content\\":\\"read\\"}]"}' }],
    [1, { id: 'two', name: 'todo_write', arguments: '{"todos":"[{\\"content\\":\\"read\\"}]"}' }]
  ]);
  const tools = [{
    name: 'todo_write',
    parameters: { type: 'object', properties: { todos: { type: 'array', items: { type: 'object' } } }, required: ['todos'] }
  }];
  const value = toolCallFences(calls, tools);
  assert.equal((value.match(/```dsh-tool-call/g) || []).length, 1);
  assert.match(value, /"todos":\[\{"content":"read"\}\]/);
});

test('Qianwen transport padding is trimmed from scalar tool arguments but not file content', () => {
  const calls = new Map([[0, {
    name: 'glob', arguments: JSON.stringify({ pattern: '\n**/*.js\n', path: '\n.\n' })
  }], [1, {
    name: 'write', arguments: JSON.stringify({ file_path: '\nnotes.txt\n', content: '\nkeep payload whitespace\n' })
  }]]);
  const tools = [
    { name: 'glob', parameters: { type: 'object', properties: { pattern: { type: 'string' }, path: { type: 'string' } }, required: ['pattern'] } },
    { name: 'write', parameters: { type: 'object', properties: { file_path: { type: 'string' }, content: { type: 'string' } }, required: ['file_path', 'content'] } }
  ];
  const fences = toolCallFences(calls, tools);
  assert.match(fences, /"pattern":"\*\*\/\*\.js","path":"\."/);
  assert.match(fences, /"file_path":"notes.txt","content":"\\nkeep payload whitespace\\n"/);
});

test('Qianwen familiar provider tool calls compile into local DSH tools', () => {
  const calls = new Map([
    [0, { id: 'cloud', name: 'code_interpreter', arguments: '{"code":"print(1)"}' }],
    [1, { id: 'local', name: 'pwsh', arguments: '{"command":"node validate.js"}' }]
  ]);
  const tools = [{ name: 'pwsh', parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } }];
  const value = toolCallFences(calls, tools);
  assert.doesNotMatch(value, /code_interpreter/);
  assert.equal((value.match(/"name":"pwsh"/g) || []).length, 2);
  assert.match(value, /FromBase64String/);
  assert.match(value, /Run local python code/);
});

test('Qianwen gateway rejects broad process-name cleanup commands', () => {
  const calls = new Map([[0, {
    name: 'pwsh',
    arguments: JSON.stringify({ command: 'Get-Process node -ErrorAction SilentlyContinue | Stop-Process -Force' })
  }]]);
  const tools = [{ name: 'pwsh', parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } }];
  assert.equal(toolCallFences(calls, tools), '');
  calls.set(0, { name: 'pwsh', arguments: JSON.stringify({ command: '$server = Start-Process node -ArgumentList "server.js" -PassThru; Stop-Process -Id $server.Id' }) });
  assert.match(toolCallFences(calls, tools), /Stop-Process -Id/);
});

test('Qianwen DSH transport accepts code_interpreter as a local compatibility alias without a repair prompt', async () => {
  const requests = [];
  const progress = [];
  const service = new RogatorService({
    home: temporaryHome(),
    fetch: async (_url, options) => {
      const body = JSON.parse(options.body);
      requests.push(body);
      return new Response(JSON.stringify({ choices: [{ message: {
        content: '```dsh-tool-call\n{"name":"code_interpreter","arguments":{"code":"print(1)"}}\n```'
      } }] }));
    }
  });
  service.process = { exitCode: null };
  service.port = 18932;
  const result = await service.complete({
    messages: [{ role: 'user', content: 'Validate the project.' }],
    run: { id: 'repair-native-tool', prompt_passthrough: true, provider_tools: [
      { name: 'pwsh', parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } }
    ] },
    onProgress: (value) => progress.push(value)
  });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].tools.some((tool) => tool.function.name === 'run_in_terminal'), true);
  assert.equal(requests[0].tools.some((tool) => tool.function.name === 'pwsh'), false);
  assert.equal(requests[0].tools.some((tool) => tool.function.name === 'code_interpreter'), false);
  assert.doesNotMatch(result.content, /code_interpreter/);
  assert.match(result.content, /"name":"pwsh"/);
  assert.deepEqual(progress, [result.content]);
});

test('Qianwen DSH transport fails closed when an unknown tool syntax survives repair', async () => {
  const service = new RogatorService({
    home: temporaryHome(),
    fetch: async () => new Response(JSON.stringify({ choices: [{ message: {
      content: 'dsh-tool-call\n{"name":"cloud_desktop","arguments":{"code":"print(1)"}}'
    } }] }))
  });
  service.process = { exitCode: null };
  service.port = 18932;
  await assert.rejects(service.complete({
    messages: [{ role: 'user', content: 'Validate.' }],
    run: { id: 'reject-native-tool', prompt_passthrough: true, provider_tools: [
      { name: 'pwsh', parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } }
    ] }
  }), (error) => error.code === 'qwen_gateway_unavailable_tool');
});

test('Qianwen compatibility catalog exposes familiar aliases only when canonical DSH targets exist', () => {
  const tools = [
    { name: 'pwsh', parameters: { type: 'object', additionalProperties: false, properties: { command: { type: 'string' }, description: { type: 'string' }, workdir: { type: 'string' }, timeoutMs: { type: 'number' }, run_in_background: { type: 'boolean' } }, required: ['command', 'description'] } },
    { name: 'read', parameters: { type: 'object', properties: { file_path: { type: 'string' }, offset: { type: 'number' } }, required: ['file_path'] } },
    { name: 'write', parameters: { type: 'object', properties: { file_path: { type: 'string' }, content: { type: 'string' } }, required: ['file_path', 'content'] } },
    { name: 'grep', parameters: { type: 'object', properties: { pattern: { type: 'string' }, path: { type: 'string' } }, required: ['pattern'] } },
    { name: 'glob', parameters: { type: 'object', properties: { pattern: { type: 'string' }, path: { type: 'string' } }, required: ['pattern'] } }
  ];
  const names = providerToolCompatibility(tools).upstream.map((tool) => tool.function.name);
  assert.deepEqual(names, ['run_in_terminal', 'read_file', 'write_file', 'search_files', 'list_directory']);
  assert.deepEqual(compileProviderToolCall('run_in_terminal', {
    command: 'npm test', is_background: 'false', timeout_ms: 12000, workdir: 'app'
  }, tools), {
    name: 'pwsh', arguments: { command: 'npm test', description: 'Run local workspace command', workdir: 'app', timeoutMs: 12000 }
  });
  assert.deepEqual(compileProviderToolCall('read_file', { path: 'src/index.ts', offset: 4 }, tools), {
    name: 'read', arguments: { file_path: 'src/index.ts', offset: 4 }
  });
  assert.equal(compileProviderToolCall('unknown_cloud_tool', {}, tools), null);
});

test('Qianwen DSH history compacts only settled large mutation payloads', () => {
  const largeContent = 'const value = 1;\n'.repeat(600);
  const messages = [
    { role: 'user', content: 'Create the application.' },
    { role: 'assistant', content: '', tool_calls: [{
      id: 'call_settled', type: 'function',
      function: { name: 'write', arguments: JSON.stringify({ file_path: 'src/app.js', content: largeContent }) }
    }, {
      id: 'call_pending', type: 'function',
      function: { name: 'write_file', arguments: JSON.stringify({ path: 'src/pending.js', content: largeContent }) }
    }] },
    { role: 'tool', tool_call_id: 'call_settled', content: 'Wrote src/app.js successfully.' },
    { role: 'assistant', content: '', tool_calls: [{
      id: 'call_read', type: 'function',
      function: { name: 'read', arguments: JSON.stringify({ file_path: 'src/app.js' }) }
    }] },
    { role: 'tool', tool_call_id: 'call_read', content: largeContent }
  ];

  const compacted = compactExecutedMutationArguments(messages);
  const settledArgs = JSON.parse(compacted[1].tool_calls[0].function.arguments);
  const pendingArgs = JSON.parse(compacted[1].tool_calls[1].function.arguments);
  assert.equal(settledArgs.file_path, 'src/app.js');
  assert.match(settledArgs.content, /omitted after successful local execution/);
  assert.equal(pendingArgs.content, largeContent);
  assert.equal(compacted[2].tool_call_id, 'call_settled');
  assert.equal(compacted[4].content, largeContent);
  assert.deepEqual(messages[1].tool_calls[0].function.arguments, JSON.stringify({ file_path: 'src/app.js', content: largeContent }));
});

test('Qianwen DSH history never compacts loaded Skill policy', () => {
  const skill = '<skill_content name="cordis">' + 'policy rule\n'.repeat(1200) + '</skill_content>';
  const compacted = compactExecutedMutationArguments([
    { role: 'assistant', content: '', tool_calls: [{ id: 'skill_call', type: 'function', function: { name: 'skill', arguments: '{"name":"cordis"}' } }] },
    { role: 'tool', tool_call_id: 'skill_call', content: skill }
  ]);
  assert.equal(compacted[1].content, skill);
});

test('Qianwen malformed repeated DSH markers are canonicalized and deduplicated', () => {
  const tools = [
    { name: 'read', parameters: { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'] } },
    { name: 'glob', parameters: { type: 'object', properties: { pattern: { type: 'string' } }, required: ['pattern'] } }
  ];
  const malformed = '```dsh-tool-call\n{"name":"read","arguments":{"file_path":"README.md"}}\ndsh-tool-call\n{"name":"glob","arguments":{"pattern":"**/*.js"}}\ndsh-tool-call\n{"name":"glob","arguments":{"pattern":"**/*.js"}}\n```Tool read does not exists.';
  const normalized = dshTextToolFences(malformed, tools);
  assert.equal((normalized.match(/```dsh-tool-call/g) || []).length, 2);
  assert.match(normalized, /"name":"read"/);
  assert.match(normalized, /"name":"glob"/);
  assert.doesNotMatch(normalized, /does not exists/);
});

test('Qianwen stringified structured arguments are decoded only when the DSH schema requires them', () => {
  const tools = [{
    name: 'todo_write',
    parameters: {
      type: 'object',
      properties: { todos: { type: 'array', items: { type: 'object' } }, note: { type: 'string' } },
      required: ['todos']
    }
  }];
  const value = dshTextToolFences('```dsh-tool-call\n{"name":"todo_write","arguments":{"todos":"[{\\"content\\":\\"read\\"}]","note":"[keep as text]"}}\n```', tools);
  assert.match(value, /"todos":\[\{"content":"read"\}\]/);
  assert.match(value, /"note":"\[keep as text\]"/);
});

test('Qianwen Cordis conceptual wrappers are restored to the flat DSH oneOf schema', () => {
  const tools = [{
    name: 'cordis_define',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['plugin', 'name', 'purpose', 'code'],
      properties: {
        plugin: {
          oneOf: [{
            type: 'object', additionalProperties: false, required: ['kind', 'idPrefix'],
            properties: { kind: { type: 'string', const: 'new' }, idPrefix: { type: 'string' } }
          }, {
            type: 'object', additionalProperties: false, required: ['kind', 'pluginId'],
            properties: { kind: { type: 'string', const: 'existing' }, pluginId: { type: 'string' } }
          }]
        },
        name: { type: 'string' }, purpose: { type: 'string' },
        code: { type: 'object', properties: { client: { type: 'string' }, host: { type: 'string' } } }
      }
    }
  }];
  const calls = new Map([[0, {
    name: 'cordis_define',
    arguments: JSON.stringify({
      plugin: JSON.stringify({ kind: 'new', name: 'background-character', purpose: 'Draw a character.' }),
      package: JSON.stringify({ description: 'Background package.', code: { client: 'return { apply(ctx) {} }' } })
    })
  }]]);
  const value = toolCallFences(calls, tools);
  const payload = JSON.parse(value.match(/```dsh-tool-call\n(.+)\n```/)[1]);
  assert.deepEqual(payload.arguments, {
    plugin: { kind: 'new', idPrefix: 'backgr' },
    name: 'background-character',
    purpose: 'Draw a character.',
    code: { client: 'return { apply(ctx) {} }' }
  });

  const flatCalls = new Map([[0, {
    name: 'cordis_define',
    arguments: JSON.stringify({
      idPrefix: 'bounce',
      purpose: 'Draw a bouncing figure.',
      code: "return { platform: 'client', apply(ctx) { document.body; ctx.slots.register() } }"
    })
  }]]);
  const flatValue = toolCallFences(flatCalls, tools);
  const flatPayload = JSON.parse(flatValue.match(/```dsh-tool-call\n(.+)\n```/)[1]);
  assert.deepEqual(flatPayload.arguments, {
    plugin: { kind: 'new', idPrefix: 'bounce' },
    name: 'bounce-plugin',
    purpose: 'Draw a bouncing figure.',
    code: { client: "return { platform: 'client', apply(ctx) { document.body; ctx.slots.register() } }" }
  });

  const longPrefixCalls = new Map([[0, {
    name: 'cordis_define',
    arguments: JSON.stringify({
      plugin: { kind: 'new', idPrefix: 'Bouncer-Long' },
      name: 'Bouncing Figure', purpose: 'Draw it.', code: { client: 'return {}' }
    })
  }]]);
  const longPrefixValue = toolCallFences(longPrefixCalls, tools);
  const longPrefixPayload = JSON.parse(longPrefixValue.match(/```dsh-tool-call\n(.+)\n```/)[1]);
  assert.equal(longPrefixPayload.arguments.plugin.idPrefix, 'bounce');

  const clientProjectionCalls = new Map([[0, {
    name: 'cordis_define',
    arguments: JSON.stringify({
      plugin: { kind: 'new', idPrefix: 'figure' },
      name: 'figure-plugin',
      client: "return { inject: ['slots'], apply(ctx) {} }"
    })
  }]]);
  const clientProjectionValue = toolCallFences(clientProjectionCalls, tools);
  const clientProjectionPayload = JSON.parse(clientProjectionValue.match(/```dsh-tool-call\n(.+)\n```/)[1]);
  assert.deepEqual(clientProjectionPayload.arguments, {
    plugin: { kind: 'new', idPrefix: 'figure' },
    name: 'figure-plugin',
    purpose: 'Dynamic Cordis package figure-plugin.',
    code: { client: "return { inject: ['slots'], apply(ctx) {} }" }
  });

  const existingAliasCalls = new Map([[0, {
    name: 'cordis_define',
    arguments: JSON.stringify({
      plugin: { kind: 'existing', id: 'figure-1' },
      name: 'figure-fix', purpose: 'Repair it.', code: { client: 'return {}' }
    })
  }]]);
  const existingAliasValue = toolCallFences(existingAliasCalls, tools);
  const existingAliasPayload = JSON.parse(existingAliasValue.match(/```dsh-tool-call\n(.+)\n```/)[1]);
  assert.deepEqual(existingAliasPayload.arguments.plugin, { kind: 'existing', pluginId: 'figure-1' });
});

test('Qianwen Cordis inspect input JSON string is restored to an object', () => {
  const tools = [{
    name: 'cordis_inspect_query',
    parameters: {
      type: 'object',
      properties: {
        platform: { type: 'string' }, provider: { type: 'string' }, method: { type: 'string' }, input: {}
      },
      required: ['platform', 'provider', 'method', 'input']
    }
  }];
  const calls = new Map([[0, {
    name: 'cordis_inspect_query',
    arguments: JSON.stringify({ platform: 'client', provider: 'Slots', method: 'listSubTree', input: '{}' })
  }]]);
  const value = toolCallFences(calls, tools);
  const payload = JSON.parse(value.match(/```dsh-tool-call\n(.+)\n```/)[1]);
  assert.deepEqual(payload.arguments.input, {});
});

test('Qianwen DSH transport preserves native image attachments and message roles', () => {
  const messages = dshGatewayMessages({
    messages: [
      { role: 'developer', content: 'Harness prompt' },
      { role: 'user', content: [{ type: 'text', text: 'Inspect' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }] }
    ],
    run: { prompt_passthrough: true, provider_tools: [] }
  });
  assert.equal(messages[0].role, 'system');
  assert.equal(Array.isArray(messages[1].content), true);
  assert.equal(messages[1].content[0].type, 'text');
  assert.equal(messages[1].content[1].image_url.url, 'data:image/png;base64,AAAA');
});

test('Qianwen DSH transport preserves the original goal and recent ordered tool evidence within its webpage budget', () => {
  const messages = [{ role: 'developer', content: 'Harness prompt' }, { role: 'user', content: 'Build the requested plugin.' }];
  for (let index = 0; index < 8; index += 1) {
    messages.push({ role: 'assistant', content: '', tool_calls: [{ id: 'call_' + index, function: { name: 'inspect', arguments: '{}' } }] });
    messages.push({ role: 'tool', tool_call_id: 'call_' + index, content: 'result-' + index + '-' + 'x'.repeat(12000) });
  }
  const value = dshGatewayMessages({ messages, run: { prompt_passthrough: true } });
  const serialized = JSON.stringify(value);
  assert.match(serialized, /Build the requested plugin/);
  assert.match(serialized, /result-7/);
  assert.doesNotMatch(serialized, /result-0/);
  assert.ok(serialized.length < 22000);
});

test('Qianwen DSH transport keeps loaded Skill instructions without a second truncation layer', () => {
  const skill = '<skill_content name="cordis-plugin-development">' + 'A'.repeat(7000)
    + "Use ctx.get('slots') or declare inject: ['slots']."
    + 'B'.repeat(7000) + '</skill_content>';
  const messages = [
    { role: 'user', content: 'Build the requested plugin.' },
    { role: 'assistant', content: '', tool_calls: [{ id: 'skill_call', function: { name: 'skill', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'skill_call', content: skill }
  ];
  for (let index = 0; index < 6; index += 1) {
    messages.push({ role: 'assistant', content: '', tool_calls: [{ id: 'call_' + index, function: { name: 'inspect', arguments: '{}' } }] });
    messages.push({ role: 'tool', tool_call_id: 'call_' + index, content: 'result-' + index + '-' + 'x'.repeat(7000) });
  }
  const value = dshGatewayMessages({ messages, run: { prompt_passthrough: true } });
  const serialized = JSON.stringify(value);
  assert.match(serialized, /Build the requested plugin/);
  assert.match(serialized, /Use ctx\.get\('slots'\) or declare inject: \['slots'\]/);
  assert.match(serialized, /cordis-plugin-development/);
});

test('normal Runtime gateway history has one ordered protocol-neutral envelope', () => {
  const messages = runtimeGatewayMessages({
    instructions: 'Keep working.\n- 工具调用使用 {"tool":"name"}\nBe concise.',
    messages: [
      { role: 'user', content: 'Read it.' },
      { role: 'assistant', content: 'call', tool_calls: [{ tool: 'read_file', content: '{"path":"a.js"}', format: 'dsh' }] },
      { role: 'tool', content: '{"success":true}' }
    ]
  }, 'No cloud tools.');
  assert.equal(messages.length, 1);
  assert.match(messages[0].content, /<webagent_messages_json>/);
  assert.match(messages[0].content, /"role":"tool"/);
  assert.doesNotMatch(messages[0].content, /工具调用使用/);
  assert.doesNotMatch(messages[0].content, /dsh-tool-call/);
});

test('Qwen residual function tags are recovered against the advertised schema', () => {
  const tools = [
    { name: 'read_file', parameters: { type: 'object', required: ['path'], properties: { path: { type: 'string' } } } },
    { name: 'exec_command', parameters: { type: 'object', required: ['command'], properties: { command: { type: 'string' }, timeout: { type: 'number' } } } },
    { name: 'apply_patch', parameters: { type: 'object', required: ['path', 'find', 'replace'], properties: { path: { type: 'string' }, find: { type: 'string' }, replace: { type: 'string' } } } }
  ];
  assert.match(residualQwenToolFence('<function=read_file><parameter=path>src/a.js</parameter></function>', tools), /"name":"read_file"/);
  const orphan = residualQwenToolFence('<parameter=command>npm test</parameter></function>', tools);
  assert.match(orphan, /"name":"exec_command"/);
  assert.match(orphan, /"command":"npm test"/);
  assert.match(residualQwenToolFence('<function=read_file><parameter=path>"\\nsrc/a.js\\n"</parameter></function>', tools), /"path":"src\/a\.js"/);
  const positional = residualQwenToolFence('src/a.js\n\nold line\n\nnew line\n\n</function>', tools);
  assert.match(positional, /"name":"apply_patch"/);
  assert.match(positional, /"find":"old line"/);
  const multiple = residualQwenToolFence('package.json\n</function>\n\nsrc/a.js\n</function>\n\nnpm test\n</function>', tools);
  assert.deepEqual((multiple.match(/```dsh-tool-call/g) || []).length, 3);
  assert.match(multiple, /"name":"read_file"/);
  assert.match(multiple, /"name":"exec_command"/);
  assert.equal(residualQwenToolFence('<parameter=unknown>x</parameter></function>', tools), '');
});

test('Qwen partial pwsh function syntax restores a command preceding named parameters', () => {
  const tools = [{
    name: 'pwsh',
    parameters: {
      type: 'object', required: ['command'],
      properties: { command: { type: 'string' }, description: { type: 'string' }, workdir: { type: 'string' } }
    }
  }];
  const raw = 'cd flight-sim; npm install three @types/three vite typescript --save-dev '
    + '<parameter=description>Install Three.js and dev dependencies</parameter>'
    + '<parameter=workdir>D:\\Work\\Works\\dshworkspace\\mctest</parameter></function>';
  const fence = residualQwenToolFence(raw, tools);
  assert.match(fence, /"name":"pwsh"/);
  assert.ok(fence.includes('"command":"cd flight-sim; npm install three @types/three vite typescript --save-dev"'));
  assert.ok(fence.includes('"workdir":"D:\\\\Work\\\\Works\\\\dshworkspace\\\\mctest"'));
  assert.doesNotMatch(fence, /<parameter=|<\/function>/);
});

test('Qwen repair fragment maps provider path back to canonical DSH read file_path', () => {
  const tools = [{
    name: 'read',
    parameters: {
      type: 'object', additionalProperties: false,
      required: ['file_path'],
      properties: { file_path: { type: 'string' }, offset: { type: 'number' }, limit: { type: 'number' } }
    }
  }, {
    name: 'glob',
    parameters: {
      type: 'object', additionalProperties: false,
      required: ['pattern'],
      properties: { pattern: { type: 'string' }, path: { type: 'string' } }
    }
  }];
  const raw = 'throttle\n\n<parameter=path>\nD:\\Work\\Works\\WebAgentQwenFlightSim\\index.html\n</parameter>\n</function>';
  const fence = residualQwenToolFence(raw, tools);
  assert.match(fence, /"name":"read"/);
  assert.match(fence, /"file_path":"D:\\\\Work\\\\Works\\\\WebAgentQwenFlightSim\\\\index\.html"/);
  assert.doesNotMatch(fence, /<parameter=|<\/function>/);
});

test('Qwen read fragment restores an unwrapped leading path before offset and limit', () => {
  const tools = [{
    name: 'read',
    parameters: {
      type: 'object', additionalProperties: false,
      required: ['file_path'],
      properties: { file_path: { type: 'string' }, offset: { type: 'number' }, limit: { type: 'number' } }
    }
  }, {
    name: 'pwsh',
    parameters: {
      type: 'object', additionalProperties: false,
      required: ['command'],
      properties: { command: { type: 'string' }, description: { type: 'string' } }
    }
  }];
  const raw = 'D:\\Work\\Works\\WebAgentQwenFlightSim\\index.html\n'
    + '<parameter=offset>\n1\n</parameter>\n'
    + '<parameter=limit>\n200\n</parameter>\n</function>';
  const fence = residualQwenToolFence(raw, tools);
  const call = JSON.parse(fence.match(/```dsh-tool-call\n(.+)\n```/)[1]);
  assert.deepEqual(call, {
    name: 'read',
    arguments: { offset: 1, limit: 200, file_path: 'D:\\Work\\Works\\WebAgentQwenFlightSim\\index.html' }
  });
});

test('Qwen long write payload restores a path whose opening parameter tag was dropped', () => {
  const tools = [{
    name: 'write',
    parameters: {
      type: 'object', required: ['file_path', 'content'],
      properties: { file_path: { type: 'string' }, content: { type: 'string' } }
    }
  }, {
    name: 'apply_patch',
    parameters: {
      type: 'object', required: ['file_path', 'patch'],
      properties: { file_path: { type: 'string' }, patch: { type: 'string' } }
    }
  }];
  const raw = 'D:\\Work\\Works\\WebAgentQwenFlightSim\\index.html\n</parameter>\n'
    + '<parameter=content>\n<!DOCTYPE html>\n<html></html>\n</parameter>\n</function>';
  const fence = residualQwenToolFence(raw, tools);
  assert.match(fence, /"name":"write"/);
  assert.match(fence, /"file_path":"D:\\\\Work\\\\Works\\\\WebAgentQwenFlightSim\\\\index\.html"/);
  assert.match(fence, /"content":"<!DOCTYPE html>/);
  assert.doesNotMatch(fence, /<parameter=|<\/function>/);
});

test('Qwen bare long write restores first-line path and preserves blank lines in content', () => {
  const tools = [{
    name: 'write',
    parameters: {
      type: 'object', required: ['file_path', 'content'],
      properties: { file_path: { type: 'string' }, content: { type: 'string' } }
    }
  }];
  const raw = "D:\\Work\\Queue\\src\\queue.js\n\n'use strict';\n\nclass Queue {\n  run() {}\n}\n\nmodule.exports = Queue;\n\n</function>";
  const fence = residualQwenToolFence(raw, tools);
  const payload = JSON.parse(fence.match(/```dsh-tool-call\n(.+)\n```/)[1]);
  assert.equal(payload.name, 'write');
  assert.equal(payload.arguments.file_path, 'D:\\Work\\Queue\\src\\queue.js');
  assert.match(payload.arguments.content, /'use strict';\n\nclass Queue/);
  assert.match(payload.arguments.content, /module\.exports = Queue;/);
});

test('Qwen malformed command parameter does not swallow its following description', () => {
  const tools = [{
    name: 'pwsh',
    parameters: {
      type: 'object', required: ['command', 'description'],
      properties: { command: { type: 'string' }, description: { type: 'string' }, workdir: { type: 'string' } }
    }
  }];
  const raw = '<parameter=command>\nGet-ChildItem -Path "D:\\Work\\Works\\dshworkspace" -Force | Select-Object Name, Mode, LastWriteTime\n'
    + '<parameter=description>\nList workspace contents\n</parameter>\n</function>';
  const fence = residualQwenToolFence(raw, tools);
  assert.match(fence, /"name":"pwsh"/);
  assert.match(fence, /"command":"Get-ChildItem -Path/);
  assert.match(fence, /"description":"List workspace contents"/);
  assert.doesNotMatch(fence, /<parameter=|<\/function>/);
});

test('Qwen parallel orphan parameter blocks recover as separate DSH calls', () => {
  const tools = [
    { name: 'read', parameters: { type: 'object', required: ['file_path'], properties: { file_path: { type: 'string' } } } },
    { name: 'write', parameters: { type: 'object', required: ['file_path', 'content'], properties: { file_path: { type: 'string' }, content: { type: 'string' } } } }
  ];
  const raw = '<parameter=file_path>\nREADME.md\n</parameter>\n</function>\n\n<parameter=file_path>\ntest/rate-limiter.test.js\n</parameter>\n</function>\n\n<parameter=file_path>\nsrc/rate-limiter.js\n</parameter>\n</function>';
  const value = residualQwenToolFence(raw, tools);
  assert.equal((value.match(/```dsh-tool-call/g) || []).length, 3);
  assert.match(value, /"name":"read"/);
  assert.match(value, /"file_path":"README\.md"/);
  assert.match(value, /"file_path":"test\/rate-limiter\.test\.js"/);
});

test('Qwen orphan glob and grep blocks are disambiguated from their parameter shapes', () => {
  const tools = [
    { name: 'glob', parameters: { type: 'object', required: ['pattern'], properties: { pattern: { type: 'string' }, path: { type: 'string' } } } },
    { name: 'grep', parameters: { type: 'object', required: ['pattern'], properties: { pattern: { type: 'string' }, path: { type: 'string' }, include: { type: 'string' } } } }
  ];
  const raw = '<parameter=pattern>**/*cordis*</parameter><parameter=path>D:\\\\Work</parameter></function>\n'
    + '<parameter=pattern>cordis|plugin</parameter><parameter=path>D:\\\\Work</parameter><parameter=include>*.md</parameter></function>';
  const value = residualQwenToolFence(raw, tools);
  assert.equal((value.match(/```dsh-tool-call/g) || []).length, 2);
  assert.match(value, /"name":"glob"/);
  assert.match(value, /"name":"grep"/);
});

test('Qwen bare Cordis skill id with closing function tags recovers as a Skill call', () => {
  const tools = [{
    name: 'skill',
    parameters: {
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name']
    }
  }, {
    name: 'read',
    parameters: {
      type: 'object',
      properties: { file_path: { type: 'string' } },
      required: ['file_path']
    }
  }];
  const fence = residualQwenToolFence('cordis-plugin-dev\n</function>\n\n</function>', tools);
  assert.match(fence, /"name":"skill"/);
  assert.match(fence, /"name":"cordis-plugin-development"/);
  assert.doesNotMatch(fence, /<\/function>/);

  const parameterized = residualQwenToolFence(
    '<parameter=name>\ncordis-plugin-development\n</parameter>\n</function>\n\n</function>',
    tools
  );
  assert.match(parameterized, /"name":"skill"/);
  assert.match(parameterized, /"name":"cordis-plugin-development"/);
});

test('Qwen abbreviated Cordis skill name is repaired at the DSH provider boundary', () => {
  const calls = new Map([[0, { name: 'skill', arguments: '{"name":"cordis-plugin-dev"}' }]]);
  const tools = [{ name: 'skill', parameters: { type: 'object', required: ['name'], properties: { name: { type: 'string' } } } }];
  assert.match(toolCallFences(calls, tools), /"name":"cordis-plugin-development"/);
});

test('Qianwen gateway exposes concrete models and maps each request to its Rogator upstream id', async () => {
  const home = temporaryHome();
  let requestBody;
  const service = new RogatorService({
    home,
    fetch: async (_url, options) => {
      requestBody = JSON.parse(options.body);
      return new Response('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n', { status: 200 });
    }
  });
  service.process = { exitCode: null };
  service.port = 18932;
  assert.deepEqual(gatewayModels().filter((model) => !model.hidden).map((model) => model.id), [
    'qwen.gateway.3.8-max', 'qwen.gateway.3.7-max', 'qwen.gateway.3.7-plus', 'qwen.gateway.3.6-plus'
  ]);
  assert.deepEqual(gatewayModels().find((model) => model.id === 'qwen.gateway.3.8-max').capabilities.reasoningEfforts, ['none', 'low', 'medium', 'high', 'xhigh', 'max', 'auto']);
  await service.complete({ model: 'qwen.gateway.3.8-max', messages: [{ role: 'user', content: 'test' }], run: { id: 'run-model' } });
  assert.equal(requestBody.model, 'qwen3-8-max');
});

test('Qianwen gateway forwards every supported reasoning effort without downgrading it', async () => {
  const received = [];
  const service = new RogatorService({
    home: temporaryHome(),
    fetch: async (_url, options) => {
      received.push(JSON.parse(options.body).reasoning_effort);
      return new Response('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n', { status: 200 });
    }
  });
  service.process = { exitCode: null };
  service.port = 18932;
  for (const effort of ['none', 'low', 'medium', 'high', 'xhigh', 'max', 'auto']) {
    await service.complete({ messages: [{ role: 'user', content: effort }], run: { id: 'run-' + effort, reasoning_effort: effort } });
  }
  assert.deepEqual(received, ['none', 'low', 'medium', 'high', 'xhigh', 'max', 'auto']);
});

test('gateway account secret is encrypted and plaintext CSV is temporary', async () => {
  const home = temporaryHome();
  const source = path.join(home, 'source');
  fs.mkdirSync(source, { recursive: true });
  const service = new RogatorService({
    home, source,
    encrypt: (value) => Buffer.from(value, 'utf8').toString('base64'),
    decrypt: (value) => Buffer.from(value, 'base64').toString('utf8')
  });
  await service.setAccount({ username: 'qwen@example.com', password: 'not-plain-on-disk', model: 'qwen3-7-max' });
  const encrypted = fs.readFileSync(service.credentialFile, 'utf8');
  assert.doesNotMatch(encrypted, /not-plain-on-disk/);
  service._materializeAccount();
  assert.match(fs.readFileSync(service.accountCsv, 'utf8'), /qwen@example\.com/);
  assert.match(fs.readFileSync(service.accountCsv, 'utf8'), /not-plain-on-disk/);
  service._removeMaterializedAuth();
  assert.equal(fs.existsSync(service.accountCsv), false);
});

test('existing Qwen Web login can be materialized as an ephemeral Rogator session', async () => {
  const home = temporaryHome();
  const source = path.join(home, 'source');
  fs.mkdirSync(source, { recursive: true });
  const exp = Math.floor(Date.now() / 1000) + 3600;
  const segment = Buffer.from(JSON.stringify({ exp, sub: 'user-42' })).toString('base64url');
  const token = 'header.' + segment + '.signature';
  const service = new RogatorService({ home, source, getBrowserCredentials: async () => ({ token, user_id: 'user-42', cookies: {} }) });
  await service._materializeAuth();
  const store = JSON.parse(fs.readFileSync(service.sessionFile, 'utf8'));
  assert.equal(store.sessions[0].token, '');
  assert.equal(store.sessions[0].user_id, 'user-42');
  assert.equal(JSON.parse(fs.readFileSync(service.browserCookieFile, 'utf8')).token, token);
  assert.equal(service.status().auth_source, 'qwen_web_cookie');
  service._removeMaterializedAuth();
  assert.equal(fs.existsSync(service.sessionFile), false);
});

test('www.qianwen.com SSO cookies are not mistaken for chat.qwen.ai gateway auth', async () => {
  const home = temporaryHome();
  const source = path.join(home, 'source');
  fs.mkdirSync(source, { recursive: true });
  const service = new RogatorService({ home, source, getBrowserCredentials: async () => ({ token: '', user_id: 'opaque-user', cookies: { tongyi_sso_ticket: 'ticket-value', tongyi_sso_ticket_hash: 'ticket-hash' } }) });
  await assert.rejects(service._materializeAuth(), (error) => error.code === 'qwen_gateway_browser_login_required' && error.status === 401);
  assert.equal(fs.existsSync(service.sessionFile), false);
  assert.equal(fs.existsSync(service.browserCookieFile), false);
});

test('SSE-wrapped Rogator upstream errors are surfaced instead of reported as empty replies', async () => {
  const home = temporaryHome();
  const service = new RogatorService({
    home,
    fetch: async () => new Response(
      'data: {"error":{"message":"Token expired: Unauthorized","type":"rate_limited","code":429}}\n\ndata: [DONE]\n\n',
      { status: 200, headers: { 'Content-Type': 'text/event-stream' } }
    )
  });
  service.process = { exitCode: null };
  service.port = 18932;
  await assert.rejects(service.complete({ messages: [{ role: 'user', content: 'test' }], run: { id: 'run-error' } }), (error) => {
    assert.equal(error.code, 'qwen_gateway_browser_login_required');
    assert.equal(error.status, 401);
    assert.match(error.message, /Unauthorized/);
    return true;
  });
});

test('Qwen Baxia rejection opens a local cooldown circuit', async () => {
  let requests = 0;
  const service = new RogatorService({
    home: temporaryHome(),
    fetch: async () => {
      requests += 1;
      return new Response(JSON.stringify({ error: {
        message: 'Baxia SM blocked: FAIL_SYS_USER_VALIDATE RGV587_ERROR::SM::busy',
        code: 503
      } }), { status: 503 });
    }
  });
  service.process = { exitCode: null };
  service.port = 18932;
  const context = { messages: [{ role: 'user', content: 'test' }], run: { id: 'run-baxia' } };
  await assert.rejects(service.complete(context), (error) => error.code === 'qwen_gateway_rate_limited' && error.status === 429);
  assert.equal(requests, 1);
  assert.ok(service.status().backoff_seconds > 0);
  assert.match(service.status().backoff_until, /^\d{4}-/);
});

test('SSE-wrapped Baxia rejection enters the same local cooldown circuit', async () => {
  let requests = 0;
  const service = new RogatorService({
    home: temporaryHome(),
    fetch: async () => {
      requests += 1;
      return new Response(
        'data: {"error":{"message":"Baxia SM blocked: FAIL_SYS_USER_VALIDATE RGV587_ERROR::SM::busy","code":503}}\n\ndata: [DONE]\n\n',
        { status: 200, headers: { 'Content-Type': 'text/event-stream' } }
      );
    }
  });
  service.process = { exitCode: null };
  service.port = 18932;
  const context = { messages: [{ role: 'user', content: 'test' }], run: { id: 'run-baxia-sse' } };
  await assert.rejects(service.complete(context), (error) => error.code === 'qwen_gateway_rate_limited' && error.status === 429);
  assert.equal(requests, 1);
});

test('Qwen Baxia rejection is retried automatically after exponential cooldown', async () => {
  let requests = 0;
  const statuses = [];
  const service = new RogatorService({
    home: temporaryHome(),
    minimumIntervalMs: 0,
    automaticRetries: 1,
    backoffBaseMs: 10,
    fetch: async () => {
      requests += 1;
      if (requests === 1) {
        return new Response(JSON.stringify({ error: {
          message: 'Baxia SM blocked: FAIL_SYS_USER_VALIDATE RGV587_ERROR::SM::busy',
          code: 503
        } }), { status: 503 });
      }
      return new Response('data: {"choices":[{"delta":{"content":"recovered"}}]}\n\ndata: [DONE]\n\n', {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' }
      });
    }
  });
  service.process = { exitCode: null };
  service.port = 18932;
  const result = await service.complete({
    messages: [{ role: 'user', content: 'test' }],
    run: { id: 'run-baxia-auto-retry' },
    onStatus: (value) => statuses.push(value)
  });
  assert.equal(requests, 2);
  assert.equal(result.content, 'recovered');
  assert.equal(service.status().backoff_seconds, 0);
  assert.equal(statuses.some((value) => /自动重试/.test(value)), true);
});

test('Qwen request lane serializes concurrent Runs and paces short gateway calls', async () => {
  const starts = [];
  let activeFetches = 0;
  let maximumActiveFetches = 0;
  const service = new RogatorService({
    home: temporaryHome(),
    minimumIntervalMs: 30,
    automaticRetries: 0,
    fetch: async () => {
      starts.push(Date.now());
      activeFetches += 1;
      maximumActiveFetches = Math.max(maximumActiveFetches, activeFetches);
      activeFetches -= 1;
      const body = new ReadableStream({
        start(controller) {
          setTimeout(() => {
            controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n'));
            controller.close();
          }, 20);
        }
      });
      return new Response(body, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' }
      });
    }
  });
  service.process = { exitCode: null };
  service.port = 18932;
  await Promise.all([
    service.complete({ messages: [{ role: 'user', content: 'one' }], run: { id: 'run-paced-one' } }),
    service.complete({ messages: [{ role: 'user', content: 'two' }], run: { id: 'run-paced-two' } })
  ]);
  assert.equal(starts.length, 2);
  assert.equal(maximumActiveFetches, 1);
  assert.ok(starts[1] - starts[0] >= 48, 'gateway calls were only ' + (starts[1] - starts[0]) + 'ms apart');
  assert.equal(service.status().queued_requests, 0);
});

test('cancelling a Run also cancels a queued Baxia retry', async () => {
  let requests = 0;
  const service = new RogatorService({
    home: temporaryHome(),
    minimumIntervalMs: 0,
    automaticRetries: 2,
    backoffBaseMs: 1000,
    fetch: async () => {
      requests += 1;
      return new Response(JSON.stringify({ error: {
        message: 'Baxia SM blocked: FAIL_SYS_USER_VALIDATE RGV587_ERROR::SM::busy',
        code: 503
      } }), { status: 503 });
    }
  });
  service.process = { exitCode: null };
  service.port = 18932;
  const controller = new AbortController();
  const completion = service.complete({
    messages: [{ role: 'user', content: 'test' }],
    run: { id: 'run-cancel-backoff' },
    signal: controller.signal
  });
  setTimeout(() => controller.abort(), 20);
  await assert.rejects(completion, (error) => error.code === 'run_cancelled' && error.name === 'AbortError');
  assert.equal(requests, 1);
  assert.equal(service.status().queued_requests, 0);
});

test('Rogator wrapper converts Qwen function roles without triggering the upstream retry', () => {
  const modulePath = path.resolve(__dirname, '../../integrations/rogator-qwen/stream_compat.py');
  const script = [
    'import importlib.util, json, sys',
    'spec=importlib.util.spec_from_file_location("stream_compat", sys.argv[1])',
    'mod=importlib.util.module_from_spec(spec); spec.loader.exec_module(mod)',
    'fallback=lambda raw: {"type":"fallback","raw":raw}',
    'parse=mod.make_webagent_parser(fallback)',
    'event={"choices":[{"delta":{"role":"function","tool_calls":[{"function":{"name":"glob","arguments":"{\\"pattern\\":\\"*\\"}"}}]}}]}',
    'assistant_call={"choices":[{"delta":{"role":"assistant","function_call":{"name":"glob","arguments":"{\\"pattern\\":\\"*\\"}"}}}]}',
    'partial_call={"choices":[{"delta":{"role":"assistant","function_call":{"name":"glob","arguments":"{\\"pattern\\":"}}}]}',
    'boundary={"choices":[{"delta":{"role":"function","status":"finished"}}]}',
    'print(json.dumps([parse(json.dumps(event)), parse(json.dumps(assistant_call)), parse(json.dumps(partial_call)), parse(json.dumps(boundary))], ensure_ascii=False))'
  ].join(';');
  const result = spawnSync('python', ['-c', script, modulePath], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout.trim());
  assert.match(parsed[0].content, /dsh-tool-call/);
  assert.match(parsed[0].content, /"name":"glob"/);
  assert.match(parsed[1].content, /dsh-tool-call/);
  assert.equal(parsed[2].type, 'fallback');
  assert.equal(parsed[3].type, 'fallback');
  assert.doesNotMatch(parsed[3].raw, /"role"/);
});
