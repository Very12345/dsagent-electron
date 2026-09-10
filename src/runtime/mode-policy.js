'use strict';

const path = require('path');

const SESSION_MODES = new Set(['chat', 'project', 'work']);
const DEFAULT_WORK_ROOT = 'D:\\Work\\WAWorkSpace';

function normalizeMode(value) {
  return SESSION_MODES.has(value) ? value : 'chat';
}

function isInside(root, target) {
  const base = path.resolve(root);
  const resolved = path.resolve(target);
  const relative = path.relative(base, resolved);
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
}

function resolveModePolicy(session, input) {
  const mode = normalizeMode(session && session.mode);
  const requestedAgent = !input || input.agent_mode !== false;
  if (mode === 'chat') {
    return {
      mode,
      agentMode: false,
      tools: false,
      skills: false,
      subagents: false,
      memoryWrite: false,
      workspace: ''
    };
  }
  if (mode === 'project') {
    if (!session.project_id || !session.workspace) {
      throw Object.assign(new Error('Project sessions require a project and workspace'), { code: 'project_required', status: 400 });
    }
    return { mode, agentMode: requestedAgent, tools: requestedAgent, skills: requestedAgent, subagents: requestedAgent, memoryWrite: requestedAgent, workspace: session.workspace };
  }
  const workRoot = path.resolve(session.workspace || session.work_root || DEFAULT_WORK_ROOT);
  return { mode, agentMode: requestedAgent, tools: requestedAgent, skills: requestedAgent, subagents: requestedAgent, memoryWrite: true, workspace: workRoot };
}

module.exports = { SESSION_MODES, DEFAULT_WORK_ROOT, normalizeMode, resolveModePolicy, isInside };
