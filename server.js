// DeepSeek Local Agent - 本地操作模块（供主进程直接调用）
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const iconv = require('iconv-lite');
const os = require('os');
const { manager: mcpManager } = require('./server-mcp');

const FORBIDDEN_DELETE_PATHS = [
    /^[A-Z]:\\Windows$/i,
    /^[A-Z]:\\Program Files$/i,
    /^[A-Z]:\\Program Files \(x86\)$/i,
];

let BASE_DIR = null;
let _cwd = process.cwd(); // 独立 cwd 句柄，不随 BASE_DIR 变动

function getCwd() { return _cwd; }
function setCwd(newPath) { _cwd = path.resolve(newPath); return _cwd; }

const DEFAULT_CONFIG = {
    dangerousCommands: [
        'del ', 'erase', 'rd ', 'rmdir', 'format', 'diskpart',
        'shutdown', 'restart', 'reboot', 'taskkill', 'tskill',
        'reg delete', 'reg add', 'sc delete', 'net user',
        'takeown', 'icacls', 'cacls', 'attrib -r -s -h',
        'powershell remove-item', 'rm -rf', 'rm -r', 'dd if=/dev/zero',
        'move ', 'ren ', 'rename '
    ],
    safeOperations: ['read', 'list', 'info', 'exists', 'subreader', 'interval', 'interval-list'],
    confirmMode: 'smart',
    commandWhitelist: [],    // 用户信任的命令列表（如 python xxx、node xxx）
    mcpServers: [],          // MCP 服务器配置列表
    skillsStoragePath: ''    // 技能大文件存储路径（空则默认 AppData）
};

// ==================== 内部工具函数 ====================

function getDsaPath(filename) {
    var appData;
    if (process.platform === 'win32') {
        appData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    } else {
        appData = path.join(os.homedir(), '.local', 'share');
    }
    var dsaDir = BASE_DIR ? path.join(BASE_DIR, '.dsa') : path.join(appData, 'dsagent-electron', 'dsa-data');
    if (!fs.existsSync(dsaDir)) fs.mkdirSync(dsaDir, { recursive: true });
    return path.join(dsaDir, filename);
}

function log(type, msg) {
    console.log(`[${new Date().toLocaleTimeString('zh-CN')}] [${type}] ${msg}`);
}

function safeResolve(filePath) {
    // 清理路径中的非法字符
    let p = filePath.replace(/\\/g, '/');
    // 剥离 Windows \\?\ 长路径前缀
    p = p.replace(/^\\\\\?\\/i, '');
    if (/[<>|]/.test(p)) {
        throw new Error('Invalid path characters: < > |');
    }

    // 解析路径
    let resolved;
    if (BASE_DIR && (p === '.' || p === './' || !path.isAbsolute(p.replace(/\//g, '\\')))) {
        resolved = path.resolve(BASE_DIR, p.replace(/\//g, '\\'));
    } else {
        resolved = path.resolve(p.replace(/\//g, '\\'));
    }

    // 标准化路径并检查边界
    const normalized = path.normalize(resolved);

    // 如果设置了 BASE_DIR，确保解析后的路径在 BASE_DIR 内
    if (BASE_DIR) {
        const normalizedBase = path.normalize(BASE_DIR);
        // Windows 下路径比较需要统一大小写
        const resolvedLower = normalized.toLowerCase();
        const baseLower = normalizedBase.toLowerCase();

        if (!resolvedLower.startsWith(baseLower)) {
            log('SECURITY', `Path traversal detected: ${filePath} -> ${normalized} (base: ${normalizedBase})`);
            throw new Error('Path traversal detected: access denied');
        }
    }

    return normalized;
}

function decodeBuffer(buffer) {
    if (!buffer || buffer.length === 0) return '';
    // 先尝试 UTF-8 解码，若无替换字符则认为是 UTF-8
    var utf8 = iconv.decode(buffer, 'utf-8');
    if (utf8.indexOf('\uFFFD') === -1) return utf8;
    // 回退 GBK（cmd.exe 默认代码页）
    var gbk = iconv.decode(buffer, 'gbk');
    if (gbk.indexOf('\uFFFD') === -1) return gbk;
    return utf8;
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
        // 多行命令用 && 连接，直接通过 cmd 执行，避免临时文件
        var singleLine = command.replace(/\r?\n/g, ' && ').replace(/\r/g, '');
        // 将命令中的 Unix 工具别名替换为 Windows 等价命令
        if (process.platform === 'win32') {
            singleLine = singleLine
                .replace(/\bpwd\b/g, 'cd')
                .replace(/\bls\b(?=\s|$|"|'|&|\|)/g, 'dir /b')
                .replace(/\bcat\b(?=\s|$|"|'|&|\|)/g, 'type')
                .replace(/\bcp\b(?=\s|$|"|'|&|\|)/g, 'copy')
                .replace(/\bmv\b(?=\s|$|"|'|&|\|)/g, 'move')
                .replace(/\brm\b(?=\s|$|"|'|&|\|)/g, 'del')
                .replace(/\bmkdir\b(?=\s|$|"|'|&|\|)/g, 'md')
                .replace(/\btouch\b(?=\s|$|"|'|&|\|)/g, 'type nul >')
                // 以上正则已限制为完整单词，可安全用于常见命令
            // Git Bash 下 `> nul` 会创建名为 nul 的文件而非丢弃输出，替换为 /dev/null
            if (process.env.BASH || process.env.MSYSTEM || process.env.MINGW_PREFIX) {
                singleLine = singleLine.replace(/>\s*nul\b/gi, '>/dev/null').replace(/2>nul\b/gi, '2>/dev/null');
            }
        }
        var execOptions = {
            shell: 'cmd.exe',
            windowsHide: true,
            encoding: 'buffer',
            cwd: BASE_DIR || process.cwd(),
            env: Object.assign({}, process.env, process.platform === 'win32' ? { LANG: 'zh_CN.UTF-8', LC_ALL: 'zh_CN.UTF-8' } : {})
        };
        if (timeoutMs && timeoutMs > 0) {
            execOptions.timeout = timeoutMs;
        }
        exec(singleLine, execOptions, (error, stdout, stderr) => {
            const result = {
                stdout: decodeBuffer(stdout),
                stderr: decodeBuffer(stderr),
                error: error ? error.message : null,
                exitCode: error ? (error.code || 1) : 0
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
    if (newBaseDir) _cwd = path.resolve(newBaseDir);
    console.log('[AGENT] Base directory set to:', BASE_DIR || '(none)');
}
function getBaseDir() { return BASE_DIR; }
function getCwd() { return _cwd; }
function setCwd(newPath) { _cwd = path.resolve(newPath); return _cwd; }

async function execCmd(command, timeoutMs) {
    if (!command) return { success: false, error: 'Missing command' };
    const result = await runCmd(command, timeoutMs);
    if (result.timedOut) {
        return { success: false, timedOut: true, stdout: result.stdout, stderr: result.stderr, error: result.error };
    }
    // 非零退出码不等于失败：很多工具用非零退出码表示状态
    // 只要 stdout 有内容，就视为成功
    return { success: true, stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode, error: result.error || null };
}

async function execCmdAdmin(command) {
    if (!command) return { success: false, error: 'Missing command' };
    command = cleanCommand(command);
    log('EXEC-ADMIN', command);

    // 多行命令用 && 连接，直接传递给 PowerShell Start-Process
    var singleLine = command.replace(/\r?\n/g, ' && ').replace(/\r/g, '');
    // Windows 下同步 Unix 别名，避免提权 cmd 中中文乱码问题
    if (process.platform === 'win32') {
        singleLine = singleLine
            .replace(/\bpwd\b/g, 'cd')
            .replace(/\bls\b(?=\s|$|"|'|&|\|)/g, 'dir /b')
            .replace(/\bcat\b(?=\s|$|"|'|&|\|)/g, 'type')
            .replace(/\bcp\b(?=\s|$|"|'|&|\|)/g, 'copy')
            .replace(/\bmv\b(?=\s|$|"|'|&|\|)/g, 'move')
            .replace(/\brm\b(?=\s|$|"|'|&|\|)/g, 'del')
            .replace(/\bmkdir\b(?=\s|$|"|'|&|\|)/g, 'md')
            .replace(/\btouch\b(?=\s|$|"|'|&|\|)/g, 'type nul >');
        singleLine = 'chcp 65001 >nul 2>&1 && ' + singleLine;
    }

    return new Promise(resolve => {
        // 通过 PowerShell Start-Process -Verb RunAs 提权执行
        // 注意：UAC 提升后的进程无法直接捕获输出，会弹出 UAC 确认框
        const psCmd = `Start-Process -FilePath "cmd.exe" -ArgumentList '/c',"${singleLine.replace(/"/g, '\\"')}" -Verb RunAs -Wait -WindowStyle Hidden`;
        exec(psCmd, {
            shell: 'powershell.exe',
            windowsHide: true,
            timeout: 0,
            encoding: 'buffer'
        }, (error, stdout, stderr) => {
            if (error) {
                resolve({ success: false, error: 'Admin execution failed: ' + error.message, stdout: decodeBuffer(stdout), stderr: decodeBuffer(stderr) });
            } else {
                resolve({ success: true, stdout: '[Admin] 命令已以管理员权限执行', stderr: decodeBuffer(stderr) });
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

    // 文件大小限制：100MB
    const MAX_FILE_SIZE = 100 * 1024 * 1024;
    if (content && content.length > MAX_FILE_SIZE) {
        return { success: false, error: 'File content too large (max 100MB, got ' + (content.length / 1024 / 1024).toFixed(2) + 'MB)' };
    }

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
    if (!fs.existsSync(abs)) return { success: false, error: 'File or directory not found' };
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

// ==================== 技能持久化（SKILL.md 标准格式） ====================
// 两级存储：大文件仓库（可配置路径） → 按需同步到工作目录 .dsa/skills/
// 默认直接使用仓库中的技能（节省空间），只有特殊化需求时才同步到工作目录

function getSkillsRepoDir() {
    // 优先使用配置中的自定义路径
    var configResult = loadConfig();
    var customPath = configResult.config.skillsStoragePath || '';
    if (customPath && fs.existsSync(customPath)) {
        return customPath;
    }
    // 默认：AppData 下的 skills-repo
    var appData;
    if (process.platform === 'win32') {
        appData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    } else {
        appData = path.join(os.homedir(), '.local', 'share');
    }
    var dir = path.join(appData, 'dsagent-electron', 'skills-repo');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return dir;
}

function getSkillsWorkDir() {
    // 工作目录下的 .dsa/skills/（仅存放已同步/自定义的技能）
    var dir = path.join(getDsaPath('skills'));
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return dir;
}

// 获取技能存储路径配置
function getSkillsStoragePath() {
    var configResult = loadConfig();
    return { success: true, path: configResult.config.skillsStoragePath || getSkillsRepoDir() };
}

// 设置技能存储路径
function setSkillsStoragePath(newPath) {
    try {
        var configResult = loadConfig();
        var config = configResult.config;
        config.skillsStoragePath = newPath || '';
        saveConfig(config);
        // 如果路径非空，确保目录存在
        if (newPath && !fs.existsSync(newPath)) {
            fs.mkdirSync(newPath, { recursive: true });
        }
        console.log('[SKILLS] Storage path set to:', newPath || '(default AppData)');
        return { success: true };
    } catch (e) {
        return { success: false, error: e.message };
    }
}

// 加载技能：工作目录（已同步/自定义）优先，仓库（默认）作为回退
// 对于未同步的仓库技能，自动创建 junction 链接到工作目录（不占额外空间）
function loadSkills() {
    try {
        var skillsMap = {};
        var repoDir = getSkillsRepoDir();
        var workDir = getSkillsWorkDir();

        // 清理指向无效目标的旧 junction
        if (fs.existsSync(workDir)) {
            var existingEntries = fs.readdirSync(workDir, { withFileTypes: true });
            existingEntries.forEach(function(entry) {
                if (!entry.isDirectory()) return;
                var fullPath = path.join(workDir, entry.name);
                try {
                    if (fs.lstatSync(fullPath).isSymbolicLink()) {
                        // 检查 junction 目标是否仍然有效
                        var target = fs.readlinkSync(fullPath);
                        if (!fs.existsSync(target)) {
                            try { fs.rmdirSync(fullPath); } catch(e) {}
                        }
                    }
                } catch(e) {}
            });
        }

        // 1. 先从仓库加载（作为默认），并为未同步的技能创建 junction
        if (fs.existsSync(repoDir)) {
            var repoEntries = fs.readdirSync(repoDir, { withFileTypes: true });
            repoEntries.forEach(function(entry) {
                if (!entry.isDirectory()) return;
                var skillName = entry.name;
                var skillPath = path.join(repoDir, skillName);
                var mdPath = path.join(skillPath, 'SKILL.md');
                if (!fs.existsSync(mdPath)) return;
                var instructions = fs.readFileSync(mdPath, 'utf-8');
                var files = fs.readdirSync(skillPath).filter(function(f) {
                    return f !== 'SKILL.md';
                });
                skillsMap[skillName] = {
                    name: skillName,
                    instructions: instructions,
                    files: files,
                    source: 'repo'
                };
                // 为未同步的技能创建 junction（不占额外空间）
                var workPath = path.join(workDir, skillName);
                if (!fs.existsSync(workPath)) {
                    try {
                        fs.symlinkSync(skillPath, workPath, 'junction');
                    } catch(e) {
                        // junction 创建失败（如权限不足），回退到复制
                        try { copyFolderSync(skillPath, workPath); } catch(e2) {}
                    }
                }
            });
        }

        // 2. 工作目录的覆盖仓库（已同步/自定义的版本优先）
        if (fs.existsSync(workDir)) {
            var workEntries = fs.readdirSync(workDir, { withFileTypes: true });
            workEntries.forEach(function(entry) {
                if (!entry.isDirectory()) return;
                var skillName = entry.name;
                var skillPath = path.join(workDir, skillName);
                // 跳过 junction（指向 repo 的链接）
                try {
                    if (fs.lstatSync(skillPath).isSymbolicLink()) return;
                } catch(e) {}
                var mdPath = path.join(skillPath, 'SKILL.md');
                if (!fs.existsSync(mdPath)) return;
                var instructions = fs.readFileSync(mdPath, 'utf-8');
                var files = fs.readdirSync(skillPath).filter(function(f) {
                    return f !== 'SKILL.md';
                });
                skillsMap[skillName] = {
                    name: skillName,
                    instructions: instructions,
                    files: files,
                    source: 'work'
                };
            });
        }

        var skills = Object.keys(skillsMap).map(function(k) { return skillsMap[k]; });
        return { success: true, skills: skills };
    } catch (e) {
        console.warn('[SKILLS] Failed to load:', e.message);
        return { success: true, skills: [] };
    }
}

// 获取仓库中所有技能列表（用于同步选择界面）
function listRepoSkills() {
    try {
        var repoDir = getSkillsRepoDir();
        if (!fs.existsSync(repoDir)) return { success: true, skills: [] };
        var entries = fs.readdirSync(repoDir, { withFileTypes: true });
        var skills = [];
        entries.forEach(function(entry) {
            if (!entry.isDirectory()) return;
            var mdPath = path.join(repoDir, entry.name, 'SKILL.md');
            if (!fs.existsSync(mdPath)) return;
            var instructions = fs.readFileSync(mdPath, 'utf-8');
            var fm = parseSkillFrontmatter(instructions);
            skills.push({
                name: entry.name,
                displayName: fm.name || entry.name,
                description: fm.description || ''
            });
        });
        return { success: true, skills: skills };
    } catch (e) {
        return { success: false, error: e.message };
    }
}

// 获取已同步到工作目录的技能名称列表（排除 junction 链接）
function getSyncedSkillNames() {
    try {
        var workDir = getSkillsWorkDir();
        if (!fs.existsSync(workDir)) return [];
        return fs.readdirSync(workDir, { withFileTypes: true })
            .filter(function(e) {
                if (!e.isDirectory()) return false;
                // 排除 junction（指向 repo 的符号链接）
                try {
                    var fullPath = path.join(workDir, e.name);
                    return !fs.lstatSync(fullPath).isSymbolicLink();
                } catch(ex) {
                    return true;
                }
            })
            .map(function(e) { return e.name; });
    } catch (e) {
        return [];
    }
}

// 将指定技能从仓库同步到工作目录（用于特殊化定制）
// 会替换 junction 为实际文件副本
function syncSkillToWorkDir(skillName) {
    try {
        var safeName = skillName.replace(/[^a-zA-Z0-9_\-\u4e00-\u9fff]/g, '');
        if (!safeName) return { success: false, error: '无效的技能名称' };
        var repoDir = getSkillsRepoDir();
        var srcPath = path.join(repoDir, safeName);
        if (!fs.existsSync(srcPath)) {
            return { success: false, error: '仓库中未找到技能: ' + safeName };
        }
        var workDir = getSkillsWorkDir();
        var destPath = path.join(workDir, safeName);
        // 如果已存在（junction 或真实目录），先删除
        if (fs.existsSync(destPath)) {
            // 如果是 junction，用 rmdir 删除（否则 rmSync 可能删除源文件）
            try {
                var stat = fs.lstatSync(destPath);
                if (stat.isSymbolicLink()) {
                    fs.rmdirSync(destPath);
                } else {
                    fs.rmSync(destPath, { recursive: true, force: true });
                }
            } catch(e) {
                fs.rmSync(destPath, { recursive: true, force: true });
            }
        }
        copyFolderSync(srcPath, destPath);
        console.log('[SKILLS] Synced to work dir:', safeName);
        return { success: true, name: safeName };
    } catch (e) {
        return { success: false, error: e.message };
    }
}

// 从工作目录取消同步（删除工作目录副本，重新创建 junction 指向仓库）
function unsyncSkill(skillName) {
    try {
        var safeName = skillName.replace(/[^a-zA-Z0-9_\-\u4e00-\u9fff]/g, '');
        if (!safeName) return { success: false, error: '无效的技能名称' };
        var workDir = getSkillsWorkDir();
        var workPath = path.join(workDir, safeName);
        if (fs.existsSync(workPath)) {
            // 删除工作目录副本（注意：如果是 junction，用 rmdir）
            try {
                var stat = fs.lstatSync(workPath);
                if (stat.isSymbolicLink()) {
                    fs.rmdirSync(workPath);
                } else {
                    fs.rmSync(workPath, { recursive: true, force: true });
                }
            } catch(e) {
                fs.rmSync(workPath, { recursive: true, force: true });
            }
            console.log('[SKILLS] Unsynced from work dir:', safeName);
        }
        // 重新创建 junction 指向仓库
        var repoDir = getSkillsRepoDir();
        var srcPath = path.join(repoDir, safeName);
        if (fs.existsSync(srcPath) && !fs.existsSync(workPath)) {
            try {
                fs.symlinkSync(srcPath, workPath, 'junction');
            } catch(e) {
                try { copyFolderSync(srcPath, workPath); } catch(e2) {}
            }
        }
        return { success: true, name: safeName };
    } catch (e) {
        return { success: false, error: e.message };
    }
}

function importSkill(sourceFolderPath) {
    try {
        var skillName = path.basename(sourceFolderPath);
        var sourceMd = path.join(sourceFolderPath, 'SKILL.md');
        if (!fs.existsSync(sourceMd)) {
            return { success: false, error: '所选文件夹中未找到 SKILL.md 文件' };
        }
        // 仅保存到仓库，不自动同步到工作目录
        var repoDir = getSkillsRepoDir();
        var repoPath = path.join(repoDir, skillName);
        if (fs.existsSync(repoPath)) {
            fs.rmSync(repoPath, { recursive: true, force: true });
        }
        copyFolderSync(sourceFolderPath, repoPath);
        console.log('[SKILLS] Imported to repo:', repoPath);
        return { success: true, name: skillName };
    } catch (e) {
        return { success: false, error: e.message };
    }
}

function deleteSkill(name) {
    try {
        // 使用 path.basename 防止路径穿越，与 importSkill 保持一致
        var safeName = path.basename(name);
        if (!safeName || safeName === '.' || safeName === '..') return { success: false, error: '无效的技能名称' };
        // 1. 从仓库删除
        var repoPath = path.join(getSkillsRepoDir(), safeName);
        if (fs.existsSync(repoPath)) {
            fs.rmSync(repoPath, { recursive: true, force: true });
        }
        // 2. 从工作目录也删除（junction 或真实目录）
        var workPath = path.join(getSkillsWorkDir(), safeName);
        if (fs.existsSync(workPath)) {
            try {
                var stat = fs.lstatSync(workPath);
                if (stat.isSymbolicLink()) {
                    fs.rmdirSync(workPath);
                } else {
                    fs.rmSync(workPath, { recursive: true, force: true });
                }
            } catch(e) {
                fs.rmSync(workPath, { recursive: true, force: true });
            }
        }
        return { success: true };
    } catch (e) {
        return { success: false, error: e.message };
    }
}

function getSkillsPrompt() {
    var result = loadSkills();
    var skills = result.skills || [];
    if (skills.length === 0) return '';
    var disabledSkills = getDisabledSkills();
    var enabledSkills = skills.filter(function(s) { return disabledSkills.indexOf(s.name) === -1; });
    if (enabledSkills.length === 0) return '';
    var prompt = '\n\n## 已加载的技能\n\n';
    prompt += '以下是当前工作区中已加载的技能列表（已禁用的技能不显示）。每个技能包含名称和描述，帮助判断何时使用。\n';
    prompt += '当用户的请求匹配某个技能的用途时，请使用 `skill` 工具获取该技能的完整指令内容后再执行。\n';
    prompt += '使用 `skill` + `all` 可重新列出所有技能及其描述。\n\n';
    prompt += '**技能文件位置：** 每个技能的附加文件存放在 `.dsa/skills/{技能名}/` 目录下。\n';
    prompt += '使用 `read` 读取技能文件时，路径格式为 `.dsa/skills/{技能名}/{文件名}`。\n';
    prompt += '使用 `skill` 获取完整 SKILL.md 指令，例如：\n';
    prompt += '<functioncall>{"tool": "skill", "params": {"name": "技能名称"}}</functioncall>\n\n';
    enabledSkills.forEach(function(s) {
        var fm = parseSkillFrontmatter(s.instructions);
        var displayName = fm.name || s.name;
        prompt += '- **' + displayName + '** — `./dsa/skills/' + s.name + '/`';
        if (fm.description) {
            prompt += '\n  ' + fm.description;
        }
        if (s.files && s.files.length > 0) {
            prompt += '\n  附加文件：' + s.files.map(function(f) { return '`' + f + '`'; }).join(', ');
        }
        prompt += '\n';
    });
    prompt += '\n> 使用 `skill` + 技能名称获取该技能的完整指令内容。\n';
    return prompt;
}

// 解析 SKILL.md 的 YAML frontmatter
// 支持单行 key: value、多行 key: > 和 key: | 语法
function parseSkillFrontmatter(instructions) {
    var fm = {};
    var match = instructions.match(/^---\s*\n([\s\S]*?)\n---/);
    if (!match) return fm;
    var body = match[1];
    var lines = body.split('\n');
    var currentKey = null;
    var currentValue = [];
    var currentMode = null; // 'fold' (>), 'literal' (|), or null (single-line)
    for (var li = 0; li < lines.length; li++) {
        var line = lines[li];
        if (currentKey) {
            // 在多行值收集模式中
            var indentMatch = line.match(/^(\s+)(.*)$/);
            if (indentMatch) {
                // 缩进行 → 继续收集
                currentValue.push(indentMatch[2]);
                continue;
            } else {
                // 非缩进行 → 结束当前多行值
                fm[currentKey] = currentMode === 'literal'
                    ? currentValue.join('\n').trim()
                    : currentValue.join(' ').replace(/\s+/g, ' ').trim();
                currentKey = null;
                currentValue = [];
                currentMode = null;
            }
        }
        // 尝试匹配新的 key: value
        var kv = line.match(/^\s*(\w+)\s*:\s*(.*)$/);
        if (!kv) continue;
        var key = kv[1];
        var val = kv[2].trim();
        if (val === '>' || val === '|') {
            // 多行值开始
            currentKey = key;
            currentValue = [];
            currentMode = val === '|' ? 'literal' : 'fold';
        } else if (val === '') {
            // 空值 → 可能下一行是缩进的多行值（纯 YAML 缩进语法）
            currentKey = key;
            currentValue = [];
            currentMode = 'fold';
        } else {
            // 单行值
            fm[key] = val;
        }
    }
    // 处理最后一个多行值
    if (currentKey) {
        fm[currentKey] = currentMode === 'literal'
            ? currentValue.join('\n').trim()
            : currentValue.join(' ').replace(/\s+/g, ' ').trim();
    }
    return fm;
}

// 获取单个技能的完整 SKILL.md 内容（不截断，返回全文）
function getSkillContent(skillName) {
    try {
        var result = loadSkills();
        var skills = result.skills || [];
        // 精确匹配
        for (var i = 0; i < skills.length; i++) {
            if (skills[i].name === skillName) {
                var content = '# 技能: ' + skills[i].name + '\n\n';
                content += '**路径:** `.dsa/skills/' + skills[i].name + '/`\n';
                if (skills[i].files && skills[i].files.length > 0) {
                    content += '**附加文件:** ' + skills[i].files.map(function(f) { return '`' + f + '`'; }).join(', ') + '\n\n';
                }
                // 返回完整 SKILL.md 内容，不做任何截断
                content += skills[i].instructions;
                return { success: true, content: content };
            }
        }
        // 不区分大小写/模糊匹配作为后备
        var lowerName = skillName.toLowerCase();
        for (var j = 0; j < skills.length; j++) {
            if (skills[j].name.toLowerCase() === lowerName) {
                var content2 = '# 技能: ' + skills[j].name + '\n\n';
                content2 += '**路径:** `.dsa/skills/' + skills[j].name + '/`\n';
                if (skills[j].files && skills[j].files.length > 0) {
                    content2 += '**附加文件:** ' + skills[j].files.map(function(f) { return '`' + f + '`'; }).join(', ') + '\n\n';
                }
                content2 += skills[j].instructions;
                return { success: true, content: content2 };
            }
        }
        return { success: false, error: '未找到技能: ' + skillName };
    } catch (e) {
        return { success: false, error: e.message };
    }
}

function copyFolderSync(src, dest) {
    if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
    var entries = fs.readdirSync(src, { withFileTypes: true });
    entries.forEach(function(entry) {
        var srcPath = path.join(src, entry.name);
        var destPath = path.join(dest, entry.name);
        if (entry.isDirectory()) {
            copyFolderSync(srcPath, destPath);
        } else {
            fs.copyFileSync(srcPath, destPath);
        }
    });
}

// ==================== 技能禁用/启用 ====================

function getDisabledSkills() {
    try {
        var result = loadConfig();
        return result.config.disabledSkills || [];
    } catch (e) {
        return [];
    }
}

function toggleSkillDisabled(name) {
    try {
        var result = loadConfig();
        var config = result.config;
        if (!config.disabledSkills) config.disabledSkills = [];
        var idx = config.disabledSkills.indexOf(name);
        if (idx === -1) {
            config.disabledSkills.push(name);
        } else {
            config.disabledSkills.splice(idx, 1);
        }
        saveConfig(config);
        return { success: true, disabled: idx === -1, disabledSkills: config.disabledSkills };
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
        shell: true,
        env: Object.assign({}, process.env, { LANG: 'zh_CN.UTF-8', LC_ALL: 'zh_CN.UTF-8' })
    });
    // 初始化终端为 UTF-8，避免中文输出乱码
    try { term.child.stdin.write('chcp 65001\r\n'); } catch (e) {}
    term.running = true;
    term.child.stdout.on('data', function(d) { term.stdout += decodeBuffer(d); });
    term.child.stderr.on('data', function(d) { term.stderr += decodeBuffer(d); });
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

// ==================== MCP 桥接 ====================

var mcpInitialized = false;

async function initMcp(force) {
    if (mcpInitialized && !force) return { success: true, message: 'Already initialized' };
    try {
        // 强制重新初始化时先关闭现有连接
        if (force && mcpInitialized) {
            await mcpManager.shutdown();
            mcpInitialized = false;
        }
        var result = loadConfig();
        var config = result.config;
        var mcpServers = config.mcpServers || [];
        if (mcpServers.length === 0) {
            return { success: true, message: 'No MCP servers configured', tools: [] };
        }
        var results = await mcpManager.initFromConfig(mcpServers);
        mcpInitialized = true;
        // 加载已保存的工具状态
        if (config.mcpToolStates) {
            mcpManager.setToolStates(config.mcpToolStates);
        }
        return { success: true, results: results, tools: mcpManager.getAllTools() };
    } catch (e) {
        return { success: false, error: e.message };
    }
}

function getMcpTools() {
    return { success: true, tools: mcpManager.getAllTools() };
}

function getMcpToolStates() {
    // 从配置文件加载
    try {
        var result = loadConfig();
        return { success: true, states: result.config.mcpToolStates || {} };
    } catch(e) {
        return { success: true, states: {} };
    }
}

function setMcpToolStates(states) {
    try {
        var result = loadConfig();
        var config = result.config;
        config.mcpToolStates = states || {};
        saveConfig(config);
        // 同步到内存中的 manager
        mcpManager.setToolStates(config.mcpToolStates);
        return { success: true };
    } catch(e) {
        return { success: false, error: e.message };
    }
}

function setMcpToolEnabled(serverName, toolName, enabled) {
    try {
        mcpManager.setToolEnabled(serverName, toolName, enabled);
        // 持久化到配置
        var result = loadConfig();
        var config = result.config;
        if (!config.mcpToolStates) config.mcpToolStates = {};
        config.mcpToolStates[serverName + '/' + toolName] = enabled;
        saveConfig(config);
        return { success: true };
    } catch(e) {
        return { success: false, error: e.message };
    }
}

function getMcpPrompt() {
    return mcpManager.generateToolsPrompt();
}

function getMcpResources() {
    return { success: true, resources: mcpManager.getAllResources() };
}

function getMcpPrompts() {
    return { success: true, prompts: mcpManager.getAllPrompts() };
}

async function callMcpTool(serverName, toolName, args) {
    try {
        var result = await mcpManager.callTool(serverName, toolName, args);
        return { success: true, result: result };
    } catch (e) {
        return { success: false, error: e.message };
    }
}

async function callMcpResource(serverName, uri) {
    try {
        var result = await mcpManager.readResource(serverName, uri);
        return { success: true, result: result };
    } catch (e) {
        return { success: false, error: e.message };
    }
}

async function callMcpPrompt(serverName, name, args) {
    try {
        var result = await mcpManager.getPrompt(serverName, name, args);
        return { success: true, result: result };
    } catch (e) {
        return { success: false, error: e.message };
    }
}

async function shutdownMcp() {
    await mcpManager.shutdown();
    mcpInitialized = false;
}

// ==================== 导出 ====================

// ==================== 计划管理 ====================

function planLoad() {
    try {
        var planPath = getDsaPath('plan.json');
        if (fs.existsSync(planPath)) {
            var plan = JSON.parse(fs.readFileSync(planPath, 'utf-8'));
            return { success: true, plan: plan };
        }
        return { success: true, plan: null };
    } catch (e) {
        return { success: false, error: e.message };
    }
}

function planSave(plan) {
    try {
        var planPath = getDsaPath('plan.json');
        plan.updatedAt = new Date().toISOString();
        fs.writeFileSync(planPath, JSON.stringify(plan, null, 2), 'utf-8');
        log('PLAN', 'Saved: ' + plan.title);
        return { success: true, plan: plan };
    } catch (e) {
        return { success: false, error: e.message };
    }
}

function planDelete() {
    try {
        var planPath = getDsaPath('plan.json');
        if (fs.existsSync(planPath)) {
            fs.unlinkSync(planPath);
        }
        return { success: true };
    } catch (e) {
        return { success: false, error: e.message };
    }
}

module.exports = {
    setBaseDir,
    getBaseDir,
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
    syncSkillToWorkDir,
    unsyncSkill,
    listRepoSkills,
    getSyncedSkillNames,
    importSkill,
    deleteSkill,
    getSkillsPrompt,
    getSkillContent,
    getSkillsRepoDir,
    getSkillsWorkDir,
    getSkillsStoragePath,
    setSkillsStoragePath,
    getDisabledSkills,
    toggleSkillDisabled,
    addWhitelist,
    removeWhitelist,
    checkWhitelist,
    terminalCreate,
    terminalWrite,
    terminalOutput,
    terminalClear,
    terminalKill,
    terminalList,
    initMcp,
    getMcpTools,
    getMcpToolStates,
    setMcpToolEnabled,
    getMcpPrompt,
    callMcpTool,
    getMcpResources,
    getMcpPrompts,
    callMcpResource,
    callMcpPrompt,
    shutdownMcp,
    planLoad,
    planSave,
    planDelete,
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