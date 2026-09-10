'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { DEFAULT_AGENT_INSTRUCTIONS, buildToolManifest } = require('../../src/runtime/system-prompt');

test('system prompt explicitly supports nested subagents without a recursion prohibition', () => {
  assert.match(DEFAULT_AGENT_INSTRUCTIONS, /子代理可以继续调用 subagent/);
  assert.doesNotMatch(DEFAULT_AGENT_INSTRUCTIONS, /不能递归|禁止递归|不可递归/);
});

test('tool manifest lists the real tool ids and the shell dialect', () => {
  // The legacy lib/tool-docs.js was dropped in the Node migration, leaving
  // models to guess tool names ("Unknown tool: list_files"), which burns
  // rounds and is the main entrance to long retry loops.
  const manifest = buildToolManifest([
    { id: 'read_file', label: '读取文件', risk: 'read' },
    { id: 'exec_command', label: '执行命令', risk: 'command' }
  ], { platform: 'win32' });
  assert.match(manifest, /read_file/);
  assert.match(manifest, /exec_command/);
  assert.match(manifest, /\{"tool":"工具名","params":\{\.\.\.\}\}/);
  assert.match(manifest, /PowerShell/);
  assert.match(manifest, /不要使用 ls、find/, 'must explicitly steer away from Unix commands on Windows');

  assert.equal(buildToolManifest([], { platform: 'win32' }), '');
  assert.equal(buildToolManifest(null), '');

  const posix = buildToolManifest([{ id: 'read_file' }], { platform: 'linux' });
  assert.doesNotMatch(posix, /PowerShell/);
});
