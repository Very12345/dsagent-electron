

// ==================== 危险命令确认（嵌入工具卡片） ====================
var pendingConfirmMessageId = null;

// 全局加载遮罩
function showLoadingOverlay(msg) {
    var overlay = document.getElementById('global-loading-overlay');
    if (msg) overlay.querySelector('span').textContent = msg;
    overlay.style.display = 'flex';
}
function hideLoadingOverlay() {
    document.getElementById('global-loading-overlay').style.display = 'none';
}

window.electronAPI.onAgentShowConfirm(function(data) {
    pendingConfirmMessageId = data._messageId;
    var area = document.getElementById('chat-area');

    // 找到第一个仍显示"执行中"的工具卡片（按创建顺序）
    var cards = area.querySelectorAll('.tool-card');
    var targetCard = null;
    for (var ci = 0; ci < cards.length; ci++) {
        var statusEl = cards[ci].querySelector('.tool-status');
        if (statusEl && statusEl.textContent.indexOf('执行中') !== -1) {
            targetCard = cards[ci];
            break;
        }
    }

    if (!targetCard) {
        // 兜底：在聊天区底部创建确认栏
        var empty = area.querySelector('.empty-msg');
        if (empty) empty.remove();
        var fallback = document.createElement('div');
        fallback.style.cssText = 'margin:8px 20px;padding:10px 14px;background:#2a1a1a;border:1px solid #6e3a3a;border-radius:8px;';
        fallback.textContent = (data.cmdDisplay || data.cmd || data.lang || '');
        area.appendChild(fallback);
        var btnRow = document.createElement('div');
        btnRow.style.cssText = 'display:flex;gap:10px;margin:6px 20px;';
        btnRow.appendChild(createConfirmBtn(data, function() { fallback.remove(); btnRow.remove(); }));
        btnRow.appendChild(createCancelBtn(data, function() { fallback.remove(); btnRow.remove(); }));
        area.appendChild(btnRow);
        setTimeout(function() { area.scrollTop = area.scrollHeight; }, 50);
        return;
    }

    // 在目标卡片的结果区添加确认/取消按钮
    var resSec = targetCard.querySelector('.tool-result-section');
    if (!resSec) {
        // 卡片没有预留结果区 → 创建一个
        resSec = document.createElement('div');
        resSec.className = 'tool-result-section';
        resSec.style.cssText = 'padding:10px 14px;';
        var toolBody = targetCard.querySelector('.tool-card-body');
        if (!toolBody) {
            toolBody = document.createElement('div');
            toolBody.className = 'tool-card-body';
            toolBody.style.cssText = 'display:block;padding:0;border-top:1px solid var(--border-light);';
            targetCard.appendChild(toolBody);
        }
        toolBody.appendChild(resSec);
    }
    resSec.style.display = '';
    resSec.style.background = '#2a1a1a';
    // 清空并显示命令内容
    resSec.innerHTML = '';
    var cmdLabel = document.createElement('div');
    cmdLabel.style.cssText = 'font-size:11px;color:#e8b0b0;margin-bottom:6px;';
    cmdLabel.textContent = (data.cmdDisplay || data.cmd || data.lang || '');
    resSec.appendChild(cmdLabel);
    var btnRow = document.createElement('div');
    btnRow.style.cssText = 'display:flex;gap:10px;';
    (function(rs) {
        btnRow.appendChild(createConfirmBtn(data, function() {
            rs.innerHTML = '<span style="color:#5a9a5a;font-size:12px;">? 已确认执行</span>';
        }));
        btnRow.appendChild(createCancelBtn(data, function() {
            rs.innerHTML = '<span style="color:#e8b0b0;font-size:12px;">? 已取消</span>';
        }));
    })(resSec);
    resSec.appendChild(btnRow);
    // 更新状态
    var statusEl = targetCard.querySelector('.tool-status');
    if (statusEl) statusEl.innerHTML = '<span style="color:#e8b0b0;">? 待确认</span>';
    // 展开卡片以便看到按钮
    var body = targetCard.querySelector('.tool-card-body');
    if (body && body.style.display === 'none') {
        body.style.display = '';
    }
    setTimeout(function() { area.scrollTop = area.scrollHeight; }, 50);
});

// ==================== 频率限制/服务器繁忙弹窗 ====================
var pendingRateLimitMessageId = null;
var ratelimitTimer = null;
var ratelimitAutoTimer = null;
window.electronAPI.onAgentShowRateLimit(function(data) {
    pendingRateLimitMessageId = data._messageId;
    var modal = document.getElementById('ratelimit-modal');
    var titleEl = document.getElementById('ratelimit-title');
    var autoEl = document.getElementById('ratelimit-auto');
    if (!modal || !autoEl) return;

    // 根据错误类型设置标题
    var errorType = data.errorType || 'ratelimit';
    if (errorType === 'serverbusy') {
        titleEl.textContent = '?? 服务器繁忙';
    } else {
        titleEl.textContent = '?? 消息发送过于频繁';
    }

    var autoCountdown = 60; // 60秒自动重试
    autoEl.textContent = autoCountdown;
    modal.style.display = 'flex';

    // 清除之前的定时器
    if (ratelimitTimer) clearInterval(ratelimitTimer);
    if (ratelimitAutoTimer) clearInterval(ratelimitAutoTimer);
    ratelimitTimer = null;

    // 每秒更新自动重试倒计时
    ratelimitAutoTimer = setInterval(function() {
        autoCountdown--;
        autoEl.textContent = autoCountdown;
        if (autoCountdown <= 0) {
            // 60秒到达，自动点击重试
            clearInterval(ratelimitAutoTimer);
            ratelimitAutoTimer = null;
            modal.style.display = 'none';
            if (pendingRateLimitMessageId) {
                window.electronAPI.agentRateLimitResponse({ _messageId: pendingRateLimitMessageId, confirmed: true });
                pendingRateLimitMessageId = null;
            }
        }
    }, 1000);
});

document.getElementById('ratelimit-confirm').onclick = function() {
    if (ratelimitTimer) { clearInterval(ratelimitTimer); ratelimitTimer = null; }
    if (ratelimitAutoTimer) { clearInterval(ratelimitAutoTimer); ratelimitAutoTimer = null; }
    document.getElementById('ratelimit-modal').style.display = 'none';
    if (pendingRateLimitMessageId) {
        window.electronAPI.agentRateLimitResponse({ _messageId: pendingRateLimitMessageId, confirmed: true });
        pendingRateLimitMessageId = null;
    }
};
document.getElementById('ratelimit-cancel').onclick = function() {
    if (ratelimitTimer) { clearInterval(ratelimitTimer); ratelimitTimer = null; }
    if (ratelimitAutoTimer) { clearInterval(ratelimitAutoTimer); ratelimitAutoTimer = null; }
    document.getElementById('ratelimit-modal').style.display = 'none';
    if (pendingRateLimitMessageId) {
        window.electronAPI.agentRateLimitResponse({ _messageId: pendingRateLimitMessageId, confirmed: false });
        pendingRateLimitMessageId = null;
    }
};

function createConfirmBtn(data, onDone) {
    var btn = document.createElement('button');
    btn.textContent = '? 执行';
    btn.style.cssText = 'padding:6px 18px;background:#c0392b;color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:13px;font-weight:600;';
    btn.onclick = function() {
        if (pendingConfirmMessageId) {
            window.electronAPI.agentConfirmResponse({ _messageId: pendingConfirmMessageId, confirmed: true });
            pendingConfirmMessageId = null;
        }
        onDone();
    };
    return btn;
}

function createCancelBtn(data, onDone) {
    var btn = document.createElement('button');
    btn.textContent = '? 取消';
    btn.style.cssText = 'padding:6px 18px;background:#555;color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:13px;';
    btn.onclick = function() {
        if (pendingConfirmMessageId) {
            window.electronAPI.agentConfirmResponse({ _messageId: pendingConfirmMessageId, confirmed: false });
            pendingConfirmMessageId = null;
        }
        onDone();
    };
    return btn;
}

let agentMode = 'expert';
let agentDeepThink = true;
let conversationId = Date.now();
let initCompleted = false;
let currentTheme = 'dark';
// 历史对话追踪
let currentHistoryId = null;
let currentHistoryMessages = [];
let currentSubSessions = [];
let currentHistoryDeepseekUrl = null;
let currentHistoryExpired = false;
// 每个对话独立的计划和 Skill 步骤数据
let currentPlan = null;          // { title, steps, ... }
let currentSkillStepStore = {};  // { skillName: [ { step, status, ts } ] }
// 更新发送按钮状态（根据 isTaskChainActive 综合决定）
// isTaskChainActive 标记整个任务链（输入→工具调用→...→最终输出）是否活跃
function updateSendBtn() {
    var btn = document.getElementById('send-prompt-btn');
    if (!btn) return;
    if (isTaskChainActive) {
        btn.textContent = '? 停止';
        btn.disabled = false;
        btn.classList.add('stop-btn');
    } else {
        btn.textContent = '发送';
        btn.disabled = false;
        btn.classList.remove('stop-btn');
    }
}

// 工具图标映射
function getToolIcon(toolName) {
    var iconMap = {
        'read': '??', 'local-read': '??',
        'write': '??', 'local-write': '??',
        'exec': '??', 'local-exec': '??',
        'cmd': '???', 'local-cmd': '???',
        'edit': '??', 'local-edit': '??',
        'delete': '???', 'local-delete': '???',
        'exists': '??', 'local-exists': '??',
        'list': '??', 'local-list': '??',
        'break': '??', 'local-break': '??',
        'skill': '??', 'local-skill': '??',
        'mcp-list': '??',
        'mcp-init': '??',
        'browser': '??', 'local-browser': '??',
        'save': '??', 'local-save': '??',
        'interval': '?', 'local-interval': '?',
        'file': '??', 'local-file': '??',
        'open': '??', 'local-open': '??',
        'rename': '??', 'local-rename': '??',
        'mkdir': '??', 'local-mkdir': '??',
        'copy': '??', 'local-copy': '??',
        'move': '??', 'local-move': '??',
        'url': '??', 'local-url': '??',
        'grep': '??', 'local-grep': '??',
        'help': '?', 'local-help': '?',
        'config': '??', 'local-config': '??',
        'env': '??', 'local-env': '??',
        'shell': '??', 'local-shell': '??',
        'python': '??', 'local-python': '??',
        'node': '??', 'local-node': '??',
        'npm': '??', 'local-npm': '??',
        'git': '??', 'local-git': '??',
        'ssh': '??', 'local-ssh': '??',
        'http': '??', 'local-http': '??',
        'api': '??', 'local-api': '??',
        'json': '??', 'local-json': '??',
        'yaml': '??', 'local-yaml': '??',
        'xml': '??', 'local-xml': '??',
        'csv': '??', 'local-csv': '??',
        'pdf': '??', 'local-pdf': '??',
        'image': '???', 'local-image': '???',
        'audio': '??', 'local-audio': '??',
        'video': '??', 'local-video': '??',
        'zip': '??', 'local-zip': '??',
        'tar': '??', 'local-tar': '??',
        '7z': '??', 'local-7z': '??',
        'unzip': '??', 'local-unzip': '??',
        'extract': '??', 'local-extract': '??',
        'convert': '??', 'local-convert': '??',
        'resize': '??', 'local-resize': '??',
        'crop': '??', 'local-crop': '??',
        'ocr': '??', 'local-ocr': '??',
        'translate': '??', 'local-translate': '??',
        'summary': '??', 'local-summary': '??',
        'analyze': '??', 'local-analyze': '??',
        'search': '??', 'local-search': '??',
        'websearch': '??', 'local-websearch': '??',
        'weather': '???', 'local-weather': '???',
        'time': '?', 'local-time': '?',
        'date': '??', 'local-date': '??',
        'calc': '??', 'local-calc': '??',
        'math': '∑', 'local-math': '∑',
        'crypto': '??', 'local-crypto': '??',
        'hash': '??', 'local-hash': '??',
        'base64': '??', 'local-base64': '??',
        'encode': '??', 'local-encode': '??',
        'decode': '??', 'local-decode': '??',
        'uuid': '??', 'local-uuid': '??',
        'random': '??', 'local-random': '??',
        'sleep': '??', 'local-sleep': '??',
        'ping': '??', 'local-ping': '??',
        'dns': '??', 'local-dns': '??',
        'port': '??', 'local-port': '??',
        'network': '??', 'local-network': '??',
        'system': '??', 'local-system': '??',
        'memory': '??', 'local-memory': '??',
        'cpu': '??', 'local-cpu': '??',
        'disk': '??', 'local-disk': '??',
        'process': '??', 'local-process': '??',
        'kill': '??', 'local-kill': '??',
        'ps': '??', 'local-ps': '??',
        'top': '??', 'local-top': '??',
        'log': '??', 'local-log': '??',
        'debug': '??', 'local-debug': '??',
        'trace': '??', 'local-trace': '??',
        'test': '??', 'local-test': '??',
        'build': '??', 'local-build': '??',
        'deploy': '??', 'local-deploy': '??',
        'run': '??', 'local-run': '??',
        'start': '??', 'local-start': '??',
        'stop': '??', 'local-stop': '??',
        'restart': '??', 'local-restart': '??',
        'status': '??', 'local-status': '??',
        'info': '??', 'local-info': '??',
        'version': '??', 'local-version': '??',
        'about': '??', 'local-about': '??',
        'exit': '??', 'local-exit': '??',
        'quit': '??', 'local-quit': '??',
        'help': '?', 'local-help': '?'
    };
    return iconMap[toolName] || iconMap[toolName.replace(/^local-/, '')] || '??';
}

// 生成状态（用于停止按钮）
let isGenerating = false;
let isExecutingTasks = false;
let isTaskChainActive = false; // 标记整个任务链是否活跃（输入→工具调用→...→最终输出）
let _stopWaitingResolve = null;  // 停止等待的 Promise resolve
let isInWorkflow = false;
let workflowWrappers = []; // 多个 <details>，每轮一个
function getCurrentWorkflowWrapper() { return workflowWrappers[workflowWrappers.length - 1] || null; }
let currentRootDir = ''; // 用于解析本地图片路径

// 初始化时获取根目录
window.electronAPI.getRootDir().then(function(dir) { currentRootDir = dir || ''; });

// ==================== 主题同步 ====================
window.electronAPI.onAgentTheme(function(theme) {
    currentTheme = theme;
    if (theme === 'light') {
        document.body.classList.add('light-theme');
    } else {
        document.body.classList.remove('light-theme');
    }
    // 同步 workflow wrapper 主题（所有 details 元素）
    workflowWrappers.forEach(function(w) {
        if (theme === 'light') w.classList.add('light');
        else w.classList.remove('light');
    });
});

// ==================== 历史对话同步刷新 ====================
window.electronAPI.onRefreshHistory(function() {
    loadHistoryList();
});

// ==================== 恢复上次历史对话 ====================
window.electronAPI.onRestoreHistory(function(historyId) {
    if (historyId) {
        loadHistoryConversation(historyId);
    }
});

// ==================== 历史对话管理 ====================
function loadHistoryList() {
    var listEl = document.getElementById('history-list');
    listEl.innerHTML = '<div class="history-empty">加载中...</div>';
    window.electronAPI.historyList().then(function(res) {
        if (!res.success || !res.histories || res.histories.length === 0) {
            listEl.innerHTML = '<div class="history-empty">没有历史对话</div>';
            return;
        }
        listEl.innerHTML = '';
        res.histories.forEach(function(h) {
            var item = document.createElement('div');
            item.className = 'history-item' + (h.id === currentHistoryId ? ' active' : '');
            item.innerHTML = '<div class="hi-title">' + escapeHtml(h.title || '(无标题)') + '</div>'
                + '<div class="hi-meta">' + formatTime(h.updatedAt) + ' | ' + h.messageCount + '条'
                + (h.subSessionCount > 0 ? ' +' + h.subSessionCount + '子' : '') + '</div>'
                + '<span class="hi-delete" title="删除此对话">&#x2715;</span>';
            var deleteBtn = item.querySelector('.hi-delete');
            deleteBtn.addEventListener('click', async function(e) {
                e.stopPropagation();
                if (!await confirmModal('确定删除此历史对话？')) return;
                showLoadingOverlay('正在删除...');
                try {
                    // 直接从列表项获取 deepseekUrl（无需加载完整历史）
                    var deepseekUrl = h.deepseekUrl || '';
                    if (deepseekUrl) {
                        hideLoadingOverlay();
                        var deleteCloud = await confirmModal('是否同时也删除 DeepSeek 上的原始对话？');
                        if (deleteCloud) {
                            showLoadingOverlay('正在删除云端对话...');
                            await window.electronAPI.agentDeleteDeepseekConversation(deepseekUrl);
                        }
                    }
                    showLoadingOverlay('正在删除...');
                    await deleteHistoryItemAsync(h.id);
                } finally {
                    hideLoadingOverlay();
                }
            });
            item.onclick = function() { loadHistoryConversation(h.id); };
            listEl.appendChild(item);
        });
    }).catch(function() {
        listEl.innerHTML = '<div class="history-empty">加载失败</div>';
    });
}

function getConversationTitle() {
    // 取第一条用户消息作为标题
    for (var i = 0; i < currentHistoryMessages.length; i++) {
        var m = currentHistoryMessages[i];
        if (m.role === 'user' && m.content) {
            var txt = m.content.replace(/```[\s\S]*?```/g, '').trim();
            return txt.substring(0, 30) + (txt.length > 30 ? '...' : '');
        }
    }
    return '(无标题)';
}

function saveCurrentHistory() {
    if (!currentHistoryId) return;
    // 没有消息时不保存（避免产生"(无标题)"的空对话）
    if (!currentHistoryMessages || currentHistoryMessages.length === 0) return;
    var title = getConversationTitle();
    window.electronAPI.getReadTools().then(function(tools) {
        var historyData = {
            id: currentHistoryId,
            mode: agentMode,
            deepthink: agentDeepThink,
            deepseekUrl: currentHistoryDeepseekUrl || '',
            createdAt: currentHistoryId,
            updatedAt: new Date().toISOString(),
            title: title,
            messages: currentHistoryMessages,
            subSessions: currentSubSessions,
            readTools: tools || [],
            plan: currentPlan,           // 计划数据
            skillStep: currentSkillStepStore,  // Skill 步骤数据
            workflowCollapsed: (function() { var c = getCurrentWorkflowWrapper(); return c && c.tagName === 'DETAILS' ? !c.hasAttribute('open') : false; })()
        };
        window.electronAPI.historySave(historyData);
        // 刷新侧边栏，更新标题和时间
        loadHistoryList();
    });
}

function loadHistoryConversation(id) {
    // 如果已经是当前对话，不重复渲染，只恢复 DeepSeek 会话
    if (currentHistoryId === id) {
        if (currentHistoryDeepseekUrl) {
            window.electronAPI.historyRestoreConversation(currentHistoryDeepseekUrl);
        }
        loadHistoryList(); // 刷新高亮
        return;
    }

    var btn = document.getElementById('send-prompt-btn');
    btn.disabled = true;
    currentHistoryExpired = false;

    window.electronAPI.historyLoad(id).then(function(res) {
        if (!res.success || !res.history) return;
        var h = res.history;

        // 清除当前状态
        var area = document.getElementById('chat-area');
        area.innerHTML = '';
        hideLoading();
        workflowWrappers = []; // 需要重建

        // 恢复到初始化后状态
        initCompleted = true;
        agentMode = h.mode || 'expert';
        agentDeepThink = h.deepthink !== false;
        document.getElementById('deepthink-switch').classList.toggle('on', agentDeepThink);
        document.getElementById('pre-init-section').style.display = 'none';
        document.getElementById('post-init-section').style.display = 'block';
        document.getElementById('mode-label').textContent = agentMode === 'expert' ? '专家模式' : (agentMode === 'image' ? '识图模式' : '快速模式');
        var deepthinkRow = document.getElementById('deepthink-switch').parentElement;
        deepthinkRow.style.display = agentMode === 'image' ? 'none' : '';

        currentHistoryId = h.id;
        conversationId = parseInt(h.id) || Date.now();
        currentHistoryMessages = h.messages || [];
        currentSubSessions = h.subSessions || [];
        currentHistoryDeepseekUrl = h.deepseekUrl || '';

        // 恢复当前对话的计划和 Skill 步骤
        currentPlan = h.plan || null;
        currentSkillStepStore = h.skillStep || {};
        renderPlanPanel(currentPlan);
        renderSkillStepFromStore();

        // 通知主进程保存当前历史对话 ID
        window.electronAPI.setLastHistoryId(h.id);

        // 重置生成状态
        isGenerating = false;
        isExecutingTasks = false;
        isTaskChainActive = false;

        // ======== 渲染消息（workflow 容器在渲染过程中按需创建） ========
        renderHistoryMessages(area, h.messages || [], h.workflowCollapsed);

        // ======== 然后异步校验 DeepSeek 会话有效性 ========
        if (currentHistoryDeepseekUrl) {
            // 添加同步提示（不影响已渲染的消息）
            var syncEl = document.createElement('div');
            syncEl.style.cssText = 'text-align:center;padding:6px;margin:4px 0 8px;color:#888;font-size:12px;';
            syncEl.textContent = '? 同步对话中...';
            area.appendChild(syncEl);
            scrollToBottom();

            window.electronAPI.historyRestoreConversation(currentHistoryDeepseekUrl).then(function(restoreRes) {
                // 如果期间切换了对话，忽略这次回调（避免竞态）
                var currentArea = document.getElementById('chat-area');
                if (!currentArea || currentArea !== area || currentHistoryId !== h.id) return;
                // DeepSeek 页面加载完毕，此时设置 readTools 才不会被重载覆盖
                if (h.readTools && h.readTools.length > 0) {
                    window.electronAPI.setReadTools(h.readTools);
                }
                // 刷新 readTools 显示
                setTimeout(refreshReadToolsDisplay, 1500);
                if (syncEl.parentNode) syncEl.remove();
                if (restoreRes && restoreRes.valid) {
                    currentHistoryExpired = false;
                    btn.disabled = false;
                    btn.textContent = '发送';
                    setTimeout(function() { document.getElementById('prompt-input').focus(); }, 300);
                } else {
                    // 检查是否已有失效标记，避免重复
                    if (currentArea.querySelector('[data-role="expired-badge"]')) return;
                    currentHistoryExpired = true;
                    btn.disabled = true;
                    btn.textContent = '失效';
                    var expiredBadge = document.createElement('div');
                    expiredBadge.setAttribute('data-role', 'expired-badge');
                    expiredBadge.style.cssText = 'text-align:center;padding:8px;margin:8px 0;color:#e88;background:#3a1a1a;border-radius:8px;font-size:13px;';
                    expiredBadge.textContent = '?? 此对话在 DeepSeek 上已过期或不存在，无法继续发送消息';
                    currentArea.appendChild(expiredBadge);
                    scrollToBottom();
                }
            }).catch(function() {
                var currentArea = document.getElementById('chat-area');
                if (!currentArea || currentArea !== area || currentHistoryId !== h.id) return;
                if (syncEl.parentNode) syncEl.remove();
                if (currentArea.querySelector('[data-role="expired-badge"]')) return;
                currentHistoryExpired = true;
                btn.disabled = true;
                var expiredBadge = document.createElement('div');
                expiredBadge.setAttribute('data-role', 'expired-badge');
                expiredBadge.style.cssText = 'text-align:center;padding:8px;margin:8px 0;color:#e88;background:#3a1a1a;border-radius:8px;font-size:13px;';
                expiredBadge.textContent = '?? 此对话已失效，无法继续发送消息';
                currentArea.appendChild(expiredBadge);
                scrollToBottom();
            });
        } else {
            // 没有 URL，直接标记为失效
            currentHistoryExpired = true;
            btn.disabled = true;
            if (!area.querySelector('[data-role="expired-badge"]')) {
                var expiredBadge = document.createElement('div');
                expiredBadge.setAttribute('data-role', 'expired-badge');
                expiredBadge.style.cssText = 'text-align:center;padding:8px;margin:8px 0;color:#e88;background:#3a1a1a;border-radius:8px;font-size:13px;';
                expiredBadge.textContent = '?? 此对话已失效（无关联会话），无法继续发送消息';
                area.appendChild(expiredBadge);
            }
        }

        // 高亮选中的历史
        loadHistoryList();
        scrollToBottom();
    });
}

function renderHistoryMessages(area, messages, workflowCollapsed) {
    var lastWasWorkflow = false;
    (messages || []).forEach(function(msg) {
        if (msg.role === 'user') {
            addMessage('user', msg.content);
            lastWasWorkflow = false;
        } else if (msg.role === 'assistant') {
            addMessage('assistant', msg.content);
            lastWasWorkflow = false;
        } else if (msg.segments) {
            if (msg.isWorkflow) {
                // 连续 workflow 段共享同一个 wrapper
                if (!lastWasWorkflow) {
                    var details = document.createElement('details');
                    details.className = 'workflow-wrap' + (currentTheme === 'light' ? ' light' : '');
                    if (!workflowCollapsed) details.setAttribute('open', '');
                    var summary = document.createElement('summary');
                    summary.innerHTML = '<span>工作流程</span><span class="badge">' + (workflowCollapsed ? '折叠' : '展开') + '</span>';
                    var wfBody = document.createElement('div');
                    wfBody.className = 'wf-body';
                    details.appendChild(summary);
                    details.appendChild(wfBody);
                    area.appendChild(details);
                    workflowWrappers.push(details);
                }
                var wfBody = workflowWrappers[workflowWrappers.length - 1].querySelector('.wf-body');
                if (wfBody) renderWorkflowSegments(wfBody, msg.segments);
                lastWasWorkflow = true;
                return;
            }
            addAssistantSegments(msg.segments, true);
            lastWasWorkflow = false;
        }
    });
    if ((messages || []).length === 0) {
        var empty = document.createElement('div');
        empty.className = 'empty-msg';
        empty.textContent = '此对话没有消息';
        area.appendChild(empty);
    }
}

// 历史回放时渲染工作流程段（简化版）
function renderWorkflowSegments(container, segments) {
    segments.forEach(function(seg) {
        var group = document.createElement('div');
        group.className = 'msg-group';
        if (seg.type === 'text' && seg.content.trim()) {
            var label = document.createElement('div');
            label.className = 'msg-label';
            label.textContent = '助手';
            group.appendChild(label);
            var msgEl = document.createElement('div');
            msgEl.className = 'msg-assistant';
            msgEl.innerHTML = renderMarkdown(seg.content);
            group.appendChild(msgEl);
            container.appendChild(group);
        } else if (seg.type === 'tool-call') {
            if (!seg.content && !seg.lang) return;
            var toolCard = document.createElement('div');
            toolCard.className = 'tool-card';
            toolCard.style.marginLeft = '20px';
            var toolHeader = document.createElement('div');
            toolHeader.style.cssText = 'display:flex;align-items:center;gap:8px;padding:10px 14px;cursor:pointer;font-size:13px;user-select:none;transition:background .2s;';
            var toolName = (seg.lang || 'unknown').replace(/^local-/, '');
            var toolIcon = getToolIcon(seg.lang || '');
            toolHeader.innerHTML = '<span class="tool-arrow" style="transition:transform .25s;transform:rotate(-90deg);font-size:10px;">&#9660;</span><span style="font-size:14px;margin-right:6px;">' + toolIcon + '</span><span class="tool-name" style="font-weight:600;">' + escapeHtml(toolName) + '</span><span class="tool-status" style="font-size:12px;margin-left:auto;">● 已返回</span>';
            var toolBody = document.createElement('div');
            toolBody.className = 'tool-card-body';
            toolBody.style.cssText = 'display:none;padding:0;border-top:1px solid var(--border-light);';
            var callSection = document.createElement('div');
            callSection.className = 'tool-call-section';
            callSection.style.cssText = 'padding:10px 14px;';
            var callLabel = document.createElement('div');
            callLabel.className = 'tool-call-label';
            callLabel.style.cssText = 'font-size:11px;margin-bottom:4px;color:var(--text-muted);';
            callLabel.textContent = '调用参数';
            callSection.appendChild(callLabel);
            var callContent = document.createElement('pre');
            callContent.className = 'tool-call-content';
            callContent.style.cssText = 'margin:0;font-family:monospace;font-size:13px;line-height:1.5;white-space:pre-wrap;word-wrap:break-word;';
            callContent.textContent = seg.content;
            callSection.appendChild(callContent);
            toolBody.appendChild(callSection);
            toolHeader.addEventListener('click', function() {
                var arrow = this.querySelector('.tool-arrow');
                if (toolBody.style.display === 'none') {
                    toolBody.style.display = '';
                    arrow.style.transform = 'rotate(0deg)';
                    this.style.background = 'var(--bg-hover)';
                } else {
                    toolBody.style.display = 'none';
                    arrow.style.transform = 'rotate(-90deg)';
                    this.style.background = '';
                }
            });
            toolCard.appendChild(toolHeader);
            toolCard.appendChild(toolBody);
            group.appendChild(toolCard);
            container.appendChild(group);
        } else if (seg.type === 'tool-result') {
            var cards = container.querySelectorAll('.tool-card');
            var targetCard = cards[cards.length - 1];
            if (targetCard) {
                // 找到 toolBody，将结果追加到可折叠区域内
                var toolBody = targetCard.querySelector('.tool-card-body');
                if (!toolBody) {
                    toolBody = document.createElement('div');
                    toolBody.className = 'tool-card-body';
                    toolBody.style.cssText = 'display:none;padding:0;border-top:1px solid var(--border-light);';
                    targetCard.appendChild(toolBody);
                }
                var resSec = document.createElement('div');
                resSec.className = 'tool-result-section';
                resSec.style.cssText = 'padding:10px 14px;background:color-mix(in srgb, var(--success) 10%, transparent);';
                var resLabel = document.createElement('div');
                resLabel.style.cssText = 'font-size:11px;margin-bottom:4px;display:flex;align-items:center;gap:6px;';
                resLabel.innerHTML = '<span>返回结果</span><span class="res-copy-btn" style="cursor:pointer;font-size:11px;padding:1px 6px;border:1px solid var(--border);border-radius:3px;user-select:none;" title="复制结果">复制</span>';
                resSec.appendChild(resLabel);
                var resContent = document.createElement('div');
                resContent.className = 'result-content';
                resContent.style.cssText = 'font-family:monospace;font-size:13px;line-height:1.5;word-wrap:break-word;';
                resContent.innerHTML = renderMarkdown(seg.content);
                resSec.appendChild(resContent);
                // 复制按钮
                resLabel.querySelector('.res-copy-btn').addEventListener('click', function(e) {
                    e.stopPropagation();
                    var cbtn = this;
                    var rtext = seg.content || '';
                    window.electronAPI.clipboardSave().then(function(saved) {
                        window.electronAPI.clipboardWriteText(rtext).then(function() {
                            cbtn.textContent = '? 已复制';
                            setTimeout(function() {
                                cbtn.textContent = '复制';
                                if (saved && saved.text !== undefined) { window.electronAPI.clipboardRestore(saved.text); }
                            }, 2000);
                        }).catch(function() { cbtn.textContent = '? 复制失败'; });
                    });
                });
                toolBody.appendChild(resSec);
            }
        }
    });
}

function formatTime(isoStr) {
    if (!isoStr) return '';
    try {
        var d = new Date(isoStr);
        var month = (d.getMonth() + 1).toString().padStart(2, '0');
        var day = d.getDate().toString().padStart(2, '0');
        var hour = d.getHours().toString().padStart(2, '0');
        var min = d.getMinutes().toString().padStart(2, '0');
        return month + '-' + day + ' ' + hour + ':' + min;
    } catch(e) { return ''; }
}

function deleteHistoryItem(id) {
    window.electronAPI.historyDelete(id).then(function(res) {
        if (currentHistoryId === id) {
            // 当前对话被删除，完整重置状态
            currentHistoryId = null;
            currentHistoryMessages = [];
            currentSubSessions = [];
            currentHistoryDeepseekUrl = null;
            currentHistoryExpired = false;
            isGenerating = false;
            isExecutingTasks = false;
            isTaskChainActive = false;
            initCompleted = false;  // 重置初始化状态
            conversationId = null;
            // 通知主进程清除保存的历史对话 ID
            window.electronAPI.setLastHistoryId(null);
            var btn = document.getElementById('send-prompt-btn');
            if (btn) { btn.disabled = false; btn.textContent = '发送'; btn.classList.remove('stop-btn'); }
            // 清理可能残留的进度元素
            var progressEl = document.querySelector('.msg-assistant[id="qwen-progress-msg"]');
            if (progressEl && progressEl.parentNode) progressEl.parentNode.remove();
            // qwenProgressEl 已迁移到状态栏
            // 清理所有 tool-card 中的 filled 标记（避免影响后续）
            document.querySelectorAll('.tool-section-result').forEach(function(el) { delete el.dataset.filled; });
            // 重置聊天区
            var area = document.getElementById('chat-area');
            area.innerHTML = '';
            var empty = document.createElement('div');
            empty.className = 'empty-msg';
            empty.textContent = '选择模式后点击「创建对话」开始';
            area.appendChild(empty);
            document.getElementById('pre-init-section').style.display = '';
            document.getElementById('post-init-section').style.display = 'none';
            // 确保弹窗关闭
            document.getElementById('newchat-modal').style.display = 'none';
            // 确保输入框可用并聚焦
            var input = document.getElementById('prompt-input');
            if (input) { input.disabled = false; input.value = ''; input.focus(); }
        }
        loadHistoryList();
    });
}

// 异步版本的删除历史项（返回 Promise，用于 await）
function deleteHistoryItemAsync(id) {
    return new Promise(function(resolve) {
        window.electronAPI.historyDelete(id).then(function(res) {
            if (currentHistoryId === id) {
                currentHistoryId = null;
                currentHistoryMessages = [];
                currentSubSessions = [];
                currentHistoryDeepseekUrl = null;
                currentHistoryExpired = false;
                isGenerating = false;
                isExecutingTasks = false;
                isTaskChainActive = false;
                initCompleted = false;
                conversationId = null;
                window.electronAPI.setLastHistoryId(null);
                var btn = document.getElementById('send-prompt-btn');
                if (btn) { btn.disabled = false; btn.textContent = '发送'; btn.classList.remove('stop-btn'); }
                var progressEl = document.querySelector('.msg-assistant[id="qwen-progress-msg"]');
                if (progressEl && progressEl.parentNode) progressEl.parentNode.remove();
                document.querySelectorAll('.tool-section-result').forEach(function(el) { delete el.dataset.filled; });
                var area = document.getElementById('chat-area');
                area.innerHTML = '';
                var empty = document.createElement('div');
                empty.className = 'empty-msg';
                empty.textContent = '选择模式后点击「创建对话」开始';
                area.appendChild(empty);
                document.getElementById('pre-init-section').style.display = '';
                document.getElementById('post-init-section').style.display = 'none';
                document.getElementById('newchat-modal').style.display = 'none';
                var input = document.getElementById('prompt-input');
                if (input) { input.disabled = false; input.value = ''; input.focus(); }
            }
            loadHistoryList();
            resolve();
        }).catch(function() {
            loadHistoryList();
            resolve();
        });
    });
}

// ==================== 模式控制 ====================
function selectMode(el) {
    document.querySelectorAll('.mode-btn').forEach(function(b) { b.classList.remove('active'); });
    el.classList.add('active');
    agentMode = el.dataset.mode;
}

function toggleDeepThink() {
    agentDeepThink = !agentDeepThink;
    document.getElementById('deepthink-switch').classList.toggle('on', agentDeepThink);
    // 实时同步到 DeepSeek 页面
    window.electronAPI.agentToggleDeepThink(agentDeepThink);
}

// 拉起创建页面（显示模式选择 + 创建对话按钮，不立即创建）
function showPreInitSection() {
    // 如果已有对话，保存当前历史
    if (currentHistoryId && currentHistoryMessages.length > 0) {
        saveCurrentHistory();
    }
    // 重置状态
    currentHistoryId = Date.now().toString();
    currentHistoryMessages = [];
    currentSubSessions = [];
    currentHistoryExpired = false;
    currentHistoryDeepseekUrl = null;
    initCompleted = false;
    isGenerating = false;
    isExecutingTasks = false;
    isTaskChainActive = false;
    conversationId = null;
    // 清理聊天区
    var area = document.getElementById('chat-area');
    area.innerHTML = '';
    var empty = document.createElement('div');
    empty.className = 'empty-msg';
    empty.textContent = '选择模式后点击「创建对话」开始';
    area.appendChild(empty);
    _pendingToolCards = [];
    workflowWrappers = [];
    // 显示预初始化界面
    document.getElementById('pre-init-section').style.display = '';
    document.getElementById('post-init-section').style.display = 'none';
    // 同步模式选择器
    document.querySelectorAll('#pre-init-mode-selector .mode-btn').forEach(function(b) {
        b.classList.toggle('active', b.getAttribute('data-mode') === agentMode);
    });
    // 确保按钮可用
    var btn = document.getElementById('send-prompt-btn');
    if (btn) { btn.disabled = false; btn.textContent = '发送'; btn.classList.remove('stop-btn'); }
    var initBtn = document.getElementById('init-btn');
    if (initBtn) initBtn.disabled = false;
}

async function startNewChat() {
    // 清除 qwen 进度指示
    // qwenProgressEl 已迁移到状态栏
    var btn = document.getElementById('history-new-chat-btn');
    var initBtn = document.getElementById('init-btn');
    var sendBtn = document.getElementById('send-prompt-btn');

    // 如果已有对话，保存当前历史
    if (currentHistoryId && currentHistoryMessages.length > 0) {
        saveCurrentHistory();
    }

    // 重置为初始化前状态：显示模式选择和深度思考
    initCompleted = false;
    document.getElementById('pre-init-section').style.display = '';
    document.getElementById('post-init-section').style.display = 'none';
    // 同步预初始化模式选择器
    document.querySelectorAll('#pre-init-mode-selector .mode-btn').forEach(function(b) {
        b.classList.toggle('active', b.getAttribute('data-mode') === agentMode);
    });
    hideLoading();

    btn.disabled = true;
    initBtn.disabled = true;
    sendBtn.disabled = true;
    showStatus('正在创建新对话...');

    // Clear chat area
    var area = document.getElementById('chat-area');
    area.innerHTML = '';
    _pendingToolCards = [];
    workflowWrappers = [];
    var empty = document.createElement('div');
    empty.className = 'empty-msg';
    empty.textContent = '初始化中...';
    area.appendChild(empty);

    // 重置历史追踪
    currentHistoryId = Date.now().toString();
    currentHistoryMessages = [];
    currentSubSessions = [];
    currentHistoryExpired = false;
    currentHistoryDeepseekUrl = null;

    try {
        var initResult = await window.electronAPI.agentStartNewChat({
            mode: agentMode,
            deepthink: agentMode === 'image' ? false : agentDeepThink
        });

        // 保存 DeepSeek 会话 URL
        if (initResult && initResult.deepseekUrl) {
            currentHistoryDeepseekUrl = initResult.deepseekUrl;
            saveCurrentHistory();
        }

        // 通知主进程保存当前历史对话 ID
        window.electronAPI.setLastHistoryId(currentHistoryId);

        initCompleted = true;
        // 初始化成功：隐藏模式选择，显示输入框和模式标签
        document.getElementById('pre-init-section').style.display = 'none';
        document.getElementById('post-init-section').style.display = 'block';
        document.getElementById('mode-label').textContent = agentMode === 'expert' ? '专家模式' : (agentMode === 'image' ? '识图模式' : '快速模式');
        // 识图模式：隐藏深度思考开关
        var deepthinkRow = document.getElementById('deepthink-switch').parentElement;
        deepthinkRow.style.display = agentMode === 'image' ? 'none' : '';

        conversationId = Date.now();
        showStatus('初始化完成');
        document.querySelector('.empty-msg').textContent = '初始化已发送，等待响应...';
        sendBtn.disabled = false;
        document.getElementById('prompt-input').focus();
        showLoading();
        loadHistoryList();
    } catch (e) {
        showStatus('初始化失败: ' + e.message);
    }
    btn.disabled = false;
    initBtn.disabled = false;
}

// ==================== 新建对话弹窗 ====================
var newchatModalMode = 'expert';

// 预初始化模式选择（直接在界面上切换）
function selectPreInitMode(mode, btn) {
    agentMode = mode;
    document.querySelectorAll('#pre-init-mode-selector .mode-btn').forEach(function(b) {
        b.classList.remove('active');
    });
    btn.classList.add('active');
}

function showNewChatModal() {
    newchatModalMode = agentMode || 'expert';
    // 更新弹窗内按钮状态
    var btns = document.querySelectorAll('#newchat-modal-modes .ncm-mode');
    btns.forEach(function(b) {
        var mode = b.getAttribute('data-mode');
        if (mode === newchatModalMode) {
            b.classList.add('active');
            b.style.borderColor = '#0ea5e9';
            b.style.background = 'rgba(14,165,233,.1)';
            b.style.color = '#c0e0ff';
        } else {
            b.classList.remove('active');
            b.style.borderColor = '#3a3a6a';
            b.style.background = 'transparent';
            b.style.color = '#8a8aaa';
        }
    });
    // 弹窗主题由 CSS 变量自动处理，无需手动设置
    document.getElementById('newchat-modal').style.display = 'flex';
}

// 弹窗模式选择
document.getElementById('newchat-modal-modes').addEventListener('click', function(e) {
    var btn = e.target.closest('.ncm-mode');
    if (!btn) return;
    document.querySelectorAll('#newchat-modal-modes .ncm-mode').forEach(function(b) {
        b.classList.remove('active');
        b.style.borderColor = '#3a3a6a';
        b.style.background = 'transparent';
        b.style.color = '#8a8aaa';
    });
    btn.classList.add('active');
    btn.style.borderColor = '#0ea5e9';
    btn.style.background = 'rgba(14,165,233,.1)';
    btn.style.color = '#c0e0ff';
    newchatModalMode = btn.getAttribute('data-mode');
});

// 弹窗取消
document.getElementById('newchat-modal-cancel').onclick = function() {
    document.getElementById('newchat-modal').style.display = 'none';
};

// 弹窗确认 - 调用 startNewChat
document.getElementById('newchat-modal-confirm').onclick = function() {
    document.getElementById('newchat-modal').style.display = 'none';
    // 同步模式选择
    agentMode = newchatModalMode;
    document.querySelectorAll('.mode-btn').forEach(function(b) {
        b.classList.toggle('active', b.getAttribute('data-mode') === agentMode);
    });
    startNewChat();
};

async function sendPrompt() {
    var input = document.getElementById('prompt-input');
    var btn = document.getElementById('send-prompt-btn');

    // 如果正在生成或执行任务中 -> 点击停止（优先于空输入检查）
    if (isTaskChainActive) {
        btn.disabled = true;
        btn.textContent = '停止中...';
        try {
            await window.electronAPI.agentStop();
        } catch(e) {}
        // 等待 inject.js 确认停止完成（最多 2 秒），防止提前恢复按钮导致二次点击
        var stopTimedOut = false;
        try {
            await new Promise(function(resolve) {
                _stopWaitingResolve = resolve;
                // 2 秒超时兜底，防止 tasks-end 永远不来
                setTimeout(function() {
                    if (_stopWaitingResolve) { stopTimedOut = true; _stopWaitingResolve(); _stopWaitingResolve = null; }
                }, 2000);
            });
        } catch(e) {}
        // 如果超时或正常完成，强制重置状态
        if (stopTimedOut) {
            isGenerating = false;
            isExecutingTasks = false;
            isTaskChainActive = false;
            hideLoading();
        }
        _stopWaitingResolve = null;
        // 使用 updateSendBtn() 根据状态更新按钮，避免直接覆盖
        updateSendBtn();
        return;
    }

    var text = input.value.trim();

    // 允许纯附件发送（无文本但有文件时也能发）
    if (!text && attachedFiles.length === 0) return;

    // 检测文本中的 path="..." 模式，自动提取为文件附件，并解析相对路径
    var pathRegex = /path="([^"]+)"/g;
    var pathMatch;
    while ((pathMatch = pathRegex.exec(text)) !== null) {
        var p = pathMatch[1];
        if (p) {
            p = resolveRelativePathsInContent('path="' + p + '"').replace(/^path="|"$/g, '');
            addFileToPanel(p, getFileName(p), 'file');
        }
    }
    text = text.replace(/^path="[^"]*"\s*\n?/gm, '').trim();

    // 如果对话已失效，不允许发送
    if (currentHistoryExpired) {
        addAssistantError('此对话已失效，无法发送消息。请创建新对话。');
        return;
    }

    // 发送前确保 DeepSeek 处于正确的对话页面（如果 URL 不对会自动切回来）
    if (currentHistoryDeepseekUrl) {
        var navRes = await window.electronAPI.historyRestoreConversation(currentHistoryDeepseekUrl);
        if (!navRes || !navRes.valid) {
            // URL 无效，清除并尝试直接发送（新建对话时 URL 可能还没就绪）
            currentHistoryDeepseekUrl = null;
            if (!initCompleted) {
                currentHistoryExpired = true;
                addAssistantError('对话已过期，请创建新对话。');
                return;
            }
            // initCompleted = true 时可能是新建对话 URL 未就绪，不清除标记，尝试直接发送
        } else {
            // 导航后 inject.js 重建，readTools 被重置，立即从历史记录恢复
            if (currentHistoryId) {
                var histRes = await window.electronAPI.historyLoad(currentHistoryId);
                if (histRes.success && histRes.history && histRes.history.readTools) {
                    await window.electronAPI.setReadTools(histRes.history.readTools);
                }
            }
        }
    }

    input.value = '';

    // 新消息前关闭所有未闭合的工作流程展开栏
    workflowWrappers.forEach(function(w) {
        if (w.hasAttribute('open')) w.removeAttribute('open');
    });
    isInWorkflow = false;

    // 若有附件或技能，拼接到消息前面
    var skillPrefix = getSkillPrefix();
    var filePrefix = getFilePathsForSend();
    var fullText = skillPrefix + filePrefix + text;
    if (filePrefix || skillPrefix) clearFilePanel();

    btn.textContent = '发送';
    btn.disabled = true;

    // Add user message
    addMessage('user', fullText);

    // 记录到历史
    if (currentHistoryId) {
        currentHistoryMessages.push({ role: 'user', content: fullText, timestamp: new Date().toISOString() });
        saveCurrentHistory();
    }

    // Scroll to bottom
    scrollToBottom(true);

    // Send via IPC
    try {
        await window.electronAPI.agentSendMessage({
            text: fullText,
            mode: agentMode,
            deepthink: agentMode === 'image' ? false : agentDeepThink,
            conversationId: conversationId
        });
        showLoading();
    } catch (e) {
        addAssistantError('发送失败：' + e.message);
    }
    btn.disabled = false;
}

// Markdown 渲染函数
function escapeHtml(text) {
    var map = {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'};
    return text.replace(/[&<>"']/g, function(c) { return map[c]; });
}

function renderMarkdown(text) {
    // 本地图片 [image:相对路径] - 在 escapeHtml 之前处理
    var imgChips = [];
    text = text.replace(/\[image:\s*([^\]]+)\]/g, function(m, imgPath) {
        imgPath = imgPath.trim();
        // 如果路径不是绝对路径且不含 file://，在前面加上根目录
        var fullPath = imgPath;
        if (!fullPath.match(/^[a-zA-Z]:\\/) && !fullPath.match(/^file:\/\//) && currentRootDir) {
            fullPath = currentRootDir.replace(/\\/g, '/').replace(/\/$/, '') + '/' + fullPath.replace(/^\/+/, '');
        }
        var chipIdx = imgChips.length;
        imgChips.push('<img src="' + fullPath.replace(/"/g, '%22') + '" style="max-width:250px;max-height:250px;object-fit:contain;border-radius:8px;margin:8px 0;display:block;" onerror="this.style.display=\'none\';">');
        return '%%IMG_CHIP_' + chipIdx + '%%';
    });
    // 在 escapeHtml 之前处理 ```file 路径``` 代码块（避免引号被转义导致匹配失败）
    // 图片扩展名自动渲染为 <img>
    var IMG_EXTS = /\.(png|jpg|jpeg|gif|bmp|webp|svg)(\?.*)?$/i;
    var pathChips = [];
    function pushFileChip(filePath) {
        var name = filePath.replace(/\\/g, '/').split('/').pop() || filePath;
        // 判断是否为图片文件
        if (IMG_EXTS.test(name)) {
            // 渲染为图片
            var fullPath = filePath;
            if (!fullPath.match(/^[a-zA-Z]:\\/) && !fullPath.match(/^file:\/\//) && currentRootDir) {
                fullPath = currentRootDir.replace(/\\/g, '/').replace(/\/$/, '') + '/' + fullPath.replace(/^\/+/, '');
            }
            var chip = '<img src="' + fullPath.replace(/"/g, '%22') + '" style="max-width:250px;max-height:250px;object-fit:contain;border-radius:8px;margin:8px 0;display:block;" onerror="this.style.display=\'none\';" title="' + name.replace(/[&<>]/g, function(c) { return c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;'; }) + '">';
            pathChips.push(chip);
        } else {
            var chip = '<span class="path-chip" data-path="' + filePath.replace(/"/g, '&quot;').replace(/[&<>]/g, function(c) { return c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;'; }) + '" title="双击打开文件">?? ' + name.replace(/[&<>]/g, function(c) { return c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;'; }) + '</span>';
            pathChips.push(chip);
        }
        return '%%PATH_CHIP_' + (pathChips.length - 1) + '%%';
    }
    // 新格式：```file 路径```
    text = text.replace(/```\s*file\s+([^\n`]+?)\s*```/g, function(m, p) {
        return pushFileChip(p.trim());
    });
    // 兼容旧格式：path="..." 和 path='...'
    text = text.replace(/path\s*=\s*["']([^"']+)["']/g, function(m, p) {
        return pushFileChip(p);
    });
    var html = escapeHtml(text);
    // 恢复图片芯片（逃逸 escapeHtml 的破坏）
    for (var ici = 0; ici < imgChips.length; ici++) {
        html = html.replace('%%IMG_CHIP_' + ici + '%%', imgChips[ici]);
    }
    // 恢复 path 芯片（逃逸 escapeHtml 的破坏）
    for (var pci = 0; pci < pathChips.length; pci++) {
        html = html.replace('%%PATH_CHIP_' + pci + '%%', pathChips[pci]);
    }
    // 数学公式（必须在代码块之前处理，避免冲突）
    html = html.replace(/\$\$([\s\S]*?)\$\$/g, '<div class="math-block">$$$1$$</div>');
    html = html.replace(/\$([^\n$]*?)\$/g, '<span class="math-inline">$$$1$</span>');
    // 多行代码块：```lang\n...\n``` （支持开头/结尾可选空格和空行）
    html = html.replace(/```\w*\s*\n([\s\S]*?)\s*```/g, function(m, code) {
        return '<pre><code>' + code.replace(/\n$/, '') + '</code></pre>';
    });
    // 单行代码块：```content``` （整行被三个反引号包围，无换行）
    html = html.replace(/^```\s*(.+?)\s*```$/gm, '<pre><code>$1</code></pre>');
    // 行内代码：`content` （排除已处理的代码块残留反引号）
    html = html.replace(/`([^`\n]+)`/g, '<code>$1</code>');
    html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    html = html.replace(/\*([^*\n]+)\*/g, '<em>$1</em>');
    // 图片语法（![]()）必须在链接语法之前处理
    html = html.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img src="$2" alt="$1" style="max-width:250px;max-height:250px;object-fit:contain;border-radius:8px;margin:8px 0;" onerror="this.style.display=\'none\'">');
    html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank">$1</a>');
    html = html.replace(/^##### (.+)$/gm, '<h5>$1</h5>');
    html = html.replace(/^#### (.+)$/gm, '<h4>$1</h4>');
    html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
    html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
    html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');
    // 水平线: ---（兼容前导空格）
    html = html.replace(/^\s*---\s*$/gm, '<hr style="border:none;border-top:1px solid #ccc;margin:12px 0;">');
    html = html.replace(/^\s*- (.+)$/gm, '<li>$1</li>');
    html = html.replace(/(<li>[\s\S]*?<\/li>(?:\s*\n)*)+/g, function(m) { return '<ul>' + m.replace(/\n/g,'') + '</ul>'; });
    html = html.replace(/^\s*\d+\. (.+)$/gm, '<li>$1</li>');
    html = html.replace(/(?:^<li>[\s\S]*?<\/li>(?:\s*\n)*)+/gm, function(m) { return '<ol>' + m.replace(/\n/g,'') + '</ol>'; });
    // 表格: | col1 | col2 |\n| --- | --- |\n| v1 | v2 |（兼容前导空格和对齐标记 |:--:|）
    html = html.replace(/^\s*\|(.+)\|\s*\n\s*\|[-| :]+\|\s*\n((?:\s*\|.+\|\s*\n?)*)/gm, function(m, header, rows) {
        var hcells = header.split('|').map(function(c) { return '<th>' + c.trim() + '</th>'; }).filter(function(c) { return c !== '<th></th>'; });
        var body = '';
        rows.replace(/\s*\|(.+)\|\s*/g, function(m2, row) {
            var cells = row.split('|').map(function(c) { return '<td>' + c.trim() + '</td>'; }).filter(function(c) { return c !== '<td></td>'; });
            body += '<tr>' + cells.join('') + '</tr>';
        });
        return '<table style="border-collapse:collapse;margin:8px 0;width:100%;"><thead><tr style="background:#ddd;">' + hcells.join('') + '</tr></thead><tbody>' + body + '</tbody></table>';
    });
    var paragraphs = html.split(/\n\s*\n/);
    for (var i = 0; i < paragraphs.length; i++) {
        var p = paragraphs[i].trim();
        if (!p) continue;
        if (!/^<(h\d|ul|ol|pre|div|li|table)/.test(p)) {
            p = p.replace(/\n/g, '<br>');
            paragraphs[i] = '<p>' + p + '</p>';
        } else {
            paragraphs[i] = p;
        }
    }
    html = paragraphs.join('\n');
    return html;
}

function addMessage(role, content) {
    var area = document.getElementById('chat-area');
    var empty = area.querySelector('.empty-msg');
    if (empty) empty.remove();

    var group = document.createElement('div');
    group.className = 'msg-group';

    var label = document.createElement('div');
    label.className = 'msg-label';
    label.textContent = role === 'user' ? '你' : '助手';
    group.appendChild(label);

    var msg = document.createElement('div');
    msg.className = 'msg-' + role;
    if (role === 'assistant' || role === 'user') {
        msg.innerHTML = renderMarkdown(content);
    } else {
        msg.textContent = content;
    }
    group.appendChild(msg);
    area.appendChild(group);
    scrollToBottom();
}

// 将文本中的相对 path="..." 解析为绝对路径
function resolveRelativePathsInContent(content) {
    if (!content || !currentRootDir) return content;
    return content.replace(/path\s*=\s*["']([^"']+)["']/gi, function(m, p) {
        var trimmed = p.trim();
        if (!trimmed) return m;
        // 已是绝对路径或带协议，不处理
        if (/^[a-zA-Z]:\\/.test(trimmed) || /^file:\/\//.test(trimmed)) return m;
        var abs = currentRootDir.replace(/\\/g, '/').replace(/\/$/, '') + '/' + trimmed.replace(/^\/+/, '');
        return 'path="' + abs + '"';
    });
}

// 待填充结果的工具卡片队列（按创建顺序，保证 tool-result 可靠匹配）
var _pendingToolCards = [];

function addAssistantSegments(segments, skipSave) {
    var area = document.getElementById('chat-area');
    var empty = area.querySelector('.empty-msg');
    if (empty) empty.remove();

    // 统一解析文本中的相对路径
    segments = segments.map(function(seg) {
        if (seg && (seg.type === 'text' || seg.type === 'tool-result') && typeof seg.content === 'string') {
            return Object.assign({}, seg, { content: resolveRelativePathsInContent(seg.content) });
        }
        return seg;
    });

    // 记录到历史（仅非历史回放时保存，避免重复计入）
    if (currentHistoryId && !skipSave) {
        currentHistoryMessages.push({ segments: segments, timestamp: new Date().toISOString(), isWorkflow: isInWorkflow });
        saveCurrentHistory();
    }

    // 合并相邻的 text 段
    var merged = [];
    var textBuf = '';
    segments.forEach(function(seg) {
        if (seg.type === 'text') {
            if (seg.content.trim()) textBuf += (textBuf ? '\n\n' : '') + seg.content.trim();
        } else {
            if (textBuf) { merged.push({ type: 'text', content: textBuf }); textBuf = ''; }
            merged.push(seg);
        }
    });
    if (textBuf) merged.push({ type: 'text', content: textBuf });

    // 每段作为独立消息组显示
    merged.forEach(function(seg) {
        var group = document.createElement('div');
        group.className = 'msg-group';

        if (seg.type === 'text' && seg.content.trim()) {
            var label = document.createElement('div');
            label.className = 'msg-label';
            label.textContent = '助手';
            group.appendChild(label);
            var msg = document.createElement('div');
            msg.className = 'msg-assistant';
            msg.innerHTML = renderMarkdown(seg.content);
            group.appendChild(msg);
        } else if (seg.type === 'tool-call') {
            // 工具调用 + 结果合并为单一可展开卡片
            var toolCard = document.createElement('div');
            toolCard.className = 'tool-card';
            toolCard.style.marginLeft = '20px';
            var toolHeader = document.createElement('div');
            toolHeader.style.cssText = 'display:flex;align-items:center;gap:8px;padding:10px 14px;cursor:pointer;font-size:13px;user-select:none;transition:background .2s;';
            var toolName2 = (seg.lang || 'unknown').replace(/^local-/, '');
            var toolIcon2 = getToolIcon(seg.lang || '');
            toolHeader.innerHTML = '<span class="tool-arrow" style="transition:transform .25s;transform:rotate(-90deg);font-size:10px;">&#9660;</span><span style="font-size:14px;margin-right:6px;">' + toolIcon2 + '</span><span class="tool-name" style="font-weight:600;">' + escapeHtml(toolName2) + '</span><span class="tool-status" style="font-size:12px;margin-left:auto;display:flex;align-items:center;gap:4px;"><span class="tool-pulse" style="width:6px;height:6px;border-radius:50%;background:var(--warning);display:inline-block;"></span>执行中...</span>';
            var toolBody = document.createElement('div');
            toolBody.className = 'tool-card-body';
            toolBody.style.cssText = 'display:none;padding:0;border-top:1px solid var(--border-light);';
            // 调用内容区
            var callSection = document.createElement('div');
            callSection.style.cssText = 'padding:10px 14px;border-bottom:1px solid var(--border-light);';
            var callLabel = document.createElement('div');
            callLabel.style.cssText = 'font-size:11px;margin-bottom:4px;color:var(--text-muted);';
            callLabel.textContent = '调用参数';
            callSection.appendChild(callLabel);
            var callContent = document.createElement('pre');
            callContent.style.cssText = 'margin:0;font-family:monospace;font-size:13px;line-height:1.5;white-space:pre-wrap;word-wrap:break-word;';
            callContent.className = 'tool-call-content';
            callContent.textContent = seg.content;
            callSection.appendChild(callContent);
            // 结果区（预留，结果到达时填充）
            var resultSection = document.createElement('div');
            resultSection.className = 'tool-result-section';
            resultSection.style.cssText = 'display:none;padding:10px 14px;';
            toolBody.appendChild(callSection);
            toolBody.appendChild(resultSection);
            // 注册到待填充队列
            _pendingToolCards.push({ card: toolCard, resSec: resultSection });
            // 展开/折叠
            toolHeader.addEventListener('click', function() {
                var arrow = this.querySelector('.tool-arrow');
                if (toolBody.style.display === 'none') {
                    toolBody.style.display = '';
                    arrow.style.transform = 'rotate(0deg)';
                    this.style.background = 'var(--bg-hover)';
                } else {
                    toolBody.style.display = 'none';
                    arrow.style.transform = 'rotate(-90deg)';
                    this.style.background = '';
                }
            });
            toolCard.appendChild(toolHeader);
            toolCard.appendChild(toolBody);
            group.appendChild(toolCard);
        } else if (seg.type === 'tool-result') {
            // 从待填充队列中取出最早未填充的工具卡片
            var pending = _pendingToolCards.shift();
            if (pending) {
                var targetCard = pending.card;
                var resSec = pending.resSec;
                var statusEl = targetCard.querySelector('.tool-status');
                // 先更新状态（确保即使后续渲染失败，状态也已更新）
                if (statusEl) statusEl.innerHTML = '<span class="tool-status" style="font-size:12px;">● 已返回</span>';
                try {
                    resSec.style.display = '';
                    resSec.style.background = 'color-mix(in srgb, var(--success) 10%, transparent)';
                    var resLabel = document.createElement('div');
                    resLabel.style.cssText = 'font-size:11px;margin-bottom:4px;display:flex;align-items:center;gap:6px;';
                    resLabel.innerHTML = '<span>返回结果</span><span class="res-copy-btn" style="cursor:pointer;font-size:11px;padding:1px 6px;border:1px solid var(--border);border-radius:3px;user-select:none;" title="复制结果">复制</span>';
                    resSec.appendChild(resLabel);
                    var resContent = document.createElement('div');
                    resContent.className = 'result-content';
                    resContent.style.cssText = 'font-family:monospace;font-size:13px;line-height:1.5;word-wrap:break-word;';
                    resContent.innerHTML = renderMarkdown(seg.content);
                    resSec.appendChild(resContent);
                    // 复制按钮
                    resLabel.querySelector('.res-copy-btn').addEventListener('click', function(e) {
                        e.stopPropagation();
                        var cbtn = this;
                        var rtext = seg.content || '';
                        window.electronAPI.clipboardSave().then(function(saved) {
                            window.electronAPI.clipboardWriteText(rtext).then(function() {
                                cbtn.textContent = '? 已复制';
                                setTimeout(function() {
                                    cbtn.textContent = '复制';
                                    if (saved && saved.text !== undefined) { window.electronAPI.clipboardRestore(saved.text); }
                                }, 2000);
                            }).catch(function() {
                                cbtn.textContent = '? 复制失败';
                            });
                        });
                    });
                } catch (e) {
                    console.warn('tool-result render error:', e);
                    resSec.innerHTML = '<div style="color:var(--danger);padding:10px;">渲染结果时出错: ' + escapeHtml(e.message) + '</div>';
                }
                scrollToBottom();
                return;  // 不创建空 group
            } else {
                // 队列为空 → 在 DOM 中查找最后一张"执行中"卡片来更新
                var allCards = document.querySelectorAll('.tool-card');
                var lastExecuting = null;
                for (var ci = allCards.length - 1; ci >= 0; ci--) {
                    var st = allCards[ci].querySelector('.tool-status');
                    if (st && st.textContent.indexOf('执行中') !== -1) {
                        lastExecuting = allCards[ci];
                        break;
                    }
                }
                if (lastExecuting) {
                    // 找到匹配的卡片，更新它
                    var targetCard2 = lastExecuting;
                    var statusEl2 = targetCard2.querySelector('.tool-status');
                    // 先更新状态（确保即使后续渲染失败，状态也已更新）
                    if (statusEl2) statusEl2.innerHTML = '<span class="tool-status" style="font-size:12px;">● 已返回</span>';
                    var toolBody2 = targetCard2.querySelector('.tool-card-body');
                    if (!toolBody2) {
                        toolBody2 = document.createElement('div');
                        toolBody2.className = 'tool-card-body';
                        toolBody2.style.cssText = 'display:none;padding:0;border-top:1px solid var(--border-light);';
                        targetCard2.appendChild(toolBody2);
                    }
                    try {
                        var resSec2 = document.createElement('div');
                        resSec2.className = 'tool-result-section';
                        resSec2.style.cssText = 'display:block;padding:10px 14px;background:color-mix(in srgb, var(--success) 10%, transparent);';
                        var resLabel2 = document.createElement('div');
                        resLabel2.style.cssText = 'font-size:11px;margin-bottom:4px;display:flex;align-items:center;gap:6px;';
                        resLabel2.innerHTML = '<span>返回结果</span><span class="res-copy-btn" style="cursor:pointer;font-size:11px;padding:1px 6px;border:1px solid var(--border);border-radius:3px;user-select:none;" title="复制结果">复制</span>';
                        resSec2.appendChild(resLabel2);
                        var resContent2 = document.createElement('div');
                        resContent2.className = 'result-content';
                        resContent2.style.cssText = 'font-family:monospace;font-size:13px;line-height:1.5;word-wrap:break-word;';
                        resContent2.innerHTML = renderMarkdown(seg.content);
                        resSec2.appendChild(resContent2);
                        resLabel2.querySelector('.res-copy-btn').addEventListener('click', function(e) {
                            e.stopPropagation();
                            var cbtn = this;
                            var rtext = seg.content || '';
                            window.electronAPI.clipboardSave().then(function(saved) {
                                window.electronAPI.clipboardWriteText(rtext).then(function() {
                                    cbtn.textContent = '? 已复制';
                                    setTimeout(function() {
                                        cbtn.textContent = '复制';
                                        if (saved && saved.text !== undefined) { window.electronAPI.clipboardRestore(saved.text); }
                                    }, 2000);
                                }).catch(function() { cbtn.textContent = '? 复制失败'; });
                            });
                        });
                        toolBody2.appendChild(resSec2);
                    } catch (e) {
                        console.warn('tool-result DOM fallback render error:', e);
                        toolBody2.innerHTML = '<div style="color:var(--danger);padding:10px;">渲染结果时出错: ' + escapeHtml(e.message) + '</div>';
                    }
                    scrollToBottom();
                    return;
                }
                // 实在找不到 → 创建新卡片兜底
                var resultArea = area;
                if (isInWorkflow) {
                    var wfW = getCurrentWorkflowWrapper();
                    if (wfW) resultArea = wfW.querySelector('.wf-body') || area;
                }
                var autoCard = document.createElement('div');
                autoCard.className = 'tool-card';
                autoCard.style.marginLeft = '20px';
                var autoHeader = document.createElement('div');
                autoHeader.className = 'tool-header';
                autoHeader.style.cssText = 'display:flex;align-items:center;gap:8px;padding:10px 14px;font-size:13px;user-select:none;';
                var toolName3 = (seg.lang || 'tool').replace(/^local-/, '');
                autoHeader.innerHTML = '<span class="tool-name" style="font-weight:600;">' + escapeHtml(toolName3) + '</span><span class="tool-status" style="font-size:12px;margin-left:auto;">● 已返回</span>';
                autoCard.appendChild(autoHeader);
                var autoResult = document.createElement('div');
                autoResult.className = 'tool-result-section';
                autoResult.style.cssText = 'padding:10px 14px;font-family:monospace;font-size:13px;line-height:1.5;word-wrap:break-word;';
                autoResult.innerHTML = renderMarkdown(seg.content);
                autoCard.appendChild(autoResult);
                group.classList.remove('msg-group');
                group.style.cssText = 'margin:0;padding:0;border:none;background:transparent;';
                group.appendChild(autoCard);
                resultArea.appendChild(group);
                scrollToBottom();
                return;
            }
        }

        // 如果处于工作流程模式，将内容追加到 workflow body 而非 chat-area
        var targetArea3 = area;
        if (isInWorkflow) {
            var wfW3 = getCurrentWorkflowWrapper();
            if (wfW3 && (seg.type === 'text' || seg.type === 'tool-call')) targetArea3 = wfW3.querySelector('.wf-body') || area;
        }
        targetArea3.appendChild(group);
    });

    scrollToBottom();
}

function addAssistantError(msg) {
    addMessage('assistant', '[错误] ' + msg);
    if (currentHistoryId) {
        currentHistoryMessages.push({ role: 'assistant', content: '[错误] ' + msg, timestamp: new Date().toISOString() });
        saveCurrentHistory();
    }
}

function showLoading() {
    var area = document.getElementById('chat-area');
    if (!area) return;
    // 移除已有的
    var existing = document.getElementById('loading-indicator');
    if (existing) existing.remove();
    // 创建新的输出中气泡（动态动画效果）
    var el = document.createElement('div');
    el.id = 'loading-indicator';
    el.style.cssText = 'flex-shrink:0;';
    el.innerHTML = '<div class="msg-group">'
        + '<div class="msg-label">助手</div>'
        + '<div class="msg-assistant" style="display:flex;align-items:center;gap:12px;padding:14px 18px;">'
        + '<div style="position:relative;width:18px;height:18px;">'
        + '<div class="spinner" style="margin:0;"></div>'
        + '</div>'
        + '<span id="loading-text" style="color:#aaa;letter-spacing:1px;">输出中</span>'
        + '<span id="loading-dots" style="color:#8888cc;font-weight:bold;min-width:20px;">...</span>'
        + '</div>'
        + '</div>';
    area.appendChild(el);
    // 先标记生成状态，再滚动，避免 scrollToBottom 误判为未读新消息从而弹出箭头
    isTaskChainActive = true;
    var btn = document.getElementById('send-prompt-btn');
    if (btn) { isGenerating = true; updateSendBtn(); }
    scrollToBottom();
    showStatus('正在处理...');
    // 动态省略号动画
    var dotEl = document.getElementById('loading-dots');
    var dotIdx = 0;
    var dotInterval = setInterval(function() {
        dotIdx = (dotIdx + 1) % 4;
        dotEl.textContent = '.'.repeat(dotIdx);
    }, 400);
    el.dataset.dotInterval = dotInterval;
}

function hideLoading() {
    var el = document.getElementById('loading-indicator');
    if (el) {
        if (el.dataset.dotInterval) clearInterval(parseInt(el.dataset.dotInterval));
        el.remove();
    }
    // 不在此重置 isGenerating，由 onAgentMessage 按需管理
    // 确保在内容到达 → addAssistantSegments → scrollToBottom 时仍能自动滚动
    updateSendBtn();
}

var SCROLL_BOTTOM_THRESHOLD = 60; // 距离底部多少像素内视为“在底部”
var hasUnreadBelow = false;
var userScrolledAway = false; // 用户是否主动翻离底部

function isChatScrolledToBottom() {
    var area = document.getElementById('chat-area');
    if (!area) return true;
    return area.scrollHeight - area.scrollTop - area.clientHeight < SCROLL_BOTTOM_THRESHOLD;
}

function updateScrollToBottomBtn() {
    var btn = document.getElementById('scroll-to-bottom-btn');
    if (!btn) return;
    var atBottom = isChatScrolledToBottom();
    if (atBottom) {
        btn.style.display = 'none';
        btn.classList.remove('flash');
        hasUnreadBelow = false;
    } else {
        btn.style.display = 'flex';
        if (hasUnreadBelow) {
            btn.classList.add('flash');
        } else {
            btn.classList.remove('flash');
        }
    }
}

function markUnreadBelow() {
    hasUnreadBelow = true;
    var btn = document.getElementById('scroll-to-bottom-btn');
    if (btn && btn.style.display !== 'none') {
        btn.classList.add('flash');
    }
}

function scrollToBottom(force) {
    var area = document.getElementById('chat-area');
    if (!area) return;
    // 条件：force（发消息/点箭头）|| 在底部 || 生成中且用户未主动翻离底部
    if (force || isChatScrolledToBottom() || (isGenerating && !userScrolledAway)) {
        scrollToBottomRAF(area, 0);
    } else {
        // 用户在翻看上方内容，不自动滚动，仅标记未读并闪烁提示按钮
        markUnreadBelow();
        updateScrollToBottomBtn();
    }
}

// 递归 requestAnimationFrame 滚动，最多 3 帧确保布局稳定
function scrollToBottomRAF(area, attempts) {
    if (attempts > 3) return;
    requestAnimationFrame(function() {
        area.scrollTop = area.scrollHeight;
        updateScrollToBottomBtn();
        scrollToBottomRAF(area, attempts + 1);
    });
}

// ==================== 底部面板折叠 ====================
var bottomExtrasCollapsed = false;
var MODAL_IDS = ['qqbot-edit-modal', 'mcp-edit-modal', 'form-modal'];

function toggleBottomExtras(forceCollapse) {
    var extras = document.getElementById('bottom-extras');
    var btn = document.getElementById('bottom-collapse-btn');
    if (!extras || !btn) return;
    if (typeof forceCollapse === 'boolean') {
        bottomExtrasCollapsed = forceCollapse;
    } else {
        bottomExtrasCollapsed = !bottomExtrasCollapsed;
    }
    // 只折叠非弹窗子元素，避免弹窗被一起隐藏；展开时恢复原来的 display
    Array.from(extras.children).forEach(function(child) {
        if (MODAL_IDS.indexOf(child.id) >= 0 || child.getAttribute('data-keep-visible') === 'true') return;
        if (bottomExtrasCollapsed) {
            if (!child.dataset.origDisplay) child.dataset.origDisplay = child.style.display;
            child.style.display = 'none';
        } else {
            child.style.display = child.dataset.origDisplay || '';
        }
    });
    btn.textContent = bottomExtrasCollapsed ? '?' : '▼';
    btn.title = bottomExtrasCollapsed ? '展开下方面板' : '折叠下方面板';
    try { localStorage.setItem('dsa_bottom_extras_collapsed', bottomExtrasCollapsed ? '1' : '0'); } catch (e) {}
}

function initBottomExtrasCollapse() {
    try {
        bottomExtrasCollapsed = localStorage.getItem('dsa_bottom_extras_collapsed') === '1';
    } catch (e) {}
    if (bottomExtrasCollapsed) {
        var extras = document.getElementById('bottom-extras');
        var btn = document.getElementById('bottom-collapse-btn');
        if (extras) {
            Array.from(extras.children).forEach(function(child) {
                if (MODAL_IDS.indexOf(child.id) >= 0 || child.getAttribute('data-keep-visible') === 'true') return;
                if (!child.dataset.origDisplay) child.dataset.origDisplay = child.style.display;
                child.style.display = 'none';
            });
        }
        if (btn) { btn.textContent = '?'; btn.title = '展开下方面板'; }
    }
}

// Listen for agent messages from main process
window.electronAPI.onAgentMessage(function(data) {
    if (data.type === 'tasks-start') {
        showStatus('工具执行中...');
        // 检查上一个 wrapper 是否已折叠（自动折叠 = 任务已结束）
        var prevWf = getCurrentWorkflowWrapper();
        var prevCollapsed = prevWf && !prevWf.hasAttribute('open');

        if (prevWf && !prevCollapsed) {
            // 同一个任务还在进行中，复用现有 wrapper，不创建新的
            isInWorkflow = true;
        } else {
            // 上一个任务已结束，创建新的 wrapper
            isInWorkflow = true;
            var area = document.getElementById('chat-area');
            var details = document.createElement('details');
            details.className = 'workflow-wrap' + (currentTheme === 'light' ? ' light' : '');
            details.setAttribute('open', '');
            var summary = document.createElement('summary');
            summary.innerHTML = '<span>工作流程</span><span class="badge">展开</span>';
            var body = document.createElement('div');
            body.className = 'wf-body';
            details.appendChild(summary);
            details.appendChild(body);
            area.appendChild(details);
            workflowWrappers.push(details);
        }
        isExecutingTasks = true;
        // isGenerating 保持 true（由 showLoading 设置），确保后续内容到达时自动滚动
        hideLoading();
        scrollToBottom();
        updateSendBtn();
        return;
    }
    if (data.type === 'tasks-end') {
        // 当前命令执行完毕，但任务链未结束（结果还要反馈给 DeepSeek，DeepSeek 可能继续生成）
        // 只有用户主动停止时才结束任务链
        isExecutingTasks = false;
        if (data.stopped) {
            // 用户停止：任务链彻底结束
            isTaskChainActive = false;
            isGenerating = false;
        }
        // 未停止时 isTaskChainActive 保持 true，等待最终响应或新一轮 tasks-start
        // 兜底：将所有仍处于"执行中"的卡片更新为"已完成"
        var allCards = document.querySelectorAll('.tool-card');
        for (var ci = 0; ci < allCards.length; ci++) {
            var st = allCards[ci].querySelector('.tool-status');
            if (st && st.textContent.indexOf('执行中') !== -1) {
                st.innerHTML = '<span class="tool-status" style="font-size:12px;">● 已完成</span>';
            }
        }
        hideLoading();
        updateSendBtn();
        // 如果在等待停止确认，清除等待
        if (_stopWaitingResolve) { _stopWaitingResolve(); _stopWaitingResolve = null; }
        return;
    }
    hideLoading();
    if (data.type === 'response') {
        var hasCommands = data.segments && data.segments.some(function(s) { return s.type === 'tool-call'; });
        if (!hasCommands && isInWorkflow) {
            // 任务结束：自动折叠
            isInWorkflow = false;
            var cur = getCurrentWorkflowWrapper();
            if (cur) {
                cur.removeAttribute('open');
                var badge = cur.querySelector('summary .badge');
                if (badge) badge.textContent = '折叠';
            }
        }
        addAssistantSegments(data.segments);
        isExecutingTasks = hasCommands;
        // isTaskChainActive 保持 true，直到 tasks-end 或无命令的最终响应
        if (!hasCommands) {
            isGenerating = false;
            isTaskChainActive = false;  // 无命令的最终响应，任务链结束
            showStatus('任务完成');
        }
        updateSendBtn();
    } else if (data.type === 'tool-results') {
        addAssistantSegments(data.segments);
    } else if (data.type === 'tool-result') {
        addAssistantSegments([{ type: 'tool-result', content: data.result }]);
    }
});

// Qwen 绘图进度 → 改为在状态栏显示
window.electronAPI.onQwenProgress(function(msg) {
    addStatus('qwen', msg, 'qwen');
});

// 状态栏管理：支持多条状态，自动过期 → 同时发送到 controlbar 统一任务栏
var statusMap = {};
function addStatus(id, text, type) {
    var bar = document.getElementById('status-bar');
    if (bar) {
        var el = statusMap[id];
        if (!el) {
            el = document.createElement('span');
            el.style.cssText = 'padding:0 6px;border-radius:4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:200px;transition:opacity .5s;';
            bar.appendChild(el);
            statusMap[id] = el;
        }
        var colors = { qwen: '#6a8acc', tool: '#8a8a6a', confirm: '#cc8a6a', success: '#5a9a5a', error: '#cc5a5a' };
        el.style.color = colors[type] || '#6a6a8a';
        el.style.background = (colors[type] || '#6a6a8a') + '18';
        el.textContent = text;
        // 清空过期状态
        var expires = Date.now() + 15000;
        el._expires = expires;
        setTimeout(function() {
            if (el._expires <= Date.now()) {
                el.style.opacity = '0';
                setTimeout(function() { if (el._expires <= Date.now()) { el.remove(); delete statusMap[id]; } }, 500);
            }
        }, 15000);
    }
    // 同步发送到 controlbar 统一任务栏
    if (window.electronAPI && window.electronAPI.agentStatusToControlbar) {
        window.electronAPI.agentStatusToControlbar(text, type || '');
    }
}

// 临时状态消息（发送到 controlbar）
function showStatus(msg) {
    addStatus('status_' + Date.now(), msg, '');
}

// 初始化：加载历史列表
loadHistoryList();

// ==================== readTools 调试面板 ====================
function refreshReadToolsDisplay() {
    window.electronAPI.getReadTools().then(function(tools) {
        var list = document.getElementById('readtools-list');
        var count = document.getElementById('readtools-count');
        if (!list || !count) return;
        var arr = tools || [];
        count.textContent = arr.length;
        if (arr.length === 0) {
            list.innerHTML = '<span style="color:#666;">暂无已读文档</span>';
            return;
        }
        list.innerHTML = arr.sort().map(function(t) {
            return '<span style="color:#8cc;">' + escapeHtml(t) + '</span>';
        }).join('<br>');
    });
}
function toggleReadToolsPopup() {
    var popup = document.getElementById('readtools-popup');
    if (!popup) return;
    var visible = popup.style.display !== 'none';
    popup.style.display = visible ? 'none' : '';
    if (!visible) refreshReadToolsDisplay();
}
function syncReadTools() {
    // 从当前历史记录的 readTools 恢复
    if (currentHistoryId) {
        window.electronAPI.historyLoad(currentHistoryId).then(function(res) {
            if (res.success && res.history && res.history.readTools) {
                window.electronAPI.setReadTools(res.history.readTools).then(function() {
                    refreshReadToolsDisplay();
                    var list = document.getElementById('readtools-list');
                    if (list) list.innerHTML = '<span style="color:#5a9a5a;">? 已从历史记录同步 ' + res.history.readTools.length + ' 个工具</span>';
                });
            } else {
                var list = document.getElementById('readtools-list');
                if (list) list.innerHTML = '<span style="color:#e88;">?? 当前历史记录无 readTools 数据</span>';
            }
        });
    }
}
// 定期自动刷新 readTools 显示
setInterval(refreshReadToolsDisplay, 5000);
// 页面加载后也尝试刷新
setTimeout(refreshReadToolsDisplay, 3000);
// 用户发送消息时也刷新
var origSend = sendPrompt;
sendPrompt = function() {
    setTimeout(refreshReadToolsDisplay, 1000);
    return origSend.apply(this, arguments);
};

// ==================== QQ Bot 托管 ====================
var qqBotEnabled = false;

function toggleQQBot() {
    qqBotEnabled = !qqBotEnabled;
    var arrowEl = document.getElementById('qqbot-arrow');
    if (arrowEl) {
        arrowEl.textContent = qqBotEnabled ? '▼' : '?';
    }
    document.getElementById('qqbot-panel').style.display = qqBotEnabled ? '' : 'none';
    if (qqBotEnabled) {
        loadQQBotList();
        loadQQBotNetMode();
    }
}

// 外网模式（localtunnel 穿透）
var qqBotNetMode = 'lan';
async function loadQQBotNetMode() {
    try {
        var res = await window.electronAPI.qqbotGetNetMode();
        qqBotNetMode = res.mode || 'lan';
        updateQQBotNetModeUI();
    } catch(e) {}
}
function updateQQBotNetModeUI() {
    var sw = document.getElementById('qqbot-netmode-switch');
    var desc = document.getElementById('qqbot-netmode-desc');
    if (sw) sw.classList.toggle('on', qqBotNetMode === 'wan');
    if (desc) {
        desc.textContent = qqBotNetMode === 'wan'
            ? 'localtunnel 穿透，外网可访问'
            : '自动替换为局域网 IP';
    }
}
async function toggleQQBotNetMode() {
    qqBotNetMode = qqBotNetMode === 'wan' ? 'lan' : 'wan';
    updateQQBotNetModeUI();
    try {
        await window.electronAPI.qqbotSetNetMode(qqBotNetMode);
    } catch(e) {}
}

// 加载已保存的机器人列表
var qqBotSelectedId = '';
var qqBotRobotsList = [];
function loadQQBotList() {
    window.electronAPI.qqbotListRobots().then(function(robots) {
        qqBotRobotsList = robots || [];
        var dd = document.getElementById('qqbot-robot-dropdown');
        if (!dd) return;
        dd.innerHTML = '';
        // 空白项
        var emptyItem = document.createElement('div');
        emptyItem.textContent = '-- 选择已保存的 Bot --';
        emptyItem.style.cssText = 'padding:6px 10px;cursor:pointer;color:#666;font-size:12px;';
        emptyItem.onclick = function() { selectQQBot(''); };
        dd.appendChild(emptyItem);
        (robots || []).forEach(function(r) {
            var item = document.createElement('div');
            item.textContent = (r.name || r.id) + ' (' + (r.appId || '').substring(0, 6) + '...)';
            item.style.cssText = 'padding:6px 10px;cursor:pointer;color:#ccc;font-size:12px;border-top:1px solid #2a2a4e;';
            item.onmouseover = function() { this.style.background = '#2a2a4e'; };
            item.onmouseout = function() { this.style.background = ''; };
            (function(rid) { item.onclick = function() { selectQQBot(rid); }; })(r.id);
            dd.appendChild(item);
        });
        // 恢复选中
        if (qqBotSelectedId) {
            var text = document.getElementById('qqbot-robot-text');
            if (text) text.textContent = (robots || []).filter(function(r) { return r.id === qqBotSelectedId; }).map(function(r) { return r.name; })[0] || '-- 选择已保存的 Bot --';
        }
        onQQBotSelectChange();
    });
}

function selectQQBot(id) {
    qqBotSelectedId = id;
    document.getElementById('qqbot-robot-dropdown').style.display = 'none';
    var text = document.getElementById('qqbot-robot-text');
    if (id) {
        window.electronAPI.qqbotListRobots().then(function(robots) {
            var found = (robots || []).filter(function(r) { return r.id === id; });
            text.textContent = found.length > 0 ? found[0].name : '-- 选择已保存的 Bot --';
            onQQBotSelectChange();
        });
    } else {
        text.textContent = '-- 选择已保存的 Bot --';
        text.style.color = '#666';
        onQQBotSelectChange();
    }
}

function toggleQQBotDropdown() {
    var dd = document.getElementById('qqbot-robot-dropdown');
    if (!dd) return;
    dd.style.display = dd.style.display === 'none' ? '' : 'none';
}
// 点击外部关闭 dropdown
document.addEventListener('click', function(e) {
    var dd = document.getElementById('qqbot-robot-dropdown');
    var display = document.getElementById('qqbot-robot-display');
    if (dd && display && !display.contains(e.target) && !dd.contains(e.target)) {
        dd.style.display = 'none';
    }
});

function getSelectedQQBotId() { return qqBotSelectedId; }
function getSelectedQQBot() {
    if (!qqBotSelectedId) return null;
    for (var gi = 0; gi < qqBotRobotsList.length; gi++) {
        if (qqBotRobotsList[gi].id === qqBotSelectedId) return qqBotRobotsList[gi];
    }
    return { id: qqBotSelectedId };
}

function onQQBotSelectChange() {
    var hasSelection = !!qqBotSelectedId;
    document.getElementById('qqbot-edit-btn').style.display = hasSelection ? '' : 'none';
    document.getElementById('qqbot-del-btn').style.display = hasSelection ? '' : 'none';
}

function showQQBotEditModal(robot) {
    var modal = document.getElementById('qqbot-edit-modal');
    document.getElementById('qqbot-edit-title').textContent = robot ? '编辑 Bot' : '新建 Bot';
    document.getElementById('qqbot-edit-name').value = robot ? (robot.name || '') : '';
    document.getElementById('qqbot-edit-appid').value = robot ? (robot.appId || '') : '';
    document.getElementById('qqbot-edit-secret').value = '';
    modal._editId = robot ? robot.id : null;
    modal.style.display = 'flex';
}

function doSaveQQBot() {
    var modal = document.getElementById('qqbot-edit-modal');
    var name = document.getElementById('qqbot-edit-name').value.trim();
    var appId = document.getElementById('qqbot-edit-appid').value.trim();
    var secret = document.getElementById('qqbot-edit-secret').value.trim();
    var isEdit = !!modal._editId;
    if (!name || !appId) { showQQBotAlert('请填写完整信息'); return; }
    if (!isEdit && !secret) { showQQBotAlert('请填写 Secret'); return; }

    var robot = {
        id: modal._editId || 'robot_' + Date.now(),
        name: name,
        appId: appId,
    };
    if (secret) {
        robot.clientSecret = secret;
    } else if (isEdit) {
        // 编辑时 secret 留空则保留原值，由 main.js 处理
        robot.clientSecret = '';
        robot._keepSecret = true;
    } else {
        robot.clientSecret = secret;
    }
    window.electronAPI.qqbotSaveRobot(robot).then(function(res) {
        if (res.success) {
            modal.style.display = 'none';
            loadQQBotList();
            // 自动选中新保存的
            var sel = document.getElementById('qqbot-robot-select');
            for (var oi = 0; oi < sel.options.length; oi++) {
                if (sel.options[oi].value === robot.id) { sel.value = robot.id; break; }
            }
            onQQBotSelectChange();
        }
    });
}

function doDeleteQQBot() {
    if (!qqBotSelectedId) return;
    showQQBotConfirm('确定删除此机器人配置？', function() {
        window.electronAPI.qqbotDeleteRobot(qqBotSelectedId).then(function() {
            selectQQBot('');
            loadQQBotList();
        });
    });
}

function doStartQQBot() {
    if (!qqBotSelectedId) { showQQBotAlert('请先选择或创建一个 Bot'); return; }

    window.electronAPI.qqbotListRobots().then(function(robots) {
        var robot = null;
        for (var ri = 0; ri < robots.length; ri++) {
            if (robots[ri].id === qqBotSelectedId) { robot = robots[ri]; break; }
        }
        if (!robot) { showQQBotAlert('找不到该 Bot 配置'); return; }

        document.getElementById('qqbot-start-btn').disabled = true;
        document.getElementById('qqbot-start-btn').textContent = '启动中...';

        window.electronAPI.qqbotStart({
            appId: robot.appId,
            clientSecret: robot.clientSecret
        }).then(function(res) {
            document.getElementById('qqbot-start-btn').disabled = false;
            document.getElementById('qqbot-start-btn').textContent = '启动';
            if (res.success) {
                document.getElementById('qqbot-status-text').textContent = '运行中';
                document.getElementById('qqbot-start-btn').style.display = 'none';
                document.getElementById('qqbot-stop-btn').style.display = '';
                if (res.verifyCode) {
                    document.getElementById('qqbot-verify-section').style.display = '';
                    document.getElementById('qqbot-verify-code').textContent = res.verifyCode;
                } else {
                    document.getElementById('qqbot-verify-section').style.display = 'none';
                }
            } else {
                showQQBotAlert('启动失败: ' + (res.error || '未知错误'));
            }
        });
    });
}

// DOM 弹窗替代 alert
function showQQBotAlert(msg) {
    var modal = document.getElementById('confirm-modal');
    document.getElementById('confirm-modal-text').textContent = msg;
    var okBtn = document.getElementById('confirm-modal-ok');
    document.getElementById('confirm-modal-cancel').style.display = 'none';
    okBtn.textContent = '确定';
    okBtn.onclick = function() { modal.style.display = 'none'; okBtn.textContent = '确定'; okBtn.onclick = null; };
    modal.style.display = 'flex';
}
function showQQBotConfirm(msg, onOk) {
    var modal = document.getElementById('confirm-modal');
    document.getElementById('confirm-modal-text').textContent = msg;
    var okBtn = document.getElementById('confirm-modal-ok');
    var cancelBtn = document.getElementById('confirm-modal-cancel');
    cancelBtn.style.display = '';
    okBtn.textContent = '确定';
    okBtn.onclick = function() { modal.style.display = 'none'; cancelBtn.style.display = 'none'; okBtn.textContent = '确定'; if (onOk) onOk(); };
    cancelBtn.onclick = function() { modal.style.display = 'none'; okBtn.textContent = '确定'; };
    modal.style.display = 'flex';
}

// 继续生成确认（由 main.js 触发）
window.electronAPI.onContinueConfirm(function(data) {
    var modal = document.getElementById('confirm-modal');
    document.getElementById('confirm-modal-text').textContent = 'DeepSeek 输出似乎被截断了，是否继续生成以获取剩余内容？';
    var okBtn = document.getElementById('confirm-modal-ok');
    var cancelBtn = document.getElementById('confirm-modal-cancel');
    cancelBtn.style.display = '';
    okBtn.textContent = '继续生成';
    okBtn.onclick = function() {
        modal.style.display = 'none';
        cancelBtn.style.display = 'none';
        okBtn.textContent = '确定';  // 重置按钮文字
        window.electronAPI.agentContinueResponse({ id: data.id, confirmed: true });
    };
    cancelBtn.onclick = function() {
        modal.style.display = 'none';
        okBtn.textContent = '确定';  // 重置按钮文字
        window.electronAPI.agentContinueResponse({ id: data.id, confirmed: false });
    };
    modal.style.display = 'flex';
});

function doStopQQBot() {
    window.electronAPI.qqbotStop().then(function() {
        document.getElementById('qqbot-status-text').textContent = '未启动';
        document.getElementById('qqbot-start-btn').style.display = '';
        document.getElementById('qqbot-stop-btn').style.display = 'none';
        document.getElementById('qqbot-verify-section').style.display = 'none';
        document.getElementById('qqbot-authorized-section').style.display = 'none';
        document.getElementById('qqbot-queue-info').style.display = 'none';
    });
}

// 接收 QQ 消息
window.electronAPI.onQQBotMessage(function(msg) {
    var text = msg.content || '';
    var files = msg.savedFiles || [];

    // 直接填输入框 + 发送（sendPrompt 内部会渲染用户消息，无需手动渲染避免重复）
    var input = document.getElementById('prompt-input');
    if (!input) return;

    // 有附件时，以 path="完整路径" 告知 AI（AI 需要完整路径访问文件）
    var filePrefix = '';
    if (files.length > 0) {
        filePrefix = files.map(function(fp) {
            return 'path="' + fp + '"';
        }).join('\n') + '\n';
    }
    input.value = filePrefix + text;
    sendPrompt();
});

// 接收授权成功通知
window.electronAPI.onQQBotAuthorized(function(data) {
    document.getElementById('qqbot-verify-section').style.display = 'none';
    document.getElementById('qqbot-authorized-section').style.display = '';
    document.getElementById('qqbot-authorized-openid').textContent = data.openid;
});

// 接收 QQ Bot 指令同步（来自手机远程控制）
window.electronAPI.onQQBotCommand(function(data) {
    switch (data.action) {
        case 'toggleDeepThink':
            var sw = document.getElementById('deepthink-switch');
            if (data.value) { sw.classList.add('on'); agentDeepThink = true; }
            else { sw.classList.remove('on'); agentDeepThink = false; }
            window.electronAPI.agentToggleDeepThink(data.value);
            break;
        case 'setConfirmMode':
            // Agent 视图本身不显示审核模式按钮，仅转发同步给主进程以便状态一致
            if (window.electronAPI && window.electronAPI.agentConfigLoad) {
                window.electronAPI.agentConfigLoad().then(function(res) {
                    if (res.success) {
                        var cfg = res.config || {};
                        cfg.confirmMode = data.value;
                        window.electronAPI.agentConfigSave(cfg).catch(function() {});
                    }
                }).catch(function() {});
            }
            break;
        case 'changeDir':
            window.electronAPI.setLastHistoryId(null);
            closeCurrentConversation();
            break;
        case 'newChat':
            // main.js 已调用 __dsagent_newChatAndSendInit 创建新对话
            // agentview 仅重置自身状态并开始轮询获取 URL
            closeCurrentConversation();
            document.getElementById('pre-init-section').style.display = 'none';
            document.getElementById('post-init-section').style.display = 'block';
            initCompleted = true;
            // 同步 mode / deepthink（由 IPC 传入）
            if (data.mode) {
                agentMode = data.mode;
                document.getElementById('mode-label').textContent = agentMode === 'expert' ? '专家模式' : (agentMode === 'image' ? '识图模式' : '快速模式');
                var deepthinkRow = document.getElementById('deepthink-switch').parentElement;
                deepthinkRow.style.display = agentMode === 'image' ? 'none' : '';
            }
            if (typeof data.deepthink === 'boolean') {
                agentDeepThink = data.deepthink;
                document.getElementById('deepthink-switch').classList.toggle('on', agentDeepThink);
            }
            // 创建新历史记录
            conversationId = Date.now();
            currentHistoryId = String(conversationId);
            currentHistoryMessages = [];
            currentSubSessions = [];
            currentPlan = null;
            currentSkillStepStore = {};
            renderPlanPanel(null);
            renderSkillStepFromStore();
            window.electronAPI.setLastHistoryId(currentHistoryId);
            saveCurrentHistory();
            // 刷新侧边栏
            loadHistoryList();
            // 保存 DeepSeek URL（由 main.js 直接返回）
            if (data.url && data.url.indexOf('/chat/') >= 0) {
                currentHistoryDeepseekUrl = data.url;
                if (currentHistoryId) {
                    window.electronAPI.historyLoadUrl(currentHistoryId, data.url);
                }
                saveCurrentHistory();
            } else {
                // fallback: 轮询获取 URL
                setTimeout(function pollUrl() {
                    window.electronAPI.agentGetDeepseekUrl().then(function(urlObj) {
                        var url = urlObj && urlObj.url;
                        if (url && url.indexOf('/chat/') >= 0) {
                            currentHistoryDeepseekUrl = url;
                            if (currentHistoryId) {
                                window.electronAPI.historyLoadUrl(currentHistoryId, url);
                            }
                            saveCurrentHistory();
                        } else {
                            setTimeout(pollUrl, 1000);
                        }
                    });
                }, 1000);
            }
            break;
        case 'stop':
            // 停止由 main.js 处理
            break;
    }
});

// 轮询 QQ Bot 状态（更新队列信息）
setInterval(function() {
    if (!qqBotEnabled) return;
    window.electronAPI.qqbotStatus().then(function(status) {
        if (status.running) {
            document.getElementById('qqbot-status-text').textContent = '运行中';
        }
        if (status.authorized) {
            document.getElementById('qqbot-authorized-section').style.display = '';
            document.getElementById('qqbot-authorized-openid').textContent = status.openid || '';
        }
        if (status.queueLength > 0 || status.processing) {
            document.getElementById('qqbot-queue-info').style.display = '';
            document.getElementById('qqbot-queue-count').textContent = status.queueLength;
        } else {
            document.getElementById('qqbot-queue-info').style.display = 'none';
        }
    });
}, 3000);

// ==================== MCP 配置管理 ====================
var mcpServersGlobal = [];
var mcpEditingIndex = -1;
var mcpEditType = 'stdio';

function toggleMcpPanel() {
    var panel = document.getElementById('mcp-panel');
    var arrow = document.getElementById('mcp-arrow');
    if (panel.style.display === 'none') {
        panel.style.display = 'block';
        arrow.textContent = '▼';
        refreshMcpServerList();
    } else {
        panel.style.display = 'none';
        arrow.textContent = '?';
    }
}

function setMcpType(type) {
    mcpEditType = type;
    var btnStdio = document.getElementById('mcp-type-stdio');
    var btnUrl = document.getElementById('mcp-type-url');
    var fieldsStdio = document.getElementById('mcp-fields-stdio');
    var fieldsUrl = document.getElementById('mcp-fields-url');
    if (type === 'url') {
        btnStdio.style.background = 'transparent';
        btnStdio.style.color = '#8a8aaa';
        btnStdio.style.borderColor = '#3a3a6a';
        btnUrl.style.background = '#0d7377';
        btnUrl.style.color = '#fff';
        btnUrl.style.borderColor = '#0ea5e9';
        fieldsStdio.style.display = 'none';
        fieldsUrl.style.display = 'block';
    } else {
        btnStdio.style.background = '#0d7377';
        btnStdio.style.color = '#fff';
        btnStdio.style.borderColor = '#0ea5e9';
        btnUrl.style.background = 'transparent';
        btnUrl.style.color = '#8a8aaa';
        btnUrl.style.borderColor = '#3a3a6a';
        fieldsStdio.style.display = 'block';
        fieldsUrl.style.display = 'none';
    }
}

function toggleMcpServer(index) {
    if (index < 0 || index >= mcpServersGlobal.length) return;
    var srv = mcpServersGlobal[index];
    srv.disabled = !srv.disabled;
    // 保存到配置
    window.electronAPI.agentConfigLoad().then(function(res) {
        if (!res.success) return;
        var config = res.config || {};
        config.mcpServers = mcpServersGlobal;
        window.electronAPI.agentConfigSave(config).then(function() {
            renderMcpServerList();
            // 重新加载 MCP
            window.electronAPI.mcpInit(true).then(function(initRes) {
                if (initRes.success) {
                    showStatus('MCP 已重载');
                }
            });
        });
    });
}

function refreshMcpServerList() {
    window.electronAPI.agentConfigLoad().then(function(res) {
        if (res.success && res.config) {
            mcpServersGlobal = res.config.mcpServers || [];
            renderMcpServerList();
        }
    });
}

function renderMcpServerList() {
    var listEl = document.getElementById('mcp-server-list');
    var countEl = document.getElementById('mcp-global-count');
    var statusEl = document.getElementById('mcp-status-text');
    var enabledCount = mcpServersGlobal.filter(function(s) { return !s.disabled; }).length;
    countEl.textContent = mcpServersGlobal.length + ' 个服务器';
    statusEl.textContent = '已启用: ' + enabledCount + '/' + mcpServersGlobal.length;
    if (mcpServersGlobal.length === 0) {
        listEl.innerHTML = '<span style="color:#666;font-size:11px;">暂无配置</span>';
        return;
    }
    var html = '';
    mcpServersGlobal.forEach(function(srv, idx) {
        var enabled = !srv.disabled;
        html += '<div style="display:flex;align-items:center;gap:6px;padding:4px 6px;background:rgba(255,255,255,.03);border-radius:4px;margin-bottom:4px;">';
        // 独立开关
        html += '<div class="switch' + (enabled ? ' on' : '') + '" onclick="toggleMcpServer(' + idx + ')" style="flex-shrink:0;transform:scale(0.65);transform-origin:left center;"></div>';
        html += '<span style="flex:1;font-size:11px;color:' + (enabled ? '#ccc' : '#666') + ';white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' + (srv.name || '未命名') + '</span>';
        if (srv.url) {
            html += '<span style="font-size:10px;color:#4a9a8a;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:80px;" title="' + srv.url + '">SSE</span>';
        } else {
            html += '<span style="font-size:10px;color:#6a6a8a;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:80px;">' + (srv.command || '') + '</span>';
        }
        html += '<button onclick="showMcpEditModal(' + idx + ')" style="padding:2px 6px;background:transparent;border:1px solid #3a3a6a;border-radius:4px;color:#8a8aaa;cursor:pointer;font-size:10px;">编辑</button>';
        html += '<button onclick="deleteMcpServer(' + idx + ')" style="padding:2px 6px;background:transparent;border:1px solid #6e3a3a;border-radius:4px;color:#e88;cursor:pointer;font-size:10px;">删除</button>';
        html += '</div>';
    });
    listEl.innerHTML = html;
}

function showMcpEditModal(index) {
    mcpEditingIndex = (typeof index === 'number') ? index : -1;
    var modal = document.getElementById('mcp-edit-modal');
    var title = document.getElementById('mcp-edit-title');
    var nameInput = document.getElementById('mcp-edit-name');
    var cmdInput = document.getElementById('mcp-edit-command');
    var argsInput = document.getElementById('mcp-edit-args');
    var cwdInput = document.getElementById('mcp-edit-cwd');
    var urlInput = document.getElementById('mcp-edit-url');
    if (mcpEditingIndex >= 0 && mcpServersGlobal[mcpEditingIndex]) {
        var srv = mcpServersGlobal[mcpEditingIndex];
        title.textContent = '编辑 MCP 服务器';
        nameInput.value = srv.name || '';
        if (srv.url) {
            setMcpType('url');
            urlInput.value = srv.url || '';
            cmdInput.value = '';
            argsInput.value = '';
            cwdInput.value = '';
        } else {
            setMcpType('stdio');
            cmdInput.value = srv.command || '';
            argsInput.value = (srv.args || []).join(' ');
            cwdInput.value = srv.cwd || '';
            urlInput.value = '';
        }
    } else {
        title.textContent = '添加 MCP 服务器';
        nameInput.value = '';
        cmdInput.value = '';
        argsInput.value = '';
        cwdInput.value = '';
        urlInput.value = '';
        setMcpType('stdio');
    }
    modal.style.display = 'flex';
}

function doSaveMcpServer() {
    var name = document.getElementById('mcp-edit-name').value.trim();
    var command = document.getElementById('mcp-edit-command').value.trim();
    var argsStr = document.getElementById('mcp-edit-args').value.trim();
    var cwd = document.getElementById('mcp-edit-cwd').value.trim();
    var url = document.getElementById('mcp-edit-url').value.trim();
    if (!name) { alert('请输入服务器名称'); return; }
    if (mcpEditType === 'url') {
        if (!url) { alert('请输入 URL'); return; }
    } else {
        if (!command) { alert('请输入命令'); return; }
    }
    var srv;
    if (mcpEditType === 'url') {
        srv = { name: name, url: url };
    } else {
        var args = argsStr ? argsStr.split(/\s+/) : [];
        srv = { name: name, command: command, args: args };
        if (cwd) srv.cwd = cwd;
    }
    window.electronAPI.agentConfigLoad().then(function(res) {
        if (!res.success) { alert('加载配置失败'); return; }
        var config = res.config || {};
        var servers = config.mcpServers || [];
        if (mcpEditingIndex >= 0 && servers[mcpEditingIndex]) {
            servers[mcpEditingIndex] = srv;
        } else {
            servers.push(srv);
        }
        config.mcpServers = servers;
        window.electronAPI.agentConfigSave(config).then(function(saveRes) {
            if (saveRes.success) {
                document.getElementById('mcp-edit-modal').style.display = 'none';
                mcpServersGlobal = servers;
                renderMcpServerList();
                // 自动重新加载 MCP
                window.electronAPI.mcpInit(true).then(function(initRes) {
                    if (initRes.success && initRes.tools) {
                        showStatus('MCP 已重载: ' + initRes.tools.length + ' 个工具');
                    }
                });
            } else {
                alert('保存失败: ' + (saveRes.error || '未知错误'));
            }
        });
    });
}

async function deleteMcpServer(index) {
    if (!await confirmModal('确定删除此 MCP 服务器配置？')) return;
    window.electronAPI.agentConfigLoad().then(function(res) {
        if (!res.success) return;
        var config = res.config || {};
        var servers = config.mcpServers || [];
        if (index >= 0 && index < servers.length) {
            servers.splice(index, 1);
            config.mcpServers = servers;
            window.electronAPI.agentConfigSave(config).then(function(saveRes) {
                if (saveRes.success) {
                    mcpServersGlobal = servers;
                    renderMcpServerList();
                }
            });
        }
    });
}

function applyMcpToCurrentFolder() {
    if (mcpServersGlobal.length === 0) {
        showStatus('全局没有配置 MCP 服务器');
        return;
    }
    window.electronAPI.agentConfigLoad().then(function(res) {
        if (!res.success) { showStatus('读取配置失败'); return; }
        var config = res.config || {};
        config.mcpServers = JSON.parse(JSON.stringify(mcpServersGlobal));
        window.electronAPI.agentConfigSave(config).then(function(saveRes) {
            if (saveRes.success) {
                showStatus('已将 ' + mcpServersGlobal.length + ' 个 MCP 服务器应用到当前文件夹');
                // 重新初始化 MCP
                window.electronAPI.mcpInit(true).then(function(initRes) {
                    if (initRes.success && initRes.tools) {
                        showStatus('MCP 已重载: ' + initRes.tools.length + ' 个工具');
                    }
                });
            } else {
                showStatus('应用失败: ' + (saveRes.error || '未知错误'));
            }
        });
    });
}

function reloadMcpServers() {
    window.electronAPI.mcpInit(true).then(function(res) {
        if (res.success) {
            var toolCount = res.tools ? res.tools.length : 0;
            showStatus('MCP 重载完成: ' + toolCount + ' 个工具');
            refreshMcpServerList();
        } else {
            showStatus('MCP 重载失败: ' + (res.error || res.message || '未知错误'));
        }
    });
}

function handleMcpImportFile(input) {
    var file = input.files[0];
    input.value = '';
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function(e) {
        try {
            var json = JSON.parse(e.target.result);
            var imported = json.mcpServers || {};
            var keys = Object.keys(imported);
            if (keys.length === 0) {
                showStatus('JSON 中未找到 mcpServers 配置');
                return;
            }
            window.electronAPI.agentConfigLoad().then(function(res) {
                if (!res.success) { showStatus('加载配置失败'); return; }
                var config = res.config || {};
                var servers = config.mcpServers || [];
                var addedCount = 0;
                keys.forEach(function(key) {
                    var item = imported[key];
                    if (!item) return;
                    // URL 类型
                    if (item.url) {
                        var exists = servers.some(function(s) { return s.name === key; });
                        if (exists) return;
                        servers.push({ name: key, url: item.url });
                        addedCount++;
                        return;
                    }
                    // 命令行类型
                    if (!item.command) return;
                    var exists = servers.some(function(s) { return s.name === key; });
                    if (exists) return;
                    var srv = {
                        name: key,
                        command: item.command,
                        args: Array.isArray(item.args) ? item.args : []
                    };
                    if (item.cwd) srv.cwd = item.cwd;
                    servers.push(srv);
                    addedCount++;
                });
                config.mcpServers = servers;
                window.electronAPI.agentConfigSave(config).then(function(saveRes) {
                    if (saveRes.success) {
                        mcpServersGlobal = servers;
                        renderMcpServerList();
                        showStatus('已导入 ' + addedCount + ' 个 MCP 服务器');
                        window.electronAPI.mcpInit(true).then(function(initRes) {
                            if (initRes.success && initRes.tools) {
                                showStatus('MCP 已重载: ' + initRes.tools.length + ' 个工具');
                            }
                        });
                    } else {
                        showStatus('保存失败: ' + (saveRes.error || '未知错误'));
                    }
                });
            });
        } catch (err) {
            showStatus('解析 JSON 失败: ' + err.message);
        }
    };
    reader.readAsText(file);
}

// ==================== 表单管理 ====================
var currentFormData = null;

// 监听表单展示事件
window.electronAPI.onAgentFormShow(function(formData) {
    showFormModal(formData);
});

function showFormModal(formData) {
    currentFormData = formData;
    var fieldsEl = document.getElementById('form-modal-fields');
    document.getElementById('form-modal-title').textContent = formData.title || '表单';
    var html = '';
    for (var i = 0; i < formData.questions.length; i++) {
        var q = formData.questions[i];
        var opts = (formData.options[i] || '').split(',').map(function(o) { return o.trim(); }).filter(Boolean);
        html += '<div style="margin-bottom:12px;">';
        html += '<label style="display:block;color:#ccc;font-size:12px;margin-bottom:4px;">' + (i + 1) + '. ' + q + '</label>';
        if (opts.length > 0) {
            html += '<div style="display:flex;flex-wrap:wrap;gap:4px;margin-bottom:4px;">';
            for (var oi = 0; oi < opts.length; oi++) {
                html += '<label style="display:flex;align-items:center;gap:2px;padding:2px 6px;background:rgba(255,255,255,.05);border-radius:4px;cursor:pointer;font-size:11px;color:#aaa;">';
                html += '<input type="radio" name="form_q_' + i + '" value="' + opts[oi] + '" style="accent-color:#0ea5e9;">' + opts[oi];
                html += '</label>';
            }
            html += '</div>';
        }
        html += '<input id="form-answer-' + i + '" placeholder="输入回答..." style="width:100%;padding:6px 8px;background:#0d0d20;border:1px solid #3a3a5a;border-radius:6px;color:#ccc;font-size:12px;box-sizing:border-box;">';
        html += '</div>';
    }
    fieldsEl.innerHTML = html;
    document.getElementById('form-modal').style.display = 'flex';
}

function submitFormResponse() {
    if (!currentFormData) return;
    var answers = {};
    var title = currentFormData.title || '表单';
    for (var i = 0; i < currentFormData.questions.length; i++) {
        var q = currentFormData.questions[i];
        var radio = document.querySelector('input[name="form_q_' + i + '"]:checked');
        var text = document.getElementById('form-answer-' + i);
        if (radio) {
            answers[q] = radio.value;
        } else if (text && text.value.trim()) {
            answers[q] = text.value.trim();
        }
    }
    document.getElementById('form-modal').style.display = 'none';
    currentFormData = null;
    window.electronAPI.agentFormSubmit({ title: title, answers: answers });
    showStatus('表单已提交');
}

// ==================== 计划面板（每个对话独立） ====================
// 监听计划更新事件（来自 main.js 的 agent-plan-update）
window.electronAPI.onAgentPlanUpdate(function(plan) {
    currentPlan = plan;
    renderPlanPanel(plan);
    saveCurrentHistory();
});

function renderPlanPanel(plan) {
    if (!plan || !plan.title || !plan.steps || plan.steps.length === 0) {
        document.getElementById('plan-panel').style.display = 'none';
        return;
    }
    document.getElementById('plan-panel').style.display = '';
    document.getElementById('plan-panel-title').textContent = '?? ' + plan.title;
    var doneCount = plan.steps.filter(function(s) { return s.status === 'done'; }).length;
    document.getElementById('plan-progress').textContent = doneCount + '/' + plan.steps.length + ' 完成';
    var html = '';
    for (var si = 0; si < plan.steps.length; si++) {
        var s = plan.steps[si];
        var icon = s.status === 'done' ? '?' : s.status === 'in_progress' ? '??' : '?';
        var color = s.status === 'in_progress' ? '#0ea5e9' : s.status === 'done' ? '#8bc88b' : '#6a6a8a';
        html += '<div style="padding:2px 0;color:' + color + ';font-size:10px;">' + icon + ' ' + s.id + '. ' + s.description;
        if (s.result) html += ' — <span style="color:#888;">' + s.result + '</span>';
        html += '</div>';
    }
    document.getElementById('plan-steps-list').innerHTML = html;
}

function deletePlan() {
    if (!confirm('确定清空当前计划？')) return;
    currentPlan = null;
    document.getElementById('plan-panel').style.display = 'none';
    document.getElementById('plan-steps-list').innerHTML = '';
    saveCurrentHistory();
    showStatus('计划已清空');
}

// ==================== Skill 步骤面板（每个对话独立） ====================

// 从 currentSkillStepStore 渲染所有 Skill 步骤
function renderSkillStepFromStore() {
    var panel = document.getElementById('skill-step-panel');
    var list = document.getElementById('skill-step-list');
    if (!panel || !list) return;

    var skills = Object.keys(currentSkillStepStore);
    if (skills.length === 0) {
        panel.style.display = 'none';
        list.innerHTML = '';
        return;
    }

    panel.style.display = '';
    // 显示所有 skill 的步骤
    var html = '';
    skills.forEach(function(skill) {
        var steps = currentSkillStepStore[skill];
        if (!steps || steps.length === 0) return;
        html += '<div style="font-weight:600;color:#888;margin-top:4px;font-size:10px;">?? ' + skill + '</div>';
        for (var i = 0; i < steps.length; i++) {
            var s = steps[i];
            var icon = s.status === 'completed' ? '?' : s.status === 'failed' ? '?' : s.status === 'running' ? '??' : '??';
            var color = s.status === 'running' ? '#0ea5e9' : s.status === 'completed' ? '#8bc88b' : s.status === 'failed' ? '#e88' : '#6a6a8a';
            html += '<div style="padding:1px 0;color:' + color + ';font-size:9px;">' + icon + ' ' + s.step + '</div>';
        }
    });
    list.innerHTML = html;
    document.getElementById('skill-step-panel-title').textContent = '?? 步骤';

    // 显示最新步骤状态
    var lastSkill = skills[skills.length - 1];
    var lastSteps = currentSkillStepStore[lastSkill];
    if (lastSteps && lastSteps.length > 0) {
        var last = lastSteps[lastSteps.length - 1];
        var statusLabels = { running: '进行中', completed: '已完成', failed: '失败', info: '信息' };
        document.getElementById('skill-step-current').textContent = lastSkill + ': ' + last.step + ' [' + (statusLabels[last.status] || last.status) + ']';
    }
}

function renderSkillStepPanel(data) {
    if (!data || !data.skill || !data.step) return;

    if (!currentSkillStepStore[data.skill]) {
        currentSkillStepStore[data.skill] = [];
    }
    var steps = currentSkillStepStore[data.skill];
    var idx = steps.findIndex(function(s) { return s.step === data.step; });
    if (idx >= 0) {
        steps[idx] = data;
    } else {
        // 新增步骤时，把同 skill 上一个 running 状态自动标记为 completed
        if (data.status === 'running' || !data.status) {
            for (var i = steps.length - 1; i >= 0; i--) {
                if (steps[i].status === 'running') {
                    steps[i].status = 'completed';
                    break;
                }
            }
        }
        steps.push(data);
    }

    renderSkillStepFromStore();
    saveCurrentHistory();
}

function clearSkillSteps() {
    currentSkillStepStore = {};
    document.getElementById('skill-step-panel').style.display = 'none';
    document.getElementById('skill-step-list').innerHTML = '';
    saveCurrentHistory();
}

// 监听 skill-step 更新事件
window.electronAPI.onAgentSkillStep(function(data) {
    renderSkillStepPanel(data);
});

// 初始化底部折叠状态，避免 1.5s 后才折叠导致页面抖动
initBottomExtrasCollapse();

// 页面加载时初始化滚动事件
setTimeout(function() {
    var chatArea = document.getElementById('chat-area');
    if (chatArea) {
        chatArea.addEventListener('scroll', function() {
            // 用户离开底部则标记，回到底部则清除
            userScrolledAway = !isChatScrolledToBottom();
            updateScrollToBottomBtn();
        }, { passive: true });
    }
}, 1500);

// 页面加载时刷新 MCP 列表
setTimeout(function() {
    refreshMcpServerList();
}, 2000);

// 在 AI 最终回复后自动发送到 QQ（hook addAssistantSegments 的末尾）
var origAddAssistantSegments = addAssistantSegments;
addAssistantSegments = function(segments, skipSave) {
    origAddAssistantSegments(segments, skipSave);
    if (!qqBotEnabled || skipSave || isInWorkflow) return;
    var textParts = [];
    var filePaths = [];
    segments.forEach(function(s) {
        if (s.type === 'text' && s.content.trim()) {
            var t = s.content.trim();
            // 将 ```file 路径``` 替换为 `文件名`（QQ 消息更简洁），不限制扩展名
            t = t.replace(/```\s*file\s+([^\n`]+?)\s*```/gi, function(m, p) {
                var name = p.replace(/\\/g, '/').split('/').pop().replace(/^\s+|\s+$/g, '');
                return '`' + name + '`';
            });
            // 兼容旧格式 path="..."
            t = t.replace(/path\s*=\s*["'][^"']+["']/gi, function(m) {
                var name = m.replace(/\\/g, '/').split('/').pop().replace(/^path\s*=\s*["']|["']$/gi, '');
                return '`' + name + '`';
            });
            textParts.push(t);
        }
        // 提取所有 ```file 路径``` 路径，不限制扩展名（图片/视频/文件统一处理）
        var fileRegex = /```\s*file\s+([^\n`]+?)\s*```/gi;
        var m;
        while ((m = fileRegex.exec(s.content || '')) !== null) {
            filePaths.push(m[1].trim());
        }
        // 兼容旧格式 path="..."
        var pathRegex = /path\s*=\s*["']([^"']+)["']/gi;
        while ((m = pathRegex.exec(s.content || '')) !== null) {
            filePaths.push(m[1]);
        }
    });
    // 去重
    var seen = {};
    filePaths = filePaths.filter(function(fp) {
        if (seen[fp]) return false;
        seen[fp] = true;
        return true;
    });
    if (textParts.length > 0 || filePaths.length > 0) {
        window.electronAPI.qqbotSendResponse({
            text: textParts.join('\n\n'),
            files: filePaths
        });
    }
};

// ==================== 目录切换时关闭对话 ====================
function closeCurrentConversation() {
    // 停止所有正在进行的操作
    isGenerating = false;
    isExecutingTasks = false;
    isTaskChainActive = false;
    isInWorkflow = false;
    workflowWrappers = [];
    updateSendBtn();
    hideLoading();
    // 重置历史追踪
    currentHistoryId = null;
    currentHistoryMessages = [];
    currentHistoryDeepseekUrl = null;
    currentHistoryExpired = false;
    initCompleted = false;
    conversationId = null;
    // 通知主进程清除保存的历史对话 ID
    window.electronAPI.setLastHistoryId(null);
    // 清理残留进度元素
    var progressEl = document.querySelector('[id="qwen-progress-msg"]');
    if (progressEl && progressEl.parentNode) progressEl.parentNode.remove();
    // 清理所有 tool-card 中的 filled 标记
    document.querySelectorAll('.tool-section-result').forEach(function(el) { delete el.dataset.filled; });
    // 重置聊天区
    var area = document.getElementById('chat-area');
    area.innerHTML = '';
    var empty = document.createElement('div');
    empty.className = 'empty-msg';
    empty.textContent = '选择模式后点击「创建对话」开始';
    area.appendChild(empty);
    document.getElementById('pre-init-section').style.display = '';
    document.getElementById('post-init-section').style.display = 'none';
    document.getElementById('newchat-modal').style.display = 'none';
    var input = document.getElementById('prompt-input');
    if (input) { input.disabled = false; input.value = ''; }
}

// 监听主进程的关闭对话指令（目录切换时触发）
window.electronAPI.onAgentCloseConversation(function() {
    closeCurrentConversation();
});

// ==================== 文件附件栏 ====================
var attachedFiles = [];
var activeSkills = [];  // 已激活的技能 [{name, instructions}]

function addFileToPanel(filePath, fileName, fileType) {
    attachedFiles.push({ type: fileType || 'file', path: filePath, name: fileName || getFileName(filePath) });
    renderFilePanel();
    document.getElementById('file-panel-bar').style.display = '';
}

function removeFileFromPanel(idx) {
    attachedFiles.splice(idx, 1);
    renderFilePanel();
    if (attachedFiles.length === 0 && activeSkills.length === 0) document.getElementById('file-panel-bar').style.display = 'none';
}

function removeSkillFromPanel(idx) {
    activeSkills.splice(idx, 1);
    renderFilePanel();
    if (attachedFiles.length === 0 && activeSkills.length === 0) document.getElementById('file-panel-bar').style.display = 'none';
}

function getFileName(fullPath) {
    var parts = fullPath.replace(/\\/g, '/').split('/');
    return parts[parts.length - 1] || fullPath;
}

function renderFilePanel() {
    var container = document.getElementById('file-panel-items');
    var countEl = document.getElementById('file-panel-count');
    var clearBtn = document.getElementById('file-panel-clear');
    var totalCount = attachedFiles.length + activeSkills.length;
    container.innerHTML = '';
    if (totalCount === 0) {
        countEl.textContent = '';
        clearBtn.style.display = 'none';
        return;
    }
    countEl.textContent = '(' + totalCount + ')';
    clearBtn.style.display = '';
    // 渲染技能 chips
    activeSkills.forEach(function(s, i) {
        var chip = document.createElement('span');
        chip.className = 'skill-chip';
        chip.innerHTML = '<span class="chip-name">?? ' + escapeHtml(s.name) + '</span><span class="chip-remove">?</span>';
        chip.querySelector('.chip-remove').onclick = function() { removeSkillFromPanel(i); };
        chip.title = '技能: ' + s.name;
        container.appendChild(chip);
    });
    // 渲染文件 chips
    attachedFiles.forEach(function(f, i) {
        var chip = document.createElement('span');
        chip.className = 'file-chip' + (f.type === 'image' ? ' chip-image' : '');
        var icon = f.type === 'image' ? '?? ' : '?? ';
        chip.innerHTML = '<span class="chip-name">' + escapeHtml(icon + f.name) + '</span><span class="chip-remove">?</span>';
        chip.querySelector('.chip-remove').onclick = function() { removeFileFromPanel(i); };
        chip.title = f.path;
        container.appendChild(chip);
    });
}

function clearFilePanel() {
    attachedFiles = [];
    activeSkills = [];
    renderFilePanel();
    document.getElementById('file-panel-bar').style.display = 'none';
}

function getFilePathsForSend() {
    if (attachedFiles.length === 0) return '';
    return attachedFiles.map(function(f) {
        return 'path="' + f.path.replace(/"/g, '\\"') + '"';
    }).join('\n') + '\n\n';
}

function getSkillPrefix() {
    if (activeSkills.length === 0) return '';
    return activeSkills.map(function(s) {
        var skillPath = '.dsa/skills/' + s.name + '/';
        var header = '请按照以下技能指令来帮助我完成任务。';
        header += '\n技能文件位于 `' + skillPath + '` 目录下，可使用 `list` 和 `read` 读取附加文件。';
        return header + '\n\n---\n## 技能: ' + s.name + '\n\n**路径:** `' + skillPath + '`\n\n' + s.instructions + '\n---';
    }).join('\n\n') + '\n\n';
}

// ==================== 文件上传（粘贴 / 拖拽 / 选择文件） ====================
// 底部区域整体支持拖拽（dropzone + input 区域）
var dropTargets = [
    document.getElementById('file-panel-dropzone'),
    document.getElementById('prompt-row'),
    document.getElementById('file-panel')
].filter(Boolean);

function handleDragOver(e) { e.preventDefault(); document.getElementById('file-panel-dropzone').style.borderColor = '#8888ff'; document.getElementById('file-panel-dropzone').style.background = 'rgba(100,100,255,.1)'; }
function handleDragLeave(e) { e.preventDefault(); document.getElementById('file-panel-dropzone').style.borderColor = '#444'; document.getElementById('file-panel-dropzone').style.background = ''; }

dropTargets.forEach(function(el) {
    el.addEventListener('dragover', handleDragOver);
    el.addEventListener('dragleave', handleDragLeave);
    el.addEventListener('drop', function(e) {
        e.preventDefault();
        handleDragLeave(e);
        var files = e.dataTransfer.files;
        // 外部拖拽：files 对象有内容（Windows 拖入、文件浏览器拖入）
        if (files && files.length > 0) {
            for (var fi = 0; fi < files.length; fi++) {
                (function(f) {
                    if (f.type.indexOf('image') === 0) {
                        var reader = new FileReader();
                        reader.onload = function(ev) {
                            window.electronAPI.saveTempImage({ data: ev.target.result, name: f.name }).then(function(res) {
                                if (res && res.success) addFileToPanel(res.path, f.name, 'image');
                            });
                        };
                        reader.readAsDataURL(f);
                    } else {
                        // 外部文件：f.path 只在 Electron 中可用
                        addFileToPanel(f.path || f.name, f.name, 'file');
                    }
                })(files[fi]);
            }
            return;
        }
        // 文本拖拽（文件浏览器拖入的路径文本）
        var text = e.dataTransfer.getData('text');
        if (text) text.split('\n').forEach(function(p) { p = p.trim(); if (p) addFileToPanel(p, getFileName(p), 'file'); });
    });
});

// 粘贴图片（输入框 + 整个底部区域）
document.getElementById('post-init-section').addEventListener('paste', function(e) {
    var items = e.clipboardData && e.clipboardData.items;
    if (!items) return;
    var hasImage = false;
    for (var i = 0; i < items.length; i++) {
        if (items[i].type.indexOf('image') === 0) {
            e.preventDefault();
            hasImage = true;
            var blob = items[i].getAsFile();
            if (!blob) continue;
            (function(b) {
                var reader = new FileReader();
                reader.onload = function(ev) {
                    window.electronAPI.saveTempImage({ data: ev.target.result, name: 'clipboard_' + Date.now() + '.' + (b.type.split('/')[1] || 'png') }).then(function(res) {
                        if (res && res.success) addFileToPanel(res.path, getFileName(res.path), 'image');
                    });
                };
                reader.readAsDataURL(b);
            })(blob);
            break;
        }
    }
    // 大文本自动保存（无图片时检测文本大小）
    if (!hasImage) {
        var text = e.clipboardData.getData('text');
        if (text && text.length > 5120) { // >5KB
            e.preventDefault();
            window.electronAPI.saveLargeText(text).then(function(res) {
                if (res && res.success) {
                    addFileToPanel(res.path, getFileName(res.path), 'file');
                    showToast('[自动保存] 粘贴内容超过5KB，已保存为临时文件');
                }
            });
        }
    }
});

// 选择文件按钮
document.getElementById('file-upload-btn').addEventListener('click', function() {
    var input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.onchange = function() {
        for (var i = 0; i < input.files.length; i++) {
            (function(f) {
                if (f.type.indexOf('image') === 0) {
                    var reader = new FileReader();
                    reader.onload = function(ev) {
                        window.electronAPI.saveTempImage({ data: ev.target.result, name: f.name }).then(function(res) {
                            if (res && res.success) addFileToPanel(res.path, f.name, 'image');
                        });
                    };
                    reader.readAsDataURL(f);
                } else {
                    addFileToPanel(f.path || f.name, f.name, 'file');
                }
            })(input.files[i]);
        }
    };
    input.click();
});

document.getElementById('file-panel-clear').onclick = clearFilePanel;

// 接收文件浏览器发送的文件路径
window.electronAPI.onAgentAddFile(function(filePath) {
    addFileToPanel(filePath, getFileName(filePath), 'file');
});

// 全局双击打开文件：对话中所有 .path-chip 双击即用系统程序打开
document.getElementById('chat-area').addEventListener('dblclick', function(e) {
    var chip = e.target.closest('.path-chip');
    if (!chip) return;
    var filePath = chip.getAttribute('data-path');
    if (filePath) window.electronAPI.openFile(filePath);
});

// ==================== DOM 确认弹窗（替代原生 confirm） ====================
function confirmModal(msg) {
    return new Promise(function(resolve) {
        var modal = document.getElementById('confirm-modal');
        var textEl = document.getElementById('confirm-modal-text');
        var okBtn = document.getElementById('confirm-modal-ok');
        var cancelBtn = document.getElementById('confirm-modal-cancel');
        if (!modal || !textEl || !okBtn || !cancelBtn) {
            resolve(true); // 兜底
            return;
        }
        textEl.textContent = msg;
        modal.style.display = 'flex';
        function cleanup(result) {
            modal.style.display = 'none';
            okBtn.removeEventListener('click', onOk);
            cancelBtn.removeEventListener('click', onCancel);
            resolve(result);
        }
        function onOk() { cleanup(true); }
        function onCancel() { cleanup(false); }
        okBtn.addEventListener('click', onOk);
        cancelBtn.addEventListener('click', onCancel);
    });
}

// ==================== 焦点保护 ====================
// 防止后台 BrowserView 劫持焦点导致输入框不可用
(function() {
    var promptRow = document.getElementById('prompt-row');
    var promptInput = document.getElementById('prompt-input');
    if (!promptRow || !promptInput) return;

    // 点击输入区域时强制聚焦（即使被其他元素劫持了焦点）
    promptRow.addEventListener('mousedown', function(e) {
        // 仅在点击非按钮区域时聚焦输入框
        if (e.target.tagName !== 'BUTTON') {
            setTimeout(function() { promptInput.focus(); }, 0);
        }
    });

    // 定时检测：如果初始化已完成但输入框意外失焦，尝试恢复
    setInterval(function() {
        if (!initCompleted || isTaskChainActive) return;
        // 如果用户正在选中文本，不抢焦点
        var sel = window.getSelection();
        if (sel && sel.toString().length > 0) return;
        if (!promptInput._focused && document.hasFocus()) {
            // 页面有焦点但输入框没有，且用户可能正在使用
            var activeEl = document.activeElement;
            if (activeEl !== promptInput && activeEl.tagName !== 'BUTTON') {
                // 不强制抢焦点（避免打断用户操作），只记录
                // 但如果 activeElement 是 body 或其他无意义元素，则恢复
                if (activeEl === document.body || activeEl === document.documentElement) {
                    promptInput.focus();
                }
            }
        }
    }, 2000);
})();

// ── 自动更新进度条 ──
(function() {
    var overlay = document.getElementById('update-overlay');
    if (!overlay) return; // 安全兜底
    var bar = document.getElementById('update-progress-bar');
    var text = document.getElementById('update-progress-text');

    window.electronAPI.onUpdateProgress(function(data) {
        overlay.style.display = 'flex';
        bar.style.width = data.percent + '%';
        text.textContent = data.percent + '%';
        if (data.bytesPerSecond) {
            var speed = (data.bytesPerSecond / 1024 / 1024).toFixed(1);
            var done = (data.transferred / 1024 / 1024).toFixed(1);
            var total = (data.total / 1024 / 1024).toFixed(0);
            text.textContent = data.percent + '% (' + done + '/' + total + ' MB @ ' + speed + ' MB/s)';
        }
    });

    window.electronAPI.onUpdateDownloaded(function() {
        bar.style.width = '100%';
        text.textContent = '下载完成，正在准备安装...';
    });
})();

// ========== 技能弹窗 ==========
var skillsModalData = [];
var disabledSkills = [];

// 解析 SKILL.md 的 YAML frontmatter
function parseSkillFrontmatter(instructions) {
    var fm = {};
    var match = instructions.match(/^---\s*\n([\s\S]*?)\n---/);
    if (!match) return fm;
    var body = match[1];
    var lines = body.split('\n');
    var currentKey = null;
    var currentValue = [];
    var currentMode = null;
    for (var li = 0; li < lines.length; li++) {
        var line = lines[li];
        if (currentKey) {
            var indentMatch = line.match(/^(\s+)(.*)$/);
            if (indentMatch) {
                currentValue.push(indentMatch[2]);
                continue;
            } else {
                fm[currentKey] = currentMode === 'literal'
                    ? currentValue.join('\n').trim()
                    : currentValue.join(' ').replace(/\s+/g, ' ').trim();
                currentKey = null;
                currentValue = [];
                currentMode = null;
            }
        }
        var kv = line.match(/^\s*(\w+)\s*:\s*(.*)$/);
        if (!kv) continue;
        var key = kv[1];
        var val = kv[2].trim();
        if (val === '>' || val === '|') {
            currentKey = key;
            currentValue = [];
            currentMode = val === '|' ? 'literal' : 'fold';
        } else if (val === '') {
            currentKey = key;
            currentValue = [];
            currentMode = 'fold';
        } else {
            fm[key] = val;
        }
    }
    if (currentKey) {
        fm[currentKey] = currentMode === 'literal'
            ? currentValue.join('\n').trim()
            : currentValue.join(' ').replace(/\s+/g, ' ').trim();
    }
    return fm;
}

window.electronAPI.onAgentShowSkills(function(skills) {
    skillsModalData = skills || [];
    loadDisabledSkills();
});

async function loadDisabledSkills() {
    try {
        var res = await window.electronAPI.agentSkillGetDisabled();
        disabledSkills = (res && res.disabledSkills) ? res.disabledSkills : [];
    } catch(e) { disabledSkills = []; }
    renderSkillsModal();
}

window.electronAPI.onAgentOpenSkillsModal(async function() {
    await loadDisabledSkills();
    document.getElementById('skills-modal').style.display = 'flex';
});

window.closeSkillsModal = function() {
    document.getElementById('skills-modal').style.display = 'none';
};

window.renderSkillsModal = function() {
    var listEl = document.getElementById('skills-modal-list');
    if (skillsModalData.length === 0) {
        listEl.innerHTML = '<div class="skill-empty" style="padding:32px;text-align:center;color:#6a6a8a;font-size:13px;">无已加载技能<br><span style="font-size:11px;opacity:0.7;">请通过侧边栏 ?? 按钮导入技能文件夹</span></div>';
        return;
    }
    var html = '';
    skillsModalData.forEach(function(s, idx) {
        var isDisabled = disabledSkills.indexOf(s.name) !== -1;
        // 解析 YAML frontmatter 获取 description
        var fm = parseSkillFrontmatter(s.instructions || '');
        var desc = fm.description || '';
        var displayName = fm.name || s.name;
        var itemBg = isDisabled ? 'rgba(255,255,255,0.02)' : 'rgba(255,255,255,0.04)';
        var itemOpacity = isDisabled ? 'opacity:0.55;' : '';
        html += '<div class="skill-item" style="padding:10px 12px;border-radius:8px;margin-bottom:6px;background:' + itemBg + ';color:#d4d4d4;font-size:13px;' + itemOpacity + '">';
        html += '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;">';
        html += '<strong style="color:#e0e0f0;">' + escapeHtml(displayName) + (isDisabled ? ' <span style="font-size:10px;color:#6a6a8a;">(已禁用)</span>' : '') + '</strong>';
        html += '<div style="display:flex;gap:6px;">';
        html += '<button class="skill-use-btn" onclick="window.useSkill(' + idx + ')" style="padding:4px 10px;border:none;border-radius:6px;cursor:pointer;font-size:11px;font-weight:600;color:#22d3ee;background:rgba(34,211,238,0.12);">使用</button>';
        html += '<button onclick="window.toggleSkillDisabled(\'' + escapeHtml(s.name) + '\')" style="padding:4px 8px;border:none;border-radius:6px;cursor:pointer;font-size:11px;' + (isDisabled ? 'color:#4ade80;background:rgba(74,222,128,0.12);' : 'color:#f59e0b;background:rgba(245,158,11,0.12);') + '" title="' + (isDisabled ? '启用' : '禁用') + '">' + (isDisabled ? '?' : '?') + '</button>';
        html += '<button onclick="window.deleteSkillFromModal(\'' + escapeHtml(s.name) + '\')" style="padding:4px 8px;border:none;border-radius:6px;cursor:pointer;font-size:11px;color:#ef4444;background:rgba(239,68,68,0.12);">?</button>';
        html += '</div></div>';
        if (desc) {
            html += '<div class="skill-desc" style="font-size:11px;color:#8a8aaa;margin-top:2px;">' + escapeHtml(desc) + '</div>';
        }
        html += '<div style="font-size:10px;color:#6a6a8a;margin-top:2px;">额外文件: ' + (s.files && s.files.length > 0 ? s.files.join(', ') : '无') + '</div>';
        html += '</div>';
    });
    listEl.innerHTML = html;
};

window.toggleSkillDisabled = async function(name) {
    try {
        var res = await window.electronAPI.agentSkillToggleDisabled(name);
        if (res.success) {
            disabledSkills = res.disabledSkills || [];
            renderSkillsModal();
        }
    } catch(e) { console.error('toggleSkillDisabled failed:', e); }
};

window.useSkill = function(idx) {
    var skill = skillsModalData[idx];
    if (!skill) return;
    // 将技能添加到附件面板，作为 chip 展示
    activeSkills.push({ name: skill.name, instructions: skill.instructions });
    renderFilePanel();
    document.getElementById('file-panel-bar').style.display = '';
    closeSkillsModal();
};

window.deleteSkillFromModal = async function(name) {
    if (!await confirmModal('确定删除技能 "' + name + '"？')) return;
    window.electronAPI.deleteSkill(name);
};

function escapeHtml(str) {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// ==================== 菜单栏（在 agentview 头部渲染） ====================
var menuConfig = null;
var currentMenuTheme = 'dark';
var openMenuId = null;

// 加载菜单配置
async function loadMenubarConfig() {
    try {
        var res = await window.electronAPI.getMenubarConfig();
        if (res.success && res.config) {
            menuConfig = res.config;
            renderMenubar(res.config);
        }
    } catch (e) {
        console.error('[Menubar] Load error:', e);
    }
}

// 渲染菜单按钮
function renderMenubar(config) {
    var container = document.getElementById('menubar-btns');
    if (!container) return;
    container.innerHTML = '';

    (config.menu || []).forEach(function(m) {
        var btn = document.createElement('button');
        btn.className = 'mb-btn';
        btn.dataset.menuId = m.id;
        btn.textContent = m.label;

        btn.addEventListener('click', function(e) {
            e.stopPropagation();
            showMenuOverlay(m.id, btn);
        });

        container.appendChild(btn);
    });
}

// 显示菜单弹出层
function showMenuOverlay(menuId, btn) {
    var overlay = document.getElementById('titlebar-menu-overlay');
    if (!overlay || !menuConfig) return;

    // 如果已打开同一菜单则关闭
    if (openMenuId === menuId && overlay.style.display !== 'none') {
        closeMenuOverlay();
        return;
    }

    var menu = (menuConfig.menu || []).find(function(m) { return m.id === menuId; });
    if (!menu || !menu.items) return;

    // 更新按钮状态
    document.querySelectorAll('.mb-btn').forEach(function(b) {
        b.classList.toggle('open', b.dataset.menuId === menuId);
    });
    openMenuId = menuId;

    // 渲染菜单项
    overlay.innerHTML = '';
    var anyItem = false;

    menu.items.forEach(function(item) {
        if (item.type === 'separator') {
            var sep = document.createElement('div');
            sep.style.cssText = 'height:1px;background:var(--border,rgba(48,54,61,0.6));margin:4px 8px;';
            overlay.appendChild(sep);
            return;
        }
        anyItem = true;
        var el = document.createElement('div');
        el.style.cssText = 'display:flex;align-items:center;justify-content:space-between;padding:6px 16px;font-size:13px;color:' +
            (currentMenuTheme === 'light' ? '#1f2328' : '#e6edf3') +
            ';cursor:pointer;transition:background 0.1s;';

        var leftWrap = document.createElement('span');
        leftWrap.style.cssText = 'display:flex;align-items:center;gap:6px;';

        if (item.type === 'radio') {
            var radio = document.createElement('span');
            radio.style.cssText = 'display:inline-block;width:6px;height:6px;border-radius:50%;margin-right:4px;border:1.5px solid ' +
                (currentMenuTheme === 'light' ? '#656d76' : '#8b949e') + ';flex-shrink:0;';
            var isChecked = false;
            if (item.id === 'theme-dark' && currentMenuTheme === 'dark') isChecked = true;
            if (item.id === 'theme-light' && currentMenuTheme === 'light') isChecked = true;
            if (isChecked) {
                radio.style.borderColor = (currentMenuTheme === 'light' ? '#0969da' : '#388bfd');
                radio.style.background = (currentMenuTheme === 'light' ? '#0969da' : '#388bfd');
            }
            leftWrap.appendChild(radio);
        }

        var labelSpan = document.createElement('span');
        labelSpan.textContent = item.label;
        leftWrap.appendChild(labelSpan);
        el.appendChild(leftWrap);

        if (item.accelerator) {
            var accelSpan = document.createElement('span');
            accelSpan.style.cssText = 'font-size:11px;color:' + (currentMenuTheme === 'light' ? '#656d76' : '#8b949e') + ';margin-left:24px;';
            accelSpan.textContent = item.accelerator;
            el.appendChild(accelSpan);
        }

        el.addEventListener('mouseenter', function() {
            el.style.background = (currentMenuTheme === 'light' ? 'rgba(0,0,0,0.05)' : 'rgba(255,255,255,0.06)');
        });
        el.addEventListener('mouseleave', function() {
            el.style.background = 'transparent';
        });

        el.addEventListener('click', function(e) {
            e.stopPropagation();
            closeMenuOverlay();
            window.electronAPI.agentMenuItemClick(item);
        });

        overlay.appendChild(el);
    });

    if (!anyItem) return;

    // 定位：在按钮下方弹出
    var btnRect = btn.getBoundingClientRect();
    overlay.style.left = Math.max(4, btnRect.left) + 'px';
    overlay.style.top = (btnRect.bottom + 2) + 'px';
    overlay.style.minWidth = '240px';
    overlay.style.display = 'block';
}

function closeMenuOverlay() {
    var overlay = document.getElementById('titlebar-menu-overlay');
    if (overlay) overlay.style.display = 'none';
    document.querySelectorAll('.mb-btn').forEach(function(b) {
        b.classList.remove('open');
    });
    openMenuId = null;
}

// 点击页面其他区域关闭菜单
document.addEventListener('click', function(e) {
    if (openMenuId) closeMenuOverlay();
});

// 主题监听更新
window.electronAPI.onAgentTheme(function(theme) {
    currentMenuTheme = theme;
});

// 页面加载后加载菜单配置
setTimeout(loadMenubarConfig, 200);
