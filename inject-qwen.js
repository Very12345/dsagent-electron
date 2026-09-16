// Qwen (chat.qwen.ai) 自动化注入脚本
(function() {
    'use strict';

    if (window.__qwen) return;
    var Q = window.__qwen = { ready: false };

    // ==================== 工具函数 ====================
    function sleep(ms) {
        return new Promise(function(r) { setTimeout(r, ms); });
    }

    function waitForElement(selector, timeout, textFilter) {
        timeout = timeout || 15000;
        var start = Date.now();
        return new Promise(function(resolve) {
            function check() {
                var els = document.querySelectorAll(selector);
                for (var i = 0; i < els.length; i++) {
                    if (!textFilter || els[i].textContent.indexOf(textFilter) !== -1) {
                        return resolve(els[i]);
                    }
                }
                if (Date.now() - start > timeout) {
                    resolve(null);
                } else {
                    setTimeout(check, 200);
                }
            }
            check();
        });
    }

    function findButton(text) {
        var buttons = document.querySelectorAll('button, a, [role="button"], [role="menuitem"], [role="option"], [class*="btn"]');
        for (var i = 0; i < buttons.length; i++) {
            if (buttons[i].textContent.trim().indexOf(text) !== -1) {
                return buttons[i];
            }
        }
        return null;
    }

    // ==================== 核心 API ====================
    Q.ready = true;

    var QWEN_WEB_MODEL_LABELS = {
        'qwen.image.web': 'Qwen3.8-Max',
		'qwen.text.web': 'Qwen3.7-Plus',
		'qwen.text.web.3.8-max': 'Qwen3.8-Max',
		'qwen.text.web.3.7-plus': 'Qwen3.7-Plus',
        'qwen.default': 'Qwen3.7-千问',
        'qwen.3.7': 'Qwen3.7-千问',
        'qwen.3.8-max': 'Qwen3.8-Max',
        'qwen.3.7-max': 'Qwen3.7-Max',
        'qwen.3.6-flash': 'Qwen3.6-Flash'
    };

    function normalizedLabel(value) {
        return String(value || '').replace(/\s+/g, ' ').trim();
    }

    function visibleElement(node) {
        if (!node || !node.getBoundingClientRect) return false;
        var rect = node.getBoundingClientRect();
        var style = window.getComputedStyle ? window.getComputedStyle(node) : null;
        return rect.width > 0 && rect.height > 0 && (!style || (style.display !== 'none' && style.visibility !== 'hidden'));
    }

    function modelPicker() {
        var candidates = document.querySelectorAll('[aria-haspopup="dialog"]');
        for (var i = 0; i < candidates.length; i++) {
            var text = normalizedLabel(candidates[i].innerText || candidates[i].textContent);
            if (visibleElement(candidates[i]) && /^(?:Qwen|千问)/i.test(text)) return candidates[i];
        }
		// Current chat.qwen.ai no longer exposes aria-haspopup="dialog" on the
		// model trigger. Find the smallest visible Qwen-labelled clickable node
		// (or its clickable ancestor) instead of relying on generated classes.
		var labelled = document.querySelectorAll('button,[role="button"],[aria-haspopup],div,span');
		var best = null, bestArea = Infinity;
		for (var j = 0; j < labelled.length; j++) {
			var label = normalizedLabel(labelled[j].innerText || labelled[j].textContent);
			if (!/^(?:Qwen|千问)[\w.\- ]{0,40}$/i.test(label) || !visibleElement(labelled[j])) continue;
			var node = labelled[j];
			for (var depth = 0; node && depth < 5; depth++, node = node.parentElement) {
				var role = node.getAttribute && node.getAttribute('role');
				var popup = node.getAttribute && node.getAttribute('aria-haspopup');
				var cls = typeof node.className === 'string' ? node.className : '';
				if (node.tagName !== 'BUTTON' && role !== 'button' && !popup && !/cursor-pointer|select|trigger/i.test(cls)) continue;
				var rect = node.getBoundingClientRect();
				var area = rect.width * rect.height;
				if (area > 0 && area < bestArea) { best = node; bestArea = area; }
				break;
			}
		}
		if (best) return best;
        return null;
    }

    Q.getCurrentModel = function() {
        var picker = modelPicker();
        return picker ? normalizedLabel(picker.innerText || picker.textContent) : '';
    };

    Q.selectModel = async function(modelId) {
        var label = QWEN_WEB_MODEL_LABELS[String(modelId || '')] || String(modelId || '');
        if (!label) return { success: false, error: 'Unknown Qwen web model: ' + modelId };
        var picker = modelPicker();
        var pickerDeadline = Date.now() + 10000;
        while (!picker && Date.now() < pickerDeadline) {
            await sleep(150);
            picker = modelPicker();
        }
        if (!picker) return { success: false, error: 'Qwen model picker not found after page stabilization' };
        if (normalizedLabel(picker.innerText || picker.textContent).indexOf(label) === 0) {
            return { success: true, model: label, unchanged: true };
        }
        if (picker.getAttribute('aria-expanded') !== 'true') {
            picker.click();
            await sleep(250);
        }
        var deadline = Date.now() + 4000;
        var option = null;
        while (!option && Date.now() < deadline) {
            var nodes = document.querySelectorAll('div,button,[role="button"],[role="option"],[role="menuitem"]');
            for (var i = 0; i < nodes.length; i++) {
                if (!visibleElement(nodes[i]) || normalizedLabel(nodes[i].innerText || nodes[i].textContent) !== label) continue;
                var candidate = nodes[i];
                for (var depth = 0; candidate && depth < 5; depth++, candidate = candidate.parentElement) {
                    var candidateText = normalizedLabel(candidate.innerText || candidate.textContent);
                    var candidateClass = typeof candidate.className === 'string' ? candidate.className : '';
                    if (candidateText.indexOf(label) === 0 && (candidate.getAttribute('role') === 'option' || candidate.getAttribute('role') === 'menuitem' || /cursor-pointer/.test(candidateClass))) {
                        option = candidate;
                        break;
                    }
                }
                if (option) break;
            }
            if (!option) await sleep(100);
        }
        if (!option) return { success: false, error: 'Qwen model option not found: ' + label };
        option.click();
        deadline = Date.now() + 4000;
        while (Date.now() < deadline) {
            await sleep(100);
            picker = modelPicker();
            var current = picker && normalizedLabel(picker.innerText || picker.textContent);
            if (current && current.indexOf(label) === 0) return { success: true, model: label };
        }
        return { success: false, error: 'Qwen model selection was not confirmed: ' + label };
    };

	var QWEN_REASONING_LABELS = {
		'none': ['Fast', '快速', '关闭思考', 'Off'],
		'low': ['Auto', '自动', '轻度思考', 'Low'],
		'medium': ['Thinking', '思考', '标准思考', 'Medium'],
		'high': ['Deep Thinking', '深度思考', 'Thinking', '思考', '深度', 'High', 'Max']
	};

	function reasoningPicker() {
		var nodes = document.querySelectorAll('button,[role="button"],[aria-haspopup],div,span');
		var best = null, bestArea = Infinity;
		for (var i = 0; i < nodes.length; i++) {
			var text = normalizedLabel(nodes[i].innerText || nodes[i].textContent);
			if (!/^(?:Auto|自动|Fast|快速|Thinking|思考|Deep Thinking|深度思考|Low|Medium|High|Max)$/i.test(text) || !visibleElement(nodes[i])) continue;
			var node = nodes[i];
			for (var depth = 0; node && depth < 5; depth++, node = node.parentElement) {
				var role = node.getAttribute && node.getAttribute('role');
				var popup = node.getAttribute && node.getAttribute('aria-haspopup');
				var cls = typeof node.className === 'string' ? node.className : '';
				if (node.tagName !== 'BUTTON' && role !== 'button' && !popup && !/cursor-pointer|select|trigger/i.test(cls)) continue;
				var rect = node.getBoundingClientRect();
				var area = rect.width * rect.height;
				if (area > 0 && area < bestArea) { best = node; bestArea = area; }
				break;
			}
		}
		return best;
	}

	Q.selectReasoningMode = async function(effort) {
		var id = String(effort || 'none').toLowerCase();
		var wanted = QWEN_REASONING_LABELS[id] || QWEN_REASONING_LABELS.none;
		var picker = reasoningPicker();
		if (!picker) return { success: false, error: 'Qwen reasoning picker not found', available: [] };
		var current = normalizedLabel(picker.innerText || picker.textContent);
		if (wanted.some(function(label){ return current.toLowerCase() === label.toLowerCase(); })) return { success: true, effort: id, label: current, unchanged: true };
		picker.click();
		await sleep(250);
		var available = [];
		var option = null;
		var deadline = Date.now() + 4000;
		while (!option && Date.now() < deadline) {
			var nodes = document.querySelectorAll('button,[role="button"],[role="option"],[role="menuitem"],div,span');
			for (var i = 0; i < nodes.length; i++) {
				if (!visibleElement(nodes[i])) continue;
				var text = normalizedLabel(nodes[i].innerText || nodes[i].textContent);
				if (!text || text.length > 48 || !/Auto|自动|Fast|快速|Think|思考|Low|Medium|High|深度|Max/i.test(text)) continue;
				if (available.indexOf(text) < 0) available.push(text);
				if (wanted.some(function(label){ return text.toLowerCase() === label.toLowerCase(); })) {
					var candidate = nodes[i];
					for (var depth = 0; candidate && depth < 5; depth++, candidate = candidate.parentElement) {
						var role = candidate.getAttribute && candidate.getAttribute('role');
						var cls = typeof candidate.className === 'string' ? candidate.className : '';
						if (candidate.tagName === 'BUTTON' || role === 'option' || role === 'menuitem' || role === 'button' || /cursor-pointer/.test(cls)) { option = candidate; break; }
					}
				}
				if (option) break;
			}
			if (!option) await sleep(100);
		}
		if (!option) {
			try { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); } catch (_) {}
			return { success: false, error: 'Qwen reasoning option not found for ' + id, available: available };
		}
		option.click();
		await sleep(250);
		picker = reasoningPicker();
		current = picker && normalizedLabel(picker.innerText || picker.textContent);
		return current && wanted.some(function(label){ return current.toLowerCase() === label.toLowerCase(); })
			? { success: true, effort: id, label: current, available: available }
			: { success: false, error: 'Qwen reasoning selection was not confirmed for ' + id, available: available, current: current || '' };
	};

    // 自动点击 float-to-bottom 按钮（Qwen 回到底部的滚动按钮）
    // 严格限定：只匹配 chat 区域内的回到底部按钮，排除侧边栏折叠按钮
    // 加导航状态保护 + 节流防抖：SPA 导航/操作期间 DOM 大量变更，不加节流会导致
    // MutationObserver 高频触发 → .click() 在 React reconciliation 中间态执行 → Blink 内部状态不
    // 一致 → 渲染进程 crash（[Qwen] Renderer gone: crashed）
    (function() {
        var _lastClick = 0;          // 节流：每秒最多 .click() 一次
        var _navGuard = false;       // navigating 标志（由 Q.sendMessage/newConversation 等设置）
        Object.defineProperty(Q, '_navigating', {
            get: function() { return _navGuard; },
            set: function(v) { _navGuard = !!v; }
        });
        var observer = new MutationObserver(function() {
            if (_navGuard) return;               // 操作中，跳过
            if (Date.now() - _lastClick < 1000) return;  // 节流：至少间隔 1s
            try {
                // 仅在 AI 生成中（停止按钮存在时）自动滚到底部
                // 用户上翻查看时没有停止按钮，不抢滚动，避免干扰阅读
                var stopBtn = findStopButton();
                if (!stopBtn) return;

                var chatArea = document.querySelector('[class*="chat-area"], [class*="chat-container"], [class*="main"]');
                var searchRoot = chatArea || document;
                var ftb = searchRoot.querySelector('[class*="float-to-bottom"]');
                if (ftb && ftb.className && (ftb.className.indexOf('active') !== -1 || ftb.className.indexOf('float-to-bottom-active') !== -1)) {
                    if (ftb.className.indexOf('sidebar') === -1 && !ftb.querySelector('[class*="sidebar"], [class*="Sidebar"]')) {
                        ftb.click();
                        _lastClick = Date.now();
                    }
                }
            } catch(e) { /* DOM 过渡期查询异常，忽略 */ }
        });
        observer.observe(document.body || document.documentElement, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ['class']
        });
    })();

    // 原始 JS 执行（用于 inject.js 传入大段代码）
    Q.__rawEval = function(code) {
        try {
            return eval(code);
        } catch(e) {
            return { error: e.message };
        }
    };

    // 新建对话
    Q.newConversation = function() {
        return new Promise(function(resolve) {
            var btn = document.querySelector('[class*="new-chat"], [class*="newChat"], [class*="new_conversation"]')
                || findButton('新建对话')
                || findButton('新对话')
                || findButton('New Chat');
            if (btn) {
                btn.click();
                // 点击后预期导航，阻止 MutationObserver 在过渡期 .click()
                if (typeof Q._navigating !== 'undefined') Q._navigating = true;
                resolve({ success: true });
            } else {
                resolve({ success: false, error: 'New conversation button not found' });
            }
        });
    };

    function qwenFileInput() {
        var inputs = document.querySelectorAll('input[type="file"]');
        var generic = null;
        for (var i = 0; i < inputs.length; i++) {
            var accept = String(inputs[i].getAttribute('accept') || '').toLowerCase();
            if (/image|png|jpe?g|webp|gif/.test(accept)) return inputs[i];
            if (!generic || !accept || accept === '*/*') generic = inputs[i];
        }
        return generic || inputs[0] || null;
    }

    function qwenAttachmentCount() {
        return document.querySelectorAll('[class*="attachment"], [class*="upload-preview"], [class*="file-preview"], [data-testid*="attachment"], [data-testid*="upload"]').length;
    }

    async function revealQwenFileInput() {
        var input = qwenFileInput();
        if (input) return input;
        var uploadBtn = document.querySelector('[class*="upload"], [class*="image-upload"], [class*="file-upload"], [class*="attach"]')
            || findButton('上传附件')
            || findButton('上传')
            || findButton('图片')
            || findButton('附件')
            || findButton('Upload');
        if (uploadBtn) uploadBtn.click();
        for (var retry = 0; retry < 20; retry++) {
            await sleep(150);
            input = qwenFileInput();
            if (input) return input;
        }
        return null;
    }
    Q.revealFileInput = revealQwenFileInput;

    // Upload real bytes into Qwen's file input. The transport supplies
    // [{name, mime, data(base64)}]; merely opening the upload menu is not an
    // upload and previously caused the model to receive metadata-only text.
    Q.uploadFiles = async function(files) {
        files = Array.isArray(files) ? files : [];
        if (!files.length) return { success: true, count: 0 };
        try {
            var fileInput = await revealQwenFileInput();
            if (!fileInput) return { success: false, error: 'Qwen file input not found' };
            var beforeAttachments = qwenAttachmentCount();
            var dt = new DataTransfer();
            for (var fi = 0; fi < files.length; fi++) {
                var source = files[fi] || {};
                if (!source.data) return { success: false, error: 'Missing base64 data for ' + (source.name || ('file ' + (fi + 1))) };
                var binary = window.atob(String(source.data).replace(/\s/g, ''));
                var bytes = new Uint8Array(binary.length);
                for (var bi = 0; bi < binary.length; bi++) bytes[bi] = binary.charCodeAt(bi);
                var mime = source.mime || 'application/octet-stream';
                var blob = new Blob([bytes], { type: mime });
                dt.items.add(new File([blob], source.name || ('upload-' + (fi + 1)), { type: mime }));
            }
            fileInput.files = dt.files;
            fileInput.dispatchEvent(new Event('input', { bubbles: true }));
            fileInput.dispatchEvent(new Event('change', { bubbles: true }));

            // Wait for React/Qwen to consume the selection. Some revisions
            // clear input.files after creating a preview, while others retain
            // it, so accept either observable acknowledgement.
            for (var wait = 0; wait < 40; wait++) {
                await sleep(150);
                var retained = fileInput.files && fileInput.files.length >= files.length;
                var previewed = qwenAttachmentCount() > beforeAttachments;
                var bodyText = String(document.body && document.body.innerText || '');
                var named = files.some(function(item) { return item && item.name && bodyText.indexOf(item.name) >= 0; });
                if (retained || previewed || named) return { success: true, count: files.length };
            }
            return { success: false, error: 'Qwen did not acknowledge the selected file(s)' };
        } catch (e) {
            return { success: false, error: e && e.message || String(e) };
        }
    };

    // Compatibility alias for older callers. It now requires actual bytes.
    Q.uploadImage = function(files) {
        return Q.uploadFiles(files || []);
    };

    // 查找发送按钮（精确版，只返回可用的发送按钮）
    // Qwen 页面按钮无 aria-label，需多策略定位：
    // 1. aria-label="发送消息"（旧版兼容）
    // 2. 输入框容器内最右侧的圆形/方形按钮（结构定位）
    // 3. class 含 "send" 且在页面底部
    var _sendBtnDiagLogged = false;
    function findSendButton() {
        // 策略1：aria-label 精确匹配（旧版/其他页面兼容）
        var exact = document.querySelector('button[aria-label="发送消息"]:not([disabled])');
        if (exact) return exact;

        // 策略2：在输入框容器内找最右侧的按钮（Qwen 发送按钮在输入区右下）
        var inputContainers = document.querySelectorAll('[class*="chat-input"], [class*="input-area"], [class*="composer"], [class*="footer"]');
        var bestBtn = null, bestRight = -1;
        for (var ci = 0; ci < inputContainers.length; ci++) {
            var btns = inputContainers[ci].querySelectorAll('button');
            for (var bi = 0; bi < btns.length; bi++) {
                var b = btns[bi];
                if (b.disabled) continue;
                var rect = b.getBoundingClientRect();
                if (rect.width < 10 || rect.height < 10) continue;
                // 最右侧的按钮通常是发送
                if (rect.right > bestRight) { bestRight = rect.right; bestBtn = b; }
            }
        }
        if (bestBtn) return bestBtn;

        // 策略3：class 含 send 且可见
        var sendBtns = document.querySelectorAll('button[class*="send"]:not([disabled]), button[class*="Send"]:not([disabled])');
        for (var si = 0; si < sendBtns.length; si++) {
            var r = sendBtns[si].getBoundingClientRect();
            if (r.width > 10 && r.height > 10) return sendBtns[si];
        }

        // 策略4：诊断 — 输出所有可见按钮特征（仅一次）
        if (!_sendBtnDiagLogged) {
            _sendBtnDiagLogged = true;
            setTimeout(function() {
                var allBtns = document.querySelectorAll('button');
                var info = [];
                for (var i = 0; i < allBtns.length; i++) {
                    var b = allBtns[i];
                    var r = b.getBoundingClientRect();
                    if (r.width < 5 || r.height < 5) continue;
                    info.push({
                        label: b.getAttribute('aria-label') || '',
                        dis: b.disabled,
                        cls: (b.className || '').substring(0, 40),
                        rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)],
                        svg: b.querySelector('svg') ? (b.querySelector('svg').getAttribute('class') || '') : ''
                    });
                }
                // findSendButton 诊断日志已移除（避免污染 Qwen 页面 DOM）
            }, 0);
        }
        return null;
    }

    // 查找"停止回答"按钮（正在输出中）
    // Qwen 有 aria-label="停止回答"（已确认），回答中显示，答完消失
    function findStopButton() {
        var btns = document.querySelectorAll('button');
        for (var i = 0; i < btns.length; i++) {
            var label = (btns[i].getAttribute('aria-label') || '').trim();
            var title = (btns[i].getAttribute('title') || '').trim();
            var testId = (btns[i].getAttribute('data-testid') || '').trim();
            if (/^(停止回答|停止生成|停止响应|Stop generating|Stop response)$/i.test(label)
                || /^(停止回答|停止生成|Stop generating)$/i.test(title)
                || /^(stop-generating|stop-response|composer-stop-button)$/i.test(testId)) {
                return btns[i];
            }
        }
        // Only accept an actual `stop` class token with a square stop glyph.
        // Substring matching used to accept utility classes such as
        // `stopPropagation`, leaving every completed Qianwen turn stuck.
        for (var i = 0; i < btns.length; i++) {
            var cls = (btns[i].className || '').toLowerCase();
            if (!/(^|[\s_-])stop([\s_-]|$)/.test(cls)) continue;
            var svg = btns[i].querySelector('svg');
            if (svg && (svg.querySelector('rect') || svg.querySelector('path[d*="H"], path[d*="h"]'))) return btns[i];
        }
        return null;
    }

    // 检测 Qwen 是否正在生成
    // 唯一可靠信号：停止按钮存在 = 回答中；不存在 = 答完
    // 注意：发送按钮 disabled 不能作为生成信号——空输入时发送按钮也 disabled（待发送态）
    function isGeneratingNow() {
        return findStopButton() !== null;
    }

    // 查找可见的 Slate.js 编辑器（排除隐藏的测量克隆体）
    function findVisibleEditor() {
        // 方案1：在 chat-input 容器内找 contenteditable
        var chatInputs = document.querySelectorAll('[class*="chat-input"], [class*="input-area"], [class*="composer"]');
        for (var ci = 0; ci < chatInputs.length; ci++) {
            var editor = chatInputs[ci].querySelector('[contenteditable="true"]');
            if (editor && editor.offsetParent !== null) {
                // 确认不在测量容器内
                var parent = editor.parentElement;
                var isMeasure = false;
                while (parent) {
                    if (parent.getAttribute && parent.getAttribute('data-testid') && parent.getAttribute('data-testid').indexOf('measure') !== -1) {
                        isMeasure = true;
                        break;
                    }
                    parent = parent.parentElement;
                }
                if (!isMeasure) return editor;
            }
        }
        // 方案2：通用搜索，排除测量克隆体
        var editors = document.querySelectorAll('[contenteditable="true"][data-slate-editor="true"]');
        for (var i = 0; i < editors.length; i++) {
            var el = editors[i];
            if (!el.offsetParent) continue;
            // 检查大小，排除 0 尺寸的元素
            var rect = el.getBoundingClientRect();
            if (rect.width < 50 || rect.height < 20) continue;
            var parent = el.parentElement;
            var isMeasure = false;
            while (parent) {
                if (parent.getAttribute && parent.getAttribute('data-testid') && parent.getAttribute('data-testid').indexOf('measure') !== -1) {
                    isMeasure = true;
                    break;
                }
                parent = parent.parentElement;
            }
            if (!isMeasure) return el;
        }
        // 方案3：兜底 — 无视 visibility/size 检查，直接找不在测量容器内的 slate 编辑器
        // 适用于视图不可见的 Agent 模式
        var allSlate = document.querySelectorAll('[contenteditable="true"][data-slate-editor="true"]');
        var best = null;
        for (var i = 0; i < allSlate.length; i++) {
            var el = allSlate[i];
            var parent = el.parentElement;
            var isMeasure = false;
            while (parent) {
                if (parent.getAttribute && parent.getAttribute('data-testid') && parent.getAttribute('data-testid').indexOf('measure') !== -1) {
                    isMeasure = true;
                    break;
                }
                parent = parent.parentElement;
            }
            if (!isMeasure) {
                // 取最后一个非测量的编辑器（页面通常有多个，measuring 克隆通常在前面）
                best = el;
            }
        }
        if (best) return best;
        return null;
    }

    // 发送消息
    // 等待编辑器就绪（最长 10 秒），抗 SPA 导航/视图切换
    function waitForEditorReady(timeoutMs) {
        timeoutMs = timeoutMs || 10000;
        return new Promise(function(resolve) {
            var start = Date.now();
            function check() {
                var ed = findVisibleEditor();
                if (ed) { resolve(ed); return; }
                if (Date.now() - start > timeoutMs) { resolve(null); return; }
                setTimeout(check, 200);
            }
            check();
        });
    }

    Q.sendMessage = function(text) {
        // Keep the exact submitted turn so extraction can reject a user-bubble
        // copy. Qwen's current DOM may place the user node after the assistant
        // markdown node even though it appears above it visually.
        Q._lastSentText = String(text || '');
        // P3: 模型微调指令（Qwen → 中文输出锁定，由 prompt-builder 兜底此处）
        return new Promise(function(resolve) {
            // 0. 先等编辑器就绪（newChat 已确保就绪，此处仅兜底，3s 足够）
            waitForEditorReady(3000).then(function(input) {
            if (!input) {
                // 未找到可见编辑器：遍历所有 contenteditable，排除测量克隆体
                // 取最后一个非测量的（真实编辑器通常在测量克隆之后）
                var allCE = document.querySelectorAll('[contenteditable="true"]');
                var bestCE = null;
                for (var i = 0; i < allCE.length; i++) {
                    var el = allCE[i];
                    if (el.getAttribute('contenteditable') !== 'true') continue;
                    var parent = el.parentElement;
                    var isMeasure = false;
                    while (parent) {
                        if (parent.getAttribute && parent.getAttribute('data-testid') && parent.getAttribute('data-testid').toString().indexOf('measure') !== -1) {
                            isMeasure = true;
                            break;
                        }
                        parent = parent.parentElement;
                    }
                    if (isMeasure) continue;
                    if (el.getAttribute('data-slate-editor') === 'true') {
                        bestCE = el;
                    } else if (!bestCE) {
                        bestCE = el;
                    }
                }
                input = bestCE;
            }
            if (!input) {
                // 再兜底：不排除测量克隆，直接取最后一个 data-slate-editor
                // 有些页面真实编辑器也在测量容器内
                var allCE2 = document.querySelectorAll('[contenteditable="true"][data-slate-editor="true"]');
                if (allCE2.length > 0) {
                    input = allCE2[allCE2.length - 1];
                }
            }
            if (!input) {
                // 再兜底：取最后一个非 hidden 的 contenteditable
                var allCE3 = document.querySelectorAll('[contenteditable="true"]');
                for (var i = allCE3.length - 1; i >= 0; i--) {
                    if (allCE3[i].offsetWidth > 0 || allCE3[i].offsetHeight > 0) {
                        input = allCE3[i];
                        break;
                    }
                }
            }
            if (!input) {
                // 兜底：找非 disabled 的 textarea
                var textareas = document.querySelectorAll('textarea');
                for (var i = 0; i < textareas.length; i++) {
                    if (!textareas[i].disabled && !textareas[i].readOnly) {
                        input = textareas[i];
                        break;
                    }
                }
            }
            if (!input) {
                resolve({ success: false, error: 'Input field not found' });
                return;
            }

            // 2. 聚焦输入框
            input.focus();
            input.click();

            // 3. 清空占位符（先清除已有内容）+ 插入文本
            if (input.isContentEditable) {
                var sel = window.getSelection();
                var range = document.createRange();
                range.selectNodeContents(input);
                range.deleteContents();
                sel.removeAllRanges();
                sel.addRange(range);

                // 离屏视图（Agent 模式 x:-10000）下 execCommand('insertText') 不可靠：
                // Slate.js 原生支持 ClipboardEvent('paste')，不依赖焦点/可见性
                var _inserted = false;
                try {
                    var dt = new DataTransfer();
                    dt.setData('text/plain', text || '');
                    input.dispatchEvent(new ClipboardEvent('paste', {
                        clipboardData: dt, bubbles: true, cancelable: true
                    }));
                    _inserted = true;
                } catch(e) { /* DataTransfer 不支持时回退 */ }

                // 兜底：execCommand insertText（可见视图下有效）
                try {
                    document.execCommand('insertText', false, text || '');
                } catch(e) {}

                // 触发 input 事件，确保 Slate.js 感知到变化
                input.dispatchEvent(new Event('input', { bubbles: true }));
            } else if (input.tagName === 'TEXTAREA') {
                var nativeSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value');
                if (nativeSetter && nativeSetter.set) {
                    nativeSetter.set.call(input, text || '');
                } else {
                    input.value = text || '';
                }
                input.dispatchEvent(new Event('input', { bubbles: true }));
            } else {
                input.value = text || '';
                input.dispatchEvent(new Event('input', { bubbles: true }));
            }

            // 4. 发送：优先用 Enter 键（Slate 编辑器原生支持），失败立即回退按钮点击
            var start = Date.now();
            function tryEnterKey() {
                try { input.focus(); } catch(e) {}
                var ke = new KeyboardEvent('keydown', {
                    key: 'Enter', code: 'Enter', keyCode: 13, which: 13,
                    bubbles: true, cancelable: true
                });
                input.dispatchEvent(ke);
                // 验证：200ms 后检查生成态（缩短等待）
                setTimeout(function() {
                    if (isGeneratingNow() || findStopButton()) {
                        resolve({ success: true, method: 'enter-key' });
                    } else {
                        waitAndClick();
                    }
                }, 200);
            }
            function waitAndClick() {
                var sendBtn = findSendButton();
                if (sendBtn && !sendBtn.disabled) {
                    sendBtn.click();
                    // 验证：250ms 后检查生成态
                    setTimeout(function() {
                        if (isGeneratingNow() || findStopButton()) {
                            resolve({ success: true, method: 'click-send' });
                        } else {
                            // 立即再点一次（不等待）
                            var btn2 = findSendButton();
                            if (btn2 && !btn2.disabled) { btn2.click(); resolve({ success: true, method: 'click-send-retry' }); }
                            else { resolve({ success: true, method: 'click-send-unknown' }); }
                        }
                    }, 250);
                } else if (Date.now() - start > 6000) {
                    resolve({ success: false, error: 'Send button not ready after 6s' });
                } else {
                    setTimeout(waitAndClick, 100);
                }
            }
            tryEnterKey();
            // 发送后预期进入 SPA 导航，置 navigating=true 阻止 MutationObserver 在过渡期 .click()
            if (typeof Q._navigating !== 'undefined') Q._navigating = true;
            });  // 闭合 waitForEditorReady().then()
        });
    };

    // 聚焦到输入编辑器
    Q.focusEditor = function() {
        var editor = findVisibleEditor();
        if (!editor) {
            // 兜底：findVisibleEditor 全部失败时，取最后一个 contenteditable
            var allCE = document.querySelectorAll('[contenteditable="true"]');
            for (var i = allCE.length - 1; i >= 0; i--) {
                if (allCE[i].offsetWidth > 0 || allCE[i].offsetHeight > 0) {
                    editor = allCE[i];
                    break;
                }
            }
            if (!editor && allCE.length > 0) editor = allCE[allCE.length - 1];
        }
        if (editor) {
            editor.focus();
            return { success: true };
        }
        return { success: false, error: 'Editor not found' + (allCE ? ' (' + allCE.length + ' total)' : '') };
    };

    // 在编辑器末尾追加文本（不清除已有内容），然后发送
    Q.appendTextAndSend = function(text) {
        return new Promise(function(resolve) {
            try {
                var editor = findVisibleEditor();
                if (!editor) { resolve({ success: false, error: 'Editor not found' }); return; }
                editor.focus();
                var sel = window.getSelection();
                var range = document.createRange();
                range.selectNodeContents(editor);
                range.collapse(false);
                sel.removeAllRanges();
                sel.addRange(range);
                var success = document.execCommand('insertText', false, text || '');
                editor.dispatchEvent(new Event('input', { bubbles: true }));
                // 等待按钮就绪后发送
                setTimeout(function() {
                    var sendBtn = findSendButton();
                    if (sendBtn && !sendBtn.disabled) {
                        sendBtn.click();
                        setTimeout(function() {
                            if (findStopButton()) {
                                resolve({ success: true, method: 'append-click' });
                            } else {
                                var btn2 = findSendButton();
                                if (btn2 && !btn2.disabled) {
                                    btn2.click();
                                }
                                resolve({ success: true, method: 'append-click-retry' });
                            }
                        }, 1000);
                    } else {
                        resolve({ success: false, error: 'Send button not ready after append' });
                    }
                }, 500);
            } catch(e) {
                resolve({ success: false, error: e.message });
            }
        });
    };

    // 直接点击发送按钮（粘贴图片后使用，加验证和重试）
    Q.clickSend = function() {
        return new Promise(function(resolve) {
            // 如果发送按钮不可用，等待其恢复（上传图片/文件时短时 disabled）
            waitForBtnEnabled().then(function() {
                var sendBtn = findSendButton();
                if (sendBtn && !sendBtn.disabled) {
                    sendBtn.click();
                    setTimeout(function() {
                        if (findStopButton()) {
                            resolve({ success: true, method: 'click' });
                        } else {
                            var btn2 = findSendButton();
                            if (btn2 && !btn2.disabled) {
                                btn2.click();
                                resolve({ success: true, method: 'click-retry' });
                            } else {
                                resolve({ success: true, method: 'click-unknown' });
                            }
                        }
                    }, 1000);
                } else {
                    resolve({ success: false, error: 'Send button not found or disabled' });
                }
            });
        });
    };

    // 等待发送按钮可用（内部辅助）
    function waitForBtnEnabled(timeout) {
        timeout = timeout || 120000;
        var start = Date.now();
        return new Promise(function(resolve) {
            function check() {
                var btn = findSendButton();
                if (btn && !btn.disabled) { resolve(); return; }
                if (Date.now() - start > timeout) { resolve(); return; }
                setTimeout(check, 500);
            }
            check();
        });
    }

    // 等待发送按钮变为可发送状态（灰→待发送）
    Q.waitForSendButton = function(timeout) {
        timeout = timeout || 30000;
        var start = Date.now();
        return new Promise(function(resolve) {
            function check() {
                var btn = findSendButton();
                if (btn && !btn.disabled) {
                    resolve({ success: true });
                    return;
                }
                if (Date.now() - start > timeout) {
                    resolve({ success: false, error: 'Send button did not become ready' });
                } else {
                    setTimeout(check, 300);
                }
            }
            check();
        });
    };

    // 检测 Qwen 是否正在回复中（aria-label="停止回答"）
    function isResponding() {
        var btn = findStopButton();
        return btn !== null;
    }

    // 等待回复完成（运行→按钮变灰为完成）
    Q.waitForResponse = function(timeout) {
        timeout = timeout || 120000;
        var start = Date.now();
        return new Promise(function(resolve) {
            function checkDone() {
                // 1. 仍在回复中 → 继续等待
                if (isResponding()) {
                    if (Date.now() - start > timeout) {
                        resolve({ success: false, error: 'Timeout' });
                    } else {
                        setTimeout(checkDone, 500);
                    }
                    return;
                }

                // 2. 检查是否有禁用的发送按钮（输出已完全结束）
                //    状态特征：aria-label="发送消息" + disabled
                var disabledBtn = document.querySelector('button[aria-label="发送消息"][disabled]');
                if (disabledBtn) {
                    resolve({ success: true, method: 'completed' });
                    return;
                }

                // 3. 检查是否有可用的发送按钮（待发送状态）
                var enabledBtn = findSendButton();
                if (enabledBtn && !enabledBtn.disabled) {
                    resolve({ success: true, method: 'ready' });
                    return;
                }

                // 4. 过渡状态（按钮暂未出现），继续等待
                if (Date.now() - start > timeout) {
                    resolve({ success: false, error: 'Timeout' });
                } else {
                    setTimeout(checkDone, 500);
                }
            }
            checkDone();
        });
    };

    // 暴露 isResponding 给外部检查
    Q.isResponding = function() {
        return { responding: isResponding() };
    };

    // 暴露 isGeneratingNow（多信号生成状态检测）给 server 层调用
    Q.isGeneratingNow = function() {
        return { generating: isGeneratingNow() };
    };

    // 当前图片生成的阶段（用于 debug 显示）
    var drawPhase = { current: 0, detail: '' };
    Object.defineProperty(Q, 'getDrawPhase', { value: function() { return drawPhase; }, writable: false });

    // 等待图片生成的完整回复
    // 策略：快速轮询(100ms)检测"运行→停止"的转换，每次转换算一个阶段完成
    // 第一阶段：文字生成（文本输出结束）
    // 第二阶段：图片生成（图片输出结束）
    Q.waitForDrawResponse = function(timeout) {
        timeout = timeout || 300000;
        var start = Date.now();
        var phase = 1;                // 1=文字生成, 2=图片检测
        var wasResponding = false;
        var lastImageUrls = '';       // 上次检测到的图片 URL 签名
        var imageStableSince = 0;     // 图片开始稳定的时间

        drawPhase.current = 0;
        drawPhase.detail = '等待开始...';

        return new Promise(function(resolve) {
            function showPhase(num, text) {
                drawPhase.current = num;
                drawPhase.detail = text;
                Q.setStatus('[图生] ' + text);
            }

            function getImageSignature() {
                // Qianwen used to return a four-variant grid, but the current
                // image mode may return one large result. Reuse the scoped
                // extractor so singular cards and renamed card wrappers share
                // exactly the same acceptance rules as the final extraction.
                var urls = Q.getLastImageUrls ? Q.getLastImageUrls() : [];
                return urls.length ? urls.join('||') : '';
            }

            function check() {
                if (Date.now() - start > timeout) {
                    showPhase(5, '超时');
                    resolve({ success: false, error: 'Timeout' });
                    return;
                }

                var nowResponding = isResponding();
                var disabledBtn = document.querySelector('button[aria-label="发送消息"][disabled]');
                var enabledBtn = findSendButton();

                // 绘图错误检测（任何阶段）
                if (phase >= 1) {
                    var errCheck = Q.checkDrawError();
                    if (errCheck.hasError) {
                        showPhase(0, '生成失败: ' + errCheck.keyword);
                        resolve({ success: false, error: errCheck.keyword });
                        return;
                    }
                }

                // ===== 第一阶段：文字生成 =====
                if (phase === 1) {
                    if (wasResponding && !nowResponding) {
                        // 文字生成结束 → 进入图片检测阶段
                        if (disabledBtn || (enabledBtn && !enabledBtn.disabled)) {
                            phase = 2;
                            showPhase(2, '阶段1/2: 文字完成，检测图片...');
                            // 立即获取当前图片签名
                            lastImageUrls = getImageSignature();
                            imageStableSince = Date.now();
                            setTimeout(check, 500);
                            return;
                        }
                        // 按钮不确定，再等一轮
                        wasResponding = false;
                        setTimeout(check, 200);
                        return;
                    }

                    wasResponding = nowResponding;

                    if (nowResponding) {
                        showPhase(1, '阶段1/2: 文字生成中...');
                        setTimeout(check, 100);
                        return;
                    }
                    if (disabledBtn) {
                        // 第一阶段太快，错过了运行状态，但按钮已变灰 → 进入图片检测
                        phase = 2;
                        showPhase(2, '阶段1/2: 文字完成，检测图片...');
                        lastImageUrls = getImageSignature();
                        imageStableSince = Date.now();
                        setTimeout(check, 500);
                        return;
                    }
                    setTimeout(check, 100);
                    return;
                }

                // ===== 第二阶段：图片检测 =====
                if (phase === 2) {
                    var currentSig = getImageSignature();
                    if (!currentSig) {
                        // 还没有图片，继续等待
                        showPhase(2, '阶段2/2: 等待图片...');
                        setTimeout(check, 500);
                        return;
                    }

                    // 图片 URL、尺寸和完成状态稳定两秒后才算完成，避免把
                    // loading 占位图或消息头像误判为生成结果。
                    if (currentSig !== lastImageUrls) {
                        lastImageUrls = currentSig;
                        imageStableSince = Date.now();
                    }
                    if (Date.now() - imageStableSince >= 2000) {
                        showPhase(5, '全部完成!');
                        resolve({ success: true });
                        return;
                    }
                    showPhase(2, '阶段2/2: 图片加载中...');
                    setTimeout(check, 500);
                    return;
                }
            }

            setTimeout(check, 50);
        });
    };

    // 获取绘图进度（供外部轮询用）
    Q.getDrawProgress = function() {
        return { current: drawPhase.current, detail: drawPhase.detail };
    };

    // ======== PPT 生成相关 ========

    // 等待 PPT 卡片出现（data-ppt-id 属性），并滚动到可见位置
    Q.waitForPPTResponse = function(timeout) {
        timeout = timeout || 1800000;
        var start = Date.now();
        console.log('[Qwen PPT] 开始等待 PPT 卡片...');
        return new Promise(function(resolve) {
            function check() {
                if (Date.now() - start > timeout) {
                    console.log('[Qwen PPT] 超时');
                    resolve({ success: false, error: 'Timeout' });
                    return;
                }
                var pptCard = document.querySelector('[data-ppt-id]');
                if (pptCard) {
                    console.log('[Qwen PPT] 找到 PPT 卡片, data-ppt-id=' + pptCard.getAttribute('data-ppt-id'));
                    // 滚动到 PPT 卡片可见
                    pptCard.scrollIntoView({ behavior: 'smooth', block: 'center' });
                    resolve({ success: true, pptId: pptCard.getAttribute('data-ppt-id') });
                    return;
                }
                setTimeout(check, 500);
            }
            setTimeout(check, 100);
        });
    };

    // 点击 PPT 卡片中的下载按钮，触发下载
    Q.clickPPTDownload = function() {
        console.log('[Qwen PPT] 查找下载按钮...');
        var pptCard = document.querySelector('[data-ppt-id]');
        if (!pptCard) {
            return { success: false, error: 'No PPT card found' };
        }
        // 在 PPT 卡片内查找下载按钮（btn-wrapper 类）
        var downloadBtn = pptCard.querySelector('[class*="btn-wrapper"]');
        if (!downloadBtn) {
            // 回退：查找所有 btn-wrapper 并在 PPT 卡片后面的
            downloadBtn = document.querySelector('[data-ppt-id] ~ [class*="btn-wrapper"], [data-ppt-id] [class*="btn-wrapper"]');
        }
        if (!downloadBtn) {
            console.log('[Qwen PPT] 未找到下载按钮，尝试点击 office-card 内的可点击元素');
            var clickable = pptCard.querySelector('button, [role="button"], [class*="btn"]');
            if (clickable) {
                clickable.click();
                console.log('[Qwen PPT] 已点击备选下载按钮');
                return { success: true };
            }
            return { success: false, error: 'No download button found' };
        }
        console.log('[Qwen PPT] 点击下载按钮:', downloadBtn.className);
        downloadBtn.click();
        return { success: true };
    };

    // 等待纯文本回复完成（类似 waitForDrawResponse 但只有文字阶段，无需检测图片）
    // 使用100ms快速轮询 + 状态转换检测，专为后台模式优化
    Q.waitForTextResponse = function(timeout) {
        timeout = timeout || 120000;
        var start = Date.now();
        var wasResponding = false;
        var completed = false;

        return new Promise(function(resolve) {
            function check() {
                if (completed) return;
                if (Date.now() - start > timeout) {
                    resolve({ success: false, error: 'Timeout' });
                    return;
                }

                var nowResponding = isResponding();
                var disabledBtn = document.querySelector('button[aria-label="发送消息"][disabled]');
                var enabledBtn = findSendButton();

                // 检测转换：正在运行 → 停止运行（回复完成）
                if (wasResponding && !nowResponding) {
                    // 转换完成，检查按钮状态确认
                    if (disabledBtn || (enabledBtn && !enabledBtn.disabled)) {
                        completed = true;
                        resolve({ success: true });
                        return;
                    }
                }

                wasResponding = nowResponding;

                // 检查错误
                var errCheck = Q.checkDrawError();
                if (errCheck.hasError) {
                    completed = true;
                    resolve({ success: false, error: errCheck.keyword });
                    return;
                }

                // 未开始：等待
                if (!nowResponding && !disabledBtn && !enabledBtn) {
                    setTimeout(check, 200);
                    return;
                }

                // 正在输出
                if (nowResponding) {
                    setTimeout(check, 100);
                    return;
                }

                // 输出结束但按钮状态不明
                if (disabledBtn) {
                    setTimeout(check, 200);
                    return;
                }

                // 按钮可用（待发送状态）→ 回复已完成
                if (enabledBtn && !enabledBtn.disabled) {
                    completed = true;
                    resolve({ success: true });
                    return;
                }

                setTimeout(check, 200);
            }

            setTimeout(check, 50);
        });
    };

    // 检测绘图错误：阶段1完成后检查页面是否出现"当前内容无法生成"等错误提示
    Q.checkDrawError = function() {
        var errorKeywords = ['当前内容无法生成', 'content generation failed'];
        var bodyText = document.body ? (document.body.innerText || '') : '';
        for (var i = 0; i < errorKeywords.length; i++) {
            if (bodyText.indexOf(errorKeywords[i]) !== -1) {
                return { hasError: true, keyword: errorKeywords[i] };
            }
        }
        return { hasError: false };
    };

    var ASSISTANT_CONTENT_SELECTOR = '[data-message-author-role="assistant"], [data-role="assistant"], [data-author="assistant"], [data-testid*="assistant"], .markdown-pc-special-class, .qk-markdown';
    var MESSAGE_SCOPE_SELECTOR = '[data-message-author-role], [data-role], [class*="message"], [class*="chat-item"], [class*="conversation-item"]';
    var USER_SCOPE_SELECTOR = '[data-message-author-role="user"], [data-role="user"], [data-author="user"], [data-testid*="user-message"], [class*="user-message"], [class*="message-user"]';
    var MARKDOWN_SELECTOR = '.markdown-pc-special-class, .qk-markdown';
    var COPY_PATH_SELECTOR = 'svg path[d*="M832 64"]';

    function isInsideUserMessage(node) {
        return !!(node && node.closest && node.closest(USER_SCOPE_SELECTOR));
    }

    function isInsideComposer(node) {
        return !!(node && node.closest && node.closest('[contenteditable="true"], textarea, [class*="composer"], [class*="chat-input"], [class*="input-area"]'));
    }

    function lastAssistantContentNode() {
        var nodes = Array.from(document.querySelectorAll(ASSISTANT_CONTENT_SELECTOR)).filter(function(node) {
            return !isInsideUserMessage(node) && !isInsideComposer(node);
        });
        if (!nodes.length) return null;
        var candidate = nodes[nodes.length - 1];
        // An explicit assistant message wrapper may contain the stable Markdown
        // body. Returning the body avoids toolbar labels and hidden metadata.
        if (candidate.querySelector) {
            var markdown = candidate.querySelector(MARKDOWN_SELECTOR);
            if (markdown && !isInsideUserMessage(markdown)) return markdown;
        }
        return candidate;
    }

    function assistantMessageScope() {
        var content = lastAssistantContentNode();
        if (!content) return null;
        var explicit = content.closest && content.closest('[data-message-author-role="assistant"], [data-role="assistant"], [data-author="assistant"], [data-testid*="assistant"]');
        if (explicit) return explicit;
        var scope = content.closest && content.closest(MESSAGE_SCOPE_SELECTOR);
        if (scope && !isInsideUserMessage(scope)) return scope;

        // Hash-based Qwen class names sometimes leave only .qk-markdown stable.
        // Walk outward while the parent still owns exactly this one Markdown
        // response so sibling action buttons remain inside the scope.
        var current = content;
        for (var depth = 0; current && current.parentElement && depth < 8; depth++) {
            var parent = current.parentElement;
            var bodies = parent.querySelectorAll ? parent.querySelectorAll(MARKDOWN_SELECTOR) : [];
            if (bodies.length > 1 || isInsideUserMessage(parent)) break;
            current = parent;
        }
        return current || content;
    }

    function cleanAssistantText() {
        var content = lastAssistantContentNode();
        if (!content) return '';
        var clone = content.cloneNode(true);
        var extras = clone.querySelectorAll ? clone.querySelectorAll('script, style, template, [hidden], [aria-hidden="true"], button, [role="button"], img, [class*="popMenu"], [class*="imageItem"], [class*="imageWrapper"]') : [];
        for (var i = 0; i < extras.length; i++) extras[i].remove();
        return (clone.innerText || clone.textContent || '').trim();
    }

    function normalizedTurnText(value) {
        return String(value || '').replace(/\r/g, '').replace(/[\s\u00a0]+/g, ' ').trim();
    }

    Q.isLastUserEcho = function(value) {
        var extracted = normalizedTurnText(value);
        var submitted = normalizedTurnText(Q._lastSentText || window.__dsagent_qwenLastUserText || '');
        return !!extracted && !!submitted && extracted === submitted;
    };

    Q.getLastAssistantScope = assistantMessageScope;

    // 获取最后回复中的图片 URL
    // Qwen 图片结构既可能是旧四图卡，也可能是新版单图结果。
    Q.getLastImageUrls = function() {
        var urls = [];
        var scope = assistantMessageScope();
        var cardSelector = '[data-card-type="ai_generate_image_list"], [data-card-type*="generate_image"], [data-card-type*="image_generate"], [data-testid*="generated-image"], [data-testid*="image-generation"]';
        var cards = scope && scope.querySelectorAll ? scope.querySelectorAll(cardSelector) : [];
        if ((!cards || !cards.length) && document.querySelectorAll) {
            cards = Array.from(document.querySelectorAll(cardSelector)).filter(function(node) {
                return !isInsideUserMessage(node) && !isInsideComposer(node);
            });
        }
        var card = cards.length ? cards[cards.length - 1] : null;
        var root = card || scope;
        if (!root) return urls;

        function imageUrl(image) {
            var candidates = [
                image.currentSrc,
                image.src,
                image.getAttribute && image.getAttribute('data-src'),
                image.getAttribute && image.getAttribute('data-original')
            ];
            var srcset = image.getAttribute && image.getAttribute('srcset');
            if (srcset) {
                var last = srcset.split(',').map(function(item) { return item.trim().split(/\s+/)[0]; }).filter(Boolean).pop();
                if (last) candidates.unshift(last);
            }
            for (var ci = 0; ci < candidates.length; ci++) {
                var value = String(candidates[ci] || '').trim();
                if (value && !/^data:|^blob:/i.test(value)) return value;
            }
            return '';
        }

        // 图片卡中的完整结果。尺寸与助手回复归属比哈希类名稳定；
        // 192px 下限排除头像和工具栏图标，同时兼容缩小后的单图预览。
        var imageItems = root.querySelectorAll('img');
        for (var i = 0; i < imageItems.length; i++) {
            var src = imageUrl(imageItems[i]);
            var width = imageItems[i].naturalWidth || imageItems[i].width || 0;
            var height = imageItems[i].naturalHeight || imageItems[i].height || 0;
            var rect = imageItems[i].getBoundingClientRect ? imageItems[i].getBoundingClientRect() : { width: 0, height: 0 };
            if (src && Math.max(width, rect.width || 0) >= 192 && Math.max(height, rect.height || 0) >= 192 && urls.indexOf(src) === -1) {
                urls.push(src);
            }
        }

        // 方式二：查找最后一条消息中的所有图片（兜底）
        if (urls.length === 0 && !card) {
            if (scope) {
                var imgs = scope.querySelectorAll('img');
                for (var i = 0; i < imgs.length; i++) {
                    var src = imageUrl(imgs[i]);
                    var rect = imgs[i].getBoundingClientRect ? imgs[i].getBoundingClientRect() : { width: 0, height: 0 };
                    if (src && Math.max(imgs[i].naturalWidth || imgs[i].width || 0, rect.width || 0) >= 192 && Math.max(imgs[i].naturalHeight || imgs[i].height || 0, rect.height || 0) >= 192 && urls.indexOf(src) === -1) {
                        urls.push(src);
                    }
                }
            }
        }

        return urls;
    };

    // 获取最后回复的文本（只返回文字部分，排除图片区域）
    // Qwen 回复结构：先文字 → 再图片（含"修改建议"等）
    Q.getLastResponseText = function() {
        return cleanAssistantText();
    };

    // 获取第一阶段文字（图片前面的文字，不含后面的修改建议）
    // Qwen 回复结构：[文字] [图片] [修改建议 + 隐藏的JSON控件数据]
    // 克隆消息节点 → 删除从第一条图片开始的所有后续元素 → 取剩余文字
    Q.getPhase1Text = function() {
        var lastMsg = assistantMessageScope();
        if (!lastMsg) return '';

        // The prose is rendered in a dedicated markdown node while the image
        // card carries embedded JSON and CSS. Prefer that stable semantic split.
        var markdownNode = lastMsg.querySelector && lastMsg.querySelector('.markdown-pc-special-class, .qk-markdown');
        if (markdownNode) return (markdownNode.innerText || markdownNode.textContent || '').trim();

        // 克隆以避免修改真实 DOM
        var clone = lastMsg.cloneNode(true);

        // 先移除隐藏的 script/style/hidden 元素（这些会产生 JSON 控件数据）
        var invisibleEls = clone.querySelectorAll('script, style, [style*="display:none"], [style*="display: none"], [hidden], template');
        for (var i = 0; i < invisibleEls.length; i++) invisibleEls[i].remove();

        // 生图卡片包含 hydration JSON/CSS；正文只保留卡片外的自然语言。
        // If the selector resolved to the card itself, detaching the cloned root
        // would not clear its children. In that case there is no trustworthy
        // natural-language prefix to return.
        if (clone.matches && clone.matches('[data-card-type="ai_generate_image_list"]')) return '';
        var generatedCard = clone.querySelector('[data-card-type="ai_generate_image_list"]');
        if (generatedCard) generatedCard.remove();

        // 查找第一条图片容器
        var firstImageContainer = clone.querySelector('[class*="imageItem"], [class*="imageWrapper"]');
        if (firstImageContainer) {
            // 删除从第一条图片开始及其之后的所有兄弟元素
            var current = firstImageContainer;
            while (current) {
                var next = current.nextElementSibling || current.nextSibling;
                current.parentNode.removeChild(current);
                current = next;
            }
            // firstImageContainer 在 while 循环中已经被删了
        }

        // 移除剩余的所有图片/菜单元素
        var extras = clone.querySelectorAll('img, [class*="popMenu"], [class*="imageItem"], [class*="imageWrapper"]');
        for (var i = 0; i < extras.length; i++) extras[i].remove();

        // 取文本内容
        return (clone.textContent || '').trim();
    };

    // 检测最后一条回复的"复制按钮"是否已出现（渲染完成信号）
    // 复用 copyLastResponse 的 tryFindButton 定位逻辑，但只返回 bool，不点击、不等待
    Q.hasCopyButton = function() {
        var assistant = assistantMessageScope();
        if (!assistant) return { success: true, has: false };
        // 方案1：复制图标 SVG 路径
        var copySvgs = assistant.querySelectorAll(COPY_PATH_SELECTOR);
        var copySvg = copySvgs.length ? copySvgs[copySvgs.length - 1] : null;
        if (copySvg) {
            var btn = copySvg.closest('[class*="hover:bg-tag"][class*="cursor-pointer"]') || copySvg.parentElement;
            if (btn) {
                var rect = btn.getBoundingClientRect();
                if (rect.width > 0 && rect.height > 0) return { success: true, has: true };
            }
        }
        // 方案2：hover:bg-tag + cursor-pointer + 复制图标
        var tagBtns = assistant.querySelectorAll('[class*="hover:bg-tag"][class*="cursor-pointer"]');
        for (var i = 0; i < tagBtns.length; i++) {
            if (tagBtns[i].querySelector('svg path[d*="M832 64"]')) {
                var r2 = tagBtns[i].getBoundingClientRect();
                if (r2.width > 0 && r2.height > 0) return { success: true, has: true };
            }
        }
        // 方案3：最后一条 AI 消息工具栏内
        var msgBtns = assistant.querySelectorAll('[class*="hover:bg-tag"][class*="cursor-pointer"]');
        for (var i = 0; i < msgBtns.length; i++) {
            if (msgBtns[i].querySelector(COPY_PATH_SELECTOR)) return { success: true, has: true };
        }
        return { success: true, has: false };
    };

    // 通过点击复制按钮 + 读剪贴板提取 AI 回复（拿到原始 markdown，不丢格式）
    // 模仿 DeepSeek 的提取链路：保存剪贴板 → 找复制按钮 → 点击 → 读剪贴板 → 恢复剪贴板
    // 找复制按钮坐标（不点击）——供主进程用 sendInputEvent 真实鼠标点击
    // 精准定位：最后一条消息内的 div.cursor-pointer + svg path[d^="M832 64"]
    // 最多等 10s，找到返回 {success:true, x, y}，找不到返回 {success:false}
    Q.findCopyButtonCoord = async function() {
        function findBtn() {
            var lastMsg = assistantMessageScope();
            if (!lastMsg) return null;
            var divs = lastMsg.querySelectorAll('div[class*="cursor-pointer"]');
            for (var i = 0; i < divs.length; i++) {
                var path = divs[i].querySelector('svg path[d^="M832 64"]');
                if (!path) continue;
                var rect = divs[i].getBoundingClientRect();
                if (rect.width > 0 && rect.height > 0) return divs[i];
            }
            return null;
        }
        var btnStart = Date.now();
        while (Date.now() - btnStart < 10000) {
            var btn = findBtn();
            if (btn) {
                var r = btn.getBoundingClientRect();
                return { success: true, x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
            }
            await new Promise(function(res){ setTimeout(res, 200); });
        }
        return { success: false, error: 'copy button not found' };
    };

    // 读剪贴板并恢复原内容（点击复制按钮后调用）
    // 先保存原剪贴板 → 读剪贴板(重试5次) → 恢复原剪贴板
    // 返回 {markdown, source, error?}
    Q.readClipboardAndRestore = async function() {
        var savedClipboard = null;
        try {
            try {
                if (window.electronAPI && window.electronAPI.clipboardSave) {
                    savedClipboard = await window.electronAPI.clipboardSave();
                }
            } catch(e) {}

            var markdown = '';
            for (var retry = 0; retry < 5; retry++) {
                try {
                    if (window.electronAPI && window.electronAPI.clipboardReadText) {
                        markdown = await window.electronAPI.clipboardReadText();
                    }
                } catch(e) {}
                if (markdown && markdown.length > 0) break;
                await new Promise(function(r){ setTimeout(r, 200); });
            }

            if (!markdown) {
                return { markdown: '', source: 'dom-fallback', error: 'clipboard empty' };
            }
            if (Q.isLastUserEcho(markdown)) {
                var assistantText = cleanAssistantText();
                return { markdown: assistantText, source: 'dom-assistant', error: 'clipboard selected the user message' };
            }
            return { markdown: markdown, source: 'clipboard' };
        } catch(e) {
            return { markdown: '', source: 'dom-fallback', error: e.message };
        } finally {
            if (savedClipboard) {
                try {
                    if (window.electronAPI && window.electronAPI.clipboardRestore) {
                        await window.electronAPI.clipboardRestore(savedClipboard, markdown);
                    }
                } catch(e) {}
            }
        }
    };

    // 通过两步菜单提取完整 Markdown：点击右侧箭头 → 点击"复制为Markdown"
    // 避免直接点复制按钮漏掉代码框；返回 markdown 文本
    Q.extractViaCopyAsMarkdown = async function() {
        var savedClipboard = null;
        try {
            try {
                if (window.electronAPI && window.electronAPI.clipboardSave) {
                    savedClipboard = await window.electronAPI.clipboardSave();
                }
            } catch(e) {}

            // 1. 找到最后一条消息中的右侧箭头按钮（旋转90度的右箭头，菜单展开器）
            function findMenuArrowBtn() {
                var lastMsg = assistantMessageScope();
                if (!lastMsg) return null;
                // 找 path[d="M7.475 14.558..."] 的右箭头（菜单展开按钮）
                var paths = lastMsg.querySelectorAll('svg path[d^="M7.475"]');
                for (var i = 0; i < paths.length; i++) {
                    var btn = paths[i].closest('button');
                    if (btn) {
                        var rect = btn.getBoundingClientRect();
                        if (rect.width > 0 && rect.height > 0) return btn;
                    }
                }
                return null;
            }

            var arrowBtn = null;
            var start = Date.now();
            while (Date.now() - start < 10000) {
                arrowBtn = findMenuArrowBtn();
                if (arrowBtn) break;
                await new Promise(function(r){ setTimeout(r, 200); });
            }
            if (!arrowBtn) {
                // 兜底：旧复制按钮
                var fb = Q.extractLastResponse ? Q.extractLastResponse() : { markdown: Q.getLastResponseText ? Q.getLastResponseText() : '', images: [] };
                return { markdown: fb.markdown || '', images: fb.images || [], source: 'dom-fallback', error: 'menu arrow not found' };
            }

            // 2. 点击箭头展开菜单（dispatchEvent 兼容 Radix UI）
            arrowBtn.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true, view: window }));
            arrowBtn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
            arrowBtn.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, cancelable: true, view: window }));
            arrowBtn.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
            arrowBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));

            // 3. 等待"复制为Markdown"菜单项出现并点击
            var mdBtn = null;
            var menuStart = Date.now();
            while (Date.now() - menuStart < 5000) {
                // 查找复制的菜单项：包含"复制为Markdown"文本的按钮或菜单项
                var allBtns = document.querySelectorAll('button, [role="menuitem"], [role="option"], [class*="menu"] button, [class*="dropdown"] *');
                for (var i = 0; i < allBtns.length; i++) {
                    var txt = allBtns[i].textContent.trim();
                    if (txt === '复制为Markdown' || txt === '复制为 Markdown' || txt.indexOf('复制为Markdown') !== -1 || txt === 'Copy as Markdown') {
                        mdBtn = allBtns[i];
                        break;
                    }
                }
                if (mdBtn) break;
                await new Promise(function(r){ setTimeout(r, 100); });
            }

            if (mdBtn) {
                mdBtn.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true, view: window }));
                mdBtn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
                mdBtn.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, cancelable: true, view: window }));
                mdBtn.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
                mdBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
            } else {
                // 兜底：没找到菜单项，直接点原始复制按钮
                var copyBtn = arrowBtn.parentElement ? arrowBtn.parentElement.querySelector('[class*="cursor-pointer"] svg path[d^="M832 64"]') : null;
                if (copyBtn) {
                    var realBtn = copyBtn.closest('[class*="cursor-pointer"]');
                    if (realBtn) {
                        try { realBtn.click(); } catch(e) {}
                    }
                }
            }

            // 4. 读剪贴板
            var markdown = '';
            for (var retry = 0; retry < 5; retry++) {
                try {
                    if (window.electronAPI && window.electronAPI.clipboardReadText) {
                        markdown = await window.electronAPI.clipboardReadText();
                    }
                } catch(e) {}
                if (markdown && markdown.length > 0) break;
                await new Promise(function(r){ setTimeout(r, 200); });
            }

            if (!markdown) {
                var fb2 = Q.extractLastResponse ? Q.extractLastResponse() : { markdown: Q.getLastResponseText ? Q.getLastResponseText() : '', images: [] };
                return { markdown: fb2.markdown || '', images: fb2.images || [], source: 'dom-fallback', error: 'clipboard empty after menu click' };
            }

            if (Q.isLastUserEcho(markdown)) {
                var assistantText = cleanAssistantText();
                return { markdown: assistantText, images: [], source: 'dom-assistant', error: 'copy action targeted the user message' };
            }

            return { markdown: markdown, images: [], source: 'clipboard-menu' };
        } catch(e) {
            var fb3 = Q.extractLastResponse ? Q.extractLastResponse() : { markdown: Q.getLastResponseText ? Q.getLastResponseText() : '', images: [] };
            return { markdown: fb3.markdown || '', images: fb3.images || [], source: 'dom-fallback', error: e.message };
        } finally {
            if (savedClipboard) {
                try {
                    if (window.electronAPI && window.electronAPI.clipboardRestore) {
                        await window.electronAPI.clipboardRestore(savedClipboard, markdown);
                    }
                } catch(e) {}
            }
        }
    };

    // 兼容旧调用：一次性剪贴板提取（合成点击，Qwen 的 div 复制按钮不可靠，已废弃）
    // 保留仅供 fallback 或 DeepSeek 风格调用，Qwen 实际走 findCopyButtonCoord + 真实点击 + readClipboardAndRestore
    Q.extractViaClipboard = async function() {
        var savedClipboard = null;
        try {
            try {
                if (window.electronAPI && window.electronAPI.clipboardSave) {
                    savedClipboard = await window.electronAPI.clipboardSave();
                }
            } catch(e) {}

            function findCopyBtnInLastMsg() {
                var lastMsg = assistantMessageScope();
                if (!lastMsg) return null;
                var divs = lastMsg.querySelectorAll('div[class*="cursor-pointer"]');
                for (var i = 0; i < divs.length; i++) {
                    var path = divs[i].querySelector('svg path[d^="M832 64"]');
                    if (!path) continue;
                    var rect = divs[i].getBoundingClientRect();
                    if (rect.width > 0 && rect.height > 0) return divs[i];
                }
                return null;
            }
            var btn = null;
            var btnStart = Date.now();
            while (Date.now() - btnStart < 10000) {
                btn = findCopyBtnInLastMsg();
                if (btn) break;
                await new Promise(function(r){ setTimeout(r, 200); });
            }
            if (!btn) {
                var fb = Q.extractLastResponse ? Q.extractLastResponse() : { markdown: Q.getLastResponseText ? Q.getLastResponseText() : '', images: [] };
                return { markdown: fb.markdown || '', images: fb.images || [], source: 'dom-fallback', error: 'copy button not found' };
            }

            try { btn.click(); } catch(e) {}

            var markdown = '';
            for (var retry = 0; retry < 5; retry++) {
                try {
                    if (window.electronAPI && window.electronAPI.clipboardReadText) {
                        markdown = await window.electronAPI.clipboardReadText();
                    }
                } catch(e) {}
                if (markdown && markdown.length > 0) break;
                await new Promise(function(r){ setTimeout(r, 200); });
            }

            if (!markdown) {
                var fb2 = Q.extractLastResponse ? Q.extractLastResponse() : { markdown: Q.getLastResponseText ? Q.getLastResponseText() : '', images: [] };
                return { markdown: fb2.markdown || '', images: fb2.images || [], source: 'dom-fallback', error: 'clipboard empty' };
            }

            if (Q.isLastUserEcho(markdown)) {
                var assistantText = cleanAssistantText();
                return { markdown: assistantText, images: [], source: 'dom-assistant', error: 'copy action targeted the user message' };
            }

            return { markdown: markdown, images: [], source: 'clipboard' };
        } catch(e) {
            var fb3 = Q.extractLastResponse ? Q.extractLastResponse() : { markdown: Q.getLastResponseText ? Q.getLastResponseText() : '', images: [] };
            return { markdown: fb3.markdown || '', images: fb3.images || [], source: 'dom-fallback', error: e.message };
        } finally {
            if (savedClipboard) {
                try {
                    if (window.electronAPI && window.electronAPI.clipboardRestore) {
                        await window.electronAPI.clipboardRestore(savedClipboard, markdown);
                    }
                } catch(e) {}
            }
        }
    };

    // 查找 Qwen 回复中的复制按钮，返回其中心坐标（不点击）
    // 由 inject.js 通过 Electron 真实鼠标事件点击，确保 navigator.clipboard 触发
    Q.copyLastResponse = async function() {

        function tryFindButton() {
            var assistant = assistantMessageScope();
            if (!assistant) return null;
            // 方案1：通过复制图标 SVG 路径定位（最精准）
            var copySvgs = assistant.querySelectorAll(COPY_PATH_SELECTOR);
            var copySvg = copySvgs.length ? copySvgs[copySvgs.length - 1] : null;
            if (copySvg) {
                // 复制按钮特征：hover:bg-tag + cursor-pointer（严格匹配，避免误点外层容器）
                var btn = copySvg.closest('[class*="hover:bg-tag"][class*="cursor-pointer"]') || copySvg.parentElement;
                if (btn) {
                    var rect = btn.getBoundingClientRect();
                    return {
                        success: true,
                        method: 'svg-path',
                        x: Math.round(rect.left + rect.width / 2),
                        y: Math.round(rect.top + rect.height / 2)
                    };
                }
            }

            // 方案2：通过 hover:bg-tag + cursor-pointer + 复制图标 SVG 定位
            var tagBtns = assistant.querySelectorAll('[class*="hover:bg-tag"][class*="cursor-pointer"]');
            for (var i = 0; i < tagBtns.length; i++) {
                if (tagBtns[i].querySelector('svg path[d*="M832 64"]')) {
                    var rect = tagBtns[i].getBoundingClientRect();
                    return {
                        success: true,
                        method: 'hover-tag',
                        x: Math.round(rect.left + rect.width / 2),
                        y: Math.round(rect.top + rect.height / 2)
                    };
                }
            }

            // 方案3：在最后一条消息的工具栏中查找（限消息内 + 复制图标 SVG）
            var msgBtns = assistant.querySelectorAll('[class*="hover:bg-tag"][class*="cursor-pointer"]');
            for (var i = 0; i < msgBtns.length; i++) {
                if (msgBtns[i].querySelector(COPY_PATH_SELECTOR)) {
                        var rect = msgBtns[i].getBoundingClientRect();
                        return {
                            success: true,
                            method: 'message-hover-tag',
                            x: Math.round(rect.left + rect.width / 2),
                            y: Math.round(rect.top + rect.height / 2)
                        };
                }
            }

            return null;
        }

        while (true) {
            var result = tryFindButton();
            if (result) {
                return result;
            }
            await sleep(200);
        }
    };

    // 获取当前页面 URL（对话专属 URL，比标题更可靠）
    Q.getCurrentUrl = function() {
        return { success: true, url: window.location.href };
    };

    // 直接导航到指定 URL（用于切回之前发送的对话）
    Q.navigateToUrl = function(url) {
        if (!url) return { success: false, error: 'No URL' };
        window.location.href = url;
        return { success: true };
    };

    // 等待 URL 变为对话专属 URL（包含 /chat/），用于确认新建对话已完成
    Q.waitForConversationUrl = function(timeout) {
        timeout = timeout || 10000;
        var start = Date.now();
        return new Promise(function(resolve) {
            function check() {
                var href = window.location.href;
                if (href.indexOf('/chat/') >= 0) {
                    resolve({ success: true, url: href });
                    return;
                }
                if (Date.now() - start > timeout) {
                    resolve({ success: false, url: href });
                    return;
                }
                setTimeout(check, 300);
            }
            check();
        });
    };

    // 获取当前活跃对话的标题（用于并行时标记对话，稍后切回）
    // 多级兜底：活跃类 → 任意对话 → 第一个对话的文本
    Q.getCurrentConversationTitle = function() {
        var allConvs = document.querySelectorAll('[data-react-window-index]');
        // 方法1：查找活跃对话（有 text-title-attachment 或 font-500 类）
        for (var i = 0; i < allConvs.length; i++) {
            var title = allConvs[i].querySelector('[class*="text-title-attachment"], [class*="font-500"]');
            if (title) {
                var t = title.textContent.trim();
                if (t) return { success: true, title: t };
            }
        }
        // 方法2：任意对话的第一个文本节点
        for (var i = 0; i < allConvs.length; i++) {
            var text = allConvs[i].textContent.trim();
            if (text) return { success: true, title: text.substring(0, 50) };
        }
        // 方法3：取第一个对话
        if (allConvs.length > 0) {
            var t = allConvs[0].textContent.trim();
            if (t) return { success: true, title: t.substring(0, 50) };
        }
        return { success: false, title: '' };
    };

    // 切换到指定标题的对话（多级兜底）
    Q.switchToConversation = function(title) {
        return new Promise(function(resolve) {
            if (!title) { resolve({ success: false, error: 'No title' }); return; }
            var allConvs = document.querySelectorAll('[data-react-window-index]');
            // 方法1：精确匹配标题文本
            for (var i = 0; i < allConvs.length; i++) {
                var text = allConvs[i].textContent.trim();
                if (text.indexOf(title) >= 0) {
                    allConvs[i].click();
                    setTimeout(function() { resolve({ success: true }); }, 800);
                    return;
                }
            }
            // 方法2：模糊匹配（取标题前 20 个字符）
            var shortTitle = title.substring(0, 20);
            for (var i = 0; i < allConvs.length; i++) {
                var text = allConvs[i].textContent.trim();
                if (text.indexOf(shortTitle) >= 0) {
                    allConvs[i].click();
                    setTimeout(function() { resolve({ success: true }); }, 800);
                    return;
                }
            }
            resolve({ success: false, error: 'Conversation not found: ' + title });
        });
    };

    // 删除当前对话（两步：菜单→删除此对话→确认）
    Q._deleteSerial = 0;
    Q.deleteConversation = function(convIndex) {
        var serial = ++Q._deleteSerial;
        return new Promise(function(resolve) {

            function safeResolve(result) {
                resolve(result);
            }

            // 0. 确保侧边栏已展开：查找 sidebarRight（展开）按钮，存在则侧边栏已折叠，需先展开
            //    Qwen 侧边栏折叠后对话列表 DOM 不可见，delete 找不到对话会静默失败
            var _needExpand = false;
            try {
                var expandBtn = document.querySelector(
                    'button[data-icon-type*="sidebarRight"], ' +
                    'button span[data-icon-type*="sidebarRight"], ' +
                    '[data-icon-type*="sidebarRight"]'
                );
                if (expandBtn) {
                    var realBtn = expandBtn.tagName === 'BUTTON' ? expandBtn : expandBtn.closest('button');
                    if (realBtn) {
                        var isVisible = realBtn.offsetParent !== null;
                        var isClosed = realBtn.getAttribute('data-state') === 'closed' || !realBtn.getAttribute('data-state');
                        if (isVisible && isClosed) {
                            _needExpand = true;
                            realBtn.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true, view: window }));
                            realBtn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
                            realBtn.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, cancelable: true, view: window }));
                            realBtn.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
                            realBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
                        }
                    }
                }
            } catch(e) { /* 非关键：展开失败不影响后续尝试 */ }

            // 将主体逻辑定义为内部函数，以便延迟执行（等待侧边栏展开动画完毕）
            function doDelete() {
            // 查找对话框中的确认按钮
            function findDialogConfirmBtn() {
                var dialogs = document.querySelectorAll('[class*="modal"], [class*="dialog"], [class*="popup"], [class*="overlay"]');
                for (var d = 0; d < dialogs.length; d++) {
                    var btns = dialogs[d].querySelectorAll('button, [role="button"]');
                    for (var b = 0; b < btns.length; b++) {
                        var txt = btns[b].textContent.trim();
                        if (txt === '确认' || txt === '确定' || txt === 'Confirm' || txt === '删除' || txt === 'Delete' || txt.indexOf('删除该对话') !== -1) {
                            return btns[b];
                        }
                    }
                }
                return findButton('确认') || findButton('确定') || findButton('删除该对话') || findButton('Confirm') || findButton('OK');
            }

            // 点击按钮（兼容 Radix UI：用 dispatchEvent 触发实际鼠标事件）
            function clickButton(btn) {
                if (!btn) return;
                btn.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true, view: window }));
                btn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
                btn.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, cancelable: true, view: window }));
                btn.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
                btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
            }

            // 查找"..."更多按钮
            function findConvMoreButton(convEl) {
                if (!convEl) return null;
                // 策略0：convEl 内找 span[data-icon-type*="more"] 的父级 button（新版 Qwen 图标）
                var qwIconSpans = convEl.querySelectorAll('span[data-icon-type*="more"]');
                if (qwIconSpans.length > 0) {
                    var btn = qwIconSpans[qwIconSpans.length - 1].closest('button');
                    if (btn) return btn;
                }
                // 策略1：convEl 内搜索 data-icon-type
                var localIconBtns = convEl.querySelectorAll('button[data-icon-type*="more"], [data-icon-type*="more"]');
                for (var i = 0; i < localIconBtns.length; i++) {
                    var btn = localIconBtns[i].tagName === 'BUTTON' ? localIconBtns[i] : localIconBtns[i].closest('button');
                    if (btn && btn.tagName === 'BUTTON') return btn;
                }
                // 策略2：convEl 内找 aria-haspopup="menu" 的小按钮（Radix UI 特征）
                var menuBtns = convEl.querySelectorAll('button[aria-haspopup="menu"]');
                if (menuBtns.length > 0) return menuBtns[menuBtns.length - 1];
                // 策略3：全局搜索，取最后一个
                var allMoreBtns = document.querySelectorAll('button[aria-haspopup="menu"]');
                if (allMoreBtns.length > 0) return allMoreBtns[allMoreBtns.length - 1];
                // 策略4：全局搜索 data-icon-type
                var iconBtns = document.querySelectorAll('button[data-icon-type*="more"], button [data-icon-type*="more"]');
                for (var i = iconBtns.length - 1; i >= 0; i--) {
                    var btn = iconBtns[i].tagName === 'BUTTON' ? iconBtns[i] : iconBtns[i].closest('button');
                    if (btn && btn.tagName === 'BUTTON') return btn;
                }
                // 策略5：convEl 内找包含 SVG 的小按钮
                var smallBtns = convEl.querySelectorAll('button, [role="button"]');
                for (var i = 0; i < smallBtns.length; i++) {
                    var btn = smallBtns[i];
                    if (btn.querySelector('svg')) return btn;
                }
                return null;
            }

            // 1. 查找对话列表
            var allConvs = document.querySelectorAll('[data-react-window-index]');
            if (allConvs.length === 0) {
                var convList = document.querySelector('[class*="conversation-list"], [class*="chat-list"], [class*="sidebar"], [class*="history-list"], [class*="session-list"]');
                if (convList) {
                    allConvs = convList.querySelectorAll('[class*="conversation"], [class*="chat-item"], [class*="session"], [class*="history-item"], a[href*="/c/"]');
                }
                if (!allConvs || allConvs.length === 0) {
                    allConvs = document.querySelectorAll('[class*="conversation"], [class*="chat-item"], [class*="session"], [class*="history-item"], a[href*="/c/"]');
                }
            }
            // Qwen 新版 Tailwind 布局：可拖拽的对话项（带 aria-haspopup 按钮）
            if (!allConvs || allConvs.length === 0) {
                var draggable = document.querySelectorAll('div[draggable="true"]');
                allConvs = Array.from(draggable).filter(function(el) {
                    return el.querySelector('button[aria-haspopup="menu"]');
                });
            }
            if (!allConvs || allConvs.length === 0) {
                // 侧边栏没有对话 = 无需删除，视为成功
                safeResolve({ success: true, reason: 'No conversations in sidebar, already clean' });
                return;
            }

            // 2. 选择对话
            // 优先选当前活跃对话（标题带 font-500 + text-title-attachment 的项）
            var targetConv = null;
            for (var ci = 0; ci < allConvs.length; ci++) {
                var title = allConvs[ci].querySelector('[class*="text-title-attachment"], [class*="font-500"]');
                if (title) {
                    targetConv = allConvs[ci];
                    break;
                }
            }
            // 其次选最后一个（默认最新对话）
            if (!targetConv) {
                var targetIdx = (convIndex !== undefined && convIndex !== null) ? convIndex : (allConvs.length - 1);
                if (targetIdx < 0 || targetIdx >= allConvs.length) {
                    safeResolve({ success: false, error: 'Invalid conversation index: ' + targetIdx });
                    return;
                }
                targetConv = allConvs[targetIdx];
            }

            // 3. 找到并点击"..."按钮
            var moreBtn = findConvMoreButton(targetConv);
            if (!moreBtn) {
                safeResolve({ success: false, error: 'More options button not found' });
                return;
            }
            clickButton(moreBtn);

            // 4. 轮询等待菜单弹出后点击"删除此对话"
            (function pollMenu() {
                if (serial !== Q._deleteSerial) { safeResolve({ success: false, reason: 'obsolete' }); return; }
                var deleteOpt = findButton('删除此对话') || findButton('删除对话') || findButton('删除') || findButton('Delete');
                if (!deleteOpt) {
                    var menus = document.querySelectorAll('[class*="menu"], [class*="dropdown"], [class*="popover"], [role="menu"], [role="listbox"]');
                    for (var m = 0; m < menus.length; m++) {
                        var items = menus[m].querySelectorAll('button, [role="button"], [role="menuitem"], [role="option"], [class*="item"], [class*="option"]');
                        for (var it = 0; it < items.length; it++) {
                            var txt = items[it].textContent.trim();
                            if (txt.indexOf('删除') !== -1 || txt.indexOf('Delete') !== -1) { deleteOpt = items[it]; break; }
                        }
                        if (deleteOpt) break;
                    }
                }
                if (deleteOpt) {
                    clickButton(deleteOpt);
                    // 5. 轮询等待确认对话框后点击确认
                    (function pollConfirm() {
                        if (serial !== Q._deleteSerial) { safeResolve({ success: false, reason: 'obsolete' }); return; }
                        var confirmBtn = findDialogConfirmBtn();
                        if (confirmBtn) { clickButton(confirmBtn); safeResolve({ success: true }); }
                        else { setTimeout(pollConfirm, 300); }
                    })();
                } else {
                    setTimeout(pollMenu, 300);
                }
            })();
            } // ← doDelete() 函数体结束

            // 6. 执行：如果展开了侧边栏，等待动画完成后执行删除；否则立即执行
            if (_needExpand) {
                setTimeout(doDelete, 800);
            } else {
                doDelete();
            }
        }); // ← Promise 闭合
    };

    // 发送修改建议到当前对话（用于二次修正图片）
    // modifyText: 修改建议文字
    Q.sendModifySuggestion = function(modifyText) {
        return new Promise(function(resolve) {
            if (!modifyText) {
                resolve({ success: false, error: 'Modify text is empty' });
                return;
            }
            Q.setStatus('发送修改建议...');
            // 直接在当前对话输入框中粘贴修改建议并发送
            Q.sendMessage(modifyText).then(function(res) {
                Q.clearStatus();
                resolve(res);
            }).catch(function(e) {
                resolve({ success: false, error: e.message });
            });
        });
    };

    // 发送参考图+提示词（粘贴参考图并附带提示词文字后发送）
    // imagePath: 已粘贴到剪贴板的图片（通过 Electron 的 qwenPasteImage）
    // text: 提示词文字
    Q.pasteWithRefImage = function(text) {
        return new Promise(function(resolve) {
            Q.setStatus('发送参考图+提示词...');
            // 注意：图片已由外部通过 qwenPasteImage 粘贴到输入框
            // 只需要再附加文字并发送
            if (text) {
                var editor = findVisibleEditor();
                if (editor) {
                    editor.focus();
                    var sel = window.getSelection();
                    var range = document.createRange();
                    range.selectNodeContents(editor);
                    range.collapse(false);
                    sel.removeAllRanges();
                    sel.addRange(range);
                    document.execCommand('insertText', false, text);
                }
            }
            // 等待输入稳定后发送
            setTimeout(function() {
                Q.clickSend().then(function(res) {
                    Q.clearStatus();
                    resolve(res);
                }).catch(function(e) {
                    resolve({ success: false, error: e.message });
                });
            }, 500);
        });
    };

    // 在 Qwen 页面显示状态覆盖层（用于 debug）
    Q.setStatus = function(text) {
        // 发送到 controlbar 状态栏，不在 Qwen 页面上创建 DOM 叠加层
        try {
            if (window.electronAPI && window.electronAPI.qwenNotifyStatus) {
                window.electronAPI.qwenNotifyStatus(text);
            }
        } catch(e) {}
        console.log('[Qwen Status]', text);
        return { success: true };
    };

    Q.clearStatus = function() {
        // 不再需要清除 DOM 叠加层
        return { success: true };
    };

    console.log('[Qwen Auto] Script loaded');

    // ==================== local 指令解析（使用共享解析器） ====================
    // 从 Qwen 最后回复中提取 local 指令块
    Q.parseLocalCommands = function() {
        var text = Q.getLastResponseText();
        if (!text) return [];
        if (window.__dsagent_parseCommands) {
            var result = window.__dsagent_parseCommands(text);
            return result.commands || [];
        }
        return [];
    };

    // 获取最后回复的完整分段（文字 + 指令），供 agent 视图展示
    Q.parseLastResponseSegments = function() {
        var text = Q.getLastResponseText();
        if (!text) return [];
        if (window.__dsagent_parseSegments) {
            var result = window.__dsagent_parseSegments(text);
            return result.segments || [];
        }
        return [{ type: 'text', content: text }];
    };

    // ==================== Server 层所需接口 ====================

    // 提取最后一条 AI 回复（结构化）
    Q.extractLastResponse = function() {
        try {
            var text = Q.getLastResponseText ? Q.getLastResponseText() : '';
            return { markdown: text, images: [] };
        } catch (e) {
            return { markdown: '', images: [], error: e.message };
        }
    };

    // 停止生成
    Q.stopGeneration = function() {
        var stopBtn = findStopButton();
        if (stopBtn) { stopBtn.click(); return { success: true }; }
        return { success: false, error: 'Stop button not found' };
    };

    // ==================== 统一 invoke 协议（供 server-qwen.js 调用） ====================

    // 检测回复类型：text / image / ppt
    Q.detectResponseType = function() {
        // 新版可能只渲染一张图且不再使用旧的 image_list 卡片名。
        if (Q.getLastImageUrls && Q.getLastImageUrls().length) return { type: 'image' };
        var scope = assistantMessageScope();
        // PPT 卡片特征：data-ppt-id
        var pptCard = scope && scope.querySelector('[data-ppt-id]');
        if (pptCard) return { type: 'ppt' };
        // 默认文本
        return { type: 'text' };
    };

    // 等待图片生成完成：等所有图片加载完毕（loading 类消失 / 图片 URL 稳定）
    Q.waitForImageDone = function(timeout) {
        return Q.waitForDrawResponse(timeout || 300000);
    };

    // 提取图片回复：文字 + 图片 URL 列表
    Q.extractImageResponse = function() {
        try {
            var text = Q.getPhase1Text ? Q.getPhase1Text() : (Q.getLastResponseText ? Q.getLastResponseText() : '');
            var images = Q.getLastImageUrls ? Q.getLastImageUrls() : [];
            return { markdown: text, images: images };
        } catch (e) {
            return { markdown: '', images: [], error: e.message };
        }
    };

    Q.invoke = async function(op, args) {
        args = args || {};
        try {
            switch (op) {
                case 'newChat':
                    return await Q.newConversation();
                case 'sendMessage':
                    return Q.sendMessage(args.text || '');
                case 'waitForDone':
                    // Qwen 的 waitForDone 由 server-qwen.js 通过轮询实现，此处仅占位
                    return { success: true };
                case 'extractResponse':
                    // Qwen 复制按钮是 div，合成 click 不可靠，由 server 层编排真实鼠标点击
                    // 此处仅作 fallback：直接 DOM 提取
                    return Q.extractLastResponse ? Q.extractLastResponse() : { markdown: Q.getLastResponseText ? Q.getLastResponseText() : '', images: [] };
                case 'detectResponseType':
                    return Q.detectResponseType ? Q.detectResponseType() : { type: 'text' };
                case 'waitForImageDone':
                    return await Q.waitForImageDone(args.timeout || 300000);
                case 'extractImageResponse':
                    return Q.extractImageResponse ? Q.extractImageResponse() : { markdown: '', images: [] };
                case 'findCopyButtonCoord':
                    return await Q.findCopyButtonCoord();
                case 'extractViaCopyAsMarkdown':
                    return await Q.extractViaCopyAsMarkdown();
                case 'readClipboardAndRestore':
                    return await Q.readClipboardAndRestore();
                case 'deleteConversation':
                    return Q.deleteConversation(args.convIndex || undefined);
                case 'stopGeneration':
                    return Q.stopGeneration();
                case 'uploadImage':
                    return await Q.uploadImage(args.files || []);
                case 'uploadFiles':
                    return await Q.uploadFiles(args.files || []);
                case 'copyLastResponse':
                    return await Q.copyLastResponse();
                case 'checkReady':
                    return { ready: !!(Q.ready && Q.sendMessage) };
                case 'getCurrentUrl':
                    return { url: window.location.href };
                case 'navigateToUrl':
                    window.location.href = args.url || '';
                    return { success: true };
                default:
                    return { success: false, error: 'Unknown op: ' + op };
            }
        } catch (e) {
            return { success: false, error: e.message };
        }
    };

})();
