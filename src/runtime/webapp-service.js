'use strict';

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const { URL } = require('url');

const COOKIE_NAME = 'webagent_session';
const DEFAULT_SESSION_TTL = 12 * 60 * 60 * 1000;
const MAX_JSON_BODY = 30 * 1024 * 1024;
const MIME_TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.gif': 'image/gif',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2'
};

function randomToken(bytes = 32) { return crypto.randomBytes(bytes).toString('base64url'); }
function hash(value) { return crypto.createHash('sha256').update(String(value || '')).digest('hex'); }
function isUnsafe(method) { return !['GET', 'HEAD', 'OPTIONS'].includes(String(method || 'GET').toUpperCase()); }

function json(res, status, value, headers) {
  if (res.headersSent) return;
  res.writeHead(status, Object.assign({
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer'
  }, headers || {}));
  res.end(JSON.stringify(value));
}

function errorPayload(error, fallbackCode) {
  return { error: { message: error && error.message || String(error || 'Unknown error'), code: error && error.code || fallbackCode || 'webapp_error' } };
}

function readJson(req, limit = MAX_JSON_BODY) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    const fail = (error) => { if (!settled) { settled = true; reject(error); } };
    req.on('data', (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > limit) {
        fail(Object.assign(new Error('Request body is too large'), { code: 'body_too_large', status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve(raw ? JSON.parse(raw) : {});
      } catch (_) {
        reject(Object.assign(new Error('Request body must be valid JSON'), { code: 'invalid_json', status: 400 }));
      }
    });
    req.on('error', fail);
  });
}

function cookies(req) {
  const result = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    const name = part.slice(0, index).trim();
    try { result[name] = decodeURIComponent(part.slice(index + 1).trim()); } catch (_) {}
  }
  return result;
}

function safeFilename(value) {
  const base = path.basename(String(value || 'file')).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/^\.+/, '').slice(0, 120);
  return base || 'file';
}

function loopbackHost(value) {
  const host = String(value || '127.0.0.1').replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || host === '::1' || host === '127.0.0.1') return host;
  if (net.isIP(host) === 4 && host.startsWith('127.')) return host;
  throw Object.assign(new Error('Runtime proxy target must be loopback'), { code: 'runtime_target_not_loopback', status: 500 });
}

function visibleRuntimeInfo(value, origin) {
  const source = value && typeof value === 'object' ? value : {};
  return {
    port: Number(source.port) || 0,
    pid: Number(source.pid) || process.pid,
    version: Number(source.version) || 1,
    started_at: source.started_at || null,
    origin,
    transport: 'browser'
  };
}

class WebAppService {
  constructor(options) {
    options = options || {};
    this.staticRoot = path.resolve(options.staticRoot || path.join(__dirname, '..', '..', 'dist-renderer'));
    this.uploadRoot = path.resolve(options.uploadRoot || path.join(os.tmpdir(), 'webagent-web-uploads'));
    this.runtime = options.runtime || options.runtimeInfo || null;
    this.nativeBridge = options.nativeBridge || {};
    this.workspaceResolver = typeof options.workspaceResolver === 'function' ? options.workspaceResolver : null;
    this.host = String(options.host || '127.0.0.1');
    this.sessionTtl = Math.max(60 * 1000, Number(options.sessionTtl) || DEFAULT_SESSION_TTL);
    this.secureCookies = !!options.secureCookies;
    this.server = null;
    this.port = null;
    this.origin = '';
    this.tickets = new Map();
    this.sessions = new Map();
  }

  async start(port) {
    if (this.server) return this.status();
    fs.mkdirSync(this.staticRoot, { recursive: true });
    fs.mkdirSync(this.uploadRoot, { recursive: true });
    const first = port == null ? 0 : Number(port);
    const candidates = first === 0 ? [0] : Array.from({ length: 50 }, (_, index) => first + index);
    let lastError = null;
    for (const candidate of candidates) {
      const server = http.createServer(this._handle.bind(this));
      try {
        await new Promise((resolve, reject) => {
          server.once('error', reject);
          server.listen(candidate, this.host, resolve);
        });
        this.server = server;
        this.port = server.address().port;
        const displayHost = this.host.includes(':') ? `[${this.host}]` : this.host;
        this.origin = `${this.secureCookies ? 'https' : 'http'}://${displayHost}:${this.port}`;
        return this.status();
      } catch (error) {
        lastError = error;
        try { server.close(); } catch (_) {}
        if (!error || error.code !== 'EADDRINUSE') throw error;
      }
    }
    throw lastError || Object.assign(new Error('No WebApp port is available'), { code: 'webapp_port_unavailable' });
  }

  async stop() {
    if (this.server) await new Promise((resolve) => this.server.close(resolve));
    for (const session of this.sessions.values()) this._cleanupSession(session);
    this.server = null;
    this.port = null;
    this.origin = '';
    this.tickets.clear();
    this.sessions.clear();
  }

  status() { return { running: !!this.server, host: this.host, port: this.port, origin: this.origin, static_root: this.staticRoot }; }

  issueBootstrapTicket(ttlMs = 5 * 60 * 1000) {
    if (!this.server) throw Object.assign(new Error('WebApp service is not running'), { code: 'webapp_not_running', status: 409 });
    this._prune();
    const ticket = randomToken(24);
    const expires = Date.now() + Math.max(10 * 1000, Math.min(Number(ttlMs) || 5 * 60 * 1000, 15 * 60 * 1000));
    this.tickets.set(hash(ticket), expires);
    return { ticket, url: `${this.origin}/auth/bootstrap?ticket=${encodeURIComponent(ticket)}`, expires_at: new Date(expires).toISOString() };
  }

  createBootstrapTicket(ttlMs) { return this.issueBootstrapTicket(ttlMs); }

  _prune() {
    const now = Date.now();
    for (const [key, expires] of this.tickets) if (expires <= now) this.tickets.delete(key);
    for (const [key, session] of this.sessions) {
      if (session.expires > now) continue;
      this._cleanupSession(session);
      this.sessions.delete(key);
    }
  }

  _cleanupSession(session) {
    if (!session || !session.uploadDirectory) return;
    const target = path.resolve(String(session.uploadDirectory));
    const relative = path.relative(this.uploadRoot, target);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return;
    try { fs.rmSync(target, { recursive: true, force: true }); } catch (_) {}
    session.uploadDirectory = '';
  }

  _session(req) {
    this._prune();
    const raw = cookies(req)[COOKIE_NAME];
    if (!raw) return null;
    const session = this.sessions.get(hash(raw));
    if (!session || session.expires <= Date.now()) return null;
    session.expires = Date.now() + this.sessionTtl;
    return session;
  }

  _sameOrigin(req, required) {
    const origin = String(req.headers.origin || '');
    if (!origin) return !required;
    try { return new URL(origin).origin === this.origin; } catch (_) { return false; }
  }

  _authorize(req, res) {
    const session = this._session(req);
    if (!session) { json(res, 401, errorPayload(Object.assign(new Error('WebApp authentication required'), { code: 'webapp_unauthorized' }))); return null; }
    if (!this._sameOrigin(req, isUnsafe(req.method))) {
      json(res, 403, errorPayload(Object.assign(new Error('Request origin does not match the WebApp origin'), { code: 'origin_mismatch' })));
      return null;
    }
    if (isUnsafe(req.method)) {
      const supplied = Buffer.from(String(req.headers['x-webagent-csrf'] || ''));
      const expected = Buffer.from(session.csrf);
      if (supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)) {
        json(res, 403, errorPayload(Object.assign(new Error('Invalid CSRF token'), { code: 'csrf_invalid' })));
        return null;
      }
    }
    return session;
  }

  async _runtimeTarget() {
    const value = typeof this.runtime === 'function' ? await this.runtime() : this.runtime;
    if (!value || !value.port || !value.token) throw Object.assign(new Error('Runtime API is unavailable'), { code: 'runtime_unavailable', status: 503 });
    return { host: loopbackHost(value.host || '127.0.0.1'), port: Number(value.port), token: String(value.token), info: value };
  }

  async _resolveWorkspace(input) {
    if (!this.workspaceResolver) throw Object.assign(new Error('Directory selection is unavailable in this build'), { code: 'native_bridge_unavailable', status: 501 });
    const resolved = await this.workspaceResolver(String(input || ''));
    if (!resolved || !path.isAbsolute(String(resolved))) throw Object.assign(new Error('Workspace validator rejected the path'), { code: 'workspace_path_invalid', status: 400 });
    let real;
    try {
      real = fs.realpathSync(path.resolve(String(resolved)));
      if (!fs.statSync(real).isDirectory()) throw new Error('not_directory');
    } catch (_) {
      throw Object.assign(new Error('Workspace directory does not exist'), { code: 'workspace_not_found', status: 404 });
    }
    return real;
  }

  _nativeCapabilities() {
    return {
      reveal_workspace: typeof this.nativeBridge.revealWorkspace === 'function' && !!this.workspaceResolver,
      open_external: typeof this.nativeBridge.openExternal === 'function',
      select_directory: typeof this.nativeBridge.selectDirectory === 'function' && !!this.workspaceResolver,
      harness_workspace: typeof this.nativeBridge.harnessCurrentWorkspace === 'function'
    };
  }

  _unavailable(res, capability) {
    return json(res, 501, errorPayload(Object.assign(new Error(`${capability} is unavailable in browser mode`), { code: 'native_bridge_unavailable' })));
  }

  async _handleSystem(req, res, url, session) {
    if (req.method === 'GET' && url.pathname === '/webapp/api/bootstrap') {
      return json(res, 200, { csrf_token: session.csrf, native_capabilities: this._nativeCapabilities() });
    }
    if (req.method === 'GET' && url.pathname === '/runtime-info') {
      let info = {};
      try { info = (await this._runtimeTarget()).info; } catch (_) { if (typeof this.runtime === 'object') info = this.runtime || {}; }
      return json(res, 200, visibleRuntimeInfo(info, this.origin));
    }
    if (req.method === 'POST' && url.pathname === '/system/select-directory') {
      const value = await readJson(req, 1024 * 1024);
      let candidate = String(value.path || '');
      if (!candidate && typeof this.nativeBridge.selectDirectory === 'function') {
        candidate = String(await this.nativeBridge.selectDirectory() || '');
        if (!candidate) return json(res, 200, { path: null, cancelled: true });
      }
      if (!candidate) return this._unavailable(res, 'Directory selection');
      return json(res, 200, { path: await this._resolveWorkspace(candidate) });
    }
    if (req.method === 'POST' && url.pathname === '/system/reveal') {
      if (typeof this.nativeBridge.revealWorkspace !== 'function') return this._unavailable(res, 'Workspace reveal');
      const value = await readJson(req, 1024 * 1024);
      const workspace = await this._resolveWorkspace(value.workspace);
      await this.nativeBridge.revealWorkspace(workspace);
      return json(res, 200, { opened: true });
    }
    if (req.method === 'POST' && url.pathname === '/system/open-external') {
      if (typeof this.nativeBridge.openExternal !== 'function') return this._unavailable(res, 'External URL opening');
      const value = await readJson(req, 1024 * 1024);
      const target = new URL(String(value.url || ''));
      if (!['http:', 'https:'].includes(target.protocol)) throw Object.assign(new Error('Only HTTP(S) URLs can be opened externally'), { code: 'external_url_invalid', status: 400 });
      await this.nativeBridge.openExternal(target.toString());
      return json(res, 200, { opened: true });
    }
    if (req.method === 'GET' && url.pathname === '/system/harness-current-workspace') {
      if (typeof this.nativeBridge.harnessCurrentWorkspace !== 'function') return this._unavailable(res, 'Harness workspace lookup');
      return json(res, 200, await this.nativeBridge.harnessCurrentWorkspace());
    }
    if (req.method === 'POST' && url.pathname === '/system/upload') {
      const value = await readJson(req, MAX_JSON_BODY);
      const files = Array.isArray(value.files) ? value.files : [];
      if (!files.length || files.length > 32) throw Object.assign(new Error('Select between 1 and 32 files'), { code: 'upload_files_invalid', status: 400 });
      const directory = path.join(this.uploadRoot, session.id);
      fs.mkdirSync(directory, { recursive: true });
      session.uploadDirectory = directory;
      let total = 0;
      const paths = [];
      for (const file of files) {
        const data = String(file && file.data || '');
        if (!/^[A-Za-z0-9+/]*={0,2}$/.test(data) || data.length % 4 === 1) throw Object.assign(new Error('Uploaded file is not valid base64'), { code: 'upload_data_invalid', status: 400 });
        const content = Buffer.from(data, 'base64');
        total += content.length;
        if (total > 20 * 1024 * 1024) throw Object.assign(new Error('Selected files exceed the 20 MB total limit'), { code: 'upload_too_large', status: 413 });
        const filename = `${Date.now()}-${randomToken(6)}-${safeFilename(file && file.name)}`;
        const target = path.join(directory, filename);
        fs.writeFileSync(target, content, { mode: 0o600, flag: 'wx' });
        paths.push(target);
      }
      return json(res, 201, { paths });
    }
    return false;
  }

  async _proxy(req, res) {
    const target = await this._runtimeTarget();
    const headers = Object.assign({}, req.headers);
    for (const name of ['authorization', 'cookie', 'origin', 'referer', 'x-webagent-csrf', 'connection', 'host', 'sec-fetch-site', 'sec-fetch-mode', 'sec-fetch-dest']) delete headers[name];
    headers.authorization = `Bearer ${target.token}`;
    headers.host = target.host.includes(':') ? `[${target.host}]:${target.port}` : `${target.host}:${target.port}`;
    const upstream = http.request({ host: target.host, port: target.port, method: req.method, path: req.url, headers }, (upstreamResponse) => {
      const responseHeaders = Object.assign({}, upstreamResponse.headers);
      delete responseHeaders['set-cookie'];
      delete responseHeaders['access-control-allow-origin'];
      delete responseHeaders['access-control-allow-credentials'];
      responseHeaders['x-content-type-options'] = 'nosniff';
      res.writeHead(upstreamResponse.statusCode || 502, responseHeaders);
      upstreamResponse.pipe(res);
    });
    upstream.on('error', (error) => {
      if (!res.headersSent) json(res, 502, errorPayload(Object.assign(new Error(`Runtime proxy failed: ${error.message}`), { code: 'runtime_proxy_failed' })));
      else res.destroy(error);
    });
    res.on('close', () => { if (!res.writableEnded) upstream.destroy(); });
    req.pipe(upstream);
  }

  _staticPath(rawUrl) {
    let rawPath = String(rawUrl || '/').split('?')[0] || '/';
    try { rawPath = decodeURIComponent(rawPath); }
    catch (_) { throw Object.assign(new Error('Malformed static file path'), { code: 'static_path_invalid', status: 400 }); }
    rawPath = rawPath.replace(/\\/g, '/');
    if (rawPath.includes('\0')) throw Object.assign(new Error('Malformed static file path'), { code: 'static_path_invalid', status: 400 });
    const segments = rawPath.split('/').filter(Boolean);
    if (segments.some((segment) => segment === '..' || segment === '.')) throw Object.assign(new Error('Static file path escapes the application root'), { code: 'static_path_forbidden', status: 403 });
    let candidate = path.resolve(this.staticRoot, ...segments);
    const relative = path.relative(this.staticRoot, candidate);
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw Object.assign(new Error('Static file path escapes the application root'), { code: 'static_path_forbidden', status: 403 });
    if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) candidate = path.join(candidate, 'index.html');
    if (!fs.existsSync(candidate) && !path.extname(candidate)) candidate = path.join(this.staticRoot, 'index.html');
    if (!fs.existsSync(candidate) || !fs.statSync(candidate).isFile()) return null;
    const realRoot = fs.realpathSync(this.staticRoot);
    const real = fs.realpathSync(candidate);
    const realRelative = path.relative(realRoot, real);
    if (realRelative.startsWith('..') || path.isAbsolute(realRelative)) throw Object.assign(new Error('Static file symlink escapes the application root'), { code: 'static_path_forbidden', status: 403 });
    return real;
  }

  _serveStatic(req, res) {
    const file = this._staticPath(req.url);
    if (!file) return json(res, 404, errorPayload(Object.assign(new Error('Static asset not found'), { code: 'static_not_found' })));
    const extension = path.extname(file).toLowerCase();
    const isHtml = extension === '.html';
    const headers = {
      'Content-Type': MIME_TYPES[extension] || 'application/octet-stream',
      'Content-Length': fs.statSync(file).size,
      'Cache-Control': isHtml ? 'no-store' : (/\.[a-f0-9]{8,}\./i.test(path.basename(file)) ? 'public, max-age=31536000, immutable' : 'no-cache'),
      'Content-Security-Policy': "default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; worker-src 'self' blob:; frame-src 'self' http://127.0.0.1:* http://localhost:*",
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Cross-Origin-Opener-Policy': 'same-origin'
    };
    res.writeHead(200, headers);
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  }

  _exchangeTicket(req, res, url) {
    if (req.method !== 'GET') return json(res, 405, errorPayload(Object.assign(new Error('Bootstrap exchange requires GET'), { code: 'method_not_allowed' })), { Allow: 'GET' });
    this._prune();
    const ticket = String(url.searchParams.get('ticket') || '');
    const key = hash(ticket);
    const expires = this.tickets.get(key);
    if (!ticket || !expires || expires <= Date.now()) return json(res, 403, errorPayload(Object.assign(new Error('Bootstrap ticket is invalid or expired'), { code: 'bootstrap_ticket_invalid' })));
    this.tickets.delete(key);
    const token = randomToken();
    const session = { id: randomToken(12), csrf: randomToken(), expires: Date.now() + this.sessionTtl };
    this.sessions.set(hash(token), session);
    const maxAge = Math.floor(this.sessionTtl / 1000);
    const secure = this.secureCookies ? '; Secure' : '';
    res.writeHead(303, {
      Location: '/',
      'Set-Cookie': `${COOKIE_NAME}=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${secure}`,
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer'
    });
    res.end();
  }

  async _handle(req, res) {
    try {
      const url = new URL(req.url, this.origin || 'http://127.0.0.1');
      if (url.pathname === '/auth/bootstrap') return this._exchangeTicket(req, res, url);
      const session = this._authorize(req, res);
      if (!session) return;
      const handled = await this._handleSystem(req, res, url, session);
      if (handled !== false) return;
      if (/^\/(?:api|v1)(?:\/|$)/.test(url.pathname) || url.pathname === '/health') return await this._proxy(req, res);
      if (!['GET', 'HEAD'].includes(req.method)) return json(res, 405, errorPayload(Object.assign(new Error('Method not allowed'), { code: 'method_not_allowed' })));
      return this._serveStatic(req, res);
    } catch (error) {
      return json(res, error && error.status || 500, errorPayload(error));
    }
  }
}

module.exports = { WebAppService, COOKIE_NAME, safeFilename, visibleRuntimeInfo };
