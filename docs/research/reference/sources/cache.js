// Caching and request-coalescing primitives for the source layer.
//
// Mirrors BitChord's `data/sources/module/SharedCalls.kt` (one in-flight-or-recent
// answer per key, shared by every caller, run in a scope that outlives them) and
// the bounded maps that sit beside it (`AddonSource.rows`, the QuickJS pool LRU).
//
// Independent JavaScript re-implementation of the mechanism documented in BITCHORD_ENGINE_RESEARCH.md (BitChord itself is GPL-3.0).
//
// Three pieces, deliberately separate:
//
//   ttlLru()       a bounded map whose entries expire. Expired entries are
//                  dropped first when room is needed, then the least recently
//                  used one (the same order StreamChoice.remember uses).
//   singleFlight() coalesces concurrent calls by key. The shared work is started
//                  WITHOUT the caller's AbortSignal, so a caller that gives up
//                  only stops waiting; the request finishes and its answer can
//                  still be cached. That is the whole point of SharedCalls: the
//                  callers above it (bestAcross, the module fan-out) are designed
//                  to abandon losers, and killing a request that already reached
//                  somebody's server is work that server did for nobody.
//   sharedCalls()  the two composed exactly as SharedCalls.kt does: in-flight
//                  work is always joined, completed answers are kept for ttlMs
//                  measured from when the work STARTED, failures are never kept,
//                  and an empty answer is an answer (it is kept).

/** The error an aborted signal rejects with. */
export function abortReason(signal) {
  return signal?.reason ?? new DOMException('This operation was aborted', 'AbortError');
}

/** True for the errors produced by an AbortController or a timeout. */
export function isAbortError(error) {
  return error?.name === 'AbortError' || error?.name === 'TimeoutError';
}

/**
 * `promise`, except that it rejects as soon as `signal` aborts.
 *
 * The underlying work is untouched: this only detaches one waiter from it.
 * A rejection of `promise` that arrives after the abort is swallowed here so it
 * cannot surface as an unhandled rejection.
 * @template T
 * @param {Promise<T>} promise
 * @param {AbortSignal} [signal]
 * @returns {Promise<T>}
 */
export function abortable(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) {
    promise.catch(() => {});
    return Promise.reject(abortReason(signal));
  }
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(abortReason(signal));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

/**
 * A bounded map with per-entry expiry and least-recently-used eviction.
 *
 * An entry is live while `now() - storedAt < ttlMs` (SharedCalls' comparison).
 * `get` refreshes recency but never extends an entry's lifetime.
 *
 * @param {{ max?: number, ttlMs?: number, now?: () => number }} [options]
 */
export function ttlLru({ max = Infinity, ttlMs = Infinity, now = Date.now } = {}) {
  if (!(max > 0)) throw new RangeError('ttlLru: max must be greater than 0');
  /** @type {Map<any, { value: any, expiresAt: number }>} */
  const entries = new Map();

  const purgeExpired = (at = now()) => {
    for (const [key, entry] of entries) if (at >= entry.expiresAt) entries.delete(key);
  };

  return {
    /** The live value for `key`, or undefined. Marks it most recently used. */
    get(key) {
      const entry = entries.get(key);
      if (!entry) return undefined;
      if (now() >= entry.expiresAt) {
        entries.delete(key);
        return undefined;
      }
      // Map iteration order is insertion order, so re-inserting moves the key
      // to the most-recently-used end.
      entries.delete(key);
      entries.set(key, entry);
      return entry.value;
    },

    /** Whether a live value is held for `key`. Does not affect recency. */
    has(key) {
      const entry = entries.get(key);
      if (!entry) return false;
      if (now() >= entry.expiresAt) {
        entries.delete(key);
        return false;
      }
      return true;
    },

    /**
     * Stores `value`. `options.ttlMs` overrides the cache-wide lifetime for this
     * entry (sharedCalls uses it to measure the lifetime from the start of the
     * work rather than from its completion). A lifetime of 0 or less stores
     * nothing.
     */
    set(key, value, { ttlMs: entryTtlMs = ttlMs } = {}) {
      entries.delete(key);
      if (!(entryTtlMs > 0)) return this;
      const at = now();
      entries.set(key, { value, expiresAt: at + entryTtlMs });
      if (entries.size > max) {
        // What can no longer be honoured goes first, and only then the least
        // recently used of what can.
        purgeExpired(at);
        while (entries.size > max) entries.delete(entries.keys().next().value);
      }
      return this;
    },

    delete(key) {
      return entries.delete(key);
    },

    clear() {
      entries.clear();
    },

    /** Live entries, oldest-used first. */
    keys() {
      purgeExpired();
      return [...entries.keys()];
    },

    get size() {
      purgeExpired();
      return entries.size;
    },
  };
}

/**
 * Coalesces concurrent calls by key.
 *
 * `run(key, work, { signal })` starts `work()` if nothing is running for `key`,
 * otherwise joins the running call. `work` receives no signal: it runs to
 * completion whatever its callers do, and `signal` only detaches that caller.
 * Nothing is remembered once the work settles; pair it with a ttlLru (or use
 * sharedCalls) to keep answers.
 */
export function singleFlight() {
  /** @type {Map<any, Promise<any>>} */
  const inFlight = new Map();

  return {
    /**
     * @template T
     * @param {any} key
     * @param {() => T | Promise<T>} work
     * @param {{ signal?: AbortSignal }} [options]
     * @returns {Promise<T>}
     */
    run(key, work, { signal } = {}) {
      let promise = inFlight.get(key);
      if (!promise) {
        // new Promise(...) turns a synchronous throw inside work() into a
        // rejection, so every caller sees the failure the same way.
        promise = new Promise((resolve) => resolve(work()));
        const started = promise;
        inFlight.set(key, started);
        // Removal is by identity: if clear() and a new call replaced this
        // entry, the stale settlement must not remove the newer one. The
        // rejection handler also marks the promise handled, so work that fails
        // after every caller has walked away is not an unhandled rejection.
        const settle = () => {
          if (inFlight.get(key) === started) inFlight.delete(key);
        };
        started.then(settle, settle);
      }
      return abortable(promise, signal);
    },

    /** Whether work for `key` is running right now. */
    isRunning(key) {
      return inFlight.has(key);
    },

    /** Forgets running work without cancelling it (SharedCalls.clear). */
    clear() {
      inFlight.clear();
    },

    get size() {
      return inFlight.size;
    },
  };
}

/** SharedCalls.MAX_ENTRIES (SharedCalls.kt:142). */
export const MAX_SHARED_ENTRIES = 128;

/**
 * SharedCalls.kt: single-flight plus a completed-answer cache.
 *
 *  - In flight: always shared, whatever ttlMs says.
 *  - Completed: kept for ttlMs, measured from when the work started
 *    (`now() - startedAtMs < ttlMs`). ttlMs = 0 means in-flight sharing only.
 *  - A failure (rejection) is never kept, so the next caller asks again.
 *  - An empty answer is kept: "this catalogue does not hold that recording"
 *    is a real answer, and re-asking for it is the waste this exists to stop.
 *
 * One deliberate difference: BitChord bounds in-flight and completed entries in
 * one map and evicts the oldest-started completed entry; here only completed
 * answers are bounded (max) and eviction is least-recently-used.
 *
 * @param {{ ttlMs?: number, max?: number, now?: () => number,
 *           onReuse?: (kind: 'hit' | 'joined', key: any) => void }} [options]
 */
export function sharedCalls({ ttlMs = 0, max = MAX_SHARED_ENTRIES, now = Date.now, onReuse } = {}) {
  const answers = ttlLru({ max, ttlMs: Math.max(ttlMs, 0), now });
  const flight = singleFlight();

  return {
    /**
     * @template T
     * @param {any} key
     * @param {() => Promise<T>} produce
     * @param {{ signal?: AbortSignal }} [options]
     * @returns {Promise<T>}
     */
    get(key, produce, { signal } = {}) {
      const held = answers.get(key);
      if (held) {
        onReuse?.('hit', key);
        return abortable(Promise.resolve(held.value), signal);
      }
      if (flight.isRunning(key)) onReuse?.('joined', key);
      const startedAt = now();
      return flight.run(
        key,
        async () => {
          const value = await produce();
          const left = ttlMs - (now() - startedAt);
          if (left > 0) answers.set(key, { value }, { ttlMs: left });
          return value;
        },
        { signal },
      );
    },

    /** Everything held, dropped (the configuration it was about is gone). */
    clear() {
      answers.clear();
      flight.clear();
    },

    /** Completed answers dropped; work already on the wire is still joined. */
    clearCompleted() {
      answers.clear();
    },

    get size() {
      return answers.size + flight.size;
    },
  };
}
