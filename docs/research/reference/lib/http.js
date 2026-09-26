// Small HTTP helpers shared by the reference implementations.
//
// Every network call takes a context `{ fetch, signal }` instead of using the
// global directly, so tests can inject a fake and React Native / browsers can
// supply their own. Timeouts are layered on top of the caller's signal.

/** @typedef {{ fetch?: typeof fetch, signal?: AbortSignal }} Ctx */

export class HttpError extends Error {
  constructor(status, url, body = '') {
    super(`HTTP ${status} for ${url}`);
    this.status = status;
    this.url = url;
    this.body = body;
  }
}

/** Combine the caller's signal with a timeout. Works where AbortSignal.any is missing. */
export function timeoutSignal(parent, timeoutMs) {
  const controller = new AbortController();
  const onAbort = () => controller.abort(parent.reason);
  if (parent) {
    if (parent.aborted) controller.abort(parent.reason);
    else parent.addEventListener('abort', onAbort, { once: true });
  }
  const timer = timeoutMs > 0
    ? setTimeout(() => controller.abort(new Error(`timeout after ${timeoutMs} ms`)), timeoutMs)
    : null;
  const done = () => {
    if (timer) clearTimeout(timer);
    if (parent) parent.removeEventListener('abort', onAbort);
  };
  return { signal: controller.signal, done };
}

/**
 * fetch() with a timeout and a status check.
 * @param {Ctx} ctx
 * @param {string} url
 * @param {RequestInit & { timeoutMs?: number, okStatuses?: number[] }} [init]
 * @returns {Promise<Response>}
 */
export async function request(ctx, url, init = {}) {
  const f = ctx?.fetch ?? globalThis.fetch;
  const { timeoutMs = 10_000, okStatuses, ...rest } = init;
  const { signal, done } = timeoutSignal(ctx?.signal, timeoutMs);
  try {
    const res = await f(url, { ...rest, signal });
    const ok = okStatuses ? okStatuses.includes(res.status) : res.ok;
    if (!ok) {
      const body = await res.text().catch(() => '');
      throw new HttpError(res.status, url, body);
    }
    return res;
  } finally {
    done();
  }
}

export async function getJson(ctx, url, init = {}) {
  const res = await request(ctx, url, init);
  return res.json();
}

export async function getText(ctx, url, init = {}) {
  const res = await request(ctx, url, init);
  return res.text();
}

/** Build a query string, skipping null/undefined values. */
export function qs(params) {
  const search = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) search.append(k, String(v));
  }
  return search.toString();
}

/**
 * A fake fetch for tests: routes by predicate, returns canned bodies.
 * @param {Array<[ (url: string, init: RequestInit) => boolean, (url: string, init: RequestInit) => ({status?: number, body: any, headers?: Record<string,string>}) ]>} routes
 */
export function fakeFetch(routes) {
  const calls = [];
  const impl = async (url, init = {}) => {
    const u = String(url);
    calls.push({ url: u, init });
    for (const [match, respond] of routes) {
      if (match(u, init)) {
        const { status = 200, body, headers = {} } = respond(u, init);
        const payload = typeof body === 'string' || body instanceof Uint8Array ? body : JSON.stringify(body);
        return new Response(payload, { status, headers });
      }
    }
    return new Response('not found', { status: 404 });
  };
  impl.calls = calls;
  return impl;
}
