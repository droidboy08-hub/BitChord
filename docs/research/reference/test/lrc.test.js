// Tests for lyrics/formats/lrc.js.
// The first two groups are ports of BitChord's own unit tests
// (app/src/test/java/com/music/bitchord/LrcLibTest.kt and LrcWriterTest.kt),
// so the JS reader/writer is held to the same behaviour as the Kotlin one.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { line } from '../lyrics/model.js';
import {
  MIN_GAP_MS,
  decodeLrcEntities,
  formatLrcClock,
  parseEnhancedLrc,
  parseLrc,
  withInstrumentalGaps,
  writeLrc,
} from '../lyrics/formats/lrc.js';

const sung = (lines) => lines.filter((l) => l.text !== '');
const texts = (lines) => lines.map((l) => l.text);
const times = (lines) => lines.map((l) => l.timeMs);

// ---- Ported from LrcLibTest.kt ------------------------------------------------

test('LrcLibTest: parses centisecond stamps', () => {
  const lines = sung(parseLrc('[00:32.07] first line\n[01:05.50] second line'));
  assert.equal(lines.length, 2);
  assert.equal(lines[0].timeMs, 32_070);
  assert.equal(lines[0].text, 'first line');
  assert.equal(lines[1].timeMs, 65_500);
});

test('LrcLibTest: parses millisecond stamps', () => {
  assert.equal(sung(parseLrc('[02:03.456] third line'))[0].timeMs, 123_456);
});

test('LrcLibTest: drops metadata tags and short gaps', () => {
  const lines = parseLrc('[ar:Arijit Singh]\n[ti:Zaalima]\n[00:10.00]\n[00:12.00] real words\n');
  assert.deepEqual(texts(sung(lines)), ['real words']);
  // The 2 s gap is dropped; the one gap left is the synthesised intro.
  assert.equal(lines.filter((l) => l.text === '').length, 1);
  assert.equal(lines[0].timeMs, 0);
});

test('LrcLibTest: keeps long instrumental gaps', () => {
  const lines = parseLrc('[00:00.00] intro words\n[00:05.00]\n[00:30.00] verse');
  assert.equal(lines.length, 3);
  assert.equal(lines[1].text, '');
  assert.equal(lines[1].timeMs, 5_000);
});

test('LrcLibTest: keeps a trailing gap as the outro', () => {
  const lines = parseLrc('[00:10.00] words\n[04:49.01] ');
  assert.deepEqual(texts(sung(lines)), ['words']);
  assert.equal(lines.at(-1).timeMs, 289_010);
  assert.equal(lines.at(-1).text, '');
});

test('LrcLibTest: adds a leading gap for a long intro', () => {
  const lines = parseLrc('[00:32.07] first words');
  assert.equal(lines.length, 2);
  assert.equal(lines[0].text, '');
  assert.equal(lines[0].timeMs, 0);
  assert.equal(lines[1].text, 'first words');
});

test('LrcLibTest: no leading gap when singing starts straight away', () => {
  const lines = parseLrc('[00:01.00] straight in');
  assert.equal(lines.length, 1);
  assert.equal(lines[0].text, 'straight in');
});

test('LrcLibTest: sorts out of order stamps', () => {
  const lines = parseLrc('[00:30.00] later\n[00:10.00] earlier');
  assert.deepEqual(texts(sung(lines)), ['earlier', 'later']);
});

// ---- Ported from LrcWriterTest.kt ---------------------------------------------

test('LrcWriterTest: each line is stamped as mm:ss.cc', () => {
  assert.equal(writeLrc([line(0, 'first line'), line(61_230, 'second line')]), '[00:00.00]first line\n[01:01.23]second line');
});

test('LrcWriterTest: milliseconds are truncated, never rounded past a second', () => {
  assert.equal(writeLrc([line(59_999, 'x')]), '[00:59.99]x');
});

test('LrcWriterTest: stamps are ASCII digits', () => {
  assert.equal(writeLrc([line(75_400, 'x')]), '[01:15.40]x');
});

test('LrcWriterTest: past ninety-nine minutes overflows to three digits', () => {
  assert.equal(writeLrc([line(6_000_000, 'x')]), '[100:00.00]x');
});

test('LrcWriterTest: an instrumental gap is written as a bare stamp', () => {
  const out = writeLrc([line(1_000, 'first line'), line(8_000, ''), line(20_000, 'second line')]);
  assert.equal(out, '[00:01.00]first line\n[00:08.00]\n[00:20.00]second line');
});

test('LrcWriterTest: lines are sorted by stamp', () => {
  assert.equal(writeLrc([line(5_000, 'later'), line(1_000, 'earlier')]), '[00:01.00]earlier\n[00:05.00]later');
});

test("LrcWriterTest: word timings are dropped and the line's text is kept whole", () => {
  const out = writeLrc([line(1_000, 'two words', [
    { startMs: 1_000, endMs: 1_400, text: 'two' },
    { startMs: 1_400, endMs: 2_000, text: 'words' },
  ])]);
  assert.equal(out, '[00:01.00]two words');
  assert.ok(!out.includes('<'));
});

test('LrcWriterTest: an answering vocal is written back onto the end of its lead', () => {
  const out = writeLrc([line(1_000, 'the lead line', [], { background: line(1_600, '(the answer)') })]);
  assert.equal(out, '[00:01.00]the lead line (the answer)');
});

test('LrcWriterTest: no lines is empty text', () => {
  assert.equal(writeLrc([]), '');
});

test('LrcWriterTest: what it writes, the parser reads back unchanged', () => {
  const lines = [line(0, ''), line(6_120, 'first line'), line(12_340, 'second line'), line(18_000, ''), line(25_500, 'third line')];
  const reparsed = parseLrc(writeLrc(lines));
  assert.deepEqual(times(reparsed), times(lines));
  assert.deepEqual(texts(reparsed), texts(lines));
});

// ---- Ported from EmbeddedLyricsTest.kt (the enhanced round trip) --------------

test('EmbeddedLyricsTest: word timings survive writeLrc({enhanced}) -> parseLrc', () => {
  const lines = [line(1_000, 'two words', [
    { startMs: 1_000, endMs: 1_400, text: 'two' },
    { startMs: 1_400, endMs: 2_000, text: 'words' },
  ])];
  const enhanced = writeLrc(lines, { enhanced: true });
  assert.equal(enhanced, '[00:01.00]<00:01.00>two <00:01.40>words<00:02.00>');
  const read = parseLrc(enhanced);
  assert.equal(read.length, 1);
  assert.equal(read[0].text, 'two words');
  assert.deepEqual(read[0].words.map((w) => w.text), ['two', 'words']);
  assert.deepEqual(read[0].words.map((w) => w.startMs), [1_000, 1_400]);
  assert.equal(read[0].words.at(-1).endMs, 2_000);
});

// ---- Reader: format details and the documented extensions ---------------------

test('fraction forms: [mm:ss:xx] (colon), one digit, none, and >99 minutes', () => {
  const lines = sung(parseLrc('[00:01:25]colon\n[00:02.5]tenths\n[00:03]bare\n[100:00.00]long'));
  assert.deepEqual(times(lines), [1_250, 2_500, 3_000, 6_000_000]);
});

test('metadata tags of every kind are ignored', () => {
  const lrc = '[ar:Artist]\n[ti:Title]\n[al:Album]\n[by:someone]\n[length: 03:21]\n[re:tool]\n[ve:1.0]\n[#:comment]\n[00:01.00]only line';
  assert.deepEqual(texts(parseLrc(lrc)), ['only line']);
});

test('compressed multi-timestamp lines expand to one line per stamp, sorted', () => {
  const lines = parseLrc('[00:10.00][00:50.00]Chorus line\n[00:20.00] [00:30.00]Verse');
  assert.deepEqual(texts(lines), ['', 'Chorus line', 'Verse', 'Verse', 'Chorus line']);
  assert.deepEqual(times(lines), [0, 10_000, 20_000, 30_000, 50_000]);
  assert.ok(lines.every((l) => !l.text.includes('[')));
});

test('[offset:] shifts every stamp (positive = earlier) and clamps at zero', () => {
  assert.deepEqual(times(sung(parseLrc('[offset:+500]\n[00:01.00]a\n[00:02.00]b'))), [500, 1_500]);
  assert.deepEqual(times(sung(parseLrc('[00:01.00]a\n[offset:-250]\n[00:02.00]b'))), [1_250, 2_250]);
  assert.deepEqual(times(sung(parseLrc('[offset:2000]\n[00:01.00]a'))), [0]);
  // Word stamps move with their line.
  const [w] = sung(parseLrc('[offset:100]\n[00:01.00]<00:01.00>hi <00:01.50>there<00:02.00>'));
  assert.deepEqual(w.words.map((x) => [x.startMs, x.endMs]), [[900, 1_400], [1_400, 1_900]]);
});

test('BOM, CRLF and leading whitespace are tolerated', () => {
  const lines = parseLrc('﻿[00:01.00]a\r\n  [00:02.00]b\r[00:03.00]c');
  assert.deepEqual(texts(lines), ['a', 'b', 'c']);
});

test('enhanced A2 line: words, ends from the next stamp, text keeps its own spacing', () => {
  const [l] = sung(parseLrc('[00:27.39]<00:27.39>I <00:27.54>been, <00:27.74>tryna <00:28.07>call<00:28.50>'));
  assert.equal(l.timeMs, 27_390);
  assert.equal(l.text, 'I been, tryna call');
  assert.deepEqual(l.words, [
    { startMs: 27_390, endMs: 27_540, text: 'I' },
    { startMs: 27_540, endMs: 27_740, text: 'been,' },
    { startMs: 27_740, endMs: 28_070, text: 'tryna' },
    { startMs: 28_070, endMs: 28_500, text: 'call' },
  ]);
});

test('enhanced line without a terminator: the last word ends where it starts (LrcLib behaviour)', () => {
  const [l] = sung(parseLrc('[00:01.00]<00:01.00>one <00:01.50>two'));
  assert.deepEqual(l.words.at(-1), { startMs: 1_500, endMs: 1_500, text: 'two' });
});

test('text before the first word stamp stays in the line but is no word', () => {
  const [l] = sung(parseLrc('[00:01.00]Hello <00:01.50>world<00:02.00>'));
  assert.equal(l.text, 'Hello world');
  assert.deepEqual(l.words.map((w) => w.text), ['world']);
});

test('the <R> marker restores right alignment and is stripped', () => {
  const [l] = sung(parseLrc('[00:01.00]<R><00:01.00>answer<00:01.80>'));
  assert.equal(l.alignment, 'end');
  assert.equal(l.text, 'answer');
  assert.equal(sung(parseLrc('[00:01.00]plain'))[0].alignment, 'start');
});

test('minGapMs option controls gap retention', () => {
  const lrc = '[00:00.00]a\n[00:02.00]\n[00:03.00]b'; // starts at 0: no synthesised intro gap
  assert.equal(parseLrc(lrc).filter((l) => l.text === '').length, 0);
  assert.equal(parseLrc(lrc, { minGapMs: 500 }).filter((l) => l.text === '').length, 1);
  assert.equal(MIN_GAP_MS, 4_000);
});

// ---- Writer: enhanced form ------------------------------------------------------

test('enhanced writer: <R> marker, background runs, clamped monotonic starts, closing stamp', () => {
  const lead = line(10_000, 'lead words', [
    { startMs: 10_000, endMs: 10_500, text: 'lead' },
    { startMs: 10_500, endMs: 11_000, text: 'words' },
  ], {
    alignment: 'end',
    background: line(10_200, '(echo)', [{ startMs: 10_200, endMs: 12_000, text: '(echo)' }]),
  });
  // The background's first stamp (10.20) is earlier than the previous run (10.50): clamped.
  assert.equal(writeLrc([lead], { enhanced: true }),
    '[00:10.00]<R><00:10.00>lead <00:10.50>words <00:10.50>(echo)<00:12.00>');
});

test('enhanced writer: a background without words becomes one run; plain lines stay plain', () => {
  const lines = [
    line(1_000, 'hey', [{ startMs: 1_000, endMs: 1_300, text: 'hey' }], { background: line(1_400, '(ho)', [], { sungUntilMs: 1_900 }) }),
    line(5_000, 'no words here'),
  ];
  assert.equal(writeLrc(lines, { enhanced: true }), '[00:01.00]<00:01.00>hey <00:01.40>(ho)<00:01.90>\n[00:05.00]no words here');
});

test('enhanced writer returns "" when nothing is word-synced; plain writer emits unstamped rows for unsynced lyrics', () => {
  assert.equal(writeLrc([line(1_000, 'a')], { enhanced: true }), '');
  assert.equal(writeLrc([line(0, 'one'), line(0, ''), line(0, 'two')]), 'one\n\ntwo');
});

test('formatLrcClock clamps negatives and truncates', () => {
  assert.equal(formatLrcClock(-5), '00:00.00');
  assert.equal(formatLrcClock(3_723_456.9), '62:03.45');
});

// ---- EnhancedLrc.parse port and helpers -----------------------------------------

test('parseEnhancedLrc: [] without word stamps; joins words; decodes entities; 800 ms tail', () => {
  assert.deepEqual(parseEnhancedLrc('[00:01.00]plain line'), []);
  const lines = parseEnhancedLrc('[00:01.00]<00:01.00>It&#x27;s <00:01.40>fine\n[00:03.00]<00:03.00>last');
  const [a, b] = lines;
  assert.equal(a.text, "It's fine");
  assert.deepEqual(a.words.map((w) => [w.startMs, w.endMs]), [[1_000, 1_400], [1_400, 3_000]]);
  assert.deepEqual(b.words, [{ startMs: 3_000, endMs: 3_800, text: 'last' }]);
});

test('withInstrumentalGaps: gap at a known end when the silence is long enough', () => {
  const lines = [
    line(5_000, 'a', [{ startMs: 5_000, endMs: 6_000, text: 'a' }]),
    line(12_000, 'b', [{ startMs: 12_000, endMs: 12_500, text: 'b' }]),
    line(14_000, 'c'),
  ];
  const out = withInstrumentalGaps(lines);
  assert.deepEqual(out.map((l) => [l.timeMs, l.text]), [[0, ''], [5_000, 'a'], [6_000, ''], [12_000, 'b'], [14_000, 'c']]);
});

test('decodeLrcEntities: order-safe, and astral code points are kept whole', () => {
  assert.equal(decodeLrcEntities('it&#x27;s &amp;#x27; &quot;x&quot; &nbsp;&lt;3'), 'it\'s &#x27; "x"  <3');
  assert.equal(decodeLrcEntities('&#x1F600;'), '😀');
  assert.equal(decodeLrcEntities('no entities'), 'no entities');
});
