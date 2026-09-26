// Unison provider ('unison'): a community-submitted lyrics database — the one
// source whose contents are contributed rather than licensed.
//
// Mirrors BitChord's data/lyrics/Unison.kt.
// Independent JavaScript re-implementation of the mechanism documented in
// BITCHORD_ENGINE_RESEARCH.md (BitChord itself is GPL-3.0).
//
// Protocol: one key-less GET, matched server-side on the name:
//   GET https://unison.boidu.dev/lyrics?song=<title>&artist=<artist>[&album=][&duration=<whole s>]
//   → { "success": true,
//       "data": { "song", "artist", "album", "lyrics": "<document>",
//                 "format": "ttml"|"lrc", "syncType": "wordsync"|"linesync"|"plain",
//                 "score", "voteCount", "confidence": "low"|…, "submitter": {…}, … } }
// The entry says which of three shapes its `lyrics` holds: Apple-style TTML,
// LRC (plain or enhanced), or untimed text. The voting fields are deliberately
// ignored: a fresh submission has no votes and "low" confidence, so trusting
// them would refuse nearly the whole database.

import { plainLines } from '../model.js';
import { parseEnhancedLrc, parseLrc } from '../formats/lrc.js';
import { parseTtml } from '../formats/ttml.js';
import { isBlank, isObject, lyricsGet, parseJson, query, secondsOf } from './plumbing.js';

export const BASE = 'https://unison.boidu.dev/lyrics';

/** Unison.kt:38-46. */
export function requestUrl(q) {
  const seconds = secondsOf(q.durationMs);
  return `${BASE}?${query({
    song: q.title ?? '',
    artist: q.artist ?? '',
    album: isBlank(q.album) ? null : q.album,
    duration: seconds > 0 ? seconds : null,
  })}`;
}

/**
 * One entry's lyrics, read by the shape it declares (Unison.kt:56-68):
 * `format: "ttml"` → TTML; else `syncType: "plain"` → untimed lines (blank
 * rows dropped, every timeMs 0); else enhanced LRC, falling back to plain LRC
 * when it carries no word stamps. Null when there is nothing in it.
 * @param {object} entry  The response's `data`.
 * @returns {import('../model.js').LyricLine[]|null}
 */
export function linesOf(entry) {
  const text = typeof entry?.lyrics === 'string' && entry.lyrics.trim() !== '' ? entry.lyrics : null;
  if (text == null) return null;
  let lines;
  if (sameText(entry.format, 'ttml')) {
    lines = parseTtml(text);
  } else if (sameText(entry.syncType, 'plain')) {
    lines = plainLines(text).filter((l) => l.text !== '');
  } else {
    lines = parseEnhancedLrc(text);
    if (lines.length === 0) lines = parseLrc(text);
  }
  return lines.length > 0 ? lines : null;
}

const sameText = (value, expected) => typeof value === 'string' && value.toLowerCase() === expected;

/** @type {import('../model.js').LyricsProvider[]} */
export const providers = [
  {
    id: 'unison',
    label: 'Unison',
    wordSynced: true,
    lyrics: async (q, ctx) => {
      const body = await lyricsGet(ctx, requestUrl(q));
      if (body == null) return null;
      const response = parseJson(body);
      if (!isObject(response) || response.success !== true || !isObject(response.data)) return null;
      return linesOf(response.data);
    },
  },
];
