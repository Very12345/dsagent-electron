// plugin-loader.js — CC 插件加载器
// 从已安装插件目录加载 hooks.json + MCP 配置，注入到现有系统
'use strict';

const fs = require('fs');
const path = require('path');
const pluginInstaller = require('./plugin-installer.js');

// 加载单个插件的配置
function loadPluginConfig(pluginName) {
    var pluginDir = pluginInstaller.getPluginDir(pluginName);
    if (!pluginDir) return null;

    var config = { name: pluginName, dir: pluginDir, hooks: [], mcpServers: [] };

    // 1. 加载 hooks.json（CC 标准格式）
    var hooksPaths = ['hooks.json', '.atomcode/hooks.json', '.claude/hooks.json'];
    for (var i = 0; i < hooksPaths.length; i++) {
        var hp = path.join(pluginDir, hooksPaths[i]);
        if (fs.existsSync(hp)) {
            try {
                var raw = JSON.parse(fs.readFileSync(hp, 'utf-8'));
                config.hooks = (raw.hooks || raw || []).filter(function(h) { return h && h.event; });
                if (config.hooks.length > 0) break;
            } catch(e) {
                console.warn('[PluginLoader] Failed to parse hooks.json in', pluginName, e.message);
            }
        }
    }

    // 2. 查找 MCP 配置
    var mcpPaths = ['mcp.json', 'mcp-config.json', '.atomcode/mcp.json', 'config.json'];
    for (var j = 0; j < mcpPaths.length; j++) {
        var mp = path.join(pluginDir, mcpPaths[j]);
        if (fs.existsSync(mp)) {
            try {
                var mcpRaw = JSON.parse(fs.readFileSync(mp, 'utf-8'));
                var servers = mcpRaw.mcpServers || mcpRaw.servers || (Array.isArray(mcpRaw) ? mcpRaw : []);
                if (Array.isArray(servers)) {
                    config.mcpServers = servers;
                    break;
                }
            } catch(e) {
                console.warn('[PluginLoader] Failed to parse MCP config in', pluginName, e.message);
            }
        }
    }

    // 3. 查找插件主入口（package.json 的 main 字段）
    var pkgPath = path.join(pluginDir, 'package.json');
    if (fs.existsSync(pkgPath)) {
        try {
            var pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
            config.packageName = pkg.name;
            config.description = pkg.description || '';
            config.version = pkg.version || '0.0.0';
            if (pkg.main) config.main = path.join(pluginDir, pkg.main);
            if (pkg.mcpServers) config.mcpServers = config.mcpServers.concat(pkg.mcpServers);
        } catch(e) {}
    }

    return config;
}

// 加载所有已安装插件
function loadAllPlugins() {
    var names = pluginInstaller.listInstalled();
    var configs = [];
    names.forEach(function(n) {
        var cfg = loadPluginConfig(n);
        if (cfg) configs.push(cfg);
    });
    return configs;
}

// 获取所有插件的 hooks（合并配置式 hooks）
function getAllPluginHooks() {
    var plugins = loadAllPlugins();
    var allHooks = [];
    plugins.forEach(function(p) {
        if (p.hooks && p.hooks.length > 0) {
            p.hooks.forEach(function(h) {
                h._plugin = p.name;
                allHooks.push(h);
            });
        }
    });
    return allHooks;
}

// 获取所有插件的 MCP 服务器配置
function getAllPluginMcpServers() {
    var plugins = loadAllPlugins();
    var allServers = [];
    var seen = {};
    plugins.forEach(function(p) {
        if (p.mcpServers && p.mcpServers.length > 0) {
            p.mcpServers.forEach(function(s) {
                if (s.name && !seen[s.name]) {
                    seen[s.name] = true;
                    allServers.push(s);
                }
            });
        }
    });
    return allServers;
}

// 初始化插件（加载 hooks + MCP 配置到全局状态）
function initPlugins(hookEngine) {
    var plugins = loadAllPlugins();
    var hooks = [];
    var mcpServers = [];

    plugins.forEach(function(p) {
        console.log('[PluginLoader] Loaded:', p.name + (p.version ? ' v' + p.version : ''));
        if (p.hooks) hooks = hooks.concat(p.hooks);
        if (p.mcpServers) mcpServers = mcpServers.concat(p.mcpServers);
    });

    // 注册 hooks 到 HookEngine
    if (hookEngine && hooks.length > 0) {
        try {
            hookEngine.loadConfigHooksFromPlugins(hooks);
        } catch(e) {
            console.warn('[PluginLoader] Failed to register hooks:', e.message);
        }
    }

    return { plugins: plugins, hooks: hooks, mcpServers: mcpServers };
}

module.exports = {
    loadPluginConfig,
    loadAllPlugins,
    getAllPluginHooks,
    getAllPluginMcpServers,
    initPlugins
};
