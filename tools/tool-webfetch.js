// webfetch - 获取网页内容
;(function() {
    if (window.__dsagent_tools && window.__dsagent_tools._webfetch_registered) return;

    window.__dsagent_tools.register({
        name: 'webfetch',
        scope: '获取网页内容（HTTP GET/POST）',
        description: '通过 HTTP 请求获取指定 URL 的内容。支持 GET 和 POST 请求，可自定义请求头。返回文本内容。',
        params: [
            { name: 'url', type: '字符串', required: true, description: '目标 URL' },
            { name: 'method', type: '字符串', default: 'GET', required: false, description: 'HTTP 方法：GET 或 POST' },
            { name: 'headers', type: '对象', default: '{}', required: false, description: '自定义请求头' },
            { name: 'body', type: '字符串', default: '', required: false, description: 'POST 请求体' },
            { name: 'timeout', type: '数字', default: '30000', required: false, description: '超时时间（毫秒）' }
        ],
        usage: '{"url": "https://example.com", "method": "GET"}\n\n{"url": "https://api.example.com", "method": "POST", "headers": {"Content-Type": "application/json"}, "body": "{\\"key\\": \\"value\\"}"}',
        notes: '请确保 URL 是完整格式（含 https://）。如果获取失败，检查网络连接或 URL 是否正确。',
        handler: async function(params) {
            var makeResult = window.__dsagent_tools.makeResult;
            var url = params.url || '';
            var method = (params.method || 'GET').toUpperCase();
            var headers = params.headers || {};
            var body = params.body || null;
            var timeout = params.timeout || 30000;

            if (!url) return makeResult(false, null, 'Missing URL');

            try {
                var fetchOptions = {
                    method: method,
                    headers: headers,
                    signal: AbortSignal.timeout(timeout)
                };
                if (body && method !== 'GET') {
                    fetchOptions.body = body;
                }

                var response = await fetch(url, fetchOptions);
                var content = await response.text();
                
                if (!response.ok) {
                    return makeResult(false, null, 'HTTP ' + response.status + ' ' + response.statusText + ':\n' + content.substring(0, 500));
                }
                
                return makeResult(true, content, null, { url: url, status: response.status });
            } catch (e) {
                return makeResult(false, null, '请求失败: ' + (e.message || e));
            }
        }
    });
    window.__dsagent_tools._webfetch_registered = true;
})();
