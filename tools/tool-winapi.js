// local-winapi - Windows 原生窗口操作
// 通过 Win32 API 列举、点击、输入、截图、识别
;(function() {
    'use strict';

    if (window.__dsagent_tools && window.__dsagent_tools._winapi_registered) return;

    // 前端窗口有效性校验（兜底过滤幽灵窗口，但允许最小化窗口）
    function isValidWindow(w) {
        if (!w) return false;
        // 最小化窗口坐标为 (-32000,-32000)，尺寸为 0，但仍是有效窗口
        if (w.windowState === 'minimized') return true;
        return w.x > -10000 && w.y > -10000 &&
               w.width > 0 && w.height > 0;
    }

    // ==================== 状态管理 ====================
    var winapiState = {
        lastActiveId: null
    };

    // ==================== 子命令分发 ====================
    async function executeWinapi(content) {
        var lines = content.trim().split('\n');
        var firstLine = lines[0].trim();
        var parts = firstLine.split(/\s+/);
        var subCmd = parts[0] || '';

        // 解析参数：支持 inline（winapi.click id=123 x=100）和多行（每行一个 key=value）两种格式
        var params = {};
        var bodyLines = [];
        for (var li = 1; li < lines.length; li++) {
            var line = lines[li].trim();
            if (!line) continue;
            var eqIdx = line.indexOf('=');
            if (eqIdx > 0 && eqIdx < 10) {
                // 看起来是 key=value 格式
                var key = line.substring(0, eqIdx).trim();
                var val = line.substring(eqIdx + 1).trim();
                val = val.replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1');
                params[key] = val;
            } else if (li === 1 && eqIdx === -1) {
                // 第二行没有 = 号，可能是 body 内容（供 winapi.input/text/msg 使用）
                bodyLines.push(line);
            } else if (eqIdx > 0) {
                // 后面行有 = 号但位置 > 10，说明值本身含 =，作为 body
                bodyLines.push(line);
            } else {
                bodyLines.push(line);
            }
        }
        // 也解析第一行中的 inline 参数（winapi.click id=123 x=100）
        for (var pi = 1; pi < parts.length; pi++) {
            var kv = parts[pi].split('=');
            if (kv.length === 2) {
                params[kv[0].trim()] = kv[1].trim().replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1');
            }
        }
        // 优先使用 body 方式指定 text/msg（多行内容），其次 params
        params.msg = params.msg || bodyLines.join('\n').trim();
        params.text = params.text || bodyLines.join('\n').trim();

        try {
            switch (subCmd) {

                case 'winapi.list': {
                    var filter = params.filter || '';
                    var result = await window.electronAPI.winapiInvoke({
                        action: 'list',
                        params: { filter: filter }
                    });
                    if (!result.success) throw new Error(result.error);
                    if (result.count === 0) return '没有找到可见窗口' + (filter ? ' (筛选: ' + filter + ')' : '');
                    // 双重过滤：后端已清理幽灵窗口，前端再兜底
                    var validWindows = result.windows.filter(isValidWindow);
                    if (validWindows.length === 0) return '没有找到有效窗口（所有窗口均为不可见/幽灵窗口）';
                    var table = '| ID | 标题 | 进程 | 状态 | 位置 | 尺寸 |\n|---|---|---|---|---|---|\n';
                    for (var wi = 0; wi < validWindows.length; wi++) {
                        var w = validWindows[wi];
                        var title = w.title.length > 30 ? w.title.substring(0, 27) + '...' : w.title;
                        var stateIcon = w.windowState === 'minimized' ? '▬' : w.windowState === 'maximized' ? '☐' : '•';
                        table += '| ' + w.id + ' | ' + title + ' | ' + w.processName + ' | ' + stateIcon + w.windowState + ' | (' + w.x + ',' + w.y + ') | ' + w.width + '×' + w.height + ' |\n';
                    }
                    return '找到 ' + validWindows.length + ' 个窗口：\n\n' + table;
                }

                case 'winapi.find': {
                    var title = params.title || '';
                    var procName = params.process || '';
                    var result = await window.electronAPI.winapiInvoke({
                        action: 'find',
                        params: { title: title, processName: procName }
                    });
                    if (!result.success) throw new Error(result.error);
                    if (result.count === 0) return '未找到匹配的窗口';
                    var validWindows = result.windows.filter(isValidWindow);
                    if (validWindows.length === 0) return '未找到有效窗口（所有匹配窗口均为幽灵窗口）';
                    winapiState.lastActiveId = validWindows[0].id;
                    var table = '| ID | 标题 | 进程 | 状态 | 位置 | 尺寸 |\n|---|---|---|---|---|---|\n';
                    for (var fi = 0; fi < validWindows.length; fi++) {
                        var f = validWindows[fi];
                        var ftitle = f.title.length > 30 ? f.title.substring(0, 27) + '...' : f.title;
                        var fStateIcon = f.windowState === 'minimized' ? '▬' : f.windowState === 'maximized' ? '☐' : '•';
                        table += '| ' + f.id + ' | ' + ftitle + ' | ' + f.processName + ' | ' + fStateIcon + f.windowState + ' | (' + f.x + ',' + f.y + ') | ' + f.width + '×' + f.height + ' |\n';
                    }
                    return '找到 ' + validWindows.length + ' 个匹配窗口：\n\n' + table;
                }

                case 'winapi.info': {
                    var winId = params.id || winapiState.lastActiveId;
                    if (!winId) throw new Error('未指定窗口 ID，也没有最近使用的窗口。请先用 winapi.list 或 winapi.find 查找窗口。');
                    var result = await window.electronAPI.winapiInvoke({
                        action: 'info',
                        params: { id: winId }
                    });
                    if (!result.success) throw new Error(result.error);
                    var wi = result.window;
                    return '📋 窗口信息：\n\n'
                        + '- ID：' + wi.id + '\n'
                        + '- 标题：' + wi.title + '\n'
                        + '- 类名：' + wi.className + '\n'
                        + '- 进程：' + wi.processName + ' (PID: ' + wi.processId + ')\n'
                        + '- 状态：' + (wi.windowState || 'unknown') + '\n'
                        + '- 位置：(' + wi.x + ', ' + wi.y + ')\n'
                        + '- 尺寸：' + wi.width + ' × ' + wi.height;
                }

                case 'winapi.click': {
                    var winId = params.id || winapiState.lastActiveId;
                    if (!winId) throw new Error('未指定窗口 ID');
                    var x = parseInt(params.x) || 0;
                    var y = parseInt(params.y) || 0;
                    var button = params.button || 'left';
                    var result = await window.electronAPI.winapiInvoke({
                        action: 'click',
                        params: { id: winId, x: x, y: y, button: button }
                    });
                    if (!result.success) throw new Error(result.error);
                    winapiState.lastActiveId = winId;
                    return result.message;
                }

                case 'winapi.input': {
                    var winId = params.id || winapiState.lastActiveId;
                    if (!winId) throw new Error('未指定窗口 ID');
                    var text = params.text;
                    if (!text) throw new Error('缺少要输入的文本。请在子命令下方写入文本，或指定 text=xxx');
                    var result = await window.electronAPI.winapiInvoke({
                        action: 'input',
                        params: { id: winId, text: text }
                    });
                    if (!result.success) throw new Error(result.error);
                    winapiState.lastActiveId = winId;
                    return result.message;
                }

                case 'winapi.screenshot': {
                    var winId = params.id || winapiState.lastActiveId;
                    if (!winId) throw new Error('未指定窗口 ID');
                    var result = await window.electronAPI.winapiInvoke({
                        action: 'screenshot',
                        params: { id: winId }
                    });
                    if (!result.success) throw new Error(result.error);
                    winapiState.lastActiveId = winId;
                    return '✅ 截图已保存：\n路径：' + result.path + '\n尺寸：' + result.width + ' × ' + result.height;
                }

                case 'winapi.identify': {
                    var winId = params.id || winapiState.lastActiveId;
                    if (!winId) throw new Error('未指定窗口 ID');
                    var gridVal = parseInt(params.grid) || 0;
                    var ssResult = await window.electronAPI.winapiInvoke({
                        action: 'screenshot',
                        params: { id: winId, grid: gridVal }
                    });
                    if (!ssResult.success) throw new Error(ssResult.error);
                    winapiState.lastActiveId = winId;

                    if (typeof window.__dsagent_qwenVision !== 'function') {
                        throw new Error('Qwen 视觉分析功能不可用。截图已保存至: ' + ssResult.path);
                    }

                    var identifyPrompt = 'path="' + ssResult.path + '"\n'
                        + '请详细描述这个窗口的内容：包含所有可见的文本、按钮、输入框、列表等 UI 元素及其大致位置（坐标范围），以便后续进行点击或输入操作。';
                    if (gridVal > 0) {
                        identifyPrompt += '\n注意：截图顶部和左侧有彩色圆点作为坐标参考点，每 ' + gridVal + ' 像素一个点，每 100 像素标注了数字坐标。请利用这些坐标点精确定位 UI 元素的位置。';
                    }
                    var extraMsg = params.msg || '';
                    if (extraMsg) {
                        identifyPrompt += '\n\n附加要求：' + extraMsg;
                    }

                    var qwenResult = await window.__dsagent_qwenVision(identifyPrompt);
                    return '✅ 识别完成：\n\n' + qwenResult;
                }

                case 'winapi.focus': {
                    var winId = params.id || winapiState.lastActiveId;
                    if (!winId) throw new Error('未指定窗口 ID');
                    var result = await window.electronAPI.winapiInvoke({
                        action: 'focus',
                        params: { id: winId }
                    });
                    if (!result.success) throw new Error(result.error);
                    winapiState.lastActiveId = winId;
                    return result.message;
                }

                case 'winapi.move': {
                    var winId = params.id || winapiState.lastActiveId;
                    if (!winId) throw new Error('未指定窗口 ID');
                    var x = parseInt(params.x) || 0;
                    var y = parseInt(params.y) || 0;
                    var width = parseInt(params.width) || 800;
                    var height = parseInt(params.height) || 600;
                    var result = await window.electronAPI.winapiInvoke({
                        action: 'move',
                        params: { id: winId, x: x, y: y, width: width, height: height }
                    });
                    if (!result.success) throw new Error(result.error);
                    winapiState.lastActiveId = winId;
                    return result.message;
                }

                default:
                    throw new Error('未知子命令: ' + subCmd + '\n\n可用命令：\n- winapi.list [filter=xxx]\n- winapi.find [title=xxx] [process=xxx]\n- winapi.info [id=xxx]\n- winapi.click id=xxx x=100 y=200 [button=left/right]\n- winapi.input id=xxx text="..."\n- winapi.screenshot [id=xxx]\n- winapi.identify [id=xxx]\n- winapi.focus [id=xxx]\n- winapi.move [id=xxx] x=100 y=100 width=800 height=600');
            }
        } catch (e) {
            return '[错误] ' + e.message;
        }
    }

    // ==================== 工具注册 ====================

    window.__dsagent_tools.register({
        name: 'local-winapi',
        scope: '操作 Windows 原生窗口（非浏览器），支持枚举、点击、输入、截图、通过 Qwen 识别窗口内容',
        description: '通过 Win32 API 操作操作系统级别的窗口，可以列举所有可见窗口、获取窗口信息、模拟鼠标点击和键盘输入、截取窗口截图，并通过 Qwen 视觉识别窗口内容以辅助自动化操作。\n\n'
            + '使用方式：在代码块中写入子命令，每个命令占据一行。\n\n'
            + '**子命令列表：**\n\n'
            + '1. `winapi.list [filter=xxx]` — 列举所有可见窗口，可选按标题筛选\n'
            + '2. `winapi.find [title=xxx] [process=xxx]` — 按标题或进程名查找窗口\n'
            + '3. `winapi.info [id=xxx]` — 获取窗口详细信息\n'
            + '4. `winapi.click id=xxx x=100 y=200 [button=left/right]` — 在窗口内模拟点击\n'
            + '5. `winapi.input id=xxx text="xxx"` — 向窗口发送键盘输入\n'
            + '6. `winapi.screenshot [id=xxx] [grid=50]` — 截取窗口截图，可选添加坐标网格\n'
            + '7. `winapi.identify [id=xxx] [grid=50] [msg="xxx"]` — 截图 + Qwen 识别窗口内容\n'
            + '8. `winapi.focus [id=xxx]` — 将窗口置前\n'
            + '9. `winapi.move [id=xxx] x=100 y=100 width=800 height=600` — 移动/调整窗口大小',
        params: [
            { name: '子命令', type: '字符串', default: '—', required: true, description: 'winapi.list / winapi.find / winapi.info / winapi.click / winapi.input / winapi.screenshot / winapi.identify / winapi.focus / winapi.move' },
            { name: 'id', type: '字符串', default: '最近使用的窗口', required: false, description: '窗口 ID（由 winapi.list 或 winapi.find 返回）' },
            { name: 'x', type: '数字', default: '0', required: false, description: '点击/移动的 X 坐标' },
            { name: 'y', type: '数字', default: '0', required: false, description: '点击/移动的 Y 坐标' },
            { name: 'button', type: '字符串', default: 'left', required: false, description: '鼠标键: left/right' },
            { name: 'text', type: '字符串', default: '—', required: false, description: '要输入的文本' },
            { name: 'title', type: '字符串', default: '—', required: false, description: '窗口标题关键词' },
            { name: 'process', type: '字符串', default: '—', required: false, description: '进程名关键词' },
            { name: 'width', type: '数字', default: '800', required: false, description: '窗口宽度' },
            { name: 'height', type: '数字', default: '600', required: false, description: '窗口高度' },
            { name: 'filter', type: '字符串', default: '—', required: false, description: '列表筛选关键词' },
            { name: 'grid', type: '数字', default: '0（不叠加）', required: false, description: '坐标网格间距（像素），每 grid 像素标注一个色点，每 100px 标注数字，帮助 AI 精确定位' },
            { name: 'msg', type: '字符串', default: '—', required: false, description: 'Qwen 识别的附加要求，例如"我只想知道登录按钮的位置"' }
        ],
        usage: '# 1. 列举窗口\nwinapi.list\n\n# 2. 按标题查找窗口\nwinapi.find\ntitle=微信\n\n# 3. 查看窗口详情\nwinapi.info\nid=123456\n\n# 4. 在窗口内点击\nwinapi.click\nid=123456\nx=200\ny=300\n\n# 5. 向窗口输入文本\nwinapi.input\nid=123456\ntext=你好世界\n\n# 6. 截图查看窗口（无网格）\nwinapi.screenshot\nid=123456\n\n# 7. 截图+坐标网格（每50像素标注）\nwinapi.screenshot\nid=123456\ngrid=50\n\n# 8. 识别窗口（带网格和附加消息）\nwinapi.identify\nid=123456\ngrid=50\nmsg=我只想知道登录按钮大概在哪\n\n# 9. 窗口置前\nwinapi.focus\nid=123456\n\n# 10. 移动窗口\nwinapi.move\nid=123456\nx=100\ny=100\nwidth=800\nheight=600',
        notes: '1. 窗口 ID 是 Windows 句柄的十进制数字表示\n'
            + '2. 使用 identify 前请确保 Qwen 页面已登录\n'
            + '3. 点击和输入操作会自动将窗口置前\n'
            + '4. 截图保存到 .dsa/temp/screenshots/ 目录\n'
            + '5. grid 参数在 screenshot 和 identify 中均可使用，设置为 0 或省略则不叠加坐标网格\n'
            + '6. msg 参数仅对 identify 有效，用于告诉 Qwen 你想关注哪部分内容',
        handler: executeWinapi
    });

    window.__dsagent_tools._winapi_registered = true;
    console.log('[DSAgent] local-winapi 工具已注册');
})();