// test/json-repair.test.js — P0: JSON 修复链单元测试
// 用 Node 18 内置 node:test，无需新依赖
// 验证 lib/json-repair.js 的 5 层修复链覆盖 atomcode json_repair.rs 对齐的关键场景
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const repair = require('../lib/json-repair.js');

test('第1层: 合法 JSON 直接通过', () => {
    const r = repair.parseLine('{"tool":"read","params":{"path":"a.js"}}');
    assert.strictEqual(r.tool, 'read');
    assert.strictEqual(r.params.path, 'a.js');
});

test('第2层: trailing comma 修复', () => {
    const r = repair.parseLine('{"tool":"edit","params":{"path":"a.js",},}');
    assert.ok(r);
    assert.strictEqual(r.params.path, 'a.js');
});

test('第2层: unquoted key 修复', () => {
    const r = repair.parseLine('{tool:"edit",params:{path:"a.js"}}');
    assert.ok(r);
    assert.strictEqual(r.tool, 'edit');
});

test('第2层: 单引号转双引号', () => {
    const r = repair.parseLine("{'tool':'edit','params':{'path':'a.js'}}");
    assert.ok(r);
    assert.strictEqual(r.tool, 'edit');
    assert.strictEqual(r.params.path, 'a.js');
});

test('第2层: markdown fence 剥离', () => {
    const r = repair.parseLine('```json\n{"tool":"read","params":{"path":"a.js"}}\n```');
    assert.ok(r);
    assert.strictEqual(r.tool, 'read');
});

test('第0层: Windows 路径预逃逸（D:\\test\\foo.py 不被解码为 D:<TAB>est...）', () => {
    // 原始字符串含 \t \f 等，JSON.parse 会错误解码
    const input = '{"params":{"path":"D:\\test\\foo.py"}}';
    const repaired = repair.repairToolArgs('read', input);
    const parsed = JSON.parse(repaired);
    assert.strictEqual(parsed.params.path, 'D:\\test\\foo.py');
});

test('第3层: edit_file 专属修复（key=value 提取）', () => {
    // 完全非 JSON 的 key=value 形式
    const input = 'file=a.js old_string="x" new_string="y"';
    const repaired = repair.repairToolArgs('edit', input);
    const parsed = JSON.parse(repaired);
    assert.strictEqual(parsed.file, 'a.js');
    assert.strictEqual(parsed.old_string, 'x');
    assert.strictEqual(parsed.new_string, 'y');
});

test('第4层: 兜底 KV 提取（非 edit 工具）', () => {
    const repaired = repair.repairToolArgs('read', 'path="a.js" force=true');
    // 兜底提取后组装为 JSON
    const parsed = JSON.parse(repaired);
    assert.strictEqual(parsed.path, 'a.js');
    assert.strictEqual(parsed.force, 'true');
});

test('parseLine 全部失败返回 __parse_failed 标记（不静默吞）', () => {
    const r = repair.parseLine('this is not json at all && no kv pairs');
    assert.ok(r);
    assert.strictEqual(r.__parse_failed, true);
    assert.ok(r.raw);
});

test('parseLine 空行/null 返回 null', () => {
    assert.strictEqual(repair.parseLine(''), null);
    assert.strictEqual(repair.parseLine(null), null);
    assert.strictEqual(repair.parseLine('   '), null);
});

test('repairToolArgs 空输入返回原值', () => {
    assert.strictEqual(repair.repairToolArgs('edit', ''), '');
    assert.strictEqual(repair.repairToolArgs('edit', null), null);
});
