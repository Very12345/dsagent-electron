// preload.js - 安全的上下文桥接
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
    // 文件浏览器相关
    listDir: (path) => ipcRenderer.invoke('list-dir', path),
    openFile: (path) => ipcRenderer.invoke('open-file', path),
    deleteFile: (path, isDir) => ipcRenderer.invoke('delete-file', path, isDir),
    renameFile: (path, newName) => ipcRenderer.invoke('rename-file', path, newName),
    getInitialDir: () => ipcRenderer.invoke('get-initial-dir'),
    getDownloadsPath: () => ipcRenderer.invoke('get-downloads-path'),
    getInitPrompt: (mode) => ipcRenderer.invoke('get-init-prompt', mode || 'quick'),
    getSubreaderStrategy: () => ipcRenderer.invoke('get-subreader-strategy'),

    // Agent 操作
    agentExec: (cmd, timeout) => ipcRenderer.invoke('agent-exec', cmd, timeout),
    agentRead: (path) => ipcRenderer.invoke('agent-read', path),
    agentReadFile: (path) => ipcRenderer.invoke('agent-readFile', path),
    agentSave: (path, content) => ipcRenderer.invoke('agent-save', path, content),
    agentEdit: (path, find, regex, replace) => ipcRenderer.invoke('agent-edit', path, find, regex, replace),
    agentList: (path) => ipcRenderer.invoke('agent-list', path),
    agentDelete: (path) => ipcRenderer.invoke('agent-delete', path),
    agentMkdir: (path) => ipcRenderer.invoke('agent-mkdir', path),
    agentExists: (path) => ipcRenderer.invoke('agent-exists', path),
    agentInfo: (path) => ipcRenderer.invoke('agent-info', path),
    agentConfigLoad: () => ipcRenderer.invoke('agent-config-load'),
    agentConfigSave: (cfg) => ipcRenderer.invoke('agent-config-save', cfg),
    agentPlanLoad: () => ipcRenderer.invoke('agent-plan-load'),
    agentPlanSave: (plan) => ipcRenderer.invoke('agent-plan-save', plan),
    agentPlanDelete: () => ipcRenderer.invoke('agent-plan-delete'),
    agentSkillsLoad: () => ipcRenderer.invoke('agent-skills-load'),
    agentSkillsDelete: (name) => ipcRenderer.invoke('agent-skills-delete', name),
    deleteSkill: (name) => ipcRenderer.invoke('agent-skills-delete', name),
    agentSkillGetContent: (skillName) => ipcRenderer.invoke('agent-skill-get-content', skillName),
    agentSkillToggleDisabled: (skillName) => ipcRenderer.invoke('agent-skill-toggle-disabled', skillName),
    agentSkillGetDisabled: () => ipcRenderer.invoke('agent-skill-get-disabled'),
    agentSkillsStoragePath: () => ipcRenderer.invoke('agent-skills-storage-path'),
    agentSkillsSetStoragePath: (path) => ipcRenderer.invoke('agent-skills-set-storage-path', path),
    agentSkillsRepoList: () => ipcRenderer.invoke('agent-skills-repo-list'),
    agentSkillsSyncedList: () => ipcRenderer.invoke('agent-skills-synced-list'),
    agentSkillsSelectFolder: () => ipcRenderer.invoke('agent-skills-select-folder'),
    syncSkillToWorkdir: (skillName) => ipcRenderer.send('sync-skill-to-workdir', skillName),
    unsyncSkill: (skillName) => ipcRenderer.send('unsync-skill', skillName),
    agentPing: () => ipcRenderer.invoke('agent-ping'),
    agentExecAdmin: (cmd) => ipcRenderer.invoke('agent-exec-admin', cmd),
    agentRequestConfirm: (data) => ipcRenderer.invoke('agent-request-confirm', data),

    // 白名单管理
    agentWhitelistAdd: (cmd) => ipcRenderer.invoke('agent-whitelist-add', cmd),
    agentWhitelistRemove: (cmd) => ipcRenderer.invoke('agent-whitelist-remove', cmd),
    agentWhitelistCheck: (cmd) => ipcRenderer.invoke('agent-whitelist-check', cmd),

    // 剪贴板
    clipboardReadText: () => ipcRenderer.invoke('clipboard-read-text'),
    clipboardWriteText: (text) => ipcRenderer.invoke('clipboard-write-text', text),
    clipboardSave: () => ipcRenderer.invoke('clipboard-save'),
    clipboardRestore: (savedText) => ipcRenderer.invoke('clipboard-restore', savedText),

    // Qwen 操作
    qwenExec: (fnName, args) => ipcRenderer.invoke('qwen-exec', fnName, args),
    qwenCheckReady: () => ipcRenderer.invoke('qwen-check-ready'),
    qwenPasteImage: (filePath) => ipcRenderer.invoke('qwen-paste-image', filePath),
    qwenPasteText: (text) => ipcRenderer.invoke('qwen-paste-text', text),
    qwenDownloadImage: (imageUrl, savePath) => ipcRenderer.invoke('qwen-download-image', imageUrl, savePath),
    qwenToggleView: () => ipcRenderer.invoke('qwen-toggle-view'),
    qwenIsVisible: () => ipcRenderer.invoke('qwen-is-visible'),
    qwenShowView: () => ipcRenderer.invoke('qwen-show-view'),
    qwenHideView: () => ipcRenderer.invoke('qwen-hide-view'),
    qwenGetClipboard: () => ipcRenderer.invoke('qwen-get-clipboard'),
    qwenClickAt: (x, y) => ipcRenderer.invoke('qwen-click-at', x, y),

    // Qwen PPT 下载准备（设置一次性 will-download 拦截）
    qwenPreparePPTDownload: (saveDir) => ipcRenderer.invoke('qwen-prepare-ppt-download', saveDir),

    // Qwen 进度推送（单向消息 → agentView）
    qwenProgress: (msg) => ipcRenderer.send('qwen-progress', msg),
    agentNotifyStatus: (msg) => ipcRenderer.send('agent-notify-status', msg),
    qwenNotifyStatus: (msg) => ipcRenderer.send('qwen-notify-status', msg),

    // 主题同步
    sendTheme: (theme) => ipcRenderer.send('theme-changed', theme),

    // Agent 视图
    agentForwardResult: (data) => ipcRenderer.send('agent-forward-result', data),

    // 定时任务管理（主进程驱动）
    intervalCreate: (params) => ipcRenderer.invoke('interval-create', params),
    intervalStop: (taskName) => ipcRenderer.invoke('interval-stop', taskName),
    intervalList: () => ipcRenderer.invoke('interval-list'),
    intervalStopAll: () => ipcRenderer.send('interval-stop-all'),
    intervalStopAllForce: () => ipcRenderer.send('interval-stop-all-force'),
    intervalGetSaved: () => ipcRenderer.invoke('interval-get-saved'),
    intervalRestoreSaved: () => ipcRenderer.invoke('interval-restore-saved'),
    intervalClearSaved: () => ipcRenderer.invoke('interval-clear-saved'),

    // 继续生成按钮检测通知（返回用户选择：true=继续生成，false=取消）
    notifyContinueGeneration: () => ipcRenderer.invoke('notify-continue-generation'),

    // 频率限制/服务器繁忙通知（返回用户选择：true=重试，false=取消）
    agentRateLimitNotify: (waitSeconds, errorType) => ipcRenderer.invoke('agent-rate-limit-notify', waitSeconds, errorType),

    winapiInvoke: (command) => ipcRenderer.invoke('winapi-invoke', command),

    // 多终端管理
    terminalCreate: (name, cwd) => ipcRenderer.invoke('terminal-create', name, cwd),
    terminalWrite: (name, command) => ipcRenderer.invoke('terminal-write', name, command),
    terminalOutput: (name, lines) => ipcRenderer.invoke('terminal-output', name, lines),
    terminalClear: (name) => ipcRenderer.invoke('terminal-clear', name),
    terminalKill: (name) => ipcRenderer.invoke('terminal-kill', name),
    terminalList: () => ipcRenderer.invoke('terminal-list'),

    // MCP 桥接
    mcpInit: (force) => ipcRenderer.invoke('mcp-init', force),
    mcpGetTools: () => ipcRenderer.invoke('mcp-get-tools'),
    mcpCallTool: (serverName, toolName, args) => ipcRenderer.invoke('mcp-call-tool', serverName, toolName, args),
    mcpShutdown: () => ipcRenderer.invoke('mcp-shutdown'),
});