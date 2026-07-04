// use-skill — 调用技能（对齐 atomcode use_skill 工具）
// 支持模板变量展开、权限模型
;(function() {
    if (window.__dsagent_tools && window.__dsagent_tools._use_skill_registered) return;

    window.__dsagent_tools.register({
        name: 'use-skill',
        scope: '调用已安装的技能（模板展开后执行）',
        description: '调用已安装的技能。技能是预定义的指令模板，支持变量替换。\n\n'
            + '参数说明：\n'
            + '- `name`: 技能名称（必填）\n'
            + '- `arguments`: 传递给技能的位置参数（可选，空格分隔）\n\n'
            + '可用 `use-skill` 的 `all` 参数列出所有可用技能及其描述。',
        params: [
            { name: 'name', type: '字符串', default: '—', required: true, description: '技能名称。传入 all 列出所有可用技能' }
        ],
        usage: '<tool:use-skill>{"name": "translate", "arguments": "Hello World"}</tool:use-skill>',
        notes: '技能模板支持变量：$ARGUMENTS[N]、${SKILL_DIR}、${SESSION_ID}、!`command`',
        handler: async function(params, body) {
            var makeResult = window.__dsagent_tools.makeResult;
            var name = params.name || '';

            if (!name && body) name = body.trim();
            if (!name) return makeResult(false, null, '请指定技能名称（name）');

            // 列出所有技能
            if (name === 'all') {
                try {
                    var res = await window.electronAPI.skillList();
                    if (!res.success || !res.skills || res.skills.length === 0) {
                        return makeResult(true, '暂无可用技能');
                    }
                    var lines = ['## 可用技能\n'];
                    res.skills.forEach(function(s) {
                        if (s.disable_model_invocation) return;
                        var hint = s.argument_hint || '';
                        lines.push('- **' + s.name + '**' + (hint ? ' ' + hint : ''));
                        if (s.description) lines.push('  ' + s.description);
                        if (s.allowed_tools && s.allowed_tools.length > 0) {
                            lines.push('  （自动放行: ' + s.allowed_tools.join(', ') + '）');
                        }
                        lines.push('');
                    });
                    return makeResult(true, lines.join('\n'));
                } catch(e) {
                    return makeResult(false, null, e.message);
                }
            }

            var skillArgs = params.arguments || '';

            try {
                var res = await window.electronAPI.skillExecute(name, skillArgs);
                if (res.success) {
                    var resultText = '## 技能: ' + name + '\n\n' + res.expanded;
                    if (res.allowed_tools && res.allowed_tools.length > 0) {
                        resultText += '\n\n> 自动放行工具: ' + res.allowed_tools.join(', ');
                    }
                    return makeResult(true, resultText);
                }
                return makeResult(false, null, res.error || '技能执行失败');
            } catch (e) {
                return makeResult(false, null, e.message);
            }
        }
    });

    window.__dsagent_tools._use_skill_registered = true;
})();
