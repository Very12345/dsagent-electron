'use strict';

const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');
const { id } = require('./ids');
const { normalizeMode, DEFAULT_WORK_ROOT } = require('./mode-policy');

function normalizeModel(model) {
  const id = String(model || '');
  return ['deepseek.fast', 'deepseek.expert', 'deepseek.image', 'deepseek.flash.web', 'deepseek.pro.web', 'deepseek.vision.web'].includes(id) ? 'deepseek.web' : (id || 'deepseek.web');
}

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

class SessionStore extends EventEmitter {
  constructor(rootDir) {
    super();
    this.rootDir = path.resolve(rootDir);
    this.sessionsDir = path.join(this.rootDir, 'sessions');
    this.cache = new Map();
    this.events = new Map();
  }

  init() {
    fs.mkdirSync(this.sessionsDir, { recursive: true });
    for (const entry of fs.readdirSync(this.sessionsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const sessionId = entry.name;
      const snapshot = this._snapshotPath(sessionId);
      try {
        const session = JSON.parse(fs.readFileSync(snapshot, 'utf8'));
        this.cache.set(sessionId, this._normalize(session));
        this.events.set(sessionId, this._readEvents(sessionId));
      } catch (_) {
        // A damaged session is isolated; other sessions remain available.
      }
    }
    return this;
  }

  create(input) {
    const now = new Date().toISOString();
    const mode = normalizeMode(input && input.mode);
    const session = {
      id: input && input.id || id('sess'),
      title: input && input.title || '新会话',
      mode,
      project_id: input && input.project_id || null,
      workspace: mode === 'work' ? (input && (input.workspace || input.work_root) || DEFAULT_WORK_ROOT) : (input && input.workspace || ''),
      work_root: mode === 'work' ? (input && (input.work_root || input.workspace) || DEFAULT_WORK_ROOT) : '',
      work_archive_path: input && input.work_archive_path || '',
      model: normalizeModel(input && input.model),
      title_mode: input && input.title_mode === 'user' ? 'user' : 'auto',
      remote_title: input && input.remote_title || '',
      deleted_at: null,
      hidden: !!(input && input.hidden),
      ephemeral: !!(input && input.ephemeral),
      integration_origin: input && input.integration_origin || '',
      external_session_id: input && input.external_session_id || '',
      parent_session_id: input && input.parent_session_id || null,
      parent_run_id: input && input.parent_run_id || null,
      messages: [],
      provider_state: { conversations: [] },
      context_state: {
        estimated_tokens: 0,
        context_window: 0,
        window_source: '',
        generation: 0,
        summaries: [],
        compacted_through_message_id: null
      },
      created_at: now,
      updated_at: now,
      version: 1
    };
    if (this.cache.has(session.id)) throw Object.assign(new Error('Session already exists'), { code: 'session_exists' });
    fs.mkdirSync(this._dir(session.id), { recursive: true });
    this.cache.set(session.id, session);
    this.events.set(session.id, []);
    this._writeSnapshot(session);
    return this._withMeta(session);
  }

  list(options) {
    const includeHidden = !!(options && options.includeHidden);
    const includeDeleted = !!(options && options.includeDeleted);
    const deletedOnly = !!(options && options.deletedOnly);
    const projectId = options && options.projectId;
    return Array.from(this.cache.values())
      .filter((session) => includeHidden || !session.hidden)
      .filter((session) => deletedOnly ? !!session.deleted_at : includeDeleted || !session.deleted_at)
      .filter((session) => !projectId || session.project_id === projectId)
      .sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)))
      .map((session) => this._withMeta(session));
  }

  get(sessionId) {
    const value = this.cache.get(sessionId);
    return value ? this._withMeta(value) : null;
  }

  update(sessionId, patch) {
    const current = this.cache.get(sessionId);
    if (!current) throw Object.assign(new Error('Session not found'), { code: 'session_not_found' });
    const normalizedPatch = clone(patch || {});
    if (normalizedPatch.mode && normalizeMode(normalizedPatch.mode) !== current.mode && current.messages.length) {
      throw Object.assign(new Error('A session with messages cannot change mode in place; create a converted session instead'), { code: 'session_mode_locked', status: 409 });
    }
    if (normalizedPatch.mode) normalizedPatch.mode = normalizeMode(normalizedPatch.mode);
    if (normalizedPatch.mode === 'work' && !normalizedPatch.workspace) normalizedPatch.workspace = current.workspace || DEFAULT_WORK_ROOT;
    if (Object.prototype.hasOwnProperty.call(normalizedPatch, 'title') && normalizedPatch.title_mode == null) normalizedPatch.title_mode = 'user';
    const next = this._normalize(Object.assign({}, current, normalizedPatch, {
      id: current.id,
      messages: patch && patch.messages ? clone(patch.messages) : current.messages,
      updated_at: new Date().toISOString(),
      version: (current.version || 0) + 1
    }));
    this.cache.set(sessionId, next);
    this._writeSnapshot(next);
    this.emit('session.updated', clone(next));
    return this._withMeta(next);
  }

  appendMessage(sessionId, message) {
    const current = this.cache.get(sessionId);
    if (!current) throw Object.assign(new Error('Session not found'), { code: 'session_not_found' });
    const messages = current.messages.concat([Object.assign({
      id: id('msg'),
      created_at: new Date().toISOString()
    }, clone(message))]);
    return this.update(sessionId, { messages });
  }

  appendEvent(sessionId, event) {
    const current = this.cache.get(sessionId);
    if (!current) throw Object.assign(new Error('Session not found'), { code: 'session_not_found' });
    const list = this.events.get(sessionId) || [];
    const full = Object.assign({
      id: id('evt'),
      session_id: sessionId,
      seq: list.length ? list[list.length - 1].seq + 1 : 1,
      created_at: new Date().toISOString()
    }, clone(event));
    list.push(full);
    this.events.set(sessionId, list);
    fs.appendFileSync(this._eventsPath(sessionId), JSON.stringify(full) + '\n', 'utf8');
    this.emit('event', clone(full));
    return clone(full);
  }

  getEvents(sessionId, afterSeq) {
    return (this.events.get(sessionId) || [])
      .filter((event) => event.seq > (Number(afterSeq) || 0))
      .map(clone);
  }

  trash(sessionId) {
    const current = this.cache.get(sessionId);
    if (!current) return false;
    if (current.deleted_at) return this._withMeta(current);
    return this.update(sessionId, { deleted_at: new Date().toISOString() });
  }

  restore(sessionId) {
    const current = this.cache.get(sessionId);
    if (!current) return false;
    return this.update(sessionId, { deleted_at: null });
  }

  delete(sessionId, options) {
    if (!(options && options.permanent)) return this.trash(sessionId);
    if (!this.cache.has(sessionId)) return false;
    this.cache.delete(sessionId);
    this.events.delete(sessionId);
    fs.rmSync(this._dir(sessionId), { recursive: true, force: true });
    this.emit('session.deleted', sessionId);
    return true;
  }

  syncRemoteTitle(sessionId, title) {
    const current = this.cache.get(sessionId);
    const clean = String(title || '').replace(/\s+/g, ' ').trim().slice(0, 120);
    if (!current || !clean) return current ? this._withMeta(current) : null;
    if (current.title_mode === 'user') {
      if (current.remote_title === clean) return this._withMeta(current);
      return this.update(sessionId, { remote_title: clean, title_mode: 'user' });
    }
    if (current.title === clean && current.remote_title === clean) return this._withMeta(current);
    return this.update(sessionId, { title: clean, remote_title: clean, title_mode: 'auto' });
  }

  _dir(sessionId) { return path.join(this.sessionsDir, sessionId); }
  _snapshotPath(sessionId) { return path.join(this._dir(sessionId), 'session.json'); }
  _eventsPath(sessionId) { return path.join(this._dir(sessionId), 'events.ndjson'); }

  _readEvents(sessionId) {
    const eventFile = this._eventsPath(sessionId);
    if (!fs.existsSync(eventFile)) return [];
    return fs.readFileSync(eventFile, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  }

  _writeSnapshot(session) {
    const target = this._snapshotPath(session.id);
    const temporary = target + '.tmp-' + process.pid;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(temporary, JSON.stringify(session, null, 2), 'utf8');
    fs.renameSync(temporary, target);
  }

  _withMeta(session) {
    const result = clone(session);
    const events = this.events.get(session.id) || [];
    result.last_event_seq = events.length ? events[events.length - 1].seq : 0;
    return result;
  }

  _normalize(session) {
    const normalized = Object.assign({
      mode: 'chat', project_id: null, workspace: '', title_mode: 'auto', remote_title: '', deleted_at: null,
      work_root: '', work_archive_path: '', context_state: {},
      hidden: false, ephemeral: false, integration_origin: '', external_session_id: '',
      parent_session_id: null, parent_run_id: null, provider_state: { conversations: [] }, messages: []
    }, session || {});
    normalized.mode = normalizeMode(normalized.mode);
    normalized.model = normalizeModel(normalized.model);
    if (normalized.mode === 'work') {
      normalized.workspace = normalized.workspace || normalized.work_root || DEFAULT_WORK_ROOT;
      normalized.work_root = normalized.work_root || normalized.workspace;
    }
    normalized.provider_state = Object.assign({ conversations: [] }, normalized.provider_state || {});
    if (!Array.isArray(normalized.provider_state.conversations)) normalized.provider_state.conversations = [];
    normalized.context_state = Object.assign({ estimated_tokens: 0, context_window: 0, window_source: '', generation: 0, summaries: [], compacted_through_message_id: null }, normalized.context_state || {});
    if (!Array.isArray(normalized.context_state.summaries)) normalized.context_state.summaries = [];
    return normalized;
  }
}

module.exports = { SessionStore };
