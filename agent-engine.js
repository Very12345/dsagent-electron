// DS Agent Engine - 本地执行引擎（纯业务逻辑，无 DOM 依赖）
// 与 inject-deepseek.js 运行在同一页面上下文，共享 window.electronAPI
;(function() {
    'use strict';

    if (window.__dsagent_engine) return;
    var E = window.__dsagent_engine = {};

    // ==================== 纯工具函数 ====================

    E.formatSize = function(bytes) {
        if (bytes < 1024) return bytes + ' B';
        if (bytes < 1024*1024) return (bytes/1024).toFixed(1) + ' KB';
        return (bytes/(1024*1024)).toFixed(1) + ' MB';
    };

    E.escapeRegex = function(str) {
        return str.replace(/[.*+?^${}()|[\]\\\/]/g, '\\$&');
    };

    E.parseKeyValuePairs = function(text) {
        const pairs = {};
        const regex = /(\w+)\s*=\s*(?:"([^"]*)"|'([^']*)'|(\S+?))(?:\s|$)/g;
        let match;
        while ((match = regex.exec(text)) !== null) {
            const key = match[1];
            const val = match[2] !== undefined ? match[2] : (match[3] !== undefined ? match[3] : match[4]);
            if (val !== undefined) pairs[key] = val;
        }
        return pairs;
    };

    E.getBaseFilename = function(promptText) {
        var sanitized = promptText.replace(/[<>:"\/\\|?*]/g, '').trim();
        var base = sanitized.substring(0, 10).replace(/\s+/g, '_');
        return base || 'qwen_draw';
    };

    // ==================== 命令引用系统 ====================

    var REFERENCE_LANGS = [
        'javascript', 'js', 'typescript', 'ts', 'python', 'py',
        'bash', 'sh', 'shell', 'cmd', 'bat', 'powershell', 'ps1',
        'java', 'c', 'cpp', 'csharp', 'go', 'rust', 'php', 'ruby',
        'sql', 'json', 'xml', 'html', 'css', 'yaml', 'yml'
    ];

    E.buildCmdMap = function(codeBlocks, getLanguage, extractCode) {
        const map = new Map();
        for (const block of codeBlocks) {
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
                    break;
                }
            }
        }
        return map;
    };

    E.resolveRefs = function(content, cmdMap) {
        return content.replace(/\{@cmd:(\S+)\}/g, function(match, name) {
            const code = cmdMap.get(name);
            if (code !== undefined) {
                if (code === null) return '# Error: @cmd:' + name + ' has no code';
                return code;
            }
            return '# Error: @cmd:' + name + ' not found';
        });
    };

    // ==================== Subreader 策略 ====================

    var _subreaderStrategy = null;

    E.loadSubreaderStrategy = async function() {
        if (_subreaderStrategy) return _subreaderStrategy;
        try {
            var res = await window.electronAPI.getSubreaderStrategy();
            if (res && res.success && res.text) {
                _subreaderStrategy = res.text;
                return res.text;
            }
        } catch(e) {
            console.warn('Failed to load subreader strategy:', e);
        }
        _subreaderStrategy = '你是一个子代理(sub-agent)，负责分析文件。请直接返回结果，使用中文。';
        return _subreaderStrategy;
    };

    E.buildSubreaderPrompt = async function(fileListStr, extraPrompt) {
        var strategy = await E.loadSubreaderStrategy();
        var parts = [strategy];
        if (extraPrompt) {
            parts.push('【用户额外要求】\n' + extraPrompt);
        }
        parts.push('请阅读以下文件：' + fileListStr);
        return parts.join('\n\n');
    };

    E.parseSingleReadParams = function(content) {
        var trimmed = content.trim();
        var lines = trimmed.split('\n');
        var allPaths = [];
        var textLines = [];
        for (var li = 0; li < lines.length; li++) {
            var line = lines[li].trim();
            var m = line.match(/^(path|paths)\s*=\s*(.+)$/);
            if (m) {
                allPaths.push(m[2].trim());
            } else if (line) {
                textLines.push(line);
            }
        }
        var extraPrompt = textLines.join('\n').trim();

        var kv = E.parseKeyValuePairs(trimmed);
        if (allPaths.length === 0 && (kv.path || kv.paths)) {
            allPaths = [kv.path || kv.paths];
        }
        if (allPaths.length > 0) {
            return {
                paths: allPaths,
                mode: kv.mode || 'quick',
                search: kv.search || 'off',
                think: kv.think || 'off',
                prompt: extraPrompt || ''
            };
        }
        var firstLineEnd = trimmed.indexOf('\n');
        var path = firstLineEnd > 0 ? trimmed.substring(0, firstLineEnd).trim() : trimmed;
        var prompt = firstLineEnd > 0 ? trimmed.substring(firstLineEnd + 1).trim() : '';
        return {
            paths: [path],
            mode: 'quick',
            search: 'off',
            think: 'off',
            prompt: prompt
        };
    };

    // ==================== Qwen 通用函数 ====================

    E.execQwen = async function(fnName, args) {
        var res = await window.electronAPI.qwenExec(fnName, args);
        if (!res.success) throw new Error(res.error || 'Qwen exec failed');
        if (res.result && typeof res.result === 'object' && res.result.success === false) {
            throw new Error('Qwen ' + fnName + ' failed: ' + (res.result.error || 'unknown error'));
        }
        return res.result;
    };

    E.showQwen = async function() {
        var vis = await window.electronAPI.qwenIsVisible();
        if (!vis.visible) await window.electronAPI.qwenShowView();
    };

    E.hideQwen = async function() {
        await window.electronAPI.qwenHideView();
    };

    E.downloadQwenImage = async function(url, savePath) {
        var res = await window.electronAPI.qwenDownloadImage(url, savePath);
        if (!res.success) throw new Error('下载图片失败: ' + (res.error || url));
        return { path: res.path, dataUrl: res.dataUrl };
    };

    E.getQwenResponseViaCopy = async function() {
        var saved = await window.electronAPI.clipboardSave();
        try {
            var btnInfo = await E.execQwen('copyLastResponse', []);
            if (btnInfo && btnInfo.success && btnInfo.x !== undefined) {
                var clickRes = await window.electronAPI.qwenClickAt(btnInfo.x, btnInfo.y);
                if (clickRes && clickRes.success) {
                    await new Promise(function(r) { setTimeout(r, 800); });
                    var clipRes = await window.electronAPI.qwenGetClipboard();
                    if (clipRes && clipRes.success && clipRes.text) {
                        return clipRes.text;
                    }
                }
            }
            var fallback = await E.execQwen('getLastResponseText', []);
            return fallback || '';
        } finally {
            if (saved && saved.text !== undefined) {
                await window.electronAPI.clipboardRestore(saved.text);
            }
        }
    };

    E.waitForQwenPageReady = async function() {
        var start = Date.now();
        var maxWait = 15000;
        while (Date.now() - start < maxWait) {
            var bodyText = await E.execQwen('__rawEval', ['document.body ? document.body.innerText || "" : ""']);
            bodyText = (bodyText && typeof bodyText === 'string') ? bodyText : '';
            if (bodyText.indexOf('对话不存在') >= 0 || bodyText.indexOf('该对话不存在') >= 0) {
                await new Promise(function(r) { setTimeout(r, 1000); });
                continue;
            }
            var edRes = await E.execQwen('focusEditor', []);
            if (edRes && edRes.success) return;
            await new Promise(function(r) { setTimeout(r, 500); });
        }
    };

    // ==================== Qwen 视觉分析 ====================

    E.qwenVision = async function(content, progressCb) {
        progressCb = progressCb || function(){};
        var pathRegex = /(\w+)\s*=\s*(?:"([^"]*)"|'([^']*)'|(\S+))/g;
        var match;
        var filePaths = [];
        var lastMatchEnd = 0;
        while ((match = pathRegex.exec(content)) !== null) {
            lastMatchEnd = match.index + match[0].length;
            var key = match[1].toLowerCase();
            var val = match[2] !== undefined ? match[2] : (match[3] !== undefined ? match[3] : match[4]);
            if (key === 'path' && val) filePaths.push(val);
        }
        var promptText = content.substring(lastMatchEnd).trim() || '请描述这些图片';
        if (filePaths.length === 0) {
            var firstLineEnd = content.indexOf('\n');
            filePaths = [firstLineEnd > 0 ? content.substring(0, firstLineEnd).trim() : content.trim()];
            promptText = firstLineEnd > 0 ? content.substring(firstLineEnd + 1).trim() : '请描述这张图片';
        }

        progressCb('[Qwen] 使用 Qwen 进行视觉分析...');
        progressCb('[Qwen] 新建对话...');
        await E.execQwen('newConversation');
        await new Promise(function(r) { setTimeout(r, 1000); });

        for (var fi = 0; fi < filePaths.length; fi++) {
            progressCb('[Qwen] 上传文件: ' + filePaths[fi] + '...');
            var pasteRes = await window.electronAPI.qwenPasteImage(filePaths[fi]);
            if (!pasteRes.success) throw new Error('上传文件失败: ' + (pasteRes.error || ''));
            await new Promise(function(r) { setTimeout(r, 1000); });
        }
        progressCb('[Qwen] 发送提示词...');
        await E.execQwen('focusEditor');
        await window.electronAPI.qwenPasteText(promptText);
        await new Promise(function(r) { setTimeout(r, 800); });
        progressCb('[Qwen] 等待回复...');
        await E.execQwen('clickSend');

        var progressDone = false;
        (async function() {
            while (!progressDone) {
                try {
                    var resp = await E.execQwen('isResponding', []);
                    progressCb(resp && resp.responding ? '[Qwen] 正在输出回复...' : '[Qwen] 等待回复...');
                } catch(e) {}
                await new Promise(function(r) { setTimeout(r, 2000); });
            }
        })();

        var waitRes = await E.execQwen('waitForTextResponse', [120000]);
        progressDone = true;
        if (!waitRes.success) throw new Error(waitRes.error === 'Timeout' ? 'Qwen 回复超时' : 'Qwen 回复失败: ' + waitRes.error);
        await new Promise(function(r) { setTimeout(r, 1500); });
        var text = await E.getQwenResponseViaCopy();
        progressCb('[Qwen] 分析完成');
        try { await E.execQwen('deleteConversation'); } catch(e) { console.warn('[Qwen] deleteConversation:', e.message); }
        await new Promise(function(r) { setTimeout(r, 500); });
        await E.waitForQwenPageReady();
        var clean = (text || '').replace(new RegExp(E.escapeRegex(promptText), 'g'), '').trim();
        return clean || '(Qwen 未返回内容)';
    };

    // ==================== Qwen 绘图 ====================

    E.qwenDraw = async function(content, progressCb) {
        progressCb = progressCb || function(){};
        var lines = content.trim().split('\n');
        var kv = {};
        var promptLines = [];
        var paramRegex = /^(\w+)\s*=\s*(?:"([^"]*)"|'([^']*)'|(.+?))\s*$/;
        for (var li = 0; li < lines.length; li++) {
            var line = lines[li].trim();
            if (!line) continue;
            var m = line.match(paramRegex);
            if (m) {
                var key = m[1].toLowerCase();
                var val = m[2] !== undefined ? m[2] : (m[3] !== undefined ? m[3] : m[4]);
                kv[key] = val;
            } else {
                promptLines.push(line);
            }
        }
        var saveDir = kv.savepath || '';
        var desc = kv.desc || '';
        var refPath = kv.ref || '';
        var promptText = promptLines.join('\n').trim();
        if (!promptText) throw new Error('Missing drawing prompt');

        var fullPrompt = '请根据以下描述生成图片，务必实际绘制图片并输出图片结果，不要仅提供文字描述或建议：\n\n' + promptText;
        if (desc) fullPrompt += '\n\n附加要求：' + desc;

        progressCb('[Qwen] 使用 Qwen 进行绘图...');
        progressCb('[Qwen] 新建对话...');
        await E.execQwen('newConversation');
        await new Promise(function(r) { setTimeout(r, 1000); });

        if (refPath) {
            progressCb('[Qwen] 上传参考图片: ' + refPath + '...');
            var pasteRes = await window.electronAPI.qwenPasteImage(refPath);
            if (!pasteRes.success) {
                progressCb('[Qwen] 参考图上传失败，继续使用纯文本绘图...');
            } else {
                await new Promise(function(r) { setTimeout(r, 1000); });
            }
        }

        progressCb('[Qwen] 发送绘图提示词...');
        await E.execQwen('focusEditor');
        await window.electronAPI.qwenPasteText(fullPrompt);
        await new Promise(function(r) { setTimeout(r, 800); });
        progressCb('[Qwen] 等待绘图开始...');
        await E.execQwen('clickSend');

        var progressDone = false;
        (async function() {
            while (!progressDone) {
                try {
                    var p = await E.execQwen('getDrawProgress');
                    progressCb('[Qwen绘图] ' + p.detail);
                    var resp = await E.execQwen('isResponding', []);
                    if (resp && resp.responding && p.current < 3) {
                        progressCb('[Qwen绘图] Qwen 正在输出... 阶段: ' + p.detail);
                    }
                } catch(e) {}
                await new Promise(function(r) { setTimeout(r, 1000); });
            }
        })();

        var waitRes = await E.execQwen('waitForDrawResponse', [300000]);
        progressDone = true;
        if (!waitRes.success) {
            if (waitRes.error === 'Timeout') throw new Error('Qwen 绘图超时');
            else throw new Error('Qwen 绘图失败：当前内容无法生成，请修改描述后重试');
        }
        await new Promise(function(r) { setTimeout(r, 1000); });
        var imgUrls = await E.execQwen('getLastImageUrls', []);
        progressCb('[Qwen] 绘图完成，正在下载图片...');

        var dirRes = await window.electronAPI.getDownloadsPath();
        var baseDir = saveDir || (dirRes.success ? dirRes.path : '.');
        var baseName = E.getBaseFilename(promptText);
        var savedPaths = [];

        for (var ui = 0; ui < (imgUrls || []).length; ui++) {
            var ext = (imgUrls[ui] || '').match(/\.(\w+)(\?|$)/);
            var suffix = ext ? '.' + ext[1] : '.png';
            var saveName = baseName + '_' + (ui + 1) + suffix;
            var savePath = baseDir + '\\' + saveName;
            try {
                var p = await E.downloadQwenImage(imgUrls[ui], savePath);
                savedPaths.push(p.path);
            } catch (e) {
                console.warn('[qwenDraw] Failed to download image ' + (ui + 1), e);
            }
        }
        progressCb('[Qwen] 下载完成');
        progressCb('[Qwen] 删除临时对话...');
        try { await E.execQwen('deleteConversation'); } catch(e) { console.warn('[Qwen] deleteConversation:', e.message); }
        await new Promise(function(r) { setTimeout(r, 500); });
        await E.waitForQwenPageReady();

        var result = '✅ Qwen 绘图完成，共生成 ' + savedPaths.length + ' 张图片。\n\n';
        for (var ui = 0; ui < savedPaths.length; ui++) {
            result += '📁 已保存: ' + savedPaths[ui] + '\n';
        }
        return result;
    };

    // ==================== Qwen PPT 生成 ====================

    E.qwenPPT = async function(content, progressCb) {
        progressCb = progressCb || function(){};
        var lines = content.trim().split('\n');
        var kv = {};
        var promptLines = [];
        var paramRegex = /^(\w+)\s*=\s*(?:"([^"]*)"|'([^']*)'|(\S+))\s*$/;
        for (var li = 0; li < lines.length; li++) {
            var line = lines[li].trim();
            if (!line) continue;
            var m = line.match(paramRegex);
            if (m) {
                var key = m[1].toLowerCase();
                var val = m[2] !== undefined ? m[2] : (m[3] !== undefined ? m[3] : m[4]);
                kv[key] = val;
            } else {
                promptLines.push(line);
            }
        }
        var saveDir = kv.savepath || '';
        var desc = kv.desc || '';
        var refPath = kv.ref || '';
        var promptText = promptLines.join('\n').trim();
        if (!promptText) throw new Error('Missing PPT prompt');

        var fullPrompt = '你是子代理(sub-agent)。请根据以下描述生成一份PPT，务必实际生成PPT文件并输出下载链接，不要仅提供文字描述或建议：\n\n' + promptText;
        if (desc) fullPrompt += '\n\n附加要求：' + desc;
        fullPrompt += ' 返回后对话将被删除，请确保返回完整信息，滚动到页面底部确保所有内容可见。';

        progressCb('[Qwen PPT] 新建对话...');
        await E.execQwen('newConversation');
        await new Promise(function(r) { setTimeout(r, 1000); });

        if (refPath) {
            progressCb('[Qwen PPT] 上传参考文件: ' + refPath + '...');
            var pasteRes = await window.electronAPI.qwenPasteImage(refPath);
            if (!pasteRes.success) {
                progressCb('[Qwen PPT] 参考文件上传失败，继续...');
            } else {
                await new Promise(function(r) { setTimeout(r, 1000); });
            }
        }

        progressCb('[Qwen PPT] 发送PPT生成提示词...');
        await E.execQwen('focusEditor');
        await window.electronAPI.qwenPasteText(fullPrompt);
        await new Promise(function(r) { setTimeout(r, 800); });
        progressCb('[Qwen PPT] 等待PPT生成...');
        await E.execQwen('clickSend');

        var pptRes = await E.execQwen('waitForPPTResponse', [1800000]);
        if (!pptRes.success) throw new Error('Qwen PPT 生成超时或失败');
        await new Promise(function(r) { setTimeout(r, 2000); });

        var downDirRes = await window.electronAPI.getDownloadsPath();
        var baseDir = saveDir || (downDirRes.success ? downDirRes.path : '.');
        progressCb('[Qwen PPT] 准备下载, 保存目录=' + baseDir);
        var downloadPromise = window.electronAPI.qwenPreparePPTDownload(baseDir);

        progressCb('[Qwen PPT] 点击下载按钮...');
        var clickRes = await E.execQwen('clickPPTDownload', []);
        if (!clickRes.success) throw new Error('未找到 PPT 下载按钮');

        var dlRes = await downloadPromise;
        if (!dlRes.success) throw new Error('PPT 下载失败: ' + (dlRes.error || ''));

        progressCb('[Qwen PPT] 下载完成: ' + dlRes.path);
        progressCb('[Qwen PPT] 删除临时对话...');
        try { await E.execQwen('deleteConversation'); } catch(e) { console.warn('[Qwen PPT] deleteConversation:', e.message); }
        await new Promise(function(r) { setTimeout(r, 500); });
        await E.waitForQwenPageReady();

        return '✅ Qwen PPT 生成完成。\n\n📁 已保存: ' + dlRes.path;
    };

    // ==================== Qwen 通用问答 ====================

    E.qwenGeneral = async function(content, progressCb) {
        progressCb = progressCb || function(){};
        var lines = content.split('\n');
        var filePaths = [];
        var textLines = [];
        for (var li = 0; li < lines.length; li++) {
            var line = lines[li].trim();
            var m = line.match(/^path\s*=\s*(.+)$/);
            if (m) {
                filePaths.push(m[1].trim());
            } else if (line) {
                textLines.push(line);
            }
        }
        var text = textLines.join('\n').trim();

        progressCb('[Qwen] 使用 Qwen...');
        progressCb('[Qwen] 新建对话...');
        await E.waitForQwenPageReady();
        await E.execQwen('newConversation');
        await new Promise(function(r) { setTimeout(r, 1000); });

        for (var fi = 0; fi < filePaths.length; fi++) {
            progressCb('[Qwen] 上传文件: ' + filePaths[fi] + '...');
            var pasteRes = await window.electronAPI.qwenPasteImage(filePaths[fi]);
            if (!pasteRes.success) throw new Error('上传文件失败: ' + (pasteRes.error || ''));
            await new Promise(function(r) { setTimeout(r, 1000); });
        }
        if (filePaths.length > 0 && !text) text = '请分析这些文件的内容';

        text = '你是子代理(sub-agent)。不生成PPT，不生成文档。' + text + ' 返回后对话将被删除，请确保返回完整信息，滚动到页面底部确保所有内容可见。';

        progressCb('[Qwen] 发送消息...');
        await E.execQwen('focusEditor');
        await window.electronAPI.qwenPasteText(text);
        await new Promise(function(r) { setTimeout(r, 800); });
        progressCb('[Qwen] 等待回复...');
        await E.execQwen('clickSend');

        var progressDone = false;
        (async function() {
            while (!progressDone) {
                try {
                    var resp = await E.execQwen('isResponding', []);
                    progressCb(resp && resp.responding ? '[Qwen] 正在输出回复...' : '[Qwen] 等待回复...');
                } catch(e) {}
                await new Promise(function(r) { setTimeout(r, 2000); });
            }
        })();

        var waitRes = await E.execQwen('waitForTextResponse', [120000]);
        progressDone = true;
        if (!waitRes.success) throw new Error(waitRes.error === 'Timeout' ? 'Qwen 回复超时' : 'Qwen 回复失败: ' + waitRes.error);
        await new Promise(function(r) { setTimeout(r, 1500); });
        var resultText = await E.getQwenResponseViaCopy();
        progressCb('[Qwen] 删除临时对话...');
        try { await E.execQwen('deleteConversation'); } catch(e) { console.warn('[Qwen] deleteConversation:', e.message); }
        await new Promise(function(r) { setTimeout(r, 500); });
        progressCb('[Qwen] 处理完成');
        return resultText || '(Qwen 未返回内容)';
    };

    // ==================== SendOnly 模式（异步） ====================

    E.qwenGeneralSendOnly = async function(content, progressCb) {
        progressCb = progressCb || function(){};
        var pathRegex = /(\w+)\s*=\s*(?:"([^"]*)"|'([^']*)'|(\S+))/g;
        var match;
        var filePaths = [];
        var lastMatchEnd = 0;
        while ((match = pathRegex.exec(content)) !== null) {
            lastMatchEnd = match.index + match[0].length;
            var key = match[1].toLowerCase();
            var val = match[2] !== undefined ? match[2] : (match[3] !== undefined ? match[3] : match[4]);
            if (key === 'path' && val) filePaths.push(val);
        }
        var text = content.substring(lastMatchEnd).trim();

        await E.waitForQwenPageReady();
        progressCb('[Qwen] qwenGeneralSendOnly: 开始, 新建对话...');
        await E.execQwen('newConversation');
        await new Promise(function(r) { setTimeout(r, 1000); });

        for (var fi = 0; fi < filePaths.length; fi++) {
            var pasteRes = await window.electronAPI.qwenPasteImage(filePaths[fi]);
            if (!pasteRes.success) throw new Error('上传文件失败: ' + (pasteRes.error || ''));
            await new Promise(function(r) { setTimeout(r, 1000); });
        }
        if (filePaths.length > 0 && !text) text = '请分析这些文件的内容';

        text = '你是子代理(sub-agent)。不生成PPT，不生成文档。' + text + ' 返回后对话将被删除，请确保返回完整信息，滚动到页面底部确保所有内容可见。';

        await E.execQwen('focusEditor');
        await window.electronAPI.qwenPasteText(text);
        await new Promise(function(r) { setTimeout(r, 800); });
        progressCb('[Qwen] qwenGeneralSendOnly: 点击发送...');
        await E.execQwen('clickSend');

        progressCb('[Qwen] qwenGeneralSendOnly: 等待对话URL...');
        var urlRes = await E.execQwen('waitForConversationUrl', [10000]);
        var convUrl = (urlRes && urlRes.url) ? urlRes.url : '';
        return { url: convUrl };
    };

    E.qwenDrawSendOnly = async function(content, progressCb) {
        progressCb = progressCb || function(){};
        var lines = content.trim().split('\n');
        var kv = {};
        var promptLines = [];
        var paramRegex = /^(\w+)\s*=\s*(?:"([^"]*)"|'([^']*)'|(\S+))\s*$/;
        for (var li = 0; li < lines.length; li++) {
            var line = lines[li].trim();
            if (!line) continue;
            var m = line.match(paramRegex);
            if (m) {
                var key = m[1].toLowerCase();
                var val = m[2] !== undefined ? m[2] : (m[3] !== undefined ? m[3] : m[4]);
                kv[key] = val;
            } else {
                promptLines.push(line);
            }
        }
        var desc = kv.desc || '';
        var refPath = kv.ref || '';
        var promptText = promptLines.join('\n').trim();
        if (!promptText) throw new Error('Missing drawing prompt');

        var fullPrompt = '请根据以下描述生成图片，务必实际绘制图片并输出图片结果：\n\n' + promptText;
        if (desc) fullPrompt += '\n\n附加要求：' + desc;

        progressCb('[Qwen绘图] 新建对话...');
        await E.execQwen('newConversation');
        await new Promise(function(r) { setTimeout(r, 1000); });

        if (refPath) {
            progressCb('[Qwen绘图] 上传参考图片: ' + refPath + '...');
            var pasteRes = await window.electronAPI.qwenPasteImage(refPath);
            if (!pasteRes.success) {
                progressCb('[Qwen绘图] 参考图上传失败，继续使用纯文本绘图...');
            } else {
                await new Promise(function(r) { setTimeout(r, 1000); });
            }
        }

        progressCb('[Qwen绘图] 发送绘图提示词...');
        await E.execQwen('focusEditor');
        await window.electronAPI.qwenPasteText(fullPrompt);
        await new Promise(function(r) { setTimeout(r, 800); });
        progressCb('[Qwen绘图] 点击发送...');
        await E.execQwen('clickSend');

        progressCb('[Qwen绘图] 等待对话URL...');
        var urlRes = await E.execQwen('waitForConversationUrl', [10000]);
        var convUrl = (urlRes && urlRes.url) ? urlRes.url : '';
        return { url: convUrl, savepath: kv.savepath || '', promptText: promptText };
    };

    E.qwenPPTSendOnly = async function(content, progressCb) {
        progressCb = progressCb || function(){};
        var lines = content.trim().split('\n');
        var kv = {};
        var promptLines = [];
        var paramRegex = /^(\w+)\s*=\s*(?:"([^"]*)"|'([^']*)'|(\S+))\s*$/;
        for (var li = 0; li < lines.length; li++) {
            var line = lines[li].trim();
            if (!line) continue;
            var m = line.match(paramRegex);
            if (m) {
                var key = m[1].toLowerCase();
                var val = m[2] !== undefined ? m[2] : (m[3] !== undefined ? m[3] : m[4]);
                kv[key] = val;
            } else {
                promptLines.push(line);
            }
        }
        var desc = kv.desc || '';
        var refPath = kv.ref || '';
        var promptText = promptLines.join('\n').trim();
        if (!promptText) throw new Error('Missing PPT prompt');

        var fullPrompt = '你是子代理(sub-agent)。请根据以下描述生成一份PPT，务必实际生成PPT文件并输出下载链接：\n\n' + promptText;
        if (desc) fullPrompt += '\n\n附加要求：' + desc;
        fullPrompt += ' 返回后对话将被删除，请确保返回完整信息。';

        progressCb('[Qwen PPT] 新建对话...');
        await E.execQwen('newConversation');
        await new Promise(function(r) { setTimeout(r, 1000); });

        if (refPath) {
            progressCb('[Qwen PPT] 上传参考文件: ' + refPath + '...');
            var pasteRes = await window.electronAPI.qwenPasteImage(refPath);
            if (!pasteRes.success) {
                progressCb('[Qwen PPT] 参考文件上传失败，继续...');
            } else {
                await new Promise(function(r) { setTimeout(r, 1000); });
            }
        }

        progressCb('[Qwen PPT] 发送PPT生成提示词...');
        await E.execQwen('focusEditor');
        await window.electronAPI.qwenPasteText(fullPrompt);
        await new Promise(function(r) { setTimeout(r, 800); });
        progressCb('[Qwen PPT] 点击发送...');
        await E.execQwen('clickSend');

        progressCb('[Qwen PPT] 等待对话URL...');
        var urlRes = await E.execQwen('waitForConversationUrl', [10000]);
        var convUrl = (urlRes && urlRes.url) ? urlRes.url : '';
        return { url: convUrl, savepath: kv.savepath || '', promptText: promptText };
    };

    // ==================== WaitAndExtract 模式 ====================

    E.qwenDrawWaitAndExtract = async function(ref, skipNavigation, progressCb) {
        progressCb = progressCb || function(){};
        if (!ref || !ref.url) return '(Qwen 绘图未返回内容)';

        if (skipNavigation) {
            progressCb('[Qwen绘图] 已在目标对话，原地等待...');
        } else {
            progressCb('[Qwen绘图] 切回对话, URL=' + ref.url);
            await E.execQwen('navigateToUrl', [ref.url]);
            await new Promise(function(r) { setTimeout(r, 2000); });
        }

        progressCb('[Qwen绘图] 等待图片生成...');
        var waitRes = await E.execQwen('waitForDrawResponse', [300000]);
        if (!waitRes.success) {
            if (waitRes.error === 'Timeout') throw new Error('Qwen 绘图超时');
            else throw new Error('Qwen 绘图失败');
        }
        await new Promise(function(r) { setTimeout(r, 1000); });

        var imgUrls = await E.execQwen('getLastImageUrls', []);
        progressCb('[Qwen绘图] 绘图完成，正在下载图片...');

        var dirRes = await window.electronAPI.getDownloadsPath();
        var baseDir = (ref.savepath || '') || (dirRes.success ? dirRes.path : '.');
        var baseName = E.getBaseFilename(ref.promptText || '');
        var savedPaths = [];

        for (var ui = 0; ui < (imgUrls || []).length; ui++) {
            var ext = (imgUrls[ui] || '').match(/\.(\w+)(\?|$)/);
            var suffix = ext ? '.' + ext[1] : '.png';
            var saveName = baseName + '_' + (ui + 1) + suffix;
            var savePath = baseDir + '\\' + saveName;
            try {
                var p = await E.downloadQwenImage(imgUrls[ui], savePath);
                savedPaths.push(p.path);
            } catch (e) {
                console.warn('[qwenDraw] Failed to download image ' + (ui + 1), e);
            }
        }
        progressCb('[Qwen绘图] 下载完成，删除临时对话...');
        try { await E.execQwen('deleteConversation'); } catch(e) { console.warn('[Qwen绘图] deleteConversation:', e.message); }
        await new Promise(function(r) { setTimeout(r, 500); });

        var result = '✅ Qwen 绘图完成，共生成 ' + savedPaths.length + ' 张图片。\n\n';
        for (var ui = 0; ui < savedPaths.length; ui++) {
            result += '📁 已保存: ' + savedPaths[ui] + '\n';
        }
        return result;
    };

    E.qwenPPTWaitAndExtract = async function(ref, skipNavigation, progressCb) {
        progressCb = progressCb || function(){};
        if (!ref || !ref.url) return '(Qwen PPT 生成未返回内容)';

        if (skipNavigation) {
            progressCb('[Qwen PPT] 已在目标对话，原地等待...');
        } else {
            progressCb('[Qwen PPT] 切回对话, URL=' + ref.url);
            await E.execQwen('navigateToUrl', [ref.url]);
            await new Promise(function(r) { setTimeout(r, 2000); });
        }

        progressCb('[Qwen PPT] 等待 PPT 卡片生成...');
        var pptRes = await E.execQwen('waitForPPTResponse', [1800000]);
        if (!pptRes.success) throw new Error('Qwen PPT 生成超时或失败');
        await new Promise(function(r) { setTimeout(r, 2000); });

        var dRes = await window.electronAPI.getDownloadsPath();
        var baseDir = (ref.savepath || '') || (dRes.success ? dRes.path : '.');
        progressCb('[Qwen PPT] 准备下载, 保存目录=' + baseDir);
        var downloadPromise = window.electronAPI.qwenPreparePPTDownload(baseDir);

        progressCb('[Qwen PPT] 点击下载按钮...');
        var clickRes = await E.execQwen('clickPPTDownload', []);
        if (!clickRes.success) throw new Error('未找到 PPT 下载按钮');

        var dlRes = await downloadPromise;
        if (!dlRes.success) throw new Error('PPT 下载失败: ' + (dlRes.error || ''));

        progressCb('[Qwen PPT] 下载完成: ' + dlRes.path);
        progressCb('[Qwen PPT] 删除临时对话...');
        try { await E.execQwen('deleteConversation'); } catch(e) { console.warn('[Qwen PPT] deleteConversation:', e.message); }
        await new Promise(function(r) { setTimeout(r, 500); });

        return '✅ Qwen PPT 生成完成。\n\n📁 已保存: ' + dlRes.path;
    };

    E.qwenWaitAndExtract = async function(ref, skipNavigation, progressCb) {
        progressCb = progressCb || function(){};
        if (!ref || !ref.url) return '(Qwen 未返回内容)';

        if (skipNavigation) {
            progressCb('[Qwen] 已在目标对话，原地等待...');
        } else {
            progressCb('[Qwen] 切回对话, URL=' + ref.url);
            await E.execQwen('navigateToUrl', [ref.url]);
            await new Promise(function(r) { setTimeout(r, 2000); });
        }

        var isResp = await E.execQwen('isResponding', []);
        if (isResp && isResp.responding) {
            progressCb('[Qwen] 等待回复...');
            var waitRes = await E.execQwen('waitForTextResponse', [120000]);
            if (!waitRes.success) throw new Error('Qwen 回复超时');
        }

        await new Promise(function(r) { setTimeout(r, 1500); });
        var resultText = await E.getQwenResponseViaCopy();
        progressCb('[Qwen] 删除临时对话...');
        try { await E.execQwen('deleteConversation'); } catch(e) { console.warn('[Qwen] deleteConversation:', e.message); }
        await new Promise(function(r) { setTimeout(r, 500); });
        return resultText || '(Qwen 未返回内容)';
    };

    // ==================== 本地命令执行（electronAPI only） ====================

    E.readLocal = async function(content, showToastFn) {
        showToastFn = showToastFn || function(){};
        content = content.trim();
        var kv = E.parseKeyValuePairs(content);
        var filePath = kv.path || content;
        var mode = kv.mode || 'professional';
        var force = kv.force === 'true';
        filePath = filePath.trim();
        if (!filePath) throw new Error('Missing file path');

        var infoRes = await window.electronAPI.agentInfo(filePath);
        if (infoRes.success && infoRes.size !== undefined) {
            var sizeKB = Math.round(infoRes.size / 1024);
            var sizeMB = (infoRes.size / 1024 / 1024).toFixed(1);
            if (infoRes.size > 2 * 1024 * 1024) {
                throw new Error('文件 ' + sizeMB + 'MB 超过 2MB，请使用 subreader mode=quick');
            }
            if (mode !== 'quick' && infoRes.size > 10 * 1024) {
                if (!force) {
                    return '⚠️ 文件大小警告：该文件 ' + sizeKB + 'KB（超过 10KB）。请使用 force=true。';
                }
                showToastFn('⚠️ 已强制读取大文件 (' + sizeKB + 'KB)', 3000);
            }
        }
        var res = await window.electronAPI.agentRead(filePath);
        if (!res.success) throw new Error(res.error);
        return res.content;
    };

    E.saveLocal = async function(filePath, content) {
        var res = await window.electronAPI.agentSave(filePath.trim(), content);
        if (!res.success) throw new Error(res.error);
        return res.message;
    };

    E.listLocal = async function(dir) {
        var targetDir = dir && dir.trim();
        if (!targetDir) targetDir = '.';
        var res = await window.electronAPI.agentList(targetDir);
        if (!res.success) throw new Error(res.error);
        var output = res.path + '\n';
        for (var i = 0; i < res.files.length; i++) {
            var f = res.files[i];
            output += (f.isDirectory ? '[DIR] ' : '[FILE] ') + f.name + ' (' + E.formatSize(f.size) + ')\n';
        }
        return output;
    };

    E.mkdirLocal = async function(p) {
        var res = await window.electronAPI.agentMkdir(p.trim());
        if (!res.success) throw new Error(res.error);
        return res.message;
    };

    E.existsLocal = async function(p) {
        var res = await window.electronAPI.agentExists(p.trim());
        if (!res.success) throw new Error(res.error);
        return res.exists ? 'Exists' : 'Not found';
    };

    E.infoLocal = async function(p) {
        var res = await window.electronAPI.agentInfo(p.trim());
        if (!res.success) throw new Error(res.error);
        return 'Path: ' + p + '\nSize: ' + E.formatSize(res.size) + '\nModified: ' + res.mtime + '\nType: ' + (res.isDirectory ? 'Directory' : 'File');
    };

    E.editLocal = async function(filePath, find, regex, replace) {
        var res = await window.electronAPI.agentEdit(filePath.trim(), find, regex, replace || '');
        if (!res.success) throw new Error(res.error);
        return res.message + (res.changed ? ' (Modified)' : ' (No match)');
    };

    E.deleteLocal = async function(p) {
        var res = await window.electronAPI.agentDelete(p.trim());
        if (!res.success) throw new Error(res.error);
        return res.message;
    };

    E.execLocal = async function(cmd, confirmFn) {
        confirmFn = confirmFn || function(){ return true; };
        var lines = cmd.split('\n');
        var timeoutMs;
        var isAdmin = false;
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
                    continue;
                }
                if (key === 'runas' && val.toLowerCase() === 'admin') {
                    isAdmin = true;
                    continue;
                }
            }
            parsedLines.push(lines[li]);
        }
        var actualCmd = parsedLines.join('\n').trim();
        if (!actualCmd) throw new Error('Missing command');

        if (!(await confirmFn('exec', actualCmd))) return '(Cancelled by user)';
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
        return parts.join('\n').trim() || '(Executed, no output)';
    };

    // ==================== 后台定时任务系统（客户端管理） ====================

    var _intervalTasks = {};
    var _pendingIntervalResults = [];
    var _intervalSending = false;

    E.createIntervalTask = async function(params, showToastFn, fillAndSendFn) {
        showToastFn = showToastFn || function(){};
        fillAndSendFn = fillAndSendFn || function(){ return false; };
        var taskName = params.taskName;
        if (!taskName) return '❌ 缺少 taskName';
        if (_intervalTasks[taskName]) return '❌ 任务 "' + taskName + '" 已存在';

        var task = {
            taskName: taskName,
            interval: params.interval || 5000,
            mode: params.mode || 'command',
            message: params.message || '',
            command: params.command || '',
            createdAt: Date.now(),
            status: 'running',
            iteration: 0
        };

        try {
            window.electronAPI.agentForwardResult({
                type: 'interval-start',
                taskName: taskName,
                command: task.mode === 'command' ? task.command : task.message,
                interval: task.interval,
                mode: task.mode
            });
        } catch(e) {}

        _intervalTasks[taskName] = task;
        console.log('[Interval] CREATED: ' + taskName + ' interval=' + task.interval + 'ms mode=' + task.mode);

        var modeLabel = task.mode === 'command' ? '执行命令' : '定时提醒';
        var detail = task.mode === 'command' ? task.command : task.message;
        return '✅ 后台定时任务 "' + taskName + '" 已创建（' + modeLabel + '，每 ' + (task.interval/1000).toFixed(1) + ' 秒）。\n'
            + '内容: ' + (detail.length > 60 ? detail.substring(0, 60) + '...' : detail);
    };

    E.stopIntervalTask = function(taskName) {
        var task = _intervalTasks[taskName];
        if (!task) return '❌ 未找到任务 "' + taskName + '"';
        task.status = 'stopped';
        delete _intervalTasks[taskName];
        _pendingIntervalResults = _pendingIntervalResults.filter(function(r) { return r.taskName !== taskName; });
        try {
            window.electronAPI.agentForwardResult({ type: 'interval-stop', taskName: taskName });
        } catch(e) {}
        return '⏹️ 已停止定时任务 "' + taskName + '"';
    };

    E.stopAllIntervalTasks = function() {
        var names = Object.keys(_intervalTasks);
        names.forEach(function(name) { E.stopIntervalTask(name); });
        _pendingIntervalResults = [];
    };

    E.listIntervalTasks = function() {
        return Object.keys(_intervalTasks).map(function(name) { return _intervalTasks[name]; });
    };

    E.collectPendingIntervalResults = function() {
        if (_pendingIntervalResults.length === 0) return [];
        var results = _pendingIntervalResults.slice();
        _pendingIntervalResults = [];
        return results;
    };

    E.getIntervalTasks = function() { return _intervalTasks; };
    E.getPendingIntervalResults = function() { return _pendingIntervalResults; };
    E.getIntervalSending = function() { return _intervalSending; };
    E.setIntervalSending = function(v) { _intervalSending = v; };

    // ==================== 向后兼容：设置 window.__dsagent_xxx 引用 ====================

    // 工具函数
    window.__dsagent_parseKeyValuePairs = E.parseKeyValuePairs;
    window.__dsagent_parseSingleReadParams = E.parseSingleReadParams;
    window.__dsagent_formatSize = E.formatSize;

    // 命令执行
    window.__dsagent_execLocal = E.execLocal;
    window.__dsagent_readLocal = E.readLocal;
    window.__dsagent_saveLocal = E.saveLocal;
    window.__dsagent_editLocal = E.editLocal;
    window.__dsagent_deleteLocal = E.deleteLocal;
    window.__dsagent_mkdirLocal = E.mkdirLocal;
    window.__dsagent_listLocal = E.listLocal;
    window.__dsagent_existsLocal = E.existsLocal;
    window.__dsagent_infoLocal = E.infoLocal;

    // 定时任务
    window.__dsagent_createInterval = E.createIntervalTask;
    window.__dsagent_stopIntervalByTaskName = E.stopIntervalTask;
    window.__dsagent_listIntervals = E.listIntervalTasks;
    window.__dsagent_stopAllIntervals = E.stopAllIntervalTasks;
    window.__dsagent_queueIntervalResult = function(taskName, content) {
        _pendingIntervalResults.push({ taskName: taskName, content: content, timestamp: Date.now() });
    };

    // Qwen
    window.__dsagent_qwenVision = E.qwenVision;
    window.__dsagent_qwenDraw = E.qwenDraw;
    window.__dsagent_qwenPPT = E.qwenPPT;
    window.__dsagent_qwenGeneral = E.qwenGeneral;
    window.__dsagent_qwenGeneralSendOnly = E.qwenGeneralSendOnly;
    window.__dsagent_qwenDrawSendOnly = E.qwenDrawSendOnly;
    window.__dsagent_qwenPPTSendOnly = E.qwenPPTSendOnly;
    window.__dsagent_qwenDrawWaitAndExtract = E.qwenDrawWaitAndExtract;
    window.__dsagent_qwenPPTWaitAndExtract = E.qwenPPTWaitAndExtract;
    window.__dsagent_qwenWaitAndExtract = E.qwenWaitAndExtract;

    // Subreader
    window.__dsagent_handleSingleRead = function(params) {
        // handleSingleRead needs DOM operations (showToast, findNewChatButton, etc.)
        // This is kept as a thin wrapper in inject-deepseek.js
        // Here we only provide the pure parsing
        return null;
    };

    // 命令引用
    window.__dsagent_buildCmdMap = E.buildCmdMap;
    window.__dsagent_resolveRefs = E.resolveRefs;

    // ==================== 安全确认引擎 ====================
    // 从 inject-deepseek.js 迁移至此，纯业务逻辑，无 DOM 依赖

    E._config = {
        dangerousCommands: [
            'del ', 'erase', 'rd ', 'rmdir', 'format', 'diskpart',
            'shutdown', 'restart', 'reboot', 'taskkill', 'tskill',
            'reg delete', 'reg add', 'sc delete', 'net user',
            'takeown', 'icacls', 'cacls', 'attrib -r -s -h',
            'powershell remove-item', 'rm -rf', 'rm -r', 'dd if=/dev/zero',
            'move ', 'ren ', 'rename '
        ],
        safeOperations: ['read', 'list', 'info', 'exists', 'save', 'edit', 'mkdir', 'subreader', 'interval', 'interval-list', 'break', 'help', 'winapi', 'skill'],
        confirmMode: 'smart',   // 'strict' | 'smart' | 'loose' | 'readonly' | 'custom:...'
        contextCompressThreshold: 100 * 1024
    };

    E.getConfig = function() { return E._config; };

    // 从远程加载配置并合并
    E.loadConfig = async function() {
        try {
            var res = await window.electronAPI.agentConfigLoad();
            if (res.success && res.config) {
                var cfg = res.config;
                if (cfg.dangerousCommands) E._config.dangerousCommands = cfg.dangerousCommands;
                if (cfg.safeOperations) E._config.safeOperations = cfg.safeOperations;
                if (cfg.confirmMode) E._config.confirmMode = cfg.confirmMode;
            }
        } catch (e) {
            console.warn('[Engine] Failed to load config:', e);
        }
    };

    // 保存确认模式到远程
    E.saveConfirmMode = async function(mode) {
        E._config.confirmMode = mode;
        if (window.electronAPI && window.electronAPI.agentConfigLoad) {
            try {
                var res = await window.electronAPI.agentConfigLoad();
                if (res.success) {
                    var cfg = res.config || {};
                    cfg.confirmMode = mode;
                    await window.electronAPI.agentConfigSave(cfg);
                }
            } catch (e) { /* ignore */ }
        }
    };

    // 检测命令是否为危险命令
    E.isDangerousCommand = function(cmd) {
        var lowerCmd = cmd.toLowerCase();
        return E._config.dangerousCommands.some(function(danger) {
            var pattern = new RegExp('\\b' + danger.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
            return pattern.test(lowerCmd);
        });
    };

    // 解析自定义确认模式
    E.parseCustomMode = function(modeStr) {
        var rules = { delete: true, exec: false, write: false, edit: false, mkdir: false };
        if (!modeStr || modeStr.indexOf('custom:') !== 0) return rules;
        var parts = modeStr.replace('custom:', '').split(',');
        parts.forEach(function(p) {
            var kv = p.split('=');
            if (kv.length === 2) rules[kv[0].trim()] = kv[1].trim() === '1';
        });
        return rules;
    };

    // 判断操作是否需要用户确认
    E.needsConfirmation = function(lang, cmd) {
        var mode = E._config.confirmMode;
        // 白名单操作永远不需要确认
        if (E._config.safeOperations.indexOf(lang) !== -1) return false;
        // Qwen 操作不需要确认
        if (['qwen-vision', 'qwen-draw', 'qwen'].indexOf(lang) !== -1) return false;
        // 只读模式：除白名单外全部需要确认
        if (mode === 'readonly') return true;
        // 自定义模式：按规则判断
        if (mode.indexOf('custom:') === 0) {
            var rules = E.parseCustomMode(mode);
            if (lang === 'delete') return rules.delete;
            if (lang === 'exec' || lang === 'cmd') return rules.exec;
            if (lang === 'save') return rules.write;
            if (lang === 'edit') return rules.edit;
            if (lang === 'mkdir') return rules.mkdir;
            return false;
        }
        // delete 总是需要确认（除非宽松模式）
        if (lang === 'delete') return mode !== 'loose';
        // exec / cmd
        if (lang === 'exec' || lang === 'cmd') {
            if (mode === 'loose') return false;
            if (mode === 'strict') return true;
            return E.isDangerousCommand(cmd);
        }
        return false;
    };

    // 异步确认：如不需要确认则直接返回 true，否则弹出确认对话框
    E.confirmCommand = async function(lang, cmd) {
        if (!E.needsConfirmation(lang, cmd)) return true;
        var cmdDisplay = cmd && cmd.length > 200 ? cmd.substring(0, 200) + '...' : cmd;
        try {
            var result = await window.electronAPI.agentRequestConfirm({
                lang: lang,
                cmd: cmd,
                cmdDisplay: cmdDisplay
            });
            return result && result.confirmed;
        } catch (e) {
            console.warn('Confirm dialog failed:', e);
            return false;
        }
    };

    // ==================== 命令执行引擎 ====================
    // 从 inject-deepseek.js 迁移至此，纯工具调用和结果处理

    // 标准化命令结果为统一 JSON 格式
    E.normalizeResult = function(r, lang) {
        if (r && typeof r === 'object' && 'success' in r) {
            if (!r.meta) r.meta = {};
            if (!r.meta.tool) r.meta.tool = lang;
            return r;
        }
        return {
            success: true,
            data: typeof r === 'string' ? r : (r ? JSON.stringify(r) : null),
            error: null,
            meta: { tool: lang }
        };
    };

    // 执行单个命令（纯工具调用，无 DOM 依赖）
    E.execOneCommand = async function(c, cmdMap) {
        var resolvedContent = cmdMap ? E.resolveRefs(c.content, cmdMap) : c.content;
        try {
            var r = null;
            if (c.lang === 'help') {
                var docTargets = resolvedContent.split(/\n|\r/).map(function(s) { return s.trim(); }).filter(function(s) { return s && s !== 'help'; });
                if (docTargets.length > 0) {
                    docTargets.forEach(function(name) {
                        if (window.__dsagent_seenToolDocs && window.__dsagent_seenToolDocs.indexOf(name) === -1) {
                            window.__dsagent_seenToolDocs.push(name);
                        }
                    });
                }
                if (window.__dsagent_tools) {
                    r = await window.__dsagent_tools.execute('help', resolvedContent);
                } else if (window.__dsagent_getInitPromptText) {
                    r = await window.__dsagent_getInitPromptText();
                }
            } else if (window.__dsagent_tools && window.__dsagent_tools.isSupported(c.lang)) {
                r = await window.__dsagent_tools.execute(c.lang, resolvedContent);
            } else {
                return null;
            }

            var jsonResult = E.normalizeResult(r, c.lang);
            delete jsonResult._autoDoc;

            // 输出大小检查
            if (jsonResult.success && typeof jsonResult.data === 'string') {
                var dataLen = jsonResult.data.length;
                var outputKB = Math.round(dataLen / 1024);
                if (dataLen > 159 * 1024) {
                    jsonResult.success = false;
                    jsonResult.error = '输出结果过长 (' + outputKB + 'KB)，无法直接返回对话。建议使用 save 将结果保存到文件。';
                    jsonResult.data = null;
                } else if (dataLen > 10 * 1024 && c.lang !== 'skill') {
                    var hasForce = false;
                    try {
                        var parsed = JSON.parse(resolvedContent.trim());
                        hasForce = parsed.params && parsed.params.force === true;
                    } catch (e) {}
                    if (!hasForce) {
                        jsonResult.data = '⚠️ 输出结果较大 (' + outputKB + 'KB)，可能占用大量上下文。\n如需完整结果，请在 params 中添加 "force": true。\n\n（返回前 2000 个字符供参考）\n\n' + jsonResult.data.substring(0, 2000);
                    }
                }
            }
            return jsonResult;
        } catch (e) {
            return { success: false, data: null, error: e.message, meta: { tool: c.lang } };
        }
    };

    // 转发命令结果到 Agent 视图
    E.forwardResult = function(result) {
        if (!result) return;
        try {
            var content = result.success
                ? (typeof result.data === 'string' ? result.data : JSON.stringify(result.data))
                : ('ERROR: ' + (result.error || ''));
            window.electronAPI.agentForwardResult({
                type: 'tool-results',
                segments: [{
                    type: 'tool-result',
                    lang: (result.meta && result.meta.tool) || 'unknown',
                    success: result.success,
                    content: content
                }]
            });
        } catch (e) {
            console.warn('Failed to forward result:', e);
        }
    };

    // 生成上下文压缩提示文本（纯文本生成，不涉及 DOM/发送）
    E.buildContextCompressPrompt = async function() {
        var prompt = '\n\n---\n\n';
        prompt += '⚠️ 当前对话上下文已较大，为保证后续处理稳定，已自动附上你之前看过的文档。请执行以下操作：\n\n';

        try {
            var helpText = '';
            if (window.__dsagent_tools) {
                helpText = await window.__dsagent_tools.execute('help', '');
            } else if (window.__dsagent_getInitPromptText) {
                helpText = await window.__dsagent_getInitPromptText();
            }
            if (helpText) {
                prompt += '## 系统帮助文档\n\n' + helpText + '\n\n---\n\n';
            }
        } catch (e) {
            console.warn('[ContextCompress] failed to get help doc:', e);
        }

        var seenDocs = window.__dsagent_seenToolDocs || [];
        if (seenDocs.length > 0) {
            prompt += '## 你已查看过的工具文档\n\n';
            for (var di = 0; di < seenDocs.length; di++) {
                try {
                    var docText = '';
                    if (window.__dsagent_tools) {
                        docText = await window.__dsagent_tools.execute('help', seenDocs[di]);
                    }
                    if (docText) {
                        prompt += '### ' + seenDocs[di] + '\n' + docText + '\n\n';
                    }
                } catch (e) {
                    console.warn('[ContextCompress] failed to get tool doc:', seenDocs[di], e);
                }
            }
            prompt += '---\n\n';
        }

        prompt += '**请对前面工作进行历史记忆总结**：\n';
        prompt += '   - 粗略描述用户最初的目标/任务。\n';
        prompt += '   - 列出已完成的关键步骤和当前状态。\n';
        prompt += '   - **重点重申当前正在进行的工作**，以及下一步应该做什么。\n';
        prompt += '   - 将不必要的原始文件内容、超大输出等从记忆中剥离，保留决策信息。\n\n';
        prompt += '**总结完成后，请继续完成当前工作，不要等待用户额外指令。**\n';

        return prompt;
    };

    // 按 lang 分类命令
    E.classifyCommands = function(commands) {
        var sr = [], qw = [], normal = [];
        for (var i = 0; i < commands.length; i++) {
            if (commands[i].lang === 'subreader') {
                sr.push(commands[i]);
            } else if (commands[i].lang === 'qwen') {
                qw.push(commands[i]);
            } else {
                normal.push(commands[i]);
            }
        }
        return { sr: sr, qw: qw, normal: normal };
    };

    console.log('[DS Agent Engine] Loaded');
})();
