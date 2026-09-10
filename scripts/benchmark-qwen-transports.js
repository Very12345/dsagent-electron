'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const PROMPT = `你是一名高级分布式系统工程师。请设计一个“离线优先的多人协同任务看板”，约束如下：
- 单个项目最多 10,000 个任务，Web 端使用 IndexedDB；
- 多人可离线编辑标题、描述、负责人、标签、排序位置；
- 联机时优先 WebSocket，失败后退化为批量 HTTP；
- 服务端必须支持 RBAC、审计日志和幂等重放；
- 不允许用“最后写入者覆盖全部对象”掩盖字段级冲突。

请严格给出：
1. 关键假设与取舍；
2. TypeScript 核心数据结构；
3. 客户端同步循环伪代码；
4. 至少 6 类冲突/故障及确定性处理表；
5. 三条必须始终成立的不变量；
6. 8 个覆盖离线、乱序、重复、撤权与断线恢复的测试案例。
要求具体、可实现，指出两种看似简单但会失败的方案及原因，不要泛泛而谈。`;

function runtimeInfo() {
  return JSON.parse(fs.readFileSync(path.join(os.homedir(), '.webagent', 'runtime.json'), 'utf8'));
}

async function requestJson(base, token, route, options) {
  const response = await fetch(base + route, {
    method: options && options.method || 'GET',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: options && options.body != null ? JSON.stringify(options.body) : undefined
  });
  const text = await response.text();
  let body = text;
  try { body = text ? JSON.parse(text) : null; } catch (_) {}
  if (!response.ok) throw Object.assign(new Error(body && body.error && body.error.message || text || 'HTTP ' + response.status), { status: response.status, body });
  return body;
}

async function cleanup(base, token, result) {
  if (!result.session_id) return { deleted: false, reason: 'no_session' };
  if (!result.completed && result.run_id) {
    await requestJson(base, token, '/api/runs/' + encodeURIComponent(result.run_id) + '/cancel', { method: 'POST', body: {} }).catch(() => null);
  }
  for (let attempt = 0; attempt < 15; attempt += 1) {
    try {
      await requestJson(base, token, '/api/sessions/' + encodeURIComponent(result.session_id) + '?permanent=1', { method: 'DELETE' });
      return { deleted: true, attempts: attempt + 1 };
    } catch (error) {
      if (error.status !== 409) return { deleted: false, error: error.message };
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  return { deleted: false, error: 'session remained busy after cancellation' };
}

async function benchmark(base, token, model) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 180000);
  const started = performance.now();
  const result = {
    model, session_id: '', run_id: '', status: 0, header_ms: null,
    first_reasoning_ms: null, first_content_ms: null, total_ms: null,
    reasoning: '', content: '', finish_reason: '', completed: false, error: ''
  };
  try {
    const response = await fetch(base + '/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, stream: true, messages: [{ role: 'user', content: PROMPT }] }),
      signal: controller.signal
    });
    result.status = response.status;
    result.header_ms = Math.round(performance.now() - started);
    result.session_id = response.headers.get('x-webagent-session-id') || response.headers.get('x-dsagent-session-id') || '';
    result.run_id = response.headers.get('x-webagent-run-id') || response.headers.get('x-dsagent-run-id') || '';
    if (!response.ok) throw new Error(await response.text());
    const decoder = new TextDecoder();
    let pending = '';
    const consume = (line) => {
      if (!line.startsWith('data:')) return;
      const raw = line.slice(5).trim();
      if (!raw) return;
      if (raw === '[DONE]') { result.completed = true; return; }
      let event;
      try { event = JSON.parse(raw); } catch (_) { return; }
      if (event.error) { result.error = event.error.message || JSON.stringify(event.error); return; }
      const choice = event.choices && event.choices[0];
      const delta = choice && choice.delta || {};
      const reasoning = delta.reasoning_content || delta.reasoning || '';
      if (reasoning) {
        if (result.first_reasoning_ms == null) result.first_reasoning_ms = Math.round(performance.now() - started);
        result.reasoning += reasoning;
      }
      if (delta.content) {
        if (result.first_content_ms == null) result.first_content_ms = Math.round(performance.now() - started);
        result.content += delta.content;
      }
      if (choice && choice.finish_reason) result.finish_reason = choice.finish_reason;
    };
    for await (const chunk of response.body) {
      pending += decoder.decode(chunk, { stream: true });
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() || '';
      for (const line of lines) consume(line);
    }
    pending += decoder.decode();
    if (pending) consume(pending);
  } catch (error) {
    result.error = error.name === 'AbortError' ? 'timeout_after_180s' : error.message;
  } finally {
    clearTimeout(timeout);
    result.total_ms = Math.round(performance.now() - started);
  }
  result.cleanup = await cleanup(base, token, result);
  return result;
}

(async () => {
  const info = runtimeInfo();
  const base = 'http://127.0.0.1:' + info.port;
  const gateway = await benchmark(base, info.token, 'qwen.gateway');
  const web = await benchmark(base, info.token, 'qwen.default');
  console.log(JSON.stringify({ prompt: PROMPT, results: [gateway, web] }, null, 2));
})().catch((error) => { console.error(error.stack || error); process.exitCode = 1; });
