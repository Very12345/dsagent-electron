'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { acquireRuntimeLock, readLock } = require('../../src/node/runtime-lock');

test('runtime lock is atomic, owner-bound and releasable', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'webagent-lock-'));
  try {
    const file = path.join(root, 'runtime.lock');
    const lock = acquireRuntimeLock(file);
    assert.equal(readLock(file).pid, process.pid);
    assert.throws(() => acquireRuntimeLock(file), { code: 'runtime_already_running' });
    assert.equal(lock.release(), true);
    assert.equal(fs.existsSync(file), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('runtime lock replaces only a confirmed stale lock file', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'webagent-stale-lock-'));
  try {
    const file = path.join(root, 'runtime.lock');
    fs.writeFileSync(file, JSON.stringify({ pid: 123, token: 'stale' }));
    const lock = acquireRuntimeLock(file, { pidAlive: () => false });
    assert.notEqual(readLock(file).token, 'stale');
    lock.release();
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
