// local-read - 读取文件内容
;(function() {
    if (window.__dsagent_tools && window.__dsagent_tools._read_registered) return;

    window.__dsagent_tools.register({
        name: 'local-read',
        scope: '读取文本文件内容到对话中',
        description: '读取本地文件的内容并返回。支持快速模式和专家模式，专家模式会检查文件大小。超过 2MB 的文件需要改用 local-singleread。',
        params: [
            { name: 'path', type: '字符串', default: '—', required: true, description: '文件路径（必填），支持绝对路径和相对路径' },
            { name: 'mode', type: '字符串', default: 'professional', required: false, description: '模式：professional（专家模式，有大小限制）或 quick（快速模式，无大小限制）' },
            { name: 'force', type: '布尔', default: 'false', required: false, description: '强制读取大文件（超过 10KB），设为 force=true' }
        ],
        usage: 'path="D:\\project\\readme.txt" force=true',
        notes: '二进制文件和超过 2MB 的大文件请使用 local-singleread。PDF 文件只能用 local-singleread 读取。',
        handler: async function(content) {
            content = content.trim();
            var kv = window.__dsagent_parseKeyValuePairs(content);
            var filePath = kv.path || content;
            var mode = kv.mode || 'professional';
            var force = kv.force === 'true';
            
            filePath = filePath.trim();
            if (!filePath) throw new Error('Missing file path');
            
            var infoRes = await window.electronAPI.agentInfo(filePath);
            if (infoRes.success && infoRes.size !== undefined) {
                if (infoRes.size > 2 * 1024 * 1024) {
                    throw new Error('文件 ' + (infoRes.size / 1024 / 1024).toFixed(1) + 'MB 超过 2MB，local-read 无法处理。请使用 local-singleread mode=quick 快速模式读取。');
                }
                if (mode !== 'quick' && infoRes.size > 10 * 1024) {
                    var sizeKB = Math.round(infoRes.size / 1024);
                    if (!force) {
                        return '⚠️ 文件大小警告：该文件 ' + sizeKB + 'KB（超过 10KB），可能会占用大量上下文。\n如果你确认需要读取完整内容，请在 local-read 中添加 force=true 参数，如：\n\n```local-read\npath="' + filePath + '" force=true\n```\n\n> 建议使用 local-singleread 并添加分析指令来获取摘要，避免占用过多上下文。';
                    }
                }
            }
            
            var res = await window.electronAPI.agentRead(filePath);
            if (!res.success) throw new Error(res.error);
            return res.content;
        }
    });
    window.__dsagent_tools._read_registered = true;
})();