// Mirrors BitChord's lyrics orchestration:
//   data/lyrics/LyricsRepository.kt  - the fallback chain (identify -> parallel start ->
//                                      ordered harvest -> cancel losers), ISRC LRU
//   ui/MainViewModel.kt:242-470      - per-track lookup, provider states
//                                      (NOT_FETCHED/FETCHING/FOUND/NOT_FOUND), manual
//                                      provider selection, generation counter, local-file first
//
// Independent JavaScript re-implementation of the mechanism documented in
// BITCHORD_ENGINE_RESEARCH.md (BitChord itself is GPL-3.0).
//
// This file never imports provider modules: providers, and BiniLyrics'
// identify()/lyricsFor(), are injected (see ./index.js for the wired default).
//
// ---------------------------------------------------------------------------
// The chain, in one screen (LyricsRepository.kt:82-170):
//
//   sequence = order ∩ sources, then any enabled source missing from order, in registry order
//   title, artist = forLyricsSearch(title), artistForLyricsSearch(artist)      (once, for everyone)
//   known = caller isrc (non-blank) ?? isrcLru[videoId]
//   hit   = known ? null : identify()   only if bini_lyrics ∈ sequence; capped at 2.5 s; null on error
//   recording = known ?? hit.isrc
//   start every source in sequence at once, except genius (lazy)
//   fallback = null
//   for source in sequence:                                   (harvest strictly in priority order)
//       if fallback != null and source is genius: skip        (never started)
//       found = await source (start it if lazy); error/cancel -> miss
//       if found has any word-synced line:                         return found
//       if !prioritizeSyllableSync and found has any timeMs > 0:   return found
//       if fallback == null: fallback = found                 (line-synced *or plain*)
//   return fallback                                           (null when everything missed)
//   finally: cancel every source still running (reported via onSourceCancelled)
//
// Behavioural differences from the Kotlin, all deliberate and documented where they occur:
//   - identify()'s 2.5 s cap is enforced (the request is aborted). In Kotlin it is soft:
//     withTimeoutOrNull cannot interrupt OkHttp's blocking execute(), so a slow search
//     still holds the lookup until the 6 s call timeout and its answer is discarded.
//   - Losers are aborted through AbortSignal; with fetch-based providers they settle at
//     once. The lookup still waits for them to settle (structured concurrency, like
//     coroutineScope), so every callback has fired when lyrics() resolves.
//   - A provider answering [] is treated as a miss (every Kotlin provider ends in
//     takeIf { isNotEmpty() }, so this is unobservable for Kotlin-equivalent providers).
//   - Duplicate ids in `order` are ignored (Kotlin's settings layer writes a permutation).
//   - Callback exceptions are swallowed so a faulty listener cannot break the lookup.
//   - A plain (unsynced) answer never outranks a later line-synced one. In Kotlin the
//     fallback slot takes the first non-winning answer, plain included, so with
//     prioritizeSyllableSync on, YouTube Music's plain lyrics (earlier in the default
//     order) beat LRCLIB's line-synced ones. Pass `kotlinParity: true` to reproduce it.

import { forLyricsSearch, artistForLyricsSearch, ktIsBlank } from './query.js';
import { withBackgroundVocals, isWordSyncedLine } from './postprocess.js';

/** The source that identifies the recording before the race (LyricsRepository.kt:236-251). */
export const IDENTIFYING_SOURCE = 'bini_lyrics';

/** Started only when the harvest reaches it with nothing in hand (LyricsRepository.kt:122-125). */
export const LAZY_SOURCES = Object.freeze(new Set(['genius']));

/** LyricsRepository.kt:226 */
export const IDENTIFY_TIMEOUT_MS = 2_500;

/** LyricsRepository.kt:254 */
export const REMEMBERED_ISRCS = 100;

/** Abort reason used for race losers. */
export class LyricsLookupCancelled extends Error {
  constructor(message = 'lyrics lookup cancelled') {
    super(message);
    this.name = 'AbortError';
  }
}

/**
 * Bounded, least-recently-used, in-memory map - LinkedHashMap(accessOrder = true)
 * with removeEldestEntry(size > capacity) (LyricsRepository.kt:264-268).
 * get() and set() of an existing key both refresh recency; eviction happens only
 * when a *new* key pushes the size past capacity.
 */
export class LruMap {
  constructor(capacity) {
    this.capacity = capacity;
    this.map = new Map();
  }

  get(key) {
    if (!this.map.has(key)) return undefined;
    const value = this.map.get(key);
    this.map.delete(key);
    this.map.set(key, value);
    return value;
  }

  /** Read without touching recency (for inspection and tests). */
  peek(key) {
    return this.map.get(key);
  }

  has(key) {
    return this.map.has(key);
  }

  set(key, value) {
    if (this.map.has(key)) {
      this.map.delete(key);
      this.map.set(key, value);
      return;
    }
    this.map.set(key, value);
    while (this.map.size > this.capacity) this.map.delete(this.map.keys().next().value);
  }

  get size() {
    return this.map.size;
  }

  /** Eldest first. */
  keys() {
    return [...this.map.keys()];
  }

  clear() {
    this.map.clear();
  }
}

/**
 * @typedef {Object} LyricsResult
 * @property {string} source   Provider id the lines came from.
 * @property {import('./model.js').LyricLine[]} lines  After withBackgroundVocals().
 */

/**
 * @typedef {Object} LyricsRequest
 * @property {string} videoId
 * @property {string} title       Raw (YouTube) title; cleaned here.
 * @property {string} artist      Raw artist/channel; cleaned here.
 * @property {number} durationMs  0 = unknown (the service and download paths pass 0).
 * @property {string|null} [album]
 * @property {string|null} [isrc] Known recording (e.g. from a file's tags); skips identify.
 */

/**
 * @typedef {Object} LyricsOptions
 * @property {Iterable<string>} [sources]  Enabled provider ids; anything else is never contacted.
 * @property {string[]} [order]            Priority, first to last.
 * @property {boolean} [prioritizeSyllableSync]
 * @property {(id: string) => void} [onSourceStarted]
 * @property {(id: string, result: LyricsResult|null) => void} [onSourceResult]  null = genuine miss
 * @property {(id: string) => void} [onSourceCancelled]  a race loser stopped before it finished
 * @property {AbortSignal} [signal]
 * @property {typeof fetch} [fetch]
 * @property {Record<string,string>} [keys]  API keys for keyed providers (PaxSenix Spotify/Musixmatch).
 * @property {boolean} [kotlinParity]  Reproduce BitChord's plain-before-line-synced fallback quirk.
 */

/**
 * @param {Object} config
 * @param {import('./model.js').LyricsProvider[]} config.providers  Registry order = the default
 *        order sources fall back to when missing from `order` (LyricsSource.entries).
 * @param {(query: object, ctx: object) => Promise<object|null>} [config.identify]
 *        BiniLyrics.identify: a search hit `{ isrc, lyricsUrl, ... }` or null.
 * @param {(hit: object, ctx: object) => Promise<object|null>} [config.lyricsFor]
 *        BiniLyrics.lyricsFor: `{ isrc, lines }` or a bare lines array, or null.
 * @param {number} [config.isrcCacheSize]
 * @param {number} [config.identifyTimeoutMs]
 */
export function createLyricsRepository({
  providers,
  identify = null,
  lyricsFor = null,
  isrcCacheSize = REMEMBERED_ISRCS,
  identifyTimeoutMs = IDENTIFY_TIMEOUT_MS,
} = {}) {
  if (!Array.isArray(providers)) throw new TypeError('createLyricsRepository: providers must be an array');
  /** @type {Map<string, import('./model.js').LyricsProvider>} */
  const registry = new Map();
  for (const provider of providers) {
    if (provider && typeof provider.id === 'string' && !registry.has(provider.id)) registry.set(provider.id, provider);
  }
  const entries = Object.freeze([...registry.keys()]);
  const canIdentify = typeof identify === 'function';
  const canFetchHit = canIdentify && typeof lyricsFor === 'function';

  /** videoId -> ISRC (LyricsRepository.kt:256-273). Per repository instance, memory only. */
  const isrcs = new LruMap(isrcCacheSize);

  function remember(videoId, isrc) {
    const value = nonBlank(isrc);
    if (value == null || !videoId) return;
    isrcs.set(videoId, value);
  }

  /** LyricsRepository.kt:102-103 */
  function sequenceFor(sources, order) {
    const enabled = new Set(sources);
    const sequence = [];
    const seen = new Set();
    for (const id of order) {
      if (enabled.has(id) && registry.has(id) && !seen.has(id)) {
        seen.add(id);
        sequence.push(id);
      }
    }
    for (const id of entries) {
      if (enabled.has(id) && !seen.has(id)) {
        seen.add(id);
        sequence.push(id);
      }
    }
    return sequence;
  }

  /**
   * The one request made before the race (LyricsRepository.kt:236-251): skipped
   * when BiniLyrics is not enabled, given up on after identifyTimeoutMs, errors
   * are misses, and a hit's ISRC is remembered against the video id.
   */
  async function identifyRecording(videoId, query, sequence, ctx) {
    if (!sequence.includes(IDENTIFYING_SOURCE) || !canIdentify) return null;
    // withTimeoutOrNull(t <= 0) returns null without running its block.
    if (!(identifyTimeoutMs > 0)) return null;
    const { controller, unlink } = linkedController(ctx.signal);
    let timer;
    const timedOut = Symbol('timeout');
    const deadline = new Promise((resolve) => { timer = setTimeout(resolve, identifyTimeoutMs, timedOut); });
    const attempt = (async () => {
      try {
        return await identify(query, { fetch: ctx.fetch, keys: ctx.keys, signal: controller.signal });
      } catch {
        return null; // runCatching { ... }.getOrNull()
      }
    })();
    try {
      const outcome = await raceAbort(Promise.race([attempt, deadline]), ctx.signal);
      if (outcome === timedOut) {
        controller.abort(new LyricsLookupCancelled(`identify timed out after ${identifyTimeoutMs} ms`));
        return null;
      }
      if (!outcome) return null;
      remember(videoId, outcome.isrc);
      return outcome;
    } finally {
      clearTimeout(timer);
      unlink();
    }
  }

  /**
   * LyricsRepository.kt:187-191: the hit identify() already found, else a full
   * BiniLyrics search (identify by ISRC/name, then fetch the document, which is
   * all BiniLyrics.lyrics is - BiniLyrics.kt:90-96). The matched ISRC is remembered.
   */
  async function fetchBini(query, ctx, hit, videoId) {
    let match = null;
    if (hit) match = asMatch(await lyricsFor(hit, ctx), hit);
    if (match == null) {
      throwIfAborted(ctx.signal);
      const again = await identify(query, ctx);
      throwIfAborted(ctx.signal);
      if (again) match = asMatch(await lyricsFor(again, ctx), again);
    }
    if (match == null) return null;
    remember(videoId, match.isrc);
    return match.lines;
  }

  /**
   * Look up lyrics for one track.
   * @param {LyricsRequest} request
   * @param {LyricsOptions} [options]
   * @returns {Promise<LyricsResult|null>}
   */
  async function lyrics(request = {}, options = {}) {
    const videoId = String(request.videoId ?? '');
    const durationMs = Number(request.durationMs) || 0;
    const album = request.album ?? null;
    const {
      sources = entries,
      order = entries,
      prioritizeSyllableSync = false,
      onSourceStarted,
      onSourceResult,
      onSourceCancelled,
      signal,
      fetch: fetchImpl,
      keys,
      kotlinParity = false,
    } = options;
    throwIfAborted(signal);

    const sequence = sequenceFor(sources, order);

    // Cleaned once, here, rather than by whichever provider thought to (LyricsRepository.kt:105-109).
    const searchTitle = forLyricsSearch(request.title ?? '');
    const searchArtist = artistForLyricsSearch(request.artist ?? '');
    const baseQuery = { title: searchTitle, artist: searchArtist, durationMs, album, videoId };
    const ctxBase = { fetch: fetchImpl, keys, signal };

    // What the caller knows beats what we worked out last time, and both beat asking again (:111-120).
    const known = nonBlank(request.isrc) ?? isrcs.get(videoId) ?? null;
    const hit = known == null ? await identifyRecording(videoId, baseQuery, sequence, ctxBase) : null;
    throwIfAborted(signal);
    const recording = known ?? nonBlank(hit?.isrc) ?? null;
    const query = Object.freeze({ ...baseQuery, isrc: recording });

    const jobs = sequence.map((id) => makeJob(id));

    function makeJob(id) {
      const provider = registry.get(id);
      const job = {
        id,
        lazy: LAZY_SOURCES.has(id),
        started: false,
        settled: false,
        controller: null,
        unlink: () => {},
        promise: null,
        start() {
          if (!job.started) {
            job.started = true;
            const linked = linkedController(signal);
            job.controller = linked.controller;
            job.unlink = linked.unlink;
            job.promise = run();
          }
          return job.promise;
        },
      };

      // The async { } body (LyricsRepository.kt:126-148). Always resolves: a result,
      // or null for a miss *and* for a cancellation (the harvest's runCatching treats
      // both the same); the difference is reported through the callbacks.
      async function run() {
        const jobSignal = job.controller.signal;
        const ctx = { fetch: fetchImpl, keys, signal: jobSignal };
        notify(onSourceStarted, id); // called from the job itself, lazily-started ones included
        try {
          const raw = id === IDENTIFYING_SOURCE && canFetchHit
            ? await fetchBini(query, ctx, hit, videoId)
            : await provider.lyrics(query, ctx);
          // Kotlin's withContext boundary throws once the job is cancelled, even if
          // the (uninterruptible) request completed: a loser is never a "result".
          throwIfAborted(jobSignal);
          const answer = normalizeAnswer(raw);
          if (answer && id === IDENTIFYING_SOURCE) remember(videoId, answer.isrc);
          const found = answer ? { source: id, lines: withBackgroundVocals(answer.lines) } : null;
          notify(onSourceResult, id, found);
          return found;
        } catch (error) {
          if (jobSignal.aborted) {
            notify(onSourceCancelled, id);
            return null;
          }
          notify(onSourceResult, id, null); // exceptions count as misses
          return null;
        } finally {
          job.settled = true;
          job.unlink();
        }
      }
      return job;
    }

    // Every enabled source is asked at the same time... (LyricsRepository.kt:124-126)
    for (const job of jobs) if (!job.lazy) job.start();

    try {
      // ...but their answers are taken in order (LyricsRepository.kt:151-164).
      let fallback = null; // first line-synced answer (Kotlin: first non-winning answer, plain included)
      let plainFallback = null; // default mode only: plain answers wait here, below any line-synced one
      for (const job of jobs) {
        // Something is already in hand: skip Genius completely (never started).
        if ((fallback !== null || plainFallback !== null) && job.lazy) continue;
        const found = await raceAbort(job.start(), signal);
        if (!found) continue;
        if (found.lines.some(isWordSyncedLine)) return found; // word-synced wins outright
        const timed = found.lines.some((l) => l.timeMs > 0);
        if (!prioritizeSyllableSync && timed) return found;
        // Kotlin keeps the first non-winning answer whatever it is, so with
        // prioritizeSyllableSync on a plain answer taken first is never replaced by
        // a later line-synced one (research paper, lyrics defect V4). By default a
        // plain answer only fills its own, lower slot; kotlinParity restores the quirk.
        if (!timed && !kotlinParity) {
          if (plainFallback === null) plainFallback = found;
          continue;
        }
        if (fallback === null) fallback = found;
      }
      return fallback ?? plainFallback;
    } finally {
      // Whoever lost the race is no longer worth waiting on (LyricsRepository.kt:165-169).
      for (const job of jobs) {
        if (job.started && !job.settled) job.controller.abort(new LyricsLookupCancelled(`${job.id} lost the race`));
      }
      // coroutineScope does not return while children run: neither does this.
      await Promise.all(jobs.filter((job) => job.started).map((job) => job.promise));
    }
  }

  return Object.freeze({
    lyrics,
    /** Provider ids in registry (default) order. */
    sourceIds: entries,
    /** The ISRC LRU (videoId -> ISRC); exposed for inspection. */
    isrcCache: isrcs,
    /** The sequence a lookup with these settings would run (LyricsRepository.kt:102-103). */
    sequenceFor: (sources = entries, order = entries) => sequenceFor(sources, order),
  });
}

// ---------------------------------------------------------------------------
// MainViewModel.kt:242-470 - the per-track lookup the player UI drives
// ---------------------------------------------------------------------------

/** MainViewModel.kt:83-88 */
export const ProviderState = Object.freeze({
  NOT_FETCHED: 'NOT_FETCHED',
  FETCHING: 'FETCHING',
  FOUND: 'FOUND',
  NOT_FOUND: 'NOT_FOUND',
});

/**
 * The player-side state machine around the repository.
 *
 * - load(track, settings): no-op when (videoId, enabled sources) is already
 *   claimed; a network track with no duration is turned away *before* claiming
 *   (the duration arrives a beat later and re-triggers); every claim bumps the
 *   generation, resets provider states/results/selection and cancels the previous
 *   automatic and manual lookups. Sources empty (lyrics off) -> checked, nothing
 *   fetched. A local file's embedded lyrics are tried first, without the duration
 *   gate; if absent and the duration is still unknown the claim is released.
 * - Provider callbacks from a stale generation are ignored.
 * - select(id): FOUND -> shown from memory; FETCHING -> shown when that attempt
 *   finishes; NOT_FETCHED -> a dedicated single-source lookup; NOT_FOUND -> inert.
 *   If the automatic race cancels the selected provider as a loser, the selection
 *   is honoured with a dedicated lookup.
 * - When the automatic lookup ends, the selected provider's result (if it has one)
 *   beats the race winner.
 *
 * @param {Object} config
 * @param {ReturnType<typeof createLyricsRepository>} config.repository
 * @param {(localUri: string, ctx: {signal: AbortSignal}) => Promise<object[]|null>} [config.localLyrics]
 *        EmbeddedLyrics.forUri equivalent (returns lines, or null).
 * @param {(snapshot: object) => void} [config.onChange]
 * @param {{fetch?: typeof fetch, keys?: Record<string,string>}} [config.lookupOptions]
 */
export function createLyricsController({ repository, localLyrics = null, onChange = null, lookupOptions = {} }) {
  const ids = repository.sourceIds;
  let claimed = null; // lyricsFor
  let generation = 0;
  let currentRequest = null;
  let selected = null;
  let automatic = null;
  const manual = new Map();
  const results = new Map();
  let states = freshStates();
  let lyrics = null;
  let source = null;
  let checked = false;

  function freshStates() {
    return new Map(ids.map((id) => [id, ProviderState.NOT_FETCHED]));
  }

  function snapshot() {
    return {
      lyrics,
      source,
      checked,
      // MainActivity.kt:2198
      unavailable: checked && !(lyrics && lyrics.length > 0),
      selected,
      generation,
      states: Object.fromEntries(states),
    };
  }

  const emit = () => {
    if (onChange) {
      try { onChange(snapshot()); } catch { /* listener errors are not the lookup's */ }
    }
  };

  function show(result) {
    lyrics = result.lines;
    source = result.source;
    checked = true;
  }

  function started(gen, id) {
    if (gen !== generation) return;
    states.set(id, ProviderState.FETCHING);
    emit();
  }

  function finished(gen, id, result) {
    if (gen !== generation) return;
    if (!result) {
      states.set(id, ProviderState.NOT_FOUND);
      emit();
      return;
    }
    results.set(id, result);
    states.set(id, ProviderState.FOUND);
    if (selected === id) show(result);
    emit();
  }

  function cancelled(gen, id) {
    if (gen !== generation) return;
    if (states.get(id) === ProviderState.FETCHING) states.set(id, ProviderState.NOT_FETCHED);
    // A tap may have selected a provider the race was still using; honour it.
    if (selected === id && currentRequest) fetchProvider(currentRequest, gen, id);
    emit();
  }

  function callbacks(gen) {
    return {
      onSourceStarted: (id) => started(gen, id),
      onSourceResult: (id, result) => finished(gen, id, result),
      onSourceCancelled: (id) => cancelled(gen, id),
    };
  }

  /** MainViewModel.kt:404-427 */
  function fetchProvider(request, gen, id) {
    if (manual.get(id)?.active) return;
    const entry = { controller: new AbortController(), active: true, done: null };
    manual.set(id, entry);
    entry.done = repository.lyrics(request, {
      ...lookupOptions,
      sources: new Set([id]),
      order: [id],
      prioritizeSyllableSync: false,
      ...callbacks(gen),
      signal: entry.controller.signal,
    }).catch(() => null).finally(() => { entry.active = false; });
  }

  /**
   * MainViewModel.kt:301-379. Returns a promise for the automatic lookup, or null
   * when nothing was started.
   */
  function load(track, settings = {}) {
    const { videoId = '', title = '', artist = '', durationMs = 0, album = null, localUri = null } = track;
    const {
      syncedLyrics = true,
      lyricsSources = ids,
      lyricsSourceOrder = ids,
      prioritizeSyllableSync = false,
    } = settings;
    const sources = syncedLyrics ? new Set(lyricsSources) : new Set();
    const key = `${videoId}\u0000${[...sources].sort().join(',')}`;
    if (claimed === key) return null;
    if (localUri == null && !(durationMs > 0)) return null;
    claimed = key;
    generation += 1;
    const gen = generation;
    currentRequest = { videoId, title, artist, durationMs, album };
    selected = null;
    for (const entry of manual.values()) entry.controller.abort(new LyricsLookupCancelled('track changed'));
    manual.clear();
    results.clear();
    states = freshStates();
    lyrics = null;
    source = null;
    automatic?.abort(new LyricsLookupCancelled('track changed'));
    automatic = null;
    if (sources.size === 0) {
      checked = true;
      emit();
      return null;
    }
    checked = false;
    const job = new AbortController();
    automatic = job;
    emit();

    return (async () => {
      if (localUri != null && localLyrics) {
        let embedded = null;
        try { embedded = await localLyrics(localUri, { signal: job.signal }); } catch { embedded = null; }
        if (job.signal.aborted) return;
        if (embedded && embedded.length > 0) {
          lyrics = embedded;
          source = null; // what the file records is the lyrics, not where they came from
          checked = true;
          emit();
          return;
        }
      }
      if (!(durationMs > 0)) {
        claimed = null; // wait for the duration to arrive and re-trigger
        return;
      }
      let found;
      try {
        found = await repository.lyrics(currentRequest, {
          ...lookupOptions,
          sources,
          order: lyricsSourceOrder,
          prioritizeSyllableSync,
          ...callbacks(gen),
          signal: job.signal,
        });
      } catch (error) {
        if (job.signal.aborted) return;
        throw error;
      }
      if (job.signal.aborted) return;
      const chosen = (selected != null ? results.get(selected) : undefined) ?? found;
      lyrics = chosen?.lines ?? null;
      source = chosen?.source ?? null;
      checked = true;
      emit();
    })();
  }

  /** MainViewModel.kt:385-402 */
  function select(id) {
    const request = currentRequest;
    if (!request) return;
    switch (states.get(id)) {
      case ProviderState.FOUND: {
        selected = id;
        const result = results.get(id);
        if (result) show(result);
        break;
      }
      case ProviderState.FETCHING:
        selected = id; // applied when the running attempt completes
        break;
      case ProviderState.NOT_FOUND:
        return; // misses cannot be requested twice
      default:
        selected = id;
        fetchProvider(request, generation, id);
    }
    emit();
  }

  /** Waits for any dedicated (manual) lookups in flight - handy for tests and teardown. */
  async function settled() {
    await Promise.all([...manual.values()].map((entry) => entry.done));
  }

  function dispose() {
    automatic?.abort(new LyricsLookupCancelled('disposed'));
    for (const entry of manual.values()) entry.controller.abort(new LyricsLookupCancelled('disposed'));
  }

  return Object.freeze({ load, select, snapshot, settled, dispose });
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function nonBlank(value) {
  if (value == null) return null;
  const s = String(value);
  return ktIsBlank(s) ? null : s;
}

/** A provider answer: a lines array, or { lines, isrc }. [] and malformed -> miss. */
function normalizeAnswer(raw) {
  if (raw == null) return null;
  if (Array.isArray(raw)) return raw.length > 0 ? { lines: raw, isrc: null } : null;
  if (Array.isArray(raw.lines)) return raw.lines.length > 0 ? { lines: raw.lines, isrc: nonBlank(raw.isrc) } : null;
  return null;
}

/** BiniLyrics.lyricsFor's Match: the lines, and the hit's ISRC. */
function asMatch(result, hit) {
  const answer = normalizeAnswer(result);
  if (answer == null) return null;
  return { lines: answer.lines, isrc: answer.isrc ?? nonBlank(hit?.isrc) };
}

function notify(callback, ...args) {
  if (typeof callback !== 'function') return;
  try {
    callback(...args);
  } catch {
    // A faulty listener must not turn into a provider miss or break the lookup.
  }
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw signal.reason ?? new LyricsLookupCancelled();
}

/** A child AbortController that follows `parent` (AbortSignal.any is Node >= 20.3). */
function linkedController(parent) {
  const controller = new AbortController();
  if (!parent) return { controller, unlink: () => {} };
  if (parent.aborted) {
    controller.abort(parent.reason);
    return { controller, unlink: () => {} };
  }
  const onAbort = () => controller.abort(parent.reason);
  parent.addEventListener('abort', onAbort, { once: true });
  return { controller, unlink: () => parent.removeEventListener('abort', onAbort) };
}

/** Resolve with `promise`, or reject as soon as `signal` aborts. */
function raceAbort(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(signal.reason ?? new LyricsLookupCancelled());
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? new LyricsLookupCancelled());
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => { signal.removeEventListener('abort', onAbort); resolve(value); },
      (error) => { signal.removeEventListener('abort', onAbort); reject(error); },
    );
  });
}
