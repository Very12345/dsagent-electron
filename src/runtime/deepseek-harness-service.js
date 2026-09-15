'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const net = require('net');
const { spawn } = require('child_process');
const yaml = require('js-yaml');
const WebSocket = require('ws');

const DEFAULT_VERSION = '0.1.5-rc.2';
const RETIRED_MANAGED_PRESETS = Object.freeze(['anchored-standard', 'router-standard']);

function atomicWrite(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = file + '.tmp-' + process.pid;
  fs.writeFileSync(temporary, content, 'utf8');
  fs.renameSync(temporary, file);
}

function availablePort(start) {
  return new Promise((resolve, reject) => {
    const tryPort = (port) => {
      if (port >= start + 100) return reject(new Error('No available DeepSeek Harness port'));
      const server = net.createServer();
      server.unref();
      server.once('error', (error) => error.code === 'EADDRINUSE' ? tryPort(port + 1) : reject(error));
      server.listen(port, '127.0.0.1', () => server.close(() => resolve(port)));
    };
    tryPort(start);
  });
}

function requestReady(url, headers) {
  return new Promise((resolve) => {
    const request = http.get(url, { timeout: 1500, headers: headers || {} }, (response) => {
      response.resume();
      resolve(response.statusCode >= 200 && response.statusCode < 300);
    });
    request.on('timeout', () => { request.destroy(); resolve(false); });
    request.on('error', () => resolve(false));
  });
}

function exchangeBrowserToken(url) {
  return new Promise((resolve, reject) => {
    const request = http.get(url, { timeout: 5000 }, (response) => {
      response.resume();
      const cookies = response.headers['set-cookie'] || [];
      const cookie = cookies.map((value) => String(value).split(';', 1)[0]).filter(Boolean).join('; ');
      if (response.statusCode !== 303 || !cookie) return reject(new Error('DeepSeek Harness did not issue a browser session cookie'));
      resolve(cookie);
    });
    request.on('timeout', () => request.destroy(new Error('DeepSeek Harness browser authentication timed out')));
    request.on('error', reject);
  });
}

function postJson(url, payload, headers) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const content = Buffer.from(JSON.stringify(payload || {}));
    const request = http.request({
      hostname: target.hostname,
      port: target.port,
      path: target.pathname + target.search,
      method: 'POST',
      timeout: 5000,
      headers: Object.assign({ 'Content-Type': 'application/json', 'Content-Length': content.length }, headers || {})
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        let data = {};
        try { data = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); }
        catch (error) { return reject(error); }
        if (response.statusCode < 200 || response.statusCode >= 300) return reject(new Error(data && data.error && data.error.message || 'HTTP ' + response.statusCode));
        resolve(data);
      });
    });
    request.on('timeout', () => request.destroy(new Error('Request timed out')));
    request.on('error', reject);
    request.end(content);
  });
}

class DeepSeekHarnessService {
  constructor(options) {
    this.root = path.resolve(options.root);
    this.runtimePort = Number(options.runtimePort);
    this.runtimeToken = String(options.runtimeToken || '');
    this.home = path.resolve(options.home || path.join(os.homedir(), '.webagent', 'deepseek-harness'));
    this.version = options.version || DEFAULT_VERSION;
    this.coreOnly = !!options.coreOnly;
    this.dshBin = options.dshBin ? path.resolve(options.dshBin) : '';
    this.defaultWorkspace = path.resolve(options.defaultWorkspace || (
      process.platform === 'win32' && fs.existsSync('D:\\Work\\WAWorkSpace')
        ? 'D:\\Work\\WAWorkSpace'
        : this.root
    ));
    this.nodeBinary = options.nodeBinary || 'node';
    this.child = null;
    this.startPromise = null;
    this.port = null;
    this.url = '';
    this.browserUrl = '';
    this.browserCookie = '';
    this.workspace = this.root;
    this.workspaceRecovery = null;
    this.error = '';
    this.logs = [];
    this.archiveSyncTimer = null;
    this.archiveSyncBusy = false;
    this.archiveSyncInitialized = false;
    this.archivedSessionIds = new Set();
    this.webModelsRegistered = false;
    this.presets = [];
    this.workspaceSnapshot = { fetchedAt: 0, items: [], archivedSessionIds: [] };
  }

  status() {
    return {
      installed: fs.existsSync(this._bin()),
      running: !!(this.child && this.child.exitCode == null && !this.child.killed),
      starting: !!this.startPromise,
      version: this.version,
      pid: this.child && this.child.exitCode == null ? this.child.pid : null,
      port: this.port,
      url: this.url,
      browser_url: this.browserUrl || this.url,
      home: this.home,
      workspace: this.workspace,
      default_workspace: this.defaultWorkspace,
      workspace_recovery: this.workspaceRecovery,
      web_models_registered: this.webModelsRegistered,
      presets: this.presets.map((preset) => ({ ...preset })),
      error: this.error,
      logs: this.logs.slice(-80)
    };
  }

  async start(input) {
    if (this.child && this.child.exitCode == null && !this.child.killed) return this.status();
    if (this.startPromise) return this.startPromise;
    this.startPromise = this._start(input || {});
    try {
      await this.startPromise;
    } finally {
      this.startPromise = null;
    }
    return this.status();
  }

  async _start(input) {
    const bin = this._bin();
    if (!fs.existsSync(bin)) throw Object.assign(new Error('DeepSeek Harness is not installed. Run npm install first.'), { code: 'harness_not_installed' });
    this.workspace = this._resolveWorkspace(input.workspace);
    this.error = '';
    this.logs = [];
    this.webModelsRegistered = false;
    this._removeRetiredManagedPresets(process.platform === 'win32' ? [] : ['webagent-minimal-stable']);
    if (process.platform === 'win32') this._installStableMinimalPreset();
    this._writeSettings();
    const env = Object.assign({}, process.env, {
      DSH_HOME: this.home,
      WEBAGENT_DSH_TOKEN: this.runtimeToken,
      WEBAGENT_RUNTIME_URL: 'http://127.0.0.1:' + this.runtimePort,
      NO_COLOR: '1'
    });
    await this._ensurePlugin(env);
    this.port = await availablePort(Number(input.port) || 3080);
    this.url = 'http://127.0.0.1:' + this.port;
    this.browserUrl = '';
    this.browserCookie = '';
    const child = spawn(this.nodeBinary, [bin, '--profile', 'web', '--patch', this._pluginPatch(), '--host', '127.0.0.1', '--port', String(this.port), '--no-open'], {
      cwd: this.workspace,
      env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    this.child = child;
    let launchOutput = '';
    const append = (kind, chunk) => {
      const text = String(chunk || '');
      launchOutput = (launchOutput + text).slice(-8192);
      const launch = launchOutput.match(/https?:\/\/127\.0\.0\.1:\d+\/\?token=[A-Za-z0-9_-]+/);
      if (launch) this.browserUrl = launch[0];
      text.split(/\r?\n/).filter(Boolean).forEach((line) => this.logs.push(kind + ' ' + line));
      if (this.logs.length > 300) this.logs.splice(0, this.logs.length - 300);
    };
    child.stdout.on('data', (chunk) => append('[out]', chunk));
    child.stderr.on('data', (chunk) => append('[err]', chunk));
    child.once('exit', (code, signal) => {
      if (this.child !== child) return;
      if (code !== 0 && this.error === '') this.error = 'DeepSeek Harness exited with ' + (signal || code);
      this.child = null;
    });
    child.once('error', (error) => { this.error = error.message; });

    const deadline = Date.now() + 120000;
    while (Date.now() < deadline) {
      if (child.exitCode != null) throw Object.assign(new Error(this.error || this.logs.slice(-12).join('\n') || 'DeepSeek Harness exited during startup'), { code: 'harness_start_failed' });
      if (await requestReady(this.url + '/favicon.svg')) {
        try {
          if (this.browserUrl && !this.browserCookie) this.browserCookie = await exchangeBrowserToken(this.browserUrl);
          this.webModelsRegistered = await this._hasRegisteredWebAgentProvider();
        } catch (error) {
          this.logs.push('[provider-check] ' + error.message);
        }
        if (this.webModelsRegistered) {
          await this._recoverOrphanedSessions().catch((error) => this.logs.push('[orphan-recovery] ' + error.message));
          this._startArchiveSync();
          return this.status();
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
    await this.stop();
    throw Object.assign(new Error('DeepSeek Harness Web UI startup timed out'), { code: 'harness_start_timeout' });
  }

  async stop() {
    this._stopArchiveSync();
    const child = this.child;
    this.child = null;
    this.url = '';
    this.browserUrl = '';
    this.browserCookie = '';
    this.port = null;
    this.webModelsRegistered = false;
    this.workspaceSnapshot = { fetchedAt: 0, items: [], archivedSessionIds: [] };
    if (!child || child.exitCode != null) return this.status();
    if (process.platform === 'win32') {
      await new Promise((resolve) => {
        const killer = spawn('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' });
        killer.once('exit', resolve);
        killer.once('error', resolve);
      });
    } else {
      child.kill('SIGTERM');
      await new Promise((resolve) => { child.once('exit', resolve); setTimeout(resolve, 5000); });
    }
    return this.status();
  }

  async restart(input) {
    const currentWorkspace = this.workspace;
    const currentPort = this.port;
    await this.stop();
    return this.start({
      workspace: input && input.workspace || currentWorkspace,
      port: input && input.port || currentPort || 3080
    });
  }

  _bin() { return this.dshBin || path.join(this.root, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'); }

  _isDirectory(value) {
    try { return fs.statSync(value).isDirectory(); }
    catch (_) { return false; }
  }

  _resolveWorkspace(value) {
    const requested = path.resolve(value || this.defaultWorkspace);
    const fallback = this._isDirectory(this.defaultWorkspace) ? this.defaultWorkspace : this.root;
    if (!this._isDirectory(fallback)) {
      throw Object.assign(new Error('DeepSeek Harness has no valid workspace available'), { code: 'harness_workspace_unavailable' });
    }
    if (this._isDirectory(requested)) {
      this.workspaceRecovery = null;
      return requested;
    }
    this.workspaceRecovery = { code: 'harness_workspace_recovered', requested, fallback };
    return fallback;
  }

  async listWorkspaces(force) {
    if (!this.url) return { items: [], archivedSessionIds: [] };
    if (!force && Date.now() - this.workspaceSnapshot.fetchedAt < 1000) return this.workspaceSnapshot;
    const value = await this._readWorkspaceBaseline();
    const items = value && Array.isArray(value.items) ? value.items.filter((item) => item && typeof item.path === 'string') : [];
    this.workspaceSnapshot = {
      fetchedAt: Date.now(),
      items: items.map((item) => ({
        workspaceId: String(item.workspaceId || ''),
        path: item.path,
        title: String(item.title || ''),
        sessionIds: Array.isArray(item.sessionIds) ? item.sessionIds.map(String) : []
      })),
      archivedSessionIds: value && Array.isArray(value.archivedSessionIds) ? value.archivedSessionIds.map(String) : []
    };
    return this.workspaceSnapshot;
  }

  _readWorkspaceBaseline() {
    if (!this.url || !this.browserCookie) return Promise.reject(new Error('DeepSeek Harness browser session is unavailable'));
    const target = new URL(this.url);
    const endpoint = 'ws://' + target.host + '/api/remote.mux';
    const streamId = 'webagent-workspaces-' + Date.now() + '-' + Math.random().toString(16).slice(2);
    return new Promise((resolve, reject) => {
      let settled = false;
      const socket = new WebSocket(endpoint, { headers: { Cookie: this.browserCookie, Origin: this.url } });
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try { socket.close(); } catch (_) {}
        if (error) reject(error); else resolve(value);
      };
      const timer = setTimeout(() => finish(new Error('DeepSeek Harness workspace snapshot timed out')), 5000);
      socket.once('open', () => socket.send(JSON.stringify({
        type: 'open', streamId, endpoint: 'workspace/follow', payload: { args: {} }
      })));
      socket.on('message', (chunk) => {
        try {
          const frame = JSON.parse(String(chunk));
          if (frame.streamId !== streamId) return;
          if (frame.type === 'error') return finish(new Error(frame.error && frame.error.message || 'DeepSeek Harness workspace stream failed'));
          if (frame.type === 'item' && frame.value && frame.value.type === 'baseline') finish(null, frame.value.value);
        } catch (error) { finish(error); }
      });
      socket.once('error', (error) => finish(error));
      socket.once('close', () => { if (!settled) finish(new Error('DeepSeek Harness workspace stream closed before its baseline')); });
    });
  }

  _remoteOnce(endpoint, args, timeoutMs) {
    if (!this.url || !this.browserCookie) return Promise.reject(new Error('DeepSeek Harness browser session is unavailable'));
    const target = new URL(this.url);
    const socketUrl = 'ws://' + target.host + '/api/remote.mux';
    const streamId = 'webagent-remote-' + Date.now() + '-' + Math.random().toString(16).slice(2);
    return new Promise((resolve, reject) => {
      let settled = false;
      let lastValue;
      const socket = new WebSocket(socketUrl, { headers: { Cookie: this.browserCookie, Origin: this.url } });
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try { socket.close(); } catch (_) {}
        if (error) reject(error); else resolve(value);
      };
      const timer = setTimeout(() => finish(new Error('DeepSeek Harness remote call timed out: ' + endpoint)), Math.max(1000, Number(timeoutMs) || 5000));
      socket.once('open', () => socket.send(JSON.stringify({ type: 'open', streamId, endpoint, payload: { args: args || {} } })));
      socket.on('message', (chunk) => {
        try {
          const frame = JSON.parse(String(chunk));
          if (frame.streamId !== streamId) return;
          if (frame.type === 'item') lastValue = frame.value;
          else if (frame.type === 'end') finish(null, lastValue);
          else if (frame.type === 'error') finish(new Error(frame.error && frame.error.message || 'DeepSeek Harness remote call failed: ' + endpoint));
        } catch (error) { finish(error); }
      });
      socket.once('error', (error) => finish(error));
      socket.once('close', () => { if (!settled) finish(new Error('DeepSeek Harness remote call closed early: ' + endpoint)); });
    });
  }

  async _remoteUnary(endpoint, args) {
    if (!this.url || !this.browserCookie) throw new Error('DeepSeek Harness browser session is unavailable');
    const rpcId = 'webagent-rpc-' + Date.now() + '-' + Math.random().toString(16).slice(2);
    const response = await postJson(this.url + '/api/' + endpoint, {
      type: 'client-request',
      rpcId,
      method: endpoint,
      payload: { args: args || {} }
    }, { Cookie: this.browserCookie, Origin: this.url });
    if (!response || response.type !== 'server-response' || response.rpcId !== rpcId || !response.result) {
      throw new Error('DeepSeek Harness returned an invalid unary response: ' + endpoint);
    }
    if (response.result.ok !== true) throw new Error(response.result.error && response.result.error.message || 'DeepSeek Harness unary call failed: ' + endpoint);
    return response.result.value;
  }

  async _recoverOrphanedSessions() {
    const value = await this._remoteUnary('session/list', { _request: {} });
    const items = value && Array.isArray(value.items) ? value.items : [];
    const running = items.filter((item) => item && item.running && item.sessionId);
    for (const item of running) {
      try {
        const cancelled = await this._remoteUnary('session/cancel', { request: { sessionId: String(item.sessionId) } });
        const accepted = cancelled && cancelled.accepted;
        this.logs.push('[orphan-recovery] session=' + item.sessionId + ' accepted=' + String(!!accepted));
      } catch (error) {
        this.logs.push('[orphan-recovery] session=' + item.sessionId + ' failed=' + error.message);
      }
    }
    return running.length;
  }

  async workspaceForSession(sessionId) {
    const id = String(sessionId || '').trim();
    if (!id) return null;
    const snapshot = await this.listWorkspaces();
    const workspace = snapshot.items.find((item) => item.sessionIds.includes(id));
    if (!workspace) return null;
    return { session_id: id, workspace_id: workspace.workspaceId, path: workspace.path, title: workspace.title };
  }

  isKnownWorkspace(value) {
    const candidate = path.resolve(String(value || '')).toLowerCase();
    return this.workspaceSnapshot.items.some((item) => path.resolve(item.path).toLowerCase() === candidate);
  }

  _pluginRoot() { return path.join(this.root, 'integrations', 'dsh-webagent-plugin'); }

  _pluginPatch() { return path.join(this.home, 'webagent-integration.patch.yml'); }

  _removeRetiredManagedPresets(additionalIds) {
    const presetRoot = path.join(this.home, '.agent-presets');
    if (!fs.existsSync(presetRoot)) {
      this.presets = [];
      return [];
    }
    const rootPrefix = path.resolve(presetRoot) + path.sep;
    const removed = [];
    for (const id of RETIRED_MANAGED_PRESETS.concat(Array.isArray(additionalIds) ? additionalIds : [])) {
      const target = path.resolve(presetRoot, id);
      const marker = path.join(target, '.webagent-managed.json');
      if (!target.startsWith(rootPrefix) || !fs.existsSync(target)) continue;
      if (!fs.existsSync(marker)) {
        this.logs.push('[preset] preserved user-managed ' + id);
        continue;
      }
      try {
        const metadata = JSON.parse(fs.readFileSync(marker, 'utf8'));
        if (metadata.product !== 'WebAgent' || metadata.id !== id) {
          this.logs.push('[preset] preserved unrecognized managed marker ' + id);
          continue;
        }
        fs.rmSync(target, { recursive: true, force: true });
        removed.push(id);
        this.logs.push('[preset] removed retired WebAgent preset ' + id);
      } catch (error) {
        this.logs.push('[preset] preserved ' + id + ': ' + error.message);
      }
    }
    this.presets = [];
    return removed;
  }

  _installStableMinimalPreset() {
    const id = 'webagent-minimal-stable';
    const source = path.join(this.root, 'integrations', 'dsh-webagent-plugin', 'presets', id);
    const target = path.join(this.home, '.agent-presets', id);
    const marker = path.join(target, '.webagent-managed.json');
    if (!fs.existsSync(path.join(source, 'preset.yml')) || !fs.existsSync(path.join(source, 'agent.cordis.yml'))) {
      this.logs.push('[preset] stable minimal source is unavailable');
      return false;
    }
    if (fs.existsSync(target) && !fs.existsSync(marker)) {
      this.logs.push('[preset] preserved user preset ' + id);
      return false;
    }
    if (fs.existsSync(marker)) {
      try {
        const metadata = JSON.parse(fs.readFileSync(marker, 'utf8'));
        if (metadata.product !== 'WebAgent' || metadata.id !== id) {
          this.logs.push('[preset] preserved unrecognized preset ' + id);
          return false;
        }
      } catch (error) {
        this.logs.push('[preset] preserved unreadable preset ' + id + ': ' + error.message);
        return false;
      }
    }
    fs.mkdirSync(target, { recursive: true });
    atomicWrite(path.join(target, 'preset.yml'), fs.readFileSync(path.join(source, 'preset.yml'), 'utf8'));
    atomicWrite(path.join(target, 'agent.cordis.yml'), fs.readFileSync(path.join(source, 'agent.cordis.yml'), 'utf8'));
    atomicWrite(marker, JSON.stringify({ product: 'WebAgent', id, version: 1 }, null, 2));
    this.presets = [{ id, name: 'WebAgent 稳定极简模式', managed: true }];
    this.logs.push('[preset] installed ' + id);
    return true;
  }

  _webAgentProvider() {
    const provider = {
      displayName: 'WebAgent - Web Models',
      apiKeyEnv: 'WEBAGENT_DSH_TOKEN',
      api: 'openai-completions',
      // pi-ai includes its stable DSH sessionId as prompt_cache_key for an
      // OpenAI-looking URL. Runtime strips this local alias before routing.
      baseURL: 'http://127.0.0.1:' + this.runtimePort + '/api.openai.com/v1',
      headers: {
        'X-WebAgent-Agent-Mode': 'false',
        'X-WebAgent-Tool-Bridge': 'dsh'
      },
      cacheRetention: 'short',
      reasoning: 'off',
      compat: { thinkingFormat: 'deepseek', supportsReasoningEffort: true, supportsUsageInStreaming: true },
      defaultContextWindow: 1000000,
      defaultMaxTokens: 32768,
      models: [
        { id: 'deepseek.web', name: 'DeepSeek - Web', input: ['text', 'image'], contextWindow: 1000000, maxTokens: 32768, reasoningEfforts: { off: null, high: 'high' } },
        { id: 'qwen.3.7', name: 'Qianwen3.7-Web', input: ['text', 'image'], contextWindow: 32768, maxTokens: 8192, reasoningEfforts: false },
        { id: 'qwen.3.8-max', name: 'Qianwen3.8Max-Web', input: ['text', 'image'], contextWindow: 32768, maxTokens: 8192, reasoningEfforts: false },
        { id: 'qwen.3.7-max', name: 'Qianwen3.7Max-Web', input: ['text'], contextWindow: 32768, maxTokens: 8192, reasoningEfforts: false },
        { id: 'qwen.3.6-flash', name: 'Qianwen3.6Flash-Web', input: ['text', 'image'], contextWindow: 32768, maxTokens: 8192, reasoningEfforts: false },
        { id: 'qwen.gateway.3.8-max', name: 'Qianwen3.8Max-Gate', input: ['text', 'image'], contextWindow: 256000, maxTokens: 32768, reasoningEfforts: { off: null, minimal: 'low', low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' } },
        { id: 'qwen.gateway.3.7-max', name: 'Qianwen3.7Max-Gate', input: ['text', 'image'], contextWindow: 256000, maxTokens: 32768, reasoningEfforts: { off: null, minimal: 'low', low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' } },
        { id: 'qwen.gateway.3.7-plus', name: 'Qianwen3.7Plus-Gate', input: ['text', 'image'], contextWindow: 256000, maxTokens: 32768, reasoningEfforts: { off: null, minimal: 'low', low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' } },
        { id: 'qwen.gateway.3.6-plus', name: 'Qianwen3.6Plus-Gate', input: ['text', 'image'], contextWindow: 256000, maxTokens: 32768, reasoningEfforts: { off: null, minimal: 'low', low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' } },
        { id: 'chatgpt.web', name: 'ChatGPT - Web', input: ['text'], contextWindow: 128000, maxTokens: 16384, reasoningEfforts: false }
      ]
    };
    if (this.coreOnly) provider.models = [
      provider.models.find((model) => model.id === 'deepseek.web'),
      { id: 'qwen.text.web.3.8-max', name: 'Qwen3.8-Max - Web', input: ['text', 'image'], contextWindow: 256000, maxTokens: 32768, reasoningEfforts: { off: 'none', low: 'low', high: 'high' } },
      { id: 'qwen.text.web.3.7-plus', name: 'Qwen3.7-Plus - Web', input: ['text', 'image'], contextWindow: 256000, maxTokens: 32768, reasoningEfforts: { off: 'none', low: 'low', high: 'high' } }
    ].filter(Boolean);
    return provider;
  }

  async _hasRegisteredWebAgentProvider() {
    if (!this.url || !this.browserCookie) return false;
    return requestReady(this.url + '/', { Cookie: this.browserCookie });
  }

  _stopArchiveSync() {
    if (this.archiveSyncTimer) clearInterval(this.archiveSyncTimer);
    this.archiveSyncTimer = null;
    this.archiveSyncBusy = false;
    this.archiveSyncInitialized = false;
  }

  _startArchiveSync() {
    this._stopArchiveSync();
    this.archivedSessionIds = new Set();
    const poll = async () => {
      if (this.archiveSyncBusy || !this.url) return;
      this.archiveSyncBusy = true;
      try {
        const snapshot = await this.listWorkspaces(true);
        const ids = snapshot.archivedSessionIds;
        if (!this.archiveSyncInitialized) {
          this.archivedSessionIds = new Set(ids);
          this.archiveSyncInitialized = true;
          return;
        }
        for (const sessionId of ids) {
          if (this.archivedSessionIds.has(sessionId)) continue;
          try {
            await postJson('http://127.0.0.1:' + this.runtimePort + '/api/harness/sessions/' + encodeURIComponent(sessionId) + '/archive', {}, { Authorization: 'Bearer ' + this.runtimeToken });
          } catch (error) {
            this.logs.push('[archive-sync] ' + sessionId + ': ' + error.message);
          }
        }
        this.archivedSessionIds = new Set(ids);
      } catch (_) {
        // The official DSH API may briefly be unavailable during startup or
        // shutdown. The next external poll retries without touching its UI.
      } finally {
        this.archiveSyncBusy = false;
      }
    };
    void poll();
    this.archiveSyncTimer = setInterval(() => { void poll(); }, 1000);
    if (this.archiveSyncTimer.unref) this.archiveSyncTimer.unref();
  }

  async _ensurePlugin(env) {
    const pluginRoot = this._pluginRoot();
    const manifest = path.join(pluginRoot, 'package.json');
    if (!fs.existsSync(manifest)) throw Object.assign(new Error('WebAgent DSH integration plugin is missing'), { code: 'harness_plugin_missing' });
    const profileManifest = path.join(this.home, 'profiles', 'web', 'package.json');
    const installedManifest = path.join(this.home, 'profiles', 'node_modules', '@webagent', 'dsh-integration', 'package.json');
    let installed = false;
    try {
      const profile = JSON.parse(fs.readFileSync(profileManifest, 'utf8'));
      const source = JSON.parse(fs.readFileSync(manifest, 'utf8'));
      const dependency = profile.dependencies && profile.dependencies['@webagent/dsh-integration'];
      const linkedPath = typeof dependency === 'string' && dependency.startsWith('link:') ? path.resolve(dependency.slice(5)) : '';
      if (linkedPath && linkedPath === pluginRoot) installed = source.name === '@webagent/dsh-integration';
      else {
        const linked = JSON.parse(fs.readFileSync(installedManifest, 'utf8'));
        installed = !!dependency && linked.version === source.version;
      }
    } catch (_) {
      // A missing or incomplete profile is repaired by the official plugin command below.
    }
    if (!installed) {
      await new Promise((resolve, reject) => {
        const child = spawn(this.nodeBinary, [this._bin(), 'plugin', '--profile', 'web', 'add', pluginRoot], {
          cwd: this.root,
          env,
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe']
        });
        let output = '';
        const append = (chunk) => { output += String(chunk || ''); if (output.length > 20000) output = output.slice(-20000); };
        child.stdout.on('data', append);
        child.stderr.on('data', append);
        child.once('error', reject);
        child.once('exit', (code) => code === 0 ? resolve() : reject(Object.assign(new Error('Unable to install WebAgent DSH plugin: ' + output.trim()), { code: 'harness_plugin_install_failed' })));
      });
    }
    // Configure the dormant official pi-ai adapter in the host overlay. The
    // same configuration is also written to settings.yaml for hot updates,
    // but boot no longer depends on settings-file activation timing.
    atomicWrite(this._pluginPatch(), yaml.dump([
      { id: 'llm-pi-ai', config: { providers: { webagent: this._webAgentProvider() } } },
      { id: 'agent-default-model', config: { provider: 'webagent', model: 'deepseek.web' } },
      { id: 'web', config: { searchProvider: 'webagent-web-search', fetchProvider: 'http' } },
      { id: 'web-search-deepseek', disabled: true },
      { id: 'tool-web', config: { fetch: true, searchTimeoutMs: 180000, searchMaxQueries: 2 } },
      { insert: [{ id: 'webagent-integration', name: '@webagent/dsh-integration' }] }
    ], { noRefs: true, lineWidth: 120 }));
  }

  _writeSettings() {
    fs.mkdirSync(this.home, { recursive: true });
    const file = path.join(this.home, 'settings.yaml');
    let settings = {};
    if (fs.existsSync(file)) {
      try { settings = yaml.load(fs.readFileSync(file, 'utf8')) || {}; }
      catch (error) { throw Object.assign(new Error('Unable to read existing DSH settings.yaml: ' + error.message), { code: 'harness_settings_invalid' }); }
    }
    const llm = Object.assign({}, settings['llm-pi-ai'] || {});
    llm.providers = Object.assign({}, llm.providers || {}, {
      webagent: this._webAgentProvider()
    });
    settings['llm-pi-ai'] = llm;
    settings['agent-default-model'] = { provider: 'webagent', model: 'deepseek.web' };
    atomicWrite(file, yaml.dump(settings, { noRefs: true, lineWidth: 120, sortKeys: false }));
  }
}

module.exports = { DeepSeekHarnessService, availablePort };
