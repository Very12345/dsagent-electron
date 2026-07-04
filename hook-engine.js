// hook-engine.js — 统一 Hook 引擎（P1）
// 参考 atomcode 的 HookEngine 设计
// 12 个钩子点：sessionStart/End, promptExtension, before/afterToolExecute,
//  beforeSendMessage, afterExtractResponse, turnStart/Complete,
//  onError, onUserPromptSubmit, onToolCallStart, onModelResponse
'use strict';

const fs = require('fs');
const path = require('path');
const { execSync, spawn } = require('child_process');

// ===== Hook 注册表 =====
const _hooks = {
    // 内置回调式 hooks（通过 registerHook 注册）
    callbacks: {
        sessionStart: [],
        sessionEnd: [],
        promptExtension: [],
        beforeSendMessage: [],
        afterExtractResponse: [],
        beforeToolExecute: [],
        afterToolExecute: [],
        turnStart: [],
        turnComplete: [],
        onError: [],
        onUserPromptSubmit: [],
        onToolCallStart: [],
        onModelResponse: []
    },
    // JSON 配置式 hooks（从 .atomcode/hooks.json / ~/.dsa/hooks.json 加载）
    configHooks: [],
    // 缓存系统 prompt 扩展
    cachedPromptExtensions: null,
    extensionsDirty: true
};

// ===== 内置 Hook 实现 =====

// 工具调用审计日志 Hook
var toolAuditLogHook = {
    name: 'tool-audit-log',
    enabled: false,
    onToolCallStart: function(ctx) {
        if (!this.enabled) return;
        var ts = new Date().toISOString();
        var log = '[' + ts + '] TURN #' + (ctx.turnNumber || '?') + ' | Tool: ' + (ctx.toolName || '') + '\n';
        try {
            fs.appendFileSync(path.join(process.env.HOME || '.', '.dsa', 'tool-audit.log'), log);
        } catch(e) {}
    }
};

// ===== 配置加载 =====

function loadConfigHooks(rootDir) {
    var allHooks = [];
    var configPaths = [];

    // 全局配置
    var home = process.env.HOME || process.env.USERPROFILE || '.';
    configPaths.push(path.join(home, '.dsa', 'hooks.json'));

    // 项目配置
    if (rootDir) configPaths.push(path.join(rootDir, '.dsa', 'hooks.json'));

    configPaths.forEach(function(fp) {
        try {
            if (fs.existsSync(fp)) {
                var data = JSON.parse(fs.readFileSync(fp, 'utf-8'));
                if (Array.isArray(data)) allHooks = allHooks.concat(data);
                else if (data.hooks) allHooks = allHooks.concat(data.hooks);
            }
        } catch(e) {}
    });

    _hooks.configHooks = allHooks;
    _hooks.extensionsDirty = true;
    return allHooks;
}

// ===== Hook 注册 =====

function registerCallbackHook(point, fn) {
    if (_hooks.callbacks[point]) {
        _hooks.callbacks[point].push(fn);
        if (point === 'promptExtension') _hooks.extensionsDirty = true;
        return true;
    }
    return false;
}

// ===== 执行配置式 Hook（shell/webhook 命令） =====

function executeCommandHook(hookConfig, contextJson) {
    return new Promise(function(resolve) {
        if (!hookConfig || !hookConfig.command) { resolve(null); return; }

        var timeout = hookConfig.timeoutMs || 10000;
        var cmd = hookConfig.command;

        try {
            // 通过 stdin 传入 JSON 上下文
            var child = spawn(process.env.COMSPEC || 'cmd.exe', ['/c', cmd], {
                stdio: ['pipe', 'pipe', 'pipe'],
                timeout: timeout,
                windowsHide: true
            });

            var stdout = '';
            var stderr = '';
            var timedOut = false;

            var timer = setTimeout(function() {
                timedOut = true;
                child.kill();
            }, timeout);

            child.stdout.on('data', function(chunk) { stdout += chunk.toString(); });
            child.stderr.on('data', function(chunk) { stderr += chunk.toString(); });

            child.on('close', function(code) {
                clearTimeout(timer);
                if (timedOut) { resolve(null); return; }
                resolve({ stdout: stdout.trim(), stderr: stderr.trim(), code: code });
            });

            if (contextJson) {
                child.stdin.write(JSON.stringify(contextJson));
                child.stdin.end();
            }
        } catch(e) {
            resolve(null);
        }
    });
}

// ===== 钩子点触发 =====

// 1. 获取 system prompt 扩展（供 prompt-builder.js 调用）
function getSystemPromptExtensions() {
    if (!_hooks.extensionsDirty && _hooks.cachedPromptExtensions) {
        return _hooks.cachedPromptExtensions;
    }

    var extensions = [];

    // 内置回调
    _hooks.callbacks.promptExtension.forEach(function(fn) {
        try {
            var result = fn();
            if (result) extensions.push(result);
        } catch(e) {}
    });

    // 配置式 hooks（promptExtension 事件）
    _hooks.configHooks.forEach(function(hook) {
        if (hook.event === 'promptExtension' || hook.event === 'SystemPrompt') {
            try {
                var result = execSync(hook.command, { timeout: hook.timeoutMs || 5000, encoding: 'utf-8', windowsHide: true });
                if (result && result.trim()) extensions.push(result.trim());
            } catch(e) {}
        }
    });

    _hooks.cachedPromptExtensions = extensions;
    _hooks.extensionsDirty = false;
    return extensions;
}

// 2. 触发 session start
function fireSessionStart(rootDir, sessionId) {
    var ctx = { rootDir: rootDir, sessionId: sessionId, timestamp: new Date().toISOString() };

    // 内置回调
    _hooks.callbacks.sessionStart.forEach(function(fn) {
        try { fn(ctx); } catch(e) {}
    });

    // 配置式 hooks
    _hooks.configHooks.forEach(function(hook) {
        if (hook.event === 'sessionStart' || hook.event === 'SessionStart') {
            executeCommandHook(hook, ctx);
        }
    });
}

// 3. 触发 session end
function fireSessionEnd(rootDir, sessionId) {
    var ctx = { rootDir: rootDir, sessionId: sessionId, timestamp: new Date().toISOString() };

    _hooks.callbacks.sessionEnd.forEach(function(fn) {
        try { fn(ctx); } catch(e) {}
    });

    _hooks.configHooks.forEach(function(hook) {
        if (hook.event === 'sessionEnd' || hook.event === 'SessionEnd') {
            executeCommandHook(hook, ctx);
        }
    });
}

// 4. 触发 beforeSendMessage
async function fireBeforeSendMessage(message, modelId) {
    var ctx = { message: message, modelId: modelId, timestamp: new Date().toISOString() };
    var modifiedMessage = message;

    // 内置回调
    for (var i = 0; i < _hooks.callbacks.beforeSendMessage.length; i++) {
        try {
            var result = await _hooks.callbacks.beforeSendMessage[i](ctx);
            if (result && result.modifiedText) modifiedMessage = result.modifiedText;
        } catch(e) {}
    }

    // 配置式 hooks
    for (var hi = 0; hi < _hooks.configHooks.length; hi++) {
        var hook = _hooks.configHooks[hi];
        if (hook.event === 'beforeSendMessage' || hook.event === 'PreToolUse') {
            // 如果有 matcher，匹配 tool 名
            if (hook.matcher) continue; // 非工具事件跳过 matcher
            var result = await executeCommandHook(hook, ctx);
            if (result && result.stdout) {
                try {
                    var parsed = JSON.parse(result.stdout);
                    if (parsed.modifiedText) modifiedMessage = parsed.modifiedText;
                    if (parsed.block) return { blocked: true, reason: parsed.reason || 'Hook 阻止了此消息' };
                } catch(e) {}
            }
        }
    }

    return { modifiedText: modifiedMessage };
}

// 5. 触发 afterExtractResponse
async function fireAfterExtractResponse(originalText, extractedText) {
    var ctx = { originalText: originalText, extractedText: extractedText, timestamp: new Date().toISOString() };
    var modifiedText = extractedText;

    for (var i = 0; i < _hooks.callbacks.afterExtractResponse.length; i++) {
        try {
            var result = await _hooks.callbacks.afterExtractResponse[i](ctx);
            if (result && result.modifiedText) modifiedText = result.modifiedText;
        } catch(e) {}
    }

    return modifiedText;
}

// 6. beforeToolExecute（审计/阻止）
async function fireBeforeToolExecute(toolName, params) {
    var ctx = { tool: toolName, params: params, timestamp: new Date().toISOString() };

    // 内置回调
    for (var i = 0; i < _hooks.callbacks.beforeToolExecute.length; i++) {
        try {
            var result = await _hooks.callbacks.beforeToolExecute[i](ctx);
            if (result && result.block) return { blocked: true, reason: result.reason || '阻止' };
        } catch(e) {}
    }

    // 配置式 hooks
    for (var hi = 0; hi < _hooks.configHooks.length; hi++) {
        var hook = _hooks.configHooks[hi];
        if ((hook.event === 'beforeToolExecute' || hook.event === 'PreToolUse') && (!hook.matcher || toolMatches(hook.matcher, toolName))) {
            var result = await executeCommandHook(hook, ctx);
            if (result && result.stdout) {
                try {
                    var parsed = JSON.parse(result.stdout);
                    if (parsed.block || parsed.decision === 'block') {
                        return { blocked: true, reason: parsed.reason || '拒绝' };
                    }
                } catch(e) {}
            }
        }
    }

    return { blocked: false };
}

// 7. afterToolExecute
async function fireAfterToolExecute(toolName, result) {
    var ctx = { tool: toolName, result: result, timestamp: new Date().toISOString() };

    _hooks.callbacks.afterToolExecute.forEach(function(fn) {
        try { fn(ctx); } catch(e) {}
    });

    _hooks.configHooks.forEach(function(hook) {
        if ((hook.event === 'afterToolExecute' || hook.event === 'PostToolUse') && (!hook.matcher || toolMatches(hook.matcher, toolName))) {
            executeCommandHook(hook, ctx);
        }
    });
}

// ===== 工具函数 =====

function toolMatches(pattern, name) {
    if (!pattern || pattern === '*') return true;
    if (pattern.endsWith('*')) return name.startsWith(pattern.slice(0, -1));
    return pattern === name;
}

// ===== 初始化 =====

function init(rootDir) {
    // 加载审计日志 hook（默认开启）
    toolAuditLogHook.enabled = true;
    registerCallbackHook('onToolCallStart', function(ctx) {
        toolAuditLogHook.onToolCallStart(ctx);
    });

    // 注册默认的编辑验证 hook（P2: Auto Verify）
    registerCallbackHook('afterToolExecute', function(ctx) {
        autoVerifyOnEdit(ctx);
    });

    // 加载配置 hooks
    loadConfigHooks(rootDir);
}

// ===== P2: 自动验证（Auto Verify） =====
// 参考 atomcode VerifyCadenceHook 设计
// 每次 edit_file/write_file/save_file 成功后提醒验证
var _lastVerifiedEdit = null;  // 防止重复验证同一编辑

function autoVerifyOnEdit(ctx) {
    if (!ctx || !ctx.tool) return;
    var toolName = ctx.tool;

    // 只检测编辑类工具
    var editTools = ['edit', 'edit_file', 'save', 'save_file', 'write_file', 'search_replace'];
    if (editTools.indexOf(toolName) < 0) return;

    // 检查是否成功
    var result = ctx.result;
    if (!result || (result.success === false)) return;

    // 防止对同一编辑重复验证
    if (_lastVerifiedEdit === toolName + '|' + Date.now()) return;
    _lastVerifiedEdit = toolName + '|' + Date.now();

    // 读取项目 verify 配置或使用默认
    var verifyCmd = getVerifyCommand(ctx.rootDir);
    if (!verifyCmd) return;

    console.log('[AutoVerify] Tool=' + toolName + ', running: ' + verifyCmd);
    try {
        var cp = require('child_process');
        var result = cp.execSync(verifyCmd, {
            timeout: 30000,
            windowsHide: true,
            encoding: 'utf-8'
        });
        if (result && result.trim()) {
            console.log('[AutoVerify] OK');
        }
    } catch(e) {
        // 验证失败，尝试通知 AI（通过 console/log）
        var errMsg = (e.stdout || e.stderr || e.message || '').substring(0, 500);
        console.warn('[AutoVerify] FAILED: ' + errMsg.substring(0, 200));
        // 验证失败时会输出到控制台，inject 层会收集并回馈给 AI
    }
}

// 读取验证命令配置
function getVerifyCommand(rootDir) {
    // 优先级：项目配置 → 自动检测
    if (rootDir) {
        try {
            var cfgPath = require('path').join(rootDir, '.dsa', 'verify.json');
            if (require('fs').existsSync(cfgPath)) {
                var cfg = JSON.parse(require('fs').readFileSync(cfgPath, 'utf-8'));
                if (cfg.command) return cfg.command;
            }
            // 自动检测项目类型
            if (require('fs').existsSync(require('path').join(rootDir, 'Cargo.toml'))) return 'cargo check 2>&1';
            if (require('fs').existsSync(require('path').join(rootDir, 'package.json'))) return 'npx tsc --noEmit 2>&1 || echo "tsc not found"';
            if (require('fs').existsSync(require('path').join(rootDir, 'go.mod'))) return 'go build ./... 2>&1';
        } catch(e) {}
    }
    return null;
}

// ===== 导出 =====

module.exports = {
    init,
    loadConfigHooks,
    registerCallbackHook,
    getSystemPromptExtensions,
    // 插件支持：加载来自插件目录的 hooks
    loadConfigHooksFromPlugins: function(pluginHooks) {
        if (pluginHooks && pluginHooks.length > 0) {
            _hooks.configHooks = _hooks.configHooks.concat(pluginHooks);
            _hooks.extensionsDirty = true;
        }
    },
    fireSessionStart,
    fireSessionEnd,
    fireBeforeSendMessage,
    fireAfterExtractResponse,
    fireBeforeToolExecute,
    fireAfterToolExecute,
    // 用于外部清除缓存（如配置重载时）
    invalidateExtensions: function() { _hooks.extensionsDirty = true; }
};
