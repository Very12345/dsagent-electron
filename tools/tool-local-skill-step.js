// skill-step - 向 Agent 面板和外部客户端报告技能执行步骤进度
;(function() {
    if (window.__dsagent_tools && window.__dsagent_tools._skill_step_registered) return;

    window.__dsagent_tools.register({
        name: 'skill-step',
        scope: '向 UI 和外部客户端报告 skill 执行到某一步',
        description: '运行 skill 时，每完成/开始一个重要步骤调用一次，用于在 Agent 面板和外部客户端（如 QQ）同步显示当前进度。\n'
            + '调用后系统会更新进度显示，不会阻塞 skill 的后续执行。',
        params: [
            { name: 'skill', type: '字符串', default: '—', required: true, description: '技能名称' },
            { name: 'step', type: '字符串', default: '—', required: true, description: '步骤描述（步骤名称），例如"正在生成封面..."' },
            { name: 'status', type: '字符串', default: 'running', required: false, description: '步骤状态：running / completed / failed / info / complete。可省略，省略时默认 running。' }
        ],
        usage: '<tool:skill-step>{"skill": "ppt-master", "step": "正在生成封面..."}</tool:skill-step>\n\n<tool:skill-step>{"skill": "ppt-master", "step": "complete"}</tool:skill-step>',
        notes: 'skill 和 step 为必填；status 可省略，默认为 running。step 直接填写步骤描述，不需要数字序号。报告下一个 step 时，系统会自动将上一个同 skill 的 running 步骤标记为 completed。最终可只填 step=complete（status 自动视为 completed）。',
        handler: async function(params, body) {
            var makeResult = window.__dsagent_tools.makeResult;
            var skill, step, status;

            // Check if new params format is being used
            var hasNewParams = params.skill || params.step || params.status;
            if (hasNewParams) {
                skill = (params.skill || '').trim();
                step = (params.step || '').trim();
                status = (params.status || 'running').trim().toLowerCase();
            } else {
                // Old format: parse body content as key=value pairs
                var content = body || '';
                var kv = (typeof window.__dsagent_parseKeyValuePairs === 'function')
                    ? window.__dsagent_parseKeyValuePairs(content)
                    : {};
                skill = (kv.skill || '').trim();
                step = (kv.step || '').trim();
                status = (kv.status || 'running').trim().toLowerCase();
            }

            if (!skill) return makeResult(false, null, 'Missing skill name');
            if (!step) return makeResult(false, null, 'Missing step description');

            if (status === 'complete') status = 'completed';
            var validStatuses = ['running', 'completed', 'failed', 'info'];
            if (validStatuses.indexOf(status) === -1) status = 'info';

            var payload = {
                type: 'skill-step',
                skill: skill,
                step: step,
                status: status,
                ts: Date.now()
            };

            try {
                window.electronAPI.agentForwardResult(payload);
            } catch (e) {
                console.warn('[SkillStep] forward failed:', e);
            }

            var statusLabels = { running: '进行中', completed: '已完成', failed: '失败', info: '信息' };
            return makeResult(true, '✅ 已报告步骤：' + skill + ' / ' + step + ' [' + statusLabels[status] + ']');
        }
    });
    window.__dsagent_tools._skill_step_registered = true;
})();