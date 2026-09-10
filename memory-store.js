// memory-store.js — 持久化记忆系统（P2）
// 参考 atomcode 的 MemoryStore 设计，global + project 两级
// AI 可通过 tools 读写：__dsagent_memory_read / __dsagent_memory_append
'use strict';

const fs = require('fs');
const path = require('path');
const { BRAND_DIR, LEGACY_BRAND_DIR, brandHome, legacyBrandHome } = require('./lib/paths.js');

const MEMORY_FILE = 'memory.json';

function getGlobalDir() {
    return brandHome();
}

function getLegacyGlobalDir() {
    return legacyBrandHome();
}

function getProjectDir(rootDir) {
    return rootDir ? path.join(rootDir, BRAND_DIR) : null;
}

function getLegacyProjectDir(rootDir) {
    return rootDir ? path.join(rootDir, LEGACY_BRAND_DIR) : null;
}

function ensureDir(dir) {
    try {
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        return true;
    } catch(e) { return false; }
}

// 读取：优先新品牌目录，回退旧 .dsa 目录，保证老数据仍可见
function loadMemory(dir, legacyDir) {
    for (const target of [dir, legacyDir]) {
        if (!target) continue;
        var fp = path.join(target, MEMORY_FILE);
        try {
            if (fs.existsSync(fp)) return JSON.parse(fs.readFileSync(fp, 'utf-8'));
        } catch(e) {}
    }
    return { entries: [] };
}

function saveMemory(dir, data) {
    if (!dir || !ensureDir(dir)) return false;
    try {
        fs.writeFileSync(path.join(dir, MEMORY_FILE), JSON.stringify(data, null, 2), 'utf-8');
        return true;
    } catch(e) { return false; }
}

// ===== 公开 API =====

function global() {
    return loadMemory(getGlobalDir(), getLegacyGlobalDir());
}

function project(rootDir) {
    return loadMemory(getProjectDir(rootDir), getLegacyProjectDir(rootDir));
}

function saveGlobal(data) {
    return saveMemory(getGlobalDir(), data);
}

function saveProject(rootDir, data) {
    return saveMemory(getProjectDir(rootDir), data);
}

// 向指定记忆库添加一条记忆
function addEntry(rootDir, scope, content) {
    // scope: 'global' | 'project'
    var data = scope === 'global' ? global() : project(rootDir);
    if (!data.entries) data.entries = [];
    data.entries.push({
        content: content,
        timestamp: new Date().toISOString()
    });
    // 最多保留 50 条
    if (data.entries.length > 50) data.entries = data.entries.slice(-50);
    return scope === 'global' ? saveGlobal(data) : saveProject(rootDir, data);
}

// 清除记忆
function clearMemory(rootDir, scope) {
    var data = { entries: [] };
    return scope === 'global' ? saveGlobal(data) : saveProject(rootDir, data);
}

// 合并两级记忆为 prompt 文本
function mergedForPrompt(globalMem, projectMem, projectName) {
    var parts = [];
    if (globalMem && globalMem.entries && globalMem.entries.length > 0) {
        parts.push('【全局记忆】');
        globalMem.entries.forEach(function(e) {
            parts.push('- ' + e.content + ' (记录于 ' + (e.timestamp || '').substring(0, 10) + ')');
        });
    }
    if (projectMem && projectMem.entries && projectMem.entries.length > 0) {
        parts.push('【项目记忆: ' + (projectName || '当前项目') + '】');
        projectMem.entries.forEach(function(e) {
            parts.push('- ' + e.content + ' (记录于 ' + (e.timestamp || '').substring(0, 10) + ')');
        });
    }
    return parts.length > 0 ? parts.join('\n') : '';
}

// 供 Runtime 的 capability-service / tool-executor 调用
function handleMemoryRead(rootDir) {
    var g = global();
    var p = project(rootDir);
    return {
        success: true,
        global: g.entries || [],
        project: p.entries || [],
        prompt: mergedForPrompt(g, p, rootDir ? path.basename(rootDir) : null)
    };
}

function handleMemoryAppend(rootDir, scope, content) {
    if (!content || !content.trim()) return { success: false, error: '内容不能为空' };
    return { success: addEntry(rootDir, scope || 'project', content.trim()) };
}

function handleMemoryClear(rootDir, scope) {
    return { success: clearMemory(rootDir, scope || 'project') };
}

module.exports = {
    global,
    project,
    addEntry,
    clearMemory,
    mergedForPrompt,
    handleMemoryRead,
    handleMemoryAppend,
    handleMemoryClear
};
