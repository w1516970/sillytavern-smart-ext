// Smart Hub 搜索桥接服务
// 作用：绕过浏览器 CORS 限制，在服务端请求必应搜索并返回结构化结果
// 运行：node server.mjs  （默认监听 http://127.0.0.1:5123）
// 无任何第三方依赖，仅需 Node.js 18+

import http from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';

const PORT = process.env.PORT || 5123;

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

function decodeEntities(str) {
    return str
        .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
        .replace(/&#x(\w+);/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
}
const stripTags = (s) => decodeEntities(String(s).replace(/<[^>]+>/g, '')).trim();

async function fetchWithTimeout(url, opts = {}, ms = 15000) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), ms);
    try {
        return await fetch(url, { ...opts, signal: ctrl.signal });
    } finally { clearTimeout(timer); }
}

// ---------- 必应 ----------
async function searchBing(query, count, cn) {
    const host = cn ? 'https://cn.bing.com' : 'https://www.bing.com';
    const url = `${host}/search?q=${encodeURIComponent(query)}&count=${Math.max(count, 10)}&setlang=zh-hans&format=rss&mkt=zh-CN`;
    const res = await fetchWithTimeout(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'zh-CN,zh;q=0.9' } });
    if (!res.ok) throw new Error(`必应返回 ${res.status}`);
    const xml = await res.text();

    const results = [];
    const itemRe = /<item>([\s\S]*?)<\/item>/g;
    let m;
    while ((m = itemRe.exec(xml)) && results.length < count) {
        const item = m[1];
        const title = stripTags((/<title>([\s\S]*?)<\/title>/.exec(item) || [])[1] || '');
        const link = stripTags((/<link>([\s\S]*?)<\/link>/.exec(item) || [])[1] || '');
        const snippet = stripTags((/<description>([\s\S]*?)<\/description>/.exec(item) || [])[1] || '');
        if (title && link) results.push({ title, url: link, snippet });
    }

    // RSS 无结果时回退到解析 HTML 页面
    if (!results.length) {
        const htmlRes = await fetchWithTimeout(
            `${host}/search?q=${encodeURIComponent(query)}&count=${Math.max(count, 10)}&mkt=zh-CN`,
            { headers: { 'User-Agent': UA, 'Accept-Language': 'zh-CN,zh;q=0.9' } });
        const html = await htmlRes.text();
        const liRe = /<li class="b_algo"[\s\S]*?<h2><a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a><\/h2>([\s\S]*?)<\/li>/g;
        let h;
        while ((h = liRe.exec(html)) && results.length < count) {
            results.push({
                url: h[1],
                title: stripTags(h[2]),
                snippet: stripTags((/<p[^>]*>([\s\S]*?)<\/p>/.exec(h[3]) || [])[1] || ''),
            });
        }
    }
    return results;
}

// ---------- DuckDuckGo（备用） ----------
async function searchDuck(query, count) {
    const res = await fetchWithTimeout('https://html.duckduckgo.com/html/', {
        method: 'POST',
        headers: { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `q=${encodeURIComponent(query)}`,
    });
    const html = await res.text();
    const results = [];
    const re = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
    let m;
    while ((m = re.exec(html)) && results.length < count) {
        let url = m[1];
        const uddg = /uddg=([^&]+)/.exec(url);
        if (uddg) url = decodeURIComponent(uddg[1]);
        results.push({ title: stripTags(m[2]), url, snippet: stripTags(m[3]) });
    }
    return results;
}

const server = http.createServer(async (req, res) => {
    // CORS：允许酒馆页面的浏览器直接调用
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

    if (req.method === 'GET' && req.url === '/') {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ status: 'ok', service: 'smart-hub-bridge', version: '1.0.0' }));
    }

    if (req.method !== 'POST' || !req.url.startsWith('/search')) {
        res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ error: 'Not Found' }));
    }

    let body = '';
    for await (const chunk of req) body += chunk;
    let query = '', count = 5, engine = 'bing';
    try {
        const data = JSON.parse(body || '{}');
        query = data.query || '';
        count = Math.min(Number(data.count) || 5, 20);
        engine = data.engine || 'bing';
    } catch { /* ignore */ }

    if (!query) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ error: '缺少 query 参数' }));
    }

    try {
        let results = [];
        for (let attempt = 0; attempt < 3 && !results.length; attempt++) {
            if (attempt > 0) await delay(1200 * attempt);
            results = engine === 'duckduckgo'
                ? await searchDuck(query, count)
                : await searchBing(query, count, engine === 'bing_cn');
        }
        console.log(`[bridge] ${new Date().toLocaleTimeString()} engine=${engine} q="${query}" -> ${results.length} 条结果`);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ query, engine, results }));
    } catch (e) {
        console.error('[bridge] 搜索失败:', e.message);
        res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: e.message }));
    }
});

server.listen(PORT, () => {
    console.log(`Smart Hub 搜索桥接服务已启动: http://127.0.0.1:${PORT}`);
    console.log('在扩展设置中填写搜索接口地址: http://127.0.0.1:5123/search');
});
