// PaxSenix providers: 'paxsenix' (keyless Apple Music lyrics),
// 'paxsenix_spotify' and 'paxsenix_musixmatch' (authenticated, need a
// user-issued PaxSenix API key).
//
// Mirrors BitChord's data/lyrics/PaxSenix.kt (and the key handling in
// data/settings/AppSettings.kt). Responses are read by parseTimedApple below,
// falling back to ../formats/provider-payload.js (ProviderLyrics.kt).
// Independent JavaScript re-implementation of the mechanism documented in
// BITCHORD_ENGINE_RESEARCH.md (BitChord itself is GPL-3.0).
//
// 'paxsenix' — no PaxSenix key, but three hosts:
//   1. Apple web token, scraped once and cached for the life of the provider
//      instance (never refreshed, as in BitChord):
//        GET https://music.apple.com/us/new                → find /assets/index~….js
//        GET https://music.apple.com/assets/index~….js     → first eyJ….eyJ….… JWT
//   2. GET https://amp-api.music.apple.com/v1/catalog/us/search
//          ?term=<title artist>&types=songs&limit=10&l=en-US
//      with Authorization: Bearer <token>, Origin/Referer https://music.apple.com.
//      Candidates are scored (title 20/10, artist 15/5, duration ±3 s 10 / ±10 s 5)
//      and the best one scoring at least 10 is taken.
//   3. GET https://lyrics.paxsenix.org/apple-music/lyrics?id=<apple id>&ttml=true
//
// 'paxsenix_spotify' (key required; no request at all without one):
//   GET https://api.paxsenix.org/spotify/search?q=<title artist>   → best candidate (same scoring)
//   GET https://api.paxsenix.org/lyrics/spotify?id=<id>
//   on any miss: GET https://api.paxsenix.org/lyrics/lrcget?q=<title artist>
//
// 'paxsenix_musixmatch' (key required):
//   GET https://api.paxsenix.org/lyrics/musixmatch?t=<title>&a=<artist>&d=<whole s, even 0>
//   on a miss: the same lrcget fallback.
//
// The key: `ctx.keys.paxsenix` for a single lookup, else the `apiKey` given
// to createPaxSenixProviders(). BitChord stores it in AppSettings
// (`paxsenix_api_key`, excluded from settings export) and accepts it with or
// without a leading "Bearer " (see normalizeApiKey).

import { line } from '../model.js';
import { parseProviderLyrics } from '../formats/provider-payload.js';
import { withInstrumentalGaps } from '../postprocess.js';
import {
  isBlank, isObject, jsonContent, jsonLong, lyricsGet, lyricsGetAuthorized, lyricsGetBearer,
  nonBlank, parseJson, query, secondsOf,
} from './plumbing.js';

export const API = 'https://api.paxsenix.org';
export const PUBLIC_PROXY = 'https://lyrics.paxsenix.org';
export const APPLE_SEARCH = 'https://amp-api.music.apple.com/v1/catalog/us/search';
export const APPLE_TOKEN_PAGE = 'https://music.apple.com/us/new';

/** A candidate must score at least this to be used (PaxSenix.kt:23). */
export const MINIMUM_MATCH_SCORE = 10;

/** A word with nothing after it to end it runs this long (PaxSenix.kt:225). */
const LAST_WORD_MS = 800;

const APPLE_INDEX_SCRIPT = /\/assets\/index~[^"]+\.js/;
const APPLE_TOKEN = /eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/;

// Field names tried, in order, when reading a search candidate (PaxSenix.kt:330-333).
const ID_KEYS = ['id', 'trackId', 'track_id', 'realId'];
const TITLE_KEYS = ['name', 'title', 'trackName', 'track_name'];
const ARTIST_KEYS = ['artistName', 'artist_name'];
const DURATION_KEYS = ['durationInMillis', 'durationMs', 'duration_ms', 'duration'];
const ARTIST_NAME_KEYS = ['name', 'artistName', 'title'];

/**
 * The key as users paste it: trimmed, with a leading "Bearer " removed
 * (PaxSenix.kt:339-346).
 * @param {string|null|undefined} value
 */
export function normalizeApiKey(value) {
  const trimmed = String(value ?? '').trim();
  return /^bearer /i.test(trimmed) ? trimmed.slice(trimmed.indexOf(' ') + 1).trim() : trimmed;
}

/**
 * The three PaxSenix providers, sharing one Apple-token cache.
 * @param {{ apiKey?: string }} [options]  Default key when `ctx.keys.paxsenix` is not given.
 * @returns {import('../model.js').LyricsProvider[]}
 */
export function createPaxSenixProviders({ apiKey = '' } = {}) {
  const apple = { token: null, lock: Promise.resolve() };
  const keyFor = (ctx) => normalizeApiKey(nonBlank(ctx?.keys?.paxsenix) ?? apiKey);
  return [
    {
      id: 'paxsenix',
      label: 'PaxSenix',
      wordSynced: true,
      lyrics: (q, ctx) => appleLyrics(q, ctx, apple),
    },
    {
      id: 'paxsenix_spotify',
      label: 'PaxSenix: Spotify',
      wordSynced: false,
      lyrics: (q, ctx) => spotifyLyrics(q, ctx, keyFor(ctx)),
    },
    {
      id: 'paxsenix_musixmatch',
      label: 'PaxSenix: Musixmatch',
      wordSynced: true,
      lyrics: (q, ctx) => musixmatchLyrics(q, ctx, keyFor(ctx)),
    },
  ];
}

/** Default instances; the key comes from `ctx.keys.paxsenix`. */
export const providers = createPaxSenixProviders();

// ---------------------------------------------------------------------------
// Routes

/** PaxSenix.kt:36-50. The album is accepted by BitChord's signature but unused. */
async function appleLyrics(q, ctx, apple) {
  const id = await searchAppleTrackId(q, ctx, apple);
  if (id == null) return null;
  const body = await lyricsGet(ctx, `${PUBLIC_PROXY}/apple-music/lyrics?${query({ id, ttml: 'true' })}`);
  return body == null ? null : parseResponse(body);
}

/** PaxSenix.kt:52-62. */
async function spotifyLyrics(q, ctx, key) {
  if (key === '') return null;
  const id = await searchTrackId('spotify/search', q, ctx, key);
  if (id != null) {
    const body = await lyricsGetBearer(ctx, `${API}/lyrics/spotify?${query({ id })}`, key);
    const lines = body == null ? null : parseResponse(body);
    if (lines) return lines;
  }
  return genericAuthenticatedLyrics(q, ctx, key);
}

/** PaxSenix.kt:64-77. Matching is left to the server; `d` is sent even when 0. */
async function musixmatchLyrics(q, ctx, key) {
  if (key === '') return null;
  const url = `${API}/lyrics/musixmatch?${query({ t: q.title ?? '', a: q.artist ?? '', d: secondsOf(q.durationMs) })}`;
  const body = await lyricsGetBearer(ctx, url, key);
  const lines = body == null ? null : parseResponse(body);
  return lines ?? genericAuthenticatedLyrics(q, ctx, key);
}

/** The keyed catch-all: LRCLIB-style candidates, one of them chosen (PaxSenix.kt:123-132). */
async function genericAuthenticatedLyrics(q, ctx, key) {
  const body = await lyricsGetBearer(ctx, `${API}/lyrics/lrcget?${query({ q: `${q.title} ${q.artist}` })}`, key);
  return body == null ? null : parseLrcGet(body, q.title, q.artist, q.durationMs);
}

/** PaxSenix.kt:108-121. */
async function searchTrackId(path, q, ctx, key) {
  const body = await lyricsGetBearer(ctx, `${API}/${path}?${query({ q: `${q.title} ${q.artist}` })}`, key);
  const root = body == null ? undefined : parseJson(body);
  if (root === undefined) return null;
  return bestCandidate(root, q.title, q.artist, q.durationMs)?.id ?? null;
}

/** PaxSenix.kt:79-95. */
async function searchAppleTrackId(q, ctx, apple) {
  const token = await appleToken(ctx, apple);
  if (!token) return null;
  const url = `${APPLE_SEARCH}?${query({ term: `${q.title} ${q.artist}`, types: 'songs', limit: 10, l: 'en-US' })}`;
  const body = await lyricsGetAuthorized(ctx, url, token);
  const root = body == null ? undefined : parseJson(body);
  if (root === undefined) return null;
  return bestCandidate(root, q.title, q.artist, q.durationMs)?.id ?? null;
}

/**
 * The cached Apple token, or one scraped now (PaxSenix.kt:97-106). Scrapes
 * are serialised like BitChord's Mutex: a caller arriving mid-scrape waits
 * and then reuses the result. A failed scrape is not cached, so the next
 * lookup pays for it again; a cached token is never invalidated.
 */
function appleToken(ctx, apple) {
  if (apple.token) return Promise.resolve(apple.token);
  const attempt = apple.lock.then(async () => {
    if (apple.token) return apple.token;
    const token = await scrapeAppleToken(ctx);
    if (token) apple.token = token;
    return token;
  });
  apple.lock = attempt.catch(() => null);
  return attempt;
}

async function scrapeAppleToken(ctx) {
  const page = await lyricsGet(ctx, APPLE_TOKEN_PAGE);
  const scriptPath = page?.match(APPLE_INDEX_SCRIPT)?.[0];
  if (!scriptPath) return null;
  const script = await lyricsGet(ctx, `https://music.apple.com${scriptPath}`);
  return script?.match(APPLE_TOKEN)?.[0] ?? null;
}

// ---------------------------------------------------------------------------
// Response parsing

/** The structured payload first, then any other format (PaxSenix.kt:205-206). */
function parseResponse(raw) {
  return parseTimedApple(raw) ?? parseProviderLyrics(raw);
}

/**
 * PaxSenix's structured lyric JSON (PaxSenix.kt:208-236): the first `content`
 * array, anywhere in the document, holding rows with a `timestamp`:
 *
 *   { "content": [ { "timestamp": 1000, "text": [ { "text": "sing", "timestamp": 1000 }, … ] }, … ] }
 *
 * Timestamps are integer milliseconds. Only starts are read — any end times
 * or background/duet flags in the rows are ignored — so a word runs until
 * the next word starts, the last word of a row until the next row starts,
 * and the last word of the song for 800 ms. Each line's stated end is the
 * next row's start, which is why no instrumental break is ever marked
 * between two lines of this format (only the intro). Word timing is kept
 * only when every text entry of the row had one; entries are joined with
 * single spaces. Rows are not re-sorted.
 *
 * @param {string} raw
 * @returns {import('../model.js').LyricLine[]|null}
 */
export function parseTimedApple(raw) {
  const root = parseJson(raw);
  if (root === undefined) return null;
  const content = findTimedContent(root);
  if (!content) return null;
  const rows = content.filter(isObject);

  const lines = [];
  rows.forEach((row, index) => {
    const start = jsonLong(row.timestamp);
    if (start == null || !Array.isArray(row.text)) return;
    const wordRows = row.text;
    const texts = wordRows.filter(isObject).map((w) => jsonContent(w.text)).filter((t) => t != null);
    if (texts.length === 0) return;
    const nextLine = index + 1 < rows.length ? jsonLong(rows[index + 1].timestamp) : null;

    const timed = [];
    wordRows.forEach((element, wordIndex) => {
      if (!isObject(element)) return;
      const text = jsonContent(element.text)?.trim();
      if (!text) return;
      const wordStart = jsonLong(element.timestamp);
      if (wordStart == null) return;
      const following = wordRows[wordIndex + 1];
      const wordEnd = (isObject(following) ? jsonLong(following.timestamp) : null)
        ?? nextLine
        ?? wordStart + LAST_WORD_MS;
      timed.push({ startMs: wordStart, endMs: Math.max(wordEnd, wordStart), text });
    });

    lines.push(line(
      Math.min(start, timed[0]?.startMs ?? start),
      texts.map((t) => t.trim()).join(' '),
      timed.length === texts.length ? timed : [],
      { sungUntilMs: nextLine },
    ));
  });

  const withGaps = withInstrumentalGaps(lines);
  return withGaps.some((l) => l.text.trim() !== '') ? withGaps : null;
}

function findTimedContent(node) {
  if (Array.isArray(node)) {
    for (const value of node) {
      const found = findTimedContent(value);
      if (found) return found;
    }
    return null;
  }
  if (!isObject(node)) return null;
  const content = node.content;
  if (Array.isArray(content) && content.some((e) => isObject(e) && Object.hasOwn(e, 'timestamp'))) return content;
  for (const value of Object.values(node)) {
    const found = findTimedContent(value);
    if (found) return found;
  }
  return null;
}

/**
 * The lrcget fallback answers with candidate documents rather than one
 * (PaxSenix.kt:134-163); parsing the array as one document would concatenate
 * every candidate and restart the timestamps at zero for each. Each candidate
 * is parsed on its own and the best is kept, ranked by: metadata score, then
 * closeness of its last timestamp to the track length, then number of timed
 * lines, then number of word-synced lines. There is no minimum score here.
 * @returns {import('../model.js').LyricLine[]|null}
 */
export function parseLrcGet(raw, title, artist, durationMs) {
  const root = parseJson(raw);
  if (root === undefined) return null;
  const documents = isObject(root) && Array.isArray(root.lyrics) ? root.lyrics : [];
  if (documents.length === 0) return parseResponse(raw);

  let best = null;
  for (const document of documents) {
    const lines = parseResponse(JSON.stringify(document));
    if (!lines) continue;
    const candidate = {
      lines,
      metadataScore: isObject(document) ? documentScore(document, title, artist, durationMs) : 0,
      distance: durationDistance(lines, durationMs),
      timed: lines.filter((l) => l.timeMs > 0).length,
      wordSynced: lines.filter((l) => l.words.length > 0).length,
    };
    if (!best || compareDocuments(candidate, best) > 0) best = candidate;
  }
  return best?.lines ?? null;
}

function compareDocuments(a, b) {
  return (a.metadataScore - b.metadataScore)
    || (b.distance - a.distance) // NaN (both infinite) falls through, as a tie should
    || (a.timed - b.timed)
    || (a.wordSynced - b.wordSynced);
}

/** How far the lyrics' last timestamp is from the track's end (PaxSenix.kt:165-175). */
function durationDistance(lines, durationMs) {
  if (!(durationMs > 0)) return 0;
  if (lines.length === 0) return Infinity;
  let last = -Infinity;
  for (const l of lines) {
    last = Math.max(last, l.timeMs, l.sungUntilMs ?? 0);
    for (const w of l.words) last = Math.max(last, w.endMs);
  }
  return Math.abs(last - durationMs);
}

function documentScore(document, title, artist, durationMs) {
  const details = isObject(document.attributes) ? document.attributes : document;
  return scoreCandidate({
    id: firstString(document, ID_KEYS) ?? '',
    title: firstString(details, TITLE_KEYS) ?? '',
    artist: firstString(details, ARTIST_KEYS) ?? artistNames(details) ?? '',
    durationMs: toDurationMs(firstLong(details, DURATION_KEYS)),
  }, title, artist, durationMs);
}

// ---------------------------------------------------------------------------
// Candidate matching

/**
 * @typedef {{ id: string, title: string, artist: string, durationMs: number }} Candidate
 */

/**
 * The best-scoring search candidate, or null when none reaches
 * {@link MINIMUM_MATCH_SCORE} (PaxSenix.kt:192-203). Every JSON object
 * anywhere in the response that has an id and a title is a candidate — the
 * walk does not look at `type`, so nested album or artist objects compete too
 * (ties go to the first found, which is the enclosing track).
 * @param {unknown} root  Parsed search response.
 * @returns {Candidate|null}
 */
export function bestCandidate(root, title, artist, durationMs) {
  const candidates = [];
  collectCandidates(root, candidates);
  let best = null;
  let bestScore = -Infinity;
  for (const candidate of candidates) {
    const score = scoreCandidate(candidate, title, artist, durationMs);
    if (score > bestScore) {
      best = candidate;
      bestScore = score;
    }
  }
  return best && bestScore >= MINIMUM_MATCH_SCORE ? best : null;
}

/**
 * PaxSenix.kt:298-313. Title: 20 exact / 10 contained either way; artist:
 * 15 / 5 (case-insensitive); duration, when both are known: 10 within 3 s,
 * 5 within 10 s. At most 45.
 * @param {Candidate} candidate
 */
export function scoreCandidate(candidate, wantedTitle, wantedArtist, wantedDurationMs) {
  let score = textScore(candidate.title, wantedTitle, 20, 10) + textScore(candidate.artist, wantedArtist, 15, 5);
  if (wantedDurationMs > 0 && candidate.durationMs > 0) {
    const diff = Math.abs(candidate.durationMs - wantedDurationMs);
    score += diff < 3_000 ? 10 : diff < 10_000 ? 5 : 0;
  }
  return score;
}

function textScore(candidate, wanted, exact, partial) {
  if (isBlank(candidate) || isBlank(wanted)) return 0;
  const a = candidate.toLowerCase();
  const b = wanted.toLowerCase();
  if (a === b) return exact;
  return a.includes(b) || b.includes(a) ? partial : 0;
}

function collectCandidates(node, into) {
  if (Array.isArray(node)) {
    for (const value of node) collectCandidates(value, into);
    return;
  }
  if (!isObject(node)) return;
  const candidate = toCandidate(node);
  if (candidate) into.push(candidate);
  for (const value of Object.values(node)) collectCandidates(value, into);
}

/** PaxSenix.kt:259-265: fields from `attributes` when present (Apple's shape), else the object. */
function toCandidate(object) {
  const details = isObject(object.attributes) ? object.attributes : object;
  const id = firstString(object, ID_KEYS) ?? firstString(details, ID_KEYS);
  if (id == null) return null;
  const title = firstString(details, TITLE_KEYS);
  if (title == null) return null;
  const artist = firstString(details, ARTIST_KEYS) ?? artistNames(details) ?? '';
  return { id, title, artist, durationMs: toDurationMs(firstLong(details, DURATION_KEYS)) };
}

/** `artists` (or else `artist`) as a string, an object or an array of either (PaxSenix.kt:267-278). */
function artistNames(details) {
  const artists = Object.hasOwn(details, 'artists') ? details.artists : details.artist;
  if (Array.isArray(artists)) {
    const names = artists
      .map((a) => (isObject(a) ? firstString(a, ARTIST_NAME_KEYS) : jsonContent(a)))
      .filter((name) => name != null);
    return names.length > 0 && names.join(', ') !== '' ? names.join(', ') : null;
  }
  if (isObject(artists)) return firstString(artists, ARTIST_NAME_KEYS);
  return jsonContent(artists);
}

function firstString(object, keys) {
  for (const key of keys) {
    if (!Object.hasOwn(object, key)) continue;
    const value = jsonContent(object[key])?.trim();
    if (value) return value;
  }
  return null;
}

function firstLong(object, keys) {
  for (const key of keys) {
    if (!Object.hasOwn(object, key)) continue;
    const value = jsonLong(object[key]);
    if (value != null) return value;
  }
  return null;
}

/** Durations under 10 000 are taken as seconds, anything else as ms (PaxSenix.kt:292-296). */
function toDurationMs(value) {
  if (value == null || value <= 0) return 0;
  return value < 10_000 ? value * 1000 : value;
}
