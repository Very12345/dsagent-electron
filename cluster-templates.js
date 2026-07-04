// cluster-templates.js — 智能体集群模板
// 定义"角色 → 能力要求"映射，配合 model-registry.filterByCapability 自动过滤可选模型
// 用户在 agentview 配置区选择模板，每个模板包含若干模型选型框
'use strict';

// 预设集群模板（仿 Claude Code 的模型选型思路）
const TEMPLATES = {
    'general': {
        id: 'general',
        displayName: '通用集群',
        description: '主模型 + 快速模型 + 多模态模型，覆盖大多数场景',
        roles: [
            { role: 'main', displayName: '主模型', required: true, criteria: {} },
            { role: 'fast', displayName: '快速模型', required: false, criteria: {} },
            { role: 'multimodal', displayName: '多模态模型', required: false, criteria: { multimodalInput: ['image'] } }
        ]
    },
    'code': {
        id: 'code',
        displayName: '代码集群',
        description: '大上下文主模型 + 快速执行模型，适合代码工程',
        roles: [
            { role: 'main', displayName: '主模型', required: true, criteria: {} },
            { role: 'fast', displayName: '快速执行模型', required: false, criteria: {} }
        ]
    },
    'vision': {
        id: 'vision',
        displayName: '视觉集群',
        description: '多模态输入输出，适合图像理解与生成',
        roles: [
            { role: 'main', displayName: '主模型（多模态）', required: true, criteria: { multimodalInput: ['image'] } },
            { role: 'output', displayName: '图像输出模型', required: false, criteria: { multimodalOutput: ['image'] } }
        ]
    },
    'minimal': {
        id: 'minimal',
        displayName: '极简集群',
        description: '仅一个模型，所有任务都走它',
        roles: [
            { role: 'main', displayName: '主模型', required: true, criteria: {} }
        ]
    },
    'custom': {
        id: 'custom',
        displayName: '自定义',
        description: '用户自由配置各角色',
        roles: [
            { role: 'main', displayName: '主模型', required: true, criteria: {} },
            { role: 'fast', displayName: '快速模型', required: false, criteria: {} },
            { role: 'multimodal', displayName: '多模态模型', required: false, criteria: {} },
            { role: 'subagent', displayName: 'Subagent 默认模型', required: false, criteria: {} }
        ]
    }
};

// 根据模板 + registry 生成"每个角色可选模型列表"
function buildSelectionOptions(templateId, registry) {
    const tpl = TEMPLATES[templateId];
    if (!tpl) return { success: false, error: 'Unknown template: ' + templateId };
    const roles = tpl.roles.map((r) => {
        const candidates = registry.filterByCapability(r.criteria || {});
        return {
            role: r.role,
            displayName: r.displayName,
            required: r.required,
            criteria: r.criteria,
            candidates: candidates.map((m) => ({ id: m.id, displayName: m.displayName || m.id, provider: m.provider }))
        };
    });
    return { success: true, template: tpl, roles: roles };
}

// 验证用户填写的 clusterConfig 是否合法（required 角色都选了、所选模型满足该角色 criteria）
function validateClusterConfig(templateId, clusterConfig, registry) {
    const tpl = TEMPLATES[templateId];
    if (!tpl) return { success: false, error: 'Unknown template' };
    for (const r of tpl.roles) {
        const chosen = clusterConfig[r.role];
        if (!chosen || !chosen.modelId) {
            if (r.required) return { success: false, error: '角色 ' + r.displayName + ' 必须选择模型' };
            continue;
        }
        const m = registry.getModel(chosen.modelId);
        if (!m) return { success: false, error: '模型不存在: ' + chosen.modelId };
        // 校验能力（保险）
        const cap = m.model.capabilities || {};
        if (r.criteria && r.criteria.multimodalInput) {
            const inputs = cap.multimodal && cap.multimodal.input || [];
            if (!r.criteria.multimodalInput.every((x) => inputs.indexOf(x) >= 0)) {
                return { success: false, error: '模型 ' + chosen.modelId + ' 不满足角色 ' + r.role + ' 的多模态输入要求' };
            }
        }
    }
    return { success: true };
}

// 默认集群配置（迁移期：保持现状 = DeepSeek quick）
function defaultClusterConfig() {
    return {
        templateId: 'minimal',
        roles: { main: { modelId: 'deepseek.fast' } },
        subagentDefaults: { modelId: 'deepseek.fast' }
    };
}

module.exports = {
    TEMPLATES,
    buildSelectionOptions,
    validateClusterConfig,
    defaultClusterConfig
};
