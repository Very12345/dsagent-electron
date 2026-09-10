'use strict';

// Read-only-ish DOM diagnostic for the Qianwen model picker. It only returns
// short, visible model-related controls near the top of the page and never
// reads conversation bodies, storage, cookies, headers, or response data.
const WebSocket = require('ws');

async function main() {
  const targets = await fetch('http://127.0.0.1:9223/json/list').then((response) => response.json());
  const target = targets.find((item) => /^https:\/\/www\.qianwen\.com\//.test(String(item.url || '')));
  if (!target) throw new Error('Qianwen Worker target was not found');
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  const pending = new Map();
  let nextId = 0;
  socket.on('message', (buffer) => {
    const message = JSON.parse(buffer);
    if (!message.id || !pending.has(message.id)) return;
    const request = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) request.reject(new Error(message.error.message));
    else request.resolve(message);
  });
  await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  const call = (method, params) => new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params: params || {} }));
    setTimeout(() => { if (pending.delete(id)) reject(new Error(method + ' timed out')); }, 5000);
  });
  await call('Runtime.enable');
  if (process.argv.includes('--state')) {
    const state = await call('Runtime.evaluate', {
      expression: `(() => {
        const generation = window.__qwen && window.__qwen.isGeneratingNow ? window.__qwen.isGeneratingNow() : {};
        const response = window.__qwen && window.__qwen.getLastResponseText ? String(window.__qwen.getLastResponseText() || '') : '';
        return { url: location.origin + location.pathname, generating: !!generation.generating, generationReason: generation.reason || '', responseLength: response.length };
      })()`,
      returnByValue: true
    });
    console.log(JSON.stringify(state.result.result.value, null, 2));
    socket.close();
    return;
  }
  if (process.argv.includes('--open')) {
    await call('Runtime.evaluate', {
      expression: `(() => {
        const picker = Array.from(document.querySelectorAll('[aria-haspopup="dialog"]')).find((node) => /(?:Qwen|千问|3\\.[0-9])/i.test(String(node.innerText || node.textContent || '')));
        if (!picker) return false;
        picker.click();
        return true;
      })()`,
      returnByValue: true
    });
    await new Promise((resolve) => setTimeout(resolve, 700));
  }
  const expression = `(() => {
    const pattern = /(?:Qwen|千问|通义|3\\.[0-9]|Max|Plus|Flash|模型|思考)/i;
    const rows = [];
    for (const node of document.querySelectorAll('button,[role="button"],[role="combobox"],[aria-haspopup],div,span')) {
      const text = String(node.innerText || node.textContent || '').replace(/\\s+/g, ' ').trim();
      if (!text || text.length > 80 || !pattern.test(text)) continue;
      const rect = node.getBoundingClientRect();
      const style = getComputedStyle(node);
      if (rect.width < 16 || rect.height < 12 || rect.top < 0 || rect.top > innerHeight || style.display === 'none' || style.visibility === 'hidden') continue;
      rows.push({
        tag: node.tagName.toLowerCase(),
        text,
        role: node.getAttribute('role') || '',
        aria: node.getAttribute('aria-label') || '',
        expanded: node.getAttribute('aria-expanded') || '',
        popup: node.getAttribute('aria-haspopup') || '',
        cls: typeof node.className === 'string' ? node.className.slice(0, 160) : '',
        rect: [Math.round(rect.left), Math.round(rect.top), Math.round(rect.width), Math.round(rect.height)]
      });
    }
    return rows.filter((row, index, all) => all.findIndex((other) => other.text === row.text && other.rect.join() === row.rect.join()) === index).slice(0, 80);
  })()`;
  const result = await call('Runtime.evaluate', { expression, returnByValue: true });
  console.log(JSON.stringify(result.result.result.value, null, 2));
  socket.close();
}

main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; });
