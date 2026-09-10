'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

function pidAlive(pid) {
  const value = Number(pid);
  if (!Number.isInteger(value) || value <= 0) return false;
  try { process.kill(value, 0); return true; }
  catch (error) { return error && error.code === 'EPERM'; }
}

function readLock(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (_) { return null; }
}

function acquireRuntimeLock(file, options) {
  options = options || {};
  const target = path.resolve(file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const token = crypto.randomBytes(16).toString('hex');
  const payload = { pid: process.pid, token, created_at: new Date().toISOString() };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const descriptor = fs.openSync(target, 'wx', 0o600);
      try { fs.writeFileSync(descriptor, JSON.stringify(payload, null, 2), 'utf8'); }
      finally { fs.closeSync(descriptor); }
      let released = false;
      return {
        file: target,
        payload,
        release() {
          if (released) return false;
          released = true;
          const current = readLock(target);
          if (!current || current.token !== token || Number(current.pid) !== process.pid) return false;
          fs.unlinkSync(target);
          return true;
        }
      };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const existing = readLock(target);
      const alive = (options.pidAlive || pidAlive)(existing && existing.pid);
      if (alive) throw Object.assign(new Error('WebAgent Runtime is already running'), { code: 'runtime_already_running', pid: existing.pid });
      // The target is a single verified lock file, never a directory or glob.
      try { fs.unlinkSync(target); } catch (unlinkError) { if (unlinkError.code !== 'ENOENT') throw unlinkError; }
    }
  }
  throw Object.assign(new Error('Unable to acquire WebAgent Runtime lock'), { code: 'runtime_lock_failed' });
}

module.exports = { acquireRuntimeLock, pidAlive, readLock };
