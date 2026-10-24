// Smart Hub - 智能中枢 · SillyTavern 扩展
// 功能：独立 API 连接 / 模型拉取 / 必应联网搜索 / 完整聊天记录读取（无视隐藏与正则）
//      额外向量化 + 重排序模型实现完整聊天记录的语义检索注入

import { extension_settings, getContext, saveMetadataDebounced } from '../../../extensions.js';
import { saveSettingsDebounced } from '../../../../script.js';
import { debounce } from '../../../utils.js';

// ==================== 常量与设置 ====================
const MODULE = 'smart-hub';
const LOG = (...m) => console.log('[SmartHub]', ...m);

const defaultSettings = {
    // 独立 API（OpenAI 兼容）
    apiUrl: '',
    apiKey: '',
    // 向量模型 API（留空则复用主 API）
    embedApiUrl: '',
    embedApiKey: '',
    embedModel: '',
    // 重排序 API（留空则复用主 API）
    rerankApiUrl: '',
    rerankApiKey: '',
    rerankModel: '',
    // 搜索
    searchUrl: 'http://127.0.0.1:5123/search',
    searchEngine: 'bing',
    searchCount: 5,
    autoSearch: false,
    searchInject: true,
    // 记忆检索
    memoryEnabled: false,
    memoryTopK: 5,
    memoryRerank: true,
    memoryScore: 0.3,
    // 内部
    vectors: {},          // chatId -> [{ hash, vector, text }]
    modelCache: [],
};

function getSettings() {
    if (extension_settings[MODULE] === undefined) {
        extension_settings[MODULE] = structuredClone(defaultSettings);
    }
    for (const k of Object.keys(defaultSettings)) {
        if (extension_settings[MODULE][k] === undefined) {
            extension_settings[MODULE][k] = defaultSettings[k];
        }
    }
    return extension_settings[MODULE];
}
const S = getSettings();

// ==================== 工具函数 ====================
function status(msg, type = 'ok') {
    const $el = $('#sh-status');
    if (!$el.length) return;
    $el.removeClass('sh-ok sh-err sh-warn').addClass(`sh-${type}`);
    const stamp = new Date().toLocaleTimeString();
    $el.text(`[${stamp}] ${msg}`);
    LOG(msg);
}

async function apiFetch(baseUrl, apiKey, path, body, isForm = false) {
    const url = new URL(path, baseUrl.startsWith('http') ? baseUrl : `http://${baseUrl}`).href;
    const headers = { 'Content-Type': 'application/json' };
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
    const res = await fetch(url, {
        method: 'POST',
        headers,
        body: isForm ? body : JSON.stringify(body),
    });
    if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`API ${res.status}: ${text.slice(0, 200)}`);
    }
    return res.json();
}

async function fetchModels(baseUrl, apiKey) {
    const url = new URL('/v1/models', baseUrl.startsWith('http') ? baseUrl : `http://${baseUrl}`).href;
    const headers = {};
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
    const res = await fetch(url, { headers });
    if (!res.ok) throw new Error(`拉取模型失败 ${res.status}`);
    const data = await res.json();
    return (data.data || []).map(m => m.id).sort();
}

function hashString(str) {
    let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
    for (let i = 0; i < str.length; i++) {
        const ch = str.charCodeAt(i);
        h1 = Math.imul(h1 ^ ch, 2654435761);
        h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (h2 >>> 0) * 4294967296 + (h1 >>> 0);
}

function cosine(a, b) {
    let dot = 0, na = 0, nb = 0;
    for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
        na += a[i] * a[i];
        nb += b[i] * b[i];
    }
    return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

// ==================== 核心：完整聊天记录读取 ====================
// 关键：直接读取 context.chat 原始数组。
//  - 「隐藏正文」(is_system) 只是前端不渲染，原始 mes 仍在数组里
//  - 正则(Regex)扩展只作用于展示层/发送层，不修改 chat[] 的原始 mes
// 因此这里读到的永远是完整未删改的聊天记录。
function getFullChat() {
    const ctx = getContext();
    const chat = ctx.chat || [];
    const msgs = [];
    for (const m of chat) {
        if (!m || m.is_thinking) continue;
        const text = String(m.mes ?? '').trim();
        if (!text) continue;
        msgs.push({
            name: m.name || (m.is_user ? 'User' : 'Assistant'),
            role: m.is_user ? 'user' : (m.is_system ? 'system' : 'assistant'),
            hidden: !!m.is_system,   // 被隐藏灯泡隐藏的消息
            text,
            swipe: m.swipe_id ?? null,
        });
    }
    return msgs;
}

function chatToTranscript(msgs) {
    return msgs.map(m =>
        `${m.name}${m.hidden ? ' [隐藏]' : ''}: ${m.text}`
    ).join('\n\n');
}

// ==================== 必应 / 网络搜索 ====================
// 浏览器端无法直连必应（CORS），需通过本地桥接服务 bridge/server.mjs
// 或任意兼容 { query, count, engine } -> { results: [{title,url,snippet}] } 的搜索接口
async function webSearch(query) {
    if (!S.searchUrl) throw new Error('未配置搜索接口地址（请启动 bridge/server.mjs 或填写兼容接口）');
    const res = await fetch(S.searchUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            query,
            count: Number(S.searchCount) || 5,
            engine: S.searchEngine || 'bing',
        }),
    });
    if (!res.ok) throw new Error(`搜索接口 ${res.status}`);
    const data = await res.json();
    const results = data.results || data || [];
    if (!Array.isArray(results) || !results.length) throw new Error('搜索无结果');
    return results;
}

function formatSearchResults(results) {
    const lines = results.map((r, i) =>
        `[${i + 1}] ${r.title}\nURL: ${r.url}\n${r.snippet || ''}`
    );
    return `[联网搜索结果 - ${new Date().toLocaleString()}]\n${lines.join('\n\n')}`;
}

function showSearchPopup(query, results, anchorX, anchorY) {
    $('#sh-search-popup').remove();
    const items = results.map(r => `
        <div class="sh-result">
            <a href="${r.url}" target="_blank" rel="noopener">${$('<i>').text(r.title).html()}</a>
            <div class="sh-snippet">${$('<i>').text(r.snippet || '').html()}</div>
        </div>`).join('');
    const $popup = $(`
        <div id="sh-search-popup">
            <div class="sh-popup-head">
                <span>🔍 必应搜索：${$('<i>').text(query).html()}</span>
                <span class="sh-popup-close" title="关闭">✕</span>
            </div>
            ${items}
        </div>`);
    $('body').append($popup);
    const w = $popup.outerWidth(), h = $popup.outerHeight();
    let x = Math.min(anchorX, window.innerWidth - w - 12);
    let y = Math.min(anchorY, window.innerHeight - h - 12);
    $popup.css({ left: x, top: y });
    $popup.find('.sh-popup-close').on('click', () => $popup.remove());
}

async function doSearchAndInject(query) {
    status(`正在用 ${S.searchEngine.toUpperCase()} 搜索：${query}...`, 'warn');
    const results = await webSearch(query);
    const formatted = formatSearchResults(results);
    // 注入到本次生成的系统提示
    setExtensionPrompt('smart-hub-search', formatted, 1, 1);
    status(`搜索完成，已注入 ${results.length} 条结果。`, 'ok');
    return { results, formatted };
}

// ==================== 向量记忆：完整聊天记录语义检索 ====================
async function embedTexts(texts) {
    const url = S.embedApiUrl || S.apiUrl;
    const key = S.embedApiKey || S.apiKey;
    const model = S.embedModel;
    if (!url || !model) throw new Error('请先在「向量 / 重排序」页配置向量模型');
    const data = await apiFetch(url, key, '/v1/embeddings', { model, input: texts });
    // 按 index 排序，保证顺序一致
    return (data.data || []).sort((a, b) => a.index - b.index).map(d => d.embedding);
}

async function rerank(query, documents) {
    const url = S.rerankApiUrl || S.apiUrl;
    const key = S.rerankApiKey || S.apiKey;
    const model = S.rerankModel;
    if (!url || !model) return documents; // 未配置则跳过重排
    const data = await apiFetch(url, key, '/v1/rerank', { model, query, documents });
    const results = (data.results || data.data || [])
        .map(r => ({ index: r.index, score: r.relevance_score ?? r.score ?? 0 }))
        .sort((a, b) => b.score - a.score);
    return results.map(r => ({ text: documents[r.index], score: r.score }));
}

async function buildMemoryIndex(force = false) {
    const ctx = getContext();
    const chatId = ctx.chatId || 'unknown';
    if (!S.memoryEnabled) return;
    if (!S.embedModel || !S.apiUrl && !S.embedApiUrl) throw new Error('未配置向量模型');
    const msgs = getFullChat();
    if (!msgs.length) return;
    S.vectors[chatId] ??= [];
    const store = S.vectors[chatId];
    const texts = msgs.map(m => `${m.name}: ${m.text}`);
    const needIdx = [];
    for (let i = 0; i < texts.length; i++) {
        const h = hashString(texts[i]);
        if (force || !store[i] || store[i].hash !== h) needIdx.push(i);
    }
    if (needIdx.length) {
        status(`正在向量化 ${needIdx.length} 条消息（含隐藏消息）...`, 'warn');
        const vecs = await embedTexts(needIdx.map(i => texts[i].slice(0, 4000)));
        needIdx.forEach((idx, j) => {
            store[idx] = { hash: hashString(texts[idx]), vector: vecs[j] };
        });
        saveSettingsDebounced();
    }
    return { store, texts };
}

async function retrieveMemory(query) {
    const built = await buildMemoryIndex(false);
    if (!built) return '';
    const { store, texts } = built;
    const [qv] = await embedTexts([query.slice(0, 4000)]);
    let scored = store
        .map((s, i) => s && s.vector ? { text: texts[i], score: cosine(qv, s.vector) } : null)
        .filter(Boolean)
        .sort((a, b) => b.score - a.score)
        .slice(0, Math.max(1, Number(S.memoryTopK) || 5));
    if (S.memoryRerank && S.rerankModel) {
        scored = await rerank(query, scored.map(s => s.text));
    }
    const finalScored = scored
        .filter(s => s.score >= (Number(S.memoryScore) || 0.3))
        .slice(0, Math.max(1, Number(S.memoryTopK) || 5));
    if (!finalScored.length) return '';
    return `[相关历史聊天记录检索（来自完整聊天记录，含隐藏消息）]\n${finalScored
        .map(s => `- ${s.text}`).join('\n')}`;
}

// ==================== 扩展提示注入 ====================
function setExtensionPrompt(key, value, position, depth) {
    const ctx = getContext();
    if (ctx.setExtensionPrompt) {
        ctx.setExtensionPrompt(key, value, position, depth);
    }
}

// ==================== UI ====================
const t = (k) => `smart-hub-${k}`;

function buildUI() {
    const html = `
    <div id="smart-hub-settings" class="smart-hub-settings">
        <div class="sh-tabs">
            <div class="sh-tab sh-active" data-tab="conn">🔌 API 连接</div>
            <div class="sh-tab" data-tab="search">🔍 联网搜索</div>
            <div class="sh-tab" data-tab="memory">🧠 向量记忆</div>
            <div class="sh-tab" data-tab="chat">📜 聊天记录</div>
        </div>

        <!-- API 连接 -->
        <div class="sh-panel sh-active" data-panel="conn">
            <div class="sh-title">独立 API（OpenAI 兼容格式）</div>
            <div class="sh-hint">支持任意 OpenAI 兼容接口（one-api / new-api / ollama / vllm / llamacpp 等），与酒馆自带 API 相互独立。</div>
            <div class="sh-row"><label>API 地址</label><input id="${t('api-url')}" type="text" placeholder="https://api.example.com" autocomplete="off"></div>
            <div class="sh-row"><label>API 密钥</label><input id="${t('api-key')}" type="password" placeholder="sk-...（可留空）" autocomplete="off"></div>
            <div class="sh-btn-group">
                <button id="${t('pull-models')}" class="menu_button">⟳ 拉取模型列表</button>
                <button id="${t('test-conn')}" class="menu_button">⚡ 测试连接</button>
            </div>
            <div class="sh-row" style="margin-top:8px"><label>选择模型</label><select id="${t('model-select')}"><option value="">-- 先拉取模型 --</option></select></div>
            <div class="sh-hint">所选模型用于：联网搜索问答、聊天记录总结、记忆检索改写等本扩展直接调用 AI 的场景。</div>
            <div id="sh-status" class="sh-status sh-ok">就绪</div>
        </div>

        <!-- 联网搜索 -->
        <div class="sh-panel" data-panel="search">
            <div class="sh-title">必应联网搜索</div>
            <div class="sh-hint">浏览器无法直连必应（CORS 限制），请运行插件目录下 bridge/server.mjs 桥接服务（默认 http://127.0.0.1:5123），或填写任何兼容 {query,count,engine} 的搜索接口。</div>
            <div class="sh-row"><label>搜索接口地址</label><input id="${t('search-url')}" type="text" placeholder="http://127.0.0.1:5123/search"></div>
            <div class="sh-row"><label>搜索引擎</label>
                <select id="${t('search-engine')}">
                    <option value="bing">必应 Bing</option>
                    <option value="bing_cn">必应中国版</option>
                    <option value="duckduckgo">DuckDuckGo（备用）</option>
                </select>
            </div>
            <div class="sh-row"><label>结果数量</label><input id="${t('search-count')}" type="number" min="1" max="20" value="5"></div>
            <div class="sh-row"><label class="checkbox_label"><input id="${t('auto-search')}" type="checkbox"><span>发送消息时自动搜索</span></label></div>
            <div class="sh-row"><label class="checkbox_label"><input id="${t('search-inject')}" type="checkbox"><span>搜索结果注入提示词</span></label></div>
            <div class="sh-row"><label>手动搜索</label><input id="${t('search-query')}" type="text" placeholder="输入要搜索的内容"></div>
            <div class="sh-btn-group">
                <button id="${t('do-search')}" class="menu_button">🔍 搜索</button>
                <button id="${t('search-inject-btn')}" class="menu_button">📥 搜索并注入</button>
            </div>
            <div class="sh-hint">也可以在输入框使用 <code>/sh搜索 关键词</code> 或 <code>/shweb 关键词</code> 快捷指令。</div>
        </div>

        <!-- 向量记忆 -->
        <div class="sh-panel" data-panel="memory">
            <div class="sh-title">向量 + 重排序记忆检索</div>
            <div class="sh-hint">使用独立配置的向量模型对<b>完整聊天记录（包含被隐藏的消息）</b>建立向量索引，并在每次生成前按当前消息语义检索相关历史，经重排序模型精排后注入提示词。</div>
            <div class="sh-row"><label class="checkbox_label"><input id="${t('memory-enabled')}" type="checkbox"><span>启用记忆检索</span></label></div>
            <div class="sh-row"><label>向量 API 地址</label><input id="${t('embed-url')}" type="text" placeholder="留空复用主 API"></div>
            <div class="sh-row"><label>向量 API 密钥</label><input id="${t('embed-key')}" type="password" placeholder="留空复用主 API 密钥"></div>
            <div class="sh-row"><label>向量模型</label><input id="${t('embed-model')}" type="text" placeholder="text-embedding-3-small / bge-m3 等"></div>
            <div class="sh-title">重排序（Rerank）</div>
            <div class="sh-row"><label>Rerank 地址</label><input id="${t('rerank-url')}" type="text" placeholder="留空复用主 API"></div>
            <div class="sh-row"><label>Rerank 密钥</label><input id="${t('rerank-key')}" type="password" placeholder="留空复用主 API 密钥"></div>
            <div class="sh-row"><label>Rerank 模型</label><input id="${t('rerank-model')}" type="text" placeholder="bge-reranker-v2-m3 等"></div>
            <div class="sh-title">检索参数</div>
            <div class="sh-row"><label>召回条数</label><input id="${t('memory-topk')}" type="number" min="1" max="30" value="5"></div>
            <div class="sh-row"><label>分数阈值</label><input id="${t('memory-score')}" type="number" step="0.05" min="0" max="1" value="0.3"></div>
            <div class="sh-row"><label class="checkbox_label"><input id="${t('memory-rerank')}" type="checkbox"><span>启用重排序精排</span></label></div>
            <div class="sh-btn-group">
                <button id="${t('build-index')}" class="menu_button">🧱 立即重建索引</button>
                <button id="${t('test-retrieve')}" class="menu_button">🧪 测试检索</button>
            </div>
            <div class="sh-hint">索引按会话保存，消息内容变化时自动增量更新（新增/修改的消息才会重新向量化）。</div>
        </div>

        <!-- 聊天记录 -->
        <div class="sh-panel" data-panel="chat">
            <div class="sh-title">完整聊天记录</div>
            <div class="sh-hint">直接读取会话底层数据，<b>不受消息隐藏（灯泡）、正则隐藏/替换、仅显示层过滤的影响</b>，展示和导出的都是原始完整记录。被隐藏的消息会以红色标记。</div>
            <div class="sh-btn-group">
                <button id="${t('view-chat')}" class="menu_button">📜 查看完整记录</button>
                <button id="${t('export-txt')}" class="menu_button">💾 导出 TXT</button>
                <button id="${t('export-json')}" class="menu_button">💾 导出 JSON</button>
                <button id="${t('ai-summarize')}" class="menu_button">🤖 AI 读取并总结</button>
            </div>
            <div class="sh-hint">「AI 读取并总结」会把全部聊天记录（含隐藏消息）发送到上方配置的独立 API 模型进行总结，总结结果复制到剪贴板。</div>
        </div>
    </div>`;

    $('#extensions_settings2').append(html);

    // 绑定开关与输入
    const bindText = (id, key, transform = v => v) =>
        $(`#${id}`).on('input', debounce(function () { S[key] = transform($(this).val()); saveSettingsDebounced(); }, 400));
    const bindCheck = (id, key) =>
        $(`#${id}`).on('change', function () { S[key] = $(this).prop('checked'); saveSettingsDebounced(); });

    bindText(t('api-url'), 'apiUrl', v => v.replace(/\/+$/, ''));
    bindText(t('api-key'), 'apiKey');
    bindText(t('embed-url'), 'embedApiUrl', v => v.replace(/\/+$/, ''));
    bindText(t('embed-key'), 'embedApiKey');
    bindText(t('embed-model'), 'embedModel');
    bindText(t('rerank-url'), 'rerankApiUrl', v => v.replace(/\/+$/, ''));
    bindText(t('rerank-key'), 'rerankApiKey');
    bindText(t('rerank-model'), 'rerankModel');
    bindText(t('search-url'), 'searchUrl');
    bindText(t('search-query'), '_tmpQuery');
    bindText(t('search-count'), 'searchCount', v => Number(v));
    bindText(t('memory-topk'), 'memoryTopK', v => Number(v));
    bindText(t('memory-score'), 'memoryScore', v => Number(v));
    bindCheck(t('auto-search'), 'autoSearch');
    bindCheck(t('search-inject'), 'searchInject');
    bindCheck(t('memory-enabled'), 'memoryEnabled');
    bindCheck(t('memory-rerank'), 'memoryRerank');

    // 标签页切换
    $('#smart-hub-settings .sh-tab').on('click', function () {
        const tab = $(this).data('tab');
        $('#smart-hub-settings .sh-tab').removeClass('sh-active');
        $('#smart-hub-settings .sh-panel').removeClass('sh-active');
        $(this).addClass('sh-active');
        $(`#smart-hub-settings .sh-panel[data-panel="${tab}"]`).addClass('sh-active');
    });

    // 拉取模型
    $(`#${t('pull-models')}`).on('click', async () => {
        try {
            status('正在拉取模型列表...', 'warn');
            const models = await fetchModels(S.apiUrl, S.apiKey);
            S.modelCache = models;
            saveSettingsDebounced();
            const $sel = $(`#${t('model-select')}`).empty();
            $sel.append('<option value="">-- 选择模型 --</option>');
            for (const m of models) $sel.append(`<option value="${m}">${m}</option>`);
            status(`成功拉取 ${models.length} 个模型`, 'ok');
        } catch (e) {
            status(e.message, 'err');
        }
    });

    // 测试连接
    $(`#${t('test-conn')}`).on('click', async () => {
        try {
            const models = await fetchModels(S.apiUrl, S.apiKey);
            status(`连接成功 ✓ 共 ${models.length} 个模型可用`, 'ok');
        } catch (e) {
            status(`连接失败：${e.message}`, 'err');
        }
    });

    // 模型选择
    $(`#${t('model-select')}`).on('change', function () {
        S.selectedModel = $(this).val();
        saveSettingsDebounced();
    });

    // 手动搜索
    const manualSearch = async (inject) => {
        const q = $(`#${t('search-query')}`).val().trim();
        if (!q) return status('请输入搜索内容', 'err');
        try {
            if (inject) await doSearchAndInject(q);
            else {
                const results = await webSearch(q);
                const off = $(`#${t('do-search')}`).offset();
                showSearchPopup(q, results, off.left, off.top + 30);
                status(`搜索完成，共 ${results.length} 条结果`, 'ok');
            }
        } catch (e) { status(e.message, 'err'); }
    };
    $(`#${t('do-search')}`).on('click', () => manualSearch(false));
    $(`#${t('search-inject-btn')}`).on('click', () => manualSearch(true));

    // 重建索引
    $(`#${t('build-index')}`).on('click', async () => {
        try {
            await buildMemoryIndex(true);
            const ctx = getContext();
            const n = (S.vectors[ctx.chatId] || []).filter(Boolean).length;
            status(`索引重建完成 ✓ 已向量化 ${n} 条消息（含隐藏消息）`, 'ok');
        } catch (e) { status(e.message, 'err'); }
    });

    // 测试检索
    $(`#${t('test-retrieve')}`).on('click', async () => {
        try {
            const q = $(`#${t('search-query')}`).val().trim() || $('#send_textarea').val().trim();
            if (!q) return status('请先在搜索框输入测试问题', 'err');
            const result = await retrieveMemory(q);
            status(result ? `检索到相关记忆：\n${result.slice(0, 500)}` : '未检索到相关记忆', result ? 'ok' : 'warn');
        } catch (e) { status(e.message, 'err'); }
    });

    // 聊天记录
    $(`#${t('view-chat')}`).on('click', openChatViewer);
    $(`#${t('export-txt')}`).on('click', () => {
        const blob = new Blob([chatToTranscript(getFullChat())], { type: 'text/plain;charset=utf-8' });
        downloadBlob(blob, `${getContext().chatId || 'chat'}-完整记录.txt`);
        status('已导出 TXT', 'ok');
    });
    $(`#${t('export-json')}`).on('click', () => {
        const blob = new Blob([JSON.stringify(getFullChat(), null, 2)], { type: 'application/json' });
        downloadBlob(blob, `${getContext().chatId || 'chat'}-完整记录.json`);
        status('已导出 JSON', 'ok');
    });
    $(`#${t('ai-summarize')}`).on('click', aiSummarizeChat);

    // 初始化 UI 值
    $(`#${t('api-url')}`).val(S.apiUrl);
    $(`#${t('api-key')}`).val(S.apiKey);
    $(`#${t('embed-url')}`).val(S.embedApiUrl);
    $(`#${t('embed-key')}`).val(S.embedApiKey);
    $(`#${t('embed-model')}`).val(S.embedModel);
    $(`#${t('rerank-url')}`).val(S.rerankApiUrl);
    $(`#${t('rerank-key')}`).val(S.rerankApiKey);
    $(`#${t('rerank-model')}`).val(S.rerankModel);
    $(`#${t('search-url')}`).val(S.searchUrl);
    $(`#${t('search-engine')}`).val(S.searchEngine).on('change', function () { S.searchEngine = $(this).val(); saveSettingsDebounced(); });
    $(`#${t('search-count')}`).val(S.searchCount);
    $(`#${t('auto-search')}`).prop('checked', S.autoSearch);
    $(`#${t('search-inject')}`).prop('checked', S.searchInject);
    $(`#${t('memory-enabled')}`).prop('checked', S.memoryEnabled);
    $(`#${t('memory-rerank')}`).prop('checked', S.memoryRerank);
    $(`#${t('memory-topk')}`).val(S.memoryTopK);
    $(`#${t('memory-score')}`).val(S.memoryScore);

    if (S.modelCache?.length) {
        const $sel = $(`#${t('model-select')}`).empty();
        $sel.append('<option value="">-- 选择模型 --</option>');
        for (const m of S.modelCache) $sel.append(`<option value="${m}">${m}</option>`);
        $sel.val(S.selectedModel || '');
    }
}

function downloadBlob(blob, name) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    URL.revokeObjectURL(a.href);
}

// ==================== 聊天记录查看抽屉 ====================
function openChatViewer() {
    $('#sh-chat-viewer').remove();
    const msgs = getFullChat();
    const html = msgs.map(m => `
        <div class="sh-msg ${m.role === 'user' ? 'sh-user' : 'sh-char'} ${m.hidden ? 'sh-hidden' : ''}">
            <div class="sh-msg-meta">
                <span>${$('<i>').text(m.name).html()}</span>
                ${m.hidden ? '<span style="color:#f44336">🚫 已隐藏（完整记录中可见）</span>' : ''}
            </div>
            <div class="sh-msg-body">${$('<i>').text(m.text).html()}</div>
        </div>`).join('');
    const $v = $(`
        <div id="sh-chat-viewer" class="sh-open">
            <div class="sh-viewer-head">
                <span>📜 完整聊天记录（${msgs.length} 条，含隐藏）</span>
                <span class="sh-popup-close" title="关闭">✕</span>
            </div>
            <div class="sh-viewer-body">${html || '<p style="opacity:.6">当前会话没有消息</p>'}</div>
        </div>`);
    $('body').append($v);
    $v.find('.sh-popup-close').on('click', () => $v.remove());
}

// ==================== AI 读取并总结 ====================
async function aiSummarizeChat() {
    if (!S.apiUrl) return status('请先配置 API 地址', 'err');
    if (!S.selectedModel) return status('请先拉取并选择模型', 'err');
    const transcript = chatToTranscript(getFullChat());
    status(`正在让 AI 读取 ${getFullChat().length} 条完整记录并总结...`, 'warn');
    try {
        const data = await apiFetch(S.apiUrl, S.apiKey, '/v1/chat/completions', {
            model: S.selectedModel,
            messages: [
                { role: 'system', content: '你是聊天记录分析助手。请完整阅读用户提供的全部聊天记录（包含原本被隐藏的消息），做一份结构化总结：主要事件、人物关系、重要伏笔与细节。' },
                { role: 'user', content: `以下是完整聊天记录：\n\n${transcript}` },
            ],
        });
        const summary = data.choices?.[0]?.message?.content || '(空回复)';
        await navigator.clipboard.writeText(summary).catch(() => {});
        status(`总结完成（已复制到剪贴板）：\n${summary.slice(0, 600)}`, 'ok');
    } catch (e) {
        status(`总结失败：${e.message}`, 'err');
    }
}

// ==================== 事件钩子 ====================
async function onGenerationStarted(type, options, dryRun) {
    if (dryRun) return;
    const ctx = getContext();
    const lastUser = [...(ctx.chat || [])].reverse().find(m => m.is_user);
    const query = $('#send_textarea').val().trim() || lastUser?.mes || '';

    // 自动搜索
    if (S.autoSearch && S.searchUrl && query) {
        try {
            const { formatted } = await doSearchAndInject(query.slice(0, 200));
            if (!S.searchInject) setExtensionPrompt('smart-hub-search', '', 1, 1);
        } catch (e) {
            status(`自动搜索失败：${e.message}`, 'err');
        }
    } else if (!S.autoSearch) {
        setExtensionPrompt('smart-hub-search', '', 1, 1);
    }

    // 记忆检索
    if (S.memoryEnabled && query) {
        try {
            const memory = await retrieveMemory(query.slice(0, 500));
            if (memory) setExtensionPrompt('smart-hub-memory', memory, 1, 0);
            else setExtensionPrompt('smart-hub-memory', '', 1, 0);
        } catch (e) {
            status(`记忆检索失败：${e.message}`, 'err');
        }
    }
}

// ==================== 快捷指令 ====================
function registerSlashCommands() {
    try {
        const SlashCommandParser = window.SlashCommandParser;
        const SlashCommand = window.SlashCommand;
        if (!SlashCommandParser) return;
        SlashCommandParser.addCommandObject(SlashCommand.fromProps({
            name: 'sh搜索',
            callback: async (args, value) => {
                if (!value) return '用法：/sh搜索 关键词';
                try {
                    const results = await webSearch(value);
                    showSearchPopup(value, results, 100, 100);
                    return formatSearchResults(results);
                } catch (e) { return `搜索失败：${e.message}`; }
            },
            helpString: '使用必应搜索并弹出结果浮层',
        }));
        SlashCommandParser.addCommandObject(SlashCommand.fromProps({
            name: 'shweb',
            callback: async (args, value) => {
                if (!value) return '用法：/shweb 关键词';
                try {
                    const { results } = await doSearchAndInject(value);
                    return formatSearchResults(results);
                } catch (e) { return `搜索失败：${e.message}`; }
            },
            helpString: '使用必应搜索并将结果注入提示词',
        }));
        SlashCommandParser.addCommandObject(SlashCommand.fromProps({
            name: 'sh聊天记录',
            callback: async () => openChatViewer(),
            helpString: '打开完整聊天记录查看器（含隐藏消息）',
        }));
    } catch (e) {
        LOG('斜杠指令注册失败（不影响其他功能）：', e);
    }
}

// ==================== 输入框快捷按钮 ====================
function addQuickButtons() {
    const $area = $('#send_textarea');
    if (!$area.length) return;
    const $btn = $(`<div class="sh-quick-btn fa-solid fa-magnifying-glass" title="Smart Hub 快速搜索（必应）"></div>`);
    $btn.on('click', async () => {
        const q = $area.val().trim();
        if (!q) return toastr.warning('请先在输入框输入要搜索的内容', 'Smart Hub');
        try {
            const results = await webSearch(q);
            const off = $btn.offset();
            showSearchPopup(q, results, off.left - 400, off.top - 100);
        } catch (e) { toastr.error(e.message, 'Smart Hub 搜索失败'); }
    });
    $('#send_but_shush').before($btn);
}

// ==================== 初始化 ====================
jQuery(async () => {
    buildUI();
    registerSlashCommands();

    // 生成前钩子
    const ctx = getContext();
    if (ctx.eventSource) {
        ctx.eventSource.on(ctx.event_types.GENERATION_STARTED, onGenerationStarted);
        // 会话切换后如启用记忆则自动增量索引
        ctx.eventSource.on(ctx.event_types.CHAT_CHANGED, async () => {
            if (S.memoryEnabled && S.embedModel) {
                buildMemoryIndex(false).catch(e => status(`记忆索引更新失败：${e.message}`, 'err'));
            }
        });
    }

    addQuickButtons();
    LOG('扩展加载完成 ✓');
});
