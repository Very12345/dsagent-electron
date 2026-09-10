'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { SessionStore } = require('../../src/runtime/session-store');
const { RuntimeConfigStore } = require('../../src/runtime/config-store');
const { ToolRegistry } = require('../../src/runtime/tool-registry');
const { createToolExecutor } = require('../../src/runtime/tool-executor');
const { RunService } = require('../../src/runtime/run-service');

test('tool manifests expose risk policy and block commands until approved', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsagent-tools-'));
  try {
    const config = new RuntimeConfigStore(root).init(); const registry = new ToolRegistry({ config });
    assert.equal(registry.get('exec_command').policy, 'ask');
    const denied = createToolExecutor({ workspace: root, registry, requestApproval: async () => false });
    assert.equal((await denied.execute('exec_command', { command: 'echo no' })).code, 'approval_denied');
    const allowed = createToolExecutor({ workspace: root, registry, requestApproval: async () => true });
    const result = await allowed.execute('exec_command', { command: 'echo approved' });
    assert.equal(result.success, true); assert.match(result.data.stdout, /approved/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('agent cluster fans out with explicit child runs and aggregates role order', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsagent-cluster-'));
  try {
    const store = new SessionStore(root).init(); const config = new RuntimeConfigStore(root).init();
    config.create('clusters', { id: 'test-cluster', name: 'test', strategy: 'parallel', max_parallel: 2, roles: [{ id: 'first', name: '第一' }, { id: 'second', name: '第二' }] });
    config.patchSettings('user', null, { agents: { default_cluster_id: 'test-cluster' } });
    const providers = { cleanupSession: async () => false, complete: async (context) => ({ content: context.run.parent_run_id ? 'child:' + context.messages.at(-1).content.slice(0, 2) : 'parent done' }) };
    const runs = new RunService({ store, providers, config, toolRegistry: new ToolRegistry({ config }) });
    const session = store.create({ mode: 'project', project_id: 'fixture', model: 'mock', workspace: root });
    const run = await runs.startRun(session.id, { prompt: 'cluster', model: 'mock', tool_calls: [{ tool: 'agent_cluster', content: JSON.stringify({ cluster_id: 'test-cluster', prompt: 'do it' }) }] });
    const completed = await runs.waitForRun(run.id); assert.equal(completed.status, 'completed');
    const event = store.getEvents(session.id, 0).find((item) => item.type === 'agent_cluster.completed');
    assert.deepEqual(event.data.results.map((item) => item.role), ['first', 'second']);
    assert.ok(store.list({ includeHidden: true }).filter((item) => item.parent_run_id === run.id).length >= 2);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
