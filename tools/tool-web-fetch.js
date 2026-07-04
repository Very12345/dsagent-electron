// web_fetch - 获取网页内容（AtomCode 标准命名 + format/max_chars 参数）
// 别名 webfetch 保留向后兼容。支持 text/markdown 格式渲染，SSRF 防护。
// 用法: {"url": "https://example.com", "format": "markdown", "max_chars": 5000}
;(function() {
    if (window.__dsagent_tools && window.__dsagent_tools._web_fetch_registered) return;

    window.__dsagent_tools.register({
        name: ['web_fetch', 'webfetch'],
        scope: '获取网页内容（HTTP GET/POST，支持格式化输出）',
        description: '通过 HTTP 请求获取指定 URL 的内容。' +
            '支持 GET 和 POST 请求，可自定义请求头。' +
            'HTML 页面会转换为纯净文本；`format: "markdown"` 可保留标题/链接/代码结构。' +
            '`max_chars` 可限制返回字符数。' +
            '自动阻止请求回环地址（localhost/私有网络/云元数据）。',
        params: [
            { name: 'url', type: '字符串', default: '—', required: true, description: '目标 URL' },
            { name: 'method', type: '字符串', default: 'GET', required: false, description: 'HTTP 方法：GET 或 POST' },
            { name: 'headers', type: '对象', default: '{}', required: false, description: '自定义请求头' },
            { name: 'body', type: '字符串', default: '', required: false, description: 'POST 请求体' },
            { name: 'format', type: '字符串', default: 'text', required: false, description: 'HTML 渲染：text（纯文本）或 markdown（保留结构）' },
            { name: 'max_chars', type: '数字', default: '—', required: false, description: '最大返回字符数（省略则不截断）' },
            { name: 'timeout', type: '数字', default: '30000', required: false, description: '超时时间（毫秒）' }
        ],
        usage: '{"url": "https://example.com"}\n\n{"url": "https://github.com", "format": "markdown", "max_chars": 2000}\n\n{"url": "https://api.example.com", "method": "POST", "headers": {"Content-Type": "application/json"}, "body": "{\\"key\\": \\"value\\"}"}',
        notes: 'URL 必须是完整格式（含 https://）。format=markdown 保留标题链接结构。web_search 搜索后可用 web_fetch 查看具体页面。',
        handler: async function(params, body) {
            var makeResult = window.__dsagent_tools.makeResult;
            var url = params.url || '';
            var method = (params.method || 'GET').toUpperCase();
            var headers = params.headers || {};
            var reqBody = params.body || null;
            var timeout = params.timeout || 30000;
            var format = params.format || 'text';
            var maxChars = params.max_chars ? parseInt(params.max_chars) : 0;

            // 从 body 解析
            if (!url && body) {
                try {
                    var bp = JSON.parse(body);
                    url = url || bp.url || '';
                    method = (bp.method || method).toUpperCase();
                    headers = bp.headers || headers;
                    reqBody = bp.body || reqBody;
                    timeout = bp.timeout || timeout;
                    format = bp.format || format;
                    maxChars = bp.max_chars ? parseInt(bp.max_chars) : maxChars;
                } catch(e) {
                    // body 可能是 URL 字符串
                    var lines = body.split('\n');
                    url = url || lines[0].trim();
                }
            }

            if (!url) return makeResult(false, null, 'Missing URL');

            // SSRF 防护：检查 URL 是否为私有地址
            if (isPrivateUrl(url)) {
                return makeResult(false, null, '拒绝请求内网/私有地址: ' + url);
            }

            try {
                var fetchOptions = {
                    method: method,
                    headers: headers,
                    signal: AbortSignal.timeout(timeout)
                };
                if (reqBody && method !== 'GET') {
                    fetchOptions.body = reqBody;
                }

                var response = await fetch(url, fetchOptions);
                var contentType = response.headers.get('content-type') || '';
                var isHTML = contentType.indexOf('text/html') !== -1;

                var content = await response.text();

                if (!response.ok) {
                    return makeResult(false, null, 'HTTP ' + response.status + ' ' + response.statusText + ':\n' + content.substring(0, 500));
                }

                // 格式化输出
                var output = content;
                if (isHTML && format === 'markdown') {
                    output = htmlToMarkdown(content);
                } else if (isHTML && format === 'text') {
                    output = htmlToText(content);
                }

                // 截断
                if (maxChars > 0 && output.length > maxChars) {
                    output = output.substring(0, maxChars) + '\n\n[... truncated at ' + maxChars + ' characters]';
                }

                var meta = { url: url, status: response.status, contentType: contentType, length: output.length };
                return makeResult(true, output, null, meta);
            } catch (e) {
                return makeResult(false, null, '请求失败: ' + (e.message || e));
            }
        }
    });

    // ====== HTML 渲染 ======

    function htmlToText(html) {
        // 简单 HTML → 纯文本
        var text = html
            .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
            .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
            .replace(/<br\s*\/?>/gi, '\n')
            .replace(/<\/p>/gi, '\n\n')
            .replace(/<\/div>/gi, '\n')
            .replace(/<\/h[1-6]>/gi, '\n')
            .replace(/<\/li>/gi, '\n')
            .replace(/<[^>]*>/g, '')
            .replace(/&amp;/g, '&')
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/&quot;/g, '"')
            .replace(/&#x27;/g, "'")
            .replace(/&#x2F;/g, '/')
            .replace(/&nbsp;/g, ' ')
            .replace(/\n\s*\n\s*\n/g, '\n\n')
            .trim();
        return text;
    }

    function htmlToMarkdown(html) {
        // 简单 HTML → Markdown
        var md = html;
        // 移除 script/style
        md = md.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '');
        md = md.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '');

        // 标题
        md = md.replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, '# $1\n\n');
        md = md.replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, '## $1\n\n');
        md = md.replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, '### $1\n\n');
        md = md.replace(/<h4[^>]*>([\s\S]*?)<\/h4>/gi, '#### $1\n\n');

        // 链接
        md = md.replace(/<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, '[$2]($1)');

        // 图片
        md = md.replace(/<img[^>]*src="([^"]*)"[^>]*>/gi, '![]($1)');

        // 代码块
        md = md.replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, function(m, c) {
            return '\n```\n' + stripTags(c) + '\n```\n';
        });
        md = md.replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, '`$1`');

        // 列表
        md = md.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, '- $1\n');

        // 换行
        md = md.replace(/<br\s*\/?>/gi, '\n');
        md = md.replace(/<\/p>/gi, '\n\n');
        md = md.replace(/<\/div>/gi, '\n');

        // 加粗/斜体
        md = md.replace(/<strong[^>]*>([\s\S]*?)<\/strong>/gi, '**$1**');
        md = md.replace(/<b[^>]*>([\s\S]*?)<\/b>/gi, '**$1**');
        md = md.replace(/<em[^>]*>([\s\S]*?)<\/em>/gi, '*$1*');
        md = md.replace(/<i[^>]*>([\s\S]*?)<\/i>/gi, '*$1*');

        // 移除剩余标签
        md = md.replace(/<[^>]*>/g, '');

        // HTML 实体
        md = md.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
        md = md.replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&nbsp;/g, ' ');

        // 清理多余空行
        md = md.replace(/\n{4,}/g, '\n\n\n').trim();
        return md;
    }

    function stripTags(html) {
        return html.replace(/<[^>]*>/g, '')
            .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
            .replace(/&quot;/g, '"').replace(/&#x27;/g, "'");
    }

    function isPrivateUrl(url) {
        try {
            var u = new URL(url);
            var hostname = u.hostname;
            // localhost
            if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1') return true;
            // 私有网络
            if (hostname.startsWith('10.') || hostname.startsWith('172.16.') ||
                hostname.startsWith('192.168.') || hostname.startsWith('169.254.')) return true;
            // 云元数据
            if (hostname.endsWith('.internal') || hostname.endsWith('.compute.internal')) return true;
            return false;
        } catch(e) {
            return true; // 无法解析 URL 也拒绝
        }
    }

    window.__dsagent_tools._web_fetch_registered = true;
})();
