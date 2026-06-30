// plugins/bot-feishu/index.js
// 飞书机器人插件入口。扫码一键创建应用（OAuth Device Flow）→ 拿 App ID/Secret → IM API 收发消息。

const proto = require('./protocol.js');
const FeishuBotClient = proto.FeishuBotClient;

let ctx = null;
let fsBotInstance = null;
let fsBotAuthorizedUser = null;
let fsBotVerifyCode = '';
let fsBotProcessing = false;
let fsBotPendingMessages = [];
let fsBotAwaitingConfirm = false;
let fsBotPowerSaveId = null;

function generateVerifyCode() {
    return String(Math.floor(1000 + Math.random() * 9000));
}

function forwardFsMessageToAgent(data) {
    const av = ctx.getAgentView();
    if (av && av.webContents && !av.webContents.isDestroyed()) {
        av.webContents.send('feishubot-message', data);
    }
}

// ==================== IPC 注册 ====================
function registerIPC() {
    const { ipcMain } = ctx;

    // 1. 发起扫码创建应用：返回二维码 PNG dataURL + 扫码页 URL
    ipcMain.handle('feishubot-start-login', async () => {
        try {
            await proto.initRegistration('feishu');
            const begin = await proto.beginRegistration('feishu');
            _pendingDeviceCode = begin.deviceCode;
            _pendingInterval = begin.interval;
            _pendingExpire = begin.expireIn;
            // 用 qrcode-generator 把扫码 URL 编码成 PNG dataURL
            var qrImg = null;
            try {
                const qrcode = require('qrcode-generator');
                const qrObj = qrcode(0, 'M');
                qrObj.addData(begin.qrUrl);
                qrObj.make();
                qrImg = qrObj.createDataURL(6, 4);
            } catch (e) { console.warn('[FeishuBot] QR 生成失败:', e.message); }
            return { success: true, qrUrl: begin.qrUrl, userCode: begin.userCode, expireIn: begin.expireIn, qrImg: qrImg };
        } catch (e) {
            console.error('[FeishuBot] 发起扫码失败:', e.message);
            return { success: false, error: e.message };
        }
    });

    // 2. 轮询扫码结果（前端定时调，或后端长轮询）
    let _pendingDeviceCode = null, _pendingInterval = 5, _pendingExpire = 600;
    ipcMain.handle('feishubot-poll-login', async () => {
        try {
            if (!_pendingDeviceCode) return { success: false, error: '无进行中的登录' };
            const r = await proto.pollRegistration({
                deviceCode: _pendingDeviceCode,
                interval: _pendingInterval,
                expireIn: 30,   // 单次 poll 最多等 30s
                initialDomain: 'feishu'
            });
            if (r.status === 'success') {
                const app = r.result;
                ctx.saveAppState({ feishuBotApp: app });
                _pendingDeviceCode = null;
                return { success: true, status: 'confirmed', app: app };
            }
            return { success: true, status: r.status };
        } catch (e) {
            return { success: false, error: e.message, status: 'polling' };
        }
    });

    // 3. 用已保存的 App ID/Secret 启动 bot
    ipcMain.handle('feishubot-start', async () => {
        try {
            if (fsBotInstance) { fsBotInstance.stop(); fsBotInstance = null; }
            const saved = ctx.loadAppState().feishuBotApp;
            if (!saved || !saved.appId || !saved.appSecret) {
                return { success: false, error: '未创建应用，请先扫码' };
            }
            if (fsBotPowerSaveId === null) {
                fsBotPowerSaveId = ctx.powerSaveBlocker.start('prevent-display-sleep');
            }
            fsBotInstance = new FeishuBotClient({
                appId: saved.appId, appSecret: saved.appSecret, domain: saved.domain || 'feishu',
                encryptKey: saved.encryptKey || ''
            });
            if (saved.authorizedUser) {
                fsBotAuthorizedUser = saved.authorizedUser;
                fsBotVerifyCode = '';
            } else {
                fsBotVerifyCode = generateVerifyCode();
                fsBotAuthorizedUser = null;
            }
            // 收消息事件处理（对照 cc-connect onMessage → dispatchCoreMessage）
            fsBotInstance.on('message', async function (msg) {
                console.log('[FeishuBot] 收到消息:', JSON.stringify(msg).substring(0, 200));
                var text = (msg.text || '').trim();
                var fromId = msg.from_user_id || '';
                var receiveId = msg.receive_id || fromId;
                var receiveIdType = msg.receive_id_type || 'open_id';
                var messageId = msg.message_id || '';
                var chatType = msg.chat_type || 'p2p';

                if (!fsBotAuthorizedUser) {
                    if (text === fsBotVerifyCode) {
                        fsBotAuthorizedUser = fromId;
                        ctx.saveAppState({ feishuBotApp: Object.assign({}, saved, { authorizedUser: fromId }) });
                        fsBotInstance.sendText(receiveIdType, receiveId, '✅ 验证通过，已建立远程连接。\n\n' + getStatusString()).catch(function (e) { console.error('[FeishuBot] 验证回复失败:', e.message); });
                        const av = ctx.getAgentView();
                        if (av && av.webContents) av.webContents.send('feishubot-authorized', { openid: fromId });
                    } else {
                        fsBotInstance.sendText(receiveIdType, receiveId, '❌ 校验码错误，请重新发送。').catch(function (e) { console.error('[FeishuBot] 错误回复失败:', e.message); });
                    }
                    return;
                }
                if (fromId !== fsBotAuthorizedUser) return;

                if (fsBotProcessing) {
                    fsBotPendingMessages.push(msg);
                    fsBotInstance.sendText(receiveIdType, receiveId, '⏳ 正在处理上一条消息，已排队（位置 ' + fsBotPendingMessages.length + '）').catch(function (e) { console.error('[FeishuBot] 排队提示失败:', e.message); });
                    return;
                }
                fsBotProcessing = true;
                forwardFsMessageToAgent({ content: text, openid: fromId, receiveId: receiveId, receiveIdType: receiveIdType, messageId: messageId, chatType: chatType });
            });

            fsBotInstance.on('error', function (e) { console.error('[FeishuBot] 错误:', e); });

            await fsBotInstance.start();
            return { success: true, verifyCode: fsBotVerifyCode };
        } catch (e) {
            console.error('[FeishuBot] 启动失败:', e);
            return { success: false, error: e.message };
        }
    });

    // 4. 停止
    ipcMain.handle('feishubot-stop', async () => {
        try {
            if (fsBotInstance) { fsBotInstance.stop(); fsBotInstance = null; }
            if (fsBotPowerSaveId !== null) { ctx.powerSaveBlocker.stop(fsBotPowerSaveId); fsBotPowerSaveId = null; }
            fsBotAuthorizedUser = null; fsBotVerifyCode = '';
            fsBotPendingMessages = []; fsBotProcessing = false;
            return { success: true };
        } catch (e) { return { success: false, error: e.message }; }
    });

    // 5. 状态
    ipcMain.handle('feishubot-status', () => {
        return {
            running: !!fsBotInstance,
            authorized: !!fsBotAuthorizedUser,
            openid: fsBotAuthorizedUser || null,
            verifyCode: fsBotVerifyCode,
            queueLength: fsBotPendingMessages.length,
            processing: fsBotProcessing
        };
    });

    // 6. Agent 回复
    ipcMain.on('feishubot-send-response', async (event, data) => {
        if (!fsBotInstance || !fsBotAuthorizedUser) return;
        try {
            if (data.text) {
                // 优先用消息来源的 receiveId/receiveIdType（群用 chat_id，私聊用 open_id）
                var rid = data.receiveId || fsBotAuthorizedUser;
                var rtype = data.receiveIdType || 'open_id';
                await fsBotInstance.sendText(rtype, rid, data.text);
            }
        } catch (e) { console.error('[FeishuBot] 回复失败:', e); }
        fsBotProcessing = false;
        if (fsBotPendingMessages.length > 0) {
            var next = fsBotPendingMessages.shift();
            fsBotProcessing = true;
            forwardFsMessageToAgent(next);
        }
    });

    // 7. 凭据管理
    ipcMain.handle('feishubot-list-robots', () => {
        var s = ctx.loadAppState();
        return s.feishuBotAccounts || [];
    });
    ipcMain.handle('feishubot-save-robot', (event, robot) => {
        var s = ctx.loadAppState();
        var arr = s.feishuBotAccounts || [];
        var i = -1;
        for (var k = 0; k < arr.length; k++) if (arr[k].id === robot.id) { i = k; break; }
        if (i >= 0) arr[i] = robot; else arr.push(robot);
        ctx.saveAppState({ feishuBotAccounts: arr });
        return { success: true, robots: arr };
    });
    ipcMain.handle('feishubot-delete-robot', (event, id) => {
        var s = ctx.loadAppState();
        var arr = (s.feishuBotAccounts || []).filter(function (r) { return r.id !== id; });
        ctx.saveAppState({ feishuBotAccounts: arr });
        return { success: true, robots: arr };
    });
}

function init(hostCtx) {
    ctx = hostCtx;
    registerIPC();
    console.log('[bot-feishu] 插件已初始化（Device Auth + IM API），IPC 已注册');
}

function getInstance() { return fsBotInstance; }
function getAuthorizedUser() { return fsBotAuthorizedUser; }
function setAwaitingConfirm(v) { fsBotAwaitingConfirm = v; }
function isAwaitingConfirm() { return fsBotAwaitingConfirm; }
function shutdown() { if (fsBotInstance) fsBotInstance.stop(); }

module.exports = {
    init, getInstance, getAuthorizedUser, setAwaitingConfirm, isAwaitingConfirm, shutdown
};
