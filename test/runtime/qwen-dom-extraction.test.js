'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

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
