'use strict';

const PLATFORMS = [
  { id: 'wechat', name: '微信', auth: 'qrcode', capabilities: ['text', 'image', 'file', 'room'] },
  { id: 'wecom', name: '企业微信', auth: 'credentials', capabilities: ['text', 'image', 'file', 'room', 'card'] },
  { id: 'qq', name: 'QQ', auth: 'credentials', capabilities: ['text', 'image', 'file', 'room'] },
  { id: 'feishu', name: '飞书', auth: 'qrcode', capabilities: ['text', 'image', 'file', 'room', 'card'] },
  { id: 'dingtalk', name: '钉钉', auth: 'credentials', capabilities: ['text', 'image', 'file', 'room', 'card'] }
];

class BotGateway {
  constructor(options) { this.config = options.config; this.store = options.store; this.runs = options.runs; this.providers = options.providers || null; this.seen = new Set(); }
  platforms() { return PLATFORMS.map((item) => Object.assign({}, item, { configured: this.config.list('bots').some((bot) => bot.platform === item.id && bot.enabled) })); }
  list() { return this.config.list('bots').map((item) => Object.assign({}, item, { credentials: item.credentials ? { configured: true } : null })); }
  create(input) {
    if (!PLATFORMS.some((item) => item.id === input.platform)) throw Object.assign(new Error('Unsupported bot platform'), { code: 'bot_platform_invalid', status: 400 });
    return this.config.create('bots', Object.assign({ name: PLATFORMS.find((item) => item.id === input.platform).name, enabled: false, mode: 'task_delegate', model_policy: 'capability' }, input));
  }
  update(id, patch) { return this.config.update('bots', id, patch); }
  delete(id) { return this.config.delete('bots', id); }
  async dispatch(input) {
    const messageId = String(input.message_id || '');
    if (messageId && this.seen.has(messageId)) return { duplicate: true };
    if (messageId) { this.seen.add(messageId); if (this.seen.size > 10000) this.seen.delete(this.seen.values().next().value); }
    const model = this._selectModel(input);
    let session = input.session_id && this.store.get(input.session_id);
    if (!session) session = this.store.create({ title: String(input.text || 'Bot 任务').slice(0, 48), model, mode: 'chat' });
    const run = await this.runs.startRun(session.id, { prompt: input.text || '', model: input.model || session.model || model, agent_mode: true });
    this.config.audit('bot.task_dispatched', { platform: input.platform, channel_id: input.channel_id, session_id: session.id, run_id: run.id });
    return { session_id: session.id, run_id: run.id, status: run.status };
  }
  _selectModel(input) {
    if (input.model) return input.model;
    const models = this.providers && this.providers.listModels ? this.providers.listModels() : [];
    const needsImage = (input.attachments || []).some((item) => /^image\//.test(item.mime || item.type || ''));
    const needsLong = String(input.text || '').length > 24000;
    const eligible = models.filter((item) => {
      const capabilities = item.capabilities || {};
      if (needsImage && !(capabilities.multimodal && (capabilities.multimodal.input || []).includes('image'))) return false;
      if (needsLong && capabilities.inputMaxLen && capabilities.inputMaxLen < 64000) return false;
      return true;
    });
    return (eligible.find((item) => item.id === 'deepseek.web') || eligible[0] || { id: 'deepseek.web' }).id;
  }
}

module.exports = { BotGateway, BOT_PLATFORMS: PLATFORMS };
