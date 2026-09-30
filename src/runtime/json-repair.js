// JSON repair for webpage tool-call transport.
// 参考 atomcode 的 turn/json_repair.rs 设计
// 处理：Windows 路径误转义、trailing comma、unquoted key、markdown fence、单引号
// Shared Node parser; injected browser code retains its browser-safe fallback.
'use strict';

// 第0层：Windows 路径预逃逸
// 检测 "D:\test\foo.py" 中的 \t/\f 等，防止它们被 JSON.parse 解码
function preEscapeWindowsPaths(str) {
    return str.replace(/"([A-Za-z]:[^"]*)"/g, function(match, path) {
        if (!path) return match;
        if (path.indexOf('\\') < 0) return match;
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
    s = s.replace(/'(true|false|null|\d+)'/g, '$1'); // 布尔/数字的单引号
    s = s.replace(/'([^']*?)'\s*:/g, '"$1":'); // key 的单引号
    s = s.replace(/:\s*'([^']*?)'/g, function(m, content) {
        if (content.indexOf('"') >= 0) return m;
        return ': "' + content.replace(/"/g, '\\"') + '"';
    });

    // 补全未加引号的 key（只补简单字母数字 key）
    s = s.replace(/([{,]\s*)([a-zA-Z_$][a-zA-Z0-9_$]*)\s*:/g, '$1"$2":');

    // 移除 trailing comma
    s = s.replace(/,\s*([}\]])/g, '$1');
    s = s.replace(/,+/g, ',');
    s = s.replace(/\.\s*([}\]])/g, '$1');

    return s;
}

// 第4层：兜底 Key-Value 提取
function extractJsonFields(str) {
    if (!str) return {};
    var result = {};
    var kvRegex = /(\w+)\s*=\s*(?:"([^"]*)"|'([^']*)'|(\S+?))(?:\s|$)/g;
    var match;
    while ((match = kvRegex.exec(str)) !== null) {
        var val = match[2] !== undefined ? match[2] : (match[3] !== undefined ? match[3] : match[4]);
        if (val !== undefined) result[match[1]] = val;
    }
    return result;
}

// 主修复函数：5层修复链
// 返回修复后的字符串（可能仍非合法 JSON，调用方需再 try JSON.parse）
function repairToolArgs(toolName, args) {
    if (!args || args.trim() === '') return args;

    // 第0层：Windows 路径预逃逸
    var pre = preEscapeWindowsPaths(args);

    // 第1层：快速路径 — 已经是合法 JSON
    try { JSON.parse(pre); return pre; } catch(e) {}

    // 第2层：通用 JSON 修复
    var repaired = repairJson(pre);
    try { JSON.parse(repaired); return repaired; } catch(e) {}

    // 第3层：专属修复 — edit_file 包含源代码，引号/换行可能未转义
    if (toolName === 'edit' || toolName === 'edit_file') {
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
        try { return JSON.stringify(extracted); } catch(e) {}
    }

    // 全部失败，返回原值
    return args;
}

// 便捷封装：尝试解析 NDJSON 的一行，修复失败返回 null
// 供 bin/dsagent-cli.js 替换 `try { JSON.parse(line) } catch { /* ignore */ }`
function parseLine(line) {
    if (!line) return null;
    var trimmed = line.trim();
    if (!trimmed) return null;
    // 第1层：直接解析
    try { return JSON.parse(trimmed); } catch(e) {}
    // 第2-4层：修复后解析
    var repaired = repairToolArgs(null, trimmed);
    try { return JSON.parse(repaired); } catch(e) {}
    // 全部失败：返回 null 但记录可调试信息（不静默吞）
    return { __parse_failed: true, raw: trimmed.substring(0, 200) };
}

module.exports = {
    preEscapeWindowsPaths: preEscapeWindowsPaths,
    repairJson: repairJson,
    extractJsonFields: extractJsonFields,
    repairToolArgs: repairToolArgs,
    parseLine: parseLine
};
