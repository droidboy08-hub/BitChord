// Tests for lyrics/formats/ttml.js (mirrors BitChord's TtmlLyrics.kt).
// Fixtures follow Apple's TTML as served by BetterLyrics / BiniLyrics; the
// words are placeholders.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTtml, parseTtmlDocument, parseTtmlTime } from '../lyrics/formats/ttml.js';

const sung = (lines) => lines.filter((l) => l.text !== '');
const texts = (items) => items.map((i) => i.text);
const gapStamps = (lines) => lines.filter((l) => l.text === '').map((l) => l.timeMs);

/** Apple-style word-timed document: minified, namespaced, one voice declared. */
const APPLE_WORD = [
  '<tt xmlns="http://www.w3.org/ns/ttml" xmlns:itunes="http://music.apple.com/lyric-ttml-internal"',
  ' xmlns:ttm="http://www.w3.org/ns/ttml#metadata" itunes:timing="Word" xml:lang="en">',
  '<head><metadata><ttm:agent type="person" xml:id="v1"/>',
  '<iTunesMetadata xmlns="http://music.apple.com/lyric-ttml-internal"><songwriters>',
  '<songwriter>A. Writer</songwriter></songwriters></iTunesMetadata></metadata></head>',
  '<body dur="3:21.570"><div begin="27.395" end="44.300" itunes:songPart="Verse">',
  '<p begin="27.395" end="28.960" itunes:key="L1" ttm:agent="v1">',
  '<span begin="27.395" end="27.549">we</span> <span begin="27.549" end="27.740">keep</span> ',
  '<span begin="27.740" end="28.077">on</span> <span begin="28.077" end="28.500">sing</span>',
  '<span begin="28.500" end="28.960">ing</span></p>',
  '<p begin="30.189" end="32.529" itunes:key="L2" ttm:agent="v1">',
  '<span begin="30.189" end="30.396">long</span> <span begin="31.839" end="31.996">e</span>',
  '<span begin="31.996" end="32.529">nough</span></p>',
  '<p begin="40.120" end="44.300" itunes:key="L3" ttm:agent="v1">',
  '<span begin="40.120" end="40.500">stay</span> <span begin="40.500" end="41.200">with</span> ',
  '<span begin="41.200" end="42.000">me</span>',
  '<span ttm:role="x-bg"><span begin="42.100" end="42.700">(stay</span> ',
  '<span begin="42.700" end="43.300">with</span> <span begin="43.300" end="44.300">me)</span></span></p>',
  '<p begin="48.500" end="50.000" itunes:key="L4" ttm:agent="v1">',
  '<span begin="48.500" end="50.000">again</span></p>',
  '</div></body></tt>',
].join('');

test('word-timed TTML: spans become words with their own start and end', () => {
  const [first] = sung(parseTtml(APPLE_WORD));
  assert.equal(first.text, 'we keep on singing');
  assert.equal(first.timeMs, 27_395);
  assert.deepEqual(first.words, [
    { startMs: 27_395, endMs: 27_549, text: 'we' },
    { startMs: 27_549, endMs: 27_740, text: 'keep' },
    { startMs: 27_740, endMs: 28_077, text: 'on' },
    { startMs: 28_077, endMs: 28_960, text: 'singing' },
  ]);
  assert.equal(first.sungUntilMs, null);
  assert.equal(first.alignment, 'start');
});

test('syllables with no whitespace between them are one word', () => {
  const second = sung(parseTtml(APPLE_WORD))[1];
  assert.equal(second.text, 'long enough');
  assert.deepEqual(texts(second.words), ['long', 'enough']);
  assert.equal(second.words[1].startMs, 31_839);
  assert.equal(second.words[1].endMs, 32_529);
});

test('whitespace inside a span also separates words, and indentation between spans counts', () => {
  const lines = parseTtml(`
    <tt><body><div>
      <p begin="1.0" end="2.0">
        <span begin="1.0" end="1.4">sing </span><span begin="1.4" end="2.0">along</span>
      </p>
      <p begin="3.0" end="4.0">
        <span begin="3.0" end="3.5">and</span>
        <span begin="3.5" end="4.0"> on</span>
      </p>
    </div></body></tt>`);
  assert.deepEqual(sung(lines).map((l) => texts(l.words)), [['sing', 'along'], ['and', 'on']]);
});

test('background vocals (ttm:role="x-bg") hang under the lead on their own clock', () => {
  const third = sung(parseTtml(APPLE_WORD))[2];
  assert.equal(third.text, 'stay with me');
  assert.deepEqual(texts(third.words), ['stay', 'with', 'me']);
  assert.ok(third.background);
  assert.equal(third.background.text, '(stay with me)');
  assert.equal(third.background.timeMs, 42_100);
  assert.deepEqual(texts(third.background.words), ['(stay', 'with', 'me)']);
  assert.equal(third.background.background, null);
});

test('a background vocal written as one timed leaf is still split off', () => {
  const [line] = sung(parseTtml(`
    <tt><body><div><p begin="1.0" end="2.0">
      <span begin="1.0" end="2.0">hello</span>
      <span ttm:role="x-bg" begin="1.5" end="2.4">(ooh)</span>
    </p></div></body></tt>`));
  assert.equal(line.text, 'hello');
  assert.equal(line.background.text, '(ooh)');
  assert.deepEqual(line.background.words, [{ startMs: 1_500, endMs: 2_400, text: '(ooh)' }]);
});

test('translations and romanisations are not read as part of the line', () => {
  const [line] = sung(parseTtml(`
    <tt><body><div><p begin="1.0" end="2.0">
      <span begin="1.0" end="2.0">hello</span>
      <span ttm:role="x-translation" xml:lang="es">hola</span>
      <span ttm:role="x-roman"><span begin="1.0" end="2.0">haro</span></span>
    </p></div></body></tt>`));
  assert.equal(line.text, 'hello');
  assert.equal(line.background, null);
});

test('instrumental gaps: an intro marker, and a marker where the singing (background included) stops', () => {
  const lines = parseTtml(APPLE_WORD);
  // Intro (27.4 s run-up); after L2 (32.529 → 40.120); after L3, measured from
  // the background vocal's end (44.300), not the lead's (42.000).
  assert.deepEqual(gapStamps(lines), [0, 32_529, 44_300]);
  assert.equal(lines.length, 7);
});

test('the paragraph begin leads the line when it is earlier than the first syllable', () => {
  const [early, missing] = sung(parseTtml(`
    <tt><body><div>
      <p begin="9.900" end="11.0"><span begin="10.000" end="11.0">soft</span></p>
      <p><span begin="12.000" end="13.0">unstamped</span></p>
    </div></body></tt>`));
  assert.equal(early.timeMs, 9_900);
  assert.equal(early.words[0].startMs, 10_000);
  assert.equal(missing.timeMs, 12_000);
});

test('nested timed spans are read at their innermost (syllable) level', () => {
  const [line] = sung(parseTtml(`
    <tt><body><div><p begin="1.0" end="3.0">
      <span begin="1.0" end="3.0"><span begin="1.0" end="1.5">to</span><span begin="1.5" end="3.0">gether</span></span>
    </p></div></body></tt>`));
  assert.deepEqual(line.words, [{ startMs: 1_000, endMs: 3_000, text: 'together' }]);
});

test('punctuation in a text node stays with its word and its whitespace ends the word', () => {
  const [line] = sung(parseTtml(
    '<tt><body><div><p begin="1.0" end="2.0"><span begin="1.0" end="1.5">Hello</span>, '
    + '<span begin="1.5" end="2.0">world</span>!</p></div></body></tt>',
  ));
  assert.deepEqual(texts(line.words), ['Hello,', 'world!']);
  assert.equal(line.words[0].endMs, 1_500);
  assert.equal(line.text, 'Hello, world!');
});

test('lines are sorted by start time whatever the document order', () => {
  const lines = sung(parseTtml(`
    <tt><body><div>
      <p begin="5.0" end="6.0">second</p>
      <p begin="1.0" end="2.0">first</p>
    </div></body></tt>`));
  assert.deepEqual(texts(lines), ['first', 'second']);
});

// ---- Duets ------------------------------------------------------------------

const DUET = `
  <tt xmlns="http://www.w3.org/ns/ttml">
    <head><metadata>
      <ttm:agent type="person" xml:id="v1"/>
      <ttm:agent type="person" xml:id="v2"/>
      <ttm:agent type="group" xml:id="v1000"/>
    </metadata></head>
    <body><div>
      <p begin="1.0" end="2.0" ttm:agent="v1">mine</p>
      <p begin="2.0" end="3.0" ttm:agent="v2">yours</p>
      <p begin="3.0" end="4.0" ttm:agent="v2">still yours</p>
      <p begin="4.0" end="5.0" ttm:agent="v1">mine again</p>
      <p begin="5.0" end="6.0" ttm:agent="v1000">both of us</p>
    </div></body>
  </tt>`;

test('duet: the side changes when the voice does; a group line stays on the left', () => {
  assert.deepEqual(sung(parseTtml(DUET)).map((l) => l.alignment), ['start', 'end', 'end', 'start', 'start']);
});

test('duet sides also apply to word-timed paragraphs', () => {
  const lines = sung(parseTtml(`
    <tt xmlns:ttm="http://www.w3.org/ns/ttml#metadata"><head><metadata>
      <ttm:agent type="person" xml:id="v1"/><ttm:agent type="person" xml:id="v2"/>
    </metadata></head><body><div>
      <p begin="1.0" end="2.0" ttm:agent="v1"><span begin="1.0" end="2.0">call</span></p>
      <p begin="2.0" end="3.0" ttm:agent="v2"><span begin="2.0" end="3.0">response</span></p>
    </div></body></tt>`));
  assert.deepEqual(lines.map((l) => [l.text, l.alignment]), [['call', 'start'], ['response', 'end']]);
});

test('a song that would sit entirely on the right is flipped back to the left', () => {
  const sides = sung(parseTtml(`
    <tt><head><metadata><ttm:agent type="other" xml:id="v2"/></metadata></head>
    <body><div>
      <p begin="1.0" end="2.0" ttm:agent="v2">one</p>
      <p begin="2.0" end="3.0" ttm:agent="v2">two</p>
    </div></body></tt>`)).map((l) => l.alignment);
  assert.deepEqual(sides, ['start', 'start']);
});

test('undeclared voices are persons, and the reserved v2000 is the other singer', () => {
  const sides = sung(parseTtml(`
    <tt><body><div>
      <p begin="1.0" end="2.0" ttm:agent="v1">one</p>
      <p begin="2.0" end="3.0" ttm:agent="v2000">two</p>
      <p begin="3.0" end="4.0">no voice named</p>
    </div></body></tt>`)).map((l) => l.alignment);
  assert.deepEqual(sides, ['start', 'end', 'start']);
});

// ---- Line timing --------------------------------------------------------------

const APPLE_LINE = [
  '<tt xmlns="http://www.w3.org/ns/ttml" xmlns:itunes="http://music.apple.com/lyric-ttml-internal"',
  ' xmlns:ttm="http://www.w3.org/ns/ttml#metadata" itunes:timing="Line" xml:lang="en">',
  '<head><metadata><ttm:agent type="person" xml:id="v1"/></metadata></head>',
  '<body dur="3:02.000"><div begin="12.500" end="32.000">',
  '<p begin="12.500" end="15.000" itunes:key="L1" ttm:agent="v1">before the solo</p>',
  '<p begin="30.000" end="32.000" itunes:key="L2" ttm:agent="v1">after the solo</p>',
  '</div></body></tt>',
].join('');

test('itunes:timing="Line": bare paragraphs are line-synced and keep their stated end', () => {
  const { timing, lines } = parseTtmlDocument(APPLE_LINE);
  assert.equal(timing, 'Line');
  assert.deepEqual(lines.map((l) => [l.timeMs, l.text, l.sungUntilMs]), [
    [0, '', null], // intro
    [12_500, 'before the solo', 15_000],
    [15_000, '', null], // the break starts when the singing stops, not when the next line is due
    [30_000, 'after the solo', 32_000],
  ]);
  assert.ok(lines.every((l) => l.words.length === 0));
});

test('itunes:timing="Word" is reported; the paragraphs themselves decide how they are read', () => {
  assert.equal(parseTtmlDocument(APPLE_WORD).timing, 'Word');
  assert.equal(parseTtmlDocument('<tt><body><p begin="1">x</p></body></tt>').timing, null);
});

test('itunes:timing="None" (unsynced) yields no lines, as in BitChord', () => {
  const doc = '<tt xmlns:itunes="http://music.apple.com/lyric-ttml-internal" itunes:timing="None">'
    + '<body><div><p>first</p><p>second</p></div></body></tt>';
  assert.deepEqual(parseTtml(doc), []);
});

test('a line-synced paragraph keeps the backing text, and a paragraph end before its begin is ignored', () => {
  const [line] = sung(parseTtml(
    '<tt><body><div><p begin="00:12.50" end="00:12.00">lead words <span ttm:role="x-bg">(echo)</span><br/>'
    + 'next\n   half</p></div></body></tt>',
  ));
  assert.equal(line.text, 'lead words (echo) next half');
  assert.equal(line.timeMs, 12_500);
  assert.equal(line.sungUntilMs, null);
});

// ---- Time expressions ---------------------------------------------------------

test('parseTtmlTime reads clock and offset times in milliseconds', () => {
  const cases = [
    ['27.395', 27_395],
    ['1:02.345', 62_345],
    ['01:02.345', 62_345],
    ['1:05.20', 65_200],
    ['1:02:03.4', 3_723_400],
    ['00:00:27.395', 27_395],
    ['62.345s', 62_345],
    ['1.5s', 1_500],
    ['250ms', 250],
    ['62345ms', 62_345],
    ['1:02.345s', 62_345], // a stray unit on a clock value, tolerated as BitChord does
    ['1.5m', 90_000],
    ['0.25h', 900_000],
    ['  27.395  ', 27_395],
    ['.5', 500],
  ];
  for (const [input, expected] of cases) assert.equal(parseTtmlTime(input), expected, input);
});

test('parseTtmlTime rounds to the nearest millisecond instead of truncating', () => {
  // 1.005 * 1000 is 1004.9999999999999 in binary floating point; BitChord's
  // toLong() yields 1004.
  assert.equal(parseTtmlTime('1.005'), 1_005);
  assert.equal(parseTtmlTime('2:03.005'), 123_005);
});

test('parseTtmlTime rejects what it cannot place on the timeline', () => {
  for (const input of [null, undefined, '', '   ', 'abc', '1:2:3:4', '00:01:02:10', '10f', '30t', '1:xx', '1..2']) {
    assert.equal(parseTtmlTime(input), null, String(input));
  }
});

test('span timings in any clock format land on the same words', () => {
  const [line] = sung(parseTtml(`
    <tt><body><div><p begin="00:27.395" end="0:00:28.960">
      <span begin="00:27.395" end="0:00:27.549">we</span>
      <span begin="27549ms" end="27.740s">keep</span>
      <span begin="0:27.740" end="28.960">on</span>
    </p></div></body></tt>`));
  assert.deepEqual(line.words.map((w) => [w.startMs, w.endMs]), [[27_395, 27_549], [27_549, 27_740], [27_740, 28_960]]);
});

// ---- Tolerance -----------------------------------------------------------------

test('entities, comments, CDATA, an XML declaration and a DOCTYPE are handled', () => {
  const lines = sung(parseTtml(`<?xml version="1.0" encoding="UTF-8"?>
    <!DOCTYPE tt [ <!ENTITY x "y"> ]>
    <tt><body><div>
      <!-- a comment <p begin="0" end="1">not a line</p> -->
      <p begin="1.0" end="2.0" title='a > b, "quoted"'>
        <span begin="1.0" end="1.5">rock &amp; roll</span>
        <span begin="1.5" end="2.0">don&#39;t&#x2019;</span>
      </p>
      <p begin="3.0" end="4.0"><![CDATA[raw <text> & more]]></p>
    </div></body></tt>`));
  assert.deepEqual(texts(lines), ['rock & roll don\'t’', 'raw <text> & more']);
  assert.deepEqual(texts(lines[0].words), ['rock & roll', 'don\'t’']);
});

test('malformed input yields no lines rather than throwing', () => {
  for (const input of ['<tt><body><p begin=', '', null, undefined, 'plain text, no markup', '<<<>>>', '</p></tt>']) {
    assert.deepEqual(parseTtml(input), [], String(input));
  }
});

test('unclosed elements are closed at the end of input', () => {
  const lines = sung(parseTtml(
    '<tt><body><div><p begin="1.0" end="2.0"><span begin="1.0" end="1.5">still</span> '
    + '<span begin="1.5" end="2.0">here</span>',
  ));
  assert.deepEqual(lines.map((l) => l.text), ['still here']);
});

test('prefixed TTML element names are found by their local name', () => {
  const lines = sung(parseTtml(
    '<tt:tt xmlns:tt="http://www.w3.org/ns/ttml"><tt:body><tt:div>'
    + '<tt:p begin="1.0" end="2.0"><tt:span begin="1.0" end="2.0">prefixed</tt:span></tt:p>'
    + '</tt:div></tt:body></tt:tt>',
  ));
  assert.deepEqual(lines.map((l) => [l.text, l.words.length]), [['prefixed', 1]]);
});
