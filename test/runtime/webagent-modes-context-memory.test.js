'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { SessionStore } = require('../../src/runtime/session-store');
const { RunService } = require('../../src/runtime/run-service');
const { ContextManager, estimateTokens } = require('../../src/runtime/context-manager');
const { WorkMemoryService } = require('../../src/runtime/work-memory-service');
const { migrateLegacyHome, migrateRuntimeStores } = require('../../src/runtime/brand-migration');
const { ProviderManager } = require('../../src/runtime/provider-manager');

function temporary(name) { return fs.mkdtempSync(path.join(os.tmpdir(), name)); }

test('chat mode cannot execute tools even when a client requests agent mode', async () => {
  const root = temporary('webagent-chat-');
  try {
    const store = new SessionStore(root).init();
    const providers = { cleanupSession: async () => false, complete: async () => ({ content: 'Calling: `write_file`\n```json\n{"path":"owned.txt","content":"bad"}\n```' }) };
    const runs = new RunService({ store, providers });
    const session = store.create({ mode: 'chat', workspace: root, model: 'mock' });
    const started = await runs.startRun(session.id, { prompt: 'try a tool', model: 'mock', agent_mode: true, tool_calls: [{ tool: 'write_file', content: '{"path":"also.txt","content":"bad"}' }] });
    const completed = await runs.waitForRun(started.id);
    assert.equal(completed.status, 'completed');
    assert.equal(fs.existsSync(path.join(root, 'owned.txt')), false);
    assert.equal(fs.existsSync(path.join(root, 'also.txt')), false);
    assert.equal(store.getEvents(session.id, 0).some((event) => event.type === 'tool_call.started'), false);
    assert.match(store.get(session.id).messages.at(-1).content, /Calling:/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('project mode requires ownership and executes an explicitly supplied tool', async () => {
  const root = temporary('webagent-project-');
  try {
    fs.writeFileSync(path.join(root, 'fixture.txt'), 'verified', 'utf8');
    const store = new SessionStore(path.join(root, '.runtime')).init();
    const providers = { cleanupSession: async () => false, complete: async (context) => ({ content: context.messages.at(-1).role === 'tool' ? 'done' : 'unexpected' }) };
    const runs = new RunService({ store, providers });
    const session = store.create({ mode: 'project', project_id: 'p1', workspace: root, model: 'mock' });
    const started = await runs.startRun(session.id, { prompt: 'read', agent_mode: true, tool_calls: [{ tool: 'read_file', content: '{"path":"fixture.txt"}' }] });
    assert.equal((await runs.waitForRun(started.id)).status, 'completed');
    assert.ok(store.getEvents(session.id, 0).some((event) => event.type === 'tool_call.completed' && event.data.success));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('sessions with messages cannot be upgraded in place', () => {
  const root = temporary('webagent-mode-lock-');
  try {
    const store = new SessionStore(root).init();
    const session = store.create({ mode: 'chat' });
    store.appendMessage(session.id, { role: 'user', content: 'hello' });
    assert.throws(() => store.update(session.id, { mode: 'work' }), { code: 'session_mode_locked' });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('context manager estimates CJK, compacts deterministically, and survives restart', () => {
  const root = temporary('webagent-context-');
  try {
    let store = new SessionStore(root).init();
    const session = store.create({ mode: 'chat', model: 'qwen.default' });
    for (let i = 0; i < 10; i += 1) store.appendMessage(session.id, { role: i % 2 ? 'assistant' : 'user', content: '重要上下文'.repeat(100) + i });
    const manager = new ContextManager({ store, providers: {}, overrides: { qwen: { window: 1200, threshold: 0.5 } } });
    assert.ok(estimateTokens('中文上下文') > 1);
    const prepared = manager.prepare(store.get(session.id), { model: 'qwen.default', instructions: '', force: false });
    assert.equal(prepared.compacted, true);
    assert.equal(prepared.force_new_conversation, true);
    assert.match(prepared.messages[0].content, /ContextPack/);
    store = new SessionStore(root).init();
    assert.equal(store.get(session.id).context_state.generation, 1);
    assert.ok(store.get(session.id).messages.length >= 10);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('provider lineage marks retired URLs without using focus or FIFO ownership', () => {
  const manager = Object.create(ProviderManager.prototype);
  const first = manager._providerState({ conversations: [] }, { provider: 'chatgpt', url: 'https://chatgpt.com/c/one', generation: 0, last_run_id: 'r1', last_worker_id: 'w1', last_lease_id: 'l1' });
  const second = manager._providerState(first, { provider: 'chatgpt', url: 'https://chatgpt.com/c/two', generation: 1, last_run_id: 'r2', last_worker_id: 'w2', last_lease_id: 'l2' });
  assert.equal(second.conversations.find((item) => item.url.endsWith('/one')).status, 'retiring');
  assert.equal(second.conversations.find((item) => item.url.endsWith('/two')).status, 'active');
  const retired = manager.markConversationRetired(second, 'https://chatgpt.com/c/one', { deleted: false, error: 'offline' });
  assert.equal(retired.conversations.find((item) => item.url.endsWith('/one')).status, 'pending_cleanup');
});

test('work memory confines archives, redacts secrets, records every turn, and recalls facts', () => {
  const root = temporary('webagent-work-');
  try {
    const memory = new WorkMemoryService({ defaultRoot: root });
    const session = { id: 'sess_work', title: '周报', mode: 'work', workspace: root, work_archive_path: '' };
    const result = memory.record(session, '请记住默认使用中文，token=super-secret-value', '已完成。work_archive_path: "Reports/Weekly"');
    assert.ok(result.archive.startsWith(path.resolve(root)));
    assert.equal(fs.readFileSync(result.daily, 'utf8').includes('super-secret-value'), false);
    assert.ok(memory.search(root, '默认 中文', 10).length > 0);
    assert.ok(memory.resolveArchive(session, '..\\escape').startsWith(path.resolve(root, 'Inbox')));
    assert.ok(fs.existsSync(path.join(root, '.webagent', 'work-index.json')));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('brand migration copies validated legacy data once and never overwrites new data', () => {
  const home = temporary('webagent-brand-');
  try {
    fs.mkdirSync(path.join(home, '.dsa', 'skills', 'legacy'), { recursive: true });
    fs.writeFileSync(path.join(home, '.dsa', 'skills', 'legacy', 'SKILL.md'), 'legacy', 'utf8');
    const first = migrateLegacyHome({ home });
    assert.ok(first.copied.includes('skills'));
    fs.writeFileSync(path.join(home, '.webagent', 'skills', 'legacy', 'SKILL.md'), 'new', 'utf8');
    migrateLegacyHome({ home });
    assert.equal(fs.readFileSync(path.join(home, '.webagent', 'skills', 'legacy', 'SKILL.md'), 'utf8'), 'new');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('runtime migration never resurrects a session deleted after the initial import', () => {
  const root = temporary('webagent-runtime-migration-');
  try {
    const legacy = path.join(root, 'legacy-runtime');
    const target = path.join(root, 'runtime-v2');
    const session = path.join(legacy, 'sessions', 'old-session');
    fs.mkdirSync(session, { recursive: true });
    fs.writeFileSync(path.join(session, 'session.json'), '{"id":"old-session"}', 'utf8');
    migrateRuntimeStores([legacy], target);
    fs.rmSync(path.join(target, 'sessions', 'old-session'), { recursive: true, force: true });
    const second = migrateRuntimeStores([legacy], target);
    assert.equal(second.skipped, true);
    assert.equal(fs.existsSync(path.join(target, 'sessions', 'old-session')), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
