'use strict';

const { id } = require('./ids');

const DEFAULTS = {
  deepseek: { window: 1000000, threshold: 0.75, source: 'deepseek-v4-official' },
  chatgpt: { window: 128000, threshold: 0.70, source: 'chatgpt-web-conservative-paid' },
  qwen: { window: 32000, threshold: 0.70, source: 'qwen-web-conservative' },
  api: { window: 128000, threshold: 0.75, source: 'api-model-default' }
};

function providerFromModel(model) {
  const value = String(model || '');
  if (value.startsWith('deepseek.')) return 'deepseek';
  if (value.startsWith('chatgpt.')) return 'chatgpt';
  if (value.startsWith('qwen.')) return 'qwen';
  return 'api';
}

function contentText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return JSON.stringify(content == null ? '' : content);
  return content.map((item) => typeof item === 'string' ? item : item && (item.text || item.input_text || '')).join('\n');
}

function estimateTokens(value) {
  const text = String(value || '');
  let latin = 0;
  let wide = 0;
  for (const character of text) /[\u3400-\u9fff\uf900-\ufaff]/.test(character) ? wide += 1 : latin += 1;
  return Math.ceil(wide / 1.6 + latin / 4);
}

function deterministicContextPack(session, messages) {
  const visible = messages.filter((message) => !message.hidden);
  const recent = visible.slice(-12);
  const decisions = visible.filter((message) => message.role === 'assistant').slice(-8).map((message) => contentText(message.content).slice(0, 700));
  const goals = visible.filter((message) => message.role === 'user').slice(-6).map((message) => contentText(message.content).slice(0, 700));
  return {
    version: 1,
    session_id: session.id,
    title: session.title,
    mode: session.mode,
    workspace: session.workspace || '',
    goals,
    decisions,
    constraints: session.mode === 'chat' ? ['Do not execute runtime tools.'] : ['Preserve workspace ownership and tool results.'],
    key_files: Array.from(new Set(visible.flatMap((message) => String(message.content || '').match(/[A-Za-z]:\\[^\s"']+|(?:[\w.-]+\/)+[\w.-]+/g) || []))).slice(-30),
    unresolved: goals.slice(-3),
    recent: recent.map((message) => ({ role: message.role, content: contentText(message.content).slice(0, 1800) }))
  };
}

class ContextManager {
  constructor(options) {
    this.store = options.store;
    this.providers = options.providers;
    this.overrides = options.overrides || {};
  }

  capabilities(model, session) {
    const provider = providerFromModel(model);
    const override = this.overrides[model] || this.overrides[provider] || {};
    const defaults = DEFAULTS[provider];
    const detected = session && session.provider_state && session.provider_state.context_window;
    return {
      provider,
      window: Math.max(1024, Number(override.window || detected || defaults.window)),
      threshold: Math.min(0.95, Math.max(0.1, Number(override.threshold || defaults.threshold))),
      source: override.source || (detected ? session.provider_state.context_window_source || 'provider-page-detected' : defaults.source)
    };
  }

  inspect(session, model, instructions) {
    const capability = this.capabilities(model || session.model, session);
    const allMessages = session.messages || [];
    const compactedId = session.context_state && session.context_state.compacted_through_message_id;
    const compactedIndex = compactedId ? allMessages.findIndex((message) => message.id === compactedId) : -1;
    const measuredMessages = compactedIndex >= 0 ? allMessages.slice(compactedIndex + 1) : allMessages;
    const summaryTokens = compactedIndex >= 0 ? estimateTokens(JSON.stringify(session.context_state.summary || {})) : 0;
    const messageTokens = summaryTokens + measuredMessages.reduce((sum, message) => sum + estimateTokens(contentText(message.content)) + estimateTokens(message.reasoning) + 8, 0);
    const estimated = messageTokens + estimateTokens(instructions) + 4096;
    const state = Object.assign({ generation: 0, summaries: [], compacted_through_message_id: null }, session.context_state || {}, {
      estimated_tokens: estimated,
      context_window: capability.window,
      trigger_tokens: Math.floor(capability.window * capability.threshold),
      window_source: capability.source,
      threshold: capability.threshold,
      needs_compaction: estimated >= Math.floor(capability.window * capability.threshold),
      updated_at: new Date().toISOString()
    });
    return state;
  }

  prepare(session, options) {
    const state = this.inspect(session, options.model, options.instructions);
    const force = !!options.force || !!state.force_compact_next;
    if (!state.needs_compaction && !force) {
      this.store.update(session.id, { context_state: state });
      return { messages: session.messages, instructions: options.instructions, state, compacted: false };
    }
    const pack = deterministicContextPack(session, session.messages || []);
    const marker = id('ctx');
    const nextState = Object.assign({}, state, {
      generation: Number(state.generation || 0) + 1,
      needs_compaction: false,
      force_compact_next: false,
      last_compaction_id: marker,
      last_compacted_at: new Date().toISOString(),
      compacted_through_message_id: session.messages.length ? session.messages[session.messages.length - 1].id : null,
      summary: pack,
      summaries: (state.summaries || []).concat([{ id: marker, generation: Number(state.generation || 0) + 1, created_at: new Date().toISOString(), pack }]).slice(-20)
    });
    this.store.update(session.id, { context_state: nextState });
    const recent = (session.messages || []).filter((message) => !message.hidden).slice(-8);
    const compactedMessages = [{ role: 'system', content: 'WebAgent ContextPack\n' + JSON.stringify(pack) }].concat(recent);
    return { messages: compactedMessages, instructions: options.instructions, state: nextState, compacted: true, force_new_conversation: true, previous_provider_state: session.provider_state || {} };
  }

  requestCompaction(sessionId) {
    const session = this.store.get(sessionId);
    if (!session) throw Object.assign(new Error('Session not found'), { code: 'session_not_found', status: 404 });
    const state = Object.assign({}, this.inspect(session, session.model, ''), { force_compact_next: true, requested_at: new Date().toISOString() });
    return this.store.update(sessionId, { context_state: state }).context_state;
  }

  applyRemoteSummary(sessionId, prepared, rawSummary) {
    let remote = String(rawSummary || '').trim();
    const fenced = remote.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenced) remote = fenced[1].trim();
    let parsed = null;
    try { parsed = JSON.parse(remote); } catch (_) {}
    const summary = parsed && typeof parsed === 'object' ? parsed : Object.assign({}, prepared.state.summary, { remote_summary: remote.slice(0, 12000) });
    const state = Object.assign({}, prepared.state, { summary, summary_source: parsed ? 'provider-structured' : 'provider-text', remote_summary_validated_at: new Date().toISOString() });
    this.store.update(sessionId, { context_state: state });
    prepared.state = state;
    prepared.messages[0] = { role: 'system', content: 'WebAgent ContextPack\n' + JSON.stringify(summary) };
    return prepared;
  }
}

module.exports = { ContextManager, estimateTokens, deterministicContextPack, providerFromModel, DEFAULTS };
