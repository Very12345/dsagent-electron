'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { WorkerPool } = require('../../src/runtime/worker-pool');

test('worker pool never exceeds cap and never changes active ownership', async () => {
  let created = 0;
  let peak = 0;
  const active = new Set();
  const seen = [];
  const pool = new WorkerPool({
    provider: 'deepseek', max: 2, idleTimeout: 60000,
    factory: async () => ({ id: ++created, destroy() {} })
  });
  pool.on('status', (status) => { peak = Math.max(peak, status.active); });

  await Promise.all(Array.from({ length: 50 }, (_, index) => (async () => {
    const binding = { provider: 'deepseek', session_id: 'session-' + index, run_id: 'run-' + index, call_id: 'call-' + index, url: 'https://chat.deepseek.com/a/chat/s/' + index };
    const lease = await pool.acquire(binding);
    assert.equal(lease.assertOwner(binding), true);
    assert.equal(lease.assertOwner(Object.assign({}, binding, { session_id: 'wrong' })), false);
    assert.equal(active.has(lease.workerId), false, 'a worker cannot serve two active runs');
    active.add(lease.workerId);
    await new Promise((resolve) => setTimeout(resolve, index % 5));
    seen.push(lease.binding.session_id);
    assert.equal(lease.binding.session_id, binding.session_id);
    active.delete(lease.workerId);
    await lease.release();
  })()));
  assert.equal(peak, 2);
  assert.equal(created, 2);
  assert.equal(new Set(seen).size, 50);
  await pool.close();
});

test('queued acquisition can be cancelled without stealing a worker', async () => {
  const pool = new WorkerPool({ provider: 'qwen', max: 1, factory: async () => ({ destroy() {} }) });
  const lease = await pool.acquire({ provider: 'qwen', session_id: 'a', run_id: 'a' });
  const controller = new AbortController();
  const queued = pool.acquire({ provider: 'qwen', session_id: 'b', run_id: 'b' }, controller.signal);
  controller.abort();
  await assert.rejects(queued, { code: 'run_cancelled' });
  assert.equal(lease.binding.session_id, 'a');
  await lease.release();
  await pool.close();
});

test('idle workers destroyed by a headed login context are replaced before reuse', async () => {
  const rawWorkers = [];
  const pool = new WorkerPool({
    provider: 'deepseek', max: 1,
    factory: async () => {
      const raw = { destroyed: false, isDestroyed() { return this.destroyed; }, async destroy() { this.destroyed = true; } };
      rawWorkers.push(raw);
      return raw;
    }
  });
  const first = await pool.acquire({ provider: 'deepseek', session_id: 'first', run_id: 'first' });
  await first.release();
  rawWorkers[0].destroyed = true;
  const second = await pool.acquire({ provider: 'deepseek', session_id: 'second', run_id: 'second' });
  assert.equal(rawWorkers.length, 2);
  assert.equal(second.worker, rawWorkers[1]);
  await second.release();
  await pool.close();
});

test('an account switch replaces only an idle worker and never reuses its profile', async () => {
  const created = [];
  const pool = new WorkerPool({
    provider: 'deepseek', max: 1,
    factory: async (binding) => {
      const raw = { accountId: binding.account_id, destroyed: false, async destroy() { this.destroyed = true; } };
      created.push(raw);
      return raw;
    }
  });
  const primary = await pool.acquire({ provider: 'deepseek', account_id: 'default', session_id: 'one', run_id: 'one' });
  await primary.release();
  const alternate = await pool.acquire({ provider: 'deepseek', account_id: 'account-two', session_id: 'two', run_id: 'two' });
  assert.equal(created.length, 2);
  assert.equal(created[0].destroyed, true);
  assert.equal(alternate.worker.accountId, 'account-two');
  await alternate.release();
  await pool.close();
});

test('per-account cap queues a third run while another account can use global headroom', async () => {
	const pool = new WorkerPool({
		provider: 'deepseek', max: 6, maxPerAccount: 2,
		factory: async (binding) => ({ accountId: binding.account_id, destroy: async () => {} })
	});
	const one = await pool.acquire({ provider: 'deepseek', account_id: 'primary', session_id: 'one', run_id: 'one' });
	const two = await pool.acquire({ provider: 'deepseek', account_id: 'primary', session_id: 'two', run_id: 'two' });
	let thirdSettled = false;
	const thirdPromise = pool.acquire({ provider: 'deepseek', account_id: 'primary', session_id: 'three', run_id: 'three' }).then((lease) => {
		thirdSettled = true;
		return lease;
	});
	await new Promise((resolve) => setTimeout(resolve, 0));
	assert.equal(thirdSettled, false);
	const alternate = await pool.acquire({ provider: 'deepseek', account_id: 'backup', session_id: 'alt', run_id: 'alt' });
	assert.equal(alternate.binding.account_id, 'backup');
	assert.equal(pool.status().account_loads.primary.active, 2);
	assert.equal(pool.status().account_loads.backup.active, 1);
	await one.release();
	const third = await thirdPromise;
	assert.equal(third.binding.account_id, 'primary');
	await Promise.all([two.release(), third.release(), alternate.release()]);
	await pool.close();
});
