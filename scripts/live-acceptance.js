'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const info = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.webagent', 'runtime.json'), 'utf8'));
const base = `http://127.0.0.1:${info.port}`;
const headers = { Authorization: `Bearer ${info.token}`, 'Content-Type': 'application/json' };
const report = { started_at: new Date().toISOString(), runtime: { pid: info.pid, port: info.port, product: info.product }, sessions: [], runs: [], checks: {} };

async function api(route, options = {}) {
  const response = await fetch(base + route, { method: options.method || (options.body ? 'POST' : 'GET'), headers, body: options.body ? JSON.stringify(options.body) : undefined });
  const value = await response.json();
  if (!response.ok) throw Object.assign(new Error(value.error && value.error.message || response.statusText), { status: response.status, value });
  return value;
}

async function waitRun(run, timeout = 10 * 60 * 1000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const approvals = await api('/api/approvals');
    for (const approval of approvals.data || []) {
      if (approval.run_id === run.id && approval.status === 'pending') await api('/api/approvals/' + approval.id, { method: 'POST', body: { approved: true, reason: 'isolated acceptance project' } });
    }
    const current = await api('/api/runs/' + run.id);
    if (['completed', 'failed', 'cancelled'].includes(current.status)) return current;
    await new Promise((resolve) => setTimeout(resolve, 800));
  }
  throw new Error('Run timed out: ' + run.id);
}

async function start(sessionId, body) {
  const run = await api('/api/sessions/' + sessionId + '/runs', { method: 'POST', body });
  const completed = await waitRun(run);
  report.runs.push({ id: completed.id, session_id: completed.session_id, status: completed.status, output: String(completed.output || '').slice(0, 1200), error: completed.error });
  if (completed.status !== 'completed') throw new Error('Run failed: ' + JSON.stringify(completed.error));
  return completed;
}

async function main() {
  const workspace = 'D:\\Code\\Project\\WebAgentLargeTest';
  const projects = await api('/api/projects');
  let project = projects.data.find((item) => path.resolve(item.workspace).toLowerCase() === path.resolve(workspace).toLowerCase());
  if (!project) project = await api('/api/projects', { method: 'POST', body: { name: 'WebAgentLargeTest', workspace } });
  const clusterId = 'live-mixed-provider-acceptance';
  const clusters = await api('/api/clusters');
  if (clusters.data.some((item) => item.id === clusterId)) await api('/api/clusters/' + clusterId, { method: 'DELETE' });
  await api('/api/clusters', { method: 'POST', body: {
    id: clusterId, name: 'Live DeepSeek + ChatGPT', strategy: 'parallel', max_parallel: 2, max_depth: 2, timeout_ms: 420000,
    roles: [
      { id: 'deepseek-reviewer', name: 'DeepSeek Reviewer', model: 'deepseek.expert', prompt: 'Inspect the supplied project evidence and identify one concrete architectural invariant.' },
      { id: 'chatgpt-reviewer', name: 'ChatGPT Reviewer', model: 'chatgpt.web', prompt: 'Independently review this concrete evidence: routeKey(sessionId, runId, callId) rejects empty IDs and returns the three IDs joined by colons; smoke reports 12 packages, 2052 modules, ok:true; git diff is empty. Identify one concrete missing regression test.' }
    ]
  } });
  const session = await api('/api/sessions', { method: 'POST', body: { title: 'WebAgent TEST · mixed provider rollover', mode: 'project', project_id: project.id, workspace, model: 'deepseek.expert' } });
  report.sessions.push(session.id);
  await start(session.id, {
    prompt: 'Run the supplied acceptance chain on this isolated generated project, aggregate results in declaration order, and finish with a concise VERIFIED summary.',
    model: 'deepseek.expert', agent_mode: true, deep_think: true,
    tool_calls: [
      { tool: 'rg', params: { pattern: 'routeKey', path: 'packages' } },
      { tool: 'read_file', params: { path: 'packages/gateway/src/module-084.ts' } },
      { tool: 'exec_command', params: { command: 'node scripts/smoke.js' } },
      { tool: 'git_diff', params: {} },
      { tool: 'agent_cluster', params: { cluster_id: clusterId, prompt: 'Review WebAgentLargeTest. Evidence: packages/gateway/src/module-084.ts exports routeKey with explicit ID validation; smoke reports 12 packages, 2052 modules, ok:true; git diff is empty.' } }
    ]
  });
  for (let generation = 1; generation <= 2; generation += 1) {
    await api('/api/sessions/' + session.id + '/compact', { method: 'POST', body: {} });
    await start(session.id, { prompt: `Context rollover verification ${generation}: state the current project, completed checks, and remaining work without calling additional tools.`, model: 'deepseek.expert', agent_mode: true });
  }
  const finalSession = await api('/api/sessions/' + session.id);
  const events = await api('/api/sessions/' + session.id + '/events-snapshot').catch(() => null);
  const localEvents = await new Promise((resolve) => {
    const req = require('http').request({ hostname: '127.0.0.1', port: info.port, path: '/api/sessions/' + session.id + '/events?after=0', headers: { Authorization: `Bearer ${info.token}`, Accept: 'text/event-stream' } });
    let buffer = '', rows = [];
    req.on('response', (res) => res.on('data', (chunk) => { buffer += chunk; let at; while ((at = buffer.indexOf('\n\n')) >= 0) { const block = buffer.slice(0, at); buffer = buffer.slice(at + 2); const line = block.split(/\r?\n/).find((item) => item.startsWith('data: ')); if (line) { try { rows.push(JSON.parse(line.slice(6))); } catch (_) {} } } if (rows.some((event) => event.type === 'run.completed' && event.run_id === report.runs.at(-1).id)) { req.destroy(); resolve(rows); } }));
    req.on('error', () => resolve(rows)); req.end(); setTimeout(() => { req.destroy(); resolve(rows); }, 5000);
  });
  report.checks = {
    context_generation: finalSession.context_state.generation,
    conversations: finalSession.provider_state.conversations,
    remote_deleted_generations: finalSession.provider_state.conversations.filter((item) => item.status === 'deleted').length,
    active_conversations: finalSession.provider_state.conversations.filter((item) => item.status === 'active').length,
    tool_calls: localEvents.filter((event) => event.type === 'tool_call.completed').map((event) => ({ tool: event.data.tool, success: event.data.success, call_id: event.call_id })),
    subagents: localEvents.filter((event) => event.type === 'subagent.completed').map((event) => ({ call_id: event.call_id, child_session_id: event.data.child_session_id, status: event.data.status })),
    all_events_owned: localEvents.every((event) => event.session_id === session.id && !!event.run_id && Object.prototype.hasOwnProperty.call(event, 'parent_run_id') && Object.prototype.hasOwnProperty.call(event, 'call_id'))
  };
  if (report.checks.context_generation < 2 || report.checks.remote_deleted_generations < 2 || report.checks.active_conversations !== 1) throw new Error('Context rollover ownership checks failed');
  if (report.checks.subagents.length < 2 || report.checks.subagents.some((item) => item.status !== 'completed')) throw new Error('Mixed-provider subagent checks failed');
  if (!report.checks.all_events_owned) throw new Error('Event ownership check failed');

  const allSessions = await api('/api/sessions?hidden=1&deleted=all');
  const children = allSessions.data.filter((item) => item.parent_session_id === session.id);
  for (const child of children) { await api('/api/sessions/' + child.id + '?permanent=1&remote=1', { method: 'DELETE' }); report.sessions.push(child.id); }
  await api('/api/sessions/' + session.id, { method: 'DELETE' });
  await api('/api/sessions/' + session.id + '?permanent=1&remote=1', { method: 'DELETE' });
  await api('/api/clusters/' + clusterId, { method: 'DELETE' });
  report.cleaned = true;
}

main().catch((error) => { report.error = { message: error.message, stack: error.stack }; process.exitCode = 1; }).finally(() => {
  report.completed_at = new Date().toISOString();
  const target = path.join(__dirname, '..', 'test-results', 'live-acceptance.json');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, JSON.stringify(report, null, 2), 'utf8');
  console.log(JSON.stringify(report, null, 2));
});
