'use strict';

const fs = require('fs');
const path = require('path');
const { execFile, spawn } = require('child_process');
const skillEngine = require('../../skill-engine');
const memoryStore = require('../../memory-store');
const { manager: mcpManager } = require('../../server-mcp');

const processes = new Map();
let processSequence = 0;

function inside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
}

// A parser or provider may hand back the whole argument object wrapped in a
// single `params`/`arguments` key — {"params":{"path":"a.js"}} — because the
// Runtime system prompt teaches models the {"tool":..., "params":{...}} shape.
// Unwrap it once here so every tool sees flat arguments no matter which
// parser produced the call. Without this the tool silently received zero
// arguments (a missing path resolved to the workspace root and raised a
// misleading EISDIR), which made agents retry the same call forever.
function unwrapArguments(input) {
  let value = input;
  for (let depth = 0; depth < 2; depth += 1) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
    const keys = Object.keys(value);
    if (keys.length !== 1) return value;
    const key = keys[0];
    if (key !== 'params' && key !== 'arguments') return value;
    const inner = value[key];
    if (!inner || typeof inner !== 'object' || Array.isArray(inner)) return value;
    value = inner;
  }
  return value;
}

// Translate a workspace-relative glob into a RegExp. `**` spans directories,
// `*` stays inside one path segment, `?` matches a single character.
function globToRegExp(pattern) {
  const source = String(pattern || '**/*').replace(/\\/g, '/').replace(/^\.\//, '');
  let output = '';
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (character === '*') {
      if (source[index + 1] === '*') {
        index += 1;
        if (source[index + 1] === '/') index += 1;
        output += '(?:.*/)?';
      } else {
        output += '[^/]*';
      }
    } else if (character === '?') {
      output += '[^/]';
    } else {
      output += character.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp('^' + output + '$', 'i');
}

function createToolExecutor(options) {
  const workspace = path.resolve(options.workspace || process.cwd());
  const registry = options.registry || null;
  const projectId = options.projectId || null;

  function resolvePath(value) {
    const candidate = path.resolve(workspace, value || '.');
    if (!inside(workspace, candidate)) throw Object.assign(new Error('Path escapes workspace'), { code: 'path_outside_workspace' });
    return candidate;
  }

  // Resolve a required path parameter. Failing loudly here is deliberate:
  // silently falling back to the workspace root turned a missing argument
  // into "read a directory" and gave the model no way to recover.
  function requiredPath(params, names) {
    for (const name of names) {
      const value = params[name];
      if (typeof value === 'string' && value.trim()) return resolvePath(value);
    }
    throw Object.assign(new Error('Missing required parameter: ' + names[0]), { code: 'tool_missing_parameter' });
  }

  function run(command, timeout) {
    return new Promise((resolve) => {
      const shell = process.platform === 'win32' ? 'powershell.exe' : '/bin/sh';
      const args = process.platform === 'win32'
        ? ['-NoProfile', '-NonInteractive', '-Command', command]
        : ['-lc', command];
      execFile(shell, args, {
        cwd: workspace,
        timeout: Math.min(Math.max(Number(timeout) || 120000, 1000), 600000),
        windowsHide: true,
        maxBuffer: 10 * 1024 * 1024
      }, (error, stdout, stderr) => {
        resolve({
          success: !error,
          data: { stdout: stdout || '', stderr: stderr || '', exit_code: error && Number.isInteger(error.code) ? error.code : 0 },
          error: error ? error.message : null
        });
      });
    });
  }

  function runFile(command, args, timeout) {
    return new Promise((resolve) => execFile(command, args, { cwd: workspace, timeout: Math.min(Math.max(Number(timeout) || 120000, 1000), 600000), windowsHide: true, maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => resolve({
      success: !error, data: { stdout: stdout || '', stderr: stderr || '', exit_code: error && Number.isInteger(error.code) ? error.code : 0 }, error: error ? error.message : null
    })));
  }

  async function approval(name, params) {
    const manifest = registry && registry.get(name, projectId);
    if (!manifest || manifest.policy !== 'ask' || params.approved === true) return null;
    if (options.onAudit) options.onAudit('tool.approval_required', { tool: name, risk: manifest.risk });
    if (!options.requestApproval) return { success: false, error: 'Approval required for ' + name, code: 'approval_required', data: { tool: name, risk: manifest.risk } };
    const approved = await options.requestApproval({ tool: name, risk: manifest.risk, arguments: params });
    return approved ? null : { success: false, error: 'Approval denied for ' + name, code: 'approval_denied', data: { tool: name, risk: manifest.risk } };
  }

  async function execute(name, raw) {
    let params = raw || {};
    if (typeof params === 'string') {
      try { params = JSON.parse(params); } catch (_) { params = { content: params }; }
    }
    params = unwrapArguments(params) || {};
    try {
      name = registry ? registry.aliases(name) : ({ read: 'read_file', list: 'list_directory', grep: 'rg', exec: 'exec_command', bash: 'exec_command', save: 'write_file' })[name] || name;
      const approvalResult = await approval(name, params);
      if (approvalResult) return approvalResult;
      switch (name) {
        case 'read_file': {
          const file = requiredPath(params, ['path', 'file', 'file_path']);
          const content = fs.readFileSync(file, 'utf8');
          const lines = content.split(/\r?\n/);
          const start = Math.max(0, (Number(params.start) || 1) - 1);
          // `limit` is the equivalent of `end` expressed as a line count; models
          // reach for it constantly, and silently ignoring it returned the whole
          // file (a model explicitly flagged the discrepancy in a live run).
          const limit = Number(params.limit != null ? params.limit : params.count);
          const end = params.end
            ? Math.min(lines.length, Number(params.end))
            : Number.isFinite(limit) && limit > 0
              ? Math.min(lines.length, start + limit)
              : lines.length;
          return { success: true, data: { path: file, content: lines.slice(start, end).join('\n') } };
        }
        case 'list_directory': {
          const directory = resolvePath(params.path || '.');
          return { success: true, data: fs.readdirSync(directory, { withFileTypes: true }).map((entry) => ({ name: entry.name, type: entry.isDirectory() ? 'directory' : 'file' })) };
        }
        case 'exists':
          return { success: true, data: { exists: fs.existsSync(requiredPath(params, ['path', 'file', 'file_path'])) } };
        case 'info': {
          const file = requiredPath(params, ['path', 'file', 'file_path']);
          const stat = fs.statSync(file);
          return { success: true, data: { path: file, size: stat.size, directory: stat.isDirectory(), modified_at: stat.mtime.toISOString() } };
        }
        case 'write_file': {
          const file = requiredPath(params, ['path', 'file', 'file_path']);
          fs.mkdirSync(path.dirname(file), { recursive: true });
          fs.writeFileSync(file, String(params.content || ''), 'utf8');
          return { success: true, data: { path: file } };
        }
        case 'apply_patch': {
          const file = requiredPath(params, ['path', 'file', 'file_path']);
          if (params.content != null && !params.find && !params.search) {
            fs.mkdirSync(path.dirname(file), { recursive: true });
            fs.writeFileSync(file, String(params.content), 'utf8');
            return { success: true, data: { path: file, operation: 'write' } };
          }
          const source = fs.readFileSync(file, 'utf8');
          const find = String(params.find || params.search || '');
          if (!find) return { success: false, error: 'Missing find text' };
          const occurrences = source.split(find).length - 1;
          if (!occurrences) return { success: false, error: 'Find text not found' };
          if (occurrences > 1 && params.all !== true) return { success: false, error: 'Find text is not unique; pass all=true to replace every occurrence' };
          const next = params.all === true ? source.split(find).join(String(params.replace || '')) : source.replace(find, String(params.replace || ''));
          fs.writeFileSync(file, next, 'utf8');
          return { success: true, data: { path: file, replacements: params.all === true ? occurrences : 1 } };
        }
        case 'mkdir': {
          const directory = requiredPath(params, ['path', 'dir', 'directory']);
          fs.mkdirSync(directory, { recursive: true });
          return { success: true, data: { path: directory } };
        }
        case 'copy_path': {
          const source = requiredPath(params, ['source', 'from']); const target = requiredPath(params, ['target', 'to']);
          fs.cpSync(source, target, { recursive: true, force: false }); return { success: true, data: { source, target } };
        }
        case 'move_path': {
          const source = requiredPath(params, ['source', 'from']); const target = requiredPath(params, ['target', 'to']);
          fs.renameSync(source, target); return { success: true, data: { source, target } };
        }
        case 'delete_path': {
          const target = requiredPath(params, ['path', 'file', 'file_path']);
          if (target === workspace) return { success: false, error: 'Refusing to delete workspace root' };
          fs.rmSync(target, { recursive: !!params.recursive, force: false }); return { success: true, data: { path: target } };
        }
        case 'exec_command':
          return run(params.command || params.cmd || '', params.timeout);
        case 'start_process': {
          const shell = process.platform === 'win32' ? 'powershell.exe' : '/bin/sh';
          const args = process.platform === 'win32' ? ['-NoProfile', '-Command', params.command || ''] : ['-lc', params.command || ''];
          const child = spawn(shell, args, { cwd: workspace, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
          const processId = 'proc_' + (++processSequence); const state = { id: processId, child, stdout: '', stderr: '', exit_code: null };
          child.stdout.on('data', (chunk) => { state.stdout += chunk.toString(); if (state.stdout.length > 2e6) state.stdout = state.stdout.slice(-2e6); });
          child.stderr.on('data', (chunk) => { state.stderr += chunk.toString(); if (state.stderr.length > 2e6) state.stderr = state.stderr.slice(-2e6); });
          child.on('exit', (code) => { state.exit_code = code; }); processes.set(processId, state);
          return { success: true, data: { process_id: processId, pid: child.pid } };
        }
        case 'write_stdin': { const state = processes.get(params.process_id); if (!state) return { success: false, error: 'Process not found' }; state.child.stdin.write(String(params.data || '')); return { success: true, data: { process_id: state.id } }; }
        case 'wait_process': { const state = processes.get(params.process_id); if (!state) return { success: false, error: 'Process not found' }; if (state.exit_code == null) await new Promise((resolve) => { const timer = setTimeout(resolve, Math.min(Number(params.timeout) || 10000, 60000)); state.child.once('exit', () => { clearTimeout(timer); resolve(); }); }); return { success: true, data: { process_id: state.id, running: state.exit_code == null, exit_code: state.exit_code, stdout: state.stdout, stderr: state.stderr } }; }
        case 'terminate_process': { const state = processes.get(params.process_id); if (!state) return { success: false, error: 'Process not found' }; state.child.kill(); return { success: true, data: { process_id: state.id } }; }
        case 'rg': {
          const pattern = String(params.pattern || params.search || '');
          if (!pattern) return { success: false, error: 'Missing search pattern' };
          return runFile('rg', ['--line-number', '--color', 'never', '--glob', '!node_modules/**', pattern, resolvePath(params.path || '.')], params.timeout || 30000);
        }
        case 'find_symbols':
        case 'find_references': {
          const symbol = String(params.symbol || params.name || params.query || '');
          if (!symbol) return { success: false, error: 'Missing symbol' };
          return runFile('rg', ['--line-number', '--word-regexp', '--color', 'never', symbol, resolvePath(params.path || '.')], params.timeout || 30000);
        }
        case 'glob': {
          const rawPattern = String(params.pattern || '*').replace(/\\/g, '/').replace(/^\.\//, '');
          // Bare patterns such as "*.js" keep the historical behaviour of
          // matching at any depth. Patterns carrying a path ("src/**/*.js")
          // need real glob semantics: the old code compared the entire pattern
          // against the file name, so every such call silently returned [] and
          // agents burned rounds guessing why a directory of files looked empty.
          const simpleSuffix = rawPattern.includes('/') ? null : rawPattern.replace(/^\*+/, '');
          const matcher = simpleSuffix === null ? globToRegExp(rawPattern) : null;
          const base = resolvePath(params.path || '.');
          const results = [];
          const walk = (target) => {
            if (results.length >= 1000) return;
            for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
              if (['node_modules', '.git', 'dist'].includes(entry.name)) continue;
              const full = path.join(target, entry.name);
              if (entry.isDirectory()) { walk(full); continue; }
              if (matcher) {
                const relative = path.relative(base, full).replace(/\\/g, '/');
                if (matcher.test(relative)) results.push(full);
              } else if (!simpleSuffix || entry.name.endsWith(simpleSuffix)) {
                results.push(full);
              }
            }
          };
          walk(base);
          return { success: true, data: { files: results } };
        }
        case 'memory_read':
          return memoryStore.handleMemoryRead(workspace);
        case 'memory_append':
          return memoryStore.handleMemoryAppend(workspace, params.scope || 'project', params.content || '');
        case 'use_skill':
          {
            const result = skillEngine.execute(params.name, params.arguments || '', workspace, params.session_id || '');
            return result && result.success ? { success: true, data: result } : { success: false, error: result && result.error || 'Skill execution failed' };
          }
        case 'mcp': {
          const data = await mcpManager.callTool(params.server, params.tool, params.args || {});
          return { success: true, data };
        }
        case 'mcp_list_tools': return { success: true, data: mcpManager.getAllTools() };
        case 'mcp_list_resources': return { success: true, data: mcpManager.getAllResources() };
        case 'mcp_read_resource': return { success: true, data: await mcpManager.readResource(params.server, params.uri) };
        case 'mcp_get_prompt': return { success: true, data: await mcpManager.getPrompt(params.server, params.name, params.args || {}) };
        case 'web_search': {
          const settings = options.config && options.config.getSettings(projectId);
          const endpoint = String(params.endpoint || settings && settings.web_search && settings.web_search.endpoint || '');
          if (!endpoint) return { success: false, error: 'Web search endpoint is not configured', code: 'web_search_not_configured' };
          const target = new URL(endpoint); target.searchParams.set(params.query_param || 'q', String(params.query || ''));
          const response = await fetch(target, { headers: settings && settings.web_search && settings.web_search.api_key ? { Authorization: 'Bearer ' + settings.web_search.api_key } : {}, signal: AbortSignal.timeout(Math.min(Number(params.timeout) || 30000, 60000)) });
          return { success: response.ok, data: { status: response.status, body: (await response.text()).slice(0, 2 * 1024 * 1024) }, error: response.ok ? null : 'HTTP ' + response.status };
        }
        case 'browser_open': {
          const target = new URL(String(params.url || '')); if (!/^https?:$/.test(target.protocol)) return { success: false, error: 'Only HTTP(S) URLs are allowed' };
          const response = await fetch(target, { signal: AbortSignal.timeout(Math.min(Number(params.timeout) || 30000, 60000)) });
          return { success: response.ok, data: { url: response.url, status: response.status, content_type: response.headers.get('content-type'), text: (await response.text()).slice(0, 2 * 1024 * 1024) }, error: response.ok ? null : 'HTTP ' + response.status };
        }
        case 'browser_screenshot': return { success: false, error: 'Browser screenshot requires the desktop browser bridge', code: 'browser_bridge_required' };
        case 'git_status': return runFile('git', ['status', '--short', '--branch'], params.timeout);
        case 'git_diff': return runFile('git', ['diff'].concat(params.cached ? ['--cached'] : []).concat(params.path ? ['--', params.path] : []), params.timeout);
        case 'git_log': return runFile('git', ['log', '--oneline', '-n', String(Math.min(Number(params.limit) || 20, 200))], params.timeout);
        case 'git_branch': return runFile('git', params.create ? ['switch', '-c', params.create] : params.switch ? ['switch', params.switch] : ['branch', '--list'], params.timeout);
        case 'git_stage': return runFile('git', ['add', '--'].concat(Array.isArray(params.paths) ? params.paths : [params.path || '.']), params.timeout);
        case 'git_commit': return runFile('git', ['commit', '-m', String(params.message || '')], params.timeout);
        case 'git_worktree': return runFile('git', ['worktree'].concat(Array.isArray(params.args) ? params.args : ['list']), params.timeout);
        case 'view_image': { const file = requiredPath(params, ['path', 'file', 'file_path']); const stat = fs.statSync(file); return { success: true, data: { path: file, size: stat.size, mime: path.extname(file).slice(1).toLowerCase() } }; }
        case 'plan': return { success: true, data: { steps: Array.isArray(params.steps) ? params.steps : [], updated: true } };
        case 'interval': return { success: true, data: { scheduled: true, interval_ms: Number(params.interval_ms) || 0, task: params.task || '' } };
        case 'request_user_input': return { success: false, error: 'User input is required', code: 'user_input_required', data: params };
        default:
          return { success: false, error: 'Unknown tool: ' + name };
      }
    } catch (error) {
      return { success: false, error: error.message, code: error.code || 'tool_error' };
    }
  }

  return { execute, workspace };
}

module.exports = { createToolExecutor };
