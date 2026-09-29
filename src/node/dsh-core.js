#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { chromium } = require('playwright-core');
const packageInfo = require('../../package.json');
const { createDeepseekServer } = require('../../server-deepseek');
const { createQwenServer } = require('../../server-qwen');
const { createDshCoreRuntime } = require('../runtime/dsh-core-runtime');
const { PlaywrightProviderHost } = require('./playwright-provider-host');
const { createProviderWorkerFactory } = require('./provider-worker-factory');
const { NativeBridge } = require('./native-bridge');
const { acquireRuntimeLock } = require('./runtime-lock');

const ROOT = path.resolve(__dirname, '..', '..');

function usage() {
  return `WebAgent DSH Core\n\nUsage:\n  webagent-dsh [options]\n\nOptions:\n  --workspace <path>          DSH workspace (default: current directory)\n  --port <number>             Local provider API port (default: 5858)\n  --harness-port <number>     DSH WebUI port (default: 3080)\n  --runtime-only              Serve the provider API only; do not start a DSH WebUI\n  --browser-channel <name>    Playwright channel, e.g. msedge or chrome\n  --browser-executable <path> Explicit Chromium-compatible executable\n  --headed-workers            Show provider browser workers\n  --no-open                   Do not open the DSH WebUI\n  -h, --help                  Show this help\n`;
}

function parseArgs(argv) {
  const result = {
    workspace: process.cwd(),
    port: 5858,
    harnessPort: 3080,
    runtimeOnly: false,
    channel: process.platform === 'win32' ? 'msedge' : '',
    executablePath: '',
    headless: true,
    noOpen: false,
    help: false
  };
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item === '--workspace') result.workspace = path.resolve(String(argv[++index] || ''));
    else if (item === '--port') result.port = Number(argv[++index]) || 5858;
    else if (item === '--harness-port') result.harnessPort = Number(argv[++index]) || 3080;
    else if (item === '--runtime-only') result.runtimeOnly = true;
    else if (item === '--browser-channel') result.channel = String(argv[++index] || '');
    else if (item === '--browser-executable') result.executablePath = path.resolve(String(argv[++index] || ''));
    else if (item === '--headed-workers') result.headless = false;
    else if (item === '--no-open') result.noOpen = true;
    else if (item === '-h' || item === '--help') result.help = true;
    else throw new Error('Unknown option: ' + item);
  }
  return result;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { process.stdout.write(usage()); return; }
  if (!fs.existsSync(args.workspace) || !fs.statSync(args.workspace).isDirectory()) throw new Error('Workspace does not exist: ' + args.workspace);

  // Reuse the established WebAgent provider profiles and DSH history by
  // default. Deployments that need isolation set WEBAGENT_HOME explicitly.
  const home = path.resolve(process.env.WEBAGENT_HOME || path.join(os.homedir(), '.webagent'));
  const lock = acquireRuntimeLock(path.join(home, 'runtime.lock'));
  const nativeBridge = new NativeBridge();
  let runtime = null;
  let closing = false;
  try {
    const launchOptions = { args: ['--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding'] };
    if (args.executablePath) launchOptions.executablePath = args.executablePath;
    const rawHost = new PlaywrightProviderHost({
      chromium,
      channel: args.channel,
      headless: args.headless,
      profilesRoot: path.join(home, 'browser-profiles'),
      accountsFile: path.join(home, 'provider-accounts.json'),
      launchOptions
    });
    const createWorker = createProviderWorkerFactory(rawHost, { root: ROOT, transportOnly: true });
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
    runtime = await createDshCoreRuntime({
      root: ROOT,
      home,
      workspace: args.workspace,
      providerHost,
      createDeepseekServer,
      createQwenServer,
      // A runtime-only host serves the provider API for a DSH that already
      // exists, so it must not require a DSH install of its own.
      dshBin: args.runtimeOnly ? undefined : require.resolve('@deepseek-ai/dsh/lib/bin.js'),
      appVersion: packageInfo.version,
      port: args.port
    });
    console.log('[DSH Core] Provider API: http://' + runtime.info.host + ':' + runtime.info.port);
    console.log('[DSH Core] Agent owner: DeepSeek Harness (Runtime agent disabled)');
    if (args.runtimeOnly) {
      console.log('[DSH Core] Runtime-only: no DSH WebUI is started; point your own DSH profile at the Provider API.');
    } else {
      const harness = await runtime.harness.start({ workspace: args.workspace, port: args.harnessPort });
      const browserTicket = runtime.api.issueHarnessBrowserTicket();
      console.log('[DSH Core] Harness: ' + browserTicket.url);
      if (!args.noOpen) await nativeBridge.openExternal(harness.browser_url);
    }

    const close = async (code) => {
      if (closing) return;
      closing = true;
      try { if (runtime) await runtime.close(); } catch (_) {}
      try { lock.release(); } catch (_) {}
      process.exitCode = code;
    };
    process.once('SIGINT', () => { void close(0); });
    process.once('SIGTERM', () => { void close(0); });
    process.once('uncaughtException', (error) => { console.error('[DSH Core] uncaught exception:', error); void close(1); });
    process.once('unhandledRejection', (error) => { console.error('[DSH Core] unhandled rejection:', error); void close(1); });
  } catch (error) {
    try { if (runtime) await runtime.close(); } catch (_) {}
    try { lock.release(); } catch (_) {}
    throw error;
  }
}

if (require.main === module) main().catch((error) => {
  console.error('webagent-dsh:', error && error.stack || error);
  process.exitCode = 1;
});

module.exports = { parseArgs, usage };
