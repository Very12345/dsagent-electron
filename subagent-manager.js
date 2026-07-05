// subagent-manager.js — Subagent 管理器
// Subagent: 独立上下文、独立人设、独立工具权限、可多层嵌套
// 参考 Claude Code 的 subagent 设计
'use strict';

// 预设 Subagent 模板
const SUBAGENT_TEMPLATES = {
    'file-reader': {
        id: 'file-reader',
        displayName: '文件阅读器',
        description: '读取并总结文件内容，不执行任何修改操作',
        systemPrompt: '你是一个文件阅读助手。你的任务是读取用户指定的文件，返回文件内容的结构化总结。不要执行任何修改操作。返回格式：文件路径、大小、主要内容摘要（按章节或代码块）。',
        toolWhitelist: ['read', 'list', 'info'],
        defaultModelRole: 'fast'
    },
    'bug-hunter': {
        id: 'bug-hunter',
        displayName: '找 Bug 专员',
        description: '分析代码寻找 bug，输出问题清单',
        systemPrompt: '你是一个代码审查专家，专门寻找代码中的 bug。分析给定代码，输出：1) 发现的 bug（含位置和原因）2) 严重程度 3) 建议修复方案。不要直接修改代码。',
        toolWhitelist: ['read', 'list', 'grep', 'info'],
        defaultModelRole: 'main'
    },
    'code-reviewer': {
        id: 'code-reviewer',
        displayName: '代码审查员',
        description: '全面代码审查：风格、安全、性能、可维护性',
        systemPrompt: '你是一个资深代码审查员。从代码风格、安全性、性能、可维护性四个维度审查代码，输出结构化报告。每个维度给出评分（1-5）和具体建议。',
        toolWhitelist: ['read', 'list', 'grep', 'info'],
        defaultModelRole: 'main'
    },
    'web-researcher': {
        id: 'web-researcher',
        displayName: '网络研究员',
        description: '联网搜索并总结信息',
        systemPrompt: '你是一个网络研究助手。根据用户问题联网搜索，返回结构化结果：关键发现、来源链接、置信度评估。',
        toolWhitelist: ['exec', 'read'],
        defaultModelRole: 'main'
    },
    'executor': {
        id: 'executor',
        displayName: '受限执行器',
        description: '在受限工具白名单内执行命令',
        systemPrompt: '你是一个受限执行助手。只执行用户明确指定的命令，不做额外探索。执行后返回：命令、stdout、stderr、退出码。危险命令前需确认。',
        toolWhitelist: ['exec', 'read', 'list'],
        defaultModelRole: 'fast'
    },
    'planner': {
        id: 'planner',
        displayName: '规划师',
        description: '分析任务并输出执行计划，不执行',
        systemPrompt: '你是一个任务规划师。分析用户任务，输出分步执行计划（含每步所需工具和预期结果）。不执行任何操作。',
        toolWhitelist: ['read', 'list', 'info'],
        defaultModelRole: 'main'
    }
};

function createSubagentManager(orchestratorRef) {
    // orchestratorRef: 函数，返回 orchestrator 实例（用于嵌套调用 agentRequest）
    const getOrchestrator = typeof orchestratorRef === 'function' ? orchestratorRef : () => orchestratorRef;

    // 运行中的 subagent 实例
    const activeSubagents = new Map();

    // 列出所有可用模板
    function listTemplates() {
        return Object.keys(SUBAGENT_TEMPLATES).map((k) => SUBAGENT_TEMPLATES[k]);
    }

    function getTemplate(templateId) {
        return SUBAGENT_TEMPLATES[templateId] || null;
    }

    // 触发一个 subagent
    // params: { template, prompt, modelOverride?, parentAgentId?, depth?, files? }
    // 防御性兜底：容忍 task 字段名错位（tool-subagent.js/main.js 旧版传 task 而非 prompt）
    async function invoke(params) {
        if (!params || typeof params !== 'object') {
            return { success: false, error: 'invoke 参数须为对象 {template, prompt}' };
        }
        if (!params.prompt && params.task) params.prompt = params.task;
        const tpl = getTemplate(params.template);
        if (!tpl) return { success: false, error: 'Unknown subagent template: ' + params.template };

        const depth = (params.depth || 0) + 1;
        if (depth > 5) {
            return { success: false, error: 'Subagent nesting depth exceeded (max 5)' };
        }

        const agentId = 'subagent-' + Date.now() + '-' + Math.random().toString(36).substring(2, 8);
        const instance = {
            agentId: agentId,
            template: tpl,
            prompt: params.prompt,
            depth: depth,
            parentAgentId: params.parentAgentId || null,
            startedAt: new Date().toISOString(),
            toolWhitelist: tpl.toolWhitelist,
            modelOverride: params.modelOverride || null
        };
        activeSubagents.set(agentId, instance);

        try {
            const orch = getOrchestrator();
            if (!orch) return { success: false, error: 'Orchestrator not available' };

            // 通过 orchestrator 发起 subagent 请求（独立上下文）
            const result = await orch.handleSubagentRequest({
                agentId: agentId,
                template: tpl,
                prompt: params.prompt,
                modelOverride: params.modelOverride,
                toolWhitelist: tpl.toolWhitelist,
                files: params.files || [],
                depth: depth
            });

            return { success: true, agentId: agentId, data: result };
        } catch (e) {
            return { success: false, error: e.message, agentId: agentId };
        } finally {
            activeSubagents.delete(agentId);
        }
    }

    // AI 输出文本中的 subagent 标签解析：XML 格式 <subagent:invoke...> 和 JSON 格式 {"subagent":{...}}
    // JSON 格式避免 Qwen 页面将 <...> 渲染为 HTML
    function parseSubagentTags(text) {
        const results = [];
        // 格式1：JSON 格式 {"subagent":{"template":"...","prompt":"...","content":"..."}}
        const jsonRegex = /\{\s*"subagent"\s*:\s*\{([\s\S]*?)\}\s*\}/g;
        let jm;
        while ((jm = jsonRegex.exec(text)) !== null) {
            try {
                const full = JSON.parse(jm[0]);
                const sa = full.subagent;
                if (sa && sa.template && sa.prompt) {
                    results.push({
                        template: sa.template,
                        modelOverride: sa.model || null,
                        prompt: sa.prompt + (sa.content ? '\n' + sa.content : '')
                    });
                    continue;
                }
            } catch(e) { /* 非 JSON，继续尝试 XML */ }
        }
        // 格式2：XML 格式 <subagent:invoke template="..." prompt="...">...</subagent:invoke>
        const xmlRegex = /<subagent:invoke\s+template="([^"]+)"(?:\s+model="([^"]+)")?\s*>([\s\S]*?)<\/subagent:invoke>/g;
        let match;
        while ((match = xmlRegex.exec(text)) !== null) {
            results.push({
                template: match[1],
                modelOverride: match[2] || null,
                prompt: match[3].trim()
            });
        }
        return results;
    }

    // 从 AI 回复中提取所有 subagent 调用并并发执行
    // 每个 subagent 创建独立 URL，由 server 层的 slot 系统管理实际并发数
    async function executeFromResponse(text, parentAgentId, depth) {
        const calls = parseSubagentTags(text);
        if (calls.length === 0) return [];
        const promises = calls.map((call) =>
            invoke({
                template: call.template,
                prompt: call.prompt,
                modelOverride: call.modelOverride,
                parentAgentId: parentAgentId,
                depth: depth || 0
            }).then((r) => ({
                template: call.template,
                prompt: call.prompt,
                success: r.success,
                data: r.data,
                error: r.error
            }))
        );
        return await Promise.all(promises);
    }

    function getActiveSubagents() {
        return Array.from(activeSubagents.values());
    }

    return {
        listTemplates,
        getTemplate,
        invoke,
        parseSubagentTags,
        executeFromResponse,
        getActiveSubagents,
        TEMPLATES: SUBAGENT_TEMPLATES
    };
}

module.exports = { createSubagentManager, SUBAGENT_TEMPLATES };
