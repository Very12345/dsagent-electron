// git_checkpoint — Git 自动提交工作进展（AtomCode git_auto_commit 等效）
// 用法: {"message": "阶段性进展: 完成登录模块"}
;(function() {
    if (window.__dsagent_tools && window.__dsagent_tools._git_checkpoint_registered) return;

    window.__dsagent_tools.register({
        name: 'git_checkpoint',
        scope: 'Git 自动提交当前工作进展',
        description: '在 Git 仓库中自动提交当前所有变更（git add -A + commit）。' +
            '用于在关键节点记录进展，方便回退。' +
            '可通过 DSAGENT_GIT_AUTOCOMMIT=1 环境变量在每次文件编辑后自动执行。',
        params: [
            { name: 'message', type: '字符串', default: 'checkpoint', required: false, description: '提交信息（可选，默认 "checkpoint: 进展"）' }
        ],
        usage: '{"message": "完成登录模块重构"}\n\n{"message": "checkpoint"}',
        notes: '仅在 Git 仓库中有效。默认不自动执行，需设置 DSAGENT_GIT_AUTOCOMMIT=1 环境变量启用自动提交。',
        handler: async function(params) {
            var makeResult = window.__dsagent_tools.makeResult;
            var msg = params.message || 'checkpoint';
            try {
                var res = await window.electronAPI.agentExec('git add -A && git commit -m ' + JSON.stringify(msg), 30000);
                if (!res || !res.success) return makeResult(false, null, (res && res.stderr) || 'git 命令执行失败');
                if (res.exitCode === 0) {
                    return makeResult(true, '✅ Git checkpoint 已创建: ' + msg);
                } else {
                    var stderr = res.stderr || '';
                    if (stderr.indexOf('nothing to commit') >= 0) {
                        return makeResult(true, 'ℹ️ 没有需要提交的变更');
                    }
                    return makeResult(true, '⚠️ Git checkpoint 结果: exit=' + res.exitCode + '\n' + (res.stdout || res.stderr || ''));
                }
            } catch (e) {
                return makeResult(false, null, 'git_checkpoint 错误: ' + (e.message || e));
            }
        }
    });

    window.__dsagent_tools._git_checkpoint_registered = true;
})();
