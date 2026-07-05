// parallel-edit — 并行多文件编辑（P2: 参考 atomcode tool/parallel_edit.rs）
// 让模型主动声明"这 N 个文件可并行改"，框架 fan-out 到子 agent 各改一个，
// 主 agent 只看汇总，带 contract 字段描述跨文件不变量。
// 重构场景（改 API 签名波及多文件、批量重命名）耗时从串行 N 倍降到并行 1 倍。
;(function() {
    if (window.__dsagent_tools && window.__dsagent_tools._parallel_edit_registered) return;

    window.__dsagent_tools.register({
        name: ['parallel_edit', 'parallel-edit'],
        scope: '并行编辑多个文件',
        description: '一次性对 2-12 个文件各发一条 edit 指令，框架并行执行并返回汇总。每个文件独立编辑，失败不影响其他文件。适合改 API 签名波及多文件、批量重命名等重构场景。',
        params: [
            { name: 'files', type: '数组', default: '—', required: true, description: '文件编辑任务数组，每项 {path, find, replace, regex?}，长度 2-12' },
            { name: 'contract', type: '字符串', default: '—', required: false, description: '跨文件不变量描述（如"所有调用点参数名必须一致"），失败时用于诊断' }
        ],
        usage: '<tool:parallel_edit>{"files":[{"path":"a.js","find":"foo","replace":"bar"},{"path":"b.js","find":"foo","replace":"bar"}],"contract":"两文件同名变量同步改名"}</tool:parallel_edit>',
        notes: '单次最多 12 个文件。每个文件独立调用底层 edit，互不影响。所有结果汇总返回，含成功/失败统计和逐条详情。',
        handler: async function(params, body) {
            var makeResult = window.__dsagent_tools.makeResult;
            var files = params.files || [];
            var contract = params.contract || '';

            // 参数校验
            if (!Array.isArray(files) || files.length < 2) {
                return makeResult(false, null, 'files 必须是长度 ≥2 的数组（并行编辑至少 2 个文件才有意义）');
            }
            if (files.length > 12) {
                return makeResult(false, null, 'files 最多 12 个（避免子 agent 调度爆炸）');
            }
            // 校验每项结构
            for (var i = 0; i < files.length; i++) {
                var f = files[i];
                if (!f || !f.path || !f.find) {
                    return makeResult(false, null, 'files[' + i + '] 缺少必填字段 path/find');
                }
            }

            // 调主进程并行执行（主进程有完整 agentEdit 能力 + 子进程调度）
            try {
                var res = await window.electronAPI.parallelEdit({
                    files: files,
                    contract: contract
                });
                if (!res || !res.success) {
                    return makeResult(false, null, (res && res.error) || '并行编辑失败');
                }
                // 汇总报告：让主 agent 看到全局结果而非各子 agent 细节
                var summary = '【并行编辑汇总】\n';
                summary += '总数 ' + res.total + '，成功 ' + res.succeeded + '，失败 ' + res.failed + '\n';
                if (contract) summary += 'contract: ' + contract + '\n';
                summary += '\n逐条结果：';
                for (var j = 0; j < (res.results || []).length; j++) {
                    var r = res.results[j];
                    summary += '\n[' + (r.success ? '✓' : '✗') + '] ' + r.path + ': ' + (r.message || r.error || '');
                }
                if (res.failed > 0) {
                    summary += '\n\n⚠ 有 ' + res.failed + ' 个文件失败，请检查 contract 是否被违反。';
                }
                return makeResult(res.failed === 0, summary, res.failed > 0 ? ('部分失败: ' + res.failed + ' 个文件') : null);
            } catch (e) {
                return makeResult(false, null, 'parallel_edit 异常: ' + (e.message || e));
            }
        }
    });
    window.__dsagent_tools._parallel_edit_registered = true;
})();
