'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DEFAULT_WORK_ROOT, isInside } = require('./mode-policy');

const SECRET_PATTERNS = [
  /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{12,}\b/g,
  /\b(?:password|passwd|token|secret|cookie|private[_ -]?key)\s*[:=]\s*[^\s,;]+/gi,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g
];

function redact(value) {
  let text = String(value || '');
  for (const pattern of SECRET_PATTERNS) text = text.replace(pattern, '[REDACTED]');
  return text.slice(0, 6000);
}

function slug(value) {
  return String(value || 'work').replace(/[<>:"/\\|?*\x00-\x1f]/g, '-').replace(/\s+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'work';
}

function dateStamp(date) { return new Date(date || Date.now()).toISOString().slice(0, 10); }

function atomicJson(target, value) {
  const temporary = target + '.tmp-' + process.pid;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2), 'utf8');
  fs.renameSync(temporary, target);
}

class WorkMemoryService {
  constructor(options) {
    this.defaultRoot = path.resolve(options && options.defaultRoot || DEFAULT_WORK_ROOT);
  }

  init(root) {
    const workspace = path.resolve(root || this.defaultRoot);
    fs.mkdirSync(path.join(workspace, 'memory'), { recursive: true });
    fs.mkdirSync(path.join(workspace, 'skills'), { recursive: true });
    fs.mkdirSync(path.join(workspace, '.webagent'), { recursive: true });
    const memoryFile = path.join(workspace, 'MEMORY.md');
    if (!fs.existsSync(memoryFile)) fs.writeFileSync(memoryFile, '# WebAgent 工作记忆\n\n', 'utf8');
    const indexFile = path.join(workspace, '.webagent', 'work-index.json');
    if (!fs.existsSync(indexFile)) atomicJson(indexFile, { version: 1, sessions: {}, artifacts: [] });
    return workspace;
  }

  resolveArchive(session, suggested) {
    const root = this.init(session.workspace || this.defaultRoot);
    const fallback = path.join(root, 'Inbox', dateStamp(), slug(session.title));
    const candidate = suggested ? path.resolve(root, suggested) : fallback;
    const archive = isInside(root, candidate) ? candidate : fallback;
    fs.mkdirSync(archive, { recursive: true });
    return archive;
  }

  recall(session, query, limit) {
    const root = this.init(session.workspace || this.defaultRoot);
    const files = [path.join(root, 'MEMORY.md'), path.join(root, 'memory', dateStamp() + '.md'), path.join(root, 'memory', dateStamp(Date.now() - 86400000) + '.md')];
    const terms = Array.from(new Set(String(query || '').toLowerCase().match(/[\p{L}\p{N}_-]{2,}/gu) || []));
    const entries = [];
    for (const file of files) {
      if (!fs.existsSync(file)) continue;
      for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
        const lower = line.toLowerCase();
        const score = terms.reduce((sum, term) => sum + (lower.includes(term) ? 2 : 0), 0) + (file.endsWith('MEMORY.md') ? 1 : 0);
        if (line.trim() && (score > 0 || terms.length === 0)) entries.push({ line, score, file });
      }
    }
    return entries.sort((a, b) => b.score - a.score).slice(0, Number(limit) || 12);
  }

  record(session, userText, assistantText) {
    const root = this.init(session.workspace || this.defaultRoot);
    const suggested = this._extractArchive(assistantText);
    const archive = this.resolveArchive(session, suggested || session.work_archive_path);
    const now = new Date().toISOString();
    const safeUser = redact(userText);
    const safeAssistant = redact(assistantText);
    const daily = path.join(root, 'memory', dateStamp() + '.md');
    const entry = `\n## ${now} · ${session.title}\n- session: ${session.id}\n- archive: ${path.relative(root, archive)}\n- request: ${safeUser.replace(/\s+/g, ' ').slice(0, 900)}\n- result: ${safeAssistant.replace(/\s+/g, ' ').slice(0, 1200)}\n`;
    fs.appendFileSync(daily, entry, 'utf8');
    this._promote(root, safeUser, safeAssistant, session);
    this._index(root, session, archive, now);
    return { archive, daily, memory: path.join(root, 'MEMORY.md') };
  }

  search(root, query, limit) {
    return this.recall({ workspace: root || this.defaultRoot }, query, limit).map((item) => Object.assign({}, item, { id: this._entryId(item.file, item.line) }));
  }

  updateMemory(root, content) {
    const workspace = this.init(root || this.defaultRoot);
    fs.writeFileSync(path.join(workspace, 'MEMORY.md'), redact(content), 'utf8');
    return true;
  }

  mutateEntry(root, entryId, action, content) {
    const workspace = this.init(root || this.defaultRoot);
    const files = [path.join(workspace, 'MEMORY.md')].concat(fs.readdirSync(path.join(workspace, 'memory')).filter((name) => name.endsWith('.md')).map((name) => path.join(workspace, 'memory', name)));
    for (const file of files) {
      const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
      const index = lines.findIndex((line) => this._entryId(file, line) === entryId);
      if (index < 0) continue;
      const original = lines[index];
      if (action === 'delete') lines.splice(index, 1);
      else if (action === 'edit') lines[index] = redact(content).replace(/[\r\n]+/g, ' ').slice(0, 1000);
      else if (action === 'pin') {
        const memoryFile = path.join(workspace, 'MEMORY.md');
        const pinned = original.replace(/^[-*]\s*/, '');
        fs.appendFileSync(memoryFile, `\n- ${pinned} <!-- pinned -->\n`, 'utf8');
        return { id: entryId, pinned: true, line: original };
      }
      fs.writeFileSync(file, lines.join('\n'), 'utf8');
      return { id: entryId, deleted: action === 'delete', line: action === 'edit' ? lines[index] : original };
    }
    throw Object.assign(new Error('Memory entry not found'), { code: 'memory_entry_not_found', status: 404 });
  }

  _extractArchive(text) {
    const match = String(text || '').match(/(?:work_archive_path|archive_path)\s*["']?\s*[:=]\s*["']([^"'\r\n]+)["']/i);
    return match ? match[1].trim() : '';
  }

  _entryId(file, line) { return crypto.createHash('sha1').update(path.resolve(file) + '\0' + line).digest('hex').slice(0, 20); }

  _promote(root, userText, assistantText, session) {
    const memoryFile = path.join(root, 'MEMORY.md');
    const existing = fs.readFileSync(memoryFile, 'utf8');
    const candidates = [];
    const joined = userText + '\n' + assistantText;
    for (const line of joined.split(/[\r\n]+/)) {
      const clean = line.trim();
      if (clean.length < 16 || clean.length > 360) continue;
      if (!/(偏好|以后|始终|默认|决定|规则|记住|prefer|always|default|decision|rule)/i.test(clean)) continue;
      const digest = crypto.createHash('sha1').update(clean.toLowerCase()).digest('hex').slice(0, 10);
      if (!existing.includes(`<!-- ${digest} -->`)) candidates.push(`- ${clean} <!-- ${digest} -->`);
    }
    if (candidates.length) fs.appendFileSync(memoryFile, `\n## 提炼记忆\n${candidates.slice(0, 8).join('\n')}\n`, 'utf8');
  }

  _index(root, session, archive, now) {
    const target = path.join(root, '.webagent', 'work-index.json');
    let index = { version: 1, sessions: {}, artifacts: [] };
    try { index = JSON.parse(fs.readFileSync(target, 'utf8')); } catch (_) {}
    index.sessions[session.id] = { title: session.title, archive_path: archive, updated_at: now };
    atomicJson(target, index);
  }
}

module.exports = { WorkMemoryService, redact };
