// edit_file - 在文件中查找替换文本（AtomCode 标准命名 + 参数对齐）
// 别名 edit 保留向后兼容。使用 old_string/new_string（精确匹配，要求唯一）或 find/replace（正则支持）。
// 用法: {"file_path": "app.js", "old_string": "let x = 1;", "new_string": "let x = 2;"}
//       {"file_path": "app.js", "find": "旧文本", "replace": "新文本", "regex": true}
;(function() {
    if (window.__dsagent_tools && window.__dsagent_tools._edit_file_registered) return;

    window.__dsagent_tools.register({
        name: ['edit_file', 'edit'],
        scope: '在文件中执行文本查找替换',
        description: '在文件中查找指定文本并替换为新的内容。' +
            '支持两种模式：\n' +
            '- `old_string`+`new_string`：精确匹配，要求原文唯一（除非 `replace_all=true`）—— 推荐，不易误改\n' +
            '- `find`+`replace`+`regex`：支持正则表达式，替换第一个匹配\n\n' +
            '精确模式（old_string）适合编辑已知代码片段；正则模式适合批量模式匹配。' +
            '编辑前自动备份文件快照。',
        params: [
            { name: 'file_path', type: '字符串', default: '—', required: true, description: '文件路径（必填）' },
            { name: 'old_string', type: '字符串', default: '—', required: false, description: '要查找的原文（精确匹配，要求唯一）' },
            { name: 'new_string', type: '字符串', default: '—', required: false, description: '替换内容（与 old_string 配对使用）' },
            { name: 'replace_all', type: '布尔', default: 'false', required: false, description: '替换所有匹配（old_string+new_string 模式）' },
            { name: 'find', type: '字符串', default: '—', required: false, description: '要查找的文本（与 replace 配对，支持 regex）' },
            { name: 'replace', type: '字符串', default: '—', required: false, description: '替换文本（与 find 配对）' },
            { name: 'regex', type: '布尔', default: 'false', required: false, description: '是否将 find 视为正则表达式' }
        ],
        usage: '{"file_path": "config.json", "old_string": "apiKey: \\"old\\"", "new_string": "apiKey: \\"new\\""}\n\n{"file_path": "src/utils.js", "find": "foo", "replace": "bar"}\n\n{"file_path": "src/*.css", "find": "margin: 0;", "replace": "margin: 0 auto;", "regex": false}',
        notes: 'old_string+new_string 模式推荐用于精确编辑（要求原文唯一才能替换）。find+replace 模式支持正则，替换第一个匹配。另外包含 search_replace 工具可跨文件批量替换。',
        handler: async function(params, body) {
            var makeResult = window.__dsagent_tools.makeResult;
            var filePath = params.file_path || params.path || '';
            var oldString = params.old_string || '';
            var newString = params.new_string || '';
            var replaceAll = params.replace_all === true;
            var find = params.find || '';
            var replace = params.replace || '';
            var useRegex = params.regex === true;

            // 向后兼容：从 body 解析 key=value 格式
            if (!filePath && body) {
                var kv = (typeof window.__dsagent_parseKeyValuePairs === 'function')
                    ? window.__dsagent_parseKeyValuePairs(body)
                    : {};
                filePath = filePath || kv.file_path || kv.path || '';
                oldString = oldString || kv.old_string || '';
                newString = newString || kv.new_string || '';
                find = find || kv.find || '';
                replace = replace || kv.replace || '';
                if (!useRegex) useRegex = kv.regex === 'true' || kv.regex === true;
                if (!replaceAll) replaceAll = kv.replace_all === 'true' || kv.replace_all === true;
            }

            if (!filePath) return makeResult(false, null, 'Missing file_path');

            // 确定使用哪种模式
            var useOldString = !!(oldString || newString); // old_string+new_string 模式
            var useFindReplace = !!(find || replace);      // find+replace 模式

            if (!useOldString && !useFindReplace) {
                return makeResult(false, null, '请提供 old_string+new_string 或 find+replace 参数');
            }

            var searchText, replaceText, isRegex;
            if (useOldString) {
                // 精确匹配模式：需要读取文件然后做精确替换
                searchText = oldString;
                replaceText = newString;
                isRegex = false; // old_string 模式不使用正则
            } else {
                searchText = find;
                replaceText = replace;
                isRegex = useRegex;
            }

            // 备份
            try {
                if (typeof window.__dsagent_fileHistoryBackup === 'function') {
                    window.__dsagent_fileHistoryBackup(filePath.trim());
                }
            } catch(e) {}

            if (useOldString) {
                // old_string+new_string 模式：精确匹配，可选 replace_all
                // 需要先读文件，手动替换后写回
                var readRes = await window.electronAPI.agentRead(filePath);
                if (!readRes || !readRes.success) return makeResult(false, null, readRes ? readRes.error : 'Read failed');

                var content = readRes.content || '';
                var newContent;

                if (replaceAll) {
                    // 全部替换
                    newContent = content.split(searchText).join(replaceText);
                } else {
                    // 只替换第一个（要求唯一）
                    var idx = content.indexOf(searchText);
                    if (idx === -1) {
                        return makeResult(true, '(未找到匹配 "' + searchText.substring(0, 50) + '")');
                    }
                    // 检查是否唯一
                    var secondIdx = content.indexOf(searchText, idx + 1);
                    if (secondIdx !== -1) {
                        return makeResult(false, null, '找到多处匹配 "' + searchText.substring(0, 50) + '"，请用 replace_all=true 或增加上下文使 old_string 唯一');
                    }
                    newContent = content.substring(0, idx) + replaceText + content.substring(idx + searchText.length);
                }

                if (newContent === content) {
                    return makeResult(true, '(No change — old_string matches but identical to new_string)');
                }

                // 用 agentSave 写回
                var saveRes = await window.electronAPI.agentSave(filePath.trim(), newContent);
                if (!saveRes.success) return makeResult(false, null, saveRes.error);
                return makeResult(true, saveRes.message + ' (Modified via exact match)');
            } else {
                // find+replace 模式：直接调 agentEdit
                var res = await window.electronAPI.agentEdit(filePath.trim(), searchText, isRegex, replaceText);
                if (!res.success) return makeResult(false, null, res.error);
                return makeResult(true, res.message + (res.changed ? ' (Modified)' : ' (No match)'));
            }
        }
    });

    window.__dsagent_tools._edit_file_registered = true;
})();
