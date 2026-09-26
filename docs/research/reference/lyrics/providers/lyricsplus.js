// LyricsPlus provider ('lyrics_plus'): syllable-timed lyrics from the open
// backend behind the YouLy+ extension, which aggregates Apple Music, QQ Music
// and Musixmatch.
//
// Mirrors BitChord's data/lyrics/LyricsPlus.kt.
// Independent JavaScript re-implementation of the mechanism documented in
// BITCHORD_ENGINE_RESEARCH.md (BitChord itself is GPL-3.0).
//
// Protocol: the same key-less GET is sent to every volunteer mirror at once,
//   GET <mirror>/v2/lyrics/get?title=&artist=[&duration=<whole s>][&album=][&isrc=]
// and the first mirror to answer with at least one usable line wins; a mirror
// that fails, times out (6 s) or has nothing for this track just drops out of
// the race. The winner is remembered and listed first next time, which only
// decides ties: every lookup still asks every mirror (as BitChord does).
// Losing requests are aborted as soon as there is a winner.
//
// Response (v2):
//   { "type": "Word"|"Line"|…,
//     "metadata": { "agents": { "<id>": { "type": "person"|"group"|"other", "alias": "v1" } } },
//     "lyrics": [ { "time": 27395, "duration": 1565, "text": "…",
//                   "syllabus": [ { "time": 27395, "duration": 154, "text": "e" }, … ],
//                   "element": { "singer": "v1" }  // or, older shape: ["opposite", …]
//                 } ] }
// Times are integer milliseconds. Syllables glue into words on the API's own
// trailing space; a line without syllables is line-synced, its `duration`
// giving its end. Background vocals arrive inside the text as "(…)", which the
// repository-level withBackgroundVocals pass splits off later.
//
// Deliberate difference: BitChord decodes the payload against a typed schema,
// so one malformed field anywhere (except `element`, read raw on purpose)
// discards the whole response; this reads each field defensively instead.

import { line } from '../model.js';
import { lineAlignments, withInstrumentalGaps } from '../postprocess.js';
import { childController, isBlank, isObject, jsonContent, jsonLong, lyricsGet, parseJson, query, secondsOf } from './plumbing.js';

/** LyricsPlus.kt:33-40, in BitChord's order. */
export const MIRRORS = Object.freeze([
  'https://lyricsplus.prjktla.my.id',
  'https://lyricsplus.atomix.one',
  'https://lyricsplus.binimum.org',
  'https://lyricsplus.prjktla.workers.dev',
  'https://lyricsplus-seven.vercel.app',
  'https://lyrics-plus-backend.vercel.app',
]);

/**
 * A LyricsPlus provider with its own memory of the last mirror that worked.
 * @param {{ mirrors?: readonly string[] }} [options]
 * @returns {import('../model.js').LyricsProvider & { readonly lastGood: string|null }}
 */
export function createLyricsPlusProvider({ mirrors = MIRRORS } = {}) {
  let lastGood = null;
  return {
    id: 'lyrics_plus',
    label: 'LyricsPlus',
    wordSynced: true,
    get lastGood() {
      return lastGood;
    },
    lyrics: async (q, ctx) => {
      const hosts = lastGood ? [lastGood, ...mirrors.filter((m) => m !== lastGood)] : [...mirrors];
      const winner = await race(hosts, q, ctx);
      if (!winner) return null;
      lastGood = winner.host;
      return winner.lines;
    },
  };
}

/** @type {import('../model.js').LyricsProvider[]} */
export const providers = [createLyricsPlusProvider()];

/**
 * Asks every host at once; resolves with the first usable answer, or null
 * once all have missed (LyricsPlus.kt:50-77). Rejects if the caller aborts.
 */
async function race(hosts, q, ctx) {
  const { controller, release } = childController(ctx?.signal);
  const raceCtx = { ...ctx, signal: controller.signal };
  try {
    return await new Promise((resolve, reject) => {
      let pending = hosts.length;
      if (pending === 0) resolve(null);
      for (const host of hosts) {
        fetchFromMirror(host, q, raceCtx).then(
          (lines) => {
            if (lines) resolve({ host, lines });
            else if (--pending === 0) resolve(null);
          },
          reject, // the caller aborted, or something unexpected broke
        );
      }
    });
  } finally {
    controller.abort(); // the losers are no longer worth waiting on
    release();
  }
}

/** The request URL (LyricsPlus.kt:87-99). The ISRC is sent alongside the name, not instead of it. */
export function requestUrl(host, q) {
  const seconds = secondsOf(q.durationMs);
  return `${host}/v2/lyrics/get?${query({
    title: q.title ?? '',
    artist: q.artist ?? '',
    duration: seconds > 0 ? seconds : null,
    album: isBlank(q.album) ? null : q.album,
    isrc: isBlank(q.isrc) ? null : q.isrc,
  })}`;
}

async function fetchFromMirror(host, q, ctx) {
  const body = await lyricsGet(ctx, requestUrl(host, q));
  if (body == null) return null;
  const response = parseJson(body);
  if (!isObject(response)) return null;
  const lines = parseLyricsPlus(response);
  return lines.length > 0 ? lines : null;
}

/**
 * A v2 response → lines (LyricsPlus.kt:107-143): word-synced where the line
 * has syllables, line-synced where it only has text, sorted by start, sides
 * from the named voices (or the older "opposite"/"right" tag), gaps added.
 * @param {object} response
 * @returns {import('../model.js').LyricLine[]}
 */
export function parseLyricsPlus(response) {
  const sung = [];
  for (const row of Array.isArray(response.lyrics) ? response.lyrics : []) {
    if (!isObject(row)) continue;
    const start = jsonLong(row.time);
    if (start == null) continue;
    const words = mergeSyllables(Array.isArray(row.syllabus) ? row.syllabus : []);
    let built = null;
    if (words.length > 0) {
      built = line(Math.min(start, words[0].startMs), words.map((w) => w.text).join(' '), words);
    } else if (typeof row.text === 'string' && row.text.trim() !== '') {
      // Line-synced: the duration is the only end it gets, and without one an
      // interlude cannot be told from a slowly sung line.
      const duration = jsonLong(row.duration);
      built = line(start, row.text.trim(), [], { sungUntilMs: duration != null && duration > 0 ? start + duration : null });
    }
    if (built) sung.push({ line: built, element: row.element });
  }
  sung.sort((a, b) => a.line.timeMs - b.line.timeMs);

  const sides = lineAlignments(sung.map((s) => singerOf(s.element)), agentTypes(response));
  return withInstrumentalGaps(sung.map((s, i) => ({
    ...s.line,
    // A payload that names no voices can still mark a line as the answering
    // side, which is how the older shape of the API said it.
    alignment: sides[i] === 'end' || saysOpposite(s.element) ? 'end' : 'start',
  })));
}

/**
 * Glues syllables back into words (LyricsPlus.kt:173-193). The API's own
 * trailing space is the word boundary: it sends "e" then "nough ", and only
 * the space says those are one word. A word runs from its first syllable's
 * start to its last syllable's start + duration.
 */
function mergeSyllables(syllables) {
  const words = [];
  let current = '';
  let start = 0;
  let end = 0;
  for (const syllable of syllables) {
    if (!isObject(syllable) || typeof syllable.text !== 'string' || syllable.text.trim() === '') continue;
    const time = jsonLong(syllable.time);
    if (time == null) continue;
    if (current === '') start = time;
    current += syllable.text.trim();
    end = time + (jsonLong(syllable.duration) ?? 0);
    if (/\s$/.test(syllable.text)) {
      words.push({ startMs: start, endMs: end, text: current });
      current = '';
    }
  }
  if (current !== '') words.push({ startMs: start, endMs: end, text: current });
  return words;
}

/** The voice that sang a line: `element.singer` on the current API shape (LyricsPlus.kt:151-152). */
function singerOf(element) {
  return isObject(element) ? jsonContent(element.singer) : null;
}

/** The older shape: `element` as an array of tags, one of which may be the side (LyricsPlus.kt:155-164). */
function saysOpposite(element) {
  return Array.isArray(element) && element.some((tag) => tag === 'opposite' || tag === 'right');
}

/**
 * Declared voices, keyed the way lines refer to them — by alias where one is
 * given (LyricsPlus.kt:205-210).
 */
function agentTypes(response) {
  const types = new Map();
  const agents = isObject(response.metadata) && isObject(response.metadata.agents) ? response.metadata.agents : {};
  for (const [id, agent] of Object.entries(agents)) {
    if (!isObject(agent) || typeof agent.type !== 'string') continue;
    types.set(typeof agent.alias === 'string' ? agent.alias : id, agent.type);
  }
  return types;
}
