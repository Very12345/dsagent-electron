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
    getInitPrompt: () => ipcRenderer.invoke('get-init-prompt'),

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
    agentConfigSave: (cfg) => ipcRenderer.invoke('agent-config-save', cfg),
    agentSkillsLoad: () => ipcRenderer.invoke('agent-skills-load'),
    agentSkillsSave: (skills) => ipcRenderer.invoke('agent-skills-save', skills),
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

    // Qwen 进度推送（单向消息 → agentView）
    qwenProgress: (msg) => ipcRenderer.send('qwen-progress', msg),
    agentNotifyStatus: (msg) => ipcRenderer.send('agent-notify-status', msg),

    // 主题同步
    sendTheme: (theme) => ipcRenderer.send('theme-changed', theme),

    // Agent 视图
    agentForwardResult: (data) => ipcRenderer.send('agent-forward-result', data),

    // 继续生成按钮检测通知（返回用户选择：true=继续生成，false=取消）
    notifyContinueGeneration: () => ipcRenderer.invoke('notify-continue-generation'),

    // 频率限制通知（返回用户选择：true=重试，false=取消）
    agentRateLimitNotify: (waitSeconds) => ipcRenderer.invoke('agent-rate-limit-notify', waitSeconds),

    // 浏览器工具
    browserCreate: (options) => ipcRenderer.invoke('browser-create', options),
    browserExecute: (winId, code) => ipcRenderer.invoke('browser-execute', winId, code),
    browserScreenshot: (winId, saveName) => ipcRenderer.invoke('browser-screenshot', winId, saveName),
    browserNavigate: (winId, url) => ipcRenderer.invoke('browser-navigate', winId, url),
    browserClose: (winId) => ipcRenderer.invoke('browser-close', winId),
    browserList: () => ipcRenderer.invoke('browser-list'),
    browserResize: (winId, width, height) => ipcRenderer.invoke('browser-resize', winId, width, height),
    winapiInvoke: (command) => ipcRenderer.invoke('winapi-invoke', command),

    // 多终端管理
    terminalCreate: (name, cwd) => ipcRenderer.invoke('terminal-create', name, cwd),
    terminalWrite: (name, command) => ipcRenderer.invoke('terminal-write', name, command),
    terminalOutput: (name, lines) => ipcRenderer.invoke('terminal-output', name, lines),
    terminalClear: (name) => ipcRenderer.invoke('terminal-clear', name),
    terminalKill: (name) => ipcRenderer.invoke('terminal-kill', name),
    terminalList: () => ipcRenderer.invoke('terminal-list'),
});