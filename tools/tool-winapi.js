// winapi - Windows API 调用（窗口管理、自动化）
;(function() {
    if (window.__dsagent_tools && window.__dsagent_tools._winapi_registered) return;

    window.__dsagent_tools.register({
        name: 'winapi',
        scope: '调用 Windows API 进行窗口管理和自动化操作',
        description: '调用 Windows API 进行窗口查找、点击、输入等自动化操作。\n\n子命令：winapi.list / winapi.find / winapi.click / winapi.type / winapi.info / winapi.screenshot / winapi.activate',
        params: [
            { name: 'action', type: '字符串', default: '—', required: true, description: '子命令：list / find / click / type / info / screenshot / activate' },
            { name: 'id', type: '数字', default: '—', required: false, description: '窗口 ID' },
            { name: 'x', type: '数字', default: '—', required: false, description: 'X 坐标' },
            { name: 'y', type: '数字', default: '—', required: false, description: 'Y 坐标' },
            { name: 'text', type: '字符串', default: '—', required: false, description: '要输入的文本' }
        ],
        usage: '<tool:winapi>{"action": "list"}</tool:winapi>\n\n<tool:winapi>{"action": "click", "id": 1, "x": 100, "y": 200}</tool:winapi>',
        notes: '需要 Windows 平台支持。',
        handler: async function(params, body) {
            var makeResult = window.__dsagent_tools.makeResult;
            var action = params.action || '';
            if (!action && body) {
                var parts = body.trim().split(/\s+/);
                action = parts[0] || '';
            }
            var command = action;
            if (params.id) command += ' id=' + params.id;
            if (params.x) command += ' x=' + params.x;
            if (params.y) command += ' y=' + params.y;
            if (params.text) command += ' text="' + params.text + '"';
            try {
                var res = await window.electronAPI.winapiInvoke(command);
                if (res && res.success) {
                    return makeResult(true, res.result || res.data || 'OK');
                }
                return makeResult(false, null, (res && res.error) || 'winapi 调用失败');
            } catch(e) {
                return makeResult(false, null, e.message || 'winapi 调用异常');
            }
        }
    });
    window.__dsagent_tools._winapi_registered = true;
})();