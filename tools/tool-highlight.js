// tool-highlight.js — 简单语法高亮器（AtomCode highlight_block 等效）
// 根据代码块语言标识应用 ANSI 颜色，无需外部依赖
;(function() {
    if (window.__dsagent_tools && window.__dsagent_tools._highlight_registered) return;

    var C = {
        kw: '\x1b[38;5;99m',    // 紫色 — 关键字
        str: '\x1b[38;5;41m',   // 绿色 — 字符串
        num: '\x1b[38;5;221m',  // 黄色 — 数字
        cmt: '\x1b[38;5;245m',  // 灰色 — 注释
        fn:  '\x1b[38;5;75m',   // 蓝色 — 函数
        tag: '\x1b[38;5;170m',  // 紫红 — HTML 标签
        attr:'\x1b[38;5;81m',   // 亮蓝 — HTML 属性
        op:  '\x1b[38;5;209m',  // 橙色 — 运算符
        pre: '\x1b[38;5;186m',  // 浅黄 — 预处理
        typ: '\x1b[38;5;117m',  // 淡蓝 — 类型
        r:   '\x1b[0m'          // reset
    };

    // 语言匹配模式
    var LANG_PATTERNS = {
        js: { keywords: /\b(function|const|let|var|if|else|for|while|do|switch|case|break|return|import|export|from|async|await|class|new|this|try|catch|throw|typeof|instanceof|in|of|yield|module|require|true|false|null|undefined)\b/g },
        ts: { keywords: /\b(function|const|let|var|if|else|for|while|do|switch|case|break|return|import|export|from|async|await|class|new|this|try|catch|throw|typeof|instanceof|interface|type|enum|implements|extends|public|private|protected|readonly|static|abstract|as|in|of|yield|module|require|true|false|null|undefined|any|void|never|unknown)\b/g },
        py: { keywords: /\b(def|class|if|elif|else|for|while|try|except|finally|with|as|import|from|return|yield|raise|pass|break|continue|lambda|self|True|False|None|and|or|not|is|in|async|await|print|range|len|type|super)\b/g },
        rs: { keywords: /\b(fn|let|mut|if|else|for|while|loop|match|return|struct|enum|impl|trait|pub|use|mod|crate|super|self|async|await|true|false|Some|None|Ok|Err|unsafe|ref|move|where|as|in|type|const|static|dyn|box)\b/g },
        go: { keywords: /\b(func|if|else|for|range|switch|case|return|import|package|type|struct|interface|map|chan|go|defer|select|var|const|nil|true|false|make|new|append|len|cap)\b/g },
        bash: { keywords: /\b(if|then|else|elif|fi|for|while|do|done|case|esac|function|return|export|local|source|echo|exit|true|false|set|unset|shift)\b/g },
        java: { keywords: /\b(public|private|protected|static|final|class|interface|extends|implements|import|package|void|return|if|else|for|while|do|try|catch|throw|throws|new|this|super|true|false|null|abstract|synchronized|volatile|transient|native|strictfp)\b/g },
    };

    function highlightBlock(code, lang) {
        lang = (lang || '').toLowerCase().replace(/^.*[\\\/]/, '');
        if (lang === 'javascript' || lang === 'js' || lang === 'mjs' || lang === 'cjs') return highlightJS(code);
        if (lang === 'typescript' || lang === 'ts' || lang === 'tsx') return highlightJS(code);
        if (lang === 'python' || lang === 'py' || lang === 'python3') return highlightGeneric(code, 'py');
        if (lang === 'rust' || lang === 'rs') return highlightGeneric(code, 'rs');
        if (lang === 'go' || lang === 'golang') return highlightGeneric(code, 'go');
        if (lang === 'bash' || lang === 'sh' || lang === 'shell' || lang === 'zsh') return highlightGeneric(code, 'bash');
        if (lang === 'java') return highlightGeneric(code, 'java');
        if (lang === 'html' || lang === 'htm' || lang === 'xml' || lang === 'svg') return highlightHTML(code);
        if (lang === 'json') return highlightJSON(code);
        if (lang === 'css' || lang === 'scss' || lang === 'less') return highlightCSS(code);
        if (lang === 'sql') return highlightGeneric(code, 'js');
        // 未知语言：只做注释着色
        return highlightGeneric(code, null);
    }

    function highlightGeneric(code, langId) {
        var lines = code.split('\n');
        var kw = langId && LANG_PATTERNS[langId] ? LANG_PATTERNS[langId].keywords : null;
        return lines.map(function(line) {
            // 注释
            line = line.replace(/(\/\/.*)/g, C.cmt + '$1' + C.r);
            line = line.replace(/(#.*)/g, C.cmt + '$1' + C.r);
            // 字符串
            line = line.replace(/(['"`])(?:(?!\1|\\).|\\.)*\1/g, C.str + '$&' + C.r);
            // 数字
            line = line.replace(/\b(\d+(\.\d+)?)\b/g, C.num + '$1' + C.r);
            // 关键字
            if (kw) {
                line = line.replace(kw, C.kw + '$&' + C.r);
                // 二次替换以修复关键字可能被上一步的字符串色覆盖
                line = line.replace(new RegExp(C.str + '.*?' + C.r, 'g'), function(m) { return m; }); // preserve strings
            }
            return line;
        }).join('\n');
    }

    function highlightJS(code) {
        return highlightGeneric(code, 'js');
    }

    function highlightJSON(code) {
        var lines = code.split('\n');
        return lines.map(function(line) {
            // 字符串键和值
            line = line.replace(/(["'])(?:(?!\1|\\).|\\.)*\1/g, C.str + '$&' + C.r);
            // 数字
            line = line.replace(/\b(\d+(\.\d+)?)\b/g, C.num + '$1' + C.r);
            // 关键字
            line = line.replace(/\b(true|false|null)\b/g, C.kw + '$&' + C.r);
            return line;
        }).join('\n');
    }

    function highlightHTML(code) {
        var lines = code.split('\n');
        return lines.map(function(line) {
            // 注释
            line = line.replace(/(<!--[\s\S]*?-->)/g, C.cmt + '$1' + C.r);
            // 标签
            line = line.replace(/(<\/?)(\w+)([^>]*)(\/?>)/g, function(m, open, tag, attrs, close) {
                return C.tag + open + tag + C.r + highlightHTMLAttrs(attrs) + C.tag + close + C.r;
            });
            // 字符串
            line = line.replace(/(['"`])(?:(?!\1|\\).|\\.)*\1/g, C.str + '$&' + C.r);
            return line;
        }).join('\n');
    }

    function highlightHTMLAttrs(attrs) {
        return attrs.replace(/(\w+)\s*=\s*(['"][^'"]*['"])/g, C.attr + '$1' + C.r + '=' + C.str + '$2' + C.r);
    }

    function highlightCSS(code) {
        var lines = code.split('\n');
        return lines.map(function(line) {
            line = line.replace(/(\/\*[\s\S]*?\*\/)/g, C.cmt + '$1' + C.r);
            line = line.replace(/(['"`])(?:(?!\1|\\).|\\.)*\1/g, C.str + '$&' + C.r);
            line = line.replace(/([\w-]+)\s*:/g, C.attr + '$1' + C.r + ':');
            return line;
        }).join('\n');
    }

    // 通过工具系统注册（供 CLI TUI 的 renderMdLine 调用）
    if (window.__dsagent_tools) {
        window.__dsagent_tools.register({
            name: ['highlight', 'hl'],
            scope: '语法高亮（JS/Python/Rust/Go/HTML/JSON 等）',
            description: '对代码块应用语法着色，返回含 ANSI 颜色的文本。语言自动检测。',
            params: [
                { name: 'code', type: '字符串', required: true, description: '要着色的代码文本' },
                { name: 'lang', type: '字符串', required: false, description: '语言标识（js/py/rs/go/html/json 等）' }
            ],
            handler: async function(params) {
                var makeResult = window.__dsagent_tools.makeResult;
                var code = params.code || '';
                var lang = params.lang || '';
                if (!code) return makeResult(false, null, 'Missing code');
                return makeResult(true, highlightBlock(code, lang));
            }
        });
    }

    // 导出给 CLI TUI 使用
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = { highlightBlock: highlightBlock };
    }

    window.__dsagent_tools._highlight_registered = true;
})();
