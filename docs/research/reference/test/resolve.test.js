// Tests for sources/resolve.js: bestAcross / matchAndStream / streamBest
// (SourceResolver.kt), the race (PlaybackService.resolveWithModulePriority),
// StreamChoice.kt, and the swap rules. Several cases are ported from
// app/src/test/.../SourcesTest.kt and StreamChoiceTest.kt.
// Independent JavaScript re-implementation of the mechanism documented in BITCHORD_ENGINE_RESEARCH.md (BitChord itself is GPL-3.0).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  acceptsLateLookup,
  bestAcross,
  effectiveTargetDuration,
  formatSummary,
  isBetter,
  isManifestStream,
  malformed,
  matchAndStream,
  permits,
  preferred,
  qualityTier,
  raceWithFallback,
  rankedAbove,
  requestForQuality,
  requestTier,
  resolveWatch,
  sameRecordingAs,
  sortByRank,
  SOURCE_KINDS,
  StreamChoice,
  StreamRequest,
  substituteForYouTube,
  upgradeFor,
  worthSwapping,
} from '../sources/resolve.js';

const RACE_TITLE = 'Paniyon Sa';
const RACE_ARTIST = 'Atif Aslam';
const raceTarget = () => ({ title: RACE_TITLE, artist: RACE_ARTIST, durationSec: 120 });

function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}

/** `promise`, or a rejection when `signal` aborts first. */
function until(promise, signal) {
  return new Promise((resolve, reject) => {
    signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
    promise.then(resolve, reject);
  });
}

/** Resolves after `ms`, for sources that must answer in the same instant. */
const gateAfter = (ms) => delay(ms);

/**
 * A source that answers its search after `delayMs` with `rows` (default: one
 * matching row) and streams `format` (null: has nothing). Records what it was
 * asked and whether it was aborted.
 */
function fakeSource(id, { delayMs = 0, gate = null, format = null, rows = null, kind = 'jiosaavn', searchError = null } = {}) {
  const state = { searches: [], streamed: [], aborted: false };
  return {
    id,
    displayName: id,
    kind,
    rank: SOURCE_KINDS[kind].rank,
    canServeLossless: SOURCE_KINDS[kind].canServeLossless,
    state,
    async search(query, { limit, signal, waitForAll, request }) {
      state.searches.push({ query, limit, waitForAll, request });
      try {
        // A shared gate models answers that arrive in the same instant.
        await (gate ? until(gate, signal) : delay(delayMs, signal));
      } catch (error) {
        state.aborted = true;
        throw error;
      }
      if (searchError) throw searchError;
      if (rows) return rows;
      if (format == null) return [];
      return [{ id: `${id}-1`, title: RACE_TITLE, artist: RACE_ARTIST, durationSec: 120 }];
    },
    async stream(trackId) {
      state.streamed.push(trackId);
      const answer = typeof format === 'function' ? format(trackId) : format;
      return answer ? { url: `https://${id}.example/${trackId}`, format: answer } : null;
    },
  };
}

// ── Formats and the swap rules ─────────────────────────────────────────────

test('isBetter: Atmos > lossless > kbps; ties and unknowns do not displace', () => {
  assert.equal(isBetter({ codec: 'mp4', kbps: 320 }, { codec: 'mp3', kbps: 128 }), true);
  assert.equal(isBetter({ codec: 'mp3', kbps: 128 }, { codec: 'mp4', kbps: 320 }), false);
  assert.equal(isBetter({ codec: 'flac' }, { codec: 'mp4', kbps: 320 }), true);
  assert.equal(isBetter({ codec: 'mp4', kbps: 320 }, { codec: 'flac' }), false);
  assert.equal(isBetter({ codec: 'eac3-joc', sampleRate: 48000 }, { codec: 'flac', bitDepth: 24, sampleRate: 96000 }), true);
  assert.equal(isBetter({ codec: 'flac', bitDepth: 24 }, { codec: 'eac3-joc' }), false);
  assert.equal(isBetter({ codec: 'mp3', kbps: 128 }, null), true);
  assert.equal(isBetter({ codec: 'mp4', kbps: 320 }, { codec: 'aac', kbps: 320 }), false);
  assert.equal(isBetter({ codec: 'flac' }, { codec: 'alac' }), false);
  assert.equal(isBetter({ codec: 'aac' }, { codec: 'mp4', kbps: 320 }), false);
  // Tri-state: an unstated codec never beats a stated lossy one on the lossless line.
  assert.equal(isBetter({ kbps: 999 }, { codec: 'mp3', kbps: 128 }), false);
});

test('worthSwapping: never away from Atmos, always to lossless/Atmos, lossy needs +96 kbps', () => {
  const youtube = { codec: 'opus', kbps: 160 };
  assert.equal(worthSwapping({ codec: 'flac' }, youtube), true);
  assert.equal(worthSwapping({ codec: 'flac' }, { codec: 'aac', kbps: 320 }), true);
  assert.equal(worthSwapping({ codec: 'aac', kbps: 320 }, youtube), true);
  assert.equal(worthSwapping({ codec: 'aac', kbps: 256 }, youtube), true); // exactly +96
  assert.equal(worthSwapping({ codec: 'aac', kbps: 255 }, youtube), false);
  assert.equal(worthSwapping({ codec: 'mp3', kbps: 192 }, { codec: 'aac', kbps: 128 }), false);
  assert.equal(worthSwapping({ codec: 'mp3', kbps: 128 }, youtube), false);
  assert.equal(worthSwapping({ codec: 'aac' }, youtube), false);
  assert.equal(worthSwapping({ codec: 'aac', kbps: 320 }, null), false);
  assert.equal(worthSwapping({ codec: 'aac', kbps: 320 }, { codec: 'opus' }), false);
  assert.equal(worthSwapping({ codec: 'flac', bitDepth: 24 }, { codec: 'eac3-joc' }), false);
  assert.equal(worthSwapping({ codec: 'eac3-joc' }, { codec: 'flac', bitDepth: 24 }), true);
});

test('sameRecordingAs: within 2 s, both known; effectiveTargetDuration keeps the catalogue on severe drift', () => {
  assert.equal(sameRecordingAs(302, 302), true);
  assert.equal(sameRecordingAs(304, 302), true);
  assert.equal(sameRecordingAs(305, 302), false);
  assert.equal(sameRecordingAs(null, 302), false);
  assert.equal(effectiveTargetDuration(302, 209), 302);
  assert.equal(effectiveTargetDuration(302, 300), 300);
  assert.equal(effectiveTargetDuration(null, 209), 209);
  assert.equal(effectiveTargetDuration(302, null), 302);
});

test('request tiers, quality ceilings and which sources a ceiling permits', () => {
  assert.equal(requestTier(StreamRequest.lossless), 'LOSSLESS');
  assert.equal(requestTier(StreamRequest.best), 'HIGH');
  assert.equal(requestTier(StreamRequest.capped(128)), 'LOW');
  assert.equal(requestTier(StreamRequest.capped(129)), 'HIGH');
  assert.deepEqual(requestForQuality('LOSSLESS'), { kind: 'lossless' });
  assert.deepEqual(requestForQuality('HIGH'), { kind: 'best' });
  assert.deepEqual(requestForQuality('MEDIUM'), { kind: 'best' });
  assert.deepEqual(requestForQuality('LOW'), { kind: 'capped', kbps: 64 });
  assert.equal(permits('LOSSLESS', 'addon'), true);
  assert.equal(permits('HIGH', 'addon'), false);
  assert.equal(permits('HIGH', 'jiosaavn'), true);
  assert.equal(permits('MEDIUM', 'jiosaavn'), false);
  assert.equal(permits('LOW', 'youtube'), true);
});

test('qualityTier reads a tier out of whatever a module calls it', () => {
  assert.equal(qualityTier('LOSSLESS'), 'LOSSLESS');
  assert.equal(qualityTier('FLAC 16-bit / 44.1kHz'), 'LOSSLESS');
  assert.equal(qualityTier('hires-96'), 'LOSSLESS');
  assert.equal(qualityTier('24-bit / 192 kHz'), 'LOSSLESS');
  assert.equal(qualityTier('FLAC 128'), 'LOSSLESS');
  assert.equal(qualityTier('HIGH'), 'HIGH');
  assert.equal(qualityTier('320kbps'), 'HIGH');
  assert.equal(qualityTier('128kbps'), 'LOW');
  assert.equal(qualityTier(''), null);
  assert.equal(qualityTier('Deadbeat'), null);
});

test('malformed: unparseable, non-http, or carrying a second copy of its own origin', () => {
  const blob = 'eyJhbGciOiJIUzI1NiJ9';
  assert.equal(malformed(`https://sp-ad-fa.audio.tidal.com/mediatracks/${blob}/https://sp-ad-fa.audio.tidal.com/mediatracks/${blob}/0.mp4?token=1~c2ln`), true);
  assert.equal(malformed(`https://sp-ad-fa.audio.tidal.com/mediatracks/${blob}/0.mp4?token=1~c2ln`), false);
  assert.equal(malformed('https://cdn.example.com/get?url=https://real.host/f.flac'), false);
  assert.equal(malformed('https://cdn.example.com/https://real.host/f.flac'), false);
  for (const bad of ['/mediatracks/blob/0.mp4', 'sp-ad-fa.audio.tidal.com/x.mp4', 'bitchord://watch?v=x', '', 'undefined', 'null',
    'file:///data/x.flac', 'content://media/external/audio/media/42', 'ftp://cdn.example.com/f.mp3']) {
    assert.equal(malformed(bad), true, bad);
  }
  assert.equal(malformed('https://sp-ad-fa.audio.tidal.com'), false);
});

test('isManifestStream: a declared transport or a .mpd/.m3u8 extension', () => {
  assert.equal(isManifestStream({ url: 'https://cdn/a/manifest.mpd?token=1' }), true);
  assert.equal(isManifestStream({ url: 'https://cdn/a/playlist.m3u8' }), true);
  assert.equal(isManifestStream({ url: 'https://cdn/dash/t1', transport: 'dash' }), true);
  assert.equal(isManifestStream({ url: 'https://cdn/a/track.flac' }), false);
});

test('formatSummary mirrors StreamFormat.summary', () => {
  assert.equal(formatSummary({ codec: 'flac', bitDepth: 24, sampleRate: 96000, kbps: 2000 }), 'FLAC · 24-bit · 96 kHz');
  assert.equal(formatSummary({ codec: 'flac', sampleRate: 44100 }), 'FLAC · 44.1 kHz');
  assert.equal(formatSummary({ codec: 'mp4', kbps: 320 }), 'MP4 · 320 kbps');
  assert.equal(formatSummary({ codec: 'eac3-joc', kbps: 768 }), 'Dolby Atmos');
  assert.equal(formatSummary({}), 'Unknown format');
});

// ── Ordering ────────────────────────────────────────────────────────────────

test('sortByRank is stable, so the user order survives among rank-0 sources', () => {
  const sources = [
    { id: 'yt', kind: 'youtube' },
    { id: 'addon-b', kind: 'addon' },
    { id: 'saavn', kind: 'jiosaavn' },
    { id: 'module-a', kind: 'custom_module' },
  ];
  const ordered = sortByRank(sources);
  assert.deepEqual(ordered.map((s) => s.id), ['addon-b', 'module-a', 'saavn', 'yt']);
  assert.deepEqual(rankedAbove(ordered, 'saavn').map((s) => s.id), ['addon-b', 'module-a']);
  assert.deepEqual(rankedAbove(ordered, 'missing').map((s) => s.id), ['addon-b', 'module-a', 'saavn', 'yt']);
});

test('preferred: the right runtime beats a lossless label; the label breaks a tie', () => {
  const target = { title: 'Sakhiyaan', artist: 'Maninder Buttar', durationSec: 180 };
  const djEdit = { id: 'dj', title: 'Sakhiyaan', artist: 'Maninder Buttar', durationSec: 185, quality: 'LOSSLESS' };
  const albumCut = { id: 'album', title: 'Sakhiyaan', artist: 'Maninder Buttar', durationSec: 180 };
  assert.deepEqual(preferred([djEdit, albumCut], target, true), [albumCut]);
  const plain = { id: 'plain', title: 'Sakhiyaan', artist: 'Maninder Buttar', durationSec: 180 };
  const lossless = { ...plain, id: 'lossless', quality: 'LOSSLESS' };
  assert.deepEqual(preferred([plain, lossless], target, true), [lossless, plain]);
  assert.deepEqual(preferred([plain, lossless], target, false), [plain, lossless]);
});

test('preferred: the immersive row goes first only when Atmos is wanted', () => {
  const target = { title: 'Gehra Hua', artist: 'Shashwat Sachdev', durationSec: 362 };
  const stereo = { id: 'stereo', title: 'Gehra Hua', artist: 'Shashwat Sachdev', durationSec: 362, quality: 'LOSSLESS' };
  const atmos = { ...stereo, id: 'atmos', quality: 'DOLBY' };
  assert.deepEqual(preferred([stereo, atmos], target, true, { atmosWanted: true }), [atmos, stereo]);
  assert.deepEqual(preferred([stereo, atmos], target, true, { atmosWanted: false }), [stereo, atmos]);
});

// ── matchAndStream and streamBest ──────────────────────────────────────────

test('matchAndStream: queries run one after another, with limit 15 and the request', async () => {
  const seen = [];
  const source = {
    id: 'addon',
    kind: 'addon',
    async search(query, { limit, request, waitForAll }) {
      seen.push({ query, limit, request, waitForAll });
      // The catalogue files the track under the composer: only the bare title finds it.
      return query === 'paniyon sa' ? [{ id: 't1', title: 'Paniyon Sa', artist: 'Atif Aslam, Tulsi Kumar', durationSec: 247 }] : [];
    },
    async stream() {
      return { url: 'https://cdn.example/t1.flac', format: { codec: 'flac' } };
    },
  };
  const target = { title: 'Paniyon Sa (From "Satyameva Jayate")', artist: 'Atif Aslam', durationSec: 247 };
  const stream = await matchAndStream(source, target, StreamRequest.lossless);
  assert.deepEqual(seen.map((s) => s.query), ['paniyon sa atif aslam', 'paniyon sa']);
  assert.ok(seen.every((s) => s.limit === 15 && s.request.kind === 'lossless' && s.waitForAll === false));
  assert.equal(stream.url, 'https://cdn.example/t1.flac');
  assert.equal(stream.durationSec, 247);
  assert.equal(stream.sourceId, 'addon');
});

test('matchAndStream: a source that throws gets no second query', async () => {
  const source = fakeSource('broken', { searchError: new Error('HTTP 500') });
  assert.equal(await matchAndStream(source, raceTarget(), StreamRequest.best), null);
  assert.equal(source.state.searches.length, 1);
});

test('matchAndStream: the first query with matches decides, even if nothing streams', async () => {
  const source = fakeSource('empty-streams', { format: null, rows: [{ id: 'r1', title: RACE_TITLE, artist: RACE_ARTIST, durationSec: 120 }] });
  assert.equal(await matchAndStream(source, raceTarget(), StreamRequest.best), null);
  assert.equal(source.state.searches.length, 1);
  assert.deepEqual(source.state.streamed, ['r1']);
});

test('streamBest: at most 3 rows opened; for lossless, the best refusal comes back below request', async () => {
  const rows = ['a', 'b', 'c', 'd'].map((id) => ({ id, title: RACE_TITLE, artist: RACE_ARTIST, durationSec: 120 }));
  const formats = { a: { codec: 'mp3', kbps: 128 }, b: { codec: 'mp4', kbps: 320 }, c: { codec: 'mp3', kbps: 192 }, d: { codec: 'flac' } };
  const source = fakeSource('lossy', { rows, format: (id) => formats[id] });
  const stream = await matchAndStream(source, raceTarget(), StreamRequest.lossless);
  assert.deepEqual(source.state.streamed, ['a', 'b', 'c']); // 'd' held a FLAC but was the 4th row
  assert.equal(stream.belowRequest, true);
  assert.equal(stream.format.kbps, 320);
});

test('streamBest: a stream that states nothing is accepted for lossless; any answer for best', async () => {
  const rows = [{ id: 'x', title: RACE_TITLE, artist: RACE_ARTIST, durationSec: 120 }];
  const undescribed = fakeSource('quiet', { rows, format: {} });
  assert.equal((await matchAndStream(undescribed, raceTarget(), StreamRequest.lossless)).belowRequest, undefined);
  const lossy = fakeSource('lossy', { rows, format: { codec: 'mp3', kbps: 128 } });
  assert.equal((await matchAndStream(lossy, raceTarget(), StreamRequest.best)).belowRequest, undefined);
});

test('streamBest: a row whose stream call throws costs that row, not the source', async () => {
  const rows = [
    { id: 'bad', title: RACE_TITLE, artist: RACE_ARTIST, durationSec: 120 },
    { id: 'good', title: RACE_TITLE, artist: RACE_ARTIST, durationSec: 120 },
  ];
  const source = {
    id: 's',
    kind: 'addon',
    search: async () => rows,
    stream: async (id) => {
      if (id === 'bad') throw new Error('HTTP 502');
      return { url: 'https://cdn.example/good.flac', format: { codec: 'flac' } };
    },
  };
  assert.equal((await matchAndStream(source, raceTarget(), StreamRequest.lossless)).url, 'https://cdn.example/good.flac');
});

test('matchAndStream: JioSaavn refuses conflicting albums when the target names none', async () => {
  const source = fakeSource('JioSaavn', {
    format: { codec: 'mp4', kbps: 320 },
    rows: [
      { id: 'iv', title: 'Brown Rang', artist: 'Yo Yo Honey Singh', durationSec: 179, album: 'International Villager' },
      { id: 'ci', title: 'Brown Rang', artist: 'Yo Yo Honey Singh', durationSec: 174, album: 'Chaar Ikke' },
    ],
  });
  const target = { title: 'Brown Rang', artist: 'Yo Yo Honey Singh', durationSec: 175 };
  assert.equal(await bestAcross([source], target, StreamRequest.best), null);
});

// ── bestAcross (the '9:45' cases from SourcesTest.kt) ──────────────────────

test('bestAcross takes the quick answer rather than waiting for a slow better one, and aborts it', async () => {
  const slow = fakeSource("Ricky's Addon", { delayMs: 2_000, format: { codec: 'flac' }, kind: 'addon' });
  const quick = fakeSource('JioSaavn', { delayMs: 5, format: { codec: 'mp4', kbps: 320 } });
  const started = Date.now();
  const found = await bestAcross([slow, quick], raceTarget(), StreamRequest.lossless);
  assert.ok(Date.now() - started < 1_000, 'waited for the slow source');
  assert.equal(found.source.id, 'JioSaavn');
  assert.equal(found.stream.format.kbps, 320);
  assert.equal(found.stream.belowRequest, true);
  assert.equal(slow.state.searches.length, 1, 'the slow source was never asked');
  assert.equal(slow.state.aborted, true, 'the slow source was left running');
});

test('bestAcross prefers the better of two answers that arrive together', async () => {
  const gate = gateAfter(5);
  const worse = fakeSource("Ricky's Addon", { gate, format: { codec: 'mp3', kbps: 128 } });
  const better = fakeSource('JioSaavn', { gate, format: { codec: 'mp4', kbps: 320 } });
  const found = await bestAcross([worse, better], raceTarget(), StreamRequest.lossless);
  assert.equal(found.source.id, 'JioSaavn');
});

test('bestAcross: an equal answer arriving together goes to the higher-ranked source', async () => {
  const gate = gateAfter(5);
  const first = fakeSource('first', { gate, format: { codec: 'mp4', kbps: 320 } });
  const second = fakeSource('second', { gate, format: { codec: 'mp4', kbps: 320 } });
  assert.equal((await bestAcross([first, second], raceTarget(), StreamRequest.best)).source.id, 'first');
  // Listed the other way round, the other one wins: rank, not speed, breaks the tie.
  const gate2 = gateAfter(5);
  const a = fakeSource('a', { gate: gate2, format: { codec: 'mp4', kbps: 320 } });
  const b = fakeSource('b', { gate: gate2, format: { codec: 'mp4', kbps: 320 } });
  assert.equal((await bestAcross([b, a], raceTarget(), StreamRequest.best)).source.id, 'b');
});

test('bestAcross keeps waiting when the first source to answer has nothing', async () => {
  const empty = fakeSource("Ricky's Addon", { delayMs: 5, format: null });
  const holder = fakeSource('JioSaavn', { delayMs: 50, format: { codec: 'mp4', kbps: 320 } });
  assert.equal((await bestAcross([empty, holder], raceTarget(), StreamRequest.lossless)).source.id, 'JioSaavn');
});

test('bestAcross has nothing when no source holds the track', async () => {
  const a = fakeSource('a', { delayMs: 5, format: null });
  const b = fakeSource('b', { delayMs: 10, format: null });
  assert.equal(await bestAcross([a, b], raceTarget(), StreamRequest.lossless), null);
  assert.equal(await bestAcross([], raceTarget(), StreamRequest.lossless), null);
});

test('bestAcross with waitForAll chooses the better later answer and aborts nothing', async () => {
  const playing = { codec: 'opus', kbps: 141 };
  const slowLossless = fakeSource("Ricky's Addon", { delayMs: 60, format: { codec: 'flac' }, kind: 'addon' });
  const quickLossy = fakeSource('JioSaavn', { delayMs: 5, format: { codec: 'mp4', kbps: 320 } });
  const found = await bestAcross([slowLossless, quickLossy], raceTarget(), StreamRequest.lossless, {
    waitForAll: true,
    strictLength: true,
    accept: (_source, stream) => worthSwapping(stream.format, playing),
  });
  assert.equal(found.source.id, "Ricky's Addon");
  assert.equal(found.stream.format.codec, 'flac');
  assert.equal(slowLossless.state.aborted, false);
  assert.ok(slowLossless.state.searches.every((s) => s.waitForAll === true));
});

test('bestAcross keeps waiting when the quick answer is refused by accept', async () => {
  const playing = { codec: 'opus', kbps: 141 };
  const quickRefused = fakeSource("Ricky's Addon", { delayMs: 5, format: { codec: 'mp3', kbps: 128 } });
  const slowTaken = fakeSource('JioSaavn', { delayMs: 50, format: { codec: 'mp4', kbps: 320 } });
  const found = await bestAcross([quickRefused, slowTaken], raceTarget(), StreamRequest.lossless, {
    accept: (_source, stream) => worthSwapping(stream.format, playing),
  });
  assert.equal(found.source.id, 'JioSaavn');
});

test('bestAcross with requireSharedArtist refuses same title and runtime from a different artist', async () => {
  const wrongMexico = fakeSource("Ricky's Addon", {
    format: { codec: 'flac' },
    rows: [{ id: 'cake', title: 'Mexico', artist: 'CAKE', durationSec: 206 }],
  });
  const target = { title: 'Mexico', artist: 'Karan Aujla', durationSec: 207 };
  assert.equal(
    await bestAcross([wrongMexico], target, StreamRequest.lossless, { waitForAll: true, strictLength: true, requireSharedArtist: true }),
    null,
  );
  // Without the requirement the runtime alone lets it through.
  assert.equal((await bestAcross([wrongMexico], target, StreamRequest.lossless)).source.id, "Ricky's Addon");
});

test('bestAcross: aborting the caller aborts every source and rejects', async () => {
  const slow = fakeSource('slow', { delayMs: 1_000, format: { codec: 'flac' } });
  const controller = new AbortController();
  const pending = bestAcross([slow], raceTarget(), StreamRequest.lossless, { signal: controller.signal });
  setTimeout(() => controller.abort(), 10);
  await assert.rejects(pending, (error) => error.name === 'AbortError');
  await delay(5);
  assert.equal(slow.state.aborted, true);
});

// ── substituteForYouTube and upgradeFor ────────────────────────────────────

test('substituteForYouTube asks only the sources ranked above YouTube, and never for a video', async () => {
  const addon = fakeSource('addon', { delayMs: 5, format: { codec: 'flac' }, kind: 'addon' });
  const youtube = fakeSource('youtube', { format: { codec: 'opus', kbps: 160 }, kind: 'youtube' });
  const below = fakeSource('below', { format: { codec: 'flac' }, kind: 'jiosaavn' });
  const stream = await substituteForYouTube([addon, youtube, below], raceTarget(), StreamRequest.lossless);
  assert.equal(stream.sourceId, 'addon');
  assert.equal(youtube.state.searches.length, 0);
  assert.equal(below.state.searches.length, 0);
  assert.equal(await substituteForYouTube([addon, youtube], { ...raceTarget(), isVideo: true }, StreamRequest.lossless), null);
  assert.equal(await substituteForYouTube([addon], raceTarget(), StreamRequest.lossless), null); // no YouTube configured
});

test('upgradeFor: patient, strict ±2 s, shared artist, worth swapping, and never the source already serving', async () => {
  const serving = fakeSource('serving', { format: { codec: 'mp4', kbps: 320 }, kind: 'addon' });
  const lossless = fakeSource('lossless', {
    delayMs: 30,
    format: { codec: 'flac' },
    kind: 'addon',
    rows: [{ id: 'f', title: RACE_TITLE, artist: RACE_ARTIST, durationSec: 121 }],
  });
  const offByThree = fakeSource('offByThree', {
    format: { codec: 'flac' },
    kind: 'addon',
    rows: [{ id: 'g', title: RACE_TITLE, artist: RACE_ARTIST, durationSec: 123 }],
  });
  const youtube = fakeSource('youtube', { kind: 'youtube' });
  const playing = { codec: 'mp4', kbps: 320 };
  const stream = await upgradeFor([serving, offByThree, lossless, youtube], raceTarget(), StreamRequest.lossless, {
    playing,
    servedBy: 'serving',
  });
  assert.equal(stream.sourceId, 'lossless');
  assert.equal(serving.state.searches.length, 0);
  assert.equal(await upgradeFor([lossless, youtube], { ...raceTarget(), durationSec: null }, StreamRequest.lossless, { playing }), null);
});

// ── The race ────────────────────────────────────────────────────────────────

/** A leg that answers `value` (or throws `error`) after `ms`, recording start, signal and abort. */
function leg(ms, value, error = null) {
  const record = { startedAt: null, aborted: false, signal: null };
  const fn = async (signal) => {
    record.startedAt = Date.now();
    record.signal = signal;
    try {
      await delay(ms, signal);
    } catch (reason) {
      record.aborted = true;
      throw reason;
    }
    if (error) throw error;
    return value;
  };
  fn.record = record;
  return fn;
}

const FLAC = { url: 'https://cdn.example/a.flac', format: { codec: 'flac' }, sourceId: 'addon', durationSec: 120 };
const YOUTUBE = { url: 'https://rr1.googlevideo.example/videoplayback?itag=251', format: { codec: 'opus', kbps: 160 } };

test('race: the source wins with what was asked for; the fallback wait is dropped', async () => {
  const lookup = leg(5, FLAC);
  const fallback = leg(40, YOUTUBE);
  const outcome = await raceWithFallback({ lookup, fallback, timeoutMs: 1_000 });
  assert.equal(outcome.winner, 'source');
  assert.equal(outcome.reason, 'met-request');
  assert.equal(outcome.stream, FLAC);
  assert.equal(outcome.substituted, true);
  assert.equal(outcome.pending, null);
  assert.equal(outcome.upgrade, null);
  assert.equal(fallback.record.signal.aborted, true);
});

test('race: no head start, both legs start at the same instant', async () => {
  const lookup = leg(5, FLAC);
  const fallback = leg(5, YOUTUBE);
  await raceWithFallback({ lookup, fallback, timeoutMs: 1_000 });
  assert.ok(Math.abs(lookup.record.startedAt - fallback.record.startedAt) < 5);
});

test('race: a source answer below the request plays, and arms an upgrade against it', async () => {
  const lossy = { url: 'https://cdn.example/a.mp4', format: { codec: 'mp4', kbps: 320 }, sourceId: 'saavn', belowRequest: true };
  const outcome = await raceWithFallback({ lookup: leg(5, lossy), fallback: leg(40, YOUTUBE), timeoutMs: 1_000 });
  assert.equal(outcome.winner, 'source');
  assert.equal(outcome.reason, 'below-request');
  assert.deepEqual(outcome.upgrade, { inFlight: null, playing: lossy.format, servedBy: 'saavn' });
});

test('race: YouTube wins and the still-running lookup is handed back as pending, not cancelled', async () => {
  const lookup = leg(60, FLAC);
  const outcome = await raceWithFallback({ lookup, fallback: leg(5, YOUTUBE), timeoutMs: 1_000 });
  assert.equal(outcome.winner, 'fallback');
  assert.equal(outcome.reason, 'fallback-first');
  assert.equal(outcome.stream.url, YOUTUBE.url);
  assert.equal(outcome.substituted, false);
  assert.ok(outcome.pending instanceof Promise);
  assert.equal(outcome.upgrade.inFlight, outcome.pending);
  assert.deepEqual(outcome.upgrade.playing, YOUTUBE.format);
  assert.equal(lookup.record.signal.aborted, false);
  // The lookup finishes on its own time; the upgrade path judges it against
  // what is playing and the decoder-reported runtime.
  const late = await outcome.pending;
  assert.equal(late, FLAC);
  assert.equal(acceptsLateLookup(late, { playing: outcome.upgrade.playing, playingDurationSec: 121, expectedSec: 120 }), true);
  assert.equal(acceptsLateLookup(late, { playing: outcome.upgrade.playing, playingDurationSec: 163, expectedSec: 189 }), false);
});

test('race: a fallback that finished without a URL has not won; the lookup is waited for', async () => {
  // An age-gated track: YouTube refuses at once, a catalogue has it.
  const outcome = await raceWithFallback({
    lookup: leg(40, FLAC),
    fallback: leg(1, null, new Error('This video is age restricted')),
    timeoutMs: 1_000,
  });
  assert.equal(outcome.winner, 'source');
  assert.equal(outcome.stream, FLAC);
  // An answer with no URL counts the same as a throw.
  const empty = await raceWithFallback({ lookup: leg(30, FLAC), fallback: leg(1, { url: '' }), timeoutMs: 1_000 });
  assert.equal(empty.winner, 'source');
});

test('race: when both come back empty the fallback error surfaces', async () => {
  await assert.rejects(
    raceWithFallback({ lookup: leg(10, null), fallback: leg(1, null, new Error('unplayable')), timeoutMs: 1_000 }),
    /unplayable/,
  );
});

test('race: a manifest found first still starts on YouTube and is handed over already answered', async () => {
  const manifest = { url: 'https://cdn.example/dash/t1', transport: 'dash', format: { codec: 'flac' }, sourceId: 'addon' };
  const outcome = await raceWithFallback({ lookup: leg(5, manifest), fallback: leg(30, YOUTUBE), timeoutMs: 1_000 });
  assert.equal(outcome.winner, 'fallback');
  assert.equal(outcome.reason, 'manifest');
  assert.equal(outcome.stream.url, YOUTUBE.url);
  assert.equal(await outcome.pending, manifest);
  assert.equal(outcome.upgrade.inFlight, outcome.pending);
  // Detected by extension too.
  const mpd = { url: 'https://cdn.example/a/manifest.mpd?token=1', format: { codec: 'flac' } };
  assert.equal((await raceWithFallback({ lookup: leg(1, mpd), fallback: leg(10, YOUTUBE), timeoutMs: 1_000 })).reason, 'manifest');
});

test('race: a manifest with no YouTube behind it plays anyway, to fail once and be replayed typed', async () => {
  const manifest = { url: 'https://cdn.example/a/manifest.mpd', format: { codec: 'flac' } };
  const outcome = await raceWithFallback({ lookup: leg(5, manifest), fallback: leg(10, null, new Error('unplayable')), timeoutMs: 1_000 });
  assert.equal(outcome.winner, 'source');
  assert.equal(outcome.reason, 'manifest-only');
  assert.equal(outcome.stream, manifest);
});

test('race: the lookup is capped at timeoutMs; its signal is aborted and it reads as a miss', async () => {
  const lookup = leg(10_000, FLAC); // never in time
  const outcome = await raceWithFallback({ lookup, fallback: leg(60, YOUTUBE), timeoutMs: 20 });
  assert.equal(outcome.winner, 'fallback');
  assert.equal(outcome.reason, 'lookup-missed');
  assert.equal(outcome.pending, null);
  assert.equal(lookup.record.aborted, true);
  assert.equal(lookup.record.signal.reason.name, 'TimeoutError');
});

test('race: a pending lookup that later times out resolves to null', async () => {
  const lookup = leg(10_000, FLAC);
  const outcome = await raceWithFallback({ lookup, fallback: leg(1, YOUTUBE), timeoutMs: 30 });
  assert.equal(outcome.reason, 'fallback-first');
  assert.equal(await outcome.pending, null);
  assert.equal(lookup.record.aborted, true);
});

test('race: cancelPending aborts a handed-over lookup nobody wants any more', async () => {
  const lookup = leg(10_000, FLAC);
  const outcome = await raceWithFallback({ lookup, fallback: leg(1, YOUTUBE), timeoutMs: 5_000 });
  outcome.cancelPending();
  assert.equal(await outcome.pending, null);
  assert.equal(lookup.record.aborted, true);
});

test('race: refused substitutes skip the lookup entirely', async () => {
  const lookup = leg(1, FLAC);
  const outcome = await raceWithFallback({ lookup, fallback: leg(1, YOUTUBE.url), refused: true });
  assert.equal(outcome.reason, 'substitutes-refused');
  assert.equal(outcome.stream.url, YOUTUBE.url);
  assert.equal(lookup.record.startedAt, null);
});

test('race: the caller giving up aborts both legs', async () => {
  const lookup = leg(1_000, FLAC);
  const fallback = leg(1_000, YOUTUBE);
  const controller = new AbortController();
  const racing = raceWithFallback({ lookup, fallback, timeoutMs: 5_000, signal: controller.signal });
  setTimeout(() => controller.abort(), 10);
  await assert.rejects(racing, (error) => error.name === 'AbortError');
  await delay(5);
  assert.equal(lookup.record.aborted, true);
  assert.equal(fallback.record.aborted, true);
});

test('race end to end: substituteForYouTube is the lookup leg', async () => {
  const saavn = fakeSource('JioSaavn', { delayMs: 5, format: { codec: 'mp4', kbps: 320 } });
  const youtube = fakeSource('youtube', { kind: 'youtube' });
  const sources = [saavn, youtube];
  const outcome = await raceWithFallback({
    lookup: (signal) => substituteForYouTube(sources, raceTarget(), StreamRequest.lossless, { signal }),
    fallback: leg(50, YOUTUBE),
    timeoutMs: 1_000,
  });
  assert.equal(outcome.winner, 'source');
  assert.equal(outcome.reason, 'below-request'); // 320 kbps against a lossless request
  assert.equal(outcome.upgrade.servedBy, 'JioSaavn');
});

// ── StreamChoice (StreamChoiceTest.kt) ─────────────────────────────────────

test('StreamChoice: a remembered choice is handed back, and forgetting reopens the question', () => {
  const choice = new StreamChoice();
  assert.equal(choice.of('track-2'), null);
  choice.remember('track-1', { url: 'https://aac.saavncdn.com/track.mp4', format: { codec: 'mp4', kbps: 320 } }, true);
  assert.equal(choice.of('track-1').url, 'https://aac.saavncdn.com/track.mp4');
  choice.forget('track-1');
  assert.equal(choice.of('track-1'), null);
});

test('StreamChoice: remembers whether the copy came from a substitute', () => {
  const choice = new StreamChoice();
  choice.remember('track-3', { url: 'https://aac.saavncdn.com/t.mp4', format: {} }, true);
  choice.remember('track-4', { url: 'https://googlevideo.example/t', format: {} }, false);
  assert.equal(choice.isSubstitute('track-3'), true);
  assert.equal(choice.isSubstitute('track-4'), false);
});

test('StreamChoice: a pin lasts 15 minutes', () => {
  let clock = 0;
  const choice = new StreamChoice({ now: () => clock });
  choice.remember('t', { url: 'https://a.example/t', format: {} }, true);
  clock = StreamChoice.TTL_MS;
  assert.ok(choice.of('t'));
  clock = StreamChoice.TTL_MS + 1;
  assert.equal(choice.of('t'), null);
});

test('StreamChoice: overflow drops the oldest choice rather than all of them (32 entries)', () => {
  let clock = 0;
  const choice = new StreamChoice({ now: () => clock++ });
  for (let i = 0; i < 40; i++) choice.remember(`track-${i}`, { url: `https://host-${i}.example/track.mp4`, format: {} }, true);
  assert.equal(choice.of('track-39').url, 'https://host-39.example/track.mp4');
  assert.equal(choice.of('track-20').url, 'https://host-20.example/track.mp4');
  assert.equal(choice.of('track-8').url, 'https://host-8.example/track.mp4'); // the 32 newest survive
  assert.equal(choice.of('track-7'), null);
  assert.equal(choice.of('track-0'), null);
});

test('StreamChoice: refused substitutes last 10 minutes', () => {
  let clock = 0;
  const choice = new StreamChoice({ now: () => clock });
  choice.refuseSubstitutes('t');
  clock = StreamChoice.REFUSAL_MS;
  assert.equal(choice.substitutesRefused('t'), true);
  clock = StreamChoice.REFUSAL_MS + 1;
  assert.equal(choice.substitutesRefused('t'), false);
});

test('resolveWatch: race, pin the winner, and reuse the pin on every later open', async () => {
  const choice = new StreamChoice();
  let lookups = 0;
  const lookup = async () => {
    lookups++;
    return { ...FLAC };
  };
  const first = await resolveWatch({ videoId: 'v1', choice, lookup, fallback: leg(30, YOUTUBE), timeoutMs: 1_000 });
  assert.equal(first.pinned, false);
  assert.equal(first.substituted, true);
  const again = await resolveWatch({ videoId: 'v1', choice, lookup, fallback: leg(30, YOUTUBE), timeoutMs: 1_000 });
  assert.equal(again.pinned, true);
  assert.equal(again.stream.url, FLAC.url);
  assert.equal(again.upgrade, null); // a lossless pin needs no second look
  assert.equal(lookups, 1);
});

test('resolveWatch: a lossy substitute pin still arms an upgrade; nothing above YouTube means no race', async () => {
  const choice = new StreamChoice();
  const lossy = { url: 'https://aac.saavncdn.com/t.mp4', format: { codec: 'mp4', kbps: 320 }, sourceId: 'saavn' };
  choice.remember('v2', lossy, true);
  const pinned = await resolveWatch({ videoId: 'v2', choice, lookup: leg(1, null), fallback: leg(1, YOUTUBE) });
  assert.deepEqual(pinned.upgrade, { inFlight: null, playing: lossy.format, servedBy: 'saavn' });

  const lookup = leg(1, FLAC);
  const plain = await resolveWatch({ videoId: 'v3', choice, canSubstitute: false, lookup, fallback: leg(1, YOUTUBE.url) });
  assert.equal(plain.stream.url, YOUTUBE.url);
  assert.equal(lookup.record.startedAt, null);
  assert.equal(choice.isSubstitute('v3'), false);
});

test('resolveWatch: a refused track goes straight to YouTube', async () => {
  const choice = new StreamChoice();
  choice.refuseSubstitutes('v4');
  const lookup = leg(1, FLAC);
  const result = await resolveWatch({ videoId: 'v4', choice, lookup, fallback: leg(1, YOUTUBE), timeoutMs: 1_000 });
  assert.equal(result.outcome.reason, 'substitutes-refused');
  assert.equal(lookup.record.startedAt, null);
});
