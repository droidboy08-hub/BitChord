// Tests for lyrics/postprocess.js. Several groups are ports of BitChord's own
// Kotlin unit tests (BackgroundVocalTest.kt, LyricFocusTest.kt, LyricClockTest.kt,
// LyricsOffsetTest.kt), so the JavaScript is held to the same answers.
//
// Independent JavaScript re-implementation of the mechanism documented in
// BITCHORD_ENGINE_RESEARCH.md (BitChord itself is GPL-3.0).

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { line } from '../lyrics/model.js';
import {
  withBackgroundVocals,
  withInstrumentalGaps,
  MIN_GAP_MS,
  lineAlignments,
  applyOffset,
  adjustedLyricsPosition,
  adjustedLyricsSeekTarget,
  normalizeLyricsOffset,
  offsetFromSliderFraction,
  activeLyricRows,
  scrollLead,
  currentLineIndex,
  endMs,
  hasKnownEnd,
  LyricClockReconciler,
} from '../lyrics/postprocess.js';

const word = (startMs, endMs, text) => ({ startMs, endMs, text });
/** Kotlin-shaped word-synced line: text = words joined by single spaces. */
function wordSynced(...spans) {
  const words = spans.map(([s, e, t]) => word(s, e, t));
  return line(words[0].startMs, words.map((w) => w.text).join(' '), words);
}

describe('withBackgroundVocals (BackgroundVocals.kt / BackgroundVocalTest.kt)', () => {
  test('a trailing bracket becomes the answering line', () => {
    const [l] = withBackgroundVocals([line(1000, 'lead words (echoed words)')]);
    assert.equal(l.text, 'lead words');
    assert.equal(l.background.text, '(echoed words)');
  });

  test('the answering line takes the words that were inside the bracket', () => {
    const [l] = withBackgroundVocals([wordSynced(
      [1000, 1400, 'lead'], [1400, 1900, 'words'], [2100, 2500, '(echoed'], [2500, 3200, 'words)'],
    )]);
    assert.equal(l.text, 'lead words');
    assert.deepEqual(l.words.map((w) => w.text), ['lead', 'words']);
    assert.equal(l.background.text, '(echoed words)');
    assert.deepEqual(l.background.words.map((w) => w.text), ['(echoed', 'words)']);
    assert.equal(l.background.timeMs, 2100); // its own stamp
    assert.ok(l.background.words.length > 0);
  });

  test('the line ends when the answer does, not when the lead does', () => {
    const [l] = withBackgroundVocals([wordSynced([1000, 1400, 'lead'], [2100, 3200, '(echo)'])]);
    assert.equal(endMs(l), 3200);
  });

  test('a line that is entirely bracketed is left as it is', () => {
    const [l] = withBackgroundVocals([line(1000, '(ooh ooh)')]);
    assert.equal(l.text, '(ooh ooh)');
    assert.equal(l.background, null);
  });

  test('a bracket in the middle of a line is left alone', () => {
    const [l] = withBackgroundVocals([line(1000, 'a (parenthetical) aside')]);
    assert.equal(l.text, 'a (parenthetical) aside');
    assert.equal(l.background, null);
  });

  test('a bracket opening mid-word is not a second voice', () => {
    const [l] = withBackgroundVocals([wordSynced([1000, 1400, 'still'], [1400, 2000, 'wait(ing)'])]);
    assert.equal(l.text, 'still wait(ing)');
    assert.equal(l.background, null);
  });

  test('nesting splits at the outer bracket', () => {
    const [l] = withBackgroundVocals([line(1000, 'lead (echo (twice))')]);
    assert.equal(l.text, 'lead');
    assert.equal(l.background.text, '(echo (twice))');
  });

  test('a bracket with no words in it is not a second voice', () => {
    const [l] = withBackgroundVocals([line(1000, 'lead words (!)')]);
    assert.equal(l.text, 'lead words (!)');
    assert.equal(l.background, null);
  });

  test("a line-synced answer shares the line's stamp and its stated end", () => {
    const [l] = withBackgroundVocals([line(1000, 'lead words (echo)', [], { sungUntilMs: 4000 })]);
    assert.equal(l.text, 'lead words');
    assert.equal(l.background.timeMs, 1000);
    assert.equal(l.background.sungUntilMs, 4000);
    assert.equal(endMs(l), 4000);
  });

  test('a source that marked its own answer is not second-guessed', () => {
    const marked = line(1000, 'lead words (already split)', [], { background: line(1500, '(the real answer)') });
    const [l] = withBackgroundVocals([marked]);
    assert.equal(l, marked);
  });

  test('instrumental breaks are left untouched', () => {
    const [l] = withBackgroundVocals([line(1000, '')]);
    assert.equal(l.text, '');
    assert.equal(l.background, null);
  });

  test('only round brackets, only at the very end', () => {
    assert.equal(withBackgroundVocals([line(1, 'lead [echo]')])[0].background, null);
    assert.equal(withBackgroundVocals([line(1, 'lead (echo) ')])[0].background, null);
  });

  test('a bracket inside a single word is not a word boundary', () => {
    // One timed word spanning the whole text: no word starts at the bracket.
    const [l] = withBackgroundVocals([line(1000, 'x (y)', [word(1000, 2000, 'x (y)')])]);
    assert.equal(l.background, null);
  });

  test('no lead words left before the bracket leaves the line alone (split <= 0)', () => {
    // Text and timings disagree: the only timed word IS the bracket, so the
    // lead would keep no timing at all.
    const [l] = withBackgroundVocals([line(1000, 'lead (echo)', [word(1000, 2000, '(echo)')])]);
    assert.equal(l.text, 'lead (echo)');
    assert.equal(l.background, null);
  });

  test("reference-model words that carry their own trailing space split the same way", () => {
    const words = [word(1000, 1400, 'lead '), word(1400, 1900, 'words '), word(2100, 2500, '(echoed '), word(2500, 3200, 'words)')];
    const [l] = withBackgroundVocals([line(1000, words.map((w) => w.text).join(''), words)]);
    assert.equal(l.text, 'lead words');
    assert.equal(l.words.length, 2);
    assert.equal(l.background.text, '(echoed words)');
    assert.equal(l.background.timeMs, 2100);
  });

  test('inputs are not mutated', () => {
    const input = [line(1000, 'lead (echo)')];
    const snapshot = JSON.stringify(input);
    withBackgroundVocals(input);
    assert.equal(JSON.stringify(input), snapshot);
  });
});

describe('withInstrumentalGaps (LyricGaps.kt)', () => {
  test('intro: a first line at >= 4 s gets a gap at 0', () => {
    const out = withInstrumentalGaps([line(MIN_GAP_MS, 'first')]);
    assert.deepEqual(out.map((l) => [l.timeMs, l.text]), [[0, ''], [4000, 'first']]);
    assert.equal(withInstrumentalGaps([line(3999, 'first')]).length, 1);
  });

  test('a break is drawn at the known end of the vocal, from 4 s of silence up', () => {
    const lines = [wordSynced([1000, 2000, 'a']), wordSynced([6000, 7000, 'b'])];
    const out = withInstrumentalGaps(lines);
    assert.deepEqual(out.map((l) => [l.timeMs, l.text]), [[1000, 'a'], [2000, ''], [6000, 'b']]);
    // 3.999 s of silence: no break.
    const tight = withInstrumentalGaps([wordSynced([1000, 2001, 'a']), wordSynced([6000, 7000, 'b'])]);
    assert.equal(tight.length, 2);
  });

  test('line-synced lines without a stated end never get a break', () => {
    const out = withInstrumentalGaps([line(1000, 'a'), line(30_000, 'b')]);
    assert.equal(out.length, 2);
    assert.equal(hasKnownEnd(out[0]), false);
  });

  test('a stated end (sungUntilMs) is enough', () => {
    const out = withInstrumentalGaps([line(1000, 'a', [], { sungUntilMs: 3000 }), line(9000, 'b')]);
    assert.deepEqual(out.map((l) => l.timeMs), [1000, 3000, 9000]);
  });

  test('the background vocal extends the line before the silence is measured', () => {
    const lead = line(1000, 'a', [word(1000, 1500, 'a')], { background: line(1200, '(b)', [word(1200, 5000, '(b)')]) });
    const out = withInstrumentalGaps([lead, line(9000, 'c')]);
    assert.deepEqual(out.map((l) => l.timeMs), [1000, 5000, 9000]);
  });

  test('a marker that would share its line\'s stamp is never inserted', () => {
    const out = withInstrumentalGaps([line(1000, 'a', [], { sungUntilMs: 1000 }), line(9000, 'b')]);
    assert.equal(out.length, 2);
  });

  test('empty input', () => {
    assert.deepEqual(withInstrumentalGaps([]), []);
  });
});

describe('lineAlignments (LyricAlignments.kt)', () => {
  test('a single voice stays on the left', () => {
    assert.deepEqual(lineAlignments(['v1', 'v1', 'v1']), ['start', 'start', 'start']);
  });

  test('sides alternate every time the voice changes, so three voices read as a conversation', () => {
    assert.deepEqual(
      lineAlignments(['v1', 'v2', 'v2', 'v3', 'v1']),
      ['start', 'end', 'end', 'start', 'end'],
    );
  });

  test('group lines sit left and do not take a turn', () => {
    const types = { v1: 'person', v2: 'person', g: 'group' };
    assert.deepEqual(lineAlignments(['v1', 'g', 'v2', 'g', 'v1'], types), ['start', 'start', 'end', 'start', 'start']);
    // Apple's reserved v1000 is a group without being declared.
    assert.deepEqual(lineAlignments(['v1', 'v1000', 'v2']), ['start', 'start', 'end']);
  });

  test('a song opening on "the other singer" (v2000) starts on the right', () => {
    assert.deepEqual(lineAlignments(['v2000', 'v1', 'v2000', 'v1', 'v1', 'v1', 'v1']).slice(0, 3), ['end', 'start', 'end']);
  });

  test('lines with no singer are left and uncounted', () => {
    assert.deepEqual(lineAlignments([null, '', undefined]), ['start', 'start', 'start']);
  });

  test('a song that came out >= 85% on the right is flipped, group lines included', () => {
    const singers = Array(17).fill('v2000').concat(['v1000', 'v1000', 'v1000']); // 17/20 = 0.85 right
    const sides = lineAlignments(singers);
    assert.deepEqual(sides.slice(0, 17), Array(17).fill('start'));
    // The Kotlin flips every entry, so the group lines end up on the right.
    assert.deepEqual(sides.slice(17), ['end', 'end', 'end']);
    // Just under the threshold (16/20): not flipped.
    const under = lineAlignments(Array(16).fill('v2000').concat(Array(4).fill('v1000')));
    assert.equal(under[0], 'end');
  });

  test('types may be a Map', () => {
    assert.deepEqual(lineAlignments(['a', 'b'], new Map([['a', 'other']])), ['end', 'start']);
  });
});

describe('sync offset (PlayerLyrics.kt / LyricsOffsetTest.kt / LyricsOffsetSheet.kt)', () => {
  test('positive offset delays lyrics', () => {
    assert.equal(adjustedLyricsPosition(10_000, 1_500), 8_500);
  });
  test('negative offset advances lyrics', () => {
    assert.equal(adjustedLyricsPosition(10_000, -1_500), 11_500);
  });
  test('offset never produces a negative lyric clock', () => {
    assert.equal(adjustedLyricsPosition(500, 1_500), 0);
  });
  test('seeking a lyric includes its offset', () => {
    assert.equal(adjustedLyricsSeekTarget(10_000, 1_500), 11_500);
    assert.equal(adjustedLyricsSeekTarget(10_000, -1_500), 8_500);
  });

  test('the offset is clamped to +-5 s and snaps to 100 ms on the slider', () => {
    assert.equal(normalizeLyricsOffset(9_000), 5_000);
    assert.equal(normalizeLyricsOffset(-9_000), -5_000);
    assert.equal(offsetFromSliderFraction(0), -5_000);
    assert.equal(offsetFromSliderFraction(1), 5_000);
    assert.equal(offsetFromSliderFraction(0.5), 0);
    assert.equal(offsetFromSliderFraction(0.50004), 0);
    assert.equal(offsetFromSliderFraction(0.516), 200); // 160 ms -> 200
  });

  test('applyOffset is the line-side equivalent of the clock-side adjustment', () => {
    const lines = [
      line(2_000, 'a', [word(2_000, 2_500, 'a')]),
      line(6_000, 'b', [], { sungUntilMs: 7_000, background: line(6_500, '(c)') }),
      line(9_000, 'd'),
    ];
    for (const offset of [1_500, -1_500]) {
      const shifted = applyOffset(lines, offset);
      for (let p = 0; p <= 12_000; p += 250) {
        const clock = adjustedLyricsPosition(p, offset);
        // Equivalent everywhere past |offset| (see applyOffset's doc).
        if (p >= Math.abs(offset)) assert.equal(currentLineIndex(shifted, p), currentLineIndex(lines, clock), `p=${p} off=${offset}`);
      }
      assert.equal(shifted[0].words[0].startMs, 2_000 + offset);
      assert.equal(shifted[1].sungUntilMs, 7_000 + offset);
      assert.equal(shifted[1].background.timeMs, 6_500 + offset);
    }
  });

  test('applyOffset leaves plain lyrics alone and never goes negative', () => {
    const plain = [line(0, 'a'), line(0, 'b')];
    assert.equal(applyOffset(plain, 1_000), plain);
    assert.equal(applyOffset([line(1_000, 'a')], -3_000)[0].timeMs, 0);
    const same = [line(1_000, 'a')];
    assert.equal(applyOffset(same, 0), same);
  });
});

describe('activeLyricRows (LyricFocus.kt / LyricFocusTest.kt)', () => {
  const overlap = [
    line(1_000, 'upper', [], { sungUntilMs: 4_000 }),
    line(2_000, 'middle', [], { sungUntilMs: 5_000 }),
    line(3_000, 'lower', [], { sungUntilMs: 6_000 }),
  ];

  test('upper line keeps anchor across three overlapping vocals', () => {
    assert.deepEqual(activeLyricRows(overlap, 3_500), [0, 1, 2]);
  });
  test('anchor advances exactly when upper vocal ends', () => {
    assert.deepEqual(activeLyricRows(overlap, 4_000), [1, 2]);
    assert.deepEqual(activeLyricRows(overlap, 5_000), [2]);
  });
  test('finished middle row does not cut off long upper vocal', () => {
    const lines = overlap.slice();
    lines[1] = { ...lines[1], sungUntilMs: 2_900 };
    assert.deepEqual(activeLyricRows(lines, 3_500), [0, 2]);
  });
  test('background vocal keeps its parent row anchored', () => {
    const lines = [
      line(1_000, 'lead', [], { sungUntilMs: 1_900, background: line(1_500, 'echo', [], { sungUntilMs: 3_000 }) }),
      line(2_000, 'next', [], { sungUntilMs: 4_000 }),
    ];
    assert.deepEqual(activeLyricRows(lines, 2_500), [0, 1]);
    assert.deepEqual(activeLyricRows(lines, 3_000), [1]);
  });
  test('plain LRC advances without inventing an overlap', () => {
    const lines = overlap.map((l) => ({ ...l, sungUntilMs: null }));
    assert.deepEqual(activeLyricRows(lines, 2_500), [1]);
  });
  test('backward seek recomputes the anchor', () => {
    assert.deepEqual(activeLyricRows(overlap, 5_500), [2]);
    assert.deepEqual(activeLyricRows(overlap, 1_500), [0]);
    assert.deepEqual(activeLyricRows(overlap, 500), []);
  });
});

describe('scrollLead (PlayerLyrics.kt:377-391)', () => {
  test('the run-up is the silence before the next line, clamped to [350, 500] ms', () => {
    const lines = [wordSynced([1_000, 2_000, 'a']), wordSynced([2_420, 3_000, 'b']), wordSynced([10_000, 11_000, 'c'])];
    assert.equal(scrollLead(lines, 1_500), 420);
    assert.equal(scrollLead(lines, 2_500), 500);
    assert.equal(scrollLead(lines, 500), 350); // before the first line
    assert.equal(scrollLead(lines, 10_500), 350); // no next line
    assert.equal(scrollLead([wordSynced([1_000, 2_000, 'a']), wordSynced([2_100, 3_000, 'b'])], 1_500), 350);
  });
});

describe('LyricClockReconciler (LyricClock.kt / LyricClockTest.kt)', () => {
  test('delayed poll does not reactivate previous line', () => {
    const clock = new LyricClockReconciler(9_500, 0, true);
    const reconciled = clock.reconcile(10_018, 9_985, 500, true);
    assert.equal(reconciled, 10_018);
    assert.equal([0, 10_000].findLastIndex((t) => t <= reconciled), 1);
  });

  test('delayed reports never move words or lines backwards', () => {
    const lineStarts = [44_754, 48_000, 51_104, 54_158];
    const clock = new LyricClockReconciler(44_500, 0, true);
    let displayed = 44_500;
    let previousLine = 0;
    const reports = [
      [500, 44_980, 45_080],
      [1_000, 45_470, 45_690],
      [3_500, 47_930, 48_180],
      [4_000, 48_430, 48_790],
      [6_500, 50_900, 51_240],
      [9_500, 53_900, 54_260],
    ];
    for (const [observedAt, report, rendered] of reports) {
      displayed = Math.max(displayed, rendered);
      displayed = clock.reconcile(displayed, report, observedAt, true);
      const current = lineStarts.findLastIndex((t) => t <= displayed);
      assert.ok(current >= previousLine);
      previousLine = current;
    }
  });

  test('seeks reset immediately in both directions', () => {
    assert.equal(new LyricClockReconciler(9_500, 0, true).reconcile(10_018, 4_000, 500, true), 4_000);
    assert.equal(new LyricClockReconciler(9_500, 0, true).reconcile(10_018, 20_000, 500, true), 20_000);
  });

  test('poll ahead of display catches up', () => {
    assert.equal(new LyricClockReconciler(9_500, 0, true).reconcile(10_018, 10_050, 500, true), 10_050);
  });

  test('paused clock accepts a seek without waiting for frames', () => {
    assert.equal(new LyricClockReconciler(10_000, 0, false).reconcile(10_000, 30_000, 250, false), 30_000);
  });

  test('pausing settles a frame clock that was slightly ahead', () => {
    assert.equal(new LyricClockReconciler(10_000, 0, true).reconcile(10_650, 10_400, 400, false), 10_400);
  });
});
