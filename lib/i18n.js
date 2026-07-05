// i18n.js — 最小多语言支持（P2: 参考 atomcode i18n/）
// 为 CLI TUI 和 prompt-builder 提供中/英文切换
// 暴露 t(key) + setLanguage(locale) + getCurrentLanguage()
'use strict';

// 中文语言包（默认）
const zhCN = {};
// 英文语言包
const en = {
    'cmd.help': 'Help',
    'cmd.quit': 'Quit',
    'cmd.clear': 'New conversation',
    'cmd.model': 'Switch model',
    'cmd.deepthink': 'Toggle deep thinking',
    'cmd.plan': 'Plan mode (read-only exploration)',
    'cmd.build': 'Build mode (full execution)',
    'cmd.raw': 'Toggle raw output',
    'cmd.timeout': 'Set timeout (ms)',
    'cmd.token': 'View API token',
    'cmd.ctx': 'View context status',
    'cmd.status': 'Session status',
    'cmd.cd': 'Change directory',
    'cmd.cost': 'View token usage',
    'cmd.diff': 'View git diff',
    'cmd.compact': 'Compact conversation history',
    'cmd.copy': 'Copy code block',
    'cmd.view': 'Preview file',
    'cmd.mcp': 'MCP status',
    'cmd.rename': 'Rename session',
    'cmd.skills': 'Browse skills',
    'cmd.language': 'Switch language',
    'cmd.bg': 'Background task',
    'cmd.bg.list': 'List background tasks',
    'cmd.bg.drop': 'Drop background task',
    'cmd.bg.status': 'View background task status',
    'cmd.worktree': 'Git worktree isolation',
    'cmd.worktree.create': 'Create worktree',
    'cmd.worktree.list': 'List worktrees',
    'cmd.worktree.cleanup': 'Clean up worktree',
    'cmd.goal': 'Set autonomous goal',
    'cmd.goal.status': 'View goal status',
    'cmd.goal.clear': 'Clear goal',
    'cmd.resume': 'Resume previous session',
    'cmd.session': 'New/switch session',
    'cmd.undo': 'Undo last turn',
    'cmd.keys': 'Keyboard shortcuts',
    'cmd.upgrade': 'Check for updates (git pull)',
    'cost.title': 'Token usage',
    'cost.rounds': 'rounds',
    'cost.duration': 'Duration',
    'cost.datalogUnavailable': 'Token usage: (datalog unavailable)',
    'bg.noTasks': '(No background tasks. Use /bg <prompt> to create one)',
    'bg.tasks': 'Background tasks',
    'bg.submitted': 'Submitted',
    'bg.id': 'ID',
    'bg.viewDetails': 'View details',
    'bg.status': 'Status',
    'upgrade.checking': 'Checking for updates...',
    'upgrade.found': 'new commits found',
    'upgrade.latest': 'Already up to date or not a git repository',
    'upgrade.failed': 'Check failed',
    'worktree.usage': 'Usage: /worktree create <branch> [base]',
    'worktree.created': 'Worktree created',
    'worktree.branch': 'Branch',
    'worktree.path': 'Path',
    'worktree.cleaned': 'Worktree cleaned up',
    'session.new': 'New conversation started',
    'session.renamed': 'Session renamed to',
    'undo.done': 'Last turn undone',
    'undo.none': 'Nothing to undo',
    'general.uptodate': 'Up to date',
    'general.error': 'Error',
    'general.unknown': 'Unknown',
    'general.ok': 'OK',
};

var _currentLanguage = 'zh';  // 'zh' | 'en'
var _fallback = zhCN;

function getCurrentLanguage() { return _currentLanguage; }

function setLanguage(locale) {
    if (locale === 'en' || locale === 'en-US' || locale === 'en-CN') {
        _currentLanguage = 'en';
        _fallback = en;
        return true;
    }
    _currentLanguage = 'zh';
    _fallback = zhCN;
    return true;
}

function t(key) {
    if (_currentLanguage === 'en' && en[key]) return en[key];
    return key;  // 无翻译时返回 key 本身
}

module.exports = { t: t, setLanguage: setLanguage, getCurrentLanguage: getCurrentLanguage };
