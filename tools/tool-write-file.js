// write_file - 创建或覆盖文件（AtomCode 标准命名）
// 别名 save 保留向后兼容。自动创建父目录。
// 用法: {"file_path": "src/utils.js", "content": "..."}
;(function() {
    if (window.__dsagent_tools && window.__dsagent_tools._write_file_registered) return;

    window.__dsagent_tools.register({
        name: ['write_file', 'save'],
        scope: '创建或覆盖文件（自动创建父目录）',
        description: '将内容写入文件。文件不存在则创建，已存在则覆盖。父目录不存在时自动创建。' +
            '对于已存在的文件，写入前会自动备份快照（可通过 /history 回滚）。' +
            '小修改请优先使用 edit_file。',
        params: [
            { name: 'file_path', type: '字符串', default: '—', required: true, description: '保存路径（绝对或相对路径）' },
            { name: 'content', type: '字符串', default: '—', required: false, description: '文件内容（也可放在 body 中）' }
        ],
        usage: '{"file_path": "src/utils.js", "content": "function hello() {\\n  console.log(\\"world\\");\\n}"}\n\n{"file_path": "notes.txt", "body": "文件内容\\n第二行"}',
        notes: '路径中的目录会自动创建。内容可放在 content 字段或 body 字段中。写入前自动备份。',
        handler: async function(params, body) {
            var makeResult = window.__dsagent_tools.makeResult;
            var filePath = params.file_path || params.path || '';
            var fileContent = params.content || body || '';

            // 兼容旧参数 path
            if (!filePath && body) {
                var lines = body.split('\n');
                var pathLine = lines[0].trim();
                var strictMatch = pathLine.match(/^path=(["'])(.*?)\1$/);
                filePath = strictMatch ? strictMatch[2] : pathLine;
                if (!params.content) fileContent = lines.slice(1).join('\n');
            }

            // 也兼容 params 中的 body/key=value 格式
            if (!filePath && body) {
                var kvRegex = /path\s*=\s*(?:"([^"]*)"|'([^']*)'|(\S+))/;
                var m = body.match(kvRegex);
                if (m) filePath = m[1] || m[2] || m[3];
            }

            if (!filePath) return makeResult(false, null, 'Missing file_path');

            // 写入前备份
            try {
                if (typeof window.__dsagent_fileHistoryBackup === 'function') {
                    window.__dsagent_fileHistoryBackup(filePath.trim());
                }
            } catch(e) {}

            var res = await window.electronAPI.agentSave(filePath.trim(), fileContent);
            if (!res.success) return makeResult(false, null, res.error);
            return makeResult(true, res.message);
        }
    });

    window.__dsagent_tools._write_file_registered = true;
})();
