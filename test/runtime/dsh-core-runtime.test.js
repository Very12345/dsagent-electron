'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { corePaths, resolveRuntimeToken } = require('../../src/runtime/dsh-core-runtime');

function withHome(run) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'webagent-token-'));
  try {
    return run(home, corePaths({ home }));
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
}

function clearEnvToken() {
  const previous = process.env.WEBAGENT_RUNTIME_TOKEN;
  delete process.env.WEBAGENT_RUNTIME_TOKEN;
  return () => {
    if (previous === undefined) delete process.env.WEBAGENT_RUNTIME_TOKEN;
    else process.env.WEBAGENT_RUNTIME_TOKEN = previous;
  };
}

test('corePaths places the token file under the runtime home', () => {
  withHome((home, paths) => {
    assert.equal(paths.tokenFile, path.join(home, 'runtime-token'));
  });
});

test('a first boot mints a token and persists it for the next boot', () => {
  const restore = clearEnvToken();
  try {
    withHome((home, paths) => {
      assert.equal(fs.existsSync(paths.tokenFile), false);
      const first = resolveRuntimeToken({ paths });
      assert.match(first, /^[0-9a-f]{48}$/);
      assert.equal(fs.readFileSync(paths.tokenFile, 'utf8').trim(), first);

      // The whole point: a restart reuses the stored token instead of rotating it.
      const second = resolveRuntimeToken({ paths });
      assert.equal(second, first);
    });
  } finally { restore(); }
});

test('an existing token file is adopted rather than replaced', () => {
  const restore = clearEnvToken();
  try {
    withHome((home, paths) => {
      fs.writeFileSync(paths.tokenFile, 'preprovisioned-token\n', 'utf8');
      assert.equal(resolveRuntimeToken({ paths }), 'preprovisioned-token');
      assert.equal(fs.readFileSync(paths.tokenFile, 'utf8').trim(), 'preprovisioned-token');
    });
  } finally { restore(); }
});

test('WEBAGENT_RUNTIME_TOKEN overrides the file and is not written to it', () => {
  const previous = process.env.WEBAGENT_RUNTIME_TOKEN;
  process.env.WEBAGENT_RUNTIME_TOKEN = 'operator-supplied-token';
  try {
    withHome((home, paths) => {
      fs.writeFileSync(paths.tokenFile, 'on-disk-token\n', 'utf8');
      assert.equal(resolveRuntimeToken({ paths }), 'operator-supplied-token');
      // The override must not clobber what the file holds for the next boot.
      assert.equal(fs.readFileSync(paths.tokenFile, 'utf8').trim(), 'on-disk-token');
    });
  } finally {
    if (previous === undefined) delete process.env.WEBAGENT_RUNTIME_TOKEN;
    else process.env.WEBAGENT_RUNTIME_TOKEN = previous;
  }
});

test('a blank or whitespace-only token file falls through to a fresh token', () => {
  const restore = clearEnvToken();
  try {
    withHome((home, paths) => {
      fs.writeFileSync(paths.tokenFile, '\n', 'utf8');
      const token = resolveRuntimeToken({ paths });
      assert.match(token, /^[0-9a-f]{48}$/);
      assert.equal(fs.readFileSync(paths.tokenFile, 'utf8').trim(), token);
    });
  } finally { restore(); }
});

test('an unwritable token file still yields a usable in-process token', () => {
  const restore = clearEnvToken();
  try {
    withHome((home, paths) => {
      // A directory where the file belongs makes persisting fail.
      fs.mkdirSync(paths.tokenFile);
      const token = resolveRuntimeToken({ paths });
      assert.match(token, /^[0-9a-f]{48}$/);
    });
  } finally { restore(); }
});

test('the token file is written owner-only on POSIX', { skip: process.platform === 'win32' ? 'POSIX file modes are not available on Windows' : false }, () => {
  const restore = clearEnvToken();
  try {
    withHome((home, paths) => {
      resolveRuntimeToken({ paths });
      assert.equal(fs.statSync(paths.tokenFile).mode & 0o777, 0o600);
    });
  } finally { restore(); }
});
