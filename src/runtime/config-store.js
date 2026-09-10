'use strict';

const fs = require('fs');
const path = require('path');
const { id } = require('./ids');

const DEFAULT_CLUSTERS = [
  { id: 'code-delivery', name: '代码交付', description: '规划、实现与审查协作', strategy: 'review', max_parallel: 3, max_depth: 3, timeout_ms: 300000, roles: [
    { id: 'planner', name: '规划', model: '', tools: ['read_file', 'list_directory', 'rg', 'glob'] },
    { id: 'implementer', name: '实现', model: '', tools: ['read_file', 'apply_patch', 'exec_command'] },
    { id: 'reviewer', name: '审查', model: '', tools: ['read_file', 'rg', 'git_diff'] }
  ] },
  { id: 'research-synthesis', name: '研究汇总', description: '并行检索并交叉验证', strategy: 'parallel', max_parallel: 4, max_depth: 2, timeout_ms: 300000, roles: [
    { id: 'researcher', name: '研究', model: '', tools: ['web_search', 'read_file'] },
    { id: 'synthesizer', name: '汇总', model: '', tools: ['read_file'] }
  ] },
  { id: 'plan-implement-review', name: '规划-实现-评审', description: '顺序完成工程任务', strategy: 'sequential', max_parallel: 2, max_depth: 3, timeout_ms: 300000, roles: [] },
  { id: 'incident-diagnosis', name: '故障诊断', description: '日志、代码和运行状态联合诊断', strategy: 'parallel', max_parallel: 4, max_depth: 2, timeout_ms: 240000, roles: [] },
  { id: 'visual-creative', name: '视觉创作', description: '视觉分析、生成与验收', strategy: 'review', max_parallel: 3, max_depth: 2, timeout_ms: 360000, roles: [] }
];

const DEFAULT_SETTINGS = {
  appearance: { theme: 'dark', density: 'compact' },
  runtime: { qwen_max_workers: 8, chatgpt_max_workers: 2, max_tool_rounds: 20 },
  tools: { policy: 'risk_based', workspace_write: 'allow', command: 'ask', network: 'ask', delete: 'ask', git_write: 'ask' },
  mobile: { enabled: false, port: 5860, tunnel: false },
  agents: { default_cluster_id: 'code-delivery' }
  ,web_search: { endpoint: '', api_key: '' }
};

function clone(value) { return value == null ? value : JSON.parse(JSON.stringify(value)); }
function merge(base, patch) {
  const out = Object.assign({}, base || {});
  for (const [key, value] of Object.entries(patch || {})) {
    out[key] = value && typeof value === 'object' && !Array.isArray(value)
      ? merge(out[key] && typeof out[key] === 'object' ? out[key] : {}, value)
      : clone(value);
  }
  return out;
}

class RuntimeConfigStore {
  constructor(rootDir) {
    this.rootDir = path.resolve(rootDir);
    this.file = path.join(this.rootDir, 'runtime-config.json');
    this.state = null;
  }

  init() {
    let loaded = null;
    try { loaded = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch (_) {}
    this.state = merge({
      version: 2,
      projects: [],
      settings: { user: clone(DEFAULT_SETTINGS), projects: {} },
      agents: [],
      clusters: clone(DEFAULT_CLUSTERS),
      bots: [],
      devices: [],
      audit: []
    }, loaded || {});
    this._save();
    return this;
  }

  list(collection) { return clone(this._collection(collection)); }
  get(collection, itemId) { return clone(this._collection(collection).find((item) => item.id === itemId) || null); }

  create(collection, input) {
    const list = this._collection(collection);
    const now = new Date().toISOString();
    const normalized = clone(input || {});
    if (collection === 'projects') {
      const workspace = path.resolve(String(normalized.workspace || ''));
      if (!normalized.workspace || !fs.existsSync(workspace) || !fs.statSync(workspace).isDirectory()) throw Object.assign(new Error('Project workspace must be an existing directory'), { code: 'project_workspace_invalid', status: 400 });
      if (list.some((entry) => String(entry.workspace).toLowerCase() === workspace.toLowerCase())) throw Object.assign(new Error('Project already exists for this workspace'), { code: 'project_exists', status: 409 });
      normalized.workspace = workspace;
      normalized.name = String(normalized.name || path.basename(workspace)).trim().slice(0, 100);
    }
    const item = Object.assign({}, normalized, {
      id: input && input.id || id(collection.slice(0, 4)),
      created_at: input && input.created_at || now,
      updated_at: now
    });
    if (list.some((entry) => entry.id === item.id)) throw Object.assign(new Error('Item already exists'), { code: 'item_exists', status: 409 });
    list.push(item);
    this._save();
    return clone(item);
  }

  update(collection, itemId, patch) {
    const list = this._collection(collection);
    const index = list.findIndex((item) => item.id === itemId);
    if (index < 0) throw Object.assign(new Error('Item not found'), { code: 'item_not_found', status: 404 });
    list[index] = Object.assign({}, list[index], clone(patch || {}), { id: itemId, updated_at: new Date().toISOString() });
    this._save();
    return clone(list[index]);
  }

  delete(collection, itemId) {
    const list = this._collection(collection);
    const index = list.findIndex((item) => item.id === itemId);
    if (index < 0) return false;
    list.splice(index, 1);
    this._save();
    return true;
  }

  getSettings(projectId) {
    const project = projectId && this.state.settings.projects[projectId] || {};
    return merge(this.state.settings.user, project);
  }

  patchSettings(scope, projectId, patch) {
    if (scope === 'project') {
      if (!projectId) throw Object.assign(new Error('project_id is required'), { code: 'invalid_request', status: 400 });
      this.state.settings.projects[projectId] = merge(this.state.settings.projects[projectId] || {}, patch || {});
    } else {
      this.state.settings.user = merge(this.state.settings.user, patch || {});
    }
    this._save();
    return this.getSettings(projectId);
  }

  audit(type, data) {
    this.state.audit.push({ id: id('audit'), type, data: clone(data || {}), created_at: new Date().toISOString() });
    if (this.state.audit.length > 2000) this.state.audit.splice(0, this.state.audit.length - 2000);
    this._save();
  }

  _collection(name) {
    if (!['projects', 'agents', 'clusters', 'bots', 'devices', 'audit'].includes(name)) throw Object.assign(new Error('Unknown collection'), { code: 'invalid_collection', status: 400 });
    return this.state[name];
  }

  _save() {
    fs.mkdirSync(this.rootDir, { recursive: true });
    const temporary = this.file + '.tmp-' + process.pid;
    fs.writeFileSync(temporary, JSON.stringify(this.state, null, 2), 'utf8');
    fs.renameSync(temporary, this.file);
  }
}

module.exports = { RuntimeConfigStore, DEFAULT_SETTINGS, DEFAULT_CLUSTERS };
