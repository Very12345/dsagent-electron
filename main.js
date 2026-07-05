﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿// DeepSeek Local Agent - Electron 主进程（双栏布局版）
const { app, BrowserWindow, BrowserView, Menu, dialog, session, ipcMain, shell, clipboard, nativeImage, desktopCapturer } = require('electron');
const path = require('path');
const agent = require('./server.js');
const historyManager = require('./history-manager.js');
const fs = require('fs');
const os = require('os');
const { exec } = require('child_process');
const localtunnel = require('localtunnel');

// ==================== 模型服务化架构（新） ====================
const { createDeepseekServer } = require('./server-deepseek.js');
const { createQwenServer } = require('./server-qwen.js');
const { createOpenAIServer } = require('./server-openai.js');
const { createAnthropicServer } = require('./server-anthropic.js');
const { createModelRegistry } = require('./model-registry.js');
const { createOrchestrator } = require('./agent-orchestrator.js');
const { createSubagentManager } = require('./subagent-manager.js');
const clusterTemplates = require('./cluster-templates.js');
const apikeyStore = require('./apikey-store.js');
const promptBuilder = require('./prompt-builder.js');
const memoryStore = require('./memory-store.js');
const hookEngine = require('./hook-engine.js');
const pluginManager = require('./plugin-manager.js');
const skillEngine = require('./skill-engine.js');
const responseProcessor = require('./lib/response-processor.js');

// 全局实例（在 setupIpcHandlers 中初始化，因依赖 deepseekView/qwenView）
let modelRegistry = null;
let orchestrator = null;
let subagentManager = null;
let deepseekServer = null;
let qwenServer = null;

// CLI 请求等待 inject 推送结果的 waiter 队列（方案 A：CLI 复用 inject 的 agentForwardResult 推送）
// key: requestId, value: { resolve, timer, collected: [segments...] }
const cliResultWaiters = new Map();
let _cliRequestIdCounter = 0;
// P0: 后台任务结果缓存（/bg 异步 fire-and-forget，CLI 通过 /api/bg-result 轮询）
const bgTaskResults = {};
let openaiServer = null;
let anthropicServer = null;
// 集群配置持久化路径
function getClusterConfigPath() { return path.join(app.getPath('userData'), '.dsa-cluster-config.json'); }
function loadClusterConfig() {
    try {
        const f = getClusterConfigPath();
        if (!fs.existsSync(f)) return clusterTemplates.defaultClusterConfig();
        return JSON.parse(fs.readFileSync(f, 'utf-8'));
    } catch (e) { return clusterTemplates.defaultClusterConfig(); }
}
function saveClusterConfigToDisk(cfg) {
    try { fs.writeFileSync(getClusterConfigPath(), JSON.stringify(cfg, null, 2), 'utf-8'); return { success: true }; }
    catch (e) { return { success: false, error: e.message }; }
}

// ==================== 配置 ====================
const CONFIG = {
    WINDOW_WIDTH: 1400,
    WINDOW_HEIGHT: 900,
};

const DEEPSEEK_URL = 'https://chat.deepseek.com/';
const DEEPSEEK_FAST_URL = 'https://chat.deepseek.com/';
const DEEPSEEK_IMAGE_URL = 'https://chat.deepseek.com/';

// 模型配置
const MODELS = {
    expert: { name: 'DeepSeek-Expert', url: DEEPSEEK_URL, mode: 'expert' },
    fast: { name: 'Fast', url: DEEPSEEK_FAST_URL, mode: 'quick' },
    imagesupport: { name: 'ImageSupport', url: DEEPSEEK_IMAGE_URL, mode: 'quick' }
};

const VIEWBAR_WIDTH = 60;  // 左侧视图选择栏宽度
const SIDEBAR_WIDTH = 350;
const CTRL_BAR_HEIGHT = 40;
const QWEN_URL = 'https://www.qianwen.com/';
const QWEN_WIDTH = 500;

// 禁用 Chromium 后台节流和窗口遮挡检测，避免 Qwen/Agent 等隐藏视图白屏
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
app.commandLine.appendSwitch('disable-renderer-backgrounding');

// 清理残留的 IndexedDB LOCK 文件（前一个异常退出后的残余锁会导致 cookies/会话无法持久化）
// 必须在 app.whenReady() 之前执行，以免 Chromium 启动后文件被占用
(function() {
    try {
        var userData = app.getPath('userData');
        var idxDbDir = path.join(userData, 'IndexedDB');
        if (fs.existsSync(idxDbDir)) {
            // 递归删除所有 LOCK 文件
            function removeLocks(dir) {
                if (!fs.existsSync(dir)) return;
                var items = fs.readdirSync(dir, { withFileTypes: true });
                for (var i = 0; i < items.length; i++) {
                    var full = path.join(dir, items[i].name);
                    if (items[i].isDirectory()) {
                        removeLocks(full);
                    } else if (items[i].name === 'LOCK') {
                        try { fs.unlinkSync(full); } catch(e) {}
                    }
                }
            }
            removeLocks(idxDbDir);
        }
        // 同样清理 File System 目录的 LOCK
        var fsDir = path.join(userData, 'File System');
        if (fs.existsSync(fsDir)) {
            function removeFsLocks(dir) {
                if (!fs.existsSync(dir)) return;
                var items = fs.readdirSync(dir, { withFileTypes: true });
                for (var i = 0; i < items.length; i++) {
                    var full = path.join(dir, items[i].name);
                    if (items[i].isDirectory()) {
                        removeFsLocks(full);
                    } else if (items[i].name === 'LOCK' || items[i].name.endsWith('.lock')) {
                        try { fs.unlinkSync(full); } catch(e) {}
                    }
                }
            }
            removeFsLocks(fsDir);
        }
    } catch(e) { /* 清理失败不阻塞启动 */ }
})();

// 过滤 Chromium 非关键 C++ 错误日志（`--disable-logging` 已禁大部分，剩余的用 console.error 兜底）
(function() {
    var _origError = console.error;
    console.error = function() {
        var msg = arguments[0] && String(arguments[0]);
        if (msg && (
            msg.indexOf('cache_util_win') >= 0 ||
            msg.indexOf('disk_cache.cc') >= 0 ||
            msg.indexOf('gpu_disk_cache') >= 0 ||
            msg.indexOf('sandbox_origin_database') >= 0 ||
            msg.indexOf('leveldb_factory.cc') >= 0 ||
            msg.indexOf('LOCK: File currently in use') >= 0
        )) return;
        _origError.apply(console, arguments);
    };
})();

let mainWindow = null;
let currentRootDir = null;  // null = 未打开文件夹
var _startupComplete = false;  // 启动动画是否完成（期间禁止 shell 显示）

// 机器人插件宿主：QQ / 微信 / 飞书 三个平台以插件形式接入，
// 各自逻辑在 plugins/*/index.js，宿主统一装配。botQQ 为 QQ 插件导出引用。
const pluginHost = require('./plugins/plugin-host.js');
let botQQ = null;          // QQ 插件导出（getInstance/getAuthorizedUser/notifyPlanSync/shutdown/setAwaitingConfirm）
let deepseekView = null;
let qwenView = null;
let qwenVisible = false;    // Qwen 视图是否可见
let shellView = null;  // 合并 viewbar/controlbar/filebrowser 的外壳视图
let agentView = null;
let agentViewVisible = true;
let prevAgentViewVisible = false; // 用于 updateBounds 检测 Agent 从隐藏变为可见
let prevQwenVisible = false;      // 用于 updateBounds 检测 Qwen 从隐藏变为可见
let currentView = 'agent'; // 'deepseek' | 'qwen' | 'agent' | 'follow'
let userStoppedGeneration = false;  // 标记用户是否主动点击了停止按钮
let lastActiveView = 'deepseek';   // 跟随模式下上次活跃的视图
let currentAppTheme = 'dark';       // 当前应用主题

// 从持久化配置读取当前确认模式
function getConfirmMode() {
    try {
        var cfgRes = agent.loadConfig();
        return (cfgRes.config && cfgRes.config.confirmMode) || 'smart';
    } catch (e) {
        return 'smart';
    }
}

const RECENT_FILE = path.join(app.getPath('userData'), 'recent-projects.json');
const MAX_RECENT = 10;
const STATE_FILE = path.join(app.getPath('userData'), 'app-state.json');

// ==================== 应用状态保存/恢复 ====================
function loadAppState() {
    try {
        if (fs.existsSync(STATE_FILE)) {
            return JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
        }
    } catch (e) { console.error('加载应用状态失败:', e); }
    return {};
}

function saveAppState(state) {
    try {
        const existing = loadAppState();
        const merged = { ...existing, ...state };
        fs.writeFileSync(STATE_FILE, JSON.stringify(merged, null, 2), 'utf-8');
    } catch (e) { console.error('保存应用状态失败:', e); }
}

// ==================== 最近项目 ====================
function loadRecentProjects() {
    try {
        if (fs.existsSync(RECENT_FILE)) {
            return JSON.parse(fs.readFileSync(RECENT_FILE, 'utf-8'));
        }
    } catch (e) {}
    return [];
}

function saveRecentProject(folderPath) {
    let recent = loadRecentProjects();
    // 去重，移到最前面
    recent = recent.filter(p => p !== folderPath);
    recent.unshift(folderPath);
    if (recent.length > MAX_RECENT) recent = recent.slice(0, MAX_RECENT);
    fs.writeFileSync(RECENT_FILE, JSON.stringify(recent, null, 2), 'utf-8');
}

// ==================== 停止一切操作 ====================
async function stopAll() {
    userStoppedGeneration = true;
    // 1. 停止 DeepSeek 生成
    if (deepseekView) {
        try {
            await deepseekView.webContents.executeJavaScript(
                'window.__dsagent_stopGeneration && window.__dsagent_stopGeneration()'
            );
        } catch (e) {
            console.warn('[Stop] DeepSeek stop failed:', e);
        }
    }
    // 2. 设置停止标记（阻止后续命令执行）
    if (deepseekView) {
        try {
            await deepseekView.webContents.executeJavaScript(
                'window.__dsagent_setStopRequested && window.__dsagent_setStopRequested(true)'
            );
        } catch (e) {
            console.warn('[Stop] Set stop flag failed:', e);
        }
    }
    // 3. 尝试停止 Qwen 页面生成
    if (qwenView && !qwenView.webContents.isDestroyed()) {
        try {
            await qwenView.webContents.executeJavaScript(
                'window.__qwen_stopGeneration && window.__qwen_stopGeneration()'
            );
        } catch (e) {
            // optional
        }
    }
    // 4. 切换到 Agent 视图
    if (currentView === 'follow') {
        agentViewVisible = true;
        qwenVisible = false;
        updateBounds();
    }
}

function openFolder(folderPath, opts) {
    opts = opts || {};
    currentRootDir = folderPath;
    agent.setBaseDir(folderPath);
    shellSend('root-changed', folderPath);
    saveRecentProject(folderPath);
    saveAppState({ lastRootDir: folderPath });
    rebuildMenu();

    if (opts.skipCloseConversation) {
        // 启动恢复场景：不关闭当前对话，也不把 DeepSeek 切回首页
        return;
    }

    // 切换目录 → 更新 cwd，保持当前会话运行
    agent.setCwd(folderPath);
    console.log('[OpenFolder] CWD updated to:', folderPath);
    // 通知 Agent 视图 cwd 变更（不关闭对话）
    if (agentView && agentView.webContents && !agentView.webContents.isDestroyed()) {
        agentView.webContents.send('cwd-changed', { path: folderPath });
    }
    // 刷新历史对话列表（显示新目录下的历史）
    if (agentView && agentView.webContents && !agentView.webContents.isDestroyed()) {
        agentView.webContents.send('refresh-history');
    }
}

// ==================== 读取注入脚本 ====================
function getDeepseekInjectScript() {
    const injectPath = path.join(__dirname, 'inject-deepseek.js');
    const toolsDir = path.join(__dirname, 'tools');
    let combined = '';
    // 1. 加载工具系统核心
    const systemPath = path.join(toolsDir, 'tool-system.js');
    if (fs.existsSync(systemPath)) {
        combined += fs.readFileSync(systemPath, 'utf-8') + '\n';
    }
    // 2. 加载各工具文件（按名称排序）
    if (fs.existsSync(toolsDir)) {
        const toolFiles = fs.readdirSync(toolsDir)
            .filter(f => f.startsWith('tool-') && f.endsWith('.js') && f !== 'tool-system.js')
            .sort();
        for (const f of toolFiles) {
            combined += fs.readFileSync(path.join(toolsDir, f), 'utf-8') + '\n';
        }
    }
    // 3. 加载 Agent 引擎（业务逻辑层，无 DOM 依赖）
    const enginePath = path.join(__dirname, 'agent-engine.js');
    if (fs.existsSync(enginePath)) {
        combined += fs.readFileSync(enginePath, 'utf-8') + '\n';
    }
    // 4. 加载主注入脚本（DOM 操作层）
    combined += fs.readFileSync(injectPath, 'utf-8');
    return combined;
}

function getQwenInjectScript() {
    const toolsDir = path.join(__dirname, 'tools');
    let combined = '';
    // 1. 加载工具系统核心（共享解析器依赖）
    const systemPath = path.join(toolsDir, 'tool-system.js');
    if (fs.existsSync(systemPath)) {
        combined += fs.readFileSync(systemPath, 'utf-8') + '\n';
    }
    // 2. 加载共享解析器
    const parserPath = path.join(toolsDir, 'tool-parser.js');
    if (fs.existsSync(parserPath)) {
        combined += fs.readFileSync(parserPath, 'utf-8') + '\n';
    }
    // 3. 加载 Qwen 注入脚本
    const qwenPath = path.join(__dirname, 'inject-qwen.js');
    combined += fs.readFileSync(qwenPath, 'utf-8');
    return combined;
}

// ==================== 修改 CSP 头 ====================
function setupSession() {
    const ses = session.defaultSession;

    ses.webRequest.onHeadersReceived((details, callback) => {
        const responseHeaders = details.responseHeaders || {};
        delete responseHeaders['content-security-policy'];
        delete responseHeaders['Content-Security-Policy'];
        delete responseHeaders['content-security-policy-report-only'];
        delete responseHeaders['Content-Security-Policy-Report-Only'];
        delete responseHeaders['x-frame-options'];
        delete responseHeaders['X-Frame-Options'];
        callback({ responseHeaders });
    });

    ses.setPermissionRequestHandler((webContents, permission, callback) => {
        callback(true);
    });
}

// ==================== Agent IPC 处理器 ====================
// 技能计数同步到视图栏
function syncSkillsCount() {
    var skills = (agent.loadSkills().skills || []);
    shellSend('ctrl-skills-count', skills.length);
}

// ── 文件操作追踪（供 orchestrator 读取，用于压缩后状态恢复） ──
var _fileOpTracker = { task: '', filesRead: [], filesEdited: [] };
function recordFileOp(type, filePath) {
    if (!filePath) return;
    if (type === 'read') {
        if (!_fileOpTracker.filesRead.includes(filePath)) _fileOpTracker.filesRead.push(filePath);
    } else if (type === 'edit') {
        if (!_fileOpTracker.filesEdited.includes(filePath)) _fileOpTracker.filesEdited.push(filePath);
    }
    if (_fileOpTracker.filesRead.length > 20) _fileOpTracker.filesRead.shift();
    if (_fileOpTracker.filesEdited.length > 20) _fileOpTracker.filesEdited.shift();
}
function getFileOpTracker() { return JSON.parse(JSON.stringify(_fileOpTracker)); }
function setFileOpTask(task) { _fileOpTracker.task = task ? task.substring(0, 200) : ''; }
function resetFileOpTracker() { _fileOpTracker = { task: '', filesRead: [], filesEdited: [] }; }

function setupAgentIPC() {
    // IPC handler for reading file op tracker
    ipcMain.handle('get-file-op-tracker', async () => getFileOpTracker());
    ipcMain.handle('set-file-op-task', async (event, task) => { setFileOpTask(task); return true; });
    ipcMain.handle('reset-file-op-tracker', async () => { resetFileOpTracker(); return true; });
    ipcMain.handle('agent-exec', async (event, cmd, timeoutMs) => {
        // 默认 30 秒超时，防止 start 等阻塞型命令卡死
        return await agent.execCmd(cmd, timeoutMs || 30000);
    });

    // 通用工具调用分发（供调试面板 ⚡ 使用，直接输入工具 JSON）
    ipcMain.handle('agent-tool', async (event, payload) => {
        try {
            var toolName, toolParams, toolBody;
            if (typeof payload === 'string') {
                try { payload = JSON.parse(payload); } catch(e) { return { success: false, error: 'JSON 解析失败: ' + e.message }; }
            }
            toolName = (payload.tool || '').toLowerCase();
            toolParams = payload.params || {};
            toolBody = payload.body || '';

            // 映射 tool 名称到 agent 方法
            var toolMap = {
                'exec':      function() { return agent.execCmd(toolBody, toolParams.timeout || 30000); },
                'cmd':       function() { return agent.execCmd(toolBody, toolParams.timeout || 30000); },
                'exec-admin': function() { return agent.execCmdAdmin(toolBody); },
                'read':      function() {
                    var p = toolParams.path || toolBody;
                    recordFileOp('read', p);
                    return agent.readFile(p);
                },
                'readfile':  function() { return agent.readFileBase64(toolParams.path || toolBody); },
                'save':      function() {
                    var p = toolParams.path || toolBody;
                    recordFileOp('edit', p);
                    return agent.saveFile(p, toolParams.content || '');
                },
                'edit':      function() {
                    var p = toolParams.path || toolBody;
                    recordFileOp('edit', p);
                    return agent.editFile(p, toolParams.find, toolParams.regex, toolParams.replace);
                },
                'list':      function() { return agent.listDir(toolParams.path || toolBody || '.'); },
                'delete':    function() { return agent.deleteFile(toolParams.path || toolBody); },
                'mkdir':     function() { return agent.makeDir(toolParams.path || toolBody); },
                'exists':    function() { return agent.checkExists(toolParams.path || toolBody); },
                'info':      function() { return agent.getInfo(toolParams.path || toolBody); },
            };

            if (toolName && toolMap[toolName]) {
                return await toolMap[toolName]();
            }
            return { success: false, error: '未识别的工具: ' + (toolName || '(空)') + '\n\n支持的工具: ' + Object.keys(toolMap).join(', ') + '\n\n格式: {"tool": "exec", "params": {"timeout": 60000}, "body": "echo hello"}' };
        } catch(e) {
            return { success: false, error: 'agent-tool 执行失败: ' + e.message };
        }
    });

    ipcMain.handle('agent-exec-admin', async (event, cmd) => {
        return await agent.execCmdAdmin(cmd);
    });

    ipcMain.handle('agent-read', async (event, filePath) => {
        return agent.readFile(filePath);
    });

    ipcMain.handle('agent-readFile', async (event, filePath) => {
        return agent.readFileBase64(filePath);
    });

    ipcMain.handle('agent-save', async (event, filePath, content) => {
        return agent.saveFile(filePath, content);
    });

    ipcMain.handle('agent-edit', async (event, filePath, find, regex, replace) => {
        return agent.editFile(filePath, find, regex, replace);
    });

    // ==================== P2: 并行多文件编辑（参考 atomcode tool/parallel_edit.rs） ====================
    // 接收 {files:[{path,find,replace,regex?}], contract} 在主进程内并行 fan-out 调 agent.editFile
    // 各文件独立执行，失败不影响其他，汇总返回成功/失败统计 + 逐条结果
    ipcMain.handle('parallel-edit', async (event, payload) => {
        try {
            var files = (payload && payload.files) || [];
            if (!Array.isArray(files) || files.length < 2 || files.length > 12) {
                return { success: false, error: 'files 数组长度须在 2-12 之间' };
            }
            // 并行 fan-out：每个文件一个 Promise，互不阻塞
            var tasks = files.map(function(f) {
                return (async function() {
                    try {
                        // 编辑前备份（与单文件 edit 一致）
                        try { fileHistory.backupBeforeWrite(f.path); } catch(e) {}
                        var r = await agent.editFile(f.path, f.find, !!f.regex, f.replace || '');
                        var result = {
                            path: f.path,
                            success: !!r.success,
                            message: r.message || '',
                            error: r.error || null,
                            changed: !!r.changed,
                            syntaxError: null
                        };
                        // 编辑成功后跑语法检查（参考 atomcode auto_fix.rs）
                        if (result.success && result.changed) {
                            try {
                                var sc = await runSyntaxCheck(f.path);
                                if (sc && sc.error) {
                                    result.syntaxError = sc.error;
                                    // 把语法错误追加到 message，让 LLM 看到并继续修
                                    result.message = (result.message || '') + '\n⚠ SYNTAX ERROR: ' + sc.error;
                                }
                            } catch(e) {}
                        }
                        return result;
                    } catch(e) {
                        return { path: f.path, success: false, message: '', error: e.message || String(e), changed: false, syntaxError: null };
                    }
                })();
            });
            var results = await Promise.all(tasks);
            var succeeded = results.filter(function(r) { return r.success; }).length;
            var failed = results.length - succeeded;
            return {
                success: true,
                total: results.length,
                succeeded: succeeded,
                failed: failed,
                results: results
            };
        } catch (e) {
            return { success: false, error: 'parallel-edit 异常: ' + (e.message || e) };
        }
    });

    ipcMain.handle('agent-list', async (event, dirPath) => {
        return agent.listDir(dirPath);
    });

    ipcMain.handle('agent-delete', async (event, filePath) => {
        return agent.deleteFile(filePath);
    });

    ipcMain.handle('agent-mkdir', async (event, dirPath) => {
        return agent.makeDir(dirPath);
    });

    ipcMain.handle('agent-exists', async (event, filePath) => {
        return agent.checkExists(filePath);
    });

    ipcMain.handle('agent-info', async (event, filePath) => {
        return agent.getInfo(filePath);
    });

    ipcMain.handle('agent-config-load', async () => {
        return agent.loadConfig();
    });

    ipcMain.handle('agent-config-save', async (event, config) => {
        return agent.saveConfig(config);
    });

    // 记忆系统 IPC（供 memory-read/memory-append 工具调用）
    var memoryStore = require('./memory-store.js');
    ipcMain.handle('agent-memory-read', async (event, scope) => {
        var rootDir = agent.getBaseDir();
        return memoryStore.handleMemoryRead(rootDir);
    });
    ipcMain.handle('agent-memory-append', async (event, content, scope) => {
        var rootDir = agent.getBaseDir();
        var ok = memoryStore.handleMemoryAppend(rootDir, scope, content);
        return { success: ok };
    });

    // Askpass IPC（启动 socket server + 注入环境变量）
    function injectAskpass(deepseekView) {
        try {
            var askpass = require('./askpass-server.js');
            var askpassServer = askpass.createAskpassServer(function(prompt) {
                return new Promise(function(resolve) {
                    if (agentView && agentView.webContents && !agentView.webContents.isDestroyed()) {
                        agentView.webContents.send('askpass-prompt', { prompt: prompt });
                        ipcMain.handleOnce('askpass-response-' + Date.now(), function(ev, pwd) { resolve(pwd); });
                        // 超时 60 秒
                        setTimeout(function() { resolve(''); }, 60000);
                    } else { resolve(''); }
                });
            });
            askpassServer.start().then(function(socketPath) {
                // 注入 SSH_ASKPASS / SUDO_ASKPASS 环境变量给子进程
                var binPath = path.join(__dirname, 'bin', 'dsagent-cli.bat');
                if (!fs.existsSync(binPath)) {
                    binPath = path.join(__dirname, 'askpass-helper.cmd');
                    // 创建 helper 脚本
                    var helperContent = '@echo off\nnode "' + __dirname.replace(/\\/g, '/') + '/askpass-server.js" askpass\n';
                    fs.writeFileSync(binPath, helperContent, 'utf-8');
                }
                process.env.SSH_ASKPASS = binPath;
                process.env.SUDO_ASKPASS = binPath;
                process.env.DSAGENT_ASKPASS_SOCKET = socketPath;
                console.log('[Askpass] Server ready at', socketPath);
            });
        } catch(e) { console.warn('[Askpass] Failed to init:', e.message); }
    }

    // 记忆管理
    ipcMain.handle('memory-get', async (event, type) => {
        var filePath = path.join(app.getPath('userData'), '.dsa-memory-' + type + '.json');
        try {
            if (fs.existsSync(filePath)) {
                var data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
                return { success: true, content: data.content || '' };
            }
            return { success: true, content: '' };
        } catch (e) {
            return { success: true, content: '' };
        }
    });
    ipcMain.handle('memory-set', async (event, type, content) => {
        var filePath = path.join(app.getPath('userData'), '.dsa-memory-' + type + '.json');
        try {
            fs.writeFileSync(filePath, JSON.stringify({ type: type, content: content, updatedAt: new Date().toISOString() }), 'utf-8');
            return { success: true };
        } catch (e) {
            return { success: false, error: e.message };
        }
    });

    ipcMain.handle('agent-whitelist-add', async (event, cmd) => {
        return agent.addWhitelist(cmd);
    });

    ipcMain.handle('agent-whitelist-remove', async (event, cmd) => {
        return agent.removeWhitelist(cmd);
    });

    ipcMain.handle('agent-whitelist-check', async (event, cmd) => {
        return agent.checkWhitelist(cmd);
    });

    // ==================== WinAPI 窗口操作 IPC ====================
    (function() {
        var WINAPI_PS1 = path.join(__dirname, 'tools', 'winapi.ps1');
        var cp = require('child_process');
        var util = require('util');
        var execP = util.promisify(cp.exec);

        function ensureWinapiTempDir() {
            var tempDir;
            if (currentRootDir) {
                tempDir = path.join(currentRootDir, '.dsa', 'temp', 'screenshots');
            } else {
                tempDir = path.join(app.getPath('userData'), '.dsa-agent', 'screenshots');
            }
            if (!fs.existsSync(tempDir)) {
                fs.mkdirSync(tempDir, { recursive: true });
            }
            return tempDir;
        }

        // 确保 winapi.ps1 文件有 UTF-8 BOM（防止 PowerShell 5 按 ANSI 解析）
        try {
            var bomContent = fs.readFileSync(WINAPI_PS1, 'utf-8');
            var bom = Buffer.from([0xEF, 0xBB, 0xBF]);
            var bomContentBuf = Buffer.from(bomContent, 'utf-8');
            fs.writeFileSync(WINAPI_PS1, Buffer.concat([bom, bomContentBuf]));
        } catch(ebom) {}

        ipcMain.handle('winapi-invoke', async (event, command) => {
            try {
                // 每次调用前确保 winapi.ps1 是 UTF-8 BOM 编码
                try {
                    var _raw = fs.readFileSync(WINAPI_PS1);
                    if (_raw[0] !== 0xEF || _raw[1] !== 0xBB || _raw[2] !== 0xBF) {
                        fs.writeFileSync(WINAPI_PS1, Buffer.concat([Buffer.from([0xEF,0xBB,0xBF]), _raw]));
                    }
                } catch(_e) {}

                // 如果是 screenshot 操作，自动生成保存路径
                if (command.action === 'screenshot' && !command.params.savePath) {
                    var tempDir = ensureWinapiTempDir();
                    var filename = 'winapi_ss_' + Date.now() + '.png';
                    command.params.savePath = path.join(tempDir, filename);
                }

                // 写命令 JSON 到临时文件
                var tempJsonFile = path.join(os.tmpdir(), '_dsa_winapi_' + Date.now() + '.json');
                fs.writeFileSync(tempJsonFile, JSON.stringify(command), 'utf-8');

                // 使用 stdin 重定向传入 JSON 文件内容，完全避免命令行参数传递问题
                var psCmd = 'powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + WINAPI_PS1 + '" < "' + tempJsonFile + '"';
                var execResult = await execP(psCmd, { timeout: 30000 });

                try {
                    fs.unlinkSync(tempJsonFile);
                } catch (e) {}

                try {
                    var parsed = JSON.parse(execResult.stdout);
                    return parsed;
                } catch (e) {
                    return { success: false, error: 'PowerShell parse error: ' + (execResult.stdout || execResult.stderr || '').substring(0, 300) };
                }
            } catch (e) {
                return { success: false, error: e.message };
            }
        });
    })();

    ipcMain.handle('agent-skills-load', async () => {
        return agent.loadSkills();
    });

    ipcMain.handle('agent-skills-save', async (event, skills) => {
        // 新版技能系统不再支持直接保存 JSON，保留以兼容但提示废弃
        return { success: false, error: '请通过视图栏的导入按钮导入技能文件夹（SKILL.md 格式）' };
    });

    // 删除技能
    ipcMain.handle('agent-skills-delete', async (event, skillName) => {
        var result = agent.deleteSkill(skillName);
        syncSkillsCount();
        return result;
    });

    ipcMain.handle('agent-ping', async () => {
        return { success: true };
    });

    // 获取技能完整内容（skill 命令）
    ipcMain.handle('agent-skill-get-content', async (event, skillName) => {
        return agent.getSkillContent(skillName);
    });

    // 技能禁用/启用
    ipcMain.handle('agent-skill-toggle-disabled', async (event, skillName) => {
        return agent.toggleSkillDisabled(skillName);
    });

    ipcMain.handle('agent-skill-get-disabled', async () => {
        return { success: true, disabledSkills: agent.getDisabledSkills() };
    });

    // 同步单个技能到工作目录
    ipcMain.on('sync-skill-to-workdir', async (event, skillName) => {
        try {
            var result = agent.syncSkillToWorkDir(skillName);
            if (result.success) {
                syncSkillsCount();
            }
        } catch (e) {
            console.warn('[SKILLS] Sync failed:', e.message);
        }
    });

    // 取消同步：从工作目录移除技能
    ipcMain.on('unsync-skill', async (event, skillName) => {
        try {
            var result = agent.unsyncSkill(skillName);
            if (result.success) {
                syncSkillsCount();
                shellSend('ctrl-notify', '已取消同步: ' + skillName);
            }
        } catch (e) {
            console.warn('[SKILLS] Unsync failed:', e.message);
        }
    });

    // invoke 版本：供 AI 工具 (dsa) 使用，返回结果
    ipcMain.handle('agent-skill-sync', async (event, skillName) => {
        try {
            var result = agent.syncSkillToWorkDir(skillName);
            if (result.success) syncSkillsCount();
            return result;
        } catch (e) {
            return { success: false, error: e.message };
        }
    });

    ipcMain.handle('agent-skill-unsync', async (event, skillName) => {
        try {
            var result = agent.unsyncSkill(skillName);
            if (result.success) syncSkillsCount();
            return result;
        } catch (e) {
            return { success: false, error: e.message };
        }
    });

    ipcMain.handle('agent-skill-delete', async (event, skillName) => {
        try {
            var result = agent.deleteSkill(skillName);
            syncSkillsCount();
            return result;
        } catch (e) {
            return { success: false, error: e.message };
        }
    });

    // 获取技能存储路径
    ipcMain.handle('agent-skills-storage-path', async () => {
        return agent.getSkillsStoragePath();
    });

    // 设置技能存储路径
    ipcMain.handle('agent-skills-set-storage-path', async (event, newPath) => {
        return agent.setSkillsStoragePath(newPath);
    });

    // 获取仓库中技能列表（用于同步选择）
    ipcMain.handle('agent-skills-repo-list', async () => {
        return agent.listRepoSkills();
    });

    // 获取已同步的技能名称列表
    ipcMain.handle('agent-skills-synced-list', async () => {
        return { success: true, names: agent.getSyncedSkillNames() };
    });

    // 选择技能存储路径文件夹
    ipcMain.handle('agent-skills-select-folder', async () => {
        var result = await dialog.showOpenDialog(mainWindow, {
            title: '选择技能存储路径',
            properties: ['openDirectory']
        });
        if (result.canceled || result.filePaths.length === 0) return { success: true, path: null };
        return { success: true, path: result.filePaths[0] };
    });

    // ===== 定时任务管理系统（主进程驱动，完整队列+状态机） =====
    var _intervalTasks = {};
    var _intervalQueue = [];           // 待发送的消息队列
    var _intervalState = { isExecuting: false, isGenerating: false };  // AI 状态（由 agentview 同步）
    var _savedIntervalTasks = [];      // 退出对话时保存的任务列表（用于恢复）

    // agentview 同步 AI 状态
    ipcMain.on('interval-state-update', (event, state) => {
        _intervalState.isExecuting = !!state.isExecuting;
        _intervalState.isGenerating = !!state.isGenerating;
    });

    // agentview 通知队列清空（工作流结束/生成完成时）
    ipcMain.on('interval-flush-queue', () => {
        flushIntervalQueue('workflow-end');
    });

    function flushIntervalQueue(reason) {
        if (_intervalQueue.length === 0) return;

        // 原子交换：避免竞态条件导致消息丢失
        var toFlush = _intervalQueue;
        _intervalQueue = [];

        var combined = toFlush.join('\n\n---\n\n');
        console.log('[Interval] Flushing queue (' + reason + '): ' + combined.substring(0, 80) + '...');

        if (deepseekView && deepseekView.webContents && !deepseekView.webContents.isDestroyed()) {
            deepseekView.webContents.executeJavaScript(
                'window.__dsagent_fillAndSend && window.__dsagent_fillAndSend(' + JSON.stringify(combined) + ');'
            ).catch(function(e) {
                console.warn('[Interval] flush fillAndSend failed:', e.message);
                // 失败时放回队列头部（避免丢失）
                _intervalQueue.unshift(combined);
            });
        } else {
            console.warn('[Interval] deepseekView not available, messages lost');
        }
    }

    function _intervalScheduleNext(task) {
        task.timerId = setTimeout(async function() {
            if (!_intervalTasks[task.taskName]) return;
            task.iteration++;

            var timestamp = new Date().toLocaleTimeString('zh-CN');
            var iterMsg;

            if (task.mode === 'command') {
                try {
                    var result = await deepseekView.webContents.executeJavaScript(
                        '(async function(){ try { var r = await window.__dsagent_execLocal(' + JSON.stringify(task.command) + '); return typeof r === "string" ? r : JSON.stringify(r); } catch(e) { return "⚠️ 执行异常: " + e.message; } })()'
                    );
                    if (typeof result === 'string' && result.indexOf('命令已超时') >= 0) {
                        stopMainIntervalTask(task.taskName, '命令执行超时');
                        return;
                    }
                    iterMsg = '【定时信息】[任务: ' + task.taskName + '] [' + timestamp + '] (第' + task.iteration + '次)\n' + (result || '(无输出)');
                } catch(e) {
                    iterMsg = '【定时信息】[任务: ' + task.taskName + '] [' + timestamp + '] (第' + task.iteration + '次)\n⚠️ 执行异常: ' + e.message;
                }
            } else {
                iterMsg = '【定时信息】[任务: ' + task.taskName + '] [' + timestamp + '] (第' + task.iteration + '次)\n' + (task.message || '(无内容)');
            }

            // ===== 核心决策：AI 状态决定发送或入队 =====
            if (_intervalState.isExecuting || _intervalState.isGenerating) {
                // AI 忙 → 入队，等 workflow 结束再 flush
                _intervalQueue.push(iterMsg);
                console.log('[Interval] Queued: ' + task.taskName + ' #' + task.iteration + ' queue=' + _intervalQueue.length + ' exec=' + _intervalState.isExecuting + ' gen=' + _intervalState.isGenerating);
            } else {
                // AI 完全空闲 → 直接发送（入队后一次 flush）
                _intervalQueue.push(iterMsg);
                flushIntervalQueue('idle');
                // 短暂禁用用户发送按钮（通过 executeJavaScript 让 DeepSeek 页面关闭发送）
                try {
                    deepseekView.webContents.executeJavaScript(
                        'var b = document.querySelector("div.ds-button--primary.ds-button--filled"); if(b) { b.style.pointerEvents="none"; setTimeout(function(){ b.style.pointerEvents=""; }, 200); }'
                    );
                } catch(e) {
                    console.warn('[Interval] Failed to disable send button:', e.message);
                }
            }

            // 通知 agentview 更新 UI
            if (agentView && agentView.webContents && !agentView.webContents.isDestroyed()) {
                agentView.webContents.send('agent-message', {
                    type: 'interval-trigger',
                    taskName: task.taskName,
                    interval: task.interval,
                    iteration: task.iteration,
                    mode: task.mode
                });
            }

            // 安排下一轮
            _intervalScheduleNext(task);
        }, task.interval);
    }

    function stopMainIntervalTask(taskName, reason) {
        var task = _intervalTasks[taskName];
        if (!task) return;
        if (task.timerId) clearTimeout(task.timerId);
        delete _intervalTasks[taskName];
        console.log('[Interval] STOPPED: ' + taskName + (reason ? ' (' + reason + ')' : ''));
        if (agentView && agentView.webContents && !agentView.webContents.isDestroyed()) {
            agentView.webContents.send('agent-message', {
                type: 'interval-stop', taskName: taskName
            });
        }
    }

    // 从 agentview/工具调用 添加定时任务
    ipcMain.handle('interval-create', async (event, params) => {
        var taskName = params.taskName;
        if (!taskName) return { success: false, error: '缺少 taskName' };
        if (_intervalTasks[taskName]) return { success: false, error: '任务 "' + taskName + '" 已存在' };

        var task = {
            taskName: taskName,
            interval: params.interval || 5000,
            mode: params.mode || 'command',
            command: params.command || '',
            message: params.message || '',
            iteration: 0,
            createdAt: Date.now(),
            timerId: null
        };
        _intervalTasks[taskName] = task;
        _intervalScheduleNext(task);

        console.log('[Interval] CREATED: ' + taskName + ' interval=' + task.interval + 'ms mode=' + task.mode);

        if (agentView && agentView.webContents && !agentView.webContents.isDestroyed()) {
            agentView.webContents.send('agent-message', {
                type: 'interval-start',
                taskName: taskName,
                command: task.mode === 'command' ? task.command : task.message,
                interval: task.interval,
                mode: task.mode
            });
        }

        var modeLabel = task.mode === 'command' ? '执行命令' : '定时提醒';
        var detail = task.mode === 'command' ? task.command : task.message;
        return {
            success: true,
            result: '✅ 后台定时任务 "' + taskName + '" 已创建（' + modeLabel + '，每 ' + (task.interval/1000).toFixed(1) + ' 秒）。\n'
                + '内容: ' + (detail.length > 60 ? detail.substring(0, 60) + '...' : detail) + '\n'
                + '对话可正常继续，定时消息将自动注入。使用 stop 停止。'
        };
    });

    // 停止定时任务
    ipcMain.handle('interval-stop', async (event, taskName) => {
        stopMainIntervalTask(taskName);
        return { success: true, result: '已停止定时任务 "' + taskName + '"' };
    });

    // 列出定时任务
    ipcMain.handle('interval-list', async () => {
        var names = Object.keys(_intervalTasks);
        var tasks = names.map(function(n) {
            var t = _intervalTasks[n];
            return { taskName: n, interval: t.interval, mode: t.mode, iteration: t.iteration, createdAt: t.createdAt };
        });
        return { success: true, tasks: tasks };
    });

    // 停止所有定时任务（切换对话时保存，可恢复）
    ipcMain.on('interval-stop-all', () => {
        // 保存当前任务列表（用于恢复）
        _savedIntervalTasks = Object.keys(_intervalTasks).map(function(n) {
            var t = _intervalTasks[n];
            return { taskName: n, interval: t.interval, mode: t.mode, command: t.command, message: t.message, iteration: t.iteration, createdAt: t.createdAt };
        });
        // 停止所有
        var names = Object.keys(_intervalTasks);
        names.forEach(function(n) { stopMainIntervalTask(n); });
        _intervalQueue = [];
        console.log('[Interval] Saved ' + _savedIntervalTasks.length + ' tasks for restore');
    });

    // 用户/AI 主动停止所有任务（不保存，直接清）
    ipcMain.on('interval-stop-all-force', () => {
        _savedIntervalTasks = [];
        var names = Object.keys(_intervalTasks);
        names.forEach(function(n) { stopMainIntervalTask(n); });
        _intervalQueue = [];
        console.log('[Interval] Force stopped all tasks');
    });

    // 获取已保存的任务列表（退出对话时存的）
    ipcMain.handle('interval-get-saved', async () => {
        return { success: true, tasks: _savedIntervalTasks };
    });

    // 清空已保存的任务列表（用户拒绝恢复时）
    ipcMain.handle('interval-clear-saved', async () => {
        _savedIntervalTasks = [];
        return { success: true };
    });

    // 恢复已保存的定时任务
    ipcMain.handle('interval-restore-saved', async () => {
        var restored = [];
        (_savedIntervalTasks || []).forEach(function(saved) {
            if (_intervalTasks[saved.taskName]) return; // 已存在则跳过
            var task = {
                taskName: saved.taskName,
                interval: saved.interval || 5000,
                mode: saved.mode || 'command',
                command: saved.command || '',
                message: saved.message || '',
                iteration: saved.iteration || 0,
                createdAt: saved.createdAt || Date.now(),
                timerId: null
            };
            _intervalTasks[task.taskName] = task;
            _intervalScheduleNext(task);
            restored.push(task.taskName);
            // 通知 agentview
            if (agentView && agentView.webContents && !agentView.webContents.isDestroyed()) {
                agentView.webContents.send('agent-message', {
                    type: 'interval-start',
                    taskName: task.taskName,
                    command: task.mode === 'command' ? task.command : task.message,
                    interval: task.interval,
                    mode: task.mode
                });
            }
        });
        _savedIntervalTasks = []; // 恢复后清空保存列表
        console.log('[Interval] Restored ' + restored.length + ' tasks: ' + restored.join(', '));
        return { success: true, restored: restored };
    });

    // ===== 旧的 interval IPC 保持兼容（转发到新系统） =====
    ipcMain.handle('interval-add-from-ui', async (event, params) => {
        var taskName = params.taskName;
        if (!taskName) return { success: false, error: '缺少 taskName' };
        if (_intervalTasks[taskName]) return { success: false, error: '任务已存在' };
        var task = {
            taskName: taskName,
            interval: params.interval || 5000,
            mode: params.mode || 'command',
            command: params.command || '',
            message: params.message || '',
            iteration: 0,
            createdAt: Date.now(),
            timerId: null
        };
        _intervalTasks[taskName] = task;
        _intervalScheduleNext(task);
        if (agentView && agentView.webContents && !agentView.webContents.isDestroyed()) {
            agentView.webContents.send('agent-message', { type: 'interval-start', taskName: taskName, command: task.mode === 'command' ? task.command : task.message, interval: task.interval, mode: task.mode });
        }
        return { success: true, result: '✅ 已创建' };
    });

    ipcMain.handle('interval-stop-from-ui', async (event, taskName) => {
        stopMainIntervalTask(taskName);
        return { success: true };
    });

    // 剪贴板读取（通过主进程确保访问权限）
    ipcMain.handle('clipboard-read-text', () => {
        const { clipboard } = require('electron');
        return clipboard.readText();
    });
    ipcMain.handle('clipboard-write-text', (event, text) => {
        const { clipboard } = require('electron');
        clipboard.writeText(text || '');
        return { success: true };
    });
    // 剪贴板保存（用于临时操作后还原）
    ipcMain.handle('clipboard-save', () => {
        const { clipboard } = require('electron');
        return { text: clipboard.readText() };
    });
    // 剪贴板还原
    ipcMain.handle('clipboard-restore', (event, savedText) => {
        const { clipboard } = require('electron');
        if (savedText !== undefined && savedText !== null) {
            clipboard.writeText(savedText);
        }
        return { success: true };
    });

    // ==================== Qwen IPC 处理器 ====================
    ipcMain.handle('qwen-exec', async (event, fnName, args) => {
        if (!qwenView || qwenView.webContents.isDestroyed() || qwenView.webContents.isLoading()) return { success: false, error: 'Qwen view not ready' };
        try {
            const argsJson = JSON.stringify(args || []);
            const result = await qwenView.webContents.executeJavaScript(
                `window.__qwen && window.__qwen.${fnName}.apply(null, ${argsJson})`
            );
            return { success: true, result: result };
        } catch (e) {
            return { success: false, error: e.message };
        }
    });

    ipcMain.handle('qwen-check-ready', async () => {
        if (!qwenView || qwenView.webContents.isDestroyed() || qwenView.webContents.isLoading()) return { success: false, ready: false };
        try {
            const ready = await qwenView.webContents.executeJavaScript(
                'window.__qwen && window.__qwen.ready === true'
            );
            return { success: true, ready: !!ready };
        } catch (e) {
            return { success: false, ready: false, error: e.message };
        }
    });

    // 从 Qwen 页面下载图片
    ipcMain.handle('qwen-download-image', async (event, imageUrl, savePath) => {
        if (!qwenView) return { success: false, error: 'Qwen view not initialized' };
        try {
            const b64Result = await qwenView.webContents.executeJavaScript(`
                (async function() {
                    try {
                        var resp = await fetch(${JSON.stringify(imageUrl)});
                        var blob = await resp.blob();
                        return new Promise(function(res) {
                            var reader = new FileReader();
                            reader.onloadend = function() { res(reader.result); };
                            reader.readAsDataURL(blob);
                        });
                    } catch(e) { return { error: e.message }; }
                })()
            `);
            if (b64Result && b64Result.error) {
                return { success: false, error: b64Result.error };
            }
            if (typeof b64Result === 'string' && b64Result.indexOf('base64,') !== -1) {
                const b64Data = b64Result.split('base64,')[1];
                const resolvedPath = path.resolve(savePath);
                const dir = path.dirname(resolvedPath);
                if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
                fs.writeFileSync(resolvedPath, Buffer.from(b64Data, 'base64'));
                // 同时返回 base64 data URL，供内联显示在 Agent 界面
                return { success: true, path: resolvedPath, dataUrl: b64Result };
            }
            return { success: false, error: 'Failed to decode image data' };
        } catch (e) {
            return { success: false, error: e.message };
        }
    });

    // 准备 PPT 下载：设置一次性 will-download 拦截，等待下载完成
    var qwenPPTDownloadResolve = null;
    ipcMain.handle('qwen-prepare-ppt-download', async (event, saveDir) => {
        return new Promise(function(resolve) {
            if (!qwenView || qwenView.webContents.isDestroyed()) {
                resolve({ success: false, error: 'Qwen view not available' });
                return;
            }
            var ses = qwenView.webContents.session;
            var handler = function(event, item, webContents) {
                // 只处理一次
                ses.removeListener('will-download', handler);
                var fileName = item.getFilename() || 'ppt_' + Date.now() + '.pptx';
                var filePath = path.join(saveDir, fileName);
                item.setSavePath(filePath);
                console.log('[Qwen PPT] 下载开始:', fileName, '->', filePath);
                item.on('done', function(event, state) {
                    if (state === 'completed') {
                        console.log('[Qwen PPT] 下载完成:', filePath);
                        resolve({ success: true, path: filePath });
                    } else {
                        console.log('[Qwen PPT] 下载失败:', state);
                        resolve({ success: false, error: 'Download ' + state, path: filePath });
                    }
                });
            };
            ses.on('will-download', handler);
            // 超时保护
            setTimeout(function() {
                ses.removeListener('will-download', handler);
                if (qwenPPTDownloadResolve === resolve) {
                    resolve({ success: false, error: 'Download timeout' });
                }
            }, 120000);
            qwenPPTDownloadResolve = resolve;
        });
    });

    // Qwen 回复复制到剪贴板后读取文本（用于获取完整回复）
    ipcMain.handle('qwen-get-clipboard', async () => {
        try {
            return { success: true, text: clipboard.readText() };
        } catch (e) {
            return { success: false, error: e.message };
        }
    });

    // 切换 Qwen 视图显示/隐藏
    ipcMain.handle('qwen-toggle-view', async () => {
        if (!qwenView) return { success: false, error: 'Qwen view not initialized' };
        qwenVisible = !qwenVisible;
        updateBounds();
        return { success: true, visible: qwenVisible };
    });

    ipcMain.handle('qwen-paste-image', async (event, filePath) => {
        if (!qwenView) return { success: false, error: 'Qwen view not initialized' };
        try {
            const img = nativeImage.createFromPath(filePath);
            if (img.isEmpty()) return { success: false, error: 'Cannot load image: ' + filePath };
            clipboard.writeImage(img);
            await new Promise(r => setTimeout(r, 300));
            qwenView.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'V', modifiers: ['ctrl'] });
            await new Promise(r => setTimeout(r, 50));
            qwenView.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'V', modifiers: ['ctrl'] });
            return { success: true };
        } catch (e) {
            return { success: false, error: e.message };
        }
    });

    ipcMain.handle('qwen-paste-text', async (event, text) => {
        try {
            if (agentViewVisible) {
                // Agent 模式下：视图不可见，sendInputEvent 和 Q.sendMessage 均不可靠
                // 改用 ClipboardEvent paste + 全方位的编辑器查找
                var result = await qwenView.webContents.executeJavaScript(`
                    (function() {
                        try {
                            // 从 Electron 主进程写入的剪贴板中读取文本
                            var input = null;

                            // 1. 按父容器查找（最精准）
                            var containers = document.querySelectorAll(
                                '[class*="chat-input"], [class*="input-area"], [class*="composer"], [class*="conversation-input"], [class*="message-input"]'
                            );
                            for (var ci = 0; ci < containers.length; ci++) {
                                var ce = containers[ci].querySelector('[contenteditable="true"]');
                                if (ce && ce.offsetParent !== null) { input = ce; break; }
                            }

                            // 2. 无结果：不依赖可见性，取最后一个 data-slate-editor
                            if (!input) {
                                var allSlate = document.querySelectorAll('[contenteditable="true"][data-slate-editor="true"]');
                                if (allSlate.length > 0) input = allSlate[allSlate.length - 1];
                            }

                            // 3. 无结果：按位置(页面底部)找 contenteditable
                            if (!input) {
                                var allEditors = document.querySelectorAll('[contenteditable="true"]');
                                var best = null;
                                for (var i = allEditors.length - 1; i >= 0; i--) {
                                    var r = allEditors[i].getBoundingClientRect();
                                    if (r.width > 5 && r.height > 5) { best = allEditors[i]; break; }
                                }
                                if (!best && allEditors.length > 0) best = allEditors[allEditors.length - 1];
                                input = best;
                            }

                            // 4. 终极兜底：任何 input/textarea
                            if (!input) {
                                var inputs = document.querySelectorAll('textarea:not([disabled]):not([readonly]), input:not([disabled]):not([readonly])');
                                for (var i = 0; i < inputs.length; i++) {
                                    var r = inputs[i].getBoundingClientRect();
                                    if (r.width > 20 && r.height > 10) { input = inputs[i]; break; }
                                }
                                if (!input && inputs.length > 0) input = inputs[0];
                            }

                            if (!input) return { success: false, error: 'no editable element found' };

                            // 聚焦
                            input.focus();
                            input.click();

                            // 清除已有内容（仅对 contenteditable）
                            if (input.isContentEditable) {
                                var sel = window.getSelection();
                                var range = document.createRange();
                                range.selectNodeContents(input);
                                range.deleteContents();
                                sel.removeAllRanges();
                                sel.addRange(range);
                            } else if (input.tagName === 'TEXTAREA' || input.tagName === 'INPUT') {
                                var nativeSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value');
                                if (nativeSetter && nativeSetter.set) {
                                    nativeSetter.set.call(input, '');
                                } else {
                                    input.value = '';
                                }
                            }

                            // 插入文本：优先 ClipboardEvent paste（Slate.js 原生支持）
                            var dt = new DataTransfer();
                            dt.setData('text/plain', ${JSON.stringify(text)});
                            input.dispatchEvent(new ClipboardEvent('paste', {
                                clipboardData: dt, bubbles: true, cancelable: true
                            }));

                            // 再补一个 insertText execCommand（旧框架兼容）
                            document.execCommand('insertText', false, ${JSON.stringify(text)});
                            input.dispatchEvent(new Event('input', { bubbles: true }));

                            return { success: true };
                        } catch(e) { return { success: false, error: e.message }; }
                    })()
                `);
                return result;
            }
            clipboard.writeText(text || '');
            await new Promise(r => setTimeout(r, 300));
            qwenView.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'V', modifiers: ['ctrl'] });
            await new Promise(r => setTimeout(r, 50));
            qwenView.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'V', modifiers: ['ctrl'] });
            return { success: true };
        } catch (e) {
            return { success: false, error: e.message };
        }
    });

    ipcMain.handle('qwen-is-visible', async () => {
        return { visible: qwenVisible };
    });

    // 显示 Qwen 视图（用于自动化工具自动切换）
    ipcMain.handle('qwen-show-view', async () => {
        if (!qwenView) return { success: false, error: 'Qwen view not initialized' };
        qwenVisible = true;
        if (currentView === 'follow') {
            // 跟随模式：必须隐藏 Agent 视图才能让 Qwen 实际可见
            agentViewVisible = false;
            updateBounds();
            setTimeout(() => {
                if (qwenView) qwenView.webContents.focus();
            }, 200);
        } else {
            // 非跟随模式：只标记为可见但保持当前视图不变
            updateBounds();
        }
        return { success: true };
    });

    // 隐藏 Qwen 视图
    ipcMain.handle('qwen-hide-view', async () => {
        if (!qwenView) return { success: false, error: 'Qwen view not initialized' };
        qwenVisible = false;
        if (currentView === 'follow') {
            // 跟随模式：隐藏 Qwen 后回到 Agent
            agentViewVisible = true;
            updateBounds();
            setTimeout(() => {
                if (agentView) agentView.webContents.focus();
            }, 200);
        } else {
            updateBounds();
        }
        return { success: true };
    });

    // Agent 模式下：deepseek 端发送 qwen 进度，转发给 agentView
    ipcMain.on('qwen-progress', (event, msg) => {
        console.log('[Qwen Progress]', msg);
        if (agentView && agentView.webContents && !agentView.webContents.isDestroyed()) {
            agentView.webContents.send('qwen-progress', msg);
        }
    });

    // 在 Qwen 页面发送真实鼠标点击事件（用于复制按钮等需用户手势的交互）
    ipcMain.handle('qwen-click-at', async (event, x, y) => {
        if (!qwenView || qwenView.webContents.isDestroyed()) return { success: false, error: 'Qwen view not ready' };
        try {
            // 必须先聚焦 Qwen 视图，navigator.clipboard.writeText 要求页面有焦点（user activation）
            qwenView.webContents.focus();
            await new Promise(r => setTimeout(r, 50));
            qwenView.webContents.sendInputEvent({ type: 'mouseDown', x: x, y: y, button: 'left', clickCount: 1 });
            await new Promise(r => setTimeout(r, 30));
            qwenView.webContents.sendInputEvent({ type: 'mouseUp', x: x, y: y, button: 'left', clickCount: 1 });
            return { success: true };
        } catch (e) {
            return { success: false, error: e.message };
        }
    });

    // ==================== MCP IPC 处理器 ====================
    ipcMain.handle('mcp-init', async (event, force) => {
        return await agent.initMcp(force);
    });

    ipcMain.handle('mcp-get-tools', async () => {
        return agent.getMcpTools();
    });

    ipcMain.handle('mcp-call-tool', async (event, serverName, toolName, args) => {
        return await agent.callMcpTool(serverName, toolName, args);
    });

    // MCP 工具启用/禁用管理
    ipcMain.handle('mcp-get-tool-states', async () => {
        return agent.getMcpToolStates();
    });

    ipcMain.handle('mcp-set-tool-enabled', async (event, serverName, toolName, enabled) => {
        return agent.setMcpToolEnabled(serverName, toolName, enabled);
    });

    ipcMain.handle('mcp-shutdown', async () => {
        return await agent.shutdownMcp();
    });

    // MCP Resources protocol
    ipcMain.handle('mcp-get-resources', async () => {
        return agent.getMcpResources();
    });
    ipcMain.handle('mcp-read-resource', async (event, serverName, uri) => {
        return await agent.callMcpResource(serverName, uri);
    });

    // MCP Prompts protocol
    ipcMain.handle('mcp-get-prompts', async () => {
        return agent.getMcpPrompts();
    });
    ipcMain.handle('mcp-get-prompt', async (event, serverName, name, args) => {
        return await agent.callMcpPrompt(serverName, name, args);
    });

    // ==================== 文件历史 Undo IPC（P1） ====================
    const fileHistory = require('./file-history.js');
    ipcMain.handle('file-history-undo', async (event, filePath, sessionId) => {
        return fileHistory.undoLast(filePath, sessionId);
    });
    ipcMain.handle('file-history-versions', async (event, filePath, sessionId) => {
        return { success: true, versions: fileHistory.listVersions(filePath, sessionId) };
    });
    ipcMain.handle('file-history-restore', async (event, filePath, version, sessionId) => {
        return fileHistory.restoreTo(filePath, version, sessionId);
    });
    // 单次文件备份（供 inject 层调用）
    ipcMain.handle('file-history-backup', async (event, filePath) => {
        return { success: !!fileHistory.backupBeforeWrite(filePath) };
    });

    // ==================== P0: 编辑后强制语法验证（参考 atomcode auto_fix.rs） ====================
    // 主进程跑磁盘语法检查（node --check / python -m py_compile / tsc --noEmit / json parse）
    // 返回 { success: true, error: '' } 表示无问题；error 非空表示语法错误文本（前 3 行）
    // 抽为独立函数 runSyntaxCheck 供 agent-syntax-check IPC 与 parallel-edit 复用
    function runSyntaxCheck(filePath, ext) {
        return new Promise(function(resolve) {
            if (!filePath || !fs.existsSync(filePath)) return resolve({ success: true, error: '' });
            var lowerExt = (ext || (filePath.split('.').pop() || '')).toLowerCase();
            var { execFile } = require('child_process');
            if (lowerExt === 'json') {
                try {
                    var content = fs.readFileSync(filePath, 'utf-8');
                    JSON.parse(content);
                    return resolve({ success: true, error: '' });
                } catch (e) {
                    return resolve({ success: true, error: filePath + ' is not valid JSON: ' + e.message });
                }
            }
            if (lowerExt === 'js' || lowerExt === 'mjs' || lowerExt === 'cjs') {
                return execFile('node', ['--check', filePath], { timeout: 15000, windowsHide: true }, function(err, stdout, stderr) {
                    if (err) {
                        resolve({ success: true, error: (stderr || err.message || '').split('\n').slice(0, 3).join('\n') });
                    } else { resolve({ success: true, error: '' }); }
                });
            }
            if (lowerExt === 'py') {
                var py = process.platform === 'win32' ? 'python' : 'python3';
                return execFile(py, ['-m', 'py_compile', filePath], { timeout: 30000, windowsHide: true }, function(err, stdout, stderr) {
                    if (err) {
                        resolve({ success: true, error: (stderr || err.message || '').split('\n').slice(0, 3).join('\n') });
                    } else { resolve({ success: true, error: '' }); }
                });
            }
            if (lowerExt === 'ts' || lowerExt === 'tsx' || lowerExt === 'jsx' || lowerExt === 'vue') {
                return execFile('npx', ['--no-install', 'tsc', '--noEmit', '--skipLibCheck', filePath], { timeout: 60000, windowsHide: true }, function(err, stdout, stderr) {
                    if (err) {
                        var msg = (stderr || '') + (stdout || '');
                        if (/not found|ENOENT|command not found|no-install/i.test(msg)) {
                            resolve({ success: true, error: '' });
                        } else {
                            resolve({ success: true, error: msg.split('\n').filter(function(l) { return l.trim(); }).slice(0, 3).join('\n') });
                        }
                    } else { resolve({ success: true, error: '' }); }
                });
            }
            resolve({ success: true, error: '' });
        });
    }

    ipcMain.handle('agent-syntax-check', async (event, filePath, ext) => {
        try { return await runSyntaxCheck(filePath, ext); }
        catch (e) { return { success: true, error: '' }; }
    });

    // 计划管理
    ipcMain.handle('agent-plan-load', async () => {
        return agent.planLoad();
    });

    ipcMain.handle('agent-plan-save', async (event, plan) => {
        var result = agent.planSave(plan);
        // 通知 Agent 视图
        if (agentView && agentView.webContents && !agentView.webContents.isDestroyed() && result.success && result.plan) {
            agentView.webContents.send('agent-plan-update', result.plan);
            // 同步计划到 QQ Bot（若已授权）
            if (botQQ && botQQ.getInstance() && botQQ.getAuthorizedUser()) {
                try {
                    var p = result.plan;
                    var doneCount = (p.steps || []).filter(function(s) { return s.status === 'done'; }).length;
                    var planText = '📋 计划已更新（' + doneCount + '/' + (p.steps || []).length + ' 完成）\n';
                    (p.steps || []).forEach(function(s, i) {
                        var mark = s.status === 'done' ? '✅' : (s.status === 'running' ? '🔄' : '⬜');
                        planText += mark + ' ' + (i + 1) + '. ' + (s.title || s.task || '') + '\n';
                        if (s.result) planText += '   — ' + s.result + '\n';
                    });
                    botQQ.notifyPlanSync(planText);
                } catch (e) {
                    console.warn('[QQBot] 计划同步失败:', e.message);
                }
            }
        }
        return result;
    });

    ipcMain.handle('agent-plan-delete', async () => {
        return agent.planDelete();
    });

    // Agent 状态消息转发到 controlbar（统一任务状态栏）
    ipcMain.on('agent-status-to-controlbar', (event, data) => {
        shellSend('ctrl-agent-status', data);
    });

    }

// ==================== 控制栏 IPC 处理 ====================
function setupControlBarIPC() {
    // 切换自动执行
    ipcMain.on('ctrl-toggle-autoexec', (event, enabled) => {
        if (deepseekView) {
            deepseekView.webContents.executeJavaScript(
                `window.__dsagent_setAutoExec && window.__dsagent_setAutoExec(${enabled});`
            ).catch(() => {});
        }
    });

    // 设置确认模式
    ipcMain.on('ctrl-set-confirm-mode', (event, mode) => {
        // 主进程直接持久化，避免依赖 DeepSeek 页面就绪状态
        try {
            var cfgRes = agent.loadConfig();
            var cfg = cfgRes.config || {};
            cfg.confirmMode = mode;
            agent.saveConfig(cfg);
            console.log('[ConfirmMode] Saved mode:', mode);
        } catch (e) {
            console.warn('[ConfirmMode] Save failed:', e.message);
        }

        // 同步到 DeepSeek 页面（跳过重复保存）
        if (deepseekView) {
            deepseekView.webContents.executeJavaScript(
                `window.__dsagent_setConfirmMode && window.__dsagent_setConfirmMode(${JSON.stringify(mode)}, true);`
            ).catch(() => {});
        }
        // 立即同步到视图选择栏
        shellSend('ctrl-viewbar-status', {
                currentView: currentView,
                dsState: 'idle',
                qwenState: 'idle',
                confirmMode: mode,
                theme: currentAppTheme
            });
    });

    // 显示说明
    ipcMain.on('ctrl-show-intro', () => {
        if (deepseekView) {
            deepseekView.webContents.executeJavaScript(
                'window.__dsagent_showIntro && window.__dsagent_showIntro();'
            ).catch(() => {});
        }
    });

    // 填入输入框
    ipcMain.on('ctrl-fill-input', (event, text) => {
        if (deepseekView) {
            deepseekView.webContents.executeJavaScript(
                `window.__dsagent_fillInput && window.__dsagent_fillInput(${JSON.stringify(text)});`
            ).catch(() => {});
        }
    });

    // 加载技能列表（供 agent 视图弹窗使用）
    ipcMain.on('ctrl-show-skills', (event) => {
        // 确保 Agent 视图可见
        if (!agentViewVisible) {
            agentViewVisible = true;
            qwenVisible = false;
            updateBounds();
            shellSend('ctrl-agent-state', agentViewVisible);
        }
        var result = agent.loadSkills();
        syncSkillsCount();
        if (agentView && agentView.webContents && !agentView.webContents.isDestroyed()) {
            agentView.webContents.send('agent-show-skills', result.skills || []);
            agentView.webContents.send('agent-open-skills-modal');
        }
    });

    // 显示工具箱弹窗
    ipcMain.on('ctrl-open-toolbox', () => {
        if (agentView && agentView.webContents && !agentView.webContents.isDestroyed()) {
            agentView.webContents.send('agent-message', { _toolbarModal: 'toolbox' });
        }
    });

    // 显示记忆管理弹窗
    ipcMain.on('ctrl-show-memory', () => {
        if (agentView && agentView.webContents && !agentView.webContents.isDestroyed()) {
            agentView.webContents.send('agent-message', { _toolbarModal: 'memory' });
        }
    });

    // 显示 MCP 配置弹窗
    ipcMain.on('ctrl-show-mcp', () => {
        if (agentView && agentView.webContents && !agentView.webContents.isDestroyed()) {
            agentView.webContents.send('agent-message', { _toolbarModal: 'mcp' });
        }
    });


    // 显示后台任务弹窗
    ipcMain.on('ctrl-show-tasks', () => {
        if (agentView && agentView.webContents && !agentView.webContents.isDestroyed()) {
            agentView.webContents.send('agent-message', { _toolbarModal: 'tasks' });
        }
    });

    // 显示 MCP 工具管理弹窗
    ipcMain.on('ctrl-show-mcp-tools', async () => {
        if (agentView && agentView.webContents && !agentView.webContents.isDestroyed()) {
            var toolsRes = agent.getMcpTools();
            var statesRes = agent.getMcpToolStates();
            agentView.webContents.send('agent-show-mcp-tools', {
                tools: toolsRes.tools || [],
                states: statesRes.states || {}
            });
        }
    });

    // 删除技能
    ipcMain.on('ctrl-delete-skill', (event, skillName) => {
        var result = agent.deleteSkill(skillName);
        syncSkillsCount();
        shellSend('ctrl-notify', result.success ? '已删除技能: ' + skillName : result.error);
    });

    // 从文件夹导入技能（标准 SKILL.md 格式）
    ipcMain.on('ctrl-import-skills', async (event) => {
        var result = await dialog.showOpenDialog(mainWindow, {
            title: '选择技能文件夹（包含 SKILL.md 的文件夹）',
            properties: ['openDirectory']
        });
        if (result.canceled || result.filePaths.length === 0) return;
        try {
            var importResult = agent.importSkill(result.filePaths[0]);
            if (importResult.success) {
                shellSend('ctrl-notify', '已导入技能: ' + importResult.name);
            } else {
                shellSend('ctrl-notify', '导入失败: ' + importResult.error);
            }
            syncSkillsCount();
        } catch (err) {
            shellSend('ctrl-notify', '导入失败: ' + err.message);
        }
    });

    // 主题切换（从左侧栏触发，广播到所有视图）
    ipcMain.on('ctrl-set-theme', (event, theme) => {
        broadcastTheme(THEME_PRESETS.hasOwnProperty(theme) ? theme : 'dark');
    });

    // 调试日志输出到主进程控制台
    ipcMain.on('ctrl-debug-log', (event, msg) => {
        console.log('[WinAPI 调试]');
        console.log(msg);
    });

    // Qwen 面板切换
    ipcMain.on('ctrl-toggle-qwen', () => {
        qwenVisible = !qwenVisible;
        currentView = qwenVisible ? 'qwen' : 'deepseek';
        updateBounds();
        if (!agentViewVisible) {
            setTimeout(() => {
                if (qwenView && qwenVisible) qwenView.webContents.focus();
                else if (deepseekView) deepseekView.webContents.focus();
            }, 200);
        }
        shellSend('ctrl-qwen-state', qwenVisible);
    });

    // 视图选择器（替换旧的 Qwen/Agent 按钮）
    ipcMain.on('ctrl-view-select', (event, view) => {
        currentView = view;
        switch (view) {
            case 'deepseek':
                agentViewVisible = false;
                qwenVisible = false;
                break;
            case 'qwen':
                agentViewVisible = false;
                qwenVisible = true;
                break;
            case 'agent':
                agentViewVisible = true;
                qwenVisible = false;
                // 检测 Agent 白屏：尝试 ping，失败则 reload
                if (agentView && !agentView.webContents.isDestroyed()) {
                    agentView.webContents.executeJavaScript('document.body && document.body.innerHTML.length > 0').then(ok => {
                        if (!ok) {
                            console.warn('[Agent] White screen detected, reloading...');
                            agentView.webContents.reload();
                        }
                    }).catch(() => {
                        console.warn('[Agent] Agent unresponsive, reloading...');
                        agentView.webContents.reload();
                    });
                }
                break;
            case 'follow':
                // 跟随模式：保持当前状态，由定时器自动切换
                break;
        }
        saveAppState({ lastMode: agentViewVisible ? 'agent' : 'deepseek' });
        updateBounds();
        setTimeout(() => {
            if (view === 'qwen' && qwenView) qwenView.webContents.focus();
            else if (view === 'agent' && agentView) agentView.webContents.focus();
            else if (deepseekView) deepseekView.webContents.focus();
        }, 200);
    });

    // 停止按钮（通用停止：停止输出 + 停止命令 + 停止切换）
    ipcMain.on('ctrl-stop', async () => {
        await stopAll();
        shellSend('ctrl-notify', '已停止');
    });

    // Agent 视图焦点恢复（删除对话后确保输入框可用）
    ipcMain.on('agent-focus-input', () => {
        if (agentView && !agentView.webContents.isDestroyed()) {
            try { mainWindow.setTopBrowserView(agentView); } catch(e) {}
            agentView.webContents.focus();
        }
    });

    // 将 DeepSeek 页面/Agent 的状态通知显示到控制栏
    ipcMain.on('agent-notify-status', (event, msg) => {
        shellSend('ctrl-notify', msg);
    });

    // P0: 工具文档缓存（注入侧 allDocs 上传，prompt-builder 读取）
    // 解决 AI 频繁调工具缺必填参数：启动时把工具 schema 注入 prompt
    global.__toolDocsCache = '';
    ipcMain.on('tool-docs-cache', (event, docs) => {
        global.__toolDocsCache = docs || '';
        console.log('[ToolDocs] cached ' + (docs ? docs.length : 0) + ' chars');
    });

    // Qwen 页面状态消息转发到 controlbar
    ipcMain.on('qwen-notify-status', (event, msg) => {
        shellSend('ctrl-agent-status', { msg: msg, type: 'qwen' });
    });

    // Agent 视图切换
    ipcMain.on('agent-view-toggle', () => {
        agentViewVisible = !agentViewVisible;
        saveAppState({ lastMode: agentViewVisible ? 'agent' : 'deepseek' });
        updateBounds();
        // 通知控制栏状态
        shellSend('ctrl-agent-state', agentViewVisible);
    });

    // 通过 Qwen BrowserView 下载远程图片并返回 data URL（绕过 CORS）
    // 图片不写入磁盘，直接返回 base64 data URL 供内联显示
    async function downloadQwenImageAsDataUrl(imageUrl) {
        if (!qwenView || !qwenView.webContents || qwenView.webContents.isDestroyed()) {
            return null;
        }
        try {
            var result = await qwenView.webContents.executeJavaScript(`
                (async function() {
                    try {
                        var resp = await fetch(${JSON.stringify(imageUrl)});
                        var blob = await resp.blob();
                        return new Promise(function(res) {
                            var reader = new FileReader();
                            reader.onloadend = function() { res(reader.result); };
                            reader.readAsDataURL(blob);
                        });
                    } catch(e) { return null; }
                })()
            `);
            return (result && typeof result === 'string' && result.indexOf('base64,') !== -1) ? result : null;
        } catch (e) {
            console.warn('[downloadQwenImage] fetch error:', e.message);
            return null;
        }
    }

    // 非 DeepSeek provider（Qwen/API）发送后轮询等待生成完成，提取结果并推送 agentview
    // DeepSeek 由 inject 层主动轮询推送，无需此函数
    async function pollAndForwardResult(modelId, provider) {
        try {
            // 1. 等待生成完成（90s 上限，避免长时间空等）
            var doneRes = await modelRegistry.invoke(modelId, 'waitForDone', { timeout: 90000 });
            console.log('[pollAndForward] waitForDone:', JSON.stringify(doneRes));
            var done = !!(doneRes && doneRes.data && doneRes.data.done);
            var hasImages = !!(doneRes && doneRes.data && doneRes.data.hasImages);
            if (!done && !hasImages) console.warn('[pollAndForward] waitForDone 超时，仍尝试提取（AI 可能已答完）');

            var markdown = '';
            var images = [];
            var think = '';
            var source = '';

            if (hasImages) {
                // 图片管道：等待图片生成完成 → 提取文字+图片URL
                console.log('[pollAndForward] 检测到图片回复，走图片管道');
                var imgWaitRes = await modelRegistry.invoke(modelId, 'waitForImageDone', { timeout: 300000 });
                if (!imgWaitRes || !imgWaitRes.success) {
                    if (agentView && agentView.webContents && !agentView.webContents.isDestroyed()) {
                        agentView.webContents.send('agent-message', { type: 'error', error: '图片生成等待失败：' + ((imgWaitRes && imgWaitRes.error) || '') });
                    }
                    return;
                }
                var imgExtractRes = await modelRegistry.invoke(modelId, 'extractImageResponse', {});
                console.log('[pollAndForward] extractImageResponse:', JSON.stringify(imgExtractRes).substring(0, 300));
                if (!imgExtractRes || !imgExtractRes.success) {
                    if (agentView && agentView.webContents && !agentView.webContents.isDestroyed()) {
                        agentView.webContents.send('agent-message', { type: 'error', error: '图片回复提取失败' });
                    }
                    return;
                }
                var imgData = imgExtractRes.data || {};
                markdown = imgData.markdown || '';
                images = imgData.images || [];
                source = 'image-pipeline';

                // 下载图片为 dataUrl（通过 qwenView fetch 绕过 CORS）
                if (images.length > 0) {
                    console.log('[pollAndForward] 下载 ' + images.length + ' 张图片...');
                    var downloadedImages = [];
                    for (var di = 0; di < images.length; di++) {
                        var dataUrl = await downloadQwenImageAsDataUrl(images[di]);
                        if (dataUrl) {
                            downloadedImages.push(dataUrl);
                        } else {
                            downloadedImages.push(images[di]); // fallback 原始 URL
                        }
                    }
                    images = downloadedImages;
                }
            } else {
                // 2. 提取 AI 回复（文字管道）
                var extractRes = await modelRegistry.invoke(modelId, 'extractResponse', {});
                console.log('[pollAndForward] extractResponse:', JSON.stringify(extractRes).substring(0, 200));
                if (!extractRes || !extractRes.success) {
                    if (agentView && agentView.webContents && !agentView.webContents.isDestroyed()) {
                        agentView.webContents.send('agent-message', { type: 'error', error: '提取回复失败：' + (extractRes && extractRes.error || '未知') });
                    }
                    return;
                }
                var data = extractRes.data || {};
                markdown = data.markdown || '';
                images = data.images || [];
                source = data.source || '';
            }

            if (!markdown && images.length === 0) {
                if (agentView && agentView.webContents && !agentView.webContents.isDestroyed()) {
                    agentView.webContents.send('agent-message', { type: 'error', error: 'AI 回复为空' });
                }
                return;
            }
            // 3a. Subagent 检测与执行（Qwen/API 的回复中可能出现 subagent 标签）
            // 复用 orchestrator 路径：executeFromResponse → handleSubagentRequest → handleRequest
            var subagentResults = [];
            if (subagentManager && (markdown.indexOf('<subagent:invoke') >= 0 || markdown.indexOf('"subagent"') >= 0)) {
                console.log('[pollAndForward] 检测到 subagent 标签，开始执行...');
                try {
                    subagentResults = await subagentManager.executeFromResponse(markdown, 'qwen-subagent-' + Date.now(), 0);
                    if (subagentResults.length > 0) {
                        // 构建 subagent 结果反馈文本（共享 response-processor）
                        var feedbackText = responseProcessor.buildSubagentFeedback(subagentResults);
                        // 发送回 AI 继续生成
                        var feedRes = await modelRegistry.invoke(modelId, 'sendMessage', { text: feedbackText, timeout: 120000 });
                        if (feedRes.success) {
                            var feedWaitRes = await modelRegistry.invoke(modelId, 'waitForDone', { timeout: 120000 });
                            if (feedWaitRes && feedWaitRes.success) {
                                var reExtractRes = await modelRegistry.invoke(modelId, 'extractResponse', {});
                                if (reExtractRes && reExtractRes.success) {
                                    var reData = reExtractRes.data || {};
                                    if (reData.markdown) markdown = reData.markdown;
                                    if (reData.think) think = reData.think;
                                }
                            }
                        }
                    }
                } catch (subE) {
                    console.warn('[pollAndForward] subagent execution failed:', subE.message);
                }
            }

            // Hook: afterExtractResponse（P1：可验证/修改提取的回复）
            try {
                var hookModified = await hookEngine.fireAfterExtractResponse(markdown, markdown);
                if (hookModified && hookModified !== markdown) {
                    markdown = hookModified;
                }
            } catch(e) { console.warn('[Hook] afterExtractResponse error:', e.message); }

            // 3b. 组装 segments（共享 response-processor，消除与 orchestrator 的重复实现）
            var segResult = responseProcessor.buildSegmentsFromMarkdown(markdown, {
                think: think, images: images, subagentResults: subagentResults
            });
            var segments = segResult.segments;

            if (agentView && agentView.webContents && !agentView.webContents.isDestroyed()) {
                agentView.webContents.send('agent-message', {
                    type: 'response',
                    segments: segments
                });
                // 通知任务链结束
                agentView.webContents.send('agent-message', { type: 'tasks-end', stopped: false });
            }
        } catch (e) {
            console.error('[pollAndForward] error:', e.message);
            if (agentView && agentView.webContents && !agentView.webContents.isDestroyed()) {
                agentView.webContents.send('agent-message', { type: 'error', error: '轮询提取失败：' + e.message });
            }
        }
    }

    // Agent 发送消息：按 modelId 路由到对应 server（DeepSeek/Qwen/API）
    // 由 agentview 决定是否新建对话（data.createNew），main.js 不检查页面 URL
    ipcMain.handle('agent-send-message', async (event, data) => {
        try {
            // 解析目标 modelId：优先用 data.modelId，否则按 data.mode 推断旧 DeepSeek modelId
            var targetModelId = data.modelId;
            if (!targetModelId) {
                var legacyMap = { expert: 'deepseek.expert', fast: 'deepseek.fast', image: 'deepseek.image' };
                targetModelId = legacyMap[data.mode] || 'deepseek.fast';
            }
            if (!modelRegistry) return { success: false, error: 'Registry not ready' };
            var modelInfo = modelRegistry.getModel(targetModelId);
            if (!modelInfo) return { success: false, error: 'Model not found: ' + targetModelId };

            // Hook: beforeSendMessage（P1：可修改/阻止消息）
            try {
                var hookResult = await hookEngine.fireBeforeSendMessage(data.text, targetModelId);
                if (hookResult.blocked) {
                    return { success: false, error: hookResult.reason || '消息被 Hook 阻止' };
                }
                if (hookResult.modifiedText) {
                    data.text = hookResult.modifiedText;
                }
            } catch(e) { console.warn('[Hook] beforeSendMessage error:', e.message); }

            // 统一走 orchestrator.handleRequest（消除与 CLI 路径的重复实现）
            // agentview 用异步模式：waitForComplete=false，发送后立即返回，
            // AI 回复靠 inject 层 agentForwardResult 异步推送（DeepSeek）或 pollAndForwardResult（Qwen/API）
            if (orchestrator) {
                var orchPayload = {
                    agentId: 'agentview-' + (data.conversationId || Date.now()),
                    message: { text: data.text || '' },
                    files: data.files || [],
                    images: data.images || [],
                    deepThink: !!data.deepthink,
                    forceNew: !!data.createNew,
                    timeout: 180000,
                    waitForComplete: false,  // 异步模式：不阻塞等工具循环
                    _skipToolLoopWait: true   // 跳过 orchestrator 的工具循环等待（agentview 靠 inject 推送）
                };
                if (targetModelId) {
                    orchPayload.clusterConfig = {
                        templateId: 'minimal',
                        roles: { main: { modelId: targetModelId } },
                        subagentDefaults: { modelId: targetModelId }
                    };
                }
                var orchResult = await orchestrator.handleRequest(orchPayload);
                // 转换返回格式：orchestrator 返回 {success, data:{markdown, conversationUrl}}
                // agentview 期望 {success, deepseekUrl, conversationUrl}
                if (!orchResult.success) return orchResult;
                var convUrl = (orchResult.data && orchResult.data.conversationUrl) || '';
                return { success: true, deepseekUrl: convUrl, conversationUrl: convUrl };
            }

            // Fallback：orchestrator 未就绪时走旧逻辑（理论上不会触发）
            console.warn('[agent-send-message] orchestrator not ready, fallback to legacy path');
            if (data.createNew) {
                var newRes = await modelRegistry.invoke(targetModelId, 'newChat', {
                    deepThink: !!data.deepthink,
                    userText: data.text || ''
                });
                if (!newRes.success) return newRes;
                var convUrl2 = newRes.data && newRes.data.conversationUrl || '';
                if (modelInfo.provider !== 'deepseek' && data.text) {
                    pollAndForwardResult(targetModelId, modelInfo.provider);
                }
                return { success: true, deepseekUrl: convUrl2, conversationUrl: convUrl2 };
            } else {
                if (modelInfo.provider === 'deepseek') {
                    await modelRegistry.invoke(targetModelId, 'switchModel', {});
                    await modelRegistry.invoke(targetModelId, 'setDeepThink', { enable: !!data.deepthink });
                    await modelRegistry.invoke(targetModelId, 'setWebSearch', { enable: false });
                }
                await new Promise(r => setTimeout(r, 500));
                var sendRes2 = await modelRegistry.invoke(targetModelId, 'sendMessage', { text: data.text });
                if (!sendRes2.success) return sendRes2;
                if (modelInfo.provider !== 'deepseek') {
                    pollAndForwardResult(targetModelId, modelInfo.provider);
                }
                return { success: true };
            }
        } catch (e) {
            return { success: false, error: e.message };
        }
    });

    // Agent 设置深度思考（按当前模型 provider 决定是否生效）
    ipcMain.handle('agent-toggle-deepthink', async (event, enabled) => {
        try {
            if (!modelRegistry) return { success: false };
            // DeepSeek 网页版才支持深度思考同步
            await modelRegistry.invoke('deepseek.fast', 'setDeepThink', { enable: !!enabled });
            return { success: true };
        } catch (e) {
            return { success: false, error: e.message };
        }
    });

    // Agent 停止生成
    ipcMain.handle('agent-stop', async () => {
        await stopAll();
        return { success: true };
    });

    // Agent 启动新对话：按 modelId 路由新建对话并发送初始化提示词
    ipcMain.handle('agent-start-new-chat', async (event, data) => {
        try {
            var targetModelId2 = data.modelId;
            if (!targetModelId2) {
                var legacyMap2 = { expert: 'deepseek.expert', fast: 'deepseek.fast', image: 'deepseek.image' };
                targetModelId2 = legacyMap2[data.mode] || 'deepseek.fast';
            }
            if (!modelRegistry) return { success: false, error: 'Registry not ready' };
            // 把初始化提示词 userText 合并进 newChat 一次发送，避免 newChat+sendMessage 连发
            var newRes2 = await modelRegistry.invoke(targetModelId2, 'newChat', {
                deepThink: !!data.deepthink,
                userText: data.userText || ''
            });
            if (!newRes2.success) return newRes2;
            var convUrl2 = newRes2.data && newRes2.data.conversationUrl || '';
            return { success: true, deepseekUrl: convUrl2, conversationUrl: convUrl2 };
        } catch (e) {
            return { success: false, error: e.message };
        }
    });

    // Agent 获取当前 DeepSeek 页面 URL
    ipcMain.handle('agent-get-deepseek-url', async () => {
        if (!deepseekView) return { success: false, error: 'DeepSeek view not ready' };
        try {
            const url = await deepseekView.webContents.executeJavaScript('window.location.href');
            return { success: true, url: url };
        } catch (e) {
            return { success: false, error: e.message };
        }
    });

    // 获取模型列表
    ipcMain.handle('agent-get-models', () => {
        return { success: true, models: Object.keys(MODELS).map(function(k) { return { id: k, name: MODELS[k].name, url: MODELS[k].url, mode: MODELS[k].mode }; }) };
    });

    // 切换到指定模型的 URL
    ipcMain.handle('agent-navigate-model', async (event, modelId) => {
        if (!deepseekView) return { success: false, error: 'DeepSeek view not ready' };
        var model = MODELS[modelId];
        if (!model) return { success: false, error: 'Unknown model: ' + modelId };
        try {
            try { mainWindow.removeBrowserView(deepseekView); } catch(e) {}
            deepseekView.webContents.loadURL(model.url);
            await new Promise(function(r) { setTimeout(r, 3000); });
            try { mainWindow.addBrowserView(deepseekView); } catch(e) {}
            var ob = deepseekView.getBounds();
            if (ob.x > -1000) deepseekView.setBounds({ x: -10000, y: ob.y, width: ob.width, height: ob.height });
            if (agentView && agentViewVisible && !agentView.webContents.isDestroyed()) {
                mainWindow.setTopBrowserView(agentView);
            }
            return { success: true, url: model.url };
        } catch (e) {
            return { success: false, error: e.message };
        }
    });

    // 获取 DeepSeek 页面对话历史用于迁移
    ipcMain.handle('agent-get-conversation-history', async () => {
        if (!deepseekView) return { success: false, error: 'DeepSeek view not ready' };
        try {
            var history = await deepseekView.webContents.executeJavaScript(
                'window.__dsagent_getConversationHistory && window.__dsagent_getConversationHistory()'
            );
            return { success: true, history: history || [] };
        } catch (e) {
            return { success: false, error: e.message };
        }
    });

    // 恢复历史对话对应的 DeepSeek 会话（deepseekView 始终活跃，无需视觉切换）
    ipcMain.handle('history-restore-conversation', async (event, deepseekUrl) => {
        if (!deepseekView) return { success: false, error: 'DeepSeek view not ready', valid: false };
        try {
            // 从 URL 中提取会话标识（/chat/ 后面的部分）
            var origMatch = deepseekUrl.match(/\/chat\/([^?#]+)/);
            var origConvId = origMatch ? origMatch[1] : '';

            // 导航前移出窗口，防止 loadURL 触发 Chromium HWND 重绘导致的闪现
            try { mainWindow.removeBrowserView(deepseekView); } catch(e) {}

            // 导航到对话页面
            deepseekView.webContents.loadURL(deepseekUrl);

            // 轮询等待 DeepSeek SPA 对话实际渲染完成（textarea 出现 = 对话就绪）
            var isValid = true;
            var maxWait = 20000;
            var start = Date.now();
            var textareaFound = false;

            while (Date.now() - start < maxWait) {
                await new Promise(function(r) { setTimeout(r, 500); });

                // 检查是否被重定向（对话不存在）
                var currentUrl = deepseekView.webContents.getURL();
                if (origConvId && currentUrl.indexOf('/chat/' + origConvId) === -1) {
                    isValid = false;
                    break;
                }

                // 检查 textarea 是否出现（DeepSeek 对话已渲染）
                try {
                    var hasTextarea = await deepseekView.webContents.executeJavaScript(
                        'document.querySelector("textarea") !== null'
                    );
                    if (hasTextarea) {
                        textareaFound = true;
                        break;
                    }
                } catch(e) {
                    // 页面可能还没加载完，继续等
                }
            }

            // 如果找到了 textarea，再等待 inject.js 完全初始化完毕
            if (textareaFound && isValid) {
                var injectStart = Date.now();
                while (Date.now() - injectStart < 10000) {
                    try {
                        var injected = await deepseekView.webContents.executeJavaScript(
                            'window.__dsagent_injected === true && typeof window.__dsagent_sendMessage === "function"'
                        );
                        if (injected) break;
                    } catch(e) {}
                    await new Promise(function(r) { setTimeout(r, 200); });
                }
            }

            // 导航完毕，将 deepseekView 重新加入窗口并移回屏幕外（x: -10000）
            // 同时确保 agentView 保持在 z-order 最顶层
            try {
                mainWindow.addBrowserView(deepseekView);
                var ob = deepseekView.getBounds();
                if (ob.x > -1000) {
                    deepseekView.setBounds({ x: -10000, y: ob.y, width: ob.width, height: ob.height });
                }
                // 恢复 agentView 在 z-order 顶层
                if (agentView && agentViewVisible && !agentView.webContents.isDestroyed()) {
                    mainWindow.setTopBrowserView(agentView);
                }
            } catch(e) {}

            return { success: true, valid: isValid };
        } catch (e) {
            // 如果异常发生，确保仍然把 view 加回来
            try {
                if (deepseekView && deepseekView.webContents && !deepseekView.webContents.isDestroyed()) {
                    var added = false;
                    var views = mainWindow.getBrowserViews();
                    for (var _vi = 0; _vi < views.length; _vi++) { if (views[_vi] === deepseekView) { added = true; break; } }
                    if (!added) {
                        mainWindow.addBrowserView(deepseekView);
                        deepseekView.setBounds({ x: -10000, y: 0, width: 1280, height: 720 });
                    }
                }
            } catch(_ee) {}
            return { success: false, error: e.message, valid: false };
        }
    });

    // Agent 获取根目录
    ipcMain.handle('agent-get-root-dir', () => {
        return currentRootDir || '';
    });

    // 频率限制/服务器繁忙通知：deepseekView → agentView DOM 弹窗
    ipcMain.handle('agent-rate-limit-notify', async (event, waitSeconds, errorType) => {
        return new Promise((resolve) => {
            var messageId = 'ratelimit-' + Date.now() + '-' + Math.random().toString(36).substr(2, 6);
            var timeout = setTimeout(() => resolve(false), 120000);

            if (!agentView || !agentView.webContents || agentView.webContents.isDestroyed()) {
                return resolve(false);
            }

            agentView.webContents.send('agent-show-ratelimit', { waitSeconds: waitSeconds, errorType: errorType, _messageId: messageId });

            var handler = (event, response) => {
                if (response._messageId === messageId) {
                    clearTimeout(timeout);
                    ipcMain.removeListener('agent-ratelimit-response', handler);
                    resolve(!!response.confirmed);
                }
            };
            ipcMain.on('agent-ratelimit-response', handler);
        });
    });

    // ==================== Robot 配置管理 ====================

    // 保存大文本到临时文件（粘贴 >5KB 内容时自动保存）
    ipcMain.handle('save-large-text', async (event, text) => {
        try {
            var tempDir = path.join(currentRootDir || app.getPath('userData'), '.dsa', 'temp');
            if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });
            var filename = 'pasted_text_' + Date.now() + '.txt';
            var filePath = path.join(tempDir, filename);
            fs.writeFileSync(filePath, text, 'utf-8');
            return { success: true, path: filePath };
        } catch (e) {
            return { success: false, error: e.message };
        }
    });


    // Agent 获取/设置 readTools
    ipcMain.handle('agent-get-read-tools', async () => {
        if (deepseekView && deepseekView.webContents && !deepseekView.webContents.isDestroyed()) {
            try {
                return await deepseekView.webContents.executeJavaScript(
                    'window.__dsagent_tools ? window.__dsagent_tools.getReadHistory() : []'
                );
            } catch(e) { return []; }
        }
        return [];
    });
    ipcMain.handle('agent-set-read-tools', async (event, arr) => {
        if (deepseekView && deepseekView.webContents && !deepseekView.webContents.isDestroyed()) {
            // 重试最多 15 秒等 inject.js 就绪
            var deadline = Date.now() + 15000;
            while (Date.now() < deadline) {
                try {
                    var ok = await deepseekView.webContents.executeJavaScript(
                        '(function() { if (window.__dsagent_tools) { window.__dsagent_tools.setReadHistory(' + JSON.stringify(arr) + '); return true; } return false; })()'
                    );
                    if (ok) return true;
                } catch(e) {}
                await new Promise(function(r) { setTimeout(r, 500); });
            }
            return false;
        }
        return false;
    });

    // Agent 删除 Qwen 原始对话（同步删除历史时使用）
    ipcMain.handle('agent-delete-qwen-conversation', async (event, qwenUrl) => {
        if (!modelRegistry) return { success: false, error: 'Registry not ready' };
        try {
            // 查找第一个可用的 Qwen 模型
            var allModels = modelRegistry.listModels ? modelRegistry.listModels() : [];
            var qwenModelId = null;
            for (var qi = 0; qi < allModels.length; qi++) {
                if (allModels[qi].id && allModels[qi].id.indexOf('qwen') !== -1) {
                    qwenModelId = allModels[qi].id;
                    break;
                }
            }
            if (!qwenModelId) return { success: false, error: 'No Qwen model found' };
            var result = await modelRegistry.invoke(qwenModelId, 'deleteConversation', {});
            // 恢复 agentView 焦点
            if (agentView && !agentView.webContents.isDestroyed()) {
                try { mainWindow.setTopBrowserView(agentView); } catch(efocus) {}
                agentView.webContents.focus();
            }
            return result || { success: false, error: 'Delete returned no result' };
        } catch (e) {
            return { success: false, error: e.message };
        }
    });

    // Agent 删除 DeepSeek 原始对话（同步删除历史时使用）
    ipcMain.handle('agent-delete-deepseek-conversation', async (event, deepseekUrl) => {
        if (!deepseekView) return { success: false, error: 'DeepSeek view not ready' };
        try {
            // 从 URL 中提取对话 ID
            var convId = '';
            var idMatch = deepseekUrl.match(/\/chat\/([^?#]+)/);
            if (idMatch) convId = idMatch[1];

            // 不导航，直接从当前页面侧边栏按 convId 匹配删除
            // 等待 __dsagent_deleteConversation 可用
            var start = Date.now();
            var ready = false;
            while (Date.now() - start < 15000) {
                await new Promise(function(r) { setTimeout(r, 500); });
                try {
                    var hasFn = await deepseekView.webContents.executeJavaScript(
                        'typeof window.__dsagent_deleteConversation === "function"'
                    );
                    if (hasFn) { ready = true; break; }
                } catch(e) {}
            }
            if (!ready) return { success: false, error: 'Inject.js not ready' };

            // 调用删除函数，传入 convId 精确匹配
            var result = await deepseekView.webContents.executeJavaScript(
                'window.__dsagent_deleteConversation(' + JSON.stringify(convId) + ').then(function(r) { return r; })'
            );

            // 恢复 agentView 焦点（setTopBrowserView 确保 OS 级焦点切换）
            if (agentView && !agentView.webContents.isDestroyed()) {
                try { mainWindow.setTopBrowserView(agentView); } catch(efocus) {}
                agentView.webContents.focus();
            }

            return result || { success: false, error: 'Execution returned no result' };
        } catch (e) {
            return { success: false, error: e.message };
        }
    });

    // 危险命令确认：从 inject.js 转发到 Agent 视图
    ipcMain.handle('agent-request-confirm', async (event, data) => {
        var qqBotInstance = botQQ ? botQQ.getInstance() : null;
        var qqBotAuthorizedUser = botQQ ? botQQ.getAuthorizedUser() : null;
        // 如果 QQ Bot 已授权，通过 QQ 按钮询问
        if (qqBotInstance && qqBotAuthorizedUser && agentView && agentView.webContents) {
            var cmdDesc = data.cmdDisplay || data.cmd || data.lang || '未知命令';
            var lang = data.lang || '';
            // 根据操作类型定制提示文案
            var actionLabel = '执行';
            var confirmLabel = '✅ 确认执行';
            if (lang === 'delete') {
                actionLabel = '删除';
                confirmLabel = '✅ 确认删除';
            }
            try {
                await qqBotInstance.sendKeyboard(qqBotAuthorizedUser,
                    '⚠️ 需要确认是否' + actionLabel + '：\n' + cmdDesc + '\n\n（60秒超时）',
                    [
                        { id: 'confirm_yes', label: confirmLabel, data: 'confirm_yes', style: 1 },
                        { id: 'confirm_no', label: '❌ 取消', data: 'confirm_no', style: 0 }
                    ]);

                if (botQQ) botQQ.setAwaitingConfirm(true);
                var qqConfirmed = await new Promise(function(resolve) {
                    var qqTimeout = setTimeout(function() {
                        if (botQQ) botQQ.setAwaitingConfirm(false);
                        qqBotInstance.removeListener('interaction', interactionHandler);
                        qqBotInstance.removeListener('message', msgHandler);
                        resolve(false);
                    }, 60000);
                    var interactionHandler = function(intData) {
                        if (intData.userOpenid !== qqBotAuthorizedUser) return;
                        clearTimeout(qqTimeout);
                        if (botQQ) botQQ.setAwaitingConfirm(false);
                        qqBotInstance.removeListener('interaction', interactionHandler);
                        qqBotInstance.removeListener('message', msgHandler);
                        if (intData.buttonData === 'confirm_yes') {
                            resolve(true);
                        } else {
                            resolve(false);
                        }
                    };
                    var msgHandler = function(msg) {
                        if (msg.openid !== qqBotAuthorizedUser) return;
                        var reply = (msg.content || '').trim().toUpperCase();
                        if (reply === 'Y' || reply === 'YES' || reply === '确认') {
                            clearTimeout(qqTimeout);
                            if (botQQ) botQQ.setAwaitingConfirm(false);
                            qqBotInstance.removeListener('interaction', interactionHandler);
                            qqBotInstance.removeListener('message', msgHandler);
                            resolve(true);
                        } else if (reply === 'N' || reply === 'NO' || reply === '取消') {
                            clearTimeout(qqTimeout);
                            if (botQQ) botQQ.setAwaitingConfirm(false);
                            qqBotInstance.removeListener('interaction', interactionHandler);
                            qqBotInstance.removeListener('message', msgHandler);
                            resolve(false);
                        }
                    };
                    qqBotInstance.on('interaction', interactionHandler);
                    qqBotInstance.on('message', msgHandler);
                });
                if (qqConfirmed) {
                    await qqBotInstance.sendText(qqBotAuthorizedUser, '✅ 已确认执行');
                } else {
                    await qqBotInstance.sendText(qqBotAuthorizedUser, '❌ 已取消执行');
                }
                return { confirmed: qqConfirmed };
            } catch (e) {
                console.error('[QQBot] 确认同步失败:', e.message);
                // fallback: 走 agentView 弹窗
            }
        }
        // 默认走 agentView DOM 弹窗
        if (!agentView || !agentView.webContents || agentView.webContents.isDestroyed()) {
            return { confirmed: false, error: 'Agent view not ready' };
        }
        return new Promise((resolve) => {
            var timeout = setTimeout(() => resolve({ confirmed: false, error: 'timeout' }), 120000);
            var messageId = 'confirm-' + Date.now() + '-' + Math.random().toString(36).substr(2, 6);
            data._messageId = messageId;
            agentView.webContents.send('agent-show-confirm', data);
            var handler = (event, response) => {
                if (response._messageId === messageId) {
                    clearTimeout(timeout);
                    ipcMain.removeListener('agent-confirm-response', handler);
                    resolve({ confirmed: !!response.confirmed });
                }
            };
            ipcMain.on('agent-confirm-response', handler);
        });
    });

    // 从 inject.js 转发解析结果到 Agent 视图
    ipcMain.on('agent-forward-result', (event, data) => {
        // ── 方案 A：CLI 请求等待 inject 推送 ──
        // inject 推送链路：
        //   纯文字:     response(纯文本) → tasks-end(完毕)
        //   有工具调用: response(工具标签) → tool-results → tasks-end(工具完，AI开始第二轮)
        //              → response(最终回复) → tasks-end(全部完成)
        // 分辨策略：检查 collected 中是否有 tool-call/tool-result 段。
        //   有工具段 → 长等待（12s 防第二轮生成慢）
        //   纯文字   → 短等待（1s 防 race）
        if (cliResultWaiters.size > 0) {
            cliResultWaiters.forEach(function(entry, reqId) {
                // 收集 segments
                if (data.type === 'response' || data.type === 'tool-results') {
                    var segs = data.segments || [];
                    for (var si = 0; si < segs.length; si++) entry.collected.push(segs[si]);

                    // ── 流式推送：实时转发 segments 给 CLI ──
                    if (entry.onStream) {
                        for (var si2 = 0; si2 < segs.length; si2++) {
                            var sg = segs[si2];
                            var streamMsg = null;
                            if (sg.type === 'tool-call') {
                                streamMsg = { type: 'tool-call', name: sg.lang || sg.content || 'tool', content: sg.content || '' };
                            } else if (sg.type === 'text') {
                                streamMsg = { type: 'text', content: sg.content || '' };
                            } else if (sg.type === 'tool-result') {
                                streamMsg = { type: 'tool-result', content: sg.content || '' };
                            }
                            if (streamMsg) {
                                try { entry.onStream(streamMsg); } catch(e) { /* connection closed */ }
                            }
                        }
                    }
                } else if (data.type === 'error') {
                    if (entry._pendingResolve) clearTimeout(entry._pendingResolve);
                    if (entry.timer) clearTimeout(entry.timer);
                    cliResultWaiters.delete(reqId);
                    entry.resolve({ timeout: false, segments: [{ type: 'text', content: '⚠️ 错误: ' + (data.error || data.message || '') }] });
                    return;
                }

                // 判断是否完成：当收到 tasks-end 时，检查已收集的 segments：
                // - 含 text 段 → 最终回复已到，1s 后 resolve（等可能的尾部 tasks-end）
                // - 只有 tool-call/tool-result → 工具调用完成，等下一轮 response（不 resolve）
                // - 空 segments → 纯文字，1s 后 resolve
                if (data.type === 'tasks-end' || data.type === 'response') {
                    // 检查已收集的 segments 中，最后一个 text 段的位置
                    var lastTextIdx = -1;
                    var hasTool = false;
                    for (var ci = 0; ci < entry.collected.length; ci++) {
                        var sg = entry.collected[ci];
                        if (sg.type === 'text') lastTextIdx = ci;
                        if (sg.type === 'tool-call' || sg.type === 'tool-result') hasTool = true;
                    }

                    // 只有纯文字回复或最后一个 segments 是 text → 可以 resolve
                    var shouldResolve = false;
                    if (!hasTool) {
                        // 纯文字：等 tasks-end 后 1s resolve
                        if (data.type === 'tasks-end') shouldResolve = true;
                    } else {
                        // 有工具调用：只有当最后一个 text 段在 tool-call/tool-result 之后才 resolve
                        // 即第二轮 AI 回复已到
                        if (lastTextIdx >= 0) {
                            // 找到最后一个 tool 位置
                            var lastToolIdx = -1;
                            for (var ci2 = 0; ci2 < entry.collected.length; ci2++) {
                                var sg2 = entry.collected[ci2];
                                if (sg2.type === 'tool-call' || sg2.type === 'tool-result') lastToolIdx = ci2;
                            }
                            // 如果最后一个 text 在最后一个 tool 之后 → 最终回复已到
                            if (lastTextIdx > lastToolIdx) {
                                if (data.type === 'tasks-end') shouldResolve = true;
                            }
                        }
                    }

                    if (shouldResolve) {
                        // 短 debounce：等可能的尾部 tasks-end
                        if (entry._pendingResolve) clearTimeout(entry._pendingResolve);
                        entry._pendingResolve = setTimeout(function() {
                            if (cliResultWaiters.has(reqId)) {
                                clearTimeout(entry.timer);
                                cliResultWaiters.delete(reqId);
                                entry.resolve({ timeout: false, segments: entry.collected });
                            }
                        }, 1000);
                    } else if (!entry.onStream) {
                        // 工具调用未完成 + 非流式模式（旧 HTTP await）：设长超时兜底
                        if (entry._pendingResolve) clearTimeout(entry._pendingResolve);
                        entry._pendingResolve = setTimeout(function() {
                            if (cliResultWaiters.has(reqId)) {
                                clearTimeout(entry.timer);
                                cliResultWaiters.delete(reqId);
                                entry.resolve({ timeout: false, segments: entry.collected });
                            }
                        }, 30000);
                    }
                    // 流式模式（onStream 存在）：不设安全超时——依赖全局 300s 超时兜底，
                    // stream 持续开放直到收到最终 text + tasks-end 或超时。
                }
            });
        }

        // 系统控制台输出 AI 返回结果（所有段原始输出）
        if (data.type === 'response' || data.type === 'tool-results') {
            var segs = data.segments || [];
            console.log('\n═══════════════════ AI 响应 ═══════════════════');
            console.log('类型: ' + data.type + ' | 分段数: ' + segs.length);
            segs.forEach(function(s, i) {
                console.log('--- 段 #' + (i+1) + ' [类型=' + s.type + '] ---');
                if (s.type === 'text') {
                    console.log(s.content || '(空)');
                } else if (s.type === 'tool-call') {
                    console.log('工具调用: ' + (s.content || JSON.stringify(s.data || '')));
                } else if (s.type === 'tool-result') {
                    console.log('工具结果: ' + ((s.content || '') + ' ' + JSON.stringify(s.data || {})).substring(0, 300));
                } else {
                    console.log(JSON.stringify(s).substring(0, 500));
                }
            });
            console.log('══════════════════════════════════════════════\n');
        } else if (data.type === 'error') {
            console.log('[AI 错误] ' + (data.error || data.content || ''));
        } else if (data.type === 'tasks-start') {
            console.log('[AI] 开始执行任务链');
        } else if (data.type === 'tasks-end') {
            console.log('[AI] 任务链执行结束');
        } else if (data.type === 'interval-start' || data.type === 'interval-stop' || data.type === 'interval-trigger') {
            console.log('[AI] ' + data.type);
        }

        if (agentView && agentView.webContents && !agentView.webContents.isDestroyed()) {
            if (data.type === 'form-show') {
                // 表单事件 → 专用通道
                agentView.webContents.send('agent-form-show', data.form);
            } else if (data.type === 'plan-update') {
                // 计划更新 → 专用通道
                agentView.webContents.send('agent-plan-update', data.plan);
            } else if (data.type === 'skill-step') {
                // 技能步骤更新 → 专用通道
                agentView.webContents.send('agent-skill-step', data);
            } else {
                // 普通消息
                agentView.webContents.send('agent-message', data);
            }
        }

        // 技能步骤同步转发到 QQ Bot（单行精简格式，适配手机屏幕）
        if (data.type === 'skill-step' && botQQ && botQQ.getInstance() && botQQ.getAuthorizedUser()) {
            try {
                var statusEmoji = { running: '🔄', completed: '✅', failed: '❌', info: 'ℹ️' };
                var emoji = statusEmoji[data.status] || '📌';
                var msgText = emoji + ' ' + data.skill + ': ' + data.step;
                botQQ.getInstance().sendText(botQQ.getAuthorizedUser(), msgText);
            } catch (e) {
                console.warn('[QQBot] skill-step forward failed:', e.message);
            }
        }
    });

    // Agent 表单提交
    ipcMain.on('agent-form-submit', (event, data) => {
        // 转发到 inject.js（DeepSeek 端）
        if (deepseekView && deepseekView.webContents && !deepseekView.webContents.isDestroyed()) {
            deepseekView.webContents.executeJavaScript(
                'window.__dsagent_formResponse && window.__dsagent_formResponse(' + JSON.stringify(data) + ');'
            ).catch(() => {});
        }
    });

    // ==================== 历史对话 IPC 处理器 ====================
    function getHistoryDir() {
        return currentRootDir || path.join(app.getPath('userData'), '.dsa');
    }

    ipcMain.handle('history-list', async () => {
        var dir = getHistoryDir();
        return { success: true, histories: historyManager.listHistories(dir) };
    });

    ipcMain.handle('history-list-all', async () => {
        return { success: true, histories: historyManager.listHistoriesAll() };
    });

    ipcMain.handle('history-load', async (event, id) => {
        var dir = getHistoryDir();
        const data = historyManager.loadHistory(dir, id);
        if (!data) return { success: false, error: 'History not found' };
        return { success: true, history: data };
    });

    ipcMain.handle('history-save', async (event, historyData) => {
        var dir = getHistoryDir();
        return historyManager.saveHistory(dir, historyData);
    });

    ipcMain.handle('history-delete', async (event, id) => {
        var dir = getHistoryDir();
        return historyManager.deleteHistory(dir, id);
    });

    ipcMain.handle('history-rename', async (event, id, newTitle) => {
        var dir = getHistoryDir();
        return historyManager.renameHistory(dir, id, newTitle);
    });

    // 仅更新历史记录中的 DeepSeek URL（绕过空消息检查）
    ipcMain.handle('history-load-url', async (event, id, url) => {
        var dir = getHistoryDir();
        try {
            var data = historyManager.loadHistory(dir, id);
            if (data) {
                data.deepseekUrl = url;
                historyManager.saveHistory(dir, data);
                return { success: true };
            }
            return { success: false, error: 'Not found' };
        } catch (e) {
            return { success: false, error: e.message };
        }
    });

    // 文件浏览器切换目录时同步刷新历史对话列表
    ipcMain.on('request-history-refresh', () => {
        if (agentView && agentView.webContents) {
            agentView.webContents.send('refresh-history');
        }
    });

    // ==================== 多终端管理 IPC ====================
    ipcMain.handle('terminal-create', (event, name, cwd) => {
        try { return { success: true, name: agent.terminalCreate(name, cwd) }; }
        catch (e) { return { success: false, error: e.message }; }
    });
    ipcMain.handle('terminal-write', (event, name, command) => {
        try { agent.terminalWrite(name, command); return { success: true }; }
        catch (e) { return { success: false, error: e.message }; }
    });
    ipcMain.handle('terminal-output', (event, name, lines) => {
        try { return { success: true, output: agent.terminalOutput(name, lines) }; }
        catch (e) { return { success: false, error: e.message }; }
    });
    ipcMain.handle('terminal-clear', (event, name) => {
        try { agent.terminalClear(name); return { success: true }; }
        catch (e) { return { success: false, error: e.message }; }
    });
    ipcMain.handle('terminal-kill', (event, name) => {
        try { agent.terminalKill(name); return { success: true }; }
        catch (e) { return { success: false, error: e.message }; }
    });
    ipcMain.handle('terminal-list', () => {
        try { return { success: true, terminals: agent.terminalList() }; }
        catch (e) { return { success: false, error: e.message }; }
    });

    // Agent view 设置当前历史对话 ID（用于状态恢复）
    ipcMain.on('set-last-history-id', (event, historyId) => {
        saveAppState({ lastHistoryId: historyId });
    });

    // 继续生成（通过 agentview DOM 弹窗 / QQ 消息）
    ipcMain.handle('notify-continue-generation', async () => {
        // smart 和 loose 模式下自动继续，不询问
        var confirmMode = getConfirmMode();
        if (confirmMode !== 'strict') {
            return await clickDeepseekContinue();
        }
        // strict 模式下弹窗询问
        userStoppedGeneration = false;
        try {
            // QQ Bot 优先
            var qqBotInstance = botQQ ? botQQ.getInstance() : null;
            var qqBotAuthorizedUser = botQQ ? botQQ.getAuthorizedUser() : null;
            if (qqBotInstance && qqBotAuthorizedUser && agentView && agentView.webContents) {
                try {
                    await qqBotInstance.sendKeyboard(qqBotAuthorizedUser,
                        '⚠️ DeepSeek 输出被截断，检测到"继续生成"按钮。\n\n（60秒超时）',
                        [
                            { id: 'continue_yes', label: '✅ 继续生成', data: 'continue_yes', style: 1 },
                            { id: 'continue_no', label: '❌ 取消', data: 'continue_no', style: 0 }
                        ]);
                    var qqContinued = await new Promise(function(resolve) {
                        var qt = setTimeout(function() {
                            qqBotInstance.removeListener('interaction', interactionHandler);
                            qqBotInstance.removeListener('message', qh);
                            resolve(false);
                        }, 60000);
                        var interactionHandler = function(intData) {
                            if (intData.userOpenid !== qqBotAuthorizedUser) return;
                            clearTimeout(qt);
                            qqBotInstance.removeListener('interaction', interactionHandler);
                            qqBotInstance.removeListener('message', qh);
                            resolve(intData.buttonData === 'continue_yes');
                        };
                        var qh = function(m) {
                            if (m.openid !== qqBotAuthorizedUser) return;
                            var r = (m.content || '').trim().toUpperCase();
                            if (r === 'Y' || r === 'YES' || r === '继续' || r === '继续生成') {
                                clearTimeout(qt); qqBotInstance.removeListener('interaction', interactionHandler); qqBotInstance.removeListener('message', qh);
                                resolve(true);
                            } else if (r === 'N' || r === 'NO' || r === '取消') {
                                clearTimeout(qt); qqBotInstance.removeListener('interaction', interactionHandler); qqBotInstance.removeListener('message', qh);
                                resolve(false);
                            }
                        };
                        qqBotInstance.on('interaction', interactionHandler);
                        qqBotInstance.on('message', qh);
                    });
                    if (qqContinued) {
                        await clickDeepseekContinue();
                    }
                    return qqContinued;
                } catch (e) {
                    console.warn('[Continue] QQ confirm failed, fallback to agentview:', e.message);
                }
            }

            // Agent view DOM 弹窗
            if (agentView && agentView.webContents && !agentView.webContents.isDestroyed()) {
                return await new Promise(function(resolve) {
                    var msgId = 'continue-' + Date.now();
                    var handler = function(event, response) {
                        if (response.id === msgId) {
                            ipcMain.removeListener('agent-continue-response', handler);
                            clearTimeout(ct);
                            if (response.confirmed) {
                                clickDeepseekContinue().then(function(success) { resolve(!!success); });
                            } else {
                                resolve(false);
                            }
                        }
                    };
                    var ct = setTimeout(function() {
                        ipcMain.removeListener('agent-continue-response', handler);
                        resolve(false);
                    }, 120000);
                    ipcMain.on('agent-continue-response', handler);
                    agentView.webContents.send('agent-show-continue-confirm', { id: msgId });
                });
            }
        } catch (e) {
            console.warn('[Continue] Error:', e);
            return false;
        }
        return false;
    });

    // 在 DeepSeek 页面点击"继续生成"按钮
    async function clickDeepseekContinue() {
        if (!deepseekView || deepseekView.webContents.isDestroyed()) {
            console.warn('[Continue] deepseekView not available');
            return false;
        }
        try {
            // 先用 JS 定位按钮坐标并高亮
            var rect = await deepseekView.webContents.executeJavaScript(`
                (function() {
                    function findBtn() {
                        var all = document.querySelectorAll('div[role="button"], button');
                        for (var i = 0; i < all.length; i++) {
                            var t = all[i].textContent.trim();
                            if (t === '\u7EE7\u7EED\u751F\u6210' || t === 'Continue') return all[i];
                        }
                        return null;
                    }
                    var el = findBtn();
                    if (!el) return null;
                    el.style.outline = '3px solid #00aaff';
                    el.style.outlineOffset = '2px';
                    el.scrollIntoView({ block: 'center' });
                    setTimeout(function() { el.style.outline = ''; }, 4000);
                    var r = el.getBoundingClientRect();
                    return { x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2), w: Math.round(r.width), h: Math.round(r.height) };
                })()
            `);
            if (!rect) {
                console.warn('[Continue] Button not found');
                return false;
            }
            console.log('[Continue] Found at', rect.x, rect.y);

            // 通过 CDP (Chrome DevTools Protocol) 发送真实鼠标事件
            var wc = deepseekView.webContents;
            try { wc.debugger.attach('1.3'); } catch(e) { /* 可能已 attach */ }
            await wc.debugger.sendCommand('Input.dispatchMouseEvent', {
                type: 'mousePressed',
                x: rect.x,
                y: rect.y,
                button: 'left',
                clickCount: 1
            });
            await new Promise(function(r) { setTimeout(r, 60); });
            await wc.debugger.sendCommand('Input.dispatchMouseEvent', {
                type: 'mouseReleased',
                x: rect.x,
                y: rect.y,
                button: 'left',
                clickCount: 1
            });
            try { wc.debugger.detach(); } catch(e) {}
            console.log('[Continue] CDP click sent');
            return true;
        } catch (e) {
            console.error('[Continue] Failed:', e.message);
            return false;
        }
    }

}

// ==================== 文件浏览器 IPC 处理 ====================
function setupIpcHandlers() {
    // 设置 Agent IPC
    setupAgentIPC();
    // 设置控制栏 IPC
    setupControlBarIPC();

    // ==================== 模型服务化架构初始化 ====================
    // 创建 server 实例（通过闭包引用 deepseekView/qwenView，视图创建后再生效）
    deepseekServer = createDeepseekServer(() => deepseekView);
    qwenServer = createQwenServer(() => qwenView);
    openaiServer = createOpenAIServer();
    anthropicServer = createAnthropicServer();

    // 创建 registry 并注册所有 server
    modelRegistry = createModelRegistry();
    modelRegistry.register('deepseek', deepseekServer);
    modelRegistry.register('qwen', qwenServer);
    // openai/anthropic 的模型由 apikey-store 动态注入（见下方 reloadApikeyServers）
    function reloadApikeyServers() {
        // 移除旧的动态 server 注册
        modelRegistry.unregister('openai');
        modelRegistry.unregister('anthropic');
        const services = apikeyStore.listServices();
        const openaiModels = [];
        const anthropicModels = [];
        services.forEach((s) => {
            (s.models || []).forEach((m) => {
                const entry = {
                    id: m.id || (s.id + ':' + (m.apiName || m.name)),
                    displayName: m.displayName || m.name || m.apiName,
                    apiName: m.apiName || m.name,
                    capabilities: m.capabilities || apikeyStore.defaultCapabilities(s.provider, m.apiName || m.name)
                };
                if (s.provider === 'openai') openaiModels.push(entry);
                else if (s.provider === 'anthropic') anthropicModels.push(entry);
            });
        });
        // 用带模型配置的 server 实例重新注册
        const openaiSvc = services.find((s) => s.provider === 'openai');
        if (openaiSvc) {
            openaiServer.setConfig({ endpoint: openaiSvc.endpoint, apiKey: openaiSvc.apiKey, models: openaiModels });
            // 临时把 openaiModels 注入 server.models 以便 registry 注册
            const tmpModels = {};
            openaiModels.forEach((m) => { tmpModels[m.id] = m; });
            openaiServer.models = tmpModels;
            modelRegistry.register('openai', openaiServer);
        }
        const anthropicSvc = services.find((s) => s.provider === 'anthropic');
        if (anthropicSvc) {
            anthropicServer.setConfig({ endpoint: anthropicSvc.endpoint, apiKey: anthropicSvc.apiKey, models: anthropicModels });
            const tmpModels = {};
            anthropicModels.forEach((m) => { tmpModels[m.id] = m; });
            anthropicServer.models = tmpModels;
            modelRegistry.register('anthropic', anthropicServer);
        }
    }
    reloadApikeyServers();

    // 创建 orchestrator 和 subagent manager
    orchestrator = createOrchestrator({
        registry: modelRegistry,
        subagentManager: null,            // 先传 null，下方回填
        historyManager: historyManager,
        getClusterConfigFn: loadClusterConfig,
        saveClusterConfigFn: saveClusterConfigToDisk
    });
    subagentManager = createSubagentManager(() => orchestrator);
    // 回填 subagentManager 引用（解决循环依赖）
    orchestrator.setSubagentManager(subagentManager);

    // 启动网页版 server 轮询（轻量）
    try { modelRegistry.startAllPoll(10000); } catch (e) { /* 非关键 */ }

    // 初始化 Hook 引擎（P1）
    try { hookEngine.init(agent.getBaseDir()); } catch (e) { console.warn('[Hook] init failed:', e.message); }

    // 初始化已安装的插件（CC 生态兼容）
    // 异步执行，不阻塞主进程启动
    setTimeout(function() {
        try {
            var mpResult = pluginManager.ensureDefaultMarketplace();
            if (mpResult.success && !mpResult.existed) {
                console.log('[Plugin] Default marketplace installed');
            }
            var pluginResult = pluginManager.refreshPlugins(hookEngine);
            if (pluginResult.plugins && pluginResult.plugins.length > 0) {
                console.log('[Plugin] Loaded', pluginResult.plugins.length, 'plugins');
            }
        } catch (e) { console.warn('[Plugin] init failed:', e.message); }
    }, 3000); // 延迟 3 秒，等窗口加载完成后再后台初始化

    // 初始化技能引擎
    try {
        var rootDir = agent.getBaseDir();
        skillEngine.loadAll(rootDir);
        console.log('[SkillEngine] Loaded', skillEngine.list(rootDir).length, 'skills');
    } catch (e) { console.warn('[SkillEngine] init failed:', e.message); }

    // ==================== 新 IPC：统一 agent-request ====================
    ipcMain.handle('agent-request', async (event, payload) => {
        if (!orchestrator) return { success: false, error: 'Orchestrator not ready' };
        // 把 subagentManager 注入到 orchestrator 闭包（临时方案：包装调用）
        const orchInternal = orchestrator;
        // 临时挂载 subagentManager 到 orchestrator 的 deps（orchestrator.handleRequest 内部已引用 subagentManager 变量）
        return await orchInternal.handleRequest(payload);
    });

    // 模型列表查询（供前端选型框）
    ipcMain.handle('model-list', async () => {
        if (!modelRegistry) return { success: false, error: 'Registry not ready' };
        return { success: true, models: modelRegistry.listModels() };
    });

    // 工具颜色映射查询（单一来源 tools/tool-colors.js，CLI 和 agentview 同源）
    ipcMain.handle('tool-colors-get', async () => {
        try { return { success: true, colors: require('./tools/tool-colors.js') }; }
        catch (e) { return { success: false, error: e.message }; }
    });

    // 切换工作目录（change_dir 工具调用，影响 exec/read 等相对路径解析）
    ipcMain.handle('change-dir', async (event, path) => {
        try {
            agent.setBaseDir(path);
            console.log('[change-dir] Base directory updated to:', path);
            return { success: true, data: path };
        } catch (e) {
            return { success: false, error: e.message };
        }
    });

    // 集群模板查询
    ipcMain.handle('cluster-templates', async () => {
        return { success: true, templates: clusterTemplates.TEMPLATES };
    });

    // 根据模板生成选型选项
    ipcMain.handle('cluster-selection-options', async (event, templateId) => {
        if (!modelRegistry) return { success: false, error: 'Registry not ready' };
        return clusterTemplates.buildSelectionOptions(templateId, modelRegistry);
    });

    // 集群配置 CRUD
    ipcMain.handle('cluster-config-get', async () => {
        return { success: true, config: loadClusterConfig() };
    });
    ipcMain.handle('cluster-config-save', async (event, cfg) => {
        const v = clusterTemplates.validateClusterConfig(cfg.templateId, cfg.roles || {}, modelRegistry);
        if (!v.success) return v;
        return saveClusterConfigToDisk(cfg);
    });

    // Subagent 模板查询
    ipcMain.handle('subagent-list', async () => {
        if (!subagentManager) return { success: false };
        return { success: true, templates: subagentManager.listTemplates() };
    });
    ipcMain.handle('subagent-invoke', async (event, params) => {
        if (!subagentManager) return { success: false };
        return await subagentManager.invoke(params);
    });

    // cwd 变更 IPC（CLI /cd 时通知桌面版）
    ipcMain.handle('cwd-changed', async (event, path) => {
        agent.setCwd(path);
        return { success: true };
    });

    // ==================== 持久化记忆 IPC（P2） ====================
    ipcMain.handle('memory-read', async (event) => {
        var rootDir = agent.getBaseDir();
        return memoryStore.handleMemoryRead(rootDir);
    });
    ipcMain.handle('memory-append', async (event, scope, content) => {
        var rootDir = agent.getBaseDir();
        return memoryStore.handleMemoryAppend(rootDir, scope, content);
    });
    ipcMain.handle('memory-clear', async (event, scope) => {
        var rootDir = agent.getBaseDir();
        return memoryStore.handleMemoryClear(rootDir, scope);
    });

    // ==================== 插件管理 IPC（CC 生态兼容） ====================
    ipcMain.handle('plugin-list', async () => {
        return { success: true, plugins: pluginManager.getAllPluginInfo() };
    });
    ipcMain.handle('plugin-install', async (event, params) => {
        return await pluginManager.installPlugin(params);
    });
    ipcMain.handle('plugin-uninstall', async (event, name) => {
        return pluginManager.uninstallPlugin(name);
    });
    ipcMain.handle('plugin-refresh', async () => {
        return { success: true, result: pluginManager.refreshPlugins(hookEngine) };
    });

    // 插件市场管理
    ipcMain.handle('plugin-marketplace-add', async (event, params) => {
        return pluginManager.addMarketplace(params);
    });
    ipcMain.handle('plugin-marketplace-list', async () => {
        return { success: true, marketplaces: pluginManager.listMarketplaces() };
    });

    // ==================== 技能引擎 IPC（对齐 atomcode Skill） ====================
    ipcMain.handle('skill-list', async () => {
        var rootDir = agent.getBaseDir();
        var skills = skillEngine.list(rootDir);
        return { success: true, skills: skills };
    });
    ipcMain.handle('skill-execute', async (event, name, args) => {
        var rootDir = agent.getBaseDir();
        return skillEngine.execute(name, args, rootDir);
    });
    ipcMain.handle('skill-refresh', async () => {
        var rootDir = agent.getBaseDir();
        skillEngine.refresh(rootDir);
        return { success: true };
    });

    // API Key 服务 CRUD
    ipcMain.handle('apikey-list', async () => {
        return { success: true, services: apikeyStore.listServices() };
    });
    ipcMain.handle('apikey-add', async (event, service) => {
        const r = apikeyStore.addService(service);
        if (r.success) reloadApikeyServers();
        return r;
    });
    ipcMain.handle('apikey-update', async (event, id, patch) => {
        const r = apikeyStore.updateService(id, patch);
        if (r.success) reloadApikeyServers();
        return r;
    });
    ipcMain.handle('apikey-delete', async (event, id) => {
        const r = apikeyStore.deleteService(id);
        if (r.success) reloadApikeyServers();
        return r;
    });

    // 并发槽位状态查询（调试用）
    ipcMain.handle('model-slot-status', async () => {
        if (!modelRegistry) return { success: false };
        return { success: true, status: modelRegistry.getAllSlotStatus() };
    });

    // 关闭对话（清理上下文）
    ipcMain.handle('agent-close-conv', async (event, agentId) => {
        if (!orchestrator) return { success: false };
        return await orchestrator.closeConversation(agentId);
    });

    // 获取初始目录
    ipcMain.handle('get-initial-dir', async () => {
        return { success: true, path: currentRootDir };
    });

    // ==================== 菜单操作（可复用函数） ====================
    function handleMenuAction(data) {
        if (!data || !data.action) return;
        switch (data.action) {
            case 'open-folder':
                dialog.showOpenDialog(mainWindow, {
                    properties: ['openDirectory'],
                    title: '选择根文件夹'
                }).then(result => {
                    if (!result.canceled && result.filePaths.length > 0) {
                        openFolder(result.filePaths[0]);
                    }
                });
                break;
            case 'close-folder':
                currentRootDir = null;
                agent.setBaseDir(null);
                shellSend('root-changed', null);
                saveAppState({ lastRootDir: null, lastHistoryId: null });
                break;
            case 'open-recent':
                if (data.path) openFolder(data.path);
                break;
            case 'quit':
                app.quit();
                break;
            case 'role':
                if (data.role && mainWindow) {
                    var focusedView = null;
                    if (agentViewVisible && agentView) focusedView = agentView;
                    else if (qwenVisible && qwenView) focusedView = qwenView;
                    else focusedView = deepseekView;
                    if (focusedView && !focusedView.webContents.isDestroyed()) {
                        focusedView.webContents.sendInputEvent({ type: 'keyDown', keyCode: data.role === 'undo' ? 'Z' : data.role === 'redo' ? 'Y' : data.role === 'copy' ? 'C' : data.role === 'paste' ? 'V' : data.role === 'cut' ? 'X' : data.role === 'selectAll' ? 'A' : '', modifiers: ['ctrl'] });
                    }
                }
                break;
            case 'reload-deepseek':
                if (deepseekView && deepseekView.webContents && !deepseekView.webContents.isDestroyed()) {
                    const currentUrl = deepseekView.webContents.getURL();
                    // 先移出窗口防止 loadURL 触发闪现
                    try { mainWindow.removeBrowserView(deepseekView); } catch(e) {}
                    if (currentUrl && currentUrl !== 'about:blank') {
                        deepseekView.webContents.loadURL(currentUrl);
                    } else {
                        deepseekView.webContents.loadURL(DEEPSEEK_URL);
                    }
                    // did-finish-load 会重新注入脚本，延迟后重新加入
                    setTimeout(() => {
                        try {
                            mainWindow.addBrowserView(deepseekView);
                            var ob = deepseekView.getBounds();
                            if (ob.x > -1000) {
                                deepseekView.setBounds({ x: -10000, y: ob.y, width: ob.width, height: ob.height });
                            }
                            if (agentView && agentViewVisible && !agentView.webContents.isDestroyed()) {
                                mainWindow.setTopBrowserView(agentView);
                            }
                        } catch(e) {}
                    }, 800);
                }
                break;
            case 'theme':
                if (data.theme) broadcastTheme(data.theme);
                break;
            case 'devtools':
                if (qwenView && qwenVisible && !qwenView.webContents.isDestroyed()) {
                    qwenView.webContents.toggleDevTools();
                } else if (agentView && agentViewVisible && !agentView.webContents.isDestroyed()) {
                    agentView.webContents.toggleDevTools();
                } else if (deepseekView && deepseekView.webContents && !deepseekView.webContents.isDestroyed()) {
                    deepseekView.webContents.toggleDevTools();
                }
                break;
            case 'about':
                dialog.showMessageBox(mainWindow, {
                    type: 'info',
                    title: '关于 DS Agent',
                    message: 'DS Agent Desktop',
                    detail: '版本: ' + require('./package.json').version + '\n基于 Electron + DeepSeek + Qwen\n本地工具系统支持文件操作、代码执行、窗口管理等功能。'
                });
                break;
            case 'skills-storage-path':
                // 通知 agentView 显示存储路径设置弹窗
                if (agentView && agentView.webContents && !agentView.webContents.isDestroyed()) {
                    agentView.webContents.send('agent-show-storage-path-dialog');
                }
                break;
        }
    }

    // 标题栏菜单操作 IPC
    ipcMain.on('titlebar-menu-action', (event, data) => {
        handleMenuAction(data);
    });

    // agentview 加载菜单配置（动态注入最近项目）
    ipcMain.handle('get-menubar-config', async () => {
        try {
            const configPath = path.join(__dirname, 'menubar-config.json');
            if (!fs.existsSync(configPath)) {
                return { success: false, config: null };
            }
            const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
            // 动态注入最近项目到文件菜单
            const recent = loadRecentProjects();
            const fileMenu = (config.menu || []).find(function(m) { return m.id === 'file'; });
            if (fileMenu && recent.length > 0) {
                // 在 "关闭文件夹" 和 "退出" 之间的分隔符前插入最近项目
                var insertIdx = -1;
                for (var fi = 0; fi < fileMenu.items.length; fi++) {
                    if (fileMenu.items[fi].id === 'exit' || fileMenu.items[fi].type === 'separator' && fi > 0) {
                        insertIdx = fi;
                        break;
                    }
                }
                if (insertIdx > 0) {
                    var recentItems = recent.map(function(p) {
                        return { id: 'recent-' + p.replace(/[^a-zA-Z0-9_-]/g, '_'), label: p, action: 'open-recent', path: p };
                    });
                    fileMenu.items.splice.apply(fileMenu.items, [insertIdx, 0, { type: 'separator' }].concat(recentItems));
                }
            }
            return { success: true, config: config };
        } catch (e) {
            return { success: false, error: e.message };
        }
    });

    // agentview 菜单项被点击 → 执行操作
    ipcMain.on('agent-menu-item-click', (event, item) => {
        if (!item || !item.action) return;
        handleMenuAction(item);
    });

    // shell 菜单按钮点击 → 弹出原生菜单（BrowserView 永远在 DOM 之上，只能用原生菜单）
    ipcMain.on('show-native-menu', (event, menuId) => {
        try {
            const configPath = path.join(__dirname, 'menubar-config.json');
            if (!fs.existsSync(configPath)) return;
            const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
            // 动态注入最近项目
            const recent = loadRecentProjects();
            const fileMenu = (config.menu || []).find(function(m) { return m.id === menuId; });
            if (!fileMenu || !fileMenu.items) return;
            // 为 file 菜单注入最近项目
            if (menuId === 'file' && recent.length > 0) {
                var insertIdx = -1;
                for (var fi = 0; fi < fileMenu.items.length; fi++) {
                    if (fileMenu.items[fi].id === 'exit' || (fileMenu.items[fi].type === 'separator' && fi > 0)) {
                        insertIdx = fi; break;
                    }
                }
                if (insertIdx > 0) {
                    var recentItems = recent.map(function(p) {
                        return { id: 'recent-' + p.replace(/[^a-zA-Z0-9_-]/g, '_'), label: p, action: 'open-recent', path: p };
                    });
                    fileMenu.items.splice.apply(fileMenu.items, [insertIdx, 0, { type: 'separator' }].concat(recentItems));
                }
            }
            // 构建原生菜单
            var menuItems = fileMenu.items.map(function(item) {
                if (item.type === 'separator') return { type: 'separator' };
                var mi = {
                    label: item.label,
                    click: function() { handleMenuAction(item); }
                };
                if (item.accelerator) mi.accelerator = item.accelerator;
                if (item.type === 'radio') {
                    mi.type = 'radio';
                    if (item.id === 'theme-' + currentAppTheme) mi.checked = true;
                }
                return mi;
            });
            var menu = Menu.buildFromTemplate(menuItems);
            // 在鼠标位置弹出
            menu.popup(mainWindow);
        } catch (e) {
            console.error('[Menu] Popup error:', e);
        }
    });

    // 兼容旧版 shell.html 中 showCustomMenu 发送的事件（只处理 agentView，DeepSeek/Qwen 不需要注入菜单）
    ipcMain.on('inject-menu-overlay', (event, data) => {
        // data 可能是旧格式（纯 menuId 字符串）或新格式（{menuId, left, bottom}）
        var payload = typeof data === 'string' ? { menuId: data } : data;
        // 仅在 Agent 视图可见时转发到 agentView 内部渲染（避免被 agentView 遮挡）
        if (agentViewVisible && agentView && !agentView.webContents.isDestroyed()) {
            // shell.html 的 getBoundingClientRect() 坐标相对于窗口内容区原点。
            // agentView BrowserView 的 setBounds 从 y=titlebarH 开始（标题栏下方），
            // 所以 agentView 的 position:fixed 是相对于其自身 viewport 的。
            // 需要将 Y 坐标减去标题栏高度，使菜单贴在按钮正下方。
            const titlebarH = 38;
            var vbW = (mainWindow && mainWindow.getContentBounds().width < 500) ? 0 :
                      (mainWindow && mainWindow.getContentBounds().width < 700) ? 48 : VIEWBAR_WIDTH;
            if (payload.left !== undefined) {
                payload.left = payload.left - vbW;
            }
            if (payload.bottom !== undefined) {
                payload.bottom = payload.bottom - titlebarH;
            }
            agentView.webContents.send('render-menu-overlay', payload);
        }
    });

    // 注入菜单项点击回调
    ipcMain.on('menu-item-clicked', (event, data) => {
        handleMenuAction(data);
    });

    // 标题栏窗口控制
    ipcMain.on('titlebar-window-control', (event, action) => {
        if (!mainWindow) return;
        switch (action) {
            case 'minimize':
                mainWindow.minimize();
                break;
            case 'maximize':
                if (mainWindow.isMaximized()) {
                    mainWindow.unmaximize();
                } else {
                    mainWindow.maximize();
                }
                break;
            case 'close':
                mainWindow.close();
                break;
        }
    });

    // 获取系统下载目录
    ipcMain.handle('get-downloads-path', async () => {
        return { success: true, path: app.getPath('downloads') };
    });

    // 获取初始化提示词
    ipcMain.handle('get-init-prompt', async (event, mode) => {
        try {
            var text = '';
            // mode 现在可能是旧 mode（expert/fast/image）或 modelId（deepseek.expert 等）
            // 统一解析为 agentSuffix + strategyMode
            var agentSuffix = 'quick';
            var strategyMode = 'quick';
            if (typeof mode === 'string') {
                if (mode.indexOf('expert') >= 0 || mode === 'expert') { agentSuffix = 'pro'; strategyMode = 'professional'; }
                else if (mode.indexOf('image') >= 0 || mode === 'image') { agentSuffix = 'image'; strategyMode = 'image'; }
                else { agentSuffix = 'quick'; strategyMode = 'quick'; }
            }
            // 兼容旧映射
            var agentFileMap = { 'expert': 'pro', 'fast': 'quick', 'image': 'image' };
            if (agentFileMap[mode]) { agentSuffix = agentFileMap[mode]; strategyMode = { 'expert': 'professional', 'fast': 'quick', 'image': 'image' }[mode]; }

            const promptDir = path.join(__dirname, 'prompt');
            if (fs.existsSync(promptDir)) {
                const allFiles = fs.readdirSync(promptDir)
                    .filter(f => f.endsWith('.md'));
                // AGENT_*.md 是模式策略文件，只加载匹配当前模式的（避免发送全部 3 个策略）
                var modeAgentFile = 'AGENT_' + agentSuffix + '.md';
                var files = allFiles.filter(function(f) {
                    if (!f.startsWith('AGENT_')) return true;          // 非策略文件全部加载
                    return f.toLowerCase() === modeAgentFile.toLowerCase(); // 策略文件只加载匹配模式的
                }).sort();
                for (const f of files) {
                    text += fs.readFileSync(path.join(promptDir, f), 'utf-8') + '\n\n';
                }
            }
            // 加载模式专用策略（common.md + {mode}.md）
            const strategyDir = path.join(__dirname, 'prompt', 'strategy');
            if (fs.existsSync(strategyDir)) {
                // 先加载公用策略
                var commonFile = path.join(strategyDir, 'common.md');
                if (fs.existsSync(commonFile)) {
                    text += fs.readFileSync(commonFile, 'utf-8') + '\n\n';
                }
                // 再加载模式专用策略
                var strategyFile = path.join(strategyDir, strategyMode + '.md');
                if (fs.existsSync(strategyFile)) {
                    text += fs.readFileSync(strategyFile, 'utf-8') + '\n\n';
                }
            }
            // 追加已加载技能
            var skillsPrompt = agent.getSkillsPrompt();
            if (skillsPrompt) text += skillsPrompt;
            // 追加 MCP 工具提示词
            var mcpPrompt = agent.getMcpPrompt();
            if (mcpPrompt) text += mcpPrompt;
            return { success: true, text: text };
        } catch (e) {
            return { success: false, error: e.message };
        }
    });

    // 获取指令文本（P0: 模块化提示词拼接，P5: 会话级缓存）
    // 由 prompt-builder.js 从多个 section 拼装，替代原来的文件直接读取
    ipcMain.handle('get-instruction-text', async (event, payload) => {
        try {
            var modelId = (payload && payload.modelId) || '';
            // 判断格式：Qwen → JSON，DeepSeek → XML，其他 API 模型 → JSON
            var useJson = false;
            if (modelId.indexOf('qwen') !== -1) {
                useJson = true;
            } else if (modelId.indexOf('deepseek') === -1 && modelRegistry) {
                var modelInfo = modelRegistry.getModel(modelId);
                if (modelInfo && modelInfo.provider !== 'deepseek') {
                    useJson = true;
                }
            }

            var mode = (payload && payload.mode) || 'fast';
            var rootDir = agent.getBaseDir() || '';
            var sessionId = (payload && payload.sessionId) || '';

            // 用 prompt-builder 组装（支持缓存）
            var result = promptBuilder.buildInstructionText({
                sessionId: sessionId,
                modelId: modelId,
                rootDir: rootDir,
                mode: mode,
                useJson: useJson
            });

            // 如果 useJson 需要特殊格式，加载 INSTRUCTION_JSON.md 替换 section 中的格式说明
            var finalText = result.text;
            if (useJson) {
                var jsonInstrFile = path.join(__dirname, 'prompt', 'INSTRUCTION_JSON.md');
                if (fs.existsSync(jsonInstrFile)) {
                    var jsonInstr = fs.readFileSync(jsonInstrFile, 'utf-8');
                    // 格式部分替换
                    finalText = finalText.replace(/XML/g, 'JSON').replace(/<[a-z]+:[a-z]+>/g, '');
                }
            }

            console.log('[get-instruction-text] modelId=' + modelId + ' mode=' + mode + ' len=' + finalText.length + ' cached=' + (result.text === finalText ? 'yes' : 'no'));
            return { success: true, text: finalText };
        } catch (e) {
            return { success: false, error: e.message };
        }
    });

    // 选择文件夹
    ipcMain.handle('select-folder', async () => {
        const result = await dialog.showOpenDialog(mainWindow, {
            properties: ['openDirectory'],
            title: '选择根文件夹'
        });
        if (result.canceled || result.filePaths.length === 0) {
            return { success: false, canceled: true };
        }
        openFolder(result.filePaths[0]);
        return { success: true, path: result.filePaths[0] };
    });

    // 关闭文件夹
    ipcMain.handle('close-folder', async () => {
        currentRootDir = null;
        agent.setBaseDir(null);
        shellSend('root-changed', null);
        saveAppState({ lastRootDir: null, lastHistoryId: null });
        return { success: true };
    });

    // 列出目录内容
    ipcMain.handle('list-dir', async (event, dirPath) => {
        try {
            if (!fs.existsSync(dirPath)) {
                return { success: false, error: '目录不存在' };
            }
            const files = fs.readdirSync(dirPath);
            const fileInfos = [];
            for (const file of files) {
                const fullPath = path.join(dirPath, file);
                try {
                    const stat = fs.statSync(fullPath);
                    fileInfos.push({
                        name: file,
                        isDir: stat.isDirectory(),
                        size: stat.size,
                        modifiedTime: stat.mtime
                    });
                } catch (e) {
                    // 忽略无权限的文件
                }
            }
            return { success: true, path: dirPath, files: fileInfos };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    // 发送路径到 Agent 文件栏 / DeepSeek 输入框
    ipcMain.handle('send-path-to-chat', async (event, filePath) => {
        var results = { agent: false, deepseek: false };
        // Agent 模式：发送到 Agent 的文件附件栏
        if (agentView && agentViewVisible) {
            try {
                agentView.webContents.send('agent-add-file', filePath);
                results.agent = true;
            } catch(e) {}
        }
        // DeepSeek 视图（直接填入输入框）
        if (deepseekView) {
            try {
                await deepseekView.webContents.executeJavaScript(
                    `window.__dsagent_fillInput && window.__dsagent_fillInput(${JSON.stringify(filePath)});`
                );
                results.deepseek = true;
            } catch (e) {}
        }
        return { success: results.agent || results.deepseek, targets: results };
    });

    // 打开文件（使用系统默认程序）
    ipcMain.handle('open-file', async (event, filePath) => {
        try {
            if (!fs.existsSync(filePath)) {
                return { success: false, error: '文件不存在' };
            }
            await shell.openPath(filePath);
            return { success: true };
        } catch (error) {
            // 如果 shell.openPath 失败，尝试用 start 命令
            return new Promise((resolve) => {
                exec(`start "" "${filePath}"`, (err) => {
                    if (err) {
                        resolve({ success: false, error: err.message });
                    } else {
                        resolve({ success: true });
                    }
                });
            });
        }
    });

    // 保存粘贴的图片到 .dsa/temp
    ipcMain.handle('save-temp-image', async (event, data) => {
        try {
            var tempDir = path.join(currentRootDir || path.join(app.getPath('userData'), '.dsa-agent'), '.dsa', 'temp');
            if (!fs.existsSync(tempDir)) {
                fs.mkdirSync(tempDir, { recursive: true });
            }
            var base64Data = data.data.replace(/^data:image\/\w+;base64,/, '');
            var buffer = Buffer.from(base64Data, 'base64');
            var savePath = path.join(tempDir, data.name || ('pasted_' + Date.now() + '.png'));
            fs.writeFileSync(savePath, buffer);
            return { success: true, path: savePath };
        } catch (e) {
            return { success: false, error: e.message };
        }
    });

    // 删除文件或目录
    ipcMain.handle('delete-file', async (event, filePath, isDir) => {
        try {
            if (!fs.existsSync(filePath)) {
                return { success: false, error: '文件/目录不存在' };
            }
            if (isDir) {
                fs.rmSync(filePath, { recursive: true });
            } else {
                fs.unlinkSync(filePath);
            }
            return { success: true };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    // 文件浏览器确认弹窗（委托到 agentview 显示）
    ipcMain.handle('fb-confirm-file-delete', async (event, fileName) => {
        try {
            if (agentView && agentView.webContents && !agentView.webContents.isDestroyed()) {
                var result = await agentView.webContents.executeJavaScript(
                    'confirmModal("确定删除 ' + fileName.replace(/\\/g, '\\\\').replace(/'/g, "\\'") + ' 吗？")'
                );
                return { success: true, confirmed: !!result };
            }
            return { success: false, error: 'agentView not available' };
        } catch (e) {
            return { success: false, error: e.message };
        }
    });

    // 重命名文件或目录
    ipcMain.handle('rename-file', async (event, filePath, newName) => {
        try {
            const path = require('path');
            if (!fs.existsSync(filePath)) {
                return { success: false, error: '文件/目录不存在' };
            }
            const dir = path.dirname(filePath);
            const newPath = path.join(dir, newName);
            if (fs.existsSync(newPath)) {
                return { success: false, error: '目标名称已存在' };
            }
            fs.renameSync(filePath, newPath);
            return { success: true };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });
}

// ==================== 主题预设 ====================
const THEME_PRESETS = {
    dark: null,   // 使用 :root 默认值，不注入
    light: null,  // 使用 body.light 默认值，不注入
    ocean: {
        '--bg-base': '#0a1628',
        '--bg-panel': '#0f1f3d',
        '--bg-elevated': '#152b52',
        '--bg-chat': '#0a1628',
        '--bg-hover': 'rgba(0,180,216,0.10)',
        '--bg-active': 'rgba(0,180,216,0.16)',
        '--border': 'rgba(0,150,200,0.5)',
        '--border-light': 'rgba(0,150,200,0.25)',
        '--border-active': '#00b4d8',
        '--text-primary': '#d6f0ff',
        '--text-secondary': '#8cc8e8',
        '--text-muted': '#5a9abb',
        '--accent': '#ff7e67',
        '--accent-2': '#00b4d8',
        '--accent-gradient': 'linear-gradient(135deg, #ff7e67, #00b4d8)',
        '--success': '#06d6a0',
        '--danger': '#ef476f',
        '--warning': '#ffd166',
        '--cyan': '#00b4d8',
        '--shadow-sm': '0 1px 3px rgba(0,0,0,0.4)',
        '--shadow-md': '0 4px 12px rgba(0,0,0,0.45)',
        '--shadow-lg': '0 8px 24px rgba(0,0,0,0.5)',
        '--shadow-glow': '0 0 25px rgba(255,126,103,0.25)',
        '--hover-overlay': 'rgba(0,180,216,0.08)',
        '--accent-soft': 'rgba(255,126,103,0.10)',
        '--accent-soft-strong': 'rgba(255,126,103,0.20)',
        '--surface-muted': 'rgba(255,255,255,0.06)',
        '--surface-muted-strong': 'rgba(255,255,255,0.1)',
        '--bg-gradient': 'linear-gradient(180deg, rgba(0,180,216,0.06) 0%, transparent 100%)',
        '--gradient-overlay': 'linear-gradient(180deg, rgba(255,126,103,0.18) 0%, rgba(0,180,216,0.10) 30%, rgba(10,22,40,0.03) 60%, transparent 80%)'
    },
    desert: {
        '--bg-base': '#1a0f08',
        '--bg-panel': '#2a1a0e',
        '--bg-elevated': '#3d2814',
        '--bg-chat': '#1a0f08',
        '--bg-hover': 'rgba(255,180,80,0.10)',
        '--bg-active': 'rgba(255,180,80,0.16)',
        '--border': 'rgba(230,150,50,0.5)',
        '--border-light': 'rgba(230,150,50,0.25)',
        '--border-active': '#ffb450',
        '--text-primary': '#fff0dc',
        '--text-secondary': '#d4b08a',
        '--text-muted': '#a07a56',
        '--accent': '#40e0d0',
        '--accent-2': '#ffb450',
        '--accent-gradient': 'linear-gradient(135deg, #40e0d0, #ffb450)',
        '--success': '#66d4a0',
        '--danger': '#ff5540',
        '--warning': '#ffcc00',
        '--cyan': '#40e0d0',
        '--shadow-sm': '0 1px 3px rgba(0,0,0,0.4)',
        '--shadow-md': '0 4px 12px rgba(0,0,0,0.45)',
        '--shadow-lg': '0 8px 24px rgba(0,0,0,0.5)',
        '--shadow-glow': '0 0 25px rgba(64,224,208,0.25)',
        '--hover-overlay': 'rgba(255,180,80,0.08)',
        '--accent-soft': 'rgba(64,224,208,0.10)',
        '--accent-soft-strong': 'rgba(64,224,208,0.20)',
        '--surface-muted': 'rgba(255,255,255,0.06)',
        '--surface-muted-strong': 'rgba(255,255,255,0.1)',
        '--bg-gradient': 'linear-gradient(180deg, rgba(255,180,80,0.06) 0%, transparent 100%)',
        '--gradient-overlay': 'linear-gradient(180deg, rgba(64,224,208,0.18) 0%, rgba(255,180,80,0.10) 30%, rgba(26,15,8,0.03) 60%, transparent 80%)'
    },
    forest: {
        '--bg-base': '#0a1a10',
        '--bg-panel': '#0f2618',
        '--bg-elevated': '#163822',
        '--bg-chat': '#0a1a10',
        '--bg-hover': 'rgba(74,222,128,0.10)',
        '--bg-active': 'rgba(74,222,128,0.16)',
        '--border': 'rgba(40,180,80,0.5)',
        '--border-light': 'rgba(40,180,80,0.25)',
        '--border-active': '#4ade80',
        '--text-primary': '#d4ffdf',
        '--text-secondary': '#88c99b',
        '--text-muted': '#5a9a6e',
        '--accent': '#e8a040',
        '--accent-2': '#4ade80',
        '--accent-gradient': 'linear-gradient(135deg, #e8a040, #4ade80)',
        '--success': '#50ff8c',
        '--danger': '#ff4455',
        '--warning': '#ffdd00',
        '--cyan': '#4ade80',
        '--shadow-sm': '0 1px 3px rgba(0,0,0,0.4)',
        '--shadow-md': '0 4px 12px rgba(0,0,0,0.45)',
        '--shadow-lg': '0 8px 24px rgba(0,0,0,0.5)',
        '--shadow-glow': '0 0 25px rgba(232,160,64,0.25)',
        '--hover-overlay': 'rgba(74,222,128,0.08)',
        '--accent-soft': 'rgba(232,160,64,0.10)',
        '--accent-soft-strong': 'rgba(232,160,64,0.20)',
        '--surface-muted': 'rgba(255,255,255,0.06)',
        '--surface-muted-strong': 'rgba(255,255,255,0.1)',
        '--bg-gradient': 'linear-gradient(180deg, rgba(74,222,128,0.06) 0%, transparent 100%)',
        '--gradient-overlay': 'linear-gradient(180deg, rgba(232,160,64,0.18) 0%, rgba(74,222,128,0.10) 30%, rgba(10,26,16,0.03) 60%, transparent 80%)'
    },
    sunset: {
        '--bg-base': '#1a0a18',
        '--bg-panel': '#2a1025',
        '--bg-elevated': '#3d1a35',
        '--bg-chat': '#1a0a18',
        '--bg-hover': 'rgba(255,100,180,0.10)',
        '--bg-active': 'rgba(255,100,180,0.16)',
        '--border': 'rgba(220,100,200,0.5)',
        '--border-light': 'rgba(220,100,200,0.25)',
        '--border-active': '#ff64b4',
        '--text-primary': '#ffe0f0',
        '--text-secondary': '#d4a0c0',
        '--text-muted': '#9a6a88',
        '--accent': '#ffd166',
        '--accent-2': '#c060ff',
        '--accent-gradient': 'linear-gradient(135deg, #ffd166, #c060ff)',
        '--success': '#50e0a0',
        '--danger': '#ff5570',
        '--warning': '#ffcc00',
        '--cyan': '#c060ff',
        '--shadow-sm': '0 1px 3px rgba(0,0,0,0.4)',
        '--shadow-md': '0 4px 12px rgba(0,0,0,0.45)',
        '--shadow-lg': '0 8px 24px rgba(0,0,0,0.5)',
        '--shadow-glow': '0 0 25px rgba(255,209,102,0.25)',
        '--hover-overlay': 'rgba(255,100,180,0.08)',
        '--accent-soft': 'rgba(255,209,102,0.10)',
        '--accent-soft-strong': 'rgba(255,209,102,0.20)',
        '--surface-muted': 'rgba(255,255,255,0.06)',
        '--surface-muted-strong': 'rgba(255,255,255,0.1)',
        '--bg-gradient': 'linear-gradient(180deg, rgba(255,100,180,0.06) 0%, transparent 100%)',
        '--gradient-overlay': 'linear-gradient(180deg, rgba(255,209,102,0.18) 0%, rgba(192,96,255,0.10) 30%, rgba(26,10,24,0.03) 60%, transparent 80%)'
    }
};

const THEME_LIST = ['dark', 'light', 'ocean', 'desert', 'forest', 'sunset'];
const THEME_ICONS = { dark: '🌙', light: '☀️', ocean: '🌊', desert: '🏜️', forest: '🌲', sunset: '🌅' };
const THEME_LABELS = { dark: '深色', light: '浅色', ocean: '海洋', desert: '沙漠', forest: '森林', sunset: '日落' };

// 向 shellView 广播 IPC 消息（单页面，无 iframe）
function shellSend(channel, ...args) {
    if (!shellView || !shellView.webContents || shellView.webContents.isDestroyed()) return;
    try {
        shellView.webContents.send(channel, ...args);
    } catch (e) {
        // 页面可能尚未就绪，静默忽略
    }
}

// 向视图注入主题 CSS 变量（通过 <style> 标签覆盖）
function injectThemeVars(view, theme) {
    if (!view || !view.webContents || view.webContents.isDestroyed()) return;
    var preset = THEME_PRESETS[theme];
    var code;
    if (preset) {
        var cssBody = Object.keys(preset).map(function(k) {
            return k + ': ' + preset[k] + ' !important;';
        }).join(' ');
        var css = ':root { ' + cssBody + ' } body { ' + cssBody + ' } body.light { ' + cssBody + ' } body.light-theme { ' + cssBody + ' }';
        code = '(function(){var s=document.getElementById("__theme_preset");if(!s){s=document.createElement("style");s.id="__theme_preset";document.head.appendChild(s)}s.textContent=' + JSON.stringify(css) + ';document.body.classList.remove("light")})()';
    } else {
        code = '(function(){var s=document.getElementById("__theme_preset");if(s)s.remove();document.body.classList.toggle("light",' + (theme === 'light') + ')})()';
    }
    view.webContents.executeJavaScript(code).catch(function(e) {
        console.warn('[Theme] Failed to inject vars:', e.message);
    });
}

// ==================== 广播主题切换 ====================
function broadcastTheme(theme) {
    currentAppTheme = theme;
    saveAppState({ theme: theme });
    // 向所有视图注入主题变量
    injectThemeVars(shellView, theme);
    injectThemeVars(agentView, theme);
    shellSend('ctrl-theme', theme);
    shellSend('fb-theme', theme);
    if (agentView && agentView.webContents && !agentView.webContents.isDestroyed()) {
        agentView.webContents.send('agent-theme', theme);
    }
    // 同步 DeepSeek / Qwen 网页主题（CSS 全局滤镜）
    setPageTheme(deepseekView, theme);
    setPageTheme(qwenView, theme);
    rebuildMenu();  // 更新菜单中的勾选状态
}

// 给外部网页应用反色滤镜（深色模式时白底变黑底）
// 使用 backdrop-filter 覆盖层方案，在 GPU 合成层操作：
// - 不受 position:fixed / contain / Shadow DOM 等影响
// - SPA 动态渲染的内容自动生效
// - invert + hue-rotate 配合：反色同时补偿色调偏移（蓝→黄修复回蓝）
// - 叠加 app 统一的渐变色，实现视图间视觉衔接
// - 反色层和渐变层分两个独立 div，避免 Chromium 合成层冲突
// - 浅色模式也叠加渐变色（只是不反色）
function setPageTheme(view, theme) {
    if (!view || !view.webContents || view.webContents.isDestroyed()) return;
    var preset = THEME_PRESETS[theme];
    var gradient = preset ? preset['--gradient-overlay'] : null;
    var code;
    if (theme === 'dark') {
        code = '(function(){var o=document.getElementById("__ds_theme_overlay");if(o)o.remove();var g=document.getElementById("__ds_theme_gradient");if(g)g.remove();var c=document.createElement("div");c.id="__ds_theme_overlay";c.style.cssText="position:fixed;top:0;left:0;width:100vw;height:100vh;pointer-events:none;z-index:2147483646;backdrop-filter:invert(1) hue-rotate(180deg);opacity:0;transition:opacity 0.3s ease";document.documentElement.appendChild(c);setTimeout(function(){c.style.opacity="1"},10);var g=document.createElement("div");g.id="__ds_theme_gradient";g.style.cssText="position:fixed;top:0;left:0;width:100vw;height:100vh;pointer-events:none;z-index:2147483647;background:linear-gradient(180deg,rgba(56,139,253,0.15) 0%,rgba(137,87,229,0.08) 30%,rgba(13,17,23,0.03) 60%,transparent 80%);opacity:0;transition:opacity 0.3s ease";document.documentElement.appendChild(g);setTimeout(function(){g.style.opacity="1"},10)})();';
    } else if (theme === 'light') {
        code = '(function(){var o=document.getElementById("__ds_theme_overlay");if(o){o.style.opacity="0";setTimeout(function(){o.remove()},300)}var g=document.getElementById("__ds_theme_gradient");if(g){g.style.opacity="0";setTimeout(function(){g.remove()},300)}setTimeout(function(){var g=document.createElement("div");g.id="__ds_theme_gradient";g.style.cssText="position:fixed;top:0;left:0;width:100vw;height:100vh;pointer-events:none;z-index:2147483647;background:linear-gradient(180deg,rgba(9,105,218,0.12) 0%,rgba(130,80,223,0.06) 30%,transparent 70%);opacity:0;transition:opacity 0.3s ease";document.documentElement.appendChild(g);setTimeout(function(){g.style.opacity="1"},10)},300)})();';
    } else if (gradient) {
        // 新主题：反色 + 主题渐变
        code = '(function(){var o=document.getElementById("__ds_theme_overlay");if(o)o.remove();var g=document.getElementById("__ds_theme_gradient");if(g)g.remove();var c=document.createElement("div");c.id="__ds_theme_overlay";c.style.cssText="position:fixed;top:0;left:0;width:100vw;height:100vh;pointer-events:none;z-index:2147483646;backdrop-filter:invert(1) hue-rotate(180deg);opacity:0;transition:opacity 0.3s ease";document.documentElement.appendChild(c);setTimeout(function(){c.style.opacity="1"},10);var g=document.createElement("div");g.id="__ds_theme_gradient";g.style.cssText="position:fixed;top:0;left:0;width:100vw;height:100vh;pointer-events:none;z-index:2147483647;background:' + gradient + ';opacity:0;transition:opacity 0.3s ease";document.documentElement.appendChild(g);setTimeout(function(){g.style.opacity="1"},10)})();';
    } else {
        code = '(function(){var o=document.getElementById("__ds_theme_overlay");if(o){o.style.opacity="0";setTimeout(function(){o.remove()},300)}var g=document.getElementById("__ds_theme_gradient");if(g){g.style.opacity="0";setTimeout(function(){g.remove()},300)}})();';
    }
    view.webContents.executeJavaScript(code).catch(function(e){
        console.warn('[Theme] Failed to apply theme:', e.message);
    });
}

// ==================== 创建菜单栏 ====================
function buildMenuTemplate() {
    const recent = loadRecentProjects();
    const reloadDeepseekItem = {
        label: '重载 DeepSeek 页面',
        accelerator: 'CmdOrCtrl+Shift+D',
        click: () => {
            if (deepseekView && deepseekView.webContents && !deepseekView.webContents.isDestroyed()) {
                const currentUrl = deepseekView.webContents.getURL();
                // 先移出窗口防止 loadURL 触发闪现
                try { mainWindow.removeBrowserView(deepseekView); } catch(e) {}
                if (currentUrl && currentUrl !== 'about:blank') {
                    deepseekView.webContents.loadURL(currentUrl);
                } else {
                    deepseekView.webContents.loadURL(DEEPSEEK_URL);
                }
                // did-finish-load 会重新注入脚本，延迟后重新加入
                setTimeout(() => {
                    try {
                        mainWindow.addBrowserView(deepseekView);
                        var ob = deepseekView.getBounds();
                        if (ob.x > -1000) {
                            deepseekView.setBounds({ x: -10000, y: ob.y, width: ob.width, height: ob.height });
                        }
                        if (agentView && agentViewVisible && !agentView.webContents.isDestroyed()) {
                            mainWindow.setTopBrowserView(agentView);
                        }
                    } catch(e) {}
                }, 800);
            }
        }
    };
    const template = [
        {
            label: '文件',
            submenu: [
                {
                    label: '打开文件夹...',
                    accelerator: 'CmdOrCtrl+O',
                    click: async () => {
                        const result = await dialog.showOpenDialog(mainWindow, {
                            properties: ['openDirectory'],
                            title: '选择根文件夹'
                        });
                        if (result.canceled || result.filePaths.length === 0) return;
                        openFolder(result.filePaths[0]);
                    }
                },
                ...(recent.length > 0 ? [
                    { type: 'separator' },
                    ...recent.map(p => ({
                        label: p,
                        click: () => openFolder(p)
                    }))
                ] : []),
                { type: 'separator' },
                {
                    label: '关闭文件夹',
                    accelerator: 'CmdOrCtrl+Shift+O',
                    click: async () => {
                        currentRootDir = null;
                        agent.setBaseDir(null);
                        shellSend('root-changed', null);
                    }
                },
                { type: 'separator' },
                { label: '退出', role: 'quit' }
            ]
        },
        {
            label: '编辑',
            submenu: [
                { label: '撤销', role: 'undo' },
                { label: '重做', role: 'redo' },
                { type: 'separator' },
                { label: '剪切', role: 'cut' },
                { label: '复制', role: 'copy' },
                { label: '粘贴', role: 'paste' },
                { label: '全选', role: 'selectAll' }
            ]
        },
        {
            label: '视图',
            submenu: [
                {
                    label: '重新加载',
                    accelerator: 'CmdOrCtrl+R',
                    role: 'reload'
                },
                {
                    label: '强制重新加载',
                    accelerator: 'CmdOrCtrl+Shift+R',
                    role: 'forceReload'
                },
                { type: 'separator' },
                reloadDeepseekItem,
                { type: 'separator' },
                ...THEME_LIST.map(function(t) {
                    return {
                        label: THEME_LABELS[t] + '主题',
                        type: 'radio',
                        checked: currentAppTheme === t,
                        click: (function(theme) { return function() { broadcastTheme(theme); }; })(t)
                    };
                }),
                { type: 'separator' },
                {
                    label: '开发者工具',
                    accelerator: 'F12',
                    click: () => {
                        if (qwenView && qwenVisible && !qwenView.webContents.isDestroyed()) {
                            qwenView.webContents.toggleDevTools();
                        } else if (agentView && agentViewVisible && !agentView.webContents.isDestroyed()) {
                            agentView.webContents.toggleDevTools();
                        } else if (deepseekView && deepseekView.webContents && !deepseekView.webContents.isDestroyed()) {
                            deepseekView.webContents.toggleDevTools();
                        }
                    }
                }
            ]
        },
        {
            label: '帮助',
            submenu: [
                {
                    label: '关于 DS Agent',
                    click: () => {
                        dialog.showMessageBox(mainWindow, {
                            type: 'info',
                            title: '关于 DS Agent',
                            message: 'DS Agent Desktop',
                            detail: '版本: 1.0.0\n基于 Electron + DeepSeek + Qwen\n本地工具系统支持文件操作、代码执行、窗口管理等功能。'
                        });
                    }
                }
            ]
        }
    ];
    return template;
}

function rebuildMenu() {
    const menu = Menu.buildFromTemplate(buildMenuTemplate());
    Menu.setApplicationMenu(menu);
}

function createMenu() {
    rebuildMenu();
}

// ==================== 布局更新 ====================
function updateBounds() {
    if (!mainWindow) return;
    const { width, height } = mainWindow.getContentBounds();
    const titlebarH = 38;
    const mainHeight = height - CTRL_BAR_HEIGHT - titlebarH;
    // 响应式：根据窗口宽度决定 viewbar/filebrowser 是否显示
    const vbW = width < 500 ? 0 : (width < 700 ? 48 : VIEWBAR_WIDTH);
    const fbW = width < 1000 ? 0 : SIDEBAR_WIDTH;
    const contentX = vbW;
    const contentWidth = width - vbW - fbW;
    const contentBounds = {
        x: contentX, y: titlebarH,
        width: contentWidth,
        height: mainHeight
    };
    // shellView 覆盖整个窗口（底层，内联 viewbar/controlbar/filebrowser）
    if (shellView && _startupComplete) {
        shellView.setBounds({ x: 0, y: 0, width: width, height: height });
    }
    // 内容区视图 — 启动完成前保持手动位置（避免 viewbar 偏移打乱 splash 居中）
    if (_startupComplete) {
        var offBounds = { x: -10000, y: titlebarH, width: contentBounds.width, height: contentBounds.height };
        if (agentViewVisible || qwenVisible) {
            deepseekView.setBounds(offBounds);
        }
        if (qwenView && (agentViewVisible || !qwenVisible)) {
            qwenView.setBounds(offBounds);
        }
        if (agentView && !agentViewVisible) {
            agentView.setBounds(offBounds);
        }
        if (!agentViewVisible && !qwenVisible) {
            deepseekView.setBounds(contentBounds);
        } else if (qwenView && !agentViewVisible && qwenVisible) {
            qwenView.setBounds(contentBounds);
        } else if (agentView && agentViewVisible) {
            agentView.setBounds(contentBounds);
        }
        if (!prevAgentViewVisible && agentViewVisible) forceRepaint(agentView);
        if (!prevQwenVisible && qwenVisible) forceRepaint(qwenView);
        prevAgentViewVisible = agentViewVisible;
        prevQwenVisible = qwenVisible;

        try {
        if (agentViewVisible && agentView) {
            mainWindow.setTopBrowserView(agentView);
        } else if (qwenVisible && qwenView) {
            mainWindow.setTopBrowserView(qwenView);
        } else if (deepseekView) {
            mainWindow.setTopBrowserView(deepseekView);
        }
    } catch (e) {}
    }
}

// 强制 BrowserView 重绘：通过微调尺寸触发 Chromium 重新合成帧
async function forceRepaint(view) {
    if (!view || view.webContents.isDestroyed()) return;
    try {
        var b = view.getBounds();
        view.setBounds({ x: b.x, y: b.y, width: Math.max(b.width - 1, 1), height: b.height });
        await new Promise(r => setTimeout(r, 50));
        view.setBounds(b);
    } catch (e) {}
}

// 安全执行 JS：封装 frame disposal 重试（SPA 导航期间帧会 disposed-重建）
// opts: { retries: 3, delay: 300, silent: false }
// 返回结果，或失败时返回 null（不冒泡错误到控制台）
async function safeExecJs(view, code, opts) {
    opts = opts || {};
    const retries = opts.retries != null ? opts.retries : 3;
    const delay = opts.delay != null ? opts.delay : 300;
    if (!view || !view.webContents || view.webContents.isDestroyed()) return null;
    // loading 时直接返回 null（等下轮调用）
    if (view.webContents.isLoading()) return null;
    for (let attempt = 0; attempt < retries; attempt++) {
        try {
            return await view.webContents.executeJavaScript(code, true);
        } catch (e) {
            const msg = String(e && e.message || e);
            // frame disposed / 导航中 → 等待帧重建后重试
            if (msg.indexOf('disposed') >= 0 || msg.indexOf('Render frame') >= 0 || msg.indexOf('frame') >= 0 || msg.indexOf('mainFrame') >= 0) {
                await new Promise(r => setTimeout(r, delay));
                continue;
            }
            // 其它错误：静默返回 null（不冒泡）
            if (!opts.silent) console.warn('[safeExecJs] error:', msg);
            return null;
        }
    }
    // 重试用尽，静默返回 null
    return null;
}

// ==================== 创建双栏窗口 ====================
// ==================== 登录检测 ====================

async function checkLoginRequired(view, name) {
    if (!view || view.webContents.isDestroyed()) return;
    try {
        var isLoginPage = await view.webContents.executeJavaScript('(function() { ' + (
            name === 'DeepSeek'
                // DeepSeek：URL 跳转到 /sign_in 即为未登录
                ? "return window.location.href.indexOf('/sign_in') !== -1;"
                // Qwen：查找含"登录"文字的按钮
                : "var btns = document.querySelectorAll('button'); for (var i = 0; i < btns.length; i++) { if (btns[i].textContent.trim() === '登录') return true; } return false;"
        ) + ' })()');
        if (isLoginPage) {
            dialog.showMessageBox(mainWindow, {
                type: 'warning',
                title: '需要登录',
                message: name + ' 未登录，请先登录后再使用相关功能。',
                detail: name === 'DeepSeek' ? '页面已跳转到登录页，请在浏览器中完成登录。' : '检测到"登录"按钮，请先完成登录。',
                buttons: ['知道了'],
                defaultId: 0
            });
        }
    } catch (e) {}
}

function createWindow() {
    // 设置 IPC 处理
    setupIpcHandlers();

    // 创建菜单
    createMenu();

    // 创建浏览器窗口（无原生标题栏/菜单栏）
    // 隐藏原生菜单
    Menu.setApplicationMenu(null);
    mainWindow = new BrowserWindow({
        width: CONFIG.WINDOW_WIDTH,
        height: CONFIG.WINDOW_HEIGHT,
        minWidth: 320,
        minHeight: 200,
        show: false, // 先不显示，等初始化完成后根据模式决定 show 或 showInactive
        title: 'DeepSeek Local Agent',
        frame: false,
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            preload: path.join(__dirname, 'preload.js'),
            devTools: true
        }
    });

    // ── 简约 UI 模式（CLI 唤起，仅显示 DeepSeek+Qwen，无 agentView/shellView） ──
    var isMinimalUI = !!process.env.DSA_MINIMAL_UI;
    if (isMinimalUI) {
        // 小尺寸窗口，不遮挡 CLI 终端
        var MIN_W = 480, MIN_H = 360;
        mainWindow.setSize(MIN_W, MIN_H);
        mainWindow.center();
        // showInactive 显示窗口但不抢夺焦点，终端 CLI 保持在前
        mainWindow.showInactive();

        // 创建 DeepSeek 网页视图（左侧）
        deepseekView = new BrowserView({
            webPreferences: {
                nodeIntegration: false,
                contextIsolation: true,
                preload: path.join(__dirname, 'preload.js')
            }
        });
        mainWindow.addBrowserView(deepseekView);
        deepseekView.setBounds({ x: 0, y: 0, width: Math.round(MIN_W / 2), height: MIN_H });
        deepseekView.webContents.loadURL(DEEPSEEK_URL);
        deepseekView.webContents.setBackgroundThrottling(false);

        // 创建 Qwen 视图（右侧）
        qwenView = new BrowserView({
            webPreferences: {
                nodeIntegration: false,
                contextIsolation: false,
                preload: null,
                webSecurity: false,
                sandbox: false
            }
        });
        mainWindow.addBrowserView(qwenView);
        qwenView.setBounds({ x: Math.round(MIN_W / 2), y: 0, width: Math.round(MIN_W / 2), height: MIN_H });
        qwenView.webContents.loadURL(QWEN_URL);
        qwenView.webContents.setBackgroundThrottling(false);

        // 监听窗口大小变化，保持两栏平分
        mainWindow.on('resize', function() {
            if (!mainWindow || mainWindow.isDestroyed()) return;
            var size = mainWindow.getContentBounds();
            var halfW = Math.round(size.width / 2);
            try { deepseekView.setBounds({ x: 0, y: 0, width: halfW, height: size.height }); } catch(e) {}
            try { qwenView.setBounds({ x: halfW, y: 0, width: size.width - halfW, height: size.height }); } catch(e) {}
        });

        // ── 简约模式仍需注入脚本才能响应 API 请求 ──
        setupSession();

        deepseekView.webContents.on('console-message', (event, level, message) => {
            if (message.indexOf('[DS') === 0) { console.log('[DeepSeek:renderer]', message); }
        });
        deepseekView.webContents.on('did-finish-load', () => {
            deepseekView.webContents.setBackgroundThrottling(false);
            const injectScript = getDeepseekInjectScript();
            deepseekView.webContents.executeJavaScript(injectScript).catch(console.error);
            setPageTheme(deepseekView, currentAppTheme);
            setTimeout(() => checkLoginRequired(deepseekView, 'DeepSeek'), 3000);
        });
        deepseekView.webContents.on('did-navigate', (event, url, httpCode, httpStatus) => {
            console.log('[DeepSeek] Navigated:', url, 'Code:', httpCode, httpStatus);
            if (url.indexOf('/chat') === -1 && url.indexOf('chat.deepseek.com') >= 0) {
                console.log('[DeepSeek] 检测到非对话页面，自动跳转回主页...');
                setTimeout(() => {
                    if (deepseekView && deepseekView.webContents && !deepseekView.webContents.isDestroyed()) {
                        try { mainWindow.removeBrowserView(deepseekView); } catch(e) {}
                        deepseekView.webContents.loadURL(DEEPSEEK_URL);
                        setTimeout(() => {
                            try {
                                mainWindow.addBrowserView(deepseekView);
                                var ob = deepseekView.getBounds();
                                if (ob.x > -1000) { deepseekView.setBounds({ x: -10000, y: ob.y, width: ob.width, height: ob.height }); }
                            } catch(e) {}
                        }, 2000);
                    }
                }, 1000);
            }
        });

        qwenView.webContents.on('console-message', (event, level, message) => {
            if (message.indexOf('[Qwen') !== -1) {
                console.log('[Qwen:renderer]', message);
            } else if (level === 3) {
                if (message.indexOf('Unauthorized') !== -1 || message.indexOf('Failed to load') !== -1
                    || message.indexOf('timeout') !== -1 || message.indexOf('crash') !== -1) {
                    console.error('[Qwen]', message);
                }
            }
        });
        qwenView.webContents.on('did-finish-load', () => {
            console.log('[Qwen] Page loaded, URL:', qwenView.webContents.getURL());
            qwenView.webContents.setBackgroundThrottling(false);
            const qwenScript = getQwenInjectScript();
            qwenView.webContents.executeJavaScript(qwenScript).catch(() => {});
            setPageTheme(qwenView, currentAppTheme);
            setTimeout(() => checkLoginRequired(qwenView, 'Qwen'), 3000);
        });

        mainWindow.show();
        return; // 跳过完整 UI 创建（简约模式不创建 agentView/shellView）
    }
    // 启动时缩小窗口居中（类似 Office 开场动画），启动完成后恢复
    // 使用 did-finish-load 事件确保 DevTools 在页面就绪后打开
    mainWindow.webContents.once('did-finish-load', function() {
        mainWindow.webContents.openDevTools();
    });
    var winBounds = mainWindow.getBounds();
    var startupWidth = Math.min(520, winBounds.width);
    var startupHeight = Math.min(360, winBounds.height);
    mainWindow.setBounds({
        x: winBounds.x + Math.round((winBounds.width - startupWidth) / 2),
        y: winBounds.y + Math.round((winBounds.height - startupHeight) / 2),
        width: startupWidth, height: startupHeight
    });

    // 创建浏览器窗口

    // 创建浏览器窗口

    // 先创建 shell 视图（底层，内联 viewbar/controlbar/filebrowser 的单页面）
    // 必须在 deepseekView/qwenView/agentView 之前添加，确保在 z-order 最底层
    shellView = new BrowserView({
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false,
            preload: null
        }
    });
    const shellPath = path.join(__dirname, 'shell.html');
    shellView.webContents.loadFile(shellPath);
    // 启动时 shell 先置于屏幕外，等 startup 完成后才显示（必须在 addBrowserView 之前）
    shellView.setBounds({ x: -10000, y: 0, width: 100, height: 100 });
    mainWindow.addBrowserView(shellView);
    // shell 加载完成后发送初始状态
    shellView.webContents.on('did-finish-load', function() {
        shellSend('ctrl-viewbar-status', {
            currentView: currentView,
            dsState: 'idle',
            qwenState: 'idle',
            confirmMode: getConfirmMode(),
            theme: currentAppTheme
        });
        shellSend('ctrl-status', { currentView: currentView });
        injectThemeVars(shellView, currentAppTheme);
        // 如果已有打开的文件夹，重新发送给 shell
        if (currentRootDir) {
            shellSend('root-changed', currentRootDir);
        }
        setTimeout(syncSkillsCount, 300);
    });

    // 创建 DeepSeek 网页视图（左侧）
    deepseekView = new BrowserView({
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            preload: path.join(__dirname, 'preload.js')
        }
    });
    mainWindow.addBrowserView(deepseekView);
    // 禁止后台节流，保证 deepseekView 即使不可见时 JS 依然全速运行
    deepseekView.webContents.setBackgroundThrottling(false);
    // 控制台日志
    deepseekView.webContents.on('console-message', (event, level, message) => {
        if (message.indexOf('deprecated') !== -1 || message.indexOf('favicon') !== -1) return;
        if (message.indexOf('[DS') !== -1) {
            console.log('[DeepSeek:renderer]', message);
        } else if (level === 3) {
            if (message.indexOf('Unauthorized') !== -1 || message.indexOf('Failed to load') !== -1
                || message.indexOf('timeout') !== -1 || message.indexOf('crash') !== -1) {
                console.error('[DeepSeek]', message);
            }
        }
    });
    deepseekView.webContents.on('render-process-gone', (event, details) => {
        console.error('[DeepSeek] Renderer gone:', details.reason);
    });
    deepseekView.webContents.on('unresponsive', () => {
        console.error('[DeepSeek] Page unresponsive');
    });

    // 创建 Qwen 网页视图（DeepSeek 加载完成后再加载，避免同时加载抢占资源）
    var qwenLoadingTimer = null;
    function createQwenView() {
        if (qwenView) return;
        qwenView = new BrowserView({
            webPreferences: {
                nodeIntegration: false,
                contextIsolation: false,
                preload: null,
                webSecurity: false,
                sandbox: false
            }
        });
        qwenView.webContents.loadURL(QWEN_URL);
        // 禁止后台节流，保证 qwenView 即使不可见时 JS 依然全速运行
        qwenView.webContents.setBackgroundThrottling(false);
        // 控制台日志
        qwenView.webContents.on('console-message', (event, level, message) => {
            if (message.indexOf('deprecated') !== -1 || message.indexOf('favicon') !== -1) return;
            if (message.indexOf('[Qwen') !== -1) {
                // [Qwen Copy] 等调试日志输出到主进程控制台
                console.log('[Qwen:renderer]', message);
            } else if (level === 3) {
                if (message.indexOf('Unauthorized') !== -1 || message.indexOf('Failed to load') !== -1
                    || message.indexOf('timeout') !== -1 || message.indexOf('crash') !== -1) {
                    console.error('[Qwen]', message);
                }
            }
        });
        qwenView.webContents.on('render-process-gone', (event, details) => {
            console.error('[Qwen] Renderer gone: reason=' + details.reason + ' exitCode=' + details.exitCode + ' URL=' + qwenView.webContents.getURL());
            // 兜底恢复：延迟 reload，防抖避免崩溃循环
            // 用 reload() 而非 loadURL(QWEN_URL)，保持当前对话 URL（如 /chat/xxx），避免被打回首页
            if (qwenLoadingTimer) clearTimeout(qwenLoadingTimer);
            qwenLoadingTimer = setTimeout(() => {
                if (qwenView && qwenView.webContents && !qwenView.webContents.isDestroyed()) {
                    console.log('[Qwen] Reloading after crash, URL:', qwenView.webContents.getURL());
                    try { qwenView.webContents.reload(); } catch (e) { console.error('[Qwen] reload failed:', e); }
                }
            }, 2000);
        });
        qwenView.webContents.on('unresponsive', () => {
            console.error('[Qwen] Page unresponsive');
        });
        qwenView.webContents.on('did-finish-load', () => {
            console.log('[Qwen] Page loaded, URL:', qwenView.webContents.getURL());
            // 每次加载完成后重新禁用后台节流
            qwenView.webContents.setBackgroundThrottling(false);
            // 单次注入+catch（不重试，避免 SPA 导航期间反复 executeJavaScript 戳帧触发崩溃）
            // SPA 内部导航 inject 还在，注入失败也无妨；真全 reload 时下次 did-finish-load 会再注入
            const qwenScript = getQwenInjectScript();
            qwenView.webContents.executeJavaScript(qwenScript).catch(() => {});
            // 页面加载后立即应用当前主题滤镜
            setPageTheme(qwenView, currentAppTheme);
            // 检测是否需要登录
            setTimeout(() => checkLoginRequired(qwenView, 'Qwen'), 3000);
        });
        qwenView.webContents.on('did-navigate', (event, url, code, status) => {
            console.log('[Qwen] Navigated:', url, 'Code:', code, status);
        });
        qwenView.webContents.on('did-fail-load', (event, code, desc, url) => {
            console.error('[Qwen] Load failed:', code, desc, url);
            if (qwenLoadingTimer) clearTimeout(qwenLoadingTimer);
            qwenLoadingTimer = setTimeout(() => {
                if (qwenView && qwenView.webContents && !qwenView.webContents.isDestroyed()) {
                    qwenView.webContents.loadURL(QWEN_URL);
                }
            }, 2000);
        });
        // 立即加入 Qwen 视图到主窗口，置于屏幕外保持 JS 全速运行
        mainWindow.addBrowserView(qwenView);
        // 初始尺寸保持正常窗口大小，避免 1x1 导致 Chromium 丢弃帧缓冲；updateBounds 会立即修正精确坐标
        qwenView.setBounds({ x: -10000, y: 0, width: 1280, height: 720 });
    }

    // 创建 Agent 视图（默认隐藏）
    agentView = new BrowserView({
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            preload: path.join(__dirname, 'preload-agent.js')
        }
    });
    const agentViewPath = path.join(__dirname, 'agentview.html');
    agentView.webContents.loadFile(agentViewPath);
    agentView.webContents.on('did-finish-load', function() {
        // 延迟同步，让 viewBar 先完成其初始化
        setTimeout(syncSkillsCount, 800);
    });
    agentView.webContents.on('render-process-gone', (event, details) => {
        console.error('[Agent] Renderer gone:', details.reason);
        // 渲染进程崩溃/被杀时自动重载，避免白屏卡死
        try { agentView.webContents.reload(); } catch (e) {}
    });
    agentView.webContents.on('unresponsive', () => {
        console.error('[Agent] Page unresponsive');
    });

    // 立即加入 Agent 视图到主窗口，置于屏幕外保持 JS 全速运行
    mainWindow.addBrowserView(agentView);
    agentView.webContents.setBackgroundThrottling(false);
    // 设置透明背景，让 deepseek/qwen 从背后透出
    agentView.setBackgroundColor('#00000000');
    // 初始尺寸保持正常窗口大小，避免 1x1 导致 Chromium 丢弃帧缓冲；updateBounds 会立即修正精确坐标
    agentView.setBounds({ x: -10000, y: 0, width: 1280, height: 720 });

    // 设置布局
    mainWindow.on('resize', updateBounds);

    // ========== 启动流程：Agent 透明，DeepSeek/Qwen 在背后可见 ==========
    agentViewVisible = true;
    qwenVisible = false;
    // DeepSeek 填满整个窗口（包括标题栏区域，shell 未显示前避免白条）
    var startupContent = { x: 0, y: 0, width: startupWidth, height: startupHeight };
    deepseekView.setBounds(startupContent);
    agentView.setBounds({ x: 0, y: 0, width: startupWidth, height: startupHeight });
    // 确保 agentView 在最上层
    try { mainWindow.setTopBrowserView(agentView); } catch(e) {}

    // 加载 DeepSeek 网页
    setupSession();
    deepseekView.webContents.loadURL(DEEPSEEK_URL);

    // 等待页面加载完成后注入脚本
    deepseekView.webContents.on('did-finish-load', () => {
        // 每次加载完成后重新禁用后台节流
        deepseekView.webContents.setBackgroundThrottling(false);
        // 立即注入，不再等待固定延迟（脚本内部自行判断 DOM 就绪）
        const injectScript = getDeepseekInjectScript();
        deepseekView.webContents.executeJavaScript(injectScript).catch(console.error);
        // 页面加载后立即应用当前主题滤镜
        setPageTheme(deepseekView, currentAppTheme);
        // 检测是否需要登录
        setTimeout(() => checkLoginRequired(deepseekView, 'DeepSeek'), 3000);
        // 页面重载后从持久化配置恢复审核模式，并同步到 viewbar
        setTimeout(() => {
            var mode = getConfirmMode();
            if (deepseekView && deepseekView.webContents && !deepseekView.webContents.isDestroyed()) {
                deepseekView.webContents.executeJavaScript(
                    `window.__dsagent_setConfirmMode && window.__dsagent_setConfirmMode(${JSON.stringify(mode)}, true);`
                ).catch(() => {});
            }
            shellSend('ctrl-viewbar-status', {
                    currentView: currentView,
                    dsState: 'idle',
                    qwenState: 'idle',
                    confirmMode: mode,
                    theme: currentAppTheme
                });
        }, 800);

        // ========== 顺序加载：DeepSeek 2s → Qwen 2s → 启动完成 ==========
        if (global.__ds_startup_done) return;
        global.__ds_startup_done = true;

        console.log('[Main] DeepSeek loaded, background init...');
        var startupContent = { x: 0, y: 0, width: startupWidth, height: startupHeight };
        function sendSplashProgress(msg, pct) {
            if (agentView && agentView.webContents && !agentView.webContents.isDestroyed()) {
                agentView.webContents.send('splash-progress', { text: msg, percent: pct });
            }
        }
        sendSplashProgress('DeepSeek 已就绪', 20);

        // DeepSeek 在背后可见 2s
        setTimeout(() => {
            // DeepSeek 加载完毕，移出屏幕
            deepseekView.setBounds({ x: -10000, y: 38, width: 800, height: 600 });
            sendSplashProgress('正在加载 Qwen...', 50);
            console.log('[Main] Loading Qwen...');

            // 创建 Qwen 并填满窗口，透过透明 agentView 可见
            if (!qwenView) createQwenView();
            if (qwenView) {
                qwenView.setBounds(startupContent);
                try { mainWindow.setTopBrowserView(agentView); } catch(e) {}
            }

            // Qwen 在背后可见 2s
            setTimeout(() => {
                sendSplashProgress('启动完成', 100);
                if (qwenView) {
                    qwenView.setBounds({ x: -10000, y: 0, width: 1280, height: 720 });
                }
                _startupComplete = true;
                if (shellView) {
                    var winSize = mainWindow ? mainWindow.getContentBounds() : { width: 800, height: 600 };
                    shellView.setBounds({ x: 0, y: 0, width: winSize.width, height: winSize.height });
                }
                // 恢复窗口到正常大小（居中）
                if (mainWindow && !mainWindow.isDestroyed()) {
                    var disp = require('electron').screen.getPrimaryDisplay().workAreaSize;
                    var targetW = Math.min(CONFIG.WINDOW_WIDTH, disp.width);
                    var targetH = Math.min(CONFIG.WINDOW_HEIGHT, disp.height);
                    mainWindow.setBounds({
                        width: targetW, height: targetH,
                        x: Math.round((disp.width - targetW) / 2),
                        y: Math.round((disp.height - targetH) / 2)
                    });
                    setTimeout(updateBounds, 100);
                }
                setTimeout(() => {
                    if (agentView && agentView.webContents && !agentView.webContents.isDestroyed()) {
                        agentView.webContents.send('splash-complete');
                    }
                }, 300);
            }, 2000);
        }, 2000);
    });

    // DeepSeek 导航事件：检测 VPN 切换导致的会话丢失，自动恢复
    deepseekView.webContents.on('did-navigate', (event, url, httpCode, httpStatus) => {
        console.log('[DeepSeek] Navigated:', url, 'Code:', httpCode, httpStatus);
        // 如果被重定向到非 chat 页面（如登录页、错误页），自动回到主页
        if (url.indexOf('/chat') === -1 && url.indexOf('chat.deepseek.com') >= 0) {
            console.log('[DeepSeek] 检测到非对话页面，自动跳转回主页...');
            setTimeout(() => {
                if (deepseekView && deepseekView.webContents && !deepseekView.webContents.isDestroyed()) {
                    // 先移出窗口防止 loadURL 触发闪现
                    try { mainWindow.removeBrowserView(deepseekView); } catch(e) {}
                    deepseekView.webContents.loadURL(DEEPSEEK_URL);
                    // did-finish-load 会重新注入脚本，这里延迟后重新加入
                    setTimeout(() => {
                        try {
                            mainWindow.addBrowserView(deepseekView);
                            var ob = deepseekView.getBounds();
                            if (ob.x > -1000) {
                                deepseekView.setBounds({ x: -10000, y: ob.y, width: ob.width, height: ob.height });
                            }
                            if (agentView && agentViewVisible && !agentView.webContents.isDestroyed()) {
                                mainWindow.setTopBrowserView(agentView);
                            }
                        } catch(e) {}
                    }, 800);
                }
            }, 2000);
        }
    });
    deepseekView.webContents.on('did-fail-load', (event, code, desc, url) => {
        console.error('[DeepSeek] Load failed:', code, desc, url);
    });

    // 轮询状态处理：跟随模式自动切换视图 + 转发状态到控制栏/视图栏/主题
    function handlePollStatus(status) {
        // 跟随模式：自动切换到当前活跃的视图
        if (currentView === 'follow') {
            var dsGenerating = status.buttonState === 'generating';
            var qwenGenerating = status.qwenState === 'generating';
            if (qwenGenerating) {
                if (!qwenVisible || agentViewVisible) {
                    agentViewVisible = false;
                    qwenVisible = true;
                    updateBounds();
                }
            } else if (dsGenerating) {
                if (qwenVisible || agentViewVisible) {
                    agentViewVisible = false;
                    qwenVisible = false;
                    updateBounds();
                }
            } else if (!agentViewVisible) {
                agentViewVisible = true;
                qwenVisible = false;
                updateBounds();
            }
        }

        // 转发到控制栏和视图选择栏
        shellSend('ctrl-status', status);
        shellSend('ctrl-viewbar-status', {
            currentView: currentView,
            dsState: status.buttonState || 'idle',
            qwenState: status.qwenState || 'idle',
            confirmMode: status.confirmMode || 'smart',
            theme: currentAppTheme,
            dsConcurrent: status.concurrentMode || false
        });

        // 转发主题到文件浏览器、Agent 视图和视图选择栏
        shellSend('fb-theme', currentAppTheme);
        shellSend('ctrl-theme', currentAppTheme);
        if (agentView && agentView.webContents && !agentView.webContents.isDestroyed()) {
            agentView.webContents.send('agent-theme', currentAppTheme);
        }
    }

    // 定期从 DeepSeek 页面获取状态并同步到控制栏
    // 对齐历史 2a87afe 实现：裸 executeJavaScript + .then().catch()，不用 safeExecJs 包裹
    // （safeExecJs 内部对 disposed 错误有 300ms 重试，帧过渡期会多戳一次，是崩溃隐患）
    setInterval(() => {
        if (deepseekView && shellView && !deepseekView.webContents.isDestroyed() && !deepseekView.webContents.isLoading()) {
            deepseekView.webContents.executeJavaScript(
                'window.__dsagent_getStatus && window.__dsagent_getStatus()'
            ).then(status => {
                if (status && shellView) {
                    status.qwenVisible = qwenVisible;
                    status.currentView = currentView;

                    // 读 Qwen 生成状态缓存（server-qwen.js 由 sendMessage/waitForDone 更新，
                    // 不调用 executeJavaScript，避免 SPA 导航期间戳 disposed 帧产生 "Render frame was disposed" 报错）
                    status.qwenState = qwenServer && typeof qwenServer.getQwenGenerating === 'function'
                        ? (qwenServer.getQwenGenerating() ? 'generating' : 'idle')
                        : 'idle';
                    handlePollStatus(status);
                }
            }).catch(() => {});
        }
    }, 300);

    // 定时对当前可见的 Agent 视图强制重绘，防止其在最前端时因 GPU/合成器丢帧变白屏
    // 不接 Qwen 视图：Qwen SPA 导航（如点击历史对话切 URL）期间 setBounds 会触发 Chromium GPU
    // 合成器崩溃 → 渲染进程 crash（[Qwen] Renderer gone: crashed）
    setInterval(() => {
        if (agentViewVisible && agentView && !agentView.webContents.isDestroyed()) {
            forceRepaint(agentView);
        }
    }, 3000);

    mainWindow.on('closed', () => {
        mainWindow = null;
    });

    // Agent 模式焦点保护：防止后台 BrowserView 劫持键盘焦点
    mainWindow.on('focus', () => {
        if (agentViewVisible && agentView && !agentView.webContents.isDestroyed()) {
            // 延迟一帧，确保 focus 事件链完成后再抢回焦点
            setTimeout(() => {
                if (agentViewVisible && agentView && !agentView.webContents.isDestroyed()) {
                    agentView.webContents.focus();
                }
            }, 0);
        }
    });

    // ==================== 恢复上次工作状态 ====================
    restoreAppState();

    // 确保窗口可见（CLI 启动无窗口时保证显示）
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.show();
        mainWindow.focus();
    }
}

function restoreAppState() {
    const state = loadAppState();
    if (!state) return;

    // 恢复主题
    if (state.theme && THEME_PRESETS.hasOwnProperty(state.theme)) {
        currentAppTheme = state.theme;
        // 延迟广播给所有视图，等待视图加载完成
        setTimeout(() => {
            broadcastTheme(currentAppTheme);
        }, 1000);
    }

    // 恢复文件夹（同步设置 currentRootDir，确保 agentView 首次 loadHistoryList 时能读到正确目录）
    if (state.lastRootDir && fs.existsSync(state.lastRootDir)) {
        // 同步设置目录，不延迟，确保后续历史加载使用正确路径
        currentRootDir = state.lastRootDir;
        agent.setBaseDir(state.lastRootDir);
        shellSend('root-changed', state.lastRootDir);
        saveRecentProject(state.lastRootDir);
        rebuildMenu();
        // 通知 filebrowser 加载该目录（异步，不影响历史加载）
        setTimeout(() => {
            // 启动恢复时保留当前对话，由后续历史恢复逻辑接管
            openFolder(state.lastRootDir, { skipCloseConversation: true });
        }, 500);
    }

    // 恢复模式 & 历史对话
    if (state.lastMode === 'agent') {
        // 等待 agentView 加载完成后切换
        currentView = 'agent';  // 同步视图选择器状态
        const tryRestoreAgent = () => {
            if (!agentView || agentView.webContents.isDestroyed()) return;
            // 切换到 Agent 视图
            agentViewVisible = true;
            if (qwenView && qwenVisible) {
                mainWindow.removeBrowserView(qwenView);
            }
            mainWindow.addBrowserView(agentView);
            updateBounds();
            shellSend('ctrl-agent-state', true);
            // 恢复历史对话
            if (state.lastHistoryId) {
                setTimeout(() => {
                    if (agentView && !agentView.webContents.isDestroyed()) {
                        agentView.webContents.send('restore-history-conversation', state.lastHistoryId);
                    }
                }, 800);
            }
        };
        // 等 agentView 页面加载完成
        if (agentView && agentView.webContents && !agentView.webContents.isLoading()) {
            tryRestoreAgent();
        } else if (agentView) {
            agentView.webContents.once('did-finish-load', tryRestoreAgent);
        }
    }
}

// ==================== 应用生命周期 ====================
// 单实例锁：防止多个进程同时运行导致 IndexedDB 锁冲突和登录丢失
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
    app.quit();
} else {
    app.on('second-instance', () => {
        if (mainWindow) {
            if (mainWindow.isMinimized()) mainWindow.restore();
            mainWindow.focus();
        }
    });
}

app.whenReady().then(() => {
    createWindow();

    // ── 初始化机器人插件宿主（QQ / 微信 / 飞书） ──
    // 各插件在 plugins/*/index.js，通过 ctx 访问宿主上下文，自行注册 IPC。
    const { powerSaveBlocker } = require('electron');
    const pluginCtx = {
        ipcMain, path, fs, os, app, exec,
        powerSaveBlocker, desktopCapturer, nativeImage,
        loadAppState, saveAppState,
        getAgentView:        () => agentView,
        getDeepseekView:     () => deepseekView,
        getQwenView:         () => qwenView,
        getMainWindow:       () => mainWindow,
        getAgentViewVisible: () => agentViewVisible,
        getQwenVisible:      () => qwenVisible,
        getCurrentView:      () => currentView,
        getCurrentAppTheme:  () => currentAppTheme,
        getCurrentRootDir:   () => currentRootDir,
        shellSend,
        stopAll,
        agent,                       // { loadConfig(), saveConfig(cfg), ... }
        historyManager,              // { listHistories(dir), loadHistory(dir, id) }
        VIEWBAR_WIDTH, SIDEBAR_WIDTH, CTRL_BAR_HEIGHT
    };
    try {
        const loaded = pluginHost.init(pluginCtx);
        // 拿到 QQ 插件导出，供宿主做计划同步、退出等零散调用
        botQQ = loaded && loaded.length ? require('./plugins/bot-qq/index.js') : null;
        console.log('[Plugins] 已加载:', loaded.map(m => m.id).join(', '));
    } catch (e) {
        console.error('[Plugins] 宿主初始化失败:', e.message);
    }

    // ── 初始化 MCP 服务器 ──
    setTimeout(() => {
        agent.initMcp().then(function(result) {
            if (result.success && result.tools && result.tools.length > 0) {
                console.log('[MCP] Initialized with', result.tools.length, 'tools');
            }
        }).catch(function(e) {
            console.log('[MCP] Init error:', e.message);
        });
    }, 3000); // 延迟 3 秒等窗口加载完成

    // ── 启动 HTTP API 服务器（供 dsagent-cli 调用） ──
    startContentServer();

    // ── 检查 npm 版本更新 ──
    // 通过 npm registry 检查最新版本，支持国内镜像
    checkNpmUpdate().catch(() => {});
});

// 检查 npm 包更新（静默，失败不影响启动）
function checkNpmUpdate() {
    return new Promise(function(resolve) {
        var https = require('https');
        // 尝试多个 registry（支持国内镜像）
        var registries = [
            'https://registry.npmmirror.com/dsagent-electron',
            'https://registry.npmjs.org/dsagent-electron'
        ];
        var tried = 0;
        function tryRegistry(url) {
            https.get(url, function(res) {
                var body = '';
                res.on('data', function(chunk) { body += chunk; });
                res.on('end', function() {
                    try {
                        var data = JSON.parse(body);
                        var latest = data['dist-tags'] && data['dist-tags'].latest;
                        var current = require('./package.json').version;
                        if (latest && latest !== current) {
                            console.log('[Update] 新版本可用: v' + latest + ' (当前 v' + current + ')');
                            if (mainWindow) {
                                dialog.showMessageBox(mainWindow, {
                                    type: 'info',
                                    title: '发现新版本',
                                    message: '新版本 v' + latest + ' 可用（当前 v' + current + '）\n\n运行 npm update -g dsagent-electron 更新',
                                    buttons: ['知道了']
                                });
                            }
                        }
                    } catch(e) {}
                    resolve();
                });
            }).on('error', function() {
                tried++;
                if (tried < registries.length) {
                    tryRegistry(registries[tried]);
                } else {
                    resolve();
                }
            });
        }
        tryRegistry(registries[0]);
    });
}

// ==================== CLI HTTP Server（本地 API，供 dsagent-cli 调用） ====================
var apiServer = null;
var API_TOKEN = '';  // 启动时生成随机 token

function startContentServer() {
    const http = require('http');
    // 生成随机 token（16 位十六进制）
    API_TOKEN = Array.from({ length: 16 }, () => Math.floor(Math.random() * 16).toString(16)).join('');
    console.log('[API] Token: ' + API_TOKEN);

    apiServer = http.createServer(function(req, res) {
        // CORS 不需要，仅本地回环
        if (req.method === 'GET' && req.url === '/api/ping') {
            res.writeHead(200);
            res.end(JSON.stringify({ ok: true }));
        } else if (req.method === 'GET' && req.url === '/api/models') {
            // 返回可用模型列表
            var modelsList = [];
            if (modelRegistry) {
                var allModels = modelRegistry.listModels();
                for (var mid in allModels) {
                    var m = allModels[mid];
                    modelsList.push({
                        id: m.id || mid,
                        provider: m.provider || '',
                        displayName: m.displayName || m.id || mid
                    });
                }
            }
            res.writeHead(200);
            res.end(JSON.stringify({ success: true, data: modelsList }));
        } else if (req.method === 'POST' && req.url === '/api/change-dir') {
            // CLI /cd：更新 daemon 侧 cwd，不 kill 会话
            var cdBody = '';
            req.on('data', function(chunk) { cdBody += chunk; });
            req.on('end', function() {
                try {
                    var cdPayload = JSON.parse(cdBody);
                    if (cdPayload.token !== API_TOKEN) {
                        res.writeHead(403);
                        res.end(JSON.stringify({ success: false, error: 'Invalid token' }));
                        return;
                    }
                    agent.setCwd(cdPayload.path);
                    console.log('[API] CWD changed to:', cdPayload.path);
                    res.writeHead(200);
                    res.end(JSON.stringify({ success: true }));
                } catch (e) {
                    res.writeHead(400);
                    res.end(JSON.stringify({ success: false, error: e.message }));
                }
            });
        } else if (req.method === 'GET' && req.url.startsWith('/api/bg-result/')) {
            // P0: 后台任务状态轮询（/bg list 时 CLI 拉取每个任务的当前状态）
            var bgTaskId = decodeURIComponent(req.url.substring('/api/bg-result/'.length));
            var bgRes = bgTaskResults[bgTaskId] || null;
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, data: bgRes }));
        } else if (req.method === 'GET' && req.url === '/api/bg-list') {
            // P0: 后台任务列表（/bg list 时拉取全部）
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, data: Object.values(bgTaskResults) }));
        } else if (req.method === 'POST' && req.url === '/api/request') {
            var body = '';
            req.on('data', function(chunk) { body += chunk; });
            req.on('end', async function() {
                try {
                    var payload = JSON.parse(body);
                    // token 验证
                    if (payload.token !== API_TOKEN) {
                        res.writeHead(403);
                        res.end(JSON.stringify({ success: false, error: 'Invalid token' }));
                        return;
                    }
                    if (!orchestrator) {
                        res.writeHead(503);
                        res.end(JSON.stringify({ success: false, error: 'Orchestrator not ready' }));
                        return;
                    }

                    // ===== P0: 后台任务（/bg） — 异步 fire-and-forget =====
                    if (payload.bg) {
                        var bgTaskId = payload.agentId || ('bg-' + Date.now());
                        bgTaskResults[bgTaskId] = { status: 'running', taskId: bgTaskId, text: payload.message && payload.message.text || '', createdAt: new Date().toISOString() };
                        // 异步执行，不等完成
                        orchestrator.handleRequest(payload).then(function(bgRes) {
                            bgTaskResults[bgTaskId] = {
                                status: bgRes && bgRes.success ? 'done' : 'failed',
                                taskId: bgTaskId,
                                text: payload.message && payload.message.text || '',
                                createdAt: bgTaskResults[bgTaskId].createdAt,
                                completedAt: new Date().toISOString(),
                                result: bgRes && bgRes.data,
                                error: bgRes && !bgRes.success ? (bgRes.error || 'unknown') : null
                            };
                            console.log('[BG] Task ' + bgTaskId + ' completed: ' + bgTaskResults[bgTaskId].status);
                        }).catch(function(e) {
                            bgTaskResults[bgTaskId] = {
                                status: 'failed', taskId: bgTaskId, error: e.message,
                                text: payload.message && payload.message.text || '',
                                createdAt: bgTaskResults[bgTaskId].createdAt, completedAt: new Date().toISOString()
                            };
                            console.warn('[BG] Task ' + bgTaskId + ' error:', e.message);
                        });
                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ success: true, data: { bg: true, taskId: bgTaskId, status: 'running' } }));
                        return;
                    }
                    // 方案 A：DeepSeek CLI 同步模式（waitForComplete 默认 true，非 agentview 异步路径）
                    // 先注册 inject 推送 waiter，再调 orchestrator，避免 inject 推送早于 waiter 注册的时序错位
                    var isCliSyncDeepSeek = !(payload.waitForComplete === false);
                    var reqId = null;
                    var injectPushPromise = null;
                    if (isCliSyncDeepSeek) {
                        reqId = 'cli-' + (++_cliRequestIdCounter);
                        console.log('[API] Registering CLI waiter reqId=' + reqId + ' agentId=' + payload.agentId);
                        injectPushPromise = new Promise(function(resolve) {
                            var entry = { resolve: resolve, timer: null, collected: [] };
                            cliResultWaiters.set(reqId, entry);
                            entry.timer = setTimeout(function() {
                                if (cliResultWaiters.has(reqId)) {
                                    cliResultWaiters.delete(reqId);
                                    resolve({ timeout: true, segments: entry.collected });
                                }
                            }, 300000);
                        });
                    }

                    var result = await orchestrator.handleRequest(payload);
                    console.log('[API] handleRequest result:', JSON.stringify(result).substring(0, 300));

                    // 方案 A：DeepSeek CLI 同步模式 → 流式 NDJSON 响应
                    // 工具调用/tool-result/text 实时推送，CLI 端边收边渲染
                    if (result && result.success && result.data && result.data._awaitInjectPush && reqId) {
                        var waiter = cliResultWaiters.get(reqId);

                        // 写 HTTP 头：NDJSON 流（每行一个 JSON 对象）
                        res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });

                        // 设置流式回调：segments 到达即写
                        if (waiter) {
                            waiter.onStream = function(streamMsg) {
                                try {
                                    res.write(JSON.stringify(streamMsg) + '\n');
                                } catch(e) {}
                            };
                        }

                        // 等 inject 推送完成
                        var injectPush = await injectPushPromise;
                        if (waiter) { clearTimeout(waiter.timer); cliResultWaiters.delete(reqId); }

                        // 最终汇总：包含 think/images/context 等元数据
                        var pushedSegs = (injectPush && injectPush.segments) || [];
                        var thinkParts = [];
                        var pushedImages = [];
                        for (var si = 0; si < pushedSegs.length; si++) {
                            var sg = pushedSegs[si];
                            if (sg.type === 'think') thinkParts.push(sg.content || '');
                            else if (sg.type === 'image') pushedImages.push(sg.content || '');
                        }
                        var finalMsg = {
                            type: 'done',
                            think: thinkParts.join('\n').trim(),
                            images: pushedImages,
                            conversationUrl: result.data.conversationUrl,
                            modelId: result.data.modelId
                        };
                        res.write(JSON.stringify(finalMsg) + '\n');
                        res.end();
                    } else {
                        // 非流式路径（Qwen/API/错误）：一次性 JSON 响应
                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify(result));
                    }
                } catch (e) {
                    const errMsg = (e && (e.message || String(e))) || '未知错误: ' + JSON.stringify(e);
                    console.error('[API] request error:', errMsg);
                    res.writeHead(400);
                    res.end(JSON.stringify({ success: false, error: errMsg }));
                }
            });
        } else {
            res.writeHead(404);
            res.end(JSON.stringify({ error: 'Not found' }));
        }
    });

    apiServer.listen(5858, '127.0.0.1', function() {
        console.log('[API] Server listening on 127.0.0.1:5858');
        // 写入 token 文件供 CLI 读取
        try {
            var tokenDir = path.join(os.homedir(), '.dsa');
            if (!fs.existsSync(tokenDir)) fs.mkdirSync(tokenDir, { recursive: true });
            fs.writeFileSync(path.join(tokenDir, 'api-token.json'), JSON.stringify({
                token: API_TOKEN,
                port: 5858,
                host: '127.0.0.1',
                pid: process.pid
            }), 'utf-8');
        } catch(e) { /* 非关键 */ }
    });
}

// ===== P3: 崩溃日志（最小集，参考 atomcode install_panic_hook） =====
// 仅写本地文件 ~/.dsa/crash-<timestamp>.log，无网络上报
var CRASH_LOG_DIR = path.join(os.homedir(), '.dsa');
function writeCrashLog(type, err) {
    try {
        if (!fs.existsSync(CRASH_LOG_DIR)) fs.mkdirSync(CRASH_LOG_DIR, { recursive: true });
        var time = new Date().toISOString().replace(/[:]/g, '-');
        var fp = path.join(CRASH_LOG_DIR, 'crash-' + time + '.log');
        var stack = err && (err.stack || err.message || String(err)) || 'unknown error';
        var pkg = require('./package.json');
        fs.writeFileSync(fp,
            '=== Crash Report ===\n' +
            'Type: ' + type + '\n' +
            'Time: ' + new Date().toISOString() + '\n' +
            'Version: ' + pkg.version + '\n' +
            'Platform: ' + process.platform + ' ' + process.arch + '\n' +
            'Stack:\n' + stack + '\n'
        );
        console.error('[Crash] written to ' + fp);
    } catch(e) { /* 无法写文件时也尽力 */ }
}
// 注册全局异常处理
process.on('uncaughtException', function(err) {
    writeCrashLog('uncaughtException', err);
    console.error('[Crash] uncaughtException:', err && (err.stack || err.message));
    // 不 process.exit，让 Electron 默认行为处理
});
process.on('unhandledRejection', function(reason) {
    // 不写文件（太频繁），仅日志
    if (reason && reason.message && reason.message.indexOf('abort') >= 0) return; // 忽略取消操作的 rejection
    console.warn('[Crash] unhandledRejection:', reason && (reason.message || String(reason)));
});

app.on('before-quit', async () => {
    try { if (apiServer) apiServer.close(); } catch(e) {}
    try { await agent.shutdownMcp(); } catch (e) {
        console.log('[MCP] Shutdown error:', e.message);
    }
    // 关闭所有 localtunnel 隧道（QQ 插件托管）
    try {
        if (botQQ && typeof botQQ.shutdown === 'function') botQQ.shutdown();
    } catch (e) {}
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

app.on('activate', () => {
    if (mainWindow === null) {
        createWindow();
    }
});