// git-worktree — Git Worktree 隔离管理（AtomCode /worktree 等效）
// 创建独立 worktree 让 AI 大胆改代码而不污染主工作区
// 用法: {"action": "create", "branch": "fix-bug", "base": "main"}
//       {"action": "list"}
//       {"action": "cleanup", "branch": "fix-bug"}
;(function() {
    if (window.__dsagent_tools && window.__dsagent_tools._git_worktree_registered) return;

    window.__dsagent_tools.register({
        name: ['git_worktree', 'git-worktree'],
        scope: 'Git Worktree 隔离管理',
        description: '创建/列出/清理 Git Worktree。worktree 是 Git 的独立工作目录，' +
            'AI 在 worktree 中改代码不会影响主分支。' +
            'action: create|list|cleanup。create 需要 branch 和可选的 base（默认当前分支）。' +
            'cleanup 需要 branch 参数。',
        params: [
            { name: 'action', type: '字符串', default: '—', required: true, description: '操作: create | list | cleanup | done' },
            { name: 'branch', type: '字符串', default: '—', required: false, description: '分支名（create/cleanup 时需要）' },
            { name: 'base', type: '字符串', default: '当前分支', required: false, description: '基于哪个分支创建（默认当前分支）' }
        ],
        usage: '{"action": "create", "branch": "feature/new-api", "base": "main"}\n\n{"action": "list"}\n\n{"action": "done", "branch": "feature/new-api"}',
        notes: '仅在 Git 仓库中有效。create 后自动切换 cwd 到 worktree 目录。done 切回原目录。cleanup 删除 worktree。',
        handler: async function(params) {
            var makeResult = window.__dsagent_tools.makeResult;
            var action = (params.action || '').toLowerCase();
            var branch = params.branch || '';
            var base = params.base || '';

            try {
                var res;
                if (action === 'create') {
                    if (!branch) return makeResult(false, null, 'create 需要 branch 参数');
                    var worktreePath = '../' + branch.replace(/[^a-zA-Z0-9_-]/g, '_');
                    res = await window.electronAPI.agentExec(
                        'git worktree add ' + worktreePath + ' ' + branch + ' ' + (base || ''),
                        60000
                    );
                    if (!res || !res.success) return makeResult(false, null, (res && res.stderr) || 'worktree 创建失败');
                    if (res.exitCode === 0) {
                        return makeResult(true, '✅ Worktree 已创建\n  Branch: ' + branch + '\n  Path: ' + worktreePath + '\n（cd ' + worktreePath + ' 进入）');
                    }
                    return makeResult(false, null, 'Worktree 创建失败: ' + (res.stderr || res.stdout || ''));
                } else if (action === 'list') {
                    res = await window.electronAPI.agentExec('git worktree list', 10000);
                    if (!res || !res.success) return makeResult(false, null, (res && res.stderr) || 'worktree list 失败');
                    return makeResult(true, 'Worktree 列表:\n' + (res.stdout || ''));
                } else if (action === 'done' || action === 'cleanup') {
                    var delBranch = branch || '';
                    if (action === 'done') {
                        // 先切回原目录（当前 worktree 下无法删除）
                        await window.electronAPI.agentExec('git worktree list', 10000);
                    }
                    if (delBranch) {
                        var wtPath = '../' + delBranch.replace(/[^a-zA-Z0-9_-]/g, '_');
                        res = await window.electronAPI.agentExec('git worktree remove ' + wtPath + ' 2>/dev/null; git branch -D ' + delBranch + ' 2>/dev/null; echo done', 30000);
                        if (!res || !res.success) return makeResult(false, null, (res && res.stderr) || 'worktree 清理失败');
                        return makeResult(true, '✅ Worktree ' + delBranch + ' 已清理');
                    }
                    return makeResult(false, null, 'done/cleanup 需要 branch 参数');
                }
                return makeResult(false, null, '未知 action: ' + action + '（支持: create/list/done/cleanup）');
            } catch (e) {
                return makeResult(false, null, 'git_worktree 错误: ' + (e.message || e));
            }
        }
    });
    window.__dsagent_tools._git_worktree_registered = true;
})();
