'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));

function harness(overrides = {}) {
    const host = {
        extensionSettings: {}, chatCompletionSettings: { chat_completion_source: 'vertexai' },
        extensionPrompts: {}, chat: [], saveSettingsDebounced() {}, ...overrides,
    };
    // Do not run ready callbacks, attach listeners, import the host or send requests.
    const sandbox = vm.createContext({
        structuredClone, SillyTavern: { getContext: () => host }, jQuery() {},
        console: { info() {}, debug() {}, warn() {}, error() {} },
        setTimeout, clearTimeout,
    });
    vm.runInContext(source, sandbox, { filename: 'index.js' });
    return {
        host,
        route(entries) {
            sandbox.__entries = entries;
            vm.runInContext('routeEntries([__entries])', sandbox);
            return entries;
        },
        settings(values) {
            sandbox.__settings = values;
            vm.runInContext('Object.assign(settings(), __settings)', sandbox);
        },
    };
}

function entry(overrides = {}) {
    return {
        uid: 1, world: 'synthetic-world', comment: 'synthetic entry',
        content: 'PAYLOAD!', constant: false, key: ['needle'], keysecondary: [],
        position: 0, depth: 4, role: 0, order: 100,
        ...overrides,
    };
}

/**
 * Small independent fixture for the host rules relevant to these regressions:
 * descending order, constant/key activation, generation filters, shared budget
 * and minimum-activation scan expansion. One character is one token unit here;
 * this deliberately tests admission rules, not a real model's tokenizer.
 * No installed SillyTavern files, user data or network services are required.
 */
function scan(entries, { chat = ['unrelated'], budget = 10000, minimum = 0, trigger = 'normal' } = {}) {
    const sorted = [...entries].sort((a, b) => b.order - a.order);
    const activated = new Map();
    let depth = 1;
    let overflow = false;
    do {
        let pending = '';
        const prior = [...activated.values()].map(item => item.content + '\n').join('');
        for (const item of sorted) {
            if (activated.has(item.uid) || item.disable) continue;
            if (item.triggers?.length && !item.triggers.includes(trigger)) continue;
            if (!item.constant && !item.key.some(key => chat.slice(0, depth).join('\n').includes(key))) continue;
            if (overflow && !item.ignoreBudget) continue;
            pending += item.content + '\n';
            if (!item.ignoreBudget && prior.length + pending.length >= budget) {
                overflow = true;
                continue;
            }
            activated.set(item.uid, item);
        }
        if (overflow || activated.size >= minimum || depth >= chat.length) break;
        depth++;
    } while (true);
    return [...activated.values()];
}

test('unmatched keyword entries do not create constant wrappers or activate their Quick Reply automation', () => {
    const h = harness();
    const rows = [entry({ automationId: 'synthetic-automation' })];
    h.route(rows);
    const active = scan(rows);
    assert.equal(active.length, 0);
    assert.equal(rows.length, 1);
    assert.deepEqual(active.map(item => item.automationId).filter(Boolean), []);
});

test('routing adds no budget-consuming decoration that can displace a real entry', () => {
    const h = harness();
    const original = [entry({ comment: 'TavernDB-ACU-synthetic', constant: true })];
    const rows = structuredClone(original);
    h.route(rows);
    assert.deepEqual(scan(original, { budget: 15 }).map(item => item.uid), [1]);
    assert.deepEqual(scan(rows, { budget: 15 }).map(item => item.uid), [1]);
    assert.equal(rows[0].content, original[0].content);
});

test('synthetic entries cannot satisfy minimum activations before deeper keyword scanning', () => {
    const h = harness();
    const rows = [entry({ key: ['deepKey'] })];
    h.route(rows);
    const active = scan(rows, { minimum: 1, chat: ['unrelated', 'deepKey'] });
    assert.deepEqual(active.map(item => item.uid), [1]);
    assert.equal(active[0].content, 'PAYLOAD!');
});

test('fixed user and assistant depth entries retain their native role and depth under either preset order', () => {
    for (const role of [1, 2]) {
        for (const order of [
            [{ identifier: 'worldInfoBefore' }, { identifier: 'chatHistory' }],
            [{ identifier: 'chatHistory' }, { identifier: 'worldInfoBefore' }],
        ]) {
            const h = harness({ chatCompletionSettings: {
                chat_completion_source: 'vertexai', prompt_order: [{ character_id: 100001, order }],
            } });
            const rows = [entry({ constant: true, position: 4, depth: 2, role })];
            const before = structuredClone(rows);
            h.route(rows);
            assert.deepEqual(plain(rows), before);
        }
    }
});

test('author-note entries stay in their native slot because their effective role belongs to the note', () => {
    const h = harness({ extensionPrompts: { '2_floating_prompt': { role: 1, value: 'synthetic note' } } });
    const rows = [entry({ constant: true, position: 2 }), entry({ uid: 2, constant: true, position: 3 })];
    const before = structuredClone(rows);
    h.route(rows);
    assert.deepEqual(plain(rows), before);
});

test('native system depth entries can still be hoisted without creating separate activation records', () => {
    const h = harness();
    const rows = [entry({ constant: true, position: 4, depth: 2, role: 0 })];
    h.route(rows);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].position, 0);
    assert.equal(rows[0].role, 0);
    assert.equal(rows[0].content, 'PAYLOAD!');
});

test('candidate filters and activation metadata belong only to their original entry and source data is untouched', () => {
    const h = harness();
    const original = [entry({
        automationId: 'synthetic-automation', triggers: ['continue'], ignoreBudget: true,
        delayUntilRecursion: 2, characterFilter: { names: ['synthetic-character'], isExclude: false },
        sticky: 3, cooldown: 4, delay: 5,
    })];
    const before = structuredClone(original);
    // The host creates per-scan entry objects. Only this copy is handed to routing.
    const rows = original.map(item => ({ ...item }));
    h.route(rows);
    assert.equal(rows.length, 1);
    for (const field of ['automationId', 'triggers', 'ignoreBudget', 'delayUntilRecursion', 'characterFilter', 'sticky', 'cooldown', 'delay']) {
        assert.deepEqual(plain(rows[0][field]), before[0][field]);
    }
    assert.deepEqual(original, before);
    assert.deepEqual(scan(rows, { trigger: 'normal' }), []);
});

test('sticky and top-depth paths do not manufacture always-active wrapper entries', () => {
    const h = harness({ chatCompletionSettings: {
        chat_completion_source: 'custom',
        prompt_order: [{ character_id: 100001, order: [{ identifier: 'chatHistory' }, { identifier: 'worldInfoBefore' }] }],
    } });
    h.settings({ stickyLore: true, stickyTurns: 6 });
    const rows = [entry(), entry({ uid: 2, constant: true, order: 200 })];
    h.route(rows);
    assert.equal(rows.length, 2);
    assert.equal(rows[0].depth, 10000);
    assert.equal(rows[0].sticky, 6);
    assert.equal(rows[1].depth, 10000);
    assert.deepEqual(scan(rows).map(item => item.uid), [2]);
});
