// Addon sources: a plain HTTP/JSON server that answers /manifest.json,
// /search?q= and /stream/{id}. Nothing is executed on this side.
//
// Mirrors BitChord's
//   data/sources/addon/AddonClient.kt   endpoints, settings passthrough, matchTier,
//                                       atmos hint, 429/404/5xx handling, caching
//   data/sources/addon/AddonModels.kt   wire shapes and what is derived from them
//   data/sources/AddonSource.kt         mapping to the source interface: rows,
//                                       codec precedence, refusals, row-URL fallback
//
// Independent JavaScript re-implementation of the mechanism documented in BITCHORD_ENGINE_RESEARCH.md (BitChord itself is GPL-3.0).
//
// Usage:
//   const addon = createAddonSource('https://addon.example.com/<token>/manifest.json',
//                                   { atmosAllowed: false });
//   const rows = await addon.search('paniyon sa atif aslam', { limit: 15, request });
//   const stream = await addon.stream(rows[0].id, { kind: 'lossless' });
//
// BitChord parses with a lenient kotlinx.serialization Json (unknown keys
// ignored, nulls coerced to defaults, numbers accepted where strings are
// declared). The readers below are equally forgiving, and slightly more so: a
// wrong-typed field becomes its default instead of failing the whole document.

import { timeoutSignal } from '../lib/http.js';
import { sharedCalls, ttlLru } from './cache.js';
import { formatSummary, malformed, qualityTier, requestTier, SOURCE_KINDS, unplayable } from './resolve.js';

// ── Constants (AddonClient.kt:392-502, AddonSource.kt:373-405) ─────────────

export const TIER_LOSSLESS = 'LOSSLESS';
export const TIER_HIGH = 'HIGH';
export const TIER_LOW = 'LOW';
const QUALITY_KEY = 'quality';
const ATMOS_KEY = 'atmos';
/** `auto` = try Atmos, else stereo. `1`/`true` would be the spec's strict mode. */
const ATMOS_AUTO = 'auto';
export const LOSSLESS_WORDS = Object.freeze(['lossless', 'flac', 'hifi', 'hi-res', 'hires', 'max', 'best']);
export const HIGH_WORDS = Object.freeze(['high', '320', 'normal', 'standard']);
export const LOW_WORDS = Object.freeze(['low', '96', '128', 'min']);
const MANIFEST_SUFFIX = '/manifest.json';
export const MANIFEST_TTL_MS = 10 * 60 * 1000;
export const SEARCH_TTL_MS = 10 * 60 * 1000;
export const STREAM_TTL_MS = 5 * 60 * 1000;
export const MAX_RETRIES = 2;
export const BACKOFF_BASE_MS = 500;
export const BACKOFF_CAP_MS = 8_000;
export const USER_AGENT = 'BitChord';
const PROBE_QUERY = 'music';
/** OkHttp callTimeout: bounds the whole call, body included (AddonClient.kt:498-502). */
export const CALL_TIMEOUT_MS = 20_000;
/** Search rows remembered for their duration and streamURL (AddonSource.kt:373). */
export const MAX_ROWS = 256;
/** Containers that name their own codec (AddonSource.kt:380). */
export const SELF_DESCRIBING_CONTAINERS = Object.freeze(new Set(['flac', 'wav', 'mp3', 'aiff']));
/** What may be believed as a codec, from a field or a URL extension (AddonSource.kt:402-405). */
export const AUDIO_CODECS = Object.freeze(new Set([
  'flac', 'alac', 'wav', 'aiff', 'mp3', 'aac', 'he-aac', 'm4a', 'mp4',
  'ogg', 'opus', 'vorbis', 'webm', 'eac3-joc', 'ec3-joc',
]));

/** The spellings of an immersive mix in any free-text field (AddonModels.kt:192). */
const ATMOS_HINT = /atmos|dolby|eac3[_-]?joc|ec-?3/i;
const KBPS_LABEL = /(\d{2,4})\s*kbps/i;
const KHZ_LABEL = /([\d.]+)\s*kHz/i;
const BIT_DEPTH_LABEL = /(\d{1,2})\s*-?\s*bit/i;

const noop = () => {};

// ── Errors (AddonClient.kt:506-524) ────────────────────────────────────────

/** Something trying again will not fix: a non-manifest, an unusable URL, a 4xx. */
export class AddonException extends Error {
  constructor(message) {
    super(message);
    this.name = 'AddonException';
  }
}

/** Momentarily not answering: a 5xx, or rate limiting that outlasted the retries. */
export class AddonUnavailable extends Error {
  constructor(message) {
    super(message);
    this.name = 'AddonUnavailable';
  }
}

/** The addon answered 404: it does not hold what was asked for. A miss, not a fault. */
export class AddonNotFound extends Error {
  constructor() {
    super('Not held by this addon');
    this.name = 'AddonNotFound';
  }
}

// ── Lenient field readers ───────────────────────────────────────────────────

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const str = (value, fallback = '') =>
  typeof value === 'string' ? value : typeof value === 'number' || typeof value === 'boolean' ? String(value) : fallback;
const optStr = (value) => (value == null ? null : str(value, null));
const blankToNull = (value) => (value == null || value.trim() === '' ? null : value);
const strList = (value) => (Array.isArray(value) ? value.map(optStr).filter((item) => item != null) : []);
function num(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value);
  return null;
}
function optBool(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string' && /^(true|false)$/i.test(value)) return value.toLowerCase() === 'true';
  return null;
}

/** A JSON scalar as the string that would go in a query parameter; null for null, blank or composite values. */
function asQueryValue(value) {
  if (typeof value === 'string') return value.trim() === '' ? null : value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return null;
}

// ── Wire shapes (AddonModels.kt) ───────────────────────────────────────────

/** AddonManifest: id, name, version, resources, settings (key, default, options). */
export function readManifest(json) {
  if (!isObject(json)) throw new TypeError('the manifest is not a JSON object');
  const settings = (Array.isArray(json.settings) ? json.settings : []).filter(isObject).map((setting) => ({
    key: str(setting.key),
    defaultValue: asQueryValue(setting.default),
    options: (Array.isArray(setting.options) ? setting.options : [])
      .filter(isObject)
      .map((option) => ({ stringValue: asQueryValue(option.value) })),
  }));
  return {
    id: str(json.id),
    name: str(json.name),
    version: str(json.version),
    resources: strList(json.resources),
    settings,
  };
}

/** Only `search` is required, and only when the addon declared anything at all. */
export function isPlayable(manifest) {
  return manifest.resources.length === 0 || manifest.resources.some((resource) => resource.toLowerCase() === 'search');
}

export function manifestDisplayName(manifest) {
  return manifest.name.trim() !== '' ? manifest.name : manifest.id;
}

/** AddonTrack, with its derived durationSec, artwork and isDolbyAtmos. */
export function readTrack(json) {
  const track = {
    id: str(json.id),
    title: str(json.title),
    artist: str(json.artist),
    album: str(json.album),
    duration: num(json.duration),
    artworkURL: optStr(json.artworkURL),
    albumArtworkURL: optStr(json.albumArtworkURL),
    format: str(json.format),
    audioQuality: str(json.audioQuality),
    audioMode: optStr(json.audioMode),
    audioModes: strList(json.audioModes),
    atmos: optBool(json.atmos),
    streamURL: optStr(json.streamURL),
  };
  // Seconds, read as a double so 240.0 is fine; truncated like Kotlin's toInt().
  track.durationSec = track.duration != null && track.duration > 0 ? Math.trunc(track.duration) : null;
  track.artwork = blankToNull(track.artworkURL) ?? blankToNull(track.albumArtworkURL);
  // Tidal files its immersive rows under audioQuality LOW, so this is read on
  // its own and before the tier label.
  track.isDolbyAtmos =
    track.atmos === true ||
    ATMOS_HINT.test(`${track.audioQuality} ${track.audioMode ?? ''} ${track.audioModes.join(' ')} ${track.format}`);
  return track;
}

export function readSearchResponse(json) {
  if (!isObject(json)) throw new TypeError('the search answer is not a JSON object');
  return { tracks: (Array.isArray(json.tracks) ? json.tracks : []).filter(isObject).map(readTrack) };
}

/** `encrypted` is "Boolean or String": false is clear, anything else names a DRM scheme. */
function isEncryptedValue(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return true; // a primitive whose content is not "false"/"none"
  if (typeof value === 'string') {
    if (value === 'true') return true;
    if (value === 'false') return false;
    const lowered = value.toLowerCase();
    return value.trim() !== '' && lowered !== 'false' && lowered !== 'none';
  }
  return false; // absent, null, or not a primitive
}

/** The declared transport: 'hls' | 'dash' | null (the URL is the audio, or nothing was said). */
function transportOf(manifest, mediaType, format) {
  const stated = blankToNull(manifest) ?? blankToNull(mediaType) ?? blankToNull(format);
  if (stated == null) return null;
  switch (stated.toLowerCase()) {
    case 'hls':
    case 'm3u8':
    case 'application/x-mpegurl':
    case 'application/vnd.apple.mpegurl':
      return 'hls';
    case 'dash':
    case 'mpd':
    case 'application/dash+xml':
      return 'dash';
    default:
      return null;
  }
}

/** AddonStream, with every derived property the source reads. */
export function readStream(json) {
  if (!isObject(json)) throw new TypeError('the stream answer is not a JSON object');
  const answer = {
    url: str(json.url),
    format: str(json.format),
    quality: str(json.quality),
    streamQuality: str(json.streamQuality),
    audioQuality: str(json.audioQuality),
    codec: optStr(json.codec),
    fileCodec: optStr(json.fileCodec),
    container: optStr(json.container),
    containerFormat: optStr(json.containerFormat),
    manifest: optStr(json.manifest),
    mediaType: optStr(json.mediaType),
    mimeType: optStr(json.mimeType),
    encrypted: json.encrypted ?? null,
    sampleRate: num(json.sampleRate),
    bitDepth: num(json.bitDepth),
    bitrate: num(json.bitrate),
    audioMode: optStr(json.audioMode),
    audioModes: strList(json.audioModes),
    error: optStr(json.error),
  };
  answer.statedCodec = (blankToNull(answer.codec) ?? blankToNull(answer.fileCodec))?.toLowerCase() ?? null;
  answer.statedContainer = (blankToNull(answer.container) ?? blankToNull(answer.containerFormat))?.toLowerCase() ?? null;
  answer.qualityText = `${answer.quality} ${answer.streamQuality} ${answer.audioQuality} ${answer.format}`;
  answer.isEncrypted = isEncryptedValue(answer.encrypted);
  answer.transport = transportOf(answer.manifest, answer.mediaType, answer.format);
  answer.sampleRateHz = sampleRateOf(answer);
  answer.bits = bitsOf(answer);
  answer.kbps = kbpsOf(answer);
  answer.isDolbyAtmos = ATMOS_HINT.test(
    `${answer.qualityText} ${answer.audioMode ?? ''} ${answer.audioModes.join(' ')} ${answer.statedCodec ?? ''}`,
  );
  return answer;
}

/** The field if filled in (kHz values under 1000 are scaled), else the "96 kHz" in a label. */
function sampleRateOf(answer) {
  if (answer.sampleRate != null && answer.sampleRate > 0) {
    return answer.sampleRate < 1000 ? Math.trunc(answer.sampleRate * 1000) : Math.trunc(answer.sampleRate);
  }
  const label = KHZ_LABEL.exec(answer.qualityText);
  const khz = label ? Number(label[1]) : NaN;
  return Number.isFinite(khz) && khz > 0 ? Math.trunc(khz * 1000) : null;
}

/** The field if filled in, else the "24" in a "24-bit" label (8..32 only). */
function bitsOf(answer) {
  if (answer.bitDepth != null && answer.bitDepth > 0) return Math.trunc(answer.bitDepth);
  const label = BIT_DEPTH_LABEL.exec(answer.qualityText);
  const bits = label ? Number.parseInt(label[1], 10) : NaN;
  return bits >= 8 && bits <= 32 ? bits : null;
}

/** kbps from `bitrate` (over 3000 is bits per second), else from a "320kbps" label. */
function kbpsOf(answer) {
  if (answer.bitrate != null && answer.bitrate > 0) {
    return answer.bitrate > 3_000 ? Math.trunc(answer.bitrate / 1000) : Math.trunc(answer.bitrate);
  }
  const label = KBPS_LABEL.exec(answer.qualityText);
  return label ? Number.parseInt(label[1], 10) : null;
}

// ── URL helpers (AddonClient.kt:424-447) ───────────────────────────────────

/** A base URL from whatever was pasted: trailing slashes and any *.json document removed. */
export function normalizeBase(raw) {
  const trimmed = String(raw ?? '').trim().replace(/\/+$/, '');
  const slash = trimmed.lastIndexOf('/');
  const lastSegment = slash < 0 ? '' : trimmed.slice(slash + 1);
  if (lastSegment.toLowerCase().endsWith('.json') && trimmed.includes('://')) {
    return trimmed.slice(0, trimmed.length - lastSegment.length).replace(/\/+$/, '');
  }
  return trimmed;
}

export function manifestUrl(base) {
  return `${base}${MANIFEST_SUFFIX}`;
}

/** The path carries the user's token, so logs keep only scheme and host. */
export function redact(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '***';
    return `${parsed.protocol.slice(0, -1)}://${parsed.hostname}/***`;
  } catch {
    return '***';
  }
}

/**
 * The declared option that best answers `tier`, or null when none were
 * enumerated: an exact (case-insensitive) match, else the first option whose
 * text contains a keyword for the tier, else the first option.
 */
export function matchTier(tier, options) {
  if (options.length === 0) return null;
  const exact = options.find((option) => option.toLowerCase() === tier.toLowerCase());
  if (exact !== undefined) return exact;
  const upper = tier.toUpperCase();
  const wanted = upper === TIER_LOSSLESS ? LOSSLESS_WORDS : upper === TIER_LOW ? LOW_WORDS : HIGH_WORDS;
  return options.find((option) => wanted.some((word) => option.toLowerCase().includes(word))) ?? options[0];
}

/**
 * How long to wait after a 429: Retry-After in seconds when it parses as a
 * number (an HTTP-date does not), else 500 ms << attempt; clamped to [0.5 s, 8 s].
 */
export function retryAfterMs(header, attempt) {
  let stated = null;
  const text = header?.trim();
  if (text) {
    if (/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?[fFdD]?$/.test(text)) stated = Number(text.replace(/[fFdD]$/, '')) * 1000;
    else if (/^[+-]?(NaN|Infinity)$/.test(text)) stated = Number(text) * 1000;
  }
  let wait = stated == null ? BACKOFF_BASE_MS * 2 ** attempt : Number.isNaN(stated) ? 0 : Math.trunc(stated);
  if (!(wait >= BACKOFF_BASE_MS)) wait = BACKOFF_BASE_MS;
  return Math.min(wait, BACKOFF_CAP_MS);
}

/** Parts joined length-prefixed, so no byte a part may contain can act as a delimiter. */
const keyOf = (...parts) => parts.map((part) => `${part.length}:${part}`).join('|');
/** Kotlin's Map.toString(), which is what BitChord puts in its cache keys. */
const mapText = (params) => `{${[...params].map(([key, value]) => `${key}=${value}`).join(', ')}}`;
const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ── The client (AddonClient.kt) ────────────────────────────────────────────

/**
 * One addon server and every question BitChord asks it. One instance per
 * configured source, so the manifest, the answers shaped by it and the 429
 * quiet window survive across tracks.
 *
 * @param {string} rawBaseUrl
 * @param {{ fetch?: typeof fetch, atmosAllowed?: boolean, now?: () => number,
 *           sleep?: (ms: number) => Promise<void>, callTimeoutMs?: number,
 *           log?: (line: string) => void }} [options]
 *   atmosAllowed folds DeviceCodecs.playsDolbyAtmos && AppSettings.dolbyAtmos.
 */
export function createAddonClient(rawBaseUrl, options = {}) {
  const {
    fetch: fetchImpl = globalThis.fetch,
    atmosAllowed = false,
    now = Date.now,
    sleep = defaultSleep,
    callTimeoutMs = CALL_TIMEOUT_MS,
    log = noop,
  } = options;
  const baseUrl = normalizeBase(rawBaseUrl);

  // Answers are shared and cached on a scope that outlives any one caller:
  // a caller's signal only detaches that caller (see cache.js).
  const manifests = sharedCalls({ ttlMs: MANIFEST_TTL_MS, now });
  const searches = sharedCalls({ ttlMs: SEARCH_TTL_MS, now });
  const streams = sharedCalls({ ttlMs: STREAM_TTL_MS, now });

  /**
   * When this addon may be spoken to again after a 429. Per instance, not per
   * request: a 429 is a statement about the server, so sibling calls wait too.
   */
  let quietUntil = 0;

  /** `{base}/{segments…}?{params}`, each id kept as a single encoded path segment. */
  function endpoint(segments, params) {
    let url;
    try {
      url = new URL(baseUrl);
    } catch {
      throw new AddonException('That is not a usable address');
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new AddonException('That is not a usable address');
    const path = url.pathname.endsWith('/') ? url.pathname.slice(0, -1) : url.pathname;
    // encodeURIComponent keeps '/' and '?' inside the segment (a%2Fb%3Fc).
    url.pathname = `${path}/${segments.map(encodeURIComponent).join('/')}`;
    // Built from the Map's entries so parameter order is exactly insertion order.
    // URLSearchParams writes a space as '+', which query parsers read as a space
    // (OkHttp writes %20).
    for (const [key, value] of params) url.searchParams.append(key, value);
    return url.toString();
  }

  /** One GET with the addon's back-pressure honoured (AddonClient.body). */
  async function body(url) {
    let attempt = 0;
    for (;;) {
      const quiet = quietUntil - now();
      if (quiet > 0) await sleep(quiet);

      const { signal, done } = timeoutSignal(undefined, callTimeoutMs);
      let status;
      let text = '';
      let retryAfter = null;
      try {
        const response = await fetchImpl(url, {
          method: 'GET',
          headers: { Accept: 'application/json', 'User-Agent': USER_AGENT },
          signal,
        });
        status = response.status;
        // The timeout spans the body too: a server dribbling a byte at a time
        // is exactly what a per-read timeout never trips.
        if (status >= 200 && status < 300) text = await response.text();
        else {
          retryAfter = response.headers.get('retry-after');
          await response.body?.cancel().catch(noop);
        }
      } finally {
        done();
      }

      if (status >= 200 && status < 300) {
        if (text.trim() === '') throw new AddonException('Empty response');
        return text;
      }
      if (status === 404) throw new AddonNotFound();
      // A 5xx is a bad minute and worth asking again on the next track; a 4xx
      // is a request this addon will never grant.
      if (status >= 500) throw new AddonUnavailable(`HTTP ${status}`);
      if (status !== 429) throw new AddonException(`HTTP ${status}`);
      if (attempt >= MAX_RETRIES) throw new AddonUnavailable('This addon is rate limiting BitChord');
      quietUntil = now() + retryAfterMs(retryAfter, attempt);
      attempt++;
    }
  }

  async function fetchJson(url) {
    try {
      return JSON.parse(await body(url));
    } catch (error) {
      if (!(error instanceof AddonNotFound)) log(`  ✗ addon call failed ${redact(url)}: ${error?.message ?? error}`);
      throw error;
    }
  }

  /**
   * What the addon says it is. Fails with AddonException when the document is
   * not a manifest (no id), cannot be searched, or is missing (a manifest 404
   * means "no addon here", not "no such track").
   */
  function manifest({ signal } = {}) {
    return manifests.get(
      baseUrl,
      async () => {
        let parsed;
        try {
          parsed = readManifest(await fetchJson(manifestUrl(baseUrl)));
        } catch (error) {
          if (error instanceof AddonNotFound) throw new AddonException('No manifest at that URL');
          throw error;
        }
        if (parsed.id.trim() === '') throw new AddonException("That URL answered, but not with an addon manifest");
        if (!isPlayable(parsed)) {
          throw new AddonException(`This addon declares ${parsed.resources.join(', ')} — BitChord needs search`);
        }
        return parsed;
      },
      { signal },
    );
  }

  /** Whether /search answers at all, without a manifest; resolves the row count. */
  async function probeSearch() {
    const answer = readSearchResponse(await fetchJson(endpoint(['search'], new Map([['q', PROBE_QUERY]]))));
    return answer.tracks.length;
  }

  /**
   * The parameters on every request: the manifest's declared defaults first,
   * then `quality` negotiated against its options (or the tier verbatim), then
   * atmos=auto unless the addon declared its own atmos setting. The manifest
   * is read best-effort: when it is missing, the call still goes out.
   */
  async function settingsFor(tier, signal) {
    let declared = [];
    try {
      declared = (await manifest({ signal })).settings;
    } catch (error) {
      if (signal?.aborted) throw error;
    }
    const params = new Map();
    for (const setting of declared) {
      if (setting.key.trim() === '') continue;
      if (setting.defaultValue != null) params.set(setting.key, setting.defaultValue);
    }
    if (tier.trim() !== '') {
      const options = (declared.find((setting) => setting.key === QUALITY_KEY)?.options ?? [])
        .map((option) => option.stringValue)
        .filter((value) => value != null);
      params.set(QUALITY_KEY, matchTier(tier, options) ?? tier);
    }
    if (atmosAllowed && !params.has(ATMOS_KEY)) params.set(ATMOS_KEY, ATMOS_AUTO);
    return params;
  }

  /** The addon's rows for `query` (no limit parameter exists in the protocol). */
  async function search(query, tier, { signal } = {}) {
    const trimmed = String(query ?? '').trim();
    if (trimmed === '') return [];
    const params = await settingsFor(tier, signal);
    // The parameters are part of the key: the same query at another tier is another question.
    const answer = await searches.get(
      keyOf(trimmed, mapText(params)),
      async () => {
        const withQuery = new Map(params);
        withQuery.set('q', trimmed);
        return readSearchResponse(await fetchJson(endpoint(['search'], withQuery)));
      },
      { signal },
    );
    return answer.tracks;
  }

  /** The /stream/{id} answer for one of the addon's own ids. */
  async function stream(trackId, tier, { signal } = {}) {
    const params = await settingsFor(tier, signal);
    return streams.get(
      keyOf(trackId, mapText(params)),
      async () => readStream(await fetchJson(endpoint(['stream', trackId], params))),
      { signal },
    );
  }

  return {
    baseUrl,
    manifest,
    probeSearch,
    search,
    stream,
    /** Everything held, dropped (the source was edited or removed). */
    clear() {
      manifests.clear();
      searches.clear();
      streams.clear();
      quietUntil = 0;
    },
    /** The listener's explicit "Upgrade quality": completed answers re-asked, in-flight kept. */
    clearCompletedTrackCalls() {
      searches.clearCompleted();
      streams.clearCompleted();
    },
  };
}

// ── The source (AddonSource.kt) ────────────────────────────────────────────

/**
 * What is really on the end of the URL, most trustworthy claim first
 * (AddonSource.kt:320-347): stated codec → self-describing container → MIME
 * subtype → Atmos hint → lossless quality label → URL extension. Null when
 * none knows. kbps falls back to the tier's published meaning on lossy rungs.
 */
export function formatOf(answer, url, tier) {
  const mime = answer.mimeType == null ? null : mimeSubtype(answer.mimeType);
  let codec =
    (answer.statedCodec != null && AUDIO_CODECS.has(answer.statedCodec) ? answer.statedCodec : null) ??
    (answer.statedContainer != null && SELF_DESCRIBING_CONTAINERS.has(answer.statedContainer)
      ? answer.statedContainer
      : null) ??
    (mime != null && AUDIO_CODECS.has(mime) ? mime : null);
  if (codec == null) {
    if (answer.isDolbyAtmos) codec = 'eac3-joc';
    else if (qualityTier(answer.qualityText) === 'LOSSLESS') codec = 'flac';
    else {
      const extension = urlExtension(url);
      codec = AUDIO_CODECS.has(extension) ? extension : null;
    }
  }
  return {
    codec,
    kbps: answer.kbps ?? (tier === TIER_HIGH ? 320 : tier === TIER_LOW ? 128 : null),
    sampleRate: answer.sampleRateHz,
    bitDepth: answer.bits,
  };
}

/** "audio/flac; x=y" → "flac" (the whole string when there is no '/'). */
export function mimeSubtype(mimeType) {
  return mimeType.slice(mimeType.lastIndexOf('/') + 1).split(';')[0].trim().toLowerCase();
}

/** The text after the last '.' before any '?', lower-cased (the whole string when there is no '.'). */
export function urlExtension(url) {
  const path = String(url).split('?')[0];
  return path.slice(path.lastIndexOf('.') + 1).toLowerCase();
}

/**
 * An addon as a source (see resolve.js#MusicSource).
 *
 * @param {string} baseUrl  the pasted URL; `/manifest.json` or any *.json suffix is removed
 * @param {{ id?: string, displayName?: string, client?: ReturnType<typeof createAddonClient>,
 *           fetch?: typeof fetch, atmosAllowed?: boolean, now?: () => number,
 *           sleep?: (ms: number) => Promise<void>, callTimeoutMs?: number,
 *           log?: (line: string) => void }} [options]
 */
export function createAddonSource(baseUrl, options = {}) {
  const { atmosAllowed = false, log = noop } = options;
  const client = options.client ?? createAddonClient(baseUrl, options);
  const id = options.id ?? client.baseUrl;
  let host = client.baseUrl;
  try {
    host = new URL(client.baseUrl).hostname;
  } catch {
    // keep the raw base as the name
  }
  const displayName = options.displayName ?? host;

  /** Rows recently handed over, by id: their duration and their own streamURL. */
  const rows = ttlLru({ max: MAX_ROWS });

  /** Everything between a URL the addon named and one the player may open. */
  function openable(url, answer, trackId, tier) {
    if (malformed(url)) {
      log(`${displayName}: malformed URL for ${trackId}; skipping it — ${url.slice(0, 120)}`);
      return null;
    }
    if (answer.isEncrypted) {
      log(`${displayName}: ${trackId} came back encrypted, which BitChord never asked for — passing`);
      return null;
    }
    const format = formatOf(answer, url, tier);
    if (unplayable(format, atmosAllowed)) {
      log(`${displayName}: answered a ${tier} request with ${formatSummary(format)}, which cannot play here — passing`);
      return null;
    }
    return {
      url,
      format,
      headers: {},
      // Said out loud rather than sniffed: an extensionless HLS path would
      // otherwise reach a progressive extractor.
      transport: answer.transport,
      durationSec: rows.get(trackId)?.durationSec ?? null,
    };
  }

  /** The search row's own streamURL, when /stream had nothing. */
  function fromRow(trackId, tier) {
    const row = rows.get(trackId);
    const url = blankToNull(row?.streamURL ?? null);
    if (url == null) return null;
    log(`${displayName}: using the search row's own URL for ${trackId}`);
    return openable(url, readStream({ url, format: row.format }), trackId, tier);
  }

  return {
    id,
    kind: 'addon',
    rank: SOURCE_KINDS.addon.rank,
    canServeLossless: SOURCE_KINDS.addon.canServeLossless,
    displayName,
    client,

    /**
     * One request, one catalogue, rows in the addon's own order. The tier is
     * the request's when a stream is what the search is for, else LOSSLESS.
     * `waitForAll` has nothing to mean here. A failure is an empty answer.
     */
    async search(query, { limit = 25, signal, request } = {}) {
      if (String(query ?? '').trim() === '') return [];
      const tier = request ? requestTier(request) : TIER_LOSSLESS;
      let tracks;
      try {
        tracks = await client.search(query, tier, { signal });
      } catch (error) {
        if (signal?.aborted) throw error;
        log(`${displayName}: search failed — ${error?.message ?? error}`);
        return [];
      }
      return tracks
        .filter((track) => track.id.trim() !== '' && track.title.trim() !== '')
        .slice(0, limit)
        .map((track) => {
          rows.set(track.id, track);
          return {
            id: track.id,
            title: track.title,
            artist: track.artist,
            album: blankToNull(track.album),
            artwork: track.artwork,
            durationSec: track.durationSec,
            explicit: null,
            // Atmos is read before the tier label and not from it.
            quality: track.isDolbyAtmos ? 'DOLBY' : qualityTier(`${track.audioQuality} ${track.format}`),
          };
        });
    },

    /**
     * The /stream answer as a SourceStream, or null. A 404 is a quiet miss,
     * anything else a logged one; both, and a 200 without a url, fall back to
     * the search row's own streamURL.
     */
    async stream(trackId, request, { signal } = {}) {
      const tier = requestTier(request);
      let answer = null;
      let failure = null;
      try {
        answer = await client.stream(trackId, tier, { signal });
      } catch (error) {
        if (signal?.aborted) throw error;
        failure = error;
      }
      if (answer == null) {
        if (!(failure instanceof AddonNotFound)) {
          log(`${displayName}: stream failed for ${trackId} — ${failure?.message ?? failure}`);
        }
        return fromRow(trackId, tier);
      }
      const url = blankToNull(answer.url);
      if (url == null) {
        log(`${displayName}: no stream for ${trackId}${answer.error?.trim() ? ` — ${answer.error}` : ''}`);
        return fromRow(trackId, tier);
      }
      return openable(url, answer, trackId, tier);
    },

    /**
     * { status: 'ok' | 'unreachable' | 'rejected', detail } (SourceHealth).
     * No manifest is not no addon: a working /search is healthy too.
     */
    async health() {
      if (String(baseUrl ?? '').trim() === '') return { status: 'rejected', detail: 'An addon URL is required' };
      try {
        const found = await client.manifest();
        const detail = [
          manifestDisplayName(found).trim() !== '' ? manifestDisplayName(found) : null,
          found.version.trim() !== '' ? `v${found.version}` : null,
        ]
          .filter((part) => part != null)
          .join(' ');
        return { status: 'ok', detail: detail.trim() === '' ? null : detail };
      } catch (failure) {
        try {
          await client.probeSearch();
          return { status: 'ok', detail: 'No manifest · search works' };
        } catch {
          // fall through to the manifest's failure
        }
        const reason = failure?.message || 'Could not reach the addon';
        return failure instanceof AddonException
          ? { status: 'rejected', detail: reason }
          : { status: 'unreachable', detail: reason };
      }
    },

    /** Dropped along with the source. */
    release() {
      rows.clear();
      client.clear();
    },

    clearCompletedTrackCalls() {
      client.clearCompletedTrackCalls();
    },
  };
}
