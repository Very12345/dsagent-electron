// plugins/plugin-host.js
// 插件宿主：统一加载 plugins/*/manifest.json，并调用各插件的 init(ctx)。
// 每个插件自行注册自己的 IPC，宿主只负责发现与装配。
//
// ctx 提供宿主上下文（插件只读使用，不修改）：
//   {
//     ipcMain, path, fs, os, app,
//     getCurrentRootDir(),                 // 当前工作根目录
//     getAgentView(),                      // BrowserView | null
//     getDeepseekView(),                   // BrowserView | null
//     loadAppState(patch?),  saveAppState(patch),   // 应用状态持久化
//     shellSend(channel, payload),         // 向 shell 窗口发消息
//     stopAll(),                           // 停止所有运行中的 agent 任务
//     powerSaveBlocker                     // electron.powerSaveBlocker
//   }

const fs = require('fs');
const path = require('path');

const PLUGINS_DIR = path.join(__dirname);

function loadManifests() {
    const out = [];
    let entries = [];
    try { entries = fs.readdirSync(PLUGINS_DIR, { withFileTypes: true }); } catch (e) {}
    for (const ent of entries) {
        if (!ent.isDirectory()) continue;
        const mfPath = path.join(PLUGINS_DIR, ent.name, 'manifest.json');
        if (!fs.existsSync(mfPath)) continue;
        try {
            const mf = JSON.parse(fs.readFileSync(mfPath, 'utf-8'));
            mf._dir = path.join(PLUGINS_DIR, ent.name);
            out.push(mf);
        } catch (e) {
            console.error('[PluginHost] manifest 解析失败:', ent.name, e.message);
        }
    }
    return out;
}

function init(ctx) {
    const manifests = loadManifests();
    const loaded = [];
    for (const mf of manifests) {
        const idxPath = path.join(mf._dir, 'index.js');
        if (!fs.existsSync(idxPath)) {
            console.warn('[PluginHost] 跳过（无 index.js）:', mf.id);
            continue;
        }
        try {
            const plugin = require(idxPath);
            if (typeof plugin.init !== 'function') {
                console.warn('[PluginHost] 跳过（无 init 导出）:', mf.id);
                continue;
            }
            plugin.init(Object.assign({ manifest: mf }, ctx));
            loaded.push(mf);
            console.log('[PluginHost] 已加载插件:', mf.id, 'v' + mf.version);
        } catch (e) {
            console.error('[PluginHost] 插件加载失败:', mf.id, e.message);
        }
    }
    return loaded;
}

module.exports = { init, loadManifests };
