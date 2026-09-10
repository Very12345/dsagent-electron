'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { SessionStore } = require('../../src/runtime/session-store');
const { RunService } = require('../../src/runtime/run-service');

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsagent-run-'));
  const store = new SessionStore(root).init();
  const providers = {
    listModels: () => [{ id: 'mock' }], status: () => ({}), cleanupSession: async () => true,
    async complete(context) {
      await new Promise((resolve) => setTimeout(resolve, Math.floor(Math.random() * 6)));
      const latest = context.messages[context.messages.length - 1];
      const content = String(latest.content || '');
      if (latest.role === 'tool') return { content: 'aggregated:' + context.session.id };
      if (context.session.parent_session_id) return { content: 'child-result:' + content };
      if (content === 'spawn') {
        return { content: Array.from({ length: 8 }, (_, index) => JSON.stringify({ tool: 'subagent', params: { prompt: 'child-' + index, model: 'mock' } })).join('\n') };
      }
      return { content: 'reply:' + context.session.id + ':' + content };
    }
  };
  const runs = new RunService({ store, providers });
  return { root, store, runs };
}

test('50 concurrent sessions route output only to their owning session', async () => {
  const f = fixture();
  try {
    const starts = await Promise.all(Array.from({ length: 50 }, (_, index) => {
      const session = f.store.create({ title: 's' + index, workspace: f.root, model: 'mock' });
      return f.runs.startRun(session.id, { prompt: 'p' + index, model: 'mock', agent_mode: false });
    }));
    const completed = await Promise.all(starts.map((run) => f.runs.waitForRun(run.id)));
    for (const run of completed) {
      assert.equal(run.status, 'completed');
      assert.match(run.output, new RegExp('^reply:' + run.session_id + ':'));
      const assistant = f.store.get(run.session_id).messages.find((message) => message.role === 'assistant');
      assert.equal(assistant.content, run.output);
    }
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('50 mixed-provider parent tasks route 100 child runs without cross-talk', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'webagent-mixed-stress-'));
  try {
    const store = new SessionStore(root).init();
    const providers = {
      cleanupSession: async () => true,
      async complete(context) {
        await new Promise((resolve) => setTimeout(resolve, Math.floor(Math.random() * 8)));
        if (context.session.parent_session_id) return { content: `${context.model}:${context.session.id}:${context.run.parent_run_id}` };
        return { content: `parent:${context.session.id}` };
      }
    };
    const runs = new RunService({ store, providers });
    const parents = Array.from({ length: 50 }, (_, index) => store.create({ title: 'mixed-' + index, mode: 'project', project_id: 'fixture', workspace: root, model: 'deepseek.test' }));
    const started = await Promise.all(parents.map((parent) => runs.startRun(parent.id, {
      prompt: 'mixed provider routing', model: 'deepseek.test', agent_mode: true,
      tool_calls: [
        { tool: 'subagent', params: { prompt: 'deepseek child', model: 'deepseek.test' } },
        { tool: 'subagent', params: { prompt: 'chatgpt child', model: 'chatgpt.test' } }
      ]
    })));
    const completed = await Promise.all(started.map((item) => runs.waitForRun(item.id)));
    assert.ok(completed.every((item) => item.status === 'completed'));
    const children = store.list({ includeHidden: true }).filter((session) => session.parent_session_id);
    assert.equal(children.length, 100);
    for (const parent of parents) {
      const owned = children.filter((child) => child.parent_session_id === parent.id);
      assert.equal(owned.length, 2);
      assert.deepEqual(owned.map((child) => child.model).sort(), ['chatgpt.test', 'deepseek.test']);
      const feedback = store.get(parent.id).messages.find((message) => message.role === 'tool');
      assert.deepEqual(feedback.tool_results.map((result) => result.data.output.split(':')[0]), ['deepseek.test', 'chatgpt.test']);
      assert.ok(owned.every((child) => store.getEvents(child.id, 0).every((event) => event.session_id === child.id && event.parent_run_id === child.parent_run_id)));
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('subagents execute concurrently but aggregate in declaration order with explicit parent ids', async () => {
  const f = fixture();
  try {
    const parent = f.store.create({ title: 'parent', mode: 'project', project_id: 'fixture', workspace: f.root, model: 'mock' });
    const started = await f.runs.startRun(parent.id, { prompt: 'spawn', model: 'mock', agent_mode: true });
    const completed = await f.runs.waitForRun(started.id);
    assert.equal(completed.status, 'completed');
    const children = f.store.list({ includeHidden: true }).filter((session) => session.parent_session_id === parent.id);
    assert.equal(children.length, 8);
    assert.ok(children.every((session) => session.parent_run_id === started.id));
    const feedback = f.store.get(parent.id).messages.find((message) => message.role === 'tool');
    assert.deepEqual(feedback.tool_results.map((result) => result.data.output.split(':').pop()), Array.from({ length: 8 }, (_, index) => 'child-' + index));
    const childEvents = children.flatMap((child) => f.store.getEvents(child.id, 0));
    assert.ok(childEvents.every((event) => event.parent_run_id === started.id));
    const parentEvents = f.store.getEvents(parent.id, 0);
    const toolStarts = parentEvents.filter((event) => event.type === 'tool_call.started' && event.data.tool === 'subagent');
    const subagentStarts = parentEvents.filter((event) => event.type === 'subagent.started');
    assert.deepEqual(toolStarts.map((event) => event.call_id), subagentStarts.map((event) => event.call_id));
    assert.ok(parentEvents.some((event) => event.type === 'subagent.event' && event.data.child_event.type === 'run.in_progress'));
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('explicit initial tool calls deterministically start a nested subagent tool chain', async () => {
  const f = fixture();
  try {
    fs.writeFileSync(require('node:path').join(f.root, 'package.json'), '{"name":"fixture"}', 'utf8');
    const parent = f.store.create({ title: 'forced-parent', mode: 'project', project_id: 'fixture', workspace: f.root, model: 'mock' });
    const started = await f.runs.startRun(parent.id, {
      prompt: 'delegate file reading',
      model: 'mock',
      agent_mode: true,
      tool_calls: [{
        tool: 'subagent',
        params: {
          template: 'file-reader',
          prompt: 'read package.json',
          tool_calls: [{ tool: 'read_file', params: { path: 'package.json' } }]
        }
      }]
    });
    const completed = await f.runs.waitForRun(started.id);
    assert.equal(completed.status, 'completed');
    const child = f.store.list({ includeHidden: true }).find((session) => session.parent_session_id === parent.id);
    assert.ok(child);
    assert.ok(f.store.getEvents(parent.id, 0).some((event) => event.type === 'subagent.completed'));
    assert.ok(f.store.getEvents(child.id, 0).some((event) => event.type === 'tool_call.completed' && event.data.tool === 'read_file' && event.data.success));
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('one session rejects a second active writer', async () => {
  const f = fixture();
  try {
    const session = f.store.create({ workspace: f.root, model: 'mock' });
    const first = await f.runs.startRun(session.id, { prompt: 'first', model: 'mock' });
    await assert.rejects(() => f.runs.startRun(session.id, { prompt: 'second', model: 'mock' }), { code: 'session_busy' });
    await f.runs.waitForRun(first.id);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('an immediate replacement waits for an aborted run to release its session lock', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'webagent-cancel-grace-'));
  try {
    const store = new SessionStore(root).init();
    const providers = {
      cleanupSession: async () => true,
      stop: async () => false,
      async complete(context) {
        if (String(context.messages[context.messages.length - 1].content) === 'replacement') return { content: 'replacement-ok' };
        await new Promise((resolve, reject) => {
          const abort = () => setTimeout(() => reject(Object.assign(new Error('cancelled'), { name: 'AbortError', code: 'run_cancelled' })), 25);
          if (context.signal.aborted) abort();
          else context.signal.addEventListener('abort', abort, { once: true });
        });
        return { content: 'unreachable' };
      }
    };
    const runs = new RunService({ store, providers, cancelGraceMs: 1000 });
    const session = store.create({ workspace: root, model: 'mock' });
    const first = await runs.startRun(session.id, { prompt: 'long', model: 'mock' });
    await runs.cancel(first.id);
    const replacement = await runs.startRun(session.id, { prompt: 'replacement', model: 'mock' });
    const completed = await runs.waitForRun(replacement.id);
    assert.equal(completed.status, 'completed');
    assert.equal(completed.output, 'replacement-ok');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('run stays non-terminal and session stays locked until child cleanup finishes', async () => {
  const f = fixture();
  try {
    let releaseCleanup;
    const cleanupStarted = new Promise((resolve) => {
      f.runs.providers.cleanupSession = async () => {
        resolve();
        await new Promise((done) => { releaseCleanup = done; });
        return true;
      };
    });
    const parent = f.store.create({ title: 'cleanup-parent', mode: 'project', project_id: 'fixture', workspace: f.root, model: 'mock' });
    const started = await f.runs.startRun(parent.id, {
      prompt: 'delegate', model: 'mock', agent_mode: true,
      tool_calls: [{ tool: 'subagent', params: { prompt: 'cleanup-child', model: 'mock' } }]
    });
    await cleanupStarted;
    assert.equal(f.runs.getRun(started.id).status, 'finalizing');
    assert.equal(f.runs.activeRunForSession(parent.id).id, started.id);
    assert.equal(f.store.getEvents(parent.id, 0).some((event) => event.type === 'run.completed'), false);
    releaseCleanup();
    const completed = await f.runs.waitForRun(started.id);
    assert.equal(completed.status, 'completed');
    assert.equal(f.runs.activeRunForSession(parent.id), null);
    assert.equal(f.store.getEvents(parent.id, 0).filter((event) => event.type === 'run.completed').length, 1);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('chat runs receive only the non-executing visualization prompt, not the tool-oriented agent prompt', async () => {
  const f = fixture();
  try {
    let instructions = null;
    f.runs.providers.complete = async (context) => { instructions = context.instructions; return { content: 'plain reply' }; };
    const session = f.store.create({ workspace: f.root, model: 'mock' });
    const started = await f.runs.startRun(session.id, { prompt: 'plain request', model: 'mock', agent_mode: false });
    await f.runs.waitForRun(started.id);
    assert.match(instructions, /Runtime tools, Skills, files, memory writes, subagents, and clusters are unavailable/);
    assert.match(instructions, /wa-plot/);
    assert.doesNotMatch(instructions, /You are an agentic coding assistant/);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('provider progress is forwarded as non-duplicated incremental events', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsagent-stream-'));
  try {
    const store = new SessionStore(root).init();
    const providers = {
      cleanupSession: async () => true,
      async complete(context) {
        context.onStatus('正在生成测试回复…');
        context.onProgress('hello');
        await new Promise((resolve) => setTimeout(resolve, 8));
        context.onProgress('hello world');
        return { content: 'hello world' };
      }
    };
    const runs = new RunService({ store, providers });
    const session = store.create({ workspace: root, model: 'mock' });
    const started = await runs.startRun(session.id, { prompt: 'stream', model: 'mock', agent_mode: false });
    const completed = await runs.waitForRun(started.id);
    assert.equal(completed.status, 'completed');
    const events = store.getEvents(session.id, 0);
    const deltas = events.filter((event) => event.type === 'response.output_text.delta').map((event) => event.data.delta);
    assert.deepEqual(deltas, ['hello', ' world']);
    assert.equal(events.find((event) => event.type === 'response.output_text.done').data.text, 'hello world');
    assert.ok(events.some((event) => event.type === 'response.status' && event.data.text === '正在生成测试回复…'));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('identical subagent calls in later rounds reuse the confirmed result', async () => {
  const f = fixture();
  try {
    let parentRounds = 0;
    f.runs.providers.complete = async (context) => {
      const latest = context.messages[context.messages.length - 1];
      if (context.session.parent_session_id) return { content: 'child-confirmed' };
      if (latest.role === 'tool' && ++parentRounds >= 2) return { content: 'final' };
      return { content: JSON.stringify({ tool: 'subagent', params: { prompt: 'same-child', model: 'mock' } }) };
    };
    const parent = f.store.create({ mode: 'project', project_id: 'fixture', workspace: f.root, model: 'mock' });
    const started = await f.runs.startRun(parent.id, { prompt: 'repeat', model: 'mock', agent_mode: true });
    const completed = await f.runs.waitForRun(started.id);
    assert.equal(completed.status, 'completed');
    const children = f.store.list({ includeHidden: true }).filter((session) => session.parent_session_id === parent.id);
    assert.equal(children.length, 1);
    assert.ok(f.store.getEvents(parent.id, 0).some((event) => event.type === 'tool_call.reused'));
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});
