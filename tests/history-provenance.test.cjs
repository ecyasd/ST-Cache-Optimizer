'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const source = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
const plain = value => value == null ? value : JSON.parse(JSON.stringify(value));

function harness(raw = [], overrides = {}) {
    const host = {
        extensionSettings: {}, chatCompletionSettings: { chat_completion_source: 'vertexai' },
        chat: raw, getCurrentChatId: () => 'history-test', saveSettingsDebounced() {},
        eventTypes: { CHAT_COMPLETION_SETTINGS_READY: 'settings' },
        eventSource: { on() {}, makeLast() {}, removeListener() {} }, ...overrides,
    };
    const chain = new Proxy({}, { get: () => () => chain });
    const sandbox = vm.createContext({
        console: { info() {}, warn() {}, error() {}, debug() {} }, structuredClone,
        setTimeout, clearTimeout, TextDecoder, URL, Response, ReadableStream, AbortController,
        window: { location: { href: 'http://127.0.0.1:8000/', origin: 'http://127.0.0.1:8000' } },
        jQuery: () => chain, $: () => chain, toastr: { info() {}, warning() {}, error() {} },
        SillyTavern: { getContext: () => host },
    });
    vm.runInContext(source, sandbox);
    const call = (name, ...args) => {
        sandbox.__args = args;
        return vm.runInContext(`${name}(...__args)`, sandbox);
    };
    return {
        host, call, evaluate: expression => vm.runInContext(expression, sandbox),
        start(core, type = 'normal', dryRun = false, options = {}) {
            call('onGenerationStarted', type, options, dryRun);
            if (!dryRun) call('captureGenerationHistory', core, 100000, () => {}, type);
        },
        prompt(chat, entries = chat, dryRun = false) {
            sandbox.__manager = { messages: { getCollection: () => [{
                identifier: 'chatHistory', getCollection: () => entries.map((message, i) => ({ ...message, identifier: `chatHistory-${i}` })),
            }] } };
            vm.runInContext('nativeOpenAIModule = { promptManager: __manager }', sandbox);
            const data = { chat, dryRun }; call('onPromptReady', data); return data;
        },
    };
}

const assistant = Array.from({ length: 35 }, (_, i) => `第${i}节是真实旅程里独一无二的叙述，旅客继续沿着车站旁的道路行走。`).join('');
const user = '我走进候车室，向站务员询问下一班列车的出发时间。';
const core = () => [{ is_user: false, mes: assistant }, { is_user: true, mes: user }];
const raw = () => [{ is_user: false, mes: `<planning>不发送的规划。</planning>${assistant}<render>不发送的美化。</render>` }, { is_user: true, mes: user }];
const actual = () => [{ role: 'assistant', content: assistant }, { role: 'user', content: user }];

test('official processed core identifies regex-filtered history without treating midpoint quotes as history', () => {
    const h = harness(raw()), before = structuredClone(h.host.chat), processed = core();
    const quote = assistant.slice(Math.floor(assistant.length / 2), Math.floor(assistant.length / 2) + 30);
    const fixed = { role: 'system', content: '固定世界设定应保留在真实历史之前。' };
    const messages = [{ role: 'system', content: '固定首规则。' }, { role: 'assistant', content: quote }, fixed, ...actual()];
    h.start(processed); h.prompt(messages);
    assert.deepEqual(plain(h.call('findHistoryRange', messages)), { start: 3, end: 4 });
    assert.equal(messages[2], fixed);
    assert.deepEqual(h.host.chat, before); assert.deepEqual(processed, core());
});

test('raw fallback uses complete bodies and actual names, and duplicate full quotes remain ambiguous', () => {
    const h = harness(core(), { name2: '旅客' });
    const quoted = assistant.slice(Math.floor(assistant.length * 0.7), Math.floor(assistant.length * 0.7) + 30);
    const messages = [{ role: 'assistant', content: quoted }, { role: 'system', content: '固定规则。' }, ...actual()];
    assert.deepEqual(plain(h.call('findHistoryRange', messages)), { start: 2, end: 3 });
    assert.equal(h.call('findHistoryRange', [{ role: 'assistant', content: assistant }, ...messages]), null);
    assert.deepEqual(plain(h.call('findHistoryRange', [{ role: 'assistant', content: `旅客: ${assistant}` }, actual()[1]])), { start: 0, end: 1 });
    assert.equal(h.call('findHistoryRange', [{ role: 'assistant', content: `未知指令: ${assistant}` }, actual()[1]]), null);
});

test('numeric host history identifiers cannot prove injected or fully duplicated narrative provenance', () => {
    const h = harness(raw()); h.start(core());
    const messages = [{ role: 'assistant', content: assistant }, { role: 'system', content: '固定规则。' }, ...actual()];
    const before = structuredClone(messages); h.prompt(messages);
    assert.equal(h.call('findHistoryRange', messages), null);
    assert.deepEqual(messages, before);
    assert.equal(h.evaluate('generationHistorySnapshot.pending'), true);
});

test('nonmatching helper prompt does not consume pending main history and dry runs leave it intact', () => {
    const h = harness(raw()); h.start(core());
    const helper = [{ role: 'user', content: '请只整理数据库纪要。' }];
    h.prompt(helper);
    assert.equal(h.call('findHistoryRange', helper), null);
    assert.equal(h.evaluate('generationHistorySnapshot.pending'), true);
    h.prompt(actual(), actual(), true);
    assert.equal(h.evaluate('generationHistorySnapshot.pending'), true);
    const messages = [actual()[0], { role: 'system', content: '当前变化的数据库召回。' }, actual()[1]];
    h.prompt(messages);
    assert.equal(h.evaluate('generationHistorySnapshot.pending'), false);
    assert.deepEqual(plain(h.call('findHistoryRange', messages)), { start: 0, end: 2 });
    h.call('onSettingsReady', { type: 'normal', messages });
    assert.deepEqual(plain(h.call('findHistoryRange', messages)), { start: 0, end: 1 });
    assert.equal(messages.at(-1).role, 'system');
});

test('main generation routes one worldinfo snapshot; quiet, impersonate, dryrun and unknown scopes do not', () => {
    const h = harness(raw());
    const makeEntry = () => ({ content: '当前地点：车站', comment: 'TavernDB-ACU-GlobalRead', constant: true, position: 0, depth: 4 });
    for (const [type, dryRun, options] of [['quiet', false, {}], ['impersonate', false, {}], ['normal', true, {}], ['unknown', false, {}], ['normal', false, { quiet_prompt: '辅助指令' }]]) {
        h.start(core(), type, dryRun, options);
        const entry = makeEntry(); h.call('onWorldInfoEntriesLoaded', { chatLore: [entry] });
        assert.equal(entry.position, 0);
    }
    h.start(core());
    const entry = makeEntry(); h.call('onWorldInfoEntriesLoaded', { chatLore: [entry] });
    assert.equal(entry.position, 4); assert.equal(entry.depth, 0);
    const later = makeEntry(); h.call('onWorldInfoEntriesLoaded', { chatLore: [later] });
    assert.equal(later.position, 0);
    h.call('clearGenerationScope');
    const ended = makeEntry(); h.call('onWorldInfoEntriesLoaded', { chatLore: [ended] });
    assert.equal(ended.position, 0);
});

test('nested quiet invalidates main permission, and chat switches cannot reuse processed history', () => {
    let chatId = 'first'; const h = harness(raw(), { getCurrentChatId: () => chatId });
    h.start(core()); h.start(core(), 'quiet');
    const messages = [actual()[0], { role: 'system', content: '辅助请求必须保留布局。' }, actual()[1]];
    const before = structuredClone(messages); h.prompt(messages);
    assert.deepEqual(messages, before); assert.equal(h.call('findHistoryRange', messages), null);
    h.start(core()); h.prompt(actual()); chatId = 'second'; h.host.chat = [];
    assert.equal(h.call('findHistoryRange', actual()), null);
});

test('late rebuilding preserves complete wrapped user input and drops unknown replacements conservatively', () => {
    const wrapped = `以下是用户的本轮输入\n<本轮用户输入>${user}</本轮用户输入>\n数据库召回：纪要甲。`;
    const h = harness([{ is_user: false, mes: assistant }, { is_user: true, mes: wrapped }]);
    h.start([{ is_user: false, mes: assistant }, { is_user: true, mes: wrapped }]);
    h.prompt([{ role: 'assistant', content: assistant }, { role: 'user', content: wrapped }]);
    const rebuilt = [{ role: 'assistant', content: assistant }, { role: 'system', content: '本轮状态。' }, { role: 'user', content: wrapped }];
    h.call('onSettingsReady', { type: 'normal', messages: rebuilt });
    assert.equal(rebuilt.at(-1).content, '本轮状态。');
    assert.equal(h.call('findHistoryRange', [{ role: 'assistant', content: assistant }, { role: 'user', content: `${wrapped}\n未知扩展的新增文本。` }]), null);
});

test('large complete histories are indexed without truncation and only budgeted tool histories block', () => {
    const messages = Array.from({ length: 80 }, (_, i) => ({ role: i % 2 ? 'user' : 'assistant', content: `完整楼层${i}。${'这段正文要完整保留。'.repeat(500)}` }));
    const source = messages.map(message => ({ is_user: message.role === 'user', mes: message.content }));
    const h = harness(source); h.start(source); h.prompt(messages);
    assert.deepEqual(plain(h.call('findHistoryRange', messages)), { start: 0, end: 79 });
    h.start([{ is_user: false, mes: assistant, extra: { tool_invocations: [{ id: 'tool-call' }] } }, core()[1]]);
    h.prompt(actual(), [{ role: 'assistant', content: assistant, tool_calls: [{ id: 'tool-call' }] }, actual()[1]]);
    assert.equal(h.call('findHistoryRange', actual()), null);
    h.start([{ is_user: false, mes: '旧工具消息已超出上下文', extra: { tool_invocations: [{ id: 'tool-call' }] } }, ...core()]);
    h.prompt(actual()); assert.deepEqual(plain(h.call('findHistoryRange', actual())), { start: 0, end: 1 });
});

test('repeated real short user turns align through complete surrounding assistant turns', () => {
    const messages = [{ role: 'assistant', content: '第一段独特的实际叙述。' }, { role: 'user', content: '继续' },
        { role: 'assistant', content: '第二段不同的实际叙述。' }, { role: 'user', content: '继续' }];
    const source = messages.map(message => ({ is_user: message.role === 'user', mes: message.content }));
    const h = harness(source); h.start(source);
    const prepared = [{ role: 'user', content: '继续' }, { role: 'system', content: '固定示范分隔。' }, ...messages];
    h.prompt(prepared); assert.deepEqual(plain(h.call('findHistoryRange', prepared)), { start: 2, end: 5 });
});

test('continue preserves assistant prefill and reports an explicit unsupported skip', () => {
    const h = harness(core()); h.start(core(), 'continue');
    const messages = [actual()[1], { role: 'system', content: '必须保留在 prefill 之前的指令。' }, actual()[0]];
    const before = structuredClone(messages); h.prompt(messages);
    h.call('onSettingsReady', { type: 'continue', messages });
    assert.deepEqual(messages, before); assert.match(h.evaluate('lastRun'), /continue.*prefill/);
    h.call('settings').compatGeminiProxy = true;
    assert.equal(h.call('applyGeminiProxyLayout', { type: 'continue', messages }).reason, 'continue-prefill');
});

test('missing main provenance reports a skip while quiet helpers preserve the main report', () => {
    const h = harness(raw()); h.call('onGenerationStarted', 'normal', {}, false);
    h.prompt(actual()); assert.match(h.evaluate('lastRun'), /未收到当前宿主历史来源/);
    h.start(core()); h.prompt(actual()); const mainReport = h.evaluate('lastRun');
    const helper = [{ role: 'user', content: '整理纪要的辅助指令。' }];
    h.prompt(helper); h.call('onSettingsReady', { type: 'quiet', messages: helper });
    assert.equal(h.evaluate('lastRun'), mainReport);
    const mainFinal = [actual()[0], { role: 'system', content: '等待最终处理的主请求状态。' }, actual()[1]];
    h.call('onSettingsReady', { type: 'normal', messages: mainFinal });
    assert.equal(mainFinal.at(-1).content, '等待最终处理的主请求状态。');
    h.start(core()); h.prompt(helper); h.call('onSettingsReady', { type: 'normal', messages: helper });
    assert.match(h.evaluate('lastRun'), /无法确认真实历史/);
});

test('a raw helper containing the full main history stays unchanged until typed main settings', () => {
    const h = harness(raw()); h.start(core()); h.prompt(actual());
    const helper = [actual()[0], { role: 'system', content: '数据库辅助模板自己的中间指令。' }, actual()[1]];
    const before = structuredClone(helper); h.prompt(helper);
    h.call('onSettingsReady', { type: 'quiet', messages: helper });
    assert.deepEqual(helper, before);
    const main = [actual()[0], { role: 'system', content: '主请求最终动态状态。' }, actual()[1]];
    h.call('onSettingsReady', { type: 'normal', messages: main });
    assert.equal(main.at(-1).content, '主请求最终动态状态。');
});

test('typed main settings restore complete official history after a helper used a shorter suffix', () => {
    const messages = [{ role: 'assistant', content: '较早但仍在正文预算中的独特实际叙述。' }, { role: 'user', content: '先确认时刻表。' }, ...actual()];
    const source = messages.map(message => ({ is_user: message.role === 'user', mes: message.content }));
    const h = harness(source); h.start(source); h.prompt(actual());
    assert.equal(h.evaluate('processedHistorySnapshot.entries.length'), 2);
    h.prompt(structuredClone(messages));
    const dynamic = { role: 'system', content: '较早历史之间的动态资料不能进入固定头。' };
    const main = [messages[0], dynamic, ...messages.slice(1)];
    h.call('onSettingsReady', { type: 'normal', messages: main });
    assert.deepEqual(plain(h.call('findHistoryRange', main)), { start: 0, end: 3 });
    assert.equal(main.at(-1), dynamic);
    assert.equal(h.evaluate('processedHistorySnapshot.entries.length'), 4);
});
