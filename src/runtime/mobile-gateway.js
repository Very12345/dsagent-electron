'use strict';

const http = require('http');
const os = require('os');
const crypto = require('crypto');
const { URL } = require('url');
const qrcode = require('qrcode-generator');

function json(res, status, value, headers) {
  res.writeHead(status, Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, headers || {}));
  res.end(JSON.stringify(value));
}
function hash(value) { return crypto.createHash('sha256').update(String(value)).digest('hex'); }
function body(req, limit = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => { raw += chunk; if (raw.length > limit) reject(new Error('Request body too large')); });
    req.on('end', () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch (error) { reject(error); } });
    req.on('error', reject);
  });
}
function localAddress() {
  for (const values of Object.values(os.networkInterfaces())) {
    for (const entry of values || []) if (entry.family === 'IPv4' && !entry.internal) return entry.address;
  }
  return '127.0.0.1';
}
function qrData(value) {
  const qr = qrcode(0, 'M'); qr.addData(value); qr.make();
  return qr.createDataURL(5, 8);
}

const MOBILE_HTML = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>WebAgent Mobile</title><style>
:root{color-scheme:dark;font:14px system-ui;background:#181818;color:#ddd}*{box-sizing:border-box}body{margin:0}header{position:sticky;top:0;display:flex;justify-content:space-between;align-items:center;padding:12px 16px;background:#202020;border-bottom:1px solid #333}button,input,textarea,select{font:inherit;color:inherit;background:#252526;border:1px solid #444;border-radius:5px;padding:8px}button{cursor:pointer}.layout{display:grid;grid-template-columns:290px 1fr;height:calc(100vh - 51px)}aside{overflow:auto;border-right:1px solid #333;padding:10px}.session{display:block;width:100%;text-align:left;margin:4px 0;border:0;background:transparent}.session.active{background:#37373d}.main{display:grid;grid-template-rows:1fr auto;min-width:0}.messages{overflow:auto;padding:14px}.message{max-width:900px;margin:0 auto 14px;padding:12px;border-bottom:1px solid #303030}.message b{display:block;margin-bottom:7px}.composer{display:flex;gap:8px;padding:10px;border-top:1px solid #333}.composer textarea{flex:1;resize:none}.muted{color:#999}.tools{font-size:12px;color:#8ab4f8}@media(max-width:700px){.layout{grid-template-columns:1fr}aside{display:none}.layout.show-list aside{display:block}.layout.show-list .main{display:none}}</style><body>
<header><b>WebAgent Mobile</b><div><button id="list">会话</button> <button id="new">新建</button></div></header><div class="layout" id="layout"><aside><input id="search" placeholder="搜索会话" style="width:100%"><div id="sessions"></div></aside><section class="main"><div class="messages" id="messages"><p class="muted">选择一个会话</p></div><div class="composer"><textarea id="prompt" rows="2" placeholder="发送任务"></textarea><button id="send">发送</button></div></section></div><script>
const S={sessions:[],current:null};async function api(path,opt={}){const r=await fetch(path,{...opt,headers:{'Content-Type':'application/json',...(opt.headers||{})}});if(!r.ok)throw new Error((await r.json()).error||r.statusText);return r.json()}function esc(v){return String(v||'').replace(/[<>"'&]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}function renderSessions(){const q=document.querySelector('#search').value.toLowerCase();document.querySelector('#sessions').innerHTML=S.sessions.filter(s=>s.title.toLowerCase().includes(q)).map(s=>'<button class="session '+(S.current&&S.current.id===s.id?'active':'')+'" data-id="'+s.id+'"><b>'+esc(s.title)+'</b><br><span class="muted">'+esc(s.mode)+' · '+esc(s.model)+'</span></button>').join('');document.querySelectorAll('.session').forEach(b=>b.onclick=()=>open(b.dataset.id))}function renderMessages(){document.querySelector('#messages').innerHTML=(S.current?.messages||[]).filter(m=>!m.hidden&&m.role!=='tool').map(m=>'<article class="message"><b>'+(m.role==='user'?'你':'WebAgent')+'</b><div>'+esc(m.content).replace(/\n/g,'<br>')+'</div></article>').join('')||'<p class="muted">暂无消息</p>';document.querySelector('#messages').scrollTop=document.querySelector('#messages').scrollHeight}async function load(){const d=await api('/mobile/api/sessions');S.sessions=d.data;renderSessions()}async function open(id){S.current=await api('/mobile/api/sessions/'+id);renderSessions();renderMessages();document.querySelector('#layout').classList.remove('show-list')}document.querySelector('#new').onclick=async()=>{const s=await api('/mobile/api/sessions',{method:'POST',body:JSON.stringify({title:'新会话',mode:'chat'})});await load();open(s.id)};document.querySelector('#send').onclick=async()=>{const input=document.querySelector('#prompt');if(!S.current||!input.value.trim())return;const text=input.value.trim();input.value='';await api('/mobile/api/sessions/'+S.current.id+'/runs',{method:'POST',body:JSON.stringify({prompt:text,agent_mode:S.current.mode!=='chat'})});setTimeout(async()=>{await open(S.current.id);await load()},800)};document.querySelector('#list').onclick=()=>document.querySelector('#layout').classList.toggle('show-list');document.querySelector('#search').oninput=renderSessions;load();
</script></body></html>`;

// The mobile gateway intentionally supports portrait only.  Its desktop-like
// two-pane conversation UI cannot remain operable at phone landscape height;
// show an explicit rotation state instead of letting the model selector or
// composer push the send action off-screen.
const MOBILE_STYLE_OVERRIDES = `<style>
@media (orientation: landscape) and (max-height: 520px) and (max-width: 900px) {
  body { min-height: 100svh; overflow: hidden; }
  body > header, body > .layout { visibility: hidden; }
  body::before { content: '请旋转设备至竖屏以继续使用 WebAgent'; position: fixed; z-index: 9; inset: 0; display: grid; place-items: center; padding: 24px; color: #ddd; background: #181818; text-align: center; font: 600 16px/1.5 system-ui; }
}
@media (max-width: 420px) {
  .composer { min-width: 0; gap: 6px; padding: 8px; }
  .composer textarea { min-width: 0; }
  #send { flex: 0 0 auto; white-space: nowrap; }
}
</style>`;

class MobileGateway {
  constructor(options) {
    this.store = options.store; this.runs = options.runs; this.config = options.config;
    this.server = null; this.port = null; this.pairings = new Map(); this.tunnel = null; this.tunnelUrl = ''; this.rate = new Map();
  }
  async start(port) {
    if (this.server) return this.status();
    const requestedPort = port === 0 ? 0 : (Number(port) || 5860);
    const candidates = requestedPort === 0 ? [0] : Array.from({ length: 50 }, (_, index) => requestedPort + index);
    for (const candidate of candidates) {
      const server = http.createServer(this._handle.bind(this));
      try {
        await new Promise((resolve, reject) => { server.once('error', reject); server.listen(candidate, '0.0.0.0', resolve); });
        this.server = server; this.port = server.address().port; return this.status();
      } catch (error) { try { server.close(); } catch (_) {} if (!['EADDRINUSE', 'EACCES'].includes(error.code)) throw error; }
    }
    throw Object.assign(new Error('No mobile gateway port is available'), { code: 'mobile_port_unavailable' });
  }
  async stop() {
    if (this.tunnel) { try { this.tunnel.close(); } catch (_) {} this.tunnel = null; this.tunnelUrl = ''; }
    if (this.server) await new Promise((resolve) => this.server.close(resolve));
    this.server = null; this.port = null;
  }
  async setTunnel(enabled) {
    if (!enabled) { if (this.tunnel) this.tunnel.close(); this.tunnel = null; this.tunnelUrl = ''; return this.status(); }
    if (!this.server) await this.start();
    if (!this.tunnel) {
      const localtunnel = require('localtunnel');
      this.tunnel = await localtunnel({ port: this.port, local_host: '127.0.0.1' });
      this.tunnelUrl = this.tunnel.url;
      this.tunnel.on('close', () => { this.tunnel = null; this.tunnelUrl = ''; });
    }
    return this.status();
  }
  createPairing(useTunnel) {
    if (!this.server) throw Object.assign(new Error('Mobile gateway is not running'), { code: 'mobile_not_running', status: 409 });
    const code = crypto.randomBytes(18).toString('base64url');
    const base = useTunnel && this.tunnelUrl ? this.tunnelUrl : `http://${localAddress()}:${this.port}`;
    const url = `${base}/pair?code=${encodeURIComponent(code)}`;
    this.pairings.set(hash(code), Date.now() + 5 * 60 * 1000);
    return { url, qr: qrData(url), expires_at: new Date(Date.now() + 5 * 60 * 1000).toISOString() };
  }
  status() { return { running: !!this.server, port: this.port, lan_url: this.server ? `http://${localAddress()}:${this.port}` : '', tunnel_url: this.tunnelUrl, devices: this.config.list('devices').map(({ token_hash, ...item }) => item) }; }
  revoke(deviceId) { return this.config.delete('devices', deviceId); }
  _device(req) {
    const match = String(req.headers.cookie || '').match(/(?:^|;\s*)dsa_device=([^;]+)/);
    if (!match) return null;
    const tokenHash = hash(decodeURIComponent(match[1]));
    return this.config.list('devices').find((item) => item.token_hash === tokenHash && !item.revoked_at) || null;
  }
  async _handle(req, res) {
    try {
      const url = new URL(req.url, 'http://mobile.local');
      const address = String(req.socket.remoteAddress || 'unknown');
      const bucket = this.rate.get(address) || { start: Date.now(), count: 0 };
      if (Date.now() - bucket.start > 60000) { bucket.start = Date.now(); bucket.count = 0; }
      bucket.count += 1; this.rate.set(address, bucket);
      if (bucket.count > 240) return json(res, 429, { error: '请求过于频繁' });
      const origin = String(req.headers.origin || '');
      if (!['GET', 'HEAD'].includes(req.method) && origin) {
        const originHost = new URL(origin).host;
        if (originHost !== String(req.headers.host || '')) return json(res, 403, { error: 'origin_mismatch' });
      }
      if (url.pathname === '/pair') {
        const key = hash(url.searchParams.get('code') || ''); const expires = this.pairings.get(key);
        if (!expires || expires < Date.now()) return json(res, 403, { error: '配对码无效或已过期' });
        this.pairings.delete(key);
        const token = crypto.randomBytes(32).toString('base64url');
        this.config.create('devices', { name: String(req.headers['user-agent'] || '移动设备').slice(0, 120), role: 'admin', token_hash: hash(token), last_seen_at: new Date().toISOString() });
        this.config.audit('mobile.device_paired', { address: req.socket.remoteAddress });
        res.writeHead(302, { Location: '/', 'Set-Cookie': `dsa_device=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000` }); return res.end();
      }
      const device = this._device(req);
      if (!device) return json(res, 401, { error: '需要扫码配对' });
      if (req.method === 'GET' && url.pathname === '/') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }); return res.end(MOBILE_HTML.replace('</style>', '</style>' + MOBILE_STYLE_OVERRIDES)); }
      if (req.method === 'GET' && url.pathname === '/mobile/api/bootstrap') return json(res, 200, { projects: this.config.list('projects'), settings: this.config.getSettings(), devices: this.status().devices, approvals: this.runs.approvals ? this.runs.approvals.list() : [] });
      if (req.method === 'GET' && url.pathname === '/mobile/api/sessions') return json(res, 200, { data: this.store.list() });
      if (req.method === 'POST' && url.pathname === '/mobile/api/sessions') return json(res, 201, this.store.create(await body(req)));
      const sessionMatch = url.pathname.match(/^\/mobile\/api\/sessions\/([^/]+)$/);
      if (sessionMatch) {
        const sid = decodeURIComponent(sessionMatch[1]);
        if (req.method === 'GET') return json(res, 200, this.store.get(sid));
        if (req.method === 'PATCH') return json(res, 200, this.store.update(sid, await body(req)));
        if (req.method === 'DELETE') { if (this.runs.activeRunForSession(sid)) return json(res, 409, { error: 'session_busy' }); return json(res, 200, this.store.trash(sid)); }
      }
      const restoreMatch = url.pathname.match(/^\/mobile\/api\/sessions\/([^/]+)\/restore$/);
      if (req.method === 'POST' && restoreMatch) return json(res, 200, this.store.restore(decodeURIComponent(restoreMatch[1])));
      const runMatch = url.pathname.match(/^\/mobile\/api\/sessions\/([^/]+)\/runs$/);
      if (req.method === 'POST' && runMatch) return json(res, 202, await this.runs.startRun(decodeURIComponent(runMatch[1]), await body(req)));
      if (url.pathname === '/mobile/api/projects') { if (req.method === 'GET') return json(res, 200, { data: this.config.list('projects') }); if (req.method === 'POST') return json(res, 201, this.config.create('projects', await body(req))); }
      if (url.pathname === '/mobile/api/settings') { if (req.method === 'GET') return json(res, 200, this.config.getSettings()); if (req.method === 'PATCH') return json(res, 200, this.config.patchSettings('user', null, await body(req))); }
      if (url.pathname === '/mobile/api/approvals' && req.method === 'GET') return json(res, 200, { data: this.runs.approvals ? this.runs.approvals.list() : [] });
      const approvalMatch = url.pathname.match(/^\/mobile\/api\/approvals\/([^/]+)$/);
      if (approvalMatch && req.method === 'POST' && this.runs.approvals) { const value = await body(req); return json(res, 200, this.runs.approvals.resolve(decodeURIComponent(approvalMatch[1]), !!value.approved, 'mobile')); }
      return json(res, 404, { error: 'not_found' });
    } catch (error) { return json(res, error.status || 500, { error: error.message }); }
  }
}

module.exports = { MobileGateway, localAddress };
