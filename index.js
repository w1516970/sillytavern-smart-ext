// Smart Hub - 智能中枢 · SillyTavern 扩展 (v1.1.0)
// 简洁模式：只在魔法棒(扩展设置)显示，主开关控制联网搜索，
// 开启后当前对话 API 每轮生成前自动用必应搜索并注入结果。

import { extension_settings, getContext } from '../../../extensions.js';
import { saveSettingsDebounced } from '../../../../script.js';
import { debounce } from '../../../utils.js';

const MODULE = 'smart-hub';
const LOG = (...m) => console.log('[SmartHub]', ...m);

const defaultSettings = {
    // 主开关：联网搜索
    autoSearch: true,
    // 独立 API
    apiUrl: '',
    apiKey: '',
    selectedModel: '',
    modelCache: [],
    // 搜索
    searchUrl: 'http://127.0.0.1:5123/search',
    searchEngine: 'bing',
    searchCount: 5,
    // 高级：向量记忆
    memoryEnabled: false,
    embedApiUrl: '', embedApiKey: '', embedModel: '',
    rerankApiUrl: '', rerankApiKey: '', rerankModel: '',
    memoryTopK: 5, memoryRerank: true, memoryScore: 0.3,
    vectors: {},
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

// ==================== 工具 ====================
function status(msg, type = 'ok') {
    const $el = $('#sh-status');
    if (!$el.length) return;
    $el.removeClass('sh-ok sh-err sh-warn').addClass(`sh-${type}`);
    $el.text(`[${new Date().toLocaleTimeString()}] ${msg}`);
    LOG(msg);
}

async function apiFetch(baseUrl, apiKey, path, body) {
    const url = new URL(path, baseUrl.startsWith('http') ? baseUrl : `http://${baseUrl}`).href;
    const headers = { 'Content-Type': 'application/json' };
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
    const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
    if (!res.ok) throw new Error(`API ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
    return res.json();
}

async function fetchModels(baseUrl, apiKey) {
    const url = new URL('/v1/models', baseUrl.startsWith('http') ? baseUrl : `http://${baseUrl}`).href;
    const headers = {};
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
    const res = await fetch(url, { headers });
    if (!res.ok) throw new Error(`拉取失败 ${res.status}`);
    return (await res.json()).data.map(m => m.id).sort();
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
    for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] ** 2; nb += b[i] ** 2; }
    return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

function setExtPrompt(key, value) {
    const ctx = getContext();
    if (ctx.setExtensionPrompt) ctx.setExtensionPrompt(key, value, 1, 1);
}

// ==================== 完整聊天记录（无视隐藏/正则） ====================
function getFullChat() {
    const chat = getContext().chat || [];
    const msgs = [];
    for (const m of chat) {
        if (!m || m.is_thinking) continue;
        const text = String(m.mes ?? '').trim();
        if (!text) continue;
        msgs.push({
            name: m.name || (m.is_user ? 'User' : 'Assistant'),
            role: m.is_user ? 'user' : 'assistant',
            hidden: !!m.is_system,
            text,
        });
    }
    return msgs;
}
const chatToTranscript = (msgs) => msgs.map(m => `${m.name}${m.hidden ? ' [隐藏]' : ''}: ${m.text}`).join('\n\n');

// ==================== 必应搜索 ====================
async function webSearch(query) {
    if (!S.searchUrl) throw new Error('未配置搜索接口（请启动 bridge/server.mjs）');
    const res = await fetch(S.searchUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, count: Number(S.searchCount) || 5, engine: S.searchEngine || 'bing' }),
    });
    if (!res.ok) throw new Error(`搜索接口 ${res.status}`);
    const results = (await res.json()).results || [];
    if (!results.length) throw new Error('搜索无结果');
    return results;
}

const formatResults = (results) =>
    `[联网搜索结果 - ${new Date().toLocaleString()}]\n` +
    results.map((r, i) => `[${i + 1}] ${r.title}\nURL: ${r.url}\n${r.snippet || ''}`).join('\n\n');

async function autoSearchInject(query) {
    const results = await webSearch(query);
    setExtPrompt('smart-hub-search', formatResults(results));
    LOG(`联网搜索完成：${query} -> ${results.length} 条结果已注入`);
    return results;
}

// ==================== 向量记忆（完整聊天记录检索） ====================
async function embedTexts(texts) {
    const url = S.embedApiUrl || S.apiUrl;
    const key = S.embedApiKey || S.apiKey;
    if (!url || !S.embedModel) throw new Error('未配置向量模型');
    const data = await apiFetch(url, key, '/v1/embeddings', { model: S.embedModel, input: texts });
    return data.data.sort((a, b) => a.index - b.index).map(d => d.embedding);
}

async function rerank(query, documents) {
    const url = S.rerankApiUrl || S.apiUrl;
    const key = S.rerankApiKey || S.apiKey;
    if (!url || !S.rerankModel) return documents.map(text => ({ text, score: 1 }));
    const data = await apiFetch(url, key, '/v1/rerank', { model: S.rerankModel, query, documents });
    return (data.results || data.data || [])
        .map(r => ({ index: r.index, score: r.relevance_score ?? r.score ?? 0 }))
        .sort((a, b) => b.score - a.score)
        .map(r => ({ text: documents[r.index], score: r.score }));
}

async function retrieveMemory(query, force = false) {
    const ctx = getContext();
    const chatId = ctx.chatId || 'unknown';
    const msgs = getFullChat();
    if (!msgs.length) return '';
    const texts = msgs.map(m => `${m.name}: ${m.text}`);
    const store = (S.vectors[chatId] ??= []);
    const needIdx = [];
    for (let i = 0; i < texts.length; i++) {
        const h = hashString(texts[i]);
        if (force || !store[i] || store[i].hash !== h) needIdx.push(i);
    }
    if (needIdx.length) {
        const vecs = await embedTexts(needIdx.map(i => texts[i].slice(0, 4000)));
        needIdx.forEach((idx, j) => { store[idx] = { hash: hashString(texts[idx]), vector: vecs[j] }; });
        saveSettingsDebounced();
    }
    const [qv] = await embedTexts([query.slice(0, 4000)]);
    let scored = store
        .map((s, i) => s && s.vector ? { text: texts[i], score: cosine(qv, s.vector) } : null)
        .filter(Boolean).sort((a, b) => b.score - a.score)
        .slice(0, Math.max(1, Number(S.memoryTopK) || 5));
    if (S.memoryRerank) scored = await rerank(query, scored.map(s => s.text));
    return scored.filter(s => s.score >= (Number(S.memoryScore) || 0.3))
        .map(s => `- ${s.text}`).join('\n');
}

// ==================== 生成前钩子：核心逻辑 ====================
async function onGenerationStarted(_type, _options, dryRun) {
    if (dryRun) return;
    const ctx = getContext();
    const lastUser = [...(ctx.chat || [])].reverse().find(m => m.is_user);
    const query = ($('#send_textarea').val() || '').trim() || lastUser?.mes || '';
    if (!query) return;

    // 联网搜索（主开关）
    if (S.autoSearch) {
        if (!S.searchUrl) {
            status('联网搜索已开启，但未配置搜索接口，请启动 bridge/server.mjs', 'warn');
        } else {
            try {
                status('联网搜索中（必应）...', 'warn');
                await autoSearchInject(query.slice(0, 300));
                status(`已注入必应搜索结果 ✓（${query.slice(0, 30)}...）`, 'ok');
            } catch (e) {
                status(`联网搜索失败：${e.message}（不影响本次对话）`, 'err');
            }
        }
    } else {
        setExtPrompt('smart-hub-search', '');
    }

    // 记忆检索（高级开关）
    if (S.memoryEnabled && S.embedModel) {
        try {
            const memory = await retrieveMemory(query.slice(0, 500));
            setExtPrompt('smart-hub-memory', memory ? `[相关历史记录]\n${memory}` : '');
        } catch (e) {
            LOG('记忆检索失败：', e);
        }
    } else {
        setExtPrompt('smart-hub-memory', '');
    }
}

// ==================== UI（只在魔法棒/扩展设置显示，单面板简洁版） ====================
const t = (k) => `smart-hub-${k}`;

function buildUI() {
    $('#smart-hub-settings').remove();

    const html = `
    <div id="smart-hub-settings">
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>🌐 Smart Hub 智能中枢</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content" style="padding:8px 12px">

                <!-- 主开关：联网搜索 -->
                <div class="sh-main-toggle">
                    <label class="checkbox_label sh-switch-row">
                        <input id="${t('auto-search')}" type="checkbox">
                        <span class="sh-switch-title">🔍 联网搜索（必应）</span>
                    </label>
                    <div class="sh-hint">开启后，当前对话每轮生成前会自动用必应搜索用户消息，并把结果注入给 AI。对话照常进行，无需其他操作。</div>
                </div>

                <!-- 状态 -->
                <div id="sh-status" class="sh-status sh-ok">就绪 — 联网搜索 ${S.autoSearch ? '已开启 ✅' : '已关闭'}</div>

                <!-- 搜索接口 -->
                <div class="sh-sec">
                    <div class="sh-sec-title">搜索接口</div>
                    <div class="sh-hint">需在运行酒馆的设备上启动 <code>node bridge/server.mjs</code>（插件目录内，零依赖）。</div>
                    <div class="sh-row"><label>接口地址</label><input id="${t('search-url')}" type="text" placeholder="http://127.0.0.1:5123/search"></div>
                    <div class="sh-row">
                        <label>引擎</label>
                        <select id="${t('search-engine')}">
                            <option value="bing">必应</option>
                            <option value="bing_cn">必应中国版</option>
                            <option value="duckduckgo">DuckDuckGo</option>
                        </select>
                        <label>条数</label><input id="${t('search-count')}" type="number" min="1" max="20" value="5">
                    </div>
                </div>

                <!-- 高级选项（折叠） -->
                <div class="inline-drawer sh-adv">
                    <div class="inline-drawer-toggle inline-drawer-header">
                        <b>⚙️ 高级选项</b>
                        <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
                    </div>
                    <div class="inline-drawer-content" style="padding:6px 4px">

                        <div class="sh-sec">
                            <div class="sh-sec-title">独立 API（OpenAI 兼容）</div>
                            <div class="sh-row"><label>API 地址</label><input id="${t('api-url')}" type="text" placeholder="https://api.example.com"></div>
                            <div class="sh-row"><label>API 密钥</label><input id="${t('api-key')}" type="password" placeholder="sk-...（可留空）"></div>
                            <div class="sh-row">
                                <button id="${t('pull-models')}" class="menu_button menu_button_icon"><i class="fa-solid fa-rotate"></i> 拉取模型</button>
                                <select id="${t('model-select')}"><option value="">-- 选择模型 --</option></select>
                            </div>
                            <div class="sh-hint">用于本扩展直接调用 AI 的场景（如 AI 总结聊天记录）。</div>
                        </div>

                        <div class="sh-sec">
                            <div class="sh-sec-title">
                                <label class="checkbox_label"><input id="${t('memory-enabled')}" type="checkbox"><span>🧠 向量记忆检索（读取完整聊天记录）</span></label>
                            </div>
                            <div class="sh-hint">用向量 + 重排序模型对完整聊天记录（含被隐藏的消息）做语义检索并注入。不受消息隐藏和正则影响。</div>
                            <div class="sh-row"><label>向量地址</label><input id="${t('embed-url')}" type="text" placeholder="留空复用主 API"></div>
                            <div class="sh-row"><label>向量密钥</label><input id="${t('embed-key')}" type="password" placeholder="留空复用主密钥"></div>
                            <div class="sh-row"><label>向量模型</label><input id="${t('embed-model')}" type="text" placeholder="text-embedding-3-small / bge-m3"></div>
                            <div class="sh-row"><label>Rerank 地址</label><input id="${t('rerank-url')}" type="text" placeholder="留空复用主 API"></div>
                            <div class="sh-row"><label>Rerank 密钥</label><input id="${t('rerank-key')}" type="password" placeholder="留空复用主密钥"></div>
                            <div class="sh-row"><label>Rerank 模型</label><input id="${t('rerank-model')}" type="text" placeholder="bge-reranker-v2-m3"></div>
                            <div class="sh-row">
                                <label>召回条数</label><input id="${t('memory-topk')}" type="number" min="1" max="30" value="5">
                                <label class="checkbox_label"><input id="${t('memory-rerank')}" type="checkbox"><span>启用重排</span></label>
                            </div>
                            <div class="sh-btn-group">
                                <button id="${t('build-index')}" class="menu_button">🧱 重建索引</button>
                            </div>
                        </div>

                        <div class="sh-sec">
                            <div class="sh-sec-title">📜 完整聊天记录</div>
                            <div class="sh-btn-group">
                                <button id="${t('view-chat')}" class="menu_button">查看</button>
                                <button id="${t('export-txt')}" class="menu_button">导出 TXT</button>
                                <button id="${t('ai-summarize')}" class="menu_button">AI 总结</button>
                            </div>
                            <div class="sh-hint">直接读取底层数据，无视隐藏与正则。被隐藏的消息以红色标记。</div>
                        </div>

                    </div>
                </div>

            </div>
        </div>
    </div>`;

    $('#extensions_settings2').append(html);

    // ---- 绑定 ----
    const bindText = (id, key, transform = v => v) =>
        $(`#${id}`).on('input', debounce(function () { S[key] = transform($(this).val()); saveSettingsDebounced(); }, 400));

    bindText(t('api-url'), 'apiUrl', v => v.replace(/\/+$/, ''));
    bindText(t('api-key'), 'apiKey');
    bindText(t('embed-url'), 'embedApiUrl', v => v.replace(/\/+$/, ''));
    bindText(t('embed-key'), 'embedApiKey');
    bindText(t('embed-model'), 'embedModel');
    bindText(t('rerank-url'), 'rerankApiUrl', v => v.replace(/\/+$/, ''));
    bindText(t('rerank-key'), 'rerankApiKey');
    bindText(t('rerank-model'), 'rerankModel');
    bindText(t('search-url'), 'searchUrl');
    bindText(t('search-count'), 'searchCount', v => Number(v));
    bindText(t('memory-topk'), 'memoryTopK', v => Number(v));

    // 主开关
    $(`#${t('auto-search')}`).on('change', function () {
        S.autoSearch = $(this).prop('checked');
        saveSettingsDebounced();
        if (!S.autoSearch) setExtPrompt('smart-hub-search', '');
        status(`联网搜索 ${S.autoSearch ? '已开启 ✅ 下一轮对话自动生效' : '已关闭'}`);
    });
    $(`#${t('search-engine')}`).on('change', function () { S.searchEngine = $(this).val(); saveSettingsDebounced(); });
    $(`#${t('memory-enabled')}`).on('change', function () { S.memoryEnabled = $(this).prop('checked'); saveSettingsDebounced(); });
    $(`#${t('memory-rerank')}`).on('change', function () { S.memoryRerank = $(this).prop('checked'); saveSettingsDebounced(); });

    // 拉取模型
    $(`#${t('pull-models')}`).on('click', async () => {
        try {
            status('正在拉取模型列表...', 'warn');
            const models = await fetchModels(S.apiUrl, S.apiKey);
            S.modelCache = models; saveSettingsDebounced();
            const $sel = $(`#${t('model-select')}`).empty();
            $sel.append('<option value="">-- 选择模型 --</option>');
            for (const m of models) $sel.append(`<option value="${m}">${m}</option>`);
            $sel.val(S.selectedModel || '');
            status(`拉取成功，共 ${models.length} 个模型`);
        } catch (e) { status(e.message, 'err'); }
    });
    $(`#${t('model-select')}`).on('change', function () { S.selectedModel = $(this).val(); saveSettingsDebounced(); });

    // 重建索引
    $(`#${t('build-index')}`).on('click', async () => {
        try {
            status('正在重建向量索引...', 'warn');
            await retrieveMemory('全文索引', true);
            const ctx = getContext();
            const n = (S.vectors[ctx.chatId] || []).filter(Boolean).length;
            status(`索引重建完成 ✓ 共 ${n} 条（含隐藏消息）`);
        } catch (e) { status(e.message, 'err'); }
    });

    // 聊天记录
    $(`#${t('view-chat')}`).on('click', openChatViewer);
    $(`#${t('export-txt')}`).on('click', () => {
        const blob = new Blob([chatToTranscript(getFullChat())], { type: 'text/plain;charset=utf-8' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `${getContext().chatId || 'chat'}-完整记录.txt`;
        a.click();
        status('已导出 TXT');
    });
    $(`#${t('ai-summarize')}`).on('click', aiSummarizeChat);

    // ---- 回填 ----
    $(`#${t('auto-search')}`).prop('checked', S.autoSearch);
    $(`#${t('search-url')}`).val(S.searchUrl);
    $(`#${t('search-engine')}`).val(S.searchEngine);
    $(`#${t('search-count')}`).val(S.searchCount);
    $(`#${t('api-url')}`).val(S.apiUrl);
    $(`#${t('api-key')}`).val(S.apiKey);
    $(`#${t('embed-url')}`).val(S.embedApiUrl);
    $(`#${t('embed-key')}`).val(S.embedApiKey);
    $(`#${t('embed-model')}`).val(S.embedModel);
    $(`#${t('rerank-url')}`).val(S.rerankApiUrl);
    $(`#${t('rerank-key')}`).val(S.rerankApiKey);
    $(`#${t('rerank-model')}`).val(S.rerankModel);
    $(`#${t('memory-enabled')}`).prop('checked', S.memoryEnabled);
    $(`#${t('memory-rerank')}`).prop('checked', S.memoryRerank);
    $(`#${t('memory-topk')}`).val(S.memoryTopK);

    if (S.modelCache?.length) {
        const $sel = $(`#${t('model-select')}`).empty();
        $sel.append('<option value="">-- 选择模型 --</option>');
        for (const m of S.modelCache) $sel.append(`<option value="${m}">${m}</option>`);
        $sel.val(S.selectedModel || '');
    }
}

// ==================== 聊天记录抽屉 ====================
function openChatViewer() {
    $('#sh-chat-viewer').remove();
    const msgs = getFullChat();
    const html = msgs.map(m => `
        <div class="sh-msg ${m.role === 'user' ? 'sh-user' : 'sh-char'} ${m.hidden ? 'sh-hidden' : ''}">
            <div class="sh-msg-meta">
                <span>${$('<i>').text(m.name).html()}</span>
                ${m.hidden ? '<span style="color:#f44336">🚫 已隐藏（此处可见）</span>' : ''}
            </div>
            <div class="sh-msg-body">${$('<i>').text(m.text).html()}</div>
        </div>`).join('');
    $('body').append($(`
        <div id="sh-chat-viewer" class="sh-open">
            <div class="sh-viewer-head">
                <span>📜 完整聊天记录（${msgs.length} 条，含隐藏）</span>
                <span class="sh-popup-close" title="关闭">✕</span>
            </div>
            <div class="sh-viewer-body">${html || '<p style="opacity:.6">当前会话没有消息</p>'}</div>
        </div>`).on('click', '.sh-popup-close', function () { $(this).closest('#sh-chat-viewer').remove(); }));
}

// ==================== AI 总结 ====================
async function aiSummarizeChat() {
    if (!S.apiUrl || !S.selectedModel) return status('请先在高级选项中配置 API 并选择模型', 'err');
    status('AI 正在读取完整聊天记录并总结...', 'warn');
    try {
        const data = await apiFetch(S.apiUrl, S.apiKey, '/v1/chat/completions', {
            model: S.selectedModel,
            messages: [
                { role: 'system', content: '你是聊天记录分析助手。请完整阅读全部聊天记录（包含被隐藏的消息），输出结构化总结：主要事件、人物关系、重要伏笔与细节。' },
                { role: 'user', content: `完整聊天记录：\n\n${chatToTranscript(getFullChat())}` },
            ],
        });
        const summary = data.choices?.[0]?.message?.content || '(空回复)';
        await navigator.clipboard.writeText(summary).catch(() => {});
        status(`总结完成（已复制）：\n${summary.slice(0, 500)}`);
    } catch (e) { status(`总结失败：${e.message}`, 'err'); }
}

// ==================== 初始化 ====================
jQuery(async () => {
    buildUI();
    const ctx = getContext();
    if (ctx.eventSource) {
        ctx.eventSource.on(ctx.event_types.GENERATION_STARTED, onGenerationStarted);
    }
    LOG('v1.1.0 加载完成 ✓');
});
