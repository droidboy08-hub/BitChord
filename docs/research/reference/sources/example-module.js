// Example BitChord "module": a skeleton showing the exact contract a JavaScript
// source module has to meet. It talks to a fictional catalogue API at
// api.example-music.test; replace the three fetch() calls with a real backend.
//
// The contract is the one enforced by BitChord's
//   data/sources/module/QuickJsExecutor.kt   (how the file is loaded and called)
//   data/sources/module/ModuleManager.kt     (the arguments each export receives)
//   data/sources/module/ModuleResults.kt     (the shapes each export must return)
//   data/sources/ModuleSource.kt             (how those shapes are interpreted)
// and by moduleHost.js in this folder, which loads this file in its tests.
//
// Independent JavaScript re-implementation of the mechanism documented in BITCHORD_ENGINE_RESEARCH.md (BitChord itself is GPL-3.0).
//
// ── How a host runs this file ────────────────────────────────────────────────
//
//  1. The file is downloaded (from the module index's `download` URL) and
//     evaluated in a fresh engine: QuickJS in BitChord, a node:vm context in
//     moduleHost.js. Neither has Node or browser APIs. What exists:
//       fetch(url, { method, headers, body, signal })  text bodies only; the
//           response has ok, status, json(), text(), headers.get(). json() and
//           text() return values, not promises (await works on both).
//       console.log / info / warn / error
//       setTimeout(fn, ms) (returns a promise), clearTimeout
//       AbortController (signal.aborted is checked once, before the request)
//       URL (a small parser), atob, Promise.any / allSettled, Object.assign
//     There is no require(), no import, no TextEncoder, no crypto, no btoa.
//  2. The `export` keywords are removed and the code runs inside a function
//     with `module`, `exports` and `self` in scope. BitChord keeps whatever
//     ends up on module.exports, and only if it has searchTracks or
//     getTrackStreamUrl. So the file must assign module.exports itself (see the
//     bottom): with only ES exports it loads in BitChord with no functions.
//  3. The engine stays resident: up to 3 engines per module, 12 modules. State
//     kept at the top level (a token, a session) survives between calls, but
//     each engine has its own copy, and a call can land on any of them.
//  4. Each call's answer is JSON.stringify'd by the host. Return plain data:
//     no functions, no class instances, no undefined where a value is expected.
//     A thrown error becomes { error: message }, which BitChord treats as "no
//     result" (and caches for 10 min / 5 min; moduleHost.js does not cache it).
//
// ── Quality words BitChord understands ───────────────────────────────────────
//
//  A quality label is read by substring, upper-cased, in this order:
//    lossless: LOSSLESS, FLAC, ALAC, HI-RES, HI_RES, HIRES, 24-BIT, 16-BIT, WAV
//    low:      LOW, 128, 96KBPS, 64
//    high:     HIGH, 320, MP3, AAC, M4A, OPUS, OGG
//  and an Atmos stream is recognised from ATMOS, EAC3_JOC or EC-3 in the
//  stream's audioQuality.

const API = 'https://api.example-music.test/v1';
const CLIENT_ID = 'replace-with-your-client-id';

// Module-level state survives between calls in the same engine.
let session = { token: null, expiresAt: 0 };

async function accessToken() {
  if (session.token && Date.now() < session.expiresAt) return session.token;
  const res = await fetch(API + '/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: { client_id: CLIENT_ID }, // objects are JSON.stringify'd by fetch()
  });
  if (!res.ok) throw new Error('token request failed: HTTP ' + res.status);
  const data = await res.json();
  session = { token: data.access_token, expiresAt: Date.now() + Math.max(0, data.expires_in - 60) * 1000 };
  return session.token;
}

async function api(path) {
  const res = await fetch(API + path, {
    headers: { Authorization: 'Bearer ' + (await accessToken()), Accept: 'application/json' },
  });
  // Throw for failures (network, auth, 5xx) so the host does not mistake them
  // for "this catalogue has no such track".
  if (!res.ok) throw new Error(path.split('?')[0] + ' failed: HTTP ' + res.status);
  return res.json();
}

function setting(context, key) {
  const settings = (context && context.settings) || {};
  // Settings arrive wrapped: context.settings.<key>.value, always a string.
  return settings[key] && settings[key].value !== undefined ? settings[key].value : undefined;
}

/**
 * searchTracks(query, limit, context)
 *
 *   query    string. BitChord sends "<clean title> <primary artist>" and then
 *            "<clean title>", lower-cased (see trackMatcher.js#queries). The
 *            artist part keeps its punctuation, so quotes and backslashes can
 *            occur. BitChord splices the query into JS source unescaped, and
 *            such a query breaks the call there (defect S1); moduleHost.js
 *            passes it intact as a JSON value.
 *   limit    number of rows wanted (BitChord asks for 15 when matching).
 *   context  { settings: {} }. BitChord passes no settings to search.
 *
 * Returns { tracks: [...], total }. Per row:
 *   id                  string, required: handed back to getTrackStreamUrl. Must not contain "::".
 *   title, artist       strings; artist may list several ("A, B & C").
 *   album               string ("" if unknown).
 *   albumCover          URL string or null.
 *   duration            WHOLE seconds, an integer (BitChord's parser rejects the whole
 *                       answer on 240.5). The runtime is the strongest matching signal:
 *                       rows more than 30 s off the track being matched are refused.
 *   audioQuality        what THIS row's copy is: "LOSSLESS", "HI_RES_LOSSLESS", "HIGH",
 *                       "FLAC 24-bit / 96 kHz", "320kbps" ... (read before availableQualities).
 *   format              codec of the row's copy when known: "flac", "mp3", "aac".
 *   availableQualities  tiers the row could be asked for, e.g. ["LOSSLESS", "HIGH", "LOW"].
 *                       Only consulted when audioQuality and format say nothing.
 *   artistId, albumId, trackNumber  optional.
 */
export async function searchTracks(query, limit, context) {
  const data = await api('/search?q=' + encodeURIComponent(query) + '&limit=' + encodeURIComponent(limit));
  const items = Array.isArray(data.items) ? data.items : [];
  const tracks = items.slice(0, limit).map(function (item) {
    const lossless = item.lossless === true;
    return {
      id: String(item.id),
      title: String(item.title || ''),
      artist: (item.artists || []).map(function (a) { return a.name; }).join(', '),
      album: (item.album && item.album.title) || '',
      albumCover: (item.album && item.album.cover) || null,
      duration: Math.round((item.duration_ms || 0) / 1000),
      audioQuality: item.hires ? 'HI_RES_LOSSLESS' : lossless ? 'LOSSLESS' : 'HIGH',
      format: lossless ? 'flac' : 'aac',
      availableQualities: lossless ? ['LOSSLESS', 'HIGH', 'LOW'] : ['HIGH', 'LOW'],
      trackNumber: item.track_number || 0,
    };
  });
  return { tracks: tracks, total: typeof data.total === 'number' ? data.total : tracks.length };
}

/**
 * getTrackStreamUrl(id, quality, context)
 *
 *   id       a row id this module returned from searchTracks.
 *   quality  "LOSSLESS" | "HIGH" | "LOW". Also sent as context.settings.quality.value;
 *            prefer the setting, fall back to the argument.
 *   context  { settings: {
 *              quality:      { value: "LOSSLESS" | "HIGH" | "LOW" },
 *              fallbackMode: { value: "strict" | "flexible" },  strict for every LOSSLESS request
 *              dolbyAtmos:   { value: "true" | "false" }        a STRING: device and user both allow Atmos
 *            } }
 *
 * Returns { streamUrl, track: { id, audioQuality, mimeType, bitDepth, sampleRate, bitrate, audioModes } }.
 *   streamUrl    an absolute http(s) URL of the audio file or DASH/HLS manifest.
 *                null (no error) is a clean miss. Anything that is not a parseable
 *                http(s) URL, or that repeats its own origin inside itself, is refused.
 *   audioQuality the tier actually served. Name it honestly: when this says
 *                HIGH, BitChord records 320 kbps unless bitrate says otherwise.
 *   mimeType     optional, and read FIRST: its subtype becomes the codec verbatim.
 *                "audio/flac" → flac (lossless). "audio/mp4" → mp4 (lossy), so do not
 *                send audio/mp4 for FLAC-in-MP4; "audio/eac3" → not Atmos. When unsure,
 *                leave it out and let audioQuality or the URL extension speak.
 *   bitDepth     integer, e.g. 16 or 24.
 *   sampleRate   Hz (numbers under 1000 are read as kHz).
 *   bitrate      kbps, not bps (a module's bitrate is taken as kbps as-is).
 *   audioModes   e.g. ["STEREO"]. Parsed but not used for Atmos detection: say
 *                ATMOS / EAC3_JOC in audioQuality instead.
 *
 * In strict mode, answer a lossless request you cannot meet with
 * { streamUrl: null } at once instead of walking down to a lossy copy: the
 * resolver has other sources to try and knows which of them advertised a FLAC.
 */
export async function getTrackStreamUrl(id, quality, context) {
  const wanted = String(setting(context, 'quality') || quality || 'HIGH').toUpperCase();
  const strict = setting(context, 'fallbackMode') === 'strict';
  const atmosAllowed = setting(context, 'dolbyAtmos') === 'true';

  const offer = await api(
    '/tracks/' + encodeURIComponent(id) + '/stream?quality=' + encodeURIComponent(wanted) +
      '&immersive=' + (atmosAllowed ? '1' : '0'),
  );
  if (!offer || !offer.url) return { streamUrl: null, track: null };

  if (offer.immersive && atmosAllowed) {
    return {
      streamUrl: offer.url,
      // No mimeType here on purpose: "audio/eac3" would be read as plain E-AC-3.
      track: { id: String(id), audioQuality: 'DOLBY_ATMOS', mimeType: null, bitDepth: null,
        sampleRate: offer.sample_rate || 48000, bitrate: offer.kbps || null, audioModes: ['DOLBY_ATMOS'] },
    };
  }

  const lossless = offer.codec === 'flac' || offer.codec === 'alac';
  if (wanted === 'LOSSLESS' && !lossless && strict) {
    // Strict: fail fast; do not hand back the lossy copy the backend fell to.
    return { streamUrl: null, track: null };
  }

  if (lossless) {
    return {
      streamUrl: offer.url,
      track: { id: String(id), audioQuality: offer.bit_depth > 16 ? 'HI_RES_LOSSLESS' : 'LOSSLESS',
        mimeType: 'audio/' + offer.codec, bitDepth: offer.bit_depth || 16,
        sampleRate: offer.sample_rate || 44100, bitrate: null, audioModes: ['STEREO'] },
    };
  }
  return {
    streamUrl: offer.url,
    track: { id: String(id), audioQuality: offer.kbps && offer.kbps <= 128 ? 'LOW' : 'HIGH',
      mimeType: offer.codec === 'aac' ? 'audio/aac' : null, bitDepth: null,
      sampleRate: offer.sample_rate || null, bitrate: offer.kbps || null, audioModes: ['STEREO'] },
  };
}

// What BitChord actually reads. Guarded so the file also imports as a plain ES
// module (there, `module` does not exist).
if (typeof module !== 'undefined' && module && typeof module === 'object') {
  module.exports = { searchTracks: searchTracks, getTrackStreamUrl: getTrackStreamUrl };
}
