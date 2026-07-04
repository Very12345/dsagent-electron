// plugin-manifest.js — CC 插件市场清单解析
// 兼容 Claude Code 的 .atomcode-plugin/marketplace.json / .claude-plugin/marketplace.json
'use strict';

const fs = require('fs');
const path = require('path');

// 解析 PluginSource（CC 格式兼容）
// 三种形式：Inline 字符串 / External 对象 / Unknown
function parseSource(src) {
    if (!src) return { type: 'inline', path: './' };
    if (typeof src === 'string') return { type: 'inline', path: src };
    if (typeof src === 'object') {
        switch (src.source) {
            case 'url': case 'git':
                return { type: 'git', url: src.url, ref: src.ref || src.branch || null };
            case 'github':
                return { type: 'github', repo: src.repo, ref: src.ref || src.branch || null };
            case 'git-subdir':
                return { type: 'git-subdir', url: src.url, path: src.path, ref: src.ref || null };
            case 'local':
                return { type: 'local', path: src.path || src.url || '' };
            case 'npm':
                return { type: 'npm', pkg: src.pkg || src.url || '' };
            default:
                return { type: 'unknown', raw: src };
        }
    }
    return { type: 'inline', path: './' };
}

// 加载单个 marketplace.json
function loadMarketplace(mpDir) {
    var candidates = ['marketplace.json', '.atomcode-plugin/marketplace.json', '.claude-plugin/marketplace.json'];
    for (var i = 0; i < candidates.length; i++) {
        var fp = path.join(mpDir, candidates[i]);
        if (fs.existsSync(fp)) {
            try {
                var raw = JSON.parse(fs.readFileSync(fp, 'utf-8'));
                var plugins = (raw.plugins || []).map(function(p) {
                    return {
                        name: p.name,
                        description: p.description || '',
                        source: parseSource(p.source),
                        _marketplace: mpDir
                    };
                });
                return { name: raw.name || path.basename(mpDir), plugins: plugins, dir: mpDir };
            } catch(e) {
                console.warn('[PluginManifest] Failed to parse', fp, e.message);
            }
        }
    }
    return null;
}

// 从 plugins 目录加载所有 marketplace
function loadAllMarketplaces(pluginsRoot) {
    var results = [];
    // 先检查根目录下是否有 marketplace.json
    var rootMp = loadMarketplace(pluginsRoot);
    if (rootMp) results.push(rootMp);

    // 检查 marketplaces/ 子目录
    var mpDir = path.join(pluginsRoot, 'marketplaces');
    if (fs.existsSync(mpDir)) {
        try {
            var dirs = fs.readdirSync(mpDir);
            dirs.forEach(function(d) {
                var full = path.join(mpDir, d);
                if (fs.statSync(full).isDirectory()) {
                    var mp = loadMarketplace(full);
                    if (mp) results.push(mp);
                }
            });
        } catch(e) {}
    }
    return results;
}

// 列出所有可安装的插件
function listAvailablePlugins(pluginsRoot) {
    var marketplaces = loadAllMarketplaces(pluginsRoot);
    var all = [];
    marketplaces.forEach(function(mp) {
        mp.plugins.forEach(function(p) {
            all.push({
                name: p.name,
                description: p.description,
                source: p.source,
                marketplace: mp.name,
                marketplaceDir: mp.dir
            });
        });
    });
    return all;
}

module.exports = {
    parseSource,
    loadMarketplace,
    loadAllMarketplaces,
    listAvailablePlugins
};
