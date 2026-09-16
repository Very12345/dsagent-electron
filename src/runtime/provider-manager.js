'use strict';

const crypto = require('crypto');
const { WorkerPool } = require('./worker-pool');
const { initialEnvelope, continuationEnvelope, stateFor } = require('./dsh-web-codec');
const { canonicalizeDsml, parseDsmlCalls, dsmlMarkerIndex } = require('./deepseek-dsml');

const PROVIDER_BUSY_RETRY_DELAYS_MS = Object.freeze([1000, 2000, 3000, 4000, 5000]);
const MAX_TOOL_PROTOCOL_REPAIRS = 2;
const DEEPSEEK_PER_ACCOUNT_CONCURRENCY = 2;

function waitForRetry(ms, signal) {
  if (signal && signal.aborted) return Promise.reject(Object.assign(new Error('Run cancelled'), { name: 'AbortError', code: 'run_cancelled' }));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, Math.max(0, Number(ms) || 0));
    function done() {
      if (signal) signal.removeEventListener('abort', aborted);
      resolve();
    }
    function aborted() {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', aborted);
      reject(Object.assign(new Error('Run cancelled'), { name: 'AbortError', code: 'run_cancelled' }));
    }
    if (signal) signal.addEventListener('abort', aborted, { once: true });
  });
}

function localHarnessTitle(messages) {
	const rows = Array.isArray(messages) ? messages : [];
	for (const message of rows.slice().reverse()) {
	  const content = typeof message?.content === 'string' ? message.content : '';
	  const marker = content.indexOf('JSON array of human messages:');
	  if (marker < 0) continue;
	  const source = content.slice(marker + 'JSON array of human messages:'.length).trim();
	  try {
		const parsed = JSON.parse(source);
		const text = (Array.isArray(parsed) ? parsed : []).map((item) => String(item && item.text || '').trim()).find(Boolean);
		if (text) return conciseLocalTitle(text);
	  } catch (_) {}
	}
	const fallback = rows.slice().reverse().map((message) => typeof message?.content === 'string' ? message.content.trim() : '').find(Boolean);
	return conciseLocalTitle(fallback || '新对话');
}

function conciseLocalTitle(value) {
	const text = String(value || '').replace(/[`*_#<>\[\]]/g, '').replace(/\s+/g, ' ').trim();
	if (!text) return '新对话';
	if (/[^\x00-\x7F]/.test(text)) return Array.from(text).slice(0, 18).join('');
	return text.split(/\s+/).slice(0, 7).join(' ').slice(0, 72);
}

function hasBridgeProtocolChanged(existingBridge, requestedBridge) {
  if (!existingBridge || !requestedBridge) return false;
  const storedProtocol = String(existingBridge.protocol || '');
  const requestedProtocol = String(requestedBridge.protocol || '');
  if (storedProtocol) return storedProtocol !== requestedProtocol;
  // A WebAgent 6.0 build persisted the V3 prompt hash but accidentally
  // omitted `protocol`. Recognize that exact state as V3-compatible so every
  // Harness tool round does not open another DeepSeek conversation. Truly
  // older bridge prompts still have a different hash and rotate once.
  return !existingBridge.prompt_hash
    || String(existingBridge.prompt_hash) !== String(requestedBridge.prompt_hash || '');
}

function obviousSchemaError(argumentsValue, definition) {
  if (!argumentsValue || typeof argumentsValue !== 'object' || Array.isArray(argumentsValue)) return 'arguments must be an object';
  const schema = definition && definition.parameters || {};
  const properties = schema.properties && typeof schema.properties === 'object' ? schema.properties : {};
  const required = Array.isArray(schema.required)
    ? schema.required
    : Object.entries(properties).filter(([, value]) => value && value.required === true).map(([name]) => name);
  const missing = required.filter((name) => argumentsValue[name] == null);
  if (missing.length) return 'missing required argument(s): ' + missing.join(', ');
  for (const [name, value] of Object.entries(argumentsValue)) {
    const expected = properties[name] && properties[name].type;
    if (!expected || value == null) continue;
    const actual = Array.isArray(value) ? 'array' : typeof value;
    if (expected !== actual && !(expected === 'number' && actual === 'number')) return 'argument ' + name + ' must be ' + expected;
  }
  return '';
}

function assessMalformedDshToolCall(output, tools) {
  const text = String(output || '');
	let marker = dsmlMarkerIndex(text);
	if (marker < 0) {
	  // Qwen's page model may ignore the supplied DSML contract and emit its
	  // legacy <tool_call> wrapper (or a raw {name,arguments} object). Treat
	  // that as malformed tool intent so the same schema-guided repair used by
	  // DeepSeek gets one chance to normalize it before DSH sees prose.
	  const legacyMarker = text.search(/<\/?tool_call\b|<\/tool_call>|<think>[\s\S]*?"name"\s*:/i);
	  if (legacyMarker < 0) return null;
	  const fragment = text.slice(legacyMarker);
	  const nameMatch = /"name"\s*:\s*"([^"]+)"/i.exec(fragment);
	  const functionMatch = /<function\s*=\s*([^>\s]+)>/i.exec(fragment);
	  const name = nameMatch && nameMatch[1] || functionMatch && functionMatch[1] || '';
	  const definitions = new Set((Array.isArray(tools) ? tools : []).map((item) => String(item.name || '')));
	  if (!name || !definitions.has(name)) return null;
	  marker = legacyMarker;
	  return { marker, toolName: name, reason: 'legacy provider <tool_call> syntax is not valid DSH DSML' };
	}
  const canonical = canonicalizeDsml(text);
  const invokeCount = (canonical.match(/<dsml_invoke\b/gi) || []).length;
  const calls = parseDsmlCalls(text);
  if (!invokeCount || calls.length !== invokeCount) return { marker, reason: 'incomplete or malformed DSML invoke/parameter tags' };
  const definitions = new Map((Array.isArray(tools) ? tools : []).map((item) => [String(item.name || ''), item]));
  for (const call of calls) {
    const definition = definitions.get(String(call.name || ''));
    if (!definition) return { marker, toolName: String(call.name || ''), reason: 'unknown tool name: ' + String(call.name || '(empty)') };
    const properties = definition.parameters && definition.parameters.properties || {};
    for (const wrapper of ['arguments', 'params']) {
      const wrapped = call.arguments && call.arguments[wrapper];
      if (typeof wrapped !== 'string' || Object.prototype.hasOwnProperty.call(properties, wrapper)) continue;
      const trimmed = wrapped.trim();
      if (!/^\{[\s\S]*\}$/.test(trimmed)) continue;
      try {
        const decoded = JSON.parse(trimmed);
        if (decoded && typeof decoded === 'object' && !Array.isArray(decoded)) {
          return {
            marker,
            toolName: call.name,
            reason: 'the DSML ' + wrapper + ' wrapper contains a JSON object but was emitted as string="true"; its keys (' + Object.keys(decoded).join(', ') + ') are hidden inside a string. Emit name="arguments" with string="false" so the object becomes the tool arguments'
          };
        }
      } catch (_) {}
    }
    const schemaError = obviousSchemaError(call.arguments, definition);
    if (schemaError) return { marker, toolName: call.name, reason: schemaError };
  }
  return null;
}

function jsonObjectsInText(value, limit) {
	const text = String(value || '').slice(0, 128 * 1024);
	const objects = [];
	for (let start = 0; start < text.length && objects.length < (limit || 20); start += 1) {
	  if (text[start] !== '{') continue;
	  let depth = 0, quoted = false, escaped = false;
	  for (let end = start; end < text.length; end += 1) {
		const ch = text[end];
		if (quoted) {
		  if (escaped) escaped = false;
		  else if (ch === '\\') escaped = true;
		  else if (ch === '"') quoted = false;
		  continue;
		}
		if (ch === '"') { quoted = true; continue; }
		if (ch === '{') depth += 1;
		if (ch === '}') depth -= 1;
		if (depth !== 0) continue;
		try { objects.push({ start, end: end + 1, value: JSON.parse(text.slice(start, end + 1)) }); } catch (_) {}
		start = end;
		break;
	  }
	}
	return objects;
}

function normalizeLegacyToolCall(output, tools) {
	const definitions = new Map((Array.isArray(tools) ? tools : []).map((item) => [String(item.name || ''), item]));
	const text = String(output || '');
	const calls = [];
	let marker = -1;
	const add = (name, args, index) => {
	  const definition = definitions.get(String(name || ''));
	  if (!definition || obviousSchemaError(args, definition)) return false;
	  calls.push({ name: String(name), arguments: args });
	  marker = marker < 0 ? index : Math.min(marker, index);
	  return true;
	};
	const functionPattern = /<function\s*=\s*([^>\s]+)>([\s\S]*?)<\/function>/gi;
	let functionMatch;
	while ((functionMatch = functionPattern.exec(text)) !== null) {
	  const name = functionMatch[1];
	  const definition = definitions.get(name);
	  if (!definition) continue;
	  const args = {};
	  const properties = definition.parameters && definition.parameters.properties || {};
	  const parameterPattern = /<parameter\s*=\s*([^>\s]+)>([\s\S]*?)<\/parameter>/gi;
	  let parameter;
	  while ((parameter = parameterPattern.exec(functionMatch[2])) !== null) {
		const key = parameter[1];
		const raw = String(parameter[2] || '').replace(/^\s*\n|\n\s*$/g, '');
		const expected = properties[key] && properties[key].type;
		let value = raw;
		if (expected && expected !== 'string') {
		  try { value = JSON.parse(raw); } catch (_) {}
		}
		args[key] = value;
	  }
	  add(name, args, functionMatch.index);
	}
	// Qwen3.8 naturally emits one JSON object per <tool_call> block, while
	// Qwen3.7 often omits the wrapper and emits consecutive bare objects. Scan
	// every object, accept only advertised tool names, and validate every call
	// against its exact schema before compiling the batch to canonical DSML.
	for (const candidate of jsonObjectsInText(output, 20)) {
	  const object = candidate.value;
	  if (!object || typeof object !== 'object' || Array.isArray(object)) continue;
	  const name = String(object.name || object.tool || '').trim();
	  const definition = definitions.get(name);
	  if (!definition) continue;
	  let args = object.arguments !== undefined ? object.arguments : object.parameters;
	  if (typeof args === 'string') {
		try { args = JSON.parse(args); } catch (_) { continue; }
	  }
	  add(name, args, candidate.start);
	}
	if (!calls.length) return null;
	const unique = [];
	const seen = new Set();
	for (const call of calls) {
	  const signature = call.name + '\n' + JSON.stringify(call.arguments);
	  if (seen.has(signature)) continue;
	  seen.add(signature);
	  unique.push(call);
	}
	return {
	  name: unique[0].name,
	  arguments: unique[0].arguments,
	  calls: unique,
	  marker,
	  dsml: '<｜DSML｜tool_calls>\n' + unique.map((call) => '<｜DSML｜invoke name="' + call.name + '">\n'
		+ '<｜DSML｜parameter name="arguments" string="false">' + JSON.stringify(call.arguments) + '</｜DSML｜parameter>\n'
		+ '</｜DSML｜invoke>').join('\n') + '\n</｜DSML｜tool_calls>'
	};
}

function dshToolRepairPrompt(assessment, tools, options) {
  options = options || {};
  const names = (Array.isArray(tools) ? tools : []).map((tool) => String(tool.name || '')).filter(Boolean).join(', ');
  const target = (Array.isArray(tools) ? tools : []).find((tool) => String(tool.name || '') === String(assessment && assessment.toolName || ''));
  const schema = target && target.parameters ? JSON.stringify(target.parameters).slice(0, 4000) : '';
  const attempt = Math.max(1, Number(options.attempt) || 1);
  const maxAttempts = Math.max(attempt, Number(options.maxAttempts) || MAX_TOOL_PROTOCOL_REPAIRS);
  if (options.protocol === 'qwen-native') return `QWEN_TOOL_REPAIR ${attempt}/${maxAttempts}: The previous native tool call is invalid.
Exact diagnosis: ${assessment.reason}.
${target ? 'Target tool: ' + target.name + '. Required JSON Schema: ' + schema + '\n' : ''}${attempt > 1 ? 'The previous correction repeated an invalid structure. Rebuild the JSON object from the schema instead of copying it.\n' : ''}Resend ONLY one or more native Qwen tool-call blocks; do not repeat the task or add prose. Use exactly:
<tool_call>
{"name":"tool_name","arguments":{"required_argument":"value"}}
</tool_call>
Use one block per call. The arguments (or parameters) value MUST be a JSON object. Allowed tool names: ${names || '(none)'}. Use exact required field names from the schema. No DSML, Python-like calls, or Markdown fence.`;
  return `FORMAT_REPAIR ${attempt}/${maxAttempts}: The previous tool call is invalid.
Exact diagnosis: ${assessment.reason}.
${target ? 'Target tool: ' + target.name + '. Required JSON Schema: ' + schema + '\n' : ''}${attempt > 1 ? 'The previous correction repeated an invalid structure. Rebuild the call from the schema instead of copying it.\n' : ''}Resend ONLY the corrected tool call; do not repeat the task or add prose. Use exactly:
<｜DSML｜tool_calls>
<｜DSML｜invoke name="tool_name">
<｜DSML｜parameter name="arguments" string="false">{"required_argument":"value"}</｜DSML｜parameter>
</｜DSML｜invoke>
</｜DSML｜tool_calls>
The arguments wrapper MUST use string="false". Allowed tool names: ${names || '(none)'}. Use the required field names from the schema. No Markdown fence and no alternative protocol.`;
}

function providerFromModel(model) {
	if (/^qwen\.text\.web(?:\.|$)/.test(String(model))) return 'qwen';
	if (/^qwen\.(?:gateway|search\.web|image\.web)(?:\.|$)/.test(String(model))) return 'rogator';
  if (String(model).startsWith('deepseek.')) return 'deepseek';
  if (String(model).startsWith('qwen.')) return 'qwen';
  if (String(model).startsWith('chatgpt.')) return 'chatgpt';
  return 'api';
}

function runtimeWebModel(model) {
  const id = String(model || '');
  if (['deepseek.fast', 'deepseek.expert', 'deepseek.image', 'deepseek.flash.web', 'deepseek.pro.web', 'deepseek.vision.web'].includes(id)) return 'deepseek.web';
  return id;
}

function normalizeWebProvider(value) {
  const id = String(value || '').trim().toLowerCase().replace(/^model\//, '');
  if (id === 'chatgpt' || id === 'chatgpt.web' || id === 'openai' || id === 'openai.web') return 'chatgpt';
  if (id === 'qwen' || id.startsWith('qwen.')) return 'qwen';
  if (id === 'deepseek' || id.startsWith('deepseek.')) return 'deepseek';
  return id;
}

function requestsImage(messages) {
  const latestUser = (Array.isArray(messages) ? messages : []).slice().reverse().find((message) => message && message.role === 'user');
  const text = String(latestUser && latestUser.content || '');
  return /(?:生图|(?:生成|绘制|画出|设计|创建).{0,16}(?:图片|图像|图标|插画|海报|头像))/i.test(text)
    || /(?:generate|create|draw|design|render|make).{0,24}(?:image|picture|icon|illustration|poster|avatar)/i.test(text);
}

function messageContentText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return content == null ? '' : JSON.stringify(content);
  return content.map((part) => {
    if (!part || typeof part !== 'object') return String(part || '');
    if (part.type === 'text' || part.type === 'input_text') return String(part.text || '');
    return JSON.stringify(part);
  }).filter(Boolean).join('\n');
}

function dataUrlFile(value, index) {
  const match = /^data:([^;,]+);base64,([A-Za-z0-9+/=\r\n]+)$/.exec(String(value || ''));
  if (!match) return null;
  const mime = match[1].toLowerCase();
  if (!mime.startsWith('image/')) return null;
  const extension = mime.split('/')[1].replace('jpeg', 'jpg').replace(/[^a-z0-9]/g, '') || 'png';
  return { name: 'dsh-image-' + (index + 1) + '.' + extension, mime, data: match[2].replace(/\s/g, '') };
}

function imageFileFingerprint(file) {
  if (!file || !file.data) return '';
  return crypto.createHash('sha256').update(String(file.mime || '')).update('\0').update(String(file.data)).digest('hex');
}

function dedupeConversationFiles(files, priorFingerprints) {
  const seen = new Set(Array.isArray(priorFingerprints) ? priorFingerprints.filter(Boolean).map(String) : []);
  const accepted = [];
  for (const file of Array.isArray(files) ? files : []) {
    const fingerprint = imageFileFingerprint(file);
    if (!fingerprint || seen.has(fingerprint)) continue;
    seen.add(fingerprint);
    accepted.push(file);
  }
  return { files: accepted, fingerprints: Array.from(seen).slice(-256) };
}

function collapseRepeatedDomText(value) {
  const text = String(value || '');
  // Some DeepSeek DOM revisions temporarily concatenate the same completed
  // Think subtree more than once. Only remove exact whole-snapshot repetition;
  // ordinary repeated prose remains untouched.
  if (text.length >= 128 && text.length % 2 === 0) {
    const half = text.length / 2;
    if (text.slice(0, half) === text.slice(half)) return text.slice(0, half);
  }
  return text;
}

function messagePayload(content) {
  if (!Array.isArray(content)) return { text: messageContentText(content), files: [] };
  const text = [];
  const files = [];
  for (const part of content) {
    if (!part || typeof part !== 'object') { text.push(String(part || '')); continue; }
    if (part.type === 'text' || part.type === 'input_text') { text.push(String(part.text || '')); continue; }
    const source = part.type === 'image'
      ? (part.data ? 'data:' + String(part.mimeType || part.media_type || 'image/png') + ';base64,' + part.data : part.url)
      : (part.image_url && (part.image_url.url || part.image_url)) || part.image_url || part.url;
    const file = dataUrlFile(source, files.length);
    if (file) files.push(file);
  }
  return { text: text.filter(Boolean).join('\n'), files };
}

class ProviderManager {
  constructor(options) {
    this.apiRegistry = options.apiRegistry || null;
    this.webFactories = options.webFactories || {};
    this.onAuthRequired = options.onAuthRequired || null;
    this.accountManager = options.accountManager || null;
    this.rogator = options.rogator || null;
    this.webStopTimeoutMs = Math.max(100, Math.min(10000, Number(options.webStopTimeoutMs ?? 2500) || 2500));
    const enabledProviders = new Set(Array.isArray(options.webProviders) ? options.webProviders : ['deepseek', 'qwen', 'chatgpt']);
    this.pools = {};
	if (enabledProviders.has('deepseek')) this.pools.deepseek = new WorkerPool({
	  provider: 'deepseek',
	  max: Math.min(16, Math.max(DEEPSEEK_PER_ACCOUNT_CONCURRENCY, Number(options.deepseekMax) || 16)),
	  maxPerAccount: DEEPSEEK_PER_ACCOUNT_CONCURRENCY,
	  min: 0,
	  idleTimeout: 180000,
	  factory: this.webFactories.deepseek
	});
	if (enabledProviders.has('qwen')) this.pools.qwen = new WorkerPool({ provider: 'qwen', max: Math.min(16, Math.max(1, Number(options.qwenMax) || 2)), min: 0, idleTimeout: 120000, factory: this.webFactories.qwen });
    if (enabledProviders.has('chatgpt')) this.pools.chatgpt = new WorkerPool({ provider: 'chatgpt', max: Math.min(4, Math.max(1, Number(options.chatgptMax) || 2)), min: 0, idleTimeout: 180000, factory: this.webFactories.chatgpt });
    this.webModels = options.webModels || [];
    // A cancellation target is keyed by Run identity, never by the focused
    // page or by URL. This prevents one DSH session from stopping another.
    this.activeWebRuns = new Map();
  }

  listModels() {
    const apiModels = this.apiRegistry && this.apiRegistry.listModels ? this.apiRegistry.listModels() : [];
    return this.webModels.concat(apiModels).filter((model) => !model.hidden).map((model) => Object.assign({ object: 'model', created: 0, owned_by: model.providerKey || model.provider || providerFromModel(model.id) }, model));
  }

  status() {
    return Object.assign(
      Object.fromEntries(Object.entries(this.pools).map(([provider, pool]) => [provider, pool.status()])),
      this.rogator ? { qwen_gateway: this.rogator.status() } : {}
    );
  }

  supportedWebProviders() { return Object.keys(this.pools); }

  listAccounts(provider) {
    provider = normalizeWebProvider(provider);
    if (!this.accountManager || typeof this.accountManager.listAccounts !== 'function') return { provider, active_account_id: 'default', data: [{ id: 'default', name: '默认账号', active: true }] };
    return this.accountManager.listAccounts(provider);
  }

  createAccount(provider, name) {
    provider = normalizeWebProvider(provider);
    if (!this.accountManager || typeof this.accountManager.createAccount !== 'function') throw Object.assign(new Error('Provider account management is unavailable'), { code: 'provider_accounts_unavailable', status: 503 });
    return this.accountManager.createAccount(provider, name);
  }

  selectAccount(provider, accountId) {
    provider = normalizeWebProvider(provider);
    if (!this.accountManager || typeof this.accountManager.selectAccount !== 'function') throw Object.assign(new Error('Provider account management is unavailable'), { code: 'provider_accounts_unavailable', status: 503 });
    return this.accountManager.selectAccount(provider, accountId);
  }

  setAccountOrder(provider, order) {
    provider = normalizeWebProvider(provider);
    if (!this.accountManager || typeof this.accountManager.setAccountOrder !== 'function') throw Object.assign(new Error('Provider account ordering is unavailable'), { code: 'provider_accounts_unavailable', status: 503 });
    return this.accountManager.setAccountOrder(provider, order);
  }

  async setBrowserVisibility(provider, visible) {
    provider = normalizeWebProvider(provider);
    const pool = this.pools[provider];
    if (!pool || !this.accountManager || typeof this.accountManager.setBrowserVisible !== 'function') throw Object.assign(new Error('Provider browser visibility is unavailable'), { code: 'provider_visibility_unavailable', status: 503 });
    const status = pool.status();
    if (status.active || status.creating || status.queued) throw Object.assign(new Error('Provider has an active Run; change browser visibility after it finishes'), { code: 'session_busy', status: 409 });
    await pool.destroyIdle();
    return this.accountManager.setBrowserVisible(provider, !!visible);
  }

  removeAccount(provider, accountId) {
    provider = normalizeWebProvider(provider);
    if (!this.accountManager || typeof this.accountManager.removeAccount !== 'function') throw Object.assign(new Error('Provider account management is unavailable'), { code: 'provider_accounts_unavailable', status: 503 });
    return this.accountManager.removeAccount(provider, accountId);
  }

  setApiRegistry(registry) { this.apiRegistry = registry; }
  setToolRegistry(registry) { this.toolRegistry = registry; }

  async inspect(provider) {
    provider = normalizeWebProvider(provider);
    const pool = this.pools[provider];
    if (!pool) throw Object.assign(new Error('Unknown provider: ' + provider + '. Available: ' + this.supportedWebProviders().join(', ')), { code: 'provider_not_found', status: 404 });
    return Promise.all(pool.workers.map(async (entry) => ({
      id: entry.id,
      state: entry.state,
      lease: entry.lease,
      page: entry.raw && entry.raw.inspect ? await entry.raw.inspect() : null
    })));
  }

  async authenticate(provider, context) {
    provider = normalizeWebProvider(provider);
    if (!this.pools[provider]) throw Object.assign(new Error('Unknown provider: ' + provider + '. Available: ' + this.supportedWebProviders().join(', ')), { code: 'provider_not_found', status: 404 });
    if (!this.onAuthRequired) throw Object.assign(new Error('Provider login UI is unavailable'), { code: 'provider_login_unavailable', status: 503 });
    const accountId = context && context.account_id || this.accountManager && this.accountManager.activeAccount ? this.accountManager.activeAccount(provider) : 'default';
    Promise.resolve(this.onAuthRequired(provider, Object.assign({}, context || {}, { account_id: accountId }))).catch(() => {});
    return { provider, account_id: accountId, login_opened: true };
  }

  _capacityAccount(provider, preferredAccount) {
	if (provider !== 'deepseek' || !this.accountManager || typeof this.accountManager.listAccounts !== 'function') return preferredAccount;
	const pool = this.pools[provider];
	if (!pool || typeof pool.accountLoad !== 'function') return preferredAccount;
	const preferredLoad = pool.accountLoad(preferredAccount);
	if (preferredLoad.active + preferredLoad.creating < DEEPSEEK_PER_ACCOUNT_CONCURRENCY) return preferredAccount;
	const listing = this.accountManager.listAccounts(provider) || {};
	const rows = Array.isArray(listing.data) ? listing.data : [];
	const byId = new Map(rows.map((row) => [String(row.id), row]));
	const configured = Array.isArray(listing.failover_order)
	  ? listing.failover_order.map(String).filter((id) => byId.has(id))
	  : [];
	const order = configured.concat(rows.map((row) => String(row.id)).filter((id) => !configured.includes(id)));
	const start = Math.max(0, order.indexOf(preferredAccount));
	for (let offset = 1; offset < order.length; offset += 1) {
	  const accountId = order[(start + offset) % order.length];
	  const account = byId.get(accountId);
	  if (!account || !account.last_login_at || account.profile_exists === false) continue;
	  const limitedUntil = Date.parse(account.limited_until || '');
	  if (Number.isFinite(limitedUntil) && limitedUntil > Date.now()) continue;
	  const load = pool.accountLoad(accountId);
	  if (load.active + load.creating < DEEPSEEK_PER_ACCOUNT_CONCURRENCY) return accountId;
	}
	return preferredAccount;
  }

  async complete(context) {
	if (context.run && context.run.auxiliary_title) {
	  return {
		content: localHarnessTitle(context.messages),
		reasoning: '',
		provider_state: context.session && context.session.provider_state || { conversations: [] }
	  };
	}
    const provider = providerFromModel(context.model);
    if (provider === 'rogator') {
      if (!this.rogator) throw Object.assign(new Error('Qianwen gateway is unavailable'), { code: 'qwen_gateway_unavailable', status: 503 });
      const narrowedTools = context.run && Array.isArray(context.run.provider_tools) && context.run.provider_tools.length
        ? context.run.provider_tools
        : null;
      const gatewayTools = context.run && context.run.agent_mode && (narrowedTools || this.toolRegistry)
        ? (narrowedTools || this.toolRegistry.list(context.session.project_id)).map((tool) => ({
          name: tool.name || tool.id,
          description: tool.description || tool.label,
          parameters: tool.parameters || tool.input_schema
        }))
        : [];
      return this.rogator.complete(Object.assign({}, context, { gateway_tools: gatewayTools }));
    }
    if (provider === 'api') return this._completeApi(context);
    return provider === 'deepseek' || provider === 'qwen'
      ? this._completeWebWithFailover(provider, context)
      : this._completeWeb(provider, context);
  }

  async _completeWebWithFailover(provider, context) {
    const providerLabel = provider === 'qwen' ? 'Qianwen' : 'DeepSeek';
	const existingAccount = context.session && context.session.provider_state && context.session.provider_state.account_id;
	const preferredAccount = context.account_id || existingAccount || (this.accountManager && this.accountManager.activeAccount
	  ? this.accountManager.activeAccount(provider)
	  : 'default');
	const initialAccount = context.account_id
	  ? preferredAccount
	  : this._capacityAccount(provider, preferredAccount);
	if (initialAccount !== preferredAccount && context.onStatus) {
	  context.onStatus(providerLabel + ' 账号 ' + preferredAccount + ' 的 2 个并行槽位已占用，临时使用 ' + initialAccount + '…');
	}
    const attempted = new Set(Array.isArray(context.failover_attempted_accounts) ? context.failover_attempted_accounts : []);
    const busyRetryDelays = Array.isArray(context.provider_busy_retry_delays)
      ? context.provider_busy_retry_delays.slice(0, 5).map((value) => Math.max(0, Number(value) || 0))
      : PROVIDER_BUSY_RETRY_DELAYS_MS;
    const busyRetries = new Map();
    let currentContext = Object.assign({}, context, { account_id: initialAccount });
    while (true) {
      attempted.add(currentContext.account_id);
      try {
        return await this._completeWeb(provider, currentContext);
      } catch (error) {
        if (error && error.code === 'context_length_exceeded' && currentContext.remote_context_rollover_attempted) {
          if (!error.provider_state) error.provider_state = currentContext.session.provider_state || {};
          throw error;
        }
        if (error && error.code === 'context_length_exceeded' && !currentContext.remote_context_rollover_attempted) {
          const currentState = currentContext.session.provider_state || {};
          const rolloverState = error.provider_state || this.invalidateConversation(currentState, currentState.url, error.message);
          if (currentContext.onStatus) currentContext.onStatus(providerLabel + ' 网页会话已达上下文上限，正在换新会话承接当前 DSH 上下文…');
          currentContext = Object.assign({}, currentContext, {
            force_new_conversation: true,
            remote_context_rollover_attempted: true,
            session: Object.assign({}, currentContext.session, { provider_state: rolloverState })
          });
          continue;
        }
        if (error && error.code === 'provider_busy') {
          const retryIndex = busyRetries.get(currentContext.account_id) || 0;
          if (retryIndex < busyRetryDelays.length) {
            const delay = busyRetryDelays[retryIndex];
            busyRetries.set(currentContext.account_id, retryIndex + 1);
            if (currentContext.onStatus) currentContext.onStatus(providerLabel + ' 服务器繁忙，' + String(delay / 1000) + ' 秒后重试（' + String(retryIndex + 1) + '/' + String(busyRetryDelays.length) + '）…');
            await waitForRetry(delay, currentContext.signal);
            currentContext = Object.assign({}, currentContext, {
              session: Object.assign({}, currentContext.session, {
                provider_state: error.provider_state || currentContext.session.provider_state || {}
              })
            });
            continue;
          }
        }
        const busyRetriesExhausted = error && error.code === 'provider_busy'
          && (busyRetries.get(currentContext.account_id) || 0) >= busyRetryDelays.length;
        if (!error || (error.code !== 'out_of_usage' && !busyRetriesExhausted)
            || !this.accountManager
            || typeof this.accountManager.nextAvailableAccount !== 'function') throw error;
        // Account order is a ring. Do not permanently exclude accounts already
        // visited by this Run: after the last account, return to the first one
        // once its busy/cooldown window permits. The Run signal/timeout remains
        // the terminal bound, so this never becomes an uninterruptible loop.
        const nextAccount = this.accountManager.nextAvailableAccount(provider, currentContext.account_id, []);
        if (!nextAccount) {
          const retrySeconds = error.code === 'provider_busy'
            ? 5
            : Math.max(1, Number(error.retry_after_seconds) || 60);
          if (currentContext.onStatus) currentContext.onStatus(providerLabel + ' 暂无其他可用账号，' + String(retrySeconds) + ' 秒后按账号顺序继续尝试…');
          await waitForRetry(retrySeconds * 1000, currentContext.signal);
          if (error.code === 'provider_busy') busyRetries.set(currentContext.account_id, 0);
          currentContext = Object.assign({}, currentContext, {
            session: Object.assign({}, currentContext.session, {
              provider_state: error.provider_state || currentContext.session.provider_state || {}
            })
          });
          continue;
        }
        if (currentContext.onStatus) currentContext.onStatus(error.code === 'provider_busy'
          ? providerLabel + ' 账号 ' + currentContext.account_id + ' 连续繁忙重试已耗尽，正在切换到 ' + nextAccount + '…'
          : providerLabel + ' 账号 ' + currentContext.account_id + ' 已限速，正在切换到 ' + nextAccount + '…');
        if (typeof this.accountManager.selectAccount === 'function') await this.accountManager.selectAccount(provider, nextAccount);
        busyRetries.set(nextAccount, 0);
        currentContext = Object.assign({}, currentContext, {
          account_id: nextAccount,
          failover_attempted_accounts: Array.from(attempted),
          force_new_conversation: true,
          session: Object.assign({}, currentContext.session, {
            provider_state: error.provider_state || currentContext.session.provider_state || {}
          })
        });
      }
    }
  }

  async _completeApi(context) {
    if (!this.apiRegistry) throw Object.assign(new Error('API model is not configured'), { code: 'model_not_configured' });
    if (context.onStatus) context.onStatus('正在连接本地模型…');
    const created = await this.apiRegistry.invoke(context.model, 'newChat', {});
    if (!created.success) throw new Error(created.error || 'Unable to create API conversation');
    const url = created.data.conversationUrl;
    const prior = context.messages.slice(0, -1).map((message) => '[' + message.role + ']\n' + (typeof message.content === 'string' ? message.content : JSON.stringify(message.content)));
    if (prior.length) await this.apiRegistry.invoke(context.model, 'injectHistory', { _conversationUrl: url, segments: prior });
    const latest = context.messages[context.messages.length - 1];
    const result = await this.apiRegistry.invoke(context.model, 'sendMessage', {
      _conversationUrl: url,
      text: typeof latest.content === 'string' ? latest.content : JSON.stringify(latest.content),
      systemPrompt: context.instructions || '',
      timeout: context.timeout,
      stream: true,
      onDelta: context.onProgress
      ,signal: context.signal
      ,tools: context.run.agent_mode && this.toolRegistry ? this.toolRegistry.list(context.session.project_id).map((tool) => ({ name: tool.id, description: tool.label, parameters: tool.input_schema })) : []
    });
    if (!result.success) throw Object.assign(new Error(result.error || 'API model request failed'), { code: result.code || 'provider_request_failed' });
    if (context.onStatus) context.onStatus('正在整理模型回复…');
    const extracted = await this.apiRegistry.invoke(context.model, 'extractResponse', { _conversationUrl: url });
    if (!extracted.success) throw new Error(extracted.error || 'API response extraction failed');
    return { content: extracted.data.markdown || '', reasoning: extracted.data.think || '', provider_state: { provider: 'api', url, last_run_id: context.run.id, last_call_id: context.run.call_id || null } };
  }

  async _completeWeb(provider, context, authAttempt) {
    authAttempt = Number(authAttempt) || 0;
    const requestedModel = context.model;
    const internalModel = runtimeWebModel(requestedModel);
    if (internalModel !== requestedModel) context = Object.assign({}, context, { model: internalModel });
    const pool = this.pools[provider];
    const existing = context.session.provider_state || {};
    const selectedAccount = context.account_id || this.accountManager && typeof this.accountManager.activeAccount === 'function'
      ? (context.account_id || this.accountManager.activeAccount(provider))
      : String(existing.account_id || 'default');
    if (this.accountManager && typeof this.accountManager.listAccounts === 'function') {
      const accountState = this.accountManager.listAccounts(provider);
      const selectedState = accountState && Array.isArray(accountState.data)
        ? accountState.data.find((account) => String(account.id) === String(selectedAccount))
        : null;
      const limitedUntil = selectedState && Date.parse(selectedState.limited_until || '');
      if (Number.isFinite(limitedUntil) && limitedUntil > Date.now()) {
        const retryAfter = Math.max(1, Math.ceil((limitedUntil - Date.now()) / 1000));
        throw Object.assign(new Error('DeepSeek webpage usage limit reached; switch accounts or retry after ' + retryAfter + ' seconds'), {
          code: 'out_of_usage',
          status: 429,
          retry_after_seconds: retryAfter,
          provider_state: Object.assign({}, existing, {
            account_id: selectedAccount,
            rate_limited_until: new Date(limitedUntil).toISOString()
          })
        });
      }
    }
    const accountChanged = existing.provider === provider && String(existing.account_id || 'default') !== String(selectedAccount);
    const bridgeCodecOptions = provider === 'qwen' ? { protocol: 'qwen-native' } : { protocol: 'dsml' };
    const requestedBridgeState = context.run.prompt_passthrough ? stateFor(context.messages, context.run.provider_tools, bridgeCodecOptions) : null;
    const bridgeProtocolChanged = hasBridgeProtocolChanged(existing.dsh_bridge, requestedBridgeState);
    // A DSH user may switch the model on an existing Harness session. Remote
    // URLs are provider-owned; never navigate Qianwen/ChatGPT workers to the
    // previous DeepSeek URL (or vice versa). A cross-provider switch starts a
    // fresh remote conversation with the full ordered DSH envelope.
    const activeUrl = context.force_new_conversation || accountChanged || bridgeProtocolChanged || (existing.provider && existing.provider !== provider)
      ? ''
      : (existing.url || '');
    const lease = await pool.acquire({
      provider,
      session_id: context.session.id,
      run_id: context.run.id,
      call_id: context.run.call_id || null,
      url: activeUrl || null,
      account_id: selectedAccount
    }, context.signal);
    const active = {
      provider,
      model: internalModel,
      session_id: context.session.id,
      run_id: context.run.id,
      call_id: context.run.call_id || null,
      url: activeUrl || '',
      account_id: selectedAccount,
      lease,
      worker: lease.worker,
      stopPromise: null
    };
    this.activeWebRuns.set(context.run.id, active);
    const stopOnAbort = () => { void this._stopActiveWebRun(context.run.id); };
    if (context.signal) context.signal.addEventListener('abort', stopOnAbort, { once: true });
    let authError = null;
    try {
      const worker = lease.worker;
      if (worker.ensureAuthenticated) await worker.ensureAuthenticated(context.signal);
      let url = activeUrl;
      let provisionalState = existing;
      const latest = context.messages[context.messages.length - 1];
      const latestPayload = messagePayload(latest.content);
      const rawText = latestPayload.text;
      let files = latestPayload.files;
      let text = latest.role === 'user' && context.instructions
        ? '<system_instructions>\n' + context.instructions + '\n</system_instructions>\n\n' + rawText
        : rawText;
      let dshEnvelope = null;
      if (context.run.prompt_passthrough) {
        dshEnvelope = url
          ? continuationEnvelope(context.messages, context.run.provider_tools, existing.dsh_bridge, bridgeCodecOptions)
          : initialEnvelope(context.messages, context.run.provider_tools, bridgeCodecOptions);
        text = dshEnvelope.text;
        const envelopeMessages = dshEnvelope.envelopeMessages || [dshEnvelope.message];
        files = envelopeMessages.flatMap((message) => messagePayload(message && message.content).files);
        const deduplicated = dedupeConversationFiles(files, existing && existing.dsh_bridge && existing.dsh_bridge.uploaded_image_hashes);
        files = deduplicated.files;
        dshEnvelope.state.uploaded_image_hashes = deduplicated.fingerprints;
      } else if (!url && (latest.role !== 'user' || context.force_new_conversation)) {
        const history = context.messages.map((message) => {
          const content = typeof message.content === 'string' ? message.content : JSON.stringify(message.content);
          const calls = Array.isArray(message.tool_calls) && message.tool_calls.length
            ? '\n<tool_calls>' + JSON.stringify(message.tool_calls) + '</tool_calls>'
            : '';
          return '<message role="' + message.role + '">\n' + content + calls + '\n</message>';
        }).join('\n');
        text = (context.instructions ? '<system_instructions>\n' + context.instructions + '\n</system_instructions>\n\n' : '')
          + '<conversation_context>\n' + history + '\n</conversation_context>\n\n请根据以上任务和工具结果继续完成回答。';
      }
      const deepThink = provider === 'deepseek' && !!context.run.deep_think;
      const webSearch = provider === 'deepseek' && !!context.run.web_search;
      if (url) {
        if (!this._validWebUrl(provider, url)) throw Object.assign(new Error('Stored provider URL is invalid'), { code: 'invalid_provider_url' });
        await worker.navigate(url, context.signal);
        await worker.assertConversation(url);
        if (provider === 'deepseek') {
          const searchState = await worker.server.invoke(context.model, 'setWebSearch', { enable: webSearch, _conversationUrl: url });
          if (!searchState || !searchState.success) {
            if (webSearch) throw Object.assign(new Error(searchState && searchState.error || 'Unable to enable DeepSeek Web Search'), { code: 'provider_search_state_failed' });
            // Search is an optional page capability for an ordinary model
            // turn. A provider UI regression must not make every DSH session
            // unusable merely because the off-state could not be confirmed.
            // Continue the turn and surface a warning; explicit search still
            // fails closed above because silently omitting requested research
            // would be incorrect.
            if (context.onStatus) context.onStatus('DeepSeek 联网搜索关闭状态未能确认，已继续发送普通对话。');
          }
          await worker.server.invoke(context.model, 'setDeepThink', { enable: deepThink, _conversationUrl: url });
		} else if (provider === 'qwen') {
          // Qianwen persists the most recently chosen model per page. Reassert
          // the Run's concrete model before every continuation so an idle
          // Worker reused by another session cannot leak its previous choice.
		  const selected = await worker.server.invoke(context.model, 'setModelMode', { _conversationUrl: url });
		  if (!selected || !selected.success) throw Object.assign(new Error(selected && selected.error || 'Unable to select Qwen model'), { code: 'provider_model_selection_failed' });
		  const reasoning = await worker.server.invoke(context.model, 'setReasoningMode', {
			reasoningEffort: context.run.reasoning_effort || 'none',
			_conversationUrl: url
		  });
		  if (!reasoning || !reasoning.success) throw Object.assign(new Error(reasoning && reasoning.error || 'Unable to select Qwen reasoning mode'), { code: 'provider_reasoning_selection_failed' });
		}
        const sent = await worker.server.invoke(context.model, 'sendMessage', { text, files, promptPassthrough: !!context.run.prompt_passthrough, _conversationUrl: url });
        if (!sent || !sent.success) {
          const code = sent && sent.code || 'provider_send_failed';
          const failure = Object.assign(new Error(sent && sent.error || 'Web send failed'), {
            code,
            status: code === 'out_of_usage' ? 429 : code === 'provider_busy' ? 503 : code === 'context_length_exceeded' ? 400 : undefined,
            retry_after_seconds: sent && sent.retryAfter
          });
          if (code === 'context_length_exceeded') failure.provider_state = this.invalidateConversation(existing, url, failure.message);
          throw failure;
        }
      } else {
		const created = await worker.server.invoke(context.model, 'newChat', { userText: text, files, deepThink, webSearch, reasoningEffort: context.run.reasoning_effort || 'none', timeout: context.timeout });
        if (!created || !created.success) {
          const code = created && created.code || 'provider_send_failed';
          throw Object.assign(new Error(created && created.error || 'Web conversation creation failed'), {
            code,
            status: code === 'out_of_usage' ? 429 : code === 'provider_busy' ? 503 : code === 'context_length_exceeded' ? 400 : undefined,
            retry_after_seconds: created && created.retryAfter
          });
        }
        url = await worker.waitForConversationUrl(created.data && created.data.conversationUrl, context.signal);
      }
      active.url = url;
      if (context.onStatus) context.onStatus(provider === 'deepseek' ? 'DeepSeek 正在生成回复…' : provider === 'qwen' ? '千问正在生成回复…' : 'ChatGPT 正在生成回复…');
      provisionalState = this._providerState(existing, {
        provider,
        account_id: selectedAccount,
        url,
        generation: context.session.context_state && context.session.context_state.generation || 0,
        last_worker_id: lease.workerId,
        last_lease_id: lease.id,
        last_run_id: context.run.id,
        last_call_id: context.run.call_id || null,
        ...(dshEnvelope ? { dsh_bridge: {
          version: dshEnvelope.state.version,
          protocol: dshEnvelope.state.protocol,
          prompt_hash: dshEnvelope.state.prompt_hash,
            tools_hash: dshEnvelope.state.tools_hash,
            message_count: dshEnvelope.state.message_count,
            message_signatures: dshEnvelope.state.message_signatures,
            uploaded_image_hashes: dshEnvelope.state.uploaded_image_hashes
        } } : {})
      });
      if (context.onProviderState) await context.onProviderState(provisionalState);
      const progress = this._startProgressPoll(worker, context, url);
      let waited;
      try {
        waited = await worker.server.invoke(context.model, 'waitForDone', {
          timeout: context.timeout,
          initialActivityTimeout: 20000,
          allowReasoningToolCall: !!context.run.prompt_passthrough,
          signal: context.signal,
          _conversationUrl: url
        });
      } finally {
        await progress.stop(true);
      }
      if (waited && waited.success && waited.data && Number(waited.data.continuations) > 0 && context.onStatus) {
        context.onStatus('DeepSeek 已自动继续生成 ' + String(waited.data.continuations) + ' 次');
      }
      if (waited && waited.success && waited.data && Number(waited.data.reasoningLoopRecoveries) > 0 && context.onStatus) {
        context.onStatus('DeepSeek 已自动终止重复循环并纠偏 ' + String(waited.data.reasoningLoopRecoveries) + ' 次');
      }
	  if ((provider === 'deepseek' || provider === 'qwen') && context.run.prompt_passthrough) {
        const recoveryDelays = Array.isArray(context.empty_response_recovery_delays)
          ? context.empty_response_recovery_delays.slice(0, 3).map((value) => Math.max(0, Number(value) || 0))
          : [2000, 4000, 8000];
        for (let recoveryAttempt = 0;
          recoveryAttempt < recoveryDelays.length
            && (!waited || !waited.success)
            && waited && waited.code === 'provider_sse_empty';
          recoveryAttempt += 1) {
		  if (context.onStatus) context.onStatus((provider === 'qwen' ? 'Qianwen' : 'DeepSeek') + ' 返回空响应，正在重发当前增量（' + String(recoveryAttempt + 1) + '/' + String(recoveryDelays.length) + '）…');
          // An empty completion also means DeepSeek did not persist the user
          // bubble. Let the SPA roll back that failed turn before resending
          // the exact ordered DSH delta, including its tool results.
          await new Promise((resolve) => setTimeout(resolve, recoveryDelays[recoveryAttempt]));
          const recoveryText = recoveryAttempt === 0
            ? text
            : text + '\n\n<webagent_transport_retry attempt="' + String(recoveryAttempt + 1) + '">The previous submission returned an empty webpage response. Process the ordered DSH delta above now; do not return an empty response.</webagent_transport_retry>';
          const recovered = await worker.server.invoke(context.model, 'sendMessage', {
            text: recoveryText,
            files: [],
            promptPassthrough: true,
            _conversationUrl: url
          });
          if (!recovered || !recovered.success) {
            waited = recovered || { success: false, code: 'provider_sse_empty', error: 'DeepSeek empty-response recovery send failed' };
            continue;
          }
          const recoveryProgress = this._startProgressPoll(worker, context, url);
          try {
            waited = await worker.server.invoke(context.model, 'waitForDone', {
              timeout: context.timeout,
              initialActivityTimeout: 20000,
              allowReasoningToolCall: true,
              signal: context.signal,
              _conversationUrl: url
            });
          } finally {
            await recoveryProgress.stop(true);
          }
        }
      }
      if (!waited || !waited.success) {
        const failure = Object.assign(new Error(waited && waited.error || 'Web response timeout'), {
          code: waited && waited.code || 'provider_timeout',
          status: waited && waited.code === 'out_of_usage' ? 429 : waited && waited.code === 'provider_busy' ? 503 : waited && waited.code === 'context_length_exceeded' ? 400 : undefined,
          retry_after_seconds: waited && waited.retryAfter
        });
        if (failure.code === 'run_cancelled') throw Object.assign(failure, { name: 'AbortError' });
        if (failure.code === 'out_of_usage' || failure.code === 'provider_busy') {
          if (failure.code === 'out_of_usage' && this.accountManager && typeof this.accountManager.markAccountLimited === 'function') {
            this.accountManager.markAccountLimited(provider, selectedAccount, failure.retry_after_seconds || 60);
          }
          // The webpage rejected this turn but the conversation is still valid.
          // Roll back only the DSH delta checkpoint so a later retry can resend
          // the same logical turn; never schedule the remote history for deletion.
          failure.provider_state = Object.assign({}, provisionalState, {
            dsh_bridge: existing && existing.dsh_bridge,
            last_failure_url: url,
            last_failure: failure.message,
            rate_limited_until: new Date(Date.now() + Math.max(1, Number(failure.retry_after_seconds) || 60) * 1000).toISOString()
          });
        } else if (failure.code === 'context_length_exceeded') {
          // DSH recognizes this canonical OpenAI-compatible overflow code and
          // runs its own compaction transaction before retrying. The webpage
          // conversation itself is already full, so retire it and force that
          // compacted retry onto a fresh remote conversation.
          failure.provider_state = this.invalidateConversation(provisionalState, url, failure.message);
        } else if (failure.code === 'provider_sse_empty') {
          // The empty request was not persisted by the webpage. Keep the
          // remote URL, but roll the DSH delta checkpoint back so a later
          // external retry resends the missing tool result/context instead of
          // advancing with only a user-authored “continue”.
          failure.provider_state = Object.assign({}, provisionalState, {
            dsh_bridge: existing && existing.dsh_bridge,
            last_failure_url: url,
            last_failure: failure.message
          });
        } else if (failure.code === 'provider_timeout' || failure.code === 'provider_incomplete' || failure.code === 'provider_send_unconfirmed') {
          failure.provider_state = this.invalidateConversation(provisionalState, url, failure.message);
        }
        throw failure;
      }
      if (provider === 'chatgpt' && worker.waitForDurableConversationUrl) url = await worker.waitForDurableConversationUrl(context.signal);
      if (context.onStatus) context.onStatus('正在整理最终回复…');
      let extracted;
      if (provider === 'qwen') {
        const detected = await worker.server.invoke(context.model, 'detectResponseType', { _conversationUrl: url });
        // waitForDone observes the card at the moment it first appears. Qwen may
        // briefly replace that DOM subtree during hydration, so do not discard
        // the durable signal because a subsequent one-shot probe sees "text".
        const hasImages = context.model === 'qwen.image.web'
          || requestsImage(context.messages)
          || !!(waited.data && waited.data.hasImages)
          || !!(detected && detected.success && detected.data && detected.data.type === 'image');
        if (hasImages) {
          const imageWait = await worker.server.invoke(context.model, 'waitForImageDone', { timeout: context.timeout, _conversationUrl: url });
          if (!imageWait || !imageWait.success || !imageWait.data || !imageWait.data.done) {
            throw Object.assign(new Error('Qwen image generation timed out'), { code: 'provider_timeout' });
          }
          extracted = await worker.server.invoke(context.model, 'extractImageResponse', { timeout: 20000, _conversationUrl: url });
        }
      }
      if (!extracted) extracted = await worker.server.invoke(context.model, 'extractResponse', { timeout: 20000, allowReasoningToolCall: !!context.run.prompt_passthrough, _conversationUrl: url });
      if (!extracted || !extracted.success) throw new Error(extracted && extracted.error || 'Web response extraction failed');
	  if ((provider === 'deepseek' || provider === 'qwen') && context.run.prompt_passthrough) {
		let originalMarkdown = String(extracted.data && extracted.data.markdown || '');
		const normalizedLegacy = provider === 'qwen'
		  ? normalizeLegacyToolCall(originalMarkdown, context.run.provider_tools)
		  : null;
		if (normalizedLegacy) {
		  originalMarkdown = normalizedLegacy.dsml;
		  extracted = Object.assign({}, extracted, {
			data: Object.assign({}, extracted.data, {
			  markdown: originalMarkdown,
			  answerConfirmed: true,
			  toolProtocolNormalized: true
			})
		  });
		}
		let assessment = assessMalformedDshToolCall(originalMarkdown, context.run.provider_tools);
        if (assessment) {
          const originalAssessment = assessment;
          // A repair turn should spend its budget reproducing the call syntax,
          // not reasoning about the task again. The next normal Run reasserts
          // the user's requested thinking mode before sending.
		  if (provider === 'deepseek') await worker.server.invoke(context.model, 'setDeepThink', { enable: false, _conversationUrl: url });
          let repaired = null;
          let repairedMarkdown = '';
          for (let repairAttempt = 1; repairAttempt <= MAX_TOOL_PROTOCOL_REPAIRS && assessment; repairAttempt += 1) {
            if (context.onStatus) context.onStatus('工具调用格式错误，正在快速修复（' + String(repairAttempt) + '/' + String(MAX_TOOL_PROTOCOL_REPAIRS) + '）：' + assessment.reason);
            const repairSent = await worker.server.invoke(context.model, 'sendMessage', {
              text: dshToolRepairPrompt(assessment, context.run.provider_tools, { attempt: repairAttempt, maxAttempts: MAX_TOOL_PROTOCOL_REPAIRS, protocol: provider === 'qwen' ? 'qwen-native' : 'dsml' }),
              files: [],
              promptPassthrough: true,
              _conversationUrl: url
            });
            if (!repairSent || !repairSent.success) throw Object.assign(new Error(repairSent && repairSent.error || 'Tool-call format repair send failed'), {
              code: repairSent && repairSent.code || 'provider_tool_protocol_invalid'
            });
            const repairProgress = this._startProgressPoll(worker, context, url);
            let repairWaited;
            try {
              repairWaited = await worker.server.invoke(context.model, 'waitForDone', {
                timeout: Math.min(Number(context.timeout) || 180000, 180000),
                initialActivityTimeout: 20000,
                allowReasoningToolCall: true,
                signal: context.signal,
                _conversationUrl: url
              });
            } finally {
              await repairProgress.stop(true);
            }
            if (!repairWaited || !repairWaited.success) throw Object.assign(new Error(repairWaited && repairWaited.error || 'Tool-call format repair failed'), {
              code: repairWaited && repairWaited.code || 'provider_tool_protocol_invalid',
              retry_after_seconds: repairWaited && repairWaited.retryAfter
            });
            repaired = await worker.server.invoke(context.model, 'extractResponse', { timeout: 20000, allowReasoningToolCall: true, _conversationUrl: url });
            if (!repaired || !repaired.success) throw Object.assign(new Error(repaired && repaired.error || 'Tool-call format repair extraction failed'), { code: 'provider_tool_protocol_invalid' });
            repairedMarkdown = String(repaired.data && repaired.data.markdown || '');
            assessment = assessMalformedDshToolCall(repairedMarkdown, context.run.provider_tools);
          }
          if (assessment) throw Object.assign(new Error('Tool-call format remained invalid after ' + String(MAX_TOOL_PROTOCOL_REPAIRS) + ' repairs: ' + assessment.reason), { code: 'provider_tool_protocol_invalid' });
          const narrative = originalMarkdown.slice(0, originalAssessment.marker).trim();
          extracted = Object.assign({}, repaired, {
            data: Object.assign({}, repaired.data, {
              markdown: [narrative, repairedMarkdown].filter(Boolean).join('\n\n'),
              answerConfirmed: true,
              toolProtocolRepaired: true
            })
          });
        }
      }
      if (provider === 'deepseek' && extracted.data && extracted.data.answerConfirmed === false) {
        throw Object.assign(new Error('DeepSeek finished without a distinct final answer; reasoning was not promoted to output'), { code: 'provider_incomplete' });
      }
      let metadata = null;
      let detectedContext = null;
      try {
        const response = await worker.server.invoke(context.model, 'getConversationMetadata', { _conversationUrl: url });
        if (response && response.success && response.data && (!response.data.url || normalizeUrl(response.data.url) === normalizeUrl(url))) metadata = response.data;
      } catch (_) {}
      try { if (worker.detectContextWindow) detectedContext = await worker.detectContextWindow(); } catch (_) {}
      if (provider === 'chatgpt' && !this._validWebUrl('chatgpt', url)) throw Object.assign(new Error('Durable ChatGPT conversation URL was not confirmed'), { code: 'conversation_url_unconfirmed' });
      return {
        content: extracted.data && extracted.data.markdown || '',
        reasoning: extracted.data && extracted.data.think || '',
        images: extracted.data && extracted.data.images || [],
        remote_title: metadata && metadata.title || '',
        provider_state: this._providerState(provisionalState, {
          provider, url, generation: context.session.context_state && context.session.context_state.generation || 0,
          context_window: detectedContext && detectedContext.context_window,
          context_window_source: detectedContext && detectedContext.source,
          last_worker_id: lease.workerId, last_lease_id: lease.id, last_run_id: context.run.id, last_call_id: context.run.call_id || null,
          ...(dshEnvelope ? { dsh_bridge: provisionalState.dsh_bridge } : {})
        })
      };
    } catch (error) {
      if (error && error.code === 'out_of_usage' && this.accountManager && typeof this.accountManager.markAccountLimited === 'function') {
        this.accountManager.markAccountLimited(provider, selectedAccount, error.retry_after_seconds || 60);
      }
      if (error && error.code === 'provider_auth_required' && authAttempt < 1 && this.onAuthRequired) {
        authError = error;
      } else {
      if (lease.worker && lease.worker.isDestroyed && lease.worker.isDestroyed()) await lease.destroy();
      throw error;
      }
    } finally {
      if (context.signal) context.signal.removeEventListener('abort', stopOnAbort);
      if (this.activeWebRuns.get(context.run.id) === active) this.activeWebRuns.delete(context.run.id);
      await lease.release();
    }
    if (authError) {
      if (context.onAuthRequired) context.onAuthRequired(provider);
      await this.onAuthRequired(provider, { model: context.model, session_id: context.session.id, run_id: context.run.id, account_id: selectedAccount });
      if (context.onAuthenticated) context.onAuthenticated(provider);
      return this._completeWeb(provider, context, authAttempt + 1);
    }
  }

  async stop(context) {
    const provider = providerFromModel(context.model);
    if (provider === 'rogator') return !!(this.rogator && this.rogator.stopRun(context.run && context.run.id || context.run_id));
    if (provider === 'api') return false;
    return this._stopActiveWebRun(context.run && context.run.id || context.run_id);
  }

  async _stopActiveWebRun(runId) {
    const active = this.activeWebRuns.get(runId);
    if (!active) return false;
    if (!active.lease.assertOwner({
      provider: active.provider,
      session_id: active.session_id,
      run_id: active.run_id,
      call_id: active.call_id
    })) return false;
    if (!active.stopPromise) {
      let timer = null;
      const stopAttempt = Promise.resolve(active.worker.server.invoke(active.model, 'stopGeneration', {
        _conversationUrl: active.url
      })).then((result) => ({ settled: true, success: !!(result && result.success) }))
        .catch(() => ({ settled: true, success: false }));
      const timeout = new Promise((resolve) => {
        timer = setTimeout(() => resolve({ settled: false, success: false }), this.webStopTimeoutMs);
        if (timer.unref) timer.unref();
      });
      active.stopPromise = Promise.race([stopAttempt, timeout]).then(async (outcome) => {
        if (timer) clearTimeout(timer);
        // executeJavaScript can remain pending while Qwen replaces its answer
        // frame. A cancelled Run must not retain the session write lock
        // indefinitely. Destroy only this Run's lease-owned worker when the
        // trusted stop action cannot be confirmed in time.
        if (!outcome.success) await active.lease.destroy().catch(() => {});
        return outcome.success;
      });
    }
    return active.stopPromise;
  }

  async summarizeForCompaction(context) {
    const provider = providerFromModel(context.model);
    if (provider === 'rogator') {
      if (!this.rogator) throw Object.assign(new Error('Qianwen gateway is unavailable'), { code: 'qwen_gateway_unavailable' });
      return this.rogator.complete(Object.assign({}, context, {
        messages: [{ role: 'user', content: 'Create a concise JSON ContextPack for continuing this conversation. Use keys: goals, constraints, decisions, key_files, tool_results, unresolved, recent. Do not add prose outside JSON.' }],
        instructions: 'Preserve facts and unresolved work; do not perform tools.',
        onProgress: null,
        onReasoningProgress: null,
        onStatus: null
      }));
    }
    if (provider === 'api') throw Object.assign(new Error('Remote webpage summary is not available for API providers'), { code: 'compaction_summary_unsupported' });
    const prompt = `Create a concise JSON ContextPack for continuing this conversation in a new thread. Use keys: goals, constraints, decisions, key_files, tool_results, unresolved, recent. Do not add prose outside JSON.`;
    return this._completeWeb(provider, Object.assign({}, context, {
      messages: [{ role: 'user', content: prompt }],
      instructions: 'This is a WebAgent context rollover. Preserve facts and unresolved work; do not perform tools.',
      force_new_conversation: false,
      onProgress: null,
      onStatus: null
    }));
  }

  async cleanupSession(session, runId, callId) {
    const state = session.provider_state || {};
    // Older web sessions can retain a temporary `WEB:<id>` placeholder beside
    // the real conversation URL.  It is intentionally rejected by
    // _validWebUrl, so never let that stale bookkeeping entry turn an otherwise
    // successful remote cleanup into an all-or-nothing failure.
    const targets = this._conversationTargets(state).filter((target) =>
      this._validWebUrl(target.provider || state.provider, target.url)
    );
    if (!targets.length || !this.pools[state.provider]) return false;
    if (targets.length > 1) {
      const failures = [];
      for (const target of targets) {
        try { await this.deleteRemoteConversation(target.provider || state.provider, target.url, target.account_id); }
        catch (error) { failures.push({ url: target.url, error: error.message }); }
      }
      if (failures.length) {
        const error = Object.assign(new Error('One or more remote conversations could not be deleted'), { code: 'remote_delete_failed', failures });
        throw error;
      }
      return true;
    }
    const targetUrl = targets[0].url;
    const targetAccount = targets[0].account_id || state.account_id || 'default';
    if (!this._validWebUrl(state.provider, targetUrl)) return false;
    if (state.last_run_id && runId && state.last_run_id !== runId) return false;
    if (state.last_call_id && callId && state.last_call_id !== callId) return false;
    const lease = await this.pools[state.provider].acquire({
      provider: state.provider,
      session_id: session.id,
      run_id: runId || state.last_run_id,
      call_id: callId || null,
      url: targetUrl,
      account_id: targetAccount
    });
    try {
      if (!lease.assertOwner({ provider: state.provider, session_id: session.id, run_id: runId || state.last_run_id, call_id: callId || null, url: targetUrl })) return false;
      await lease.worker.navigate(targetUrl);
      await lease.worker.assertConversation(targetUrl);
      const result = await lease.worker.server.invoke(runtimeWebModel(session.model), 'deleteConversation', { convid: targetUrl, _conversationUrl: targetUrl });
      return !!(result && result.success);
    } finally {
      await lease.release();
    }
  }

  async listRemoteConversations(provider, accountId) {
    provider = normalizeWebProvider(provider);
    const pool = this.pools[provider];
    if (!pool) throw Object.assign(new Error('Unknown provider: ' + provider), { code: 'provider_not_found', status: 404 });
    accountId = accountId || this.accountManager && this.accountManager.activeAccount ? this.accountManager.activeAccount(provider) : 'default';
    const lease = await pool.acquire({ provider, session_id: 'maintenance:' + provider, run_id: 'list:' + Date.now(), call_id: null, url: null, account_id: accountId });
    try {
      if (lease.worker.ensureAuthenticated) await lease.worker.ensureAuthenticated();
      const model = provider === 'deepseek' ? 'deepseek.web' : provider === 'qwen' ? 'qwen.default' : 'chatgpt.web';
      const result = await lease.worker.server.invoke(model, 'listConversations', {});
      if (!result || !result.success) throw Object.assign(new Error(result && result.error || 'Unable to list remote conversations'), { code: 'provider_list_failed', status: 502 });
      return (Array.isArray(result.data) ? result.data : []).filter((row) => row && this._validWebUrl(provider, row.url));
    } finally {
      await lease.release();
    }
  }

  async deleteRemoteConversation(provider, targetUrl, accountId) {
    provider = normalizeWebProvider(provider);
    const pool = this.pools[provider];
    if (!pool) throw Object.assign(new Error('Unknown provider: ' + provider), { code: 'provider_not_found', status: 404 });
    if (!this._validWebUrl(provider, targetUrl)) throw Object.assign(new Error('Invalid remote conversation URL'), { code: 'invalid_provider_url', status: 400 });
    const runId = 'delete:' + Date.now();
    accountId = accountId || this.accountManager && this.accountManager.activeAccount ? this.accountManager.activeAccount(provider) : 'default';
    const lease = await pool.acquire({ provider, session_id: 'maintenance:' + provider, run_id: runId, call_id: null, url: targetUrl, account_id: accountId });
    try {
      if (lease.worker.ensureAuthenticated) await lease.worker.ensureAuthenticated();
      await lease.worker.navigate(targetUrl);
      await lease.worker.assertConversation(targetUrl);
      const model = provider === 'deepseek' ? 'deepseek.web' : provider === 'qwen' ? 'qwen.default' : 'chatgpt.web';
      const result = await lease.worker.server.invoke(model, 'deleteConversation', { convid: targetUrl, _conversationUrl: targetUrl });
      if (!result || !result.success) throw Object.assign(new Error(result && result.error || 'Remote conversation deletion failed'), { code: 'provider_delete_failed', status: 502 });
      return { provider, url: targetUrl, deleted: true };
    } finally {
      await lease.release();
    }
  }

  async retireConversation(previousState, activeState) {
    if (!previousState || !previousState.url || previousState.url === (activeState && activeState.url)) return { deleted: true, skipped: true };
    return this.deleteRemoteConversation(previousState.provider, previousState.url, previousState.account_id);
  }

  markConversationRetired(state, targetUrl, result) {
    const next = Object.assign({}, state || {});
    next.conversations = (Array.isArray(next.conversations) ? next.conversations : []).map((item) => {
      if (normalizeUrl(item.url) !== normalizeUrl(targetUrl)) return item;
      return Object.assign({}, item, {
        status: result && result.deleted ? 'deleted' : 'pending_cleanup',
        deleted_at: result && result.deleted ? new Date().toISOString() : null,
        delete_error: result && result.deleted ? '' : String(result && result.error || 'Remote cleanup failed')
      });
    });
    if (result && result.deleted && normalizeUrl(next.url) === normalizeUrl(targetUrl)) next.url = '';
    return next;
  }

  async retryPendingCleanup(state) {
    let next = Object.assign({}, state || {}, { conversations: Array.isArray(state && state.conversations) ? state.conversations.slice() : [] });
    for (const item of next.conversations.filter((row) => row.status === 'pending_cleanup')) {
      try {
        const result = await this.deleteRemoteConversation(item.provider || next.provider, item.url);
        next = this.markConversationRetired(next, item.url, result);
      } catch (error) {
        next = this.markConversationRetired(next, item.url, { deleted: false, error: error.message });
      }
    }
    return next;
  }

  async close() {
    await Promise.all([
      ...Object.values(this.pools).map((pool) => pool.close()),
      ...(this.rogator ? [this.rogator.close()] : [])
    ]);
  }

  _providerState(existing, current) {
    const conversations = Array.isArray(existing && existing.conversations) ? existing.conversations.slice() : [];
    const normalized = normalizeUrl(current.url);
    const found = conversations.findIndex((item) => normalizeUrl(item.url) === normalized);
    const record = {
      provider: current.provider,
      account_id: current.account_id || existing && existing.account_id || 'default',
      url: current.url,
      generation: current.generation || 0,
      run_id: current.last_run_id,
      call_id: current.last_call_id,
      worker_id: current.last_worker_id,
      lease_id: current.last_lease_id,
      status: 'active',
      created_at: found >= 0 ? conversations[found].created_at : new Date().toISOString(),
      delete_error: ''
    };
    conversations.forEach((item) => { if (item.status === 'active' && normalizeUrl(item.url) !== normalized) item.status = 'retiring'; });
    if (found >= 0) conversations[found] = Object.assign({}, conversations[found], record);
    else conversations.push(record);
    return Object.assign({}, existing || {}, current, { conversations });
  }

  invalidateConversation(existing, url, reason) {
    const normalized = normalizeUrl(url);
    const conversations = (Array.isArray(existing && existing.conversations) ? existing.conversations : []).map((item) => {
      if (normalizeUrl(item && item.url) !== normalized || item.status === 'deleted') return Object.assign({}, item);
      return Object.assign({}, item, { status: 'pending_cleanup', delete_error: String(reason || 'provider conversation invalidated') });
    });
    return Object.assign({}, existing || {}, {
      url: '',
      conversations,
      last_failure_url: url || '',
      last_failure: String(reason || 'provider conversation invalidated')
    });
  }

  _conversationTargets(state) {
    const rows = Array.isArray(state && state.conversations) ? state.conversations : [];
    const targets = rows.filter((item) => item && item.url && item.status !== 'deleted').map((item) => ({ provider: item.provider || state.provider, url: item.url, account_id: item.account_id || state.account_id || 'default' }));
    if (state && state.url && !targets.some((item) => normalizeUrl(item.url) === normalizeUrl(state.url))) targets.push({ provider: state.provider, url: state.url, account_id: state.account_id || 'default' });
    const seen = new Set();
    return targets.filter((item) => { const key = item.provider + ':' + item.account_id + ':' + normalizeUrl(item.url); if (seen.has(key)) return false; seen.add(key); return true; });
  }

  _startProgressPoll(worker, context, url) {
    let stopped = false;
    let active = null;
    const read = async () => {
      if (context.signal && context.signal.aborted) return;
      try {
        const response = await worker.server.invoke(context.model, 'peekResponse', { _conversationUrl: url });
        const text = String(response && response.data && (response.data.text || response.data.markdown) || '');
        const reasoning = collapseRepeatedDomText(response && response.data && (response.data.reasoning || response.data.think) || '');
        if (reasoning && context.onReasoningProgress) context.onReasoningProgress(reasoning);
        if (text && context.onProgress) context.onProgress(text);
      } catch (_) {
        // DOM snapshots are best-effort. The final extractor remains authoritative.
      }
    };
    const tick = () => {
      if (stopped || active) return active || Promise.resolve();
      active = read().finally(() => { active = null; });
      return active;
    };
    void tick();
    const timer = setInterval(() => { void tick(); }, 150);
    return {
      stop: async (finalRead) => {
        clearInterval(timer);
        if (active) await active;
        if (finalRead) await read();
        stopped = true;
      }
    };
  }

  _validWebUrl(provider, value) {
    try {
      const url = new URL(value);
      if (provider === 'deepseek') return url.protocol === 'https:' && url.hostname === 'chat.deepseek.com' && /\/(?:chat\/|a\/chat\/s\/)/.test(url.pathname);
	  if (provider === 'qwen') return url.protocol === 'https:'
		&& (url.hostname === 'www.qianwen.com' || url.hostname.endsWith('.qwen.ai'))
		&& (/\/chat\//.test(url.pathname) || /\/c\/[0-9a-f]{8,}(?:-[0-9a-f-]+)?(?:\/|$)/i.test(url.pathname));
      if (provider === 'chatgpt') return url.protocol === 'https:' && (url.hostname === 'chatgpt.com' || url.hostname === 'chat.openai.com') && /\/c\//.test(url.pathname) && !/\/c\/WEB(?::|%3A)/i.test(url.pathname);
      return false;
    } catch (_) { return false; }
  }
}

function normalizeUrl(value) {
  try { const url = new URL(value); return url.origin + url.pathname.replace(/\/$/, ''); } catch (_) { return ''; }
}

module.exports = { ProviderManager, providerFromModel, normalizeWebProvider, collapseRepeatedDomText, dedupeConversationFiles, imageFileFingerprint, hasBridgeProtocolChanged, assessMalformedDshToolCall, normalizeLegacyToolCall, localHarnessTitle, dshToolRepairPrompt, PROVIDER_BUSY_RETRY_DELAYS_MS, DEEPSEEK_PER_ACCOUNT_CONCURRENCY, waitForRetry };
