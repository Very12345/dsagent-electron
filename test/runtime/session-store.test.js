'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { SessionStore } = require('../../src/runtime/session-store');

test('session snapshots and monotonic events survive restart', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsagent-store-'));
  try {
    const store = new SessionStore(root).init();
    const session = store.create({ title: 'persist', workspace: root, model: 'mock' });
    store.appendMessage(session.id, { role: 'user', content: 'hello' });
    const first = store.appendEvent(session.id, { type: 'one', run_id: 'run-a' });
    const second = store.appendEvent(session.id, { type: 'two', run_id: 'run-a' });
    assert.equal(first.seq, 1);
    assert.equal(second.seq, 2);

    const restored = new SessionStore(root).init();
    assert.equal(restored.get(session.id).messages[0].content, 'hello');
    assert.deepEqual(restored.getEvents(session.id, 1).map((event) => event.type), ['two']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
