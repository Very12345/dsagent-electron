﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿// DeepSeek Local Agent - Electron 主进程（双栏布局版）
const { app, BrowserWindow, BrowserView, Menu, dialog, session, ipcMain, shell, clipboard, nativeImage, desktopCapturer } = require('electron');
const path = require('path');
const agent = require('./server.js');
const historyManager = require('./history-manager.js');
const { autoUpdater } = require('electron-updater');
const fs = require('fs');
const os = require('os');
const { exec } = require('child_process');
const localtunnel = require('localtunnel');

// ==================== 配置 ====================
const CONFIG = {
    WINDOW_WIDTH: 1400,
    WINDOW_HEIGHT: 900,
};

const DEEPSEEK_URL = 'https://chat.deepseek.com/';

const VIEWBAR_WIDTH = 60;  // 左侧视图选择栏宽度
const SIDEBAR_WIDTH = 350;
const CTRL_BAR_HEIGHT = 40;
const QWEN_URL = 'https://www.qianwen.com/';
const QWEN_WIDTH = 500;

// 禁用 Chromium 后台节流和窗口遮挡检测，避免 Qwen/Agent 等隐藏视图白屏
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
app.commandLine.appendSwitch('disable-renderer-backgrounding');

let mainWindow = null;
let currentRootDir = null;  // null = 未打开文件夹

// QQ Bot 托管
const QQBotClient = require('./qqbot.js');
let qqBotInstance = null;
let qqBotPowerSaveId = null;
let qqBotAuthorizedUser = null;   // 校验通过的用户 openid
let qqBotVerifyCode = '';
let qqBotPendingMessages = [];     // 等待队列
let qqBotProcessing = false;       // 是否正在处理
let qqBotAwaitingConfirm = false;  // 是否正在等待用户确认
let deepseekView = null;
let qwenView = null;
let qwenVisible = false;    // Qwen 视图是否可见
let viewBarView = null;
let fileBrowserView = null;
let controlBarView = null;
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
    if (fileBrowserView) {
        fileBrowserView.webContents.send('root-changed', folderPath);
    }
    saveRecentProject(folderPath);
    saveAppState({ lastRootDir: folderPath });
    rebuildMenu();

    if (opts.skipCloseConversation) {
        // 启动恢复场景：不关闭当前对话，也不把 DeepSeek 切回首页
        return;
    }

    // 切换目录 → 强制关闭当前对话
    stopAll().then(function() {
        // 通知 Agent 视图清除当前对话
        if (agentView && agentView.webContents && !agentView.webContents.isDestroyed()) {
            agentView.webContents.send('agent-close-conversation');
        }
        // 导航 DeepSeek 回首页，结束当前会话
        if (deepseekView) {
            try {
                deepseekView.webContents.loadURL('about:blank');
                setTimeout(function() {
                    deepseekView.webContents.loadURL(DEEPSEEK_URL);
                }, 100);
            } catch(e) {
                console.warn('[OpenFolder] Navigate home failed:', e);
            }
        }
    });

    // 重新加载技能列表（不再推送到控制栏，由 agent 视图弹窗按需加载）
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
    // 3. 加载主注入脚本
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
    if (viewBarView && viewBarView.webContents && !viewBarView.webContents.isDestroyed()) {
        viewBarView.webContents.send('ctrl-skills-count', skills.length);
    }
}

function setupAgentIPC() {
    ipcMain.handle('agent-exec', async (event, cmd, timeoutMs) => {
        // 默认 30 秒超时，防止 start 等阻塞型命令卡死
        return await agent.execCmd(cmd, timeoutMs || 30000);
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

    // 获取技能完整内容（local-skill 命令）
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
                if (controlBarView) {
                    controlBarView.webContents.send('ctrl-notify', '已取消同步: ' + skillName);
                }
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

    // 计划管理
    ipcMain.handle('agent-plan-load', async () => {
        return agent.planLoad();
    });

    ipcMain.handle('agent-plan-save', async (event, plan) => {
        var result = agent.planSave(plan);
        // 同步计划到 QQ Bot
        if (qqBotInstance && qqBotAuthorizedUser && result.success && result.plan) {
            try {
                var p = result.plan;
                var doneCount = (p.steps || []).filter(function(s) { return s.status === 'done'; }).length;
                var planText = '📋 **' + p.title + '** (' + doneCount + '/' + (p.steps || []).length + ')\n\n';
                for (var si = 0; si < (p.steps || []).length; si++) {
                    var s = p.steps[si];
                    var icon = s.status === 'done' ? '✅' : s.status === 'in_progress' ? '🔄' : '⬜';
                    planText += icon + ' ' + s.id + '. ' + s.description;
                    if (s.result) planText += ' — ' + s.result;
                    planText += '\n';
                }
                await qqBotInstance.sendText(qqBotAuthorizedUser, planText);
            } catch (e) {
                console.warn('[QQBot] 计划同步失败:', e.message);
            }
        }
        // 通知 Agent 视图
        if (agentView && agentView.webContents && !agentView.webContents.isDestroyed() && result.success && result.plan) {
            agentView.webContents.send('agent-plan-update', result.plan);
        }
        return result;
    });

    ipcMain.handle('agent-plan-delete', async () => {
        return agent.planDelete();
    });

    // Agent 状态消息转发到 controlbar（统一任务状态栏）
    ipcMain.on('agent-status-to-controlbar', (event, data) => {
        if (controlBarView && controlBarView.webContents && !controlBarView.webContents.isDestroyed()) {
            controlBarView.webContents.send('ctrl-agent-status', data);
        }
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
        if (viewBarView && viewBarView.webContents && !viewBarView.webContents.isDestroyed()) {
            viewBarView.webContents.send('ctrl-viewbar-status', {
                currentView: currentView,
                dsState: 'idle',
                qwenState: 'idle',
                confirmMode: mode,
                theme: currentAppTheme
            });
        }
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
            if (controlBarView && controlBarView.webContents && !controlBarView.webContents.isDestroyed()) {
                controlBarView.webContents.send('ctrl-agent-state', agentViewVisible);
            }
        }
        var result = agent.loadSkills();
        syncSkillsCount();
        if (agentView && agentView.webContents && !agentView.webContents.isDestroyed()) {
            agentView.webContents.send('agent-show-skills', result.skills || []);
            agentView.webContents.send('agent-open-skills-modal');
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
        if (controlBarView) {
            controlBarView.webContents.send('ctrl-notify', result.success ? '已删除技能: ' + skillName : result.error);
        }
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
                if (controlBarView) {
                    controlBarView.webContents.send('ctrl-notify', '已导入技能: ' + importResult.name);
                }
            } else {
                if (controlBarView) {
                    controlBarView.webContents.send('ctrl-notify', '导入失败: ' + importResult.error);
                }
            }
            syncSkillsCount();
        } catch (err) {
            if (controlBarView) {
                controlBarView.webContents.send('ctrl-notify', '导入失败: ' + err.message);
            }
        }
    });

    // 主题切换（从左侧栏触发，广播到所有视图）
    ipcMain.on('ctrl-set-theme', (event, theme) => {
        broadcastTheme(theme === 'light' ? 'light' : 'dark');
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
        if (controlBarView) controlBarView.webContents.send('ctrl-qwen-state', qwenVisible);
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
        if (controlBarView && controlBarView.webContents) {
            controlBarView.webContents.send('ctrl-notify', '已停止');
        }
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
        if (controlBarView && controlBarView.webContents && !controlBarView.webContents.isDestroyed()) {
            controlBarView.webContents.send('ctrl-notify', msg);
        }
    });

    // Qwen 页面状态消息转发到 controlbar
    ipcMain.on('qwen-notify-status', (event, msg) => {
        if (controlBarView && controlBarView.webContents && !controlBarView.webContents.isDestroyed()) {
            controlBarView.webContents.send('ctrl-agent-status', { msg: msg, type: 'qwen' });
        }
    });

    // Agent 视图切换
    ipcMain.on('agent-view-toggle', () => {
        agentViewVisible = !agentViewVisible;
        saveAppState({ lastMode: agentViewVisible ? 'agent' : 'deepseek' });
        updateBounds();
        // 通知控制栏状态
        if (controlBarView && controlBarView.webContents && !controlBarView.webContents.isDestroyed()) {
            controlBarView.webContents.send('ctrl-agent-state', agentViewVisible);
        }
    });

    // Agent 发送消息：控制 DeepSeek 页面完成模式选择、深度思考、关闭联网、发送消息
    ipcMain.handle('agent-send-message', async (event, data) => {
        if (!deepseekView) return { success: false, error: 'DeepSeek view not ready' };
        try {
            // executeJavaScript 在后台也可正常工作，无需切换视图

            // 1. 设置模式（expert/quick）
            await deepseekView.webContents.executeJavaScript(
                'window.__dsagent_setModelMode && window.__dsagent_setModelMode(' + JSON.stringify(data.mode) + ')'
            );

            // 2. 设置深度思考
            await deepseekView.webContents.executeJavaScript(
                'window.__dsagent_setDeepThink && window.__dsagent_setDeepThink(' + (!!data.deepthink) + ')'
            );

            // 3. 确保关闭联网搜索
            await deepseekView.webContents.executeJavaScript(
                'window.__dsagent_disableWebSearch && window.__dsagent_disableWebSearch()'
            );

            // 等待设置生效
            await new Promise(r => setTimeout(r, 500));

            // 4. 发送消息（填充并点击发送按钮）
            await deepseekView.webContents.executeJavaScript(
                'window.__dsagent_sendMessage && window.__dsagent_sendMessage(' + JSON.stringify(data.text) + ')'
            );

            return { success: true };
        } catch (e) {
            return { success: false, error: e.message };
        }
    });

    // Agent 设置深度思考（实时同步到 DeepSeek）
    ipcMain.handle('agent-toggle-deepthink', async (event, enabled) => {
        if (!deepseekView) return { success: false };
        try {
            await deepseekView.webContents.executeJavaScript(
                'window.__dsagent_setDeepThink && window.__dsagent_setDeepThink(' + (!!enabled) + ')'
            );
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

    // Agent 启动新对话：创建新对话并发送初始化提示词
    ipcMain.handle('agent-start-new-chat', async (event, data) => {
        if (!deepseekView) return { success: false, error: 'DeepSeek view not ready' };
        try {
            // executeJavaScript 在后台也可正常工作，无需切换视图

            // 调用 inject.js 的新建对话+发送初始化流程
            await deepseekView.webContents.executeJavaScript(
                'window.__dsagent_newChatAndSendInit && window.__dsagent_newChatAndSendInit('
                + JSON.stringify(data.mode) + ', ' + (!!data.deepthink) + ')'
            );

            // 返回当前 DeepSeek 页面 URL
            var deepseekUrl = await deepseekView.webContents.executeJavaScript('window.location.href');

            return { success: true, deepseekUrl: deepseekUrl };
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

    // 恢复历史对话对应的 DeepSeek 会话（deepseekView 始终活跃，无需视觉切换）
    ipcMain.handle('history-restore-conversation', async (event, deepseekUrl) => {
        if (!deepseekView) return { success: false, error: 'DeepSeek view not ready', valid: false };
        try {
            // 从 URL 中提取会话标识（/chat/ 后面的部分）
            var origMatch = deepseekUrl.match(/\/chat\/([^?#]+)/);
            var origConvId = origMatch ? origMatch[1] : '';

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

            return { success: true, valid: isValid };
        } catch (e) {
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

    // ==================== QQ Bot 托管 IPC ====================

    // 生成校验码（4位数字）
    function generateVerifyCode() {
        return String(Math.floor(1000 + Math.random() * 9000));
    }

    // 转发消息到 agentView（从 QQ 收到的消息）
    function forwardQQMessageToAgent(data) {
        if (agentView && agentView.webContents && !agentView.webContents.isDestroyed()) {
            agentView.webContents.send('qqbot-message', data);
        }
    }

    // 启动 QQ Bot
    ipcMain.handle('qqbot-start', async (event, config) => {
        try {
            if (qqBotInstance) {
                qqBotInstance.removeAllListeners();
                qqBotInstance.ws && qqBotInstance.ws.close();
                qqBotInstance = null;
            }

            // 强制不熄屏
            if (qqBotPowerSaveId === null) {
                const { powerSaveBlocker } = require('electron');
                qqBotPowerSaveId = powerSaveBlocker.start('prevent-display-sleep');
                console.log('[QQBot] 已阻止屏幕休眠, id:', qqBotPowerSaveId);
            }

            qqBotInstance = new QQBotClient({
                appId: config.appId,
                clientSecret: config.clientSecret,
                gatewayUrl: config.gatewayUrl || 'wss://sandbox.api.sgroup.qq.com/websocket',
                intents: (1 << 1) | (1 << 25) | (1 << 26),
                apiBase: 'https://api.sgroup.qq.com',
                imagePath: config.imagePath || './1.png',
                tempDir: config.tempDir || path.join(currentRootDir || '.', '.dsa', 'temp')
            });

            // 生成校验码
            var savedState = loadAppState();
            if (savedState.qqBotSavedUser) {
                qqBotAuthorizedUser = savedState.qqBotSavedUser;
                qqBotVerifyCode = '';
                console.log('[QQBot] 已恢复保存的用户:', qqBotAuthorizedUser);
            } else {
                qqBotVerifyCode = generateVerifyCode();
                qqBotAuthorizedUser = null;
            }

            // 监听消息
            qqBotInstance.on('message', async (msg) => {
                console.log('[QQBot] 收到消息 from:', msg.openid, 'content:', msg.content);
                var text = (msg.content || '').trim();

                // 校验阶段
                if (!qqBotAuthorizedUser) {
                    if (text === qqBotVerifyCode) {
                        qqBotAuthorizedUser = msg.openid;
                        console.log('[QQBot] 用户验证通过:', msg.openid);
                        // 持久化保存，下次启动不再需要校验码
                        saveAppState({ qqBotSavedUser: msg.openid });
                        var statusStr = getQQBotStatusString();
                        qqBotInstance.sendText(msg.openid, '✅ 验证通过，已建立远程连接。\n\n' + statusStr, msg.msgId);
                        if (agentView && agentView.webContents) {
                            agentView.webContents.send('qqbot-authorized', { openid: msg.openid });
                        }
                    } else {
                        qqBotInstance.sendText(msg.openid, '❌ 校验码错误，请重新发送。', msg.msgId);
                    }
                    return;
                }

                // 只处理已授权用户
                if (msg.openid !== qqBotAuthorizedUser) return;

                // ========== 基础指令处理（不转发 AI） ==========
                if (text.startsWith('/')) {
                    var handled = await handleQQBotCommand(text, msg);
                    if (handled) return;
                }

                // 非指令消息 → 转发 AI
                if (qqBotAwaitingConfirm) {
                    console.log('[QQBot] 跳过确认回复，不转发 AI');
                    return;
                }
                if (qqBotProcessing) {
                    qqBotPendingMessages.push(msg);
                    qqBotInstance.sendText(msg.openid, '⏳ 正在处理上一条消息，已加入等待队列（位置 ' + qqBotPendingMessages.length + '）', msg.msgId);
                    return;
                }

                // 检查是否有活跃对话（DeepSeek 页面是否在当前对话中）
                try {
                    if (deepseekView && deepseekView.webContents && !deepseekView.webContents.isDestroyed()) {
                        var dsUrl = await deepseekView.webContents.executeJavaScript('window.location.href');
                        var dsBody = await deepseekView.webContents.executeJavaScript('document.body ? document.body.textContent.length > 100 : false');
                        if (!dsUrl || !dsUrl.includes('/chat/')) {
                            // 无活跃对话，发送告警而非自动转发
                            if (text) {
                                qqBotInstance.sendText(msg.openid, '⚠️ 当前没有活跃的对话。请先发送 /new 开始新对话，或使用 /list 查看已有对话后用 /switch <编号> 切换。', msg.msgId);
                            }
                            return;
                        }
                    }
                } catch(e) {
                    console.log('[QQBot] 检查对话状态失败:', e.message);
                }

                qqBotProcessing = true;
                forwardQQMessageToAgent(msg);
            });

            // 按钮交互处理
            qqBotInstance.on('interaction', async (intData) => {
                console.log('[QQBot] 按钮交互:', intData.buttonData);
                var data = intData.buttonData || '';
                // 帮助面板按钮：直接执行对应指令
                if (data === '/n') {
                    await handleQQBotCommand('/n', { openid: intData.userOpenid, msgId: null });
                } else if (data === '/d') {
                    await handleQQBotCommand('/d', { openid: intData.userOpenid, msgId: null });
                } else if (data === '/s') {
                    await handleQQBotCommand('/s', { openid: intData.userOpenid, msgId: null });
                } else if (data === '/l') {
                    await handleQQBotCommand('/l', { openid: intData.userOpenid, msgId: null });
                } else if (data === '/stop') {
                    await handleQQBotCommand('/stop', { openid: intData.userOpenid, msgId: null });
                } else if (data === '/sc') {
                    await handleQQBotCommand('/sc', { openid: intData.userOpenid, msgId: null });
                }
                // 确认/取消按钮由 agent-request-confirm 的 Promise 处理，这里不处理
            });

            qqBotInstance.on('error', (err) => {
                console.error('[QQBot] 错误:', err);
            });

            await qqBotInstance.start();

            return { success: true, verifyCode: qqBotVerifyCode };
        } catch (err) {
            console.error('[QQBot] 启动失败:', err);
            return { success: false, error: err.message };
        }
    });

    // 获取当前状态字符串（供 /status 和验证成功时用）
    function getQQBotStatusString() {
        var state = loadAppState();
        var deepthink = state.qqBotDeepThink !== false;
        var mode = state.qqBotMode || 'expert';
        var confirmMode = state.qqBotConfirmMode || 'smart';
        var dir = state.qqBotDir || currentRootDir || '.';
        var parts = [];
        parts.push('📋 当前状态：');
        parts.push('├ 🧠 深度思考: ' + (deepthink ? '开' : '关'));
        parts.push('├ ⚡ 模式: ' + (mode === 'expert' ? '专家' : '快速'));
        parts.push('├ 🔒 信任模式: ' + (confirmMode === 'smart' ? '智能' : confirmMode === 'strict' ? '严格' : '宽松'));
        parts.push('└ 📂 目录: ' + dir);
        parts.push('');
        parts.push('📖 可用指令：');
        parts.push('/h               - 显示此帮助');
        parts.push('/n [expert|quick] - 新对话');
        parts.push('/d               - 切换深度思考');
        parts.push('/m [smart|strict|loose] - 查看/切换信任模式');
        parts.push('/cd <路径>        - 切换工作目录');
        parts.push('/s               - 显示当前状态');
        parts.push('/sc               - 全屏截图');
        parts.push('/sct              - 截取当前视图窗口');
        parts.push('/stop            - 停止正在执行的任务');
        parts.push('/l               - 列出所有对话');
        parts.push('/sw <编号>        - 切换到指定对话（用 /l 查看编号）');
        return parts.join('\n');
    }

    // 处理 QQ Bot 指令（返回 true=已处理，false=需要转发 AI）
    async function handleQQBotCommand(text, msg) {
        var cmd = text.split(/\s+/);
        var main = cmd[0].toLowerCase();

        if (main === '/help' || main === '/h' || main === '帮助') {
            var s = getQQBotStatusString();
            await qqBotInstance.sendKeyboard(msg.openid, s, [
                { id: 'help_new', label: '🔄 新对话', data: '/n', style: 1 },
                { id: 'help_deepthink', label: '🧠 切换深度思考', data: '/d', style: 0 },
                { id: 'help_status', label: '📋 状态', data: '/s', style: 0 },
                { id: 'help_list', label: '📜 对话列表', data: '/l', style: 0 },
                { id: 'help_stop', label: '⏹️ 停止', data: '/stop', style: 0 },
                { id: 'help_screenshot', label: '📸 截图', data: '/sc', style: 0 }
            ], msg.msgId);
            return true;
        }

        if (main === '/status' || main === '/s') {
            var s = getQQBotStatusString();
            await qqBotInstance.sendText(msg.openid, s, msg.msgId);
            return true;
        }

        if (main === '/deep' || main === '/d' || main === '/deepthink') {
            var state = loadAppState();
            var current = state.qqBotDeepThink !== false;
            state.qqBotDeepThink = !current;
            saveAppState({ qqBotDeepThink: !current });
            // 实际触发深度思考切换
            try {
                if (deepseekView && deepseekView.webContents && !deepseekView.webContents.isDestroyed()) {
                    deepseekView.webContents.executeJavaScript(
                        'if (window.__dsagent_toggleDeepThink) window.__dsagent_toggleDeepThink(' + (!current) + ')'
                    );
                }
            } catch (e) { /* ignore */ }
            // 同步到 agentview
            if (agentView && agentView.webContents) {
                agentView.webContents.send('qqbot-command', { action: 'toggleDeepThink', value: !current });
            }
            await qqBotInstance.sendText(msg.openid, '🧠 深度思考已' + (!current ? '开启' : '关闭'), msg.msgId);
            return true;
        }

        if (main === '/mode' || main === '/m') {
            var state2 = loadAppState();
            var modes = ['smart', 'strict', 'loose', 'readonly', 'custom'];
            var labels = { smart: '智能', strict: '严格', loose: '宽松', readonly: '只读', custom: '自定义' };
            if (cmd.length >= 2 && modes.indexOf(cmd[1]) >= 0) {
                var newMode = cmd[1];
                saveAppState({ qqBotConfirmMode: newMode });
                // 更新 config 中的 confirmMode，保持主配置与 QQ 状态一致
                try {
                    var cfgRes = agent.loadConfig();
                    var cfg = cfgRes.config || {};
                    cfg.confirmMode = newMode;
                    agent.saveConfig(cfg);
                } catch (e) { console.warn('[QQBot] save confirm mode to config failed:', e.message); }

                // 同步到 DeepSeek（配置已保存，跳过重复保存）
                if (deepseekView) {
                    deepseekView.webContents.executeJavaScript(
                        `window.__dsagent_setConfirmMode && window.__dsagent_setConfirmMode(${JSON.stringify(newMode)}, true);`
                    ).catch(() => {});
                }
                // 同步到 Agent 视图
                if (agentView && agentView.webContents) {
                    agentView.webContents.send('qqbot-command', { action: 'setConfirmMode', value: newMode });
                }
                // 同步到 viewbar
                if (viewBarView && viewBarView.webContents && !viewBarView.webContents.isDestroyed()) {
                    viewBarView.webContents.send('ctrl-viewbar-status', {
                        currentView: currentView,
                        dsState: 'idle',
                        qwenState: 'idle',
                        confirmMode: newMode,
                        theme: currentAppTheme
                    });
                }
                await qqBotInstance.sendText(msg.openid, '🔒 信任模式已设为: ' + labels[newMode], msg.msgId);
            } else {
                var curMode = state2.qqBotConfirmMode || 'smart';
                var msg2 = '🔒 当前信任模式: ' + (labels[curMode] || curMode) + ' (' + curMode + ')\n可切换: /mode smart（智能）/ strict（严格）/ loose（宽松）/ readonly（只读）/ custom（自定义）';
                await qqBotInstance.sendText(msg.openid, msg2, msg.msgId);
            }
            return true;
        }

        if (main === '/cd' || main === '/chdir') {
            if (cmd.length >= 2) {
                var newDir = cmd.slice(1).join(' ');
                try {
                    if (fs.existsSync(newDir) && fs.statSync(newDir).isDirectory()) {
                        saveAppState({ qqBotDir: newDir });
                        if (agentView && agentView.webContents) {
                            agentView.webContents.send('qqbot-command', { action: 'changeDir', value: newDir });
                        }
                        // 也同步到文件浏览器的根目录
                        if (fileBrowserView && fileBrowserView.webContents) {
                            fileBrowserView.webContents.send('root-changed', newDir);
                        }
                        await qqBotInstance.sendText(msg.openid, '📂 工作目录已切换至: ' + newDir, msg.msgId);
                    } else {
                        await qqBotInstance.sendText(msg.openid, '❌ 目录不存在: ' + newDir, msg.msgId);
                    }
                } catch (e) {
                    await qqBotInstance.sendText(msg.openid, '❌ 切换失败: ' + e.message, msg.msgId);
                }
            } else {
                var curDir = loadAppState().qqBotDir || currentRootDir || '.';
                await qqBotInstance.sendText(msg.openid, '📂 当前工作目录: ' + curDir + '\n使用 /cd <路径> 切换', msg.msgId);
            }
            return true;
        }

        if (main === '/new' || main === '/n') {
            var mode3 = 'expert';
            if (cmd.length >= 2 && (cmd[1] === 'quick' || cmd[1] === 'expert')) mode3 = cmd[1];
            var deepVal = cmd.indexOf('nodeep') >= 0 ? false : (cmd.indexOf('deep') >= 0 ? true : null);
            var state3 = loadAppState();
            if (deepVal !== null) { saveAppState({ qqBotDeepThink: deepVal }); }
            saveAppState({ qqBotMode: mode3 });
            // 实际执行新建对话
            var newUrl = '';
            try {
                if (deepseekView && deepseekView.webContents && !deepseekView.webContents.isDestroyed()) {
                    var execCode = 'if (window.__dsagent_newChatAndSendInit) window.__dsagent_newChatAndSendInit("' + mode3 + '", ' + (deepVal !== null ? deepVal : state3.qqBotDeepThink !== false) + ')';
                    await deepseekView.webContents.executeJavaScript(execCode);
                    // 等待页面 URL 更新（SPA 导航可能需要时间）
                    await new Promise(function(r) { setTimeout(r, 500); });
                    newUrl = await deepseekView.webContents.executeJavaScript('window.location.href');
                }
            } catch (e) { /* ignore */ }
            if (agentView && agentView.webContents) {
                agentView.webContents.send('qqbot-command', { action: 'newChat', mode: mode3, deepthink: deepVal !== null ? deepVal : state3.qqBotDeepThink !== false, url: newUrl });
            }
            await qqBotInstance.sendText(msg.openid, '🔄 已开始新对话（模式: ' + (mode3 === 'expert' ? '专家' : '快速') + '）', msg.msgId);
            return true;
        }

        if (main === '/list' || main === '/l') {
            try {
                var listDir = currentRootDir || app.getPath('userData');
                var histories = historyManager.listHistories(listDir);
                if (!histories || histories.length === 0) {
                    await qqBotInstance.sendText(msg.openid, '📋 没有找到任何历史对话。发送 /new 开始一个新对话。', msg.msgId);
                } else {
                    var lines = ['📋 历史对话列表：'];
                    var limit = Math.min(histories.length, 30);
                    for (var li = 0; li < limit; li++) {
                        var h = histories[li];
                        var prefix = (li + 1) < 10 ? ' ' : '';
                        var title = (h.title || '(无标题)').substring(0, 40);
                        var modeInfo = (h.mode || 'expert') + (h.deepthink ? '+深' : '');
                        var msgCount = h.messageCount || 0;
                        lines.push(prefix + (li + 1) + '. ' + title + ' [' + modeInfo + ' ' + msgCount + '条]');
                    }
                    if (histories.length > 30) lines.push('... 还有 ' + (histories.length - 30) + ' 个');
                    lines.push('');
                    lines.push('发送 /sw <编号>（或 /switch <编号>）切换对话');
                    await qqBotInstance.sendText(msg.openid, lines.join('\n'), msg.msgId);
                }
            } catch (e) {
                await qqBotInstance.sendText(msg.openid, '❌ 获取对话列表失败: ' + e.message, msg.msgId);
            }
            return true;
        }

        if (main === '/switch' || main === '/sw') {
            var swIdx = parseInt(cmd[1], 10);
            if (isNaN(swIdx) || swIdx < 1) {
                await qqBotInstance.sendText(msg.openid, '❌ 请指定有效的对话编号。使用 /l 查看所有对话。', msg.msgId);
                return true;
            }
            try {
                var listDir = currentRootDir || app.getPath('userData');
                var histories = historyManager.listHistories(listDir);
                if (!histories || swIdx > histories.length) {
                    await qqBotInstance.sendText(msg.openid, '❌ 对话编号超出范围（1-' + (histories.length || 0) + '）', msg.msgId);
                    return true;
                }
                var target = histories[swIdx - 1];
                // 验证对话记录是否仍然存在（可能在列表后刚被删除）
                var fullHistory = historyManager.loadHistory(listDir, target.id);
                if (!fullHistory) {
                    await qqBotInstance.sendText(msg.openid, '❌ 该对话记录已不存在（可能已被删除）', msg.msgId);
                    return true;
                }
                // 通过 agentView 恢复历史对话
                if (agentView && agentView.webContents && !agentView.webContents.isDestroyed()) {
                    agentView.webContents.send('restore-history-conversation', target.id);
                    await qqBotInstance.sendText(msg.openid, '✅ 已切换到: ' + (target.title || '(未命名对话)'), msg.msgId);
                } else {
                    await qqBotInstance.sendText(msg.openid, '❌ Agent 页面未加载', msg.msgId);
                }
            } catch (e) {
                await qqBotInstance.sendText(msg.openid, '❌ 切换对话失败: ' + e.message, msg.msgId);
            }
            return true;
        }

        if (main === '/screenshot' || main === '/sc') {
            try {
                var ssTempDir = path.join(currentRootDir || app.getPath('userData'), '.dsa', 'temp');
                if (!fs.existsSync(ssTempDir)) fs.mkdirSync(ssTempDir, { recursive: true });
                var ssFilename = 'screenshot_' + Date.now() + '.png';
                var ssPath = path.join(ssTempDir, ssFilename);

                // 方法1: desktopCapturer screen capture + crop
                var captured = false;
                try {
                    var sources = await desktopCapturer.getSources({
                        types: ['screen'],
                        thumbnailSize: { width: 3840, height: 2160 } // 明确尺寸更可靠
                    });

                    var electronScreen = require('electron').screen;
                    var winBounds = mainWindow.getBounds();
                    var targetDisplay = electronScreen.getDisplayMatching(winBounds);
                    var source = null;
                    for (var si = 0; si < sources.length; si++) {
                        if (String(sources[si].display_id) === String(targetDisplay.id)) {
                            source = sources[si];
                            break;
                        }
                    }
                    if (!source && sources.length > 0) source = sources[0];

                    if (source && source.thumbnail && !source.thumbnail.isEmpty()) {
                        var img = source.thumbnail;

                        fs.writeFileSync(ssPath, img.toPNG());
                        captured = true;
                        console.log('[QQBot] 截图方式: desktopCapturer');
                    }
                } catch (e) {
                    console.log('[QQBot] desktopCapturer 异常:', e.message);
                }

                // 方法2: PowerShell .NET 截图兜底（写入临时 .ps1 脚本避免转义问题）
                if (!captured) {
                    console.log('[QQBot] 截图回退到 PowerShell');
                    try {
                        var psTempPath = ssPath.replace('.png', '_raw.png');
                        // 生成临时 PowerShell 脚本
                        var psScriptContent =
                            'Add-Type -AssemblyName System.Drawing, System.Windows.Forms\r\n' +
                            '$s = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds\r\n' +
                            '$b = New-Object System.Drawing.Bitmap $s.Width, $s.Height\r\n' +
                            '$g = [System.Drawing.Graphics]::FromImage($b)\r\n' +
                            '$g.CopyFromScreen($s.X, $s.Y, 0, 0, $s.Size)\r\n' +
                            '$b.Save("' + psTempPath.replace(/\\/g, '\\\\') + '")\r\n' +
                            '$g.Dispose(); $b.Dispose()';
                        var psFile = path.join(ssTempDir, '_capture.ps1');
                        fs.writeFileSync(psFile, psScriptContent, 'utf-8');
                        await new Promise(function(resolve, reject) {
                            exec('powershell -NoProfile -ExecutionPolicy Bypass -File "' + psFile + '"', { timeout: 15000 }, function(err, stdout) {
                                if (err) { reject(err); return; }
                                resolve(stdout);
                            });
                        });
                        // 清理临时脚本
                        try { fs.unlinkSync(psFile); } catch(e) {}

                        if (fs.existsSync(psTempPath)) {
                            var psBuffer = fs.readFileSync(psTempPath);
                            var psImg = nativeImage.createFromBuffer(psBuffer);
                            if (!psImg.isEmpty()) {
                                fs.writeFileSync(ssPath, psImg.toPNG());
                                captured = true;
                                console.log('[QQBot] 截图方式: PowerShell');
                            }
                            // 删除临时原始截图
                            try { fs.unlinkSync(psTempPath); } catch(e) {}
                        }
                    } catch (e) {
                        console.log('[QQBot] PowerShell 截图也失败:', e.message);
                    }
                }

                // 方法3: 终极兜底 - capturePage
                if (!captured) {
                    console.log('[QQBot] 截图回退到 capturePage');
                    try {
                        var capImg = await mainWindow.webContents.capturePage();
                        if (capImg && !capImg.isEmpty()) {
                            fs.writeFileSync(ssPath, capImg.toPNG());
                            captured = true;
                        }
                    } catch (e) {
                        console.log('[QQBot] capturePage 也失败:', e.message);
                    }
                }

                if (fs.existsSync(ssPath)) {
                    var stats = fs.statSync(ssPath);
                    await qqBotInstance.sendImage(msg.openid, ssPath, msg.msgId);
                    console.log('[QQBot] 截图已发送:', ssPath, '(' + Math.round(stats.size / 1024) + 'KB)');
                } else {
                    await qqBotInstance.sendText(msg.openid, '❌ 截图保存失败（窗口截图可能被系统阻止）', msg.msgId);
                }
            } catch (e) {
                console.error('[QQBot] 截图失败:', e);
                await qqBotInstance.sendText(msg.openid, '❌ 截图失败: ' + e.message, msg.msgId);
            }
            return true;
        }

        if (main === '/sct' || main === '/sct:' || (main === '/sct' && cmd.length === 1)) {
            try {
                // 确定当前活跃的视图
                var targetView = null;
                var viewName = '';
                if (agentViewVisible) {
                    targetView = agentView;
                    viewName = 'Agent';
                } else if (qwenVisible) {
                    targetView = qwenView;
                    viewName = 'Qwen';
                } else {
                    targetView = deepseekView;
                    viewName = 'DeepSeek';
                }

                if (!targetView || targetView.webContents.isDestroyed()) {
                    await qqBotInstance.sendText(msg.openid, '❌ 当前视图不可用', msg.msgId);
                    return true;
                }

                console.log('[QQBot] /sct 截取窗口: ' + viewName);

                var sctTempDir = path.join(currentRootDir || app.getPath('userData'), '.dsa', 'temp');
                if (!fs.existsSync(sctTempDir)) fs.mkdirSync(sctTempDir, { recursive: true });
                var sctFilename = 'screenshot_win_' + Date.now() + '.png';
                var sctPath = path.join(sctTempDir, sctFilename);

                // 计算内容区域 bounds（与 updateBounds 一致）
                var winSize = mainWindow.getContentBounds();
                var contentX = VIEWBAR_WIDTH;
                var contentWidth = winSize.width - VIEWBAR_WIDTH - SIDEBAR_WIDTH;
                var contentHeight = winSize.height - CTRL_BAR_HEIGHT;

                // 保存原始 bounds，临时设为可见区域
                var origBounds = targetView.getBounds();
                var wasOffscreen = origBounds.width < 10 || origBounds.x < 0;

                if (wasOffscreen) {
                    targetView.setBounds({
                        x: contentX, y: 0,
                        width: contentWidth, height: contentHeight
                    });
                    // 等待一帧确保渲染
                    await new Promise(function(r) { setTimeout(r, 300); });
                }

                // capturePage 捕获视图内容
                var captured = false;
                try {
                    var capImg = await targetView.webContents.capturePage();
                    if (capImg && !capImg.isEmpty()) {
                        fs.writeFileSync(sctPath, capImg.toPNG());
                        captured = true;
                        console.log('[QQBot] /sct 截图方式: capturePage, 视图: ' + viewName);
                    }
                } catch (e) {
                    console.log('[QQBot] /sct capturePage 失败:', e.message);
                }

                // 恢复原始 bounds
                if (wasOffscreen) {
                    targetView.setBounds(origBounds);
                }

                if (captured && fs.existsSync(sctPath)) {
                    var sctStats = fs.statSync(sctPath);
                    await qqBotInstance.sendImage(msg.openid, sctPath, msg.msgId);
                    console.log('[QQBot] /sct 截图已发送:', sctPath, '(' + Math.round(sctStats.size / 1024) + 'KB) 视图: ' + viewName);
                } else {
                    await qqBotInstance.sendText(msg.openid, '❌ 截图失败（' + viewName + ' 视图不可用）', msg.msgId);
                }
            } catch (e) {
                console.error('[QQBot] /sct 截图失败:', e);
                await qqBotInstance.sendText(msg.openid, '❌ 截图失败: ' + e.message, msg.msgId);
            }
            return true;
        }

        if (main === '/stop') {
            try {
                await stopAll();
            } catch (e) { /* ignore */ }
            if (agentView && agentView.webContents) {
                agentView.webContents.send('qqbot-command', { action: 'stop' });
            }
            await qqBotInstance.sendText(msg.openid, '⏹️ 已停止', msg.msgId);
            return true;
        }

        return false; // 不认识的指令，转发 AI
    }

    // 停止 QQ Bot
    ipcMain.handle('qqbot-stop', async () => {
        try {
            if (qqBotInstance) {
                qqBotInstance.removeAllListeners();
                qqBotInstance.ws && qqBotInstance.ws.close();
                qqBotInstance = null;
            }
            if (qqBotPowerSaveId !== null) {
                const { powerSaveBlocker } = require('electron');
                powerSaveBlocker.stop(qqBotPowerSaveId);
                qqBotPowerSaveId = null;
                console.log('[QQBot] 已恢复屏幕休眠');
            }
            qqBotAuthorizedUser = null;
            qqBotVerifyCode = '';
            qqBotPendingMessages = [];
            qqBotProcessing = false;
            return { success: true };
        } catch (err) {
            return { success: false, error: err.message };
        }
    });

    // 查询 QQ Bot 状态
    ipcMain.handle('qqbot-status', () => {
        return {
            running: !!qqBotInstance,
            authorized: !!qqBotAuthorizedUser,
            openid: qqBotAuthorizedUser || null,
            verifyCode: qqBotVerifyCode,
            queueLength: qqBotPendingMessages.length,
            processing: qqBotProcessing
        };
    });

    ipcMain.handle('qqbot-get-net-mode', () => {
        return { mode: getQQBotNetMode() };
    });

    ipcMain.handle('qqbot-set-net-mode', (event, mode) => {
        saveAppState({ qqBotNetMode: mode });
        // 关闭所有已有的隧道（模式切换时清理）
        for (var port in tunnelCache) {
            try {
                tunnelCache[port].tunnel.close();
            } catch (e) {}
        }
        tunnelCache = {};
        return { success: true, mode: mode };
    });

    // ==================== QQ Bot 外网模式 URL 转换 ====================
    var tunnelCache = {};  // port -> { url, tunnel }

    // 获取本机局域网 IP
    function getLanIP() {
        var interfaces = os.networkInterfaces();
        for (var name in interfaces) {
            var iface = interfaces[name];
            if (!iface) continue;
            for (var i = 0; i < iface.length; i++) {
                var addr = iface[i];
                if (addr.family === 'IPv4' && !addr.internal) {
                    return addr.address;
                }
            }
        }
        return '127.0.0.1';
    }

    // 提取 URL 中的端口号
    function extractPort(url) {
        var m = url.match(/:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0):(\d+)/);
        return m ? parseInt(m[1]) : null;
    }

    // 替换文本中的 localhost URL（同步：LAN 模式直接替换，外网模式标记待异步处理）
    // 标记格式: __DSAGENT_TUNNEL_port__path  保留路径，避免 502
    function replaceLocalhostUrls(text, netMode) {
        var urlRegex = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0)(:\d+)?(\/[^\s]*)?/gi;
        return text.replace(urlRegex, function(matched) {
            var port = extractPort(matched);
            if (netMode === 'wan' && port) {
                var path = matched.replace(/^https?:\/\/[^\/]+/, '') || '/';
                return '__DSAGENT_TUNNEL_' + port + '__' + path;
            }
            var lanIP = getLanIP();
            return matched.replace(/(?:localhost|127\.0\.0\.1|0\.0\.0\.0)/i, lanIP);
        });
    }

    // 异步替换 __DSAGENT_TUNNEL_port__path 标记为 localtunnel URL
    async function replaceWithTunnels(text) {
        var tunnelMarkers = text.match(/__DSAGENT_TUNNEL_\d+__[^\s]*/g);
        if (!tunnelMarkers) return text;

        for (var i = 0; i < tunnelMarkers.length; i++) {
            var marker = tunnelMarkers[i];
            var portMatch = marker.match(/__DSAGENT_TUNNEL_(\d+)__(\/[^\s]*)?/);
            if (!portMatch) continue;
            var port = parseInt(portMatch[1]);
            var path = portMatch[2] || '/';

            try {
                var tunnelUrl;
                if (tunnelCache[port] && tunnelCache[port].url) {
                    tunnelUrl = tunnelCache[port].url;
                } else {
                    console.log('[Tunnel] Creating tunnel for port', port);
                    var tunnel = await localtunnel({ port: port, local_host: '127.0.0.1' });
                    tunnelUrl = tunnel.url;
                    tunnelCache[port] = { url: tunnelUrl, tunnel: tunnel };
                    console.log('[Tunnel] Created:', tunnelUrl);
                    tunnel.on('close', function() {
                        console.log('[Tunnel] Closed for port', port);
                        delete tunnelCache[port];
                    });
                    tunnel.on('error', function(err) {
                        console.error('[Tunnel] Error for port', port, err.message);
                        delete tunnelCache[port];
                    });
                }
                text = text.replace(marker, tunnelUrl + path);
            } catch (e) {
                console.error('[Tunnel] Failed to create tunnel for port', port, e.message);
                var lanIP = getLanIP();
                text = text.replace(marker, 'http://' + lanIP + ':' + port + path);
            }
        }
        return text;
    }

    // 获取当前外网模式
    function getQQBotNetMode() {
        var state = loadAppState();
        return state.qqBotNetMode || 'lan';
    }

    // Agent 发送 QQ 回复（由 agentview 在 AI 完成处理后调用）
    ipcMain.on('qqbot-send-response', async (event, data) => {
        if (!qqBotInstance || !qqBotAuthorizedUser) return;
        var openid = qqBotAuthorizedUser;
        var msgId = data.msgId || null;

        try {
            // 发送文字回复（自动转换 localhost URL 为 LAN/外网 地址）
            if (data.text) {
                var netMode = getQQBotNetMode();
                var text = replaceLocalhostUrls(data.text, netMode);
                text = await replaceWithTunnels(text);
                await qqBotInstance.sendText(openid, text, msgId);
            }
            // 发送图片/文件
            if (data.files && data.files.length > 0) {
                for (var fi = 0; fi < data.files.length; fi++) {
                    var fp = data.files[fi];
                    try {
                        var ext = path.extname(fp).toLowerCase();
                        if (ext.match(/\.(png|jpg|jpeg|gif|bmp|webp|svg)$/i)) {
                            await qqBotInstance.sendImage(openid, fp, msgId);
                        } else {
                            await qqBotInstance.sendFile(openid, fp, msgId);
                        }
                    } catch (e) {
                        console.error('[QQBot] 发送文件失败:', fp, e.message);
                    }
                }
            }
        } catch (err) {
            console.error('[QQBot] 发送回复失败:', err);
        }

        // 处理下一个排队消息
        qqBotProcessing = false;
        if (qqBotPendingMessages.length > 0) {
            var next = qqBotPendingMessages.shift();
            qqBotProcessing = true;
            forwardQQMessageToAgent(next);
        }
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

    ipcMain.handle('qqbot-list-robots', () => {
        var state = loadAppState();
        return state.qqRobots || [];
    });

    ipcMain.handle('qqbot-save-robot', (event, robot) => {
        var state = loadAppState();
        var robots = state.qqRobots || [];
        var idx = -1;
        for (var ri = 0; ri < robots.length; ri++) {
            if (robots[ri].id === robot.id) { idx = ri; break; }
        }
        if (idx >= 0) {
            // 编辑时 secret 留空且标记 _keepSecret，保留旧值
            if (robot._keepSecret && !robot.clientSecret) {
                robot.clientSecret = robots[idx].clientSecret;
            }
            delete robot._keepSecret;
            robots[idx] = robot;
        } else {
            delete robot._keepSecret;
            robots.push(robot);
        }
        saveAppState({ qqRobots: robots });
        return { success: true, robots: robots };
    });

    ipcMain.handle('qqbot-delete-robot', (event, robotId) => {
        var state = loadAppState();
        var robots = (state.qqRobots || []).filter(function(r) { return r.id !== robotId; });
        saveAppState({ qqRobots: robots });
        return { success: true, robots: robots };
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
        // 如果 QQ Bot 已授权，通过 QQ 按钮询问
        if (qqBotInstance && qqBotAuthorizedUser && agentView && agentView.webContents) {
            var cmdDesc = data.cmdDisplay || data.cmd || data.lang || '未知命令';
            var lang = data.lang || '';
            // 根据操作类型定制提示文案
            var actionLabel = '执行';
            var confirmLabel = '✅ 确认执行';
            if (lang === 'local-delete') {
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

                qqBotAwaitingConfirm = true;
                var qqConfirmed = await new Promise(function(resolve) {
                    var qqTimeout = setTimeout(function() {
                        qqBotAwaitingConfirm = false;
                        qqBotInstance.removeListener('interaction', interactionHandler);
                        qqBotInstance.removeListener('message', msgHandler);
                        resolve(false);
                    }, 60000);
                    var interactionHandler = function(intData) {
                        if (intData.userOpenid !== qqBotAuthorizedUser) return;
                        clearTimeout(qqTimeout);
                        qqBotAwaitingConfirm = false;
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
                            qqBotAwaitingConfirm = false;
                            qqBotInstance.removeListener('interaction', interactionHandler);
                            qqBotInstance.removeListener('message', msgHandler);
                            resolve(true);
                        } else if (reply === 'N' || reply === 'NO' || reply === '取消') {
                            clearTimeout(qqTimeout);
                            qqBotAwaitingConfirm = false;
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
        if (data.type === 'skill-step' && qqBotInstance && qqBotAuthorizedUser) {
            try {
                var statusEmoji = { running: '🔄', completed: '✅', failed: '❌', info: 'ℹ️' };
                var emoji = statusEmoji[data.status] || '📌';
                var msgText = emoji + ' ' + data.skill + ': ' + data.step;
                qqBotInstance.sendText(qqBotAuthorizedUser, msgText);
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
                if (fileBrowserView) {
                    fileBrowserView.webContents.send('root-changed', null);
                }
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
                    if (currentUrl && currentUrl !== 'about:blank') {
                        deepseekView.webContents.loadURL(currentUrl);
                    } else {
                        deepseekView.webContents.loadURL(DEEPSEEK_URL);
                    }
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
            const promptDir = path.join(__dirname, 'prompt');
            if (fs.existsSync(promptDir)) {
                const files = fs.readdirSync(promptDir)
                    .filter(f => f.endsWith('.md'))
                    .sort();  // 按文件名排序，保证 01- 03- 顺序
                for (const f of files) {
                    text += fs.readFileSync(path.join(promptDir, f), 'utf-8') + '\n\n';
                }
            }
            // 加载模式专用策略（common.md + {mode}.md）
            var strategyMode = mode || 'quick';
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

    // 加载 subreader 通用策略
    ipcMain.handle('get-subreader-strategy', async () => {
        try {
            var text = '';
            const commonFile = path.join(__dirname, 'prompt', 'subreader', 'common.md');
            if (fs.existsSync(commonFile)) {
                text = fs.readFileSync(commonFile, 'utf-8');
            }
            return { success: true, text: text };
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
        if (fileBrowserView) {
            fileBrowserView.webContents.send('root-changed', null);
        }
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

// ==================== 广播主题切换 ====================
function broadcastTheme(theme) {
    currentAppTheme = theme;
    saveAppState({ theme: theme });
    if (controlBarView && controlBarView.webContents && !controlBarView.webContents.isDestroyed()) {
        controlBarView.webContents.send('ctrl-theme', theme);
    }
    if (viewBarView && viewBarView.webContents && !viewBarView.webContents.isDestroyed()) {
        viewBarView.webContents.send('ctrl-theme', theme);
    }
    if (fileBrowserView && fileBrowserView.webContents && !fileBrowserView.webContents.isDestroyed()) {
        fileBrowserView.webContents.send('fb-theme', theme);
    }
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
    var code;
    if (theme === 'dark') {
        code = '(function(){var o=document.getElementById("__ds_theme_overlay");if(o)o.remove();var g=document.getElementById("__ds_theme_gradient");if(g)g.remove();var c=document.createElement("div");c.id="__ds_theme_overlay";c.style.cssText="position:fixed;top:0;left:0;width:100vw;height:100vh;pointer-events:none;z-index:2147483646;backdrop-filter:invert(1) hue-rotate(180deg);opacity:0;transition:opacity 0.3s ease";document.documentElement.appendChild(c);setTimeout(function(){c.style.opacity="1"},10);var g=document.createElement("div");g.id="__ds_theme_gradient";g.style.cssText="position:fixed;top:0;left:0;width:100vw;height:100vh;pointer-events:none;z-index:2147483647;background:linear-gradient(180deg,rgba(56,139,253,0.15) 0%,rgba(137,87,229,0.08) 30%,rgba(13,17,23,0.03) 60%,transparent 80%);opacity:0;transition:opacity 0.3s ease";document.documentElement.appendChild(g);setTimeout(function(){g.style.opacity="1"},10)})();';
    } else {
        code = '(function(){var o=document.getElementById("__ds_theme_overlay");if(o){o.style.opacity="0";setTimeout(function(){o.remove()},300)}var g=document.getElementById("__ds_theme_gradient");if(g){g.style.opacity="0";setTimeout(function(){g.remove()},300)}setTimeout(function(){var g=document.createElement("div");g.id="__ds_theme_gradient";g.style.cssText="position:fixed;top:0;left:0;width:100vw;height:100vh;pointer-events:none;z-index:2147483647;background:linear-gradient(180deg,rgba(9,105,218,0.12) 0%,rgba(130,80,223,0.06) 30%,transparent 70%);opacity:0;transition:opacity 0.3s ease";document.documentElement.appendChild(g);setTimeout(function(){g.style.opacity="1"},10)},300)})();';
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
                if (currentUrl && currentUrl !== 'about:blank') {
                    deepseekView.webContents.loadURL(currentUrl);
                } else {
                    deepseekView.webContents.loadURL(DEEPSEEK_URL);
                }
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
                        if (fileBrowserView) {
                            fileBrowserView.webContents.send('root-changed', null);
                        }
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
                {
                    label: '深色主题',
                    type: 'radio',
                    checked: currentAppTheme === 'dark',
                    click: () => broadcastTheme('dark')
                },
                {
                    label: '浅色主题',
                    type: 'radio',
                    checked: currentAppTheme === 'light',
                    click: () => broadcastTheme('light')
                },
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
    const mainHeight = height - CTRL_BAR_HEIGHT;
    const contentX = VIEWBAR_WIDTH;
    const contentWidth = width - VIEWBAR_WIDTH - SIDEBAR_WIDTH;
    const contentBounds = {
        x: contentX, y: 0,
        width: contentWidth,
        height: mainHeight
    };
    // 左侧视图选择栏
    if (viewBarView) {
        viewBarView.setBounds({
            x: 0, y: 0,
            width: VIEWBAR_WIDTH, height: height
        });
    }
    // 左侧内容区视图（DeepSeek / Qwen / Agent）
    // 所有视图始终在主窗口中，通过屏幕外定位控制可见性。
    // 隐藏时仍保持正常尺寸，避免 Chromium 因缩放到 1x1 丢弃帧缓冲导致白屏。
    if (!agentViewVisible && !qwenVisible) {
        deepseekView.setBounds(contentBounds);
    } else {
        deepseekView.setBounds({ x: -10000, y: 0, width: contentBounds.width, height: contentBounds.height });
    }
    if (qwenView) {
        if (!agentViewVisible && qwenVisible) {
            qwenView.setBounds(contentBounds);
        } else {
            qwenView.setBounds({ x: -10000, y: 0, width: contentBounds.width, height: contentBounds.height });
        }
    }
    if (agentView) {
        if (agentViewVisible) {
            agentView.setBounds(contentBounds);
        } else {
            agentView.setBounds({ x: -10000, y: 0, width: contentBounds.width, height: contentBounds.height });
        }
    }
    // 右侧文件浏览器视图
    fileBrowserView.setBounds({
        x: width - SIDEBAR_WIDTH, y: 0,
        width: SIDEBAR_WIDTH, height: height
    });
    // 底部控制栏
    controlBarView.setBounds({
        x: contentX, y: mainHeight,
        width: contentWidth,
        height: CTRL_BAR_HEIGHT
    });
    // 当 Qwen / Agent 从隐藏变为可见时，强制触发一次重绘，修复 Chromium 帧缓冲丢失导致的白屏
    if (!prevAgentViewVisible && agentViewVisible) forceRepaint(agentView);
    if (!prevQwenVisible && qwenVisible) forceRepaint(qwenView);
    prevAgentViewVisible = agentViewVisible;
    prevQwenVisible = qwenVisible;
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
        title: 'DeepSeek Local Agent',
        frame: false,
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            preload: path.join(__dirname, 'preload.js')
        }
    });

    // 创建浏览器窗口

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

    // 创建 Qwen 网页视图（后台加载，默认不显示）
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
            console.error('[Qwen] Renderer gone:', details.reason);
        });
        qwenView.webContents.on('unresponsive', () => {
            console.error('[Qwen] Page unresponsive');
        });
        qwenView.webContents.on('did-finish-load', () => {
            console.log('[Qwen] Page loaded, URL:', qwenView.webContents.getURL());
            // 每次加载完成后重新禁用后台节流
            qwenView.webContents.setBackgroundThrottling(false);
            const qwenScript = getQwenInjectScript();
            qwenView.webContents.executeJavaScript(qwenScript).catch(console.error);
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
        });
    }
    createQwenView();
    // 立即加入 Qwen 视图到主窗口，置于屏幕外保持 JS 全速运行
    mainWindow.addBrowserView(qwenView);
    // 初始尺寸保持正常窗口大小，避免 1x1 导致 Chromium 丢弃帧缓冲；updateBounds 会立即修正精确坐标
    qwenView.setBounds({ x: -10000, y: 0, width: 1280, height: 720 });

    // 创建文件浏览器视图（右侧）
    fileBrowserView = new BrowserView({
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false,
            preload: null
        }
    });
    mainWindow.addBrowserView(fileBrowserView);

    // 创建控制栏视图（底部）
    controlBarView = new BrowserView({
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false,
            preload: null
        }
    });
    mainWindow.addBrowserView(controlBarView);

    // 创建左侧视图选择栏
    viewBarView = new BrowserView({
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false,
            preload: null
        }
    });
    const viewBarPath = path.join(__dirname, 'viewbar.html');
    viewBarView.webContents.loadFile(viewBarPath);
    mainWindow.addBrowserView(viewBarView);
    // 视图栏加载完成后发送初始状态同步
    viewBarView.webContents.on('did-finish-load', function() {
        if (viewBarView && viewBarView.webContents && !viewBarView.webContents.isDestroyed()) {
            viewBarView.webContents.send('ctrl-viewbar-status', {
                currentView: currentView,
                dsState: 'idle',
                qwenState: 'idle',
                confirmMode: getConfirmMode(),
                theme: currentAppTheme
            });
            syncSkillsCount();
        }
    });

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
        syncSkillsCount();
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
    // 初始尺寸保持正常窗口大小，避免 1x1 导致 Chromium 丢弃帧缓冲；updateBounds 会立即修正精确坐标
    agentView.setBounds({ x: -10000, y: 0, width: 1280, height: 720 });

    // 设置布局

    mainWindow.on('resize', updateBounds);
    // 不再需要 move 同步（Qwen 在主窗口内）

    // 加载 DeepSeek 网页
    setupSession();
    deepseekView.webContents.loadURL(DEEPSEEK_URL);

    // 加载文件浏览器页面
    const fileBrowserPath = path.join(__dirname, 'filebrowser.html');
    fileBrowserView.webContents.loadFile(fileBrowserPath);

    // 加载控制栏页面
    const controlBarPath = path.join(__dirname, 'controlbar.html');
    controlBarView.webContents.loadFile(controlBarPath);
    // 控制栏加载完成后立即发送初始状态（确保视图选择器同步）
    controlBarView.webContents.on('did-finish-load', function() {
        if (controlBarView && controlBarView.webContents && !controlBarView.webContents.isDestroyed()) {
            controlBarView.webContents.send('ctrl-status', { currentView: currentView });
        }
    });

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
            if (viewBarView && viewBarView.webContents && !viewBarView.webContents.isDestroyed()) {
                viewBarView.webContents.send('ctrl-viewbar-status', {
                    currentView: currentView,
                    dsState: 'idle',
                    qwenState: 'idle',
                    confirmMode: mode,
                    theme: currentAppTheme
                });
            }
        }, 800);
        // 强制渲染 DeepSeek 页面一次，确保 SVG 图标即使屏幕外也已渲染完成
        setTimeout(() => {
            if (!deepseekView || deepseekView.webContents.isDestroyed()) return;
            try {
                // DeepSeek 初始在屏幕外（x: -10000），Chromium 因此跳过 SVG 渲染。
                // 短暂置于屏幕内强制完整渲染后移回，此后即使屏幕外 SVG 也可用。
                var b = deepseekView.getBounds();
                deepseekView.setBounds({ x: 0, y: 0, width: b.width, height: b.height });
                setTimeout(() => {
                    if (deepseekView && deepseekView.webContents && !deepseekView.webContents.isDestroyed()) {
                        // 移回屏幕外（updateBounds 会在 resize 或视图切换时修正精确位置）
                        deepseekView.setBounds({ x: -10000, y: 0, width: 1280, height: 720 });
                    }
                }, 200);
            } catch(e) {
                console.warn('[DeepSeek] Warmup render failed:', e);
            }
        }, 100);
    });

    // DeepSeek 导航事件：检测 VPN 切换导致的会话丢失，自动恢复
    deepseekView.webContents.on('did-navigate', (event, url, httpCode, httpStatus) => {
        console.log('[DeepSeek] Navigated:', url, 'Code:', httpCode, httpStatus);
        // 如果被重定向到非 chat 页面（如登录页、错误页），自动回到主页
        if (url.indexOf('/chat') === -1 && url.indexOf('chat.deepseek.com') >= 0) {
            console.log('[DeepSeek] 检测到非对话页面，自动跳转回主页...');
            setTimeout(() => {
                if (deepseekView && deepseekView.webContents && !deepseekView.webContents.isDestroyed()) {
                    deepseekView.webContents.loadURL(DEEPSEEK_URL);
                }
            }, 2000);
        }
    });
    deepseekView.webContents.on('did-fail-load', (event, code, desc, url) => {
        console.error('[DeepSeek] Load failed:', code, desc, url);
    });

    // 更新布局
    setTimeout(updateBounds, 100);

    // 定期从 DeepSeek 页面获取状态并同步到控制栏
    setInterval(() => {
        if (deepseekView && controlBarView && !deepseekView.webContents.isDestroyed() && !deepseekView.webContents.isLoading()) {
            deepseekView.webContents.executeJavaScript(
                'window.__dsagent_getStatus && window.__dsagent_getStatus()'
            ).then(status => {
                if (status && controlBarView) {
                    status.qwenVisible = qwenVisible;
                    status.currentView = currentView;
                    
                    // 检查 Qwen 状态
                    if (qwenView && qwenView.webContents && !qwenView.webContents.isDestroyed() && !qwenView.webContents.isLoading()) {
                        qwenView.webContents.executeJavaScript(
                            'window.__qwen && window.__qwen.isResponding ? window.__qwen.isResponding() : { responding: false }'
                        ).then(qwenResp => {
                            status.qwenState = (qwenResp && qwenResp.responding) ? 'generating' : 'idle';
                            
                            // 跟随模式：自动切换到当前活跃的视图
                            if (currentView === 'follow') {
                                var dsGenerating = status.buttonState === 'generating';
                                var qwenGenerating = status.qwenState === 'generating';
                                
                                if (qwenGenerating) {
                                    // Qwen 正在生成 → 确保 Qwen 视图可见（优先于 DeepSeek）
                                    if (!qwenVisible || agentViewVisible) {
                                        agentViewVisible = false;
                                        qwenVisible = true;
                                        updateBounds();
                                    }
                                } else if (dsGenerating) {
                                    // DeepSeek 生成中且当前是 Qwen/Agent → 切回 DeepSeek
                                    if (qwenVisible || agentViewVisible) {
                                        agentViewVisible = false;
                                        qwenVisible = false;
                                        updateBounds();
                                    }
                                } else if (!agentViewVisible) {
                                    // 都空闲 → 回到 Agent 视图
                                    agentViewVisible = true;
                                    qwenVisible = false;
                                    updateBounds();
                                }
                            }
                            
                            // 转发到控制栏
                            controlBarView.webContents.send('ctrl-status', status);
                            // 转发到视图选择栏
                            if (viewBarView && viewBarView.webContents && !viewBarView.webContents.isDestroyed()) {
                                viewBarView.webContents.send('ctrl-viewbar-status', {
                                    currentView: currentView,
                                    dsState: status.buttonState || 'idle',
                                    qwenState: status.qwenState || 'idle',
                                    confirmMode: status.confirmMode || 'smart',
                                    theme: currentAppTheme,
                                    dsConcurrent: status.concurrentMode || false
                                });
                            }
                        }).catch(() => {
                            status.qwenState = 'idle';
                            controlBarView.webContents.send('ctrl-status', status);
                        });
                    } else {
                        status.qwenState = 'idle';
                        controlBarView.webContents.send('ctrl-status', status);
                    }
                    
                    // 转发主题到文件浏览器、Agent 视图和视图选择栏
                    if (fileBrowserView && fileBrowserView.webContents && !fileBrowserView.webContents.isDestroyed()) {
                        fileBrowserView.webContents.send('fb-theme', currentAppTheme);
                    }
                    if (agentView && agentView.webContents && !agentView.webContents.isDestroyed()) {
                        agentView.webContents.send('agent-theme', currentAppTheme);
                    }
                    if (viewBarView && viewBarView.webContents && !viewBarView.webContents.isDestroyed()) {
                        viewBarView.webContents.send('ctrl-theme', currentAppTheme);
                    }
                }
            }).catch(() => {});
        }
    }, 300);

    // 定时对当前可见的 Qwen/Agent 视图强制重绘，防止其在最前端时因 GPU/合成器丢帧变白屏
    setInterval(() => {
        if (qwenVisible && qwenView && !qwenView.webContents.isDestroyed()) {
            forceRepaint(qwenView);
        } else if (agentViewVisible && agentView && !agentView.webContents.isDestroyed()) {
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
}

function restoreAppState() {
    const state = loadAppState();
    if (!state) return;

    // 恢复主题
    if (state.theme === 'light' || state.theme === 'dark') {
        currentAppTheme = state.theme;
        // 延迟广播给所有视图，等待视图加载完成
        setTimeout(() => {
            broadcastTheme(currentAppTheme);
        }, 1000);
    }

    // 恢复文件夹
    if (state.lastRootDir && fs.existsSync(state.lastRootDir)) {
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
            mainWindow.addBrowserView(fileBrowserView);
            mainWindow.addBrowserView(controlBarView);
            updateBounds();
            if (controlBarView && controlBarView.webContents && !controlBarView.webContents.isDestroyed()) {
                controlBarView.webContents.send('ctrl-agent-state', true);
            }
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
app.whenReady().then(() => {
    createWindow();

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

    // ── 自动更新 ──
    autoUpdater.logger = console;
    autoUpdater.autoDownload = false;
    autoUpdater.setFeedURL({
        provider: 'github',
        owner: 'Very12345',
        repo: 'dsagent-electron'
    });
    autoUpdater.checkForUpdates().catch(() => {}); // 静默检查，出错不影响启动
});

// 更新事件
autoUpdater.on('update-available', (info) => {
    if (mainWindow) {
        dialog.showMessageBox(mainWindow, {
            type: 'info',
            title: '发现新版本',
            message: `有新版本 ${info.version} 可用，是否下载更新？`,
            buttons: ['下载', '稍后'],
            defaultId: 0,
            cancelId: 1
        }).then(({ response }) => {
            if (response === 0) {
                autoUpdater.downloadUpdate();
            }
        });
    }
});

autoUpdater.on('download-progress', (progress) => {
    var pct = Math.round(progress.percent);
    // 发送进度到控制栏视图（右下角进度条）
    if (controlBarView && controlBarView.webContents && !controlBarView.webContents.isDestroyed()) {
        controlBarView.webContents.send('ctrl-update-progress', {
            percent: pct,
            bytesPerSecond: progress.bytesPerSecond,
            transferred: progress.transferred,
            total: progress.total
        });
    }
    // 发送进度到 agent 视图前端
    if (agentView && agentView.webContents && !agentView.webContents.isDestroyed()) {
        agentView.webContents.send('update-progress', {
            percent: pct,
            bytesPerSecond: progress.bytesPerSecond,
            transferred: progress.transferred,
            total: progress.total
        });
    }
    // 同时也发到主窗口
    if (mainWindow) mainWindow.webContents.send('update-progress', progress);
});

autoUpdater.on('update-downloaded', () => {
    // 通知控制栏进度完成
    if (controlBarView && controlBarView.webContents && !controlBarView.webContents.isDestroyed()) {
        controlBarView.webContents.send('ctrl-update-done');
    }
    if (mainWindow) {
        // 通知前端进度完成
        if (agentView && agentView.webContents && !agentView.webContents.isDestroyed()) {
            agentView.webContents.send('update-downloaded');
        }
        dialog.showMessageBox(mainWindow, {
            type: 'info',
            title: '更新已下载',
            message: '更新已下载完成，是否立即重启安装？',
            buttons: ['重启', '稍后'],
            defaultId: 0,
            cancelId: 1
        }).then(({ response }) => {
            if (response === 0) {
                // 清理更新缓存目录（%LOCALAPPDATA%/<appname>-updater）
                var updaterCacheDir = require('path').join(require('os').tmpdir(), '..', '..', '..');
                try {
                    var fs = require('fs');
                    var path = require('path');
                    var appData = process.env.LOCALAPPDATA || require('os').homedir();
                    // electron-updater 缓存路径
                    var cachePaths = [
                        path.join(appData, 'dsagent-electron-updater'),
                        path.join(appData, '..', 'Local', 'dsagent-electron-updater'),
                    ];
                    cachePaths.forEach(function(p) {
                        if (fs.existsSync(p)) {
                            fs.rmSync(p, { recursive: true, force: true });
                            console.log('[Update] Cleaned cache:', p);
                        }
                    });
                } catch(e) { console.warn('[Update] Cache cleanup failed:', e.message); }
                autoUpdater.quitAndInstall();
            }
        });
    }
});

app.on('before-quit', async () => {
    try {
        await agent.shutdownMcp();
    } catch (e) {
        console.log('[MCP] Shutdown error:', e.message);
    }
    // 关闭所有 localtunnel 隧道
    if (typeof tunnelCache !== 'undefined' && tunnelCache) {
        for (var port in tunnelCache) {
            try {
                tunnelCache[port].tunnel.close();
                console.log('[Tunnel] Closed for port', port);
            } catch (e) {}
        }
    }
    tunnelCache = {};
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