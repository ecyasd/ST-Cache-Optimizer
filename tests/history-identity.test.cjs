'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const source = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
const core = () => [{ is_user: false, mes: '完整的宿主正文。<render-only>仅显示占位符</render-only>' },
    { is_user: true, mes: '本轮完整输入。<recall>宏前纪要</recall>' }];
const messages = () => [{ role: 'system', content: '固定首规则。' }, { role: 'assistant', content: core()[0].mes },
    { role: 'system', content: '本轮动态资料。' }, { role: 'user', content: core()[1].mes }];
const plain = value => value == null ? value : JSON.parse(JSON.stringify(value));
function harness() {
    const host = { mainApi: 'openai', extensionSettings: {}, chatCompletionSettings: { chat_completion_source: 'vertexai' },
        chat: core(), getCurrentChatId: () => 'identity-fixture', saveSettingsDebounced() {},
        eventTypes: { CHAT_COMPLETION_SETTINGS_READY: 'settings' }, eventSource: { on() {}, makeLast() {}, removeListener() {} } };
    const chain = new Proxy({}, { get: () => () => chain });
    const sandbox = vm.createContext({ structuredClone, TextDecoder, URL, Response, ReadableStream, AbortController, setTimeout, clearTimeout,
        console: { info() {}, warn() {}, error() {}, debug() {} }, jQuery: () => chain, $: () => chain, window: {},
        SillyTavern: { getContext: () => host } });
    vm.runInContext(source, sandbox);
    const call = (name, ...args) => { sandbox.args = args; return vm.runInContext(`${name}(...args)`, sandbox); };
    return { host, call, evaluate: expression => vm.runInContext(expression, sandbox),
        start() { call('onGenerationStarted', 'normal', {}, false); call('captureGenerationHistory', core(), 100000, () => {}, 'normal'); },
        prompt(chat, managerMessages = chat) {
            sandbox.manager = { messages: { getCollection: () => [{ identifier: 'chatHistory', getCollection: () => managerMessages.map((message, index) => ({ ...message, identifier: `chatHistory-${index}` })) }] } };
            vm.runInContext('nativeOpenAIModule = { promptManager: manager }', sandbox);
            call('onPromptReady', { chat, dryRun: false });
        },
        final(chat) { call('onSettingsReady', { type: 'normal', chat_completion_source: 'vertexai', messages: chat }); },
    };
}

test('verified native message identities survive one in-place template pass without executing it again', () => {
    const h = harness(); h.start(); const prepared = messages(); h.prompt(prepared);
    assert.equal(h.evaluate('generationHistorySnapshot.identityGroups.length'), 1);
    let templateCalls = 0;
    for (const message of prepared) if (['user', 'assistant'].includes(message.role)) {
        templateCalls++; message.content = message.role === 'assistant' ? '模板加工后的完整正文，与原字符串不同。' : '数据库重新包装后的完整本轮输入与纪要。';
    }
    const final = prepared.filter(Boolean); // Native createGenerationParameters keeps message references.
    h.final(final);
    assert.equal(templateCalls, 2); assert.equal(final.at(-1).content, '本轮动态资料。');
    assert.deepEqual(plain(h.call('findHistoryRange', final)), { start: 1, end: 2 });
    assert.deepEqual(plain(h.call('findHistoryRange', JSON.parse(JSON.stringify(final)))), { start: 1, end: 2 });
    assert.ok(h.evaluate('generationDiagnostics.events.some(event => event.event === "processed-confirmed")'));
    assert.ok(h.evaluate('generationDiagnostics.events.some(event => event.event === "identity-final-confirmed")'));
});

test('identity witnesses are never transferred to cloned, missing, repeated or role-changed messages', () => {
    for (const mode of ['clone', 'delete', 'duplicate-reference', 'change-role', 'quote-new-object', 'reorder']) {
        const h = harness(); h.start(); const original = messages(); h.prompt(original);
        let final = original.slice();
        if (mode === 'clone') final = structuredClone(original);
        if (mode === 'delete') final.splice(1, 1);
        if (mode === 'duplicate-reference') final.splice(1, 0, original[1]);
        if (mode === 'change-role') original[1].role = 'user';
        if (mode === 'quote-new-object') final.splice(0, 0, { ...original[1] });
        if (mode === 'reorder') [final[1], final[3]] = [final[3], final[1]];
        const before = structuredClone(final); h.final(final);
        assert.deepEqual(final, before, mode); assert.equal(h.call('findHistoryRange', final), null, mode);
    }
});

test('a helper clone cannot consume or inherit a main identity chain, and main still finishes later', () => {
    const h = harness(); h.start(); const main = messages(); h.prompt(main);
    const helper = structuredClone(main); helper[1].content = '辅助模型改写的其他正文。'; helper[3].content = '辅助模型输入。';
    h.prompt(helper); const helperBefore = structuredClone(helper); h.final(helper);
    assert.deepEqual(helper, helperBefore); assert.equal(h.evaluate('generationScope.settingsHandled'), false);
    main[1].content = '主模板最终正文。'; main[3].content = '主数据库最终输入。'; h.final(main);
    assert.equal(main.at(-1).content, '本轮动态资料。');
});

test('independently verified helper and main candidates do not overwrite each other', () => {
    const h = harness(); h.start(); const helper = messages(); h.prompt(helper);
    const main = messages(); h.prompt(main);
    assert.equal(h.evaluate('generationHistorySnapshot.identityGroups.length'), 2);
    main[1].content = '主模板最终正文。'; main[3].content = '主数据库最终输入。'; h.final(main);
    assert.equal(main.at(-1).content, '本轮动态资料。');
});

test('a macro change before the initial native full-text proof remains unsupported and skipped', () => {
    const h = harness(); h.start(); const prepared = messages(); prepared[1].content = 'preparePrompt 已展开宏的不同正文。';
    h.prompt(prepared); assert.equal(h.evaluate('generationHistorySnapshot.identityGroups.length'), 0);
    const before = structuredClone(prepared); h.final(prepared);
    assert.deepEqual(prepared, before); assert.equal(h.call('findHistoryRange', prepared), null);
});

test('an internal duplicate quote prevents initial whole-sequence identity authorization', () => {
    const h = harness();
    const extendedCore = [core()[0], { is_user: true, mes: '继续' }, { is_user: false, mes: '第二段独特实际正文。' }, core()[1]];
    h.call('onGenerationStarted', 'normal', {}, false); h.call('captureGenerationHistory', extendedCore, 100000, () => {}, 'normal');
    const prepared = [{ role: 'assistant', content: extendedCore[0].mes }, { role: 'user', content: '继续' },
        { role: 'user', content: '继续' }, { role: 'assistant', content: extendedCore[2].mes }, { role: 'user', content: extendedCore[3].mes }];
    h.prompt(prepared); assert.equal(h.evaluate('generationHistorySnapshot.identityGroups.length'), 0);
});
