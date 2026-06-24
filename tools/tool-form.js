// local-form - 表单收集（一次性询问多个问题，支持选项）
// AI 通过此工具向用户提问，用户填写后结果返回给 AI
;(function() {
    if (window.__dsagent_tools && window.__dsagent_tools._form_registered) return;

    window.__dsagent_tools.register({
        name: 'local-form',
        scope: '向用户展示表单，收集多个问题的回答',
        description: '向用户展示一个或多个问题，支持提供选项供用户选择。\n'
            + '用户填写或选择后，结果会返回给 AI 继续处理。\n'
            + '支持通过外部客户端按钮交互（如果已启用）。',
        params: [
            { name: 'title', type: '字符串', default: '表单', required: false, description: '表单标题' },
            { name: 'questions', type: '字符串', default: '—', required: true, description: '问题列表，用 | 分隔（如：项目名称?|技术栈?|是否需要数据库?）' },
            { name: 'options', type: '字符串', default: '—', required: false, description: '每个问题的选项，用 | 分隔，每个问题的选项用逗号分隔（如：React,Vue,Angular|是,否|）' }
        ],
        usage: '{"tool": "form", "params": {"title": "新项目设置", "questions": "项目名称?|技术栈?|是否需要TypeScript?", "options": "|React,Vue,Angular|是,否"}}',
        notes: 'questions 和 options 分别用 | 分隔。options 中每个问题对应一项，空项表示自由输入。表单结果会通过 Agent 端或外部客户端按钮返回。',
        handler: async function(params, body) {
            var makeResult = window.__dsagent_tools.makeResult;
            var title, questionsStr, optionsStr;

            // Check if new params format is being used
            var hasNewParams = params.title || params.questions || params.options;
            if (hasNewParams) {
                title = params.title || '表单';
                questionsStr = params.questions || '';
                optionsStr = params.options || '';
            } else {
                // Old format: parse body content (first line has key=value pairs)
                var content = body || '';
                var lines = content.trim().split('\n');
                var firstLine = lines[0].trim();
                var kv = (typeof window.__dsagent_parseKeyValuePairs === 'function')
                    ? window.__dsagent_parseKeyValuePairs(firstLine)
                    : {};
                title = kv.title || '表单';
                questionsStr = kv.questions || '';
                optionsStr = kv.options || '';
            }

            var questions = questionsStr.split('|').map(function(q) { return q.trim(); }).filter(Boolean);
            var options = optionsStr.split('|').map(function(o) { return o.trim(); });

            if (questions.length === 0) {
                return makeResult(false, null, '至少需要一个问题（用 | 分隔）');
            }

            // 确保 options 数组长度与 questions 一致
            while (options.length < questions.length) options.push('');

            var formData = {
                title: title,
                questions: questions,
                options: options,
                timestamp: Date.now()
            };

            // 转发到 Agent 视图显示表单
            if (window.electronAPI && window.electronAPI.agentForwardResult) {
                window.electronAPI.agentForwardResult({
                    type: 'form-show',
                    form: formData
                });
            }

            // 构建返回文本，让 AI 知道表单已发送
            var result = '📋 表单已发送: **' + title + '**\n\n';
            for (var qi = 0; qi < questions.length; qi++) {
                result += (qi + 1) + '. ' + questions[qi];
                if (options[qi]) {
                    result += ' [' + options[qi] + ']';
                }
                result += '\n';
            }
            result += '\n⏳ 等待用户填写...';

            return makeResult(true, result);
        }
    });
    window.__dsagent_tools._form_registered = true;
})();