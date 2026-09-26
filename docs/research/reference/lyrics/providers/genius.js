// Genius provider ('genius'): plain (unsynced) lyrics, BitChord's last resort.
//
// Mirrors BitChord (commit fe198ac):
//   app/src/main/java/com/music/bitchord/data/lyrics/Genius.kt
//     scrapeLyrics, searchSongUrl, bestMatch, parseHtml/parseHtmlUnsafe,
//     stripArtifacts, textToLyricLines, cleanQuery
//   app/src/main/java/com/music/bitchord/data/lyrics/LyricsRepository.kt
//     (Genius is started lazily and skipped once anything else answered)
//
// Independent JavaScript re-implementation of the mechanism documented in
// BITCHORD_ENGINE_RESEARCH.md (BitChord itself is GPL-3.0).
//
//   1. Up to five query variants, tried one after another, each a
//      GET https://genius.com/api/search/multi?q=<form-encoded>;
//      the first variant whose "song" section yields an acceptable hit wins.
//   2. Hit scoring (bestMatch): a hit is acceptable when EITHER its title OR
//      its artist_names matches (equality or containment); translation /
//      tracklist / album-art pages are penalised.
//   3. GET the hit's `url`; lyrics are the text of every
//      div[data-lyrics-container=true] (else div.lyrics), minus header/ad/button
//      nodes, with <br> -> newline and a newline before each <p>.
//   4. Clean-up: odd spaces, "You might also like", trailing "123Embed";
//      blank runs collapse to one gap line; all lines have timeMs 0.
// BitChord uses Jsoup; this file carries a minimal HTML tree builder that
// reproduces the parts of Jsoup's behaviour the scrape depends on.

import { timeoutSignal, HttpError, qs } from '../../lib/http.js';
import { line } from '../model.js';

// "What this says it is, which is deliberately not a browser": Genius's
// Cloudflare front challenges a browser UA whose TLS fingerprint does not match.
export const GENIUS_USER_AGENT = 'BitChord';
const CALL_TIMEOUT_MS = 8_000; // Genius.kt: callTimeout 8 s, connectTimeout 4 s

const TITLE_SEPARATOR = /\s*[-–—:]\s*/;
const DECORATIVE_CHARS = /[♪♫★☆【】《》「」~_]/g;
const PRODUCER_TAGS = /\b(?:prod(?:uced)?\.?(?:\s+by)?)\s+.*$/i;
const NOISE = new RegExp(
  String.raw`\s*[(\[]\s*(?:from|feat\.?|ft\.?|featuring|with|prod\.?|produced by|official|lyrical|video|audio|remix|music video|visualizer|mv|hd|4k|hq|full song)[^)\]]*[)\]]|`
    + String.raw`\s*\b(?:official\s+(?:music\s+)?(?:video|audio)|lyrical(?:\s+video)?|full\s+song|4k\s+video|hd\s+video|music\s+video)\b`,
  'gi',
);
const BRACKETED_CONTENT = /\s*[([].*?[)\]]/g;
const NON_ALPHANUMERIC = /[^\p{L}\p{N}\s]/gu;
const YOU_MIGHT_ALSO_LIKE = /\d*You might also like/gi;
const TRAILING_EMBED = /\d*Embed\s*$/i;

// ---- HTTP ---------------------------------------------------------------------

async function httpGet(ctx, url) {
  const f = ctx?.fetch ?? globalThis.fetch;
  const { signal, done } = timeoutSignal(ctx?.signal, CALL_TIMEOUT_MS);
  try {
    const res = await f(url, {
      headers: {
        'User-Agent': GENIUS_USER_AGENT,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,application/json,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      signal,
    });
    const body = await res.text();
    // Any non-2xx (a Cloudflare 403 included) is indistinguishable from "no lyrics".
    if (!res.ok) throw new HttpError(res.status, url, body);
    return body;
  } catch (err) {
    if (ctx?.signal?.aborted) throw err;
    return null;
  } finally {
    done();
  }
}

// ---- Query shaping ------------------------------------------------------------

/** Genius.cleanQuery. */
export function cleanGeniusQuery(text) {
  const original = String(text ?? '');
  let cleaned = original.replace(DECORATIVE_CHARS, ' ').replace(NOISE, ' ').replace(PRODUCER_TAGS, ' ');
  const bar = cleaned.indexOf(' | ');
  if (bar >= 0) cleaned = cleaned.slice(0, bar);
  cleaned = cleaned.replace(/\s+/g, ' ').trim();
  return cleaned === '' ? original.trim() : cleaned;
}

const eqIgnoreCase = (a, b) => a.toLowerCase() === b.toLowerCase() || a.toUpperCase() === b.toUpperCase();

/**
 * Genius.scrapeLyrics' query plan. Handles "Artist - Title" titles by
 * splitting on the first -, –, — or ":" - which also splits hyphenated
 * titles such as "Anti-Hero" (a BitChord quirk, reproduced).
 * @returns {{ query: string, title: string, artist: string }[]}
 */
export function geniusSearchAttempts(title, artist) {
  const cleanTitle = cleanGeniusQuery(title);
  const cleanArtist = cleanGeniusQuery(artist);

  let parts = null;
  const sep = TITLE_SEPARATOR.exec(cleanTitle);
  if (sep) parts = [cleanTitle.slice(0, sep.index), cleanTitle.slice(sep.index + sep[0].length)];

  let extractedTitle = cleanTitle;
  if (parts && eqIgnoreCase(parts[0].trim(), cleanArtist)) extractedTitle = parts[1].trim();
  else if (parts && eqIgnoreCase(parts[1].trim(), cleanArtist)) extractedTitle = parts[0].trim();
  else if (parts && parts[0].trim() !== '' && parts[1].trim() !== '') extractedTitle = parts[1].trim();

  let extractedArtist = cleanArtist;
  if (parts && (eqIgnoreCase(parts[0].trim(), cleanArtist) || eqIgnoreCase(parts[1].trim(), cleanArtist))) extractedArtist = cleanArtist;
  else if (parts && cleanArtist.trim() === '') extractedArtist = parts[0].trim();

  const titleWithoutBrackets = extractedTitle
    .replace(BRACKETED_CONTENT, ' ')
    .replace(NON_ALPHANUMERIC, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const blank = (s) => s.trim() === '';
  const attempts = [];
  if (!blank(extractedArtist) && !blank(extractedTitle)) {
    attempts.push({ query: `${extractedArtist} ${extractedTitle}`.trim(), title: extractedTitle, artist: extractedArtist });
  }
  if (!blank(extractedArtist) && !blank(titleWithoutBrackets) && titleWithoutBrackets !== extractedTitle) {
    attempts.push({ query: `${extractedArtist} ${titleWithoutBrackets}`.trim(), title: titleWithoutBrackets, artist: extractedArtist });
  }
  if (cleanTitle !== extractedTitle) {
    attempts.push({ query: `${cleanArtist} ${cleanTitle}`.trim(), title: cleanTitle, artist: cleanArtist });
    attempts.push({ query: cleanTitle, title: extractedTitle, artist: extractedArtist });
  }
  if (!blank(titleWithoutBrackets)) {
    attempts.push({ query: titleWithoutBrackets, title: titleWithoutBrackets, artist: extractedArtist });
  } else if (!blank(extractedTitle)) {
    attempts.push({ query: extractedTitle, title: extractedTitle, artist: extractedArtist });
  }
  const seen = new Set();
  return attempts.filter((a) => (seen.has(a.query) ? false : (seen.add(a.query), true)));
}

// ---- Search -------------------------------------------------------------------

/**
 * Genius.bestMatch over the `result` objects of the "song" section.
 * Title: +50 exact, +25 containment. Artist (artist_names): +40 exact, +20
 * containment. A hit matching neither is dropped; so is one scoring <= 0
 * after penalties (-30 translation, -40 turkce/polskie-tlumaczenie,
 * -50 tracklist/album-art in `path`). Note that an artist-only match (a
 * different song by the same artist) is acceptable - a BitChord weakness.
 */
export function geniusBestMatch(candidates, targetTitle, targetArtist) {
  if (candidates.length === 0) return null;
  const normTitle = targetTitle.toLowerCase();
  const normArtist = targetArtist.toLowerCase();
  let best = null;
  let bestScore = -Infinity;
  for (const item of candidates) {
    const title = typeof item.title === 'string' ? item.title.toLowerCase() : '';
    const artist = typeof item.artist_names === 'string' ? item.artist_names.toLowerCase() : '';
    const titleMatches = normTitle.trim() !== '' && (title === normTitle || title.includes(normTitle) || normTitle.includes(title));
    const artistMatches = normArtist.trim() !== '' && (artist === normArtist || artist.includes(normArtist) || normArtist.includes(artist));
    if (!titleMatches && !artistMatches) continue;

    let score = 0;
    if (title === normTitle) score += 50;
    else if (titleMatches) score += 25;
    if (artistMatches) score += artist === normArtist ? 40 : 20;

    const path = typeof item.path === 'string' ? item.path.toLowerCase() : '';
    if (path.includes('translation') && !normTitle.includes('translation')) score -= 30;
    if (path.includes('türkçe') || path.includes('polskie-tlumaczenie')) score -= 40;
    if (path.includes('tracklist') || path.includes('album-art')) score -= 50;
    if (score <= 0) continue;
    if (score > bestScore) { // first maximum wins, like maxByOrNull
      best = item;
      bestScore = score;
    }
  }
  return best;
}

async function searchSongUrl(ctx, attempt) {
  // java.net.URLEncoder == application/x-www-form-urlencoded == URLSearchParams.
  const body = await httpGet(ctx, `https://genius.com/api/search/multi?${qs({ q: attempt.query })}`);
  if (body == null) return null;
  let root;
  try {
    root = JSON.parse(body);
  } catch {
    return null;
  }
  const sections = root?.response?.sections;
  if (!Array.isArray(sections)) return null;
  const songSection = sections.find((s) => s && typeof s === 'object' && s.type === 'song');
  if (!songSection || !Array.isArray(songSection.hits)) return null;
  const candidates = songSection.hits
    .map((h) => (h && typeof h === 'object' ? h.result : null))
    .filter((r) => r && typeof r === 'object' && !Array.isArray(r));
  const best = geniusBestMatch(candidates, attempt.title, attempt.artist);
  // The URL is taken from the API as-is (not checked to be on genius.com).
  return typeof best?.url === 'string' ? best.url : null;
}

// ---- Page parsing -------------------------------------------------------------

/**
 * Genius.parseHtml: lyrics text of a song page as plain lines, or null.
 * @param {string} html
 */
export function parseGeniusHtml(html) {
  try {
    const doc = parseHtmlTree(html);
    let containers = selectAll(doc, (el) => el.name === 'div' && attrEquals(el, 'data-lyrics-container', 'true'));
    if (containers.length === 0) containers = selectAll(doc, (el) => el.name === 'div' && hasClass(el, 'lyrics'));
    if (containers.length === 0) return null;

    let full = '';
    for (const container of containers) {
      // Remove headers, contributors, translation links, buttons, ads.
      // Jsoup's `.Class` selector matches a whole class token, so hashed
      // styled-components names such as "LyricsHeader__Container-sc-1a2b3c"
      // do NOT match these; the data-exclude-from-selection attribute is what
      // actually removes the header on current pages.
      for (const el of selectAll(container, isExcluded)) {
        if (el !== container) detach(el);
      }
      for (const br of selectAll(container, (el) => el.name === 'br')) replaceWithText(br, '\n');
      for (const p of selectAll(container, (el) => el.name === 'p')) p.children.unshift({ type: 'text', text: '\n', parent: p });
      const text = wholeText(container);
      if (text.trim() !== '') full += `${text}\n`;
    }
    if (full.trim() === '') return null;
    const lines = geniusTextToLines(stripGeniusArtifacts(full));
    return lines.length > 0 ? lines : null;
  } catch {
    return null;
  }
}

function isExcluded(el) {
  return attrEquals(el, 'data-exclude-from-selection', 'true')
    || hasClass(el, 'LyricsHeader__Container')
    || hasClass(el, 'SongBioPreview__Container')
    || hasClass(el, 'InreadAd__Container')
    || el.name === 'button'
    || el.name === 'script'
    || el.name === 'style';
}

/** Genius.stripArtifacts. */
export function stripGeniusArtifacts(raw) {
  return raw
    .replace(/[ ​﻿]/g, ' ')
    .replace(YOU_MIGHT_ALSO_LIKE, '')
    .trim()
    .replace(TRAILING_EMBED, '')
    .trim();
}

/** Genius.textToLyricLines: one gap for each blank run, none at either end; all timeMs 0. */
export function geniusTextToLines(text) {
  const result = [];
  let lastWasGap = false;
  for (const raw of text.split(/\r\n|\r|\n/)) {
    const t = raw.trim().replace(TRAILING_EMBED, '').trim();
    if (t === '') {
      if (!lastWasGap && result.length > 0) {
        result.push(line(0, ''));
        lastWasGap = true;
      }
    } else {
      result.push(line(0, t));
      lastWasGap = false;
    }
  }
  while (result.length > 0 && result[0].text === '') result.shift();
  while (result.length > 0 && result[result.length - 1].text === '') result.pop();
  return result;
}

/** Genius.isSectionHeader: "[Verse 1]", "[Chorus]" ... (3..60 characters). */
export function isSectionHeader(text) {
  const t = String(text).trim();
  return t.startsWith('[') && t.endsWith(']') && t.length >= 3 && t.length <= 60;
}

// ---- Provider -----------------------------------------------------------------

/** @type {import('../model.js').LyricsProvider['lyrics']} */
async function lyrics(query, ctx = {}) {
  try {
    let songUrl = null;
    for (const attempt of geniusSearchAttempts(query.title, query.artist)) {
      songUrl = await searchSongUrl(ctx, attempt);
      if (songUrl) break;
    }
    if (!songUrl) return null;
    const html = await httpGet(ctx, songUrl);
    if (html == null || html.trim() === '') return null;
    return parseGeniusHtml(html);
  } catch (err) {
    if (ctx.signal?.aborted) throw err;
    return null;
  }
}

export const providers = [
  { id: 'genius', label: 'Genius', wordSynced: false, lyrics },
];

// ---- Minimal HTML tree builder (the subset of Jsoup the scrape relies on) ----
//
// Elements: { type:'element', name, attrs, children, parent }; text nodes:
// { type:'text', text, parent }. Handles comments/doctype, void elements,
// "/>", raw-text <script>/<style>, RCDATA <title>/<textarea>, implied </p>,
// and mismatched end tags (ignored unless the element is open). Entities are
// decoded in text and attribute values. Not a full HTML5 parser.

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'keygen', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
const RAW_TEXT = new Set(['script', 'style']);
const RCDATA = new Set(['title', 'textarea']);
const CLOSES_P = new Set(['address', 'article', 'aside', 'blockquote', 'div', 'dl', 'fieldset', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr', 'main', 'nav', 'ol', 'p', 'pre', 'section', 'table', 'ul']);

const isSpaceCode = (c) => c === 32 || c === 9 || c === 10 || c === 12 || c === 13;
const isAsciiLetter = (c) => (c >= 65 && c <= 90) || (c >= 97 && c <= 122);

export function parseHtmlTree(html) {
  const src = String(html);
  const n = src.length;
  const root = { type: 'element', name: '#document', attrs: {}, children: [], parent: null };
  const stack = [root];
  const top = () => stack[stack.length - 1];
  const appendText = (text) => {
    if (!text) return;
    const parent = top();
    const last = parent.children[parent.children.length - 1];
    if (last && last.type === 'text') last.text += text;
    else parent.children.push({ type: 'text', text, parent });
  };

  let i = 0;
  while (i < n) {
    const lt = src.indexOf('<', i);
    if (lt < 0) {
      appendText(decodeHtmlEntities(src.slice(i)));
      break;
    }
    if (lt > i) appendText(decodeHtmlEntities(src.slice(i, lt)));
    i = lt;

    if (src.startsWith('<!--', i)) {
      const end = src.indexOf('-->', i + 4);
      i = end < 0 ? n : end + 3;
      continue;
    }
    const c1 = src.charCodeAt(i + 1);
    if (c1 === 33 /* ! */ || c1 === 63 /* ? */) {
      const end = src.indexOf('>', i);
      i = end < 0 ? n : end + 1;
      continue;
    }
    const closing = c1 === 47; /* / */
    if (!isAsciiLetter(src.charCodeAt(i + (closing ? 2 : 1)))) {
      appendText('<'); // "<" not starting a tag is text
      i += 1;
      continue;
    }

    const tag = readTag(src, i, closing);
    i = tag.end;
    if (closing) {
      for (let k = stack.length - 1; k > 0; k--) {
        if (stack[k].name === tag.name) {
          stack.length = k;
          break;
        }
      }
      continue;
    }

    if (CLOSES_P.has(tag.name) && top().name === 'p') stack.pop();
    const el = { type: 'element', name: tag.name, attrs: tag.attrs, children: [], parent: top() };
    top().children.push(el);

    if (RAW_TEXT.has(tag.name) || RCDATA.has(tag.name)) {
      const close = new RegExp(`</${tag.name}\\s*>`, 'ig');
      close.lastIndex = i;
      const m = close.exec(src);
      const content = src.slice(i, m ? m.index : n);
      if (content) el.children.push({ type: 'text', text: RCDATA.has(tag.name) ? decodeHtmlEntities(content) : content, parent: el });
      i = m ? m.index + m[0].length : n;
      continue;
    }
    if (!VOID.has(tag.name) && !tag.selfClosing) stack.push(el);
  }
  return root;
}

function readTag(src, start, closing) {
  const n = src.length;
  let j = start + (closing ? 2 : 1);
  const nameStart = j;
  while (j < n && !isSpaceCode(src.charCodeAt(j)) && src[j] !== '/' && src[j] !== '>') j++;
  const name = src.slice(nameStart, j).toLowerCase();
  const attrs = {};
  let selfClosing = false;
  while (j < n) {
    while (j < n && isSpaceCode(src.charCodeAt(j))) j++;
    if (j >= n) break;
    if (src[j] === '>') {
      j++;
      break;
    }
    if (src[j] === '/') {
      if (src[j + 1] === '>') {
        selfClosing = true;
        j += 2;
        break;
      }
      j++;
      continue;
    }
    const attrStart = j;
    while (j < n && !isSpaceCode(src.charCodeAt(j)) && src[j] !== '/' && src[j] !== '>' && src[j] !== '=') j++;
    const attrName = src.slice(attrStart, j).toLowerCase();
    while (j < n && isSpaceCode(src.charCodeAt(j))) j++;
    let value = '';
    if (src[j] === '=') {
      j++;
      while (j < n && isSpaceCode(src.charCodeAt(j))) j++;
      const quote = src[j];
      if (quote === '"' || quote === "'") {
        const close = src.indexOf(quote, j + 1);
        const end = close < 0 ? n : close;
        value = src.slice(j + 1, end);
        j = end + 1;
      } else {
        const valueStart = j;
        while (j < n && !isSpaceCode(src.charCodeAt(j)) && src[j] !== '>') j++;
        value = src.slice(valueStart, j);
      }
    }
    if (attrName && !(attrName in attrs)) attrs[attrName] = decodeHtmlEntities(value);
    if (j === attrStart) j++; // never stall on a stray character
  }
  return { end: j, name, attrs, selfClosing };
}

/** Pre-order elements under (and including) `root` that satisfy `pred`. */
function selectAll(root, pred) {
  const out = [];
  const walk = (node) => {
    if (node.type !== 'element') return;
    if (pred(node)) out.push(node);
    for (const child of node.children) walk(child);
  };
  walk(root);
  return out;
}

/** Jsoup [attr=value]: value compared trimmed and case-insensitively. */
function attrEquals(el, name, value) {
  const v = el.attrs?.[name];
  return v !== undefined && v.trim().toLowerCase() === value.toLowerCase();
}

/** Jsoup .class: a whole whitespace-separated class token, case-insensitive. */
function hasClass(el, cls) {
  const v = el.attrs?.class;
  if (!v) return false;
  const want = cls.toLowerCase();
  return v.split(/\s+/).some((c) => c.toLowerCase() === want);
}

function detach(node) {
  const siblings = node.parent?.children;
  if (!siblings) return;
  const k = siblings.indexOf(node);
  if (k >= 0) siblings.splice(k, 1);
  node.parent = null;
}

function replaceWithText(node, text) {
  const siblings = node.parent?.children;
  if (!siblings) return;
  const k = siblings.indexOf(node);
  if (k >= 0) siblings[k] = { type: 'text', text, parent: node.parent };
}

/** Jsoup Element.wholeText(): every descendant text node, unnormalised. */
function wholeText(node) {
  if (node.type === 'text') return node.text;
  let out = '';
  for (const child of node.children) out += wholeText(child);
  return out;
}

const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', shy: '­',
  hellip: '…', mdash: '—', ndash: '–', lsquo: '‘', rsquo: '’', sbquo: '‚', ldquo: '“', rdquo: '”', bdquo: '„',
  laquo: '«', raquo: '»', lsaquo: '‹', rsaquo: '›', bull: '•', middot: '·', prime: '′', Prime: '″',
  copy: '©', reg: '®', trade: '™', deg: '°', plusmn: '±', times: '×', divide: '÷', micro: 'µ', para: '¶', sect: '§',
  iexcl: '¡', iquest: '¿', cent: '¢', pound: '£', yen: '¥', euro: '€', frac12: '½', frac14: '¼', frac34: '¾',
  ensp: ' ', emsp: ' ', thinsp: ' ', zwnj: '‌', zwj: '‍', lrm: '‎', rlm: '‏',
  aacute: 'á', agrave: 'à', acirc: 'â', auml: 'ä', atilde: 'ã', aring: 'å', aelig: 'æ', ccedil: 'ç',
  eacute: 'é', egrave: 'è', ecirc: 'ê', euml: 'ë', iacute: 'í', igrave: 'ì', icirc: 'î', iuml: 'ï',
  ntilde: 'ñ', oacute: 'ó', ograve: 'ò', ocirc: 'ô', ouml: 'ö', otilde: 'õ', oslash: 'ø',
  uacute: 'ú', ugrave: 'ù', ucirc: 'û', uuml: 'ü', yacute: 'ý', yuml: 'ÿ', szlig: 'ß',
  Aacute: 'Á', Agrave: 'À', Acirc: 'Â', Auml: 'Ä', Atilde: 'Ã', Aring: 'Å', AElig: 'Æ', Ccedil: 'Ç',
  Eacute: 'É', Egrave: 'È', Ecirc: 'Ê', Euml: 'Ë', Iacute: 'Í', Igrave: 'Ì', Icirc: 'Î', Iuml: 'Ï',
  Ntilde: 'Ñ', Oacute: 'Ó', Ograve: 'Ò', Ocirc: 'Ô', Ouml: 'Ö', Otilde: 'Õ', Oslash: 'Ø',
  Uacute: 'Ú', Ugrave: 'Ù', Ucirc: 'Û', Uuml: 'Ü', Yacute: 'Ý',
};
// Names HTML allows without the trailing semicolon (a common subset).
const LEGACY = new Set(['amp', 'lt', 'gt', 'quot', 'nbsp', 'copy', 'reg']);

/** Decode character references: numeric always, named from the table above. */
export function decodeHtmlEntities(text) {
  if (!text.includes('&')) return text;
  return text.replace(/&(#[xX][0-9a-fA-F]+|#\d+|[A-Za-z][A-Za-z0-9]*)(;?)/g, (whole, ref, semi) => {
    if (ref[0] === '#') {
      const cp = ref[1] === 'x' || ref[1] === 'X' ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
      if (!Number.isFinite(cp) || cp === 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return '�';
      return String.fromCodePoint(cp);
    }
    const value = NAMED_ENTITIES[ref];
    if (value === undefined || (!semi && !LEGACY.has(ref))) return whole;
    return value;
  });
}
