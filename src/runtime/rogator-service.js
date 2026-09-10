'use strict';

const fs = require('fs');
const path = require('path');
const net = require('net');
const { spawn } = require('child_process');
const { compactValue, orderedMessages } = require('./dsh-web-codec');

const ROGATOR_REPOSITORY = 'https://github.com/nichengfuben/rogator.git';
const ROGATOR_REVISION = 'fccf6c237a2877a0ea2f67084181699cb20f7eb0';
const DEFAULT_UPSTREAM_MODEL = 'qwen3-7-max';
const QWEN_GATEWAY_REASONING_EFFORTS = Object.freeze(['none', 'low', 'medium', 'high', 'xhigh', 'max', 'auto']);
const ROGATOR_MODELS = [
  { id: 'qwen.gateway', upstream: '', displayName: 'Qianwen 网关（兼容）', hidden: true },
  { id: 'qwen.gateway.3.8-max', upstream: 'qwen3-8-max', displayName: 'Qwen3.8 Max' },
  { id: 'qwen.gateway.3.7-max', upstream: 'qwen3-7-max', displayName: 'Qwen3.7 Max' },
  { id: 'qwen.gateway.3.7-plus', upstream: 'qwen3-7-plus', displayName: 'Qwen3.7 Plus' },
  { id: 'qwen.gateway.3.6-plus', upstream: 'qwen3-6-plus', displayName: 'Qwen3.6 Plus' }
];

function gatewayModels() {
  return ROGATOR_MODELS.map((entry) => ({
    id: entry.id,
    provider: 'rogator',
    providerDisplayName: 'Qianwen 网关',
    displayName: entry.displayName,
    upstreamModel: entry.upstream,
    description: entry.hidden ? '原 qwen.gateway 兼容别名' : '通过 Rogator 的 Qwen-only 本地网关访问 ' + entry.displayName,
    hidden: !!entry.hidden,
    capabilities: {
      inputMaxLen: 256000,
      deepThink: true,
      reasoningEfforts: QWEN_GATEWAY_REASONING_EFFORTS.slice(),
      multimodal: { input: ['text', 'image'], output: ['text'] }
    }
  }));
}

function upstreamModel(modelId, fallback) {
  const entry = ROGATOR_MODELS.find((item) => item.id === String(modelId || ''));
  return entry && entry.upstream || fallback || DEFAULT_UPSTREAM_MODEL;
}

function gatewayError(message, code, status) {
  return Object.assign(new Error(message), { code: code || 'qwen_gateway_error', status: status || 503 });
}

function compactDshOrderedHistory(source, maxChars = 14000) {
  // Preserve DSH's native OpenAI message objects, including system/developer
  // roles, image URLs and exact tool-call ids. `orderedMessages()` is the
  // textual webpage codec and intentionally strips those fields, so it must
  // not be used for this provider-native transport.
  const ordered = (Array.isArray(source) ? source : [])
    .filter(Boolean)
    .map((message) => JSON.parse(JSON.stringify(message)));
  const compactMessage = (message) => {
    const content = typeof message.content === 'string' ? message.content : '';
    // A loaded Skill is executable policy, not ordinary tool evidence. Cutting
    // the Cordis Skill at the generic 3.6K result limit removed the exact Slot
    // dependency and registration rules, causing otherwise capable models to
    // repeatedly emit invalid plugins. Keep the latest applicable Skill whole
    // (current bundled skills are below this cap), then budget recent evidence
    // around it.
    const limit = message.role === 'tool' && /<skill_content\b/i.test(content)
      ? 24000
      : message.role === 'tool' ? 9000 : message.role === 'assistant' ? 2800 : 6000;
    return { ...message, content: typeof message.content === 'string' ? compactValue(message.content, limit) : message.content };
  };
  const goalIndex = ordered.findIndex((message) => message.role === 'user'
    && !String(typeof message.content === 'string' ? message.content : '').trimStart().startsWith('Current runtime context.'));
  const systemIndex = ordered.findIndex((message) => message.role === 'system');
  const latestSkillIndex = ordered.reduce((found, message, index) => message.role === 'tool'
    && /<skill_content\b/i.test(String(message.content || '')) ? index : found, -1);
  if (latestSkillIndex >= 0) maxChars = Math.max(maxChars, 32000);
  const protectedIndexes = new Set([systemIndex, goalIndex, latestSkillIndex].filter((index) => index >= 0));
  const chosen = [];
  let used = 0;
  for (const index of protectedIndexes) {
    const item = compactMessage(ordered[index]);
    chosen.push({ index, item });
    used += JSON.stringify(item).length;
  }
  for (let index = ordered.length - 1; index >= 0; index -= 1) {
    if (protectedIndexes.has(index)) continue;
    const item = compactMessage(ordered[index]);
    const size = JSON.stringify(item).length;
    if (used + size > maxChars) continue;
    chosen.push({ index, item });
    used += size;
  }
  return chosen.sort((a, b) => a.index - b.index).map((entry) => entry.item);
}

function compactSchemaDescriptions(value) {
  if (Array.isArray(value)) return value.map(compactSchemaDescriptions);
  if (!value || typeof value !== 'object') return value;
  const cloned = {};
  for (const [key, item] of Object.entries(value)) {
    cloned[key] = key === 'description' && typeof item === 'string'
      ? compactValue(item, 480)
      : compactSchemaDescriptions(item);
  }
  return cloned;
}

function compactExecutedMutationArguments(messages) {
  const cloned = (Array.isArray(messages) ? messages : []).map((message) => JSON.parse(JSON.stringify(message)));
  const settled = new Set();
  for (const message of cloned) {
    if (message && message.role === 'tool' && message.tool_call_id) settled.add(String(message.tool_call_id));
  }
  for (const message of cloned) {
    if (!message || message.role !== 'assistant' || !Array.isArray(message.tool_calls)) continue;
    for (const call of message.tool_calls) {
      if (!call || !settled.has(String(call.id || '')) || !call.function) continue;
      const name = String(call.function.name || '');
      if (!/^(?:write|write_file|edit|apply_patch|cordis_define)$/i.test(name)) continue;
      let args;
      try { args = typeof call.function.arguments === 'string' ? JSON.parse(call.function.arguments) : call.function.arguments; } catch (_) { continue; }
      if (!args || typeof args !== 'object' || Array.isArray(args)) continue;
      const compacted = { ...args };
      let changed = false;
      for (const key of ['content', 'code', 'old_string', 'new_string', 'patch']) {
        if (typeof compacted[key] === 'string' && compacted[key].length > 800) {
          compacted[key] = '[omitted after successful local execution; use read to inspect the current file]';
          changed = true;
        } else if (compacted[key] && typeof compacted[key] === 'object' && JSON.stringify(compacted[key]).length > 800) {
          compacted[key] = { omitted: 'successful local execution; inspect current state with the appropriate read tool' };
          changed = true;
        }
      }
      if (changed) call.function.arguments = JSON.stringify(compacted);
    }
  }
  return cloned;
}

function dshGatewayMessages(context) {
  const source = Array.isArray(context.messages) ? context.messages : [];
  // DSH owns both its system prompt and the exact ordering of its durable
  // messages.  Rogator already accepts standard OpenAI messages and performs
  // its *own* provider-side function protocol injection.  Wrapping the whole
  // conversation in a synthetic user JSON envelope made Qwen treat DSH's
  // `<parameter=...>` protocol as prose, rather than allowing Rogator to
  // parse and return an OpenAI tool call. Pass the native request through
  // without a second context budget: Rogator owns prompt budgeting, including
  // its Qwen OSS long-text path. Its OpenAI normalizer accepts `system`, not
  // the OpenAI-specific `developer` alias, so adapt only that role in place.
  const adaptedRoles = source.map((message) => ({
    ...message,
    role: message.role === 'developer' ? 'system' : message.role
  }));
  const executionHistory = compactExecutedMutationArguments(adaptedRoles);
  return compactDshOrderedHistory(executionHistory, 18000);
}

function runtimeGatewayMessages(context, localToolBoundary) {
  const instructions = String(context.instructions || '')
    // Rogator owns the provider wire syntax for this path. Keeping the generic
    // JSON-format hint beside ENTML creates two competing output protocols.
    .replace(/^\s*-\s*工具调用使用[^\n]*\n?/m, '');
  const history = orderedMessages(context.messages || []);
  return [{
    role: 'user',
    content: [
      localToolBoundary,
      instructions,
      'Continue the ordered WebAgent conversation below. Tool results are authoritative local results. Use the API function tools supplied with this request for the next required action; do not print or imitate a tool-call wire format in ordinary text.',
      '<webagent_messages_json>' + JSON.stringify(history) + '</webagent_messages_json>'
    ].filter(Boolean).join('\n\n')
  }];
}

function openAITools(tools) {
  return (Array.isArray(tools) ? tools : []).map((tool) => {
    if (tool && tool.type === 'function' && tool.function) return { ...tool, function: compactSchemaDescriptions(tool.function) };
    const name = String(tool && (tool.name || tool.id) || '').trim();
    if (!name) return null;
    return {
      type: 'function',
      function: {
        name,
        description: compactValue(String(tool.description || tool.label || ''), 480),
        parameters: compactSchemaDescriptions(tool.parameters || tool.input_schema || { type: 'object', additionalProperties: true })
      }
    };
  }).filter(Boolean);
}

function providerToolCompatibility(tools) {
  const canonicalTools = openAITools(tools);
  const canonical = new Map(canonicalTools.map((tool) => [tool.function.name, tool.function]));
  const aliases = new Map();
  const add = (name, target, description, parameters, compile) => {
    if (canonical.has(name) || !canonical.has(target)) return;
    const definition = { name, description, parameters };
    aliases.set(name, { target, definition, compile });
  };

  add('run_in_terminal', 'pwsh',
    'Run a command in the local Windows Harness workspace. This is an alias for the DSH pwsh tool; it is not a cloud terminal.',
    {
      type: 'object', additionalProperties: false,
      properties: {
        command: { type: 'string', description: 'PowerShell command to run locally.' },
        description: { type: 'string', description: 'Short active-voice description of the command.' },
        workdir: { type: 'string', description: 'Optional local working directory.' },
        timeout_ms: { type: 'number', description: 'Optional timeout in milliseconds.' },
        is_background: { type: 'boolean', description: 'Run as a managed DSH background job.' }
      },
      required: ['command']
    },
    (args) => ({
      command: args.command,
      description: args.description || 'Run local workspace command',
      ...(args.workdir ? { workdir: args.workdir } : {}),
      ...(Number(args.timeout_ms) > 0 ? { timeoutMs: Number(args.timeout_ms) } : {}),
      ...(args.is_background === true || args.is_background === 'true' ? { run_in_background: true } : {})
    }));

  add('code_interpreter', 'pwsh',
    'Execute Python, JavaScript, or PowerShell code locally in the Harness workspace. Files and side effects remain subject to DSH sandbox and approval policy.',
    {
      type: 'object', additionalProperties: false,
      properties: {
        code: { type: 'string', description: 'Source code to execute locally.' },
        language: { type: 'string', enum: ['python', 'javascript', 'powershell'], description: 'Source language. Defaults to python.' },
        description: { type: 'string', description: 'Short active-voice description.' },
        workdir: { type: 'string', description: 'Optional local working directory.' },
        timeout_ms: { type: 'number', description: 'Optional timeout in milliseconds.' }
      },
      required: ['code']
    },
    (args) => {
      const language = String(args.language || 'python').toLowerCase();
      const suffix = language === 'javascript' ? '.js' : language === 'powershell' ? '.ps1' : '.py';
      const runner = language === 'javascript' ? 'node' : language === 'powershell' ? 'pwsh -File' : 'python';
      const encoded = Buffer.from(String(args.code || ''), 'utf8').toString('base64');
      const command = [
        "$waTmp = Join-Path (Get-Location) ('.webagent-code-' + [guid]::NewGuid().ToString('N') + '" + suffix + "')",
        "[IO.File]::WriteAllBytes($waTmp, [Convert]::FromBase64String('" + encoded + "'))",
        'try { & ' + runner + ' $waTmp } finally { Remove-Item -LiteralPath $waTmp -Force -ErrorAction SilentlyContinue }'
      ].join('; ');
      return {
        command,
        description: args.description || 'Run local ' + language + ' code',
        ...(args.workdir ? { workdir: args.workdir } : {}),
        ...(Number(args.timeout_ms) > 0 ? { timeoutMs: Number(args.timeout_ms) } : {})
      };
    });

  add('read_file', 'read', 'Read a local workspace text file through DSH.', {
    type: 'object', additionalProperties: false,
    properties: {
      path: { type: 'string' }, file_path: { type: 'string' },
      offset: { type: 'number' }, limit: { type: 'number' }
    },
    anyOf: [{ required: ['path'] }, { required: ['file_path'] }]
  }, (args) => ({
    file_path: args.file_path || args.path,
    ...(args.offset != null ? { offset: args.offset } : {}),
    ...(args.limit != null ? { limit: args.limit } : {})
  }));

  add('write_file', 'write', 'Create or replace a local workspace text file through DSH.', {
    type: 'object', additionalProperties: false,
    properties: { path: { type: 'string' }, file_path: { type: 'string' }, content: { type: 'string' } },
    required: ['content'], anyOf: [{ required: ['path'] }, { required: ['file_path'] }]
  }, (args) => ({ file_path: args.file_path || args.path, content: args.content }));

  add('search_files', 'grep', 'Search local workspace file contents with a regular expression through DSH.', {
    type: 'object', additionalProperties: false,
    properties: {
      query: { type: 'string' }, pattern: { type: 'string' }, path: { type: 'string' }, include: { type: 'string' }
    },
    anyOf: [{ required: ['query'] }, { required: ['pattern'] }]
  }, (args) => ({
    pattern: args.pattern || args.query,
    ...(args.path ? { path: args.path } : {}),
    ...(args.include ? { include: args.include } : {})
  }));

  add('list_directory', 'glob', 'List files in a local workspace directory through the DSH glob tool.', {
    type: 'object', additionalProperties: false,
    properties: { path: { type: 'string' }, pattern: { type: 'string' } }
  }, (args) => ({ pattern: args.pattern || '*', ...(args.path ? { path: args.path } : {}) }));

  // Expose exactly one provider-familiar name for each compatible local
  // capability. Advertising both `pwsh` and `run_in_terminal` (and likewise
  // read/read_file, write/write_file, ...) made Qwen choose between duplicate
  // schemas and enlarged every ENTML request. Keep all aliases accepted on the
  // return path so learned/native calls such as code_interpreter still compile,
  // but present one unambiguous vocabulary to the model.
  const preferredAlias = new Map([
    ['pwsh', 'run_in_terminal'],
    ['read', 'read_file'],
    ['write', 'write_file'],
    ['grep', 'search_files'],
    ['glob', 'list_directory']
  ]);
  const replacedTargets = new Set(
    [...preferredAlias.entries()]
      .filter(([, alias]) => aliases.has(alias))
      .map(([target]) => target)
  );
  const upstream = canonicalTools.filter((tool) => !replacedTargets.has(tool.function.name));
  for (const [target, aliasName] of preferredAlias) {
    const alias = aliases.get(aliasName);
    if (alias && alias.target === target) upstream.push({ type: 'function', function: alias.definition });
  }

  return { canonical, aliases, upstream };
}

function compileProviderToolCall(name, args, tools) {
  const compatibility = providerToolCompatibility(tools);
  const alias = compatibility.aliases.get(name);
  const target = alias ? alias.target : name;
  if (!compatibility.canonical.has(target)) return null;
  let compiled = alias ? alias.compile({ ...args }) : { ...args };
  if (!compiled || typeof compiled !== 'object' || Array.isArray(compiled)) return null;
  compiled = normalizeStructuredArguments(target, compiled, tools);
  const schema = compatibility.canonical.get(target).parameters || {};
  const properties = schema.properties || {};
  if (schema.additionalProperties === false) {
    compiled = Object.fromEntries(Object.entries(compiled).filter(([key]) => Object.prototype.hasOwnProperty.call(properties, key)));
  }
  const required = Array.isArray(schema.required) ? schema.required : [];
  if (required.some((key) => compiled[key] == null || compiled[key] === '')) return null;
  return { name: target, arguments: compiled };
}

function providerAcceptedDefinitions(compatibility) {
  return [
    ...compatibility.canonical.values(),
    ...Array.from(compatibility.aliases.values(), (alias) => alias.definition)
  ];
}

function appendToolCallDelta(calls, delta) {
  for (const item of Array.isArray(delta && delta.tool_calls) ? delta.tool_calls : []) {
    if (!item || typeof item !== 'object') continue;
    const index = Number.isInteger(item.index) ? item.index : calls.size;
    const current = calls.get(index) || { id: '', name: '', arguments: '' };
    const fn = item.function && typeof item.function === 'object' ? item.function : item;
    if (item.id) current.id = String(item.id);
    if (fn.name) {
      const name = String(fn.name);
      current.name = name.startsWith(current.name) ? name : current.name + name;
    }
    if (fn.arguments != null) {
      const fragment = typeof fn.arguments === 'string' ? fn.arguments : JSON.stringify(fn.arguments);
      // Some compatible gateways emit argument fragments, while others emit
      // cumulative JSON snapshots. Accept both without duplicating text.
      current.arguments = fragment.startsWith(current.arguments) ? fragment : current.arguments + fragment;
    }
    calls.set(index, current);
  }
}

function schemaBranches(schema) {
  if (!schema || typeof schema !== 'object') return [];
  const branches = [];
  if (Array.isArray(schema.oneOf)) branches.push(...schema.oneOf);
  if (Array.isArray(schema.anyOf)) branches.push(...schema.anyOf);
  return branches.filter((branch) => branch && typeof branch === 'object');
}

function schemaAcceptsStructuredValue(schema, decoded) {
  if (!schema || typeof schema !== 'object') return false;
  const objectValue = decoded && typeof decoded === 'object' && !Array.isArray(decoded);
  if (schema.type === 'object' && objectValue) return true;
  if (schema.type === 'array' && Array.isArray(decoded)) return true;
  if (!schema.type && schema.properties && objectValue) return true;
  return schemaBranches(schema).some((branch) => schemaAcceptsStructuredValue(branch, decoded));
}

function decodeStructuredValue(value, schema) {
  if (typeof value !== 'string') return value;
  try {
    const decoded = JSON.parse(value);
    return schemaAcceptsStructuredValue(schema, decoded) ? decoded : value;
  } catch (_) {
    return value;
  }
}

function matchingSchemaBranch(schema, value) {
  const branches = schemaBranches(schema);
  if (!branches.length || !value || typeof value !== 'object' || Array.isArray(value)) return schema;
  return branches.find((branch) => {
    const properties = branch.properties || {};
    return Object.entries(properties).every(([key, property]) => property.const === undefined || value[key] === property.const);
  }) || branches[0];
}

function normalizeValueAgainstSchema(value, schema) {
  const decoded = decodeStructuredValue(value, schema);
  if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) return decoded;
  const selected = matchingSchemaBranch(schema, decoded) || {};
  const properties = selected.properties || schema && schema.properties || {};
  const normalized = { ...decoded };
  for (const [key, property] of Object.entries(properties)) {
    if (Object.prototype.hasOwnProperty.call(normalized, key)) normalized[key] = normalizeValueAgainstSchema(normalized[key], property);
  }
  return normalized;
}

function repairCordisDefineArguments(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return args;
  const normalized = { ...args };
  let plugin = normalized.plugin && typeof normalized.plugin === 'object' && !Array.isArray(normalized.plugin)
    ? { ...normalized.plugin }
    : null;
  let packageValue = normalized.package;
  if (typeof packageValue === 'string') {
    try { packageValue = JSON.parse(packageValue); } catch (_) { packageValue = null; }
  }
  if (!packageValue || typeof packageValue !== 'object' || Array.isArray(packageValue)) packageValue = null;

  // Qwen's webpage function bridge sometimes projects the flat Cordis schema
  // as two conceptual records, `plugin` and `package`. Restore the exact DSH
  // schema at the provider boundary so Harness still validates and executes it.
  // It also sometimes flattens the `plugin` union and the single client/host
  // code field. Both projections are lossless enough to restore here.
  if (!plugin && typeof normalized.idPrefix === 'string') {
    plugin = { kind: 'new', idPrefix: normalized.idPrefix };
    delete normalized.idPrefix;
  } else if (!plugin && typeof normalized.pluginId === 'string') {
    plugin = { kind: 'existing', pluginId: normalized.pluginId };
    delete normalized.pluginId;
  }
  if (typeof normalized.code === 'string') {
    const source = normalized.code;
    const clientCode = /platform\s*:\s*['"]client['"]|\b(?:document|window|React|slots?)\b/.test(source);
    normalized.code = clientCode ? { client: source } : { host: source };
  }
  if (normalized.code == null && (typeof normalized.client === 'string' || typeof normalized.host === 'string')) {
    normalized.code = {};
    if (typeof normalized.client === 'string') normalized.code.client = normalized.client;
    if (typeof normalized.host === 'string') normalized.code.host = normalized.host;
    delete normalized.client;
    delete normalized.host;
  }
  if (plugin) {
    if (plugin.kind === 'existing' && plugin.pluginId == null && typeof plugin.id === 'string') {
      plugin.pluginId = plugin.id;
      delete plugin.id;
    }
    if (normalized.name == null && typeof plugin.name === 'string') normalized.name = plugin.name;
    if (normalized.purpose == null && typeof plugin.purpose === 'string') normalized.purpose = plugin.purpose;
    if (plugin.kind === 'new' && plugin.idPrefix == null && typeof plugin.name === 'string') {
      const letters = plugin.name.toLowerCase().replace(/[^a-z]/g, '');
      plugin.idPrefix = (letters || 'plug').slice(0, 6).padEnd(3, 'x');
    }
    if (plugin.kind === 'new' && typeof plugin.idPrefix === 'string') {
      const letters = plugin.idPrefix.toLowerCase().replace(/[^a-z]/g, '');
      plugin.idPrefix = (letters || 'plug').slice(0, 6).padEnd(3, 'x');
    }
    delete plugin.name;
    delete plugin.purpose;
    normalized.plugin = plugin;
    if (normalized.name == null) {
      const seed = String(plugin.idPrefix || plugin.pluginId || 'dynamic-plugin').trim();
      normalized.name = seed + (/-plugin$/i.test(seed) ? '' : '-plugin');
    }
    if (normalized.purpose == null && normalized.code && typeof normalized.code === 'object') {
      normalized.purpose = 'Dynamic Cordis package ' + normalized.name + '.';
    }
  }
  if (packageValue) {
    if (normalized.name == null && typeof packageValue.name === 'string') normalized.name = packageValue.name;
    if (normalized.purpose == null) {
      if (typeof packageValue.purpose === 'string') normalized.purpose = packageValue.purpose;
      else if (typeof packageValue.description === 'string') normalized.purpose = packageValue.description;
    }
    if (normalized.code == null && packageValue.code && typeof packageValue.code === 'object') normalized.code = packageValue.code;
    delete normalized.package;
  }
  return normalized;
}

function repairKnownSkillAlias(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return args;
  const aliases = {
    'cordis-plugin-dev': 'cordis-plugin-development',
    'cordis-plugin': 'cordis-plugin-development'
  };
  const name = String(args.name || '').trim();
  return aliases[name] ? { ...args, name: aliases[name] } : args;
}

function normalizeStructuredArguments(name, args, tools) {
  const definitions = new Map(openAITools(tools).map((tool) => [tool.function.name, tool.function]));
  const definition = definitions.get(name);
  const properties = definition && definition.parameters && definition.parameters.properties || {};
  const normalized = { ...args };
  for (const [key, schema] of Object.entries(properties)) {
    if (!Object.prototype.hasOwnProperty.call(normalized, key)) continue;
    normalized[key] = normalizeValueAgainstSchema(normalized[key], schema);
  }
  // Rogator's ENTML bridge can preserve formatting newlines around scalar
  // parameter bodies (for example path becomes "\n.\n"). Those bytes are
  // transport padding, not user data, and form invalid Windows paths. Never
  // trim payload-bearing fields such as content/code/old_string/new_string.
  const trimSafe = /^(?:path|file|file_path|pattern|include|query|command|cmd|description|workdir|cwd|name|language)$/i;
  for (const [key, value] of Object.entries(normalized)) {
    if (trimSafe.test(key) && typeof value === 'string') normalized[key] = value.trim();
  }
  if (name === 'cordis_define') return repairCordisDefineArguments(normalized);
  if (name === 'cordis_inspect_query' && typeof normalized.input === 'string') {
    try {
      const input = JSON.parse(normalized.input);
      if (input && typeof input === 'object' && !Array.isArray(input)) normalized.input = input;
    } catch (_) {}
  }
  if (name === 'skill') return repairKnownSkillAlias(normalized);
  return normalized;
}

function preferToolCandidate(candidates, args) {
  if (!Array.isArray(candidates) || candidates.length <= 1) return candidates;
  const keys = Object.keys(args || {});
  if (keys.includes('include')) {
    const grep = candidates.filter((tool) => /^(?:grep|search|rg)$/i.test(tool.name));
    if (grep.length === 1) return grep;
  }
  if (typeof args.pattern === 'string') {
    const pattern = args.pattern.trim();
    if (/(?:\*\*|\*\.|\{[^}]*,[^}]*\})/.test(pattern)) {
      const glob = candidates.filter((tool) => /^glob$/i.test(tool.name));
      if (glob.length === 1) return glob;
    }
    if (/[|^$()+\\]/.test(pattern)) {
      const grep = candidates.filter((tool) => /^(?:grep|search|rg)$/i.test(tool.name));
      if (grep.length === 1) return grep;
    }
  }
  return candidates;
}

function unsafeGatewayToolArguments(name, args) {
  if (!/^(?:pwsh|powershell|bash|shell|exec|exec_command|run_in_terminal)$/i.test(String(name || ''))) return false;
  const command = String(args && (args.command || args.cmd) || '');
  if (!command) return false;
  // A DSH verification command once used `Get-Process node | Stop-Process`,
  // which killed Harness, the Runtime launcher and every unrelated Node task.
  // Gateway models may start a helper, but cleanup must target the exact PID
  // returned for that helper. Reject process-name and wildcard mass kills.
  return /Get-Process\s+(?:-Name\s+)?(?:node|electron|python|pwsh|powershell)\b[^\r\n;|]*\|\s*Stop-Process\b/i.test(command)
    || /Stop-Process\b[^\r\n;]*(?:-Name\s+(?:node|electron|python|pwsh|powershell)\b|\*)/i.test(command)
    || /taskkill\b[^\r\n;]*\/IM\s+(?:node|electron|python|pwsh|powershell)(?:\.exe)?\b/i.test(command)
    || /(?:pkill|killall)\s+(?:-[^\s]+\s+)*(?:node|electron|python|pwsh|powershell)\b/i.test(command);
}

function toolCallFences(calls, tools) {
  const compatibility = providerToolCompatibility(tools);
  const definitions = new Set(providerAcceptedDefinitions(compatibility).map((definition) => definition.name));
  const seen = new Set();
  return Array.from(calls.keys()).sort((a, b) => a - b).map((index) => {
    const call = calls.get(index);
    // Forward only advertised canonical names or compatibility aliases. The
    // compiler below maps aliases back to the DSH manifest before execution.
    if (!call || !call.name || !definitions.has(call.name)) return '';
    let args = {};
    try { args = call.arguments ? JSON.parse(call.arguments) : {}; } catch (_) { return ''; }
    if (!args || typeof args !== 'object' || Array.isArray(args)) return '';
    const compiled = compileProviderToolCall(call.name, args, tools);
    if (!compiled || unsafeGatewayToolArguments(compiled.name, compiled.arguments)) return '';
    const canonical = JSON.stringify(compiled);
    if (seen.has(canonical)) return '';
    seen.add(canonical);
    return '```dsh-tool-call\n' + canonical + '\n```';
  }).filter(Boolean).join('\n');
}

function providerToolAttempt(message, tools) {
  const supported = new Set(providerAcceptedDefinitions(providerToolCompatibility(tools)).map((definition) => definition.name));
  const attempted = new Set();
  for (const call of Array.isArray(message && message.tool_calls) ? message.tool_calls : []) {
    const name = String(call && call.function && call.function.name || call && call.name || '').trim();
    if (name) attempted.add(name);
  }
  const content = String(message && message.content || '');
  const hasDshWire = /(?:^|\r?\n)(?:`{3})?dsh[-_]tool[-_]call\b/i.test(content);
  if (hasDshWire) {
    const names = /\{\s*"name"\s*:\s*"([^"]+)"/gi;
    let match;
    while ((match = names.exec(content)) !== null) attempted.add(String(match[1] || '').trim());
  }
  const entmlNames = /<(?:entml:)?(?:function|invoke)(?:\s+name\s*=\s*["']?([^\s>"']+)|\s*=\s*["']?([^\s>"']+))/gi;
  let entml;
  while ((entml = entmlNames.exec(content)) !== null) attempted.add(String(entml[1] || entml[2] || '').trim());
  return {
    hasWireSyntax: hasDshWire || /<\/?(?:entml:)?(?:function|invoke)\b/i.test(content) || attempted.size > 0,
    unsupported: Array.from(attempted).filter((name) => name && !supported.has(name))
  };
}

function normalizedProviderMessage(message, tools, promptPassthrough) {
  const calls = new Map();
  appendToolCallDelta(calls, { tool_calls: message && message.tool_calls || [] });
  const fences = toolCallFences(calls, tools);
  const textualFences = promptPassthrough ? dshTextToolFences(message && message.content, tools) : '';
  const residualFence = residualQwenToolFence(message && message.content, tools);
  const attempt = providerToolAttempt(message, tools);
  const recovered = fences || textualFences || residualFence;
  return {
    content: recovered || (!attempt.hasWireSyntax ? String(message && message.content || '').trimEnd() : ''),
    attempt,
    recovered
  };
}

function dshTextToolFences(content, tools) {
  const compatibility = providerToolCompatibility(tools);
  const definitions = new Map(providerAcceptedDefinitions(compatibility).map((definition) => [definition.name, definition]));
  if (!definitions.size) return '';
  const fences = [];
  const seen = new Set();
  const pattern = /(?:^|\r?\n)(?:`{3})?dsh[-_]tool[-_]call[^\S\r\n]*\r?\n(\{[^\r\n]+\})/gi;
  let match;
  while ((match = pattern.exec(String(content || ''))) !== null) {
    let call;
    try { call = JSON.parse(match[1]); } catch (_) { continue; }
    const name = String(call && call.name || '');
    if (!call || !definitions.has(name) || !call.arguments || typeof call.arguments !== 'object' || Array.isArray(call.arguments)) continue;
    const compiled = compileProviderToolCall(name, call.arguments, tools);
    if (!compiled || unsafeGatewayToolArguments(compiled.name, compiled.arguments)) continue;
    const canonical = JSON.stringify(compiled);
    if (seen.has(canonical)) continue;
    seen.add(canonical);
    fences.push('```dsh-tool-call\n' + canonical + '\n```');
  }
  return fences.join('\n');
}

function qwenParameterEntries(content) {
  const source = String(content || '');
  const entries = [];
  // Qwen's ENTML serializer can omit </parameter> just before the next
  // parameter. Stop at either form of boundary so command never consumes the
  // following description/workdir field as text.
  const pattern = /<(?:entml:)?parameter(?:\s+name\s*=\s*["']?([^\s>"']+)["']?|\s*=\s*["']?([^\s>"']+)["']?)\s*>([\s\S]*?)(?=<(?:entml:)?parameter(?:\s+name\s*=|\s*=)|<\/(?:entml:)?function\s*>|$)/gi;
  let match;
  while ((match = pattern.exec(source)) !== null) {
    const key = String(match[1] || match[2] || '').trim();
    const raw = String(match[3] || '').replace(/<\/(?:entml:)?parameter\s*>\s*$/i, '').trim();
    if (!key) continue;
    try {
      const parsed = JSON.parse(raw);
      entries.push([key, typeof parsed === 'string' ? parsed.trim() : parsed]);
    } catch (_) { entries.push([key, raw]); }
  }
  return entries;
}

function residualQwenToolFence(content, tools) {
  const text = String(content || '');
  if (!/<\/?(?:entml:)?(?:function|invoke)\b/i.test(text)) return '';
  const explicit = text.match(/<(?:entml:)?(?:function|invoke)(?:\s+name\s*=\s*["']?([^\s>"']+)|\s*=\s*["']?([^\s>"']+))/i);
  const args = {};
  for (const [key, value] of qwenParameterEntries(text)) args[key] = value;
  const compatibility = providerToolCompatibility(tools);
  // Missing opening tags must be inferred only against canonical DSH schemas.
  // Alias schemas intentionally overlap those targets and would otherwise make
  // a recoverable orphan call ambiguous. Explicitly named aliases remain valid
  // and are compiled below.
  const definitions = Array.from(compatibility.canonical.values());
  const supportedDefinitions = providerAcceptedDefinitions(compatibility);
  let name = String(explicit && (explicit[1] || explicit[2]) || '').trim();
  // With several parallel calls Qwen 3.8 occasionally emits only the named
  // parameter body plus </function>; Rogator drops the fragmented opening
  // tags and therefore cannot form message.tool_calls. Recover each closed
  // block independently against the advertised schemas instead of merging
  // all file_path values into one lossy call.
  if (!name && /<\/?(?:entml:)?parameter\b/i.test(text) && /<\/(?:entml:)?function\s*>/i.test(text)) {
    const blocks = text.split(/<\/(?:entml:)?function\s*>/i).slice(0, -1);
    const recovered = [];
    const seen = new Set();
    for (const block of blocks) {
      const localArgs = {};
      for (const [key, value] of qwenParameterEntries(block)) localArgs[key] = value;
      // Qwen/Rogator may append a duplicate bare </function> after a valid
      // parameterized call.  It creates an empty split block; ignore only that
      // block instead of discarding the valid call recovered before it.
      if (!Object.keys(localArgs).length) continue;
      let candidates = definitions.filter((tool) => {
        const schema = tool.parameters || {};
        const properties = schema.properties || {};
        const required = Array.isArray(schema.required) ? schema.required : [];
        return Object.keys(localArgs).every((key) => Object.prototype.hasOwnProperty.call(properties, key))
          && required.every((key) => Object.prototype.hasOwnProperty.call(localArgs, key));
      });
      // A long `write` payload is the most common place for the webpage DOM
      // bridge to lose two adjacent opening tags at once. The surviving wire
      // text then starts like this:
      //   D:\\workspace\\index.html
      //   </parameter><parameter=content>...</parameter></function>
      // Recover the unnamed leading value only when the advertised schemas
      // leave exactly one required path-shaped property and identify a unique
      // tool. This deliberately does not guess arbitrary missing arguments.
      const orphanLeadingParameter = block.match(/^\s*([^<]+?)\s*(?:<\/(?:entml:)?parameter\s*>\s*)?(?=<(?:entml:)?parameter\b)/i);
      if (!candidates.length && orphanLeadingParameter) {
        const leadingValue = String(orphanLeadingParameter[1] || '').trim();
        if (leadingValue && /^(?:[a-z]:[\\/]|\.?\.?[\\/]|[^\r\n<>]+[\\/])?[^\r\n<>]+\.[a-z0-9_-]+$/i.test(leadingValue)) {
          const backfill = definitions.filter((tool) => {
            const schema = tool.parameters || {};
            const properties = schema.properties || {};
            const required = Array.isArray(schema.required) ? schema.required : [];
            const missing = required.filter((key) => !Object.prototype.hasOwnProperty.call(localArgs, key));
            return Object.keys(localArgs).every((key) => Object.prototype.hasOwnProperty.call(properties, key))
              && missing.length === 1
              && /^(?:path|file|file_path)$/i.test(missing[0]);
          });
          if (backfill.length === 1) {
            const required = Array.isArray(backfill[0].parameters && backfill[0].parameters.required)
              ? backfill[0].parameters.required
              : [];
            const pathKey = required.find((key) => /^(?:path|file|file_path)$/i.test(key));
            if (pathKey) {
              localArgs[pathKey] = leadingValue;
              candidates = backfill;
            }
          }
        }
      }
      // Qwen 3.8 can lose just the opening <function=pwsh> tag while retaining
      // the command as plain text immediately before its named parameters:
      //   cd app; npm install ... <parameter=description>...</parameter>
      //   <parameter=workdir>...</parameter></function>
      // It is not user-facing prose. Recover it only for a unique advertised
      // command-shaped tool with one missing command/cmd argument; otherwise
      // leave the fragment untouched rather than guessing a tool invocation.
      const commandPrelude = block
        .replace(/<(?:entml:)?(?:function|invoke)[^>]*>/gi, '')
        .replace(/<(?:entml:)?parameter(?:\s+name\s*=\s*["']?[^\s>"']+["']?|\s*=\s*["']?[^\s>"']+["']?)\s*>[\s\S]*?(?=<(?:entml:)?parameter(?:\s+name\s*=|\s*=)|<\/(?:entml:)?function\s*>|$)/gi, '')
        .trim();
      if (!candidates.length && commandPrelude
        && /^(?:cd|npm|pnpm|yarn|npx|node|git|powershell|pwsh|python|New-Item|Set-Location)\b/i.test(commandPrelude)) {
        let backfill = definitions.filter((tool) => {
          const schema = tool.parameters || {};
          const properties = schema.properties || {};
          const required = Array.isArray(schema.required) ? schema.required : [];
          const missing = required.filter((key) => !Object.prototype.hasOwnProperty.call(localArgs, key));
          return Object.keys(localArgs).every((key) => Object.prototype.hasOwnProperty.call(properties, key))
            && missing.length === 1 && /^(?:command|cmd)$/i.test(missing[0]);
        });
        backfill = preferToolCandidate(backfill, { ...localArgs, command: commandPrelude });
        if (backfill.length === 1) {
          const required = Array.isArray(backfill[0].parameters && backfill[0].parameters.required) ? backfill[0].parameters.required : [];
          const commandKey = required.find((key) => /^(?:command|cmd)$/i.test(key));
          if (commandKey) {
            localArgs[commandKey] = commandPrelude;
            candidates = backfill;
          }
        }
      }
      // A repair round can retain the provider-facing `path` parameter but
      // lose the opening `<function=read_file>` tag.  Canonical DSH exposes
      // that same value as `read.file_path`, so a strict property-name match
      // above finds no candidate and incorrectly aborts the run.  Recover only
      // the narrow, file-shaped single-argument case and only when exactly one
      // canonical read tool exists. Directory-shaped paths stay ambiguous.
      if (!candidates.length && Object.keys(localArgs).length === 1
        && typeof localArgs.path === 'string'
        && /^(?:[a-z]:[\\/]|\.?\.?[\\/]|[^\r\n<>]+[\\/])?[^\r\n<>]+\.[a-z0-9_-]+$/i.test(localArgs.path.trim())) {
        const readers = definitions.filter((tool) => {
          if (!/^(?:read|read_file)$/i.test(tool.name)) return false;
          const schema = tool.parameters || {};
          const properties = schema.properties || {};
          const required = Array.isArray(schema.required) ? schema.required : [];
          return required.length === 1
            && /^(?:path|file|file_path)$/i.test(required[0])
            && Object.prototype.hasOwnProperty.call(properties, required[0]);
        });
        if (readers.length === 1) {
          const pathKey = readers[0].parameters.required[0];
          const filePath = localArgs.path.trim();
          delete localArgs.path;
          localArgs[pathKey] = filePath;
          candidates = readers;
        }
      }
      candidates = preferToolCandidate(candidates, localArgs);
      if (candidates.length > 1 && Object.keys(localArgs).length === 1) {
        const key = Object.keys(localArgs)[0];
        const preferred = candidates.filter((tool) => {
          if (/^(?:file_path|file)$/i.test(key)) return /^(?:read|read_file)$/i.test(tool.name);
          if (/^(?:command|cmd)$/i.test(key)) return /^(?:pwsh|bash|exec|exec_command)$/i.test(tool.name);
          if (/^(?:pattern|glob)$/i.test(key)) return /^(?:glob|rg|search)$/i.test(tool.name);
          return false;
        });
        if (preferred.length === 1) candidates = preferred;
      }
      if (candidates.length !== 1) return '';
      const compiled = compileProviderToolCall(candidates[0].name, localArgs, tools);
      if (!compiled || unsafeGatewayToolArguments(compiled.name, compiled.arguments)) continue;
      const canonical = JSON.stringify(compiled);
      if (seen.has(canonical)) continue;
      seen.add(canonical);
      recovered.push('```dsh-tool-call\n' + canonical + '\n```');
    }
    if (recovered.length) return recovered.join('\n');
  }
  if (!Object.keys(args).length && /<\/(?:entml:)?function\s*>/i.test(text)) {
    const blocks = text.split(/<\/(?:entml:)?function\s*>/i).slice(0, -1)
      .map((block) => block.replace(/<(?:entml:)?(?:function|invoke)[^>]*>/gi, '').trim()).filter(Boolean);
    const recovered = [];
    for (const block of blocks) {
      // Long write calls can lose the function tag and BOTH parameter opening
      // tags while preserving the closing function tag. The remaining shape
      // is unambiguous: one file path on the first line, a blank separator,
      // then the complete file payload (which may itself contain any number
      // of blank lines). Do not split that payload positionally.
      const orphanWrite = block.match(/^([^\r\n<>]+\.[a-z0-9_-]+)\r?\n\s*\r?\n([\s\S]+)$/i);
      const writeDefinition = definitions.find((tool) => tool.name === 'write'
        && Array.isArray(tool.parameters && tool.parameters.required)
        && tool.parameters.required.includes('file_path')
        && tool.parameters.required.includes('content'));
      if (orphanWrite && writeDefinition) {
        const filePath = String(orphanWrite[1] || '').trim();
        if (/^(?:[a-z]:[\\/]|\.?\.?[\\/]|[^\r\n<>]+[\\/])?[^\r\n<>]+\.[a-z0-9_-]+$/i.test(filePath)) {
          const compiled = compileProviderToolCall('write', { file_path: filePath, content: orphanWrite[2] }, tools);
          if (compiled) {
            recovered.push('```dsh-tool-call\n' + JSON.stringify(compiled) + '\n```');
            continue;
          }
        }
      }
      const segments = block.split(/\r?\n\s*\r?\n/).map((value) => value.trim()).filter(Boolean);
      let candidates = definitions.filter((tool) => {
        const required = Array.isArray(tool.parameters && tool.parameters.required) ? tool.parameters.required : [];
        return required.length === segments.length && required.length > 0;
      });
      if (candidates.length > 1 && segments.length === 1) {
        const value = segments[0];
        const scored = candidates.map((tool) => {
          const key = tool.parameters.required[0];
          let score = 0;
          // Rogator occasionally loses both the ENTML opening tag and the
          // <parameter=name> wrapper for a Skill call, leaving only the exact
          // skill id followed by </function>.  Prefer the advertised `skill`
          // function for that narrowly identifiable shape instead of leaking
          // the provider wire fragment into the assistant message.
          if (/^skill$/i.test(tool.name) && /^name$/i.test(key)
            && /^(?:cordis-plugin(?:-development|-dev)?|editing-cordis-compositions)$/i.test(value)) score += 4;
          if (/^(?:path|file|file_path)$/i.test(key) && (/[\\/]/.test(value) || /^[^\s]+\.[a-z0-9_-]+$/i.test(value))) score += 2;
          if (/^(?:command|cmd)$/i.test(key) && /^(?:npm|node|pnpm|yarn|git|npx|pwsh|powershell|python)\b/i.test(value)) score += 2;
          return { tool, score };
        });
        const best = Math.max(...scored.map((item) => item.score));
        candidates = best > 0 && scored.filter((item) => item.score === best).length === 1
          ? [scored.find((item) => item.score === best).tool]
          : [];
      }
      if (candidates.length !== 1) return '';
      const positionalArgs = {};
      candidates[0].parameters.required.forEach((key, index) => { positionalArgs[key] = segments[index]; });
      const compiled = compileProviderToolCall(candidates[0].name, positionalArgs, tools);
      if (!compiled || unsafeGatewayToolArguments(compiled.name, compiled.arguments)) continue;
      recovered.push('```dsh-tool-call\n' + JSON.stringify(compiled) + '\n```');
    }
    if (recovered.length) return recovered.join('\n');
  }
  if (!name && Object.keys(args).length) {
    const candidates = definitions.filter((tool) => {
      const schema = tool.parameters || {};
      const properties = schema.properties || {};
      const required = Array.isArray(schema.required) ? schema.required : [];
      return Object.keys(args).every((key) => Object.prototype.hasOwnProperty.call(properties, key))
        && required.every((key) => Object.prototype.hasOwnProperty.call(args, key));
    });
    if (candidates.length === 1) name = candidates[0].name;
  }
  if (!name || !Object.keys(args).length || !supportedDefinitions.some((tool) => tool.name === name)) return '';
  const compiled = compileProviderToolCall(name, args, tools);
  if (!compiled || unsafeGatewayToolArguments(compiled.name, compiled.arguments)) return '';
  return '```dsh-tool-call\n' + JSON.stringify(compiled) + '\n```';
}

function csvCell(value) {
  const text = String(value == null ? '' : value);
  return /[",\r\n]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
}

function findPort(host) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, host, () => {
      const address = server.address();
      server.close(() => resolve(address.port));
    });
  });
}

function runCommand(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, Object.assign({ windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }, options || {}));
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk.toString(); });
    child.stderr.on('data', (chunk) => { output += chunk.toString(); });
    child.once('error', reject);
    child.once('exit', (code) => code === 0 ? resolve(output) : reject(gatewayError(output.trim() || command + ' exited with code ' + code, 'qwen_gateway_install_failed', 500)));
  });
}

class RogatorService {
  constructor(options) {
    options = options || {};
    this.home = path.resolve(options.home);
    this.source = path.resolve(options.source || path.join(this.home, 'source'));
    this.python = options.python || process.env.WEBAGENT_ROGATOR_PYTHON || 'python';
    this.repository = options.repository || ROGATOR_REPOSITORY;
    this.revision = options.revision || ROGATOR_REVISION;
    this.runner = options.runner || null;
    this.fetch = options.fetch || global.fetch;
    this.encrypt = options.encrypt || null;
    this.decrypt = options.decrypt || null;
    this.getBrowserCredentials = options.getBrowserCredentials || null;
    this.authenticate = options.authenticate || null;
    this.process = null;
    this.port = null;
    this.starting = null;
    this.error = '';
    this.logs = [];
    this.active = new Map();
    this.materialized = { account: false, session: false, cookies: false };
    this.authSource = '';
    this.backoffUntil = 0;
    this.backoffReason = '';
    this.baxiaFailures = 0;
    this.minimumIntervalMs = Math.max(0, Math.min(30000, Number(options.minimumIntervalMs ?? process.env.WEBAGENT_QWEN_MIN_INTERVAL_MS ?? 8000) || 0));
    this.backoffBaseMs = Math.max(10, Math.min(10 * 60 * 1000, Number(options.backoffBaseMs ?? process.env.WEBAGENT_QWEN_BACKOFF_BASE_MS ?? 90000) || 90000));
    this.automaticRetries = Math.max(0, Math.min(4, Number(options.automaticRetries ?? process.env.WEBAGENT_QWEN_AUTOMATIC_RETRIES ?? 2) || 0));
    this.nextRequestAt = 0;
    this.requestLane = Promise.resolve();
    this.queuedRequests = 0;
  }

  get credentialFile() { return path.join(this.home, 'qwen-account.enc.json'); }
  get accountCsv() { return path.join(this.source, 'config', 'upstream', 'qwen', 'accounts.csv'); }
  get sessionFile() { return path.join(this.source, 'persist', 'qwen', 'sessions.json'); }
  get browserCookieFile() { return path.join(this.source, 'persist', 'qwen', 'webagent-browser-cookies.json'); }
  get qwenUpstreamConfigFile() { return path.join(this.source, 'config', 'upstream', 'qwen', 'config.toml'); }
  // Rogator 2.2 migrates the legacy root config.toml into config/config.toml.
  // Write the canonical path directly so every dynamically selected port is
  // applied on subsequent starts instead of being shadowed by stale state.
  get configFile() { return path.join(this.source, 'config', 'config.toml'); }

  status() {
    return {
      id: 'qwen.gateway',
      name: 'Qianwen 网关模型',
      provider: 'rogator',
      upstream: 'qwen',
      deepseek_enabled: false,
      installed: fs.existsSync(path.join(this.source, 'main.py')),
      configured: fs.existsSync(this.credentialFile),
      browser_login_reuse: !!this.getBrowserCredentials,
      auth_source: this.authSource,
      running: !!(this.process && this.process.exitCode == null),
      starting: !!this.starting,
      pid: this.process && this.process.exitCode == null ? this.process.pid : null,
      url: this.port ? 'http://127.0.0.1:' + this.port : '',
      upstream_model: this._settings().model || DEFAULT_UPSTREAM_MODEL,
      revision: this.revision,
      error: this.error,
      backoff_until: this.backoffUntil > Date.now() ? new Date(this.backoffUntil).toISOString() : '',
      backoff_seconds: this.backoffUntil > Date.now() ? Math.ceil((this.backoffUntil - Date.now()) / 1000) : 0,
      minimum_interval_ms: this.minimumIntervalMs,
      automatic_retries: this.automaticRetries,
      queued_requests: this.queuedRequests,
      logs: this.logs.slice(-80)
      ,models: gatewayModels().filter((model) => !model.hidden).map((model) => ({ id: model.id, name: model.displayName, upstream: model.upstreamModel }))
    };
  }

  _settings() {
    try {
      const payload = JSON.parse(fs.readFileSync(this.credentialFile, 'utf8'));
      const plaintext = this.decrypt ? this.decrypt(payload.secret) : Buffer.from(payload.secret, 'base64').toString('utf8');
      return Object.assign({}, JSON.parse(plaintext), { configured: true });
    } catch (_) { return {}; }
  }

  async setAccount(input) {
    input = input || {};
    const username = String(input.username || input.email || input.phone || '').trim();
    const password = String(input.password || '');
    if (!username || !password) throw gatewayError('Qwen gateway username and password are required', 'qwen_gateway_credentials_required', 400);
    if (this.process) await this.stop();
    const account = { username, password, area_code: String(input.area_code || '').trim(), model: String(input.model || DEFAULT_UPSTREAM_MODEL).trim() || DEFAULT_UPSTREAM_MODEL };
    const plain = JSON.stringify(account);
    const secret = this.encrypt ? this.encrypt(plain) : Buffer.from(plain, 'utf8').toString('base64');
    fs.mkdirSync(this.home, { recursive: true });
    const temporary = this.credentialFile + '.tmp-' + process.pid;
    fs.writeFileSync(temporary, JSON.stringify({ version: 1, secret }), 'utf8');
    fs.renameSync(temporary, this.credentialFile);
    return this.status();
  }

  async login() {
    if (!this.authenticate) throw gatewayError('Qianwen gateway login UI is unavailable', 'qwen_gateway_login_unavailable', 503);
    if (this.process) await this.stop();
    await this.authenticate();
    return this.status();
  }

  async install() {
    if (this.process) await this.stop();
    fs.mkdirSync(this.home, { recursive: true });
    if (!fs.existsSync(path.join(this.source, '.git'))) {
      if (fs.existsSync(this.source)) throw gatewayError('Rogator source directory exists but is not a Git checkout', 'qwen_gateway_source_invalid', 409);
      await runCommand('git', ['clone', '--filter=blob:none', this.repository, this.source], { cwd: this.home });
    }
    await runCommand('git', ['fetch', '--depth', '1', 'origin', this.revision], { cwd: this.source });
    await runCommand('git', ['checkout', '--detach', this.revision], { cwd: this.source });
    await runCommand(this.python, ['-m', 'pip', 'install', '-r', 'requirements.txt'], { cwd: this.source });
    this.error = '';
    return this.status();
  }

  _writeLockedConfig(port) {
    const content = [
      '[server]',
      'port = ' + port,
      'host = "127.0.0.1"',
      'prelogin = 3',
      'login_interval = 15.0',
      'startup_force_kill_port = false',
      '',
      '[limits]',
      'max_concurrent = 8',
      'max_queue_size = 128',
      'model_context_length = 256000',
      'client_max_body_bytes = 33554432',
      '',
      '[upstream]',
      'enabled = ["qwen"]',
      '',
      '[fncall]',
      'record_all = false',
      'record_prompt = false',
      'print_prompt = false',
      'record_response = false',
      'record_sse = false',
      ''
    ].join('\n');
    fs.mkdirSync(path.dirname(this.configFile), { recursive: true });
    fs.writeFileSync(this.configFile, content, 'utf8');
    // Rogator's 10 KiB default moves longer prompt prefixes to an STS
      // attachment. Browser-reused sessions cannot always obtain STS upload
    // credentials, which silently drops the protocol prefix on the second
      // tool round. Qwen accepts this direct payload size, and Rogator's
    // PayloadTooLarge retry still halves the per-model limit if necessary.
    try {
      const qwenConfig = fs.readFileSync(this.qwenUpstreamConfigFile, 'utf8');
      const next = /qwen_send_max_chars\s*=\s*\d+/.test(qwenConfig)
        ? qwenConfig.replace(/qwen_send_max_chars\s*=\s*\d+/, 'qwen_send_max_chars = 65536')
        : qwenConfig + '\nqwen_send_max_chars = 65536\n';
      fs.writeFileSync(this.qwenUpstreamConfigFile, next, 'utf8');
    } catch (_) {}
  }

  _materializeAccount() {
    const account = this._settings();
    if (!account.username || !account.password) throw gatewayError('Configure the Qianwen gateway account first', 'qwen_gateway_not_configured', 409);
    fs.mkdirSync(path.dirname(this.accountCsv), { recursive: true });
    const email = account.username.includes('@') ? account.username : '';
    const phone = email ? '' : account.username;
    const csv = 'email,phone,password,area_code,name\n' + [email, phone, account.password, account.area_code || '', 'WebAgent'].map(csvCell).join(',') + '\n';
    fs.writeFileSync(this.accountCsv, csv, { encoding: 'utf8', mode: 0o600 });
    this.materialized.account = true;
  }

  async _materializeAuth() {
    const settings = this._settings();
    if (settings.username && settings.password) {
      this._materializeAccount();
      this.authSource = 'encrypted_account';
      return;
    }
    if (!this.getBrowserCredentials) throw gatewayError('Configure the Qwen gateway account or log in to Qwen Web first', 'qwen_gateway_not_configured', 409);
    const browser = await this.getBrowserCredentials();
    const cookies = browser && browser.cookies && typeof browser.cookies === 'object' ? browser.cookies : {};
    const token = String(browser && browser.token || cookies.token || '').trim();
    // Rogator targets chat.qwen.ai.  www.qianwen.com's tongyi_sso_ticket is a
    // different authentication realm and must never be advertised as a valid
    // gateway login: accepting it makes the sidecar look healthy until the
    // first generation fails with an SSE-wrapped Unauthorized error.
    if (!token || token.length < 20 || /\s/.test(token)) {
      throw gatewayError('Qianwen gateway requires a chat.qwen.ai login (the www.qianwen.com SSO session cannot authenticate this gateway)', 'qwen_gateway_browser_login_required', 401);
    }
    let payload = {};
    try {
      const value = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
      payload = JSON.parse(Buffer.from(value + '='.repeat((4 - value.length % 4) % 4), 'base64').toString('utf8'));
    } catch (_) {}
    if (payload.exp && Number(payload.exp) * 1000 <= Date.now() + 30000) throw gatewayError('The Qwen Web login token has expired; log in to Qwen Web again', 'qwen_gateway_browser_login_required', 401);
    const userId = String(browser.user_id || payload.user_id || payload.sub || payload.id || '').trim();
    const username = String(browser.username || (userId ? 'browser:' + userId : 'browser-session'));
    if (token && !cookies.token) cookies.token = token;
    const store = {
      // Browser cookies are injected by the wrapper. Keep token empty so
      // Rogator does not synthesize a conflicting token= cookie.
      sessions: [{ username, password: '', token: '', user_id: userId, upstream: 'qwen', login_time: Date.now() / 1000, is_valid: true }],
      current_index: 0,
      blocked_accounts: {},
      muted_accounts: {},
      updated_at: Date.now() / 1000
    };
    fs.mkdirSync(path.dirname(this.sessionFile), { recursive: true });
    fs.writeFileSync(this.sessionFile, JSON.stringify(store), { encoding: 'utf8', mode: 0o600 });
    this.materialized.session = true;
    fs.writeFileSync(this.browserCookieFile, JSON.stringify(cookies), { encoding: 'utf8', mode: 0o600 });
    this.materialized.cookies = true;
    this.authSource = 'qwen_web_cookie';
  }

  _removeMaterializedAuth() {
    try { if (this.materialized.account && fs.existsSync(this.accountCsv)) fs.unlinkSync(this.accountCsv); } catch (_) {}
    try { if (this.materialized.session && fs.existsSync(this.sessionFile)) fs.unlinkSync(this.sessionFile); } catch (_) {}
    try { if (this.materialized.cookies && fs.existsSync(this.browserCookieFile)) fs.unlinkSync(this.browserCookieFile); } catch (_) {}
    this.materialized = { account: false, session: false, cookies: false };
    this.authSource = '';
  }

  _log(chunk) {
    const lines = String(chunk || '').split(/\r?\n/).filter(Boolean);
    this.logs.push(...lines);
    if (this.logs.length > 300) this.logs.splice(0, this.logs.length - 300);
  }

  _baxiaFailure(details) {
    const message = String(details || '');
    if (/Baxia\s+SM\s+blocked|FAIL_SYS_USER_VALIDATE|RGV587_ERROR/i.test(message)) {
      this.baxiaFailures += 1;
      const cooldown = Math.min(10 * 60 * 1000, this.backoffBaseMs * Math.pow(2, Math.min(3, this.baxiaFailures - 1)));
      this.backoffUntil = Math.max(this.backoffUntil, Date.now() + cooldown);
      this.backoffReason = 'Qwen Baxia capacity validation blocked the current web session';
      this._log('[bridge-backoff] until=' + new Date(this.backoffUntil).toISOString() + ' delay_ms=' + cooldown + ' reason=baxia_capacity_validation');
      return gatewayError(
        'Qianwen Web is temporarily rejecting this account/session. WebAgent paused upstream requests to avoid extending the block.',
        'qwen_gateway_rate_limited',
        429
      );
    }
    return null;
  }

  _httpFailure(label, response, details) {
    const message = String(details || '');
    const baxia = this._baxiaFailure(message);
    if (baxia) return baxia;
    return gatewayError(label + ' returned HTTP ' + response.status + (message ? ': ' + message.slice(0, 500) : ''), 'qwen_gateway_request_failed', 502);
  }

  _wait(ms, signal) {
    if (!(ms > 0)) return Promise.resolve();
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (signal) signal.removeEventListener('abort', abort);
        if (error) reject(error); else resolve();
      };
      const abort = () => finish(Object.assign(new Error('Run cancelled'), { name: 'AbortError', code: 'run_cancelled' }));
      const timer = setTimeout(() => finish(), ms);
      if (signal) {
        if (signal.aborted) abort();
        else signal.addEventListener('abort', abort, { once: true });
      }
    });
  }

  async _acquireRequestLane(signal) {
    let unlock;
    let released = false;
    const current = new Promise((resolve) => { unlock = resolve; });
    const previous = this.requestLane.catch(() => {});
    this.requestLane = previous.then(() => current);
    this.queuedRequests += 1;
    try {
      await new Promise((resolve, reject) => {
        let settled = false;
        const finish = (error) => {
          if (settled) return;
          settled = true;
          if (signal) signal.removeEventListener('abort', abort);
          if (error) reject(error); else resolve();
        };
        const abort = () => finish(Object.assign(new Error('Run cancelled'), { name: 'AbortError', code: 'run_cancelled' }));
        if (signal && signal.aborted) abort();
        else {
          if (signal) signal.addEventListener('abort', abort, { once: true });
          previous.then(() => finish(), finish);
        }
      });
    } catch (error) {
      unlock();
      throw error;
    } finally {
      this.queuedRequests = Math.max(0, this.queuedRequests - 1);
    }
    return () => {
      if (released) return;
      released = true;
      // Streaming fetch resolves when response headers arrive, not when the
      // model finishes. Anchor a second quiet window to the completed Run so
      // the next short Harness turn cannot fire immediately after a long SSE
      // response drains.
      this.nextRequestAt = Math.max(this.nextRequestAt, Date.now() + this.minimumIntervalMs);
      unlock();
    };
  }

  async _pacedGatewayFetch(body, signal) {
    const due = Math.max(this.nextRequestAt, this.backoffUntil);
    await this._wait(Math.max(0, due - Date.now()), signal);
    try {
      return await this.fetch('http://127.0.0.1:' + this.port + '/v1/chat/completions', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal
      });
    } finally {
      // Pace from the end of every HTTP exchange, including action/repair
      // follow-ups inside the same Harness turn. This is intentionally more
      // conservative than merely spacing top-level Runs: very short tool
      // rounds are the burst pattern most likely to trip Baxia validation.
      this.nextRequestAt = Date.now() + this.minimumIntervalMs;
    }
  }

  async _waitForBackoff(signal, onStatus, attempt) {
    const delay = Math.max(0, this.backoffUntil - Date.now());
    if (!delay) return;
    if (onStatus) onStatus('千问网页触发限流，WebAgent 将在 ' + Math.ceil(delay / 1000) + ' 秒后自动重试（' + attempt + '/' + this.automaticRetries + '）…');
    this._log('[bridge-retry] attempt=' + attempt + ' wait_ms=' + delay);
    await this._wait(delay, signal);
  }

  _markGatewaySuccess() {
    this.backoffUntil = 0;
    this.backoffReason = '';
    this.baxiaFailures = 0;
  }

  async _postGatewayJson(body, signal, label, onStatus) {
    for (let attempt = 0; attempt <= this.automaticRetries; attempt += 1) {
      await this._waitForBackoff(signal, onStatus, attempt);
      const response = await this._pacedGatewayFetch(body, signal);
      let failure = null;
      let payload = null;
      if (!response.ok) {
        const details = await response.text().catch(() => '');
        this._log('[bridge-http] status=' + response.status + ' body=' + JSON.stringify(compactValue(details, 800)));
        failure = this._httpFailure(label, response, details);
      } else {
        payload = await response.json().catch(() => null);
        if (payload && payload.error) {
          const detail = typeof payload.error === 'string' ? payload.error : payload.error.message || payload.error.type || 'Unknown upstream error';
          failure = this._baxiaFailure(detail)
            || gatewayError(label + ' upstream error: ' + String(detail).slice(0, 500), 'qwen_gateway_request_failed', 502);
        }
      }
      if (!failure) {
        this._markGatewaySuccess();
        return payload;
      }
      if (failure.code !== 'qwen_gateway_rate_limited' || attempt >= this.automaticRetries) throw failure;
      await this._waitForBackoff(signal, onStatus, attempt + 1);
    }
    throw gatewayError(label + ' exhausted automatic retries', 'qwen_gateway_request_failed', 502);
  }

  async _postGatewayStream(body, signal, label, onStatus) {
    for (let attempt = 0; attempt <= this.automaticRetries; attempt += 1) {
      await this._waitForBackoff(signal, onStatus, attempt);
      const response = await this._pacedGatewayFetch(body, signal);
      if (response.ok) return { response, attempt };
      const details = await response.text().catch(() => '');
      this._log('[bridge-http] status=' + response.status + ' body=' + JSON.stringify(compactValue(details, 800)));
      const failure = this._httpFailure(label, response, details);
      if (failure.code !== 'qwen_gateway_rate_limited' || attempt >= this.automaticRetries) throw failure;
      await this._waitForBackoff(signal, onStatus, attempt + 1);
    }
    throw gatewayError(label + ' exhausted automatic retries', 'qwen_gateway_request_failed', 502);
  }

  async start() {
    if (this.process && this.process.exitCode == null) return this.status();
    if (this.starting) return this.starting;
    this.starting = this._start();
    try { return await this.starting; } finally { this.starting = null; }
  }

  async _start() {
    if (!fs.existsSync(path.join(this.source, 'main.py'))) throw gatewayError('Rogator is not installed', 'qwen_gateway_not_installed', 409);
    this.port = await findPort('127.0.0.1');
    this._writeLockedConfig(this.port);
    await this._materializeAuth();
    this.error = '';
    const entry = this.runner && fs.existsSync(this.runner) ? this.runner : 'main.py';
    const child = spawn(this.python, [entry], {
      cwd: this.source,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: Object.assign({}, process.env, { WEBAGENT_ROGATOR_SOURCE: this.source, WEBAGENT_QWEN_COOKIE_FILE: this.browserCookieFile })
    });
    this.process = child;
    child.stdout.on('data', (chunk) => this._log(chunk));
    child.stderr.on('data', (chunk) => this._log(chunk));
    child.once('error', (error) => { this.error = error.message; this._removeMaterializedAuth(); });
    child.once('exit', (code) => {
      if (code && !this.error) this.error = 'Rogator exited with code ' + code;
      if (this.process === child) this.process = null;
      this._removeMaterializedAuth();
    });
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      if (!this.process || this.process.exitCode != null) throw gatewayError(this.error || 'Rogator stopped during startup', 'qwen_gateway_start_failed');
      try {
        const response = await this.fetch('http://127.0.0.1:' + this.port + '/health', { signal: AbortSignal.timeout(1500) });
        if (response.ok) return this.status();
      } catch (_) {}
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    await this.stop();
    throw gatewayError('Rogator health check timed out', 'qwen_gateway_start_timeout');
  }

  async stop() {
    for (const controller of this.active.values()) controller.abort();
    this.active.clear();
    const child = this.process;
    if (child && child.exitCode == null) {
      child.kill();
      await Promise.race([
        new Promise((resolve) => child.once('exit', resolve)),
        new Promise((resolve) => setTimeout(resolve, 5000))
      ]);
      if (child.exitCode == null) child.kill('SIGKILL');
    }
    if (this.process === child) this.process = null;
    this.port = null;
    this._removeMaterializedAuth();
    return this.status();
  }

  async complete(context) {
    if (!this.process || this.process.exitCode != null) await this.start();
    const controller = new AbortController();
    let releaseLane = null;
    const runId = context.run && context.run.id || 'gateway-' + Date.now();
    const abort = () => controller.abort();
    if (context.signal) {
      if (context.signal.aborted) abort();
      else context.signal.addEventListener('abort', abort, { once: true });
    }
    this.active.set(runId, controller);
    try {
      releaseLane = await this._acquireRequestLane(controller.signal);
      const settings = this._settings();
      const promptPassthrough = !!(context.run && context.run.prompt_passthrough);
      const providerToolDefinitions = promptPassthrough ? context.run.provider_tools : context.gateway_tools;
      const gatewayTools = openAITools(providerToolDefinitions);
      const compatibility = providerToolCompatibility(providerToolDefinitions);
      // Rogator injects OpenAI function schemas into Qwen's provider protocol
      // and returns invocations to us; it does not execute them. Keep this
      // channel enabled for DSH. If it is disabled, Qwen's account-level ENTML
      // instruction still encourages tool syntax, but Rogator has no schema to
      // parse against and the webpage model can loop on "Tool ... does not
      // exists" instead of returning control to Harness.
      const upstreamTools = compatibility.upstream;
      const localToolBoundary = gatewayTools.length
        ? (promptPassthrough
          ? 'The supplied functions operate on the local Harness workspace. Harness executes them and returns their results.'
          : 'Qianwen provider-native tools (especially code_interpreter) run in a remote cloud sandbox and MUST NOT be used for this request. They cannot see the local workspace. Use only the function tools explicitly supplied with this API request; WebAgent will execute them locally and return their results.')
        : '';
      let messages;
      if (gatewayTools.length) {
        if (promptPassthrough) {
          messages = dshGatewayMessages(context);
        } else {
          messages = runtimeGatewayMessages(context, localToolBoundary);
        }
      } else {
        messages = [];
        const instructions = [context.instructions, localToolBoundary].filter(Boolean).join('\n\n');
        if (instructions) messages.push({ role: 'system', content: instructions });
        for (const message of context.messages || []) messages.push(message);
      }
      const body = {
        model: upstreamModel(context.model, settings.model),
        messages,
        // Qwen's streaming web endpoint keeps consuming native function
        // events after a call and may execute them in its remote sandbox.
        // The non-streaming Rogator path stops correctly at finish_reason
        // tool_calls, so use it only for agent rounds. Text-only chat keeps
        // the existing incremental reasoning/answer stream.
        stream: upstreamTools.length === 0,
        // A real tool list gives Qwen its familiar function vocabulary. The
        // compatibility compiler maps aliases such as code_interpreter back
        // to canonical DSH tools before Harness performs local execution.
        tools: upstreamTools,
        // Respect the selected reasoning effort on every agent round. Qwen
        // 3.8 may occasionally finish a reasoning phase without an action;
        // the one-shot action retry below handles that case without silently
        // disabling reasoning for the rest of a long debugging session.
        reasoning_effort: context.run && context.run.reasoning_effort
          || (context.run && context.run.deep_think ? 'low' : 'none')
      };
      if (context.onStatus) context.onStatus('Qianwen 网关正在生成回复…');
      if (!body.stream) {
        let payload = await this._postGatewayJson(body, controller.signal, 'Qianwen gateway', context.onStatus);
        let message = payload && payload.choices && payload.choices[0] && payload.choices[0].message || {};
        const firstCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
        const firstContent = String(message.content || '').trim();
        // At high reasoning efforts Qwen's webpage bridge can finish the
        // planning phase with reasoning only and no action. That is not a DSH
        // turn completion. Transparently request the action phase once with
        // reasoning disabled, preserving the selected model and full history.
        if (!firstContent && !firstCalls.length) {
          if (context.onStatus) context.onStatus('Qianwen 网关已完成规划，正在生成工具动作…');
          const actionBody = { ...body, reasoning_effort: 'none' };
          payload = await this._postGatewayJson(actionBody, controller.signal, 'Qianwen gateway action retry', context.onStatus);
          message = payload && payload.choices && payload.choices[0] && payload.choices[0].message || {};
        }
        let normalized = normalizedProviderMessage(message, providerToolDefinitions, promptPassthrough);
        if (promptPassthrough) {
          const attemptedNames = Array.from(new Set((Array.isArray(message && message.tool_calls) ? message.tool_calls : [])
            .map((call) => String(call && call.function && call.function.name || call && call.name || '').trim())
            .filter(Boolean)));
          this._log('[bridge] calls=' + JSON.stringify(attemptedNames)
            + ' content_chars=' + String(message && message.content || '').length
            + ' recovered=' + Boolean(normalized.recovered)
            + ' unsupported=' + JSON.stringify(normalized.attempt.unsupported)
            + (normalized.attempt.hasWireSyntax && !normalized.recovered
              ? ' wire=' + JSON.stringify(compactValue(String(message && message.content || ''), 500))
              : ''));
        }
        // Do not leak malformed or unavailable provider-native syntax into
        // DSH as assistant prose. Give Qwen one action-only repair round
        // against the same advertised OpenAI schemas. This is a transport
        // correction, not another Harness prompt or a reordered user task.
        if (promptPassthrough && normalized.attempt.hasWireSyntax && !normalized.recovered) {
          const allowed = upstreamTools.map((tool) => tool.function.name).join(', ');
          const rejected = normalized.attempt.unsupported.join(', ') || 'malformed provider tool syntax';
          if (context.onStatus) context.onStatus('Qianwen 网关正在纠正不可用的云端工具调用…');
          const repairBody = {
            ...body,
            reasoning_effort: 'none',
            messages: [...body.messages, {
              role: 'user',
              content: 'Transport correction: the preceding response attempted an unavailable function (' + rejected + '). Continue the pending task with one supplied function call: ' + allowed + '. Do not print function wire syntax as text.'
            }]
          };
          const repairPayload = await this._postGatewayJson(repairBody, controller.signal, 'Qianwen gateway tool repair', context.onStatus);
          message = repairPayload && repairPayload.choices && repairPayload.choices[0] && repairPayload.choices[0].message || {};
          normalized = normalizedProviderMessage(message, providerToolDefinitions, promptPassthrough);
          const repairNames = Array.from(new Set((Array.isArray(message && message.tool_calls) ? message.tool_calls : [])
            .map((call) => String(call && call.function && call.function.name || call && call.name || '').trim())
            .filter(Boolean)));
          this._log('[bridge-repair] calls=' + JSON.stringify(repairNames)
            + ' content_chars=' + String(message && message.content || '').length
            + ' recovered=' + Boolean(normalized.recovered)
            + ' unsupported=' + JSON.stringify(normalized.attempt.unsupported)
            + (!normalized.recovered
              ? ' wire=' + JSON.stringify(compactValue(String(message && message.content || ''), 500))
              : ''));
          if (normalized.attempt.hasWireSyntax && !normalized.recovered) {
            const invalid = normalized.attempt.unsupported.join(', ') || 'malformed provider tool syntax';
            const wire = compactValue(JSON.stringify({
              tool_calls: Array.isArray(message && message.tool_calls) ? message.tool_calls : [],
              content: String(message && message.content || '')
            }), 1200);
            throw gatewayError('Qianwen gateway repeated an unavailable tool call after protocol repair: ' + invalid + '; wire=' + wire, 'qwen_gateway_unavailable_tool', 502);
          }
        }
        const content = normalized.content;
        const reasoning = String(message.reasoning_content || message.reasoning || '');
        if (reasoning && context.onReasoningProgress) context.onReasoningProgress(reasoning);
        if (content && context.onProgress) context.onProgress(content);
        if (!content.trim()) throw gatewayError('Qianwen gateway returned an empty response', 'empty_response', 502);
        return { content, reasoning, provider_state: { provider: 'rogator', upstream: 'qwen', url: '', last_run_id: runId, last_call_id: context.run && context.run.call_id || null } };
      }
      let { response } = await this._postGatewayStream(body, controller.signal, 'Qianwen gateway', context.onStatus);
      let content = '';
      let reasoning = '';
      let streamError = null;
      let toolCalls = new Map();
      let pending = '';
      let decoder = new TextDecoder();
      const consume = (line) => {
        const value = line.trim();
        if (!value.startsWith('data:')) return;
        const raw = value.slice(5).trim();
        if (!raw || raw === '[DONE]') return;
        let event;
        try { event = JSON.parse(raw); } catch (_) { return; }
        if (event && event.error) {
          const detail = typeof event.error === 'string' ? event.error : event.error.message || event.error.type || 'Unknown upstream error';
          const baxia = this._baxiaFailure(detail);
          if (baxia) {
            streamError = baxia;
            return;
          }
          const numericCode = Number(event.error.code || 0);
          const authFailure = numericCode === 401 || numericCode === 403 || numericCode === 429 || /token expired|unauthori[sz]ed|login|auth/i.test(detail);
          streamError = gatewayError(
            'Qianwen gateway upstream error: ' + String(detail).slice(0, 500),
            authFailure ? 'qwen_gateway_browser_login_required' : 'qwen_gateway_request_failed',
            authFailure ? 401 : 502
          );
          return;
        }
        const delta = event && event.choices && event.choices[0] && event.choices[0].delta || {};
        appendToolCallDelta(toolCalls, delta);
        const reasoningDelta = typeof delta.reasoning === 'string' ? delta.reasoning : delta.reasoning_content;
        if (typeof reasoningDelta === 'string') {
          reasoning += reasoningDelta;
          if (context.onReasoningProgress) context.onReasoningProgress(reasoning);
        }
        if (typeof delta.content === 'string' && delta.content) {
          content += delta.content;
          if (context.onProgress) context.onProgress(content);
        }
      };
      let sseRetries = 0;
      while (true) {
        for await (const chunk of response.body) {
          pending += decoder.decode(chunk, { stream: true });
          const lines = pending.split(/\r?\n/);
          pending = lines.pop() || '';
          for (const line of lines) consume(line);
        }
        pending += decoder.decode();
        if (pending) consume(pending);
        const cleanRateLimit = streamError && streamError.code === 'qwen_gateway_rate_limited'
          && !content && !reasoning && toolCalls.size === 0;
        if (cleanRateLimit && sseRetries < this.automaticRetries) {
          sseRetries += 1;
          await this._waitForBackoff(controller.signal, context.onStatus, sseRetries);
          ({ response } = await this._postGatewayStream(body, controller.signal, 'Qianwen gateway', context.onStatus));
          streamError = null;
          pending = '';
          decoder = new TextDecoder();
          toolCalls = new Map();
          continue;
        }
        if (streamError) throw streamError;
        this._markGatewaySuccess();
        break;
      }
      const fences = toolCallFences(toolCalls, providerToolDefinitions);
      if (fences) content = content.trimEnd() + (content.trim() ? '\n\n' : '') + fences;
      const textualFences = promptPassthrough ? dshTextToolFences(content, providerToolDefinitions) : '';
      if (textualFences) content = textualFences;
      if (!content.trim()) throw gatewayError('Qianwen gateway returned an empty response', 'empty_response', 502);
      return { content, reasoning, provider_state: { provider: 'rogator', upstream: 'qwen', url: '', last_run_id: runId, last_call_id: context.run && context.run.call_id || null } };
    } catch (error) {
      if (controller.signal.aborted) throw Object.assign(new Error('Run cancelled'), { name: 'AbortError', code: 'run_cancelled' });
      throw error;
    } finally {
      if (releaseLane) releaseLane();
      this.active.delete(runId);
      if (context.signal) context.signal.removeEventListener('abort', abort);
    }
  }

  stopRun(runId) {
    const controller = this.active.get(runId);
    if (!controller) return false;
    controller.abort();
    return true;
  }

  close() { return this.stop(); }
}

module.exports = {
  RogatorService, ROGATOR_REPOSITORY, ROGATOR_REVISION, DEFAULT_UPSTREAM_MODEL,
  QWEN_GATEWAY_REASONING_EFFORTS, ROGATOR_MODELS, dshGatewayMessages,
  compactExecutedMutationArguments,
  runtimeGatewayMessages, gatewayModels, upstreamModel, openAITools,
  providerToolCompatibility, compileProviderToolCall,
  appendToolCallDelta, toolCallFences, residualQwenToolFence, dshTextToolFences,
  normalizeStructuredArguments
};
