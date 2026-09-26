// Shared lyric data model for the reference implementations.
//
// Mirrors BitChord's `data/lyrics/LyricLine.kt`:
//   LyricWord(startMs, endMs, text)
//   LyricLine(timeMs, text, words, sungUntilMs, background, alignment)
// A line with empty text is a gap (an instrumental pause); a line with words
// is word-synced (syllable/karaoke timing); a line with timeMs > 0 but no
// words is line-synced; all-zero timeMs means plain (unsynced) lyrics.

/**
 * @typedef {Object} LyricWord
 * @property {number} startMs
 * @property {number} endMs
 * @property {string} text   Includes its own trailing space when the source had one.
 */

/**
 * @typedef {Object} LyricLine
 * @property {number} timeMs              Line start. 0 for every line of plain lyrics.
 * @property {string} text                Empty string = gap.
 * @property {LyricWord[]} words          Empty unless word-synced.
 * @property {number|null} [sungUntilMs]  Known line end, when the source states one.
 * @property {LyricLine|null} [background] Answering/background vocal drawn under the lead.
 * @property {'start'|'end'} [alignment]  'end' for a second singer (duet), drawn right-aligned.
 */

/**
 * @typedef {Object} LyricsQuery
 * @property {string} title           Already cleaned with forLyricsSearch().
 * @property {string} artist          Already cleaned with artistForLyricsSearch().
 * @property {number} durationMs      Playing track length; most providers match on it.
 * @property {string} [album]
 * @property {string} [videoId]       YouTube id, for providers keyed on the video.
 * @property {string} [isrc]          Recording id, when known.
 */

/**
 * @typedef {Object} ProviderContext
 * @property {typeof fetch} fetch     Injected so tests and React Native can supply their own.
 * @property {AbortSignal} [signal]
 */

/**
 * A lyrics provider: one database or API.
 * @typedef {Object} LyricsProvider
 * @property {string} id              Stable id, e.g. 'lrclib'.
 * @property {string} label
 * @property {boolean} wordSynced     Whether it can ever return per-word timing.
 * @property {(q: LyricsQuery, ctx: ProviderContext) => Promise<LyricLine[]|null>} lyrics
 */

/** @returns {LyricLine} */
export function line(timeMs, text, words = [], extra = {}) {
  return { timeMs, text, words, sungUntilMs: null, background: null, alignment: 'start', ...extra };
}

export const isGap = (l) => l.text === '';
export const isWordSynced = (lines) => lines.some((l) => l.words && l.words.length > 0);
export const isLineSynced = (lines) => lines.some((l) => l.timeMs > 0);

/** Plain text → unsynced lines (every timeMs = 0). */
export function plainLines(text) {
  return String(text)
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((t) => t.trim())
    .filter((t, i, all) => t !== '' || (i > 0 && all[i - 1] !== ''))
    .map((t) => line(0, t));
}
