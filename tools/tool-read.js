// read - 读取文件内容到主 AI 对话中
;(function() {
    if (window.__dsagent_tools && window.__dsagent_tools._read_registered) return;

    var BINARY_EXTS = ['exe', 'dll', 'bin', 'zip', 'rar', '7z', 'tar', 'gz', 'mp3', 'mp4', 'avi', 'mkv', 'mov', 'wmv', 'flv', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'ttf', 'otf', 'woff', 'woff2', 'eot', 'iso', 'img', 'dmg', 'pkg', 'apk', 'ipa', 'msi', 'dat', 'db', 'sqlite', 'mdb', 'accdb', 'class', 'o', 'obj', 'lib', 'a', 'so', 'dylib'];
    var IMAGE_EXTS = ['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp', 'svg', 'ico', 'pdf'];

    window.__dsagent_tools.register({
        name: 'read',
        scope: '读取文件内容到当前对话中',
        description: '读取本地文件的内容。\n'
            + '默认读取文本文件，使用 `mode: "image"` 可读取图片/PDF 并上传到对话中。\n'
            + '超过 2MB 的文件请改用 readslice 切片读取。',
        params: [
            { name: 'path', type: '字符串', default: '—', required: true, description: '文件路径（必填），支持绝对路径和相对路径' },
            { name: 'mode', type: '字符串', default: 'text', required: false, description: 'image 模式可读取图片/PDF 上传到对话' },
            { name: 'force', type: '布尔', default: 'false', required: false, description: '强制读取大文件（超过 10KB）' }
        ],
        usage: '<tool:read>{"path": "D:\\\\project\\\\main.js"}</tool:read>\n\n<tool:read>{"path": "screenshot.png", "mode": "image"}</tool:read>',
        notes: '默认仅支持文本文件。mode=image 可读取图片/PDF 上传到对话。大文件请用 readslice。',
        handler: async function(params, body) {
            var makeResult = window.__dsagent_tools.makeResult;
            var filePath = params.path || '';
            var mode = params.mode || 'text';
            var force = params.force === true;

            // Backward compat: parse from body
            if (!filePath && body) {
                var kv = window.__dsagent_parseKeyValuePairs(body);
                filePath = kv.path || body.trim();
                mode = kv.mode || 'text';
                force = kv.force === 'true';
            }
            
            filePath = filePath.trim();
            if (!filePath) return makeResult(false, null, 'Missing file path');

            var ext = filePath.toLowerCase().split('.').pop();
            var isImage = IMAGE_EXTS.indexOf(ext) !== -1;

            // 图片/PDF 模式：读取并上传到对话
            if (mode === 'image' && isImage) {
                var fileRes = await window.electronAPI.agentReadFile(filePath);
                if (!fileRes.success) return makeResult(false, null, fileRes.error);
                
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
                        return makeResult(true, '已上传: ' + fileRes.name + ' (' + (fileRes.size / 1024).toFixed(1) + 'KB)');
                    }
                } catch(e) {
                    return makeResult(false, null, '上传失败: ' + e.message);
                }
                return makeResult(true, '<file>' + filePath + '</file>\n\n> ' + fileRes.name + ' (' + (fileRes.size / 1024).toFixed(1) + 'KB)');
            }

            // 非图片模式但文件是图片：提示使用 image 模式
            if (isImage) {
                return makeResult(false, null, '文件 .' + ext + ' 是图片/PDF 格式，请使用 mode: "image" 读取。');
            }

            // 其他二进制文件：拒绝
            if (BINARY_EXTS.indexOf(ext) !== -1) {
                return makeResult(false, null, '文件 .' + ext + ' 是二进制格式，read 不支持。请使用 readslice 切片读取。');
            }
            
            // 文本文件：正常读取
            var infoRes = await window.electronAPI.agentInfo(filePath);
            if (infoRes.success && infoRes.size !== undefined) {
                if (infoRes.size > 2 * 1024 * 1024) {
                    return makeResult(false, null, '文件 ' + (infoRes.size / 1024 / 1024).toFixed(1) + 'MB 超过 2MB，read 无法处理。请使用 readslice 切片读取。');
                }
                if (infoRes.size > 10 * 1024) {
                    var sizeKB = Math.round(infoRes.size / 1024);
                    if (!force) {
                        return makeResult(true, '⚠️ 文件大小警告：该文件 ' + sizeKB + 'KB（超过 10KB），可能会占用大量上下文。\n如需读取完整内容，请在 params 中添加 "force": true。\n\n> 建议使用 readslice 切片读取来获取摘要。');
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