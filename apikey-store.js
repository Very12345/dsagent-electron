// apikey-store.js — API Key encrypted storage
// This module is intentionally Electron-free. A CredentialVault can be injected
// by the desktop shell, while the Node runtime defaults to the operating-system
// credential backend exposed by src/runtime/credential-vault.js.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { CredentialVault } = require('./src/runtime/credential-vault');

const DEFAULT_STORE_NAME = '.dsa-apikey-store.json';
const OBF_KEY = 'dsagent-apikey-obf-2026';

let configuration = {};
let configuredVault = null;

function configure(options = {}) {
    configuration = Object.assign({}, configuration, options);
    const hasVaultOption = Object.prototype.hasOwnProperty.call(options, 'vault');
    const hasBackendOption = !!(options.safeStorage || options.electronSafeStorage || options.backend || options.legacyDecrypt);
    if (hasVaultOption) configuredVault = options.vault || null;
    if (!hasVaultOption && hasBackendOption) {
        configuredVault = new CredentialVault({
            safeStorage: options.safeStorage || options.electronSafeStorage,
            backend: options.backend,
            legacyDecrypt: options.legacyDecrypt,
            onLegacyDecrypted: options.onLegacyDecrypted,
            platform: options.platform,
            powershellPath: options.powershellPath,
            spawnSync: options.spawnSync,
            serviceName: options.serviceName
        });
    }
    return { storeFile: resolveStoreFile(), vault: getVault() };
}

function resetConfiguration() {
    configuration = {};
    configuredVault = null;
}

function getVault() {
    if (!configuredVault) configuredVault = new CredentialVault();
    return configuredVault;
}

function resolveStoreFile() {
    if (typeof configuration.storeFile === 'function') return path.resolve(String(configuration.storeFile()));
    if (configuration.storeFile) return path.resolve(String(configuration.storeFile));
    if (configuration.userDataPath) return path.join(path.resolve(String(configuration.userDataPath)), DEFAULT_STORE_NAME);
    if (configuration.app && typeof configuration.app.getPath === 'function') {
        return path.join(configuration.app.getPath('userData'), DEFAULT_STORE_NAME);
    }
    const configuredHome = process.env.WEBAGENT_HOME || process.env.WEBAGENT_USER_DATA;
    return path.join(configuredHome ? path.resolve(configuredHome) : path.join(os.homedir(), '.webagent'), DEFAULT_STORE_NAME);
}

function deobfuscate(b64) {
    if (!b64) return '';
    try {
        const raw = Buffer.from(b64, 'base64').toString('binary');
        const out = [];
        for (let i = 0; i < raw.length; i++) {
            out.push(String.fromCharCode(raw.charCodeAt(i) ^ OBF_KEY.charCodeAt(i % OBF_KEY.length)));
        }
        return out.join('');
    } catch (_) { return ''; }
}

function protect(value) {
    if (!value) return '';
    return getVault().encrypt(String(value));
}

function unprotect(value) {
    if (!value) return '';
    return getVault().decrypt(String(value));
}

function loadStore() {
    const file = resolveStoreFile();
    if (!fs.existsSync(file)) return { services: [] };

    let json;
    try {
        json = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (_) {
        return { services: [] };
    }
    if (!Array.isArray(json.services)) json.services = [];

    json.services.forEach((service) => {
        if (service._secret) service.apiKey = unprotect(service._secret);
        else if (service._ak) {
            // Read-only compatibility for the pre-safeStorage store. New writes
            // never use obfuscation and therefore cannot downgrade protection.
            service.apiKey = deobfuscate(service._ak);
            if (typeof configuration.onLegacyDecrypted === 'function') {
                configuration.onLegacyDecrypted({ backend: 'dsagent-obfuscation', ciphertext: service._ak });
            }
        }
        delete service._secret;
        delete service._ak;
    });
    return json;
}

function saveStore(store) {
    try {
        const file = resolveStoreFile();
        const toSave = { services: [] };
        for (const service of (store.services || [])) {
            toSave.services.push({
                id: service.id,
                provider: service.provider,
                name: service.name,
                endpoint: service.endpoint,
                protocol: service.protocol || 'auto',
                _secret: protect(service.apiKey || ''),
                models: service.models || []
            });
        }
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify(toSave, null, 2), { encoding: 'utf8', mode: 0o600 });
        return { success: true };
    } catch (error) {
        return { success: false, error: error.message, code: error.code || 'credential_store_write_failed' };
    }
}

// ===== CRUD =====
function listServices() {
    return loadStore().services || [];
}

function getService(id) {
    return listServices().find((service) => service.id === id) || null;
}

function addService(service) {
    const store = loadStore();
    if (!service.id) service.id = 'svc-' + Date.now() + '-' + Math.random().toString(36).substring(2, 8);
    store.services.push(service);
    const result = saveStore(store);
    return result.success ? { success: true, id: service.id } : result;
}

function updateService(id, patch) {
    const store = loadStore();
    const index = store.services.findIndex((service) => service.id === id);
    if (index < 0) return { success: false, error: 'Service not found: ' + id };
    store.services[index] = Object.assign({}, store.services[index], patch);
    return saveStore(store);
}

function deleteService(id) {
    const store = loadStore();
    store.services = store.services.filter((service) => service.id !== id);
    return saveStore(store);
}

// Generate the default capability matrix when a custom model omits it.
function defaultCapabilities(provider, apiName) {
    if (provider === 'anthropic') {
        return { inputMaxLen: 200000, file: { maxMB: 0, maxCount: 0, types: [] }, multimodal: { input: ['text', 'image'], output: ['text'] } };
    }
    const visionHints = ['gpt-4o', 'gpt-4-vision', 'vision', 'claude', 'glm-4v', 'qwen-vl'];
    const isVision = visionHints.some((hint) => String(apiName || '').toLowerCase().includes(hint));
    return {
        inputMaxLen: 128000,
        file: { maxMB: 0, maxCount: 0, types: [] },
        multimodal: { input: isVision ? ['text', 'image'] : ['text'], output: ['text'] }
    };
}

module.exports = {
    configure,
    resetConfiguration,
    listServices,
    getService,
    addService,
    updateService,
    deleteService,
    defaultCapabilities
};
