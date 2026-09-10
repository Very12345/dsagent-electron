'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const MIGRATION_VERSION = 2;

function copyMissing(source, target) {
  if (!fs.existsSync(source) || fs.existsSync(target)) return false;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.cpSync(source, target, { recursive: true, errorOnExist: false, force: false });
  return true;
}

function atomicJson(target, value) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = target + '.tmp-' + process.pid;
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2), 'utf8');
  fs.renameSync(temporary, target);
}

function migrateLegacyHome(options) {
  const home = options && options.home || os.homedir();
  const oldRoot = path.join(home, '.dsa');
  const newRoot = path.join(home, '.webagent');
  const marker = path.join(newRoot, 'migration.json');
  let previous = null;
  try { previous = JSON.parse(fs.readFileSync(marker, 'utf8')); } catch (_) {}
  if (previous && Number(previous.version) >= MIGRATION_VERSION) return previous;
  fs.mkdirSync(newRoot, { recursive: true });
  const copied = [];
  for (const name of ['skills', 'memory', 'config.json', 'devices.json', 'work-index.json']) {
    if (copyMissing(path.join(oldRoot, name), path.join(newRoot, name))) copied.push(name);
  }
  const result = { version: MIGRATION_VERSION, source: oldRoot, target: newRoot, copied, completed_at: new Date().toISOString() };
  atomicJson(marker, result);
  return result;
}

function migrateElectronUserData(appData, currentUserData) {
  const target = path.join(appData, 'WebAgent');
  if (path.resolve(currentUserData) === path.resolve(target)) return target;
  fs.mkdirSync(target, { recursive: true });
  for (const name of ['runtime-v1', 'Partitions']) copyMissing(path.join(currentUserData, name), path.join(target, name));
  return target;
}

function migrateRuntimeStores(candidates, target) {
  fs.mkdirSync(target, { recursive: true });
  // Runtime-store migration is intentionally a one-time import.  Running the
  // old "copy missing" loop on every startup made a permanently deleted new
  // session reappear whenever a same-named legacy snapshot still existed.
  // The marker is only written after the import finishes, so a crashed first
  // migration remains retryable while completed migrations never resurrect
  // data the user removed from WebAgent.
  const marker = path.join(target, 'store-migration.json');
  try {
    const previous = JSON.parse(fs.readFileSync(marker, 'utf8'));
    if (previous && Number(previous.version) >= MIGRATION_VERSION) {
      return { target, copied: [], skipped: true };
    }
  } catch (_) {}
  const copied = [];
  for (const candidate of candidates || []) {
    const source = path.resolve(candidate);
    if (!fs.existsSync(source) || source === path.resolve(target)) continue;
    for (const name of ['sessions', 'config', 'config.json', 'audit.ndjson', 'devices.json', 'bot-config.json']) {
      if (copyMissing(path.join(source, name), path.join(target, name))) copied.push({ source, name });
    }
  }
  atomicJson(marker, { version: MIGRATION_VERSION, copied, completed_at: new Date().toISOString() });
  return { target, copied };
}

module.exports = { MIGRATION_VERSION, migrateLegacyHome, migrateElectronUserData, migrateRuntimeStores };
