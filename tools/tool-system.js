// Tool System - 标准工具注册/加载器
// 每个工具按标准格式注册，支持元数据查询和执行调度

;(function() {
    'use strict';

    if (window.__dsagent_toolSystem) return;
    window.__dsagent_toolSystem = true;

    var registry = {};
    var toolOrder = [];
    var utils = null;  // 由 inject.js 注入工具函数

    // 已通过 local-help 阅读过文档的工具集合
    var readTools = new Set();

    // 免检白名单 — 这些工具不需要先阅读文档即可使用
    var READ_WHITELIST = ['local-help', 'local-break'];

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

    // ==================== 文档生成 ====================
    function generateToolDoc(name) {
        var tool = registry[name];
        if (!tool) return '未知工具: ' + name;

        // 标记该工具的文档已被阅读
        readTools.add(name);
        if (Array.isArray(tool.name)) {
            for (var _ni = 0; _ni < tool.name.length; _ni++) {
                readTools.add(tool.name[_ni]);
            }
        }

        var doc = '';
        // 工具名（多别名显示）
        var names = Array.isArray(tool.name) ? tool.name : [tool.name];
        doc += '### `' + names[0] + '`\n';
        if (names.length > 1) {
            doc += '> 别名: ' + names.slice(1).map(function(n) { return '`' + n + '`'; }).join(', ') + '\n\n';
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
            doc += '**使用示例**:\n\n```' + names[0] + '\n' + tool.usage + '\n```\n\n';
        }

        if (tool.notes) {
            doc += '**注意事项**: ' + tool.notes + '\n\n';
        }

        return doc;
    }

    function generateAllDocs() {
        // 阅读全部文档 = 标记所有工具已读
        for (var oi = 0; oi < toolOrder.length; oi++) {
            readTools.add(toolOrder[oi]);
            var tool = registry[toolOrder[oi]];
            if (tool && Array.isArray(tool.name)) {
                for (var _ai = 0; _ai < tool.name.length; _ai++) {
                    readTools.add(tool.name[_ai]);
                }
            }
        }

        var doc = '# 本地工具系统 — 完整指令文档\n\n';
        doc += '> 本系统包含 ' + toolOrder.length + ' 个可用工具，支持文件操作、命令执行、AI 视觉分析、子代理读取等功能。\n\n';
        doc += '---\n\n';

        for (var oi = 0; oi < toolOrder.length; oi++) {
            doc += generateToolDoc(toolOrder[oi]);
            doc += '---\n\n';
        }

        // 附录：处理逻辑说明
        doc += '## 处理逻辑\n\n';
        doc += '### 使用前注意事项\n\n';
        doc += '如果不确定某个工具的具体用法或参数，请先调用 `local-help` 查看完整文档，避免错误使用。\n\n';
        doc += '### 自动执行\n\n';
        doc += '所有 `local-*` 代码块在 DeepSeek 回复后自动检测并执行。系统通过监听发送按钮状态检测生成完成，然后点击复制按钮获取完整回复内容，解析其中的代码块并依次执行。\n\n';
        doc += '### 确认机制\n\n';
        doc += '- 危险命令（如 `del`、`rm` 等）默认需要用户确认\n';
        doc += '- 安全操作（文件读写、列表等）自动执行无需确认\n';
        doc += '- 三种确认模式: `strict`（全部确认）、`smart`（仅危险命令）、`loose`（全部自动）\n\n';
        doc += '### 输出控制\n\n';
        doc += '- 输出超过 10KB 时自动警告（除非添加 `force=true`）\n';
        doc += '- 输出超过 159KB 时强制拒绝\n';
        doc += '- 可通过 `force=true` 参数强制返回大结果\n\n';
        doc += '### 中断机制\n\n';
        doc += '- 点击停止按钮可中断 AI 生成和后续命令执行\n';
        doc += '- `stopRequested` 标记阻止后续命令继续执行\n';
        doc += '- `local-break` 可停止 `local-interval` 循环\n\n';
        doc += '### 内容截断处理\n\n';
        doc += '- 检测到"继续生成"按钮时弹出确认框\n';
        doc += '- 用户选择"继续生成"则跳过本次解析，等待完整内容\n';
        doc += '- 用户选择"取消"则正常处理当前已有内容\n\n';
        doc += '### 文件上传核验\n\n';
        doc += '- 上传后检查页面通知中的"该格式暂不支持"字眼\n';
        doc += '- 生成结束后检查"未识别到文字"错误\n';
        doc += '- 检测到错误自动清理临时对话并返回错误说明\n\n';
        doc += '### 剪贴板管理\n\n';
        doc += '- 操作剪贴板前自动保存当前剪贴板内容\n';
        doc += '- 操作完成后自动还原\n\n';
        doc += '### 错误处理\n\n';
        doc += '- 各工具执行失败时返回具体错误信息\n';
        doc += '- 超时、权限不足、文件不存在等均有对应处理\n';
        doc += '- 全局异常捕获防止单工具崩溃影响后续工具\n';

        return doc;
    }

    // ==================== 工具执行 ====================
    async function executeTool(name, content, toolContext) {
        var tool = registry[name];
        if (!tool) throw new Error('未知工具: ' + name);

        // 文档阅读检查 — 调用前必须先通过 local-help 阅读过文档
        if (READ_WHITELIST.indexOf(name) === -1 && !readTools.has(name)) {
            return '⚠️ **工具未阅读文档**: 你尝试调用了 `' + name + '`，但在本轮对话中尚未通过 `local-help` 阅读该工具的文档。\n\n'
                + '请先查看文档了解用法后再调用：\n\n```local-help\n' + name + '\n```\n\n'
                + '（你也可以直接阅读全部工具文档：`local-help` 无参数调用）';
        }

        if (!tool.handler) throw new Error('工具 ' + name + ' 未实现处理函数');
        return await tool.handler(content, toolContext);
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
        clearReadHistory: function() { readTools = new Set(); },
        getReadHistory: function() { return Array.from(readTools); },
        setReadHistory: function(arr) { readTools = new Set(arr || []); }
    };
})();