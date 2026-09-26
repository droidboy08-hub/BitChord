// Range-chunked media fetch: the googlevideo anti-pacing trick.
//
// Mirrors BitChord (commit fe198ac):
//   app/src/main/java/com/music/bitchord/playback/ChunkedDataSource.kt   (whole file)
//   app/src/main/java/com/music/bitchord/data/innertube/PlayerClient.kt  rangeBytesFor (:146-159)
//   app/src/main/java/com/music/bitchord/playback/PlaybackService.kt     STREAM_CHUNK_BYTES (:7497),
//                                                                         factory wiring (:1474-1484)
//   app/src/main/java/com/music/bitchord/data/innertube/StreamResolver.kt REFUSAL_CODES (:797)
//   [ITX] InnerTubeExtractor.kt usesChunkedMediaRanges / mediaRangeChunkSize (:1626-1628),
//         which PlayerClient.rangeBytesFor copies.
//
// Independent JavaScript re-implementation of the mechanism documented in
// BITCHORD_ENGINE_RESEARCH.md §5.2 / §10 #1 (BitChord itself is GPL-3.0;
// InnerTubeX is GPL-3.0 too — LICENSE and README "License" in its repository).
//
// Why: googlevideo paces one open-ended GET to roughly playback speed
// (measured in ChunkedDataSource.kt:25-28: 15.5 kB/s unbounded vs 5.7 MB/s for
// `Range: bytes=0-2097151` on the same track and connection). A 160 kbps stream
// needs 20 kB/s, so an unbounded read can never build a buffer. Bounded ranges
// are served at line rate.
//
// Rules, as in ChunkedDataSource:
//   * Chunk only when the URL carries `clen` (the total size is needed to know
//     where the last range ends). Any host qualifies; in practice only
//     googlevideo URLs carry it. Everything else is ONE pass-through request.
//   * Range size = min(chunkBytes (1 MiB), rangeBytesFor(url)): 512 KiB when
//     the URL's `c=` is ANDROID_VR or TVHTML5_SIMPLY* on googlevideo (the
//     largest range InnerTubeX found those clients' URLs reliably served),
//     1 MiB for other googlevideo clients, unlimited (so chunkBytes) elsewhere.
//   * Requests are sequential and use the `Range` header, not `&range=`.
//   * A range that ends early is re-opened from the first missing byte. Three
//     consecutive reads that yield nothing (MAX_EMPTY_RANGES; the end-of-body of
//     a truncated range counts as one) stop the stream. Kotlin then reports a
//     silent end-of-input; here the default is a TruncatedStreamError because an
//     async iterator has no declared length for the consumer to compare with.
//     Pass { onTruncated: 'end' } for the Kotlin behaviour.
//   * 403 / 404 / 410 call onRefused(url, status, info) before the error is
//     thrown: that is StreamResolver.onPlaybackRefused's hook (evict the URL,
//     retire the client that minted it). Also for pass-through requests.
//   * Per-request headers only (the minting client's User-Agent); nothing is
//     set globally, cf. the double-User-Agent note at PlaybackService.kt:1474-1478.
//
// Additions: an idle timeout standing in for OkHttp's 30 s read timeout
// (Http.kt:134-142), armed only while waiting on the network, never while the
// consumer holds a chunk; a server that answers a Range request with 200 (Range
// ignored) is skipped to the position and then read to the end instead of
// being re-asked for every chunk; bodies without a stream reader (React
// Native's fetch) are read with arrayBuffer(), which chunking keeps at <= 1 MiB.
//
// Usage with the YouTube resolver:
//   const s = await resolver.resolve(id);
//   for await (const bytes of chunkedStream(s.url, {
//     headers: resolver.mediaHeadersFor(s.url),
//     onRefused: (url, status) => resolver.onPlaybackRefused(url, status),
//   })) sink.write(bytes);

import { HttpError } from '../lib/http.js';

/** PlaybackService.kt:7497 STREAM_CHUNK_BYTES. */
export const STREAM_CHUNK_BYTES = 1024 * 1024;
/** PlayerClient.kt:158 RANGE_BYTES. */
export const RANGE_BYTES = 1024 * 1024;
/** PlayerClient.kt:159 NARROW_RANGE_BYTES (ANDROID_VR, TVHTML5_SIMPLY). */
export const NARROW_RANGE_BYTES = 512 * 1024;
/** ChunkedDataSource.kt:200: "enough to ride out a truncated range, not enough to hang on a dead one". */
export const MAX_EMPTY_RANGES = 3;
/** StreamResolver.kt:797: the statuses that mean "this client's URL was refused". */
export const REFUSAL_CODES = Object.freeze([403, 404, 410]);
/** OkHttp read timeout of the shared client (Http.kt:136), used here as an idle timeout. */
export const READ_IDLE_TIMEOUT_MS = 30_000;

/** The stream ended before the bytes it was asked for, after MAX_EMPTY_RANGES empty reads. */
export class TruncatedStreamError extends Error {
  constructor(url, position, end) {
    super(`stream ended at byte ${position} of ${end} after ${MAX_EMPTY_RANGES} empty reads: ${url}`);
    this.name = 'TruncatedStreamError';
    this.url = url;
    this.position = position;
    this.end = end;
  }
}

function parseHttpUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Largest single range googlevideo reliably serves for `url`'s client
 * (PlayerClient.rangeBytesFor). Infinity (Kotlin Long.MAX_VALUE) for URLs that
 * are not googlevideo or cannot be parsed.
 * @param {string} url
 * @returns {number}
 */
export function rangeBytesFor(url) {
  const parsed = parseHttpUrl(url);
  if (!parsed || !parsed.hostname.endsWith('googlevideo.com')) return Infinity;
  const name = parsed.searchParams.get('c')?.toUpperCase();
  return name === 'ANDROID_VR' || name?.startsWith('TVHTML5_SIMPLY') ? NARROW_RANGE_BYTES : RANGE_BYTES;
}

/**
 * The `clen` query parameter (total size in bytes), or null. Mirrors
 * `uri.getQueryParameter("clen")?.toLongOrNull()`.
 * @param {string} url
 * @returns {number|null}
 */
export function contentLengthOf(url) {
  let value;
  try {
    value = new URL(url).searchParams.get('clen');
  } catch {
    return null;
  }
  if (value === null || !/^[+-]?\d+$/.test(value)) return null;
  const n = Number(value);
  return Number.isSafeInteger(n) ? n : null;
}

/**
 * An AbortController tied to the caller's signal, plus an idle timer that is
 * armed only while we wait on the network (connect/headers, each body read).
 * Like OkHttp's read timeout it never runs while the CONSUMER holds a chunk,
 * so a paused player does not get its request killed.
 */
function watchdog(parent, idleMs) {
  const controller = new AbortController();
  const onParentAbort = () => controller.abort(parent.reason);
  if (parent) {
    if (parent.aborted) controller.abort(parent.reason);
    else parent.addEventListener('abort', onParentAbort, { once: true });
  }
  let timer = null;
  const disarm = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };
  const arm = () => {
    disarm();
    if (idleMs > 0 && !controller.signal.aborted) {
      timer = setTimeout(() => {
        const error = new Error(`no data for ${idleMs} ms`);
        error.name = 'TimeoutError';
        controller.abort(error);
      }, idleMs);
    }
  };
  const close = () => {
    disarm();
    if (parent) parent.removeEventListener('abort', onParentAbort);
  };
  return { signal: controller.signal, arm, disarm, close };
}

/** `dog`'s timer runs only for the duration of `promise` (which also rejects on abort). */
async function waitOnNetwork(promise, dog) {
  dog.arm();
  try {
    return await untilAborted(promise, dog.signal);
  } finally {
    dog.disarm();
  }
}

/** Issue one request; any 2xx is returned, anything else becomes an HttpError (refusals reported first). */
async function open(url, headers, options, dog, info) {
  const f = options.ctx?.fetch ?? globalThis.fetch;
  const res = await waitOnNetwork(Promise.resolve().then(() => f(url, { headers, signal: dog.signal })), dog);
  if (res.status >= 200 && res.status <= 299) return res;
  const body = await waitOnNetwork(res.text(), dog).catch(() => '');
  if (REFUSAL_CODES.includes(res.status) && options.onRefused) {
    // The one piece of evidence client retirement rests on (ChunkedDataSource.kt:129-133).
    try {
      options.onRefused(url, res.status, info);
    } catch {
      // A failing hook must not mask the HTTP error.
    }
  }
  throw new HttpError(res.status, url, body);
}

/**
 * `promise`, rejecting as soon as `signal` aborts. Body reads go through this
 * so the idle timeout and the caller's signal work even with a fetch
 * implementation that does not wire its signal into the body stream.
 */
function untilAborted(promise, signal) {
  if (signal.aborted) {
    promise.catch(() => {});
    return Promise.reject(signal.reason);
  }
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (v) => { signal.removeEventListener('abort', onAbort); resolve(v); },
      (e) => { signal.removeEventListener('abort', onAbort); reject(e); },
    );
  });
}

/** A response body as Uint8Array pieces; cancels the transfer if the consumer stops early. */
async function* bodyChunks(res, dog) {
  const body = res.body;
  if (body && typeof body.getReader === 'function') {
    const reader = body.getReader();
    try {
      for (;;) {
        const { done, value } = await waitOnNetwork(reader.read(), dog);
        if (done) return;
        if (value && value.byteLength > 0) yield value instanceof Uint8Array ? value : new Uint8Array(value);
      }
    } finally {
      reader.cancel().catch(() => {});
    }
  } else {
    // No streaming body (React Native): one range is one buffer.
    const whole = new Uint8Array(await waitOnNetwork(res.arrayBuffer(), dog));
    if (whole.byteLength > 0) yield whole;
  }
}

/**
 * Stream `res`'s body, dropping the first `skip` bytes and stopping after
 * `budget` bytes. Reports progress through `state.got`.
 */
async function* sliceBody(res, dog, skip, budget, state) {
  for await (const piece of bodyChunks(res, dog)) {
    let chunk = piece;
    if (skip > 0) {
      if (chunk.byteLength <= skip) {
        skip -= chunk.byteLength;
        continue;
      }
      chunk = chunk.subarray(skip);
      skip = 0;
    }
    const room = budget - state.got;
    if (chunk.byteLength > room) chunk = chunk.subarray(0, room);
    if (chunk.byteLength === 0) return;
    state.got += chunk.byteLength;
    yield chunk;
    if (state.got >= budget) return;
  }
}

async function* rangedBody(url, o) {
  let pos = o.start;
  let misses = 0;
  const client = parseHttpUrl(url)?.searchParams.get('c') ?? null;
  while (pos < o.end) {
    const want = Math.min(o.rangeBytes, o.end - pos);
    const info = { rangeStart: pos, rangeEnd: pos + want - 1, client };
    const dog = watchdog(o.ctx?.signal, o.idleTimeoutMs);
    try {
      const res = await open(url, { ...o.headers, Range: `bytes=${pos}-${pos + want - 1}` }, o, dog, info);
      // 200 = Range ignored: the body starts at byte 0 and runs to the end.
      // Skip to `pos` (as Media3's OkHttpDataSource does) and keep reading this
      // response for the whole remainder rather than re-requesting per chunk.
      const ignoredRange = res.status === 200;
      const budget = ignoredRange ? o.end - pos : want;
      const state = { got: 0 };
      for await (const chunk of sliceBody(res, dog, ignoredRange ? pos : 0, budget, state)) {
        pos += chunk.byteLength;
        yield chunk;
      }
      if (state.got > 0) misses = 0; // a read that returned bytes resets the count
      if (state.got >= budget) continue; // range complete: step to the next one
      misses += 1; // the read that hit end-of-body early
      if (misses >= MAX_EMPTY_RANGES) {
        if (o.onTruncated === 'end') return; // Kotlin: C.RESULT_END_OF_INPUT
        throw new TruncatedStreamError(url, pos, o.end);
      }
    } finally {
      dog.close();
    }
  }
}

async function* passthroughBody(url, o) {
  if (o.length === 0) return;
  const headers = { ...o.headers };
  const ranged = o.position > 0 || o.length != null;
  if (ranged) headers.Range = `bytes=${o.position}-${o.length != null ? o.position + o.length - 1 : ''}`;
  const dog = watchdog(o.ctx?.signal, o.idleTimeoutMs);
  try {
    const info = { rangeStart: o.position, rangeEnd: o.length != null ? o.position + o.length - 1 : null, client: null };
    const res = await open(url, headers, o, dog, info);
    const skip = ranged && res.status === 200 ? o.position : 0;
    yield* sliceBody(res, dog, skip, o.length ?? Infinity, { got: 0 });
  } finally {
    dog.close();
  }
}

/**
 * @typedef {Object} ChunkedOptions
 * @property {{fetch?: typeof fetch, signal?: AbortSignal}} [ctx]
 * @property {Record<string,string>} [headers]  per-request headers (e.g. the minting client's User-Agent)
 * @property {number} [chunkBytes]   upper bound per range; default STREAM_CHUNK_BYTES (1 MiB)
 * @property {(url: string, status: number, info: {rangeStart: number, rangeEnd: number|null, client: string|null}) => void} [onRefused]
 * @property {number} [position]     first byte to read (a seek); default 0
 * @property {number} [length]       bytes to read from `position`; default: to the end
 * @property {number} [idleTimeoutMs] abort when one network wait (headers, a body read) exceeds this; default 30 s
 * @property {'error'|'end'} [onTruncated] what three empty reads mean; default 'error'
 */

/**
 * Read `url` as sequential bounded ranges (when it carries `clen`) or as one
 * pass-through request (when it does not).
 *
 * The returned async iterator yields Uint8Array pieces in order and carries:
 *   chunked        whether ranges are used
 *   contentLength  `clen`, or null
 *   expectedBytes  bytes this read will deliver when known, else null
 *   rangeBytes     bytes per range when chunked, else null
 * Breaking out of `for await` cancels the request in flight.
 *
 * @param {string} url
 * @param {ChunkedOptions} [options]
 * @returns {AsyncGenerator<Uint8Array, void, undefined> & {chunked: boolean,
 *   contentLength: number|null, expectedBytes: number|null, rangeBytes: number|null}}
 */
export function chunkedStream(url, options = {}) {
  const {
    ctx = {},
    headers = {},
    chunkBytes = STREAM_CHUNK_BYTES,
    onRefused,
    position = 0,
    length = null,
    idleTimeoutMs = READ_IDLE_TIMEOUT_MS,
    onTruncated = 'error',
  } = options;
  const common = { ctx, headers, onRefused, idleTimeoutMs, onTruncated };
  const total = contentLengthOf(url);
  if (total === null) {
    return Object.assign(passthroughBody(url, { ...common, position, length }), {
      chunked: false,
      contentLength: null,
      expectedBytes: length ?? null,
      rangeBytes: null,
    });
  }
  // ChunkedDataSource.open: end = clen, or min(clen, position + length).
  const end = length == null ? total : Math.min(total, position + length);
  const rangeBytes = Math.min(chunkBytes, rangeBytesFor(url));
  return Object.assign(rangedBody(url, { ...common, start: position, end, rangeBytes }), {
    chunked: true,
    contentLength: total,
    expectedBytes: Math.max(end - position, 0),
    rangeBytes,
  });
}

/**
 * chunkedStream() as a WHATWG ReadableStream<Uint8Array> (pull-driven: no
 * range is requested before a reader asks for bytes). Cancelling the stream
 * cancels the request in flight.
 * @param {string} url
 * @param {ChunkedOptions} [options]
 * @returns {ReadableStream<Uint8Array>}
 */
export function chunkedReadableStream(url, options = {}) {
  if (typeof ReadableStream === 'undefined') {
    throw new Error('ReadableStream is not available here; iterate chunkedStream() instead');
  }
  const it = chunkedStream(url, options);
  const stream = new ReadableStream(
    {
      async pull(controller) {
        try {
          const { value, done } = await it.next();
          if (done) controller.close();
          else controller.enqueue(value);
        } catch (error) {
          controller.error(error);
        }
      },
      async cancel() {
        await it.return(undefined);
      },
    },
    { highWaterMark: 0 },
  );
  return Object.assign(stream, {
    chunked: it.chunked,
    contentLength: it.contentLength,
    expectedBytes: it.expectedBytes,
    rangeBytes: it.rangeBytes,
  });
}
