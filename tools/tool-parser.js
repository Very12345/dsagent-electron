// Tool Parser - 支持 <tool:xxx>/<message> XML 标签格式 和 JSON 字段格式
// XML: <tool:xxx>JSON内容</tool:xxx>、<message>内容</message>
// JSON: {"tool":"xxx","params":{...}}、{"message":"内容"}
// 两种格式同时支持，JSON 格式优先检测（避免 Qwen 页面将 <...> 渲染为 HTML）
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

    // 检查是否 <message> 行首标签（更宽松：不再要求 indexOf('</message>') === -1）
    function isMessageStart(line) {
        var trimmed = line.trim();
        if (trimmed === '<message>') return true;
        if (trimmed.startsWith('<message>')) return true;
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
            var trimmed = line.trim();

            // 0. JSON 格式检测（避免 Qwen 页面将 <...> 渲染为 HTML，优先走 JSON）
            // 支持格式：{"message":"内容"}、{"tool":"name","params":{...}}
            // 支持跨行 JSON（剪贴板复制会将 \n 变成真实换行）
            if (trimmed.startsWith('{')) {
                var jsonStr = trimmed;
                var jsonLine = i;
                // 如果当前行不以 } 结尾，继续读后续行直到找到 }
                if (!trimmed.endsWith('}')) {
                    var braceDepth = 1;
                    for (var ji = 0; ji < jsonStr.length; ji++) {
                        if (jsonStr[ji] === '{') braceDepth++;
                        else if (jsonStr[ji] === '}') braceDepth--;
                    }
                    while (braceDepth > 0 && jsonLine + 1 < lines.length) {
                        jsonLine++;
                        var nextLine = lines[jsonLine];
                        for (var ji2 = 0; ji2 < nextLine.length; ji2++) {
                            if (nextLine[ji2] === '{') braceDepth++;
                            else if (nextLine[ji2] === '}') braceDepth--;
                        }
                        jsonStr += '\n' + nextLine;
                    }
                }
                try {
                    var jsonObj = JSON.parse(jsonStr);
                    if (jsonObj.message !== undefined && typeof jsonObj.message === 'string') {
                        // {"message": "content"}
                        var msgContent = jsonObj.message.trim();
                        if (msgContent) {
                            segments.push({ type: 'text', content: msgContent });
                        }
                        i = jsonLine + 1;
                        continue;
                    }
                    if (jsonObj.tool !== undefined && typeof jsonObj.tool === 'string') {
                        // {"tool": "name", "params": {...}}
                        var toolName = jsonObj.tool;
                        var toolParams = jsonObj.params !== undefined ? JSON.stringify(jsonObj.params) : '';
                        if (isSupportedLang(toolName)) {
                            segments.push({ type: 'tool-call', lang: toolName, content: toolParams });
                        } else {
                            errors.push('工具 "' + toolName + '" 未注册，可用工具: ' + (window.__dsagent_tools ? window.__dsagent_tools.getAllLangs().join(', ') : 'unknown'));
                            segments.push({ type: 'text', content: trimmed });
                        }
                        i++;
                        continue;
                    }
                } catch(e) {
                    // JSON 解析失败，继续尝试 XML 匹配
                }
            }

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

        // 7. 兜底：如果完全没有找到 segments，将全部非空文本作为一个 text segment
        // （解决 AI 回复纯文本/未包裹格式时被丢弃的问题）
        if (segments.length === 0) {
            var allLines = [];
            for (var li = 0; li < lines.length; li++) {
                var tl = lines[li].trim();
                if (tl && !tl.startsWith('<tool:') && !tl.startsWith('</tool:') && !tl.startsWith('<message>') && !tl.startsWith('</message>') && !tl.startsWith('<functioncall>') && !tl.startsWith('</functioncall>')) {
                    allLines.push(tl);
                }
            }
            if (allLines.length > 0) {
                segments.push({ type: 'text', content: allLines.join('\n') });
            }
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
        var inCodeBlock = false;

        while (i < lines.length) {
            var line = lines[i];
            var trimmed = line.trim();

            // 检测代码块边界（``` 或 ~~~），跳过其中的示例代码
            if (/^```/.test(trimmed) || /^~~~/.test(trimmed)) {
                inCodeBlock = !inCodeBlock;
                i++;
                continue;
            }
            if (inCodeBlock) { i++; continue; }

            // 0. JSON 格式检测（{"tool":"name","params":{...}}），支持跨行
            if (trimmed.startsWith('{')) {
                // 跨行 JSON 拼接
                var jsonStr = trimmed;
                var jsonLine = i;
                if (!trimmed.endsWith('}')) {
                    var braceDepth = 1;
                    for (var ji = 0; ji < jsonStr.length; ji++) {
                        if (jsonStr[ji] === '{') braceDepth++;
                        else if (jsonStr[ji] === '}') braceDepth--;
                    }
                    while (braceDepth > 0 && jsonLine + 1 < lines.length) {
                        jsonLine++;
                        var nextLine = lines[jsonLine];
                        for (var ji2 = 0; ji2 < nextLine.length; ji2++) {
                            if (nextLine[ji2] === '{') braceDepth++;
                            else if (nextLine[ji2] === '}') braceDepth--;
                        }
                        jsonStr += '\n' + nextLine;
                    }
                }
                try {
                    var jsonObj = JSON.parse(jsonStr);
                    if (jsonObj.tool !== undefined && typeof jsonObj.tool === 'string') {
                        var toolName = jsonObj.tool;
                        var toolParams = jsonObj.params !== undefined ? JSON.stringify(jsonObj.params) : '';
                        if (toolParams) {
                            var parseRes = parseToolContent(toolName, toolParams);
                            if (parseRes.ok) {
                                commands.push({ lang: toolName, content: toolParams });
                            } else {
                                errors.push(parseRes.error);
                            }
                        }
                        i++;
                        continue;
                    }
                } catch(e) {
                    // JSON 解析失败，继续尝试 XML
                }
            }

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

    // ==================== P1: JSON 修复（5层修复链） ====================
    // 参考 atomcode 的 json_repair.rs 设计
    // 处理：Windows 路径误转义、trailing comma、unquoted key、markdown fence、单引号

    // 第0层：Windows 路径预逃逸
    // 检测 "D:\test\foo.py" 中的 \t/\f 等，防止它们被 JSON.parse 解码
    function preEscapeWindowsPaths(str) {
        return str.replace(/"([A-Za-z]:[^"]*)"/g, function(match, path) {
            if (!path) return match;
            // 只处理包含反斜杠的路径
            if (path.indexOf('\\') < 0) return match;
            // 只处理第一个字符是字母且第二个字符是冒号的（盘符）
            var escaped = path.replace(/\\([tbnrf])/g, '\\\\$1');
            return '"' + escaped + '"';
        });
    }

    // 第2层：通用 JSON 修复
    function repairJson(str) {
        if (!str || str.trim() === '') return '';
        var s = str.trim();

        // 移除 Markdown 代码围栏
        s = s.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '');

        // 替换单引号为双引号（但保留字符串内的单引号）
        // 简单做法：将键和字符串值外的单引号替换
        s = s.replace(/'(true|false|null|\d+)'/g, '$1'); // 布尔/数字的单引号
        s = s.replace(/'([^']*?)'\s*:/g, '"$1":'); // key 的单引号
        s = s.replace(/:\s*'([^']*?)'/g, function(m, content) {
            // 如果内容包含双引号则不处理
            if (content.indexOf('"') >= 0) return m;
            return ': "' + content.replace(/"/g, '\\"') + '"';
        });

        // 补全未加引号的 key（只补简单字母数字 key）
        s = s.replace(/([{,]\s*)([a-zA-Z_$][a-zA-Z0-9_$]*)\s*:/g, '$1"$2":');

        // 移除 trailing comma
        s = s.replace(/,\s*([}\]])/g, '$1');
        // 修正连续的逗号
        s = s.replace(/,+/g, ',');
        // 移除对象/数组尾部的多余点
        s = s.replace(/\.\s*([}\]])/g, '$1');

        return s;
    }

    // 第4层：兜底 Key-Value 提取（当 JSON 完全无法修复时）
    function extractJsonFields(str) {
        if (!str) return {};
        var result = {};
        // 匹配 key="value" 或 key='value' 或 key=value（无空格的值）
        var kvRegex = /(\w+)\s*=\s*(?:"([^"]*)"|'([^']*)'|(\S+?))(?:\s|$)/g;
        var match;
        while ((match = kvRegex.exec(str)) !== null) {
            var val = match[2] !== undefined ? match[2] : (match[3] !== undefined ? match[3] : match[4]);
            if (val !== undefined) result[match[1]] = val;
        }
        return result;
    }

    // 主修复函数：5层修复链
    function repairToolArgs(toolName, args) {
        if (!args || args.trim() === '') return args;

        // 第0层：Windows 路径预逃移
        var pre = preEscapeWindowsPaths(args);

        // 第1层：快速路径 — 已经是合法 JSON
        try { JSON.parse(pre); return pre; } catch(e) {}

        // 第2层：通用 JSON 修复
        var repaired = repairJson(pre);
        try { JSON.parse(repaired); return repaired; } catch(e) {}

        // 第3层：专属修复 — edit_file 包含源代码，引号/换行可能未转义
        if (toolName === 'edit' || toolName === 'edit_file') {
            // 尝试将参数按必填字段重组
            var fields = extractJsonFields(repaired || pre);
            if (fields.file || fields.file_path || fields.old_string) {
                try {
                    var rebuilt = {};
                    rebuilt.file = fields.file || fields.file_path || '';
                    rebuilt.old_string = fields.old_string || '';
                    rebuilt.new_string = fields.new_string || '';
                    if (rebuilt.file && rebuilt.old_string) {
                        return JSON.stringify(rebuilt);
                    }
                } catch(e) {}
            }
        }

        // 第4层：兜底 — Key-Value 提取
        var extracted = extractJsonFields(repaired || pre);
        var keys = Object.keys(extracted);
        if (keys.length > 0) {
            // 至少提取到了有效字段，尝试组装为 JSON
            try { return JSON.stringify(extracted); } catch(e) {}
        }

        // 全部失败，返回原值
        return args;
    }

    // 导出
    window.__dsagent_repairToolArgs = repairToolArgs;
    window.__dsagent_repairJson = repairJson;
    window.__dsagent_parseCommands = parseCommandsFromMarkdown;
    window.__dsagent_parseSegments = parseSegmentsFromMarkdown;
    window.__dsagent_extractTool = extractToolFromJson;
})();
