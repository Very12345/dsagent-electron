// 历史对话管理器 - 管理 .dsa/histories/ 目录
const fs = require('fs');
const path = require('path');

const HISTORIES_DIR = '.dsa';
const SUBDIR = 'histories';

function getBaseDir(rootDir) {
    if (!rootDir) return null;
    return path.join(rootDir, HISTORIES_DIR, SUBDIR);
}

function ensureDir(dir) {
    if (!dir) return false;
    try {
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        return true;
    } catch (e) {
        console.warn('[History] Failed to create directory:', e.message);
        return false;
    }
}

function listHistories(rootDir) {
    const dir = getBaseDir(rootDir);
    if (!dir || !fs.existsSync(dir)) return [];
    try {
        const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
        const histories = files.map(f => {
            try {
                const data = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8'));
                return {
                    id: data.id,
                    mode: data.mode,
                    deepthink: data.deepthink,
                    createdAt: data.createdAt,
                    updatedAt: data.updatedAt,
                    messageCount: (data.messages || []).length,
                    subSessionCount: (data.subSessions || []).length,
                    title: data.title || '(无标题)'
                };
            } catch (e) {
                return null;
            }
        }).filter(Boolean);
        // 按更新时间降序排列
        histories.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
        return histories;
    } catch (e) {
        console.warn('[History] Failed to list histories:', e.message);
        return [];
    }
}

function loadHistory(rootDir, id) {
    const dir = getBaseDir(rootDir);
    if (!dir) return null;
    try {
        const filePath = path.join(dir, id + '.json');
        if (!fs.existsSync(filePath)) return null;
        return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    } catch (e) {
        console.warn('[History] Failed to load history:', e.message);
        return null;
    }
}

function saveHistory(rootDir, historyData) {
    const dir = getBaseDir(rootDir);
    if (!dir || !ensureDir(dir)) return { success: false, error: 'No root directory' };
    try {
        const filePath = path.join(dir, historyData.id + '.json');
        fs.writeFileSync(filePath, JSON.stringify(historyData, null, 2), 'utf-8');
        return { success: true };
    } catch (e) {
        console.warn('[History] Failed to save history:', e.message);
        return { success: false, error: e.message };
    }
}

function deleteHistory(rootDir, id) {
    const dir = getBaseDir(rootDir);
    if (!dir) return { success: false, error: 'No root directory' };
    try {
        const filePath = path.join(dir, id + '.json');
        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
        }
        return { success: true };
    } catch (e) {
        return { success: false, error: e.message };
    }
}

module.exports = {
    listHistories,
    loadHistory,
    saveHistory,
    deleteHistory
};