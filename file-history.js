// file-history.js — 文件快照历史（P1: Undo 支持）
// 参考 atomcode 的 file_history.rs 设计
// 每次 edit_file/write_file 前自动备份，支持 /undo 回滚
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const BASE_DIR = '.dsa';
const HISTORY_DIR = 'file-history';
const MAX_VERSIONS = 50;

// 会话级缓存：{ filePath → { versions: [{version, timestamp, backupPath}], nextVersion } }
const _sessionCache = new Map();

function getHistoryDir(sessionId) {
    var home = process.env.HOME || process.env.USERPROFILE || '.';
    return path.join(home, BASE_DIR, HISTORY_DIR, sessionId || 'default');
}

function _backupName(filePath, version) {
    var hash = crypto.createHash('sha256').update(filePath).digest('hex').substring(0, 16);
    return hash + '@v' + version;
}

function _ensureDir(dir) {
    try { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); return true; } catch(e) { return false; }
}

// 备份文件到快照目录
// 返回版本号，如果文件不存在或备份失败返回 null
function backupBeforeWrite(filePath, sessionId) {
    try {
        if (!fs.existsSync(filePath)) return null; // 新文件

        var histDir = getHistoryDir(sessionId);
        if (!_ensureDir(histDir)) return null;

        var cacheKey = filePath + '|' + (sessionId || 'default');
        if (!_sessionCache.has(cacheKey)) {
            _sessionCache.set(cacheKey, { nextVersion: 1, entries: [] });
        }
        var cache = _sessionCache.get(cacheKey);
        var version = cache.nextVersion;
        var bName = _backupName(filePath, version);
        var bPath = path.join(histDir, bName);

        fs.copyFileSync(filePath, bPath);
        cache.entries.push({ version: version, timestamp: Date.now(), backupPath: bPath });
        cache.nextVersion++;

        // 清理旧版本
        if (cache.entries.length > MAX_VERSIONS) {
            var removed = cache.entries.shift();
            try { if (removed.backupPath && fs.existsSync(removed.backupPath)) fs.unlinkSync(removed.backupPath); } catch(e) {}
        }

        return version;
    } catch(e) {
        console.warn('[FileHistory] backup failed:', filePath, e.message);
        return null;
    }
}

// 列出文件的可恢复版本
function listVersions(filePath, sessionId) {
    var cacheKey = filePath + '|' + (sessionId || 'default');
    var cache = _sessionCache.get(cacheKey);
    if (!cache) return [];
    return cache.entries.map(function(e) {
        return {
            version: e.version,
            timestamp: new Date(e.timestamp).toISOString(),
            exists: e.backupPath ? fs.existsSync(e.backupPath) : false
        };
    });
}

// 恢复到指定版本
function restoreTo(filePath, version, sessionId) {
    var cacheKey = filePath + '|' + (sessionId || 'default');
    var cache = _sessionCache.get(cacheKey);
    if (!cache) return { success: false, error: '无版本历史' };

    var entry = null;
    for (var i = 0; i < cache.entries.length; i++) {
        if (cache.entries[i].version === version) { entry = cache.entries[i]; break; }
    }
    if (!entry) return { success: false, error: '版本 ' + version + ' 不存在' };
    if (!entry.backupPath || !fs.existsSync(entry.backupPath)) return { success: false, error: '备份文件已丢失' };

    try {
        fs.copyFileSync(entry.backupPath, filePath);
        return { success: true, version: version, filePath: filePath };
    } catch(e) {
        return { success: false, error: e.message };
    }
}

// 撤销最后一次编辑（undo 最新版本）
function undoLast(filePath, sessionId) {
    var versions = listVersions(filePath, sessionId);
    if (versions.length === 0) return { success: false, error: '无版本可回滚' };
    var latest = versions[versions.length - 1];
    return restoreTo(filePath, latest.version, sessionId);
}

// 清理 session 缓存
function clearSession(sessionId) {
    var prefix = '|' + (sessionId || 'default');
    for (var key of _sessionCache.keys()) {
        if (key.endsWith(prefix)) _sessionCache.delete(key);
    }
}

module.exports = {
    backupBeforeWrite,
    listVersions,
    restoreTo,
    undoLast,
    clearSession
};
