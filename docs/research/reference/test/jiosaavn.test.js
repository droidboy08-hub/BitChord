// Tests for sources/jiosaavn.js (mirrors data/jiosaavn/JioSaavnService.kt and
// data/sources/JioSaavnSource.kt). Offline: every request goes to fakeFetch.
// Independent JavaScript re-implementation of the mechanism documented in
// BITCHORD_ENGINE_RESEARCH.md (BitChord itself is GPL-3.0; InnerTubeX is GPL-3.0).
//
// Row fixtures follow the api_version=4 / ctx=android shape the Kotlin
// models decode (RawSongItem / RawMoreInfo / RawArtistMap), padded with the
// neighbouring fields a real response carries so parsing is not tested
// against an unrealistically tidy object.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeFetch } from '../lib/http.js';
import { desEncrypt } from '../sources/des.js';
import {
  SAAVN_API_URL,
  SAAVN_HEADERS,
  SAAVN_DES_KEY,
  base64Decode,
  decryptMediaUrl,
  selectBestSaavnStream,
  isExplicit,
  prioritizeExplicit,
  upscaleThumbnail,
  formatDuration,
  toTrack,
  searchSongs,
  search,
  getStreamUrl,
  stream,
  streamFromSearchRow,
  searchAndStream,
  createJioSaavnSource,
} from '../sources/jiosaavn.js';

// ---- fixtures ----------------------------------------------------------------

/** Produced independently with: printf '%s' URL | openssl enc -des-ecb -K 3338333436353931 -nosalt -provider legacy | base64 */
const OPENSSL = [
  [
    'https://aac.saavncdn.com/815/2b2bb1d9d8d0ec5b8f4d6c21c1fda85b_96.mp4',
    'ID2ieOjCrwfgWvL5sXl4B1ImC5QfbsDyGgo96tPdy18TWbpZbksO0sY7aMNQNcyNGwdi5xI8ab93bGqNaDm60Rw7tS9a8Gtq',
  ],
  [
    'https://aac.saavncdn.com/372/f3c9d2a1b6e84c1b9d0e7a5c3b2f1e0d_160.mp4?Expires=1790000000&Signature=AbC-123_x',
    'ID2ieOjCrwfgWvL5sXl4B1ImC5QfbsDy9WG5UmQjmAQhKudBEwCmB/h5+Upa/0czId58tKxqESlH8tqyR6k2Yyp13X4DzSqWSbQV1m0nsxt9RQHFKKMTyIgLQ5ggVFiSXCnYaXnhJm9ZixsQJX5pNg==',
  ],
  [
    'https://aac.saavncdn.com/001/deadbeef_48.mp4',
    'ID2ieOjCrwfgWvL5sXl4B1ImC5QfbsDyvonoIa7OKYURtymwEAGwnxw7tS9a8Gtq',
  ],
];

const enc = (url) => Buffer.from(desEncrypt(SAAVN_DES_KEY, url)).toString('base64');
const cdn = (id, kbps, query = '') => `https://aac.saavncdn.com/${id.length}/${id}_${kbps}.mp4${query}`;

function row({
  id,
  title = 'Kesariya',
  explicit = '0',
  has320 = 'true',
  url = cdn(id, 96),
  album = 'Brahmastra',
  duration = '268',
  artists = ['Pritam', 'Arijit Singh'],
  image = 'http://c.saavncdn.com/191/Kesariya-From-Brahmastra-Hindi-2022-20220717092820-150x150.jpg',
}) {
  return {
    id,
    title,
    subtitle: `${artists.join(', ')} - ${album}`,
    header_desc: '',
    type: 'song',
    perma_url: `https://www.jiosaavn.com/song/kesariya/${id}`,
    image,
    language: 'hindi',
    year: '2022',
    play_count: '152000000',
    explicit_content: explicit,
    list_count: '0',
    list_type: '',
    list: '',
    more_info: {
      music: 'Pritam',
      album_id: '37208838',
      album,
      label: 'Sony Music Entertainment India Pvt. Ltd.',
      origin: 'search',
      is_dolby_content: false,
      '320kbps': has320,
      ...(url === null ? {} : { encrypted_media_url: enc(url) }),
      encrypted_cache_url: '',
      album_url: 'https://www.jiosaavn.com/album/brahmastra/abc',
      duration,
      rights: { code: '0', cacheable: 'true', delete_cached_object: 'false', reason: '' },
      cache_state: 'false',
      has_lyrics: 'false',
      lyrics_snippet: '',
      starred: 'false',
      copyright_text: '(P) 2022 Sony Music',
      artistMap: {
        primary_artists: artists.map((name, i) => ({
          id: String(455000 + i),
          name,
          role: 'primary_artists',
          image: '',
          type: 'artist',
          perma_url: '',
        })),
        featured_artists: [],
        artists: [],
      },
      release_date: '2022-07-17',
      vcode: '010910441234',
      vlink: 'https://jiotunepreview.jio.com/content/Converted/010910441234.mp3',
      triller_available: false,
      request_jiotune_flag: false,
      webp: 'true',
    },
  };
}

const isApi = (call) => (url) => url.startsWith(`${SAAVN_API_URL}?`) && new URL(url).searchParams.get('__call') === call;

function server({ results = [], details = {}, searchStatus = 200 } = {}) {
  return fakeFetch([
    [isApi('search.getResults'), () => ({ status: searchStatus, body: { total: results.length, start: 1, results } })],
    [
      isApi('song.getDetails'),
      (url) => {
        const pid = new URL(url).searchParams.get('pids');
        return pid in details ? { body: details[pid] } : { body: {} };
      },
    ],
  ]);
}

// ---- decryption --------------------------------------------------------------

test('decryptMediaUrl reproduces the OpenSSL-encrypted CDN URLs', () => {
  for (const [url, encrypted] of OPENSSL) assert.equal(decryptMediaUrl(encrypted), url);
});

test('decryptMediaUrl trims, like the Kotlin .trim()', () => {
  // printf '  https://aac.saavncdn.com/815/padded_320.mp4 \n' | openssl enc -des-ecb …
  assert.equal(
    decryptMediaUrl('BmOtWmPnWpLtnup4KhmKWNFhi50sf21czZCKs8dvQlq+YcDl8vKc9ye1Ev/rvDP4'),
    'https://aac.saavncdn.com/815/padded_320.mp4',
  );
});

test('Base64 is read leniently (line breaks and spaces skipped, padding optional)', () => {
  const [url, encrypted] = OPENSSL[1];
  const wrapped = encrypted.replace(/(.{20})/g, '$1\n ').replace(/=+$/, '');
  assert.equal(decryptMediaUrl(wrapped), url);
  assert.deepEqual(base64Decode('aGk='), Uint8Array.from([104, 105]));
});

test('without TextDecoder (older React Native) the fallback decodes UTF-8 identically', () => {
  const nonAscii = 'https://aac.saavncdn.com/815/Kesariyā_टेस्ट_🎵_96.mp4';
  const malformed = Buffer.from(desEncrypt(SAAVN_DES_KEY, Uint8Array.from([0x68, 0xff, 0x69, 0xe2, 0x82, 0x41]))).toString('base64');
  const withNative = [decryptMediaUrl(enc(nonAscii)), decryptMediaUrl(malformed)];
  const saved = globalThis.TextDecoder;
  globalThis.TextDecoder = undefined;
  try {
    assert.deepEqual([decryptMediaUrl(enc(nonAscii)), decryptMediaUrl(malformed)], withNative);
  } finally {
    globalThis.TextDecoder = saved;
  }
  assert.equal(withNative[0], nonAscii);
  assert.equal(withNative[1], 'h�i�A');
});

test('decryptMediaUrl returns "" for blank or undecryptable input (never throws)', () => {
  assert.equal(decryptMediaUrl(''), '');
  assert.equal(decryptMediaUrl('   '), '');
  assert.equal(decryptMediaUrl(undefined), '');
  assert.equal(decryptMediaUrl('not base64!!'), ''); // 6 bytes: not a DES block multiple
  const zeroBlock = Buffer.from(desEncrypt(SAAVN_DES_KEY, new Uint8Array(8), { padding: false })).toString('base64');
  assert.equal(decryptMediaUrl(zeroBlock), ''); // decrypts to 0x00 padding: BadPadding
});

// ---- rendition selection (mirrors BitChord's SourcesTest) ---------------------

test('a parameterized 96 kbps URL is upgraded without losing its query', () => {
  const url = 'https://aac.saavncdn.com/871/song_96.mp4?Expires=123&Signature=abc';
  assert.deepEqual(selectBestSaavnStream(url, true), {
    url: 'https://aac.saavncdn.com/871/song_320.mp4?Expires=123&Signature=abc',
    kbps: 320,
  });
});

test('an unrecognised URL is never called 320 kbps', () => {
  const url = 'https://aac.saavncdn.com/871/song.mp4?token=abc';
  assert.deepEqual(selectBestSaavnStream(url, true), { url, kbps: null });
});

test('without the 320 flag the stated rendition is kept and reported', () => {
  assert.deepEqual(selectBestSaavnStream(cdn('abc', 160), false), { url: cdn('abc', 160), kbps: 160 });
  assert.deepEqual(selectBestSaavnStream(cdn('abc', 96), 'false'), { url: cdn('abc', 96), kbps: 96 });
});

test('the marker must end the path; case and extension are preserved on rewrite', () => {
  assert.deepEqual(selectBestSaavnStream('https://x/a_96.MP4#t=1', 'TRUE'), { url: 'https://x/a_320.MP4#t=1', kbps: 320 });
  assert.deepEqual(selectBestSaavnStream('https://x/a_160.aac', true), { url: 'https://x/a_320.aac', kbps: 320 });
  assert.deepEqual(selectBestSaavnStream('https://x/a_96.mp4x', true), { url: 'https://x/a_96.mp4x', kbps: null });
  assert.deepEqual(selectBestSaavnStream('https://x/a_64.mp4', true), { url: 'https://x/a_64.mp4', kbps: null });
  assert.equal(selectBestSaavnStream('   ', true), null);
});

// ---- row mapping ---------------------------------------------------------------

test('explicit flags: "1" and textual "true" count, everything else does not', () => {
  assert.equal(isExplicit({ explicit_content: '1' }), true);
  assert.equal(isExplicit({ explicit_content: 'true' }), true);
  assert.equal(isExplicit({ explicit_content: 1 }), true); // lenient JSON number
  assert.equal(isExplicit({ explicit_content: 'false' }), false);
  assert.equal(isExplicit({ explicit_content: '' }), false);
  assert.equal(isExplicit({}), false);
});

test('prioritizeExplicit puts the uncensored duplicate first and keeps the rest in order', () => {
  const rows = [
    { id: 'clean', explicit_content: '0' },
    { id: 'explicit', explicit_content: '1' },
    { id: 'clean-2', explicit_content: '0' },
  ];
  assert.deepEqual(prioritizeExplicit(rows).map((r) => r.id), ['explicit', 'clean', 'clean-2']);
});

test('thumbnails are upscaled to 500x500 and forced to https', () => {
  assert.equal(
    upscaleThumbnail('http://c.saavncdn.com/191/Kesariya-150x150.jpg'),
    'https://c.saavncdn.com/191/Kesariya-500x500.jpg',
  );
  assert.equal(upscaleThumbnail('https://c.saavncdn.com/x-50x50.jpg'), 'https://c.saavncdn.com/x-500x500.jpg');
});

test('durations format as M:SS and non-integers give null', () => {
  assert.equal(formatDuration('268'), '4:28');
  assert.equal(formatDuration('59'), '0:59');
  assert.equal(formatDuration('600'), '10:00');
  assert.equal(formatDuration('268.5'), null);
  assert.equal(formatDuration(''), null);
});

test('toTrack builds the fields JioSaavnSource.search does', () => {
  const track = toTrack(row({ id: 'k1', album: '   ', artists: [] }));
  assert.equal(track.artist, 'Unknown Artist');
  assert.equal(track.album, null);
  assert.equal(track.durationSec, 268);
  assert.equal(track.durationText, '4:28');
  assert.equal(track.sourceQuality, 'HIGH');
  assert.equal(track.thumbnailUrl, 'https://c.saavncdn.com/191/Kesariya-From-Brahmastra-Hindi-2022-20220717092820-500x500.jpg');
});

// ---- search ----------------------------------------------------------------------

test('search sends BitChord\'s exact query and geo/explicit headers', async () => {
  const fetch = server({ results: [row({ id: 'a' })] });
  await searchSongs('kesariya arijit', { fetch });
  assert.equal(fetch.calls.length, 1);
  const { url, init } = fetch.calls[0];
  const u = new URL(url);
  assert.equal(`${u.origin}${u.pathname}`, SAAVN_API_URL);
  assert.deepEqual([...u.searchParams], [
    ['__call', 'search.getResults'],
    ['_format', 'json'],
    ['_marker', '0'],
    ['api_version', '4'],
    ['ctx', 'android'],
    ['q', 'kesariya arijit'],
    ['p', '1'],
    ['n', '10'],
  ]);
  assert.deepEqual(init.headers, { ...SAAVN_HEADERS });
  assert.equal(init.headers['X-Forwarded-For'], '49.36.0.1');
  assert.equal(init.headers['X-Real-IP'], '49.36.0.1');
  assert.equal(init.headers.Cookie, 'explicit_content=1');
  assert.equal(init.headers['Accept-Language'], 'en-IN,en;q=0.9');
});

test('search maps rows, puts explicit rows first and applies the limit', async () => {
  const fetch = server({
    results: [
      row({ id: 'clean', title: 'Starboy', explicit: '0', artists: ['The Weeknd', 'Daft Punk'] }),
      row({ id: 'explicit', title: 'Starboy', explicit: '1', artists: ['The Weeknd', 'Daft Punk'] }),
      row({ id: 'other', title: 'Starboy (Remix)' }),
    ],
  });
  const tracks = await search('starboy', { fetch, limit: 2 });
  assert.deepEqual(tracks.map((t) => t.id), ['explicit', 'clean']);
  assert.equal(tracks[0].artist, 'The Weeknd, Daft Punk');
  assert.equal(tracks[0].isExplicit, true);
  assert.equal(tracks[0].album, 'Brahmastra');
});

test('search failures are empty results, not exceptions', async () => {
  assert.deepEqual(await searchSongs('x', { fetch: server({ searchStatus: 500 }) }), []);
  assert.deepEqual(await searchSongs('x', { fetch: fakeFetch([[() => true, () => ({ body: '<html>' })]]) }), []);
  assert.deepEqual(await searchSongs('x', { fetch: async () => { throw new TypeError('fetch failed'); } }), []);
  assert.deepEqual(await searchSongs('x', { fetch: fakeFetch([[() => true, () => ({ body: { results: null } })]]) }), []);
});

test('the connect-phase timeout (4 s by default) turns a hung server into []', async () => {
  const hung = (url, init) =>
    new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true }));
  const started = Date.now();
  const rows = await searchSongs('x', { fetch: hung, timeouts: { connectMs: 30 } });
  assert.deepEqual(rows, []);
  assert.ok(Date.now() - started < 2_000);
});

test('the request timeout (6 s by default) also bounds a body that never finishes', async () => {
  const stalledBody = async () => new Response(new ReadableStream({ start() {} }), { status: 200 });
  const started = Date.now();
  const rows = await searchSongs('x', { fetch: stalledBody, timeouts: { connectMs: 1_000, requestMs: 40 } });
  assert.deepEqual(rows, []);
  assert.ok(Date.now() - started < 2_000);
});

test('an abort of the caller\'s own signal is rethrown, not swallowed', async () => {
  const controller = new AbortController();
  const hung = (url, init) =>
    new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true }));
  const pending = searchSongs('x', { fetch: hung, signal: controller.signal });
  controller.abort(new Error('user left'));
  await assert.rejects(pending, /user left/);
});

// ---- song.getDetails -------------------------------------------------------------

test('getStreamUrl reads the id-keyed shape song.getDetails really returns', async () => {
  const fetch = server({ details: { k1: { k1: row({ id: 'k1', has320: 'true' }) } } });
  const result = await getStreamUrl('k1', { fetch });
  assert.deepEqual(result, { url: cdn('k1', 320), kbps: 320 });
  const u = new URL(fetch.calls[0].url);
  assert.deepEqual([...u.searchParams], [
    ['__call', 'song.getDetails'],
    ['_format', 'json'],
    ['_marker', '0'],
    ['api_version', '4'],
    ['ctx', 'android'],
    ['pids', 'k1'],
  ]);
});

test('getStreamUrl also reads the {"songs":[…]} envelope', async () => {
  const fetch = server({ details: { k2: { songs: [row({ id: 'k2', has320: 'false', url: cdn('k2', 160) })] } } });
  assert.deepEqual(await getStreamUrl('k2', { fetch }), { url: cdn('k2', 160), kbps: 160 });
});

test('getStreamUrl prefers the requested id when other objects share the envelope', async () => {
  const body = { modules: { list: {} }, k3: row({ id: 'k3', has320: 'false', url: cdn('k3', 160) }) };
  const fetch = server({ details: { k3: body } });
  assert.deepEqual(await getStreamUrl('k3', { fetch }), { url: cdn('k3', 160), kbps: 160 });
});

test('getStreamUrl returns null for an empty or failed answer', async () => {
  assert.equal(await getStreamUrl('nothing', { fetch: server() }), null);
  assert.equal(await getStreamUrl('k', { fetch: fakeFetch([[() => true, () => ({ status: 403, body: 'no' })]]) }), null);
});

test('stream refuses 96 kbps and below, keeps 160, upgrades when 320 exists', async () => {
  const fetch = server({
    details: {
      low: { low: row({ id: 'low', has320: 'false', url: cdn('low', 96) }) },
      tiny: { tiny: row({ id: 'tiny', has320: 'false', url: cdn('tiny', 48) }) },
      mid: { mid: row({ id: 'mid', has320: 'false', url: cdn('mid', 160) }) },
      best: { best: row({ id: 'best', has320: 'true', url: cdn('best', 96) }) },
      odd: { odd: row({ id: 'odd', has320: 'true', url: 'https://aac.saavncdn.com/odd/file.mp4' }) },
    },
  });
  assert.equal(await stream('low', { fetch }), null);
  assert.equal(await stream('tiny', { fetch }), null);
  assert.deepEqual(await stream('mid', { fetch }), {
    url: cdn('mid', 160),
    format: { codec: 'mp4', kbps: 160 },
    headers: {},
    via: 'song.getDetails',
  });
  assert.equal((await stream('best', { fetch })).format.kbps, 320);
  assert.equal((await stream('odd', { fetch })).format.kbps, null); // unknown rendition: allowed, unlabelled
});

// ---- the search-row optimisation --------------------------------------------------

test('streamFromSearchRow decrypts the row itself', () => {
  assert.deepEqual(streamFromSearchRow(row({ id: 'r1', has320: 'true' })), {
    url: cdn('r1', 320),
    format: { codec: 'mp4', kbps: 320 },
    headers: {},
    via: 'search-row',
  });
  assert.equal(streamFromSearchRow(row({ id: 'r2', has320: 'false' })), null); // 96 kbps: refused
  assert.equal(streamFromSearchRow(row({ id: 'r3', url: null })), null); // nothing to decrypt
});

test('searchAndStream answers from the search row with ONE request', async () => {
  const fetch = server({ results: [row({ id: 'a', has320: 'true' })] });
  const hit = await searchAndStream('kesariya', { fetch });
  assert.equal(fetch.calls.length, 1);
  assert.equal(hit.track.id, 'a');
  assert.equal(hit.stream.url, cdn('a', 320));
  assert.equal(hit.stream.via, 'search-row');
});

test('searchAndStream with useSearchRow:false is BitChord\'s two-call path', async () => {
  const fetch = server({
    results: [row({ id: 'a', has320: 'true' })],
    details: { a: { a: row({ id: 'a', has320: 'true' }) } },
  });
  const hit = await searchAndStream('kesariya', { fetch, useSearchRow: false });
  assert.deepEqual(fetch.calls.map((c) => new URL(c.url).searchParams.get('__call')), ['search.getResults', 'song.getDetails']);
  assert.equal(hit.stream.via, 'song.getDetails');
  assert.equal(hit.stream.url, cdn('a', 320));
});

test('a refused candidate is skipped and the next row is tried (explicit first)', async () => {
  const fetch = server({
    results: [
      row({ id: 'clean', explicit: '0', has320: 'true' }),
      row({ id: 'explicit-96', explicit: '1', has320: 'false' }),
    ],
  });
  const hit = await searchAndStream('starboy', { fetch });
  assert.equal(hit.track.id, 'clean'); // the explicit row came first but offered only 96 kbps
  assert.equal(fetch.calls.length, 1); // a refused row is not re-asked through song.getDetails
});

test('a row without encrypted_media_url falls back to song.getDetails', async () => {
  const fetch = server({
    results: [row({ id: 'bare', url: null })],
    details: { bare: { bare: row({ id: 'bare', has320: 'false', url: cdn('bare', 160) }) } },
  });
  const hit = await searchAndStream('x', { fetch });
  assert.equal(hit.stream.via, 'song.getDetails');
  assert.equal(hit.stream.format.kbps, 160);
  assert.equal(fetch.calls.length, 2);
});

test('createJioSaavnSource is a MusicSource: kind, rank, search rows, stream', async () => {
  const fetch = server({
    results: [row({ id: 's1', explicit: '1' })],
    details: { s1: { s1: row({ id: 's1', has320: 'true' }) } },
  });
  const source = createJioSaavnSource({ fetch });
  assert.equal(source.kind, 'jiosaavn');
  assert.equal(source.rank, 2);
  assert.equal(source.canServeLossless, false);
  const [first] = await source.search('kesariya', { limit: 15 });
  assert.equal(first.explicit, true);
  assert.equal(first.quality, 'HIGH');
  assert.equal((await source.stream('s1', { kind: 'lossless' })).format.kbps, 320);
});

test('at most maxCandidates rows are tried; pick() can rank them', async () => {
  const rows = ['r1', 'r2', 'r3', 'r4'].map((id) => row({ id, has320: 'false' })); // all 96 kbps
  const fetch = server({ results: [...rows, row({ id: 'good', has320: 'true' })] });
  assert.equal(await searchAndStream('x', { fetch }), null);
  const picked = await searchAndStream('x', { fetch, pick: (list) => list.filter((r) => r.id === 'good') });
  assert.equal(picked.track.id, 'good');
});
