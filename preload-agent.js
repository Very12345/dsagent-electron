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
    historyLoad: (id) => ipcRenderer.invoke('history-load', id),
    historySave: (data) => ipcRenderer.invoke('history-save', data),
    historyLoadUrl: (id, url) => ipcRenderer.invoke('history-load-url', id, url),
    historyDelete: (id) => ipcRenderer.invoke('history-delete', id),
    historyRestoreConversation: (url) => ipcRenderer.invoke('history-restore-conversation', url),

    // 获取根目录（用于解析本地图片等）
    getRootDir: () => ipcRenderer.invoke('agent-get-root-dir'),

    // 获取/设置 readTools（持久化已读文档记录）
    getReadTools: () => ipcRenderer.invoke('agent-get-read-tools'),
    setReadTools: (arr) => ipcRenderer.invoke('agent-set-read-tools', arr),

    // DeepSeek 原始对话删除（同步删除历史时使用）
    agentDeleteDeepseekConversation: (deepseekUrl) => ipcRenderer.invoke('agent-delete-deepseek-conversation', deepseekUrl),

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
});