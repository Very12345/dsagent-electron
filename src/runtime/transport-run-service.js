'use strict';

const EventEmitter = require('events');
const { id } = require('./ids');

const REASONING_EFFORTS = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'auto']);

function normalizeReasoningEffort(value, deepThink) {
  if (value == null || value === '') return deepThink ? 'high' : 'none';
  const effort = String(value).trim().toLowerCase();
  const normalized = { off: 'none', disabled: 'none', default: 'medium', enabled: 'medium' }[effort] || effort;
  return REASONING_EFFORTS.has(normalized) ? normalized : (deepThink ? 'high' : 'none');
}

function abortError() {
  return Object.assign(new Error('Run cancelled'), { name: 'AbortError', code: 'run_cancelled' });
}

class TransportRunService extends EventEmitter {
  constructor(options) {
    super();
    this.setMaxListeners(0);
    this.store = options.store;
    this.providers = options.providers;
    this.runs = new Map();
    this.sessionLocks = new Map();
    this.cancelGraceMs = Math.max(0, Math.min(15000, Number(options.cancelGraceMs ?? 5000) || 0));
  }

  getRun(runId) {
    const run = this.runs.get(runId);
    return run ? this._publicRun(run) : null;
  }

  activeRunForSession(sessionId) {
    const runId = this.sessionLocks.get(sessionId);
    return runId ? this.getRun(runId) : null;
  }

  async startRun(sessionId, input) {
    const session = this.store.get(sessionId);
    if (!session) throw Object.assign(new Error('Session not found'), { code: 'session_not_found', status: 404 });
    const lockedId = this.sessionLocks.get(sessionId);
    const locked = lockedId && this.runs.get(lockedId);
    if (locked && locked.controller.signal.aborted && locked.promise && this.cancelGraceMs) {
      await Promise.race([locked.promise.catch(() => {}), new Promise((resolve) => setTimeout(resolve, this.cancelGraceMs))]);
    }
    if (this.sessionLocks.has(sessionId)) throw Object.assign(new Error('Session already has an active run'), { code: 'session_busy', status: 409, run_id: this.sessionLocks.get(sessionId) });

    const messages = Array.isArray(input.messages) ? input.messages : [];
    if (messages.length && session.messages.length === 0) {
      for (const message of messages.slice(0, -1)) this.store.appendMessage(sessionId, {
        role: message.role,
        content: message.content,
        ...(message.name ? { name: message.name } : {}),
        ...(message.tool_call_id ? { tool_call_id: message.tool_call_id } : {}),
        ...(message.tool_calls ? { tool_calls: message.tool_calls } : {})
      });
    }
    const latestMessage = messages[messages.length - 1];
    const latest = input.prompt != null ? input.prompt : latestMessage ? latestMessage.content : input.input;
    if (latest == null) throw Object.assign(new Error('Missing run input'), { code: 'invalid_request', status: 400 });
    this.store.appendMessage(sessionId, {
      role: latestMessage && latestMessage.role || 'user',
      content: latest,
      ...(latestMessage && latestMessage.name ? { name: latestMessage.name } : {}),
      ...(latestMessage && latestMessage.tool_call_id ? { tool_call_id: latestMessage.tool_call_id } : {}),
      ...(latestMessage && latestMessage.tool_calls ? { tool_calls: latestMessage.tool_calls } : {})
    });

    const reasoningEffort = normalizeReasoningEffort(input.reasoning_effort || input.thinking_level, !!input.deep_think);
    const run = {
      id: input.run_id || id('run'),
      session_id: sessionId,
      parent_run_id: null,
      call_id: input.call_id || null,
      model: input.model || session.model,
      status: 'queued',
      mode: 'transport',
      agent_mode: false,
	  auxiliary_title: !!input.auxiliary_title,
      prompt_passthrough: !!input.prompt_passthrough,
      passthrough_messages: input.prompt_passthrough && messages.length ? JSON.parse(JSON.stringify(messages)) : null,
      provider_tools: Array.isArray(input.provider_tools) ? JSON.parse(JSON.stringify(input.provider_tools)) : [],
      instructions: input.prompt_passthrough ? '' : String(input.instructions || ''),
      deep_think: reasoningEffort !== 'none',
      reasoning_effort: reasoningEffort,
      web_search: String(input.model || session.model).startsWith('deepseek.') && !!input.web_search,
      timeout_ms: Math.max(60000, Math.min(30 * 60 * 1000, Number(input.timeout_ms) || 10 * 60 * 1000)),
      created_at: new Date().toISOString(),
      completed_at: null,
      output: '',
      reasoning: '',
      images: [],
      error: null,
      controller: new AbortController()
    };
    this.runs.set(run.id, run);
    this.sessionLocks.set(sessionId, run.id);
    this._event(run, 'run.created', { status: 'queued' });
    run.promise = this._execute(run).finally(() => {
      if (this.sessionLocks.get(sessionId) === run.id) this.sessionLocks.delete(sessionId);
    });
    return this._publicRun(run);
  }

  async waitForRun(runId) {
    const run = this.runs.get(runId);
    if (!run) throw Object.assign(new Error('Run not found'), { code: 'run_not_found', status: 404 });
    await run.promise;
    return this._publicRun(run);
  }

  async cancel(runId) {
    const run = this.runs.get(runId);
    if (!run) return false;
    run.controller.abort();
    this._event(run, 'run.cancelling', {});
    if (this.providers && this.providers.stop) await this.providers.stop({ model: run.model, run, session: this.store.get(run.session_id) }).catch(() => false);
    return true;
  }

  _progress(run, stream, field, type, value) {
    const text = String(value || '');
    if (text === stream[field]) return;
    if (text.startsWith(stream[field])) this._event(run, type + '.delta', { delta: text.slice(stream[field].length) });
    else this._event(run, type + '.replace', { text });
    stream[field] = text;
  }

  async _execute(run) {
    run.status = 'in_progress';
    this._event(run, 'run.in_progress', { status: run.status });
    const stream = { text: '', reasoning: '' };
    let terminal = 'completed';
    try {
      const session = this.store.get(run.session_id);
      const result = await this.providers.complete({
        model: run.model,
        session,
        messages: run.prompt_passthrough ? (run.passthrough_messages || session.messages) : session.messages,
        instructions: run.instructions,
        run,
        signal: run.controller.signal,
        timeout: run.timeout_ms,
        onAuthRequired: (provider) => this._event(run, 'provider.auth_required', { provider }),
        onAuthenticated: (provider) => this._event(run, 'provider.authenticated', { provider }),
        onProviderState: (providerState) => {
          this.store.update(run.session_id, { provider_state: providerState, model: run.model });
          this._event(run, 'provider.conversation_bound', { provider: providerState.provider, url: providerState.url, worker_id: providerState.last_worker_id, lease_id: providerState.last_lease_id });
        },
        onStatus: (text) => this._event(run, 'response.status', { text: String(text || '') }),
        onProgress: (text) => this._progress(run, stream, 'text', 'response.output_text', text),
        onReasoningProgress: (text) => this._progress(run, stream, 'reasoning', 'response.reasoning', text)
      });
      if (run.controller.signal.aborted) throw abortError();
      if (result.provider_state) this.store.update(run.session_id, { provider_state: result.provider_state, model: run.model });
      run.output = String(result.content || '');
      run.reasoning = String(result.reasoning || '');
      run.images = Array.isArray(result.images) ? result.images.slice() : [];
      if (!run.output.trim()) throw Object.assign(new Error('Model returned an empty response'), { code: 'empty_response' });
      this._progress(run, stream, 'reasoning', 'response.reasoning', run.reasoning);
      this._event(run, 'response.reasoning.done', { text: run.reasoning });
      this._progress(run, stream, 'text', 'response.output_text', run.output);
      this._event(run, 'response.output_text.done', { text: run.output });
      this.store.appendMessage(run.session_id, { role: 'assistant', content: run.output, reasoning: run.reasoning, images: result.images || [] });
    } catch (error) {
      terminal = error && (error.name === 'AbortError' || error.code === 'run_cancelled') ? 'cancelled' : 'failed';
      run.error = { message: error.message || String(error), code: error.code || (terminal === 'cancelled' ? 'run_cancelled' : 'run_failed'), ...(error.retry_after_seconds ? { retry_after_seconds: Number(error.retry_after_seconds) } : {}) };
      if (error && error.provider_state) this.store.update(run.session_id, { provider_state: error.provider_state });
    } finally {
      try {
        const current = this.store.get(run.session_id);
        if (current && this.providers.retryPendingCleanup) this.store.update(run.session_id, { provider_state: await this.providers.retryPendingCleanup(current.provider_state) });
      } catch (_) {}
      run.status = terminal;
      run.completed_at = new Date().toISOString();
      this._event(run, 'run.' + terminal, terminal === 'completed' ? { status: terminal, output: run.output, images: run.images || [] } : { status: terminal, error: run.error });
    }
  }

  _event(run, type, data) {
    const event = this.store.appendEvent(run.session_id, { type, run_id: run.id, parent_run_id: null, call_id: data && data.call_id || run.call_id || null, data: data || {} });
    this.emit('event', event);
    return event;
  }

  _publicRun(run) {
    return { id: run.id, session_id: run.session_id, parent_run_id: null, call_id: run.call_id, model: run.model, deep_think: run.deep_think, reasoning_effort: run.reasoning_effort, web_search: run.web_search, timeout_ms: run.timeout_ms, status: run.status, created_at: run.created_at, completed_at: run.completed_at, output: run.output, reasoning: run.reasoning, images: run.images || [], error: run.error };
  }
}

module.exports = { TransportRunService, normalizeReasoningEffort };
