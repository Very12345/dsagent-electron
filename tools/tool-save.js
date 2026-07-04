// save - 保存文件
;(function() {
    if (window.__dsagent_tools && window.__dsagent_tools._save_registered) return;

    window.__dsagent_tools.register({
        name: 'save',
        scope: '创建或覆盖文件',
        description: '将内容保存到指定文件中。如果文件已存在则覆盖，目录不存在时自动创建。',
        params: [
            { name: 'path', type: '字符串', default: '—', required: true, description: '保存路径（必填）' },
            { name: 'content', type: '字符串', default: '—', required: false, description: '文件内容（也可放在 body 中）' }
        ],
        usage: '<tool:save>{"path": "D:\\\\project\\\\notes.txt", "body": "文件内容\\n第二行内容"}</tool:save>',
        notes: '路径中的目录会自动创建。内容可放在 body 字段中，或 params.content 中。',
        handler: async function(params, body) {
            var makeResult = window.__dsagent_tools.makeResult;
            var filePath = params.path || '';
            var fileContent = params.content || body || '';

            // Backward compat: parse from body
            if (!filePath && body) {
                var lines = body.split('\n');
                var pathLine = lines[0].trim();
                var strictMatch = pathLine.match(/^path=(["'])(.*?)\1$/);
                filePath = strictMatch ? strictMatch[2] : pathLine;
                fileContent = lines.slice(1).join('\n');
            }

            if (!filePath) return makeResult(false, null, 'Missing file path');
            // P1: 文件快照 — 保存前备份
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
    window.__dsagent_tools._save_registered = true;
})();