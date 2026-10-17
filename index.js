// 缓存优化 v2.5：按来源路由数据库召回，在 SETTINGS_READY 再处理最终消息。
// 仅修改本轮扫描/请求副本；请求相似度和服务端缓存 token 分开报告。
// 相同前缀能提高隐式缓存机会，但实际命中以 API 响应为准。

const MODULE = 'cacheOptimizer';
const DEFAULTS = Object.freeze({
    enabled: true,
    routeWorldInfo: true,
    hoistStatic: true,
    learn: true,
    stickyLore: false,
    stickyTurns: 6,
    compatShujuku: true,
    compatIzumi: false,
    compatGeminiProxy: false,
    volatileHeads: ['〔记忆系统私密简报'],
    learnedHeads: [],
    keepPatterns: 'output_format|Force_Structured|^<\\/?Format>|jailbreak|破限',
});
const WRAP_OPEN = '<当前剧情相关设定>';
const WRAP_CLOSE = '</当前剧情相关设定>';
const WRAP_WORLD = '__cache_optimizer__';
const STATIC_OPEN = '<固定设定>';
const STATIC_CLOSE = '</固定设定>';
const STICKY_OPEN = '<近期剧情设定>';
const STICKY_CLOSE = '</近期剧情设定>';
const STICKY_ORDER_BASE = 2000000;
const FIXED_SYSTEM_PLACEHOLDER = '【固定规则已置于系统指令】';
// 比任何聊天记录都深：插在聊天记录最顶端
// 酒馆只注入深度 0~10000（MAX_INJECTION_DEPTH），再大会被静默丢掉
const TOP_DEPTH = 10000;
const POS = { before: 0, after: 1, anTop: 2, anBottom: 3, atDepth: 4, emTop: 5, emBottom: 6, outlet: 7 };
const ROLE_SYSTEM = 0;
const HOIST_ORDER_BASE = 100000;
const MAX_LEARNED = 30;
const MAX_LEARN_CHARS = 20000;
const changeCounts = new Map();
// constant 只代表常驻激活，不代表条目正文不会被其他扩展更新。
// 常驻条目里出现这些就视为每轮可能变化。读固定配置的 {{getvar::xx}} 不算：它们开局设定后基本不变；
// 真正每轮变的是 MVU 等消息级变量（stat_data / getMessageVar）、随机、时间、最新消息。
const DYNAMIC_EJS = /stat_data|getMessageVar|getvar\(\s*['"`]stat_data|random|Math\.|Date|roll|_\.(sample|shuffle)|lastUserMessage|lastCharMessage|chat\[|incvar|addvar/;
const DYNAMIC_MACRO = /\{\{(roll|random|pick|time|date|weekday|isotime|isodate|datetimeformat|idle_duration|lastMessage|lastUserMessage|lastCharMessage|lastMessageId)/i;
// MVU 变量块是「标签后紧跟模板代码」；正文里只是提到标签名的规则条目不算
const DYNAMIC_TAG = /<status_current_variables>\s*(<%|\{\{)/i;
const SHUJUKU_TEMPLATE = /\{\[\s*(?:db|sql)\b|\$(?:random|calc|max|min)\b|<(?:random|calc|max|min|if)\b/i;
const IZUMI_MEMORY = /<!--\s*IZM7_[\w-]+\s*-->\s*<KonataExtraInformation>[\s\S]*?<\/KonataExtraInformation>/g;

function isShujukuEntry(entry) {
    if (!settings().compatShujuku) return false;
    const raw = String(entry.comment ?? entry.name ?? '');
    const marker = raw.match(/<!--\s*ACU_CUSTOM_TABLE_EXPORT_V1\s+({[\s\S]*?})\s*-->/);
    if (marker) {
        try {
            const m = JSON.parse(marker[1]);
            if (m.version === 1 && m.kind === 'custom_table_export'
                && ['main', 'row', 'header', 'wrapper_before', 'wrapper_after', 'index'].includes(m.role)
                && ['sheetKey', 'tableName', 'entryName'].every(k => typeof m[k] === 'string' && m[k].trim())) return true;
        } catch { /* 不凭损坏的元数据认定来源 */ }
    }
    const name = raw.trim().replace(/^ACU-\[[^\]]+\]-/, '');
    if (name.startsWith('外部导入-') || name.startsWith('TavernDB-ACU-AgentGreenlight')) return false;
    return /^(?:TavernDB-ACU-|重要人物条目|总结条目|小总结条目)/.test(name);
}

function isIzumiMemory(content) {
    return settings().compatIzumi && new RegExp(IZUMI_MEMORY.source).test(content);
}

let lastRun = '尚未发送过请求';
let lastSystemBlocks = null;
let nativeOpenAIModule = null;
let processedHistorySnapshot = null;

async function loadNativePromptManager() {
    try {
        // Read the host's finished messages; never run the user's regex or macros again.
        // Keep the namespace: ST replaces this exported live binding after API changes.
        nativeOpenAIModule = await import('/scripts/openai.js');
    } catch { /* Older hosts keep the conservative raw-chat fallback. */ }
}

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

/** 正文本身每轮可能不同（变量、随机、时间、概率触发）；与触发时机无关 */
function isDynamicContent(entry) {
    const content = String(entry.content ?? '');
    if (isShujukuEntry(entry) || isIzumiMemory(content)) return true;
    if (settings().compatShujuku && SHUJUKU_TEMPLATE.test(content)) return true;
    const ejs = content.match(/<%[\s\S]*?%>/g) ?? [];
    if (ejs.some(block => DYNAMIC_EJS.test(block))) return true;
    if (DYNAMIC_MACRO.test(content) || DYNAMIC_TAG.test(content)) return true;
    return !!entry.useProbability && Number(entry.probability ?? 100) < 100;
}

function isDynamicEntry(entry) {
    if (isDynamicContent(entry)) return true;
    // 粘性/冷却/延迟会让条目时有时无
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

/**
 * 聊天记录前的 system 块会不会被并进同一条消息。Gemini / Vertex 会把非开头的 system 块转成 user 并与相邻消息合并，
 * 提示词后处理也会合并。这里保守禁用 stickyLore，避免把可变召回放回较早位置；
 * 不能由消息是否合并推断服务端实际缓存边界。
 */
function systemBlocksGetMerged() {
    const cc = ctx().chatCompletionSettings ?? {};
    if (['makersuite', 'vertexai'].includes(cc.chat_completion_source)) return true;
    return !!cc.custom_prompt_post_processing;
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
    let stickyMoved = 0, stickyTemplate = null, stickyTarget = null;
    const stickyTurns = Math.max(0, Math.floor(Number(s.stickyTurns) || 0));
    const stickyOn = s.stickyLore && !systemBlocksGetMerged();
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
            const ownedDynamic = isShujukuEntry(e) || isIzumiMemory(String(e.content ?? ''));
            if (!ownedDynamic && (keep.test(String(e.comment ?? '')) || keep.test(firstLine))) continue;
            const pos = Number(e.position);
            if (pos === POS.before || pos === POS.after) {
                // 关键词条目时有时无、动态常驻条目每轮都变：都不能留在系统提示里
                if (stickyOn && !e.constant && !isDynamicContent(e)) {
                    // 关键词条目放回聊天记录之前（与固定设定同一条消息，排在其后），并粘住几轮：
                    // 场景不变时这块几轮不变，连同后面的聊天记录都能命中缓存
                    Object.assign(e, {
                        position: POS.atDepth, depth: TOP_DEPTH, role: ROLE_SYSTEM,
                        order: STICKY_ORDER_BASE + (pos === POS.after ? 50000 : 0) + (Number(e.order) || 0),
                        sticky: Math.max(Number(e.sticky) || 0, stickyTurns),
                    });
                    stickyMoved++;
                    stickyTemplate ??= e;
                    stickyTarget ??= list;
                } else if (!e.constant || isDynamicEntry(e)) {
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
    if (stickyMoved && stickyTemplate && stickyTarget) {
        stickyTarget.push(
            wrap(stickyTemplate, -910005, STICKY_OPEN, STICKY_ORDER_BASE - 500000, TOP_DEPTH),
            wrap(stickyTemplate, -910006, STICKY_CLOSE, STICKY_ORDER_BASE + 1000000, TOP_DEPTH),
        );
    }
}

// ───────────────────────── 2. 发送前重排 + 3. 自动学习 ─────────────────────────

function headOf(message) {
    return text(message).trimStart().split('\n', 1)[0].slice(0, 40);
}

/** 插在聊天记录最顶端、要留在前面的块（固定设定 / 近期剧情设定） */
function isTopBlock(message) {
    const t = text(message).trimStart();
    return t.startsWith(STATIC_OPEN) || t.startsWith(STICKY_OPEN);
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
            if (t.length <= 60) return { role: m.is_user ? 'user' : 'assistant', exact: t, snippets: [] };
            // 取中段：开头常是思维链、结尾常是变量块，都可能被正则删掉
            return { role: m.is_user ? 'user' : 'assistant', exact: t,
                snippets: [0.3, 0.5, 0.7].map(p => t.slice(Math.floor(t.length * p), Math.floor(t.length * p) + 30)) };
        });
}

function currentProcessedHistory() {
    if (processedHistorySnapshot?.chatId !== ctx().getCurrentChatId()) processedHistorySnapshot = null;
    return processedHistorySnapshot;
}

function processedHistoryText(message) {
    const t = normalize(text(message)), c = ctx();
    const names = [message.role === 'user' ? c.name1 : c.name2,
        ...(c.chat ?? []).filter(raw => raw && (raw.is_user ? 'user' : 'assistant') === message.role).map(raw => raw.name)]
        .filter(name => typeof name === 'string' && name.trim() && name.length <= 80 && !/[\r\n]/.test(name));
    for (const name of names) {
        const prefix = `${normalize(name)}: `;
        if (t.startsWith(prefix)) return t.slice(prefix.length);
    }
    return t;
}

/** Numeric chatHistory identifiers also include depth injections in ST.
 * Only complete equality with a same-role real message proves this additional path.
 * Partial raw substrings are still ambiguous: depth injections can quote real chat.
 */
function hasRawHistoryWitness(message) {
    const t = processedHistoryText(message);
    if (!t) return false;
    return (ctx().chat ?? []).some(raw => {
        if (!raw || raw.is_system || typeof raw.mes !== 'string'
            || (raw.is_user ? 'user' : 'assistant') !== message.role) return false;
        const source = normalize(raw.mes);
        return source === t;
    });
}

function captureProcessedHistory(manager, chat) {
    processedHistorySnapshot = null;
    if (!Array.isArray(chat)) return;
    try {
        const collections = manager?.messages?.getCollection?.();
        const history = collections?.find(collection => collection?.identifier === 'chatHistory');
        const messages = history?.getCollection?.();
        if (!Array.isArray(messages)) return;
        const entries = messages.filter(message => /^chatHistory-\d+$/.test(message?.identifier)
            && ['user', 'assistant'].includes(message.role) && typeof message.content === 'string'
            && hasRawHistoryWitness(message)
            && chat.some(candidate => candidate.role === message.role && normalize(text(candidate)) === normalize(message.content)))
            .map(message => ({ role: message.role, content: message.content }));
        if (entries.length) processedHistorySnapshot = { chatId: ctx().getCurrentChatId(), entries };
    } catch { /* Unrecognized host collection shapes are not guessed. */ }
}

function matchesHistoryText(message, item) {
    if (message.role !== item.role) return false;
    const t = processedHistoryText(message), expected = processedHistoryText(item);
    if (!t || !expected) return false;
    // Late rebuilding must retain the complete processed message. Quoted anchors
    // in a worldbook injection do not make that injection a history message.
    return t === expected;
}

/**
 * 找出提示词里真正的聊天记录范围。很多预设在聊天记录前放伪造的 user/assistant 对话、规则和资料，
 * 不能把「第一条非 system 消息」当成聊天记录的开头，所以拿真实聊天消息逐条比对。
 */
function findRawHistoryRange(chat) {
    const snippets = historySnippets();
    if (!snippets.length) return null;
    let start = -1, end = -1;
    chat.forEach((m, i) => {
        if (m.role === 'system') return;
        const t = normalize(text(m));
        if (t && snippets.some(item => item.role === m.role && (t === item.exact
            || (item.exact.length > 8 && t.endsWith(`: ${item.exact}`))
            || item.snippets.some(s => s && t.includes(s))))) {
            if (start < 0) start = i;
            end = i;
        }
    });
    return start < 0 ? null : { start, end };
}

function findHistoryRange(chat) {
    const snapshot = currentProcessedHistory();
    // Do not let an exact-only snapshot of the latest user shrink an already
    // confirmed real assistant boundary and promote intervening runtime systems.
    const legacy = findRawHistoryRange(chat);
    if (legacy) return legacy;
    if (!snapshot) return null;
    const matches = snapshot.entries.flatMap(item => {
        const matching = chat.map((message, i) => matchesHistoryText(message, item) ? i : -1).filter(i => i >= 0);
        return matching.length === 1 ? [{ at: matching[0], role: item.role }] : [];
    });
    if (!['assistant', 'user'].every(role => matches.some(item => item.role === role))) return null;
    const positions = matches.map(item => item.at);
    return { start: Math.min(...positions), end: Math.max(...positions) };
}

function reorder(chat) {
    const range = findHistoryRange(chat);
    // 预设伪对话与数据库辅助请求也有 user/assistant；无法确认真实历史时不猜。
    if (!range) return 0;
    const { start, end } = range;
    if (start < 0 || end < 0) return 0;
    const anchor = chat[end];

    const moved = [];
    // 聊天记录中间插入的 system 块：每多一轮位置就后移，会改写上一轮的前缀
    for (let i = end - 1; i > start; i--) {
        // 插在聊天记录最顶端的固定设定块就是要留在前面的
        if (chat[i].role === 'system' && !isTopBlock(chat[i])) moved.unshift(...chat.splice(i, 1));
    }
    // 聊天记录之前的易变块（柏宝书历史摘要、学到的易变块、现场调整出来的动态世界书块）
    for (let i = start - 1; i >= 0; i--) {
        const t = text(chat[i]).trimStart();
        if (chat[i].role === 'system' && !isTopBlock(chat[i])
            && (chat[i].__cacheoptDynamic
                || (isVolatileHead(headOf(chat[i])) && t.length <= MAX_LEARN_CHARS) || t.startsWith(WRAP_OPEN))) moved.unshift(...chat.splice(i, 1));
    }
    if (!moved.length) return 0;

    const at = chat.indexOf(anchor);
    // 认出了聊天记录：放在它之后；否则放在最后一条用户消息之前
    chat.splice(range ? at + 1 : at, 0, ...moved);
    return moved.length;
}

/** 只拆来源明确、成对完整的 system 包裹；绝不按用户正文或单个变量值猜测来源。 */
function splitKnownDynamicBlocks(chat) {
    const range = findHistoryRange(chat);
    if (!range) return;
    for (let i = range.end - 1; i >= 0; i--) {
        const message = chat[i];
        if (message.role !== 'system' || typeof message.content !== 'string' || isTopBlock(message)) continue;
        const patterns = [];
        if (settings().compatIzumi) patterns.push(IZUMI_MEMORY.source);
        if (settings().compatShujuku) {
            for (const tag of ['最新数据与记录', '过往记忆', '剧情大纲编码索引']) {
                // 标签必须各自独占一行且唯一，避免正文里提到标签时误拆。
                const opens = message.content.split(`<${tag}>`).length - 1;
                const closes = message.content.split(`</${tag}>`).length - 1;
                if (opens === 1 && closes === 1) patterns.push(`^<${tag}>[^\\S\\n]*\\n[\\s\\S]*?^<\/${tag}>[^\\S\\n]*(?=\\n|$)`);
            }
        }
        if (!patterns.length || text(message).trimStart().startsWith(WRAP_OPEN)) continue;
        const matches = [...message.content.matchAll(new RegExp(patterns.join('|'), 'gm'))];
        if (!matches.length) continue;
        const pieces = [];
        let at = 0;
        for (const match of matches) {
            const before = message.content.slice(at, match.index);
            if (before) pieces.push({ ...message, content: before });
            pieces.push({ ...message, content: match[0], __cacheoptDynamic: true });
            at = match.index + match[0].length;
        }
        const after = message.content.slice(at);
        if (after) pieces.push({ ...message, content: after });
        // 不向模型发送内部识别字段；用非枚举属性保留本轮来源。
        for (const piece of pieces) if (piece.__cacheoptDynamic) {
            Object.defineProperty(piece, '__cacheoptDynamic', { value: true, enumerable: false });
        }
        chat.splice(i, 1, ...pieces);
    }
}

/** 聊天记录之前的固定区域里，同一开头的块内容变了 → 记为易变，下一轮起挪到聊天记录之后 */
function learnFrom(chat) {
    const s = settings();
    if (!s.learn) return [];
    const range = findHistoryRange(chat);
    const firstTurn = chat.findIndex(m => m.role !== 'system');
    const stop = range ? range.start : (firstTurn < 0 ? chat.length : firstTurn);
    // 顶端设定块随场景变化是预期内的，不能学成易变块挪走
    const blocks = chat.slice(0, stop).filter(m => m.role === 'system' && !isTopBlock(m)).map(m => ({ head: headOf(m), body: text(m) }));
    const learned = [];
    if (lastSystemBlocks && lastSystemBlocks.chatId === ctx().getCurrentChatId()) {
        const prev = new Map(lastSystemBlocks.blocks.map(b => [b.head, b.body]));
        for (const b of blocks) {
            if (b.head.length < 4 || !prev.has(b.head) || prev.get(b.head) === b.body || isVolatileHead(b.head)) continue;
            // 大块（整本世界书之类）挪到聊天记录之后，每轮整块按原价算，比偶尔变一次贵得多
            if (b.body.length > MAX_LEARN_CHARS) continue;
            // 偶发一次变化（改设置、换预设、脚本改了一次变量）不算，第二次变才学
            const seen = (changeCounts.get(b.head) ?? 0) + 1;
            changeCounts.set(b.head, seen);
            if (seen < 2) continue;
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
    armFinalHook();
    captureProcessedHistory(nativeOpenAIModule?.promptManager, data?.chat);
    if (!settings().enabled || !Array.isArray(data?.chat)) return;
    splitKnownDynamicBlocks(data.chat);
    const n = reorder(data.chat);
    if (data.dryRun) return;
    lastRun = `${new Date().toLocaleTimeString()} 发送前重排：移动了 ${n} 个块`
        + '（等待数据库及预设的最终处理）';
    $('#cacheopt_last').text(lastRun);
    renderLearned();
}

function onSettingsReady(data) {
    if (!settings().enabled || !Array.isArray(data?.messages) || data.type === 'quiet') return;
    if (!findHistoryRange(data.messages)) return;
    splitKnownDynamicBlocks(data.messages);
    const learned = learnFrom(data.messages);
    const n = reorder(data.messages);
    lastRun = `${new Date().toLocaleTimeString()} 最终请求重排：移动了 ${n} 个块`
        + (learned.length ? `；新学到易变块 ${learned.length} 个` : '');
    $('#cacheopt_last').text(lastRun);
    renderLearned();
}

function armFinalHook() {
    const c = ctx();
    const event = c.eventTypes.CHAT_COMPLETION_SETTINGS_READY;
    if (!event) return;
    // 数据库和泉的脚本可能晚于本插件加载；在每次 PROMPT_READY 重新排到队尾。
    c.eventSource.removeListener(event, onSettingsReady);
    if (typeof c.eventSource.makeLast === 'function') c.eventSource.makeLast(event, onSettingsReady);
    else c.eventSource.on(event, onSettingsReady);
}

// ───────────────────────── 4. 测试指引（不改聊天、不请求模型） ─────────────────────────

function checkStability() {
    $('#cacheopt_report').text([
        '连续楼层测试：保持同一角色卡、世界书、预设、正文模型和连接，正常聊天至少 3 轮，每轮输入不同内容，并让数据库照常召回。',
        '切换优化开关后分别观察至少 3 轮；不要将切换后的第一轮作为效果结论。数据库辅助模型请求不与正文请求配对。',
        '“重复请求”只说明重发相同内容；“连续楼层”才对应正常推进。相同字符前缀只是诊断，不是缓存 token 命中率。',
        '实际缓存以 API 返回 cachedContentTokenCount / cached_tokens 为准。没有返回统计时显示“未知”，不能当成 0。',
        'Vertex 建议启用流式输出：部分酒馆版本的非流式响应会丢失 usageMetadata。',
        '此按钮不截短历史、不触发生成，也不会额外消耗 API。',
    ].join('\n'));
}

// ───────────────────────── 5. 真实发送对比 ─────────────────────────
// 模拟检查看不到只在真实生成时才出现的变化（EJS 渲染、扩展在生成时注入、变量被脚本改写等）。
// 这里在网络层旁观每次真实发出的请求（不修改、不额外请求），和同一聊天的上一次对比。

const GENERATE_PATH = '/api/backends/chat-completions/generate';
const RECENT_LIMIT = 8;
const ACU_INTERNAL = Symbol.for('acu.internal-generation-fetch');
// 仅在同聊天、同来源/模型/请求类型内，对比紧邻上次请求，避免重复请求美化连续楼层结果。
let recentReal = [];

/** Complete runtime records produced by this card's scripts, after template rendering.
 * Rules merely mentioning fortune or a current turn are not runtime provenance.
 */
function splitRuntimeSystemRecords(messages) {
    const runtime = /^【本轮江湖介入】启用后第\d+轮；实际玩家回合序号\d+，玩家楼层\d+。[^\n]*同轮续写不新开第二个事件。(?=\n|$)|^<此刻运势>[^\S\n]*\d{1,3}[^\S\n]*<\/此刻运势>[^\S\n]*\n同一回合各项不同行动共用此值。[^\n]*不在正文展示运势。(?=\n|$)/gm;
    let converted = 0;
    const result = messages.flatMap(message => {
        if (message.role !== 'system') return [message];
        const matches = [...message.content.matchAll(runtime)];
        if (!matches.length) return [message];
        const pieces = [];
        let at = 0;
        for (const match of matches) {
            if (match.index > at) pieces.push({ ...message, content: message.content.slice(at, match.index) });
            pieces.push({ role: 'user', content: match[0] });
            converted++;
            at = match.index + match[0].length;
        }
        if (at < message.content.length) pieces.push({ ...message, content: message.content.slice(at) });
        return pieces;
    });
    return { messages: result, converted };
}

/** Opt-in transport compatibility, after auxiliary attribution is available.
 * Text order inside each original message is unchanged; system priority/order does change.
 * This is not an explicit provider cache and does not imply a token hit rate.
 */
function applyGeminiProxyLayout(body) {
    const skip = reason => ({ applied: false, reason });
    if (!settings().enabled || !settings().compatGeminiProxy) return skip('disabled');
    if (body?.type !== 'normal' || body?.[ACU_INTERNAL]) return skip('non-main');
    if (!['custom', 'vertexai', 'makersuite'].includes(body.chat_completion_source)
        || !/gemini/i.test(String(body.model ?? ''))) return skip('connection');
    if (!Array.isArray(body.messages)) return skip('messages');
    if (['tools', 'functions'].some(key => body[key] != null && (!Array.isArray(body[key]) || body[key].length))
        || ['tool_choice', 'function_call', 'response_format', 'json_schema'].some(key => body[key] != null)) return skip('tools-or-schema');
    if (body.messages.some(message => !message || typeof message.content !== 'string'
        || !['system', 'user', 'assistant'].includes(message.role)
        || Object.keys(message).some(key => !['role', 'content'].includes(key)
            && !(key === 'signature' && ['user', 'assistant'].includes(message.role) && typeof message.signature === 'string')))) return skip('message-metadata');
    if (body.messages.some(message => /\bIZ[MW]7_/i.test(message.content))) return skip('memory-authorization');
    const runtime = splitRuntimeSystemRecords(body.messages);
    const messages = runtime.messages;
    const range = findHistoryRange(messages);
    if (!range) return skip('unconfirmed-history');
    const fixed = [], remaining = [];
    let convertedSystems = runtime.converted, fixedPlaceholders = 0;
    for (let i = 0; i < messages.length; i++) {
        const message = messages[i];
        if (message.role !== 'system') { remaining.push(message); continue; }
        if (i < range.start) {
            const t = message.content.trimStart();
            if (isVolatileHead(headOf(message)) || t.startsWith(WRAP_OPEN)
                || isDynamicContent({ content: message.content })
                || /^<(?:最新数据与记录|过往记忆|剧情大纲编码索引|status_current_variables?)>/.test(t)) return skip('dynamic-before-history');
            fixed.push(message);
            if (i > 0) {
                // Keep a real user boundary where native Google would convert this
                // system block. Otherwise adjacent signed model turns can be merged.
                remaining.push({ role: 'user', content: FIXED_SYSTEM_PLACEHOLDER });
                fixedPlaceholders++;
            }
        } else {
            // The normal router first places injections after the last actual history turn.
            // If an unrecognized layout still has interleaved system messages, leave it alone.
            if (i <= range.end) return skip('interleaved-system');
            remaining.push({ ...message, role: 'user' });
            convertedSystems++;
        }
    }
    if (!fixed.length) return skip('no-fixed-system');
    const content = fixed.map(message => message.content).join('\n\n');
    body.messages = [{ role: 'system', content }, ...remaining];
    return { applied: true, mergedSystems: fixed.length, fixedHeadChars: content.length, convertedSystems, fixedPlaceholders };
}

function describeGeminiLayout(report) {
    return report.applied
        ? `Gemini / Vertex 固定头强化：${report.mergedSystems} 条 system 集中为固定头 ${report.fixedHeadChars.toLocaleString()} 字，原位保留 ${report.fixedPlaceholders} 个固定标记，后部 ${report.convertedSystems} 条 system 转为 user（角色和规则顺序已调整；非缓存命中率）`
        : `Gemini / Vertex 固定头强化：本次保守跳过（${report.reason}）`;
}

function requestInitWithBody(init, body) {
    const forwarded = Object.create(null), seen = new Set(['body']);
    // Preserve dictionary members without rebinding class/private-field getters
    // to a child object. Only fetch's actual property reads invoke these getters.
    for (let owner = init; owner; owner = Object.getPrototypeOf(owner)) {
        for (const key of Reflect.ownKeys(owner)) {
            if (seen.has(key)) continue;
            seen.add(key);
            const descriptor = Object.getOwnPropertyDescriptor(owner, key);
            Object.defineProperty(forwarded, key, {
                configurable: true, enumerable: descriptor?.enumerable ?? false,
                get: () => Reflect.get(init, key, init),
            });
        }
    }
    Object.defineProperty(forwarded, 'body', { value: body, enumerable: true, configurable: true, writable: true });
    return forwarded;
}

function messageTexts(body) {
    return (Array.isArray(body.messages) ? body.messages : []).map(m => JSON.stringify(m));
}

function sharedPrefix(a, b) {
    let k = 0;
    while (k < a.length && k < b.length && a[k] === b[k]) k++;
    let at = 0;
    if (k < a.length && k < b.length) while (at < a[k].length && a[k][at] === b[k][at]) at++;
    const chars = a.slice(0, k).reduce((s, t) => s + t.length + 1, 0) + at;
    return { k, at, chars };
}

function describeReal(prev, cur, gapSec) {
    const a = prev.texts, b = cur.texts;
    const { k, at, chars } = sharedPrefix(a, b);
    const total = b.reduce((s, t) => s + t.length + 1, 0) || 1;
    const show = s => s.slice(Math.max(0, at - 40), at + 80).replace(/\s+/g, ' ');
    const toolSchema = body => JSON.stringify({ tools: body.tools ?? [], tool_choice: body.tool_choice, json_schema: body.json_schema });
    const repeated = JSON.stringify(a) === JSON.stringify(b) && toolSchema(prev.body) === toolSchema(cur.body);
    const advanced = prev.history && cur.history && cur.history.userCount > prev.history.userCount
        && cur.history.lastUser !== prev.history.lastUser;
    return [
        `${new Date().toLocaleTimeString()}｜对比 ${gapSec} 秒前同模型的上一次正文请求（${a.length} 条 → ${b.length} 条消息）`,
        `请求类型：${repeated ? '重复请求（不能证明连续楼层效果）' : advanced ? '连续楼层（用户输入不同）' : '其他变化（重试、改写或历史状态不明）'}`,
        `请求前缀文本相似度：${(chars / total * 100).toFixed(1)}%（约 ${chars.toLocaleString()} / ${total.toLocaleString()} 字，前 ${k} 条完全相同；不是缓存命中率）`,
        k < b.length ? `第一处不同：第 ${k + 1} 条（${cur.body.messages[k]?.role}），该条第 ${at} 字` : '当前消息数组为上次的完整相同前缀或完全相同（另检查工具定义）',
        k < b.length ? `　上次：${show(a[k] ?? '（无）')}` : '',
        k < b.length ? `　这次：${show(b[k])}` : '',
        toolSchema(prev.body) !== toolSchema(cur.body) ? '⚠ 工具定义发生变化（包括参数 schema），需结合 API 缓存统计判断影响' : '',
        '观察阶段：浏览器发往酒馆的最终请求；酒馆后端仍可能合并消息或转换格式，最终发送内容以后台为准。',
    ].filter(Boolean).join('\n');
}

function recordRealRequest(rawBody) {
    let body;
    try { body = JSON.parse(rawBody); } catch { return; }
    if (!body || !Array.isArray(body.messages) || body.type === 'quiet' || !findHistoryRange(body.messages)) return null;
    const chatId = ctx().getCurrentChatId?.() ?? '';
    const now = Date.now();
    const channel = JSON.stringify([body.chat_completion_source, body.model, body.type, body.reverse_proxy, body.custom_url]);
    const history = ctx().chat ?? [];
    const cur = { chatId, channel, at: now, body, texts: messageTexts(body), history: {
        count: history.length, userCount: history.filter(m => m.is_user).length,
        lastUser: history.findLast(m => m.is_user)?.mes ?? '',
    } };
    const candidates = recentReal.filter(r => r.chatId === chatId && r.channel === channel);
    if (candidates.length) {
        const previous = candidates.at(-1);
        const report = describeReal(previous, cur, Math.round((now - previous.at) / 1000));
        settings().lastRealReport = report;
        save();
        $('#cacheopt_real').text(report);
        console.info('[缓存优化] 真实发送对比\n' + report);
    }
    recentReal = [...recentReal.filter(r => r.chatId === chatId), cur].slice(-RECENT_LIMIT);
    $('#cacheopt_usage').text(`${body.model ?? '当前正文模型'}｜API 缓存统计：等待响应…`);
    return cur;
}

/** 缺失统计与明确返回 0 严格分开；只读取响应，不推算 token。 */
function readUsage(payload) {
    if (!payload || typeof payload !== 'object') return null;
    const usage = payload.usageMetadata ?? payload.usage_metadata ?? payload.usage;
    if (!usage || typeof usage !== 'object') return null;
    const count = (...values) => values.find(v => typeof v === 'number' && Number.isFinite(v) && v >= 0) ?? null;
    const cached = count(usage.cachedContentTokenCount, usage.cached_content_token_count,
        usage.prompt_tokens_details?.cached_tokens, usage.input_tokens_details?.cached_tokens,
        usage.cache_read_input_tokens, usage.total_cached_tokens);
    const total = count(usage.promptTokenCount, usage.prompt_token_count, usage.prompt_tokens, usage.input_tokens, usage.total_input_tokens);
    return cached === null && total === null ? null : { cached, total };
}

function identifiedUsageFields(payload) {
    const prefix = ['usageMetadata', 'usage_metadata', 'usage'].find(key => payload?.[key] != null);
    if (!prefix) return [];
    const fields = [
        'cachedContentTokenCount', 'cached_content_token_count',
        'prompt_tokens_details.cached_tokens', 'input_tokens_details.cached_tokens',
        'cache_read_input_tokens', 'total_cached_tokens',
    ];
    return fields.map(field => `${prefix}.${field}`).flatMap(path => {
        const value = path.split('.').reduce((object, key) => object?.[key], payload);
        return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? [`${path} = ${value}`] : [];
    });
}

async function observeUsage(response, request) {
    if (!request || !response.ok) return;
    let usage = null;
    let cacheFields = [];
    try {
        const copy = response.clone();
        const accept = payload => {
            const value = readUsage(payload);
            if (value) usage = { cached: value.cached ?? usage?.cached ?? null, total: value.total ?? usage?.total ?? null };
            const fields = identifiedUsageFields(payload);
            if (fields.length) cacheFields = fields;
        };
        // 酒馆透传流式响应时可能没有 Content-Type；请求本身也能确认 SSE 模式。
        if (request.body?.stream === true || (copy.headers.get('content-type') ?? '').includes('text/event-stream')) {
            const reader = copy.body.getReader();
            const decoder = new TextDecoder();
            let buffer = '';
            const line = value => {
                if (!value.startsWith('data:')) return;
                try { accept(JSON.parse(value.slice(5).trim())); } catch { /* DONE/非 JSON 帧 */ }
            };
            try {
                while (true) {
                    const { done, value } = await reader.read();
                    buffer += decoder.decode(value, { stream: !done });
                    let end;
                    while ((end = buffer.indexOf('\n')) >= 0) {
                        line(buffer.slice(0, end).replace(/\r$/, ''));
                        buffer = buffer.slice(end + 1);
                    }
                    // 异常或超大 SSE 单帧时停止观察，不影响原响应。
                    if (buffer.length > 4 * 1024 * 1024) { void reader.cancel(); break; }
                    if (done) { if (buffer) line(buffer); break; }
                }
            } finally { reader.releaseLock(); }
        } else accept(await copy.json());
    } catch { /* 原响应继续交给酒馆；旁观失败不能被算作 0 */ }
    if (ctx().getCurrentChatId?.() !== request.chatId || recentReal.at(-1) !== request) return;
    const ratio = usage?.cached !== null && usage?.cached !== undefined && usage?.total > 0
        ? `（${(usage.cached / usage.total * 100).toFixed(1)}%）` : '';
    const report = `${request.body.model ?? '当前正文模型'}｜API 缓存 token：${usage?.cached ?? '未知（响应未返回缓存字段）'}`
        + `${usage?.total !== null && usage?.total !== undefined ? ` / 输入 ${usage.total}` : ''}${ratio}`;
    settings().lastUsageReport = report;
    save();
    $('#cacheopt_usage').text(report);
    $('#cacheopt_usage').attr('title', cacheFields.length ? cacheFields.join('\n') : '响应未返回已识别的缓存数字字段');
}

function recordRequestFailure(request) {
    if (!request) return;
    const latest = recentReal.at(-1) === request;
    recentReal = recentReal.filter(r => r !== request);
    if (latest && ctx().getCurrentChatId?.() === request.chatId) {
        $('#cacheopt_usage').text('正文请求失败或已取消：没有可确认的 API 缓存统计。');
    }
}

function watchRealRequests() {
    const original = window.fetch;
    if (original.__cacheoptWatch) return;
    const wrapped = function (input, init) {
        let request = null;
        let forwardedInit = init;
        try {
            const url = typeof input === 'string' ? input : input?.url;
            // 数据库已公开的内存标记；辅助模型处理输入/召回，不纳入正文统计。
            if (!init?.[ACU_INTERNAL] && url && url.includes(GENERATE_PATH) && typeof init?.body === 'string') {
                let rawBody = init.body;
                if (settings().enabled && settings().compatGeminiProxy) {
                    const body = JSON.parse(rawBody);
                    const report = applyGeminiProxyLayout(body);
                    if (report.applied) {
                        rawBody = JSON.stringify(body);
                        forwardedInit = requestInitWithBody(init, rawBody);
                    }
                    $('#cacheopt_last').text(`${lastRun}\n${describeGeminiLayout(report)}`);
                }
                request = recordRealRequest(rawBody);
            }
        } catch { /* 只旁观，出错不影响请求 */ }
        return original.call(this, input, forwardedInit).then(response => {
            if (!response.ok) recordRequestFailure(request);
            else if (request) void observeUsage(response, request);
            return response;
        }, error => {
            recordRequestFailure(request);
            throw error;
        });
    };
    wrapped.__cacheoptWatch = true;
    window.fetch = wrapped;
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
          <label class="checkbox_label"><input id="cacheopt_shujuku" type="checkbox"> 数据库召回兼容：纪要、索引、表头和包裹移到当前历史之后</label>
          <label class="checkbox_label"><input id="cacheopt_izumi" type="checkbox"> 泉记忆功能兼容（仅使用该功能时开启）</label>
          <label class="checkbox_label"><input id="cacheopt_gemini_proxy" type="checkbox"> Gemini / Vertex 固定头强化（实验）：固定规则集中到开头，动态资料留在后部</label>
          <div class="cacheopt-hint">用于自定义、Vertex 或 Google 接口的 Gemini 正文请求。会合并固定 system 并调整规则顺序，原位留下固定 user 标记，将后部 system 资料原位转为 user；可能影响预设服从程度。默认关闭，实际收益以 API 缓存 token 为准。</div>
          <label class="checkbox_label"><input id="cacheopt_sticky" type="checkbox"> 关键词设定放到聊天记录前并保持
            <input id="cacheopt_sticky_turns" class="text_pole cacheopt-num" type="number" min="1" max="50"> 条消息（场景稳定时更省，换场景那轮更贵；Gemini / Vertex 或开了提示词后处理时自动不生效）</label>
          <label class="checkbox_label"><input id="cacheopt_learn" type="checkbox"> 自动学习系统提示里的易变块</label>
          <label class="cacheopt-label">保持原位的条目（正则，匹配条目名或内容开头）
            <input id="cacheopt_keep" class="text_pole" type="text">
          </label>
          <div class="cacheopt-row">
            <div id="cacheopt_check" class="menu_button">连续楼层测试说明（免费）</div>
            <div id="cacheopt_forget" class="menu_button">清空已学到的易变块</div>
          </div>
          <div id="cacheopt_learned" class="cacheopt-hint"></div>
          <div id="cacheopt_last" class="cacheopt-hint"></div>
          <div id="cacheopt_report" class="cacheopt-report">正常聊天后查看下方两项：请求前缀文本相似度、API 实际缓存 token。</div>
          <div class="cacheopt-hint">真实发送对比（同聊天、同模型的相邻正文请求，排除已标记的数据库辅助请求）：</div>
          <div id="cacheopt_real" class="cacheopt-report">同一聊天连续发送两次后显示。</div>
          <div id="cacheopt_usage" class="cacheopt-report">API 缓存统计：尚未收到正文响应。没有返回统计时为未知。</div>
        </div>
      </div>
    </div>`;
    $('#extensions_settings2').append(html);
    $('#cacheopt_enabled').prop('checked', settings().enabled).on('input', function () { setEnabled(!!$(this).prop('checked')); });
    bindCheckbox('#cacheopt_route', 'routeWorldInfo');
    bindCheckbox('#cacheopt_hoist', 'hoistStatic');
    bindCheckbox('#cacheopt_shujuku', 'compatShujuku');
    bindCheckbox('#cacheopt_izumi', 'compatIzumi');
    bindCheckbox('#cacheopt_gemini_proxy', 'compatGeminiProxy');
    bindCheckbox('#cacheopt_learn', 'learn');
    bindCheckbox('#cacheopt_sticky', 'stickyLore');
    $('#cacheopt_sticky_turns').val(settings().stickyTurns).on('change', function () {
        settings().stickyTurns = Math.min(50, Math.max(1, Math.floor(Number($(this).val())) || DEFAULTS.stickyTurns));
        $(this).val(settings().stickyTurns);
        save();
    });
    $('#cacheopt_keep').val(settings().keepPatterns).on('change', function () {
        settings().keepPatterns = String($(this).val());
        save();
    });
    $('#cacheopt_check').on('click', checkStability);
    $('#cacheopt_forget').on('click', () => {
        settings().learnedHeads = [];
        save();
        renderLearned();
    });
    $('#cacheopt_last').text(lastRun);
    // 不把旧版本的字符百分比或上次会话的 usage 当成本轮结果。
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
    void loadNativePromptManager();
    renderSettings();
    watchRealRequests();
    const c = ctx();
    c.eventSource.on(c.eventTypes.WORLDINFO_ENTRIES_LOADED, data => {
        routeEntries([data?.globalLore, data?.characterLore, data?.chatLore, data?.personaLore]);
    });
    c.eventSource.on(c.eventTypes.CHAT_COMPLETION_PROMPT_READY, onPromptReady);
    armFinalHook();
});
