// plugins/bot-qq/index.js
// QQ 机器人插件入口。从 main.js 抽离的全部 QQ Bot 业务逻辑。
// 通过 init(ctx) 接收宿主上下文，自行注册所有 qqbot-* / ctrl-show-qqbot IPC。
//
// ctx 必须提供：
//   ipcMain, path, fs, os, app, exec,
//   powerSaveBlocker, desktopCapturer, nativeImage,
//   loadAppState(patch?), saveAppState(patch),
//   getAgentView(), getDeepseekView(), getQwenView(),
//   getMainWindow(),
//   getAgentViewVisible(), getQwenVisible(),
//   getCurrentView(), getCurrentAppTheme(),
//   getCurrentRootDir(),
//   shellSend(channel, payload),
//   stopAll(),
//   agent: { loadConfig(), saveConfig(cfg) },
//   historyManager: { listHistories(dir), loadHistory(dir, id) },
//   VIEWBAR_WIDTH, SIDEBAR_WIDTH, CTRL_BAR_HEIGHT
//
// 设计：所有原 main.js 内闭包变量改为模块级变量，IPC 注册一次。

const QQBotClient = require('./protocol.js');
const localtunnel = require('localtunnel');

// ==================== 模块级状态 ====================
let qqBotInstance = null;
let qqBotPowerSaveId = null;
let qqBotAuthorizedUser = null;   // 校验通过的用户 openid
let qqBotVerifyCode = '';
let qqBotPendingMessages = [];     // 等待队列
let qqBotProcessing = false;       // 是否正在处理
let qqBotAwaitingConfirm = false;  // 是否正在等待用户确认
let tunnelCache = {};              // port -> { url, tunnel }

// ==================== 宿主上下文（init 时注入） ====================
let ctx = null;

// ==================== 辅助函数 ====================
function generateVerifyCode() {
    return String(Math.floor(1000 + Math.random() * 9000));
}

function forwardQQMessageToAgent(data) {
    const av = ctx.getAgentView();
    if (av && av.webContents && !av.webContents.isDestroyed()) {
        av.webContents.send('qqbot-message', data);
    }
}

// 统一回复分发：群消息走 sendGroupMessage，私聊走 sendC2CMessage
// 对照 cc-connect sendMessage 按 messageType 选 /v2/groups/ 或 /v2/users/ 路径
async function qqReply(msg, text) {
    if (!qqBotInstance) return;
    try {
        if (msg && msg.scope === 'group' && msg.groupOpenId) {
            await qqBotInstance.sendGroupMessage(msg.groupOpenId, text, msg.msgId);
        } else if (msg && msg.openid) {
            await qqBotInstance.sendText(msg.openid, text, msg.msgId);
        }
    } catch (e) {
        console.error('[QQBot] qqReply 发送失败:', e.response?.data || e.message);
    }
}

// 群消息发图片分发（截图指令用）
async function qqReplyImage(msg, imgPath) {
    if (!qqBotInstance) return;
    try {
        // 群消息暂只支持文本回复，图片回退为提示（群 rich media 需另上传 channel）
        if (msg && msg.scope === 'group' && msg.groupOpenId) {
            await qqBotInstance.sendGroupMessage(msg.groupOpenId, '📸 截图已生成：' + imgPath + '（群消息暂不支持直接发图，请私聊查看）', msg.msgId);
        } else if (msg && msg.openid) {
            await qqBotInstance.sendImage(msg.openid, imgPath, msg.msgId);
        }
    } catch (e) {
        console.error('[QQBot] qqReplyImage 发送失败:', e.response?.data || e.message);
    }
}

// 群消息发按钮键盘分发（/help 指令用）
async function qqReplyKeyboard(msg, text, buttons) {
    if (!qqBotInstance) return;
    try {
        if (msg && msg.scope === 'group' && msg.groupOpenId) {
            // 群消息不支持 keyboard，回退纯文本
            await qqBotInstance.sendGroupMessage(msg.groupOpenId, text, msg.msgId);
        } else if (msg && msg.openid) {
            await qqBotInstance.sendKeyboard(msg.openid, text, buttons, msg.msgId);
        }
    } catch (e) {
        console.error('[QQBot] qqReplyKeyboard 发送失败:', e.response?.data || e.message);
    }
}

function getLanIP() {
    const interfaces = ctx.os.networkInterfaces();
    for (const name in interfaces) {
        const iface = interfaces[name];
        if (!iface) continue;
        for (let i = 0; i < iface.length; i++) {
            const addr = iface[i];
            if (addr.family === 'IPv4' && !addr.internal) {
                return addr.address;
            }
        }
    }
    return '127.0.0.1';
}

function extractPort(url) {
    const m = url.match(/:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0):(\d+)/);
    return m ? parseInt(m[1]) : null;
}

function replaceLocalhostUrls(text, netMode) {
    const urlRegex = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0)(:\d+)?(\/[^\s]*)?/gi;
    return text.replace(urlRegex, function (matched) {
        const port = extractPort(matched);
        if (netMode === 'wan' && port) {
            const p = matched.replace(/^https?:\/\/[^\/]+/, '') || '/';
            return '__DSAGENT_TUNNEL_' + port + '__' + p;
        }
        const lanIP = getLanIP();
        return matched.replace(/(?:localhost|127\.0\.0\.1|0\.0\.0\.0)/i, lanIP);
    });
}

async function replaceWithTunnels(text) {
    const tunnelMarkers = text.match(/__DSAGENT_TUNNEL_\d+__[^\s]*/g);
    if (!tunnelMarkers) return text;

    for (let i = 0; i < tunnelMarkers.length; i++) {
        const marker = tunnelMarkers[i];
        const portMatch = marker.match(/__DSAGENT_TUNNEL_(\d+)__(\/[^\s]*)?/);
        if (!portMatch) continue;
        const port = parseInt(portMatch[1]);
        const p = portMatch[2] || '/';

        try {
            let tunnelUrl;
            if (tunnelCache[port] && tunnelCache[port].url) {
                tunnelUrl = tunnelCache[port].url;
            } else {
                console.log('[Tunnel] Creating tunnel for port', port);
                const tunnel = await localtunnel({ port: port, local_host: '127.0.0.1' });
                tunnelUrl = tunnel.url;
                tunnelCache[port] = { url: tunnelUrl, tunnel: tunnel };
                console.log('[Tunnel] Created:', tunnelUrl);
                tunnel.on('close', function () {
                    console.log('[Tunnel] Closed for port', port);
                    delete tunnelCache[port];
                });
                tunnel.on('error', function (err) {
                    console.error('[Tunnel] Error for port', port, err.message);
                    delete tunnelCache[port];
                });
            }
            text = text.replace(marker, tunnelUrl + p);
        } catch (e) {
            console.error('[Tunnel] Failed to create tunnel for port', port, e.message);
            const lanIP = getLanIP();
            text = text.replace(marker, 'http://' + lanIP + ':' + port + p);
        }
    }
    return text;
}

function getQQBotNetMode() {
    const state = ctx.loadAppState();
    return state.qqBotNetMode || 'lan';
}

function getQQBotStatusString() {
    const state = ctx.loadAppState();
    const deepthink = state.qqBotDeepThink !== false;
    const mode = state.qqBotMode || 'expert';
    const confirmMode = state.qqBotConfirmMode || 'smart';
    const modeLabels = { smart: '智能', strict: '严格', loose: '宽松', readonly: '只读', custom: '自定义' };
    const workDir = state.qqBotDir || ctx.getCurrentRootDir() || '.';
    let s = '📋 当前状态\n';
    s += '• 深度思考: ' + (deepthink ? '✅ 开启' : '❌ 关闭') + '\n';
    s += '• 对话模式: ' + (mode === 'expert' ? '专家' : '快速') + '\n';
    s += '• 信任模式: ' + (modeLabels[confirmMode] || confirmMode) + '\n';
    s += '• 工作目录: ' + workDir + '\n';
    s += '\n可用指令:\n/new [quick|expert] [deep|nodeep] 新对话\n/d 切换深度思考\n/m <模式> 信任模式\n/cd <路径> 切换目录\n/l 对话列表 / /sw <编号> 切换\n/sc 截屏 / /sct 窗口截图\n/s 状态 / /stop 停止 / /h 帮助';
    return s;
}

// ==================== 指令处理 ====================
async function handleQQBotCommand(text, msg) {
    const cmd = text.split(/\s+/);
    const main = cmd[0].toLowerCase();
    const dsView = ctx.getDeepseekView();
    const av = ctx.getAgentView();

    if (main === '/help' || main === '/h' || main === '帮助') {
        const s = getQQBotStatusString();
        await qqReplyKeyboard(msg, s, [
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
        await qqReply(msg, getQQBotStatusString());
        return true;
    }

    if (main === '/deep' || main === '/d' || main === '/deepthink') {
        const state = ctx.loadAppState();
        const current = state.qqBotDeepThink !== false;
        ctx.saveAppState({ qqBotDeepThink: !current });
        try {
            if (dsView && dsView.webContents && !dsView.webContents.isDestroyed()) {
                dsView.webContents.executeJavaScript(
                    'if (window.__dsagent_toggleDeepThink) window.__dsagent_toggleDeepThink(' + (!current) + ')'
                );
            }
        } catch (e) { /* ignore */ }
        if (av && av.webContents) {
            av.webContents.send('qqbot-command', { action: 'toggleDeepThink', value: !current });
        }
        await qqReply(msg, '🧠 深度思考已' + (!current ? '开启' : '关闭'));
        return true;
    }

    if (main === '/mode' || main === '/m') {
        const state2 = ctx.loadAppState();
        const modes = ['smart', 'strict', 'loose', 'readonly', 'custom'];
        const labels = { smart: '智能', strict: '严格', loose: '宽松', readonly: '只读', custom: '自定义' };
        if (cmd.length >= 2 && modes.indexOf(cmd[1]) >= 0) {
            const newMode = cmd[1];
            ctx.saveAppState({ qqBotConfirmMode: newMode });
            try {
                const cfgRes = ctx.agent.loadConfig();
                const cfg = cfgRes.config || {};
                cfg.confirmMode = newMode;
                ctx.agent.saveConfig(cfg);
            } catch (e) { console.warn('[QQBot] save confirm mode to config failed:', e.message); }

            if (dsView) {
                dsView.webContents.executeJavaScript(
                    `window.__dsagent_setConfirmMode && window.__dsagent_setConfirmMode(${JSON.stringify(newMode)}, true);`
                ).catch(() => {});
            }
            if (av && av.webContents) {
                av.webContents.send('qqbot-command', { action: 'setConfirmMode', value: newMode });
            }
            ctx.shellSend('ctrl-viewbar-status', {
                currentView: ctx.getCurrentView(),
                dsState: 'idle',
                qwenState: 'idle',
                confirmMode: newMode,
                theme: ctx.getCurrentAppTheme()
            });
            await qqReply(msg, '🔒 信任模式已设为: ' + labels[newMode]);
        } else {
            const curMode = state2.qqBotConfirmMode || 'smart';
            const msg2 = '🔒 当前信任模式: ' + (labels[curMode] || curMode) + ' (' + curMode + ')\n可切换: /mode smart（智能）/ strict（严格）/ loose（宽松）/ readonly（只读）/ custom（自定义）';
            await qqReply(msg, msg2);
        }
        return true;
    }

    if (main === '/cd' || main === '/chdir') {
        if (cmd.length >= 2) {
            const newDir = cmd.slice(1).join(' ');
            try {
                if (ctx.fs.existsSync(newDir) && ctx.fs.statSync(newDir).isDirectory()) {
                    ctx.saveAppState({ qqBotDir: newDir });
                    if (av && av.webContents) {
                        av.webContents.send('qqbot-command', { action: 'changeDir', value: newDir });
                    }
                    ctx.shellSend('root-changed', newDir);
                    await qqReply(msg, '📂 工作目录已切换至: ' + newDir);
                } else {
                    await qqReply(msg, '❌ 目录不存在: ' + newDir);
                }
            } catch (e) {
                await qqReply(msg, '❌ 切换失败: ' + e.message);
            }
        } else {
            const curDir = ctx.loadAppState().qqBotDir || ctx.getCurrentRootDir() || '.';
            await qqReply(msg, '📂 当前工作目录: ' + curDir + '\n使用 /cd <路径> 切换');
        }
        return true;
    }

    if (main === '/new' || main === '/n') {
        let mode3 = 'expert';
        if (cmd.length >= 2 && (cmd[1] === 'quick' || cmd[1] === 'expert')) mode3 = cmd[1];
        const deepVal = cmd.indexOf('nodeep') >= 0 ? false : (cmd.indexOf('deep') >= 0 ? true : null);
        const state3 = ctx.loadAppState();
        if (deepVal !== null) { ctx.saveAppState({ qqBotDeepThink: deepVal }); }
        ctx.saveAppState({ qqBotMode: mode3 });
        let newUrl = '';
        try {
            if (dsView && dsView.webContents && !dsView.webContents.isDestroyed()) {
                const execCode = 'if (window.__dsagent_newChatAndSendInit) window.__dsagent_newChatAndSendInit("' + mode3 + '", ' + (deepVal !== null ? deepVal : state3.qqBotDeepThink !== false) + ')';
                await dsView.webContents.executeJavaScript(execCode);
                await new Promise(function (r) { setTimeout(r, 500); });
                newUrl = await dsView.webContents.executeJavaScript('window.location.href');
            }
        } catch (e) { /* ignore */ }
        if (av && av.webContents) {
            av.webContents.send('qqbot-command', { action: 'newChat', mode: mode3, deepthink: deepVal !== null ? deepVal : state3.qqBotDeepThink !== false, url: newUrl });
        }
        await qqReply(msg, '🔄 已开始新对话（模式: ' + (mode3 === 'expert' ? '专家' : '快速') + '）');
        return true;
    }

    if (main === '/list' || main === '/l') {
        try {
            const listDir = ctx.getCurrentRootDir() || ctx.app.getPath('userData');
            const histories = ctx.historyManager.listHistories(listDir);
            if (!histories || histories.length === 0) {
                await qqReply(msg, '📋 没有找到任何历史对话。发送 /new 开始一个新对话。');
            } else {
                const lines = ['📋 历史对话列表：'];
                const limit = Math.min(histories.length, 30);
                for (let li = 0; li < limit; li++) {
                    const h = histories[li];
                    const prefix = (li + 1) < 10 ? ' ' : '';
                    const title = (h.title || '(无标题)').substring(0, 40);
                    const modeInfo = (h.mode || 'expert') + (h.deepthink ? '+深' : '');
                    const msgCount = h.messageCount || 0;
                    lines.push(prefix + (li + 1) + '. ' + title + ' [' + modeInfo + ' ' + msgCount + '条]');
                }
                if (histories.length > 30) lines.push('... 还有 ' + (histories.length - 30) + ' 个');
                lines.push('');
                lines.push('发送 /sw <编号>（或 /switch <编号>）切换对话');
                await qqReply(msg, lines.join('\n'));
            }
        } catch (e) {
            await qqReply(msg, '❌ 获取对话列表失败: ' + e.message);
        }
        return true;
    }

    if (main === '/switch' || main === '/sw') {
        const swIdx = parseInt(cmd[1], 10);
        if (isNaN(swIdx) || swIdx < 1) {
            await qqReply(msg, '❌ 请指定有效的对话编号。使用 /l 查看所有对话。');
            return true;
        }
        try {
            const listDir = ctx.getCurrentRootDir() || ctx.app.getPath('userData');
            const histories = ctx.historyManager.listHistories(listDir);
            if (!histories || swIdx > histories.length) {
                await qqReply(msg, '❌ 对话编号超出范围（1-' + (histories.length || 0) + '）');
                return true;
            }
            const target = histories[swIdx - 1];
            const fullHistory = ctx.historyManager.loadHistory(listDir, target.id);
            if (!fullHistory) {
                await qqReply(msg, '❌ 该对话记录已不存在（可能已被删除）');
                return true;
            }
            if (av && av.webContents && !av.webContents.isDestroyed()) {
                av.webContents.send('restore-history-conversation', target.id);
                await qqReply(msg, '✅ 已切换到: ' + (target.title || '(未命名对话)'));
            } else {
                await qqReply(msg, '❌ Agent 页面未加载');
            }
        } catch (e) {
            await qqReply(msg, '❌ 切换对话失败: ' + e.message);
        }
        return true;
    }

    if (main === '/screenshot' || main === '/sc') {
        try {
            const ssTempDir = ctx.path.join(ctx.getCurrentRootDir() || ctx.app.getPath('userData'), '.dsa', 'temp');
            if (!ctx.fs.existsSync(ssTempDir)) ctx.fs.mkdirSync(ssTempDir, { recursive: true });
            const ssFilename = 'screenshot_' + Date.now() + '.png';
            const ssPath = ctx.path.join(ssTempDir, ssFilename);

            let captured = false;
            try {
                const sources = await ctx.desktopCapturer.getSources({
                    types: ['screen'],
                    thumbnailSize: { width: 3840, height: 2160 }
                });
                const electronScreen = require('electron').screen;
                const winBounds = ctx.getMainWindow().getBounds();
                const targetDisplay = electronScreen.getDisplayMatching(winBounds);
                let source = null;
                for (let si = 0; si < sources.length; si++) {
                    if (String(sources[si].display_id) === String(targetDisplay.id)) {
                        source = sources[si];
                        break;
                    }
                }
                if (!source && sources.length > 0) source = sources[0];

                if (source && source.thumbnail && !source.thumbnail.isEmpty()) {
                    ctx.fs.writeFileSync(ssPath, source.thumbnail.toPNG());
                    captured = true;
                    console.log('[QQBot] 截图方式: desktopCapturer');
                }
            } catch (e) {
                console.log('[QQBot] desktopCapturer 异常:', e.message);
            }

            if (!captured) {
                console.log('[QQBot] 截图回退到 PowerShell');
                try {
                    const psTempPath = ssPath.replace('.png', '_raw.png');
                    const psScriptContent =
                        'Add-Type -AssemblyName System.Drawing, System.Windows.Forms\r\n' +
                        '$s = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds\r\n' +
                        '$b = New-Object System.Drawing.Bitmap $s.Width, $s.Height\r\n' +
                        '$g = [System.Drawing.Graphics]::FromImage($b)\r\n' +
                        '$g.CopyFromScreen($s.X, $s.Y, 0, 0, $s.Size)\r\n' +
                        '$b.Save("' + psTempPath.replace(/\\/g, '\\\\') + '")\r\n' +
                        '$g.Dispose(); $b.Dispose()';
                    const psFile = ctx.path.join(ssTempDir, '_capture.ps1');
                    ctx.fs.writeFileSync(psFile, psScriptContent, 'utf-8');
                    await new Promise(function (resolve, reject) {
                        ctx.exec('powershell -NoProfile -ExecutionPolicy Bypass -File "' + psFile + '"', { timeout: 15000 }, function (err, stdout) {
                            if (err) { reject(err); return; }
                            resolve(stdout);
                        });
                    });
                    try { ctx.fs.unlinkSync(psFile); } catch (e) {}

                    if (ctx.fs.existsSync(psTempPath)) {
                        const psBuffer = ctx.fs.readFileSync(psTempPath);
                        const psImg = ctx.nativeImage.createFromBuffer(psBuffer);
                        if (!psImg.isEmpty()) {
                            ctx.fs.writeFileSync(ssPath, psImg.toPNG());
                            captured = true;
                            console.log('[QQBot] 截图方式: PowerShell');
                        }
                        try { ctx.fs.unlinkSync(psTempPath); } catch (e) {}
                    }
                } catch (e) {
                    console.log('[QQBot] PowerShell 截图也失败:', e.message);
                }
            }

            if (!captured) {
                console.log('[QQBot] 截图回退到 capturePage');
                try {
                    const capImg = await ctx.getMainWindow().webContents.capturePage();
                    if (capImg && !capImg.isEmpty()) {
                        ctx.fs.writeFileSync(ssPath, capImg.toPNG());
                        captured = true;
                    }
                } catch (e) {
                    console.log('[QQBot] capturePage 也失败:', e.message);
                }
            }

            if (ctx.fs.existsSync(ssPath)) {
                const stats = ctx.fs.statSync(ssPath);
                await qqReplyImage(msg, ssPath);
                console.log('[QQBot] 截图已发送:', ssPath, '(' + Math.round(stats.size / 1024) + 'KB)');
            } else {
                await qqReply(msg, '❌ 截图保存失败（窗口截图可能被系统阻止）');
            }
        } catch (e) {
            console.error('[QQBot] 截图失败:', e);
            await qqReply(msg, '❌ 截图失败: ' + e.message);
        }
        return true;
    }

    if (main === '/sct' || main === '/sct:') {
        try {
            let targetView = null;
            let viewName = '';
            if (ctx.getAgentViewVisible()) {
                targetView = ctx.getAgentView();
                viewName = 'Agent';
            } else if (ctx.getQwenVisible()) {
                targetView = ctx.getQwenView();
                viewName = 'Qwen';
            } else {
                targetView = dsView;
                viewName = 'DeepSeek';
            }

            if (!targetView || targetView.webContents.isDestroyed()) {
                await qqReply(msg, '❌ 当前视图不可用');
                return true;
            }

            console.log('[QQBot] /sct 截取窗口: ' + viewName);

            const sctTempDir = ctx.path.join(ctx.getCurrentRootDir() || ctx.app.getPath('userData'), '.dsa', 'temp');
            if (!ctx.fs.existsSync(sctTempDir)) ctx.fs.mkdirSync(sctTempDir, { recursive: true });
            const sctFilename = 'screenshot_win_' + Date.now() + '.png';
            const sctPath = ctx.path.join(sctTempDir, sctFilename);

            const winSize = ctx.getMainWindow().getContentBounds();
            const contentX = ctx.VIEWBAR_WIDTH;
            const contentWidth = winSize.width - ctx.VIEWBAR_WIDTH - ctx.SIDEBAR_WIDTH;
            const contentHeight = winSize.height - ctx.CTRL_BAR_HEIGHT;

            const origBounds = targetView.getBounds();
            const wasOffscreen = origBounds.width < 10 || origBounds.x < 0;

            if (wasOffscreen) {
                targetView.setBounds({
                    x: contentX, y: 0,
                    width: contentWidth, height: contentHeight
                });
                await new Promise(function (r) { setTimeout(r, 300); });
            }

            let captured = false;
            try {
                const capImg = await targetView.webContents.capturePage();
                if (capImg && !capImg.isEmpty()) {
                    ctx.fs.writeFileSync(sctPath, capImg.toPNG());
                    captured = true;
                    console.log('[QQBot] /sct 截图方式: capturePage, 视图: ' + viewName);
                }
            } catch (e) {
                console.log('[QQBot] /sct capturePage 失败:', e.message);
            }

            if (wasOffscreen) {
                targetView.setBounds(origBounds);
            }

            if (captured && ctx.fs.existsSync(sctPath)) {
                const sctStats = ctx.fs.statSync(sctPath);
                await qqReplyImage(msg, sctPath);
                console.log('[QQBot] /sct 截图已发送:', sctPath, '(' + Math.round(sctStats.size / 1024) + 'KB) 视图: ' + viewName);
            } else {
                await qqReply(msg, '❌ 截图失败（' + viewName + ' 视图不可用）');
            }
        } catch (e) {
            console.error('[QQBot] /sct 截图失败:', e);
            await qqReply(msg, '❌ 截图失败: ' + e.message);
        }
        return true;
    }

    if (main === '/stop') {
        try {
            await ctx.stopAll();
        } catch (e) { /* ignore */ }
        if (av && av.webContents) {
            av.webContents.send('qqbot-command', { action: 'stop' });
        }
        await qqReply(msg, '⏹️ 已停止');
        return true;
    }

    return false;
}

// ==================== IPC 注册 ====================
function registerIPC() {
    const { ipcMain, path, fs, app } = ctx;

    // 显示 QQ 托管弹窗
    ipcMain.on('ctrl-show-qqbot', () => {
        const av = ctx.getAgentView();
        if (av && av.webContents && !av.webContents.isDestroyed()) {
            av.webContents.send('agent-message', { _toolbarModal: 'qqbot' });
        }
    });

    // 启动 QQ Bot
    ipcMain.handle('qqbot-start', async (event, config) => {
        try {
            if (qqBotInstance) {
                qqBotInstance.removeAllListeners();
                qqBotInstance.ws && qqBotInstance.ws.close();
                qqBotInstance = null;
            }

            if (qqBotPowerSaveId === null) {
                qqBotPowerSaveId = ctx.powerSaveBlocker.start('prevent-display-sleep');
                console.log('[QQBot] 已阻止屏幕休眠, id:', qqBotPowerSaveId);
            }

            qqBotInstance = new QQBotClient({
                appId: config.appId,
                clientSecret: config.clientSecret,
                gatewayUrl: config.gatewayUrl || 'wss://sandbox.api.sgroup.qq.com/websocket',
                intents: (1 << 1) | (1 << 25) | (1 << 26),
                apiBase: 'https://api.sgroup.qq.com',
                imagePath: config.imagePath || './1.png',
                tempDir: config.tempDir || path.join(ctx.getCurrentRootDir() || '.', '.dsa', 'temp')
            });

            const savedState = ctx.loadAppState();
            if (savedState.qqBotSavedUser) {
                qqBotAuthorizedUser = savedState.qqBotSavedUser;
                qqBotVerifyCode = '';
                console.log('[QQBot] 已恢复保存的用户:', qqBotAuthorizedUser);
            } else {
                qqBotVerifyCode = generateVerifyCode();
                qqBotAuthorizedUser = null;
            }

            const dsView = ctx.getDeepseekView();
            const av = ctx.getAgentView();

            qqBotInstance.on('message', async (msg) => {
                console.log('[QQBot] 收到消息 from:', msg.openid, 'content:', msg.content);
                const text = (msg.content || '').trim();

                if (!qqBotAuthorizedUser) {
                    if (text === qqBotVerifyCode) {
                        qqBotAuthorizedUser = msg.openid;
                        console.log('[QQBot] 用户验证通过:', msg.openid);
                        ctx.saveAppState({ qqBotSavedUser: msg.openid });
                        const statusStr = getQQBotStatusString();
                        qqReply(msg, '✅ 验证通过，已建立远程连接。\n\n' + statusStr);
                        if (av && av.webContents) {
                            av.webContents.send('qqbot-authorized', { openid: msg.openid });
                        }
                    } else {
                        qqReply(msg, '❌ 校验码错误，请重新发送。');
                    }
                    return;
                }

                if (msg.openid !== qqBotAuthorizedUser) return;

                if (text.startsWith('/')) {
                    const handled = await handleQQBotCommand(text, msg);
                    if (handled) return;
                }

                if (qqBotAwaitingConfirm) {
                    console.log('[QQBot] 跳过确认回复，不转发 AI');
                    return;
                }
                if (qqBotProcessing) {
                    qqBotPendingMessages.push(msg);
                    qqReply(msg, '⏳ 正在处理上一条消息，已加入等待队列（位置 ' + qqBotPendingMessages.length + '）');
                    return;
                }

                try {
                    if (dsView && dsView.webContents && !dsView.webContents.isDestroyed()) {
                        const dsUrl = await dsView.webContents.executeJavaScript('window.location.href');
                        const dsBody = await dsView.webContents.executeJavaScript('document.body ? document.body.textContent.length > 100 : false');
                        if (!dsUrl || !dsUrl.includes('/chat/')) {
                            if (text) {
                                qqReply(msg, '⚠️ 当前没有活跃的对话。请先发送 /new 开始新对话，或使用 /list 查看已有对话后用 /switch <编号> 切换。');
                            }
                            return;
                        }
                    }
                } catch (e) {
                    console.log('[QQBot] 检查对话状态失败:', e.message);
                }

                qqBotProcessing = true;
                forwardQQMessageToAgent(msg);
            });

            qqBotInstance.on('interaction', async (intData) => {
                console.log('[QQBot] 按钮交互:', intData.buttonData);
                const data = intData.buttonData || '';
                const cmds = ['/n', '/d', '/s', '/l', '/stop', '/sc'];
                if (cmds.indexOf(data) >= 0) {
                    await handleQQBotCommand(data, { openid: intData.userOpenid, msgId: null });
                }
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

    // 停止 QQ Bot
    ipcMain.handle('qqbot-stop', async () => {
        try {
            if (qqBotInstance) {
                qqBotInstance.removeAllListeners();
                qqBotInstance.ws && qqBotInstance.ws.close();
                qqBotInstance = null;
            }
            if (qqBotPowerSaveId !== null) {
                ctx.powerSaveBlocker.stop(qqBotPowerSaveId);
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

    // 查询状态
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
        ctx.saveAppState({ qqBotNetMode: mode });
        for (const port in tunnelCache) {
            try { tunnelCache[port].tunnel.close(); } catch (e) {}
        }
        tunnelCache = {};
        return { success: true, mode: mode };
    });

    // Agent 发送 QQ 回复
    ipcMain.on('qqbot-send-response', async (event, data) => {
        if (!qqBotInstance || !qqBotAuthorizedUser) return;
        const openid = qqBotAuthorizedUser;
        const msgId = data.msgId || null;

        try {
            if (data.text) {
                const netMode = getQQBotNetMode();
                let text = replaceLocalhostUrls(data.text, netMode);
                text = await replaceWithTunnels(text);
                await qqBotInstance.sendText(openid, text, msgId);
            }
            if (data.files && data.files.length > 0) {
                for (let fi = 0; fi < data.files.length; fi++) {
                    const fp = data.files[fi];
                    try {
                        const ext = path.extname(fp).toLowerCase();
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

        qqBotProcessing = false;
        if (qqBotPendingMessages.length > 0) {
            const next = qqBotPendingMessages.shift();
            qqBotProcessing = true;
            forwardQQMessageToAgent(next);
        }
    });

    // Robot 配置管理
    ipcMain.handle('qqbot-list-robots', () => {
        const state = ctx.loadAppState();
        return state.qqRobots || [];
    });

    ipcMain.handle('qqbot-save-robot', (event, robot) => {
        const state = ctx.loadAppState();
        const robots = state.qqRobots || [];
        let idx = -1;
        for (let ri = 0; ri < robots.length; ri++) {
            if (robots[ri].id === robot.id) { idx = ri; break; }
        }
        if (idx >= 0) {
            if (robot._keepSecret && !robot.clientSecret) {
                robot.clientSecret = robots[idx].clientSecret;
            }
            delete robot._keepSecret;
            robots[idx] = robot;
        } else {
            delete robot._keepSecret;
            robots.push(robot);
        }
        ctx.saveAppState({ qqRobots: robots });
        return { success: true, robots: robots };
    });

    ipcMain.handle('qqbot-delete-robot', (event, robotId) => {
        const state = ctx.loadAppState();
        const robots = (state.qqRobots || []).filter(function (r) { return r.id !== robotId; });
        ctx.saveAppState({ qqRobots: robots });
        return { success: true, robots: robots };
    });
}

// ==================== 对外 API（供宿主调用） ====================
function getInstance() { return qqBotInstance; }
function getAuthorizedUser() { return qqBotAuthorizedUser; }

function notifyPlanSync(planText) {
    if (qqBotInstance && qqBotAuthorizedUser) {
        return qqBotInstance.sendText(qqBotAuthorizedUser, planText);
    }
    return Promise.resolve();
}

function shutdown() {
    for (const port in tunnelCache) {
        try {
            tunnelCache[port].tunnel.close();
            console.log('[Tunnel] Closed for port', port);
        } catch (e) {}
    }
    tunnelCache = {};
}

// ==================== 插件入口 ====================
function init(hostCtx) {
    ctx = hostCtx;
    registerIPC();
    console.log('[bot-qq] 插件已初始化，IPC 已注册');
}

module.exports = {
    init,
    getInstance,
    getAuthorizedUser,
    notifyPlanSync,
    shutdown,
    // 状态访问器（供宿主做计划同步等零散调用）
    setAwaitingConfirm: function (v) { qqBotAwaitingConfirm = v; },
    isAwaitingConfirm: function () { return qqBotAwaitingConfirm; }
};
