'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const skillEngine = require('../../skill-engine');
const pluginManager = require('../../plugin-manager');
const memoryStore = require('../../memory-store');
const { manager: mcpManager } = require('../../server-mcp');
const SUBAGENT_TEMPLATES = {
  'file-reader': { displayName: '文件阅读', description: '只读分析文件内容与结构' },
  'code-reviewer': { displayName: '代码审查', description: '检查缺陷、安全性、性能和可维护性' },
  'researcher': { displayName: '研究代理', description: '检索并整理外部信息' },
  'restricted-executor': { displayName: '受限执行', description: '按指定权限执行命令' },
  'planner': { displayName: '规划代理', description: '拆解任务并给出执行计划' }
};

const LOCAL_TOOLS = ['read', 'read_file', 'list', 'list_directory', 'exists', 'info', 'write_file', 'save', 'edit', 'edit_file', 'mkdir', 'exec', 'bash', 'grep', 'glob', 'memory_read', 'memory_append', 'use_skill', 'mcp'];

function simpleItem(id, label, description, kind) {
  return { id, label, description: description || '', kind: kind || 'item' };
}

class CapabilityService {
  constructor(options) {
    this.providers = options.providers;
    this.tools = options.tools || null;
    this.bots = options.bots || null;
    this.config = options.config || null;
  }

  list(group, workspace) {
    const root = path.resolve(workspace || process.cwd());
    if (group === 'files') {
      try {
        return fs.readdirSync(root, { withFileTypes: true }).slice(0, 500).map((entry) => simpleItem(entry.name, entry.name, entry.isDirectory() ? '目录' : '文件', entry.isDirectory() ? 'directory' : 'file'));
      } catch (error) { return [simpleItem('error', '无法读取工作区', error.message, 'error')]; }
    }
    if (group === 'agents') {
      const clusters = this.config ? this.config.list('clusters').map((item) => simpleItem(item.id, item.name, item.description, 'agent')) : [];
      return clusters.length ? clusters : Object.keys(SUBAGENT_TEMPLATES).map((name) => simpleItem(name, SUBAGENT_TEMPLATES[name].displayName || name, SUBAGENT_TEMPLATES[name].description || '', 'agent'));
    }
    if (group === 'tools') {
      const local = (this.tools ? this.tools.list().map((tool) => tool.id) : LOCAL_TOOLS).map((name) => simpleItem('local/' + name, name, '本地 Runtime 工具', 'tool'));
      const mcp = mcpManager.getAllTools().map((tool) => simpleItem((tool._mcpServer || 'mcp') + '/' + tool.name, tool.name, tool.description || '', 'mcp'));
      return local.concat(mcp);
    }
    if (group === 'plugins') {
      const skills = skillEngine.list(root).map((skill) => simpleItem('skill/' + skill.name, skill.name, skill.description || '', 'skill'));
      let plugins = [];
      try { plugins = pluginManager.getAllPluginInfo().map((plugin) => simpleItem('plugin/' + plugin.name, plugin.name, plugin.description || (plugin.installed ? '已安装' : '可安装'), 'plugin')); } catch (_) {}
      return skills.concat(plugins);
    }
    if (group === 'bots') {
      const platforms = this.bots ? this.bots.platforms() : [];
      return platforms.map((item) => simpleItem(item.id, item.name, item.configured ? '已配置' : '未配置', 'bot')).concat([simpleItem('intervals', 'Interval Tasks', '后台周期任务', 'task')]);
    }
    if (group === 'settings') {
      const status = this.providers.status();
      return [
        simpleItem('deepseek', 'DeepSeek Worker Pool', status.deepseek.active + '/' + status.deepseek.max + ' 活跃', 'provider'),
        simpleItem('qwen', '千问 Worker Pool', status.qwen.active + '/' + status.qwen.max + ' 活跃', 'provider'),
        simpleItem('chatgpt', 'ChatGPT Worker Pool', status.chatgpt.active + '/' + status.chatgpt.max + ' 活跃', 'provider'),
        ...this.providers.listModels().map((model) => simpleItem('model/' + model.id, model.displayName || model.id, model.owned_by || model.provider || '', 'model'))
      ];
    }
    return [];
  }

  tree(workspace, relativePath) {
    const root = path.resolve(workspace || process.cwd());
    const relative = String(relativePath || '').replace(/\\/g, '/');
    const target = path.resolve(root, relative);
    const boundary = path.relative(root, target);
    if (boundary.startsWith('..') || path.isAbsolute(boundary)) {
      const error = new Error('路径超出工作区');
      error.code = 'workspace_path_invalid';
      error.status = 400;
      throw error;
    }
    const entries = fs.readdirSync(target, { withFileTypes: true });
    return entries
      .filter((entry) => !entry.isSymbolicLink())
      .sort((left, right) => {
        if (left.isDirectory() !== right.isDirectory()) return left.isDirectory() ? -1 : 1;
        return left.name.localeCompare(right.name, 'zh-CN', { numeric: true, sensitivity: 'base' });
      })
      .slice(0, 1000)
      .map((entry) => {
        const itemPath = relative ? relative.replace(/\/$/, '') + '/' + entry.name : entry.name;
        return {
          id: itemPath,
          label: entry.name,
          path: itemPath,
          kind: entry.isDirectory() ? 'directory' : 'file'
        };
      });
  }

  readMemory(workspace) {
    return memoryStore.handleMemoryRead(path.resolve(workspace || process.cwd()));
  }

  appendMemory(workspace, scope, content) {
    return memoryStore.handleMemoryAppend(path.resolve(workspace || process.cwd()), scope, content);
  }

  listSkills(workspace) { return skillEngine.list(path.resolve(workspace || process.cwd())).map((item) => ({ name: item.name, description: item.description, allowed_tools: item.allowed_tools, user_invocable: item.user_invocable, source_path: item.source_path })); }
  addSkill(input) {
    const name = String(input.name || '').trim();
    if (!/^[a-zA-Z0-9._-]{1,80}$/.test(name)) throw Object.assign(new Error('Invalid skill name'), { code: 'skill_name_invalid', status: 400 });
    const base = input.scope === 'project' ? path.join(path.resolve(input.workspace || process.cwd()), '.webagent', 'skills') : path.join(os.homedir(), '.webagent', 'skills');
    const target = path.join(base, name); fs.mkdirSync(base, { recursive: true });
    if (fs.existsSync(target)) throw Object.assign(new Error('Skill already exists'), { code: 'skill_exists', status: 409 });
    if (input.source === 'git') execFileSync('git', ['clone', '--depth', '1', String(input.url || ''), target], { timeout: 120000, windowsHide: true });
    else if (input.source === 'local') fs.cpSync(path.resolve(String(input.path || '')), target, { recursive: true, force: false });
    else {
      fs.mkdirSync(target, { recursive: true });
      const frontmatter = ['---', 'name: ' + name, 'description: ' + String(input.description || ''), 'disable_model_invocation: false', 'user_invocable: true', 'allowed_tools: ' + JSON.stringify(input.allowed_tools || []), '---', '', String(input.content || '描述此技能的工作流程。')].join('\n');
      fs.writeFileSync(path.join(target, 'SKILL.md'), frontmatter, 'utf8');
    }
    if (!fs.existsSync(path.join(target, 'SKILL.md'))) throw Object.assign(new Error('Imported directory does not contain SKILL.md'), { code: 'skill_manifest_missing', status: 400 });
    skillEngine.refresh(path.resolve(input.workspace || process.cwd()));
    return { name, path: target };
  }
  deleteSkill(name, workspace, scope) {
    if (!/^[a-zA-Z0-9._-]{1,80}$/.test(String(name))) return false;
    const base = scope === 'project' ? path.join(path.resolve(workspace || process.cwd()), '.webagent', 'skills') : path.join(os.homedir(), '.webagent', 'skills');
    const target = path.join(base, name); if (!fs.existsSync(target)) return false; fs.rmSync(target, { recursive: true, force: false }); skillEngine.refresh(path.resolve(workspace || process.cwd())); return true;
  }
  listPlugins() { return pluginManager.getAllPluginInfo(); }
  installPlugin(input) { return pluginManager.installPlugin(input); }
  uninstallPlugin(name) { return pluginManager.uninstallPlugin(name); }
  marketplaces() { return pluginManager.listMarketplaces(); }
  addMarketplace(input) { return pluginManager.addMarketplace(input); }
}

module.exports = { CapabilityService, LOCAL_TOOLS };
