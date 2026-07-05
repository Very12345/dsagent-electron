// agent-orchestrator.js — 主进程编排层
// 接收前端 agentRequest，按集群配置路由到对应 server，处理历史注入/缓存/subagent
'use strict';

const { app } = require('electron');
const fs = require('fs');
const path = require('path');
const responseProcessor = require('./lib/response-processor.js');

function createOrchestrator(deps) {
    // deps: { registry, subagentManager, historyManager, getInitPromptFn }
    // 注意：subagentManager 可能在构造后回填（因循环依赖），用 getter 动态读取
    const registry = deps.registry;
    let _subagentManager = deps.subagentManager;
    const historyManager = deps.historyManager;
    const getInitPromptFn = deps.getInitPromptFn;       // (mode) => Promise<string>
    const getClusterConfigFn = deps.getClusterConfigFn; // () => clusterConfig
    const saveClusterConfigFn = deps.saveClusterConfigFn;

    function getSubagentManager() {
        return _subagentManager || (orchestratorInstance && orchestratorInstance.subagentManager);
    }

    // 对话上下文缓存：{ agentId → { modelId, conversationUrl, historyInjected, lastResponse, turnCount, lastCompressAt } }
    const contexts = new Map();

    // 历史注入分段长度（按字符估算，超过 effectiveWindow 一定比例就分段）
    const INJECT_SEGMENT_RATIO = 0.4;  // 每段 = effectiveWindow * 0.4

    // ===== 网页滑动窗口估算（P0: 窗口校准） =====
    // 网页侧（DeepSeek/Qwen 服务器）真实上下文窗口无法直接观测，
    // inputMaxLen 是模型标称值，服务端实际保留的有效上下文通常更小。
    // 用 effectiveWindow 作为保守估算，所有压缩/注入阈值都基于它而非 inputMaxLen。
    // 用户可在 model.capabilities.effectiveWindow 中显式配置；否则取 inputMaxLen * 0.6。
    const DEFAULT_WINDOW_RATIO = 0.6;

    function getEffectiveWindow(model) {
        const cap = (model && model.model && model.model.capabilities) || {};
        if (cap.effectiveWindow && cap.effectiveWindow > 0) return cap.effectiveWindow;
        const inputMaxLen = cap.inputMaxLen || 32768;
        return Math.floor(inputMaxLen * DEFAULT_WINDOW_RATIO);
    }

    // 持续对话压缩触发阈值：当本地累计消息字符数超过 effectiveWindow 的 70% 时，
    // 认为网页侧最早上下文可能已被滑动出窗口，需要给当前 userText 追加"近期关键事实"前缀。
    const CONTINUOUS_COMPRESS_RATIO = 0.7;
    // 触发压缩后保留近多少条消息作为"近期"全量
    const CONTINUOUS_KEEP_LATEST = 5;
    // 同一会话两次压缩之间的最小轮次间隔，避免每轮都重算摘要
    const COMPRESS_MIN_TURN_GAP = 3;

    // ===== 工具函数：剥离 system-reminder（不存入历史） =====
    function stripSystemReminder(text) {
        if (!text) return text;
        return text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim();
    }

    // ===== 压缩后状态追踪 =====
    var _compressState = { task: '', filesEdited: [], filesRead: [] };
    var _planMode = false;  // plan mode 标记

    // ===== Plan Mode 支持 =====
    function isPlanMode() { return _planMode; }
    function setPlanMode(enabled) {
        _planMode = !!enabled;
        console.log('[Orch] Plan mode ' + (_planMode ? 'enabled' : 'disabled'));
        return { success: true, planMode: _planMode };
    }

    // ===== 工具过滤：plan mode 下只允许读取工具 =====
    var READ_ONLY_TOOLS = ['read', 'glob', 'grep', 'help', 'findstr', 'list', 'ls', 'dir',
                           'displayWidth', 'stripAnsi', 'visualWrap', 'echoLine', 'echoSystem',
                           'listDirectory', 'list_symbols', 'read_symbol', 'find_references',
                           'trace_callers', 'trace_callees', 'trace_chain', 'blast_radius',
                           'file_dependencies', 'web_fetch', 'web_search', 'recall'];

    function filterToolsForPlanMode(toolList) {
        if (!_planMode) return toolList;
        return toolList.filter(function(t) {
            return READ_ONLY_TOOLS.indexOf(t.name || t) >= 0;
        });
    }
    function recordFileOp(type, path) {
        if (type === 'read') {
            if (!_compressState.filesRead.includes(path)) _compressState.filesRead.push(path);
        } else if (type === 'edit' || type === 'save') {
            if (!_compressState.filesEdited.includes(path)) _compressState.filesEdited.push(path);
        }
        // 限制列表长度
        if (_compressState.filesRead.length > 20) _compressState.filesRead.shift();
        if (_compressState.filesEdited.length > 20) _compressState.filesEdited.shift();
    }
    function buildCompressStateReminder() {
        var parts = [];
        if (_compressState.task) parts.push('TASK: ' + _compressState.task);
        if (_compressState.filesEdited.length > 0) parts.push('FILES EDITED: ' + _compressState.filesEdited.join(', '));
        if (_compressState.filesRead.length > 0) parts.push('FILES READ: ' + _compressState.filesRead.join(', '));
        if (parts.length === 0 && !_planMode) return '';
        var lines = parts.join('\n');
        if (_planMode) {
            var planLine = 'PLAN MODE is active. Do NOT create, edit, or delete files. Investigate with read-only tools then present a plan and STOP.';
            lines = lines ? planLine + '\n' + lines : planLine;
        }
        return '\n\n<system-reminder>\n' + lines + '\n</system-reminder>';
    }

    // ===== 核心入口：处理 agentRequest =====
    async function handleRequest(payload) {
        // payload: { agentId, clusterConfig?, history, message, files, subagent? }
        const agentId = payload.agentId || 'main';
        const clusterConfig = payload.clusterConfig || (getClusterConfigFn ? getClusterConfigFn() : null);
        console.log('[Orch] handleRequest agentId=%s clusterConfig=%j', agentId, clusterConfig);
        if (!clusterConfig) {
            return { success: false, error: 'No cluster config available' };
        }

        // 选模型：根据消息角色选对应 clusterConfig 角色
        const role = payload.role || 'main';
        const roleConfig = clusterConfig.roles && clusterConfig.roles[role];
        if (!roleConfig || !roleConfig.modelId) {
            return { success: false, error: 'Role "' + role + '" has no model configured' };
        }
        const modelId = roleConfig.modelId;
        const model = registry.getModel(modelId);
        if (!model) return { success: false, error: 'Model not found: ' + modelId };

        const cap = model.model.capabilities || {};
        const effectiveWindow = getEffectiveWindow(model);

        try {
            // 1. 获取或创建上下文
            let ctx = contexts.get(agentId);
            // L2 缓存丢失兜底：从 L1 历史反查 conversationUrl 重建 ctx（避免重启后误建新对话）
            if (!ctx && payload.history && payload.history.id && payload.history.conversationUrl) {
                ctx = {
                    agentId: agentId,
                    modelId: modelId,
                    conversationUrl: payload.history.conversationUrl,
                    historyInjected: true,  // L1 已有的历史，网页侧也已有，不必重灌
                    injectedSegments: 0,
                    lastResponse: '',
                    turnCount: (payload.history.messages || []).length,
                    lastCompressAt: 0,
                    _messageAlreadySent: false,
                    _recoveredFromL1: true
                };
                contexts.set(agentId, ctx);
                console.log('[Orch] ctx recovered from L1 history, convUrl=' + ctx.conversationUrl.substring(0, 60));
            }
            const isNewConversation = !ctx || !ctx.conversationUrl || payload.forceNew;

            // 2. 决定是否需要新建对话 / 历史注入
            if (isNewConversation) {
                // 新建对话 — 直接将用户消息作为 userText 传过去，
                // 让 inject 脚本合并在初始提示词中一次发送，避免 AI 先输出"就绪"再重新处理
                const initialUserText = payload.message && payload.message.text || '';
                console.log('[Orch] newChat start modelId=%s userText=%s', modelId, initialUserText ? initialUserText.substring(0, 80) : '(none)');
                const newRes = await registry.invoke(modelId, 'newChat', { deepThink: !!payload.deepThink, webSearch: !!payload.webSearch, userText: initialUserText });
                console.log('[Orch] newChat result:', JSON.stringify(newRes));
                if (!newRes.success) return newRes;
                const convUrl = newRes.data && newRes.data.conversationUrl || '';
                ctx = {
                    agentId: agentId,
                    modelId: modelId,
                    conversationUrl: convUrl,
                    historyInjected: false,
                    injectedSegments: 0,
                    lastResponse: '',
                    turnCount: 0,
                    lastCompressAt: 0,
                    _messageAlreadySent: !!(initialUserText)  // 如果 userText 已随 newChat 发送，标记跳过后续 sendMessage
                };
                contexts.set(agentId, ctx);

                // 历史注入（如果带了 history 且超长）— 阈值用 effectiveWindow 而非 inputMaxLen
                if (payload.history && payload.history.messages && payload.history.messages.length > 0) {
                    const injectResult = await injectHistory(modelId, payload.history.messages, effectiveWindow, ctx && ctx.conversationUrl);
                    if (!injectResult.success) {
                        return { success: false, error: 'History injection failed: ' + injectResult.error, partial: true };
                    }
                    ctx.historyInjected = true;
                    ctx.injectedSegments = injectResult.segments;
                    ctx.turnCount = (payload.history.messages || []).length;
                }
            } else {
                // 已有对话：导航回去（网页版需要）
                // 重置发送标记：新消息需要重新 sendMessage
                ctx._messageAlreadySent = false;
                if (ctx.conversationUrl && model.provider !== 'openai' && model.provider !== 'anthropic') {
                    const curUrlRes = await registry.invoke(modelId, 'getCurrentUrl', {});
                    const curUrl = curUrlRes.success ? curUrlRes.data.url : '';
                    if (curUrl !== ctx.conversationUrl) {
                        await registry.invoke(modelId, 'navigateToUrl', { url: ctx.conversationUrl });
                    }
                }
                // DeepSeek 网页版：每次发消息前同步模式/深度思考/联网搜索设置
                // （原 agent-send-message 已有对话分支的逻辑，合并至此）
                if (model.provider === 'deepseek') {
                    try {
                        await registry.invoke(modelId, 'switchModel', {});
                        await registry.invoke(modelId, 'setDeepThink', { enable: !!payload.deepThink });
                        await registry.invoke(modelId, 'setWebSearch', { enable: !!payload.webSearch });
                    } catch (e) { console.warn('[Orch] mode sync error:', e.message); }
                    await new Promise(r => setTimeout(r, 500)); // 等待 UI 切换生效
                }

                // P0: 持续对话压缩触发——同一 URL 聊久了，网页侧最早上下文会被滑出窗口，
                // 本地以为 AI 还记得的内容实际已丢。这里在 userText 前追加"近期关键事实"前缀，
                // 让 AI 知道哪些早期内容可能已不可见，引用时需重新说明。
                // 不重灌历史（避免和网页侧已有内容重复），只追加一份本地生成的摘要。
                if (payload.history && payload.history.messages && payload.history.messages.length > 0) {
                    const histMessages = payload.history.messages;
                    const totalChars = histMessages.reduce(function(s, m) { return s + (m.content || '').length; }, 0);
                    const compressThreshold = Math.floor(effectiveWindow * CONTINUOUS_COMPRESS_RATIO);
                    const turnsSinceLastCompress = ctx.turnCount - (ctx.lastCompressAt || 0);
                    if (totalChars > compressThreshold
                        && histMessages.length > CONTINUOUS_KEEP_LATEST * 2
                        && turnsSinceLastCompress >= COMPRESS_MIN_TURN_GAP) {
                        const compressMessages = histMessages.slice(0, -CONTINUOUS_KEEP_LATEST * 2);
                        const summaryLines = compressMessages.map(function(m) {
                            var role = m.role === 'assistant' ? 'AI' : '用户';
                            var content = (m.content || '').replace(/<[^>]*>/g, '');
                            var preview = content.substring(0, 150);
                            return role + ': ' + preview + (content.length > 150 ? '...' : '');
                        }).join('\n');
                        ctx._continuousCompressPrefix = '【⚠️ 网页侧滑动窗口提示】\n'
                            + '以下早期内容（共 ' + compressMessages.length + ' 条消息）可能已超出网页侧有效上下文窗口，'
                            + '你或许不再可见原文。若需引用，请向用户重新说明，不要假设你记得细节：\n'
                            + summaryLines + '\n\n---\n\n';
                        ctx.lastCompressAt = ctx.turnCount;
                        console.log('[Orch] continuous compress triggered: ' + compressMessages.length + ' msgs summarized, totalChars=' + totalChars + ' threshold=' + compressThreshold);
                    }
                }
            }

            // 3. 文件能力校验
            if (payload.files && payload.files.length > 0) {
                const fileCap = cap.file || {};
                if ((fileCap.maxCount || 0) === 0 && (!fileCap.doc || fileCap.doc.maxCount === 0)) {
                    return { success: false, error: '模型 ' + modelId + ' 不支持文件上传' };
                }
            }

            // 4. 发送消息（如果 newChat 已附带 userText 发送，则跳过）
            if (!ctx._messageAlreadySent) {
                var userText = payload.message && payload.message.text || '';
                // 持续对话压缩前缀（P0: 网页滑动窗口对齐）——在用户消息前追加早期摘要
                var continuousPrefix = ctx._continuousCompressPrefix || '';
                if (continuousPrefix) {
                    ctx._continuousCompressPrefix = '';  // 用完即清，避免下轮重复
                }
                // 压缩后状态恢复：注入 TASK + FILES EDITED/READ
                var compressReminder = buildCompressStateReminder();
                var finalText = (continuousPrefix ? continuousPrefix : '') + userText + (compressReminder ? compressReminder : '');
                const sendArgs = {
                    text: finalText,
                    files: payload.files || [],
                    images: payload.images || [],
                    systemPrompt: payload.systemPrompt || null,
                    timeout: payload.timeout || 180000,
                    _conversationUrl: ctx && ctx.conversationUrl
                };
                // Rate-Limit 自动重试（最多 2 次）
                let sendRes = await registry.invoke(modelId, 'sendMessage', sendArgs);
                if (!sendRes.success && sendRes.error === 'rate_limited') {
                    var retryAfter = sendRes.retryAfter || 60;
                    console.log('[Orch] Rate limited, retrying after ' + retryAfter + 's');
                    await new Promise(function(r) { setTimeout(r, retryAfter * 1000); });
                    sendRes = await registry.invoke(modelId, 'sendMessage', sendArgs);
                    if (!sendRes.success && sendRes.error === 'rate_limited') {
                        retryAfter = sendRes.retryAfter || 120;
                        console.log('[Orch] Rate limited again, retrying after ' + retryAfter + 's');
                        await new Promise(function(r) { setTimeout(r, retryAfter * 1000); });
                        sendRes = await registry.invoke(modelId, 'sendMessage', sendArgs);
                    }
                }
                if (!sendRes.success) return sendRes;
            }

            // 5. 等待生成完成（网页版需要；API 版立即返回）
            // 异步模式（agentview）：waitForComplete=false 时跳过等待，立即返回（AI 回复靠 inject 异步推送）
            const waitForComplete = payload.waitForComplete !== false;
            if (!waitForComplete) {
                // agentview 异步模式：newChat/sendMessage 已触发，立即返回 conversationUrl
                if (model.provider !== 'openai' && model.provider !== 'anthropic') {
                    const curUrlRes = await registry.invoke(modelId, 'getCurrentUrl', {});
                    if (curUrlRes.success && curUrlRes.data && curUrlRes.data.url) {
                        ctx.conversationUrl = curUrlRes.data.url;
                    }
                }
                return {
                    success: true,
                    data: { markdown: '', conversationUrl: ctx.conversationUrl, modelId: modelId, async: true }
                };
            }

            const waitRes = await registry.invoke(modelId, 'waitForDone', { timeout: payload.timeout || 180000 });
            if (!waitRes.success) return waitRes;

            // 5b. DeepSeek inject 层在 AI 回复后自动执行工具并把结果 fillAndSend 发回 AI，
            // 触发新一轮生成，且 inject 会主动通过 agentForwardResult 推送 segments。
            // CLI 同步模式（!_skipToolLoopWait）：不再自己 extractResponse（会和 inject 抢夺回复），
            // 而是直接返回 _awaitInjectPush 标记，由 main.js 在调本函数之前已注册的 waiter 接收 inject 推送。
            // 不在这里等 isExecuting——waiter 已提前注册，inject 推送不会错过。
            if (model.provider === 'deepseek' && !payload._skipToolLoopWait) {
                // 更新 conversationUrl（网页版发送后 URL 可能变更）
                try {
                    const curUrlRes = await registry.invoke(modelId, 'getCurrentUrl', {});
                    if (curUrlRes.success && curUrlRes.data && curUrlRes.data.url) {
                        ctx.conversationUrl = curUrlRes.data.url;
                    }
                } catch(e) {}
                console.log('[Orch] returning _awaitInjectPush for CLI (waiter pre-registered)');
                return {
                    success: true,
                    data: {
                        markdown: '',
                        conversationUrl: ctx.conversationUrl,
                        modelId: modelId,
                        _awaitInjectPush: true
                    }
                };
            }

            // 网页版发送后 URL 可能变更（Qwen/DeepSeek 会创建新会话），更新缓存的 URL
            if (model.provider !== 'openai' && model.provider !== 'anthropic') {
                const curUrlRes = await registry.invoke(modelId, 'getCurrentUrl', {});
                if (curUrlRes.success && curUrlRes.data && curUrlRes.data.url) {
                    ctx.conversationUrl = curUrlRes.data.url;
                }
            }

            // 6. 提取回复：图片回复走独立图片管道，文字回复走 clipboard/DOM
            const hasImages = waitRes.data && waitRes.data.hasImages;
            let responseMarkdown = '';
            let responseThink = '';
            let responseImages = [];
            if (hasImages) {
                // 图片管道：等待图片生成完成 → 提取文字+图片URL
                const imgWaitRes = await registry.invoke(modelId, 'waitForImageDone', { timeout: payload.timeout || 300000 });
                if (!imgWaitRes.success) return imgWaitRes;
                const imgExtractRes = await registry.invoke(modelId, 'extractImageResponse', {});
                if (!imgExtractRes.success) return imgExtractRes;
                responseMarkdown = imgExtractRes.data && imgExtractRes.data.markdown || '';
                responseImages = imgExtractRes.data && imgExtractRes.data.images || [];
            } else {
                // 文字管道：clipboard 提取
                const extractRes = await registry.invoke(modelId, 'extractResponse', { _conversationUrl: ctx && ctx.conversationUrl });
                if (!extractRes.success) return extractRes;
                responseMarkdown = extractRes.data && extractRes.data.markdown || '';
                responseThink = extractRes.data && extractRes.data.think || '';
                responseImages = extractRes.data && extractRes.data.images || [];
            }

            ctx.lastResponse = responseMarkdown;

            // 7. 检测 subagent 标签并执行（嵌套）
            // 支持 XML 格式 <subagent:invoke...> 和 JSON 格式 {"subagent":{...}}
            let subagentResults = [];
            const sm = getSubagentManager();
            if (sm && (responseMarkdown.indexOf('<subagent:invoke') >= 0 || responseMarkdown.indexOf('"subagent"') >= 0)) {
                subagentResults = await sm.executeFromResponse(responseMarkdown, agentId, payload.subagentDepth || 0);
                // 将 subagent 结果拼接回主对话（发送给当前模型）
                if (subagentResults.length > 0) {
                    const feedbackText = buildSubagentFeedback(subagentResults);
                    await registry.invoke(modelId, 'sendMessage', { text: feedbackText, timeout: 120000 });
                    await registry.invoke(modelId, 'waitForDone', { timeout: 120000 });
                    const reExtract = await registry.invoke(modelId, 'extractResponse', { _conversationUrl: ctx && ctx.conversationUrl });
                    if (reExtract.success) {
                        ctx.lastResponse = reExtract.data && reExtract.data.markdown || responseMarkdown;
                    }
                }
            }

            // 7b. Goal 自动循环：检查 payload.goal，若 AI 未输出 <goal_met/> 则回填并继续
            const goalCondition = payload.goal;
            if (goalCondition && typeof goalCondition === 'string') {
                let goalRounds = 0;
                const maxGoalRounds = parseInt(process.env.DSAGENT_GOAL_MAX_ROUNDS || '15', 10);
                const maxGoalDurationSecs = parseInt(process.env.DSAGENT_GOAL_MAX_DURATION_SECS || '300', 10);
                const goalStartTime = Date.now();
                while (goalRounds < maxGoalRounds) {
                    // 检查超时
                    if ((Date.now() - goalStartTime) / 1000 > maxGoalDurationSecs) {
                        console.log('[Goal] Duration limit reached (' + maxGoalDurationSecs + 's)');
                        break;
                    }
                    goalRounds++;
                    // 检查是否包含完成标记
                    if (ctx.lastResponse && ctx.lastResponse.indexOf('<goal_met/>') >= 0) {
                        console.log('[Goal] Goal met after', goalRounds, 'rounds');
                        break;
                    }
                    // 构造进度提示
                    const progressText = '<message>目标尚未完成。已完成 ' + goalRounds + '/' + maxGoalRounds + ' 轮。目标: '
                        + goalCondition + '。请继续使用工具执行下一步。完成时请在回复中输出 <goal_met/>（独占一行，不要附带其他内容）。</message>';
                    console.log('[Goal] Round', goalRounds, '- sending progress to AI');
                    const sendRes2 = await registry.invoke(modelId, 'sendMessage', { text: progressText, timeout: 180000 });
                    if (!sendRes2.success) break;
                    const waitRes2 = await registry.invoke(modelId, 'waitForDone', { timeout: 180000 });
                    if (!waitRes2.success) break;
                    const reExtract2 = await registry.invoke(modelId, 'extractResponse', { _conversationUrl: ctx && ctx.conversationUrl });
                    if (reExtract2.success && reExtract2.data && reExtract2.data.markdown) {
                        ctx.lastResponse = reExtract2.data.markdown;
                    }
                    // 再次检查完成标记
                    if (ctx.lastResponse && ctx.lastResponse.indexOf('<goal_met/>') >= 0) {
                        console.log('[Goal] Goal met after', goalRounds, 'rounds');
                        break;
                    }
                }
                if (goalRounds >= maxGoalRounds) {
                    console.log('[Goal] Max rounds reached without meeting goal');
                }
            }

            // 8b. Git 自动提交（启用 DSAGENT_GIT_AUTOCOMMIT=1 后每次文件编辑后自动 checkpoint）
            if (process.env.DSAGENT_GIT_AUTOCOMMIT === '1' && ctx.lastResponse) {
                try {
                    var checkpointMsg = 'auto: checkpoint - ' + (payload.message && payload.message.text || '').substring(0, 40);
                    await registry.invoke(modelId, 'sendMessage', {
                        text: '{"tool":"git_checkpoint","params":{"message":' + JSON.stringify(checkpointMsg) + '}}',
                        timeout: 30000
                    });
                } catch(e) { /* non-critical */ }
            }

            // 9. 缓存到 history-manager（剥离 system-reminder）
            if (historyManager && payload.history && payload.history.id) {
                try {
                    // AI 会话命名：如果是首次对话且标题为空，自动生成标题
                    var sessTitle = payload.history.title || '';
                    if (!sessTitle && ctx._exchangeCount === 0 && ctx.lastResponse) {
                        var firstUserMsg = (payload.message && payload.message.text || '').trim();
                        sessTitle = firstUserMsg.substring(0, 20) || '对话 ' + new Date().toISOString().slice(0, 10);
                    }
                    historyManager.saveHistory({
                        id: payload.history.id,
                        title: sessTitle || payload.history.title || '对话',
                        modelId: modelId,
                        conversationUrl: ctx.conversationUrl,
                        messages: (payload.history.messages || []).concat([
                            { role: 'user', content: stripSystemReminder(sendArgs.text) },
                            { role: 'assistant', content: stripSystemReminder(ctx.lastResponse) }
                        ]),
                        updatedAt: new Date().toISOString()
                    });
                } catch (e) { /* 非关键 */ }
            }

            // P0: 本轮 turn 结束，递增 turnCount（用于持续对话压缩触发间隔控制）
            ctx.turnCount = (ctx.turnCount || 0) + 1;

            // P1: Turn 级 Datalog — 写结构化 turn 记录（参考 atomcode turn/datalog.rs）
            try {
                var datalog = require('./lib/datalog.js');
                var userText = payload.message && payload.message.text || '';
                var assistantText = ctx.lastResponse || '';
                var turnRecord = {
                    turn: ctx.turnCount,
                    modelId: modelId,
                    conversationUrl: ctx.conversationUrl,
                    userText: userText.substring(0, 500),
                    assistantText: assistantText.substring(0, 1000),
                    estimatedUserTokens: datalog.estimateTokens(userText),
                    estimatedAssistantTokens: datalog.estimateTokens(assistantText),
                    durationMs: ctx._turnStartTime ? (Date.now() - ctx._turnStartTime) : 0,
                    error: null
                };
                datalog.writeTurn(payload.history && payload.history.id || agentId, turnRecord);
            } catch(e) { /* 非关键 */ }

            return {
                success: true,
                data: {
                    markdown: ctx.lastResponse,
                    think: responseThink,
                    images: responseImages,
                    conversationUrl: ctx.conversationUrl,
                    modelId: modelId,
                    subagentResults: subagentResults
                }
            };
        } catch (e) {
            const errMsg = (e && (e.message || String(e))) || '未知错误: ' + JSON.stringify(e);
            return { success: false, error: errMsg };
        }
    }

    // ===== 历史注入：分段发送 =====
    // windowBudget 为有效窗口估算值（effectiveWindow），非模型标称 inputMaxLen
    async function injectHistory(modelId, messages, windowBudget, conversationUrl) {
        // Compaction UX: 标记开始
        console.log('[Compaction] Starting history compaction...');
        // 把 messages 拼成文本
        const text = messages.map((m) => {
            const role = m.role === 'assistant' ? '【AI 回复】' : '【用户】';
            return role + '\n' + (m.content || '');
        }).join('\n\n---\n\n');

        // P4: 上下文压缩（参考 atomcode 冷区设计）
        // 当文本超过 70% windowBudget 时，压缩旧轮次为摘要，保留最近 5 轮全量
        const COMPRESS_THRESHOLD = Math.floor(windowBudget * 0.7);
        const OVERFLOW_THRESHOLD = Math.floor(windowBudget * 0.85);
        const KEEP_LATEST = 5;
        let finalText = text;
        let compressed = false;

        if (text.length > OVERFLOW_THRESHOLD && messages.length > KEEP_LATEST * 2) {
            // OverflowCompaction：超过 85% 阈值时用 LLM 摘要
            const keepCount = KEEP_LATEST * 2;
            const keepMessages = messages.slice(-keepCount);
            const compressMessages = messages.slice(0, -keepCount);
            // 生成简单摘要（行数过多时截断，避免 LLM 摘要调用的开销）
            const summaryLines = compressMessages.map(function(m) {
                var role = m.role === 'assistant' ? 'AI' : '用户';
                var content = (m.content || '');
                var preview = content.replace(/<[^>]*>/g, '').substring(0, 200);
                return role + ': ' + preview + (content.length > 200 ? '...' : '');
            }).join('\n');
            finalText = '【历史摘要（已压缩 ' + compressMessages.length + ' 条旧消息）】\n'
                + summaryLines + '\n\n'
                + '【最近 ' + keepCount + ' 条消息】\n'
                + keepMessages.map(function(m) {
                    var role = m.role === 'assistant' ? '【AI 回复】' : '【用户】';
                    return role + '\n' + (m.content || '');
                }).join('\n\n---\n\n')
                + '\n\n请基于以上历史继续对话。';
            compressed = true;
        } else if (text.length > COMPRESS_THRESHOLD && messages.length > KEEP_LATEST * 2) {
            // 中等阈值压缩（70%）
            const keepCount = KEEP_LATEST * 2;
            const keepMessages = messages.slice(-keepCount);
            const compressMessages = messages.slice(0, -keepCount);

            // 生成摘要
            const summary = compressMessages.map((m) => {
                const role = m.role === 'assistant' ? 'AI' : '用户';
                const content = (m.content || '');
                // 只取前 200 字符做摘要
                const preview = content.replace(/<[^>]*>/g, '').substring(0, 200);
                return role + ': ' + preview + (content.length > 200 ? '...' : '');
            }).join('\n');

            finalText = '【历史摘要（已压缩 ' + compressMessages.length + ' 条旧消息）】\n'
                + summary + '\n\n'
                + '【最近 ' + keepCount + ' 条消息】\n'
                + keepMessages.map((m) => {
                    const role = m.role === 'assistant' ? '【AI 回复】' : '【用户】';
                    return role + '\n' + (m.content || '');
                }).join('\n\n---\n\n')
                + '\n\n请基于以上历史继续对话。';
        }

        const segLen = Math.floor(windowBudget * INJECT_SEGMENT_RATIO);
        const segments = [];
        if (finalText.length <= segLen) {
            // 不超长：单段注入
            segments.push('【历史对话】\n' + finalText + '\n\n请基于以上历史继续对话。');
        } else {
            // 分段
            const parts = splitTextByLength(finalText, segLen);
            for (let i = 0; i < parts.length; i++) {
                const isLast = i === parts.length - 1;
                segments.push('【历史对话 第 ' + (i + 1) + '/' + parts.length + ' 段】\n' + parts[i] + (isLast ? '\n\n以上是完整历史，请基于此继续对话。' : '\n\n（历史分段注入，请回复"继续"）'));
            }
        }

        const res = await registry.invoke(modelId, 'injectHistory', { segments: segments, discardIntermediate: true, _conversationUrl: conversationUrl });
        if (!res.success) return { success: false, error: res.error };
        console.log('[Compaction] Done — ' + segments.length + ' segment(s), ' + (compressed ? 'compressed' : 'full'));
        return { success: true, segments: segments.length, compressed: compressed };
    }

    // 按长度切分文本，尽量在段落/句子边界切
    function splitTextByLength(text, maxLen) {
        const parts = [];
        let remaining = text;
        while (remaining.length > maxLen) {
            // 在 maxLen 附近找换行符
            let cut = maxLen;
            for (let i = maxLen; i > maxLen * 0.7; i--) {
                if (remaining[i] === '\n') { cut = i + 1; break; }
            }
            parts.push(remaining.substring(0, cut));
            remaining = remaining.substring(cut);
        }
        if (remaining.length > 0) parts.push(remaining);
        return parts;
    }

    // ===== Subagent 请求处理（被 subagent-manager 回调） =====
    async function handleSubagentRequest(params) {
        // params: { agentId, template, prompt, modelOverride, toolWhitelist, files, depth }
        // 1. 从集群配置选模型：按模板 defaultModelRole 找对应角色
        const clusterCfg = getClusterConfigFn ? getClusterConfigFn() : null;
        const roleName = params.template.defaultModelRole || 'main';
        let roleCfg = clusterCfg && clusterCfg.roles && clusterCfg.roles[roleName];
        let modelId = params.modelOverride || (roleCfg && roleCfg.modelId) || (clusterCfg && clusterCfg.subagentDefaults && clusterCfg.subagentDefaults.modelId) || 'deepseek.fast';

        // 2. 多模态路由：如果 files 中包含图片，检查模型能力
        const imageExts = ['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp'];
        const hasImages = (params.files || []).length > 0 && params.files.some(function(f) {
            var ext = (f.name || f.path || '').split('.').pop().toLowerCase();
            return imageExts.indexOf(ext) >= 0;
        });
        if (hasImages) {
            var cap = registry.getCapabilities(modelId);
            var supportsImage = cap && cap.multimodal && cap.multimodal.input && cap.multimodal.input.indexOf('image') >= 0;
            if (!supportsImage) {
                // 模型不支持图片 → 尝试路由到集群中 multimodal 角色
                var mmRole = clusterCfg && clusterCfg.roles && clusterCfg.roles.multimodal;
                if (mmRole && mmRole.modelId) {
                    modelId = mmRole.modelId;
                } else {
                    return { success: false, error: '当前集群未配置多模态模型，subagent 无法处理图片' };
                }
            }
        }

        // 3. 构造 subagent 的集群配置（minimal，仅用选定模型）
        const subClusterConfig = {
            templateId: 'minimal',
            roles: { main: { modelId: modelId } },
            subagentDefaults: {}
        };

        // 4. 执行 subagent 对话
        var result = await handleRequest({
            agentId: params.agentId,
            clusterConfig: subClusterConfig,
            role: 'main',
            message: { text: params.prompt },
            files: params.files || [],
            systemPrompt: params.template.systemPrompt,
            subagentDepth: params.depth,
            forceNew: true   // subagent 独立上下文，强制新对话
        });

        // 5. 持久化 subagent 对话到 history-manager（供用户查阅）
        if (historyManager && result.success) {
            try {
                historyManager.saveHistory({
                    id: params.agentId,
                    title: '[Sub] ' + params.template.displayName + ': ' + params.prompt.substring(0, 40),
                    modelId: modelId,
                    conversationUrl: result.data && result.data.conversationUrl || '',
                    kind: 'subagent',
                    messages: [
                        { role: 'user', content: params.prompt },
                        { role: 'assistant', content: (result.data && result.data.markdown) || '' }
                    ],
                    createdAt: new Date().toISOString(),
                    updatedAt: new Date().toISOString()
                });
            } catch (e) { /* 非关键 */ }
        }

        return result;
    }

    // ===== 构建 subagent 结果反馈文本（委托给 lib/response-processor.js，消除重复实现） =====
    function buildSubagentFeedback(results) {
        return responseProcessor.buildSubagentFeedback(results);
    }

    // ===== 上下文管理 =====
    function getContext(agentId) { return contexts.get(agentId); }
    function clearContext(agentId) { contexts.delete(agentId); }
    function listContexts() {
        const out = [];
        contexts.forEach((ctx, id) => { out.push({ agentId: id, modelId: ctx.modelId, conversationUrl: ctx.conversationUrl }); });
        return out;
    }

    // ===== 集群配置 CRUD（委托给外部 store） =====
    function getClusterConfig() { return getClusterConfigFn ? getClusterConfigFn() : null; }
    function saveClusterConfig(cfg) { return saveClusterConfigFn ? saveClusterConfigFn(cfg) : { success: false, error: 'no store' }; }

    // ===== 关闭对话（清理上下文 + 删除网页对话） =====
    async function closeConversation(agentId) {
        const ctx = contexts.get(agentId);
        if (!ctx) return { success: true };
        try {
            if (ctx.conversationUrl) {
                await registry.invoke(ctx.modelId, 'deleteConversation', { convid: ctx.conversationUrl });
            }
        } catch (e) { /* 非关键 */ }
        contexts.delete(agentId);
        return { success: true };
    }

    const orchestratorInstance = {
        handleRequest,
        handleSubagentRequest,
        injectHistory,
        getContext,
        clearContext,
        listContexts,
        closeConversation,
        getClusterConfig,
        saveClusterConfig,
        setPlanMode,
        isPlanMode,
        filterToolsForPlanMode,
        subagentManager: null,   // 外部回填
        setSubagentManager: function(sm) { _subagentManager = sm; this.subagentManager = sm; }
    };

    return orchestratorInstance;
}

module.exports = { createOrchestrator };
