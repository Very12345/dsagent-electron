// tool-loop.js — Core 层工具调用回环主体
// 职责：
//   1. 从 markdown 中解析工具调用（JSON + XML 双格式）
//   2. 通过 execJs 桥接到 inject 层执行工具（execTool op）
//   3. 组装 JSON 反馈供回灌给 AI
//   4. 死循环防护（稳定 transit 退出）
// 使用方式：
//   const { runToolLoop } = require('./tool-loop.js');
//   const result = await runToolLoop(markdown, opts, invokeInjectFn);
//   if (result.toolCalls > 0) { await fillAndSend(result.feedback); }
'use strict';

const { parseDsmlCalls } = require('./src/runtime/deepseek-dsml');

/**
 * 从 markdown 中提取工具调用列表
 * 支持格式：
 *   JSON:  {"tool":"xxx","params":{...}}   — 独立行或跨行
 *   XML:   <tool:xxx>{...}</tool:xxx>      — 多行或单行
 *   XML 旧: <functioncall>{...}</functioncall>
 * @param {string} markdown
 * @returns {{ commands: Array<{tool:string, content:string, format:'json'|'xml'}>, errors: Array<string> }}
 */
function parseToolCalls(markdown) {
    var commands = [];
    var errors = [];
    if (!markdown || typeof markdown !== 'string') return { commands: commands, errors: errors };

    // DeepSeek V4 native tool protocol. Only complete invoke/parameter blocks
    // are accepted; Runtime tool manifests still perform allowlist/schema and
    // approval validation before execution.
    parseDsmlCalls(markdown).forEach(function(call) {
        commands.push({ tool: call.name, content: JSON.stringify(call.arguments || {}), format: 'dsml' });
    });

    // Canonical DSH/WebAgent bridge format. This is also emitted by provider
    // adapters when an OpenAI-compatible gateway returns native tool_calls.
    // Parse it before the generic code-fence skipper below.
    var dshFencePattern = /```+dsh-tool-call\s*\n([\s\S]*?)\n```+/gi;
    var dshFenceMatch;
    while ((dshFenceMatch = dshFencePattern.exec(markdown)) !== null) {
        try {
            var dshCall = JSON.parse(dshFenceMatch[1].trim());
            if (!dshCall || typeof (dshCall.name || dshCall.tool) !== 'string') {
                errors.push('dsh-tool-call 缺少工具名');
                continue;
            }
            var dshArgs = dshCall.arguments !== undefined ? dshCall.arguments : dshCall.params;
            if (dshArgs === undefined) {
                dshArgs = {};
                Object.keys(dshCall).forEach(function(key) {
                    if (['name', 'tool', 'arguments', 'params', 'type', 'id'].indexOf(key) < 0) dshArgs[key] = dshCall[key];
                });
            }
            commands.push({
                tool: dshCall.name || dshCall.tool,
                content: typeof dshArgs === 'string' ? dshArgs : JSON.stringify(dshArgs || {}),
                format: 'dsh'
            });
        } catch (e) {
            errors.push('dsh-tool-call 的 JSON 参数无效');
        }
    }

    // Some DeepSeek webpage turns render a native call on one Markdown line:
    //   **Calling** `read` with `{"file_path":"package.json"}`
    // This is distinct from the older Calling: block below. Parse only an
    // explicit tool name followed by a balanced JSON object.
    var inlineCallingPattern = /(?:^|\n)\s*(?:\*\*)?Calling(?:\*\*)?\s+`?([a-zA-Z0-9_-]+)`?\s+(?:with|using)\s+`?/gi;
    var inlineCallingMatch;
    while ((inlineCallingMatch = inlineCallingPattern.exec(markdown)) !== null) {
        var inlineOpen = markdown.indexOf('{', inlineCallingPattern.lastIndex);
        if (inlineOpen < 0 || inlineOpen - inlineCallingPattern.lastIndex > 64) continue;
        var inlineDepth = 0;
        var inlineString = false;
        var inlineEscaped = false;
        var inlineClose = -1;
        for (var ii = inlineOpen; ii < Math.min(markdown.length, inlineOpen + 4096); ii++) {
            var inlineChar = markdown[ii];
            if (inlineString) {
                if (inlineEscaped) inlineEscaped = false;
                else if (inlineChar === '\\') inlineEscaped = true;
                else if (inlineChar === '"') inlineString = false;
                continue;
            }
            if (inlineChar === '"') inlineString = true;
            else if (inlineChar === '{') inlineDepth++;
            else if (inlineChar === '}' && --inlineDepth === 0) { inlineClose = ii + 1; break; }
        }
        if (inlineClose < 0) continue;
        try {
            var inlineArgs = JSON.parse(markdown.slice(inlineOpen, inlineClose));
            commands.push({ tool: inlineCallingMatch[1], content: JSON.stringify(inlineArgs), format: 'calling' });
        } catch (e) {
            errors.push('Calling ' + inlineCallingMatch[1] + ' with JSON arguments is invalid');
        }
    }

    // DeepSeek's current web UI also renders native tool calls as:
    //   Calling: list_directory
    //   ```text
    //   {"path":"."}
    //   ```
    // The toolbar labels ("text / 复制 / 下载") can also be mixed into the
    // extracted DOM text. Parse this protocol before skipping code fences.
    var callingPattern = /(?:^|\n|[：:]\s+)\s*(?:\*\*)?Calling:(?:\*\*)?\s*`?([a-zA-Z0-9_-]+)`?[^\n]*(?:\n|$)/g;
    var callingMatch;
    while ((callingMatch = callingPattern.exec(markdown)) !== null) {
        var searchStart = callingPattern.lastIndex;
        var nextCalling = markdown.slice(searchStart).search(/\n\s*Calling:\s*[a-zA-Z0-9_-]+/);
        var searchEnd = nextCalling >= 0 ? searchStart + nextCalling : Math.min(markdown.length, searchStart + 4096);
        var open = markdown.indexOf('{', searchStart);
        if (open < 0 || open >= searchEnd) {
            errors.push('Calling: ' + callingMatch[1] + ' 缺少 JSON 参数');
            continue;
        }
        var depth = 0;
        var inString = false;
        var escaped = false;
        var close = -1;
        for (var bi = open; bi < searchEnd; bi++) {
            var ch = markdown[bi];
            if (inString) {
                if (escaped) escaped = false;
                else if (ch === '\\') escaped = true;
                else if (ch === '"') inString = false;
                continue;
            }
            if (ch === '"') inString = true;
            else if (ch === '{') depth++;
            else if (ch === '}' && --depth === 0) { close = bi + 1; break; }
        }
        if (close < 0) {
            errors.push('Calling: ' + callingMatch[1] + ' 的 JSON 参数不完整');
            continue;
        }
        try {
            var callingArgs = JSON.parse(markdown.slice(open, close));
            commands.push({ tool: callingMatch[1], content: JSON.stringify(callingArgs), format: 'calling' });
        } catch (e) {
            errors.push('Calling: ' + callingMatch[1] + ' 的 JSON 参数无效');
        }
    }

    // A second DeepSeek variant is emitted as an OpenAI-like JSON array in a
    // fenced block: [{"name":"read_file","arguments":{"path":"..."}}].
    // Only accept arrays whose entries all have an explicit tool name, so
    // ordinary JSON examples in an answer are not mistaken for calls.
    var fencedJsonPattern = /```(?:json|text)?\s*([\s\S]*?)```/gi;
    var fencedMatch;
    while ((fencedMatch = fencedJsonPattern.exec(markdown)) !== null) {
        var candidate = fencedMatch[1].replace(/^\s*(?:text\s*)?(?:复制\s*)?(?:下载\s*)?/i, '').trim();
        if (!candidate.startsWith('[')) continue;
        try {
            var nativeCalls = JSON.parse(candidate);
            if (!Array.isArray(nativeCalls) || !nativeCalls.length || !nativeCalls.every(function(call) {
                return call && typeof (call.name || call.tool) === 'string';
            })) continue;
            nativeCalls.forEach(function(call) {
                var args = call.arguments !== undefined ? call.arguments : call.params;
                commands.push({
                    tool: call.name || call.tool,
                    content: typeof args === 'string' ? args : JSON.stringify(args || {}),
                    format: 'native'
                });
            });
        } catch (e) {
            // Not a tool-call block; leave it visible as normal answer content.
        }
    }

    // Simplified Chinese web rendering observed in some DeepSeek turns:
    //   [调用 list_directory] {"path":"."}
    var chineseCallPattern = /\[调用\s+([a-zA-Z0-9_-]+)\]\s*/g;
    var chineseMatch;
    while ((chineseMatch = chineseCallPattern.exec(markdown)) !== null) {
        var chineseOpen = markdown.indexOf('{', chineseCallPattern.lastIndex);
        if (chineseOpen < 0 || chineseOpen - chineseCallPattern.lastIndex > 512) continue;
        var chineseDepth = 0;
        var chineseString = false;
        var chineseEscaped = false;
        var chineseClose = -1;
        for (var chi = chineseOpen; chi < Math.min(markdown.length, chineseOpen + 4096); chi++) {
            var chineseChar = markdown[chi];
            if (chineseString) {
                if (chineseEscaped) chineseEscaped = false;
                else if (chineseChar === '\\') chineseEscaped = true;
                else if (chineseChar === '"') chineseString = false;
                continue;
            }
            if (chineseChar === '"') chineseString = true;
            else if (chineseChar === '{') chineseDepth++;
            else if (chineseChar === '}' && --chineseDepth === 0) { chineseClose = chi + 1; break; }
        }
        if (chineseClose < 0) continue;
        try {
            var chineseArgs = JSON.parse(markdown.slice(chineseOpen, chineseClose));
            commands.push({ tool: chineseMatch[1], content: JSON.stringify(chineseArgs), format: 'calling' });
        } catch (e) {
            errors.push('[调用 ' + chineseMatch[1] + '] 的 JSON 参数无效');
        }
    }

    // DeepSeek may also render a tool directly as lightweight XML:
    //   <read_file><path>package.json</path></read_file>
    // Restrict this parser to known Runtime tool names so normal HTML/XML in
    // an answer cannot trigger execution.
    var knownTools = /^(?:read|read_file|list|list_directory|exists|info|write_file|save|edit|edit_file|mkdir|exec|bash|grep|glob|memory_read|memory_append|use_skill|mcp|subagent)$/;
    var directXmlPattern = /<([a-zA-Z][a-zA-Z0-9_-]*)>\s*([\s\S]*?)\s*<\/\1>/g;
    var directXmlMatch;
    while ((directXmlMatch = directXmlPattern.exec(markdown)) !== null) {
        var directTool = directXmlMatch[1];
        if (!knownTools.test(directTool)) continue;
        var directBody = directXmlMatch[2].trim();
        var directParams = {};
        if (directBody.startsWith('{')) {
            try { directParams = JSON.parse(directBody); } catch (e) { directParams = { content: directBody }; }
        } else {
            var fieldPattern = /<([a-zA-Z][a-zA-Z0-9_-]*)>\s*([\s\S]*?)\s*<\/\1>/g;
            var fieldMatch;
            while ((fieldMatch = fieldPattern.exec(directBody)) !== null) {
                directParams[fieldMatch[1]] = fieldMatch[2].trim();
            }
            if (!Object.keys(directParams).length && directBody) directParams.content = directBody;
        }
        commands.push({ tool: directTool, content: JSON.stringify(directParams), format: 'xml' });
    }

    // OpenAI-style XML wrapper used by newer DeepSeek web responses:
    // <function_calls><function_call>{"name":"read_file","arguments":{...}}</function_call></function_calls>
    var functionCallPattern = /<function_call>\s*([\s\S]*?)\s*<\/function_call>/g;
    var functionCallMatch;
    while ((functionCallMatch = functionCallPattern.exec(markdown)) !== null) {
        try {
            var functionCall = JSON.parse(functionCallMatch[1]);
            if (!functionCall || typeof (functionCall.name || functionCall.tool) !== 'string') continue;
            var functionArgs = functionCall.arguments !== undefined ? functionCall.arguments : functionCall.params;
            commands.push({
                tool: functionCall.name || functionCall.tool,
                content: typeof functionArgs === 'string' ? functionArgs : JSON.stringify(functionArgs || {}),
                format: 'native'
            });
        } catch (e) {
            errors.push('<function_call> 的 JSON 参数无效');
        }
    }

    // ReAct-style output used by some DeepSeek turns:
    // Action: read_file
    // Action Input: {"file_path":"package.json"}
    var reactPattern = /(?:^|\n)\s*Action:\s*`?([a-zA-Z0-9_-]+)`?\s*\n\s*Action\s+Input:\s*/g;
    var reactMatch;
    while ((reactMatch = reactPattern.exec(markdown)) !== null) {
        var reactOpen = markdown.indexOf('{', reactPattern.lastIndex);
        if (reactOpen < 0 || reactOpen - reactPattern.lastIndex > 512) continue;
        var reactDepth = 0;
        var reactString = false;
        var reactEscaped = false;
        var reactClose = -1;
        for (var ri = reactOpen; ri < Math.min(markdown.length, reactOpen + 4096); ri++) {
            var reactChar = markdown[ri];
            if (reactString) {
                if (reactEscaped) reactEscaped = false;
                else if (reactChar === '\\') reactEscaped = true;
                else if (reactChar === '"') reactString = false;
                continue;
            }
            if (reactChar === '"') reactString = true;
            else if (reactChar === '{') reactDepth++;
            else if (reactChar === '}' && --reactDepth === 0) { reactClose = ri + 1; break; }
        }
        if (reactClose < 0) continue;
        try {
            var reactArgs = JSON.parse(markdown.slice(reactOpen, reactClose));
            commands.push({ tool: reactMatch[1], content: JSON.stringify(reactArgs), format: 'native' });
        } catch (e) {
            errors.push('Action Input 的 JSON 参数无效');
        }
    }

    var lines = markdown.split('\n');
    var i = 0;
    var inCodeBlock = false;

    while (i < lines.length) {
        var line = lines[i];
        var trimmed = line.trim();

        // 跳过代码块
        if (/^```/.test(trimmed) || /^~~~/.test(trimmed)) {
            inCodeBlock = !inCodeBlock;
            i++;
            continue;
        }
        if (inCodeBlock) { i++; continue; }

        // ── 0. JSON 格式：{"tool":"xxx","params":{...}} ──
        if (trimmed.startsWith('{')) {
            // 跨行拼接直到找到匹配的 }
            var jsonStr = trimmed;
            if (!trimmed.endsWith('}')) {
                var depth = 0;
                for (var ci = 0; ci < jsonStr.length; ci++) {
                    if (jsonStr[ci] === '{') depth++;
                    else if (jsonStr[ci] === '}') depth--;
                }
                var walkIdx = i;
                while (depth > 0 && walkIdx + 1 < lines.length) {
                    walkIdx++;
                    var next = lines[walkIdx];
                    for (var cj = 0; cj < next.length; cj++) {
                        if (next[cj] === '{') depth++;
                        else if (next[cj] === '}') depth--;
                    }
                    jsonStr += '\n' + next;
                }
            }
            try {
                var obj = JSON.parse(jsonStr);
                if (obj && typeof obj.tool === 'string') {
                    var content = obj.params !== undefined ? JSON.stringify(obj.params) : '';
                    commands.push({ tool: obj.tool, content: content, format: 'json' });
                    i = walkIdx !== undefined ? walkIdx + 1 : i + 1;
                    continue;
                }
            } catch (e) {
                // JSON 解析失败，继续试 XML
            }
            // 重置 walkIdx，可能走了跨行但不是工具调用
            if (walkIdx !== undefined && walkIdx > i) i = walkIdx;
        }

        // ── 1. 多行 <tool:xxx>...</tool:xxx> ──
        var tagMatch = trimmed.match(/^<tool:([a-zA-Z0-9_-]+)>$/);
        if (tagMatch) {
            var toolName = tagMatch[1];
            i++;
            var contentLines = [];
            while (i < lines.length && !lines[i].trim().match(/^<\/tool:[a-zA-Z0-9_-]+>$/)) {
                contentLines.push(lines[i]);
                i++;
            }
            if (i < lines.length) i++; // skip </tool:xxx>
            var xmlContent = contentLines.join('\n').trim();
            if (xmlContent) {
                commands.push({ tool: toolName, content: xmlContent, format: 'xml' });
            }
            continue;
        }

        // ── 2. 单行 <tool:xxx>content</tool:xxx> ──
        var inlineMatch = trimmed.match(/^<tool:([a-zA-Z0-9_-]+)>(.*?)<\/tool:[a-zA-Z0-9_-]+>$/);
        if (inlineMatch) {
            if (inlineMatch[2]) {
                commands.push({ tool: inlineMatch[1], content: inlineMatch[2].trim(), format: 'xml' });
            }
            i++;
            continue;
        }

        // ── 3. 旧格式 <functioncall> 兼容 ──
        if (trimmed === '<functioncall>') {
            i++;
            var fcLines = [];
            while (i < lines.length && lines[i].trim() !== '</functioncall>') {
                fcLines.push(lines[i]);
                i++;
            }
            if (i < lines.length) i++;
            var fcContent = fcLines.join('\n').trim();
            if (fcContent) {
                try {
                    var fcObj = JSON.parse(fcContent);
                    if (fcObj && fcObj.tool) {
                        errors.push('检测到旧格式 <functioncall>，请改用 <tool:' + fcObj.tool + '> 格式');
                    } else {
                        errors.push('检测到旧格式 <functioncall>，请改用 <tool:工具名> 格式');
                    }
                } catch (e) {
                    errors.push('检测到旧格式 <functioncall>，请改用 <tool:工具名> 格式');
                }
            }
            continue;
        }

        i++;
    }

    return { commands: commands, errors: errors };
}

/**
 * 构建工具执行结果反馈 JSON
 * @param {Array<{tool:string, success:boolean, data:*, error:string, meta:object}>} results
 * @returns {string} 格式化 JSON 字符串
 */
function buildFeedback(results) {
    if (!results || results.length === 0) {
        return JSON.stringify({
            summary: { total: 0, success: 0, failed: 0 },
            results: []
        }, null, 2);
    }
    var successCount = results.filter(function(r) { return r.success; }).length;
    var feedbackObj = {
        summary: { total: results.length, success: successCount, failed: results.length - successCount },
        results: results.map(function(r) {
            return {
                tool: (r.meta && r.meta.tool) || r.tool || 'unknown',
                success: !!r.success,
                data: r.data !== undefined && r.data !== null ? r.data : null,
                error: r.error || null
            };
        })
    };
    return JSON.stringify(feedbackObj, null, 2);
}

/**
 * 执行工具调用回环
 * 解析 markdown → 逐工具执行 → 组装反馈
 *
 * @param {string} markdown — AI 回复的 markdown
 * @param {function} execToolFn — async (toolName, content) => { success, data, error, meta }
 *        由调用方提供，实际桥接到 inject 层 __ds.invoke('execTool', {name, content})
 * @param {object} [opts]
 * @param {number} [opts.maxLoops] - 最大工具调用次数（默认 50）
 * @param {Array} [opts.existingResults] - 已有结果（注入到 feedback 中）
 * @returns {Promise<{toolCalls:number, results:Array, feedback:string, summary:object}>}
 *         summary: { total, success, failed }
 *         results: [ { tool, success, data, error, meta } ]
 *         feedback: JSON 字符串（直接回灌给 AI）
 */
async function runToolLoop(markdown, execToolFn, opts) {
    opts = opts || {};
    var maxLoops = opts.maxLoops || 50;

    var parsed = parseToolCalls(markdown);
    var commands = parsed.commands;
    var errors = parsed.errors;

    if (commands.length === 0) {
        return {
            toolCalls: 0,
            results: [],
            feedback: buildFeedback([]),
            summary: { total: 0, success: 0, failed: 0 }
        };
    }

    // 截断超出上限
    if (commands.length > maxLoops) {
        commands = commands.slice(0, maxLoops);
        errors.push('工具调用超过上限（' + maxLoops + '），已截断');
    }

    var results = [];
    for (var ci = 0; ci < commands.length; ci++) {
        var cmd = commands[ci];
        try {
            var raw = await execToolFn(cmd.tool, cmd.content);
            // 标准化结果：raw 可能来自 inject 层，已将实际结果包在 raw.data 里
            var normResult = (raw && typeof raw === 'object' && 'data' in raw) ? raw : { success: !!raw, data: raw };
            results.push({
                tool: cmd.tool,
                success: !!normResult.success,
                data: normResult.data !== undefined ? normResult.data : null,
                error: normResult.error || null,
                meta: { tool: cmd.tool, format: cmd.format }
            });
        } catch (e) {
            results.push({
                tool: cmd.tool,
                success: false,
                data: null,
                error: e.message || String(e),
                meta: { tool: cmd.tool, format: cmd.format }
            });
        }
    }

    // 合并已有结果（如果有）
    if (opts.existingResults && opts.existingResults.length > 0) {
        results = opts.existingResults.concat(results);
    }

    var feedbackStr = buildFeedback(results);

    return {
        toolCalls: results.length,
        results: results,
        feedback: feedbackStr,
        summary: { total: results.length, success: results.filter(function(r) { return r.success; }).length, failed: results.filter(function(r) { return !r.success; }).length }
    };
}

module.exports = {
    parseToolCalls: parseToolCalls,
    buildFeedback: buildFeedback,
    runToolLoop: runToolLoop
};
