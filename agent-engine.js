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

    // ==================== subreader 已废弃（保留兼容 shim，由 subagent 架构替代） ====================

    // buildSubreaderPrompt 保留为兼容 shim：旧 subreader 命令降级串行执行时仍可能调用
    E.buildSubreaderPrompt = async function(fileListStr, extraPrompt) {
        var parts = ['你是一个子代理(sub-agent)，负责分析文件。请直接返回结果，使用中文。'];
        if (extraPrompt) parts.push('【用户额外要求】\n' + extraPrompt);
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

    // Shell 绕过检测：cat/head/tail/ls/cp/mv/tee 等文件操作命令可能绕过工具审批
    E.isShellFileCommand = function(cmd) {
        var lowerCmd = cmd.trim().toLowerCase();
        return (/\b(cat|head|tail|less|more|nl|tac)\b/.test(lowerCmd) && /\S/.test(lowerCmd)) ||
               (/\b(ls|dir|find|locate)\b/.test(lowerCmd)) ||
               (/\b(cp|copy|mv|move|tee)\b/.test(lowerCmd));
    };

    // 敏感路径检测（读这些路径需要确认）
    E.SENSITIVE_PATTERNS = [
        /[\\\/]\.env\b/,                       // .env / .env.local / .env.production
        /[\\\/]\.ssh[\\\/]/,                   // .ssh/*
        /[\\\/]id_rsa\b/,                      // id_rsa
        /[\\\/]id_ed25519\b/,                  // id_ed25519
        /[\\\/]credentials\b/,                  // credentials
        /[\\\/]secrets?\b/,                    // secret / secrets
        /[\\\/]\w*[-_]?(cert|key|pem|pfx)\b/i, // *cert* / *key* / *.pem / *.pfx
        /[\\\/]\.gitconfig\b/,                 // .gitconfig
        /[\\\/]\.aws[\\\/]/,                   // .aws/*
        /[\\\/]\.gcloud[\\\/]/,                // .gcloud/*
        /[\\\/]config\.json\b.*api.?key/i,     // config.json 含 api key（近似）
    ];
    E.isSensitivePath = function(cmd) {
        if (!cmd) return false;
        var lower = cmd.toLowerCase();
        return E.SENSITIVE_PATTERNS.some(function(p) { return p.test(lower); });
    };

    // 源码文件扩展名
    E.SOURCE_CODE_EXTS = [
        '.js', '.ts', '.jsx', '.tsx', '.mjs', '.cjs',
        '.rs', '.py', '.java', '.go', '.c', '.cpp', '.h', '.hpp', '.cs',
        '.rb', '.php', '.vue', '.svelte', '.swift', '.kt', '.scala',
        '.sh', '.bash', '.ps1', '.bat', '.cmd',
        '.json', '.yaml', '.yml', '.toml', '.xml',
        '.md', '.css', '.scss', '.less', '.html'
    ];
    E.isSourceCodeFile = function(path) {
        if (!path) return false;
        var lower = path.toLowerCase();
        return E.SOURCE_CODE_EXTS.some(function(ext) { return lower.endsWith(ext); });
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
        // Shell 绕过防护：exec/cmd 中的 cat/head/cp/mv 等文件操作继承路径审批
        if (lang === 'exec' || lang === 'cmd') {
            if (E.isShellFileCommand(cmd)) {
                // 对源码文件的写操作（cp/mv/tee）始终需要确认
                if ((/\b(cp|copy|mv|move|tee)\b/.test(cmd) || /\b(>|>>)\s*/.test(cmd)) && mode !== 'loose') {
                    return true;
                }
                // 读操作（cat/head/tail/ls）在 smart 模式下需要确认敏感路径
                if (E.isSensitivePath(cmd)) return true;
            }
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

    // ==================== P0: 循环检测（Loop Guard） ====================
    // 参考 atomcode 的 LoopGuardState 设计
    // 检测同一 (name, args, output, success) 重复 3 次 → 打断
    // STATE_CHANGING 工具（edit/save/write/delete）成功执行时重置计数器

    var STATE_CHANGING = ['edit', 'save', 'write', 'delete', 'edit_file', 'write_file', 'save_file', 'search_replace'];
    var LOOP_THRESHOLD = 3;
    var LOOP_HARD_THRESHOLD = 6;
    var LOOP_WINDOW = 32;

    var _loopRecent = [];

    function _loopKey(name, args) {
        // args 归一化：只取 JSON 字段名（去掉值），避免同一工具不同参数误判
        var argSig = '';
        try {
            var parsed = typeof args === 'string' ? JSON.parse(args) : args;
            argSig = Object.keys(parsed || {}).sort().join(',');
        } catch(e) {
            argSig = String(args).substring(0, 80);
        }
        return name + '\0' + argSig;
    }

    function _loopOutputHash(output) {
        var str = typeof output === 'string' ? output : JSON.stringify(output);
        var hash = 0;
        for (var i = 0; i < str.length; i++) {
            var ch = str.charCodeAt(i);
            hash = ((hash << 5) - hash) + ch;
            hash |= 0;
        }
        return hash;
    }

    function loopGuardCheck(name, args, output, success) {
        if (!name) return { blocked: false };

        var key = _loopKey(name, args);
        var outHash = _loopOutputHash(output);
        var isStateChanging = STATE_CHANGING.indexOf(name) >= 0;

        // 检查是否循环
        var sameKeyCount = 0;
        var strictMatchCount = 0;
        for (var i = 0; i < _loopRecent.length; i++) {
            var e = _loopRecent[i];
            if (e.key === key) {
                sameKeyCount++;
                if (e.outputHash === outHash && e.success === success) {
                    strictMatchCount++;
                }
            }
        }

        // 硬上限：同一 (name, args) 超过 6 次 → 阻止
        if (sameKeyCount >= LOOP_HARD_THRESHOLD) {
            console.warn('[LoopGuard] HARD block: ' + name + ' repeated ' + (sameKeyCount + 1) + ' times');
            return { blocked: true, reason: '工具 ' + name + ' 已重复执行 ' + (sameKeyCount + 1) + ' 次，已自动阻止循环' };
        }

        // 严格检测：同一 (name, args, output, success) 超过 3 次 → 阻止
        if (strictMatchCount >= LOOP_THRESHOLD) {
            console.warn('[LoopGuard] STRICT block: ' + name + ' identical call #' + (strictMatchCount + 1));
            return { blocked: true, reason: '工具 ' + name + ' 已产生相同结果 ' + (strictMatchCount + 1) + ' 次，已自动阻止循环' };
        }

        // 记录本次调用
        _loopRecent.push({
            key: key,
            outputHash: outHash,
            success: !!success,
            name: name,
            timestamp: Date.now()
        });

        // 窗口大小限制
        if (_loopRecent.length > LOOP_WINDOW) _loopRecent.shift();

        // STATE_CHANGING 工具成功执行 → 重置计数器（保留当前记录作为参考, 但清老记录）
        if (isStateChanging && success) {
            _loopRecent = _loopRecent.slice(-3); // 只保留最近 3 条供参考
        }

        return { blocked: false };
    }

    function loopGuardReset() {
        _loopRecent = [];
    }

    // 导出到 window 供 inject 层调用
    window.__dsagent_loopGuardCheck = loopGuardCheck;
    window.__dsagent_loopGuardReset = loopGuardReset;
    E.loopGuardCheck = loopGuardCheck;
    E.loopGuardReset = loopGuardReset;

    // ==================== P1: 文件快照桥接 ====================
    window.__dsagent_fileHistoryBackup = function(filePath) {
        // 通过 electronAPI 调用主进程的文件历史备份
        try {
            if (window.electronAPI && window.electronAPI.fileHistoryBackup) {
                window.electronAPI.fileHistoryBackup(filePath);
            }
        } catch(e) { /* 非关键 */ }
    };

    console.log('[DS Agent Engine] Loaded');
})();
