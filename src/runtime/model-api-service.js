'use strict';

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');

function apiError(message, code) {
  return { error: { message, type: 'invalid_request_error', code: code || 'model_api_error' } };
}

function sendJson(res, status, value) {
  const body = Buffer.from(JSON.stringify(value));
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': body.length });
  res.end(body);
}

function readJson(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(Object.assign(new Error('Request body is too large'), { code: 'request_too_large', status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
      catch (_) { reject(Object.assign(new Error('Request body must be valid JSON'), { code: 'invalid_json', status: 400 })); }
    });
    req.on('error', reject);
  });
}

class ModelApiService {
  constructor(options) {
    options = options || {};
    this.home = path.resolve(options.home);
    this.file = path.join(this.home, 'model-api.json');
    this.getModels = options.getModels || (() => []);
    this.fetch = options.fetch || global.fetch;
    this.encrypt = options.encrypt || ((value) => Buffer.from(value, 'utf8').toString('base64'));
    this.decrypt = options.decrypt || ((value) => Buffer.from(value, 'base64').toString('utf8'));
    this.runtime = null;
    this.server = null;
    this.actualPort = null;
    this.state = this._load(options.port);
  }

  _load(defaultPort) {
    let saved = {};
    try { saved = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch (_) {}
    let token = '';
    try { token = saved.secret ? this.decrypt(saved.secret) : ''; } catch (_) {}
    if (!token) token = 'wa_' + crypto.randomBytes(24).toString('hex');
    return {
      enabled: !!saved.enabled,
      model: String(saved.model || ''),
      alias: String(saved.alias || ''),
      port: Number.isInteger(saved.port) ? saved.port : Number.isInteger(defaultPort) ? defaultPort : 5861,
      token
    };
  }

  _save() {
    fs.mkdirSync(this.home, { recursive: true });
    const payload = {
      version: 1,
      enabled: this.state.enabled,
      model: this.state.model,
      alias: this.state.alias,
      port: this.state.port,
      secret: this.encrypt(this.state.token)
    };
    const temporary = this.file + '.tmp-' + process.pid;
    fs.writeFileSync(temporary, JSON.stringify(payload, null, 2), 'utf8');
    fs.renameSync(temporary, this.file);
  }

  setRuntime(address) {
    this.runtime = { host: '127.0.0.1', port: Number(address.port), token: String(address.token || '') };
  }

  _selectedModel() {
    return this.getModels().find((model) => model.id === this.state.model) || null;
  }

  status() {
    const model = this._selectedModel();
    const port = this.actualPort == null ? this.state.port : this.actualPort;
    return {
      enabled: this.state.enabled,
      running: !!(this.server && this.server.listening),
      host: '127.0.0.1',
      port,
      base_url: 'http://127.0.0.1:' + port + '/v1',
      model: this.state.model,
      exposed_model: this.state.alias || this.state.model,
      display_name: model && (model.displayName || model.id) || '',
      api_key: this.state.token
    };
  }

  async configure(input) {
    input = input || {};
    const nextModel = input.model == null ? this.state.model : String(input.model).trim();
    if (nextModel && !this.getModels().some((model) => model.id === nextModel)) {
      throw Object.assign(new Error('Selected model is not available'), { code: 'model_not_found', status: 404 });
    }
    const nextAlias = input.alias == null ? this.state.alias : String(input.alias).trim();
    if (nextAlias && !/^[A-Za-z0-9._:-]{1,128}$/.test(nextAlias)) {
      throw Object.assign(new Error('API model alias may contain only letters, digits, dot, colon, underscore and hyphen'), { code: 'invalid_model_alias', status: 400 });
    }
    const nextPort = input.port == null ? this.state.port : Number(input.port);
    if (!Number.isInteger(nextPort) || (nextPort !== 0 && (nextPort < 1024 || nextPort > 65535))) {
      throw Object.assign(new Error('Port must be between 1024 and 65535'), { code: 'invalid_port', status: 400 });
    }
    const restart = !!(this.server && this.server.listening) && (nextPort !== this.state.port);
    this.state.model = nextModel;
    this.state.alias = nextAlias;
    this.state.port = nextPort;
    this._save();
    if (restart) { await this.stop(false); await this.start(); }
    return this.status();
  }

  async start(input) {
    if (input && Object.keys(input).length) await this.configure(input);
    if (this.server && this.server.listening) return this.status();
    if (!this.runtime || !this.runtime.port || !this.runtime.token) throw Object.assign(new Error('Runtime API is unavailable'), { code: 'runtime_unavailable', status: 503 });
    if (!this._selectedModel()) throw Object.assign(new Error('Select a model before publishing the API'), { code: 'model_required', status: 400 });
    this.server = http.createServer(this._handle.bind(this));
    try {
      await new Promise((resolve, reject) => {
        this.server.once('error', reject);
        this.server.listen(this.state.port, '127.0.0.1', resolve);
      });
    } catch (error) {
      this.server = null;
      throw Object.assign(new Error(error.code === 'EADDRINUSE' ? 'Local API port is already in use' : error.message), { code: error.code === 'EADDRINUSE' ? 'port_in_use' : 'model_api_start_failed', status: 409 });
    }
    this.actualPort = this.server.address().port;
    this.state.enabled = true;
    this._save();
    return this.status();
  }

  async stop(persist = true) {
    const server = this.server;
    this.server = null;
    this.actualPort = null;
    if (server && server.listening) {
      if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
    if (persist) {
      this.state.enabled = false;
      this._save();
    }
    return this.status();
  }

  async resetToken() {
    this.state.token = 'wa_' + crypto.randomBytes(24).toString('hex');
    this._save();
    return this.status();
  }

  async restore() {
    if (!this.state.enabled) return this.status();
    try { return await this.start(); }
    catch (error) { this.state.enabled = false; this._save(); throw error; }
  }

  _authorized(req) {
    return String(req.headers.authorization || '').replace(/^Bearer\s+/i, '') === this.state.token;
  }

  async _handle(req, res) {
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (req.method === 'GET' && url.pathname === '/health') return sendJson(res, 200, { ok: true, product: 'WebAgent Model API' });
      if (!this._authorized(req)) return sendJson(res, 401, apiError('Invalid API key', 'invalid_api_key'));
      if (req.method === 'GET' && url.pathname === '/v1/models') {
        const model = this._selectedModel();
        return sendJson(res, 200, { object: 'list', data: [{ id: this.state.alias || this.state.model, object: 'model', created: 0, owned_by: 'webagent', source_model: this.state.model, display_name: model && (model.displayName || model.id) || this.state.model }] });
      }
      if (req.method !== 'POST' || !['/v1/chat/completions', '/v1/responses'].includes(url.pathname)) {
        return sendJson(res, 404, apiError('Route not found', 'not_found'));
      }
      const body = await readJson(req, 32 * 1024 * 1024);
      body.model = this.state.model;
      const headers = { Authorization: 'Bearer ' + this.runtime.token, 'Content-Type': 'application/json' };
      for (const name of ['x-webagent-session-id', 'x-webagent-agent-mode']) {
        if (req.headers[name]) headers[name] = String(req.headers[name]);
      }
      const upstream = await this.fetch('http://127.0.0.1:' + this.runtime.port + url.pathname, { method: 'POST', headers, body: JSON.stringify(body) });
      const responseHeaders = { 'Content-Type': upstream.headers.get('content-type') || 'application/json; charset=utf-8' };
      for (const name of ['x-webagent-session-id', 'x-webagent-run-id']) {
        const value = upstream.headers.get(name);
        if (value) responseHeaders[name] = value;
      }
      res.writeHead(upstream.status, responseHeaders);
      if (upstream.body) for await (const chunk of upstream.body) res.write(chunk);
      res.end();
    } catch (error) {
      if (!res.headersSent) sendJson(res, error.status || 502, apiError(error.message, error.code || 'model_api_proxy_failed'));
      else res.end();
    }
  }
}

module.exports = { ModelApiService };
