// plugins/bot-wechat/protocol.js
// 微信 iLink Bot API 协议实现（腾讯官方开放协议）。
// 纯 HTTP/JSON，无 SDK 依赖。端点域名 https://ilinkai.weixin.qq.com 。
//
// 流程：
//   1. GET  ilink/bot/get_bot_qrcode?bot_type=3  → 拿二维码图片 URL + qrcode token
//   2. GET  ilink/bot/get_qrcode_status?qrcode=<token>  （长轮询 35s）
//      → status: wait/scaned/confirmed/expired；confirmed 时返回 bot_token + ilink_bot_id + ilink_user_id
//   3. POST ilink/bot/getupdates  （长轮询，body {get_updates_buf, base_info}，header Bearer bot_token）
//      → {ret, msgs:[...], get_updates_buf}
//   4. POST ilink/bot/sendmessage  发消息
//   5. POST ilink/bot/getconfig   拿 typing_ticket
//   6. POST ilink/bot/sendtyping  发"正在输入"状态
//
// 实现对照 cc-connect/platform/weixin（weixin.go / client.go / types.go / parse.go）。

const axios = require('axios');
const crypto = require('crypto');
const EventEmitter = require('events');

const DEFAULT_BASE_URL = 'https://ilinkai.weixin.qq.com';
const DEFAULT_BOT_TYPE = '3';
const QR_LONG_POLL_MS = 35000;
const UPDATE_LONG_POLL_MS = 35000;
const API_TIMEOUT_MS = 15000;

// 对照 cc-connect 常量
const MAX_CHUNK = 3800;                    // maxWeixinChunk
const SEND_MAX_RETRIES = 3;                // weixinSendMaxRetries
const SEND_RETRY_DELAY = 500;              // weixinSendRetryDelay (ms)
const CHUNK_SEND_DELAY = 100;              // weixinChunkSendDelay (ms)
const TYPING_TICKET_TTL = 10 * 60 * 1000;  // typingTicketTTL (ms)
const TYPING_REPEAT_INTERVAL = 5000;       // typingRepeatInterval (ms)
const TYPING_AUTO_STOP_MS = 90000;         // 自动停止 typing（防止 AI 异常时永远"正在输入"）

// 消息类型常量（对照 cc-connect types.go）
const MSG_TYPE_USER = 1;
const MSG_TYPE_BOT = 2;
const ITEM_TEXT = 1;
const ITEM_IMAGE = 2;
const ITEM_VOICE = 3;
const ITEM_FILE = 4;
const ITEM_VIDEO = 5;
const MSG_STATE_FINISH = 2;
const SESSION_EXPIRED_ERRCODE = -14;
const TYPING_STATUS_START = 1;
const TYPING_STATUS_STOP = 2;

function randomWechatUIN() {
    const uint32 = crypto.randomBytes(4).readUInt32BE(0);
    return Buffer.from(String(uint32), 'utf-8').toString('base64');
}

function randomHex(n) {
    return crypto.randomBytes(n).toString('hex');
}

// ==================== 扫码登录 ====================
async function fetchQrCode(baseUrl, botType) {
    const base = baseUrl.endsWith('/') ? baseUrl : baseUrl + '/';
    const url = base + 'ilink/bot/get_bot_qrcode?bot_type=' + encodeURIComponent(botType || DEFAULT_BOT_TYPE);
    const res = await axios.get(url, { timeout: API_TIMEOUT_MS });
    return res.data; // { qrcode, qrcode_img_content }
}

async function pollQrStatus(baseUrl, qrcode) {
    const base = baseUrl.endsWith('/') ? baseUrl : baseUrl + '/';
    const url = base + 'ilink/bot/get_qrcode_status?qrcode=' + encodeURIComponent(qrcode);
    try {
        const res = await axios.get(url, {
            headers: { 'iLink-App-ClientVersion': '1' },
            timeout: QR_LONG_POLL_MS + 5000
        });
        return res.data; // { status, bot_token?, ilink_bot_id?, baseurl?, ilink_user_id? }
    } catch (e) {
        // 长轮询超时视为 wait
        if (e && (e.code === 'ECONNABORTED' || (e.response && e.response.status >= 500))) {
            return { status: 'wait' };
        }
        throw e;
    }
}

// ==================== 消息 API ====================
function buildHeaders(token, bodyStr) {
    const h = {
        'Content-Type': 'application/json',
        'AuthorizationType': 'ilink_bot_token'
    };
    if (bodyStr) h['Content-Length'] = String(Buffer.byteLength(bodyStr, 'utf-8'));
    h['X-WECHAT-UIN'] = randomWechatUIN();
    if (token && token.trim()) h['Authorization'] = 'Bearer ' + token.trim();
    return h;
}

async function apiPost(baseUrl, endpoint, bodyObj, token, timeoutMs) {
    const base = baseUrl.endsWith('/') ? baseUrl : baseUrl + '/';
    const url = base + endpoint;
    const payload = Object.assign({ base_info: { channel_version: 'dsagent-weixin/1.0' } }, bodyObj);
    const body = JSON.stringify(payload);
    const res = await axios.post(url, body, {
        headers: buildHeaders(token, body),
        timeout: timeoutMs || API_TIMEOUT_MS,
        validateStatus: function () { return true; }
    });
    if (res.status < 200 || res.status >= 300) {
        throw new Error('WechatAPI ' + endpoint + ' ' + res.status + ': ' + JSON.stringify(res.data));
    }
    return res.data;
}

async function getUpdates(baseUrl, token, getUpdatesBuf) {
    try {
        return await apiPost(baseUrl, 'ilink/bot/getupdates', {
            get_updates_buf: getUpdatesBuf || ''
        }, token, UPDATE_LONG_POLL_MS + 5000);
    } catch (e) {
        // 长轮询超时返回空，调用方继续轮询（对照 cc-connect client.go getUpdates 的 DeadlineExceeded 处理）
        if (e && (e.code === 'ECONNABORTED')) {
            return { ret: 0, msgs: [], get_updates_buf: getUpdatesBuf };
        }
        throw e;
    }
}

async function sendMessage(baseUrl, token, msgBody) {
    return apiPost(baseUrl, 'ilink/bot/sendmessage', msgBody, token, API_TIMEOUT_MS);
}

async function sendTyping(baseUrl, token, typingBody) {
    return apiPost(baseUrl, 'ilink/bot/sendtyping', typingBody, token, 10000);
}

// getconfig：拿 typing_ticket（对照 cc-connect client.go getConfig）
async function getConfig(baseUrl, token, userId, contextToken) {
    return apiPost(baseUrl, 'ilink/bot/getconfig', {
        ilink_user_id: userId,
        context_token: contextToken || ''
    }, token, API_TIMEOUT_MS);
}

// ==================== 消息体解析（对照 cc-connect bodyFromItemList / parse.go） ====================
// item_list 中提取文本：type=1 (text) → text_item.text（含引用拼接）；type=3 (voice) → voice_item.text（识别文本）
function bodyFromItemList(itemList) {
    if (!Array.isArray(itemList)) return '';
    for (const it of itemList) {
        if (!it) continue;
        if (it.type === ITEM_TEXT && it.text_item && it.text_item.text) {
            const text = it.text_item.text.trim();
            const ref = it.ref_msg;
            if (!ref) return text;
            // 引用消息：拼接 [引用: title | refBody]\n实际文本
            const parts = [];
            if (ref.title) parts.push(ref.title);
            if (ref.message_item) {
                const refBody = bodyFromItemList([ref.message_item]);
                if (refBody) parts.push(refBody);
            }
            if (parts.length === 0) return text;
            return '[引用: ' + parts.join(' | ') + ']\n' + text;
        }
        if (it.type === ITEM_VOICE && it.voice_item && it.voice_item.text && it.voice_item.text.trim()) {
            return it.voice_item.text.trim();
        }
    }
    return '';
}

// 判断是否纯媒体消息（无文本）
function isMediaOnly(itemList) {
    if (!Array.isArray(itemList) || itemList.length === 0) return false;
    for (const it of itemList) {
        if (!it) continue;
        if (it.type === ITEM_TEXT || (it.type === ITEM_VOICE && it.voice_item && it.voice_item.text)) return false;
    }
    return true;
}

// ==================== UTF-8 分块（对照 cc-connect splitUTF8） ====================
function splitUTF8(s, maxRunes) {
    if (!maxRunes || maxRunes <= 0) return [s];
    const runes = [...s];
    if (runes.length <= maxRunes) return [s];
    const out = [];
    let i = 0;
    while (i < runes.length) {
        const n = Math.min(maxRunes, runes.length - i);
        out.push(runes.slice(i, i + n).join(''));
        i += n;
    }
    return out;
}

function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

// ==================== 客户端类 ====================
class WeixinBotClient extends EventEmitter {
    constructor(config) {
        super();
        this.config = config; // { baseUrl, token, accountId, userId }
        this.getUpdatesBuf = '';
        this._running = false;
        this._dedup = new Map();          // 去重：key=from|msgId|seq|createTime|clientId
        this._contextTokens = new Map();  // peer → context_token（对照 cc-connect tokens map）
        this._typingTickets = new Map();  // peer → { ticket, fetchedAt }
    }

    // ---- context_token 存取（对照 cc-connect setContextToken/getContextToken） ----
    _setContextToken(peer, token) {
        if (!peer || !token) return;
        this._contextTokens.set(peer, token);
    }
    _getContextToken(peer) {
        return this._contextTokens.get(peer) || '';
    }

    // ---- typing ticket 缓存（对照 cc-connect getTypingTicket） ----
    async _getTypingTicket(peer, contextToken) {
        const entry = this._typingTickets.get(peer);
        if (entry && (Date.now() - entry.fetchedAt) < TYPING_TICKET_TTL) return entry.ticket;
        try {
            const resp = await getConfig(this.config.baseUrl || DEFAULT_BASE_URL, this.config.token, peer, contextToken);
            if (resp && resp.typing_ticket && resp.typing_ticket.trim()) {
                const ticket = resp.typing_ticket.trim();
                this._typingTickets.set(peer, { ticket: ticket, fetchedAt: Date.now() });
                return ticket;
            }
        } catch (e) {
            console.debug('[WechatBot] getconfig typing ticket 失败:', e.message);
        }
        return '';
    }

    // 启动长轮询接收消息循环（对照 cc-connect pollLoop）
    async start() {
        this._running = true;
        const self = this;
        const base = this.config.baseUrl || DEFAULT_BASE_URL;
        let backoff = 1000;
        let paused = false;
        async function loop() {
            while (self._running) {
                if (paused) {
                    await sleep(5000);
                    continue;
                }
                try {
                    const resp = await getUpdates(base, self.config.token, self.getUpdatesBuf);
                    backoff = 1000;
                    if (resp.get_updates_buf) self.getUpdatesBuf = resp.get_updates_buf;
                    // session 过期错误码 -14：暂停 1 小时（对照 cc-connect pauseSession）
                    if (resp.errcode === SESSION_EXPIRED_ERRCODE) {
                        console.warn('[WechatBot] session 过期，暂停 1 小时');
                        paused = true;
                        setTimeout(function () { paused = false; }, 60 * 60 * 1000);
                        continue;
                    }
                    if (resp.ret !== 0 && resp.errmsg) {
                        console.warn('[WechatBot] getUpdates ret=' + resp.ret + ' errcode=' + resp.errcode + ' msg=' + resp.errmsg);
                    }
                    if (resp.msgs && resp.msgs.length > 0) {
                        for (let i = 0; i < resp.msgs.length; i++) {
                            try { self._dispatchInbound(resp.msgs[i]); }
                            catch (e) { console.error('[WechatBot] message handler error:', e.message); }
                        }
                    }
                } catch (e) {
                    console.error('[WechatBot] getUpdates error:', e.message);
                    await sleep(backoff);
                    if (backoff < 30000) backoff *= 2;
                }
            }
        }
        loop().catch(function (e) { console.error('[WechatBot] loop fatal:', e.message); });
    }

    // 分发入站消息（对照 cc-connect dispatchInbound：去重 + 存 context_token + 预取 typing ticket + 提文本 + 忽略 bot 自身）
    _dispatchInbound(m) {
        if (!m) return;
        if (m.message_type === MSG_TYPE_BOT) return;
        if (m.message_type !== 0 && m.message_type !== MSG_TYPE_USER) return;
        const from = (m.from_user_id || '').trim();
        if (!from) return;

        // 去重（5 分钟窗口）
        const dedupKey = from + '|' + m.message_id + '|' + m.seq + '|' + m.create_time_ms + '|' + (m.client_id || '');
        const now = Date.now();
        for (const [k, ts] of this._dedup) { if (now - ts > 300000) this._dedup.delete(k); }
        if (this._dedup.has(dedupKey)) return;
        this._dedup.set(dedupKey, now);

        // 存 context_token + 预取 typing ticket（对照 cc-connect refreshTypingTicket）
        const tok = (m.context_token || '').trim();
        if (tok) {
            this._setContextToken(from, tok);
            // 预取 typing ticket（异步，不阻塞消息分发）
            this._getTypingTicket(from, tok).catch(function () {});
        }

        let text = bodyFromItemList(m.item_list);
        if (!text && isMediaOnly(m.item_list)) {
            text = '[收到媒体消息：图片/文件/语音暂不支持，请改用文字说明]';
        }
        if (!text) return;

        this.emit('message', {
            from_user_id: from,
            text: text,
            context_token: tok,
            message_id: m.message_id || 0,
            seq: m.seq || 0,
            create_time_ms: m.create_time_ms || 0
        });
    }

    async stop() {
        this._running = false;
    }

    // ---- 底层发送单块文本（对照 cc-connect client.go sendText） ----
    async _sendTextRaw(toUserId, text, contextToken, clientID) {
        if (!contextToken || !contextToken.trim()) {
            throw new Error('WechatBot: context_token 必填');
        }
        const msgBody = {
            msg: {
                from_user_id: '',
                to_user_id: toUserId,
                client_id: clientID || ('dsagent-' + randomHex(6)),
                message_type: MSG_TYPE_BOT,
                message_state: MSG_STATE_FINISH,
                item_list: [{ type: ITEM_TEXT, text_item: { text: text } }],
                context_token: contextToken
            }
        };
        const resp = await sendMessage(this.config.baseUrl || DEFAULT_BASE_URL, this.config.token, msgBody);
        // 对照 cc-connect sendMessage：检查 ret
        if (resp && resp.ret != null && resp.ret !== 0) {
            const err = new Error('weixin: sendMessage ret=' + resp.ret + ' errcode=' + resp.errcode + ' errmsg=' + resp.errmsg);
            err.ret = resp.ret;
            throw err;
        }
        return resp;
    }

    // ---- 分块发送 + 重试 + token 刷新（对照 cc-connect sendChunks / sendChunkWithRetry） ----
    async sendText(toUserId, content, contextToken) {
        // 若未传 token，从存储回退取用（对照 cc-connect sendChunks 的 getContextToken 回退）
        let token = (contextToken || '').trim();
        if (!token) token = this._getContextToken(toUserId);
        if (!token) {
            throw new Error('WechatBot: 缺少 context_token，用户需先发一条消息刷新会话');
        }
        if (!content || !content.trim()) return;

        const chunks = splitUTF8(content, MAX_CHUNK);
        const total = chunks.length;
        for (let i = 0; i < chunks.length; i++) {
            if (i > 0) await sleep(CHUNK_SEND_DELAY);
            const err = await this._sendChunkWithRetry(toUserId, chunks[i], token, i + 1, total);
            if (err) {
                // 发送不完整通知（对照 cc-connect 的 notice）
                try {
                    await this._sendTextRaw(toUserId, '⚠️ 消息发送不完整，请在应用内查看完整结果。', token, 'dsagent-notice-' + randomHex(6));
                } catch (_) {}
                throw err;
            }
        }
    }

    async _sendChunkWithRetry(toUserId, chunk, contextToken, chunkIdx, totalChunks) {
        let lastErr = null;
        let currentToken = contextToken;
        for (let attempt = 0; attempt < SEND_MAX_RETRIES; attempt++) {
            try {
                await this._sendTextRaw(toUserId, chunk, currentToken, 'dsagent-' + randomHex(6));
                return null;
            } catch (e) {
                lastErr = e;
                // ret=-2：context_token 过期，尝试从存储刷新（对照 cc-connect sendChunkWithRetry）
                if (e.ret === -2 || (e.message && e.message.indexOf('ret=-2') >= 0)) {
                    const fresh = this._getContextToken(toUserId);
                    if (!fresh || fresh === currentToken) {
                        // 无新 token 可刷新，快速失败
                        console.warn('[WechatBot] sendMessage ret=-2，无新 token 可刷新，用户需重新发消息');
                        return new Error('WechatBot: context_token 过期（ret=-2），用户需重新发一条消息刷新会话: ' + e.message);
                    }
                    console.warn('[WechatBot] sendMessage ret=-2，用新 token 重试 (attempt ' + (attempt + 1) + ')');
                    currentToken = fresh;
                    await sleep(SEND_RETRY_DELAY);
                    continue;
                }
                // 其他错误不重试
                return e;
            }
        }
        return lastErr;
    }

    // ---- typing 指示器（对照 cc-connect StartTyping） ----
    // 返回 stop 函数；调用方在回复发送完成后调用 stop() 取消"正在输入"
    async startTyping(toUserId, contextToken) {
        const self = this;
        let token = (contextToken || '').trim();
        if (!token) token = this._getContextToken(toUserId);
        if (!token) return function () {};
        const ticket = await this._getTypingTicket(toUserId, token);
        if (!ticket) return function () {};

        try {
            await sendTyping(self.config.baseUrl || DEFAULT_BASE_URL, self.config.token, {
                ilink_user_id: toUserId, typing_ticket: ticket, status: TYPING_STATUS_START
            });
        } catch (e) {
            console.debug('[WechatBot] typing start 失败:', e.message);
            return function () {};
        }

        let stopped = false;
        // 自动停止定时器：AI 处理超时或异常时自动 stop，防止手机一直"正在输入"
        const autoStopTimer = setTimeout(function () {
            if (stopped) return;
            stopped = true;
            clearInterval(ticker);
            sendTyping(self.config.baseUrl || DEFAULT_BASE_URL, self.config.token, {
                ilink_user_id: toUserId, typing_ticket: ticket, status: TYPING_STATUS_STOP
            }).catch(function () {});
        }, TYPING_AUTO_STOP_MS);

        const ticker = setInterval(function () {
            if (stopped) return;
            sendTyping(self.config.baseUrl || DEFAULT_BASE_URL, self.config.token, {
                ilink_user_id: toUserId, typing_ticket: ticket, status: TYPING_STATUS_START
            }).catch(function () { /* best effort */ });
        }, TYPING_REPEAT_INTERVAL);

        return function stop() {
            if (stopped) return;
            stopped = true;
            clearInterval(ticker);
            clearTimeout(autoStopTimer);
            sendTyping(self.config.baseUrl || DEFAULT_BASE_URL, self.config.token, {
                ilink_user_id: toUserId, typing_ticket: ticket, status: TYPING_STATUS_STOP
            }).catch(function () { /* best effort */ });
        };
    }
}

module.exports = {
    DEFAULT_BASE_URL,
    DEFAULT_BOT_TYPE,
    fetchQrCode,
    pollQrStatus,
    getUpdates,
    sendMessage,
    sendTyping,
    getConfig,
    WeixinBotClient
};
