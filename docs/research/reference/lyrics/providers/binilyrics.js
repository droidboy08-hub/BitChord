// BiniLyrics provider ('bini_lyrics'): Apple Music TTML from a third host, and
// the only source that answers to a recording (ISRC) rather than to a name.
//
// Mirrors BitChord's data/lyrics/BiniLyrics.kt, plus the identify step and the
// hit reuse in data/lyrics/LyricsRepository.kt (IDENTIFY_TIMEOUT_MS, fetch()).
// Independent JavaScript re-implementation of the mechanism documented in
// BITCHORD_ENGINE_RESEARCH.md (BitChord itself is GPL-3.0).
//
// Protocol (key-less, two GETs):
//   1. GET https://lyrics-api.binimum.org/?isrc=<ISRC>
//      or  https://lyrics-api.binimum.org/?track=&artist=[&album=][&duration=<whole s>]
//      → { total, source: "HIT-EXACT"|…, results: [{ track_name, artist_name,
//          album_name, duration, isrc, timing_type: "word"|"line", lyricsUrl }] }
//      A miss is a 404 (or an empty `results`). The first result is taken as
//      is: the host does all of the matching.
//   2. GET <lyricsUrl>  → the TTML document itself, from a storage host.
//
// The search is also how the lookup learns the ISRC: LyricsRepository runs it
// first, capped at IDENTIFY_TIMEOUT_MS, and hands the ISRC to every source
// that can use one (LyricsPlus). Recommended repository wiring:
//
//   const hit = await identify(query, ctx, { timeoutMs: IDENTIFY_TIMEOUT_MS });
//   const isrc = query.isrc ?? hit?.isrc;
//   // BiniLyrics itself: reuse the hit, else search again (by ISRC if known)
//   const match = (hit && await lyricsFor(hit, ctx)) ?? await lyrics({ ...query, isrc }, ctx);

import { parseTtml } from '../formats/ttml.js';
import {
  LYRICS_TIMEOUT_MS, isBlank, isObject, lyricsGet, nonBlank, parseJson, query, secondsOf,
} from './plumbing.js';

export const BASE = 'https://lyrics-api.binimum.org/';

/**
 * How long LyricsRepository waits for {@link identify} before starting the
 * providers without an ISRC (LyricsRepository.kt:226). Short on purpose: a
 * fuzzy match is a better failure than an empty lyrics panel.
 */
export const IDENTIFY_TIMEOUT_MS = 2_500;

/**
 * @typedef {Object} BiniHit
 * @property {string|undefined} isrc       The recording the host matched; undefined when it gave none.
 * @property {string|undefined} lyricsUrl  Where the TTML lives.
 * @property {string|undefined} trackName
 * @property {string|undefined} artistName
 * @property {string|undefined} albumName
 * @property {number|undefined} duration   Seconds.
 * @property {string|undefined} timingType `word` or `line`; the document itself is the authority.
 * @property {string|undefined} source     How the host matched (`HIT-EXACT`, …). Informational only.
 */

/**
 * The search URL (BiniLyrics.kt:58-72). With an ISRC nothing else is sent —
 * the recording is named, and a title could only ever disagree with it.
 * @param {import('../model.js').LyricsQuery} q
 */
export function searchUrl(q) {
  if (!isBlank(q.isrc)) return `${BASE}?${query({ isrc: q.isrc })}`;
  const seconds = secondsOf(q.durationMs);
  return `${BASE}?${query({
    track: q.title ?? '',
    artist: q.artist ?? '',
    album: isBlank(q.album) ? null : q.album,
    duration: seconds > 0 ? seconds : null,
  })}`;
}

/**
 * Which recording is this, without fetching its words (BiniLyrics.kt:51-80).
 *
 * Resolves to the first search result, or null on a miss or any failure. A
 * timeout is a miss; an abort of `ctx.signal` is rethrown. Pass
 * `{ timeoutMs: IDENTIFY_TIMEOUT_MS }` to reproduce the repository's cap.
 *
 * @param {import('../model.js').LyricsQuery} q
 * @param {{ fetch?: typeof fetch, signal?: AbortSignal }} ctx
 * @param {{ timeoutMs?: number }} [options]
 * @returns {Promise<BiniHit|null>}
 */
export async function identify(q, ctx, { timeoutMs = LYRICS_TIMEOUT_MS } = {}) {
  const body = await lyricsGet(ctx, searchUrl(q), { timeoutMs });
  if (body == null) return null;
  const response = parseJson(body);
  if (!isObject(response) || !Array.isArray(response.results)) return null;
  const first = response.results[0];
  if (!isObject(first)) return null;
  return {
    isrc: nonBlank(first.isrc) ?? undefined,
    lyricsUrl: nonBlank(first.lyricsUrl) ?? undefined,
    trackName: stringOrUndefined(first.track_name),
    artistName: stringOrUndefined(first.artist_name),
    albumName: stringOrUndefined(first.album_name),
    duration: typeof first.duration === 'number' ? first.duration : undefined,
    timingType: stringOrUndefined(first.timing_type),
    source: stringOrUndefined(response.source),
  };
}

/**
 * The document a search already found, fetched and parsed
 * (BiniLyrics.kt:83-88). Null when the hit has no document URL, the fetch
 * fails, or the TTML holds no lines. Only http(s) URLs are followed — the URL
 * comes from a third party, and OkHttp would refuse any other scheme too.
 *
 * @param {BiniHit} hit
 * @param {{ fetch?: typeof fetch, signal?: AbortSignal }} ctx
 * @returns {Promise<{ lines: import('../model.js').LyricLine[], isrc?: string }|null>}
 */
export async function lyricsFor(hit, ctx) {
  const document = nonBlank(hit?.lyricsUrl);
  if (!document || !/^https?:\/\//i.test(document)) return null;
  const ttml = await lyricsGet(ctx, document);
  if (ttml == null) return null;
  const lines = parseTtml(ttml);
  if (lines.length === 0) return null;
  const isrc = nonBlank(hit.isrc);
  return isrc ? { lines, isrc } : { lines };
}

/**
 * Search, then fetch (BiniLyrics.kt:90-96): lyrics plus the ISRC they were
 * matched to, which the caller may remember against the video id.
 * @returns {Promise<{ lines: import('../model.js').LyricLine[], isrc?: string }|null>}
 */
export async function lyrics(q, ctx) {
  const hit = await identify(q, ctx);
  return hit ? lyricsFor(hit, ctx) : null;
}

/** @type {import('../model.js').LyricsProvider[]} */
export const providers = [
  {
    id: 'bini_lyrics',
    label: 'BiniLyrics',
    wordSynced: true,
    /**
     * `ctx.biniHit`, when present, is what {@link identify} already found:
     * its document is tried first, and only if that yields nothing is the
     * search run again (LyricsRepository.kt:187-189) — by ISRC when the query
     * carries one.
     */
    lyrics: async (q, ctx) => {
      const reused = ctx?.biniHit ? await lyricsFor(ctx.biniHit, ctx) : null;
      const match = reused ?? await lyrics(q, ctx);
      return match?.lines ?? null;
    },
  },
];

function stringOrUndefined(value) {
  return typeof value === 'string' ? value : undefined;
}
