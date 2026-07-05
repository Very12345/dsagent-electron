const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
    // Agent view → main process (control DeepSeek)
    agentSendMessage: (data) => ipcRenderer.invoke('agent-send-message', data),
    agentStartNewChat: (data) => ipcRenderer.invoke('agent-start-new-chat', data),
    agentViewToggle: () => ipcRenderer.send('agent-view-toggle'),
    agentToggleDeepThink: (enabled) => ipcRenderer.invoke('agent-toggle-deepthink', enabled),
    agentGetDeepseekUrl: () => ipcRenderer.invoke('agent-get-deepseek-url'),
    agentStop: () => ipcRenderer.invoke('agent-stop'),

    // Main process → agent view (receive parsed content)
    onAgentMessage: (callback) => {
        ipcRenderer.on('agent-message', (event, data) => callback(data));
    },

    // Theme sync
    onAgentTheme: (callback) => {
        ipcRenderer.on('agent-theme', (event, theme) => callback(theme));
    },

    // History management
    historyList: () => ipcRenderer.invoke('history-list'),
    historyListAll: () => ipcRenderer.invoke('history-list-all'),
    historyLoad: (id) => ipcRenderer.invoke('history-load', id),
    historySave: (data) => ipcRenderer.invoke('history-save', data),
    historyLoadUrl: (id, url) => ipcRenderer.invoke('history-load-url', id, url),
    historyDelete: (id) => ipcRenderer.invoke('history-delete', id),
    historyRename: (id, newTitle) => ipcRenderer.invoke('history-rename', id, newTitle),
    historyRestoreConversation: (url) => ipcRenderer.invoke('history-restore-conversation', url),

    // 获取根目录（用于解析本地图片等）
    getRootDir: () => ipcRenderer.invoke('agent-get-root-dir'),

    // 获取/设置 readTools（持久化已读文档记录）
    getReadTools: () => ipcRenderer.invoke('agent-get-read-tools'),
    setReadTools: (arr) => ipcRenderer.invoke('agent-set-read-tools', arr),

    // DeepSeek 原始对话删除（同步删除历史时使用）
    agentDeleteDeepseekConversation: (deepseekUrl) => ipcRenderer.invoke('agent-delete-deepseek-conversation', deepseekUrl),

    // Qwen 原始对话删除（同步删除历史时使用）  
    agentDeleteQwenConversation: (qwenUrl) => ipcRenderer.invoke('agent-delete-qwen-conversation', qwenUrl),

    // Dangerous command confirmation
    onAgentShowConfirm: (callback) => {
        ipcRenderer.on('agent-show-confirm', (event, data) => callback(data));
    },
    agentConfirmResponse: (data) => ipcRenderer.send('agent-confirm-response', data),

    // Qwen 绘图进度
    onQwenProgress: (callback) => {
        ipcRenderer.on('qwen-progress', (event, msg) => callback(msg));
    },

    // 历史对话列表刷新（文件浏览器切换目录时触发）
    onRefreshHistory: (callback) => {
        ipcRenderer.on('refresh-history', () => callback());
    },

    // cwd 变更通知（/cd 切换目录时，不关闭对话）
    onCwdChanged: (callback) => {
        ipcRenderer.on('cwd-changed', (event, data) => callback(data));
    },

    // 恢复历史对话（应用启动时）
    onRestoreHistory: (callback) => {
        ipcRenderer.on('restore-history-conversation', (event, historyId) => callback(historyId));
    },

    // 设置当前历史对话 ID（用于状态保存）
    setLastHistoryId: (historyId) => ipcRenderer.send('set-last-history-id', historyId),

    // 目录切换时关闭当前对话
    onAgentCloseConversation: (callback) => {
        ipcRenderer.on('agent-close-conversation', () => callback());
    },

    // 文件附件栏
    saveTempImage: (data) => ipcRenderer.invoke('save-temp-image', data),
    openFile: (filePath) => ipcRenderer.invoke('open-file', filePath),
    onAgentAddFile: (callback) => {
        ipcRenderer.on('agent-add-file', (event, filePath) => callback(filePath));
    },

    // 剪贴板操作（供复制按钮使用）
    clipboardWriteText: (text) => ipcRenderer.invoke('clipboard-write-text', text),
    clipboardSave: () => ipcRenderer.invoke('clipboard-save'),
    clipboardRestore: (text) => ipcRenderer.invoke('clipboard-restore', text),

    // Agent 视图焦点恢复
    focusInput: () => ipcRenderer.send('agent-focus-input'),

    // 频率限制弹窗（从 DeepSeek 页面转发）
    onAgentShowRateLimit: (callback) => {
        ipcRenderer.on('agent-show-ratelimit', (event, data) => callback(data));
    },
    agentRateLimitResponse: (data) => ipcRenderer.send('agent-ratelimit-response', data),

    // QQ Bot 托管
    qqbotStart: (config) => ipcRenderer.invoke('qqbot-start', config),
    qqbotStop: () => ipcRenderer.invoke('qqbot-stop'),
    qqbotStatus: () => ipcRenderer.invoke('qqbot-status'),
    qqbotSendResponse: (data) => ipcRenderer.send('qqbot-send-response', data),
    qqbotGetNetMode: () => ipcRenderer.invoke('qqbot-get-net-mode'),
    qqbotSetNetMode: (mode) => ipcRenderer.invoke('qqbot-set-net-mode', mode),
    onQQBotMessage: (callback) => {
        ipcRenderer.on('qqbot-message', (event, data) => callback(data));
    },
    onQQBotAuthorized: (callback) => {
        ipcRenderer.on('qqbot-authorized', (event, data) => callback(data));
    },
    onQQBotCommand: (callback) => {
        ipcRenderer.on('qqbot-command', (event, data) => callback(data));
    },
    // Robot 配置管理
    qqbotListRobots: () => ipcRenderer.invoke('qqbot-list-robots'),
    qqbotSaveRobot: (robot) => ipcRenderer.invoke('qqbot-save-robot', robot),
    qqbotDeleteRobot: (robotId) => ipcRenderer.invoke('qqbot-delete-robot', robotId),

    // 微信机器人（iLink Bot API）
    wechatbotStartLogin: () => ipcRenderer.invoke('wechatbot-start-login'),
    wechatbotPollLogin: (event, qrcode) => ipcRenderer.invoke('wechatbot-poll-login', qrcode),
    wechatbotPollStatus: (callback) => {
        const handler = (event, data) => callback(data);
        ipcRenderer.on('wechatbot-poll-status', handler);
        return () => ipcRenderer.removeListener('wechatbot-poll-status', handler);
    },
    wechatbotStart: () => ipcRenderer.invoke('wechatbot-start'),
    wechatbotStop: () => ipcRenderer.invoke('wechatbot-stop'),
    wechatbotStatus: () => ipcRenderer.invoke('wechatbot-status'),
    wechatbotSendResponse: (data) => ipcRenderer.send('wechatbot-send-response', data),
    onWechatbotMessage: (cb) => ipcRenderer.on('wechatbot-message', (e, d) => cb(d)),
    onWechatbotAuthorized: (cb) => ipcRenderer.on('wechatbot-authorized', (e, d) => cb(d)),
    wechatbotListRobots: () => ipcRenderer.invoke('wechatbot-list-robots'),
    wechatbotSaveRobot: (r) => ipcRenderer.invoke('wechatbot-save-robot', r),
    wechatbotDeleteRobot: (id) => ipcRenderer.invoke('wechatbot-delete-robot', id),

    // 飞书机器人（Device Auth + IM API）
    feishubotStartLogin: () => ipcRenderer.invoke('feishubot-start-login'),
    feishubotPollLogin: () => ipcRenderer.invoke('feishubot-poll-login'),
    feishubotStart: () => ipcRenderer.invoke('feishubot-start'),
    feishubotStop: () => ipcRenderer.invoke('feishubot-stop'),
    feishubotStatus: () => ipcRenderer.invoke('feishubot-status'),
    feishubotSendResponse: (data) => ipcRenderer.send('feishubot-send-response', data),
    onFeishubotMessage: (cb) => ipcRenderer.on('feishubot-message', (e, d) => cb(d)),
    onFeishubotAuthorized: (cb) => ipcRenderer.on('feishubot-authorized', (e, d) => cb(d)),
    feishubotListRobots: () => ipcRenderer.invoke('feishubot-list-robots'),
    feishubotSaveRobot: (r) => ipcRenderer.invoke('feishubot-save-robot', r),
    feishubotDeleteRobot: (id) => ipcRenderer.invoke('feishubot-delete-robot', id),

    // 多终端管理
    terminalCreate: (name, cwd) => ipcRenderer.invoke('terminal-create', name, cwd),
    terminalWrite: (name, command) => ipcRenderer.invoke('terminal-write', name, command),
    terminalOutput: (name, lines) => ipcRenderer.invoke('terminal-output', name, lines),
    terminalClear: (name) => ipcRenderer.invoke('terminal-clear', name),
    terminalKill: (name) => ipcRenderer.invoke('terminal-kill', name),
    terminalList: () => ipcRenderer.invoke('terminal-list'),

    // 继续生成确认
    onContinueConfirm: (callback) => {
        ipcRenderer.on('agent-show-continue-confirm', (event, data) => callback(data));
    },
    agentContinueResponse: (response) => ipcRenderer.send('agent-continue-response', response),

    // 自动更新进度
    onUpdateProgress: (callback) => {
        ipcRenderer.on('update-progress', (event, data) => callback(data));
    },
    onUpdateDownloaded: (callback) => {
        ipcRenderer.on('update-downloaded', () => callback());
    },

    // 保存大文本到临时文件
    saveLargeText: (text) => ipcRenderer.invoke('save-large-text', text),

    // 技能弹窗
    onAgentShowSkills: (callback) => {
        ipcRenderer.on('agent-show-skills', (event, skills) => callback(skills));
    },
    onAgentOpenSkillsModal: (callback) => {
        ipcRenderer.on('agent-open-skills-modal', () => callback());
    },
    onAgentShowMcpTools: (callback) => {
        ipcRenderer.on('agent-show-mcp-tools', (event, data) => callback(data));
    },
    deleteSkill: (name) => ipcRenderer.send('ctrl-delete-skill', name),
    agentSkillsLoad: () => ipcRenderer.invoke('agent-skills-load'),
    agentSkillsSyncedList: () => ipcRenderer.invoke('agent-skills-synced-list'),
    syncSkillToWorkdir: (skillName) => ipcRenderer.send('sync-skill-to-workdir', skillName),
    unsyncSkill: (skillName) => ipcRenderer.send('unsync-skill', skillName),
    // invoke 版本（供 dsa 工具使用，返回结果）
    agentSkillSync: (skillName) => ipcRenderer.invoke('agent-skill-sync', skillName),
    agentSkillUnsync: (skillName) => ipcRenderer.invoke('agent-skill-unsync', skillName),
    agentSkillDelete: (skillName) => ipcRenderer.invoke('agent-skill-delete', skillName),

    // 获取技能完整内容（skill 命令）
    agentSkillGetContent: (skillName) => ipcRenderer.invoke('agent-skill-get-content', skillName),
    agentSkillToggleDisabled: (skillName) => ipcRenderer.invoke('agent-skill-toggle-disabled', skillName),
    agentSkillGetDisabled: () => ipcRenderer.invoke('agent-skill-get-disabled'),

    // 配置管理
    agentConfigLoad: () => ipcRenderer.invoke('agent-config-load'),
    agentConfigSave: (config) => ipcRenderer.invoke('agent-config-save', config),
    // 记忆管理
    memoryGet: (type) => ipcRenderer.invoke('memory-get', type),
    memorySet: (type, content) => ipcRenderer.invoke('memory-set', type, content),
    agentSkillsStoragePath: () => ipcRenderer.invoke('agent-skills-storage-path'),
    agentSkillsSetStoragePath: (path) => ipcRenderer.invoke('agent-skills-set-storage-path', path),
    agentSkillsSelectFolder: () => ipcRenderer.invoke('agent-skills-select-folder'),

    // 存储路径设置弹窗事件
    onAgentShowStoragePathDialog: (callback) => {
        ipcRenderer.on('agent-show-storage-path-dialog', () => callback());
    },

    // MCP 桥接
    mcpInit: (force) => ipcRenderer.invoke('mcp-init', force),
    mcpGetTools: () => ipcRenderer.invoke('mcp-get-tools'),
    mcpCallTool: (serverName, toolName, args) => ipcRenderer.invoke('mcp-call-tool', serverName, toolName, args),
    mcpShutdown: () => ipcRenderer.invoke('mcp-shutdown'),
    // MCP Resources protocol
    mcpGetResources: () => ipcRenderer.invoke('mcp-get-resources'),
    mcpReadResource: (serverName, uri) => ipcRenderer.invoke('mcp-read-resource', serverName, uri),
    // MCP Prompts protocol
    mcpGetPrompts: () => ipcRenderer.invoke('mcp-get-prompts'),
    mcpGetPrompt: (serverName, name, args) => ipcRenderer.invoke('mcp-get-prompt', serverName, name, args),
    // 文件历史 Undo（P1）
    fileHistoryUndo: (filePath, sessionId) => ipcRenderer.invoke('file-history-undo', filePath, sessionId),
    fileHistoryVersions: (filePath, sessionId) => ipcRenderer.invoke('file-history-versions', filePath, sessionId),
    fileHistoryRestore: (filePath, version, sessionId) => ipcRenderer.invoke('file-history-restore', filePath, version, sessionId),
    fileHistoryBackup: (filePath) => ipcRenderer.invoke('file-history-backup', filePath),
    // P0: 编辑后强制语法验证
    agentSyntaxCheck: (filePath, ext) => ipcRenderer.invoke('agent-syntax-check', filePath, ext),
    // 插件管理（CC 生态兼容）
    pluginList: () => ipcRenderer.invoke('plugin-list'),
    pluginInstall: (params) => ipcRenderer.invoke('plugin-install', params),
    pluginUninstall: (name) => ipcRenderer.invoke('plugin-uninstall', name),
    pluginRefresh: () => ipcRenderer.invoke('plugin-refresh'),
    // 插件市场
    pluginMarketplaceAdd: (params) => ipcRenderer.invoke('plugin-marketplace-add', params),
    pluginMarketplaceList: () => ipcRenderer.invoke('plugin-marketplace-list'),
    // 技能引擎（对齐 atomcode Skill）
    skillList: () => ipcRenderer.invoke('skill-list'),
    skillExecute: (name, args) => ipcRenderer.invoke('skill-execute', name, args),
    skillRefresh: () => ipcRenderer.invoke('skill-refresh'),
    mcpGetToolStates: () => ipcRenderer.invoke('mcp-get-tool-states'),
    mcpSetToolEnabled: (serverName, toolName, enabled) => ipcRenderer.invoke('mcp-set-tool-enabled', serverName, toolName, enabled),

    // 计划管理
    agentPlanLoad: () => ipcRenderer.invoke('agent-plan-load'),
    agentPlanSave: (plan) => ipcRenderer.invoke('agent-plan-save', plan),
    agentPlanDelete: () => ipcRenderer.invoke('agent-plan-delete'),

    // 表单结果回复
    onAgentFormShow: (callback) => {
        ipcRenderer.on('agent-form-show', (event, data) => callback(data));
    },
    agentFormSubmit: (data) => ipcRenderer.send('agent-form-submit', data),

    // 计划更新通知
    onAgentPlanUpdate: (callback) => {
        ipcRenderer.on('agent-plan-update', (event, plan) => callback(plan));
    },

    // Skill 步骤更新通知
    onAgentSkillStep: (callback) => {
        ipcRenderer.on('agent-skill-step', (event, data) => callback(data));
    },

    // 菜单栏注入：由 shell.html 触发，在当前可见的 agentView 中渲染菜单 overlay
    onMenuOverlay: (callback) => {
        ipcRenderer.on('render-menu-overlay', (event, data) => callback(data));
    },

    // 获取 INSTRUCTION.md 基本指令内容（可选传 modelId，智能选择 XML/JSON 格式）
    getInstructionText: (modelId) => ipcRenderer.invoke('get-instruction-text', { modelId: modelId || '' }),

    // 启动进度更新（来自主进程的 DeepSeek→Qwen→Agent 顺序加载）
    onSplashProgress: (callback) => {
        ipcRenderer.on('splash-progress', (event, data) => callback(data));
    },
    onSplashComplete: (callback) => {
        ipcRenderer.on('splash-complete', () => callback());
    },

    // 状态消息发送到 controlbar（统一任务栏）
    agentStatusToControlbar: (msg, type) => ipcRenderer.send('agent-status-to-controlbar', { msg: msg, type: type || '' }),

    // 加载菜单栏配置
    getMenubarConfig: () => ipcRenderer.invoke('get-menubar-config'),
    // 菜单项点击 → 主进程执行操作
    agentMenuItemClick: (item) => ipcRenderer.send('agent-menu-item-click', item),

    // 后台定时任务管理（从 agentview UI 控制）
    intervalAddFromUI: (params) => ipcRenderer.invoke('interval-add-from-ui', params),
    intervalStopFromUI: (taskName) => ipcRenderer.invoke('interval-stop-from-ui', taskName),
    intervalStopAll: () => ipcRenderer.send('interval-stop-all'),
    intervalStopAllForce: () => ipcRenderer.send('interval-stop-all-force'),
    intervalGetSaved: () => ipcRenderer.invoke('interval-get-saved'),
    intervalRestoreSaved: () => ipcRenderer.invoke('interval-restore-saved'),
    intervalClearSaved: () => ipcRenderer.invoke('interval-clear-saved'),
    // 定时任务状态同步和队列管理
    intervalStateUpdate: (state) => ipcRenderer.send('interval-state-update', state),
    intervalFlushQueue: () => ipcRenderer.send('interval-flush-queue'),

    // ==================== 模型服务化架构（新） ====================
    // 统一 agent-request
    agentRequest: (payload) => ipcRenderer.invoke('agent-request', payload),
    // 模型列表
    modelList: () => ipcRenderer.invoke('model-list'),
    // 工具颜色映射（单一来源 tools/tool-colors.js）
    toolColors: () => ipcRenderer.invoke('tool-colors-get'),
    // 集群模板
    clusterTemplates: () => ipcRenderer.invoke('cluster-templates'),
    clusterSelectionOptions: (templateId) => ipcRenderer.invoke('cluster-selection-options', templateId),
    // 集群配置
    clusterConfigGet: () => ipcRenderer.invoke('cluster-config-get'),
    clusterConfigSave: (cfg) => ipcRenderer.invoke('cluster-config-save', cfg),
    // Subagent
    subagentList: () => ipcRenderer.invoke('subagent-list'),
    subagentInvoke: (params) => ipcRenderer.invoke('subagent-invoke', params),
    // 持久化记忆（P2）
    memoryRead: () => ipcRenderer.invoke('memory-read'),
    memoryAppend: (scope, content) => ipcRenderer.invoke('memory-append', scope, content),
    memoryClear: (scope) => ipcRenderer.invoke('memory-clear', scope),
    // API Key 服务管理
    apikeyList: () => ipcRenderer.invoke('apikey-list'),
    apikeyAdd: (service) => ipcRenderer.invoke('apikey-add', service),
    apikeyUpdate: (id, patch) => ipcRenderer.invoke('apikey-update', id, patch),
    apikeyDelete: (id) => ipcRenderer.invoke('apikey-delete', id),
    // 并发槽位状态
    modelSlotStatus: () => ipcRenderer.invoke('model-slot-status'),
    // 关闭对话
    agentCloseConv: (agentId) => ipcRenderer.invoke('agent-close-conv', agentId),
});