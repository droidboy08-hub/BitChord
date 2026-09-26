// Tests for sources/trackMatcher.js (mirrors data/sources/TrackMatcher.kt).
// Most fixtures are ported from BitChord's own app/src/test/.../SourcesTest.kt
// and TrackIdentityMismatchTest.kt, so a divergence from the Kotlin shows up here.
// Independent JavaScript re-implementation of the mechanism documented in BITCHORD_ENGINE_RESEARCH.md (BitChord itself is GPL-3.0).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as M from '../sources/trackMatcher.js';

const song = (title, artist, durationText = null, extra = {}) => ({ id: extra.id ?? title, title, artist, durationText, ...extra });
const matches = (candidate, title, artist, durationSec = null) => M.matches(candidate, title, artist, durationSec);

// ── Asking ──────────────────────────────────────────────────────────────────

test('queries: packaging off, primary artist on, then the title alone', () => {
  assert.deepEqual(
    M.queries({ title: 'Paniyon Sa (From "Satyameva Jayate") | Official Video', artist: 'Atif Aslam, Tulsi Kumar' }),
    ['paniyon sa atif aslam', 'paniyon sa'],
  );
});

test('queries: version markers stay in the query, sorted like a TreeSet', () => {
  assert.deepEqual(M.queries({ title: 'Shape of You (Acoustic)', artist: '' }), ['shape of you acoustic']);
  assert.deepEqual(M.queries({ title: 'Song (Remix) (Live)', artist: '' }), ['song live remix']);
});

test('queries: nothing to ask without a title', () => {
  assert.deepEqual(M.queries({ title: '', artist: 'Atif Aslam' }), []);
});

test('queries: the artist is only lower-cased, so quotes and backslashes reach the source (defect S1)', () => {
  assert.deepEqual(M.queries({ title: 'Song', artist: 'Jay "Hov" Z\\' }), ['song jay "hov" z\\', 'song']);
});

test('primaryArtist: first credit, split on the separators', () => {
  assert.equal(M.primaryArtist('Atif Aslam, Tulsi Kumar'), 'atif aslam');
  assert.equal(M.primaryArtist('Jay-Z & Linkin Park'), 'jay-z');
  assert.equal(M.primaryArtist('Calvin Harris feat. Rihanna'), 'calvin harris');
  assert.equal(M.primaryArtist('Lil Nas X'), 'lil nas'); // "x" is a separator
  assert.equal(M.primaryArtist('AC/DC'), 'ac'); // so is "/"
});

test('primaryArtist: word boundaries are Unicode-aware, as ICU makes them on Android', () => {
  // With JavaScript's ASCII \b, "and" inside "Ñandú" would be a separator.
  assert.equal(M.primaryArtist('Ñandú'), 'ñandú');
  assert.deepEqual([...M.artistNames('Ñandú Rock').keys()], ['and rock']);
});

// ── Title parsing: real-world upload titles ────────────────────────────────

test('parseTitle: official video, lyrics and audio labels are packaging', () => {
  for (const title of [
    'Blinding Lights (Official Video)',
    'Blinding Lights [Official Audio]',
    'Blinding Lights (Lyrics)',
    'Blinding Lights | Official Music Video',
    'Blinding Lights - Official Lyric Video',
  ]) {
    assert.equal(M.parseTitle(title).core, 'blindinglights', title);
    assert.equal(M.parseTitle(title).versions.size, 0, title);
  }
});

test('parseTitle: feat. credits are dropped wherever they are printed', () => {
  assert.equal(M.parseTitle('Sunflower (feat. Swae Lee)').core, 'sunflower');
  assert.equal(M.parseTitle('Sunflower feat. Swae Lee').core, 'sunflower');
  assert.equal(M.parseTitle('Sunflower ft. Swae Lee').core, 'sunflower');
  assert.deepEqual([...M.parseTitle('Sunflower (feat. Swae Lee)').context], ['swae', 'lee']);
});

test('parseTitle: "with" counts as a featuring marker anywhere (a Kotlin quirk, mirrored)', () => {
  const parts = M.parseTitle('Dancing with a Stranger (with Normani)');
  assert.equal(parts.core, 'dancing');
  assert.deepEqual(M.queries({ title: 'Dancing with a Stranger', artist: 'Sam Smith' }), ['dancing sam smith', 'dancing']);
});

test('parseTitle: remix, live, slowed and stems are versions; album/radio edits are neutral', () => {
  assert.deepEqual([...M.parseTitle('Titanium (feat. Sia) [David Guetta Remix]').versions], ['remix']);
  assert.deepEqual([...M.parseTitle('Faded (Slowed + Reverb)').versions].sort(), ['reverb', 'slowed']);
  assert.deepEqual([...M.parseTitle('Creep - Live at Glastonbury').versions], ['live']);
  assert.deepEqual([...M.parseTitle('Apna Bana Le - Arijit Singh Vocals Only').versions], ['vocals']);
  assert.equal(M.parseTitle('Africa (Album Version)').versions.size, 0);
  assert.equal(M.parseTitle('One More Time - Radio Edit').versions.size, 0);
  assert.equal(M.parseTitle('Levels - Original Mix').versions.size, 0);
  assert.deepEqual([...M.parseTitle('Strobe (Extended Mix)').versions].sort(), ['extended', 'mix']);
});

test('parseTitle: "Artist - Title" uploads hand over to the tail', () => {
  const parts = M.parseTitle('Imagine Dragons - Believer (Official Music Video)', 'Imagine Dragons');
  assert.equal(parts.core, 'believer');
  assert.deepEqual([...parts.context].sort(), ['dragons', 'imagine']);
});

test('parseTitle: an "&" in the artist defeats "Artist - Title" detection (Kotlin quirk, mirrored)', () => {
  // The title's "&" becomes "and", the artist's does not, so the head is not
  // recognised as the artist and the song title is thrown away as context.
  const parts = M.parseTitle('Simon & Garfunkel - The Boxer', 'Simon & Garfunkel');
  assert.equal(parts.core, 'simongarfunkel');
  assert.equal(matches(song('The Boxer', 'Simon & Garfunkel'), 'Simon & Garfunkel - The Boxer', 'Simon & Garfunkel'), false);
});

test('parseTitle: trailing upload labels go, but never down to nothing', () => {
  assert.equal(M.parseTitle('Tum Hi Ho Full Song HD').core, 'tumhiho');
  assert.equal(M.parseTitle('Song').core, 'song');
  assert.equal(M.parseTitle('Jack & Jill').core, M.parseTitle('Jack and Jill').core);
});

test('parseTitle: an unbalanced bracket takes the rest of the line', () => {
  const parts = M.parseTitle('Kesariya (From "Brahmastra');
  assert.equal(parts.core, 'kesariya');
  assert.deepEqual([...parts.context], ['brahmastra']);
});

// ── Matching (SourcesTest.kt) ───────────────────────────────────────────────

test('matches the same recording across differing catalogue titles', () => {
  assert.ok(matches(song('Bohemian Rhapsody (Remastered 2011)', 'Queen'), 'Bohemian Rhapsody', 'Queen'));
  assert.ok(matches(song('Sunflower', 'Post Malone, Swae Lee'), 'Sunflower (feat. Swae Lee)', 'Post Malone'));
  assert.ok(matches(song("Don't Stop Me Now", 'QUEEN'), 'Dont Stop Me Now', 'Queen'));
});

test('matches a film credit against a bare catalogue listing, both ways round', () => {
  assert.ok(matches(song('Paniyon Sa', 'Atif Aslam, Tulsi Kumar', '4:07'), 'Paniyon Sa (From "Satyameva Jayate")', 'Atif Aslam', 247));
  assert.ok(matches(song('Paniyon Sa (From "Satyameva Jayate")', 'Atif Aslam'), 'Paniyon Sa', 'Atif Aslam, Tulsi Kumar'));
});

test('strips upload labelling from either side', () => {
  assert.ok(matches(song('Tum Hi Ho', 'Arijit Singh'), 'Tum Hi Ho Full Song', 'Arijit Singh'));
  assert.ok(matches(song('Kesariya', 'Arijit Singh'), 'Kesariya - Brahmastra | Official Video', 'Arijit Singh'));
  assert.ok(matches(song('Believer', 'Imagine Dragons'), 'Imagine Dragons - Believer', 'Imagine Dragons'));
});

test('refuses a different song, a cover, and a name that merely contains the artist', () => {
  assert.equal(matches(song('The Show Must Go On', 'Queen'), 'Bohemian Rhapsody', 'Queen'), false);
  assert.equal(matches(song('Hurt', 'Johnny Cash'), 'Hurt', 'Nine Inch Nails'), false);
  assert.equal(matches(song('No One Knows', 'Queens of the Stone Age'), 'No One Knows', 'Queen'), false);
});

test('accepts a shared artist when catalogues credit differently', () => {
  assert.ok(matches(song('Numb / Encore', 'Jay-Z & Linkin Park'), 'Numb / Encore', 'Linkin Park'));
});

test('a composer credit stands in for a singer credit only on an exact (±2 s) runtime', () => {
  assert.ok(matches(song('Jhak Maar Ke', 'Neeraj Shridhar', '3:53'), 'Jhak Maar Ke', 'Pritam', 233));
  assert.ok(matches(song('Jhak Maar Ke', 'Neeraj Shridhar', '3:55'), 'Jhak Maar Ke', 'Pritam', 233));
  assert.equal(matches(song('Jhak Maar Ke', 'Neeraj Shridhar', '3:56'), 'Jhak Maar Ke', 'Pritam', 233), false);
  assert.equal(matches(song('Jhak Maar Ke', 'Leo Lz Mix', '4:01'), 'Jhak Maar Ke', 'Pritam', 233), false);
  // Without a runtime on both sides nothing vouches for anything.
  assert.equal(matches(song('Jhak Maar Ke', 'Neeraj Shridhar'), 'Jhak Maar Ke', 'Pritam'), false);
  assert.equal(matches(song('Jhak Maar Ke', 'Neeraj Shridhar', '3:53'), 'Jhak Maar Ke', 'Pritam', null), false);
  // And never for a music video, whose runtime includes visuals.
  assert.equal(
    M.score({ title: 'Jhak Maar Ke', artist: 'Pritam', durationSec: 233, isVideo: true }, song('Jhak Maar Ke', 'Neeraj Shridhar', '3:53')),
    null,
  );
});

test('a credited match outranks a runtime-vouched one, which scores 100 - 30 + 40', () => {
  const target = { title: 'Jhak Maar Ke', artist: 'Pritam, Neeraj Shridhar', durationSec: 233 };
  const vouched = song('Jhak Maar Ke', 'Some Uploader', '3:53');
  const credited = song('Jhak Maar Ke', 'Neeraj Shridhar', '3:53');
  assert.equal(M.score(target, vouched), 100 - 30 + 40);
  assert.equal(M.score(target, credited), 100 + 10 + 40); // a partial credit is ARTIST_SHARED
  assert.equal(M.score(target, song('Jhak Maar Ke', 'Neeraj Shridhar, Pritam', '3:53')), 100 + 25 + 40);
  assert.equal(M.best(target, [vouched, credited]), credited);
  // ranked drops the runtime-only row once a credited row exists.
  assert.deepEqual(M.ranked(target, [vouched, credited]), [credited]);
});

test('refuses a different take, in both directions', () => {
  assert.equal(matches(song('Shape of You (Acoustic)', 'Ed Sheeran'), 'Shape of You', 'Ed Sheeran'), false);
  assert.equal(matches(song('Shape of You', 'Ed Sheeran'), 'Shape of You (Acoustic)', 'Ed Sheeran'), false);
  assert.equal(matches(song('Creep (Live)', 'Radiohead'), 'Creep', 'Radiohead'), false);
  assert.equal(matches(song('Faded', 'Alan Walker'), 'Faded (Slowed + Reverb)', 'Alan Walker'), false);
  assert.equal(
    matches(song('Apna Bana Le - Arijit Singh Vocals Only', 'Arijit Singh, Sachin-Jigar'), 'Apna Bana Le (From "Bhediya")', 'Arijit Singh'),
    false,
  );
  assert.equal(matches(song('Kesariya (Instrumental)', 'Arijit Singh'), 'Kesariya', 'Arijit Singh'), false);
  assert.equal(matches(song('Titanium (David Guetta Remix)', 'David Guetta, Sia'), 'Titanium (feat. Sia)', 'David Guetta'), false);
  assert.ok(matches(song('Creep (Live)', 'Radiohead'), 'Creep [Live]', 'Radiohead'));
});

test('treats an album or radio version as the plain track', () => {
  assert.ok(matches(song('Africa', 'Toto'), 'Africa (Album Version)', 'Toto'));
  assert.ok(matches(song('Clocks', 'Coldplay'), 'Clocks (Radio Edit)', 'Coldplay'));
});

test('falls back to title alone when no artist is known', () => {
  assert.ok(matches(song('Clair de Lune', 'Debussy'), 'Clair de Lune', ''));
  assert.equal(matches(song('Reverie', 'Debussy'), 'Clair de Lune', ''), false);
});

test('a title that loses every character to [^a-z0-9] never matches', () => {
  assert.equal(matches(song('तुम ही हो', 'Arijit Singh'), 'तुम ही हो', 'Arijit Singh'), false);
});

// ── Duration windows ────────────────────────────────────────────────────────

test('duration: ≤ 3 s scores +40, ≤ 30 s +15, > 30 s rejects a different artist', () => {
  const target = { title: 'Levitating', artist: 'Dua Lipa', durationSec: 203 };
  assert.equal(M.score(target, song('Levitating', 'Dua Lipa', '3:26')), 100 + 25 + 40); // 3 s
  assert.equal(M.score(target, song('Levitating', 'Dua Lipa', '3:27')), 100 + 25 + 15); // 4 s
  assert.equal(M.score(target, song('Levitating', 'Dua Lipa', '3:53')), 100 + 25 + 15); // 30 s
  assert.equal(M.score(target, song('Levitating', 'Dua Lipa', '1:00:12')), null); // an hour-long loop
  assert.equal(M.score({ ...target, artist: 'Dua Lipa' }, song('Levitating', 'Some Cover Band', '3:54')), null);
});

test('duration: the window widens to 90 s (scoring 0) whenever the credit does not contradict', () => {
  const target = { title: 'Brown Rang', artist: 'Yo Yo Honey Singh', durationSec: 211 };
  assert.equal(M.score(target, song('Brown Rang', 'Yo Yo Honey Singh', '2:59')), 100 + 25 + 0); // 32 s off
  assert.equal(M.score(target, song('Brown Rang', 'Yo Yo Honey Singh', '2:01')), 100 + 25 + 0); // 90 s off
  assert.equal(M.score(target, song('Brown Rang', 'Yo Yo Honey Singh', '2:00')), null); // 91 s off
  // Not only a shared artist: a row with no artist at all gets the wide window too.
  assert.equal(M.score(target, song('Brown Rang', '', '2:01')), 100);
});

test('unlabelled music video timing cannot make another artist the Brown Rang match', () => {
  const target = { title: 'Brown Rang', artist: 'Yo Yo Honey Singh', durationSec: 211, isVideo: false };
  const wantedAudio = song('Brown Rang', 'Yo Yo Honey Singh', '2:59', { album: 'International Villager' });
  const wrongExactRuntime = song('Brown Rang', 'Lovely, Jais Rikhi, Love Sagar', '3:30', { album: 'Brown Rang' });
  assert.equal(M.best(target, [wrongExactRuntime, wantedAudio]), wantedAudio);
  assert.deepEqual(M.ranked(target, [wrongExactRuntime, wantedAudio]), [wantedAudio]);
  assert.equal(M.hasConflictingAlbums([wantedAudio], target), false);
});

test('picks the closest candidate rather than the first acceptable one', () => {
  const target = { title: 'Paniyon Sa', artist: 'Atif Aslam', durationSec: 247 };
  const wrongLength = song('Paniyon Sa', 'Atif Aslam', '4:32');
  const right = song('Paniyon Sa', 'Atif Aslam, Tulsi Kumar', '4:06');
  assert.equal(M.best(target, [wrongLength, right]), right);
});

test('ranked is stable: equal scores keep the catalogue order', () => {
  const target = { title: 'Song', artist: 'A', durationSec: 180 };
  const first = song('Song', 'A', '3:00', { id: '1' });
  const second = song('Song', 'A', '3:00', { id: '2' });
  assert.deepEqual(M.ranked(target, [first, second]).map((r) => r.id), ['1', '2']);
  assert.deepEqual(M.ranked(target, [second, first]).map((r) => r.id), ['2', '1']);
});

test('rows may carry durationSec instead of durationText; 0 means unknown', () => {
  const target = { title: 'Hello', artist: 'Adele', durationSec: 180 };
  assert.equal(M.score(target, { title: 'Hello', artist: 'Adele', durationSec: 181 }), 165);
  assert.equal(M.score(target, { title: 'Hello', artist: 'Adele', durationSec: 0 }), 125);
});

test('single-letter artist words are dropped, so a one-letter artist counts as no credit', () => {
  assert.equal(M.artistNames('A').size, 0);
  assert.equal(M.score({ title: 'Song', artist: 'A', durationSec: 180 }, { title: 'Song', artist: 'B', durationSec: 180 }), 140);
  // "A. R. Rahman" keeps only "rahman", which is a whole-word run inside "ar rahman":
  // the same person, scored as a shared credit rather than an exact one.
  assert.deepEqual([...M.artistNames('A. R. Rahman').keys()], ['rahman']);
  assert.equal(M.sharesArtist('A. R. Rahman', 'AR Rahman'), true);
  assert.equal(M.artistScore('A. R. Rahman', 'AR Rahman'), M.ARTIST_SHARED);
});

// ── Album and explicit ─────────────────────────────────────────────────────

test('the album separates duplicate JioSaavn recordings', () => {
  const target = { title: 'Brown Rang', artist: 'Yo Yo Honey Singh', durationSec: 175, album: 'International Villager' };
  const wanted = song('Brown Rang', 'Yo Yo Honey Singh', '2:59', { album: 'International Villager' });
  const wrongButCloser = song('Brown Rang', 'Yo Yo Honey Singh', '2:54', { album: 'Chaar Ikke' });
  assert.equal(M.best(target, [wrongButCloser, wanted]), wanted);
  assert.equal(M.albumKey('International Villager (Deluxe Edition)'), M.albumKey('international villager'));
});

test('detects conflicting releases only when the requested album is unknown', () => {
  const target = { title: 'Brown Rang', artist: 'Yo Yo Honey Singh', durationSec: 175 };
  const iv = song('Brown Rang', 'Yo Yo Honey Singh', '2:59', { album: 'International Villager' });
  const ci = song('Brown Rang', 'Yo Yo Honey Singh', '2:54', { album: 'Chaar Ikke' });
  assert.equal(M.hasConflictingAlbums([iv, ci], target), true);
  assert.equal(M.hasConflictingAlbums([iv, { ...iv, album: 'International Villager (Deluxe Edition)' }], target), false);
  assert.equal(M.hasConflictingAlbums([iv, ci], { ...target, album: 'International Villager' }), false);
});

test('the uniquely fullest credit resolves a JioSaavn release collision; a tie does not', () => {
  const target = { title: 'Ek Dil Ek Jaan', artist: 'Shivam Pathak', durationSec: 220 };
  const original = song('Ek Dil Ek Jaan', 'Shivam Pathak, Mujtaba Aziz Naza, Kunal Pandit, Farhan Sabri', '3:40', { album: 'Padmaavat' });
  const compilation = song('Ek Dil Ek Jaan', 'Shivam Pathak', '3:39', { album: 'Top 20 - Romantic Songs 2018' });
  const fromCompilation = song('Ek Dil Ek Jaan (From Padmaavat)', 'Shivam Pathak, Sanjay Leela Bhansali, A.M. Turaz', '3:39', { album: 'Bollywood Magic Mix' });
  assert.equal(M.uniquelyMostCreditedCloseMatch([original, compilation, fromCompilation], target), original);

  const tieTarget = { title: 'Mere Bina', artist: "Pritam, Nikhil D'Souza", durationSec: 290 };
  const first = song('Mere Bina', "Pritam, Nikhil D'Souza", '4:49', { album: 'Crook' });
  const second = song('Mere Bina', "Pritam, Nikhil D'Souza", '4:51', { album: 'Sad Love Hits' });
  assert.equal(M.uniquelyMostCreditedCloseMatch([first, second], tieTarget), null);
});

test('explicit: an explicit target cannot match the censored edition; unknown is no veto', () => {
  const target = { title: 'Starboy', artist: 'The Weeknd', durationSec: 230, album: 'Starboy', explicit: true };
  const clean = song('Starboy', 'The Weeknd', '3:50', { album: 'Starboy', explicit: false });
  const uncensored = { ...clean, id: 'uncensored', explicit: true };
  assert.equal(M.score(target, clean), null);
  assert.equal(M.score(target, uncensored), 100 + 25 + 40 + 35 + 20);
  assert.equal(M.best(target, [clean, uncensored]), uncensored);

  const unknown = { title: 'For A Reason', artist: 'Karan Aujla, IKKY', durationSec: 180, explicit: null };
  const wanted = song('For A Reason', "Karan Aujla, IKKY, Ikwinder Sahota, Milan D'Agostini", '3:00', { album: 'P-POP CULTURE', explicit: true });
  const remix = song('For A Reason', 'Aye Manny', '3:00', { album: 'For A Reason (Remix)', explicit: false });
  assert.deepEqual(M.ranked(unknown, [remix, wanted]), [wanted]);
});

test('context words shared by both asides add +20', () => {
  const target = { title: 'Kesariya (From "Brahmastra")', artist: 'Arijit Singh' };
  assert.equal(M.score(target, song('Kesariya - Brahmastra', 'Arijit Singh')), 100 + 25 + 20);
  assert.equal(M.score(target, song('Kesariya', 'Arijit Singh')), 100 + 25);
});

// ── Official audio for a video ─────────────────────────────────────────────

test('manual video audio switch accepts the official song despite a long visual intro', () => {
  const target = { title: 'Big Dawgs', artist: 'Hanumankind, Kalmi', durationSec: 391, isVideo: true };
  const officialAudio = song('Big Dawgs', 'Hanumankind, Kalmi', '3:11', { id: 'official-audio' });
  const sameTitleCover = song('Big Dawgs', 'Unrelated Cover Artist', '6:31', { id: 'cover' });
  assert.equal(M.best(target, [officialAudio, sameTitleCover]), null);
  assert.equal(M.bestOfficialAudioForVideo(target, [sameTitleCover, officialAudio]), officialAudio);
});

// ── Runtime helpers and resolver-level filters ─────────────────────────────

test('secondsOf reads a queue row runtime', () => {
  assert.equal(M.secondsOf('3:45'), 225);
  assert.equal(M.secondsOf('1:02:03'), 3723);
  assert.equal(M.secondsOf(' 4 : 07 '), 247);
  assert.equal(M.secondsOf(null), null);
  assert.equal(M.secondsOf('live'), null);
  assert.equal(M.secondsOf('0:00'), null);
  assert.equal(M.secondsOf('245'), null);
  assert.equal(M.secondsOf('1:2:3:4'), null);
});

test('withinSeconds needs a runtime on both sides (the mid-track swap guard)', () => {
  const playing = { title: 'Jo Tere Sang', artist: 'Jeet Gannguli', durationSec: 306 };
  assert.ok(M.withinSeconds(song('Jo Tere Sang', 'x', '5:06'), playing, 2));
  assert.ok(M.withinSeconds(song('Jo Tere Sang', 'x', '5:04'), playing, 2));
  assert.equal(M.withinSeconds(song('Jo Tere Sang', 'x', '5:12'), playing, 2), false);
  assert.equal(M.withinSeconds(song('Jo Tere Sang', 'x'), playing, 2), false);
  assert.equal(M.withinSeconds(song('Jo Tere Sang', 'x', '5:06'), { title: 'Jo Tere Sang', artist: 'Jeet Gannguli' }, 2), false);
});

test('isSevereMismatch flags more than 30 s of drift (the São Paulo regression)', () => {
  assert.equal(M.isSevereMismatch(302, 209), true);
  assert.equal(M.isSevereMismatch(302, 300), false);
  assert.equal(M.isSevereMismatch(302, 288), false);
  assert.equal(M.isSevereMismatch(null, 209), false);
  assert.ok(M.withinSeconds(song('São Paulo', 'The Weeknd, Anitta', '5:02'), { title: 'São Paulo', durationSec: 302 }, 2));
});

test('keepSameRecording keeps only rows within ±3 s, unless none is', () => {
  const target = { title: 'Sakhiyaan', artist: 'Maninder Buttar', durationSec: 180 };
  const djEdit = song('Sakhiyaan', 'Maninder Buttar', '3:05');
  const albumCut = song('Sakhiyaan', 'Maninder Buttar', '3:03');
  assert.deepEqual(M.keepSameRecording([djEdit, albumCut], target), [albumCut]);
  assert.deepEqual(M.keepSameRecording([djEdit], target), [djEdit]);
  assert.equal(M.SAME_RECORDING_SEC, 3);
});

test('keepStrictLength keeps only rows within ±2 s, and nothing against a target without a runtime', () => {
  const target = { title: 'Mexico', artist: 'Karan Aujla', durationSec: 207 };
  const rows = [song('Mexico', 'Karan Aujla', '3:29'), song('Mexico', 'Karan Aujla', '3:30')];
  assert.deepEqual(M.keepStrictLength(rows, target), [rows[0]]);
  assert.deepEqual(M.keepStrictLength(rows, { ...target, durationSec: null }), []);
  assert.equal(M.UPGRADE_DRIFT_SEC, 2);
});

test('keepSharedArtist refuses same title and runtime from a different artist', () => {
  const target = { title: 'Mexico', artist: 'Karan Aujla', durationSec: 207 };
  const cake = song('Mexico', 'CAKE', '3:26');
  // The runtime alone admits it to ranking...
  assert.deepEqual(M.ranked(target, [cake]), [cake]);
  // ...and the shared-artist requirement of upgrades and downloads removes it.
  assert.deepEqual(M.keepSharedArtist([cake], target), []);
});
