// test/datalog.test.js — P1: Turn Datalog 单元测试
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const datalog = require('../lib/datalog.js');

const TEST_SESSION = 'test-session-' + Date.now();

test('writeTurn 写入并读取', () => {
    const ok = datalog.writeTurn(TEST_SESSION, {
        turn: 1,
        modelId: 'deepseek',
        userText: 'hello',
        assistantText: 'hi',
        durationMs: 100
    });
    assert.strictEqual(ok, true);
    const turns = datalog.readTurns(TEST_SESSION);
    assert.strictEqual(turns.length, 1);
    assert.strictEqual(turns[0].turn, 1);
    assert.strictEqual(turns[0].modelId, 'deepseek');
    assert.ok(turns[0].ts);
});

test('writeToolCall 写入工具事件', () => {
    const ok = datalog.writeToolCall(TEST_SESSION, 1, {
        tool: 'read',
        params: { path: 'a.js' },
        success: true,
        durationMs: 50
    });
    assert.strictEqual(ok, true);
    const dir = datalog.getDatalogDir(TEST_SESSION);
    const toolsPath = path.join(dir, 'tools.jsonl');
    assert.ok(fs.existsSync(toolsPath));
    const lines = fs.readFileSync(toolsPath, 'utf-8').trim().split('\n');
    assert.strictEqual(lines.length, 1);
    const rec = JSON.parse(lines[0]);
    assert.strictEqual(rec.tool, 'read');
    assert.strictEqual(rec.turn, 1);
});

test('多 turn 追加不覆盖', () => {
    datalog.writeTurn(TEST_SESSION, { turn: 2, modelId: 'deepseek' });
    datalog.writeTurn(TEST_SESSION, { turn: 3, modelId: 'deepseek' });
    const turns = datalog.readTurns(TEST_SESSION);
    assert.strictEqual(turns.length, 3);
    assert.strictEqual(turns[0].turn, 1);
    assert.strictEqual(turns[2].turn, 3);
});

test('readTurns 不存在的会话返回空数组', () => {
    const turns = datalog.readTurns('nonexistent-session-xyz');
    assert.deepStrictEqual(turns, []);
});

test('clearSession 清理会话文件', () => {
    const ok = datalog.clearSession(TEST_SESSION);
    assert.strictEqual(ok, true);
    const dir = datalog.getDatalogDir(TEST_SESSION);
    const files = fs.readdirSync(dir);
    assert.strictEqual(files.length, 0);
});

test('writeTurn 无 sessionId 静默失败', () => {
    assert.strictEqual(datalog.writeTurn(null, { turn: 1 }), false);
    assert.strictEqual(datalog.writeTurn('', { turn: 1 }), false);
});
