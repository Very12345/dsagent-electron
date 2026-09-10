'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createChatGPTServer } = require('../../server-chatgpt');

test('experimental ChatGPT web adapter sends, waits, streams snapshots and extracts metadata', async () => {
  let url = 'https://chatgpt.com/'; let sent = false; let extractionSource = ''; let inserted = '';
  const view = { webContents: {
    isDestroyed: () => false, getURL: () => url, loadURL: async (value) => { url = value; },
    insertText: async (value) => { inserted = value; sent = false; },
    sendInputEvent: (event) => { if ((event.type === 'mouseUp' && inserted) || (event.type === 'keyUp' && event.keyCode === 'Enter')) { sent = true; url = 'https://chatgpt.com/c/test'; } },
    executeJavaScript: async (source) => {
      if (source.includes('const editors=')) return { ok: true, editorX: 70, editorY: 100, before: url, assistantCount: 0, lastAssistantText: '', userCount: 0, lastUserText: '' };
      if (source.includes('const sendButtons=')) return { ok: true, x: 100, y: 100 };
      if (source.includes('const remaining=')) return sent;
      if (source.includes('const stopNode=')) return { stop: false, complete: sent, text: sent ? 'hello' : '' };
      if (source.includes('const candidates=')) { extractionSource = source; return { markdown: 'hello', think: '', title: 'Adapter Test', url }; }
      return null;
    }
  } };
  const server = createChatGPTServer(() => view);
  const created = await server.invoke('chatgpt.web', 'newChat', { userText: 'hello' }); assert.equal(created.success, true);
  assert.equal(inserted, 'hello');
  assert.equal((await server.invoke('chatgpt.web', 'waitForDone', { timeout: 3000 })).success, true);
  const peek = await server.invoke('chatgpt.web', 'peekResponse', {}); assert.equal(peek.data.text, 'hello');
  const metadata = await server.invoke('chatgpt.web', 'getConversationMetadata', {}); assert.equal(metadata.data.title, 'Adapter Test'); assert.equal(metadata.data.url, 'https://chatgpt.com/c/test');
  assert.doesNotThrow(() => new Function('document', 'Node', 'return ' + extractionSource));
  assert.match(extractionSource, /codeLanguage/);
  assert.match(extractionSource, /wa-plot\|mermaid\|typst/);
  assert.doesNotMatch(extractionSource, /\['p','div','section'/);
  assert.match(extractionSource, /root\.innerText\|\|root\.textContent/);
});

test('ChatGPT adapter uses trusted insertion and accepts a second turn on the same URL', async () => {
  let url = 'https://chatgpt.com/c/existing';
  let inserted = '';
  let submitted = false;
  let userCount = 1;
  const inputEvents = [];
  const view = { webContents: {
    isDestroyed: () => false,
    getURL: () => url,
    insertText: async (value) => { inserted = value; submitted = false; },
    sendInputEvent: (event) => {
      inputEvents.push(event);
      if (event.type === 'mouseUp' && inserted) { submitted = true; userCount += 1; }
    },
    executeJavaScript: async (source) => {
      if (source.includes('const editors=')) return { ok: true, editorX: 80, editorY: 120, before: url, assistantCount: 1, lastAssistantText: 'first answer', userCount, lastUserText: 'first turn' };
      if (source.includes('const sendButtons=')) return { ok: true, x: 700, y: 120 };
      if (source.includes('const remaining=')) return submitted;
      return null;
    }
  } };
  const server = createChatGPTServer(() => view);
  const result = await server.invoke('chatgpt.web', 'sendMessage', { text: 'second turn' });
  assert.equal(result.success, true);
  assert.equal(inserted, 'second turn');
  assert.ok(inputEvents.some((event) => event.type === 'keyDown' && event.keyCode === 'A' && event.modifiers.includes('control')));
  assert.ok(inputEvents.some((event) => event.type === 'mouseUp' && event.x === 700));
});

test('ChatGPT deletion falls back to the currently open conversation when its sidebar row is unloaded', async () => {
  let url = 'https://chatgpt.com/c/legacy';
  const events = [];
  const view = { webContents: {
    isDestroyed: () => false, getURL: () => url,
    sendInputEvent: (event) => { events.push(event); },
    executeJavaScript: async (source) => {
      if (source.includes('const wanted=') && source.includes('if(!anchor)')) return { found: true, direct: true, title: 'Legacy chat', hover: null, option: null };
      if (source.includes("querySelectorAll('button')).filter(visible)")) return { x: 520, y: 44 };
      if (source.includes('const menuPoint=')) return { x: 520, y: 88 };
      if (source.includes('const wantedTitle=')) return { x: 520, y: 140 };
      if (source.includes('const remains=')) return false;
      return null;
    }
  } };
  const server = createChatGPTServer(() => view);
  const result = await server.invoke('chatgpt.web', 'deleteConversation', { convid: url });
  assert.equal(result.success, true);
  assert.ok(events.some((event) => event.type === 'mouseUp' && event.x === 520 && event.y === 44));
});

test('ChatGPT deletion accepts a verified missing direct conversation as already deleted', async () => {
  const url = 'https://chatgpt.com/c/already-gone';
  const events = [];
  const view = { webContents: {
    isDestroyed: () => false, getURL: () => url,
    sendInputEvent: (event) => { events.push(event); },
    executeJavaScript: async (source) => {
      if (source.includes('const wanted=') && source.includes('if(!anchor)')) return { found: true, direct: true, title: 'ChatGPT', hover: null, option: null };
      if (source.includes('const normalise=function')) return { exact: true, hasSidebarRow: false, hasMessages: false, genericTitle: true, loading: false };
      if (source.includes("querySelectorAll('button')).filter(visible)")) return null;
      return null;
    }
  } };
  const server = createChatGPTServer(() => view);
  const result = await server.invoke('chatgpt.web', 'deleteConversation', { convid: url });
  assert.equal(result.success, true);
  assert.equal(result.data.already_missing, true);
  assert.equal(events.length, 0);
});
