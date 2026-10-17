'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const source = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
const core = [{ is_user: false, name: '旅客', mes: '用于生命周期验证的完整实际回答。' }, { is_user: true, name: '玩家', mes: '继续调查下一处地点。' }];
const messages = () => [{ role: 'system', content: '固定规则。' }, { role: 'assistant', content: core[0].mes },
    { role: 'system', content: '这一轮变化的资料。' }, { role: 'user', content: core[1].mes }];
function harness() {
    const host = { mainApi: 'openai', chatCompletionSettings: { chat_completion_source: 'vertexai' },
        extensionSettings: {}, chat: structuredClone(core), getCurrentChatId: () => 'offline-lifecycle',
        saveSettingsDebounced() {}, eventTypes: {}, eventSource: { on() {}, removeListener() {}, makeLast() {} } };
    const panels = new Map();
    const chain = new Proxy({}, { get: () => () => chain });
    const jquery = selector => typeof selector !== 'string' ? chain : new Proxy({}, { get: (_target, method) => (...args) => {
        if (method === 'text' && args.length) panels.set(selector, args[0]);
        if (method === 'attr' && args.length > 1) panels.set(`${selector}:${args[0]}`, args[1]);
        return chain;
    } });
    const sandbox = vm.createContext({ SillyTavern: { getContext: () => host }, jQuery: () => chain, $: () => chain,
        console: { info() {}, warn() {}, error() {}, debug() {} }, structuredClone, setTimeout, clearTimeout,
        URL, TextDecoder, Response, ReadableStream, AbortController, window: {} });
    sandbox.jQuery = jquery; sandbox.$ = jquery;
    vm.runInContext(source, sandbox);
    return { call(name, ...args) { sandbox.args = args; return vm.runInContext(`${name}(...args)`, sandbox); },
        evaluate: expression => vm.runInContext(expression, sandbox), panels, host, window: sandbox.window };
}

test('TavernHelper task STOP before the official core hook preserves the outer native generation', () => {
    const h = harness(); h.call('onGenerationStarted', 'normal', {}, false);
    h.call('onGenerationStopped', '8d817f8c-0049-4c7f-a5fb-offline-task');
    assert.notEqual(h.evaluate('generationScope'), null);
    h.call('captureGenerationHistory', structuredClone(core), 100000, () => {}, 'normal');
    assert.equal(h.call('isMainGenerationScope'), true);
    const body = { type: 'normal', chat_completion_source: 'vertexai', messages: messages() };
    h.call('onSettingsReady', body);
    assert.equal(body.messages.at(-1).content, '这一轮变化的资料。');
});

test('TavernHelper task STOP after the core hook preserves confirmed provenance', () => {
    const h = harness(); h.call('onGenerationStarted', 'normal', {}, false);
    h.call('captureGenerationHistory', structuredClone(core), 100000, () => {}, 'normal');
    h.call('onGenerationStopped', 'another-offline-task');
    assert.equal(h.call('isMainGenerationScope'), true);
    assert.equal(h.call('confirmFinalHistory', messages()), true);
});

test('the native no-argument STOP and unknown STOP shapes still invalidate all history permission', () => {
    for (const args of [[], [undefined], [null], [0], ['']]) {
        const h = harness(); h.call('onGenerationStarted', 'normal', {}, false);
        h.call('captureGenerationHistory', structuredClone(core), 100000, () => {}, 'normal');
        h.call('onGenerationStopped', ...args);
        assert.equal(h.call('isMainGenerationScope'), false);
        assert.equal(h.evaluate('generationHistorySnapshot'), null);
    }
});

test('unconfirmed history still observes explicit Vertex API cache usage without authorizing rewriting', async () => {
    const h = harness();
    const body = { type: 'normal', chat_completion_source: 'vertexai', model: 'gemini-offline', messages: [{ role: 'user', content: '与当前历史不同的完整请求。' }] };
    const before = structuredClone(body);
    const request = h.call('recordRealRequest', JSON.stringify(body));
    assert.equal(request.historyConfirmed, false); assert.equal(request.history, null);
    assert.equal(h.call('isMainGenerationScope'), false);
    await h.call('observeUsage', new Response(JSON.stringify({ usageMetadata: { promptTokenCount: 10000, cachedContentTokenCount: 7000 } })), request);
    assert.match(h.panels.get('#cacheopt_usage'), /70\.0%/);
    assert.deepEqual(body, before);
});

test('read-only usage requires an explicit main generation type and never defaults helper types to normal', () => {
    const h = harness();
    for (const type of [undefined, '', 'quiet', 'impersonate', 'continue']) {
        assert.equal(h.call('recordRealRequest', JSON.stringify({ type, chat_completion_source: 'vertexai', messages: messages() })), null);
    }
    for (const type of ['normal', 'regenerate', 'swipe']) {
        assert.notEqual(h.call('recordRealRequest', JSON.stringify({ type, chat_completion_source: 'vertexai', messages: messages() })), null);
    }
});

test('an unconfirmed attempt prevents comparisons from jumping back to an older confirmed request', () => {
    const h = harness(); h.call('onGenerationStarted', 'normal', {}, false);
    h.call('captureGenerationHistory', structuredClone(core), 100000, () => {}, 'normal');
    const body = { type: 'normal', chat_completion_source: 'vertexai', model: 'gemini-offline', messages: messages() };
    assert.equal(h.call('recordRealRequest', JSON.stringify(body)).historyConfirmed, true);
    assert.equal(h.call('recordRealRequest', JSON.stringify({ ...body, messages: [{ role: 'user', content: '无法确认的请求。' }] })).historyConfirmed, false);
    h.call('recordRealRequest', JSON.stringify(body));
    assert.match(h.panels.get('#cacheopt_real'), /保守跳过前缀比较/);
    assert.equal(h.evaluate('recentReal.length'), 3);
});

test('lifecycle diagnostics expose event order and counts without prompt text or task IDs', () => {
    const h = harness(); h.call('onGenerationStarted', 'normal', {}, false);
    h.call('onGenerationStopped', 'private-helper-task-id');
    h.call('captureGenerationHistory', structuredClone(core), 100000, () => {}, 'normal');
    h.call('confirmFinalHistory', messages()); h.call('onGenerationEnded');
    const title = h.panels.get('#cacheopt_last:title');
    assert.match(title, /stop-helper-id/); assert.match(title, /history-confirmed/); assert.match(title, /ended/);
    assert.ok(!title.includes(core[0].mes)); assert.ok(!title.includes('private-helper-task-id')); assert.ok(!title.includes('offline-lifecycle'));
    assert.ok(h.evaluate('generationDiagnostics.events.length') <= 30);
});

test('helper cleanup END before the official core preserves only the pending native START', () => {
    const h = harness(); h.call('onGenerationStarted', 'normal', {}, false);
    h.call('onGenerationEnded');
    assert.notEqual(h.evaluate('generationScope'), null);
    assert.equal(h.call('isMainGenerationScope'), false);
    assert.match(h.panels.get('#cacheopt_last:title'), /ended-before-core/);
    h.call('captureGenerationHistory', structuredClone(core), 100000, () => {}, 'normal');
    assert.equal(h.call('isMainGenerationScope'), true);
    const body = { type: 'normal', chat_completion_source: 'vertexai', messages: messages() };
    h.call('onSettingsReady', body); assert.equal(body.messages.at(-1).content, '这一轮变化的资料。');
    h.call('onGenerationEnded'); assert.equal(h.evaluate('generationScope'), null);
});

test('early END cannot revive real STOP, dryrun, quiet or a stale connection', () => {
    for (const scenario of ['native-stop', 'dryrun', 'quiet', 'connection-change']) {
        const h = harness(); h.call('onGenerationStarted', scenario === 'quiet' ? 'quiet' : 'normal', {}, scenario === 'dryrun');
        if (scenario === 'native-stop') h.call('onGenerationStopped');
        if (scenario === 'connection-change') h.host.chatCompletionSettings.chat_completion_source = 'custom';
        h.call('onGenerationEnded');
        assert.equal(h.evaluate('generationScope'), null, scenario);
        h.host.chatCompletionSettings.chat_completion_source = 'vertexai';
        h.call('captureGenerationHistory', structuredClone(core), 100000, () => {}, 'normal');
        assert.equal(h.call('isMainGenerationScope'), false, scenario);
    }
});

test('load-time diagnostics report the host loaded manifest and exact own global hook without generating', () => {
    const h = harness();
    h.call('reportHostHookStatus', {
        getExtensionManifest: name => name === 'ST-Cache-Optimizer' ? { version: '2.6.5', generate_interceptor: 'cacheOptimizerCaptureHistory' } : null,
        findExtension: () => ({ enabled: true }), runGenerationInterceptors() {},
    });
    const event = h.evaluate('generationDiagnostics.events.at(-1)');
    assert.equal(event.event, 'host-hook-status'); assert.equal(event.loadedVersion, '2.6.5');
    assert.equal(event.loadedHook, 'cacheOptimizerCaptureHistory'); assert.equal(event.ownGlobalMatches, true);
    assert.equal(event.hostInterceptorType, 'function'); assert.equal(event.extensionEnabled, true);
    assert.equal(h.evaluate('generationScope'), null);
});

test('load-time diagnostics distinguish missing cached metadata from a clobbered global hook', () => {
    const h = harness(); h.evaluate('globalThis.cacheOptimizerCaptureHistory = () => {}');
    h.call('reportHostHookStatus', { getExtensionManifest: () => ({ version: 'old-without-hook' }), findExtension: () => ({ enabled: false }) });
    const event = h.evaluate('generationDiagnostics.events.at(-1)');
    assert.equal(event.loadedManifest, true); assert.equal(event.loadedHook, null);
    assert.equal(event.ownGlobalType, 'function'); assert.equal(event.ownGlobalMatches, false);
    assert.equal(event.hostInterceptorType, 'undefined'); assert.equal(event.extensionEnabled, false);
});

test('a stale own manifest is reloaded through its exact URL without mutating the host registry', async () => {
    const h = harness(), loaded = { version: '2.5.2', js: 'index.js' }, calls = [];
    h.window.fetch = async (url, init) => { calls.push({ url, init }); return new Response(JSON.stringify({ version: '2.6.5', js: 'index.js', generate_interceptor: 'cacheOptimizerCaptureHistory' })); };
    const result = await h.call('refreshOwnManifestCache', {
        getExtensionManifest: () => loaded, findExtension: () => ({ name: 'third-party/ST-Cache-Optimizer', enabled: true }),
    });
    assert.equal(result, 'refreshed'); assert.equal(calls.length, 1);
    assert.equal(calls[0].url, '/scripts/extensions/third-party/ST-Cache-Optimizer/manifest.json');
    assert.equal(calls[0].init.cache, 'reload'); assert.equal(calls[0].init.method, 'GET');
    assert.equal(calls[0].init.credentials, 'same-origin'); assert.equal(loaded.generate_interceptor, undefined);
    assert.match(h.panels.get('#cacheopt_last'), /再次刷新.*再生成/);
    assert.equal(h.evaluate('generationScope'), null);
});

test('manifest refresh does not fetch other extensions, disabled registrations or already valid hooks', async () => {
    const h = harness(); let calls = 0; h.window.fetch = async () => { calls++; throw Error('must not fetch'); };
    for (const fixture of [
        { manifest: { generate_interceptor: 'cacheOptimizerCaptureHistory' }, name: 'third-party/ST-Cache-Optimizer', enabled: true },
        { manifest: {}, name: 'third-party/another-extension', enabled: true },
        { manifest: {}, name: 'third-party/ST-Cache-Optimizer', enabled: false },
        { manifest: {}, name: '../ST-Cache-Optimizer', enabled: true },
    ]) await h.call('refreshOwnManifestCache', { getExtensionManifest: () => fixture.manifest, findExtension: () => ({ name: fixture.name, enabled: fixture.enabled }) });
    assert.equal(calls, 0);
});

test('a manifest reload failure never authorizes history or silently claims a current host registration', async () => {
    const h = harness(); h.window.fetch = async () => new Response(JSON.stringify({ version: '2.5.2', js: 'index.js' }));
    assert.equal(await h.call('refreshOwnManifestCache', { getExtensionManifest: () => ({}), findExtension: () => ({ name: 'third-party/ST-Cache-Optimizer', enabled: true }) }), 'failed');
    assert.match(h.panels.get('#cacheopt_last'), /失败/); assert.equal(h.call('isMainGenerationScope'), false);
});
