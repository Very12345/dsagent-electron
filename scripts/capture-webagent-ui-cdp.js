'use strict';

const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

async function main() {
  const mode = process.argv.includes('--models') ? 'models' : 'api';
  const targets = await fetch('http://127.0.0.1:9223/json/list').then((response) => response.json());
  const target = targets.find((item) => item.title === 'WebAgent' && /^file:/.test(item.url));
  if (!target) throw new Error('WebAgent renderer target was not found');
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  const pending = new Map();
  let nextId = 0;
  socket.on('message', (buffer) => {
    const message = JSON.parse(buffer);
    if (!message.id || !pending.has(message.id)) return;
    const request = pending.get(message.id);
    pending.delete(message.id);
    message.error ? request.reject(new Error(message.error.message)) : request.resolve(message);
  });
  await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  const call = (method, params) => new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params: params || {} }));
    setTimeout(() => { if (pending.delete(id)) reject(new Error(method + ' timed out')); }, 8000);
  });
  await call('Page.enable');
  await call('Runtime.enable');
  const expression = mode === 'api' ? `(() => {
    const button = Array.from(document.querySelectorAll('.activity-bar button')).find((node) => node.title === '本地 API');
    if (!button) return 'api activity missing'; button.click(); return 'ok';
  })()` : `(() => {
    const activity = Array.from(document.querySelectorAll('.activity-bar button')).find((node) => node.title === '会话');
    if (activity) activity.click();
    return 'ok';
  })()`;
  await call('Runtime.evaluate', { expression, returnByValue: true });
  if (mode === 'models') {
    await new Promise((resolve) => setTimeout(resolve, 500));
    await call('Runtime.evaluate', { expression: `(() => { const node=document.querySelector('.session-list [role="button"]'); if(node) node.click(); return !!node; })()`, returnByValue: true });
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const clicked = await call('Runtime.evaluate', { expression: `(() => { const node=document.querySelector('.model-picker-trigger'); if(!node) return {found:false}; const r=node.getBoundingClientRect(); return {found:true,disabled:!!node.disabled,x:r.left+r.width/2,y:r.top+r.height/2}; })()`, returnByValue: true });
    const point = clicked.result.result.value;
    if (point.found && !point.disabled) {
      await call('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 });
      await call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1 });
    }
    console.log(JSON.stringify(point));
  }
  await new Promise((resolve) => setTimeout(resolve, mode === 'api' ? 1000 : 500));
  if (mode === 'models') {
    const menu = await call('Runtime.evaluate', { expression: `(() => { const node=document.querySelector('.model-picker-menu'); return node ? {open:true,text:String(node.innerText||'').replace(/\s+/g,' ').trim().slice(0,1000),rect:(() => { const r=node.getBoundingClientRect(); return [r.left,r.top,r.width,r.height]; })()} : {open:false}; })()`, returnByValue: true });
    console.log(JSON.stringify(menu.result.result.value));
  }
  const screenshot = await call('Page.captureScreenshot', { format: 'png', fromSurface: true });
  const output = path.join(process.cwd(), 'artifacts', 'webagent-' + mode + '-ui.png');
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, Buffer.from(screenshot.result.data, 'base64'));
  console.log(output);
  socket.close();
}

main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; });
