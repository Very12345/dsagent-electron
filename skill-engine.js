// skill-engine.js — 技能引擎（对齐 atomcode Skill 设计）
// 模板引擎 + 注册表 + 权限模型 + 自动注入
'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// ===== 技能结构 =====
// 对应 atomcode skill.rs 的 Skill struct
// .dsa/skills/<name>/SKILL.md
// ---
// name: 技能名
// description: 描述
// disable_model_invocation: false
// user_invocable: true
// argument_hint: "[参数提示]"
// allowed_tools: []
// ---
// 模板内容...

const SKILLS_DIR = '.dsa';
const SKILL_SUBDIR = 'skills';

// 获取技能存储路径：优先使用配置中的 skillsStoragePath
function getStoragePath(rootDir) {
    try {
        var server = require('./server.js');
        var configRes = server.getSkillsStoragePath && server.getSkillsStoragePath();
        if (configRes && configRes.success && configRes.path) {
            var p = configRes.path;
            if (fs.existsSync(p)) return p;
        }
    } catch(e) {}
    // 回退：项目级 .dsa/skills/ 或全局
    if (rootDir) {
        var proj = path.join(rootDir, SKILLS_DIR, SKILL_SUBDIR);
        if (fs.existsSync(proj)) return proj;
    }
    // 全局 fallback
    var home = process.env.HOME || process.env.USERPROFILE || '.';
    return path.join(home, SKILLS_DIR, SKILL_SUBDIR);
}

// ===== 注册表 =====
var _registry = new Map(); // name → skill object
var _dirty = true;

function getBaseDir(rootDir) {
    if (!rootDir) return null;
    return path.join(rootDir, SKILLS_DIR, SKILL_SUBDIR);
}

function getGlobalDir() {
    var home = process.env.HOME || process.env.USERPROFILE || '.';
    return path.join(home, SKILLS_DIR, SKILL_SUBDIR);
}

// 解析 SKILL.md frontmatter
function parseSkillFile(filePath) {
    try {
        if (!fs.existsSync(filePath)) return null;
        var content = fs.readFileSync(filePath, 'utf-8');
        var skillDir = path.dirname(filePath);
        var name = path.basename(skillDir);

        var skill = {
            name: name,
            description: '',
            template: content,
            disable_model_invocation: false,
            user_invocable: true,
            argument_hint: null,
            allowed_tools: [],
            skill_dir: skillDir,
            source_path: filePath
        };

        // 解析 frontmatter (--- 包围的 YAML 风格块)
        var fmMatch = content.match(/^---\n([\s\S]*?)\n---\n?/);
        if (fmMatch) {
            var fmText = fmMatch[1];
            var lines = fmText.split('\n');
            lines.forEach(function(line) {
                var m = line.match(/^(\w+)\s*:\s*(.+)$/);
                if (!m) return;
                var key = m[1].trim();
                var val = m[2].trim();
                switch (key) {
                    case 'name': skill.name = val; break;
                    case 'description': skill.description = val; break;
                    case 'disable_model_invocation': skill.disable_model_invocation = val === 'true'; break;
                    case 'user_invocable': skill.user_invocable = val !== 'false'; break;
                    case 'argument_hint': skill.argument_hint = val; break;
                    case 'allowed_tools':
                        try { skill.allowed_tools = JSON.parse(val); } catch(e) {
                            skill.allowed_tools = val.split(',').map(function(s) { return s.trim(); }).filter(Boolean);
                        }
                        break;
                }
            });
            skill.template = content.substring(fmMatch[0].length).trim();
        }

        return skill;
    } catch(e) {
        console.warn('[SkillEngine] Failed to parse', filePath, e.message);
        return null;
    }
}

// 扫描并加载所有技能
function loadAll(rootDir) {
    _registry.clear();
    var dirs = [];

    // 从配置的存储路径加载
    var storagePath = getStoragePath(rootDir);
    if (storagePath && fs.existsSync(storagePath)) {
        try {
            fs.readdirSync(storagePath).forEach(function(d) {
                var skillFile = path.join(storagePath, d, 'SKILL.md');
                if (fs.existsSync(skillFile)) dirs.push(skillFile);
            });
        } catch(e) {}
    }

    // 也加载项目级 .dsa/skills/
    var projDir = getBaseDir(rootDir);
    if (projDir && fs.existsSync(projDir) && projDir !== storagePath) {
        try {
            fs.readdirSync(projDir).forEach(function(d) {
                var skillFile = path.join(projDir, d, 'SKILL.md');
                if (fs.existsSync(skillFile) && !dirs.some(function(f) { return f === skillFile; })) {
                    dirs.push(skillFile);
                }
            });
        } catch(e) {}
    }

    // 全局技能
    var globalDir = getGlobalDir();
    if (fs.existsSync(globalDir)) {
        try {
            fs.readdirSync(globalDir).forEach(function(d) {
                var skillFile = path.join(globalDir, d, 'SKILL.md');
                if (fs.existsSync(skillFile)) dirs.push(skillFile);
            });
        } catch(e) {}
    }

    dirs.forEach(function(fp) {
        var skill = parseSkillFile(fp);
        if (skill) _registry.set(skill.name, skill);
    });

    _dirty = false;
    return _registry;
}

// 获取单个技能
function get(name, rootDir) {
    if (_dirty) loadAll(rootDir);
    return _registry.get(name) || null;
}

// 列出所有技能
function list(rootDir) {
    if (_dirty) loadAll(rootDir);
    var result = [];
    _registry.forEach(function(s) { result.push(s); });
    return result;
}

// AI 可调用的技能（disable_model_invocation = false）
function invocableByLlm(rootDir) {
    if (_dirty) loadAll(rootDir);
    var result = [];
    _registry.forEach(function(s) {
        if (!s.disable_model_invocation) result.push(s);
    });
    return result;
}

// ===== 模板引擎 =====
// 对应 atomcode skill.rs 的 expand() 方法
// $ARGUMENTS[N] → 位置参数
// $N → 简写
// $ARGUMENTS → 全部参数
// ${SKILL_DIR} → 技能目录
// ${SESSION_ID} → 会话 ID
// !`command` → Shell 注入

function expandTemplate(template, argStr, sessionId) {
    if (!template) return '';
    var positional = argStr.trim() ? argStr.split(/\s+/) : [];
    var result = template;

    // 1. $ARGUMENTS[N]
    for (var i = 0; i < positional.length; i++) {
        result = result.split('$ARGUMENTS[' + i + ']').join(positional[i]);
    }

    // 2. $N 简写（仅当后面不是数字）
    for (var j = 0; j < positional.length; j++) {
        var re = new RegExp('\\$' + j + '(?![0-9])', 'g');
        result = result.replace(re, positional[j]);
    }

    // 3. $ARGUMENTS
    if (result.indexOf('$ARGUMENTS') >= 0) {
        result = result.split('$ARGUMENTS').join(arguments.trim());
    } else if (arguments.trim()) {
        result += '\n\nARGUMENTS: ' + arguments.trim();
    }

    // 4. ${SKILL_DIR}
    // 由调用方传 skillDir 参数
    if (sessionId) {
        result = result.split('${SESSION_ID}').join(sessionId);
    }

    // 5. !`command` shell 注入
    result = result.replace(/!`([^`]+)`/g, function(m, cmd) {
        try {
            return execSync(cmd, { timeout: 10000, windowsHide: true, encoding: 'utf-8' }).trim();
        } catch(e) {
            return '[!`' + cmd + '` 执行失败: ' + (e.message || '') + ']';
        }
    });

    return result;
}

// ===== 对外 API =====

// 获取 AI 可用的技能列表文本（供 prompt-builder 注入）
function getSkillsPrompt(rootDir) {
    var skills = invocableByLlm(rootDir);
    if (skills.length === 0) return '';

    var lines = ['\n=== 可用技能 ==='];
    lines.push('这是完整的可用技能列表。不在此列表中的技能不存在——不要虚构或假定未列出的技能。');
    lines.push('修改技能请直接编辑 SKILL.md 文件。使用 `use_skill` 工具调用技能。\n');

    skills.forEach(function(s) {
        var hint = s.argument_hint ? ' ' + s.argument_hint : '';
        lines.push('- `' + s.name + '`' + hint + ': ' + (s.description || '(无描述)'));
    });

    lines.push('\n使用格式: {"tool": "use_skill", "params": {"name": "技能名", "arguments": "参数"}}');
    return lines.join('\n');
}

// 执行技能：expand 模板 + 返回展开后的内容
function execute(name, argStr, rootDir, sessionId) {
    var skill = get(name, rootDir);
    if (!skill) return { success: false, error: '技能不存在: ' + name };

    var expanded = expandTemplate(skill.template, argStr || '', sessionId || '');
    // 替换 ${SKILL_DIR}
    if (skill.skill_dir) {
        expanded = expanded.split('${SKILL_DIR}').join(skill.skill_dir);
    }

    return {
        success: true,
        name: skill.name,
        description: skill.description,
        expanded: expanded,
        allowed_tools: skill.allowed_tools || [],
        user_invocable: skill.user_invocable
    };
}

// 强制刷新
function refresh(rootDir) {
    _dirty = true;
    return loadAll(rootDir);
}

module.exports = {
    loadAll,
    get,
    list,
    invocableByLlm,
    expandTemplate,
    getSkillsPrompt,
    execute,
    refresh
};
