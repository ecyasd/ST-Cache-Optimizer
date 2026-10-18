#!/usr/bin/env node
'use strict';

// No HTTP client, browser, credentials, live API or preset script is loaded.
// Only the extension and the local host's prompt converter are evaluated.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const ROOT = path.resolve(__dirname, '..');
const fixture = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests/fixtures/izumi-shujuku.json'), 'utf8'));
const replies = JSON.parse(fs.readFileSync(path.join(__dirname, 'offline-replies.json'), 'utf8')).replies;
const clone = value => JSON.parse(JSON.stringify(value));
const sha = value => crypto.createHash('sha256').update(typeof value === 'string' ? value : canonical(value)).digest('hex');

function canonical(value) {
    if (value === undefined) return 'null';
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
}

function prefixLength(a, b) {
    let i = 0;
    while (i < a.length && i < b.length && a.charCodeAt(i) === b.charCodeAt(i)) i++;
    return i;
}

// Only structural field names are emitted; arbitrary private keys stay hidden.
const safeKeys = new Set(['role', 'content', 'parts', 'text', 'messages', 'contents', 'system_instruction',
    'systemInstruction', 'signature', 'thoughtSignature', 'inlineData', 'data', 'mimeType', 'tools', 'name',
    'functionCall', 'functionResponse', 'args', 'parameters', 'generationConfig', 'safetySettings']);
const pointer = key => /^(0|[1-9]\d*)$/.test(key) || safeKeys.has(key) ? key : '*';
function firstDifference(a, b, at = '') {
    if (canonical(a) === canonical(b)) return null;
    if (a && b && typeof a === 'object' && typeof b === 'object' && Array.isArray(a) === Array.isArray(b)) {
        for (const key of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort((x, y) =>
            Array.isArray(a) ? Number(x) - Number(y) : x.localeCompare(y))) {
            const found = firstDifference(a[key], b[key], `${at}/${pointer(key)}`);
            if (found) return found;
        }
    }
    return { path: at || '/', ...(typeof a === 'string' && typeof b === 'string'
        ? { commonValueChars: prefixLength(a, b), previousChars: a.length, currentChars: b.length } : {}) };
}

function compareMessages(previous, current) {
    let same = 0;
    while (same < previous.length && same < current.length && canonical(previous[same]) === canonical(current[same])) same++;
    const render = list => list.map(message => canonical(message)).join('\n');
    const a = render(previous), b = render(current);
    const chars = prefixLength(a, b);
    return {
        identicalPrefixMessages: same,
        previousMessageCount: previous.length, currentMessageCount: current.length,
        characterUnit: 'UTF-16 code units', commonPrefixChars: chars,
        previousChars: a.length, currentChars: b.length,
        commonPrefixPercent: b.length ? 100 * chars / b.length : null,
        commonPrefixSHA256: sha(a.slice(0, chars)),
        firstDifference: firstDifference(previous, current),
    };
}

function nativeMessages(native) {
    const system = native.system_instruction ?? native.systemInstruction;
    return [...(system ? [{ role: 'system', ...system }] : []), ...(native.contents ?? [])];
}

function loadNativeConverter(options = {}) {
    const candidates = options.path ? [path.resolve(options.path)] : [
        'D:\\SillyTavern\\src\\prompt-converters.js',
        path.resolve(ROOT, '../reference/sillytavern/prompt-converters.js'),
    ];
    const file = candidates.find(candidate => fs.existsSync(candidate));
    if (!file) throw new Error('NATIVE_CONVERTER_MISSING: supply --converter <local prompt-converters.js>');
    const source = fs.readFileSync(file, 'utf8');
    // Preserve every converter function. Replace only its two known imports and
    // ESM export declarations so Node can run the host source without importing
    // util.js (which initializes host config and unrelated server dependencies).
    const imports = source.match(/^import .+;\r?$/gm) ?? [];
    if (imports.length !== 2 || !source.includes("from 'node:crypto'") || !source.includes("from './util.js'")) {
        throw new Error('UNSUPPORTED_CONVERTER_IMPORTS');
    }
    const config = { promptPlaceholder: "Let's get started.", 'gemini.thoughtSignatures': true, ...options.config };
    const context = vm.createContext({ crypto,
        getConfigValue: (key, fallback) => Object.hasOwn(config, key) ? config[key] : fallback,
        tryParse: text => { try { return JSON.parse(text); } catch { return undefined; } },
    });
    const executable = source.replace(/^import .+;\r?$/gm, '').replace(/^export (?=(?:const|function)\b)/gm, '');
    vm.runInContext(executable, context, { filename: file, timeout: 5000 });
    return {
        metadata: { implementation: 'unmodified-host-functions-in-vm', sourceFile: path.basename(file),
            sourceSHA256: sha(source), sourceKind: file.includes(`${path.sep}reference${path.sep}`) ? 'reference-copy' : 'installed-host',
            configFixture: config, serverEndpointExecuted: false,
            limit: 'Host converter is real; browser prompt expansion, config and Vertex transport envelope are fixture-controlled.' },
        convert(body) {
            context.__body = clone(body);
            return clone(vm.runInContext('convertGooglePrompt(__body.messages, __body.model, !!__body.use_sysprompt, getPromptNames({ body: __body }))', context, { timeout: 5000 }));
        },
    };
}

function createHarness({ extensionSource, settings = {}, converter = loadNativeConverter() } = {}) {
    const listeners = new Map(), panels = new Map(), requests = [], events = [];
    const eventTypes = Object.fromEntries(['WORLDINFO_ENTRIES_LOADED', 'WORLD_INFO_ACTIVATED', 'GENERATION_STARTED', 'GENERATION_ENDED',
        'GENERATION_STOPPED', 'CHAT_COMPLETION_PROMPT_READY', 'CHAT_COMPLETION_SETTINGS_READY'].map(name => [name, name]));
    const bus = {
        on(name, listener) { const list = listeners.get(name) ?? []; list.push(listener); listeners.set(name, list); },
        removeListener(name, listener) { listeners.set(name, (listeners.get(name) ?? []).filter(item => item !== listener)); },
        makeLast(name, listener) { this.removeListener(name, listener); this.on(name, listener); },
        emit(name, ...args) { events.push(name); for (const listener of [...(listeners.get(name) ?? [])]) listener(...args); },
    };
    const host = { mainApi: 'openai', chat: [], name1: '玩家', name2: '守塔人', characterId: 0,
        characters: [{ avatar: 'offline-synthetic.png' }], getCurrentChatId: () => 'offline-advancing-floors',
        extensionSettings: { cacheOptimizer: clone(settings) }, saveSettingsDebounced() {},
        chatCompletionSettings: { chat_completion_source: 'vertexai', use_sysprompt: true, names_behavior: -1 },
        extensionPrompts: {}, eventTypes, eventSource: bus };
    const chain = new Proxy({}, { get: () => () => chain });
    const jquery = selector => typeof selector !== 'string' ? chain : new Proxy({}, { get: (_obj, method) => (...args) => {
        if (method === 'text' && args.length) panels.set(selector, args[0]);
        return chain;
    } });
    let pendingReply = '', blockedNetworkAttempts = 0;
    const denyNetwork = () => { blockedNetworkAttempts++; throw new Error('OFFLINE_NETWORK_BLOCKED'); };
    const sandbox = vm.createContext({ structuredClone, URL, TextDecoder, Response, ReadableStream, AbortController,
        setTimeout, clearTimeout, fetch: denyNetwork, console: { info() {}, warn() {}, error() {}, debug() {} },
        jQuery: jquery, $: jquery, toastr: {}, SillyTavern: { getContext: () => host },
        window: { location: { href: 'http://offline.invalid/', origin: 'http://offline.invalid' },
            fetch: async (input, init) => {
                const url = new URL(typeof input === 'string' ? input : input.url, 'http://offline.invalid/');
                if (url.origin !== 'http://offline.invalid' || url.pathname !== '/api/backends/chat-completions/generate'
                    || init?.method !== 'POST' || typeof init.body !== 'string') return denyNetwork();
                const body = JSON.parse(init.body);
                requests.push({ body, native: converter.convert(body) });
                // No usageMetadata, usage, cached counts or invented API tokens.
                return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: pendingReply } }] }),
                    { headers: { 'content-type': 'application/json' } });
            } },
    });
    const source = extensionSource ?? fs.readFileSync(path.join(ROOT, 'index.js'), 'utf8');
    vm.runInContext(source, sandbox, { filename: 'index.js', timeout: 5000 });
    const call = (name, ...args) => { sandbox.__args = args; return vm.runInContext(`${name}(...__args)`, sandbox, { timeout: 5000 }); };
    for (const [event, handler] of Object.entries({ GENERATION_STARTED: 'onGenerationStarted', GENERATION_ENDED: 'onGenerationEnded',
        GENERATION_STOPPED: 'onGenerationStopped', WORLDINFO_ENTRIES_LOADED: 'onWorldInfoEntriesLoaded', WORLD_INFO_ACTIVATED: 'onWorldInfoActivated',
        CHAT_COMPLETION_PROMPT_READY: 'onPromptReady', CHAT_COMPLETION_SETTINGS_READY: 'onSettingsReady' })) {
        bus.on(event, (...args) => call(handler, ...args));
    }
    call('settings'); call('watchRealRequests');
    return { host, bus, panels, requests, events, call, window: sandbox.window,
        extensionSHA256: sha(source), get blockedNetworkAttempts() { return blockedNetworkAttempts; },
        async generate({ core, body, worldInfo = { chatLore: [] }, reply, helperCleanup = true }) {
            host.chat = clone(core); pendingReply = reply;
            bus.emit(eventTypes.GENERATION_STARTED, 'normal', {}, false);
            // TavernHelper's cleanup can precede the outer official core hook.
            if (helperCleanup) { bus.emit(eventTypes.GENERATION_STOPPED, 'offline-helper-id'); bus.emit(eventTypes.GENERATION_ENDED); }
            call('cacheOptimizerCaptureHistory', clone(core), 100000, () => {}, 'normal');
            events.push('generate_interceptor');
            bus.emit(eventTypes.WORLDINFO_ENTRIES_LOADED, worldInfo);
            // Fixture expansion consumes the routed per-scan copies, never saved lore.
            for (const entry of worldInfo.chatLore ?? []) {
                const message = { role: 'system', content: `<当前剧情相关设定>\n${entry.content}\n</当前剧情相关设定>` };
                if (entry.position === 4 && entry.depth === 0) body.messages.push(message);
                else body.messages.splice(fixture.syntheticRequest.staticPrefixMessages.length, 0, message);
            }
            bus.emit(eventTypes.WORLD_INFO_ACTIVATED, worldInfo.chatLore ?? []);
            bus.emit(eventTypes.CHAT_COMPLETION_PROMPT_READY, { chat: body.messages, dryRun: false });
            bus.emit(eventTypes.CHAT_COMPLETION_SETTINGS_READY, body);
            const response = await sandbox.window.fetch('/api/backends/chat-completions/generate', { method: 'POST', body: JSON.stringify(body) });
            const payload = await response.json();
            bus.emit(eventTypes.GENERATION_ENDED);
            return { request: requests.at(-1), reply: payload.choices[0].message.content, worldInfo };
        },
    };
}

function coreFromMessages(messages) {
    return messages.map(message => ({ name: message.role === 'user' ? '玩家' : '守塔人', is_user: message.role === 'user',
        is_system: false, mes: message.content, send_date: '2026-10-19T00:00:00.000Z', extra: {} }));
}

function buildTurn(turn, history) {
    const template = fixture.syntheticRequest;
    const input = turn < fixture.consecutiveTurns.length ? fixture.consecutiveTurns[turn].userInput
        : ['我沿石阶走到码头，查看潮位刻度。', '我向船夫打听下一班渡船的路线。', '我带着航线记录返回灯塔，核对出发清单。'][turn - 3];
    const epoch = turn + 1, memory = template.earlyMemoryMessage.content
        .replace(/abcdef_1/g, `abcdef_${epoch}`).replace('角色曾在灯塔门前见过用户。', `第 ${epoch} 轮独有记忆：已记录 ${epoch} 条灯塔线索。`);
    const recall = `<最新数据与记录>\n第 ${epoch} 轮独有召回：潮位记录 ${epoch * 17}。\n</最新数据与记录>`;
    const directory = template.footerMessages[1].content.replace('12345', String(12345 + epoch * 137))
        .replace(/abcdef_1/g, `abcdef_${epoch}`);
    const table = fixture.shujuku.customTableMessage.content.replace('灯塔,问风向', `码头${epoch},核对潮位${epoch}`);
    const inputFooter = template.footerMessages[0].content.replace(fixture.consecutiveTurns[0].userInput, input);
    history.push({ role: 'user', content: input });
    return { input, reply: replies[turn], dynamic: [memory, recall, directory, table, inputFooter],
        worldInfo: { chatLore: [{ ...clone(fixture.shujuku.generatedWorldbookEntries[0]),
            position: 0, depth: 4, role: 0, order: 999, content: `第 ${epoch} 轮现场世界书召回 ${epoch * 31}。` }] },
        body: { type: 'normal', model: 'gemini-offline', chat_completion_source: 'vertexai', stream: false,
            use_sysprompt: true, char_name: '守塔人', user_name: '玩家', group_names: [], max_tokens: 30000,
            messages: [...clone(template.staticPrefixMessages), { role: 'system', content: memory },
                { role: 'system', content: recall }, ...clone(history),
                { role: 'user', content: table }, { role: 'system', content: inputFooter },
                { role: 'system', content: directory }, ...clone(template.footerMessages.slice(2))] } };
}

function fidelity(originalStatic, request, dynamic, history) {
    const joined = request.messages.map(message => message.content).join('\n');
    const locations = originalStatic.map(message => request.messages.findIndex(candidate => canonical(candidate) === canonical(message)));
    const occurrences = content => joined.split(content).length - 1;
    return {
        staticMessageCount: originalStatic.length,
        staticRulesExactlyOnce: originalStatic.every(message => occurrences(message.content) === 1),
        staticRolesPreserved: locations.every(index => index >= 0),
        staticRelativeOrderPreserved: locations.every((index, i) => index >= 0 && (i === 0 || index > locations[i - 1])),
        dynamicBlocksExactlyOnce: dynamic.every(content => occurrences(content) === 1),
        historyMessagesExactlyOnce: history.every(message => request.messages.filter(candidate => canonical(candidate) === canonical(message)).length === 1),
        outgoingInternalMarkersAbsent: !JSON.stringify(request).includes('__cacheoptDynamic'),
    };
}

async function runOffline(options = {}) {
    const turns = options.turns ?? 6;
    assert.ok(Number.isInteger(turns) && turns >= 3 && turns <= replies.length, 'turns must be 3..6; replies may never repeat');
    const converter = options.converter ?? loadNativeConverter({ path: options.converterPath });
    const modes = [{ name: 'disabled', enabled: false, compatGeminiProxy: false },
        { name: 'preserve-preset', enabled: true, compatGeminiProxy: false },
        ...(options.compareExperimental ? [{ name: 'experimental-layout', enabled: true, compatGeminiProxy: true }] : [])];
    const report = { formatVersion: 1, kind: 'offline-advancing-floor-fixture', synthetic: true,
        networkRequests: 0, paidModelRequests: 0, apiCacheUsage: 'unknown; synthetic replies omit every usage field',
        extensionSHA256: null, converter: converter.metadata, turns,
        boundary: 'Actual extension lifecycle/interceptor/settings/fetch and host Vertex converter; fixture prompt expansion and database recall. No live Tavern capture.',
        replySources: replies.slice(0, turns).map(({ title, author, source }) => ({ title, author, source })), modes: [] };
    let exportedChat;
    for (const mode of modes) {
        const h = createHarness({ converter, settings: { ...mode, compatIzumi: true, compatShujuku: true } });
        report.extensionSHA256 = h.extensionSHA256;
        const history = [clone(fixture.syntheticRequest.historyMessages[0])], modeReport = { mode: mode.name,
            experimentalLayoutMayChangeRoles: mode.compatGeminiProxy, rounds: [], comparisons: [] };
        for (let turn = 0; turn < turns; turn++) {
            const data = buildTurn(turn, history);
            const before = clone(data.body), loreBefore = clone(data.worldInfo), originalCore = coreFromMessages(history);
            const result = await h.generate({ core: originalCore, body: data.body, worldInfo: data.worldInfo, reply: data.reply.text });
            const request = result.request;
            const dynamic = [...data.dynamic, loreBefore.chatLore[0].content];
            const checked = fidelity([...fixture.syntheticRequest.staticPrefixMessages,
                ...fixture.syntheticRequest.footerMessages.slice(2)], request.body, dynamic, history);
            assert.equal(result.reply, data.reply.text);
            assert.equal(checked.staticRulesExactlyOnce, true, 'static rule loss/duplication');
            assert.equal(checked.dynamicBlocksExactlyOnce, true, 'dynamic block loss/duplication');
            assert.equal(checked.historyMessagesExactlyOnce, true, 'history loss/duplication');
            if (!mode.compatGeminiProxy) {
                assert.equal(checked.staticRolesPreserved, true, 'preset roles changed');
                assert.equal(checked.staticRelativeOrderPreserved, true, 'preset order changed');
            }
            const head = request.native.system_instruction ?? { parts: [] };
            modeReport.rounds.push({ round: turn + 1, inputSHA256: sha(data.input), replySHA256: sha(result.reply),
                recallSHA256: sha(dynamic.join('\n')), frontendMessageCount: request.body.messages.length,
                nativeMessageCount: request.native.contents.length,
                nativeSystemHeadChars: (head.parts ?? []).map(part => part.text ?? '').join('\n').length,
                nativeSystemHeadSHA256: sha(head), historyMessageCount: history.length,
                frontendChanged: canonical(before) !== canonical(request.body),
                worldInfoRouted: canonical(loreBefore) !== canonical(result.worldInfo), fidelity: checked });
            if (turn) modeReport.comparisons.push({ previousRound: turn, currentRound: turn + 1,
                frontend: compareMessages(h.requests[turn - 1].body.messages, request.body.messages),
                native: compareMessages(nativeMessages(h.requests[turn - 1].native), nativeMessages(request.native)) });
            history.push({ role: 'assistant', content: result.reply });
        }
        assert.equal(new Set(modeReport.rounds.map(round => round.inputSHA256)).size, turns);
        assert.equal(new Set(modeReport.rounds.map(round => round.replySHA256)).size, turns);
        assert.equal(new Set(modeReport.rounds.map(round => round.recallSHA256)).size, turns);
        assert.equal(h.requests.length, turns);
        assert.equal(h.blockedNetworkAttempts, 0);
        modeReport.mainRequestsIntercepted = h.requests.length;
        modeReport.events = [...new Set(h.events)];
        modeReport.uniqueInputs = turns; modeReport.uniqueReplies = turns; modeReport.uniqueRecalls = turns;
        modeReport.finalChatFloors = history.length;
        report.modes.push(modeReport);
        if (mode.name === 'preserve-preset') exportedChat = coreFromMessages(history);
    }
    if (options.chatOut) {
        const metadata = { user_name: '玩家', character_name: '守塔人', create_date: '2026-10-19T00:00:00.000Z',
            chat_metadata: { offline_test: true, synthetic: true, public_domain_replies: true } };
        fs.writeFileSync(path.resolve(options.chatOut), [metadata, ...exportedChat].map(JSON.stringify).join('\n') + '\n', 'utf8');
        report.syntheticChatExported = true;
    }
    return report;
}

function readCaptures(input) {
    const absolute = path.resolve(input), stat = fs.statSync(absolute);
    const files = stat.isDirectory() ? fs.readdirSync(absolute).filter(name => name.endsWith('.json'))
        .sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).map(name => path.join(absolute, name)) : [absolute];
    const records = [], ui = []; let ignored = 0, invalid = 0;
    for (const file of files) {
        try {
            const data = JSON.parse(fs.readFileSync(file, 'utf8'));
            if (Array.isArray(data.messages)) records.push({ kind: 'frontend', data, messages: data.messages });
            else if (Array.isArray(data.contents)) records.push({ kind: 'native', data, messages: nativeMessages(data) });
            else if (/^round-\d+-ui\.json$/.test(path.basename(file))) ui.push(data);
            else ignored++;
        } catch { invalid++; }
    }
    return { records, ui, ignored, invalid };
}

async function analyzeCaptures(input, { replay = false, converter = loadNativeConverter() } = {}) {
    const { records, ui, ignored, invalid } = readCaptures(input);
    const result = { kind: 'historical-capture-analysis', liveCapture: false, privatePromptTextEmitted: false,
        networkRequests: 0, apiCacheUsage: 'not inferred from prompt similarity or old UI usage',
        includedCaptures: records.length, diagnosticOnlyCaptures: ui.length, ignoredFiles: ignored, invalidFiles: invalid,
        boundary: 'UI diagnostics cannot reconstruct the original messages. Native provider requests cannot reconstruct original preset roles. Missing official history means extension replays conservatively skip optimization.',
        captures: [], comparisons: [] };
    const previous = new Map();
    for (const record of records) {
        const ordinal = result.captures.length + 1;
        const generationType = ['normal', 'regenerate', 'swipe', 'quiet', 'impersonate', 'continue'].includes(record.data.type)
            ? record.data.type : 'unknown';
        const entry = { ordinal, kind: record.kind, generationType,
            messages: record.messages.length, requestSHA256: sha(record.messages) };
        if (replay && record.kind === 'frontend') {
            const h = createHarness({ converter });
            const body = { ...clone(record.data), type: record.data.type ?? 'normal', chat_completion_source: 'vertexai',
                model: record.data.model ?? 'gemini-offline', use_sysprompt: record.data.use_sysprompt ?? true, stream: false };
            h.bus.emit(h.host.eventTypes.GENERATION_STARTED, 'normal', {}, false);
            h.bus.emit(h.host.eventTypes.CHAT_COMPLETION_PROMPT_READY, { chat: body.messages, dryRun: false });
            h.bus.emit(h.host.eventTypes.CHAT_COMPLETION_SETTINGS_READY, body);
            await h.window.fetch('/api/backends/chat-completions/generate', { method: 'POST', body: JSON.stringify(body) });
            entry.replay = { extensionExecuted: true, officialHistoryAvailable: false, mutationSkipped: true,
                frontendMessagesUnchanged: canonical(record.data.messages) === canonical(h.requests[0].body.messages),
                nativeMessageCount: h.requests[0].native.contents.length };
        }
        result.captures.push(entry);
        // Old captures often omitted the generation type entirely. Compare them
        // as unverified artifact series only; never label them consecutive floors
        // or mix explicitly marked helper/continue requests into main requests.
        const group = `${record.kind}:${generationType}:${sha({ model: record.data.model, tools: record.data.tools ?? null,
            source: record.data.chat_completion_source, max_tokens: record.data.max_tokens })}`;
        const prior = previous.get(group);
        if (prior) result.comparisons.push({ kind: record.kind, generationType, continuityVerified: false,
            previousOrdinal: prior.ordinal, currentOrdinal: ordinal,
            ...compareMessages(prior.record.messages, record.messages) });
        previous.set(group, { ordinal, record });
    }
    return result;
}

async function main(argv = process.argv.slice(2)) {
    const options = {}, captures = [];
    let out;
    for (let i = 0; i < argv.length; i++) {
        const flag = argv[i];
        if (flag === '--help') {
            process.stdout.write('node tools/offline-runner.cjs [--turns 3..6] [--out report.json] [--chat-out synthetic.jsonl] [--converter local-file] [--compare-experimental] [--captures file-or-dir] [--replay-ui file-or-dir]\n');
            return;
        }
        if (flag === '--compare-experimental') { options.compareExperimental = true; continue; }
        if (!['--turns', '--out', '--chat-out', '--converter', '--captures', '--replay-ui'].includes(flag) || !argv[i + 1]) throw Error('INVALID_ARGUMENT');
        const value = argv[++i];
        if (flag === '--turns') options.turns = Number(value);
        if (flag === '--out') out = value;
        if (flag === '--chat-out') options.chatOut = value;
        if (flag === '--converter') options.converterPath = value;
        if (flag === '--captures' || flag === '--replay-ui') captures.push({ path: value, replay: flag === '--replay-ui' });
    }
    const report = await runOffline(options);
    if (captures.length) {
        const converter = loadNativeConverter({ path: options.converterPath });
        report.historicalCaptures = [];
        for (const input of captures) report.historicalCaptures.push(await analyzeCaptures(input.path, { ...input, converter }));
    }
    const output = JSON.stringify(report, null, 2) + '\n';
    if (out) fs.writeFileSync(path.resolve(out), output, 'utf8');
    else process.stdout.write(output);
}

module.exports = { canonical, prefixLength, firstDifference, compareMessages, nativeMessages, loadNativeConverter,
    createHarness, coreFromMessages, buildTurn, fidelity, runOffline, readCaptures, analyzeCaptures, main };
if (require.main === module) main().catch(() => {
    // Never print JSON parse contents, private paths, body text or error sources.
    process.stderr.write('Offline validation failed. Check CLI arguments, local converter availability and runner assertions. No model request was made.\n');
    process.exitCode = 1;
});
