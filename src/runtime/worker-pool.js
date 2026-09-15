'use strict';

const EventEmitter = require('events');
const { id } = require('./ids');

class WorkerPool extends EventEmitter {
  constructor(options) {
    super();
    this.provider = options.provider;
    this.max = Math.max(1, Number(options.max) || 1);
	this.maxPerAccount = Math.max(1, Number(options.maxPerAccount) || this.max);
    this.min = Math.max(0, Number(options.min) || 0);
    this.idleTimeout = Number(options.idleTimeout) || 120000;
    this.factory = options.factory;
    this.workers = [];
    this.queue = [];
    this.creating = 0;
	this.creatingAccounts = new Map();
  }

	_accountTotal(accountId) {
		return this.workers.filter((worker) => worker.state !== 'destroyed' && worker.account_id === accountId).length
			+ (this.creatingAccounts.get(accountId) || 0);
	}

	accountLoad(accountId) {
		const workers = this.workers.filter((worker) => worker.state !== 'destroyed' && worker.account_id === accountId);
		return {
			total: workers.length + (this.creatingAccounts.get(accountId) || 0),
			active: workers.filter((worker) => worker.state === 'active').length,
			idle: workers.filter((worker) => worker.state === 'idle').length,
			creating: this.creatingAccounts.get(accountId) || 0
		};
	}

  async acquire(binding, signal) {
    if (signal && signal.aborted) throw this._abortError();
    const stale = this.workers.filter((worker) => worker.state === 'idle' && worker.raw && typeof worker.raw.isDestroyed === 'function' && worker.raw.isDestroyed());
    for (const worker of stale) await this._destroy(worker, null);
    const accountId = binding && binding.account_id || 'default';
    const idle = this.workers.find((worker) => worker.state === 'idle' && worker.account_id === accountId);
    if (idle) return this._lease(idle, binding);
    const mismatchedIdle = this.workers.find((worker) => worker.state === 'idle' && worker.account_id !== accountId);
    if (mismatchedIdle && this.workers.length + this.creating >= this.max) await this._destroy(mismatchedIdle, null);
	if (this._accountTotal(accountId) < this.maxPerAccount && this.workers.length + this.creating < this.max) {
		const worker = await this._createWorker(binding);
		return this._lease(worker, binding);
    }
    return new Promise((resolve, reject) => {
      const request = { binding, signal, resolve, reject };
      this.queue.push(request);
      if (signal) {
        const abort = () => {
          const index = this.queue.indexOf(request);
          if (index >= 0) this.queue.splice(index, 1);
          reject(this._abortError());
        };
        signal.addEventListener('abort', abort, { once: true });
        request.abort = abort;
      }
      this.emit('status', this.status());
    });
  }

  async _createWorker(binding) {
    const accountId = binding && binding.account_id || 'default';
	this.creating += 1;
	this.creatingAccounts.set(accountId, (this.creatingAccounts.get(accountId) || 0) + 1);
	this.emit('status', this.status());
	try {
		const raw = await this.factory({ provider: this.provider, index: this.workers.length, account_id: accountId });
		const worker = {
		  id: id('worker'),
		  state: 'idle',
		  raw,
		  account_id: raw && raw.accountId || accountId,
		  lease: null,
		  timer: null,
		  created_at: Date.now()
		};
		this.workers.push(worker);
		return worker;
	} finally {
		this.creating -= 1;
		const remaining = (this.creatingAccounts.get(accountId) || 1) - 1;
		if (remaining > 0) this.creatingAccounts.set(accountId, remaining);
		else this.creatingAccounts.delete(accountId);
		this.emit('status', this.status());
	}
  }

  _lease(worker, binding) {
    if (worker.timer) clearTimeout(worker.timer);
    const leaseId = id('lease');
    worker.state = 'active';
    worker.lease = Object.freeze(Object.assign({
      id: leaseId,
      provider: this.provider,
      worker_id: worker.id
    }, binding));
    let released = false;
    this.emit('status', this.status());
    return {
      id: leaseId,
      workerId: worker.id,
      binding: worker.lease,
      worker: worker.raw,
      assertOwner: (candidate) => this.assertOwner(leaseId, candidate),
      release: async () => {
        if (released) return;
        released = true;
        await this._release(worker, leaseId);
      },
      destroy: async () => {
        if (released) return;
        released = true;
        await this._destroy(worker, leaseId);
      }
    };
  }

  assertOwner(leaseId, candidate) {
    const worker = this.workers.find((item) => item.lease && item.lease.id === leaseId);
    if (!worker || worker.state !== 'active') return false;
    const lease = worker.lease;
    return ['provider', 'session_id', 'run_id', 'call_id', 'url'].every((key) => {
      if (candidate[key] == null) return true;
      return candidate[key] === lease[key];
    });
  }

  async _release(worker, leaseId) {
    if (!worker.lease || worker.lease.id !== leaseId) return;
    worker.state = 'idle';
    worker.lease = null;
    const next = this.queue.shift();
    if (next) {
      const requestedAccount = next.binding && next.binding.account_id || 'default';
	  if (worker.account_id === requestedAccount) {
		if (next.signal && next.abort) next.signal.removeEventListener('abort', next.abort);
		next.resolve(this._lease(worker, next.binding));
	  }
      else {
        this.queue.unshift(next);
        await this._destroy(worker, null);
      }
    } else if (this.workers.length > this.min) {
      worker.timer = setTimeout(() => this._destroy(worker, null), this.idleTimeout);
      if (worker.timer.unref) worker.timer.unref();
    }
    this.emit('status', this.status());
  }

  async _destroy(worker, leaseId) {
    if (leaseId && (!worker.lease || worker.lease.id !== leaseId)) return;
    const index = this.workers.indexOf(worker);
    if (index >= 0) this.workers.splice(index, 1);
    worker.state = 'destroyed';
    worker.lease = null;
    if (worker.timer) clearTimeout(worker.timer);
    if (worker.raw && typeof worker.raw.destroy === 'function') await worker.raw.destroy();
    const next = this.queue.shift();
    if (next) {
	  const requestedAccount = next.binding && next.binding.account_id || 'default';
	  if (this._accountTotal(requestedAccount) >= this.maxPerAccount) {
		this.queue.unshift(next);
	  } else {
		if (next.signal && next.abort) next.signal.removeEventListener('abort', next.abort);
		try {
		  const replacement = await this._createWorker(next.binding);
		  next.resolve(this._lease(replacement, next.binding));
		} catch (error) {
		  next.reject(error);
		}
	  }
    }
    this.emit('status', this.status());
  }

  status() {
	const accountIds = new Set([
	  ...this.workers.map((worker) => worker.account_id),
	  ...this.creatingAccounts.keys()
	]);
    return {
      provider: this.provider,
      max: this.max,
	  max_per_account: this.maxPerAccount,
      total: this.workers.length,
      creating: this.creating,
      active: this.workers.filter((worker) => worker.state === 'active').length,
      idle: this.workers.filter((worker) => worker.state === 'idle').length,
	  queued: this.queue.length,
	  accounts: Array.from(accountIds),
	  account_loads: Object.fromEntries(Array.from(accountIds).map((accountId) => [accountId, this.accountLoad(accountId)]))
    };
  }

  async destroyIdle() {
    const idle = this.workers.filter((worker) => worker.state === 'idle');
    await Promise.all(idle.map((worker) => this._destroy(worker, null)));
    return idle.length;
  }

  async close() {
    const workers = this.workers.slice();
    this.queue.splice(0).forEach((request) => request.reject(new Error('Worker pool closed')));
    await Promise.all(workers.map((worker) => this._destroy(worker, null)));
  }

  _abortError() {
    return Object.assign(new Error('Run cancelled'), { name: 'AbortError', code: 'run_cancelled' });
  }
}

module.exports = { WorkerPool };
