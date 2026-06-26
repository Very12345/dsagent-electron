// skill - 获取指定技能的完整 SKILL.md 内容
;(function() {
    if (window.__dsagent_tools && window.__dsagent_tools._skill_registered) return;

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
        name: 'skill',
        scope: '获取已加载技能的完整指令内容（SKILL.md），或使用 all 列出所有已安装技能及其描述',
        description: '返回已加载技能的完整 SKILL.md 内容。\n\n特殊参数 `all`：列出所有已安装技能的名称和描述。\n\n技能对应的附加文件存放在 `.dsa/skills/{技能名}/` 目录下。',
        params: [
            { name: 'name', type: '字符串', default: '—', required: false, description: '技能名称。传入 all 可列出所有已安装技能及其描述。' }
        ],
        usage: '<tool:skill>{"name": "all"}</tool:skill>\n\n<tool:skill>{"name": "翻译助手"}</tool:skill>',
        notes: '每次调用只返回一个技能的完整内容。使用 all 可以快速浏览所有技能。',
        handler: async function(params, body) {
            var makeResult = window.__dsagent_tools.makeResult;
            var skillName = params.name || params.skillName || body || '';
            // Backward compat
            if (!skillName && body) {
                skillName = body.replace(/\w+\s*=\s*(?:"[^"]*"|'[^']*'|\S+)/g, '').trim();
            }
            skillName = skillName.trim();
            if (!skillName) {
                try {
                    var listRes = await window.electronAPI.agentSkillsLoad();
                    var available = '';
                    if (listRes.success && listRes.skills && listRes.skills.length > 0) {
                        available = '\n\n可用技能：\n' + listRes.skills.map(function(s) { return '- `' + s.name + '`'; }).join('\n');
                    } else {
                        available = '\n\n当前没有已加载的技能。';
                    }
                    return makeResult(false, null, '请指定技能名称，或使用 `all` 列出所有技能。' + available);
                } catch(e) { return makeResult(false, null, '请指定技能名称'); }
            }

            if (skillName.toLowerCase() === 'all') {
                try {
                    var listRes = await window.electronAPI.agentSkillsLoad();
                    if (listRes.success && listRes.skills && listRes.skills.length > 0) {
                        var result = '## 已安装的技能列表\n\n共 ' + listRes.skills.length + ' 个技能：\n\n';
                        listRes.skills.forEach(function(s) {
                            var fm = parseFrontmatter(s.instructions);
                            var displayName = fm.name || s.name;
                            result += '### ' + displayName + '\n';
                            if (fm.description) result += fm.description + '\n';
                            if (s.files && s.files.length > 0) {
                                result += '\n附加文件：' + s.files.map(function(f) { return '`' + f + '`'; }).join(', ');
                            }
                            result += '\n\n';
                        });
                        result += '> 使用 `skill` + 技能名称获取具体技能的完整指令内容。';
                        return makeResult(true, result);
                    }
                    return makeResult(true, '当前没有已安装的技能。');
                } catch(e) { return makeResult(false, null, e.message || '获取技能列表失败'); }
            }

            var res = await window.electronAPI.agentSkillGetContent(skillName);
            if (res.success) return makeResult(true, res.content);

            var available = '';
            try {
                var listRes = await window.electronAPI.agentSkillsLoad();
                if (listRes.success && listRes.skills && listRes.skills.length > 0) {
                    available = '\n\n可用技能：\n' + listRes.skills.map(function(s) { return '- `' + s.name + '`'; }).join('\n');
                }
            } catch(e) {}
            return makeResult(false, null, '未找到技能 "' + skillName + '"：' + (res.error || '技能不存在') + available);
        }
    });
    window.__dsagent_tools._skill_registered = true;
})();