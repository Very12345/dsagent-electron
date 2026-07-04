// apikey-store.js — API Key 加密存储
// 管理用户自定义的 OpenAI/Anthropic 兼容服务配置（endpoint + apiKey + models）
// 存储路径: userData/.dsa-apikey-store.json，apiKey 用简单加密混淆（非强加密，本机存储）
'use strict';

const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const STORE_FILE = () => path.join(app.getPath('userData'), '.dsa-apikey-store.json');
// 简单 XOR 混淆 key（本机存储，防止明文裸露，非安全加密）
const OBF_KEY = 'dsagent-apikey-obf-2026';

function obfuscate(str) {
    if (!str) return '';
    const out = [];
    for (let i = 0; i < str.length; i++) {
        out.push(String.fromCharCode(str.charCodeAt(i) ^ OBF_KEY.charCodeAt(i % OBF_KEY.length)));
    }
    return Buffer.from(out.join(''), 'binary').toString('base64');
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
    } catch (e) { return ''; }
}

function loadStore() {
    try {
        const f = STORE_FILE();
        if (!fs.existsSync(f)) return { services: [] };
        const raw = fs.readFileSync(f, 'utf-8');
        const json = JSON.parse(raw);
        // 解密 apiKey
        if (json.services) {
            json.services.forEach((s) => {
                if (s._ak) s.apiKey = deobfuscate(s._ak);
                delete s._ak;
            });
        }
        return json;
    } catch (e) {
        return { services: [] };
    }
}

function saveStore(store) {
    try {
        const f = STORE_FILE();
        // 加密 apiKey
        const toSave = { services: [] };
        if (store.services) {
            store.services.forEach((s) => {
                toSave.services.push({
                    id: s.id,
                    provider: s.provider,        // 'openai' | 'anthropic'
                    name: s.name,                // 用户自定义名称
                    endpoint: s.endpoint,
                    _ak: obfuscate(s.apiKey || ''),
                    models: s.models || []       // [{id, displayName, apiName, capabilities}]
                });
            });
        }
        fs.writeFileSync(f, JSON.stringify(toSave, null, 2), 'utf-8');
        return { success: true };
    } catch (e) {
        return { success: false, error: e.message };
    }
}

// ===== CRUD =====
function listServices() {
    return loadStore().services || [];
}

function getService(id) {
    const list = listServices();
    return list.find((s) => s.id === id) || null;
}

function addService(service) {
    const store = loadStore();
    if (!service.id) service.id = 'svc-' + Date.now() + '-' + Math.random().toString(36).substring(2, 8);
    store.services.push(service);
    const r = saveStore(store);
    return r.success ? { success: true, id: service.id } : r;
}

function updateService(id, patch) {
    const store = loadStore();
    const idx = store.services.findIndex((s) => s.id === id);
    if (idx < 0) return { success: false, error: 'Service not found: ' + id };
    store.services[idx] = Object.assign({}, store.services[idx], patch);
    return saveStore(store);
}

function deleteService(id) {
    const store = loadStore();
    store.services = store.services.filter((s) => s.id !== id);
    return saveStore(store);
}

// 生成默认能力矩阵（用户添加模型时可省略）
function defaultCapabilities(provider, apiName) {
    if (provider === 'anthropic') {
        return { inputMaxLen: 200000, file: { maxMB: 0, maxCount: 0, types: [] }, multimodal: { input: ['text', 'image'], output: ['text'] } };
    }
    // openai 兼容
    // 视觉模型探测
    const visionHints = ['gpt-4o', 'gpt-4-vision', 'vision', 'claude', 'glm-4v', 'qwen-vl'];
    const isVision = visionHints.some((h) => apiName.toLowerCase().indexOf(h) >= 0);
    return {
        inputMaxLen: 128000,
        file: { maxMB: 0, maxCount: 0, types: [] },
        multimodal: { input: isVision ? ['text', 'image'] : ['text'], output: ['text'] }
    };
}

module.exports = {
    listServices,
    getService,
    addService,
    updateService,
    deleteService,
    defaultCapabilities
};
