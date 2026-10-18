'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const source = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');

function harness() {
    const host = { mainApi: 'openai', extensionSettings: {}, characterId: 1,
        chatCompletionSettings: { chat_completion_source: 'vertexai',
            preset_settings_openai: 'synthetic-preset', prompts: [{ identifier: 'rule', role: 'system', content: 'Original rule' }] },
        chat: [{ is_user: false, mes: '上轮的独立实际回答。' }, { is_user: true, mes: '本轮的独立实际输入。' }],
        getCurrentChatId: () => 'structure-test-chat', saveSettingsDebounced() {} };
    const chain = new Proxy({}, { get: () => () => chain });
    const sandbox = vm.createContext({ structuredClone, setTimeout, clearTimeout,
        console: { info() {}, warn() {}, error() {}, debug() {} }, jQuery: () => chain, $: () => chain,
        SillyTavern: { getContext: () => host } });
    vm.runInContext(source, sandbox);
    return { host, call(name, ...args) { sandbox.args = args; return vm.runInContext(`${name}(...args)`, sandbox); } };
}

const history = () => [{ role: 'assistant', content: '上轮的独立实际回答。' },
    { role: 'user', content: '本轮的独立实际输入。' }];
const plain = value => JSON.parse(JSON.stringify(value));

test('new and migrated settings default to protecting preset structure and leave fixed-head packing opt-in', () => {
    const h = harness();
    h.host.extensionSettings.cacheOptimizer = { enabled: true, hoistStatic: true };
    assert.equal(h.call('settings').preserveStructure, true);
    assert.equal(h.call('settings').compatGeminiProxy, false);
});

test('literal template examples inside fixed preset rules do not authorize final-message relocation', () => {
    const h = harness();
    const chat = [{ role: 'system', content: '模板语法说明：\n文档中的 {{random::左,右}} 表示示例语法。' }, ...history()];
    const before = structuredClone(chat);
    assert.equal(h.call('reorder', chat), 0);
    assert.deepEqual(chat, before);
});

test('an incomplete or repeated wrapper does not identify a final system block as dynamic', () => {
    const h = harness();
    for (const content of ['<当前剧情相关设定>\nIncomplete documentation.',
        '<当前剧情相关设定>\nOne.\n</当前剧情相关设定>\nFixed instructions outside.',
        '<当前剧情相关设定>\n<当前剧情相关设定>\nNested.\n</当前剧情相关设定>']) {
        const chat = [{ role: 'system', content }, ...history()], before = structuredClone(chat);
        assert.equal(h.call('reorder', chat), 0);
        assert.deepEqual(chat, before);
    }
});

test('default sorting keeps fixed demonstrations, unknown interleaved systems, roles and metadata verbatim', () => {
    const h = harness();
    const [assistant, user] = history();
    const chat = [{ role: 'system', content: '首部固定规则。' }, { role: 'user', content: '固定示范问题。' },
        { role: 'assistant', content: '固定示范回答。', signature: 'demo-signature' },
        { role: 'system', content: '示范之后的固定规则。' }, assistant,
        { role: 'system', content: '预设要求在历史中间保留的规则。', name: 'keep-metadata' }, user,
        { role: 'system', content: '预设的末尾固定规则。' }];
    const before = structuredClone(chat);
    assert.equal(h.call('reorder', chat), 0);
    assert.deepEqual(chat, before);
});

test('known dynamic records move after history without moving an adjacent unknown fixed system', () => {
    const h = harness(), [assistant, user] = history();
    const fixed = { role: 'system', content: '保持在这个位置的固定规则。' };
    const dynamic = { role: 'system', content: '<最新数据与记录>\n本轮召回发生变化。\n</最新数据与记录>' };
    const chat = [{ role: 'system', content: '首部规则。' }, assistant, fixed, dynamic, user];
    h.call('splitKnownDynamicBlocks', chat);
    assert.equal(h.call('reorder', chat), 1);
    assert.equal(chat[2], fixed);
    assert.equal(chat[3], user);
    assert.equal(chat[4].content, dynamic.content);
    assert.equal(JSON.stringify(chat).includes('__cacheopt'), false);
});

test('protected output rules cannot be learned or relocated by stale learned records in either layout', () => {
    for (const preserveStructure of [true, false]) {
        const h = harness();
        h.call('settings').preserveStructure = preserveStructure;
        for (const version of ['one', 'two', 'three']) {
            const chat = [{ role: 'system', content: `output_format\n${version}` }, ...history()];
            assert.deepEqual(plain(h.call('learnFrom', chat)), []);
        }
        h.call('rememberLearnedHeads', ['output_format']);
        const chat = [history()[0], { role: 'system', content: 'output_format\nlatest' }, history()[1]];
        const before = structuredClone(chat);
        assert.equal(h.call('reorder', chat), 0);
        assert.deepEqual(chat, before);
    }
});

test('learning is bound to preset source, enabled order and name as well as character and chat', () => {
    for (const change of [
        cc => { cc.preset_settings_openai = 'another-preset'; },
        cc => { cc.prompts[0].content = 'Updated fixed rule'; },
        cc => { cc.prompts[0].role = 'user'; },
        cc => { cc.prompt_order = [{ character_id: 100001, order: [{ identifier: 'chatHistory' }, { identifier: 'rule' }] }]; },
    ]) {
        const h = harness();
        for (const version of ['one', 'two', 'three']) h.call('learnFrom', [
            { role: 'system', content: `General rules\n${version}` }, ...history()]);
        assert.deepEqual(plain(h.call('learnedHeadsForScope')), ['General rules']);
        const initialKey = h.call('learningScopeKey');
        change(h.host.chatCompletionSettings);
        assert.notEqual(h.call('learningScopeKey'), initialKey);
        assert.deepEqual(plain(h.call('learnedHeadsForScope')), []);
        const chat = [{ role: 'system', content: 'General rules\nNew fixed preset rule.' }, ...history()];
        assert.equal(h.call('reorder', chat), 0);
        assert.deepEqual(plain(h.call('learnFrom', chat)), []);
    }
});

test('known wrappers with unknown message metadata are never split into duplicate metadata copies', () => {
    const h = harness();
    const chat = [{ role: 'system', content: 'Rules.\n<最新数据与记录>\nCurrent.\n</最新数据与记录>', signature: 'system-metadata' }, ...history()];
    const before = structuredClone(chat);
    h.call('splitKnownDynamicBlocks', chat);
    assert.deepEqual(chat, before);
});

test('complete card runtime records leave static system fragments and their roles in their original order', () => {
    const h = harness();
    const runtime = '【本轮江湖介入】启用后第4轮；实际玩家回合序号4，玩家楼层7。每轮独立处理，同轮续写不新开第二个事件。';
    const chat = [{ role: 'system', content: `固定开头。\n${runtime}\n固定结尾。` }, ...history()];
    h.call('splitKnownDynamicBlocks', chat);
    assert.equal(h.call('reorder', chat), 1);
    assert.deepEqual(chat.slice(0, 2).map(m => [m.role, m.content]), [
        ['system', '固定开头。\n'], ['system', '\n固定结尾。']]);
    assert.deepEqual(plain(chat.at(-1)), { role: 'system', content: runtime });
    assert.equal(chat.map(m => m.content).join('').split(runtime).length - 1, 1);
});

test('a twice-changing interleaved system can be learned without moving another fixed interleaved rule', () => {
    const h = harness();
    let chat;
    for (const version of ['one', 'two', 'three']) {
        chat = [history()[0], { role: 'system', content: 'Fixed instructions\nRemain here.' },
            { role: 'system', content: `Changing context\n${version}` }, history()[1]];
        h.call('learnFrom', chat);
    }
    const fixed = chat[1];
    assert.deepEqual(plain(h.call('learnedHeadsForScope')), ['Changing context']);
    assert.equal(h.call('reorder', chat), 1);
    assert.equal(chat[1], fixed);
    assert.equal(chat.at(-1).content, 'Changing context\nthree');
});
