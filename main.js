// DeepSeek Local Agent - Electron 主进程（双栏布局版）
const { app, BrowserWindow, BrowserView, Menu, dialog, session, ipcMain, shell, clipboard, nativeImage } = require('electron');
const path = require('path');
const agent = require('./server.js');
const historyManager = require('./history-manager.js');
const { autoUpdater } = require('electron-updater');
const fs = require('fs');
const os = require('os');
const { exec } = require('child_process');

// ==================== 配置 ====================
const CONFIG = {
    TARGET_URL: 'https://chat.deepseek.com/',
    WINDOW_WIDTH: 1400,
    WINDOW_HEIGHT: 900,
};

const VIEWBAR_WIDTH = 60;  // 左侧视图选择栏宽度
const SIDEBAR_WIDTH = 350;
const CTRL_BAR_HEIGHT = 40;
const QWEN_URL = 'https://www.qianwen.com/';
const QWEN_WIDTH = 500;

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
let agentViewVisible = false;
let currentView = 'deepseek'; // 'deepseek' | 'qwen' | 'agent' | 'follow'
let userStoppedGeneration = false;  // 标记用户是否主动点击了停止按钮
let lastActiveView = 'deepseek';   // 跟随模式下上次活跃的视图
let currentAppTheme = 'dark';       // 当前应用主题

// ==================== 浏览器工具窗口管理 ====================
let browserToolWindows = new Map();
let browserWindowIdCounter = 0;
const BROWSER_TOOL_TEMP_DIR = '.dsa';
const BROWSER_TOOL_TEMP_SUBDIR = 'temp';

const RECENT_FILE = path.join(__dirname, 'recent_projects.json');
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

function openFolder(folderPath) {
    currentRootDir = folderPath;
    agent.setBaseDir(folderPath);
    if (fileBrowserView) {
        fileBrowserView.webContents.send('root-changed', folderPath);
    }
    saveRecentProject(folderPath);
    saveAppState({ lastRootDir: folderPath });
    rebuildMenu();

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
                    deepseekView.webContents.loadURL(CONFIG.TARGET_URL);
                }, 100);
            } catch(e) {
                console.warn('[OpenFolder] Navigate home failed:', e);
            }
        }
    });

    // 重新加载技能列表
    if (controlBarView) {
        const result = agent.loadSkills();
        controlBarView.webContents.send('ctrl-skills', result.skills || []);
    }
}

// ==================== 读取注入脚本 ====================
function getInjectScript() {
    const injectPath = path.join(__dirname, 'inject.js');
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
    const qwenPath = path.join(__dirname, 'qwen_inject.js');
    return fs.readFileSync(qwenPath, 'utf-8');
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
        return agent.saveSkills(skills);
    });

    ipcMain.handle('agent-ping', async () => {
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
        if (!qwenView) return { success: false, error: 'Qwen view not initialized' };
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
        if (!qwenView) return { success: false, ready: false };
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
        if (deepseekView) {
            deepseekView.webContents.executeJavaScript(
                `window.__dsagent_setConfirmMode && window.__dsagent_setConfirmMode('${mode}');`
            ).catch(() => {});
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

    // 加载技能列表
    ipcMain.on('ctrl-load-skills', (event) => {
        loadSkillsToControlBar();
    });

    // 添加技能
    ipcMain.on('ctrl-add-skill', (event, skill) => {
        const result = agent.loadSkills();
        const skills = result.skills || [];
        skills.push(skill);
        agent.saveSkills(skills);
        loadSkillsToControlBar();
    });

    // 从文件导入技能
    ipcMain.on('ctrl-import-skills', async (event) => {
        const result = await dialog.showOpenDialog(mainWindow, {
            title: '选择技能文件（JSON）',
            filters: [{ name: 'JSON 文件', extensions: ['json'] }],
            properties: ['openFile']
        });
        if (result.canceled || result.filePaths.length === 0) return;
        try {
            const content = fs.readFileSync(result.filePaths[0], 'utf-8');
            const skills = JSON.parse(content);
            if (!Array.isArray(skills)) throw new Error('JSON 应为数组格式');
            for (const s of skills) {
                if (!s.name || typeof s.name !== 'string') throw new Error('技能缺少 name 字段');
            }
            agent.saveSkills(skills);
            loadSkillsToControlBar();
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

    // 频率限制通知：deepseekView → agentView DOM 弹窗
    ipcMain.handle('agent-rate-limit-notify', async (event, waitSeconds) => {
        return new Promise((resolve) => {
            var messageId = 'ratelimit-' + Date.now() + '-' + Math.random().toString(36).substr(2, 6);
            var timeout = setTimeout(() => resolve(false), 120000);

            if (!agentView || !agentView.webContents || agentView.webContents.isDestroyed()) {
                return resolve(false);
            }

            agentView.webContents.send('agent-show-ratelimit', { waitSeconds: waitSeconds, _messageId: messageId });

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
                intents: (1 << 1) | (1 << 25),
                apiBase: 'https://api.sgroup.qq.com',
                imagePath: config.imagePath || './1.png',
                tempDir: config.tempDir || path.join(currentRootDir || '.', '.dsa', 'temp')
            });

            // 生成校验码
            qqBotVerifyCode = generateVerifyCode();
            qqBotAuthorizedUser = null;

            // 监听消息
            qqBotInstance.on('message', async (msg) => {
                console.log('[QQBot] 收到消息 from:', msg.openid, 'content:', msg.content);
                var text = (msg.content || '').trim();

                // 校验阶段
                if (!qqBotAuthorizedUser) {
                    if (text === qqBotVerifyCode) {
                        qqBotAuthorizedUser = msg.openid;
                        console.log('[QQBot] 用户验证通过:', msg.openid);
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
                qqBotProcessing = true;
                forwardQQMessageToAgent(msg);
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
        parts.push('/h          - 显示此帮助');
        parts.push('/n [expert|quick] - 新对话');
        parts.push('/d          - 切换深度思考');
        parts.push('/m [smart|strict|loose] - 查看/切换信任模式');
        parts.push('/cd <路径>   - 切换工作目录');
        parts.push('/s          - 显示当前状态');
        parts.push('/sc [full]   - 窗口截图（加 full 则为全屏）');
        parts.push('/stop       - 停止正在执行的任务');
        return parts.join('\n');
    }

    // 处理 QQ Bot 指令（返回 true=已处理，false=需要转发 AI）
    async function handleQQBotCommand(text, msg) {
        var cmd = text.split(/\s+/);
        var main = cmd[0].toLowerCase();

        if (main === '/help' || main === '/h' || main === '帮助') {
            var s = getQQBotStatusString();
            await qqBotInstance.sendText(msg.openid, s, msg.msgId);
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
                if (deepseekView && !deepseekView.webContents.isDestroyed()) {
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
            var modes = ['smart', 'strict', 'loose'];
            var labels = { smart: '智能', strict: '严格', loose: '宽松' };
            if (cmd.length >= 2 && modes.indexOf(cmd[1]) >= 0) {
                var newMode = cmd[1];
                saveAppState({ qqBotConfirmMode: newMode });
                if (agentView && agentView.webContents) {
                    agentView.webContents.send('qqbot-command', { action: 'setConfirmMode', value: newMode });
                }
                await qqBotInstance.sendText(msg.openid, '🔒 信任模式已设为: ' + labels[newMode], msg.msgId);
            } else {
                var curMode = state2.qqBotConfirmMode || 'smart';
                var msg2 = '🔒 当前信任模式: ' + labels[curMode] + ' (' + curMode + ')\n可切换: /mode smart（智能）/ strict（严格）/ loose（宽松）';
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
                if (deepseekView && !deepseekView.webContents.isDestroyed()) {
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

        if (main === '/screenshot' || main === '/sc') {
            var ssFull = cmd[1] === 'full' || cmd[1] === 'f';
            try {
                var ssTempDir = path.join(currentRootDir || app.getPath('userData'), '.dsa', 'temp');
                if (!fs.existsSync(ssTempDir)) fs.mkdirSync(ssTempDir, { recursive: true });
                var ssFilename = 'screenshot_' + Date.now() + '.png';
                var ssPath = path.join(ssTempDir, ssFilename);

                if (ssFull) {
                    // 全屏截图：用 scaleFactor 得到物理尺寸
                    var scaleFactor = require('electron').screen.getPrimaryDisplay().scaleFactor || 1;
                    var psScript = 'Add-Type -AssemblyName System.Windows.Forms,System.Drawing\n'
                        + '$s=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds\n'
                        + ('$r=New-Object System.Drawing.Size([int]($s.Width*' + scaleFactor + '),[int]($s.Height*' + scaleFactor + '))\n')
                        + '$bmp=New-Object System.Drawing.Bitmap($r.Width,$r.Height)\n'
                        + '$g2=[System.Drawing.Graphics]::FromImage($bmp)\n'
                        + '$g2.CopyFromScreen(0,0,0,0,$r)\n'
                        + ('$bmp.Save(\'' + ssPath.replace(/'/g, "''") + '\',[System.Drawing.Imaging.ImageFormat]::Png)\n')
                        + '$g2.Dispose();$bmp.Dispose()\n'
                        + 'Write-Output \'OK\'';
                    var psFile = path.join(os.tmpdir(), '_ds_ss_' + Date.now() + '.ps1');
                    fs.writeFileSync(psFile, psScript, 'utf-8');
                    try {
                        require('child_process').execSync(
                            'powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + psFile + '"',
                            { timeout: 15000, encoding: 'utf-8' }
                        );
                    } finally {
                        try { fs.unlinkSync(psFile); } catch(e) {}
                    }
                } else {
                    // 窗口截图：通过 PowerShell 截全屏，按 Electron 窗口位置裁切
                    var winBounds = mainWindow.getBounds();
                    var ssScale = require('electron').screen.getPrimaryDisplay().scaleFactor || 1;
                    var winPngPath = ssPath;
                    var psWin = 'Add-Type -AssemblyName System.Windows.Forms,System.Drawing\n'
                        + '$s=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds\n'
                        + ('$r=New-Object System.Drawing.Size([int]($s.Width*' + ssScale + '),[int]($s.Height*' + ssScale + '))\n')
                        + '$full=New-Object System.Drawing.Bitmap($r.Width,$r.Height)\n'
                        + '$g2=[System.Drawing.Graphics]::FromImage($full)\n'
                        + '$g2.CopyFromScreen(0,0,0,0,$r)\n'
                        + ('$rect=New-Object System.Drawing.Rectangle('
                            + Math.round(winBounds.x * ssScale) + ','
                            + Math.round(winBounds.y * ssScale) + ','
                            + Math.round(winBounds.width * ssScale) + ','
                            + Math.round(winBounds.height * ssScale) + ')\n')
                        + '$crop=$full.Clone($rect,[System.Drawing.Imaging.PixelFormat]::Format32bppArgb)\n'
                        + ('$crop.Save(\'' + winPngPath.replace(/'/g, "''") + '\',[System.Drawing.Imaging.ImageFormat]::Png)\n')
                        + '$g2.Dispose();$full.Dispose();$crop.Dispose()\n'
                        + 'Write-Output \'OK\'';
                    var psWinFile = path.join(os.tmpdir(), '_ds_ss_' + Date.now() + '.ps1');
                    fs.writeFileSync(psWinFile, psWin, 'utf-8');
                    try {
                        require('child_process').execSync(
                            'powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + psWinFile + '"',
                            { timeout: 15000, encoding: 'utf-8' }
                        );
                    } finally {
                        try { fs.unlinkSync(psWinFile); } catch(e) {}
                    }
                }

                if (fs.existsSync(ssPath)) {
                    var stats = fs.statSync(ssPath);
                    await qqBotInstance.sendImage(msg.openid, ssPath, msg.msgId);
                    console.log('[QQBot] 截图已发送:', ssPath, '(' + Math.round(stats.size / 1024) + 'KB, ' + (ssFull ? '全屏' : '窗口') + ')');
                } else {
                    await qqBotInstance.sendText(msg.openid, '❌ 截图保存失败', msg.msgId);
                }
            } catch (e) {
                console.error('[QQBot] 截图失败:', e);
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

    // Agent 发送 QQ 回复（由 agentview 在 AI 完成处理后调用）
    ipcMain.on('qqbot-send-response', async (event, data) => {
        if (!qqBotInstance || !qqBotAuthorizedUser) return;
        var openid = qqBotAuthorizedUser;
        var msgId = data.msgId || null;

        try {
            // 发送文字回复
            if (data.text) {
                await qqBotInstance.sendText(openid, data.text, msgId);
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
        if (deepseekView && !deepseekView.webContents.isDestroyed()) {
            try {
                return await deepseekView.webContents.executeJavaScript(
                    'window.__dsagent_tools ? window.__dsagent_tools.getReadHistory() : []'
                );
            } catch(e) { return []; }
        }
        return [];
    });
    ipcMain.handle('agent-set-read-tools', async (event, arr) => {
        if (deepseekView && !deepseekView.webContents.isDestroyed()) {
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
        // 如果 QQ Bot 已授权，通过 QQ 询问
        if (qqBotInstance && qqBotAuthorizedUser && agentView && agentView.webContents) {
            var cmdDesc = data.cmdDisplay || data.cmd || data.lang || '未知命令';
            try {
                await qqBotInstance.sendText(qqBotAuthorizedUser,
                    '⚠️ 需要确认是否执行：\n' + cmdDesc + '\n\n回复 Y 确认执行，其他回复取消（60秒超时）');

                qqBotAwaitingConfirm = true;
                var qqConfirmed = await new Promise(function(resolve) {
                    var qqTimeout = setTimeout(function() {
                        qqBotAwaitingConfirm = false;
                        qqBotInstance.removeListener('message', qqHandler);
                        resolve(false);
                    }, 60000);
                    var qqHandler = function(msg) {
                        if (msg.openid !== qqBotAuthorizedUser) return;
                        var reply = (msg.content || '').trim().toUpperCase();
                        if (reply === 'Y' || reply === 'YES' || reply === '确认') {
                            clearTimeout(qqTimeout);
                            qqBotAwaitingConfirm = false;
                            qqBotInstance.removeListener('message', qqHandler);
                            resolve(true);
                        } else if (reply === 'N' || reply === 'NO' || reply === '取消') {
                            clearTimeout(qqTimeout);
                            qqBotAwaitingConfirm = false;
                            qqBotInstance.removeListener('message', qqHandler);
                            resolve(false);
                        }
                        // 其他回复忽略，继续等待
                    };
                    qqBotInstance.on('message', qqHandler);
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
        if (agentView && agentView.webContents && !agentView.webContents.isDestroyed()) {
            agentView.webContents.send('agent-message', data);
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
        // 不再检查 userStoppedGeneration — 有截断就弹窗，让用户自己决定
        userStoppedGeneration = false;
        try {
            // QQ Bot 优先
            if (qqBotInstance && qqBotAuthorizedUser && agentView && agentView.webContents) {
                try {
                    await qqBotInstance.sendText(qqBotAuthorizedUser,
                        '⚠️ DeepSeek 输出被截断，检测到"继续生成"按钮。\n\n回复 Y 继续生成，其他回复取消（60秒超时）');
                    var qqContinued = await new Promise(function(resolve) {
                        var qt = setTimeout(function() {
                            qqBotInstance.removeListener('message', qh);
                            resolve(false);
                        }, 60000);
                        var qh = function(m) {
                            if (m.openid !== qqBotAuthorizedUser) return;
                            var r = (m.content || '').trim().toUpperCase();
                            if (r === 'Y' || r === 'YES' || r === '继续' || r === '继续生成') {
                                clearTimeout(qt); qqBotInstance.removeListener('message', qh);
                                resolve(true);
                            } else if (r === 'N' || r === 'NO' || r === '取消') {
                                clearTimeout(qt); qqBotInstance.removeListener('message', qh);
                                resolve(false);
                            }
                        };
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

    function loadSkillsToControlBar() {
        const result = agent.loadSkills();
        if (controlBarView) {
            controlBarView.webContents.send('ctrl-skills', result.skills || []);
        }
    }
}

// ==================== 文件浏览器 IPC 处理 ====================
function setupIpcHandlers() {
    // 设置 Agent IPC
    setupAgentIPC();
    // 设置控制栏 IPC
    setupControlBarIPC();
    // 设置浏览器工具 IPC
    setupBrowserIPC();

    // 获取初始目录
    ipcMain.handle('get-initial-dir', async () => {
        return { success: true, path: currentRootDir };
    });

    // 获取系统下载目录
    ipcMain.handle('get-downloads-path', async () => {
        return { success: true, path: app.getPath('downloads') };
    });

    // 获取初始化提示词
    ipcMain.handle('get-init-prompt', async () => {
        try {
            const promptPath = path.join(__dirname, 'agent-prompt.md');
            const text = fs.readFileSync(promptPath, 'utf-8');
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
                fs.rmdirSync(filePath);
            } else {
                fs.unlinkSync(filePath);
            }
            return { success: true };
        } catch (error) {
            return { success: false, error: error.message };
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

// ==================== 浏览器工具 IPC 处理 ====================
function setupBrowserIPC() {
    // 获取浏览器工具临时目录
    function getBrowserTempDir() {
        var tempDir;
        if (currentRootDir) {
            tempDir = path.join(currentRootDir, BROWSER_TOOL_TEMP_DIR, BROWSER_TOOL_TEMP_SUBDIR);
        } else {
            tempDir = path.join(app.getPath('userData'), '.dsa-agent', BROWSER_TOOL_TEMP_DIR, BROWSER_TOOL_TEMP_SUBDIR);
        }
        if (!fs.existsSync(tempDir)) {
            fs.mkdirSync(tempDir, { recursive: true });
        }
        return tempDir;
    }

    // 创建浏览器窗口
    ipcMain.handle('browser-create', async (event, options) => {
        try {
            var id = ++browserWindowIdCounter;
            var winId = 'browser-' + id;

            var win = new BrowserWindow({
                width: options.width || 1024,
                height: options.height || 768,
                title: options.title || ('Browser Tool #' + id),
                webPreferences: {
                    nodeIntegration: false,
                    contextIsolation: true,
                    webSecurity: options.webSecurity !== false,
                },
                show: true,
                frame: options.frame !== false,
                autoHideMenuBar: true,
            });

            // 若有关闭窗口事件，自动清理
            win.on('closed', function() {
                browserToolWindows.delete(winId);
                console.log('[BrowserTool] Window closed:', winId);
            });

            // 加载 URL（如果有）
            if (options.url) {
                win.loadURL(options.url);
            }

            browserToolWindows.set(winId, win);
            console.log('[BrowserTool] Window created:', winId, options.url || '(blank)');

            return { success: true, id: winId };
        } catch (e) {
            return { success: false, error: e.message };
        }
    });

    // 在浏览器窗口中执行 JavaScript
    ipcMain.handle('browser-execute', async (event, winId, code) => {
        try {
            var win = browserToolWindows.get(winId);
            if (!win || win.isDestroyed()) {
                return { success: false, error: 'Browser window not found or closed: ' + winId };
            }
            var result = await win.webContents.executeJavaScript(code);
            return { success: true, result: result };
        } catch (e) {
            return { success: false, error: e.message };
        }
    });

    // 截取浏览器窗口截图
    ipcMain.handle('browser-screenshot', async (event, winId, saveName) => {
        try {
            var win = browserToolWindows.get(winId);
            if (!win || win.isDestroyed()) {
                return { success: false, error: 'Browser window not found or closed: ' + winId };
            }

            var image = await win.webContents.capturePage();
            var tempDir = getBrowserTempDir();
            var filename = (saveName || 'browser_screenshot_' + Date.now()) + '.png';
            var filePath = path.join(tempDir, filename);

            // 保存为 PNG
            fs.writeFileSync(filePath, image.toPNG());

            // 同时返回 base64 data URL 用于 Qwen 分析
            var dataUrl = 'data:image/png;base64,' + image.toPNG().toString('base64');

            console.log('[BrowserTool] Screenshot saved:', filePath);
            return { success: true, path: filePath, dataUrl: dataUrl, size: image.getSize() };
        } catch (e) {
            return { success: false, error: e.message };
        }
    });

    // 导航到 URL
    ipcMain.handle('browser-navigate', async (event, winId, url) => {
        try {
            var win = browserToolWindows.get(winId);
            if (!win || win.isDestroyed()) {
                return { success: false, error: 'Browser window not found or closed: ' + winId };
            }
            win.loadURL(url);
            return { success: true };
        } catch (e) {
            return { success: false, error: e.message };
        }
    });

    // 关闭浏览器窗口
    ipcMain.handle('browser-close', async (event, winId) => {
        try {
            var win = browserToolWindows.get(winId);
            if (!win || win.isDestroyed()) {
                // 已关闭，清理记录
                browserToolWindows.delete(winId);
                return { success: true, message: 'Window already closed' };
            }
            win.close();
            browserToolWindows.delete(winId);
            return { success: true };
        } catch (e) {
            return { success: false, error: e.message };
        }
    });

    // 列出所有浏览器窗口
    ipcMain.handle('browser-list', async () => {
        try {
            var windows = [];
            browserToolWindows.forEach(function(win, id) {
                var destroyed = win.isDestroyed();
                if (!destroyed) {
                    try {
                        var url = win.webContents.getURL();
                        var title = win.getTitle();
                        var size = win.getSize();
                        windows.push({
                            id: id,
                            url: url,
                            title: title,
                            width: size[0],
                            height: size[1]
                        });
                    } catch (e) {
                        windows.push({ id: id, url: '(error)', title: '(error)' });
                    }
                }
            });
            // 清理已销毁的窗口记录
            browserToolWindows.forEach(function(win, id) {
                if (win.isDestroyed()) browserToolWindows.delete(id);
            });
            return { success: true, windows: windows };
        } catch (e) {
            return { success: false, error: e.message };
        }
    });

    // 调整浏览器窗口大小
    ipcMain.handle('browser-resize', async (event, winId, width, height) => {
        try {
            var win = browserToolWindows.get(winId);
            if (!win || win.isDestroyed()) {
                return { success: false, error: 'Browser window not found or closed: ' + winId };
            }
            win.setSize(width, height);
            return { success: true };
        } catch (e) {
            return { success: false, error: e.message };
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
    rebuildMenu();  // 更新菜单中的勾选状态
}

// ==================== 创建菜单栏 ====================
function buildMenuTemplate() {
    const recent = loadRecentProjects();
    const reloadDeepseekItem = {
        label: '重载 DeepSeek 页面',
        accelerator: 'CmdOrCtrl+Shift+D',
        click: () => {
            if (deepseekView && !deepseekView.webContents.isDestroyed()) {
                const currentUrl = deepseekView.webContents.getURL();
                if (currentUrl && currentUrl !== 'about:blank') {
                    deepseekView.webContents.loadURL(currentUrl);
                } else {
                    deepseekView.webContents.loadURL(CONFIG.TARGET_URL);
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
                        } else if (deepseekView && !deepseekView.webContents.isDestroyed()) {
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
    // 所有视图始终在主窗口中，通过屏幕外定位控制可见性
    if (!agentViewVisible && !qwenVisible) {
        deepseekView.setBounds(contentBounds);
    } else {
        deepseekView.setBounds({ x: -10000, y: -10000, width: 1, height: 1 });
    }
    if (qwenView) {
        if (!agentViewVisible && qwenVisible) {
            qwenView.setBounds(contentBounds);
        } else {
            qwenView.setBounds({ x: -10000, y: -10000, width: 1, height: 1 });
        }
    }
    if (agentView) {
        if (agentViewVisible) {
            agentView.setBounds(contentBounds);
        } else {
            agentView.setBounds({ x: -10000, y: -10000, width: 1, height: 1 });
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

    // 创建浏览器窗口
    mainWindow = new BrowserWindow({
        width: CONFIG.WINDOW_WIDTH,
        height: CONFIG.WINDOW_HEIGHT,
        title: 'DeepSeek Local Agent',
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
        // 伪装 User-Agent
        qwenView.webContents.loadURL(QWEN_URL, {
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36'
        });
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
            const qwenScript = getQwenInjectScript();
            qwenView.webContents.executeJavaScript(qwenScript).catch(console.error);
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
    qwenView.setBounds({ x: -10000, y: -10000, width: 1, height: 1 });

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
                confirmMode: (agent.loadConfig().config && agent.loadConfig().config.confirmMode) || 'smart',
                theme: currentAppTheme
            });
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
    // 立即加入 Agent 视图到主窗口，置于屏幕外保持 JS 全速运行
    mainWindow.addBrowserView(agentView);
    agentView.webContents.setBackgroundThrottling(false);
    agentView.setBounds({ x: -10000, y: -10000, width: 1, height: 1 });

    // 设置布局

    mainWindow.on('resize', updateBounds);
    // 不再需要 move 同步（Qwen 在主窗口内）

    // 加载 DeepSeek 网页
    setupSession();
    deepseekView.webContents.loadURL(CONFIG.TARGET_URL);

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
        const injectScript = getInjectScript();
        deepseekView.webContents.executeJavaScript(injectScript).catch(console.error);
        // 检测是否需要登录
        setTimeout(() => checkLoginRequired(deepseekView, 'DeepSeek'), 3000);
    });

    // 更新布局
    setTimeout(updateBounds, 100);

    // 定期从 DeepSeek 页面获取状态并同步到控制栏
    setInterval(() => {
        if (deepseekView && controlBarView) {
            deepseekView.webContents.executeJavaScript(
                'window.__dsagent_getStatus && window.__dsagent_getStatus()'
            ).then(status => {
                if (status && controlBarView) {
                    status.qwenVisible = qwenVisible;
                    status.currentView = currentView;
                    
                    // 检查 Qwen 状态
                    if (qwenView && qwenView.webContents && !qwenView.webContents.isDestroyed()) {
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
                                    theme: currentAppTheme
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
        // 各视图创建完成后，setInterval 会广播主题
    }

    // 恢复文件夹
    if (state.lastRootDir && fs.existsSync(state.lastRootDir)) {
        setTimeout(() => {
            openFolder(state.lastRootDir);
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
        mainWindow.webContents.send('update-available', info);
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
    if (mainWindow) mainWindow.webContents.send('update-progress', progress);
});

autoUpdater.on('update-downloaded', () => {
    if (mainWindow) {
        dialog.showMessageBox(mainWindow, {
            type: 'info',
            title: '更新已下载',
            message: '更新已下载完成，是否立即重启安装？',
            buttons: ['重启', '稍后'],
            defaultId: 0,
            cancelId: 1
        }).then(({ response }) => {
            if (response === 0) autoUpdater.quitAndInstall();
        });
    }
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