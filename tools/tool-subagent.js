// subagent — 调用子代理执行独立子任务（参考 atomcode parallel_edit 的子 agent 调度）
// 子代理有独立上下文、独立人设、独立工具权限，可多层嵌套
// 预设模板：file-reader / bug-hunter / code-reviewer / web-researcher / executor
;(function() {
    if (window.__dsagent_tools && window.__dsagent_tools._subagent_registered) return;

    window.__dsagent_tools.register({
        name: ['subagent', 'sub_agent'],
        scope: '调用子代理执行独立子任务',
        description: '派一个子代理独立分析或执行子任务。子代理有独立上下文、独立人设、独立工具白名单，'
            + '不会污染主对话上下文。适合：大文件阅读总结、找 bug、代码审查、联网搜索、受限执行等。'
            + '可同时派多个子代理并行执行（batchId 分组）。',
        params: [
            { name: 'template', type: '字符串', default: '—', required: true, description: '子代理模板 ID（必填）: file-reader | bug-hunter | code-reviewer | web-researcher | executor' },
            { name: 'task', type: '字符串', default: '—', required: true, description: '子代理任务描述（必填），如"阅读 src/main.js 并总结核心模块"' },
            { name: 'files', type: '数组', required: false, description: '子代理可访问的文件路径白名单（可选，默认允许工具白名单内所有操作）' },
            { name: 'batchId', type: '字符串', required: false, description: '并行批次 ID（可选，同 batchId 的子代理并行执行）' }
        ],
        usage: '{"template": "file-reader", "task": "阅读 src/main.js 并总结核心模块"}\n\n{"template": "bug-hunter", "task": "审查 server.js 寻找潜在 bug"}\n\n{"template": "code-reviewer", "task": "审查 agent-orchestrator.js 的代码风格和安全性"}',
        notes: '预设模板有独立工具白名单：file-reader 只能 read/list/info；bug-hunter 能 read/list/grep/info；'
            + 'executor 能 exec/read/list。子代理结果以摘要形式返回主对话，完整结果存入历史。',
        handler: async function(params) {
            var makeResult = window.__dsagent_tools.makeResult;
            var template = (params.template || '').trim();
            var task = (params.task || '').trim();
            if (!template) return makeResult(false, null, '缺少必填参数: template');
            if (!task) return makeResult(false, null, '缺少必填参数: task');

            try {
                // 调主进程 subagent 调度（主进程有 subagent-manager.js 完整实现）
                var res = await window.electronAPI.subagentInvoke({
                    template: template,
                    task: task,
                    files: params.files || null,
                    batchId: params.batchId || null
                });
                if (!res || !res.success) {
                    return makeResult(false, null, (res && res.error) || '子代理调用失败');
                }
                // res.summary 已由 main.js subagent-invoke handler 从 result.data.data.markdown 提取
                var summary = (res && res.summary) || '子代理执行完成（无文本输出）';
                return makeResult(true, '【子代理·' + template + '】\n' + summary);
            } catch (e) {
                return makeResult(false, null, 'subagent 错误: ' + (e.message || e));
            }
        }
    });
    window.__dsagent_tools._subagent_registered = true;
})();
