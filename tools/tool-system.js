// Tool System - 标准工具注册/加载器（JSON 标准化版）
// 每个工具按标准格式注册，支持元数据查询和执行调度
// 工具调用输入和返回均为 JSON 格式

;(function() {
    'use strict';

    if (window.__dsagent_toolSystem) return;
    window.__dsagent_toolSystem = true;

    var registry = {};
    var toolOrder = [];
    var utils = null;  // 由 inject-deepseek.js 注入工具函数

    // 已通过 local-help 阅读过文档的工具集合
    var readTools = new Set();

    // 免检白名单 — 这些工具不需要先阅读文档即可使用
    var READ_WHITELIST = ['local-help', 'local-break', 'mcp-list', 'mcp-init'];

    // ==================== JSON 解析 ====================

    // 解析代码块内容为 { params, body }
    // 如果内容以 { 开头，尝试 JSON 解析，提取 params 和 body
    // 否则回退到旧格式：将整个 content 作为 body，params 为空
    function parseJsonContent(content) {
        if (!content) return { params: {}, body: '' };
        var trimmed = content.trim();
        if (trimmed[0] === '{') {
            try {
                var parsed = JSON.parse(trimmed);
                return {
                    params: parsed.params || {},
                    body: typeof parsed.body === 'string' ? parsed.body : (parsed.body ? JSON.stringify(parsed.body) : '')
                };
            } catch(e) {
                // JSON 解析失败，回退到旧格式
                return { params: {}, body: content };
            }
        }
        // 旧格式：整个内容作为 body
        return { params: {}, body: content };
    }

    // 构建标准 JSON 返回结果
    function makeResult(success, data, error, meta) {
        return {
            success: !!success,
            data: data !== undefined ? data : null,
            error: error || null,
            meta: meta || {}
        };
    }

    // ==================== 工具注册 ====================
    function registerTool(toolDef) {
        if (!toolDef || !toolDef.name) return;
        var names = Array.isArray(toolDef.name) ? toolDef.name : [toolDef.name];
        for (var ni = 0; ni < names.length; ni++) {
            registry[names[ni]] = toolDef;
        }
        if (toolOrder.indexOf(toolDef.name) === -1) {
            toolOrder.push(Array.isArray(toolDef.name) ? toolDef.name[0] : toolDef.name);
        }
    }

    // ==================== 工具查询 ====================
    function getTool(name) {
        return registry[name] || null;
    }

    function getAllTools() {
        var list = [];
        for (var oi = 0; oi < toolOrder.length; oi++) {
            var tool = registry[toolOrder[oi]];
            if (tool) list.push(tool);
        }
        return list;
    }

    function isSupported(name) {
        return !!registry[name];
    }

    function getAllSupportedLangs() {
        var langs = [];
        for (var oi = 0; oi < toolOrder.length; oi++) {
            var tool = registry[toolOrder[oi]];
            if (tool) {
                var names = Array.isArray(tool.name) ? tool.name : [tool.name];
                for (var ni = 0; ni < names.length; ni++) {
                    langs.push(names[ni]);
                }
            }
        }
        return langs;
    }

    // ==================== 文档生成（JSON 格式） ====================
    function generateToolDoc(name) {
        var tool = registry[name];
        if (!tool) return '未知工具: ' + name;

        readTools.add(name);
        if (Array.isArray(tool.name)) {
            for (var _ni = 0; _ni < tool.name.length; _ni++) {
                readTools.add(tool.name[_ni]);
            }
        }

        var doc = '';
        var names = Array.isArray(tool.name) ? tool.name : [tool.name];
        var displayNames = names.map(function(n) { return n.replace(/^local-/, ''); });
        doc += '### `' + displayNames[0] + '`\n';
        if (displayNames.length > 1) {
            doc += '> 别名: ' + displayNames.slice(1).map(function(n) { return '`' + n + '`'; }).join(', ') + '\n\n';
        }
        doc += '\n**使用范围**: ' + (tool.scope || '通用') + '\n\n';
        doc += '**功能说明**: ' + (tool.description || '') + '\n\n';

        if (tool.params && tool.params.length > 0) {
            doc += '**参数**:\n\n';
            doc += '| 参数 | 类型 | 默认值 | 必填 | 说明 |\n';
            doc += '|------|------|--------|------|------|\n';
            for (var pi = 0; pi < tool.params.length; pi++) {
                var p = tool.params[pi];
                doc += '| `' + p.name + '` | ' + (p.type || '字符串') + ' | ' + (p.default || '—') + ' | ' + (p.required ? '是' : '否') + ' | ' + (p.description || '') + ' |\n';
            }
            doc += '\n';
        }

        if (tool.usage) {
            doc += '**JSON 使用示例**:\n\n<functioncall>' + tool.usage + '</functioncall>\n\n';
        }

        if (tool.notes) {
            doc += '**注意事项**: ' + tool.notes + '\n\n';
        }

        return doc;
    }

    function generateAllDocs() {
        for (var oi = 0; oi < toolOrder.length; oi++) {
            readTools.add(toolOrder[oi]);
            var tool = registry[toolOrder[oi]];
            if (tool && Array.isArray(tool.name)) {
                for (var _ai = 0; _ai < tool.name.length; _ai++) {
                    readTools.add(tool.name[_ai]);
                }
            }
        }

        var doc = '# 本地工具系统 — 完整指令文档（JSON 格式）\n\n';
        doc += '> 本系统包含 ' + toolOrder.length + ' 个可用工具。所有工具统一使用 `<functioncall>` 标签，通过 `tool` 字段指定工具名。\n';
        doc += '> 内容为 JSON 对象，包含 `tool`（工具名，无需 `local-` 前缀）、`params`（参数）和 `body`（内容体）。\n\n';
        doc += '---\n\n';

        for (var oi = 0; oi < toolOrder.length; oi++) {
            doc += generateToolDoc(toolOrder[oi]);
            doc += '---\n\n';
        }

        doc += '## JSON 调用格式\n\n';
        doc += '所有工具统一使用 `<functioncall>` 标签：\n\n';
        doc += '```\n<functioncall>{"tool": "read", "params": {"key": "value"}, "body": "多行内容放在 body 字段中"}</functioncall>\n```\n\n';
        doc += '- `tool`: 工具名称（必填），如 `exec`、`read`、`save` 等，无需 `local-` 前缀\n';
        doc += '- `params`: 工具参数，key-value 对象\n';
        doc += '- `body`: 多行内容体（命令、文件内容等），可选\n\n';
        doc += '## JSON 返回格式\n\n';
        doc += '所有工具返回统一 JSON 结构：\n\n';
        doc += '```json\n{\n  "success": true,\n  "data": "结果数据",\n  "error": null,\n  "meta": { "tool": "xxx" }\n}\n```\n\n';
        doc += '- `success`: 执行是否成功\n';
        doc += '- `data`: 成功时的返回数据\n';
        doc += '- `error`: 失败时的错误信息\n';
        doc += '- `meta`: 元数据（工具名、耗时等）\n\n';
        doc += '## 处理逻辑\n\n';
        doc += '### 自动执行\n所有 `<functioncall>` 标签在 DeepSeek 回复后自动检测并执行。\n\n';
        doc += '### 确认机制\n危险命令默认需要用户确认，安全操作自动执行。\n\n';
        doc += '### 输出控制\n输出超过 10KB 时自动警告，超过 159KB 时强制拒绝。\n\n';

        return doc;
    }

    // ==================== 工具执行 ====================
    async function executeTool(name, content, toolContext) {
        var tool = registry[name];
        if (!tool) throw new Error('未知工具: ' + name);

        // 解析 JSON 输入
        var parsed = parseJsonContent(content);
        var params = parsed.params;
        var body = parsed.body;

        // 必填参数检查
        if (tool.params && tool.params.length > 0) {
            var missing = [];
            for (var pi = 0; pi < tool.params.length; pi++) {
                var p = tool.params[pi];
                if (p.required && (params[p.name] === undefined || params[p.name] === null || params[p.name] === '')) {
                    missing.push(p.name);
                }
            }
            if (missing.length > 0) {
                var doc = generateToolDoc(name);
                return makeResult(false, null, '缺少必填参数: ' + missing.join(', ') + '\n\n' + doc);
            }
        }

        // 文档阅读检查 — 未阅读时自动帮读
        if (READ_WHITELIST.indexOf(name) === -1 && !readTools.has(name)) {
            readTools.add(name);
            var doc = generateToolDoc(name);
            if (!tool.handler) throw new Error('工具 ' + name + ' 未实现处理函数');

            // 执行工具并包装结果
            var result;
            try {
                var rawResult = await tool.handler(params, body, toolContext);
                // 如果 handler 已经返回标准 JSON 格式，直接使用
                if (rawResult && typeof rawResult === 'object' && 'success' in rawResult) {
                    result = rawResult;
                } else {
                    result = makeResult(true, rawResult, null, { tool: name });
                }
            } catch (e) {
                result = makeResult(false, null, e.message || '执行失败', { tool: name });
            }
            result._autoDoc = doc;
            return result;
        }

        if (!tool.handler) throw new Error('工具 ' + name + ' 未实现处理函数');

        try {
            var rawResult = await tool.handler(params, body, toolContext);
            if (rawResult && typeof rawResult === 'object' && 'success' in rawResult) {
                return rawResult;
            }
            return makeResult(true, rawResult, null, { tool: name });
        } catch (e) {
            return makeResult(false, null, e.message || '执行失败', { tool: name });
        }
    }

    // ==================== 初始化 ====================
    function init(toolUtils) {
        utils = toolUtils;
    }

    // 暴露到全局
    window.__dsagent_tools = {
        register: registerTool,
        get: getTool,
        getAll: getAllTools,
        isSupported: isSupported,
        getAllLangs: getAllSupportedLangs,
        doc: generateToolDoc,
        allDocs: generateAllDocs,
        execute: executeTool,
        init: init,
        parseJsonContent: parseJsonContent,
        makeResult: makeResult,
        clearReadHistory: function() { readTools = new Set(); },
        getReadHistory: function() { return Array.from(readTools); },
        setReadHistory: function(arr) { readTools = new Set(arr || []); }
    };
})();