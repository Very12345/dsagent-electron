const WebSocket = require('ws');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');

class QQBotClient extends EventEmitter {
    constructor(config) {
        super();
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
        
        this.ensureTempDir();
    }

    ensureTempDir() {
        if (!fs.existsSync(this.config.tempDir)) {
            fs.mkdirSync(this.config.tempDir, { recursive: true });
            console.log(`[Init] 创建临时目录: ${this.config.tempDir}`);
        }
    }

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

    // ==================== 下载并保存文件 ====================
    async downloadAndSaveFile(fileUrl, userOpenId, msgId, fileInfo) {
        try {
            console.log(`[Download] 开始下载: ${fileInfo.filename || '未知文件'}`);
            console.log(`[Download] URL: ${fileUrl}`);
            
            const response = await axios({
                method: 'get',
                url: fileUrl,
                responseType: 'stream',
                timeout: 60000,
                headers: {
                    'User-Agent': 'QQBot-Client/1.0'
                }
            });

            const originalName = fileInfo.filename || 'unknown';
            const nameParts = originalName.split('.');
            const ext = nameParts.length > 1 ? `.${nameParts.pop()}` : '';
            const baseName = nameParts.join('.');
            
            // 保留完整原始文件名（仅移除危险字符）
            const safeBaseName = baseName.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim();
            let filename = `${safeBaseName}${ext}`;
            let filePath = path.join(this.config.tempDir, filename);
            
            // 文件已存在自动加 (1)(2) 编号
            let counter = 1;
            while (fs.existsSync(filePath)) {
                filename = `${safeBaseName}(${counter})${ext}`;
                filePath = path.join(this.config.tempDir, filename);
                counter++;
            }
            
            const writer = fs.createWriteStream(filePath);
            response.data.pipe(writer);
            
            return new Promise((resolve, reject) => {
                writer.on('finish', () => {
                    const stats = fs.statSync(filePath);
                    console.log(`[Download] 保存成功: ${filePath} (${(stats.size / 1024).toFixed(2)} KB)`);
                    resolve(filePath);
                });
                writer.on('error', (error) => {
                    console.error(`[Download] 保存失败: ${error.message}`);
                    reject(error);
                });
            });
        } catch (error) {
            console.error(`[Download] 下载失败: ${error.message}`);
            throw error;
        }
    }

    // ==================== 保存文字消息 ====================
    async saveTextMessage(userOpenId, msgId, content, timestamp, fileInfo = null) {
        try {
            const date = new Date(timestamp);
            const dateStr = `${date.getFullYear()}-${date.getMonth()+1}-${date.getDate()}`;
            const timeStr = `${date.getHours()}:${date.getMinutes()}:${date.getSeconds()}`;
            
            const filename = `${userOpenId}_${msgId}_text.txt`;
            const filePath = path.join(this.config.tempDir, filename);
            
            let textContent = `========================================\n`;
            textContent += `时间: ${dateStr} ${timeStr}\n`;
            textContent += `用户: ${userOpenId}\n`;
            textContent += `消息ID: ${msgId}\n`;
            textContent += `========================================\n`;
            textContent += `文字内容:\n${content || '(无文字内容)'}\n`;
            
            if (fileInfo) {
                textContent += `\n========================================\n`;
                textContent += `附件信息:\n`;
                textContent += `  类型: ${fileInfo.content_type || '未知'}\n`;
                textContent += `  文件名: ${fileInfo.filename || '未知'}\n`;
                textContent += `  大小: ${(fileInfo.size / 1024).toFixed(2)} KB\n`;
                if (fileInfo.width && fileInfo.height) {
                    textContent += `  尺寸: ${fileInfo.width} x ${fileInfo.height}\n`;
                }
            }
            
            fs.writeFileSync(filePath, textContent, 'utf8');
            console.log(`[SaveText] 文字信息保存成功: ${filePath}`);
            
            if (content) {
                console.log(`[Content] ${content}`);
            }
            
            return filePath;
        } catch (error) {
            console.error(`[SaveText] 保存失败: ${error.message}`);
            throw error;
        }
    }

    // ==================== 处理消息 ====================
	async processMessage(data) {
		const author = data.author?.user_openid;
		const msgId = data.id;
		const timestamp = data.timestamp;
		
		// 获取文字内容（通常为空）
		let content = data.content || '';
		const attachments = data.attachments || [];
		
		console.log(`\n===== 收到消息 =====`);
		console.log(`用户: ${author}`);
		console.log(`消息ID: ${msgId}`);
		console.log(`时间: ${new Date(timestamp).toLocaleString()}`);
		console.log(`文字内容: ${content || '(无文字内容)'}`);
		console.log(`附件数量: ${attachments.length}`);
		
		// 1. 保存文字内容
		if (content) {
			await this.saveTextMessage(author, msgId, content, timestamp);
		}
		
		// 2. 处理附件（图片、文件等）
		const savedFiles = [];
		for (let i = 0; i < attachments.length; i++) {
			const att = attachments[i];
			const attContentType = att.content_type;
			const attFilename = att.filename;
			const attUrl = att.url;
			const attSize = att.size;
			const attWidth = att.width;
			const attHeight = att.height;
			
			// 判断是否为图片
			if (attContentType && attContentType.startsWith('image/')) {
				console.log(`[Image] 收到图片: ${attFilename}, 尺寸: ${attWidth}x${attHeight}, 大小: ${(attSize / 1024).toFixed(2)} KB`);
				console.log(`[Image] URL: ${attUrl}`);
				
				if (attUrl) {
					// 保存图片信息到文字文件
					const fileInfo = {
						filename: attFilename,
						content_type: attContentType,
						size: attSize,
						width: attWidth,
						height: attHeight
					};
					
					// 如果没有文字内容，在日志文件中记录图片信息
					if (!content) {
						await this.saveTextMessage(author, msgId, `[图片] ${attFilename}`, timestamp, fileInfo);
					} else {
						await this.saveTextMessage(author, msgId, content, timestamp, fileInfo);
					}
					
					// 下载并保存图片
					try {
						const savedPath = await this.downloadAndSaveFile(attUrl, author, msgId, fileInfo);
						savedFiles.push(savedPath);
					} catch (error) {
						console.error(`[Image] 下载失败: ${error.message}`);
					}
				}
			}
			// 判断是否为文件
			else if (attContentType === 'file') {
				console.log(`[File] 收到文件: ${attFilename}, 大小: ${(attSize / 1024).toFixed(2)} KB`);
				
				if (attUrl) {
					const fileInfo = {
						filename: attFilename,
						content_type: 'file',
						size: attSize
					};
					
					if (!content) {
						await this.saveTextMessage(author, msgId, `[文件] ${attFilename}`, timestamp, fileInfo);
					} else {
						await this.saveTextMessage(author, msgId, content, timestamp, fileInfo);
					}
					
					try {
						const savedPath = await this.downloadAndSaveFile(attUrl, author, msgId, fileInfo);
						savedFiles.push(savedPath);
					} catch (error) {
						console.error(`[File] 下载失败: ${error.message}`);
					}
				}
			}
		}
		
		// 3. 既无文字也无附件的情况
		if (!content && attachments.length === 0) {
			await this.saveTextMessage(author, msgId, '(空消息)', timestamp);
		}
		
		// 输出处理结果
		console.log(`\n[处理结果]`);
		console.log(`- 文字已保存: ${content ? '是' : '否'}`);
		console.log(`- 图片/文件已保存: ${savedFiles.length} 个`);
		if (savedFiles.length > 0) {
			savedFiles.forEach((file, idx) => {
				console.log(`  ${idx+1}. ${path.basename(file)}`);
			});
		}
		console.log(`=====================\n`);
		
		return { content, attachments, savedFiles };
	}

    // ==================== 上传图片 ====================
    async uploadC2CImage(openid, filePath) {
        try {
            if (!fs.existsSync(filePath)) {
                throw new Error(`文件不存在: ${filePath}`);
            }

            const fileBuffer = fs.readFileSync(filePath);
            const base64Data = fileBuffer.toString('base64');
            
            const ext = path.extname(filePath).toLowerCase();
            const mimeTypes = {
                '.png': 'image/png',
                '.jpg': 'image/jpeg',
                '.jpeg': 'image/jpeg',
            };
            const mimeType = mimeTypes[ext];
            if (!mimeType) {
                throw new Error(`不支持的图片格式: ${ext}，仅支持 png/jpg`);
            }

            console.log(`[Upload] 正在上传图片: ${filePath} (${(fileBuffer.length / 1024).toFixed(2)} KB)`);
            
            const token = await this.getAccessToken();
            const response = await axios.post(
                `${this.config.apiBase}/v2/users/${openid}/files`,
                {
                    file_type: 1,
                    file_data: base64Data,
                    file_name: path.basename(filePath),
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
            
            console.log('[Upload] 上传成功:', JSON.stringify(response.data));
            return response.data;
        } catch (error) {
            console.error('[Upload] 上传失败:', error.response?.data || error.message);
            throw error;
        }
    }

    async sendC2CMediaMessage(openid, fileInfo, msgId = null) {
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
            console.log('[SendMedia] 图片消息发送成功:', JSON.stringify(response.data));
            return response.data;
        } catch (error) {
            console.error('[SendMedia] 图片消息发送失败:', error.response?.data || error.message);
            throw error;
        }
    }

    async sendC2CMessage(openid, content, msgId = null) {
        try {
            const token = await this.getAccessToken();
            
            const payload = {
                markdown: {
					content:content
				},
                msg_type: 2,
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
            console.log('[SendText] 文本消息发送成功:', JSON.stringify(response.data));
            return response.data;
        } catch (error) {
            console.error('[SendText] 文本消息发送失败:', error.response?.data || error.message);
            throw error;
        }
    }

    // ==================== 发送单张图片 ====================
    async sendImage(openid, imagePath, msgId = null) {
        try {
            console.log('[SendImage] 开始发送图片');

            const uploadResult = await this.uploadC2CImage(openid, imagePath);
            
            if (uploadResult.file_info) {
                const sendResult = await this.sendC2CMediaMessage(openid, uploadResult.file_info, msgId);
                console.log('[SendImage] 图片发送完成');
                return sendResult;
            } else {
                throw new Error('上传未返回 file_info');
            }
        } catch (error) {
            console.error('[SendImage] 图片发送失败:', error.message);
            throw error;
        }
    }

    // ==================== 发送富文本（文字+图片） ====================
    async sendRichMessage(openid, textContent, imagePath, msgId = null) {
        try {
            console.log('[RichMessage] 开始发送富文本消息（文字+图片）');
            
            // 步骤1: 上传图片
            const uploadResult = await this.uploadC2CImage(openid, imagePath);
            
            if (!uploadResult.file_info) {
                throw new Error('上传图片失败，未返回 file_info');
            }
            
            // 步骤2: 发送文字消息
            console.log('[RichMessage] 发送文字部分...');
            await this.sendC2CMessage(openid, textContent, msgId);
            
            // 等待一小段时间，避免消息顺序错乱
            await new Promise(resolve => setTimeout(resolve, 500));
            
            // 步骤3: 发送图片消息
            console.log('[RichMessage] 发送图片部分...');
            const sendResult = await this.sendC2CMediaMessage(openid, uploadResult.file_info, msgId);
            
            console.log('[RichMessage] 富文本消息发送完成');
            return sendResult;
            
        } catch (error) {
            console.error('[RichMessage] 富文本消息发送失败:', error.message);
            throw error;
        }
    }

    // ==================== 发送文件（type 7） ====================
    async sendFile(openid, filePath, msgId = null) {
        try {
            if (!fs.existsSync(filePath)) throw new Error(`文件不存在: ${filePath}`);

            const fileBuffer = fs.readFileSync(filePath);
            const base64Data = fileBuffer.toString('base64');
            const ext = path.extname(filePath).toLowerCase();
            var fileType = 1; // 默认图片
            if (ext.match(/\.(mp4|avi|mov|mkv|webm)$/i)) fileType = 2;
            else if (ext.match(/\.(mp3|wav|ogg|flac)$/i)) fileType = 3;
            else fileType = 4; // 普通文件

            console.log(`[SendFile] 发送文件: ${filePath} (type=${fileType})`);

            const token = await this.getAccessToken();
            const uploadRes = await axios.post(
                `${this.config.apiBase}/v2/users/${openid}/files`,
                {
                    file_type: fileType,
                    file_data: base64Data,
                    file_name: path.basename(filePath),
                    url: "",
                    srv_send_msg: false
                },
                {
                    headers: { 'Authorization': `QQBot ${token}`, 'Content-Type': 'application/json' },
                    timeout: 60000
                }
            );

            if (!uploadRes.data || !uploadRes.data.file_info) {
                throw new Error('上传未返回 file_info');
            }

            const payload = {
                msg_type: 7,
                media: { file_info: uploadRes.data.file_info }
            };
            if (msgId) { payload.msg_id = msgId; payload.msg_seq = this.getMessageSeq(msgId); }

            const sendRes = await axios.post(
                `${this.config.apiBase}/v2/users/${openid}/messages`,
                payload,
                {
                    headers: { 'Authorization': `QQBot ${token}`, 'Content-Type': 'application/json' },
                    timeout: 10000
                }
            );
            console.log('[SendFile] 文件消息发送成功');
            return sendRes.data;
        } catch (error) {
            console.error('[SendFile] 发送失败:', error.message);
            throw error;
        }
    }

    // ==================== 发送纯文本（type 2 markdown） ====================
    async sendText(openid, content, msgId = null) {
        return this.sendC2CMessage(openid, content, msgId);
    }

    // ==================== 发送测试富文本 ====================
    async sendTestRichMessage(openid, msgId = null) {
        const testText = `📦 测试富文本消息\n\n这是一条同时包含文字和图片的测试消息\n时间: ${new Date().toLocaleString()}`;
        await this.sendRichMessage(openid, testText, this.config.imagePath, msgId);
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
                console.log('[READY] 鉴权成功, session_id:', this.sessionId);
                console.log('[READY] 机器人信息:', d.user?.username, d.user?.id);
                break;

            case 'RESUMED':
                console.log('[RESUMED] 会话恢复成功');
                break;

            case 'C2C_MESSAGE_CREATE':
                this.onC2CMessage(d);
                break;

            default:
                if (t) {
                    console.log(`[Event] ${t}:`, JSON.stringify(d).substring(0, 200));
                }
        }
    }

    // ==================== 处理单聊消息（核心逻辑） ====================
    async onC2CMessage(data) {
        const author = data.author?.user_openid;
        const msgId = data.id;
        const content = data.content || '';
        const contentType = data.content_type;
        
        try {
            // 处理并保存消息
            var result = await this.processMessage(data);
            
            // 发送事件（供 Electron 主进程使用）
            this.emit('message', {
                openid: author,
                msgId: msgId,
                content: content,
                contentType: contentType,
                attachments: data.attachments || [],
                savedFiles: result.savedFiles || [],
                raw: data
            });

            // ========== 指令判断（优先处理） ==========
            // 所有指令由 Electron 主进程处理，这里不做处理
            // 直接回调 message 事件，让主进程处理
            console.log('[QQBot] 消息已转发给 AI 处理');
            
        } catch (error) {
            console.error('[Handle] 处理消息时出错:', error);
            try {
                await this.sendC2CMessage(author, '处理消息时出错了', msgId);
            } catch (sendError) {
                console.error('[Handle] 发送错误回复失败:', sendError);
            }
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
        // 检查图片是否存在
        if (!fs.existsSync(this.config.imagePath)) {
            console.error(`[Error] 图片不存在: ${this.config.imagePath}`);
            console.log(`[Warning] 图片发送功能将不可用，请创建 ${this.config.imagePath}`);
        }

        await this.connect();

        setInterval(async () => {
            try {
                await this.getAccessToken();
            } catch (e) {
                console.error('[Token] 定时刷新失败:', e.message);
            }
        }, 30 * 60 * 1000);
    }
}

module.exports = QQBotClient;