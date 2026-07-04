// open_file - 用系统默认程序打开文件（AtomCode 等效工具）
// 浏览器预览 HTML/图片，PDF 阅读器打开 PDF 等
// 用法: {"file_path": "report.html"}, {"file_path": "D:/images/screenshot.png"}
;(function() {
    if (window.__dsagent_tools && window.__dsagent_tools._open_file_registered) return;

    window.__dsagent_tools.register({
        name: 'open_file',
        scope: '用系统默认程序打开文件（浏览器看图/PDF/HTML）',
        description: '在用户的默认 GUI 应用程序中打开文件。图片/HTML 会在浏览器中打开，' +
            'PDF 在 PDF 阅读器中打开，其他文件用系统关联程序打开。' +
            '不会返回文件内容，仅负责打开操作。',
        params: [
            { name: 'file_path', type: '字符串', default: '—', required: true, description: '要打开的文件路径（绝对或相对路径）' }
        ],
        usage: '{"file_path": "report.html"}\n\n{"file_path": "screenshot.png"}\n\n{"file_path": "D:\\\\project\\\\result.pdf"}',
        notes: '路径相对于当前工作目录。如果是 headless/SSH 环境，打开操作可能失败。',
        handler: async function(params, body) {
            var makeResult = window.__dsagent_tools.makeResult;
            var filePath = params.file_path || '';

            if (!filePath && body) {
                var trimmed = body.trim();
                var kv = (typeof window.__dsagent_parseKeyValuePairs === 'function')
                    ? window.__dsagent_parseKeyValuePairs(body)
                    : {};
                filePath = kv.file_path || kv.path || trimmed;
            }

            if (!filePath) return makeResult(false, null, 'Missing file_path');

            // 验证文件存在
            try {
                var infoRes = await window.electronAPI.agentInfo(filePath);
                if (!infoRes || !infoRes.success) {
                    return makeResult(false, null, '文件不存在: ' + filePath);
                }
                if (infoRes.isDirectory) {
                    return makeResult(false, null, '路径是目录，不是文件: ' + filePath);
                }

                // 调用 Electron shell.openPath
                if (window.electronAPI && window.electronAPI.openFile) {
                    var openRes = await window.electronAPI.openFile(filePath);
                    if (openRes && openRes.success !== false) {
                        return makeResult(true, '已打开: ' + filePath);
                    }
                    return makeResult(false, null, '打开文件失败: ' + (openRes && openRes.error || 'unknown'));
                } else {
                    return makeResult(false, null, '当前环境不支持打开文件（electronAPI.openFile 不可用）');
                }
            } catch (e) {
                return makeResult(false, null, 'open_file 错误: ' + (e.message || e));
            }
        }
    });

    window.__dsagent_tools._open_file_registered = true;
})();
