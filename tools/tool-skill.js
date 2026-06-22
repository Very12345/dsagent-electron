// local-skill - 获取指定技能的完整 SKILL.md 内容
;(function() {
    if (window.__dsagent_tools && window.__dsagent_tools._skill_registered) return;

    // 解析 SKILL.md 的 YAML frontmatter，提取 name 和 description
    function parseFrontmatter(instructions) {
        var fm = {};
        var match = instructions.match(/^---\s*\n([\s\S]*?)\n---/);
        if (match) {
            var lines = match[1].split('\n');
            lines.forEach(function(line) {
                var kv = line.match(/^\s*(\w+)\s*:\s*(.+)$/);
                if (kv) {
                    fm[kv[1]] = kv[2].trim();
                }
            });
        }
        return fm;
    }

    window.__dsagent_tools.register({
        name: 'local-skill',
        scope: '获取已加载技能的完整指令内容（SKILL.md），或使用 all 列出所有已安装技能及其描述',
        description: '返回已加载技能的完整 SKILL.md 内容。在初始化时你只收到了技能名称列表，需要时使用此命令获取具体技能的完整指令。\n\n'
            + '参数为技能名称（中英文皆可），大小写敏感。\n\n'
            + '特殊参数 `all`：列出所有已安装技能的名称和描述，便于你判断应该调用哪个技能。\n\n'
            + '技能对应的附加文件存放在 `.dsa/skills/{技能名}/` 目录下，可以使用 `local-list` 查看文件列表，使用 `local-read` 读取文件内容。',
        params: [
            { name: 'skillName', type: '字符串', default: '—', required: true, description: '技能名称，对应初始化时列出的技能名。如 "翻译助手"、"代码审查" 等。传入 all 可列出所有已安装技能及其描述。' }
        ],
        usage: '# 列出所有技能及描述\nall\n\n# 获取技能完整内容\n翻译助手',
        notes: '每次调用只返回一个技能的完整内容。使用 all 可以快速浏览所有技能。如果技能不存在，会返回错误提示和可用的技能列表。',
        handler: async function(content) {
            // 解析参数，支持 force=true
            var kv = window.__dsagent_parseKeyValuePairs ? window.__dsagent_parseKeyValuePairs(content) : {};
            var skillName = (kv.skillName || content).trim();
            // 兼容直接写 "local-skill ppt-master" 或 "local-skill skillName=ppt-master force=true"
            if (!skillName) {
                skillName = content.replace(/\w+\s*=\s*(?:"[^"]*"|'[^']*'|\S+)/g, '').trim();
            }
            if (!skillName) {
                var available = '';
                try {
                    var listRes = await window.electronAPI.agentSkillsLoad();
                    if (listRes.success && listRes.skills && listRes.skills.length > 0) {
                        available = '\n\n可用技能：\n' + listRes.skills.map(function(s) { return '- `' + s.name + '`'; }).join('\n');
                    } else {
                        available = '\n\n当前没有已加载的技能。';
                    }
                } catch(e) { /* ignore */ }
                return '请指定技能名称，或使用 `all` 列出所有技能。' + available;
            }

            // all 语法：列出所有已安装技能的名称和描述
            if (skillName.toLowerCase() === 'all') {
                try {
                    var listRes = await window.electronAPI.agentSkillsLoad();
                    if (listRes.success && listRes.skills && listRes.skills.length > 0) {
                        var result = '## 已安装的技能列表\n\n';
                        result += '共 ' + listRes.skills.length + ' 个技能：\n\n';
                        listRes.skills.forEach(function(s) {
                            var fm = parseFrontmatter(s.instructions);
                            var displayName = fm.name || s.name;
                            result += '### ' + displayName + '\n';
                            if (fm.description) {
                                result += fm.description + '\n';
                            }
                            if (s.files && s.files.length > 0) {
                                result += '\n附加文件：' + s.files.map(function(f) { return '`' + f + '`'; }).join(', ');
                            }
                            result += '\n\n';
                        });
                        result += '> 使用 `local-skill` + 技能名称获取具体技能的完整指令内容。';
                        return result;
                    } else {
                        return '当前没有已安装的技能。';
                    }
                } catch(e) {
                    return '获取技能列表失败：' + (e.message || '未知错误');
                }
            }

            var res = await window.electronAPI.agentSkillGetContent(skillName);
            if (res.success) {
                return res.content;
            }
            // 技能不存在，列出可用技能
            var available = '';
            try {
                var listRes = await window.electronAPI.agentSkillsLoad();
                if (listRes.success && listRes.skills && listRes.skills.length > 0) {
                    available = '\n\n可用技能：\n' + listRes.skills.map(function(s) { return '- `' + s.name + '`'; }).join('\n');
                } else {
                    available = '\n\n当前没有已加载的技能。';
                }
            } catch(e) { /* ignore */ }
            return '未找到技能 "' + skillName + '"：' + (res.error || '技能不存在') + available;
        }
    });
    window.__dsagent_tools._skill_registered = true;
})();