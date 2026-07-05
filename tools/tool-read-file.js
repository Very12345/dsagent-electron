// read_file - 读取文件内容（AtomCode 标准命名 + offset/limit 行切片）
// 别名 read 保留向后兼容
// 用法: {"file_path": "main.js"}, {"file_path": "big.log", "offset": 100, "limit": 50}
;(function() {
    if (window.__dsagent_tools && window.__dsagent_tools._read_file_registered) return;

    var BINARY_EXTS = ['exe', 'dll', 'bin', 'zip', 'rar', '7z', 'tar', 'gz', 'mp3', 'mp4', 'avi', 'mkv', 'mov', 'wmv', 'flv', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'ttf', 'otf', 'woff', 'woff2', 'eot', 'iso', 'img', 'dmg', 'pkg', 'apk', 'ipa', 'msi', 'dat', 'db', 'sqlite', 'mdb', 'accdb', 'class', 'o', 'obj', 'lib', 'a', 'so', 'dylib'];
    var IMAGE_EXTS = ['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp', 'svg', 'ico', 'pdf'];

    window.__dsagent_tools.register({
        name: ['read_file', 'read'],
        scope: '读取文件内容到当前对话中',
        description: '读取本地文件的内容，返回带行号的前缀（`<n>\\t<content>`）。' +
            '对于大文件，使用 `offset` 和 `limit` 切片读取。' +
            '使用 `mode: "image"` 可读取图片/PDF 并上传到对话中。' +
            '超过 2MB 的文件请改用 readslice 切片读取。',
        params: [
            { name: 'file_path', type: '字符串', default: '—', required: true, description: '文件路径，支持绝对路径和相对路径' },
            { name: 'offset', type: '数字', default: '—', required: false, description: '起始行号（1-based），省略则从开头读取' },
            { name: 'limit', type: '数字', default: '—', required: false, description: '最大行数，省略则读取到文件末尾' },
            { name: 'mode', type: '字符串', default: 'text', required: false, description: 'image 模式可读取图片/PDF 上传到对话' },
            { name: 'force', type: '布尔', default: 'false', required: false, description: '强制读取大文件（超过 10KB）' }
        ],
        usage: '{"file_path": "src/main.js"}\n\n{"file_path": "server.log", "offset": 100, "limit": 50}\n\n{"file_path": "screenshot.png", "mode": "image"}',
        notes: 'offset 和 limit 是行级切片。mode=image 可读取图片/PDF 上传到对话。大文件请用 readslice。',
        handler: async function(params, body) {
            var makeResult = window.__dsagent_tools.makeResult;
            var filePath = params.file_path || params.path || '';
            var offset = parseInt(params.offset) || 0;
            var limit = parseInt(params.limit) || 0;
            var mode = params.mode || 'text';
            var force = params.force === true;

            // 兼容旧参数名 path（从 body 解析也支持）
            if (!filePath && body) {
                var kv = (typeof window.__dsagent_parseKeyValuePairs === 'function')
                    ? window.__dsagent_parseKeyValuePairs(body)
                    : {};
                filePath = kv.file_path || kv.path || body.trim();
                mode = kv.mode || mode;
                force = kv.force === 'true' || force;
                offset = parseInt(kv.offset) || offset;
                limit = parseInt(kv.limit) || limit;
            }

            filePath = filePath.trim();
            if (!filePath) return makeResult(false, null, 'Missing file_path');

            var ext = filePath.toLowerCase().split('.').pop();
            var isImage = IMAGE_EXTS.indexOf(ext) !== -1;

            // 图片/PDF 模式
            if (mode === 'image' && isImage) {
                var fileRes = await window.electronAPI.agentReadFile(filePath);
                if (!fileRes.success) return makeResult(false, null, fileRes.error);
                try {
                    var fileInput = document.querySelector('input[type="file"]');
                    if (fileInput) {
                        var binaryString = window.atob(fileRes.data);
                        var bytes = new Uint8Array(binaryString.length);
                        for (var bi = 0; bi < binaryString.length; bi++) {
                            bytes[bi] = binaryString.charCodeAt(bi);
                        }
                        var blob = new Blob([bytes], { type: fileRes.mime || 'image/png' });
                        var file = new File([blob], fileRes.name, { type: fileRes.mime || 'image/png' });
                        var dt = new DataTransfer();
                        dt.items.add(file);
                        fileInput.files = dt.files;
                        fileInput.dispatchEvent(new Event('change', { bubbles: true }));
                        return makeResult(true, '已上传: ' + fileRes.name + ' (' + (fileRes.size / 1024).toFixed(1) + 'KB)');
                    }
                    return makeResult(false, null, '未找到文件上传控件');
                } catch(e) {
                    return makeResult(false, null, '上传失败: ' + (e.message || e));
                }
            }

            // 二进制文件检测
            if (BINARY_EXTS.indexOf(ext) !== -1 && offset === 0 && limit === 0) {
                var infoRes = await window.electronAPI.agentInfo(filePath);
                if (infoRes && infoRes.success && infoRes.size > 0) {
                    return makeResult(true, '[Binary file: ' + filePath + ' (' + (infoRes.size / 1024).toFixed(1) + ' KB)]');
                }
            }

            // 读取文件
            try {
                var readRes = await window.electronAPI.agentRead(filePath);
                if (!readRes || !readRes.success) return makeResult(false, null, readRes ? readRes.error : 'Read failed');

                var content = readRes.content || '';
                var info = readRes;

                // 行切片
                if (offset > 0 || limit > 0) {
                    var lines = content.split('\n');
                    var startIdx = Math.max(0, offset - 1); // offset 是 1-based
                    var endIdx = limit > 0 ? Math.min(lines.length, startIdx + limit) : lines.length;
                    var sliced = lines.slice(startIdx, endIdx);
                    var output = '';
                    for (var li = startIdx; li < endIdx; li++) {
                        output += (li + 1) + '\t' + lines[li] + '\n';
                    }
                    var totalLines = lines.length;
                    var infoLine = '\n[Lines ' + (startIdx + 1) + '-' + endIdx + ' / ' + totalLines + ']';
                    return makeResult(true, output + infoLine);
                }

                return makeResult(true, content);
            } catch (e) {
                return makeResult(false, null, '读取失败: ' + (e.message || e));
            }
        }
    });

    window.__dsagent_tools._read_file_registered = true;
})();
