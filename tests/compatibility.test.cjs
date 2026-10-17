'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

// Load the extension unchanged. The ready callback is deliberately not run:
// these tests exercise the same functions without starting a browser or an API call.
const source = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');

function harness(overrides = {}) {
    const host = {
        extensionSettings: {},
        chatCompletionSettings: { chat_completion_source: 'vertexai', use_sysprompt: true },
        chat: [],
        getCurrentChatId: () => 'compatibility-test-chat',
        saveSettingsDebounced() {},
        eventTypes: { CHAT_COMPLETION_SETTINGS_READY: 'settings', CHAT_COMPLETION_PROMPT_READY: 'prompt' },
        eventSource: { on() {}, makeLast() {}, removeListener() {} },
        ...overrides,
    };
    const jqueryChain = new Proxy({}, { get: () => () => jqueryChain });
    const jquery = () => jqueryChain;
    const sandbox = vm.createContext({
        console: { info() {}, warn() {}, error() {}, debug() {} },
        structuredClone,
        setTimeout,
        clearTimeout,
        TextDecoder,
        URL,
        Response,
        ReadableStream,
        AbortController,
        window: { fetch: async () => new Response('{}') },
        jQuery: jquery,
        $: jquery,
        toastr: { info() {}, warning() {}, error() {} },
        SillyTavern: { getContext: () => host },
    });
    vm.runInContext(source, sandbox, { filename: 'index.js' });
    return {
        host,
        window: sandbox.window,
        call(name, ...args) {
            sandbox.__testArgs = args;
            return vm.runInContext(`${name}(...__testArgs)`, sandbox);
        },
        evaluate(expression) { return vm.runInContext(expression, sandbox); },
        setPromptManager(manager) {
            sandbox.__nativePromptManager = manager;
            vm.runInContext('nativeOpenAIModule = { promptManager: __nativePromptManager }', sandbox);
        },
        setOpenAIModule(module) {
            sandbox.__openAIModule = module;
            vm.runInContext('nativeOpenAIModule = __openAIModule', sandbox);
        },
    };
}

const plain = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));

// These are protocol fixtures, not captured live requests. They follow the official
// SillyTavern release pipeline: native Vertex SSE is forwarded unchanged, whereas
// non-streaming sendMakerSuiteRequest returns only choices + responseContent.
// https://github.com/SillyTavern/SillyTavern/blob/release/src/endpoints/backends/chat-completions.js#L740-L785
const vertexSseChunk = {
    candidates: [{ content: { role: 'model', parts: [{ text: 'protocol fixture reply' }] } }],
    usageMetadata: { promptTokenCount: 12000, candidatesTokenCount: 120, cachedContentTokenCount: 8192 },
};
const sillyTavernNonStreamingReply = {
    choices: [{ message: { content: 'protocol fixture reply' } }],
    responseContent: { role: 'model', parts: [{ text: 'protocol fixture reply' }] },
};

test('Vertex SSE usage preserves the provider cached token count', () => {
    const h = harness();
    assert.deepEqual(plain(h.call('readUsage', vertexSseChunk)), { cached: 8192, total: 12000 });
});

test('provider-reported zero is different from an absent cached count', () => {
    const h = harness();
    assert.deepEqual(plain(h.call('readUsage', {
        usageMetadata: { promptTokenCount: 12000, cachedContentTokenCount: 0 },
    })), { cached: 0, total: 12000 });
    assert.deepEqual(plain(h.call('readUsage', {
        usageMetadata: { promptTokenCount: 12000 },
    })), { cached: null, total: 12000 });
});

test('SillyTavern native non-stream reply without usage is unknown, not zero', () => {
    const h = harness();
    assert.equal(h.call('readUsage', sillyTavernNonStreamingReply), null);
    assert.equal(h.call('readUsage', {}), null);
    assert.equal(h.call('readUsage', null), null);
});

test('OpenAI-compatible proxies report cached prompt tokens through usage details', () => {
    const h = harness();
    assert.deepEqual(plain(h.call('readUsage', {
        usage: { prompt_tokens: 10000, completion_tokens: 50, prompt_tokens_details: { cached_tokens: 7000 } },
    })), { cached: 7000, total: 10000 });
});

test('request comparison retains tool-call arguments and signatures', () => {
    const h = harness();
    const request = argument => ({ messages: [{
        role: 'assistant', content: null, signature: 'stored-thought-signature',
        tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'lookup', arguments: argument } }],
    }] });
    const previous = h.call('messageTexts', request('{"key":"previous"}'));
    const current = h.call('messageTexts', request('{"key":"current"}'));
    assert.notDeepEqual(plain(previous), plain(current));
    assert.match(previous.join('\n'), /stored-thought-signature/);
    assert.match(previous.join('\n'), /previous/);
});

test('request comparison retains multimodal content instead of treating it as empty text', () => {
    const h = harness();
    const request = url => ({ messages: [{ role: 'user', content: [
        { type: 'text', text: 'Describe this image' },
        { type: 'image_url', image_url: { url } },
    ] }] });
    const previous = h.call('messageTexts', request('data:image/png;base64,AAA'));
    const current = h.call('messageTexts', request('data:image/png;base64,BBB'));
    assert.notDeepEqual(plain(previous), plain(current));
    assert.match(previous.join('\n'), /Describe this image/);
    assert.match(previous.join('\n'), /AAA/);
});

test('tool schema differences are reported even when function names stay the same', () => {
    const h = harness();
    const request = type => ({
        messages: [{ role: 'system', content: 'Fixed role and preset' }, { role: 'user', content: 'A turn' }],
        tools: [{ type: 'function', function: {
            name: 'lookup', parameters: { type: 'object', properties: { key: { type } } },
        } }],
    });
    const previousBody = request('string');
    const currentBody = request('number');
    const report = h.call('describeReal',
        { body: previousBody, texts: h.call('messageTexts', previousBody) },
        { body: currentBody, texts: h.call('messageTexts', currentBody) }, 20);
    assert.match(report, /工具/);
    assert.match(report, /变化|不同|改变/);
});

test('database compatibility defaults on and optional Izumi memory defaults off', () => {
    const h = harness({ extensionSettings: { cacheOptimizer: { enabled: true, learnedHeads: ['saved head'] } } });
    const settings = h.call('settings');
    assert.equal(settings.compatShujuku, true);
    assert.equal(settings.compatIzumi, false);
    assert.equal(settings.compatGeminiProxy, false);
    assert.deepEqual(plain(settings.learnedHeads), ['saved head']);
});

test('database constant activation does not imply immutable table content', () => {
    const h = harness();
    const entry = {
        uid: 1, comment: 'TavernDB-ACU-GlobalRead', constant: true,
        position: 0, depth: 4, content: '人物当前地点：车站',
    };
    assert.equal(h.call('isDynamicContent', entry), true);
    const snapshot = [structuredClone(entry)];
    h.call('routeEntries', [snapshot]);
    assert.equal(snapshot[0].position, 4);
    assert.equal(snapshot[0].depth, 0);
    assert.deepEqual(entry, {
        uid: 1, comment: 'TavernDB-ACU-GlobalRead', constant: true,
        position: 0, depth: 4, content: '人物当前地点：车站',
    });
    h.call('settings').compatShujuku = false;
    assert.equal(h.call('isDynamicContent', entry), false);
});

test('custom table export metadata is validated and imported lore stays static', () => {
    const h = harness();
    const metadata = {
        version: 1, kind: 'custom_table_export', role: 'row',
        sheetKey: 'sheet_people', tableName: '重要人物', entryName: '人物甲',
    };
    const comment = `人物甲\n<!-- ACU_CUSTOM_TABLE_EXPORT_V1 ${JSON.stringify(metadata)} -->`;
    assert.equal(h.call('isDynamicContent', { comment, content: '当前关系：熟悉' }), true);
    assert.equal(h.call('isDynamicContent', {
        comment: '<!-- ACU_CUSTOM_TABLE_EXPORT_V1 {"version":1} -->', content: '固定内容',
    }), false);
    assert.equal(h.call('isDynamicContent', { comment: '外部导入-世界地理', content: '固定地理设定' }), false);
    assert.equal(h.call('isDynamicContent', { comment: 'TavernDB-ACU-AgentGreenlight', content: '固定规则' }), false);
});

const izumiMemory = value => `<!-- IZM7_compatibility -->\n<KonataExtraInformation>\n${value}\n</KonataExtraInformation>`;
const databaseRecall = value => `<最新数据与记录>\n${value}\n</最新数据与记录>`;
const rolePreset = '固定角色设定与世界规则。';
const fakeUser = '下面仅为预设中固定的示范问题。';
const fakeAssistant = '下面仅为预设中固定的示范答案。';

const nativeHistoryManager = (entries, otherCollections = []) => ({ messages: { getCollection: () => [
    ...otherCollections,
    { identifier: 'chatHistory', getCollection: () => entries },
] } });

test('finished host history keeps exact chat provenance and declines unproven regex-filtered narrative', () => {
    const narrative = '<content>旅客向站务员问路，站务员指向东边的月台，提醒他带好行李，下一班列车将在午后开出。候车室里传来检票广播，靠窗的位置还有几张空椅子，门口的时钟指着正午时分。</content>';
    const user = '我沿着站务员指示的小路走向月台，准备确认车票上的出发时间，并看看有没有临时变更。';
    const html = `<html><style>${'large-render-only-css '.repeat(900)}</style></html>`;
    const h = harness({ chat: [
        { is_user: false, mes: `<planning>仅用于原始消息的规划部分。</planning>${html}${narrative}<tucao>已按楼层过滤。</tucao>` },
        { is_user: true, mes: user },
    ] });
    const injectedUser = '这是世界书以 user 角色注入的资料，不是任何实际聊天楼层。';
    const injection = databaseRecall('本轮会变的资料。');
    const prepared = [
        { role: 'system', content: rolePreset },
        { role: 'user', content: fakeUser },
        { role: 'assistant', content: fakeAssistant },
        { role: 'user', content: injectedUser },
        { role: 'assistant', content: narrative },
        { role: 'system', content: injection },
        { role: 'user', content: user },
    ];
    h.setPromptManager(nativeHistoryManager([
        { identifier: 'newMainChat', role: 'user', content: fakeUser },
        { identifier: 'chatHistory-1', role: 'user', content: injectedUser },
        { identifier: 'chatHistory-2', role: 'assistant', content: narrative },
        { identifier: 'chatHistory-3', role: 'system', content: injection },
        { identifier: 'chatHistory-4', role: 'user', content: user },
    ], [{ identifier: 'dialogueExamples', getCollection: () => [
        { identifier: 'chatHistory-999', role: 'assistant', content: fakeAssistant },
    ] }]));
    const raw = structuredClone(h.host.chat);
    const data = { chat: structuredClone(prepared), dryRun: false };
    h.call('onPromptReady', data);
    assert.deepEqual(plain(h.evaluate('processedHistorySnapshot.entries')), [
        { role: 'user', content: user },
    ]);
    // A late template extension can rebuild the array, losing all object identity.
    const final = { type: 'normal', messages: structuredClone(prepared) };
    h.call('onSettingsReady', final);
    assert.deepEqual(plain(h.call('findHistoryRange', final.messages)), { start: 5, end: 5 });
    assert.equal(final.messages.at(-1).content, injection);
    assert.equal(final.messages[3].content, injectedUser);
    assert.deepEqual(h.host.chat, raw);
});

test('processed history snapshots never replace an existing legacy range and clear when chats change', () => {
    let chatId = 'first-chat';
    const actual = '这一段曾经实际发生，但固定示范也完整重复了这一句话。';
    const latest = '这是唯一的当前用户输入，用于确定最后一个真实楼层。';
    const h = harness({ getCurrentChatId: () => chatId, chat: [
        { is_user: false, mes: actual }, { is_user: true, mes: latest },
    ] });
    const messages = [
        { role: 'assistant', content: actual }, { role: 'system', content: rolePreset },
        { role: 'assistant', content: actual }, { role: 'user', content: latest },
    ];
    h.call('captureProcessedHistory', nativeHistoryManager([
        { identifier: 'chatHistory-1', role: 'assistant', content: actual },
        { identifier: 'chatHistory-2', role: 'user', content: latest },
    ]), messages);
    assert.deepEqual(plain(h.call('findHistoryRange', messages)), { start: 0, end: 3 });
    chatId = 'second-chat';
    h.host.chat = [{ is_user: true, mes: '另一个聊天中的新输入。' }];
    assert.equal(h.call('findHistoryRange', messages), null);
    assert.equal(h.evaluate('processedHistorySnapshot'), null);
});

test('a current-user-only snapshot cannot hoist runtime systems across confirmed assistant history', () => {
    const narrative = '站务员向旅客说明下一班车的发车时刻，并指着墙上的时刻表让他核对票面上的站台号码。'.repeat(6);
    const user = '我核对票面上的号码后，继续询问月台在哪里。';
    const runtime = '实际位置：这是运行时资料，应当照常随剧情变化，不能因为仅识别当前用户就被当成固定头。';
    const h = harness({ chat: [
        { is_user: false, mes: `<hidden-prefix>前缀已被提示词正则去除。</hidden-prefix>${narrative}` },
        { is_user: true, mes: user },
    ] });
    const prepared = [
        { role: 'system', content: rolePreset }, { role: 'assistant', content: fakeAssistant },
        { role: 'system', content: '固定世界设定。' }, { role: 'assistant', content: narrative },
        { role: 'system', content: runtime }, { role: 'user', content: user },
    ];
    h.setPromptManager(nativeHistoryManager([
        { identifier: 'chatHistory-1', role: 'assistant', content: narrative },
        { identifier: 'chatHistory-2', role: 'user', content: user },
    ]));
    h.call('settings').compatGeminiProxy = true;
    const data = { chat: structuredClone(prepared), dryRun: false };
    h.call('onPromptReady', data);
    assert.equal(h.evaluate('processedHistorySnapshot.entries.length'), 1);
    assert.deepEqual(plain(h.call('findHistoryRange', data.chat)), { start: 3, end: 4 });
    assert.equal(data.chat.at(-1).content, runtime);
    const body = { type: 'normal', chat_completion_source: 'vertexai', model: 'gemini-3.1-flash-lite', messages: data.chat };
    assert.equal(h.call('applyGeminiProxyLayout', body).applied, true);
    assert.ok(!body.messages[0].content.includes(runtime));
    assert.equal(body.messages.at(-1).role, 'user');
    assert.equal(body.messages.at(-1).content, runtime);
});

test('snapshot fallback requires unique complete assistant and user matches when raw history is unavailable', () => {
    const assistant = '这是当时的实际助手回答，用于建立完整来源的快照。';
    const user = '这是当时的实际用户输入，用于建立完整来源的快照。';
    const h = harness({ chat: [{ is_user: false, mes: assistant }, { is_user: true, mes: user }] });
    const messages = [{ role: 'assistant', content: assistant }, { role: 'user', content: user }];
    h.call('captureProcessedHistory', nativeHistoryManager(messages.map((m, i) => ({ ...m, identifier: `chatHistory-${i}` }))), messages);
    h.host.chat = [{ is_user: true, mes: '宿主随后变更的文本不能与旧快照匹配。' }];
    assert.equal(h.call('findRawHistoryRange', messages), null);
    assert.deepEqual(plain(h.call('findHistoryRange', messages)), { start: 0, end: 1 });
    assert.equal(h.call('findHistoryRange', [{ role: 'user', content: user }]), null);
    assert.equal(h.call('findHistoryRange', [...messages, { role: 'assistant', content: assistant }]), null);
});

test('a depth injection quoting one span cannot become a processed history witness', () => {
    const quoted = '这是一段恰好四十个字左右的真实聊天原文，注入的资料仅仅引用这一段话而已。'.padEnd(40, '甲').slice(0, 40);
    const raw = `${quoted}这是属于真实聊天的后续内容，应当与注入资料里的固定指令严格区分。`;
    const injection = `${quoted}${'来自世界书的独立指令，不能当成实际聊天。'.repeat(10)}`;
    const h = harness({ chat: [{ is_user: true, mes: raw }] });
    assert.equal(h.call('hasRawHistoryWitness', { role: 'user', content: injection }), false);
    const messages = [{ role: 'user', content: injection }];
    h.call('captureProcessedHistory', nativeHistoryManager([
        { identifier: 'chatHistory-1', role: 'user', content: injection },
        { identifier: 'newMainChat', role: 'user', content: raw },
    ]), messages);
    assert.equal(h.evaluate('processedHistorySnapshot'), null);
});

test('a depth injection quoting two real spans plus its own rules cannot move fixed system rules', () => {
    const rawAssistant = Array.from({ length: 30 }, (_, i) => `旅客第${i}段实际发生的记述仅属于这一楼。`).join('');
    const injected = rawAssistant.slice(0, 80) + '这是世界书注入的附加资料，不是聊天楼层。'.repeat(20);
    const user = '我继续前往车站，并向站务员询问下一班列车。';
    const h = harness({ chat: [{ is_user: false, mes: rawAssistant }, { is_user: true, mes: user }] });
    const prepared = [
        { role: 'system', content: '首规则。' },
        { role: 'assistant', content: injected },
        { role: 'system', content: rolePreset },
        { role: 'assistant', content: rawAssistant },
        { role: 'user', content: user },
    ];
    h.setPromptManager(nativeHistoryManager([
        { identifier: 'chatHistory-3', role: 'assistant', content: injected },
        { identifier: 'chatHistory-2', role: 'assistant', content: rawAssistant },
        { identifier: 'chatHistory-1', role: 'user', content: user },
    ]));
    const data = { chat: structuredClone(prepared), dryRun: false };
    h.call('onPromptReady', data);
    assert.deepEqual(plain(h.call('findHistoryRange', data.chat)), { start: 3, end: 4 });
    assert.equal(h.evaluate('processedHistorySnapshot.entries.length'), 2);
    assert.deepEqual(data.chat, prepared, 'fixed rules before actual history must not move');
});

test('a depth injection containing only a raw substring cannot expand the processed history range', () => {
    const rawAssistant = Array.from({ length: 30 }, (_, i) => `旅客第${i}段实际发生的记述仅属于这一楼。`).join('');
    const quoted = rawAssistant.slice(0, 80);
    const user = '我继续前往车站，并向站务员询问下一班列车。';
    const h = harness({ chat: [{ is_user: false, mes: rawAssistant }, { is_user: true, mes: user }] });
    const prepared = [
        { role: 'system', content: '首规则。' }, { role: 'assistant', content: quoted },
        { role: 'system', content: rolePreset }, { role: 'assistant', content: rawAssistant },
        { role: 'user', content: user },
    ];
    h.setPromptManager(nativeHistoryManager([
        { identifier: 'chatHistory-3', role: 'assistant', content: quoted },
        { identifier: 'chatHistory-2', role: 'assistant', content: rawAssistant },
        { identifier: 'chatHistory-1', role: 'user', content: user },
    ]));
    const data = { chat: structuredClone(prepared), dryRun: false };
    h.call('onPromptReady', data);
    assert.deepEqual(plain(h.call('findHistoryRange', data.chat)), { start: 3, end: 4 });
    assert.deepEqual(data.chat, prepared);
});

test('processed history permits only known name prefixes, never arbitrary instructions before a quote', () => {
    const raw = '旅客进站后先查询时刻表，然后沿路牌前往二号月台等待检票。'.repeat(4);
    const h = harness({ name2: '旅客', chat: [{ is_user: false, name: '旅客', mes: raw }] });
    const malicious = `${'附加世界书指令不可作为实际历史。'.repeat(30)}: ${raw}`;
    assert.equal(h.call('hasRawHistoryWitness', { role: 'assistant', content: malicious }), false);
    assert.equal(h.call('matchesHistoryText', { role: 'assistant', content: malicious }, { role: 'assistant', content: raw }), false);
    assert.equal(h.call('hasRawHistoryWitness', { role: 'assistant', content: `旅客: ${raw}` }), true);
    assert.equal(h.call('matchesHistoryText', { role: 'assistant', content: `旅客: ${raw}` }, { role: 'assistant', content: raw }), true);
});

test('processed history uses the current exported promptManager after host initialization or API switches', () => {
    const first = '旅客走进车站后先核对时刻表，随后询问工作人员月台的位置，并按照路牌的指示继续往前。'.repeat(3);
    const second = '列车靠站后，旅客收起车票走下车厢，在广场上的路线图前停下，寻找通往旅店的道路。'.repeat(3);
    const h = harness({ chat: [{ is_user: false, mes: first }] });
    const module = { promptManager: null };
    h.setOpenAIModule(module);
    h.call('onPromptReady', { chat: [{ role: 'assistant', content: first }], dryRun: false });
    assert.equal(h.evaluate('processedHistorySnapshot'), null);
    module.promptManager = nativeHistoryManager([{ identifier: 'chatHistory-1', role: 'assistant', content: first }]);
    h.call('onPromptReady', { chat: [{ role: 'assistant', content: first }], dryRun: false });
    assert.equal(h.evaluate('processedHistorySnapshot.entries[0].content'), first);
    h.host.chat = [{ is_user: false, mes: second }];
    module.promptManager = nativeHistoryManager([{ identifier: 'chatHistory-1', role: 'assistant', content: second }]);
    h.call('onPromptReady', { chat: [{ role: 'assistant', content: second }], dryRun: false });
    assert.equal(h.evaluate('processedHistorySnapshot.entries[0].content'), second);
});

test('Gemini proxy compatibility makes one large stable system head while retaining all live text', () => {
    const h = harness();
    h.call('settings').compatGeminiProxy = true;
    const first = '开头固定系统规则。'.padEnd(277, '甲');
    const fixed = '来源明确的固定世界设定。'.repeat(250);
    const heads = [];
    for (let i = 0; i < 3; i++) {
        const user = `这是第${i + 1}次自然输入，角色将继续前进并询问新的事情。`;
        const dynamic = databaseRecall(`本轮召回和状态 ${i + 1}`);
        h.host.chat = [{ is_user: true, mes: user }];
        const raw = structuredClone(h.host.chat);
        const body = { type: 'normal', chat_completion_source: ['custom', 'vertexai', 'makersuite'][i], model: 'build-gemini-3.8-flash',
            tools: null, tool_choice: null, response_format: null,
            messages: [
                { role: 'system', content: first },
                { role: 'assistant', content: fakeAssistant },
                { role: 'user', content: fakeUser },
                { role: 'system', content: fixed },
                { role: 'user', content: user },
                { role: 'system', content: dynamic },
            ] };
        const report = h.call('applyGeminiProxyLayout', body);
        assert.equal(report.applied, true);
        assert.equal(report.mergedSystems, 2);
        assert.equal(report.convertedSystems, 1);
        assert.equal(report.fixedHeadChars, first.length + 2 + fixed.length);
        assert.equal(body.messages.filter(m => m.role === 'system').length, 1);
        assert.equal(body.messages[0].content, `${first}\n\n${fixed}`);
        assert.ok(!body.messages[0].content.includes(dynamic));
        assert.deepEqual(plain(body.messages.slice(1).map(m => m.role)), ['assistant', 'user', 'user', 'user', 'user']);
        assert.equal(report.fixedPlaceholders, 1);
        assert.equal(body.messages[3].content, '【固定规则已置于系统指令】');
        for (const content of [first, fixed, fakeAssistant, fakeUser, user, dynamic]) {
            assert.equal(body.messages.map(m => m.content).join('\n').split(content).length - 1, 1);
        }
        heads.push(body.messages[0].content);
        assert.deepEqual(h.host.chat, raw);
    }
    assert.equal(heads[0], heads[1]);
    assert.equal(heads[1], heads[2]);
});

test('Gemini proxy compatibility skips auxiliary, other connections, unsafe roles and authorization verbatim', () => {
    const user = '这是用于确认主聊天的真实用户输入。';
    const h = harness({ chat: [{ is_user: true, mes: user }] });
    h.call('settings').compatGeminiProxy = true;
    const make = () => ({ type: 'normal', chat_completion_source: 'custom', model: 'gemini-proxy', messages: [
        { role: 'system', content: rolePreset }, { role: 'user', content: user },
        { role: 'system', content: databaseRecall('保持实时召回。') },
    ] });
    const cases = [
        b => { b.type = 'quiet'; }, b => { b[Symbol.for('acu.internal-generation-fetch')] = true; },
        b => { b.chat_completion_source = 'openai'; }, b => { b.model = 'other-model'; },
        b => { b.tools = [{ type: 'function', function: { name: 'lookup' } }]; },
        b => { b.response_format = { type: 'json_object' }; },
        b => { b.messages[1].content = [{ type: 'text', text: user }]; },
        b => { b.messages[1].name = 'metadata-must-survive'; },
        b => { b.messages[1].tool_calls = []; },
        b => { b.messages[0].signature = 'system-signature-must-not-move'; },
        b => { b.messages[0].content += '<!-- IZM7_authorization -->'; },
        b => { b.messages[0].content += '<!-- IZW7_authorization -->'; },
        b => { b.messages.unshift({ role: 'system', content: databaseRecall('不明确的前置召回。') }); },
    ];
    for (const mutate of cases) {
        const body = make(); mutate(body);
        const before = JSON.stringify(body);
        const internal = body[Symbol.for('acu.internal-generation-fetch')];
        assert.equal(h.call('applyGeminiProxyLayout', body).applied, false);
        assert.equal(JSON.stringify(body), before);
        assert.equal(body[Symbol.for('acu.internal-generation-fetch')], internal);
    }
    h.call('settings').compatGeminiProxy = false;
    const off = make(), before = structuredClone(off);
    assert.equal(h.call('applyGeminiProxyLayout', off).applied, false);
    assert.deepEqual(off, before);
});

test('Gemini compatibility transport excludes marked auxiliary fetches and preserves caller objects', async () => {
    const user = '我提出本轮新的问题，继续推进当前角色的故事。';
    const h = harness({ chat: [{ is_user: true, mes: user }] });
    h.call('settings').compatGeminiProxy = true;
    const body = { type: 'normal', chat_completion_source: 'custom', model: 'gemini-proxy', messages: [
        { role: 'system', content: '首条系统规则。' },
        { role: 'assistant', content: fakeAssistant },
        { role: 'system', content: rolePreset },
        { role: 'user', content: user },
        { role: 'system', content: databaseRecall('这一轮的最新资料。') },
    ] };
    const replies = [], forwarded = [];
    h.window.fetch = async (url, init) => { forwarded.push({ url, init }); const r = new Response('{}'); replies.push(r); return r; };
    h.call('watchRealRequests');
    const original = { method: 'POST', headers: { 'x-test': 'preserved' }, body: JSON.stringify(body) };
    const first = await h.window.fetch('/api/backends/chat-completions/generate', original);
    assert.equal(first, replies[0]);
    assert.equal(original.body, JSON.stringify(body));
    assert.equal(forwarded[0].init.headers, original.headers);
    const transformed = JSON.parse(forwarded[0].init.body);
    assert.equal(transformed.messages.filter(m => m.role === 'system').length, 1);
    assert.equal(transformed.messages.at(-1).role, 'user');
    const auxiliary = { ...original, [Symbol.for('acu.internal-generation-fetch')]: true };
    const second = await h.window.fetch('/api/backends/chat-completions/generate', auxiliary);
    assert.equal(second, replies[1]);
    assert.equal(forwarded[1].init, auxiliary);
    assert.equal(forwarded[1].init.body, original.body);
});

test('Gemini compatibility preserves inherited and non-enumerable RequestInit dictionary members', async () => {
    const user = '我继续向前走，并询问月台前的工作人员下一班车何时抵达。';
    const h = harness({ chat: [{ is_user: true, mes: user }] });
    h.call('settings').compatGeminiProxy = true;
    const body = { type: 'normal', chat_completion_source: 'custom', model: 'gemini-proxy', messages: [
        { role: 'system', content: rolePreset }, { role: 'user', content: user },
        { role: 'system', content: databaseRecall('这一轮的最新资料。') },
    ] };
    const headers = { 'x-test': 'inherited' }, signal = new AbortController().signal;
    const init = Object.create({ method: 'POST', headers });
    Object.defineProperty(init, 'signal', { value: signal });
    Object.defineProperty(init, 'credentials', { value: 'same-origin' });
    init.body = JSON.stringify(body);
    const originalBody = init.body;
    let forwarded;
    h.window.fetch = async (_url, received) => { forwarded = received; return new Response('{}'); };
    h.call('watchRealRequests');
    await h.window.fetch('/api/backends/chat-completions/generate', init);
    assert.notEqual(forwarded, init);
    assert.equal(forwarded.method, 'POST');
    assert.equal(forwarded.headers, headers);
    assert.equal(forwarded.signal, signal);
    assert.equal(forwarded.credentials, 'same-origin');
    assert.equal(init.body, originalBody);
    assert.equal(JSON.parse(forwarded.body).messages.at(-1).role, 'user');
});

test('RequestInit forwarding reads inherited private-field getters with the original receiver', () => {
    const h = harness();
    const signal = new AbortController().signal;
    class Init {
        #signal = signal;
        get signal() { return this.#signal; }
    }
    const init = new Init();
    init.method = 'POST';
    Object.defineProperty(init, 'body', { value: 'old-body', configurable: false, writable: false });
    const forwarded = h.call('requestInitWithBody', init, 'new-body');
    assert.equal(forwarded.signal, signal);
    assert.equal(forwarded.method, 'POST');
    assert.equal(forwarded.body, 'new-body');
    assert.equal(init.body, 'old-body');
});

test('native Gemini signed history stays separate and is preserved once after fixed system packing', () => {
    const history = '上轮实际发生的正文。'.repeat(30);
    const user = '我在月台上继续等待，同时询问身旁的旅客是否知道列车的情况。';
    const h = harness({ chat: [{ is_user: false, mes: history }, { is_user: true, mes: user }] });
    h.call('settings').compatGeminiProxy = true;
    const signed = { role: 'assistant', content: history, signature: 'native-gemini-thought-signature' };
    const body = { type: 'normal', chat_completion_source: 'vertexai', model: 'gemini-3.1-flash-lite', messages: [
        { role: 'system', content: '首条系统规则。' }, { role: 'assistant', content: fakeAssistant },
        { role: 'system', content: rolePreset }, signed, { role: 'user', content: user },
        { role: 'system', content: databaseRecall('保持实时状态。') },
    ] };
    assert.equal(h.call('applyGeminiProxyLayout', body).applied, true);
    const signedIndex = body.messages.indexOf(signed);
    assert.ok(signedIndex > 0);
    assert.equal(body.messages[signedIndex - 1].role, 'user');
    assert.equal(body.messages[signedIndex - 1].content, '【固定规则已置于系统指令】');
    assert.equal(signed.signature, 'native-gemini-thought-signature');
    assert.equal(body.messages.filter(m => m.content === history).length, 1);
    assert.equal(body.messages.filter(m => m.signature).length, 1);
    assert.equal(body.messages[0].content, `首条系统规则。\n\n${rolePreset}`);
});

const runtimeIntervention = (turn, floor) => `【本轮江湖介入】启用后第${turn}轮；实际玩家回合序号${turn}，玩家楼层${floor}。当前介入记录应照常更新。同轮续写不新开第二个事件。`;
const runtimeFortune = value => `<此刻运势>${value}</此刻运势>\n同一回合各项不同行动共用此值。只在叙事检定中使用，不在正文展示运势。`;

test('complete card runtime counters and fortune stay live at their user positions outside the fixed head', () => {
    const user = '我继续向前行进，查看站牌上的最新消息。';
    const h = harness({ chat: [{ is_user: true, mes: user }] });
    h.call('settings').compatGeminiProxy = true;
    const heads = [];
    for (let turn = 1; turn <= 2; turn++) {
        const intervention = runtimeIntervention(turn, turn + 10), fortune = runtimeFortune(turn + 20);
        const body = { type: 'normal', chat_completion_source: 'vertexai', model: 'gemini-3.1-flash-lite', messages: [
            { role: 'system', content: rolePreset }, { role: 'system', content: intervention },
            { role: 'system', content: '固定规则只提及本轮、运势与随机，不包含运行时记录。' },
            { role: 'system', content: fortune }, { role: 'user', content: user },
        ] };
        const report = h.call('applyGeminiProxyLayout', body);
        assert.equal(report.applied, true);
        assert.equal(report.convertedSystems, 2);
        assert.equal(report.mergedSystems, 2);
        assert.ok(!body.messages[0].content.includes('启用后第'));
        assert.ok(!body.messages[0].content.includes('<此刻运势>'));
        assert.ok(body.messages[0].content.includes('固定规则只提及本轮、运势与随机'));
        assert.deepEqual(plain(body.messages.filter(m => [intervention, fortune].includes(m.content)).map(m => m.role)), ['user', 'user']);
        assert.ok(body.messages.findIndex(m => m.content === intervention) < body.messages.findIndex(m => m.content === fortune));
        for (const content of [intervention, fortune, user]) assert.equal(body.messages.map(m => m.content).join('').split(content).length - 1, 1);
        heads.push(body.messages[0].content);
    }
    assert.equal(heads[0], heads[1]);
});

test('complete runtime records embedded in a merged system are separated without freezing or deleting their text', () => {
    const user = '我查看前方的路口，准备继续赶往渡口。';
    const h = harness({ chat: [{ is_user: true, mes: user }] });
    h.call('settings').compatGeminiProxy = true;
    const heads = [];
    for (let turn = 1; turn <= 2; turn++) {
        const intervention = runtimeIntervention(turn, turn + 30), fortune = runtimeFortune(turn + 40);
        const content = `${rolePreset}\n\n${intervention}\n\n固定世界规则继续保持。\n\n${fortune}\n\n固定输出格式。`;
        const parts = h.call('splitRuntimeSystemRecords', [{ role: 'system', content }]);
        assert.equal(parts.converted, 2);
        assert.equal(parts.messages.map(m => m.content).join(''), content, 'splitting retains every original character');
        const body = { type: 'normal', chat_completion_source: 'custom', model: 'gemini-proxy', messages: [
            { role: 'system', content }, { role: 'user', content: user },
        ] };
        assert.equal(h.call('applyGeminiProxyLayout', body).applied, true);
        assert.ok(body.messages.some(m => m.role === 'user' && m.content === intervention));
        assert.ok(body.messages.some(m => m.role === 'user' && m.content === fortune));
        assert.ok(body.messages[0].content.includes(rolePreset));
        assert.ok(body.messages[0].content.includes('固定输出格式。'));
        heads.push(body.messages[0].content);
    }
    assert.equal(heads[0], heads[1]);
});

test('usage inspection exposes only recognized finite cache numbers and their field paths', () => {
    const h = harness();
    assert.deepEqual(plain(h.call('identifiedUsageFields', { usage: {
        prompt_tokens_details: { cached_tokens: 170 }, unrelated_private_data: 'never report this',
    } })), ['usage.prompt_tokens_details.cached_tokens = 170']);
    assert.deepEqual(plain(h.call('identifiedUsageFields', { usageMetadata: { cachedContentTokenCount: 0 } })),
        ['usageMetadata.cachedContentTokenCount = 0']);
    assert.deepEqual(plain(h.call('identifiedUsageFields', { usage: { cache_read_input_tokens: -1, total_cached_tokens: '170' } })), []);
});

test('Izumi requires its identity marker and complete memory wrapper', () => {
    const h = harness();
    h.call('settings').compatIzumi = true;
    assert.equal(h.call('isDynamicContent', { content: izumiMemory('当前记忆：已到站') }), true);
    assert.equal(h.call('isDynamicContent', {
        content: '<KonataExtraInformation>固定规则里举例提到的标签</KonataExtraInformation>',
    }), false);
    assert.equal(h.call('isDynamicContent', { content: '<!-- IZM7_incomplete --> 当前内容' }), false);
    h.call('settings').compatIzumi = false;
    assert.equal(h.call('isDynamicContent', { content: izumiMemory('当前记忆：已到站') }), false);
});

test('three advancing turns keep fixed preset and history before changing memory and recall', () => {
    const h = harness();
    h.call('settings').compatIzumi = true;
    const inputs = ['我走到车站，看看公告。', '我转身询问站务员下一班车。', '我买了一瓶水，准备上车。'];
    const replies = ['公告栏上贴着时刻表。', '站务员说列车马上进站。'];
    const histories = [];
    const requests = [];
    for (let turn = 0; turn < inputs.length; turn++) {
        if (turn > 0) histories.push({ role: 'assistant', content: replies[turn - 1] });
        histories.push({ role: 'user', content: inputs[turn] });
        h.host.chat = histories.map(m => ({ is_user: m.role === 'user', is_system: false, mes: m.content }));
        const memory = izumiMemory(`这是第 ${turn + 1} 轮独有的记忆。`);
        const recall = databaseRecall(`这是第 ${turn + 1} 轮独有的数据库召回。`);
        const data = { type: 'normal', messages: [
            { role: 'system', content: `${rolePreset}\n${memory}\n固定输出规则。` },
            { role: 'user', content: fakeUser },
            { role: 'assistant', content: fakeAssistant },
            ...histories.map(m => ({ ...m })),
        ] };
        // Model a database/template extension rebuilding messages at SETTINGS_READY
        // after the early PROMPT_READY pass has already happened.
        data.messages = [
            ...data.messages.slice(0, 3), { role: 'system', content: recall }, ...data.messages.slice(3),
        ];
        h.call('onSettingsReady', data);
        const messages = data.messages;
        const latestUserIndex = messages.findIndex(m => m.content === inputs[turn]);
        for (const dynamic of [memory, recall]) {
            const dynamicIndex = messages.findIndex(m => m.content === dynamic);
            assert.ok(dynamicIndex > latestUserIndex, 'dynamic memory belongs after the latest real chat turn');
            assert.equal(messages[dynamicIndex].role, 'system');
            assert.ok(!JSON.stringify(messages).includes('__cacheoptDynamic'), 'internal flags never enter outgoing JSON');
        }
        assert.equal(messages.filter(m => m.content === fakeUser).length, 1);
        assert.equal(messages.filter(m => m.content === fakeAssistant).length, 1);
        assert.ok(messages.findIndex(m => m.content === fakeAssistant) < messages.findIndex(m => m.content === inputs[0]));
        for (const unchanged of histories) {
            assert.ok(messages.some(m => m.content === unchanged.content && m.role === unchanged.role));
        }
        assert.equal(messages.map(m => m.content).join('').split(rolePreset).length - 1, 1);
        assert.equal(messages.map(m => m.content).join('').split('固定输出规则。').length - 1, 1);
        requests.push({ body: { messages: structuredClone(messages) }, texts: h.call('messageTexts', { messages }) });
    }
    for (let i = 1; i < requests.length; i++) {
        const report = h.call('describeReal', requests[i - 1], requests[i], 30);
        assert.doesNotMatch(report, /两次完全相同/);
        assert.ok(h.call('sharedPrefix', requests[i - 1].texts, requests[i].texts).k >= 5,
            'fixed preset, demonstration turns and first real user turn stay identical');
    }
});

test('ambiguous database wrappers and user-authored wrappers are preserved verbatim', () => {
    const h = harness({ chat: [{ is_user: true, mes: '这是真实用户的新一轮输入。' }] });
    const ambiguous = `${databaseRecall('第一段')}\n${databaseRecall('第二段')}`;
    const userAuthored = izumiMemory('用户正文中的引用，不是系统记忆注入。');
    const data = { type: 'normal', messages: [
        { role: 'system', content: ambiguous },
        { role: 'user', content: userAuthored },
        { role: 'user', content: '这是真实用户的新一轮输入。' },
    ] };
    h.call('onSettingsReady', data);
    assert.ok(data.messages.some(m => m.role === 'system' && m.content === ambiguous));
    assert.ok(data.messages.some(m => m.role === 'user' && m.content === userAuthored));
});

test('repeat request comparison is distinguished from an advancing conversation', () => {
    const h = harness();
    const firstBody = { messages: [{ role: 'system', content: rolePreset }, { role: 'user', content: '第一轮输入。' }] };
    const secondBody = { messages: [...firstBody.messages, { role: 'assistant', content: '第一轮回答。' }, { role: 'user', content: '第二轮不同输入。' }] };
    const first = {
        body: firstBody, texts: h.call('messageTexts', firstBody),
        history: { count: 1, userCount: 1, lastUser: '第一轮输入。' },
    };
    const second = {
        body: secondBody, texts: h.call('messageTexts', secondBody),
        history: { count: 3, userCount: 2, lastUser: '第二轮不同输入。' },
    };
    assert.match(h.call('describeReal', first, first, 20), /重复请求/);
    assert.match(h.call('describeReal', first, second, 20), /连续楼层/);
});

test('the final hook is rearmed behind a database listener loaded later', async () => {
    // Match the official EventEmitter behavior: makeLast moves a listener, and
    // emit snapshots the listener array before awaiting them in order.
    const listeners = [];
    const eventSource = {
        on(_event, listener) { listeners.push(listener); },
        removeListener(_event, listener) {
            const index = listeners.indexOf(listener);
            if (index >= 0) listeners.splice(index, 1);
        },
        makeLast(event, listener) { this.removeListener(event, listener); listeners.push(listener); },
        async emit(data) { for (const listener of listeners.slice()) await listener(data); },
    };
    const userText = '真正的新一轮用户输入。';
    const h = harness({ eventSource, chat: [{ is_user: true, mes: userText }] });
    h.call('armFinalHook');
    const recall = databaseRecall('数据库最终一刻重建的召回。');
    eventSource.on('settings', data => {
        data.messages = [{ role: 'system', content: `${rolePreset}\n${recall}` }, { role: 'user', content: userText }];
    });
    h.call('onPromptReady', { chat: [{ role: 'user', content: userText }], dryRun: false });
    const data = { type: 'normal', messages: [] };
    await eventSource.emit(data);
    assert.equal(data.messages.at(-1).content, recall);
    assert.equal(data.messages.at(-1).role, 'system');
    assert.ok(data.messages.findIndex(m => m.content === userText) < data.messages.findIndex(m => m.content === recall));
});

test('database auxiliary fetches are excluded using their published Symbol flag', async () => {
    const h = harness({ chat: [{ is_user: true, mes: '正文用户输入。' }] });
    const body = JSON.stringify({ type: 'normal', model: 'gemini-4-argon', chat_completion_source: 'vertexai',
        messages: [{ role: 'user', content: '正文用户输入。' }] });
    const init = { method: 'POST', body, [Symbol.for('acu.internal-generation-fetch')]: true };
    const originalReply = new Response('{}', { headers: { 'content-type': 'application/json' } });
    let forwardedInit;
    h.window.fetch = async (_url, requestInit) => { forwardedInit = requestInit; return originalReply; };
    h.call('watchRealRequests');
    const reply = await h.window.fetch('/api/backends/chat-completions/generate', init);
    assert.equal(reply, originalReply);
    assert.equal(forwardedInit, init);
    assert.equal(forwardedInit.body, body);
    assert.equal(h.evaluate('recentReal.length'), 0);
});

test('SSE usage observer handles split frames while preserving the original response', async () => {
    const h = harness({ chat: [{ is_user: true, mes: '正文用户输入。' }] });
    const body = { type: 'normal', model: 'gemini-4-argon', chat_completion_source: 'vertexai',
        messages: [{ role: 'user', content: '正文用户输入。' }] };
    const request = h.call('recordRealRequest', JSON.stringify(body));
    const wire = `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: '测试响应。' }] } }] })}\r\n\r\n`
        + `data: ${JSON.stringify(vertexSseChunk)}\r\n\r\ndata: [DONE]\r\n\r\n`;
    const bytes = new TextEncoder().encode(wire);
    const stream = new ReadableStream({ start(controller) {
        for (let at = 0; at < bytes.length; at += 13) controller.enqueue(bytes.slice(at, at + 13));
        controller.close();
    } });
    const response = new Response(stream, { headers: { 'content-type': 'text/event-stream; charset=utf-8' } });
    await h.call('observeUsage', response, request);
    assert.match(h.call('settings').lastUsageReport, /8192/);
    assert.match(h.call('settings').lastUsageReport, /12000/);
    assert.equal(response.bodyUsed, false);
    assert.equal(await response.text(), wire);
});

test('a streaming request identifies SSE usage when SillyTavern omits Content-Type', async () => {
    const h = harness({ chat: [{ is_user: true, mes: '无响应类型头的流式正文。' }] });
    const request = h.call('recordRealRequest', JSON.stringify({
        type: 'normal', model: 'gemini-4-argon', chat_completion_source: 'vertexai', stream: true,
        messages: [{ role: 'user', content: '无响应类型头的流式正文。' }],
    }));
    const wire = `data: ${JSON.stringify(vertexSseChunk)}\n\ndata: [DONE]\n\n`;
    const response = new Response(new ReadableStream({ start(controller) {
        const bytes = new TextEncoder().encode(wire);
        controller.enqueue(bytes.slice(0, 19));
        controller.enqueue(bytes.slice(19));
        controller.close();
    } }));
    assert.equal(response.headers.has('content-type'), false);
    await h.call('observeUsage', response, request);
    assert.match(h.call('settings').lastUsageReport, /8192/);
    assert.match(h.call('settings').lastUsageReport, /12000/);
    assert.equal(response.bodyUsed, false);
    assert.equal(await response.text(), wire);
});

test('non-streaming usage observer reports unknown without consuming SillyTavern reply', async () => {
    const h = harness({ chat: [{ is_user: true, mes: '正文用户输入。' }] });
    const request = h.call('recordRealRequest', JSON.stringify({
        type: 'normal', model: 'gemini-4-argon', messages: [{ role: 'user', content: '正文用户输入。' }],
    }));
    const response = new Response(JSON.stringify(sillyTavernNonStreamingReply), {
        headers: { 'content-type': 'application/json' },
    });
    await h.call('observeUsage', response, request);
    assert.match(h.call('settings').lastUsageReport, /未知/);
    assert.doesNotMatch(h.call('settings').lastUsageReport, /token：0/);
    assert.equal(response.bodyUsed, false);
    assert.deepEqual(await response.json(), sillyTavernNonStreamingReply);
});

test('the free-check guide never generates a response or changes live chat messages', async () => {
    const chat = [{ is_user: true, mes: '待保护的真实聊天内容。' }, { is_user: false, mes: '已有回答。' }];
    const original = structuredClone(chat);
    let calls = 0;
    const h = harness({ chat, generate() { calls++; throw new Error('Generation is not allowed by a free check'); } });
    h.window.fetch = async () => { calls++; throw new Error('No API call is allowed by a free check'); };
    await h.call('checkStability');
    assert.equal(calls, 0);
    assert.deepEqual(chat, original);
});

test('request comparison separates the actual source, model and endpoint channels', () => {
    const userText = '这是实际正文请求。';
    const h = harness({ chat: [{ is_user: true, mes: userText }] });
    const base = { type: 'normal', model: 'gemini-4-argon', chat_completion_source: 'vertexai',
        messages: [{ role: 'system', content: 'original-channel' }, { role: 'user', content: userText }] };
    const variants = [
        base,
        { ...base, model: 'another-model' },
        { ...base, chat_completion_source: 'custom' },
        { ...base, reverse_proxy: 'https://example.invalid/proxy' },
        { ...base, custom_url: 'https://example.invalid/compatible' },
    ];
    for (const body of variants) {
        h.call('recordRealRequest', JSON.stringify(body));
        assert.equal(h.call('settings').lastRealReport, undefined);
    }
    const current = { ...base, messages: [{ role: 'system', content: 'updated-original-channel' }, { role: 'user', content: userText }] };
    h.call('recordRealRequest', JSON.stringify(current));
    assert.match(h.call('settings').lastRealReport, /original-channel/);
});

test('comparison uses the immediately preceding channel request instead of the most similar older one', () => {
    const userText = '这是实际正文请求。';
    const h = harness({ chat: [{ is_user: true, mes: userText }] });
    const body = marker => ({ type: 'normal', model: 'gemini-4-argon', chat_completion_source: 'vertexai',
        messages: [{ role: 'system', content: marker }, { role: 'user', content: userText }] });
    h.call('recordRealRequest', JSON.stringify(body('earlier-most-similar')));
    h.call('recordRealRequest', JSON.stringify(body('immediately-previous')));
    h.call('recordRealRequest', JSON.stringify(body('earlier-most-similar')));
    const report = h.call('settings').lastRealReport;
    assert.match(report, /immediately-previous/);
    assert.doesNotMatch(report, /请求类型：重复请求/);
    const beforeQuiet = h.evaluate('recentReal.length');
    assert.equal(h.call('recordRealRequest', JSON.stringify({ ...body('auxiliary'), type: 'quiet' })), null);
    assert.equal(h.evaluate('recentReal.length'), beforeQuiet);
});

test('a short user turn cannot match preset explanations or the same assistant word', () => {
    const h = harness({ chat: [{ is_user: true, mes: '继续' }] });
    const messages = [
        { role: 'system', content: rolePreset },
        { role: 'user', content: '固定预设说明：用户说继续时保持现有文风。' },
        { role: 'system', content: '必须保持原位的固定输出规则。' },
        { role: 'assistant', content: '继续' },
        { role: 'user', content: '继续' },
    ];
    assert.deepEqual(plain(h.call('findHistoryRange', messages)), { start: 4, end: 4 });
    const original = structuredClone(messages);
    h.call('onSettingsReady', { type: 'normal', messages });
    assert.deepEqual(messages, original);

    const presetOnly = original.slice(0, -1);
    assert.equal(h.call('findHistoryRange', presetOnly), null);
    const presetSnapshot = structuredClone(presetOnly);
    h.call('onSettingsReady', { type: 'normal', messages: presetOnly });
    assert.deepEqual(presetOnly, presetSnapshot);
});

test('failed or cancelled fetches preserve the original result and cannot become the next comparison baseline', async () => {
    for (const mode of ['http-error', 'cancelled']) {
        const userText = '这一条是真实用户正文。';
        const h = harness({ chat: [{ is_user: true, mes: userText }] });
        const body = marker => ({ type: 'normal', model: 'gemini-4-argon', chat_completion_source: 'vertexai',
            messages: [{ role: 'system', content: marker }, { role: 'user', content: userText }] });
        const baseline = h.call('recordRealRequest', JSON.stringify(body('last-successful-baseline')));
        const failure = Object.assign(new Error('The request was cancelled'), { name: 'AbortError' });
        const errorResponse = new Response('{"error":"upstream unavailable"}', {
            status: 503, headers: { 'content-type': 'application/json' },
        });
        const init = { method: 'POST', body: JSON.stringify(body('failed-request-must-be-removed')) };
        let forwardedInit;
        h.window.fetch = async (_url, options) => {
            forwardedInit = options;
            if (mode === 'cancelled') throw failure;
            return errorResponse;
        };
        h.call('watchRealRequests');
        if (mode === 'cancelled') {
            await assert.rejects(h.window.fetch('/api/backends/chat-completions/generate', init), error => error === failure);
        } else {
            const reply = await h.window.fetch('/api/backends/chat-completions/generate', init);
            assert.equal(reply, errorResponse);
            assert.equal(reply.status, 503);
            assert.equal(reply.bodyUsed, false);
            assert.deepEqual(await reply.json(), { error: 'upstream unavailable' });
        }
        assert.equal(forwardedInit, init);
        assert.equal(h.evaluate('recentReal.length'), 1);
        assert.equal(h.evaluate('recentReal[0]'), baseline);
        h.call('recordRealRequest', JSON.stringify(body('next-successful-request')));
        const report = h.call('settings').lastRealReport;
        assert.match(report, /last-successful-baseline/);
        assert.doesNotMatch(report, /failed-request-must-be-removed/);
    }
});
