// plugin-manager.js — CC 插件管理器
// 管理 installed_plugins.json + 统一 API 供 IPC 层调用
'use strict';

const fs = require('fs');
const path = require('path');
const manifest = require('./plugin-manifest.js');
const installer = require('./plugin-installer.js');
const loader = require('./plugin-loader.js');
const { brandHome } = require('./lib/paths.js');

// 默认官方市场（Claude Code 兼容插件）
const DEFAULT_MARKETPLACE = {
    name: 'cc-official',
    source: { type: 'github', repo: 'anthropics/claude-plugins-official' }
};

// 插件数据目录：统一在 ~/.webagent/plugins
function getPluginsRoot() {
    return path.join(brandHome(), 'plugins');
}

const STATE_FILE = 'installed_plugins.json';

function getStatePath() {
    return path.join(brandHome(), STATE_FILE);
}

// 加载已安装插件状态
function loadState() {
    var fp = getStatePath();
    try {
        if (fs.existsSync(fp)) return JSON.parse(fs.readFileSync(fp, 'utf-8'));
    } catch(e) {}
    return { plugins: {} };
}

// 保存已安装插件状态
function saveState(state) {
    var fp = getStatePath();
    try {
        var dir = path.dirname(fp);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(fp, JSON.stringify(state, null, 2), 'utf-8');
        return true;
    } catch(e) { return false; }
}

// 注册插件到状态
function registerPlugin(name, info) {
    var state = loadState();
    state.plugins[name] = {
        name: name,
        version: info.version || '0.0.0',
        description: info.description || '',
        installedAt: new Date().toISOString(),
        dir: info.dir || '',
        source: info.source || null,
        marketplace: info.marketplace || ''
    };
    return saveState(state);
}

// 注销插件
function unregisterPlugin(name) {
    var state = loadState();
    delete state.plugins[name];
    return saveState(state);
}

// 获取已注册插件列表
function listRegistered() {
    var state = loadState();
    return Object.keys(state.plugins).map(function(k) {
        return state.plugins[k];
    });
}

// 安装插件（从 marketplace 或直接来源）
async function installPlugin(params) {
    // params: { name, source: {type, url, ...} }
    var result = await installer.install(params);
    if (!result.success) return result;

    // 注册到状态
    var info = {
        version: '0.0.0',
        description: params.description || '',
        dir: result.dir,
        source: params.source,
        marketplace: params.marketplace || ''
    };
    try {
        var pkgPath = path.join(result.dir, 'package.json');
        if (fs.existsSync(pkgPath)) {
            var pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
            info.version = pkg.version || '0.0.0';
            info.description = pkg.description || '';
        }
    } catch(e) {}
    registerPlugin(result.name, info);

    // 加载插件配置
    var config = loader.loadPluginConfig(result.name);
    return { success: true, name: result.name, dir: result.dir, config: config };
}

// 卸载插件
function uninstallPlugin(name) {
    var result = installer.uninstall(name);
    if (result.success) unregisterPlugin(name);
    return result;
}

// 获取完整插件信息（已安装 + 市场可用）
function getAllPluginInfo() {
    var installed = listRegistered();
    var installedNames = {};
    installed.forEach(function(p) { installedNames[p.name] = p; });

    // 从市场列出可用但未安装的
    var pluginsRoot = getPluginsRoot();
    var available = manifest.listAvailablePlugins(pluginsRoot);

    // 合并
    var all = [];
    var seen = {};
    installed.forEach(function(p) {
        seen[p.name] = true;
        all.push({ name: p.name, installed: true, version: p.version, description: p.description, installedAt: p.installedAt });
    });
    available.forEach(function(p) {
        if (!seen[p.name]) {
            all.push({ name: p.name, installed: false, description: p.description, source: p.source, marketplace: p.marketplace });
        }
    });
    return all;
}

// 刷新插件（重载所有已安装的 hooks 和 MCP 配置）
function refreshPlugins(hookEngine) {
    var result = loader.initPlugins(hookEngine);
    return result;
}

// 只读取插件的 MCP 服务器清单（不注册 hooks，无副作用）
function getAllPluginMcpServers() {
    try {
        return loader.getAllPluginMcpServers();
    } catch(e) {
        console.warn('[Plugin] MCP manifest scan failed:', e.message);
        return [];
    }
}

// 添加市场（git clone 到 marketplaces/ 目录）
function addMarketplace(params) {
    // params: { name, source: {type, url, repo, ...} }
    var pluginsRoot = getPluginsRoot();
    var mpDir = path.join(pluginsRoot, 'marketplaces', params.name || 'market-' + Date.now());

    // 如果已存在，先删除
    if (fs.existsSync(mpDir)) {
        try { fs.rmSync(mpDir, { recursive: true, force: true }); } catch(e) {}
    }

    try {
        var source = params.source;
        if (source.type === 'git' || source.type === 'url') {
            var { execSync } = require('child_process');
            console.log('[Marketplace] Cloning', source.url, 'to', mpDir);
            execSync('git clone ' + JSON.stringify(source.url) + ' ' + JSON.stringify(mpDir), {
                timeout: 120000, windowsHide: true, stdio: 'pipe'
            });
        } else if (source.type === 'github') {
            var { execSync } = require('child_process');
            var gitUrl = 'https://github.com/' + source.repo + '.git';
            console.log('[Marketplace] Cloning github', gitUrl, 'to', mpDir);
            execSync('git clone ' + JSON.stringify(gitUrl) + ' ' + JSON.stringify(mpDir), {
                timeout: 120000, windowsHide: true, stdio: 'pipe'
            });
        } else if (source.type === 'local') {
            var fs2 = require('fs');
            if (!fs2.existsSync(source.path)) return { success: false, error: '路径不存在: ' + source.path };
            copyRecursive(source.path, mpDir);
        } else {
            return { success: false, error: '不支持的市场来源类型: ' + source.type };
        }

        // 验证是否包含 marketplace.json
        var found = false;
        var candidates = ['marketplace.json', '.atomcode-plugin/marketplace.json', '.claude-plugin/marketplace.json'];
        candidates.forEach(function(c) {
            if (fs.existsSync(path.join(mpDir, c))) found = true;
        });
        if (!found) {
            // 清理无效市场
            try { fs.rmSync(mpDir, { recursive: true, force: true }); } catch(e) {}
            return { success: false, error: '该仓库不包含有效的 marketplace.json' };
        }

        return { success: true, name: params.name || path.basename(mpDir), dir: mpDir };
    } catch (e) {
        try { fs.rmSync(mpDir, { recursive: true, force: true }); } catch(ign) {}
        return { success: false, error: e.message || '添加市场失败' };
    }
}

// 列出已添加的市场
function listMarketplaces() {
    var pluginsRoot = getPluginsRoot();
    var mpDir = path.join(pluginsRoot, 'marketplaces');
    if (!fs.existsSync(mpDir)) return [];

    var result = [];
    try {
        var dirs = fs.readdirSync(mpDir);
        dirs.forEach(function(d) {
            var full = path.join(mpDir, d);
            if (fs.statSync(full).isDirectory()) {
                var mpManifest = manifest.loadMarketplace(full);
                result.push({
                    name: d,
                    dir: full,
                    displayName: mpManifest ? mpManifest.name : d,
                    pluginCount: mpManifest ? (mpManifest.plugins || []).length : 0
                });
            }
        });
    } catch(e) {}
    return result;
}

function copyRecursive(src, dest) {
    try {
        if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
        var items = fs.readdirSync(src);
        items.forEach(function(item) {
            var s = path.join(src, item);
            var d = path.join(dest, item);
            if (fs.statSync(s).isDirectory()) {
                copyRecursive(s, d);
            } else {
                fs.copyFileSync(s, d);
            }
        });
    } catch(e) {}
}

// 确保默认市场已安装（启动时调用）
function ensureDefaultMarketplace() {
    var pluginsRoot = getPluginsRoot();
    var mpDir = path.join(pluginsRoot, 'marketplaces', DEFAULT_MARKETPLACE.name);
    if (fs.existsSync(mpDir)) return { success: true, existed: true };
    // 检查 git 是否可用
    try {
        var installer = require('./plugin-installer.js');
        if (!installer.isGitAvailable()) {
            console.warn('[Marketplace] git not found, skipping default marketplace');
            return { success: false, error: 'git not available' };
        }
    } catch(e) {
        return { success: false, error: e.message };
    }
    console.log('[Marketplace] Installing default:', DEFAULT_MARKETPLACE.source.repo);
    return addMarketplace({ name: DEFAULT_MARKETPLACE.name, source: DEFAULT_MARKETPLACE.source });
}

module.exports = {
    installPlugin,
    uninstallPlugin,
    listRegistered,
    getAllPluginInfo,
    getAllPluginMcpServers,
    refreshPlugins,
    addMarketplace,
    listMarketplaces,
    ensureDefaultMarketplace
};
