// Mirrors BitChord's `data/lyrics/LyricsSource.kt` (the provider enum: ids,
// labels, details, word-sync capability, default priority) and the lyric-source
// settings readers in `data/settings/AppSettings.kt` (readLyricsSources,
// readLyricsSourceOrder, LEGACY_SOURCES, defaults).
//
// Independent JavaScript re-implementation of the mechanism documented in
// BITCHORD_ENGINE_RESEARCH.md (BitChord itself is GPL-3.0).
//
// Declaration order *is* the default priority (LyricsSource.kt:18-31): both
// AppSettings.lyricsSources and AppSettings.lyricsSourceOrder fall back to
// LyricsSource.entries verbatim. The three Apple-TTML hosts lead, BiniLyrics
// first because it is the only one that answers to a recording (ISRC) and is
// where the ISRC the other sources use comes from; Genius (plain text, scraped)
// is last and is started lazily by the repository.
//
// `name` is the Kotlin enum constant, which is what AppSettings persists
// (comma-joined); `id` is the same name lower-cased, which is what the
// JavaScript providers use.

/**
 * @typedef {Object} LyricsSourceInfo
 * @property {string} id          Stable provider id used by the JS providers.
 * @property {string} name        Kotlin enum constant, as stored in preferences.
 * @property {string} label       Shown in Settings and in the provider sheet.
 * @property {string} detail      One-line description shown in Settings.
 * @property {boolean} wordSynced Whether it can ever return per-word timing.
 */

/** @type {ReadonlyArray<LyricsSourceInfo>} LyricsSource.kt:32-111, in declaration order. */
export const LYRICS_SOURCES = Object.freeze([
  src('bini_lyrics', 'BiniLyrics', 'The same Apple timings, matched on the recording itself', true),
  src('better_lyrics', 'BetterLyrics', 'Apple Music timings, word by word', true),
  src('better_lyrics_portato', 'BetterLyrics Portato', 'QQ Music karaoke timings through BetterLyrics', true),
  src('paxsenix', 'PaxSenix', 'Apple Music timings through the original keyless provider', true),
  src('paxsenix_spotify', 'PaxSenix: Spotify', 'Spotify lyrics with PaxSenix fallback; API key required', false),
  src('paxsenix_musixmatch', 'PaxSenix: Musixmatch', 'Musixmatch timings with PaxSenix fallback; API key required', true),
  src('lyrics_plus', 'LyricsPlus', 'Syllable by syllable, on community mirrors', true),
  src('simp_music', 'SimpMusic', 'Matched on the video, so never the wrong edit', true),
  src('unison', 'Unison', 'Contributed by listeners, so it has what nobody licensed', true),
  src('youtube_transcript', 'YouTube captions', 'Timed captions matched to the exact playing video', false),
  src('youtube_music', 'YouTube Music', "Plain lyrics from the playing video's Lyrics tab", false),
  src('megalobiz', 'Megalobiz', 'Community-made, whole-line LRC', false),
  src('kugou', 'KuGou', 'Whole lines, strong outside the English catalogue', false),
  src('lrclib', 'LRCLIB', 'Whole lines only, and always up', false),
  src('musixmatch', 'Musixmatch', 'Whole lines, from the biggest lyrics database there is', false),
  src('genius', 'Genius', 'Plain text fallback, massive web catalogue', false),
]);

function src(id, label, detail, wordSynced) {
  return Object.freeze({ id, name: id.toUpperCase(), label, detail, wordSynced });
}

/** LyricsSource.entries as ids: the out-of-the-box priority order. */
export const DEFAULT_ORDER = Object.freeze(LYRICS_SOURCES.map((s) => s.id));

/** id -> LyricsSourceInfo */
export const SOURCE_BY_ID = new Map(LYRICS_SOURCES.map((s) => [s.id, s]));

/** The provider that identifies the recording (ISRC) before the race. */
export const BINI_LYRICS = 'bini_lyrics';

/** The plain-text scraper the repository starts lazily (LyricsRepository.kt:122-125). */
export const GENIUS = 'genius';

/**
 * The sources that existed before `lyrics_sources_seen` was persisted.
 * Fixed forever (AppSettings.kt:1351-1365): it describes what an old build
 * could have saved, so it does not grow when the enum does.
 */
export const LEGACY_SOURCES = Object.freeze([
  'lyrics_plus', 'paxsenix', 'better_lyrics', 'simp_music', 'kugou', 'lrclib', 'musixmatch', 'genius',
]);

/**
 * Settings defaults (AppSettings.kt:450-561, 1918-1919).
 * lyricsOffsetMs is one global value, clamped to +-5 s, applied to the playback
 * clock rather than to the lines (see postprocess.js adjustedLyricsPosition).
 */
export const DEFAULT_LYRICS_SETTINGS = Object.freeze({
  syncedLyrics: true, //                 AppSettings.kt:538 - master switch; off = no lookups at all
  lyricsSources: DEFAULT_ORDER, //       AppSettings.kt:541 - all enabled
  lyricsSourceOrder: DEFAULT_ORDER, //   AppSettings.kt:551 - declaration order
  prioritizeSyllableSync: false, //      AppSettings.kt:561
  lyricsOffsetMs: 0, //                  AppSettings.kt:453
  lyricsBlur: true, //                   AppSettings.kt:450
  translationLanguage: '', //            AppSettings.kt:464 - blank = follow the app language
});

/** Accepts a stored comma-joined string of enum names/ids, or an array; unknown names fall out. */
function parseStored(stored) {
  const parts = Array.isArray(stored) ? stored : String(stored).split(',');
  const out = [];
  for (const part of parts) {
    const id = String(part).trim().toLowerCase();
    if (SOURCE_BY_ID.has(id)) out.push(id);
  }
  return out;
}

/**
 * Which sources are enabled, from what was persisted (AppSettings.kt:1338-1346).
 *
 * - Nothing stored: everything is enabled.
 * - A source *added by an upgrade* is enabled rather than left out: absence from a
 *   saved list is only a decision about sources that list was chosen from.
 *   `seen` (lyrics_sources_seen) records that list; before it existed,
 *   LEGACY_SOURCES stands in for it.
 *
 * @param {string|string[]|null|undefined} stored  e.g. "BINI_LYRICS,LRCLIB"
 * @param {string|string[]|null|undefined} [seen]
 * @returns {Set<string>}
 */
export function readLyricsSources(stored, seen) {
  if (stored == null) return new Set(DEFAULT_ORDER);
  const chosen = parseStored(stored);
  const seenSet = new Set(seen == null ? LEGACY_SOURCES : parseStored(seen));
  return new Set([...chosen, ...DEFAULT_ORDER.filter((id) => !seenSet.has(id))]);
}

/**
 * The priority order, from what was persisted (AppSettings.kt:1378-1384).
 * Named sources that no longer exist fall out; sources added since are appended
 * in declaration order. Like the Kotlin reader, duplicates are not removed here
 * (the settings dialog only ever writes a permutation); the repository dedups.
 *
 * @param {string|string[]|null|undefined} stored
 * @returns {string[]}
 */
export function readLyricsSourceOrder(stored) {
  if (stored == null) return [...DEFAULT_ORDER];
  const saved = parseStored(stored);
  return [...saved, ...DEFAULT_ORDER.filter((id) => !saved.includes(id))];
}

/** How AppSettings persists a set or an order: comma-joined enum names. */
export function storeLyricsSources(ids) {
  return [...ids].map((id) => SOURCE_BY_ID.get(id)?.name ?? String(id).toUpperCase()).join(',');
}
