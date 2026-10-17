'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const source = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
const ENDPOINT = '/api/backends/chat-completions/generate';
const USER = '这是本地离线测试的当前用户输入，内容足够长，可以与真实聊天记录准确对应，但不会发送网络请求。';
const ORIGIN = 'http://localhost:8000';

function fixture() {
    return { type: 'normal', model: 'gemini-offline', chat_completion_source: 'custom', stream: true, messages: [
        { role: 'system', content: '固定系统规则。' },
        { role: 'user', content: USER },
        { role: 'system', content: '<最新数据与记录>当前一轮的动态资料。</最新数据与记录>' },
    ] };
}

function harness() {
    const host = { extensionSettings: {}, chatCompletionSettings: { chat_completion_source: 'custom' },
        chat: [{ is_user: true, mes: USER }], getCurrentChatId: () => 'offline-transport',
        saveSettingsDebounced() {}, eventTypes: {}, eventSource: {} };
    const chain = new Proxy({}, { get: () => () => chain });
    const sandbox = vm.createContext({ console: { info() {}, warn() {}, error() {} },
        structuredClone, setTimeout, clearTimeout, TextDecoder, URL, Response, ReadableStream, AbortController,
        window: { location: { href: `${ORIGIN}/`, origin: ORIGIN }, fetch: async () => new Response('{}') },
        jQuery: () => chain, $: () => chain, toastr: {}, SillyTavern: { getContext: () => host } });
    vm.runInContext(source, sandbox, { filename: 'index.js' });
    return { host, window: sandbox.window,
        call(name, ...args) { sandbox.__args = args; return vm.runInContext(`${name}(...__args)`, sandbox); },
        evaluate(value) { return vm.runInContext(value, sandbox); } };
}

test('body and method accessors are evaluated only by the original fetch, with optimization either off or on', async () => {
    for (const enabled of [false, true]) {
        const h = harness();
        h.call('settings').enabled = enabled;
        h.call('settings').compatGeminiProxy = true;
        let reads = 0, methodReads = 0, wire;
        const init = { get method() { methodReads++; return 'POST'; },
            get body() { reads++; return JSON.stringify({ ...fixture(), nonce: reads }); } };
        h.window.fetch = async (_input, received) => {
            assert.equal(received, init);
            wire = JSON.parse(await new Request(`${ORIGIN}${ENDPOINT}`, received).text());
            return new Response('{}');
        };
        h.call('watchRealRequests');
        await h.window.fetch(ENDPOINT, init);
        assert.equal(reads, 1);
        assert.equal(methodReads, 1);
        assert.equal(wire.nonce, 1);
        assert.equal(h.evaluate('recentReal.length'), 0);
    }
});

test('body accessors are skipped even when method is an ordinary POST data property', async () => {
    const h = harness();
    h.call('settings').compatGeminiProxy = true;
    let reads = 0;
    const init = { method: 'POST', get body() { reads++; return JSON.stringify(fixture()); } };
    h.window.fetch = async (_input, received) => { assert.equal(received, init); void received.body; return new Response('{}'); };
    h.call('watchRealRequests');
    await h.window.fetch(ENDPOINT, init);
    assert.equal(reads, 1);
    assert.equal(h.evaluate('recentReal.length'), 0);
});

test('an auxiliary marker accessor is conservatively skipped without invoking its getter', async () => {
    const h = harness();
    h.call('settings').compatGeminiProxy = true;
    let reads = 0, forwarded;
    const init = { method: 'POST', body: JSON.stringify(fixture()),
        get [Symbol.for('acu.internal-generation-fetch')]() { reads++; return true; } };
    h.window.fetch = async (_input, received) => { forwarded = received; return new Response('{}'); };
    h.call('watchRealRequests');
    await h.window.fetch(ENDPOINT, init);
    assert.equal(forwarded, init);
    assert.equal(reads, 0);
    assert.equal(h.evaluate('recentReal.length'), 0);
});

test('layout forwarding preserves non-enumerated Proxy dictionary fields, private getters and immutable original body', async () => {
    const h = harness();
    h.call('settings').compatGeminiProxy = true;
    const controller = new AbortController();
    const headers = { 'x-offline-test': 'preserved' };
    class Init {
        #credentials = 'same-origin';
        get credentials() { return this.#credentials; }
    }
    const target = new Init();
    target.method = 'POST';
    const raw = JSON.stringify(fixture());
    Object.defineProperty(target, 'body', { value: raw, enumerable: true, configurable: false, writable: false });
    const init = new Proxy(target, { get(object, key, receiver) {
        if (key === 'headers') return headers;
        if (key === 'signal') return controller.signal;
        return Reflect.get(object, key, receiver === init ? object : receiver);
    } });
    let forwarded, request;
    h.window.fetch = async (_input, received) => {
        forwarded = received;
        request = new Request(`${ORIGIN}${ENDPOINT}`, received);
        return new Response('{}');
    };
    h.call('watchRealRequests');
    await h.window.fetch(ENDPOINT, init);
    assert.notEqual(forwarded, init);
    assert.equal(forwarded.headers, headers);
    assert.equal(forwarded.signal, controller.signal);
    assert.equal(forwarded.credentials, 'same-origin');
    assert.equal(request.headers.get('x-offline-test'), 'preserved');
    assert.equal(init.body, raw);
    assert.notEqual(forwarded.body, raw);
    controller.abort();
    assert.equal(request.signal.aborted, true);
    // A subsequent transport wrapper may still add dictionary overrides.
    forwarded.credentials = 'omit';
    assert.equal(forwarded.credentials, 'omit');
});

test('only the exact same-origin generation endpoint with an explicit POST is observed or modified', async () => {
    const h = harness();
    h.call('settings').compatGeminiProxy = true;
    const raw = JSON.stringify(fixture());
    const skipped = [
        [`https://example.invalid${ENDPOINT}`, 'POST'],
        [`https://example.invalid/log?copy=${ENDPOINT}`, 'POST'],
        [`/log?copy=${ENDPOINT}`, 'POST'],
        [`${ENDPOINT}-other`, 'POST'],
        [`${ENDPOINT}/other`, 'POST'],
        [ENDPOINT, 'GET'], [ENDPOINT, 'PUT'], [ENDPOINT, undefined],
    ];
    let received;
    h.window.fetch = async (_input, init) => { received = init; return new Response('{}'); };
    h.call('watchRealRequests');
    for (const [url, method] of skipped) {
        const init = { body: raw, ...(method ? { method } : {}) };
        await h.window.fetch(url, init);
        assert.equal(received, init);
        assert.equal(received.body, raw);
        assert.equal(h.evaluate('recentReal.length'), 0);
    }
    const accepted = { method: 'post', body: raw };
    await h.window.fetch(`${ORIGIN}${ENDPOINT}?local=1`, accepted);
    assert.notEqual(received, accepted);
    assert.notEqual(received.body, raw);
    assert.equal(h.evaluate('recentReal.length'), 1);
});

function observer() {
    const h = harness();
    return { h, request: h.call('recordRealRequest', JSON.stringify(fixture())) };
}
const usage = 'data: {"usage":{"prompt_tokens":100,"prompt_tokens_details":{"cached_tokens":50}}}\n\n';

test('DONE completes observation before EOF and does not await cancellation of the cloned tee', async () => {
    const { h, request } = observer();
    let controller;
    const wire = usage + 'data: [DONE]\n\n';
    const response = new Response(new ReadableStream({ start(value) {
        controller = value;
        controller.enqueue(new TextEncoder().encode(wire));
    } }));
    const pending = h.call('observeUsage', response, request);
    try {
        const status = await Promise.race([pending.then(() => 'done'), new Promise(resolve => setTimeout(() => resolve('timeout'), 250))]);
        assert.equal(status, 'done');
        assert.match(h.call('settings').lastUsageReport, /50 \/ 输入 100（50\.0%）/);
        assert.equal(response.bodyUsed, false);
    } finally { controller.close(); await pending; }
    assert.equal(await response.text(), wire);
});

test('DONE ignores trailing bytes while native Gemini without DONE still finishes at a clean EOF', async () => {
    const first = observer();
    await first.h.call('observeUsage', new Response(usage + 'data: [DONE]\n\ndata: {"error":"post-terminal bytes"}\n\n'), first.request);
    assert.match(first.h.call('settings').lastUsageReport, /50 \/ 输入 100（50\.0%）/);
    const second = observer();
    await second.h.call('observeUsage', new Response('data: {"usageMetadata":{"promptTokenCount":100,"cachedContentTokenCount":50}}\n\n'), second.request);
    assert.match(second.h.call('settings').lastUsageReport, /50 \/ 输入 100（50\.0%）/);
});

test('explicit provider SSE errors leave an incomplete reason and remove the failed comparison baseline', async () => {
    const errors = ['event: error\ndata: {}\n\n', 'data: {"error":{"message":"offline failure"}}\n\n',
        'event: response.failed\ndata: {}\n\n', 'data: {"type":"response.incomplete"}\n\n'];
    for (const error of errors) {
        const { h, request } = observer();
        await h.call('observeUsage', new Response(usage + error), request);
        assert.match(h.call('settings').lastUsageReport, /未完成（接口返回错误事件）/);
        assert.doesNotMatch(h.call('settings').lastUsageReport, /%/);
        assert.equal(h.evaluate('recentReal.length'), 0);
    }
});

test('HTTP200 non-streaming provider errors also remove the failed baseline without a fabricated usage result', async () => {
    const { h, request } = observer();
    request.body.stream = false;
    const response = new Response(JSON.stringify({ error: { message: 'offline failure' }, usage: {
        prompt_tokens: 100, prompt_tokens_details: { cached_tokens: 50 } } }));
    await h.call('observeUsage', response, request);
    assert.match(h.call('settings').lastUsageReport, /未完成（接口返回错误事件）/);
    assert.doesNotMatch(h.call('settings').lastUsageReport, /%/);
    assert.equal(h.evaluate('recentReal.length'), 0);
    assert.equal(response.bodyUsed, false);
});

test('an older observer cannot overwrite a newer failure after that failed attempt leaves the baseline', async () => {
    const { h, request: older } = observer();
    let controller;
    const first = new Response(new ReadableStream({ start(value) {
        controller = value;
        controller.enqueue(new TextEncoder().encode(usage));
    } }));
    const pending = h.call('observeUsage', first, older);
    const newer = h.call('recordRealRequest', JSON.stringify(fixture()));
    await h.call('observeUsage', new Response('data: {"error":"newer request failed"}\n\n'), newer);
    const failure = h.call('settings').lastUsageReport;
    assert.match(failure, /未完成（接口返回错误事件）/);
    assert.equal(h.evaluate('recentReal.length'), 1);
    assert.equal(h.evaluate('latestRealAttempt'), newer);
    controller.close();
    await pending;
    assert.equal(h.call('settings').lastUsageReport, failure);
    assert.equal(first.bodyUsed, false);
});

test('an explicit stream AbortError removes its baseline while ordinary observer read or parse failures retain theirs', async () => {
    for (const mode of ['abort', 'read', 'parse']) {
        const { h, request } = observer();
        const response = mode === 'parse' ? new Response(usage + 'data: {bad-json}\n\n')
            : new Response(new ReadableStream({
                start(controller) { controller.enqueue(new TextEncoder().encode(usage)); },
                pull(controller) { controller.error(Object.assign(new Error('offline stream interruption'), {
                    name: mode === 'abort' ? 'AbortError' : 'TypeError',
                })); },
            }));
        await h.call('observeUsage', response, request);
        assert.match(h.call('settings').lastUsageReport, /未完成/);
        if (mode === 'abort') assert.match(h.call('settings').lastUsageReport, /响应已取消/);
        assert.equal(h.evaluate('recentReal.length'), mode === 'abort' ? 0 : 1);
        assert.equal(response.bodyUsed, false);
    }
});

test('failure-reporting exceptions cannot replace the original HTTP response or rejection', async () => {
    for (const mode of ['http', 'rejection']) {
        const h = harness();
        const original = mode === 'http' ? new Response('offline failure', { status: 500 }) : new Error('original request failure');
        h.window.fetch = async () => {
            h.host.getCurrentChatId = () => { throw new Error('observer context failure'); };
            if (mode === 'rejection') throw original;
            return original;
        };
        h.call('watchRealRequests');
        const pending = h.window.fetch(ENDPOINT, { method: 'POST', body: JSON.stringify(fixture()) });
        if (mode === 'http') assert.equal(await pending, original);
        else await assert.rejects(pending, error => error === original);
    }
});
