// DeepSeek Local Agent - Electron injected script
(function() {
    'use strict';

    // 防止重复注入
    if (window.__dsagent_injected) return;
    window.__dsagent_injected = true;

    // 引用 engine（agent-engine.js 已加载在同一上下文）
    var E = window.__dsagent_engine;

    // Agent 模式：quick / professional / image（影响策略 prompt 加载）
    window._dsAgentMode = window._dsAgentMode || 'quick';
    window.__dsagent_setMode = function(mode) {
        window._dsAgentMode = mode;
        console.log('[DS Agent] Mode set to:', mode);
    };

    const CONFIG = {
        SEND_DELAY: 300,
        TOAST_DURATION: 5000,
        SERVICE_CHECK_INTERVAL: 30000,
        START_DELAY: 1500,
        ANTI_LOOP: true,
    };

    const SELECTORS = {
        input: 'textarea',
        codeBlock: '.md-code-block, pre',
        messageContainer: '.ds-message, [class*="message"]',
        sendButton: 'div.ds-button--circle:not(.ds-button--disabled)',
        newChatBtn: 'a[href="/"], [aria-label="New Chat"], [class*="new-chat"], [class*="newChat"]',
        fileInput: 'input[type="file"]',
        convList: '[class*="conversation-list"], [class*="chat-list"], [class*="sidebar-list"]',
        convItem: '[class*="conversation-item"], [class*="chat-item"], [class*="sidebar-item"]',
        convTitle: '[class*="conversation-title"], [class*="chat-title"], [class*="sidebar-title"]',
        confirmDeleteBtn: '[class*="confirm"]',
        navToggleBtn: 'button[aria-label="切换导航面板"]',
    };

    // SUPPORTED_LANGS 从工具系统动态获取
    var SUPPORTED_LANGS = [];

    const REFERENCE_LANGS = [
        'javascript', 'js', 'typescript', 'ts', 'python', 'py',
        'bash', 'sh', 'shell', 'cmd', 'bat', 'powershell', 'ps1',
        'java', 'c', 'cpp', 'csharp', 'go', 'rust', 'php', 'ruby',
        'sql', 'json', 'xml', 'html', 'css', 'yaml', 'yml'
    ];

    let enableAutoExec = true;
    let serviceConnected = false;
    let isExecuting = false;
    let stopRequested = false;  // 全局停止请求标记
    let stopTimestamp = 0;     // 停止按钮按下时间戳（用于抑制停止后3秒内的继续生成弹窗）
    let cachedTheme = 'dark';
    let lastUserText = '';       // 用户最后一次发送的消息
    let sendTimestamp = 0;       // 发送时间戳
    let pollTimer = 0;           // 轮询定时器 ID
    let lastProcessedTimestamp = 0; // 最后一次处理完成的时间戳，防重复
    let _asyncRoundCount = 0;      // 异步任务等待轮次计数（控制 DeepSeek 输出 <= 2）
    let _contextCompressSent = false; // 本轮是否已触发上下文压缩提示
    window.__dsagent_pendingAsyncTasks = [];  // 待处理异步任务列表
    window.__dsagent_seenToolDocs = [];       // AI 已查看过文档的工具名列表

var _wasAiGenerating = false;   // 全局：AI 是否正在生成（由 watcher 维护）

    // 安全确认功能已迁移至 agent-engine.js (E.needsConfirmation / E.confirmCommand)

    function escapeHtml(str) {
        return str.replace(/[&<>]/g, function(m) {
            if (m === '&') return '&amp;';
            if (m === '<') return '&lt;';
            if (m === '>') return '&gt;';
            return m;
        });
    }

    function getSendStopBtn() {
        // 优先：ds-button 类名
        var btns = document.querySelectorAll('div.ds-button--primary.ds-button--filled.ds-button--circle');
        for (var i = 0; i < btns.length; i++) {
            var b = btns[i];
            if (b.getAttribute('aria-label')) continue;
            return b;
        }

        // 降级 1: capsule 形状按钮
        var capsule = document.querySelectorAll('div.ds-button--primary.ds-button--filled.ds-button--capsule');
        for (var ci = 0; ci < capsule.length; ci++) {
            var cb = capsule[ci];
            if (cb.getAttribute('aria-label')) continue;
            return cb;
        }

        // 降级 2: 通过 aria-label 查找（发送/停止）
        var labeled = document.querySelectorAll('[aria-label*="发送"], [aria-label*="Send"], [aria-label*="停止"], [aria-label*="Stop"]');
        if (labeled.length > 0) return labeled[0];

        // 降级 3: 通过按钮位置（输入框附近的主色按钮）
        var allBtns = document.querySelectorAll('button, div[role="button"]');
        for (var ab = 0; ab < allBtns.length; ab++) {
            var btn = allBtns[ab];
            var style = window.getComputedStyle(btn);
            // 查找主色按钮（蓝色/紫色）
            if (style.backgroundColor && (style.backgroundColor.includes('56, 139, 253') || style.backgroundColor.includes('137, 87, 229'))) {
                return btn;
            }
        }

        console.warn('[DeepSeek] Send/Stop button not found - DeepSeek UI may have changed');
        return null;
    }

    function isSendBtnEnabled() {
        var btn = getSendStopBtn();
        return btn && !btn.classList.contains('ds-button--disabled');
    }

    function findToggleByLabel(label) {
        // 暴力方案：遍历 DOM 中所有元素，找 textContent 精确包含目标文本的
        var allNodes = document.querySelectorAll('*');
        for (var i = 0; i < allNodes.length; i++) {
            var el = allNodes[i];
            if (!el.textContent) continue;
            var txt = el.textContent.trim();
            if (txt === label) {
                // 精确匹配，向上找可交互的父元素
                var target = el;
                for (var j = 0; j < 5; j++) {
                    if (target.hasAttribute('tabindex') || target.hasAttribute('aria-pressed') || target.getAttribute('role') === 'switch' || target.classList.contains('ds-toggle-button')) {
                        return target;
                    }
                    if (target === document.body) break;
                    target = target.parentElement;
                }
                return el;
            }
        }
        // 降级：包含式匹配
        for (var i = 0; i < allNodes.length; i++) {
            var el = allNodes[i];
            if (!el.textContent) continue;
            if (el.textContent.trim().includes(label) && (el.hasAttribute('tabindex') || el.hasAttribute('aria-pressed'))) {
                return el;
            }
        }
        return null;
    }

    function isToggleActive(el) {
        return el.getAttribute('aria-pressed') === 'true' || el.classList.contains('active');
    }

    function tryToggleWebSearch(enable) {
        try {
            var toggle = findToggleByLabel('联网搜索') || findToggleByLabel('智能搜索') || findToggleByLabel('搜索');
            if (!toggle) return false;
            var active = isToggleActive(toggle);
            if ((enable && !active) || (!enable && active)) {
                toggle.click();
                return true;
            }
            return active;
        } catch(e) { return false; }
    }

    function setDeepThink(enable, maxRetries) {
        if (maxRetries === undefined) maxRetries = 5;
        return new Promise(function(resolve) {
            var attempt = 0;
            function tryToggle() {
                attempt++;
                var toggle = null;
                // 方法1：按 .ds-toggle-button + span 文本查找
                var allToggles = document.querySelectorAll('.ds-toggle-button');
                for (var ti = 0; ti < allToggles.length; ti++) {
                    var t = allToggles[ti];
                    var span = t.querySelector('span');
                    if (span && (span.textContent.includes('深度思考') || span.textContent.includes('Deep Think'))) {
                        toggle = t;
                        break;
                    }
                }
                // 方法2：按 aria-label
                if (!toggle) {
                    toggle = document.querySelector('[aria-label="深度思考"], [aria-label="Deep Think"]');
                }
                // 方法3：fallback 到 findToggleByLabel
                if (!toggle) {
                    toggle = findToggleByLabel('深度思考');
                }
                if (!toggle) {
                    if (attempt < maxRetries) { setTimeout(tryToggle, 500); return; }
                    resolve(false);
                    return;
                }
                var active = isToggleActive(toggle);
                if ((enable && !active) || (!enable && active)) {
                    toggle.click();
                    // 点击后等待验证
                    setTimeout(function() {
                        var newActive = isToggleActive(toggle);
                        if (newActive === enable) { resolve(true); return; }
                        if (attempt < maxRetries) { setTimeout(tryToggle, 500); return; }
                        resolve(false);
                    }, 500);
                } else {
                    resolve(true); // 已经符合预期状态
                }
            }
            tryToggle();
        });
    }

    function waitForToggle(label, timeout) {
        var start = Date.now();
        return new Promise(function(resolve) {
            function poll() {
                var toggle = findToggleByLabel(label);
                if (toggle) { resolve(toggle); return; }
                if (Date.now() - start > timeout) {
                    console.log('[waitForToggle] Timeout: "' + label + '" not found after ' + timeout + 'ms');
                    resolve(null);
                    return;
                }
                setTimeout(poll, 300);
            }
            poll();
        });
    }

    function setModelMode(mode) {
        // mode: 'quick' 或 'professional' 或 'image'
        // targetType 对应 DeepSeek 页面上的 data-model-type 值
        var targetType = mode === 'professional' ? 'expert' : (mode === 'image' ? 'image' : 'quick');
        var labelMap = {
            'professional': { zh: '专家模式', en: ['DeepSeek-Expert', 'DeepSeek', 'Expert'] },
            'quick': { zh: '快速模式', en: ['DeepSeek-Fast', 'Fast', 'Quick'] },
            'image': { zh: '识图模式', en: ['DeepSeek-ImageSupport', 'Image'] }
        };
        var info = labelMap[mode] || labelMap['quick'];
        var labels = [info.zh].concat(info.en);

        // 方法1: data-model-type 属性
        var allRadios = document.querySelectorAll('[data-model-type]');
        for (var ri = 0; ri < allRadios.length; ri++) {
            var r = allRadios[ri];
            if (r.getAttribute('data-model-type') === targetType) {
                if (r.getAttribute('aria-checked') !== 'true') {
                    r.dispatchEvent(new Event('click', { bubbles: true }));
                    return true;
                }
                return false;
            }
        }

        // 方法2: 按文字搜索（中英文）
        for (var li = 0; li < labels.length; li++) {
            var searchText = labels[li];
            var allEls = document.querySelectorAll('span, div, button, a, [role="tab"], [role="radio"]');
            for (var ei = 0; ei < allEls.length; ei++) {
                var el = allEls[ei];
                if (el.textContent && el.textContent.trim() === searchText) {
                    // 检查是否已有 role=tab / radio 的父元素
                    var parent = el;
                    for (var pj = 0; pj < 5; pj++) {
                        if (parent.hasAttribute('data-model-type') || parent.getAttribute('role') === 'tab' || parent.getAttribute('role') === 'radio' || parent.tagName === 'BUTTON' || parent.hasAttribute('aria-selected')) {
                            if (parent.getAttribute('aria-selected') !== 'true' && parent.getAttribute('aria-checked') !== 'true') {
                                parent.dispatchEvent(new Event('click', { bubbles: true }));
                                return true;
                            }
                            return false;
                        }
                        if (parent === document.body) break;
                        parent = parent.parentElement;
                    }
                    // 如果没找到可点击父元素，直接点文本元素本身
                    el.dispatchEvent(new Event('click', { bubbles: true }));
                    return true;
                }
            }
        }

        // 方法3: 通过通用选择器查找模型切换按钮群
        var modelSelectors = [
            '[class*="model-select"]', '[class*="model-tab"]', '[class*="model-btn"]',
            '[class*="ModelSelect"]', '[class*="ModelTab"]',
            '[aria-label*="model" i]', '[aria-label*="切换模型"]'
        ];
        for (var si = 0; si < modelSelectors.length; si++) {
            var container = document.querySelector(modelSelectors[si]);
            if (container) {
                var children = container.querySelectorAll('button, [role="tab"], [role="radio"], [tabindex]');
                for (var ci = 0; ci < children.length; ci++) {
                    var txt = (children[ci].textContent || '').trim().toLowerCase();
                    var matches = labels.some(function(l) { return txt.indexOf(l.toLowerCase()) >= 0; });
                    if (matches) {
                        if (children[ci].getAttribute('aria-selected') !== 'true') {
                            children[ci].dispatchEvent(new Event('click', { bubbles: true }));
                            return true;
                        }
                        return false;
                    }
                }
            }
        }

        return false;
    }
    /** 后台定时任务系统（非阻塞） */

    function makeDraggable(el) {
        var isDragging = false;
        var offsetX, offsetY;

        el.style.cursor = 'move';
        el.addEventListener('mousedown', function(e) {
            if (e.target.tagName === 'BUTTON') return;
            isDragging = true;
            var rect = el.getBoundingClientRect();
            offsetX = e.clientX - rect.left;
            offsetY = e.clientY - rect.top;
            el.style.transition = 'none';
            e.preventDefault();
        });

        document.addEventListener('mousemove', function(e) {
            if (!isDragging) return;
            var x = e.clientX - offsetX;
            var y = e.clientY - offsetY;
            x = Math.max(0, Math.min(window.innerWidth - el.offsetWidth, x));
            y = Math.max(0, Math.min(window.innerHeight - el.offsetHeight, y));
            el.style.left = x + 'px';
            el.style.top = y + 'px';
            el.style.right = 'auto';
            el.style.bottom = 'auto';
        });

        document.addEventListener('mouseup', function() {
            if (isDragging) {
                isDragging = false;
                el.style.transition = '';
            }
        });
    }

    function getInputBox() {
        // 优先：使用配置的选择器
        var el = document.querySelector(SELECTORS.input);
        if (el) return el;

        // 降级 1: 查找所有 textarea
        var textareas = document.querySelectorAll('textarea');
        if (textareas.length === 1) return textareas[0];

        // 降级 2: 查找可见且可编辑的 textarea（输入框通常可见）
        for (var i = 0; i < textareas.length; i++) {
            var ta = textareas[i];
            if (!ta.disabled && !ta.readOnly && ta.offsetParent !== null) {
                return ta;
            }
        }

        // 降级 3: contenteditable 元素
        var editables = document.querySelectorAll('[contenteditable="true"]');
        for (var ei = 0; ei < editables.length; ei++) {
            if (editables[ei].offsetParent !== null) return editables[ei];
        }

        console.warn('[DeepSeek] Input box not found - DeepSeek UI may have changed');
        return null;
    }

    function showToast(msg, duration) {
        // 发送到控制栏状态栏显示，不在 DeepSeek 页面上创建 DOM
        try {
            window.electronAPI.agentNotifyStatus(msg);
        } catch(e) {
            console.warn('[Toast] Failed to notify status:', e.message);
        }
    }

    async function fillAndSend(text) {
        const input = getInputBox();
        if (!input) return false;

        const nativeSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
        if (nativeSetter && input.tagName === 'TEXTAREA') {
            nativeSetter.call(input, text);
        } else {
            input.value = text;
        }
        const tracker = input._valueTracker;
        if (tracker) {
            try {
                tracker.setValue('');
            } catch(e) {
                console.warn('[FillAndSend] Failed to reset value tracker:', e.message);
            }
        }
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        await new Promise(function(r) { setTimeout(r, CONFIG.SEND_DELAY); });

        // 等待发送按钮可用（上传图片/文件时按钮会暂时 disabled）
        var sendBtn = getSendStopBtn();
        if (sendBtn) {
            var waitStart = Date.now();
            while (sendBtn.classList.contains('ds-button--disabled') || sendBtn.disabled) {
                if (Date.now() - waitStart > 120000) break; // 最多等 2 分钟
                await new Promise(function(r) { setTimeout(r, 500); });
                sendBtn = getSendStopBtn();
                if (!sendBtn) break;
            }
            if (sendBtn && !sendBtn.classList.contains('ds-button--disabled') && !sendBtn.disabled) {
                sendBtn.click();
                return true;
            }
        }

        input.focus();
        input.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true
        }));
        return true;
    }

    function extractCode(mdCodeBlock) {
        const pre = mdCodeBlock.querySelector('pre');
        if (pre) return pre.textContent.trim();
        const clone = mdCodeBlock.cloneNode(true);
        const banner = clone.querySelector('.md-code-block-banner');
        if (banner) banner.remove();
        return (clone.textContent || '').replace(/copy|download|复制|下载/g, '').trim();
    }

    function getLanguage(mdCodeBlock) {
        const langSpan = mdCodeBlock.querySelector('[class*="language-"]');
        if (langSpan) {
            const match = langSpan.className.match(/language-(\w+)/);
            if (match) return match[1].toLowerCase();
        }
        const codeElem = mdCodeBlock.querySelector('code');
        if (codeElem && codeElem.className) {
            const match = codeElem.className.match(/language-(\w+)/);
            if (match) return match[1].toLowerCase();
        }
        const textSpan = mdCodeBlock.querySelector('span:first-child');
        if (textSpan) {
            const text = textSpan.textContent.trim().toLowerCase();
            if (text && !text.match(/copy|download|复制|下载/)) return text;
        }
        return '';
    }

    function parseCodeBlock(mdCodeBlock) {
        const lang = getLanguage(mdCodeBlock);
        if (lang === 'skip') return null;
        if (window.__dsagent_tools) {
            if (!window.__dsagent_tools.isSupported(lang)) return null;
        } else {
            if (SUPPORTED_LANGS.indexOf(lang) < 0) return null;
        }
        const content = extractCode(mdCodeBlock);
        if (!content) return null;
        return { lang: lang, content: content };
    }


    // ==================== subreader 已删除（由 subagent 架构替代） ====================

    // 估算页面上当前对话总字符数（用于上下文压缩检查）
    function estimateCurrentContextLength() {
        try {
            var containers = document.querySelectorAll(SELECTORS.messageContainer);
            var total = 0;
            for (var ci = 0; ci < containers.length; ci++) {
                var c = containers[ci];
                if (c.querySelector('.ds-loading') || c.querySelector('[class*="loading"]')) continue;
                total += (c.textContent || '').length;
            }
            return total;
        } catch (e) { return 0; }
    }

    // 添加上下文压缩提示
    async function appendContextCompressPrompt() {
        if (_contextCompressSent) return;
        _contextCompressSent = true;
        try {
            var prompt = await E.buildContextCompressPrompt();
            await fillAndSend(prompt);
        } catch (e) { /* 非关键 */ }
    }


// 删除当前活跃的对话
async function deleteCurrentConversation() {
    var navToggle = document.querySelector(SELECTORS.navToggleBtn);
    if (navToggle) { navToggle.click(); await sleep(500); }
    var convItems = document.querySelectorAll(SELECTORS.convItem);
    if (convItems.length === 0) {
        convItems = document.querySelectorAll('a[href*="/chat"], [class*="conversation-item"], [class*="chat-item"]');
    }
    if (convItems.length > 0) {
        var delBtn = await findDeleteButton(convItems[0]);
        if (delBtn) {
            delBtn.click();
            await sleep(2000);
            var confirmBtn = findConfirmButton();
            if (confirmBtn) { confirmBtn.click(); await sleep(1500); }
        }
    }
}

    async function findNewChatButton() {
        var btn = document.querySelector(SELECTORS.newChatBtn);
        if (btn) return btn;
        // 按文字搜索"开启新对话"按钮
        var allBtns = document.querySelectorAll('button, a, [role="button"], div[tabindex]');
        for (var bi = 0; bi < allBtns.length; bi++) {
            if (allBtns[bi].textContent.trim().includes('开启新对话')) {
                return allBtns[bi];
            }
        }
        var navToggle = document.querySelector(SELECTORS.navToggleBtn);
        if (navToggle) { navToggle.click(); await sleep(500); }
        btn = document.querySelector(SELECTORS.newChatBtn);
        if (btn) return btn;
        allBtns = document.querySelectorAll('button, a, [role="button"], div[tabindex]');
        for (var bi = 0; bi < allBtns.length; bi++) {
            if (allBtns[bi].textContent.trim().includes('开启新对话')) {
                return allBtns[bi];
            }
        }
        return null;
    }

    function resetContextState() {
        window.__dsagent_seenToolDocs = [];
        _contextCompressSent = false;
        window.__dsagent_pendingAsyncTasks = [];
        _asyncRoundCount = 0;
        // 通知主进程停止所有后台定时任务
        try {
            window.electronAPI.intervalStopAll();
        } catch(e) {
            console.warn('[ResetContext] Failed to stop interval tasks:', e.message);
        }
    }

    async function findDeleteButton(convEl) {
        // 1. 找到"..."菜单按钮并点击
        var moreBtn = null;
        var possibleBtns = convEl.querySelectorAll('button, [role="button"], [tabindex]');
        for (var mb = 0; mb < possibleBtns.length; mb++) {
            var b = possibleBtns[mb];
            // 跳过对话链接本身和已有文本的按钮
            if (b.tagName === 'A' || b.getAttribute('href')) continue;
            if (b.textContent.trim() && b.textContent.trim().length > 3) continue;
            // 优先选带 SVG 的小按钮（"..."通常是个 SVG 图标）
            if (b.querySelector('svg')) {
                var rect = b.getBoundingClientRect();
                if (rect.width <= 40 && rect.height <= 40) {
                    moreBtn = b;
                    break;
                }
            }
        }
        if (!moreBtn) return null;

        moreBtn.click();
        await sleep(500);

        // 2. 菜单弹出后，在整个文档中找"删除"选项
        var allItems = document.querySelectorAll('button, [role="button"], [class*="menu-item"], [class*="dropdown-item"], [class*="option"]');
        var best = null;
        for (var bi = 0; bi < allItems.length; bi++) {
            var txt = allItems[bi].textContent.trim();
            if (txt.includes('删除') || txt.includes('Delete')) {
                // 取可见的
                var style = window.getComputedStyle(allItems[bi]);
                if (style.display !== 'none' && style.visibility !== 'hidden' && allItems[bi].offsetParent !== null) {
                    best = allItems[bi];
                    break;
                }
                if (!best) best = allItems[bi];
            }
        }
        return best;
    }

    function findConfirmButton() {
        var btn = document.querySelector(SELECTORS.confirmDeleteBtn);
        if (btn) {
            var style = window.getComputedStyle(btn);
            if (style.display !== 'none' && style.visibility !== 'hidden' && (btn.offsetParent !== null || style.position === 'fixed')) return btn;
        }
        // 只搜 <button> 和 [role="button"]，避免 div[tabindex] 匹配到对话框容器
        var allBtns = document.querySelectorAll('button, [role="button"]');
        // 优先找"删除该对话"/"确认删除"（对话框中的红色确认按钮）
        for (var bi = 0; bi < allBtns.length; bi++) {
            var el = allBtns[bi];
            var txt = el.textContent.trim();
            if (txt.includes('删除该对话') || txt.includes('确认删除')) {
                var style = window.getComputedStyle(el);
                if (style.display !== 'none' && style.visibility !== 'hidden') {
                    return el;
                }
            }
        }
        // 备选：找"确认"/"确定"/"删除"
        for (var bi = 0; bi < allBtns.length; bi++) {
            var el = allBtns[bi];
            var txt = el.textContent.trim();
            if (txt === '确认' || txt === '确定' || txt === 'Confirm' || txt === 'Delete' || txt === '删除') {
                var style = window.getComputedStyle(el);
                if (style.display !== 'none' && style.visibility !== 'hidden') return el;
            }
        }
        return null;
    }

    function sleep(ms) {
        return new Promise(function(r) { setTimeout(r, ms); });
    }

    async function checkPageError() {
        // 扫描页面 DOM 中的错误通知（toast、alert 弹窗、提示条等）
        // "该格式暂不支持" 是以页面通知形式出现的，不在 AI 回复中
        var bodyText = document.body ? (document.body.textContent || document.body.innerText) : '';
        if (bodyText.indexOf('该格式暂不支持') !== -1 || bodyText.indexOf('格式暂不支持') !== -1) {
            return { error: 'format_unsupported', message: 'DeepSeek 不支持该文件格式' };
        }
        if (bodyText.indexOf('未识别到文字') !== -1 || bodyText.indexOf('未能识别到文字') !== -1) {
            return { error: 'no_text_recognized', message: 'DeepSeek 未能从图片中识别出文字' };
        }
        return null;
    }

    async function waitForReady() {
        // 等待按钮从不可按变为可按（灰→蓝），用于文件上传完成
        var start = Date.now();
        var maxWait = 120000;

        while (Date.now() - start < maxWait) {
            if (isSendBtnEnabled()) {
                await sleep(300);
                if (isSendBtnEnabled()) return;
            }
            await sleep(500);
        }
    }

    async function waitForGenerationEnd() {
        // 通过停止方块图标判断生成状态：出现→生成开始，消失→生成结束
        var start = Date.now();
        var maxWait = 120000;

        // 阶段1：等待生成开始（停止方块出现）
        while (Date.now() - start < maxWait) {
            var btn = getSendStopBtn();
            if (btn) {
                var svg = btn.querySelector('svg path');
                var d = svg ? svg.getAttribute('d') || '' : '';
                if (d.indexOf('M2 4.88') >= 0) break;
            }
            await sleep(300);
        }

        // 阶段2：等待生成结束（停止方块消失）
        while (Date.now() - start < maxWait) {
            var btn = getSendStopBtn();
            if (btn) {
                var svg = btn.querySelector('svg path');
                var d = svg ? svg.getAttribute('d') || '' : '';
                if (d.indexOf('M2 4.88') < 0) return;
            }
            await sleep(300);
        }
    }

    // ==================== 完成生成处理（新流程：点击复制按钮 → 读取剪贴板 → 解析 markdown → 执行） ====================
    // DOM 兜底：从页面直接提取最后一条 AI 回复
    function extractLastAssistantResponse() {
        try {
            // DeepSeek 的 AI 回复通常在 .ds-markdown 或 .markdown 元素中
            var markdownEls = document.querySelectorAll('.ds-markdown, .markdown, [class*="markdown"]');
            if (markdownEls.length > 0) {
                return markdownEls[markdownEls.length - 1].innerText || '';
            }
            // 兜底：找最后一个包含代码块的容器
            var codeBlocks = document.querySelectorAll('pre code, .code-block');
            if (codeBlocks.length > 0) {
                var lastBlock = codeBlocks[codeBlocks.length - 1];
                var container = lastBlock.closest('[class*="message"], [class*="bubble"], [class*="response"]');
                if (container) return container.innerText || '';
            }
            return '';
        } catch(e) {
            return '';
        }
    }

    function findCopyButton() {
        // 查找 DeepSeek 回复底部的复制按钮（SVG 为复制图标）
        // 返回最后一个（= 最新消息的）复制按钮
        var buttons = document.querySelectorAll('[role="button"]');
        console.log('[Debug] findCopyButton: total [role="button"] elements=' + buttons.length);
        var last = null;
        for (var i = 0; i < buttons.length; i++) {
            var btn = buttons[i];
            var svgPath = btn.querySelector('svg path');
            if (svgPath) {
                var d = svgPath.getAttribute('d') || '';
                // 复制图标路径特征：以 M6.14929 4.02032 开头
                if (d.indexOf('M6.14929 4.02032') >= 0) {
                    console.log('[Debug] findCopyButton: found candidate at index ' + i + ' d=' + d.substring(0, 50));
                    last = btn;
                }
            }
        }
        console.log('[Debug] findCopyButton: returning ' + (last ? 'FOUND' : 'null'));
        return last;
    }

    function sleepCopyBtn(ms) {
        return new Promise(function(resolve) { setTimeout(resolve, ms); });
    }

    async function waitForCopyButton(timeout) {
        var start = Date.now();
        while (Date.now() - start < timeout) {
            var btn = findCopyButton();
            if (btn) return btn;
            await sleepCopyBtn(50);
        }
        return null;
    }

    // 解析函数已迁移到 tools/tool-parser.js 共享模块
    // 使用 window.__dsagent_parseCommands / window.__dsagent_parseSegments

    var _collectingAsyncResults = false;

    // 检查并收集已完成的异步任务结果
    async function collectAsyncResults() {
        if (_collectingAsyncResults) return [];
        _collectingAsyncResults = true;
        try {
            var tasks = window.__dsagent_pendingAsyncTasks || [];
            var completed = [];
            var remaining = [];
            for (var ti = 0; ti < tasks.length; ti++) {
                var t = tasks[ti];
                try {
                    // 检查 Promise 是否已完成（使用 Promise.race 加超时）
                    var result = await Promise.race([
                        t.promise.then(function(r) { return { done: true, result: r }; }),
                        new Promise(function(resolve) { setTimeout(function() { resolve({ done: false }); }, 100); })
                    ]);
                    if (result.done) {
                        completed.push({ id: t.id, lang: t.lang, result: result.result, desc: t.desc });
                    } else {
                        remaining.push(t);
                    }
                } catch (e) {
                    completed.push({ id: t.id, lang: t.lang, result: '❌ ' + t.desc + ' 失败: ' + (e.message || e), desc: t.desc });
                }
            }
            window.__dsagent_pendingAsyncTasks = remaining;
            return completed;
        } finally {
            _collectingAsyncResults = false;
        }
    }

    async function processCompletedGeneration(copyBtn) {
        if (!enableAutoExec || isExecuting) return;
        // 防重复：1 秒内已处理过的跳过
        if (Date.now() - lastProcessedTimestamp < 1000) return;
        lastProcessedTimestamp = Date.now();
        isExecuting = true;
        stopRequested = false;  // 重置停止标记，新一轮生成开始（仅在非停止状态下进入时重置）

        // 保存剪贴板，操作完成后还原
        var savedClipboard = null;
        try {
            savedClipboard = await window.electronAPI.clipboardSave();
        } catch(e) {
            console.warn('Failed to save clipboard:', e);
        }

        try {
            showToast('检测到输出完成，正在获取内容...');

            // 1. 点击复制按钮
            if (!copyBtn) {
                console.log('[Process] Copy button is null, reporting error to agent view');
                showToast('未找到复制按钮，自动执行失败', 2000);
                try {
                    window.electronAPI.agentForwardResult({ type: 'error', message: '未找到复制按钮，无法获取 AI 回复内容。可能原因是 DeepSeek 页面在后台时按钮未渲染。' });
                } catch(e) {}
                return;
            }
            copyBtn.click();

            // 2. 等待剪贴板更新（带重试）
            await sleep(200);
            var markdown = '';
            for (var retry = 0; retry < 5; retry++) {
                try {
                    markdown = await window.electronAPI.clipboardReadText();
                } catch (e) {
                    console.warn('[Process] clipboard read attempt ' + (retry + 1) + ' failed:', e);
                }
                if (markdown && markdown.length > 10) break;
                // 剪贴板可能还没更新，重试
                await sleep(200);
            }

            // 3. 读取剪贴板中的完整 markdown
            if (!markdown) {
                // 剪贴板方案失败，尝试从 DOM 直接提取
                console.warn('[Process] Clipboard empty after retries, trying DOM fallback');
                markdown = extractLastAssistantResponse();
                if (!markdown) {
                    showToast('剪贴板内容为空', 2000);
                    try {
                        window.electronAPI.agentForwardResult({ type: 'error', message: '剪贴板内容为空，无法获取 AI 回复内容。' });
                    } catch(e2) {}
                    return;
                }
            }

            // 3.5. 尝试从 DOM 提取深度思考/推理内容（如果开启了深度思考）
            // 策略：先在本轮 AI 容器内查找；找不到则全局取最后一个 think 元素（避免取到上一轮）
            var thinkContent = '';
            try {
                var thinkEl = null;
                // 先定位本轮最后一个 AI 消息容器
                var allMsgs = document.querySelectorAll(SELECTORS.messageContainer);
                var lastAiMsgForThink = null;
                for (var mi = allMsgs.length - 1; mi >= 0; mi--) {
                    var tEls = allMsgs[mi].querySelectorAll('.ds-message-content, [class*="markdown"], p');
                    if (tEls.length > 0) { lastAiMsgForThink = allMsgs[mi]; break; }
                }
                // 优先：在本轮 AI 容器内查找 think 元素
                if (lastAiMsgForThink) {
                    thinkEl = lastAiMsgForThink.querySelector('[class*="think-content"], [class*="reasoning"], [class*="thought"], .ds-think, [class*="ThinkContent"], [class*="think"]');
                    if (!thinkEl) {
                        var allDivs = lastAiMsgForThink.querySelectorAll('div');
                        for (var ti = 0; ti < allDivs.length; ti++) {
                            var txt = allDivs[ti].textContent || '';
                            if ((txt.indexOf('深度思考') >= 0 || txt.indexOf('Thinking') >= 0 || txt.indexOf('已深度思考') >= 0) && txt.length > 20) {
                                thinkEl = allDivs[ti];
                                break;
                            }
                        }
                    }
                }
                // 兜底：全局查找所有 think 元素，取最后一个（本轮的）
                if (!thinkEl) {
                    var allThinkEls = document.querySelectorAll('[class*="think-content"], [class*="reasoning"], [class*="thought"], .ds-think, [class*="ThinkContent"], [class*="think"]');
                    if (allThinkEls.length > 0) thinkEl = allThinkEls[allThinkEls.length - 1];
                }
                if (thinkEl) {
                    thinkContent = thinkEl.textContent || '';
                    // 限制长度避免过大
                    if (thinkContent.length > 10000) thinkContent = thinkContent.substring(0, 10000) + '\n...（截断）';
                }
            } catch(e) {
                console.warn('[Process] Failed to extract think content:', e);
            }

            // 4.5. 检测并过滤系统反馈 JSON（工具执行结果返回给 AI 的 JSON）
            // 格式: {"summary": {"total": N, "success": N, "failed": N}, "results": [...]}
            // 防止被误识别为 AI 回复发送到 agentview
            if (/^\s*\{\s*"summary"\s*:/.test(markdown) && /"results"\s*:\s*\[/.test(markdown)) {
                var depth = 0, jsonEnd = -1;
                for (var fi = 0; fi < markdown.length; fi++) {
                    if (markdown[fi] === '{') depth++;
                    else if (markdown[fi] === '}') { depth--; if (depth === 0) { jsonEnd = fi + 1; break; } }
                }
                if (jsonEnd > 0) {
                    markdown = markdown.substring(jsonEnd).trim();
                    if (!markdown) {
                        console.log('[Process] Content is feedback JSON only, skipping');
                        return;
                    }
                }
            }

            // 4a. 频率限制检测：页面包含"发送过于频繁，请稍后重试"
            {
                var bodyText = document.body ? document.body.innerText || '' : '';
                var isRateLimit = bodyText.indexOf('消息发送过于频繁') >= 0 && bodyText.indexOf('请稍后重试') >= 0;
                var isServerBusy = bodyText.indexOf('服务器繁忙') >= 0 && bodyText.indexOf('请稍后再试') >= 0;
                if (isRateLimit || isServerBusy) {
                    var errorType = isRateLimit ? 'ratelimit' : 'serverbusy';
                    showToast(isRateLimit ? '检测到频率限制' : '检测到服务器繁忙', 2000);
                    if (pollTimer) { clearInterval(pollTimer); pollTimer = 0; }
                    var waitSeconds = Math.floor((Date.now() - sendTimestamp) / 1000);
                    var confirmed = await window.electronAPI.agentRateLimitNotify(waitSeconds, errorType);
                    if (confirmed) {
                        clickRetryButton();
                        rateLimitNotified = false;
                        sendTimestamp = Date.now();
                        startPollingFallback();
                    } else {
                        rateLimitNotified = false;
                    }
                    return;
                }
            }

            // 4. 从 markdown 中提取命令和分段（新格式：只支持 <message> / <functioncall> 行首标签）
            var cmdResult = window.__dsagent_parseCommands(markdown);
            var commands = cmdResult.commands || [];
            var parseErrors = cmdResult.errors || [];

            var segResult = window.__dsagent_parseSegments(markdown);
            var segments = segResult.segments || [];
            parseErrors = parseErrors.concat(segResult.errors || []);

            // 4a. 如果有解析错误，立即反馈给 AI
            if (parseErrors.length > 0) {
                var errorFeedback = '<message>⚠️ **标签解析错误**</message>\n\n';
                errorFeedback += '<message>检测到以下问题，请修正后重试：</message>\n\n';
                for (var ei = 0; ei < parseErrors.length; ei++) {
                    errorFeedback += '<message>- ' + parseErrors[ei] + '</message>\n';
                }
                errorFeedback += '\n<message>请确保使用正确的格式：\n';
                errorFeedback += '<tool:exec>{"body": "echo hello"}</tool:exec>\n';
                errorFeedback += '或单行：<tool:exec>{"body": "echo hello"}</tool:exec></message>';
                await fillAndSend(errorFeedback);
                showToast('解析错误已反馈给 AI', 3000);
                return;
            }

            // 4b. 如果有指令，先通知任务开始，再转发解析结果
            if (commands.length > 0) {
                try {
                    window.electronAPI.agentForwardResult({ type: 'tasks-start' });
                } catch (e) { /* ignore */ }
            }

            try {
                if (segments.length > 0) {
                    var responseData = { type: 'response', segments: segments };
                    // 附带深度思考/推理内容
                    if (thinkContent) responseData.thinkContent = thinkContent;
                    window.electronAPI.agentForwardResult(responseData);
                }
            } catch (e) {
                console.warn('Failed to forward to agent view:', e);
            }

            if (commands.length === 0) {
                // 没有命令，但可能有待处理的异步任务结果
                var asyncResults = await collectAsyncResults();
                if (asyncResults.length > 0) {
                    // 有异步任务完成，发送结果给 DeepSeek
                    _asyncRoundCount = 0;
                    var asyncResultsList = asyncResults.map(function(ar) {
                        return { tool: ar.lang, success: true, data: ar.result, async: true };
                    });
                    var asyncFeedback = JSON.stringify({
                        summary: { total: asyncResults.length, success: asyncResults.length, failed: 0, async: true },
                        results: asyncResultsList
                    }, null, 2);
                    await fillAndSend(asyncFeedback);
                    try {
                        window.electronAPI.agentForwardResult({ type: 'tasks-end', stopped: false });
                    } catch (e) { /* ignore */ }
                    showToast('异步任务完成: ' + asyncResults.length, 3000);
                } else if (segments.length === 0) {
                    // 既无命令也无消息框：AI 回复了未格式化内容（纯文本），发送提示引导修正
                    showToast('AI 回复格式不正确，已发送提示', 3000);
                    var formatHint = '<message>⚠️ 未检测到有效的标签格式</message>\n\n';
                    formatHint += '<message>你的回复中未包含可识别的 `<message>` 或 `<tool:xxx>` 标签，请按以下格式重新回复：</message>\n\n';
                    formatHint += '<tool:exec>{"body": "echo 格式测试"}</tool:exec>\n\n';
                    formatHint += '<message>如果只是回复用户消息，请使用 `<message>内容</message>` 包裹。</message>';
                    await fillAndSend(formatHint);
                    // 格式修正提示发送后，通知任务链结束（CLI waiter 依赖此信号）
                    try {
                        window.electronAPI.agentForwardResult({ type: 'tasks-end', stopped: false });
                    } catch (e) { /* ignore */ }
                } else {
                    showToast('未找到可执行的指令', 2000);
                    // 纯文字回复（有 segments 但无工具调用）：通知任务链结束
                    // CLI waiter 依赖 tasks-end 信号 resolve，agentview 依赖它结束 isTaskChainActive 状态
                    try {
                        window.electronAPI.agentForwardResult({ type: 'tasks-end', stopped: false });
                    } catch (e) { /* ignore */ }
                }
                return;
            }

            // 5. 执行命令
            console.log('Found ' + commands.length + ' commands via clipboard');
            showToast('执行 ' + commands.length + ' 个指令...');

            var cmdMap = window.__dsagent_engine.buildCmdMap(document.querySelectorAll('.md-code-block, pre'), getLanguage, extractCode);
            var results = [];

            // 5a. 分类命令（所有命令统一串行执行，并发由 server 层管理）
            var classified = E.classifyCommands(commands);
            var srCommands = classified.sr;       // 旧分类保留兼容
            var qwCommands = classified.qw;
            var normalCommands = classified.normal;

            // 5b. 旧 subreader 命令：降级为普通串行执行
            if (srCommands.length > 0) {
                showToast('命令 ' + srCommands.length + ' 个（串行执行）...');
                for (var si = 0; si < srCommands.length; si++) {
                    var result = await E.execOneCommand(srCommands[si], cmdMap);
                    if (result) { results.push(result); E.forwardResult(result); }
                    if (stopRequested) break;
                    if (si < srCommands.length - 1) await new Promise(function(r) { setTimeout(r, 300); });
                }
            }

            // 5b2. qwen 命令：串行执行（并发由 server-qwen 槽位管理）
            if (qwCommands.length > 0) {
                showToast('qwen 命令 ' + qwCommands.length + ' 个（串行执行）...');
                for (var qi = 0; qi < qwCommands.length; qi++) {
                    var result = await E.execOneCommand(qwCommands[qi], cmdMap);
                    if (result) { results.push(result); E.forwardResult(result); }
                    if (stopRequested) break;
                    if (qi < qwCommands.length - 1) await new Promise(function(r) { setTimeout(r, 300); });
                }
            }

            // 5c. 普通命令串行执行
            for (var i = 0; i < normalCommands.length; i++) {
                var c = normalCommands[i];
                showToast((i + 1 + srCommands.length + qwCommands.length) + '/' + commands.length + ' ' + c.lang + '...');
                var result = await E.execOneCommand(c, cmdMap);
                if (result) {
                    results.push(result);
                    E.forwardResult(result);
                }
                if (stopRequested) {
                    console.log('[Stop] Stop requested, breaking command loop');
                    results.push({ success: true, data: '(后续命令已停止)', meta: { tool: 'stop' } });
                    break;
                }
                if (i < normalCommands.length - 1) await new Promise(function(r) { setTimeout(r, 300); });
            }

            // 如果被停止，不发送反馈，避免触发新一轮生成
            if (stopRequested) {
                console.log('[Stop] Skipping feedback send due to stop request');
                showToast('已停止', 2000);
            } else {
                var successCount = results.filter(function(r) { return r.success; }).length;
                // JSON 格式反馈
                var feedbackObj = {
                    summary: { total: results.length, success: successCount, failed: results.length - successCount },
                    results: results.map(function(r) {
                        return {
                            tool: ((r.meta && r.meta.tool) || 'unknown'),
                            success: r.success,
                            data: r.data,
                            error: r.error
                        };
                    })
                };
                var feedback = JSON.stringify(feedbackObj, null, 2);

                // 检查已启动的异步任务是否完成
                var asyncCompleted = await collectAsyncResults();
                if (asyncCompleted.length > 0) {
                    _asyncRoundCount = 0;
                    var asyncExtras = asyncCompleted.map(function(ar) {
                        return { tool: ar.lang, success: true, data: ar.result, desc: ar.desc };
                    });
                    feedbackObj.results.push.apply(feedbackObj.results, asyncExtras);
                    feedbackObj.summary.total += asyncCompleted.length;
                    feedbackObj.summary.success += asyncCompleted.length;
                    feedback = JSON.stringify(feedbackObj, null, 2);
                }

                // 检查是否有待注入的定时任务结果
                var intervalResults = window.__dsagent_engine.collectPendingIntervalResults();
                if (intervalResults.length > 0) {
                    _asyncRoundCount = 0;
                    intervalResults.forEach(function(ir) {
                        feedbackObj.results.push({
                            tool: 'interval',
                            success: true,
                            data: ir.content,
                            desc: '定时任务: ' + ir.taskName
                        });
                    });
                    feedbackObj.summary.total += intervalResults.length;
                    feedbackObj.summary.success += intervalResults.length;
                    feedback = JSON.stringify(feedbackObj, null, 2);
                }

                // 控制 DeepSeek 输出轮次：待处理异步任务不超过 2 轮
                var pendingAsync = (window.__dsagent_pendingAsyncTasks || []).length;
                if (pendingAsync > 0) {
                    _asyncRoundCount++;
                    if (_asyncRoundCount > 2) {
                        // 超过 2 轮，不再发送反馈，等待异步任务完成
                        _asyncRoundCount = 0;
                        showToast('等待异步任务完成（已等待 ' + pendingAsync + ' 个）...', 3000);
                        // 不发送反馈，等待下一轮自动检测
                        // 但需要通知 agent 视图任务结束
                        try {
                            window.electronAPI.agentForwardResult({ type: 'tasks-end', stopped: false });
                        } catch (e) { /* ignore */ }
                        return;
                    }
                    feedback += '\n\n⏳ 还有 ' + pendingAsync + ' 个异步任务正在后台运行，请继续处理其他任务。';
                } else {
                    _asyncRoundCount = 0;
                }

                // 上下文压缩检查：输入输出总字符数超过阈值时触发
                var contextLen = estimateCurrentContextLength();
                if (contextLen > E._config.contextCompressThreshold && !_contextCompressSent) {
                    feedback += '\n\n[SYSTEM] 当前对话上下文已较大，请在完成本轮后按提示进行历史记忆总结。';
                }

                await fillAndSend(feedback);

                showToast('完成 ' + successCount + '/' + results.length, 3000);

                // 发送反馈后，若上下文超长，追加压缩提示
                if (contextLen > E._config.contextCompressThreshold && !_contextCompressSent) {
                    await sleep(500);
                    await appendContextCompressPrompt();
                }
            }

            // 通知 Agent 视图：所有任务执行完毕（无论是否停止都通知）
            try {
                window.electronAPI.agentForwardResult({ type: 'tasks-end', stopped: stopRequested });
            } catch (e) { /* ignore */ }
        } finally {
            // 还原剪贴板
            if (savedClipboard && savedClipboard.text !== undefined) {
                try {
                    await window.electronAPI.clipboardRestore(savedClipboard.text);
                } catch(e) {
                    console.warn('Failed to restore clipboard:', e);
                }
            }
            isExecuting = false;
        }
    }

    function findContinueButton() {
        // 按层级查找：span.ds-button__content 包含文本"继续生成" → 返回其父 button
        var spans = document.querySelectorAll('span.ds-button__content');
        console.log('[Continue] Found ' + spans.length + ' span.ds-button__content elements');
        for (var i = 0; i < spans.length; i++) {
            var txt = spans[i].textContent.trim();
            console.log('[Continue] span[' + i + '] textContent="' + txt + '"');
            if (txt === '继续生成' || txt === 'Continue') {
                var btn = spans[i].closest('div[role="button"], button');
                console.log('[Continue] Matched! closest button/div=', btn ? btn.tagName + (btn.className ? ' class=' + btn.className : '') : 'null');
                if (btn) return btn;
            }
        }
        // 兜底：直接查所有 div[role="button"] 和 button 的文本
        var allBtns = document.querySelectorAll('div[role="button"], button');
        console.log('[Continue] Fallback: scanning ' + allBtns.length + ' button elements for text match');
        for (var j = 0; j < allBtns.length; j++) {
            var t = allBtns[j].textContent.trim();
            if (t === '继续生成' || t === 'Continue') {
                console.log('[Continue] Fallback found match at index ' + j);
                return allBtns[j];
            }
        }
        console.log('[Continue] Button NOT found by any method');
        return null;
    }

    // 流式预览：记录上次转发的文本，避免重复发送
    var _lastStreamingText = '';

    // 提取 DeepSeek 页面中最新 AI 回复的文本（即使未完成生成）
    function extractStreamingText() {
        var messages = document.querySelectorAll(SELECTORS.messageContainer);
        var lastAiMsg = null;
        for (var mi = messages.length - 1; mi >= 0; mi--) {
            var msg = messages[mi];
            var textEls = msg.querySelectorAll('.ds-message-content, [class*="markdown"], p, [class*="ds-markdown"]');
            if (textEls.length > 0) { lastAiMsg = msg; break; }
        }
        if (lastAiMsg) {
            var textEls = lastAiMsg.querySelectorAll('.ds-message-content, [class*="markdown"], p, [class*="ds-markdown"]');
            var text = '';
            for (var ti = 0; ti < textEls.length; ti++) {
                text += textEls[ti].textContent;
            }
            return text.trim();
        }
        return '';
    }

    // 查找并点击 DeepSeek 页面的"滚动到底部"悬浮按钮
    // 特征：ds-button--floating + role="button" + 向下箭头 SVG
    function clickScrollDownFloatingButton() {
        try {
            var buttons = document.querySelectorAll('div[role="button"].ds-button--floating');
            for (var bi = 0; bi < buttons.length; bi++) {
                var btn = buttons[bi];
                // 确认包含向下箭头 SVG（path 特征：M11.8486 5.5L11.4238...）
                var svgPath = btn.querySelector('svg path');
                if (svgPath && svgPath.getAttribute('d') && svgPath.getAttribute('d').indexOf('M11.8486') >= 0) {
                    btn.click();
                    break;
                }
            }
        } catch(e) {
            // 静默忽略
        }
    }

    function startCompletionWatcher() {
        var wasGenerating = false;
        var _continueHandled = false;  // 防止重复弹出"继续生成"
        // 记录上一次记录的诊断状态，避免重复输出相同日志
        var _lastLogState = 'initial';

        function _logIfChanged(newState, msg) {
            if (_lastLogState !== newState) {
                _lastLogState = newState;
                console.log('[Watcher] ' + msg);
            }
        }

        setInterval(async function() {
            if (!enableAutoExec) {
                _logIfChanged('skip-disabled', 'SKIP: enableAutoExec=false');
                return;
            }
            if (isExecuting) {
                _logIfChanged('skip-executing', 'SKIP: isExecuting=true');
                return;
            }

            var btn = getSendStopBtn();
            if (!btn) {
                _logIfChanged('skip-nobtn', 'SKIP: getSendStopBtn() returned null');
                return;
            }

            var isDisabled = btn.classList.contains('ds-button--disabled') || btn.disabled === true;
            var svgPath = btn.querySelector('svg path');
            var d = svgPath ? svgPath.getAttribute('d') || '' : '';
            var isStopSquare = d.indexOf('M2 4.88') >= 0;

            // 合成当前状态标识
            var curState = isStopSquare ? 'generating' : (isDisabled ? 'done' : 'idle');

            // 状态变化时输出摘要日志
            _logIfChanged(curState, 'State=' + curState +
                ' (disabled=' + isDisabled + ' stopSquare=' + isStopSquare + ' wasGen=' + wasGenerating + ')');

            // 新的生成开始时，重置标记
            if (isStopSquare) {
                _continueHandled = false;

                // 流式预览：提取当前 AI 回复文本，转发到 agentview
                var currentText = extractStreamingText();
                if (currentText && currentText !== _lastStreamingText) {
                    _lastStreamingText = currentText;
                    // 只转发末 ~80 字符
                    var preview = currentText.length > 80 ? '…' + currentText.slice(-80) : currentText;
                    try {
                        window.electronAPI.agentForwardResult({
                            type: 'streaming-preview',
                            text: preview
                        });
                    } catch(e) {}
                }

                // AI 输出中，查找并点击 DeepSeek 页面的"滚动到底部"悬浮按钮
                clickScrollDownFloatingButton();
            } else if (!isStopSquare) {
                // 非生成状态，重置流式文本缓存
                _lastStreamingText = '';
            }

            // 检测生成完成转换
            if (wasGenerating && !isStopSquare && isDisabled) {
                _lastLogState = 'processing'; // 防止后续回到 idle 时重复输出 idle 日志
                console.log('[Watcher] DETECTED: generation completed!');
                if (pollTimer) { clearInterval(pollTimer); pollTimer = 0; }
                var copyBtn = await waitForCopyButton(10000);
                if (copyBtn) {
                    console.log('[Watcher] Found copy button');
                    await sleep(300);
                    if (_continueHandled) {
                        console.log('[Watcher] Continue already handled, skipping');
                        return;
                    }
                    var continueBtn = findContinueButton();
                    if (continueBtn) {
                        console.log('[Watcher] "继续生成" button found');
                        // 停止后 3 秒内不弹继续生成窗，直接走正常处理
                        var withinCooldown = stopTimestamp > 0 && Date.now() - stopTimestamp < 3000;
                        if (withinCooldown) {
                            console.log('[Watcher] Stop was within 3s, suppressing continue popup');
                            _continueHandled = true;  // 防止重复处理
                        } else if (_continueHandled) {
                            console.log('[Watcher] Continue already handled, skipping');
                            return;
                        } else {
                            _continueHandled = true;
                            var continued = await window.electronAPI.notifyContinueGeneration();
                            if (continued) {
                                console.log('[Watcher] User chose to continue generation');
                                wasGenerating = true;
                                _lastLogState = 'generating';
                                return;
                            }
                            console.log('[Watcher] User cancelled continue, proceeding normally');
                            _continueHandled = false;
                        }
                    } else {
                        console.log('[Watcher] Continue button not found');
                    }
                    // 停止后不触发新的处理
                    if (stopRequested) {
                        console.log('[Watcher] Stop requested, skipping processCompletedGeneration');
                        return;
                    }
                    await processCompletedGeneration(copyBtn);
                } else {
                    console.log('[Watcher] Copy button NOT found within 500ms');
                    // Debug: log current DOM state for diagnosis
                    console.log('[Debug] State at skip: isExecuting=' + isExecuting + ' stopRequested=' + stopRequested + ' wasGen=' + wasGenerating + ' isStop=' + isStopSquare + ' disabled=' + isDisabled + ' btnClass=' + (btn ? btn.className : 'null'));
                    // Debug: log all SVG paths in buttons to see what's actually on the page
                    var allBtns2 = document.querySelectorAll('[role="button"] svg path');
                    var paths2 = [];
                    for (var pi2 = 0; pi2 < allBtns2.length && pi2 < 20; pi2++) {
                        var pd2 = allBtns2[pi2].getAttribute('d') || '';
                        paths2.push(pd2.substring(0, 40));
                    }
                    console.log('[Debug] First 20 SVG paths on page:', JSON.stringify(paths2));
                    // 通知 Agent 视图：复制按钮找不到
                    try {
                        window.electronAPI.agentForwardResult({ type: 'error', message: '检测到 AI 已完成回复，但在页面上未找到复制按钮（10 秒超时）。页面可能处于不可见状态导致 SVG 未渲染。' });
                    } catch(e) {}
                }
            } else if (wasGenerating && !isStopSquare && !isDisabled) {
                console.log('[Watcher] Generation interrupted (stop-square gone, button enabled)');
            }

            wasGenerating = isStopSquare;
            _wasAiGenerating = isStopSquare;  // 同步全局标志
        }, 500);
    }

    // ===== 轮询兜底：短消息/主检测遗漏时备用 =====
    function startPollingFallback() {
        if (pollTimer) clearInterval(pollTimer);
        pollTimer = setInterval(async function() {
            if (!enableAutoExec || isExecuting) return;
            var now = Date.now();
            if (now - sendTimestamp < 1000) return; // 前 1s 不检查（防止刚发送时误判）
            if (now - sendTimestamp > 60000) { clearInterval(pollTimer); pollTimer = 0; return; } // 超过 60s 停止

            var btn = getSendStopBtn();
            if (!btn) return;
            var isDisabled = btn.classList.contains('ds-button--disabled') || btn.disabled === true;
            var svgPath = btn.querySelector('svg path');
            var d = svgPath ? svgPath.getAttribute('d') || '' : '';
            var isStopSquare = d.indexOf('M2 4.88') >= 0;

            // 如果按钮已禁用且不是停止状态 → 可能已完成
            if (isDisabled && !isStopSquare) {
                 console.log('[Fallback#' + Math.floor((now - sendTimestamp)/1000) + 's] Detected: disabled + sendIcon, checking copy button...');
                 var copyBtn = await waitForCopyButton(5000);
                 if (copyBtn) {
                     console.log('[Fallback] Found copy button, processing...');
                     // 如果最近已处理过，跳过（防止与主检测重复）
                     if (Date.now() - lastProcessedTimestamp < 1000) return;
                     if (stopRequested) { console.log('[Fallback] Stop requested, skipping'); return; }
                     clearInterval(pollTimer); pollTimer = 0;
                     await processCompletedGeneration(copyBtn);
                } else {
                    console.log('[Fallback] Copy button not found within 200ms');
                }
            }
            // 检测"消息发送过于频繁"
            checkRateLimit(now);
        }, 3000);
    }

    // ===== 频率限制/服务器繁忙检测 =====
    var rateLimitNotified = false;
    async function checkRateLimit(now) {
        if (rateLimitNotified) return;
        try {
            // 直接检测页面上是否有频率限制/服务器繁忙提示
            var bodyText = document.body ? document.body.innerText || '' : '';
            var isRateLimit = bodyText.indexOf('消息发送过于频繁') >= 0 && bodyText.indexOf('请稍后重试') >= 0;
            var isServerBusy = bodyText.indexOf('服务器繁忙') >= 0 && bodyText.indexOf('请稍后再试') >= 0;
            if (!isRateLimit && !isServerBusy) return;

            rateLimitNotified = true;
            if (pollTimer) { clearInterval(pollTimer); pollTimer = 0; }

            // 通知 agentview 显示弹窗（传递错误类型）
            var waitSeconds = Math.floor((now - sendTimestamp) / 1000);
            var errorType = isRateLimit ? 'ratelimit' : 'serverbusy';
            var confirmed = await window.electronAPI.agentRateLimitNotify(waitSeconds, errorType);
            if (confirmed) {
                // 点击重试按钮
                clickRetryButton();
                // 重置状态，继续检测
                rateLimitNotified = false;
                sendTimestamp = Date.now();
                startPollingFallback();
            }
        } catch(e) { /* ignore */ }
    }

    function clickRetryButton() {
        // 查找 DeepSeek 的重试按钮（根据用户提供的 SVG path 特征）
        var btns = document.querySelectorAll('div[role="button"].ds-button--warning');
        for (var bi = 0; bi < btns.length; bi++) {
            var b = btns[bi];
            var svg = b.querySelector('svg path');
            if (svg) {
                var pd = svg.getAttribute('d') || '';
                if (pd.indexOf('M1.272 6.21348') >= 0) {
                    console.log('[RateLimit] Clicking retry button');
                    b.click();
                    return;
                }
            }
        }
        // 兜底：找任何 ds-button--warning
        var fallback = document.querySelector('div[role="button"].ds-button--warning');
        if (fallback) { fallback.click(); console.log('[RateLimit] Clicked fallback retry button'); }
    }

    async function checkService() {
        try {
            await window.electronAPI.agentPing();
            serviceConnected = true;
            console.log('Local service connected');
        } catch (e) {
            serviceConnected = false;
            console.warn('Local service not available');
        }
    }

    async function init() {
        // 从 engine 加载安全配置
        await E.loadConfig();

        // ======== 暴露工具函数给工具系统 ========
        window.__dsagent_fillAndSend = fillAndSend;
        window.__dsagent_isGenerating = function() { return _wasAiGenerating; };
        window.__dsagent_isExecuting = function() { return isExecuting; };
        window.__dsagent_confirmCommand = E.confirmCommand;

        // ======== 初始化工具系统 ========
        if (window.__dsagent_tools && window.__dsagent_tools.init) {
            window.__dsagent_tools.init({ utils: true });
            // 从工具系统获取所有支持的语言列表，并加入统一入口 `local`
            SUPPORTED_LANGS = window.__dsagent_tools.getAllLangs();
            if (SUPPORTED_LANGS.indexOf('local') === -1) {
                SUPPORTED_LANGS.push('local');
            }
        }

        // 暴露控制接口给主进程
        window.__dsagent_setAutoExec = function(enabled) {
            enableAutoExec = enabled;
        };
        window.__dsagent_setConfirmMode = function(mode, skipSave) {
            E._config.confirmMode = mode;
            if (skipSave) return;
            E.saveConfirmMode(mode);
        };
        window.__dsagent_showIntro = async function() {
            var apiDoc = (await window.__dsagent_getInitPromptText())
                + '\n\n## 初次使用\n\n'
                + '请先发送测试指令确认连接：\n\n'
                + '<tool:exec>{"body": "echo \\"本地服务连接测试成功\\""}</tool:exec>';

            var input = getInputBox();
            if (input) {
                var nativeSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
                if (nativeSetter && input.tagName === 'TEXTAREA') {
                    nativeSetter.call(input, apiDoc);
                } else {
                    input.value = apiDoc;
                }
                input.dispatchEvent(new Event('input', { bubbles: true }));
                input.focus();
                // 自动发送
                setTimeout(function() {
                    var sendBtn = getSendStopBtn();
                    if (sendBtn && !sendBtn.classList.contains('ds-button--disabled')) {
                        sendBtn.click();
                    }
                }, 500);
            }
        };
        window.__dsagent_fillInput = function(text) {
            var input = getInputBox();
            if (input) {
                var nativeSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
                if (nativeSetter && input.tagName === 'TEXTAREA') {
                    nativeSetter.call(input, text);
                } else {
                    input.value = text;
                }
                input.dispatchEvent(new Event('input', { bubbles: true }));
                input.focus();
            }
        };
        window.__dsagent_stopGeneration = function() {
            stopRequested = true;
            stopTimestamp = Date.now();  // 记录停止时间，抑制后续继续生成弹窗
            var btn = getSendStopBtn();
            if (btn) {
                // 检查按钮是否处于停止模式（SVG 路径含正方形图标）
                var svgPath = btn.querySelector('svg path');
                var d = svgPath ? svgPath.getAttribute('d') || '' : '';
                if (d.indexOf('M2 4.88') >= 0) {
                    btn.click();
                    return { success: true, message: 'Stop button clicked' };
                }
                return { success: false, message: 'Not in generating state' };
            }
            return { success: false, message: 'Stop button not found' };
        };

        window.__dsagent_setStopRequested = function(v) {
            stopRequested = !!v;
            if (v) stopTimestamp = Date.now();  // 同步记录停止时间
        };
        // 表单响应处理（从 Agent 视图或 QQ Bot 提交）
        window.__dsagent_formResponse = async function(data) {
            console.log('[Form] Received form response:', JSON.stringify(data));
            var answers = data.answers || {};
            var title = data.title || '表单';
            var feedback = '📋 **表单回复**: ' + title + '\n\n';
            var keys = Object.keys(answers);
            for (var ki = 0; ki < keys.length; ki++) {
                feedback += '**' + keys[ki] + '**: ' + answers[keys[ki]] + '\n';
            }
            await fillAndSend(feedback);
        };
        // Agent 视图控制函数
        window.__dsagent_setModelMode = function(mode) {
            // agentview mode 值 (expert/fast/image) → setModelMode 期望的值 (professional/quick/image)
            var dsMode = mode === 'expert' ? 'professional' : (mode === 'image' ? 'image' : 'quick');
            setModelMode(dsMode);
        };
        window.__dsagent_setDeepThink = async function(enable) { return await setDeepThink(!!enable); };
        window.__dsagent_disableWebSearch = function() { tryToggleWebSearch(false); };
        window.__dsagent_enableWebSearch = function() { tryToggleWebSearch(true); };
        window.__dsagent_sendMessage = async function(text) {
            // P3: 模型微调指令（DeepSeek → 中文输出锁定）
            var directives = '';
            /* 模型级指令由 prompt-builder 注入到 INSTRUCTION 中，此处为兜底 */
            // per-turn <system-reminder>（对齐 AtomCode，注入日期/时间/轮次）
            var now = new Date();
            var dateStr = now.toISOString().split('T')[0];
            var timeStr = now.toTimeString().split(' ')[0];
            // 递增轮次计数
            var turnCount = (window.__dsagent_turnCount || 0) + 1;
            window.__dsagent_turnCount = turnCount;
            var systemReminder = '\n\n<system-reminder>\n'
                + 'Current date: ' + dateStr + ', local time ' + timeStr + '\n'
                + 'Turn round: ' + turnCount + '\n'
                + '</system-reminder>';
            // 每轮追加压缩行为指令（防止长对话后首条 instruction 被压缩遗忘）
            var behaviorReminder = '\n\n【行为规则】\n'
                + '- 直接行动，不啰嗦\n'
                + '- 用 `read` 读文件（非 exec cat），用 `save`/`edit` 改文件（非 exec sed/echo）\n'
                + '- 并行：不依赖的操作一次完成\n'
                + '- 贯穿到底：明确后完整执行，不问"要继续吗"\n'
                + '- 先读再改：不修改未读过的文件\n'
                + '- 有证据才说完成\n'
                + '- 不做范围外改进\n'
                + '- 技术正确性优先\n'
                + '- 出错先读输出、分析根因，不重试已失败的\n'
                + '- 危险操作先问用户';
            lastUserText = text;
            sendTimestamp = Date.now();
            rateLimitNotified = false;
            // 将 system-reminder 追加到用户消息末尾发送给 LLM
            var fullText = text + systemReminder + behaviorReminder;
            // 保存压缩后状态（TASK + 操作记录），由 orchestrator 在压缩后注入
            window.__dsagent_lastTask = text.substring(0, 200); // 保存当前任务片段
            var result = await fillAndSend(fullText);
            // 发送后启动轮询兜底
            startPollingFallback();
            return result;
        };
        // 删除指定 DeepSeek 对话（convid 可选，不传则删当前活跃对话）
        window.__dsagent_deleteConversation = async function(convid) {
            // 确保侧边栏展开（多种选择器兜底）
            var navToggle = document.querySelector(SELECTORS.navToggleBtn)
                || document.querySelector('button[class*="nav"], [class*="sidebar-toggle"], [class*="menu-toggle"]');
            if (navToggle) {
                var isExpanded = navToggle.getAttribute('aria-expanded');
                if (isExpanded !== 'true') { navToggle.click(); await sleep(600); }
            }
            // 查找对话列表
            var convItems = document.querySelectorAll(SELECTORS.convItem);
            if (convItems.length === 0) {
                convItems = document.querySelectorAll('a[href*="/chat"], [class*="conversation-item"], [class*="chat-item"]');
            }
            // 如果还是没找到，等一会儿重试一次（SPA 可能还没渲染完）
            if (convItems.length === 0) {
                await sleep(2000);
                convItems = document.querySelectorAll(SELECTORS.convItem);
                if (convItems.length === 0) {
                    convItems = document.querySelectorAll('a[href*="/chat"], [class*="conversation-item"], [class*="chat-item"]');
                }
            }
            // 找目标对话
             var targetConv = null;
             for (var dci = 0; dci < convItems.length; dci++) {
                 var item = convItems[dci];
                 // 如果有 convid，按 href 匹配（优先精确匹配）
                 if (convid) {
                     var href = item.getAttribute('href') || '';
                     if (href.indexOf(convid) !== -1) {
                         targetConv = item; break;
                     }
                 } else {
                     // 否则取高亮/活跃的
                     if (item.classList.contains('active') || item.getAttribute('aria-current') === 'page') {
                         targetConv = item; break;
                     }
                 }
             }
             if (!targetConv) return { success: false, error: 'No conversation found in sidebar' };
            var delBtn = await findDeleteButton(targetConv);
            if (!delBtn) return { success: false, error: 'Delete button not found' };
            delBtn.click();
            await sleep(2000);
            var confirmBtn = findConfirmButton();
            if (!confirmBtn) return { success: false, error: 'Confirm button not found' };
            confirmBtn.click();
            await sleep(1500);
            return { success: true };
        };
        window.__dsagent_getInitPromptText = async function(mode) {
            var baseText = '';
            try {
                var res = await window.electronAPI.getInitPrompt(mode || window._dsAgentMode || 'quick');
                if (res.success && res.text) baseText = res.text;
            } catch (e) {
                console.warn('Failed to load prompt file:', e);
            }
            if (!baseText) {
                baseText = '# 本地执行助手\n\n你是一个能通过本机接口执行命令、读写文件的助手。\n使用 `exec`、`read` 等工具执行操作。\n详细指令见 `prompt/` 文件夹。';
            }
            // 动态追加工具列表（从工具系统自动生成）
            if (window.__dsagent_tools) {
                var allTools = window.__dsagent_tools.getAll();
                var currentToolNames = allTools.map(function(t) {
                    return Array.isArray(t.name) ? t.name[0] : t.name;
                });

                // 工具变更检测：对比上次已知的工具列表
                var savedKnownTools = [];
                try {
                    var saved = localStorage.getItem('__dsagent_knownTools');
                    if (saved) savedKnownTools = JSON.parse(saved);
                } catch(e) {}
                var newTools = currentToolNames.filter(function(n) { return savedKnownTools.indexOf(n) === -1; });

                // 保存当前工具列表（供下次对比）
                try {
                    localStorage.setItem('__dsagent_knownTools', JSON.stringify(currentToolNames));
                } catch(e) {}

                baseText += '\n\n## 可用工具一览\n\n';
                if (newTools.length > 0) {
                    baseText += '> ⚡ 以下工具可免费使用！\n\n';
                }
                baseText += '> 每个工具的详细参数和使用方法请使用 `help` 查询。\n\n';
                baseText += '| 命令 | 适用场景 |\n';
                baseText += '|------|----------|\n';
                for (var ti = 0; ti < allTools.length; ti++) {
                    var t = allTools[ti];
                    var names = Array.isArray(t.name) ? t.name : [t.name];
                    var nameStr = names.map(function(n) { return '`' + n + '`'; }).join(' / ');
                    var isNew = newTools.indexOf(names[0]) !== -1;
                    baseText += '| ' + (isNew ? '🆕 ' : '') + nameStr + ' | ' + (t.scope || t.description || '') + ' |\n';
                }
                baseText += '\n> 如有疑问，使用 `help` 获取完整文档。';
            }
            return baseText;
        };
        window.__dsagent_newChatAndSendInit = async function(mode, deepthink, userText, enableWebSearch) {
            // 新对话：清空上下文相关状态
            resetContextState();
            // 新对话：清空工具文档阅读记录
            if (window.__dsagent_tools && window.__dsagent_tools.clearReadHistory) {
                window.__dsagent_tools.clearReadHistory();
            }

            // 先创建新对话再设模式（原顺序：在对话页面上设模式才生效）
            var newChatBtn = await findNewChatButton();
            if (!newChatBtn) throw new Error('找不到新建对话按钮');
            newChatBtn.click();

            // 等待新页面加载完成
            var ta = null;
            for (var retry = 0; retry < 30; retry++) {
                ta = document.querySelector('textarea');
                if (ta) break;
                await sleep(300);
            }
            if (!ta) throw new Error('新对话加载超时');
            ta.focus();
            await sleep(600);

            // 设置模式（在对话页面上操作）
            setModelMode(mode === 'expert' ? 'professional' : (mode === 'image' ? 'image' : 'quick'));
            await sleep(800);

            // 设置深度思考
            if (mode === 'image') {
                await setDeepThink(false);
            } else {
                await setDeepThink(!!deepthink);
            }
            await sleep(300);

            // 设置联网搜索
            tryToggleWebSearch(!!enableWebSearch);
            await sleep(400);

            // 发送初始化提示词
            var initText = await window.__dsagent_getInitPromptText(mode);

            // 是否有用户消息（带附件/技能/INSTRUCTION.md 的完整文本）
            if (userText && userText.trim()) {
                // 有用户消息：直接追加到初始化消息后面（userText 已包含【基本指令】【用户消息】结构）
                initText += '\n\n' + userText.trim() + '\n\n';
                initText += '以上是用户发送的消息。请基于已加载的策略和工具，直接处理用户请求，无需等待。';
            } else {
                // 无用户消息（纯初始化）：要求 AI 先输出就绪消息
                initText += '\n\n## 首次启动指令\n\n';
                initText += '你现在已加载所有工具和指令。**请先不要执行任何操作**，只需输出一个就绪确认：\n\n';
                initText += '<message>✅ 就绪，请输入你的需求</message>\n\n';
                initText += '等待用户输入具体需求后，再按照上述指令格式执行。';
            }

            sendTimestamp = Date.now();  // 标记发送时间，启用兜底轮询保底
            await fillAndSend(initText);

            // 获取新对话的 URL（用于历史追踪）
            var newUrl = '';
            try { newUrl = window.location.href; } catch(e) {}
            // 等待一小段时间确保 URL 更新（SPA 导航可能有延迟）
            if (!newUrl || !/\/chat\/[^?#]+/.test(newUrl)) {
                await sleep(1500);
                try { newUrl = window.location.href; } catch(e) {}
            }

            return { success: true, messageIncluded: !!(userText && userText.trim()), deepseekUrl: newUrl || '' };
        };

        // ==================== 主题检测 ====================
        function detectTheme() {
            try {
                var html = document.documentElement;
                var themeAttr = html.getAttribute('data-theme');
                if (themeAttr === 'dark' || themeAttr === 'light') return themeAttr;
                var cls = html.className;
                if (cls.indexOf('dark') !== -1) return 'dark';
                if (cls.indexOf('light') !== -1) return 'light';
                var bg = getComputedStyle(document.body).backgroundColor;
                var rgb = bg.match(/\d+/g);
                if (rgb && rgb.length >= 3) {
                    var avg = (parseInt(rgb[0]) + parseInt(rgb[1]) + parseInt(rgb[2])) / 3;
                    return avg < 128 ? 'dark' : 'light';
                }
                return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
            } catch(e) { return 'dark'; }
        }

        function getTheme() {
            var theme = detectTheme();
            if (cachedTheme !== theme) {
                cachedTheme = theme;
                try {
                    window.electronAPI.sendTheme && window.electronAPI.sendTheme(theme);
                } catch(e) {}
            }
            return theme;
        }

        cachedTheme = detectTheme();

        window.__dsagent_getStatus = function() {
            var btn = getSendStopBtn();
            var raw = 'no-button';
            if (btn) {
                var isDisabled = btn.classList.contains('ds-button--disabled') || btn.disabled;
                if (isDisabled) {
                    raw = 'disabled-arrow';
                } else {
                    var svgPath = btn.querySelector('svg path');
                    var d = svgPath ? svgPath.getAttribute('d') || '' : '';
                    raw = d.indexOf('M2 4.88') >= 0 ? 'stop-square' : 'enabled-arrow';
                }
            }
            // 从原始外观+前一个状态推导 buttonState
            var prev = window.__ds_prevRaw || 'no-button';
            var buttonState;
            switch (raw) {
                case 'disabled-arrow':
                    buttonState = (prev === 'stop-square') ? 'done' : (prev === 'enabled-arrow') ? 'sending' : 'no-input';
                    break;
                case 'enabled-arrow':
                    buttonState = 'ready';
                    break;
                case 'stop-square':
                    buttonState = 'generating';
                    break;
                default:
                    buttonState = 'no-input';
            }
            window.__ds_prevRaw = raw;
            return { connected: serviceConnected, confirmMode: E._config.confirmMode, buttonState: buttonState, theme: getTheme() };
        };

        setTimeout(async function() {
            startCompletionWatcher();
            // ===== 精简版 DOM 诊断：每 3 秒检查一次消息数量变化 =====
            var _lastMsgCount = 0;
            var _domDiagTimer = setInterval(function() {
                if (!enableAutoExec || isExecuting) return;
                var msgs = document.querySelectorAll('.ds-message, [class*="message"]');
                if (msgs.length === _lastMsgCount) return; // 数量没变，跳过
                var prevCount = _lastMsgCount;
                _lastMsgCount = msgs.length;
                var btn = getSendStopBtn();
                var btnState = 'null';
                if (btn) {
                    var dis = btn.classList.contains('ds-button--disabled') || btn.disabled;
                    var sp = btn.querySelector('svg path');
                    var d2 = sp ? sp.getAttribute('d') || '' : '';
                    btnState = (dis ? 'disabled-' : '') + (d2.indexOf('M2 4.88') >= 0 ? 'stop' : 'arrow');
                }
                var hasContinue = !!findContinueButton();
                console.log('[DOMDiag] messages=' + prevCount + '->' + msgs.length +
                    ' btn=' + btnState +
                    ' continueBtn=' + hasContinue);
            }, 3000);

            // ===== 异步任务兜底：任务完成后若 DeepSeek 空闲，主动触发结果返回 =====
            setInterval(async function() {
                if (!enableAutoExec || isExecuting) return;
                if ((window.__dsagent_pendingAsyncTasks || []).length === 0) return;
                var completed = await collectAsyncResults();
                if (completed.length === 0) return;
                // 只在 DeepSeek 真正空闲且输入框为空时主动发送（避免覆盖用户正在输入的内容）
                var btn = getSendStopBtn();
                if (!btn) return;
                var disabled = btn.classList.contains('ds-button--disabled') || btn.disabled;
                var svg = btn.querySelector('svg path');
                var d = svg ? svg.getAttribute('d') || '' : '';
                if (d.indexOf('M2 4.88') >= 0) return; // 正在生成，不打扰
                if (!disabled) return; // 输入框有内容，可能是用户在打字，不覆盖
                _asyncRoundCount = 0;
                var feedback = JSON.stringify({
                    summary: { total: completed.length, success: completed.length, failed: 0, async: true },
                    results: completed.map(function(ar) {
                        return { tool: ar.lang, success: true, data: ar.result };
                    })
                }, null, 2);
                await fillAndSend(feedback);
                try {
                    window.electronAPI.agentForwardResult({ type: 'tasks-end', stopped: false });
                } catch (e) { /* ignore */ }
                showToast('异步任务完成: ' + completed.length, 3000);
            }, 3000);

            await checkService();
            setInterval(checkService, CONFIG.SERVICE_CHECK_INTERVAL);
            console.log('DeepSeek Local Agent (Electron) started');
        }, CONFIG.START_DELAY);
    }

    // ==================== 对话列表查询（供 QQ Bot /list 使用） ====================
    window.__dsagent_listConversations = function() {
        // 收集侧边栏中所有对话条目及其标题
        var items = document.querySelectorAll('a[href*="/chat"], [class*="conversation-item"], [class*="chat-item"], [class*="sidebar-item"]');
        var results = [];
        var seen = new Set();
        for (var i = 0; i < items.length; i++) {
            var el = items[i];
            // 过滤隐藏元素
            if (el.offsetParent === null && window.getComputedStyle(el).position !== 'fixed') continue;
            var titleEl = el.querySelector('[class*="title"], [class*="name"]') || el;
            var title = (titleEl.textContent || '').trim();
            // 跳过空标题和重复项
            if (!title || title.length === 0) continue;
            if (seen.has(title)) continue;
            seen.add(title);
            var href = el.getAttribute('href') || '';
            results.push({ title: title, href: href });
        }
        return results;
    };

    // ==================== 切换对话（供 QQ Bot /switch 使用） ====================
    window.__dsagent_switchToConversation = function(index) {
        var items = document.querySelectorAll('a[href*="/chat"], [class*="conversation-item"], [class*="chat-item"], [class*="sidebar-item"]');
        var visible = [];
        for (var i = 0; i < items.length; i++) {
            if (items[i].offsetParent !== null || window.getComputedStyle(items[i]).position === 'fixed') {
                var titleEl = items[i].querySelector('[class*="title"], [class*="name"]') || items[i];
                var title = (titleEl.textContent || '').trim();
                if (title) visible.push(items[i]);
            }
        }
        if (index < 0 || index >= visible.length) return { success: false, error: '索引超出范围（0-' + (visible.length - 1) + '）' };
        visible[index].click();
        return { success: true, title: (visible[index].textContent || '').trim() };
    };

    // ======== 对话健康检查：VPN 切换时 DeepSeek 可能丢失会话显示"对话不存在"，自动恢复 ========
    var _lastRecoveryTime = 0;
    setInterval(function() {
        if (!document.body) return;
        var bodyText = document.body.innerText || '';
        if (bodyText.indexOf('对话不存在') >= 0 || bodyText.indexOf('该对话不存在') >= 0) {
            var now = Date.now();
            if (now - _lastRecoveryTime < 30000) return; // 30 秒内不重复恢复
            _lastRecoveryTime = now;
            console.log('[DS] 检测到对话不存在，自动跳转到主页...');
            window.location.href = 'https://chat.deepseek.com/';
        }
    }, 5000); // 每 5 秒检测一次

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

    // ==================== Server 层所需接口（供 server-deepseek.js 通过 executeJavaScript 调用） ====================

    // 提取最后一条 AI 回复 + 深度思考内容（结构化返回）
    window.__dsagent_extractLastResponse = async function() {
        try {
            var markdown = '';
            var think = '';

            // ── 1. 提取 markdown：点击复制按钮 → 读剪贴板 ──
            var copyBtn = findCopyButton();
            if (copyBtn) {
                // 保存当前剪贴板
                var savedClipboard = null;
                try { savedClipboard = await window.electronAPI.clipboardSave(); } catch(e) {}
                try {
                    copyBtn.click();
                    // 等待剪贴板更新（最多 3 秒）
                    for (var ri = 0; ri < 15; ri++) {
                        await new Promise(function(r) { setTimeout(r, 200); });
                        try {
                            var txt = await window.electronAPI.clipboardReadText();
                            if (txt && txt.length > 5) { markdown = txt; break; }
                        } catch(e) {}
                    }
                } catch(e) { /* clipboard 失败则降级到 DOM */ }
                // 还原剪贴板
                if (savedClipboard && savedClipboard.text !== undefined) {
                    try { await window.electronAPI.clipboardRestore(savedClipboard.text); } catch(e) {}
                }
            }
            // 剪贴板失败时 DOM 兜底
            if (!markdown) {
                var messages = document.querySelectorAll(SELECTORS.messageContainer);
                var lastAiMsg = null;
                for (var mi = messages.length - 1; mi >= 0; mi--) {
                    var msg = messages[mi];
                    var textEls = msg.querySelectorAll('.ds-message-content, [class*="markdown"], p');
                    if (textEls.length > 0) { lastAiMsg = msg; break; }
                }
                if (lastAiMsg) {
                    var textEls = lastAiMsg.querySelectorAll('.ds-message-content, [class*="markdown"], p');
                    for (var ti = 0; ti < textEls.length; ti++) {
                        markdown += textEls[ti].textContent + '\n';
                    }
                }
            }

            // ── 2. 提取深度思考内容（DOM 提取即可） ──
            var messages = document.querySelectorAll(SELECTORS.messageContainer);
            var lastAiMsg = null;
            for (var mi = messages.length - 1; mi >= 0; mi--) {
                var msg = messages[mi];
                var textEls = msg.querySelectorAll('.ds-message-content, [class*="markdown"], p');
                if (textEls.length > 0) { lastAiMsg = msg; break; }
            }
            if (lastAiMsg) {
                var thinkEl = lastAiMsg.querySelector('[class*="think-content"], [class*="reasoning"], [class*="thought"], .ds-think, [class*="ThinkContent"], [class*="think"]');
                if (!thinkEl) {
                    var allDivs = lastAiMsg.querySelectorAll('div');
                    for (var di = 0; di < allDivs.length; di++) {
                        var txt = allDivs[di].textContent || '';
                        if ((txt.indexOf('深度思考') >= 0 || txt.indexOf('Thinking') >= 0 || txt.indexOf('已深度思考') >= 0) && txt.length > 20) {
                            thinkEl = allDivs[di]; break;
                        }
                    }
                }
                if (!thinkEl) {
                    var allThinkEls = document.querySelectorAll('[class*="think-content"], [class*="reasoning"], [class*="thought"], .ds-think, [class*="ThinkContent"], [class*="think"]');
                    if (allThinkEls.length > 0) thinkEl = allThinkEls[allThinkEls.length - 1];
                }
                if (thinkEl) {
                    think = thinkEl.textContent || '';
                    if (think.length > 10000) think = think.substring(0, 10000) + '\n...（截断）';
                }
            }

            return { markdown: markdown.trim(), think: think.trim() };
        } catch (e) {
            return { markdown: '', think: '', error: e.message };
        }
    };

    // 上传文件到当前对话（由 server-deepseek.js 调用，files 为 [{name, mime, data(base64)}]）
    // 注意：此函数在 inject 上下文执行，需将 base64 还原为 File 对象
    window.__dsagent_uploadFiles = async function(files) {
        try {
            var fileInput = document.querySelector(SELECTORS.fileInput);
            if (!fileInput) return { success: false, error: '找不到文件上传输入框' };

            var dt = new DataTransfer();
            for (var fi = 0; fi < files.length; fi++) {
                var f = files[fi];
                var binaryString = window.atob(f.data);
                var bytes = new Uint8Array(binaryString.length);
                for (var i = 0; i < binaryString.length; i++) {
                    bytes[i] = binaryString.charCodeAt(i);
                }
                var blob = new Blob([bytes], { type: f.mime || 'application/octet-stream' });
                var file = new File([blob], f.name, { type: f.mime || 'application/octet-stream' });
                dt.items.add(file);
            }
            fileInput.files = dt.files;
            fileInput.dispatchEvent(new Event('change', { bubbles: true }));
            await waitForReady();
            return { success: true };
        } catch (e) {
            return { success: false, error: e.message };
        }
    };

    // ==================== 统一 invoke 协议（供 server-deepseek.js 调用） ====================
    window.__ds = window.__ds || {};
    window.__ds.invoke = async function(op, args) {
        args = args || {};
        try {
            switch (op) {
                case 'newChat':
                    return await window.__dsagent_newChatAndSendInit(args.mode || 'quick', !!args.deepThink, args.userText || '', !!args.webSearch);
                case 'switchModel':
                    if (window.__dsagent_setModelMode) { window.__dsagent_setModelMode(args.mode || 'quick'); return { success: true }; }
                    return { success: false, error: 'setModelMode not available' };
                case 'setDeepThink':
                    return await (window.__dsagent_setDeepThink ? window.__dsagent_setDeepThink(!!args.enable) : Promise.resolve({ success: false }));
                case 'setWebSearch':
                    if (window.__dsagent_disableWebSearch) { if (!args.enable) window.__dsagent_disableWebSearch(); return { success: true }; }
                    return { success: false };
                case 'sendMessage':
                    return await (window.__dsagent_sendMessage ? window.__dsagent_sendMessage(args.text || '') : Promise.resolve({ success: false, error: 'not ready' }));
                case 'extractResponse':
                    return window.__dsagent_extractLastResponse ? window.__dsagent_extractLastResponse() : { markdown: '', think: '' };
                case 'uploadFiles':
                    return await (window.__dsagent_uploadFiles ? window.__dsagent_uploadFiles(args.files || []) : Promise.resolve({ success: false }));
                case 'deleteConversation':
                    return await (window.__dsagent_deleteConversation ? window.__dsagent_deleteConversation(args.convid || null) : Promise.resolve({ success: false }));
                case 'stopGeneration':
                    return window.__dsagent_stopGeneration ? window.__dsagent_stopGeneration() : { success: false };
                case 'getStatus':
                    return window.__dsagent_getStatus ? window.__dsagent_getStatus() : { connected: false };
                case 'checkReady':
                    return { ready: !!(window.__dsagent_injected && window.__dsagent_sendMessage) };
                case 'getCurrentUrl':
                    return { url: window.location.href };
                case 'getInitPromptText':
                    return await (window.__dsagent_getInitPromptText ? window.__dsagent_getInitPromptText(args.mode) : Promise.resolve(''));
                default:
                    return { success: false, error: 'Unknown op: ' + op };
            }
        } catch (e) {
            return { success: false, error: e.message };
        }
    };
})();