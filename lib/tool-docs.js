// tool-docs.js — 工具 schema 静态集（P0: CLI 路径下工具说明注入）
// inject 侧用 tool-system.js 的 generateAllDocs() 动态生成, CLI 路径下
// __toolDocsCache 永远为空 (无注入侧上传). 抽一份静态集给 CLI 直接 require.
// 维护: 与 tools/tool-*.js 的 register 调用保持同步.
'use strict';

// 只列关键工具的必填参数, 完整版由 inject 侧 allDocs 提供
const TOOL_DOCS = [
    {
        names: ['read_file', 'read'],
        scope: '读取文件内容到当前对话中',
        description: '读取本地文件的内容，返回带行号的前缀。大文件用 offset/limit 切片。',
        params: [
            { name: 'file_path', type: '字符串', required: true, description: '文件路径（必填），支持绝对和相对路径' },
            { name: 'offset', type: '数字', required: false, description: '起始行号（1-based）' },
            { name: 'limit', type: '数字', required: false, description: '最大行数' },
            { name: 'mode', type: '字符串', required: false, description: 'image 模式可读图片/PDF' },
            { name: 'force', type: '布尔', required: false, description: '强制读大文件（>10KB）' }
        ],
        usage: '{"file_path": "src/main.js"}\n\n{"file_path": "server.log", "offset": 100, "limit": 50}'
    },
    {
        names: ['readslice'],
        scope: '读取文件的指定行范围',
        description: '按行号范围读取文本文件片段。适合大文件中只关心特定行的情况。',
        params: [
            { name: 'file_path', type: '字符串', required: true, description: '文件路径（必填）' },
            { name: 'offset', type: '数字', required: true, description: '起始行号（1-based，必填）' },
            { name: 'limit', type: '数字', required: true, description: '读取行数（必填）' }
        ],
        usage: '{"file_path": "big.log", "offset": 1000, "limit": 50}'
    },
    {
        names: ['write_file', 'save'],
        scope: '保存文件内容到本地',
        description: '将内容写入文件。已存在文件会先备份快照。',
        params: [
            { name: 'file_path', type: '字符串', required: true, description: '保存路径（必填）' },
            { name: 'content', type: '字符串', required: false, description: '文件内容（也可放 body）' }
        ],
        usage: '{"file_path": "src/utils.js", "content": "function hello() {\\n  console.log(\\"world\\");\\n}"}'
    },
    {
        names: ['edit_file', 'edit'],
        scope: '编辑文件（查找替换）',
        description: '在文件中查找 old_string 并替换为 new_string。编辑前自动备份快照。',
        params: [
            { name: 'file_path', type: '字符串', required: true, description: '文件路径（必填）' },
            { name: 'old_string', type: '字符串', required: false, description: '要查找的原文（精确匹配，要求唯一）' },
            { name: 'new_string', type: '字符串', required: false, description: '替换内容' },
            { name: 'replace_all', type: '布尔', required: false, description: '替换所有匹配' }
        ],
        usage: '{"file_path": "config.js", "old_string": "const port = 3000", "new_string": "const port = 8080"}'
    },
    {
        names: ['exec'],
        scope: '执行系统命令',
        description: '执行 shell 命令并返回输出。危险命令需用户确认。',
        params: [
            { name: 'cmd', type: '字符串', required: true, description: '要执行的命令（必填）' },
            { name: 'timeout', type: '数字', required: false, description: '超时毫秒（默认 30000）' }
        ],
        usage: '{"cmd": "git status", "timeout": 10000}'
    },
    {
        names: ['list', 'ls'],
        scope: '列出目录内容',
        description: '列出指定目录的文件和子目录。',
        params: [
            { name: 'path', type: '字符串', required: true, description: '目录路径（必填）' },
            { name: 'depth', type: '数字', required: false, description: '递归深度（默认 1）' }
        ],
        usage: '{"path": "src", "depth": 2}'
    },
    {
        names: ['grep', 'findstr'],
        scope: '搜索文件内容',
        description: '在指定目录中搜索文本模式。',
        params: [
            { name: 'pattern', type: '字符串', required: true, description: '搜索模式（正则，必填）' },
            { name: 'path', type: '字符串', required: false, description: '搜索路径（默认当前目录）' },
            { name: 'include', type: '字符串', required: false, description: '文件名 glob（如 *.js）' }
        ],
        usage: '{"pattern": "TODO", "path": "src", "include": "*.js"}'
    },
    {
        names: ['glob'],
        scope: '按文件名模式查找文件',
        description: '用 glob 模式查找文件路径。',
        params: [
            { name: 'pattern', type: '字符串', required: true, description: 'glob 模式（如 **/*.js，必填）' },
            { name: 'path', type: '字符串', required: false, description: '搜索根目录' }
        ],
        usage: '{"pattern": "**/*.test.js", "path": "src"}'
    },
    {
        names: ['info'],
        scope: '获取文件信息',
        description: '返回文件大小、修改时间等元信息。',
        params: [
            { name: 'path', type: '字符串', required: true, description: '文件路径（必填）' }
        ],
        usage: '{"path": "package.json"}'
    },
    {
        names: ['exists'],
        scope: '检查文件/目录是否存在',
        description: '返回文件或目录是否存在。',
        params: [
            { name: 'path', type: '字符串', required: true, description: '路径（必填）' }
        ],
        usage: '{"path": "src/config.js"}'
    },
    {
        names: ['delete'],
        scope: '删除文件或目录',
        description: '删除文件或目录。危险操作，需用户确认。',
        params: [
            { name: 'path', type: '字符串', required: true, description: '要删除的路径（必填）' }
        ],
        usage: '{"path": "tmp/cache.log"}'
    },
    {
        names: ['mkdir'],
        scope: '创建目录',
        description: '递归创建目录。',
        params: [
            { name: 'path', type: '字符串', required: true, description: '目录路径（必填）' }
        ],
        usage: '{"path": "src/utils/helpers"}'
    },
    {
        names: ['web_search'],
        scope: '搜索网页',
        description: '用搜索引擎搜索关键词。',
        params: [
            { name: 'query', type: '字符串', required: true, description: '搜索关键词（必填）' }
        ],
        usage: '{"query": "Node.js stream API"}'
    },
    {
        names: ['webfetch', 'web_fetch'],
        scope: '获取网页内容',
        description: '抓取 URL 内容并返回。',
        params: [
            { name: 'url', type: '字符串', required: true, description: 'URL（必填）' }
        ],
        usage: '{"url": "https://nodejs.org/api/stream.html"}'
    },
    {
        names: ['memory_append'],
        scope: '追加持久化记忆',
        description: '将内容存入长期记忆，跨会话保留。',
        params: [
            { name: 'content', type: '字符串', required: true, description: '记忆内容（必填）' },
            { name: 'scope', type: '字符串', required: false, description: 'global 或 project' }
        ],
        usage: '{"content": "项目用 Vue3 + Vite", "scope": "project"}'
    },
    {
        names: ['memory_read'],
        scope: '读取持久化记忆',
        description: '返回所有长期记忆。',
        params: [],
        usage: '{}'
    },
    {
        names: ['git_checkpoint'],
        scope: 'Git 自动提交',
        description: '将当前改动自动提交到 git。',
        params: [
            { name: 'message', type: '字符串', required: false, description: '提交信息' }
        ],
        usage: '{"message": "WIP: refactor API"}'
    },
    {
        names: ['git_worktree'],
        scope: 'Git Worktree 隔离',
        description: '创建/列出/清理 Git Worktree。',
        params: [
            { name: 'action', type: '字符串', required: true, description: 'create | list | cleanup（必填）' },
            { name: 'branch', type: '字符串', required: false, description: '分支名' },
            { name: 'base', type: '字符串', required: false, description: '基于哪个分支' }
        ],
        usage: '{"action": "create", "branch": "fix-bug", "base": "main"}'
    },
    {
        names: ['parallel_edit'],
        scope: '并行编辑多个文件',
        description: '一次性对 2-12 个文件各发一条 edit 指令，并行执行。',
        params: [
            { name: 'files', type: '数组', required: true, description: '文件编辑任务数组，每项 {path, find, replace}（必填）' },
            { name: 'contract', type: '字符串', required: false, description: '跨文件不变量描述' }
        ],
        usage: '{"files": [{"path": "a.js", "find": "foo", "replace": "bar"}, {"path": "b.js", "find": "foo", "replace": "bar"}]}'
    },
    {
        names: ['find_references'],
        scope: '查找符号引用',
        description: '在项目中搜索函数名/变量名/类名的所有引用位置。',
        params: [
            { name: 'symbol', type: '字符串', required: true, description: '符号名（必填）' },
            { name: 'path', type: '字符串', required: false, description: '搜索路径' }
        ],
        usage: '{"symbol": "myFunction", "path": "src"}'
    },
    {
        names: ['list_symbols'],
        scope: '列出文件中的符号',
        description: '解析源文件中的函数/类/变量定义。',
        params: [
            { name: 'path', type: '字符串', required: true, description: '文件路径（必填）' }
        ],
        usage: '{"path": "src/main.js"}'
    }
];

function generateAllDocs() {
    var out = '';
    for (var ti = 0; ti < TOOL_DOCS.length; ti++) {
        var t = TOOL_DOCS[ti];
        out += '### `' + t.names[0] + '`\n';
        if (t.names.length > 1) {
            out += '> 别名: ' + t.names.slice(1).map(function(n) { return '`' + n + '`'; }).join(', ') + '\n\n';
        }
        out += '\n**使用范围**: ' + t.scope + '\n\n';
        out += '**功能说明**: ' + t.description + '\n\n';
        if (t.params && t.params.length > 0) {
            out += '**参数**:\n\n';
            for (var pi = 0; pi < t.params.length; pi++) {
                var p = t.params[pi];
                out += '- `' + p.name + '` (' + (p.type || '字符串') + ')' + (p.required ? ' [必填]' : '') + ': ' + p.description + '\n';
            }
            out += '\n';
        } else {
            out += '**参数**: 无\n\n';
        }
        out += '**示例**: `' + (t.usage || '{}') + '`\n\n---\n\n';
    }
    return out;
}

module.exports = { generateAllDocs: generateAllDocs, TOOL_DOCS: TOOL_DOCS };
