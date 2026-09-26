// Tests for sources/cache.js (mirrors data/sources/module/SharedCalls.kt; the
// SharedCalls cases follow app/src/test/.../SharedCallsTest.kt).
// Independent JavaScript re-implementation of the mechanism documented in BITCHORD_ENGINE_RESEARCH.md (BitChord itself is GPL-3.0).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { abortable, isAbortError, sharedCalls, singleFlight, ttlLru } from '../sources/cache.js';

const tick = () => new Promise((resolve) => setImmediate(resolve));

/** A promise with its resolve/reject handles (Promise.withResolvers is Node 22+). */
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// ── ttlLru ──────────────────────────────────────────────────────────────────

test('ttlLru: get, set, has, delete, clear', () => {
  const cache = ttlLru({ max: 10 });
  assert.equal(cache.get('a'), undefined);
  cache.set('a', 1).set('b', 2);
  assert.equal(cache.get('a'), 1);
  assert.equal(cache.has('b'), true);
  assert.equal(cache.delete('b'), true);
  assert.equal(cache.has('b'), false);
  assert.equal(cache.size, 1);
  cache.clear();
  assert.equal(cache.size, 0);
});

test('ttlLru: an entry is live while now - storedAt < ttlMs', () => {
  let clock = 0;
  const cache = ttlLru({ ttlMs: 1_000, now: () => clock });
  cache.set('q', 'answer');
  clock = 999;
  assert.equal(cache.get('q'), 'answer');
  clock = 1_000;
  assert.equal(cache.get('q'), undefined);
  assert.equal(cache.size, 0);
});

test('ttlLru: get refreshes recency but never extends the lifetime', () => {
  let clock = 0;
  const cache = ttlLru({ ttlMs: 100, now: () => clock });
  cache.set('a', 1);
  clock = 90;
  assert.equal(cache.get('a'), 1);
  clock = 101;
  assert.equal(cache.get('a'), undefined);
});

test('ttlLru: the least recently used entry is evicted first', () => {
  const cache = ttlLru({ max: 3 });
  cache.set('a', 1).set('b', 2).set('c', 3);
  cache.get('a'); // a is now the most recently used
  cache.set('d', 4);
  assert.deepEqual(cache.keys(), ['c', 'a', 'd']);
  assert.equal(cache.has('b'), false);
});

test('ttlLru: expired entries are dropped before any live one is evicted', () => {
  let clock = 0;
  const cache = ttlLru({ max: 2, ttlMs: 1_000, now: () => clock });
  cache.set('old', 1, { ttlMs: 10 }); // per-entry lifetime
  cache.set('live', 2);
  clock = 50;
  cache.set('new', 3);
  assert.deepEqual(cache.keys(), ['live', 'new']);
});

test('ttlLru: a lifetime of zero stores nothing', () => {
  const cache = ttlLru({ ttlMs: 0 });
  cache.set('a', 1);
  assert.equal(cache.has('a'), false);
});

// ── singleFlight ────────────────────────────────────────────────────────────

test('singleFlight: concurrent calls for one key share one execution', async () => {
  const flight = singleFlight();
  const gate = deferred();
  let calls = 0;
  const work = async () => {
    calls++;
    await gate.promise;
    return 'flac';
  };
  const waiters = [flight.run('q', work), flight.run('q', work), flight.run('q', work)];
  assert.equal(flight.isRunning('q'), true);
  gate.resolve();
  assert.deepEqual(await Promise.all(waiters), ['flac', 'flac', 'flac']);
  assert.equal(calls, 1);
  assert.equal(flight.isRunning('q'), false);
});

test('singleFlight: different keys do not share', async () => {
  const flight = singleFlight();
  let calls = 0;
  await Promise.all([flight.run('a', async () => ++calls), flight.run('b', async () => ++calls)]);
  assert.equal(calls, 2);
});

test('singleFlight: nothing is remembered after the work settles', async () => {
  const flight = singleFlight();
  let calls = 0;
  await flight.run('q', async () => ++calls);
  await flight.run('q', async () => ++calls);
  assert.equal(calls, 2);
});

test('singleFlight: a caller that aborts stops waiting; the shared work keeps running', async () => {
  const flight = singleFlight();
  const gate = deferred();
  let finished = false;
  const work = async () => {
    await gate.promise;
    finished = true;
    return 'flac';
  };
  const quitter = new AbortController();
  const abandoned = flight.run('q', work, { signal: quitter.signal });
  const patient = flight.run('q', work);
  quitter.abort();
  await assert.rejects(abandoned, (error) => isAbortError(error));
  assert.equal(finished, false);
  gate.resolve();
  assert.equal(await patient, 'flac');
  assert.equal(finished, true);
});

test('singleFlight: a failure reaches every waiter and is not retained', async () => {
  const flight = singleFlight();
  let calls = 0;
  const failing = async () => {
    calls++;
    throw new Error('server having a bad minute');
  };
  const results = await Promise.allSettled([flight.run('q', failing), flight.run('q', failing)]);
  assert.deepEqual(results.map((r) => r.status), ['rejected', 'rejected']);
  assert.equal(calls, 1);
  await assert.rejects(flight.run('q', failing));
  assert.equal(calls, 2);
});

test('singleFlight: work that fails after every caller left is not an unhandled rejection', async () => {
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  try {
    const flight = singleFlight();
    const gate = deferred();
    const quitter = new AbortController();
    const waiter = flight.run(
      'q',
      async () => {
        await gate.promise;
        throw new Error('late failure');
      },
      { signal: quitter.signal },
    );
    quitter.abort();
    await assert.rejects(waiter);
    gate.resolve();
    await tick();
    await tick();
    assert.deepEqual(unhandled, []);
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});

test('singleFlight: a synchronous throw inside work is a rejection', async () => {
  const flight = singleFlight();
  await assert.rejects(
    flight.run('q', () => {
      throw new Error('sync');
    }),
    /sync/,
  );
});

test('abortable: an already-aborted signal rejects at once', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(abortable(new Promise(() => {}), controller.signal), (error) => isAbortError(error));
});

// ── sharedCalls (SharedCallsTest.kt) ────────────────────────────────────────

test('sharedCalls: a repeated question inside the window costs one call', async () => {
  const shared = sharedCalls({ ttlMs: 60_000 });
  let calls = 0;
  for (let i = 0; i < 5; i++) {
    assert.equal(
      await shared.get('q', async () => {
        calls++;
        return 'flac';
      }),
      'flac',
    );
  }
  assert.equal(calls, 1);
});

test('sharedCalls: an empty answer is kept, because it is an answer', async () => {
  const shared = sharedCalls({ ttlMs: 60_000 });
  let calls = 0;
  for (let i = 0; i < 3; i++) {
    await shared.get('missing', async () => {
      calls++;
      return [];
    });
  }
  assert.equal(calls, 1);
});

test('sharedCalls: a failure is not kept', async () => {
  const shared = sharedCalls({ ttlMs: 60_000 });
  let calls = 0;
  for (let i = 0; i < 3; i++) {
    await assert.rejects(
      shared.get('q', async () => {
        calls++;
        throw new Error('bad minute');
      }),
    );
  }
  assert.equal(calls, 3);
});

test('sharedCalls: an expired answer is asked again; the window runs from the start of the work', async () => {
  let clock = 0;
  const shared = sharedCalls({ ttlMs: 1_000, now: () => clock });
  let calls = 0;
  const produce = async () => {
    calls++;
    clock += 400; // the work itself takes 400 ms of the window
    return 'a';
  };
  await shared.get('q', produce);
  clock = 999;
  await shared.get('q', produce);
  assert.equal(calls, 1);
  clock = 1_000;
  await shared.get('q', produce);
  assert.equal(calls, 2);
});

test('sharedCalls: callers arriving mid-flight share the one call even with ttl 0', async () => {
  const reuse = [];
  const shared = sharedCalls({ ttlMs: 0, onReuse: (kind) => reuse.push(kind) });
  const gate = deferred();
  let calls = 0;
  const produce = async () => {
    calls++;
    await gate.promise;
    return 'flac';
  };
  const waiters = [0, 1, 2, 3].map(() => shared.get('q', produce));
  gate.resolve();
  assert.deepEqual(await Promise.all(waiters), ['flac', 'flac', 'flac', 'flac']);
  assert.equal(calls, 1);
  assert.deepEqual(reuse, ['joined', 'joined', 'joined']);
  // ttl 0: nothing kept once complete.
  await shared.get('q', produce);
  assert.equal(calls, 2);
});

test('sharedCalls: a cancelled caller does not kill the call; its answer lands in the cache', async () => {
  const shared = sharedCalls({ ttlMs: 60_000 });
  const gate = deferred();
  let calls = 0;
  const quitter = new AbortController();
  const abandoned = shared.get(
    'q',
    async () => {
      calls++;
      await gate.promise;
      return 'flac';
    },
    { signal: quitter.signal },
  );
  quitter.abort();
  await assert.rejects(abandoned);
  gate.resolve();
  await tick();
  assert.equal(await shared.get('q', async () => 'never asked'), 'flac');
  assert.equal(calls, 1);
});

test('sharedCalls: clearCompleted drops answers but keeps work already in flight', async () => {
  const shared = sharedCalls({ ttlMs: 60_000 });
  let calls = 0;
  await shared.get('done', async () => `answer-${++calls}`);
  const gate = deferred();
  const running = shared.get('running', async () => {
    calls++;
    await gate.promise;
    return 'flac';
  });
  shared.clearCompleted();
  const joined = shared.get('running', async () => 'duplicate');
  gate.resolve();
  assert.equal(await running, 'flac');
  assert.equal(await joined, 'flac');
  assert.equal(await shared.get('done', async () => `answer-${++calls}`), 'answer-3');
});

test('sharedCalls: held answers stay bounded', async () => {
  const shared = sharedCalls({ ttlMs: 60_000 });
  for (let i = 0; i < 400; i++) await shared.get(`q${i}`, async () => 'a');
  assert.ok(shared.size <= 128, `held ${shared.size}`);
});
