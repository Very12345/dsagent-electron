// 历史对话管理器 - 管理 .dsa/histories/ 目录
const fs = require('fs');
const path = require('path');
const os = require('os');

const HISTORIES_DIR = '.dsa';
const SUBDIR = 'histories';
const CLI_SUBDIR = 'cli-sessions';  // CLI TUI 会话专用子目录（全局，不跟项目走）

// 全局历史目录：~/.dsa/histories-all/（跨项目查看/恢复所有 session）
const GLOBAL_HISTORY_DIR = path.join(os.homedir(), HISTORIES_DIR, 'histories-all');

function getBaseDir(rootDir) {
    if (!rootDir) return null;
    return path.join(rootDir, HISTORIES_DIR, SUBDIR);
}

// CLI 会话全局目录：~/.dsa/cli-sessions/（无项目根目录时使用）
function getCliBaseDir() {
    return path.join(os.homedir(), HISTORIES_DIR, CLI_SUBDIR);
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
                    modelId: data.modelId || null,           // 新增：模型 ID
                    conversationUrl: data.conversationUrl || null,  // 新增：网页对话 URL
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

// 列出所有项目的全局历史（跨目录）
function listHistoriesAll() {
    var dir = GLOBAL_HISTORY_DIR;
    if (!dir || !fs.existsSync(dir)) return [];
    try {
        var files = fs.readdirSync(dir).filter(function(f) { return f.endsWith('.json'); });
        var histories = files.map(function(f) {
            try {
                var data = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8'));
                return {
                    id: data.id,
                    mode: data.mode,
                    modelId: data.modelId || null,
                    conversationUrl: data.conversationUrl || null,
                    createdAt: data.createdAt,
                    updatedAt: data.updatedAt,
                    messageCount: (data.messages || []).length,
                    title: data.title || '(无标题)',
                    rootDir: data.rootDir || ''
                };
            } catch (e) { return null; }
        }).filter(Boolean);
        histories.sort(function(a, b) { return (b.updatedAt || '').localeCompare(a.updatedAt || ''); });
        return histories;
    } catch (e) {
        console.warn('[History] Failed to list all histories:', e.message);
        return [];
    }
}

// 按 modelId + conversationUrl 查找历史（用于历史注入缓存命中判断）
function findByConversation(rootDir, modelId, conversationUrl) {
    if (!modelId || !conversationUrl) return null;
    const dir = getBaseDir(rootDir);
    if (!dir || !fs.existsSync(dir)) return null;
    try {
        const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
        for (const f of files) {
            try {
                const data = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8'));
                if (data.modelId === modelId && data.conversationUrl === conversationUrl) {
                    return data;
                }
            } catch (e) { /* skip */ }
        }
        return null;
    } catch (e) { return null; }
}

// 查找同模型的所有历史（用于历史注入缓存复用）
function findByModel(rootDir, modelId) {
    if (!modelId) return [];
    const dir = getBaseDir(rootDir);
    if (!dir || !fs.existsSync(dir)) return [];
    try {
        const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
        const results = [];
        for (const f of files) {
            try {
                const data = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8'));
                if (data.modelId === modelId) results.push(data);
            } catch (e) { /* skip */ }
        }
        return results;
    } catch (e) { return []; }
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
        const tmpPath = filePath + '.tmp';
        fs.writeFileSync(tmpPath, JSON.stringify(historyData, null, 2), 'utf-8');
        fs.renameSync(tmpPath, filePath);
        // 同步保存到全局目录（跨项目可见）
        if (ensureDir(GLOBAL_HISTORY_DIR)) {
            var globalData = JSON.parse(JSON.stringify(historyData));
            globalData.rootDir = rootDir || '';
            var globalPath = path.join(GLOBAL_HISTORY_DIR, historyData.id + '.json');
            var globalTmp = globalPath + '.tmp';
            fs.writeFileSync(globalTmp, JSON.stringify(globalData, null, 2), 'utf-8');
            fs.renameSync(globalTmp, globalPath);
        }
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

function renameHistory(rootDir, id, newTitle) {
    const dir = getBaseDir(rootDir);
    if (!dir) return { success: false, error: 'No root directory' };
    try {
        const filePath = path.join(dir, id + '.json');
        if (!fs.existsSync(filePath)) return { success: false, error: 'History not found' };
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        data.title = newTitle;
        data.updatedAt = new Date().toISOString();
        fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
        return { success: true };
    } catch (e) {
        return { success: false, error: e.message };
    }
}

// ===== CLI TUI 会话持久化（消除 bin/dsagent-cli.js 的 cli-session.json 独立实现） =====
// CLI 存的是 TUI 渲染状态（body 数组带 ANSI、goal、turn、status），和 agentview 的 messages 语义不同，
// 但复用 history-manager 的文件 I/O 逻辑，统一在 ~/.dsa/ 下管理。
// 存储位置：~/.dsa/cli-sessions/<sessionId>.json（单文件，每次 saveCliSession 覆盖最近一条）
const CLI_SESSION_FILE = 'last-session.json';  // 固定文件名，CLI 只保留最近一次会话

function saveCliSession(state) {
    const dir = getCliBaseDir();
    if (!ensureDir(dir)) return { success: false, error: 'Cannot create CLI session dir' };
    try {
        const filePath = path.join(dir, CLI_SESSION_FILE);
        fs.writeFileSync(filePath, JSON.stringify({
            sessionId: state.sessionId,
            hasHistory: state.hasHistory,
            modelId: state.modelId,
            deepThink: state.deepThink,
            body: state.body,
            goal: state.goal,
            turn: state.turn,
            status: { model: state.status.model, cwd: state.status.cwd },
            savedAt: new Date().toISOString()
        }, null, 2), 'utf-8');
        return { success: true };
    } catch (e) {
        console.warn('[History] Failed to save CLI session:', e.message);
        return { success: false, error: e.message };
    }
}

function loadCliSession() {
    const dir = getCliBaseDir();
    try {
        const filePath = path.join(dir, CLI_SESSION_FILE);
        if (!fs.existsSync(filePath)) return null;
        return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    } catch (e) {
        console.warn('[History] Failed to load CLI session:', e.message);
        return null;
    }
}

function deleteCliSession() {
    const dir = getCliBaseDir();
    try {
        const filePath = path.join(dir, CLI_SESSION_FILE);
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
        return { success: true };
    } catch (e) {
        return { success: false, error: e.message };
    }
}

module.exports = {
    listHistories,
    listHistoriesAll,
    loadHistory,
    saveHistory,
    deleteHistory,
    renameHistory,
    findByConversation,
    findByModel,
    saveCliSession,
    loadCliSession,
    deleteCliSession
};