#!/usr/bin/env node
/**
 * dsagent-cli — 向运行中的 dsagent-electron 进程发送请求
 * 不启动新 Electron 窗口，通过 HTTP 与已有进程通信
 *
 * 用法:
 *   dsagent-cli -p "prompt"                    # 发送消息
 *   dsagent-cli -p "prompt" --model deepseek-v4 # 指定模型
 *   dsagent-cli -p "prompt" --token xxxxxx      # 指定 token
 *   dsagent-cli --token-info                    # 查看 token
 *   dsagent-cli --help                          # 帮助
 *
 * 环境变量:
 *   DSAGENT_TOKEN      API token（可从 --token-info 获取）
 *   DSAGENT_PORT       API 端口（默认 5858）
 *   DSAGENT_HOST       API 主机（默认 127.0.0.1）
 */
// ── 启动输出捕获：截获 console.log/error，等 TUI 初始化后写入 state.body ──
// 消除"启动输出被 CLS 清屏吞掉"的问题
var _startupBuffer = [];
var _originalConsoleLog = console.log;
var _originalConsoleError = console.error;
console.log = function() {
    var msg = Array.prototype.slice.call(arguments).join(' ');
    _startupBuffer.push(msg);
    _originalConsoleLog.apply(console, arguments);
};
console.error = function() {
    var msg = Array.prototype.slice.call(arguments).join(' ');
    _startupBuffer.push('ERROR: ' + msg);
    _originalConsoleError.apply(console, arguments);
};

const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn, execSync } = require('child_process');

// 加载 prompt-builder（纯 JS 模块，无 Electron 依赖）
let promptBuilder = null;
try { promptBuilder = require('../prompt-builder.js'); } catch(e) { console.error('prompt-builder load failed:', e.message); }

// 会话持久化：复用 history-manager（消除 cli-session.json 独立实现）
const historyManager = require('../history-manager.js');

const HOST = process.env.DSAGENT_HOST || '127.0.0.1';
const PORT = parseInt(process.env.DSAGENT_PORT || '5858', 10);
const TOKEN = process.env.DSAGENT_TOKEN || '';
const TOKEN_FILE = path.join(require('os').homedir(), '.dsa', 'api-token.json');

function getTokenFromEnv() {
   return TOKEN;
}

function readTokenFile() {
   try {
       if (fs.existsSync(TOKEN_FILE)) {
           var data = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf-8'));
           return data.token || '';
       }
   } catch(e) {}
   return '';
}

function getEffectiveToken() {
   return getTokenFromEnv() || readTokenFile();
}

// ── 会话持久化（/continue）— 委托给 history-manager，消除本地 cli-session.json ──
function saveSession(state) {
    try { historyManager.saveCliSession(state); } catch(e) { /* non-critical */ }
}

function loadSession() {
    try { return historyManager.loadCliSession(); } catch(e) { return null; }
}

function deleteSession() {
    try { historyManager.deleteCliSession(); } catch(e) {}
}

// 自动启动 Electron（如果未运行）
function ensureServerRunning() {
    return new Promise(function(resolve, reject) {
        // 先尝试连接（快速探测，200ms 超时让 ECONNREFUSED 尽快触发）
        var req = http.get('http://' + HOST + ':' + PORT + '/api/ping', function(res) {
            res.resume();
            resolve(true); // 已运行
        });
        req.on('error', function(e) {
            if (e.code === 'ECONNREFUSED') {
                console.error('提示: dsagent-electron 未运行，正在启动...');
                // 清理残留的 electron.exe 进程（Windows），避免进程堆积
                try {
                    if (process.platform === 'win32') {
                        execSync('taskkill /F /IM electron.exe /T 2>/dev/null', { stdio: 'ignore', timeout: 3000 });
                    }
                } catch(e2) { /* 没有残留进程是正常情况 */ }
                // 查找可执行文件路径（打包环境 vs 开发环境）
                var exePath = findAppExe();
                if (!exePath) {
                    reject(new Error('找不到 dsagent-electron 可执行文件'));
                    return;
                }
                // 开发环境：electron 需要 app 目录参数；打包环境：exe 自带 app
                var isDev = exePath.indexOf('node_modules') >= 0 || exePath.indexOf('electron') >= 0;
                var args = [];
                if (isDev) {
                    args.push(path.join(__dirname, '..')); // app 目录
                    args.push('--no-sandbox');
                    args.push('--disable-logging');
                }
                var child = spawn(exePath, args, {
                    detached: true,
                    stdio: 'ignore',
                    windowsHide: false,
                    env: Object.assign({}, process.env, { DSA_MINIMAL_UI: '1' })
                });
                child.unref();
                // 轮询等待 server 就绪（缩短延迟：首次 800ms，间隔 500ms）
                var deadline = Date.now() + 60000;
                function poll() {
                    var r = http.get('http://' + HOST + ':' + PORT + '/api/ping', function(res) {
                        // 服务就绪后：将终端 CLI 窗口切回前置
                        //（Electron 新窗口弹出时会抢焦点，用 Alt+Tab 切回终端）
                        if (process.platform === 'win32') {
                            try {
                                execSync(
                                    'powershell -windowstyle hidden -noprofile -command "& {Start-Sleep 0.3; Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait(\'%{TAB}\')}"',
                                    { timeout: 3000, stdio: 'ignore' }
                                );
                            } catch(e2) { /* 切前台失败不影响主流程 */ }
                        }
                        resolve(true);
                    });
                    r.on('error', function() {
                        if (Date.now() > deadline) {
                            reject(new Error('启动超时（60秒），请手动启动 dsagent-electron'));
                        } else {
                            setTimeout(poll, 500);
                        }
                    });
                    r.setTimeout(2000, function() { r.destroy(); });
                }
                setTimeout(poll, 800);
            } else {
                reject(e);
            }
        });
        req.setTimeout(500, function() { req.destroy(); });
    });
}

// 查找 dsagent-electron 可执行文件
function findAppExe() {
    // 打包环境：CLI 二进制在 resources/cli/ 下，Electron exe 在上级的上级
    var scriptDir = __dirname;
    var candidates = [
        // 打包 CLI (resources/cli/dsagent-cli.exe → ../../dsagent-electron.exe)
        path.join(scriptDir, '..', '..', 'dsagent-electron.exe'),
        // 打包后 bin/ 目录（resources/app/bin/ → ../../../../dsagent-electron.exe）
        path.join(scriptDir, '..', '..', '..', '..', 'dsagent-electron.exe'),
        // 开发环境：.bat 所在目录的同级
        path.join(scriptDir, 'dsagent-electron.exe'),
        // 上级目录
        path.join(scriptDir, '..', 'dsagent-electron.exe'),
        path.join(scriptDir, '..', '..', 'dsagent-electron.exe'),
        path.join(scriptDir, '..', '..', '..', 'dsagent-electron.exe'),
        // macOS .app 路径
        path.join(scriptDir, '..', '..', '..', '..', 'DeepSeek Agent.app', 'Contents', 'MacOS', 'dsagent-electron'),
        // Linux AppImage
        path.join(scriptDir, '..', '..', '..', 'DeepSeek Agent', 'dsagent-electron'),
    ];
    for (var i = 0; i < candidates.length; i++) {
        if (fs.existsSync(candidates[i])) return candidates[i];
    }
    // 开发环境兜底：用 require('electron') 找到 electron 二进制
    try {
        var electronPath = require('electron');
        return electronPath;
    } catch(e) {}
    return null;
}

function httpGet(path) {
    return new Promise(function(resolve, reject) {
        var options = { hostname: HOST, port: PORT, path: path, method: 'GET', timeout: 5000 };
        var req = http.request(options, function(res) {
            var respBody = '';
            res.on('data', function(chunk) { respBody += chunk; });
            res.on('end', function() {
                try { resolve(JSON.parse(respBody)); } catch(e) { resolve(null); }
            });
        });
        req.on('error', function(e) { resolve(null); });
        req.on('timeout', function() { req.destroy(); resolve(null); });
        req.end();
    });
}

function httpPost(path, data, signal) {
    return new Promise(function(resolve, reject) {
        var body = JSON.stringify(data);
        var options = {
            hostname: HOST,
            port: PORT,
            path: path,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(body)
            },
            timeout: 300000
        };
        var req = http.request(options, function(res) {
            var respBody = '';
            res.on('data', function(chunk) { respBody += chunk; });
            res.on('end', function() {
                try {
                    resolve({ status: res.statusCode, data: JSON.parse(respBody) });
                } catch(e) {
                    resolve({ status: res.statusCode, data: null, raw: respBody });
                }
            });
        });
        req.on('error', function(e) {
            if (e.code === 'ABORT_ERR' || (e.message && e.message.indexOf('abort') >= 0)) return;
            reject(e);
        });
        req.on('timeout', function() { req.destroy(); reject(new Error('请求超时')); });
        if (signal) {
            signal.addEventListener('abort', function() { req.destroy(); }, { once: true });
        }
        req.write(body);
        req.end();
    });
}

// ── 流式 HTTP POST：接收 NDJSON 行，每到达一行调 onLine(line) ──
function httpPostStream(path, data, onLine, signal) {
    return new Promise(function(resolve, reject) {
        var body = JSON.stringify(data);
        var options = {
            hostname: HOST,
            port: PORT,
            path: path,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(body)
            },
            timeout: 300000
        };
        var req = http.request(options, function(res) {
            var buffer = '';
            res.on('data', function(chunk) {
                buffer += chunk.toString();
                // 按行切分 NDJSON
                var nlIdx;
                while ((nlIdx = buffer.indexOf('\n')) >= 0) {
                    var line = buffer.substring(0, nlIdx).trim();
                    buffer = buffer.substring(nlIdx + 1);
                    if (line && onLine) {
                        try { onLine(JSON.parse(line)); } catch(e) { /* ignore malformed line */ }
                    }
                }
            });
            res.on('end', function() {
                resolve(res.statusCode);
            });
        });
        req.on('error', function(e) {
            if (e.code === 'ABORT_ERR' || (e.message && e.message.indexOf('abort') >= 0)) return;
            reject(e);
        });
        req.on('timeout', function() { req.destroy(); reject(new Error('请求超时')); });
        if (signal) {
            signal.addEventListener('abort', function() { req.destroy(); }, { once: true });
        }
        req.write(body);
        req.end();
    });
}

function printHelp() {
    console.log('dsagent-cli — 向运行中的 dsagent-electron 发送请求\n');
    console.log('用法:');
    console.log('  dsagent-cli -p "prompt"                         发送消息');
    console.log('  dsagent-cli -p "prompt" --model modelId          指定模型');
    console.log('  dsagent-cli -p "prompt" --token xxxxxx           指定 token');
    console.log('  dsagent-cli -p "prompt" --system "指令..."       自定义系统提示词');
    console.log('  dsagent-cli -p "prompt" --files a.txt,b.png      附加文件');
    console.log('  dsagent-cli -p "prompt" --images a.png,b.jpg     附加图片');
    console.log('  dsagent-cli -f file.txt                          从文件读取提示词');
    console.log('  dsagent-cli -p "prompt" --role fast              指定集群角色');
    console.log('  dsagent-cli -p "prompt" --template minimal       指定集群模板');
    console.log('  dsagent-cli -p "prompt" --timeout 300000         超时（毫秒）');
    console.log('  dsagent-cli -p "prompt" --raw                    输出原始 JSON');
    console.log('  dsagent-cli -p "prompt" --deep-think             启用深度思考');
    console.log('  dsagent-cli -p "prompt" --prompt-file file.txt   从文件读取提示词');
    console.log('  dsagent-cli --token-info                         查看 token 信息');
    console.log('  dsagent-cli --continue | -c                      恢复上次会话');
    console.log('  dsagent-cli --help                               本帮助\n');
    console.log('环境变量:');
    console.log('  DSAGENT_TOKEN    API token（可从 --token-info 获取）');
    console.log('  DSAGENT_PORT     API 端口（默认 5858）');
    console.log('  DSAGENT_HOST     API 主机（默认 127.0.0.1）\n');
    console.log('注: --model 指定的 API 模型参数（temperature/top_p 等）由服务端自动处理，');
    console.log('    网页模型（deepseek.* / qwen.*）会忽略不支持的参数。\n');
    console.log('示例:');
    console.log('  dsagent-cli -p "总结这个项目" --model openai.gpt-4o');
    console.log('  DSAGENT_TOKEN=abc123 dsagent-cli -p "hello"');
    console.log('  dsagent-cli -p "分析这张图" --files screenshot.png');
}

// ==================== TUI 交互模式（AtomCode 风格） ====================
var _tui_state = null;

async function runInteractive(token, timeout, raw, continueSession) {
    await ensureServerRunning();
    if (!token) token = getEffectiveToken();
    if (!token) {
        console.error('错误: 无法获取 API token。请设置 DSAGENT_TOKEN 环境变量');
        process.exit(1);
    }

    var savedSess = null;
    if (continueSession) {
        savedSess = loadSession();
        if (savedSess) {
            console.log('📋 恢复上次会话 (' + new Date(savedSess.savedAt).toLocaleString() + ')');
        } else {
            console.log('⚠️ 没有可恢复的会话，将新建对话');
        }
    }

    // ── AtomCode 风格常量 ──
    // 颜色映射自 AtomCode theme.rs:
    //   Border / Accent = Cyan (bright cyan 96)
    //   Brand = Magenta (bright magenta 95)
    //   Muted = SGR 90 (DarkGrey / "bright black")
    //   Secondary = default fg (no color)
    var THEMES = {
        'atomcode': {
            name:'AtomCode',
            reset:'\x1b[0m', bold:'\x1b[1m', dim:'\x1b[2m',
            cyan:'\x1b[34m', magenta:'\x1b[95m', gray:'\x1b[90m',
            red:'\x1b[91m', green:'\x1b[92m', yellow:'\x1b[93m',
            rev:'\x1b[7m',
        },
        'warm': {
            name:'暖色',
            reset:'\x1b[0m', bold:'\x1b[1m', dim:'\x1b[2m',
            cyan:'\x1b[93m',  // 标题变金黄
            magenta:'\x1b[92m', // 工具调用变翠绿
            gray:'\x1b[90m',
            red:'\x1b[91m',
            green:'\x1b[96m',  // 成功变青蓝
            yellow:'\x1b[95m', // 警告变紫
            rev:'\x1b[7m',
        },
        'aurora': {
            name:'极光',
            reset:'\x1b[0m', bold:'\x1b[1m', dim:'\x1b[2m',
            cyan:'\x1b[92m',  // 标题变荧光绿
            magenta:'\x1b[96m', // 工具调用变冰蓝
            gray:'\x1b[90m',
            red:'\x1b[91m',
            green:'\x1b[92m',
            yellow:'\x1b[95m', // 警告变紫
            rev:'\x1b[7m',
        },
        'mono': {
            name:'极简',
            reset:'\x1b[0m', bold:'\x1b[1m', dim:'\x1b[2m',
            cyan:'\x1b[1m',  // 标题仅加粗
            magenta:'\x1b[36m', // 工具调用柔青
            gray:'\x1b[2m',
            red:'\x1b[31m',
            green:'\x1b[32m',
            yellow:'\x1b[33m',
            rev:'\x1b[7m',
        }
    };
    var activeTheme = 'atomcode';
    function getC() {
        var t = THEMES[activeTheme] || THEMES['warm'];
        t.HOME = '\x1b[H'; t.CLS = '\x1b[2J'; t.EL = '\x1b[K';
        t.HIDE = '\x1b[?25l'; t.SHOW = '\x1b[?25h';
        return t;
    }
    function setTheme(name) {
        if (THEMES[name]) { activeTheme = name; C = getC(); return true; }
        return false;
    }
    var C = getC();
    function pos(r, c) { return '\x1b[' + r + ';' + c + 'H'; }

    // ── 工具名称格式化（AtomCode 风格） ──
    // snake_case → PascalCase，MCP 用 · 分隔
    function displayToolName(snake) {
        if (!snake) return '';
        if (snake.startsWith('mcp__')) {
            var rest = snake.substring(5);
            var idx = rest.indexOf('__');
            if (idx > 0) return 'mcp · ' + rest.substring(0, idx) + ' · ' + rest.substring(idx + 2);
        }
        return snake.split('_').map(function(w) {
            if (w.length === 0) return '';
            return w[0].toUpperCase() + w.substring(1);
        }).join('');
    }

    // 短名称：去掉 _file/_files/_directory 后缀
    function displayToolNameShort(snake) {
        if (!snake) return '';
        if (snake.startsWith('mcp__')) return displayToolName(snake);
        var trimmed = snake;
        if (trimmed.endsWith('_files')) trimmed = trimmed.slice(0, -6);
        else if (trimmed.endsWith('_file')) trimmed = trimmed.slice(0, -5);
        else if (trimmed.endsWith('_directory')) trimmed = trimmed.slice(0, -10);
        return displayToolName(trimmed);
    }

    // 工具调用详情格式化（AtomCode format_tool_detail 移植）
    function formatToolDetail(name, argsJson) {
        if (!argsJson) return '';
        try { var v = JSON.parse(argsJson); } catch(e) { return ''; }
        var getStr = function(k) { return (v[k] !== undefined && v[k] !== null) ? String(v[k]) : null; };
        var basename = function(p) { var parts = p.replace(/\\/g,'/').split('/'); return parts[parts.length-1] || p; };
        switch (name) {
            case 'read_file': case 'edit_file': case 'write_file': case 'create_file': case 'list_symbols':
                return getStr('file_path') ? basename(getStr('file_path')) : '';
            case 'read_symbol': {
                var sym = getStr('symbol') || '';
                var file = getStr('file_path') ? basename(getStr('file_path')) : '';
                if (!sym) return file;
                if (!file) return sym;
                return sym + ' in ' + file;
            }
            case 'glob': case 'grep':
                return (getStr('pattern') || '').substring(0, 100);
            case 'bash':
                return (getStr('command') || '').substring(0, 500);
            case 'list_directory': case 'list_dir': case 'change_dir':
                return getStr('path') || getStr('dir') || '.';
            case 'web_fetch':
                return (getStr('url') || '').substring(0, 150);
            case 'web_search':
                return (getStr('query') || '').substring(0, 100);
            case 'find_references': case 'trace_callees': case 'trace_callers':
                return getStr('symbol') || '';
            case 'trace_chain': {
                var from = getStr('from') || '';
                var to = getStr('to') || '';
                if (!from || !to) return '';
                return from + ' → ' + to;
            }
            case 'blast_radius': case 'file_dependencies':
                return getStr('file') ? basename(getStr('file')) : '';
            case 'search_replace': {
                var search = getStr('search') || '';
                var replace = getStr('replace') || '';
                var path = getStr('path') || '';
                var out = search.substring(0, 30) + ' → ' + replace.substring(0, 30);
                if (path && path !== '.') out += ' in ' + path;
                return out;
            }
            case 'todo': {
                var action = getStr('action') || '';
                if (action === 'add') return getStr('content') || '';
                if (action === 'update') return '#' + (getStr('id') || '') + ' → ' + (getStr('status') || '');
                if (action === 'list') return 'list all';
                return action;
            }
            default: {
                // 兜底：优先取 file_path/path/symbol/query/url
                var keys = ['file_path', 'path', 'symbol', 'query', 'url', 'dir', 'name'];
                for (var ki = 0; ki < keys.length; ki++) {
                    var val = getStr(keys[ki]);
                    if (val) { return val.substring(0, 100); }
                }
                return '';
            }
        }
    }

    // ── Markdown 行内渲染 ──
    // 处理 **bold** / *italic* / `code` / ~~strikethrough~~
    function renderMdInline(text) {
        var out = '';
        var i = 0;
        while (i < text.length) {
            // **bold**
            if (text[i] === '*' && text[i+1] === '*') {
                var end = text.indexOf('**', i+2);
                if (end > i+2) {
                    out += C.bold + text.substring(i+2, end) + C.reset;
                    i = end + 2;
                    continue;
                }
            }
            // *italic*
            if (text[i] === '*' && text[i+1] !== '*') {
                var end2 = text.indexOf('*', i+1);
                if (end2 > i+1 && text[end2+1] !== '*') {
                    out += C.dim + text.substring(i+1, end2) + C.reset;
                    i = end2 + 1;
                    continue;
                }
            }
            // `code`
            if (text[i] === '`') {
                var end3 = text.indexOf('`', i+1);
                if (end3 > i+1) {
                    out += C.cyan + C.bold + text.substring(i+1, end3) + C.reset;
                    i = end3 + 1;
                    continue;
                }
            }
            out += text[i];
            i++;
        }
        return out;
    }

    // Markdown 逐行渲染（块级 + 行内）
    // 全局代码块状态跟踪
    var _inCodeBlock = false;
    var _codeBlockLang = '';
    function renderMdLine(line) {
        var trimmed = line.trim();
        // 跳过空行
        if (!trimmed) return { line: line, skip: false };

        // 代码块围栏：跟踪状态，围栏行本身以灰色显示
        if (trimmed.startsWith('```') || trimmed.startsWith('~~~')) {
            _inCodeBlock = !_inCodeBlock;
            _codeBlockLang = _inCodeBlock ? trimmed.replace(/^```/, '').trim() : '';
            return { line: C.gray + C.dim + (trimmed.replace(/^```/, '```').replace(/^~~~/, '~~~')) + C.reset, skip: false };
        }

        // 在代码块内：原样输出，不处理 markdown
        if (_inCodeBlock) {
            // A-1: 代码块语法着色
            var highlighted = line;
            try {
                if (typeof require !== 'undefined') {
                    var hl = require('../tools/tool-highlight.js');
                    if (hl && hl.highlightBlock) {
                        highlighted = hl.highlightBlock(line, _codeBlockLang);
                    }
                }
            } catch(e) {}
            return { line: C.reset + highlighted + C.reset, skip: false };
        }

        // 水平线 ---
        if (/^[-*_]{3,}$/.test(trimmed)) {
            return { line: '', skip: false };
        }

        // 标题 # ## ###
        var hd = trimmed.match(/^(#{1,6})\s+(.+)$/);
        if (hd) {
            var level = hd[1].length;
            var inner = renderMdInline(hd[2]);
            var indent = '  '.repeat(level - 1);
            if (level <= 3) {
                return { line: indent + C.cyan + C.bold + inner + C.reset, skip: false };
            }
            return { line: indent + C.dim + inner + C.reset, skip: false };
        }

        // 无序列表 - / *
        var li = trimmed.match(/^(\s*)[-*]\s+(.+)$/);
        if (li) {
            var liIndent = li[1];
            var liText = renderMdInline(li[2]);
            return { line: liIndent + C.magenta + '• ' + C.reset + liText, skip: false };
        }

        // 有序列表 1. 2.
        var oi = trimmed.match(/^(\s*)(\d+)\.\s+(.+)$/);
        if (oi) {
            var oiIndent = oi[1];
            var oiText = renderMdInline(oi[3]);
            return { line: oiIndent + C.gray + oi[2] + '.' + C.reset + ' ' + oiText, skip: false };
        }

        // 表格行 | ... |
        // A-2: 缓冲多行，跨行对齐
        if (trimmed.startsWith('|')) {
            if (!state._tableAccum) state._tableAccum = [];
            state._tableAccum.push(trimmed);
            return { line: '', skip: true };
        }
        // A-2: 非表格行到达时刷出缓冲的表格
        if (state._tableAccum && state._tableAccum.length > 0) {
            var tbl = flushTable(state._tableAccum, state.cols || 80);
            state._tableAccum = [];
            if (tbl) {
                var tblLines = tbl.split('\n');
                for (var tbi = 0; tbi < tblLines.length; tbi++) {
                    pushBodyRow(tblLines[tbi]);
                }
            }
        }

        // 水平线 ---
        if (/^[-*_]{3,}$/.test(trimmed)) {
            return { line: '', skip: false };
        }

        // 标题 # ## ###
        var hd = trimmed.match(/^(#{1,6})\s+(.+)$/);
        if (hd) {
            var level = hd[1].length;
            var inner = renderMdInline(hd[2]);
            var indent = '  '.repeat(level - 1);
            if (level <= 3) {
                return { line: indent + C.cyan + C.bold + inner + C.reset, skip: false };
            }
            return { line: indent + C.dim + inner + C.reset, skip: false };
        }

        // 无序列表 - / *
        var li = trimmed.match(/^(\s*)[-*]\s+(.+)$/);
        if (li) {
            var liIndent = li[1];
            var liText = renderMdInline(li[2]);
            return { line: liIndent + C.magenta + '• ' + C.reset + liText, skip: false };
        }

        // 有序列表 1. 2.
        var oi = trimmed.match(/^(\s*)(\d+)\.\s+(.+)$/);
        if (oi) {
            var oiIndent = oi[1];
            var oiText = renderMdInline(oi[3]);
            return { line: oiIndent + C.gray + oi[2] + '.' + C.reset + ' ' + oiText, skip: false };
        }

        // 默认：行内渲染
        return { line: renderMdInline(line), skip: false };
    }

    // A-2: 跨行表格对齐刷出
    function flushTable(rows, termWidth) {
        if (!rows || rows.length === 0) return '';
        // 解析所有行列
        var parsed = rows.map(function(r) {
            var cells = r.split('|');
            if (cells.length > 0 && cells[0].trim() === '') cells.shift();
            if (cells.length > 0 && cells[cells.length - 1].trim() === '') cells.pop();
            return cells.map(function(c) { return c.trim(); });
        });
        // 计算最大列宽
        var maxCols = 0;
        parsed.forEach(function(p) { if (p.length > maxCols) maxCols = p.length; });
        if (maxCols === 0) return '';
        var colWidths = [];
        for (var ci = 0; ci < maxCols; ci++) {
            var maxW = 0;
            parsed.forEach(function(p) {
                if (ci < p.length) {
                    var w = displayWidth(stripAnsi(renderMdInline(p[ci])));
                    if (w > maxW) maxW = w;
                }
            });
            colWidths.push(Math.min(maxW, Math.floor((termWidth - maxCols * 3 - 2) / Math.max(1, maxCols))));
        }
        // 组装输出
        var out = '';
        var topBorder = function() {
            var parts = [];
            for (var ci = 0; ci < maxCols; ci++) {
                var w = colWidths[ci];
                var line = '';
                for (var li = 0; li < w + 2; li++) line += '─';
                parts.push(line);
            }
            return C.gray + '┌' + parts.join('┬') + '┐' + C.reset;
        };
        var botBorder = function() {
            var parts = [];
            for (var ci = 0; ci < maxCols; ci++) {
                var w = colWidths[ci];
                var line = '';
                for (var li = 0; li < w + 2; li++) line += '─';
                parts.push(line);
            }
            return C.gray + '└' + parts.join('┴') + '┘' + C.reset;
        };
        var hasData = false;
        parsed.forEach(function(p) {
            // 检测分隔行 |---|---| → 画横线
            var joined = p.join(' ');
            if (/^[-:|\s]+$/.test(joined)) {
                var sepParts = [];
                for (var ci = 0; ci < maxCols; ci++) {
                    var w = colWidths[ci];
                    var line = '';
                    for (var li = 0; li < w + 2; li++) line += '─';
                    sepParts.push(line);
                }
                out += (out ? '\n' : '') + C.gray + '├' + sepParts.join('┼') + '┤' + C.reset;
                return;
            }
            if (!hasData) {
                out = topBorder();
                hasData = true;
            }
            var cells = [];
            for (var ci = 0; ci < maxCols; ci++) {
                var txt = ci < p.length ? renderMdInline(p[ci]) : '';
                var vis = displayWidth(stripAnsi(txt));
                var pad = Math.max(0, colWidths[ci] - vis);
                cells.push(' ' + txt + ' '.repeat(pad) + ' ');
            }
            out += (out ? '\n' : '') + C.gray + '│' + C.reset + cells.join(C.gray + '│' + C.reset) + C.gray + '│' + C.reset;
        });
        if (hasData) out += '\n' + botBorder();
        return out;
    }

    // ── 辅助：视觉宽度（ASCII=1, CJK=2） ──
    function displayWidth(s) {
        var w = 0;
        for (var i = 0; i < s.length; i++) {
            var cc = s.charCodeAt(i);
            if (cc >= 32 && cc < 127) w += 1;
            else if (cc === 10 || cc === 13) ; // 换行不占列
            else w += 2; // 全角 / CJK
        }
        return w;
    }

    // ── 辅助：剥离 ANSI 转义码 ──
    function stripAnsi(s) {
        return s.replace(/\x1b\[\d+(;\d+)*m/g, '');
    }

    // ── 辅助：按视觉宽度分行，保留 ANSI 码完整 ──
    // AtomCode wrap_with_cursor：分行 + 返回光标所在行和列（显示宽度）
    // cursorChar: character index into text (NOT byte offset)
    // returns [lines, cursorRow, cursorCol] where cursorCol is display width (0 = after prefix)
    function wrapWithCursor(text, maxCols, cursorChar) {
        if (maxCols <= 0) return [[text || ''], 0, 0];
        var lines = [''];
        var col = 0;
        var cursorRow = 0, cursorCol = 0, cursorSet = false;
        for (var ci = 0; ci < text.length; ) {
            var cp = text.codePointAt(ci);
            var charLen = cp > 0xffff ? 2 : 1;
            var ch = text[ci];
            var isNewline = (ch === '\n');
            var cw = 0;
            if (!isNewline) {
                cw = (cp >= 32 && cp < 127) ? 1 : 2;
                // Wrap check BEFORE writing the char (cursor at wrap boundary → new row)
                if (col + cw > maxCols && lines[lines.length - 1] !== '') {
                    lines.push('');
                    col = 0;
                }
            }
            if (!cursorSet && ci >= cursorChar) {
                cursorRow = lines.length - 1;
                cursorCol = col;
                cursorSet = true;
            }
            if (isNewline) {
                lines.push('');
                col = 0;
            } else {
                lines[lines.length - 1] += text.substring(ci, ci + charLen);
                col += cw;
            }
            ci += charLen;
        }
        if (!cursorSet) {
            cursorRow = lines.length - 1;
            cursorCol = col;
        }
        return [lines, cursorRow, cursorCol];
    }

    // visualWrap：不带光标跟踪的纯分行（保留 ANSI，用于 echoLine 等）
    function visualWrap(text, maxCols) {
        if (maxCols <= 0) return [text || ''];
        var lines = [];
        var currentLine = '';
        var currentW = 0;
        var i = 0;
        while (i < text.length) {
            var ch = text[i];
            if (ch === '\x1b' && text[i + 1] === '[') {
                var end = i + 2;
                while (end < text.length && text[end] !== 'm') end++;
                if (end < text.length) end++;
                currentLine += text.substring(i, end);
                i = end;
                continue;
            }
            var cc = text.charCodeAt(i);
            var cw = (cc >= 32 && cc < 127) ? 1 : 2;
            if (ch === '\n') {
                lines.push(currentLine);
                currentLine = '';
                currentW = 0;
                i++;
                continue;
            }
            if (currentW + cw > maxCols) {
                lines.push(currentLine);
                currentLine = '';
                currentW = 0;
                continue;
            }
            currentLine += ch;
            currentW += cw;
            i++;
        }
        if (currentLine || lines.length === 0) lines.push(currentLine);
        return lines;
    }

    // AtomCode 风格命令定义
    var COMMANDS = [
        { name:'/quit',     desc:'退出',          match:['quit','exit','q'] },
        { name:'/help',     desc:'本帮助',         match:['help','h','?'] },
        { name:'/clear',    desc:'新建对话',       match:['clear','new'] },
        { name:'/model',    desc:'切换模型',       match:['model','m'] },
        { name:'/deepthink',desc:'切换深度思考',   match:['deepthink','think','dt'] },
        { name:'/plan',     desc:'Plan 模式（只读）',match:['plan','p'] },
        { name:'/build',    desc:'Build 模式（执行）',match:['build','b'] },
        { name:'/raw',      desc:'切换原始输出',    match:['raw'] },
        { name:'/timeout',  desc:'设置超时（ms）', match:['timeout','to'] },
        { name:'/token',    desc:'查看 API token', match:['token','t'] },
        { name:'/ctx',      desc:'查看上下文状态', match:['ctx','context'] },
        { name:'/status',   desc:'会话状态概要',   match:['status','s'] },
        { name:'/cd',       desc:'切换工作目录',   match:['cd'] },
        { name:'/cost',     desc:'查看 token 用量',match:['cost'] },
        { name:'/diff',     desc:'查看 git diff', match:['diff'] },
        { name:'/compact',  desc:'压缩对话历史',   match:['compact'] },
        { name:'/undo',     desc:'撤销上一轮',     match:['undo'] },
        { name:'/copy',     desc:'复制代码块',     match:['copy'] },
        { name:'/view',     desc:'预览文件内容',   match:['view','cat'] },
        { name:'/rename',   desc:'重命名会话',     match:['rename'] },
        { name:'/keys',     desc:'键盘快捷键',     match:['keys'] },
        { name:'/theme',    desc:'切换颜色主题',   match:['theme'] },
        { name:'/find',     desc:'搜索对话历史',   match:['find','search'] },
        { name:'/mcp',      desc:'MCP 状态',      match:['mcp'] },
        { name:'/skills',   desc:'浏览技能',       match:['skills'] },
        { name:'/language', desc:'切换语言',       match:['language','lang'] },
        { name:'/bg',       desc:'后台任务',        match:['bg'] },
        { name:'/goal',     desc:'目标自动循环',    match:['goal'] },
    ];

    var state = {
        sessionId: 'cli-repl-' + Date.now() + '-' + Math.random().toString(36).substring(2, 8),
        hasHistory: false,
        modelId: (savedSess && savedSess.modelId) || '',
        deepThink: (savedSess && savedSess.deepThink) || false,
        rawOutput: !!raw,
        timeout: timeout || 180000,
        body: (savedSess && savedSess.body) || [],
        input: '',
        cursor: 0,
        status: { model: (savedSess && savedSess.status && savedSess.status.model) || 'deepseek',
                  cwd: (savedSess && savedSess.status && savedSess.status.cwd) || process.cwd(),
                  tip: '/help 查看命令', ctx: '' },
        cols: 80,
        rows: 24,
        running: true,
        turn: (savedSess && savedSess.turn) || 0,
        round: 0,
        // ── Plan/Build 模式（AtomCode） ──
        mode: 'build',      // 'build' | 'plan'
        sessionName: '',
        language: 'zh',     // 'zh' | 'en'
        // ── Goal row（AtomCode: build_goal_row 摘要行） ──
        goal: (savedSess && savedSess.goal) || null,
        // ── 请求控制（Ctrl+C 取消） ──
        abortController: null,  // AbortController | null
        // ── 命令菜单（AtomCode slash palette） ──
        menu: null,         // { items:[{name,desc}], selected:0 } | null
        // ── 折叠块跟踪 ──
        foldBlocks: [],     // [{start,count}] body 中可折叠的行范围
        // ── 粘贴折叠（AtomCode 风格） ──
        isPasted: false,    // 当前输入是否为粘贴内容
        // ── 旋转动画状态（live body row，非 status bar） ──
        spinning: false,    // 是否正在旋转动画中
        spinTimer: null,    // setInterval 句柄
        spinStart: 0,       // 开始时间戳
        spinLabelIdx: 0,    // 标签轮转索引
        // ── 输入历史（AtomCode: ↑/↓ 翻历史） ──
        history: [],        // 输入历史（最近在前）
        historyIdx: -1,     // 当前浏览位置（-1 = 新输入）
        // ── 撤销栈（AtomCode: /undo） ──
        undoStack: [],      // [{body, goal, turn}] 快照
        // ── 后台任务（/bg） ──
        bgTasks: [],        // [{taskId, text, status, createdAt}]
        // ── 目标循环（/goal） ──
        goalCondition: null, // string | null
        goalActive: false,
        // ── Ctrl+C 安全退出 ──
        _exitWarned: false,
        // ── Esc 双击撤销 ──
        _lastEscTime: 0,
        _escWarned: false,
        // ── 滚动状态 ──
        scrollOffset: 0,
        _inModelMenu: false, // 模型选择菜单模式
        _cursorRow: 1,
        _cursorCol: 1,
        _bodyRows: 0, // 最近一次 redraw 计算的 body 行数（PageUp/Down 用）
        // ── 会话统计（供退出时展示摘要） ──
        _exchangeCount: 0,  // 用户-AI 交互轮次
        _sessionStart: Date.now(), // 会话启动时间戳
        _currentModelName: '', // 当前使用的模型名
        // ── 推理块跟踪 ──
        _inThinkBlock: false,
        // ── 工具调用行跟踪 ──
        _toolCallRows: [],
        // ── 表格累积器 ──
        _tableAccum: null,
        // ── 并行工具批次 ──
        _currentBatchId: null,
        _batchHeaderPushed: false,
        // ── 颜色主题 ──
        _activeTheme: 'atomcode',
    };
    _tui_state = state;

    // 如果是继续会话，恢复 sessionId
    if (savedSess && savedSess.sessionId) {
        state.sessionId = savedSess.sessionId;
        state.hasHistory = savedSess.hasHistory || false;
    }

    // ── 清理退出 ──
    function cleanupExit(msg) {
        state.running = false;
        if (state.spinTimer) { clearInterval(state.spinTimer); state.spinTimer = null; }
        state.spinning = false;
        // 计算会话统计
        var elapsed = Math.round((Date.now() - state._sessionStart) / 1000);
        var elapsedStr = elapsed >= 3600
            ? Math.floor(elapsed / 3600) + 'h ' + Math.floor((elapsed % 3600) / 60) + 'm'
            : elapsed >= 60 ? Math.floor(elapsed / 60) + 'm ' + (elapsed % 60) + 's' : elapsed + 's';
        var modelName = state._currentModelName || state.modelId || '—';
        var summary = '';
        summary += '┌─ DSAgent CLI 会话结束 ─────────────────────┐\n';
        summary += '│  模型: ' + (modelName + '               ').substring(0, 33) + '│\n';
        summary += '│  轮次: ' + (state._exchangeCount + '               ').substring(0, 33) + '│\n';
        summary += '│  持续: ' + (elapsedStr + '               ').substring(0, 33) + '│\n';
        summary += '└──────────────────────────────────────────────┘';
        // 清屏 + 显示摘要
        process.stdout.write(C.CLS + C.HOME + C.SHOW + C.reset);
        console.log('\n' + summary);
        if (msg && msg !== '再见！') console.log('\n' + msg);
        // 禁用 Kitty 键盘协议
        try { process.stdout.write('\x1b[<u'); } catch(e) {}
        if (stdin.setRawMode) stdin.setRawMode(false);
        stdin.pause();
        process.exit(0);
    }

    // 获取终端尺寸
    try { state.cols = process.stdout.columns || 80; state.rows = process.stdout.rows || 24; } catch(e) {}

    function updateTerminalTitle() {
        // 终端标题状态点 🟢/🟡/🔴（AtomCode 等效）
        var glyph = state.spinning ? '🟡' : (state.goalActive ? '🟢' : '🟢');
        var model = state.modelId || 'ds';
        var title = glyph + ' DSAgent [' + model + ']';
        try { process.stdout.write('\x1b]0;' + title + '\x07'); } catch(e) {}
    }

    // Ctrl+Shift+C: 复制选中内容到剪贴板
    function copySelectedToClipboard() {
        // 从 body 中提取最后一段 AI 回复（不含工具行、spinner、复制提示）
        var textToCopy = '';
        for (var ci = state.body.length - 1; ci >= 0; ci--) {
            var line = state.body[ci];
            if (typeof line !== 'string') continue;
            var plain = stripAnsi(line).trim();
            if (plain.match(/^\s*$/) || plain.match(/^───/) || plain.match(/^[✓✗]/)) continue;
            if (plain.match(/^[◎◐▸╰>\[]/) || plain.match(/^[⚙●↻]/)) continue;
            textToCopy = (textToCopy ? plain + '\n' + textToCopy : plain);
        }
        if (!textToCopy) {
            // 回退：复制整个 body 的最后 20 行
            textToCopy = state.body.slice(-20).map(function(l) { return stripAnsi(l); }).join('\n');
        }
        // OSC 52 终端剪贴板协议（兼容 SSH，需终端支持）
        try {
            var b64 = Buffer.from(textToCopy, 'utf-8').toString('base64');
            process.stdout.write('\x1b]52;;' + b64 + '\x07');
            process.stdout.write('\x1b[?2026h');
            echoSystem(C.green + '✓' + C.reset + ' 已复制 (' + textToCopy.length + ' 字符)');
            redraw();
        } catch(e) {
            echoSystem(C.red + '✗' + C.reset + ' 复制失败: 终端不支持 OSC 52');
            redraw();
        }
    }

    // ── 菜单过滤 ──
    // 可用模型列表（DeepSeek + Qwen）
    var MODEL_ITEMS = [
        { name: 'deepseek.fast', desc: 'DeepSeek 快速' },
        { name: 'deepseek.expert', desc: 'DeepSeek 专家' },
        { name: 'deepseek.image', desc: 'DeepSeek 图片' },
        { name: 'qwen.default', desc: 'Qwen 默认' },
    ];
    function isModelMenu() { return state._inModelMenu; }
    function updateMenu() {
        // 模型选择模式：不干扰菜单
        if (state._modelSelectionPending) return;
        if (!state.input || state.input.indexOf('/') !== 0) {
            state.menu = null;
            state._inModelMenu = false;
            return;
        }
        var typed = state.input.toLowerCase().substring(1); // 去掉 /
        // 按 / 后第一个空格分界：如果已有空格则是命令参数输入，不弹菜单
        if (typed.indexOf(' ') >= 0) { state.menu = null; return; }
        var items = [];
        for (var ci = 0; ci < COMMANDS.length; ci++) {
            var cmd = COMMANDS[ci];
            var rawName = cmd.name.substring(1); // 去掉 /
            if (rawName.indexOf(typed) === 0) {
                items.push({ name: cmd.name, desc: cmd.desc });
            } else {
                // 按别名匹配
                for (var ai = 0; ai < cmd.match.length; ai++) {
                    if (cmd.match[ai].indexOf(typed) === 0) {
                        items.push({ name: cmd.name, desc: cmd.desc });
                        break;
                    }
                }
            }
        }
        if (items.length === 0 || items.length === 1 && items[0].name === '/' + typed) {
            state.menu = null;
            return;
        }
        state.menu = { items: items, selected: 0 };
    }

    function getFooterRows() {
        var menuRows = state.menu ? Math.min(state.menu.items.length, 5) : 0;
        var goalRow = state.goal ? 1 : 0;
        var textBudget = Math.max(1, (state.cols || 80) - 2);
        var _wc = wrapWithCursor(state.input || '', textBudget, state.cursor || 0);
        var inputLines = _wc[0];
        var h = state.rows || 24;
        var MAX_INPUT_ROWS = 10;
        var reservedInputRows = 2 + 0 + menuRows + goalRow + 1 + 1;
        var maxInputRows = Math.max(1, Math.min(MAX_INPUT_ROWS, h - reservedInputRows));
        var middleRows = Math.min(inputLines.length, maxInputRows);
        return 1 + middleRows + 1 + menuRows + goalRow + 1;
    }

    // ── body push (严格对齐 AtomCode append-only 模型) ──
    // AtomCode 核心：emit_body_line_inner 在 push 前计算 visible_len，
    // 溢出时在屏幕最后一行输出 LF 触发终端原生向上滚动。
    // 所有 body 行必须通过 pushBodyRow 进入 terminal，严禁 splice 直接改数组。
    var _scrolledOff = 0;       // 已滚入终端原生 scrollback 的行数
    var _liveSpinnerActive = false;  // spinner 是否活跃（最后一行是 spinner）
    function pushBodyRow(line) {
        // AtomCode: emit BEFORE push (body_lines.len() 不含新行)
        emitBodyLineInner(line);
        state.body.push(line);
        // 溢出内存缓存上限 AtomCode MAX_SCROLLBACK_ROWS=5000
        while (state.body.length > 5000) {
            state.body.shift();
            _scrolledOff = Math.max(0, _scrolledOff - 1);
        }
    }
    function bodyPush(cells) {
        for (var i = 0; i < cells.length; i++) {
            pushBodyRow(cells[i]);
        }
    }
    function emitBodyLineInner(line) {
        var h = state.rows || 24;
        var w = state.cols || 80;
        var footerRows;
        try { footerRows = getFooterRows(); } catch(e) { footerRows = 4; }
        var cap = Math.max(1, h - footerRows);
        if (cap <= 0 || h <= 1) return;
        // AtomCode: visible_len = body_lines.len() - scrolled_off (emit 时还没 push)
        var visibleLen = state.body.length - _scrolledOff;
        var display = truncateToWidth(line || '', w);
        try {
            process.stdout.write('\x1b[?2026l\x1b[?25l');
            // 溢出循环：visible_len >= cap 时在屏幕最后一行输出 \n 触发终端向上滚动
            while (visibleLen >= cap) {
                process.stdout.write('\x1b[' + h + ';1H\n');
                _scrolledOff++;
                visibleLen--;
            }
            // target_1idx = visible_len + 1（新行落点，1-indexed）
            var target1idx = visibleLen + 1;
            // CUP to target → EL（只清目标行，不擦 footer）
            process.stdout.write('\x1b[' + target1idx + ';1H\x1b[K');
            process.stdout.write(display);
            // LF（光标下移，不滚动因为 target < h）
            process.stdout.write('\n');
        } catch(e) {}
    }
    // 截断行到指定视觉宽度（保留 ANSI 码）
    function truncateToWidth(line, maxW) {
        var stripped = stripAnsi(line);
        var visW = displayWidth(stripped);
        if (visW <= maxW) return line;
        var acc = '', accW = 0, si = 0;
        while (si < line.length && accW < maxW) {
            if (line[si] === '\x1b' && line[si+1] === '[') {
                var end = si + 2;
                while (end < line.length && line[end] !== 'm') end++;
                if (end < line.length) end++;
                acc += line.substring(si, end); si = end; continue;
            }
            var cc = line.charCodeAt(si);
            var cw = (cc >= 32 && cc < 127) ? 1 : 2;
            if (accW + cw > maxW) break;
            acc += line[si]; accW += cw; si++;
        }
        return acc;
    }
    // ── spinner: push_or_update_live_spinner (AtomCode 模式) ──
    // 首次通过 pushBodyRow 追加到最后一行；后续更新在原地重写（CUP + EL + write，无 LF）
    function pushOrUpdateSpinner(line) {
        if (_liveSpinnerActive) {
            // AtomCode: 更新 last row in-place
            if (state.body.length > 0) {
                state.body[state.body.length - 1] = line;
            }
            // 定位到 body_bottom_row（可见区域的最后一行）
            var h = state.rows || 24;
            var footerRows;
            try { footerRows = getFooterRows(); } catch(e) { footerRows = 4; }
            var cap = Math.max(1, h - footerRows);
            if (cap <= 0) return;
            var visibleLen = state.body.length - _scrolledOff;
            var bodyBottom = Math.min(visibleLen, cap);
            if (bodyBottom < 1) return;
            try {
                process.stdout.write('\x1b[?2026l\x1b[?25l');
                var display = truncateToWidth(line, state.cols || 80);
                process.stdout.write('\x1b[' + bodyBottom + ';1H\x1b[K' + display);
            } catch(e) {}
        } else {
            pushBodyRow(line);
            _liveSpinnerActive = true;
        }
    }
    // 清除 spinner（AtomCode clear_live_spinner + body_lines.pop）
    // 会擦除终端上的 spinner 行
    function clearSpinner() {
        if (!_liveSpinnerActive) return false;
        _liveSpinnerActive = false;
        if (state.body.length > 0) {
            // 找到 spinner 在屏幕上的行，EL 擦除
            var h = state.rows || 24;
            var footerRows;
            try { footerRows = getFooterRows(); } catch(e) { footerRows = 4; }
            var cap = Math.max(1, h - footerRows);
            var visibleLen = state.body.length - _scrolledOff;
            var bodyBottom = Math.min(visibleLen, cap);
            if (bodyBottom >= 1) {
                try {
                    process.stdout.write('\x1b[' + bodyBottom + ';1H\x1b[K');
                } catch(e) {}
            }
            state.body.pop();
        }
        return true;
    }

    // ── 重新绘制 footer ──
    // AtomCode 模式：footer 在 body 内容下方，不是绝对定位屏幕底部。
    // footerTop = visibleBodyLen（可直接在 body 下一行画 footer）。
    // 当 body+footer >= h 时，overflow 循环让 body 向上滚入 scrollback，
    // footer 自然保持在屏幕底部。
    function redraw() {
        updateTerminalTitle();
        var w = state.cols, h = state.rows;
        var visibleBodyLen = state.body.length - _scrolledOff;

        var textBudget = Math.max(1, w - 2);
        // AtomCode wrap_with_cursor：分行 + 返回光标行列
        var _wc = wrapWithCursor(state.input || '', textBudget, state.cursor || 0);
        var inputLines = _wc[0];
        var cursorRowInMiddle = _wc[1];   // 0-indexed row
        var cursorColInRow = _wc[2];      // display width (0 = after "> " prefix)

        var menuRows = state.menu ? Math.min(state.menu.items.length, 5) : 0;
        var hasGoal = !!state.goal;
        var statusRows = 1;
        var goalRows = hasGoal ? 1 : 0;
        var attachmentRows = 0;
        // AtomCode max_input_rows: leave room for top_rule(1) + bot_rule(1) + attachments + menu + goal + status + 1 body row
        var MAX_INPUT_ROWS = 10;
        var reservedInputRows = 2 + attachmentRows + menuRows + goalRows + statusRows + 1;
        var maxInputRows = Math.max(1, Math.min(MAX_INPUT_ROWS, h - reservedInputRows));
        var inputViewStart = inputLines.length > maxInputRows
            ? Math.min(
                Math.max(0, cursorRowInMiddle - (maxInputRows - 1)),
                inputLines.length - maxInputRows
              )
            : 0;
        var cursorRowInMiddle = cursorRowInMiddle - inputViewStart;
        var middleRows = Math.min(inputLines.length - inputViewStart, maxInputRows);
        var totalFooterRows = 1 + middleRows + 1 + attachmentRows + menuRows + goalRows + statusRows;
        // AtomCode: footerTop = body_rows_on_screen = min(visibleBodyLen, h - totalFooterRows)
        var bodyRowsOnScreen = Math.min(visibleBodyLen, Math.max(0, h - totalFooterRows));
        var footerTop = bodyRowsOnScreen;

        process.stdout.write('\x1b[?2026l\x1b[?25l');

        var sep = '';
        for (var ci = 0; ci < w; ci++) sep += '─';

        // Footer 从 footerTop 下一行开始
        var topRuleRow = footerTop + 1;
        var inputRow = topRuleRow + 1;
        var botRuleRow = inputRow + middleRows;
        var menuStartRow = botRuleRow + 1;
        var goalRow = hasGoal ? (menuStartRow + menuRows) : -1;
        var statusRow = hasGoal ? (goalRow + 1) : (menuStartRow + menuRows);

        process.stdout.write(pos(topRuleRow, 1) + C.EL + C.cyan + sep + C.reset);

        var slicedMiddle = inputLines.slice(inputViewStart, inputViewStart + middleRows);
        for (var i = 0; i < slicedMiddle.length; i++) {
            var prefix = (inputViewStart + i === 0) ? (C.cyan + '> ' + C.reset) : '  ';
            process.stdout.write(pos(inputRow + i, 1) + C.EL + prefix + slicedMiddle[i]);
        }

        process.stdout.write(pos(botRuleRow, 1) + C.EL + C.cyan + sep + C.reset);

        if (state.menu) {
            var shown = Math.min(state.menu.items.length, 5);
            for (var mi = 0; mi < shown; mi++) {
                var item = state.menu.items[mi];
                var isSel = mi === state.menu.selected;
                var selStyle = isSel ? (C.cyan + C.rev) : '';
                var disp = '  ' + (isSel ? '▸' : ' ') + ' ' + item.name;
                var padLen = w - disp.length - (item.desc || '').length - 4;
                process.stdout.write(pos(menuStartRow + mi, 1) + C.EL
                    + selStyle + disp + C.reset
                    + ' '.repeat(Math.max(0, padLen))
                    + C.gray + (item.desc || '') + C.reset);
            }
        }

        if (state.goal) {
            var goalText = C.cyan + '◎ ' + C.reset + state.goal.condition
                + C.gray + ' · round ' + state.goal.round + ' · ' + state.goal.elapsed + C.reset;
            process.stdout.write(pos(goalRow, 1) + C.EL + goalText);
        }

        // Status line
        var leftParts = [];
        if (state.status.model) leftParts.push(state.status.model);
        if (state.mode === 'plan') leftParts.push(C.yellow + 'Plan' + C.gray);
        if (state.deepThink) leftParts.push(C.magenta + '🧠' + C.gray);
        if (state.status.ctx) leftParts.push(state.status.ctx);
        var left = leftParts.join('  ');
        if (state.status.cwd) {
            var cwdDisplay = state.status.cwd;
            var leftW = displayWidth(stripAnsi(left));
            var cwdW = displayWidth(cwdDisplay);
            var maxLeftW = Math.floor(w * 0.6);
            if (leftW + cwdW + 4 > maxLeftW) {
                var budget = maxLeftW - leftW - 4;
                var truncated = '', tw = 0;
                for (var ci3 = 0; ci3 < cwdDisplay.length && tw + 2 < budget; ci3++) {
                    var cc3 = cwdDisplay.charCodeAt(ci3);
                    var cw3 = (cc3 >= 32 && cc3 < 127) ? 1 : 2;
                    if (tw + cw3 > budget - 2) break;
                    truncated += cwdDisplay[ci3]; tw += cw3;
                }
                cwdDisplay = truncated + '…';
            }
            left += '  ' + cwdDisplay;
        }
        var tip = state.status.tip || '';
        var leftVisible = displayWidth(stripAnsi(left));
        var tipVisible = displayWidth(stripAnsi(tip));
        var avail = w - leftVisible - 2;
        var tipPad = '';
        if (avail > tipVisible + 2) tipPad = ' '.repeat(avail - tipVisible);
        process.stdout.write(pos(statusRow, 1) + C.EL + C.gray + left + tipPad + tip + C.reset);

        // 清除 statusRow 以下残影
        for (var cr = statusRow + 1; cr <= h; cr++) {
            process.stdout.write(pos(cr, 1) + C.EL);
        }

        // 光标定位 — AtomCode 公式：footerTop + 1 + cursor_row_in_middle + 1（1-indexed）
        var cursorAbsRow = footerTop + 1 + cursorRowInMiddle + 1;
        // AtomCode 公式：2 + cursor_col_in_row + 1（2 = "> " 前缀）
        var cursorAbsCol = 2 + cursorColInRow + 1;
        state._cursorRow = cursorAbsRow;
        state._cursorCol = cursorAbsCol;
        // AtomCode: spinner/tool 活跃时隐藏光标
        if (_liveSpinnerActive || state.spinning) {
            process.stdout.write(C.HIDE);
        } else {
            process.stdout.write(pos(cursorAbsRow, cursorAbsCol) + C.SHOW);
        }
        if (process.stdout._flush) process.stdout._flush();
    }

    // ── 仅重绘 Footer（输入/状态变化时用，body 不变） ──
    function redrawFooter() {
        redraw(); // 简化：全量重画，body 不变也只是重写一遍
    }

    // ── 工具函数：消息行 ──
    // prefixOnlyFirst=true（默认）：只有第一行加 prefix，续行无前缀无缩进（适合 markdown 正文）
    // prefixOnlyFirst=false：续行加 2 空格缩进（适合带 prefix 的对话行）
    function echoLine(prefix, text, prefixOnlyFirst) {
        var maxW = Math.max(20, state.cols - 4);
        var wrapped = visualWrap(text, maxW);
        if (wrapped.length === 0) wrapped = [''];
        var rows = [];
        var contPrefix = (prefixOnlyFirst === false) ? '  ' : '';
        for (var li = 0; li < wrapped.length; li++) {
            rows.push((li === 0 ? prefix : contPrefix) + wrapped[li]);
        }
        bodyPush(rows);
        // 不在 echoLine 里设 scrollOffset=0——用户主动发送时在 handleInput 设，
        // 这样 AI 回复追加时不会跳回最新。
        redraw();
    }

    function echoSystem(text) {
        echoLine(C.gray + '', text, false);
    }

    function echoUser(text) {
        echoLine(C.cyan + '▸' + C.gray + ' ' + C.reset, text, false);
    }

    // echoAssistant: markdown 正文，逐行渲染 **bold**、`code`、列表、标题等
    function echoAssistant(text) {
        var lines = text.split('\n');
        for (var li = 0; li < lines.length; li++) {
            var r = renderMdLine(lines[li]);
            if (r.line) {
                echoLine('', r.line, true);
            }
        }
    }

    function echoError(text) {
        echoLine(C.red + '╰─ ' + C.reset, text, false);
    }

    function setStatus(model, tip, ctx) {
        if (model !== undefined) state.status.model = model;
        if (tip !== undefined) state.status.tip = tip;
        if (ctx !== undefined) state.status.ctx = ctx;
        redrawFooter(); // 仅状态行变化，无需全量重绘
    }

    // ── 清屏重绘 ──
    function clearAll() {
        state.body = [];
        state.scrollOffset = 0;
        _scrolledOff = 0;
        _footerDirty = true;
        process.stdout.write(C.CLS + C.HOME);
        redraw();
    }

    // ── 初始画面 ──
    // 设计：logo + welcome 全部 push 到 state.body。
    // CLS 之前只操作数组（不 emit），CLS 后再统一 emitBodyLineInner 写到终端，
    // 防止 CLS 前后重复 emit 导致双 logo。

    // 1. 启动输出（console.log 截获）直接丢弃——TUI 启动后 CLS 会清屏，
    //    这些文本（如"提示: dsagent-electron 未运行"）不应进 body，否则显示成乱码。
    //    保留 _startupBuffer 仅供调试，不灌入 body。
    _startupBuffer = [];

    // 2. logo push 到 body（仅数组，不 emit）
    var logoPath = path.join(__dirname, '..', 'assets', 'logo.txt');
    var logoText = '';
    try { logoText = fs.readFileSync(logoPath, 'utf-8'); } catch(e) {}
    if (logoText) {
        var logoLines = logoText.split('\n');
        for (var li = 0; li < logoLines.length; li++) {
            var trimmed = logoLines[li].replace(/\r$/, '');
            if (trimmed.length > 0) {
                state.body.push(C.cyan + trimmed + C.reset);
            }
        }
    }

    // 3. welcome push 到 body（仅数组，不 emit）
    state.body.push('');
    state.body.push(C.bold + 'dsagent-electron' + C.reset + C.gray + ' v' + require('../package.json').version + C.reset);
    state.body.push(C.gray + state.status.cwd + C.reset);
    state.body.push(C.gray + (state.modelId || 'deepseek') + C.reset);
    state.body.push('');
    state.body.push(C.gray + 'type something, or press / to browse commands' + C.reset);
    state.body.push(C.gray + '/help  to view all commands' + C.reset);
    state.body.push('');

    // 4. 启动：CLS + 逐行 emitBodyLineInner 输出 logo/welcome + 画 footer
    process.stdout.write(C.CLS + C.HOME + C.HIDE);
    // 先清 state.body，让 emitBodyLineInner 从 0 开始计 visible_len
    var _startupBody = state.body.slice();
    state.body = [];
    for (var bi = 0; bi < _startupBody.length; bi++) {
        emitBodyLineInner(_startupBody[bi]);
        state.body.push(_startupBody[bi]);
    }
    redraw();

    // ── Raw mode ──
    var stdin = process.stdin;
    if (stdin.setRawMode) stdin.setRawMode(true);
    stdin.resume();

    // ── Kitty 键盘协议 (CSI u) ──
    // 启用后终端发送 Shift+Enter = \x1b[13;2u, Ctrl+Enter = \x1b[13;5u 等
    // 目前已知支持: Windows Terminal / WezTerm / Kitty / iTerm2
    // 不支持的终端会自动忽略此序列，不影响其他功能
    try { process.stdout.write('\x1b[>1u'); } catch(e) {}

    // ── 终端 resize ──
    process.stdout.on('resize', function() {
        try { state.cols = process.stdout.columns || 80; state.rows = process.stdout.rows || 24; } catch(e) {}
        redraw();
    });

    // ── 键盘处理 ──
    // Windows raw mode 逐字节交付，需要输入缓冲区累积完整 CSI 序列
    var _inputBuf = '';  // 字节缓冲区
    stdin.on('data', function(chunk) {
        if (!state.running) return;
        var raw = chunk.toString('utf8');
        // 累计到缓冲区
        _inputBuf += raw;
        // 循环从缓冲区提取并处理完整的"事件"（普通字符或完整 CSI 序列）
        while (_inputBuf.length > 0) {
            var b0 = _inputBuf[0];
            // 如果缓冲区以 \x1b 开头，尝试收集完整 CSI 序列
            if (b0 === '\x1b') {
                if (_inputBuf.length < 2) break; // 等下一 chunk
                if (_inputBuf[1] === '[') {
                    // CSI 序列：找终结符（字母或 ~）
                    var ci = 2;
                    while (ci < _inputBuf.length) {
                        var bc = _inputBuf[ci];
                        if ((bc >= 'a' && bc <= 'z') || (bc >= 'A' && bc <= 'Z') || bc === '~') {
                            // 完整 CSI 序列
                            var seq = _inputBuf.substring(0, ci + 1);
                            _inputBuf = _inputBuf.substring(ci + 1);
                            // 解析 CSI 序列
                            parseCSI(seq);
                            break;
                        }
                        ci++;
                    }
                    if (ci >= _inputBuf.length) break; // 未完整，等更多字节
                } else {
                    // \x1b 后不是 [，可能是裸 ESC 或 Alt+组合键
                    // Alt+Enter: \x1b\r 或 \x1b\n
                    if (_inputBuf.length >= 2 && (_inputBuf[1] === '\r' || _inputBuf[1] === '\n')) {
                        _inputBuf = _inputBuf.substring(2);
                        // Alt+Enter → 插入换行
                        state.input = state.input.substring(0, state.cursor) + '\n' + state.input.substring(state.cursor);
                        state.cursor++;
                        redrawFooter();
                        continue;
                    }
                    // 裸 ESC → handleEscPress
                    _inputBuf = _inputBuf.substring(1);
                    handleEscPress();
                    continue;
                }
                continue;
            }
            // 普通字符或控制字符
            _inputBuf = _inputBuf.substring(1);
            handleChar(b0);
        }
    });

    // ── CSI 序列解析 ──
    // 处理完整的 CSI 序列如 \x1b[A（↑）、\x1b[13;2u（Shift+Enter）、\x1b[3~（Delete）等
    function parseCSI(seq) {
        // seq 格式: \x1b[... 已去除 \x1b[
        var inner = seq.substring(2); // 去掉 \x1b[
        var term = inner[inner.length - 1]; // 终结符
        var body = inner.substring(0, inner.length - 1); // 终结符之前的部分

        // ~ 序列: \x1b[N~
        if (term === '~') {
            var num = parseInt(body, 10);
            if (num === 3) { // Delete
                if (state.cursor < state.input.length) {
                    state.input = state.input.substring(0, state.cursor) + state.input.substring(state.cursor + 1);
                }
                redrawFooter(); return;
            }
            if (num === 5) { // PageUp
                state.scrollOffset = (state.scrollOffset || 0) + Math.floor((state._bodyRows || 20) / 2);
                redraw(); return;
            }
            if (num === 6) { // PageDown
                state.scrollOffset = Math.max(0, (state.scrollOffset || 0) - Math.floor((state._bodyRows || 20) / 2));
                redraw(); return;
            }
            return;
        }

        // CSI u 序列: \x1b[N;Mu
        if (term === 'u') {
            var uParts = body.split(';');
            var keyCode = parseInt(uParts[0], 10);
            var modifier = parseInt(uParts[1], 10) || 1;
            if (keyCode === 13 && (modifier === 2 || modifier === 5)) {
                // Shift+Enter → 插入换行
                state.input = state.input.substring(0, state.cursor) + '\n' + state.input.substring(state.cursor);
                state.cursor++;
                redrawFooter(); return;
            }
            // Ctrl+↑ (keyCode=1, modifier=5) → 向上滚动 3 行
            if (keyCode === 65 && modifier === 5) {
                state.scrollOffset = (state.scrollOffset || 0) + 3;
                redraw(); return;
            }
            // Ctrl+↓ (keyCode=1, modifier=5)
            if (keyCode === 66 && modifier === 5) {
                state.scrollOffset = Math.max(0, (state.scrollOffset || 0) - 3);
                redraw(); return;
            }
            // Ctrl+Shift+C (keyCode=67, modifier=6) → 复制选中文本/代码块到剪贴板
            if (keyCode === 67 && modifier === 6) {
                copySelectedToClipboard();
                return;
            }
            return;
        }

        // 单字符 CSI: \x1b[X (X = A/B/C/D/H/F)
        if (term === 'A') { // ↑
            if (state.menu && state.menu.items.length > 0) {
                state.menu.selected = (state.menu.selected - 1 + state.menu.items.length) % state.menu.items.length;
                redrawFooter();
            } else {
                if (state.history.length > 0) {
                    if (state.historyIdx < state.history.length - 1) {
                        if (state.historyIdx === -1) state._savedInput = state.input;
                        state.historyIdx++;
                        state.input = state.history[state.historyIdx];
                        state.cursor = state.input.length;
                    }
                    redrawFooter();
                }
            }
            return;
        }
        if (term === 'B') { // ↓
            if (state.menu && state.menu.items.length > 0) {
                state.menu.selected = (state.menu.selected + 1) % state.menu.items.length;
                redrawFooter();
            } else {
                if (state.historyIdx > 0) {
                    state.historyIdx--;
                    state.input = state.history[state.historyIdx];
                    state.cursor = state.input.length;
                } else if (state.historyIdx === 0) {
                    state.historyIdx = -1;
                    state.input = state._savedInput || '';
                    state.cursor = state.input.length;
                }
                redrawFooter();
            }
            return;
        }
        if (term === 'C') { // →
            if (state.cursor < state.input.length) state.cursor++;
            redrawFooter(); return;
        }
        if (term === 'D') { // ←
            if (state.cursor > 0) state.cursor--;
            redrawFooter(); return;
        }
        if (term === 'H') { // Home
            state.cursor = 0;
            redrawFooter(); return;
        }
        if (term === 'F') { // End
            state.cursor = state.input.length;
            redrawFooter(); return;
        }
        // 未知 CSI 序列，如有菜单则关闭
        if (state.menu) { state.menu = null; redrawFooter(); }
    }

    // ── 单字符处理 ──
    // 处理从缓冲区提取的单个字符（普通字符或控制字符）
    function handleChar(ch) {
        var code = ch.charCodeAt(0);

        // Enter: 发送消息（\ + Enter 插入换行）
        if (ch === '\r' || ch === '\n') {
            // AtomCode 兜底：\ + Enter → 插入换行（光标前一个字符是 \ 且在行尾/末尾）
            var cursorAtEnd = state.cursor === state.input.length;
            var prevIsBackslash = state.cursor > 0 && state.input[state.cursor - 1] === '\\';
            if (prevIsBackslash && cursorAtEnd) {
                state.input = state.input.substring(0, state.cursor - 1) + '\n' + state.input.substring(state.cursor);
                state.cursor++;
                redrawFooter(); return;
            }
            handleInput();
            return;
        }
        // Backspace
        if (ch === '\x7f' || ch === '\b') {
            if (state.cursor > 0) {
                state.cursor--;
                if (state.cursor < state.input.length) {
                    state.input = state.input.substring(0, state.cursor) + state.input.substring(state.cursor + 1);
                } else {
                    state.input = state.input.substring(0, state.cursor);
                }
            }
            state.isPasted = false;
            updateMenu();
            redrawFooter(); return;
        }
        // Ctrl+C
        if (ch === '\x03') {
            if (state.abortController) {
                try { state.abortController.abort(); } catch(e) {}
                state.abortController = null;
                echoSystem(C.yellow + '╰─ 已取消' + C.reset);
                setStatus(state.status.model, '/help 查看命令', '');
                return;
            }
            if (state.input) {
                state.input = '';
                state.cursor = 0;
                state.menu = null;
                state._exitWarned = false;
                setStatus(state.status.model, '/help 查看命令', '');
                redrawFooter(); return;
            }
            // 空输入：第1次提示再按退出，第2次退出
            if (state._exitWarned) {
                cleanupExit('再见！');
                return;
            }
            state._exitWarned = true;
            setStatus(state.status.model, '再按 Ctrl+C 退出', '');
            redrawFooter(); return;
        }
        // Ctrl+D
        if (ch === '\x04') {
            if (!state.input) { cleanupExit('再见！'); return; }
            return;
        }
        // Ctrl+A
        if (ch === '\x01') { state.cursor = 0; redrawFooter(); return; }
        // Ctrl+E
        if (ch === '\x05') { state.cursor = state.input.length; redrawFooter(); return; }
        // Ctrl+W
        if (ch === '\x17') {
            if (state.cursor > 0) {
                var start = state.cursor - 1;
                while (start > 0 && state.input[start - 1] === ' ') start--;
                while (start > 0 && state.input[start - 1] !== ' ') start--;
                state.input = state.input.substring(0, start) + state.input.substring(state.cursor);
                state.cursor = start;
            }
            redrawFooter(); return;
        }
        // Ctrl+U
        if (ch === '\x15') {
            state.input = '';
            state.cursor = 0;
            state.menu = null;
            redrawFooter(); return;
        }
        // Ctrl+K
        if (ch === '\x0b') {
            state.input = state.input.substring(0, state.cursor);
            redrawFooter(); return;
        }
        // Ctrl+L: 清屏/新建对话
        if (ch === '\x0c') {
            handleCommand('/clear');
            return;
        }
        // Ctrl+V: 检查剪贴板图片（仅通过 API 读剪贴板）
        if (ch === '\x16') {
            // 通过 electronAPI 检查剪贴板是否有图片
            if (window.electronAPI && window.electronAPI.clipboardHasImage) {
                window.electronAPI.clipboardHasImage().then(function(hasImage) {
                    if (hasImage) {
                        handleCommand('/paste');
                    } else {
                        // 无图片时正常插入字符
                        state.input = state.input.substring(0, state.cursor) + ch + state.input.substring(state.cursor);
                        state.cursor++;
                        redrawFooter();
                    }
                });
                return;
            }
            // 不支持检测时直接插入
            state.input = state.input.substring(0, state.cursor) + ch + state.input.substring(state.cursor);
            state.cursor++;
            redrawFooter();
            return;
        }
        // Tab
        if (ch === '\t') {
            if (state.menu && state.menu.items.length > 0) {
                var sel = state.menu.items[state.menu.selected];
                if (state._inModelMenu) {
                    state.modelId = sel.name;
                    state._currentModelName = sel.name;
                    state.hasHistory = false;
                    state.sessionId = 'cli-repl-' + Date.now() + '-' + Math.random().toString(36).substring(2, 8);
                    state.input = '';
                    state.cursor = 0;
                    state.menu = null;
                    state._inModelMenu = false;
                    echoSystem('模型切换为: ' + C.bold + sel.name + C.reset);
                    setStatus(state.modelId, '/help 查看命令', '');
                    redraw();
                } else {
                    state.input = sel.name + ' ';
                    state.cursor = state.input.length;
                    state.menu = null;
                    redrawFooter();
                }
                return;
            }
            return;
        }
        // 可打印字符
        if (code >= 32) {
            if (state.scrollOffset > 0) state.scrollOffset = 0;
            state.input = state.input.substring(0, state.cursor) + ch + state.input.substring(state.cursor);
            state.cursor++;
            state.isPasted = false;
            updateMenu();
            redrawFooter();
        }
    }

    // ── Esc 处理（清输入/取消/撤销） ──
    function handleEscPress() {
        // 有菜单时先关菜单
        if (state.menu) { state.menu = null; redrawFooter(); return; }
        // 有 input 时清空
        if (state.input) { state.input = ''; state.cursor = 0; state.menu = null; state._escWarned = false; redrawFooter(); return; }
        // 有生成进行中时取消
        if (state.abortController) { try { state.abortController.abort(); } catch(e) {} state.abortController = null; echoSystem(C.yellow + '╰─ 已取消' + C.reset); setStatus(state.status.model, '/help 查看命令', ''); return; }
        // 双击 Esc → 撤销
        var now = Date.now();
        if (now - state._lastEscTime < 1000) {
            state._lastEscTime = 0;
            state._escWarned = false;
            handleCommand('/undo');
            return;
        }
        state._lastEscTime = now;
        if (!state._escWarned) {
            state._escWarned = true;
            setStatus(state.status.model, '再按 Esc 撤销', '');
        }
        redrawFooter();
    }

    // ── 命令处理 ──
    async function handleInput() {
        // 防止并发请求（上一条还未完成时按 Enter）
        if (state.spinning) {
            echoSystem(C.yellow + '⏳ 正在处理上一条消息...' + C.reset);
            return;
        }
        var text = state.input.trim();

        // ── 模型选择模式：按 Enter 选中当前菜单项 ──
        if (state._modelSelectionPending && text === '') {
            // 用户按 Enter 选择模型（输入框为空时）
            if (state.menu && state.menu.items.length > 0) {
                var selModel = state.menu.items[state.menu.selected];
                state.modelId = selModel.name;
                state._currentModelName = selModel.name;
                state.hasHistory = false;
                state.sessionId = 'cli-repl-' + Date.now() + '-' + Math.random().toString(36).substring(2, 8);
                state.menu = null;
                state._modelSelectionPending = false;
                echoSystem('模型切换为: ' + C.bold + selModel.name + C.reset);
                setStatus(state.modelId, '/help 查看命令', '');
                redraw();
                return;
            }
            state._modelSelectionPending = false;
        }
        // Enter 时如果菜单显示的是模型列表，视为选中当前模型
        if (state._inModelMenu && state.menu && state.menu.items.length > 0 && text === '/model') {
            var selModel2 = state.menu.items[state.menu.selected];
            state.modelId = selModel2.name;
            state._currentModelName = selModel2.name;
            state.hasHistory = false;
            state.sessionId = 'cli-repl-' + Date.now() + '-' + Math.random().toString(36).substring(2, 8);
            state.input = '';
            state.cursor = 0;
            state.menu = null;
            state._inModelMenu = false;
            echoSystem('模型切换为: ' + C.bold + selModel2.name + C.reset);
            setStatus(state.modelId, '/help 查看命令', '');
            redraw();
            return;
        }
        state.input = '';
        state.menu = null;
        state.historyIdx = -1;
        if (text && state.history[0] !== text) {
            state.history.unshift(text);
            if (state.history.length > 50) state.history.pop();
        }
        if (!text) { redraw(); return; }

        // ── 折叠前一个 /help 输出（AtomCode 风格的输出折叠） ──
        while (state.foldBlocks.length > 0) {
            var fb = state.foldBlocks.pop();
            if (fb.start < state.body.length) {
                var endIdx = Math.min(fb.start + fb.count, state.body.length);
                var kept = endIdx - fb.start;
                if (kept > 1) {
                    state.body.splice(fb.start, kept, C.gray + C.dim + '  [已折叠 ' + fb.label + ']' + C.reset);
                }
            }
        }

        // ── 撤销快照（/undo） ──
        if (text.indexOf('/') !== 0) {
            state.undoStack.push({
                body: state.body.slice(),
                goal: state.goal ? JSON.parse(JSON.stringify(state.goal)) : null,
                turn: state.turn
            });
            if (state.undoStack.length > 20) state.undoStack.shift();
        }

        // 显示用户消息
        echoUser(text);
        // 用户主动发送消息时跳回最新
        state.scrollOffset = 0;
        // 计数会话轮次
        state._exchangeCount++;

        if (text.indexOf('/') === 0) { handleCommand(text); return; }

        // ── 构建 systemPrompt（instruction）─ 每次发送都带，确保 AI 始终有指令上下文 ──
        if (promptBuilder && !state._cachedInstruction) {
            try {
                var instr = promptBuilder.buildInstructionText({
                    sessionId: state.sessionId,
                    modelId: state.modelId || 'deepseek',
                    rootDir: process.cwd(),
                    mode: 'build',
                    useJson: false
                });
                state._cachedInstruction = instr.text;
            } catch(e) { console.error('buildInstruction failed:', e.message); }
        }

        // ── 启动旋转动画 ──
        // AtomCode append-only 模型：spinner 永远是最后一行，通过 pushBodyRow 追加
        var THINKING_LABELS = ['Pondering','Noodling','Percolating','Brewing','Cogitating',
                               'Churning','Hatching','Marinating','Simmering','Tinkering',
                               'Mulling','Musing','Ruminating','Puttering','Fermenting',
                               'Divining','Concocting','Germinating','Whittling','Scheming'];
        var spinFrames = ['|','/','-','\\'];
        var startTime = Date.now();
        state.spinning = true;
        state.spinStart = startTime;
        state.spinLabelIdx = (state.spinLabelIdx + 1) % THINKING_LABELS.length;
        var label = THINKING_LABELS[state.spinLabelIdx % THINKING_LABELS.length];
        var spinBodyRow = C.magenta + spinFrames[0] + C.reset + ' ' + C.bold + label + '…' + C.reset;
        // AtomCode: spinner 首次通过 pushBodyRow 追加（会自动 emit 到终端）
        pushOrUpdateSpinner(spinBodyRow);
        redraw(); // 初始画完后要显示 footer
        var spinFrameIdx = 0;
        state.spinTimer = setInterval(function() {
            if (!state.spinning) return;
            var elapsed = Math.floor((Date.now() - startTime) / 1000);
            var elapsedStr = elapsed < 60 ? elapsed + 's' : Math.floor(elapsed / 60) + 'm' + (elapsed % 60) + 's';
            spinFrameIdx = (spinFrameIdx + 1) % spinFrames.length;
            var frame = spinFrames[spinFrameIdx];
            var currentLabel = THINKING_LABELS[(state.spinLabelIdx + Math.floor(elapsed / 2)) % THINKING_LABELS.length];
            var newRow = C.magenta + frame + C.reset + ' ' + C.bold + currentLabel + '…' + C.reset + C.gray + ' (' + elapsedStr + ')' + C.reset;
            // AtomCode: push_or_update_live_spinner — 原地更新最后一行，无 LF 无滚动
            pushOrUpdateSpinner(newRow);
        }, 120);

        var payload = {
            agentId: state.sessionId,
            token: token,
            message: { text: text },
            deepThink: state.deepThink,
            forceNew: !state.hasHistory,
            timeout: state.timeout,
            goal: state._nextGoal || null,
            systemPrompt: state._cachedInstruction || null
        };
        state._nextGoal = null;
        if (state.modelId) {
            payload.clusterConfig = {
                templateId: 'minimal',
                roles: { main: { modelId: state.modelId } },
                subagentDefaults: { modelId: state.modelId }
            };
        }
        try {
            var ac = new AbortController();
            state.abortController = ac;

            // ── 流式请求：实时接收工具调用/text 推送 ──
            var collectedToolCalls = [];
            var collectedToolMsgCount = 0;
            var collectedTextLines = [];
            var toolColorsCache = null;

            // 刷新缓冲的纯文字（工具调用前的 AI 话语）
            function flushCollectedText() {
                if (collectedTextLines.length === 0) return;
                var maxTW = Math.max(20, (state.cols || 80) - 4);
                clearSpinner();
                for (var tli = 0; tli < collectedTextLines.length; tli++) {
                    var lines = (collectedTextLines[tli] || '').split('\n');
                    for (var lni = 0; lni < lines.length; lni++) {
                        if (!lines[lni]) { pushBodyRow(''); continue; }
                        var wrapped = visualWrap(lines[lni], maxTW);
                        if (wrapped.length === 0) wrapped = [''];
                        for (var wi = 0; wi < wrapped.length; wi++) {
                            var mdR = renderMdLine(wrapped[wi]);
                            pushBodyRow(mdR.line || wrapped[wi]);
                        }
                    }
                }
                collectedTextLines = [];
                var el = Math.floor((Date.now() - startTime) / 1000);
                var es = el < 60 ? el + 's' : Math.floor(el / 60) + 'm' + (el % 60) + 's';
                var f = spinFrames[(spinFrameIdx + 1) % spinFrames.length];
                var cl = THINKING_LABELS[(state.spinLabelIdx + Math.floor(el / 2)) % THINKING_LABELS.length];
                pushOrUpdateSpinner(C.magenta + f + C.reset + ' ' + C.bold + cl + '…' + C.reset + C.gray + ' (' + es + ')' + C.reset);
                redraw();
            }

            function getToolColors() {
                if (!toolColorsCache) toolColorsCache = require('../tools/tool-colors.js');
                var Cc = C;
                return {
                    colorForTool: function(name) {
                        var nl = (name || '').toLowerCase();
                        if (toolColorsCache[nl] && Cc[toolColorsCache[nl].ansi]) return Cc[toolColorsCache[nl].ansi];
                        var key = nl.replace(/[-_]/g, '');
                        for (var k in toolColorsCache) { if (k.replace(/[-_]/g, '') === key && Cc[toolColorsCache[k].ansi]) return Cc[toolColorsCache[k].ansi]; }
                        return Cc.cyan;
                    },
                    renderToolCall: function(name, params) {
                        var color = this.colorForTool(name);
                        var s = color + '▸ ' + Cc.reset + Cc.bold + color + name + Cc.reset;
                        if (params) {
                            var pk = Object.keys(params);
                            if (pk.length > 0) {
                                var v = params[pk[0]];
                                var vs = typeof v === 'string' ? v.substring(0, 50) : JSON.stringify(v);
                                s += Cc.gray + '(' + Cc.reset + Cc.yellow + pk[0] + Cc.reset + Cc.gray + ': ' + Cc.reset + Cc.green + vs + Cc.reset + Cc.gray + ')' + Cc.reset;
                            }
                        }
                        return s;
                    }
                };
            }

            var hasStreamedToolCall = false;
            function onStreamLine(msg) {
                // B-2: 并行工具分组 — 检测 batchId
                var batchId = msg.batchId || (msg.meta && msg.meta.batchId);
                if (msg.type === 'tool-call') {
                    if (!hasStreamedToolCall) {
                        hasStreamedToolCall = true;
                        // 刷新之前缓冲的纯文字内容（先于工具调用显示）
                        if (collectedTextLines.length > 0) {
                            flushCollectedText();
                        }
                    }
                    // B-1/B-2: 工具调用动画 + 并行分组
                    var rawName = msg.name || msg.content || 'tool';
                    var argsJson = msg.content || '';
                    var dispName = displayToolNameShort(rawName);
                    var detail = formatToolDetail(rawName, argsJson);
                    var color = C.green;
                    var isBatchChild = batchId && state._currentBatchId === batchId;
                    if (batchId) state._currentBatchId = batchId;
                    // B-2: 如果是同批次的后续工具，缩进显示为子行
                    if (isBatchChild) {
                        // 子工具行：不更新当前批次 ID，直接推子行
                        var childLine = C.magenta + '  ↻ ' + C.reset + C.bold + color + dispName + C.reset + C.gray + ' ' + detail + C.reset;
                        clearSpinner();
                        pushBodyRow(childLine);
                        if (!state._toolCallRows) state._toolCallRows = [];
                        state._toolCallRows.push({ idx: state.body.length - 1, name: dispName, batchId: batchId });
                        var elapsedB = Math.floor((Date.now() - startTime) / 1000);
                        var elapsedStrB = elapsedB < 60 ? elapsedB + 's' : Math.floor(elapsedB / 60) + 'm' + (elapsedB % 60) + 's';
                        var frameB = spinFrames[(spinFrameIdx + 1) % spinFrames.length];
                        var labelB = THINKING_LABELS[(state.spinLabelIdx + Math.floor(elapsedB / 2)) % THINKING_LABELS.length];
                        pushOrUpdateSpinner(C.magenta + frameB + C.reset + ' ' + C.bold + labelB + '…' + C.reset + C.gray + ' (' + elapsedStrB + ')' + C.reset);
                        redraw();
                    } else {
                        // 新批次或单工具：正常渲染
                        if (batchId) state._batchHeaderPushed = true;
                        // 动画图标：↻ 标识进行中
                        var animIcon = '↻';
                        var toolLine = C.magenta + animIcon + ' ' + C.reset + C.bold + color + dispName + C.reset + C.gray + ' ' + detail + C.reset;
                        // 清除当前 spinner，在它的位置推工具行，然后重推 spinner
                        clearSpinner(); // pop from body_lines + erase terminal row
                        pushBodyRow(toolLine);
                        // 记录工具行索引供后续更新为 ✓
                        var toolRowIdx = state.body.length - 1;
                        if (!state._toolCallRows) state._toolCallRows = [];
                        state._toolCallRows.push({ idx: toolRowIdx, name: dispName });
                        // 重推 spinner（最后一个 pending row）
                        var elapsed = Math.floor((Date.now() - startTime) / 1000);
                        var elapsedStr = elapsed < 60 ? elapsed + 's' : Math.floor(elapsed / 60) + 'm' + (elapsed % 60) + 's';
                        var frame = spinFrames[(spinFrameIdx + 1) % spinFrames.length];
                        var currentLabel = THINKING_LABELS[(state.spinLabelIdx + Math.floor(elapsed / 2)) % THINKING_LABELS.length];
                        var newSpinRow = C.magenta + frame + C.reset + ' ' + C.bold + currentLabel + '…' + C.reset + C.gray + ' (' + elapsedStr + ')' + C.reset;
                        pushOrUpdateSpinner(newSpinRow);
                        redraw();
                    }
                } else if (msg.type === 'tool-result') {
                    collectedToolMsgCount++;
                    // B-1: 更新对应的工具调用行为 ✓（如果有追踪）
                    if (state._toolCallRows && state._toolCallRows.length > 0) {
                        var lastTool = state._toolCallRows.pop();
                        var success = msg.success !== false;
                        var resultColor = success ? C.green : C.red;
                        var resultIcon = success ? '✓' : '✗';
                        state.body[lastTool.idx] = resultColor + resultIcon + ' ' + C.reset + C.bold + resultColor + lastTool.name + C.reset;
                        // 重绘该行
                        redraw();
                    }
                    // C-1: 工具结果摘要行
                    var success = msg.success !== false;
                    var summary = msg.summary || '';
                    if (!summary && msg.content) summary = msg.content.substring(0, 80);
                    if (summary) {
                        clearSpinner();
                        var resultColor = success ? C.green : C.red;
                        var resultIcon = success ? '✓' : '✗';
                        pushBodyRow('  ' + resultColor + resultIcon + C.reset + C.gray + ' ' + resultColor + summary + C.reset);
                        // 重推 spinner
                        var elapsedR = Math.floor((Date.now() - startTime) / 1000);
                        var elapsedStrR = elapsedR < 60 ? elapsedR + 's' : Math.floor(elapsedR / 60) + 'm' + (elapsedR % 60) + 's';
                        var frameR = spinFrames[(spinFrameIdx + 1) % spinFrames.length];
                        var labelR = THINKING_LABELS[(state.spinLabelIdx + Math.floor(elapsedR / 2)) % THINKING_LABELS.length];
                        pushOrUpdateSpinner(C.magenta + frameR + C.reset + ' ' + C.bold + labelR + '…' + C.reset + C.gray + ' (' + elapsedStrR + ')' + C.reset);
                        redraw();
                    }
                } else if (msg.type === 'think') {
                    // D-2: 流式推理显示（灰色/斜体）
                    if (!state._inThinkBlock) {
                        state._inThinkBlock = true;
                        clearSpinner();
                        pushBodyRow(C.magenta + C.bold + '🧠 Thinking...' + C.reset);
                        var elapsedT = Math.floor((Date.now() - startTime) / 1000);
                        var elapsedStrT = elapsedT < 60 ? elapsedT + 's' : Math.floor(elapsedT / 60) + 'm' + (elapsedT % 60) + 's';
                        var frameT = spinFrames[(spinFrameIdx + 1) % spinFrames.length];
                        pushOrUpdateSpinner(C.magenta + frameT + C.reset + ' ' + C.bold + 'Thinking...' + C.reset + C.gray + ' (' + elapsedStrT + ')' + C.reset);
                        redraw();
                    }
                    var thinkText = msg.content || '';
                    if (thinkText) {
                        var thinkLines = thinkText.split('\n');
                        var maxTW = Math.max(20, (state.cols || 80) - 4);
                        clearSpinner();
                        for (var tli = 0; tli < thinkLines.length; tli++) {
                            if (!thinkLines[tli]) { pushBodyRow(''); continue; }
                            var wrapped = visualWrap(thinkLines[tli], maxTW);
                            if (wrapped.length === 0) wrapped = [''];
                            for (var wi = 0; wi < wrapped.length; wi++) {
                                pushBodyRow(C.dim + C.gray + wrapped[wi] + C.reset);
                            }
                        }
                        var elapsedT2 = Math.floor((Date.now() - startTime) / 1000);
                        var elapsedStrT2 = elapsedT2 < 60 ? elapsedT2 + 's' : Math.floor(elapsedT2 / 60) + 'm' + (elapsedT2 % 60) + 's';
                        var frameT2 = spinFrames[(spinFrameIdx + 1) % spinFrames.length];
                        pushOrUpdateSpinner(C.magenta + frameT2 + C.reset + ' ' + C.bold + 'Thinking...' + C.reset + C.gray + ' (' + elapsedStrT2 + ')' + C.reset);
                        redraw();
                    }
                } else if (msg.type === 'text') {
                    // A-3: think 块结束时添加分隔
                    if (state._inThinkBlock) {
                        state._inThinkBlock = false;
                        pushBodyRow(C.gray + C.dim + '─── /think ───' + C.reset);
                    }
                    if (hasStreamedToolCall) {
                        // 工具调用间文本：清 spinner → 推文本行 → 重推 spinner
                        var textLines = (msg.content || '').split('\n');
                        var maxTW = Math.max(20, (state.cols || 80) - 4);
                        clearSpinner();
                        for (var tli = 0; tli < textLines.length; tli++) {
                            if (!textLines[tli]) {
                                pushBodyRow('');
                                continue;
                            }
                            var wrapped = visualWrap(textLines[tli], maxTW);
                            if (wrapped.length === 0) wrapped = [''];
                            for (var wi = 0; wi < wrapped.length; wi++) {
                                var mdR = renderMdLine(wrapped[wi]);
                                var lineContent = mdR.line || wrapped[wi];
                                pushBodyRow(lineContent);
                            }
                        }
                        // 重推 spinner
                        var elapsed2 = Math.floor((Date.now() - startTime) / 1000);
                        var elapsedStr2 = elapsed2 < 60 ? elapsed2 + 's' : Math.floor(elapsed2 / 60) + 'm' + (elapsed2 % 60) + 's';
                        var frame2 = spinFrames[(spinFrameIdx + 1) % spinFrames.length];
                        var currentLabel2 = THINKING_LABELS[(state.spinLabelIdx + Math.floor(elapsed2 / 2)) % THINKING_LABELS.length];
                        var newSpinRow2 = C.magenta + frame2 + C.reset + ' ' + C.bold + currentLabel2 + '…' + C.reset + C.gray + ' (' + elapsedStr2 + ')' + C.reset;
                        pushOrUpdateSpinner(newSpinRow2);
                        redraw();
                    } else {
                        // 纯文字回复：暂存，等 stream 结束后才显示（不打断 spinner）
                        collectedTextLines.push(msg.content || '');
                    }
                }
            }

            var streamStatus = await httpPostStream('/api/request', payload, onStreamLine, ac.signal);
            state.abortController = null;

            // ── 关闭 spinner ──
            state.spinning = false;
            if (state.spinTimer) {
                clearInterval(state.spinTimer);
                state.spinTimer = null;
            }
            // AtomCode: 清 spinner 行
            clearSpinner();

            var elapsed = Math.floor((Date.now() - startTime) / 1000);
            var elapsedStr = '';
            if (elapsed < 60) elapsedStr = elapsed + 's';
            else elapsedStr = Math.floor(elapsed / 60) + 'm' + (elapsed % 60) + 's';
            state.turn++;

            if (streamStatus === 200) {
                if (!hasStreamedToolCall && collectedTextLines.length > 0) {
                    // 纯文字回复：stream 未实时推送，现在显示
                    for (var mi = 0; mi < collectedTextLines.length; mi++) {
                        echoAssistant(collectedTextLines[mi]);
                    }
                }
                // 有工具调用时：工具行和中间文本已在 stream 期间实时推入，不需额外处理
                state.hasHistory = true;
                setStatus(state.status.model, '/help 查看命令', '');
                // D-1: Turn 分隔线
                var sep = C.gray + C.dim + '─── turn #' + state.turn + ' ───' + C.reset;
                pushBodyRow(sep);
                saveSession(state);
            } else {
                echoError(C.red + '╰─ 错误: ' + C.reset + 'HTTP ' + streamStatus);
                setStatus(state.status.model, '出错了', '');
            }
        } catch(e) {
            state.spinning = false;
            clearInterval(state.spinTimer);
            state.spinTimer = null;
            clearSpinner();
            if (e.message === 'aborted') {
                // Ctrl+C 取消，已显示"已取消"
            } else {
                echoError(C.red + '╰─ 错误: ' + C.reset + e.message);
                setStatus(state.status.model, '出错了', '');
            }
        }
        redraw();
    }

    async function handleCommand(cmd) {
        var parts = cmd.split(/\s+/);
        var name = parts[0];
        var arg = parts.slice(1).join(' ');

        if (name === '/quit' || name === '/exit') {
            state.running = false;
            process.stdout.write(C.SHOW);
            if (stdin.setRawMode) stdin.setRawMode(false);
            stdin.pause();
            console.log('\n再见！');
            process.exit(0);
        } else if (name === '/help') {
            // 注册可折叠块
            var foldIdx = state.body.length;
            echoSystem(C.cyan + '── 命令 ──' + C.reset);
            echoSystem('  /quit                   退出');
            echoSystem('  /help                   本帮助');
            echoSystem('  /clear                  新建对话');
            echoSystem('  /model <id>             切换模型');
            echoSystem('  /deepthink              切换深度思考');
            echoSystem('  /plan                   Plan 模式');
            echoSystem('  /build                  Build 模式');
            echoSystem('  /raw                    切换原始输出');
            echoSystem('  /timeout <ms>           设置超时');
            echoSystem('  /token                  查看 token');
            echoSystem('  /ctx                    查看上下文');
            echoSystem('  /cd <dir>               切换工作目录');
            echoSystem('  /cost                   查看 token 用量');
            echoSystem('  /diff                   查看 git diff');
            echoSystem('  /compact                压缩对话历史');
            echoSystem('  /copy [N/all]           复制代码块');
            echoSystem('  /view <path>            预览文件');
            echoSystem('  /status                 会话状态');
            echoSystem('  /mcp                    MCP 状态');
            echoSystem('  /rename <name>          重命名会话');
            echoSystem('  /skills                 浏览技能');
            echoSystem('  /language               切换语言');
            echoSystem('  /bg <prompt>            后台任务');
            echoSystem('  /bg list                列出后台任务');
            echoSystem('  /bg drop <N>            删除后台任务');
            echoSystem('  /goal <条件>            设置自动目标');
            echoSystem('  /goal status            查看目标状态');
            echoSystem('  /goal clear             清除目标');
            echoSystem('  /undo                   撤销上一轮');
            echoSystem('  /keys                   键盘快捷键');
            echoSystem(C.cyan + '──' + C.reset);
            state.foldBlocks.push({ start: foldIdx, count: 32, label: '命令帮助' });
        } else if (name === '/clear') {
            state.sessionId = 'cli-repl-' + Date.now() + '-' + Math.random().toString(36).substring(2, 8);
            state.hasHistory = false;
            state.goal = null;
            state.turn = 0;
            deleteSession();
            clearAll();
            echoSystem('已新建对话');
        } else if (name === '/raw') {
            state.rawOutput = !state.rawOutput;
            echoSystem('原始输出: ' + (state.rawOutput ? '开' : '关'));
        } else if (name === '/deepthink') {
            state.deepThink = !state.deepThink;
            echoSystem('深度思考: ' + (state.deepThink ? '开' : '关'));
        } else if (name === '/token') {
            echoSystem('Token: ' + token);
        } else if (name === '/ctx') {
            echoSystem('上下文: ' + (state.hasHistory ? '有' : '新建'));
        } else if (name === '/model') {
            if (!arg) {
                // 无参数：激活模型选择模式（AtomCode 风格）
                // 设置菜单，然后等待用户按 Enter 选择
                var current = state.modelId || 'deepseek.fast';
                var items = [];
                for (var mi = 0; mi < MODEL_ITEMS.length; mi++) {
                    var m = MODEL_ITEMS[mi];
                    var mark = (m.name === current) ? ' ✓' : '';
                    items.push({ name: m.name, desc: m.desc + mark });
                }
                state.menu = { items: items, selected: 0 };
                state._modelSelectionPending = true;
                state._inModelMenu = true;
                // 清空输入——用户按 Enter 选择模型
                state.input = '';
                state.cursor = 0;
                // 显示菜单提示
                echoSystem(C.cyan + '请选择模型（↑/↓ 切换，Enter 确认）：' + C.reset);
                redraw();
            } else {
                state.modelId = arg;
                state._currentModelName = arg;
                state.hasHistory = false;
                state.sessionId = 'cli-repl-' + Date.now() + '-' + Math.random().toString(36).substring(2, 8);
                echoSystem('模型切换为: ' + C.bold + arg + C.reset);
                setStatus(state.modelId, '/help 查看命令', '');
            }
        } else if (name === '/timeout') {
            var t = parseInt(arg, 10);
            if (t > 0) { state.timeout = t; echoSystem('超时: ' + t + 'ms'); }
            else { echoError('无效超时值'); }
        } else if (name === '/undo') {
            if (state.undoStack.length > 0) {
                var snap = state.undoStack.pop();
                state.body = snap.body;
                state.goal = snap.goal;
                state.turn = snap.turn;
                redraw();
                echoSystem('已撤销上一轮');
            } else {
                echoSystem('没有可撤销的操作');
            }
        } else if (name === '/theme') {
            // 主题切换命令
            if (!arg) {
                echoSystem('当前主题: ' + C.cyan + activeTheme + C.reset + ' (' + (THEMES[activeTheme] ? THEMES[activeTheme].name : '') + ')');
                echoSystem('可用主题: ' + Object.keys(THEMES).join(', '));
            } else if (arg === 'list') {
                var list = '';
                for (var tk in THEMES) {
                    var mark = tk === activeTheme ? ' ✓' : '';
                    list += '  ' + tk + mark + ' — ' + THEMES[tk].name + '\n';
                }
                echoSystem('可用主题:\n' + list.trim());
            } else if (setTheme(arg)) {
                state._activeTheme = activeTheme;
                echoSystem('主题已切换为: ' + C.cyan + activeTheme + C.reset + ' (' + THEMES[activeTheme].name + ')');
                redraw();
                saveSession(state);
            } else {
                echoError('未知主题: ' + arg + '（可用: ' + Object.keys(THEMES).join(', ') + '）');
            }
        } else if (name === '/find') {
            // body 文本搜索
            if (!arg) { echoError('请指定搜索文本: /find <text>'); }
            else {
                var matches = [];
                for (var fi = 0; fi < state.body.length; fi++) {
                    var bl = state.body[fi];
                    if (typeof bl === 'string' && bl.toLowerCase().indexOf(arg.toLowerCase()) >= 0) {
                        matches.push({ idx: fi, line: bl });
                    }
                }
                if (matches.length === 0) {
                    echoSystem('在 ' + state.body.length + ' 行中未找到: ' + arg);
                } else {
                    echoSystem('在 ' + state.body.length + ' 行中找到 ' + matches.length + ' 处匹配:');
                    for (var mi = 0; mi < Math.min(matches.length, 20); mi++) {
                        var ml = matches[mi];
                        var display = stripAnsi(ml.line).substring(0, 80);
                        echoSystem(C.yellow + '#' + (ml.idx + 1) + C.reset + ' ' + display);
                    }
                    if (matches.length > 20) echoSystem('... (还有 ' + (matches.length - 20) + ' 行)');
                }
            }
        } else if (name === '/keys') {
            var foldIdx = state.body.length;
            echoSystem(C.cyan + '── 快捷键 ──' + C.reset);
            echoSystem('  Enter           发送消息');
            echoSystem('  Shift/Ctrl+Enter 换行');
            echoSystem('  ↑/↓             历史/菜单导航');
            echoSystem('  ←/→             光标移动');
            echoSystem('  Home/End         行首/行尾');
            echoSystem('  Ctrl+A/E         行首/行尾');
            echoSystem('  Ctrl+W           删除前一词');
            echoSystem('  Ctrl+U           清空输入行');
            echoSystem('  Ctrl+K           删除到行尾');
            echoSystem('  Ctrl+C           取消/清空/退出');
            echoSystem('  Ctrl+Shift+C     复制选中文本');
            echoSystem('  Tab              命令补全');
            echoSystem('  Esc              关闭菜单');
            echoSystem(C.cyan + '──' + C.reset);
            state.foldBlocks.push({ start: foldIdx, count: 15, label: '快捷键' });
        } else if (name === '/cost') {
            // 统计 token 用量（从 goal 行汇总）
            var totalTok = 0;
            var roundCount = state.turn;
            for (var bi = 0; bi < state.body.length; bi++) {
                var bl = state.body[bi];
                if (typeof bl === 'string' && bl.indexOf('tok') > 0) {
                    var tm = bl.match(/([\d.]+[kKmM]?)\s*tok/);
                    if (tm) {
                        var v = tm[1];
                        if (v.indexOf('k') > 0) totalTok += parseFloat(v) * 1000;
                        else if (v.indexOf('m') > 0) totalTok += parseFloat(v) * 1000000;
                        else totalTok += parseFloat(v);
                    }
                }
            }
            var tokStr = totalTok > 1000000 ? (totalTok / 1000000).toFixed(1) + 'M' :
                totalTok > 1000 ? (totalTok / 1000).toFixed(1) + 'k' : String(totalTok);
            echoSystem('Token 用量: ' + tokStr + ' tok / ' + roundCount + ' rounds');
        } else if (name === '/diff') {
            // 调用 git diff
            try {
                var diffRes = await window.electronAPI.agentExec('git diff', 30000);
                if (diffRes && diffRes.success !== false) {
                    var diffOut = diffRes.stdout || diffRes.data || '';
                    if (!diffOut || diffOut.trim() === '') {
                        echoSystem('(工作区干净，无未暂存的修改)');
                    } else {
                        var lines = diffOut.split('\n');
                        for (var di = 0; di < Math.min(lines.length, 80); di++) {
                            var dl = lines[di];
                            if (dl.startsWith('+') && !dl.startsWith('+++')) echoSystem(C.green + dl + C.reset);
                            else if (dl.startsWith('-') && !dl.startsWith('---')) echoSystem(C.red + dl + C.reset);
                            else echoSystem(dl);
                        }
                        if (lines.length > 80) echoSystem('... (+' + (lines.length - 80) + ' more lines)');
                    }
                } else {
                    echoError('git diff 失败: ' + ((diffRes && diffRes.error) || 'unknown'));
                }
            } catch(e) {
                echoError('git diff 错误: ' + (e.message || e));
            }
        } else if (name === '/compact') {
            // D-3: 压缩 body — 标记压缩点 + 折叠
            if (state.body.length > 30) {
                var keep = 20;
                var folded = state.body.length - keep;
                // 添加压缩标记线
                var markLine = C.gray + C.dim + '  ──── compaction point ────' + C.reset;
                state.body.splice(0, folded, markLine, C.gray + C.dim + '  [已折叠 ' + folded + ' 条历史消息]' + C.reset);
                echoSystem('已压缩对话历史（保留最后 ' + keep + ' 条，折叠 ' + folded + ' 条）');
                redraw();
            } else {
                echoSystem('对话历史较短（' + state.body.length + ' 条），无需压缩');
            }
        } else if (name === '/cd') {
            // 切换工作目录（通过 API 通知 daemon，保持会话运行）
            if (arg) {
                try {
                    // 先通过 API 通知 daemon 更新 cwd
                    if (state.token) {
                        await httpPost('/api/change-dir', { token: state.token, path: arg });
                    }
                    state.status.cwd = arg;
                    setStatus(state.status.model, '/help 查看命令', state.status.ctx);
                    echoSystem('工作目录: ' + arg);
                } catch(e) {
                    state.status.cwd = arg;
                    setStatus(state.status.model, '/help 查看命令', state.status.ctx);
                    echoSystem('工作目录（CLI）: ' + arg);
                }
            } else {
                echoSystem('当前目录: ' + state.status.cwd);
            }
        } else if (name === '/copy' || name === '/cp') {
            // 复制最后一个代码块到剪贴板
            var lastReply = '';
            for (var cpi = state.body.length - 1; cpi >= 0; cpi--) {
                var cl = state.body[cpi];
                if (typeof cl === 'string' && !cl.match(/^\s*[◎◐▸╰>\[]/)) {
                    lastReply = (lastReply ? cl + '\n' + lastReply : cl);
                } else if (lastReply) break;
            }
            // 提取 ``` 代码块
            var codeBlocks = [];
            var inBlock = false;
            var blockLines = [];
            var blockLang = '';
            var replyLines = lastReply.split('\n');
            for (var rli = 0; rli < replyLines.length; rli++) {
                var rl = replyLines[rli];
                if (rl.trim().match(/^```/)) {
                    if (inBlock) {
                        codeBlocks.push({ lang: blockLang, code: blockLines.join('\n') });
                        blockLines = [];
                        inBlock = false;
                    } else {
                        inBlock = true;
                        blockLang = rl.trim().substring(3).trim();
                    }
                } else if (inBlock) {
                    blockLines.push(rl);
                }
            }
            if (codeBlocks.length === 0) {
                echoSystem('未找到代码块（用 /copy N 复制第 N 个，/copy all 复制全部）');
            } else {
                var copyIdx = parseInt(arg) || 1;
                var copyAll = arg === 'all';
                if (copyAll) {
                    var allCode = codeBlocks.map(function(b) { return b.code; }).join('\n\n');
                    if (window.electronAPI && window.electronAPI.clipboardWriteText) {
                        await window.electronAPI.clipboardWriteText(allCode);
                        echoSystem('已复制全部 ' + codeBlocks.length + ' 个代码块到剪贴板');
                    } else echoSystem('剪贴板不可用');
                } else if (copyIdx >= 1 && copyIdx <= codeBlocks.length) {
                    var cb = codeBlocks[copyIdx - 1];
                    if (window.electronAPI && window.electronAPI.clipboardWriteText) {
                        await window.electronAPI.clipboardWriteText(cb.code);
                        echoSystem('已复制代码块 #' + copyIdx + ' (' + (cb.lang || 'text') + ') 到剪贴板');
                    } else echoSystem('剪贴板不可用');
                } else {
                    echoError('代码块索引超出范围（1-' + codeBlocks.length + '）。用 /copy all 复制全部');
                }
            }
        } else if (name === '/view') {
            // 预览文件内容
            if (!arg) { echoError('请指定文件路径: /view <path>'); }
            else {
                try {
                    var viewRes = await window.electronAPI.agentRead(arg);
                    if (viewRes && viewRes.success) {
                        var vLines = (viewRes.content || '').split('\n');
                        var vOut = '';
                        var vMax = Math.min(vLines.length, 80);
                        for (var vi = 0; vi < vMax; vi++) {
                            vOut += (vi + 1) + '\t' + vLines[vi] + '\n';
                        }
                        echoSystem(C.cyan + '── ' + arg + ' (' + vLines.length + ' lines)' + C.reset);
                        echoSystem(vOut.trim());
                        if (vLines.length > 80) echoSystem('... (+' + (vLines.length - 80) + ' more lines)');
                    } else {
                        echoError('读取失败: ' + ((viewRes && viewRes.error) || 'unknown'));
                    }
                } catch(e) { echoError('读取错误: ' + (e.message || e)); }
            }
        } else if (name === '/plan') {
            state.mode = 'plan';
            setStatus(state.status.model, '/help 查看命令', state.status.ctx);
            echoSystem('模式: Plan（只读探索，不执行文件写入和命令）');
        } else if (name === '/build') {
            state.mode = 'build';
            setStatus(state.status.model, '/help 查看命令', state.status.ctx);
            echoSystem('模式: Build（完整执行）');
        } else if (name === '/status') {
            var sessName = state.sessionName || '(未命名)';
            var modeLabel = state.mode === 'plan' ? 'Plan' : 'Build';
            echoSystem('会话: ' + sessName);
            echoSystem('  ID:      ' + state.sessionId);
            echoSystem('  模型:    ' + (state.modelId || 'deepseek'));
            echoSystem('  模式:    ' + modeLabel + (state.deepThink ? ' + 🧠 深度思考' : ''));
            echoSystem('  目录:    ' + state.status.cwd);
            echoSystem('  轮次:    ' + state.turn + (state.hasHistory ? ' (有对话历史)' : ' (新建)'));
            echoSystem('  Body:    ' + state.body.length + ' 条消息');
            echoSystem('  撤销:    ' + state.undoStack.length + ' 步可回退');
        } else if (name === '/mcp') {
            try {
                var mcpTools = await window.electronAPI.mcpGetTools();
                if (mcpTools && mcpTools.success && mcpTools.data) {
                    var mcpServers = {};
                    var tools = mcpTools.data.tools || mcpTools.data || [];
                    for (var mi = 0; mi < tools.length; mi++) {
                        var t = tools[mi];
                        var srv = t.server || 'default';
                        if (!mcpServers[srv]) mcpServers[srv] = [];
                        mcpServers[srv].push(t.name || t.tool || t);
                    }
                    var serverNames = Object.keys(mcpServers);
                    if (serverNames.length === 0) {
                        echoSystem('(无活跃 MCP 服务器)');
                    } else {
                        echoSystem('MCP 服务器 (' + serverNames.length + '):');
                        for (var si = 0; si < serverNames.length; si++) {
                            var sn = serverNames[si];
                            echoSystem('  ' + sn + ' (' + mcpServers[sn].length + ' tools)');
                        }
                    }
                } else {
                    echoSystem('(MCP 未初始化，使用 mcp-init 初始化)');
                }
            } catch(e) {
                echoError('MCP 查询失败: ' + (e.message || e));
            }
        } else if (name === '/rename') {
            if (arg) {
                state.sessionName = arg;
                echoSystem('会话已重命名: ' + arg);
            } else {
                echoSystem('当前名称: ' + (state.sessionName || '(未命名)'));
            }
        } else if (name === '/language' || name === '/lang') {
            state.language = state.language === 'zh' ? 'en' : 'zh';
            echoSystem('语言: ' + (state.language === 'zh' ? '中文' : 'English'));
        } else if (name === '/skills') {
            try {
                var skillsRes = await window.electronAPI.agentSkillsLoad();
                if (skillsRes && skillsRes.success && skillsRes.data) {
                    var skillList = skillsRes.data.skills || skillsRes.data;
                    if (skillList.length === 0) {
                        echoSystem('(没有已安装的技能)');
                    } else {
                        echoSystem('已安装的技能 (' + skillList.length + '):');
                        for (var ski = 0; ski < skillList.length; ski++) {
                            var sk = skillList[ski];
                            echoSystem('  ' + (sk.name || sk) + (sk.description ? ' — ' + sk.description.substring(0, 60) : ''));
                        }
                    }
                } else {
                    echoSystem('(技能系统不可用)');
                }
            } catch(e) {
                echoError('技能查询失败: ' + (e.message || e));
            }
        } else if (name === '/bg') {
            var bgSub = arg.trim().split(/\s+/)[0];
            var bgArg = arg.trim().substring(bgSub.length).trim();
            if (bgSub === 'list' || !bgSub) {
                if (state.bgTasks.length === 0) { echoSystem('(无后台任务。使用 /bg <prompt> 创建)'); }
                else {
                    echoSystem('后台任务 (' + state.bgTasks.length + '):');
                    for (var bi = 0; bi < state.bgTasks.length; bi++) {
                        var bt = state.bgTasks[bi];
                        echoSystem('  #' + (bi + 1) + ' [' + bt.status + '] ' + (bt.text || '').substring(0, 60));
                    }
                }
            } else if (bgSub === 'drop') {
                var idx = parseInt(bgArg) - 1;
                if (idx >= 0 && idx < state.bgTasks.length) {
                    var dropped = state.bgTasks.splice(idx, 1);
                    echoSystem('已删除 #' + (idx + 1) + ': ' + (dropped[0].text || '').substring(0, 40));
                } else { echoError('无效编号: ' + bgArg); }
            } else {
                var bgText = arg;
                var taskId = 'bg-' + Date.now() + '-' + Math.random().toString(36).substring(2, 6);
                state.bgTasks.push({ taskId: taskId, text: bgText, status: 'running', createdAt: new Date().toISOString() });
                try {
                    var bgPayload = {
                        agentId: taskId, token: token, message: { text: bgText },
                        deepThink: state.deepThink, forceNew: true,
                        timeout: state.timeout || 180000, bg: true
                    };
                    if (state.modelId) { bgPayload.clusterConfig = { templateId: 'minimal', roles: { main: { modelId: state.modelId } }, subagentDefaults: { modelId: state.modelId } }; }
                    echoSystem('⏳ 后台 #' + state.bgTasks.length + ' 已提交...');
                    httpPost('/api/request', bgPayload).then(function(bgRes) {
                        for (var bfi = 0; bfi < state.bgTasks.length; bfi++) {
                            if (state.bgTasks[bfi].taskId === taskId) {
                                state.bgTasks[bfi].status = bgRes && bgRes.data && bgRes.data.success ? 'done' : 'failed';
                                state.bgTasks[bfi].result = bgRes && bgRes.data; break;
                            }
                        }
                    }).catch(function(e) {
                        for (var bfi2 = 0; bfi2 < state.bgTasks.length; bfi2++) {
                            if (state.bgTasks[bfi2].taskId === taskId) { state.bgTasks[bfi2].status = 'failed'; state.bgTasks[bfi2].error = e.message; break; }
                        }
                    });
                    echoSystem('ID: ' + taskId + '（/bg list 查看）');
                } catch(e) { echoError('提交失败: ' + (e.message || e)); }
            }
        } else if (name === '/goal') {
            var goalSub = arg.trim().split(/\s+/)[0].toLowerCase();
            var goalArg = arg.trim().substring(goalSub.length).trim();
            if (!goalSub || goalSub === 'status') {
                if (state.goalCondition) { echoSystem('目标: ' + state.goalCondition + (state.goalActive ? ' (运行中)' : ' (已停止)')); }
                else { echoSystem('(未设置目标。使用 /goal <条件> 设置)'); }
            } else if (['clear','stop','off','reset','none','cancel'].indexOf(goalSub) >= 0) {
                state.goalCondition = null; state.goalActive = false;
                echoSystem('目标已清除');
            } else {
                state.goalCondition = arg; state.goalActive = true;
                state.input = arg; state.cursor = state.input.length;
                echoSystem('🎯 目标: ' + arg + '（下条消息启动循环）');
                state._nextGoal = arg;
            }
        } else {
            echoError('未知命令: ' + name + ' （输入 /help 查看命令）');
        }
    }
}

async function main() {
    var args = process.argv.slice(2);

    if (args.indexOf('--help') >= 0 || args.indexOf('-h') >= 0) {
        printHelp();
        return;
    }
    // 无参数时进入交互模式（类似 atomcode）
    if (args.length === 0) {
        return runInteractive(token, 180000, false, false);
    }

    // -c / --continue: 恢复上次会话
    if (args.indexOf('--continue') >= 0 || args.indexOf('-c') >= 0) {
        // 去掉 -c 参数后如果还有别的参数则走正常流程
        var filteredArgs = args.filter(function(a) { return a !== '--continue' && a !== '-c'; });
        if (filteredArgs.length === 0) {
            return runInteractive(token, 180000, false, true);
        }
        return runInteractive(token, 180000, false, true);
    }

    // --token-info: 向服务端查询当前 token（用于调试）
    if (args.indexOf('--token-info') >= 0) {
        try {
            await ensureServerRunning();
        } catch(e) {
            console.log('❌ ' + e.message);
            process.exit(1);
        }
        var token = getEffectiveToken();
        if (!token) {
            console.log('token 文件: ' + TOKEN_FILE);
            console.log('请确认文件存在并包含有效的 token');
            process.exit(1);
        }
        try {
            var res = await httpPost('/api/request', { token: token, action: 'ping' });
            if (res.status === 200) {
                console.log('✅ 连接成功');
                console.log('HOST: ' + HOST);
                console.log('PORT: ' + PORT);
                console.log('TOKEN: ' + token);
            } else if (res.status === 403) {
                console.log('❌ Token 无效');
                process.exit(1);
            }
        } catch(e) {
            console.log('❌ 连接失败: ' + e.message);
            process.exit(1);
        }
        return;
    }

    // 交互模式
    if (args.indexOf('-i') >= 0 || args.indexOf('--interactive') >= 0) {
        return runInteractive(token, requestTimeout, rawOutput, false);
    }

    // 解析参数
    var prompt = '';
    var modelId = '';
    var token = getTokenFromEnv();
    var deepThink = false;
    var systemPrompt = '';
    var files = [];
    var images = [];
    var role = '';
    var templateId = '';
    var requestTimeout = 180000;
    var rawOutput = false;

    for (var i = 0; i < args.length; i++) {
        if ((args[i] === '-p' || args[i] === '--prompt') && i + 1 < args.length) {
            prompt = args[++i];
        } else if ((args[i] === '-f' || args[i] === '--prompt-file') && i + 1 < args.length) {
            // 从文件读取提示词
            try {
                prompt = require('fs').readFileSync(args[++i], 'utf-8');
            } catch(e) {
                console.error('❌ 读取文件失败:', e.message);
                process.exit(1);
            }
        } else if (args[i] === '--model' && i + 1 < args.length) {
            modelId = args[++i];
        } else if (args[i] === '--token' && i + 1 < args.length) {
            token = args[++i];
        } else if (args[i] === '--deep-think' || args[i] === '--deepthink') {
            deepThink = true;
        } else if (args[i] === '--system' && i + 1 < args.length) {
            systemPrompt = args[++i];
        } else if (args[i] === '--files' && i + 1 < args.length) {
            files = args[++i].split(',').map(function(f) { return f.trim(); }).filter(function(f) { return f; });
        } else if (args[i] === '--images' && i + 1 < args.length) {
            images = args[++i].split(',').map(function(f) { return f.trim(); }).filter(function(f) { return f; });
        } else if (args[i] === '--role' && i + 1 < args.length) {
            role = args[++i];
        } else if (args[i] === '--template' && i + 1 < args.length) {
            templateId = args[++i];
        } else if (args[i] === '--timeout' && i + 1 < args.length) {
            requestTimeout = parseInt(args[++i], 10) || 180000;
        } else if (args[i] === '--raw') {
            rawOutput = true;
        }
    }

    if (!prompt) {
        console.error('错误: 请使用 -p 或 -f 指定提示词');
        console.error('用法: dsagent-cli -p "prompt" [options] 或 dsagent-cli -f file.txt');
        process.exit(1);
    }

    // 确保 server 运行 + 获取 token
    try {
        await ensureServerRunning();
    } catch(e) {
        console.error('❌ ' + e.message);
        process.exit(1);
    }
    if (!token) token = getEffectiveToken();
    if (!token) {
        console.error('错误: 无法获取 API token。请设置 DSAGENT_TOKEN 环境变量');
        process.exit(1);
    }

    // 构造 payload
    var agentId = 'cli-' + Date.now() + '-' + Math.random().toString(36).substring(2, 8);
    var payload = {
        agentId: agentId,
        token: token,
        message: { text: prompt },
        deepThink: deepThink,
        forceNew: true,
        timeout: requestTimeout
    };
    if (systemPrompt) payload.systemPrompt = systemPrompt;
    if (files.length > 0) payload.files = files;
    if (images.length > 0) payload.images = images;
    if (role) payload.role = role;
    if (modelId || templateId) {
        payload.clusterConfig = {
            templateId: templateId || 'minimal',
            roles: {},
            subagentDefaults: {}
        };
        if (modelId) payload.clusterConfig.roles[role || 'main'] = { modelId: modelId };
        if (modelId) payload.clusterConfig.subagentDefaults.modelId = modelId;
    }
    // 添加历史记录支持
    payload.history = {
        id: 'cli-' + Date.now(),
        title: prompt.substring(0, 80),
        messages: []
    };

    try {
        var res = await httpPost('/api/request', payload);
        if (res.status === 200 && res.data) {
            if (res.data.success) {
                var output = res.data.data.markdown || '';

                if (rawOutput) {
                    // --raw: 输出完整 JSON
                    console.log(JSON.stringify(res.data, null, 2));
                } else {
                    // 清理输出：AI 按系统提示输出 JSON 格式（{"message": "..."}），提取纯文本消息
                    var cleanLines = [];
                    var lines = output.split('\n');
                    for (var li = 0; li < lines.length; li++) {
                        var line = lines[li].trim();
                        if (!line) continue;
                        try {
                            var parsed = JSON.parse(line);
                            if (parsed && parsed.message) {
                                cleanLines.push(parsed.message);
                                continue;
                            }
                            if (parsed && parsed.file) continue;
                        } catch(e) { /* 不是 JSON，保留原样 */ }
                        cleanLines.push(lines[li]);
                    }
                    output = cleanLines.join('\n').trim();
                    if (res.data.data.think) {
                        output = '> ' + res.data.data.think.replace(/\n/g, '\n> ') + '\n\n' + output;
                    }
                }

                console.log(output);
                process.exit(0);
            } else {
                console.error('错误: ' + (res.data.error || '未知错误'));
                process.exit(1);
            }
        } else if (res.status === 403) {
            console.error('错误: Token 无效');
            process.exit(1);
        } else {
            console.error('错误: HTTP ' + res.status + ' ' + JSON.stringify(res.data));
            process.exit(1);
        }
    } catch(e) {
        console.error('错误: ' + e.message);
        process.exit(1);
    }
}

main().catch(function(e) {
    console.error('错误: ' + e.message);
    process.exit(1);
});
