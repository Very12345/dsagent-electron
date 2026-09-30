'use strict';

const fs = require('node:fs');
const crypto = require('node:crypto');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const PROVIDERS = Object.freeze({
  deepseek: {
    home: 'https://chat.deepseek.com/',
    login: 'https://chat.deepseek.com/sign_in'
  },
  qwen: {
    home: 'https://chat.qwen.ai/',
    login: 'https://chat.qwen.ai/auth?action=signin'
  },
  'qwen-gateway': {
    home: 'https://chat.qwen.ai/',
    login: 'https://chat.qwen.ai/auth?action=signin'
  },
  chatgpt: {
    home: 'https://chatgpt.com/',
    login: 'https://chatgpt.com/'
  }
});

function isCompletionUrl(provider, value) {
	const url = String(value || '');
	if (provider === 'deepseek') return /\/api\/v0\/chat\/(?:completion|continue)(?:\?|$)/i.test(url);
	if (provider === 'qwen') return /\/api\/v2\/chat\/completions(?:\?|$)/i.test(url);
	return false;
}

function isConversationHistoryUrl(provider, value) {
  const url = String(value || '');
  return provider === 'deepseek' && /\/api\/v0\/chat\/history_messages(?:\?|$)/i.test(url);
}

function deepseekConversationId(value) {
  try {
    const url = new URL(String(value || ''));
    const queryId = url.searchParams.get('chat_session_id');
    if (queryId) return queryId;
    const match = url.pathname.match(/\/a\/chat\/s\/([^/?#]+)/i);
    return match ? decodeURIComponent(match[1]) : '';
  } catch (_) { return ''; }
}

function completionLooksDone(provider, value) {
	const text = String(value || '');
	return provider === 'qwen'
		? /data:\s*\[DONE\]|response\.stopped/i.test(text)
		: /\nevent:\s*close(?:\n|$)/i.test(text);
}

async function pageHasVisibleLoginControl(page) {
  if (!page || typeof page.frames !== 'function') return false;
  for (const frame of page.frames()) {
    if (!frame || typeof frame.getByText !== 'function') continue;
    const locator = frame.getByText(/^(?:登录|登入|Sign in|Log in|Login)$/i, { exact: true });
    const count = Math.min(20, await locator.count().catch(() => 0));
    for (let index = 0; index < count; index += 1) {
      if (await locator.nth(index).isVisible().catch(() => false)) return true;
    }
  }
  return false;
}

const MODIFIER_KEYS = Object.freeze({
  alt: 'Alt',
  control: 'Control',
  ctrl: 'Control',
  meta: 'Meta',
  command: 'Meta',
  shift: 'Shift'
});

function normalizeProvider(value) {
  const input = String(value || '').trim().toLowerCase();
  if (/^deepseek(?:\.|$)/.test(input)) return 'deepseek';
  if (/^(?:qwen|qianwen)(?:[.-]gateway|[.-]gate)(?:\.|$)/.test(input)) return 'qwen-gateway';
  if (/^(?:qwen|qianwen)(?:\.|$)/.test(input)) return 'qwen';
  if (/^(?:chatgpt|openai[.-]web)(?:\.|$)/.test(input)) return 'chatgpt';
  if (Object.prototype.hasOwnProperty.call(PROVIDERS, input)) return input;
  throw Object.assign(new Error('Unknown web provider: ' + (value || '<empty>')), {
    code: 'unknown_provider',
    provider: value
  });
}

function defaultChromium() {
  // `playwright-core` is this package's declared dependency and the only one a
  // plain install guarantees; the other two ship with a full Playwright setup
  // and are kept as fallbacks for hosts that have one.
  try { return require('playwright-core').chromium; }
  catch (_) { /* fall through */ }
  try { return require('playwright').chromium; }
  catch (_) { return require('@playwright/test').chromium; }
}

function safeProfilePath(root, provider) {
  const resolvedRoot = path.resolve(root);
  const forbiddenRoots = [
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Microsoft', 'Edge', 'User Data'),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'User Data')
  ].filter(Boolean).map((item) => path.resolve(item).toLowerCase());
  const lowerRoot = resolvedRoot.toLowerCase();
  if (forbiddenRoots.some((item) => lowerRoot === item || lowerRoot.startsWith(item + path.sep.toLowerCase()))) {
    throw Object.assign(new Error('WebAgent must use an isolated provider profile, not a system browser profile'), {
      code: 'unsafe_profile_root'
    });
  }
  const candidate = path.resolve(resolvedRoot, provider);
  const relative = path.relative(resolvedRoot, candidate);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw Object.assign(new Error('Unsafe provider profile path'), { code: 'unsafe_profile_path' });
  }
  return candidate;
}

function normalizeAccountId(value) {
  const id = String(value || 'default').trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]{0,47}$/.test(id)) throw Object.assign(new Error('Invalid provider account id'), { code: 'provider_account_invalid' });
  return id;
}

function cleanToken(value) {
  const token = String(value || '').replace(/^Bearer\s+/i, '').replace(/^['"]|['"]$/g, '').trim();
  return token.length >= 16 && !/\s/.test(token) ? token : '';
}

function findToken(value, depth, parentKey) {
  if ((depth || 0) > 6 || value == null) return '';
  if (typeof value === 'string') {
    const jwt = value.match(/(?:^|["':\s])(eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)(?:$|["'\s])/);
    if (jwt) return jwt[1];
    try {
      const parsed = JSON.parse(value);
      const nested = findToken(parsed, (depth || 0) + 1, parentKey);
      if (nested) return nested;
    } catch (_) {}
    if (/^(?:token|access[_-]?token|id[_-]?token|auth(?:orization)?|user[_-]?token)$/i.test(String(parentKey || ''))) {
      return cleanToken(value);
    }
    return '';
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const token = findToken(item, (depth || 0) + 1, parentKey);
      if (token) return token;
    }
    return '';
  }
  if (typeof value === 'object') {
    const keys = Object.keys(value).sort((a, b) => Number(/token|auth/i.test(b)) - Number(/token|auth/i.test(a)));
    for (const key of keys) {
      const token = findToken(value[key], (depth || 0) + 1, key);
      if (token) return token;
    }
  }
  return '';
}

class CapturedPage {
  constructor(png) {
    this.png = Buffer.from(png || []);
  }

  isEmpty() { return this.png.length === 0; }
  toPNG() { return Buffer.from(this.png); }
  toDataURL() { return 'data:image/png;base64,' + this.png.toString('base64'); }
}

class PlaywrightWebContents extends EventEmitter {
  constructor(page, options) {
    super();
    this.page = page;
    this.provider = options.provider;
    this.navigationTimeout = options.navigationTimeout;
    this.destroyed = false;
    this._inputQueue = Promise.resolve();
    this._wirePageEvents();
  }

  _wirePageEvents() {
    if (!this.page || typeof this.page.on !== 'function') return;
    this.page.on('load', () => this.emit('did-finish-load'));
    this.page.on('domcontentloaded', () => this.emit('dom-ready'));
    this.page.on('framenavigated', (frame) => {
      if (typeof this.page.mainFrame === 'function' && frame !== this.page.mainFrame()) return;
      const url = this.getURL();
      this.emit('did-navigate', {}, url, 200, 'OK');
      this.emit('did-navigate-in-page', {}, url, true);
    });
    this.page.on('crash', () => {
      this.destroyed = true;
      this.emit('render-process-gone', {}, { reason: 'crashed' });
    });
    this.page.on('close', () => {
      this.destroyed = true;
      this.emit('destroyed');
    });
  }

  isDestroyed() {
    return this.destroyed || !this.page || (typeof this.page.isClosed === 'function' && this.page.isClosed());
  }

  getURL() {
    if (this.isDestroyed() || typeof this.page.url !== 'function') return '';
    return this.page.url() || '';
  }

  async loadURL(url, options) {
    if (this.isDestroyed()) throw Object.assign(new Error('Provider page is destroyed'), { code: 'provider_page_destroyed' });
    const target = String(url || '');
    this.emit('did-start-navigation', {}, target, false, true);
    try {
      return await this.page.goto(target, {
        waitUntil: (options && options.waitUntil) || 'domcontentloaded',
        timeout: Number(options && options.timeout) || this.navigationTimeout
      });
    } catch (error) {
      const code = Number(error && error.errno) || -2;
      this.emit('did-fail-load', {}, code, String(error && error.message || error), target, true);
      throw error;
    }
  }

  async executeJavaScript(source) {
    if (this.isDestroyed()) throw Object.assign(new Error('Provider page is destroyed'), { code: 'provider_page_destroyed' });
    return this.page.evaluate(String(source || ''));
  }

  sendInputEvent(event) {
    const input = Object.assign({}, event);
    const run = () => this._dispatchInputEvent(input);
    this._inputQueue = this._inputQueue.then(run, run).catch((error) => {
      this.emit('input-error', error);
    });
    return this._inputQueue;
  }

  async _dispatchInputEvent(event) {
    if (this.isDestroyed()) return;
    const type = String(event.type || '');
    if (type === 'mouseMove') return this.page.mouse.move(Number(event.x) || 0, Number(event.y) || 0);
    if (type === 'mouseDown') return this.page.mouse.down({ button: event.button || 'left', clickCount: Number(event.clickCount) || 1 });
    if (type === 'mouseUp') return this.page.mouse.up({ button: event.button || 'left', clickCount: Number(event.clickCount) || 1 });
    if (type === 'mouseWheel') return this.page.mouse.wheel(Number(event.deltaX) || 0, Number(event.deltaY) || 0);
    if (type === 'char') return this.page.keyboard.insertText(String(event.keyCode || event.text || ''));

    const key = String(event.keyCode || event.key || '');
    const modifiers = (event.modifiers || []).map((item) => MODIFIER_KEYS[String(item).toLowerCase()]).filter(Boolean);
    if (type === 'keyDown' || type === 'rawKeyDown') {
      for (const modifier of modifiers) await this.page.keyboard.down(modifier);
      if (key) await this.page.keyboard.down(key);
      return;
    }
    if (type === 'keyUp') {
      if (key) await this.page.keyboard.up(key);
      for (const modifier of modifiers.slice().reverse()) await this.page.keyboard.up(modifier);
    }
  }

  async insertText(value) {
    await this._inputQueue;
    if (this.isDestroyed()) throw Object.assign(new Error('Provider page is destroyed'), { code: 'provider_page_destroyed' });
    return this.page.keyboard.insertText(String(value == null ? '' : value));
  }

  async clickVisibleText(labels, options) {
    if (this.isDestroyed()) throw Object.assign(new Error('Provider page is destroyed'), { code: 'provider_page_destroyed' });
    if (!this.page || typeof this.page.getByText !== 'function') return { found: false, clicked: false };
    const timeout = Math.max(250, Number(options && options.timeout) || 1500);
    for (const label of Array.isArray(labels) ? labels : [labels]) {
      const locator = this.page.getByText(String(label || ''), { exact: true });
      const count = await locator.count().catch(() => 0);
      for (let index = count - 1; index >= 0; index -= 1) {
        const candidate = locator.nth(index);
        if (!await candidate.isVisible().catch(() => false)) continue;
        try {
          await candidate.click({ timeout });
          return { found: true, clicked: true, label: String(label || ''), trusted: true, method: 'playwright-text' };
        } catch (_) {}
      }
    }
    return { found: false, clicked: false };
  }

  async clickVisibleButton(labels, options) {
    if (this.isDestroyed()) throw Object.assign(new Error('Provider page is destroyed'), { code: 'provider_page_destroyed' });
    if (!this.page || typeof this.page.getByRole !== 'function') return { found: false, clicked: false };
    const timeout = Math.max(250, Number(options && options.timeout) || 1500);
    const click = !(options && options.click === false);
    for (const label of Array.isArray(labels) ? labels : [labels]) {
      // Restrict matching to accessible buttons. A model response, code block,
      // or search result whose complete text is "Continue" must never be
      // eligible for provider-control automation.
      const locator = this.page.getByRole('button', { name: String(label || ''), exact: true });
      const count = await locator.count().catch(() => 0);
      for (let index = count - 1; index >= 0; index -= 1) {
        const candidate = locator.nth(index);
        if (!await candidate.isVisible().catch(() => false)) continue;
        if (!await candidate.isEnabled().catch(() => true)) continue;
        if (!click) return { found: true, clicked: false, label: String(label || ''), trusted: true, method: 'playwright-button' };
        try {
          await candidate.click({ timeout });
          return { found: true, clicked: true, label: String(label || ''), trusted: true, method: 'playwright-button' };
        } catch (_) {}
      }
    }
    return { found: false, clicked: false };
  }

  async setVisibleToggle(labels, enabled, options) {
    if (this.isDestroyed()) throw Object.assign(new Error('Provider page is destroyed'), { code: 'provider_page_destroyed' });
    if (!this.page || typeof this.page.locator !== 'function') return { success: false, error: 'Provider toggle locator is unavailable' };
    const expected = !!enabled;
    const wanted = (Array.isArray(labels) ? labels : [labels]).map((value) => String(value || '').replace(/\s+/g, ' ').trim());
    const retries = Math.max(1, Math.min(5, Number(options && options.retries) || 3));
    const selector = 'button,[role="button"],[role="switch"],[aria-pressed],.ds-toggle-button';
    const stateOf = async (candidate) => {
      for (const name of ['aria-pressed', 'aria-checked', 'data-active', 'data-selected', 'data-checked']) {
        const value = await candidate.getAttribute(name).catch(() => null);
        if (value === 'true') return { known: true, active: true, source: name };
        if (value === 'false') return { known: true, active: false, source: name };
      }
      const dataState = String(await candidate.getAttribute('data-state').catch(() => '') || '').toLowerCase();
      if (/^(?:on|active|selected|checked|open)$/.test(dataState)) return { known: true, active: true, source: 'data-state' };
      if (/^(?:off|inactive|unselected|unchecked|closed)$/.test(dataState)) return { known: true, active: false, source: 'data-state' };
      const className = String(await candidate.getAttribute('class').catch(() => '') || '').toLowerCase();
      if (/(?:^|[\s_-])(?:active|selected|checked|on)(?:$|[\s_-])/.test(className)) return { known: true, active: true, source: 'class' };
      if (/(?:^|[\s_-])(?:inactive|unselected|unchecked|off)(?:$|[\s_-])/.test(className)) return { known: true, active: false, source: 'class' };
      return { known: false, active: false, source: '' };
    };
    const locate = async () => {
      const controls = this.page.locator(selector);
      const count = await controls.count().catch(() => 0);
      for (let index = count - 1; index >= 0; index -= 1) {
        const candidate = controls.nth(index);
        if (!await candidate.isVisible().catch(() => false)) continue;
        const aria = await candidate.getAttribute('aria-label').catch(() => '');
        const content = aria || await candidate.innerText().catch(() => candidate.textContent().catch(() => ''));
        const label = String(content || '').replace(/\s+/g, ' ').trim();
        if (!wanted.includes(label)) continue;
        return { candidate, label, state: await stateOf(candidate) };
      }
      return null;
    };
    let observed = null;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      observed = await locate();
      if (!observed) return { success: false, enabled: expected, verified: false, error: 'Web Search toggle not found' };
      if (observed.state.known && observed.state.active === expected) {
        return { success: true, enabled: expected, verified: true, source: observed.state.source, method: 'playwright-toggle' };
      }
      if (!observed.state.known && !expected) {
        return { success: true, enabled: false, verified: false, method: 'playwright-toggle' };
      }
      if (attempt >= retries) break;
      try { await observed.candidate.click({ timeout: 1500 }); }
      catch (_) {}
      if (typeof this.page.waitForTimeout === 'function') await this.page.waitForTimeout(250);
      else await new Promise((resolve) => setTimeout(resolve, 250));
    }
    const actual = observed && observed.state && observed.state.known ? observed.state.active : null;
    return { success: false, enabled: expected, verified: actual !== null, actual, error: 'Web Search toggle did not reach requested state' };
  }

  async capturePage(rect) {
    if (this.isDestroyed()) throw Object.assign(new Error('Provider page is destroyed'), { code: 'provider_page_destroyed' });
    const options = { type: 'png' };
    if (rect && Number(rect.width) > 0 && Number(rect.height) > 0) {
      options.clip = {
        x: Number(rect.x) || 0,
        y: Number(rect.y) || 0,
        width: Number(rect.width),
        height: Number(rect.height)
      };
    }
    return new CapturedPage(await this.page.screenshot(options));
  }

  async destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.page && typeof this.page.close === 'function' && !(typeof this.page.isClosed === 'function' && this.page.isClosed())) {
      await this.page.close();
    }
  }
}

class PlaywrightProviderWorker {
  constructor(host, provider, profileDir, page) {
    this.host = host;
    this.provider = provider;
    this.profileDir = profileDir;
    this.page = page;
    this.webContents = new PlaywrightWebContents(page, {
      provider,
      navigationTimeout: host.navigationTimeout
    });
    this.rawResponses = [];
    this.historyResponses = [];
    this.historySequence = 0;
    this.cdpResponses = [];
    this.cdpRequests = new Map();
    this.cdpSequence = 0;
    this.cdpRequestSequence = 0;
    this.cdpRequestMeta = new Map();
    this.cdpSession = null;
    this.cdpReady = this._startCdpCapture();
    if (page && typeof page.on === 'function') {
      page.on('response', (response) => { void this._captureResponse(response); });
    }
  }

  async _startCdpCapture() {
	if (this.provider !== 'deepseek' && this.provider !== 'qwen') return false;
    try {
      const context = this.page && typeof this.page.context === 'function' ? this.page.context() : null;
      if (!context || typeof context.newCDPSession !== 'function') return false;
      const session = await context.newCDPSession(this.page);
      this.cdpSession = session;
      session.on('Network.requestWillBeSent', (event) => this._trackCdpRequest(event));
      session.on('Network.responseReceived', (event) => { void this._beginCdpResponse(event); });
      session.on('Network.dataReceived', (event) => this._appendCdpResponse(event));
      session.on('Network.loadingFinished', (event) => this._finishCdpResponse(event.requestId));
      session.on('Network.loadingFailed', (event) => this._finishCdpResponse(event.requestId, event.errorText || 'Network loading failed'));
      await session.send('Network.enable');
      return true;
    } catch (_) { return false; }
  }

  _trackCdpRequest(event) {
    const request = event && event.request || {};
    const url = String(request.url || '');
	if (!isCompletionUrl(this.provider, url)) return;
    this.cdpRequestMeta.set(event.requestId, {
      seq: ++this.cdpRequestSequence,
      url,
      startedAt: Date.now()
    });
  }

  async _beginCdpResponse(event) {
    const response = event && event.response || {};
    const url = String(response.url || '');
	if (!isCompletionUrl(this.provider, url)) return;
    const requestMeta = this.cdpRequestMeta.get(event.requestId);
    const requestSeq = requestMeta && requestMeta.seq || ++this.cdpRequestSequence;
    this.cdpSequence = Math.max(this.cdpSequence, requestSeq);
    const record = {
      seq: requestSeq,
      requestId: event.requestId,
      url,
      status: Number(response.status) || 0,
      contentType: String(response.mimeType || ''),
      text: '',
      done: false,
      logicalDone: false,
      startedAt: requestMeta && requestMeta.startedAt || Date.now(),
      decoder: new TextDecoder()
    };
    this.cdpRequests.set(event.requestId, record);
    this.cdpResponses.push(record);
    if (this.cdpResponses.length > 6) this.cdpResponses.splice(0, this.cdpResponses.length - 6);
    try {
      const buffered = await this.cdpSession.send('Network.streamResourceContent', { requestId: event.requestId });
      if (buffered && buffered.bufferedData) this._appendCdpBytes(record, buffered.bufferedData);
    } catch (error) {
      record.error = error && error.message || String(error);
    }
  }

  _appendCdpBytes(record, base64) {
    try {
      record.text += record.decoder.decode(Buffer.from(String(base64 || ''), 'base64'), { stream: true });
      if (record.text.length > 16 * 1024 * 1024) record.text = record.text.slice(-16 * 1024 * 1024);
	  if (completionLooksDone(this.provider, record.text)) record.logicalDone = true;
    } catch (error) { record.error = error && error.message || String(error); }
  }

  _appendCdpResponse(event) {
    const record = event && this.cdpRequests.get(event.requestId);
    if (record && event.data) this._appendCdpBytes(record, event.data);
  }

  _finishCdpResponse(requestId, error) {
    const record = this.cdpRequests.get(requestId);
    if (!record) return;
    if (error) record.error = error;
    try { record.text += record.decoder.decode(); } catch (_) {}
    record.done = true;
    record.finishedAt = Date.now();
    this.cdpRequests.delete(requestId);
    this.cdpRequestMeta.delete(requestId);
  }

  async ready() { await this.cdpReady; return this; }

  async _captureResponse(response) {
    try {
      const url = String(response.url ? response.url() : '');
	  if (!url) return;
      const headers = typeof response.allHeaders === 'function' ? await response.allHeaders() : (response.headers ? response.headers() : {});
      const contentType = String(headers && headers['content-type'] || '');
	  if (isConversationHistoryUrl(this.provider, url)) {
        const record = {
          seq: ++this.historySequence,
          url,
          sessionId: deepseekConversationId(url),
          status: typeof response.status === 'function' ? response.status() : 0,
          contentType,
          text: '',
          json: null,
          done: false,
          capturedAt: Date.now()
        };
        this.historyResponses.push(record);
        if (this.historyResponses.length > 12) this.historyResponses.splice(0, this.historyResponses.length - 12);
        try {
          const body = typeof response.body === 'function' ? await response.body() : Buffer.alloc(0);
          record.text = Buffer.from(body || []).toString('utf8').slice(0, 16 * 1024 * 1024);
          try { record.json = JSON.parse(record.text); } catch (_) {}
        } catch (error) {
          record.error = error && error.message || String(error);
        } finally {
          record.done = true;
          record.finishedAt = Date.now();
        }
        return;
      }
	  if (!isCompletionUrl(this.provider, url)) return;
	  const candidate = isCompletionUrl(this.provider, url) && /event-stream/i.test(contentType);
      if (!candidate) return;
      const record = {
        url,
        status: typeof response.status === 'function' ? response.status() : 0,
        contentType,
        text: '',
        done: false,
        capturedAt: Date.now()
      };
      this.rawResponses.push(record);
      if (this.rawResponses.length > 12) this.rawResponses.splice(0, this.rawResponses.length - 12);
      try {
        const body = typeof response.body === 'function' ? await response.body() : Buffer.alloc(0);
        record.text = Buffer.from(body || []).toString('utf8').slice(-4 * 1024 * 1024);
      } catch (error) {
        record.error = error && error.message || String(error);
      } finally {
        record.done = true;
        record.finishedAt = Date.now();
      }
    } catch (_) {}
  }

  getRawResponses() { return this.rawResponses.slice(); }
  rawResponseCursor() { return this.rawResponses.length; }
  completionResponseAfter(cursor) {
	return this.rawResponses.slice(Math.max(0, Number(cursor) || 0)).filter((record) => isCompletionUrl(this.provider, record.url)).slice(-1)[0] || null;
  }
  async rawStreamCursor() {
    let page = 0;
    try { page = Number(await this.page.evaluate(() => window.__webagentRawCompletionCursor ? window.__webagentRawCompletionCursor() : 0)) || 0; } catch (_) {}
    return { cdp: this.cdpRequestSequence, page };
  }
  async resetRawCompletionStreams() {
    this.cdpResponses.length = 0;
    let page = 0;
    try { page = Number(await this.page.evaluate(() => window.__webagentResetRawCompletions ? window.__webagentResetRawCompletions() : 0)) || 0; } catch (_) {}
    return { cdp: this.cdpRequestSequence, page };
  }
  async completionStreamAfter(cursor) {
    const cdpCursor = Number(cursor && cursor.cdp) || 0;
    const cdp = this.cdpResponses.filter((record) => record.seq > cdpCursor).slice(-1)[0];
    if (cdp && (cdp.text || !cdp.error)) return { seq: cdp.seq, url: cdp.url, text: cdp.text, done: cdp.done, logicalDone: cdp.logicalDone, error: cdp.error || '', source: 'cdp' };
    try {
      const pageCursor = Number(cursor && cursor.page) || 0;
      const page = await this.page.evaluate((value) => window.__webagentRawCompletionAfter ? window.__webagentRawCompletionAfter(value) : null, pageCursor);
      return page ? Object.assign({ source: 'page-fetch' }, page) : null;
    } catch (_) { return null; }
  }

  historyResponseCursor() { return this.historySequence; }

  conversationHistoryAfter(cursor, sessionId) {
    const expected = String(sessionId || '');
    return this.historyResponses.filter((record) => record.seq > (Number(cursor) || 0)
      && (!expected || record.sessionId === expected)).slice(-1)[0] || null;
  }

  async reloadConversationHistory(value, options) {
    if (this.provider !== 'deepseek') return null;
    const target = String(value || (this.page && this.page.url && this.page.url()) || '');
    const sessionId = deepseekConversationId(target);
    if (!sessionId) return null;
    const cursor = this.historyResponseCursor();
    const timeout = Math.max(1000, Math.min(30000, Number(options && options.timeout) || 12000));
    try {
      if (this.page && typeof this.page.reload === 'function'
        && deepseekConversationId(this.page.url && this.page.url()) === sessionId) {
        await this.page.reload({ waitUntil: 'domcontentloaded', timeout: this.host.navigationTimeout });
      } else if (this.page && typeof this.page.goto === 'function') {
        await this.page.goto(target, { waitUntil: 'domcontentloaded', timeout: this.host.navigationTimeout });
      } else return null;
    } catch (_) {
      // A history response can still have completed before an unrelated page
      // resource made navigation report a timeout, so inspect the capture.
    }
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const record = this.conversationHistoryAfter(cursor, sessionId);
      if (record && record.done) return {
        seq: record.seq,
        url: record.url,
        sessionId: record.sessionId,
        status: record.status,
        text: record.text,
        json: record.json,
        error: record.error || '',
        source: 'page-history'
      };
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return null;
  }

  isDestroyed() { return this.webContents.isDestroyed(); }
  async destroy() {
    if (this.cdpSession && typeof this.cdpSession.detach === 'function') await this.cdpSession.detach().catch(() => {});
    await this.webContents.destroy();
    this.host._forgetWorker(this);
  }
}

class PlaywrightProviderHost {
  constructor(options) {
    const config = options || {};
    this.chromium = config.chromium || null;
    this.channel = config.channel === undefined ? 'msedge' : config.channel;
    this.headless = config.headless === undefined ? true : !!config.headless;
    this.profilesRoot = path.resolve(config.profilesRoot || path.join(os.homedir(), '.webagent', 'edge-profiles'));
    this.clipboardBridge = config.clipboardBridge || null;
    this.navigationTimeout = Math.max(1000, Number(config.navigationTimeout) || 60000);
    this.viewport = Object.assign({ width: 1280, height: 800 }, config.viewport || {});
    this.launchOptions = Object.assign({}, config.launchOptions || {});
    this.authenticationProbe = typeof config.authenticationProbe === 'function' ? config.authenticationProbe : null;
    this.loginTimeout = Math.max(10000, Number(config.loginTimeout) || 10 * 60 * 1000);
    this.providerUrls = Object.assign({}, PROVIDERS, config.providerUrls || {});
    this.contexts = new Map();
    this.loginAttempts = new Map();
    this.workers = new Set();
    this.pageReservations = new Set();
    this.closed = false;
    this.accountsFile = path.resolve(config.accountsFile || path.join(this.profilesRoot, 'accounts.json'));
    this.accounts = this._loadAccounts();
  }

  _loadAccounts() {
    let value = {};
    try { value = JSON.parse(fs.readFileSync(this.accountsFile, 'utf8')); } catch (_) {}
    const providers = {};
    for (const provider of Object.keys(PROVIDERS)) {
      const source = value.providers && value.providers[provider] || {};
      const items = Array.isArray(source.items) ? source.items.filter((item) => item && /^[a-z0-9][a-z0-9_-]{0,47}$/.test(String(item.id || ''))) : [];
      if (!items.some((item) => item.id === 'default')) items.unshift({ id: 'default', name: '默认账号', created_at: new Date().toISOString(), limited_until: '' });
      const active = items.some((item) => item.id === source.active) ? source.active : 'default';
      const ids = items.map((item) => item.id);
      const configuredOrder = Array.isArray(source.failover_order) ? source.failover_order.filter((id) => ids.includes(id)) : [];
      providers[provider] = { active, items, failover_order: configuredOrder.concat(ids.filter((id) => !configuredOrder.includes(id))), browser_visible: !!source.browser_visible };
    }
    return { version: 1, providers };
  }

  _saveAccounts() {
    fs.mkdirSync(path.dirname(this.accountsFile), { recursive: true });
    const temporary = this.accountsFile + '.tmp-' + process.pid;
    fs.writeFileSync(temporary, JSON.stringify(this.accounts, null, 2), 'utf8');
    fs.renameSync(temporary, this.accountsFile);
  }

  activeAccount(providerValue) {
    const provider = normalizeProvider(providerValue);
    return this.accounts.providers[provider].active;
  }

  listAccounts(providerValue) {
    const provider = normalizeProvider(providerValue);
    const record = this.accounts.providers[provider];
    return { provider, active_account_id: record.active, failover_order: record.failover_order.slice(), browser_visible: !!record.browser_visible, data: record.items.map((item) => ({
      ...item,
      active: item.id === record.active,
      failover_index: record.failover_order.indexOf(item.id),
      profile_exists: fs.existsSync(safeProfilePath(this.profilesRoot, item.id === 'default' ? provider : provider + '--' + item.id))
    })) };
  }

  createAccount(providerValue, name) {
    const provider = normalizeProvider(providerValue);
    const record = this.accounts.providers[provider];
    const id = 'account-' + crypto.randomBytes(5).toString('hex');
    const item = { id, name: String(name || '').trim().slice(0, 64) || '账号 ' + (record.items.length + 1), created_at: new Date().toISOString(), limited_until: '' };
    record.items.push(item);
    record.failover_order.push(id);
    this._saveAccounts();
    return { ...item, active: false };
  }

  async selectAccount(providerValue, accountValue) {
    const provider = normalizeProvider(providerValue);
    const accountId = normalizeAccountId(accountValue);
    const record = this.accounts.providers[provider];
    if (!record.items.some((item) => item.id === accountId)) throw Object.assign(new Error('Provider account not found'), { code: 'provider_account_not_found', status: 404 });
    record.active = accountId;
    this._saveAccounts();
    return this.listAccounts(provider);
  }

  setAccountOrder(providerValue, orderValue) {
    const provider = normalizeProvider(providerValue);
    const record = this.accounts.providers[provider];
    const ids = record.items.map((item) => item.id);
    const requested = Array.isArray(orderValue) ? orderValue.map(normalizeAccountId) : [];
    if (requested.length !== ids.length || new Set(requested).size !== ids.length || requested.some((id) => !ids.includes(id))) {
      throw Object.assign(new Error('Account failover order must contain every account exactly once'), { code: 'provider_account_order_invalid', status: 400 });
    }
    record.failover_order = requested;
    this._saveAccounts();
    return this.listAccounts(provider);
  }

  nextAvailableAccount(providerValue, currentValue, excludedValue) {
    const provider = normalizeProvider(providerValue);
    const record = this.accounts.providers[provider];
    const current = normalizeAccountId(currentValue || record.active);
    const excluded = new Set((Array.isArray(excludedValue) ? excludedValue : []).map(normalizeAccountId));
    const order = record.failover_order.length ? record.failover_order : record.items.map((item) => item.id);
    const start = Math.max(0, order.indexOf(current));
    for (let offset = 1; offset <= order.length; offset += 1) {
      const id = order[(start + offset) % order.length];
      if (!id || id === current || excluded.has(id)) continue;
      const item = record.items.find((candidate) => candidate.id === id);
      if (!item || !item.last_login_at) continue;
      const limitedUntil = Date.parse(item.limited_until || '');
      if (Number.isFinite(limitedUntil) && limitedUntil > Date.now()) continue;
      const profileDir = safeProfilePath(this.profilesRoot, id === 'default' ? provider : provider + '--' + id);
      if (!fs.existsSync(profileDir)) continue;
      return id;
    }
    return '';
  }

  browserVisible(providerValue) {
    const provider = normalizeProvider(providerValue);
    return !!this.accounts.providers[provider].browser_visible;
  }

  async setBrowserVisible(providerValue, visible) {
    const provider = normalizeProvider(providerValue);
    await this._closeProviderContext(provider);
    this.accounts.providers[provider].browser_visible = !!visible;
    this._saveAccounts();
    return this.listAccounts(provider);
  }

  markAccountLimited(providerValue, accountValue, retryAfter) {
    const provider = normalizeProvider(providerValue);
    const accountId = normalizeAccountId(accountValue || this.activeAccount(provider));
    const item = this.accounts.providers[provider].items.find((candidate) => candidate.id === accountId);
    if (!item) return false;
    item.limited_until = new Date(Date.now() + Math.max(1, Number(retryAfter) || 60) * 1000).toISOString();
    this._saveAccounts();
    return true;
  }

  async removeAccount(providerValue, accountValue) {
    const provider = normalizeProvider(providerValue);
    const accountId = normalizeAccountId(accountValue);
    if (accountId === 'default') throw Object.assign(new Error('The default provider account cannot be deleted'), { code: 'provider_account_default', status: 409 });
    const record = this.accounts.providers[provider];
    const index = record.items.findIndex((item) => item.id === accountId);
    if (index < 0) throw Object.assign(new Error('Provider account not found'), { code: 'provider_account_not_found', status: 404 });
    await this._closeProviderContext(provider, accountId);
    record.items.splice(index, 1);
    record.failover_order = record.failover_order.filter((id) => id !== accountId);
    if (record.active === accountId) record.active = 'default';
    this._saveAccounts();
    return this.listAccounts(provider);
  }

  _accountKey(provider, accountId) { return provider + ':' + normalizeAccountId(accountId); }

  async _context(providerValue, accountValue) {
    if (this.closed) throw Object.assign(new Error('Playwright provider host is closed'), { code: 'provider_host_closed' });
    const provider = normalizeProvider(providerValue);
    const accountId = normalizeAccountId(accountValue || this.activeAccount(provider));
    const key = this._accountKey(provider, accountId);
    if (this.contexts.has(key)) return this.contexts.get(key);

    const pending = this._launchContext(provider, undefined, accountId).catch((error) => {
      this.contexts.delete(key);
      throw error;
    });
    this.contexts.set(key, pending);
    return pending;
  }

  async _launchContext(provider, headlessOverride, accountValue) {
    const accountId = normalizeAccountId(accountValue || this.activeAccount(provider));
    const profileDir = safeProfilePath(this.profilesRoot, accountId === 'default' ? provider : provider + '--' + accountId);
    fs.mkdirSync(profileDir, { recursive: true });
    const chromium = this.chromium || defaultChromium();
    const launchOptions = Object.assign({
      headless: headlessOverride === undefined ? (this.headless && !this.browserVisible(provider)) : !!headlessOverride,
      viewport: this.viewport,
      acceptDownloads: true
    }, this.launchOptions);
    if (this.channel) launchOptions.channel = this.channel;
    const context = await chromium.launchPersistentContext(profileDir, launchOptions);
    try {
      await this._installClipboardBridge(context, provider);
      if (this.clipboardBridge) {
        if (typeof context.grantPermissions === 'function') {
          const origin = new URL(this.providerUrls[provider].home).origin;
          await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin });
        }
      }
      // A persistent Chromium context always owns an initial about:blank page.
      // When debug visibility is enabled, keep that unleased page on the real
      // provider home so noVNC shows useful state even though Qwen requests
      // themselves use cookies plus HTTP/SSE and create no worker tab.
      if (launchOptions.headless === false) {
        const pages = typeof context.pages === 'function' ? context.pages() : [];
        const monitor = pages.find((page) => page
          && !(typeof page.isClosed === 'function' && page.isClosed())
          && typeof page.url === 'function'
          && page.url() === 'about:blank') || await context.newPage();
        await monitor.goto(this.providerUrls[provider].home, {
          waitUntil: 'domcontentloaded',
          timeout: this.navigationTimeout
        }).catch(() => {});
        if (typeof monitor.bringToFront === 'function') await monitor.bringToFront().catch(() => {});
      }
    }
    catch (error) {
      if (context && typeof context.close === 'function') await context.close().catch(() => {});
      throw error;
    }
    const record = { provider, accountId, profileDir, context };
    if (context && typeof context.on === 'function') {
      context.on('close', () => {
        const current = this.contexts.get(this._accountKey(provider, accountId));
        if (current && typeof current.then === 'function') {
          current.then((value) => { if (value === record) this.contexts.delete(this._accountKey(provider, accountId)); }).catch(() => {});
        }
      });
    }
    return record;
  }

  async _installClipboardBridge(context, provider) {
    if (this.clipboardBridge) {
      const bindings = [
        ['__webagentClipboardReadText', 'readText'],
        ['__webagentClipboardWriteText', 'writeText'],
        ['__webagentClipboardSave', 'save'],
        ['__webagentClipboardRestore', 'restore']
      ];
      for (const [binding, operation] of bindings) {
        await context.exposeBinding(binding, (source, ...args) => this._callClipboard(operation, provider, source, args));
      }
      await context.addInitScript(`(function(){
        var api = window.electronAPI || {};
        api.clipboardReadText = function(){ return window.__webagentClipboardReadText(); };
        api.clipboardWriteText = function(text){ return window.__webagentClipboardWriteText(String(text == null ? '' : text)); };
        api.clipboardSave = function(){ return window.__webagentClipboardSave(); };
        api.clipboardRestore = function(saved, expectedText){ return window.__webagentClipboardRestore(saved, expectedText); };
        Object.defineProperty(window, 'electronAPI', { configurable: true, value: api });
      })();`);
    }
    if (provider === 'deepseek' || provider === 'qwen') {
	  const completionPattern = provider === 'deepseek'
		? '\\/api\\/v0\\/chat\\/(?:completion|continue)(?:\\?|$)'
		: '\\/api\\/v2\\/chat\\/completions(?:\\?|$)';
	  const completionDonePattern = provider === 'deepseek'
		? '\\nevent:\\s*close(?:\\n|$)'
		: 'data:\\s*\\[DONE\\]|response\\.stopped';
      // Installed before the application scripts run. Reading a cloned fetch
      // body exposes the provider's original SSE incrementally without
      // delaying or consuming the response used by DeepSeek's own UI.
      await context.addInitScript(`(function(){
        if(window.__webagentRawCompletionInstalled||typeof window.fetch!=='function')return;
        window.__webagentRawCompletionInstalled=true;
		var originalFetch=window.fetch;
		var completionPattern=new RegExp(${JSON.stringify(completionPattern)},'i');
		var completionDonePattern=new RegExp(${JSON.stringify(completionDonePattern)},'i');
        var sequence=0;
        var records=[];
        window.__webagentRawCompletionCursor=function(){return sequence;};
        window.__webagentResetRawCompletions=function(){records.length=0;return sequence;};
        window.__webagentRawCompletionAfter=function(cursor){
          var found=records.filter(function(item){return item.seq>Number(cursor||0);});
          return found.length?found[found.length-1]:null;
        };
        window.fetch=async function(){
          var args=Array.prototype.slice.call(arguments);
          var requestUrl=String(args[0]&&(args[0].url||args[0])||'');
		  var isCompletion=completionPattern.test(requestUrl);
          var record=isCompletion?{seq:++sequence,url:requestUrl,text:'',done:false,logicalDone:false,startedAt:Date.now()}:null;
          if(record){records.push(record);if(records.length>4)records.splice(0,records.length-4);}
          var response;
          try{response=await originalFetch.apply(this,args);}
          catch(error){if(record){record.error=error&&error.message||String(error);record.done=true;record.finishedAt=Date.now();}throw error;}
          try{
            var url=String(response.url||args[0]&&(args[0].url||args[0])||'');
			if(!completionPattern.test(url))return response;
            if(!record){record={seq:++sequence,url:url,text:'',done:false,logicalDone:false,startedAt:Date.now()};records.push(record);if(records.length>4)records.splice(0,records.length-4);}
            record.url=url;
            var clone=response.clone();
            Promise.resolve().then(async function(){
              try{
                var reader=clone.body&&clone.body.getReader?clone.body.getReader():null;
				if(!reader){record.text=await clone.text();record.logicalDone=completionDonePattern.test(record.text);return;}
                var decoder=new TextDecoder();
                while(true){
                  var item=await reader.read();
                  if(item.done)break;
                  record.text+=decoder.decode(item.value,{stream:true});
                  if(record.text.length>16777216)record.text=record.text.slice(-16777216);
				  if(completionDonePattern.test(record.text))record.logicalDone=true;
                }
                record.text+=decoder.decode();
				if(completionDonePattern.test(record.text))record.logicalDone=true;
              }catch(error){record.error=error&&error.message||String(error);}
              finally{record.done=true;record.finishedAt=Date.now();}
            });
          }catch(_){}
          return response;
        };
      })();`);
    }
  }

  async _callClipboard(operation, provider, source, args) {
    const handler = this.clipboardBridge[operation] || this.clipboardBridge['clipboard' + operation[0].toUpperCase() + operation.slice(1)];
    if (typeof handler === 'function') {
      return handler(...args, { provider, page: source && source.page });
    }
    if (operation === 'readText') return '';
    if (operation === 'save') return null;
    if (operation === 'restore') return { restored: false, reason: 'clipboard_bridge_unavailable' };
    return false;
  }

  async createWorker(providerValue, options) {
    const provider = normalizeProvider(providerValue);
    const accountId = normalizeAccountId(options && options.account_id || this.activeAccount(provider));
    const record = await this._context(provider, accountId);
    const claimedPages = new Set(Array.from(this.workers).map((worker) => worker.page));
    const pages = typeof record.context.pages === 'function' ? record.context.pages() : [];
    const reusable = pages.find((candidate) => candidate
      && !(typeof candidate.isClosed === 'function' && candidate.isClosed())
      && !claimedPages.has(candidate)
      && !this.pageReservations.has(candidate)
      && typeof candidate.url === 'function'
      && candidate.url() === 'about:blank');
    const page = reusable || await record.context.newPage();
    // createWorker calls for title generation and the first real turn can race
    // immediately after startup. Reserve the initial page before the first
    // await so a concurrent call cannot bind and navigate the same page.
    this.pageReservations.add(page);
    const worker = new PlaywrightProviderWorker(this, provider, record.profileDir, page);
    try { await worker.ready(); }
    catch (error) { this.pageReservations.delete(page); await worker.destroy().catch(() => {}); throw error; }
    worker.accountId = accountId;
    this.workers.add(worker);
    this.pageReservations.delete(page);
    const config = options || {};
    const url = Object.prototype.hasOwnProperty.call(config, 'url') ? config.url : this.providerUrls[provider].home;
    if (url) {
      try { await worker.webContents.loadURL(url, config); }
      catch (error) { await worker.destroy().catch(() => {}); throw error; }
    }
    return worker;
  }

  async openLogin(providerValue, options) {
    const provider = normalizeProvider(providerValue);
    const accountId = normalizeAccountId(options && options.account_id || this.activeAccount(provider));
    const key = this._accountKey(provider, accountId);
    if (this.loginAttempts.has(key)) return this.loginAttempts.get(key);
    const attempt = this._openLogin(provider, Object.assign({}, options || {}, { account_id: accountId })).finally(() => {
      if (this.loginAttempts.get(key) === attempt) this.loginAttempts.delete(key);
    });
    this.loginAttempts.set(key, attempt);
    return attempt;
  }

  async _openLogin(provider, options) {
    const accountId = normalizeAccountId(options && options.account_id || this.activeAccount(provider));
    const config = Object.assign({}, options || {}, { url: (options && options.url) || this.providerUrls[provider].login });
    if (!this.headless || this.browserVisible(provider)) {
      const worker = await this.createWorker(provider, Object.assign({}, config, { account_id: accountId }));
      if (worker.page && typeof worker.page.bringToFront === 'function') await worker.page.bringToFront();
      await this._waitForAuthentication(provider, worker.page, config.signal);
      const account = this.accounts.providers[provider].items.find((item) => item.id === accountId);
      if (account) { account.last_login_at = new Date().toISOString(); account.limited_until = ''; this._saveAccounts(); }
      return worker;
    }
    await this._closeProviderContext(provider, accountId);
    const key = this._accountKey(provider, accountId);
    const pending = this._launchContext(provider, false, accountId).catch((error) => {
      this.contexts.delete(key);
      throw error;
    });
    this.contexts.set(key, pending);
    const record = await pending;
    const existing = typeof record.context.pages === 'function' ? record.context.pages().find((page) => page && !(typeof page.isClosed === 'function' && page.isClosed())) : null;
    const page = existing || await record.context.newPage();
    await page.goto(config.url, { waitUntil: 'domcontentloaded', timeout: this.navigationTimeout });
    if (typeof page.bringToFront === 'function') await page.bringToFront();
    try {
      await this._waitForAuthentication(provider, page, config.signal);
      const account = this.accounts.providers[provider].items.find((item) => item.id === accountId);
      if (account) { account.last_login_at = new Date().toISOString(); account.limited_until = ''; this._saveAccounts(); }
      return { provider, account_id: accountId, profileDir: record.profileDir, page, authenticated: true };
    } finally {
      await this._closeProviderContext(provider, accountId);
    }
  }

  async _waitForAuthentication(provider, page, signal) {
    const startedAt = Date.now();
    const deadline = Date.now() + this.loginTimeout;
    const selector = provider === 'deepseek'
      ? 'textarea[placeholder], [contenteditable="true"][role="textbox"]'
      : provider === 'qwen' || provider === 'qwen-gateway'
        ? '[contenteditable="true"][data-slate-editor="true"], textarea[placeholder]'
        : '#prompt-textarea, [contenteditable="true"][role="textbox"]';
    while (Date.now() < deadline) {
      if (signal && signal.aborted) throw Object.assign(new Error('Login cancelled'), { name: 'AbortError', code: 'run_cancelled' });
      if (!page || (typeof page.isClosed === 'function' && page.isClosed())) throw Object.assign(new Error('Login window was closed before authentication completed'), { code: 'provider_login_cancelled' });
      const authenticated = this.authenticationProbe
        ? await this.authenticationProbe(provider, page)
        : await page.evaluate(({ editorSelector, provider }) => {
          const path = location.pathname || '';
          const loginLines = String(document.body && document.body.innerText || '').split(/\r?\n/).map((line) => line.replace(/\s+/g, ' ').trim());
          const loginVisible = loginLines.some((text) => /^(?:登录|登入|Sign in|Log in|Login)$/i.test(text)) || Array.from(document.querySelectorAll('button,a,[role="button"],span,div')).some((node) => {
            const text = String(node.textContent || '').replace(/\s+/g, ' ').trim();
            const rect = node.getBoundingClientRect();
            const style = getComputedStyle(node);
            return /^(?:登录|登入|Log in|Login|Sign in)$/i.test(text) && rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
          });
          return !!document.querySelector(editorSelector) && !/sign[_-]?in|login/i.test(path) && !(provider === 'qwen' && loginVisible);
        }, { editorSelector: selector, provider }).catch(() => false);
      if (provider === 'qwen' && (Date.now() - startedAt < 3000 || await pageHasVisibleLoginControl(page))) {
        await new Promise((resolve) => setTimeout(resolve, 400));
        continue;
      }
      if (authenticated) return true;
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
    throw Object.assign(new Error('Provider login timed out'), { code: 'provider_login_timeout' });
  }

  async _closeProviderContext(providerValue, accountValue) {
    const provider = normalizeProvider(providerValue);
    const accountId = accountValue == null ? null : normalizeAccountId(accountValue);
    const keys = Array.from(this.contexts.keys()).filter((key) => key.startsWith(provider + ':') && (!accountId || key === this._accountKey(provider, accountId)));
    const pendings = keys.map((key) => this.contexts.get(key)).filter(Boolean);
    keys.forEach((key) => this.contexts.delete(key));
    const workers = Array.from(this.workers).filter((worker) => worker.provider === provider && (!accountId || worker.accountId === accountId));
    await Promise.allSettled(workers.map((worker) => worker.destroy()));
    await Promise.allSettled(pendings.map(async (pending) => {
      const record = await pending;
      if (record && record.context && typeof record.context.close === 'function') await record.context.close();
    }));
  }

  async getCookies(providerValue, urls) {
    const record = await this._context(providerValue);
    return urls == null ? record.context.cookies() : record.context.cookies(urls);
  }

  async readStorage(providerValue) {
    const provider = normalizeProvider(providerValue);
    const record = await this._context(provider);
    const pages = typeof record.context.pages === 'function' ? record.context.pages() : [];
    let page = pages.find((candidate) => {
      try { return new URL(candidate.url()).hostname === new URL(this.providerUrls[provider].home).hostname; }
      catch (_) { return false; }
    });
    let temporary = false;
    if (!page) {
      page = await record.context.newPage();
      temporary = true;
      await page.goto(this.providerUrls[provider].home, { waitUntil: 'domcontentloaded', timeout: this.navigationTimeout });
    }
    try {
      return await page.evaluate(`(function(){
        var out={url:location.href,local:{},session:{}};
        for(var i=0;i<localStorage.length;i++){var k=localStorage.key(i);out.local[k]=localStorage.getItem(k)}
        for(var j=0;j<sessionStorage.length;j++){var s=sessionStorage.key(j);out.session[s]=sessionStorage.getItem(s)}
        return out;
      })()`);
    } finally {
      if (temporary && page && typeof page.close === 'function') await page.close().catch(() => {});
    }
  }

  async readStorageToken(providerValue) {
    const credentials = await this.getBrowserCredentials(providerValue);
    return credentials.token;
  }

  async getBrowserCredentials(providerValue) {
    const provider = normalizeProvider(providerValue);
    const cookieList = await this.getCookies(provider);
    const cookies = Object.fromEntries((cookieList || []).map((cookie) => [cookie.name, cookie.value]));
    let storage = { local: {}, session: {} };
    try { storage = await this.readStorage(provider); } catch (_) {}
    let state = null;
    try {
      const record = await this._context(provider);
      if (record.context && typeof record.context.storageState === 'function') state = await record.context.storageState();
    } catch (_) {}
    const token = findToken(cookies) || findToken(storage) || findToken(state) || '';
    const userId = cookies.cnaui || cookies.aui || cookies['b-user-id'] || '';
    return {
      provider,
      token,
      user_id: userId,
      username: 'browser:' + (cookies['b-user-id'] || userId || 'session'),
      cookies,
      cookie_list: cookieList || [],
      storage
    };
  }

  _forgetWorker(worker) { this.workers.delete(worker); }

  async close() {
    if (this.closed) return;
    this.closed = true;
    const workers = Array.from(this.workers);
    await Promise.allSettled(workers.map((worker) => worker.destroy()));
    const contexts = await Promise.allSettled(Array.from(this.contexts.values()));
    await Promise.allSettled(contexts.filter((item) => item.status === 'fulfilled').map((item) => {
      const context = item.value && item.value.context;
      return context && typeof context.close === 'function' ? context.close() : Promise.resolve();
    }));
    this.contexts.clear();
    this.loginAttempts.clear();
    this.pageReservations.clear();
  }
}

module.exports = {
  PlaywrightProviderHost,
  PlaywrightProviderWorker,
  PlaywrightWebContents,
  CapturedPage,
  normalizeProvider,
  findToken
};
