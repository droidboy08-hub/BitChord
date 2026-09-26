// Tests for lyrics/query.js - mirrors BitChord's data/lyrics/LyricsQuery.kt.
// The first five cases are the Kotlin unit tests (NewLyricsSourceTest.kt:126-174) verbatim.
//
// Independent JavaScript re-implementation of the mechanism documented in
// BITCHORD_ENGINE_RESEARCH.md (BitChord itself is GPL-3.0).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { forLyricsSearch, artistForLyricsSearch, ktTrim, ktIsBlank } from '../lyrics/query.js';

test('strips the credits a catalogue does not file a track under', () => {
  assert.equal(forLyricsSearch('Dracula (feat. JENNIE)'), 'Dracula');
  assert.equal(forLyricsSearch('Dracula (with JENNIE)'), 'Dracula');
  assert.equal(forLyricsSearch('Dracula [ft. JENNIE]'), 'Dracula');
  assert.equal(forLyricsSearch('Dracula feat. JENNIE'), 'Dracula');
  assert.equal(forLyricsSearch('Dracula featuring JENNIE'), 'Dracula');
});

test('strips how an upload was labelled', () => {
  assert.equal(forLyricsSearch('Blinding Lights (Official Video)'), 'Blinding Lights');
  assert.equal(forLyricsSearch('Blinding Lights (Official Music Video)'), 'Blinding Lights');
  assert.equal(forLyricsSearch('Blinding Lights [Lyrics]'), 'Blinding Lights');
  assert.equal(forLyricsSearch('Blinding Lights (Visualizer)'), 'Blinding Lights');
  assert.equal(forLyricsSearch('Blinding Lights (4K)'), 'Blinding Lights');
});

test('leaves alone anything that names a different recording', () => {
  for (const title of [
    'Dracula (JENNIE Remix)',
    'Everlong (Acoustic)',
    'Song 2 (Live)',
    'Bohemian Rhapsody (Remastered 2011)',
    'Nights (Sped Up)',
  ]) {
    assert.equal(forLyricsSearch(title), title);
  }
});

test('handles both at once and leaves ordinary titles untouched', () => {
  assert.equal(forLyricsSearch('Levitating (feat. DaBaby) [Official Video]'), 'Levitating');
  assert.equal(forLyricsSearch('golden hour'), 'golden hour');
  // Nothing but packaging: keep what we were given.
  assert.equal(forLyricsSearch('(Official Video)'), '(Official Video)');
  assert.equal(forLyricsSearch('  (Official Video)  '), '(Official Video)');
});

test('drops the topic suffix from an auto-generated channel', () => {
  assert.equal(artistForLyricsSearch('Tame Impala - Topic'), 'Tame Impala');
  assert.equal(artistForLyricsSearch('Tame Impala'), 'Tame Impala');
});

test('the rest of the packaging vocabulary', () => {
  assert.equal(forLyricsSearch('Song (Official Audio)'), 'Song');
  assert.equal(forLyricsSearch('Song (Official Lyric Video)'), 'Song');
  assert.equal(forLyricsSearch('Song (Lyrics Video)'), 'Song');
  assert.equal(forLyricsSearch('Song [MV]'), 'Song');
  assert.equal(forLyricsSearch('Song (M/V)'), 'Song');
  assert.equal(forLyricsSearch('Song (HD)'), 'Song');
  assert.equal(forLyricsSearch('Song [HQ]'), 'Song');
  assert.equal(forLyricsSearch('Song (Full Song)'), 'Song');
  assert.equal(forLyricsSearch('Song (Visualiser)'), 'Song');
  assert.equal(forLyricsSearch('Song (Official)'), 'Song');
  assert.equal(forLyricsSearch('Song ( official )'), 'Song');
  // Case-insensitive throughout.
  assert.equal(forLyricsSearch('SONG (OFFICIAL VIDEO) FEAT. SOMEONE'), 'SONG');
});

test('unbracketed credits need whitespace around the keyword and run to the end', () => {
  assert.equal(forLyricsSearch('Song ft Artist'), 'Song');
  assert.equal(forLyricsSearch('Song Ft. Artist & Other (Remix)'), 'Song');
  // No leading whitespace, no strip: "Defeat", "Gift", "Left" are words, not credits.
  assert.equal(forLyricsSearch('Defeat the Night'), 'Defeat the Night');
  assert.equal(forLyricsSearch('Gift of Love'), 'Gift of Love');
  // "with" is only a credit inside brackets, and only as a whole word.
  assert.equal(forLyricsSearch('Dancing with Myself'), 'Dancing with Myself');
  assert.equal(forLyricsSearch('Stay (Without You)'), 'Stay (Without You)');
  // A known false positive of the Kotlin pattern, reproduced faithfully:
  // any parenthetical that *starts* with "with" is treated as a credit.
  assert.equal(forLyricsSearch('To Sir (With Love)'), 'To Sir');
});

test('whitespace is collapsed and trailing separators are trimmed', () => {
  assert.equal(forLyricsSearch('A    B'), 'A B');
  assert.equal(forLyricsSearch('Song - (Official Video)'), 'Song');
  assert.equal(forLyricsSearch('Song, (Official Video)'), 'Song');
  assert.equal(forLyricsSearch('Song — [Lyrics]'), 'Song');
  // Only trailing separators go; inner ones stay.
  assert.equal(forLyricsSearch('Artist - Song'), 'Artist - Song');
});

test('Kotlin whitespace semantics for trim/isBlank', () => {
  // Kotlin trims U+001C..U+001F and U+3000; it does not trim U+FEFF.
  assert.equal(ktTrim('\u001C a 　'), 'a');
  assert.equal(ktTrim('﻿a'), '﻿a');
  assert.equal(ktIsBlank(' \t '), true);
  assert.equal(ktIsBlank(''), true);
  assert.equal(ktIsBlank('x'), false);
});

test('artist cleaning edge cases', () => {
  // Case-sensitive exact suffix.
  assert.equal(artistForLyricsSearch('Tame Impala - topic'), 'Tame Impala - topic');
  // Nothing left after the suffix: fall back to the original, trimmed.
  assert.equal(artistForLyricsSearch(' - Topic'), '- Topic');
  assert.equal(artistForLyricsSearch('  Artist  '), 'Artist');
});

test('non-string input is tolerated', () => {
  assert.equal(forLyricsSearch(undefined), '');
  assert.equal(artistForLyricsSearch(null), '');
});
