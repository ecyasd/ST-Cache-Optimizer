// 缓存优化 v2.6.7：仅处理 Vertex 正文，按本轮激活来源有限前移常驻世界书。
// 仅修改本轮扫描/请求副本；请求相似度和服务端缓存 token 分开报告。
// 相同前缀能提高隐式缓存机会，但实际命中以 API 响应为准。

const MODULE = 'cacheOptimizer';
const DEFAULTS = Object.freeze({
    enabled: true,
    routeWorldInfo: true,
    hoistStatic: true,
    preserveStructure: true,
    learn: true,
    stickyLore: false,
    stickyTurns: 6,
    compatShujuku: true,
    compatIzumi: false,
    compatGeminiProxy: false,
    volatileHeads: ['〔记忆系统私密简报'],
    learnedHeads: [],
    learnedByScope: {},
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
const MAX_LEARNED = 30;
const MAX_LEARNING_SCOPES = 50;
const LEARNED_TTL = 30 * 24 * 60 * 60 * 1000;
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
const RUNTIME_SYSTEM_RECORDS = /^【本轮江湖介入】启用后第\d+轮；实际玩家回合序号\d+，玩家楼层\d+。[^\n]*同轮续写不新开第二个事件。(?=\n|$)|^<此刻运势>[^\S\n]*\d{1,3}[^\S\n]*<\/此刻运势>[^\S\n]*\n同一回合各项不同行动共用此值。[^\n]*不在正文展示运势。(?=\n|$)/gm;

function isShujukuEntry(entry) {
    if (!settings().compatShujuku) return false;
    return hasShujukuOwnership(entry);
}

function hasShujukuOwnership(entry) {
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
let generationHistorySnapshot = null;
let nativeHistoryInterceptorSupported = false;
let generationScope = null;
const generationDiagnostics = { sequence: 0, events: [] };

function diagnosticGenerationType(type) {
    return ['normal', 'regenerate', 'swipe', 'quiet', 'impersonate', 'continue'].includes(type) ? type : type == null ? 'missing' : 'other';
}

function noteGenerationEvent(event, details = {}) {
    try {
        if (!isVertexConnection()) return;
        const c = ctx(), chatId = String(c.getCurrentChatId() ?? '');
        let hash = 2166136261;
        for (let i = 0; i < chatId.length; i++) hash = Math.imul(hash ^ chatId.charCodeAt(i), 16777619);
        const entry = { n: ++generationDiagnostics.sequence, event, chat: (hash >>> 0).toString(16),
            type: diagnosticGenerationType(generationScope?.type), scope: !!generationScope,
            confirmed: !!generationScope?.confirmed, ...details };
        generationDiagnostics.events = [...generationDiagnostics.events.slice(-29), entry];
        $('#cacheopt_last').attr('title', generationDiagnostics.events.map(row => JSON.stringify(row)).join('\n'));
        console.debug('[缓存优化诊断]', JSON.stringify(entry));
    } catch { /* Diagnostic failures must not affect generation. No prompt text is logged. */ }
}

function isVertexConnection(connection = null) {
    if (connection) return connection.mainApi === 'openai' && connection.source === 'vertexai';
    const c = ctx();
    return c.mainApi === 'openai' && c.chatCompletionSettings?.chat_completion_source === 'vertexai';
}

function onGenerationStarted(type, options = {}, dryRun = false) {
    processedHistorySnapshot = null;
    generationHistorySnapshot = null;
    const c = ctx();
    generationScope = {
        chatId: c.getCurrentChatId(), type: type ?? 'normal', dryRun: !!dryRun,
        connection: { mainApi: c.mainApi, source: c.chatCompletionSettings?.chat_completion_source },
        confirmed: false, worldInfoHandled: false, settingsHandled: false,
        auxiliary: typeof options.quiet_prompt === 'string' && !!options.quiet_prompt.trim(),
    };
    noteGenerationEvent('start', { dryRun: !!dryRun, auxiliary: generationScope.auxiliary });
}

function clearGenerationScope(reason = 'reset') {
    if (generationScope || generationHistorySnapshot) noteGenerationEvent(reason === 'ended' ? 'ended' : 'reset');
    generationScope = null;
    processedHistorySnapshot = null;
    generationHistorySnapshot = null;
}

function onGenerationStopped(generationId) {
    // Native ST stopGeneration emits STOPPED without arguments. TavernHelper's
    // generate/generateRaw emits the same host event with its string task ID;
    // stopping database planning must not revoke the outer native generation.
    if (typeof generationId === 'string' && generationId.length > 0) { noteGenerationEvent('stop-helper-id'); return; }
    noteGenerationEvent('stop-native');
    clearGenerationScope();
}

function onGenerationEnded() {
    // TavernHelper's planning cleanup calls native activateSendButtons, which
    // emits ENDED before the outer Generate reaches its official core hook.
    // This preserves only a pending START; it grants no rewrite permission.
    if (generationScope && !generationScope.confirmed && !generationHistorySnapshot
        && !generationScope.dryRun && !generationScope.auxiliary
        && generationScope.chatId === ctx().getCurrentChatId()
        && isVertexConnection() && isVertexConnection(generationScope.connection)
        && ['normal', 'regenerate', 'swipe'].includes(generationScope.type)) {
        noteGenerationEvent('ended-before-core');
        return;
    }
    clearGenerationScope('ended');
}

function isMainGenerationScope() {
    if (!isVertexConnection()) { clearGenerationScope(); return false; }
    return !!generationScope && generationScope.chatId === ctx().getCurrentChatId()
        && isVertexConnection(generationScope.connection)
        && generationScope.confirmed && !generationScope.dryRun && !generationScope.auxiliary
        && ['normal', 'regenerate', 'swipe'].includes(generationScope.type);
}

function onWorldInfoEntriesLoaded(data) {
    if (!isMainGenerationScope() || generationScope.worldInfoHandled) return;
    generationScope.worldInfoHandled = true;
    captureStaticLoreSources(data);
    routeEntries([data?.globalLore, data?.characterLore, data?.chatLore, data?.personaLore]);
}

/** Source admission is separate from dynamic routing and never changes scan data.
 * A constant entry with arbitrary template syntax is not a literal fixed rule.
 */
function staticLoreRecord(entry) {
    if (!entry || typeof entry.world !== 'string' || !entry.world
        || !['string', 'number'].includes(typeof entry.uid)) return null;
    const content = String(entry.content ?? ''), depth = Number(entry.depth), keep = keepRegex();
    const eligible = entry.constant === true && !entry.disable
        && Number(entry.position) === POS.atDepth && Number(entry.role ?? ROLE_SYSTEM) === ROLE_SYSTEM
        && Number.isInteger(depth) && depth > 0 && depth <= TOP_DEPTH
        && !!content.trim() && !/\{\{|\}\}|<%|%>|\{\[|\bIZ[MW]7_|【本轮江湖介入】|<此刻运势>/i.test(content)
        && !hasShujukuOwnership(entry) && !SHUJUKU_TEMPLATE.test(content) && !isDynamicEntry(entry)
        && (!entry.useProbability || Number(entry.probability ?? 100) === 100)
        && !entry.vectorized && !String(entry.group ?? '').trim() && !String(entry.automationId ?? '').trim()
        && !entry.delayUntilRecursion && !(entry.characterFilter?.names?.length || entry.characterFilter?.tags?.length)
        && !(Array.isArray(entry.triggers) && entry.triggers.length)
        && !keep.test(String(entry.comment ?? entry.name ?? '')) && !keep.test(content.trimStart().split('\n', 1)[0]);
    return { key: JSON.stringify([entry.world, entry.uid]), content, depth, eligible,
        signature: JSON.stringify([content, entry.constant, entry.disable ?? false, Number(entry.position),
            Number(entry.role ?? ROLE_SYSTEM), depth, entry.useProbability ?? false, entry.probability ?? 100,
            entry.sticky ?? 0, entry.cooldown ?? 0, entry.delay ?? 0, entry.vectorized ?? false,
            entry.group ?? '', entry.automationId ?? '', entry.triggers ?? [], entry.comment ?? entry.name ?? '',
            entry.delayUntilRecursion ?? false, entry.characterFilter ?? null]) };
}

function captureStaticLoreSources(data) {
    const records = new Map();
    for (const list of [data?.globalLore, data?.characterLore, data?.chatLore, data?.personaLore]) {
        if (!Array.isArray(list)) continue;
        for (const entry of list) {
            const record = staticLoreRecord(entry);
            if (record) records.set(record.key, records.has(record.key) ? null : record);
        }
    }
    generationScope.staticLoreSources = records;
    generationScope.staticLoreActivated = [];
    generationScope.staticLorePreset = presetLearningIdentity();
}

function onWorldInfoActivated(entries) {
    if (!isMainGenerationScope() || !Array.isArray(entries) || !generationScope.staticLoreSources) return;
    const seen = new Set(), activated = [];
    for (const entry of entries) {
        const current = staticLoreRecord(entry);
        if (!current) continue;
        const source = generationScope.staticLoreSources.get(current.key);
        if (seen.has(current.key)) { generationScope.staticLoreActivated = []; return; }
        seen.add(current.key);
        if (source?.eligible && current.eligible && source.signature === current.signature) activated.push(source);
    }
    generationScope.staticLoreActivated = activated;
}

function uniqueLiteralOffset(haystack, needle) {
    const at = haystack.indexOf(needle);
    return at >= 0 && haystack.indexOf(needle, at + 1) < 0 ? at : -1;
}

/** Never cut across an open tag, XML comment or Markdown code fence. */
function closedLoreBoundary(content, whole = content) {
    let fence = null;
    const outside = [];
    for (const line of content.split('\n')) {
        const mark = line.match(/^\s{0,3}(`{3,}|~{3,})(.*)$/);
        if (mark) {
            if (!fence) fence = { char: mark[1][0], length: mark[1].length };
            else if (mark[1][0] === fence.char && mark[1].length >= fence.length && !mark[2].trim()) fence = null;
        } else if (!fence) outside.push(line);
    }
    if (fence) return false;
    let value = outside.join('\n');
    value = value.replace(/<!--[\s\S]*?-->/g, '');
    if (value.includes('<!--') || value.includes('-->')) return false;
    const stack = [], empty = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
    const htmlContainers = new Set(['div', 'span', 'p', 'pre', 'code', 'script', 'style', 'section', 'article', 'table', 'ul', 'ol', 'li', 'details', 'textarea']);
    const closers = new Set([...whole.matchAll(/<\/([A-Za-z_\u3400-\u9fff][\w\u3400-\u9fff:.-]*)\s*>/g)].map(match => match[1].toLowerCase()));
    for (const match of value.matchAll(/<(\/?)([A-Za-z_\u3400-\u9fff][\w\u3400-\u9fff:.-]*)(?:\s[^<>]*?)?\s*(\/?)>/g)) {
        const tag = match[2].toLowerCase();
        if (empty.has(tag) || match[3]) continue;
        // Inline bare <name> values with no closer are common documentation
        // placeholders inside an enclosing, balanced rule. Standalone tags,
        // HTML containers and tags closed in the unknown tail remain structural.
        if (!match[1] && !closers.has(tag) && !htmlContainers.has(tag) && match[0] === `<${match[2]}>`) {
            const lineStart = value.lastIndexOf('\n', match.index - 1) + 1;
            const nextLine = value.indexOf('\n', match.index + match[0].length);
            const lineEnd = nextLine < 0 ? value.length : nextLine;
            if (stack.length && value.slice(lineStart, lineEnd).trim() !== match[0]) continue;
        }
        if (match[1]) { if (stack.pop() !== tag) return false; }
        else stack.push(tag);
    }
    return stack.length === 0;
}

/** Prove the leading literal part of the host's actual depth-WI assembly.
 * A mixed or templated tail stays put; no macros or regex are executed again.
 */
function provenStaticLorePrefixes() {
    const groups = new Map();
    for (const record of generationScope.staticLoreActivated ?? []) {
        const list = groups.get(record.depth) ?? [];
        list.push(record); groups.set(record.depth, list);
    }
    const prefixes = [];
    for (const [depth, records] of groups) {
        const prompt = ctx().extensionPrompts?.[`customDepthWI_${depth}_${ROLE_SYSTEM}`];
        if (!prompt || Number(prompt.depth) !== depth || Number(prompt.role) !== ROLE_SYSTEM
            || Number(prompt.position) !== 1 || typeof prompt.value !== 'string' || !prompt.value) continue;
        const value = prompt.value;
        const spans = records.map(record => ({ record, start: uniqueLiteralOffset(value, record.content) }))
            .filter(span => span.start >= 0 && (span.start === 0 || value[span.start - 1] === '\n')
                && (span.start + span.record.content.length === value.length || value[span.start + span.record.content.length] === '\n'))
            .sort((a, b) => a.start - b.start);
        if (spans.some((span, index) => index > 0 && span.start < spans[index - 1].start + spans[index - 1].record.content.length)) continue;
        let end = 0, count = 0;
        for (const span of spans) {
            if (span.start < end || !/^\n*$/.test(value.slice(end, span.start))) break;
            end = span.start + span.record.content.length; count++;
        }
        if (count && closedLoreBoundary(value.slice(0, end), value)) prefixes.push({ assembly: value,
            content: value.slice(0, end), entries: count });
    }
    return prefixes;
}

/** Limited relocation crosses authenticated history only. Unknown fixed rules
 * are barriers, preserving the global order of all fixed/preset material.
 */
function hoistProvenStaticLore(chat) {
    const result = { blocks: 0, entries: 0, chars: 0 };
    const s = settings(), snapshot = currentProcessedHistory();
    if (!s.enabled || !s.hoistStatic || !s.preserveStructure || !isMainGenerationScope()
        || !snapshot || generationScope.staticLorePreset !== presetLearningIdentity()) return result;
    if (chat.some(message => !message || typeof message.content !== 'string'
        || !['system', 'user', 'assistant'].includes(message.role))) return result;
    const aligned = alignHistorySequence(chat, snapshot.entries, snapshot.requiredRoles, true);
    if (!aligned) return result;
    const historical = new Set(aligned.positions.map(position => chat[position]));
    const candidates = provenStaticLorePrefixes().filter(prefix => {
        let count = 0, prefixCount = 0;
        for (const message of chat) {
            const at = uniqueLiteralOffset(message.content, prefix.assembly);
            if (at >= 0) count++;
            else if (message.content.includes(prefix.assembly)) return false;
            const prefixAt = uniqueLiteralOffset(message.content, prefix.content);
            if (prefixAt >= 0) prefixCount++;
            else if (message.content.includes(prefix.content)) return false;
        }
        return count === 1 && prefixCount === 1;
    });
    const anchor = chat[aligned.start], moved = [];
    // Stop at any unknown material, including the unproven tail of a mixed block.
    for (let i = aligned.start; i <= aligned.end; i++) {
        const message = chat[i];
        if (historical.has(message)) continue;
        if (message.role !== 'system' || Object.keys(message).some(key => !['role', 'content'].includes(key))) break;
        const matches = candidates.filter(prefix => message.content.startsWith(prefix.assembly));
        if (matches.length !== 1) break;
        const prefix = matches[0], tail = message.content.slice(prefix.content.length);
        if (!tail && chat[i - 1]?.role === chat[i + 1]?.role && ['user', 'assistant'].includes(chat[i - 1]?.role)) break;
        const fixed = tail ? { role: 'system', content: prefix.content } : message;
        Object.defineProperty(fixed, '__cacheoptStaticLore', { value: true, enumerable: false });
        moved.push(fixed); result.blocks++; result.entries += prefix.entries; result.chars += prefix.content.length;
        if (tail) { chat[i] = { role: 'system', content: tail }; break; }
        chat.splice(i--, 1); aligned.end--;
    }
    if (moved.length) chat.splice(chat.indexOf(anchor), 0, ...moved);
    return result;
}

async function loadNativePromptManager() {
    try {
        // Read the host's finished messages; never run the user's regex or macros again.
        // Keep the namespace: ST replaces this exported live binding after API changes.
        const [openai, extensions] = await Promise.all([import('/scripts/openai.js'), import('/scripts/extensions.js')]);
        nativeOpenAIModule = openai;
        nativeHistoryInterceptorSupported = typeof extensions.runGenerationInterceptors === 'function';
        reportHostHookStatus(extensions);
        await refreshOwnManifestCache(extensions);
    } catch {
        noteGenerationEvent('host-hook-import-failed');
        /* 未确认正式历史钩子的宿主不授权请求整理；不以弱回退绕过来源确认。 */
    }
}

function reportHostHookStatus(extensions) {
    try {
        const manifest = extensions.getExtensionManifest?.('ST-Cache-Optimizer');
        const extension = extensions.findExtension?.('ST-Cache-Optimizer');
        noteGenerationEvent('host-hook-status', {
            loadedManifest: !!manifest,
            loadedVersion: typeof manifest?.version === 'string' ? manifest.version.slice(0, 40) : null,
            loadedHook: typeof manifest?.generate_interceptor === 'string' ? manifest.generate_interceptor.slice(0, 100) : null,
            ownGlobalType: typeof globalThis.cacheOptimizerCaptureHistory,
            ownGlobalMatches: globalThis.cacheOptimizerCaptureHistory === captureGenerationHistory,
            hostInterceptorType: typeof extensions.runGenerationInterceptors,
            extensionEnabled: typeof extension?.enabled === 'boolean' ? extension.enabled : null,
        });
    } catch { noteGenerationEvent('host-hook-status', { metadataReadFailed: true }); }
}

async function refreshOwnManifestCache(extensions) {
    if (!isVertexConnection()) return 'other-connection';
    try {
        const loaded = extensions.getExtensionManifest?.('ST-Cache-Optimizer');
        const extension = extensions.findExtension?.('ST-Cache-Optimizer');
        if (!loaded || loaded.generate_interceptor === 'cacheOptimizerCaptureHistory') return 'not-needed';
        if (extension?.enabled !== true || !/^(?:third-party\/)?ST-Cache-Optimizer$/i.test(extension.name ?? '')) return 'unknown-registration';
        // Cocktail+ may preload old manifests with force-cache. Reload only our
        // exact manifest URL, updating its HTTP cache for the next normal page
        // load. Never mutate the host's private registry or other extensions.
        const url = `/scripts/extensions/${extension.name.split('/').map(encodeURIComponent).join('/')}/manifest.json`;
        const response = await window.fetch(url, { method: 'GET', credentials: 'same-origin', cache: 'reload' });
        if (!response.ok) throw new Error('manifest-response');
        const fresh = await response.json();
        if (fresh?.generate_interceptor !== 'cacheOptimizerCaptureHistory' || fresh.js !== 'index.js') throw new Error('manifest-hook');
        noteGenerationEvent('own-manifest-refreshed', { fetchedVersion: typeof fresh.version === 'string' ? fresh.version.slice(0, 40) : null });
        lastRun = '宿主加载了本插件的旧清单；已刷新本插件清单缓存，请再次刷新酒馆页面后再生成。';
        $('#cacheopt_last').text(lastRun);
        return 'refreshed';
    } catch {
        noteGenerationEvent('own-manifest-refresh-failed');
        lastRun = '宿主未加载本插件的历史钩子，自动刷新本插件清单缓存失败；请更新插件并完整刷新页面后再生成。';
        $('#cacheopt_last').text(lastRun);
        return 'failed';
    }
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
    if (!isVertexConnection() || !s.enabled || !s.routeWorldInfo) return;
    const keep = keepRegex();
    // 有的预设把世界书位置排在聊天记录之后：那里的内容每轮都排在新消息后面，永远命中不了。
    // 这时固定设定改插到聊天记录最顶端（深度 TOP_DEPTH），不管预设怎么排都在聊天记录之前。
    const beforeSlotOk = presetSlotBeforeHistory('worldInfoBefore');
    const afterSlotOk = presetSlotBeforeHistory('worldInfoAfter');
    const stickyTurns = Math.max(0, Math.floor(Number(s.stickyTurns) || 0));
    const stickyOn = s.stickyLore && !systemBlocksGetMerged();
    const toTop = e => {
        Object.assign(e, { position: POS.atDepth, depth: TOP_DEPTH, role: ROLE_SYSTEM });
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
                } else if (!e.constant || isDynamicEntry(e)) {
                    Object.assign(e, { position: POS.atDepth, depth: 0, role: ROLE_SYSTEM });
                } else if (!s.preserveStructure && (pos === POS.before ? !beforeSlotOk : !afterSlotOk)) {
                    toTop(e);
                }
            } else if (pos === POS.atDepth && (!e.constant || isDynamicEntry(e))) {
                // 会变的深度条目统一放到深度 0：深度设得比聊天记录还大时它会落进系统提示，
                // 放在中间也会随楼层后移改写前缀；深度 0 之后由发送前重排挪到聊天记录末尾
                if (Number(e.depth) !== 0) {
                    e.depth = 0;
                }
            } else if (!s.preserveStructure && s.hoistStatic && e.constant && !isDynamicEntry(e)
                && pos === POS.atDepth && Number(e.role ?? ROLE_SYSTEM) === ROLE_SYSTEM) {
                // 显式关闭结构保护时允许前移；扫描预算优先级 order 保持原值。
                // before 槽固定使用 system；保留 user/assistant 深度条目及角色由作者注释控制的 AN 条目。
                // order also controls host activation/budget priority. Never change
                // it during the scan, even when explicitly opting into relocation.
                if (beforeSlotOk) e.position = POS.before;
                else toTop(e);
            }
        }
    }
    // 不添加装饰性世界书条目：即使原条目未激活，constant 包裹也会占用预算、
    // 满足最小激活数，并可能继承 automationId 触发真实 Quick Reply。
}

// ───────────────────────── 2. 发送前重排 + 3. 自动学习 ─────────────────────────

function headOf(message) {
    return text(message).trimStart().split('\n', 1)[0].slice(0, 40);
}

/** 插在聊天记录最顶端、要留在前面的块（固定设定 / 近期剧情设定） */
function isTopBlock(message) {
    if (message.__cacheoptStaticLore) return true;
    const t = text(message).trimStart();
    if (t.startsWith(STATIC_OPEN) || t.startsWith(STICKY_OPEN)) return true;
    // ST exposes the activated, assembled top-depth lore as an extension prompt.
    // Match the complete block instead of adding constant scan entries as labels.
    const top = ctx().extensionPrompts?.[`customDepthWI_${TOP_DEPTH}_${ROLE_SYSTEM}`];
    return message.role === 'system' && top?.depth === TOP_DEPTH && top?.role === ROLE_SYSTEM
        && typeof top.value === 'string' && !!top.value.trim() && normalize(t) === normalize(top.value);
}

function isVolatileHead(head) {
    return settings().volatileHeads.some(h => h && head.startsWith(h)) || learnedHeadsForScope().includes(head);
}

function isProtectedMessage(message) {
    const firstLine = text(message).trimStart().split('\n', 1)[0];
    return !!firstLine && keepRegex().test(firstLine);
}

function isMovableDynamic(message) {
    const t = text(message).trimStart();
    // Complete known database wrappers take precedence over generic keep patterns.
    if (message.__cacheoptDynamic || t.startsWith(WRAP_OPEN) && t.trimEnd().endsWith(WRAP_CLOSE)
        && t.split(WRAP_OPEN).length === 2 && t.split(WRAP_CLOSE).length === 2) return true;
    if (isProtectedMessage(message)) return false;
    // Worldbook template syntax alone does not establish final-message origin:
    // a fixed preset can document a random macro literally as an example.
    return isVolatileHead(headOf(message)) && t.length <= MAX_LEARN_CHARS;
}

function presetLearningIdentity() {
    const cc = ctx().chatCompletionSettings ?? {};
    // Hash source templates and order, never rendered turn variables. Learning
    // from one preset must not authorize moving a same-titled rule in another.
    const source = JSON.stringify([cc.preset_settings_openai ?? '', cc.names_behavior ?? 0,
        cc.prompt_order ?? [], cc.prompts ?? []]);
    let hash = 2166136261;
    for (let i = 0; i < source.length; i++) hash = Math.imul(hash ^ source.charCodeAt(i), 16777619);
    return `${source.length}:${(hash >>> 0).toString(16)}`;
}

function learningScopeKey() {
    const c = ctx();
    const owner = c.groupId ? ['group', String(c.groupId)]
        : ['character', String(c.characters?.[c.characterId]?.avatar ?? c.characterId ?? '')];
    return JSON.stringify([...owner, String(c.getCurrentChatId() ?? ''), presetLearningIdentity()]);
}

function learnedHeadsForScope() {
    // Legacy global heads cannot safely be attributed to a character or chat.
    const record = settings().learnedByScope[learningScopeKey()];
    return record && Number.isFinite(record.updatedAt) && Date.now() - record.updatedAt < LEARNED_TTL
        && Array.isArray(record.heads) ? record.heads : [];
}

function rememberLearnedHeads(heads) {
    const s = settings(), now = Date.now();
    const records = Object.entries(s.learnedByScope).filter(([, record]) => record
        && Number.isFinite(record.updatedAt) && now - record.updatedAt < LEARNED_TTL);
    const key = learningScopeKey();
    s.learnedByScope = Object.fromEntries([...records.filter(([id]) => id !== key),
        [key, { heads: [...new Set(heads)].slice(-MAX_LEARNED), updatedAt: now }]]
        .sort((a, b) => a[1].updatedAt - b[1].updatedAt).slice(-MAX_LEARNING_SCOPES));
}

function normalize(value) {
    return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function currentProcessedHistory() {
    const chatId = ctx().getCurrentChatId();
    if (processedHistorySnapshot?.chatId !== chatId) processedHistorySnapshot = null;
    if (generationHistorySnapshot?.chatId !== chatId) generationHistorySnapshot = null;
    return processedHistorySnapshot;
}

/** Official ST interceptor: coreChat has already passed prompt regex, file and
 * reasoning processing, and has not received worldbook/depth injections yet.
 * Read only; never run the user's transformations a second time.
 */
function captureGenerationHistory(chat, _contextSize, _abort, type) {
    nativeHistoryInterceptorSupported = true;
    processedHistorySnapshot = null;
    const generationType = type ?? 'normal';
    if (generationScope && generationScope.type === generationType) generationScope.confirmed = true;
    const blocked = !isMainGenerationScope() || !Array.isArray(chat);
    generationHistorySnapshot = {
        chatId: ctx().getCurrentChatId(), pending: true, blocked,
        identityWitnesses: new WeakMap(), identityGroups: [],
        entries: blocked ? [] : chat.filter(message => message && !message.is_system
            && typeof message.mes === 'string' && message.mes.trim() && message.extra?.type !== 'narrator')
            .map(expectedHistoryEntry),
    };
    noteGenerationEvent('core', { suppliedType: diagnosticGenerationType(type), blocked, entries: generationHistorySnapshot.entries.length });
}
globalThis.cacheOptimizerCaptureHistory = captureGenerationHistory;

function expectedHistoryEntry(message) {
    const c = ctx(), behavior = c.chatCompletionSettings?.names_behavior ?? 0;
    const narrator = message.extra?.type === 'narrator';
    let content = message.mes;
    // Match this host's setOpenAIMessages exactly. Source text stays literal:
    // if it already starts "Name: ", CONTENT intentionally adds a second one.
    const named = behavior === 2 && !narrator || behavior === 0
        && ((c.groupId && message.name !== c.name1)
            || (message.force_avatar && message.name !== c.name1 && !narrator));
    if (named) content = `${message.name}: ${content}`;
    return { role: narrator ? 'system' : message.is_user ? 'user' : 'assistant', content: content.replace(/\r/g, '') };
}

function processedHistoryText(message) {
    return normalize(text(message));
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
        const source = processedHistoryText(expectedHistoryEntry(raw));
        return source === t;
    });
}

function captureProcessedHistory(manager, chat, dryRun = false) {
    if (dryRun) return;
    const previous = currentProcessedHistory();
    if (!Array.isArray(chat)) return;
    const source = generationHistorySnapshot;
    if (!source) {
        // Helper generations do not pass the native coreChat interceptor. Do not
        // erase confirmed main provenance while its SETTINGS event is pending.
        // A different helper prompt still cannot match that complete sequence.
        if (nativeHistoryInterceptorSupported && !previous) processedHistorySnapshot = { chatId: ctx().getCurrentChatId(), entries: [], requiredRoles: [] };
        return;
    }
    if (!previous) processedHistorySnapshot = { chatId: source.chatId, entries: [], requiredRoles: [] };
    if (source.blocked) { source.pending = false; return; }
    try {
        const collections = manager?.messages?.getCollection?.();
        const history = collections?.find(collection => collection?.identifier === 'chatHistory');
        const messages = history?.getCollection?.();
        if (!Array.isArray(messages)) return;
        // Tool history is unsupported only while it survives native budgeting.
        // An old tool invocation outside the final prompt must not block forever.
        if (messages.some(message => message?.role === 'tool' || message?.tool_calls || message?.tool_call_id)
            || chat.some(message => message?.role === 'tool' || message?.tool_calls || message?.tool_call_id)) return;
        const entries = messages.filter(message => /^chatHistory-\d+$/.test(message?.identifier)
            && ['user', 'assistant'].includes(message.role) && typeof message.content === 'string'
            && !message.tool_calls && !message.tool_call_id)
            .map(message => ({ role: message.role, content: message.content }));
        const located = alignHistorySequence(entries, source.entries, undefined, true);
        if (!located) return;
        const selected = source.entries.slice(located.sourceStart);
        const requiredRoles = [...new Set(source.entries.map(item => item.role))];
        const prepared = alignHistorySequence(chat, selected, requiredRoles, true);
        if (!prepared) return;
        source.pending = false;
        processedHistorySnapshot = { chatId: source.chatId, entries: selected, requiredRoles };
        // The native budget may retain only an official suffix. Authenticate the
        // complete retained sequence, including its offset in the official core;
        // never infer identity for a partially matched prepared sequence.
        const identityCandidate = prepared.sourceStart === 0 && source.identityGroups.length < 8;
        if (identityCandidate) {
            const group = { count: selected.length, sourceStart: located.sourceStart };
            source.identityGroups.push(group);
            prepared.positions.forEach((position, index) => {
                const message = chat[position], witnesses = source.identityWitnesses.get(message) ?? [];
                // A later helper can share these objects while using less history.
                // Keep earlier proofs so its suffix cannot revoke the main range.
                witnesses.push({ group, index, role: selected[index].role });
                source.identityWitnesses.set(message, witnesses);
            });
        }
        noteGenerationEvent('processed-confirmed', { entries: selected.length, identityCandidate });
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

function alignHistorySequence(chat, entries, requiredRoles = [...new Set(entries.map(item => item.role))], uniqueSequence = false) {
    if (!entries.length) return null;
    const index = { user: new Map(), assistant: new Map() };
    for (let i = 0; i < chat.length; i++) {
        const message = chat[i], byText = index[message.role];
        if (!byText) continue;
        const canonical = processedHistoryText(message);
        if (!canonical) continue;
        if (!byText.has(canonical)) byText.set(canonical, []);
        byText.get(canonical).push(i);
    }
    const expected = entries.map(item => ({ role: item.role, text: processedHistoryText(item) }));
    const previous = (positions, before) => {
        let lo = 0, hi = positions.length;
        while (lo < hi) { const mid = (lo + hi) >>> 1; if (positions[mid] < before) lo = mid + 1; else hi = mid; }
        return positions[lo - 1];
    };
    const next = (positions, after) => {
        let lo = 0, hi = positions.length;
        while (lo < hi) { const mid = (lo + hi) >>> 1; if (positions[mid] <= after) lo = mid + 1; else hi = mid; }
        return positions[lo];
    };
    const positions = [], roles = new Set();
    let before = chat.length, sourceStart = entries.length;
    for (let i = entries.length - 1; i >= 0; i--) {
        const item = expected[i], matching = item.text ? index[item.role]?.get(item.text) ?? [] : [];
        const position = previous(matching, before);
        if (position === undefined) break; // Native budgeting can drop an older prefix.
        before = position; positions.push(before); roles.add(item.role); sourceStart = i;
    }
    if (!positions.length || requiredRoles.some(role => !roles.has(role))) return null;
    // Repeated real short turns (e.g. "continue") are constrained by their full
    // neighboring turns. Accept only when earliest and latest valid alignments
    // have the same boundaries; a full quote outside history remains ambiguous.
    let after = -1, first;
    const earliest = [];
    for (let i = sourceStart; i < expected.length; i++) {
        const item = expected[i], position = next(index[item.role]?.get(item.text) ?? [], after);
        if (position === undefined) return null;
        if (first === undefined) first = position;
        after = position; earliest.push(position);
    }
    const start = positions.at(-1), end = positions[0];
    if (first !== start || after !== end) return null;
    if (uniqueSequence) {
        const ordered = positions.slice().reverse();
        if (earliest.some((position, i) => position !== ordered[i])) return null;
        return { start, end, sourceStart, positions: ordered };
    }
    return { start, end, sourceStart };
}

function locateHistorySequence(chat, entries, requiredRoles) {
    const aligned = alignHistorySequence(chat, entries, requiredRoles);
    return aligned ? { start: aligned.start, end: aligned.end } : null;
}

/**
 * 找出提示词里真正的聊天记录范围。很多预设在聊天记录前放伪造的 user/assistant 对话、规则和资料，
 * 不能把「第一条非 system 消息」当成聊天记录的开头，所以拿真实聊天消息逐条比对。
 */
function findRawHistoryRange(chat) {
    const entries = (ctx().chat ?? []).filter(message => message && !message.is_system
        && typeof message.mes === 'string' && message.mes.trim() && message.extra?.type !== 'narrator')
        .map(expectedHistoryEntry);
    return locateHistorySequence(chat, entries);
}

function findHistoryRange(chat) {
    const snapshot = currentProcessedHistory();
    return snapshot ? locateHistorySequence(chat, snapshot.entries, snapshot.requiredRoles)
        : findRawHistoryRange(chat);
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
        if (chat[i].role === 'system' && !isTopBlock(chat[i])
            && (isMovableDynamic(chat[i]) || !settings().preserveStructure && !isProtectedMessage(chat[i]))) moved.unshift(...chat.splice(i, 1));
    }
    // 聊天记录之前的易变块（柏宝书历史摘要、学到的易变块、现场调整出来的动态世界书块）
    for (let i = start - 1; i >= 0; i--) {
        if (chat[i].role === 'system' && !isTopBlock(chat[i])
            && isMovableDynamic(chat[i])) moved.unshift(...chat.splice(i, 1));
    }
    if (!moved.length) return 0;

    const at = chat.indexOf(anchor);
    // 认出了聊天记录：放在它之后；否则放在最后一条用户消息之前
    chat.splice(at + 1, 0, ...moved);
    return moved.length;
}

/** 只拆来源明确、成对完整的 system 包裹；绝不按用户正文或单个变量值猜测来源。 */
function splitKnownDynamicBlocks(chat) {
    const range = findHistoryRange(chat);
    if (!range) return;
    for (let i = range.end - 1; i >= 0; i--) {
        const message = chat[i];
        if (message.role !== 'system' || typeof message.content !== 'string' || isTopBlock(message)
            || Object.keys(message).some(key => !['role', 'content'].includes(key))) continue;
        const patterns = [RUNTIME_SYSTEM_RECORDS.source];
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

/** 历史末尾之前，同一唯一标题的 system 块两次改变才学习；保护规则和顶端块除外。 */
function learnFrom(chat) {
    const s = settings();
    if (!s.learn) return [];
    const chatId = ctx().getCurrentChatId();
    const scopeKey = learningScopeKey();
    if (lastSystemBlocks?.scopeKey !== scopeKey) changeCounts.clear();
    const range = findHistoryRange(chat);
    const firstTurn = chat.findIndex(m => m.role !== 'system');
    const stop = range ? range.end : (firstTurn < 0 ? chat.length : firstTurn);
    // 顶端设定块随场景变化是预期内的，不能学成易变块挪走
    const blocks = chat.slice(0, stop).filter(m => m.role === 'system' && !isTopBlock(m)
        && !isProtectedMessage(m)).map(m => ({ head: headOf(m), body: text(m) }));
    const learned = [];
    if (lastSystemBlocks && lastSystemBlocks.scopeKey === scopeKey) {
        // A head is only an identifier when it occurs once on both sides.
        // Collapsing duplicate heads into a Map compares separate fixed blocks.
        const unique = list => {
            const counts = new Map();
            for (const b of list) counts.set(b.head, (counts.get(b.head) ?? 0) + 1);
            return new Map(list.filter(b => counts.get(b.head) === 1).map(b => [b.head, b.body]));
        };
        const prev = unique(lastSystemBlocks.blocks), current = unique(blocks);
        for (const head of changeCounts.keys()) if (!prev.has(head) || !current.has(head)) changeCounts.delete(head);
        for (const [head, body] of current) {
            const b = { head, body };
            if (b.head.length < 4 || !prev.has(b.head) || prev.get(b.head) === b.body || isVolatileHead(b.head)) continue;
            // 大块（整本世界书之类）挪到聊天记录之后，每轮整块按原价算，比偶尔变一次贵得多
            if (b.body.length > MAX_LEARN_CHARS) continue;
            // 偶发一次变化（改设置、换预设、脚本改了一次变量）不算，第二次变才学
            const seen = (changeCounts.get(b.head) ?? 0) + 1;
            changeCounts.set(b.head, seen);
            if (seen < 2) continue;
            learned.push(b.head);
        }
        if (learned.length) {
            rememberLearnedHeads([...learnedHeadsForScope(), ...learned]);
            save();
        }
    }
    lastSystemBlocks = { chatId, scopeKey, blocks };
    return learned;
}

function forgetLearned() {
    settings().learnedHeads = [];
    settings().learnedByScope = {};
    changeCounts.clear();
    lastSystemBlocks = null;
    save();
    renderLearned();
}

function onPromptReady(data) {
    if (!isVertexConnection()) { clearGenerationScope(); return; }
    armFinalHook();
    if (data?.dryRun) return;
    captureProcessedHistory(nativeOpenAIModule?.promptManager, data?.chat, data?.dryRun);
    if (generationScope?.type === 'continue') {
        lastRun = '本次保守跳过：continue / assistant prefill 的末尾结构暂不支持重排。';
        $('#cacheopt_last').text(lastRun);
        return;
    }
    if (!settings().enabled || !Array.isArray(data?.chat)) return;
    if (!isMainGenerationScope()) {
        if (generationScope && !generationScope.dryRun && !generationScope.auxiliary
            && ['normal', 'regenerate', 'swipe'].includes(generationScope.type) && !generationScope.confirmed) reportHistorySkip('未收到当前宿主历史来源');
        return;
    }
    if (!findHistoryRange(data.chat)) {
        // A raw database helper can emit PROMPT_READY while main provenance is
        // pending or already consumed. Defer an ambiguous failure until a typed
        // main SETTINGS so helper prompts never replace the main report.
        return;
    }
    // This event has no generation type. Raw helpers may contain the complete
    // same history, so only observe provenance here; mutate typed main SETTINGS.
    lastRun = `${new Date().toLocaleTimeString()} 已确认宿主历史来源，等待正文请求的最终处理。`;
    $('#cacheopt_last').text(lastRun);
    renderLearned();
}

function reportHistorySkip(reason) {
    lastRun = `本次保守跳过：${reason}；请更新酒馆和插件后刷新，检查聊天可见楼层及提示词加工。`;
    $('#cacheopt_last').text(lastRun);
}

function identityFinalHistory(chat, source) {
    const candidates = source.identityGroups.map(group => ({ group, positions: new Map(), valid: true }));
    const byGroup = new Map(candidates.map(candidate => [candidate.group, candidate]));
    const observed = [];
    for (let position = 0; position < chat.length; position++) {
        const message = chat[position], witnesses = source.identityWitnesses.get(message) ?? [];
        for (const witness of witnesses) {
            const candidate = byGroup.get(witness.group);
            if (!candidate) continue;
            observed.push({ index: witness.group.sourceStart + witness.index, position });
            if (message.role !== witness.role || typeof message.content !== 'string' || !message.content.trim()
                || candidate.positions.has(witness.index)) candidate.valid = false;
            candidate.positions.set(witness.index, position);
        }
    }
    const valid = candidates.filter(candidate => candidate.valid && candidate.positions.size === candidate.group.count)
        .map(candidate => ({ sourceStart: candidate.group.sourceStart,
            positions: Array.from({ length: candidate.group.count }, (_, index) => candidate.positions.get(index)) }))
        .filter(candidate => candidate.positions.every((position, index, positions) => position !== undefined && (index === 0 || position > positions[index - 1])))
        .sort((a, b) => a.sourceStart - b.sourceStart);
    if (!valid.length) return null;
    // Shared-object suffix proofs are compatible with a complete main proof.
    // Independent histories in the same final request remain ambiguous.
    const chosen = valid[0], positions = chosen.positions;
    if (valid.some(candidate => candidate.positions.some((position, index) =>
        positions[candidate.sourceStart - chosen.sourceStart + index] !== position))) return null;
    // A surviving older witness cannot silently become a fixed pre-history block
    // merely because another proof authenticated a shorter budgeted suffix.
    if (observed.some(witness => witness.index < chosen.sourceStart
        || positions[witness.index - chosen.sourceStart] !== witness.position)) return null;
    const entries = positions.map(position => ({ role: chat[position].role, content: chat[position].content }));
    // New quoted messages are not given identity. They also cannot create a
    // second text alignment that would enlarge the authenticated range later.
    const aligned = alignHistorySequence(chat, entries, undefined, true);
    if (!aligned || aligned.sourceStart !== 0 || aligned.positions.some((position, index) => position !== positions[index])) return null;
    return { entries, start: positions[0], end: positions.at(-1) };
}

function confirmFinalHistory(chat) {
    const source = generationHistorySnapshot;
    processedHistorySnapshot = { chatId: ctx().getCurrentChatId(), entries: [], requiredRoles: [] };
    if (!source || source.blocked || source.chatId !== ctx().getCurrentChatId()
        || chat.some(message => message?.role === 'tool' || message?.tool_calls || message?.tool_call_id)) {
        noteGenerationEvent('history-unconfirmed', { entries: source?.entries.length ?? 0, messages: chat.length });
        return false;
    }
    if (source.identityGroups.length) {
        const identity = identityFinalHistory(chat, source);
        if (!identity) {
            noteGenerationEvent('identity-final-unconfirmed', { entries: source.entries.length, messages: chat.length });
            return false;
        }
        processedHistorySnapshot = { chatId: source.chatId, entries: identity.entries,
            requiredRoles: [...new Set(identity.entries.map(item => item.role))] };
        noteGenerationEvent('identity-final-confirmed', { entries: identity.entries.length, messages: chat.length,
            start: identity.start, end: identity.end });
        return true;
    }
    // Only SETTINGS carries the generation type. Re-align the complete official
    // core here, so an earlier untyped helper's smaller budget cannot shorten the
    // main history boundary or turn older dynamic material into a fixed rule.
    const located = alignHistorySequence(chat, source.entries);
    if (!located) { noteGenerationEvent('history-unconfirmed', { entries: source.entries.length, messages: chat.length }); return false; }
    const entries = source.entries.slice(located.sourceStart);
    processedHistorySnapshot = { chatId: source.chatId, entries, requiredRoles: [...new Set(entries.map(item => item.role))] };
    noteGenerationEvent('history-confirmed', { entries: entries.length, messages: chat.length, start: located.start, end: located.end });
    return true;
}

function onSettingsReady(data) {
    if (!isVertexConnection()) { clearGenerationScope(); return; }
    noteGenerationEvent('settings', { suppliedType: diagnosticGenerationType(data?.type), vertex: data?.chat_completion_source === 'vertexai' });
    if (!settings().enabled || !Array.isArray(data?.messages)
        || data.chat_completion_source !== 'vertexai'
        || !['normal', 'regenerate', 'swipe'].includes(data.type)) return;
    if (!isMainGenerationScope()) {
        if (!generationScope || !generationScope.dryRun && !generationScope.auxiliary
            && ['normal', 'regenerate', 'swipe'].includes(generationScope.type)) reportHistorySkip('未收到当前宿主历史来源');
        return;
    }
    if (generationScope.settingsHandled) return;
    if (!confirmFinalHistory(data.messages)) { reportHistorySkip('无法确认真实历史'); return; }
    generationScope.settingsHandled = true;
    splitKnownDynamicBlocks(data.messages);
    const learned = learnFrom(data.messages);
    const n = reorder(data.messages);
    const unsupported = ['tools', 'functions'].some(key => data[key] != null && (!Array.isArray(data[key]) || data[key].length))
        || ['tool_choice', 'function_call', 'response_format', 'json_schema'].some(key => data[key] != null);
    const fixed = unsupported ? { blocks: 0, entries: 0, chars: 0 } : hoistProvenStaticLore(data.messages);
    lastRun = `${new Date().toLocaleTimeString()} 最终请求重排：移动了 ${n} 个块`
        + (fixed.blocks ? `；常驻世界书前移 ${fixed.entries} 条（${fixed.chars} 字，保留 system 角色）` : '')
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
        '仅记录 Vertex 正文请求；数据库辅助请求保持原调用。实际缓存以 API 返回 cachedContentTokenCount 为准，缺失时为“未知”，不能当成 0。',
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
// A failed attempt leaves the comparison baseline, but remains the latest UI
// owner so an older response cannot replace its failure report.
let latestRealAttempt = null;

/** Complete runtime records produced by this card's scripts, after template rendering.
 * Rules merely mentioning fortune or a current turn are not runtime provenance.
 */
function splitRuntimeSystemRecords(messages) {
    let converted = 0;
    const result = messages.flatMap(message => {
        if (message.role !== 'system') return [message];
        const matches = [...message.content.matchAll(RUNTIME_SYSTEM_RECORDS)];
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
    if (body?.type === 'continue') return skip('continue-prefill');
    if (!['normal', 'regenerate', 'swipe'].includes(body?.type) || body?.[ACU_INTERNAL]) return skip('non-main');
    if (body.chat_completion_source !== 'vertexai'
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
        ? `Vertex 固定头强化：${report.mergedSystems} 条 system 集中为固定头 ${report.fixedHeadChars.toLocaleString()} 字，原位保留 ${report.fixedPlaceholders} 个固定标记，后部 ${report.convertedSystems} 条 system 转为 user（角色和规则顺序已调整；非缓存命中率）`
        : `Vertex 固定头强化：本次保守跳过（${report.reason}）`;
}

function requestInitWithBody(init, body) {
    const forwarded = Object.create(null);
    Object.defineProperty(forwarded, 'body', { value: body, enumerable: true, configurable: true, writable: true });
    // Fetch reads RequestInit dictionary members directly, including members a
    // Proxy supplies without listing them in ownKeys. Keep the original receiver
    // for class/private-field getters; use a separate target so an immutable
    // original body does not impose Proxy invariants on the replacement body.
    return new Proxy(forwarded, {
        get(target, key, receiver) {
            return Object.hasOwn(target, key) ? Reflect.get(target, key, receiver) : Reflect.get(init, key, init);
        },
        has: (target, key) => Reflect.has(target, key) || Reflect.has(init, key),
        ownKeys: target => [...new Set([...Reflect.ownKeys(target), ...Reflect.ownKeys(init)])],
        getOwnPropertyDescriptor(target, key) {
            const own = Reflect.getOwnPropertyDescriptor(target, key);
            if (own) return own;
            const descriptor = Reflect.getOwnPropertyDescriptor(init, key);
            return descriptor ? { configurable: true, enumerable: descriptor.enumerable, get: () => Reflect.get(init, key, init) } : undefined;
        },
    });
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
    if (!isVertexConnection()) return null;
    let body;
    try { body = JSON.parse(rawBody); } catch { return null; }
    if (!body || body.chat_completion_source !== 'vertexai' || !Array.isArray(body.messages)
        || !['normal', 'regenerate', 'swipe'].includes(body.type) || body[ACU_INTERNAL]) return null;
    // Read-only API usage does not require permission to rewrite history. The
    // fetch boundary separately rejects marked database helpers and other URLs.
    const historyConfirmed = !!findHistoryRange(body.messages);
    const chatId = ctx().getCurrentChatId?.() ?? '';
    const now = Date.now();
    const channel = JSON.stringify([body.chat_completion_source, body.model, body.type, body.reverse_proxy, body.custom_url]);
    const history = ctx().chat ?? [];
    const cur = { chatId, channel, at: now, body, texts: messageTexts(body), historyConfirmed, history: historyConfirmed ? {
        count: history.length, userCount: history.filter(m => m.is_user).length,
        lastUser: history.findLast(m => m.is_user)?.mes ?? '',
    } : null };
    const candidates = recentReal.filter(r => r.chatId === chatId && r.channel === channel);
    if (candidates.length) {
        const previous = candidates.at(-1);
        const report = previous.historyConfirmed && cur.historyConfirmed
            ? describeReal(previous, cur, Math.round((now - previous.at) / 1000))
            : `${new Date().toLocaleTimeString()}｜相邻 Vertex 请求的真实历史未确认，保守跳过前缀比较；仍观察本次 API 返回的缓存用量。`;
        settings().lastRealReport = report;
        save();
        $('#cacheopt_real').text(report);
        console.info('[缓存优化] 真实发送对比\n' + report);
    }
    recentReal = [...recentReal.filter(r => r.chatId === chatId), cur].slice(-RECENT_LIMIT);
    latestRealAttempt = cur;
    noteGenerationEvent('fetch-observed', { suppliedType: diagnosticGenerationType(body.type), historyConfirmed });
    $('#cacheopt_usage').text(`${body.model ?? '当前正文模型'}｜API 缓存统计：等待响应…`);
    return cur;
}

const CACHE_USAGE_FIELDS = ['cachedContentTokenCount', 'cached_content_token_count',
    'prompt_tokens_details.cached_tokens', 'input_tokens_details.cached_tokens',
    'cache_read_input_tokens', 'total_cached_tokens', 'prompt_cache_hit_tokens'];
const INPUT_USAGE_FIELDS = ['promptTokenCount', 'prompt_token_count', 'toolUsePromptTokenCount',
    'tool_use_prompt_token_count', 'prompt_tokens', 'input_tokens', 'total_input_tokens', 'cache_creation_input_tokens'];
const usageNumber = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;

function extractUsageSnapshot(payload, previousProtocol = null, eventType = '') {
    if (!payload || typeof payload !== 'object') return null;
    const prefixes = ['usageMetadata', 'usage_metadata', 'message.usage', 'response.usage', 'usage'];
    const get = path => path.split('.').reduce((object, key) => object?.[key], payload);
    const prefix = prefixes.find(path => get(path) && typeof get(path) === 'object');
    if (!prefix) return null;
    const raw = get(prefix), values = {}, sources = {};
    const canonical = { cached_content_token_count: 'cachedContentTokenCount', prompt_token_count: 'promptTokenCount', tool_use_prompt_token_count: 'toolUsePromptTokenCount' };
    for (const field of [...CACHE_USAGE_FIELDS, ...INPUT_USAGE_FIELDS]) {
        const value = field.split('.').reduce((object, key) => object?.[key], raw);
        if (!usageNumber(value)) continue;
        const key = canonical[field] ?? field;
        if (key in values) continue;
        values[key] = value;
        sources[key] = `${prefix}.${field}`;
    }
    const cache = CACHE_USAGE_FIELDS.map(field => canonical[field] ?? field).find(field => usageNumber(values[field]));
    if (cache) { values.cached = values[cache]; sources.cached = sources[cache]; }
    const type = payload.type || eventType;
    let protocol = previousProtocol ?? 'openai';
    if (/^usage[M_]/.test(prefix) || ['promptTokenCount', 'cachedContentTokenCount'].some(key => key in values)) protocol = 'gemini';
    else if (prefix === 'response.usage') protocol = 'openai';
    else if (prefix === 'message.usage' || /^message_(?:start|delta|stop)$/.test(type)
        || ['cache_read_input_tokens', 'cache_creation_input_tokens'].some(key => key in values)) protocol = 'anthropic';
    else if ('prompt_tokens' in values || 'input_tokens_details.cached_tokens' in values) protocol = 'openai';
    const inclusive = (protocol === 'anthropic' ? ['total_input_tokens', 'prompt_tokens']
        : protocol === 'openai' ? ['prompt_tokens', 'input_tokens', 'total_input_tokens'] : []).find(key => key in values);
    if (inclusive) { values.inclusive_input = values[inclusive]; sources.inclusive_input = sources[inclusive]; }
    return { protocol, values, sources };
}

function mergeUsageSnapshot(previous, update) {
    if (!update) return previous;
    if (!previous || previous.protocol !== update.protocol) return update;
    return { protocol: update.protocol, values: { ...previous.values, ...update.values }, sources: { ...previous.sources, ...update.sources } };
}

function calculateUsage(snapshot) {
    if (!snapshot) return null;
    const { values, sources, protocol } = snapshot;
    const first = fields => fields.find(field => usageNumber(values[field]));
    const cachedField = first(['cached']);
    const cached = cachedField ? values[cachedField] : null;
    let total = null, inputFields = [], formula = '';
    if (protocol === 'gemini') {
        const prompt = first(['promptTokenCount', 'prompt_token_count']);
        const tool = first(['toolUsePromptTokenCount', 'tool_use_prompt_token_count']);
        if (prompt) {
            inputFields = [prompt, ...(tool ? [tool] : [])];
            total = inputFields.reduce((sum, field) => sum + values[field], 0);
            formula = inputFields.map(field => sources[field]).join(' + ');
        }
    } else if (protocol === 'anthropic') {
        const explicit = first(['inclusive_input']);
        if (explicit) { total = values[explicit]; inputFields = [explicit]; formula = sources[explicit]; }
        else {
            inputFields = ['input_tokens', 'cached', 'cache_creation_input_tokens'].filter(field => usageNumber(values[field]));
            if (inputFields.length === 3) {
                total = inputFields.reduce((sum, field) => sum + values[field], 0);
                formula = inputFields.map(field => sources[field]).join(' + ');
            }
        }
    } else {
        const input = first(['inclusive_input']);
        if (input) { total = values[input]; inputFields = [input]; formula = sources[input]; }
    }
    if (cached === null && total === null) return null;
    return { cached, total, cachedField, inputFields, formula, inconsistent: cached !== null && total !== null && cached > total };
}

/** Protocol input totals already include cache except Anthropic's native separate buckets. */
function readUsage(payload) {
    const value = calculateUsage(extractUsageSnapshot(payload));
    return value ? { cached: value.cached, total: value.total } : null;
}

function identifiedUsageFields(payload) {
    const snapshot = extractUsageSnapshot(payload);
    return snapshot ? CACHE_USAGE_FIELDS.filter(field => field in snapshot.values)
        .map(field => `${snapshot.sources[field]} = ${snapshot.values[field]}`) : [];
}

function describeUsageSources(snapshot, usage) {
    if (!snapshot || !usage) return '响应未返回已识别的输入或缓存数字字段';
    const fields = [usage.cachedField, ...usage.inputFields].filter(Boolean);
    return [...new Set(fields)].map(field => `${snapshot.sources[field]} = ${snapshot.values[field]}`)
        .concat(usage.formula ? [`输入分母 = ${usage.formula} = ${usage.total}`] : ['输入分母未知']).join('\n');
}

async function observeUsage(response, request) {
    if (!request || !response.ok) return;
    let snapshot = null, complete = false, failedAttempt = false, incompleteReason = '响应读取失败';
    try {
        const copy = response.clone();
        const isProviderError = (payload, type = '') => payload?.error != null || payload?.response?.error != null
            || [type, payload?.type].some(value => ['error', 'response.failed', 'response.incomplete'].includes(value));
        const markProviderError = () => { failedAttempt = true; incompleteReason = '接口返回错误事件'; };
        const accept = (payload, type = '') => {
            snapshot = mergeUsageSnapshot(snapshot, extractUsageSnapshot(payload, snapshot?.protocol, type));
        };
        // 酒馆透传流式响应时可能没有 Content-Type；请求本身也能确认 SSE 模式。
        if (request.body?.stream === true || (copy.headers.get('content-type') ?? '').includes('text/event-stream')) {
            const reader = copy.body.getReader();
            const decoder = new TextDecoder();
            const maxEventChars = 4 * 1024 * 1024;
            let buffer = '', data = [], eventType = '', eventChars = 0, stopped = false;
            const line = value => {
                if (value === '') {
                    const payload = data.join('\n').trim();
                    if (isProviderError(null, eventType)) { stopped = true; markProviderError(); }
                    else if (payload === '[DONE]') { stopped = true; complete = true; }
                    else if (payload && payload !== 'ping' && eventType !== 'ping') {
                        try {
                            const parsed = JSON.parse(payload);
                            if (isProviderError(parsed)) {
                                stopped = true; markProviderError();
                            } else accept(parsed, eventType);
                        } catch { stopped = true; incompleteReason = 'SSE 数据事件无法解析'; }
                    }
                    data = []; eventType = ''; eventChars = 0;
                    return;
                }
                eventChars += value.length;
                if (eventChars > maxEventChars) { stopped = true; incompleteReason = 'SSE 事件过大，已停止观察'; return; }
                const colon = value.indexOf(':');
                const field = colon < 0 ? value : value.slice(0, colon);
                let content = colon < 0 ? '' : value.slice(colon + 1);
                if (content.startsWith(' ')) content = content.slice(1);
                if (field === 'data') data.push(content);
                if (field === 'event') eventType = content;
            };
            try {
                while (true) {
                    const { done, value } = await reader.read();
                    buffer += decoder.decode(value, { stream: !done });
                    let end;
                    while ((end = buffer.indexOf('\n')) >= 0) {
                        line(buffer.slice(0, end).replace(/\r$/, ''));
                        buffer = buffer.slice(end + 1);
                        if (stopped) break;
                    }
                    if (!stopped && buffer.length + eventChars > maxEventChars) { stopped = true; incompleteReason = 'SSE 事件过大，已停止观察'; }
                    if (stopped) { void reader.cancel().catch(() => {}); break; }
                    if (done) {
                        if (buffer || data.length) incompleteReason = 'SSE 事件未完整结束';
                        else complete = true;
                        break;
                    }
                }
            } catch (error) {
                if (error?.name === 'AbortError') {
                    failedAttempt = true;
                    incompleteReason = '响应已取消';
                }
                throw error;
            } finally { reader.releaseLock(); }
        } else {
            const payload = await copy.json();
            if (isProviderError(payload)) markProviderError();
            else { accept(payload); complete = true; }
        }
    } catch { /* 原响应继续交给酒馆；旁观失败不能被算作 0 */ }
    const latest = latestRealAttempt === request;
    if (failedAttempt) recordRequestFailure(request, false);
    if (ctx().getCurrentChatId?.() !== request.chatId || !latest) return;
    const usage = calculateUsage(snapshot);
    const ratio = usage?.cached !== null && usage?.cached !== undefined && usage?.total > 0 && !usage.inconsistent
        ? `（${(usage.cached / usage.total * 100).toFixed(1)}%）` : '';
    const report = `${request.body.model ?? '当前正文模型'}｜` + (complete
        ? `API 缓存 token：${usage?.cached ?? '未知（响应未返回缓存字段）'}`
            + `${usage?.total !== null && usage?.total !== undefined ? ` / 输入 ${usage.total}` : ''}`
            + (usage?.inconsistent ? '（统计不一致：缓存大于总输入）' : ratio)
        : `API 缓存统计：未完成（${incompleteReason}）；部分统计不作为最终结果。`);
    settings().lastUsageReport = report;
    save();
    $('#cacheopt_usage').text(report);
    $('#cacheopt_usage').attr('title', `${complete ? '' : '未完成，以下仅为部分字段\n'}${describeUsageSources(snapshot, usage)}`);
}

function recordRequestFailure(request, updateReport = true) {
    if (!request) return;
    const latest = latestRealAttempt === request;
    recentReal = recentReal.filter(r => r !== request);
    if (updateReport && latest && ctx().getCurrentChatId?.() === request.chatId) {
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
            const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input?.url, window.location.href);
            if (url.origin === window.location.origin && url.pathname === GENERATE_PATH) {
                // Inspect data descriptors only. Calling an accessor before fetch
                // would evaluate a one-shot body/method getter more than once.
                const unknownMember = Symbol('cacheopt-unreadable-member');
                const dataMember = key => {
                    for (let owner = init; owner; owner = Object.getPrototypeOf(owner)) {
                        const descriptor = Object.getOwnPropertyDescriptor(owner, key);
                        if (descriptor) return Object.hasOwn(descriptor, 'value') ? descriptor.value : unknownMember;
                    }
                };
                const bodyDescriptor = init && Object.getOwnPropertyDescriptor(init, 'body');
                const method = dataMember('method');
                // 数据库已公开的内存标记；辅助模型处理输入/召回，不纳入正文统计。
                if (typeof method === 'string' && method.toUpperCase() === 'POST' && !dataMember(ACU_INTERNAL)
                    && bodyDescriptor && Object.hasOwn(bodyDescriptor, 'value') && typeof bodyDescriptor.value === 'string') {
                    let rawBody = bodyDescriptor.value;
                    const body = JSON.parse(rawBody);
                    if (isVertexConnection() && body?.chat_completion_source === 'vertexai') {
                        if (settings().enabled && settings().compatGeminiProxy && isMainGenerationScope()) {
                            const report = applyGeminiProxyLayout(body);
                            if (report.applied) {
                                rawBody = JSON.stringify(body);
                                forwardedInit = requestInitWithBody(init, rawBody);
                            }
                            $('#cacheopt_last').text(`${lastRun}\n${describeGeminiLayout(report)}`);
                        }
                        request = recordRealRequest(rawBody);
                    }
                }
            }
        } catch { /* 只旁观，出错不影响请求 */ }
        return original.call(this, input, forwardedInit).then(response => {
            if (!response.ok) {
                try { recordRequestFailure(request); } catch { /* 旁观失败不改变原 HTTP 响应 */ }
            } else if (request) void observeUsage(response, request).catch(() => {});
            return response;
        }, error => {
            try { recordRequestFailure(request); } catch { /* 保留原请求异常 */ }
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
    $('#cacheopt_menu_label').text(`Vertex 缓存优化：${value ? '开' : '关'}`);
    $('#cacheopt_menu .extensionsMenuExtensionButton').css('opacity', value ? '' : '0.4');
}

function renderLearned() {
    const list = learnedHeadsForScope();
    $('#cacheopt_learned').text(list.length ? `当前聊天已学到的易变块（${list.length}）：${list.join(' / ')}` : '当前聊天已学到的易变块：暂无');
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
          <b>⚡ Vertex 缓存优化 2.6.7</b>
          <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
        </div>
        <div class="inline-drawer-content">
          <div class="cacheopt-hint">仅用于酒馆的 Vertex AI 渠道；其他渠道不整理请求、不记录统计，数据库辅助模型保持原调用。</div>
          <div class="cacheopt-hint">需要支持正式 generate_interceptor 历史钩子及带生成类型的最终设置事件。未确认宿主来源时跳过整理，不猜测历史。</div>
          <label class="checkbox_label"><input id="cacheopt_enabled" type="checkbox"> 启用 Vertex 缓存优化</label>
          <label class="checkbox_label"><input id="cacheopt_preserve" type="checkbox"> 保留预设结构（推荐）：保护示范对话、尾部规则和未知来源块的顺序与角色</label>
          <label class="checkbox_label"><input id="cacheopt_route" type="checkbox"> 世界书现场调整：关键词 / 会变的条目移到聊天中（不改文件）</label>
          <label class="checkbox_label"><input id="cacheopt_hoist" type="checkbox"> 常驻世界书智能前移：仅本轮已激活、无模板的字面设定，保留 system 角色</label>
          <div class="cacheopt-hint">结构保护开启时仅跨越已确认的真实历史；混合块中未知尾部、深度 0、数据库、格式规则和模板保持原位。合格条目的深度位置会提前，不改世界书文件或激活预算。</div>
          <label class="checkbox_label"><input id="cacheopt_shujuku" type="checkbox"> 数据库召回兼容：纪要、索引、表头和包裹移到当前历史之后</label>
          <label class="checkbox_label"><input id="cacheopt_izumi" type="checkbox"> 泉记忆功能兼容（仅使用该功能时开启）</label>
          <label class="checkbox_label"><input id="cacheopt_gemini_proxy" type="checkbox"> Vertex 固定头强化（实验）：固定规则集中到开头，动态资料留在后部</label>
          <div class="cacheopt-hint">固定头强化独立于结构保护：开启后仍会合并固定 system 并调整规则顺序，原位留下固定 user 标记，将后部 system 资料原位转为 user。默认关闭，实际收益以 API 缓存 token 为准。</div>
          <label class="checkbox_label"><input id="cacheopt_sticky" type="checkbox" disabled> 关键词前置保持（Vertex 渠道不适用，自动停用）
            <input id="cacheopt_sticky_turns" class="text_pole cacheopt-num" type="number" min="1" max="50" disabled> 条消息</label>
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
          <div class="cacheopt-hint">Vertex 真实发送对比（同聊天、同模型的相邻正文请求，排除已标记的数据库辅助请求）：</div>
          <div id="cacheopt_real" class="cacheopt-report">同一聊天连续发送两次后显示。</div>
          <div id="cacheopt_usage" class="cacheopt-report">Vertex API 缓存统计：尚未收到正文响应。没有返回统计时为未知。</div>
        </div>
      </div>
    </div>`;
    $('#extensions_settings2').append(html);
    $('#cacheopt_enabled').prop('checked', settings().enabled).on('input', function () { setEnabled(!!$(this).prop('checked')); });
    bindCheckbox('#cacheopt_preserve', 'preserveStructure');
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
    $('#cacheopt_forget').on('click', forgetLearned);
    $('#cacheopt_last').text(lastRun);
    // 不把旧版本的字符百分比或上次会话的 usage 当成本轮结果。
    renderLearned();

    // 魔法棒菜单（左下角）一键开关，结构与酒馆自带的菜单项一致
    const item = $(`<div id="cacheopt_wand_container" class="extension_container interactable" tabindex="0">
        <div id="cacheopt_menu" class="list-group-item flex-container flexGap5 interactable" tabindex="0" role="listitem" title="一键开关 Vertex 缓存优化">
          <div class="fa-solid fa-bolt extensionsMenuExtensionButton"></div><span id="cacheopt_menu_label"></span></div></div>`);
    item.on('click', () => {
        setEnabled(!settings().enabled);
        toastr.info(`Vertex 缓存优化已${settings().enabled ? '开启' : '关闭'}`, 'Vertex 缓存优化');
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
    c.eventSource.on(c.eventTypes.WORLDINFO_ENTRIES_LOADED, onWorldInfoEntriesLoaded);
    if (c.eventTypes.WORLD_INFO_ACTIVATED) c.eventSource.on(c.eventTypes.WORLD_INFO_ACTIVATED, onWorldInfoActivated);
    if (c.eventTypes.GENERATION_STARTED) c.eventSource.on(c.eventTypes.GENERATION_STARTED, onGenerationStarted);
    if (c.eventTypes.GENERATION_ENDED) c.eventSource.on(c.eventTypes.GENERATION_ENDED, onGenerationEnded);
    if (c.eventTypes.GENERATION_STOPPED) c.eventSource.on(c.eventTypes.GENERATION_STOPPED, onGenerationStopped);
    c.eventSource.on(c.eventTypes.CHAT_COMPLETION_PROMPT_READY, onPromptReady);
    armFinalHook();
});
