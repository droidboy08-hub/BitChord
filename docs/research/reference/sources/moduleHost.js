// JavaScript "module" sources: third-party JS files that export
// searchTracks(query, limit, context) and getTrackStreamUrl(id, quality, context),
// loaded into isolated engines that stay resident between calls.
//
// Mirrors BitChord's
//   data/sources/module/QuickJsExecutor.kt   engine pool (12 modules x 3 engines), console,
//                                            the __spine.fetch bridge, polyfills, export
//                                            stripping, the call protocol
//   data/sources/module/ModuleManager.kt     index/load/search/stream calls, SharedCalls,
//                                            the `context` argument
//   data/sources/module/ModuleResults.kt     result shapes
//   data/sources/module/SpineModule.kt,
//   data/sources/module/ModuleIndex.kt       the index format
//   data/sources/ModuleSource.kt             fan-out search, stream mapping, lossless
//                                            detection, fallbackMode
//
// Independent JavaScript re-implementation of the mechanism documented in BITCHORD_ENGINE_RESEARCH.md (BitChord itself is GPL-3.0).
//
// SECURITY: node:vm is NOT a security sandbox. Code in a vm context can reach
// the host realm through any host function it is handed (here: the bridges),
// e.g. via `.constructor.constructor`. Only load modules you would run with
// full Node privileges. BitChord runs modules in QuickJS, an interpreter with
// its own heap; a React Native port would likewise use a JS-engine binding
// such as QuickJS (react-native-quickjs, quickjs-emscripten) or a separate
// Hermes runtime, not the app's own JS context. This file shows the contract
// and the host mechanics, not a sandbox.
//
// A module promise that rejects with no handler (say, an eager token fetch
// nobody awaits) surfaces as the host process's 'unhandledRejection', which
// crashes Node by default; QuickJS simply drops it. Modules should catch.
//
// Deliberate differences from BitChord, each fixing something the paper or
// this port found:
//   - Arguments reach a module as JSON values, never spliced into source text
//     (defect S1: an artist containing `"` or `\` broke, or injected into, the call).
//   - A module that throws (the `{ error }` answer) is a failure and is NOT
//     cached. BitChord parses that answer as an empty success and caches it for
//     10 min (search) / 5 min (stream).
//   - The search fan-out stops waiting once every module has answered. BitChord
//     waits the full 8 s budget when all modules answer with nothing.
//   - Names declared with ES `export` are collected into module.exports when the
//     module did not assign them (option collectEsExports, default true);
//     BitChord strips `export` and loses such names, so an ESM-only module loads
//     with no exports at all.
//   - The fetch bridge is async, cancellable on unload, returns response headers
//     and respects a module's own Content-Type (BitChord forces JSON; paper S5).

import vm from 'node:vm';
import { getText, timeoutSignal } from '../lib/http.js';
import { sharedCalls } from './cache.js';
import { formatSummary, malformed, qualityTier, requestTier, SOURCE_KINDS, unplayable } from './resolve.js';

// ── Constants ───────────────────────────────────────────────────────────────

/** Modules kept resident, LRU (QuickJsExecutor.kt:71). */
export const MAX_MODULES = 12;
/** Engines per module, grown lazily (QuickJsExecutor.kt:83). */
export const ENGINES_PER_MODULE = 3;
/** ModuleManager.kt:395, 407, 422. */
export const INDEX_TTL_MS = 10 * 60 * 1000;
export const SEARCH_TTL_MS = 10 * 60 * 1000;
export const STREAM_TTL_MS = 5 * 60 * 1000;
/** Fan-out budgets (ModuleSource.kt:571-593). */
export const SEARCH_BUDGET_MS = 8_000;
export const SEARCH_GRACE_MS = 2_500;
export const SEARCH_PATIENT_MS = 25_000;
export const SEARCH_PATIENT_GRACE_MS = 8_000;
/** `<moduleId>::<upstreamId>` (ModuleSource.kt:601). */
export const MOD_SEPARATOR = '::';
/** Worst to best (ModuleSource.kt:531). */
export const TIERS = Object.freeze(['LOW', 'HIGH', 'LOSSLESS']);
/** Extensions believed as a codec when nothing else said (ModuleSource.kt:559-560). */
export const AUDIO_EXTENSIONS = Object.freeze(
  new Set(['flac', 'alac', 'wav', 'aiff', 'mp3', 'm4a', 'aac', 'ogg', 'opus', 'webm']),
);
/** The User-Agent the bridge sends when a module sets none (QuickJsExecutor.kt:496-500). */
export const DEFAULT_MODULE_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
/** BitChord's module HTTP client: 20 s connect and read timeouts (applied here to the whole call). */
export const MODULE_FETCH_TIMEOUT_MS = 20_000;
const EXCLUDED_CATEGORIES = new Set(['category:artworks', 'category:testing']);
const KBPS_LABEL = /(\d{2,4})\s*kbps/i;
const KBPS_URL = /\.(\d{2,4})\.(?:mp3|m4a|aac|ogg)/i;

const noop = () => {};
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const str = (value, fallback = '') =>
  typeof value === 'string' ? value : typeof value === 'number' || typeof value === 'boolean' ? String(value) : fallback;
const optStr = (value) => (value == null ? null : str(value, null));
const blankToNull = (value) => (value == null || String(value).trim() === '' ? null : value);
function num(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value);
  return null;
}
const int = (value) => {
  const n = num(value);
  return n == null ? null : Math.trunc(n);
};
const keyOf = (...parts) => parts.map((part) => `${part.length}:${part}`).join('|');

/** A failure reported by the module itself (the `{ error }` answer). */
export class ModuleError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ModuleError';
  }
}

// ── Code preprocessing (QuickJsExecutor.preprocessModuleCode) ──────────────

const TEMPLATE_EXPORT = /^export\s+const\s+\w+\s*=\s*`/;
const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

/**
 * Strips ES `export` keywords so the code can run as a function body, as
 * BitChord does, and lists the names those keywords exported.
 *
 * Two forms: `export const x = \`...code...\`` (a module shipped inside a
 * template literal) returns the literal's raw content untouched; anything else
 * gets BitChord's three regex passes. The passes are textual, so they also
 * apply inside comments and strings.
 *
 * @returns {{ code: string, exportNames: Array<{ local: string, exported: string }> }}
 */
export function preprocessModuleCode(jsCode) {
  const code = String(jsCode).trim();
  const template = TEMPLATE_EXPORT.exec(code);
  if (template) {
    const start = template[0].length;
    for (let i = start; i < code.length; i++) {
      if (code[i] === '\\' && i + 1 < code.length) {
        i++;
        continue;
      }
      if (code[i] === '`') return { code: code.slice(start, i).trim(), exportNames: [] };
    }
    // Not closed: fall through to the regex passes, like BitChord.
  }
  const exportNames = collectExportNames(code);
  const stripped = code
    .replace(/\bexport\s+default\s+(?=function|class|const|let|var|async)/g, '')
    .replace(/\bexport\s+(const|let|var|function|class|async)\b/g, '$1')
    .replace(/\bexport\s*\{[^}]*\}\s*;?/g, '');
  return { code: stripped, exportNames };
}

function collectExportNames(code) {
  const names = [];
  const add = (local, exported = local) => {
    if (IDENTIFIER.test(local) && IDENTIFIER.test(exported) && exported !== 'default') names.push({ local, exported });
  };
  for (const m of code.matchAll(/\bexport\s+(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/g)) add(m[1]);
  for (const m of code.matchAll(/\bexport\s+(?:default\s+)?class\s+([A-Za-z_$][\w$]*)/g)) add(m[1]);
  for (const m of code.matchAll(/\bexport\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)) add(m[1]);
  for (const m of code.matchAll(/\bexport\s*\{([^}]*)\}/g)) {
    for (const part of m[1].split(',')) {
      const [local, exported] = part.trim().split(/\s+as\s+/);
      if (local) add(local.trim(), (exported ?? local).trim());
    }
  }
  return names;
}

// ── The engine's global surface ────────────────────────────────────────────
//
// Evaluated into every new context before the module. The same names BitChord
// defines, written independently: console.{log,info,warn,error}, an async
// __spine bridge (fetch, setTimeout, clearTimeout), fetch()/setTimeout()/
// clearTimeout() wrappers, and guarded polyfills for AbortController,
// Object.assign, Promise.any/allSettled, AggregateError, atob and URL.
// Only strings and numbers cross the host boundary.

const PRELUDE = String.raw`
var __spine = {
  fetch: __spine_fetch_bridge,
  setTimeout: __spine_sleep_bridge,
  clearTimeout: __spine_wake_bridge
};
var __spine_log = __spine_log_bridge;
delete globalThis.__spine_fetch_bridge;
delete globalThis.__spine_sleep_bridge;
delete globalThis.__spine_wake_bridge;
delete globalThis.__spine_log_bridge;

var console = (function () {
  function line(args) {
    var parts = [];
    for (var i = 0; i < args.length; i++) {
      try { parts.push(String(args[i])); } catch (e) { parts.push('[unprintable]'); }
    }
    return parts.join(' ');
  }
  function level(name) { return function () { __spine_log(name, line(arguments)); }; }
  return { log: level('log'), info: level('info'), warn: level('warn'), error: level('error'), debug: level('debug') };
})();

// fetch(): the web surface a module expects, over the text-only bridge.
// json() and text() return values, not promises; 'await res.json()' works either way.
var fetch = async function (url, options) {
  var method = 'GET';
  var headers = '{}';
  var body = null;
  if (options) {
    method = options.method || 'GET';
    if (options.headers) {
      if (typeof options.headers === 'string') headers = options.headers;
      else { try { headers = JSON.stringify(options.headers); } catch (e) { headers = '{}'; } }
    }
    if (options.body !== undefined && options.body !== null) {
      body = typeof options.body === 'string' ? options.body : JSON.stringify(options.body);
    }
    if (options.signal && options.signal.aborted) throw new Error('Aborted');
  }
  var raw = JSON.parse(await __spine.fetch(String(url), String(method), headers, body));
  var text = raw.body;
  var received = raw.headers || {};
  return {
    ok: raw.ok,
    status: raw.status,
    statusText: raw.ok ? 'OK' : 'Error',
    url: raw.url,
    json: function () {
      try { return JSON.parse(text); } catch (e) { throw new Error('Invalid JSON: ' + text.substring(0, 200)); }
    },
    text: function () { return text; },
    arrayBuffer: function () { throw new Error('Not implemented'); },
    clone: function () { return this; },
    headers: { get: function (name) { var v = received[String(name).toLowerCase()]; return v === undefined ? null : v; } }
  };
};

// setTimeout() resolves (as a promise) after the callback ran, as in BitChord,
// and the returned handle can be passed to clearTimeout(), which BitChord ignores.
var __spine_timer_seq = 0;
var setTimeout = function (callback, ms) {
  var id = ++__spine_timer_seq;
  var extra = Array.prototype.slice.call(arguments, 2);
  var handle = new Promise(function (resolve, reject) {
    __spine.setTimeout(id, Number(ms) || 0).then(function (outcome) {
      try {
        if (outcome === 'fired' && typeof callback === 'function') callback.apply(undefined, extra);
        resolve(0);
      } catch (e) { reject(e); }
    });
  });
  handle.catch(function (e) { console.error('timer callback failed: ' + (e && e.message ? e.message : e)); });
  handle.__spine_timer = id;
  return handle;
};
var clearTimeout = function (handle) {
  var id = handle !== null && typeof handle === 'object' ? handle.__spine_timer : handle;
  if (typeof id === 'number') __spine.clearTimeout(id);
};

if (typeof AbortController === 'undefined') {
  var AbortController = function () {
    var listeners = [];
    var signal = {
      aborted: false,
      reason: undefined,
      onabort: null,
      addEventListener: function (type, fn) { if (type === 'abort' && typeof fn === 'function') listeners.push(fn); },
      removeEventListener: function (type, fn) { var i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1); },
      throwIfAborted: function () { if (signal.aborted) throw signal.reason; }
    };
    this.signal = signal;
    this.abort = function (reason) {
      if (signal.aborted) return;
      signal.aborted = true;
      signal.reason = reason === undefined ? new Error('Aborted') : reason;
      var event = { type: 'abort', target: signal };
      if (typeof signal.onabort === 'function') signal.onabort(event);
      listeners.slice().forEach(function (fn) { fn(event); });
    };
  };
}

if (typeof Object.assign !== 'function') {
  Object.assign = function (target) {
    if (target == null) throw new TypeError('Cannot convert undefined or null to object');
    var to = Object(target);
    for (var i = 1; i < arguments.length; i++) {
      var source = arguments[i];
      if (source == null) continue;
      for (var key in source) if (Object.prototype.hasOwnProperty.call(source, key)) to[key] = source[key];
    }
    return to;
  };
}

if (typeof AggregateError === 'undefined') {
  var AggregateError = function (errors, message) {
    this.errors = Array.prototype.slice.call(errors || []);
    this.message = message || '';
    this.name = 'AggregateError';
  };
  AggregateError.prototype = Object.create(Error.prototype);
}

if (typeof Promise.allSettled !== 'function') {
  Promise.allSettled = function (items) {
    return Promise.all(Array.prototype.map.call(items, function (item) {
      return Promise.resolve(item).then(
        function (value) { return { status: 'fulfilled', value: value }; },
        function (reason) { return { status: 'rejected', reason: reason }; }
      );
    }));
  };
}

if (typeof Promise.any !== 'function') {
  Promise.any = function (items) {
    var list = Array.prototype.slice.call(items);
    return new Promise(function (resolve, reject) {
      var errors = new Array(list.length);
      var left = list.length;
      if (left === 0) { reject(new AggregateError([], 'All promises were rejected')); return; }
      list.forEach(function (item, i) {
        Promise.resolve(item).then(resolve, function (error) {
          errors[i] = error;
          if (--left === 0) reject(new AggregateError(errors, 'All promises were rejected'));
        });
      });
    });
  };
}

if (typeof atob === 'undefined') {
  var atob = function (input) {
    var alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    var text = String(input).replace(/[\t\n\f\r ]+/g, '').replace(/=+$/, '');
    if (text.length % 4 === 1 || /[^A-Za-z0-9+\/]/.test(text)) throw new Error('atob: invalid base64');
    var out = '';
    var buffer = 0;
    var bits = 0;
    for (var i = 0; i < text.length; i++) {
      buffer = ((buffer << 6) | alphabet.indexOf(text.charAt(i))) & 0xffffff;
      bits += 6;
      if (bits >= 8) {
        bits -= 8;
        out += String.fromCharCode((buffer >> bits) & 0xff);
      }
    }
    return out;
  };
}

// URL: a small parser. BitChord's polyfill fills in only href, hostname and
// pathname; this one also fills protocol, host, port, search, hash and origin,
// and, like BitChord's, never throws.
if (typeof URL === 'undefined') {
  var URL = function (url, base) {
    var input = String(url);
    if (base !== undefined && !/^[A-Za-z][A-Za-z0-9+.\-]*:/.test(input)) {
      var root = new URL(base);
      input = input.charAt(0) === '/'
        ? root.origin + input
        : root.origin + root.pathname.replace(/[^\/]*$/, '') + input;
    }
    this.href = input;
    var m = /^([A-Za-z][A-Za-z0-9+.\-]*:)(?:\/\/(?:[^@\/?#]*@)?(\[[^\]]*\]|[^\/?#:]*)(?::(\d*))?)?([^?#]*)(\?[^#]*)?(#.*)?$/.exec(input);
    this.protocol = m ? m[1].toLowerCase() : '';
    this.hostname = m && m[2] ? m[2].toLowerCase() : '';
    this.port = m && m[3] ? m[3] : '';
    this.host = this.hostname + (this.port ? ':' + this.port : '');
    this.pathname = m ? (m[4] || '/') : '';
    this.search = m && m[5] && m[5] !== '?' ? m[5] : '';
    this.hash = m && m[6] && m[6] !== '#' ? m[6] : '';
    this.origin = this.protocol + '//' + this.host;
  };
  URL.prototype.toString = function () { return this.href; };
  URL.prototype.toJSON = function () { return this.href; };
}

// What the module's code runs inside: a function with module, exports and self
// in scope; module.exports is kept only if it has one of the two exports.
var __spine_mod = {};
var __spine_iife_error = null;
function __spine_init(factory) {
  var module = { exports: {} };
  var self = {};
  try {
    var collected = factory(module, module.exports, self) || [];
    var target = module.exports;
    if (target !== null && (typeof target === 'object' || typeof target === 'function')) {
      for (var i = 0; i < collected.length; i++) {
        var name = collected[i][0];
        var value = collected[i][1];
        if (value !== undefined && !(name in target)) target[name] = value;
      }
    }
    __spine_mod = target && (target.searchTracks || target.getTrackStreamUrl) ? target : {};
  } catch (e) {
    __spine_iife_error = e && e.message ? e.message : String(e);
    __spine_mod = {};
  }
}

function __spine_has(name) { return typeof __spine_mod[name] === 'function'; }

// One export call. Arguments arrive as one JSON string and are parsed here, so
// nothing a caller passes is ever compiled as code. The answer leaves as JSON.
var __spine_call = async function (name, argsJson) {
  var fn = __spine_mod[name];
  if (typeof fn !== 'function') return JSON.stringify({ error: name + ' not found' });
  try {
    var result = await fn.apply(undefined, JSON.parse(argsJson));
    return typeof result === 'string' ? result : JSON.stringify(result);
  } catch (e) {
    return JSON.stringify({ error: e && e.message ? e.message : String(e) });
  }
};
`;

/** QuickJsExecutor.resolveUrl: absolute as is; '/x' against the base's origin; 'x' against the base. */
export function resolveModuleUrl(url, base) {
  if (url.startsWith('http://') || url.startsWith('https://')) return url;
  if (base === '') return url;
  if (url.startsWith('/')) {
    const cut = base.indexOf('://');
    const scheme = cut < 0 ? base : base.slice(0, cut);
    const rest = cut < 0 ? base : base.slice(cut + 3);
    const slash = rest.indexOf('/');
    return `${scheme}://${slash < 0 ? rest : rest.slice(0, slash)}${url}`;
  }
  return `${base}/${url}`;
}

// ── The host (QuickJsExecutor) ─────────────────────────────────────────────

/**
 * Keeps module engines resident: up to `maxModules` modules (least recently
 * used evicted), each with up to `enginesPerModule` independent contexts,
 * grown lazily and handed to one caller at a time.
 *
 * @param {{ fetch?: typeof fetch, maxModules?: number, enginesPerModule?: number,
 *           fetchTimeoutMs?: number, loadTimeoutMs?: number, collectEsExports?: boolean,
 *           log?: (line: string) => void }} [options]
 */
export function createModuleHost(options = {}) {
  const {
    fetch: fetchImpl = globalThis.fetch,
    maxModules = MAX_MODULES,
    enginesPerModule = ENGINES_PER_MODULE,
    fetchTimeoutMs = MODULE_FETCH_TIMEOUT_MS,
    loadTimeoutMs = 5_000,
    collectEsExports = true,
    log = noop,
  } = options;

  /** moduleId → pool; Map order doubles as the LRU order. */
  const pools = new Map();

  /** The module's HTTP bridge (QuickJsExecutor.bindAsyncFetch + fetchUrlSync). */
  async function bridgeFetch(engine, fetchBase, rawUrl, method, headersJson, body) {
    if (rawUrl == null) throw new Error('fetch requires a URL');
    const url = resolveModuleUrl(String(rawUrl), fetchBase);
    const headers = {};
    let hasUserAgent = false;
    let hasContentType = false;
    try {
      const declared = JSON.parse(headersJson ?? '{}');
      if (isObject(declared)) {
        for (const [key, value] of Object.entries(declared)) {
          if (typeof value === 'string') headers[key] = value;
          else if (value !== null && typeof value === 'object') headers[key] = JSON.stringify(value);
          else headers[key] = String(value);
          if (key.toLowerCase() === 'user-agent') hasUserAgent = true;
          if (key.toLowerCase() === 'content-type') hasContentType = true;
        }
      }
    } catch {
      // Malformed header JSON is ignored, as in BitChord.
    }
    if (!hasUserAgent) headers['User-Agent'] = DEFAULT_MODULE_USER_AGENT;
    const verb = String(method ?? 'GET').toUpperCase();
    const init = { method: 'GET', headers };
    if (verb === 'POST' || verb === 'PUT') {
      init.method = verb;
      init.body = body ?? '';
      if (!hasContentType) headers['Content-Type'] = 'application/json; charset=utf-8';
    } else if (verb === 'DELETE' || verb === 'HEAD') {
      init.method = verb;
    } // every other verb goes out as GET, as in BitChord

    log(`  → fetch ${init.method} ${url}`);
    const { signal, done } = timeoutSignal(engine.lifetime.signal, fetchTimeoutMs);
    try {
      const response = await fetchImpl(url, { ...init, signal });
      const text = init.method === 'HEAD' ? '' : await response.text();
      const received = {};
      response.headers.forEach((value, key) => {
        received[key.toLowerCase()] = value;
      });
      log(`    HTTP ${response.status} (${text.length} chars)`);
      return JSON.stringify({
        status: response.status,
        ok: response.status >= 200 && response.status <= 299,
        body: text,
        headers: received,
        url: response.url || url,
      });
    } finally {
      done();
    }
  }

  function bridgeSleep(engine, id, ms) {
    const delay = Math.max(0, Number(ms) || 0);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        engine.timers.delete(id);
        resolve('fired');
      }, delay);
      if (id != null) engine.timers.set(id, { timer, resolve });
    });
  }

  function bridgeWake(engine, id) {
    const pending = engine.timers.get(id);
    if (pending) {
      clearTimeout(pending.timer);
      engine.timers.delete(id);
      pending.resolve('cleared');
    }
    return 'ok';
  }

  /** A fresh context with the module evaluated into it, or a throw saying why not. */
  function newEngine(moduleId, jsCode, fetchBase) {
    const engine = {
      timers: new Map(),
      lifetime: new AbortController(),
      closed: false,
      context: null,
      call: null,
      has: null,
    };
    const sandbox = {
      __spine_fetch_bridge: (url, method, headersJson, body) =>
        bridgeFetch(engine, fetchBase, url, method, headersJson, body),
      __spine_sleep_bridge: (id, ms) => bridgeSleep(engine, id, ms),
      __spine_wake_bridge: (id) => bridgeWake(engine, id),
      __spine_log_bridge: (level, text) => log(`[JS${level === 'log' ? '' : `-${String(level).toUpperCase()}`}] ${text}`),
    };
    const context = vm.createContext(sandbox, { name: `module:${moduleId}` });
    try {
      vm.runInContext(PRELUDE, context, { filename: 'bitchord-module-prelude.js' });

      const { code, exportNames } = preprocessModuleCode(jsCode);
      // Names were validated as identifiers, so splicing them is safe.
      const collect = (collectEsExports ? exportNames : [])
        .map(
          ({ local, exported }) =>
            `[${JSON.stringify(exported)}, typeof ${local} === 'undefined' ? undefined : ${local}]`,
        )
        .join(', ');
      // Compiled as a function body in the context: the module's own code is
      // meant to run, so this is the one place text becomes code. Arguments to
      // later calls never are.
      const factory = vm.compileFunction(`${code}\n;return [${collect}];`, ['module', 'exports', 'self'], {
        parsingContext: context,
        filename: `${moduleId}.js`,
      });
      sandbox.__spine_factory = factory;
      // The timeout bounds the module's synchronous top level (QuickJS has none).
      vm.runInContext('__spine_init(__spine_factory); delete globalThis.__spine_factory;', context, {
        timeout: loadTimeoutMs,
      });
      const initError = vm.runInContext('__spine_iife_error', context);
      if (initError != null) throw new Error(`Module init error: ${initError}`);
      engine.context = context;
      engine.call = vm.runInContext('__spine_call', context);
      engine.has = vm.runInContext('__spine_has', context);
      engine.exportKeys = JSON.parse(vm.runInContext('JSON.stringify(Object.keys(__spine_mod))', context));
    } catch (error) {
      // Timers or fetches the module's top level already started go with it.
      closeEngine(engine);
      throw error;
    }
    log(`  Module exports: [${engine.exportKeys.join(', ')}]`);
    return engine;
  }

  function closeEngine(engine) {
    engine.closed = true;
    engine.lifetime.abort(new Error('module unloaded'));
    for (const { timer, resolve } of engine.timers.values()) {
      clearTimeout(timer);
      resolve('cleared');
    }
    engine.timers.clear();
  }

  function closePool(pool) {
    pool.closed = true;
    for (const engine of pool.made) closeEngine(engine);
    for (const waiter of pool.waiters.splice(0)) waiter.reject(new Error('module unloaded'));
  }

  /** Marks `moduleId` most recently used and returns its pool. */
  function touch(moduleId) {
    const pool = pools.get(moduleId);
    if (pool) {
      pools.delete(moduleId);
      pools.set(moduleId, pool);
    }
    return pool;
  }

  /** An engine for exclusive use: a free one, a new one if there is room, else wait. */
  function acquire(moduleId, pool) {
    const free = pool.free.shift();
    if (free) return Promise.resolve(free);
    if (pool.started < enginesPerModule) {
      // The claim is taken before building and released if building throws.
      pool.started++;
      try {
        const fresh = newEngine(moduleId, pool.code, pool.fetchBase);
        pool.made.push(fresh);
        return Promise.resolve(fresh);
      } catch (error) {
        pool.started--;
        return Promise.reject(error);
      }
    }
    return new Promise((resolve, reject) => pool.waiters.push({ resolve, reject }));
  }

  /** Back into circulation on every path, or a pool slot is lost for good. */
  function release(pool, engine) {
    if (pool.closed || engine.closed) return;
    const waiter = pool.waiters.shift();
    if (waiter) waiter.resolve(engine);
    else pool.free.push(engine);
  }

  return {
    /**
     * Evaluates `code` into a first engine for `moduleId` (no-op if loaded).
     * Evicts the least recently used module first when `maxModules` are loaded.
     * @param {string} moduleId
     * @param {string} code
     * @param {{ fetchBase?: string }} [options]  base for the module's relative fetch URLs
     */
    load(moduleId, code, { fetchBase = '' } = {}) {
      if (pools.has(moduleId)) {
        touch(moduleId);
        return;
      }
      while (pools.size >= maxModules) {
        const lru = pools.keys().next().value;
        log(`  Evicting LRU module engine: ${lru}`);
        closePool(pools.get(lru));
        pools.delete(lru);
      }
      const engine = newEngine(moduleId, String(code), fetchBase);
      pools.set(moduleId, {
        code: String(code),
        fetchBase,
        free: [engine],
        made: [engine],
        started: 1,
        waiters: [],
        closed: false,
      });
    },

    isLoaded(moduleId) {
      return pools.has(moduleId);
    },

    /** The export names the module's first engine ended up with. */
    exportsOf(moduleId) {
      return pools.get(moduleId)?.made[0]?.exportKeys ?? [];
    },

    /** Engines built for `moduleId` so far (for tests and diagnostics). */
    engineCount(moduleId) {
      return pools.get(moduleId)?.made.length ?? 0;
    },

    /**
     * Calls an export with `args` passed as JSON values and resolves the
     * module's answer parsed from JSON. A module-reported `{ error }` is
     * returned as data; the caller decides what it means.
     * @param {string} moduleId
     * @param {string} functionName
     * @param {unknown[]} args  JSON-serialisable
     */
    async call(moduleId, functionName, args = []) {
      const pool = touch(moduleId);
      if (!pool) throw new Error(`Module ${moduleId} is not loaded`);
      const argsJson = JSON.stringify(args);
      const engine = await acquire(moduleId, pool);
      try {
        if (!engine.has(functionName)) throw new Error(`${functionName} is not a function on module ${moduleId}`);
        const raw = await engine.call(functionName, argsJson);
        if (typeof raw !== 'string') throw new Error(`${functionName} on module ${moduleId} returned nothing`);
        return JSON.parse(raw);
      } finally {
        release(pool, engine);
      }
    },

    unload(moduleId) {
      const pool = pools.get(moduleId);
      if (pool) closePool(pool);
      pools.delete(moduleId);
    },

    unloadAll() {
      for (const pool of pools.values()) closePool(pool);
      pools.clear();
    },
  };
}

// ── Index and results (ModuleIndex.kt, SpineModule.kt, ModuleResults.kt) ──

/**
 * Every module listed under a `category:*` key (except category:artworks and
 * category:testing), first occurrence of an id winning. A category holding an
 * entry without an id or a name is dropped whole, as a failed decode is.
 */
export function parseModuleIndex(json) {
  if (!isObject(json)) throw new TypeError('the module index is not a JSON object');
  const seen = new Set();
  const modules = [];
  for (const [key, value] of Object.entries(json)) {
    if (!key.startsWith('category:') || EXCLUDED_CATEGORIES.has(key)) continue;
    if (!Array.isArray(value)) continue;
    const entries = value.map((entry) =>
      isObject(entry) && optStr(entry.id) != null && optStr(entry.name) != null
        ? {
            id: str(entry.id),
            name: str(entry.name),
            version: str(entry.version),
            download: str(entry.download),
            // Some indexes publish capabilities under "labels" instead of "tags".
            tags: (Array.isArray(entry.tags) && entry.tags.length > 0
              ? entry.tags
              : Array.isArray(entry.labels) ? entry.labels : []
            ).map((tag) => str(tag)),
          }
        : null,
    );
    if (entries.some((entry) => entry == null)) continue;
    for (const entry of entries) {
      if (seen.has(entry.id)) continue;
      seen.add(entry.id);
      modules.push(entry);
    }
  }
  return modules;
}

/** ModuleSearchResponse. A thrown module (`{ error }` and no tracks) is a failure. */
export function readModuleSearchResponse(json) {
  if (!isObject(json)) throw new ModuleError('searchTracks did not return an object');
  if (!Array.isArray(json.tracks) && blankToNull(optStr(json.error)) != null) throw new ModuleError(json.error);
  const tracks = (Array.isArray(json.tracks) ? json.tracks : []).filter(isObject).map((track) => ({
    id: str(track.id),
    title: str(track.title),
    artist: str(track.artist),
    artistId: optStr(track.artistId),
    album: str(track.album),
    albumId: optStr(track.albumId),
    albumCover: optStr(track.albumCover),
    // An integer number of seconds in BitChord (a fraction fails its parser); truncated here.
    duration: int(track.duration) ?? 0,
    trackNumber: int(track.trackNumber) ?? 0,
    audioQuality: str(track.audioQuality),
    format: str(track.format),
    availableQualities: Array.isArray(track.availableQualities) ? track.availableQualities.map((q) => str(q)) : [],
  }));
  return { tracks, total: int(json.total) ?? 0 };
}

/** ModuleStreamResponse. `streamUrl: null` alone is a miss; with an `error`, a failure. */
export function readModuleStreamResponse(json) {
  if (!isObject(json)) throw new ModuleError('getTrackStreamUrl did not return an object');
  const streamUrl = optStr(json.streamUrl);
  if (blankToNull(streamUrl) == null && blankToNull(optStr(json.error)) != null) throw new ModuleError(json.error);
  const meta = isObject(json.track) ? json.track : null;
  return {
    streamUrl,
    track: meta && {
      id: str(meta.id),
      audioQuality: str(meta.audioQuality),
      mimeType: optStr(meta.mimeType),
      bitDepth: int(meta.bitDepth),
      sampleRate: num(meta.sampleRate),
      bitrate: int(meta.bitrate),
      // Parsed, and (as in BitChord) not consulted for Atmos detection.
      audioModes: Array.isArray(meta.audioModes) ? meta.audioModes.map((mode) => str(mode)) : null,
    },
  };
}

// ── Format detection (ModuleSource.kt:307-342) ─────────────────────────────

/**
 * The codec, from the first thing that states one: the MIME subtype (taken
 * verbatim, whatever it is), an Atmos label (ATMOS, EAC3_JOC, EC-3) →
 * 'eac3-joc', a lossless label (qualityTier) → 'flac', the URL extension.
 */
export function moduleCodecOf(mimeType, quality, url) {
  if (mimeType != null) {
    const subtype = mimeType.slice(mimeType.lastIndexOf('/') + 1).split(';')[0].trim().toLowerCase();
    if (subtype !== '') return subtype;
  }
  const label = String(quality ?? '').toUpperCase();
  if (label.includes('ATMOS') || label.includes('EAC3_JOC') || label.includes('EC-3')) return 'eac3-joc';
  if (qualityTier(quality ?? '') === 'LOSSLESS') return 'flac';
  const path = String(url).split('?')[0];
  const extension = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
  return AUDIO_EXTENSIONS.has(extension) ? extension : null;
}

/** The `320` in a "320kbps" label or the `.128.` in a CDN filename, 8..2000 only. */
function kbpsIn(text) {
  if (text == null || String(text).trim() === '') return null;
  const found = KBPS_LABEL.exec(text) ?? KBPS_URL.exec(text);
  if (!found) return null;
  const kbps = Number.parseInt(found[1], 10);
  return kbps >= 8 && kbps <= 2_000 ? kbps : null;
}

/** Label number, URL number, else the label's tier: HIGH = 320, LOW = 128. */
export function moduleKbpsFor(quality, url) {
  const stated = kbpsIn(quality) ?? kbpsIn(url);
  if (stated != null) return stated;
  const tier = qualityTier(quality ?? '');
  return tier === 'HIGH' ? 320 : tier === 'LOW' ? 128 : null;
}

/** A row's tier: its stated quality/format first, else the best it lists as available. */
export function rowTier(track) {
  const stated = qualityTier(`${track.audioQuality} ${track.format}`);
  if (stated != null) return stated;
  let bestLabel = null;
  let bestIndex = -Infinity;
  for (const label of track.availableQualities) {
    const index = TIERS.indexOf(qualityTier(label));
    if (index > bestIndex) {
      bestIndex = index;
      bestLabel = label;
    }
  }
  return bestLabel == null ? null : qualityTier(bestLabel);
}

/** First of each, then second of each: nth place everywhere beats second place anywhere. */
function interleave(lists) {
  const merged = [];
  for (let rank = 0; lists.some((list) => list.length > rank); rank++) {
    for (const list of lists) if (rank < list.length) merged.push(list[rank]);
  }
  return merged;
}

/** Resolves when `promise` settles or `ms` pass, whichever is first; rejects on abort. */
function within(ms, promise, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(finish, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason ?? new DOMException('This operation was aborted', 'AbortError'));
    };
    function finish() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener('abort', onAbort, { once: true });
    Promise.resolve(promise).then(finish, finish);
  });
}

// ── The source (ModuleManager + ModuleSource) ──────────────────────────────

/**
 * A module index (or a fixed list of modules) as a source (see
 * resolve.js#MusicSource). Row ids are `<moduleId>::<upstreamId>`.
 *
 * @param {{ id?: string, displayName?: string, kind?: 'custom_module'|'module',
 *           indexUrl?: string,
 *           modules?: Array<{ id: string, name?: string, code?: string, download?: string, fetchBase?: string }>,
 *           host?: ReturnType<typeof createModuleHost>, fetch?: typeof fetch,
 *           atmosAllowed?: boolean, now?: () => number, log?: (line: string) => void,
 *           budgets?: { firstAnswerMs?: number, graceMs?: number, patientMs?: number, patientGraceMs?: number } }} options
 *   BitChord's QuickJsExecutor is one process-wide pool keyed by module id;
 *   pass one `host` to several sources to share it the same way.
 */
export function createModuleSource(options) {
  const {
    indexUrl = null,
    kind = 'custom_module',
    fetch: fetchImpl = globalThis.fetch,
    atmosAllowed = false,
    now = Date.now,
    log = noop,
  } = options;
  const host = options.host ?? createModuleHost({ fetch: fetchImpl, log });
  const id = options.id ?? indexUrl ?? 'modules';
  const displayName = options.displayName ?? id;
  const budgets = {
    firstAnswerMs: SEARCH_BUDGET_MS,
    graceMs: SEARCH_GRACE_MS,
    patientMs: SEARCH_PATIENT_MS,
    patientGraceMs: SEARCH_PATIENT_GRACE_MS,
    ...options.budgets,
  };
  const fixed = options.modules ?? null;
  if (fixed == null && indexUrl == null) throw new TypeError('createModuleSource needs indexUrl or modules');
  const indexBase = indexUrl == null ? '' : indexUrl.slice(0, Math.max(indexUrl.lastIndexOf('/'), 0));

  const indexes = sharedCalls({ ttlMs: INDEX_TTL_MS, now });
  const loads = sharedCalls({ ttlMs: 0, now }); // shared while running, never by time
  const searches = sharedCalls({ ttlMs: SEARCH_TTL_MS, now });
  const streams = sharedCalls({ ttlMs: STREAM_TTL_MS, now });
  /** moduleId → { code, fetchBase }: the downloaded source, kept to revive an evicted engine. */
  const loaded = new Map();

  function fetchIndex({ signal } = {}) {
    if (fixed != null) return Promise.resolve(fixed.map((module) => ({ name: module.id, ...module })));
    return indexes.get(
      indexUrl,
      async () => parseModuleIndex(JSON.parse(await getText({ fetch: fetchImpl }, indexUrl, { timeoutMs: 30_000 }))),
      { signal },
    );
  }

  /** Downloads (once) and loads the module's JS; revives an engine the pool evicted. */
  function loadModule(module, { signal } = {}) {
    return loads.get(
      module.id,
      async () => {
        const cached = loaded.get(module.id);
        if (cached) {
          if (!host.isLoaded(module.id)) host.load(module.id, cached.code, { fetchBase: cached.fetchBase });
          return cached;
        }
        let code = module.code;
        let fetchBase = module.fetchBase ?? '';
        if (code == null) {
          const downloadUrl = module.download.startsWith('http') ? module.download : `${indexBase}/${module.download}`;
          code = await getText({ fetch: fetchImpl }, downloadUrl, { timeoutMs: 30_000 });
          fetchBase = downloadUrl.slice(0, Math.max(downloadUrl.lastIndexOf('/'), 0));
        }
        host.load(module.id, code, { fetchBase });
        const entry = { code, fetchBase };
        loaded.set(module.id, entry);
        return entry;
      },
      { signal },
    );
  }

  /** The `context` argument: `{ settings: { key: { value } } }`, the shape a module reads. */
  const contextOf = (settings) => ({
    settings: Object.fromEntries(Object.entries(settings).map(([key, value]) => [key, { value }])),
  });

  function searchTracks(module, query, limit, settings = {}, { signal } = {}) {
    const context = contextOf(settings);
    return searches.get(
      keyOf(module.id, query, String(limit), JSON.stringify(context)),
      async () => readModuleSearchResponse(await host.call(module.id, 'searchTracks', [query, limit, context])),
      { signal },
    );
  }

  function getStreamUrl(module, trackId, quality, settings = {}, { signal } = {}) {
    const context = contextOf(settings);
    return streams.get(
      keyOf(module.id, trackId, quality, JSON.stringify(context)),
      async () =>
        readModuleStreamResponse(await host.call(module.id, 'getTrackStreamUrl', [trackId, quality, context])),
      { signal },
    );
  }

  /** One module's rows, or [] if it could not give any. Never rejects. */
  async function searchOne(module, query, limit) {
    try {
      await loadModule(module);
    } catch (error) {
      log(`${displayName}: load failed for ${module.id} — ${error?.message ?? error}`);
      return [];
    }
    let answer;
    try {
      answer = await searchTracks(module, query, limit);
    } catch (error) {
      log(`${displayName}: search failed for ${module.id} — ${error?.message ?? error}`);
      return [];
    }
    return answer.tracks.map((track) => ({
      id: `${module.id}${MOD_SEPARATOR}${track.id}`,
      title: track.title,
      artist: track.artist,
      album: blankToNull(track.album),
      artwork: track.albumCover,
      durationSec: track.duration > 0 ? track.duration : null,
      explicit: null,
      quality: rowTier(track),
    }));
  }

  /** The settings a stream call carries: strict fallback whenever lossless was asked for. */
  function streamSettings(request) {
    return {
      quality: requestTier(request),
      fallbackMode: request.kind === 'lossless' ? 'strict' : 'flexible',
      dolbyAtmos: String(atmosAllowed),
    };
  }

  return {
    id,
    kind,
    rank: SOURCE_KINDS[kind]?.rank ?? 0,
    canServeLossless: true,
    displayName,
    host,
    fetchIndex,

    /**
     * Every module asked at once, answers interleaved round-robin, trimmed to
     * `limit`. Live: up to 8 s for a first useful (non-empty) answer, then
     * 2.5 s for the rest. waitForAll (upgrades, downloads): 8 s + 8 s within
     * 25 s. Stragglers are not cancelled; their answers still reach the cache.
     */
    async search(query, { limit = 25, signal, waitForAll = false } = {}) {
      if (String(query ?? '').trim() === '') return [];
      let modules;
      try {
        modules = await fetchIndex({ signal });
      } catch (error) {
        if (signal?.aborted) throw error;
        log(`${displayName}: index fetch failed — ${error?.message ?? error}`);
        return [];
      }
      const answers = new Array(modules.length).fill(null);
      let markUseful;
      let markAll;
      const useful = new Promise((resolve) => {
        markUseful = resolve;
      });
      const all = new Promise((resolve) => {
        markAll = resolve;
      });
      let finished = 0;
      if (modules.length === 0) markAll();
      modules.forEach((module, at) => {
        searchOne(module, query, limit).then((rows) => {
          answers[at] = rows;
          if (rows.length > 0) markUseful();
          if (++finished === modules.length) markAll();
        });
      });
      // BitChord waits for a first useful answer only; once every module has
      // answered (all empty), there is nothing left to wait for.
      const firstOrAll = Promise.race([useful, all]);
      if (waitForAll) {
        // withTimeoutOrNull(25 s) { first answer ≤ 8 s; stragglers ≤ 8 s }
        const deadline = Date.now() + budgets.patientMs;
        const left = () => Math.max(0, deadline - Date.now());
        await within(Math.min(budgets.firstAnswerMs, left()), firstOrAll, signal);
        await within(Math.min(budgets.patientGraceMs, left()), all, signal);
      } else {
        await within(budgets.firstAnswerMs, firstOrAll, signal);
        await within(budgets.graceMs, all, signal);
      }
      return interleave(answers.filter((rows) => rows != null)).slice(0, limit);
    },

    /**
     * getTrackStreamUrl(upstreamId, tier, { settings }) → SourceStream or null.
     * Refuses an empty or malformed URL, and Atmos where it cannot play.
     */
    async stream(trackId, request, { signal } = {}) {
      const cut = trackId.indexOf(MOD_SEPARATOR);
      if (cut < 0) {
        log(`${displayName}: malformed trackId '${trackId}'`);
        return null;
      }
      const moduleId = trackId.slice(0, cut);
      const upstreamId = trackId.slice(cut + MOD_SEPARATOR.length);
      let modules;
      try {
        modules = await fetchIndex({ signal });
      } catch (error) {
        if (signal?.aborted) throw error;
        log(`${displayName}: index fetch failed — ${error?.message ?? error}`);
        return null;
      }
      const module = modules.find((candidate) => candidate.id === moduleId);
      if (!module) {
        log(`${displayName}: module '${moduleId}' not found in index`);
        return null;
      }
      try {
        await loadModule(module, { signal });
      } catch (error) {
        if (signal?.aborted) throw error;
        log(`${displayName}: load failed for ${moduleId} — ${error?.message ?? error}`);
        return null;
      }
      const tier = requestTier(request);
      let answer;
      try {
        answer = await getStreamUrl(module, upstreamId, tier, streamSettings(request), { signal });
      } catch (error) {
        if (signal?.aborted) throw error;
        log(`${displayName}: getStreamUrl failed for ${upstreamId} — ${error?.message ?? error}`);
        return null;
      }
      const url = blankToNull(answer.streamUrl);
      if (url == null) {
        log(`${displayName}: empty stream URL for ${upstreamId}`);
        return null;
      }
      if (malformed(url)) {
        log(`${displayName}: ${moduleId} returned a malformed URL for ${upstreamId}; skipping it`);
        return null;
      }
      const meta = answer.track;
      let sampleRate = null;
      if (meta?.sampleRate != null) {
        // Values under 1000 are a kHz figure where Hz was specified.
        sampleRate = meta.sampleRate < 1000 ? Math.trunc(meta.sampleRate * 1000) : Math.trunc(meta.sampleRate);
      }
      const format = {
        codec: moduleCodecOf(meta?.mimeType ?? null, meta?.audioQuality ?? null, url),
        // A module's bitrate is taken as kbps, unlike an addon's (no bps normalisation).
        kbps: meta?.bitrate ?? moduleKbpsFor(meta?.audioQuality ?? null, url),
        sampleRate: sampleRate != null && sampleRate > 0 ? sampleRate : null,
        bitDepth: meta?.bitDepth != null && meta.bitDepth > 0 ? meta.bitDepth : null,
      };
      if (unplayable(format, atmosAllowed)) {
        log(
          `${displayName}: ${moduleId} answered a ${tier} request with ${formatSummary(format)}, ` +
            'which cannot play here — passing',
        );
        return null;
      }
      return { url, format, headers: {} };
    },

    /** { status: 'ok' | 'unreachable' | 'rejected', detail } (SourceHealth). */
    async health() {
      try {
        const modules = await fetchIndex();
        if (modules.length === 0) {
          return { status: 'rejected', detail: 'The index answered but listed no modules — check the URL' };
        }
        return { status: 'ok', detail: `${modules.length} module${modules.length === 1 ? '' : 's'}` };
      } catch (error) {
        return { status: 'unreachable', detail: error?.message || 'Could not reach the module index' };
      }
    },

    /** Everything held, dropped (ModuleManager.unloadAll). */
    unloadAll() {
      loaded.clear();
      loads.clear();
      searches.clear();
      streams.clear();
      indexes.clear();
      host.unloadAll();
    },
  };
}
