// SimpMusic provider ('simp_music'): lyrics from SimpMusic's community
// database, keyed on the YouTube video id rather than on a name.
//
// Mirrors BitChord's data/lyrics/SimpMusicLyrics.kt.
// Independent JavaScript re-implementation of the mechanism documented in
// BITCHORD_ENGINE_RESEARCH.md (BitChord itself is GPL-3.0).
//
// Protocol: one key-less GET.
//   GET https://api-lyrics.simpmusic.org/v1/<videoId>
//   → { "success": true,
//       "data": [ { "duration": <seconds>, "richSyncLyrics": "<enhanced LRC>",
//                   "syncedLyrics": "<LRC>", "plainLyrics": "…", … }, … ] }
// Several entries can exist for one video (different cuts); the one closest
// in length to the playing track is taken, provided it is within 10 s — or
// the shortest one when the track length is unknown. Its rich sync (word
// timing, served HTML-escaped: `&#x27;`) is preferred, then its line sync;
// `plainLyrics` is never used, so an entry with only plain text is a miss.
//
// Seen in the wild: the host geoblocks some regions with a 403 "Access denied
// from your region", so a miss here can be permanent for a user and the chain
// must carry on past it.

import { parseEnhancedLrc, parseLrc } from '../formats/lrc.js';
import { isBlank, isObject, lyricsGet, parseJson, secondsOf } from './plumbing.js';

export const BASE = 'https://api-lyrics.simpmusic.org/v1/';

/** Length slack when the database holds several cuts of one video (SimpMusicLyrics.kt:27). */
export const DURATION_TOLERANCE_SECONDS = 10;

/**
 * The entry for the playing cut (SimpMusicLyrics.kt:36-40): within the
 * tolerance, closest first, earliest on a tie. A missing duration counts as 0.
 * @param {object[]} entries
 * @param {number} durationMs
 */
export function pickEntry(entries, durationMs) {
  const seconds = secondsOf(durationMs);
  let best = null;
  let bestDistance = Infinity;
  for (const entry of entries) {
    if (!isObject(entry)) continue;
    const distance = Math.abs(entryDuration(entry) - seconds);
    if (seconds > 0 && distance > DURATION_TOLERANCE_SECONDS) continue;
    if (distance < bestDistance) {
      best = entry;
      bestDistance = distance;
    }
  }
  return best;
}

const hasText = (value) => typeof value === 'string' && value.trim() !== '';

function entryDuration(entry) {
  return typeof entry.duration === 'number' && Number.isFinite(entry.duration) ? entry.duration : 0;
}

/** @type {import('../model.js').LyricsProvider[]} */
export const providers = [
  {
    id: 'simp_music',
    label: 'SimpMusic',
    wordSynced: true,
    lyrics: async (q, ctx) => {
      if (isBlank(q.videoId)) return null;
      const body = await lyricsGet(ctx, BASE + encodeURIComponent(q.videoId));
      if (body == null) return null;
      const response = parseJson(body);
      if (!isObject(response) || response.success !== true) return null;
      const entry = pickEntry(Array.isArray(response.data) ? response.data : [], q.durationMs);
      if (!entry) return null;

      // Word timing first; a line-synced answer from here is no better than
      // LRCLIB's, but it is still better than nothing.
      if (hasText(entry.richSyncLyrics)) {
        const rich = parseEnhancedLrc(entry.richSyncLyrics);
        if (rich.length > 0) return rich;
      }
      if (hasText(entry.syncedLyrics)) {
        const synced = parseLrc(entry.syncedLyrics);
        if (synced.length > 0) return synced;
      }
      return null;
    },
  },
];
