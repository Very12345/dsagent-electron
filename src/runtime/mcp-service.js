'use strict';

// MCP 服务：驱动 server-mcp 的单例 mcpManager。
// MCP 服务器配置有两个来源，按名称去重后合并：
//   1. 已安装插件的清单（plugin-loader.getAllPluginMcpServers，纯读取）
//   2. Runtime 配置里的 settings.mcp.servers（用户显式声明）
// 旧实现散落在 server.js 的 initMcp/shutdownMcp，读取的是已被移除的
// <repo>/.dsa/config.json，导致新架构下 MCP 从未真正初始化。

const pluginManager = require('../../plugin-manager');
const { manager: mcpManager } = require('../../server-mcp');

function normalizeServers(input) {
  const seen = new Set();
  const servers = [];
  for (const entry of Array.isArray(input) ? input : []) {
    if (!entry || !entry.name || seen.has(entry.name)) continue;
    seen.add(entry.name);
    servers.push(entry);
  }
  return servers;
}

class McpService {
  constructor(options) {
    options = options || {};
    this.config = options.config || null;
    this.initialized = false;
    this.lastServers = [];
  }

  configuredServers() {
    const collected = [];
    try {
      const fromPlugins = pluginManager.getAllPluginMcpServers();
      if (Array.isArray(fromPlugins)) collected.push(...fromPlugins);
    } catch (error) {
      console.warn('[MCP] plugin manifest scan failed:', error.message);
    }
    try {
      const settings = this.config ? this.config.getSettings() : null;
      const configured = settings && settings.mcp && settings.mcp.servers;
      if (Array.isArray(configured)) collected.push(...configured);
    } catch (error) {
      console.warn('[MCP] runtime config read failed:', error.message);
    }
    return normalizeServers(collected);
  }

  savedToolStates() {
    try {
      const settings = this.config ? this.config.getSettings() : null;
      const states = settings && settings.mcp && settings.mcp.tool_states;
      return states && typeof states === 'object' ? states : null;
    } catch (_) {
      return null;
    }
  }

  async init(force) {
    if (this.initialized && !force) {
      return { success: true, message: 'Already initialized', tools: this.listTools() };
    }
    try {
      if (force && this.initialized) {
        await mcpManager.shutdown();
        this.initialized = false;
      }
      const servers = this.configuredServers();
      this.lastServers = servers.map((item) => item.name);
      if (!servers.length) return { success: true, message: 'No MCP servers configured', tools: [] };
      const results = await mcpManager.initFromConfig(servers);
      this.initialized = true;
      const states = this.savedToolStates();
      if (states) mcpManager.setToolStates(states);
      return { success: true, results, tools: this.listTools() };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  async shutdown() {
    try { await mcpManager.shutdown(); } catch (_) {}
    this.initialized = false;
  }

  listTools() { return mcpManager.getAllTools(); }
  listResources() { return mcpManager.getAllResources(); }
  listPrompts() { return mcpManager.getAllPrompts(); }

  status() {
    return {
      initialized: this.initialized,
      servers: this.initialized ? this.lastServers : this.configuredServers().map((item) => item.name),
      tools: this.listTools().length
    };
  }
}

module.exports = { McpService, normalizeServers };
