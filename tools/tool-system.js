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

    // 已通过 help 阅读过文档的工具集合
    var readTools = new Set();

    // 免检白名单 — 这些工具不需要先阅读文档即可使用
    var READ_WHITELIST = ['help', 'break', 'mcp-list', 'mcp-init'];

    // ==================== JSON 解析 ====================

    // 解析代码块内容为 { params, body }
    // 新格式支持：平铺 JSON，body 从 body/content/command 字段提取
    // 旧格式兼容：如果 JSON 包含 tool 字段，尝试解析旧格式 {tool, params, body}
    // 如果内容不以 { 开头，回退到旧格式：整个 content 作为 body
    function parseJsonContent(content) {
        if (!content) return { params: {}, body: '' };
        var trimmed = content.trim();
        if (trimmed[0] === '{') {
            try {
                var parsed = JSON.parse(trimmed);
                // 旧格式兼容：如果包含 tool 字段，说明是旧格式 {tool: "xxx", params: {...}, body: "..."}
                if (parsed.tool !== undefined && parsed.params !== undefined) {
                    return {
                        params: parsed.params || {},
                        body: typeof parsed.body === 'string' ? parsed.body : (parsed.body ? JSON.stringify(parsed.body) : '')
                    };
                }
                // 新格式：平铺 JSON，提取 body 字段（优先级：body > content > command）
                var body = '';
                if (parsed.body !== undefined && typeof parsed.body === 'string') {
                    body = parsed.body;
                    delete parsed.body;
                } else if (parsed.content !== undefined && typeof parsed.content === 'string') {
                    body = parsed.content;
                    delete parsed.content;
                } else if (parsed.command !== undefined && typeof parsed.command === 'string') {
                    body = parsed.command;
                    delete parsed.command;
                }
                return { params: parsed, body: body };
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
        var displayNames = names;
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
            doc += '**JSON 使用示例**:\n\n';
            doc += '<tool:' + displayNames[0] + '>\n';
            doc += tool.usage + '\n';
            doc += '</tool:' + displayNames[0] + '>\n\n';
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
        doc += '> 内容为 JSON 对象，包含 `tool`（工具名）、`params`（参数）和 `body`（内容体）。\n\n';
        doc += '---\n\n';

        for (var oi = 0; oi < toolOrder.length; oi++) {
            doc += generateToolDoc(toolOrder[oi]);
            doc += '---\n\n';
        }

        doc += '## 工具调用格式\n\n';
        doc += '所有工具统一使用 `<tool:工具名>` 标签（独占一行，JSON 放在标签之间）：\n\n';
        doc += '```\n<tool:read>\n{"key": "value", "body": "多行内容放在 body 字段中"}\n</tool:read>\n```\n\n';
        doc += '或单行格式：\n\n';
        doc += '```\n<tool:read>{"key": "value"}</tool:read>\n```\n\n';
        doc += '- 工具名在标签中（如 `exec`、`read`、`save` 等）\n';
        doc += '- JSON 参数直接填写，不需要 params 嵌套\n';
        doc += '- body 字段用于多行内容\n\n';
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
        doc += '### 错误反馈\n如果 `<functioncall>` 中的 JSON 格式错误，系统会自动检测并反馈错误信息，帮助修正。\n\n';

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
                // P0: Loop Guard 循环检测
                try {
                    if (typeof window.__dsagent_loopGuardCheck === 'function') {
                        var lc = window.__dsagent_loopGuardCheck(name, JSON.stringify(params), rawResult, true);
                        if (lc && lc.blocked) {
                            return makeResult(true, null, null, { tool: name, warning: lc.reason, block: true });
                        }
                    }
                } catch(le) {}
                // P0: 动态步长预算 + 停滞检测
                try {
                    if (typeof window.__dsagent_disciplineCheck === 'function') {
                        var dc = window.__dsagent_disciplineCheck(name, JSON.stringify(params), rawResult && rawResult.success);
                        if (dc && dc.blocked) {
                            return makeResult(true, null, null, { tool: name, warning: dc.reason, block: true });
                        }
                        if (dc && dc.warning && rawResult && typeof rawResult === 'object') {
                            rawResult._disciplineWarning = dc.warning;
                        }
                    }
                } catch(de) {}
                // P0: 写类工具成功后强制语法验证
                if (rawResult && rawResult.success && WRITE_TOOLS.indexOf(name) >= 0) {
                    var editedPath2 = getEditedFilePath(name, params, body);
                    var syntaxErr2 = await postEditSyntaxCheck(editedPath2);
                    if (syntaxErr2) {
                        if (typeof rawResult.data === 'string') {
                            rawResult.data = rawResult.data + syntaxErr2;
                        } else {
                            rawResult._syntaxWarning = syntaxErr2;
                        }
                        console.warn('[SyntaxCheck] ' + name + ' on ' + editedPath2 + ' reported:' + syntaxErr2.substring(0, 200));
                    }
                }
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
            // P0: Loop Guard 循环检测
            try {
                if (typeof window.__dsagent_loopGuardCheck === 'function') {
                    var lc2 = window.__dsagent_loopGuardCheck(name, JSON.stringify(params), rawResult, true);
                    if (lc2 && lc2.blocked) {
                        return makeResult(true, null, null, { tool: name, warning: lc2.reason, block: true });
                    }
                }
            } catch(le) {}
            // P0: 动态步长预算 + 停滞检测（参考 atomcode DisciplineState）
            try {
                if (typeof window.__dsagent_disciplineCheck === 'function') {
                    var dc = window.__dsagent_disciplineCheck(name, JSON.stringify(params), rawResult && rawResult.success);
                    if (dc && dc.blocked) {
                        return makeResult(true, null, null, { tool: name, warning: dc.reason, block: true });
                    }
                    if (dc && dc.warning) {
                        // 不阻塞，但把警告附到结果上让 LLM 看到
                        if (rawResult && typeof rawResult === 'object' && 'success' in rawResult) {
                            rawResult._disciplineWarning = dc.warning;
                        }
                    }
                }
            } catch(de) {}
            if (rawResult && typeof rawResult === 'object' && 'success' in rawResult) {
                // P0: 写类工具成功后强制语法验证
                if (rawResult.success && WRITE_TOOLS.indexOf(name) >= 0) {
                    var editedPath = getEditedFilePath(name, params, body);
                    var syntaxErr = await postEditSyntaxCheck(editedPath);
                    if (syntaxErr) {
                        // 把语法错误追加到返回数据，让 LLM 看到并继续修
                        var origData = rawResult.data;
                        var warnText = (typeof origData === 'string' ? origData : (origData && origData.message ? origData.message : '')) + syntaxErr;
                        if (typeof origData === 'string') {
                            rawResult.data = warnText;
                        } else {
                            rawResult.data = origData;
                            rawResult._syntaxWarning = syntaxErr;
                        }
                        console.warn('[SyntaxCheck] ' + name + ' on ' + editedPath + ' reported:' + syntaxErr.substring(0, 200));
                    }
                }
                return rawResult;
            }
            return makeResult(true, rawResult, null, { tool: name });
        } catch (e) {
            return makeResult(false, null, e.message || '执行失败', { tool: name });
        }
    }

    // ==================== P0: 编辑后强制语法验证（参考 atomcode auto_fix.rs） ====================
    // 写类工具成功后，框架层强制跑一次语法检查（node --check / python -m py_compile / tsc --noEmit / json parse）
    // 失败把错误回灌给 LLM 继续修。把"模型自觉验证"变成"框架强制验证"，杜绝 AI 谎报完成。
    var WRITE_TOOLS = ['edit', 'edit_file', 'save', 'write', 'write_file', 'search_replace', 'search-replace'];

    function getEditedFilePath(name, params, body) {
        // 不同工具用不同字段名承载路径
        if (name === 'save' || name === 'write' || name === 'write_file') {
            return params.path || params.file || params.file_path || '';
        }
        if (name === 'edit' || name === 'edit_file') {
            return params.path || params.file || params.file_path || '';
        }
        if (name === 'search_replace' || name === 'search-replace') {
            return params.path || params.file || params.file_path || '';
        }
        return params.path || params.file || params.file_path || '';
    }

    // 通过 electronAPI 调用主进程做磁盘语法检查（主进程有 node 子进程权限）
    // 返回 '' 表示无问题，否则是错误提示文本
    async function postEditSyntaxCheck(filePath) {
        if (!filePath) return '';
        var ext = (filePath.split('.').pop() || '').toLowerCase();
        // 仅对常见可静态检查的扩展名做检查，避免对未知类型瞎跑
        var checkable = ['js', 'mjs', 'cjs', 'py', 'json', 'ts', 'tsx', 'jsx', 'vue'];
        if (checkable.indexOf(ext) < 0) return '';
        try {
            if (window.electronAPI && typeof window.electronAPI.agentSyntaxCheck === 'function') {
                var res = await window.electronAPI.agentSyntaxCheck(filePath, ext);
                if (res && res.success && res.error) return '\n⚠ SYNTAX ERROR: ' + res.error;
            }
        } catch (e) { /* 非关键，静默 */ }
        return '';
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
        setReadHistory: function(arr) { readTools = new Set(arr || []); },
        // 暴露给外部测试/复用
        _postEditSyntaxCheck: postEditSyntaxCheck,
        _WRITE_TOOLS: WRITE_TOOLS
    };
})();