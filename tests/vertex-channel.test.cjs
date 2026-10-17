'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const source = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');

const USER = '本次离线测试询问车站何时开放，内容没有来自真实聊天。';
const ASSISTANT = '这是用于验证完整历史来源的独立合成回复，站台上没有其他旅客。';
const core = () => [{ is_user: false, mes: ASSISTANT }, { is_user: true, mes: USER }];
const messages = () => [{ role: 'system', content: '固定规则。' }, { role: 'assistant', content: ASSISTANT },
    { role: 'system', content: '当前变化的动态资料。' }, { role: 'user', content: USER }];
const body = (provider = 'vertexai') => ({ type: 'normal', model: 'gemini-offline', chat_completion_source: provider,
    stream: false, messages: messages() });
const plain = value => JSON.parse(JSON.stringify(value));

function harness(mainApi = 'openai', provider = 'vertexai') {
    const host = { mainApi, extensionSettings: {}, chatCompletionSettings: { chat_completion_source: provider },
        chat: core(), getCurrentChatId: () => 'offline-vertex-channel', saveSettingsDebounced() {},
        eventTypes: { CHAT_COMPLETION_SETTINGS_READY: 'settings' },
        eventSource: { on() {}, makeLast() {}, removeListener() {} } };
    const chain = new Proxy({}, { get: () => () => chain });
    const sandbox = vm.createContext({ structuredClone, setTimeout, clearTimeout, TextDecoder, URL, Response,
        ReadableStream, AbortController, console: { info() {}, warn() {}, error() {}, debug() {} },
        window: { location: { href: 'http://localhost:8000/', origin: 'http://localhost:8000' }, fetch: async () => new Response('{}') },
        jQuery: () => chain, $: () => chain, toastr: {}, SillyTavern: { getContext: () => host } });
    vm.runInContext(source, sandbox);
    const call = (name, ...args) => { sandbox.__args = args; return vm.runInContext(`${name}(...__args)`, sandbox); };
    return { host, call, window: sandbox.window, evaluate: text => vm.runInContext(text, sandbox),
        start() { call('onGenerationStarted', 'normal', {}, false); call('captureGenerationHistory', core(), 100000, () => {}, 'normal'); } };
}

test('only the Chat Completion Vertex connection authorizes worldinfo routing and typed final sorting', () => {
    for (const [mainApi, provider] of [['openai', 'custom'], ['openai', 'makersuite'], ['openai', 'openai'],
        ['textgenerationwebui', 'vertexai'], ['openai', undefined], ['openai', 'vertexai']]) {
        const h = harness(mainApi, provider);
        if (provider === undefined) delete h.host.chatCompletionSettings.chat_completion_source;
        h.start();
        const supported = mainApi === 'openai' && provider === 'vertexai';
        assert.equal(h.call('isVertexConnection'), supported);
        const entry = { comment: 'TavernDB-ACU-synthetic', content: '本轮合成纪要。', constant: true, position: 0, depth: 4 };
        h.call('onWorldInfoEntriesLoaded', { chatLore: [entry] });
        assert.equal(entry.position, supported ? 4 : 0);
        const list = messages(), before = structuredClone(list);
        h.call('onSettingsReady', { type: 'normal', chat_completion_source: provider, messages: list });
        if (supported) assert.equal(list.at(-1).content, '当前变化的动态资料。');
        else assert.deepEqual(list, before);
    }
});

test('direct worldinfo routing is also inert outside the supported Vertex connection', () => {
    const h = harness('openai', 'custom');
    const rows = [{ comment: 'TavernDB-ACU-synthetic', content: '合成纪要。', constant: true, position: 0, depth: 4 }];
    const before = structuredClone(rows);
    h.call('routeEntries', [rows]);
    assert.deepEqual(rows, before);
});

test('captured connection permission cannot be reused after a channel switch', () => {
    const h = harness(); h.start();
    h.host.chatCompletionSettings.chat_completion_source = 'custom';
    h.call('onPromptReady', { chat: messages() });
    assert.equal(h.evaluate('generationScope'), null);
    h.host.chatCompletionSettings.chat_completion_source = 'vertexai';
    const list = messages(), before = structuredClone(list);
    h.call('onSettingsReady', { type: 'normal', chat_completion_source: 'vertexai', messages: list });
    assert.deepEqual(list, before);

    h.host.chatCompletionSettings.chat_completion_source = 'custom'; h.start();
    h.host.chatCompletionSettings.chat_completion_source = 'vertexai';
    assert.equal(h.call('isMainGenerationScope'), false);
});

test('a non-Vertex final body cannot consume permission for the actual Vertex main request', () => {
    const h = harness(); h.start();
    const helper = messages(), before = structuredClone(helper);
    h.call('onSettingsReady', { type: 'normal', chat_completion_source: 'custom', messages: helper });
    assert.deepEqual(helper, before);
    assert.equal(h.evaluate('generationScope.settingsHandled'), false);
    const main = messages();
    h.call('onSettingsReady', { type: 'normal', chat_completion_source: 'vertexai', messages: main });
    assert.equal(main.at(-1).content, '当前变化的动态资料。');
});

test('fetch forwards every other provider and connection unchanged without recording its usage', async () => {
    for (const [mainApi, current, actual] of [['openai', 'vertexai', 'custom'], ['openai', 'vertexai', 'makersuite'],
        ['openai', 'custom', 'vertexai'], ['textgenerationwebui', 'vertexai', 'vertexai']]) {
        const h = harness(mainApi, current); h.start();
        h.call('settings').compatGeminiProxy = true;
        const init = { method: 'POST', headers: { 'x-offline-test': 'preserved' }, body: JSON.stringify(body(actual)) };
        const response = new Response('{}'); let forwarded;
        h.window.fetch = async (_input, received) => { forwarded = received; return response; };
        h.call('watchRealRequests');
        assert.equal(await h.window.fetch('/api/backends/chat-completions/generate', init), response);
        assert.equal(forwarded, init);
        assert.equal(forwarded.body, init.body);
        assert.equal(h.evaluate('recentReal.length'), 0);
        assert.equal(h.call('recordRealRequest', init.body), null);
    }
});

test('Vertex database auxiliary requests keep their original transport and do not enter main usage', async () => {
    for (const marked of [false, true]) {
        const h = harness(); h.start(); h.call('settings').compatGeminiProxy = true;
        const auxiliary = body();
        if (!marked) auxiliary.type = 'quiet';
        const init = { method: 'POST', body: JSON.stringify(auxiliary), ...(marked ? { [Symbol.for('acu.internal-generation-fetch')]: true } : {}) };
        let forwarded;
        h.window.fetch = async (_input, received) => { forwarded = received; return new Response('{}'); };
        h.call('watchRealRequests');
        await h.window.fetch('/api/backends/chat-completions/generate', init);
        assert.equal(forwarded, init);
        assert.equal(h.evaluate('recentReal.length'), 0);
    }
});

test('missing official history support never enables the experimental request rewrite', async () => {
    const h = harness();
    h.call('onGenerationStarted', 'normal', {}, false);
    h.call('settings').compatGeminiProxy = true;
    const init = { method: 'POST', body: JSON.stringify(body()) }; let forwarded;
    h.window.fetch = async (_input, received) => { forwarded = received; return new Response('{}'); };
    h.call('watchRealRequests');
    await h.window.fetch('/api/backends/chat-completions/generate', init);
    assert.equal(forwarded, init);
    assert.deepEqual(plain(JSON.parse(init.body).messages), messages());
});

test('the actual Vertex main response can still be recorded with ordinary optimization disabled', () => {
    const h = harness(); h.start();
    h.call('onSettingsReady', { type: 'normal', chat_completion_source: 'vertexai', messages: messages() });
    h.call('settings').enabled = false;
    assert.ok(h.call('recordRealRequest', JSON.stringify(body())));
    assert.equal(h.evaluate('recentReal.length'), 1);
});
