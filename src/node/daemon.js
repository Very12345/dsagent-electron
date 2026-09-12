#!/usr/bin/env node
'use strict';

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { chromium } = require('playwright-core');
const packageInfo = require('../../package.json');
const apiKeyStore = require('../../apikey-store');
const { createModelRegistry } = require('../../model-registry');
const { createDeepseekServer } = require('../../server-deepseek');
const { createQwenServer } = require('../../server-qwen');
const { createChatGPTServer } = require('../../server-chatgpt');
const { createOpenAIServer } = require('../../server-openai');
const { createAnthropicServer } = require('../../server-anthropic');
const { createRuntime, atomicJson } = require('../runtime/bootstrap');
const { CredentialVault } = require('../runtime/credential-vault');
const { WebAppService } = require('../runtime/webapp-service');
const { PlaywrightProviderHost } = require('./playwright-provider-host');
const { createProviderWorkerFactory } = require('./provider-worker-factory');
const { NativeBridge } = require('./native-bridge');
const { acquireRuntimeLock } = require('./runtime-lock');

const ROOT = path.resolve(__dirname, '..', '..');
const HOME = path.resolve(process.env.WEBAGENT_HOME || path.join(os.homedir(), '.webagent'));
const INFO_FILE = path.join(HOME, 'runtime.json');
const LOCK_FILE = path.join(HOME, 'runtime.lock');

function parseArgs(argv) {
  const value = { runtimeOnly: false, noOpen: false, headlessWorkers: true, port: 0, webPort: 0, channel: 'msedge' };
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item === '--runtime-only') value.runtimeOnly = true;
    else if (item === '--no-open') value.noOpen = true;
    else if (item === '--headless-workers') value.headlessWorkers = true;
    else if (item === '--headed-workers') value.headlessWorkers = false;
    else if (item === '--port') value.port = Number(argv[++index]) || 0;
    else if (item === '--web-port') value.webPort = Number(argv[++index]) || 0;
    else if (item === '--browser-channel') value.channel = String(argv[++index] || 'msedge');
  }
  return value;
}

function request(info, route, options) {
  options = options || {};
  return new Promise((resolve, reject) => {
    const body = options.body == null ? null : JSON.stringify(options.body);
    const req = http.request({
      hostname: info.host || '127.0.0.1', port: info.port, path: route,
      method: options.method || (body ? 'POST' : 'GET'),
      headers: Object.assign({ Authorization: 'Bearer ' + info.token, 'Content-Type': 'application/json' }, body ? { 'Content-Length': Buffer.byteLength(body) } : {})
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let data = raw;
        try { data = raw ? JSON.parse(raw) : null; } catch (_) {}
        if ((res.statusCode || 500) >= 400) reject(Object.assign(new Error(data && data.error && data.error.message || 'HTTP ' + res.statusCode), { status: res.statusCode, data }));
        else resolve(data);
      });
    });
    req.setTimeout(Number(options.timeout) || 1200, () => req.destroy(new Error('Runtime request timeout')));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function readInfo() {
  try { return JSON.parse(fs.readFileSync(INFO_FILE, 'utf8')); }
  catch (_) { return null; }
}

async function healthy(info) {
  if (!info || !info.port || !info.token) return false;
  try { const response = await request(info, '/api/ping', { timeout: 800 }); return !!(response && response.ok); }
  catch (_) { return false; }
}

function existingDirectory(value) {
  const input = String(value || '').trim();
  if (!input || !path.isAbsolute(input)) throw Object.assign(new Error('Workspace path must be absolute'), { code: 'workspace_path_invalid', status: 400 });
  try {
    const resolved = fs.realpathSync(path.resolve(input));
    if (!fs.statSync(resolved).isDirectory()) throw new Error('not_directory');
    return resolved;
  } catch (_) {
    throw Object.assign(new Error('Workspace directory does not exist'), { code: 'workspace_not_found', status: 404 });
  }
}

function copyLegacyProviderStore(target) {
  if (fs.existsSync(target)) return '';
  const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  const candidates = [
    path.join(appData, 'dsagent-electron', '.dsa-apikey-store.json'),
    path.join(appData, 'WebAgent', '.dsa-apikey-store.json'),
    path.join(appData, 'webagent-electron', '.dsa-apikey-store.json')
  ];
  const source = candidates.find((candidate) => fs.existsSync(candidate));
  if (!source) return '';
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
  return source;
}

async function ticketForExisting(info) {
  const issued = await request(info, '/api/webapp/ticket', { method: 'POST', body: {}, timeout: 3000 });
  if (!issued || !issued.url) throw new Error('Running Runtime did not provide a WebApp ticket');
  return issued.url;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const nativeBridge = new NativeBridge();
  const existing = readInfo();
  if (await healthy(existing)) {
    if (!args.runtimeOnly && !args.noOpen) await nativeBridge.openExternal(await ticketForExisting(existing));
    return;
  }

  const lock = acquireRuntimeLock(LOCK_FILE);
  let runtime = null;
  let webapp = null;
  let closing = false;
  try {
    const vault = new CredentialVault({ serviceName: 'WebAgent' });
    const rawHost = new PlaywrightProviderHost({
      chromium,
      channel: args.channel,
      headless: args.headlessWorkers,
      profilesRoot: path.join(HOME, 'browser-profiles'),
      accountsFile: path.join(HOME, 'provider-accounts.json'),
      launchOptions: { args: ['--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding'] }
    });
    const createWorker = createProviderWorkerFactory(rawHost, { root: ROOT });
    const providerHost = {
      createWorker: (provider, options) => createWorker(provider, options),
      openLogin: (provider, options) => rawHost.openLogin(provider, options),
      getBrowserCredentials: (provider) => rawHost.getBrowserCredentials(provider),
      activeAccount: (provider) => rawHost.activeAccount(provider),
      listAccounts: (provider) => rawHost.listAccounts(provider),
      createAccount: (provider, name) => rawHost.createAccount(provider, name),
      selectAccount: (provider, accountId) => rawHost.selectAccount(provider, accountId),
      setAccountOrder: (provider, order) => rawHost.setAccountOrder(provider, order),
      nextAvailableAccount: (provider, accountId, excluded) => rawHost.nextAvailableAccount(provider, accountId, excluded),
      browserVisible: (provider) => rawHost.browserVisible(provider),
      setBrowserVisible: (provider, visible) => rawHost.setBrowserVisible(provider, visible),
      removeAccount: (provider, accountId) => rawHost.removeAccount(provider, accountId),
      markAccountLimited: (provider, accountId, retryAfter) => rawHost.markAccountLimited(provider, accountId, retryAfter),
      close: () => rawHost.close()
    };
    const providerStoreFile = path.join(HOME, 'provider-configs.json');
    const importedProviderStore = copyLegacyProviderStore(providerStoreFile);
    if (importedProviderStore) console.log('[Migration] copied provider metadata from', importedProviderStore);
    const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    runtime = await createRuntime({
      root: ROOT,
      home: HOME,
      runtimeRoot: path.join(HOME, 'runtime-v2'),
      providerStoreFile,
      providerHost,
      credentialVault: vault,
      apiKeyStore,
      createModelRegistry,
      createDeepseekServer,
      createQwenServer,
      createChatGPTServer,
      createOpenAIServer,
      createAnthropicServer,
      appVersion: packageInfo.version,
      architecture: 'node-pwa-playwright',
      port: args.port,
      migrateLegacy: !process.env.WEBAGENT_HOME,
      legacyRuntimeRoots: [
        path.join(appData, 'dsagent-electron', 'runtime-v1'),
        path.join(appData, 'DeepSeek Agent', 'runtime-v1'),
        path.join(appData, 'WebAgent', 'runtime-v1'),
        path.join(appData, 'webagent-electron', 'runtime-v1')
      ]
    });
    nativeBridge.setWorkspaceValidator(existingDirectory);
    nativeBridge.harnessCurrentWorkspace = async () => {
      const status = runtime.harness.status();
      const workspace = status.workspace && fs.existsSync(status.workspace) ? existingDirectory(status.workspace) : '';
      return { available: !!workspace, session_id: '', path: workspace, title: workspace ? path.basename(workspace) : '', reason: workspace ? 'harness_runtime_workspace' : 'harness_not_running' };
    };
    webapp = new WebAppService({
      staticRoot: path.join(ROOT, 'dist-renderer'),
      runtime: () => runtime.info,
      nativeBridge,
      workspaceResolver: existingDirectory,
      uploadRoot: path.join(HOME, 'web-uploads')
    });
    await webapp.start(args.webPort || 0);
    runtime.api.webapp = webapp;
    runtime.webapp = webapp;
    runtime.info.webapp = webapp.status();
    runtime.info.webapp_url = webapp.origin;
    atomicJson(runtime.paths.infoFile, runtime.info);
    if (runtime.paths.legacyInfoFile) atomicJson(runtime.paths.legacyInfoFile, runtime.info);
    console.log('[WebAgent] Runtime:', `http://${runtime.info.host}:${runtime.info.port}`);
    console.log('[WebAgent] Workbench:', webapp.origin);
    if (!args.runtimeOnly && !args.noOpen) await nativeBridge.openExternal(webapp.issueBootstrapTicket().url);

    const close = async (code) => {
      if (closing) return;
      closing = true;
      try { if (webapp) await webapp.stop(); } catch (_) {}
      try { if (runtime) await runtime.close(); } catch (_) {}
      try { lock.release(); } catch (_) {}
      process.exitCode = code;
    };
    process.once('SIGINT', () => { void close(0); });
    process.once('SIGTERM', () => { void close(0); });
    process.once('uncaughtException', (error) => { console.error('[WebAgent] uncaught exception:', error); void close(1); });
    process.once('unhandledRejection', (error) => { console.error('[WebAgent] unhandled rejection:', error); void close(1); });
  } catch (error) {
    try { if (webapp) await webapp.stop(); } catch (_) {}
    try { if (runtime) await runtime.close(); } catch (_) {}
    try { lock.release(); } catch (_) {}
    throw error;
  }
}

main().catch((error) => {
  console.error('webagent:', error && error.stack || error);
  process.exitCode = 1;
});
