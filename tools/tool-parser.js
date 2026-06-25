// Tool Parser - 共享指令解析器
// 从 AI 回复中提取 <message> 和 <functioncall> 标签，供 DeepSeek / Qwen / 未来 AI 服务共用
// 格式：<message>文本内容</message>  <functioncall>{"tool":"...","params":{...}}</functioncall>
// 兼容旧格式：message: 前缀 / ```message 代码块 / ```functioncall 代码块
;(function() {
    'use strict';

    if (window.__dsagent_toolParser) return;
    window.__dsagent_toolParser = true;

    // 从 JSON 内容中提取 tool 字段名
    function extractToolFromJson(content) {
        if (!content) return null;
        try {
            var parsed = JSON.parse(content);
            var tool = parsed.tool || null;
            if (!tool) return null;
            if (window.__dsagent_tools && window.__dsagent_tools.isSupported) {
                if (window.__dsagent_tools.isSupported(tool)) return tool;
                var withPrefix = 'local-' + tool;
                if (window.__dsagent_tools.isSupported(withPrefix)) return withPrefix;
            }
            if (tool.indexOf('local-') !== 0) {
                tool = 'local-' + tool;
            }
            return tool;
        } catch(e) {
            return null;
        }
    }

    function isSupportedLang(lang) {
        if (window.__dsagent_tools && window.__dsagent_tools.isSupported) {
            return window.__dsagent_tools.isSupported(lang);
        }
        return false;
    }

    // ========== 新格式解析：<message> / <functioncall> 标签 ==========

    function isNewFormat(markdown) {
        return /<message>/.test(markdown) || /<functioncall>/.test(markdown);
    }

    // 提取所有 <functioncall>...</functioncall> → commands
    function parseCommandsNew(markdown) {
        var commands = [];
        var regex = /<functioncall>([\s\S]*?)<\/functioncall>/g;
        var match;
        while ((match = regex.exec(markdown)) !== null) {
            var json = match[1].trim();
            if (json) {
                var toolName = extractToolFromJson(json);
                if (toolName && isSupportedLang(toolName)) {
                    commands.push({ lang: toolName, content: json });
                }
            }
        }
        return commands;
    }

    // 提取所有 <message> + <functioncall> → segments
    function parseSegmentsNew(markdown) {
        var segments = [];
        // 使用全局匹配，按出现顺序提取所有 <message> 和 <functioncall> 标签
        var regex = /<(message|functioncall)>([\s\S]*?)<\/\1>/g;
        var match;
        while ((match = regex.exec(markdown)) !== null) {
            var tag = match[1];
            var content = match[2].trim();
            if (tag === 'message') {
                if (content) {
                    segments.push({ type: 'text', content: content });
                }
            } else if (tag === 'functioncall') {
                if (content) {
                    var toolName = extractToolFromJson(content);
                    if (toolName && isSupportedLang(toolName)) {
                        segments.push({ type: 'tool-call', lang: toolName, content: content });
                    }
                }
            }
        }
        return segments;
    }

    // ========== 旧格式兼容（message: 前缀） ==========

    function isPrefixFormat(markdown) {
        return /^message:/m.test(markdown) || /^functioncall:/m.test(markdown);
    }

    function parseCommandsPrefix(markdown) {
        var commands = [];
        var lines = markdown.split('\n');
        var i = 0;
        while (i < lines.length) {
            var trimmed = lines[i].trim();
            if (/^functioncall:/.test(trimmed)) {
                var lineStart = 0;
                for (var j = 0; j < i; j++) lineStart += lines[j].length + 1;
                var json = extractFunctionCallJson(markdown, lineStart + trimmed.indexOf('functioncall:') + 'functioncall:'.length);
                if (json) {
                    var toolName = extractToolFromJson(json);
                    if (toolName && isSupportedLang(toolName)) {
                        commands.push({ lang: toolName, content: json });
                    }
                }
            }
            i++;
        }
        return commands;
    }

    function extractFunctionCallJson(text, startIndex) {
        var braceStart = text.indexOf('{', startIndex);
        if (braceStart < 0) return null;
        var depth = 0;
        for (var i = braceStart; i < text.length; i++) {
            if (text[i] === '{') depth++;
            else if (text[i] === '}') { depth--; if (depth === 0) return text.substring(braceStart, i + 1); }
        }
        return null;
    }

    function parseSegmentsPrefix(markdown) {
        var segments = [];
        var lines = markdown.split('\n');
        var i = 0;
        while (i < lines.length) {
            var trimmed = lines[i].trim();
            if (/^message:/.test(trimmed)) {
                var msgLines = [];
                while (i < lines.length && /^message:/.test(lines[i].trim())) {
                    msgLines.push(lines[i].trim().substring('message:'.length));
                    i++;
                }
                segments.push({ type: 'text', content: msgLines.join('\n') });
                continue;
            }
            if (/^functioncall:/.test(trimmed)) {
                var lineStart = 0;
                for (var j = 0; j < i; j++) lineStart += lines[j].length + 1;
                var json = extractFunctionCallJson(markdown, lineStart + trimmed.indexOf('functioncall:') + 'functioncall:'.length);
                if (json) {
                    var toolName = extractToolFromJson(json);
                    if (toolName && isSupportedLang(toolName)) {
                        segments.push({ type: 'tool-call', lang: toolName, content: json });
                    }
                }
                i++;
                continue;
            }
            i++;
        }
        return segments;
    }

    // ========== 旧旧格式兼容（``` 代码块） ==========

    function parseCommandsLegacy(markdown) {
        var commands = [];
        var regex = /```(\w[\w-]*)\s*\n([\s\S]*?)```|```(\w[\w-]*)\s*\n([\s\S]+)$/g;
        var match;
        while ((match = regex.exec(markdown)) !== null) {
            var lang = (match[1] || match[3] || '').toLowerCase();
            var content = (match[2] || match[4] || '').trim();
            if (lang === 'message' || lang === 'functioncall-skip' || lang === 'local-skip') continue;
            if (lang === 'functioncall' || lang === 'local') {
                var toolName = extractToolFromJson(content);
                if (toolName && isSupportedLang(toolName)) {
                    commands.push({ lang: toolName, content: content });
                }
            } else if (lang.indexOf('functioncall-') === 0) {
                var mappedLang = 'local-' + lang.substring('functioncall-'.length);
                if (isSupportedLang(mappedLang)) {
                    commands.push({ lang: mappedLang, content: content });
                }
            } else if (isSupportedLang(lang)) {
                commands.push({ lang: lang, content: content });
            }
        }
        return commands;
    }

    function parseSegmentsLegacy(markdown) {
        var segments = [];
        var regex = /```(\w[\w-]*)\s*\n([\s\S]*?)```|```(\w[\w-]*)\s*\n([\s\S]+)$/g;
        var match;
        var hasMessageBlock = false;

        while ((match = regex.exec(markdown)) !== null) {
            var lang = (match[1] || match[3] || '').toLowerCase();
            var content = (match[2] || match[4] || '').trim();

            if (lang === 'message') {
                if (content) {
                    segments.push({ type: 'text', content: content });
                    hasMessageBlock = true;
                }
                continue;
            }

            if (lang === 'functioncall' || lang === 'local') {
                var toolName = extractToolFromJson(content);
                if (toolName && isSupportedLang(toolName)) {
                    segments.push({ type: 'tool-call', lang: toolName, content: content });
                }
                continue;
            }

            if (lang.indexOf('functioncall-') === 0) {
                var mappedLang = 'local-' + lang.substring('functioncall-'.length);
                if (isSupportedLang(mappedLang)) {
                    segments.push({ type: 'tool-call', lang: mappedLang, content: content });
                }
                continue;
            }

            if (isSupportedLang(lang)) {
                segments.push({ type: 'tool-call', lang: lang, content: content });
                continue;
            }

            if (lang === 'message-skip' || lang === 'functioncall-skip' || lang === 'local-skip') continue;
        }

        if (!hasMessageBlock) {
            var commandsInLegacy = parseCommandsLegacy(markdown);
            if (commandsInLegacy.length > 0 || markdown.trim()) {
                var plainText = markdown.replace(/```(\w[\w-]*)\s*\n[\s\S]*?```|```(\w[\w-]*)\s*\n[\s\S]+$/g, '').trim();
                if (plainText) {
                    segments.unshift({ type: 'text', content: plainText });
                }
            }
        }

        return segments;
    }

    // ========== 统一入口：新格式 → 前缀格式 → 代码块格式 ==========

    function parseCommandsFromMarkdown(markdown) {
        if (isNewFormat(markdown)) {
            var cmds = parseCommandsNew(markdown);
            if (cmds.length > 0) return cmds;
        }
        if (isPrefixFormat(markdown)) {
            var cmds2 = parseCommandsPrefix(markdown);
            if (cmds2.length > 0) return cmds2;
        }
        return parseCommandsLegacy(markdown);
    }

    function parseSegmentsFromMarkdown(markdown) {
        if (isNewFormat(markdown)) {
            var segs = parseSegmentsNew(markdown);
            if (segs.length > 0) return segs;
        }
        if (isPrefixFormat(markdown)) {
            var segs2 = parseSegmentsPrefix(markdown);
            if (segs2.length > 0) return segs2;
        }
        return parseSegmentsLegacy(markdown);
    }

    window.__dsagent_parseCommands = parseCommandsFromMarkdown;
    window.__dsagent_parseSegments = parseSegmentsFromMarkdown;
    window.__dsagent_extractTool = extractToolFromJson;
})();