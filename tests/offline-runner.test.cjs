'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { canonical, firstDifference, compareMessages, nativeMessages, loadNativeConverter, createHarness,
    coreFromMessages, buildTurn, fidelity, runOffline, analyzeCaptures } = require('../tools/offline-runner.cjs');

test('six progressing turns intercept actual extension fetch and native converter, with distinct assistant replies', async () => {
    const report = await runOffline({ turns: 6, compareExperimental: true });
    assert.equal(report.networkRequests, 0);
    assert.equal(report.paidModelRequests, 0);
    assert.match(report.apiCacheUsage, /unknown/);
    assert.match(report.converter.sourceSHA256, /^[a-f0-9]{64}$/);
    assert.equal(report.converter.implementation, 'unmodified-host-functions-in-vm');
    assert.equal(report.converter.serverEndpointExecuted, false);
    for (const mode of report.modes) {
        assert.equal(mode.mainRequestsIntercepted, 6);
        assert.equal(mode.uniqueInputs, 6);
        assert.equal(mode.uniqueReplies, 6);
        assert.equal(mode.uniqueRecalls, 6);
        assert.equal(mode.finalChatFloors, 13);
        assert.equal(mode.comparisons.length, 5);
        assert.ok(mode.events.includes('generate_interceptor'));
        assert.ok(mode.events.includes('CHAT_COMPLETION_PROMPT_READY'));
        assert.ok(mode.events.includes('CHAT_COMPLETION_SETTINGS_READY'));
        assert.deepEqual(mode.rounds.map(round => round.historyMessageCount), [2, 4, 6, 8, 10, 12]);
        assert.ok(mode.rounds.every(round => round.fidelity.staticRulesExactlyOnce
            && round.fidelity.dynamicBlocksExactlyOnce && round.fidelity.historyMessagesExactlyOnce));
    }
    const normal = report.modes.find(mode => mode.mode === 'preserve-preset');
    const disabled = report.modes.find(mode => mode.mode === 'disabled');
    assert.ok(normal.rounds.every(round => round.fidelity.staticRolesPreserved && round.fidelity.staticRelativeOrderPreserved));
    assert.ok(normal.rounds.every(round => round.worldInfoRouted));
    assert.ok(disabled.rounds.every(round => !round.worldInfoRouted));
    assert.ok(normal.comparisons.every((pair, i) => pair.frontend.identicalPrefixMessages > disabled.comparisons[i].frontend.identicalPrefixMessages),
        'optimization must extend the prefix on differing inputs, not repeat the same request');
    assert.equal(new Set(normal.rounds.map(round => round.nativeSystemHeadSHA256)).size, 1);
    assert.ok(!JSON.stringify(report).includes('晋太元中'));
    assert.ok(!JSON.stringify(report).includes('固定预设任务'));
});

test('native converter preserves its actual merging, name and thought-signature behavior', () => {
    const converter = loadNativeConverter();
    const native = converter.convert({ model: 'gemini-2.5-flash', use_sysprompt: true,
        char_name: '守塔人', user_name: '玩家', messages: [
            { role: 'system', content: 'fixed-first' }, { role: 'system', content: 'fixed-second' },
            { role: 'assistant', content: 'hello', name: 'example_assistant', signature: 'signed' },
            { role: 'system', content: 'late-system' }, { role: 'user', content: 'latest-input' },
        ] });
    assert.deepEqual(native.system_instruction.parts, [{ text: 'fixed-first' }, { text: 'fixed-second' }]);
    assert.equal(native.contents[0].role, 'model');
    assert.equal(native.contents[0].parts[0].text, '守塔人: hello');
    assert.equal(native.contents[0].parts[0].thoughtSignature, 'signed');
    assert.equal(native.contents[1].role, 'user');
    assert.equal(native.contents[1].parts[0].text, 'late-system\n\nlatest-input');
    assert.equal(nativeMessages(native).length, 3);
});

test('sandbox rejects remote requests and unrelated localhost paths before any transport', async () => {
    const h = createHarness();
    for (const input of ['https://aiplatform.googleapis.com/v1/models/test:generateContent', '/api/other']) {
        await assert.rejects(() => h.window.fetch(input, { method: 'POST', body: '{}' }), /OFFLINE_NETWORK_BLOCKED/);
    }
    assert.equal(h.requests.length, 0);
    assert.equal(h.blockedNetworkAttempts, 2);
});

test('the intercepted response has no usage fields and its reply belongs to the assistant floor', async () => {
    const h = createHarness({ settings: { compatIzumi: true } });
    const history = [{ role: 'assistant', content: '开场楼层。' }], data = buildTurn(0, history);
    const result = await h.generate({ core: coreFromMessages(history), body: data.body, worldInfo: data.worldInfo,
        reply: data.reply.text });
    history.push({ role: 'assistant', content: result.reply });
    const core = coreFromMessages(history);
    assert.deepEqual(core.map(message => message.is_user), [false, true, false]);
    assert.equal(core[2].mes, data.reply.text);
    assert.equal(h.call('readUsage', { choices: [{ message: { role: 'assistant', content: result.reply } }] }), null);
    assert.equal(h.requests.length, 1);
});

test('fidelity detects changed preset roles, order and duplicated dynamic text', () => {
    const fixed = [{ role: 'user', content: 'fixed-a' }, { role: 'assistant', content: 'fixed-b' }];
    const check = messages => fidelity(fixed, { messages }, ['unique-dynamic'], []);
    const good = [...fixed, { role: 'system', content: 'unique-dynamic' }];
    assert.equal(check(good).staticRolesPreserved, true);
    assert.equal(check([{ ...fixed[0], role: 'system' }, ...good.slice(1)]).staticRolesPreserved, false);
    assert.equal(check([fixed[1], fixed[0], good[2]]).staticRelativeOrderPreserved, false);
    assert.equal(check([...good, good[2]]).dynamicBlocksExactlyOnce, false);
});

test('metadata and role differences appear in a structural path without prompt text', () => {
    const a = [{ role: 'system', content: 'private-body' }, { role: 'assistant', content: 'same', signature: 'first' }];
    const b = structuredClone(a); b[1].signature = 'second';
    const report = compareMessages(a, b);
    assert.equal(report.identicalPrefixMessages, 1);
    assert.equal(report.firstDifference.path, '/1/signature');
    assert.equal(report.commonPrefixSHA256.length, 64);
    assert.ok(!JSON.stringify(report).includes('private-body'));
    assert.equal(firstDifference({ 'private-field-name': 1 }, { 'private-field-name': 2 }).path, '/*');
    assert.equal(canonical({ b: 2, a: 1 }), canonical({ a: 1, b: 2 }));
});

test('chat export contains true alternating assistant/user floors and no repeated mocked answer', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cacheopt-chat-'));
    try {
        const file = path.join(directory, 'synthetic.jsonl');
        await runOffline({ turns: 6, chatOut: file });
        const lines = fs.readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse);
        assert.equal(lines[0].chat_metadata.synthetic, true);
        const chat = lines.slice(1);
        assert.equal(chat.length, 13);
        assert.ok(chat.every((message, i) => message.is_user === (i % 2 === 1)));
        const assistant = chat.filter(message => !message.is_user);
        assert.equal(new Set(assistant.map(message => message.mes)).size, 7);
        assert.ok(assistant.slice(1).every(message => message.name === '守塔人'));
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('private native/UI analysis never guesses the original roles or repeats old cache usage', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cacheopt-captures-'));
    try {
        for (const round of [1, 2]) {
            fs.writeFileSync(path.join(directory, `round-0${round}-native.json`), JSON.stringify({
                systemInstruction: { parts: [{ text: 'private fixed head' }] },
                contents: [{ role: 'user', parts: [{ text: `private turn ${round}` }] }],
            }));
            fs.writeFileSync(path.join(directory, `round-0${round}-ui.json`), JSON.stringify({
                round, trace: 'private diagnostic body', usage: 'old cached count 99999',
            }));
        }
        const report = await analyzeCaptures(directory, { replay: true });
        assert.equal(report.includedCaptures, 2);
        assert.equal(report.diagnosticOnlyCaptures, 2);
        assert.equal(report.comparisons[0].identicalPrefixMessages, 1);
        assert.equal(report.comparisons[0].firstDifference.path, '/1/parts/0/text');
        assert.equal(report.captures[0].replay, undefined);
        const output = JSON.stringify(report);
        assert.ok(!output.includes('private fixed'));
        assert.ok(!output.includes('private turn'));
        assert.ok(!output.includes('99999'));
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('frontend capture replay keeps requests unchanged when official history is unavailable', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cacheopt-frontend-'));
    try {
        fs.writeFileSync(path.join(directory, 'request.json'), JSON.stringify({ model: 'gemini-offline',
            messages: [{ role: 'system', content: 'private rule' }, { role: 'user', content: 'private input' }] }));
        const report = await analyzeCaptures(directory, { replay: true });
        assert.equal(report.captures[0].replay.extensionExecuted, true);
        assert.equal(report.captures[0].replay.officialHistoryAvailable, false);
        assert.equal(report.captures[0].replay.frontendMessagesUnchanged, true);
        assert.ok(!JSON.stringify(report).includes('private rule'));
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('missing converter and repeated-answer turn counts fail closed', async () => {
    assert.throws(() => loadNativeConverter({ path: path.join(os.tmpdir(), 'missing-cacheopt-native-converter.js') }), /NATIVE_CONVERTER_MISSING/);
    await assert.rejects(() => runOffline({ turns: 7 }), /turns must be 3\.\.6/);
    await assert.rejects(() => runOffline({ turns: 2 }), /turns must be 3\.\.6/);
});
