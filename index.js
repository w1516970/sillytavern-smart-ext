// Smart Hub - 智能中枢 · SillyTavern 扩展 (v1.2.0)
// 独立对话插件：从魔法棒(扩展设置)打开独立聊天窗口，
// 使用独立 API 对话，开启联网搜索后每轮自动必应搜索并作为上下文。
// 另支持：附加酒馆完整聊天记录(含隐藏/无视正则)、向量记忆检索。

import { extension_settings, getContext } from '../../../extensions.js';
import { saveSettingsDebounced } from '../../../../script.js';
import { debounce } from '../../../utils.js';

const MODULE = 'smart-hub';
const LOG = (...m) => console.log('[SmartHub]', ...m);

const defaultSettings = {
    // 独立 API
    apiUrl: '',
    apiKey: '',
    selectedModel: '',
    modelCache: [],
    systemPrompt: '你是智能助手。回答时优先参考给出的联网搜索结果和历史资料，并注明信息来源。若信息不足请如实说明。',
    // 搜索
    autoSearch: true,        // 对话时自动联网搜索
    searchUrl: 'http://127.0.0.1:5123/search',
    searchEngine: 'bing',
    searchCount: 5,
    // 上下文
    includeTavernChat: false, // 附加酒馆完整聊天记录(含隐藏)
    tavernChatLimit: 20,      // 附加最近 N 条
    // 向量记忆
    memoryEnabled: false,
    embedApiUrl: '', embedApiKey: '', embedModel: '',
    rerankApiUrl: '', rerankApiKey: '', rerankModel: '',
    memoryTopK: 5, memoryRerank: true, memoryScore: 0.3,
    vectors: {},
    // 独立对话记录
    chatHistory: [],          // [{role, content, time}]
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

function chatStatus(msg, type = 'ok') {
    const $el = $('#sh-chat-status');
    if (!$el.length) return;
    $el.removeClass('sh-ok sh-err sh-warn').addClass(`sh-${type}`);
    $el.text(msg);
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
    results.map((r, i) => `[${i + 1}] ${r.title}(${r.url})\n${r.snippet || ''}`).join('\n\n');

// ==================== 向量记忆 ====================
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

// ==================== 独立对话窗口 ====================
let sending = false;

function openChatWindow() {
    $('#sh-chat-window').remove();
    const $w = $(`
        <div id="sh-chat-window" class="sh-open">
            <div class="sh-chat-head">
                <div class="sh-chat-head-title">
                    <i class="fa-solid fa-comments"></i>
                    <span>Smart Hub 独立对话</span>
                    ${S.autoSearch ? '<span class="sh-badge">🔍 联网搜索开</span>' : '<span class="sh-badge sh-badge-off">🔍 联网搜索关</span>'}
                </div>
                <div class="sh-chat-head-btns">
                    <span class="sh-chat-clear" title="清空对话">🗑</span>
                    <span class="sh-chat-close" title="关闭">✕</span>
                </div>
            </div>
            <div class="sh-chat-body">
                <div id="sh-chat-messages"></div>
                <div id="sh-chat-status" class="sh-chat-status"></div>
            </div>
            <div class="sh-chat-input-bar">
                <textarea id="sh-chat-input" rows="1" placeholder="输入消息，Enter 发送（Shift+Enter 换行）"></textarea>
                <button id="sh-chat-send" class="menu_button" title="发送"><i class="fa-solid fa-paper-plane"></i></button>
            </div>
        </div>`);
    $('body').append($w);
    renderHistory();
    $w.find('.sh-chat-close').on('click', () => $w.remove());
    $w.find('.sh-chat-clear').on('click', () => {
        if (!confirm('确定清空当前独立对话记录吗？')) return;
        S.chatHistory = []; saveSettingsDebounced(); renderHistory();
    });
    const $input = $w.find('#sh-chat-input');
    $input.on('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat(); }
    });
    $input.on('input', function () {
        this.style.height = 'auto';
        this.style.height = Math.min(this.scrollHeight, 120) + 'px';
    });
    $w.find('#sh-chat-send').on('click', () => sendChat());
    setTimeout(() => $input.trigger('focus'), 100);
}

function renderHistory() {
    const $box = $('#sh-chat-messages');
    if (!$box.length) return;
    $box.empty();
    if (!S.chatHistory.length) {
        $box.append(`<div class="sh-chat-empty">👋 开始你的独立对话吧。<br>当前模型：<b>${S.selectedModel || '未选择（去高级选项配置）'}</b><br>联网搜索：<b>${S.autoSearch ? '开' : '关'}</b></div>`);
        return;
    }
    for (const m of S.chatHistory) {
        if (m.role === 'system') continue;
        $box.append(chatBubble(m.role, m.content, m.searched));
    }
    $box.scrollTop($box[0].scrollHeight);
}

function chatBubble(role, content, searched) {
    const esc = $('<i>').text(content).html();
    return `<div class="sh-bubble sh-${role === 'user' ? 'user' : 'ai'}">
        <div class="sh-bubble-tag">${role === 'user' ? '你' : 'AI'}${searched ? ' · 🔍已联网' : ''}</div>
        <div class="sh-bubble-body">${esc}</div>
    </div>`;
}

async function sendChat() {
    if (sending) return;
    const $input = $('#sh-chat-input');
    const text = ($input.val() || '').trim();
    if (!text) return;

    if (!S.apiUrl) { chatStatus('请先在魔法棒面板的高级选项中配置独立 API 地址', 'err'); return; }
    if (!S.selectedModel) { chatStatus('请先在高级选项中拉取并选择模型', 'err'); return; }

    sending = true;
    $input.val('').trigger('input');
    const $box = $('#sh-chat-messages');
    $box.find('.sh-chat-empty').remove();

    // 用户气泡
    $box.append(chatBubble('user', text));
    $box.scrollTop($box[0].scrollHeight);

    try {
        // 1) 联网搜索
        let searchBlock = '';
        let searched = false;
        if (S.autoSearch && S.searchUrl) {
            chatStatus('🔍 正在必应搜索...', 'warn');
            try {
                const results = await webSearch(text.slice(0, 300));
                searchBlock = formatResults(results);
                searched = true;
                chatStatus(`🔍 已获取 ${results.length} 条搜索结果`, 'warn');
            } catch (e) {
                chatStatus(`搜索失败(${e.message})，继续无搜索回答`, 'warn');
            }
        }

        // 2) 组装上下文
        const messages = [{ role: 'system', content: S.systemPrompt || '你是智能助手。' }];

        if (S.includeTavernChat) {
            const full = getFullChat().slice(-Math.max(1, Number(S.tavernChatLimit) || 20));
            if (full.length) {
                messages.push({
                    role: 'system',
                    content: `[酒馆当前会话完整聊天记录（含被隐藏的消息）]\n${full.map(m => `${m.name}: ${m.text}`).join('\n')}`,
                });
            }
        }

        if (S.memoryEnabled && S.embedModel) {
            try {
                chatStatus('🧠 正在检索记忆...', 'warn');
                const memory = await retrieveMemory(text);
                if (memory) messages.push({ role: 'system', content: `[相关历史聊天记录检索]\n${memory}` });
            } catch (e) { LOG('记忆检索失败：', e); }
        }

        // 独立对话历史
        for (const m of S.chatHistory.slice(-40)) {
            if (m.role !== 'user' && m.role !== 'assistant') continue;
            messages.push({ role: m.role, content: m.content });
        }

        if (searchBlock) messages.push({ role: 'system', content: searchBlock });
        messages.push({ role: 'user', content: text });

        // 3) 请求独立 API
        chatStatus('⏳ AI 思考中...', 'warn');
        const data = await apiFetch(S.apiUrl, S.apiKey, '/v1/chat/completions', {
            model: S.selectedModel,
            messages,
            temperature: 0.7,
        });
        const reply = data.choices?.[0]?.message?.content?.trim() || '(空回复)';

        // 4) 展示 + 保存
        $box.append(chatBubble('assistant', reply, searched));
        S.chatHistory.push({ role: 'user', content: text, time: Date.now() });
        S.chatHistory.push({ role: 'assistant', content: reply, searched, time: Date.now() });
        if (S.chatHistory.length > 200) S.chatHistory = S.chatHistory.slice(-200);
        saveSettingsDebounced();
        $box.scrollTop($box[0].scrollHeight);
        chatStatus(searched ? '✓ 本次回答已联网（必应搜索）' : '✓ 完成', 'ok');
    } catch (e) {
        chatStatus(`发送失败：${e.message}`, 'err');
        $box.append(chatBubble('assistant', `⚠️ 请求失败：${e.message}`));
        $box.scrollTop($box[0].scrollHeight);
    } finally {
        sending = false;
    }
}

// ==================== 聊天记录查看抽屉（酒馆完整记录） ====================
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
                <span>📜 酒馆完整聊天记录（${msgs.length} 条，含隐藏）</span>
                <span class="sh-popup-close" title="关闭">✕</span>
            </div>
            <div class="sh-viewer-body">${html || '<p style="opacity:.6">当前会话没有消息</p>'}</div>
        </div>`).on('click', '.sh-popup-close', function () { $(this).closest('#sh-chat-viewer').remove(); }));
}

// ==================== UI（魔法棒面板） ====================
const t = (k) => `smart-hub-${k}`;

function buildUI() {
    $('#smart-hub-settings').remove();

    const html = `
    <div id="smart-hub-settings">
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>💬 Smart Hub 独立对话</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content" style="padding:8px 12px">

                <!-- 打开对话按钮 -->
                <button id="${t('open-chat')}" class="menu_button sh-open-btn">
                    <i class="fa-solid fa-comments"></i>&nbsp; 打开独立对话窗口
                </button>
                <div class="sh-hint">独立于酒馆聊天的对话窗口，使用下方配置的 API 与模型。开启「对话时联网搜索」后，每轮提问前会自动用必应搜索并把结果给 AI 参考。</div>
                <div id="sh-status" class="sh-status sh-ok">就绪 — 模型：${S.selectedModel || '未选择'}</div>

                <!-- 对话选项 -->
                <div class="sh-sec">
                    <div class="sh-sec-title">对话选项</div>
                    <div class="sh-row"><label class="checkbox_label"><input id="${t('auto-search')}" type="checkbox"><span>对话时联网搜索（必应）</span></label></div>
                    <div class="sh-row"><label class="checkbox_label"><input id="${t('include-tavern')}" type="checkbox"><span>附加酒馆完整聊天记录（含隐藏，无视正则）</span></label></div>
                    <div class="sh-row"><label>附加条数</label><input id="${t('tavern-limit')}" type="number" min="1" max="200" value="20"></div>
                    <div class="sh-row"><label>系统提示词</label><input id="${t('system-prompt')}" type="text" placeholder="AI 的角色设定"></div>
                </div>

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

                <!-- 高级选项 -->
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
                        </div>

                        <div class="sh-sec">
                            <div class="sh-sec-title">
                                <label class="checkbox_label"><input id="${t('memory-enabled')}" type="checkbox"><span>🧠 向量记忆检索</span></label>
                            </div>
                            <div class="sh-hint">用向量 + 重排序模型检索酒馆完整聊天记录（含被隐藏的消息）作为对话上下文。</div>
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
                            <div class="sh-sec-title">📜 酒馆完整聊天记录</div>
                            <div class="sh-btn-group">
                                <button id="${t('view-chat')}" class="menu_button">查看</button>
                                <button id="${t('export-txt')}" class="menu_button">导出 TXT</button>
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
    bindText(t('system-prompt'), 'systemPrompt');
    bindText(t('embed-url'), 'embedApiUrl', v => v.replace(/\/+$/, ''));
    bindText(t('embed-key'), 'embedApiKey');
    bindText(t('embed-model'), 'embedModel');
    bindText(t('rerank-url'), 'rerankApiUrl', v => v.replace(/\/+$/, ''));
    bindText(t('rerank-key'), 'rerankApiKey');
    bindText(t('rerank-model'), 'rerankModel');
    bindText(t('search-url'), 'searchUrl');
    bindText(t('search-count'), 'searchCount', v => Number(v));
    bindText(t('tavern-limit'), 'tavernChatLimit', v => Number(v));
    bindText(t('memory-topk'), 'memoryTopK', v => Number(v));

    $(`#${t('open-chat')}`).on('click', openChatWindow);
    $(`#${t('auto-search')}`).on('change', function () { S.autoSearch = $(this).prop('checked'); saveSettingsDebounced(); });
    $(`#${t('include-tavern')}`).on('change', function () { S.includeTavernChat = $(this).prop('checked'); saveSettingsDebounced(); });
    $(`#${t('search-engine')}`).on('change', function () { S.searchEngine = $(this).val(); saveSettingsDebounced(); });
    $(`#${t('memory-enabled')}`).on('change', function () { S.memoryEnabled = $(this).prop('checked'); saveSettingsDebounced(); });
    $(`#${t('memory-rerank')}`).on('change', function () { S.memoryRerank = $(this).prop('checked'); saveSettingsDebounced(); });

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
    $(`#${t('model-select')}`).on('change', function () {
        S.selectedModel = $(this).val(); saveSettingsDebounced();
        status(`已选择模型：${S.selectedModel}`);
    });

    $(`#${t('build-index')}`).on('click', async () => {
        try {
            status('正在重建向量索引...', 'warn');
            await retrieveMemory('全文索引', true);
            const ctx = getContext();
            const n = (S.vectors[ctx.chatId] || []).filter(Boolean).length;
            status(`索引重建完成 ✓ 共 ${n} 条（含隐藏消息）`);
        } catch (e) { status(e.message, 'err'); }
    });

    $(`#${t('view-chat')}`).on('click', openChatViewer);
    $(`#${t('export-txt')}`).on('click', () => {
        const blob = new Blob([getFullChat().map(m => `${m.name}${m.hidden ? ' [隐藏]' : ''}: ${m.text}`).join('\n\n')],
            { type: 'text/plain;charset=utf-8' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `${getContext().chatId || 'chat'}-完整记录.txt`;
        a.click();
        status('已导出 TXT');
    });

    // ---- 回填 ----
    $(`#${t('auto-search')}`).prop('checked', S.autoSearch);
    $(`#${t('include-tavern')}`).prop('checked', S.includeTavernChat);
    $(`#${t('tavern-limit')}`).val(S.tavernChatLimit);
    $(`#${t('system-prompt')}`).val(S.systemPrompt);
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

// ==================== 初始化 ====================
jQuery(async () => {
    buildUI();
    LOG('v1.2.0 加载完成 ✓');
});
