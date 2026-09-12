#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const candidates = process.env.WEBAGENT_HOME
  ? [path.resolve(process.env.WEBAGENT_HOME)]
  : [path.join(os.homedir(), '.webagent-dsh'), path.join(os.homedir(), '.webagent')];

function processIsAlive(pid) {
  const value = Number(pid);
  if (!Number.isInteger(value) || value <= 0) return true;
  try { process.kill(value, 0); return true; }
  catch (_) { return false; }
}

function readRuntimeInfos() {
  const infos = [];
  for (const home of candidates) {
    const file = path.join(home, 'runtime.json');
    if (!fs.existsSync(file)) continue;
    try {
      const info = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (processIsAlive(info.pid)) infos.push(info);
    } catch (_) {}
  }
  return infos;
}

async function main() {
  let lastError = null;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const infos = readRuntimeInfos();
    if (!infos.length) {
      lastError = new Error('No running WebAgent DSH Core was found');
      await new Promise((resolve) => setTimeout(resolve, 1000));
      continue;
    }
    for (const info of infos) {
      try {
        const response = await fetch('http://' + (info.host || '127.0.0.1') + ':' + info.port + '/api/harness/browser-ticket', {
          method: 'POST',
          headers: { Authorization: 'Bearer ' + info.token },
          signal: AbortSignal.timeout(3000)
        });
        const payload = await response.json();
        if (response.ok) { process.stdout.write(payload.url + '\n'); return; }
        lastError = new Error(payload.error && payload.error.message || 'HTTP ' + response.status);
      } catch (error) {
        lastError = error;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw lastError || new Error('DeepSeek Harness did not become ready');
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
