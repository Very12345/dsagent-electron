'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  BRIDGE_SENTINEL,
  initialEnvelope,
  continuationEnvelope,
  orderedMessages,
  stateFor
} = require('../../src/runtime/dsh-web-codec');

const runtimeContext = 'Current runtime context. This snapshot supersedes earlier runtime-context snapshots.\n\nWorkspace: D:/Code/Test\nPolicy: workspace-write';
const prompt = BRIDGE_SENTINEL + '\nCompact DSH-owned prompt. Use only native DSML.';
const tools = [{ name: 'read_file', description: 'Read one file', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } }];
const skillCatalog = '<system-reminder>\n<available_skills>\n- `cordis-plugin-development`: Build plugins.\n</available_skills>\n</system-reminder>';

function tagValue(text, name) {
  const match = text.match(new RegExp('<' + name + '_json>([\\s\\S]*?)</' + name + '_json>'));
  assert.ok(match, 'missing ' + name + ' envelope');
  return JSON.parse(match[1]);
}

test('initial DSH envelope preserves every transport message in its original order', () => {
  const source = [
    { role: 'developer', content: prompt },
    { role: 'user', content: 'Inspect package.json' },
    { role: 'user', content: runtimeContext },
    { role: 'user', content: skillCatalog }
  ];
  const envelope = initialEnvelope(source, tools);
  assert.match(envelope.text, /Compact DSH-owned prompt/);
  assert.deepEqual(tagValue(envelope.text, 'dsh_messages'), orderedMessages(source));
  assert.deepEqual(tagValue(envelope.text, 'dsh_messages').map((message) => message.content), [
    'Inspect package.json', runtimeContext, skillCatalog
  ]);
  assert.match(envelope.text, /"required":\["path"\]/);
  assert.doesNotMatch(envelope.text, /dsh_user_request_json|dsh_supplemental_context_json|dsh_runtime_context_json/);
  assert.equal(envelope.state.version, 3);
  assert.equal(envelope.state.message_count, 3);
});

test('a complete external preset keeps its system prompt ahead of the webpage wire appendix', () => {
  const presetPrompt = 'You are a helpful software engineer assistant.';
  const envelope = initialEnvelope([
    { role: 'system', content: presetPrompt },
    { role: 'user', content: 'Inspect the project' }
  ], tools);
  assert.ok(envelope.text.indexOf(presetPrompt) < envelope.text.indexOf(BRIDGE_SENTINEL));
  assert.match(envelope.text, /WEBAGENT_DSH_BRIDGE_V3/);
  assert.match(envelope.text, /<｜DSML｜tool_calls>/);
  assert.doesNotMatch(envelope.text, /dsh-tool-call/);
  assert.match(envelope.text, /no alternative tool protocol/);
});

test('continuation preserves assistant calls and parallel tool results as an ordered delta', () => {
  const before = [
    { role: 'developer', content: prompt },
    { role: 'user', content: 'Inspect files' },
    { role: 'user', content: runtimeContext }
  ];
  const messages = before.concat([
    { role: 'assistant', content: '', tool_calls: [
      { id: 'call_a', function: { name: 'read_file', arguments: '{"path":"a"}' } },
      { id: 'call_b', function: { name: 'read_file', arguments: '{"path":"b"}' } }
    ] },
    { role: 'tool', tool_call_id: 'call_a', content: 'A' },
    { role: 'tool', tool_call_id: 'call_b', content: 'B' }
  ]);
  const envelope = continuationEnvelope(messages, tools, stateFor(before, tools));
  const delta = tagValue(envelope.text, 'dsh_messages');
  assert.deepEqual(delta.map((message) => message.role), ['assistant', 'tool', 'tool']);
  assert.deepEqual(delta.slice(1).map((message) => message.tool_call_id), ['call_a', 'call_b']);
  assert.doesNotMatch(envelope.text, /Continue the task|dsh_tool_results_json|dsh_user_request_json/);
});

test('runtime snapshots and skill reminders after tool results retain their exact positions', () => {
  const before = [
    { role: 'developer', content: prompt },
    { role: 'user', content: 'Inspect package.json' }
  ];
  const messages = before.concat([
    { role: 'assistant', content: '', tool_calls: [{ id: 'call_read', function: { name: 'read_file', arguments: '{"path":"package.json"}' } }] },
    { role: 'tool', tool_call_id: 'call_read', content: '{"name":"webagent-electron"}' },
    { role: 'user', content: runtimeContext },
    { role: 'user', content: skillCatalog }
  ]);
  const envelope = continuationEnvelope(messages, tools, stateFor(before, tools));
  const delta = tagValue(envelope.text, 'dsh_messages');
  assert.deepEqual(delta.map((message) => message.role), ['assistant', 'tool', 'user', 'user']);
  assert.deepEqual(delta.map((message) => message.content), ['', '{"name":"webagent-electron"}', runtimeContext, skillCatalog]);
});

test('a later user turn is not promoted ahead of or behind adjacent DSH context', () => {
  const first = [
    { role: 'developer', content: prompt },
    { role: 'user', content: 'first' },
    { role: 'user', content: runtimeContext }
  ];
  const next = first.concat([
    { role: 'assistant', content: 'first answer' },
    { role: 'user', content: 'second' },
    { role: 'user', content: runtimeContext + '\nApproval: granted' }
  ]);
  const envelope = continuationEnvelope(next, tools.concat({ name: 'write_file', parameters: { type: 'object' } }), stateFor(first, tools));
  assert.deepEqual(tagValue(envelope.text, 'dsh_messages').map((message) => message.content), [
    'first answer', 'second', runtimeContext + '\nApproval: granted'
  ]);
  assert.match(envelope.text, /write_file/);
});
