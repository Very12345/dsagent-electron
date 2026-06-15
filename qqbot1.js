const WebSocket = require('ws');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

// ================== 配置区 ==================
const CONFIG = {
    appId: '1904158612',
    clientSecret: 'klmoruy38EKRZhq0ALXjwAPeuBSk2Ley',
    gatewayUrl: 'wss://sandbox.api.sgroup.qq.com/websocket',
    intents: (1 << 1) | (1 << 25),
    apiBase: 'https://api.sgroup.qq.com',
    pdfPath: './1.pdf'
};
// =============================================

class QQBotClient {
    constructor(config) {
        this.config = config;
        this.accessToken = null;
        this.tokenExpiresAt = 0;
        this.ws = null;
        this.sessionId = null;
        this.lastSeq = null;
        this.heartbeatInterval = null;
        this.heartbeatTimer = null;
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = 10;
        this.replyCountMap = new Map();
    }

    // ==================== 获取 AccessToken ====================
    async getAccessToken() {
        const now = Date.now();
        if (this.accessToken && now < this.tokenExpiresAt - 60000) {
            return this.accessToken;
        }

        try {
            console.log('[Token] 正在获取 access_token...');
            const response = await axios.post(
                'https://bots.qq.com/app/getAppAccessToken',
                {
                    appId: this.config.appId,
                    clientSecret: this.config.clientSecret
                },
                {
                    headers: { 'Content-Type': 'application/json' },
                    timeout: 10000
                }
            );

            const data = response.data;
            this.accessToken = data.access_token;
            this.tokenExpiresAt = now + (data.expires_in || 7200) * 1000;
            console.log(`[Token] 获取成功，过期时间: ${new Date(this.tokenExpiresAt).toLocaleString()}`);
            return this.accessToken;
        } catch (error) {
            console.error('[Token] 获取失败:', error.message);
            throw error;
        }
    }

    // ==================== 获取消息回复序号 ====================
    getMessageSeq(msgId) {
        const count = (this.replyCountMap.get(msgId) || 0) + 1;
        this.replyCountMap.set(msgId, count);
        
        if (this.replyCountMap.size > 1000) {
            const entries = Array.from(this.replyCountMap.entries());
            const toDelete = entries.slice(0, 500);
            toDelete.forEach(([key]) => this.replyCountMap.delete(key));
        }
        
        return count;
    }

    // ==================== 上传文件 ====================
    async uploadFile(openid, filePath) {
        try {
            if (!fs.existsSync(filePath)) {
                throw new Error(`文件不存在: ${filePath}`);
            }

            const fileBuffer = fs.readFileSync(filePath);
            const base64Data = fileBuffer.toString('base64');
            const fileName = path.basename(filePath);
            
            console.log(`[Upload] 上传文件: ${fileName} (${(fileBuffer.length / 1024).toFixed(2)} KB)`);
            
            const token = await this.getAccessToken();
            const response = await axios.post(
                `${this.config.apiBase}/v2/users/${openid}/files`,
                {
                    file_type: 4,  // 4 表示普通文件
                    file_data: base64Data,
					file_name: "测试.pdf",
                    url: "",
                    srv_send_msg: false
                },
                {
                    headers: {
                        'Authorization': `QQBot ${token}`,
                        'Content-Type': 'application/json'
                    },
                    timeout: 30000
                }
            );
            
            console.log('[Upload] 上传成功');
			console.log(response.data);
            return response.data;
        } catch (error) {
            console.error('[Upload] 上传失败:', error.response?.data || error.message);
            throw error;
        }
    }

    // ==================== 发送文件消息 ====================
    async sendFileMessage(openid, fileInfo, msgId = null) {
        try {
            const token = await this.getAccessToken();
            const payload = {
                msg_type: 7,
                media: {
                    file_info: fileInfo
                }
            };

            if (msgId) {
                payload.msg_id = msgId;
                payload.msg_seq = this.getMessageSeq(msgId);
            }

            const response = await axios.post(
                `${this.config.apiBase}/v2/users/${openid}/messages`,
                payload,
                {
                    headers: {
                        'Authorization': `QQBot ${token}`,
                        'Content-Type': 'application/json'
                    },
                    timeout: 10000
                }
            );
            console.log('[SendFile] 文件发送成功');
            return response.data;
        } catch (error) {
            console.error('[SendFile] 文件发送失败:', error.response?.data || error.message);
            throw error;
        }
    }

    // ==================== 发送 PDF ====================
    async sendPDF(openid, msgId = null) {
        const uploadResult = await this.uploadFile(openid, this.config.pdfPath);
        
        if (!uploadResult.file_info) {
            throw new Error('上传未返回 file_info');
        }
        
        await this.sendFileMessage(openid, uploadResult.file_info, msgId);
        console.log('[SendPDF] PDF 发送完成');
    }

    // ==================== 发送文本消息（错误提示用） ====================
    async sendTextMessage(openid, content, msgId = null) {
        try {
            const token = await this.getAccessToken();
            const payload = {
                content: content,
                msg_type: 0,
            };

            if (msgId) {
                payload.msg_id = msgId;
                payload.msg_seq = this.getMessageSeq(msgId);
            }

            await axios.post(
                `${this.config.apiBase}/v2/users/${openid}/messages`,
                payload,
                {
                    headers: {
                        'Authorization': `QQBot ${token}`,
                        'Content-Type': 'application/json'
                    },
                    timeout: 10000
                }
            );
            console.log('[SendText] 文本发送成功');
        } catch (error) {
            console.error('[SendText] 文本发送失败:', error.response?.data || error.message);
        }
    }

    // ==================== WebSocket 连接 ====================
    async connect() {
        await this.getAccessToken();

        console.log(`[WS] 正在连接: ${this.config.gatewayUrl}`);
        this.ws = new WebSocket(this.config.gatewayUrl);

        this.ws.on('open', () => {
            console.log('[WS] 连接已建立');
            this.reconnectAttempts = 0;
        });

        this.ws.on('message', (data) => {
            try {
                const message = JSON.parse(data.toString());
                this.handleMessage(message);
            } catch (e) {
                console.error('[WS] 消息解析失败:', e.message);
            }
        });

        this.ws.on('close', (code, reason) => {
            console.log(`[WS] 连接关闭, code: ${code}, reason: ${reason.toString()}`);
            this.stopHeartbeat();
            this.scheduleReconnect();
        });

        this.ws.on('error', (error) => {
            console.error('[WS] 连接错误:', error.message);
        });
    }

    handleMessage(message) {
        const { op, d, s, t } = message;

        if (s) {
            this.lastSeq = s;
        }

        switch (op) {
            case 10:
                console.log('[Hello] 收到心跳周期:', d.heartbeat_interval, 'ms');
                this.startHeartbeat(d.heartbeat_interval);
                if (this.sessionId && this.lastSeq) {
                    this.sendResume();
                } else {
                    this.sendIdentify();
                }
                break;

            case 11:
                console.log('[Heartbeat] ACK');
                break;

            case 0:
                this.handleDispatch(t, d);
                break;

            case 7:
                console.log('[Reconnect] 服务端要求重连');
                this.reconnect();
                break;

            case 9:
                console.log('[InvalidSession] 会话无效，需要重新鉴权');
                this.sessionId = null;
                this.lastSeq = null;
                this.sendIdentify();
                break;

            default:
                console.log('[WS] 收到未知 op:', op);
        }
    }

    handleDispatch(t, d) {
        switch (t) {
            case 'READY':
                this.sessionId = d.session_id;
                console.log('[READY] 鉴权成功');
                break;

            case 'RESUMED':
                console.log('[RESUMED] 会话恢复成功');
                break;

            case 'C2C_MESSAGE_CREATE':
                this.onC2CMessage(d);
                break;

            default:
                if (t) {
                    console.log(`[Event] ${t}`);
                }
        }
    }

    // ==================== 核心逻辑：收到消息就返回 PDF ====================
    async onC2CMessage(data) {
        const author = data.author?.user_openid;
        const msgId = data.id;
        const content = data.content || '';
        
        // 简单打印收到的消息
        console.log(`\n[收到] 用户: ${author.substring(0, 8)}... 内容: ${content || '(图片或文件)'}`);
        
        try {
            // 检查 PDF 文件是否存在
            if (!fs.existsSync(this.config.pdfPath)) {
                console.error(`[Error] PDF 文件不存在: ${this.config.pdfPath}`);
                await this.sendTextMessage(author, 'PDF 文件不存在', msgId);
                return;
            }
            
            // 发送 PDF
            console.log(`[回复] 发送 1.pdf`);
            await this.sendPDF(author, msgId);
            
        } catch (error) {
            console.error('[错误]', error.message);
            await this.sendTextMessage(author, '发送失败，请稍后重试', msgId);
        }
    }

    sendIdentify() {
        const identifyPayload = {
            op: 2,
            d: {
                token: `QQBot ${this.accessToken}`,
                intents: this.config.intents,
                shard: [0, 1],
                properties: {
                    $os: 'linux',
                    $browser: 'nodejs_qqbot',
                    $device: 'nodejs_qqbot'
                }
            }
        };
        console.log('[Identify] 发送鉴权...');
        this.ws.send(JSON.stringify(identifyPayload));
    }

    sendResume() {
        const resumePayload = {
            op: 6,
            d: {
                token: `QQBot ${this.accessToken}`,
                session_id: this.sessionId,
                seq: this.lastSeq
            }
        };
        console.log('[Resume] 尝试恢复会话, seq:', this.lastSeq);
        this.ws.send(JSON.stringify(resumePayload));
    }

    startHeartbeat(interval) {
        this.stopHeartbeat();
        this.heartbeatInterval = interval;
        console.log(`[Heartbeat] 启动心跳，间隔: ${interval}ms`);

        const sendHeartbeat = () => {
            if (this.ws && this.ws.readyState === WebSocket.OPEN) {
                const heartbeatPayload = {
                    op: 1,
                    d: this.lastSeq
                };
                this.ws.send(JSON.stringify(heartbeatPayload));
            }
        };

        this.heartbeatTimer = setInterval(sendHeartbeat, interval);
    }

    stopHeartbeat() {
        if (this.heartbeatTimer) {
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = null;
            console.log('[Heartbeat] 已停止');
        }
    }

    scheduleReconnect() {
        if (this.reconnectAttempts >= this.maxReconnectAttempts) {
            console.error('[Reconnect] 已达最大重连次数，退出');
            process.exit(1);
        }

        const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 60000);
        this.reconnectAttempts++;
        console.log(`[Reconnect] 将在 ${delay}ms 后第 ${this.reconnectAttempts} 次重连...`);

        setTimeout(() => {
            this.connect();
        }, delay);
    }

    reconnect() {
        if (this.ws) {
            this.ws.close();
        }
    }

    async start() {
        if (!fs.existsSync(this.config.pdfPath)) {
            console.error(`[Error] 找不到文件: ${this.config.pdfPath}`);
            console.log(`[提示] 请将 1.pdf 放在程序目录下`);
            process.exit(1);
        }
        
        const stats = fs.statSync(this.config.pdfPath);
        console.log(`[Init] 加载文件: 1.pdf (${(stats.size / 1024).toFixed(2)} KB)`);
        
        await this.connect();

        setInterval(async () => {
            try {
                await this.getAccessToken();
            } catch (e) {
                console.error('[Token] 刷新失败:', e.message);
            }
        }, 30 * 60 * 1000);
    }
}

// ==================== 启动 ====================
const client = new QQBotClient(CONFIG);
client.start().catch(console.error);