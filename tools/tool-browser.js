// local-browser - 浏览器工具：创建窗口、执行控制台、截图、页面识别
;(function() {
    'use strict';

    if (window.__dsagent_tools && window.__dsagent_tools._browser_registered) return;

    // ==================== 工具函数 ====================

    function parseBrowserParams(content) {
        var lines = content.trim().split('\n');
        var params = {};
        var bodyLines = [];

        for (var li = 0; li < lines.length; li++) {
            var line = lines[li];
            var kvMatch = line.match(/^(\w[\w-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|(\S+))$/);
            if (kvMatch) {
                var key = kvMatch[1];
                var val = kvMatch[2] !== undefined ? kvMatch[2] : (kvMatch[3] !== undefined ? kvMatch[3] : kvMatch[4]);
                params[key] = val;
            } else {
                bodyLines.push(line);
            }
        }

        var body = bodyLines.join('\n').trim();
        return { params: params, body: body };
    }

    function getActiveWindowId(params, state) {
        // 如果指定了 id 参数，用指定的；否则用最近活跃的
        if (params.id) return params.id;
        if (params.win) return params.win;
        return state.lastActiveId || null;
    }

    function urlFromParams(params) {
        return params.url || '';
    }

    // 敏感 API 正则列表（执行前需要用户确认）
    var SENSITIVE_API_PATTERNS = [
        /document\.cookie/i,
        /localStorage\./i,
        /sessionStorage\./i,
        /indexedDB\./i,
        /navigator\.credentials/i,
        /navigator\.clipboard\.read/i,
        /fetch\s*\(/i,
        /XMLHttpRequest/i,
        /new\s+Request/i,
        /WebSocket/i,
        /window\.open/i,
        /document\.write/i,
        /document\.execCommand/i,
        /form\.submit/i,
        /\.submit\(\s*\)/i,
        /\.click\(\s*\)/i,
        /file:\/\//i,
    ];

    function containsSensitiveApi(code) {
        for (var si = 0; si < SENSITIVE_API_PATTERNS.length; si++) {
            if (SENSITIVE_API_PATTERNS[si].test(code)) {
                return SENSITIVE_API_PATTERNS[si];
            }
        }
        return null;
    }

    var browserState = {
        lastActiveId: null,   // 最近一次操作的窗口 ID
        lastIdentifyResult: '' // 最近一次识别的结果
    };

    // ==================== 工具注册 ====================

    window.__dsagent_tools.register({
        name: 'local-browser',
        scope: '创建和管理浏览器窗口，执行 JavaScript 控制台命令，截图并通过 Qwen 识别页面内容',
        description: '在本地创建独立的浏览器窗口，可执行 JS 控制台代码、截取页面截图、并通过 Qwen 视觉识别页面内容以辅助自动化操作。\n\n'
            + '使用方式：在代码块中写入子命令，每个命令占据一行。\n\n'
            + '**子命令列表：**\n\n'
            + '1. `browser.create url=https://example.com` — 创建新浏览器窗口\n'
            + '2. `browser.console id=xxx` + JS 代码 — 在窗口中执行 JavaScript\n'
            + '3. `browser.screenshot id=xxx name=xxx` — 截取窗口截图\n'
            + '4. `browser.identify id=xxx` — 截图 + Qwen 识别页面内容\n'
            + '5. `browser.close id=xxx` — 关闭窗口\n'
            + '6. `browser.list` — 列出所有已打开的窗口\n'
            + '7. `browser.navigate id=xxx url=xxx` — 导航到新 URL\n'
            + '8. `browser.resize id=xxx width=1024 height=768` — 调整窗口大小',
        params: [
            { name: '子命令', type: '字符串', default: '—', required: true, description: 'browser.create / browser.console / browser.screenshot / browser.identify / browser.close / browser.list / browser.navigate / browser.resize' },
            { name: 'id', type: '字符串', default: '最近使用的窗口', required: false, description: '窗口 ID（由 browser.create 返回）' },
            { name: 'url', type: '字符串', default: '—', required: false, description: '要打开的 URL' },
            { name: 'name', type: '字符串', default: '自动生成', required: false, description: '截图文件名（不含扩展名）' },
            { name: 'width', type: '数字', default: '1024', required: false, description: '窗口宽度' },
            { name: 'height', type: '数字', default: '768', required: false, description: '窗口高度' }
        ],
        usage: '# 1. 创建浏览器窗口\nbrowser.create\nurl=https://www.baidu.com\n\n# 2. 执行控制台代码（获取页面信息）\nbrowser.console\nid=browser-1\ndocument.title\n\n# 3. 点击页面元素\nbrowser.console\nid=browser-1\ndocument.querySelector("#search-button").click()\n\n# 4. 截图\nbrowser.screenshot\nid=browser-1\nname=my_screenshot\n\n# 5. 识别页面（截图+Qwen 自动分析）\nbrowser.identify\nid=browser-1\n\n# 6. 导航到新页面\nbrowser.navigate\nid=browser-1\nurl=https://www.example.com\n\n# 7. 列出所有窗口\nbrowser.list\n\n# 8. 关闭窗口\nbrowser.close\nid=browser-1',
        notes: '1. browser.identify 会先截图保存到 .dsa/temp/，然后自动调用 local-qwen 进行视觉分析\n'
            + '2. 识别结果会返回页面布局、功能按钮位置等信息，方便后续编写精确的控制台点击操作\n'
            + '3. 如果已有窗口未指定 id，自动使用最近操作的窗口\n'
            + '4. 窗口被手动关闭后会自动清理，不会报错',
        handler: async function(content) {
            var lines = content.trim().split('\n');
            var firstLine = lines[0].trim().toLowerCase();

            // 提取子命令
            var subCmd = '';
            var cmdIdx = 0;
            for (var ci = 0; ci < lines.length; ci++) {
                var trimmed = lines[ci].trim().toLowerCase();
                if (trimmed.indexOf('browser.') === 0) {
                    subCmd = trimmed;
                    cmdIdx = ci;
                    break;
                }
            }

            if (!subCmd) {
                throw new Error('缺少子命令。请以 browser.create、browser.console、browser.screenshot、browser.identify、browser.close、browser.list、browser.navigate 或 browser.resize 开头');
            }

            // 子命令后面的内容
            var restContent = lines.slice(cmdIdx + 1).join('\n');
            var parsed = parseBrowserParams(restContent);
            var params = parsed.params;

            switch (subCmd) {
                // ==================== create ====================
                case 'browser.create': {
                    var url = urlFromParams(params);
                    var width = parseInt(params.width) || 1024;
                    var height = parseInt(params.height) || 768;
                    var title = params.title || '';
                    var frame = params.frame !== 'false';

                    var res = await window.electronAPI.browserCreate({
                        url: url || undefined,
                        width: width,
                        height: height,
                        title: title || undefined,
                        frame: frame
                    });

                    if (!res.success) throw new Error(res.error);
                    browserState.lastActiveId = res.id;
                    return '✅ 浏览器窗口已创建\n\n窗口 ID: `' + res.id + '`\n地址: ' + (url || '(空白页)') + '\n大小: ' + width + 'x' + height + '\n\n请使用 browser.console id=' + res.id + ' 执行 JS，或 browser.screenshot id=' + res.id + ' 截图。';
                }

                // ==================== console ====================
                case 'browser.console': {
                    var winId = getActiveWindowId(params, browserState);
                    if (!winId) throw new Error('未指定窗口 ID，并且没有最近使用的窗口。请先使用 browser.create 创建窗口，或指定 id=xxx 参数');

                    var code = parsed.body;
                    if (!code) throw new Error('缺少要执行的 JavaScript 代码。请在子命令下方写入要执行的代码。');

                    // 敏感 API 检查（类似危险命令确认）
                    var matchedPattern = containsSensitiveApi(code);
                    if (matchedPattern) {
                        if (typeof window.__dsagent_confirmCommand === 'function') {
                            var confirmed = await window.__dsagent_confirmCommand('browser.console', code);
                            if (!confirmed) return '(用户取消了此行代码的执行)';
                        }
                    }

                    var res = await window.electronAPI.browserExecute(winId, code);
                    if (!res.success) throw new Error(res.error);

                    browserState.lastActiveId = winId;

                    // 格式化返回结果
                    var result = res.result;
                    var resultStr;
                    if (result === null || result === undefined) {
                        resultStr = '(null/undefined)';
                    } else if (typeof result === 'object') {
                        try {
                            resultStr = JSON.stringify(result, null, 2);
                            if (resultStr.length > 50000) {
                                resultStr = resultStr.substring(0, 50000) + '\n... (结果过长，已截断)';
                            }
                        } catch(e) {
                            resultStr = String(result);
                        }
                    } else {
                        resultStr = String(result);
                    }

                    return '✅ 控制台执行结果:\n\n```\n' + resultStr + '\n```';
                }

                // ==================== screenshot ====================
                case 'browser.screenshot': {
                    var winId = getActiveWindowId(params, browserState);
                    if (!winId) throw new Error('未指定窗口 ID，并且没有最近使用的窗口。请先使用 browser.create 创建窗口，或指定 id=xxx 参数');

                    var name = params.name || ('browser_screenshot_' + winId.replace('browser-', '') + '_' + Date.now());
                    // 确保 name 不含路径分隔符
                    name = name.replace(/[<>:"\/\\|?*]/g, '_');

                    var res = await window.electronAPI.browserScreenshot(winId, name);
                    if (!res.success) throw new Error(res.error);

                    browserState.lastActiveId = winId;
                    return '✅ 截图已保存\n\n路径: `' + res.path + '`\n大小: ' + res.size.width + 'x' + res.size.height + '\n\n如需识别页面内容，请使用 browser.identify';
                }

                // ==================== identify ====================
                case 'browser.identify': {
                    var winId = getActiveWindowId(params, browserState);
                    if (!winId) throw new Error('未指定窗口 ID，并且没有最近使用的窗口。请先使用 browser.create 创建窗口，或指定 id=xxx 参数');

                    browserState.lastActiveId = winId;

                    // 1. 截图
                    var name = 'browser_identify_' + winId.replace('browser-', '') + '_' + Date.now();
                    var shotRes = await window.electronAPI.browserScreenshot(winId, name);
                    if (!shotRes.success) throw new Error('截图失败: ' + shotRes.error);

                    // 2. 调用 local-qwen 进行视觉分析
                    if (typeof window.__dsagent_qwenVision !== 'function') {
                        throw new Error('Qwen 视觉分析功能不可用。截图已保存至: ' + shotRes.path);
                    }

                    var qwenPrompt = '请仔细分析这张浏览器页面截图，告诉我：\n'
                        + '1. 当前页面的整体布局和主要内容\n'
                        + '2. 所有可见的按钮、链接、输入框等交互元素的位置（用截图中的相对位置描述，如"左上角搜索框"、"右侧登录按钮"）\n'
                        + '3. 页面上显示的文字内容摘要\n'
                        + '4. 如果要实现某个操作（如搜索、点击、填写表单），应该使用什么 JavaScript 选择器或坐标\n\n'
                        + '请详细描述，以便我能在此浏览器窗口中执行精确的控制台操作。';

                    var identifyResult = await window.__dsagent_qwenVision(
                        'path="' + shotRes.path + '"\n' + qwenPrompt
                    );

                    // 缓存识别结果
                    browserState.lastIdentifyResult = identifyResult;

                    return '✅ 页面识别完成\n\n截图路径: `' + shotRes.path + '`\n\n--- Qwen 分析结果 ---\n\n' + identifyResult;
                }

                // ==================== close ====================
                case 'browser.close': {
                    var winId = getActiveWindowId(params, browserState);
                    if (!winId) throw new Error('未指定窗口 ID，并且没有最近使用的窗口。请指定 id=xxx 参数');

                    var res = await window.electronAPI.browserClose(winId);
                    if (!res.success) throw new Error(res.error);

                    // 如果关闭的是最近使用的窗口，清除记录
                    if (browserState.lastActiveId === winId) {
                        browserState.lastActiveId = null;
                    }

                    return '✅ 窗口 ' + winId + ' 已关闭';
                }

                // ==================== list ====================
                case 'browser.list': {
                    var res = await window.electronAPI.browserList();
                    if (!res.success) throw new Error(res.error);

                    if (res.windows.length === 0) {
                        return '当前没有打开的浏览器窗口。请使用 browser.create 创建新窗口。';
                    }

                    var output = '当前打开的浏览器窗口（' + res.windows.length + ' 个）:\n\n';
                    for (var wi = 0; wi < res.windows.length; wi++) {
                        var w = res.windows[wi];
                        output += '**' + w.id + '**\n';
                        output += '- 标题: ' + (w.title || '(无标题)') + '\n';
                        output += '- URL: ' + (w.url || '(空白)') + '\n';
                        output += '- 大小: ' + (w.width || '?') + 'x' + (w.height || '?') + '\n';
                        if (wi < res.windows.length - 1) output += '\n';
                    }

                    return output;
                }

                // ==================== navigate ====================
                case 'browser.navigate': {
                    var winId = getActiveWindowId(params, browserState);
                    if (!winId) throw new Error('未指定窗口 ID，并且没有最近使用的窗口。请先使用 browser.create 创建窗口，或指定 id=xxx 参数');

                    var url = urlFromParams(params);
                    if (!url) throw new Error('缺少 URL。请指定 url=xxx 参数');

                    var res = await window.electronAPI.browserNavigate(winId, url);
                    if (!res.success) throw new Error(res.error);

                    browserState.lastActiveId = winId;
                    return '✅ 窗口 ' + winId + ' 已导航至: ' + url;
                }

                // ==================== resize ====================
                case 'browser.resize': {
                    var winId = getActiveWindowId(params, browserState);
                    if (!winId) throw new Error('未指定窗口 ID，并且没有最近使用的窗口。请先使用 browser.create 创建窗口，或指定 id=xxx 参数');

                    var width = parseInt(params.width) || 1024;
                    var height = parseInt(params.height) || 768;

                    var res = await window.electronAPI.browserResize(winId, width, height);
                    if (!res.success) throw new Error(res.error);

                    browserState.lastActiveId = winId;
                    return '✅ 窗口 ' + winId + ' 大小已调整为 ' + width + 'x' + height;
                }

                default:
                    throw new Error('未知子命令: ' + subCmd + '。支持的子命令: browser.create, browser.console, browser.screenshot, browser.identify, browser.close, browser.list, browser.navigate, browser.resize');
            }
        }
    });

    window.__dsagent_tools._browser_registered = true;
})();