'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
const plain = value => value == null ? value : JSON.parse(JSON.stringify(value));

function harness(chat, options = {}) {
    const host = {
        chat, extensionSettings: {}, mainApi: 'openai', name1: '玩家', name2: '旅客',
        getCurrentChatId: () => 'vertex-names', saveSettingsDebounced() {},
        eventSource: { on() {}, makeLast() {}, removeListener() {} }, eventTypes: {},
        chatCompletionSettings: { chat_completion_source: 'vertexai', ...options.settings },
        ...options.context,
    };
    const chain = new Proxy({}, { get: () => () => chain });
    const sandbox = vm.createContext({ SillyTavern: { getContext: () => host }, $: () => chain, jQuery: () => chain,
        window: {}, console: { info() {}, warn() {}, debug() {}, error() {} }, structuredClone, URL, TextDecoder,
        Response, ReadableStream, AbortController, setTimeout, clearTimeout });
    vm.runInContext(source, sandbox);
    const call = (name, ...args) => { sandbox.args = args; return vm.runInContext(`${name}(...args)`, sandbox); };
    return { host, call, start() { call('onGenerationStarted', 'normal', {}, false); call('captureGenerationHistory', chat, 100000, () => {}, 'normal'); } };
}

test('Vertex history predicts native NONE, DEFAULT, COMPLETION and CONTENT naming modes literally', () => {
    // Native openai.js character_names_behavior: -1 / 0 / 1 / 2.
    for (const [mode, expected] of [[-1, '旅客: 原本就是剧本格式。'], [0, '旅客: 原本就是剧本格式。'],
        [1, '旅客: 原本就是剧本格式。'], [2, '旅客: 旅客: 原本就是剧本格式。']]) {
        const raw = [{ is_user: false, name: '旅客', mes: '旅客: 原本就是剧本格式。' }];
        const before = structuredClone(raw), h = harness(raw, { settings: { names_behavior: mode } }); h.start();
        const messages = [{ role: 'assistant', content: expected }];
        assert.equal(h.call('confirmFinalHistory', messages), true, `native mode ${mode}`);
        assert.deepEqual(plain(h.call('findHistoryRange', messages)), { start: 0, end: 0 });
        assert.deepEqual(raw, before);
    }
});

test('a single-prefix injection cannot impersonate a double-prefixed native CONTENT history turn', () => {
    const raw = [{ is_user: false, name: '旅客', mes: '旅客: 原本就是剧本格式。' }, { is_user: true, name: '玩家', mes: '我继续前进。' }];
    const h = harness(raw, { settings: { names_behavior: 2 } }); h.start();
    const fixed = { role: 'system', content: '应当留在真实历史前面的固定世界规则。' };
    const messages = [{ role: 'system', content: '固定首规则。' }, { role: 'assistant', content: raw[0].mes }, fixed,
        { role: 'assistant', content: '旅客: 旅客: 原本就是剧本格式。' }, { role: 'user', content: '玩家: 我继续前进。' }];
    assert.equal(h.call('confirmFinalHistory', messages), true);
    assert.deepEqual(plain(h.call('findHistoryRange', messages)), { start: 3, end: 4 });
    assert.equal(h.call('reorder', messages), 0); assert.equal(messages[2], fixed);
    assert.equal(h.call('findHistoryRange', [{ role: 'assistant', content: raw[0].mes }, messages[4]]), null);
});

test('native DEFAULT adds a name only for group members or sendas avatars and never guesses extra prefixes', () => {
    const named = { is_user: false, name: '临时【路人】:/?·甲', mes: '临时【路人】:/?·甲: 本来就有标签的对白。' };
    const fixtures = [
        [{}, named.mes],
        [{ context: { groupId: 'group-test' } }, `临时【路人】:/?·甲: ${named.mes}`],
        [{ forceAvatar: true }, `临时【路人】:/?·甲: ${named.mes}`],
        [{ context: { groupId: 'group-test', name1: named.name } }, named.mes],
    ];
    for (const [options, expected] of fixtures) {
        const raw = [{ ...named, ...(options.forceAvatar ? { force_avatar: 'temporary-avatar' } : {}) }];
        const h = harness(raw, options); h.start();
        assert.equal(h.call('confirmFinalHistory', [{ role: 'assistant', content: expected }]), true);
        assert.equal(h.call('findRawHistoryRange', [{ role: 'assistant', content: `任意新增指令: ${expected}` }]), null);
    }
});

test('CONTENT handles literal long or temporary names without consulting a global name list', () => {
    const name = `${'长名称·'.repeat(25)}临时角色`;
    const raw = [{ is_user: false, name, mes: '完整的真实叙述。' }, { is_user: true, name: '玩家', mes: '继续' }];
    const h = harness(raw, { settings: { names_behavior: 2 } }); h.start();
    const messages = [{ role: 'assistant', content: `${name}: 完整的真实叙述。` }, { role: 'user', content: '玩家: 继续' }];
    assert.equal(h.call('confirmFinalHistory', messages), true);
    assert.deepEqual(plain(h.call('findHistoryRange', messages)), { start: 0, end: 1 });
    assert.equal(h.call('hasRawHistoryWitness', messages[0]), true);
    assert.equal(h.call('hasRawHistoryWitness', { role: 'assistant', content: raw[0].mes }), false);
});

test('safe raw fallback expects the current native name format without stripping source body text', () => {
    const raw = [{ is_user: false, name: '旅客', mes: '旅客: 原始剧本对白。' }, { is_user: true, name: '玩家', mes: '继续' }];
    const h = harness(raw, { settings: { names_behavior: 2 } });
    const messages = [{ role: 'assistant', content: '旅客: 旅客: 原始剧本对白。' }, { role: 'user', content: '玩家: 继续' }];
    assert.deepEqual(plain(h.call('findRawHistoryRange', messages)), { start: 0, end: 1 });
    assert.equal(h.call('findRawHistoryRange', [{ role: 'assistant', content: raw[0].mes }, messages[1]]), null);
    assert.equal(h.call('matchesHistoryText', { role: 'assistant', content: '旅客: 原始剧本对白。' }, { role: 'assistant', content: '原始剧本对白。' }), false);
});
