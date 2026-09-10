'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { SessionStore } = require('../../src/runtime/session-store');
const { RuntimeConfigStore } = require('../../src/runtime/config-store');
const { MobileGateway } = require('../../src/runtime/mobile-gateway');
const { BotGateway } = require('../../src/runtime/bot-gateway');

function get(port, route, cookie) { return new Promise((resolve, reject) => { const req = http.request({ hostname: '127.0.0.1', port, path: route, headers: cookie ? { Cookie: cookie } : {} }, (res) => { let raw = ''; res.on('data', (chunk) => { raw += chunk; }); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, raw })); }); req.on('error', reject); req.end(); }); }

test('five bot platforms expose one task-oriented adapter contract', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsagent-bots-'));
  try {
    const store = new SessionStore(root).init(); const config = new RuntimeConfigStore(root).init();
    const runs = { startRun: async (sessionId) => ({ id: 'run_test', session_id: sessionId, status: 'queued' }) };
    const bots = new BotGateway({ store, config, runs });
    assert.deepEqual(bots.platforms().map((item) => item.id), ['wechat', 'wecom', 'qq', 'feishu', 'dingtalk']);
    const bot = bots.create({ platform: 'wechat', enabled: true }); assert.equal(bot.mode, 'task_delegate');
    const task = await bots.dispatch({ platform: 'wechat', channel_id: 'room', message_id: 'one', text: '完成大型任务' });
    assert.equal(task.run_id, 'run_test');
    assert.equal((await bots.dispatch({ platform: 'wechat', message_id: 'one', text: 'duplicate' })).duplicate, true);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('mobile gateway requires one-time pairing and stores only hashed device tokens', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsagent-mobile-'));
  const port = 0;
  const store = new SessionStore(root).init(); const config = new RuntimeConfigStore(root).init();
  const runs = { activeRunForSession: () => null, startRun: async () => ({ id: 'run' }), approvals: { list: () => [] } };
  const mobile = new MobileGateway({ store, config, runs });
  try {
    await mobile.start(port); const actualPort = mobile.port; const pairing = mobile.createPairing(false); const code = new URL(pairing.url).searchParams.get('code');
    const paired = await get(actualPort, '/pair?code=' + encodeURIComponent(code)); assert.equal(paired.status, 302);
    const cookie = paired.headers['set-cookie'][0].split(';')[0];
    assert.equal((await get(actualPort, '/mobile/api/sessions')).status, 401);
    assert.equal((await get(actualPort, '/mobile/api/sessions', cookie)).status, 200);
    const mobilePage = await get(actualPort, '/', cookie);
    assert.equal(mobilePage.status, 200);
    assert.match(mobilePage.raw, /请旋转设备至竖屏以继续使用 WebAgent/);
    assert.match(mobilePage.raw, /#send \{ flex: 0 0 auto/);
    assert.ok(config.list('devices')[0].token_hash); assert.equal(Object.prototype.hasOwnProperty.call(config.list('devices')[0], 'token'), false);
    assert.equal((await get(actualPort, '/pair?code=' + encodeURIComponent(code))).status, 403);
  } finally { await mobile.stop(); fs.rmSync(root, { recursive: true, force: true }); }
});
