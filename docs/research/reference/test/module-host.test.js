// Tests for sources/moduleHost.js and sources/example-module.js (mirrors
// QuickJsExecutor.kt, ModuleManager.kt, ModuleResults.kt, ModuleIndex.kt and
// ModuleSource.kt), including the S1 fix: arguments reach a module as JSON
// values, never as spliced source text.
// Independent JavaScript re-implementation of the mechanism documented in BITCHORD_ENGINE_RESEARCH.md (BitChord itself is GPL-3.0).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { fakeFetch } from '../lib/http.js';
import {
  createModuleHost,
  createModuleSource,
  moduleCodecOf,
  moduleKbpsFor,
  parseModuleIndex,
  preprocessModuleCode,
  resolveModuleUrl,
  rowTier,
} from '../sources/moduleHost.js';
import { matchAndStream, StreamRequest } from '../sources/resolve.js';
import { queries } from '../sources/trackMatcher.js';

const EXAMPLE = await readFile(new URL('../sources/example-module.js', import.meta.url), 'utf8');
const API = 'https://api.example-music.test/v1';

// ── The fictional catalogue the example module talks to ────────────────────

const ITEMS = [
  { id: 101, title: 'Paniyon Sa', artists: [{ name: 'Atif Aslam' }, { name: 'Tulsi Kumar' }],
    album: { title: 'Satyameva Jayate', cover: 'https://img.example-music.test/101.jpg' }, duration_ms: 247_000,
    lossless: true, hires: true, track_number: 3 },
  { id: 102, title: 'Paniyon Sa (Remix)', artists: [{ name: 'DJ Someone' }], album: { title: 'Remixes' },
    duration_ms: 200_400, lossless: false },
];
const OFFERS = {
  101: {
    LOSSLESS: { url: 'https://cdn.example-music.test/101.flac?sig=a', codec: 'flac', bit_depth: 24, sample_rate: 96000 },
    HIGH: { url: 'https://cdn.example-music.test/101.m4a?sig=b', codec: 'aac', kbps: 320, sample_rate: 44100 },
    IMMERSIVE: { url: 'https://cdn.example-music.test/101/atmos.mpd', codec: 'eac3', kbps: 768, sample_rate: 48000, immersive: true },
  },
  // This backend quietly falls back to a lossy copy when lossless is asked for.
  102: {
    LOSSLESS: { url: 'https://cdn.example-music.test/102.m4a', codec: 'aac', kbps: 320 },
    HIGH: { url: 'https://cdn.example-music.test/102.m4a', codec: 'aac', kbps: 320 },
  },
};

function catalogue() {
  return fakeFetch([
    [(url, init) => url === `${API}/token` && init.method === 'POST', () => ({ body: { access_token: 'tok', expires_in: 3600 } })],
    [(url) => url.startsWith(`${API}/search?`), (url) => {
      const q = new URL(url).searchParams.get('q');
      return { body: { items: q.includes('paniyon') ? ITEMS : [], total: q.includes('paniyon') ? 2 : 0 } };
    }],
    [(url) => /\/tracks\/\d+\/stream/.test(url), (url) => {
      const u = new URL(url);
      const id = u.pathname.split('/')[3];
      const offers = OFFERS[id] ?? {};
      const offer = u.searchParams.get('immersive') === '1' && offers.IMMERSIVE ? offers.IMMERSIVE : offers[u.searchParams.get('quality')] ?? offers.HIGH;
      return offer ? { body: offer } : { status: 404, body: { error: 'no such track' } };
    }],
  ]);
}

const exampleSource = (fetch, options = {}) =>
  createModuleSource({ id: 'examples', modules: [{ id: 'example', code: EXAMPLE }], fetch, ...options });

// ── Code preprocessing ─────────────────────────────────────────────────────

test('preprocess: export keywords are stripped as QuickJsExecutor does, and the names collected', () => {
  const { code, exportNames } = preprocessModuleCode(`
    export async function searchTracks() {}
    export const version = 1;
    export default function helper() {}
    function getTrackStreamUrl() {}
    export { getTrackStreamUrl, version as v };
  `);
  assert.doesNotMatch(code, /\bexport\b/);
  assert.match(code, /async function searchTracks/);
  assert.match(code, /const version = 1/);
  assert.match(code, /function helper/);
  assert.deepEqual(exportNames.map((n) => `${n.local}->${n.exported}`).sort(), [
    'getTrackStreamUrl->getTrackStreamUrl', 'helper->helper', 'searchTracks->searchTracks', 'version->v', 'version->version',
  ]);
});

test('preprocess: a module shipped inside an exported template literal is unwrapped', () => {
  const wrapped = 'export const code = `module.exports = { searchTracks: async () => ({ tracks: [], total: 0 }) };`';
  assert.equal(preprocessModuleCode(wrapped).code, 'module.exports = { searchTracks: async () => ({ tracks: [], total: 0 }) };');
});

// ── The example module end to end ──────────────────────────────────────────

test('example module: searchTracks rows map to the source interface', async () => {
  const fetch = catalogue();
  const source = exampleSource(fetch);
  const rows = await source.search('paniyon sa atif aslam', { limit: 15 });
  assert.deepEqual(rows[0], {
    id: 'example::101',
    title: 'Paniyon Sa',
    artist: 'Atif Aslam, Tulsi Kumar',
    album: 'Satyameva Jayate',
    artwork: 'https://img.example-music.test/101.jpg',
    durationSec: 247,
    explicit: null,
    quality: 'LOSSLESS',
  });
  assert.equal(rows[1].quality, 'HIGH');
  assert.equal(rows[1].durationSec, 200);
  const search = fetch.calls.find((c) => c.url.startsWith(`${API}/search`));
  assert.equal(new URL(search.url).searchParams.get('limit'), '15');
  assert.equal(search.init.headers.Authorization, 'Bearer tok');
  // No User-Agent from the module: the bridge supplies BitChord's desktop Chrome one.
  assert.match(search.init.headers['User-Agent'], /Chrome\/130/);
});

test('example module: engines stay resident, so the token is fetched once across calls', async () => {
  const fetch = catalogue();
  const source = exampleSource(fetch);
  await source.search('paniyon sa atif aslam', { limit: 15 });
  await source.stream('example::101', StreamRequest.lossless);
  await source.stream('example::101', StreamRequest.best);
  const tokens = fetch.calls.filter((c) => c.url === `${API}/token`);
  assert.equal(tokens.length, 1);
  assert.equal(tokens[0].init.method, 'POST');
  assert.equal(tokens[0].init.body, '{"client_id":"replace-with-your-client-id"}');
  assert.equal(tokens[0].init.headers['Content-Type'], 'application/json');
});

test('example module: a lossless request gets FLAC detected from the MIME type', async () => {
  const stream = await exampleSource(catalogue()).stream('example::101', StreamRequest.lossless);
  assert.equal(stream.url, 'https://cdn.example-music.test/101.flac?sig=a');
  assert.deepEqual(stream.format, { codec: 'flac', kbps: null, sampleRate: 96000, bitDepth: 24 });
});

test('example module: a best request gets AAC 320', async () => {
  const stream = await exampleSource(catalogue()).stream('example::101', StreamRequest.best);
  assert.deepEqual(stream.format, { codec: 'aac', kbps: 320, sampleRate: 44100, bitDepth: null });
});

test('example module: strict fallbackMode makes a lossless request fail fast instead of settling', async () => {
  const fetch = catalogue();
  const source = exampleSource(fetch);
  assert.equal(await source.stream('example::102', StreamRequest.lossless), null);
  const asked = new URL(fetch.calls.find((c) => c.url.includes('/tracks/102/stream')).url);
  assert.equal(asked.searchParams.get('quality'), 'LOSSLESS');
  // A best request is flexible and takes the lossy copy.
  assert.equal((await source.stream('example::102', StreamRequest.best)).format.codec, 'aac');
});

test('example module: Atmos only when allowed, detected from the label', async () => {
  const allowed = await exampleSource(catalogue(), { atmosAllowed: true }).stream('example::101', StreamRequest.lossless);
  assert.equal(allowed.format.codec, 'eac3-joc');
  assert.equal(allowed.url, 'https://cdn.example-music.test/101/atmos.mpd');
  const fetch = catalogue();
  const stereo = await exampleSource(fetch, { atmosAllowed: false }).stream('example::101', StreamRequest.lossless);
  assert.equal(stereo.format.codec, 'flac');
  assert.equal(new URL(fetch.calls.find((c) => c.url.includes('/stream')).url).searchParams.get('immersive'), '0');
});

test('example module: the full resolver path matches and streams the right row', async () => {
  const source = exampleSource(catalogue());
  const target = { title: 'Paniyon Sa (From "Satyameva Jayate")', artist: 'Atif Aslam', durationSec: 247 };
  const stream = await matchAndStream(source, target, StreamRequest.lossless);
  assert.equal(stream.url, 'https://cdn.example-music.test/101.flac?sig=a');
  assert.equal(stream.durationSec, 247);
  assert.equal(stream.sourceId, 'examples');
});

// ── S1: arguments are JSON values, never spliced into code ─────────────────

const ECHO = `
  var calls = 0;
  module.exports = {
    searchTracks: async function (query, limit, context) {
      calls++;
      return { tracks: [{ id: 'row-1', title: 'Song', artist: query.split(' ').slice(1).join(' '), duration: 200 }],
               total: 1, echo: { query: query, limit: limit, context: context, calls: calls,
                                 pwned: typeof globalThis.pwned !== 'undefined' } };
    },
    getTrackStreamUrl: async function (id, quality, context) {
      return { streamUrl: 'https://cdn.example/' + encodeURIComponent(id) + '.flac',
               track: { id: id, audioQuality: quality, mimeType: 'audio/flac' },
               echo: { id: id, quality: quality, context: context } };
    }
  };
`;

test('S1: a query with a double quote and a backslash reaches the module intact', async () => {
  const host = createModuleHost({ fetch: fakeFetch([]) });
  host.load('echo', ECHO);
  const query = 'song jay "hov" z\\';
  const answer = await host.call('echo', 'searchTracks', [query, 15, { settings: {} }]);
  assert.equal(answer.echo.query, query);
  assert.equal(answer.echo.limit, 15);
  assert.deepEqual(answer.echo.context, { settings: {} });
});

test('S1: an injection attempt stays data', async () => {
  const host = createModuleHost({ fetch: fakeFetch([]) });
  host.load('echo', ECHO);
  const payload = '"); globalThis.pwned = true; ("';
  const first = await host.call('echo', 'searchTracks', [payload, 15, { settings: {} }]);
  assert.equal(first.echo.query, payload);
  const second = await host.call('echo', 'searchTracks', ['next', 15, { settings: {} }]);
  assert.equal(second.echo.pwned, false);
});

test('S1: the same arguments spliced the way ModuleManager.kt does break the call or run code', () => {
  // ModuleManager.searchTracksNow: args = listOf("\\"$query\\"", limit.toString(), contextArg)
  const splice = (query) => `searchTracks("${query}", 15, {settings:{}})`;
  assert.throws(() => new vm.Script(splice('song jay "hov" z\\')), SyntaxError);
  const injected = vm.createContext({ searchTracks: () => null });
  vm.runInContext(splice('"); globalThis.pwned = true; ("'), injected);
  assert.equal(injected.pwned, true);
});

test('S1 end to end: an artist with a quote and a backslash flows from the matcher to the module', async () => {
  const host = createModuleHost({ fetch: fakeFetch([]) });
  const seen = [];
  const spy = { ...host, call: async (...args) => {
    seen.push(args);
    return host.call(...args);
  } };
  const source = createModuleSource({ id: 'echo-source', modules: [{ id: 'echo', code: ECHO }], host: spy });
  const target = { title: 'Song', artist: 'Jay "Hov" Z\\', durationSec: 200 };
  const stream = await matchAndStream(source, target, StreamRequest.lossless);
  const [firstQuery] = queries(target);
  assert.equal(seen[0][1], 'searchTracks');
  assert.equal(seen[0][2][0], firstQuery);
  assert.equal(firstQuery, 'song jay "hov" z\\');
  assert.equal(stream.url, 'https://cdn.example/row-1.flac');
});

test('the stream call carries quality, strict fallback and the Atmos flag as strings', async () => {
  const host = createModuleHost({ fetch: fakeFetch([]) });
  const seen = [];
  const spy = { ...host, call: async (...args) => {
    seen.push(args);
    return host.call(...args);
  } };
  const source = createModuleSource({ modules: [{ id: 'echo', code: ECHO }], host: spy, atmosAllowed: true });
  await source.stream('echo::t 1', StreamRequest.lossless);
  await source.stream('echo::t 1', StreamRequest.capped(96));
  const [lossless, capped] = seen.filter((call) => call[1] === 'getTrackStreamUrl').map((call) => call[2]);
  assert.deepEqual(lossless, ['t 1', 'LOSSLESS', { settings: {
    quality: { value: 'LOSSLESS' }, fallbackMode: { value: 'strict' }, dolbyAtmos: { value: 'true' },
  } }]);
  assert.deepEqual(capped[2].settings.fallbackMode, { value: 'flexible' });
  assert.equal(capped[1], 'LOW');
});

// ── The engine pool ─────────────────────────────────────────────────────────

const SLOW = `
  var engineId = Math.random().toString(36).slice(2);
  var served = 0;
  module.exports = {
    searchTracks: async function (query) {
      served++;
      await new Promise(function (resolve) { setTimeout(resolve, 20); });
      return { tracks: [], total: 0, engine: engineId, served: served };
    }
  };
`;

test('pool: up to 3 engines per module, grown lazily; further callers wait their turn', async () => {
  const host = createModuleHost({ fetch: fakeFetch([]) });
  host.load('slow', SLOW);
  assert.equal(host.engineCount('slow'), 1);
  const answers = await Promise.all([1, 2, 3, 4, 5].map((i) => host.call('slow', 'searchTracks', [`q${i}`])));
  assert.equal(host.engineCount('slow'), 3);
  assert.equal(new Set(answers.map((a) => a.engine)).size, 3);
  // Module-level state persisted in whichever engine served twice.
  assert.ok(answers.some((a) => a.served === 2));
});

test('pool: least recently used modules are evicted past the cap; a source revives them', async () => {
  const host = createModuleHost({ fetch: fakeFetch([]), maxModules: 2 });
  host.load('a', ECHO);
  host.load('b', ECHO);
  await host.call('a', 'searchTracks', ['x', 1, {}]); // a is now more recent than b
  host.load('c', ECHO);
  assert.equal(host.isLoaded('b'), false);
  assert.equal(host.isLoaded('a'), true);
  await assert.rejects(host.call('b', 'searchTracks', ['x', 1, {}]), /not loaded/);

  const source = createModuleSource({ modules: [{ id: 'b', code: ECHO }], host });
  host.unload('b');
  assert.equal((await source.search('song x', { limit: 5 })).length, 1);
  assert.equal(host.isLoaded('b'), true);
});

// ── Loading ─────────────────────────────────────────────────────────────────

test('load: an init error or a syntax error fails the load', () => {
  const host = createModuleHost({ fetch: fakeFetch([]) });
  assert.throws(() => host.load('boom', 'throw new Error("no token");'), /Module init error: no token/);
  // Thrown from inside the vm context, so it is that realm's SyntaxError.
  assert.throws(() => host.load('syntax', 'function ('), (error) => error.name === 'SyntaxError');
  assert.equal(host.isLoaded('boom'), false);
});

test('load: a module without the two exports loads empty and every call fails', async () => {
  const host = createModuleHost({ fetch: fakeFetch([]) });
  host.load('nothing', 'module.exports = { other: function () {} };');
  assert.deepEqual(host.exportsOf('nothing'), []);
  await assert.rejects(host.call('nothing', 'searchTracks', ['x', 1, {}]), /not a function/);
});

test('load: an ESM-only module works here, and loads empty under BitChord rules', async () => {
  const esm = 'export async function searchTracks(q) { return { tracks: [], total: 0, q: q }; }';
  const host = createModuleHost({ fetch: fakeFetch([]) });
  host.load('esm', esm);
  assert.equal((await host.call('esm', 'searchTracks', ['hi'])).q, 'hi');
  const strict = createModuleHost({ fetch: fakeFetch([]), collectEsExports: false });
  strict.load('esm', esm);
  assert.deepEqual(strict.exportsOf('esm'), []);
});

test('load: a synchronous infinite loop at the top level is cut off', () => {
  const host = createModuleHost({ fetch: fakeFetch([]), loadTimeoutMs: 50 });
  assert.throws(() => host.load('spin', 'while (true) {}'), /timed out/);
});

// ── The engine's global surface ─────────────────────────────────────────────

test('surface: console, atob, URL, AbortController, timers and Promise helpers exist', async () => {
  const lines = [];
  const host = createModuleHost({ fetch: fakeFetch([]), log: (line) => lines.push(line) });
  host.load('surface', `
    module.exports = {
      searchTracks: async function () {
        console.log('hello', 42);
        var url = new URL('https://api.example.com:8443/a/b?x=1#frag');
        var controller = new AbortController();
        var aborted = false;
        controller.signal.addEventListener('abort', function () { aborted = true; });
        controller.abort();
        var fired = false;
        var cancelled = setTimeout(function () { fired = true; }, 5);
        clearTimeout(cancelled);
        await setTimeout(function () {}, 10);
        var any = await Promise.any([Promise.reject(new Error('x')), Promise.resolve('y')]);
        return { tracks: [], total: 0, surface: {
          atob: atob('aGVsbG8gd29ybGQ='),
          host: url.hostname, port: url.port, path: url.pathname, search: url.search, href: String(url),
          aborted: aborted, signalAborted: controller.signal.aborted, fired: fired, any: any,
          types: [typeof fetch, typeof require, typeof process, typeof Buffer]
        } };
      }
    };`);
  const { surface } = await host.call('surface', 'searchTracks', []);
  assert.deepEqual(surface, {
    atob: 'hello world',
    host: 'api.example.com',
    port: '8443',
    path: '/a/b',
    search: '?x=1',
    href: 'https://api.example.com:8443/a/b?x=1#frag',
    aborted: true,
    signalAborted: true,
    fired: false,
    any: 'y',
    types: ['function', 'undefined', 'undefined', 'undefined'],
  });
  assert.ok(lines.includes('[JS] hello 42'));
});

test('fetch bridge: relative URLs resolve against the download directory; status and headers reach the module', async () => {
  const fetch = fakeFetch([
    [(url) => url === 'https://mods.example.com/index.json', () => ({ body: {
      'category:music': [{ id: 'rel', name: 'Relative', download: 'modules/rel.js' }],
      'category:testing': [{ id: 'ignored', name: 'Ignored', download: 'x.js' }],
    } })],
    [(url) => url === 'https://mods.example.com/modules/rel.js', () => ({ body: `
      module.exports = {
        searchTracks: async function (query) {
          var res = await fetch('api/search?q=' + encodeURIComponent(query), { headers: { 'User-Agent': 'mine/1.0', 'X-Key': 7 } });
          var abs = await fetch('/root.json', { method: 'PATCH', body: { a: 1 } });
          return { tracks: [], total: 0, status: res.status, ok: res.ok, type: res.headers.get('Content-Type'),
                   text: res.text(), absStatus: abs.status };
        }
      };` })],
    [(url) => url.startsWith('https://mods.example.com/modules/api/search'), () => ({ status: 418, body: 'teapot', headers: { 'content-type': 'text/plain' } })],
    [(url) => url === 'https://mods.example.com/root.json', () => ({ status: 200, body: '{}' })],
  ]);
  const source = createModuleSource({ indexUrl: 'https://mods.example.com/index.json', fetch });
  const host = source.host;
  await source.search('probe', { limit: 5 });
  const answer = await host.call('rel', 'searchTracks', ['probe']);
  assert.deepEqual(
    { status: answer.status, ok: answer.ok, type: answer.type, text: answer.text, absStatus: answer.absStatus },
    { status: 418, ok: false, type: 'text/plain', text: 'teapot', absStatus: 200 },
  );
  const api = fetch.calls.find((c) => c.url.includes('/modules/api/search'));
  assert.equal(api.init.headers['User-Agent'], 'mine/1.0');
  assert.equal(api.init.headers['X-Key'], '7');
  const patch = fetch.calls.find((c) => c.url === 'https://mods.example.com/root.json');
  assert.equal(patch.init.method, 'GET'); // every verb but POST/PUT/DELETE/HEAD goes out as GET, as in BitChord
  assert.equal(patch.init.body, undefined);
  // The index is fetched once and cached; the testing category is excluded.
  assert.deepEqual((await source.fetchIndex()).map((m) => m.id), ['rel']);
  assert.equal(fetch.calls.filter((c) => c.url.endsWith('/index.json')).length, 1);
});

test('resolveModuleUrl mirrors QuickJsExecutor.resolveUrl', () => {
  assert.equal(resolveModuleUrl('https://x.example/a', 'https://b.example/dir'), 'https://x.example/a');
  assert.equal(resolveModuleUrl('/api', 'https://b.example/dir/sub'), 'https://b.example/api');
  assert.equal(resolveModuleUrl('api', 'https://b.example/dir'), 'https://b.example/dir/api');
  assert.equal(resolveModuleUrl('api', ''), 'api');
});

// ── Results, caching and failures ──────────────────────────────────────────

test('a module that throws is a failure and is asked again; an empty answer is kept', async () => {
  const host = createModuleHost({ fetch: fakeFetch([]) });
  let calls = 0;
  const spy = { ...host, call: async (...args) => {
    calls++;
    return host.call(...args);
  } };
  const flaky = `
    var attempts = 0;
    module.exports = {
      searchTracks: async function (query) {
        attempts++;
        if (query === 'nothing') return { tracks: [], total: 0 };
        if (attempts === 1) throw new Error('backend timed out');
        return { tracks: [{ id: '1', title: 'Song', artist: 'A', duration: 180 }], total: 1 };
      }
    };`;
  const lines = [];
  const source = createModuleSource({ modules: [{ id: 'flaky', code: flaky }], host: spy, log: (l) => lines.push(l) });
  assert.deepEqual(await source.search('song a', { limit: 5 }), []);
  assert.ok(lines.some((line) => line.includes('backend timed out')));
  assert.equal((await source.search('song a', { limit: 5 })).length, 1);
  assert.equal(calls, 2);
  await source.search('nothing', { limit: 5 });
  await source.search('nothing', { limit: 5 });
  assert.equal(calls, 3);
});

test('stream: an empty, malformed or unplayable answer is a miss; bad track ids are refused', async () => {
  const code = `
    module.exports = {
      getTrackStreamUrl: async function (id) {
        if (id === 'empty') return { streamUrl: null };
        if (id === 'doubled') return { streamUrl: 'https://cdn.example/x/https://cdn.example/x/a.flac' };
        if (id === 'relative') return { streamUrl: '/a.flac' };
        if (id === 'atmos') return { streamUrl: 'https://cdn.example/a.mp4', track: { audioQuality: 'DOLBY_ATMOS' } };
        return { streamUrl: 'https://cdn.example/ok.128.mp3', track: { audioQuality: 'LOW' } };
      }
    };`;
  const source = createModuleSource({ modules: [{ id: 'm', code }], fetch: fakeFetch([]) });
  for (const id of ['empty', 'doubled', 'relative', 'atmos']) assert.equal(await source.stream(`m::${id}`, StreamRequest.lossless), null, id);
  assert.equal(await source.stream('no-separator', StreamRequest.lossless), null);
  assert.equal(await source.stream('unknown::x', StreamRequest.lossless), null);
  const ok = await source.stream('m::fine', StreamRequest.best);
  assert.deepEqual(ok.format, { codec: 'mp3', kbps: 128, sampleRate: null, bitDepth: null });
});

// ── Lossless detection heuristics (ModuleSource.codecOf / kbpsFor / rowTier) ──

test('codec: MIME subtype verbatim → Atmos label → lossless label → URL extension', () => {
  assert.equal(moduleCodecOf('audio/flac', 'HIGH', 'https://cdn/a.mp3'), 'flac');
  assert.equal(moduleCodecOf('audio/mp4', 'LOSSLESS', 'https://cdn/a.flac'), 'mp4'); // FLAC-in-MP4 reads as lossy
  assert.equal(moduleCodecOf('audio/eac3', 'DOLBY_ATMOS', 'https://cdn/a.mp4'), 'eac3'); // and E-AC-3 as not Atmos
  assert.equal(moduleCodecOf(null, 'Dolby Atmos', 'https://cdn/a.mp4'), 'eac3-joc');
  assert.equal(moduleCodecOf(null, 'EAC3_JOC', 'https://cdn/a.mp4'), 'eac3-joc');
  assert.equal(moduleCodecOf('', 'FLAC 24-bit / 96 kHz', 'https://cdn/a.mp4'), 'flac');
  assert.equal(moduleCodecOf(null, 'HI_RES', 'https://cdn/a'), 'flac');
  assert.equal(moduleCodecOf(null, 'HIGH', 'https://cdn/track.M4A?sig=1'), 'm4a');
  assert.equal(moduleCodecOf(null, '', 'https://cdn/dash/manifest'), null);
});

test('kbps: label, then the .128. in a URL, then the label tier (HIGH 320, LOW 128)', () => {
  assert.equal(moduleKbpsFor('256kbps', 'https://cdn/a.mp3'), 256);
  assert.equal(moduleKbpsFor(null, 'https://cdn/ikpkCKbPKAqA.128.mp3'), 128);
  assert.equal(moduleKbpsFor('HIGH', 'https://cdn/a'), 320);
  assert.equal(moduleKbpsFor('LOW', 'https://cdn/a'), 128);
  assert.equal(moduleKbpsFor('LOSSLESS', 'https://cdn/a.flac'), null);
  // An out-of-range label is no answer: the URL is asked next...
  assert.equal(moduleKbpsFor('5000kbps', 'https://cdn/x.128.mp3'), 128);
  assert.equal(moduleKbpsFor('5000kbps', 'https://cdn/a'), null);
});

test('rowTier: what the row states beats what it lists as available', () => {
  assert.equal(rowTier({ audioQuality: 'HIGH', format: '', availableQualities: ['LOSSLESS'] }), 'HIGH');
  assert.equal(rowTier({ audioQuality: '', format: '', availableQualities: ['LOW', 'LOSSLESS', 'HIGH'] }), 'LOSSLESS');
  assert.equal(rowTier({ audioQuality: '', format: '', availableQualities: ['DOLBY_ATMOS'] }), null);
});

test('parseModuleIndex: category keys only, a bad category dropped whole, first id wins', () => {
  const modules = parseModuleIndex({
    name: 'not a category',
    'category:music': [{ id: 'a', name: 'A', download: 'a.js', labels: ['FLAC'] }, { id: 'b', name: 'B', download: 'b.js' }],
    'category:broken': [{ id: 'c', name: 'C' }, { name: 'no id' }],
    'category:more': [{ id: 'a', name: 'duplicate', download: 'dup.js' }, { id: 'd', name: 'D', download: 'd.js' }],
    'category:artworks': [{ id: 'art', name: 'Art' }],
  });
  assert.deepEqual(modules.map((m) => `${m.id}:${m.download}`), ['a:a.js', 'b:b.js', 'd:d.js']);
  assert.deepEqual(modules[0].tags, ['FLAC']);
});

// ── The search fan-out (ModuleSource.search) ───────────────────────────────

const moduleAnswering = (rows, delayMs) => `
  module.exports = {
    searchTracks: async function () {
      await new Promise(function (resolve) { setTimeout(resolve, ${delayMs}); });
      return { tracks: ${JSON.stringify(rows)}, total: ${rows.length} };
    }
  };`;
const row = (id) => ({ id, title: `T${id}`, artist: 'A', duration: 180 });

test('fan-out: answers are interleaved round-robin and trimmed to the limit', async () => {
  const source = createModuleSource({
    modules: [
      { id: 'one', code: moduleAnswering([row('1a'), row('1b'), row('1c')], 1) },
      { id: 'two', code: moduleAnswering([row('2a'), row('2b')], 1) },
    ],
    fetch: fakeFetch([]),
    budgets: { firstAnswerMs: 500, graceMs: 200 },
  });
  const rows = await source.search('anything', { limit: 4 });
  assert.deepEqual(rows.map((r) => r.id), ['one::1a', 'two::2a', 'one::1b', 'two::2b']);
});

test('fan-out: a module slower than the grace period sits this track out; waitForAll waits for it', async () => {
  const modules = [
    { id: 'fast', code: moduleAnswering([row('f')], 1) },
    { id: 'slow', code: moduleAnswering([row('s')], 120) },
  ];
  const live = createModuleSource({ modules, fetch: fakeFetch([]), budgets: { firstAnswerMs: 500, graceMs: 30 } });
  assert.deepEqual((await live.search('q', { limit: 5 })).map((r) => r.id), ['fast::f']);
  const patient = createModuleSource({
    modules,
    fetch: fakeFetch([]),
    budgets: { firstAnswerMs: 500, patientGraceMs: 1_000, patientMs: 2_000 },
  });
  assert.deepEqual((await patient.search('q', { limit: 5, waitForAll: true })).map((r) => r.id), ['fast::f', 'slow::s']);
});

test('fan-out: when every module answers empty the search ends at once, not after the budget', async () => {
  const source = createModuleSource({
    modules: [
      { id: 'a', code: moduleAnswering([], 1) },
      { id: 'b', code: moduleAnswering([], 5) },
    ],
    fetch: fakeFetch([]),
    budgets: { firstAnswerMs: 2_000, graceMs: 2_000 },
  });
  const started = Date.now();
  assert.deepEqual(await source.search('missing', { limit: 5 }), []);
  assert.ok(Date.now() - started < 1_000, 'waited out the first-answer budget');
});
