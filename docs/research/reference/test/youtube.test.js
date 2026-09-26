// Tests for sources/youtube.js (mirrors data/innertube/StreamResolver.kt,
// InnerTubeXResolver.kt, PlayerClient.kt, Innertube.kt and InnerTubeX v0.7.0's
// client catalogue / FormatSelectors). Offline: InnerTube, sw.js_data and
// googlevideo are all fakeFetch routes.
// Independent JavaScript re-implementation of the mechanism documented in
// BITCHORD_ENGINE_RESEARCH.md (BitChord itself is GPL-3.0; InnerTubeX is GPL-3.0).
//
// Player-response fixtures carry the fields InnerTubeX's PlayerResponse model
// reads (playabilityStatus, streamingData.formats/adaptiveFormats with quoted
// numeric strings where YouTube quotes them, videoDetails, playerConfig
// .audioConfig) plus the neighbouring fields a real answer has.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeFetch, HttpError } from '../lib/http.js';
import {
  CLIENTS,
  DEFAULT_CLIENT_ORDER,
  MUSIC_ORIGIN,
  VISITOR_DATA_URL,
  WEB_USER_AGENT,
  URL_TTL_MS,
  UNPLAYABLE_TTL_MS,
  EXCLUDE_MS,
  PROBE,
  acceptLanguageHeader,
  buildPlayerRequest,
  parsePlayerResponse,
  selectBestAudioFormat,
  selectDirectAudio,
  audioFormatScore,
  qualityFor,
  hasNParameter,
  isAllowedMediaUrl,
  appendClientPlaybackNonce,
  generateClientPlaybackNonce,
  mediaHeadersFor,
  playerClientForStreamUrl,
  probe,
  parseVisitorData,
  fetchVisitorData,
  permanentVerdict,
  YouTubeResolver,
  PermanentlyUnplayableError,
  PlayerRequestsFailedError,
} from '../sources/youtube.js';

const KiB = 1024;
const MiB = 1024 * KiB;
const VIDEO = 'kJQP7kiw5Fk';
const VISITOR = 'CgtJTF9BM0ZzOHdHOCj3kI26BjIKCgJVUxIEGgAgNQ%3D%3D';

// ---- fixtures ----------------------------------------------------------------

function gvUrl({ itag, client, cver, clen, mime, n = false, host = 'rr4---sn-4g5lznek.googlevideo.com' }) {
  return (
    `https://${host}/videoplayback?expire=1790000000&ei=Zm9vYmFyYmF6&ip=203.0.113.7&id=o-AHtY8f9Qx` +
    `&itag=${itag}&source=youtube&requiressl=yes&xpc=EgVo2aDSNQ%3D%3D&mh=aB&mm=31%2C29` +
    `&mn=sn-4g5lznek%2Csn-4g5ednsz&ms=au%2Crdu&mv=m&mvi=4&pl=24&rms=au%2Cau&initcwndbps=1250000` +
    `&vprv=1&svpuc=1&mime=${encodeURIComponent(mime)}&rqh=1&gir=yes${clen ? `&clen=${clen}` : ''}` +
    `&dur=212.061&lmt=1700000000000000&mt=1789990000&fvip=4&keepalive=yes&c=${client}&cver=${cver}` +
    `${n ? '&n=Xk3RW8f_7zQ' : ''}&txp=5532434&sparams=expire%2Cei%2Cip%2Cid%2Citag%2Csource%2Crequiressl` +
    `&sig=AJfQdSswRQIhAKx&lsparams=met%2Cmh%2Cmm%2Cmn%2Cms%2Cmv%2Cmvi%2Cpl%2Crms%2Cinitcwndbps&lsig=APaTxxMwRQIh`
  );
}

const AUDIO = [
  { itag: 139, mime: 'audio/mp4; codecs="mp4a.40.5"', bitrate: 50557, clen: 1287133, rate: '22050' },
  { itag: 140, mime: 'audio/mp4; codecs="mp4a.40.2"', bitrate: 130673, clen: 3433287, rate: '44100' },
  { itag: 249, mime: 'audio/webm; codecs="opus"', bitrate: 56812, clen: 1311072, rate: '48000' },
  { itag: 250, mime: 'audio/webm; codecs="opus"', bitrate: 73386, clen: 1734541, rate: '48000' },
  { itag: 251, mime: 'audio/webm; codecs="opus"', bitrate: 139621, clen: 3441072, rate: '48000' },
];

/**
 * adaptiveFormats for one client: two video-only formats plus the audio ladder.
 * `cipher`: itags served as signatureCipher; `withN`: itags whose url keeps `n`;
 * `extra`: more audio defs (e.g. itag 774); `noLength`: drop contentLength AND clen.
 */
function adaptive({ client, cver, cipher = [], withN = [], extra = [], only = null, noLength = false }) {
  const video = [
    { itag: 137, mimeType: 'video/mp4; codecs="avc1.640028"', bitrate: 4000000, width: 1920, height: 1080, fps: 30 },
    { itag: 248, mimeType: 'video/webm; codecs="vp9"', bitrate: 2600000, width: 1920, height: 1080, fps: 30 },
  ].map((v) => ({ ...v, url: gvUrl({ itag: v.itag, client, cver, clen: 50_000_000, mime: v.mimeType.split(';')[0] }), quality: 'hd1080' }));
  const audio = [...AUDIO, ...extra]
    .filter((d) => !only || only.includes(d.itag))
    .map((d) => {
      const url = gvUrl({ itag: d.itag, client, cver, clen: noLength ? null : d.clen, mime: d.mime.split(';')[0], n: withN.includes(d.itag) });
      const base = {
        itag: d.itag,
        mimeType: d.mime,
        bitrate: d.bitrate,
        initRange: { start: '0', end: '265' },
        indexRange: { start: '266', end: '622' },
        lastModified: '1700000000000000',
        ...(noLength ? {} : { contentLength: String(d.clen) }),
        quality: 'tiny',
        projectionType: 'RECTANGULAR',
        averageBitrate: d.bitrate - 7000,
        audioQuality: 'AUDIO_QUALITY_MEDIUM',
        approxDurationMs: '212061',
        audioSampleRate: d.rate,
        audioChannels: d.channels ?? 2,
        loudnessDb: -5.23,
      };
      return cipher.includes(d.itag)
        ? { ...base, signatureCipher: `s=AOq0QJ8wRQIgWm0Xv&sp=sig&url=${encodeURIComponent(url)}` }
        : { ...base, url };
    });
  return [...video, ...audio];
}

function okResponse(videoId, clientId, { loudnessDb = -7.4, identity = videoId, ...formatOptions } = {}) {
  const c = CLIENTS[clientId];
  return {
    responseContext: { visitorData: VISITOR, serviceTrackingParams: [{ service: 'GFEEDBACK', params: [] }], maxAgeSeconds: 0 },
    playabilityStatus: { status: 'OK', playableInEmbed: true, contextParams: 'Q0FFU0FnZ0I=' },
    streamingData: {
      expiresInSeconds: '21540',
      formats: [
        {
          itag: 18,
          url: gvUrl({ itag: 18, client: c.clientName, cver: c.clientVersion, clen: 9_000_000, mime: 'video/mp4' }),
          mimeType: 'video/mp4; codecs="avc1.42001E, mp4a.40.2"',
          bitrate: 503000,
          width: 640,
          height: 360,
          quality: 'medium',
          audioSampleRate: '44100',
          audioChannels: 2,
        },
      ],
      adaptiveFormats: adaptive({ client: c.clientName, cver: c.clientVersion, ...formatOptions }),
    },
    playbackTracking: {
      videostatsPlaybackUrl: { baseUrl: 'https://s.youtube.com/api/stats/playback?cl=1&docid=' + videoId },
      videostatsWatchtimeUrl: { baseUrl: 'https://s.youtube.com/api/stats/watchtime?cl=1&docid=' + videoId },
    },
    videoDetails: {
      videoId: identity,
      title: 'Despacito',
      lengthSeconds: '212',
      channelId: 'UCxoq-PAQeAdk_zyg8YS0JqA',
      author: 'Luis Fonsi - Topic',
      musicVideoType: 'MUSIC_VIDEO_TYPE_ATV',
      isLiveContent: false,
      viewCount: '123456789',
    },
    playerConfig: {
      audioConfig: { loudnessDb, perceptualLoudnessDb: loudnessDb - 14, enablePerFormatLoudness: true },
      streamSelectionConfig: { maxBitrate: '1680000' },
    },
  };
}

const failResponse = (status, reason) => ({
  responseContext: { visitorData: VISITOR },
  playabilityStatus: {
    status,
    reason,
    errorScreen: { playerErrorMessageRenderer: { reason: { simpleText: reason } } },
    contextParams: 'Q0FFU0FnZ0I=',
  },
  trackingParams: 'CAAQu2kiEwj',
});

function swJsData(visitor = VISITOR) {
  const inner = Array(16).fill(null);
  inner[0] = 'CgtTaG9ydA'; // shaped like an id but too short
  inner[5] = { visitorData: 'CgNOTAnArrayValue_long_enough_to_match_the_pattern_xyz' }; // objects are not searched
  inner[13] = visitor; // where InnerTubeX looks: [0][2][0][0][13]
  return `)]}'\n${JSON.stringify([['yt.sw.adr', null, [[inner]], null, null, null, 'yt', 1]])}`;
}

/** A googlevideo that answers every Range with 206 audio of exactly that length. */
function honestMedia(url, init) {
  const m = /^bytes=(\d+)-(\d*)$/.exec(init.headers?.Range ?? '');
  const clen = Number(new URL(url).searchParams.get('clen') ?? 5_000_000);
  const start = m ? Number(m[1]) : 0;
  const end = m && m[2] !== '' ? Math.min(Number(m[2]), clen - 1) : clen - 1;
  return { status: 206, body: new Uint8Array(end - start + 1), headers: { 'content-type': 'audio/webm' } };
}

/**
 * The whole of YouTube in one fake. `players['NAME/version']` answers a player
 * POST for that client (default: UNPLAYABLE); `media` answers googlevideo.
 */
function youtube({ players = {}, media = honestMedia, visitor = swJsData() } = {}) {
  return fakeFetch([
    [(url) => url === VISITOR_DATA_URL, () => ({ body: visitor })],
    [
      (url) => url.startsWith(`${MUSIC_ORIGIN}/youtubei/v1/player`),
      (url, init) => {
        const body = JSON.parse(init.body);
        const key = `${body.context.client.clientName}/${body.context.client.clientVersion}`;
        const handler = players[key];
        return handler ? handler(body, init) : { body: failResponse('UNPLAYABLE', 'This video is not available') };
      },
    ],
    [(url) => new URL(url).hostname.endsWith('googlevideo.com'), (url, init) => media(url, init)],
  ]);
}

const playerCalls = (fetch) => fetch.calls.filter((c) => c.url.startsWith(`${MUSIC_ORIGIN}/youtubei/v1/player`));
const probeCalls = (fetch) => fetch.calls.filter((c) => c.url.includes('googlevideo.com'));
const clientOf = (call) => {
  const { clientName, clientVersion } = JSON.parse(call.init.body).context.client;
  return `${clientName}/${clientVersion}`;
};

function clock(start = 1_000_000) {
  let t = start;
  const now = () => t;
  now.advance = (ms) => { t += ms; };
  return now;
}

const noSleep = async () => {};

// ---- catalogue ----------------------------------------------------------------

test('client identities are InnerTubeX v0.7.0\'s, field for field', () => {
  const pick = (c) => [c.clientName, c.clientVersion, c.clientId, c.userAgent, c.osName, c.osVersion, c.deviceMake, c.deviceModel, c.androidSdkVersion, c.platform];
  assert.deepEqual(pick(CLIENTS.VISIONOS_0_1), [
    'VISIONOS', '0.1', '101',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
    'VISION_OS', '1.3', 'Apple', 'RealityDevice14,1', undefined, 'MOBILE',
  ]);
  assert.deepEqual(pick(CLIENTS.VISIONOS), [
    'VISIONOS', '1.02', '101',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 15_7_3) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15',
    'visionOS', '26.5.23O471', 'Apple', 'RealityDevice17,1', undefined, undefined,
  ]);
  assert.deepEqual(pick(CLIENTS.ANDROID_VR_1_43_32), [
    'ANDROID_VR', '1.43.32', '28',
    'com.google.android.apps.youtube.vr.oculus/1.43.32 (Linux; U; Android 12; en_US; Quest 3; Build/SQ3A.220605.009.A1; Cronet/107.0.5284.2)',
    'Android', '12', 'Oculus', 'Quest 3', '32', undefined,
  ]);
  assert.deepEqual(pick(CLIENTS.ANDROID_VR_1_61_48), [
    'ANDROID_VR', '1.61.48', '28',
    'com.google.android.apps.youtube.vr.oculus/1.61.48 (Linux; U; Android 12; en_US; Quest 3; Build/SQ3A.220605.009.A1; Cronet/132.0.6808.3)',
    'Android', '12', 'Oculus', 'Quest 3', '32', undefined,
  ]);
  assert.deepEqual(pick(CLIENTS.ANDROID_VR_1_65_10), [
    'ANDROID_VR', '1.65.10', '28',
    'com.google.android.apps.youtube.vr.oculus/1.65.10 (Linux; U; Android 12L; eureka-user Build/SQ3A.220605.009.A1) gzip',
    'Android', '12L', 'Oculus', 'Quest 3', '32', undefined,
  ]);
  assert.deepEqual(pick(CLIENTS.ANDROID_VR_NO_AUTH), [
    'ANDROID_VR', '1.61.48', '28',
    'com.google.android.apps.youtube.vr.oculus/1.61.48 (Linux; U; Android 12; en_US; Oculus Quest 3; Build/SQ3A.220605.009.A1; Cronet/132.0.6808.3)',
    undefined, undefined, undefined, undefined, undefined, undefined,
  ]);
  for (const c of Object.values(CLIENTS)) assert.equal(c.useMusicPlayerEndpoint, true);
});

test('the default order is InnerTubeX\'s automatic client, then its score order', () => {
  assert.deepEqual([...DEFAULT_CLIENT_ORDER], [
    'VISIONOS_0_1', 'VISIONOS', 'ANDROID_VR_1_43_32', 'ANDROID_VR_1_61_48', 'ANDROID_VR_1_65_10', 'ANDROID_VR_NO_AUTH',
  ]);
  assert.equal(CLIENTS.VISIONOS_0_1.itx.selectionMode, 'AUTOMATIC');
  // ContentAwareFallbackStrategy.score for normal content: base + 25 + 10 + lifecycle.
  const lifecycle = { STABLE: 0, EXPERIMENTAL: -10, UNRELEASED: -5, DEPRECATED: -20 };
  const score = (id) => CLIENTS[id].itx.priority + 35 + lifecycle[CLIENTS[id].itx.lifecycle];
  const probeOnly = DEFAULT_CLIENT_ORDER.slice(1);
  assert.deepEqual(probeOnly.map(score), [130, 97, 79, 75, 75]);
});

// ---- request ------------------------------------------------------------------

test('the player request is InnerTubeX\'s, byte for byte (ANDROID_VR 1.43.32)', () => {
  const { url, init } = buildPlayerRequest(CLIENTS.ANDROID_VR_1_43_32, VIDEO, { visitorData: VISITOR });
  assert.equal(url, 'https://music.youtube.com/youtubei/v1/player?prettyPrint=false');
  assert.equal(init.method, 'POST');
  assert.deepEqual(init.headers, {
    'Content-Type': 'application/json',
    'X-Goog-Api-Format-Version': '1',
    'X-YouTube-Client-Name': '28',
    'X-YouTube-Client-Version': '1.43.32',
    Origin: 'https://music.youtube.com',
    'X-Origin': 'https://music.youtube.com',
    Referer: 'https://music.youtube.com/',
    'Accept-Language': 'en-US,en;q=0.9',
    'X-Goog-Visitor-Id': VISITOR,
    'User-Agent': CLIENTS.ANDROID_VR_1_43_32.userAgent,
  });
  assert.equal(
    init.body,
    JSON.stringify({
      context: {
        client: {
          clientName: 'ANDROID_VR',
          clientVersion: '1.43.32',
          userAgent: CLIENTS.ANDROID_VR_1_43_32.userAgent,
          osName: 'Android',
          osVersion: '12',
          deviceMake: 'Oculus',
          deviceModel: 'Quest 3',
          androidSdkVersion: '32',
          gl: 'US',
          hl: 'en',
          visitorData: VISITOR,
        },
        request: { internalExperimentFlags: [], useSsl: true },
        user: { lockedSafetyMode: false },
      },
      videoId: VIDEO,
      contentCheckOk: true,
      racyCheckOk: true,
    }),
  );
});

test('visionOS 0.1 keeps its UA out of the context and adds platform; no visitor header when none', () => {
  const { init } = buildPlayerRequest(CLIENTS.VISIONOS_0_1, VIDEO, { hl: 'de', gl: 'DE' });
  assert.equal(init.headers['X-YouTube-Client-Name'], '101');
  assert.equal(init.headers['X-Goog-Visitor-Id'], undefined);
  assert.equal(init.headers['Accept-Language'], 'de-DE,de;q=0.9');
  const body = JSON.parse(init.body);
  assert.deepEqual(body.context.client, {
    clientName: 'VISIONOS',
    clientVersion: '0.1',
    osName: 'VISION_OS',
    osVersion: '1.3',
    deviceMake: 'Apple',
    deviceModel: 'RealityDevice14,1',
    platform: 'MOBILE',
    gl: 'DE',
    hl: 'de',
  });
  assert.equal('videoCheckOk' in body, false); // music endpoint
  assert.equal('playbackContext' in body, false); // no signatureTimestamp for these clients
});

test('Accept-Language follows YouTubeLocale.acceptLanguageHeader', () => {
  assert.equal(acceptLanguageHeader('en', 'US'), 'en-US,en;q=0.9');
  assert.equal(acceptLanguageHeader('en-GB', 'US'), 'en-GB,en;q=0.9');
  assert.equal(acceptLanguageHeader('pt_BR', 'US'), 'pt-BR,pt;q=0.9');
  assert.equal(acceptLanguageHeader('en', ''), 'en');
});

// ---- response + format selection ------------------------------------------------

test('parsePlayerResponse reads status, formats (quoted numbers) and loudness', () => {
  const parsed = parsePlayerResponse(okResponse(VIDEO, 'VISIONOS'), VIDEO, CLIENTS.VISIONOS);
  assert.equal(parsed.status, 'OK');
  assert.equal(parsed.playable, true);
  assert.equal(parsed.loudnessDb, -7.4);
  assert.equal(parsed.expiresInSeconds, 21540);
  const f251 = parsed.formats.find((f) => f.itag === 251);
  assert.equal(f251.audioSampleRate, 48000);
  assert.equal(f251.contentLength, 3441072);
  assert.equal(f251.isAudio, true);
  assert.equal(parsed.formats.find((f) => f.itag === 137).isAudio, false);
  assert.equal(parsed.formats.find((f) => f.itag === 18).isAudio, false);
});

test('playability: wrong video, missing status and non-OK answers are not playable', () => {
  assert.equal(parsePlayerResponse(okResponse(VIDEO, 'VISIONOS', { identity: 'otherVideo1' }), VIDEO, CLIENTS.VISIONOS).playable, false);
  assert.equal(parsePlayerResponse({ streamingData: {} }, VIDEO, CLIENTS.VISIONOS).playable, false);
  const bot = failResponse('LOGIN_REQUIRED', "Sign in to confirm you're not a bot");
  assert.equal(parsePlayerResponse(bot, VIDEO, CLIENTS.VISIONOS).playable, false);
  // VISIONOS_0_1 skips status validation (skipPlayerResponseValidation) but still needs audio.
  const odd = { ...okResponse(VIDEO, 'VISIONOS_0_1'), playabilityStatus: { status: 'UNPLAYABLE' } };
  assert.equal(parsePlayerResponse(odd, VIDEO, CLIENTS.VISIONOS_0_1).playable, true);
  assert.equal(parsePlayerResponse(odd, VIDEO, CLIENTS.VISIONOS).playable, false);
  assert.equal(parsePlayerResponse(bot, VIDEO, CLIENTS.VISIONOS_0_1).playable, false);
});

const audioOf = (response) => parsePlayerResponse(response, VIDEO).formats.filter((f) => f.isAudio);

test('AUTO picks the best Opus (251, or 774 when offered)', () => {
  assert.equal(selectBestAudioFormat(audioOf(okResponse(VIDEO, 'VISIONOS')), 'AUTO').itag, 251);
  const premium = okResponse(VIDEO, 'VISIONOS', { extra: [{ itag: 774, mime: 'audio/webm; codecs="opus"', bitrate: 257000, clen: 6000000, rate: '48000' }] });
  assert.equal(selectBestAudioFormat(audioOf(premium), 'AUTO').itag, 774);
});

test('LOW picks the cheapest AAC (139, else 140, else the cheapest of anything); MP4 the best AAC', () => {
  const all = audioOf(okResponse(VIDEO, 'VISIONOS'));
  assert.equal(selectBestAudioFormat(all, 'LOW').itag, 139);
  assert.equal(selectBestAudioFormat(all.filter((f) => f.itag !== 139), 'LOW').itag, 140);
  assert.equal(selectBestAudioFormat(all.filter((f) => f.itag >= 249), 'LOW').itag, 249);
  assert.equal(selectBestAudioFormat(all, 'MP4').itag, 140);
  assert.equal(selectBestAudioFormat(all.filter((f) => f.itag >= 249), 'MP4'), null);
  assert.equal(selectBestAudioFormat(all, 'HIGH').itag, 251);
});

test('audioFormatScore: stereo outweighs a little bitrate; first of equals wins', () => {
  const f = (itag, bitrate, audioChannels) => ({ itag, bitrate, audioChannels, audioSampleRate: 48000, mimeType: 'audio/webm; codecs="opus"', url: 'u' });
  assert.equal(selectBestAudioFormat([f(1, 160000, 1), f(2, 140000, 2)], 'AUTO').itag, 2);
  assert.equal(audioFormatScore(f(3, 100, null)) - audioFormatScore(f(4, 100, 1)), 25000);
  assert.equal(selectBestAudioFormat([f(5, 1000, 2), f(6, 1000, 2)], 'AUTO').itag, 5);
});

test('selectDirectAudio takes a plain URL, appends the cpn and keeps the clen', () => {
  const cpn = 'AbCdEfGhIjKlMnOp';
  const pick = selectDirectAudio(parsePlayerResponse(okResponse(VIDEO, 'VISIONOS_0_1'), VIDEO), { cpn, clientName: 'VISIONOS' });
  assert.equal(pick.kind, 'direct');
  assert.equal(pick.format.itag, 251);
  assert.ok(pick.url.endsWith(`&cpn=${cpn}`));
  assert.equal(pick.clen, 3441072);
});

test('selectDirectAudio defers to a cipher-capable fallback when it must', () => {
  const parse = (options) => parsePlayerResponse(okResponse(VIDEO, 'VISIONOS', options), VIDEO);
  const premiumCiphered = parse({
    cipher: [774],
    extra: [{ itag: 774, mime: 'audio/webm; codecs="opus"', bitrate: 257000, clen: 6000000, rate: '48000' }],
  });
  assert.equal(selectDirectAudio(premiumCiphered).kind, 'needs-cipher'); // better stream behind the cipher
  assert.equal(selectDirectAudio(parse({ cipher: [139, 140, 249, 250, 251] })).kind, 'needs-cipher');
  assert.equal(selectDirectAudio(parse({ withN: [251] })).kind, 'needs-cipher'); // `n` would be throttled
  assert.equal(selectDirectAudio(parse({ only: [] })).kind, 'no-audio');
  const noLength = parse({ noLength: true });
  assert.equal(selectDirectAudio(noLength, { clientName: 'ANDROID_VR' }).kind, 'no-length'); // bounded client
  assert.equal(selectDirectAudio(noLength, { clientName: 'VISIONOS' }).kind, 'direct');
  const offHost = parse();
  for (const f of offHost.formats) if (f.url) f.url = f.url.replace('rr4---sn-4g5lznek.googlevideo.com', 'evil.example.com');
  assert.equal(selectDirectAudio(offHost).kind, 'rejected-url');
});

test('URL rules: n detection, allowed hosts, cpn appended once before the fragment', () => {
  assert.equal(hasNParameter('https://x/videoplayback?a=1&n=abc'), true);
  assert.equal(hasNParameter('https://x/videoplayback?a=1%26n%3Dabc'), true);
  assert.equal(hasNParameter('https://x/videoplayback?a=1&cpn=abcdefghijklmnop'), false);
  assert.equal(isAllowedMediaUrl('https://rr1---sn-x.googlevideo.com/videoplayback?x=1'), true);
  assert.equal(isAllowedMediaUrl('https://rr1---sn-x.googlevideo.com:8443/videoplayback'), false);
  assert.equal(isAllowedMediaUrl('http://rr1---sn-x.googlevideo.com/videoplayback'), false);
  assert.equal(isAllowedMediaUrl('https://rr1---sn-x.googlevideo.com/other'), false);
  const cpn = generateClientPlaybackNonce();
  assert.match(cpn, /^[A-Za-z0-9_-]{16}$/);
  const url = 'https://rr1---sn-x.googlevideo.com/videoplayback?itag=251#t';
  const once = appendClientPlaybackNonce(url, cpn);
  assert.equal(once, `https://rr1---sn-x.googlevideo.com/videoplayback?itag=251&cpn=${cpn}#t`);
  assert.equal(appendClientPlaybackNonce(once, 'ZZZZZZZZZZZZZZZZ'), once);
  assert.equal(appendClientPlaybackNonce('https://example.com/videoplayback?a=1', cpn), 'https://example.com/videoplayback?a=1');
});

test('quality mapping follows InnerTubeXResolver.extract', () => {
  assert.equal(qualityFor({ requireM4a: true }), 'MP4');
  assert.equal(qualityFor({ maxKbps: 64 }), 'LOW');
  assert.equal(qualityFor({ maxKbps: 65 }), 'AUTO');
  assert.equal(qualityFor(), 'AUTO');
});

// ---- media headers (PlayerClient.forStreamUrl) ----------------------------------

test('mediaHeadersFor maps c= / cver= to the minting client like PlayerClient.kt', () => {
  const ua = (c, v) => mediaHeadersFor(gvUrl({ itag: 251, client: c, cver: v, clen: 1, mime: 'audio/webm' }))['User-Agent'];
  assert.match(ua('IOS', '21.26.4'), /^com\.google\.ios\.youtube\/21\.26\.4 /);
  assert.match(ua('IOS', '21.29.1'), /^com\.google\.ios\.youtube\/21\.29\.1 .*18_5/);
  assert.match(ua('ANDROID_VR', '1.43.32'), /vr\.oculus\/1\.43\.32 .*Cronet\/107/);
  assert.match(ua('ANDROID_VR', '1.61.48'), /vr\.oculus\/1\.65\.10 /); // PlayerClient only models 1.43.32 and 1.65.10
  assert.match(ua('ANDROID_MUSIC', '8'), /youtube\.music\/8\.39\.42 /);
  assert.match(ua('ANDROID_CREATOR', '1'), /com\.google\.android\.youtube\/21\.26\.364 /);
  assert.equal(ua('VISIONOS', '0.1'), CLIENTS.VISIONOS_0_1.userAgent);
  assert.equal(ua('VISIONOS', '1.02'), CLIENTS.VISIONOS.userAgent);
  assert.match(ua('SOMETHING_NEW', '1'), /^com\.google\.ios\.youtube\/21\.26\.4 /);
  assert.deepEqual(mediaHeadersFor(gvUrl({ itag: 251, client: 'WEB_REMIX', cver: '1', clen: 1, mime: 'audio/webm' })), {
    'User-Agent': WEB_USER_AGENT,
    Origin: 'https://music.youtube.com',
    Referer: 'https://music.youtube.com/',
  });
  assert.equal(mediaHeadersFor(gvUrl({ itag: 251, client: 'TVHTML5_SIMPLY', cver: '1', clen: 1, mime: 'audio/webm' })).Origin, 'https://www.youtube.com');
  assert.equal(mediaHeadersFor(gvUrl({ itag: 251, client: 'MWEB', cver: '1', clen: 1, mime: 'audio/webm' })).Origin, 'https://www.youtube.com');
  assert.equal(playerClientForStreamUrl('not a url').clientName, 'IOS');
  assert.equal(playerClientForStreamUrl('https://r.googlevideo.com/videoplayback').clientName, 'IOS');
});

// ---- probe ----------------------------------------------------------------------

const url251 = (client = 'VISIONOS', cver = '0.1', clen = 3441072) => gvUrl({ itag: 251, client, cver, clen, mime: 'audio/webm' });

test('the probe asks for exactly the 16 KiB it needs, 1 MiB in (D6 fixed)', async () => {
  const fetch = fakeFetch([[() => true, honestMedia]]);
  const verdict = await probe(url251(), { ctx: { fetch }, headers: { 'User-Agent': 'UA/1' } });
  assert.equal(verdict, PROBE.OK);
  assert.deepEqual(fetch.calls[0].init.headers, { 'User-Agent': 'UA/1', Range: 'bytes=1048576-1064959' });
});

test('short files are probed from 0; files under 16 KiB need only their length', async () => {
  const fetch = fakeFetch([[() => true, honestMedia]]);
  assert.equal(await probe(url251('VISIONOS', '0.1', 500_000), { ctx: { fetch } }), PROBE.OK);
  assert.equal(await probe(url251('VISIONOS', '0.1', 10_000), { ctx: { fetch } }), PROBE.OK);
  assert.deepEqual(fetch.calls.map((c) => c.init.headers.Range), ['bytes=0-16383', 'bytes=0-9999']);
});

test('exact:false reproduces BitChord\'s sizing: a full range, abandoned after 16 KiB', async () => {
  let cancelled = false;
  const ranges = [];
  const fetch = async (url, init) => {
    ranges.push(init.headers.Range);
    return new Response(
      new ReadableStream({
        pull(c) { c.enqueue(new Uint8Array(8 * KiB)); },
        cancel() { cancelled = true; },
      }),
      { status: 206, headers: { 'content-type': 'audio/webm' } },
    );
  };
  assert.equal(await probe(url251('VISIONOS', '1.02'), { ctx: { fetch }, exact: false }), PROBE.OK);
  assert.equal(await probe(url251('ANDROID_VR', '1.43.32'), { ctx: { fetch }, exact: false }), PROBE.OK);
  assert.deepEqual(ranges, ['bytes=1048576-2097151', 'bytes=1048576-1572863']);
  assert.equal(cancelled, true);
});

test('probe verdicts: refusals, disguised refusals, errors, short bodies, stalls', async () => {
  const answer = (status, type, bytes = 16 * KiB) =>
    fakeFetch([[() => true, () => ({ status, body: new Uint8Array(bytes), headers: { 'content-type': type } })]]);
  for (const status of [403, 404, 410]) assert.equal(await probe(url251(), { ctx: { fetch: answer(status, 'text/html') } }), PROBE.REFUSED);
  assert.equal(await probe(url251(), { ctx: { fetch: answer(200, 'text/html; charset=utf-8') } }), PROBE.REFUSED); // consent page
  assert.equal(await probe(url251(), { ctx: { fetch: answer(500, 'audio/webm') } }), PROBE.UNREACHABLE);
  assert.equal(await probe(url251(), { ctx: { fetch: answer(206, 'audio/webm', 1000) } }), PROBE.UNREACHABLE);
  assert.equal(await probe(url251(), { ctx: { fetch: answer(416, 'audio/webm') } }), PROBE.OK); // 416 is judged like a 2xx, as in Kotlin
  assert.equal(await probe(url251(), { ctx: { fetch: async () => { throw new TypeError('fetch failed'); } } }), PROBE.UNREACHABLE);
  const stalled = async () => new Response(new ReadableStream({ start() {} }), { status: 206, headers: { 'content-type': 'audio/webm' } });
  const started = Date.now();
  assert.equal(await probe(url251(), { ctx: { fetch: stalled }, timeoutMs: 30 }), PROBE.UNREACHABLE);
  assert.ok(Date.now() - started < 2_000);
});

// ---- visitorData ---------------------------------------------------------------------

test('parseVisitorData finds the id by shape, as Innertube.findVisitorData does', () => {
  assert.equal(parseVisitorData(swJsData()), VISITOR);
  assert.equal(parseVisitorData(`)]}'${JSON.stringify([[VISITOR]])}`.replace(`)]}'`, ")]}'x")), VISITOR); // no newline: drop 5 chars
  assert.equal(parseVisitorData(`)]}'\n[["CgtTaG9ydA", {"v": "${VISITOR}"}]]`), null);
  assert.equal(parseVisitorData('<html>'), null);
});

test('fetchVisitorData GETs sw.js_data with a desktop Chrome UA; failures are null', async () => {
  const fetch = fakeFetch([[(url) => url === VISITOR_DATA_URL, () => ({ body: swJsData() })]]);
  assert.equal(await fetchVisitorData({ fetch }), VISITOR);
  assert.equal(fetch.calls[0].init.headers['User-Agent'], WEB_USER_AGENT);
  assert.equal(await fetchVisitorData({ fetch: fakeFetch([[() => true, () => ({ status: 429, body: '' })]]) }), null);
});

// ---- resolver ---------------------------------------------------------------------------

test('resolve: visitorData, one player POST, one exact probe, a complete answer', async () => {
  const fetch = youtube({ players: { 'VISIONOS/0.1': () => ({ body: okResponse(VIDEO, 'VISIONOS_0_1') }) } });
  const resolver = new YouTubeResolver({ fetch, now: clock() });
  const s = await resolver.resolve(VIDEO);

  assert.deepEqual(fetch.calls.map((c) => new URL(c.url).hostname), ['www.youtube.com', 'music.youtube.com', 'rr4---sn-4g5lznek.googlevideo.com']);
  const post = playerCalls(fetch)[0];
  assert.equal(post.init.headers['X-Goog-Visitor-Id'], VISITOR);
  assert.equal(JSON.parse(post.init.body).context.client.visitorData, VISITOR);
  assert.equal(probeCalls(fetch)[0].init.headers.Range, 'bytes=1048576-1064959');
  assert.equal(probeCalls(fetch)[0].init.headers['User-Agent'], CLIENTS.VISIONOS_0_1.userAgent);

  assert.equal(s.videoId, VIDEO);
  assert.equal(s.client, 'VISIONOS_0_1');
  assert.equal(s.profileId, 'VISIONOS_0_1__nopo');
  assert.equal(s.itag, 251);
  assert.equal(s.mimeType, 'audio/webm; codecs="opus"');
  assert.equal(s.codecs, 'opus');
  assert.equal(s.bitrate, 139621);
  assert.equal(s.kbps, 139);
  assert.equal(s.clen, 3441072);
  assert.equal(s.sampleRate, 48000);
  assert.equal(s.loudnessDb, -7.4);
  assert.equal(s.expiresAt, 1790000000);
  assert.equal(s.rangeBytes, MiB);
  assert.match(s.url, /[?&]c=VISIONOS&cver=0\.1&/);
  assert.match(s.url, /&cpn=[A-Za-z0-9_-]{16}$/);
  assert.deepEqual(s.headers, { 'User-Agent': CLIENTS.VISIONOS_0_1.userAgent });
  assert.deepEqual(resolver.mediaHeadersFor(s.url), s.headers);
  assert.equal(resolver.loudnessDbFor(VIDEO), -7.4);
});

test('the URL cache answers for 20 minutes without any request', async () => {
  const fetch = youtube({ players: { 'VISIONOS/0.1': () => ({ body: okResponse(VIDEO, 'VISIONOS_0_1') }) } });
  const now = clock();
  const resolver = new YouTubeResolver({ fetch, now });
  const first = await resolver.resolve(VIDEO);
  const calls = fetch.calls.length;
  now.advance(URL_TTL_MS - 1);
  assert.equal(await resolver.resolve(VIDEO), first);
  assert.equal(fetch.calls.length, calls);
  now.advance(1);
  const again = await resolver.resolve(VIDEO);
  assert.notEqual(again, first);
  assert.equal(playerCalls(fetch).length, 2);
  assert.equal(fetch.calls.filter((c) => c.url === VISITOR_DATA_URL).length, 1); // the visitor id is kept
});

test('clients are walked in order until one yields a direct URL', async () => {
  const attempts = [];
  const fetch = youtube({
    players: {
      'VISIONOS/0.1': () => ({ body: failResponse('LOGIN_REQUIRED', "Sign in to confirm you're not a bot") }),
      'VISIONOS/1.02': () => ({ body: failResponse('UNPLAYABLE', 'Playback on other apps has been disabled') }),
      'ANDROID_VR/1.43.32': () => ({ body: okResponse(VIDEO, 'ANDROID_VR_1_43_32') }),
    },
  });
  const resolver = new YouTubeResolver({ fetch, now: clock(), onAttempt: (a) => attempts.push(a) });
  const s = await resolver.resolve(VIDEO);
  assert.deepEqual(playerCalls(fetch).map(clientOf), ['VISIONOS/0.1', 'VISIONOS/1.02', 'ANDROID_VR/1.43.32']);
  assert.deepEqual(playerCalls(fetch).map((c) => c.init.headers['X-YouTube-Client-Name']), ['101', '101', '28']);
  assert.deepEqual(attempts.map((a) => a.outcome), ['playability', 'playability', 'ok']);
  assert.equal(s.client, 'ANDROID_VR_1_43_32');
  assert.equal(s.rangeBytes, 512 * KiB);
  assert.deepEqual(resolver.mediaHeadersFor(s.url), { 'User-Agent': CLIENTS.ANDROID_VR_1_43_32.userAgent });
});

test('a URL that fails its probe sends the walk to the next client', async () => {
  const attempts = [];
  const fetch = youtube({
    players: {
      'VISIONOS/0.1': () => ({ body: okResponse(VIDEO, 'VISIONOS_0_1') }),
      'VISIONOS/1.02': () => ({ body: okResponse(VIDEO, 'VISIONOS') }),
    },
    // VISIONOS 0.1's URL is refused past 1 MiB, the "later-range authorization boundary".
    media: (url, init) => (url.includes('cver=0.1') ? { status: 403, body: '' } : honestMedia(url, init)),
  });
  const resolver = new YouTubeResolver({ fetch, now: clock(), onAttempt: (a) => attempts.push(a) });
  const s = await resolver.resolve(VIDEO);
  assert.equal(s.client, 'VISIONOS');
  assert.deepEqual(attempts.map((a) => a.outcome), ['probe:REFUSED', 'ok']);
});

test('at most 3 URLs are probed per resolve (INNERTUBEX_ATTEMPTS)', async () => {
  const players = Object.fromEntries(
    DEFAULT_CLIENT_ORDER.map((id) => [`${CLIENTS[id].clientName}/${CLIENTS[id].clientVersion}`, () => ({ body: okResponse(VIDEO, id) })]),
  );
  const fetch = youtube({ players, media: () => ({ status: 200, body: 'consent', headers: { 'content-type': 'text/html' } }) });
  const resolver = new YouTubeResolver({ fetch, now: clock(), visitorData: null });
  assert.equal(await resolver.resolve(VIDEO), null);
  assert.equal(probeCalls(fetch).length, 3);
  assert.equal(playerCalls(fetch).length, 3);
});

test('ciphered-only answers return null (for a cipher-capable fallback) and are not cached', async () => {
  const fetch = youtube({
    players: Object.fromEntries(
      DEFAULT_CLIENT_ORDER.map((id) => [
        `${CLIENTS[id].clientName}/${CLIENTS[id].clientVersion}`,
        () => ({ body: okResponse(VIDEO, id, { cipher: [139, 140, 249, 250, 251] }) }),
      ]),
    ),
  });
  const resolver = new YouTubeResolver({ fetch, now: clock(), visitorData: null });
  assert.equal(await resolver.resolve(VIDEO), null);
  assert.equal(probeCalls(fetch).length, 0);
  assert.equal(playerCalls(fetch).length, DEFAULT_CLIENT_ORDER.length); // each client asked once
  assert.equal(await resolver.resolve(VIDEO), null);
  assert.equal(playerCalls(fetch).length, 2 * DEFAULT_CLIENT_ORDER.length); // nothing was cached
});

test('an age gate is a verdict: thrown, remembered 10 minutes, forgotten on session change', async () => {
  const fetch = youtube({
    players: { 'VISIONOS/0.1': () => ({ body: failResponse('LOGIN_REQUIRED', 'Sign in to confirm your age') }) },
  });
  const now = clock();
  const resolver = new YouTubeResolver({ fetch, now, visitorData: null });
  await assert.rejects(resolver.resolve(VIDEO), (e) => e instanceof PermanentlyUnplayableError && e.category === 'age-restricted');
  const walked = fetch.calls.length;
  await assert.rejects(resolver.resolve(VIDEO), PermanentlyUnplayableError);
  assert.equal(fetch.calls.length, walked); // answered from memory
  resolver.onSessionChanged();
  await assert.rejects(resolver.resolve(VIDEO), PermanentlyUnplayableError);
  assert.equal(fetch.calls.length, walked * 2);
  now.advance(UNPLAYABLE_TTL_MS);
  await assert.rejects(resolver.resolve(VIDEO), PermanentlyUnplayableError);
  assert.equal(fetch.calls.length, walked * 3);
});

test('no verdict when another client did answer playable (InnerTubeX sawPlayableResponse)', async () => {
  const fetch = youtube({
    players: {
      'VISIONOS/0.1': () => ({ body: failResponse('LOGIN_REQUIRED', 'Sign in to confirm your age') }),
      'VISIONOS/1.02': () => ({ body: okResponse(VIDEO, 'VISIONOS', { cipher: [139, 140, 249, 250, 251] }) }),
    },
  });
  const resolver = new YouTubeResolver({ fetch, now: clock(), visitorData: null });
  assert.equal(await resolver.resolve(VIDEO), null); // left to the cipher-capable fallback
  assert.equal(await resolver.resolve(VIDEO), null); // and nothing was remembered as unplayable
  assert.equal(playerCalls(fetch).length, 2 * DEFAULT_CLIENT_ORDER.length);
});

test('"Video unavailable" is not a verdict (as in BitChord) and gives null', async () => {
  const fetch = youtube({ players: { 'VISIONOS/0.1': () => ({ body: failResponse('ERROR', 'Video unavailable') }) } });
  const resolver = new YouTubeResolver({ fetch, now: clock(), visitorData: null });
  assert.equal(await resolver.resolve(VIDEO), null);
  assert.equal(permanentVerdict('ERROR', 'Video unavailable'), null);
  assert.equal(permanentVerdict('LOGIN_REQUIRED', 'This video is private').category, 'private');
  assert.equal(permanentVerdict('UNPLAYABLE', 'The uploader has not made this video available in your country').category, 'geo');
  assert.equal(permanentVerdict('UNPLAYABLE', 'This video is only available to Music Premium members').category, 'premium');
  assert.equal(permanentVerdict('AGE_CHECK_REQUIRED', null).category, 'age-restricted');
  assert.equal(permanentVerdict('LOGIN_REQUIRED', "Sign in to confirm you're not a bot"), null);
});

test('when no player request gets an answer the error says so', async () => {
  const base = youtube();
  const offline = async (url, init) => {
    if (url.startsWith(MUSIC_ORIGIN)) throw new TypeError('fetch failed');
    return base(url, init);
  };
  const resolver = new YouTubeResolver({ fetch: offline, now: clock(), visitorData: null, sleep: noSleep });
  await assert.rejects(resolver.resolve(VIDEO), (e) => {
    assert.ok(e instanceof PlayerRequestsFailedError);
    assert.equal(e.attempts.length, DEFAULT_CLIENT_ORDER.length);
    assert.ok(e.attempts.every((a) => a.outcome === 'request'));
    return true;
  });
});

test('transient statuses are retried inside the 8 s budget (500 ms, then 1 s)', async () => {
  let n = 0;
  const fetch = youtube({
    players: { 'VISIONOS/0.1': () => (++n === 1 ? { status: 503, body: 'busy' } : { body: okResponse(VIDEO, 'VISIONOS_0_1') }) },
  });
  const sleeps = [];
  const resolver = new YouTubeResolver({ fetch, now: clock(), visitorData: null, sleep: async (ms) => { sleeps.push(ms); } });
  assert.equal((await resolver.resolve(VIDEO)).client, 'VISIONOS_0_1');
  assert.deepEqual(sleeps, [500]);
  assert.equal(playerCalls(fetch).length, 2);
});

test('a 4xx player answer is not retried and moves on to the next client', async () => {
  const attempts = [];
  const fetch = youtube({
    players: {
      'VISIONOS/0.1': () => ({ status: 400, body: { error: { code: 400, status: 'INVALID_ARGUMENT' } } }),
      'VISIONOS/1.02': () => ({ body: okResponse(VIDEO, 'VISIONOS') }),
    },
  });
  const resolver = new YouTubeResolver({ fetch, now: clock(), visitorData: null, onAttempt: (a) => attempts.push(a) });
  assert.equal((await resolver.resolve(VIDEO)).client, 'VISIONOS');
  assert.ok(attempts[0].error instanceof HttpError && attempts[0].error.status === 400);
  assert.equal(playerCalls(fetch).length, 2);
});

test('an answer about another video is ignored', async () => {
  const fetch = youtube({
    players: {
      'VISIONOS/0.1': () => ({ body: okResponse(VIDEO, 'VISIONOS_0_1', { identity: 'dQw4w9WgXcQ' }) }),
      'VISIONOS/1.02': () => ({ body: okResponse(VIDEO, 'VISIONOS') }),
    },
  });
  const resolver = new YouTubeResolver({ fetch, now: clock(), visitorData: null });
  assert.equal((await resolver.resolve(VIDEO)).client, 'VISIONOS');
});

test('concurrent callers share one walk (single flight)', async () => {
  const fetch = youtube({ players: { 'VISIONOS/0.1': () => ({ body: okResponse(VIDEO, 'VISIONOS_0_1') }) } });
  const resolver = new YouTubeResolver({ fetch, now: clock() });
  const [a, b] = await Promise.all([resolver.resolve(VIDEO), resolver.resolve(VIDEO)]);
  assert.equal(a, b);
  assert.equal(playerCalls(fetch).length, 1);
  assert.equal(probeCalls(fetch).length, 1);
});

test('a caller that gives up only stops waiting; the walk still fills the cache', async () => {
  const fetch = youtube({ players: { 'VISIONOS/0.1': () => ({ body: okResponse(VIDEO, 'VISIONOS_0_1') }) } });
  const resolver = new YouTubeResolver({ fetch, now: clock(), visitorData: null });
  const controller = new AbortController();
  const impatient = resolver.resolve(VIDEO, { signal: controller.signal });
  const patient = resolver.resolve(VIDEO);
  controller.abort(new Error('skipped'));
  await assert.rejects(impatient, /skipped/);
  assert.equal((await patient).client, 'VISIONOS_0_1');

  // Nobody waiting at all: the answer is still remembered for the next caller.
  const lonely = new AbortController();
  const other = 'OtherVideo1';
  const fetch2 = youtube({ players: { 'VISIONOS/0.1': () => ({ body: okResponse(other, 'VISIONOS_0_1') }) } });
  const resolver2 = new YouTubeResolver({ fetch: fetch2, now: clock(), visitorData: null });
  const gone = resolver2.resolve(other, { signal: lonely.signal });
  lonely.abort(new Error('left'));
  await assert.rejects(gone, /left/);
  await new Promise((resolve) => setTimeout(resolve, 20));
  const before = fetch2.calls.length;
  assert.equal((await resolver2.resolve(other)).client, 'VISIONOS_0_1');
  assert.equal(fetch2.calls.length, before);
});

test('a playback refusal evicts the URL and benches its client for 10 minutes', async () => {
  const fetch = youtube({
    players: {
      'VISIONOS/0.1': () => ({ body: okResponse(VIDEO, 'VISIONOS_0_1') }),
      'VISIONOS/1.02': () => ({ body: okResponse(VIDEO, 'VISIONOS') }),
    },
  });
  const now = clock();
  const resolver = new YouTubeResolver({ fetch, now, visitorData: null });
  const first = await resolver.resolve(VIDEO);

  resolver.onPlaybackRefused(first.url, 500); // not a refusal code
  resolver.onPlaybackRefused('https://cdn.example.org/x.flac?c=VISIONOS', 403); // not googlevideo
  assert.equal(await resolver.resolve(VIDEO), first);

  resolver.onPlaybackRefused(first.url, 403);
  const second = await resolver.resolve(VIDEO);
  assert.equal(second.client, 'VISIONOS'); // VISIONOS 0.1 is skipped for this track
  assert.equal(clientOf(playerCalls(fetch).at(-1)), 'VISIONOS/1.02');
  assert.deepEqual(resolver.mediaHeadersFor(first.url), mediaHeadersFor(first.url)); // no longer minted here

  now.advance(URL_TTL_MS + EXCLUDE_MS);
  assert.equal((await resolver.resolve(VIDEO)).client, 'VISIONOS_0_1'); // bench lifted, cache expired
});

test('LOW and MP4 quality pick AAC, as InnerTubeXResolver maps them', async () => {
  const players = { 'VISIONOS/0.1': () => ({ body: okResponse(VIDEO, 'VISIONOS_0_1') }) };
  const low = await new YouTubeResolver({ fetch: youtube({ players }), now: clock(), visitorData: null, quality: 'LOW' }).resolve(VIDEO);
  assert.equal(low.itag, 139);
  assert.equal(low.mimeType, 'audio/mp4; codecs="mp4a.40.5"');
  const mp4 = await new YouTubeResolver({ fetch: youtube({ players }), now: clock(), visitorData: null, quality: 'MP4' }).resolve(VIDEO);
  assert.equal(mp4.itag, 140);
  assert.equal(mp4.kbps, 130);
});

test('visitorData is optional: null sends none, a string is used as given', async () => {
  const players = { 'VISIONOS/0.1': () => ({ body: okResponse(VIDEO, 'VISIONOS_0_1') }) };
  const none = youtube({ players });
  await new YouTubeResolver({ fetch: none, now: clock(), visitorData: null }).resolve(VIDEO);
  assert.equal(none.calls.some((c) => c.url === VISITOR_DATA_URL), false);
  assert.equal(playerCalls(none)[0].init.headers['X-Goog-Visitor-Id'], undefined);

  const given = youtube({ players });
  const own = 'CgtPd25WaXNpdG9ySWRfX19fX19fX19fX19fX19fX19fXw%3D%3D';
  await new YouTubeResolver({ fetch: given, now: clock(), visitorData: own }).resolve(VIDEO);
  assert.equal(given.calls.some((c) => c.url === VISITOR_DATA_URL), false);
  assert.equal(playerCalls(given)[0].init.headers['X-Goog-Visitor-Id'], own);
});

test('a failed visitor fetch does not block resolution', async () => {
  const fetch = youtube({
    players: { 'VISIONOS/0.1': () => ({ body: okResponse(VIDEO, 'VISIONOS_0_1') }) },
    visitor: '<!doctype html>',
  });
  const s = await new YouTubeResolver({ fetch, now: clock() }).resolve(VIDEO);
  assert.equal(s.client, 'VISIONOS_0_1');
  assert.equal(playerCalls(fetch)[0].init.headers['X-Goog-Visitor-Id'], undefined);
});

test('mediaHeaderPolicy "itx" reproduces InnerTubeX\'s empty header map for these clients', async () => {
  const fetch = youtube({ players: { 'VISIONOS/0.1': () => ({ body: okResponse(VIDEO, 'VISIONOS_0_1') }) } });
  const resolver = new YouTubeResolver({ fetch, now: clock(), visitorData: null, mediaHeaderPolicy: 'itx' });
  const s = await resolver.resolve(VIDEO);
  assert.deepEqual(s.headers, {});
  assert.deepEqual(resolver.mediaHeadersFor(s.url), {}); // an empty map still wins, like Kotlin's `?:`
  assert.deepEqual(probeCalls(fetch)[0].init.headers, { Range: 'bytes=1048576-1064959' });
});

test('exactProbe:false restores BitChord\'s full-size probe range', async () => {
  const fetch = youtube({ players: { 'VISIONOS/0.1': () => ({ body: okResponse(VIDEO, 'VISIONOS_0_1') }) } });
  await new YouTubeResolver({ fetch, now: clock(), visitorData: null, exactProbe: false }).resolve(VIDEO);
  assert.equal(probeCalls(fetch)[0].init.headers.Range, 'bytes=1048576-2097151');
});
