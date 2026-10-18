'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const source = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
const plain = value => value == null ? value : JSON.parse(JSON.stringify(value));

const core = () => [{ is_user: false, mes: '上一轮已经发生的独特真实叙述。' },
    { is_user: true, mes: '本轮独特的真实用户输入。' }];
const history = () => core().map(message => ({ role: message.is_user ? 'user' : 'assistant', content: message.mes }));
const lore = (overrides = {}) => ({ world: 'synthetic-static-world', uid: 1,
    content: '固定的山川设定。\n河流从山脉流向南方平原。', comment: 'Synthetic permanent geography',
    constant: true, disable: false, position: 4, depth: 1, role: 0, order: 100,
    vectorized: false, useProbability: true, probability: 100,
    sticky: 0, cooldown: 0, delay: 0, group: '', triggers: [], automationId: '', ...overrides });

function harness() {
    let chatId = 'static-lore-fixture';
    const host = { mainApi: 'openai', extensionSettings: {}, chat: core(),
        characterId: 0, characters: [{ avatar: 'synthetic-character.png' }], extensionPrompts: {},
        chatCompletionSettings: { chat_completion_source: 'vertexai', names_behavior: -1,
            prompts: [{ identifier: 'main', role: 'system', content: '固定预设源。' }] },
        getCurrentChatId: () => chatId, saveSettingsDebounced() {},
        eventTypes: { CHAT_COMPLETION_SETTINGS_READY: 'settings', WORLD_INFO_ACTIVATED: 'activated' },
        eventSource: { on() {}, removeListener() {}, makeLast() {} } };
    const chain = new Proxy({}, { get: () => () => chain });
    const sandbox = vm.createContext({ structuredClone, TextDecoder, URL, Response, ReadableStream, AbortController,
        setTimeout, clearTimeout, console: { info() {}, warn() {}, error() {}, debug() {} },
        window: {}, jQuery: () => chain, $: () => chain, SillyTavern: { getContext: () => host } });
    vm.runInContext(source, sandbox);
    const call = (name, ...args) => { sandbox.args = args; return vm.runInContext(`${name}(...args)`, sandbox); };
    return { host, call, evaluate: expression => vm.runInContext(expression, sandbox),
        switchChat() { chatId = 'another-static-lore-chat'; },
        start(entries = core(), type = 'normal', dryRun = false) {
            host.chat = structuredClone(entries);
            call('onGenerationStarted', type, {}, dryRun);
            if (!dryRun) call('captureGenerationHistory', entries, 100000, () => {}, type);
        },
        load(entries) { call('onWorldInfoEntriesLoaded', { globalLore: [], characterLore: [], chatLore: entries, personaLore: [] }); },
        activate(entries) { call('onWorldInfoActivated', entries); },
        assembled(value, depth = 1) {
            host.extensionPrompts[`customDepthWI_${depth}_0`] = { value, depth, role: 0, position: 1 };
        },
        prompt(chat) {
            sandbox.manager = { messages: { getCollection: () => [{ identifier: 'chatHistory',
                getCollection: () => chat.map((message, index) => ({ ...message, identifier: `chatHistory-${index}` })) }] } };
            vm.runInContext('nativeOpenAIModule = { promptManager: manager }', sandbox);
            call('onPromptReady', { chat, dryRun: false });
        },
        confirm(chat) { return call('confirmFinalHistory', chat); },
        hoist(chat) { return call('hoistProvenStaticLore', chat); },
        final(chat) { call('onSettingsReady', { type: 'normal', chat_completion_source: 'vertexai', messages: chat }); },
    };
}

function prepared({ entries = [lore()], activated = entries, value = entries.map(entry => entry.content).join('\n'),
    content = value, metadata = {}, coreEntries = core(), messages } = {}) {
    const h = harness(); h.start(coreEntries); h.load(entries); h.activate(activated); h.assembled(value);
    const actual = history();
    const chat = messages ?? [{ role: 'system', content: '固定预设首规则。' }, actual[0],
        { role: 'system', content, ...metadata }, actual[1]];
    h.prompt(chat);
    assert.equal(h.confirm(chat), true, 'fixture must first authenticate the real native history');
    return { h, chat, entries, value };
}

const unchanged = (h, chat, label) => {
    const before = structuredClone(chat), references = chat.slice();
    const result = h.hoist(chat);
    assert.equal(result.blocks, 0, label);
    assert.deepEqual(chat, before, label);
    assert.ok(chat.every((message, index) => message === references[index]), label);
};

test('an activated literal permanent depth-system entry can cross only its authenticated history', () => {
    const entry = lore(), actual = history();
    const pseudoUser = { role: 'user', content: '固定的预设示范问题。', name: 'example_user' };
    const pseudoAssistant = { role: 'assistant', content: '固定的预设示范回答。', signature: 'synthetic-demo-signature' };
    actual[0].signature = 'synthetic-history-signature';
    const fixed = { role: 'system', content: '伪对话之后、真实历史之前的固定规则。' };
    const system = { role: 'system', content: entry.content };
    const chat = [{ role: 'system', content: '固定首规则。' }, pseudoUser, pseudoAssistant, fixed,
        actual[0], system, actual[1], { role: 'system', content: '末尾格式规则保持原位。' }];
    const beforeNonSystem = chat.filter(message => message.role !== 'system').slice();
    const { h } = prepared({ entries: [entry], messages: chat });
    assert.equal(h.call('settings').preserveStructure, true);
    const report = h.hoist(chat);
    assert.equal(report.blocks, 1); assert.equal(report.entries, 1); assert.ok(report.chars >= entry.content.length);
    assert.deepEqual(chat.slice(0, 4), [{ role: 'system', content: '固定首规则。' }, pseudoUser, pseudoAssistant, fixed]);
    assert.equal(chat[4].content, entry.content); assert.equal(chat[4].role, 'system');
    assert.equal(chat[5], actual[0]);
    assert.deepEqual(chat.filter(message => message.role !== 'system'), beforeNonSystem);
    assert.ok(chat.filter(message => message.role !== 'system').every((message, index) => message === beforeNonSystem[index]));
    assert.equal(chat.filter(message => message.content === entry.content).length, 1);
    assert.equal(JSON.stringify(chat).includes('__cacheopt'), false);
});

test('a proven literal prefix is extracted once while a mixed template-derived tail stays verbatim in place', () => {
    const first = lore({ uid: 11, content: '<fixed-geography>\n第一条常驻世界设定。\n</fixed-geography>' });
    const second = lore({ uid: 12, order: 200, content: '第二条常驻世界规则。\n这个规则没有模板。' });
    const dynamic = lore({ uid: 13, order: 300, content: '当前变量。\n{{getvar::current_state}}' });
    const stable = `${first.content}\n${second.content}`;
    const tail = '\n当前变量。\n本轮已经展开的动态值。';
    const value = stable + tail;
    const { h, chat } = prepared({ entries: [first, second, dynamic], value });
    const originalNonSystem = chat.filter(message => message.role !== 'system');
    const report = h.hoist(chat);
    assert.equal(report.blocks, 1); assert.equal(report.entries, 2);
    const lifted = chat[1], remainder = chat[3];
    assert.equal(lifted.role, 'system'); assert.ok(lifted.content.startsWith(stable));
    assert.equal(remainder.role, 'system');
    assert.equal(lifted.content + remainder.content, value, 'no separator may be trimmed or invented');
    assert.ok(remainder.content.includes('本轮已经展开的动态值。'));
    assert.ok(!lifted.content.includes('本轮已经展开的动态值。'));
    assert.equal(chat.filter(message => message.role !== 'system')[0], originalNonSystem[0]);
    assert.equal(chat.filter(message => message.role !== 'system')[1], originalNonSystem[1]);
    for (const entry of [first, second]) assert.equal(chat.map(message => message.content).join('').split(entry.content).length - 1, 1);
});

test('a static entry after an unknown leading part of the assembled value is never promoted', () => {
    const entry = lore();
    const { h, chat } = prepared({ entries: [entry], value: `未知来源的前导规则。\n${entry.content}` });
    unchanged(h, chat, 'only a completely proved prefix may move');
});

test('source ownership and every conditional or templated entry veto static promotion', () => {
    const invalid = [
        ['not-constant', { constant: false }], ['disabled', { disable: true }],
        ['wrong-position', { position: 0 }], ['depth-zero', { depth: 0 }], ['assistant-role', { role: 1 }],
        ['user-role', { role: 2 }], ['probability', { probability: 99 }], ['vector', { vectorized: true }],
        ['sticky', { sticky: 1 }], ['cooldown', { cooldown: 1 }], ['delay', { delay: 1 }],
        ['recursion-delay', { delayUntilRecursion: 1 }],
        ['character-filter', { characterFilter: { names: ['conditional-character'], isExclude: false } }],
        ['group', { group: 'conditional-source' }], ['trigger', { triggers: ['normal'] }],
        ['automation', { automationId: 'synthetic-automation' }],
        ['ordinary-macro', { content: '固定标题。\n{{getvar::state}}' }],
        ['ejs', { content: '固定标题。\n<%= stableConfiguration %>' }],
        ['database-template', { content: '固定标题。\n{[ db recall ]}' }],
        ['database-origin', { comment: 'TavernDB-ACU-GlobalRead' }],
        ['optional-memory-origin', { content: '<!-- IZM7_fixture -->\n<KonataExtraInformation>回忆。</KonataExtraInformation>' }],
        ['runtime-record', { content: '【本轮江湖介入】启用后第4轮；实际玩家回合序号4，玩家楼层7。每轮独立处理，同轮续写不新开第二个事件。' }],
        ['protected-name', { comment: 'output_format' }], ['protected-content', { content: 'output_format\n固定输出结构。' }],
    ];
    for (const [label, override] of invalid) {
        const entry = lore(override), { h, chat } = prepared({ entries: [entry], value: entry.content });
        h.call('settings').compatShujuku = false;
        h.call('settings').compatIzumi = false;
        unchanged(h, chat, label);
    }
});

test('the source filter excludes owned database data even when compatibility was already disabled at load', () => {
    const h = harness(); h.call('settings').compatShujuku = false;
    const entry = lore({ comment: 'TavernDB-ACU-GlobalRead' }), chat = [history()[0], { role: 'system', content: entry.content }, history()[1]];
    h.start(); h.load([entry]); h.activate([entry]); h.assembled(entry.content); h.prompt(chat);
    assert.equal(h.confirm(chat), true); unchanged(h, chat, 'compatibility is not a static-origin authorization');
});

test('probability 100 remains deterministic and qualifies with either probability switch value', () => {
    for (const useProbability of [true, false]) {
        const { h, chat } = prepared({ entries: [lore({ useProbability, probability: 100 })] });
        assert.equal(h.hoist(chat).entries, 1);
    }
});

test('candidate text alone never replaces loaded source and same-round activation provenance', () => {
    for (const mode of ['no-loaded-source', 'not-activated', 'wrong-world', 'changed-content', 'changed-constant']) {
        const h = harness(), entry = lore(); h.start();
        if (mode !== 'no-loaded-source') h.load([entry]);
        const active = mode === 'not-activated' ? [] : [{ ...entry,
            ...(mode === 'wrong-world' ? { world: 'other-world' } : {}),
            ...(mode === 'changed-content' ? { content: `${entry.content}\n未知新增内容。` } : {}),
            ...(mode === 'changed-constant' ? { constant: false } : {}) }];
        h.activate(active); h.assembled(entry.content);
        const chat = [history()[0], { role: 'system', content: entry.content }, history()[1]];
        h.prompt(chat); assert.equal(h.confirm(chat), true); unchanged(h, chat, mode);
    }
});

test('a later native generation cannot inherit old activation or assembled-prompt evidence', () => {
    const { h, entries, value } = prepared();
    h.start(); // extensionPrompts may still contain the preceding generation's value.
    const chat = [history()[0], { role: 'system', content: value }, history()[1]];
    h.prompt(chat); assert.equal(h.confirm(chat), true);
    unchanged(h, chat, 'activation must belong to this generation');
    assert.equal(entries.length, 1);
});

test('duplicate full assembled values, inline quotes and unknown system metadata stay untouched', () => {
    for (const mode of ['duplicate', 'inline', 'metadata', 'missing-assembly']) {
        const entry = lore(), actual = history();
        const chat = [actual[0], { role: 'system', content: entry.content }, actual[1]];
        if (mode === 'duplicate') chat.push({ role: 'system', content: entry.content });
        if (mode === 'inline') chat[1].content = `引文前缀：${entry.content}：引文后缀`;
        if (mode === 'metadata') chat[1].signature = 'unknown-system-metadata';
        const { h } = prepared({ entries: [entry], messages: chat });
        if (mode === 'missing-assembly') h.host.extensionPrompts = {};
        unchanged(h, chat, mode);
    }
});

test('an incomplete container or code fence cannot be separated from its closing dynamic tail', () => {
    for (const entryText of ['<fixed-container>\n常驻片段。', '```text\n常驻片段。']) {
        const entry = lore({ content: entryText });
        const tail = entryText.startsWith('<') ? '\n动态片段。\n</fixed-container>' : '\n动态片段。\n```';
        const { h, chat } = prepared({ entries: [entry], value: entryText + tail });
        unchanged(h, chat, 'the extraction boundary must close its own container');
    }
});

test('a closed standalone code fence is preserved exactly when its proven prefix moves', () => {
    const entry = lore({ content: '```text\n常驻设定的原始文本。\n```' });
    const { h, chat } = prepared({ entries: [entry] });
    assert.equal(h.hoist(chat).entries, 1);
    assert.equal(chat[1].content, entry.content);
});

test('unknown fixed systems and unproven pseudo-dialogue remain barriers even inside the history range', () => {
    for (const barrier of [
        [{ role: 'system', content: '必须维持顺序的未知固定规则。' }],
        [{ role: 'user', content: '预设插入的伪问题。' }, { role: 'assistant', content: '预设插入的伪回答。' }],
    ]) {
        const entry = lore(), actual = history();
        const chat = [actual[0], ...barrier, { role: 'system', content: entry.content }, actual[1]];
        const { h } = prepared({ entries: [entry], messages: chat });
        unchanged(h, chat, 'promotion may cross authenticated history only');
    }
});

test('removing a complete system cannot join previously separated same-role history turns', () => {
    const official = [core()[0], { is_user: false, mes: '紧接着出现的第二段实际叙述。' }, core()[1]];
    const entry = lore();
    const chat = [{ role: 'assistant', content: official[0].mes }, { role: 'system', content: entry.content },
        { role: 'assistant', content: official[1].mes, signature: 'second-history-signature' }, { role: 'user', content: official[2].mes }];
    const { h } = prepared({ entries: [entry], coreEntries: official, messages: chat });
    unchanged(h, chat, 'provider turn boundaries must not collapse');
});

test('missing final history permission, cloned history, another chat or disabled feature cannot promote source data', () => {
    for (const mode of ['unconfirmed', 'clone', 'other-chat', 'disabled', 'no-hoist', 'legacy-layout', 'other-connection']) {
        const { h, chat } = prepared();
        if (mode === 'unconfirmed') h.evaluate('processedHistorySnapshot = null; generationScope.confirmed = false');
        if (mode === 'clone') assert.equal(h.confirm(structuredClone(chat)), false);
        if (mode === 'other-chat') h.switchChat();
        if (mode === 'disabled') h.call('settings').enabled = false;
        if (mode === 'no-hoist') h.call('settings').hoistStatic = false;
        if (mode === 'legacy-layout') h.call('settings').preserveStructure = false;
        if (mode === 'other-connection') h.host.chatCompletionSettings.chat_completion_source = 'custom';
        unchanged(h, chat, mode);
    }
});

test('typed final settings perform the proven promotion while preserving signed user and assistant objects', () => {
    const h = harness(), entry = lore(); h.start(); h.load([entry]); h.activate([entry]); h.assembled(entry.content);
    const actual = history(); actual[0].signature = 'synthetic-final-history-signature';
    const chat = [{ role: 'system', content: '固定首规则。' }, actual[0], { role: 'system', content: entry.content }, actual[1]];
    h.prompt(chat); h.final(chat);
    assert.equal(chat[1].content, entry.content); assert.equal(chat[1].role, 'system');
    assert.equal(chat[2], actual[0]); assert.equal(chat[3], actual[1]);
    assert.equal(actual[0].signature, 'synthetic-final-history-signature');
    assert.equal(h.evaluate('generationScope.settingsHandled'), true);
    assert.deepEqual(plain(h.call('findHistoryRange', chat)), { start: 2, end: 3 });
});

test('several proved depth blocks preserve their final relative order and all intervening true history', () => {
    const h = harness();
    const official = [{ is_user: false, mes: '第一段实际历史叙述。' }, { is_user: true, mes: '第一段实际用户输入。' }, ...core()];
    const first = lore({ uid: 21, depth: 2, content: '最终请求中首先出现的常驻地理规则。' });
    const second = lore({ uid: 22, depth: 1, content: '最终请求中稍后出现的常驻社会规则。' });
    h.start(official); h.load([second, first]); h.activate([second, first]);
    h.assembled(first.content, 2); h.assembled(second.content, 1);
    const actual = official.map(message => ({ role: message.is_user ? 'user' : 'assistant', content: message.mes }));
    const chat = [{ role: 'system', content: '固定首规则。' }, actual[0], { role: 'system', content: first.content },
        actual[1], actual[2], { role: 'system', content: second.content }, actual[3]];
    h.prompt(chat); assert.equal(h.confirm(chat), true);
    const report = h.hoist(chat);
    assert.equal(report.blocks, 2); assert.equal(report.entries, 2);
    assert.deepEqual(chat.slice(1, 3).map(message => message.content), [first.content, second.content]);
    assert.ok(chat.filter(message => message.role !== 'system').every((message, index) => message === actual[index]));
});

test('preset changes and duplicate source identities invalidate prior static proofs', () => {
    for (const mode of ['preset-source', 'preset-order', 'duplicate-loaded', 'duplicate-activated']) {
        const h = harness(), entry = lore(); h.start();
        h.load(mode === 'duplicate-loaded' ? [entry, { ...entry }] : [entry]);
        h.activate(mode === 'duplicate-activated' ? [entry, { ...entry }] : [entry]); h.assembled(entry.content);
        const chat = [history()[0], { role: 'system', content: entry.content }, history()[1]];
        h.prompt(chat); assert.equal(h.confirm(chat), true);
        if (mode === 'preset-source') h.host.chatCompletionSettings.prompts[0].content = '另一份预设源规则。';
        if (mode === 'preset-order') h.host.chatCompletionSettings.prompt_order = [{ character_id: 100001,
            order: [{ identifier: 'chatHistory', enabled: true }, { identifier: 'main', enabled: true }] }];
        unchanged(h, chat, mode);
    }
});

test('the host assembly role, depth, placement and exact literal text remain part of the proof', () => {
    for (const mode of ['role', 'depth', 'placement', 'changed-text', 'duplicate-entry-text']) {
        const entry = lore();
        const { h, chat } = prepared({ entries: [entry] });
        const prompt = h.host.extensionPrompts.customDepthWI_1_0;
        if (mode === 'role') prompt.role = 1;
        if (mode === 'depth') prompt.depth = 2;
        if (mode === 'placement') prompt.position = 0;
        if (mode === 'changed-text') prompt.value = `${prompt.value}\n其他来源添加了额外字节。`;
        if (mode === 'duplicate-entry-text') {
            const duplicated = `${entry.content}\n${entry.content}`;
            prompt.value = duplicated; chat[2].content = duplicated;
        }
        unchanged(h, chat, mode);
    }
});

test('a twice-identical owned database entry never acquires fixed-lore permission', () => {
    const h = harness(); h.call('settings').compatShujuku = false;
    for (const suffix of ['相同召回正文。', '相同召回正文。', '第三轮已变化的召回正文。']) {
        const entry = lore({ comment: 'TavernDB-ACU-GlobalRead', content: `数据库动态纪要。\n${suffix}` });
        h.start(); h.load([entry]); h.activate([entry]); h.assembled(entry.content);
        const chat = [history()[0], { role: 'system', content: entry.content }, history()[1]];
        h.prompt(chat); assert.equal(h.confirm(chat), true);
        unchanged(h, chat, 'equality is never an independent static-source proof');
    }
});

test('inline documentation placeholders inside a closed parent rule do not block literal promotion', () => {
    const entry = lore({ content: '<rules>\n角色名填写为<姓名>，行为填写为<action>；这些是文档占位符。\n</rules>' });
    const { h, chat } = prepared({ entries: [entry] });
    const originalHistory = chat.filter(message => message.role !== 'system');
    const report = h.hoist(chat);
    assert.equal(report.entries, 1); assert.equal(report.blocks, 1);
    assert.equal(chat[1].role, 'system'); assert.equal(chat[1].content, entry.content);
    assert.ok(chat.filter(message => message.role !== 'system').every((message, index) => message === originalHistory[index]));
    assert.equal(chat.map(message => message.content).join('').split(entry.content).length - 1, 1);
});

test('an inline tag whose closer occurs only in the unknown tail cannot become a documentation placeholder', () => {
    const entry = lore({ content: '<rules>\n角色状态：<character-state>尚未完成的片段。\n</rules>' });
    const tail = '\n未知来源的后续状态，最后才出现</character-state>。';
    const { h, chat } = prepared({ entries: [entry], value: entry.content + tail });
    unchanged(h, chat, 'a later structural closer must veto the inline-placeholder exception');
});

test('unpaired standalone tags and inline HTML containers remain structural inside closed parent rules', () => {
    for (const content of [
        '<rules>\n<standalone-container>\n常驻规则正文。\n</rules>',
        '<rules>\n规则要求使用<span>仍未封闭的HTML片段。\n</rules>',
        '<rules>\n规则要求使用<div class="state">仍未封闭的HTML片段。\n</rules>',
    ]) {
        const { h, chat } = prepared({ entries: [lore({ content })] });
        unchanged(h, chat, 'structural markup must not be reclassified as an inline value placeholder');
    }
});

test('typed tools and schema settings veto static promotion without changing valid source or history evidence', () => {
    const unsupported = [
        { tools: [{ type: 'function', function: { name: 'synthetic_tool', parameters: { type: 'object' } } }] },
        { functions: [{ name: 'synthetic_function', parameters: { type: 'object' } }] },
        { tool_choice: 'auto' }, { function_call: 'auto' },
        { response_format: { type: 'json_object' } },
        { json_schema: { name: 'synthetic_schema', schema: { type: 'object' } } },
    ];
    for (const extra of unsupported) {
        const h = harness(), entry = lore(); h.start(); h.load([entry]); h.activate([entry]); h.assembled(entry.content);
        const entryBefore = structuredClone(entry), actual = history(); actual[0].signature = 'unchanged-schema-history-signature';
        const chat = [{ role: 'system', content: '固定首规则。' }, actual[0], { role: 'system', content: entry.content }, actual[1]];
        h.prompt(chat);
        const before = structuredClone(chat), references = chat.slice();
        const body = { type: 'normal', chat_completion_source: 'vertexai', messages: chat, ...extra };
        h.call('onSettingsReady', body);
        assert.deepEqual(chat, before, Object.keys(extra)[0]);
        assert.ok(chat.every((message, index) => message === references[index]));
        assert.deepEqual(entry, entryBefore);
        assert.equal(actual[0].signature, 'unchanged-schema-history-signature');
        assert.equal(h.evaluate('generationScope.settingsHandled'), true);
        assert.equal(h.evaluate('generationScope.staticLoreActivated.length'), 1);
        assert.deepEqual(plain(h.call('findHistoryRange', chat)), { start: 1, end: 3 });
        for (const key of Object.keys(extra)) assert.equal(body[key], extra[key]);
    }
    // Merely present empty tool lists do not introduce a tool/schema constraint.
    const h = harness(), entry = lore(); h.start(); h.load([entry]); h.activate([entry]); h.assembled(entry.content);
    const chat = [history()[0], { role: 'system', content: entry.content }, history()[1]];
    h.prompt(chat); h.call('onSettingsReady', { type: 'normal', chat_completion_source: 'vertexai', messages: chat, tools: [], functions: [] });
    assert.equal(chat[0].content, entry.content);
});
