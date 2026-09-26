// Shared plumbing for the Apple-family lyric providers (BiniLyrics,
// BetterLyrics, PaxSenix, LyricsPlus, Unison, SimpMusic): the three GET
// flavours, their headers and deadlines, and a few JSON/query helpers.
//
// Mirrors BitChord's data/lyrics/LyricsHttp.kt (lyricsGet, lyricsGetBearer,
// lyricsGetAuthorized, LYRICS_AGENT, the 6 s and 15 s clients).
// Independent JavaScript re-implementation of the mechanism documented in
// BITCHORD_ENGINE_RESEARCH.md (BitChord itself is GPL-3.0).
//
// Failure semantics, as in BitChord: every GET resolves to the body of a 2xx
// response or to null — a non-2xx status, a network error, a timeout and an
// unreadable body are all simply "no answer". The one exception is the
// caller's own AbortSignal: when that fires, the abort reason is thrown, so a
// cancelled race loser is not mistaken for a miss (LyricsRepository.kt:95-100).
//
// What is not modelled: OkHttp's separate 3 s / 10 s connect timeouts (fetch
// has a single deadline) and its transparent retry on a failed pooled
// connection. In browsers the User-Agent, Origin and Referer headers below are
// forbidden and silently dropped; Node and React Native send them.

import { qs, timeoutSignal } from '../../lib/http.js';

/** Whole-call deadline of the lyrics client (LyricsHttp.kt:17, callTimeout). */
export const LYRICS_TIMEOUT_MS = 6_000;

/** Deadline for PaxSenix's authenticated API (LyricsHttp.kt:36-41). */
export const AUTHENTICATED_TIMEOUT_MS = 15_000;

/** LyricsHttp.kt:19. */
export const LYRICS_AGENT = 'BitChord (https://github.com/bitchord)';

/**
 * Body of a successful GET, or null (LyricsHttp.kt:44-52).
 * Headers: User-Agent, `Accept: application/json` — sent even when the
 * document is TTML or HTML, as BitChord does.
 * @param {{ fetch?: typeof fetch, signal?: AbortSignal }} ctx
 * @param {string} url
 * @param {{ timeoutMs?: number }} [options]
 * @returns {Promise<string|null>}
 */
export function lyricsGet(ctx, url, { timeoutMs = LYRICS_TIMEOUT_MS } = {}) {
  return getBody(ctx, url, { 'User-Agent': LYRICS_AGENT, Accept: 'application/json' }, timeoutMs);
}

/**
 * Body of a bearer-authenticated GET, or null; null without a request when
 * the key is blank (LyricsHttp.kt:55-65). 15 s deadline.
 * @returns {Promise<string|null>}
 */
export function lyricsGetBearer(ctx, url, bearer) {
  if (bearer == null || String(bearer).trim() === '') return Promise.resolve(null);
  return getBody(ctx, url, {
    'User-Agent': LYRICS_AGENT,
    Accept: 'application/json, text/plain, */*',
    Authorization: `Bearer ${bearer}`,
  }, AUTHENTICATED_TIMEOUT_MS);
}

/**
 * {@link lyricsGet} with a bearer token and the headers Apple's web player
 * sends with one (LyricsHttp.kt:72-83): amp-api.music.apple.com answers a
 * token with no Origin, or the wrong one, with a 403. 6 s deadline.
 * @returns {Promise<string|null>}
 */
export function lyricsGetAuthorized(ctx, url, bearer) {
  return getBody(ctx, url, {
    'User-Agent': LYRICS_AGENT,
    Accept: 'application/json',
    Authorization: `Bearer ${bearer}`,
    Origin: 'https://music.apple.com',
    Referer: 'https://music.apple.com/',
  }, LYRICS_TIMEOUT_MS);
}

async function getBody(ctx, url, headers, timeoutMs) {
  const f = ctx?.fetch ?? globalThis.fetch;
  // The deadline covers the body as well as the headers, like OkHttp's
  // callTimeout; lib/http.js request() stops its timer once headers arrive.
  const { signal, done } = timeoutSignal(ctx?.signal, timeoutMs);
  try {
    const res = await f(url, { method: 'GET', headers, signal });
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      return null;
    }
    return await res.text();
  } catch (err) {
    if (ctx?.signal?.aborted) throw ctx.signal.reason ?? err;
    return null;
  } finally {
    done();
  }
}

/**
 * A child AbortController that follows `parent`, for fanning one request out
 * to several hosts and cancelling the losers. Call `release()` when done.
 * @param {AbortSignal|undefined} parent
 */
export function childController(parent) {
  const controller = new AbortController();
  const onAbort = () => controller.abort(parent.reason);
  if (parent?.aborted) controller.abort(parent.reason);
  else parent?.addEventListener('abort', onAbort, { once: true });
  return { controller, release: () => parent?.removeEventListener('abort', onAbort) };
}

/**
 * Query string encoded the way OkHttp's addQueryParameter does it: null and
 * undefined values are skipped, a space is `%20` rather than URLSearchParams'
 * `+` (a literal `+` is already `%2B`, so the swap is safe).
 */
export function query(params) {
  return qs(params).replace(/\+/g, '%20');
}

/** Whole seconds of a duration, truncated like Kotlin's Long division; 0 if unknown. */
export function secondsOf(durationMs) {
  const ms = Number(durationMs);
  return Number.isFinite(ms) ? Math.trunc(ms / 1000) : 0;
}

/** Kotlin `isNullOrBlank()`. */
export function isBlank(value) {
  return value == null || String(value).trim() === '';
}

/** The string itself when it is a non-blank string, else null. */
export function nonBlank(value) {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

/** JSON.parse that yields undefined for malformed input. */
export function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** A JSON object (not an array, not null). */
export function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * kotlinx `JsonPrimitive.longOrNull`: an integer, given as a JSON number or
 * as a numeric string; anything else is null. (JSON.parse reads `233.0` as
 * 233, which Kotlin would reject; the difference only ever helps.)
 */
export function jsonLong(value) {
  if (typeof value === 'number') return Number.isInteger(value) ? value : null;
  if (typeof value === 'string' && /^-?\d+$/.test(value)) return Number(value);
  return null;
}

/** kotlinx `JsonPrimitive.contentOrNull`: strings as-is, numbers and booleans as text. */
export function jsonContent(value) {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return null;
}
