// DeepSeek Local Agent - 本地操作模块（供主进程直接调用）
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const iconv = require('iconv-lite');
const os = require('os');

const FORBIDDEN_DELETE_PATHS = [
    /^[A-Z]:\\Windows$/i,
    /^[A-Z]:\\Program Files$/i,
    /^[A-Z]:\\Program Files \(x86\)$/i,
];

let BASE_DIR = null;

const DEFAULT_CONFIG = {
    dangerousCommands: [
        'del ', 'erase', 'rd ', 'rmdir', 'format', 'diskpart',
        'shutdown', 'restart', 'reboot', 'taskkill', 'tskill',
        'reg delete', 'reg add', 'sc delete', 'net user',
        'takeown', 'icacls', 'cacls', 'attrib -r -s -h',
        'powershell remove-item', 'rm -rf', 'rm -r', 'dd if=/dev/zero',
        'move ', 'ren ', 'rename '
    ],
    safeOperations: ['local-read', 'local-list', 'local-info', 'local-exists', 'local-singleread'],
    confirmMode: 'smart',
    commandWhitelist: []    // 用户信任的命令列表（如 python xxx、node xxx）
};

// ==================== 内部工具函数 ====================

function getDsaPath(filename) {
    const dir = BASE_DIR ? path.join(BASE_DIR, '.dsa') : __dirname;
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return path.join(dir, filename);
}

function log(type, msg) {
    console.log(`[${new Date().toLocaleTimeString('zh-CN')}] [${type}] ${msg}`);
}

function safeResolve(filePath) {
    let p = filePath.replace(/\\/g, '/');
    if (/\.\./.test(p) || /[<>]/.test(p)) {
        throw new Error('Invalid path characters');
    }
    let resolved;
    if (BASE_DIR && (p === '.' || p === './' || !path.isAbsolute(p.replace(/\//g, '\\')))) {
        resolved = path.resolve(BASE_DIR, p.replace(/\//g, '\\'));
    } else {
        resolved = path.resolve(p.replace(/\//g, '\\'));
    }
    return resolved;
}

function decodeBuffer(buffer) {
    if (!buffer || buffer.length === 0) return '';
    // 先尝试 UTF-8 解码，若无替换字符则认为是 UTF-8
    var utf8 = iconv.decode(buffer, 'utf-8');
    if (utf8.indexOf('\uFFFD') === -1) return utf8;
    // 回退 GBK（cmd.exe 默认代码页）
    return iconv.decode(buffer, 'gbk');
}

function cleanCommand(cmd) {
    cmd = cmd.replace(/[\u201c\u201d]/g, '"');
    cmd = cmd.replace(/[\u2018\u2019]/g, "'");
    cmd = cmd.replace(/[\u3000]/g, ' ');
    return cmd.trim();
}

function runCmd(command, timeoutMs) {
    return new Promise(resolve => {
        command = cleanCommand(command);
        log('EXEC', command + (BASE_DIR ? ' [cwd: ' + BASE_DIR + ']' : ''));
        // 写入临时 bat 文件（GBK 编码），cmd.exe 可正确识别中文路径
        const tmpFile = path.join(os.tmpdir(), '_dsa_' + Date.now() + '.bat');
        try {
            // 以 GBK 编码写入 .bat 文件，cmd.exe 可正确识别中文路径
            const cmdText = '@echo off\r\n' + command + '\r\n';
            const cmdBuffer = iconv.encode(cmdText, 'gbk');
            fs.writeFileSync(tmpFile, cmdBuffer);
        } catch (e) {
            return resolve({ success: false, error: 'Failed to write temp file: ' + e.message });
        }
        var execOptions = {
            shell: 'cmd.exe',
            windowsHide: true,
            encoding: 'buffer',
            cwd: BASE_DIR || process.cwd()
        };
        if (timeoutMs && timeoutMs > 0) {
            execOptions.timeout = timeoutMs;
        }
        exec('"' + tmpFile + '"', execOptions, (error, stdout, stderr) => {
            try { fs.unlinkSync(tmpFile); } catch(e) {}
            const result = {
                stdout: decodeBuffer(stdout),
                stderr: decodeBuffer(stderr),
                error: error ? decodeBuffer(Buffer.from(error.message)) : null
            };
            // 检测超时
            if (error && error.killed && error.signal === 'SIGTERM') {
                result.timedOut = true;
                result.error = 'Command timed out after ' + (timeoutMs || '?') + 'ms';
            }
            if (result.error) log('RESULT', 'Failed: ' + result.error);
            else log('RESULT', 'OK (' + result.stdout.length + ' chars)');
            if (result.stdout) console.log('stdout:', result.stdout);
            if (result.stderr) console.log('stderr:', result.stderr);
            resolve(result);
        });
    });
}

// ==================== 公开 API ====================

function setBaseDir(newBaseDir) {
    BASE_DIR = newBaseDir;
    console.log('[AGENT] Base directory set to:', BASE_DIR || '(none)');
}

async function execCmd(command, timeoutMs) {
    if (!command) return { success: false, error: 'Missing command' };
    const result = await runCmd(command, timeoutMs);
    if (result.timedOut) {
        return { success: false, timedOut: true, stdout: result.stdout, stderr: result.stderr, error: result.error };
    }
    return { success: true, ...result };
}

async function execCmdAdmin(command) {
    if (!command) return { success: false, error: 'Missing command' };
    command = cleanCommand(command);
    log('EXEC-ADMIN', command);

    const tmpFile = path.join(os.tmpdir(), '_dsa_admin_' + Date.now() + '.bat');
    try {
        const cmdText = '@echo off\r\n' + command + '\r\n';
        const cmdBuffer = iconv.encode(cmdText, 'gbk');
        fs.writeFileSync(tmpFile, cmdBuffer);
    } catch (e) {
        return { success: false, error: 'Failed to write temp file: ' + e.message };
    }

    return new Promise(resolve => {
        // 通过 PowerShell Start-Process -Verb RunAs 提权执行
        // 注意：UAC 提升后的进程无法直接捕获输出，会弹出 UAC 确认框
        const psCmd = `Start-Process -FilePath "cmd.exe" -ArgumentList '/c','"${tmpFile}"' -Verb RunAs -Wait -WindowStyle Hidden`;
        exec(psCmd, {
            shell: 'powershell.exe',
            windowsHide: true,
            timeout: 0
        }, (error) => {
            try { fs.unlinkSync(tmpFile); } catch(e) {}
            if (error) {
                resolve({ success: false, error: 'Admin execution failed: ' + error.message });
            } else {
                resolve({ success: true, stdout: '[Admin] 命令已以管理员权限执行', stderr: '' });
            }
        });
    });
}

function readFile(filePath) {
    if (!filePath) return { success: false, error: 'Missing filePath' };
    const abs = safeResolve(filePath);
    if (!fs.existsSync(abs)) return { success: false, error: 'File not found: ' + abs };
    const content = fs.readFileSync(abs, 'utf-8');
    log('READ', abs + ' (' + content.length + ' chars)');
    return { success: true, content };
}

function readFileBase64(filePath) {
    if (!filePath) return { success: false, error: 'Missing filePath' };
    const abs = safeResolve(filePath);
    if (!fs.existsSync(abs)) return { success: false, error: 'File not found: ' + abs };
    const stat = fs.statSync(abs);
    const ext = path.extname(abs).toLowerCase();
    const mimeMap = { '.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.gif':'image/gif','.webp':'image/webp','.bmp':'image/bmp','.svg':'image/svg+xml','.ico':'image/x-icon','.pdf':'application/pdf','.txt':'text/plain','.md':'text/markdown','.json':'application/json','.js':'text/javascript','.ts':'text/typescript','.py':'text/x-python','.html':'text/html','.css':'text/css','.xml':'application/xml','.csv':'text/csv','.yaml':'text/yaml','.yml':'text/yaml','.sh':'text/x-shellscript','.bat':'text/x-bat','.ps1':'text/x-powershell','.exe':'application/octet-stream','.zip':'application/zip','.tar':'application/x-tar','.gz':'application/gzip' };
    const mime = mimeMap[ext] || 'application/octet-stream';
    const raw = fs.readFileSync(abs);
    const data = raw.toString('base64');
    log('READFILE', abs + ' (' + stat.size + ' bytes, ' + mime + ')');
    return { success: true, name: path.basename(abs), mime, data, size: stat.size };
}

function saveFile(filePath, content) {
    if (!filePath) return { success: false, error: 'Missing filePath' };
    const abs = safeResolve(filePath);
    const dir = path.dirname(abs);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(abs, content !== undefined ? content : '', 'utf-8');
    log('SAVE', abs + ' (' + (content || '').length + ' chars)');
    return { success: true, message: 'Saved to ' + abs };
}

function editFile(filePath, find, regex, replace) {
    if (!filePath) return { success: false, error: 'Missing filePath' };
    if (!find && !regex) return { success: false, error: 'Missing find or regex' };
    const abs = safeResolve(filePath);
    if (!fs.existsSync(abs)) return { success: false, error: 'File not found: ' + abs };

    let content = fs.readFileSync(abs, 'utf-8');
    let modified = false;

    if (regex) {
        try {
            const match = regex.match(/^\/(.+)\/([gimsu]*)$/);
            let pattern, flags = 'g';
            if (match) {
                pattern = match[1];
                const userFlags = match[2];
                flags = userFlags.includes('g') ? userFlags : userFlags + 'g';
            } else { pattern = regex; }
            const re = new RegExp(pattern, flags);
            const newContent = content.replace(re, replace || '');
            if (newContent !== content) { content = newContent; modified = true; }
        } catch (e) {
            return { success: false, error: 'Regex error: ' + e.message };
        }
    } else if (find) {
        const idx = content.indexOf(find);
        if (idx !== -1) {
            content = content.substring(0, idx) + (replace || '') + content.substring(idx + find.length);
            modified = true;
        }
    }

    if (!modified) {
        return { success: true, message: 'No match found, file unchanged', changed: false };
    } else {
        fs.writeFileSync(abs, content, 'utf-8');
        log('EDIT', abs + ' replaced');
        return { success: true, message: 'File modified', changed: true };
    }
}

function listDir(dirPath) {
    const targetPath = dirPath || '.';
    const abs = safeResolve(targetPath);
    if (!fs.existsSync(abs)) return { success: false, error: 'Directory not found' };
    const stat = fs.statSync(abs);
    if (!stat.isDirectory()) return { success: false, error: 'Path is not a directory' };
    const files = fs.readdirSync(abs).map(name => {
        const full = path.join(abs, name);
        const s = fs.statSync(full);
        return { name, isDirectory: s.isDirectory(), size: s.size, mtime: s.mtime.toISOString() };
    });
    return { success: true, path: abs, files };
}

function deleteFile(filePath) {
    if (!filePath) return { success: false, error: 'Missing filePath' };
    const abs = safeResolve(filePath);
    if (!fs.existsSync(abs)) return { success: false, error: 'File not found' };
    if (FORBIDDEN_DELETE_PATHS.some(r => r.test(abs))) {
        return { success: false, error: 'Security: cannot delete system path' };
    }
    const stat = fs.statSync(abs);
    if (stat.isDirectory()) return { success: false, error: 'Cannot delete directories' };
    fs.unlinkSync(abs);
    return { success: true, message: 'Deleted ' + abs };
}

function makeDir(dirPath) {
    if (!dirPath) return { success: false, error: 'Missing filePath' };
    const abs = safeResolve(dirPath);
    if (fs.existsSync(abs)) return { success: false, error: 'Path already exists' };
    fs.mkdirSync(abs, { recursive: true });
    return { success: true, message: 'Created directory ' + abs };
}

function checkExists(filePath) {
    if (!filePath) return { success: false, error: 'Missing filePath' };
    const abs = safeResolve(filePath);
    return { success: true, exists: fs.existsSync(abs) };
}

function getInfo(filePath) {
    if (!filePath) return { success: false, error: 'Missing filePath' };
    const abs = safeResolve(filePath);
    if (!fs.existsSync(abs)) return { success: false, error: 'File not found' };
    const stat = fs.statSync(abs);
    return {
        success: true, size: stat.size, mtime: stat.mtime.toISOString(),
        ctime: stat.ctime.toISOString(), isDirectory: stat.isDirectory(), isFile: stat.isFile()
    };
}

// ==================== 配置持久化 ====================

function loadConfig() {
    try {
        const configPath = getDsaPath('config.json');
        if (fs.existsSync(configPath)) {
            const data = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
            return { success: true, config: Object.assign({}, DEFAULT_CONFIG, data) };
        }
    } catch (e) {
        console.warn('[CONFIG] Failed to load:', e.message);
    }
    return { success: true, config: Object.assign({}, DEFAULT_CONFIG) };
}

function saveConfig(config) {
    try {
        const configPath = getDsaPath('config.json');
        fs.writeFileSync(configPath, JSON.stringify(config || {}, null, 2), 'utf-8');
        console.log('[CONFIG] Saved to', configPath);
        return { success: true };
    } catch (e) {
        console.warn('[CONFIG] Failed to save:', e.message);
        return { success: false, error: e.message };
    }
}

// ==================== 技能持久化 ====================

function loadSkills() {
    try {
        const skillsPath = getDsaPath('skills.json');
        if (fs.existsSync(skillsPath)) {
            const skills = JSON.parse(fs.readFileSync(skillsPath, 'utf-8'));
            return { success: true, skills: skills };
        }
    } catch (e) {
        console.warn('[SKILLS] Failed to load:', e.message);
    }
    return { success: true, skills: [] };
}

function saveSkills(skills) {
    try {
        const skillsPath = getDsaPath('skills.json');
        fs.writeFileSync(skillsPath, JSON.stringify(skills || [], null, 2), 'utf-8');
        return { success: true };
    } catch (e) {
        return { success: false, error: e.message };
    }
}

// ==================== 多终端管理 ====================
// 支持持久化 shell 进程，用于长时间运行或异步命令
const spawn = require('child_process').spawn;
var terminals = {};

function terminalCreate(name, cwd) {
    if (terminals[name]) throw new Error('终端 "' + name + '" 已存在');
    var safeName = name.replace(/[^a-zA-Z0-9_\-\u4e00-\u9fff]/g, '');
    if (!safeName) throw new Error('无效的终端名称');
    var term = {
        name: safeName,
        createdAt: Date.now(),
        stdout: '',
        stderr: '',
        child: null,
        running: false
    };
    term.child = spawn('cmd.exe', [], {
        cwd: cwd || BASE_DIR || process.cwd(),
        windowsHide: true,
        shell: true
    });
    term.running = true;
    term.child.stdout.on('data', function(d) { term.stdout += d.toString(); });
    term.child.stderr.on('data', function(d) { term.stderr += d.toString(); });
    term.child.on('exit', function() {
        term.running = false;
        term.child = null;
    });
    terminals[safeName] = term;
    console.log('[TERM] Created terminal "' + safeName + '"');
    return safeName;
}

function terminalWrite(name, command) {
    var term = terminals[name];
    if (!term) throw new Error('终端 "' + name + '" 不存在');
    if (!term.child || !term.running) throw new Error('终端 "' + name + '" 已停止');
    console.log('[TERM]', name, '<<', command);
    term.child.stdin.write(command + '\r\n');
}

function terminalOutput(name, lines) {
    var term = terminals[name];
    if (!term) return '';
    var all = term.stdout + term.stderr;
    if (!lines || lines <= 0) return all;
    var parts = all.split('\n');
    return parts.slice(-lines).join('\n');
}

function terminalClear(name) {
    var term = terminals[name];
    if (!term) return;
    term.stdout = '';
    term.stderr = '';
}

function terminalKill(name) {
    var term = terminals[name];
    if (!term) return;
    console.log('[TERM] Killing terminal "' + name + '"');
    if (term.child && term.running) {
        term.child.stdin.write('\x03\r\n');
        setTimeout(function() {
            if (term.child && term.running) {
                term.child.kill();
            }
        }, 2000);
    }
    delete terminals[name];
}

function terminalList() {
    var list = [];
    for (var key in terminals) {
        if (terminals.hasOwnProperty(key)) {
            var t = terminals[key];
            list.push({
                name: t.name,
                running: t.running,
                createdAt: t.createdAt,
                stdoutLen: (t.stdout + t.stderr).length
            });
        }
    }
    return list;
}

// ==================== 导出 ====================

module.exports = {
    setBaseDir,
    execCmd,
    execCmdAdmin,
    readFile,
    readFileBase64,
    saveFile,
    editFile,
    listDir,
    deleteFile,
    makeDir,
    checkExists,
    getInfo,
    loadConfig,
    saveConfig,
    loadSkills,
    saveSkills,
    addWhitelist,
    removeWhitelist,
    checkWhitelist,
    terminalCreate,
    terminalWrite,
    terminalOutput,
    terminalClear,
    terminalKill,
    terminalList,
    DEFAULT_CONFIG
};

// ==================== 白名单管理 ====================

function addWhitelist(cmd) {
    try {
        const result = loadConfig();
        const config = result.config;
        if (!config.commandWhitelist) config.commandWhitelist = [];
        // 标准化：去空格、转小写
        const normalized = cmd.trim().toLowerCase();
        if (config.commandWhitelist.indexOf(normalized) === -1) {
            config.commandWhitelist.push(normalized);
            saveConfig(config);
            log('WHITELIST', 'Added: ' + normalized);
        }
        return { success: true, whitelist: config.commandWhitelist };
    } catch (e) {
        return { success: false, error: e.message };
    }
}

function removeWhitelist(cmd) {
    try {
        const result = loadConfig();
        const config = result.config;
        if (!config.commandWhitelist) return { success: true, whitelist: [] };
        const normalized = cmd.trim().toLowerCase();
        config.commandWhitelist = config.commandWhitelist.filter(function(item) {
            return item !== normalized;
        });
        saveConfig(config);
        return { success: true, whitelist: config.commandWhitelist };
    } catch (e) {
        return { success: false, error: e.message };
    }
}

function checkWhitelist(cmd) {
    try {
        const result = loadConfig();
        const config = result.config;
        if (!config.commandWhitelist) return { success: true, whitelisted: false };
        const normalized = cmd.trim().toLowerCase();
        // 前缀匹配（如 "python" 放行所有 python 命令）
        var matched = config.commandWhitelist.some(function(item) {
            return normalized === item || normalized.indexOf(item + ' ') === 0;
        });
        return { success: true, whitelisted: matched };
    } catch (e) {
        return { success: false, error: e.message };
    }
}