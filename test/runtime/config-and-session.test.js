'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { SessionStore } = require('../../src/runtime/session-store');
const { RuntimeConfigStore } = require('../../src/runtime/config-store');

test('project records, scoped settings and default clusters persist atomically', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsagent-config-'));
  try {
    const config = new RuntimeConfigStore(root).init();
    const project = config.create('projects', { name: 'demo', workspace: root });
    config.patchSettings('project', project.id, { tools: { command: 'allow' } });
    assert.equal(config.getSettings(project.id).tools.command, 'allow');
    assert.ok(config.list('clusters').some((item) => item.id === 'code-delivery'));
    const restored = new RuntimeConfigStore(root).init();
    assert.equal(restored.get('projects', project.id).workspace, root);
    assert.equal(restored.getSettings(project.id).tools.command, 'allow');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('manual titles are locked while automatic titles follow verified remote metadata', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsagent-title-'));
  try {
    const store = new SessionStore(root).init();
    const session = store.create({ title: '新会话' });
    store.syncRemoteTitle(session.id, '远端标题一');
    assert.equal(store.get(session.id).title, '远端标题一');
    store.update(session.id, { title: '我的标题' });
    store.syncRemoteTitle(session.id, '远端标题二');
    assert.equal(store.get(session.id).title, '我的标题');
    assert.equal(store.get(session.id).remote_title, '远端标题二');
    store.update(session.id, { title_mode: 'auto', title: store.get(session.id).remote_title });
    assert.equal(store.get(session.id).title, '远端标题二');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('session trash is recoverable and permanent deletion is explicit', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsagent-trash-'));
  try {
    const store = new SessionStore(root).init(); const session = store.create({ title: 'trash me' });
    store.delete(session.id);
    assert.equal(store.list().length, 0); assert.equal(store.list({ deletedOnly: true })[0].id, session.id);
    store.restore(session.id); assert.equal(store.list()[0].id, session.id);
    store.delete(session.id, { permanent: true }); assert.equal(store.get(session.id), null);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
