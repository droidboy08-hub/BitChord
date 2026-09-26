// Tests for the line-synced / plain lyric providers:
//   lrclib, musixmatch, kugou, megalobiz, genius, youtube_transcript, youtube_music.
//
// No network: every request goes to a fakeFetch whose canned bodies are shaped
// exactly like what BitChord's Kotlin parsers read (see each provider file).
// Lyric text in fixtures is placeholder text.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { fakeFetch } from '../lib/http.js';

import { providers as lrclibProviders, cleanLrclibQuery } from '../lyrics/providers/lrclib.js';
import {
  providers as mxmProviders,
  parseRichSyncBody,
  resetMusixmatchSession,
  scoreMusixmatchTrack,
  signMusixmatchUrl,
  subtitleToLrc,
} from '../lyrics/providers/musixmatch.js';
import {
  providers as kugouProviders,
  decodeKugouContent,
  encodeKugouContent,
  kugouKeyword,
  stripKugouCredits,
} from '../lyrics/providers/kugou.js';
import { providers as megalobizProviders } from '../lyrics/providers/megalobiz.js';
import {
  providers as geniusProviders,
  cleanGeniusQuery,
  geniusBestMatch,
  geniusSearchAttempts,
  parseGeniusHtml,
} from '../lyrics/providers/genius.js';
import {
  providers as youtubeProviders,
  lyricsBrowseEndpoint,
  resetInnertubeSession,
  transcriptParams,
} from '../lyrics/providers/youtube.js';

const provider = (list, id) => list.find((p) => p.id === id);
const lrclib = provider(lrclibProviders, 'lrclib');
const musixmatch = provider(mxmProviders, 'musixmatch');
const kugou = provider(kugouProviders, 'kugou');
const megalobiz = provider(megalobizProviders, 'megalobiz');
const genius = provider(geniusProviders, 'genius');
const ytTranscript = provider(youtubeProviders, 'youtube_transcript');
const ytMusic = provider(youtubeProviders, 'youtube_music');

const sung = (lines) => lines.filter((l) => l.text !== '');
const header = (init, name) => {
  const h = init?.headers ?? {};
  const key = Object.keys(h).find((k) => k.toLowerCase() === name.toLowerCase());
  return key === undefined ? undefined : h[key];
};
/** A fetch that never answers and rejects when its signal aborts. */
const hangingFetch = () => (url, { signal }) => new Promise((_, reject) => {
  if (signal.aborted) reject(signal.reason);
  signal.addEventListener('abort', () => reject(signal.reason), { once: true });
});

test('provider descriptors', () => {
  const all = [lrclib, musixmatch, kugou, megalobiz, genius, ytTranscript, ytMusic];
  for (const p of all) {
    assert.equal(typeof p.id, 'string');
    assert.equal(typeof p.label, 'string');
    assert.equal(typeof p.wordSynced, 'boolean');
    assert.equal(typeof p.lyrics, 'function');
  }
  assert.deepEqual(all.map((p) => p.label), ['LRCLIB', 'Musixmatch', 'KuGou', 'Megalobiz', 'Genius', 'YouTube captions', 'YouTube Music']);
});

// =============================================================================
// LRCLIB
// =============================================================================

const LRCLIB_RECORD = (over = {}) => ({
  id: 1,
  trackName: 'Placeholder Song',
  artistName: 'Placeholder Artist',
  albumName: 'Placeholder Album',
  duration: 200,
  instrumental: false,
  plainLyrics: 'First line\nSecond line',
  syncedLyrics: '[00:01.00] First line\n[00:05.00] Second line',
  ...over,
});

test('lrclib: exact /api/get hit, query encoding and User-Agent', async () => {
  const fetch = fakeFetch([
    [(u) => u.startsWith('https://lrclib.net/api/get?'), () => ({ body: LRCLIB_RECORD() })],
  ]);
  const lines = await lrclib.lyrics({ title: 'Placeholder Song', artist: 'Placeholder Artist', durationMs: 200_999 }, { fetch });
  assert.deepEqual(lines.map((l) => [l.timeMs, l.text]), [[1_000, 'First line'], [5_000, 'Second line']]);
  assert.equal(fetch.calls.length, 1);
  assert.equal(fetch.calls[0].url, 'https://lrclib.net/api/get?track_name=Placeholder%20Song&artist_name=Placeholder%20Artist&duration=200');
  assert.equal(header(fetch.calls[0].init, 'User-Agent'), 'BitChord (https://github.com/bitchord)');
});

test('lrclib: exact miss (404) falls back to /api/search and takes the closest duration with synced lyrics', async () => {
  const fetch = fakeFetch([
    [(u) => u.includes('/api/get?'), () => ({ status: 404, body: { code: 404, name: 'TrackNotFound', message: 'Failed to find specified track' } })],
    [(u) => u.includes('/api/search?'), () => ({
      body: [
        LRCLIB_RECORD({ id: 2, duration: 150, syncedLyrics: '[00:01.00]too short' }),
        LRCLIB_RECORD({ id: 3, duration: 200, syncedLyrics: null }), // exact length but unsynced: skipped
        LRCLIB_RECORD({ id: 4, duration: 201.5, syncedLyrics: '[00:02.00]closest synced' }),
        LRCLIB_RECORD({ id: 5, duration: 199, syncedLyrics: '   ' }), // blank: skipped
      ],
    })],
  ]);
  const lines = await lrclib.lyrics({ title: 'Placeholder Song', artist: 'Placeholder Artist', durationMs: 200_000 }, { fetch });
  assert.deepEqual(lines.map((l) => l.text), ['closest synced']);
  assert.equal(fetch.calls.length, 2);
  assert.equal(fetch.calls[1].url, 'https://lrclib.net/api/search?track_name=Placeholder%20Song&artist_name=Placeholder%20Artist');
});

test('lrclib: no maximum duration tolerance in the search fallback (BitChord weakness)', async () => {
  const fetch = fakeFetch([
    [(u) => u.includes('/api/get?'), () => ({ status: 404, body: {} })],
    [(u) => u.includes('/api/search?'), () => ({ body: [LRCLIB_RECORD({ duration: 600, syncedLyrics: '[00:01.00]ten minutes off' })] })],
  ]);
  const lines = await lrclib.lyrics({ title: 'x', artist: 'y', durationMs: 180_000 }, { fetch });
  assert.deepEqual(lines.map((l) => l.text), ['ten minutes off']);
});

test('lrclib: plain-only everywhere is a miss; an exact "" skips the search', async () => {
  const plainOnly = fakeFetch([
    [(u) => u.includes('/api/get?'), () => ({ body: LRCLIB_RECORD({ syncedLyrics: null }) })],
    [(u) => u.includes('/api/search?'), () => ({ body: [LRCLIB_RECORD({ syncedLyrics: null })] })],
  ]);
  assert.equal(await lrclib.lyrics({ title: 'a', artist: 'b', durationMs: 1_000 }, { fetch: plainOnly }), null);
  assert.equal(plainOnly.calls.length, 2);

  const emptyExact = fakeFetch([
    [(u) => u.includes('/api/get?'), () => ({ body: LRCLIB_RECORD({ syncedLyrics: '' }) })],
    [(u) => u.includes('/api/search?'), () => ({ body: [LRCLIB_RECORD()] })],
  ]);
  assert.equal(await lrclib.lyrics({ title: 'a', artist: 'b', durationMs: 1_000 }, { fetch: emptyExact }), null);
  assert.equal(emptyExact.calls.length, 1);
});

test('lrclib: its own title cleaning strips (From ...), (Remix ...), any [...] and " | ..."', () => {
  assert.equal(cleanLrclibQuery('Song (From "Some Film")'), 'Song');
  assert.equal(cleanLrclibQuery('Song (Remix) [Live] | Official Video'), 'Song');
  assert.equal(cleanLrclibQuery('Song lyrical full song'), 'Song');
  assert.equal(cleanLrclibQuery('[Only brackets]'), '[Only brackets]'); // nothing left: original kept
});

// =============================================================================
// Musixmatch
// =============================================================================

const MXM_SECRET = 'test-signing-secret'; // a dummy - never the real key
const MXM_APP_JS = (secret) => {
  const reversed = [...Buffer.from(secret, 'utf8').toString('base64')].reverse().join('');
  return `(self.webpackChunk=self.webpackChunk||[]).push([[888],{1:function(e,t,n){const s=n.Buffer.from("${reversed}".split("").reverse().join(""),"base64").toString("utf-8");e.exports=s}}]);`;
};
const MXM_SEARCH_PAGE = '<!DOCTYPE html><html><head><script src="/_next/static/chunks/webpack-1a2b.js" defer=""></script>'
  + '<script src="/_next/static/chunks/pages/_app-5f2e1c9d.js" defer=""></script></head><body></body></html>';
const envelope = (body, statusCode = 200) => ({ message: { header: { status_code: statusCode, execute_time: 0.01 }, body } });

const utcDate = () => {
  const d = new Date();
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;
};
/** Check a request URL carries a valid signature for `secret` (today, UTC). */
function assertSigned(url, secret) {
  const at = url.indexOf('&signature=');
  assert.ok(at > 0, `unsigned: ${url}`);
  const unsigned = url.slice(0, at);
  const params = new URL(url).searchParams;
  assert.equal(params.get('signature_protocol'), 'sha256');
  const expected = createHmac('sha256', secret).update(unsigned + utcDate()).digest('base64');
  assert.equal(params.get('signature'), expected);
  assert.ok(!unsigned.includes('%20'), 'spaces are sent as +');
}

const MXM_TRACKS = [
  { track: { track_id: 11, track_name: 'Other Placeholder Song', artist_name: 'Someone Else', track_length: 300, has_subtitles: 1, has_richsync: 1 } },
  { track: { track_id: 22, track_name: 'Placeholder Song', artist_name: 'Placeholder Artist', track_length: 201, has_subtitles: 1, has_richsync: 1 } },
];
const RICHSYNC = [
  {
    ts: 48.502,
    te: 50.813,
    x: 'I save time by giving it all',
    l: [
      { c: 'I', o: 0.0 }, { c: ' ', o: 0.12 }, { c: 'save ', o: 0.18 }, { c: 'time ', o: 0.52 },
      { c: 'by ', o: 0.87 }, { c: 'giv', o: 1.08 }, { c: 'ing ', o: 1.24 }, { c: 'it ', o: 1.56 }, { c: 'all', o: 1.82 },
    ],
  },
];
const SUBTITLE = [
  { text: 'First line', time: { total: 12.5, minutes: 0, seconds: 12, hundredths: 50 } },
  { text: '', time: { total: 20.0, minutes: 0, seconds: 20, hundredths: 0 } },
  { text: 'Second line', time: { total: 65.123, minutes: 1, seconds: 5, hundredths: 12 } },
];

/** A fake Musixmatch: web page + app script + signed API. `tokens` are handed out in order. */
function mxmServer({ tokens = ['tok-1'], search, richsync, subtitle, pageStatus = 200 } = {}) {
  let tokenIndex = 0;
  return fakeFetch([
    [(u) => u === 'https://www.musixmatch.com/search', () => ({ status: pageStatus, body: MXM_SEARCH_PAGE })],
    [(u) => u === 'https://www.musixmatch.com/_next/static/chunks/pages/_app-5f2e1c9d.js', () => ({ body: MXM_APP_JS(MXM_SECRET) })],
    [(u) => u.startsWith('https://apic.musixmatch.com/ws/1.1/token.get?'), () => ({ body: envelope({ user_token: tokens[Math.min(tokenIndex++, tokens.length - 1)] }) })],
    [(u) => u.startsWith('https://apic.musixmatch.com/ws/1.1/track.search?'), (u) => ({ body: search ? search(new URL(u).searchParams) : envelope({ track_list: MXM_TRACKS }) })],
    [(u) => u.startsWith('https://apic.musixmatch.com/ws/1.1/track.richsync.get?'), () => ({ body: richsync ?? envelope({ richsync: { richsync_body: JSON.stringify(RICHSYNC) } }) })],
    [(u) => u.startsWith('https://apic.musixmatch.com/ws/1.1/track.subtitle.get?'), () => ({ body: subtitle ?? envelope({ subtitle: { subtitle_body: JSON.stringify(SUBTITLE) } }) })],
  ]);
}

const MXM_QUERY = { title: 'Placeholder Song', artist: 'Placeholder Artist', durationMs: 200_000 };

beforeEach(() => {
  resetMusixmatchSession();
  resetInnertubeSession();
});

test('musixmatch: scrape secret -> token -> signed search -> best track -> rich sync (word-synced)', async () => {
  const fetch = mxmServer();
  const lines = await musixmatch.lyrics(MXM_QUERY, { fetch });
  const [l] = sung(lines);
  assert.equal(l.text, 'I save time by giving it all');
  assert.deepEqual(l.words.map((w) => w.text), ['I', 'save', 'time', 'by', 'giving', 'it', 'all']);
  assert.equal(l.timeMs, 48_502);
  assert.equal(l.sungUntilMs, 50_813);

  const urls = fetch.calls.map((c) => c.url);
  assert.equal(urls[0], 'https://www.musixmatch.com/search');
  assert.equal(header(fetch.calls[0].init, 'Cookie'), 'mxm_bab=AB');
  assert.match(header(fetch.calls[0].init, 'User-Agent'), /Chrome\/131/);
  const api = fetch.calls.filter((c) => c.url.startsWith('https://apic.musixmatch.com/'));
  assert.deepEqual(api.map((c) => new URL(c.url).pathname), ['/ws/1.1/token.get', '/ws/1.1/track.search', '/ws/1.1/track.richsync.get']);
  for (const c of api) assertSigned(c.url, MXM_SECRET);
  const search = new URL(api[1].url).searchParams;
  assert.equal(search.get('q_track'), 'Placeholder Song');
  assert.equal(search.get('usertoken'), 'tok-1');
  assert.equal(search.get('f_has_lyrics'), '1');
  assert.equal(search.get('page_size'), '10');
  assert.equal(new URL(api[2].url).searchParams.get('track_id'), '22');
  assert.ok(api[1].url.includes('q_track=Placeholder+Song&'));
});

test('musixmatch: the credentials are cached for the process', async () => {
  const fetch = mxmServer();
  await musixmatch.lyrics(MXM_QUERY, { fetch });
  const before = fetch.calls.length;
  await musixmatch.lyrics(MXM_QUERY, { fetch });
  const second = fetch.calls.slice(before).map((c) => new URL(c.url).pathname);
  assert.deepEqual(second, ['/ws/1.1/track.search', '/ws/1.1/track.richsync.get']);
});

test('musixmatch: no rich sync -> subtitle.get (mxm) -> LRC -> line-synced', async () => {
  const fetch = mxmServer({
    search: () => envelope({ track_list: [{ track: { ...MXM_TRACKS[1].track, has_richsync: 0 } }] }),
  });
  const lines = await musixmatch.lyrics(MXM_QUERY, { fetch });
  assert.deepEqual(lines.map((l) => [l.timeMs, l.text]), [[0, ''], [12_500, 'First line'], [65_123, 'Second line']]);
  assert.ok(lines.every((l) => l.words.length === 0));
  const paths = fetch.calls.map((c) => new URL(c.url).pathname);
  assert.ok(!paths.includes('/ws/1.1/track.richsync.get'));
  const sub = fetch.calls.find((c) => c.url.includes('track.subtitle.get'));
  assert.equal(new URL(sub.url).searchParams.get('subtitle_format'), 'mxm');
});

test('musixmatch: a 401 inside a 200 renews secret and token once and retries', async () => {
  const fetch = mxmServer({
    tokens: ['tok-old', 'tok-new'],
    search: (params) => (params.get('usertoken') === 'tok-old'
      ? envelope('', 401)
      : envelope({ track_list: MXM_TRACKS })),
  });
  const lines = await musixmatch.lyrics(MXM_QUERY, { fetch });
  assert.ok(lines.some((l) => l.words.length > 0));
  const paths = fetch.calls.map((c) => new URL(c.url).pathname);
  assert.equal(paths.filter((p) => p === '/search').length, 2, 'secret re-scraped');
  assert.equal(paths.filter((p) => p === '/ws/1.1/token.get').length, 2, 'token re-fetched');
  const searches = fetch.calls.filter((c) => c.url.includes('track.search'));
  assert.deepEqual(searches.map((c) => new URL(c.url).searchParams.get('usertoken')), ['tok-old', 'tok-new']);
});

test('musixmatch: scrape failure uses ctx.keys.musixmatchSigningSecret, else misses without API calls', async () => {
  const withKey = mxmServer({ pageStatus: 503 });
  const lines = await musixmatch.lyrics(MXM_QUERY, { fetch: withKey, keys: { musixmatchSigningSecret: MXM_SECRET } });
  assert.ok(lines.some((l) => l.words.length > 0));

  resetMusixmatchSession();
  const withoutKey = mxmServer({ pageStatus: 503 });
  assert.equal(await musixmatch.lyrics(MXM_QUERY, { fetch: withoutKey }), null);
  assert.ok(withoutKey.calls.every((c) => !c.url.startsWith('https://apic.musixmatch.com/')));
});

test('musixmatch: an error envelope with "body": [] is a miss', async () => {
  const fetch = mxmServer({ search: () => envelope([], 404) });
  assert.equal(await musixmatch.lyrics(MXM_QUERY, { fetch }), null);
});

test('musixmatch: signMusixmatchUrl matches HMAC-SHA256(url + yyyyMMdd) and normalises %20 to +', () => {
  const now = new Date(Date.UTC(2026, 8, 26, 23, 59, 59));
  const url = 'https://apic.musixmatch.com/ws/1.1/track.search?app_id=mobile-app-v1.0&q_track=A%20B&usertoken=t';
  const signed = signMusixmatchUrl(url, 'k', now);
  const normalized = url.replace('%20', '+');
  const mac = createHmac('sha256', 'k').update(`${normalized}20260926`).digest('base64');
  assert.equal(signed, `${normalized}&signature=${encodeURIComponent(mac)}&signature_protocol=sha256`);
});

test('musixmatch: score() weights and the absence of a minimum score', () => {
  const t = (name, artist, length) => ({ track_name: name, artist_name: artist, track_length: length });
  assert.equal(scoreMusixmatchTrack(t('Song', 'Artist', 200), 'song', 'artist', 201), 150);
  assert.equal(scoreMusixmatchTrack(t('Song (Live)', 'Artist feat. X', 196), 'Song', 'Artist', 200), 95);
  assert.equal(scoreMusixmatchTrack(t('Unrelated', 'Nobody', 400), 'Song', 'Artist', 200), -20);
  assert.equal(scoreMusixmatchTrack({ track_name: 'Song', artist_name: 'Artist' }, 'Song', 'Artist', 200), 120);
});

test('musixmatch: parseRichSyncBody (ported MusixmatchTest.kt cases)', () => {
  const [l] = sung(parseRichSyncBody(JSON.stringify(RICHSYNC)));
  assert.equal(l.timeMs, 48_502);
  assert.equal(l.words[4].text, 'giving');
  assert.equal(l.words[4].startMs, 49_582);
  assert.equal(l.words.at(-1).endMs, 50_813);

  const backwards = sung(parseRichSyncBody(JSON.stringify([
    { ts: 10.0, te: 12.0, x: 'one two three', l: [{ c: 'one ', o: 0.0 }, { c: 'two ', o: 0.7 }, { c: 'three', o: 0.65 }] },
  ])))[0].words;
  assert.deepEqual(backwards.map((w) => w.startMs), [10_000, 10_700, 10_700]);
  assert.ok(backwards.every((w) => w.endMs >= w.startMs));

  assert.deepEqual(parseRichSyncBody('not json'), []);
  assert.deepEqual(parseRichSyncBody(JSON.stringify([{ ts: 1, l: [] }])), []); // missing te: whole body rejected
});

test('musixmatch: subtitleToLrc skips blank (instrumental) rows and writes [mm:ss.mmm]', () => {
  assert.equal(subtitleToLrc(JSON.stringify(SUBTITLE)), '[00:12.500]First line\n[01:05.123]Second line');
  assert.equal(subtitleToLrc('[{"text":"x"}]'), '');
});

// =============================================================================
// KuGou
// =============================================================================

// Shaped like a real lyrics.kugou.com/download?fmt=lrc payload (cf. KuGouTest.kt):
// unstamped header tags, the title restated, two credits with full-width colons.
const KUGOU_LRC = [
  '[id:$00000000]',
  '[ti:Placeholder Song]',
  '[ar:Placeholder Artist]',
  '[al:Placeholder Album]',
  '[by:]',
  '[offset:0]',
  '[00:00.00]Placeholder Song - PLACEHOLDER ĀRTIST',
  '[00:04.12]Lyrics by：Writer One/Writer Two',
  '[00:08.24]Composed by：Writer One',
  '[00:12.36]First sung line',
  '[00:15.90]Second sung line',
  '[00:19.73]Third sung line, with 作词 characters',
  '[03:04.12]Last sung line',
  '[03:07.90]Ooh ooh ooh-ooh',
].join('\r\n');

test('kugou: download content is base64(UTF-8 LRC); encode/decode round-trips and matches Node', () => {
  const encoded = encodeKugouContent(KUGOU_LRC);
  assert.equal(encoded, Buffer.from(KUGOU_LRC, 'utf8').toString('base64'));
  assert.equal(decodeKugouContent(encoded), KUGOU_LRC);
  assert.equal(decodeKugouContent(encoded.replace(/=+$/, '')), KUGOU_LRC); // padding optional
  assert.throws(() => decodeKugouContent(`${encoded.slice(0, 8)}\n${encoded.slice(8)}`)); // strict like java.util.Base64
});

test('kugou: stripCredits drops header tags and everything through the last head credit', () => {
  const stripped = stripKugouCredits(KUGOU_LRC);
  assert.ok(stripped.startsWith('[00:12.36]First sung line'));
  assert.ok(!stripped.includes('Lyrics by') && !stripped.includes('Composed by') && !stripped.includes('ĀRTIST'));
  assert.ok(!stripped.includes('[ti:') && !stripped.includes('[offset:'));
  assert.ok(stripped.endsWith('[03:07.90]Ooh ooh ooh-ooh'));
  assert.equal(stripKugouCredits('[00:01.00]a\n[00:05.00]b'), '[00:01.00]a\n[00:05.00]b');
  assert.equal(stripKugouCredits(''), '');
});

test('kugou: BitChord-exact stripCredits deletes a short song up to its last colon line (bug)', () => {
  const compat = { bitchordCompat: true };
  // <= 31 stamped lines: the head window is the whole file.
  const trailingCredits = '[00:01.00]sung\n[00:05.00]also sung\n[03:00.00]Mixed by：A\n[03:01.00]Mastered by：B';
  assert.equal(stripKugouCredits(trailingCredits, compat), '');
  const colonLyric = '[00:01.00]one\n[00:02.00]two\n[00:03.00]Rule one: listen\n[00:04.00]four';
  assert.equal(stripKugouCredits(colonLyric, compat), '[00:04.00]four');
  // The Kotlin test fixture's shape is unaffected (no colon after the credits).
  assert.equal(stripKugouCredits(KUGOU_LRC, compat), stripKugouCredits(KUGOU_LRC));
});

test('kugou: default stripCredits keeps windows to half the file; the tail stays nearest-first', () => {
  const trailingCredits = '[00:01.00]sung\n[00:05.00]also sung\n[03:00.00]Mixed by：A\n[03:01.00]Mastered by：B';
  assert.equal(stripKugouCredits(trailingCredits), '[00:01.00]sung\n[00:05.00]also sung\n[03:00.00]Mixed by：A');
});

test('kugou: a colon-bearing lyric inside a window still reads as a credit (heuristic weakness, both modes)', () => {
  const colonLyric = '[00:01.00]one\n[00:02.00]two\n[00:03.00]Rule one: listen\n[00:04.00]four\n[00:05.00]five\n[00:06.00]six';
  const expected = '[00:04.00]four\n[00:05.00]five\n[00:06.00]six';
  assert.equal(stripKugouCredits(colonLyric), expected);
  assert.equal(stripKugouCredits(colonLyric, { bitchordCompat: true }), expected);
});

test('kugou: on a long file both modes agree, including the tail asymmetry', () => {
  const body = Array.from({ length: 40 }, (_, i) => `[00:${String(i).padStart(2, '0')}.00]line ${i}`).join('\n');
  const lrc = `${body}\n[03:00.00]Mixed by：A\n[03:01.00]Mastered by：B`;
  for (const options of [{}, { bitchordCompat: true }]) {
    const out = stripKugouCredits(lrc, options).split('\n');
    assert.equal(out.length, 41);
    assert.equal(out.at(-1), '[03:00.00]Mixed by：A'); // only the credit nearest the end goes
  }
});

test('kugou: song search -> tolerance filter -> hash lyric search -> download -> parse', async () => {
  const fetch = fakeFetch([
    [(u) => u.startsWith('https://mobileservice.kugou.com/api/v3/search/song?'), () => ({
      body: {
        status: 1,
        error: '',
        data: {
          total: 3,
          info: [
            { hash: 'AAAA', duration: 260, songname: 'Placeholder Song (Extended)' },
            { hash: 'BBBB', duration: 203, songname: 'Placeholder Song' },
            { hash: 'CCCC', duration: 197, songname: 'Placeholder Song' },
          ],
        },
      },
    })],
    [(u) => u.includes('lyrics.kugou.com/search?') && u.includes('hash=BBBB'), () => ({ body: { status: 200, info: 'OK', candidates: [] } })],
    [(u) => u.includes('lyrics.kugou.com/search?') && u.includes('hash=CCCC'), () => ({
      body: { status: 200, info: 'OK', candidates: [{ id: '12345', accesskey: 'ABCDEF0123', singer: 'x', song: 'y', duration: 197_000, score: 60 }] },
    })],
    [(u) => u.startsWith('https://lyrics.kugou.com/download?'), () => ({
      body: { status: 200, info: 'OK', error_code: 0, fmt: 'lrc', contenttype: 0, charset: 'utf8', id: '12345', content: encodeKugouContent(KUGOU_LRC) },
    })],
  ]);
  const lines = await kugou.lyrics({ title: 'Placeholder Song (Remastered)', artist: 'Placeholder Artist', album: 'Placeholder Album', durationMs: 200_400 }, { fetch });
  assert.deepEqual(lines.map((l) => [l.timeMs, l.text]), [
    [0, ''],
    [12_360, 'First sung line'],
    [15_900, 'Second sung line'],
    [19_730, 'Third sung line, with 作词 characters'],
    [184_120, 'Last sung line'],
    [187_900, 'Ooh ooh ooh-ooh'],
  ]);
  const urls = fetch.calls.map((c) => c.url);
  assert.equal(urls[0], 'https://mobileservice.kugou.com/api/v3/search/song?version=9108&plat=0&pagesize=8&showtype=0&keyword=Placeholder%20Song%20-%20Placeholder%20Artist%20Placeholder%20Album');
  assert.equal(urls[1], 'https://lyrics.kugou.com/search?ver=1&man=yes&client=pc&hash=BBBB'); // 203 s and 197 s tie at 3 s: stable order
  assert.equal(urls[2], 'https://lyrics.kugou.com/search?ver=1&man=yes&client=pc&hash=CCCC');
  assert.equal(urls[3], 'https://lyrics.kugou.com/download?fmt=lrc&charset=utf8&client=pc&ver=1&id=12345&accesskey=ABCDEF0123');
  assert.ok(urls.every((u) => !u.includes('AAAA')), 'the 60 s-off cut is never tried');
  assert.equal(header(fetch.calls[0].init, 'Accept'), 'application/json');
  assert.equal(header(fetch.calls[0].init, 'User-Agent'), 'BitChord (https://github.com/bitchord)');
});

test('kugou: no hash within 8 s -> keyword lyric search with duration in ms', async () => {
  const fetch = fakeFetch([
    [(u) => u.includes('/api/v3/search/song?'), () => ({ body: { data: { info: [{ hash: 'FAR', duration: 100 }] } } })],
    [(u) => u.includes('lyrics.kugou.com/search?') && u.includes('keyword='), () => ({ body: { candidates: [{ id: '9', accesskey: 'K' }] } })],
    [(u) => u.includes('lyrics.kugou.com/download?'), () => ({ body: { content: encodeKugouContent('[00:01.00]only line') } })],
  ]);
  const lines = await kugou.lyrics({ title: 'Song', artist: 'Artist', durationMs: 200_000 }, { fetch });
  assert.deepEqual(lines.map((l) => l.text), ['only line']);
  assert.equal(fetch.calls[1].url, 'https://lyrics.kugou.com/search?ver=1&man=yes&client=pc&keyword=Song%20-%20Artist&duration=200000');
});

test('kugou: keyword shaping, and misses', async () => {
  assert.equal(kugouKeyword('Song (Live) （現場）', 'Artist (Band)', '  '), 'Song - Artist');
  assert.equal(kugouKeyword('(Only)', 'A', null), '(Only) - A');
  const nothing = fakeFetch([
    [(u) => u.includes('/api/v3/search/song?'), () => ({ body: { data: { info: [] } } })],
    [(u) => u.includes('lyrics.kugou.com/search?'), () => ({ body: { candidates: [] } })],
  ]);
  assert.equal(await kugou.lyrics({ title: 'x', artist: 'y', durationMs: 1_000 }, { fetch: nothing }), null);
  const badBase64 = fakeFetch([
    [(u) => u.includes('/api/v3/search/song?'), () => ({ body: { data: { info: [] } } })],
    [(u) => u.includes('lyrics.kugou.com/search?'), () => ({ body: { candidates: [{ id: '1', accesskey: 'k' }] } })],
    [(u) => u.includes('lyrics.kugou.com/download?'), () => ({ body: { content: 'not base64 !' } })],
  ]);
  assert.equal(await kugou.lyrics({ title: 'x', artist: 'y', durationMs: 1_000 }, { fetch: badBase64 }), null);
});

test('kugou: a cancelled lookup rejects instead of reporting a miss', async () => {
  const controller = new AbortController();
  const pending = kugou.lyrics({ title: 'x', artist: 'y', durationMs: 1_000 }, { fetch: hangingFetch(), signal: controller.signal });
  controller.abort(new Error('race lost'));
  await assert.rejects(pending, /race lost/);
});

// =============================================================================
// Megalobiz
// =============================================================================

const MEGALOBIZ_SEARCH = `<!DOCTYPE html><html><body><div class="pro_part">
  <a class="entity_name" href="/lrc/maker/download/51234567/placeholder-artist-song&amp;ref=search" title="Placeholder Artist - Song">Placeholder Artist - Song</a>
  <a class="entity_name" href="/lrc/maker/download/99999999/someone-else">Someone Else - Song</a>
</div></body></html>`;
const MEGALOBIZ_PAGE = `<html><body><div class="lyrics_details entity_more_info">
<span id="lrc_51234567_details" class="lrc_text">[ar:Placeholder Artist]<br />
[ti:Song]<br>
[00:01.00]First &amp; only line<br/>
[00:05.00]It&#39;s the <i>second</i> line<BR>
[00:09.00]Third line</span><span id="other">not lyrics</span></div></body></html>`;

test('megalobiz: first /lrc/maker/download link -> lrc_*_details span -> LRC', async () => {
  const fetch = fakeFetch([
    [(u) => u.startsWith('https://www.megalobiz.com/searchall?'), () => ({ body: MEGALOBIZ_SEARCH })],
    [(u) => u.startsWith('https://www.megalobiz.com/lrc/maker/download/51234567/'), () => ({ body: MEGALOBIZ_PAGE })],
  ]);
  const lines = await megalobiz.lyrics({ title: 'Song', artist: 'Placeholder Artist', durationMs: 0 }, { fetch });
  assert.deepEqual(lines.map((l) => [l.timeMs, l.text]), [[1_000, 'First & only line'], [5_000, "It's the second line"], [9_000, 'Third line']]);
  assert.equal(fetch.calls[0].url, 'https://www.megalobiz.com/searchall?qry=Placeholder%20Artist%20Song');
  assert.equal(fetch.calls[1].url, 'https://www.megalobiz.com/lrc/maker/download/51234567/placeholder-artist-song&ref=search');
});

test('megalobiz: no link, no details element, or only blank lines is a miss', async () => {
  const noLink = fakeFetch([[(u) => u.includes('/searchall?'), () => ({ body: '<html>no results</html>' })]]);
  assert.equal(await megalobiz.lyrics({ title: 'a', artist: 'b' }, { fetch: noLink }), null);
  const blank = fakeFetch([
    [(u) => u.includes('/searchall?'), () => ({ body: MEGALOBIZ_SEARCH })],
    [(u) => u.includes('/lrc/maker/download/'), () => ({ body: '<span id="lrc_1_details">[ar:x]<br>[00:01.00]<br>[00:09.00]</span>' })],
  ]);
  assert.equal(await megalobiz.lyrics({ title: 'a', artist: 'b' }, { fetch: blank }), null);
});

// =============================================================================
// Genius
// =============================================================================

const GENIUS_SEARCH = {
  meta: { status: 200 },
  response: {
    sections: [
      { type: 'top_hit', hits: [] },
      {
        type: 'song',
        hits: [
          { highlights: [], index: 'song', type: 'song', result: { title: 'Song (Translation)', artist_names: 'Genius Translations', path: '/Genius-translations-song-translation-lyrics', url: 'https://genius.com/Genius-translations-song-translation-lyrics' } },
          { highlights: [], index: 'song', type: 'song', result: { title: 'Song', artist_names: 'Placeholder Artist', path: '/Placeholder-artist-song-lyrics', url: 'https://genius.com/Placeholder-artist-song-lyrics' } },
        ],
      },
      { type: 'lyric', hits: [] },
    ],
  },
};
const GENIUS_PAGE = `<!DOCTYPE html>
<html><head><title>Placeholder Artist - Song Lyrics | Genius Lyrics</title>
<script>window.__x = "<div data-lyrics-container=\\"true\\">not lyrics</div>";</script>
<style>.a > .b { color: red }</style></head>
<body>
  <div data-lyrics-container="true" class="Lyrics__Container-sc-1ynbvzw-1 kUgSbL">
    <div data-exclude-from-selection="true" class="LyricsHeader__Container-sc-5e4b7146-1 hFsVRk">
      <button>12 Contributors</button><div class="SongBioPreview__Container">Song Bio</div>
    </div>
    [Intro]<br>First line &amp; more<br><a href="/123/x" class="ReferentFragment"><span>Second line</span></a><br><br>
    [Verse 1]<br>Third line, it&#x27;s here<br>15You might also like<br>
  </div>
  <div class="InreadAd__Container"><div>ad text</div></div>
  <div data-lyrics-container="true" class="Lyrics__Container">[Chorus]<br>Fourth&nbsp;line<br><i>Fifth</i> line<br>42Embed</div>
</body></html>`;

const GENIUS_EXPECTED = ['[Intro]', 'First line & more', 'Second line', '', '[Verse 1]', "Third line, it's here", '', '[Chorus]', 'Fourth line', 'Fifth line'];

test('genius: page parsing keeps sections and stanzas and strips header/ads/artifacts', () => {
  const lines = parseGeniusHtml(GENIUS_PAGE);
  assert.deepEqual(lines.map((l) => l.text), GENIUS_EXPECTED);
  assert.ok(lines.every((l) => l.timeMs === 0 && l.words.length === 0));
});

test('genius: legacy div.lyrics layout with <p> blocks', () => {
  const lines = parseGeniusHtml('<div class="song_body lyrics"><p>[Hook]<br>line one</p><p>line two<br/>line three</p></div>');
  assert.deepEqual(lines.map((l) => l.text), ['[Hook]', 'line one', 'line two', 'line three']);
  assert.equal(parseGeniusHtml('<div class="nothing">x</div>'), null);
});

test('genius: search/multi -> song section -> best hit -> page', async () => {
  const fetch = fakeFetch([
    [(u) => u.startsWith('https://genius.com/api/search/multi?'), () => ({ body: GENIUS_SEARCH })],
    [(u) => u === 'https://genius.com/Placeholder-artist-song-lyrics', () => ({ body: GENIUS_PAGE })],
  ]);
  const lines = await genius.lyrics({ title: 'Song', artist: 'Placeholder Artist', durationMs: 0 }, { fetch });
  assert.deepEqual(lines.map((l) => l.text), GENIUS_EXPECTED);
  assert.equal(fetch.calls[0].url, 'https://genius.com/api/search/multi?q=Placeholder+Artist+Song');
  assert.equal(header(fetch.calls[0].init, 'User-Agent'), 'BitChord');
  assert.equal(fetch.calls.length, 2);
});

test('genius: every attempt missing (403 challenge or no song section) is a miss', async () => {
  const fetch = fakeFetch([
    [(u) => u.includes('q=Placeholder+Artist+Song'), () => ({ status: 403, body: '<html>Just a moment...</html>' })],
    [(u) => u.includes('/api/search/multi?'), () => ({ body: { response: { sections: [{ type: 'top_hit', hits: [] }] } } })],
  ]);
  assert.equal(await genius.lyrics({ title: 'Song', artist: 'Placeholder Artist' }, { fetch }), null);
  assert.deepEqual(fetch.calls.map((c) => new URL(c.url).searchParams.get('q')), ['Placeholder Artist Song', 'Song']);
});

test('genius: query plan - cleaning, "Artist - Title" split, and the hyphenated-title quirk', () => {
  assert.equal(cleanGeniusQuery('♪ Placeholder - Song [OFFICIAL MUSIC VIDEO] Prod. Some Producer ♪'), 'Placeholder - Song');
  assert.equal(cleanGeniusQuery('Song (feat. Guest) | Topic'), 'Song');

  const split = geniusSearchAttempts('Placeholder Artist - Song', 'Placeholder Artist');
  assert.deepEqual(split[0], { query: 'Placeholder Artist Song', title: 'Song', artist: 'Placeholder Artist' });
  assert.equal(split.at(-1).query, 'Song');

  const hyphen = geniusSearchAttempts('Up-Beat', 'Placeholder Artist');
  assert.deepEqual(hyphen.map((a) => a.query), ['Placeholder Artist Beat', 'Placeholder Artist Up-Beat', 'Up-Beat', 'Beat']);
});

test('genius: bestMatch accepts an artist-only match and rejects penalised pages', () => {
  const differentSong = { title: 'Completely Different', artist_names: 'Placeholder Artist', path: '/x', url: 'u1' };
  assert.equal(geniusBestMatch([differentSong], 'Song', 'Placeholder Artist'), differentSong);
  const tracklist = { title: 'Song', artist_names: 'Someone', path: '/Someone-album-tracklist', url: 'u2' };
  assert.equal(geniusBestMatch([tracklist], 'Song', 'Placeholder Artist'), null);
});

// =============================================================================
// YouTube (InnerTube, WEB_REMIX)
// =============================================================================

const VIDEO_ID = 'dQw4w9WgXcQ';

const TRANSCRIPT_RESPONSE = {
  responseContext: { visitorData: 'CgtWaXNpdG9yRGF0YUFCQ0RFRkdISUpLTE1OT1BRUlNUVVZXWFla' },
  actions: [{
    clickTrackingParams: 'x',
    updateEngagementPanelAction: {
      targetId: 'engagement-panel-searchable-transcript',
      content: {
        transcriptRenderer: {
          body: {
            transcriptBodyRenderer: {
              cueGroups: [
                { transcriptCueGroupRenderer: { formattedStartOffset: { simpleText: '0:20' }, cues: [{ transcriptCueRenderer: { cue: { simpleText: '♪ Second line ♪' }, startOffsetMs: '20000', durationMs: '4000' } }] } },
                { transcriptCueGroupRenderer: { formattedStartOffset: { simpleText: '0:12' }, cues: [{ transcriptCueRenderer: { cue: { runs: [{ text: 'First ' }, { text: 'line' }] }, startOffsetMs: 12000, durationMs: '3000' } }] } },
                { transcriptCueGroupRenderer: { cues: [{ transcriptCueRenderer: { cue: { simpleText: ' ♪ ' }, startOffsetMs: '25000', durationMs: '1000' } }] } },
                { transcriptCueGroupRenderer: { cues: [{ transcriptCueRenderer: { cue: { simpleText: '[Music]' }, startOffsetMs: '30000', durationMs: '5000' } }] } },
                { transcriptCueGroupRenderer: { cues: [{ transcriptCueRenderer: { cue: { simpleText: 'no start' } } }] } },
              ],
            },
          },
        },
      },
    },
  }],
};

test('youtube_transcript: WEB_REMIX get_transcript request shape', async () => {
  const fetch = fakeFetch([
    [(u, init) => u === 'https://music.youtube.com/youtubei/v1/get_transcript?prettyPrint=false&hl=en' && init.method === 'POST', () => ({ body: TRANSCRIPT_RESPONSE })],
  ]);
  await ytTranscript.lyrics({ title: '', artist: '', durationMs: 0, videoId: VIDEO_ID }, { fetch });
  const { init } = fetch.calls[0];
  const body = JSON.parse(init.body);
  assert.deepEqual(body.context, {
    client: { clientName: 'WEB_REMIX', clientVersion: '1.20250101.01.00', hl: 'en', gl: 'US' },
    user: { lockedSafetyMode: false },
    request: { useSsl: true },
  });
  const expectedParams = Buffer.from([0x0a, VIDEO_ID.length, ...Buffer.from(VIDEO_ID)]).toString('base64');
  assert.equal(body.params, expectedParams);
  assert.equal(transcriptParams(VIDEO_ID), expectedParams);
  assert.equal(header(init, 'X-YouTube-Client-Name'), '67');
  assert.equal(header(init, 'X-YouTube-Client-Version'), '1.20250101.01.00');
  assert.equal(header(init, 'X-Origin'), 'https://music.youtube.com');
  assert.equal(header(init, 'Origin'), 'https://music.youtube.com');
  assert.equal(header(init, 'Referer'), 'https://music.youtube.com/');
  assert.equal(header(init, 'Content-Type'), 'application/json');
  assert.equal(header(init, 'Accept-Language'), 'en-US,en;q=0.9');
  assert.equal(header(init, 'X-Goog-Visitor-Id'), undefined);
});

test('youtube_transcript: cues -> sorted line-synced lines; the visitor id is reused afterwards', async () => {
  const fetch = fakeFetch([[(u) => u.includes('/get_transcript?'), () => ({ body: TRANSCRIPT_RESPONSE })]]);
  const lines = await ytTranscript.lyrics({ title: '', artist: '', durationMs: 0, videoId: VIDEO_ID }, { fetch });
  // "♪" trimmed, "♪"-only cue dropped, "[Music]" kept (BitChord does not filter it), no-start cue dropped.
  assert.deepEqual(lines.map((l) => [l.timeMs, l.text]), [[12_000, 'First line'], [20_000, 'Second line'], [30_000, '[Music]']]);
  assert.ok(lines.every((l) => l.sungUntilMs === null));

  await ytTranscript.lyrics({ title: '', artist: '', durationMs: 0, videoId: VIDEO_ID }, { fetch });
  const second = fetch.calls[1].init;
  assert.equal(header(second, 'X-Goog-Visitor-Id'), TRANSCRIPT_RESPONSE.responseContext.visitorData);
  assert.equal(JSON.parse(second.body).context.client.visitorData, TRANSCRIPT_RESPONSE.responseContext.visitorData);
});

test('youtube: invalid video ids are rejected without a request; HTTP errors are misses', async () => {
  const fetch = fakeFetch([]);
  for (const videoId of [undefined, 'short', 'dQw4w9WgXcQ?', 'dQw4w9WgXcQx']) {
    assert.equal(await ytTranscript.lyrics({ title: '', artist: '', durationMs: 0, videoId }, { fetch }), null);
    assert.equal(await ytMusic.lyrics({ title: '', artist: '', durationMs: 0, videoId }, { fetch }), null);
  }
  assert.equal(fetch.calls.length, 0);

  const failing = fakeFetch([[() => true, () => ({ status: 500, body: '{"error":{}}' })]]);
  assert.equal(await ytTranscript.lyrics({ title: '', artist: '', durationMs: 0, videoId: VIDEO_ID }, { fetch: failing }), null);
  assert.equal(failing.calls.length, 1, 'an HTTP status is an answer: not retried');
});

test('youtube: a transport failure is retried after the 500 ms backoff', async () => {
  const inner = fakeFetch([[(u) => u.includes('/get_transcript?'), () => ({ body: TRANSCRIPT_RESPONSE })]]);
  let attempts = 0;
  const flaky = async (url, init) => {
    attempts += 1;
    if (attempts === 1) throw new TypeError('fetch failed');
    return inner(url, init);
  };
  const started = Date.now();
  const lines = await ytTranscript.lyrics({ title: '', artist: '', durationMs: 0, videoId: VIDEO_ID }, { fetch: flaky });
  assert.equal(attempts, 2);
  assert.ok(Date.now() - started >= 450);
  assert.equal(lines.length, 3);
});

const tab = (title, browseId, extra = {}) => ({
  tabRenderer: {
    title,
    ...(browseId ? { endpoint: { clickTrackingParams: 'c', browseEndpoint: { browseId, ...(browseId.startsWith('MPLY') ? { params: 'cGFyYW1z' } : {}), browseEndpointContextSupportedConfigs: { browseEndpointContextMusicConfig: { pageType: 'MUSIC_PAGE_TYPE_TRACK_LYRICS' } } } } } : {}),
    trackingParams: 't',
    ...extra,
  },
});
const upNextTab = {
  tabRenderer: {
    title: 'Up next',
    content: {
      musicQueueRenderer: {
        content: {
          playlistPanelRenderer: {
            contents: [{
              playlistPanelVideoRenderer: {
                title: { runs: [{ text: 'Some queued song' }] },
                longBylineText: { runs: [{ text: 'Queued Artist', navigationEndpoint: { browseEndpoint: { browseId: 'UCartistchannel' } } }] },
              },
            }],
          },
        },
      },
    },
  },
};
const nextResponse = (tabs) => ({
  responseContext: { visitorData: 'Cgt' + 'A'.repeat(40) },
  contents: { singleColumnMusicWatchNextResultsRenderer: { tabbedRenderer: { watchNextTabbedResultsRenderer: { tabs } } } },
});
const LYRICS_PAGE = {
  contents: {
    sectionListRenderer: {
      contents: [{
        musicDescriptionShelfRenderer: {
          description: { runs: [{ text: 'First line\r\nSecond line\n\n  Third line  \n' }] },
          footer: { runs: [{ text: 'Source: LyricFind' }] },
        },
      }],
    },
  },
};
const ARTIST_BIO_PAGE = {
  contents: { sectionListRenderer: { contents: [{ musicDescriptionShelfRenderer: { header: { runs: [{ text: 'About the artist' }] }, description: { runs: [{ text: 'An artist biography.' }] } } }] } },
};

function ytmServer(tabs) {
  return fakeFetch([
    [(u) => u.startsWith('https://music.youtube.com/youtubei/v1/next?'), () => ({ body: nextResponse(tabs) })],
    [(u, init) => u.startsWith('https://music.youtube.com/youtubei/v1/browse?') && JSON.parse(init.body).browseId.startsWith('MPLY'), () => ({ body: LYRICS_PAGE })],
    [(u, init) => u.startsWith('https://music.youtube.com/youtubei/v1/browse?') && JSON.parse(init.body).browseId.startsWith('MPTR'), () => ({ body: ARTIST_BIO_PAGE })],
  ]);
}

test('youtube_music: next -> Lyrics tab browseEndpoint -> browse -> description shelf (plain)', async () => {
  const fetch = ytmServer([upNextTab, tab('Lyrics', 'MPLYt_placeholder'), tab('Related', 'MPTRt_placeholder')]);
  const lines = await ytMusic.lyrics({ title: '', artist: '', durationMs: 0, videoId: VIDEO_ID }, { fetch });
  assert.deepEqual(lines.map((l) => [l.timeMs, l.text]), [[0, 'First line'], [0, 'Second line'], [0, 'Third line']]);
  const nextBody = JSON.parse(fetch.calls[0].init.body);
  assert.equal(nextBody.videoId, VIDEO_ID);
  assert.equal(nextBody.playlistId, `RDAMVM${VIDEO_ID}`);
  assert.equal(nextBody.isAudioOnly, true);
  const browseBody = JSON.parse(fetch.calls[1].init.body);
  assert.equal(browseBody.browseId, 'MPLYt_placeholder');
  assert.equal(browseBody.params, 'cGFyYW1z');
  assert.equal(browseBody.context.client.clientName, 'WEB_REMIX');
});

test('youtube_music: localised tab titles fall back to the tab in the Lyrics slot', async () => {
  const fetch = ytmServer([upNextTab, tab('Letra', 'MPLYt_localised'), tab('Relacionado', 'MPTRt_placeholder')]);
  const lines = await ytMusic.lyrics({ title: '', artist: '', durationMs: 0, videoId: VIDEO_ID }, { fetch, innertube: { hl: 'es' } });
  assert.equal(lines.length, 3);
  assert.equal(JSON.parse(fetch.calls[1].init.body).browseId, 'MPLYt_localised');
  assert.equal(header(fetch.calls[0].init, 'Accept-Language'), 'es,en-US;q=0.8,en;q=0.7');
  assert.ok(fetch.calls[0].url.endsWith('?prettyPrint=false&hl=es'));
});

test('youtube_music: an endpoint-less Lyrics tab is a miss (deviation: BitChord would browse the Related tab)', async () => {
  const tabs = [upNextTab, tab('Lyrics', null, { unselectable: true }), tab('Related', 'MPTRt_placeholder')];
  // BitChord's selection - drop(1).firstNotNullOfOrNull - would reach "Related":
  const bitchordFallback = tabs.slice(1).map((t) => t.tabRenderer.endpoint?.browseEndpoint).find(Boolean);
  assert.equal(bitchordFallback.browseId, 'MPTRt_placeholder');
  // This implementation stops at the Lyrics slot.
  assert.equal(lyricsBrowseEndpoint(nextResponse(tabs)), null);
  const fetch = ytmServer(tabs);
  assert.equal(await ytMusic.lyrics({ title: '', artist: '', durationMs: 0, videoId: VIDEO_ID }, { fetch }), null);
  assert.equal(fetch.calls.length, 1, 'no browse request');
});

test('youtube: a cancelled lookup rejects instead of reporting a miss', async () => {
  const controller = new AbortController();
  const pending = ytMusic.lyrics({ title: '', artist: '', durationMs: 0, videoId: VIDEO_ID }, { fetch: hangingFetch(), signal: controller.signal });
  controller.abort(new Error('superseded'));
  await assert.rejects(pending, /superseded/);
});
