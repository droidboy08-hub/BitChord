// Tests for the word-synced / Apple-family providers: BiniLyrics,
// BetterLyrics (+ Portato), PaxSenix (Apple, Spotify, Musixmatch), LyricsPlus,
// Unison and SimpMusic.
//
// No network: every response comes from fakeFetch, shaped the way BitChord's
// Kotlin reads it (BiniLyrics and Unison envelopes follow the payloads captured
// in BitChord's NewLyricsSourceTest.kt). Lyrics, titles and ids are
// placeholders; the Apple token is a fake that only has the shape of a JWT.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeFetch } from '../lib/http.js';
import * as bini from '../lyrics/providers/binilyrics.js';
import * as betterLyrics from '../lyrics/providers/betterlyrics.js';
import * as pax from '../lyrics/providers/paxsenix.js';
import * as lyricsPlus from '../lyrics/providers/lyricsplus.js';
import * as unison from '../lyrics/providers/unison.js';
import * as simpMusic from '../lyrics/providers/simpmusic.js';

// ---- helpers ------------------------------------------------------------------

const QUERY = Object.freeze({
  title: 'Placeholder Song',
  artist: 'Test Artist',
  album: 'Test Album',
  durationMs: 209_900, // → 209 whole seconds on the wire
  videoId: 'abcDEF12345',
});

const json = (body, status = 200) => () => ({ status, body, headers: { 'content-type': 'application/json' } });
const text = (body, status = 200) => () => ({ status, body });
const startsWith = (prefix) => (url) => url.startsWith(prefix);
const sung = (lines) => lines.filter((l) => l.text !== '');
const headerOf = (call, name) => call.init.headers?.[name];

/** fakeFetch, plus hosts that never answer until their request is aborted. */
function fetchWithHangs(isHanging, routes) {
  const fake = fakeFetch(routes);
  const impl = (url, init = {}) => {
    if (!isHanging(String(url))) return fake(url, init);
    fake.calls.push({ url: String(url), init });
    return new Promise((_, reject) => {
      const fail = () => reject(init.signal.reason ?? new Error('aborted'));
      if (init.signal?.aborted) fail();
      else init.signal?.addEventListener('abort', fail, { once: true });
    });
  };
  impl.calls = fake.calls;
  return impl;
}

/** Word-timed Apple TTML with a duet and a background vocal. */
const TTML = [
  '<tt xmlns="http://www.w3.org/ns/ttml" xmlns:itunes="http://music.apple.com/lyric-ttml-internal"',
  ' xmlns:ttm="http://www.w3.org/ns/ttml#metadata" itunes:timing="Word" xml:lang="en">',
  '<head><metadata><ttm:agent type="person" xml:id="v1"/><ttm:agent type="person" xml:id="v2"/></metadata></head>',
  '<body dur="3:29.900"><div begin="1.000" end="6.000">',
  '<p begin="1.000" end="2.500" itunes:key="L1" ttm:agent="v1"><span begin="1.000" end="1.400">sing</span> ',
  '<span begin="1.400" end="1.700">a</span><span begin="1.700" end="2.500">long</span></p>',
  '<p begin="3.000" end="6.000" itunes:key="L2" ttm:agent="v2"><span begin="3.000" end="3.500">answer</span> ',
  '<span begin="3.500" end="4.000">back</span><span ttm:role="x-bg"><span begin="4.100" end="6.000">(back)</span></span></p>',
  '</div></body></tt>',
].join('');

function assertTtmlLines(lines) {
  assert.ok(lines, 'expected lines');
  const [first, second] = sung(lines);
  assert.equal(first.text, 'sing along');
  assert.deepEqual(first.words.map((w) => [w.text, w.startMs, w.endMs]), [['sing', 1_000, 1_400], ['along', 1_400, 2_500]]);
  assert.equal(second.alignment, 'end');
  assert.equal(second.background.text, '(back)');
}

// ---- BiniLyrics ------------------------------------------------------------------

const BINI_SEARCH = {
  total: 1,
  source: 'HIT-EXACT',
  results: [{
    id: '69b0336e00361778ec55',
    track_name: 'Placeholder Song',
    artist_name: 'Test Artist',
    album_name: 'Test Album - Single',
    duration: 209,
    isrc: 'XXABC2400001',
    timing_type: 'word',
    lyricsUrl: 'https://lyrics-storage.binimum.org/XXABC2400001.ttml',
  }],
};

test('BiniLyrics identify: searches by name, length in whole seconds, and reports the ISRC', async () => {
  const fetch = fakeFetch([[startsWith(bini.BASE), json(BINI_SEARCH)]]);
  const hit = await bini.identify(QUERY, { fetch });
  assert.equal(fetch.calls.length, 1);
  assert.equal(
    fetch.calls[0].url,
    'https://lyrics-api.binimum.org/?track=Placeholder%20Song&artist=Test%20Artist&album=Test%20Album&duration=209',
  );
  assert.equal(headerOf(fetch.calls[0], 'User-Agent'), 'BitChord (https://github.com/bitchord)');
  assert.equal(headerOf(fetch.calls[0], 'Accept'), 'application/json');
  assert.equal(hit.isrc, 'XXABC2400001');
  assert.equal(hit.lyricsUrl, 'https://lyrics-storage.binimum.org/XXABC2400001.ttml');
  assert.equal(hit.timingType, 'word');
  assert.equal(hit.source, 'HIT-EXACT');
});

test('BiniLyrics identify: an ISRC is sent alone, and unknown length/album are omitted', async () => {
  const fetch = fakeFetch([[startsWith(bini.BASE), json(BINI_SEARCH)]]);
  await bini.identify({ ...QUERY, isrc: 'XXABC2400001' }, { fetch });
  await bini.identify({ title: 'Placeholder Song', artist: 'Test Artist', durationMs: 0 }, { fetch });
  assert.deepEqual(fetch.calls.map((c) => c.url), [
    'https://lyrics-api.binimum.org/?isrc=XXABC2400001',
    'https://lyrics-api.binimum.org/?track=Placeholder%20Song&artist=Test%20Artist',
  ]);
});

test('BiniLyrics identify: a 404, an empty result set or a broken body is a miss', async () => {
  for (const respond of [json({ message: 'not found' }, 404), json({ total: 0 }), text('<html>oops</html>')]) {
    const fetch = fakeFetch([[startsWith(bini.BASE), respond]]);
    assert.equal(await bini.identify(QUERY, { fetch }), null);
  }
});

test('BiniLyrics identify: the repository cap turns a slow host into a miss, a caller abort into an error', async () => {
  const fetch = fetchWithHangs(() => true, []);
  const started = Date.now();
  assert.equal(await bini.identify(QUERY, { fetch }, { timeoutMs: 30 }), null);
  assert.ok(Date.now() - started < 1_000);
  assert.equal(bini.IDENTIFY_TIMEOUT_MS, 2_500);

  const controller = new AbortController();
  const pending = bini.identify(QUERY, { fetch, signal: controller.signal });
  controller.abort(new Error('track changed'));
  await assert.rejects(pending, /track changed/);
});

test('BiniLyrics provider: search, then the TTML document from the storage host', async () => {
  const fetch = fakeFetch([
    [startsWith(bini.BASE), json(BINI_SEARCH)],
    [startsWith('https://lyrics-storage.binimum.org/'), text(TTML)],
  ]);
  const [provider] = bini.providers;
  assert.deepEqual([provider.id, provider.label, provider.wordSynced], ['bini_lyrics', 'BiniLyrics', true]);
  assertTtmlLines(await provider.lyrics(QUERY, { fetch }));
  assert.equal(fetch.calls.length, 2);

  const match = await bini.lyrics(QUERY, { fetch });
  assert.equal(match.isrc, 'XXABC2400001');
});

test('BiniLyrics provider: a hit from identify() is reused; if its document fails the search runs again', async () => {
  const hit = await bini.identify(QUERY, { fetch: fakeFetch([[startsWith(bini.BASE), json(BINI_SEARCH)]]) });

  const reuse = fakeFetch([[startsWith('https://lyrics-storage.binimum.org/'), text(TTML)]]);
  assertTtmlLines(await bini.providers[0].lyrics(QUERY, { fetch: reuse, biniHit: hit }));
  assert.equal(reuse.calls.length, 1);

  // The first document fetch fails; BitChord then searches again (by ISRC when known).
  let documentRequests = 0;
  const retry = fakeFetch([
    [startsWith(bini.BASE), json(BINI_SEARCH)],
    [startsWith('https://lyrics-storage.binimum.org/'), () => (++documentRequests === 1 ? { status: 503, body: '' } : { body: TTML })],
  ]);
  assertTtmlLines(await bini.providers[0].lyrics({ ...QUERY, isrc: hit.isrc }, { fetch: retry, biniHit: hit }));
  assert.deepEqual(retry.calls.map((c) => c.url.split('?')[0]), [
    'https://lyrics-storage.binimum.org/XXABC2400001.ttml',
    'https://lyrics-api.binimum.org/',
    'https://lyrics-storage.binimum.org/XXABC2400001.ttml',
  ]);
  assert.equal(retry.calls[1].url, 'https://lyrics-api.binimum.org/?isrc=XXABC2400001');
});

test('BiniLyrics lyricsFor: no document URL, a non-http URL or an empty TTML is a miss', async () => {
  const fetch = fakeFetch([[() => true, text('<tt><body></body></tt>')]]);
  assert.equal(await bini.lyricsFor({ isrc: 'X' }, { fetch }), null);
  assert.equal(await bini.lyricsFor({ lyricsUrl: 'file:///etc/passwd' }, { fetch }), null);
  assert.equal(fetch.calls.length, 0);
  assert.equal(await bini.lyricsFor({ lyricsUrl: 'https://lyrics-storage.binimum.org/x.ttml' }, { fetch }), null);
});

// ---- BetterLyrics ------------------------------------------------------------------

test('BetterLyrics: one GET keyed on s/a/d/al, answered with TTML in a {"ttml": …} envelope', async () => {
  const fetch = fakeFetch([[startsWith(betterLyrics.BASE), json({ ttml: TTML })]]);
  const [provider] = betterLyrics.providers;
  assertTtmlLines(await provider.lyrics(QUERY, { fetch }));
  assert.equal(
    fetch.calls[0].url,
    'https://lyrics-api.boidu.dev/getLyrics?s=Placeholder%20Song&a=Test%20Artist&d=209&al=Test%20Album',
  );
});

test('BetterLyrics: unknown length and album are left off the request', async () => {
  const fetch = fakeFetch([[startsWith(betterLyrics.BASE), json({ ttml: TTML })]]);
  await betterLyrics.providers[0].lyrics({ title: 'Placeholder Song', artist: 'Test Artist', durationMs: 0, album: ' ' }, { fetch });
  assert.equal(fetch.calls[0].url, 'https://lyrics-api.boidu.dev/getLyrics?s=Placeholder%20Song&a=Test%20Artist');
});

test('BetterLyrics: a 404, an error envelope or an HTML error page is a miss', async () => {
  for (const respond of [json({ error: 'Lyrics not found' }, 404), json({ error: 'Lyrics not found' }), text('<!DOCTYPE html><html><body>502</body></html>')]) {
    const fetch = fakeFetch([[startsWith(betterLyrics.BASE), respond]]);
    assert.equal(await betterLyrics.providers[0].lyrics(QUERY, { fetch }), null);
  }
});

test('BetterLyrics Portato: QQ Music QRC karaoke keeps per-character timing', async () => {
  const qrc = '<?xml version="1.0" encoding="utf-8"?><QrcInfos><QrcHeadInfo SaveTime="0" Version="100"/>'
    + '<LyricInfo LyricCount="1"><Lyric_1 LyricType="1" LyricContent="[ti:Placeholder Song]\n'
    + '[1000,2000]你(1000,500)好(1500,500)世(2000,500)界(2500,500)\n'
    + '[9000,1000]再(9000,400)见(9400,600)"/></LyricInfo></QrcInfos>';
  const fetch = fakeFetch([[startsWith(betterLyrics.PORTATO), json({ lyrics: qrc })]]);
  const provider = betterLyrics.providers[1];
  assert.deepEqual([provider.id, provider.label, provider.wordSynced], ['better_lyrics_portato', 'BetterLyrics Portato', true]);
  const lines = await provider.lyrics(QUERY, { fetch });
  assert.ok(fetch.calls[0].url.startsWith('https://lyrics-api.boidu.dev/qq/getLyrics?s=Placeholder%20Song&a=Test%20Artist&d=209'));
  const [first, second] = sung(lines);
  assert.equal(first.text, '你好世界');
  assert.deepEqual(first.words.map((w) => [w.text, w.startMs, w.endMs]), [['你', 1_000, 1_500], ['好', 1_500, 2_000], ['世', 2_000, 2_500], ['界', 2_500, 3_000]]);
  assert.equal(first.sungUntilMs, 3_000);
  assert.equal(second.text, '再见');
  // The row's stated end (3.0 s) is known, so the 6 s pause before 9.0 s is marked.
  assert.deepEqual(lines.filter((l) => l.text === '').map((l) => l.timeMs), [3_000]);
});

test('BetterLyrics Portato: NetEase YRC (stamp before the word) is read too', async () => {
  const fetch = fakeFetch([[startsWith(betterLyrics.PORTATO), json({ lrc: '[1000,900](1000,400,0)sing (1400,500,0)along' })]]);
  const [line] = sung(await betterLyrics.providers[1].lyrics(QUERY, { fetch }));
  assert.equal(line.text, 'sing along');
  assert.deepEqual(line.words.map((w) => [w.text, w.startMs, w.endMs]), [['sing', 1_000, 1_400], ['along', 1_400, 1_900]]);
});

// ---- PaxSenix ------------------------------------------------------------------

const APPLE_PAGE = '<!DOCTYPE html><html><head><meta charset="utf-8">'
  + '<script type="module" crossorigin src="/assets/index~6ee77bfa6c.js"></script></head><body></body></html>';
// Fake token: base64url of {"alg":"ES256","typ":"JWT","kid":"FIXTURE"} / {"iss":"FIXTURE","iat":1}.
const FAKE_TOKEN = 'eyJhbGciOiJFUzI1NiIsInR5cCI6IkpXVCIsImtpZCI6IkZJWFRVUkUifQ.eyJpc3MiOiJGSVhUVVJFIiwiaWF0IjoxfQ.ZmFrZS1zaWduYXR1cmU';
const APPLE_SCRIPT = `var a=1;const cfg={token:"${FAKE_TOKEN}",storefront:"us"};export{cfg};`;

const appleSong = (id, name, artistName, durationInMillis) => ({
  id,
  type: 'songs',
  href: `/v1/catalog/us/songs/${id}`,
  attributes: {
    albumName: 'Test Album',
    artistName,
    durationInMillis,
    isrc: 'XXABC2400001',
    name,
    hasLyrics: true,
    playParams: { id, kind: 'song' },
    artwork: { width: 3000, height: 3000, url: 'https://example.invalid/{w}x{h}bb.jpg' },
  },
});

const APPLE_SEARCH_BODY = {
  results: {
    songs: {
      href: '/v1/catalog/us/search?limit=10&term=Placeholder+Song+Test+Artist&types=songs',
      data: [
        appleSong('1111111111', 'Placeholder Song (Live)', 'Test Artist', 250_000),
        appleSong('1234567890', 'Placeholder Song', 'Test Artist', 209_000),
      ],
    },
  },
  meta: { results: { order: ['songs'], rawOrder: ['songs'] } },
};

/** PaxSenix's structured payload: rows and words with integer-ms timestamps. */
const PAX_STRUCTURED = {
  type: 'Syllable',
  content: [
    { timestamp: 1_000, endtime: 2_000, oppositeTurn: false, text: [{ text: 'sing', timestamp: 1_000, endtime: 1_300 }, { text: 'along', timestamp: 1_400, endtime: 1_900 }] },
    { timestamp: 2_200, endtime: 3_000, oppositeTurn: false, text: [{ text: 'again', timestamp: 2_200, endtime: 2_900 }] },
  ],
};

function appleRoutes(searchBody = APPLE_SEARCH_BODY, lyricsBody = PAX_STRUCTURED) {
  return [
    [startsWith('https://music.apple.com/us/new'), text(APPLE_PAGE)],
    [startsWith('https://music.apple.com/assets/index~'), text(APPLE_SCRIPT)],
    [startsWith(pax.APPLE_SEARCH), json(searchBody)],
    [startsWith(`${pax.PUBLIC_PROXY}/apple-music/lyrics`), json(lyricsBody)],
  ];
}

test('PaxSenix (keyless): scrape the Apple token, search the catalogue, fetch lyrics by Apple id', async () => {
  const [provider] = pax.createPaxSenixProviders();
  assert.deepEqual([provider.id, provider.label, provider.wordSynced], ['paxsenix', 'PaxSenix', true]);
  const fetch = fakeFetch(appleRoutes());
  const lines = await provider.lyrics(QUERY, { fetch });

  assert.deepEqual(fetch.calls.map((c) => c.url), [
    'https://music.apple.com/us/new',
    'https://music.apple.com/assets/index~6ee77bfa6c.js',
    'https://amp-api.music.apple.com/v1/catalog/us/search?term=Placeholder%20Song%20Test%20Artist&types=songs&limit=10&l=en-US',
    'https://lyrics.paxsenix.org/apple-music/lyrics?id=1234567890&ttml=true', // the exact title beat "(Live)"
  ]);
  const search = fetch.calls[2];
  assert.equal(headerOf(search, 'Authorization'), `Bearer ${FAKE_TOKEN}`);
  assert.equal(headerOf(search, 'Origin'), 'https://music.apple.com');
  assert.equal(headerOf(search, 'Referer'), 'https://music.apple.com/');

  // Only starts are read: a word ends where the next begins, whatever `endtime` says.
  const [first, second] = sung(lines);
  assert.deepEqual(first.words.map((w) => [w.text, w.startMs, w.endMs]), [['sing', 1_000, 1_400], ['along', 1_400, 2_200]]);
  assert.equal(first.sungUntilMs, 2_200);
  assert.deepEqual(second.words, [{ startMs: 2_200, endMs: 3_000, text: 'again' }]); // last word: +800 ms
});

test('PaxSenix (keyless): the Apple token is scraped once and then reused', async () => {
  const [provider] = pax.createPaxSenixProviders();
  const fetch = fakeFetch(appleRoutes());
  await Promise.all([provider.lyrics(QUERY, { fetch }), provider.lyrics(QUERY, { fetch })]);
  await provider.lyrics(QUERY, { fetch });
  const scrapes = fetch.calls.filter((c) => c.url.startsWith('https://music.apple.com/'));
  assert.equal(scrapes.length, 2); // page + script, once, even for concurrent lookups
  assert.equal(fetch.calls.filter((c) => c.url.startsWith(pax.APPLE_SEARCH)).length, 3);
});

test('PaxSenix (keyless): no candidate scoring 10 means no lyrics request', async () => {
  const [provider] = pax.createPaxSenixProviders();
  const unrelated = { results: { songs: { data: [appleSong('999', 'Different Tune', 'Someone Else', 120_000)] } } };
  const fetch = fakeFetch(appleRoutes(unrelated));
  assert.equal(await provider.lyrics(QUERY, { fetch }), null);
  assert.ok(!fetch.calls.some((c) => c.url.startsWith(pax.PUBLIC_PROXY)));
});

test('PaxSenix (keyless): a TTML answer from the proxy is parsed as TTML', async () => {
  const [provider] = pax.createPaxSenixProviders();
  const fetch = fakeFetch(appleRoutes(APPLE_SEARCH_BODY, { ttmlContent: TTML }));
  assertTtmlLines(await provider.lyrics(QUERY, { fetch }));
});

test('PaxSenix (keyless): a failed token scrape is a miss and is retried on the next lookup', async () => {
  const [provider] = pax.createPaxSenixProviders();
  const fetch = fakeFetch([[startsWith('https://music.apple.com/us/new'), text('<html></html>')]]);
  assert.equal(await provider.lyrics(QUERY, { fetch }), null);
  assert.equal(await provider.lyrics(QUERY, { fetch }), null);
  assert.equal(fetch.calls.length, 2);
});

const SPOTIFY_SEARCH = {
  tracks: {
    items: [{
      id: '4uLU6hMCjMI75M1A2tKUQC',
      name: 'Placeholder Song',
      artists: [{ id: 'a1', name: 'Test Artist' }],
      album: { id: 'b2', name: 'Test Album', artists: [{ id: 'a1', name: 'Test Artist' }] },
      duration_ms: 209_500,
    }],
  },
};

const LRCGET = {
  lyrics: [
    { id: 'wrong', trackName: 'Out of Touch', artistName: 'Other', duration: 209, syncedLyrics: '[00:01.00]wrong line\n[00:02.00]wrong again' },
    { id: 'right', trackName: 'Placeholder Song', artistName: 'Test Artist', duration: 209, syncedLyrics: '[00:01.00]first line\n[00:02.00]second line' },
    { id: 'remix', trackName: 'Placeholder Song (Remix)', artistName: 'Test Artist', duration: 240, syncedLyrics: '[00:01.00]remix line' },
  ],
};

test('PaxSenix Spotify: without a key nothing is requested', async () => {
  const fetch = fakeFetch([[() => true, json({})]]);
  const spotify = pax.providers.find((p) => p.id === 'paxsenix_spotify');
  assert.deepEqual([spotify.label, spotify.wordSynced], ['PaxSenix: Spotify', false]);
  assert.equal(await spotify.lyrics(QUERY, { fetch }), null);
  assert.equal(await spotify.lyrics(QUERY, { fetch, keys: { paxsenix: '   ' } }), null);
  assert.equal(fetch.calls.length, 0);
});

test('PaxSenix Spotify: search then lyrics by Spotify id, with the key from ctx.keys', async () => {
  const fetch = fakeFetch([
    [startsWith(`${pax.API}/spotify/search`), json(SPOTIFY_SEARCH)],
    [startsWith(`${pax.API}/lyrics/spotify`), json({ lyrics: '[00:01.00]first line\n[00:03.50]second line' })],
  ]);
  const spotify = pax.providers.find((p) => p.id === 'paxsenix_spotify');
  const lines = await spotify.lyrics(QUERY, { fetch, keys: { paxsenix: 'Bearer test-key' } });
  assert.deepEqual(fetch.calls.map((c) => c.url), [
    'https://api.paxsenix.org/spotify/search?q=Placeholder%20Song%20Test%20Artist',
    'https://api.paxsenix.org/lyrics/spotify?id=4uLU6hMCjMI75M1A2tKUQC',
  ]);
  for (const call of fetch.calls) {
    assert.equal(headerOf(call, 'Authorization'), 'Bearer test-key'); // "Bearer " prefix normalised away
    assert.equal(headerOf(call, 'Accept'), 'application/json, text/plain, */*');
  }
  assert.deepEqual(sung(lines).map((l) => [l.timeMs, l.text]), [[1_000, 'first line'], [3_500, 'second line']]);
});

test('PaxSenix Spotify: a lyrics miss falls back to lrcget, which picks one candidate', async () => {
  const fetch = fakeFetch([
    [startsWith(`${pax.API}/spotify/search`), json(SPOTIFY_SEARCH)],
    [startsWith(`${pax.API}/lyrics/spotify`), json({ error: true, message: 'not found' }, 404)],
    [startsWith(`${pax.API}/lyrics/lrcget`), json(LRCGET)],
  ]);
  const [, spotify] = pax.createPaxSenixProviders({ apiKey: 'factory-key' });
  const lines = await spotify.lyrics(QUERY, { fetch });
  assert.equal(fetch.calls[2].url, 'https://api.paxsenix.org/lyrics/lrcget?q=Placeholder%20Song%20Test%20Artist');
  assert.equal(headerOf(fetch.calls[2], 'Authorization'), 'Bearer factory-key');
  assert.deepEqual(sung(lines).map((l) => [l.timeMs, l.text]), [[1_000, 'first line'], [2_000, 'second line']]);
});

test('PaxSenix Musixmatch: server-side match on t/a/d (d always sent), structured word timing', async () => {
  const fetch = fakeFetch([[startsWith(`${pax.API}/lyrics/musixmatch`), json(PAX_STRUCTURED)]]);
  const [, , musixmatch] = pax.createPaxSenixProviders({ apiKey: 'factory-key' });
  assert.deepEqual([musixmatch.id, musixmatch.label, musixmatch.wordSynced], ['paxsenix_musixmatch', 'PaxSenix: Musixmatch', true]);
  const lines = await musixmatch.lyrics(QUERY, { fetch });
  await musixmatch.lyrics({ ...QUERY, durationMs: 0 }, { fetch, keys: { paxsenix: 'ctx-key' } });
  assert.deepEqual(fetch.calls.map((c) => c.url), [
    'https://api.paxsenix.org/lyrics/musixmatch?t=Placeholder%20Song&a=Test%20Artist&d=209',
    'https://api.paxsenix.org/lyrics/musixmatch?t=Placeholder%20Song&a=Test%20Artist&d=0',
  ]);
  assert.equal(headerOf(fetch.calls[1], 'Authorization'), 'Bearer ctx-key'); // ctx.keys wins over the factory key
  assert.equal(sung(lines)[0].text, 'sing along');
  assert.equal(sung(lines)[0].words.length, 2);
});

test('PaxSenix Musixmatch: a miss falls back to lrcget; everything missing is null', async () => {
  const [, , musixmatch] = pax.createPaxSenixProviders({ apiKey: 'k' });
  const fallback = fakeFetch([[startsWith(`${pax.API}/lyrics/lrcget`), json(LRCGET)]]);
  assert.equal(sung(await musixmatch.lyrics(QUERY, { fetch: fallback }))[0].text, 'first line');
  assert.deepEqual(fallback.calls.map((c) => c.url.split('?')[0]), [
    'https://api.paxsenix.org/lyrics/musixmatch',
    'https://api.paxsenix.org/lyrics/lrcget',
  ]);
  assert.equal(await musixmatch.lyrics(QUERY, { fetch: fakeFetch([]) }), null);
});

test('PaxSenix scoring: title 20/10, artist 15/5, duration 10/5, threshold 10', () => {
  const candidate = (title, artist, durationMs) => ({ id: 'x', title, artist, durationMs });
  assert.equal(pax.scoreCandidate(candidate('Placeholder Song', 'Test Artist', 209_000), 'placeholder song', 'TEST ARTIST', 209_900), 45);
  assert.equal(pax.scoreCandidate(candidate('Placeholder Song (Live)', 'Test Artist', 215_000), 'Placeholder Song', 'Test Artist', 209_900), 10 + 15 + 5);
  assert.equal(pax.scoreCandidate(candidate('Other', 'Test Artist & Friend', 0), 'Placeholder Song', 'Test Artist', 209_900), 5);
  assert.equal(pax.MINIMUM_MATCH_SCORE, 10);
  // Durations under 10 000 are read as seconds.
  const found = pax.bestCandidate({ items: [{ id: 's', title: 'Placeholder Song', artist_name: 'Nobody', duration: 209 }] }, 'Placeholder Song', 'Test Artist', 209_900);
  assert.deepEqual(found, { id: 's', title: 'Placeholder Song', artist: 'Nobody', durationMs: 209_000 });
});

test('PaxSenix key normalisation accepts bare and "Bearer "-prefixed keys', () => {
  assert.equal(pax.normalizeApiKey(' secret '), 'secret');
  assert.equal(pax.normalizeApiKey('Bearer secret'), 'secret');
  assert.equal(pax.normalizeApiKey('bearer   secret '), 'secret');
  assert.equal(pax.normalizeApiKey(undefined), '');
});

test('PaxSenix lrcget: string candidates are separate LRC documents, ranked by closeness to the track length', () => {
  const raw = JSON.stringify({ lyrics: ['[00:01.00]wrong first\n[00:40.00]wrong last', '[00:01.00]right first\n[03:19.00]right last'] });
  const lines = pax.parseLrcGet(raw, 'Song', 'Artist', 200_000);
  assert.deepEqual(sung(lines).map((l) => [l.timeMs, l.text]), [[1_000, 'right first'], [199_000, 'right last']]);
});

test('PaxSenix lrcget: an LRCLIB-shaped candidate with both plain and synced text yields the synced lines', () => {
  // BitChord's ProviderLyrics tries plainLyrics first and would return these
  // lines unsynced; the reference prefers syncedLyrics (documented deviation).
  const raw = JSON.stringify({ lyrics: [{
    id: 1, trackName: 'Placeholder Song', artistName: 'Test Artist', albumName: 'Test Album', duration: 209.0,
    instrumental: false, plainLyrics: 'first line\nsecond line', syncedLyrics: '[00:01.00]first line\n[00:02.00]second line',
  }] });
  const lines = pax.parseLrcGet(raw, 'Placeholder Song', 'Test Artist', 209_900);
  assert.deepEqual(sung(lines).map((l) => [l.timeMs, l.text]), [[1_000, 'first line'], [2_000, 'second line']]);
});

// ---- LyricsPlus ------------------------------------------------------------------

const LYRICS_PLUS_BODY = {
  type: 'Word',
  metadata: {
    source: 'Apple',
    title: 'Placeholder Song',
    language: 'en',
    agents: {
      v1: { type: 'person', alias: 'v1' },
      v2: { type: 'person', alias: 'v2' },
      v1000: { type: 'group', alias: 'v1000' },
    },
  },
  lyrics: [
    {
      time: 1_000, duration: 1_500, text: 'sing along',
      syllabus: [{ time: 1_000, duration: 400, text: 'sing ' }, { time: 1_400, duration: 300, text: 'a' }, { time: 1_700, duration: 800, text: 'long' }],
      element: { key: 'L1', songPart: 'Verse', singer: 'v1' },
    },
    {
      time: 3_000, duration: 1_000, text: 'answer back',
      syllabus: [{ time: 3_000, duration: 500, text: 'answer ' }, { time: 3_500, duration: 500, text: 'back' }],
      element: { key: 'L2', songPart: 'Verse', singer: 'v2' },
    },
    { time: 4_200, duration: 800, text: 'all of us', syllabus: [], element: { key: 'L3', singer: 'v1000' } },
  ],
};

function assertLyricsPlusLines(lines) {
  assert.deepEqual(lines.map((l) => [l.timeMs, l.text, l.alignment]), [
    [1_000, 'sing along', 'start'],
    [3_000, 'answer back', 'end'],
    [4_200, 'all of us', 'start'], // group: left, and not a turn
  ]);
  assert.deepEqual(lines[0].words, [{ startMs: 1_000, endMs: 1_400, text: 'sing' }, { startMs: 1_400, endMs: 2_500, text: 'along' }]);
  assert.equal(lines[2].sungUntilMs, 5_000); // line-synced: its duration is its end
}

test('LyricsPlus: v2 request carries the ISRC alongside the name; syllables, voices and line timing are read', async () => {
  const provider = lyricsPlus.createLyricsPlusProvider({ mirrors: ['https://mirror.test'] });
  const fetch = fakeFetch([[startsWith('https://mirror.test/'), json(LYRICS_PLUS_BODY)]]);
  assertLyricsPlusLines(await provider.lyrics({ ...QUERY, isrc: 'XXABC2400001' }, { fetch }));
  assert.equal(
    fetch.calls[0].url,
    'https://mirror.test/v2/lyrics/get?title=Placeholder%20Song&artist=Test%20Artist&duration=209&album=Test%20Album&isrc=XXABC2400001',
  );
});

test('LyricsPlus: the older element shape marks the answering side with a tag', () => {
  const lines = lyricsPlus.parseLyricsPlus({
    lyrics: [
      { time: 1_000, duration: 500, text: 'mine' },
      { time: 2_000, duration: 500, text: 'yours', element: ['opposite'] },
    ],
  });
  assert.deepEqual(lines.map((l) => l.alignment), ['start', 'end']);
});

test('LyricsPlus: mirror failover — first usable answer wins, losers are aborted, the winner goes first next time', async () => {
  const [m0, m1, m2, m3, m4, m5] = lyricsPlus.MIRRORS;
  assert.deepEqual(lyricsPlus.MIRRORS, [
    'https://lyricsplus.prjktla.my.id',
    'https://lyricsplus.atomix.one',
    'https://lyricsplus.binimum.org',
    'https://lyricsplus.prjktla.workers.dev',
    'https://lyricsplus-seven.vercel.app',
    'https://lyrics-plus-backend.vercel.app',
  ]);
  const hangs = (url) => url.startsWith(m1) || url.startsWith(m5);
  const fetch = fetchWithHangs(hangs, [
    [startsWith(m0), text('Service Unavailable', 503)],
    [startsWith(m2), json({ type: 'Word', lyrics: [] })], // answers, but has nothing: not a winner
    [startsWith(m3), json(LYRICS_PLUS_BODY)],
    [startsWith(m4), text('An error occurred with your deployment', 402)],
  ]);
  const provider = lyricsPlus.createLyricsPlusProvider();
  assert.deepEqual([provider.id, provider.label, provider.wordSynced], ['lyrics_plus', 'LyricsPlus', true]);

  assertLyricsPlusLines(await provider.lyrics(QUERY, { fetch }));
  assert.deepEqual(fetch.calls.map((c) => c.url.split('/v2/')[0]), [m0, m1, m2, m3, m4, m5]); // all at once, in order
  const hanging = fetch.calls.filter((c) => hangs(c.url));
  assert.ok(hanging.every((c) => c.init.signal.aborted), 'losing requests are aborted');
  assert.equal(provider.lastGood, m3);

  fetch.calls.length = 0;
  assertLyricsPlusLines(await provider.lyrics(QUERY, { fetch }));
  assert.deepEqual(fetch.calls.map((c) => c.url.split('/v2/')[0]), [m3, m0, m1, m2, m4, m5]);
});

test('LyricsPlus: when every mirror misses the provider misses', async () => {
  const provider = lyricsPlus.createLyricsPlusProvider({ mirrors: ['https://a.test', 'https://b.test', 'https://c.test'] });
  const fetch = fakeFetch([
    [startsWith('https://a.test/'), text('rate limited', 429)],
    [startsWith('https://b.test/'), text('{"lyrics": "not an array"')],
  ]);
  assert.equal(await provider.lyrics(QUERY, { fetch }), null);
  assert.equal(provider.lastGood, null);
});

test('LyricsPlus: a caller abort rejects instead of reading as a miss', async () => {
  const provider = lyricsPlus.createLyricsPlusProvider({ mirrors: ['https://a.test', 'https://b.test'] });
  const controller = new AbortController();
  const pending = provider.lyrics(QUERY, { fetch: fetchWithHangs(() => true, []), signal: controller.signal });
  controller.abort(new Error('track changed'));
  await assert.rejects(pending, /track changed/);
});

// ---- Unison ------------------------------------------------------------------

const unisonEntry = (fields) => ({
  success: true,
  data: {
    id: 4883,
    videoId: 'abcDEF12345',
    song: 'Placeholder Song',
    artist: 'Test Artist',
    album: 'Test Album',
    language: 'en',
    score: 0,
    effectiveScore: 0,
    voteCount: 0,
    confidence: 'low',
    hidden: false,
    submitter: { keyId: 'dea04ab0', reputation: 2, displayName: 'Someone', tier: null, level: 1, badgeCount: 2, topBadge: { key: 'early-adopter', name: 'Early Adopter' } },
    userVote: null,
    ...fields,
  },
});

test('Unison: one GET on song/artist/album/duration; a TTML entry is word-synced', async () => {
  const fetch = fakeFetch([[startsWith(unison.BASE), json(unisonEntry({ lyrics: TTML, format: 'ttml', syncType: 'wordsync' }))]]);
  const [provider] = unison.providers;
  assert.deepEqual([provider.id, provider.label, provider.wordSynced], ['unison', 'Unison', true]);
  assertTtmlLines(await provider.lyrics(QUERY, { fetch }));
  assert.equal(
    fetch.calls[0].url,
    'https://unison.boidu.dev/lyrics?song=Placeholder%20Song&artist=Test%20Artist&album=Test%20Album&duration=209',
  );
});

test('Unison: LRC entries are read as enhanced LRC first, then as line-synced LRC', async () => {
  const lrc = unisonEntry({ lyrics: '[00:15.46]first placeholder line\n[00:17.30]second placeholder line', format: 'lrc', syncType: 'linesync' });
  const lines = await unison.providers[0].lyrics(QUERY, { fetch: fakeFetch([[() => true, json(lrc)]]) });
  assert.deepEqual(sung(lines).map((l) => [l.timeMs, l.text, l.words.length]), [[15_460, 'first placeholder line', 0], [17_300, 'second placeholder line', 0]]);
  assert.equal(lines[0].text, ''); // the 15 s intro gets its own gap

  const a2 = unisonEntry({ lyrics: '[00:01.00]<00:01.00>sing <00:01.50>along\n[00:03.00]<00:03.00>again', format: 'lrc', syncType: 'wordsync' });
  const words = sung(await unison.providers[0].lyrics(QUERY, { fetch: fakeFetch([[() => true, json(a2)]]) }))[0].words;
  assert.deepEqual(words.map((w) => [w.text, w.startMs, w.endMs]), [['sing', 1_000, 1_500], ['along', 1_500, 3_000]]);
});

test('Unison: a plain entry is untimed lines with blank rows dropped', () => {
  const lines = unison.linesOf({ format: 'lrc', syncType: 'plain', lyrics: '  first line \n\n second line \n' });
  assert.deepEqual(lines.map((l) => [l.timeMs, l.text]), [[0, 'first line'], [0, 'second line']]);
});

test('Unison: success:false, a missing entry, blank lyrics or a 404 is a miss', async () => {
  for (const respond of [json({ success: false, error: 'No lyrics found' }), json({ success: true }), json(unisonEntry({ lyrics: '  ', format: 'lrc' })), json({}, 404)]) {
    assert.equal(await unison.providers[0].lyrics(QUERY, { fetch: fakeFetch([[() => true, respond]]) }), null);
  }
});

// ---- SimpMusic ------------------------------------------------------------------

const simpEntry = (duration, fields = {}) => ({
  id: `entry-${duration}`,
  videoId: 'abcDEF12345',
  songTitle: 'Placeholder Song',
  artistName: 'Test Artist',
  albumName: 'Test Album',
  duration,
  plainLyrics: 'plain text only',
  syncedLyrics: '[00:01.00]synced line\n[00:04.00]another synced line',
  richSyncLyrics: '[00:01.00]<00:01.00>don&#x27;t <00:01.50>stop\n[00:04.00]<00:04.00>now',
  vote: 0,
  ...fields,
});

test('SimpMusic: keyed on the video id; the cut closest in length (within 10 s) wins; rich sync is unescaped', async () => {
  const fetch = fakeFetch([[startsWith(simpMusic.BASE), json({
    success: true,
    data: [simpEntry(180, { richSyncLyrics: '[00:01.00]<00:01.00>wrong <00:01.50>cut' }), simpEntry(211), simpEntry(205, { richSyncLyrics: '[00:01.00]<00:01.00>farther <00:01.50>cut' })],
  })]]);
  const [provider] = simpMusic.providers;
  assert.deepEqual([provider.id, provider.label, provider.wordSynced], ['simp_music', 'SimpMusic', true]);
  const lines = await provider.lyrics(QUERY, { fetch });
  assert.equal(fetch.calls[0].url, 'https://api-lyrics.simpmusic.org/v1/abcDEF12345');
  const [first] = sung(lines);
  assert.equal(first.text, "don't stop");
  assert.deepEqual(first.words.map((w) => [w.text, w.startMs, w.endMs]), [["don't", 1_000, 1_500], ['stop', 1_500, 4_000]]);
});

test('SimpMusic: falls back to line sync; plain lyrics alone are a miss', async () => {
  const synced = fakeFetch([[() => true, json({ success: true, data: [simpEntry(209, { richSyncLyrics: '' })] })]]);
  const lines = await simpMusic.providers[0].lyrics(QUERY, { fetch: synced });
  assert.deepEqual(sung(lines).map((l) => [l.timeMs, l.text, l.words.length]), [[1_000, 'synced line', 0], [4_000, 'another synced line', 0]]);

  const plainOnly = fakeFetch([[() => true, json({ success: true, data: [simpEntry(209, { richSyncLyrics: null, syncedLyrics: null })] })]]);
  assert.equal(await simpMusic.providers[0].lyrics(QUERY, { fetch: plainOnly }), null);
});

test('SimpMusic: no video id means no request; no cut within 10 s, success:false or a geoblock 403 is a miss', async () => {
  const none = fakeFetch([]);
  assert.equal(await simpMusic.providers[0].lyrics({ ...QUERY, videoId: '' }, { fetch: none }), null);
  assert.equal(await simpMusic.providers[0].lyrics({ ...QUERY, videoId: undefined }, { fetch: none }), null);
  assert.equal(none.calls.length, 0);

  for (const respond of [
    json({ success: true, data: [simpEntry(180), simpEntry(240)] }),
    json({ success: false, data: [simpEntry(209)] }),
    text('Access denied from your region', 403),
  ]) {
    assert.equal(await simpMusic.providers[0].lyrics(QUERY, { fetch: fakeFetch([[() => true, respond]]) }), null);
  }
});

test('SimpMusic: with the track length unknown the shortest cut is taken', () => {
  const picked = simpMusic.pickEntry([simpEntry(240), simpEntry(180), simpEntry(200)], 0);
  assert.equal(picked.duration, 180);
  assert.equal(simpMusic.DURATION_TOLERANCE_SECONDS, 10);
});
