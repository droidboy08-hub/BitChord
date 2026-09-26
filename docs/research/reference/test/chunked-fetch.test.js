// Tests for transport/chunkedFetch.js (mirrors playback/ChunkedDataSource.kt and
// PlayerClient.rangeBytesFor) against an in-memory "googlevideo".
// Independent JavaScript re-implementation of the mechanism documented in
// BITCHORD_ENGINE_RESEARCH.md (BitChord itself is GPL-3.0; InnerTubeX is GPL-3.0).
//
// The fake server answers `Range: bytes=a-b` with 206 and exactly those bytes,
// as googlevideo does; individual tests bend it (truncate, go silent, refuse,
// ignore Range) to exercise each branch of ChunkedDataSource's contract.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeFetch, HttpError } from '../lib/http.js';
import {
  rangeBytesFor,
  contentLengthOf,
  chunkedStream,
  chunkedReadableStream,
  TruncatedStreamError,
  STREAM_CHUNK_BYTES,
  NARROW_RANGE_BYTES,
  MAX_EMPTY_RANGES,
} from '../transport/chunkedFetch.js';

const KiB = 1024;
const MiB = 1024 * KiB;

const makeBytes = (n) => Uint8Array.from({ length: n }, (_, i) => (i * 31 + 7) & 255);

const gv = (client, version = '1.0', clen = 5_000_000, extra = '') =>
  `https://rr3---sn-4g5lznek.googlevideo.com/videoplayback?expire=1790000000&ei=abc&id=o-AAAA&itag=251` +
  `&source=youtube&requiressl=yes&mime=audio%2Fwebm&gir=yes&clen=${clen}&dur=212.061&lmt=1700000000000000` +
  `&c=${client}&cver=${version}${extra}&sig=AJfQdSswRQIh&lsig=APaTxxMw`;

function parseRange(header, size) {
  const m = /^bytes=(\d+)-(\d*)$/.exec(header ?? '');
  if (!m) return null;
  const start = Number(m[1]);
  const end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  return { start, end };
}

/**
 * googlevideo in miniature. `tweak(n, range)` may return a response for the
 * n-th request (1-based) to override the honest one.
 */
function mediaServer(bytes, tweak = () => null) {
  let n = 0;
  return fakeFetch([
    [
      () => true,
      (url, init) => {
        n += 1;
        const range = parseRange(init.headers?.Range, bytes.length);
        const override = tweak(n, range);
        if (override) return override;
        if (!range) return { status: 200, body: bytes, headers: { 'content-type': 'audio/webm' } };
        return {
          status: 206,
          body: bytes.slice(range.start, range.end + 1),
          headers: { 'content-type': 'audio/webm', 'content-range': `bytes ${range.start}-${range.end}/${bytes.length}` },
        };
      },
    ],
  ]);
}

async function collect(iterable) {
  const parts = [];
  for await (const part of iterable) parts.push(part);
  const out = new Uint8Array(parts.reduce((sum, p) => sum + p.byteLength, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.byteLength;
  }
  return out;
}

const ranges = (fetch) => fetch.calls.map((c) => c.init.headers?.Range ?? null);

// ---- rangeBytesFor / clen (mirrors BitChord's PlayerClientRangeTest) ---------------

test('googlevideo ranges are capped at one megabyte', () => {
  assert.equal(rangeBytesFor(gv('IOS')), MiB);
  assert.equal(rangeBytesFor(gv('VISIONOS', '1.02')), MiB);
  assert.equal(rangeBytesFor(gv('TVHTML5')), MiB);
  assert.equal(rangeBytesFor(gv('WEB_REMIX')), MiB);
});

test('clients refused past a megabyte get half that', () => {
  assert.equal(rangeBytesFor(gv('ANDROID_VR', '1.65.10')), 512 * KiB);
  assert.equal(rangeBytesFor(gv('TVHTML5_SIMPLY')), 512 * KiB);
  assert.equal(rangeBytesFor(gv('TVHTML5_SIMPLY_EMBEDDED_PLAYER')), 512 * KiB);
  assert.equal(rangeBytesFor(gv('android_vr')), 512 * KiB); // `c` is upper-cased first
});

test('non-googlevideo hosts and unparseable URLs are not capped', () => {
  assert.equal(rangeBytesFor('https://sp-ad-cf.audio.tidal.com/x.flac'), Infinity);
  assert.equal(rangeBytesFor('not a url'), Infinity);
  assert.equal(rangeBytesFor('ftp://r1.googlevideo.com/videoplayback?c=ANDROID_VR'), Infinity);
});

test('clen is read like getQueryParameter("clen")?.toLongOrNull()', () => {
  assert.equal(contentLengthOf(gv('IOS', '1', 3433287)), 3433287);
  assert.equal(contentLengthOf('https://x/a?clen='), null);
  assert.equal(contentLengthOf('https://x/a?clen=12x'), null);
  assert.equal(contentLengthOf('https://x/a'), null);
  assert.equal(contentLengthOf('::'), null);
});

// ---- chunked reads -------------------------------------------------------------------

test('a googlevideo URL with clen is read as sequential 1 MiB Range requests', async () => {
  const size = 2 * MiB + 512 * KiB + 123;
  const bytes = makeBytes(size);
  const fetch = mediaServer(bytes);
  const url = gv('WEB_REMIX', '1.20260707.12.00', size);
  const s = chunkedStream(url, { ctx: { fetch }, headers: { 'User-Agent': 'UA/1' } });
  assert.equal(s.chunked, true);
  assert.equal(s.contentLength, size);
  assert.equal(s.expectedBytes, size);
  assert.equal(s.rangeBytes, STREAM_CHUNK_BYTES);
  assert.deepEqual(await collect(s), bytes);
  assert.deepEqual(ranges(fetch), ['bytes=0-1048575', 'bytes=1048576-2097151', `bytes=2097152-${size - 1}`]);
  for (const call of fetch.calls) {
    assert.deepEqual(call.init.headers, { 'User-Agent': 'UA/1', Range: call.init.headers.Range }); // per-request headers only
  }
});

test('ANDROID_VR URLs are read in 512 KiB ranges', async () => {
  const size = 1_300_000;
  const bytes = makeBytes(size);
  const fetch = mediaServer(bytes);
  const s = chunkedStream(gv('ANDROID_VR', '1.43.32', size), { ctx: { fetch } });
  assert.equal(s.rangeBytes, NARROW_RANGE_BYTES);
  assert.deepEqual(await collect(s), bytes);
  assert.deepEqual(ranges(fetch), ['bytes=0-524287', 'bytes=524288-1048575', `bytes=1048576-${size - 1}`]);
});

test('the range size is min(chunkBytes, rangeBytesFor(url))', async () => {
  const size = 600 * KiB;
  const fetch = mediaServer(makeBytes(size));
  const s = chunkedStream(gv('WEB_REMIX', '1', size), { ctx: { fetch }, chunkBytes: 256 * KiB });
  await collect(s);
  assert.deepEqual(ranges(fetch), ['bytes=0-262143', 'bytes=262144-524287', `bytes=524288-${size - 1}`]);
});

test('any host with clen is chunked (the gate is clen, not the host), at chunkBytes', async () => {
  const size = 1_500_000;
  const fetch = mediaServer(makeBytes(size));
  const s = chunkedStream(`https://cdn.example.org/track.flac?clen=${size}`, { ctx: { fetch } });
  assert.equal(s.rangeBytes, MiB);
  await collect(s);
  assert.deepEqual(ranges(fetch), ['bytes=0-1048575', `bytes=1048576-${size - 1}`]);
});

test('position and length bound the ranges like ChunkedDataSource.open', async () => {
  const size = 3 * MiB;
  const bytes = makeBytes(size);
  const fetch = mediaServer(bytes);
  const s = chunkedStream(gv('IOS', '21.26.4', size), { ctx: { fetch }, position: 1_000_000, length: 1_500_000 });
  assert.equal(s.expectedBytes, 1_500_000);
  assert.deepEqual(await collect(s), bytes.slice(1_000_000, 2_500_000));
  assert.deepEqual(ranges(fetch), ['bytes=1000000-2048575', 'bytes=2048576-2499999']);
});

test('a length past clen is clipped to clen; a position at the end reads nothing', async () => {
  const size = 100_000;
  const fetch = mediaServer(makeBytes(size));
  assert.equal((await collect(chunkedStream(gv('IOS', '1', size), { ctx: { fetch }, position: 90_000, length: 50_000 }))).length, 10_000);
  const empty = chunkedStream(gv('IOS', '1', size), { ctx: { fetch }, position: size });
  assert.equal(empty.expectedBytes, 0);
  assert.equal((await collect(empty)).length, 0);
  assert.equal(fetch.calls.length, 1); // nothing requested for the empty read
});

// ---- pass-through ---------------------------------------------------------------------

test('without clen the URL is fetched once, with no Range header', async () => {
  const bytes = makeBytes(3 * MiB);
  const fetch = mediaServer(bytes);
  const s = chunkedStream('https://aac.saavncdn.com/815/abc_320.mp4', { ctx: { fetch } });
  assert.equal(s.chunked, false);
  assert.equal(s.rangeBytes, null);
  assert.deepEqual(await collect(s), bytes);
  assert.deepEqual(ranges(fetch), [null]);
});

test('a pass-through seek sends Range like OkHttpDataSource (open-ended or bounded)', async () => {
  const bytes = makeBytes(10_000);
  const fetch = mediaServer(bytes);
  const url = 'https://aac.saavncdn.com/815/abc_320.mp4';
  assert.deepEqual(await collect(chunkedStream(url, { ctx: { fetch }, position: 4_000 })), bytes.slice(4_000));
  assert.deepEqual(await collect(chunkedStream(url, { ctx: { fetch }, position: 10, length: 90 })), bytes.slice(10, 100));
  assert.deepEqual(ranges(fetch), ['bytes=4000-', 'bytes=10-99']);
});

// ---- truncation ---------------------------------------------------------------------------

test('a truncated range is re-opened from the first missing byte', async () => {
  const size = 2 * MiB;
  const bytes = makeBytes(size);
  // The first response stops after 100 000 bytes of its 1 MiB.
  const fetch = mediaServer(bytes, (n, r) =>
    n === 1 ? { status: 206, body: bytes.slice(r.start, r.start + 100_000), headers: { 'content-type': 'audio/webm' } } : null,
  );
  assert.deepEqual(await collect(chunkedStream(gv('IOS', '1', size), { ctx: { fetch } })), bytes);
  assert.deepEqual(ranges(fetch), ['bytes=0-1048575', 'bytes=100000-1148575', `bytes=1148576-${size - 1}`]);
});

test(`${MAX_EMPTY_RANGES} empty reads in a row stop the stream (clean boundary: 3 opens)`, async () => {
  const size = 1_500_000;
  const bytes = makeBytes(size);
  const silentAfterFirst = (n) => (n > 1 ? { status: 206, body: new Uint8Array(0), headers: { 'content-type': 'audio/webm' } } : null);

  const fetch = mediaServer(bytes, silentAfterFirst);
  const received = [];
  await assert.rejects(
    (async () => { for await (const p of chunkedStream(gv('IOS', '1', size), { ctx: { fetch } })) received.push(p); })(),
    (e) => e instanceof TruncatedStreamError && e.position === MiB && e.end === size,
  );
  assert.equal(received.reduce((s, p) => s + p.byteLength, 0), MiB);
  assert.equal(fetch.calls.length, 1 + 3);

  // onTruncated:'end' reproduces Kotlin's silent C.RESULT_END_OF_INPUT.
  const quiet = mediaServer(bytes, silentAfterFirst);
  const got = await collect(chunkedStream(gv('IOS', '1', size), { ctx: { fetch: quiet }, onTruncated: 'end' }));
  assert.equal(got.length, MiB);
});

test('after a truncation the early end-of-body counts as the first empty read (2 re-opens)', async () => {
  const size = 1_500_000;
  const bytes = makeBytes(size);
  const fetch = mediaServer(bytes, (n, r) =>
    n === 1
      ? { status: 206, body: bytes.slice(0, 100), headers: { 'content-type': 'audio/webm' } }
      : { status: 206, body: new Uint8Array(0), headers: { 'content-type': 'audio/webm' } },
  );
  await assert.rejects(collect(chunkedStream(gv('IOS', '1', size), { ctx: { fetch } })), TruncatedStreamError);
  assert.deepEqual(ranges(fetch), ['bytes=0-1048575', 'bytes=100-1048675', 'bytes=100-1048675']);
});

// ---- refusals -----------------------------------------------------------------------------

test('403/404/410 call onRefused (with the minting client) before the error surfaces', async () => {
  for (const status of [403, 404, 410]) {
    const size = 2 * MiB;
    const fetch = mediaServer(makeBytes(size), (n) => (n === 2 ? { status, body: 'refused' } : null));
    const refusals = [];
    const url = gv('ANDROID_VR', '1.43.32', size);
    const received = [];
    await assert.rejects(
      (async () => {
        for await (const p of chunkedStream(url, { ctx: { fetch }, onRefused: (...args) => refusals.push(args) })) received.push(p);
      })(),
      (e) => e instanceof HttpError && e.status === status,
    );
    assert.equal(received.reduce((s, p) => s + p.byteLength, 0), 512 * KiB);
    assert.deepEqual(refusals, [[url, status, { rangeStart: 524288, rangeEnd: 1048575, client: 'ANDROID_VR' }]]);
  }
});

test('other failures are thrown without calling onRefused', async () => {
  const fetch = mediaServer(makeBytes(10_000), () => ({ status: 503, body: 'busy' }));
  let called = false;
  await assert.rejects(
    collect(chunkedStream(gv('IOS', '1', 10_000), { ctx: { fetch }, onRefused: () => { called = true; } })),
    (e) => e instanceof HttpError && e.status === 503,
  );
  assert.equal(called, false);
});

test('pass-through refusals are reported too (a dead module URL names itself)', async () => {
  const fetch = mediaServer(makeBytes(10), () => ({ status: 404, body: 'gone' }));
  const refusals = [];
  await assert.rejects(
    collect(chunkedStream('https://cdn.example.org/x.flac', { ctx: { fetch }, onRefused: (u, s) => refusals.push(s) })),
    HttpError,
  );
  assert.deepEqual(refusals, [404]);
});

// ---- servers that ignore Range ------------------------------------------------------------

test('a 200 answer to a Range request is skipped to the position and read to the end, once', async () => {
  const size = 2 * MiB + 1000;
  const bytes = makeBytes(size);
  const ignoresRange = mediaServer(bytes, () => ({ status: 200, body: bytes, headers: { 'content-type': 'audio/webm' } }));
  assert.deepEqual(await collect(chunkedStream(gv('IOS', '1', size), { ctx: { fetch: ignoresRange } })), bytes);
  assert.equal(ignoresRange.calls.length, 1);

  const seek = mediaServer(bytes, () => ({ status: 200, body: bytes, headers: { 'content-type': 'audio/webm' } }));
  const tail = await collect(chunkedStream(gv('IOS', '1', size), { ctx: { fetch: seek }, position: MiB, length: 5000 }));
  assert.deepEqual(tail, bytes.slice(MiB, MiB + 5000));
  assert.equal(seek.calls.length, 1);
});

// ---- consumers ------------------------------------------------------------------------------

test('breaking out early cancels the transfer in flight', async () => {
  let cancelled = false;
  const endless = async () =>
    new Response(
      new ReadableStream({
        pull(controller) { controller.enqueue(new Uint8Array(64 * KiB)); },
        cancel() { cancelled = true; },
      }),
      { status: 206 },
    );
  for await (const piece of chunkedStream(gv('IOS', '1', 10 * MiB), { ctx: { fetch: endless } })) {
    assert.equal(piece.byteLength, 64 * KiB);
    break;
  }
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(cancelled, true);
});

test('chunkedReadableStream yields the same bytes and carries the same metadata', async () => {
  const size = 1_200_000;
  const bytes = makeBytes(size);
  const fetch = mediaServer(bytes);
  const stream = chunkedReadableStream(gv('ANDROID_VR', '1.65.10', size), { ctx: { fetch } });
  assert.equal(stream.rangeBytes, 512 * KiB);
  assert.equal(fetch.calls.length, 0); // pull-driven: nothing is fetched before a read
  const reader = stream.getReader();
  const parts = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
  }
  assert.deepEqual(new Uint8Array(Buffer.concat(parts)), bytes);
  assert.equal(fetch.calls.length, 3);
});

test('bodies without a stream reader (React Native fetch) are read with arrayBuffer()', async () => {
  const size = 700_000;
  const bytes = makeBytes(size);
  const calls = [];
  const rnFetch = async (url, init) => {
    const r = parseRange(init.headers.Range, size);
    calls.push(init.headers.Range);
    const slice = bytes.slice(r.start, r.end + 1);
    return { status: 206, ok: true, body: null, headers: new Headers(), arrayBuffer: async () => slice.buffer, text: async () => '' };
  };
  const got = await collect(chunkedStream(gv('ANDROID_VR', '1.43.32', size), { ctx: { fetch: rnFetch } }));
  assert.deepEqual(got, bytes);
  assert.deepEqual(calls, ['bytes=0-524287', `bytes=524288-${size - 1}`]);
});

test('a request that delivers nothing is abandoned after idleTimeoutMs', async () => {
  const silent = (url, init) =>
    new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true }));
  await assert.rejects(
    collect(chunkedStream(gv('IOS', '1', 5000), { ctx: { fetch: silent }, idleTimeoutMs: 25 })),
    (e) => e.name === 'TimeoutError',
  );
});

test('a body that stalls after its headers is abandoned too (even if fetch ignores its signal)', async () => {
  const stalled = async () => new Response(new ReadableStream({ start() {} }), { status: 206 });
  await assert.rejects(
    collect(chunkedStream(gv('IOS', '1', 5000), { ctx: { fetch: stalled }, idleTimeoutMs: 25 })),
    (e) => e.name === 'TimeoutError',
  );
});

test('the idle timer does not run while the consumer holds a chunk (backpressure is not a stall)', async () => {
  const size = 3 * 64 * KiB;
  const bytes = makeBytes(size);
  const fetch = mediaServer(bytes);
  const got = [];
  for await (const piece of chunkedStream(gv('IOS', '1', size), { ctx: { fetch }, chunkBytes: 64 * KiB, idleTimeoutMs: 20 })) {
    got.push(piece);
    await new Promise((resolve) => setTimeout(resolve, 50)); // a paused player, longer than the idle timeout
  }
  assert.deepEqual(new Uint8Array(Buffer.concat(got)), bytes);
});

test('the caller\'s signal aborts the stream', async () => {
  const controller = new AbortController();
  const silent = (url, init) =>
    new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true }));
  const pending = collect(chunkedStream(gv('IOS', '1', 5000), { ctx: { fetch: silent, signal: controller.signal } }));
  controller.abort(new Error('skipped'));
  await assert.rejects(pending, /skipped/);
});
