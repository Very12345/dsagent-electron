'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { createOpenAIServer } = require('../../server-openai');

async function mockServer(handler) {
  const server = http.createServer(handler); await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, endpoint: 'http://127.0.0.1:' + server.address().port + '/v1' };
}

test('OpenAI-compatible Responses upstream forwards real incremental deltas', async () => {
  const mock = await mockServer((req, res) => {
    assert.equal(req.url, '/v1/responses');
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('data: {"type":"response.output_text.delta","delta":"hel"}\n\n');
    setTimeout(() => { res.write('data: {"type":"response.output_text.delta","delta":"lo"}\n\n'); res.end('data: [DONE]\n\n'); }, 10);
  });
  try {
    const api = createOpenAIServer({ endpoint: mock.endpoint, apiKey: 'test', protocol: 'responses', models: [{ id: 'model', apiName: 'model' }] });
    const created = await api.invoke('model', 'newChat', {}); const progress = [];
    const sent = await api.invoke('model', 'sendMessage', { _conversationUrl: created.data.conversationUrl, text: 'hi', stream: true, onDelta: (text) => progress.push(text) });
    assert.equal(sent.success, true); assert.deepEqual(progress, ['hel', 'hello']);
    const output = await api.invoke('model', 'extractResponse', { _conversationUrl: created.data.conversationUrl }); assert.equal(output.data.markdown, 'hello');
  } finally { await new Promise((resolve) => mock.server.close(resolve)); }
});

test('OpenAI-compatible native function calls are converted to the runtime tool protocol', async () => {
  const mock = await mockServer((_req, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message: { tool_calls: [{ function: { name: 'read_file', arguments: '{"path":"README.md"}' } }] } }] })); });
  try {
    const api = createOpenAIServer({ endpoint: mock.endpoint, apiKey: 'test', protocol: 'chat_completions', models: [{ id: 'model' }] });
    const created = await api.invoke('model', 'newChat', {}); await api.invoke('model', 'sendMessage', { _conversationUrl: created.data.conversationUrl, text: 'read' });
    const output = await api.invoke('model', 'extractResponse', { _conversationUrl: created.data.conversationUrl });
    assert.match(output.data.markdown, /Calling: read_file/); assert.match(output.data.markdown, /README\.md/);
  } finally { await new Promise((resolve) => mock.server.close(resolve)); }
});
