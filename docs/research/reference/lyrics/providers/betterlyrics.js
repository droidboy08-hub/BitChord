// BetterLyrics providers: 'better_lyrics' (Apple Music TTML) and
// 'better_lyrics_portato' (QQ Music karaoke timing through BetterLyrics'
// "Portato" endpoint).
//
// Mirrors BitChord's data/lyrics/BetterLyrics.kt; the response is read by
// ../formats/provider-payload.js (ProviderLyrics.kt).
// Independent JavaScript re-implementation of the mechanism documented in
// BITCHORD_ENGINE_RESEARCH.md (BitChord itself is GPL-3.0).
//
// Protocol: one key-less GET, matched entirely server-side on the name:
//   GET https://lyrics-api.boidu.dev/getLyrics?s=<title>&a=<artist>[&d=<whole s>][&al=<album>]
//   GET https://lyrics-api.boidu.dev/qq/getLyrics?…same parameters…
// The body is a JSON envelope around the lyric document — `{"ttml": "<tt …>"}`
// for the Apple endpoint — and is format-sniffed rather than trusted: TTML,
// QQ QRC / NetEase YRC karaoke, enhanced LRC, LRC or plain text all parse. A
// miss is a non-2xx status or an envelope with no lyric text in it.
//
// This is the BetterLyrics extension's original host. Its newer Cloudflare API
// sits behind a Turnstile challenge, which a native client cannot answer.

import { parseProviderLyrics } from '../formats/provider-payload.js';
import { isBlank, lyricsGet, query, secondsOf } from './plumbing.js';

export const BASE = 'https://lyrics-api.boidu.dev/getLyrics';
export const PORTATO = 'https://lyrics-api.boidu.dev/qq/getLyrics';

/**
 * BetterLyrics.kt:46-54. Duration is sent only when known; album only when
 * non-blank.
 * @param {string} endpoint
 * @param {import('../model.js').LyricsQuery} q
 */
export function requestUrl(endpoint, q) {
  const seconds = secondsOf(q.durationMs);
  return `${endpoint}?${query({
    s: q.title ?? '',
    a: q.artist ?? '',
    d: seconds > 0 ? seconds : null,
    al: isBlank(q.album) ? null : q.album,
  })}`;
}

async function fetchLyrics(endpoint, q, ctx) {
  const body = await lyricsGet(ctx, requestUrl(endpoint, q));
  return body == null ? null : parseProviderLyrics(body);
}

/** @type {import('../model.js').LyricsProvider[]} */
export const providers = [
  {
    id: 'better_lyrics',
    label: 'BetterLyrics',
    wordSynced: true,
    lyrics: (q, ctx) => fetchLyrics(BASE, q, ctx),
  },
  {
    id: 'better_lyrics_portato',
    label: 'BetterLyrics Portato',
    wordSynced: true,
    lyrics: (q, ctx) => fetchLyrics(PORTATO, q, ctx),
  },
];
