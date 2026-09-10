#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const readline = require('readline');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const INFO_FILES = [path.join(os.homedir(), '.webagent', 'runtime.json'), path.join(os.homedir(), '.dsa', 'runtime.json')];

function parseArgs(argv) {
  const args = { prompt: '', model: '', session: '', mode: 'chat', project: '', workRoot: '', reasoningEffort: 'none', json: false, list: false };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '-p' || value === '--prompt') args.prompt = argv[++index] || '';
    else if (value === '-m' || value === '--model') args.model = argv[++index] || '';
    else if (value === '-s' || value === '--session') args.session = argv[++index] || '';
    else if (value === '--mode') args.mode = argv[++index] || 'chat';
    else if (value === '--project') { args.project = argv[++index] || ''; args.mode = 'project'; }
    else if (value === '--work-root') { args.workRoot = argv[++index] || ''; args.mode = 'work'; }
    else if (value === '--reasoning-effort') args.reasoningEffort = String(argv[++index] || 'none').toLowerCase();
    else if (value === '--deep-think') args.reasoningEffort = 'low';
    else if (value === '--json') args.json = true;
    else if (value === '--list' || value === '--sessions') args.list = true;
    else if (value === '-h' || value === '--help') args.help = true;
    else if (!args.prompt) args.prompt = value;
  }
  if (!['chat', 'project', 'work'].includes(args.mode)) throw new Error('Invalid --mode; expected chat, project, or work');
  if (!['none', 'low', 'medium', 'high', 'xhigh', 'max', 'auto'].includes(args.reasoningEffort)) throw new Error('Invalid --reasoning-effort; expected none, low, medium, high, xhigh, max, or auto');
  return args;
}

function readInfo() {
  for (const file of INFO_FILES) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) {}
  }
  return null;
}

function rawRequest(info, route, options) {
  options = options || {};
  return new Promise((resolve, reject) => {
    const body = options.body == null ? null : JSON.stringify(options.body);
    const request = http.request({
      hostname: '127.0.0.1', port: info.port, path: route, method: options.method || (body ? 'POST' : 'GET'),
      headers: Object.assign({ Authorization: 'Bearer ' + info.token, 'Content-Type': 'application/json' }, body ? { 'Content-Length': Buffer.byteLength(body) } : {})
    }, (response) => {
      let raw = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { raw += chunk; });
      response.on('end', () => {
        let data = null;
        try { data = raw ? JSON.parse(raw) : null; } catch (_) { data = raw; }
        if (response.statusCode >= 400) reject(Object.assign(new Error(data && data.error && data.error.message || 'HTTP ' + response.statusCode), { status: response.statusCode, data }));
        else resolve({ status: response.statusCode, data, headers: response.headers });
      });
    });
    request.setTimeout(options.timeout || 10000, () => request.destroy(new Error('Runtime request timeout')));
    request.on('error', reject);
    if (body) request.write(body);
    request.end();
  });
}

async function healthy(info) {
  if (!info || !info.port || !info.token) return false;
  try { const result = await rawRequest(info, '/api/ping', { timeout: 800 }); return !!(result.data && result.data.ok); } catch (_) { return false; }
}

function findRuntimeLauncher() {
  const daemon = path.join(ROOT, 'src', 'node', 'daemon.js');
  if (fs.existsSync(daemon)) return { executable: process.execPath, args: [daemon, '--runtime-only'] };
  const candidates = process.platform === 'win32'
    ? [path.join(__dirname, '..', '..', 'webagent-runtime.exe'), path.join(__dirname, '..', '..', 'WebAgent.exe')]
    : [path.join(__dirname, '..', '..', 'webagent-runtime'), path.join(__dirname, '..', '..', 'webagent')];
  const executable = candidates.find((candidate) => fs.existsSync(candidate));
  return executable ? { executable, args: ['--runtime-only'] } : null;
}

async function ensureRuntime() {
  let info = readInfo();
  if (await healthy(info)) return info;
  const launcher = findRuntimeLauncher();
  if (!launcher) throw new Error('WebAgent Node Runtime not found. Run npm install in the project first.');
  const child = spawn(launcher.executable, launcher.args, { detached: true, stdio: 'ignore', windowsHide: true, env: Object.assign({}, process.env, { WEBAGENT_RUNTIME_ONLY: '1' }) });
  child.unref();
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 400));
    info = readInfo();
    if (await healthy(info)) return info;
  }
  throw new Error('WebAgent Runtime startup timed out');
}

async function listSessions(info, asJson) {
  const result = await rawRequest(info, '/api/sessions');
  if (asJson) return console.log(JSON.stringify(result.data, null, 2));
  for (const session of result.data.data) console.log([session.id, session.mode, session.model, session.title].join('\t'));
}

async function createSession(info, args, title) {
  let projectId = null;
  let workspace = '';
  if (args.mode === 'project') {
    workspace = path.resolve(args.project || process.cwd());
    const projects = await rawRequest(info, '/api/projects');
    let project = (projects.data.data || []).find((item) => path.resolve(item.workspace) === workspace);
    if (!project) project = (await rawRequest(info, '/api/projects', { method: 'POST', body: { name: path.basename(workspace), workspace } })).data;
    projectId = project.id;
  } else if (args.mode === 'work') workspace = path.resolve(args.workRoot || 'D:\\Work\\WAWorkSpace');
  const result = await rawRequest(info, '/api/sessions', {
    method: 'POST',
    body: { model: args.model || 'deepseek.fast', title: title || 'WebAgent CLI', mode: args.mode, project_id: projectId, workspace, work_root: args.workRoot || undefined }
  });
  return result.data;
}

async function runPrompt(info, session, prompt, model, reasoningEffort, asJson) {
  const started = await rawRequest(info, '/api/sessions/' + encodeURIComponent(session.id) + '/runs', { method: 'POST', body: { prompt, model: model || session.model, agent_mode: session.mode !== 'chat', deep_think: reasoningEffort !== 'none', reasoning_effort: reasoningEffort }, timeout: 15000 });
  const runId = started.data.id;
  if (!asJson) process.stdout.write('\n');
  await new Promise((resolve, reject) => {
    const request = http.request({ hostname: '127.0.0.1', port: info.port, path: '/api/sessions/' + encodeURIComponent(session.id) + '/events?after=0', headers: { Authorization: 'Bearer ' + info.token, Accept: 'text/event-stream' } });
    let buffer = '';
    request.on('response', (response) => {
      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        buffer += chunk;
        let boundary;
        while ((boundary = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
          const line = block.split(/\r?\n/).find((item) => item.startsWith('data: '));
          if (!line) continue;
          let event;
          try { event = JSON.parse(line.slice(6)); } catch (_) { continue; }
          if (event.run_id !== runId) continue;
          if (asJson) console.log(JSON.stringify(event));
          else if (event.type === 'response.output_text.delta') process.stdout.write(event.data.delta || '');
          else if (event.type === 'tool_call.started') process.stderr.write('\n[tool] ' + event.data.tool + '\n');
          else if (event.type === 'subagent.started') process.stderr.write('\n[subagent] ' + event.data.template + '\n');
          if (/run\.(completed|failed|cancelled)/.test(event.type)) { if (!asJson) process.stdout.write('\n'); request.destroy(); resolve(); }
        }
      });
    });
    request.on('error', (error) => error.code === 'ECONNRESET' ? resolve() : reject(error));
    request.end();
  });
}

async function interactive(info, args) {
  let session = args.session ? (await rawRequest(info, '/api/sessions/' + encodeURIComponent(args.session))).data : await createSession(info, args, 'WebAgent CLI');
  console.log('WebAgent CLI · ' + session.mode + ' · session ' + session.id);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: 'webagent> ' });
  rl.prompt();
  for await (const line of rl) {
    const input = line.trim();
    if (!input) { rl.prompt(); continue; }
    if (input === '/exit' || input === '/quit') break;
    if (input === '/help') console.log('/sessions list sessions\n/new create a session\n/use <id> switch session\n/exit quit');
    else if (input === '/sessions') await listSessions(info, false);
    else if (input === '/new') { session = await createSession(info, args, 'WebAgent CLI'); console.log('Created ' + session.id); }
    else if (input.startsWith('/use ')) { session = (await rawRequest(info, '/api/sessions/' + encodeURIComponent(input.slice(5).trim()))).data; console.log('Using ' + session.id); }
    else await runPrompt(info, session, input, args.model, args.reasoningEffort, false);
    rl.prompt();
  }
  rl.close();
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) return console.log('webagent [-p prompt] [-m model] [-s session] [--mode chat|project|work] [--project path] [--work-root path] [--reasoning-effort none|low|medium|high|xhigh|max|auto] [--list] [--json]');
  const info = await ensureRuntime();
  if (args.list) return listSessions(info, args.json);
  if (args.prompt) {
    const session = args.session ? (await rawRequest(info, '/api/sessions/' + encodeURIComponent(args.session))).data : await createSession(info, args, args.prompt.slice(0, 48));
    return runPrompt(info, session, args.prompt, args.model, args.reasoningEffort, args.json);
  }
  return interactive(info, args);
}

main().catch((error) => { console.error('webagent:', error.message); process.exitCode = 1; });
