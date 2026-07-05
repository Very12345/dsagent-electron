// find-references — 查找符号引用（轻量版，正则匹配无 LSP）
// 参考 atomcode find_references 工具设计
// 使用 grep 在项目中搜索指定符号的名称匹配
;(function() {
    if (window.__dsagent_tools && window.__dsagent_tools._find_references_registered) return;

    window.__dsagent_tools.register({
        name: 'find_references',
        scope: '查找指定符号在项目中的引用位置',
        description: '在项目中搜索指定的函数名、变量名、类名等的所有引用位置。' +
            '返回每个匹配的文件路径、行号和所在行内容。默认搜索当前项目目录。',
        params: [
            { name: 'symbol', type: '字符串', default: '—', required: true, description: '要查找的符号名（必填）' },
            { name: 'path', type: '字符串', default: '项目目录', required: false, description: '搜索路径（默认项目根目录）' },
            { name: 'max_results', type: '整数', default: '50', required: false, description: '最多返回结果数（默认50）' }
        ],
        usage: '{"symbol": "myFunction"}\n\n{"symbol": "MyClass", "path": "src/", "max_results": 20}',
        notes: '基于 grep 文本匹配，不依赖 LSP 语言服务器。可能包含注释中的匹配。精确模式搜索完整单词。',
        handler: async function(params) {
            var makeResult = window.__dsagent_tools.makeResult;
            var symbol = (params.symbol || '').trim();
            var searchPath = params.path || '.';
            var maxResults = Math.min(params.max_results || 50, 200);
            if (!symbol) return makeResult(false, null, '缺少 symbol 参数');

            try {
                // 使用 exec 调 grep（跨平台）
                var cmd = process.platform === 'win32'
                    ? 'findstr /s /n /c:"' + symbol.replace(/"/g, '') + '" ' + searchPath + '\\*.{js,jsx,ts,tsx,vue,py,rs,go,java,c,cpp,h,hpp,cs,php,rb,scala,kt,sql,yaml,yml,json,toml,md,html,css} 2>nul'
                    : 'grep -rn -w --include="*.{js,jsx,ts,tsx,vue,py,rs,go,java,c,cpp,h,hpp,cs,php,rb,scala,kt,sql,yaml,yml,json,toml,md,html,css}" "' + symbol.replace(/"/g, '\\"') + '" ' + searchPath + ' 2>/dev/null | head -' + maxResults;
                var res = await window.electronAPI.agentExec(cmd, 30000);
                if (!res || !res.success) return makeResult(false, null, '搜索失败: ' + (res && res.stderr || ''));
                var output = (res.stdout || '').trim();
                if (!output) return makeResult(true, '符号 "' + symbol + '" 未找到引用。');
                var lines = output.split('\n').filter(Boolean);
                if (lines.length > maxResults) lines = lines.slice(0, maxResults);
                var summary = '符号 "' + symbol + '" 的引用 (' + lines.length + ' 处):\n' + lines.join('\n');
                return makeResult(true, summary);
            } catch (e) {
                return makeResult(false, null, 'find_references 错误: ' + (e.message || e));
            }
        }
    });
    window.__dsagent_tools._find_references_registered = true;
})();
