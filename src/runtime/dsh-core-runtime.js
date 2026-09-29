'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { SessionStore } = require('./session-store');
const { TransportRunService } = require('./transport-run-service');
const { RuntimeApiServer } = require('./api-server');
const { ProviderManager } = require('./provider-manager');
const { DeepSeekHarnessService } = require('./deepseek-harness-service');
const { RogatorService, gatewayModels } = require('./rogator-service');

function atomicJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = file + '.tmp-' + process.pid + '-' + crypto.randomBytes(4).toString('hex');
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2), 'utf8');
  fs.renameSync(temporary, file);
}

function corePaths(options) {
  const home = path.resolve(options.home || path.join(os.homedir(), '.webagent'));
  return {
    home,
    runtimeRoot: path.resolve(options.runtimeRoot || path.join(home, 'transport')),
    infoFile: path.resolve(options.infoFile || path.join(home, 'runtime.json')),
    tokenFile: path.resolve(options.tokenFile || process.env.WEBAGENT_RUNTIME_TOKEN_FILE || path.join(home, 'runtime-token')),
    harnessHome: path.resolve(options.harnessHome || path.join(home, 'deepseek-harness')),
    rogatorHome: path.resolve(options.rogatorHome || path.join(home, 'qwen-gateway'))
  };
}

/**
 * Resolve the runtime's bearer token so it survives restarts.
 *
 * The token used to be minted fresh on every boot, which made every client that
 * had stored it fail with 401 as soon as the service restarted. Precedence:
 *
 *   1. `WEBAGENT_RUNTIME_TOKEN` — an explicit operator override.
 *   2. the persisted token file — read back on every start.
 *   3. a new random token — written to that file, mode 0600, on first boot.
 *
 * A blank or unreadable file falls through to (3) rather than booting with no
 * usable token, which would lock every client out silently. Persisting is
 * best-effort: a read-only home still boots with a working in-process token.
 *
 * @param {object} options - runtime options carrying `paths`.
 * @returns {string} the token to authenticate clients with.
 */
function resolveRuntimeToken(options) {
  const fromEnv = String(process.env.WEBAGENT_RUNTIME_TOKEN || '').trim();
  if (fromEnv) return fromEnv;
  const file = options.paths.tokenFile;
  const persisted = readTokenFile(file);
  if (persisted) return persisted;
  const token = crypto.randomBytes(24).toString('hex');
  try {
    writeTokenFile(file, token);
  } catch (error) {
    console.warn('[runtime] could not persist the bearer token to ' + file + ': ' + error.message);
  }
  return token;
}

function readTokenFile(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (_error) {
    return '';
  }
  return text.trim();
}

function writeTokenFile(file, token) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = file + '.tmp-' + process.pid + '-' + crypto.randomBytes(4).toString('hex');
  fs.writeFileSync(temporary, token + '\n', { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(temporary, file);
  // rename() keeps the temporary file's mode, but an existing target on some
  // platforms is replaced with it; re-assert so the secret stays owner-only.
  try { fs.chmodSync(file, 0o600); } catch (_error) { /* non-POSIX filesystem */ }
}

function emptyApiRegistry() {
  return {
    listModels: () => [],
    getModel: () => null,
    invoke: async (model) => ({ success: false, error: 'API model is unavailable in DSH-core mode: ' + model })
  };
}

async function createDshCoreRuntime(options) {
  options = options || {};
  const root = path.resolve(options.root || path.join(__dirname, '..', '..'));
  const paths = corePaths({
    home: options.home || path.join(os.homedir(), '.webagent'),
    runtimeRoot: options.runtimeRoot,
    infoFile: options.infoFile,
    harnessHome: options.harnessHome
  });
  const providerHost = options.providerHost;
  if (!providerHost || typeof providerHost.createWorker !== 'function') throw new Error('ProviderBrowserHost is required');

  const store = new SessionStore(paths.runtimeRoot).init();
  const deepseekModels = Object.values(options.createDeepseekServer(() => null).models);
  const rogator = new RogatorService({
    home: paths.rogatorHome,
    source: process.env.WEBAGENT_ROGATOR_SOURCE || path.join(paths.rogatorHome, 'source'),
    runner: path.join(root, 'integrations', 'rogator-qwen', 'webagent_runner.py'),
    python: options.python,
    encrypt: (value) => Buffer.from(String(value || ''), 'utf8').toString('base64'),
    decrypt: (value) => Buffer.from(String(value || ''), 'base64').toString('utf8'),
    authenticate: () => providerHost.openLogin('qwen'),
    getBrowserCredentials: () => providerHost.getBrowserCredentials('qwen')
  });
  const providers = new ProviderManager({
    apiRegistry: emptyApiRegistry(),
    rogator,
    webModels: deepseekModels.concat(gatewayModels()),
    webProviders: ['deepseek', 'qwen'],
    webFactories: {
      deepseek: (binding) => providerHost.createWorker('deepseek', binding),
      qwen: (binding) => providerHost.createWorker('qwen', binding)
    },
    onAuthRequired: (provider, owner) => providerHost.openLogin(provider, owner),
    accountManager: providerHost
  });
  const runs = new TransportRunService({ store, providers });
  const token = resolveRuntimeToken({ paths });
  const api = new RuntimeApiServer({
    store, providers, runs, token, providerOnly: true,
    port: Number(options.port || process.env.WEBAGENT_PORT) || 5858
  });
  api.rogator = rogator;
  const address = await api.start();
  const harness = new DeepSeekHarnessService({
    root,
    runtimePort: address.port,
    runtimeToken: token,
    home: paths.harnessHome,
    defaultWorkspace: options.workspace || process.cwd(),
    coreOnly: true,
    dshBin: options.dshBin
  });
  api.harness = harness;
  const info = {
    version: 4,
    product: 'WebAgent DSH Core',
    architecture: 'dsh-core-playwright',
    app_version: String(options.appVersion || '0.0.0'),
    pid: process.pid,
    host: address.host,
    port: address.port,
    token,
    providers: ['deepseek', 'qwen'],
    started_at: new Date().toISOString()
  };
  atomicJson(paths.infoFile, info);
  return {
    root, paths, store, providers, runs, api, harness, rogator, providerHost, info,
    async close() {
      try { await harness.stop(); } catch (_) {}
      try { await rogator.stop(); } catch (_) {}
      try { await api.close(); } catch (_) {}
      try { await providers.close(); } catch (_) {}
      try { await providerHost.close(); } catch (_) {}
      try {
        const current = JSON.parse(fs.readFileSync(paths.infoFile, 'utf8'));
        if (Number(current.pid) === process.pid) fs.unlinkSync(paths.infoFile);
      } catch (_) {}
    }
  };
}

module.exports = { createDshCoreRuntime, emptyApiRegistry, corePaths, resolveRuntimeToken };
