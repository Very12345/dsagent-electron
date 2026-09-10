'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { ModelApiService } = require('../../src/runtime/model-api-service');

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

test('published model API exposes exactly one alias and proxies requests to the selected Runtime model', async () => {
  let received = null;
  const runtime = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      received = { authorization: req.headers.authorization, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) };
      res.writeHead(200, { 'Content-Type': 'application/json', 'X-WebAgent-Session-Id': 'session-test' });
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'proxied' } }] }));
    });
  });
  const runtimePort = await listen(runtime);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'webagent-model-api-'));
  const service = new ModelApiService({ home, port: 0, getModels: () => [{ id: 'qwen.gateway.3.8-max', displayName: 'Qwen3.8 Max' }] });
  service.setRuntime({ port: runtimePort, token: 'runtime-secret' });
  try {
    await service.configure({ model: 'qwen.gateway.3.8-max', alias: 'qwen-max-local', port: 0 });
    const status = await service.start();
    const headers = { Authorization: 'Bearer ' + status.api_key, 'Content-Type': 'application/json' };
    const models = await fetch(status.base_url + '/models', { headers }).then((response) => response.json());
    assert.deepEqual(models.data.map((model) => model.id), ['qwen-max-local']);
    const response = await fetch(status.base_url + '/chat/completions', { method: 'POST', headers, body: JSON.stringify({ model: 'ignored-client-model', messages: [{ role: 'user', content: 'hello' }] }) });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).choices[0].message.content, 'proxied');
    assert.equal(response.headers.get('x-webagent-session-id'), 'session-test');
    assert.equal(received.authorization, 'Bearer runtime-secret');
    assert.equal(received.body.model, 'qwen.gateway.3.8-max');
    const unauthorized = await fetch(status.base_url + '/models');
    assert.equal(unauthorized.status, 401);
  } finally {
    await service.stop(false);
    await new Promise((resolve) => runtime.close(resolve));
    fs.rmSync(home, { recursive: true, force: true });
  }
});
