// Mirrors the wiring in BitChord's `data/lyrics/LyricsRepository.kt` (which
// provider object answers for which LyricsSource, LyricsRepository.kt:172-206)
// and the default ordering of `data/lyrics/LyricsSource.kt`.
//
// Independent JavaScript re-implementation of the mechanism documented in
// BITCHORD_ENGINE_RESEARCH.md (BitChord itself is GPL-3.0).
//
// ============================================================================
// Usage
// ============================================================================
//
//   import { defaultLyricsRepository, createLyricsController } from './lyrics/index.js';
//
//   const repo = defaultLyricsRepository();          // all 16 providers, default order
//
//   // One lookup, exactly as the player's automatic lookup runs it:
//   const result = await repo.lyrics(
//     { videoId: 'dQw4w9WgXcQ', title: 'Dracula (feat. JENNIE)', artist: 'Tame Impala - Topic',
//       durationMs: 205_000, album: null },
//     {
//       sources: new Set(['bini_lyrics', 'lrclib', 'genius']),   // anything else is never contacted
//       order: ['lrclib', 'bini_lyrics', 'genius'],              // priority, first to last
//       prioritizeSyllableSync: false,
//       onSourceStarted: (id) => console.log('asking', id),
//       onSourceResult: (id, r) => console.log(id, r ? `${r.lines.length} lines` : 'miss'),
//       onSourceCancelled: (id) => console.log(id, 'lost the race'),
//       signal: AbortSignal.timeout(30_000),                     // e.g. the download path's 30 s cap
//       keys: { paxsenix: '...' },                               // for the keyed PaxSenix routes
//     },
//   );
//   // result: { source: 'bini_lyrics', lines: LyricLine[] } | null
//
//   // The player-side state machine (provider sheet, manual selection):
//   const controller = createLyricsController({ repository: repo, onChange: render });
//   controller.load({ videoId, title, artist, durationMs, album }, settings);
//   controller.select('lrclib');     // FOUND: instant; FETCHING: when done; NOT_FETCHED: fetch it
//
//   // Post-processing and timing helpers:
//   import { applyOffset, activeLyricRows, withInstrumentalGaps } from './lyrics/index.js';
//
// Each provider module under ./providers/ exports `providers`, an array of
// { id, label, wordSynced, lyrics(query, ctx) }; binilyrics.js additionally
// exports identify(query, ctx) and lyricsFor(hit, ctx), which the repository
// uses for the pre-race ISRC lookup. Namespace imports are used so a module that
// does not export one of those names degrades to "not wired" instead of failing
// to link.
// ============================================================================

import * as bini from './providers/binilyrics.js';
import * as betterLyrics from './providers/betterlyrics.js';
import * as paxSenix from './providers/paxsenix.js';
import * as lyricsPlus from './providers/lyricsplus.js';
import * as simpMusic from './providers/simpmusic.js';
import * as unison from './providers/unison.js';
import * as youtube from './providers/youtube.js';
import * as megalobiz from './providers/megalobiz.js';
import * as kugou from './providers/kugou.js';
import * as lrclib from './providers/lrclib.js';
import * as musixmatch from './providers/musixmatch.js';
import * as genius from './providers/genius.js';

import { DEFAULT_ORDER, SOURCE_BY_ID } from './sources.js';
import { createLyricsRepository } from './repository.js';

const MODULES = [
  bini, betterLyrics, paxSenix, lyricsPlus, simpMusic, unison,
  youtube, megalobiz, kugou, lrclib, musixmatch, genius,
];

/**
 * Every provider, deduplicated by id and sorted into LyricsSource's declaration
 * order (the default priority); ids unknown to sources.js keep import order after
 * the known ones. Missing label/wordSynced are filled in from sources.js.
 * @type {ReadonlyArray<import('./model.js').LyricsProvider>}
 */
export const allProviders = Object.freeze(buildRegistry(MODULES));

function buildRegistry(modules) {
  const byId = new Map();
  for (const mod of modules) {
    const list = Array.isArray(mod?.providers) ? mod.providers : [];
    for (const provider of list) {
      if (!provider || typeof provider.id !== 'string' || typeof provider.lyrics !== 'function') continue;
      if (byId.has(provider.id)) continue;
      const info = SOURCE_BY_ID.get(provider.id);
      byId.set(provider.id, Object.freeze({
        ...provider,
        label: provider.label ?? info?.label ?? provider.id,
        wordSynced: provider.wordSynced ?? info?.wordSynced ?? false,
        // Keep the provider's own method bound to the provider object.
        lyrics: provider.lyrics.bind(provider),
      }));
    }
  }
  const rank = (id) => {
    const i = DEFAULT_ORDER.indexOf(id);
    return i < 0 ? DEFAULT_ORDER.length : i;
  };
  // Array.prototype.sort is stable, so unknown ids keep their import order.
  return [...byId.values()].sort((a, b) => rank(a.id) - rank(b.id));
}

/** id -> provider */
export const providerById = new Map(allProviders.map((p) => [p.id, p]));

/** BiniLyrics' pre-race search, when binilyrics.js exports it. */
export const identify = typeof bini.identify === 'function' ? bini.identify : null;
/** BiniLyrics' document fetch for a search hit, when binilyrics.js exports it. */
export const lyricsFor = typeof bini.lyricsFor === 'function' ? bini.lyricsFor : null;

/**
 * A repository wired with every provider, BiniLyrics' identify/lyricsFor, and
 * BitChord's constants (100-entry ISRC LRU, 2.5 s identify cap). Any of those can
 * be overridden.
 * @param {Partial<Parameters<typeof createLyricsRepository>[0]>} [overrides]
 */
export function defaultLyricsRepository(overrides = {}) {
  return createLyricsRepository({
    providers: [...allProviders],
    identify,
    lyricsFor,
    ...overrides,
  });
}

export {
  createLyricsRepository,
  createLyricsController,
  ProviderState,
  LruMap,
  LyricsLookupCancelled,
  IDENTIFY_TIMEOUT_MS,
  REMEMBERED_ISRCS,
  LAZY_SOURCES,
  IDENTIFYING_SOURCE,
} from './repository.js';
export { forLyricsSearch, artistForLyricsSearch } from './query.js';
export {
  LYRICS_SOURCES,
  DEFAULT_ORDER,
  SOURCE_BY_ID,
  DEFAULT_LYRICS_SETTINGS,
  LEGACY_SOURCES,
  readLyricsSources,
  readLyricsSourceOrder,
  storeLyricsSources,
} from './sources.js';
export {
  withBackgroundVocals,
  withInstrumentalGaps,
  lineAlignments,
  applyOffset,
  adjustedLyricsPosition,
  adjustedLyricsSeekTarget,
  normalizeLyricsOffset,
  activeLyricRows,
  scrollLead,
  currentLineIndex,
  endMs,
  hasKnownEnd,
  MIN_GAP_MS,
  LyricClockReconciler,
} from './postprocess.js';
