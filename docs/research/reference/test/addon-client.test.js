// Tests for sources/addonClient.js (mirrors AddonClient.kt, AddonModels.kt,
// AddonSource.kt). Payloads follow app/src/test/.../AddonSourceTest.kt, several
// of which were captured from live addons in September 2026.
// Independent JavaScript re-implementation of the mechanism documented in BITCHORD_ENGINE_RESEARCH.md (BitChord itself is GPL-3.0).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeFetch } from '../lib/http.js';
import {
  AddonUnavailable,
  createAddonClient,
  createAddonSource,
  matchTier,
  normalizeBase,
  readStream,
  redact,
  retryAfterMs,
} from '../sources/addonClient.js';
import { bestAcross, StreamRequest } from '../sources/resolve.js';

const BASE = 'https://addon.example.com/tok123';
const MANIFEST = { id: 'com.test.addon', name: 'Test Addon', version: '2.1.0', resources: ['search', 'stream'] };

const pathIs = (path) => (url) => new URL(url).pathname === path;
const json = (body, status = 200, headers = {}) => () => ({ status, body, headers: { 'content-type': 'application/json', ...headers } });

/** A fake fetch serving the manifest plus `routes` ([path, responder] pairs, or full [match, responder]). */
function addonFetch(routes = [], { manifest = MANIFEST } = {}) {
  const table = routes.map(([match, respond]) => [typeof match === 'string' ? pathIs(`/tok123${match}`) : match, respond]);
  if (manifest) table.push([pathIs('/tok123/manifest.json'), json(manifest)]);
  return fakeFetch(table);
}

/** The first request the fake saw for `path` under the base. */
const requestFor = (fetch, path) => {
  const call = fetch.calls.find((c) => new URL(c.url).pathname === `/tok123${path}`);
  assert.ok(call, `no request for ${path}`);
  return new URL(call.url);
};

/** A clock that only moves when the client sleeps, so back-off is deterministic. */
function fakeClock() {
  let now = 1_000_000;
  const sleeps = [];
  return {
    now: () => now,
    sleep: async (ms) => {
      sleeps.push(ms);
      now += ms;
    },
    advance: (ms) => {
      now += ms;
    },
    sleeps,
  };
}

// ── URL handling ────────────────────────────────────────────────────────────

test('normalizeBase accepts every form of the address a user might paste', () => {
  const expected = 'https://addon.example.com';
  for (const raw of [
    'https://addon.example.com',
    'https://addon.example.com/',
    '  https://addon.example.com//  ',
    'https://addon.example.com/manifest.json',
    'https://addon.example.com/MANIFEST.JSON',
    'https://addon.example.com/addon.json',
  ]) {
    assert.equal(normalizeBase(raw), expected, raw);
  }
  assert.equal(normalizeBase('https://addon.example.com/abc123/manifest.json'), 'https://addon.example.com/abc123');
});

test('redact hides the token in the path and keeps the host', () => {
  assert.equal(redact('https://addon.example.com/secret-token/stream/42'), 'https://addon.example.com/***');
  assert.equal(redact('not a url'), '***');
});

test('matchTier: exact match first, then a keyword, then the first option', () => {
  assert.equal(matchTier('LOSSLESS', ['lossless', 'high', 'normal']), 'lossless');
  assert.equal(matchTier('LOSSLESS', ['best (FLAC)', 'normal']), 'best (FLAC)');
  assert.equal(matchTier('LOW', ['320', '128']), '128');
  assert.equal(matchTier('HIGH', ['hires', 'standard']), 'standard');
  assert.equal(matchTier('LOW', ['a', 'b']), 'a');
  assert.equal(matchTier('HIGH', []), null);
});

test('retryAfterMs: Retry-After seconds when numeric, else 0.5 s << attempt, clamped to [0.5 s, 8 s]', () => {
  assert.equal(retryAfterMs('2', 0), 2000);
  assert.equal(retryAfterMs('0', 0), 500);
  assert.equal(retryAfterMs('1.5', 0), 1500);
  assert.equal(retryAfterMs('120', 0), 8000);
  assert.equal(retryAfterMs(null, 0), 500);
  assert.equal(retryAfterMs(null, 1), 1000);
  assert.equal(retryAfterMs(null, 5), 8000);
  assert.equal(retryAfterMs('Wed, 21 Oct 2015 07:28:00 GMT', 1), 1000); // an HTTP-date is not read
});

// ── Health ──────────────────────────────────────────────────────────────────

test('a well-formed manifest reports healthy with its name and version', async () => {
  const addon = createAddonSource(BASE, { fetch: addonFetch() });
  assert.deepEqual(await addon.health(), { status: 'ok', detail: 'Test Addon v2.1.0' });
});

test('an addon that cannot be searched is rejected; one without stream is accepted', async () => {
  const noSearch = createAddonSource(BASE, { fetch: addonFetch([], { manifest: { ...MANIFEST, resources: ['catalog'] } }) });
  assert.equal((await noSearch.health()).status, 'rejected');
  const searchOnly = createAddonSource(BASE, { fetch: addonFetch([], { manifest: { ...MANIFEST, resources: ['search'] } }) });
  assert.equal((await searchOnly.health()).status, 'ok');
});

test('no manifest is still healthy when /search answers', async () => {
  const fetch = addonFetch([['/search', json({ tracks: [] })]], { manifest: null });
  assert.deepEqual(await createAddonSource(BASE, { fetch }).health(), { status: 'ok', detail: 'No manifest · search works' });
});

test('a document that is not a manifest is rejected; no manifest and no search is rejected too', async () => {
  const notManifest = createAddonSource(BASE, { fetch: addonFetch([], { manifest: { hello: 'world' } }) });
  assert.deepEqual(await notManifest.health(), {
    status: 'rejected',
    detail: 'That URL answered, but not with an addon manifest',
  });
  const nothing = createAddonSource(BASE, { fetch: addonFetch([], { manifest: null }) });
  assert.deepEqual(await nothing.health(), { status: 'rejected', detail: 'No manifest at that URL' });
});

test('a server error reads as unreachable, not as a configuration problem', async () => {
  const fetch = fakeFetch([[() => true, () => ({ status: 503, body: 'down' })]]);
  assert.deepEqual(await createAddonSource(BASE, { fetch }).health(), { status: 'unreachable', detail: 'HTTP 503' });
});

// ── Settings passthrough ────────────────────────────────────────────────────

test('declared setting defaults travel with the request and quality overrides them', async () => {
  const fetch = addonFetch([['/search', json({ tracks: [] })]], {
    manifest: {
      ...MANIFEST,
      resources: ['search', 'stream', 'settings'],
      settings: [
        { key: 'quality', type: 'select', default: 'normal', options: [{ value: 'lossless' }, { value: 'high' }, { value: 'normal' }] },
        { key: 'region', type: 'text', default: 'US' },
        { key: 'preferOpus', type: 'toggle', default: true },
        { key: 'blank', type: 'text', default: '  ' },
        { key: 'object', default: { a: 1 } },
      ],
    },
  });
  await createAddonSource(BASE, { fetch }).search('hello world', { limit: 5 });
  const url = requestFor(fetch, '/search');
  assert.equal(url.searchParams.get('q'), 'hello world');
  assert.equal(url.searchParams.get('region'), 'US');
  assert.equal(url.searchParams.get('preferOpus'), 'true');
  assert.equal(url.searchParams.get('quality'), 'lossless');
  assert.equal(url.searchParams.has('blank'), false);
  assert.equal(url.searchParams.has('object'), false);
  // Declared order first, the query last.
  assert.deepEqual([...url.searchParams.keys()], ['quality', 'region', 'preferOpus', 'q']);
});

test('with no options enumerated the tier goes verbatim; capped asks LOW; the search box asks LOSSLESS', async () => {
  const fetch = addonFetch([
    ['/search', json({ tracks: [] })],
    [(url) => new URL(url).pathname.startsWith('/tok123/stream/'), json({ url: 'https://cdn.example.com/a.flac' })],
  ]);
  const addon = createAddonSource(BASE, { fetch });
  await addon.stream('t1', StreamRequest.lossless);
  assert.equal(requestFor(fetch, '/stream/t1').searchParams.get('quality'), 'LOSSLESS');
  await addon.stream('t2', StreamRequest.capped(64));
  assert.equal(requestFor(fetch, '/stream/t2').searchParams.get('quality'), 'LOW');
  await addon.stream('t3', StreamRequest.best);
  assert.equal(requestFor(fetch, '/stream/t3').searchParams.get('quality'), 'HIGH');
  await addon.search('x', { limit: 5 });
  assert.equal(requestFor(fetch, '/search').searchParams.get('quality'), 'LOSSLESS');
});

test('atmos=auto travels on search and stream only when Atmos is allowed, never over a declared atmos', async () => {
  const routes = [
    ['/search', json({ tracks: [] })],
    ['/stream/t1', json({ url: 'https://cdn.example.com/a.flac', codec: 'flac' })],
  ];
  const on = addonFetch(routes);
  const allowed = createAddonSource(BASE, { fetch: on, atmosAllowed: true });
  await allowed.search('x', { limit: 5 });
  await allowed.stream('t1', StreamRequest.lossless);
  assert.equal(requestFor(on, '/search').searchParams.get('atmos'), 'auto');
  assert.equal(requestFor(on, '/stream/t1').searchParams.get('atmos'), 'auto');

  const off = addonFetch(routes);
  await createAddonSource(BASE, { fetch: off, atmosAllowed: false }).search('x', { limit: 5 });
  assert.equal(requestFor(off, '/search').searchParams.has('atmos'), false);

  const declared = addonFetch(routes, { manifest: { ...MANIFEST, settings: [{ key: 'atmos', default: 'off' }] } });
  await createAddonSource(BASE, { fetch: declared, atmosAllowed: true }).search('x', { limit: 5 });
  assert.equal(requestFor(declared, '/search').searchParams.get('atmos'), 'off');
});

// ── Search rows ─────────────────────────────────────────────────────────────

test('a Tidal immersive row is tagged DOLBY, not by its LOW bitrate label', async () => {
  const fetch = addonFetch([
    [
      '/search',
      json({
        tracks: [
          { id: 'tidal:479222720', title: 'Gehra Hua', artist: 'Shashwat Sachdev', album: 'Dhurandhar', duration: 362,
            format: 'flac', audioQuality: 'LOSSLESS', audioModes: ['STEREO'], provider: 'Tidal' },
          { id: 'tidal:527739156', title: 'Gehra Hua (From "Dhurandhar")', artist: 'Shashwat Sachdev', album: 'Dhurandhar',
            duration: 362, format: 'dash', audioQuality: 'LOW', audioModes: ['DOLBY_ATMOS'], atmos: true, provider: 'Tidal' },
          { id: 't3', title: 'S', artist: 'A', duration: 200, audioQuality: 'LOW', audioModes: ['DOLBY_ATMOS'] },
          { id: 't4', title: 'S', artist: 'A', duration: 200, audioQuality: 'LOW', audioModes: ['STEREO'], format: 'mp3' },
        ],
      }),
    ],
  ]);
  const rows = await createAddonSource(BASE, { fetch }).search('gehra hua', { limit: 10 });
  assert.deepEqual(rows.map((r) => r.quality), ['LOSSLESS', 'DOLBY', 'DOLBY', 'LOW']);
});

test('real search rows keep provider-prefixed ids, fall back to album artwork, and read durations', async () => {
  const fetch = addonFetch([
    [
      '/search',
      json({
        tracks: [
          { id: 'tidal:417594671', sourceId: '417594671', title: 'Daylight', artist: 'David Kushner', album: 'Daylight',
            albumArtworkURL: 'https://resources.tidal.com/images/x/1080x1080.jpg', trackNumber: 1, duration: 212,
            format: 'flac', isrc: 'QZXDB2300005', audioQuality: 'LOSSLESS', provider: 'Tidal', audioModes: ['STEREO'] },
          { id: '', title: 'no id' },
          { id: 'x', title: '   ' },
          { id: 42, title: 'Numeric id', artist: 'A', duration: '240.7' },
        ],
        albums: [],
      }),
    ],
  ]);
  const rows = await createAddonSource(BASE, { fetch }).search('daylight', { limit: 5 });
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], {
    id: 'tidal:417594671',
    title: 'Daylight',
    artist: 'David Kushner',
    album: 'Daylight',
    artwork: 'https://resources.tidal.com/images/x/1080x1080.jpg',
    durationSec: 212,
    explicit: null,
    quality: 'LOSSLESS',
  });
  assert.equal(rows[1].id, '42');
  assert.equal(rows[1].durationSec, 240);
});

test('search honours the limit, and an unreachable addon returns no rows rather than throwing', async () => {
  const many = { tracks: Array.from({ length: 10 }, (_, i) => ({ id: `t${i}`, title: `T${i}`, artist: 'A' })) };
  const limited = createAddonSource(BASE, { fetch: addonFetch([['/search', json(many)]]) });
  assert.equal((await limited.search('t', { limit: 3 })).length, 3);
  const down = createAddonSource(BASE, { fetch: fakeFetch([[() => true, () => ({ status: 500, body: '' })]]) });
  assert.deepEqual(await down.search('t', { limit: 3 }), []);
});

test('a track id containing a slash stays one path segment', async () => {
  const fetch = addonFetch([['/stream/a%2Fb%3Fc', json({ url: 'https://cdn.example.com/a.flac' })]]);
  assert.ok(await createAddonSource(BASE, { fetch }).stream('a/b?c', StreamRequest.lossless));
});

// ── Stream format: codec precedence ────────────────────────────────────────

const streamWith = async (answer, request = StreamRequest.lossless, options = {}) => {
  const fetch = addonFetch([['/stream/t1', json(answer)]]);
  return createAddonSource(BASE, { fetch, ...options }).stream('t1', request);
};

test('the routing fields become the format the player is told about', async () => {
  const stream = await streamWith({
    url: 'https://cdn.example.com/a.flac', format: 'flac', quality: 'lossless', codec: 'flac', container: 'flac',
    manifest: 'none', encrypted: false, sampleRate: 96000, bitDepth: 24,
  });
  assert.equal(stream.url, 'https://cdn.example.com/a.flac');
  assert.deepEqual(stream.format, { codec: 'flac', kbps: null, sampleRate: 96000, bitDepth: 24 });
  assert.equal(stream.transport, null);
});

test('codec precedence: stated codec → container → MIME → Atmos hint → lossless label → URL extension', async () => {
  const codecOf = async (answer, request) => (await streamWith(answer, request, { atmosAllowed: true })).format.codec;
  assert.equal(await codecOf({ url: 'https://cdn/a.mp3', codec: 'ALAC', container: 'flac', mimeType: 'audio/mpeg' }), 'alac');
  assert.equal(await codecOf({ url: 'https://cdn/a.mp3', codec: 'weird', container: 'WAV', mimeType: 'audio/ogg' }), 'wav');
  assert.equal(await codecOf({ url: 'https://cdn/a.mp3', container: 'mp4', mimeType: 'audio/ogg; codecs=opus' }), 'ogg');
  assert.equal(await codecOf({ url: 'https://cdn/a.mp3', mimeType: 'audio/mpeg', quality: 'Dolby Atmos' }), 'eac3-joc');
  assert.equal(await codecOf({ url: 'https://cdn/a.mp3', quality: 'HI_RES_LOSSLESS' }), 'flac');
  assert.equal(await codecOf({ url: 'https://cdn/track.opus?sig=1' }), 'opus');
  assert.equal(await codecOf({ url: 'https://cdn/dash/track' }), null);
});

test('kbps: bitrate over 3000 is bps, else kbps; a label; else the tier (HIGH 320, LOW 128)', async () => {
  assert.equal((await streamWith({ url: 'https://cdn/a.mp3', codec: 'mp3', bitrate: 320000 }, StreamRequest.best)).format.kbps, 320);
  assert.equal((await streamWith({ url: 'https://cdn/a.flac', codec: 'flac', bitrate: 1411 })).format.kbps, 1411);
  assert.equal((await streamWith({ url: 'https://cdn/a.mp3', quality: '256kbps' }, StreamRequest.best)).format.kbps, 256);
  assert.equal((await streamWith({ url: 'https://cdn/a.mp3' }, StreamRequest.best)).format.kbps, 320);
  assert.equal((await streamWith({ url: 'https://cdn/a.mp3' }, StreamRequest.capped(64))).format.kbps, 128);
  assert.equal((await streamWith({ url: 'https://cdn/a.mp3' }, StreamRequest.lossless)).format.kbps, null);
});

test('a real Tidal Hi-Res answer routes to DASH on the strength of its format field', async () => {
  const url = 'https://im-fa.manifest.tidal.com/1/manifests/Egk0MTc1OTQ2NzEYAigBMAJY3onUY2CHaGoIUExBWUJBQ0s';
  const stream = await streamWith({
    url, format: 'dash', quality: 'Tidal · Hi-Res FLAC (DASH)', streamQuality: '[Tidal] HI_RES_LOSSLESS',
    provider: 'Tidal', expiresAt: 1788633325,
  });
  assert.equal(stream.transport, 'dash');
  assert.equal(stream.format.codec, 'flac');
});

test('a container in the format field is not mistaken for a transport (JioSaavn via an addon)', async () => {
  const stream = await streamWith(
    { url: 'https://aac.saavncdn.com/601/b81082b74fa06e4596b5b111b0115d1a_320.mp4', format: 'mp4', quality: '320kbps', provider: 'JioSaavn' },
    StreamRequest.best,
  );
  assert.equal(stream.transport, null);
  assert.equal(stream.format.codec, 'mp4');
  assert.equal(stream.format.kbps, 320);
});

test('an extensionless HLS playlist is declared; bit depth and rate are read from free text', async () => {
  const hls = await streamWith({ url: 'https://cdn.example.com/dash/t1', format: 'flac', codec: 'flac', manifest: 'hls' });
  assert.equal(hls.transport, 'hls');
  const labelled = await streamWith({ url: 'https://cdn/a', format: 'dash', quality: 'FLAC 24-bit / 96 kHz' });
  assert.equal(labelled.format.bitDepth, 24);
  assert.equal(labelled.format.sampleRate, 96000);
  assert.equal(readStream({ sampleRate: 44.1 }).sampleRateHz, 44100); // kHz where Hz was specified
});

test('an Atmos answer (underscore codec and all) plays where allowed and is refused where not', async () => {
  const answer = {
    url: 'https://cdn.example.com/dash/tidal-atmos', format: 'dash', quality: 'Tidal · Dolby Atmos',
    streamQuality: '[Tidal] DOLBY_ATMOS', codec: 'eac3_joc', container: 'mp4', manifest: 'dash', sampleRate: 48000,
    atmos: true, encrypted: false,
  };
  const allowed = await streamWith(answer, StreamRequest.lossless, { atmosAllowed: true });
  assert.equal(allowed.format.codec, 'eac3-joc');
  assert.equal(allowed.transport, 'dash');
  assert.equal(await streamWith(answer, StreamRequest.lossless, { atmosAllowed: false }), null);
});

// ── Refusals and misses ────────────────────────────────────────────────────

test('an encrypted rendition is refused; encrypted false or "none" is not', async () => {
  assert.equal(await streamWith({ url: 'https://cdn/a.mpd', encrypted: 'widevine', manifest: 'dash' }), null);
  assert.equal(await streamWith({ url: 'https://cdn/a.mpd', encrypted: true }), null);
  assert.equal(await streamWith({ url: 'https://cdn/a.mpd', encrypted: 0 }), null); // any other primitive names a scheme
  assert.ok(await streamWith({ url: 'https://cdn/a.flac', encrypted: false }));
  assert.ok(await streamWith({ url: 'https://cdn/a.flac', encrypted: 'NONE' }));
  assert.ok(await streamWith({ url: 'https://cdn/a.flac', encrypted: null }));
});

test('a malformed stream URL is refused before the player sees it', async () => {
  assert.equal(await streamWith({ url: '/relative/path.flac' }), null);
  assert.equal(await streamWith({ url: 'file:///sdcard/a.flac' }), null);
});

test('a 404, a 502 and a 200 carrying only an error are all misses', async () => {
  const lines = [];
  const fetch = addonFetch([
    ['/stream/gateway', () => ({ status: 502, body: 'bad gateway' })],
    ['/stream/arl', json({ error: 'Deezer ARL required — set it in the setup page' })],
  ]);
  const addon = createAddonSource(BASE, { fetch, log: (line) => lines.push(line) });
  assert.equal(await addon.stream('nope', StreamRequest.lossless), null);
  assert.equal(await addon.stream('gateway', StreamRequest.lossless), null);
  assert.equal(await addon.stream('arl', StreamRequest.lossless), null);
  // A 404 is a quiet miss; the others say why.
  assert.ok(!lines.some((line) => line.includes('stream failed for nope')));
  assert.ok(lines.some((line) => line.includes('HTTP 502')));
  assert.ok(lines.some((line) => line.includes('Deezer ARL required')));
});

test("the search row's own streamURL is used when /stream has nothing, with the row's duration", async () => {
  const fetch = addonFetch([
    ['/search', json({ tracks: [{ id: 't1', title: 'S', artist: 'A', duration: 180, streamURL: 'https://cdn.example.com/direct.mp3', format: 'mp3' }] })],
  ]);
  const addon = createAddonSource(BASE, { fetch });
  await addon.search('s', { limit: 5 });
  const stream = await addon.stream('t1', StreamRequest.best);
  assert.equal(stream.url, 'https://cdn.example.com/direct.mp3');
  assert.equal(stream.format.codec, 'mp3');
  assert.equal(stream.durationSec, 180);
  assert.equal(await addon.stream('unknown', StreamRequest.best), null);
});

test("a searched row's duration reaches the stream it produces", async () => {
  const fetch = addonFetch([
    ['/search', json({ tracks: [{ id: 't1', title: 'S', artist: 'A', duration: 242 }] })],
    ['/stream/t1', json({ url: 'https://cdn/a.flac', codec: 'flac' })],
  ]);
  const addon = createAddonSource(BASE, { fetch });
  await addon.search('s', { limit: 5 });
  assert.equal((await addon.stream('t1', StreamRequest.lossless)).durationSec, 242);
});

// ── Rate limiting ───────────────────────────────────────────────────────────

/** A route that answers from a queue of responders, then keeps repeating the last one. */
function sequence(...responders) {
  let at = 0;
  return (url, init) => responders[Math.min(at++, responders.length - 1)](url, init);
}

test('a 429 is waited out and retried; Retry-After is believed (and clamped to at least 0.5 s)', async () => {
  const clock = fakeClock();
  const fetch = addonFetch([
    ['/stream/t1', sequence(() => ({ status: 429, body: '', headers: { 'retry-after': '0' } }), json({ url: 'https://cdn/a.flac', codec: 'flac' }))],
  ]);
  const stream = await createAddonSource(BASE, { fetch, now: clock.now, sleep: clock.sleep }).stream('t1', StreamRequest.lossless);
  assert.ok(stream, 'a 429 should be retried, not reported as a miss');
  assert.deepEqual(clock.sleeps, [500]);
});

test('without Retry-After the back-off doubles from 0.5 s; after 2 retries the addon is unavailable', async () => {
  const clock = fakeClock();
  const limited = () => ({ status: 429, body: '' });
  const fetch = addonFetch([['/search', limited]]);
  const client = createAddonClient(BASE, { fetch, now: clock.now, sleep: clock.sleep });
  await assert.rejects(client.search('x', 'LOSSLESS'), (error) => error instanceof AddonUnavailable);
  assert.deepEqual(clock.sleeps, [500, 1000]);
  assert.equal(fetch.calls.filter((c) => new URL(c.url).pathname === '/tok123/search').length, 3);
});

test('the quiet window is per addon: a sibling call waits it out too', async () => {
  // Sleeps stay pending until released, so both calls can be seen inside the window.
  let now = 1_000_000;
  const pending = [];
  const sleep = (ms) => new Promise((resolve) => pending.push({ ms, resolve }));
  const settle = async (count) => {
    for (let i = 0; i < 200 && pending.length < count; i++) await new Promise((r) => setImmediate(r));
  };
  const fetch = addonFetch([
    ['/search', sequence(() => ({ status: 429, body: '', headers: { 'retry-after': '4' } }), json({ tracks: [] }))],
    ['/stream/t1', json({ url: 'https://cdn/a.flac', codec: 'flac' })],
  ]);
  const client = createAddonClient(BASE, { fetch, now: () => now, sleep });
  await client.manifest();
  const searching = client.search('x', 'LOSSLESS');
  await settle(1); // the search drew its 429 and is sleeping out the window
  now += 1_000; // one second into the four
  const streaming = client.stream('t1', 'LOSSLESS');
  await settle(2);
  assert.deepEqual(pending.map((p) => p.ms), [4000, 3000]);
  assert.equal(fetch.calls.some((c) => c.url.includes('/stream/t1')), false, 'the sibling went out inside the window');
  now += 3_000;
  for (const p of pending.splice(0)) p.resolve();
  await Promise.all([searching, streaming]);
  assert.equal(fetch.calls.filter((c) => c.url.includes('/stream/t1')).length, 1);
});

// ── Caching (SharedCalls: failures not kept, empty answers kept) ───────────

test('search answers, empty ones included, are shared for 10 minutes; failures are not kept', async () => {
  const clock = fakeClock();
  let searches = 0;
  let failures = 0;
  const fetch = addonFetch([
    ['/search', (url) => {
      if (new URL(url).searchParams.get('q') === 'broken') {
        failures++;
        return { status: 500, body: '' };
      }
      searches++;
      return { status: 200, body: { tracks: [] } };
    }],
  ]);
  const client = createAddonClient(BASE, { fetch, now: clock.now, sleep: clock.sleep });
  await client.search('nothing here', 'LOSSLESS');
  await client.search('nothing here', 'LOSSLESS');
  assert.equal(searches, 1);
  await client.search('nothing here', 'HIGH'); // another tier is another question
  assert.equal(searches, 2);
  clock.advance(10 * 60 * 1000);
  await client.search('nothing here', 'LOSSLESS');
  assert.equal(searches, 3);
  await assert.rejects(client.search('broken', 'LOSSLESS'));
  await assert.rejects(client.search('broken', 'LOSSLESS'));
  assert.equal(failures, 2);
});

test('stream answers are shared for 5 minutes; the manual refresh asks again', async () => {
  const clock = fakeClock();
  let streams = 0;
  const fetch = addonFetch([['/stream/t1', () => ({ status: 200, body: { url: `https://cdn/a${++streams}.flac`, codec: 'flac' } })]]);
  const addon = createAddonSource(BASE, { fetch, now: clock.now, sleep: clock.sleep });
  assert.equal((await addon.stream('t1', StreamRequest.lossless)).url, 'https://cdn/a1.flac');
  clock.advance(5 * 60 * 1000 - 1);
  assert.equal((await addon.stream('t1', StreamRequest.lossless)).url, 'https://cdn/a1.flac');
  clock.advance(1);
  assert.equal((await addon.stream('t1', StreamRequest.lossless)).url, 'https://cdn/a2.flac');
  addon.clearCompletedTrackCalls();
  assert.equal((await addon.stream('t1', StreamRequest.lossless)).url, 'https://cdn/a3.flac');
});

test('a 404 on /stream is not cached, so the next play asks again', async () => {
  const fetch = addonFetch([]);
  const addon = createAddonSource(BASE, { fetch });
  await addon.stream('gone', StreamRequest.lossless);
  await addon.stream('gone', StreamRequest.lossless);
  assert.equal(fetch.calls.filter((c) => c.url.includes('/stream/gone')).length, 2);
});

test('an addon with no manifest pays a manifest request on every call (a failure is never cached)', async () => {
  const fetch = addonFetch([['/search', json({ tracks: [] })]], { manifest: null });
  const client = createAddonClient(BASE, { fetch });
  await client.search('a', 'LOSSLESS');
  await client.search('b', 'LOSSLESS');
  assert.equal(fetch.calls.filter((c) => c.url.endsWith('/manifest.json')).length, 2);
});

// ── Transport ───────────────────────────────────────────────────────────────

test('every call sends Accept: application/json and the BitChord User-Agent', async () => {
  const fetch = addonFetch([['/search', json({ tracks: [] })]]);
  await createAddonClient(BASE, { fetch }).search('x', 'LOSSLESS');
  const headers = fetch.calls[0].init.headers;
  assert.equal(headers.Accept, 'application/json');
  assert.equal(headers['User-Agent'], 'BitChord');
});

test('the call timeout bounds a server that never answers', async () => {
  const lines = [];
  const hanging = async (url, init) =>
    new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason)));
  const addon = createAddonSource(BASE, { fetch: hanging, callTimeoutMs: 20, log: (line) => lines.push(line) });
  const started = Date.now();
  assert.deepEqual(await addon.search('x', { limit: 5 }), []);
  assert.ok(Date.now() - started < 1_000);
  assert.ok(lines.some((line) => line.includes('timeout after 20 ms')), lines.join('\n'));
});

// ── Through the resolver ────────────────────────────────────────────────────

test('an addon serves a lossless match through bestAcross', async () => {
  const fetch = addonFetch([
    ['/search', json({ tracks: [
      { id: 'cover', title: 'Paniyon Sa', artist: 'Some Cover Band', duration: 247, audioQuality: 'LOSSLESS' },
      { id: 'real', title: 'Paniyon Sa', artist: 'Atif Aslam, Tulsi Kumar', album: 'Satyameva Jayate', duration: 246, audioQuality: 'LOSSLESS', format: 'flac' },
    ] })],
    ['/stream/real', json({ url: 'https://cdn.example.com/real.flac', codec: 'flac', bitDepth: 24, sampleRate: 48000 })],
  ]);
  const addon = createAddonSource(BASE, { fetch });
  const target = { title: 'Paniyon Sa (From "Satyameva Jayate")', artist: 'Atif Aslam', durationSec: 247 };
  const found = await bestAcross([addon], target, StreamRequest.lossless);
  assert.equal(found.stream.url, 'https://cdn.example.com/real.flac');
  assert.equal(found.stream.durationSec, 246);
  assert.equal(found.stream.sourceId, addon.id);
  assert.equal(fetch.calls.some((c) => c.url.includes('/stream/cover')), false);
});
