// YouTube providers, keyed on query.videoId:
//   'youtube_transcript'  timed captions from InnerTube get_transcript (line-synced)
//   'youtube_music'       the YouTube Music player's "Lyrics" tab (plain)
//
// Mirrors BitChord (commit fe198ac):
//   app/src/main/java/com/music/bitchord/data/lyrics/YouTubeLyrics.kt
//     YouTubeMusicLyrics, YouTubeTranscriptLyrics, objectsNamed, youtubeStrings
//   app/src/main/java/com/music/bitchord/data/innertube/Innertube.kt
//     postMusic (headers, context), next, browse, transcript, withRetry,
//     WEB_REMIX_VERSION / WEB_REMIX_CLIENT_ID, HttpTimeout
//
// Independent JavaScript re-implementation of the mechanism documented in
// BITCHORD_ENGINE_RESEARCH.md (BitChord itself is GPL-3.0).
//
// Every call is POST https://music.youtube.com/youtubei/v1/<endpoint>?prettyPrint=false&hl=<hl>
// as the WEB_REMIX client (X-YouTube-Client-Name 67), anonymously: BitChord
// adds Cookie / SAPISIDHASH / X-Goog-AuthUser / X-Goog-PageId and
// context.user.onBehalfOfUser only for a signed-in user, which is out of
// scope here. No API key is sent.
//
// Browsers forbid setting Origin/Referer (and silently drop them); Node and
// React Native send them as given.

import { timeoutSignal, HttpError, qs } from '../../lib/http.js';
import { line } from '../model.js';

export const MUSIC_BASE = 'https://music.youtube.com/youtubei/v1';
export const MUSIC_ORIGIN = 'https://music.youtube.com';
/** Innertube.kt fallback; BitChord replaces it with the live INNERTUBE_CLIENT_VERSION only when signed in. */
export const WEB_REMIX_VERSION = '1.20250101.01.00';
export const WEB_REMIX_CLIENT_ID = '67';

// Ktor HttpTimeout in Innertube.kt: request 30 s, connect 15 s, socket 20 s.
const REQUEST_TIMEOUT_MS = 30_000;
// Innertube.withRetry: 3 attempts for transport failures only, backoff 500 ms then 1 s.
const RETRY_ATTEMPTS = 3;
const FIRST_BACKOFF_MS = 500;

const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/;

/**
 * Per-process InnerTube state. BitChord mints visitorData deliberately
 * (www.youtube.com/sw.js_data) elsewhere; here it is only picked up from the
 * first response's responseContext, as postMusic() also does.
 */
const session = { visitorData: null };

/** Forget the captured visitor id (tests). */
export function resetInnertubeSession() {
  session.visitorData = null;
}

/** Innertube.acceptLanguageHeader. */
const acceptLanguage = (hl) => (hl === 'en' ? 'en-US,en;q=0.9' : `${hl},en-US;q=0.8,en;q=0.7`);

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) return reject(signal.reason ?? new Error('aborted'));
  const timer = setTimeout(() => {
    signal?.removeEventListener('abort', onAbort);
    resolve();
  }, ms);
  const onAbort = () => {
    clearTimeout(timer);
    reject(signal.reason ?? new Error('aborted'));
  };
  signal?.addEventListener('abort', onAbort, { once: true });
});

/**
 * Innertube.withRetry: a transport failure (connection reset etc.) is retried;
 * an HTTP status, an unparseable body, the app's own timeout, or a caller
 * cancellation is not.
 */
async function withRetry(ctx, block) {
  let backoff = FIRST_BACKOFF_MS;
  for (let attempt = 1; ; attempt++) {
    try {
      return await block();
    } catch (err) {
      const timedOut = err?.name === 'AbortError' || err?.name === 'TimeoutError' || /^timeout after/.test(err?.message ?? '');
      const retryable = !(err instanceof HttpError) && !(err instanceof SyntaxError) && !timedOut && !ctx?.signal?.aborted;
      if (!retryable || attempt >= RETRY_ATTEMPTS) throw err;
    }
    await sleep(backoff, ctx?.signal);
    backoff *= 2;
  }
}

/**
 * Innertube.postMusic (anonymous path). Optional overrides:
 * ctx.innertube = { hl = 'en', clientVersion, visitorData }.
 */
export async function postMusic(ctx, endpoint, extras) {
  const opts = ctx?.innertube ?? {};
  const hl = opts.hl ?? 'en';
  const clientVersion = opts.clientVersion ?? WEB_REMIX_VERSION;
  const visitorData = opts.visitorData ?? session.visitorData;

  const url = `${MUSIC_BASE}/${endpoint}?${qs({ prettyPrint: 'false', hl })}`;
  const headers = {
    'Content-Type': 'application/json',
    'Accept-Language': acceptLanguage(hl),
    'X-Origin': MUSIC_ORIGIN,
    Origin: MUSIC_ORIGIN,
    Referer: `${MUSIC_ORIGIN}/`,
    'X-YouTube-Client-Name': WEB_REMIX_CLIENT_ID,
    'X-YouTube-Client-Version': clientVersion,
  };
  if (visitorData) headers['X-Goog-Visitor-Id'] = visitorData;
  const client = { clientName: 'WEB_REMIX', clientVersion, hl, gl: 'US' };
  if (visitorData) client.visitorData = visitorData;
  const body = JSON.stringify({
    context: { client, user: { lockedSafetyMode: false }, request: { useSsl: true } },
    ...extras,
  });

  const json = await withRetry(ctx, async () => {
    const f = ctx?.fetch ?? globalThis.fetch;
    const { signal, done } = timeoutSignal(ctx?.signal, REQUEST_TIMEOUT_MS);
    try {
      const res = await f(url, { method: 'POST', headers, body, signal });
      const text = await res.text();
      if (!res.ok) throw new HttpError(res.status, url, text); // Ktor expectSuccess = true
      return JSON.parse(text);
    } finally {
      done();
    }
  });
  if (!session.visitorData && typeof json?.responseContext?.visitorData === 'string') {
    session.visitorData = json.responseContext.visitorData;
  }
  return json;
}

// ---- JSON walking (YouTubeLyrics.kt) ------------------------------------------

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** objectsNamed: every object stored under key `name`, anywhere, in document order. */
export function* objectsNamed(element, name) {
  if (Array.isArray(element)) {
    for (const v of element) yield* objectsNamed(v, name);
  } else if (isObject(element)) {
    for (const [key, value] of Object.entries(element)) {
      if (key === name && isObject(value)) yield value;
      yield* objectsNamed(value, name);
    }
  }
}

const first = (iterable) => {
  for (const v of iterable) return v;
  return undefined;
};

/**
 * youtubeStrings: the visible strings of a YouTube text object. An object
 * with a primitive `text` or `simpleText` yields just that; otherwise every
 * value is walked. JSON null yields nothing.
 */
export function youtubeStrings(element) {
  if (element === null || element === undefined) return [];
  if (Array.isArray(element)) return element.flatMap(youtubeStrings);
  if (isObject(element)) {
    const primitive = (v) => v !== null && v !== undefined && typeof v !== 'object';
    if (primitive(element.text)) return [String(element.text)];
    if (primitive(element.simpleText)) return [String(element.simpleText)];
    return Object.values(element).flatMap(youtubeStrings);
  }
  return [String(element)];
}

/** Kotlin String.trim(vararg chars): only these characters, from both ends. */
function trimChars(s, chars) {
  let start = 0;
  let end = s.length;
  while (start < end && chars.includes(s[start])) start++;
  while (end > start && chars.includes(s[end - 1])) end--;
  return s.slice(start, end);
}

/** JsonPrimitive.longOrNull: an integer given as a JSON number or a numeric string. */
function longOrNull(v) {
  if (v === null || v === undefined || typeof v === 'object') return null;
  const s = String(v);
  return /^[+-]?\d+$/.test(s) ? Number(s) : null;
}

// ---- Transcript ---------------------------------------------------------------

/**
 * Innertube.transcript params: a hand-built protobuf, field 1 (wire type 2)
 * = the video id - bytes 0x0A, len, id - then standard base64 with padding.
 */
export function transcriptParams(videoId) {
  const id = [...new TextEncoder().encode(videoId)];
  return base64Encode(Uint8Array.from([0x0a, id.length & 0xff, ...id]));
}

/** YouTubeTranscriptLyrics.lyrics body: transcriptCueRenderer -> line-synced lines. */
export function parseTranscript(response) {
  const lines = [];
  for (const cue of objectsNamed(response, 'transcriptCueRenderer')) {
    const start = longOrNull(cue.startOffsetMs);
    if (start === null) continue;
    // durationMs is present on every cue but ignored, so no sungUntilMs.
    const text = trimChars(youtubeStrings(cue.cue).join(''), [' ', '\n', '♪']);
    if (text !== '') lines.push(line(start, text));
  }
  lines.sort((a, b) => a.timeMs - b.timeMs);
  return lines.length > 0 ? lines : null;
}

/** @type {import('../model.js').LyricsProvider['lyrics']} */
async function transcriptLyrics(query, ctx = {}) {
  const videoId = query.videoId;
  if (typeof videoId !== 'string' || !YOUTUBE_ID.test(videoId)) return null;
  try {
    const response = await postMusic(ctx, 'get_transcript', { params: transcriptParams(videoId) });
    return parseTranscript(response);
  } catch (err) {
    if (ctx.signal?.aborted) throw err;
    return null;
  }
}

// ---- YouTube Music "Lyrics" tab -------------------------------------------------

/**
 * Which browseEndpoint the Lyrics tab points at, from a `next` response.
 *
 * BitChord: the first tabRenderer with any string equal (ignoring case) to
 * "Lyrics", else the first browseEndpoint among tabRenderers[1..]. That
 * fallback exists for localised tab titles, but it also fires when the
 * Lyrics tab is present without an endpoint (a track with no lyrics), and
 * can then land on the "Related" tab, whose page may itself hold a
 * musicDescriptionShelfRenderer ("About the artist") that BitChord would
 * return as lyrics.
 *
 * Deviation: the positional fallback here only looks at tabRenderers[1],
 * the Lyrics tab's slot, and never further.
 */
export function lyricsBrowseEndpoint(next) {
  const tabs = [...objectsNamed(next, 'tabRenderer')];
  const titled = tabs.find((tab) => youtubeStrings(tab).some((t) => t.toLowerCase() === 'lyrics'));
  const endpoint = titled ? first(objectsNamed(titled, 'browseEndpoint')) : undefined;
  if (endpoint) return endpoint;
  return tabs[1] ? first(objectsNamed(tabs[1], 'browseEndpoint')) ?? null : null;
}

/** YouTubeMusicLyrics.lyrics body: first musicDescriptionShelfRenderer's description -> plain lines. */
export function parseLyricsShelf(page) {
  const shelf = first(objectsNamed(page, 'musicDescriptionShelfRenderer'));
  if (!shelf) return null;
  const text = (shelf.description === undefined ? [] : youtubeStrings(shelf.description)).join('').trim();
  const lines = text.split(/\r\n|\r|\n/).map((t) => t.trim()).filter((t) => t !== '').map((t) => line(0, t));
  return lines.length > 0 ? lines : null;
}

/** @type {import('../model.js').LyricsProvider['lyrics']} */
async function youtubeMusicLyrics(query, ctx = {}) {
  const videoId = query.videoId;
  if (typeof videoId !== 'string' || !YOUTUBE_ID.test(videoId)) return null;
  try {
    // Innertube.next: the watch-next ("RDAMVM" radio) response carries the tabs.
    const next = await postMusic(ctx, 'next', { videoId, playlistId: `RDAMVM${videoId}`, isAudioOnly: true });
    const endpoint = lyricsBrowseEndpoint(next);
    const browseId = endpoint && typeof endpoint.browseId === 'string' ? endpoint.browseId : null;
    if (!browseId) return null;
    const extras = { browseId };
    if (typeof endpoint.params === 'string') extras.params = endpoint.params;
    const page = await postMusic(ctx, 'browse', extras);
    return parseLyricsShelf(page);
  } catch (err) {
    if (ctx.signal?.aborted) throw err;
    return null;
  }
}

export const providers = [
  { id: 'youtube_transcript', label: 'YouTube captions', wordSynced: false, lyrics: transcriptLyrics },
  { id: 'youtube_music', label: 'YouTube Music', wordSynced: false, lyrics: youtubeMusicLyrics },
];

// ---- base64 (kept local so this file stands alone) ------------------------------

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function base64Encode(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63];
    out += i + 1 < bytes.length ? B64[(n >> 6) & 63] : '=';
    out += i + 2 < bytes.length ? B64[n & 63] : '=';
  }
  return out;
}
