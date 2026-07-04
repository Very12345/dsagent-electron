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
    // Resources protocol
    async listResources() { var r = await this._sendRequest('resources/list', {}); this.resources = r.resources || []; return this.resources; }
    async readResource(uri) { return await this._sendRequest('resources/read', { uri: uri }); }
    async subscribeResource(uri) { return await this._sendRequest('resources/subscribe', { uri: uri }); }
    async unsubscribeResource(uri) { return await this._sendRequest('resources/unsubscribe', { uri: uri }); }
    // Prompts protocol
    async listPrompts() { var r = await this._sendRequest('prompts/list', {}); this.prompts = r.prompts || []; return this.prompts; }
    async getPrompt(name, args) { return await this._sendRequest('prompts/get', { name: name, arguments: args || {} }); }
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
                res.on('error', (e) => {
                    // 已初始化后 SSE 连接断开是正常现象（服务器超时），降级为 disconnected
                    if (this._state === 'ready') {
                        this._setState('disconnected');
                        console.log('[MCP:' + this.name + '] SSE connection lost (server may have timed out), tools remain cached');
                    } else {
                        this._setState('error');
                    }
                    this._rejectAll(e.message);
                });
                res.on('close', () => {
                    if (this._state === 'ready') this._setState('disconnected');
                });
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
    // Resources protocol
    async listResources() { var r = await this._rpc('resources/list', {}); this.resources = r.resources || []; return this.resources; }
    async readResource(uri) { return await this._rpc('resources/read', { uri: uri }); }
    async subscribeResource(uri) { return await this._rpc('resources/subscribe', { uri: uri }); }
    async unsubscribeResource(uri) { return await this._rpc('resources/unsubscribe', { uri: uri }); }
    // Prompts protocol
    async listPrompts() { var r = await this._rpc('prompts/list', {}); this.prompts = r.prompts || []; return this.prompts; }
    async getPrompt(name, args) { return await this._rpc('prompts/get', { name: name, arguments: args || {} }); }

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
    constructor() {
        this.clients = new Map();
        this.allTools = [];
        this.allResources = [];   // Resources protocol
        this.allPrompts = [];     // Prompts protocol
        this.toolStates = {};
        this.resourceCache = {};  // URI → content (for subscribed resources)
    }

    // 工具状态管理：key = "serverName/toolName"
    _toolKey(server, tool) { return server + '/' + tool; }
    isToolEnabled(server, tool) {
        var key = this._toolKey(server, tool);
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
        this.allResources = [];
        this.allPrompts = [];
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
                // Tools
                var tools = await client.listTools();
                this.clients.set(cfg.name, client);
                tools.forEach(function(t) { t._mcpServer = cfg.name; });
                this.allTools = this.allTools.concat(tools);
                console.log('[MCP] ' + cfg.name + ': ' + tools.length + ' tools');
                // Resources（可选能力）
                try {
                    var resources = await client.listResources();
                    if (resources && resources.length > 0) {
                        resources.forEach(function(r) { r._mcpServer = cfg.name; });
                        this.allResources = this.allResources.concat(resources);
                        console.log('[MCP] ' + cfg.name + ': ' + resources.length + ' resources');
                    }
                } catch (e) { /* resources 不是必备能力 */ }
                // Prompts（可选能力）
                try {
                    var prompts = await client.listPrompts();
                    if (prompts && prompts.length > 0) {
                        prompts.forEach(function(p) { p._mcpServer = cfg.name; });
                        this.allPrompts = this.allPrompts.concat(prompts);
                        console.log('[MCP] ' + cfg.name + ': ' + prompts.length + ' prompts');
                    }
                } catch (e) { /* prompts 不是必备能力 */ }
                results.push({ name: cfg.name, success: true, toolCount: tools.length });
            } catch (e) {
                console.error('[MCP] ' + cfg.name + ' FAILED:', e.message);
                results.push({ name: cfg.name, success: false, error: e.message });
            }
        }
        return results;
    }

    getEnabledTools() {
        var self = this;
        return this.allTools.filter(function(t) {
            return self.isToolEnabled(t._mcpServer || 'unknown', t.name);
        });
    }
    getAllTools() { return this.allTools; }
    getAllResources() { return this.allResources; }
    getAllPrompts() { return this.allPrompts; }

    async callTool(serverName, toolName, args) {
        if (!this.isToolEnabled(serverName, toolName)) {
            throw new Error('MCP 工具已被禁用: ' + serverName + '/' + toolName);
        }
        var client = this.clients.get(serverName);
        if (!client) throw new Error('MCP server not found: ' + serverName);
        return await client.callTool(toolName, args);
    }

    async readResource(serverName, uri) {
        var client = this.clients.get(serverName);
        if (!client) throw new Error('MCP server not found: ' + serverName);
        if (!client.readResource) throw new Error('MCP server does not support resources');
        var result = await client.readResource(uri);
        // 缓存到内存供后续引用
        this.resourceCache[uri] = result;
        return result;
    }

    async getPrompt(serverName, name, args) {
        var client = this.clients.get(serverName);
        if (!client) throw new Error('MCP server not found: ' + serverName);
        if (!client.getPrompt) throw new Error('MCP server does not support prompts');
        return await client.getPrompt(name, args);
    }

    generateToolsPrompt() {
        var enabledTools = this.getEnabledTools();
        var parts = [];
        if (enabledTools.length > 0) {
            var toolPrompt = '\n\n## MCP 服务器工具\n\n以下是通过 MCP 协议连接的外部工具。使用 `mcp` 调用。\n\n';
            var byServer = {};
            enabledTools.forEach(function(t) { var s = t._mcpServer || 'unknown'; if (!byServer[s]) byServer[s] = []; byServer[s].push(t); });
            for (var server in byServer) {
                toolPrompt += '### ' + server + '\n\n';
                byServer[server].forEach(function(t) { toolPrompt += '- **`' + t.name + '`**'; if (t.description) toolPrompt += ': ' + t.description; toolPrompt += '\n'; });
                toolPrompt += '\n';
            }
            toolPrompt += '> 使用 `mcp`（`{"tool": "mcp", "params": {"server": "服务器名", "tool": "工具名", "args": {...}}}`）调用。\n';
            parts.push(toolPrompt);
        }
        // Resources prompt
        if (this.allResources.length > 0) {
            var resPrompt = '\n## MCP 服务器资源\n\n以下 MCP 服务器暴露了可读取的资源（文件/数据）。使用 `mcp_read_resource` 读取。\n\n';
            var resByServer = {};
            this.allResources.forEach(function(r) { var s = r._mcpServer || 'unknown'; if (!resByServer[s]) resByServer[s] = []; resByServer[s].push(r); });
            for (var server in resByServer) {
                resPrompt += '### ' + server + '\n\n';
                resByServer[server].forEach(function(r) {
                    resPrompt += '- `' + r.uri + '`';
                    if (r.name) resPrompt += ' (' + r.name + ')';
                    if (r.description) resPrompt += ': ' + r.description;
                    if (r.mimeType) resPrompt += ' [' + r.mimeType + ']';
                    resPrompt += '\n';
                });
                resPrompt += '\n';
            }
            resPrompt += '> 使用 `{"tool": "mcp_read_resource", "params": {"server": "服务器名", "uri": "资源URI"}}` 读取。\n';
            parts.push(resPrompt);
        }
        // Prompts prompt
        if (this.allPrompts.length > 0) {
            var promptSection = '\n## MCP 服务器提示词\n\n以下 MCP 服务器暴露了可用的提示词模板。使用 `mcp_get_prompt` 获取。\n\n';
            var pByServer = {};
            this.allPrompts.forEach(function(p) { var s = p._mcpServer || 'unknown'; if (!pByServer[s]) pByServer[s] = []; pByServer[s].push(p); });
            for (var server in pByServer) {
                promptSection += '### ' + server + '\n\n';
                pByServer[server].forEach(function(p) {
                    promptSection += '- **`' + p.name + '`**';
                    if (p.description) promptSection += ': ' + p.description;
                    if (p.arguments && p.arguments.length > 0) {
                        promptSection += ' 参数: ' + p.arguments.map(function(a) { return a.name + (a.required ? '*' : ''); }).join(', ');
                    }
                    promptSection += '\n';
                });
                promptSection += '\n';
            }
            promptSection += '> 使用 `{"tool": "mcp_get_prompt", "params": {"server": "服务器名", "name": "提示词名称", "args": {...}}}` 获取。\n';
            parts.push(promptSection);
        }
        return parts.join('\n');
    }

    async shutdown() {
        for (var [n, c] of this.clients) { try { await c.stop(); } catch (e) {} }
        this.clients.clear();
        this.allTools = [];
        this.allResources = [];
        this.allPrompts = [];
        this.resourceCache = {};
    }
}

var manager = new McpManager();
module.exports = { McpClient, McpSseClient, McpManager, manager };