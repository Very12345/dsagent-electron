'use strict';

const crypto = require('crypto');

class ProviderConfigService {
  constructor(options) { this.store = options.store; this.reload = options.reload; }
  list() { return this.store.listServices().map((item) => this._redact(item)); }
  get(id) { const item = this.store.getService(id); return item ? this._redact(item) : null; }
  async create(input) {
    const service = this._normalize(input || {}); const result = this.store.addService(service);
    if (!result.success) throw Object.assign(new Error(result.error), { code: 'provider_save_failed', status: 400 });
    if (this.reload) await this.reload(); return this.get(result.id);
  }
  async update(id, patch) {
    const current = this.store.getService(id); if (!current) throw Object.assign(new Error('Provider not found'), { code: 'provider_not_found', status: 404 });
    const next = this._normalize(Object.assign({}, current, patch || {}, { id, apiKey: patch && patch.apiKey ? patch.apiKey : current.apiKey }));
    const result = this.store.updateService(id, next); if (!result.success) throw Object.assign(new Error(result.error), { code: 'provider_save_failed', status: 400 });
    if (this.reload) await this.reload(); return this.get(id);
  }
  async delete(id) { const result = this.store.deleteService(id); if (this.reload) await this.reload(); return result; }
  async test(id) {
    const item = this.store.getService(id); if (!item) throw Object.assign(new Error('Provider not found'), { code: 'provider_not_found', status: 404 });
    const endpoint = String(item.endpoint || '').replace(/\/$/, '');
    const response = await fetch(endpoint + '/models', { headers: { Authorization: 'Bearer ' + item.apiKey }, signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw Object.assign(new Error('Provider returned HTTP ' + response.status), { code: 'provider_test_failed', status: 400 });
    const data = await response.json(); return { ok: true, models: Array.isArray(data.data) ? data.data.slice(0, 200) : [] };
  }
  _normalize(input) {
    const rawEndpoint = String(input.endpoint || '').replace(/\/$/, '').replace(/\/(?:chat\/completions|responses)$/i, '');
    const endpoint = /\/v1$/i.test(rawEndpoint) ? rawEndpoint : rawEndpoint + '/v1';
    if (!/^https?:\/\//i.test(endpoint)) throw Object.assign(new Error('Provider endpoint must use HTTP or HTTPS'), { code: 'provider_endpoint_invalid', status: 400 });
    if (!input.apiKey) throw Object.assign(new Error('API key is required'), { code: 'provider_api_key_required', status: 400 });
    const protocol = ['responses', 'chat_completions', 'auto'].includes(input.protocol) ? input.protocol : 'auto';
    return Object.assign({}, input, { id: input.id || 'svc_' + crypto.randomBytes(8).toString('hex'), provider: input.provider || 'openai', name: input.name || 'OpenAI 兼容服务', endpoint, protocol, models: Array.isArray(input.models) ? input.models : [] });
  }
  _redact(item) { const { apiKey, ...value } = item; return Object.assign(value, { api_key_configured: !!apiKey }); }
}

module.exports = { ProviderConfigService };
