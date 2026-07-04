// 共享的回复处理逻辑（消除 main.js pollAndForwardResult 和 agent-orchestrator 的重复）
// 包含：subagent 反馈构建、segments 组装（JSON 工具调用解析 + subagent 段 + 文本/图片段）
;(function (root, factory) {
    if (typeof module === 'object' && module.exports) {
        module.exports = factory();
    } else {
        root.responseProcessor = factory();
    }
}(typeof self !== 'undefined' ? self : this, function () {

    // ===== 构建 subagent 结果反馈文本（原 orchestrator.buildSubagentFeedback + main.js pollAndForward 重复实现） =====
    function buildSubagentFeedback(results) {
        var parts = ['【Subagent 执行结果】\n'];
        for (var i = 0; i < results.length; i++) {
            var r = results[i];
            parts.push('### Subagent ' + (i + 1) + ': ' + r.template);
            parts.push('**任务**: ' + (r.prompt || ''));
            if (r.success && r.data && r.data.data) {
                parts.push('**结果**:\n' + (r.data.data.markdown || JSON.stringify(r.data.data)));
            } else {
                parts.push('**失败**: ' + (r.error || '未知错误'));
            }
            parts.push('');
        }
        parts.push('请基于以上 subagent 结果继续处理用户请求。');
        return parts.join('\n');
    }

    // ===== 从 markdown 中解析 JSON 工具调用，组装 segments =====
    // 返回 { segments: [...], textParts: [...] }
    // segments 包含 think（若有）、tool-call（若有）、text（合并后的剩余文本）、image（若有）
    function buildSegmentsFromMarkdown(markdown, opts) {
        opts = opts || {};
        var think = opts.think || '';
        var images = opts.images || [];
        var subagentResults = opts.subagentResults || [];

        var segments = [];
        if (think) segments.push({ type: 'think', content: think });

        // 检测回复中的工具调用：JSON 格式 {"tool":"name","params":{...}}
        // 用大括号计数法提取完整 JSON 对象，避免嵌套 {} 被截断
        var textParts = [];
        var lastIdx = 0;
        var braceDepth = 0;
        var jsonStart = -1;
        for (var ci = 0; ci < markdown.length; ci++) {
            var ch = markdown[ci];
            if (ch === '{') {
                if (braceDepth === 0) jsonStart = ci;
                braceDepth++;
            } else if (ch === '}') {
                braceDepth--;
                if (braceDepth === 0 && jsonStart >= 0) {
                    var jsonStr = markdown.substring(jsonStart, ci + 1);
                    try {
                        var obj = JSON.parse(jsonStr);
                        if (obj.tool && typeof obj.tool === 'string' && obj.params) {
                            var beforeText = markdown.substring(lastIdx, jsonStart).trim();
                            if (beforeText) textParts.push(beforeText);
                            textParts.push('[工具调用: ' + obj.tool + ']');
                            segments.push({ type: 'tool-call', lang: obj.tool, content: JSON.stringify(obj.params) });
                            lastIdx = ci + 1;
                        }
                    } catch (e) { /* 非工具调用 JSON，保留为文本 */ }
                    jsonStart = -1;
                }
            }
        }
        var remaining = markdown.substring(lastIdx).trim();
        if (remaining) textParts.push(remaining);

        // subagent 段处理：清理原始 subagent 标签文本，注入 subagent tool-call + tool-result
        if (subagentResults && subagentResults.length > 0) {
            var cleanTextParts = [];
            for (var tpi = 0; tpi < textParts.length; tpi++) {
                var tp = textParts[tpi];
                tp = tp.replace(/\{\s*"subagent"\s*:\s*\{[\s\S]*?\}\s*\}/g, '').trim();
                tp = tp.replace(/<subagent:invoke[^>]*>[\s\S]*?<\/subagent:invoke>/g, '').trim();
                if (tp) cleanTextParts.push(tp);
            }
            var cleanAiText = cleanTextParts.join('\n\n').trim();
            segments.length = 0; // 清空之前可能插入的 tool-call（原始回复中的工具调用）
            if (think) segments.push({ type: 'think', content: think });
            if (cleanAiText) segments.push({ type: 'text', content: cleanAiText });
            for (var si = 0; si < subagentResults.length; si++) {
                var sr = subagentResults[si];
                segments.push({ type: 'tool-call', lang: 'subagent:' + sr.template, content: sr.prompt || '', subagent: true });
                segments.push({ type: 'tool-result', content: (sr.success && sr.data && sr.data.data && sr.data.data.markdown) || sr.error || '', lang: 'subagent:' + sr.template, subagent: true });
            }
        } else if (segments.length === 0) {
            // 无工具调用、无 subagent：纯文本
            segments.push({ type: 'text', content: markdown });
        } else if (textParts.length > 0) {
            // 有工具调用：合并剩余文本插入到 segments 前面
            var mergedText = textParts.join('\n\n').trim();
            if (mergedText) {
                segments.unshift({ type: 'text', content: mergedText });
            }
        }

        // 图片段
        if (images && images.length > 0) {
            for (var ii = 0; ii < images.length; ii++) {
                segments.push({ type: 'image', content: images[ii] });
            }
        }

        return { segments: segments, textParts: textParts };
    }

    return {
        buildSubagentFeedback: buildSubagentFeedback,
        buildSegmentsFromMarkdown: buildSegmentsFromMarkdown
    };
}));
