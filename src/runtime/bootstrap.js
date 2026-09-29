'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { SessionStore } = require('./session-store');
const { RunService } = require('./run-service');
const { RuntimeApiServer } = require('./api-server');
const { ProviderManager } = require('./provider-manager');
const { CapabilityService } = require('./capability-service');
const { RuntimeConfigStore } = require('./config-store');
const { ToolRegistry } = require('./tool-registry');
const { ApprovalService } = require('./approval-service');
const { MobileGateway } = require('./mobile-gateway');
const { BotGateway } = require('./bot-gateway');
const { ProviderConfigService } = require('./provider-config-service');
const { ContextManager } = require('./context-manager');
const { WorkMemoryService } = require('./work-memory-service');
const { DeepSeekHarnessService } = require('./deepseek-harness-service');
const { RogatorService, gatewayModels } = require('./rogator-service');
const { ModelApiService } = require('./model-api-service');
const { McpService } = require('./mcp-service');
const { migrateLegacyHome, migrateRuntimeStores } = require('./brand-migration');
const { resolveRuntimeToken } = require('./runtime-token');

function atomicJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = file + '.tmp-' + process.pid + '-' + crypto.randomBytes(4).toString('hex');
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2), 'utf8');
  fs.renameSync(temporary, file);
}

function runtimePaths(options) {
  const home = path.resolve(options.home || path.join(os.homedir(), '.webagent'));
  const runtimeRoot = path.resolve(options.runtimeRoot || path.join(home, 'runtime-v2'));
  return {
    home,
    runtimeRoot,
    infoFile: path.resolve(options.infoFile || path.join(home, 'runtime.json')),
    tokenFile: path.resolve(options.tokenFile || process.env.WEBAGENT_RUNTIME_TOKEN_FILE || path.join(home, 'runtime-token')),
    legacyInfoFile: options.legacyInfoFile === false ? '' : path.resolve(options.legacyInfoFile || path.join(os.homedir(), '.dsa', 'runtime.json')),
    harnessHome: path.resolve(options.harnessHome || path.join(home, 'deepseek-harness')),
    rogatorHome: path.resolve(options.rogatorHome || path.join(home, 'qwen-gateway')),
    providerStoreFile: path.resolve(options.providerStoreFile || path.join(home, 'provider-configs.json'))
  };
}

function configureApiKeyStore(store, options) {
  if (!store || typeof store.configure !== 'function') return store;
  store.configure({
    vault: options.credentialVault,
    storeFile: options.paths.providerStoreFile,
    electronSafeStorage: options.electronSafeStorage || null
  });
  return store;
}

function createApiRegistry(options) {
  const registry = options.createModelRegistry();
  for (const service of options.apiKeyStore.listServices()) {
    if (!Array.isArray(service.models) || !service.models.length) continue;
    const models = service.models.map((model) => Object.assign({}, model, {
      provider: service.provider,
      providerKey: service.id || service.provider,
      providerDisplayName: service.name || service.provider
    }));
    const server = service.provider === 'anthropic'
      ? options.createAnthropicServer({ endpoint: service.endpoint, apiKey: service.apiKey, models })
      : options.createOpenAIServer({ endpoint: service.endpoint, apiKey: service.apiKey, protocol: service.protocol || 'auto', models });
    server.models = Object.fromEntries(models.map((model) => [model.id, model]));
    registry.register(service.id || service.provider, server);
  }
  return registry;
}

async function createRuntime(options) {
  options = options || {};
  const root = path.resolve(options.root || path.join(__dirname, '..', '..'));
  const paths = runtimePaths(options);
  const providerHost = options.providerHost;
  const vault = options.credentialVault;
  if (!providerHost || typeof providerHost.createWorker !== 'function') throw new Error('ProviderBrowserHost is required');
  if (!vault || typeof vault.encrypt !== 'function' || typeof vault.decrypt !== 'function') throw new Error('CredentialVault is required');

  if (options.migrateLegacy !== false) migrateLegacyHome({ home: options.userHome || os.homedir() });
  migrateRuntimeStores(options.legacyRuntimeRoots || [], paths.runtimeRoot);
  const store = new SessionStore(paths.runtimeRoot).init();
  const config = new RuntimeConfigStore(paths.runtimeRoot).init();
  const apiKeyStore = configureApiKeyStore(options.apiKeyStore, { credentialVault: vault, paths, electronSafeStorage: options.electronSafeStorage });
  const registryOptions = {
    apiKeyStore,
    createModelRegistry: options.createModelRegistry,
    createOpenAIServer: options.createOpenAIServer,
    createAnthropicServer: options.createAnthropicServer
  };
  const buildRegistry = () => createApiRegistry(registryOptions);
  const encrypt = (value) => vault.encrypt(String(value || ''));
  const decrypt = (value) => vault.decrypt(String(value || ''));
  const rogator = new RogatorService({
    home: paths.rogatorHome,
    source: process.env.WEBAGENT_ROGATOR_SOURCE || path.join(paths.rogatorHome, 'source'),
    runner: path.join(root, 'integrations', 'rogator-qwen', 'webagent_runner.py'),
    encrypt,
    decrypt,
    authenticate: () => providerHost.openLogin('qwen-gateway'),
    getBrowserCredentials: () => providerHost.getBrowserCredentials('qwen-gateway')
  });

  const mcp = new McpService({ config });
  try {
    const result = await mcp.init();
    if (result && result.success === false) console.warn('[MCP] initialization failed:', result.error);
    else if (result && result.message === 'No MCP servers configured') console.log('[MCP] no servers configured');
    else if (result && Array.isArray(result.results)) {
      const failed = result.results.filter((item) => !item.success && item.error !== 'disabled');
      console.log('[MCP] initialized:', result.results.length - failed.length, '/', result.results.length, 'servers');
      for (const item of failed) console.warn('[MCP] ' + item.name + ' failed:', item.error);
    }
  } catch (error) { console.warn('[MCP] initialization failed:', error.message); }
  const deepseekModels = Object.values(options.createDeepseekServer(() => null).models);
  const qwenModels = Object.values(options.createQwenServer(() => null).models);
  const chatgptModels = Object.values(options.createChatGPTServer(() => null).models);
  const providers = new ProviderManager({
    apiRegistry: buildRegistry(),
    rogator,
    webModels: deepseekModels.concat(qwenModels, chatgptModels, gatewayModels()),
    qwenMax: Number(process.env.WEBAGENT_QWEN_MAX || process.env.DSAGENT_QWEN_MAX) || 8,
    chatgptMax: Number(process.env.WEBAGENT_CHATGPT_MAX || process.env.DSAGENT_CHATGPT_MAX) || config.getSettings().runtime.chatgpt_max_workers || 2,
    webFactories: {
      deepseek: (binding) => providerHost.createWorker('deepseek', binding),
      qwen: (binding) => providerHost.createWorker('qwen', binding),
      chatgpt: (binding) => providerHost.createWorker('chatgpt', binding)
    },
    onAuthRequired: (provider, owner) => providerHost.openLogin(provider, owner),
    accountManager: providerHost
  });
  const tools = new ToolRegistry({ config });
  providers.setToolRegistry(tools);
  const approvals = new ApprovalService({ config });
  const workMemory = new WorkMemoryService({ defaultRoot: process.env.WEBAGENT_WORK_ROOT || 'D:\\Work\\WAWorkSpace' });
  const contextManager = new ContextManager({ store, providers });
  const runs = new RunService({ store, providers, config, toolRegistry: tools, approvals, contextManager, workMemory });
  const mobile = new MobileGateway({ store, runs, config });
  const bots = new BotGateway({ store, runs, config, providers });
  const capabilities = new CapabilityService({ providers, tools, bots, config });
  const providerConfigs = new ProviderConfigService({ store: apiKeyStore, reload: async () => providers.setApiRegistry(buildRegistry()) });
  const token = resolveRuntimeToken(paths.tokenFile);
  const modelApi = new ModelApiService({ home: path.join(paths.runtimeRoot, 'model-api'), getModels: () => providers.listModels(), encrypt, decrypt });
  const api = new RuntimeApiServer({
    store, providers, runs, capabilities, config, tools, approvals, mobile, bots,
    providerConfigs, contextManager, workMemory, rogator, modelApi, token,
    port: Number(options.port || process.env.WEBAGENT_PORT || process.env.DSAGENT_PORT) || 5858
  });
  const address = await api.start();
  modelApi.setRuntime({ port: address.port, token });
  if (modelApi.status().enabled) {
    try { await modelApi.restore(); } catch (error) { console.warn('[Model API] restore failed:', error.message); }
  }
  const harness = new DeepSeekHarnessService({ root, runtimePort: address.port, runtimeToken: token, home: paths.harnessHome });
  api.harness = harness;
  api.mcp = mcp;
  const info = {
    version: 3,
    product: 'WebAgent',
    architecture: options.architecture || 'node',
    app_version: String(options.appVersion || '0.0.0'),
    pid: process.pid,
    host: address.host,
    port: address.port,
    token,
    providers: providers.supportedWebProviders(),
    started_at: new Date().toISOString()
  };
  atomicJson(paths.infoFile, info);
  if (paths.legacyInfoFile) atomicJson(paths.legacyInfoFile, info);
  if (config.getSettings().mobile.enabled) await mobile.start(config.getSettings().mobile.port);
  return {
    root, paths, store, config, providers, runs, api, tools, approvals, mobile,
    bots, providerConfigs, contextManager, workMemory, harness, rogator, modelApi, mcp,
    providerHost, apiKeyStore, credentialVault: vault, info,
    async close() {
      try { await api.close(); } catch (_) {}
      try { await modelApi.stop(false); } catch (_) {}
      try { await providers.close(); } catch (_) {}
      try { await mobile.stop(); } catch (_) {}
      try { await harness.stop(); } catch (_) {}
      try { await mcp.shutdown(); } catch (_) {}
      try { await providerHost.close(); } catch (_) {}
      for (const file of [paths.infoFile, paths.legacyInfoFile].filter(Boolean)) {
        try {
          const current = JSON.parse(fs.readFileSync(file, 'utf8'));
          if (Number(current.pid) === process.pid) fs.unlinkSync(file);
        } catch (_) {}
      }
    }
  };
}

module.exports = { createRuntime, createApiRegistry, runtimePaths, atomicJson };
