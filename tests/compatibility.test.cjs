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
