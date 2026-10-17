'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const source = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
const HISTORY = '上一轮真实发生的故事，旅客在月台上确认了车次，并将行李放在长椅旁。';
const USER = '我转身询问站务员，下一班前往渡口的列车什么时候抵达。';
const FIXED = '固定世界规则：列车按时刻表运行，角色回答保持既定叙事格式。';
const SIGNATURE = 'offline-vertex-stored-thought-signature';
const PLACEHOLDER = '【固定规则已置于系统指令】';
const MAIN_TYPES = ['normal', 'regenerate', 'swipe'];
const plain = value => JSON.parse(JSON.stringify(value));

function harness() {
    const host = { extensionSettings: {}, chatCompletionSettings: { chat_completion_source: 'vertexai' },
        chat: [{ is_user: false, mes: HISTORY }, { is_user: true, mes: USER }],
        getCurrentChatId: () => 'vertex-retry-fixture', saveSettingsDebounced() {} };
    const sandbox = vm.createContext({ structuredClone, SillyTavern: { getContext: () => host }, jQuery() {},
        console: { info() {}, warn() {}, error() {} }, setTimeout, clearTimeout });
    vm.runInContext(source, sandbox);
    return { call(name, ...args) { sandbox.__args = args; return vm.runInContext(`${name}(...__args)`, sandbox); } };
}

function fixture(type = 'normal', live = '当前站台为三号，刚召回的纪要保持实时。') {
    return { type, chat_completion_source: 'vertexai', model: 'gemini-3.1-flash-lite', messages: [
        { role: 'system', content: '固定首规则。' },
        { role: 'user', content: '预设中的示范问题。' },
        { role: 'assistant', content: '预设中的示范回答。' },
        { role: 'system', content: FIXED },
        { role: 'assistant', content: HISTORY, signature: SIGNATURE },
        { role: 'user', content: USER },
        { role: 'system', content: `<最新数据与记录>\n${live}\n</最新数据与记录>` },
    ] };
}

test('Vertex normal, regenerate and swipe share the same fixed head and preserve live text and signed history', () => {
    const h = harness();
    h.call('settings').compatGeminiProxy = true;
    const heads = [];
    for (const [ordinal, type] of MAIN_TYPES.entries()) {
        const live = `本轮召回纪要编号 ${ordinal + 1}，当前站台随本次请求更新。`;
        const body = fixture(type, live);
        const signed = body.messages.find(message => message.signature);
        const dynamic = body.messages.at(-1).content;
        const result = h.call('applyGeminiProxyLayout', body);
        assert.equal(result.applied, true, type);
        assert.equal(body.type, type);
        assert.equal(body.chat_completion_source, 'vertexai');
        assert.equal(body.messages.filter(message => message.role === 'system').length, 1);
        assert.equal(body.messages[0].content, `固定首规则。\n\n${FIXED}`);
        assert.equal(body.messages.at(-1).role, 'user');
        assert.equal(body.messages.at(-1).content, dynamic);
        assert.equal(body.messages.map(message => message.content).join('').split(live).length - 1, 1);
        assert.equal(body.messages.filter(message => message.content === HISTORY).length, 1);
        assert.equal(body.messages.filter(message => message.signature).length, 1);
        assert.equal(body.messages.find(message => message.signature), signed);
        assert.equal(signed.signature, SIGNATURE);
        const signedIndex = body.messages.indexOf(signed);
        assert.equal(body.messages[signedIndex - 1].role, 'user');
        assert.equal(body.messages[signedIndex - 1].content, PLACEHOLDER);
        assert.equal(body.messages.filter(message => message.content === PLACEHOLDER).length, 1);
        assert.ok(!body.messages[0].content.includes(live));
        heads.push(body.messages[0].content);
    }
    assert.equal(new Set(heads).size, 1);
});

test('the Vertex retry layout remains opt-in for all supported main request types', () => {
    const h = harness();
    for (const type of MAIN_TYPES) {
        const body = fixture(type), before = structuredClone(body);
        assert.equal(h.call('applyGeminiProxyLayout', body).reason, 'disabled');
        assert.deepEqual(plain(body), before);
    }
});

test('only Vertex requests can use this fixed-head layout even when another source names a Gemini model', () => {
    const h = harness();
    h.call('settings').compatGeminiProxy = true;
    for (const source of ['custom', 'makersuite', 'openai', undefined]) {
        for (const type of MAIN_TYPES) {
            const body = fixture(type);
            body.chat_completion_source = source;
            const before = plain(body);
            assert.equal(h.call('applyGeminiProxyLayout', body).reason, 'connection');
            assert.deepEqual(plain(body), before);
        }
    }
});

test('continue prefill and non-main Vertex requests are preserved verbatim', () => {
    const h = harness();
    h.call('settings').compatGeminiProxy = true;
    for (const type of ['continue', 'quiet', 'impersonate', 'unknown', undefined]) {
        const body = fixture();
        body.type = type;
        const before = plain(body);
        const result = h.call('applyGeminiProxyLayout', body);
        assert.equal(result.applied, false);
        assert.equal(result.reason, type === 'continue' ? 'continue-prefill' : 'non-main');
        assert.deepEqual(plain(body), before);
    }
});
