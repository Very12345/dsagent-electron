// local-save - 保存文件
;(function() {
    if (window.__dsagent_tools && window.__dsagent_tools._save_registered) return;

    window.__dsagent_tools.register({
        name: 'local-save',
        scope: '创建或覆盖文件',
        description: '将内容保存到指定文件中。如果文件已存在则覆盖，目录不存在时自动创建。',
        params: [
            { name: 'path', type: '字符串', default: '—', required: true, description: '保存路径（必填），第一行以 path= 开头指定路径，剩余行为文件内容' }
        ],
        usage: 'path="D:\\project\\notes.txt"\n这是文件内容\n第二行内容',
        notes: '路径中的目录会自动创建。如果文件已存在，内容将被覆盖。保存大文件（超过 1MB）建议使用 local-exec 配合 echo/fs 命令。',
        handler: async function(content) {
            var lines = content.split('\n');
            var pathLine = lines[0].trim();
            var strictMatch = pathLine.match(/^path=(["'])(.*?)\1$/);
            var filePath = strictMatch ? strictMatch[2] : pathLine;
            var fileContent = lines.slice(1).join('\n');
            if (!filePath) throw new Error('Missing file path');
            var res = await window.electronAPI.agentSave(filePath.trim(), fileContent);
            if (!res.success) throw new Error(res.error);
            return res.message;
        }
    });
    window.__dsagent_tools._save_registered = true;
})();