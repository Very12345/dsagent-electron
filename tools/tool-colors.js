// 工具颜色映射单一来源（CLI 终端 ANSI 色 + agentview CSS hex 色同源）
// 新增工具只需在此添加一项，CLI 和 agentview 自动同步
//   ansi: CLI 终端颜色名（对应 bin/dsagent-cli.js 的 C.green/C.yellow/...）
//   hex:  agentview CSS 颜色值
;(function (root, factory) {
    if (typeof module === 'object' && module.exports) {
        module.exports = factory();
    } else {
        root.TOOL_COLORS = factory();
    }
}(typeof self !== 'undefined' ? self : this, function () {
    // ANSI 色名 → CLI 的 C 对象键（bin/dsagent-cli.js 定义）
    // 这些是终端标准色，CLI 端用 colorForTool 返回的 ansi 名查 C[ansi]
    return {
        'read':              { ansi: 'green',   hex: '#3fb950' },
        'readfile':          { ansi: 'green',   hex: '#3fb950' },
        'readslice':         { ansi: 'green',   hex: '#3fb950' },
        'subreader':         { ansi: 'green',   hex: '#7ee787' },
        'open':              { ansi: 'green',   hex: '#3fb950' },
        'openfile':          { ansi: 'green',   hex: '#3fb950' },
        'save':              { ansi: 'green',   hex: '#3fb950' },
        'write':             { ansi: 'green',   hex: '#3fb950' },
        'writefile':         { ansi: 'green',   hex: '#3fb950' },
        'edit':              { ansi: 'yellow',  hex: '#d29922' },
        'editfile':          { ansi: 'yellow',  hex: '#d29922' },
        'search':            { ansi: 'yellow',  hex: '#d29922' },
        'search-replace':    { ansi: 'yellow',  hex: '#d29922' },
        'delete':            { ansi: 'red',     hex: '#f85149' },
        'break':             { ansi: 'red',     hex: '#f85149' },
        'exec':              { ansi: 'blue',    hex: '#58a6ff' },
        'cmd':               { ansi: 'blue',    hex: '#58a6ff' },
        'term':              { ansi: 'blue',    hex: '#58a6ff' },
        'bash':              { ansi: 'blue',    hex: '#58a6ff' },
        'shell':             { ansi: 'blue',    hex: '#58a6ff' },
        'exists':            { ansi: 'blue',    hex: '#58a6ff' },
        'mkdir':             { ansi: 'blue',    hex: '#58a6ff' },
        'change-dir':        { ansi: 'blue',    hex: '#58a6ff' },
        'list':              { ansi: 'gray',    hex: '#8b949e' },
        'list-directory':    { ansi: 'gray',    hex: '#8b949e' },
        'info':              { ansi: 'gray',    hex: '#8b949e' },
        'system':            { ansi: 'gray',    hex: '#8b949e' },
        'todo':              { ansi: 'gray',    hex: '#8b949e' },
        'glob':              { ansi: 'gray',    hex: '#8b949e' },
        'help':              { ansi: 'magenta', hex: '#bc8cff' },
        'skill':             { ansi: 'magenta', hex: '#bc8cff' },
        'plan':              { ansi: 'magenta', hex: '#bc8cff' },
        'use-skill':         { ansi: 'magenta', hex: '#bc8cff' },
        'local-skill-step':  { ansi: 'magenta', hex: '#bc8cff' },
        'skill-step':        { ansi: 'magenta', hex: '#bc8cff' },
        'interval':          { ansi: 'cyan',    hex: '#79c0ff' },
        'webfetch':          { ansi: 'cyan',    hex: '#79c0ff' },
        'web-fetch':         { ansi: 'cyan',    hex: '#79c0ff' },
        'websearch':         { ansi: 'cyan',    hex: '#79c0ff' },
        'web-search':        { ansi: 'cyan',    hex: '#79c0ff' },
        'findstr':           { ansi: 'cyan',    hex: '#79c0ff' },
        'grep':              { ansi: 'cyan',    hex: '#79c0ff' },
        'qwen':              { ansi: 'magenta', hex: '#f778ba' },
        'vision':            { ansi: 'magenta', hex: '#f778ba' },
        'draw':              { ansi: 'magenta', hex: '#f778ba' },
        'ppt':               { ansi: 'magenta', hex: '#f778ba' },
        'mcp':               { ansi: 'yellow',  hex: '#ffa657' },
        'mcp-list':          { ansi: 'yellow',  hex: '#ffa657' },
        'mcp-init':          { ansi: 'yellow',  hex: '#ffa657' },
        'form':              { ansi: 'yellow',  hex: '#f0883e' },
        'winapi':            { ansi: 'yellow',  hex: '#e3b341' },
        'menubar':           { ansi: 'gray',    hex: '#8b949e' },
        'parser':            { ansi: 'gray',    hex: '#8b949e' },
        'dsa':               { ansi: 'blue',    hex: '#58a6ff' }
    };
}));
