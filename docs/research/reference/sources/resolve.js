// Resolution and orchestration: which source serves a track, and how the
// lossless lookup races the YouTube fallback.
//
// Mirrors BitChord's
//   data/sources/SourceResolver.kt   bestAcross, matchAndStream, preferred, streamBest,
//                                    isBetter, worthSwapping, sameRecordingAs,
//                                    substituteForYouTube, upgradeFor, requestForNow
//   data/sources/MusicSource.kt      StreamFormat, StreamRequest, MusicSource
//   data/sources/SourceKind.kt       ranks and capabilities
//   data/settings/AppSettings.kt     AudioQuality.permits
//   playback/PlaybackService.kt      resolveWithModulePriority (the race, PS:4468-4602)
//                                    and the StreamChoice branch of the resolver (PS:1355-1405)
//   playback/StreamChoice.kt         the 15-minute pin and the 10-minute refusal
//   playback/QualityUpgrade.kt       effectiveTargetDuration and lookAgain's guard
//   data/sources/ModuleSource.kt     the companion helpers both addon and module sources
//                                    use (qualityTier, malformed, unplayable)
//
// Independent JavaScript re-implementation of the mechanism documented in BITCHORD_ENGINE_RESEARCH.md (BitChord itself is GPL-3.0).
//
// Nothing here touches the network itself; sources do. Every async function
// takes an AbortSignal, and cancelling one only stops *waiting*: sources built
// on cache.js#singleFlight keep their in-flight HTTP calls running so the
// answers still land in their caches (SharedCalls semantics).

import { abortReason, abortable } from './cache.js';
import {
  hasConflictingAlbums,
  isSevereMismatch,
  keepSameRecording,
  keepSharedArtist,
  keepStrictLength,
  queries,
  ranked,
  rowSeconds,
  uniquelyMostCreditedCloseMatch,
  UPGRADE_DRIFT_SEC,
} from './trackMatcher.js';

// ── Types ───────────────────────────────────────────────────────────────────

/**
 * What the caller is willing to pay for (MusicSource.kt:115-124).
 * @typedef {{ kind: 'lossless' } | { kind: 'best' } | { kind: 'capped', kbps: number }} StreamRequest
 */

/**
 * What a source says it is about to hand the decoder. Every field is optional;
 * null means "not stated", never "no". `codec` is lower-case.
 * @typedef {{ codec?: string|null, kbps?: number|null, sampleRate?: number|null, bitDepth?: number|null }} StreamFormat
 */

/**
 * @typedef {Object} SourceStream
 * @property {string} url
 * @property {StreamFormat} format
 * @property {Record<string, string>} [headers]
 * @property {'hls'|'dash'|null} [transport]   declared manifest type (StreamContainer.declare)
 * @property {number|null} [durationSec]       the row's runtime, set by streamBest
 * @property {string|null} [sourceId]          which source answered, set by streamBest
 * @property {boolean} [belowRequest]          less than was asked for; an upgrade should follow
 */

/**
 * One row of a source's search answer.
 * @typedef {Object} SourceRow
 * @property {string} id                 the source's own track id, handed back to stream()
 * @property {string} title
 * @property {string} artist
 * @property {string|null} [album]
 * @property {number|null} [durationSec]
 * @property {boolean|null} [explicit]
 * @property {'LOSSLESS'|'HIGH'|'LOW'|'DOLBY'|null} [quality]   tier the row advertises
 */

/**
 * The source interface (MusicSource.kt:161-206).
 * @typedef {Object} MusicSource
 * @property {string} id
 * @property {'addon'|'custom_module'|'module'|'jiosaavn'|'youtube'} kind
 * @property {number} rank
 * @property {boolean} canServeLossless
 * @property {string} [displayName]
 * @property {(query: string, options: { limit: number, signal?: AbortSignal, waitForAll?: boolean,
 *            request?: StreamRequest }) => Promise<SourceRow[]>} search
 * @property {(trackId: string, request: StreamRequest, options: { signal?: AbortSignal })
 *            => Promise<SourceStream|null>} stream   null = a miss, not an error
 */

// ── Constants ───────────────────────────────────────────────────────────────

/** Rows asked for per query (SourceResolver.kt:1101). */
export const MATCH_CANDIDATES = 15;
/** Matching rows actually opened per source (SourceResolver.kt:1111). */
export const STREAM_ATTEMPTS = 3;
/** kbps a lossy stream must gain to earn a seam in the audio (SourceResolver.kt:1157). */
export const UPGRADE_MIN_GAIN_KBPS = 96;
/** Cap on offering a YouTube track to a higher-ranked source (PlaybackService.kt:7546). */
export const SUBSTITUTE_TIMEOUT_MS = 20_000;
/** At or below this cap a source is asked for its LOW tier (ModuleSource.kt:557). */
export const LOW_CEILING_KBPS = 128;

/** Codecs treated as bit-exact (MusicSource.kt:50). */
export const LOSSLESS_CODECS = Object.freeze(new Set(['flac', 'alac', 'wav', 'aiff', 'ape', 'wv', 'dsf', 'dff']));
/** Codecs treated as Dolby Atmos, i.e. E-AC-3 JOC (MusicSource.kt:51). */
export const DOLBY_ATMOS_CODECS = Object.freeze(new Set(['eac3-joc', 'ec3-joc', 'dolby-atmos']));

/** SourceKind.kt: where each kind sits in the walk and what it can do. */
export const SOURCE_KINDS = Object.freeze({
  addon: Object.freeze({ rank: 0, canServeLossless: true, worthPrefetching: false }),
  custom_module: Object.freeze({ rank: 0, canServeLossless: true, worthPrefetching: false }),
  module: Object.freeze({ rank: 1, canServeLossless: true, worthPrefetching: false }),
  jiosaavn: Object.freeze({ rank: 2, canServeLossless: false, worthPrefetching: true }),
  youtube: Object.freeze({ rank: 3, canServeLossless: false, worthPrefetching: false }),
});

/** StreamRequest values. */
export const StreamRequest = Object.freeze({
  lossless: Object.freeze({ kind: 'lossless' }),
  best: Object.freeze({ kind: 'best' }),
  /** @param {number} kbps */
  capped: (kbps) => Object.freeze({ kind: 'capped', kbps }),
});

/** AudioQuality ceilings (AppSettings.kt:37-41). */
export const AUDIO_QUALITY_KBPS = Object.freeze({ LOW: 64, MEDIUM: Infinity, HIGH: Infinity, LOSSLESS: Infinity });

const noop = () => {};
const sourceName = (source) => source?.displayName ?? source?.id ?? 'source';

// ── Requests and tiers ──────────────────────────────────────────────────────

/** SourceResolver.requestForNow for a given effective AudioQuality. */
export function requestForQuality(quality) {
  if (quality === 'LOSSLESS') return StreamRequest.lossless;
  const cap = AUDIO_QUALITY_KBPS[quality];
  if (cap === undefined) throw new TypeError(`unknown audio quality: ${quality}`);
  return cap === Infinity ? StreamRequest.best : StreamRequest.capped(cap);
}

/**
 * AudioQuality.permits: which sources a stream started under this ceiling may
 * use at all. LOSSLESS: every source. HIGH: only sources that cannot serve
 * lossless (JioSaavn, YouTube). MEDIUM and LOW: YouTube alone.
 */
export function permits(quality, kind) {
  switch (quality) {
    case 'LOSSLESS':
      return true;
    case 'HIGH':
      return !SOURCE_KINDS[kind]?.canServeLossless;
    case 'MEDIUM':
    case 'LOW':
      return kind === 'youtube';
    default:
      throw new TypeError(`unknown audio quality: ${quality}`);
  }
}

/** The tier name addons and modules are asked for (AddonSource/ModuleSource `.tier`). */
export function requestTier(request) {
  switch (request?.kind) {
    case 'lossless':
      return 'LOSSLESS';
    case 'best':
      return 'HIGH';
    case 'capped':
      return request.kbps <= LOW_CEILING_KBPS ? 'LOW' : 'HIGH';
    default:
      throw new TypeError(`unknown StreamRequest kind: ${request?.kind}`);
  }
}

// ── StreamFormat ────────────────────────────────────────────────────────────

/** true / false / null (unknown codec means unknown, not lossy). */
export function isLossless(format) {
  const codec = format?.codec;
  return codec == null ? null : LOSSLESS_CODECS.has(codec);
}

export function isDolbyAtmos(format) {
  return format?.codec != null && DOLBY_ATMOS_CODECS.has(format.codec);
}

/** Neither a codec nor a bitrate stated: nothing rules lossless out. */
export function statesNothingLossy(format) {
  return isLossless(format) == null && format?.kbps == null;
}

/** StreamFormat.summary: "Dolby Atmos", "FLAC · 24-bit · 96 kHz", "MP3 · 320 kbps". */
export function formatSummary(format) {
  if (isDolbyAtmos(format)) return 'Dolby Atmos';
  const parts = [];
  if (format?.codec != null) parts.push(format.codec.toUpperCase());
  if (format?.bitDepth != null) parts.push(`${format.bitDepth}-bit`);
  if (format?.sampleRate != null) parts.push(`${(format.sampleRate / 1000).toFixed(1).replace(/\.0$/, '')} kHz`);
  if (format?.kbps != null && isLossless(format) !== true) parts.push(`${format.kbps} kbps`);
  return parts.length > 0 ? parts.join(' · ') : 'Unknown format';
}

/**
 * Whether `candidate` is a better rendition than `current`: Atmos first, then
 * lossless, then bitrate (SourceResolver.kt:1042-1057). A null current is
 * beaten by anything; an equal one is not displaced. Note the tri-state:
 * an unknown codec never beats a known lossy one on the lossless line.
 */
export function isBetter(candidate, current) {
  if (current == null) return true;
  const candidateAtmos = isDolbyAtmos(candidate);
  if (candidateAtmos !== isDolbyAtmos(current)) return candidateAtmos;
  const candidateLossless = isLossless(candidate);
  if (candidateLossless !== isLossless(current)) return candidateLossless === true;
  return (candidate?.kbps ?? 0) > (current?.kbps ?? 0);
}

/**
 * Whether swapping to `candidate` mid-song is worth the seam
 * (SourceResolver.kt:657-668). Never away from Atmos; always to lossless or
 * Atmos; a lossy candidate needs a stated gain of at least 96 kbps over a
 * stated `playing` bitrate.
 */
export function worthSwapping(candidate, playing) {
  if (playing != null && isDolbyAtmos(playing) && !isDolbyAtmos(candidate)) return false;
  if (isLossless(candidate) === true || isDolbyAtmos(candidate)) return true;
  if (candidate?.kbps == null || playing?.kbps == null) return false;
  return candidate.kbps - playing.kbps >= UPGRADE_MIN_GAIN_KBPS;
}

/** Whether two runtimes are one recording for a mid-song swap: within 2 s, both known. */
export function sameRecordingAs(candidateSec, playingSec) {
  if (candidateSec == null || playingSec == null) return false;
  return Math.abs(candidateSec - playingSec) <= UPGRADE_DRIFT_SEC;
}

// ── Helpers shared by addon and module sources (ModuleSource.kt companion) ──

const LOSSLESS_HINTS = ['LOSSLESS', 'FLAC', 'ALAC', 'HI-RES', 'HI_RES', 'HIRES', '24-BIT', '16-BIT', 'WAV'];
const LOW_HINTS = ['LOW', '128', '96KBPS', '64'];
const HIGH_HINTS = ['HIGH', '320', 'MP3', 'AAC', 'M4A', 'OPUS', 'OGG'];

/**
 * Which tier a free-text quality label describes: 'LOSSLESS' | 'LOW' | 'HIGH'
 * | null, checked in that order (ModuleSource.kt:540-554).
 */
export function qualityTier(label) {
  const text = String(label ?? '').toUpperCase();
  if (text.trim() === '') return null;
  if (LOSSLESS_HINTS.some((hint) => text.includes(hint))) return 'LOSSLESS';
  if (LOW_HINTS.some((hint) => text.includes(hint))) return 'LOW';
  if (HIGH_HINTS.some((hint) => text.includes(hint))) return 'HIGH';
  return null;
}

/**
 * Whether a stream URL is one no server could answer (ModuleSource.kt:460-472):
 * anything that is not a parseable http(s) URL, or a URL carrying a second copy
 * of its own origin (the August 2026 Tidal fault). WHATWG URL stands in for
 * OkHttp's HttpUrl parser here.
 */
export function malformed(url) {
  if (typeof url !== 'string' || url === '') return true;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return true;
  }
  if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || parsed.hostname === '') return true;
  const schemeEnd = url.indexOf('://');
  if (schemeEnd < 0) return false;
  const originEnd = url.indexOf('/', schemeEnd + 3);
  if (originEnd < 0) return false;
  return url.indexOf(url.slice(0, originEnd), originEnd) >= 0;
}

/** An Atmos rendition on a device or setting that cannot take it (ModuleSource.unplayable). */
export function unplayable(format, atmosAllowed) {
  return isDolbyAtmos(format) && !atmosAllowed;
}

/** StreamContainer.isManifest: a declared transport, else a .m3u8/.mpd extension. */
export function isManifestStream(stream) {
  if (stream?.transport === 'hls' || stream?.transport === 'dash') return true;
  const extension = String(stream?.url ?? '').split('?')[0].split('.').pop().toLowerCase();
  return extension === 'm3u8' || extension === 'mpd';
}

// ── Ordering ────────────────────────────────────────────────────────────────

/** SourceRegistry.active(): stable sort by rank, so user order survives among rank-0 sources. */
export function sortByRank(sources) {
  return sources
    .map((source, index) => ({ source, index, rank: source.rank ?? SOURCE_KINDS[source.kind]?.rank ?? 99 }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map(({ source }) => source);
}

/** The sources ranked above `id`; an id not in the list ranks last. */
export function rankedAbove(sources, id) {
  const at = sources.findIndex((source) => source.id === id);
  return sources.slice(0, at < 0 ? sources.length : at);
}

/**
 * The matching rows in the order worth opening (SourceResolver.kt:947-971):
 *   1. length first: if any row is within ±3 s of the target, only those are eligible;
 *   2. Atmos rows first when Atmos is wanted and one exists;
 *   3. for a lossless request, LOSSLESS-labelled rows first (stable).
 */
export function preferred(matchesList, target, wantsLossless, { atmosWanted = false } = {}) {
  const eligible = keepSameRecording(matchesList, target);
  const partition = (rows, test) => [...rows.filter(test), ...rows.filter((row) => !test(row))];
  if (atmosWanted) {
    const immersiveFirst = partition(eligible, (row) => row.quality === 'DOLBY');
    if (immersiveFirst[0]?.quality === 'DOLBY') return immersiveFirst;
  }
  if (!wantsLossless) return eligible;
  return partition(eligible, (row) => row.quality === 'LOSSLESS');
}

// ── Asking one source ───────────────────────────────────────────────────────

/**
 * Runs a call into a source. A throw costs the source its turn (logged,
 * `{ ok: false }`); an abort of *our* signal is the caller giving up and is
 * re-thrown (SourceResolver.attempt).
 */
async function attempt(source, signal, log, block) {
  try {
    return { ok: true, value: await block() };
  } catch (error) {
    if (signal?.aborted) throw error;
    log(`${sourceName(source)} failed: ${error?.name ?? 'Error'}: ${error?.message ?? error}`);
    return { ok: false, error };
  }
}

/**
 * Opens the best of `matchesList` that can serve `request` (SourceResolver.streamBest).
 * Up to STREAM_ATTEMPTS rows, in `preferred` order, one after another. For a
 * lossless request an answer must be lossless, Atmos, or state nothing lossy;
 * anything else is kept as a refusal and the best refusal comes back marked
 * `belowRequest`. For any other request the first answer is taken.
 */
export async function streamBest(source, matchesList, target, request, { signal, atmosWanted = false, log = noop } = {}) {
  const wantsLossless = request.kind === 'lossless';
  const ordered = preferred(matchesList, target, wantsLossless, { atmosWanted });
  let settleFor = null;
  for (const match of ordered.slice(0, STREAM_ATTEMPTS)) {
    const opened = await attempt(source, signal, log, () => source.stream(match.id, request, { signal }));
    if (!opened.ok || !opened.value) continue;
    // The row knows how long the recording is; the URL does not.
    const stream = {
      ...opened.value,
      format: opened.value.format ?? {},
      durationSec: rowSeconds(match),
      sourceId: source.id,
    };
    const served = stream.format;
    if (!wantsLossless || isLossless(served) === true || isDolbyAtmos(served) || statesNothingLossy(served)) {
      log(`${sourceName(source)} matched '${match.title}' by '${match.artist}' → ${formatSummary(served)}`);
      return stream;
    }
    log(`${sourceName(source)} offered ${formatSummary(served)} for '${match.title}'; looking further`);
    const refused = { ...stream, belowRequest: true };
    // The floor is the best of what was refused, not the first of it.
    if (settleFor == null || isBetter(refused.format, settleFor.format)) settleFor = refused;
  }
  return settleFor;
}

/**
 * Searches one source for `target` and streams it if an answer really is that
 * recording (SourceResolver.kt:839-900). Queries are tried one after another
 * (at most two); an empty answer moves on to the next query, a throwing source
 * gets no second chance. The first query that leaves any match decides: its
 * streamBest result is returned even when that is null.
 *
 * @param {MusicSource} source
 * @param {object} target            a trackMatcher Target
 * @param {StreamRequest} request
 * @param {{ waitForAll?: boolean, strictLength?: boolean, requireSharedArtist?: boolean,
 *           atmosWanted?: boolean, signal?: AbortSignal, log?: (line: string) => void }} [options]
 * @returns {Promise<SourceStream|null>}
 */
export async function matchAndStream(source, target, request, options = {}) {
  const { waitForAll = false, strictLength = false, requireSharedArtist = false, signal, log = noop } = options;
  for (const query of queries(target)) {
    const answer = await attempt(source, signal, log, () =>
      source.search(query, { limit: MATCH_CANDIDATES, signal, waitForAll, request }),
    );
    if (!answer.ok) return null;
    const candidates = Array.isArray(answer.value) ? answer.value : [];
    let found = ranked(target, candidates);
    if (requireSharedArtist) found = keepSharedArtist(found, target);
    // JioSaavn can hold different audio under one title and artist on
    // different releases; with no album to choose by, refuse to guess.
    if (source.kind === 'jiosaavn' && hasConflictingAlbums(found, target)) {
      const canonical = uniquelyMostCreditedCloseMatch(found, target);
      if (canonical == null) {
        log(`${sourceName(source)} returned conflicting albums for '${target.title}'; refusing to guess`);
        continue;
      }
      found = [canonical];
    }
    if (strictLength) found = keepStrictLength(found, target);
    if (found.length === 0) continue;
    return streamBest(source, found, target, request, options);
  }
  return null;
}

// ── Asking several sources at once ─────────────────────────────────────────

/** An AbortController that also aborts when `parent` does. */
function linkedController(parent) {
  const controller = new AbortController();
  if (!parent) return { controller, release: noop };
  if (parent.aborted) {
    controller.abort(abortReason(parent));
    return { controller, release: noop };
  }
  const onAbort = () => controller.abort(abortReason(parent));
  parent.addEventListener('abort', onAbort, { once: true });
  return { controller, release: () => parent.removeEventListener('abort', onAbort) };
}

/**
 * One trip through the event loop. Kotlin's select resumes through the
 * dispatcher queue, so sources that finished in the same instant are complete
 * by the time the winner is looked at; Node instead runs microtasks between
 * timer and I/O callbacks. Yielding one macrotask restores "everything that
 * crossed the line while we were waiting".
 */
const dispatchHop = () =>
  new Promise((resolve) => (typeof setImmediate === 'function' ? setImmediate(resolve) : setTimeout(resolve, 0)));

/** Resolves when `arm`'s callback is called; rejects if `signal` aborts first. */
function nextWake(signal, arm) {
  return new Promise((resolve, reject) => {
    let onAbort = null;
    if (signal) {
      if (signal.aborted) {
        reject(abortReason(signal));
        return;
      }
      onAbort = () => reject(abortReason(signal));
      signal.addEventListener('abort', onAbort, { once: true });
    }
    arm(() => {
      if (onAbort) signal.removeEventListener('abort', onAbort);
      resolve();
    });
  });
}

/**
 * The best stream the given sources can serve for `target`, all of them asked
 * at once (SourceResolver.kt:764-816).
 *
 * Every wake-up folds in *every* answer that has already arrived, ranked by
 * source order when several arrive together, keeping the best by isBetter. The
 * first acceptable answer ends the race unless `waitForAll` is set (the
 * background upgrade path); sources still running are then aborted.
 *
 * @param {MusicSource[]} sources  in walk order
 * @param {object} target
 * @param {StreamRequest} request
 * @param {{ waitForAll?: boolean, strictLength?: boolean, requireSharedArtist?: boolean,
 *           accept?: (source: MusicSource, stream: SourceStream) => boolean,
 *           atmosWanted?: boolean, signal?: AbortSignal, log?: (line: string) => void }} [options]
 * @returns {Promise<{ source: MusicSource, stream: SourceStream } | null>}
 */
export async function bestAcross(sources, target, request, options = {}) {
  const { waitForAll = false, accept = () => true, signal, ...perSource } = options;
  if (signal?.aborted) throw abortReason(signal);

  const settled = [];
  let wake = null;
  const tasks = sources.map((source, index) => {
    const { controller, release } = linkedController(signal);
    const task = { controller, running: true };
    matchAndStream(source, target, request, { ...perSource, waitForAll, signal: controller.signal }).then(
      (stream) => finish(stream ?? null),
      () => finish(null),
    );
    function finish(stream) {
      task.running = false;
      release();
      settled.push({ source, index, stream });
      wake?.();
    }
    return task;
  });

  let remaining = tasks.length;
  let best = null;
  try {
    while (remaining > 0) {
      if (settled.length === 0) {
        await nextWake(signal, (resolve) => {
          wake = resolve;
        });
      }
      wake = null;
      await dispatchHop();
      if (signal?.aborted) throw abortReason(signal);
      // Everything that crossed the line while we waited is folded in now;
      // source order breaks a tie between answers that arrived together.
      const ready = settled.splice(0).sort((a, b) => a.index - b.index);
      remaining -= ready.length;
      for (const { source, stream } of ready) {
        if (stream == null) continue;
        if (!accept(source, stream)) continue;
        if (best == null || isBetter(stream.format, best.stream.format)) best = { source, stream };
      }
      if (best != null && !waitForAll) break;
    }
  } finally {
    for (const task of tasks) {
      if (task.running) task.controller.abort(new DOMException('bestAcross already has its answer', 'AbortError'));
    }
  }
  return best;
}

/**
 * The stream for a YouTube track from a source ranked above YouTube, or null
 * (SourceResolver.substituteForYouTube). This is the race's lookup leg.
 */
export async function substituteForYouTube(sources, target, request, options = {}) {
  if (String(target.title ?? '').trim() === '' || target.isVideo) return null;
  const youtube = sources.find((source) => source.kind === 'youtube');
  if (!youtube) return null;
  const found = await bestAcross(rankedAbove(sources, youtube.id), target, request, options);
  return found?.stream ?? null;
}

/**
 * The second look during playback (SourceResolver.upgradeFor): every source
 * above YouTube except the one already serving, all waited for, strict ±2 s
 * length, a shared artist, and a bar of worthSwapping against what is playing.
 * `target.durationSec` must be the runtime actually playing (see
 * effectiveTargetDuration).
 */
export async function upgradeFor(sources, target, request, { playing = null, servedBy = null, ...options } = {}) {
  if (String(target.title ?? '').trim() === '' || target.durationSec == null || target.isVideo) return null;
  const youtube = sources.find((source) => source.kind === 'youtube');
  if (!youtube) return null;
  const candidates = rankedAbove(sources, youtube.id).filter((source) => source.id !== servedBy);
  const found = await bestAcross(candidates, target, request, {
    ...options,
    waitForAll: true,
    strictLength: true,
    requireSharedArtist: true,
    accept: (_source, stream) => worthSwapping(stream.format, playing),
  });
  return found?.stream ?? null;
}

// ── The duration guard of the second look (QualityUpgrade.kt:417-470) ──────

/**
 * The runtime an upgrade must match: the decoder's, unless it drifted more
 * than 30 s from the catalogue's (a music video playing for an album track),
 * in which case the catalogue's.
 */
export function effectiveTargetDuration(expectedSec, playingSec) {
  if (expectedSec != null && playingSec != null && isSevereMismatch(expectedSec, playingSec)) return expectedSec;
  return playingSec ?? expectedSec ?? null;
}

/**
 * Whether a lookup that lost the race (the race's `pending`) may be swapped in
 * once it answers: worthSwapping over what is playing, and sameRecordingAs the
 * effective runtime (QualityUpgrade.lookAgain).
 */
export function acceptsLateLookup(late, { playing = null, playingDurationSec = null, expectedSec = null } = {}) {
  if (!late) return false;
  return (
    worthSwapping(late.format ?? {}, playing) &&
    sameRecordingAs(late.durationSec ?? null, effectiveTargetDuration(expectedSec, playingDurationSec))
  );
}

// ── The race (PlaybackService.resolveWithModulePriority) ───────────────────

/** A fallback's answer as a stream: a bare URL string or a { url, ... } object. */
function asStream(value) {
  if (typeof value === 'string') return value === '' ? null : { url: value, format: {} };
  if (value && typeof value.url === 'string' && value.url !== '') return { ...value, format: value.format ?? {} };
  return null;
}

/**
 * @typedef {Object} RaceOutcome
 * @property {'source'|'fallback'} winner
 * @property {SourceStream} stream           what plays now
 * @property {boolean} substituted           winner === 'source' (StreamChoice.remember's flag)
 * @property {Promise<SourceStream|null>|null} pending
 *           the lookup that lost, still running: handed over, never cancelled
 *           (or, in the manifest case, the manifest stream already answered)
 * @property {{ inFlight: Promise<SourceStream|null>|null, playing: StreamFormat|null,
 *              servedBy: string|null } | null} upgrade
 *           what QualityUpgrade.settledForLess is handed; null when nothing should follow
 * @property {'met-request'|'below-request'|'manifest'|'manifest-only'|'fallback-first'|
 *            'lookup-missed'|'substitutes-refused'} reason
 * @property {() => void} cancelPending      aborts a pending lookup nobody wants any more
 */

/**
 * Races a source lookup against the YouTube fallback with no head start.
 *
 * Both legs start at the same instant. `lookup(signal)` resolves a
 * SourceStream or null and is capped at `timeoutMs` (a timeout reads as null
 * and aborts its signal). `fallback(signal)` resolves a URL string or a
 * `{ url, format?, headers? }`; it may reject.
 *
 * Outcomes, as in PS:4468-4602:
 *  - The lookup answers first with a direct file that meets the request: it
 *    plays; the fallback's wait is dropped.
 *  - ... with something below the request: it plays, and an upgrade follows
 *    (playing = its format, servedBy = its source).
 *  - ... with a DASH/HLS manifest: playback still starts on the fallback (the
 *    progressive source cannot become a manifest source mid-open); the manifest
 *    is handed over as an already-answered `pending`. If the fallback has no
 *    URL either, the manifest plays and is left to fail once and be replayed
 *    with its type declared.
 *  - The fallback answers first: it plays, and the lookup, still running, is
 *    returned as `pending` for the upgrade path. It is NOT cancelled.
 *  - A fallback that finished without a URL has not won anything: the race
 *    waits for the lookup instead. Only when both come back empty does this
 *    reject, with the fallback's error.
 *
 * @param {{ lookup: (signal: AbortSignal) => Promise<SourceStream|null>,
 *           fallback: (signal: AbortSignal) => Promise<string|{url: string}>,
 *           timeoutMs?: number, refused?: boolean,
 *           isManifest?: (stream: SourceStream) => boolean,
 *           signal?: AbortSignal, log?: (line: string) => void }} options
 * @returns {Promise<RaceOutcome>}
 */
export async function raceWithFallback({
  lookup,
  fallback,
  timeoutMs = SUBSTITUTE_TIMEOUT_MS,
  refused = false,
  isManifest = isManifestStream,
  signal,
  log = noop,
}) {
  if (signal?.aborted) throw abortReason(signal);
  const lookupCtl = new AbortController();
  const fallbackCtl = new AbortController();
  let lookupDone = false;

  const outcome = ({ winner, stream, pending = null, upgrade = null, reason }) => ({
    winner,
    stream,
    substituted: winner === 'source',
    pending,
    upgrade,
    reason,
    cancelPending: () => {
      if (!lookupDone) lookupCtl.abort(new DOMException('pending lookup cancelled', 'AbortError'));
    },
  });

  // A substitute already broke this track (StreamChoice.refuseSubstitutes):
  // racing the same catalogue again would find the same unplayable URL.
  if (refused) {
    lookupDone = true;
    const stream = asStream(await abortable(Promise.resolve().then(() => fallback(signal)), signal));
    if (stream == null) throw new Error('fallback finished without a URL');
    return outcome({ winner: 'fallback', stream, reason: 'substitutes-refused' });
  }

  // Leg 1: withTimeoutOrNull(SUBSTITUTE_TIMEOUT_MS) { substituteForYouTube(target) }.
  let timer = null;
  const lookupLeg = new Promise((resolve) => {
    const finish = (stream) => {
      if (lookupDone) return;
      lookupDone = true;
      clearTimeout(timer);
      resolve(stream ?? null);
    };
    timer = setTimeout(() => {
      log(`lookup gave up after ${timeoutMs} ms`);
      // withTimeoutOrNull: cancel the block, then answer null.
      lookupCtl.abort(new DOMException(`lookup timed out after ${timeoutMs} ms`, 'TimeoutError'));
      finish(null);
    }, timeoutMs);
    Promise.resolve()
      .then(() => lookup(lookupCtl.signal))
      .then(finish, (error) => {
        if (!lookupCtl.signal.aborted) log(`lookup failed: ${error?.message ?? error}`);
        finish(null);
      });
  });

  // Leg 2: runCatching { StreamResolver.resolve(videoId) }, started at the same instant.
  const fallbackLeg = Promise.resolve()
    .then(() => fallback(fallbackCtl.signal))
    .then(
      (value) => {
        const stream = asStream(value);
        return stream ? { ok: true, stream } : { ok: false, error: new Error('fallback finished without a URL') };
      },
      (error) => ({ ok: false, error }),
    );

  // The caller giving up cancels both legs, but only while the race runs: a
  // lookup already handed back as `pending` belongs to the upgrade path.
  const onAbort = () => {
    lookupCtl.abort(abortReason(signal));
    fallbackCtl.abort(abortReason(signal));
  };
  signal?.addEventListener('abort', onAbort, { once: true });

  try {
    // First past the post; the lookup clause is listed first, like the select.
    const first = await abortable(
      Promise.race([
        lookupLeg.then((stream) => ({ leg: 'lookup', stream })),
        fallbackLeg.then((result) => ({ leg: 'fallback', result })),
      ]),
      signal,
    );
    let quick;
    if (first.leg === 'lookup') quick = first.stream;
    else if (first.result.ok) quick = null;
    else quick = await abortable(lookupLeg, signal); // a fallback without a URL has not won

    if (quick != null && isManifest(quick)) {
      const fell = await abortable(fallbackLeg, signal);
      if (fell.ok) {
        log('offered a manifest; starting on the fallback and swapping to it under the music');
        const answered = Promise.resolve(quick);
        return outcome({
          winner: 'fallback',
          stream: fell.stream,
          pending: answered,
          upgrade: { inFlight: answered, playing: fell.stream.format ?? null, servedBy: null },
          reason: 'manifest',
        });
      }
      log('only a manifest, and the fallback cannot serve; letting it fail once to declare its type');
      return outcome({ winner: 'source', stream: quick, reason: 'manifest-only' });
    }

    if (quick != null) {
      // The fallback is spare work now. Aborting drops only our wait; a
      // fallback built on singleFlight finishes into its own cache.
      fallbackCtl.abort(new DOMException('the lookup won the race', 'AbortError'));
      if (!quick.belowRequest) return outcome({ winner: 'source', stream: quick, reason: 'met-request' });
      return outcome({
        winner: 'source',
        stream: quick,
        upgrade: { inFlight: null, playing: quick.format ?? null, servedBy: quick.sourceId ?? null },
        reason: 'below-request',
      });
    }

    const fell = await abortable(fallbackLeg, signal);
    if (!fell.ok) throw fell.error;
    // Handed over still running, or null if it already finished with nothing.
    const pending = lookupDone ? null : lookupLeg;
    return outcome({
      winner: 'fallback',
      stream: fell.stream,
      pending,
      upgrade: { inFlight: pending, playing: fell.stream.format ?? null, servedBy: null },
      reason: pending ? 'fallback-first' : 'lookup-missed',
    });
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
}

// ── StreamChoice (playback/StreamChoice.kt) ─────────────────────────────────

/**
 * Which copy of a track fills its cache entry. Once a stream starts filling an
 * entry, every later open of the same track (seek, resume, the continuation
 * fetch) must get the same stream, or the middle of an MP4 ends up appended
 * to a WebM.
 */
export class StreamChoice {
  /** How long a pin is trusted (StreamChoice.kt:178). */
  static TTL_MS = 15 * 60 * 1000;
  /** How long a track stays off substitution after one broke it (StreamChoice.kt:188). */
  static REFUSAL_MS = 10 * 60 * 1000;
  /** Pins and refusals held (StreamChoice.kt:190). */
  static MAX_REMEMBERED = 32;

  #chosen = new Map();
  #refused = new Map();
  #now;

  /** @param {{ now?: () => number }} [options] */
  constructor({ now = Date.now } = {}) {
    this.#now = now;
  }

  /** The stream already serving `videoId`, or null (none, or older than 15 minutes). */
  of(videoId) {
    const choice = this.#chosen.get(videoId);
    if (!choice) return null;
    if (this.#now() - choice.at > StreamChoice.TTL_MS) {
      this.#chosen.delete(videoId);
      return null;
    }
    return choice.stream;
  }

  /**
   * Records `stream` as the copy of `videoId` being read. When full, expired
   * pins go first and then the single oldest one; never the whole map.
   */
  remember(videoId, stream, substituted) {
    if (this.#chosen.size >= StreamChoice.MAX_REMEMBERED) {
      const now = this.#now();
      for (const [id, choice] of this.#chosen) if (now - choice.at > StreamChoice.TTL_MS) this.#chosen.delete(id);
      if (this.#chosen.size >= StreamChoice.MAX_REMEMBERED) {
        let oldestId = null;
        let oldestAt = Infinity;
        for (const [id, choice] of this.#chosen) {
          if (choice.at < oldestAt) {
            oldestAt = choice.at;
            oldestId = id;
          }
        }
        this.#chosen.delete(oldestId);
      }
    }
    this.#chosen.set(videoId, { stream, at: this.#now(), substituted: Boolean(substituted) });
  }

  /** Whether the copy serving `videoId` came from a source standing in for YouTube. */
  isSubstitute(videoId) {
    return this.#chosen.get(videoId)?.substituted === true;
  }

  forget(videoId) {
    this.#chosen.delete(videoId);
  }

  /** Stops `videoId` being substituted for 10 minutes. Cleared wholesale at 32, as in Kotlin. */
  refuseSubstitutes(videoId) {
    if (this.#refused.size >= StreamChoice.MAX_REMEMBERED) this.#refused.clear();
    this.#refused.set(videoId, this.#now());
  }

  substitutesRefused(videoId) {
    const at = this.#refused.get(videoId);
    if (at == null) return false;
    if (this.#now() - at <= StreamChoice.REFUSAL_MS) return true;
    this.#refused.delete(videoId);
    return false;
  }
}

/**
 * The resolver's branches for a YouTube-queued track, in ladder order
 * (PS:1355-1471, steps 5-7 of the paper's §4.2):
 *   5. a StreamChoice pin is reused (a lossy substitute pin still arms an upgrade);
 *   6. nothing ranks above YouTube: the fallback alone, pinned;
 *   7. otherwise the race, and whatever wins is pinned.
 */
export async function resolveWatch({
  videoId,
  choice,
  canSubstitute = true,
  lookup,
  fallback,
  timeoutMs = SUBSTITUTE_TIMEOUT_MS,
  signal,
  log = noop,
}) {
  const pinned = choice.of(videoId);
  if (pinned) {
    const substituted = choice.isSubstitute(videoId);
    const upgrade =
      substituted && isLossless(pinned.format) !== true
        ? { inFlight: null, playing: pinned.format ?? null, servedBy: pinned.sourceId ?? null }
        : null;
    return { stream: pinned, pinned: true, substituted, upgrade, outcome: null };
  }
  if (!canSubstitute) {
    const stream = asStream(await abortable(Promise.resolve().then(() => fallback(signal)), signal));
    if (stream == null) throw new Error('fallback finished without a URL');
    choice.remember(videoId, stream, false);
    return { stream, pinned: false, substituted: false, upgrade: null, outcome: null };
  }
  const outcome = await raceWithFallback({
    lookup,
    fallback,
    timeoutMs,
    refused: choice.substitutesRefused(videoId),
    signal,
    log,
  });
  choice.remember(videoId, outcome.stream, outcome.substituted);
  return { stream: outcome.stream, pinned: false, substituted: outcome.substituted, upgrade: outcome.upgrade, outcome };
}
