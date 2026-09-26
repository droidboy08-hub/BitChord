// KuGou provider ('kugou').
//
// Mirrors BitChord (commit fe198ac):
//   app/src/main/java/com/music/bitchord/data/lyrics/KuGou.kt
//     lyrics, searchSongs, searchLyrics, download, keyword, stripParenthetical, stripCredits
//   app/src/main/java/com/music/bitchord/data/lyrics/LyricsHttp.kt  lyricsGet (6 s deadline, headers)
//
// Independent JavaScript re-implementation of the mechanism documented in
// BITCHORD_ENGINE_RESEARCH.md (BitChord itself is GPL-3.0).
//
// Three unauthenticated GETs, chained:
//   1. mobileservice.kugou.com/api/v3/search/song   keyword -> song hashes,
//      kept only within +/-8 s of the playing track, closest first
//   2. lyrics.kugou.com/search                      hash -> lyric candidates
//      (tried hash by hash, first candidate of the first hash that has one);
//      if no hash yields one: the same endpoint by keyword (+ duration in ms)
//   3. lyrics.kugou.com/download?fmt=lrc            id + accesskey -> JSON whose
//      `content` is base64 of plain UTF-8 LRC.
//
// Payload: BitChord asks for fmt=lrc, so the download is base64(LRC) and
// nothing more. It never requests fmt=krc and has no KRC decoder (no XOR key,
// no zlib), so this file needs neither.
//
// Deviation: stripKugouCredits() caps its head/tail windows at half the file
// by default; BitChord's windows cover the whole of a short file and can
// delete an entire song. { bitchordCompat: true } reproduces BitChord exactly.

import { timeoutSignal, HttpError, qs } from '../../lib/http.js';
import { parseLrc } from '../formats/lrc.js';

export const KUGOU_DURATION_TOLERANCE_SECONDS = 8;
const LYRICS_TIMEOUT_MS = 6_000; // LyricsHttp.kt: callTimeout 6 s (connect 3 s)
const LYRICS_AGENT = 'BitChord (https://github.com/bitchord)';

const SEARCH_SONG = 'https://mobileservice.kugou.com/api/v3/search/song';
const SEARCH_LYRICS = 'https://lyrics.kugou.com/search';
const DOWNLOAD = 'https://lyrics.kugou.com/download';

/** OkHttp's addQueryParameter encoding: form encoding, but a space is %20. */
const okhttpQuery = (params) => qs(params).replace(/\+/g, '%20');

/** LyricsHttp.lyricsGet: body of a 2xx, null for any failure; cancellation propagates. */
async function lyricsGet(ctx, url) {
  const f = ctx?.fetch ?? globalThis.fetch;
  const { signal, done } = timeoutSignal(ctx?.signal, LYRICS_TIMEOUT_MS);
  try {
    const res = await f(url, { headers: { 'User-Agent': LYRICS_AGENT, Accept: 'application/json' }, signal });
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

const parseJson = (text) => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isScalar = (v) => typeof v === 'string' || typeof v === 'number';

/** KuGou.stripParenthetical: drop (...) and full-width （...） runs; keep the original if nothing is left. */
function stripParenthetical(s) {
  const out = s.replace(/[(（].*?[)）]/g, '').trim();
  return out === '' ? s : out;
}

/** KuGou.keyword: "<title> - <artist>[ <album>]". */
export function kugouKeyword(title, artist, album) {
  let k = `${stripParenthetical(String(title ?? ''))} - ${stripParenthetical(String(artist ?? ''))}`;
  if (album != null && String(album).trim() !== '') k += ` ${album}`;
  return k;
}

/** Step 1 (KuGou.searchSongs): hashes within tolerance, closest duration first. */
async function searchSongs(ctx, keyword, seconds) {
  const url = `${SEARCH_SONG}?${okhttpQuery({ version: '9108', plat: '0', pagesize: '8', showtype: '0', keyword })}`;
  const body = await lyricsGet(ctx, url);
  if (body == null) return null;
  const json = parseJson(body);
  if (!isObject(json)) return null;
  const info = isObject(json.data) && Array.isArray(json.data.info) ? json.data.info : [];
  // kotlinx decodes Info(hash: String, duration: Int = -1): one bad entry fails the list.
  if (!info.every((i) => isObject(i) && isScalar(i.hash))) return null;
  return info
    .map((i) => ({ hash: String(i.hash), duration: Number.isFinite(Number(i.duration)) && i.duration !== null ? Math.trunc(Number(i.duration)) : -1 }))
    .filter((i) => seconds <= 0 || Math.abs(i.duration - seconds) <= KUGOU_DURATION_TOLERANCE_SECONDS)
    .sort((a, b) => Math.abs(a.duration - seconds) - Math.abs(b.duration - seconds))
    .map((i) => i.hash);
}

/** Step 2 (KuGou.searchLyrics): by hash, or by keyword (+ duration in milliseconds). */
async function searchLyrics(ctx, { hash, keyword, seconds = -1 }) {
  const params = { ver: '1', man: 'yes', client: 'pc' };
  if (hash != null) params.hash = hash;
  else if (keyword != null) {
    params.keyword = keyword;
    if (seconds > 0) params.duration = String(seconds * 1000);
  } else return null;
  const body = await lyricsGet(ctx, `${SEARCH_LYRICS}?${okhttpQuery(params)}`);
  if (body == null) return null;
  const json = parseJson(body);
  if (!isObject(json)) return null;
  const candidates = Array.isArray(json.candidates) ? json.candidates : [];
  // Candidate(id: String, accesskey: String) are both required.
  if (!candidates.every((c) => isObject(c) && isScalar(c.id) && isScalar(c.accesskey))) return null;
  return candidates.map((c) => ({ id: String(c.id), accesskey: String(c.accesskey) }));
}

/** Step 3 (KuGou.download): JSON { content: base64(UTF-8 LRC) } -> credit-stripped LRC. */
async function download(ctx, id, accesskey) {
  const url = `${DOWNLOAD}?${okhttpQuery({ fmt: 'lrc', charset: 'utf8', client: 'pc', ver: '1', id, accesskey })}`;
  const body = await lyricsGet(ctx, url);
  if (body == null) return null;
  const json = parseJson(body);
  if (!isObject(json)) return null;
  let decoded;
  try {
    decoded = decodeKugouContent(typeof json.content === 'string' ? json.content : '');
  } catch {
    return null;
  }
  return stripKugouCredits(decoded);
}

/** base64 -> UTF-8 text, strict like java.util.Base64.getDecoder(). */
export function decodeKugouContent(content) {
  return utf8Decode(base64Decode(content));
}

/** The inverse, for fixtures: what lyrics.kugou.com/download?fmt=lrc puts in `content`. */
export function encodeKugouContent(lrc) {
  return base64Encode(new TextEncoder().encode(lrc));
}

const STAMPED = /^\[\d{2}:\d{2}\.\d{2,3}\].*$/;
const CREDIT = /^.+\][^[]+[:：].+$/;

/**
 * KuGou.stripCredits. Keeps only lines that start with a [mm:ss.xx] stamp
 * (metadata and [offset:] vanish here), then:
 *  - head: finds the LAST "label: value" line (ASCII or full-width colon
 *    after the stamp) in the head window and drops everything up to and
 *    including it - which also takes the "Title - Artist" line above it;
 *  - tail: finds the credit line NEAREST THE END in the tail window and drops
 *    it and everything after it. (Not symmetric with the head: a trailing
 *    block of two credit lines loses only the last one. Kept as-is.)
 *
 * Window size. BitChord uses min(30, lastIndex) for both windows, so for a
 * file of 31 or fewer stamped lines the head window IS the whole file: the
 * last colon-bearing line anywhere - a trailing "Mixed by: X", or a lyric like
 * "Rule one: listen" - deletes every line before it, and a trailing credit
 * deletes the entire song. Deviation (default): each window is also capped at
 * half the lines, so the two windows can never span the whole song. Pass
 * { bitchordCompat: true } for the exact Kotlin behaviour.
 *
 * @param {string} text
 * @param {{ bitchordCompat?: boolean }} [options]
 */
export function stripKugouCredits(text, { bitchordCompat = false } = {}) {
  const lines = String(text).split(/\r\n|\r|\n/).filter((l) => STAMPED.test(l));
  if (lines.length === 0) return '';
  const windowEnd = (lastIndex) => Math.min(30, bitchordCompat ? lastIndex : Math.floor(lastIndex / 2));
  const headLimit = windowEnd(lines.length - 1);
  let headCut = 0;
  for (let i = headLimit; i >= 0; i--) {
    if (CREDIT.test(lines[i])) {
      headCut = i + 1;
      break;
    }
  }
  const body = lines.slice(headCut);
  const tailLimit = windowEnd(body.length - 1);
  let tailCut = 0;
  for (let i = 0; i <= tailLimit; i++) {
    if (CREDIT.test(body[body.length - 1 - i])) {
      tailCut = i + 1;
      break;
    }
  }
  return body.slice(0, body.length - tailCut).join('\n');
}

/** @type {import('../model.js').LyricsProvider['lyrics']} */
async function lyrics(query, ctx = {}) {
  try {
    const keyword = kugouKeyword(query.title, query.artist, query.album);
    const seconds = Math.trunc((query.durationMs ?? 0) / 1000);

    let candidate = null;
    // Sequential on purpose (as in Kotlin's firstNotNullOfOrNull): up to 8
    // lyric searches, one per hash, stopping at the first with a candidate.
    for (const hash of (await searchSongs(ctx, keyword, seconds)) ?? []) {
      candidate = (await searchLyrics(ctx, { hash }))?.[0] ?? null;
      if (candidate) break;
    }
    if (!candidate) candidate = (await searchLyrics(ctx, { keyword, seconds }))?.[0] ?? null;
    if (!candidate) return null;

    const lrc = await download(ctx, candidate.id, candidate.accesskey);
    if (lrc == null) return null;
    const lines = parseLrc(lrc);
    return lines.length > 0 ? lines : null;
  } catch (err) {
    if (ctx.signal?.aborted) throw err;
    return null;
  }
}

export const providers = [
  { id: 'kugou', label: 'KuGou', wordSynced: false, lyrics },
];

// ---- Dependency-free byte helpers (kept local so this file stands alone) -----

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

/** Strict: padding optional, anything outside A-Z a-z 0-9 + / (whitespace too) throws. */
function base64Decode(str) {
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

/** UTF-8 with U+FFFD for malformed input (Java's String(bytes, UTF_8)). */
function utf8Decode(bytes) {
  if (typeof TextDecoder !== 'undefined') return new TextDecoder('utf-8').decode(bytes);
  // Minimal fallback for runtimes without TextDecoder (older Hermes).
  let out = '';
  let i = 0;
  while (i < bytes.length) {
    const b = bytes[i];
    if (b < 0x80) {
      out += String.fromCharCode(b);
      i += 1;
      continue;
    }
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
