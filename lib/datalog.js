// datalog.js — Turn 级结构化日志（P1: 参考 atomcode turn/datalog.rs）
// 每个 turn 写一份 JSONL 到 ~/.dsa/datalog/<sessionId>/<turn>.jsonl
// 记录工具调用、参数、结果、耗时、token，可回放/调试/做 eval
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

// P1: 简单 token 估算（无 tiktoken 依赖，按字符/4 估算 token 数）
// 中英文混合：中文约 1 token/1.5 字符，英文约 1 token/4 字符
// 简单统一用 1 token ≈ 3 字符
function estimateTokens(text) {
    if (!text) return 0;
    return Math.ceil((text.length || 0) / 3);
}

function getDatalogDir(sessionId) {
    var home = process.env.HOME || process.env.USERPROFILE || os.homedir();
    var dir = path.join(home, '.dsa', 'datalog', sessionId || 'default');
    try { fs.mkdirSync(dir, { recursive: true }); } catch(e) {}
    return dir;
}

// 写一条 turn 记录（追加到会话文件）
// record: { turn, modelId, conversationUrl, userText, assistantText, toolCalls, durationMs, tokens, error }
function writeTurn(sessionId, record) {
    if (!sessionId) return false;
    try {
        var dir = getDatalogDir(sessionId);
        var filePath = path.join(dir, 'turns.jsonl');
        var line = JSON.stringify(Object.assign({ ts: new Date().toISOString() }, record)) + '\n';
        // 原子追加：先写 .tmp 再 rename 不适用于追加，改用 flags:'a' + 异常兜底
        fs.appendFileSync(filePath, line, 'utf-8');
        return true;
    } catch (e) {
        console.warn('[Datalog] write failed:', e.message);
        return false;
    }
}

// 写一条工具调用记录（单独的工具事件流，便于统计工具模式）
function writeToolCall(sessionId, turn, toolRecord) {
    if (!sessionId) return false;
    try {
        var dir = getDatalogDir(sessionId);
        var filePath = path.join(dir, 'tools.jsonl');
        var line = JSON.stringify(Object.assign({ ts: new Date().toISOString(), turn: turn }, toolRecord)) + '\n';
        fs.appendFileSync(filePath, line, 'utf-8');
        return true;
    } catch (e) { return false; }
}

// 列出某会话的所有 turn 记录（供回放）
function readTurns(sessionId) {
    try {
        var dir = getDatalogDir(sessionId);
        var filePath = path.join(dir, 'turns.jsonl');
        if (!fs.existsSync(filePath)) return [];
        var lines = fs.readFileSync(filePath, 'utf-8').split('\n').filter(Boolean);
        return lines.map(function(l) { try { return JSON.parse(l); } catch(e) { return null; } }).filter(Boolean);
    } catch (e) { return []; }
}

// 清理会话 datalog
function clearSession(sessionId) {
    try {
        var dir = getDatalogDir(sessionId);
        if (fs.existsSync(dir)) {
            var files = fs.readdirSync(dir);
            files.forEach(function(f) { try { fs.unlinkSync(path.join(dir, f)); } catch(e) {} });
        }
        return true;
    } catch (e) { return false; }
}

module.exports = {
    writeTurn: writeTurn,
    writeToolCall: writeToolCall,
    readTurns: readTurns,
    clearSession: clearSession,
    getDatalogDir: getDatalogDir,
    estimateTokens: estimateTokens
};
