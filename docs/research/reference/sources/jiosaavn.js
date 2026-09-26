// JioSaavn source: search, stream-URL decryption and rendition selection.
//
// Mirrors BitChord (commit fe198ac):
//   app/src/main/java/com/music/bitchord/data/jiosaavn/JioSaavnService.kt
//     selectBestSaavnStream (:66-84)   RawSongItem.isExplicit (:95-96)
//     prioritizeExplicit (:115-116)    BASE_URL, Base64-obfuscated (:122)
//     client timeouts + headers (:131-150)
//     decryptUrl (:152-166)            searchSongs (:185-207)   getStreamUrl (:209-245)
//   app/src/main/java/com/music/bitchord/data/sources/JioSaavnSource.kt
//     search (:22-66)  stream (:68-96)  MIN_USABLE_KBPS (:106)
//
// Independent JavaScript re-implementation of the mechanism documented in
// BITCHORD_ENGINE_RESEARCH.md §3.3 (BitChord itself is GPL-3.0; InnerTubeX,
// which this file does not use, is GPL-3.0 as well).
//
// The protocol, end to end:
//   1. GET https://www.jiosaavn.com/api.php?__call=search.getResults&_format=json
//        &_marker=0&api_version=4&ctx=android&q=<query>&p=1&n=10
//      -> {"results":[{id,title,image,explicit_content,more_info:{album,duration,
//          "320kbps","encrypted_media_url",artistMap:{primary_artists:[{name}]}}}]}
//   2. GET …?__call=song.getDetails&…&pids=<id>
//      -> {"<id>":{…same row…}}  (older builds: {"songs":[{…}]}) — both are read.
//   3. encrypted_media_url: Base64 -> DES/ECB/PKCS5Padding, key "38346591" -> trim
//      -> e.g. https://aac.saavncdn.com/815/<hash>_96.mp4
//   4. `_96` is rewritten to `_320` ONLY when the row says "320kbps":"true";
//      renditions of 96 kbps or less are refused so the resolver moves on.
//   Media is then fetched from the CDN with no special headers (one plain GET;
//   the URL has no `clen`, so ChunkedDataSource passes it through).
//
// What this adds over BitChord (kept optional, both paths documented):
//   searchAndStream() decrypts straight from the search row, which already
//   carries encrypted_media_url and the 320kbps flag, instead of paying a
//   second song.getDetails round trip per candidate (paper §3.3, defect D11).
//   Pass { useSearchRow: false } for BitChord's exact two-call behaviour.
//
// Behavioural notes (matching the Kotlin unless stated):
//   * Network and parse failures never throw: search -> [], stream -> null
//     (Kotlin runCatching). Only a non-200 status counts as failure.
//   * Titles keep JioSaavn's HTML entities (&quot; &amp; …); BitChord does not
//     unescape them either.
//   * Nothing is cached (as in BitChord); wrap with your own 5-10 min cache.
//   Deliberate deviations, all on error paths:
//   * An abort of the CALLER's own signal is rethrown, so cancellation is
//     distinguishable from "no results" (Kotlin's runCatching swallows it).
//   * song.getDetails: the entry keyed by the requested id is preferred over
//     "the first object value", which could be an unrelated object.
//   * A null or oddly typed field in one row falls back to its default instead
//     of failing the whole page (kotlinx rejects null in a non-null field).

import { desDecrypt } from './des.js';
import { request, qs, timeoutSignal } from '../lib/http.js';

// ---- Protocol constants ------------------------------------------------------

/** JioSaavnService.kt:122 stores this Base64-encoded: aHR0cHM6Ly93d3cuamlvc2Fhdm4uY29tL2FwaS5waHA= */
export const SAAVN_API_URL = 'https://www.jiosaavn.com/api.php';

/**
 * The DES key every JioSaavn client uses for encrypted_media_url
 * (JioSaavnService.kt:155). A public protocol constant, not a secret.
 */
export const SAAVN_DES_KEY = '38346591';

/**
 * Ktor HttpTimeout in JioSaavnService.kt:134-138: connect 4 s, request 6 s,
 * socket 6 s. fetch() cannot observe the TCP connect separately, so `connectMs`
 * bounds the wait for response headers (a slightly stricter stand-in) and
 * `requestMs` bounds the whole call, body included.
 */
export const SAAVN_TIMEOUTS = Object.freeze({ connectMs: 4_000, requestMs: 6_000 });

/** search.getResults page size (JioSaavnService.kt:194). The resolver asks for 15 but gets 10. */
export const SEARCH_PAGE_SIZE = 10;

/** JioSaavnSource.kt:106: 48 and 96 kbps are below YouTube's ~160 kbps Opus. */
export const MIN_USABLE_KBPS = 96;

/**
 * Default headers of JioSaavnService's client (JioSaavnService.kt:139-147).
 * Browsers drop `Cookie`/`User-Agent` and CORS blocks api.php anyway; this is
 * for React Native and Node, which send them as given.
 */
export const SAAVN_HEADERS = Object.freeze({
  Accept: 'application/json',
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36',
  // Geo gate. JioSaavn is an Indian service whose catalogue is restricted by
  // country. BitChord's answer is to claim a Reliance Jio address (49.36.0.1)
  // in both client-IP headers, which works only as far as the API trusts
  // them. No proxy is involved: the TCP connection still comes from the real
  // client. Check the service's terms before relying on this outside India.
  'X-Forwarded-For': '49.36.0.1',
  'X-Real-IP': '49.36.0.1',
  'Accept-Language': 'en-IN,en;q=0.9',
  // Explicit gate. The cookie opts the session into explicit content, which
  // is otherwise kept out of answers; without it an explicit YouTube track
  // could only ever match a censored duplicate (and TrackMatcher rejects an
  // explicit mismatch). prioritizeExplicit() then puts the uncensored row first.
  Cookie: 'explicit_content=1',
});

// Every call carries these after `__call`, in this order (JioSaavnService.kt:187-191, 212-216).
const COMMON_PARAMS = { _format: 'json', _marker: '0', api_version: '4', ctx: 'android' };

// ---- Byte helpers (no Buffer / atob / TextDecoder assumptions) -------------

const B64_INDEX = (() => {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const table = new Int8Array(128).fill(-1);
  for (let i = 0; i < 64; i++) table[alphabet.charCodeAt(i)] = i;
  table[45] = 62; // '-' (URL-safe alphabet, accepted for tolerance)
  table[95] = 63; // '_'
  return table;
})();

/**
 * Lenient Base64 decode in the spirit of android.util.Base64.DEFAULT:
 * characters outside the alphabet (whitespace, line breaks) are skipped,
 * missing padding is tolerated, decoding stops at the first '='.
 * @param {string} text
 * @returns {Uint8Array}
 */
export function base64Decode(text) {
  const out = new Uint8Array(Math.ceil((text.length * 3) / 4));
  let acc = 0;
  let bits = 0;
  let n = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 61) break; // '='
    const v = c < 128 ? B64_INDEX[c] : -1;
    if (v < 0) continue;
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[n++] = (acc >> bits) & 0xff;
      acc &= (1 << bits) - 1;
    }
  }
  return out.subarray(0, n);
}

/**
 * UTF-8 decode with one U+FFFD per maximal malformed subpart, like
 * `String(bytes, UTF_8)` and TextDecoder. The fallback is the WHATWG
 * "UTF-8 decoder" algorithm, for engines without TextDecoder (older RN).
 */
function utf8Decode(bytes) {
  if (typeof TextDecoder !== 'undefined') return new TextDecoder('utf-8').decode(bytes);
  let out = '';
  let cp = 0;
  let needed = 0;
  let seen = 0;
  let lower = 0x80;
  let upper = 0xbf;
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    if (needed === 0) {
      if (b <= 0x7f) out += String.fromCharCode(b);
      else if (b >= 0xc2 && b <= 0xdf) { needed = 1; cp = b & 0x1f; }
      else if (b >= 0xe0 && b <= 0xef) {
        if (b === 0xe0) lower = 0xa0;
        if (b === 0xed) upper = 0x9f;
        needed = 2;
        cp = b & 0x0f;
      } else if (b >= 0xf0 && b <= 0xf4) {
        if (b === 0xf0) lower = 0x90;
        if (b === 0xf4) upper = 0x8f;
        needed = 3;
        cp = b & 0x07;
      } else out += '\uFFFD';
      continue;
    }
    if (b < lower || b > upper) {
      cp = needed = seen = 0;
      lower = 0x80;
      upper = 0xbf;
      out += '\uFFFD';
      i -= 1; // the offending byte starts over
      continue;
    }
    lower = 0x80;
    upper = 0xbf;
    cp = (cp << 6) | (b & 0x3f);
    if (++seen === needed) {
      out += String.fromCodePoint(cp);
      cp = needed = seen = 0;
    }
  }
  return needed ? `${out}\uFFFD` : out;
}

// ---- Pure protocol logic ----------------------------------------------------

const str = (v) => (v === undefined || v === null ? '' : String(v));
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isBlank = (s) => str(s).trim() === '';
const moreInfoOf = (row) => (isObject(row?.more_info) ? row.more_info : {});

/**
 * encrypted_media_url -> CDN URL: Base64 -> DES/ECB/PKCS5 with "38346591" -> UTF-8 -> trim.
 * Returns '' on blank input or any failure, like JioSaavnService.decryptUrl.
 * @param {string} encrypted
 * @returns {string}
 */
export function decryptMediaUrl(encrypted) {
  if (isBlank(encrypted)) return '';
  try {
    return utf8Decode(desDecrypt(SAAVN_DES_KEY, base64Decode(String(encrypted)))).trim();
  } catch {
    return '';
  }
}

/** The rendition marker: `_96.mp4`, `_320.MP4?Expires=…`, `_160.aac#t`, … (JioSaavnService.kt:68-71). */
const RENDITION = /_(48|96|160|320)\.(mp4|aac|mp3)(?=[?#]|$)/i;

/** `more_info["320kbps"]`, a "true"/"false" string (RawMoreInfo.supports320). */
export function supports320(moreInfo) {
  return str(moreInfo?.['320kbps']).toLowerCase() === 'true';
}

/**
 * The best rendition a decrypted CDN URL really has, and the bitrate it will
 * deliver (JioSaavnService.kt:66-84):
 *   blank URL                   -> null
 *   no `_NN.ext` marker         -> URL unchanged, kbps null (never guessed as 320)
 *   has320 false                -> URL unchanged, kbps = the stated rendition
 *   has320 true                 -> marker rewritten to `_320.<same ext>`, kbps 320,
 *                                  query string and fragment preserved
 * @param {string} url decrypted media URL
 * @param {boolean|string} has320 `true` or the raw "true" string
 * @returns {{url: string, kbps: number|null}|null}
 */
export function selectBestSaavnStream(url, has320) {
  if (isBlank(url)) return null;
  const match = RENDITION.exec(url);
  if (!match) return { url, kbps: null };
  const offered = Number(match[1]);
  const upgrade = has320 === true || (typeof has320 === 'string' && has320.toLowerCase() === 'true');
  if (!upgrade) return { url, kbps: offered };
  const rewritten = `${url.slice(0, match.index)}_320.${match[2]}${url.slice(match.index + match[0].length)}`;
  return { url: rewritten, kbps: 320 };
}

/** `explicit_content` is "1"/"0"; "true" is accepted defensively (JioSaavnService.kt:95-96). */
export function isExplicit(row) {
  const flag = str(row?.explicit_content);
  return flag === '1' || flag.toLowerCase() === 'true';
}

/** Uncensored rows first, otherwise in the order JioSaavn gave (a stable partition). */
export function prioritizeExplicit(rows) {
  return [...rows.filter(isExplicit), ...rows.filter((row) => !isExplicit(row))];
}

/** 150x150 / 50x50 artwork -> 500x500, and http -> https (JioSaavnSource.kt:39-42). */
export function upscaleThumbnail(url) {
  return str(url).replace(/150x150|50x50/g, '500x500').replace(/^http:\/\//, 'https://');
}

/** Kotlin `String.toIntOrNull()`: optional sign, digits only, 32-bit range. */
function toIntOrNull(value) {
  const text = str(value);
  if (!/^[+-]?\d+$/.test(text)) return null;
  const n = Number.parseInt(text, 10);
  return n >= -2147483648 && n <= 2147483647 ? n : null;
}

/** Seconds (a numeric string) -> "M:SS" via `"%d:%02d".format(s / 60, s % 60)`, or null. */
export function formatDuration(seconds) {
  const total = toIntOrNull(seconds);
  if (total === null) return null;
  return `${Math.trunc(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

/**
 * A search/details row as the track BitChord builds from it (JioSaavnSource.search).
 * @returns {{id: string, title: string, artist: string, album: string|null,
 *   thumbnailUrl: string, durationSec: number|null, durationText: string|null,
 *   isExplicit: boolean, sourceQuality: 'HIGH'}}
 */
export function toTrack(row) {
  const info = moreInfoOf(row);
  const primary = Array.isArray(info.artistMap?.primary_artists) ? info.artistMap.primary_artists : [];
  const artist = primary.map((a) => str(a?.name)).join(', ');
  return {
    id: str(row?.id),
    title: str(row?.title),
    artist: isBlank(artist) ? 'Unknown Artist' : artist,
    album: isBlank(info.album) ? null : str(info.album),
    thumbnailUrl: upscaleThumbnail(row?.image),
    durationSec: toIntOrNull(info.duration),
    durationText: formatDuration(info.duration),
    isExplicit: isExplicit(row),
    sourceQuality: 'HIGH',
  };
}

/** decrypt + select for one row (search or details): what `bestStream()` does in Kotlin. */
export function bestStreamFromRow(row) {
  const info = moreInfoOf(row);
  return selectBestSaavnStream(decryptMediaUrl(info.encrypted_media_url), supports320(info));
}

/**
 * JioSaavnSource.stream's acceptance rules: no URL -> null; a stated rendition
 * of 96 kbps or less -> null (a refusal lets the resolver step to the next
 * source, whereas a returned-then-rejected stream would end the upgrade);
 * otherwise a SourceStream. `codec: 'mp4'` names the container; it holds AAC.
 * @param {{url: string, kbps: number|null}|null} saavn
 * @param {string} via 'song.getDetails' | 'search-row' (diagnostic only)
 */
export function toSourceStream(saavn, via) {
  if (!saavn || isBlank(saavn.url)) return null;
  if (saavn.kbps !== null && saavn.kbps <= MIN_USABLE_KBPS) return null;
  return { url: saavn.url, format: { codec: 'mp4', kbps: saavn.kbps }, headers: {}, via };
}

/** The optimisation BitChord misses: a SourceStream straight from a search row, no second call. */
export function streamFromSearchRow(row) {
  return toSourceStream(bestStreamFromRow(row), 'search-row');
}

// ---- HTTP -------------------------------------------------------------------

/**
 * @typedef {Object} SaavnOptions
 * @property {typeof fetch} [fetch]    injected fetch (tests, React Native); defaults to global
 * @property {AbortSignal} [signal]    the caller's cancellation
 * @property {Record<string,string>} [headers]  override SAAVN_HEADERS (e.g. to drop the geo headers)
 * @property {{connectMs: number, requestMs: number}} [timeouts]
 * @property {(level: string, message: string) => void} [log]
 */

/** `promise`, but rejecting when `signal` aborts (the body read outlives request()'s own timer). */
function untilAborted(promise, signal) {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (v) => { signal.removeEventListener('abort', onAbort); resolve(v); },
      (e) => { signal.removeEventListener('abort', onAbort); reject(e); },
    );
  });
}

/** One api.php call; resolves to the parsed JSON body. Throws on non-200/timeout/bad JSON. */
async function callApi(call, params, options = {}) {
  const { fetch: f, signal, headers = SAAVN_HEADERS } = options;
  const timeouts = { ...SAAVN_TIMEOUTS, ...options.timeouts };
  const url = `${SAAVN_API_URL}?${qs({ __call: call, ...COMMON_PARAMS, ...params })}`;
  const overall = timeoutSignal(signal, timeouts.requestMs);
  try {
    const res = await request({ fetch: f, signal: overall.signal }, url, {
      headers: { ...headers },
      timeoutMs: timeouts.connectMs,
      okStatuses: [200], // `response.status != HttpStatusCode.OK` is a failure in Kotlin
    });
    return JSON.parse(await untilAborted(res.text(), overall.signal));
  } finally {
    overall.done();
  }
}

function swallow(error, options, what) {
  if (options.signal?.aborted) throw options.signal.reason ?? error; // the caller gave up: say so
  options.log?.('warn', `Saavn ${what} error: ${error?.message ?? error}`);
}

/**
 * JioSaavnService.searchSongs: one page of 10 raw rows, in JioSaavn's order.
 * @param {string} query
 * @param {SaavnOptions} [options]
 * @returns {Promise<object[]>} [] on any failure
 */
export async function searchSongs(query, options = {}) {
  try {
    const body = await callApi('search.getResults', { q: query, p: '1', n: String(SEARCH_PAGE_SIZE) }, options);
    if (!isObject(body)) return [];
    if (body.results === undefined || body.results === null) return [];
    if (!Array.isArray(body.results)) throw new Error('results is not an array');
    return body.results.filter(isObject);
  } catch (error) {
    swallow(error, options, 'search');
    return [];
  }
}

/**
 * JioSaavnService.getStreamUrl: song.getDetails for one id, both response shapes.
 * Deviation (safer, same answer in practice): the entry keyed by the requested
 * id is preferred over "the first object value", which the Kotlin takes.
 * @param {string} saavnSongId
 * @param {SaavnOptions} [options]
 * @returns {Promise<{url: string, kbps: number|null}|null>}
 */
export async function getStreamUrl(saavnSongId, options = {}) {
  try {
    const root = await callApi('song.getDetails', { pids: saavnSongId }, options);
    if (!isObject(root)) return null;
    const song =
      (Array.isArray(root.songs) && root.songs.length > 0 ? root.songs[0] : undefined) ??
      (isObject(root[saavnSongId]) ? root[saavnSongId] : undefined) ??
      Object.values(root).find(isObject);
    if (!isObject(song)) {
      options.log?.('warn', `Saavn getDetails held no song for ${saavnSongId}`);
      return null;
    }
    return bestStreamFromRow(song);
  } catch (error) {
    swallow(error, options, 'getDetails');
    return null;
  }
}

/**
 * JioSaavnSource.search: explicit rows first, at most `limit`, mapped to tracks.
 * @param {string} query
 * @param {SaavnOptions & {limit?: number}} [options]
 */
export async function search(query, { limit = SEARCH_PAGE_SIZE, ...options } = {}) {
  return prioritizeExplicit(await searchSongs(query, options)).slice(0, limit).map(toTrack);
}

/**
 * JioSaavnSource.stream: song.getDetails, decrypt, select, refuse <= 96 kbps.
 * @param {string} trackId
 * @param {SaavnOptions} [options]
 */
export async function stream(trackId, options = {}) {
  return toSourceStream(await getStreamUrl(trackId, options), 'song.getDetails');
}

/**
 * JioSaavnSource itself: a MusicSource of kind 'jiosaavn' (rank 2 in
 * SourceKind.kt, never lossless), shaped like the MusicSource typedef in
 * ./resolve.js so the resolver there can race it. Rows also carry `explicit`
 * and `quality`, the names that typedef uses. `request` is moot: one catalogue,
 * no tiers to ask for (JioSaavnSource.kt:21).
 * @param {SaavnOptions & {id?: string, displayName?: string}} [options] defaults for every call
 */
export function createJioSaavnSource({ id = 'jiosaavn', displayName = 'JioSaavn', ...defaults } = {}) {
  return {
    id,
    kind: 'jiosaavn',
    rank: 2,
    canServeLossless: false,
    displayName,
    /** "Always Ok since the API endpoints don't need authentication to search." */
    async health() {
      return { ok: true };
    },
    async search(query, { limit = SEARCH_PAGE_SIZE, signal } = {}) {
      const tracks = await search(query, { ...defaults, signal, limit });
      return tracks.map((track) => ({ ...track, explicit: track.isExplicit, quality: track.sourceQuality }));
    },
    async stream(trackId, _request, { signal } = {}) {
      return stream(trackId, { ...defaults, signal });
    },
  };
}

/**
 * Search, then stream the first acceptable candidate — the per-source half of
 * SourceResolver.matchAndStream (<= 3 candidates, tried in order).
 *
 * Two paths, both kept:
 *   useSearchRow: true  (default) decrypt the row's own encrypted_media_url and
 *                       320kbps flag: ONE HTTP call for the whole lookup. Falls
 *                       back to song.getDetails only when a row carries no
 *                       usable encrypted URL. A row that decrypts to a refused
 *                       rendition is not re-asked: details would say the same.
 *   useSearchRow: false BitChord's behaviour: a song.getDetails call per candidate.
 *
 * @param {string} query
 * @param {SaavnOptions & {useSearchRow?: boolean, maxCandidates?: number,
 *   pick?: (rows: object[]) => object[]}} [options] `pick` reorders/filters
 *   the explicit-first rows (plug a TrackMatcher-style ranking in here).
 * @returns {Promise<{track: ReturnType<typeof toTrack>, stream: object, row: object}|null>}
 */
export async function searchAndStream(query, { useSearchRow = true, maxCandidates = 3, pick, ...options } = {}) {
  const rows = prioritizeExplicit(await searchSongs(query, options));
  const candidates = (pick ? pick(rows) : rows).slice(0, maxCandidates);
  for (const row of candidates) {
    let saavn = useSearchRow ? bestStreamFromRow(row) : null;
    let via = 'search-row';
    if (!saavn) {
      saavn = await getStreamUrl(str(row.id), options);
      via = 'song.getDetails';
    }
    const accepted = toSourceStream(saavn, via);
    if (accepted) return { track: toTrack(row), stream: accepted, row };
    options.log?.('info', `JioSaavn ${str(row.id)} offered ${saavn?.kbps ?? 'no'} kbps; trying the next row`);
  }
  return null;
}
