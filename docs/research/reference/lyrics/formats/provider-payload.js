// Reads the loosely specified payloads of the smaller lyric providers
// (BetterLyrics, BetterLyrics Portato, PaxSenix): peel off JSON envelopes,
// sniff the format, hand it to the right parser.
//
// Mirrors BitChord's data/lyrics/ProviderLyrics.kt: `ProviderLyrics.parse`,
// `unwrap`, `extract`, `plain`, and the `KaraokeLrc` reader for QQ Music QRC
// and NetEase YRC karaoke timing defined in the same file. LRC and enhanced
// (A2) LRC are read by ./lrc.js; TTML by ./ttml.js.
// Independent JavaScript re-implementation of the mechanism documented in
// BITCHORD_ENGINE_RESEARCH.md (BitChord itself is GPL-3.0).
//
// Deliberate differences from ProviderLyrics.kt:
//  - `syncedLyrics` is tried before `plainLyrics`. BitChord's CONTENT_KEYS has
//    them the other way round, so an envelope carrying both (LRCLIB's shape,
//    e.g. a PaxSenix lrcget candidate) yields the unsynced text there.
//  - BitChord decodes JSON leniently (kotlinx `isLenient`), so a body that is a
//    single bare word parses as an unquoted JSON literal and is discarded;
//    here JSON.parse fails on it and it is read as plain text.

import { line } from '../model.js';
import { withInstrumentalGaps } from '../postprocess.js';
import { decodeLrcEntities, parseEnhancedLrc, parseLrc } from './lrc.js';
import { parseTtml } from './ttml.js';

/**
 * Keys that may hold the lyric document, in the order they are tried
 * (ProviderLyrics.kt:68-72, except that `syncedLyrics` is moved ahead of
 * `plainLyrics` — see the header).
 */
export const CONTENT_KEYS = Object.freeze([
  'ttml', 'ttmlContent', 'lyrics', 'lrc', 'content', 'text',
  'syncedLyrics', 'plainLyrics', 'line', 'lines', 'lyric',
  'data', 'result', 'response',
]);

/**
 * Any provider body → lines, or null when it holds no lyric text
 * (ProviderLyrics.kt:12-23). Decision order:
 *  1. TTML  — `<tt` followed by whitespace or `>`, or the TTML namespace URI.
 *  2. QQ QRC / NetEase YRC karaoke — `[start,duration]` lines with `(start,duration)` word stamps.
 *  3. Any other markup (an HTML error page, say) — nothing.
 *  4. Enhanced LRC, else LRC, else plain text.
 * @param {string} raw
 * @returns {import('../model.js').LyricLine[]|null}
 */
export function parseProviderLyrics(raw) {
  const unwrapped = unwrapPayload(raw);
  if (unwrapped == null) return null;
  const content = unescapeTtml(unwrapped);

  let lines;
  if (/<tt(?:\s|>)/i.test(content) || content.toLowerCase().includes('http://www.w3.org/ns/ttml')) {
    lines = parseTtml(content);
  } else if (looksLikeKaraokeLrc(content)) {
    lines = parseKaraokeLrc(content);
  } else if (content.trimStart().startsWith('<')) {
    lines = [];
  } else {
    lines = parseEnhancedLrc(content);
    if (lines.length === 0) lines = parseLrc(content);
    if (lines.length === 0) lines = plain(content);
  }
  return lines.some((l) => l.text.trim() !== '') ? lines : null;
}

/**
 * The lyric string inside one or more JSON envelopes, or the body itself when
 * it is not JSON (ProviderLyrics.kt:33-43). Strips BOMs and a Markdown code
 * fence first. Returns null for a blank body or an envelope that is an error
 * or carries no content.
 * @param {string} raw
 * @returns {string|null}
 */
export function unwrapPayload(raw) {
  let value = String(raw ?? '').replaceAll('﻿', '').trim();
  if (value.startsWith('```')) {
    let rows = value.split(/\r\n|\r|\n/).slice(1);
    if (rows.length > 0 && rows[rows.length - 1].trim() === '```') rows = rows.slice(0, -1);
    value = rows.join('\n').trim();
  }
  if (value === '') return null;
  const json = tryJson(value);
  if (json === NOT_JSON) return value;
  const found = extract(json)?.trim();
  return found ? found : null;
}

const NOT_JSON = Symbol('not json');

function tryJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return NOT_JSON;
  }
}

/** ProviderLyrics.kt:45-61. */
function extract(element) {
  if (element === null || element === undefined) return null;
  if (typeof element === 'string') {
    // A string may itself be a serialised envelope ("double-wrapped").
    const text = element.trim();
    const nested = tryJson(text);
    return nested !== NOT_JSON && nested !== null && typeof nested === 'object' ? extract(nested) : text;
  }
  if (typeof element !== 'object') return null; // numbers and booleans carry no lyrics
  if (Array.isArray(element)) {
    const joined = element.map(extract).filter((v) => v != null).join('\n');
    return joined.trim() === '' ? null : joined;
  }
  if (isErrorEnvelope(element)) return null;
  for (const key of CONTENT_KEYS) {
    if (!Object.hasOwn(element, key)) continue;
    const found = extract(element[key]);
    if (found != null) return found;
  }
  const metadata = Object.hasOwn(element, 'metadata') ? element.metadata : null;
  if (metadata && typeof metadata === 'object' && !Array.isArray(metadata)) {
    const found = extract(metadata);
    if (found != null) return found;
  }
  return Object.hasOwn(element, 'words') ? extract(element.words) : null;
}

/** `isError: true`, `ok: false`, or any `error` other than null / false / "" (ProviderLyrics.kt:54-56). */
function isErrorEnvelope(object) {
  if (object.isError === true || object.ok === false) return true;
  if (!Object.hasOwn(object, 'error')) return false;
  const error = object.error;
  return error !== null && error !== false && error !== '';
}

/** TTML that arrived entity-escaped inside a string (ProviderLyrics.kt:63-66). */
function unescapeTtml(value) {
  if (!/&lt;tt/i.test(value)) return value;
  return value
    .replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'").replaceAll('&apos;', "'").replaceAll('&amp;', '&');
}

/**
 * Untimed text, one line per row (ProviderLyrics.kt:25-30). A body that reads
 * like an error message is rejected outright — note the test is for the word
 * "error" anywhere, so a plain lyric containing it is rejected too. Rows that
 * look like LRC metadata tags ("[ar:Artist]") are dropped.
 */
function plain(content) {
  if (/\b(?:lyrics? (?:not found|unavailable)|error)\b/i.test(content)) return [];
  return content.split(/\r\n|\r|\n/)
    .map((row) => row.trim())
    .filter((row) => row !== '' && !/^\[[A-Za-z]+:.*\]$/.test(row))
    .map((row) => line(0, row));
}

// ---------------------------------------------------------------------------
// KaraokeLrc: QQ Music QRC and NetEase YRC (ProviderLyrics.kt:75-123)
//
// A line is `[lineStartMs,lineDurationMs]` followed by words stamped in
// milliseconds, either before the word (NetEase YRC: `(start,dur,0)word`) or
// after it (QQ QRC: `word(start,dur)`). QQ's XML wraps the text in a
// `LyricContent="..."` attribute.

const K_LINE = /^\[(\d{1,8}),(\d{1,8})\](.*)$/;
const K_PREFIX_WORD = /\((\d{1,8}),(\d{1,8})(?:,\d{1,8})?\)([^()]*)/g;
const K_SUFFIX_WORD = /([^()]*)\((\d{1,8}),(\d{1,8})(?:,\d{1,8})?\)/g;
const K_WORD_TIME = /\(\d{1,8},\d{1,8}(?:,\d{1,8})?\)/g;
const K_CONTENT = /LyricContent\s*=\s*"([^"]*)"/i;

/** Whether any row is a karaoke line with at least one word stamp. */
export function looksLikeKaraokeLrc(raw) {
  return lyricContent(raw).split(/\r\n|\r|\n/).some((row) => {
    const m = K_LINE.exec(row.trim());
    if (!m) return false;
    return new RegExp(K_PREFIX_WORD.source).test(m[3]) || new RegExp(K_SUFFIX_WORD.source).test(m[3]);
  });
}

/**
 * Karaoke rows → word-synced lines. Each row is read both ways (stamp before,
 * stamp after the word) and the reading that attaches more text to stamps
 * wins, ties going to the prefix form. The row's own duration becomes the
 * line's stated end; the text keeps the source spacing with stamps removed.
 * @param {string} raw
 * @returns {import('../model.js').LyricLine[]}
 */
export function parseKaraokeLrc(raw) {
  const rows = [];
  for (const source of lyricContent(raw).split(/\r\n|\r|\n/)) {
    const m = K_LINE.exec(source.trim());
    if (!m) continue;
    const lineStart = Number(m[1]);
    const lineDuration = Number(m[2]);
    const body = m[3];
    const prefixed = [...body.matchAll(K_PREFIX_WORD)].map((w) => timedWord(w[3], w[1], w[2])).filter(Boolean);
    const suffixed = [...body.matchAll(K_SUFFIX_WORD)].map((w) => timedWord(w[1], w[2], w[3])).filter(Boolean);
    const words = textLength(prefixed) >= textLength(suffixed) ? prefixed : suffixed;
    if (words.length === 0) continue;
    const text = decodeLrcEntities(body.replace(K_WORD_TIME, '')).trim();
    if (text === '') continue;
    rows.push(line(Math.min(lineStart, words[0].startMs), text, words, {
      sungUntilMs: lineDuration > 0 ? lineStart + lineDuration : null,
    }));
  }
  rows.sort((a, b) => a.timeMs - b.timeMs);
  return withInstrumentalGaps(rows);
}

function timedWord(text, start, duration) {
  const clean = decodeLrcEntities(text).trim();
  if (clean === '') return null;
  const startMs = Number(start);
  return { startMs, endMs: startMs + Number(duration), text: clean };
}

const textLength = (words) => words.reduce((sum, w) => sum + w.text.length, 0);

function lyricContent(raw) {
  const m = K_CONTENT.exec(raw);
  if (!m) return raw;
  return m[1]
    .replaceAll('&quot;', '"').replaceAll('&apos;', "'").replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>').replaceAll('&amp;', '&');
}
