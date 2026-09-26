// Musixmatch provider ('musixmatch').
//
// Mirrors BitChord (commit fe198ac):
//   app/src/main/java/com/music/bitchord/data/lyrics/Musixmatch.kt
//     lyrics, bestTrack, score, searchTrack, fetchSubtitle, fetchRichSync,
//     parseRichSyncBody, subtitleToLrc, signedGet, looksUnauthorized,
//     getToken/fetchToken, getSecret, sign
//   app/src/main/java/com/music/bitchord/data/lyrics/LyricGaps.kt (withInstrumentalGaps)
//
// Independent JavaScript re-implementation of the mechanism documented in
// BITCHORD_ENGINE_RESEARCH.md (BitChord itself is GPL-3.0).
//
// Flow (every API call is an HMAC-signed GET on https://apic.musixmatch.com/ws/1.1):
//   0. signing secret: scraped from the web client's Next.js `_app-*.js`
//      bundle (reversed base64 inside `from("...".split`), cached per process.
//      BitChord falls back to a secret compiled into the app; that value is NOT
//      reproduced here - pass it yourself as ctx.keys.musixmatchSigningSecret.
//   1. token.get(app_id, guid, format)          -> message.body.user_token (cached)
//   2. track.search(q_track, q_artist, ...)     -> best track by score()
//   3. track.richsync.get(track_id)             -> word timing, if has_richsync != 0
//   4. track.subtitle.get(track_id, mxm)        -> line timing fallback, if has_subtitles != 0
// A 401/402 inside the JSON envelope (or any failed call) drops both cached
// credentials, re-derives them once, and repeats the call once.

import { timeoutSignal, HttpError, qs } from '../../lib/http.js';
import { line } from '../model.js';
import { parseLrc, withInstrumentalGaps } from '../formats/lrc.js';

export const MUSIXMATCH_BASE = 'https://apic.musixmatch.com/ws/1.1';
export const MUSIXMATCH_APP_ID = 'mobile-app-v1.0';
export const MUSIXMATCH_SEARCH_PAGE = 'https://www.musixmatch.com/search';
export const MUSIXMATCH_BROWSER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// Musixmatch.kt builds its own client: callTimeout 8 s, connectTimeout 4 s.
const CALL_TIMEOUT_MS = 8_000;

const APP_SCRIPT = /src=["']([^"']*\/_next\/static\/chunks\/pages\/_app-[^"']+\.js)["']/i;
const ENCODED_SECRET = /from\(\s*["']([^"']+)["']\s*\.split/;

// ---- Per-process credential cache (AtomicReference + Mutex in Kotlin) -------

const session = { secret: null, token: null, guid: randomUuid() };
let tokenLock = Promise.resolve();

/** Forget the cached signing secret and user token (tests; account switches). */
export function resetMusixmatchSession() {
  session.secret = null;
  session.token = null;
  session.guid = randomUuid();
  tokenLock = Promise.resolve();
}

/** Run fn under a FIFO async lock - the Kotlin tokenMutex. */
async function withTokenLock(fn) {
  const previous = tokenLock;
  let release;
  tokenLock = new Promise((r) => { release = r; });
  await previous;
  try {
    return await fn();
  } finally {
    release();
  }
}

// ---- HTTP ---------------------------------------------------------------------

/** GET with the 8 s whole-call deadline; body on 2xx, else null. Cancellation propagates. */
async function requestText(ctx, url, accept, cookie) {
  const f = ctx?.fetch ?? globalThis.fetch;
  const { signal, done } = timeoutSignal(ctx?.signal, CALL_TIMEOUT_MS);
  const headers = {
    'User-Agent': MUSIXMATCH_BROWSER_AGENT,
    Accept: accept,
    'Accept-Language': 'en-US,en;q=0.9',
  };
  if (cookie) headers.Cookie = cookie;
  try {
    const res = await f(url, { headers, signal });
    const body = await res.text();
    if (!res.ok) throw new HttpError(res.status, url, body);
    return body;
  } catch (err) {
    if (ctx?.signal?.aborted) throw err;
    return null;
  } finally {
    done();
  }
}

const apiGet = (ctx, url) => requestText(ctx, url, 'application/json, text/plain, */*');
// The web pages are asked for with the A/B cookie the web client sets.
const browserGet = (ctx, url, accept) => requestText(ctx, url, accept, 'mxm_bab=AB');

const parseJson = (text) => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// ---- Signing ------------------------------------------------------------------

/**
 * Musixmatch.sign: HMAC-SHA256 over `<url><UTC yyyyMMdd>`, base64, appended as
 * `&signature=<urlencoded>&signature_protocol=sha256`. The URL is first
 * normalised so a space is "+", which is also the form that is sent.
 */
export function signMusixmatchUrl(url, secret, now = new Date()) {
  const normalized = url.replaceAll('%20', '+').replaceAll(' ', '+');
  const p2 = (n) => String(n).padStart(2, '0');
  const date = `${now.getUTCFullYear()}${p2(now.getUTCMonth() + 1)}${p2(now.getUTCDate())}`;
  const mac = hmacSha256(utf8Encode(secret), utf8Encode(normalized + date));
  // java.net.URLEncoder and encodeURIComponent agree on the base64 alphabet (+ / =).
  return `${normalized}&signature=${encodeURIComponent(base64Encode(mac))}&signature_protocol=sha256`;
}

/**
 * Musixmatch.getSecret: fetch /search, find the `_app-*.js` chunk, find
 * `from("<reversed base64>".split`, reverse, base64-decode.
 * @returns {Promise<string>} throws when any step fails.
 */
export async function scrapeMusixmatchSecret(ctx) {
  const page = await browserGet(ctx, MUSIXMATCH_SEARCH_PAGE, 'text/html,application/xhtml+xml');
  if (page == null) throw new Error('search page unavailable');
  const script = APP_SCRIPT.exec(page)?.[1];
  if (!script) throw new Error('application script not found');
  const scriptUrl = new URL(script, MUSIXMATCH_SEARCH_PAGE).toString();
  const javascript = await browserGet(ctx, scriptUrl, '*/*');
  if (javascript == null) throw new Error('application script unavailable');
  const encoded = ENCODED_SECRET.exec(javascript)?.[1];
  if (!encoded) throw new Error('signing key not found');
  const secret = utf8Decode(base64Decode([...encoded].reverse().join('')));
  if (secret.trim() === '') throw new Error('empty signing key');
  return secret;
}

/** Cached secret, else scraped, else ctx.keys.musixmatchSigningSecret; whichever is used is cached. */
async function getSecret(ctx) {
  if (session.secret) return session.secret;
  let secret = null;
  try {
    secret = await scrapeMusixmatchSecret(ctx);
  } catch (err) {
    if (ctx?.signal?.aborted) throw err;
  }
  secret ||= ctx?.keys?.musixmatchSigningSecret || null;
  if (secret) session.secret = secret;
  return secret;
}

/** Musixmatch.fetchToken: token.get, signed. */
async function fetchToken(ctx, secret) {
  const url = `${MUSIXMATCH_BASE}/token.get?${qs({ app_id: MUSIXMATCH_APP_ID, guid: session.guid, format: 'json' })}`;
  const body = await apiGet(ctx, signMusixmatchUrl(url, secret));
  if (body == null) return null;
  const token = parseJson(body)?.message?.body?.user_token;
  return typeof token === 'string' ? token : null;
}

/** Musixmatch.getToken: cached, else fetched once under the lock (double-checked). */
async function getToken(ctx, secret) {
  if (session.token) return session.token;
  return withTokenLock(async () => {
    if (session.token) return session.token;
    const token = await fetchToken(ctx, secret);
    if (token) session.token = token;
    return token;
  });
}

/** Musixmatch reports an expired token inside a 200: header.status_code 401 or 402. */
function looksUnauthorized(body) {
  const code = Number(parseJson(body)?.message?.header?.status_code);
  return code === 401 || code === 402;
}

/**
 * Musixmatch.signedGet: sign and issue buildUrl(token); on failure or an
 * auth error, drop both credentials, re-derive them once and retry once.
 */
async function signedGet(ctx, buildUrl) {
  let secret = await getSecret(ctx);
  if (!secret) return null;
  let token = await getToken(ctx, secret);
  if (!token) return null;
  const first = await apiGet(ctx, signMusixmatchUrl(buildUrl(token), secret));
  if (first != null && !looksUnauthorized(first)) return first;

  session.token = null;
  session.secret = null;
  secret = await getSecret(ctx);
  if (!secret) return null;
  token = await getToken(ctx, secret);
  if (!token) return null;
  return apiGet(ctx, signMusixmatchUrl(buildUrl(token), secret));
}

// ---- API calls ----------------------------------------------------------------

/** Musixmatch.searchTrack: up to 10 tracks that have lyrics. */
async function searchTrack(ctx, title, artist) {
  const body = await signedGet(ctx, (token) => `${MUSIXMATCH_BASE}/track.search?${qs({
    app_id: MUSIXMATCH_APP_ID,
    format: 'json',
    q_track: title,
    q_artist: artist,
    f_has_lyrics: '1',
    s_track_rating: 'desc',
    quorum_factor: '1',
    page_size: '10',
    page: '1',
    usertoken: token,
  })}`);
  if (body == null) return null;
  const payload = parseJson(body)?.message?.body;
  // An error envelope carries `"body": []`, which Kotlin fails to decode -> null.
  if (!isObject(payload)) return null;
  const list = Array.isArray(payload.track_list) ? payload.track_list : [];
  return list
    .map((wrapper) => wrapper?.track)
    .filter((t) => isObject(t) && t.track_id != null && typeof t.track_name === 'string');
}

async function fetchSubtitle(ctx, trackId) {
  const body = await signedGet(ctx, (token) => `${MUSIXMATCH_BASE}/track.subtitle.get?${qs({
    app_id: MUSIXMATCH_APP_ID,
    format: 'json',
    track_id: String(trackId),
    subtitle_format: 'mxm',
    usertoken: token,
  })}`);
  if (body == null) return null;
  const payload = parseJson(body)?.message?.body;
  const text = isObject(payload) && isObject(payload.subtitle) ? payload.subtitle.subtitle_body : null;
  return typeof text === 'string' ? text : null;
}

async function fetchRichSync(ctx, trackId) {
  const body = await signedGet(ctx, (token) => `${MUSIXMATCH_BASE}/track.richsync.get?${qs({
    app_id: MUSIXMATCH_APP_ID,
    format: 'json',
    track_id: String(trackId),
    usertoken: token,
  })}`);
  if (body == null) return null;
  const payload = parseJson(body)?.message?.body;
  const text = isObject(payload) && isObject(payload.richsync) ? payload.richsync.richsync_body : null;
  return typeof text === 'string' ? text : null;
}

// ---- Matching -----------------------------------------------------------------

/**
 * Musixmatch.score. Title: +80 exact, +40 containment either way. Artist:
 * +40 when the result's artist contains ours. Length (when present):
 * <=2 s +30, <=5 s +15, <=10 s +5, else -20. There is no minimum score: the
 * best of whatever came back is used.
 */
export function scoreMusixmatchTrack(track, title, artist, seconds) {
  let score = 0;
  const name = String(track.track_name ?? '').trim().toLowerCase();
  const target = String(title ?? '').trim().toLowerCase();
  if (name === target) score += 80;
  else if (name.includes(target) || target.includes(name)) score += 40;
  const trackArtist = String(track.artist_name ?? '').trim().toLowerCase();
  if (trackArtist.includes(String(artist ?? '').trim().toLowerCase())) score += 40;
  if (track.track_length != null && Number.isFinite(Number(track.track_length))) {
    const diff = Math.abs(Number(track.track_length) - seconds);
    if (diff <= 2) score += 30;
    else if (diff <= 5) score += 15;
    else if (diff <= 10) score += 5;
    else score -= 20;
  }
  return score;
}

async function bestTrack(ctx, title, artist, seconds) {
  const tracks = await searchTrack(ctx, title, artist);
  if (!tracks || tracks.length === 0) return null;
  let best = null;
  let bestScore = -Infinity;
  for (const t of tracks) {
    const s = scoreMusixmatchTrack(t, title, artist, seconds);
    if (s > bestScore) { // first maximum wins, like maxByOrNull
      best = t;
      bestScore = s;
    }
  }
  return best;
}

// ---- Payload parsing ----------------------------------------------------------

/** (seconds * 1000.0).toLong(): truncation toward zero, same IEEE doubles as the JVM. */
const secondsToMs = (s) => Math.trunc(Number(s) * 1000);
const isWs = (ch) => /\s/.test(ch);

/**
 * Musixmatch.parseRichSyncBody. The body is a JSON array of lines:
 *   { ts: lineStartSec, te: lineEndSec, x: lineText, l: [{ c: fragmentText, o: offsetSec }] }
 * Fragments are glued into words: a leading/trailing whitespace in a
 * fragment's text is a word boundary. Word starts are clamped monotonic;
 * each fragment ends at the next fragment's start (or the line end). The line
 * gets sungUntilMs = te when te > ts, then instrumental gaps are derived.
 * Any malformed entry fails the whole body (kotlinx decode semantics) -> [].
 */
export function parseRichSyncBody(body) {
  const entries = parseJson(body);
  if (!Array.isArray(entries)) return [];
  const num = (v) => (typeof v === 'number' || (typeof v === 'string' && v.trim() !== '')) && Number.isFinite(Number(v));
  const valid = entries.every((e) => isObject(e) && num(e.ts) && num(e.te)
    && (e.l === undefined || (Array.isArray(e.l) && e.l.every((f) => isObject(f) && typeof f.c === 'string' && num(f.o))))
    && (e.x === undefined || typeof e.x === 'string'));
  if (!valid) return [];

  const lines = [];
  for (const entry of entries) {
    const ts = Number(entry.ts);
    const lineStart = secondsToMs(ts);
    const lineEnd = Math.max(lineStart, secondsToMs(entry.te));
    const fragments = entry.l ?? [];
    const words = [];
    let current = '';
    let currentStart = lineStart;
    let currentEnd = lineStart;
    let previousStart = lineStart;

    const flush = () => {
      const text = current.trim();
      current = '';
      if (text !== '') words.push({ startMs: currentStart, endMs: Math.max(currentStart, currentEnd), text });
    };

    fragments.forEach((fragment, index) => {
      const raw = fragment.c;
      if (raw === '') return;
      const start = Math.max(lineStart, previousStart, secondsToMs(ts + Number(fragment.o)));
      const nextFragment = fragments[index + 1];
      const next = nextFragment ? secondsToMs(ts + Number(nextFragment.o)) : lineEnd;
      const end = Math.max(start, Math.min(lineEnd, next));
      previousStart = start;

      if (isWs(raw[0])) flush();
      const content = raw.trim();
      if (content !== '') {
        if (current === '') currentStart = start;
        current += content;
        currentEnd = end;
      }
      if (isWs(raw[raw.length - 1])) flush();
    });
    flush();

    const text = String(entry.x ?? '').trim() || words.map((w) => w.text).join(' ');
    if (text === '') continue;
    lines.push(line(Math.min(lineStart, words[0]?.startMs ?? lineStart), text, words, {
      sungUntilMs: lineEnd > lineStart ? lineEnd : null,
    }));
  }
  return withInstrumentalGaps(lines.sort((a, b) => a.timeMs - b.timeMs));
}

/**
 * Musixmatch.subtitleToLrc: the `mxm` subtitle body is a JSON array of
 * { text, time: { total: seconds, minutes, seconds, hundredths } }. Blank
 * texts (Musixmatch's instrumental markers) are skipped, so breaks survive
 * only as far as parseLrc() re-derives them. Stamps are [mm:ss.mmm].
 */
export function subtitleToLrc(subtitleBody) {
  const rows = parseJson(subtitleBody);
  if (!Array.isArray(rows)) return '';
  if (!rows.every((r) => isObject(r) && typeof r.text === 'string' && isObject(r.time) && Number.isFinite(Number(r.time.total)))) {
    return '';
  }
  const out = [];
  for (const r of rows) {
    if (r.text.trim() === '') continue;
    const totalMs = secondsToMs(r.time.total);
    const minutes = Math.trunc(totalMs / 1000 / 60);
    const seconds = Math.trunc(totalMs / 1000) % 60;
    const millis = totalMs % 1000;
    const p = (n, w) => String(n).padStart(w, '0');
    out.push(`[${p(minutes, 2)}:${p(seconds, 2)}.${p(millis, 3)}]${r.text}`);
  }
  return out.join('\n').trim();
}

// ---- Provider -----------------------------------------------------------------

/** `Int? != 0`: an absent flag counts as "maybe", so the call is tried. */
const mayHave = (flag) => flag == null || Number(flag) !== 0;

/** @type {import('../model.js').LyricsProvider['lyrics']} */
async function lyrics(query, ctx = {}) {
  try {
    const title = String(query.title ?? '');
    const artist = String(query.artist ?? '');
    const seconds = Math.trunc((query.durationMs ?? 0) / 1000);
    const track = await bestTrack(ctx, title, artist, seconds);
    if (!track) return null;

    // Prefer the separate rich-sync tier so syllable data is not flattened.
    if (mayHave(track.has_richsync)) {
      const rich = await fetchRichSync(ctx, track.track_id);
      if (rich != null) {
        const lines = parseRichSyncBody(rich);
        if (lines.some((l) => l.words.length > 0)) return lines;
      }
    }

    // Only the chosen track is tried; a lower-scoring one with sync is never consulted.
    const subtitle = mayHave(track.has_subtitles) ? await fetchSubtitle(ctx, track.track_id) : null;
    const lrc = subtitle != null ? subtitleToLrc(subtitle) : '';
    if (lrc.trim() === '') return null;
    const lines = parseLrc(lrc);
    return lines.length > 0 ? lines : null;
  } catch (err) {
    if (ctx.signal?.aborted) throw err;
    return null;
  }
}

export const providers = [
  // BitChord's LyricsSource.MUSIXMATCH declares wordSynced = false, but
  // Musixmatch.kt returns rich-sync word timing whenever the track has it, so
  // the capability flag here is true.
  { id: 'musixmatch', label: 'Musixmatch', wordSynced: true, lyrics },
];

// ---- Dependency-free primitives (kept local so this file stands alone) ------

function randomUuid() {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  const b = new Uint8Array(16);
  if (c && typeof c.getRandomValues === 'function') c.getRandomValues(b);
  else for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** UTF-8 encode (handles surrogate pairs; lone surrogates become U+FFFD). */
export function utf8Encode(str) {
  if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(str);
  const out = [];
  for (const ch of String(str)) {
    let cp = ch.codePointAt(0);
    if (cp >= 0xd800 && cp <= 0xdfff) cp = 0xfffd;
    if (cp < 0x80) out.push(cp);
    else if (cp < 0x800) out.push(0xc0 | (cp >> 6), 0x80 | (cp & 63));
    else if (cp < 0x10000) out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
    else out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 63), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
  }
  return Uint8Array.from(out);
}

/** UTF-8 decode with U+FFFD for malformed input (java String(bytes, UTF_8) behaviour). */
export function utf8Decode(bytes) {
  if (typeof TextDecoder !== 'undefined') return new TextDecoder('utf-8').decode(bytes);
  let out = '';
  let i = 0;
  while (i < bytes.length) {
    const b = bytes[i];
    if (b < 0x80) {
      out += String.fromCharCode(b);
      i += 1;
      continue;
    }
    // Continuation-byte count from the lead byte; 0 = not a valid lead byte.
    const need = b >= 0xc2 && b <= 0xdf ? 1 : b >= 0xe0 && b <= 0xef ? 2 : b >= 0xf0 && b <= 0xf4 ? 3 : 0;
    let cp = need === 1 ? b & 0x1f : need === 2 ? b & 0x0f : b & 0x07;
    let ok = need > 0 && i + need < bytes.length;
    for (let k = 1; ok && k <= need; k++) {
      const c = bytes[i + k];
      if ((c & 0xc0) !== 0x80) ok = false;
      else cp = (cp << 6) | (c & 0x3f);
    }
    const min = need === 1 ? 0x80 : need === 2 ? 0x800 : 0x10000;
    if (!ok || cp < min || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) {
      out += '�';
      i += 1;
      continue;
    }
    out += String.fromCodePoint(cp);
    i += need + 1;
  }
  return out;
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Standard base64 with padding (java.util.Base64.getEncoder()). */
export function base64Encode(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63];
    out += i + 1 < bytes.length ? B64[(n >> 6) & 63] : '=';
    out += i + 2 < bytes.length ? B64[n & 63] : '=';
  }
  return out;
}

/**
 * Strict standard base64 (java.util.Base64.getDecoder()): padding optional,
 * any character outside the alphabet - whitespace included - is an error.
 */
export function base64Decode(str) {
  const s = String(str).replace(/={1,2}$/, '');
  if (s.length % 4 === 1 || /[^A-Za-z0-9+/]/.test(s)) throw new Error('invalid base64');
  const out = new Uint8Array(Math.floor((s.length * 3) / 4));
  let acc = 0;
  let bits = 0;
  let o = 0;
  for (const ch of s) {
    acc = (acc << 6) | B64.indexOf(ch);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (acc >> bits) & 0xff;
    }
  }
  return out;
}

const K256 = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

/** SHA-256 (FIPS 180-4) of a byte array. */
export function sha256(bytes) {
  const h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const length = bytes.length;
  const padded = new Uint8Array((((length + 9) + 63) >> 6) << 6);
  padded.set(bytes);
  padded[length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor(length / 0x20000000));
  view.setUint32(padded.length - 4, (length << 3) >>> 0);
  const w = new Uint32Array(64);
  const rotr = (x, n) => (x >>> n) | (x << (32 - n));
  for (let off = 0; off < padded.length; off += 64) {
    for (let t = 0; t < 16; t++) w[t] = view.getUint32(off + t * 4);
    for (let t = 16; t < 64; t++) {
      const s0 = rotr(w[t - 15], 7) ^ rotr(w[t - 15], 18) ^ (w[t - 15] >>> 3);
      const s1 = rotr(w[t - 2], 17) ^ rotr(w[t - 2], 19) ^ (w[t - 2] >>> 10);
      w[t] = (w[t - 16] + s0 + w[t - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, hh] = h;
    for (let t = 0; t < 64; t++) {
      const t1 = (hh + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K256[t] + w[t]) >>> 0;
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
      hh = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    h[0] += a; h[1] += b; h[2] += c; h[3] += d; h[4] += e; h[5] += f; h[6] += g; h[7] += hh;
  }
  const out = new Uint8Array(32);
  const outView = new DataView(out.buffer);
  for (let i = 0; i < 8; i++) outView.setUint32(i * 4, h[i]);
  return out;
}

/** HMAC-SHA256 (RFC 2104). */
export function hmacSha256(key, message) {
  const k = new Uint8Array(64);
  k.set(key.length > 64 ? sha256(key) : key);
  const inner = new Uint8Array(64 + message.length);
  const outer = new Uint8Array(64 + 32);
  for (let i = 0; i < 64; i++) {
    inner[i] = k[i] ^ 0x36;
    outer[i] = k[i] ^ 0x5c;
  }
  inner.set(message, 64);
  outer.set(sha256(inner), 64);
  return sha256(outer);
}
