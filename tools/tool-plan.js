// local-plan - 计划管理（制定/执行/查看/完成）
// AI 通过此工具管理项目计划，用户可掌握项目进度
;(function() {
    if (window.__dsagent_tools && window.__dsagent_tools._plan_registered) return;

    window.__dsagent_tools.register({
        name: 'local-plan',
        scope: '制定、查看、执行、完成项目计划',
        description: '管理项目计划，支持制定计划、标记步骤完成、查看进度、执行计划。\n'
            + '计划会同步到 Agent 面板和外部客户端（如果启用），帮助用户掌握项目进度。\n'
            + 'create=创建计划，add=添加步骤，complete=完成步骤，view=查看进度，execute=获取下一步。',
        params: [
            { name: 'action', type: '字符串', default: 'view', required: false, description: 'create=创建, add=添加步骤, complete=完成步骤, view=查看, execute=获取下一步' },
            { name: 'title', type: '字符串', default: '—', required: false, description: '计划标题（create 时使用）' },
            { name: 'step', type: '字符串', default: '—', required: false, description: '步骤描述（add 时使用）' },
            { name: 'id', type: '数字', default: '—', required: false, description: '步骤 ID（complete 时使用）' },
            { name: 'result', type: '字符串', default: '—', required: false, description: '完成结果说明（complete 时使用）' }
        ],
        usage: '{"tool": "plan", "params": {"action": "create", "title": "开发一个网站"}}\n\n{"tool": "plan", "params": {"action": "add", "step": "编写单元测试"}}\n\n{"tool": "plan", "params": {"action": "complete", "id": 1, "result": "已完成"}}\n\n{"tool": "plan", "params": {"action": "view"}}\n\n{"tool": "plan", "params": {"action": "execute"}}',
        notes: '计划保存在 .dsa/plan.json。创建时可在参数行后直接列出步骤，一行一步，无需多次调用 add。',
        handler: async function(params, body) {
            var makeResult = window.__dsagent_tools.makeResult;

            var action = params.action || '';
            var title = params.title || '';
            var step = params.step || '';
            var stepId = params.id ? parseInt(params.id) : 0;
            var resultText = params.result || '';
            var contentLines = [];

            // Backward compat: parse from body if params are empty
            if (!action && body) {
                var lines = body.trim().split('\n');
                var kv = {};
                var cl = [];
                var paramRegex = /^(\w+)\s*=\s*(?:"([^"]*)"|'([^']*)'|(\S+))\s*$/;
                for (var li = 0; li < lines.length; li++) {
                    var line = lines[li].trim();
                    if (!line) continue;
                    var m = line.match(paramRegex);
                    if (m) {
                        var key = m[1].toLowerCase();
                        var val = m[2] !== undefined ? m[2] : (m[3] !== undefined ? m[3] : m[4]);
                        kv[key] = val;
                    } else {
                        cl.push(line);
                    }
                }
                action = action || kv.action || 'view';
                title = title || kv.title || '';
                step = step || kv.step || '';
                if (!stepId) stepId = parseInt(kv.id) || 0;
                if (!resultText) resultText = kv.result || '';
                contentLines = cl;
            }

            var plan = { title: '', steps: [], createdAt: '', updatedAt: '' };

            // Load existing plan
            var loadFailed = false;
            if (window.electronAPI && window.electronAPI.agentPlanLoad) {
                try {
                    var loadRes = await window.electronAPI.agentPlanLoad();
                    if (loadRes.success && loadRes.plan) {
                        plan = loadRes.plan;
                    } else if (!loadRes.success) {
                        loadFailed = true;
                    }
                } catch(e) {
                    loadFailed = true;
                }
            } else {
                return makeResult(false, null, '计划功能未正确初始化，请联系开发者检查 preload 配置。');
            }

            if (action === 'create') {
                var planTitle = title || '未命名计划';
                var steps = [];
                for (var si = 0; si < contentLines.length; si++) {
                    steps.push({
                        id: si + 1,
                        description: contentLines[si],
                        status: 'pending',
                        result: null
                    });
                }
                plan = {
                    title: planTitle,
                    steps: steps,
                    createdAt: new Date().toISOString(),
                    updatedAt: new Date().toISOString()
                };
                var saveOk = await savePlan(plan);
                if (!saveOk) {
                    return makeResult(false, null, '计划保存失败，请检查文件系统权限。');
                }
                var msg = '✅ 计划已创建: **' + planTitle + '**';
                if (steps.length > 0) {
                    msg += '（' + steps.length + ' 个步骤）\n';
                    for (var sj = 0; sj < steps.length; sj++) {
                        msg += '\n  ' + steps[sj].id + '. ' + steps[sj].description;
                    }
                }
                msg += '\n\n使用 `plan` (`{"tool": "plan", "params": {"action": "execute"}}`) 开始执行，`plan` (`{"tool": "plan", "params": {"action": "add"}}`) 添加更多步骤。';
                return makeResult(true, msg);
            }

            if (action === 'add') {
                if (!plan.title) {
                    return makeResult(false, null, '尚无计划，请先使用 `plan`（`{"tool": "plan", "params": {"action": "create", "title": "..."}}`）创建计划。');
                }
                var stepDesc = step || contentLines.join('\n') || '未命名步骤';
                var newId = plan.steps.length > 0 ? Math.max.apply(null, plan.steps.map(function(s) { return s.id; })) + 1 : 1;
                plan.steps.push({
                    id: newId,
                    description: stepDesc,
                    status: 'pending',
                    result: null
                });
                plan.updatedAt = new Date().toISOString();
                await savePlan(plan);
                return makeResult(true, '✅ 步骤 ' + newId + ' 已添加: ' + stepDesc);
            }

            if (action === 'complete') {
                if (!plan.title) {
                    if (loadFailed) {
                        return makeResult(false, null, '计划文件读取失败，请检查文件系统权限或重新创建计划。');
                    }
                    return makeResult(false, null, '尚无计划，请先创建计划。');
                }
                if (!stepId) {
                    return makeResult(false, null, '请指定要完成的步骤 ID，如 `id=1`。使用 `plan`（`{"tool": "plan", "params": {"action": "view"}}`）查看当前计划。');
                }
                var completeResult = resultText || '已完成';
                var found = false;
                for (var si = 0; si < plan.steps.length; si++) {
                    if (plan.steps[si].id === stepId) {
                        if (plan.steps[si].status === 'done') {
                            return makeResult(false, null, '步骤 ' + stepId + ' 已经完成，无需重复标记。');
                        }
                        plan.steps[si].status = 'done';
                        plan.steps[si].result = completeResult;
                        found = true;
                        break;
                    }
                }
                if (!found) {
                    return makeResult(false, null, '未找到步骤 ' + stepId + '，请使用 `plan`（`{"tool": "plan", "params": {"action": "view"}}`）查看当前计划。');
                }
                plan.updatedAt = new Date().toISOString();
                await savePlan(plan);
                return makeResult(true, '✅ 步骤 ' + stepId + ' 已完成: ' + completeResult);
            }

            if (action === 'execute') {
                if (!plan.title || plan.steps.length === 0) {
                    return makeResult(false, null, '尚无计划或计划为空。');
                }
                var inProgress = null;
                for (var si = 0; si < plan.steps.length; si++) {
                    if (plan.steps[si].status === 'in_progress') {
                        inProgress = plan.steps[si];
                        break;
                    }
                }
                if (inProgress) {
                    return makeResult(true, '▶️ 当前步骤 [' + inProgress.id + '/' + plan.steps.length + ']（仍在进行中）: ' + inProgress.description + '\n\n请执行此步骤，完成后使用 `plan`（`{"tool": "plan", "params": {"action": "complete", "id": ' + inProgress.id + '}}`）标记完成。');
                }
                var nextStep = null;
                for (var si = 0; si < plan.steps.length; si++) {
                    if (plan.steps[si].status === 'pending') {
                        nextStep = plan.steps[si];
                        plan.steps[si].status = 'in_progress';
                        plan.updatedAt = new Date().toISOString();
                        await savePlan(plan);
                        break;
                    }
                }
                if (!nextStep) {
                    return makeResult(true, '✅ 所有步骤已完成！计划完成。');
                }
                return makeResult(true, '▶️ 当前步骤 [' + nextStep.id + '/' + plan.steps.length + ']: ' + nextStep.description + '\n\n请执行此步骤，完成后使用 `plan`（`{"tool": "plan", "params": {"action": "complete", "id": ' + nextStep.id + '}}`）标记完成。');
            }

            // Default action=view
            if (!plan.title || plan.steps.length === 0) {
                return makeResult(true, '📋 当前没有计划。\n\n使用 `plan`（`{"tool": "plan", "params": {"action": "create", "title": "..."}}`）创建计划。');
            }
            var doneCount = plan.steps.filter(function(s) { return s.status === 'done'; }).length;
            var inProgressSteps = plan.steps.filter(function(s) { return s.status === 'in_progress'; });
            var viewText = '📋 **' + plan.title + '** (' + doneCount + '/' + plan.steps.length + ' 已完成)\n\n';
            for (var si = 0; si < plan.steps.length; si++) {
                var s = plan.steps[si];
                var icon = s.status === 'done' ? '✅' : s.status === 'in_progress' ? '🔄' : '⬜';
                viewText += icon + ' ' + s.id + '. ' + s.description;
                if (s.result) viewText += ' — ' + s.result;
                viewText += '\n';
            }
            if (inProgressSteps.length > 0) {
                viewText += '\n⏳ 当前进行中: ' + inProgressSteps.map(function(s) { return '#' + s.id; }).join(', ');
            }
            viewText += '\n\n> 使用 `plan`（`{"tool": "plan", "params": {"action": "execute"}}`）获取下一步。';
            return makeResult(true, viewText);
        }
    });

    async function savePlan(plan) {
        if (window.electronAPI && window.electronAPI.agentPlanSave) {
            try {
                var res = await window.electronAPI.agentPlanSave(plan);
                return res && res.success;
            } catch(e) {
                console.warn('[Plan] Save failed:', e);
                return false;
            }
        }
        return false;
    }

    window.__dsagent_tools._plan_registered = true;
})();