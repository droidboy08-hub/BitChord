// Cross-catalogue matching: is this catalogue row the same recording as the
// track being played, and what should a catalogue be asked for in the first place?
//
// Mirrors BitChord's `data/sources/TrackMatcher.kt`, plus the resolver-level
// filters that `data/sources/SourceResolver.kt` layers on top of it
// (SAME_RECORDING_SEC, UPGRADE_DRIFT_SEC, requireSharedArtist).
//
// Independent JavaScript re-implementation of the mechanism documented in BITCHORD_ENGINE_RESEARCH.md (BitChord itself is GPL-3.0).
//
// Shapes used here:
//
//   Target    { title, artist = '', durationSec = null, album = null,
//               explicit = null, isVideo = false }
//   Candidate { title, artist, album?, explicit?, durationSec? | durationText? }
//               durationSec is whole seconds; durationText is "m:ss" or
//               "h:mm:ss" (what BitChord's Song carries). 0 means unknown.
//
// Argument order: the Kotlin is score(candidate, target) / ranked(candidates,
// target); this module takes the target first everywhere.
//
// Regex dialect: on Android, java.util.regex is backed by ICU, where \b and \s
// are Unicode-aware (\w = letters, marks and digits of every script). JavaScript's
// \b only knows [A-Za-z0-9_], which would, for example, split the artist "Ñandú"
// at "and". The patterns below therefore spell out ICU's definitions.

// ── Constants (TrackMatcher.kt:562-671) ─────────────────────────────────────

/** Everything that reaches scoring has already matched on title and version. */
export const BASE = 100;
export const ARTIST_EXACT = 25;
export const ARTIST_SHARED = 10;
/** Carried by a match the runtime vouched for rather than the credit. */
export const CREDITS_DISAGREE = -30;
/** How exactly two runtimes must agree before that may stand in for a shared credit. */
export const CREDIT_OVERRIDE_SEC = 2;
export const DURATION_TIGHT = 40;
export const DURATION_LOOSE = 15;
export const ALBUM_EXACT = 35;
export const EXPLICIT_EXACT = 20;
export const CONTEXT_SHARED = 20;
/** Within this many seconds is the same master, allowing for trimmed silence. */
export const DURATION_TIGHT_SEC = 3;
/** Past this, two tracks sharing a title are not sharing a recording. */
export const DURATION_LIMIT_SEC = 30;
/** Visual intros/outros can make a video much longer than its audio master. */
export const VIDEO_DURATION_LIMIT_SEC = 90;
export const BRACKET_PASSES = 3;
export const DASH_PASSES = 3;

// Resolver-level thresholds (SourceResolver.kt:1122, 1131).
/** A replacement cut into a playing track must agree on runtime to this many seconds. */
export const UPGRADE_DRIFT_SEC = 2;
/** Rows within this many seconds of the target are the same cut; the rest drop out. */
export const SAME_RECORDING_SEC = 3;

/** Words that mean a different take. On one side only, the pair is refused. */
export const VERSION_WORDS = Object.freeze(new Set([
  'remix', 'remixes', 'rmx', 'refix', 'flip', 'bootleg', 'mashup', 'medley',
  'live', 'concert', 'unplugged', 'acoustic', 'instrumental', 'karaoke',
  'vocals', 'vocal', 'acapella', 'acappella', 'backing', 'stems', 'stem',
  'cover', 'demo', 'reprise', 'remake', 'rework', 'extended', 'edit',
  'version', 'mix', 'dub', 'vip', 'session', 'sessions',
  'sped', 'slowed', 'reverb', 'nightcore', 'lofi', 'orchestral', 'symphonic',
  'part', 'pt', 'chapter',
]));

/** Asides that read like a version but describe the ordinary release. */
export const NEUTRAL_SEGMENTS = Object.freeze(new Set([
  'albumversion', 'originalversion', 'originalmix', 'singleversion',
  'radioversion', 'radioedit', 'stereoversion', 'monoversion',
  'studioversion', 'fullversion', 'standardversion', 'explicitversion',
  'deluxeversion', 'originaltrack',
]));

/** Packaging words, worth nothing as a tie-break because everything has them. */
export const NOISE_WORDS = Object.freeze(new Set([
  'official', 'video', 'audio', 'lyrics', 'lyric', 'lyrical', 'visualizer',
  'song', 'songs', 'full', 'music', 'the', 'and', 'from', 'feat', 'ft',
  'featuring', 'with', 'new', 'latest', 'free', 'download', 'remaster',
  'remastered', 'explicit', 'clean', 'bonus', 'track', 'deluxe', 'original',
  'album', 'single', 'hd', 'hq', '4k', 'mp3',
]));

export const ALBUM_NOISE_WORDS = Object.freeze(new Set([
  'album', 'deluxe', 'edition', 'expanded', 'remaster', 'remastered',
  'version', 'explicit', 'clean', 'bonus', 'anniversary',
]));

/** Trailing labels an upload hangs on a title with no brackets to hold them. */
export const TRAILING_NOISE = Object.freeze(new Set([
  'song', 'songs', 'video', 'audio', 'lyrics', 'lyric', 'lyrical',
  'official', 'full', 'hd', 'hq', '4k', 'mp3', 'ost', 'soundtrack',
]));

/** Dropped from the core so "Jack and Jill" and "Jack & Jill" are one title. */
export const JOINING_WORDS = Object.freeze(new Set(['and']));

// ── Patterns (TrackMatcher.kt:612-618), in ICU's Unicode-aware dialect ─────

/** ICU's \w: [\p{Alphabetic}\p{Mark}\p{Decimal_Number}\p{Connector_Punctuation}‌‍]. */
const W = String.raw`[\p{Alphabetic}\p{M}\p{Nd}\p{Pc}‌‍]`;
/** ICU's \b: a transition between \w and \W. */
const B = String.raw`(?:(?<=${W})(?!${W})|(?<!${W})(?=${W}))`;
/** ICU's \s: [\t\n\f\r\p{Z}]. */
const S = String.raw`[\t\n\f\r\p{Z}]`;

const BRACKETED = /[(\[]([^()\[\]]*)[)\]]/g;
const BRACKETED_TEST = /[(\[]([^()\[\]]*)[)\]]/;
const DASH = new RegExp(String.raw`${S}+[-–—|]+${S}+`, 'u');
const FEATURING = new RegExp(String.raw`${B}(feat|ft|featuring|with)${B}.*`, 'gu');
const WORD_SPLIT = new RegExp(String.raw`[\t\n\f\r\p{Z}.·]+`, 'u');
const NON_ALNUM = /[^a-z0-9]/g;
const ARTIST_SEPARATORS = new RegExp(
  String.raw`${S}*(?:[,&/;·|]|${B}and${B}|${B}x${B}|${B}vs\.?${B}|${B}feat\.?${B}|${B}ft\.?${B}|${B}featuring${B}|${B}with${B})${S}*`,
  'u',
);

// ── Small helpers ───────────────────────────────────────────────────────────

const lower = (value) => String(value ?? '').toLowerCase();
const isBlank = (value) => value == null || String(value).trim() === '';

/** Splits on whitespace, dots and middle dots, and strips all but [a-z0-9]. */
function words(text) {
  return String(text).split(WORD_SPLIT).map((word) => word.replace(NON_ALNUM, ''));
}

function setsEqual(a, b) {
  if (a.size !== b.size) return false;
  for (const item of a) if (!b.has(item)) return false;
  return true;
}

/** Stable sort, highest key first (Kotlin's sortedByDescending is stable). */
function sortedDesc(items, key) {
  return items
    .map((item, index) => ({ item, index, key: key(item) }))
    .sort((a, b) => (b.key === a.key ? a.index - b.index : b.key > a.key ? 1 : -1))
    .map(({ item }) => item);
}

/** "3:45" or "1:02:03" as whole seconds; null for anything else (TrackMatcher.secondsOf). */
export function secondsOf(text) {
  if (text == null) return null;
  const parts = String(text).trim().split(':');
  if (parts.length < 2 || parts.length > 3) return null;
  let total = 0;
  for (const part of parts) {
    const trimmed = part.trim();
    // Kotlin's toIntOrNull: an optional sign and digits, nothing else.
    if (!/^[+-]?\d+$/.test(trimmed)) return null;
    total = total * 60 + Number.parseInt(trimmed, 10);
  }
  return total > 0 ? total : null;
}

/** A candidate row's runtime in whole seconds, or null when it states none. */
export function rowSeconds(row) {
  if (row == null) return null;
  if (typeof row.durationSec === 'number') {
    return Number.isFinite(row.durationSec) && row.durationSec > 0 ? Math.trunc(row.durationSec) : null;
  }
  return secondsOf(row.durationText);
}

function targetSeconds(target) {
  const value = target?.durationSec;
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

// ── Asking ──────────────────────────────────────────────────────────────────

/**
 * What to put to a source's search box, best first: "<title> <primary artist>",
 * then "<title>" alone for catalogues that credit the composer or the film.
 * The raw title is never one of them.
 */
export function queries(target) {
  const title = searchableTitle(target.title, target.artist ?? '');
  if (isBlank(title)) return [];
  const artist = primaryArtist(target.artist ?? '');
  if (isBlank(artist)) return [title];
  return [`${title} ${artist}`, title];
}

/** The title with the packaging taken off, version markers kept (sorted, as Kotlin's TreeSet). */
export function searchableTitle(title, artist = '') {
  const parts = parseTitle(title, artist);
  return [...parts.words, ...[...parts.versions].sort()].join(' ');
}

/**
 * The first credited artist, lower-cased. Note that only lower-casing happens:
 * quotes and backslashes survive, which is how an artist string reaches a
 * module's search call verbatim (defect S1 in the paper; see moduleHost.js).
 */
export function primaryArtist(artist) {
  return (lower(artist).split(ARTIST_SEPARATORS)[0] ?? '').trim();
}

/** Whether both credits name at least one of the same artists. */
export function sharesArtist(wanted, got) {
  const want = artistNames(wanted);
  const have = artistNames(got);
  if (want.size === 0 || have.size === 0) return false;
  for (const w of want.values()) {
    for (const h of have.values()) if (sameArtist(w, h)) return true;
  }
  return false;
}

// ── Title ───────────────────────────────────────────────────────────────────

/**
 * A title split into identity and packaging (TrackMatcher.parseTitle):
 *   words    the title proper, lower-cased, one entry per word
 *   core     words joined with nothing between them; what identity compares
 *   versions markers of a different take (remix, live, acoustic); must agree both ways
 *   context  words dropped with the packaging; a tie-break, never a veto
 *
 * @returns {{ words: string[], core: string, versions: Set<string>, context: Set<string> }}
 */
export function parseTitle(raw, artist = '') {
  const versions = new Set();
  const context = new Set();
  let text = lower(raw).replaceAll('&', ' and ');

  // Bracketed asides, innermost first: (From "Satyamev Jayate"), [Official Audio].
  for (let pass = 0; pass < BRACKET_PASSES; pass++) {
    if (!BRACKETED_TEST.test(text)) continue;
    text = text.replace(BRACKETED, (_, inner) => {
      classify(inner, versions, context);
      return ' ';
    });
  }
  // An unbalanced bracket (a truncated title) takes the rest of the line with it.
  const open = text.search(/[(\[]/);
  if (open >= 0) {
    classify(text.slice(open), versions, context);
    text = text.slice(0, open);
  }

  // Dash- and pipe-separated tails. The head is normally the title, but a head
  // that is just the artist's name is the "Artist - Title" upload convention.
  for (let pass = 0; pass < DASH_PASSES; pass++) {
    const dash = DASH.exec(text);
    if (!dash) continue;
    const head = text.slice(0, dash.index);
    const tail = text.slice(dash.index + dash[0].length);
    if (isArtistName(head, artist)) {
      classify(head, versions, context);
      text = tail;
    } else {
      classify(tail, versions, context);
      text = head;
    }
  }

  // A feat. credit belongs to the artist field wherever a catalogue prints it.
  // Note: "with" counts too, so "Dancing with a Stranger" becomes "dancing".
  text = text.replace(FEATURING, ' ');

  let kept = words(text).filter((word) => word !== '' && !JOINING_WORDS.has(word));
  // "Tum Hi Ho Full Song": trailing upload labels, never stripped to nothing.
  while (kept.length > 1 && TRAILING_NOISE.has(kept[kept.length - 1])) kept = kept.slice(0, -1);

  return { words: kept, core: kept.join(''), versions, context };
}

/** Files one dropped segment under versions or context (TrackMatcher.classify). */
function classify(segment, versions, context) {
  const segmentWords = words(segment).filter((word) => word !== '');
  if (segmentWords.length === 0) return;
  if (NEUTRAL_SEGMENTS.has(segmentWords.join(''))) return;
  const marks = segmentWords.filter((word) => VERSION_WORDS.has(word));
  if (marks.length > 0) {
    for (const mark of marks) versions.add(mark);
    return;
  }
  for (const word of segmentWords) {
    if (word.length > 2 && !NOISE_WORDS.has(word)) context.add(word);
  }
}

/**
 * Whether `text` is nothing but (part of) `artist`. The artist is only
 * lower-cased here, not '&'-expanded like the title, so "Simon & Garfunkel -
 * The Boxer" is NOT recognised as an "Artist - Title" upload (faithful to Kotlin).
 */
function isArtistName(text, artist) {
  if (isBlank(artist)) return false;
  const head = words(text).filter((word) => word !== '');
  if (head.length === 0) return false;
  const credited = new Set(words(lower(artist)).filter((word) => word !== ''));
  return head.every((word) => credited.has(word));
}

// ── Artist ──────────────────────────────────────────────────────────────────

/**
 * The credited artists, each as its own list of words, keyed by the words
 * joined with spaces (a Set of lists in Kotlin). Single letters go, so
 * "A. R. Rahman" and "AR Rahman" are the same person.
 * @returns {Map<string, string[]>}
 */
export function artistNames(value) {
  const names = new Map();
  for (const name of lower(value).split(ARTIST_SEPARATORS)) {
    const nameWords = words(name).filter((word) => word.length > 1);
    if (nameWords.length > 0) names.set(nameWords.join(' '), nameWords);
  }
  return names;
}

function sameArtist(a, b) {
  return runOf(a, b) || runOf(b, a);
}

/** Whether `outer` contains `inner` as a run of whole words. */
function runOf(outer, inner) {
  if (inner.length === 0 || inner.length > outer.length) return false;
  for (let at = 0; at <= outer.length - inner.length; at++) {
    let equal = true;
    for (let i = 0; i < inner.length; i++) {
      if (outer[at + i] !== inner[i]) {
        equal = false;
        break;
      }
    }
    if (equal) return true;
  }
  return false;
}

/**
 * Points for the credit agreeing, or null when it disagrees. A side with no
 * credit at all scores 0 rather than failing.
 */
export function artistScore(wanted, got) {
  const want = artistNames(wanted);
  const have = artistNames(got);
  if (want.size === 0 || have.size === 0) return 0;
  if (!sharesArtist(wanted, got)) return null;
  return setsEqual(new Set(want.keys()), new Set(have.keys())) ? ARTIST_EXACT : ARTIST_SHARED;
}

// ── Duration, album, explicit, context ─────────────────────────────────────

/**
 * Points for the runtimes agreeing, or null when they cannot be one recording.
 * Only consulted when both sides state a runtime. `allowVideoDrift` widens the
 * window to 90 s (scoring 0 between 31 and 90 s).
 */
export function durationScore(wanted, got, allowVideoDrift = false) {
  if (wanted == null || got == null) return 0;
  const drift = Math.abs(wanted - got);
  if (drift > DURATION_LIMIT_SEC && allowVideoDrift && drift <= VIDEO_DURATION_LIMIT_SEC) return 0;
  if (drift > DURATION_LIMIT_SEC) return null;
  if (drift <= DURATION_TIGHT_SEC) return DURATION_TIGHT;
  return DURATION_LOOSE;
}

/** Punctuation, spacing and a trailing edition label are not release identity. */
export function albumKey(value) {
  let text = lower(value).trim();
  if (text === '') return null;
  for (let pass = 0; pass < BRACKET_PASSES; pass++) text = text.replace(BRACKETED, ' ');
  const key = words(text)
    .filter((word) => word !== '' && !ALBUM_NOISE_WORDS.has(word))
    .join('');
  return key === '' ? null : key;
}

function albumScore(wanted, got) {
  const want = albumKey(wanted);
  if (want == null) return 0;
  const have = albumKey(got);
  if (have == null) return 0;
  return want === have ? ALBUM_EXACT : 0;
}

/** When both catalogues state the explicit flag they must agree. */
function explicitScore(wanted, got) {
  if (wanted == null || got == null) return 0;
  if (Boolean(wanted) !== Boolean(got)) return null;
  return EXPLICIT_EXACT;
}

function contextScore(wanted, got) {
  for (const word of wanted.context) if (got.context.has(word)) return CONTEXT_SHARED;
  return 0;
}

// ── Judging ─────────────────────────────────────────────────────────────────

/**
 * How confident this is the same recording, or null when it is not one
 * (TrackMatcher.score). Rejections: empty or different core, different version
 * sets, runtime out of window, disjoint credits (unless the runtime agrees to
 * within 2 s and the target is not a video), and contradicting explicit flags.
 */
export function score(target, candidate) {
  const wanted = parseTitle(target.title, target.artist ?? '');
  const got = parseTitle(candidate.title, candidate.artist ?? '');
  if (wanted.core === '' || got.core === '') return null;
  if (wanted.core !== got.core) return null;
  if (!setsEqual(wanted.versions, got.versions)) return null;

  const creditedArtist = artistScore(target.artist ?? '', candidate.artist ?? '');
  // The wider video window is allowed whenever the credit does not contradict,
  // which includes a candidate (or target) with no credit at all.
  const duration = durationScore(targetSeconds(target), rowSeconds(candidate), creditedArtist != null);
  if (duration == null) return null;

  let artist = creditedArtist;
  if (artist == null) {
    // Film catalogues credit the composer on one side and the singer on the
    // other. Only an exact runtime may stand in for a shared credit, and never
    // for a music video, whose runtime includes visuals.
    if (!target.isVideo && withinSeconds(candidate, target, CREDIT_OVERRIDE_SEC)) artist = CREDITS_DISAGREE;
    else return null;
  }

  const explicit = explicitScore(target.explicit, candidate.explicit);
  if (explicit == null) return null;
  return BASE + artist + duration + albumScore(target.album, candidate.album) + explicit + contextScore(wanted, got);
}

/**
 * Every candidate that really is `target`, most confident first (stable). If
 * any row carries the requested artist, rows admitted only on runtime (the
 * different-artist exception) are dropped.
 */
export function ranked(target, candidates) {
  const scored = [];
  for (const candidate of candidates) {
    const points = score(target, candidate);
    if (points != null) scored.push({ candidate, points });
  }
  const credited = scored.filter(({ candidate }) => artistScore(target.artist ?? '', candidate.artist ?? '') != null);
  const pool = credited.length > 0 ? credited : scored;
  return sortedDesc(pool, (entry) => entry.points).map((entry) => entry.candidate);
}

/** The best candidate that is genuinely `target`, or null. */
export function best(target, candidates) {
  return ranked(target, candidates)[0] ?? null;
}

/** Yes/no form of score (TrackMatcher.matches). */
export function matches(candidate, title, artist, durationSec = null) {
  return score({ title, artist, durationSec }, candidate) != null;
}

/**
 * Whether `candidate` states a runtime within `seconds` of the target's. Both
 * halves are requirements: an unstated runtime on either side is a no.
 */
export function withinSeconds(candidate, target, seconds) {
  const wanted = targetSeconds(target);
  if (wanted == null) return false;
  const got = rowSeconds(candidate);
  if (got == null) return false;
  return Math.abs(wanted - got) <= seconds;
}

/** Whether two runtimes differ by more than DURATION_LIMIT_SEC. */
export function isSevereMismatch(expectedSec, actualSec) {
  if (expectedSec == null || actualSec == null) return false;
  return Math.abs(actualSec - expectedSec) > DURATION_LIMIT_SEC;
}

/**
 * Whether otherwise valid rows describe more than one release while the target
 * names none (JioSaavn catalogue collisions).
 */
export function hasConflictingAlbums(candidates, target) {
  if (!isBlank(target.album)) return false;
  const hasRuntime = targetSeconds(target) != null;
  const comparable = hasRuntime
    ? candidates.filter((candidate) => withinSeconds(candidate, target, DURATION_LIMIT_SEC))
    : candidates;
  if (hasRuntime && comparable.length === 0) return false;
  const albums = new Set(comparable.map((candidate) => albumKey(candidate.album)).filter((key) => key != null));
  return albums.size > 1;
}

/** Resolves a release collision only for a unique, fuller (>= 2 names) credit. */
export function uniquelyMostCreditedCloseMatch(candidates, target) {
  const close = candidates.filter((candidate) => withinSeconds(candidate, target, DURATION_LIMIT_SEC));
  if (close.length < 2) return null;
  const counted = close.map((candidate) => ({ candidate, credits: artistNames(candidate.artist ?? '').size }));
  const top = Math.max(...counted.map((entry) => entry.credits));
  if (top < 2) return null;
  const winners = counted.filter((entry) => entry.credits === top);
  return winners.length === 1 ? winners[0].candidate : null;
}

/**
 * The official audio release for a music video the listener explicitly
 * switched: exact title and versions plus a shared (or absent) credit; the
 * runtime only ranks, it never vetoes.
 */
export function bestOfficialAudioForVideo(target, candidates) {
  const wanted = parseTitle(target.title, target.artist ?? '');
  if (wanted.core === '') return null;
  let chosen = null;
  let chosenPoints = -Infinity;
  for (const candidate of candidates) {
    const got = parseTitle(candidate.title, candidate.artist ?? '');
    if (wanted.core !== got.core || !setsEqual(wanted.versions, got.versions)) continue;
    const artist = artistScore(target.artist ?? '', candidate.artist ?? '');
    if (artist == null) continue;
    const expected = targetSeconds(target);
    const actual = rowSeconds(candidate);
    const duration = expected == null ? 0 : actual == null ? -120 : -Math.abs(expected - actual);
    const points = artist * 1000 + duration;
    if (points > chosenPoints) {
      chosen = candidate;
      chosenPoints = points;
    }
  }
  return chosen;
}

// ── Resolver-level filters (SourceResolver.kt) ─────────────────────────────

/**
 * SourceResolver.preferred's first rule: when any row agrees with the target's
 * runtime to within SAME_RECORDING_SEC, only those rows are eligible. If none
 * agrees, nothing is excluded.
 */
export function keepSameRecording(matchesList, target) {
  const sameLength = matchesList.filter((row) => withinSeconds(row, target, SAME_RECORDING_SEC));
  return sameLength.length > 0 ? sameLength : matchesList;
}

/**
 * matchAndStream's strictLength filter, used by upgrades and downloads: the
 * row must state a runtime within UPGRADE_DRIFT_SEC. Against a target with no
 * runtime this removes everything, by design.
 */
export function keepStrictLength(matchesList, target) {
  return matchesList.filter((row) => withinSeconds(row, target, UPGRADE_DRIFT_SEC));
}

/** matchAndStream's requireSharedArtist filter: the credits must overlap. */
export function keepSharedArtist(matchesList, target) {
  return matchesList.filter((row) => sharesArtist(target.artist ?? '', row.artist ?? ''));
}
