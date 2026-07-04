// web_search - 联网搜索（AI 工具，用户无需手动调用）
// AtomCode 等效：crates/atomcode-capabilities/src/tools/web_search.rs
// 后端：DuckDuckGo HTML 搜索（无需 API Key）
;(function() {
    if (window.__dsagent_tools && window.__dsagent_tools._websearch_registered) return;

    window.__dsagent_tools.register({
        name: 'web_search',
        scope: '联网搜索关键词，返回标题/URL/摘要列表',
        description: 'Search the web for information — returns titles, URLs, and snippets. Use to find documentation, look up APIs, research libraries, or find information not available locally; then call `web_fetch` on a result URL to read it. `max_results` caps the list (default 8).',
        params: [
            { name: 'query', type: '字符串', required: true, description: '搜索关键词' },
            { name: 'max_results', type: '数字', default: '8', required: false, description: '返回结果数上限（1-20）' }
        ],
        usage: JSON.stringify({ query: 'AtomCode 发布', max_results: 5 }),
        notes: '使用 DuckDuckGo 搜索，无需 API Key。如果搜索被屏蔽，可以尝试 webfetch 直接访问已知 URL。',
        handler: async function(params) {
            var makeResult = window.__dsagent_tools.makeResult;
            var query = (params.query || '').trim();
            var maxResults = Math.min(Math.max(1, parseInt(params.max_results) || 8), 20);

            if (!query) return makeResult(false, null, 'Missing query parameter');

            try {
                // DuckDuckGo HTML 搜索
                var response = await fetch('https://html.duckduckgo.com/html/', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/x-www-form-urlencoded',
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                    },
                    body: 'q=' + encodeURIComponent(query),
                    signal: AbortSignal.timeout(15000)
                });

                if (!response.ok) {
                    return makeResult(false, null, 'DuckDuckGo returned HTTP ' + response.status);
                }

                var html = await response.text();

                // 解析 HTML 提取搜索结果
                var results = parseDdgResults(html, maxResults);

                if (results.length === 0) {
                    return makeResult(false, null, 'No results found for "' + query + '" (' + html.length + ' bytes received)');
                }

                var output = 'Search results for "' + query + '":\n\n';
                for (var i = 0; i < results.length; i++) {
                    output += (i + 1) + '. ' + results[i].title + '\n';
                    output += '   ' + results[i].url + '\n';
                    output += '   ' + results[i].snippet + '\n\n';
                }

                return makeResult(true, output, null, { query: query, results: results.length, total: results.length });
            } catch (e) {
                var errMsg = (e && (e.message || String(e))) || 'Unknown error';
                return makeResult(false, null, 'web_search failed for "' + query + '": ' + errMsg + '\n\nIf web search keeps failing here (blocked / unreachable network), try using webfetch to access specific URLs directly.');
            }
        }
    });

    // DuckDuckGo HTML 搜索结果解析
    function parseDdgResults(html, maxResults) {
        var results = [];
        // 匹配 <a class="result__a" href="...">title</a>
        var linkRegex = /<a[^>]+class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
        // 匹配 <a class="result__snippet"[^>]*>snippet</a> 或 <a class="result__snippet" ...>snippet</a>
        var snippetRegex = /<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;
        // 匹配 <span class="result__url"[^>]*>url</span> 或类似
        var urlRegex = /<span[^>]*class="result__url"[^>]*>([\s\S]*?)<\/span>/gi;

        var links = [];
        var match;
        while ((match = linkRegex.exec(html)) !== null && links.length < maxResults) {
            var title = stripHtml(match[2]).trim();
            if (title) {
                links.push({ href: match[1], title: title });
            }
        }

        var snippets = [];
        while ((match = snippetRegex.exec(html)) !== null && snippets.length < maxResults) {
            var snippet = stripHtml(match[1]).trim();
            if (snippet) snippets.push(snippet);
        }

        var urls = [];
        while ((match = urlRegex.exec(html)) !== null && urls.length < maxResults) {
            var u = stripHtml(match[1]).trim();
            if (u) urls.push(u);
        }

        for (var i = 0; i < Math.min(links.length, maxResults); i++) {
            results.push({
                title: links[i] ? links[i].title : '',
                url: (urls[i] || links[i] ? links[i].href : '').replace(/\/\/duckduckgo\.com\/l\/\?uddg=/, '').replace(/&rut=.*$/, ''),
                snippet: snippets[i] || ''
            });
            // 解码 URL（DDG 跳转编码）
            try {
                if (results[i].url.indexOf('http') !== 0 && links[i] && links[i].href) {
                    results[i].url = decodeDdgUrl(links[i].href);
                }
            } catch(e) {}
        }

        return results;
    }

    function stripHtml(text) {
        return text.replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&#x2F;/g, '/');
    }

    function decodeDdgUrl(href) {
        // DuckDuckGo 使用 /l/?uddg=ENCODED_URL&rut=... 格式跳转
        var m = href.match(/uddg=([^&]+)/);
        if (m) return decodeURIComponent(m[1]);
        return href;
    }

    window.__dsagent_tools._websearch_registered = true;
})();
