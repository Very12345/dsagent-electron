// plugins/bot-feishu/protocol.js
// 飞书扫码一键创建应用 + IM 消息收发。
// 协议：OAuth 2.0 Device Authorization Grant（RFC 8628）扫码创建应用。
// 拿到 App ID/Secret 后用 tenant_access_token + IM API 发消息，
// WebSocket 长连接（@larksuiteoapi/node-sdk WSClient）收消息事件 im.message.receive_v1。
//
// 收发格式对照 cc-connect/platform/feishu（feishu.go onMessage/dispatchMessage/Send/replyMessage）。

const axios = require('axios');
const EventEmitter = require('events');

const FEISHU_ACCOUNTS = 'https://accounts.feishu.cn';
const LARK_ACCOUNTS = 'https://accounts.larksuite.com';
const REGISTRATION_PATH = '/oauth/v1/app/registration';
const FEISHU_OPEN = 'https://open.feishu.cn';
const LARK_OPEN = 'https://open.larksuite.com';
const REQUEST_TIMEOUT = 10000;
const DEFAULT_POLL_INTERVAL = 5;
const DEFAULT_EXPIRE = 600;

function accountsBase(domain) {
    return domain === 'lark' ? LARK_ACCOUNTS : FEISHU_ACCOUNTS;
}
function openBase(domain) {
    return domain === 'lark' ? LARK_OPEN : FEISHU_OPEN;
}

async function postRegistration(baseUrl, body) {
    const res = await axios.post(baseUrl + REGISTRATION_PATH, new URLSearchParams(body).toString(), {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        timeout: REQUEST_TIMEOUT,
        validateStatus: function () { return true; }
    });
    let data = {};
    try { data = res.data || {}; } catch (e) {}
    if (typeof data === 'string') { try { data = JSON.parse(data); } catch (e) { data = {}; } }
    return { status: res.status, data: data };
}

// ==================== 设备授权流程 ====================

async function initRegistration(domain) {
    const r = await postRegistration(accountsBase(domain), { action: 'init' });
    if (!r.data.supported_auth_methods || r.data.supported_auth_methods.indexOf('client_secret') < 0) {
        throw new Error('当前环境不支持 client_secret 认证方式');
    }
}

async function beginRegistration(domain) {
    const r = await postRegistration(accountsBase(domain), {
        action: 'begin',
        archetype: 'PersonalAgent',
        auth_method: 'client_secret',
        request_user_info: 'open_id'
    });
    const d = r.data;
    if (!d.device_code || !d.verification_uri_complete) {
        throw new Error('beginRegistration 返回异常: ' + JSON.stringify(d));
    }
    var qrUrl;
    try {
        qrUrl = new URL(d.verification_uri_complete);
        qrUrl.searchParams.set('from', 'oc_onboard');
        qrUrl.searchParams.set('tp', 'ob_cli_app');
        qrUrl = qrUrl.toString();
    } catch (e) { qrUrl = d.verification_uri_complete; }
    return {
        deviceCode: d.device_code,
        qrUrl: qrUrl,
        userCode: d.user_code || '',
        interval: d.interval || DEFAULT_POLL_INTERVAL,
        expireIn: d.expire_in || DEFAULT_EXPIRE
    };
}

async function pollRegistration(opts) {
    var domain = opts.initialDomain || 'feishu';
    var interval = opts.interval || DEFAULT_POLL_INTERVAL;
    var deadline = Date.now() + (opts.expireIn || DEFAULT_EXPIRE) * 1000;
    var domainSwitched = false;

    while (Date.now() < deadline) {
        if (opts.abortSignal && opts.abortSignal.aborted) return { status: 'timeout' };
        var r;
        try {
            r = await postRegistration(accountsBase(domain), {
                action: 'poll',
                device_code: opts.deviceCode,
                tp: 'ob_cli_app'
            });
        } catch (e) {
            await sleep(interval * 1000);
            continue;
        }
        var d = r.data || {};

        if (d.user_info && d.user_info.tenant_brand === 'lark' && !domainSwitched) {
            domain = 'lark';
            domainSwitched = true;
            if (opts.onStatus) opts.onStatus('domain_switched');
            continue;
        }

        if (d.client_id && d.client_secret) {
            return {
                status: 'success',
                result: {
                    appId: d.client_id,
                    appSecret: d.client_secret,
                    domain: domain,
                    openId: (d.user_info || {}).open_id
                }
            };
        }
        if (d.error) {
            if (d.error === 'authorization_pending') {
                // 继续
            } else if (d.error === 'slow_down') {
                interval += 5;
                if (opts.onStatus) opts.onStatus('slow_down');
            } else if (d.error === 'access_denied') {
                return { status: 'access_denied' };
            } else if (d.error === 'expired_token') {
                return { status: 'expired' };
            } else {
                return { status: 'error', message: d.error + ': ' + (d.error_description || '') };
            }
        }
        if (opts.onStatus) opts.onStatus('polling');
        await sleep(interval * 1000);
    }
    return { status: 'timeout' };
}

function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

// ==================== IM API ====================

// tenant_access_token 缓存 + 失效自动刷新（对照 cc-connect fetchFreshTenantAccessToken / withFreshTenantAccessTokenRetry）
let _tokenCache = new Map(); // key=appId → { token, expiresAt }
async function getTenantAccessToken(appId, appSecret, domain) {
    const entry = _tokenCache.get(appId);
    if (entry && Date.now() < entry.expiresAt - 60000) return entry.token;
    const res = await axios.post(openBase(domain) + '/open-apis/auth/v3/tenant_access_token/internal',
        { app_id: appId, app_secret: appSecret },
        { headers: { 'Content-Type': 'application/json' }, timeout: REQUEST_TIMEOUT, validateStatus: function () { return true; } }
    );
    if (!res.data || !res.data.tenant_access_token) {
        throw new Error('获取 tenant_access_token 失败: ' + JSON.stringify(res.data));
    }
    const token = res.data.tenant_access_token;
    const expire = res.data.expire || 7200;
    _tokenCache.set(appId, { token: token, expiresAt: Date.now() + expire * 1000 });
    return token;
}

function invalidateToken(appId) { _tokenCache.delete(appId); }

// 发消息通用方法（对照 cc-connect createMessage / replyMessage）
// receiveIdType: open_id/user_id/union_id/email/chat_id
// msgType: text/post/image/interactive 等
// content: JSON 字符串
async function sendMessageRaw(appId, appSecret, domain, receiveIdType, receiveId, msgType, content, replyInThread) {
    var body = { receive_id: receiveId, msg_type: msgType, content: content };
    if (replyInThread) body.reply_in_thread = true;
    var token = await getTenantAccessToken(appId, appSecret, domain);
    var url = openBase(domain) + '/open-apis/im/v1/messages?receive_id_type=' + receiveIdType;
    var res = await axios.post(url, body, {
        headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
        timeout: REQUEST_TIMEOUT, validateStatus: function () { return true; }
    });
    // token 失效重试一次（对照 cc-connect withFreshTenantAccessTokenRetry）
    if (res.data && res.data.code === 99991663) {  // invalid access token
        invalidateToken(appId);
        token = await getTenantAccessToken(appId, appSecret, domain);
        res = await axios.post(url, body, {
            headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
            timeout: REQUEST_TIMEOUT, validateStatus: function () { return true; }
        });
    }
    if (!res.data || res.data.code !== 0) {
        throw new Error('FeishuAPI send 失败: code=' + (res.data && res.data.code) + ' msg=' + (res.data && res.data.msg));
    }
    return res.data;
}

// 发文本消息
async function sendText(appId, appSecret, domain, receiveIdType, receiveId, text) {
    return sendMessageRaw(appId, appSecret, domain, receiveIdType, receiveId, 'text', JSON.stringify({ text: text }));
}

// 回复消息（对照 cc-connect replyMessage，用 reply API 走 thread）
async function replyText(appId, appSecret, domain, messageId, text) {
    var token = await getTenantAccessToken(appId, appSecret, domain);
    var url = openBase(domain) + '/open-apis/im/v1/messages/' + messageId + '/reply';
    var body = { msg_type: 'text', content: JSON.stringify({ text: text }) };
    var res = await axios.post(url, body, {
        headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
        timeout: REQUEST_TIMEOUT, validateStatus: function () { return true; }
    });
    if (res.data && res.data.code === 99991663) {
        invalidateToken(appId);
        token = await getTenantAccessToken(appId, appSecret, domain);
        res = await axios.post(url, body, {
            headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
            timeout: REQUEST_TIMEOUT, validateStatus: function () { return true; }
        });
    }
    if (!res.data || res.data.code !== 0) {
        throw new Error('FeishuAPI reply 失败: code=' + (res.data && res.data.code) + ' msg=' + (res.data && res.data.msg));
    }
    return res.data;
}

// ==================== 消息内容解析（对照 cc-connect dispatchMessage / parsePostContent） ====================

// 从 event 提取发送者 ID（对照 cc-connect userIDFromEvent）
function userIDFromEvent(senderId) {
    if (!senderId) return '';
    return senderId.open_id || senderId.union_id || senderId.user_id || '';
}

// 剥离 @bot/@all 提及文本（对照 cc-connect stripMentions）
function stripMentions(text, mentions, botOpenId) {
    if (!text) return '';
    var out = text;
    if (Array.isArray(mentions)) {
        for (var i = 0; i < mentions.length; i++) {
            var m = mentions[i];
            if (!m) continue;
            // 群里 @bot 不响应其他机器人，仅剥离 @bot 文本
            if (botOpenId && m.id && m.id.open_id === botOpenId) {
                out = out.replace('@_user_' + (i + 1), '').trim();
            }
        }
    }
    out = out.replace(/@_all/g, '').trim();
    return out;
}

// 从 post 富文本提取文本（对照 cc-connect parsePostContent / extractPostParts）
function extractPostText(content) {
    try {
        var obj = JSON.parse(content);
        // post 结构：{ zh_cn: { title, content:[[ {tag,text},{tag,a,href,text} ]] }, en_us: ... }
        var lang = obj.zh_cn || obj.en_us || obj.ja_jp || obj[Object.keys(obj)[0]];
        if (!lang) return '';
        var parts = [];
        if (lang.title) parts.push(lang.title);
        if (Array.isArray(lang.content)) {
            for (var i = 0; i < lang.content.length; i++) {
                var line = lang.content[i];
                if (!Array.isArray(line)) continue;
                for (var j = 0; j < line.length; j++) {
                    var node = line[j];
                    if (!node) continue;
                    if (node.tag === 'text' && node.text) parts.push(node.text);
                    else if (node.tag === 'a' && node.text) parts.push(node.text);
                    else if (node.tag === 'at' && node.text) parts.push(node.text);
                    else if (node.tag === 'code' && node.text) parts.push(node.text);
                }
            }
        }
        return parts.join('');
    } catch (e) { return ''; }
}

// 主解析：按 msg_type 提取文本（对照 cc-connect dispatchMessage switch）
function parseInboundMessage(msgType, content, mentions, botOpenId) {
    if (msgType === 'text') {
        try {
            var tb = JSON.parse(content);
            return stripMentions(tb.text || '', mentions, botOpenId);
        } catch (e) { return ''; }
    }
    if (msgType === 'post') {
        return stripMentions(extractPostText(content), mentions, botOpenId);
    }
    if (msgType === 'image') return '[图片]';
    if (msgType === 'file') return '[文件]';
    if (msgType === 'audio') return '[语音]';
    if (msgType === 'media') return '[视频]';
    if (msgType === 'sticker') return '[表情]';
    if (msgType === 'merge_forward') return '[合并转发消息]';
    return '';
}

// ==================== 客户端类（WebSocket 长连接收消息） ====================
class FeishuBotClient extends EventEmitter {
    constructor(config) {
        super();
        this.config = config; // { appId, appSecret, domain, encryptKey? }
        this._running = false;
        this._wsClient = null;
        this._dedup = new Map();     // message_id 去重
        this._botOpenId = '';
    }

    async start() {
        this._running = true;
        const self = this;
        // 用官方 SDK WebSocket client 接收事件（对照 cc-connect startWebSocketMode）
        let sdk;
        try {
            sdk = require('@larksuiteoapi/node-sdk');
        } catch (e) {
            console.error('[FeishuBot] 缺少 @larksuiteoapi/node-sdk，无法接收消息:', e.message);
            this.emit('error', new Error('缺少 @larksuiteoapi/node-sdk'));
            return;
        }

        // 拿 bot open_id（对照 cc-connect fetchBotOpenID，用于群里 @bot 过滤）
        try {
            this._botOpenId = await this._fetchBotOpenId();
        } catch (e) { console.warn('[FeishuBot] 获取 bot open_id 失败，群 @ 过滤将禁用:', e.message); }

        const dispatcher = new sdk.EventDispatcher({ encryptKey: this.config.encryptKey || '' });
        dispatcher.register({
            'im.message.receive_v1': function (data) {
                try { self._onMessage(data); }
                catch (e) { console.error('[FeishuBot] onMessage error:', e.message); }
                return Promise.resolve();
            }
        });

        this._wsClient = new sdk.WSClient({
            appId: this.config.appId,
            appSecret: this.config.appSecret,
            domain: this.config.domain === 'lark' ? sdk.Domain.Lark : sdk.Domain.Feishu,
            eventDispatcher: dispatcher
        });

        // SDK start 是长连接，异步启动
        this._wsClient.start().catch(function (e) {
            console.error('[FeishuBot] WebSocket 启动失败:', e.message);
            self.emit('error', e);
        });
        console.log('[FeishuBot] WebSocket 长连接已启动，等待消息事件');
    }

    // 获取 bot open_id（对照 cc-connect fetchBotOpenID）
    async _fetchBotOpenId() {
        const token = await getTenantAccessToken(this.config.appId, this.config.appSecret, this.config.domain || 'feishu');
        const res = await axios.get(openBase(this.config.domain || 'feishu') + '/open-apis/bot/v3/info', {
            headers: { 'Authorization': 'Bearer ' + token },
            timeout: REQUEST_TIMEOUT, validateStatus: function () { return true; }
        });
        if (res.data && res.data.open_id) return res.data.open_id;
        return '';
    }

    // 处理入站消息（对照 cc-connect onMessage + dispatchMessage）
    _onMessage(data) {
        // data 结构：{ event: { message: {...}, sender: {sender_id:{...}} } }
        const evt = data && data.event;
        if (!evt) return;
        const msg = evt.message || {};
        const sender = evt.sender || {};
        const senderId = sender.sender_id || {};

        const msgType = msg.message_type || '';
        const chatId = msg.chat_id || '';
        const messageId = msg.message_id || '';
        const chatType = msg.chat_type || '';  // p2p / group
        const content = msg.content || '';
        const mentions = msg.mentions || [];
        const createTime = msg.create_time || '';

        if (!messageId) return;

        // 去重（对照 cc-connect dedup.IsDuplicate）
        const now = Date.now();
        for (const [k, ts] of this._dedup) { if (now - ts > 300000) this._dedup.delete(k); }
        if (this._dedup.has(messageId)) return;
        this._dedup.set(messageId, now);

        // 跳过旧消息（对照 cc-connect IsOldMessage，>5分钟）
        if (createTime) {
            const ms = parseInt(createTime, 10);
            if (!isNaN(ms) && (now - ms) > 300000) return;
        }

        // 群消息：仅处理 @bot 的（对照 cc-connect isBotMentioned 过滤）
        if (chatType === 'group' && this._botOpenId) {
            let mentioned = false;
            for (let i = 0; i < mentions.length; i++) {
                if (mentions[i] && mentions[i].id && mentions[i].id.open_id === this._botOpenId) { mentioned = true; break; }
            }
            if (!mentioned) return;
        }

        const userId = userIDFromEvent(senderId);
        const text = parseInboundMessage(msgType, content, mentions, this._botOpenId);
        if (!text) return;

        // emit 给主进程（对照 cc-connect dispatchCoreMessage）
        this.emit('message', {
            from_user_id: userId,
            text: text,
            message_id: messageId,
            chat_id: chatId,
            chat_type: chatType,
            receive_id: chatType === 'group' ? chatId : userId,  // 回复目标：群用 chat_id，私聊用 user open_id
            receive_id_type: chatType === 'group' ? 'chat_id' : 'open_id',
            msg_type: msgType
        });
    }

    async stop() {
        this._running = false;
        try { if (this._wsClient && typeof this._wsClient.close === 'function') this._wsClient.close(); }
        catch (e) {}
        this._wsClient = null;
    }

    // 发送文本（对照 cc-connect Send）
    async sendText(receiveIdType, receiveId, text) {
        return sendText(this.config.appId, this.config.appSecret, this.config.domain || 'feishu', receiveIdType, receiveId, text);
    }

    // 回复消息（用 reply API，走 thread）
    async replyText(messageId, text) {
        return replyText(this.config.appId, this.config.appSecret, this.config.domain || 'feishu', messageId, text);
    }
}

module.exports = {
    initRegistration,
    beginRegistration,
    pollRegistration,
    getTenantAccessToken,
    sendText,
    replyText,
    sendMessageRaw,
    FeishuBotClient,
    FEISHU_ACCOUNTS
};
