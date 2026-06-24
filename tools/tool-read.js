// local-read - 读取文件内容
;(function() {
    if (window.__dsagent_tools && window.__dsagent_tools._read_registered) return;

    // 快速/识图模式下允许读取的常见二进制文件
    var QUICK_BINARY_EXTS = ['pdf', 'jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp', 'svg', 'ico'];
    // 专业模式下拒绝的二进制文件
    var BINARY_EXTS = ['pdf', 'exe', 'dll', 'bin', 'zip', 'rar', '7z', 'tar', 'gz', 'jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp', 'ico', 'mp3', 'mp4', 'avi', 'mkv', 'mov', 'wmv', 'flv', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'ttf', 'otf', 'woff', 'woff2', 'eot', 'iso', 'img', 'dmg', 'pkg', 'apk', 'ipa', 'msi', 'dat', 'db', 'sqlite', 'mdb', 'accdb', 'class', 'o', 'obj', 'lib', 'a', 'so', 'dylib'];
    var IMAGE_EXTS = ['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp', 'svg', 'ico'];

    window.__dsagent_tools.register({
        name: 'local-read',
        scope: '读取文本文件内容到对话中，快速/识图模式下支持读取常见图片和 PDF',
        description: '读取本地文件的内容并返回。\n'
            + '- `professional` 模式：仅支持文本文件，有大小限制，适合精确编辑场景\n'
            + '- `quick` 模式：支持文本和常见图片/PDF，文件直接传入对话\n'
            + '- `image` 模式：与 quick 相同，但禁用深度思考，适合看图场景\n'
            + '超过 2MB 的文件需要改用 local-subreader。',
        params: [
            { name: 'path', type: '字符串', default: '—', required: true, description: '文件路径（必填），支持绝对路径和相对路径' },
            { name: 'mode', type: '字符串', default: 'professional', required: false, description: '模式：professional / quick / image' },
            { name: 'force', type: '布尔', default: 'false', required: false, description: '强制读取大文件（超过 10KB）' }
        ],
        usage: '{"tool": "read", "params": {"path": "screenshot.png", "mode": "image"}}\n\n{"tool": "read", "params": {"path": "doc.pdf", "mode": "quick"}}',
        notes: '专业模式下仅支持文本文件。快速/识图模式下支持 PDF、图片等常见格式。图片文件会自动上传到对话中，PDF 以 file 引用形式返回。',
        handler: async function(params, body) {
            var makeResult = window.__dsagent_tools.makeResult;
            var filePath = params.path || '';
            var mode = params.mode || 'professional';
            var force = params.force === true;

            // Backward compat: parse from body
            if (!filePath && body) {
                var kv = window.__dsagent_parseKeyValuePairs(body);
                filePath = kv.path || body.trim();
                mode = kv.mode || 'professional';
                force = kv.force === 'true';
            }
            
            filePath = filePath.trim();
            if (!filePath) return makeResult(false, null, 'Missing file path');

            var ext = filePath.toLowerCase().split('.').pop();
            var isQuickMode = (mode === 'quick' || mode === 'image');
            var isImage = IMAGE_EXTS.indexOf(ext) !== -1;

            // 二进制文件处理
            if (BINARY_EXTS.indexOf(ext) !== -1) {
                if (isQuickMode && QUICK_BINARY_EXTS.indexOf(ext) !== -1) {
                    // 快速/识图模式：允许读取 PDF 和图片
                    var fileRes = await window.electronAPI.agentReadFile(filePath);
                    if (!fileRes.success) return makeResult(false, null, fileRes.error);
                    
                    if (isImage) {
                        // 图片：上传到当前对话
                        try {
                            var fileInput = document.querySelector('input[type="file"]');
                            if (fileInput) {
                                var binaryString = window.atob(fileRes.data);
                                var bytes = new Uint8Array(binaryString.length);
                                for (var i = 0; i < binaryString.length; i++) {
                                    bytes[i] = binaryString.charCodeAt(i);
                                }
                                var blob = new Blob([bytes], { type: fileRes.mime || 'image/png' });
                                var file = new File([blob], fileRes.name, { type: fileRes.mime || 'image/png' });
                                var dt = new DataTransfer();
                                dt.items.add(file);
                                fileInput.files = dt.files;
                                fileInput.dispatchEvent(new Event('change', { bubbles: true }));
                                return makeResult(true, '已上传图片: ' + fileRes.name + ' (' + (fileRes.size / 1024).toFixed(1) + 'KB)\n\n```file\n' + filePath + '\n```');
                            }
                        } catch(e) {
                            return makeResult(false, null, '图片上传失败: ' + e.message);
                        }
                        // 回退：返回 file 引用
                        return makeResult(true, '```file\n' + filePath + '\n```\n\n> 图片: ' + fileRes.name + ' (' + (fileRes.size / 1024).toFixed(1) + 'KB)');
                    } else {
                        // PDF 等：返回 file 引用
                        return makeResult(true, '```file\n' + filePath + '\n```\n\n> 文件: ' + fileRes.name + ' (' + (fileRes.size / 1024).toFixed(1) + 'KB)');
                    }
                }
                // 专业模式：拒绝
                return makeResult(false, null, '文件 .' + ext + ' 是二进制格式，local-read 无法在专业模式下读取。请使用 mode=quick 或 mode=image 读取。');
            }
            
            // 文本文件：正常读取
            var infoRes = await window.electronAPI.agentInfo(filePath);
            if (infoRes.success && infoRes.size !== undefined) {
                if (infoRes.size > 2 * 1024 * 1024) {
                    return makeResult(false, null, '文件 ' + (infoRes.size / 1024 / 1024).toFixed(1) + 'MB 超过 2MB，local-read 无法处理。请使用 local-subreader mode=quick 快速模式读取。');
                }
                if (mode === 'professional' && infoRes.size > 10 * 1024) {
                    var sizeKB = Math.round(infoRes.size / 1024);
                    if (!force) {
                        return makeResult(true, '⚠️ 文件大小警告：该文件 ' + sizeKB + 'KB（超过 10KB），可能会占用大量上下文。\n如需读取完整内容，请在 params 中添加 "force": true。\n\n> 建议使用 local-subreader 并添加分析指令来获取摘要。');
                    }
                }
            }
            
            var res = await window.electronAPI.agentRead(filePath);
            if (!res.success) return makeResult(false, null, res.error);
            return makeResult(true, res.content);
        }
    });
    window.__dsagent_tools._read_registered = true;
})();