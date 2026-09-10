'use strict';

const { test, expect } = require('@playwright/test');
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
let runtimeHome;
let daemon;
let info;

function call(route, options) {
  options = options || {};
  return new Promise((resolve, reject) => {
    const body = options.body == null ? null : JSON.stringify(options.body);
    const req = http.request({
      hostname: '127.0.0.1', port: info.port, path: route, method: options.method || (body ? 'POST' : 'GET'),
      headers: Object.assign({ Authorization: 'Bearer ' + info.token, 'Content-Type': 'application/json' }, body ? { 'Content-Length': Buffer.byteLength(body) } : {})
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        try { resolve(JSON.parse(raw)); } catch (_) { resolve(raw); }
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

test.beforeAll(async () => {
  runtimeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'webagent-pwa-e2e-'));
  daemon = spawn(process.execPath, [path.join(ROOT, 'src', 'node', 'daemon.js'), '--no-open', '--headless-workers'], {
    cwd: ROOT,
    env: Object.assign({}, process.env, { WEBAGENT_HOME: runtimeHome }),
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = '';
  daemon.stdout.on('data', (chunk) => { output += chunk; });
  daemon.stderr.on('data', (chunk) => { output += chunk; });
  const deadline = Date.now() + 30000;
  const infoFile = path.join(runtimeHome, 'runtime.json');
  while (Date.now() < deadline) {
    if (daemon.exitCode != null) throw new Error('Node Runtime exited during startup:\n' + output);
    try {
      info = JSON.parse(fs.readFileSync(infoFile, 'utf8'));
      const ping = await call('/api/ping');
      if (ping && ping.ok && info.webapp_url) return;
    } catch (_) {}
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error('Node Runtime startup timed out:\n' + output);
});

test.afterAll(async () => {
  if (daemon && daemon.exitCode == null) {
    daemon.kill('SIGTERM');
    await Promise.race([
      new Promise((resolve) => daemon.once('exit', resolve)),
      new Promise((resolve) => setTimeout(resolve, 5000))
    ]);
  }
  if (runtimeHome) fs.rmSync(runtimeHome, { recursive: true, force: true });
});

test('PWA exchanges a one-time ticket, loads models and performs an authenticated mutation', async ({ page }) => {
  const ticket = await call('/api/webapp/ticket', { method: 'POST', body: {} });
  await page.goto(ticket.url);
  await expect(page.getByRole('heading', { name: '开始使用 WebAgent' })).toBeVisible();
  await page.getByRole('button', { name: '新建会话', exact: true }).first().click();
  await expect(page.getByRole('button', { name: /新会话 deepseek\.web/ })).toBeVisible();
  await expect(page.getByRole('button', { name: 'deepseek.web', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Runtime' })).toBeVisible();
});

test('PWA theme covers the activity bar, sidebar, editor and composer', async ({ page }) => {
  const ticket = await call('/api/webapp/ticket', { method: 'POST', body: {} });
  await page.goto(ticket.url);
  await page.getByRole('button', { name: '切换主题' }).click();
  await expect(page.locator('.workbench')).toHaveClass(/light/);
  await expect(page.getByRole('navigation', { name: '主活动栏' })).toBeVisible();
  await expect(page.getByRole('textbox', { name: /与 WebAgent 对话/ })).toBeVisible();
});
