'use strict';

// Read-only diagnostic for the Qwen login BrowserWindow. It intentionally
// excludes cookies, storage, request headers and response bodies.
const WebSocket = require('ws');

async function main() {
  const targets = await fetch('http://127.0.0.1:9223/json/list').then((response) => response.json());
  const target = targets.find((item) => String(item.url || '').includes('chat.qwen.ai'));
  if (!target) throw new Error('Qwen auth target was not found');
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  const pending = new Map();
  const events = [];
  let nextId = 0;
  socket.on('message', (buffer) => {
    const message = JSON.parse(buffer);
    if (message.id && pending.has(message.id)) {
      pending.get(message.id)(message);
      pending.delete(message.id);
    } else if (message.method) events.push(message);
  });
  await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  const call = (method, params) => new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, resolve);
    socket.send(JSON.stringify({ id, method, params: params || {} }));
    setTimeout(() => { if (pending.delete(id)) reject(new Error(method + ' timed out')); }, 5000);
  });
  // Page-domain calls are handled outside the renderer's JavaScript main
  // thread. Run them first so a wedged login SPA still yields useful evidence.
  const treeResult = await Promise.allSettled([
    call('Page.getFrameTree'),
    call('Page.captureScreenshot', { format: 'png', fromSurface: true })
  ]);
  const tree = treeResult[0].status === 'fulfilled' ? treeResult[0].value : null;
  const screenshot = treeResult[1].status === 'fulfilled' ? treeResult[1].value : null;
  if (screenshot && screenshot.result && screenshot.result.data) {
    require('fs').writeFileSync('artifacts/qwen-auth-cdp.png', Buffer.from(screenshot.result.data, 'base64'));
  }
  const runtimeEnabled = await call('Runtime.enable').then(() => true, () => false);
  if (runtimeEnabled) await call('Log.enable').catch(() => {});
  await new Promise((resolve) => setTimeout(resolve, 500));
  const evaluated = runtimeEnabled ? await call('Runtime.evaluate', {
    expression: `(() => {
      const compactStyle = (node) => node ? {
        display: getComputedStyle(node).display,
        visibility: getComputedStyle(node).visibility,
        opacity: getComputedStyle(node).opacity,
        width: node.getBoundingClientRect().width,
        height: node.getBoundingClientRect().height
      } : null;
      return {
        url: location.origin + location.pathname + location.search,
        title: document.title,
        ready: document.readyState,
        text: (document.body && document.body.innerText || '').slice(0, 1500),
        bodyChildren: document.body ? document.body.children.length : 0,
        body: compactStyle(document.body),
        root: compactStyle(document.querySelector('#root')),
        app: compactStyle(document.querySelector('#app')),
        htmlPrefix: (document.body && document.body.innerHTML || '').slice(0, 1500)
      };
    })()`,
    returnByValue: true
  }).catch(() => null) : null;
  const errors = events.filter((event) => event.method === 'Log.entryAdded').map((event) => ({
    level: event.params.entry.level,
    source: event.params.entry.source,
    text: String(event.params.entry.text || '').slice(0, 500)
  }));
  console.log(JSON.stringify({
    target: { title: target.title, url: target.url },
    frame: tree && tree.result && tree.result.frameTree && tree.result.frameTree.frame,
    frameError: treeResult[0].status === 'rejected' ? treeResult[0].reason.message : null,
    screenshot: screenshot ? 'artifacts/qwen-auth-cdp.png' : null,
    page: evaluated && evaluated.result && evaluated.result.result && evaluated.result.result.value,
    errors
  }, null, 2));
  socket.close();
}

main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; });
