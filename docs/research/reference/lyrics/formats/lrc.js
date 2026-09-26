// LRC reading and writing.
//
// Mirrors BitChord (commit fe198ac):
//   app/src/main/java/com/music/bitchord/data/lyrics/LrcLib.kt      parseLrc, parseWordRuns, stripAlignmentMarker
//   app/src/main/java/com/music/bitchord/data/lyrics/LrcWriter.kt   toLrc, toEnhancedLrc, clock
//   app/src/main/java/com/music/bitchord/data/lyrics/EnhancedLrc.kt parse, decodeEntities
//   app/src/main/java/com/music/bitchord/data/lyrics/LyricGaps.kt   MIN_GAP_MS, withInstrumentalGaps
//
// Independent JavaScript re-implementation of the mechanism documented in
// BITCHORD_ENGINE_RESEARCH.md (BitChord itself is GPL-3.0).
//
// Two LRC readers exist in BitChord and both are reproduced here:
//
//  - parseLrc()          <- LrcLib.parseLrc. The reader every line-synced source
//                           (LRCLIB, Musixmatch subtitles, KuGou, Megalobiz) and
//                           the embedded-file path go through. Reads plain LRC and
//                           the "enhanced" A2 word stamps.
//  - parseEnhancedLrc()  <- EnhancedLrc.parse. Only used for sources that are
//                           known to serve A2 (SimpMusic, Unison, ProviderLyrics);
//                           returns [] for a file with no word stamps so the
//                           caller can fall back to parseLrc().
//
// Deliberate deviations from LrcLib.parseLrc, all of them additions the Kotlin
// reader lacks (see the research notes for the corresponding defects):
//   1. Compressed lines "[00:12.00][00:45.00]Chorus" are expanded to one line
//      per stamp. BitChord uses the first stamp only and leaves "[00:45.00]"
//      in the displayed text.
//   2. "[offset:+/-ms]" is applied (positive = lyrics earlier, per the LRC
//      convention). BitChord ignores the tag; its only offset is the global
//      user setting applied at render time (PlayerLyrics.kt adjustedLyricsPosition).
//   3. "[mm:ss]" (no fraction), one-digit and 4+-digit fractions, and 3+-digit
//      minutes are read. BitChord's STAMP regex requires 1-2 minute digits and a
//      2-3 digit fraction and silently drops every other line, including the
//      "[100:00.00]" stamps its own LrcWriter emits past 99 minutes.
//   4. Stamps must lead the line (after optional whitespace/BOM). BitChord's
//      STAMP.find() accepts the first stamp anywhere in the line.

import { line } from '../model.js';

/** LyricGaps.kt: instrumental breaks shorter than this are not drawn. */
export const MIN_GAP_MS = 4_000;

/** LrcWriter.kt / LrcLib.kt: BitChord's own right-alignment (duet) marker, "<R>" after the stamp. */
export const ALIGNMENT_MARKER = '<R>';

/** LrcWriter.kt: the container tag name BitChord writes enhanced (A2) LRC under. */
export const WORD_LYRICS_FIELD = 'BITCHORD_LYRICS';

/** EnhancedLrc.kt TAIL_MS: the closing word of a song with no next line runs this long. */
export const ENHANCED_TAIL_MS = 800;

// A line stamp at the very start of the (left-trimmed) remainder.
const LINE_STAMP = /^\[(\d+):(\d{1,2})(?:[.:](\d+))?\]/;
// A2 word stamp: <mm:ss.xx>, <mm:ss.xxx>, <mm:ss:xx>, <m:ss>.
const WORD_STAMP = /<(\d+):(\d{1,2})(?:[.:](\d+))?>/g;
const OFFSET_TAG = /^\s*\[offset:\s*([+-]?\d+)\s*\]/i;

/**
 * "m", "ss", "fraction" -> milliseconds. The fraction is a decimal fraction of
 * a second: two digits are centiseconds and three are milliseconds, exactly as
 * LrcLib.kt reads them; one digit is tenths, and digits past the third are
 * truncated.
 */
function stampMs(minutes, seconds, fraction) {
  const fractionMs = fraction ? Number((fraction + '00').slice(0, 3)) : 0;
  return Number(minutes) * 60_000 + Number(seconds) * 1_000 + fractionMs;
}

/**
 * The <mm:ss.xx> runs of an A2 line body, as words (LrcLib.parseWordRuns).
 *
 * Each run ends where the next one starts, so a trailing bare stamp is a
 * terminator that names no word but gives the last word its end. A run with
 * blank text is skipped. With no terminator the last word ends at its own
 * start (zero length) - that is BitChord's LrcLib behaviour, kept on purpose.
 * Text before the first word stamp belongs to the line but to no word.
 * Word text is trimmed, as in BitChord.
 *
 * @param {string} body  Line text after the line stamp(s) and alignment marker.
 * @returns {import('../model.js').LyricWord[]}
 */
export function parseWordRuns(body) {
  const marks = [...body.matchAll(WORD_STAMP)];
  if (marks.length === 0) return [];
  const runs = marks.map((mark, i) => {
    const until = i + 1 < marks.length ? marks[i + 1].index : body.length;
    return { startMs: stampMs(mark[1], mark[2], mark[3]), text: body.slice(mark.index + mark[0].length, until) };
  });
  const words = [];
  runs.forEach((run, i) => {
    if (run.text.trim() === '') return;
    const endMs = i + 1 < runs.length ? runs[i + 1].startMs : run.startMs;
    words.push({ startMs: run.startMs, endMs: Math.max(endMs, run.startMs), text: run.text.trim() });
  });
  return words;
}

/** Stable sort by timeMs (Kotlin's sortedBy is stable; so is Array#sort since ES2019). */
function byTime(lines) {
  return [...lines].sort((a, b) => a.timeMs - b.timeMs);
}

/**
 * Parse LRC text (plain or enhanced/A2) into lines.
 *
 * - Lines with no leading time stamp are ignored, which drops every metadata
 *   tag ([ar:], [ti:], [al:], [by:], [length:], [re:], [ve:], [id:], [#:]).
 * - "[offset:N]" shifts every stamp by -N ms (clamped at 0).
 * - A stamp with no text is an instrumental gap (text ''). As in BitChord a gap
 *   survives only if it is the last line or the next line starts at least
 *   `minGapMs` later; and when the first sung line starts at or after
 *   `minGapMs`, a gap at 0 is prepended so the intro has a line of its own.
 * - "<R>" right after the stamp marks a right-aligned (second singer) line.
 * - Output is sorted by timeMs (stable, so equal stamps keep file order).
 *
 * @param {string} text
 * @param {{ minGapMs?: number }} [options]
 * @returns {import('../model.js').LyricLine[]}
 */
export function parseLrc(text, { minGapMs = MIN_GAP_MS } = {}) {
  const rows = String(text ?? '').replace(/^﻿/, '').split(/\r\n|\r|\n/);

  // "[offset:]" applies to the whole file wherever it sits; the first one wins.
  let offsetMs = 0;
  for (const row of rows) {
    const m = OFFSET_TAG.exec(row);
    if (m) {
      offsetMs = Number(m[1]);
      break;
    }
  }

  const all = [];
  for (const row of rows) {
    let rest = row.replace(/^\s+/, '');
    const stamps = [];
    for (;;) {
      const m = LINE_STAMP.exec(rest);
      if (!m) break;
      stamps.push(stampMs(m[1], m[2], m[3]));
      rest = rest.slice(m[0].length);
      // Tolerate "[00:01.00] [00:30.00]text": whitespace between two stamps.
      const gap = /^\s*/.exec(rest)[0];
      if (gap && LINE_STAMP.test(rest.slice(gap.length))) rest = rest.slice(gap.length);
    }
    if (stamps.length === 0) continue;

    let body = rest;
    let alignment = 'start';
    if (body.startsWith(ALIGNMENT_MARKER)) {
      body = body.slice(ALIGNMENT_MARKER.length);
      alignment = 'end';
    }
    // The line's own text keeps the source's spacing/punctuation between words:
    // only the word stamps are removed (LrcLib.kt, "Stripped rather than rebuilt").
    const lineText = body.replace(WORD_STAMP, '').trim();
    const words = parseWordRuns(body);

    // Word stamps are absolute; a compressed line repeats them relative to its
    // first stamp.
    const first = stamps[0];
    for (const stamp of stamps) {
      const shift = stamp - first - offsetMs;
      all.push(
        line(
          Math.max(0, stamp - offsetMs),
          lineText,
          words.map((w) => ({
            startMs: Math.max(0, w.startMs + shift),
            endMs: Math.max(0, w.endMs + shift),
            text: w.text,
          })),
          { alignment },
        ),
      );
    }
  }

  const sorted = byTime(all);
  const kept = sorted.filter((l, i) => {
    if (l.text !== '') return true;
    const next = sorted[i + 1];
    // A trailing stamp closes off the last line - that's the outro.
    if (!next) return true;
    return next.timeMs - l.timeMs >= minGapMs;
  });

  // LRC starts at the first sung word; give a long run-up its own break.
  const head = kept[0];
  if (head && head.text !== '' && head.timeMs > 0 && head.timeMs >= minGapMs) {
    return [line(0, ''), ...kept];
  }
  return kept;
}

/**
 * EnhancedLrc.decodeEntities: SimpMusic and Megalobiz serve HTML-escaped text.
 * "&amp;" is decoded last so "&amp;#x27;" does not decode twice.
 *
 * Deviation: BitChord maps a numeric entity through Int.toChar(), which keeps
 * only the low 16 bits and so mangles astral code points (emoji); this uses
 * String.fromCodePoint and U+FFFD for out-of-range values.
 */
export function decodeLrcEntities(text) {
  const s = String(text);
  if (!s.includes('&')) return s;
  const cp = (n) => (Number.isInteger(n) && n >= 0 && n <= 0x10ffff ? String.fromCodePoint(n) : '�');
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => cp(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => cp(parseInt(dec, 10)))
    .replaceAll('&apos;', "'")
    .replaceAll('&quot;', '"')
    .replaceAll('&nbsp;', ' ')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&');
}

/**
 * EnhancedLrc.parse: the A2-specific reader. Returns [] when nothing in the
 * file carries a word stamp. Differences from parseLrc(), reproduced as-is:
 * each line must match ^[stamp](.*)$ after trimming (one stamp, 2-digit
 * seconds, 2-3 digit fraction); entities are decoded; the line text is
 * rebuilt as the words joined by single spaces; the line starts at the earlier
 * of its stamp and its first word; an unterminated last word runs to the next
 * line's stamp (or ENHANCED_TAIL_MS past its start at the end of the file);
 * blank rows are dropped and gaps are re-derived by withInstrumentalGaps().
 */
export function parseEnhancedLrc(lrc) {
  const LINE = /^\[(\d{1,3}):(\d{2})[.:](\d{2,3})\](.*)$/;
  const WORD = /<(\d{1,3}):(\d{2})[.:](\d{2,3})>([^<]*)/g;
  const ms = (m, s, f) => Number(m) * 60_000 + Number(s) * 1_000 + (f.length === 3 ? Number(f) : Number(f) * 10);

  const rows = [];
  for (const raw of String(lrc ?? '').split(/\r\n|\r|\n/)) {
    const m = LINE.exec(raw.trim());
    if (!m) continue;
    rows.push({ timeMs: ms(m[1], m[2], m[3]), words: [...m[4].matchAll(WORD)], plain: m[4].trim() });
  }
  rows.sort((a, b) => a.timeMs - b.timeMs);
  if (!rows.some((r) => r.words.length > 0)) return [];

  const out = [];
  rows.forEach((row, index) => {
    if (row.words.length === 0) {
      const text = decodeLrcEntities(row.plain);
      if (text !== '') out.push(line(row.timeMs, text));
      return;
    }
    const lastWord = row.words[row.words.length - 1];
    const lineEnd = index + 1 < rows.length
      ? rows[index + 1].timeMs
      : ms(lastWord[1], lastWord[2], lastWord[3]) + ENHANCED_TAIL_MS;
    const words = [];
    row.words.forEach((match, i) => {
      const text = decodeLrcEntities(match[4]).trim();
      if (text === '') return;
      const start = ms(match[1], match[2], match[3]);
      const nextMatch = row.words[i + 1];
      const end = nextMatch ? ms(nextMatch[1], nextMatch[2], nextMatch[3]) : lineEnd;
      words.push({ startMs: start, endMs: Math.max(end, start), text });
    });
    if (words.length === 0) return;
    out.push(line(Math.min(row.timeMs, words[0].startMs), words.map((w) => w.text).join(' '), words));
  });
  return withInstrumentalGaps(out);
}

// ---- Line helpers shared with the providers (LyricLine.kt / LyricGaps.kt) ----

/** LyricLine.hasKnownEnd: word timings or a provider-stated line end. */
export const hasKnownEnd = (l) => (l.words?.length ?? 0) > 0 || l.sungUntilMs != null;

/** LyricLine.endMs: last word's end, else sungUntilMs, else timeMs; the background vocal counts. */
export function lineEndMs(l) {
  const words = l.words ?? [];
  const lead = words.length > 0 ? words[words.length - 1].endMs : (l.sungUntilMs ?? l.timeMs);
  return Math.max(lead, l.background ? lineEndMs(l.background) : lead);
}

/**
 * LyricGaps.withInstrumentalGaps: an intro gap when the first line starts at
 * or after MIN_GAP_MS, and a gap at a line's known end when the silence before
 * the next line is at least MIN_GAP_MS. Lines with no known end get no gap
 * after them (the stamp-to-stamp distance is the line's slot, not silence).
 */
export function withInstrumentalGaps(lines, { minGapMs = MIN_GAP_MS } = {}) {
  if (lines.length === 0) return lines;
  const out = [];
  if (lines[0].timeMs >= minGapMs) out.push(line(0, ''));
  lines.forEach((l, i) => {
    out.push(l);
    const next = lines[i + 1];
    if (!next || !hasKnownEnd(l)) return;
    const end = lineEndMs(l);
    // A marker sharing its line's stamp could never be reached by the cursor.
    if (next.timeMs - end >= minGapMs && end > l.timeMs) out.push(line(end, ''));
  });
  return out;
}

// ---- Writer (LrcWriter.kt) ---------------------------------------------------

/**
 * LrcWriter.clock: "mm:ss.cc". Truncated (never rounded) to centiseconds,
 * minutes not wrapped at 99, negatives clamped to 0, ASCII digits always.
 */
export function formatLrcClock(timeMs) {
  const total = Math.max(0, Math.floor(timeMs));
  const minutes = String(Math.floor(total / 60_000)).padStart(2, '0');
  const seconds = String(Math.floor((total % 60_000) / 1_000)).padStart(2, '0');
  const centis = String(Math.floor((total % 1_000) / 10)).padStart(2, '0');
  return `${minutes}:${seconds}.${centis}`;
}

const stamp = (t) => `[${formatLrcClock(t)}]`;
const wordStamp = (t) => `<${formatLrcClock(t)}>`;

/** LrcWriter.flattened: the answering (background) vocal rides on the end of its lead. */
function flattened(l) {
  return l.background ? `${l.text} ${l.background.text}`.trim() : l.text;
}

/** LrcWriter.timedRuns: lead words, then the background's; nothing without lead words. */
function timedRuns(l) {
  if (!l.words || l.words.length === 0) return [];
  const bg = l.background;
  let answer = [];
  if (bg) {
    if (bg.words && bg.words.length > 0) answer = bg.words;
    else if (bg.text.trim() !== '') answer = [{ startMs: bg.timeMs, endMs: lineEndMs(bg), text: bg.text }];
  }
  return [...l.words, ...answer];
}

/**
 * LrcWriter.enhancedBody: "<R>" for a right-aligned line, then one
 * "<start>word" run per word (starts clamped so they never run backwards),
 * then a bare closing stamp carrying the line's end.
 *
 * Deviation: word text is trimmed before writing. BitChord's words are always
 * trimmed already; the JS model allows a trailing space, which would otherwise
 * double the separator.
 */
function enhancedBody(l) {
  const runs = timedRuns(l);
  if (runs.length === 0) return flattened(l);
  let out = l.alignment === 'end' ? ALIGNMENT_MARKER : '';
  let previous = l.timeMs;
  runs.forEach((w, i) => {
    const start = Math.max(w.startMs, previous);
    out += wordStamp(start) + String(w.text).trim();
    if (i !== runs.length - 1) out += ' ';
    previous = start;
  });
  out += wordStamp(Math.max(Math.max(...runs.map((w) => w.endMs)), previous));
  return out;
}

/**
 * Write lines as LRC (LrcWriter.toLrc / toEnhancedLrc).
 *
 * Plain (default): "[mm:ss.cc]text" per line, sorted, word timings dropped
 * (a reader without A2 shows "<00:01.00>" instead of skipping it); no
 * [ti:]/[ar:]/[al:] header; gaps are bare stamps; if no line has timeMs > 0
 * the output is the plain text rows with no stamps at all.
 *
 * { enhanced: true }: the A2 form BitChord stores under BITCHORD_LYRICS; ''
 * when no line (or background) is word-synced. Lines without words are
 * written as plain stamped text.
 *
 * @param {import('../model.js').LyricLine[]} lines
 * @param {{ enhanced?: boolean }} [options]
 */
export function writeLrc(lines, { enhanced = false } = {}) {
  if (!lines || lines.length === 0) return '';
  if (enhanced) {
    const wordSynced = lines.some((l) => (l.words?.length ?? 0) > 0 || (l.background?.words?.length ?? 0) > 0);
    if (!wordSynced) return '';
    return byTime(lines).map((l) => stamp(l.timeMs) + enhancedBody(l)).join('\n');
  }
  if (!lines.some((l) => l.timeMs > 0)) return lines.map(flattened).join('\n');
  return byTime(lines).map((l) => stamp(l.timeMs) + flattened(l)).join('\n');
}
