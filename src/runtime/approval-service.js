'use strict';

const { id } = require('./ids');

class ApprovalService {
  constructor(options) { this.config = options && options.config; this.pending = new Map(); }
  list() { return Array.from(this.pending.values()).map((item) => this._public(item)); }
  request(context) {
    const approval = Object.assign({ id: id('approval'), status: 'pending', created_at: new Date().toISOString() }, context || {});
    return new Promise((resolve) => {
      const timer = setTimeout(() => this.resolve(approval.id, false, 'timeout'), 5 * 60 * 1000);
      this.pending.set(approval.id, Object.assign(approval, { resolve, timer }));
      if (context && context.onRequested) context.onRequested(this._public(approval));
    });
  }
  resolve(approvalId, approved, reason) {
    const item = this.pending.get(approvalId); if (!item) return false;
    clearTimeout(item.timer); this.pending.delete(approvalId);
    item.status = approved ? 'approved' : 'denied'; item.resolved_at = new Date().toISOString();
    if (this.config) this.config.audit('tool.approval_resolved', { approval_id: approvalId, approved: !!approved, reason: reason || '' });
    item.resolve(!!approved); return this._public(item);
  }
  cancelRun(runId) { for (const item of this.pending.values()) if (item.run_id === runId) this.resolve(item.id, false, 'run_cancelled'); }
  _public(item) { const { resolve, timer, onRequested, ...value } = item; return value; }
}

module.exports = { ApprovalService };
