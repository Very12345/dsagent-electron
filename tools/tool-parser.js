// Tool Parser - 共享指令解析器
// 从 AI 回复中提取 functioncall 和 message 代码块，供 DeepSeek / Qwen / 未来 AI 服务共用
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
            if (tool && tool.indexOf('local-') !== 0) {
                tool = 'local-' + tool;
            }
            return tool;
        } catch(e) {
            return null;
        }
    }

    // 检查 lang 是否为工具系统支持的指令
    function isSupportedLang(lang) {
        if (window.__dsagent_tools && window.__dsagent_tools.isSupported) {
            return window.__dsagent_tools.isSupported(lang);
        }
        return false;
    }

    // 从 markdown 文本中提取所有 functioncall 指令块（跳过 message 块）
    // 返回 [{ lang: 'local-exec', content: '{...}' }, ...]
    function parseCommandsFromMarkdown(markdown) {
        var commands = [];
        // 匹配闭合的代码块，或末尾未闭合的代码块
        var regex = /```(\w[\w-]*)\s*\n([\s\S]*?)```|```(\w[\w-]*)\s*\n([\s\S]+)$/g;
        var match;
        while ((match = regex.exec(markdown)) !== null) {
            var lang = (match[1] || match[3] || '').toLowerCase();
            var content = (match[2] || match[4] || '').trim();
            // 跳过 message 和 skip 标记
            if (lang === 'message' || lang === 'functioncall-skip' || lang === 'local-skip') continue;
            if (lang === 'functioncall' || lang === 'local') {
                var toolName = extractToolFromJson(content);
                if (toolName && isSupportedLang(toolName)) {
                    commands.push({ lang: toolName, content: content });
                }
            } else if (lang.indexOf('functioncall-') === 0) {
                // functioncall-exec → local-exec
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

    // 将 markdown 文本拆分为 segment 数组
    // 只提取 message 和 functioncall 代码块，忽略块外内容
    // [{ type: 'text', content: '...' }, { type: 'tool-call', lang: 'local-exec', content: '{...}' }]
    function parseSegmentsFromMarkdown(markdown) {
        var segments = [];
        // 匹配闭合的代码块，或末尾未闭合的代码块
        var regex = /```(\w[\w-]*)\s*\n([\s\S]*?)```|```(\w[\w-]*)\s*\n([\s\S]+)$/g;
        var match;
        var hasMessageBlock = false;

        while ((match = regex.exec(markdown)) !== null) {
            var lang = (match[1] || match[3] || '').toLowerCase();
            var content = (match[2] || match[4] || '').trim();

            // message 代码块 → 文本段
            if (lang === 'message') {
                if (content) {
                    segments.push({ type: 'text', content: content });
                    hasMessageBlock = true;
                }
                continue;
            }

            // functioncall / local → 工具调用段
            if (lang === 'functioncall' || lang === 'local') {
                var toolName = extractToolFromJson(content);
                if (toolName && isSupportedLang(toolName)) {
                    segments.push({ type: 'tool-call', lang: toolName, content: content });
                }
                continue;
            }

            // functioncall-xxx → 映射到 local-xxx
            if (lang.indexOf('functioncall-') === 0) {
                var mappedLang = 'local-' + lang.substring('functioncall-'.length);
                if (isSupportedLang(mappedLang)) {
                    segments.push({ type: 'tool-call', lang: mappedLang, content: content });
                }
                continue;
            }

            // 直接支持的指令
            if (isSupportedLang(lang)) {
                segments.push({ type: 'tool-call', lang: lang, content: content });
                continue;
            }

            // 跳过 message-skip、functioncall-skip、local-skip 等
            if (lang === 'message-skip' || lang === 'functioncall-skip' || lang === 'local-skip') continue;

            // 其他代码块（如 file、json 等）→ 仅在 message 块内才有意义，单独出现时忽略
        }

        // 向后兼容：如果没有 message 块，将整个文本作为文本段（旧格式兼容）
        if (!hasMessageBlock) {
            var commandsInLegacy = parseCommandsFromMarkdown(markdown);
            if (commandsInLegacy.length > 0 || markdown.trim()) {
                // 提取非代码块文本（同时移除闭合和未闭合的代码块）
                var plainText = markdown.replace(/```(\w[\w-]*)\s*\n[\s\S]*?```|```(\w[\w-]*)\s*\n[\s\S]+$/g, '').trim();
                if (plainText) {
                    // 插入到开头
                    segments.unshift({ type: 'text', content: plainText });
                }
            }
        }

        return segments;
    }

    // 导出到全局
    window.__dsagent_parseCommands = parseCommandsFromMarkdown;
    window.__dsagent_parseSegments = parseSegmentsFromMarkdown;
    window.__dsagent_extractTool = extractToolFromJson;
})();