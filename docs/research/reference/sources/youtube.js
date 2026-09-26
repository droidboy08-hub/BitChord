// Minimal InnerTube audio resolver: no-cipher, no-PoToken clients only.
//
// Mirrors BitChord (commit fe198ac), app/src/main/java/com/music/bitchord/data/innertube/:
//   StreamResolver.kt     resolve (:258-278), unplayable verdicts (:331-362),
//                         coalescedResolve (:386-420), innerTubeXStream (:485-509),
//                         mediaHeadersFor (:512-513), probe (:746-820),
//                         onPlaybackRefused (:833-845), permanentReason (:941-962),
//                         recent URL cache (:1071-1096)
//   InnerTubeXResolver.kt extract: quality mapping, kbps, mime (:209-244),
//                         minted headers (:193-247), onRefused/exclude (:254-265)
//   PlayerClient.kt       forStreamUrl + its client table (:44-144)
//   Innertube.kt          ensureVisitorData / fetchVisitorData (:116-187)
// and InnerTubeX v0.7.0 (github.com/MetrolistGroup/innertubex, src/commonMain/kotlin/
// com/metrolist/innertubex/), which BitChord delegates client choice to:
//   models/YouTubeClient.kt                    client identities (:140-273), toContext (:39-64)
//   extraction/strategy/PlaybackClientCatalog.kt  priority / lifecycle / selection (:104-206)
//   extraction/strategy/ContentAwareFallbackStrategy.kt  score() (:218-311)
//   InnerTube.kt                               ytClient headers + endpoint (:385-448),
//                                              player body (:571-650), transient codes (:112)
//   models/YouTubeLocale.kt                    acceptLanguageHeader (:10-15)
//   extraction/PlayerClientDirector.kt         8 s player timeout (:57), isPlayable (:987-996),
//                                              video identity check (:984-985)
//   extraction/InnerTubeExtractor.kt           direct fast path (:1030-1166), buildHeaders
//                                              (:1477-1521), isAllowedMediaUrl (:1601-1610),
//                                              hasNParameter (:1462), bounded clients (:1623-1628)
//   extraction/FormatSelectors.kt              selectBestAudioFormat, audioFormatScore (:5-87)
//   extraction/PlaybackNonce.kt                cpn (:6-57)
//   extraction/PlayabilityFailure.kt           age-restriction markers (:28-34)
//
// Independent JavaScript re-implementation of the mechanism documented in
// BITCHORD_ENGINE_RESEARCH.md §3.2 (BitChord itself is GPL-3.0; InnerTubeX is
// GPL-3.0 as well: LICENSE at its repository root, README "License: GPL-3.0",
// POM "GNU General Public License, version 3"). Only protocol constants come
// from InnerTubeX: client names, versions, numeric ids, user agents and device
// fields, which any InnerTube client has to send verbatim to be served.
//
// ---------------------------------------------------------------------------
// What it does
//
//   resolve(videoId)
//     URL cache (20 min, 32) -> negative cache (10 min) -> single flight per id
//     -> [optional] visitorData from www.youtube.com/sw.js_data
//     -> for each client in order: POST music.youtube.com/youtubei/v1/player
//          -> playabilityStatus + streamingData.adaptiveFormats
//          -> pick audio like InnerTubeX (AUTO / LOW / MP4)
//          -> only a DIRECT url without `n` is usable; otherwise next client
//          -> probe: Range at 1 MiB, audio/*, 16 KiB, 6 s
//     -> first probed URL wins, is cached and returned; null if none.
//
// Why no signature cipher / n-transform (deliberately out of scope)
//   A format that carries `signatureCipher` instead of `url` must have its `s`
//   value scrambled by a function hidden in YouTube's player JavaScript
//   (base.js), and a URL with an `n` parameter must have `n` transformed by
//   another such function, or googlevideo throttles it to a crawl. Doing either
//   means downloading ~2 MB of player JS, extracting the functions and running
//   them in a JS sandbox, then keeping up as YouTube rotates the player every
//   few days (InnerTubeX needs three tiers for it: remote "zemer" configs, the
//   yt-dlp EJS solver in QuickJS, a regex parser; BitChord records a cold solve
//   at 8.7 s). The clients below are chosen because their responses carry
//   plain `url`s with no `n`: no player JS, no solver, no PoToken. InnerTubeX
//   itself runs exactly this "no-cipher direct pass" first and only pays for
//   the cipher when it finds nothing. So when no direct URL exists this module
//   returns null, and the caller runs its cipher-capable fallback (a NewPipe-
//   or yt-dlp-style extractor), just as BitChord falls through to NewPipe.
//
// Which clients, in which order (see CLIENTS / DEFAULT_CLIENT_ORDER)
//   InnerTubeX v0.7.0 lists six identities of this kind. Only VISIONOS_0_1 is
//   AUTOMATIC in its catalogue, so it is the one no-cipher client BitChord's
//   walk really uses; VISIONOS 1.02 and all ANDROID_VR profiles are PROBE_ONLY
//   there (benchmark notes: VR URLs hit a CDN 403 after 1 MiB, visionOS 1.02
//   "can stall" on clean sessions). They are still useful fallbacks here,
//   because the probe reads PAST 1 MiB and within 6 s, so exactly those
//   failures are caught before a URL is trusted. The default order puts the
//   automatic client first, then the rest in InnerTubeX's own score order for
//   normal content (base priority + content +25 + direct +10 + lifecycle):
//     VISIONOS_0_1 125 | VISIONOS 130 | ANDROID_VR_1_43_32 97 |
//     ANDROID_VR_1_61_48 79 | ANDROID_VR_1_65_10 75 | ANDROID_VR_NO_AUTH 75
//   Every one of them posts to music.youtube.com (useMusicPlayerEndpoint).
//
// visitorData (how BitChord gets it)
//   Innertube.ensureVisitorData() GETs https://www.youtube.com/sw.js_data with
//   a desktop Chrome UA. The body is `)]}'` + newline + nested JSON arrays; the
//   id is the first string shaped like /Cg[A-Za-z0-9_%-]{40,}/ (found by shape,
//   not by path; InnerTubeX reads [0][2][0][0][13]). A session-bound id taken
//   from the signed-in music.youtube.com shell outranks it. It is sent as
//   context.client.visitorData AND X-Goog-Visitor-Id. Without one, Google may
//   answer LOGIN_REQUIRED ("confirm you're not a bot") or, worse, URLs that
//   serve a byte and then 403 (Innertube.kt:116-130). Optional here: pass
//   { visitorData: null } to skip it, or a string to supply your own.
//
// Media headers (a finding worth knowing)
//   InnerTubeX's buildHeaders() returns an EMPTY map for ANDROID_VR, VISIONOS
//   and TVHTML5_SIMPLY, and BitChord's mediaHeadersFor() prefers InnerTubeX's
//   map, so BitChord actually fetches those URLs with OkHttp's default UA, not
//   the minting client's. PlayerClient.forStreamUrl (c=/cver= -> UA) is only
//   its fallback for URLs InnerTubeX did not mint. This module defaults to
//   sending the minting client's own UA (mediaHeaderPolicy 'client-ua');
//   'itx' reproduces InnerTubeX's empty map.

import { request, timeoutSignal, HttpError, qs } from '../lib/http.js';
import { rangeBytesFor, contentLengthOf, REFUSAL_CODES } from '../transport/chunkedFetch.js';

export { rangeBytesFor };

// ---- Constants ---------------------------------------------------------------

export const MUSIC_ORIGIN = 'https://music.youtube.com';
export const WWW_ORIGIN = 'https://www.youtube.com';

/** PlayerClient.kt:48-50 / Innertube.kt:456-458 (desktop Chrome 141). */
export const WEB_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';

/** [ITX] PlayerClientDirector.kt:57 DEFAULT_PLAYER_REQUEST_TIMEOUT_MS: covers retries and body. */
export const PLAYER_REQUEST_TIMEOUT_MS = 8_000;
/** [ITX] InnerTube.kt:112 TRANSIENT_STATUS_CODES; 3 attempts, 500 ms then 1 s back-off (:450-501). */
export const TRANSIENT_STATUS_CODES = Object.freeze([408, 425, 429, 500, 502, 503, 504]);
const PLAYER_MAX_ATTEMPTS = 3;
const PLAYER_RETRY_DELAY_MS = 500;

/** StreamResolver.kt:1084 / :1087. */
export const URL_TTL_MS = 20 * 60 * 1000;
export const MAX_REMEMBERED = 32;
/** StreamResolver.kt:362. */
export const UNPLAYABLE_TTL_MS = 10 * 60 * 1000;
/** InnerTubeXResolver.kt:284 / :285. */
export const EXCLUDE_MS = 10 * 60 * 1000;
export const MAX_MINTED = 64;
/** StreamResolver.kt:515 INNERTUBEX_ATTEMPTS: at most this many URLs are probed per resolve. */
export const MAX_PROBES = 3;
/** InnerTubeXResolver.kt:283: maxKbps <= 64 selects AudioQuality.LOW. */
export const LOW_KBPS = 64;

/** StreamResolver.kt:814 / :817 / :820. */
export const PROBE_TIMEOUT_MS = 6_000;
export const AUTH_BOUNDARY_BYTES = 1024 * 1024;
export const PROBE_READ_BYTES = 16 * 1024;
export const PROBE = Object.freeze({ OK: 'OK', REFUSED: 'REFUSED', UNREACHABLE: 'UNREACHABLE' });

export const VISITOR_DATA_URL = 'https://www.youtube.com/sw.js_data';
/** [ITX] PlayerClientDirector.kt:58 DEFAULT_VISITOR_DATA_FETCH_TIMEOUT_MS. */
export const VISITOR_DATA_TIMEOUT_MS = 8_000;
/** Innertube.kt:187: protobuf-in-base64, always this shape. Must match the WHOLE string. */
export const VISITOR_DATA_PATTERN = /^Cg[A-Za-z0-9_%-]{40,}$/;

// ---- Client catalogue ---------------------------------------------------------

/**
 * The no-cipher, no-PoToken identities of InnerTubeX v0.7.0, copied field for
 * field from models/YouTubeClient.kt. `itx` records the catalogue entry
 * (extraction/strategy/PlaybackClientCatalog.kt). Only fields that toContext()
 * serialises are kept (buildId / cronetVersion / packageName are never sent).
 */
export const CLIENTS = Object.freeze({
  // YouTubeClient.kt:158-176; catalogue :128-146. The only AUTOMATIC one.
  VISIONOS_0_1: Object.freeze({
    id: 'VISIONOS_0_1',
    clientName: 'VISIONOS',
    clientVersion: '0.1',
    clientId: '101',
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
    osName: 'VISION_OS',
    osVersion: '1.3',
    deviceMake: 'Apple',
    deviceModel: 'RealityDevice14,1',
    platform: 'MOBILE',
    includeUserAgentInContext: false,
    useMusicPlayerEndpoint: true,
    skipPlayerResponseValidation: true,
    itx: Object.freeze({ priority: 100, lifecycle: 'EXPERIMENTAL', selectionMode: 'AUTOMATIC' }),
  }),
  // YouTubeClient.kt:140-156; catalogue :106-127.
  VISIONOS: Object.freeze({
    id: 'VISIONOS',
    clientName: 'VISIONOS',
    clientVersion: '1.02',
    clientId: '101',
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 15_7_3) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15',
    osName: 'visionOS',
    osVersion: '26.5.23O471',
    deviceMake: 'Apple',
    deviceModel: 'RealityDevice17,1',
    includeUserAgentInContext: false,
    useMusicPlayerEndpoint: true,
    skipPlayerResponseValidation: false,
    itx: Object.freeze({ priority: 100, lifecycle: 'UNRELEASED', selectionMode: 'PROBE_ONLY' }),
  }),
  // YouTubeClient.kt:251-273; catalogue :162-176.
  ANDROID_VR_1_43_32: Object.freeze({
    id: 'ANDROID_VR_1_43_32',
    clientName: 'ANDROID_VR',
    clientVersion: '1.43.32',
    clientId: '28',
    userAgent:
      'com.google.android.apps.youtube.vr.oculus/1.43.32 (Linux; U; Android 12; en_US; Quest 3; Build/SQ3A.220605.009.A1; Cronet/107.0.5284.2)',
    osName: 'Android',
    osVersion: '12',
    deviceMake: 'Oculus',
    deviceModel: 'Quest 3',
    androidSdkVersion: '32',
    includeUserAgentInContext: true,
    useMusicPlayerEndpoint: true,
    skipPlayerResponseValidation: false,
    itx: Object.freeze({ priority: 82, lifecycle: 'DEPRECATED', selectionMode: 'PROBE_ONLY' }),
  }),
  // YouTubeClient.kt:222-244; catalogue :192-206.
  ANDROID_VR_1_61_48: Object.freeze({
    id: 'ANDROID_VR_1_61_48',
    clientName: 'ANDROID_VR',
    clientVersion: '1.61.48',
    clientId: '28',
    userAgent:
      'com.google.android.apps.youtube.vr.oculus/1.61.48 (Linux; U; Android 12; en_US; Quest 3; Build/SQ3A.220605.009.A1; Cronet/132.0.6808.3)',
    osName: 'Android',
    osVersion: '12',
    deviceMake: 'Oculus',
    deviceModel: 'Quest 3',
    androidSdkVersion: '32',
    includeUserAgentInContext: true,
    useMusicPlayerEndpoint: true,
    skipPlayerResponseValidation: false,
    itx: Object.freeze({ priority: 64, lifecycle: 'DEPRECATED', selectionMode: 'PROBE_ONLY' }),
  }),
  // YouTubeClient.kt:183-201; catalogue :147-161. yt-dlp's current android_vr profile.
  ANDROID_VR_1_65_10: Object.freeze({
    id: 'ANDROID_VR_1_65_10',
    clientName: 'ANDROID_VR',
    clientVersion: '1.65.10',
    clientId: '28',
    userAgent:
      'com.google.android.apps.youtube.vr.oculus/1.65.10 (Linux; U; Android 12L; eureka-user Build/SQ3A.220605.009.A1) gzip',
    osName: 'Android',
    osVersion: '12L',
    deviceMake: 'Oculus',
    deviceModel: 'Quest 3',
    androidSdkVersion: '32',
    includeUserAgentInContext: true,
    useMusicPlayerEndpoint: true,
    skipPlayerResponseValidation: false,
    itx: Object.freeze({ priority: 40, lifecycle: 'STABLE', selectionMode: 'PROBE_ONLY' }),
  }),
  // YouTubeClient.kt:203-216; catalogue :177-191. No device fields at all.
  ANDROID_VR_NO_AUTH: Object.freeze({
    id: 'ANDROID_VR_NO_AUTH',
    clientName: 'ANDROID_VR',
    clientVersion: '1.61.48',
    clientId: '28',
    userAgent:
      'com.google.android.apps.youtube.vr.oculus/1.61.48 (Linux; U; Android 12; en_US; Oculus Quest 3; Build/SQ3A.220605.009.A1; Cronet/132.0.6808.3)',
    includeUserAgentInContext: true,
    useMusicPlayerEndpoint: true,
    skipPlayerResponseValidation: false,
    itx: Object.freeze({ priority: 60, lifecycle: 'DEPRECATED', selectionMode: 'PROBE_ONLY' }),
  }),
});

/** InnerTubeX's automatic client first, then its probe-only ones in its own score order. */
export const DEFAULT_CLIENT_ORDER = Object.freeze([
  'VISIONOS_0_1',
  'VISIONOS',
  'ANDROID_VR_1_43_32',
  'ANDROID_VR_1_61_48',
  'ANDROID_VR_1_65_10',
  'ANDROID_VR_NO_AUTH',
]);

// ---- Small helpers -------------------------------------------------------------

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const array = (v) => (Array.isArray(v) ? v : []);
const nonBlank = (v) => typeof v === 'string' && v.trim() !== '';

/** A JSON number or numeric string as an integer (kotlinx accepts quoted numbers), else null. */
function toInt(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? Math.trunc(v) : null;
  if (typeof v === 'string' && /^[+-]?\d+$/.test(v.trim())) {
    const n = Number(v.trim());
    return Number.isSafeInteger(n) ? n : null;
  }
  return null;
}
const toNumber = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : null);

function parseUrl(value) {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function defaultSleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** `promise`, rejecting when `signal` aborts; a late rejection is swallowed. */
function untilAborted(promise, signal) {
  if (!signal) return promise;
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

function cancelBody(res) {
  try {
    res?.body?.cancel?.()?.catch?.(() => {});
  } catch {
    // locked or already consumed
  }
}

// ---- Request (InnerTube.ytClient + playerWithSession) ---------------------------

/** [ITX] YouTubeLocale.acceptLanguageHeader: ("en","US") -> "en-US,en;q=0.9". */
export function acceptLanguageHeader(hl = 'en', gl = 'US') {
  const languageTag = hl.replace(/_/g, '-');
  const regionalTag = languageTag.includes('-') || gl === '' ? languageTag : `${languageTag}-${gl}`;
  const fallback = languageTag.split('-')[0];
  return regionalTag === fallback ? regionalTag : `${regionalTag},${fallback};q=0.9`;
}

/**
 * [ITX] YouTubeClient.toContext, serialised as kotlinx does with
 * explicitNulls=false / encodeDefaults=true (BitChord's Json config): absent
 * fields omitted, `request` and `user` defaults written out, key order kept.
 */
export function toContext(client, { hl = 'en', gl = 'US', visitorData = null } = {}) {
  const c = { clientName: client.clientName, clientVersion: client.clientVersion };
  if (client.includeUserAgentInContext) c.userAgent = client.userAgent;
  for (const key of ['osName', 'osVersion', 'deviceMake', 'deviceModel', 'androidSdkVersion', 'platform']) {
    if (client[key] != null) c[key] = client[key];
  }
  c.gl = gl;
  c.hl = hl;
  if (visitorData) c.visitorData = visitorData;
  return { client: c, request: { internalExperimentFlags: [], useSsl: true }, user: { lockedSafetyMode: false } };
}

/**
 * The player POST exactly as InnerTubeX sends it for a signed-out, token-free
 * client: music.youtube.com when the client uses the music player endpoint,
 * www.youtube.com otherwise; no cookie (loginSupported = false); no
 * playbackContext (no signatureTimestamp for these clients); videoCheckOk only
 * off the music endpoint.
 * @returns {{url: string, init: {method: string, headers: Record<string,string>, body: string}}}
 */
export function buildPlayerRequest(client, videoId, { visitorData = null, hl = 'en', gl = 'US' } = {}) {
  const origin = client.useMusicPlayerEndpoint ? MUSIC_ORIGIN : WWW_ORIGIN;
  const headers = {
    'Content-Type': 'application/json',
    'X-Goog-Api-Format-Version': '1',
    'X-YouTube-Client-Name': client.clientId,
    'X-YouTube-Client-Version': client.clientVersion,
    Origin: origin,
    'X-Origin': origin,
    Referer: `${origin}/`,
    'Accept-Language': acceptLanguageHeader(hl, gl),
  };
  if (visitorData) headers['X-Goog-Visitor-Id'] = visitorData;
  headers['User-Agent'] = client.userAgent;
  const body = {
    context: toContext(client, { hl, gl, visitorData }),
    videoId,
    contentCheckOk: true,
    racyCheckOk: true,
  };
  if (!client.useMusicPlayerEndpoint) body.videoCheckOk = true;
  return {
    url: `${origin}/youtubei/v1/player?${qs({ prettyPrint: 'false' })}`,
    init: { method: 'POST', headers, body: JSON.stringify(body) },
  };
}

// ---- Response ------------------------------------------------------------------

/**
 * @typedef {Object} Format   one entry of streamingData.formats / adaptiveFormats
 * @property {number} itag
 * @property {string|null} url             null when the format is ciphered
 * @property {string} mimeType             e.g. 'audio/webm; codecs="opus"'
 * @property {number} bitrate              bits per second
 * @property {boolean} isAudio             [ITX] Format.isAudio: width == null
 * @property {number|null} contentLength
 * @property {number|null} audioSampleRate
 * @property {number|null} audioChannels
 * @property {number|null} loudnessDb
 * @property {boolean} isDrc
 * @property {string|null} signatureCipher
 * @property {string|null} cipher
 */

function normalizeFormat(raw) {
  const cipher = raw.signatureCipher ?? raw.signature_cipher;
  return {
    itag: toInt(raw.itag) ?? -1,
    url: nonBlank(raw.url) ? raw.url : null,
    mimeType: typeof raw.mimeType === 'string' ? raw.mimeType : '',
    bitrate: toInt(raw.bitrate) ?? 0,
    width: toInt(raw.width),
    height: toInt(raw.height),
    isAudio: raw.width === undefined || raw.width === null,
    contentLength: toInt(raw.contentLength),
    audioSampleRate: toInt(raw.audioSampleRate),
    audioChannels: toInt(raw.audioChannels),
    loudnessDb: toNumber(raw.loudnessDb),
    isDrc: raw.isDrc === true,
    signatureCipher: nonBlank(cipher) ? cipher : null,
    cipher: nonBlank(raw.cipher) ? raw.cipher : null,
  };
}

/**
 * The parts of a /player response this resolver reads.
 *
 * `playable` follows [ITX] PlayerClientDirector.isPlayable: status "OK" (or a
 * client that skips validation, VISIONOS_0_1) and at least one audio format
 * with a url or a cipher, or an HLS manifest. A response whose
 * videoDetails.videoId names another video is never playable.
 * @returns {{status: string|null, reason: string|null, playable: boolean,
 *   matchesVideo: boolean, formats: Format[], loudnessDb: number|null,
 *   perceptualLoudnessDb: number|null, expiresInSeconds: number|null,
 *   hlsManifestUrl: string|null}}
 */
export function parsePlayerResponse(json, videoId, client = {}) {
  const ps = isObject(json?.playabilityStatus) ? json.playabilityStatus : null;
  const status = typeof ps?.status === 'string' ? ps.status : null;
  const reason = typeof ps?.reason === 'string' ? ps.reason : null;
  const sd = isObject(json?.streamingData) ? json.streamingData : null;
  const formats = sd ? [...array(sd.formats), ...array(sd.adaptiveFormats)].filter(isObject).map(normalizeFormat) : [];
  const identity = json?.videoDetails?.videoId;
  const matchesVideo = !nonBlank(identity) || identity === videoId;
  const hlsManifestUrl = nonBlank(sd?.hlsManifestUrl) ? sd.hlsManifestUrl : null;
  const hasAudio = formats.some((f) => f.isAudio && (f.url || f.signatureCipher || f.cipher));
  const audioConfig = json?.playerConfig?.audioConfig;
  return {
    status,
    reason,
    playable:
      matchesVideo &&
      status !== null &&
      (status === 'OK' || client.skipPlayerResponseValidation === true) &&
      (hasAudio || hlsManifestUrl !== null),
    matchesVideo,
    formats,
    loudnessDb: toNumber(audioConfig?.loudnessDb),
    perceptualLoudnessDb: toNumber(audioConfig?.perceptualLoudnessDb),
    expiresInSeconds: toInt(sd?.expiresInSeconds),
    hlsManifestUrl,
  };
}

// ---- Format selection ([ITX] FormatSelectors.kt) ------------------------------

// Kotlin's maxByOrNull / minByOrNull / maxWithOrNull keep the FIRST extreme element.
function maxBy(list, key) {
  let best = null;
  let bestKey;
  for (const item of list) {
    const k = key(item);
    if (best === null || k > bestKey) { best = item; bestKey = k; }
  }
  return best;
}
function minBy(list, key) {
  let best = null;
  let bestKey;
  for (const item of list) {
    const k = key(item);
    if (best === null || k < bestKey) { best = item; bestKey = k; }
  }
  return best;
}

const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

/**
 * [ITX] audioFormatScore: codecRank (webm 100, mp4 50) * 1e6 + stereo bonus
 * (2 ch 50 000, mono 0, unknown 25 000) + bitrate + min(sampleRate, 48 000) / 10.
 */
export function audioFormatScore(format) {
  const codecRank = format.mimeType.includes('audio/webm') ? 100 : format.mimeType.includes('audio/mp4') ? 50 : 0;
  const channelBonus = format.audioChannels === 2 ? 50_000 : format.audioChannels === 1 ? 0 : 25_000;
  return codecRank * 1_000_000 + channelBonus + format.bitrate + Math.trunc(clamp(format.audioSampleRate ?? 0, 0, 48_000) / 10);
}

function highKey(f) {
  const channelRank = f.audioChannels === 2 ? 2 : f.audioChannels == null ? 1 : 0;
  const containerRank = f.mimeType.includes('audio/webm') ? 2 : f.mimeType.includes('audio/mp4') ? 1 : 0;
  return [f.bitrate, channelRank, clamp(f.audioSampleRate ?? 0, 0, 48_000), containerRank];
}
function compareKeys(a, b) {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  return 0;
}

/**
 * [ITX] selectBestAudioFormat.
 *   AUTO  best audio/webm (Opus: 251, or 774 when offered) by audioFormatScore,
 *         else the best of anything
 *   LOW   cheapest audio/mp4 (139, else 140), else the cheapest of anything
 *   MP4   best audio/mp4 (141 when offered, else 140); null if there is none
 *   HIGH  highest bitrate, then stereo, sample rate, webm over mp4
 * @param {Format[]} formats audio formats
 * @param {'AUTO'|'LOW'|'MP4'|'HIGH'} [quality]
 * @param {{requireUrl?: boolean}} [options] requireUrl=false also considers ciphered formats
 * @returns {Format|null}
 */
export function selectBestAudioFormat(formats, quality = 'AUTO', { requireUrl = true } = {}) {
  const valid = requireUrl ? formats.filter((f) => nonBlank(f.url)) : formats;
  if (valid.length === 0) return null;
  switch (quality) {
    case 'LOW':
      return minBy(valid.filter((f) => f.mimeType.includes('audio/mp4')), (f) => f.bitrate) ?? minBy(valid, (f) => f.bitrate);
    case 'AUTO':
      return maxBy(valid.filter((f) => f.mimeType.includes('audio/webm')), audioFormatScore) ?? maxBy(valid, audioFormatScore);
    case 'MP4':
      return maxBy(valid.filter((f) => f.mimeType.includes('audio/mp4')), audioFormatScore);
    case 'HIGH': {
      let best = null;
      for (const f of valid) if (best === null || compareKeys(highKey(best), highKey(f)) < 0) best = f;
      return best;
    }
    default:
      throw new TypeError(`unknown audio quality: ${quality}`);
  }
}

/** InnerTubeXResolver.extract's mapping: export -> MP4, <= 64 kbps -> LOW, else AUTO. */
export function qualityFor({ maxKbps = Infinity, requireM4a = false } = {}) {
  if (requireM4a) return 'MP4';
  return maxKbps <= LOW_KBPS ? 'LOW' : 'AUTO';
}

// ---- URL rules ([ITX] InnerTubeExtractor.kt, PlaybackNonce.kt) -----------------

const googlevideoHost = (h) => h === 'googlevideo.com' || h.endsWith('.googlevideo.com');

/** https, port 443, *.googlevideo.com or *.youtube.com, path /videoplayback, no credentials. */
export function isAllowedMediaUrl(value) {
  const u = parseUrl(value);
  if (!u) return false;
  const host = u.hostname;
  return (
    u.protocol === 'https:' &&
    (u.port === '' || u.port === '443') &&
    (googlevideoHost(host) || host === 'youtube.com' || host.endsWith('.youtube.com')) &&
    u.pathname === '/videoplayback' &&
    u.username === '' &&
    u.password === ''
  );
}

/** A URL still carrying the throttling `n` parameter (plain or percent-encoded). */
export function hasNParameter(url) {
  return /(?:[?&]|%26)n(?:=|%3[dD])/i.test(url);
}

/** Clients whose URLs must be read in bounded ranges ([ITX] requiresBoundedMediaRange). */
export function requiresBoundedMediaRange(clientName) {
  return clientName === 'ANDROID_VR' || clientName === 'IOS' || clientName === 'TVHTML5_SIMPLY';
}

const CPN_ALPHABET = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_';

/** [ITX] generateClientPlaybackNonce: 16 characters from a 64-letter alphabet. */
export function generateClientPlaybackNonce() {
  const bytes = new Uint8Array(16);
  if (globalThis.crypto?.getRandomValues) globalThis.crypto.getRandomValues(bytes);
  else for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  let out = '';
  for (const b of bytes) out += CPN_ALPHABET[b & 63];
  return out;
}

/** [ITX] appendClientPlaybackNonce: `cpn=` before any fragment, googlevideo /videoplayback only, once. */
export function appendClientPlaybackNonce(url, cpn) {
  if (!/^[A-Za-z0-9_-]{16}$/.test(cpn)) return url;
  const u = parseUrl(url);
  if (
    !u ||
    u.protocol !== 'https:' ||
    !(u.port === '' || u.port === '443') ||
    !googlevideoHost(u.hostname) ||
    u.pathname !== '/videoplayback' ||
    u.username !== '' ||
    u.password !== '' ||
    u.searchParams.has('cpn')
  ) {
    return url;
  }
  const hashAt = url.indexOf('#');
  const before = hashAt < 0 ? url : url.slice(0, hashAt);
  const fragment = hashAt < 0 ? '' : url.slice(hashAt);
  return `${before}${before.includes('?') ? '&' : '?'}cpn=${cpn}${fragment}`;
}

function extractExpire(url) {
  const m = /[?&]expire=([0-9]+)/.exec(url);
  return m ? Number(m[1]) : null;
}

function extractCodecs(mimeType) {
  const m = /codecs="([^"]+)"/.exec(mimeType);
  return m ? m[1] : null;
}

/**
 * The direct fast path of [ITX] InnerTubeExtractor.extractWithConfig with
 * allowCipherProcessing = false, for one client's parsed response:
 *   1. best audio format among those with a plain url;
 *   2. it must also be the best format overall, ciphered ones included —
 *      otherwise the better stream sits behind a cipher ('needs-cipher');
 *   3. cpn appended, URL must be a googlevideo/youtube /videoplayback URL;
 *   4. no `n` parameter (else it needs the n-transform: 'needs-cipher');
 *   5. clients that require bounded ranges need a known length.
 * @returns {{kind: 'direct', format: Format, url: string, clen: number|null}
 *   | {kind: 'no-audio'|'needs-cipher'|'rejected-url'|'no-length', detail?: string}}
 */
export function selectDirectAudio(parsed, { quality = 'AUTO', clientName = '', cpn = null } = {}) {
  const audio = parsed.formats.filter((f) => f.isAudio);
  const candidate = selectBestAudioFormat(audio, quality);
  const best = selectBestAudioFormat(
    audio.filter((f) => f.url || f.signatureCipher || f.cipher),
    quality,
    { requireUrl: false },
  );
  if (!candidate) return best ? { kind: 'needs-cipher', detail: 'every usable format is ciphered' } : { kind: 'no-audio' };
  if (best && candidate.itag !== best.itag) return { kind: 'needs-cipher', detail: `itag ${best.itag} is better but ciphered` };
  const url = cpn ? appendClientPlaybackNonce(candidate.url, cpn) : candidate.url;
  if (!isAllowedMediaUrl(url)) return { kind: 'rejected-url' };
  if (hasNParameter(url)) return { kind: 'needs-cipher', detail: 'url carries n' };
  // InnerTubeX would HEAD the URL when contentLength is missing; `clen` in the
  // URL is the same number and costs nothing, so no HEAD is made here.
  const clen = candidate.contentLength > 0 ? candidate.contentLength : contentLengthOf(url);
  if (requiresBoundedMediaRange(clientName) && !(clen > 0)) return { kind: 'no-length' };
  return { kind: 'direct', format: candidate, url, clen: clen ?? null };
}

// ---- Media headers (PlayerClient.kt) -------------------------------------------

const playerClient = (clientName, clientVersion, userAgent, origin = null) =>
  Object.freeze({ clientName, clientVersion, userAgent, origin });

/** PlayerClient.kt:52-110, verbatim. */
export const PLAYER_CLIENTS = Object.freeze({
  IOS: playerClient('IOS', '21.26.4', 'com.google.ios.youtube/21.26.4 (iPhone16,2; U; CPU iOS 18_3_2 like Mac OS X;)'),
  IOS_RECENT: playerClient('IOS', '21.29.1', 'com.google.ios.youtube/21.29.1 (iPhone16,2; U; CPU iOS 18_5 like Mac OS X;)'),
  ANDROID: playerClient(
    'ANDROID',
    '21.26.364',
    'com.google.android.youtube/21.26.364 (Linux; U; Android 15; en_US; Pixel 9 Pro; Build/AP4A.250205.002; Cronet/132.0.6834.79) gzip',
  ),
  ANDROID_MUSIC: playerClient(
    'ANDROID_MUSIC',
    '8.39.42',
    'com.google.android.apps.youtube.music/8.39.42 (Linux; U; Android 15; en_US; Pixel 9 Pro; Build/AP4A.250205.002) gzip',
  ),
  ANDROID_VR: playerClient(
    'ANDROID_VR',
    '1.65.10',
    'com.google.android.apps.youtube.vr.oculus/1.65.10 (Linux; U; Android 12L; eureka-user Build/SQ3A.220605.009.A1) gzip',
  ),
  ANDROID_VR_LEGACY: playerClient(
    'ANDROID_VR',
    '1.43.32',
    'com.google.android.apps.youtube.vr.oculus/1.43.32 (Linux; U; Android 12; en_US; Quest 3; Build/SQ3A.220605.009.A1; Cronet/107.0.5284.2)',
  ),
  WEB_REMIX: playerClient('WEB_REMIX', '1.20260707.12.00', WEB_USER_AGENT, MUSIC_ORIGIN),
  WEB: playerClient('WEB', '2.20260708.00.00', WEB_USER_AGENT, WWW_ORIGIN),
  TVHTML5: playerClient(
    'TVHTML5',
    '7.20260707.07.00',
    'Mozilla/5.0(SMART-TV; Linux; Tizen 4.0.0.2) AppleWebkit/605.1.15 (KHTML, like Gecko) SamsungBrowser/9.2 TV Safari/605.1.15',
    WWW_ORIGIN,
  ),
});

/**
 * PlayerClient.forStreamUrl: the client a googlevideo URL says minted it
 * (`c=` / `cver=`), IOS when unknown ("approximately right beats a smart TV's
 * headers for a URL an iPhone asked for").
 * Deviation: for VISIONOS, PlayerClient.kt reads NewPipe's getVisionOsUserAgent()
 * (an app-style "com.google.visionos.youtube/1.02 …" string, per BitChord's
 * PlayerClientRangeTest); NewPipe is not vendored, so InnerTubeX's visionOS
 * agent for that cver is used — the one its player request was made with.
 */
export function playerClientForStreamUrl(url) {
  const u = parseUrl(url);
  if (!u || (u.protocol !== 'http:' && u.protocol !== 'https:')) return PLAYER_CLIENTS.IOS;
  const name = u.searchParams.get('c')?.toUpperCase();
  if (!name) return PLAYER_CLIENTS.IOS;
  const version = u.searchParams.get('cver');
  if (name.startsWith('IOS')) return version === PLAYER_CLIENTS.IOS_RECENT.clientVersion ? PLAYER_CLIENTS.IOS_RECENT : PLAYER_CLIENTS.IOS;
  if (name === 'ANDROID_VR') return version === PLAYER_CLIENTS.ANDROID_VR_LEGACY.clientVersion ? PLAYER_CLIENTS.ANDROID_VR_LEGACY : PLAYER_CLIENTS.ANDROID_VR;
  if (name === 'ANDROID_MUSIC') return PLAYER_CLIENTS.ANDROID_MUSIC;
  if (name.startsWith('ANDROID')) return PLAYER_CLIENTS.ANDROID;
  if (name.startsWith('TVHTML5')) return PLAYER_CLIENTS.TVHTML5;
  if (name === 'WEB_REMIX') return PLAYER_CLIENTS.WEB_REMIX;
  if (name.startsWith('WEB') || name === 'MWEB') return PLAYER_CLIENTS.WEB;
  if (name === 'VISIONOS') {
    const identity = version === CLIENTS.VISIONOS_0_1.clientVersion ? CLIENTS.VISIONOS_0_1 : CLIENTS.VISIONOS;
    return playerClient('VISIONOS', version ?? '1.02', identity.userAgent);
  }
  return PLAYER_CLIENTS.IOS;
}

/**
 * Headers a media fetch of `url` must carry (PlayerClient.mediaHeaders):
 * User-Agent, plus Origin/Referer for browser-shaped clients only.
 * YouTubeResolver#mediaHeadersFor prefers what was recorded at mint time.
 * @param {string} url
 * @returns {Record<string,string>}
 */
export function mediaHeadersFor(url) {
  const pc = playerClientForStreamUrl(url);
  const headers = { 'User-Agent': pc.userAgent };
  if (pc.origin) {
    headers.Origin = pc.origin;
    headers.Referer = `${pc.origin}/`;
  }
  return headers;
}

// ---- Probe (StreamResolver.probe, with D6 fixed) --------------------------------

/**
 * Read until `need` bytes arrived or the body ended; then stop the transfer.
 * Every read races `signal`, so a stalled body is abandoned on time even with
 * a fetch implementation that does not wire its signal into the body stream.
 */
async function readAtLeast(res, need, signal) {
  const body = res.body;
  if (body && typeof body.getReader === 'function') {
    const reader = body.getReader();
    let got = 0;
    try {
      while (got < need) {
        const { done, value } = await untilAborted(reader.read(), signal);
        if (done) break;
        got += value.byteLength;
      }
    } finally {
      reader.cancel().catch(() => {});
    }
    return got;
  }
  return (await untilAborted(res.arrayBuffer(), signal)).byteLength;
}

/**
 * Read from a URL before trusting it.
 *
 * As StreamResolver.probe: the range starts at 1 MiB when the file is longer
 * than 1 MiB + 16 KiB (some clients' URLs serve the first MiB and 403 the rest),
 * the answer must be audio/* (not a consent page) and 16 KiB of it must arrive
 * within 6 s (a body that stalls after its headers is a failure too).
 *
 * D6 fixed (default `exact: true`): the request asks for exactly the 16 KiB it
 * reads (`bytes=1048576-1064959`), not a full 1 MiB / 512 KiB range that is
 * then reset mid-flight. Trade-off: StreamResolver.kt:754-757 argues the probe
 * range should be as large as the real reads, because a doubted session may
 * serve small ranges and 403 large ones. `exact: false` restores that sizing.
 * Deviation: when `clen` is under 16 KiB, only `clen` bytes are required.
 *
 * @param {string} url
 * @param {{ctx?: {fetch?: typeof fetch, signal?: AbortSignal}, headers?: Record<string,string>,
 *   exact?: boolean, timeoutMs?: number}} [options]
 * @returns {Promise<'OK'|'REFUSED'|'UNREACHABLE'>}
 */
export async function probe(url, { ctx = {}, headers = mediaHeadersFor(url), exact = true, timeoutMs = PROBE_TIMEOUT_MS } = {}) {
  const length = contentLengthOf(url);
  const start = length !== null && length > AUTH_BOUNDARY_BYTES + PROBE_READ_BYTES ? AUTH_BOUNDARY_BYTES : 0;
  const endExclusive = Math.min(start + (exact ? PROBE_READ_BYTES : rangeBytesFor(url)), length ?? Infinity);
  if (endExclusive <= start) return PROBE.UNREACHABLE;
  const range = Number.isFinite(endExclusive) ? `bytes=${start}-${endExclusive - 1}` : `bytes=${start}-`;
  const need = exact ? Math.min(PROBE_READ_BYTES, endExclusive - start) : PROBE_READ_BYTES;
  const f = ctx.fetch ?? globalThis.fetch;
  const { signal, done } = timeoutSignal(ctx.signal, timeoutMs); // spans headers AND body
  try {
    const res = await untilAborted(Promise.resolve().then(() => f(url, { headers: { ...headers, Range: range }, signal })), signal);
    if (REFUSAL_CODES.includes(res.status)) {
      cancelBody(res);
      return PROBE.REFUSED;
    }
    if ((res.status < 200 || res.status > 299) && res.status !== 416) {
      cancelBody(res);
      return PROBE.UNREACHABLE;
    }
    // A refusal dressed as a success: an error page or a consent interstitial.
    if (!(res.headers.get('content-type') ?? '').startsWith('audio/')) {
      cancelBody(res);
      return PROBE.REFUSED;
    }
    return (await readAtLeast(res, need, signal)) >= need ? PROBE.OK : PROBE.UNREACHABLE;
  } catch {
    return PROBE.UNREACHABLE;
  } finally {
    done();
  }
}

// ---- visitorData (Innertube.kt:116-187) ------------------------------------------

function findVisitorData(element) {
  if (Array.isArray(element)) {
    for (const child of element) {
      const found = findVisitorData(child);
      if (found !== null) return found;
    }
    return null;
  }
  // Primitives only; objects are not descended (Innertube.findVisitorData).
  return typeof element === 'string' && VISITOR_DATA_PATTERN.test(element) ? element : null;
}

/**
 * Parse a sw.js_data body: drop the `)]}'` anti-hijacking line (or, with no
 * newline, the first 5 characters), then find the id by shape.
 * @param {string} body
 * @returns {string|null}
 */
export function parseVisitorData(body) {
  const nl = body.indexOf('\n');
  const json = nl >= 0 ? body.slice(nl + 1) : body.slice(5);
  try {
    return findVisitorData(JSON.parse(json));
  } catch {
    return null;
  }
}

/**
 * Mint an anonymous visitor id the way BitChord does. Never throws for
 * network/parse failures (null instead); rethrows a caller abort.
 * @param {{fetch?: typeof fetch, signal?: AbortSignal}} [ctx]
 * @returns {Promise<string|null>}
 */
export async function fetchVisitorData(ctx = {}, { timeoutMs = VISITOR_DATA_TIMEOUT_MS } = {}) {
  const deadline = timeoutSignal(ctx.signal, timeoutMs);
  try {
    const res = await request({ fetch: ctx.fetch, signal: deadline.signal }, VISITOR_DATA_URL, {
      headers: { 'User-Agent': WEB_USER_AGENT },
      timeoutMs,
    });
    return parseVisitorData(await untilAborted(res.text(), deadline.signal));
  } catch (error) {
    if (ctx.signal?.aborted) throw ctx.signal.reason ?? error;
    return null;
  } finally {
    deadline.done();
  }
}

// ---- Verdicts ------------------------------------------------------------------

/** A track that cannot play for a reason that will read the same in ten minutes. */
export class PermanentlyUnplayableError extends Error {
  constructor(message, category) {
    super(message);
    this.name = 'PermanentlyUnplayableError';
    this.category = category;
  }
}

/**
 * Every player request failed without a response worth judging (offline, DNS,
 * timeouts, HTTP errors) — InnerTubeX's Reason.NETWORK. `attempts` says which.
 */
export class PlayerRequestsFailedError extends Error {
  constructor(videoId, attempts) {
    super(`every InnerTube player request failed for ${videoId}`);
    this.name = 'PlayerRequestsFailedError';
    this.attempts = attempts;
    this.cause = attempts.find((a) => a.error)?.error;
  }
}

/**
 * Whether a playability failure is a verdict about the content rather than
 * about this client or this minute — the categories StreamResolver.permanentReason
 * treats as permanent (from NewPipe's exception types), recognised here from
 * the English (hl=en) status/reason. "Video unavailable" is deliberately NOT
 * permanent, as in BitChord (NewPipe's plain ContentNotAvailableException).
 * @returns {{category: string, message: string}|null}
 */
export function permanentVerdict(status, reason) {
  const s = (status ?? '').toUpperCase();
  const r = (reason ?? '').toLowerCase();
  if (
    ['AGE_CHECK_REQUIRED', 'AGE_VERIFICATION_REQUIRED', 'CONTENT_CHECK_REQUIRED'].includes(s) ||
    ['confirm your age', 'age-restricted', 'age restricted', 'age verification'].some((m) => r.includes(m))
  ) {
    return { category: 'age-restricted', message: 'This track is age-restricted. Sign in to YouTube to play it.' };
  }
  if (/private video|video is private/.test(r)) return { category: 'private', message: 'This track is private' };
  if (/not available in your country|not made this video available in your country|blocked it in your country/.test(r)) {
    return { category: 'geo', message: "This track isn't available in your country" };
  }
  if (/music premium|premium members/.test(r)) return { category: 'premium', message: 'This track needs YouTube Music Premium' };
  if (/requires payment|rent this video|purchase this video/.test(r)) return { category: 'paid', message: 'This track is paid content' };
  if (/(?:account|channel)[^.]*\bterminated\b/.test(r)) {
    return { category: 'terminated', message: 'The channel behind this track was terminated' };
  }
  return null;
}

// ---- Resolver --------------------------------------------------------------------

/**
 * @typedef {Object} ResolvedAudio
 * @property {string} videoId
 * @property {string} url                     googlevideo URL (with cpn)
 * @property {Record<string,string>} headers  send these with every media request
 * @property {number} itag
 * @property {string} mimeType                'audio/webm; codecs="opus"' (BitChord's Extracted.mimeType)
 * @property {string} container               'audio/webm'
 * @property {string|null} codecs             'opus'
 * @property {number} bitrate                 bits per second
 * @property {number} kbps                    floor(bitrate / 1000), as BitChord reports it
 * @property {number|null} clen               total bytes
 * @property {number|null} sampleRate
 * @property {number|null} channels
 * @property {number|null} loudnessDb         playerConfig.audioConfig.loudnessDb, else the format's
 * @property {number|null} expiresAt          `expire=` (epoch seconds); informational, not used
 * @property {string} client                  catalogue id, e.g. 'VISIONOS_0_1'
 * @property {string} clientName
 * @property {string} clientVersion
 * @property {string} profileId               InnerTubeX-style '<id>__nopo'; exclusions key on it
 * @property {number} rangeBytes              512 KiB (ANDROID_VR) or 1 MiB
 */

/**
 * The resolver: StreamResolver's caches and single flight around InnerTubeX's
 * direct pass. One instance per app (it holds the caches).
 */
export class YouTubeResolver {
  #fetch;
  #clients;
  #quality;
  #hl;
  #gl;
  #maxProbes;
  #exactProbe;
  #headerPolicy;
  #now;
  #sleep;
  #onAttempt;
  #visitorData = null;
  #visitorSessionBound = false;
  #visitorMode; // 'fetch' | 'fixed' | 'off'
  #visitorFlight = null;
  #recent = new Map(); // videoId -> {value, at}
  #unplayable = new Map(); // videoId -> {reason, category, at}
  #inFlight = new Map(); // videoId -> Promise
  #loudness = new Map(); // videoId -> dB (kept for the process, as in Kotlin)
  #minted = new Map(); // url -> {videoId, profileId, headers}
  #excluded = new Map(); // videoId -> Map(profileId -> until)

  /**
   * @param {Object} [options]
   * @param {typeof fetch} [options.fetch]
   * @param {string[]} [options.clients]      catalogue ids, tried in order (DEFAULT_CLIENT_ORDER)
   * @param {'AUTO'|'LOW'|'MP4'|'HIGH'} [options.quality]  resolver-wide, so the URL cache
   *        cannot hand one ceiling's pick to another (BitChord defect S4)
   * @param {string} [options.hl] @param {string} [options.gl]
   * @param {string|null} [options.visitorData] undefined: mint from sw.js_data (default);
   *        a string: use it as a session-bound id (only ensureVisitorData({refresh:true})
   *        replaces it); null: send none
   * @param {number} [options.maxProbes]      MAX_PROBES (3)
   * @param {boolean} [options.exactProbe]    true (default): 16 KiB probe, no wasted range; false: BitChord's
   *        full-size range, which also catches sessions that serve small ranges but 403 large ones (see probe())
   * @param {'client-ua'|'itx'} [options.mediaHeaderPolicy]
   * @param {() => number} [options.now]      monotonic ms
   * @param {(ms: number, signal?: AbortSignal) => Promise<void>} [options.sleep]
   * @param {(attempt: object) => void} [options.onAttempt] diagnostics hook, one call per client tried
   */
  constructor(options = {}) {
    this.#fetch = options.fetch ?? ((...args) => globalThis.fetch(...args));
    this.#clients = (options.clients ?? DEFAULT_CLIENT_ORDER).map((id) => {
      const client = CLIENTS[id];
      if (!client) throw new TypeError(`unknown client id: ${id}`);
      return client;
    });
    this.#quality = options.quality ?? 'AUTO';
    this.#hl = options.hl ?? 'en';
    this.#gl = options.gl ?? 'US';
    this.#maxProbes = options.maxProbes ?? MAX_PROBES;
    this.#exactProbe = options.exactProbe ?? true;
    this.#headerPolicy = options.mediaHeaderPolicy ?? 'client-ua';
    this.#now = options.now ?? (() => (globalThis.performance?.now ? performance.now() : Date.now()));
    this.#sleep = options.sleep ?? defaultSleep;
    this.#onAttempt = options.onAttempt ?? null;
    if (options.visitorData === undefined) {
      this.#visitorMode = 'fetch';
    } else if (options.visitorData === null) {
      this.#visitorMode = 'off';
    } else {
      this.#visitorMode = 'fixed';
      this.#visitorData = options.visitorData;
      this.#visitorSessionBound = true;
    }
  }

  /**
   * A probed, direct audio URL for `videoId`, or null when none of the
   * no-cipher clients has one (run a cipher-capable fallback then).
   * Throws PermanentlyUnplayableError for a verdict (cached 10 min) and
   * PlayerRequestsFailedError when every player request failed outright.
   * `signal` only abandons this caller's wait: the walk goes on for any other
   * caller and still fills the cache.
   * @param {string} videoId
   * @param {{signal?: AbortSignal}} [options]
   * @returns {Promise<ResolvedAudio|null>}
   */
  async resolve(videoId, { signal } = {}) {
    if (typeof videoId !== 'string' || videoId === '') throw new TypeError('videoId must be a non-empty string');
    const hit = this.#recent.get(videoId);
    if (hit && this.#now() - hit.at < URL_TTL_MS) return hit.value;
    const verdict = this.#unplayableVerdict(videoId);
    if (verdict) throw new PermanentlyUnplayableError(verdict.reason, verdict.category);
    return untilAborted(this.#coalesced(videoId), signal);
  }

  /** YouTube's normalisation figure for a resolved track, or null (StreamResolver.loudnessDbFor). */
  loudnessDbFor(videoId) {
    return this.#loudness.get(videoId) ?? null;
  }

  /**
   * Headers for a media fetch of `url`: what was recorded when this resolver
   * minted it (InnerTubeXResolver.headersFor), else PlayerClient's c=/cver= map.
   */
  mediaHeadersFor(url) {
    return this.#minted.get(url)?.headers ?? mediaHeadersFor(url);
  }

  /**
   * A cached URL was refused while playing (ChunkedDataSource -> here):
   * forget it and, if this resolver minted it, skip that client for the track
   * for 10 minutes. Only 403/404/410 from googlevideo count.
   */
  onPlaybackRefused(url, status) {
    if (!REFUSAL_CODES.includes(status)) return;
    const u = parseUrl(url);
    if (!u || !u.hostname.endsWith('googlevideo.com')) return;
    let videoId = null;
    const minted = this.#minted.get(url);
    if (minted) {
      this.#minted.delete(url);
      this.#exclude(minted.videoId, minted.profileId);
      videoId = minted.videoId;
    } else {
      for (const [id, entry] of this.#recent) {
        if (entry.value.url === url) { videoId = id; break; }
      }
    }
    if (videoId !== null) this.#recent.delete(videoId);
  }

  /**
   * Sign-in / sign-out (StreamResolver.onSessionChanged): verdicts,
   * exclusions and minted headers belong to the old session. A fetched
   * visitor id goes too; one supplied by the caller stays.
   */
  onSessionChanged() {
    this.#unplayable.clear();
    this.#excluded.clear();
    this.#minted.clear();
    if (this.#visitorMode === 'fetch') {
      this.#visitorData = null;
      this.#visitorSessionBound = false;
    }
  }

  /**
   * Innertube.ensureVisitorData: the current id, minting one when missing (or
   * when `refresh`). A session-bound id is never replaced by an anonymous one
   * except on refresh. Concurrent callers share one fetch.
   * @returns {Promise<string|null>}
   */
  async ensureVisitorData({ refresh = false } = {}) {
    if (this.#visitorMode === 'off') return null;
    if (!refresh && this.#visitorData !== null) return this.#visitorData;
    if (this.#visitorMode === 'fixed' && !refresh) return this.#visitorData;
    if (!this.#visitorFlight) {
      this.#visitorFlight = fetchVisitorData({ fetch: this.#fetch }).finally(() => {
        this.#visitorFlight = null;
      });
    }
    const minted = await this.#visitorFlight;
    if (minted !== null && (refresh || !this.#visitorSessionBound)) {
      this.#visitorData = minted;
      this.#visitorSessionBound = false;
    }
    return this.#visitorData;
  }

  /** Adopt a session-bound visitor id (e.g. from the signed-in shell's ytcfg). */
  setVisitorData(visitorData, { sessionBound = true } = {}) {
    this.#visitorData = visitorData;
    this.#visitorSessionBound = sessionBound;
  }

  // -- internals --

  /** One walk per videoId; unregistered by the walk's own completion (StreamResolver.kt:399-413). */
  #coalesced(videoId) {
    let walk = this.#inFlight.get(videoId);
    if (!walk) {
      walk = this.#resolveUncached(videoId).finally(() => {
        if (this.#inFlight.get(videoId) === walk) this.#inFlight.delete(videoId);
      });
      walk.catch(() => {}); // callers that left must not turn a failure into an unhandled rejection
      this.#inFlight.set(videoId, walk);
    }
    return walk;
  }

  async #resolveUncached(videoId) {
    const visitorData = await this.ensureVisitorData();
    const cpn = generateClientPlaybackNonce(); // one per extraction, as InnerTubeX does
    const attempts = [];
    const note = (attempt) => {
      attempts.push(attempt);
      try {
        this.#onAttempt?.({ videoId, ...attempt });
      } catch {
        // diagnostics must never break resolution
      }
    };
    let probes = 0;
    for (const client of this.#clients) {
      const profileId = `${client.id}__nopo`;
      if (this.#isExcluded(videoId, profileId)) {
        note({ client: client.id, outcome: 'excluded' });
        continue;
      }
      if (probes >= this.#maxProbes) break;

      let json;
      try {
        json = await this.#postPlayer(client, videoId, visitorData);
      } catch (error) {
        note({ client: client.id, outcome: error instanceof SyntaxError ? 'invalid-response' : 'request', error });
        continue;
      }
      const parsed = parsePlayerResponse(json, videoId, client);
      if (!parsed.playable) {
        note({
          client: client.id,
          outcome: parsed.matchesVideo ? 'playability' : 'wrong-video',
          status: parsed.status,
          reason: parsed.reason,
        });
        continue;
      }
      const pick = selectDirectAudio(parsed, { quality: this.#quality, clientName: client.clientName, cpn });
      if (pick.kind !== 'direct') {
        note({ client: client.id, outcome: pick.kind, playable: true, detail: pick.detail ?? null });
        continue;
      }

      const headers = this.#headersToMint(client);
      probes += 1;
      const verdict = await probe(pick.url, { ctx: { fetch: this.#fetch }, headers, exact: this.#exactProbe });
      if (verdict !== PROBE.OK) {
        note({ client: client.id, outcome: `probe:${verdict}`, playable: true, url: pick.url });
        continue;
      }

      const stream = this.#toResolved(videoId, client, profileId, parsed, pick, headers);
      note({ client: client.id, outcome: 'ok', playable: true });
      this.#rememberMinted(stream);
      if (stream.loudnessDb !== null) this.#loudness.set(videoId, stream.loudnessDb);
      // Remembered by the walk itself, so an answer that arrives after every
      // caller gave up still serves the next one (Kotlin remembers per caller).
      this.#remember(videoId, stream);
      return stream;
    }

    // As InnerTubeX's throwExtractionFailure: failures are only classified
    // when no client returned a playable response at all.
    if (!attempts.some((a) => a.playable)) {
      const permanent = attempts
        .filter((a) => a.outcome === 'playability')
        .map((a) => permanentVerdict(a.status, a.reason))
        .find((v) => v !== null);
      if (permanent) {
        this.#rememberUnplayable(videoId, permanent);
        throw new PermanentlyUnplayableError(permanent.message, permanent.category);
      }
      const answered = attempts.some((a) => a.outcome !== 'request' && a.outcome !== 'excluded');
      if (!answered && attempts.some((a) => a.outcome === 'request')) throw new PlayerRequestsFailedError(videoId, attempts);
    }
    return null;
  }

  /** One player POST: 8 s for everything, transient statuses retried twice (500 ms, 1 s). */
  async #postPlayer(client, videoId, visitorData) {
    const { url, init } = buildPlayerRequest(client, videoId, { visitorData, hl: this.#hl, gl: this.#gl });
    const deadline = timeoutSignal(undefined, PLAYER_REQUEST_TIMEOUT_MS);
    try {
      let delay = PLAYER_RETRY_DELAY_MS;
      for (let attempt = 1; ; attempt++) {
        let res;
        try {
          res = await untilAborted(
            Promise.resolve().then(() => this.#fetch(url, { ...init, signal: deadline.signal })),
            deadline.signal,
          );
        } catch (error) {
          if (deadline.signal.aborted || attempt >= PLAYER_MAX_ATTEMPTS) throw error;
          await this.#sleep(delay, deadline.signal);
          delay *= 2;
          continue;
        }
        if (TRANSIENT_STATUS_CODES.includes(res.status) && attempt < PLAYER_MAX_ATTEMPTS) {
          cancelBody(res);
          await this.#sleep(delay, deadline.signal);
          delay *= 2;
          continue;
        }
        if (res.status < 200 || res.status > 299) {
          const body = await untilAborted(res.text(), deadline.signal).catch(() => '');
          throw new HttpError(res.status, url, body);
        }
        return JSON.parse(await untilAborted(res.text(), deadline.signal)); // 8 s covers the body too
      }
    } finally {
      deadline.done();
    }
  }

  #headersToMint(client) {
    if (this.#headerPolicy === 'itx') {
      // InnerTubeExtractor.buildHeaders: nothing for these three clients.
      if (['ANDROID_VR', 'VISIONOS', 'TVHTML5_SIMPLY'].includes(client.clientName)) return {};
      return { 'User-Agent': client.userAgent, Accept: '*/*', 'Accept-Language': acceptLanguageHeader(this.#hl, this.#gl) };
    }
    return { 'User-Agent': client.userAgent };
  }

  #toResolved(videoId, client, profileId, parsed, pick, headers) {
    const format = pick.format;
    const container = format.mimeType.split(';')[0].trim();
    const codecs = extractCodecs(format.mimeType);
    return Object.freeze({
      videoId,
      url: pick.url,
      headers: Object.freeze({ ...headers }),
      itag: format.itag,
      mimeType: codecs ? `${container}; codecs="${codecs}"` : container,
      container,
      codecs,
      bitrate: format.bitrate,
      kbps: Math.trunc(format.bitrate / 1000),
      clen: pick.clen,
      sampleRate: format.audioSampleRate,
      channels: format.audioChannels,
      loudnessDb: parsed.loudnessDb ?? format.loudnessDb,
      expiresAt: extractExpire(pick.url),
      client: client.id,
      clientName: client.clientName,
      clientVersion: client.clientVersion,
      profileId,
      rangeBytes: rangeBytesFor(pick.url),
    });
  }

  /** StreamResolver.remember: when full, drop expired entries; still full, drop everything. */
  #remember(videoId, value) {
    if (this.#recent.size >= MAX_REMEMBERED) {
      const cutoff = this.#now() - URL_TTL_MS;
      for (const [id, entry] of this.#recent) if (entry.at < cutoff) this.#recent.delete(id);
      if (this.#recent.size >= MAX_REMEMBERED) this.#recent.clear();
    }
    this.#recent.set(videoId, { value, at: this.#now() });
  }

  #rememberMinted(stream) {
    if (this.#minted.size >= MAX_MINTED) this.#minted.clear(); // InnerTubeXResolver.kt:241
    this.#minted.set(stream.url, { videoId: stream.videoId, profileId: stream.profileId, headers: stream.headers });
  }

  #unplayableVerdict(videoId) {
    const entry = this.#unplayable.get(videoId);
    if (!entry) return null;
    if (this.#now() - entry.at < UNPLAYABLE_TTL_MS) return entry;
    this.#unplayable.delete(videoId);
    return null;
  }

  #rememberUnplayable(videoId, verdict) {
    if (this.#unplayable.size > MAX_REMEMBERED) this.#unplayable.clear();
    this.#unplayable.set(videoId, { reason: verdict.message, category: verdict.category, at: this.#now() });
  }

  #exclude(videoId, profileId) {
    let entries = this.#excluded.get(videoId);
    if (!entries) this.#excluded.set(videoId, (entries = new Map()));
    entries.set(profileId, this.#now() + EXCLUDE_MS);
  }

  #isExcluded(videoId, profileId) {
    const entries = this.#excluded.get(videoId);
    if (!entries) return false;
    const now = this.#now();
    for (const [id, until] of entries) if (until <= now) entries.delete(id);
    return entries.has(profileId);
  }
}
