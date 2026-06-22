// MCP Bridge - 通用 MCP (Model Context Protocol) 客户端
// 支持 stdio 传输，连接本地 MCP 服务器进程
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

class McpClient {
    constructor(config) {
        this.name = config.name;
        this.command = config.command;
        this.args = config.args || [];
        this.env = config.env || {};
        this.cwd = config.cwd || process.cwd();
        this.process = null;
        this.nextId = 1;
        this.pending = new Map();     // id → { resolve, reject }
        this.buffer = '';
        this.tools = [];
        this.connected = false;
        this._onClose = null;
    }

    // ==================== 启动 MCP 服务器进程 ====================
    async start() {
        return new Promise((resolve, reject) => {
            var env = Object.assign({}, process.env, this.env);
            console.log('[MCP:' + this.name + '] Starting:', this.command, this.args.join(' '));
            
            this.process = spawn(this.command, this.args, {
                cwd: this.cwd,
                env: env,
                stdio: ['pipe', 'pipe', 'pipe'],
                windowsHide: true
            });

            this.process.stdout.on('data', (data) => {
                this._onData(data.toString());
            });

            this.process.stderr.on('data', (data) => {
                console.log('[MCP:' + this.name + ' stderr]', data.toString().trim());
            });

            this.process.on('error', (err) => {
                console.error('[MCP:' + this.name + '] Process error:', err.message);
                this.connected = false;
                reject(err);
            });

            this.process.on('close', (code) => {
                console.log('[MCP:' + this.name + '] Process exited with code', code);
                this.connected = false;
                if (this._onClose) this._onClose(code);
                // 清理所有未完成的请求
                this.pending.forEach((p) => p.reject(new Error('MCP server closed')));
                this.pending.clear();
            });

            // 发送 initialize 请求
            var initReq = this._buildRequest('initialize', {
                protocolVersion: '2024-11-05',
                capabilities: { tools: {} },
                clientInfo: { name: 'dsagent-electron', version: '5.0.5' }
            });
            this.process.stdin.write(initReq);

            var timeout = setTimeout(() => {
                reject(new Error('MCP server initialization timeout'));
            }, 15000);

            var handler = (id, result) => {
                clearTimeout(timeout);
                this.connected = true;
                console.log('[MCP:' + this.name + '] Initialized:', JSON.stringify(result).substring(0, 200));
                // 发送 initialized 通知
                this._sendRaw(this._buildNotification('notifications/initialized', {}));
                resolve();
            };

            this.pending.set(this.nextId - 1, { resolve: handler, reject: (e) => { clearTimeout(timeout); reject(e); } });
        });
    }

    // ==================== 获取工具列表 ====================
    async listTools() {
        var result = await this._sendRequest('tools/list', {});
        this.tools = result.tools || [];
        return this.tools;
    }

    // ==================== 调用工具 ====================
    async callTool(toolName, args) {
        var result = await this._sendRequest('tools/call', {
            name: toolName,
            arguments: args || {}
        });
        return result;
    }

    // ==================== 关闭 ====================
    async stop() {
        if (this.process) {
            this.process.kill();
            this.process = null;
        }
        this.connected = false;
    }

    onClose(callback) {
        this._onClose = callback;
    }

    // ==================== 内部 JSON-RPC 通信 ====================
    _sendRequest(method, params) {
        return new Promise((resolve, reject) => {
            var id = this.nextId++;
            var req = this._buildRequest(method, params, id);
            this.pending.set(id, { resolve, reject });
            this._sendRaw(req);

            // 30秒超时
            setTimeout(() => {
                if (this.pending.has(id)) {
                    this.pending.delete(id);
                    reject(new Error('MCP request timeout: ' + method));
                }
            }, 30000);
        });
    }

    _buildRequest(method, params, id) {
        var msg = { jsonrpc: '2.0', method: method, params: params };
        if (id !== undefined) msg.id = id;
        return JSON.stringify(msg) + '\n';
    }

    _buildNotification(method, params) {
        return JSON.stringify({ jsonrpc: '2.0', method: method, params: params }) + '\n';
    }

    _sendRaw(data) {
        if (this.process && this.process.stdin.writable) {
            this.process.stdin.write(data);
        }
    }

    _onData(chunk) {
        this.buffer += chunk;
        var lines = this.buffer.split('\n');
        this.buffer = lines.pop() || '';
        for (var i = 0; i < lines.length; i++) {
            var line = lines[i].trim();
            if (!line) continue;
            try {
                var msg = JSON.parse(line);
                this._handleMessage(msg);
            } catch (e) {
                console.warn('[MCP:' + this.name + '] Parse error:', line.substring(0, 100));
            }
        }
    }

    _handleMessage(msg) {
        if (msg.id !== undefined && this.pending.has(msg.id)) {
            var p = this.pending.get(msg.id);
            this.pending.delete(msg.id);
            if (msg.error) {
                p.reject(new Error(msg.error.message || 'MCP error'));
            } else {
                p.resolve(msg.result);
            }
        } else if (msg.method) {
            // 服务器发来的请求/通知（目前忽略，我们不处理服务器主动请求）
            console.log('[MCP:' + this.name + '] Server message:', msg.method);
        }
    }
}

// ==================== MCP 管理器 ====================
class McpManager {
    constructor() {
        this.clients = new Map();  // name → McpClient
        this.allTools = [];        // 所有 MCP 工具的扁平列表
    }

    // 从配置初始化所有 MCP 服务器
    async initFromConfig(mcpServers) {
        this.allTools = [];
        var results = [];
        for (var i = 0; i < mcpServers.length; i++) {
            var cfg = mcpServers[i];
            try {
                var client = new McpClient(cfg);
                await client.start();
                var tools = await client.listTools();
                this.clients.set(cfg.name, client);
                
                // 为每个工具添加服务器前缀
                tools.forEach(function(t) {
                    t._mcpServer = cfg.name;
                });
                this.allTools = this.allTools.concat(tools);
                
                console.log('[MCP] ' + cfg.name + ': ' + tools.length + ' tools loaded');
                results.push({ name: cfg.name, success: true, toolCount: tools.length });
            } catch (e) {
                console.error('[MCP] Failed to init ' + cfg.name + ':', e.message);
                results.push({ name: cfg.name, success: false, error: e.message });
            }
        }
        return results;
    }

    // 获取所有 MCP 工具
    getAllTools() {
        return this.allTools;
    }

    // 调用指定 MCP 工具
    async callTool(serverName, toolName, args) {
        var client = this.clients.get(serverName);
        if (!client) throw new Error('MCP server not found: ' + serverName);
        return await client.callTool(toolName, args);
    }

    // 根据工具名查找（带 _mcpServer 前缀）
    findTool(toolName) {
        for (var i = 0; i < this.allTools.length; i++) {
            if (this.allTools[i].name === toolName) {
                return this.allTools[i];
            }
        }
        return null;
    }

    // 生成 MCP 工具文档（用于 AI 提示词）
    generateToolsPrompt() {
        if (this.allTools.length === 0) return '';
        var prompt = '\n\n## MCP 服务器工具\n\n';
        prompt += '以下是通过 MCP 协议连接的外部工具。使用 `local-mcp` 调用。\n\n';

        // 按服务器分组
        var byServer = {};
        this.allTools.forEach(function(t) {
            var s = t._mcpServer || 'unknown';
            if (!byServer[s]) byServer[s] = [];
            byServer[s].push(t);
        });

        for (var server in byServer) {
            prompt += '### ' + server + '\n\n';
            byServer[server].forEach(function(t) {
                prompt += '- **`' + t.name + '`**';
                if (t.description) prompt += ': ' + t.description;
                prompt += '\n';
            });
            prompt += '\n';
        }
        prompt += '> 使用 `local-mcp server="服务器名" tool="工具名"` 调用，参数用 `key=value` 格式。\n';
        return prompt;
    }

    // 关闭所有 MCP 服务器
    async shutdown() {
        for (var [name, client] of this.clients) {
            try { await client.stop(); } catch (e) {}
        }
        this.clients.clear();
        this.allTools = [];
    }
}

// 单例
var manager = new McpManager();

module.exports = {
    McpClient,
    McpManager,
    manager
};