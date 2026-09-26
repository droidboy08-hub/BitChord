// Tests for lyrics/repository.js - the fallback chain of BitChord's
// data/lyrics/LyricsRepository.kt and the provider-state machine of
// ui/MainViewModel.kt:242-470. Only fake providers are used: nothing here
// touches the network or imports a real provider module.
//
// Independent JavaScript re-implementation of the mechanism documented in
// BITCHORD_ENGINE_RESEARCH.md (BitChord itself is GPL-3.0).

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { line } from '../lyrics/model.js';
import {
  createLyricsRepository,
  createLyricsController,
  ProviderState,
  LruMap,
} from '../lyrics/repository.js';

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

const WORD = () => [line(1_000, 'hello world', [
  { startMs: 1_000, endMs: 1_400, text: 'hello' },
  { startMs: 1_400, endMs: 2_000, text: 'world' },
])];
const LINE = (text = 'hello world') => [line(1_000, text), line(5_000, 'second line')];
const PLAIN = () => [line(0, 'hello world'), line(0, 'second line')];

const tick = () => new Promise((resolve) => setImmediate(resolve));

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/** A provider whose every call waits until the test answers it. Honours abort unless told not to. */
function controllable(id, { honourAbort = true } = {}) {
  const calls = [];
  const provider = {
    id,
    label: id,
    wordSynced: false,
    lyrics(query, ctx) {
      const d = deferred();
      const call = { query, ctx, ...d, settled: false };
      calls.push(call);
      d.promise.then(() => { call.settled = true; }, () => { call.settled = true; });
      if (honourAbort) ctx.signal.addEventListener('abort', () => d.reject(ctx.signal.reason), { once: true });
      return d.promise;
    },
  };
  provider.calls = calls;
  provider.answer = (value) => calls.at(-1).resolve(value);
  provider.fail = (error) => calls.at(-1).reject(error);
  return provider;
}

/** A provider that answers at once (after a microtask). */
function fixed(id, value) {
  const provider = {
    id,
    label: id,
    wordSynced: false,
    calls: [],
    async lyrics(query, ctx) {
      provider.calls.push({ query, ctx });
      if (value instanceof Error) throw value;
      return typeof value === 'function' ? value(query) : value;
    },
  };
  return provider;
}

function recorder() {
  const events = [];
  return {
    events,
    of: (kind) => events.filter(([k]) => k === kind).map(([, id]) => id),
    callbacks: {
      onSourceStarted: (id) => events.push(['started', id]),
      onSourceResult: (id, result) => events.push([result ? 'found' : 'miss', id]),
      onSourceCancelled: (id) => events.push(['cancelled', id]),
    },
  };
}

const TRACK = { videoId: 'vid1', title: 'Dracula (feat. JENNIE)', artist: 'Tame Impala - Topic', durationMs: 205_000 };

// ---------------------------------------------------------------------------
// the chain
// ---------------------------------------------------------------------------

describe('ordered harvest', () => {
  test('a faster lower-priority answer never preempts a higher-priority source still pending', async () => {
    const a = controllable('a');
    const b = fixed('b', LINE('from b'));
    const repo = createLyricsRepository({ providers: [a, b] });
    const rec = recorder();
    const pending = repo.lyrics(TRACK, { ...rec.callbacks });
    await tick();
    assert.deepEqual(rec.of('found'), ['b']); // b answered first...
    a.answer(LINE('from a'));
    const result = await pending;
    assert.equal(result.source, 'a'); // ...but a is first in order
    assert.equal(result.lines[0].text, 'from a');
    assert.deepEqual(rec.of('cancelled'), []);
  });

  test('word-synced wins outright; pending losers are cancelled, not reported as misses', async () => {
    const a = fixed('a', WORD());
    const b = controllable('b');
    const c = controllable('c');
    const repo = createLyricsRepository({ providers: [a, b, c] });
    const rec = recorder();
    const result = await repo.lyrics(TRACK, { ...rec.callbacks });
    assert.equal(result.source, 'a');
    assert.deepEqual(rec.of('started'), ['a', 'b', 'c']); // all started at once
    assert.deepEqual(rec.of('cancelled').sort(), ['b', 'c']);
    assert.deepEqual(rec.of('miss'), []);
    assert.equal(b.calls[0].ctx.signal.aborted, true);
    assert.equal(c.calls[0].ctx.signal.aborted, true);
  });

  test('a lower-priority word-synced answer waits for the higher-priority sources ahead of it', async () => {
    const a = controllable('a');
    const b = fixed('b', WORD());
    const repo = createLyricsRepository({ providers: [a, b] });
    const pending = repo.lyrics(TRACK);
    await tick();
    a.answer(null); // miss
    const result = await pending;
    assert.equal(result.source, 'b');
  });

  test('prioritizeSyllableSync off: the first line-synced answer is taken as-is', async () => {
    const a = fixed('a', LINE());
    const b = controllable('b');
    const repo = createLyricsRepository({ providers: [a, b] });
    const rec = recorder();
    const result = await repo.lyrics(TRACK, { prioritizeSyllableSync: false, ...rec.callbacks });
    assert.equal(result.source, 'a');
    assert.deepEqual(rec.of('cancelled'), ['b']); // never waited on for its word timing
  });

  test('prioritizeSyllableSync on: line-synced is held while the rest are checked for word timing', async () => {
    const a = fixed('a', LINE());
    const b = fixed('b', null);
    const c = controllable('c');
    const repo = createLyricsRepository({ providers: [a, b, c] });
    const pending = repo.lyrics(TRACK, { prioritizeSyllableSync: true });
    await tick();
    c.answer(WORD());
    assert.equal((await pending).source, 'c');

    // No word timing anywhere: the *first* line-synced answer is the one kept.
    const repo2 = createLyricsRepository({ providers: [fixed('a', LINE('first')), fixed('b', LINE('second')), fixed('c', null)] });
    const kept = await repo2.lyrics(TRACK, { prioritizeSyllableSync: true });
    assert.equal(kept.source, 'a');
    assert.equal(kept.lines[0].text, 'first');
  });

  test('plain lyrics are returned when nothing better exists, and lose to a later synced answer', async () => {
    const plainThenLine = () => createLyricsRepository({ providers: [fixed('yt', PLAIN()), fixed('lrc', LINE())] });
    assert.equal((await plainThenLine().lyrics(TRACK)).source, 'lrc');

    const plainOnly = createLyricsRepository({ providers: [fixed('yt', PLAIN()), fixed('lrc', null)] });
    const result = await plainOnly.lyrics(TRACK);
    assert.equal(result.source, 'yt');
    assert.ok(result.lines.every((l) => l.timeMs === 0));
  });

  test('Kotlin quirk, reproduced: with prioritizeSyllableSync on, an earlier plain answer beats a later line-synced one', async () => {
    const repo = createLyricsRepository({ providers: [fixed('yt', PLAIN()), fixed('lrc', LINE())] });
    const result = await repo.lyrics(TRACK, { prioritizeSyllableSync: true, kotlinParity: true });
    assert.equal(result.source, 'yt'); // off, the same lookup returns 'lrc'
  });

  test('default (fixed): with prioritizeSyllableSync on, a later line-synced answer still beats an earlier plain one', async () => {
    const repo = createLyricsRepository({ providers: [fixed('yt', PLAIN()), fixed('lrc', LINE())] });
    assert.equal((await repo.lyrics(TRACK, { prioritizeSyllableSync: true })).source, 'lrc');
    // ...and plain is still the answer when nothing timed exists anywhere
    const plainOnly = createLyricsRepository({ providers: [fixed('yt', PLAIN()), fixed('none', null)] });
    assert.equal((await plainOnly.lyrics(TRACK, { prioritizeSyllableSync: true })).source, 'yt');
  });

  test('exceptions and empty answers count as misses', async () => {
    const rec = recorder();
    const repo = createLyricsRepository({
      providers: [fixed('boom', new Error('HTTP 500')), fixed('empty', []), fixed('ok', LINE())],
    });
    const result = await repo.lyrics(TRACK, { ...rec.callbacks });
    assert.equal(result.source, 'ok');
    assert.deepEqual(rec.of('miss'), ['boom', 'empty']);
  });

  test('every source missing resolves to null', async () => {
    const rec = recorder();
    const repo = createLyricsRepository({ providers: [fixed('a', null), fixed('b', new Error('x')), fixed('genius', null)] });
    assert.equal(await repo.lyrics(TRACK, { ...rec.callbacks }), null);
    assert.deepEqual(rec.of('miss').sort(), ['a', 'b', 'genius']);
  });

  test('an empty source set contacts nobody and resolves to null', async () => {
    const a = fixed('a', LINE());
    let identified = 0;
    const repo = createLyricsRepository({ providers: [a], identify: async () => { identified++; return null; } });
    assert.equal(await repo.lyrics(TRACK, { sources: new Set() }), null);
    assert.equal(a.calls.length, 0);
    assert.equal(identified, 0);
  });

  test('results get the background-vocal split; providers get the cleaned query', async () => {
    const a = fixed('a', [line(1_000, 'lead words (echo)')]);
    const repo = createLyricsRepository({ providers: [a] });
    const result = await repo.lyrics({ ...TRACK, album: 'Deadbeat' });
    assert.equal(result.lines[0].text, 'lead words');
    assert.equal(result.lines[0].background.text, '(echo)');
    const { query } = a.calls[0];
    assert.equal(query.title, 'Dracula');
    assert.equal(query.artist, 'Tame Impala');
    assert.equal(query.durationMs, 205_000);
    assert.equal(query.album, 'Deadbeat');
    assert.equal(query.videoId, 'vid1');
    assert.equal(query.isrc, null);
  });
});

describe('sequence', () => {
  test('order filtered by sources, missing sources appended in registry order, unknown ids ignored', () => {
    const ids = ['a', 'b', 'c', 'd'];
    const repo = createLyricsRepository({ providers: ids.map((id) => fixed(id, null)) });
    assert.deepEqual(repo.sequenceFor(new Set(['a', 'b', 'c', 'zzz']), ['c', 'zzz', 'a']), ['c', 'a', 'b']);
    assert.deepEqual(repo.sequenceFor(['d', 'a'], ['a', 'a', 'd']), ['a', 'd']); // duplicates ignored
    assert.deepEqual(repo.sequenceFor(), ids);
  });

  test('sources outside the enabled set are never contacted', async () => {
    const a = fixed('a', null);
    const b = fixed('b', LINE());
    const repo = createLyricsRepository({ providers: [a, b] });
    assert.equal((await repo.lyrics(TRACK, { sources: ['b'] })).source, 'b');
    assert.equal(a.calls.length, 0);
  });
});

describe('Genius is lazy', () => {
  test('never started once anything is in hand', async () => {
    const genius = fixed('genius', PLAIN());
    const rec = recorder();
    const repo = createLyricsRepository({ providers: [fixed('lrclib', LINE()), genius] });
    assert.equal((await repo.lyrics(TRACK, { ...rec.callbacks })).source, 'lrclib');
    assert.equal(genius.calls.length, 0);
    assert.ok(!rec.events.some(([, id]) => id === 'genius')); // no started/cancelled either
  });

  test('skipped when a fallback is held, even with prioritizeSyllableSync on', async () => {
    const genius = fixed('genius', PLAIN());
    const repo = createLyricsRepository({ providers: [fixed('lrclib', LINE()), fixed('other', null), genius] });
    assert.equal((await repo.lyrics(TRACK, { prioritizeSyllableSync: true })).source, 'lrclib');
    assert.equal(genius.calls.length, 0);
  });

  test('started only when the harvest reaches it with nothing in hand', async () => {
    const lrclib = controllable('lrclib');
    const genius = fixed('genius', PLAIN());
    const rec = recorder();
    const repo = createLyricsRepository({ providers: [lrclib, genius] });
    const pending = repo.lyrics(TRACK, { ...rec.callbacks });
    await tick();
    assert.equal(genius.calls.length, 0);
    assert.deepEqual(rec.of('started'), ['lrclib']);
    lrclib.answer(null);
    const result = await pending;
    assert.equal(result.source, 'genius');
    assert.deepEqual(rec.of('started'), ['lrclib', 'genius']);
  });

  test('first in the order, it is started as soon as the harvest begins', async () => {
    const genius = fixed('genius', PLAIN());
    const repo = createLyricsRepository({ providers: [fixed('lrclib', LINE())] .concat(genius) });
    const result = await repo.lyrics(TRACK, { order: ['genius', 'lrclib'] });
    assert.equal(genius.calls.length, 1);
    assert.equal(result.source, 'lrclib'); // plain is only a fallback
  });
});

describe('identify (BiniLyrics ISRC) and the ISRC cache', () => {
  function biniSetup({ identifyImpl, lyricsForImpl, others = [], ...config } = {}) {
    const identifyCalls = [];
    const lyricsForCalls = [];
    const bini = fixed('bini_lyrics', () => { throw new Error('the injected path should be used'); });
    const repo = createLyricsRepository({
      providers: [bini, ...others],
      identify: async (query, ctx) => {
        identifyCalls.push({ query, ctx });
        return identifyImpl ? identifyImpl(query, ctx) : { isrc: 'GBKPL2204171', lyricsUrl: 'https://x/doc.ttml' };
      },
      lyricsFor: async (hit, ctx) => {
        lyricsForCalls.push({ hit, ctx });
        return lyricsForImpl ? lyricsForImpl(hit, ctx) : { isrc: hit.isrc, lines: WORD() };
      },
      ...config,
    });
    return { repo, bini, identifyCalls, lyricsForCalls };
  }

  test('runs only when bini_lyrics is enabled', async () => {
    const lrclib = fixed('lrclib', LINE());
    const { repo, identifyCalls } = biniSetup({ others: [lrclib] });
    await repo.lyrics(TRACK, { sources: ['lrclib'] });
    assert.equal(identifyCalls.length, 0);
    assert.equal(lrclib.calls[0].query.isrc, null);
  });

  test("its ISRC reaches every provider, and BiniLyrics reuses the hit instead of searching twice", async () => {
    const lrclib = controllable('lrclib');
    const { repo, identifyCalls, lyricsForCalls } = biniSetup({ others: [lrclib] });
    const result = await repo.lyrics(TRACK);
    assert.equal(result.source, 'bini_lyrics');
    assert.equal(identifyCalls.length, 1);
    assert.equal(identifyCalls[0].query.title, 'Dracula'); // cleaned
    assert.equal(identifyCalls[0].query.isrc, undefined); // asked by name
    assert.equal(lyricsForCalls.length, 1);
    assert.equal(lyricsForCalls[0].hit.isrc, 'GBKPL2204171');
    assert.equal(lrclib.calls[0].query.isrc, 'GBKPL2204171');
  });

  test('capped: a slow search is abandoned (and aborted) and the race runs without it', async () => {
    const lrclib = fixed('lrclib', LINE());
    let identifySignal;
    const { repo } = biniSetup({
      others: [lrclib],
      identifyTimeoutMs: 20,
      identifyImpl: (query, ctx) => {
        identifySignal = ctx.signal;
        return new Promise((resolve, reject) => ctx.signal.addEventListener('abort', () => reject(ctx.signal.reason)));
      },
      lyricsForImpl: () => null,
    });
    const started = Date.now();
    const result = await repo.lyrics(TRACK, { sources: ['bini_lyrics', 'lrclib'], order: ['lrclib', 'bini_lyrics'] });
    assert.ok(Date.now() - started >= 15);
    assert.equal(identifySignal.aborted, true);
    assert.equal(result.source, 'lrclib');
    assert.equal(lrclib.calls[0].query.isrc, null);
  });

  test('errors in identify are misses of the identify step only', async () => {
    const lrclib = fixed('lrclib', LINE());
    const { repo } = biniSetup({ others: [lrclib], identifyImpl: () => { throw new Error('404'); }, lyricsForImpl: () => null });
    const result = await repo.lyrics(TRACK);
    assert.equal(result.source, 'lrclib');
  });

  test('remembered per video id: the second lookup does not identify again', async () => {
    const lrclib = fixed('lrclib', null);
    const { repo, identifyCalls } = biniSetup({ others: [lrclib] });
    await repo.lyrics(TRACK);
    await repo.lyrics(TRACK);
    assert.equal(identifyCalls.filter((c) => c.query.isrc === undefined).length, 1);
    assert.equal(repo.isrcCache.peek('vid1'), 'GBKPL2204171');
    assert.equal(lrclib.calls[1].query.isrc, 'GBKPL2204171');
  });

  test('a caller-provided ISRC skips identify; a blank one does not count', async () => {
    const lrclib = fixed('lrclib', null);
    const { repo, identifyCalls } = biniSetup({ others: [lrclib] });
    await repo.lyrics({ ...TRACK, isrc: 'USUM71703861' }, { sources: ['lrclib', 'bini_lyrics'] });
    assert.equal(identifyCalls.filter((c) => c.query.isrc === undefined).length, 0);
    assert.equal(lrclib.calls[0].query.isrc, 'USUM71703861');
    await repo.lyrics({ ...TRACK, videoId: 'other', isrc: '   ' });
    assert.equal(identifyCalls.filter((c) => c.query.isrc === undefined).length, 1);
  });

  test("BiniLyrics falls back to a full search by ISRC when the hit's document is missing", async () => {
    let documents = 0;
    const { repo, identifyCalls } = biniSetup({
      lyricsForImpl: (hit) => (++documents === 1 ? null : { isrc: hit.isrc, lines: WORD() }),
    });
    const result = await repo.lyrics(TRACK);
    assert.equal(result.source, 'bini_lyrics');
    assert.equal(identifyCalls.length, 2);
    assert.equal(identifyCalls[1].query.isrc, 'GBKPL2204171'); // BiniLyrics.lyrics(..., isrc = recording)
  });

  test("BiniLyrics' own match is remembered even when identify timed out", async () => {
    let first = true;
    const { repo } = biniSetup({
      identifyTimeoutMs: 20,
      identifyImpl: (query, ctx) => {
        if (first) {
          first = false;
          return new Promise((resolve, reject) => ctx.signal.addEventListener('abort', () => reject(ctx.signal.reason)));
        }
        return { isrc: 'FROMSEARCH01', lyricsUrl: 'u' };
      },
    });
    await repo.lyrics(TRACK);
    assert.equal(repo.isrcCache.peek('vid1'), 'FROMSEARCH01');
  });

  test('no video id, nothing remembered', async () => {
    const { repo } = biniSetup();
    await repo.lyrics({ ...TRACK, videoId: '' });
    assert.equal(repo.isrcCache.size, 0);
  });

  test('the cache is a 100-entry LRU by default; recency is refreshed by reads', async () => {
    const { repo } = biniSetup({ isrcCacheSize: 2, identifyImpl: (q) => ({ isrc: `ISRC-${q.videoId}`, lyricsUrl: 'u' }) });
    await repo.lyrics({ ...TRACK, videoId: 'v1' });
    await repo.lyrics({ ...TRACK, videoId: 'v2' });
    await repo.lyrics({ ...TRACK, videoId: 'v1' }); // read: v1 becomes most recent
    await repo.lyrics({ ...TRACK, videoId: 'v3' }); // evicts v2, the eldest
    assert.deepEqual(repo.isrcCache.keys(), ['v1', 'v3']);

    const lru = new LruMap(100);
    for (let i = 0; i < 150; i++) lru.set(`v${i}`, 'x');
    assert.equal(lru.size, 100);
    assert.equal(lru.has('v49'), false);
    assert.equal(lru.has('v50'), true);
  });
});

describe('cancellation', () => {
  test('a loser that ignores its abort signal is still reported as cancelled, and the lookup waits for it', async () => {
    const a = fixed('a', WORD());
    const stubborn = controllable('stubborn', { honourAbort: false });
    const rec = recorder();
    const repo = createLyricsRepository({ providers: [a, stubborn] });
    let resolvedEarly = false;
    const pending = repo.lyrics(TRACK, { ...rec.callbacks }).then((r) => { resolvedEarly = !stubborn.calls[0].settled; return r; });
    await tick();
    await tick();
    assert.equal(stubborn.calls[0].ctx.signal.aborted, true);
    stubborn.answer(LINE()); // arrives after it lost
    const result = await pending;
    assert.equal(result.source, 'a');
    assert.equal(resolvedEarly, false); // structured: waited for the loser to settle
    assert.deepEqual(rec.of('cancelled'), ['stubborn']);
    assert.deepEqual(rec.of('found'), ['a']);
  });

  test('caller cancellation rejects the lookup and cancels every started source', async () => {
    const a = controllable('a');
    const b = controllable('b');
    const genius = fixed('genius', PLAIN());
    const rec = recorder();
    const repo = createLyricsRepository({ providers: [a, b, genius] });
    const controller = new AbortController();
    const pending = repo.lyrics(TRACK, { ...rec.callbacks, signal: controller.signal });
    await tick();
    controller.abort();
    await assert.rejects(pending, { name: 'AbortError' });
    assert.deepEqual(rec.of('cancelled').sort(), ['a', 'b']);
    assert.equal(genius.calls.length, 0);
  });

  test('an already-aborted signal rejects before anyone is contacted', async () => {
    const a = fixed('a', LINE());
    const repo = createLyricsRepository({ providers: [a] });
    await assert.rejects(repo.lyrics(TRACK, { signal: AbortSignal.abort() }));
    assert.equal(a.calls.length, 0);
  });

  test('a faulty listener cannot break the lookup', async () => {
    const repo = createLyricsRepository({ providers: [fixed('a', LINE())] });
    const result = await repo.lyrics(TRACK, {
      onSourceStarted: () => { throw new Error('listener'); },
      onSourceResult: () => { throw new Error('listener'); },
    });
    assert.equal(result.source, 'a');
  });
});

// ---------------------------------------------------------------------------
// the player-side controller (MainViewModel)
// ---------------------------------------------------------------------------

describe('controller (MainViewModel.loadLyrics / selectLyricsProvider)', () => {
  const SETTINGS = (ids) => ({ syncedLyrics: true, lyricsSources: ids, lyricsSourceOrder: ids, prioritizeSyllableSync: false });

  test('duration gate before the claim; (videoId, sources) dedup; lyrics off', async () => {
    const a = fixed('a', LINE());
    const b = fixed('b', LINE('from b'));
    const repo = createLyricsRepository({ providers: [a, b] });
    const controller = createLyricsController({ repository: repo });
    assert.equal(controller.load({ ...TRACK, durationMs: 0 }, SETTINGS(['a'])), null); // turned away, not claimed
    await controller.load(TRACK, SETTINGS(['a']));
    assert.equal(controller.snapshot().source, 'a');
    assert.equal(controller.load(TRACK, SETTINGS(['a'])), null); // already claimed
    assert.equal(a.calls.length, 1);
    // Changing only the order or prioritizeSyllableSync does NOT re-run the lookup
    // for the track already playing (the claim key is videoId + enabled set)...
    assert.equal(controller.load(TRACK, { ...SETTINGS(['a']), lyricsSourceOrder: ['b', 'a'], prioritizeSyllableSync: true }), null);
    // ...changing the enabled set does.
    await controller.load(TRACK, { ...SETTINGS(['a', 'b']), lyricsSourceOrder: ['b', 'a'] });
    assert.equal(controller.snapshot().source, 'b');

    const off = createLyricsController({ repository: repo });
    assert.equal(off.load(TRACK, { ...SETTINGS(['a']), syncedLyrics: false }), null);
    assert.equal(off.snapshot().checked, true);
    assert.equal(off.snapshot().lyrics, null);
    assert.equal(off.snapshot().unavailable, true);
  });

  test('a local file is read first and short-circuits the network', async () => {
    const a = fixed('a', LINE());
    const controller = createLyricsController({
      repository: createLyricsRepository({ providers: [a] }),
      localLyrics: async () => LINE('from the file'),
    });
    await controller.load({ ...TRACK, localUri: 'file:///x.flac', durationMs: 0 }, SETTINGS(['a']));
    const state = controller.snapshot();
    assert.equal(state.lyrics[0].text, 'from the file');
    assert.equal(state.source, null); // no provider to credit
    assert.equal(a.calls.length, 0);
  });

  test('a local file without lyrics and without a duration releases the claim', async () => {
    const a = fixed('a', LINE());
    const controller = createLyricsController({
      repository: createLyricsRepository({ providers: [a] }),
      localLyrics: async () => null,
    });
    const track = { ...TRACK, localUri: 'file:///x.m4a', durationMs: 0 };
    await controller.load(track, SETTINGS(['a']));
    assert.equal(controller.snapshot().checked, false);
    assert.equal(a.calls.length, 0);
    await controller.load({ ...track, durationMs: 180_000 }, SETTINGS(['a'])); // same key, but released
    assert.equal(controller.snapshot().source, 'a');
  });

  test('provider states and manual selection', async () => {
    const win = fixed('win', WORD());
    const slow = controllable('slow');
    const miss = fixed('miss', null);
    const repo = createLyricsRepository({ providers: [miss, win, slow] });
    const controller = createLyricsController({ repository: repo });
    await controller.load(TRACK, SETTINGS(['miss', 'win', 'slow']));
    let state = controller.snapshot();
    assert.equal(state.source, 'win');
    assert.deepEqual(state.states, {
      miss: ProviderState.NOT_FOUND,
      win: ProviderState.FOUND,
      slow: ProviderState.NOT_FETCHED, // cancelled loser: back to "not fetched"
    });

    controller.select('miss'); // NOT_FOUND rows are inert
    assert.equal(controller.snapshot().selected, null);

    controller.select('slow'); // NOT_FETCHED: a dedicated single-source lookup
    await tick();
    assert.equal(controller.snapshot().states.slow, ProviderState.FETCHING);
    slow.answer(LINE('slow lines'));
    await controller.settled();
    state = controller.snapshot();
    assert.equal(state.source, 'slow');
    assert.equal(state.lyrics[0].text, 'slow lines');
    assert.equal(state.states.slow, ProviderState.FOUND);

    controller.select('win'); // FOUND: from memory, no request
    assert.equal(controller.snapshot().source, 'win');
    assert.equal(slow.calls.length, 2);
  });

  test('selecting a provider the race then cancels is honoured with a dedicated lookup', async () => {
    const a = controllable('a');
    const b = controllable('b');
    const controller = createLyricsController({ repository: createLyricsRepository({ providers: [a, b] }) });
    const automatic = controller.load(TRACK, SETTINGS(['a', 'b']));
    await tick();
    assert.equal(controller.snapshot().states.b, ProviderState.FETCHING);
    controller.select('b'); // FETCHING: apply when that attempt completes
    a.answer(WORD()); // a wins; b is cancelled as a loser...
    await automatic;
    await tick();
    assert.equal(controller.snapshot().source, 'a'); // the race's answer, for now
    assert.equal(b.calls.length, 2); // ...and asked again on its own
    b.answer(LINE('b lines'));
    await controller.settled();
    assert.equal(controller.snapshot().source, 'b');
  });

  test('a selection that completes during the race beats the race winner', async () => {
    const a = controllable('a');
    const b = fixed('b', LINE('b lines'));
    const controller = createLyricsController({ repository: createLyricsRepository({ providers: [a, b] }) });
    const automatic = controller.load(TRACK, SETTINGS(['a', 'b']));
    await tick();
    controller.select('b'); // already FOUND
    assert.equal(controller.snapshot().source, 'b');
    a.answer(WORD());
    await automatic;
    assert.equal(controller.snapshot().source, 'b');
  });

  test('callbacks from a stale generation are ignored', async () => {
    const a = controllable('a');
    const controller = createLyricsController({ repository: createLyricsRepository({ providers: [a] }) });
    const first = controller.load(TRACK, SETTINGS(['a']));
    await tick();
    const second = controller.load({ ...TRACK, videoId: 'vid2' }, SETTINGS(['a']));
    await first; // track 1's lookup was cancelled; its "cancelled" callback is stale
    await tick();
    const state = controller.snapshot();
    assert.equal(state.generation, 2);
    assert.equal(state.states.a, ProviderState.FETCHING); // track 2's attempt, untouched
    a.answer(LINE());
    await second;
    assert.equal(controller.snapshot().states.a, ProviderState.FOUND);
    assert.equal(controller.snapshot().source, 'a');
  });

  test('everything missing: checked, no lyrics, "unavailable"', async () => {
    const controller = createLyricsController({
      repository: createLyricsRepository({ providers: [fixed('a', null), fixed('genius', null)] }),
    });
    await controller.load(TRACK, SETTINGS(['a', 'genius']));
    const state = controller.snapshot();
    assert.equal(state.checked, true);
    assert.equal(state.lyrics, null);
    assert.equal(state.unavailable, true);
    assert.deepEqual(state.states, { a: ProviderState.NOT_FOUND, genius: ProviderState.NOT_FOUND });
  });
});
