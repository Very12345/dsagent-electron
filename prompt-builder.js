// prompt-builder.js — 模块化提示词组装器
// 参考 atomcode 的 assemble_system_prompt 设计，分层拼接
// 支持会话级缓存（P5） + 分层指令 + 持久化记忆 + Hook 扩展
'use strict';

const fs = require('fs');
const path = require('path');

// ===== 缓存：每个 session 构建一次 =====
const _promptCache = new Map(); // sessionId → { prompt, jsonFormat }

function invalidateCache(sessionId) {
    _promptCache.delete(sessionId);
}

// ===== 提示片段生成器 =====

// 1. 身份标识
function identitySection(rootDir) {
    return '# 角色介绍\n\n'
        + '你是本地执行助手，能通过本机接口执行命令、读写文件。\n'
        + '当前对话窗口连接了一个本地服务，你可以通过特定格式让服务执行操作。\n';
}

// 2. 环境信息
function environmentSection(rootDir) {
    var env = process.env;
    var os = process.platform;
    var shell = os === 'win32' ? (env.COMSPEC || 'cmd.exe') : (env.SHELL || 'bash');
    var date = new Date().toISOString().split('T')[0];
    var parts = [
        '## 环境信息\n',
        '平台: ' + os + ' | Shell: ' + shell + ' | 日期: ' + date,
        '工作目录: ' + (rootDir || '.'),
        '所有文件路径必须使用绝对路径，基于工作目录。',
    ];
    if (rootDir) {
        parts.push('SCOPE: 请保持在 ' + rootDir + ' 目录内操作，除非用户明确指定了外部路径。');
    }
    return parts.join('\n');
}

// 3. 工具列表
function toolsSection() {
    var s = '## 能力范围\n'
        + '- 读写本地文件（read/save/edit/delete）\n'
        + '- 执行系统命令（exec）\n'
        + '- 搜索文件内容（findstr）\n'
        + '- 读取网页内容（webfetch）\n'
        + '- 并行多文件编辑（parallel_edit：一次性改 2-12 个文件，重构场景用，带 contract 描述跨文件不变量）\n'
        + '- Subagent 独立分析（按集群配置自动选模型，支持嵌套）\n'
        + '- 多模态模型（识图、绘图等，按集群配置自动路由）\n'
        + '- 终端管理（term）\n'
        + '- 计划管理（plan）\n'
        + '- 技能系统（skill）\n'
        + '- MCP 外部工具（mcp）\n'
        + '- 定时任务（interval）\n'
        + '- 表单交互（form）\n'
        + '- Git 自动提交（git_checkpoint）\n'
        + '- Git Worktree 隔离（git_worktree：独立工作目录，AI 改代码不污染主分支，支持 create/list/cleanup）\n'
        + '- 持久化记忆（memory_read/memory_append）\n';
    // P0: 注入工具 schema 全集，让 AI 知道每个工具的必填参数名
    // 避免 AI 频繁调工具缺必填参数（如 read 缺 file_path）
    try {
        var cached = global.__toolDocsCache || '';
        if (cached) {
            s += '\n## 工具调用说明（必填参数必须传，否则工具报错）\n' + cached + '\n';
        }
    } catch(e) {}
    return s;
}

// 4. 分层指令（global → project → user）
// 支持 atomcode/AGENTS.md 开放标准 + dsagent 自有 .dsa/instructions/ 目录
function instructionsSection(rootDir) {
    var parts = [];
    // global: ~/.atomcode/ATOMCODE.md（atomcode 标准） + ~/.dsa/instructions/（dsagent 自有）
    var atomcodeGlobal = path.join(process.env.HOME || process.env.USERPROFILE || '.', '.atomcode', 'ATOMCODE.md');
    if (fs.existsSync(atomcodeGlobal)) {
        try {
            var content = fs.readFileSync(atomcodeGlobal, 'utf-8').trim();
            if (content) parts.push('【全局指令】\n' + content);
        } catch(e) {}
    }
    var globalDir = path.join(process.env.HOME || process.env.USERPROFILE || '.', '.dsa', 'instructions');
    if (fs.existsSync(globalDir)) {
        try {
            var files = fs.readdirSync(globalDir).filter(f => f.endsWith('.md')).sort();
            files.forEach(function(f) {
                var content = fs.readFileSync(path.join(globalDir, f), 'utf-8').trim();
                if (content) parts.push('【全局指令: ' + f.replace(/\.md$/, '') + '】\n' + content);
            });
        } catch(e) {}
    }
    // project: .atomcode.md / AGENTS.md / CLAUDE.md（开放标准） + .dsa/instructions/（dsagent 自有）
    if (rootDir) {
        var standardFiles = ['.atomcode.md', 'AGENTS.md', 'CLAUD.md', 'claude.md', 'ATOMCODE.md'];
        for (var si = 0; si < standardFiles.length; si++) {
            var sf = path.join(rootDir, standardFiles[si]);
            if (fs.existsSync(sf)) {
                try {
                    var sc = fs.readFileSync(sf, 'utf-8').trim();
                    if (sc) parts.push('【项目指令: ' + standardFiles[si] + '】\n' + sc);
                    break;  // 首个命中即可
                } catch(e) {}
            }
        }
        var projDir = path.join(rootDir, '.dsa', 'instructions');
        if (fs.existsSync(projDir)) {
            try {
                var files2 = fs.readdirSync(projDir).filter(f => f.endsWith('.md')).sort();
                files2.forEach(function(f) {
                    var content = fs.readFileSync(path.join(projDir, f), 'utf-8').trim();
                    if (content) parts.push('【项目指令: ' + f.replace(/\.md$/, '') + '】\n' + content);
                });
            } catch(e) {}
        }
    }
    // user: 当前 prompt 目录下 INSTRUCTION*.md 由外部加载，不在此处重复
    return parts.length > 0 ? ('## 分层指令\n\n' + parts.join('\n\n')) : '';
}

// 5. 持久化记忆（P2）
function memorySection(rootDir) {
    try {
        var MemoryStore = require('./memory-store.js');
        var global = MemoryStore.global();
        var project = rootDir ? MemoryStore.project(rootDir) : null;
        var block = MemoryStore.mergedForPrompt(global, project, rootDir ? path.basename(rootDir) : 'project');
        if (block) return '## 持久化记忆\n\n' + block;
    } catch(e) { /* 模块未就绪或文件不存在 */ }
    return '';
}

// 6. 策略规则 + 硬性行为纪律（根据 mode 选择，追加不可覆盖的纪律约束）
//    规则放在最后组装 — 利用近因效应让模型生成第一轮回复时记住约束
function rulesSection(mode) {
    var strategyDir = path.join(__dirname, 'prompt', 'strategy');
    var files = [];
    // 通用策略始终加载
    files.push('common.md');
    // 模式特有策略
    if (mode === 'professional' || mode === 'expert') files.push('professional.md');
    else if (mode === 'quick' || mode === 'fast') files.push('quick.md');
    else if (mode === 'image') files.push('image.md');

    var parts = [];
    files.forEach(function(f) {
        var fp = path.join(strategyDir, f);
        if (fs.existsSync(fp)) {
            parts.push(fs.readFileSync(fp, 'utf-8').trim());
        }
    });

    // 硬性行为纪律（P3 — 参考 AtomCode 行为契约，不可被策略文件覆盖）
    parts.push(
        '## 执行纪律（严格遵守）\n\n'
        + '### 任务处理流程\n'
        + '- **简单任务**（单步操作）：直接做 → 验证 → 结束\n'
        + '- **多步骤任务**（分析/开发）：先搜索了解结构 → 制定计划 → 逐步骤执行 → 验证 → 总结\n'
        + '- **Bug 报告**：先重现错误 → 诊断原因 → 修复 → 验证\n\n'
        + '### 完整性\n'
        + '- **贯穿到底**：一旦明确任务范围，必须完整执行到给出结果才停止。不要做到一半问"要继续吗"\n'
        + '- **必须汇报具体发现**：每完成一个步骤，输出具体的发现和结果。禁止只说"完成""好了"\n'
        + '- **有证据才说完成**：未验证的结果不能算完成。测试失败必须如实报告\n\n'
        + '### 卡住时\n'
        + '- 失败后先读错误信息，分析根本原因，不要重复同一个失败的方法\n'
        + '- 如果 3 轮搜索后仍找不到答案，停，告诉用户你查了什么、建议下一步做什么\n\n'
        + '### 工具纪律\n'
        + '- **并行执行**：多个不依赖的操作必须一次完成（读多个文件、查多个路径），分开每轮浪费 5-30 秒\n'
        + '- **先读再改**：不要对没读过的文件提修改建议\n'
        + '- **不猜测 API**：不知道用法时用 help 查，不要假设参数名或行为'
    );

    return parts.length > 0 ? ('## 策略与纪律\n\n' + parts.join('\n\n---\n\n')) : '';
}

// 6a. 可用技能列表（对齐 atomcode AVAILABLE SKILLS）
function skillsSection(rootDir) {
    try {
        var skillEngine = require('./skill-engine.js');
        var prompt = skillEngine.getSkillsPrompt(rootDir);
        return prompt || '';
    } catch(e) { return ''; }
}

// 6b. Goal 模式指令
function goalSection() {
    return '## Goal 自动循环模式\n\n'
        + '当用户设置 `/goal <条件>` 时，你进入自动循环模式。你需要持续调用工具执行步骤，直到任务目标完成。\n\n'
        + '**规则：**\n'
        + '- 每轮执行完后判断目标是否达成\n'
        + '- 如果已达成，在你的回复末尾**独占一行**输出 `<goal_met/>`（不要附带其他内容）\n'
        + '- 如果未达成，继续调用工具执行下一步\n'
        + '- 系统会自动将你的回复回填，无需等待用户输入\n\n'
        + '**示例：**\n'
        + '```\n<message>已完成第1步：分析了项目结构。</message>\n\n<tool:exec>{"body": "下一步命令"}</tool:exec>\n```\n\n'
        + '目标达成时：\n'
        + '```\n<message>全部任务完成！</message>\n<goal_met/>\n```';
}

// 6c. 平台规则（对齐 atomcode WINDOWS_RULES）
function platformRulesSection() {
    var os = process.platform;
    if (os === 'win32') {
        return '## 平台规则\n\n'
            + '- Shell 运行在 cmd.exe 下（非 WSL）。使用 Windows 语法：dir（非 ls）、where（非 which）、type（非 cat）\n'
            + '- 路径分隔符：命令中用 \\\\。示例：cd src\\\\components\n'
            + '- 装工具：用 winget、choco 或直接下载。不能用 apt/brew\n'
            + '- 查工具：用 where <工具名>（非 which）\n'
            + '- Python 虚拟环境：检查 Scripts\\\\ 子目录（非 bin/）\n'
            + '- PowerShell：复杂脚本用 powershell -Command "..."';
    }
    if (os === 'darwin') {
        return '## 平台规则\n\n'
            + '- Shell: /bin/zsh（默认）。命令与 Linux 基本兼容\n'
            + '- 装工具：用 brew install\n'
            + '- 查工具：用 which <工具名>';
    }
    return '';
}

// 6d. Git 快照（对齐 atomcode env_snapshot.as_prompt_section）
function gitSnapshotSection(rootDir) {
    try {
        var gitDir = rootDir ? path.join(rootDir, '.git') : null;
        if (!gitDir || !fs.existsSync(gitDir)) return '';
        var branch = '';
        try {
            var head = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf-8').trim();
            if (head.indexOf('ref: ') === 0) branch = head.substring(5).replace('refs/heads/', '');
            else branch = head.substring(0, 10); // detached HEAD
        } catch(e) { branch = 'unknown'; }
        var shortHash = '';
        try {
            var packedRefs = path.join(gitDir, 'refs', 'heads', branch);
            if (fs.existsSync(packedRefs)) {
                shortHash = fs.readFileSync(packedRefs, 'utf-8').trim().substring(0, 10);
            } else {
                // try reading from packed-refs
                var pr = path.join(gitDir, 'packed-refs');
                if (fs.existsSync(pr)) {
                    var lines = fs.readFileSync(pr, 'utf-8').split('\n');
                    for (var li = 0; li < lines.length; li++) {
                        if (lines[li].indexOf('refs/heads/' + branch) > 0) {
                            shortHash = lines[li].substring(0, 10); break;
                        }
                    }
                }
            }
        } catch(e) {}
        if (!shortHash) return ''; // not a real git repo yet
        var statusText = '';
        try {
            var statusOut = require('child_process').execSync('git -C "' + rootDir + '" status --porcelain', { encoding: 'utf-8', timeout: 3000 });
            var modified = statusOut.split('\n').filter(function(l) { return l.trim().length > 0; }).length;
            statusText = ' | ' + modified + ' modified';
        } catch(e) {}
        return '## Git 快照\n'
            + '分支: ' + branch + ' | HEAD: ' + shortHash + (statusText || '') + '\n';
    } catch(e) { return ''; }
}

// 7. 模型级微调指令（P3）
function modelDirectivesSection(modelId) {
    var parts = [];
    if (!modelId) return '';
    // CN 语言锁定：Qwen/DeepSeek 等中文模型默认偏好英文输出
    if (modelId.indexOf('qwen') >= 0 || modelId.indexOf('deepseek') >= 0 || modelId.indexOf('kimi') >= 0) {
        parts.push('用户可见的输出请用中文。工具调用参数和代码保持原样。');
    }
    return parts.length > 0 ? ('## 模型指令\n\n' + parts.join('\n')) : '';
}

// 8. Hook 扩展（P1）
function hookExtensionsSection() {
    try {
        var HookEngine = require('./hook-engine.js');
        var exts = HookEngine.getSystemPromptExtensions();
        if (exts && exts.length > 0) {
            return '## Hook 系统扩展\n\n' + exts.join('\n\n');
        }
    } catch(e) {}
    return '';
}

// ===== 核心组装函数 =====

// 构建完整指令文本（由 main.js 的 get-instruction-text IPC 调用）
function buildInstructionText(opts) {
    // opts: { sessionId, modelId, rootDir, mode, useJson }
    // 会话级缓存（P5）
    var cacheKey = opts.sessionId || (opts.modelId + '|' + (opts.rootDir || '') + '|' + (opts.mode || ''));
    if (_promptCache.has(cacheKey)) {
        var cached = _promptCache.get(cacheKey);
        return { text: cached.prompt, useJson: cached.jsonFormat };
    }

    var parts = [];

    // 1. 身份
    parts.push(identitySection(opts.rootDir));
    // 2. 环境
    parts.push(environmentSection(opts.rootDir));
    // 3. 工具列表
    parts.push(toolsSection());
    // 4. 分层指令
    var instructions = instructionsSection(opts.rootDir);
    if (instructions) parts.push(instructions);
    // 5. 持久化记忆
    var memory = memorySection(opts.rootDir);
    if (memory) parts.push(memory);
    // 6a. 可用技能列表
    var skills = skillsSection(opts.rootDir);
    if (skills) parts.push(skills);
    // 6d. Git 快照
    var git = gitSnapshotSection(opts.rootDir);
    if (git) parts.push(git);
    // 7. 模型微调指令
    var directives = modelDirectivesSection(opts.modelId);
    if (directives) parts.push(directives);
    // 7b. Goal 模式指令
    parts.push(goalSection());
    // 6c. 平台规则
    var platform = platformRulesSection();
    if (platform) parts.push(platform);
    // 8. 策略 + 纪律规则（P4 — 移到最后，利用近因效应让模型记住行为约束）
    var rules = rulesSection(opts.mode);
    if (rules) parts.push(rules);
    // 9. Hook 扩展（外部注入的扩展，放在最后但模型视其为外部内容）
    var hooks = hookExtensionsSection();
    if (hooks) parts.push(hooks);

    var prompt = parts.join('\n\n---\n\n');

    // 缓存
    if (opts.sessionId) {
        _promptCache.set(cacheKey, { prompt: prompt, jsonFormat: !!opts.useJson });
    }

    return { text: prompt, useJson: !!opts.useJson };
}

// 获取单条提示片段（供外部按需取用）
function getSection(name, opts) {
    switch (name) {
        case 'identity': return identitySection(opts && opts.rootDir);
        case 'environment': return environmentSection(opts && opts.rootDir);
        case 'tools': return toolsSection();
        case 'instructions': return instructionsSection(opts && opts.rootDir);
        case 'memory': return memorySection(opts && opts.rootDir);
        case 'rules': return rulesSection(opts && opts.mode);
        case 'modelDirectives': return modelDirectivesSection(opts && opts.modelId);
        case 'goal': return goalSection();
        case 'hookExtensions': return hookExtensionsSection();
        default: return '';
    }
}

module.exports = {
    buildInstructionText,
    getSection,
    invalidateCache
};
