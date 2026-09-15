'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { parseQwenSse } = require('../../server-qwen');

test('Qianwen native page SSE separates reasoning and final answer without DOM or clipboard', () => {
	const raw = [
		'data: {"choices":[{"delta":{"role":"assistant","phase":"think","content":"先分析"}}]}',
		'',
		'data: {"choices":[{"delta":{"role":"assistant","phase":"answer","content":"答案"}}]}',
		'',
		'data: {"choices":[{"delta":{"role":"assistant","phase":"answer","content":"完成"}}]}',
		'',
		'data: [DONE]',
		''
	].join('\n');
	assert.deepEqual(parseQwenSse(raw, false), {
		content: '答案完成',
		reasoning: '先分析',
		images: [],
		error: '',
		done: true
	});
});

test('Qianwen A/B page SSE selects response_index zero instead of concatenating candidates', () => {
	const raw = [
		'data: {"response.created":{"response_id":"b","response_index":"1"}}', '',
		'data: {"response.created":{"response_id":"a","response_index":"0"}}', '',
		'data: {"choices":[{"delta":{"role":"assistant","phase":"answer","content":"SECOND"}}],"response_id":"b"}', '',
		'data: {"choices":[{"delta":{"role":"assistant","phase":"answer","content":"FIRST"}}],"response_id":"a"}', ''
	].join('\n');
	const parsed = parseQwenSse(raw, true);
	assert.equal(parsed.content, 'FIRST');
	assert.equal(parsed.done, true);
});

function textClone(text) {
  return {
    innerText: text,
    textContent: text,
    querySelectorAll: () => []
  };
}

test('Qianwen extraction selects the assistant markdown even when the user message is the last generic DOM item', () => {
  let buttons = [];
  const assistantContent = {
    innerText: 'Nameeee',
    textContent: 'Nameeee',
    parentElement: null,
    querySelector: () => null,
    querySelectorAll: () => [],
    cloneNode: () => textClone('Nameeee'),
    closest(selector) {
      if (selector.includes('contenteditable') || selector.includes('data-message-author-role="user"')) return null;
      if (selector.includes('[class*="message"]')) return assistantMessage;
      return null;
    }
  };
  const assistantMessage = {
    textContent: 'Nameeee',
    parentElement: null,
    querySelector: (selector) => selector.includes('.qk-markdown') ? assistantContent : null,
    querySelectorAll: (selector) => selector.includes('.qk-markdown') ? [assistantContent] : [],
    closest: () => null,
    cloneNode: () => textClone('Nameeee')
  };
  assistantContent.parentElement = assistantMessage;
  const userMessage = {
    textContent: 'repeat Nameeee',
    querySelector: () => null,
    querySelectorAll: () => [],
    closest: (selector) => selector.includes('data-message-author-role="user"') ? userMessage : null,
    cloneNode: () => textClone('repeat Nameeee')
  };
  const document = {
    body: {}, documentElement: {},
    querySelector: () => null,
    querySelectorAll(selector) {
      if (selector === 'button') return buttons;
      if (selector.includes('.qk-markdown') && selector.includes('data-message-author-role="assistant"')) return [assistantContent];
      if (selector.includes('[class*="message"]')) return [assistantMessage, userMessage];
      return [];
    }
  };
  const sandbox = {
    document,
    location: { href: 'https://www.qianwen.com/chat/test' },
    console: { log() {}, warn() {}, error() {} },
    MutationObserver: class { observe() {} },
    setTimeout, clearTimeout, setInterval: () => 1, clearInterval() {},
    Array, Object, String, Number, Boolean, Date, Math, Promise, RegExp,
    window: null
  };
  sandbox.window = sandbox;
  const source = fs.readFileSync(path.join(__dirname, '..', '..', 'inject-qwen.js'), 'utf8');
  vm.runInNewContext(source, sandbox, { filename: 'inject-qwen.js' });

  sandbox.window.__qwen._lastSentText = 'repeat Nameeee';
  assert.equal(sandbox.window.__qwen.getLastResponseText(), 'Nameeee');
  assert.equal(sandbox.window.__qwen.getPhase1Text(), 'Nameeee');
  assert.equal(sandbox.window.__qwen.isLastUserEcho('repeat Nameeee'), true);
  assert.equal(sandbox.window.__qwen.isLastUserEcho('Nameeee'), false);

  buttons = [{
    className: 'toolbar-stopPropagation-control',
    getAttribute: () => '',
    querySelector: () => null
  }];
  assert.equal(sandbox.window.__qwen.isGeneratingNow().generating, false);
  buttons = [{
    className: '',
    getAttribute: (name) => name === 'aria-label' ? '停止回答' : '',
    querySelector: () => null
  }];
  assert.equal(sandbox.window.__qwen.isGeneratingNow().generating, true);
});

test('Qianwen web model selector clicks the requested concrete model and confirms the page state', async () => {
  let currentModel = 'Qwen3.7-千问';
  let expanded = false;
  const rect = { width: 180, height: 36 };
  const picker = {
    get innerText() { return currentModel; },
    get textContent() { return currentModel; },
    className: 'model-trigger cursor-pointer',
    parentElement: null,
    getBoundingClientRect: () => rect,
    getAttribute(name) {
      if (name === 'aria-haspopup') return 'dialog';
      if (name === 'aria-expanded') return expanded ? 'true' : 'false';
      return null;
    },
    click() { expanded = true; }
  };
  const option = {
    innerText: 'Qwen3.8-Max',
    textContent: 'Qwen3.8-Max',
    className: 'model-option cursor-pointer',
    parentElement: null,
    getBoundingClientRect: () => rect,
    getAttribute: () => null,
    click() {
      currentModel = 'Qwen3.8-Max';
      expanded = false;
    }
  };
  const document = {
    body: {}, documentElement: {},
    querySelector: () => null,
    querySelectorAll(selector) {
      if (selector === '[aria-haspopup="dialog"]') return [picker];
      if (selector === 'div,button,[role="button"],[role="option"],[role="menuitem"]') return expanded ? [option] : [];
      if (selector === 'button') return [];
      return [];
    }
  };
  const sandbox = {
    document,
    location: { href: 'https://www.qianwen.com/chat/test' },
    console: { log() {}, warn() {}, error() {} },
    MutationObserver: class { observe() {} },
    setTimeout, clearTimeout, setInterval: () => 1, clearInterval() {},
    getComputedStyle: () => ({ display: 'block', visibility: 'visible' }),
    Array, Object, String, Number, Boolean, Date, Math, Promise, RegExp,
    window: null
  };
  sandbox.window = sandbox;
  const source = fs.readFileSync(path.join(__dirname, '..', '..', 'inject-qwen.js'), 'utf8');
  vm.runInNewContext(source, sandbox, { filename: 'inject-qwen.js' });

  const result = await sandbox.window.__qwen.selectModel('qwen.3.8-max');
  assert.equal(result.success, true);
  assert.equal(result.model, 'Qwen3.8-Max');
  assert.equal(sandbox.window.__qwen.getCurrentModel(), 'Qwen3.8-Max');
});

test('Qianwen accepts one stable generated image from the current single-image card', async () => {
  let now = 0;
  const image = {
    currentSrc: 'https://workspace-zb-cdn.qianwen.com/generated-single.png',
    src: 'https://workspace-zb-cdn.qianwen.com/generated-single.png',
    naturalWidth: 1024,
    naturalHeight: 1024,
    width: 512,
    height: 512,
    getAttribute: () => null,
    getBoundingClientRect: () => ({ width: 512, height: 512 }),
    closest: () => null
  };
  const card = {
    textContent: '',
    querySelectorAll: (selector) => selector === 'img' ? [image] : [],
    querySelector: () => null,
    closest: () => null
  };
  const assistantMessage = {
    textContent: '',
    parentElement: null,
    querySelector: (selector) => selector.includes('data-ppt-id') ? null : selector.includes('.qk-markdown') ? assistantContent : null,
    querySelectorAll: (selector) => selector.includes('generate_image') || selector.includes('generated-image') ? [card] : selector.includes('.qk-markdown') ? [assistantContent] : selector === 'img' ? [image] : [],
    closest: () => null,
    cloneNode: () => textClone('')
  };
  const assistantContent = {
    innerText: '', textContent: '', parentElement: assistantMessage,
    querySelector: () => null, querySelectorAll: () => [], cloneNode: () => textClone(''),
    closest(selector) { return selector.includes('data-message-author-role="assistant"') ? assistantMessage : null; }
  };
  const disabledSend = { disabled: true };
  const document = {
    body: { innerText: '' }, documentElement: {},
    querySelector(selector) {
      if (selector === 'button[aria-label="发送消息"][disabled]') return disabledSend;
      return null;
    },
    querySelectorAll(selector) {
      if (selector === 'button') return [];
      if (selector.includes('data-message-author-role="assistant"') && selector.includes('.qk-markdown')) return [assistantContent];
      if (selector.includes('data-card-type*="generate_image"')) return [card];
      return [];
    }
  };
  const FastDate = class extends Date { static now() { return now; } };
  const fastTimeout = (callback, delay) => { now += Math.max(Number(delay) || 0, 600); queueMicrotask(callback); return 1; };
  const sandbox = {
    document,
    location: { href: 'https://www.qianwen.com/chat/single-image' },
    console: { log() {}, warn() {}, error() {} },
    MutationObserver: class { observe() {} },
    setTimeout: fastTimeout, clearTimeout() {}, setInterval: () => 1, clearInterval() {},
    getComputedStyle: () => ({ display: 'block', visibility: 'visible' }),
    Array, Object, String, Number, Boolean, Date: FastDate, Math, Promise, RegExp,
    window: null
  };
  sandbox.window = sandbox;
  const source = fs.readFileSync(path.join(__dirname, '..', '..', 'inject-qwen.js'), 'utf8');
  vm.runInNewContext(source, sandbox, { filename: 'inject-qwen.js' });

  assert.deepEqual(Array.from(sandbox.window.__qwen.getLastImageUrls()), ['https://workspace-zb-cdn.qianwen.com/generated-single.png']);
  assert.equal(sandbox.window.__qwen.detectResponseType().type, 'image');
  assert.equal((await sandbox.window.__qwen.waitForDrawResponse(10000)).success, true);
});
