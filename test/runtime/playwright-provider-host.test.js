'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const {
  PlaywrightProviderHost,
  normalizeProvider
} = require('../../src/node/playwright-provider-host');

class MockPage extends EventEmitter {
  constructor(context) {
    super();
    this.context = context;
    this.currentUrl = 'about:blank';
    this.closed = false;
    this.inputs = [];
    this.mouse = {
      move: async (...args) => { this.inputs.push(['mouse.move', ...args]); },
      down: async (value) => { this.inputs.push(['mouse.down', value]); },
      up: async (value) => { this.inputs.push(['mouse.up', value]); },
      wheel: async (...args) => { this.inputs.push(['mouse.wheel', ...args]); }
    };
    this.keyboard = {
      down: async (value) => { this.inputs.push(['keyboard.down', value]); },
      up: async (value) => { this.inputs.push(['keyboard.up', value]); },
      insertText: async (value) => { this.inputs.push(['keyboard.insertText', value]); }
    };
  }

  async goto(url) {
    this.currentUrl = url;
    this.emit('framenavigated', this.mainFrame());
    this.emit('domcontentloaded');
    this.emit('load');
    return { ok: () => true };
  }

  url() { return this.currentUrl; }
  isClosed() { return this.closed; }
  mainFrame() {
    if (!this.frame) this.frame = { page: this };
    return this.frame;
  }
  async evaluate(source) {
    if (String(source).includes('localStorage.length')) return this.storage || { url: this.currentUrl, local: {}, session: {} };
    return { evaluated: source };
  }
  async screenshot() { return Buffer.from('png'); }
  async bringToFront() { this.broughtToFront = true; }
  async close() { if (!this.closed) { this.closed = true; this.emit('close'); } }
}

class MockContext extends EventEmitter {
  constructor(profile, options) {
    super();
    this.profile = profile;
    this.options = options;
    this.bindings = {};
    this.scripts = [];
    this._pages = [];
    this.cookieValues = [];
    this.closed = false;
  }
  async exposeBinding(name, handler) { this.bindings[name] = handler; }
  async addInitScript(script) { this.scripts.push(script); }
  async newPage() { const page = new MockPage(this); this._pages.push(page); return page; }
  pages() { return this._pages.slice(); }
  async cookies() { return this.cookieValues.slice(); }
  async storageState() { return { origins: [] }; }
  async close() { this.closed = true; this.emit('close'); }
}

function fixture() {
  const profilesRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'webagent-playwright-host-'));
  const launches = [];
  const chromium = {
    async launchPersistentContext(profile, options) {
      const context = new MockContext(profile, options);
      launches.push(context);
      return context;
    }
  };
  const host = new PlaywrightProviderHost({ chromium, profilesRoot, headless: true, authenticationProbe: async () => true });
  return { host, profilesRoot, launches };
}

async function cleanup(f) {
  await f.host.close();
  fs.rmSync(f.profilesRoot, { recursive: true, force: true });
}

test('one persistent Edge context is reused per provider while workers get separate pages', async () => {
  const f = fixture();
  try {
    const first = await f.host.createWorker('deepseek.pro.web');
    const second = await f.host.createWorker('deepseek.flash.web');
    const qwen = await f.host.createWorker('qwen.web');
    assert.equal(f.launches.length, 2);
    assert.notEqual(first.page, second.page);
    assert.equal(first.profileDir, second.profileDir);
    assert.notEqual(first.profileDir, qwen.profileDir);
    assert.equal(f.launches[0].options.channel, 'msedge');
    assert.equal(f.launches[0].options.headless, true);
    assert.ok(first.profileDir.startsWith(path.resolve(f.profilesRoot) + path.sep));
    assert.equal(first.webContents.getURL(), 'https://chat.deepseek.com/');
    assert.equal(qwen.webContents.getURL(), 'https://www.qianwen.com/');
    assert.ok(f.launches[0].scripts.some((script) => String(script).includes('__webagentRawCompletionAfter')));
    assert.ok(f.launches[0].scripts.some((script) => String(script).includes('__webagentResetRawCompletions')));
    assert.ok(!f.launches[1].scripts.some((script) => String(script).includes('__webagentRawCompletionAfter')));
  } finally { await cleanup(f); }
});

test('openLogin uses provider login URL and exposes the injected clipboard bridge', async () => {
  const calls = [];
  const f = fixture();
  f.host.clipboardBridge = {
    readText: async (meta) => { calls.push(['read', meta.provider]); return 'copied text'; },
    writeText: async (value, meta) => { calls.push(['write', value, meta.provider]); return true; },
    save: async (meta) => ({ owner: meta.provider }),
    restore: async (saved, expected, meta) => ({ restored: true, saved, expected, provider: meta.provider })
  };
  try {
    const worker = await f.host.openLogin('qwen-gateway');
    const context = f.launches[0];
    assert.equal(worker.page.url(), 'https://chat.qwen.ai/auth?action=signin');
    assert.equal(worker.page.broughtToFront, true);
    assert.equal(worker.authenticated, true);
    assert.equal(context.options.headless, false);
    assert.equal(context.closed, true);
    assert.match(context.scripts[0], /electronAPI/);
    assert.equal(await context.bindings.__webagentClipboardReadText({ page: worker.page }), 'copied text');
    assert.equal(await context.bindings.__webagentClipboardWriteText({ page: worker.page }, 'new text'), true);
    assert.deepEqual(calls, [['read', 'qwen-gateway'], ['write', 'new text', 'qwen-gateway']]);
    const background = await f.host.createWorker('qwen-gateway');
    assert.equal(f.launches[1].options.headless, true);
    assert.equal(background.profileDir, worker.profileDir);
  } finally { await cleanup(f); }
});

test('concurrent authentication requests share one headed login window', async () => {
  const f = fixture();
  try {
    const [first, second] = await Promise.all([f.host.openLogin('deepseek'), f.host.openLogin('deepseek')]);
    assert.equal(f.launches.length, 1);
    assert.equal(f.launches[0].options.headless, false);
    assert.equal(first.page, second.page);
  } finally { await cleanup(f); }
});

test('DeepSeek accounts use isolated persistent profiles and persist manual selection', async () => {
  const f = fixture();
  try {
    const account = f.host.createAccount('deepseek', '备用账号');
    assert.notEqual(account.id, 'default');
    await f.host.selectAccount('deepseek', account.id);
    const alternate = await f.host.createWorker('deepseek', { account_id: account.id });
    const listing = f.host.listAccounts('deepseek');
    assert.equal(listing.active_account_id, account.id);
    assert.equal(listing.data.find((item) => item.id === account.id).active, true);
    assert.match(alternate.profileDir, /deepseek--account-/);
    await alternate.destroy();
    await f.host.selectAccount('deepseek', 'default');
    const primary = await f.host.createWorker('deepseek', { account_id: 'default' });
    assert.notEqual(primary.profileDir, alternate.profileDir);
    assert.equal(JSON.parse(fs.readFileSync(path.join(f.profilesRoot, 'accounts.json'), 'utf8')).providers.deepseek.active, 'default');
  } finally { await cleanup(f); }
});

test('webContents maps JavaScript, keyboard, mouse, screenshot and Electron-like events', async () => {
  const f = fixture();
  try {
    const worker = await f.host.createWorker('chatgpt');
    let finished = 0;
    worker.webContents.on('did-finish-load', () => { finished += 1; });
    await worker.webContents.loadURL('https://chatgpt.com/c/test');
    assert.equal(finished, 1);
    assert.deepEqual(await worker.webContents.executeJavaScript('1 + 1', true), { evaluated: '1 + 1' });
    worker.webContents.sendInputEvent({ type: 'mouseMove', x: 12, y: 34 });
    worker.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'A', modifiers: ['control'] });
    worker.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'A', modifiers: ['control'] });
    await worker.webContents.insertText('hello');
    assert.deepEqual(worker.page.inputs, [
      ['mouse.move', 12, 34],
      ['keyboard.down', 'Control'],
      ['keyboard.down', 'A'],
      ['keyboard.up', 'A'],
      ['keyboard.up', 'Control'],
      ['keyboard.insertText', 'hello']
    ]);
    const image = await worker.webContents.capturePage();
    assert.deepEqual(image.toPNG(), Buffer.from('png'));
    assert.match(image.toDataURL(), /^data:image\/png;base64,/);
    await worker.destroy();
    assert.equal(worker.webContents.isDestroyed(), true);
  } finally { await cleanup(f); }
});

test('getBrowserCredentials combines isolated cookies and storage without reading a system profile', async () => {
  const f = fixture();
  try {
    const worker = await f.host.createWorker('qwen-gateway');
    const context = f.launches[0];
    context.cookieValues = [
      { name: 'cnaui', value: 'user-42' },
      { name: 'tongyi_sso_ticket', value: 'ticket' }
    ];
    worker.page.storage = {
      url: worker.page.url(),
      local: { access_token: 'abcdefghijklmnop-access-token' },
      session: {}
    };
    const credentials = await f.host.getBrowserCredentials('qwen-gateway');
    assert.equal(credentials.token, 'abcdefghijklmnop-access-token');
    assert.equal(credentials.user_id, 'user-42');
    assert.equal(credentials.username, 'browser:user-42');
    assert.equal(credentials.cookies.tongyi_sso_ticket, 'ticket');
    assert.ok(context.profile.startsWith(path.resolve(f.profilesRoot) + path.sep));
  } finally { await cleanup(f); }
});

test('provider aliases normalize deterministically and unknown providers fail closed', () => {
  assert.equal(normalizeProvider('qianwen.gateway.3.8-max'), 'qwen-gateway');
  assert.equal(normalizeProvider('openai-web.experimental'), 'chatgpt');
  assert.throws(() => normalizeProvider('../../Edge/User Data'), /Unknown web provider/);
});

test('an explicitly supplied system Edge profile is rejected before Chromium is launched', async () => {
  const previous = process.env.LOCALAPPDATA;
  const fakeLocal = fs.mkdtempSync(path.join(os.tmpdir(), 'webagent-local-app-data-'));
  process.env.LOCALAPPDATA = fakeLocal;
  let launches = 0;
  const host = new PlaywrightProviderHost({
    chromium: { launchPersistentContext: async () => { launches += 1; throw new Error('must not launch'); } },
    profilesRoot: path.join(fakeLocal, 'Microsoft', 'Edge', 'User Data')
  });
  try {
    await assert.rejects(host.createWorker('deepseek'), (error) => error && error.code === 'unsafe_profile_root');
    assert.equal(launches, 0);
  } finally {
    await host.close();
    if (previous === undefined) delete process.env.LOCALAPPDATA;
    else process.env.LOCALAPPDATA = previous;
    fs.rmSync(fakeLocal, { recursive: true, force: true });
  }
});
