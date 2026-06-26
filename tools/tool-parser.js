// Tool Parser - 支持 <tool:xxx> 和 <message> 标签格式
// <tool:xxx> 标签开始必须位于行首（或整行），标签结束必须位于行首
// 支持多行和单行格式
// 标签外的内容被忽略
// JSON 解析错误时会收集错误信息，由调用方反馈给 AI
;(function() {
    'use strict';

    if (window.__dsagent_toolParser) return;
    window.__dsagent_toolParser = true;

    // 从 JSON 内容中提取 tool 字段名（旧格式兼容）
    function extractToolFromJson(content) {
        if (!content) return null;
        try {
            var parsed = JSON.parse(content);
            var tool = parsed.tool || null;
            if (!tool) return null;
            if (window.__dsagent_tools && window.__dsagent_tools.isSupported) {
                if (window.__dsagent_tools.isSupported(tool)) return tool;
            }
            return null;
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

    // ========== 工具标签解析 ==========

    // 检查是否 <tool:xxx> 行首标签
    function matchToolTag(line) {
        var trimmed = line.trim();
        var m = trimmed.match(/^<tool:([a-zA-Z0-9_-]+)>$/);
        if (m) return { matched: true, toolName: m[1] };
        return { matched: false, toolName: '' };
    }

    // 检查是否 </tool:xxx> 行首标签
    function matchToolEndTag(line) {
        return line.trim().match(/^<\/tool:[a-zA-Z0-9_-]+>$/) !== null;
    }

    // 检查是否 <message> 行首标签（支持 <message>内容同行起始 以及 <message> 单独一行）
    function isMessageStart(line) {
        var trimmed = line.trim();
        if (trimmed === '<message>') return true;
        // 同行 <message>内容...（无同行闭合标签）
        if (trimmed.startsWith('<message>') && trimmed.indexOf('</message>') === -1) return true;
        return false;
    }

    function isMessageEnd(line) {
        return line.trim() === '</message>';
    }

    // 单行 <tool:xxx>JSON</tool:xxx>
    function tryExtractInlineTool(line) {
        var trimmed = line.trim();
        var m = trimmed.match(/^<tool:([a-zA-Z0-9_-]+)>(.*?)<\/tool:\1>$/);
        if (m && m[2].trim()) {
            return { matched: true, toolName: m[1], content: m[2].trim() };
        }
        return { matched: false, toolName: '', content: '' };
    }

    // 单行 <message>内容</message>
    function tryExtractInlineMessage(line) {
        var trimmed = line.trim();
        var m = trimmed.match(/^<message>(.*?)<\/message>$/);
        if (m && m[1].trim()) {
            return { matched: true, content: m[1].trim() };
        }
        return { matched: false, content: '' };
    }

    // 解析工具内容（单层 JSON）
    // 返回 { ok: true, toolName: 'xxx', content: '原始JSON' } 或 { ok: false, error: '...' }
    function parseToolContent(toolName, content) {
        if (!content) {
            return { ok: false, error: '工具 "' + toolName + '" 的内容为空' };
        }
        try {
            var parsed = JSON.parse(content);
            if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
                return { ok: false, error: '工具 "' + toolName + '" 的内容必须是 JSON 对象，当前: ' + content.substring(0, 200) };
            }
            if (!isSupportedLang(toolName)) {
                return { ok: false, error: '工具 "' + toolName + '" 未注册，可用工具: ' + (window.__dsagent_tools ? window.__dsagent_tools.getAllLangs().join(', ') : 'unknown') };
            }
            return { ok: true, toolName: toolName, content: content };
        } catch (e) {
            return { ok: false, error: '工具 "' + toolName + '" JSON 解析错误: ' + e.message + '，内容: ' + content.substring(0, 200) };
        }
    }

    // 提取所有 <message> + <tool:xxx> → segments
    // 返回 { segments: [...], errors: [...] }
    function parseSegmentsNew(markdown) {
        var segments = [];
        var errors = [];
        if (!markdown) return { segments: segments, errors: errors };

        var lines = markdown.split('\n');
        var i = 0;

        while (i < lines.length) {
            var line = lines[i];

            // 1. 多行 <message>（支持 <message>内容同行起始、</message>同行结尾）
            if (isMessageStart(line)) {
                i++;
                var contentLines = [];
                // 如果起始行有同行内容（<message>当前目录...），提取出来
                var trimmedLine = line.trim();
                if (trimmedLine !== '<message>' && trimmedLine.startsWith('<message>')) {
                    contentLines.push(trimmedLine.substring('<message>'.length));
                }
                while (i < lines.length) {
                    var cline = lines[i];
                    // 检查此行是否包含 </message>（可能同行结尾）
                    var endIdx = cline.indexOf('</message>');
                    if (endIdx !== -1) {
                        var before = cline.substring(0, endIdx).trim();
                        if (before) contentLines.push(before);
                        i++; // skip past this line
                        break;
                    }
                    if (isMessageEnd(cline)) {
                        i++; // skip the </message> line
                        break;
                    }
                    contentLines.push(cline);
                    i++;
                }
                var content = contentLines.join('\n').trim();
                if (content) {
                    segments.push({ type: 'text', content: content });
                }
                continue;
            }

            // 2. 多行 <tool:xxx>
            var tagInfo = matchToolTag(line);
            if (tagInfo.matched) {
                i++;
                var contentLines = [];
                while (i < lines.length && !matchToolEndTag(lines[i])) {
                    contentLines.push(lines[i]);
                    i++;
                }
                if (i < lines.length) i++; // skip </tool:xxx>
                var content = contentLines.join('\n').trim();
                if (content) {
                    var parseRes = parseToolContent(tagInfo.toolName, content);
                    if (parseRes.ok) {
                        segments.push({ type: 'tool-call', lang: tagInfo.toolName, content: content });
                    } else {
                        errors.push(parseRes.error);
                        segments.push({ type: 'text', content: '<tool:' + tagInfo.toolName + '> ' + parseRes.error + ' </tool:' + tagInfo.toolName + '>' });
                    }
                }
                continue;
            }

            // 3. 单行 <message>内容</message>
            var inlineMsg = tryExtractInlineMessage(line);
            if (inlineMsg.matched) {
                if (inlineMsg.content) {
                    segments.push({ type: 'text', content: inlineMsg.content });
                }
                i++;
                continue;
            }

            // 4. 单行 <tool:xxx>内容</tool:xxx>
            var inlineTool = tryExtractInlineTool(line);
            if (inlineTool.matched) {
                if (inlineTool.content) {
                    var parseRes = parseToolContent(inlineTool.toolName, inlineTool.content);
                    if (parseRes.ok) {
                        segments.push({ type: 'tool-call', lang: inlineTool.toolName, content: inlineTool.content });
                    } else {
                        errors.push(parseRes.error);
                        segments.push({ type: 'text', content: '<tool:' + inlineTool.toolName + '> ' + parseRes.error + ' </tool:' + inlineTool.toolName + '>' });
                    }
                }
                i++;
                continue;
            }

            // 5. 旧格式 <functioncall> 兼容（仍然检测，但标记为错误）
            if (line.trim() === '<functioncall>') {
                i++;
                var fcLines = [];
                while (i < lines.length && lines[i].trim() !== '</functioncall>') {
                    fcLines.push(lines[i]);
                    i++;
                }
                if (i < lines.length) i++;
                var fcContent = fcLines.join('\n').trim();
                if (fcContent) {
                    // 尝试提取旧格式中的 tool 字段
                    var oldTool = extractToolFromJson(fcContent);
                    if (oldTool) {
                        errors.push('检测到旧格式 <functioncall>，请改用 <tool:' + oldTool + '> 格式');
                    } else {
                        errors.push('检测到旧格式 <functioncall>，请改用 <tool:工具名> 格式');
                    }
                }
                continue;
            }

            // 6. 其他行：忽略（标签外的内容被丢弃）
            i++;
        }

        return { segments: segments, errors: errors };
    }

    // 提取所有 <tool:xxx> → commands
    // 返回 { commands: [...], errors: [...] }
    function parseCommandsNew(markdown) {
        var commands = [];
        var errors = [];
        if (!markdown) return { commands: commands, errors: errors };

        var lines = markdown.split('\n');
        var i = 0;

        while (i < lines.length) {
            var line = lines[i];

            // 1. 多行 <tool:xxx>
            var tagInfo = matchToolTag(line);
            if (tagInfo.matched) {
                i++;
                var contentLines = [];
                while (i < lines.length && !matchToolEndTag(lines[i])) {
                    contentLines.push(lines[i]);
                    i++;
                }
                if (i < lines.length) i++; // skip </tool:xxx>
                var content = contentLines.join('\n').trim();
                if (content) {
                    var parseRes = parseToolContent(tagInfo.toolName, content);
                    if (parseRes.ok) {
                        commands.push({ lang: tagInfo.toolName, content: content });
                    } else {
                        errors.push(parseRes.error);
                    }
                }
                continue;
            }

            // 2. 单行 <tool:xxx>内容</tool:xxx>
            var inlineTool = tryExtractInlineTool(line);
            if (inlineTool.matched) {
                if (inlineTool.content) {
                    var parseRes = parseToolContent(inlineTool.toolName, inlineTool.content);
                    if (parseRes.ok) {
                        commands.push({ lang: inlineTool.toolName, content: inlineTool.content });
                    } else {
                        errors.push(parseRes.error);
                    }
                }
                i++;
                continue;
            }

            // 3. 旧格式 <functioncall> 兼容
            if (line.trim() === '<functioncall>') {
                i++;
                var fcLines = [];
                while (i < lines.length && lines[i].trim() !== '</functioncall>') {
                    fcLines.push(lines[i]);
                    i++;
                }
                if (i < lines.length) i++;
                var fcContent = fcLines.join('\n').trim();
                if (fcContent) {
                    var oldTool = extractToolFromJson(fcContent);
                    if (oldTool) {
                        errors.push('检测到旧格式 <functioncall>，请改用 <tool:' + oldTool + '> 格式');
                    } else {
                        errors.push('检测到旧格式 <functioncall>，请改用 <tool:工具名> 格式');
                    }
                }
                continue;
            }

            // 4. 其他行：忽略
            i++;
        }

        return { commands: commands, errors: errors };
    }

    // ========== 统一入口 ==========

    function parseCommandsFromMarkdown(markdown) {
        return parseCommandsNew(markdown);
    }

    function parseSegmentsFromMarkdown(markdown) {
        return parseSegmentsNew(markdown);
    }

    // 保持旧 API 兼容
    window.__dsagent_parseCommands = parseCommandsFromMarkdown;
    window.__dsagent_parseSegments = parseSegmentsFromMarkdown;
    window.__dsagent_extractTool = extractToolFromJson;
})();
