'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const workRoot = 'D:\\Work\\WAWorkSpace';
const info = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.webagent', 'runtime.json'), 'utf8'));
const base = `http://127.0.0.1:${info.port}`;
const headers = { Authorization: `Bearer ${info.token}`, 'Content-Type': 'application/json' };
const report = { started_at: new Date().toISOString(), sessions: [], runs: [], checks: {} };

async function api(route, options = {}) {
  const response = await fetch(base + route, { method: options.method || (options.body ? 'POST' : 'GET'), headers, body: options.body ? JSON.stringify(options.body) : undefined });
  const value = await response.json();
  if (!response.ok) throw Object.assign(new Error(value.error && value.error.message || response.statusText), { status: response.status, value });
  return value;
}

async function waitRun(run, timeout = 8 * 60 * 1000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const approvals = await api('/api/approvals');
    for (const approval of approvals.data || []) {
      if (approval.run_id === run.id && approval.status === 'pending') await api('/api/approvals/' + approval.id, { method: 'POST', body: { approved: true, reason: 'isolated WebAgent mode acceptance' } });
    }
    const current = await api('/api/runs/' + run.id);
    if (['completed', 'failed', 'cancelled'].includes(current.status)) return current;
    await new Promise((resolve) => setTimeout(resolve, 700));
  }
  throw new Error('Run timed out: ' + run.id);
}

async function run(session, body) {
  const started = await api('/api/sessions/' + session.id + '/runs', { method: 'POST', body });
  const completed = await waitRun(started);
  report.runs.push({ id: completed.id, session_id: session.id, status: completed.status, output: completed.output });
  if (completed.status !== 'completed') throw new Error('Run failed: ' + JSON.stringify(completed.error));
  return completed;
}

function snapshot(file) { return fs.existsSync(file) ? { exists: true, content: fs.readFileSync(file) } : { exists: false }; }
function restore(file, before) {
  if (before.exists) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, before.content); }
  else if (fs.existsSync(file)) fs.rmSync(file, { force: true });
}

async function permanentDelete(sessionId) {
  try { await api('/api/sessions/' + sessionId, { method: 'DELETE' }); } catch (_) {}
  await api('/api/sessions/' + sessionId + '?permanent=1&remote=1', { method: 'DELETE' });
}

async function main() {
  fs.mkdirSync(workRoot, { recursive: true });
  const today = new Date().toISOString().slice(0, 10);
  const managedFiles = [path.join(workRoot, 'MEMORY.md'), path.join(workRoot, 'memory', today + '.md'), path.join(workRoot, '.webagent', 'work-index.json')];
  const before = new Map(managedFiles.map((file) => [file, snapshot(file)]));
  const artifactRoot = path.join(workRoot, 'Acceptance-Live');
  try {
    const first = await api('/api/sessions', { method: 'POST', body: { title: 'WebAgent TEST work memory seed', mode: 'work', work_root: workRoot, model: 'deepseek.fast' } });
    report.sessions.push(first.id);
    await run(first, {
      prompt: 'Always remember this work rule: acceptance code is WA-MEMORY-2026 and the default reporting language is Chinese. Create the requested concise office note, then state work_archive_path: "Acceptance-Live/Seed".',
      model: 'deepseek.fast', agent_mode: true,
      tool_calls: [{ tool: 'write_file', params: { path: 'Acceptance-Live/Seed/office-note.md', content: '# Acceptance note\n\nCode: WA-MEMORY-2026\nDefault reporting language: Chinese.\n' } }]
    });

    const second = await api('/api/sessions', { method: 'POST', body: { title: 'WebAgent TEST work memory recall', mode: 'work', work_root: workRoot, model: 'deepseek.fast' } });
    report.sessions.push(second.id);
    const recalled = await run(second, {
      prompt: 'From prior work memory, report the acceptance code and default reporting language. Then state work_archive_path: "Acceptance-Live/Recall". Do not invent values.',
      model: 'deepseek.fast', agent_mode: true,
      tool_calls: [{ tool: 'write_file', params: { path: 'Acceptance-Live/Recall/recall-check.md', content: '# Recall verification\n\nThis artifact verifies that a second work session can use shared memory.\n' } }]
    });
    report.checks.work_recall = /WA-MEMORY-2026/i.test(recalled.output) && /(Chinese|中文)/i.test(recalled.output);
    report.checks.work_artifacts = fs.existsSync(path.join(artifactRoot, 'Seed', 'office-note.md')) && fs.existsSync(path.join(artifactRoot, 'Recall', 'recall-check.md'));
    const workSessions = await Promise.all([api('/api/sessions/' + first.id), api('/api/sessions/' + second.id)]);
    report.checks.work_archives_inside_root = workSessions.every((session) => {
      const relative = path.relative(workRoot, session.work_archive_path || '');
      return relative && !relative.startsWith('..') && !path.isAbsolute(relative);
    });

    const chat = await api('/api/sessions', { method: 'POST', body: { title: 'WebAgent TEST chat visual policy', mode: 'chat', model: 'deepseek.fast' } });
    report.sessions.push(chat.id);
    const visual = await run(chat, {
      prompt: 'Return exactly three fenced examples: a wa-plot block for sin(x), a mermaid flowchart A-->B, and a typst block whose first line is // @plot and whose body is #line(length: 20pt). Do not call tools.',
      model: 'deepseek.fast', agent_mode: true,
      tool_calls: [{ tool: 'write_file', params: { path: 'CHAT-MUST-NOT-WRITE.txt', content: 'policy failure' } }]
    });
    const eventFile = path.join(os.homedir(), '.webagent', 'runtime-v2', 'sessions', chat.id, 'events.ndjson');
    const events = fs.existsSync(eventFile) ? fs.readFileSync(eventFile, 'utf8').trim().split(/\r?\n/).filter(Boolean).map(JSON.parse) : [];
    report.checks.chat_tool_events = events.filter((event) => event.type.startsWith('tool_call.')).length;
    report.checks.chat_visual_protocols = ['```wa-plot', '```mermaid', '```typst'].every((marker) => visual.output.toLowerCase().includes(marker));
    report.checks.chat_write_blocked = !fs.existsSync(path.join(workRoot, 'CHAT-MUST-NOT-WRITE.txt')) && !fs.existsSync(path.join(process.cwd(), 'CHAT-MUST-NOT-WRITE.txt'));

    if (!report.checks.work_recall || !report.checks.work_artifacts || !report.checks.work_archives_inside_root || report.checks.chat_tool_events !== 0 || !report.checks.chat_visual_protocols || !report.checks.chat_write_blocked) throw new Error('Mode acceptance assertions failed');
    for (const sessionId of report.sessions.slice().reverse()) await permanentDelete(sessionId);
    report.cleaned = true;
  } finally {
    if (!report.cleaned) {
      for (const sessionId of report.sessions.slice().reverse()) {
        try { await permanentDelete(sessionId); } catch (_) {}
      }
    }
    if (fs.existsSync(artifactRoot)) fs.rmSync(artifactRoot, { recursive: true, force: true });
    for (const [file, state] of before) restore(file, state);
  }
}

main().catch((error) => { report.error = { message: error.message, stack: error.stack }; process.exitCode = 1; }).finally(() => {
  report.completed_at = new Date().toISOString();
  const target = path.join(__dirname, '..', 'test-results', 'live-modes-acceptance.json');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, JSON.stringify(report, null, 2), 'utf8');
  console.log(JSON.stringify(report, null, 2));
});
