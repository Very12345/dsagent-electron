// DeepSeek Local Agent - Electron injected script
(function() {
    'use strict';

    // 防止重复注入
    if (window.__dsagent_injected) return;
    window.__dsagent_injected = true;

    const CONFIG = {
        SEND_DELAY: 300,
        TOAST_DURATION: 5000,
        SERVICE_CHECK_INTERVAL: 30000,
        START_DELAY: 1500,
        ANTI_LOOP: true,
        DANGEROUS_COMMANDS: [
            'del ', 'erase', 'rd ', 'rmdir', 'format', 'diskpart',
            'shutdown', 'restart', 'reboot', 'taskkill', 'tskill',
            'reg delete', 'reg add', 'sc delete', 'net user',
            'takeown', 'icacls', 'cacls', 'attrib -r -s -h',
            'powershell remove-item', 'rm -rf', 'rm -r', 'dd if=/dev/zero',
            'move ', 'ren ', 'rename '
        ],
        SAFE_OPERATIONS: ['local-read', 'local-list', 'local-info', 'local-exists', 'local-save', 'local-edit', 'local-mkdir', 'local-singleread', 'local-interval', 'local-break', 'local-help', 'local-browser', 'local-winapi'],
        CONFIRM_MODE: 'smart',  // 'strict' | 'smart' | 'loose'
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

    function isDangerousCommand(cmd) {
        const lowerCmd = cmd.toLowerCase();
        return CONFIG.DANGEROUS_COMMANDS.some(danger => {
            const pattern = new RegExp('\\b' + danger.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
            return pattern.test(lowerCmd);
        });
    }

    function needsConfirmation(lang, cmd) {
        // 白名单操作永远不需要确认
        if (CONFIG.SAFE_OPERATIONS.indexOf(lang) !== -1) return false;
        // Qwen 操作不需要确认（用户明确要求）
        if (['local-qwen-vision', 'local-qwen-draw', 'local-qwen'].indexOf(lang) !== -1) return false;
        // local-delete 总是需要确认（除非宽松模式）
        if (lang === 'local-delete') return CONFIG.CONFIRM_MODE !== 'loose';
        // local-exec / local-cmd
        if (lang === 'local-exec' || lang === 'local-cmd') {
            if (CONFIG.CONFIRM_MODE === 'loose') return false;
            if (CONFIG.CONFIRM_MODE === 'strict') return true;
            // smart: 只有危险命令需要确认
            return isDangerousCommand(cmd);
        }
        return false;
    }

    async function confirmDangerousCommand(lang, cmd) {
        if (!needsConfirmation(lang, cmd)) return true;
        var cmdDisplay = cmd && cmd.length > 200 ? cmd.substring(0, 200) + '...' : cmd;
        try {
            var result = await window.electronAPI.agentRequestConfirm({
                lang: lang,
                cmd: cmd,
                cmdDisplay: cmdDisplay
            });
            return result && result.confirmed;
        } catch(e) {
            console.warn('Confirm dialog failed:', e);
            return false;
        }
    }

    function escapeHtml(str) {
        return str.replace(/[&<>]/g, function(m) {
            if (m === '&') return '&amp;';
            if (m === '<') return '&lt;';
            if (m === '>') return '&gt;';
            return m;
        });
    }

    function escapeRegex(str) {
        return str.replace(/[.*+?^${}()|[\]\\\/]/g, '\\$&');
    }

    function getSendStopBtn() {
        var btns = document.querySelectorAll('div.ds-button--primary.ds-button--filled.ds-button--circle');
        for (var i = 0; i < btns.length; i++) {
            var b = btns[i];
            if (b.getAttribute('aria-label')) continue;
            return b;
        }
        // fallback: 新版本使用 capsule 形状
        var capsule = document.querySelectorAll('div.ds-button--primary.ds-button--filled.ds-button--capsule');
        for (var ci = 0; ci < capsule.length; ci++) {
            var cb = capsule[ci];
            if (cb.getAttribute('aria-label')) continue;
            return cb;
        }
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
        // mode: 'quick' 或 'professional'
        var targetType = mode === 'professional' ? 'expert' : 'quick';
        var radios = document.querySelectorAll('[data-model-type]');
        for (var ri = 0; ri < radios.length; ri++) {
            var r = radios[ri];
            if (r.getAttribute('data-model-type') === targetType) {
                if (r.getAttribute('aria-checked') !== 'true') {
                    r.click();
                    return true;
                }
                return false; // already selected
            }
        }
        // fallback: 按文字搜索
        var label = mode === 'professional' ? '专家模式' : '快速模式';
        var allEls = document.querySelectorAll('span, div, button');
        for (var ei = 0; ei < allEls.length; ei++) {
            var el = allEls[ei];
            if (el.textContent && el.textContent.trim() === label) {
                var parent = el;
                for (var pj = 0; pj < 5; pj++) {
                    if (parent.hasAttribute('data-model-type') || parent.getAttribute('role') === 'radio') {
                        if (parent.getAttribute('aria-checked') !== 'true') {
                            parent.click();
                            return true;
                        }
                        return false;
                    }
                    if (parent === document.body) break;
                    parent = parent.parentElement;
                }
            }
        }
        return false;
    }

    let cachedCmdMap = null;
    let cmdMapTimestamp = 0;

    function buildCmdMap(forceRebuild = false) {
        const now = Date.now();
        if (!forceRebuild && cachedCmdMap && (now - cmdMapTimestamp) < 30000) return cachedCmdMap;
        const map = new Map();
        const allCodeBlocks = document.querySelectorAll(SELECTORS.codeBlock);
        for (const block of allCodeBlocks) {
            const lang = getLanguage(block);
            if (!REFERENCE_LANGS.includes(lang)) continue;
            const code = extractCode(block);
            if (!code) continue;
            const lines = code.split('\n');
            for (const line of lines) {
                const trimmed = line.trim();
                const match = trimmed.match(/^(?:\/\/|#|--)\s*@cmd:(\S+)/);
                if (match) {
                    const name = match[1];
                    const lineIndex = lines.indexOf(line);
                    const actualCode = lines.slice(lineIndex + 1).join('\n').trim();
                    map.set(name, actualCode || null);
                    console.log('Registered ref: @cmd:' + name);
                    break;
                }
            }
        }
        cachedCmdMap = map;
        cmdMapTimestamp = now;
        return map;
    }

    function resolveRefs(content, cmdMap) {
        return content.replace(/\{@cmd:(\S+)\}/g, (match, name) => {
            const code = cmdMap.get(name);
            if (code !== undefined) {
                if (code === null) return '# Error: @cmd:' + name + ' has no code';
                return code;
            }
            console.warn('Ref not found: @cmd:' + name);
            return '# Error: @cmd:' + name + ' not found';
        });
    }

    async function execLocal(cmd) {
        // 解析参数行（key=value 格式，位于开头几行）
        var lines = cmd.split('\n');
        var timeoutMs;
        var isAdmin = false;
        var paramLineCount = 0;
        var parsedLines = [];
        for (var li = 0; li < lines.length; li++) {
            var line = lines[li].trim();
            var kvMatch = line.match(/^(\w+)\s*=\s*(.+)$/);
            if (kvMatch) {
                var key = kvMatch[1].toLowerCase();
                var val = kvMatch[2].trim();
                if (key === 'timeout') {
                    timeoutMs = parseInt(val, 10);
                    if (isNaN(timeoutMs) || timeoutMs <= 0) timeoutMs = undefined;
                    paramLineCount++;
                    continue;
                }
                if (key === 'runas' && val.toLowerCase() === 'admin') {
                    isAdmin = true;
                    paramLineCount++;
                    continue;
                }
            }
            // 非参数行，停止解析
            parsedLines.push(lines[li]);
        }
        
        var actualCmd = parsedLines.join('\n').trim();
        if (!actualCmd) throw new Error('Missing command');

        if (!(await confirmDangerousCommand('local-exec', actualCmd))) return '(Cancelled by user)';
        var res;
        if (isAdmin) {
            res = await window.electronAPI.agentExecAdmin(actualCmd);
        } else {
            res = await window.electronAPI.agentExec(actualCmd, timeoutMs);
        }
        if (!res.success) throw new Error(res.error || 'Execution failed');
        var parts = [];
        if (res.stdout) parts.push(res.stdout);
        if (res.stderr) parts.push('[stderr] ' + res.stderr);
        const output = parts.join('\n').trim() || '(Executed, no output)';
        return output;
    }

    async function readLocal(content) {
        content = content.trim();
        
        // 解析参数：支持 path=xxx mode=quick|professional force=true
        var kv = parseKeyValuePairs(content);
        var filePath = kv.path || content;  // 没有 path= 时取全文作为路径
        var mode = kv.mode || 'professional';
        var force = kv.force === 'true';
        
        filePath = filePath.trim();
        if (!filePath) throw new Error('Missing file path');
        
        // 检查文件大小
        var infoRes = await window.electronAPI.agentInfo(filePath);
        if (infoRes.success && infoRes.size !== undefined) {
            var sizeKB = Math.round(infoRes.size / 1024);
            var sizeMB = (infoRes.size / 1024 / 1024).toFixed(1);
            
            // 2MB 硬限制（所有模式）
            if (infoRes.size > 2 * 1024 * 1024) {
                throw new Error('文件 ' + sizeMB + 'MB 超过 2MB，local-read 无法处理。请使用 local-singleread mode=quick 快速模式读取。');
            }
            
            // 专家模式：超过 10KB 需要 force=true 才能读取
            if (mode !== 'quick' && infoRes.size > 10 * 1024) {
                if (!force) {
                    return '⚠️ 文件大小警告：该文件 ' + sizeKB + 'KB（超过 10KB），可能会占用大量上下文。\n如果你确认需要读取完整内容，请在 local-read 中添加 force=true 参数，如：\n\n```local-read\npath="' + filePath + '" force=true\n```\n\n> 建议使用 local-singleread 并添加分析指令来获取摘要，避免占用过多上下文。';
                }
                showToast('⚠️ 已强制读取大文件 (' + sizeKB + 'KB)', 3000);
            }
        }
        
        const res = await window.electronAPI.agentRead(filePath);
        if (!res.success) throw new Error(res.error);
        return res.content;
    }

    async function saveLocal(filePath, content) {
        const res = await window.electronAPI.agentSave(filePath.trim(), content);
        if (!res.success) throw new Error(res.error);
        return res.message;
    }

    async function listLocal(dir) {
        let targetDir = dir && dir.trim();
        if (!targetDir) targetDir = '.';
        const res = await window.electronAPI.agentList(targetDir);
        if (!res.success) throw new Error(res.error);
        let output = res.path + '\n';
        for (let i = 0; i < res.files.length; i++) {
            const f = res.files[i];
            output += (f.isDirectory ? '[DIR] ' : '[FILE] ') + f.name + ' (' + formatSize(f.size) + ')\n';
        }
        return output;
    }

    async function deleteLocal(p) {
        if (!(await confirmDangerousCommand('local-delete', p.trim()))) return '(Cancelled by user)';
        const res = await window.electronAPI.agentDelete(p.trim());
        if (!res.success) throw new Error(res.error);
        return res.message;
    }

    async function mkdirLocal(p) {
        const res = await window.electronAPI.agentMkdir(p.trim());
        if (!res.success) throw new Error(res.error);
        return res.message;
    }

    async function existsLocal(p) {
        const res = await window.electronAPI.agentExists(p.trim());
        if (!res.success) throw new Error(res.error);
        return res.exists ? 'Exists' : 'Not found';
    }

    async function infoLocal(p) {
        const res = await window.electronAPI.agentInfo(p.trim());
        if (!res.success) throw new Error(res.error);
        return 'Path: ' + p + '\nSize: ' + formatSize(res.size) + '\nModified: ' + res.mtime + '\nType: ' + (res.isDirectory ? 'Directory' : 'File');
    }

    async function editLocal(filePath, find, regex, replace) {
        const res = await window.electronAPI.agentEdit(filePath.trim(), find, regex, replace || '');
        if (!res.success) throw new Error(res.error);
        return res.message + (res.changed ? ' (Modified)' : ' (No match)');
    }

    /** local-interval 循环执行 */
    var _intervalBreak = false;

    async function execInterval(content) {
        var lines = content.trim().split('\n');
        var intervalMs = 5000;
        // 解析 interval=... 参数
        var intervalMatch = lines[0] && lines[0].match(/^\s*interval\s*=\s*(\d+)/i);
        if (intervalMatch) {
            intervalMs = parseInt(intervalMatch[1]);
            lines = lines.slice(1);
        }
        var cmdContent = lines.join('\n').trim();
        if (!cmdContent) return '# Error: local-interval requires a command after the parameters';

        // 阻止 completion watcher 干扰
        var prevExecuting = isExecuting;
        isExecuting = true;
        _intervalBreak = false;

        try {
            var iteration = 0;
            while (!_intervalBreak) {
                iteration++;
                var result;
                try {
                    result = await execLocal(cmdContent);
                } catch (e) {
                    result = 'Error: ' + e.message;
                }
                // 如果返回超时，直接退出 interval
                if (typeof result === 'string' && result.indexOf('命令已超时') >= 0) {
                    return result;
                }

                var iterMsg = '--- Interval Iteration ' + iteration + ' ---\n' + (result || '(no output)');
                // 发送结果到对话
                await fillAndSend(iterMsg + '\n\n要继续监控请回复 `local-break` 以停止。');
                // 等待 AI 生成回复
                await waitForGenerationEnd();
                await sleep(300);
                // 检查 AI 回复中是否包含 local-break
                var allMsgs = document.querySelectorAll('.ds-message, [class*="message"]');
                var lastMsg = allMsgs[allMsgs.length - 1];
                if (lastMsg && lastMsg.textContent.indexOf('local-break') >= 0) {
                    break;
                }
                // 等待间隔
                await sleep(intervalMs);
            }
        } finally {
            isExecuting = prevExecuting;
            _intervalBreak = false;
        }

        return '✅ Interval monitoring stopped after ' + iteration + ' iteration(s).';
    }

    function formatSize(bytes) {
        if (bytes < 1024) return bytes + ' B';
        if (bytes < 1024*1024) return (bytes/1024).toFixed(1) + ' KB';
        return (bytes/(1024*1024)).toFixed(1) + ' MB';
    }

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
        var el = document.querySelector(SELECTORS.input);
        return el;
    }

    function showToast(msg, duration) {
        // 改为发送到控制栏状态栏显示，不在 DeepSeek 页面上创建 DOM
        try {
            window.electronAPI.agentNotifyStatus(msg);
        } catch(e) {}
        if (!duration) duration = CONFIG.TOAST_DURATION;
        // 保留 DOM toast 作为兜底（如果 IPC 失败）
        var t = document.createElement('div');
        t.textContent = msg;
        Object.assign(t.style, {
            position: 'fixed', bottom: '60px', right: '20px', zIndex: '10000',
            background: 'rgba(0,0,0,0.85)', color: '#fff', padding: '10px 18px',
            borderRadius: '8px', fontSize: '14px', maxWidth: '400px',
            transition: 'opacity 0.3s', fontFamily: 'system-ui, sans-serif'
        });
        document.body.appendChild(t);
        setTimeout(function() {
            t.style.opacity = '0';
            setTimeout(function() { t.remove(); }, 300);
        }, duration);
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
        if (tracker) { try { tracker.setValue(''); } catch(e) {} }
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
        if (lang === 'local-skip') return null;
        if (window.__dsagent_tools) {
            if (!window.__dsagent_tools.isSupported(lang)) return null;
        } else {
            if (SUPPORTED_LANGS.indexOf(lang) < 0) return null;
        }
        const content = extractCode(mdCodeBlock);
        if (!content) return null;
        return { lang: lang, content: content };
    }

    function parseKeyValuePairs(text) {
        const pairs = {};
        const regex = /(\w+)\s*=\s*(?:"([^"]*)"|'([^']*)'|(\S+?))(?:\s|$)/g;
        let match;
        while ((match = regex.exec(text)) !== null) {
            const key = match[1];
            const val = match[2] !== undefined ? match[2] : (match[3] !== undefined ? match[3] : match[4]);
            if (val !== undefined) pairs[key] = val;
        }
        return pairs;
    }

    async function handleSingleRead(params) {
    var filePath = params.path;
    var filePaths = params.paths;
    var mode = params.mode || 'quick';
    var enableSearch = params.search === 'on';
    var enableThink = params.think === 'on';
    var extraPrompt = params.prompt || '';
    
    // 解析多文件路径
    var pathsList = [];
    if (filePaths) {
        pathsList = filePaths.split(',').map(function(p) { return p.trim(); }).filter(function(p) { return p; });
    }
    if (filePath && pathsList.indexOf(filePath) === -1) {
        pathsList.unshift(filePath);
    }
    if (pathsList.length === 0) {
        pathsList = [filePath];
    }
    
    // 声明状态变量
    var searchActuallyEnabled = false;
    var thinkActuallyEnabled = false;

    // ======== 读取所有文件并检查大小 ========
    var fileResults = [];
    var fileListStr = '';
    var totalSizeBytes = 0;
    var MAX_QUICK_FILES = 50;
    var MAX_QUICK_SIZE_PER_FILE = 100 * 1024 * 1024;   // 100MB
    var MAX_EXPERT_TOTAL_SIZE = 159 * 1024;             // 159KB（字节为单位）
    
    for (var fi = 0; fi < pathsList.length; fi++) {
        if (mode === 'quick' && fi >= MAX_QUICK_FILES) {
            throw new Error('快速模式最多支持 ' + MAX_QUICK_FILES + ' 个文件，当前 ' + pathsList.length + ' 个');
        }
        
        showToast('Reading file ' + (fi + 1) + '/' + pathsList.length + '...');
        
        // 先获取文件信息检查大小
        var fileInfo = await window.electronAPI.agentInfo(pathsList[fi]);
        if (fileInfo.success && fileInfo.size !== undefined) {
            if (mode === 'quick') {
                if (fileInfo.size > MAX_QUICK_SIZE_PER_FILE) {
                    throw new Error('快速模式单个文件不能超过 100MB。文件 "' + pathsList[fi] + '" 大小为 ' + Math.round(fileInfo.size / 1024 / 1024) + 'MB');
                }
            } else {
                // 专家模式：累积大小检查
                totalSizeBytes += fileInfo.size;
                if (totalSizeBytes > MAX_EXPERT_TOTAL_SIZE) {
                    throw new Error('专家模式所有文件总大小不能超过 159KB。当前累积已达 ' + Math.round(totalSizeBytes / 1024) + 'KB。请使用 mode=quick 快速模式（不限大小）');
                }
            }
        }
        
        var fileRes = await window.electronAPI.agentReadFile(pathsList[fi]);
        if (!fileRes.success) throw new Error(fileRes.error || 'File not found: ' + pathsList[fi]);
        fileResults.push(fileRes);
        if (fileListStr) fileListStr += ', ';
        fileListStr += fileRes.name;
    }

    // ======== Save original conversation reference ========
    showToast('Creating sub-agent conversation...');
    var origConvEl = null;
    var origConvHref = null;
    var allSideItems = document.querySelectorAll('a[href*="/chat"], [class*="conversation-item"], [class*="chat-item"], [class*="sidebar-item"]');
    for (var si = 0; si < allSideItems.length; si++) {
        var item = allSideItems[si];
        if (item.classList && (item.classList.contains('active') || item.getAttribute('aria-current') === 'page' || item.dataset && item.dataset.active)) {
            origConvEl = item;
            break;
        }
    }
    origConvHref = window.location.pathname + window.location.search + window.location.hash;

    // ======== Create new conversation ========
    var newChatBtn = await findNewChatButton();
    if (!newChatBtn) throw new Error('找不到新建对话按钮');
    newChatBtn.click();

    // 等待新页面加载完成（以 textarea 出现为标志）
    var ta = null;
    for (var retry = 0; retry < 30; retry++) {
        ta = document.querySelector('textarea');
        if (ta) break;
        await sleep(300);
    }
    if (!ta) throw new Error('新对话加载超时');
    ta.focus();
    await sleep(600);

    // ======== 专家模式特殊处理 ========
    if (mode === 'professional') {
        showToast('Switching to Expert mode...');
        setModelMode('professional');
        await sleep(1500); // 等待模式切换完成
        
        // 专家模式：需要先点击输入框激活完整工具栏
        ta.click();
        await sleep(500);
        
        // 查找深度思考按钮（专家模式可能位置不同）
        if (enableThink) {
            showToast('Enabling deep think in Expert mode...');
            var thinkSuccess = false;

            // 方法1：通过 ds-toggle-button 查找
            for (var attempt = 0; attempt < 8; attempt++) {
                // 查找所有 toggle 按钮
                var allToggles = document.querySelectorAll('.ds-toggle-button');
                var deepThinkBtn = null;

                for (var ti = 0; ti < allToggles.length; ti++) {
                    var toggle = allToggles[ti];
                    var span = toggle.querySelector('span');
                    if (span && (span.textContent.includes('深度思考') || span.textContent.includes('Deep Think'))) {
                        deepThinkBtn = toggle;
                        break;
                    }
                }

                // 方法2：通过 aria-label
                if (!deepThinkBtn) {
                    deepThinkBtn = document.querySelector('[aria-label="深度思考"], [aria-label="Deep Think"]');
                }

                if (deepThinkBtn) {
                    var isActive = deepThinkBtn.getAttribute('aria-pressed') === 'true';
                    if (!isActive) {
                        deepThinkBtn.click();
                        await sleep(600);
                        // 验证
                        var newActive = deepThinkBtn.getAttribute('aria-pressed') === 'true';
                        if (newActive) {
                            thinkSuccess = true;
                            thinkActuallyEnabled = true;
                            showToast('Deep think enabled', 1000);
                            break;
                        }
                    } else {
                        thinkSuccess = true;
                        thinkActuallyEnabled = true;
                        break;
                    }
                }
                await sleep(500);
            }

            if (!thinkSuccess) {
                console.warn('Failed to enable deep think in expert mode');
                showToast('Warning: Could not enable deep think', 3000);
            }
        } else {
            // 新对话可能沿用之前的深度思考状态，需要关闭
            for (var attempt = 0; attempt < 5; attempt++) {
                var allToggles = document.querySelectorAll('.ds-toggle-button');
                var deepThinkBtn = null;
                for (var ti = 0; ti < allToggles.length; ti++) {
                    var toggle = allToggles[ti];
                    var span = toggle.querySelector('span');
                    if (span && (span.textContent.includes('深度思考') || span.textContent.includes('Deep Think'))) {
                        deepThinkBtn = toggle;
                        break;
                    }
                }
                if (!deepThinkBtn) {
                    deepThinkBtn = document.querySelector('[aria-label="深度思考"], [aria-label="Deep Think"]');
                }
                if (deepThinkBtn) {
                    if (deepThinkBtn.getAttribute('aria-pressed') === 'true') {
                        deepThinkBtn.click();
                        await sleep(400);
                    }
                    break;
                }
                await sleep(500);
            }
        }

        // 专家模式联网搜索
        if (enableSearch) {
            for (var attempt = 0; attempt < 5; attempt++) {
                var allToggles = document.querySelectorAll('.ds-toggle-button');
                var searchBtn = null;
                for (var ti = 0; ti < allToggles.length; ti++) {
                    var toggle = allToggles[ti];
                    var span = toggle.querySelector('span');
                    if (span && (span.textContent.includes('联网搜索') || span.textContent.includes('智能搜索') || span.textContent.includes('搜索'))) {
                        searchBtn = toggle;
                        break;
                    }
                }
                if (!searchBtn) {
                    searchBtn = document.querySelector('[aria-label*="搜索"], [aria-label*="Search"]');
                }
                if (searchBtn) {
                    if (searchBtn.getAttribute('aria-pressed') !== 'true') {
                        searchBtn.click();
                        await sleep(400);
                        searchActuallyEnabled = true;
                    } else {
                        searchActuallyEnabled = true;
                    }
                    break;
                }
                await sleep(500);
            }
        } else {
            // 新对话可能沿用之前的联网搜索状态，需要关闭
            for (var attempt = 0; attempt < 5; attempt++) {
                var allToggles = document.querySelectorAll('.ds-toggle-button');
                var searchBtn = null;
                for (var ti = 0; ti < allToggles.length; ti++) {
                    var toggle = allToggles[ti];
                    var span = toggle.querySelector('span');
                    if (span && (span.textContent.includes('联网搜索') || span.textContent.includes('智能搜索') || span.textContent.includes('搜索'))) {
                        searchBtn = toggle;
                        break;
                    }
                }
                if (!searchBtn) {
                    searchBtn = document.querySelector('[aria-label*="搜索"], [aria-label*="Search"]');
                }
                if (searchBtn) {
                    if (searchBtn.getAttribute('aria-pressed') === 'true') {
                        searchBtn.click();
                        await sleep(400);
                    }
                    break;
                }
                await sleep(500);
            }
        }
    } else {
        // 普通模式
        showToast('Using Quick mode...');
        setModelMode('quick');
        await sleep(800);
        
        // 普通模式的深度思考
        if (enableThink) {
            showToast('Enabling deep think...');
            for (var attempt = 0; attempt < 5; attempt++) {
                var dt = await waitForToggle('深度思考', 2000);
                if (dt) {
                    var active = isToggleActive(dt);
                    if (!active) {
                        dt.click();
                        await sleep(500);
                        var newActive = isToggleActive(dt);
                        if (newActive) {
                            thinkActuallyEnabled = true;
                            showToast('Deep think enabled', 1000);
                            break;
                        }
                    } else {
                        thinkActuallyEnabled = true;
                        break;
                    }
                }
                await sleep(500);
            }
        } else {
            // 新对话可能沿用之前的深度思考状态，需要关闭
            for (var attempt = 0; attempt < 3; attempt++) {
                var dt = await waitForToggle('深度思考', 2000);
                if (dt) {
                    if (isToggleActive(dt)) {
                        dt.click();
                        await sleep(400);
                    }
                    break;
                }
                await sleep(500);
            }
        }

        // 普通模式联网搜索
        if (enableSearch) {
            showToast('Enabling web search...');
            for (var attempt = 0; attempt < 3; attempt++) {
                var st = await waitForToggle('智能搜索', 3000);
                if (st && !isToggleActive(st)) {
                    st.click();
                    searchActuallyEnabled = true;
                    await sleep(400);
                    break;
                } else if (st && isToggleActive(st)) {
                    searchActuallyEnabled = true;
                    break;
                }
                await sleep(500);
            }
        } else {
            // 新对话可能沿用之前的联网搜索状态，需要关闭
            for (var attempt = 0; attempt < 3; attempt++) {
                var st = await waitForToggle('智能搜索', 3000);
                if (st) {
                    if (isToggleActive(st)) {
                        st.click();
                        await sleep(400);
                    }
                    break;
                }
                await sleep(500);
            }
        }
    }

    // ======== 处理文件（注意编码） ========
    var readMsg;
    if (mode === 'quick') {
        // 快速模式：上传文件
        var fileInput = document.querySelector(SELECTORS.fileInput);
        if (!fileInput) throw new Error('找不到文件上传输入框');

        var dt = new DataTransfer();
        for (var fi = 0; fi < fileResults.length; fi++) {
            var fr = fileResults[fi];
            showToast('Uploading file: ' + fr.name + '...');
            // 处理 base64 编码，确保中文正确
            var binaryString = window.atob(fr.data);
            var bytes = new Uint8Array(binaryString.length);
            for (var i = 0; i < binaryString.length; i++) {
                bytes[i] = binaryString.charCodeAt(i);
            }
            var blob = new Blob([bytes], { type: fr.mime || 'application/octet-stream' });
            var file = new File([blob], fr.name, { type: fr.mime || 'application/octet-stream' });
            dt.items.add(file);
        }
        fileInput.files = dt.files;
        fileInput.dispatchEvent(new Event('change', { bubbles: true }));
        await waitForReady();

        // ======== 核验：上传完成后立即检查页面是否有格式不支持的通知 ========
        var uploadErr = checkPageError();
        if (uploadErr && uploadErr.error === 'format_unsupported') {
            showToast('⚠️ 上传格式不支持，立即终止');
            // 清理临时对话
            var nt0 = document.querySelector(SELECTORS.navToggleBtn);
            if (nt0) { nt0.click(); await sleep(500); }
            var convItems0 = document.querySelectorAll(SELECTORS.convItem);
            if (convItems0.length === 0) convItems0 = document.querySelectorAll('a[href*="/chat"], [class*="conversation-item"], [class*="chat-item"]');
            if (convItems0.length > 0) {
                var delBtn0 = await findDeleteButton(convItems0[0]);
                if (delBtn0) { delBtn0.click(); await sleep(2000); var cf0 = findConfirmButton(); if (cf0) { cf0.click(); await sleep(1500); } }
            }
            return '⚠️ 上传失败：DeepSeek 不支持该文件格式，请尝试将文件转换为支持的格式（如 txt、pdf、docx 等文本格式）后重试。';
        }

        readMsg = '请阅读我上传的文件：' + fileListStr + '。提取其完整内容并作必要分析，将结果完整返回。注意：你是子代理(sub-agent)，返回后对话将被删除，请确保返回完整信息。' + (extraPrompt ? '\n\n额外指令（必须遵守）：' + extraPrompt : '');
    } else {
        // 专家模式：以文本形式发送，注意编码
        showToast('Reading file content for Expert mode...');
        var allTextContent = '';
        for (var fi = 0; fi < fileResults.length; fi++) {
            var fr = fileResults[fi];
            try {
                var textRes = await window.electronAPI.agentRead(pathsList[fi]);
                if (textRes.success) {
                    if (allTextContent) allTextContent += '\n\n--- 文件分隔 ---\n\n';
                    allTextContent += '**文件: ' + fr.name + '**\n```text\n' + textRes.content + '\n```';
                }
            } catch(e) {
                console.warn('Failed to read file content:', e);
            }
        }
        
        if (allTextContent) {
            readMsg = '请分析以下文件内容。这是子代理任务，请深入分析后返回完整结果。\n\n' + allTextContent + '\n\n请基于以上内容进行分析。' + (extraPrompt ? '\n\n额外指令（必须遵守）：' + extraPrompt : '');
        } else {
            // 降级方案：通过路径读取
            readMsg = '请读取并分析以下文件：' + fileListStr + '\n路径：' + pathsList.join(', ') + '\n请返回完整的分析结果。' + (extraPrompt ? '\n\n额外指令：' + extraPrompt : '');
        }
    }

    showToast('Sending to sub-agent...');
    await fillAndSend(readMsg);

    showToast('Waiting for sub-agent response...');
    await waitForGenerationEnd();
    showToast('Sub-agent responded, extracting...');

    // ======== 核验：生成结束后再次检查页面是否有文字识别失败的通知 ========
    var genErr = checkPageError();
    if (genErr && genErr.error === 'no_text_recognized') {
        showToast('⚠️ 图片未识别到文字，立即终止');
        // 清理临时对话
        var ntErr = document.querySelector(SELECTORS.navToggleBtn);
        if (ntErr) { ntErr.click(); await sleep(500); }
        var convItemsErr = document.querySelectorAll(SELECTORS.convItem);
        if (convItemsErr.length === 0) convItemsErr = document.querySelectorAll('a[href*="/chat"], [class*="conversation-item"], [class*="chat-item"]');
        if (convItemsErr.length > 0) {
            var delBtnErr = await findDeleteButton(convItemsErr[0]);
            if (delBtnErr) { delBtnErr.click(); await sleep(2000); var cfErr = findConfirmButton(); if (cfErr) { cfErr.click(); await sleep(1500); } }
        }
        return '⚠️ 图片识别失败：DeepSeek 未能从图片中识别出文字。请确保图片中包含清晰的文字内容，或使用 local-qwen-vision 进行视觉分析。';
    }

    // ======== Extract response ========
    var messages = document.querySelectorAll(SELECTORS.messageContainer);
    var lastAiMsg = null;
    for (var mi = messages.length - 1; mi >= 0; mi--) {
        var msg = messages[mi];
        var textEls = msg.querySelectorAll('.ds-message-content, [class*="markdown"], p');
        if (textEls.length > 0) { lastAiMsg = msg; break; }
    }
    var responseText = '';
    if (lastAiMsg) {
        var textEls = lastAiMsg.querySelectorAll('.ds-message-content, [class*="markdown"], p');
        for (var ti = 0; ti < textEls.length; ti++) {
            responseText += textEls[ti].textContent + '\n';
        }
    }
    if (!responseText.trim()) responseText = '(子代理未返回内容)';

    // ======== 核验：检查回复文本中是否包含文字识别失败（兜底） ========
    var errorCheck = responseText.trim();
    if (errorCheck.indexOf('未识别到文字') !== -1 || errorCheck.indexOf('未能识别到文字') !== -1) {
        showToast('⚠️ 图片未识别到文字，立即终止');
        // 清理临时对话
        var nt2 = document.querySelector(SELECTORS.navToggleBtn);
        if (nt2) { nt2.click(); await sleep(500); }
        var convItems2 = document.querySelectorAll(SELECTORS.convItem);
        if (convItems2.length === 0) convItems2 = document.querySelectorAll('a[href*="/chat"], [class*="conversation-item"], [class*="chat-item"]');
        if (convItems2.length > 0) {
            var delBtn2 = await findDeleteButton(convItems2[0]);
            if (delBtn2) { delBtn2.click(); await sleep(2000); var cf2 = findConfirmButton(); if (cf2) { cf2.click(); await sleep(1500); } }
        }
        return '⚠️ 图片识别失败：DeepSeek 未能从图片中识别出文字。请确保图片中包含清晰的文字内容，或使用 local-qwen-vision 进行视觉分析。';
    }

    // ======== Delete temporary conversation ========
    showToast('Cleaning up sub-agent conversation...');
    var navToggle2 = document.querySelector(SELECTORS.navToggleBtn);
    if (navToggle2) { navToggle2.click(); await sleep(500); }

    var convItems = document.querySelectorAll(SELECTORS.convItem);
    if (convItems.length === 0) {
        convItems = document.querySelectorAll('a[href*="/chat"], [class*="conversation-item"], [class*="chat-item"]');
    }
    if (convItems.length > 0) {
        var tempConv = convItems[0];
        var delBtn = await findDeleteButton(tempConv);
        if (delBtn) {
            delBtn.click();
            await sleep(2000);
            var confirmBtn = findConfirmButton();
            if (confirmBtn) { confirmBtn.click(); await sleep(1500); }
        }
    }

    // ======== Return to original conversation ========
    showToast('Returning to original conversation...');
    var wentBack = false;
    if (origConvEl && document.body.contains(origConvEl)) {
        origConvEl.click();
        wentBack = true;
        await sleep(1000);
    }
    if (!wentBack && origConvHref) {
        var targetId = origConvHref.replace(/^.*\/chat\//, '');
        var allConvLinks = document.querySelectorAll('a[href*="/chat/"]');
        for (var cli = 0; cli < allConvLinks.length; cli++) {
            var href = allConvLinks[cli].getAttribute('href');
            if (href && href.includes(targetId)) {
                allConvLinks[cli].click();
                wentBack = true;
                await sleep(1000);
                break;
            }
        }
    }
    if (!wentBack) {
        var allItems = document.querySelectorAll('a[href*="/chat"], [class*="conversation-item"], [class*="chat-item"]');
        for (var ai = 0; ai < allItems.length; ai++) {
            if (ai === 0) continue;
            allItems[ai].click();
            wentBack = true;
            await sleep(1000);
            break;
        }
    }
    if (!wentBack) {
        if (navToggle2) navToggle2.click();
        await sleep(500);
    }

    // ======== Return result ========
    var modeLabel = mode === 'professional' ? 'Expert' : 'Quick';
    if (searchActuallyEnabled) modeLabel += '+Search';
    if (thinkActuallyEnabled) modeLabel += '+DeepThink';
    
    return '**子代理分析结果 (' + modeLabel + '): ' + fileListStr + '**\n\n' + responseText.trim();
}

    function parseSingleReadParams(content) {
        var trimmed = content.trim();
        // 提取 key=value 参数后面的额外提示词
        var kvRegex = /(\w+)\s*=\s*(?:"([^"]*)"|'([^']*)'|(\S+?))(?:\s|$)/g;
        var lastMatchEnd = 0;
        var match;
        while ((match = kvRegex.exec(trimmed)) !== null) {
            lastMatchEnd = match.index + match[0].length;
        }
        var extraPrompt = trimmed.substring(lastMatchEnd).trim();

        var kv = parseKeyValuePairs(trimmed);
        if (kv.path || kv.paths) {
            return {
                path: kv.path || '',
                paths: kv.paths || '',
                mode: kv.mode || 'quick',
                search: kv.search || 'off',
                think: kv.think || 'off',
                prompt: extraPrompt || ''
            };
        }
        // 兼容旧格式：纯路径，第一行是路径，其余是 prompt
        var firstLineEnd = trimmed.indexOf('\n');
        var path = firstLineEnd > 0 ? trimmed.substring(0, firstLineEnd).trim() : trimmed;
        var prompt = firstLineEnd > 0 ? trimmed.substring(firstLineEnd + 1).trim() : '';
        return {
            path: path,
            paths: '',
            mode: 'quick',
            search: 'off',
            think: 'off',
            prompt: prompt
        };
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

    // ==================== Qwen 命令处理 ====================
    async function execQwen(fnName, args) {
        var res = await window.electronAPI.qwenExec(fnName, args);
        if (!res.success) throw new Error(res.error || 'Qwen exec failed');
        // 检查内部结果（有些函数返回 {success, result} 或 {success, error}）
        if (res.result && typeof res.result === 'object' && res.result.success === false) {
            throw new Error('Qwen ' + fnName + ' failed: ' + (res.result.error || 'unknown error'));
        }
        return res.result;
    }

    async function showQwen() {
        var vis = await window.electronAPI.qwenIsVisible();
        if (!vis.visible) await window.electronAPI.qwenShowView();
    }

    async function hideQwen() {
        await window.electronAPI.qwenHideView();
    }

    async function downloadQwenImage(url, savePath) {
        var res = await window.electronAPI.qwenDownloadImage(url, savePath);
        if (!res.success) throw new Error('下载图片失败: ' + (res.error || url));
        return { path: res.path, dataUrl: res.dataUrl };
    }

    function getBaseFilename(promptText) {
        // 取前 5 个中文字符或 10 个英文作为文件名前缀
        var sanitized = promptText.replace(/[<>:"\/\\|?*]/g, '').trim();
        var base = sanitized.substring(0, 10).replace(/\s+/g, '_');
        return base || 'qwen_draw';
    }

    // 使用 Qwen 回复中的复制按钮获取完整文本（防阶段/残缺）
    async function getQwenResponseViaCopy() {
        // 保存当前剪贴板内容，操作完成后还原
        var saved = await window.electronAPI.clipboardSave();
        try {
            // 查找复制按钮，获取其坐标（不通过 JS 点击，因为 navigator.clipboard 需要用户手势）
            var btnInfo = await execQwen('copyLastResponse', []);
            if (btnInfo && btnInfo.success && btnInfo.x !== undefined) {
                // 通过 Electron 真实鼠标事件点击复制按钮
                var clickRes = await window.electronAPI.qwenClickAt(btnInfo.x, btnInfo.y);
                if (clickRes && clickRes.success) {
                    await sleep(800); // 等待剪贴板更新
                    var clipRes = await window.electronAPI.qwenGetClipboard();
                    if (clipRes && clipRes.success && clipRes.text) {
                        return clipRes.text;
                    }
                }
            }
            // 降级：使用 DOM 提取
            var fallback = await execQwen('getLastResponseText', []);
            return fallback || '';
        } finally {
            // 还原剪贴板
            if (saved && saved.text !== undefined) {
                await window.electronAPI.clipboardRestore(saved.text);
            }
        }
    }

    async function qwenVision(content) {
        // 格式：path="图片路径"\n可选提示词
        var lines = content.trim().split('\n');
        var firstLine = lines[0].trim();
        var kv = parseKeyValuePairs(firstLine);
        var imagePath = kv.path || firstLine;
        var promptText = lines.slice(1).join('\n').trim() || '请描述这张图片';

        window.electronAPI.qwenProgress('[Qwen] 使用 Qwen 进行视觉分析...');
        window.electronAPI.qwenProgress('[Qwen] 新建对话...');
        await execQwen('newConversation');
        await sleep(1000);
        window.electronAPI.qwenProgress('[Qwen] 上传图片...');
        // 通过 Electron 粘贴图片文件
        var pasteRes = await window.electronAPI.qwenPasteImage(imagePath);
        if (!pasteRes.success) throw new Error('粘贴图片失败: ' + (pasteRes.error || ''));
        await sleep(1000);
        window.electronAPI.qwenProgress('[Qwen] 发送提示词...');
        // 使用 Electron 级粘贴（绕过 Slate.js 内部状态问题）
        await execQwen('focusEditor');
        await window.electronAPI.qwenPasteText(promptText);
        await sleep(800);
        window.electronAPI.qwenProgress('[Qwen] 等待回复...');
        await execQwen('clickSend');

        // 轮询 Qwen 是否正在输出
        var progressDone = false;
        (async function() {
            while (!progressDone) {
                try {
                    var resp = await execQwen('isResponding', []);
                    if (resp && resp.responding) {
                        window.electronAPI.qwenProgress('[Qwen] 正在输出回复...');
                    } else {
                        window.electronAPI.qwenProgress('[Qwen] 等待回复...');
                    }
                } catch(e) {}
                await sleep(2000);
            }
        })();

        var waitRes = await execQwen('waitForTextResponse', [120000]);
        progressDone = true;
        if (!waitRes.success) throw new Error(waitRes.error === 'Timeout' ? 'Qwen 回复超时' : 'Qwen 回复失败: ' + waitRes.error);
        // 等待复制按钮渲染
        await sleep(1500);
        var text = await getQwenResponseViaCopy();
        window.electronAPI.qwenProgress('[Qwen] 分析完成');
        await execQwen('deleteConversation');
        // 去除 AI 可能复述的提示词内容（按需精简）
        var clean = (text || '').replace(new RegExp(escapeRegex(promptText), 'g'), '').trim();
        return clean || '(Qwen 未返回内容)';
    }

    async function qwenDraw(content) {
        var lines = content.trim().split('\n');
        var firstLine = lines[0].trim();
        var kv = parseKeyValuePairs(firstLine);
        var saveDir = kv.savepath || '';
        var desc = kv.desc || '';
        var refPath = kv.ref || '';

        // 如果第一行解析出了 key=value 参数，则剩余内容为绘图描述；否则全部为绘图描述
        var promptText;
        var kvKeys = Object.keys(kv);
        if (kvKeys.length > 0) {
            promptText = lines.slice(1).join('\n').trim();
        } else {
            promptText = content.trim();
        }

        if (!promptText) throw new Error('Missing drawing prompt');

        // 附加说明文字（用于补充绘图意图）
        var fullPrompt = '请根据以下描述生成图片，务必实际绘制图片并输出图片结果，不要仅提供文字描述或建议：\n\n' + promptText;
        if (desc) fullPrompt += '\n\n附加要求：' + desc;

        window.electronAPI.qwenProgress('[Qwen] 使用 Qwen 进行绘图...');
        window.electronAPI.qwenProgress('[Qwen] 新建对话...');
        await execQwen('newConversation');
        await sleep(1000);
        
        // 如果有参考图，先上传参考图
        if (refPath) {
            window.electronAPI.qwenProgress('[Qwen] 上传参考图片: ' + refPath + '...');
            var pasteRes = await window.electronAPI.qwenPasteImage(refPath);
            if (!pasteRes.success) {
                console.warn('[qwenDraw] Failed to paste reference image:', pasteRes.error);
                window.electronAPI.qwenProgress('[Qwen] 参考图上传失败，继续使用纯文本绘图...');
            } else {
                await sleep(1000);
            }
        }
        
        window.electronAPI.qwenProgress('[Qwen] 发送绘图提示词...');
        // 使用 Electron 级粘贴（绕过 Slate.js 内部状态问题）
        await execQwen('focusEditor');
        await window.electronAPI.qwenPasteText(fullPrompt);
        await sleep(800);
        window.electronAPI.qwenProgress('[Qwen] 等待绘图开始...');
        await execQwen('clickSend');

        // 并发轮询绘图进度并推送到 agent 界面
        var progressDone = false;
        (async function() {
            while (!progressDone) {
                try {
                    var p = await execQwen('getDrawProgress');
                    // 显示所有阶段(0-5)：等待→文字生成→文字完成→图片输出→完成
                    window.electronAPI.qwenProgress('[Qwen绘图] ' + p.detail);
                    // 额外检测是否正在输出
                    var resp = await execQwen('isResponding', []);
                    if (resp && resp.responding && p.current < 3) {
                        window.electronAPI.qwenProgress('[Qwen绘图] Qwen 正在输出... 阶段: ' + p.detail);
                    }
                } catch(e) {}
                await sleep(1000);
            }
        })();

        var waitRes = await execQwen('waitForDrawResponse', [300000]);
        progressDone = true;
        if (!waitRes.success) {
            if (waitRes.error === 'Timeout') {
                throw new Error('Qwen 绘图超时');
            } else {
                throw new Error('Qwen 绘图失败：当前内容无法生成，请修改描述后重试');
            }
        }
        await sleep(1000);
        var imgUrls = await execQwen('getLastImageUrls', []);
        window.electronAPI.qwenProgress('[Qwen] 绘图完成，正在下载图片...');

        // 使用自定义保存目录或系统下载目录
        var dirRes = await window.electronAPI.getDownloadsPath();
        var baseDir = saveDir || (dirRes.success ? dirRes.path : '.');
        var baseName = getBaseFilename(promptText);
        var savedPaths = [];

        for (var ui = 0; ui < (imgUrls || []).length; ui++) {
            var ext = (imgUrls[ui] || '').match(/\.(\w+)(\?|$)/);
            var suffix = ext ? '.' + ext[1] : '.png';
            var saveName = baseName + '_' + (ui + 1) + suffix;
            var savePath = baseDir + '\\' + saveName;
            try {
                var p = await downloadQwenImage(imgUrls[ui], savePath);
                savedPaths.push(p.path);
            } catch (e) {
                console.warn('[qwenDraw] Failed to download image ' + (ui + 1), e);
            }
        }

        window.electronAPI.qwenProgress('[Qwen] 下载完成');

        window.electronAPI.qwenProgress('[Qwen] 删除临时对话...');
        await execQwen('deleteConversation');
        // 只返回保存路径给 DeepSeek（不包含 base64 图片数据，避免输入框溢出）
        var result = '✅ Qwen 绘图完成，共生成 ' + savedPaths.length + ' 张图片。\n\n';
        for (var ui = 0; ui < savedPaths.length; ui++) {
            result += '📁 已保存: ' + savedPaths[ui] + '\n';
        }
        return result;
    }

    async function qwenGeneral(content) {
        // 解析 path 参数（支持图片/文件上传）
        var lines = content.trim().split('\n');
        var firstLine = lines[0].trim();
        var kv = parseKeyValuePairs(firstLine);
        var filePath = kv.path || '';
        var text = filePath ? lines.slice(1).join('\n').trim() : content.trim();

        window.electronAPI.qwenProgress('[Qwen] 使用 Qwen...');
        window.electronAPI.qwenProgress('[Qwen] 新建对话...');
        await execQwen('newConversation');
        await sleep(1000);

        // 如果有文件路径（图片等），先上传
        if (filePath) {
            window.electronAPI.qwenProgress('[Qwen] 上传文件: ' + filePath + '...');
            var pasteRes = await window.electronAPI.qwenPasteImage(filePath);
            if (!pasteRes.success) throw new Error('上传文件失败: ' + (pasteRes.error || ''));
            await sleep(1000);
            if (!text) text = '请分析这个文件的内容';
        }

        window.electronAPI.qwenProgress('[Qwen] 发送消息...');
        // 使用 Electron 级粘贴（绕过 Slate.js 内部状态问题）
        await execQwen('focusEditor');
        await window.electronAPI.qwenPasteText(text);
        await sleep(800);
        window.electronAPI.qwenProgress('[Qwen] 等待回复...');
        await execQwen('clickSend');

        // 轮询 Qwen 是否正在输出
        var progressDone = false;
        (async function() {
            while (!progressDone) {
                try {
                    var resp = await execQwen('isResponding', []);
                    if (resp && resp.responding) {
                        window.electronAPI.qwenProgress('[Qwen] 正在输出回复...');
                    } else {
                        window.electronAPI.qwenProgress('[Qwen] 等待回复...');
                    }
                } catch(e) {}
                await sleep(2000);
            }
        })();

        var waitRes = await execQwen('waitForTextResponse', [120000]);
        progressDone = true;
        if (!waitRes.success) throw new Error(waitRes.error === 'Timeout' ? 'Qwen 回复超时' : 'Qwen 回复失败: ' + waitRes.error);
        // 等待复制按钮渲染
        await sleep(1500);
        var resultText = await getQwenResponseViaCopy();
        window.electronAPI.qwenProgress('[Qwen] 删除临时对话...');
        await execQwen('deleteConversation');
        window.electronAPI.qwenProgress('[Qwen] 处理完成');
        return resultText || '(Qwen 未返回内容)';
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
    function findCopyButton() {
        // 查找 DeepSeek 回复底部的复制按钮（SVG 为复制图标）
        // 返回最后一个（= 最新消息的）复制按钮
        var buttons = document.querySelectorAll('[role="button"]');
        var last = null;
        for (var i = 0; i < buttons.length; i++) {
            var btn = buttons[i];
            var svgPath = btn.querySelector('svg path');
            if (svgPath) {
                var d = svgPath.getAttribute('d') || '';
                // 复制图标路径特征：以 M6.14929 4.02032 开头
                if (d.indexOf('M6.14929 4.02032') >= 0) {
                    last = btn;
                }
            }
        }
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

    function parseCommandsFromMarkdown(markdown) {
        var commands = [];
        // 匹配标准代码块 ```lang\ncontent```
        var regex = /```(\w[\w-]*)\s*\n([\s\S]*?)```/g;
        var match;
        while ((match = regex.exec(markdown)) !== null) {
            var lang = match[1].toLowerCase();
            var content = match[2].trim();
            if (lang === 'local-skip') continue;
            if (SUPPORTED_LANGS.indexOf(lang) >= 0) {
                commands.push({ lang: lang, content: content });
            }
        }
        return commands;
    }

    function parseSegmentsFromMarkdown(markdown) {
        var segments = [];
        // 匹配标准代码块 ```lang\ncontent```
        var regex = /```(\w[\w-]*)\s*\n([\s\S]*?)```/g;
        var lastIndex = 0;

        while (true) {
            var match = regex.exec(markdown);
            if (!match) break;

            // 代码块前的文本
            var textBefore = markdown.slice(lastIndex, match.index).trim();
            if (textBefore) {
                segments.push({ type: 'text', content: textBefore });
            }

            var lang = match[1].toLowerCase();
            var content = match[2].trim();
            if (content) {
                if (SUPPORTED_LANGS.indexOf(lang) >= 0) {
                    segments.push({ type: 'tool-call', lang: lang, content: content });
                } else if (lang.indexOf('local-') !== 0) {
                    // 非 local-* 的普通代码块也当作文本
                    segments.push({ type: 'text', content: match[0] });
                }
            }

            lastIndex = match.index + match[0].length;
        }

        // 末尾剩余文本
        var textAfter = markdown.slice(lastIndex).trim();
        if (textAfter) {
            segments.push({ type: 'text', content: textAfter });
        }

        return segments;
    }

    async function processCompletedGeneration(copyBtn) {
        if (!enableAutoExec || isExecuting) return;
        // 防重复：1 秒内已处理过的跳过
        if (Date.now() - lastProcessedTimestamp < 1000) return;
        lastProcessedTimestamp = Date.now();
        isExecuting = true;
        stopRequested = false;  // 重置停止标记，新一轮生成开始

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
                showToast('未找到复制按钮，跳过自动执行', 2000);
                return;
            }
            copyBtn.click();

            // 2. 等待剪贴板更新
            await sleep(150);

            // 3. 读取剪贴板中的完整 markdown
            var markdown = '';
            try {
                markdown = await window.electronAPI.clipboardReadText();
            } catch (e) {
                showToast('读取剪贴板失败: ' + e.message, 3000);
                return;
            }
            if (!markdown) {
                showToast('剪贴板内容为空', 2000);
                return;
            }

            // 4a. 频率限制检测：剪贴板内容等于用户发送的消息 + 页面包含"发送过于频繁"
            if (lastUserText && markdown === lastUserText) {
                var bodyText = document.body ? document.body.innerText || '' : '';
                if (bodyText.indexOf('消息发送过于频繁') >= 0 || bodyText.indexOf('请稍后重试') >= 0) {
                    showToast('检测到频率限制', 2000);
                    if (pollTimer) { clearInterval(pollTimer); pollTimer = 0; }
                    var waitSeconds = Math.floor((Date.now() - sendTimestamp) / 1000);
                    var confirmed = await window.electronAPI.agentRateLimitNotify(waitSeconds);
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

            // 4. 从 markdown 中提取命令和分段
            var commands = parseCommandsFromMarkdown(markdown);

            // 4a. 如果有指令，先通知任务开始，再转发解析结果
            if (commands.length > 0) {
                try {
                    window.electronAPI.agentForwardResult({ type: 'tasks-start' });
                } catch (e) { /* ignore */ }
            }

            try {
                var segments = parseSegmentsFromMarkdown(markdown);
                if (segments.length > 0) {
                    window.electronAPI.agentForwardResult({ type: 'response', segments: segments });
                }
            } catch (e) {
                console.warn('Failed to forward to agent view:', e);
            }

            if (commands.length === 0) {
                showToast('未找到可执行的指令', 2000);
                return;
            }

            // 5. 执行命令
            console.log('Found ' + commands.length + ' commands via clipboard');
            showToast('执行 ' + commands.length + ' 个指令...');

            var cmdMap = buildCmdMap();
            var results = [];

            for (var i = 0; i < commands.length; i++) {
            var c = commands[i];
            var resolvedContent = resolveRefs(c.content, cmdMap);
            showToast((i+1) + '/' + commands.length + ' ' + c.lang + '...');
            try {
                var r = null;
                if (c.lang === 'local-help') {
                    if (window.__dsagent_tools) {
                        r = await window.__dsagent_tools.execute('local-help', resolvedContent);
                    } else {
                        r = await window.__dsagent_getInitPromptText();
                    }
                } else if (window.__dsagent_tools && window.__dsagent_tools.isSupported(c.lang)) {
                    r = await window.__dsagent_tools.execute(c.lang, resolvedContent);
                } else {
                    continue;
                }
                results.push({ lang: c.lang, success: true, result: r });
            } catch (e) {
                results.push({ lang: c.lang, success: false, result: e.message });
            }
            // 每次工具执行完成后立即转发到 Agent 视图（逐任务更新状态）
            try {
                var lastResult = results[results.length - 1];
                if (lastResult) {
                    window.electronAPI.agentForwardResult({
                        type: 'tool-results',
                        segments: [{
                            type: 'tool-result',
                            lang: lastResult.lang,
                            success: lastResult.success,
                            content: (lastResult.success ? '' : 'ERROR: ') + (typeof lastResult.result === 'string' ? lastResult.result : JSON.stringify(lastResult.result))
                        }]
                    });
                }
            } catch (e) {
                console.warn('Failed to forward result:', e);
            }
            // 输出大小检查
            if (r && typeof r === 'string' && i < results.length) {
                var lastRes = results[results.length - 1];
                if (lastRes.success && lastRes.result === r) {
                    var outputKB = Math.round(r.length / 1024);
                    if (r.length > 159 * 1024) {
                        lastRes.success = false;
                        lastRes.result = '❌ 输出结果过长 (' + outputKB + 'KB)，无法直接返回对话。\n建议使用 local-save 将结果保存到文件，或使用 local-singleread 子代理读取分析。';
                    } else if (r.length > 10 * 1024) {
                        var hasForce = /force\s*=\s*true/.test(resolvedContent);
                        if (!hasForce) {
                            lastRes.result = '⚠️ 输出结果较大 (' + outputKB + 'KB)，可能占用大量上下文。\n如果你需要完整结果，请在命令中添加 force=true 参数。\n建议使用 local-save 保存结果到文件，避免上下文溢出。\n\n（返回前 2000 个字符供参考）\n\n' + r.substring(0, 2000);
                        } else {
                            showToast('⚠️ 已强制返回大结果 (' + outputKB + 'KB)', 3000);
                        }
                    }
                }
            }
            // 检查停止请求
            if (stopRequested) {
                console.log('[Stop] Stop requested, breaking command loop');
                // 多加一个跳过提示
                results.push({ lang: 'stop', success: true, result: '(后续命令已停止)' });
                break;
            }
            if (i < commands.length - 1) await new Promise(function(r) { setTimeout(r, 300); });
            }

            var successCount = results.filter(function(r) { return r.success; }).length;
            var feedback = 'Execution results (' + successCount + '/' + results.length + ')\n';
            for (var i = 0; i < results.length; i++) {
                var r = results[i];
                feedback += '\n--- ' + r.lang + ' ' + (r.success ? 'OK' : 'FAIL') + ' ---\n';
                var resultStr = r.result;
                feedback += (resultStr || '(No output)');
            }

            await fillAndSend(feedback);

            // 通知 Agent 视图：所有任务执行完毕
            try {
                window.electronAPI.agentForwardResult({ type: 'tasks-end' });
            } catch (e) { /* ignore */ }

            showToast('完成 ' + successCount + '/' + results.length, 3000);
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
            }

            // 检测生成完成转换
            if (wasGenerating && !isStopSquare && isDisabled) {
                _lastLogState = 'processing'; // 防止后续回到 idle 时重复输出 idle 日志
                console.log('[Watcher] DETECTED: generation completed!');
                if (pollTimer) { clearInterval(pollTimer); pollTimer = 0; }
                var copyBtn = await waitForCopyButton(500);
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
                    await processCompletedGeneration(copyBtn);
                } else {
                    console.log('[Watcher] Copy button NOT found within 500ms');
                }
            } else if (wasGenerating && !isStopSquare && !isDisabled) {
                console.log('[Watcher] Generation interrupted (stop-square gone, button enabled)');
            }

            wasGenerating = isStopSquare;
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
                 var copyBtn = await waitForCopyButton(200);
                 if (copyBtn) {
                     console.log('[Fallback] Found copy button, processing...');
                     // 如果最近已处理过，跳过（防止与主检测重复）
                     if (Date.now() - lastProcessedTimestamp < 1000) return;
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

    // ===== 频率限制检测 =====
    var rateLimitNotified = false;
    async function checkRateLimit(now) {
        if (rateLimitNotified || !lastUserText) return;
        try {
            var clipboard = await window.electronAPI.clipboardReadText();
            if (!clipboard || clipboard !== lastUserText) return;
            // 页面上是否有"消息发送过于频繁"
            var bodyText = document.body ? document.body.innerText || '' : '';
            if (bodyText.indexOf('消息发送过于频繁') === -1 && bodyText.indexOf('请稍后重试') === -1) return;

            rateLimitNotified = true;
            if (pollTimer) { clearInterval(pollTimer); pollTimer = 0; }

            // 通知 agentview 显示弹窗
            var waitSeconds = Math.floor((now - sendTimestamp) / 1000);
            var confirmed = await window.electronAPI.agentRateLimitNotify(waitSeconds);
            if (confirmed) {
                // 点击重试按钮
                clickRetryButton();
                // 重置状态，继续检测
                rateLimitNotified = false;
                lastUserText = clipboard; // 保持用户文本
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
        // 从服务端加载配置
        try {
            var configRes = await window.electronAPI.agentConfigLoad();
            if (configRes.success && configRes.config) {
                if (configRes.config.dangerousCommands) CONFIG.DANGEROUS_COMMANDS = configRes.config.dangerousCommands;
                if (configRes.config.safeOperations) CONFIG.SAFE_OPERATIONS = configRes.config.safeOperations;
                if (configRes.config.confirmMode) CONFIG.CONFIRM_MODE = configRes.config.confirmMode;
            }
        } catch (e) {
            console.warn('Failed to load config:', e);
        }

        // ======== 暴露工具函数给工具系统 ========
        window.__dsagent_parseKeyValuePairs = parseKeyValuePairs;
        window.__dsagent_parseSingleReadParams = parseSingleReadParams;
        window.__dsagent_handleSingleRead = handleSingleRead;
        window.__dsagent_execInterval = execInterval;
        window.__dsagent_breakInterval = function() { _intervalBreak = true; };
        window.__dsagent_qwenVision = qwenVision;
        window.__dsagent_qwenDraw = qwenDraw;
        window.__dsagent_qwenGeneral = qwenGeneral;
        window.__dsagent_confirmCommand = confirmDangerousCommand;

        // ======== 初始化工具系统 ========
        if (window.__dsagent_tools && window.__dsagent_tools.init) {
            window.__dsagent_tools.init({ utils: true });
            // 从工具系统获取所有支持的语言列表
            SUPPORTED_LANGS = window.__dsagent_tools.getAllLangs();
        }

        // 暴露控制接口给主进程
        window.__dsagent_setAutoExec = function(enabled) {
            enableAutoExec = enabled;
        };
        window.__dsagent_setConfirmMode = function(mode) {
            CONFIG.CONFIRM_MODE = mode;
            // 保存到服务端
            window.electronAPI.agentConfigSave({ confirmMode: mode }).catch(function() {});
        };
        window.__dsagent_showIntro = async function() {
            var apiDoc = (await window.__dsagent_getInitPromptText())
                + '\n\n## 初次使用\n\n'
                + '请先发送测试指令确认连接：\n\n'
                + '```local-exec\necho "本地服务连接测试成功"\n```';

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
        // Agent 视图控制函数
        window.__dsagent_setModelMode = function(mode) { setModelMode(mode); };
        window.__dsagent_setDeepThink = async function(enable) { return await setDeepThink(!!enable); };
        window.__dsagent_disableWebSearch = function() { tryToggleWebSearch(false); };
        window.__dsagent_sendMessage = async function(text) {
            lastUserText = text;
            sendTimestamp = Date.now();
            rateLimitNotified = false;
            var result = await fillAndSend(text);
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
        window.__dsagent_getInitPromptText = async function() {
            var baseText = '';
            try {
                var res = await window.electronAPI.getInitPrompt();
                if (res.success && res.text) baseText = res.text;
            } catch (e) {
                console.warn('Failed to load prompt file:', e);
            }
            if (!baseText) {
                baseText = '# 本地执行助手\n\n你是一个能通过本机接口执行命令、读写文件的助手。\n使用 `local-exec`、`local-read` 等代码块执行操作。\n详细指令见 `agent-prompt.md`。';
            }
            // 动态追加工具列表（从工具系统自动生成）
            if (window.__dsagent_tools) {
                var allTools = window.__dsagent_tools.getAll();
                baseText += '\n\n## 可用工具一览\n\n';
                baseText += '> 每个工具的详细参数和使用方法请使用 `local-help` 查询。\n\n';
                baseText += '| 命令 | 适用场景 |\n';
                baseText += '|------|----------|\n';
                for (var ti = 0; ti < allTools.length; ti++) {
                    var t = allTools[ti];
                    var names = Array.isArray(t.name) ? t.name : [t.name];
                    var nameStr = names.map(function(n) { return '`' + n + '`'; }).join(' / ');
                    baseText += '| ' + nameStr + ' | ' + (t.scope || t.description || '') + ' |\n';
                }
                baseText += '\n> 如有疑问，使用 `local-help` 获取完整文档。';
            }
            return baseText;
        };
        window.__dsagent_newChatAndSendInit = async function(mode, deepthink) {
            // 新对话：清空工具文档阅读记录
            if (window.__dsagent_tools && window.__dsagent_tools.clearReadHistory) {
                window.__dsagent_tools.clearReadHistory();
            }
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

            // 设置模式
            setModelMode(mode === 'expert' ? 'professional' : 'quick');
            await sleep(800);

            // 设置深度思考（使用统一的健壮方法，含重试和验证）
            await setDeepThink(!!deepthink);
            await sleep(300);

            // 确保关闭联网搜索
            tryToggleWebSearch(false);
            await sleep(400);

            // 发送初始化提示词
            var initText = await window.__dsagent_getInitPromptText();
            sendTimestamp = Date.now();  // 标记发送时间，启用兜底轮询保底
            await fillAndSend(initText);
            startPollingFallback();  // 启动兜底轮询，防止主检测错过 stop-square 状态

            return { success: true };
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
                    // 停止方块→disabled = 输出完毕；可用箭头→disabled = 发送中；其余=未输入
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
            return { connected: serviceConnected, confirmMode: CONFIG.CONFIRM_MODE, buttonState: buttonState, theme: getTheme() };
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

            await checkService();
            setInterval(checkService, CONFIG.SERVICE_CHECK_INTERVAL);
            console.log('DeepSeek Local Agent (Electron) started');
        }, CONFIG.START_DELAY);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();