// Mirrors BitChord's `data/lyrics/LyricsQuery.kt` (String.forLyricsSearch,
// String.artistForLyricsSearch) plus the two Kotlin stdlib behaviours those
// functions lean on (String.trim / isBlank with Kotlin's notion of whitespace).
//
// Independent JavaScript re-implementation of the mechanism documented in
// BITCHORD_ENGINE_RESEARCH.md (BitChord itself is GPL-3.0).
//
// What the cleaning is for (LyricsQuery.kt:3-25): every provider except the
// video-keyed ones is asked for a *name*, and the name the player has is
// YouTube's. Only credits ("feat. X", "(with X)") and upload packaging
// ("(Official Video)", "[Lyrics]", "(4K)") are removed. Anything that names a
// different recording - "(Remix)", "(Live)", "(Acoustic)", "(Sped Up)",
// "(Remastered 2011)" - is deliberately kept, because stripping it turns a miss
// into confidently wrong words.
//
// Regex fidelity notes. The Kotlin patterns run on Android's ICU-backed
// java.util.regex, so they are translated here with ICU semantics:
//   - `\s`  -> [\t\n\f\r\p{Z}]            (ICU white space; desktop JVM uses [ \t\n\x0B\f\r])
//   - `\b` after the credit keyword -> "next char is not an ICU word char"
//                                          ([\p{Alphabetic}\p{M}\p{Nd}\p{Pc}‌‍])
//   - `.`   -> anything but an ICU line terminator
//   - `$`   -> end of input, or just before one final line terminator (no MULTILINE)
//   - IGNORE_CASE -> `iu` (Kotlin/JVM Regex adds UNICODE_CASE to CASE_INSENSITIVE)
// For ordinary titles (ASCII spaces, no line breaks) every choice above gives
// the same answer as a naive transliteration; they only matter on exotic input.

/** ICU `\s`. */
const WS = String.raw`[\t\n\f\r\p{Z}]`;
/** ICU `\b` in the only position the patterns use it: right after a keyword that ends in a letter. */
const WORD_END = String.raw`(?![\p{Alphabetic}\p{M}\p{Nd}\p{Pc}‌‍])`;
/** ICU line terminators (what `.` refuses and what `$` may sit before). */
const LINE_TERMINATOR = String.raw`[\n\u000B\f\r\u0085  ]`;
const DOT = String.raw`[^\n\u000B\f\r\u0085  ]`;
const END = String.raw`(?=(?:\r\n|${LINE_TERMINATOR})?$)`;

/**
 * LyricsQuery.kt:46-59, in the same order. Each is applied with replaceAll(" ").
 * Capturing groups are made non-capturing; that changes nothing, since the
 * replacement is a literal space.
 */
export const CREDITS = Object.freeze([
  // Bracketed credits: (feat. X), [ft. X], (with X).            LyricsQuery.kt:48
  new RegExp(String.raw`${WS}*[(\[]${WS}*(?:feat|ft|featuring|with)${WORD_END}[^)\]]*[)\]]`, 'giu'),
  // The same, unbracketed and running to the end of the title.  LyricsQuery.kt:50
  new RegExp(String.raw`${WS}+(?:feat|ft|featuring)\.?${WS}+${DOT}*${END}`, 'giu'),
  // How the upload was labelled, not what was recorded.         LyricsQuery.kt:52-57
  new RegExp(
    String.raw`${WS}*[(\[]${WS}*(?:official${WS}*)?(?:music${WS}*)?` +
      String.raw`(?:video|audio|visuali[sz]er|lyrics?${WS}*video|lyrics?|m\/?v|hd|hq|4k|full${WS}*song)` +
      String.raw`${WS}*[)\]]`,
    'giu',
  ),
  //                                                              LyricsQuery.kt:58
  new RegExp(String.raw`${WS}*[(\[]${WS}*official${WS}*[)\]]`, 'giu'),
]);

/** LyricsQuery.kt:44 - `\s+`, collapsed to one space. */
const WHITESPACE = new RegExp(`${WS}+`, 'gu');

/**
 * Kotlin's Char.isWhitespace() on the JVM/Android:
 * Character.isWhitespace(c) || Character.isSpaceChar(c)
 * = \t \n \u000B \f \r \u001C-\u001F plus every Unicode separator (Z*).
 * (JavaScript's own trim() differs: it strips U+FEFF and keeps U+001C-U+001F.)
 */
const KT_WHITESPACE_CHAR = /^[\t\n\u000B\f\r\u001C-\u001F\p{Z}]$/u;
const isKtWhitespace = (ch) => KT_WHITESPACE_CHAR.test(ch);

/** Kotlin String.trim(). Works on UTF-16 units, exactly like Kotlin. */
export function ktTrim(s) {
  let start = 0;
  let end = s.length;
  while (start < end && isKtWhitespace(s[start])) start++;
  while (end > start && isKtWhitespace(s[end - 1])) end--;
  return s.slice(start, end);
}

/** Kotlin String.trimEnd() (no-argument form). */
export function ktTrimEnd(s) {
  let end = s.length;
  while (end > 0 && isKtWhitespace(s[end - 1])) end--;
  return s.slice(0, end);
}

/** Kotlin CharSequence.isBlank(): empty, or whitespace only. */
export function ktIsBlank(s) {
  for (let i = 0; i < s.length; i++) if (!isKtWhitespace(s[i])) return false;
  return true;
}

/** Kotlin String.trimEnd(vararg chars). */
function trimEndChars(s, chars) {
  let end = s.length;
  while (end > 0 && chars.includes(s[end - 1])) end--;
  return s.slice(0, end);
}

const TRAILING_SEPARATORS = [',', '-', '–', '—']; // , - – —

/**
 * A YouTube title, as a lyrics database would have indexed it.
 * LyricsQuery.kt:26-33.
 *
 * "Dracula (feat. JENNIE)"                        -> "Dracula"
 * "Levitating (feat. DaBaby) [Official Video]"    -> "Levitating"
 * "Everlong (Acoustic)"                           -> unchanged
 * "(Official Video)"                              -> unchanged: a title that was
 *   *only* packaging falls back to the original, trimmed - better to ask with
 *   what we were given than with nothing.
 *
 * @param {string} title
 * @returns {string}
 */
export function forLyricsSearch(title) {
  const original = String(title ?? '');
  let name = original;
  for (const pattern of CREDITS) {
    pattern.lastIndex = 0;
    name = name.replace(pattern, ' ');
  }
  const cleaned = ktTrim(trimEndChars(ktTrim(name.replace(WHITESPACE, ' ')), TRAILING_SEPARATORS));
  // `.ifBlank { trim() }` - the lambda's `trim()` is the *receiver's*, i.e. the
  // original title, not the cleaned one.
  return ktIsBlank(cleaned) ? ktTrim(original) : cleaned;
}

/**
 * Trims " - Topic" off an auto-generated YouTube artist channel name.
 * LyricsQuery.kt:41-42. Case-sensitive, exact suffix only.
 *
 * @param {string} artist
 * @returns {string}
 */
export function artistForLyricsSearch(artist) {
  const original = String(artist ?? '');
  const suffix = ' - Topic';
  const stripped = original.endsWith(suffix) ? original.slice(0, -suffix.length) : original;
  const cleaned = ktTrim(stripped);
  return ktIsBlank(cleaned) ? ktTrim(original) : cleaned;
}
