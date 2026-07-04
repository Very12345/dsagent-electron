// model-registry.js — 全局模型注册表
// 汇总所有 server（deepseek/qwen/openai/anthropic）注册的模型，提供统一查询/路由
'use strict';

function createModelRegistry() {
    // servers: { providerName: serverInstance }
    const servers = {};
    // models: { modelId: { provider, server, model } }
    const models = {};

    function register(providerName, server) {
        servers[providerName] = server;
        // 拉取该 server 的所有模型
        const modelMap = server.models || {};
        Object.keys(modelMap).forEach((mid) => {
            models[mid] = { provider: providerName, server: server, model: modelMap[mid] };
        });
    }

    function unregister(providerName) {
        delete servers[providerName];
        Object.keys(models).forEach((mid) => {
            if (models[mid].provider === providerName) delete models[mid];
        });
    }

    function listModels() {
        return Object.keys(models).map((mid) => Object.assign({ id: mid }, models[mid].model));
    }

    function getModel(modelId) {
        return models[modelId] || null;
    }

    function getCapabilities(modelId) {
        const m = models[modelId];
        return m ? (m.model.capabilities || {}) : null;
    }

    // 路由到对应 server 并 invoke
    async function invoke(modelId, op, args) {
        const m = models[modelId];
        if (!m) return { success: false, error: 'Model not registered: ' + modelId };
        try {
            return await m.server.invoke(modelId, op, args || {});
        } catch (e) {
            return { success: false, error: (e && (e.message || String(e))) || '未知错误: ' + JSON.stringify(e) };
        }
    }

    // 按能力过滤模型（供 cluster-templates 选型框用）
    function filterByCapability(criteria) {
        // criteria: { multimodalInput?: ['image'], supportsFile?: true, minInputLen?: N, provider?: '...' }
        const result = [];
        Object.keys(models).forEach((mid) => {
            const m = models[mid];
            const cap = m.model.capabilities || {};
            if (criteria.provider && m.provider !== criteria.provider) return;
            if (criteria.multimodalInput && criteria.multimodalInput.length > 0) {
                const inputs = cap.multimodal && cap.multimodal.input || [];
                if (!criteria.multimodalInput.every((x) => inputs.indexOf(x) >= 0)) return;
            }
            if (criteria.multimodalOutput && criteria.multimodalOutput.length > 0) {
                const outputs = cap.multimodal && cap.multimodal.output || [];
                if (!criteria.multimodalOutput.every((x) => outputs.indexOf(x) >= 0)) return;
            }
            if (criteria.supportsFile) {
                const f = cap.file || {};
                const totalCap = (f.maxCount || 0);
                if (totalCap === 0) return;
            }
            if (criteria.minInputLen && (cap.inputMaxLen || 0) < criteria.minInputLen) return;
            result.push(Object.assign({ id: mid, provider: m.provider }, m.model));
        });
        return result;
    }

    // 启动所有 server 的轮询
    function startAllPoll(intervalMs) {
        Object.keys(servers).forEach((p) => {
            if (servers[p].startPoll) servers[p].startPoll(intervalMs);
        });
    }
    function stopAllPoll() {
        Object.keys(servers).forEach((p) => {
            if (servers[p].stopPoll) servers[p].stopPoll();
        });
    }

    // 查询所有 server 的并发槽位状态
    function getAllSlotStatus() {
        const out = {};
        Object.keys(servers).forEach((p) => {
            out[p] = servers[p].getSlotStatus ? servers[p].getSlotStatus() : null;
        });
        return out;
    }

    return {
        register,
        unregister,
        listModels,
        getModel,
        getCapabilities,
        invoke,
        filterByCapability,
        startAllPoll,
        stopAllPoll,
        getAllSlotStatus,
        servers
    };
}

module.exports = { createModelRegistry };
