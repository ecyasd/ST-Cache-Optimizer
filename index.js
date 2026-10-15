// 缓存优化 (Cache Optimizer) v2
//
// Gemini / Vertex 的隐式缓存（以及大多数按前缀计费的缓存）要求：
//   - 开头的系统提示（第一条对话消息之前的所有 system 消息）每轮一字不差；
//   - 之后的内容按前缀命中，每轮最好只在末尾追加。
// 本扩展在不改任何文件的前提下，对任意预设 / 世界书生效：
//   1. 世界书现场调整（WORLDINFO_ENTRIES_LOADED，只改本次扫描的临时副本）：
//      - 「角色定义前/后」的关键词条目、会变的常驻条目（MVU 变量、随机宏、概率触发）→ 聊天中深度 0，
//        外面用 <当前剧情相关设定> 包住；
//      - 按深度 / 作者注释插入、内容固定的常驻条目 → 角色定义前（进入固定的系统提示）。
//   2. 发送前重排（CHAT_COMPLETION_PROMPT_READY）：聊天记录中间的 system 块、系统提示里的易变块
//      → 聊天记录末尾（「</聊天记录>」标记之前，没有标记则放在最新一条用户消息之前）。
//   3. 自动学习：系统提示里两轮之间变化过的块记下开头特征，以后自动挪到聊天记录之后。
//   4. 免费检查：只组装不发送，比较「上一轮」和「这一轮」的提示词，报告能命中缓存的比例。

const MODULE = 'cacheOptimizer';
const DEFAULTS = Object.freeze({
    enabled: true,
    routeWorldInfo: true,
    hoistStatic: true,
    learn: true,
    volatileHeads: ['〔记忆系统私密简报'],
    learnedHeads: [],
    keepPatterns: 'output_format|Force_Structured|^<\\/?Format>|jailbreak|破限',
});
const WRAP_OPEN = '<当前剧情相关设定>';
const WRAP_CLOSE = '</当前剧情相关设定>';
const WRAP_WORLD = '__cache_optimizer__';
const STATIC_OPEN = '<固定设定>';
const STATIC_CLOSE = '</固定设定>';
// 比任何聊天记录都深：插在聊天记录最顶端
const TOP_DEPTH = 99999;
const POS = { before: 0, after: 1, anTop: 2, anBottom: 3, atDepth: 4, emTop: 5, emBottom: 6, outlet: 7 };
const ROLE_SYSTEM = 0;
const HOIST_ORDER_BASE = 100000;
const MAX_LEARNED = 30;
// 常驻条目里出现这些就视为每轮可能变化。读固定配置的 {{getvar::xx}} 不算：它们开局设定后基本不变；
// 真正每轮变的是 MVU 等消息级变量（stat_data / getMessageVar）、随机、时间、最新消息。
const DYNAMIC_EJS = /stat_data|getMessageVar|getvar\(\s*['"`]stat_data|random|Math\.|Date|roll|_\.(sample|shuffle)|lastUserMessage|lastCharMessage|chat\[|incvar|addvar/;
const DYNAMIC_MACRO = /\{\{(roll|random|pick|time|date|weekday|isotime|isodate|datetimeformat|idle_duration|lastMessage|lastUserMessage|lastCharMessage|lastMessageId)/i;
// MVU 变量块是「标签后紧跟模板代码」；正文里只是提到标签名的规则条目不算
const DYNAMIC_TAG = /<status_current_variables>\s*(<%|\{\{)/i;

let lastRun = '尚未发送过请求';
let lastSystemBlocks = null;

function ctx() {
    return SillyTavern.getContext();
}

function settings() {
    const all = ctx().extensionSettings;
    all[MODULE] ??= structuredClone(DEFAULTS);
    for (const [key, value] of Object.entries(DEFAULTS)) {
        all[MODULE][key] ??= structuredClone(value);
    }
    return all[MODULE];
}

function save() {
    ctx().saveSettingsDebounced();
}

function text(message) {
    return typeof message?.content === 'string' ? message.content : '';
}

function keepRegex() {
    try {
        return new RegExp(settings().keepPatterns, 'im');
    } catch {
        return new RegExp(DEFAULTS.keepPatterns, 'im');
    }
}

// ───────────────────────── 1. 世界书现场调整 ─────────────────────────

function isDynamicEntry(entry) {
    const content = String(entry.content ?? '');
    const ejs = content.match(/<%[\s\S]*?%>/g) ?? [];
    if (ejs.some(block => DYNAMIC_EJS.test(block))) return true;
    if (DYNAMIC_MACRO.test(content) || DYNAMIC_TAG.test(content)) return true;
    // 概率触发、粘性/冷却/延迟都会让条目时有时无
    if (entry.useProbability && Number(entry.probability ?? 100) < 100) return true;
    if (Number(entry.sticky) > 0 || Number(entry.cooldown) > 0 || Number(entry.delay) > 0) return true;
    return false;
}

/** 预设里某个模块（如 worldInfoBefore）是否排在聊天记录之前；找不到时按常见结构（之前）处理 */
function presetSlotBeforeHistory(identifier) {
    const orders = ctx().chatCompletionSettings?.prompt_order ?? [];
    const order = (orders.find(o => o.character_id === 100001) ?? orders[0])?.order ?? [];
    const index = id => order.findIndex(e => e.identifier === id && e.enabled !== false);
    const slot = index(identifier), history = index('chatHistory');
    if (slot < 0 || history < 0) return true;
    return slot < history;
}

function routeEntries(lists) {
    const s = settings();
    if (!s.enabled || !s.routeWorldInfo) return;
    const keep = keepRegex();
    // 有的预设把世界书位置排在聊天记录之后：那里的内容每轮都排在新消息后面，永远命中不了。
    // 这时固定设定改插到聊天记录最顶端（深度 TOP_DEPTH），不管预设怎么排都在聊天记录之前。
    const beforeSlotOk = presetSlotBeforeHistory('worldInfoBefore');
    const afterSlotOk = presetSlotBeforeHistory('worldInfoAfter');
    let moved = 0, template = null, target = null;
    let topMoved = 0, topTemplate = null, topTarget = null;
    const toTop = (e, list, order) => {
        Object.assign(e, { position: POS.atDepth, depth: TOP_DEPTH, role: ROLE_SYSTEM, order });
        topMoved++;
        topTemplate ??= e;
        topTarget ??= list;
    };

    for (const list of lists) {
        if (!Array.isArray(list)) continue;
        for (const e of list) {
            if (!e || e.disable || e.world === WRAP_WORLD) continue;
            // 只看条目名和正文第一行，避免正文里随口提到的词误判
            const firstLine = String(e.content ?? '').trimStart().split('\n', 1)[0];
            if (keep.test(String(e.comment ?? '')) || keep.test(firstLine)) continue;
            const pos = Number(e.position);
            if (pos === POS.before || pos === POS.after) {
                // 关键词条目时有时无、动态常驻条目每轮都变：都不能留在系统提示里
                if (!e.constant || isDynamicEntry(e)) {
                    Object.assign(e, { position: POS.atDepth, depth: 0, role: ROLE_SYSTEM });
                    moved++;
                    template ??= e;
                    target ??= list;
                } else if (pos === POS.before ? !beforeSlotOk : !afterSlotOk) {
                    toTop(e, list, (pos === POS.after ? 50000 : 0) + (Number(e.order) || 0));
                }
            } else if (pos === POS.atDepth && (!e.constant || isDynamicEntry(e))) {
                // 会变的深度条目统一放到深度 0：深度设得比聊天记录还大时它会落进系统提示，
                // 放在中间也会随楼层后移改写前缀；深度 0 之后由发送前重排挪到聊天记录末尾
                if (Number(e.depth) !== 0) {
                    e.depth = 0;
                    moved++;
                }
            } else if (s.hoistStatic && e.constant && !isDynamicEntry(e)
                && (pos === POS.atDepth || pos === POS.anTop || pos === POS.anBottom)) {
                // 固定规则前移到聊天记录之前；按原深度从深到浅、再按 order 排，保持原先的相对顺序
                const depth = pos === POS.atDepth ? Number(e.depth) || 0 : 0;
                const order = HOIST_ORDER_BASE + (100 - Math.min(depth, 99)) * 1000 + (Number(e.order) || 0);
                if (beforeSlotOk) Object.assign(e, { position: POS.before, order });
                else toTop(e, list, order);
            }
        }
    }

    const wrap = (from, uid, content, order, depth) => ({
        ...from, uid, world: WRAP_WORLD, comment: content, content, order,
        key: [], keysecondary: [], constant: true, disable: false, selective: false,
        useProbability: false, probability: 100, group: '', groupOverride: false,
        sticky: 0, cooldown: 0, delay: 0, position: POS.atDepth, depth, role: ROLE_SYSTEM,
        excludeRecursion: true, preventRecursion: true,
    });
    if (moved && template && target) {
        target.push(wrap(template, -910001, WRAP_OPEN, -1000000, 0), wrap(template, -910002, WRAP_CLOSE, 1000000, 0));
    }
    if (topMoved && topTemplate && topTarget) {
        topTarget.push(wrap(topTemplate, -910003, STATIC_OPEN, -1000000, TOP_DEPTH), wrap(topTemplate, -910004, STATIC_CLOSE, 1000000, TOP_DEPTH));
    }
}

// ───────────────────────── 2. 发送前重排 + 3. 自动学习 ─────────────────────────

function headOf(message) {
    return text(message).trimStart().split('\n', 1)[0].slice(0, 40);
}

function isVolatileHead(head) {
    const { volatileHeads, learnedHeads } = settings();
    return [...volatileHeads, ...learnedHeads].some(h => h && head.startsWith(h));
}

function normalize(value) {
    return String(value ?? '').replace(/\s+/g, ' ').trim();
}

/** 最近的真实聊天消息各取几段文字，用来在提示词里认出哪些是聊天记录 */
function historySnippets() {
    return (ctx().chat ?? [])
        .filter(m => m && !m.is_system && typeof m.mes === 'string' && m.mes.trim())
        .slice(-60)
        .map(m => {
            const t = normalize(m.mes);
            if (t.length <= 60) return [t];
            // 取中段：开头常是思维链、结尾常是变量块，都可能被正则删掉
            return [0.3, 0.5, 0.7].map(p => t.slice(Math.floor(t.length * p), Math.floor(t.length * p) + 30));
        });
}

/**
 * 找出提示词里真正的聊天记录范围。很多预设在聊天记录前放伪造的 user/assistant 对话、规则和资料，
 * 不能把「第一条非 system 消息」当成聊天记录的开头，所以拿真实聊天消息逐条比对。
 */
function findHistoryRange(chat) {
    const snippets = historySnippets();
    if (!snippets.length) return null;
    let start = -1, end = -1;
    chat.forEach((m, i) => {
        if (m.role === 'system') return;
        const t = normalize(text(m));
        if (t && snippets.some(list => list.some(s => s && t.includes(s)))) {
            if (start < 0) start = i;
            end = i;
        }
    });
    return start < 0 ? null : { start, end };
}

function reorder(chat) {
    const range = findHistoryRange(chat);
    const firstTurn = chat.findIndex(m => m.role !== 'system');
    // 认不出聊天记录时退回旧规则：第一条非 system 消息到最后一条用户消息之间
    const start = range ? range.start : firstTurn;
    const end = range ? range.end : chat.findLastIndex(m => m.role === 'user');
    if (start < 0 || end < 0) return 0;
    const anchor = chat[end];

    const moved = [];
    // 聊天记录中间插入的 system 块：每多一轮位置就后移，会改写上一轮的前缀
    for (let i = end - 1; i > start; i--) {
        // 插在聊天记录最顶端的固定设定块就是要留在前面的
        if (chat[i].role === 'system' && !text(chat[i]).trimStart().startsWith(STATIC_OPEN)) moved.unshift(...chat.splice(i, 1));
    }
    // 聊天记录之前的易变块（柏宝书历史摘要、学到的易变块、现场调整出来的动态世界书块）
    for (let i = start - 1; i >= 0; i--) {
        const t = text(chat[i]).trimStart();
        if (chat[i].role === 'system' && (isVolatileHead(headOf(chat[i])) || t.startsWith(WRAP_OPEN))) moved.unshift(...chat.splice(i, 1));
    }
    if (!moved.length) return 0;

    const at = chat.indexOf(anchor);
    // 认出了聊天记录：放在它之后；否则放在最后一条用户消息之前
    chat.splice(range ? at + 1 : at, 0, ...moved);
    return moved.length;
}

/** 聊天记录之前的固定区域里，同一开头的块内容变了 → 记为易变，下一轮起挪到聊天记录之后 */
function learnFrom(chat) {
    const s = settings();
    if (!s.learn) return [];
    const range = findHistoryRange(chat);
    const firstTurn = chat.findIndex(m => m.role !== 'system');
    const stop = range ? range.start : (firstTurn < 0 ? chat.length : firstTurn);
    const blocks = chat.slice(0, stop).filter(m => m.role === 'system').map(m => ({ head: headOf(m), body: text(m) }));
    const learned = [];
    if (lastSystemBlocks && lastSystemBlocks.chatId === ctx().getCurrentChatId()) {
        const prev = new Map(lastSystemBlocks.blocks.map(b => [b.head, b.body]));
        for (const b of blocks) {
            if (b.head.length < 4 || !prev.has(b.head) || prev.get(b.head) === b.body || isVolatileHead(b.head)) continue;
            s.learnedHeads.push(b.head);
            learned.push(b.head);
        }
        if (learned.length) {
            s.learnedHeads = s.learnedHeads.slice(-MAX_LEARNED);
            save();
        }
    }
    lastSystemBlocks = { chatId: ctx().getCurrentChatId(), blocks };
    return learned;
}

function onPromptReady(data) {
    if (!settings().enabled || !Array.isArray(data?.chat)) return;
    const n = reorder(data.chat);
    if (data.dryRun) return;
    const learned = learnFrom(data.chat);
    lastRun = `${new Date().toLocaleTimeString()} 发送前重排：移动了 ${n} 个块`
        + (learned.length ? `；新学到易变块 ${learned.length} 个（下一轮生效）` : '');
    $('#cacheopt_last').text(lastRun);
    renderLearned();
}

// ───────────────────────── 4. 免费稳定性检查 ─────────────────────────

async function captureDryRun() {
    const c = ctx();
    let captured = null;
    const handler = data => { captured = structuredClone(data.chat); };
    c.eventSource.on(c.eventTypes.CHAT_COMPLETION_PROMPT_READY, handler);
    try {
        await c.generate('normal', {}, true);
    } finally {
        c.eventSource.removeListener(c.eventTypes.CHAT_COMPLETION_PROMPT_READY, handler);
    }
    return captured;
}

async function checkStability() {
    const c = ctx();
    const report = $('#cacheopt_report');
    if (c.mainApi !== 'openai') return report.text('只支持对话补全（Chat Completion）接口。');
    const lastUser = c.chat.findLastIndex(m => m.is_user);
    if (lastUser < 2) return report.text('聊天记录太短，至少需要两轮对话。');
    report.text('检查中（只组装、不发送，不花钱）…');

    const original = c.chat.length;
    let previous;
    const removed = c.chat.splice(lastUser - 1);
    try {
        previous = await captureDryRun();
    } finally {
        c.chat.push(...removed);
    }
    const current = await captureDryRun();
    if (c.chat.length !== original || !previous || !current) return report.text('检查失败：没能组装出提示词。');

    const flat = list => list.map(m => `[${m.role}]${text(m)}`).join('\n');
    const lead = list => { let k = 0; while (k < list.length && list[k].role === 'system') k++; return k; };
    const a = flat(previous), b = flat(current);
    let i = 0;
    while (i < a.length && a[i] === b[i]) i++;
    let at = 0, acc = 0;
    for (; at < current.length; at++) {
        acc += flat([current[at]]).length + 1;
        if (acc > i) break;
    }
    const sysPrev = previous.slice(0, lead(previous)), sysCur = current.slice(0, lead(current));
    const systemSame = flat(sysPrev) === flat(sysCur);
    const changed = systemSame ? [] : sysCur.filter((m, k) => text(m) !== text(sysPrev[k])).map(headOf);
    report.text([
        `系统提示两轮一致：${systemSame ? '✅ 是' : '❌ 否（Vertex/Gemini 会整轮 0 命中）'}`,
        changed.length ? `系统提示里变化的块：${changed.slice(0, 5).join(' / ')}` : '',
        `两轮相同的前缀：${(i / b.length * 100).toFixed(1)}%（约 ${i.toLocaleString()} / ${b.length.toLocaleString()} 字）`,
        `第一次不同出现在第 ${at + 1} 条消息（${current[at]?.role}）：`,
        text(current[at]).slice(0, 80).replace(/\s+/g, ' '),
        '注：模拟不包含记忆扩展「折叠旧楼」这类每轮真实发生的变化。',
        settings().enabled ? '' : '（当前未启用，开启后再检查一次可对比效果）',
    ].filter(Boolean).join('\n'));
}

// ───────────────────────── 界面 ─────────────────────────

function setEnabled(value) {
    settings().enabled = value;
    save();
    $('#cacheopt_enabled').prop('checked', value);
    $('#cacheopt_menu_label').text(`缓存优化：${value ? '开' : '关'}`);
    $('#cacheopt_menu .extensionsMenuExtensionButton').css('opacity', value ? '' : '0.4');
}

function renderLearned() {
    const list = settings().learnedHeads;
    $('#cacheopt_learned').text(list.length ? `已学到的易变块（${list.length}）：${list.join(' / ')}` : '已学到的易变块：暂无');
}

function bindCheckbox(id, key) {
    $(id).prop('checked', !!settings()[key]).on('input', function () {
        settings()[key] = !!$(this).prop('checked');
        save();
    });
}

function renderSettings() {
    const html = `
    <div class="cacheopt-settings">
      <div class="inline-drawer">
        <div class="inline-drawer-toggle inline-drawer-header">
          <b>⚡ 缓存优化</b>
          <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
        </div>
        <div class="inline-drawer-content">
          <label class="checkbox_label"><input id="cacheopt_enabled" type="checkbox"> 启用缓存优化</label>
          <label class="checkbox_label"><input id="cacheopt_route" type="checkbox"> 世界书现场调整：关键词 / 会变的条目移到聊天中（不改文件）</label>
          <label class="checkbox_label"><input id="cacheopt_hoist" type="checkbox"> 固定规则条目前移进系统提示</label>
          <label class="checkbox_label"><input id="cacheopt_learn" type="checkbox"> 自动学习系统提示里的易变块</label>
          <label class="cacheopt-label">保持原位的条目（正则，匹配条目名或内容开头）
            <input id="cacheopt_keep" class="text_pole" type="text">
          </label>
          <div class="cacheopt-row">
            <div id="cacheopt_check" class="menu_button">检查缓存稳定性（免费）</div>
            <div id="cacheopt_forget" class="menu_button">清空已学到的易变块</div>
          </div>
          <div id="cacheopt_learned" class="cacheopt-hint"></div>
          <div id="cacheopt_last" class="cacheopt-hint"></div>
          <div id="cacheopt_report" class="cacheopt-report">点「检查缓存稳定性」查看两轮之间能命中缓存的比例。</div>
        </div>
      </div>
    </div>`;
    $('#extensions_settings2').append(html);
    $('#cacheopt_enabled').prop('checked', settings().enabled).on('input', function () { setEnabled(!!$(this).prop('checked')); });
    bindCheckbox('#cacheopt_route', 'routeWorldInfo');
    bindCheckbox('#cacheopt_hoist', 'hoistStatic');
    bindCheckbox('#cacheopt_learn', 'learn');
    $('#cacheopt_keep').val(settings().keepPatterns).on('change', function () {
        settings().keepPatterns = String($(this).val());
        save();
    });
    $('#cacheopt_check').on('click', () => checkStability().catch(e => $('#cacheopt_report').text(`检查失败：${e?.message || e}`)));
    $('#cacheopt_forget').on('click', () => {
        settings().learnedHeads = [];
        save();
        renderLearned();
    });
    $('#cacheopt_last').text(lastRun);
    renderLearned();

    // 魔法棒菜单（左下角）一键开关，结构与酒馆自带的菜单项一致
    const item = $(`<div id="cacheopt_wand_container" class="extension_container interactable" tabindex="0">
        <div id="cacheopt_menu" class="list-group-item flex-container flexGap5 interactable" tabindex="0" role="listitem" title="一键开关缓存优化">
          <div class="fa-solid fa-bolt extensionsMenuExtensionButton"></div><span id="cacheopt_menu_label"></span></div></div>`);
    item.on('click', () => {
        setEnabled(!settings().enabled);
        toastr.info(`缓存优化已${settings().enabled ? '开启' : '关闭'}`, '缓存优化');
    });
    $('#extensionsMenu').append(item);
    setEnabled(settings().enabled);
}

jQuery(() => {
    settings();
    renderSettings();
    const c = ctx();
    c.eventSource.on(c.eventTypes.WORLDINFO_ENTRIES_LOADED, data => {
        routeEntries([data?.globalLore, data?.characterLore, data?.chatLore, data?.personaLore]);
    });
    c.eventSource.on(c.eventTypes.CHAT_COMPLETION_PROMPT_READY, onPromptReady);
});
