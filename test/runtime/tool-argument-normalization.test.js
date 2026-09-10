'use strict';

// Regression guard for the "infinite retry" failure mode.
//
// The Runtime system prompt teaches models to call tools as
//   {"tool":"read","params":{"path":"src/a.js"}}
// When that instruction is rendered through DeepSeek's DSML protocol it
// arrives as a single parameter literally named `params`. The DSML parser
// originally only flattened a wrapper named `arguments`, so every such call
// reached the executor with zero real arguments: a missing `path` resolved to
// the workspace root and raised a misleading `EISDIR`, and the agent would
// retry the same call forever while still streaming text — the run never
// completed and the client showed an endless loading state.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { parseDsmlCalls } = require('../../src/runtime/deepseek-dsml');
const { parseToolCalls } = require('../../tool-loop');
const { RuntimeConfigStore } = require('../../src/runtime/config-store');
const { ToolRegistry } = require('../../src/runtime/tool-registry');
const { createToolExecutor } = require('../../src/runtime/tool-executor');

function dsml(name, parameters) {
  return '<｜DSML｜tool_calls>\n<｜DSML｜invoke name="' + name + '">\n' + parameters + '\n</｜DSML｜invoke>\n</｜DSML｜tool_calls>';
}

function executorFor(root) {
  const config = new RuntimeConfigStore(path.join(root, '.runtime')).init();
  config.patchSettings('user', null, { tools: { command: 'allow', network: 'allow' } });
  return createToolExecutor({ workspace: root, config, registry: new ToolRegistry({ config }) });
}

test('DSML flattens a single "params" wrapper exactly like "arguments"', () => {
  const wrapped = dsml('read', '<｜DSML｜parameter name="params">{"path":"src/a.js"}</｜DSML｜parameter>');
  assert.deepEqual(parseDsmlCalls(wrapped).map(({ name, arguments: args }) => ({ name, arguments: args })), [
    { name: 'read', arguments: { path: 'src/a.js' } }
  ]);

  // The full markdown -> command pipeline must carry flat arguments.
  const parsed = parseToolCalls(wrapped);
  assert.equal(parsed.commands.length, 1);
  assert.equal(parsed.commands[0].tool, 'read');
  assert.deepEqual(JSON.parse(parsed.commands[0].content), { path: 'src/a.js' });

  // The native `arguments` spelling keeps working, and real multi-parameter
  // calls must not be rewritten.
  const native = dsml('read', '<｜DSML｜parameter name="arguments">{"path":"b.js"}</｜DSML｜parameter>');
  assert.deepEqual(parseDsmlCalls(native)[0].arguments, { path: 'b.js' });
  const flat = dsml('read', '<｜DSML｜parameter name="path">c.js</｜DSML｜parameter><｜DSML｜parameter name="start">1</｜DSML｜parameter>');
  assert.deepEqual(parseDsmlCalls(flat)[0].arguments, { path: 'c.js', start: 1 });
});

test('the tool executor tolerates a wrapped argument object from any parser', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'webagent-args-'));
  try {
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'a.js'), 'alpha\nbeta\n', 'utf8');
    const executor = executorFor(root);

    const wrapped = await executor.execute('read', JSON.stringify({ params: { path: 'src/a.js' } }));
    assert.equal(wrapped.success, true, 'wrapped params must be unwrapped: ' + wrapped.error);
    assert.match(wrapped.data.content, /alpha/);

    const flat = await executor.execute('read', JSON.stringify({ path: 'src/a.js' }));
    assert.equal(flat.success, true);
    assert.match(flat.data.content, /alpha/);

    const written = await executor.execute('write_file', JSON.stringify({ params: { path: 'src/b.js', content: 'ok' } }));
    assert.equal(written.success, true, 'wrapped write must be unwrapped: ' + written.error);
    assert.equal(fs.readFileSync(path.join(root, 'src', 'b.js'), 'utf8'), 'ok');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a missing path parameter reports itself instead of reading a directory', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'webagent-args-'));
  try {
    const executor = executorFor(root);
    const result = await executor.execute('read', JSON.stringify({}));
    assert.equal(result.success, false);
    assert.equal(result.code, 'tool_missing_parameter');
    assert.match(result.error, /path/);
    // The old behaviour surfaced EISDIR from reading the workspace root.
    assert.doesNotMatch(result.error, /EISDIR/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('glob honours path patterns and read_file honours a limit', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'webagent-glob-'));
  try {
    fs.mkdirSync(path.join(root, 'src', 'nested'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'a.js'), 'l1\nl2\nl3\nl4\nl5\n', 'utf8');
    fs.writeFileSync(path.join(root, 'src', 'b.txt'), 'x\n', 'utf8');
    fs.writeFileSync(path.join(root, 'src', 'nested', 'c.js'), 'y\n', 'utf8');
    const executor = executorFor(root);

    // Patterns carrying a path used to be compared against the file name, so
    // every such call returned [] even though the files were right there.
    const deep = await executor.execute('glob', JSON.stringify({ pattern: 'src/**/*.js' }));
    assert.equal(deep.success, true);
    assert.equal(deep.data.files.length, 2, 'src/**/*.js must span directories: ' + JSON.stringify(deep.data.files));

    const direct = await executor.execute('glob', JSON.stringify({ pattern: 'src/*.js' }));
    assert.equal(direct.data.files.length, 1, 'src/*.js must not recurse');

    // Bare patterns keep matching at any depth so existing callers do not change.
    const bare = await executor.execute('glob', JSON.stringify({ pattern: '*.js' }));
    assert.equal(bare.data.files.length, 2);

    const limited = await executor.execute('read_file', JSON.stringify({ path: 'src/a.js', limit: 2 }));
    assert.equal(limited.data.content, 'l1\nl2');

    const whole = await executor.execute('read_file', JSON.stringify({ path: 'src/a.js' }));
    assert.equal(whole.data.content.split('\n').length, 6);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
