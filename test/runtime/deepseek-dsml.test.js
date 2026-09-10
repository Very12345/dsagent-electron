'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseDsmlCalls, dsmlMarkerIndex, completeDsmlSuffix } = require('../../src/runtime/deepseek-dsml');
const { bridgeCallPayloads, bridgedToolCalls, contentBeforeToolCalls } = require('../../src/runtime/api-server');
const { parseToolCalls } = require('../../tool-loop');
const { extractDshToolCallsFromText } = require('../../server-deepseek');

const official = `<｜DSML｜tool_calls>
<｜DSML｜invoke name="write">
<｜DSML｜parameter name="file_path" string="true">src/app.js</｜DSML｜parameter>
<｜DSML｜parameter name="content" string="true">const value = "ok";</｜DSML｜parameter>
</｜DSML｜invoke>
<｜DSML｜invoke name="pwsh">
<｜DSML｜parameter name="arguments" string="false">{"command":"npm test","timeout":120000}</｜DSML｜parameter>
</｜DSML｜invoke>
</｜DSML｜tool_calls><｜end▁of▁sentence｜>`;

test('DeepSeek DSML parses parallel typed parameters and flattens arguments objects', () => {
  assert.deepEqual(parseDsmlCalls(official).map(({ name, arguments: args }) => ({ name, arguments: args })), [
    { name: 'write', arguments: { file_path: 'src/app.js', content: 'const value = "ok";' } },
    { name: 'pwsh', arguments: { command: 'npm test', timeout: 120000 } }
  ]);
  assert.equal(dsmlMarkerIndex('prefix\n' + official), 7);
  assert.equal(completeDsmlSuffix('reasoning\n' + official).length, 2);
  assert.deepEqual(completeDsmlSuffix(official + '\nordinary prose'), []);
});

test('DeepSeek DSML accepts webpage-spaced and HTML-escaped markers', () => {
  const spaced = `< | | DSML | | calls>
< | | DSML | | invoke name="pwsh">
< | | DSML | | parameter name="arguments" string="false">{"command":"Get-ChildItem -Force"}</ | | DSML | | parameter>
</ | | DSML | | invoke>
</ | | DSML | | calls>`;
  assert.deepEqual(parseDsmlCalls(spaced).map(({ name, arguments: args }) => ({ name, arguments: args })), [
    { name: 'pwsh', arguments: { command: 'Get-ChildItem -Force' } }
  ]);
  const escaped = '&lt;｜DSML｜invoke name=&quot;read&quot;&gt;&lt;｜DSML｜parameter name=&quot;file_path&quot; string=&quot;true&quot;&gt;README.md&lt;/｜DSML｜parameter&gt;&lt;/｜DSML｜invoke&gt;';
  assert.deepEqual(parseDsmlCalls(escaped).map(({ name, arguments: args }) => ({ name, arguments: args })), [
    { name: 'read', arguments: { file_path: 'README.md' } }
  ]);
});

test('incomplete DSML stays inert while complete calls become allowlisted OpenAI calls', () => {
  assert.deepEqual(parseDsmlCalls('<｜DSML｜invoke name="pwsh"><｜DSML｜parameter name="arguments" string="false">{"command":"dir"}'), []);
  assert.equal(bridgeCallPayloads(official).length, 2);
  const tools = [
    { type: 'function', function: { name: 'pwsh', parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } } }
  ];
  const calls = bridgedToolCalls('I will inspect.\n' + official, tools);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].function.name, 'pwsh');
  assert.deepEqual(JSON.parse(calls[0].function.arguments), { command: 'npm test', timeout: 120000 });
  assert.equal(contentBeforeToolCalls('I will inspect.\n' + official), 'I will inspect.');
});

test('canonical DOM DSML is recognized as tool syntax before it reaches an SSE client', () => {
  assert.equal(dsmlMarkerIndex('<dsml_tool_call>\n<dsml_invoke name="pwsh">'), 0);
  assert.equal(dsmlMarkerIndex('prose only'), -1);
  assert.equal(contentBeforeToolCalls('progress\n\n<tool_calls>\n<tool_call>\n<invoke name="pwsh">'), 'progress');
});

test('Runtime tool loop recognizes DSML without exposing it as prose', () => {
  const parsed = parseToolCalls(official);
  assert.deepEqual(parsed.commands.map((command) => ({ tool: command.tool, args: JSON.parse(command.content), format: command.format })), [
    { tool: 'write', args: { file_path: 'src/app.js', content: 'const value = "ok";' }, format: 'dsml' },
    { tool: 'pwsh', args: { command: 'npm test', timeout: 120000 }, format: 'dsml' }
  ]);
});

test('flattened dsh fences preserve schema properties instead of producing empty arguments', () => {
  const output = `Retrying.
\`\`\`dsh-tool-call
{"name":"pwsh","command":"Get-Location","description":"Show workspace"}
\`\`\`
\`\`\`dsh-tool-call
{"name":"glob","pattern":"**/*"}
\`\`\``;
  const tools = [
    { type: 'function', function: { name: 'pwsh', parameters: { type: 'object', properties: { command: { type: 'string' }, description: { type: 'string' } }, required: ['command', 'description'] } } },
    { type: 'function', function: { name: 'glob', parameters: { type: 'object', properties: { pattern: { type: 'string' } }, required: ['pattern'] } } }
  ];
  const calls = bridgedToolCalls(output, tools);
  assert.deepEqual(calls.map((call) => ({ name: call.function.name, arguments: JSON.parse(call.function.arguments) })), [
    { name: 'pwsh', arguments: { command: 'Get-Location', description: 'Show workspace' } },
    { name: 'glob', arguments: { pattern: '**/*' } }
  ]);
  assert.deepEqual(parseToolCalls(output).commands.map((call) => JSON.parse(call.content)), [
    { command: 'Get-Location', description: 'Show workspace' },
    { pattern: '**/*' }
  ]);
  assert.match(extractDshToolCallsFromText(output), /"command":"Get-Location"/);
  assert.match(extractDshToolCallsFromText(output), /"pattern":"\*\*\/\*"/);
});

test('actual double-fullwidth-pipe DOM DSML preserves PowerShell arguments', () => {
  const output = `<｜｜DSML｜｜ calls>
<｜｜DSML｜｜ invoke name="pwsh">
<｜｜DSML｜｜ parameter name="arguments" string="false">{"command":"$root='D:\\\\Work'; Get-ChildItem $root","description":"Inspect"}</｜｜DSML｜｜ parameter>
</｜｜DSML｜｜ invoke>
</｜｜DSML｜｜ calls>`;
  const parsed = parseDsmlCalls(output);
  assert.equal(parsed.length, 1);
  assert.deepEqual(parsed[0].arguments, { command: "$root='D:\\Work'; Get-ChildItem $root", description: 'Inspect' });
});

test('write bridge repairs a whole JSON-escaped multiline file without touching command backslashes', () => {
  const output = `<｜DSML｜tool_calls>
<｜DSML｜invoke name="write">
<｜DSML｜parameter name="file_path" string="true">src/probe.js</｜DSML｜parameter>
<｜DSML｜parameter name="content" string="true">const root = "D:\\Work";\\nconsole.log(root);\\nprocess.exit(0);</｜DSML｜parameter>
</｜DSML｜invoke>
</｜DSML｜tool_calls>`;
  const tools = [{ type: 'function', function: { name: 'write', parameters: {
    type: 'object', properties: { file_path: { type: 'string' }, content: { type: 'string' } }, required: ['file_path', 'content']
  } } }];
  const call = bridgedToolCalls(output, tools)[0];
  assert.deepEqual(JSON.parse(call.function.arguments), {
    file_path: 'src/probe.js', content: 'const root = "D:\\Work";\nconsole.log(root);\nprocess.exit(0);'
  });
});
