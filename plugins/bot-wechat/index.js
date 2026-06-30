// plugins/bot-wechat/index.js
// 微信机器人插件入口。iLink Bot API（腾讯官方），扫码登录 + 长轮询收消息。
// 复用 QQ 插件的校验码/转发模型，但凭据是扫码后拿到的 bot_token（非 AppID/Secret）。

const proto = require('./protocol.js');
const WeixinBotClient = proto.WeixinBotClient;

let ctx = null;
let wxBotInstance = null;
let wxBotAuthorizedUser = null;   // 已授权的 ilink_user_id
let wxBotVerifyCode = '';
let wxBotProcessing = false;
let wxBotPendingMessages = [];
let wxBotAwaitingConfirm = false;
let wxBotPowerSaveId = null;

function generateVerifyCode() {
    return String(Math.floor(1000 + Math.random() * 9000));
}

function forwardWxMessageToAgent(data) {
    const av = ctx.getAgentView();
    if (av && av.webContents && !av.webContents.isDestroyed()) {
        av.webContents.send('wechatbot-message', data);
    }
}

function getStatusString() {
    return '📋 微信机器人状态\n' +
        '• 授权用户: ' + (wxBotAuthorizedUser || '未授权') + '\n' +
        '• 处理中: ' + (wxBotProcessing ? '是' : '否') + '\n' +
        '• 队列: ' + wxBotPendingMessages.length + ' 条';
}

// ==================== IPC 注册 ====================
function registerIPC() {
    const { ipcMain, fs, path, app } = ctx;

    // 1. 发起扫码登录：返回二维码 PNG dataURL（前端直接 <img src>）
    ipcMain.handle('wechatbot-start-login', async () => {
        try {
            const base = proto.DEFAULT_BASE_URL;
            const qr = await proto.fetchQrCode(base, proto.DEFAULT_BOT_TYPE);
            const qrUrl = qr.qrcode_img_content;
            // 用 qrcode-generator 把扫码 URL 编码成 PNG dataURL（扫码页是 HTML，不能直接 <img>）
            var qrImg = null;
            try {
                const qrcode = require('qrcode-generator');
                const qrObj = qrcode(0, 'M');
                qrObj.addData(qrUrl);
                qrObj.make();
                qrImg = qrObj.createDataURL(6, 4);
            } catch (e) { console.warn('[WechatBot] QR 生成失败，回退 URL:', e.message); }
            return { success: true, qrcodeUrl: qrUrl, qrcode: qr.qrcode, qrImg: qrImg };
        } catch (e) {
            console.error('[WechatBot] 获取二维码失败:', e.message);
            return { success: false, error: e.message };
        }
    });

    // 2. 轮询扫码状态（后端跑完整 cc-connect 循环：for { poll(35s long); switch status; sleep 1s }）
    // 前端只调一次，等待最终结果。中间状态通过 event.sender.send('wechatbot-poll-status', data) 推送。
    // 对照 cc-connect runWeixinQRLoginFlow 完全一致的行为。
    const MAX_QR_REFRESH = 3;
    const QR_PROACTIVE_REFRESH_AT = 80000;
    let _pollQrKey = '';
    let _pollRefreshCount = 1;
    let _pollQrFetchedAt = 0;
    let _pollScannedPrinted = false;
    ipcMain.handle('wechatbot-poll-login', async (event, qrcode) => {
        _pollQrKey = qrcode;
        _pollRefreshCount = 1;
        _pollQrFetchedAt = Date.now();
        _pollScannedPrinted = false;
        const deadline = Date.now() + 480000;  // 8min timeout
        const pushStatus = (data) => { try { event.sender.send('wechatbot-poll-status', data); } catch (_) {} };

        while (Date.now() < deadline) {
            try {
                const st = await proto.pollQrStatus(proto.DEFAULT_BASE_URL, _pollQrKey);
                switch (st.status) {
                    case 'wait':
                    case '':
                        // 主动刷新（cc-connect proactive refresh）：QR 满 80s 且未达上限
                        if ((Date.now() - _pollQrFetchedAt) > QR_PROACTIVE_REFRESH_AT && _pollRefreshCount < MAX_QR_REFRESH) {
                            _pollRefreshCount++;
                            pushStatus({ status: 'refreshing', msg: '二维码即将过期，正在自动刷新 (' + _pollRefreshCount + '/' + MAX_QR_REFRESH + ')' });
                            try {
                                const newQr = await proto.fetchQrCode(proto.DEFAULT_BASE_URL, proto.DEFAULT_BOT_TYPE);
                                if (newQr.qrcode && newQr.qrcode_img_content) {
                                    _pollQrKey = newQr.qrcode;
                                    _pollQrFetchedAt = Date.now();
                                    _pollScannedPrinted = false;
                                    // 同步更新 QR 图片到前端
                                    var qrImg2 = null;
                                    try {
                                        const qrcode = require('qrcode-generator');
                                        const qrObj = qrcode(0, 'M');
                                        qrObj.addData(newQr.qrcode_img_content);
                                        qrObj.make();
                                        qrImg2 = qrObj.createDataURL(6, 4);
                                    } catch (e) {}
                                    pushStatus({ status: 'refreshed', qrcode: newQr.qrcode, qrImg: qrImg2 });
                                }
                            } catch (e) {
                                // 刷新失败，不中断，继续用当前 QR（cc-connect 同样处理）
                            }
                        }
                        pushStatus({ status: 'wait', scanned: _pollScannedPrinted });
                        break;
                    case 'scaned':
                        if (!_pollScannedPrinted) { _pollScannedPrinted = true; pushStatus({ status: 'scaned' }); }
                        break;
                    case 'expired':
                        _pollRefreshCount++;
                        if (_pollRefreshCount > MAX_QR_REFRESH) {
                            pushStatus({ status: 'error', msg: '二维码多次过期，请重新获取' });
                            return { success: false, error: '二维码多次过期，请重新获取', status: 'expired' };
                        }
                        pushStatus({ status: 'refreshing', msg: '二维码过期，正在自动刷新 (' + _pollRefreshCount + '/' + MAX_QR_REFRESH + ')' });
                        try {
                            const newQr = await proto.fetchQrCode(proto.DEFAULT_BASE_URL, proto.DEFAULT_BOT_TYPE);
                            if (newQr.qrcode && newQr.qrcode_img_content) {
                                _pollQrKey = newQr.qrcode;
                                _pollQrFetchedAt = Date.now();
                                _pollScannedPrinted = false;
                                var qrImg3 = null;
                                try {
                                    const qrcode = require('qrcode-generator');
                                    const qrObj = qrcode(0, 'M');
                                    qrObj.addData(newQr.qrcode_img_content);
                                    qrObj.make();
                                    qrImg3 = qrObj.createDataURL(6, 4);
                                } catch (e) {}
                                pushStatus({ status: 'refreshed', qrcode: newQr.qrcode, qrImg: qrImg3 });
                            }
                        } catch (e) {
                            pushStatus({ status: 'error', msg: '刷新二维码失败: ' + e.message });
                            return { success: false, error: '刷新二维码失败: ' + e.message, status: 'expired' };
                        }
                        break;
                    case 'confirmed':
                        if (st.bot_token && st.ilink_bot_id) {
                            const account = {
                                accountId: st.ilink_bot_id,
                                token: st.bot_token,
                                baseUrl: st.baseurl || proto.DEFAULT_BASE_URL,
                                userId: st.ilink_user_id || ''
                            };
                            ctx.saveAppState({ wechatBotSession: account });
                            pushStatus({ status: 'confirmed', account: account });
                            return { success: true, status: 'confirmed', account: account };
                        }
                        // cc-connect 行为：confirmed 但无凭据视为错误
                        return { success: false, error: '登录确认但缺少凭据', status: 'confirmed' };
                    default:
                        break;
                }
            } catch (e) {
                // pollQrStatus 网络错误，继续重试（cc-connect 直接报错退出，这里宽松些）
                console.warn('[WechatBot] poll-login 网络错误:', e.message);
            }
            // 对照 cc-connect time.Sleep(time.Second)
            await new Promise(r => setTimeout(r, 1000));
        }
        pushStatus({ status: 'error', msg: '等待扫码超时，请重试' });
        return { success: false, error: '等待扫码超时', status: 'timeout' };
    });

    // 3. 用已保存的凭据启动 bot（长轮询收消息）
    ipcMain.handle('wechatbot-start', async () => {
        try {
            if (wxBotInstance) { wxBotInstance.stop(); wxBotInstance = null; }

            const saved = ctx.loadAppState().wechatBotSession;
            if (!saved || !saved.token) {
                return { success: false, error: '未登录，请先扫码' };
            }

            if (wxBotPowerSaveId === null) {
                wxBotPowerSaveId = ctx.powerSaveBlocker.start('prevent-display-sleep');
            }

            wxBotInstance = new WeixinBotClient({
                baseUrl: saved.baseUrl,
                token: saved.token,
                accountId: saved.accountId,
                userId: saved.userId
            });

            // 校验码：首次需用户在微信发校验码授权；已授权则免
            if (saved.authorizedUser) {
                wxBotAuthorizedUser = saved.authorizedUser;
                wxBotVerifyCode = '';
            } else {
                wxBotVerifyCode = generateVerifyCode();
                wxBotAuthorizedUser = null;
            }

            wxBotInstance.on('message', async function (msg) {
                console.log('[WechatBot] 收到消息:', JSON.stringify(msg).substring(0, 200));
                // msg 结构（对照 cc-connect dispatchInbound）：{ from_user_id, text, context_token, message_id, seq, create_time_ms }
                var text = (msg.text || '').trim();
                var fromId = msg.from_user_id || '';
                var contextToken = msg.context_token || '';

                if (!wxBotAuthorizedUser) {
                    if (text === wxBotVerifyCode) {
                        wxBotAuthorizedUser = fromId;
                        ctx.saveAppState({ wechatBotSession: Object.assign({}, saved, { authorizedUser: fromId }) });
                        wxBotInstance.sendText(fromId, '✅ 验证通过，已建立远程连接。\n\n' + getStatusString(), contextToken).catch(function(e){ console.error('[WechatBot] 验证回复失败:', e.message); });
                        const av = ctx.getAgentView();
                        if (av && av.webContents) av.webContents.send('wechatbot-authorized', { openid: fromId });
                    } else {
                        wxBotInstance.sendText(fromId, '❌ 校验码错误，请重新发送。', contextToken).catch(function(e){ console.error('[WechatBot] 错误回复失败:', e.message); });
                    }
                    return;
                }
                if (fromId !== wxBotAuthorizedUser) return;

                if (wxBotProcessing) {
                    wxBotPendingMessages.push(msg);
                    wxBotInstance.sendText(fromId, '⏳ 正在处理上一条消息，已排队（位置 ' + wxBotPendingMessages.length + '）', contextToken).catch(function(e){ console.error('[WechatBot] 排队提示失败:', e.message); });
                    return;
                }
                wxBotProcessing = true;
                // 启动"正在输入"指示器，AI 回复发送后由 wechatbot-send-response 停止
                wxBotInstance._typingStop = null;
                try {
                    wxBotInstance._typingStop = await wxBotInstance.startTyping(fromId, contextToken);
                } catch (e) { console.debug('[WechatBot] typing 启动失败:', e.message); }
                forwardWxMessageToAgent({ content: text, openid: fromId, contextToken: contextToken, msgId: msg.message_id || null });
            });

            wxBotInstance.on('error', function (e) { console.error('[WechatBot] 错误:', e); });

            await wxBotInstance.start();
            return { success: true, verifyCode: wxBotVerifyCode };
        } catch (e) {
            console.error('[WechatBot] 启动失败:', e);
            return { success: false, error: e.message };
        }
    });

    // 4. 停止
    ipcMain.handle('wechatbot-stop', async () => {
        try {
            if (wxBotInstance) {
                try { if (wxBotInstance._typingStop) { wxBotInstance._typingStop(); wxBotInstance._typingStop = null; } } catch (_) {}
                wxBotInstance.stop();
                wxBotInstance = null;
            }
            if (wxBotPowerSaveId !== null) {
                ctx.powerSaveBlocker.stop(wxBotPowerSaveId);
                wxBotPowerSaveId = null;
            }
            wxBotAuthorizedUser = null;
            wxBotVerifyCode = '';
            wxBotPendingMessages = [];
            wxBotProcessing = false;
            return { success: true };
        } catch (e) { return { success: false, error: e.message }; }
    });

    // 5. 状态
    ipcMain.handle('wechatbot-status', () => {
        return {
            running: !!wxBotInstance,
            authorized: !!wxBotAuthorizedUser,
            openid: wxBotAuthorizedUser || null,
            verifyCode: wxBotVerifyCode,
            queueLength: wxBotPendingMessages.length,
            processing: wxBotProcessing
        };
    });

    // 6. Agent 回复（由 agentview 调）
    ipcMain.on('wechatbot-send-response', async (event, data) => {
        if (!wxBotInstance || !wxBotAuthorizedUser) return;
        // 停止"正在输入"指示器
        try { if (wxBotInstance._typingStop) { wxBotInstance._typingStop(); wxBotInstance._typingStop = null; } } catch (_) {}
        try {
            if (data.text) {
                await wxBotInstance.sendText(wxBotAuthorizedUser, data.text, data.contextToken || '');
            }
        } catch (e) { console.error('[WechatBot] 回复失败:', e); }
        wxBotProcessing = false;
        if (wxBotPendingMessages.length > 0) {
            var next = wxBotPendingMessages.shift();
            wxBotProcessing = true;
            // 下一条消息处理期间也启动 typing
            try { wxBotInstance._typingStop = await wxBotInstance.startTyping(next.openid || wxBotAuthorizedUser, next.contextToken || ''); } catch (_) {}
            forwardWxMessageToAgent(next);
        }
    });

    // 7. 凭据管理（列表/保存/删除，跟 QQ robot 一致，便于多账号）
    ipcMain.handle('wechatbot-list-robots', () => {
        var s = ctx.loadAppState();
        return s.wechatBotAccounts || [];
    });
    ipcMain.handle('wechatbot-save-robot', (event, robot) => {
        var s = ctx.loadAppState();
        var arr = s.wechatBotAccounts || [];
        var i = -1;
        for (var k = 0; k < arr.length; k++) if (arr[k].id === robot.id) { i = k; break; }
        if (i >= 0) arr[i] = robot; else arr.push(robot);
        ctx.saveAppState({ wechatBotAccounts: arr });
        return { success: true, robots: arr };
    });
    ipcMain.handle('wechatbot-delete-robot', (event, id) => {
        var s = ctx.loadAppState();
        var arr = (s.wechatBotAccounts || []).filter(function (r) { return r.id !== id; });
        ctx.saveAppState({ wechatBotAccounts: arr });
        return { success: true, robots: arr };
    });
}

function init(hostCtx) {
    ctx = hostCtx;
    registerIPC();
    console.log('[bot-wechat] 插件已初始化（iLink Bot API），IPC 已注册');
}

function getInstance() { return wxBotInstance; }
function getAuthorizedUser() { return wxBotAuthorizedUser; }
function setAwaitingConfirm(v) { wxBotAwaitingConfirm = v; }
function isAwaitingConfirm() { return wxBotAwaitingConfirm; }
function shutdown() { if (wxBotInstance) wxBotInstance.stop(); }

module.exports = {
    init, getInstance, getAuthorizedUser, setAwaitingConfirm, isAwaitingConfirm, shutdown
};
