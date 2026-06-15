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

    // 自动点击 float-to-bottom 按钮（Qwen 回到底部的滚动按钮）
    // 这个按钮出现时需要自动点击，否则对话内容被截断不完整
    (function() {
        var observer = new MutationObserver(function() {
            var ftb = document.querySelector('[class*="float-to-bottom"]');
            if (ftb && (ftb.className.indexOf('active') !== -1 || ftb.className.indexOf('float-to-bottom-active') !== -1)) {
                ftb.click();
            }
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
                resolve({ success: true });
            } else {
                resolve({ success: false, error: 'New conversation button not found' });
            }
        });
    };

    // 触发上传（点击上传按钮）
    Q.uploadImage = function() {
        return new Promise(function(resolve) {
            var uploadBtn = document.querySelector('[class*="upload"], [class*="image-upload"], [class*="file-upload"], [class*="attach"]')
                || findButton('上传')
                || findButton('图片')
                || findButton('附件');
            var fileInput = document.querySelector('input[type="file"]');
            if (fileInput) {
                resolve({ success: true, fileInput: true });
                return;
            }
            if (uploadBtn) {
                uploadBtn.click();
                setTimeout(function() {
                    var fi = document.querySelector('input[type="file"]');
                    if (fi) {
                        resolve({ success: true, fileInput: true });
                    } else {
                        resolve({ success: false, error: 'File input not found after click' });
                    }
                }, 1000);
            } else {
                resolve({ success: false, error: 'Upload button not found' });
            }
        });
    };

    // 查找发送按钮（精确版，只返回可用的发送按钮）
    function findSendButton() {
        // 精确匹配 aria-label="发送消息" 且未禁用
        var exact = document.querySelector('button[aria-label="发送消息"]:not([disabled])');
        if (exact) return exact;

        // 遍历按钮，找 aria-label 含"发送"且未禁用
        var btns = document.querySelectorAll('button');
        for (var i = 0; i < btns.length; i++) {
            var b = btns[i];
            if (b.disabled) continue;
            var label = (b.getAttribute('aria-label') || '').toLowerCase();
            if (label === '发送消息' || label === '发送') return b;
        }
        return null;
    }

    // 查找"停止回答"按钮（正在输出中）
    function findStopButton() {
        var btns = document.querySelectorAll('button');
        for (var i = 0; i < btns.length; i++) {
            var label = (btns[i].getAttribute('aria-label') || '').toLowerCase();
            if (label.indexOf('停止') !== -1 && !btns[i].disabled) {
                return btns[i];
            }
        }
        return null;
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
    Q.sendMessage = function(text) {
        return new Promise(function(resolve) {
            // 1. 查找输入框（优先 contenteditable，Qwen 使用 Slate.js）
            var input = findVisibleEditor();
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

            // 3. 清空占位符（先清除已有内容）
            if (input.isContentEditable) {
                var sel = window.getSelection();
                var range = document.createRange();
                range.selectNodeContents(input);
                range.deleteContents();
                // 再插入文本
                sel.removeAllRanges();
                sel.addRange(range);
                document.execCommand('insertText', false, text || '');
                // 额外触发 input 事件，确保 Slate.js 感知到变化
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

            // 4. 等待发送按钮就绪并点击
            var start = Date.now();
            function waitAndClick() {
                var sendBtn = findSendButton();
                if (sendBtn && !sendBtn.disabled) {
                    sendBtn.click();
                    // 5. 验证：1秒后检查是否出现"停止回答"按钮
                    setTimeout(function() {
                        if (findStopButton()) {
                            resolve({ success: true, method: 'click-send' });
                        } else {
                            // 未出现停止按钮 → 再试一次
                            var btn2 = findSendButton();
                            if (btn2 && !btn2.disabled) {
                                btn2.click();
                                resolve({ success: true, method: 'click-send-retry' });
                            } else {
                                resolve({ success: true, method: 'click-send-unknown' });
                            }
                        }
                    }, 1000);
                } else if (Date.now() - start > 5000) {
                    resolve({ success: false, error: 'Send button not ready after timeout' });
                } else {
                    setTimeout(waitAndClick, 200);
                }
            }
            waitAndClick();
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
                var imgs = document.querySelectorAll('[class*="imageItem"] img, [class*="imageWrapper"] img, [class*="message"]:last-child img');
                var sigs = [];
                for (var ii = 0; ii < imgs.length; ii++) {
                    var src = imgs[ii].src || '';
                    if (src.indexOf('qianwen.com') >= 0 || src.indexOf('data:image') >= 0) sigs.push(src + '|w=' + (imgs[ii].width || 0));
                }
                return sigs.join('||');
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

                    // 图片已出现 → 立即完成
                    showPhase(5, '全部完成!');
                    resolve({ success: true });
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

    // 获取最后回复中的图片 URL
    // Qwen 图片结构：<div class="imageItem-xxx imageWrapper-xxx complete-xxx"><img src="https://workspace-zb-cdn.qianwen.com/..."></div>
    Q.getLastImageUrls = function() {
        var urls = [];

        // 方式一：直接查找 imageItem/imageWrapper 容器中的 img
        var imageItems = document.querySelectorAll('[class*="imageItem"] img, [class*="imageWrapper"] img');
        for (var i = 0; i < imageItems.length; i++) {
            var src = imageItems[i].src || '';
            if (src && src.indexOf('qianwen.com') > -1 && urls.indexOf(src) === -1) {
                urls.push(src);
            }
        }

        // 方式二：查找最后一条消息中的所有图片（兜底）
        if (urls.length === 0) {
            var messages = document.querySelectorAll('[class*="message"], [class*="chat-item"], [class*="conversation-item"]');
            if (messages.length > 0) {
                var lastMsg = messages[messages.length - 1];
                var imgs = lastMsg.querySelectorAll('img');
                for (var i = 0; i < imgs.length; i++) {
                    var src = imgs[i].src || '';
                    if (src && src.indexOf('qianwen.com') > -1 && urls.indexOf(src) === -1) {
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
        var messages = document.querySelectorAll('[class*="message"], [class*="chat-item"], [class*="conversation-item"]');
        if (messages.length === 0) return '';
        var lastMsg = messages[messages.length - 1];
        // 克隆节点，删除图片容器，取纯文字
        var clone = lastMsg.cloneNode(true);
        var imgAreas = clone.querySelectorAll('[class*="imageItem"], [class*="imageWrapper"], img, [class*="popMenu"]');
        for (var i = 0; i < imgAreas.length; i++) {
            imgAreas[i].remove();
        }
        return (clone.textContent || '').trim();
    };

    // 获取第一阶段文字（图片前面的文字，不含后面的修改建议）
    // Qwen 回复结构：[文字] [图片] [修改建议 + 隐藏的JSON控件数据]
    // 克隆消息节点 → 删除从第一条图片开始的所有后续元素 → 取剩余文字
    Q.getPhase1Text = function() {
        var messages = document.querySelectorAll('[class*="message"], [class*="chat-item"], [class*="conversation-item"]');
        if (messages.length === 0) return '';
        var lastMsg = messages[messages.length - 1];

        // 克隆以避免修改真实 DOM
        var clone = lastMsg.cloneNode(true);

        // 先移除隐藏的 script/style/hidden 元素（这些会产生 JSON 控件数据）
        var invisibleEls = clone.querySelectorAll('script, style, [style*="display:none"], [style*="display: none"], [hidden], template');
        for (var i = 0; i < invisibleEls.length; i++) invisibleEls[i].remove();

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

    // 查找 Qwen 回复中的复制按钮，返回其中心坐标（不点击）
    // 由 inject.js 通过 Electron 真实鼠标事件点击，确保 navigator.clipboard 触发
    Q.copyLastResponse = async function() {

        function tryFindButton() {
            // 方案1：通过复制图标 SVG 路径定位（最精准）
            var copySvg = document.querySelector('svg path[d*="M832 64"]');
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
            var tagBtns = document.querySelectorAll('[class*="hover:bg-tag"][class*="cursor-pointer"]');
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
            var messages = document.querySelectorAll('[class*="message"], [class*="chat-item"], [class*="conversation-item"]');
            if (messages.length > 0) {
                var lastMsg = messages[messages.length - 1];
                var msgBtns = lastMsg.querySelectorAll('[class*="hover:bg-tag"][class*="cursor-pointer"]');
                for (var i = 0; i < msgBtns.length; i++) {
                    if (msgBtns[i].querySelector('svg path[d*="M832 64"]')) {
                        var rect = msgBtns[i].getBoundingClientRect();
                        return {
                            success: true,
                            method: 'message-hover-tag',
                            x: Math.round(rect.left + rect.width / 2),
                            y: Math.round(rect.top + rect.height / 2)
                        };
                    }
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

    // 删除当前对话（两步：菜单→删除此对话→确认）
    Q._deleteSerial = 0;
    Q.deleteConversation = function(convIndex) {
        var serial = ++Q._deleteSerial;
        return new Promise(function(resolve) {

            function safeResolve(result) {
                resolve(result);
            }

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
                if (allConvs.length === 0) {
                    allConvs = document.querySelectorAll('[class*="conversation"], [class*="chat-item"], [class*="session"], [class*="history-item"], a[href*="/c/"]');
                }
            }
            if (allConvs.length === 0) {
                safeResolve({ success: false, error: 'No conversations found in sidebar' });
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
        });
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
        try {
            var el = document.getElementById('__qwen_status');
            if (!el) {
                el = document.createElement('div');
                el.id = '__qwen_status';
                el.style.cssText = 'position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);background:rgba(0,0,0,0.85);color:#0ff;padding:16px 24px;border-radius:12px;z-index:99999;font-size:16px;text-align:center;max-width:600px;word-break:break-all;box-shadow:0 4px 20px rgba(0,0,0,0.5);pointer-events:none;font-family:monospace;border:2px solid #0ff;';
                document.body.appendChild(el);
            }
            el.textContent = '🔧 Qwen Debug: ' + text;
            el.style.display = 'block';
            return { success: true };
        } catch(e) {
            return { success: false, error: e.message };
        }
    };

    Q.clearStatus = function() {
        try {
            var el = document.getElementById('__qwen_status');
            if (el) el.style.display = 'none';
            return { success: true };
        } catch(e) {
            return { success: false, error: e.message };
        }
    };

    console.log('[Qwen Auto] Script loaded');
})();