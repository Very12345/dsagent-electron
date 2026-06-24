// MCP Bridge - 通用 MCP (Model Context Protocol) 客户端
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const http = require('http');
const https = require('https');
const EventEmitter = require('events');

class McpClient {
    constructor(config) {
        this.name = config.name;
        this.command = config.command;
        this.args = config.args || [];
        this.env = config.env || {};
        this.cwd = config.cwd || process.cwd();
        this.process = null;
        this.nextId = 1;
        this.pending = new Map();
        this.buffer = '';
        this.tools = [];
        this.connected = false;
        this._onClose = null;
    }

    async start() {
        return new Promise((resolve, reject) => {
            var env = Object.assign({}, process.env, this.env);
            console.log('[MCP:' + this.name + '] Starting:', this.command, this.args.join(' '));
            this.process = spawn(this.command, this.args, {
                cwd: this.cwd, env: env,
                stdio: ['pipe', 'pipe', 'pipe'],
                windowsHide: true, shell: true
            });
            this.process.stdout.on('data', (data) => this._onData(data.toString()));
            this.process.stderr.on('data', (data) => console.log('[MCP:' + this.name + ' stderr]', data.toString().trim()));
            this.process.on('error', (err) => { this.connected = false; reject(err); });
            this.process.on('close', (code) => {
                this.connected = false;
                if (this._onClose) this._onClose(code);
                this.pending.forEach((p) => p.reject(new Error('MCP server closed')));
                this.pending.clear();
            });
            var initId = this.nextId++;
            var initReq = this._buildRequest('initialize', { protocolVersion: '2024-11-05', capabilities: { tools: {} }, clientInfo: { name: 'dsagent-electron', version: '5.0.5' } }, initId);
            this.process.stdin.write(initReq);
            var timeout = setTimeout(() => reject(new Error('MCP init timeout')), 60000);
            var handler = (id, result) => {
                clearTimeout(timeout);
                this.connected = true;
                this._sendRaw(this._buildNotification('notifications/initialized', {}));
                resolve();
            };
            this.pending.set(initId, { resolve: handler, reject: (e) => { clearTimeout(timeout); reject(e); } });
        });
    }

    async listTools() { var r = await this._sendRequest('tools/list', {}); this.tools = r.tools || []; return this.tools; }
    async callTool(toolName, args) { return await this._sendRequest('tools/call', { name: toolName, arguments: args || {} }); }
    async stop() { if (this.process) { this.process.kill(); this.process = null; } this.connected = false; }
    onClose(cb) { this._onClose = cb; }

    _sendRequest(method, params) {
        return new Promise((resolve, reject) => {
            var id = this.nextId++;
            this.pending.set(id, { resolve, reject });
            this._sendRaw(this._buildRequest(method, params, id));
            setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('MCP timeout: ' + method)); } }, 30000);
        });
    }
    _buildRequest(method, params, id) { var m = { jsonrpc: '2.0', method: method, params: params }; if (id !== undefined) m.id = id; return JSON.stringify(m) + '\n'; }
    _buildNotification(method, params) { return JSON.stringify({ jsonrpc: '2.0', method: method, params: params }) + '\n'; }
    _sendRaw(data) { if (this.process && this.process.stdin.writable) this.process.stdin.write(data); }

    _onData(chunk) {
        this.buffer += chunk;
        var lines = this.buffer.split('\n');
        this.buffer = lines.pop() || '';
        for (var i = 0; i < lines.length; i++) {
            var line = lines[i].trim();
            if (!line) continue;
            try { var msg = JSON.parse(line); this._handleMessage(msg); } catch (e) {}
        }
    }
    _handleMessage(msg) {
        if (msg.id !== undefined && this.pending.has(msg.id)) {
            var p = this.pending.get(msg.id);
            this.pending.delete(msg.id);
            msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result);
        }
    }
}

// ==================== SSE 传输客户端 ====================
class McpSseClient extends EventEmitter {
    constructor(config) {
        super();
        this.name = config.name;
        this.url = config.url;
        this.nextId = 1;
        this.tools = [];
        this.connected = false;
        this.sseReq = null;
        this.sseRes = null;
        this.sessionId = null;
        this._onClose = null;
        this.rejectUnauthorized = config.rejectUnauthorized !== false;
        this._sseBuffer = '';
        this._state = 'disconnected';
    }

    _setState(s) { this._state = s; console.log('[MCP:' + this.name + '] STATE: ' + s); }

    async start() {
        this._setState('connecting');
        var baseUrl = new URL(this.url);
        var transport = baseUrl.protocol === 'https:' ? https : http;

        // 打开 SSE 连接并等待 endpoint
        var endpoint = await new Promise((resolve, reject) => {
            var req = transport.request({
                hostname: baseUrl.hostname,
                port: baseUrl.port || (baseUrl.protocol === 'https:' ? 443 : 80),
                path: baseUrl.pathname + baseUrl.search,
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Accept': 'text/event-stream' },
                timeout: 30000,
                rejectUnauthorized: this.rejectUnauthorized
            }, (res) => {
                this.sseReq = req;
                this.sseRes = res;
                var buf = '';
                res.on('data', (chunk) => {
                    buf += chunk.toString();
                    // 等 endpoint 事件
                    var m = buf.match(/event:\s*endpoint\s*\n\s*data:\s*(\S+)/);
                    if (m) {
                        var ep = m[1];
                        var epUrl = baseUrl.protocol + '//' + baseUrl.host + (ep.startsWith('/') ? '' : '/') + ep;
                        this.url = epUrl;
                        buf = buf.substring(m.index + m[0].length);
                        this._sseBuffer = buf;
                        this._setState('endpoint_ready');
                        resolve(epUrl);
                        // 处理 endpoint 之后的残留数据
                        if (buf.trim()) this._processSseBuffer();
                        return;
                    }
                });
                res.on('end', () => {
                    this._setState('disconnected');
                    this._rejectAll('SSE closed');
                    if (this._onClose) this._onClose(0);
                });
                res.on('error', (e) => { this._setState('error'); this._rejectAll(e.message); });
            });
            req.on('error', (e) => reject(e));
            req.on('timeout', () => { req.destroy(); reject(new Error('SSE timeout')); });
            req.write(JSON.stringify({
                jsonrpc: '2.0', method: 'initialize', id: 0,
                params: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, clientInfo: { name: 'dsagent-electron', version: '5.0.5' } }
            }));
            req.end();
        });

        console.log('[MCP:' + this.name + '] endpoint=' + endpoint);

        // 在 SSE data 事件上注册统一处理器
        this._setupSseHandler();

        // 发送 initialize
        this._setState('initializing');
        var initResult = await this._rpc('initialize', {
            protocolVersion: '2024-11-05',
            capabilities: { tools: {} },
            clientInfo: { name: 'dsagent-electron', version: '5.0.5' }
        });
        this._setState('initialized');
        console.log('[MCP:' + this.name + '] init OK, server=' + (initResult.serverInfo && initResult.serverInfo.name || '?'));

        // initialized 通知
        await this._notify('notifications/initialized', {});
        this.connected = true;
        this._setState('ready');
    }

    // 在 SSE 流上统一处理后续 data 事件
    _setupSseHandler() {
        var self = this;
        if (!self.sseRes) return;
        // 先处理已有的 buffer
        if (self._sseBuffer.trim()) self._processSseBuffer();
        // 监听后续数据
        self.sseRes.on('data', (chunk) => {
            self._sseBuffer += chunk.toString();
            self._processSseBuffer();
        });
    }

    _processSseBuffer() {
        var parts = this._sseBuffer.split(/\n\n/);
        // 最后一段可能不完整，保留
        this._sseBuffer = parts.pop() || '';
        for (var i = 0; i < parts.length; i++) {
            var block = parts[i].trim();
            if (!block) continue;
            var lines = block.split('\n');
            var ev = null, data = '';
            for (var j = 0; j < lines.length; j++) {
                var l = lines[j].trim();
                if (l.startsWith('event:')) ev = l.substring(6).trim();
                else if (l.startsWith('data:')) data += l.substring(5).trim();
            }
            if (!data) continue;
            if (ev === 'message' || !ev) {
                try {
                    var msg = JSON.parse(data);
                    this.emit('rpc:' + msg.id, msg);
                } catch (e) {}
            }
        }
    }

    _rejectAll(reason) {
        var ids = this.eventNames().filter(function(n) { return typeof n === 'string' && n.startsWith('rpc:'); });
        ids.forEach(function(n) {
            var listeners = this.listeners(n);
            listeners.forEach(function(fn) { fn({ error: { message: reason } }); });
            this.removeAllListeners(n);
        }, this);
    }

    // 发送 JSON-RPC 请求，通过 EventEmitter 等待响应
    _rpc(method, params) {
        var self = this;
        return new Promise((resolve, reject) => {
            var id = self.nextId++;
            var eventName = 'rpc:' + id;
            var timer = setTimeout(() => {
                self.removeAllListeners(eventName);
                reject(new Error('MCP rpc timeout: ' + method));
            }, 60000);
            self.once(eventName, (msg) => {
                clearTimeout(timer);
                msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
            });
            self._post(id, method, params);
        });
    }

    _notify(method, params) {
        return new Promise((resolve) => {
            var id = this.nextId++;
            this._post(id, method, params, true);
            // 通知不需要等响应
            resolve();
        });
    }

    _post(id, method, params, isNotify) {
        var urlObj = new URL(this.url);
        var transport = urlObj.protocol === 'https:' ? https : http;
        var headers = { 'Content-Type': 'application/json' };
        if (this.sessionId) headers['Mcp-Session-Id'] = this.sessionId;
        var body = JSON.stringify({ jsonrpc: '2.0', method: method, params: params, id: id });

        var req = transport.request({
            hostname: urlObj.hostname,
            port: urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80),
            path: urlObj.pathname + urlObj.search,
            method: 'POST',
            headers: headers,
            timeout: 30000,
            rejectUnauthorized: this.rejectUnauthorized
        }, (res) => {
            var sid = res.headers['mcp-session-id'];
            if (sid) this.sessionId = sid;
            res.on('data', () => {});
            res.on('end', () => {});
        });
        req.on('error', () => {});
        req.on('timeout', () => { req.destroy(); });
        req.write(body);
        req.end();
    }

    async listTools() { var r = await this._rpc('tools/list', {}); this.tools = r.tools || []; return this.tools; }
    async callTool(toolName, args) { return await this._rpc('tools/call', { name: toolName, arguments: args || {} }); }

    async stop() {
        this.connected = false;
        if (this.sseReq) { try { this.sseReq.destroy(); } catch (e) {} this.sseReq = null; }
        this.removeAllListeners();
        if (this._onClose) this._onClose(0);
    }
    onClose(cb) { this._onClose = cb; }
}

// ==================== MCP 管理器 ====================
class McpManager {
    constructor() { this.clients = new Map(); this.allTools = []; this.toolStates = {}; }

    // 工具状态管理：key = "serverName/toolName"
    _toolKey(server, tool) { return server + '/' + tool; }
    isToolEnabled(server, tool) {
        var key = this._toolKey(server, tool);
        // 默认启用（未配置过的工具默认可用）
        return this.toolStates[key] !== false;
    }
    setToolEnabled(server, tool, enabled) {
        var key = this._toolKey(server, tool);
        this.toolStates[key] = enabled;
    }
    getToolStates() { return this.toolStates; }
    setToolStates(states) { this.toolStates = states || {}; }

    async initFromConfig(mcpServers) {
        this.allTools = [];
        var results = [];
        for (var i = 0; i < mcpServers.length; i++) {
            var cfg = mcpServers[i];
            if (cfg.disabled) {
                console.log('[MCP] ' + cfg.name + ': skipped (disabled)');
                results.push({ name: cfg.name, success: false, error: 'disabled' });
                continue;
            }
            try {
                var client = cfg.url ? new McpSseClient(cfg) : new McpClient(cfg);
                await client.start();
                var tools = await client.listTools();
                this.clients.set(cfg.name, client);
                tools.forEach(function(t) { t._mcpServer = cfg.name; });
                this.allTools = this.allTools.concat(tools);
                console.log('[MCP] ' + cfg.name + ': ' + tools.length + ' tools');
                results.push({ name: cfg.name, success: true, toolCount: tools.length });
            } catch (e) {
                console.error('[MCP] ' + cfg.name + ' FAILED:', e.message);
                results.push({ name: cfg.name, success: false, error: e.message });
            }
        }
        return results;
    }

    // 获取已启用的工具（过滤掉用户禁用的）
    getEnabledTools() {
        var self = this;
        return this.allTools.filter(function(t) {
            return self.isToolEnabled(t._mcpServer || 'unknown', t.name);
        });
    }
    getAllTools() { return this.allTools; }
    async callTool(serverName, toolName, args) {
        if (!this.isToolEnabled(serverName, toolName)) {
            throw new Error('MCP 工具已被禁用: ' + serverName + '/' + toolName);
        }
        var client = this.clients.get(serverName);
        if (!client) throw new Error('MCP server not found: ' + serverName);
        return await client.callTool(toolName, args);
    }
    generateToolsPrompt() {
        var enabledTools = this.getEnabledTools();
        if (enabledTools.length === 0) return '';
        var prompt = '\n\n## MCP 服务器工具\n\n以下是通过 MCP 协议连接的外部工具。使用 `mcp` 调用。\n\n';
        var byServer = {};
        enabledTools.forEach(function(t) { var s = t._mcpServer || 'unknown'; if (!byServer[s]) byServer[s] = []; byServer[s].push(t); });
        for (var server in byServer) {
            prompt += '### ' + server + '\n\n';
            byServer[server].forEach(function(t) { prompt += '- **`' + t.name + '`**'; if (t.description) prompt += ': ' + t.description; prompt += '\n'; });
            prompt += '\n';
        }
        prompt += '> 使用 `mcp`（`{"tool": "mcp", "params": {"server": "服务器名", "tool": "工具名"}}`）调用。\n';
        return prompt;
    }
    async shutdown() { for (var [n, c] of this.clients) { try { await c.stop(); } catch (e) {} } this.clients.clear(); this.allTools = []; }
}

var manager = new McpManager();
module.exports = { McpClient, McpSseClient, McpManager, manager };