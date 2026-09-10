'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { WebAppService } = require('../../src/runtime/webapp-service');

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function close(server) { return new Promise((resolve) => server.close(resolve)); }

function call(port, route, options) {
  options = options || {};
  return new Promise((resolve, reject) => {
    const body = options.body == null ? null : typeof options.body === 'string' ? options.body : JSON.stringify(options.body);
    const headers = Object.assign({}, options.headers || {}, body == null ? {} : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
    const req = http.request({ hostname: '127.0.0.1', port, path: route, method: options.method || 'GET', headers }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let data = raw;
        try { data = raw ? JSON.parse(raw) : null; } catch (_) {}
        resolve({ status: res.statusCode, headers: res.headers, raw, data });
      });
    });
    req.on('error', reject);
    if (body != null) req.write(body);
    req.end();
  });
}

async function authenticated(service) {
  const issued = service.issueBootstrapTicket();
  const exchange = await call(service.port, new URL(issued.url).pathname + new URL(issued.url).search);
  assert.equal(exchange.status, 303);
  const cookie = exchange.headers['set-cookie'][0].split(';')[0];
  const bootstrap = await call(service.port, '/webapp/api/bootstrap', { headers: { Cookie: cookie } });
  assert.equal(bootstrap.status, 200);
  return { cookie, csrf: bootstrap.data.csrf_token, exchange };
}

test('WebApp bootstrap tickets are one-time and static files stay inside the configured root', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'webagent-webapp-static-'));
  const staticRoot = path.join(root, 'dist');
  fs.mkdirSync(path.join(staticRoot, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(staticRoot, 'index.html'), '<!doctype html><title>WebAgent</title>', 'utf8');
  fs.writeFileSync(path.join(staticRoot, 'assets', 'app.12345678.js'), 'globalThis.loaded=true', 'utf8');
  fs.writeFileSync(path.join(root, 'secret.txt'), 'do not serve', 'utf8');
  const service = new WebAppService({ staticRoot, runtime: { port: 1, token: 'never-exposed', pid: 88, version: 3 } });
  try {
    await service.start(0);
    assert.equal((await call(service.port, '/')).status, 401);
    const issued = service.issueBootstrapTicket(60000);
    const exchange = await call(service.port, `/auth/bootstrap?ticket=${encodeURIComponent(issued.ticket)}`);
    assert.equal(exchange.status, 303);
    assert.match(exchange.headers['set-cookie'][0], /HttpOnly/);
    assert.match(exchange.headers['set-cookie'][0], /SameSite=Strict/);
    assert.match(exchange.headers['set-cookie'][0], /Path=\//);
    assert.equal((await call(service.port, `/auth/bootstrap?ticket=${encodeURIComponent(issued.ticket)}`)).status, 403);
    const cookie = exchange.headers['set-cookie'][0].split(';')[0];
    const index = await call(service.port, '/', { headers: { Cookie: cookie } });
    assert.equal(index.status, 200);
    assert.match(index.raw, /WebAgent/);
    assert.match(index.headers['content-security-policy'], /frame-ancestors 'none'/);
    const asset = await call(service.port, '/assets/app.12345678.js', { headers: { Cookie: cookie } });
    assert.equal(asset.status, 200);
    assert.match(asset.headers['cache-control'], /immutable/);
    const traversal = await call(service.port, '/%2e%2e%2fsecret.txt', { headers: { Cookie: cookie } });
    assert.equal(traversal.status, 403);
    assert.doesNotMatch(traversal.raw, /do not serve/);
    const info = await call(service.port, '/runtime-info', { headers: { Cookie: cookie } });
    assert.equal(info.status, 200);
    assert.equal(info.data.pid, 88);
    assert.equal(info.data.transport, 'browser');
    assert.equal(Object.prototype.hasOwnProperty.call(info.data, 'token'), false);
    assert.doesNotMatch(info.raw, /never-exposed/);
  } finally {
    await service.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('WebApp proxy enforces exact Origin and CSRF while preserving Runtime SSE', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'webagent-webapp-proxy-'));
  fs.writeFileSync(path.join(root, 'index.html'), '<!doctype html>', 'utf8');
  const seen = [];
  const upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      seen.push({ url: req.url, method: req.method, authorization: req.headers.authorization, cookie: req.headers.cookie, origin: req.headers.origin, csrf: req.headers['x-webagent-csrf'], body: Buffer.concat(chunks).toString('utf8') });
      if (req.url.includes('/events')) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache' });
        res.end('id: 7\nevent: message.delta\ndata: {"seq":7,"type":"message.delta"}\n\n');
      } else {
        res.writeHead(201, { 'Content-Type': 'application/json', 'Set-Cookie': 'upstream=secret', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ ok: true }));
      }
    });
  });
  const upstreamPort = await listen(upstream);
  const service = new WebAppService({ staticRoot: root, runtime: { host: '127.0.0.1', port: upstreamPort, token: 'runtime-secret', pid: 1, version: 2 } });
  try {
    await service.start(0);
    const auth = await authenticated(service);
    const noOrigin = await call(service.port, '/api/write', { method: 'POST', headers: { Cookie: auth.cookie, 'X-WebAgent-CSRF': auth.csrf }, body: { value: 1 } });
    assert.equal(noOrigin.status, 403);
    assert.equal(noOrigin.data.error.code, 'origin_mismatch');
    const wrongOrigin = await call(service.port, '/api/write', { method: 'POST', headers: { Cookie: auth.cookie, Origin: 'http://evil.invalid', 'X-WebAgent-CSRF': auth.csrf }, body: { value: 1 } });
    assert.equal(wrongOrigin.status, 403);
    const noCsrf = await call(service.port, '/api/write', { method: 'POST', headers: { Cookie: auth.cookie, Origin: service.origin }, body: { value: 1 } });
    assert.equal(noCsrf.status, 403);
    assert.equal(noCsrf.data.error.code, 'csrf_invalid');
    const proxied = await call(service.port, '/api/write', { method: 'POST', headers: { Cookie: auth.cookie, Origin: service.origin, 'X-WebAgent-CSRF': auth.csrf }, body: { value: 2 } });
    assert.equal(proxied.status, 201);
    assert.equal(proxied.headers['set-cookie'], undefined);
    assert.equal(proxied.headers['access-control-allow-origin'], undefined);
    assert.equal(seen[0].authorization, 'Bearer runtime-secret');
    assert.equal(seen[0].cookie, undefined);
    assert.equal(seen[0].origin, undefined);
    assert.equal(seen[0].csrf, undefined);
    assert.equal(JSON.parse(seen[0].body).value, 2);
    const stream = await call(service.port, '/api/sessions/session/events?after=0', { headers: { Cookie: auth.cookie } });
    assert.equal(stream.status, 200);
    assert.match(stream.headers['content-type'], /text\/event-stream/);
    assert.match(stream.raw, /message\.delta/);
  } finally {
    await service.stop();
    await close(upstream);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('WebApp native bridge validates workspace paths and uploads use a controlled directory', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'webagent-webapp-native-'));
  const staticRoot = path.join(root, 'dist');
  const workspace = path.join(root, 'workspace');
  const uploadRoot = path.join(root, 'uploads');
  fs.mkdirSync(staticRoot, { recursive: true });
  fs.mkdirSync(workspace, { recursive: true });
  fs.writeFileSync(path.join(staticRoot, 'index.html'), '<!doctype html>', 'utf8');
  const calls = { reveal: [], external: [] };
  const service = new WebAppService({
    staticRoot,
    uploadRoot,
    runtime: { port: 1, token: 'unused' },
    workspaceResolver: async (candidate) => {
      if (path.resolve(candidate) !== path.resolve(workspace)) throw Object.assign(new Error('Workspace is not registered'), { code: 'workspace_not_registered', status: 403 });
      return workspace;
    },
    nativeBridge: {
      revealWorkspace: async (candidate) => { calls.reveal.push(candidate); },
      openExternal: async (url) => { calls.external.push(url); },
      harnessCurrentWorkspace: async () => ({ available: true, session_id: 'harness', path: workspace, title: 'Harness', reason: '' })
    }
  });
  try {
    await service.start(0);
    const auth = await authenticated(service);
    const mutationHeaders = { Cookie: auth.cookie, Origin: service.origin, 'X-WebAgent-CSRF': auth.csrf };
    const selected = await call(service.port, '/system/select-directory', { method: 'POST', headers: mutationHeaders, body: { path: workspace } });
    assert.equal(selected.status, 200);
    assert.equal(selected.data.path, fs.realpathSync(workspace));
    const rejected = await call(service.port, '/system/select-directory', { method: 'POST', headers: mutationHeaders, body: { path: root } });
    assert.equal(rejected.status, 403);
    const revealed = await call(service.port, '/system/reveal', { method: 'POST', headers: mutationHeaders, body: { workspace } });
    assert.equal(revealed.status, 200);
    assert.deepEqual(calls.reveal, [fs.realpathSync(workspace)]);
    const invalidExternal = await call(service.port, '/system/open-external', { method: 'POST', headers: mutationHeaders, body: { url: 'file:///etc/passwd' } });
    assert.equal(invalidExternal.status, 400);
    const external = await call(service.port, '/system/open-external', { method: 'POST', headers: mutationHeaders, body: { url: 'https://example.com/path' } });
    assert.equal(external.status, 200);
    assert.deepEqual(calls.external, ['https://example.com/path']);
    const upload = await call(service.port, '/system/upload', { method: 'POST', headers: mutationHeaders, body: { files: [{ name: '../../unsafe.txt', mimeType: 'text/plain', data: Buffer.from('safe upload').toString('base64') }] } });
    assert.equal(upload.status, 201);
    assert.equal(path.relative(uploadRoot, upload.data.paths[0]).startsWith('..'), false);
    assert.equal(fs.readFileSync(upload.data.paths[0], 'utf8'), 'safe upload');
    const harness = await call(service.port, '/system/harness-current-workspace', { headers: { Cookie: auth.cookie } });
    assert.equal(harness.status, 200);
    assert.equal(harness.data.session_id, 'harness');
  } finally {
    await service.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

