// Megalobiz provider ('megalobiz').
//
// Mirrors BitChord (commit fe198ac):
//   app/src/main/java/com/music/bitchord/data/lyrics/Megalobiz.kt    lyrics, LRC_LINK, LRC_BODY
//   app/src/main/java/com/music/bitchord/data/lyrics/LyricsHttp.kt   lyricsGet (6 s deadline, headers)
//   app/src/main/java/com/music/bitchord/data/lyrics/EnhancedLrc.kt  decodeEntities
//
// Independent JavaScript re-implementation of the mechanism documented in
// BITCHORD_ENGINE_RESEARCH.md (BitChord itself is GPL-3.0).
//
// A two-page HTML scrape of community-made LRC:
//   1. GET https://www.megalobiz.com/searchall?qry=<artist title>
//      -> the FIRST href="/lrc/maker/download/..." in the page. There is no
//         title/artist/duration check at all: whatever is listed first wins.
//   2. GET that page -> inner HTML of the element id="lrc_<...>_details" up to
//      the first </span>; <br> -> newline, all other tags stripped, entities
//      decoded -> parseLrc(). A result with no non-blank line is a miss.
// The URL shapes and the element id are what BitChord's regexes expect; they
// could not be re-verified against the live site from this environment.

import { timeoutSignal, HttpError, qs } from '../../lib/http.js';
import { decodeLrcEntities, parseLrc } from '../formats/lrc.js';

export const MEGALOBIZ_BASE = 'https://www.megalobiz.com';
const LYRICS_TIMEOUT_MS = 6_000; // LyricsHttp.kt: callTimeout 6 s (connect 3 s)
const LYRICS_AGENT = 'BitChord (https://github.com/bitchord)';

const LRC_LINK = /href=["'](\/lrc\/maker\/download\/[^"']+)["']/i;
const LRC_BODY = /id=["']lrc_[^"']*_details["'][^>]*>([\s\S]*?)<\/span>/i;

/** OkHttp's addQueryParameter encoding: form encoding, but a space is %20. */
const okhttpQuery = (params) => qs(params).replace(/\+/g, '%20');

/** LyricsHttp.lyricsGet: body of a 2xx, null for any failure; cancellation propagates. */
async function lyricsGet(ctx, url) {
  const f = ctx?.fetch ?? globalThis.fetch;
  const { signal, done } = timeoutSignal(ctx?.signal, LYRICS_TIMEOUT_MS);
  try {
    // lyricsGet always claims to want JSON, even for these HTML pages.
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

/** The LRC text held in a Megalobiz lyric page, or null. */
export function extractMegalobizLrc(page) {
  const raw = LRC_BODY.exec(page)?.[1];
  if (raw == null) return null;
  return decodeLrcEntities(raw.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, ''));
}

/** @type {import('../model.js').LyricsProvider['lyrics']} */
async function lyrics(query, ctx = {}) {
  try {
    const search = `${MEGALOBIZ_BASE}/searchall?${okhttpQuery({ qry: `${query.artist ?? ''} ${query.title ?? ''}`.trim() })}`;
    const results = await lyricsGet(ctx, search);
    if (results == null) return null;
    const path = LRC_LINK.exec(results)?.[1];
    if (!path) return null;
    // Only "&amp;" is unescaped in the href, exactly as in Kotlin.
    const page = await lyricsGet(ctx, MEGALOBIZ_BASE + path.replaceAll('&amp;', '&'));
    if (page == null) return null;
    const lrc = extractMegalobizLrc(page);
    if (lrc == null) return null;
    const lines = parseLrc(lrc);
    return lines.some((l) => l.text.trim() !== '') ? lines : null;
  } catch (err) {
    if (ctx.signal?.aborted) throw err;
    return null;
  }
}

export const providers = [
  { id: 'megalobiz', label: 'Megalobiz', wordSynced: false, lyrics },
];
