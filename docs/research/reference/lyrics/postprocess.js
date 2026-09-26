// Mirrors BitChord's lyric post-processing and timing helpers:
//   data/lyrics/BackgroundVocals.kt  - withBackgroundVocals (trailing "(echo)" -> background line)
//   data/lyrics/LyricGaps.kt         - withInstrumentalGaps, MIN_GAP_MS
//   data/lyrics/LyricAlignments.kt   - lineAlignments (duet sides)
//   data/lyrics/LyricLine.kt         - isGap, hasKnownEnd, endMs
//   ui/player/PlayerLyrics.kt        - adjustedLyricsPosition / adjustedLyricsSeekTarget, scrollLead
//   ui/player/LyricsOffsetSheet.kt + data/settings/AppSettings.kt - offset range and step
//   ui/player/LyricFocus.kt          - activeLyricRows
//   ui/player/LyricClock.kt          - LyricClockReconciler
//
// Independent JavaScript re-implementation of the mechanism documented in
// BITCHORD_ENGINE_RESEARCH.md (BitChord itself is GPL-3.0).
//
// Every function is pure and returns new objects; input lines are never mutated.
// Lines use the shape in ./model.js.

import { line as makeLine } from './model.js';
import { ktTrim, ktTrimEnd } from './query.js';

// ---------------------------------------------------------------------------
// LyricLine.kt timing helpers
// ---------------------------------------------------------------------------

/** LyricLine.kt:55 - a blank *empty* text is an instrumental gap ("" only, not "  "). */
export const isGap = (l) => l.text === '';

/** LyricLine.kt:57 */
export const isWordSyncedLine = (l) => Array.isArray(l.words) && l.words.length > 0;

/**
 * LyricLine.kt:121 - whether anything said when the singing *stops*: word
 * timings do, and so does a provider-stated line end (sungUntilMs). The
 * distance to the next stamp is deliberately not evidence of an end.
 */
export const hasKnownEnd = (l) => isWordSyncedLine(l) || l.sungUntilMs != null;

/**
 * LyricLine.kt:132-136 - last word's end, else the stated end, else the line's
 * own stamp; extended by the background (answering) vocal, which routinely
 * holds past the lead's last word.
 * @returns {number}
 */
export function endMs(l) {
  const lead = isWordSyncedLine(l) ? l.words[l.words.length - 1].endMs : (l.sungUntilMs ?? l.timeMs);
  return Math.max(lead, l.background ? endMs(l.background) : lead);
}

/** `lines.indexOfLast { it.timeMs <= positionMs }` - the cursor rule used everywhere. */
export function currentLineIndex(lines, positionMs) {
  for (let i = lines.length - 1; i >= 0; i--) if (lines[i].timeMs <= positionMs) return i;
  return -1;
}

// ---------------------------------------------------------------------------
// BackgroundVocals.kt
// ---------------------------------------------------------------------------

/**
 * Pulls a trailing bracketed answering vocal out of each line and hangs it
 * under the lead as `background` (BackgroundVocals.kt:27-67).
 *
 * Rules, in order, per line:
 *  1. Lines that already carry a background (Apple TTML marks `ttm:role="x-bg"`
 *     structurally) and gaps are left alone.
 *  2. The text must END with ')' ; the matching '(' is found walking back and
 *     counting depth, so "lead (echo (twice))" splits at the OUTER bracket.
 *     A line that is entirely bracketed (bracket at index 0) is left alone.
 *     Only round brackets count.
 *  3. lead = text before the bracket (trimEnd), backing = bracket onwards (trim).
 *     Nothing happens if the lead is empty or the backing has no letter/digit
 *     ("lead words (!)" stays as it is).
 *  4. Line-synced line (no words): both halves share the line's stamp; the
 *     background also inherits sungUntilMs (it is the line's end too).
 *  5. Word-synced line: the bracket must open on a word boundary; words from
 *     that word on move to the background, whose timeMs is its first word's
 *     start. A bracket opening mid-word ("wait(ing)") or on the first word is
 *     left alone.
 * Parentheses are kept on the background text - that is what LRC export
 * writes back out (LrcWriter.flattened).
 *
 * @param {import('./model.js').LyricLine[]} lines
 * @returns {import('./model.js').LyricLine[]}
 */
export function withBackgroundVocals(lines) {
  return lines.map(splitTrailingBracket);
}

function splitTrailingBracket(l) {
  if (l.background != null || isGap(l)) return l;

  const open = bracketStart(l.text);
  if (open == null) return l;
  const lead = ktTrimEnd(l.text.substring(0, open));
  const backing = ktTrim(l.text.substring(open));
  if (lead === '' || !hasLetterOrDigit(backing)) return l;

  if (!isWordSyncedLine(l)) {
    return {
      ...l,
      text: lead,
      background: makeLine(l.timeMs, backing, [], { sungUntilMs: l.sungUntilMs ?? null }),
    };
  }

  const split = indexOfWordStartingAt(l.words, l.text, open);
  if (split == null || split <= 0) return l;
  const backingWords = l.words.slice(split);
  return {
    ...l,
    text: lead,
    words: l.words.slice(0, split),
    background: makeLine(backingWords[0].startMs, backing, backingWords),
  };
}

/**
 * BackgroundVocals.kt:92-105. Index of the '(' matching the final ')', or null.
 * Works on UTF-16 units like the Kotlin loop.
 */
function bracketStart(text) {
  if (!text.endsWith(')')) return null;
  let depth = 0;
  for (let index = text.length - 1; index >= 0; index--) {
    const ch = text[index];
    if (ch === ')') depth++;
    else if (ch === '(') {
      depth--;
      if (depth === 0) return index > 0 ? index : null;
    }
  }
  return null;
}

/**
 * Index of the word that starts at character `offset` of `text`, or null.
 *
 * BackgroundVocals.kt:73-82 computes word offsets arithmetically
 * (`at += word.text.length + 1`), relying on every Kotlin word-synced parser
 * building `text` as the words joined by single spaces. This walks the words
 * through the text instead (the same walk as LyricLine.wordSpans,
 * LyricLine.kt:67-75), which yields identical offsets for that Kotlin shape and
 * stays correct for the reference model's convention, where a word may carry
 * its own trailing space or be a glued syllable.
 */
function indexOfWordStartingAt(words, text, offset) {
  let from = 0;
  for (let index = 0; index < words.length; index++) {
    const found = text.indexOf(words[index].text, from);
    const start = found >= 0 ? found : from;
    if (start === offset) return index;
    if (start > offset) return null;
    from = start + words[index].text.length;
  }
  return null;
}

/** Kotlin `any { it.isLetterOrDigit() }` over UTF-16 units: categories L* or Nd. */
const LETTER_OR_DIGIT = /^[\p{L}\p{Nd}]$/u;
function hasLetterOrDigit(s) {
  for (let i = 0; i < s.length; i++) if (LETTER_OR_DIGIT.test(s[i])) return true;
  return false;
}

// ---------------------------------------------------------------------------
// LyricGaps.kt
// ---------------------------------------------------------------------------

/** LyricGaps.kt:4 - shorter instrumental breaks are not worth interrupting the line for. */
export const MIN_GAP_MS = 4_000;

/**
 * Inserts empty "gap" lines for instrumental stretches (LyricGaps.kt:18-34).
 *
 *  - Intro: if the first line starts at >= 4 s, a gap is prepended at 0
 *    (even if that first line is itself a gap - the Kotlin does not check).
 *  - Between lines: only after a line whose END is known (word timings or a
 *    stated sungUntilMs; background included, see endMs). If
 *    next.timeMs - endMs >= 4000 AND endMs > line.timeMs, a gap is inserted
 *    at endMs - so the note appears the moment the vocal stops, not when the
 *    next line is due. A gap that would share its line's stamp is never
 *    inserted (the cursor could never reach the words).
 *  - Line-synced lines without a stated end never get a gap: the distance to
 *    the next stamp is the line's own slot, not silence.
 *
 * Applied inside providers (TtmlLyrics.kt:81, LyricsPlus.kt:142, PaxSenix.kt:235,
 * ProviderLyrics.kt:110, Musixmatch.kt:210, EnhancedLrc.kt:60), not by the
 * repository; LRC parsing has its own stamp-based variant (LrcLib.parseLrc).
 */
export function withInstrumentalGaps(lines) {
  if (lines.length === 0) return lines;
  const out = [];
  if (lines[0].timeMs >= MIN_GAP_MS) out.push(makeLine(0, ''));
  for (let index = 0; index < lines.length; index++) {
    const l = lines[index];
    out.push(l);
    const next = lines[index + 1];
    if (next === undefined || !hasKnownEnd(l)) continue;
    const end = endMs(l);
    if (next.timeMs - end >= MIN_GAP_MS && end > l.timeMs) out.push(makeLine(end, ''));
  }
  return out;
}

// ---------------------------------------------------------------------------
// LyricAlignments.kt
// ---------------------------------------------------------------------------

const PERSON = 'person';
const GROUP = 'group';
const OTHER = 'other';
/** Apple's reserved agents: everyone at once, and "the other singer". */
const GROUP_AGENT = 'v1000';
const OTHER_AGENT = 'v2000';
/** LyricAlignments.kt:17 - a Float in Kotlin; compared in float precision below. */
const MOSTLY_RIGHT = Math.fround(0.85);

/**
 * Which side each line is sung from, given who sang it (LyricAlignments.kt:39-73).
 *
 *  - No singer -> 'start' (not counted).
 *  - Type = declared type, else v1000 -> group, v2000 -> other, else person.
 *  - Group lines -> 'start', counted in the total, but they do not change whose
 *    turn it is.
 *  - The first voiced line goes left unless its type is 'other'; after that the
 *    side flips every time the voice changes (so a three-voice song alternates
 *    rather than stacking two voices on one side).
 *  - If >= 85 % of counted lines ended up on the right, the whole song is
 *    flipped - including group and unassigned lines, which then sit on the
 *    right (the Kotlin flips every entry).
 *
 * Called by TtmlLyrics (agents from <ttm:agent>) and LyricsPlus (element.singer).
 *
 * @param {(string|null|undefined)[]} singers  voice id per line, in line order
 * @param {Map<string,string>|Record<string,string>} [types]  voice id -> person|group|other
 * @returns {('start'|'end')[]}
 */
export function lineAlignments(singers, types = {}) {
  const typeOf = (singer) => (types instanceof Map
    ? types.get(singer)
    : (Object.prototype.hasOwnProperty.call(types, singer) ? types[singer] : undefined));
  let left = true;
  let lastVoice = null;
  let rightward = 0;
  let placed = 0;

  const sides = singers.map((singer) => {
    if (singer == null || singer === '') return 'start';
    const type = typeOf(singer) ?? (singer === GROUP_AGENT ? GROUP : singer === OTHER_AGENT ? OTHER : PERSON);
    placed += 1;
    if (type === GROUP) return 'start';
    if (lastVoice === null) left = type !== OTHER;
    else if (singer !== lastVoice) left = !left;
    lastVoice = singer;
    if (!left) rightward += 1;
    return left ? 'start' : 'end';
  });

  if (placed === 0 || Math.fround(rightward / placed) < MOSTLY_RIGHT) return sides;
  return sides.map((side) => (side === 'start' ? 'end' : 'start'));
}

// ---------------------------------------------------------------------------
// Sync offset (PlayerLyrics.kt:462-466, LyricsOffsetSheet.kt, AppSettings.kt)
// ---------------------------------------------------------------------------

/** AppSettings.kt:1918-1919 - one global offset, clamped to +-5 s. */
export const MIN_LYRICS_OFFSET_MS = -5_000;
export const MAX_LYRICS_OFFSET_MS = 5_000;
/** LyricsOffsetSheet.kt:71 - the +/- buttons and the slider snap to 100 ms. */
export const LYRICS_OFFSET_STEP_MS = 100;

/** AppSettings.setLyricsOffsetMs (AppSettings.kt:1294-1299): coerceIn(-5000, 5000). */
export function normalizeLyricsOffset(offsetMs) {
  const v = Math.trunc(Number(offsetMs) || 0);
  return Math.min(MAX_LYRICS_OFFSET_MS, Math.max(MIN_LYRICS_OFFSET_MS, v));
}

/** LyricsOffsetSheet.kt:272-277 - slider fraction -> offset, snapped to 100 ms. */
export function offsetFromSliderFraction(fraction) {
  const f = Math.min(1, Math.max(0, Number(fraction) || 0));
  const raw = MIN_LYRICS_OFFSET_MS + f * (MAX_LYRICS_OFFSET_MS - MIN_LYRICS_OFFSET_MS);
  return Math.round(raw / LYRICS_OFFSET_STEP_MS) * LYRICS_OFFSET_STEP_MS;
}

/**
 * PlayerLyrics.kt:462-463. BitChord applies the offset to the *clock*, not the
 * lines: positive delays the lyrics, negative brings them forward, never below 0.
 */
export function adjustedLyricsPosition(positionMs, offsetMs) {
  return Math.max(0, positionMs - offsetMs);
}

/** PlayerLyrics.kt:465-466 - tapping a line seeks to its stamp plus the offset. */
export function adjustedLyricsSeekTarget(lineTimeMs, offsetMs) {
  return Math.max(0, lineTimeMs + offsetMs);
}

/**
 * The line-side equivalent of adjustedLyricsPosition, for consumers that cannot
 * adjust their clock: every line, word, stated end and background is moved by
 * +offsetMs (clamped at 0).
 *
 * Equivalence: for any line stamped at or after |offsetMs|,
 *   line.timeMs <= adjustedLyricsPosition(p, off)  <=>  shifted.timeMs <= p.
 * The two differ only inside the first |offsetMs| of the song, where BitChord's
 * clock clamps at 0 (so a positive offset cannot delay a line stamped at 0:00).
 * Unsynced (plain) lyrics are returned unchanged - shifting them would make them
 * look line-synced, and BitChord's clock-side offset never touches them either.
 *
 * @param {import('./model.js').LyricLine[]} lines
 * @param {number} offsetMs
 */
export function applyOffset(lines, offsetMs) {
  const delta = Math.trunc(Number(offsetMs) || 0);
  if (delta === 0) return lines;
  // The player's own test for "synced" (PlayerLyrics.kt:1426, 2191).
  if (!lines.some((l) => l.timeMs > 0)) return lines;
  return lines.map((l) => shiftLine(l, delta));
}

function shiftLine(l, delta) {
  const shift = (t) => Math.max(0, t + delta);
  return {
    ...l,
    timeMs: shift(l.timeMs),
    words: (l.words ?? []).map((w) => ({ ...w, startMs: shift(w.startMs), endMs: shift(w.endMs) })),
    sungUntilMs: l.sungUntilMs == null ? null : shift(l.sungUntilMs),
    background: l.background ? shiftLine(l.background, delta) : null,
  };
}

// ---------------------------------------------------------------------------
// Which rows are live (LyricFocus.kt) and how early the panel scrolls (PlayerLyrics.kt)
// ---------------------------------------------------------------------------

/**
 * LyricFocus.kt:6-15 - every row still being sung at positionMs. The latest
 * started line is always included; an earlier one stays while it is not a gap,
 * its end is known (its own or its background's), and positionMs < endMs.
 * The first entry is the scroll anchor. Plain LRC (no ends) never overlaps.
 */
export function activeLyricRows(lines, positionMs) {
  const latest = currentLineIndex(lines, positionMs);
  if (latest < 0) return [];
  const rows = [];
  for (let index = 0; index <= latest; index++) {
    const l = lines[index];
    if (index === latest || (!isGap(l)
      && (hasKnownEnd(l) || (l.background != null && hasKnownEnd(l.background)))
      && l.timeMs <= positionMs && positionMs < endMs(l))) {
      rows.push(index);
    }
  }
  return rows;
}

/** PlayerLyrics.kt:332-333 */
export const SCROLL_LEAD_MIN_MS = 350;
export const SCROLL_LEAD_MAX_MS = 500;

/**
 * PlayerLyrics.kt:377-391 - how far ahead of the next line the panel starts
 * scrolling: the silence between the current line's end and the next stamp,
 * clamped to [350, 500] ms. The sweep itself always uses the real clock.
 */
export function scrollLead(lines, positionMs) {
  const current = currentLineIndex(lines, positionMs);
  if (current < 0) return SCROLL_LEAD_MIN_MS;
  const next = lines[current + 1];
  if (next === undefined) return SCROLL_LEAD_MIN_MS;
  const gap = next.timeMs - endMs(lines[current]);
  return Math.min(SCROLL_LEAD_MAX_MS, Math.max(SCROLL_LEAD_MIN_MS, gap));
}

// ---------------------------------------------------------------------------
// LyricClock.kt
// ---------------------------------------------------------------------------

/** LyricClock.kt:47 - above one late 500 ms poll, below a meaningful seek. */
export const SEEK_DISCONTINUITY_MS = 1_250;

/**
 * Reconciles a frame-driven lyric clock with the player's ~500 ms position
 * reports (LyricClock.kt:14-41). A fresh report is compared with where the
 * *previous report* should have reached by now, not with the already-advanced
 * display clock, so delivery delay is not mistaken for a seek and words never
 * move backwards. A jump beyond 1.25 s, or any report while paused, resets the
 * clock to the report; otherwise the clock only moves forward.
 */
export class LyricClockReconciler {
  constructor(initialReportedMs, initialObservedAtMs, initialPlaying) {
    this.lastReportedMs = initialReportedMs;
    this.lastObservedAtMs = initialObservedAtMs;
    this.wasPlaying = initialPlaying;
  }

  reconcile(displayedMs, reportedMs, observedAtMs, isPlaying) {
    const elapsedMs = Math.max(0, observedAtMs - this.lastObservedAtMs);
    const expectedMs = this.lastReportedMs + (this.wasPlaying ? elapsedMs : 0);
    const discontinuity = !isPlaying || Math.abs(reportedMs - expectedMs) > SEEK_DISCONTINUITY_MS;
    this.lastReportedMs = reportedMs;
    this.lastObservedAtMs = observedAtMs;
    this.wasPlaying = isPlaying;
    return discontinuity ? reportedMs : Math.max(displayedMs, reportedMs);
  }
}
