// askpass-server.js — 密码请求服务（AtomCode Askpass 等效）
// 通过 SSH_ASKPASS/SUDO_ASKPASS 协议为 AI 提供密码输入支持
'use strict';

const fs = require('fs');
const path = require('path');
const net = require('net');

// ===== 密码缓存 =====
class PasswordCache {
    constructor() {
        this._entries = new Map(); // host → { password, expiresAt }
    }

    get(host) {
        var entry = this._entries.get(host);
        if (!entry) return null;
        if (Date.now() > entry.expiresAt) {
            this._entries.delete(host);
            return null;
        }
        return entry.password;
    }

    set(host, password, ttlMs) {
        ttlMs = ttlMs || 300000; // 默认 5 分钟
        this._entries.set(host, { password: password, expiresAt: Date.now() + ttlMs });
    }

    clear() { this._entries.clear(); }
}

var passwordCache = new PasswordCache();

// ===== Unix Domain Socket 服务器（用于 TUI/AgentView 弹出密码框） =====
function createAskpassServer(getPasswordCallback) {
    // getPasswordCallback: (prompt) => Promise<string | null>
    var server = null;
    var socketPath = '';

    function start() {
        return new Promise((resolve, reject) => {
            socketPath = path.join(require('os').tmpdir(), 'dsagent-askpass-' + Date.now() + '.sock');
            server = net.createServer((stream) => {
                stream.setEncoding('utf-8');
                var data = '';
                stream.on('data', (chunk) => { data += chunk; });
                stream.on('end', async () => {
                    try {
                        var req = JSON.parse(data);
                        // { prompt: "xxx", host: "xxx" }
                        var cached = req.host ? passwordCache.get(req.host) : null;
                        if (cached) {
                            stream.end(JSON.stringify({ password: cached }) + '\n');
                            return;
                        }
                        var password = getPasswordCallback ? await getPasswordCallback(req.prompt || '') : null;
                        if (password && req.host) {
                            passwordCache.set(req.host, password);
                        }
                        stream.end(JSON.stringify({ password: password || '' }) + '\n');
                    } catch (e) {
                        stream.end(JSON.stringify({ error: e.message }) + '\n');
                    }
                });
            });
            server.listen(socketPath, () => { resolve(socketPath); });
            server.on('error', reject);
        });
    }

    function stop() {
        if (server) { try { server.close(); } catch(e) {} server = null; }
        try { if (socketPath && fs.existsSync(socketPath)) fs.unlinkSync(socketPath); } catch(e) {}
    }

    function getSocketPath() { return socketPath; }

    return { start, stop, getSocketPath, passwordCache };
}

// ===== ASKPASS 协议（SSH_ASKPASS / SUDO_ASKPASS） =====
// 直接读 socket，返回密码给 ssh/sudo
function createAskpassHelper() {
    return function(prompt) {
        try {
            var home = process.env.HOME || process.env.USERPROFILE || '.';
            var statePath = path.join(home, '.dsa', 'askpass-state.json');
            if (!fs.existsSync(statePath)) { process.stdout.write(''); return; }
            var state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
            var socketPath = state.socketPath;
            if (!socketPath || !fs.existsSync(socketPath)) { process.stdout.write(''); return; }
            var client = net.createConnection(socketPath, () => {
                client.write(JSON.stringify({ prompt: prompt }) + '\n');
            });
            var data = '';
            client.on('data', (chunk) => { data += chunk; });
            client.on('end', () => {
                try {
                    var res = JSON.parse(data);
                    process.stdout.write(res.password || '');
                } catch(e) { process.stdout.write(''); }
            });
            client.on('error', () => { process.stdout.write(''); });
        } catch(e) { process.stdout.write(''); }
    };
}

module.exports = { createAskpassServer, createAskpassHelper, PasswordCache };
