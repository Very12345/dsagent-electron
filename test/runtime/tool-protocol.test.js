'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseToolCalls } = require('../../tool-loop');

test('canonical DSH fences execute in the shared Runtime tool loop', () => {
  const parsed = parseToolCalls([
    '```dsh-tool-call',
    '{"name":"read_file","arguments":{"path":"src/stats.js"}}',
    '```',
    '```dsh-tool-call',
    '{"name":"exec_command","arguments":{"command":"npm test"}}',
    '```'
  ].join('\n'));
  assert.deepEqual(parsed.errors, []);
  assert.deepEqual(parsed.commands.map((command) => command.tool), ['read_file', 'exec_command']);
  assert.deepEqual(JSON.parse(parsed.commands[0].content), { path: 'src/stats.js' });
});

test('parses DeepSeek Calling protocol even when code-block toolbar text is present', () => {
  const parsed = parseToolCalls([
    '首先让我查看项目的根目录结构： Calling: list_directory',
    '',
    '```text',
    'text 复制 下载',
    '{"path":"."}',
    '```'
  ].join('\n'));
  assert.equal(parsed.commands.length, 1);
  assert.deepEqual(parsed.commands[0], {
    tool: 'list_directory',
    content: '{"path":"."}',
    format: 'calling'
  });
});

test('parses multiple Calling commands in declaration order', () => {
  const parsed = parseToolCalls('Calling: read_file\n{"path":"a.js"}\nCalling: grep_search\n{"query":"TODO"}');
  assert.deepEqual(parsed.commands.map((command) => command.tool), ['read_file', 'grep_search']);
});

test('parses DeepSeek fenced native name/arguments arrays', () => {
  const parsed = parseToolCalls([
    '我先查看项目。',
    '```json',
    '[{"name":"list_directory","arguments":{"path":"."}},{"name":"read_file","arguments":{"path":"package.json"}}]',
    '```'
  ].join('\n'));
  assert.deepEqual(parsed.commands.map((command) => [command.tool, command.content, command.format]), [
    ['list_directory', '{"path":"."}', 'native'],
    ['read_file', '{"path":"package.json"}', 'native']
  ]);
});

test('parses DeepSeek simplified Chinese call markers', () => {
  const parsed = parseToolCalls('我先检查目录。\n[调用 list_directory] {"path":"."}');
  assert.deepEqual(parsed.commands[0], {
    tool: 'list_directory',
    content: '{"path":"."}',
    format: 'calling'
  });
});

test('parses DeepSeek direct XML tool tags with nested arguments', () => {
  const parsed = parseToolCalls('我先读取文件。\n<read_file>\n<path>package.json</path>\n</read_file>');
  assert.deepEqual(parsed.commands[0], {
    tool: 'read_file',
    content: '{"path":"package.json"}',
    format: 'xml'
  });
});

test('parses DeepSeek function_call XML wrappers', () => {
  const parsed = parseToolCalls('<function_calls><function_call>{"name":"list_directory","arguments":{"path":"."}}</function_call></function_calls>');
  assert.deepEqual(parsed.commands[0], {
    tool: 'list_directory',
    content: '{"path":"."}',
    format: 'native'
  });
});

test('parses decorated Calling markers used after tool failures', () => {
  const parsed = parseToolCalls('**Calling:** `read_file`\n```\n{"file_path":"package.json"}\n```');
  assert.equal(parsed.commands[0].tool, 'read_file');
  assert.equal(parsed.commands[0].content, '{"file_path":"package.json"}');
});

test('parses DeepSeek inline Markdown Calling with arguments', () => {
  const parsed = parseToolCalls('**Calling** `read` with `{"file_path":"D:\\\\Work\\\\package.json"}`');
  assert.equal(parsed.commands.length, 1);
  assert.equal(parsed.commands[0].tool, 'read');
  assert.deepEqual(JSON.parse(parsed.commands[0].content), { file_path: 'D:\\Work\\package.json' });
});

test('parses ReAct Action and Action Input calls', () => {
  const parsed = parseToolCalls('我来读取文件。\nAction: read_file\nAction Input: {"file_path":"package.json"}');
  assert.deepEqual(parsed.commands[0], {
    tool: 'read_file',
    content: '{"file_path":"package.json"}',
    format: 'native'
  });
});
