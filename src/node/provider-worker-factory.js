'use strict';

const fs = require('fs');
const path = require('path');
const { createDeepseekServer } = require('../../server-deepseek');
const { createQwenServer } = require('../../server-qwen');
const { createChatGPTServer } = require('../../server-chatgpt');

const HOME_URLS = {
  deepseek: 'https://chat.deepseek.com/',
  qwen: 'https://www.qianwen.com/',
  chatgpt: 'https://chatgpt.com/'
};

function normalizeConversationUrl(value) {
  try {
    const url = new URL(value);
    return url.origin + url.pathname.replace(/\/$/, '');
  } catch (_) { return ''; }
}

function validConversationUrl(provider, value) {
  try {
    const url = new URL(value);
    if (provider === 'deepseek') return url.hostname === 'chat.deepseek.com' && /\/chat\//.test(url.pathname);
    if (provider === 'qwen') return (url.hostname === 'www.qianwen.com' || url.hostname.endsWith('.qwen.ai')) && /\/chat\//.test(url.pathname);
    return (url.hostname === 'chatgpt.com' || url.hostname === 'chat.openai.com') && /\/c\//.test(url.pathname);
  } catch (_) { return false; }
}

function buildInject(root, provider) {
  let combined = '';
  const toolsDir = path.join(root, 'tools');
  const systemFile = path.join(toolsDir, 'tool-system.js');
  if (fs.existsSync(systemFile)) combined += fs.readFileSync(systemFile, 'utf8') + '\n';
  if (provider === 'deepseek') {
    const toolFiles = fs.readdirSync(toolsDir).filter((file) => file.startsWith('tool-') && file.endsWith('.js') && file !== 'tool-system.js').sort();
    for (const file of toolFiles) combined += fs.readFileSync(path.join(toolsDir, file), 'utf8') + '\n';
    const engine = path.join(root, 'agent-engine.js');
    if (fs.existsSync(engine)) combined += fs.readFileSync(engine, 'utf8') + '\n';
    combined += fs.readFileSync(path.join(root, 'inject-deepseek.js'), 'utf8');
  } else if (provider === 'qwen') {
    const parser = path.join(toolsDir, 'tool-parser.js');
    if (fs.existsSync(parser)) combined += fs.readFileSync(parser, 'utf8') + '\n';
    combined += fs.readFileSync(path.join(root, 'inject-qwen.js'), 'utf8');
  }
  return combined;
}

function abortError() {
  return Object.assign(new Error('Run cancelled'), { name: 'AbortError', code: 'run_cancelled' });
}

function serverFor(provider, view) {
  if (provider === 'deepseek') return createDeepseekServer(() => view);
  if (provider === 'qwen') return createQwenServer(() => view);
  return createChatGPTServer(() => view);
}

function createProviderWorkerFactory(host, options) {
  options = options || {};
  const root = path.resolve(options.root || path.join(__dirname, '..', '..'));
  return async function createProviderWorker(provider, workerOptions) {
    if (!HOME_URLS[provider]) throw Object.assign(new Error('Unknown provider: ' + provider), { code: 'unknown_provider' });
    const raw = await host.createWorker(provider, { url: HOME_URLS[provider], account_id: workerOptions && workerOptions.account_id });
    const view = raw;
    const inject = buildInject(root, provider);
    let destroyed = false;
    const injectNow = async () => {
      if (view.webContents.isDestroyed() || !inject) return;
      try { await view.webContents.executeJavaScript(inject, true); }
      catch (error) { console.warn('[Worker:' + provider + '] injection failed:', error.message); }
    };
    view.webContents.on('did-finish-load', () => { void injectNow(); });
    view.webContents.on('render-process-gone', () => { destroyed = true; });
    await injectNow();

    const worker = {
      accountId: raw.accountId || workerOptions && workerOptions.account_id || 'default',
      server: serverFor(provider, view),
      view,
      isDestroyed: () => destroyed || view.webContents.isDestroyed(),
      async navigate(url, signal) {
        if (signal && signal.aborted) throw abortError();
        if (normalizeConversationUrl(view.webContents.getURL()) === normalizeConversationUrl(url)) return;
        if (provider === 'chatgpt') {
          try {
            await view.webContents.executeJavaScript(`(function(){
              const target=${JSON.stringify(url)};const targetPath=new URL(target).pathname;
              const link=Array.from(document.querySelectorAll('a[href*="/c/"]')).find(function(item){try{return new URL(item.href).pathname===targetPath}catch(_){return false}});
              if(link){link.click();return true}location.assign(target);return false;
            })()`, true);
          } catch (_) {}
          const deadline = Date.now() + 30000;
          while (Date.now() < deadline) {
            if (signal && signal.aborted) throw abortError();
            if (normalizeConversationUrl(view.webContents.getURL()) === normalizeConversationUrl(url)) { await injectNow(); return; }
            await new Promise((resolve) => setTimeout(resolve, 300));
          }
        }
        let lastError = null;
        const attempts = provider === 'chatgpt' ? 2 : 1;
        for (let attempt = 0; attempt < attempts; attempt += 1) {
          try {
            await view.webContents.loadURL(url, { timeout: 60000 });
            await injectNow();
            return;
          } catch (error) {
            lastError = error;
            if (signal && signal.aborted) throw abortError();
            await new Promise((resolve) => setTimeout(resolve, 800));
            if (normalizeConversationUrl(view.webContents.getURL()) === normalizeConversationUrl(url)) { await injectNow(); return; }
          }
        }
        throw lastError || Object.assign(new Error('Provider navigation failed'), { code: 'provider_page_load_failed' });
      },
      async ensureAuthenticated(signal) {
        const deadline = Date.now() + 15000;
        while (Date.now() < deadline) {
          if (signal && signal.aborted) throw abortError();
          const editorSelector = provider === 'deepseek'
            ? 'textarea[placeholder], [contenteditable="true"][role="textbox"]'
            : provider === 'qwen' ? '[contenteditable="true"][data-slate-editor="true"]' : '#prompt-textarea';
          const auth = await view.webContents.executeJavaScript(`(function(){
            var path=location.pathname||'';
            var editor=!!document.querySelector(${JSON.stringify(editorSelector)});
            var loginPath=/sign[_-]?in|login/i.test(path);
            var loginButton=Array.from(document.querySelectorAll('button,a')).some(function(el){return /登录|登入|sign in|log in/i.test((el.textContent||'').trim())});
            return {editor:editor,loginPath:loginPath,loginButton:loginButton};
          })()`, true);
          if (auth && auth.editor && !auth.loginPath) return true;
          if (auth && (auth.loginPath || auth.loginButton)) break;
          await new Promise((resolve) => setTimeout(resolve, 400));
        }
        const name = provider === 'deepseek' ? 'DeepSeek' : provider === 'qwen' ? '千问' : 'ChatGPT';
        throw Object.assign(new Error(name + ' 需要登录'), { code: 'provider_auth_required', provider, login_url: HOME_URLS[provider] });
      },
      async assertConversation(expected) {
        const current = normalizeConversationUrl(view.webContents.getURL());
        if (!current || current !== normalizeConversationUrl(expected)) throw Object.assign(new Error('Worker conversation ownership mismatch'), { code: 'conversation_mismatch' });
        return true;
      },
      async waitForConversationUrl(suggested, signal) {
        const deadline = Date.now() + (provider === 'chatgpt' ? 60000 : 20000);
        let previous = '';
        let stable = 0;
        while (Date.now() < deadline) {
          if (signal && signal.aborted) throw abortError();
          const current = view.webContents.getURL() || suggested || '';
          if (validConversationUrl(provider, current)) {
            const normalized = normalizeConversationUrl(current);
            stable = normalized === previous ? stable + 1 : 1;
            previous = normalized;
            if (stable >= 2) return current;
          }
          await new Promise((resolve) => setTimeout(resolve, 300));
        }
        throw Object.assign(new Error('Conversation URL was not confirmed'), { code: 'conversation_url_unconfirmed' });
      },
      async waitForDurableConversationUrl(signal) {
        const deadline = Date.now() + 30000;
        let previous = '';
        let stable = 0;
        while (Date.now() < deadline) {
          if (signal && signal.aborted) throw abortError();
          const current = view.webContents.getURL() || '';
          const durable = validConversationUrl(provider, current) && (provider !== 'chatgpt' || !/\/c\/WEB(?::|%3A)/i.test(new URL(current).pathname));
          if (durable) {
            const normalized = normalizeConversationUrl(current);
            stable = normalized === previous ? stable + 1 : 1;
            previous = normalized;
            if (stable >= 2) return current;
          }
          await new Promise((resolve) => setTimeout(resolve, 300));
        }
        throw Object.assign(new Error('Durable conversation URL was not confirmed'), { code: 'conversation_url_unconfirmed' });
      },
      async inspect() {
        const pageState = await view.webContents.executeJavaScript(`(function(){return {url:location.href,title:document.title,visibility:document.visibilityState,htmlLength:document.documentElement.innerHTML.length,bodyTail:(document.body&&document.body.innerText||'').slice(-4000)}})()`, true);
        pageState.networkResponses = typeof raw.getRawResponses === 'function' ? raw.getRawResponses() : [];
        return pageState;
      },
      async detectContextWindow() {
        if (provider === 'deepseek') return { context_window: 1000000, source: 'deepseek-v4-official' };
        if (provider === 'qwen') return { context_window: 32000, source: 'qwen-web-conservative' };
        try {
          return await view.webContents.executeJavaScript(`(function(){var text=(document.body&&document.body.innerText||'').slice(0,120000);var paid=/\\b(Plus|Pro|Team|Business|Enterprise)\\b/i.test(text);var modern=/\\b(GPT[- ]?5(?:\\.\\d+)?|chat[- ]latest)\\b/i.test(text);return {context_window:modern?400000:(paid?128000:32000),source:modern?'chatgpt-page-model-detected':paid?'chatgpt-page-paid-conservative':'chatgpt-page-free-conservative'}})()`, true);
        } catch (_) { return { context_window: 128000, source: 'chatgpt-web-fallback' }; }
      },
      async destroy() {
        destroyed = true;
        await raw.destroy();
      }
    };
    return worker;
  };
}

module.exports = { createProviderWorkerFactory, buildInject, normalizeConversationUrl, validConversationUrl };
