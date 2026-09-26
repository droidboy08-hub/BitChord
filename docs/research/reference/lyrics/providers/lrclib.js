// LRCLIB provider ('lrclib').
//
// Mirrors BitChord (commit fe198ac):
//   app/src/main/java/com/music/bitchord/data/lyrics/LrcLib.kt   lyrics, exactMatch, bestSearchHit, clean
//   (LRC parsing lives in ../formats/lrc.js, mirroring LrcLib.parseLrc)
//
// Independent JavaScript re-implementation of the mechanism documented in
// BITCHORD_ENGINE_RESEARCH.md (BitChord itself is GPL-3.0).
//
// Protocol: two key-less GETs against https://lrclib.net/api.
//   1. GET /get?track_name=&artist_name=&duration=<whole seconds>  -> one object
//   2. only if (1) yields no syncedLyrics:
//      GET /search?track_name=&artist_name=                        -> array
//      the hit with non-blank syncedLyrics whose `duration` is closest to the
//      playing track wins. There is NO maximum tolerance (BitChord weakness).
// Only `syncedLyrics` is ever used; `plainLyrics` and `instrumental` are ignored.

import { timeoutSignal, HttpError, qs } from '../../lib/http.js';
import { parseLrc } from '../formats/lrc.js';

export const LRCLIB_BASE = 'https://lrclib.net/api';
export const LRCLIB_AGENT = 'BitChord (https://github.com/bitchord)';

// LrcLib.kt calls the shared Http.client directly, not the 6 s lyrics client:
// connect 20 s + read 30 s and no overall call timeout. fetch() has a single
// deadline, so their sum is the closest equivalent upper bound.
const TIMEOUT_MS = 50_000;

// LrcLib.kt NOISE: "(From ...)", "(feat. ...)", "(Official ...)", "(Remix ...)",
// any [bracketed] run, and a few loose upload labels.
const NOISE = /\((?:from|feat\.?|official|lyrical|video|audio|remix)[^)]*\)|\[[^\]]*\]|\b(?:official (?:video|audio|music video)|lyrical|full song|4k video)\b/gi;

/**
 * LrcLib.clean. Applied on top of the repository's forLyricsSearch() cleaning.
 * Note it strips "(Remix ...)" and every "[...]", which the repository-level
 * cleaner deliberately keeps because they name a different recording.
 */
export function cleanLrclibQuery(s) {
  const original = String(s ?? '');
  let out = original.replace(NOISE, ' ');
  const bar = out.indexOf(' | ');
  if (bar >= 0) out = out.slice(0, bar);
  out = out.replace(/\s+/g, ' ').trim();
  return out === '' ? original : out;
}

/** OkHttp's addQueryParameter encoding: form encoding, but a space is %20. */
const okhttpQuery = (params) => qs(params).replace(/\+/g, '%20');

/** GET with a whole-call deadline; body on 2xx, HttpError otherwise. */
async function get(ctx, url) {
  const f = ctx?.fetch ?? globalThis.fetch;
  const { signal, done } = timeoutSignal(ctx?.signal, TIMEOUT_MS);
  try {
    // LrcLib.kt sends only a User-Agent (no Accept). Browsers refuse to set
    // User-Agent; Node and React Native honour it.
    const res = await f(url, { headers: { 'User-Agent': LRCLIB_AGENT }, signal });
    const body = await res.text();
    if (!res.ok) throw new HttpError(res.status, url, body);
    return body;
  } finally {
    done();
  }
}

/** `syncedLyrics` of the exact match, or null (LrcLib.exactMatch). */
async function exactMatch(ctx, title, artist, seconds) {
  const url = `${LRCLIB_BASE}/get?${okhttpQuery({ track_name: title, artist_name: artist, duration: String(seconds) })}`;
  const json = JSON.parse(await get(ctx, url));
  if (!json || typeof json !== 'object' || Array.isArray(json)) return null;
  const synced = json.syncedLyrics;
  if (synced == null) return null;
  // Kotlin's `.jsonPrimitive` throws on a non-primitive, which reads as a miss
  // and lets the search run.
  if (typeof synced === 'object') throw new TypeError('syncedLyrics is not a primitive');
  return String(synced);
}

/** Closest-duration search hit with synced lyrics, or null (LrcLib.bestSearchHit). */
async function bestSearchHit(ctx, title, artist, seconds) {
  const url = `${LRCLIB_BASE}/search?${okhttpQuery({ track_name: title, artist_name: artist })}`;
  const hits = JSON.parse(await get(ctx, url));
  if (!Array.isArray(hits)) return null;
  let best = null;
  let bestDiff = Infinity;
  for (const hit of hits) {
    if (!hit || typeof hit !== 'object' || Array.isArray(hit)) continue;
    const synced = hit.syncedLyrics;
    if (synced == null || String(synced).trim() === '') continue;
    // `duration` is seconds as a float; missing or non-numeric counts as 0.0.
    const raw = typeof hit.duration === 'number' || typeof hit.duration === 'string' ? Number(hit.duration) : NaN;
    const diff = Math.abs((Number.isFinite(raw) ? raw : 0) - seconds);
    if (diff < bestDiff) { // strict: the first of equals wins, like minByOrNull
      best = String(synced);
      bestDiff = diff;
    }
  }
  return best;
}

/** @type {import('../model.js').LyricsProvider['lyrics']} */
async function lyrics(query, ctx = {}) {
  const title = cleanLrclibQuery(query.title);
  const artist = cleanLrclibQuery(query.artist);
  const seconds = Math.trunc((query.durationMs ?? 0) / 1000);
  const guard = (e) => {
    if (ctx.signal?.aborted) throw e; // a cancellation is not a miss
    return null;
  };

  let synced = await exactMatch(ctx, title, artist, seconds).catch(guard);
  // `exact ?: search`: only a null falls through. An exact hit whose
  // syncedLyrics is "" skips the search and ends as a miss, as in Kotlin.
  if (synced == null) synced = await bestSearchHit(ctx, title, artist, seconds).catch(guard);
  if (synced == null) return null;
  const lines = parseLrc(synced);
  return lines.length > 0 ? lines : null;
}

export const providers = [
  { id: 'lrclib', label: 'LRCLIB', wordSynced: false, lyrics },
];
