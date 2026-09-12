'use strict';

const http = require('http');
const crypto = require('crypto');
const { URL } = require('url');
const { id } = require('./ids');
const { parseToolCalls } = require('../../tool-loop');
const { parseDsmlCalls, dsmlMarkerIndex } = require('./deepseek-dsml');
const { estimateTokens } = require('./context-manager');
const { continuationEnvelope } = require('./dsh-web-codec');
const dirtyJson = require('dirty-json');

// Keep only enough uncommitted text to recognize a split Markdown/DSH opener.
// The former 256-character guard delayed short answers until they were almost
// complete, which defeated the purpose of SSE for normal webpage responses.
const STREAM_GUARD_CHARS = 64;
const STREAM_CHUNK_CHARS = 128;

function estimateContentTokens(content, seenImages) {
  if (typeof content === 'string') return estimateTokens(content);
  if (!Array.isArray(content)) return estimateTokens(JSON.stringify(content == null ? '' : content));
  let total = 0;
  for (const part of content) {
    if (!part || typeof part !== 'object') { total += estimateTokens(String(part || '')); continue; }
    if (part.type === 'text' || part.type === 'input_text' || part.type === 'output_text') {
      total += estimateTokens(part.text || '');
      continue;
    }
    if (part.type === 'image' || part.type === 'input_image' || part.type === 'image_url' || part.image_url || part.data) {
      // Base64 is transport, not prompt text. The webpage does not report its
      // visual-token charge, so use one explicit conservative image estimate.
      const fingerprint = imagePartFingerprint(part);
      if (!seenImages || !seenImages.has(fingerprint)) {
        if (seenImages) seenImages.add(fingerprint);
        total += 1024;
      }
      continue;
    }
    total += estimateTokens(JSON.stringify(part));
  }
  return total;
}

function estimateInputTokens(messages, tools, instructions, model) {
  const rows = Array.isArray(messages) ? messages : [];
  const seenImages = new Set();
  let total = instructions ? estimateTokens(instructions) + 4 : 0;
  for (const message of rows) {
    total += 6;
    total += estimateTokens(message && message.role || '');
    total += estimateContentTokens(message && message.content, seenImages);
    if (message && message.name) total += estimateTokens(message.name) + 1;
    if (message && message.tool_calls) total += estimateTokens(JSON.stringify(message.tool_calls));
  }
  if (Array.isArray(tools) && tools.length) total += estimateTokens(JSON.stringify(tools)) + 8;
  // Calibrated against DeepSeek V4's published tokenizer.json on the complete
  // DSH standard prompt + 28-tool catalog. The generic chars/token heuristic
  // was about 16% high on that representative request.
  if (String(model || '').startsWith('deepseek.')) total = Math.ceil(total * 0.86);
  return Math.max(1, total);
}

function isHarnessTitleRequest(body) {
  if (!body || (Array.isArray(body.tools) && body.tools.length)) return false;
  const maxTokens = Number(body.max_tokens || body.max_completion_tokens || 0);
  if (maxTokens && maxTokens > 128) return false;
  const text = (Array.isArray(body.messages) ? body.messages : [])
    .map((message) => typeof message.content === 'string' ? message.content : JSON.stringify(message.content || ''))
    .join('\n');
  return /Create a concise title for an AI coding-assistant session|Generate the session title from this JSON array/i.test(text);
}

function estimatedUsage(inputTokens, output, reasoning, shape, cachedTokens) {
  const outputTokens = Math.max(1, estimateTokens(String(reasoning || '') + '\n' + String(output || '')));
  const input = Math.max(1, Number(inputTokens) || 1);
  const cached = Math.max(0, Math.min(input, Number(cachedTokens) || 0));
  return shape === 'responses'
    ? { input_tokens: input, output_tokens: outputTokens, total_tokens: input + outputTokens, input_tokens_details: { cached_tokens: cached } }
    : { prompt_tokens: input, completion_tokens: outputTokens, total_tokens: input + outputTokens, prompt_tokens_details: { cached_tokens: cached } };
}

function imagePartFingerprint(part) {
  if (!part || typeof part !== 'object') return '';
  let mime = String(part.mimeType || part.mime_type || 'image/png').toLowerCase();
  let data = part.data || (part.image_url && (part.image_url.url || part.image_url)) || part.url || '';
  const match = /^data:([^;,]+);base64,([A-Za-z0-9+/=\r\n]+)$/.exec(String(data));
  if (match) { mime = match[1].toLowerCase(); data = match[2].replace(/\s/g, ''); }
  if (!data) return '';
  return crypto.createHash('sha256').update(mime).update('\0').update(String(data)).digest('hex');
}

function estimateHarnessCachedTokens(body, session, inputTokens) {
  const bridge = session && session.provider_state && session.provider_state.dsh_bridge;
  if (!bridge || bridge.version !== 3 || !session.provider_state.url) return 0;
  try {
    const envelope = continuationEnvelope(body.messages, toolDefinitions(body.tools), bridge);
    let fresh = estimateTokens(envelope.text);
    const seen = new Set(Array.isArray(bridge.uploaded_image_hashes) ? bridge.uploaded_image_hashes : []);
    for (const message of envelope.envelopeMessages || []) {
      for (const part of Array.isArray(message && message.content) ? message.content : []) {
        const fingerprint = imagePartFingerprint(part);
        if (!fingerprint || seen.has(fingerprint)) continue;
        seen.add(fingerprint);
        fresh += 1024;
      }
    }
    if (String(body.model || '').startsWith('deepseek.')) fresh = Math.ceil(fresh * 0.86);
    return Math.max(0, Math.min(inputTokens, inputTokens - Math.max(1, fresh)));
  } catch (_) {
    return 0;
  }
}

function parseBridgeCall(raw) {
  const source = String(raw || '').trim();
  try { return JSON.parse(source); }
  catch (_) {
    // Web models sometimes put a JavaScript/regex escape such as `\$` or
    // `\(` directly inside a JSON string. JSON requires the backslash itself
    // to be escaped. Repair only those invalid escapes, and only in strings.
    const repaired = repairInvalidJsonEscapes(source);
    if (repaired !== source) {
      try { return JSON.parse(repaired); } catch (_) {}
    }
    // DeepSeek occasionally closes a flattened fenced call with one extra
    // brace (`{"command":"...","name":"pwsh"}}`). Remove only surplus
    // trailing closers, and accept the result only if strict JSON parsing then
    // succeeds. Allowlisting and the advertised JSON Schema still apply later.
    for (const candidate of new Set([source, repaired])) {
      const closers = (candidate.match(/[}\]]+$/) || [''])[0].length;
      for (let count = 1; count <= Math.min(4, closers); count += 1) {
        try {
          const parsed = JSON.parse(candidate.slice(0, -count));
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
        } catch (_) {}
      }
    }
    // Repair syntax as data only. Tool allowlisting below and DSH's JSON
    // Schema validation still run before anything reaches an executor.
    try {
      const parsed = dirtyJson.parse(source);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
    } catch (_) { return null; }
  }
}

function repairInvalidJsonEscapes(value) {
  const source = String(value || '');
  let output = '';
  let inString = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (char === '"') {
      let slashes = 0;
      for (let cursor = index - 1; cursor >= 0 && source[cursor] === '\\'; cursor -= 1) slashes += 1;
      if (slashes % 2 === 0) inString = !inString;
      output += char;
      continue;
    }
    if (inString && char === '\\') {
      const next = source[index + 1] || '';
      if (!/["\\/bfnrtu]/.test(next)) output += '\\';
    }
    output += char;
  }
  return output;
}

function bridgeCallPayloads(output) {
  const payloads = [];
  // DeepSeek's Markdown renderer can preserve an opening custom tag while
  // consuming its closing tag as DOM. The next opening tag (or stream end) is
  // therefore also a valid boundary, but only a successfully parsed payload
  // is ever accepted by bridgedToolCalls.
  const pattern = /<dsh[-_]tool[-_]call>\s*([\s\S]*?)(?=<\/dsh[-_]tool[-_]call>|<dsh[-_]tool[-_]call>|$)/gi;
  let match;
  const source = String(output || '');
  for (const call of parseDsmlCalls(source)) payloads.push({ index: call.index, payload: JSON.stringify({ name: call.name, arguments: call.arguments }) });
  while ((match = pattern.exec(source)) !== null) payloads.push({ index: match.index, payload: match[1].trim() });
  // The webpage Markdown renderer may promote a three-backtick fence to four
  // backticks when the JSON argument itself contains Markdown fences. Match
  // the exact opening fence width and only close on a real line boundary;
  // otherwise embedded ``` sequences inside JSON string values truncate the
  // payload before it reaches DSH's schema validator.
  const fence = /(?:^|\n)(`{3,})dsh[-_]tool[-_]call[^\S\r\n]*\r?\n([\s\S]*?)\r?\n\1(?=[^\S\r\n]*(?:\r?\n|$))/gi;
  while ((match = fence.exec(source)) !== null) payloads.push({ index: match.index, payload: match[2].trim() });
  return payloads.sort((a, b) => a.index - b.index).map((item) => item.payload);
}

function toolDefinitions(tools) {
  return (Array.isArray(tools) ? tools : []).map((item) => item && item.type === 'function' ? item.function : item)
    .filter((item) => item && typeof item.name === 'string')
    .map((item) => ({ name: item.name, description: item.description || '', parameters: item.parameters || { type: 'object', properties: {} } }));
}

function normalizeBridgeArguments(name, args, definition) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return args;
  const schema = definition && definition.parameters && typeof definition.parameters === 'object'
    ? definition.parameters
    : {};
  const properties = schema.properties && typeof schema.properties === 'object' ? schema.properties : {};
  const required = Array.isArray(schema.required) ? schema.required : [];
  // Qwen gateway models occasionally use the descriptive `skill_name` key
  // even though DSH's Skill tool schema calls the field `name`. Repair this
  // one unambiguous compatibility alias only when the advertised schema
  // explicitly requires `name`; never invent a value or broaden the tool
  // allowlist.
  let normalized = args;
  const toolName = String(name || '').toLowerCase();
  if (toolName === 'skill'
      && required.includes('name')
      && Object.prototype.hasOwnProperty.call(properties, 'name')
      && args.name == null) {
    const aliases = ['skill_name', 'skillName'].filter((key) => args[key] != null);
    if (aliases.length === 1) {
      normalized = Object.assign({}, args, { name: args[aliases[0]] });
      delete normalized[aliases[0]];
    }
  }
  // DSH's DSML `string=true` is intentionally raw. Web models nevertheless
  // sometimes JSON-escape an entire multi-line file before placing it in that
  // raw field, leaving dozens of literal `\n` sequences in the written file.
  // Repair only an advertised write-content field, and only when the strong
  // multi-line signature is present. Commands and paths must keep backslashes.
  const contentSchema = properties.content;
  const content = normalized.content;
  if ((toolName === 'write' || toolName === 'write_file')
      && contentSchema && contentSchema.type === 'string'
      && typeof content === 'string' && !/[\r\n]/.test(content)
      && (content.match(/\\(?:r\\n|n)/g) || []).length >= 2) {
    normalized = Object.assign({}, normalized, {
      content: content.replace(/\\r\\n/g, '\n').replace(/\\n/g, '\n').replace(/\\r/g, '\r').replace(/\\t/g, '\t')
    });
  }
  return normalized;
}

function bridgeArguments(call, definition) {
  if (call.arguments !== undefined) return call.arguments;
  if (call.params !== undefined) return call.params;
  const properties = definition && definition.parameters && definition.parameters.properties && typeof definition.parameters.properties === 'object'
    ? definition.parameters.properties
    : {};
  const flattened = {};
  for (const [key, value] of Object.entries(call || {})) {
    if (['name', 'tool', 'arguments', 'params', 'type', 'id'].includes(key)) continue;
    if (Object.keys(properties).length && !Object.prototype.hasOwnProperty.call(properties, key)) continue;
    flattened[key] = value;
  }
  return flattened;
}

function bridgedToolCalls(output, tools) {
  const definitions = toolDefinitions(tools);
  const byName = new Map(definitions.map((item) => [item.name, item]));
  const allowed = new Set(byName.keys());
  const tagged = [];
  for (const payload of bridgeCallPayloads(output)) {
    try {
      const call = parseBridgeCall(payload);
      if (!call || typeof call !== 'object' || Array.isArray(call)) continue;
      const name = String(call && (call.name || call.tool) || '');
      if (!allowed.has(name)) continue;
      let args = bridgeArguments(call, byName.get(name));
      if (typeof args !== 'string') args = normalizeBridgeArguments(name, args, byName.get(name));
      tagged.push({
        id: id('call'),
        type: 'function',
        function: { name, arguments: typeof args === 'string' ? args : JSON.stringify(args || {}) }
      });
    } catch (_) {
      // A malformed bridge block is left as model text and never executed.
    }
  }
  if (tagged.length) return tagged;
  return parseToolCalls(String(output || '')).commands.filter((command) => allowed.has(command.tool)).map((command) => ({
    id: id('call'),
    type: 'function',
    function: { name: command.tool, arguments: command.content || '{}' }
  }));
}

function toolCallMarkerIndex(output) {
  const text = String(output || '');
  const markers = [/<dsh[-_]tool[-_]call>/i, /`{3,}dsh[-_]tool[-_]call/i, /(?:^|\n)\s*(?:\*\*)?Calling(?:(?:\*\*)?\s+`?[a-zA-Z0-9_-]+`?\s+(?:with|using)|:)/i, /```(?:json|text)?\s*\[\s*\{\s*"(?:name|tool)"/i, /<(?:function_calls?|tool_calls?|tool_call|dsml_tool_calls?|dsml_invoke|invoke)\b/i]
    .map((pattern) => text.search(pattern)).filter((index) => index >= 0);
  const dsml = dsmlMarkerIndex(text);
  if (dsml >= 0) markers.push(dsml);
  return markers.length ? Math.min(...markers) : -1;
}

function contentBeforeToolCalls(output) {
  const text = String(output || '');
  const marker = toolCallMarkerIndex(text);
  return (marker >= 0 ? text.slice(0, marker) : text).trim() || null;
}

function requestedReasoningEffort(body) {
  if (!body || typeof body !== 'object') return 'none';
  let value = body.reasoning_effort != null ? body.reasoning_effort : body.thinking_level;
  if (value == null && typeof body.reasoning === 'string') value = body.reasoning;
  if (body.reasoning && typeof body.reasoning === 'object') {
    value = body.reasoning.effort != null ? body.reasoning.effort : body.reasoning.level != null ? body.reasoning.level : value;
    if (value == null && body.reasoning.enabled != null) value = body.reasoning.enabled ? 'medium' : 'none';
  }
  if (body.thinking && typeof body.thinking === 'object') {
    value = body.thinking.effort != null ? body.thinking.effort : body.thinking.level != null ? body.thinking.level : value;
    if (value == null && (body.thinking.type === 'enabled' || body.thinking.enabled === true)) value = 'medium';
    if (value == null && (body.thinking.type === 'disabled' || body.thinking.enabled === false)) value = 'none';
  }
  if (value == null && body.deep_think) value = 'low';
  const effort = String(value == null ? 'none' : value).trim().toLowerCase();
  return ({ off: 'none', disabled: 'none', default: 'medium', enabled: 'medium' })[effort] || effort;
}

function reasoningRequested(body) {
  const effort = requestedReasoningEffort(body);
  return effort !== 'off' && effort !== 'none';
}

function commonPrefixLength(left, right) {
  const limit = Math.min(left.length, right.length);
  let index = 0;
  while (index < limit && left.charCodeAt(index) === right.charCodeAt(index)) index += 1;
  return index;
}

// SSE is append-only, while a webpage Markdown renderer is not: during a
// response it can expose an opening fence first and later insert the closing
// fence before already-visible prose. Once the opening fence has been sent,
// clients such as DSH cannot retract it and render the rest of the answer as
// code. Return only the prefix whose fenced code and display-math blocks are
// structurally closed. Ordinary prose continues to stream immediately.
function stableMarkdownPrefixLength(value, requestedEnd) {
  const source = String(value || '');
  const end = Math.max(0, Math.min(source.length, requestedEnd == null ? source.length : requestedEnd));
  let fence = null;
  let displayMathStart = -1;
  let lineStart = 0;

  while (lineStart < end) {
    let lineEnd = source.indexOf('\n', lineStart);
    if (lineEnd < 0 || lineEnd >= end) lineEnd = end;
    const line = source.slice(lineStart, lineEnd);
    const fenceMatch = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);

    if (fence) {
      if (fenceMatch && fenceMatch[1][0] === fence.char && fenceMatch[1].length >= fence.width && !fenceMatch[2].trim()) fence = null;
    } else if (fenceMatch) {
      fence = { char: fenceMatch[1][0], width: fenceMatch[1].length, start: lineStart };
    } else {
      for (let index = 0; index + 1 < line.length; index += 1) {
        if (line[index] !== '$' || line[index + 1] !== '$') continue;
        let slashes = 0;
        for (let cursor = index - 1; cursor >= 0 && line[cursor] === '\\'; cursor -= 1) slashes += 1;
        if (slashes % 2) continue;
        if (displayMathStart < 0) displayMathStart = lineStart + index;
        else displayMathStart = -1;
        index += 1;
      }
    }

    lineStart = lineEnd < end ? lineEnd + 1 : end;
  }

  if (fence) return Math.min(end, fence.start);
  if (displayMathStart >= 0) return Math.min(end, displayMathStart);
  return end;
}

function json(res, status, body, headers) {
  res.writeHead(status, Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, headers || {}));
  res.end(JSON.stringify(body));
}

function apiError(error) {
  const code = error.code || 'server_error';
  const rawMessage = error.message || String(error);
  const message = code === 'provider_busy' && !/\b503\b/.test(rawMessage) ? 'HTTP 503: ' + rawMessage : rawMessage;
  return {
    error: {
      message,
      type: code,
      param: error.param || null,
      code,
      ...(error.retry_after_seconds ? { retry_after_seconds: Number(error.retry_after_seconds) } : {})
    }
  };
}

function completedRunErrorStatus(error) {
  const code = String(error && error.code || '');
  if (code === 'qwen_gateway_rate_limited' || code === 'rate_limit_exceeded' || code === 'out_of_usage') return 429;
  if (code === 'context_length_exceeded') return 400;
  if (code === 'provider_busy') return 503;
  if (code === 'qwen_gateway_browser_login_required' || code === 'provider_login_required') return 401;
  return 500;
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > limit) req.destroy(Object.assign(new Error('Request body too large'), { code: 'request_too_large', status: 413 }));
    });
    req.on('end', () => {
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); }
      catch (_) { reject(Object.assign(new Error('Invalid JSON body'), { code: 'invalid_json', status: 400 })); }
    });
    req.on('error', reject);
  });
}

function harnessSessionId(externalId) {
  const value = String(externalId || '').trim();
  if (!value) return null;
  return 'harness_' + crypto.createHash('sha256').update(value).digest('hex').slice(0, 40);
}

class RuntimeApiServer {
  constructor(options) {
    this.store = options.store;
    this.runs = options.runs;
    this.providers = options.providers;
    this.capabilities = options.capabilities || null;
    this.config = options.config || null;
    this.tools = options.tools || null;
    this.approvals = options.approvals || null;
    this.mobile = options.mobile || null;
    this.bots = options.bots || null;
    this.providerConfigs = options.providerConfigs || null;
    this.contextManager = options.contextManager || null;
    this.workMemory = options.workMemory || null;
    this.harness = options.harness || null;
    this.rogator = options.rogator || null;
    this.modelApi = options.modelApi || null;
    this.token = options.token;
    this.host = '127.0.0.1';
    this.startPort = options.port === 0 ? 0 : (Number(options.port) || 5858);
    this.port = null;
    this.server = http.createServer(this._handle.bind(this));
  }

  async start() {
    const ports = this.startPort === 0
      ? [0]
      : Array.from({ length: 100 }, (_, index) => this.startPort + index);
    for (const port of ports) {
      try {
        await new Promise((resolve, reject) => {
          const onError = (error) => { this.server.removeListener('listening', onListening); reject(error); };
          const onListening = () => { this.server.removeListener('error', onError); resolve(); };
          this.server.once('error', onError);
          this.server.once('listening', onListening);
          this.server.listen(port, this.host);
        });
        const address = this.server.address();
        this.port = address && typeof address === 'object' ? address.port : port;
        return { host: this.host, port: this.port };
      } catch (error) {
        if (!['EADDRINUSE', 'EACCES'].includes(error.code)) throw error;
        this.server = http.createServer(this._handle.bind(this));
      }
    }
    throw new Error('No available runtime port');
  }

  async close() {
    if (!this.server.listening) return;
    if (typeof this.server.closeAllConnections === 'function') this.server.closeAllConnections();
    await new Promise((resolve) => this.server.close(resolve));
  }

  _authorized(req) {
    if (req.url === '/api/ping' || req.url === '/health') return true;
    const bearer = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    return !!this.token && bearer === this.token;
  }

  async _handle(req, res) {
    try {
      if (!this._authorized(req)) return json(res, 401, apiError(Object.assign(new Error('Invalid runtime token'), { code: 'invalid_api_key' })));
      const url = new URL(req.url, 'http://127.0.0.1');
      // DSH's pi-ai adapter emits its stable sessionId as prompt_cache_key only
      // for OpenAI-looking endpoints.  This local alias enables that standard
      // request field without changing the actual loopback destination.
      const path = url.pathname.replace(/^\/api\.openai\.com(?=\/)/, '');
      if (req.method === 'GET' && (path === '/api/ping' || path === '/health')) {
        return json(res, 200, { ok: true, product: 'WebAgent', version: 2, pid: process.pid, workers: this.providers.status() });
      }
      if (req.method === 'GET' && path === '/v1/models') {
        return json(res, 200, { object: 'list', data: this.providers.listModels() });
      }
      if (path === '/api/webapp' && this.webapp && req.method === 'GET') {
        return json(res, 200, this.webapp.status());
      }
      if (path === '/api/webapp/ticket' && this.webapp && req.method === 'POST') {
        return json(res, 201, this.webapp.issueBootstrapTicket());
      }
      if (path === '/api/model-api' && this.modelApi) {
        if (req.method === 'GET') return json(res, 200, this.modelApi.status());
        if (req.method === 'PATCH') return json(res, 200, await this.modelApi.configure(await readBody(req, 1024 * 1024)));
      }
      if (path === '/api/model-api/start' && this.modelApi && req.method === 'POST') {
        return json(res, 200, await this.modelApi.start(await readBody(req, 1024 * 1024)));
      }
      if (path === '/api/model-api/stop' && this.modelApi && req.method === 'POST') {
        return json(res, 200, await this.modelApi.stop());
      }
      if (path === '/api/model-api/token' && this.modelApi && req.method === 'POST') {
        return json(res, 200, await this.modelApi.resetToken());
      }
      if (req.method === 'GET' && path === '/api/providers') {
        return json(res, 200, { object: 'list', data: this.providers.supportedWebProviders().map((id) => ({ id, type: 'web', status: this.providers.status()[id] })) });
      }
      if (path === '/api/qwen-gateway' && this.rogator) {
        if (req.method === 'GET') return json(res, 200, this.rogator.status());
      }
      if (path === '/api/qwen-gateway/install' && this.rogator && req.method === 'POST') {
        return json(res, 200, await this.rogator.install());
      }
      if (path === '/api/qwen-gateway/account' && this.rogator && req.method === 'POST') {
        return json(res, 200, await this.rogator.setAccount(await readBody(req, 1024 * 1024)));
      }
      if (path === '/api/qwen-gateway/login' && this.rogator && req.method === 'POST') {
        return json(res, 200, await this.rogator.login());
      }
      if (path === '/api/qwen-gateway/start' && this.rogator && req.method === 'POST') {
        return json(res, 200, await this.rogator.start());
      }
      if (path === '/api/qwen-gateway/stop' && this.rogator && req.method === 'POST') {
        return json(res, 200, await this.rogator.stop());
      }
      const providerAccountsMatch = path.match(/^\/api\/providers\/([^/]+)\/accounts$/);
      if (providerAccountsMatch && req.method === 'GET') return json(res, 200, this.providers.listAccounts(decodeURIComponent(providerAccountsMatch[1])));
      if (providerAccountsMatch && req.method === 'POST') {
        const body = await readBody(req, 1024 * 1024);
        return json(res, 201, this.providers.createAccount(decodeURIComponent(providerAccountsMatch[1]), body.name));
      }
      const providerAccountOrderMatch = path.match(/^\/api\/providers\/([^/]+)\/accounts\/order$/);
      if (providerAccountOrderMatch && (req.method === 'PUT' || req.method === 'PATCH')) {
        const body = await readBody(req, 1024 * 1024);
        return json(res, 200, this.providers.setAccountOrder(decodeURIComponent(providerAccountOrderMatch[1]), body.order));
      }
      const providerVisibilityMatch = path.match(/^\/api\/providers\/([^/]+)\/browser-visibility$/);
      if (providerVisibilityMatch && (req.method === 'PUT' || req.method === 'PATCH')) {
        const body = await readBody(req, 1024 * 1024);
        return json(res, 200, await this.providers.setBrowserVisibility(decodeURIComponent(providerVisibilityMatch[1]), !!body.visible));
      }
      const providerAccountActionMatch = path.match(/^\/api\/providers\/([^/]+)\/accounts\/([^/]+)(?:\/(select|login))?$/);
      if (providerAccountActionMatch) {
        const provider = decodeURIComponent(providerAccountActionMatch[1]);
        const accountId = decodeURIComponent(providerAccountActionMatch[2]);
        const action = providerAccountActionMatch[3] || '';
        if (req.method === 'POST' && action === 'select') return json(res, 200, await this.providers.selectAccount(provider, accountId));
        if (req.method === 'POST' && action === 'login') return json(res, 200, await this.providers.authenticate(provider, { source: 'api', account_id: accountId }));
        if (req.method === 'DELETE' && !action) return json(res, 200, await this.providers.removeAccount(provider, accountId));
      }
      const providerLoginMatch = path.match(/^\/api\/providers\/([^/]+)\/login$/);
      if (req.method === 'POST' && providerLoginMatch) {
        return json(res, 200, await this.providers.authenticate(decodeURIComponent(providerLoginMatch[1]), { source: 'api' }));
      }
      const providerConversationsMatch = path.match(/^\/api\/providers\/([^/]+)\/conversations$/);
      if (providerConversationsMatch && req.method === 'GET') {
        return json(res, 200, { object: 'list', data: await this.providers.listRemoteConversations(decodeURIComponent(providerConversationsMatch[1]), url.searchParams.get('account_id') || undefined) });
      }
      if (providerConversationsMatch && req.method === 'DELETE') {
        const body = await readBody(req, 1024 * 1024);
        return json(res, 200, await this.providers.deleteRemoteConversation(decodeURIComponent(providerConversationsMatch[1]), body.url, body.account_id));
      }
      const providerDebugMatch = path.match(/^\/api\/debug\/providers\/([^/]+)$/);
      if (req.method === 'GET' && providerDebugMatch && (process.env.WEBAGENT_DEBUG === '1' || process.env.DSAGENT_DEBUG === '1')) {
        return json(res, 200, { data: await this.providers.inspect(decodeURIComponent(providerDebugMatch[1])) });
      }
      if (req.method === 'GET' && path === '/api/sessions') {
        return json(res, 200, { object: 'list', data: this.store.list({
          includeHidden: url.searchParams.get('hidden') === '1', includeDeleted: url.searchParams.get('deleted') === 'all',
          deletedOnly: url.searchParams.get('deleted') === '1', projectId: url.searchParams.get('project_id') || null
        }) });
      }
      if (req.method === 'GET' && path === '/api/tools' && this.tools) return json(res, 200, { object: 'list', data: this.tools.list(url.searchParams.get('project_id') || null) });
      if (path === '/api/settings' && this.config) {
        if (req.method === 'GET') return json(res, 200, this.config.getSettings(url.searchParams.get('project_id') || null));
        if (req.method === 'PATCH') { const value = await readBody(req, 2 * 1024 * 1024); return json(res, 200, this.config.patchSettings(value.scope || 'user', value.project_id || null, value.settings || value)); }
      }
      const collectionMatch = path.match(/^\/api\/(projects|agents|clusters)$/);
      if (collectionMatch && this.config) {
        const collection = collectionMatch[1];
        if (req.method === 'GET') return json(res, 200, { object: 'list', data: this.config.list(collection) });
        if (req.method === 'POST') return json(res, 201, this.config.create(collection, await readBody(req, 2 * 1024 * 1024)));
      }
      const collectionItemMatch = path.match(/^\/api\/(projects|agents|clusters)\/([^/]+)$/);
      if (collectionItemMatch && this.config) {
        const collection = collectionItemMatch[1], itemId = decodeURIComponent(collectionItemMatch[2]);
        if (req.method === 'GET') { const item = this.config.get(collection, itemId); return item ? json(res, 200, item) : json(res, 404, apiError(Object.assign(new Error('Item not found'), { code: 'item_not_found' }))); }
        if (req.method === 'PATCH') return json(res, 200, this.config.update(collection, itemId, await readBody(req, 2 * 1024 * 1024)));
        if (req.method === 'DELETE') return json(res, this.config.delete(collection, itemId) ? 200 : 404, { deleted: itemId });
      }
      if (path === '/api/provider-configs' && this.providerConfigs) {
        if (req.method === 'GET') return json(res, 200, { object: 'list', data: this.providerConfigs.list() });
        if (req.method === 'POST') return json(res, 201, await this.providerConfigs.create(await readBody(req, 2 * 1024 * 1024)));
      }
      const providerConfigMatch = path.match(/^\/api\/provider-configs\/([^/]+)(?:\/(test))?$/);
      if (providerConfigMatch && this.providerConfigs) {
        const providerId = decodeURIComponent(providerConfigMatch[1]);
        if (req.method === 'POST' && providerConfigMatch[2] === 'test') return json(res, 200, await this.providerConfigs.test(providerId));
        if (req.method === 'PATCH') return json(res, 200, await this.providerConfigs.update(providerId, await readBody(req, 2 * 1024 * 1024)));
        if (req.method === 'DELETE') return json(res, 200, await this.providerConfigs.delete(providerId));
      }
      if (path === '/api/approvals' && this.approvals && req.method === 'GET') return json(res, 200, { object: 'list', data: this.approvals.list() });
      const approvalMatch = path.match(/^\/api\/approvals\/([^/]+)$/);
      if (approvalMatch && this.approvals && req.method === 'POST') { const value = await readBody(req, 1024 * 1024); const result = this.approvals.resolve(decodeURIComponent(approvalMatch[1]), !!value.approved, value.reason); return result ? json(res, 200, result) : json(res, 404, apiError(Object.assign(new Error('Approval not found'), { code: 'approval_not_found' }))); }
      if (path === '/api/bots/platforms' && this.bots && req.method === 'GET') return json(res, 200, { object: 'list', data: this.bots.platforms() });
      if (path === '/api/bots' && this.bots) {
        if (req.method === 'GET') return json(res, 200, { object: 'list', data: this.bots.list() });
        if (req.method === 'POST') return json(res, 201, this.bots.create(await readBody(req, 2 * 1024 * 1024)));
      }
      const botMatch = path.match(/^\/api\/bots\/([^/]+)$/);
      if (botMatch && this.bots) { const botId = decodeURIComponent(botMatch[1]); if (req.method === 'PATCH') return json(res, 200, this.bots.update(botId, await readBody(req, 2 * 1024 * 1024))); if (req.method === 'DELETE') return json(res, this.bots.delete(botId) ? 200 : 404, { deleted: botId }); }
      if (path === '/api/bots/dispatch' && this.bots && req.method === 'POST') return json(res, 202, await this.bots.dispatch(await readBody(req, 2 * 1024 * 1024)));
      if (path === '/api/mobile' && this.mobile) {
        if (req.method === 'GET') return json(res, 200, this.mobile.status());
        if (req.method === 'POST') { const value = await readBody(req, 1024 * 1024); value.enabled === false ? await this.mobile.stop() : await this.mobile.start(value.port); if (value.tunnel != null) await this.mobile.setTunnel(!!value.tunnel); if (this.config) this.config.patchSettings('user', null, { mobile: { enabled: value.enabled !== false, port: this.mobile.port || Number(value.port) || 5860, tunnel: !!value.tunnel } }); return json(res, 200, this.mobile.status()); }
      }
      if (path === '/api/mobile/pair' && this.mobile && req.method === 'POST') { const value = await readBody(req, 1024 * 1024); return json(res, 201, this.mobile.createPairing(!!value.tunnel)); }
      const deviceMatch = path.match(/^\/api\/mobile\/devices\/([^/]+)$/);
      if (deviceMatch && this.mobile && req.method === 'DELETE') return json(res, this.mobile.revoke(decodeURIComponent(deviceMatch[1])) ? 200 : 404, { deleted: decodeURIComponent(deviceMatch[1]) });
      const capabilityMatch = path.match(/^\/api\/capabilities\/([^/]+)$/);
      if (req.method === 'GET' && capabilityMatch && this.capabilities) {
        return json(res, 200, { object: 'list', data: this.capabilities.list(decodeURIComponent(capabilityMatch[1]), url.searchParams.get('workspace') || process.cwd()) });
      }
      if (req.method === 'GET' && path === '/api/workspace/tree' && this.capabilities) {
        return json(res, 200, {
          object: 'list',
          data: this.capabilities.tree(url.searchParams.get('workspace') || process.cwd(), url.searchParams.get('path') || '')
        });
      }
      if (path === '/api/harness' && this.harness) {
        if (req.method === 'GET') return json(res, 200, this.harness.status());
      }
      if (path === '/api/harness/start' && this.harness && req.method === 'POST') {
        return json(res, 200, await this.harness.start(await readBody(req, 1024 * 1024)));
      }
      if (path === '/api/harness/stop' && this.harness && req.method === 'POST') {
        return json(res, 200, await this.harness.stop());
      }
      const harnessArchiveMatch = path.match(/^\/api\/harness\/sessions\/([^/]+)\/archive$/);
      if (req.method === 'POST' && harnessArchiveMatch) {
        const externalId = decodeURIComponent(harnessArchiveMatch[1]);
        const sessionId = harnessSessionId(externalId);
        const session = sessionId && this.store.get(sessionId);
        if (!session) return json(res, 200, { archived: externalId, remote_deleted: false, skipped: true });
        if (this.runs.activeRunForSession(sessionId)) throw Object.assign(new Error('Harness session has an active run'), { code: 'session_busy', status: 409 });
        const state = session.provider_state || {};
        const hasRemote = !!state.url || (Array.isArray(state.conversations) && state.conversations.some((item) => item.status !== 'deleted'));
        if (hasRemote) {
          const deleted = await this.providers.cleanupSession(session, state.last_run_id, state.last_call_id);
          if (!deleted) throw Object.assign(new Error('Harness remote conversation was not deleted; mapping was preserved'), { code: 'remote_delete_failed', status: 502 });
        }
        this.store.delete(sessionId, { permanent: true });
        return json(res, 200, { archived: externalId, session_id: sessionId, remote_deleted: hasRemote });
      }
      if (path === '/api/memory' && this.capabilities) {
        if (req.method === 'GET') return json(res, 200, this.capabilities.readMemory(url.searchParams.get('workspace') || process.cwd()));
        if (req.method === 'POST') {
          const body = await readBody(req, 1024 * 1024);
          return json(res, 200, this.capabilities.appendMemory(body.workspace || process.cwd(), body.scope || 'project', body.content || ''));
        }
      }
      if (path === '/api/skills' && this.capabilities) {
        if (req.method === 'GET') return json(res, 200, { object: 'list', data: this.capabilities.listSkills(url.searchParams.get('workspace') || process.cwd()) });
        if (req.method === 'POST') return json(res, 201, this.capabilities.addSkill(await readBody(req, 4 * 1024 * 1024)));
      }
      const skillMatch = path.match(/^\/api\/skills\/([^/]+)$/);
      if (skillMatch && this.capabilities && req.method === 'DELETE') return json(res, this.capabilities.deleteSkill(decodeURIComponent(skillMatch[1]), url.searchParams.get('workspace'), url.searchParams.get('scope')) ? 200 : 404, { deleted: decodeURIComponent(skillMatch[1]) });
      if (path === '/api/plugins' && this.capabilities) {
        if (req.method === 'GET') return json(res, 200, { object: 'list', data: this.capabilities.listPlugins() });
        if (req.method === 'POST') return json(res, 201, await this.capabilities.installPlugin(await readBody(req, 4 * 1024 * 1024)));
      }
      const pluginMatch = path.match(/^\/api\/plugins\/([^/]+)$/);
      if (pluginMatch && this.capabilities && req.method === 'DELETE') return json(res, 200, this.capabilities.uninstallPlugin(decodeURIComponent(pluginMatch[1])));
      if (path === '/api/plugin-marketplaces' && this.capabilities) {
        if (req.method === 'GET') return json(res, 200, { object: 'list', data: this.capabilities.marketplaces() });
        if (req.method === 'POST') return json(res, 201, this.capabilities.addMarketplace(await readBody(req, 4 * 1024 * 1024)));
      }
      if (req.method === 'POST' && path === '/api/sessions') {
        const body = await readBody(req, 1024 * 1024);
        if (body.mode === 'project' && this.config) {
          const project = this.config.get('projects', body.project_id);
          if (!project) throw Object.assign(new Error('Project not found'), { code: 'project_not_found', status: 404 });
          body.workspace = project.workspace;
        }
        if (body.mode === 'work' && this.workMemory) body.workspace = this.workMemory.init(body.work_root || body.workspace);
        return json(res, 201, this.store.create(body));
      }

      const contextMatch = path.match(/^\/api\/sessions\/([^/]+)\/context$/);
      if (req.method === 'GET' && contextMatch && this.contextManager) {
        const current = this.store.get(decodeURIComponent(contextMatch[1]));
        if (!current) throw Object.assign(new Error('Session not found'), { code: 'session_not_found', status: 404 });
        return json(res, 200, this.contextManager.inspect(current, current.model, ''));
      }
      const compactMatch = path.match(/^\/api\/sessions\/([^/]+)\/compact$/);
      if (req.method === 'POST' && compactMatch && this.contextManager) {
        const sessionId = decodeURIComponent(compactMatch[1]);
        if (this.runs.activeRunForSession(sessionId)) throw Object.assign(new Error('Session has an active run'), { code: 'session_busy', status: 409 });
        return json(res, 202, this.contextManager.requestCompaction(sessionId));
      }
      const convertMatch = path.match(/^\/api\/sessions\/([^/]+)\/convert$/);
      if (req.method === 'POST' && convertMatch) {
        const source = this.store.get(decodeURIComponent(convertMatch[1]));
        if (!source) throw Object.assign(new Error('Session not found'), { code: 'session_not_found', status: 404 });
        const body = await readBody(req, 1024 * 1024);
        const summary = source.context_state && source.context_state.summary || { title: source.title, recent: source.messages.filter((message) => !message.hidden).slice(-8).map((message) => ({ role: message.role, content: message.content })) };
        const target = this.store.create({ title: body.title || source.title, mode: body.mode, model: body.model || source.model, project_id: body.project_id || null, workspace: body.workspace || body.work_root || '', work_root: body.work_root || '' });
        this.store.appendMessage(target.id, { role: 'system', content: 'Converted from session ' + source.id + '\n' + JSON.stringify(summary), hidden: true });
        return json(res, 201, this.store.get(target.id));
      }
      if (path === '/api/work-memory' && this.workMemory) {
        const workRoot = url.searchParams.get('work_root') || undefined;
        if (req.method === 'GET') return json(res, 200, { object: 'list', data: this.workMemory.search(workRoot, url.searchParams.get('q') || '', Number(url.searchParams.get('limit')) || 50) });
        if (req.method === 'PATCH') {
          const body = await readBody(req, 2 * 1024 * 1024);
          this.workMemory.updateMemory(body.work_root || workRoot, body.content || '');
          return json(res, 200, { updated: true });
        }
      }
      const workMemoryMatch = path.match(/^\/api\/work-memory\/([^/]+)(?:\/(pin))?$/);
      if (workMemoryMatch && this.workMemory) {
        const entryId = decodeURIComponent(workMemoryMatch[1]);
        const workRoot = url.searchParams.get('work_root') || undefined;
        if (req.method === 'DELETE') return json(res, 200, this.workMemory.mutateEntry(workRoot, entryId, 'delete'));
        if (req.method === 'PATCH') { const body = await readBody(req, 1024 * 1024); return json(res, 200, this.workMemory.mutateEntry(body.work_root || workRoot, entryId, 'edit', body.content || '')); }
        if (req.method === 'POST' && workMemoryMatch[2] === 'pin') return json(res, 200, this.workMemory.mutateEntry(workRoot, entryId, 'pin'));
      }

      const sessionMatch = path.match(/^\/api\/sessions\/([^/]+)$/);
      if (sessionMatch) {
        const sessionId = decodeURIComponent(sessionMatch[1]);
        if (req.method === 'GET') {
          const session = this.store.get(sessionId);
          return session ? json(res, 200, session) : json(res, 404, apiError(Object.assign(new Error('Session not found'), { code: 'session_not_found' })));
        }
        if (req.method === 'PATCH') {
          const body = await readBody(req, 1024 * 1024);
          if (body.mode === 'project' && this.config) {
            const project = this.config.get('projects', body.project_id);
            if (!project) throw Object.assign(new Error('Project not found'), { code: 'project_not_found', status: 404 });
            body.workspace = project.workspace;
          }
          return json(res, 200, this.store.update(sessionId, body));
        }
        if (req.method === 'DELETE') {
          if (this.runs.activeRunForSession(sessionId)) throw Object.assign(new Error('Session has an active run'), { code: 'session_busy', status: 409 });
          const permanent = url.searchParams.get('permanent') === '1';
          const current = this.store.get(sessionId);
          if (current) {
            const state = current.provider_state || {};
            const hasRemoteWebConversation = ['deepseek', 'qwen', 'chatgpt'].includes(state.provider) && (!!state.url || (Array.isArray(state.conversations) && state.conversations.some((item) => item.status !== 'deleted')));
            if (hasRemoteWebConversation) {
              const remoteDeleted = await this.providers.cleanupSession(current, state.last_run_id, state.last_call_id);
              if (!remoteDeleted) throw Object.assign(new Error('Remote conversation was not deleted; local record was preserved'), { code: 'remote_delete_failed', status: 502 });
              let nextState = state;
              const targets = [state.url].concat((state.conversations || []).map((item) => item.url)).filter(Boolean);
              for (const target of new Set(targets)) nextState = this.providers.markConversationRetired ? this.providers.markConversationRetired(nextState, target, { deleted: true }) : nextState;
              this.store.update(sessionId, { provider_state: nextState });
            }
          }
          const deleted = this.store.delete(sessionId, { permanent });
          return json(res, deleted ? 200 : 404, permanent ? { deleted: sessionId, permanent: true } : deleted);
        }
      }

      const restoreMatch = path.match(/^\/api\/sessions\/([^/]+)\/restore$/);
      if (req.method === 'POST' && restoreMatch) return json(res, 200, this.store.restore(decodeURIComponent(restoreMatch[1])));
      const autoTitleMatch = path.match(/^\/api\/sessions\/([^/]+)\/title-mode$/);
      if (req.method === 'POST' && autoTitleMatch) { const sessionId = decodeURIComponent(autoTitleMatch[1]); const value = await readBody(req, 1024 * 1024); const current = this.store.get(sessionId); const mode = value.mode === 'user' ? 'user' : 'auto'; return json(res, 200, this.store.update(sessionId, { title_mode: mode, title: mode === 'auto' && current.remote_title ? current.remote_title : current.title })); }

      const runStartMatch = path.match(/^\/api\/sessions\/([^/]+)\/runs$/);
      if (req.method === 'POST' && runStartMatch) {
        const sessionId = decodeURIComponent(runStartMatch[1]);
        const body = await readBody(req, 32 * 1024 * 1024);
        const run = await this.runs.startRun(sessionId, body);
        return json(res, 202, run, { 'X-WebAgent-Run-Id': run.id, 'X-DSAgent-Run-Id': run.id });
      }

      const eventsMatch = path.match(/^\/api\/sessions\/([^/]+)\/events$/);
      if (req.method === 'GET' && eventsMatch) {
        const sessionId = decodeURIComponent(eventsMatch[1]);
        if (!this.store.get(sessionId)) return json(res, 404, apiError(Object.assign(new Error('Session not found'), { code: 'session_not_found' })));
        return this._eventStream(req, res, sessionId, Number(url.searchParams.get('after')) || 0);
      }

      const runMatch = path.match(/^\/api\/runs\/([^/]+)$/);
      if (req.method === 'GET' && runMatch) {
        const run = this.runs.getRun(decodeURIComponent(runMatch[1]));
        return run ? json(res, 200, run) : json(res, 404, apiError(Object.assign(new Error('Run not found'), { code: 'run_not_found' })));
      }
      const cancelMatch = path.match(/^\/api\/runs\/([^/]+)\/cancel$/);
      if (req.method === 'POST' && cancelMatch) {
        const cancelled = await this.runs.cancel(decodeURIComponent(cancelMatch[1]));
        return json(res, cancelled ? 202 : 404, { cancelled });
      }

      if (req.method === 'POST' && path === '/v1/chat/completions') {
        // Await inside this try/catch. Returning the promise directly lets an
        // asynchronous startRun() rejection (notably session_busy) escape the
        // request error boundary and become an unhandled rejection.
        return await this._chatCompletions(req, res);
      }
      if (req.method === 'POST' && path === '/v1/responses') {
        return await this._responses(req, res);
      }
      return json(res, 404, apiError(Object.assign(new Error('Route not found'), { code: 'not_found' })));
    } catch (error) {
      if (!res.headersSent) json(res, error.status || 500, apiError(error), error.retry_after_seconds ? { 'Retry-After': String(error.retry_after_seconds) } : undefined);
      else res.end();
    }
  }

  async _ensureSession(req, body, prompt) {
    const isHarness = String(req.headers['x-webagent-tool-bridge'] || '').toLowerCase() === 'dsh';
    const auxiliaryTitle = isHarness && isHarnessTitleRequest(body);
    const rawExternalHarnessId = isHarness
      ? (body.prompt_cache_key || req.headers['x-session-id'] || req.headers['x-session-affinity'] || req.headers['x-client-request-id'])
      : null;
    // DSH's first-prompt title generator intentionally runs beside the main
    // model turn but pi-ai gives both calls the same sessionId. Isolate that
    // helper call or it races the writable main run and surfaces session_busy.
    const externalHarnessId = rawExternalHarnessId && auxiliaryTitle
      ? String(rawExternalHarnessId) + ':title'
      : rawExternalHarnessId;
    const headerId = req.headers['x-webagent-session-id'] || req.headers['x-dsagent-session-id'];
    const sessionId = harnessSessionId(externalHarnessId) || headerId || body.conversation_id || null;
    if (sessionId) {
      const existing = this.store.get(String(sessionId));
      if (existing) return existing;
    }
    return this.store.create({
      id: sessionId || undefined,
      title: String(prompt || 'API 会话').slice(0, 48),
      model: body.model,
      mode: body.mode || 'chat',
      project_id: body.project_id || null,
      workspace: body.workspace || '',
      work_root: body.work_root || '',
      hidden: isHarness || String(req.headers['x-webagent-ephemeral'] || '').toLowerCase() === 'true',
      ephemeral: auxiliaryTitle || String(req.headers['x-webagent-ephemeral'] || '').toLowerCase() === 'true',
      integration_origin: auxiliaryTitle ? 'dsh-title' : isHarness ? 'dsh' : '',
      external_session_id: externalHarnessId ? String(externalHarnessId) : ''
    });
  }

  async _chatCompletions(req, res) {
    const body = await readBody(req, 32 * 1024 * 1024);
    if (!body.model || !Array.isArray(body.messages) || !body.messages.length) throw Object.assign(new Error('model and messages are required'), { code: 'invalid_request', status: 400 });
    const latest = body.messages[body.messages.length - 1];
    const session = await this._ensureSession(req, body, latest.content);
    const isHarness = String(req.headers['x-webagent-tool-bridge'] || '').toLowerCase() === 'dsh';
    const auxiliaryTitle = isHarness && isHarnessTitleRequest(body);
    const toolBridge = isHarness && !auxiliaryTitle && toolDefinitions(body.tools).length > 0;
    const harnessPassthrough = isHarness && !auxiliaryTitle;
    const run = await this.runs.startRun(session.id, {
      messages: body.messages,
      model: body.model,
      instructions: harnessPassthrough ? '' : body.messages.filter((message) => message.role === 'system').map((message) => message.content).join('\n'),
      prompt_passthrough: harnessPassthrough,
      skip_runtime_instructions: auxiliaryTitle,
      provider_tools: harnessPassthrough ? toolDefinitions(body.tools) : [],
      timeout_ms: body.timeout_ms || body.timeout,
      deep_think: reasoningRequested(body),
      reasoning_effort: requestedReasoningEffort(body),
      web_search: !!body.web_search,
      agent_mode: toolBridge ? false : String(req.headers['x-webagent-agent-mode'] || req.headers['x-dsagent-agent-mode'] || 'true').toLowerCase() !== 'false'
    });
    res.setHeader('X-WebAgent-Session-Id', session.id);
    res.setHeader('X-WebAgent-Run-Id', run.id);
    res.setHeader('X-DSAgent-Session-Id', session.id);
    res.setHeader('X-DSAgent-Run-Id', run.id);
    res.setHeader('X-WebAgent-Usage-Estimated', 'true');
    const inputTokens = estimateInputTokens(body.messages, body.tools, '', body.model);
    const cachedTokens = harnessPassthrough ? estimateHarnessCachedTokens(body, session, inputTokens) : 0;
    if (body.stream) return this._openAIChatStream(req, res, session.id, run.id, body.model, {
      toolBridge,
      tools: body.tools,
      ephemeral: !!session.ephemeral,
      // DeepSeek reasoning moves provisional text between answer and reasoning DOM
      // nodes. Stream reasoning immediately, but wait for the authoritative
      // final answer/tool envelope before committing body text to DSH.
      deferContent: toolBridge && reasoningRequested(body),
      inputTokens,
      cachedTokens,
      includeUsage: !!(body.stream_options && body.stream_options.include_usage)
    });
    const completed = await this.runs.waitForRun(run.id);
    if (completed.status !== 'completed') {
      if (session.ephemeral) await this._cleanupEphemeralSession(session.id);
      throw Object.assign(new Error(completed.error && completed.error.message || 'Run failed'), { code: completed.error && completed.error.code || 'run_failed', status: completedRunErrorStatus(completed.error), retry_after_seconds: completed.error && completed.error.retry_after_seconds });
    }
    const calls = toolBridge ? bridgedToolCalls(completed.output, body.tools) : [];
    const response = {
      id: 'chatcmpl-' + run.id,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: body.model,
      choices: [{ index: 0, message: { role: 'assistant', content: calls.length ? contentBeforeToolCalls(completed.output) : completed.output, ...(completed.reasoning ? { reasoning_content: completed.reasoning } : {}), ...(calls.length ? { tool_calls: calls } : {}) }, finish_reason: calls.length ? 'tool_calls' : 'stop' }],
      usage: estimatedUsage(inputTokens, completed.output, completed.reasoning, 'chat', cachedTokens),
      conversation_id: session.id
    };
    json(res, 200, response);
    if (session.ephemeral) await this._cleanupEphemeralSession(session.id);
  }

  async _responses(req, res) {
    const body = await readBody(req, 32 * 1024 * 1024);
    if (!body.model || body.input == null) throw Object.assign(new Error('model and input are required'), { code: 'invalid_request', status: 400 });
    const prompt = typeof body.input === 'string' ? body.input : this._responseInputText(body.input);
    const session = await this._ensureSession(req, body, prompt);
    const run = await this.runs.startRun(session.id, {
      prompt,
      model: body.model,
      instructions: body.instructions || '',
      deep_think: reasoningRequested(body),
      reasoning_effort: requestedReasoningEffort(body),
      web_search: !!body.web_search,
      agent_mode: String(req.headers['x-webagent-agent-mode'] || req.headers['x-dsagent-agent-mode'] || 'true').toLowerCase() !== 'false'
    });
    res.setHeader('X-WebAgent-Session-Id', session.id);
    res.setHeader('X-WebAgent-Run-Id', run.id);
    res.setHeader('X-DSAgent-Session-Id', session.id);
    res.setHeader('X-DSAgent-Run-Id', run.id);
    res.setHeader('X-WebAgent-Usage-Estimated', 'true');
    const inputTokens = estimateInputTokens([{ role: 'user', content: prompt }], null, body.instructions || '', body.model);
    if (body.stream) return this._openAIResponseStream(req, res, session.id, run.id, body.model, inputTokens);
    const completed = await this.runs.waitForRun(run.id);
    if (completed.status !== 'completed') throw Object.assign(new Error(completed.error && completed.error.message || 'Run failed'), { code: completed.error && completed.error.code || 'run_failed', status: completedRunErrorStatus(completed.error), retry_after_seconds: completed.error && completed.error.retry_after_seconds });
    return json(res, 200, this._responseObject(completed, body.model, inputTokens));
  }

  _eventStream(req, res, sessionId, after) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive' });
    const write = (event) => res.write('id: ' + event.seq + '\nevent: ' + event.type + '\ndata: ' + JSON.stringify(event) + '\n\n');
    this.store.getEvents(sessionId, after).forEach(write);
    const listener = (event) => { if (event.session_id === sessionId) write(event); };
    this.store.on('event', listener);
    const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 15000);
    req.on('close', () => { clearInterval(heartbeat); this.store.removeListener('event', listener); });
  }

  _openAIChatStream(req, res, sessionId, runId, model, options) {
    options = options || {};
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive' });
    const send = (payload) => res.write('data: ' + JSON.stringify(payload) + '\n\n');
    send({ id: 'chatcmpl-' + runId, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] });
    let closed = false;
    let currentText = '';
    let sentText = '';
    let currentReasoning = '';
    let sentReasoning = '';
    let reasoningDesynced = false;
    const flushReasoning = (final, stableEnd) => {
      if (reasoningDesynced) return;
      if (!currentReasoning.startsWith(sentReasoning)) return;
      const confirmed = stableEnd == null ? currentReasoning.length : Math.min(currentReasoning.length, stableEnd);
      const candidate = final ? currentReasoning.length : Math.max(0, confirmed - STREAM_GUARD_CHARS);
      const limit = final ? candidate : stableMarkdownPrefixLength(currentReasoning, candidate);
      if (limit <= sentReasoning.length) return;
      const delta = currentReasoning.slice(sentReasoning.length, limit);
      sentReasoning = currentReasoning.slice(0, limit);
      for (let offset = 0; offset < delta.length; offset += STREAM_CHUNK_CHARS) {
        send({ id: 'chatcmpl-' + runId, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, delta: { reasoning_content: delta.slice(offset, offset + STREAM_CHUNK_CHARS) }, finish_reason: null }] });
      }
    };
    const flushText = (final, stableEnd) => {
      if (!currentText.startsWith(sentText)) return;
      const marker = options.toolBridge ? toolCallMarkerIndex(currentText) : -1;
      const safeEnd = marker >= 0 ? marker : currentText.length;
      // Keep enough uncommitted text to recognize a tool marker split across
      // DOM polls. Long narrative still streams while tool JSON stays hidden.
      const confirmed = stableEnd == null ? safeEnd : Math.min(safeEnd, stableEnd);
      const candidate = final || marker >= 0 ? safeEnd : Math.max(0, confirmed - STREAM_GUARD_CHARS);
      const limit = final ? candidate : stableMarkdownPrefixLength(currentText, candidate);
      if (limit <= sentText.length) return;
      const delta = currentText.slice(sentText.length, limit);
      sentText = currentText.slice(0, limit);
      for (let offset = 0; offset < delta.length; offset += STREAM_CHUNK_CHARS) {
        send({ id: 'chatcmpl-' + runId, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, delta: { content: delta.slice(offset, offset + STREAM_CHUNK_CHARS) }, finish_reason: null }] });
      }
    };
    const listener = (event) => {
      if (closed) return;
      if (event.session_id !== sessionId || event.run_id !== runId) return;
      if (event.type === 'response.reasoning.delta') { const previous = currentReasoning; currentReasoning += String(event.data.delta || ''); flushReasoning(false, commonPrefixLength(previous, currentReasoning)); }
      if (event.type === 'response.reasoning.replace') {
        const previous = currentReasoning;
        const next = String(event.data.text || '');
        // A webpage may rewrite an already-rendered Think block while turning
        // provisional DOM into Markdown. SSE cannot retract bytes already sent,
        // so freeze only the reasoning channel and keep the answer/tool stream
        // alive instead of failing the entire run.
        if (sentReasoning && !next.startsWith(sentReasoning)) reasoningDesynced = true;
        else if (!reasoningDesynced) { currentReasoning = next; flushReasoning(false, commonPrefixLength(previous, currentReasoning)); }
      }
      if (event.type === 'response.reasoning.done') {
        const finalReasoning = String(event.data.text || '');
        if (!reasoningDesynced) {
          if (sentReasoning && !finalReasoning.startsWith(sentReasoning)) reasoningDesynced = true;
          else currentReasoning = finalReasoning;
        }
        flushReasoning(true);
      }
      if (event.type === 'response.output_text.delta') {
        // DeepSeek stops mutating its reasoning card before it starts the body
        // (including a hidden DSH tool envelope). Release the guarded reasoning
        // tail at that boundary instead of holding it for the many seconds a
        // large tool argument may take to finish generating.
        flushReasoning(true);
        const previous = currentText; currentText += String(event.data.delta || ''); if (!options.deferContent) flushText(false, commonPrefixLength(previous, currentText));
      }
      if (event.type === 'response.output_text.replace') {
        flushReasoning(true);
        const previous = currentText; currentText = String(event.data.text || ''); if (!options.deferContent) flushText(false, commonPrefixLength(previous, currentText));
      }
      if (event.type === 'response.output_text.done') {
        flushReasoning(true);
        currentText = String(event.data.text || '');
        if (!options.deferContent && sentText && !currentText.startsWith(sentText)) {
          send(apiError(Object.assign(new Error('Webpage output changed before already-streamed content; refusing to return a truncated answer'), { code: 'stream_desync' })));
          cleanup();
          return;
        }
        if (!options.deferContent) flushText(!options.toolBridge);
      }
      if (event.type === 'run.completed') {
        const completedRun = this.runs.getRun(runId);
        const completedReasoning = String(completedRun && completedRun.reasoning || currentReasoning);
        if (!reasoningDesynced) {
          if (sentReasoning && !completedReasoning.startsWith(sentReasoning)) reasoningDesynced = true;
          else currentReasoning = completedReasoning;
        }
        flushReasoning(true);
        currentText = String(event.data.output || currentText);
        if (sentText && !currentText.startsWith(sentText)) {
          send(apiError(Object.assign(new Error('Webpage output changed before already-streamed content; refusing to return a truncated answer'), { code: 'stream_desync' })));
          cleanup();
          return;
        }
        const calls = options.toolBridge ? bridgedToolCalls(currentText, options.tools) : [];
        if (calls.length) {
          flushText(true);
          calls.forEach((call, index) => send({ id: 'chatcmpl-' + runId, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, delta: { tool_calls: [{ index, id: call.id, type: 'function', function: call.function }] }, finish_reason: null }] }));
        } else flushText(true);
        send({ id: 'chatcmpl-' + runId, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, delta: {}, finish_reason: calls.length ? 'tool_calls' : 'stop' }] });
        if (options.includeUsage) send({
          id: 'chatcmpl-' + runId,
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model,
          choices: [],
          usage: estimatedUsage(options.inputTokens, currentText, currentReasoning, 'chat', options.cachedTokens)
        });
        res.write('data: [DONE]\n\n');
        cleanup();
        if (options.ephemeral) void this._cleanupEphemeralSession(sessionId);
      }
      if (event.type === 'run.failed' || event.type === 'run.cancelled') {
        send(apiError(Object.assign(new Error(event.data.error && event.data.error.message || 'Run failed'), { code: event.data.error && event.data.error.code || event.type, retry_after_seconds: event.data.error && event.data.error.retry_after_seconds })));
        res.write('data: [DONE]\n\n');
        cleanup();
        if (options.ephemeral) void this._cleanupEphemeralSession(sessionId);
      }
    };
    const heartbeat = setInterval(() => { if (!closed && !res.writableEnded) res.write(': heartbeat\n\n'); }, 5000);
    const cleanup = () => { if (closed) return; closed = true; clearInterval(heartbeat); this.store.removeListener('event', listener); if (!res.writableEnded) res.end(); };
    const disconnect = () => {
      if (closed) return;
      const active = this.runs.getRun(runId);
      cleanup();
      if (active && !['completed', 'failed', 'cancelled'].includes(active.status)) void this.runs.cancel(runId);
    };
    this.store.on('event', listener);
    req.on('aborted', disconnect);
    res.on('close', disconnect);
    this.store.getEvents(sessionId, 0).filter((event) => event.run_id === runId).forEach(listener);
  }

  async _cleanupEphemeralSession(sessionId) {
    const session = this.store.get(sessionId);
    if (!session) return true;
    try {
      const deleted = await this.providers.cleanupSession(session, session.provider_state && session.provider_state.last_run_id, session.provider_state && session.provider_state.last_call_id);
      if (!deleted) { this.store.trash(sessionId); return false; }
      return !!this.store.delete(sessionId, { permanent: true });
    } catch (_) {
      this.store.trash(sessionId);
      return false;
    }
  }

  _openAIResponseStream(req, res, sessionId, runId, model, inputTokens) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive' });
    const responseId = 'resp_' + runId;
    const send = (type, data) => res.write('event: ' + type + '\ndata: ' + JSON.stringify(Object.assign({ type }, data)) + '\n\n');
    send('response.created', { response: { id: responseId, object: 'response', status: 'in_progress', model, output: [] } });
    let closed = false;
    let currentText = '';
    let sentText = '';
    let currentReasoning = '';
    let sentReasoning = '';
    const flushReasoning = (final) => {
      if (!currentReasoning.startsWith(sentReasoning)) return;
      const limit = final ? currentReasoning.length : Math.max(0, currentReasoning.length - 32);
      if (limit <= sentReasoning.length) return;
      const delta = currentReasoning.slice(sentReasoning.length, limit);
      sentReasoning = currentReasoning.slice(0, limit);
      send('response.reasoning.delta', { response_id: responseId, output_index: 0, delta });
    };
    const flushText = (final) => {
      if (!currentText.startsWith(sentText)) return;
      const limit = final ? currentText.length : Math.max(0, currentText.length - 64);
      if (limit <= sentText.length) return;
      const delta = currentText.slice(sentText.length, limit);
      sentText = currentText.slice(0, limit);
      send('response.output_text.delta', { response_id: responseId, output_index: 0, content_index: 0, delta });
    };
    const listener = (event) => {
      if (closed) return;
      if (event.session_id !== sessionId || event.run_id !== runId) return;
      if (event.type === 'response.reasoning.delta') { currentReasoning += String(event.data.delta || ''); flushReasoning(false); }
      else if (event.type === 'response.reasoning.replace') { currentReasoning = String(event.data.text || ''); flushReasoning(false); }
      else if (event.type === 'response.reasoning.done') { currentReasoning = String(event.data.text || ''); flushReasoning(true); send('response.reasoning.done', { response_id: responseId, output_index: 0, text: currentReasoning }); }
      else if (event.type === 'response.output_text.delta') { currentText += String(event.data.delta || ''); flushText(false); }
      else if (event.type === 'response.output_text.replace') { currentText = String(event.data.text || ''); flushText(false); }
      else if (event.type === 'response.output_text.done') { currentText = String(event.data.text || ''); flushText(true); }
      else if (event.type.startsWith('tool_call.') || event.type.startsWith('subagent.')) send('dsagent.' + event.type, { response_id: responseId, event });
      else if (event.type === 'run.completed') {
        const completedRun = this.runs.getRun(runId);
        currentReasoning = String(completedRun && completedRun.reasoning || currentReasoning); flushReasoning(true);
        currentText = String(event.data.output || currentText); flushText(true);
        send('response.output_text.done', { response_id: responseId, output_index: 0, content_index: 0, text: event.data.output });
        send('response.completed', { response: this._responseObject(this.runs.getRun(runId), model, inputTokens) });
        cleanup();
      } else if (event.type === 'run.failed' || event.type === 'run.cancelled') {
        send('response.failed', { response: { id: responseId, object: 'response', status: event.type === 'run.cancelled' ? 'cancelled' : 'failed', error: event.data.error } });
        cleanup();
      }
    };
    const cleanup = () => { if (closed) return; closed = true; this.store.removeListener('event', listener); if (!res.writableEnded) res.end(); };
    const disconnect = () => {
      if (closed) return;
      const active = this.runs.getRun(runId);
      cleanup();
      if (active && !['completed', 'failed', 'cancelled'].includes(active.status)) void this.runs.cancel(runId);
    };
    this.store.on('event', listener);
    req.on('aborted', disconnect);
    res.on('close', disconnect);
    this.store.getEvents(sessionId, 0).filter((event) => event.run_id === runId).forEach(listener);
  }

  _responseObject(run, model, inputTokens) {
    return {
      id: 'resp_' + run.id,
      object: 'response',
      created_at: Math.floor(Date.now() / 1000),
      status: run.status,
      model,
      output: [
        ...(run.reasoning ? [{ id: id('reasoning'), type: 'reasoning', status: 'completed', content: run.reasoning, summary: [] }] : []),
        { id: id('msg'), type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: run.output || '', annotations: [] }] }
      ],
      error: run.error,
      usage: estimatedUsage(inputTokens, run.output, run.reasoning, 'responses', 0)
    };
  }

  _responseInputText(input) {
    if (!Array.isArray(input)) return String(input || '');
    return input.map((item) => {
      if (typeof item === 'string') return item;
      if (typeof item.content === 'string') return item.content;
      if (Array.isArray(item.content)) return item.content.map((part) => part.text || part.input_text || '').join('');
      return '';
    }).join('\n');
  }
}

module.exports = { RuntimeApiServer, apiError, parseBridgeCall, bridgeCallPayloads, bridgedToolCalls, normalizeBridgeArguments, bridgeArguments, repairInvalidJsonEscapes, stableMarkdownPrefixLength, toolCallMarkerIndex, contentBeforeToolCalls };
