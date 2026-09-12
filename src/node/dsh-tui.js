#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

function main() {
  const root = path.resolve(__dirname, '..', '..');
  const webagentHome = path.resolve(process.env.WEBAGENT_HOME || path.join(os.homedir(), '.webagent-dsh'));
  const dshHome = path.resolve(process.env.DSH_HOME || path.join(webagentHome, 'deepseek-harness'));
  const runtimeFile = path.join(webagentHome, 'runtime.json');
  const profileFile = path.join(dshHome, 'profiles', 'tui', 'package.json');
  const patchFile = path.join(dshHome, 'webagent-integration.patch.yml');
  const dshBin = [
    path.join(root, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
    path.join(root, '..', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  ].find((candidate) => fs.existsSync(candidate));
  if (!fs.existsSync(runtimeFile)) throw new Error('WebAgent DSH Core is not running: ' + runtimeFile + ' was not found');
  if (!fs.existsSync(profileFile)) throw new Error('The TUI profile is not installed under ' + dshHome);
  if (!fs.existsSync(patchFile)) throw new Error('The WebAgent DSH integration patch is missing: ' + patchFile);
  if (!dshBin) throw new Error('The bundled @deepseek-ai/dsh launcher could not be resolved');
  const runtime = JSON.parse(fs.readFileSync(runtimeFile, 'utf8'));
  if (!runtime.token || !runtime.port) throw new Error('The active WebAgent runtime record is incomplete');
  const child = spawn(process.execPath, [dshBin, '--profile', 'tui', '--patch', patchFile, ...process.argv.slice(2)], {
    cwd: process.cwd(),
    env: Object.assign({}, process.env, {
      DSH_HOME: dshHome,
      WEBAGENT_DSH_TOKEN: String(runtime.token),
      WEBAGENT_RUNTIME_URL: 'http://127.0.0.1:' + String(runtime.port)
    }),
    stdio: 'inherit'
  });
  child.once('error', (error) => { console.error(error.message); process.exitCode = 1; });
  child.once('exit', (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    else process.exitCode = Number(code) || 0;
  });
}

try { main(); }
catch (error) { console.error(error.message); process.exitCode = 1; }
