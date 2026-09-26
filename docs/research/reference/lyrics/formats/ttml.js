// Apple Music TTML (Timed Text Markup Language) lyrics → LyricLine[].
//
// Mirrors BitChord's data/lyrics/TtmlLyrics.kt. The line layout it finishes
// with (duet sides from LyricAlignments.kt, instrumental gaps from LyricGaps.kt)
// is shared with the other parsers and lives in ../postprocess.js.
// Independent JavaScript re-implementation of the mechanism documented in
// BITCHORD_ENGINE_RESEARCH.md (BitChord itself is GPL-3.0).
//
// The format, as Apple writes it:
//
//   <tt xmlns="http://www.w3.org/ns/ttml" itunes:timing="Word" ...>
//     <head><metadata><ttm:agent type="person" xml:id="v1"/></metadata></head>
//     <body><div>
//       <p begin="27.395" end="28.960" ttm:agent="v1">
//         <span begin="27.395" end="27.549">I</span> <span ...>e</span><span ...>nough</span>
//         <span ttm:role="x-bg"><span begin=".." end="..">(ooh)</span></span>
//       </p>
//
// One <p> per sung line. With itunes:timing="Word" each <p> holds one timed
// <span> per syllable; with "Line" it holds bare text. Syllables of one word
// are adjacent spans with no whitespace between them, so whitespace — not the
// span boundary — separates words. Every begin/end is absolute media time
// (Apple's convention; TTML's parent-relative timing is not applied).
//
// Deliberate differences from TtmlLyrics.kt, all on malformed or unusual input:
//  - BitChord parses with a DOM and returns nothing at all for any document
//    that is not well-formed. This tokenizer recovers: unclosed elements close
//    at end of input, stray end tags are ignored, unknown entities are left as
//    written, a DOCTYPE is skipped. A truncated tag still ends the document.
//  - Element names are matched by local name, so a prefixed <tt:p> is found
//    (BitChord's non-namespace-aware lookup matches only a bare "p").
//  - A text node like ", " between two spans ends the word at its whitespace,
//    as TtmlLyrics.kt's own doc comment describes; BitChord's code instead
//    glues the next syllable onto it ("word, next" as one word).
//  - For line-synced paragraphs the text skips x-translation/x-roman spans,
//    reads <br/> as a space and collapses whitespace; BitChord uses the raw
//    textContent. <br/> is also a word boundary between spans.
//  - Clock values are rounded to the nearest millisecond; BitChord truncates
//    the double product, which is 1 ms early for about 1% of values
//    (e.g. "1.005" → 1004). The `h` and `m` offset metrics are also accepted.
//  - CDATA sections are read as text.

import { line } from '../model.js';
import { lineAlignments, withInstrumentalGaps } from '../postprocess.js';

/**
 * Roles that are not this line: translations and romanisations are alternate
 * renderings of the same words and would double the line (TtmlLyrics.kt:36).
 */
const SKIPPED_ROLES = new Set(['x-translation', 'x-roman']);

/** The answering vocal, carried as `line.background` (TtmlLyrics.kt:44). */
const BACKGROUND_ROLE = 'x-bg';

// ---------------------------------------------------------------------------
// Public API

/**
 * Parses a TTML document into lyric lines. Never throws; returns [] for input
 * with no usable paragraphs.
 * @param {string} xmlString
 * @returns {import('../model.js').LyricLine[]}
 */
export function parseTtml(xmlString) {
  return parseTtmlDocument(xmlString).lines;
}

/**
 * Like {@link parseTtml}, but also reports the document's declared timing
 * (`itunes:timing` on <tt>: "Word", "Line", "None", or null when absent).
 *
 * The declaration is informational only. As in BitChord, each paragraph is
 * read by what it contains: timed spans make it word-synced, bare text with a
 * `begin` makes it line-synced, and a paragraph with no `begin` and no timed
 * spans (itunes:timing="None") is dropped — so an unsynced Apple document
 * yields no lines.
 *
 * @param {string} xmlString
 * @returns {{ timing: string|null, lines: import('../model.js').LyricLine[] }}
 */
export function parseTtmlDocument(xmlString) {
  if (xmlString == null) return { timing: null, lines: [] };
  const root = parseXml(String(xmlString));

  const tt = findFirst(root, (el) => localName(el.name) === 'tt');
  const timing = (tt && qualifiedAttr(tt, 'itunes:timing')) || null;

  // The line and the voice that sang it, kept together: which side a line
  // belongs on can only be worked out once every line is known.
  const sung = [];
  for (const paragraph of findAll(root, (el) => localName(el.name) === 'p')) {
    const parsed = lineFrom(paragraph);
    if (parsed) sung.push({ line: parsed, agent: qualifiedAttr(paragraph, 'ttm:agent') || null });
  }
  sung.sort((a, b) => a.line.timeMs - b.line.timeMs); // stable, like Kotlin's sortBy

  const sides = lineAlignments(sung.map((s) => s.agent), agentTypes(root));
  const lines = withInstrumentalGaps(sung.map((s, i) => ({ ...s.line, alignment: sides[i] })));
  return { timing, lines };
}

/**
 * A TTML time expression in milliseconds, or null when it cannot be read.
 *
 * Accepted (a superset of TtmlLyrics.time, TtmlLyrics.kt:279-295):
 *  - clock time  `27.395`, `1:02.345`, `01:02:03.4`  ([[h:]m:]s with a fraction)
 *  - offset time `62.345s`, `62345ms`, `1.5m`, `0.25h`
 *  - clock time with a stray trailing `s` (`1:02.345s`), which BitChord tolerates.
 * Frame (`f`), tick (`t`) and `hh:mm:ss:ff` forms need the document's frame or
 * tick rate and are rejected, as they are in BitChord.
 *
 * @param {string|null|undefined} value
 * @returns {number|null}
 */
export function parseTtmlTime(value) {
  if (value == null) return null;
  const raw = String(value).trim();
  if (raw === '') return null;

  const offset = OFFSET_TIME.exec(raw);
  if (offset) return toMs(Number(offset[1]) * METRIC_MS[offset[2]]);

  const clock = raw.endsWith('s') ? raw.slice(0, -1) : raw;
  const parts = clock.split(':');
  if (parts.length > 3 || !parts.every((part) => DECIMAL.test(part))) return null;
  const seconds = parts.reduce((total, part) => total * 60 + Number(part), 0);
  return toMs(seconds * 1000);
}

const DECIMAL = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/;
const OFFSET_TIME = /^([+-]?(?:\d+(?:\.\d*)?|\.\d+))(ms|h|m|s)$/;
const METRIC_MS = { h: 3_600_000, m: 60_000, s: 1_000, ms: 1 };

function toMs(value) {
  if (!Number.isFinite(value)) return null;
  const ms = Math.round(value);
  return ms === 0 ? 0 : ms; // no -0
}

// ---------------------------------------------------------------------------
// Paragraph → line (TtmlLyrics.kt:143-180)

function lineFrom(paragraph) {
  const pieces = [];
  const backingPieces = [];
  collect(paragraph, pieces, backingPieces);
  const words = mergeIntoWords(pieces);
  const backingWords = mergeIntoWords(backingPieces);
  const background = backingWords.length > 0
    ? line(backingWords[0].startMs, joinWords(backingWords), backingWords)
    : null;

  if (words.length === 0) {
    // Line-synced: a <p> with a stamp and bare text. The backing vocal, if
    // any, stays in the text — its bracket is all the separation the
    // document gave. The paragraph's own end is the only statement of when
    // the singing stops, which is what lets a break be found after it.
    const begin = parseTtmlTime(paragraph.attrs.get('begin'));
    const text = lineText(paragraph);
    if (begin == null || text === '') return null;
    const end = parseTtmlTime(paragraph.attrs.get('end'));
    return line(begin, text, [], { sungUntilMs: end != null && end > begin ? end : null });
  }

  // Prefer the paragraph's own stamp when it is earlier: Apple sets it a hair
  // before the first syllable on lines opening with a soft consonant.
  const begin = parseTtmlTime(paragraph.attrs.get('begin')) ?? words[0].startMs;
  return line(Math.min(begin, words[0].startMs), joinWords(words), words, { background });
}

const joinWords = (words) => words.map((w) => w.text).join(' ');

/**
 * Flattens a paragraph into timed leaves and the text between them
 * (TtmlLyrics.kt:191-216). Nested timed spans recurse to their leaves, so only
 * the innermost (per-syllable) timings survive. Everything under an x-bg span
 * goes to `backing`; translations and romanisations are skipped entirely.
 */
function collect(node, out, backing) {
  for (const child of node.children) {
    if (child.type === 'text') {
      if (child.text !== '') out.push({ timed: false, text: child.text });
      continue;
    }
    if (isLineBreak(child)) {
      out.push({ timed: false, text: ' ' });
      continue;
    }
    const role = qualifiedAttr(child, 'ttm:role');
    if (SKIPPED_ROLES.has(role)) continue;
    // Inside a backing span every leaf is backing, whether the span holds its
    // own syllables or is a single timed leaf.
    const sink = role === BACKGROUND_ROLE ? backing : out;
    const begin = parseTtmlTime(child.attrs.get('begin'));
    const end = parseTtmlTime(child.attrs.get('end'));
    if (begin != null && end != null && !hasTimedChild(child)) {
      sink.push({ timed: true, text: textContent(child), start: begin, end });
    } else {
      collect(child, sink, backing);
    }
  }
}

function hasTimedChild(element) {
  return element.children.some((child) =>
    child.type === 'element' && ((child.attrs.get('begin') ?? '') !== '' || hasTimedChild(child)));
}

/**
 * Glues syllables back into words (TtmlLyrics.kt:233-273). A word ends at the
 * first whitespace after it — a whitespace text node between spans, or
 * whitespace at either edge of a span's own text — and runs from its first
 * syllable's start to its last syllable's end. Untimed text can only extend
 * the word it follows (trailing punctuation); it never starts a word, because
 * a word needs a span to get its timing from.
 */
function mergeIntoWords(pieces) {
  const words = [];
  let current = '';
  let start = 0;
  let end = 0;
  let timed = false;

  const flush = () => {
    const text = current.trim();
    current = '';
    if (text !== '' && timed) words.push({ startMs: start, endMs: end, text });
    timed = false;
  };

  for (const piece of pieces) {
    if (!piece.timed) {
      if (isBlank(piece.text)) {
        flush();
      } else if (timed) {
        const gap = piece.text.search(/\s/);
        if (gap < 0) {
          current += piece.text;
        } else {
          current += piece.text.slice(0, gap);
          flush();
        }
      }
      continue;
    }
    if (isBlank(piece.text)) continue;
    if (/^\s/.test(piece.text)) flush();
    if (current === '') start = piece.start;
    current += piece.text.trim();
    end = piece.end;
    timed = true;
    if (/\s$/.test(piece.text)) flush();
  }
  flush();
  return words;
}

/** Text of a line-synced paragraph: roles skipped, <br/> as space, whitespace collapsed. */
function lineText(paragraph) {
  let text = '';
  const walk = (node) => {
    for (const child of node.children) {
      if (child.type === 'text') text += child.text;
      else if (isLineBreak(child)) text += ' ';
      else if (!SKIPPED_ROLES.has(qualifiedAttr(child, 'ttm:role'))) walk(child);
    }
  };
  walk(paragraph);
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * The `<ttm:agent>` declarations in the head, as xml:id → type (`person`,
 * `group`, `other`) (TtmlLyrics.kt:94-106).
 */
function agentTypes(root) {
  const types = new Map();
  for (const agent of findAll(root, (el) => localName(el.name) === 'agent')) {
    const id = qualifiedAttr(agent, 'xml:id');
    const type = agent.attrs.get('type') ?? '';
    if (id !== '' && type !== '') types.set(id, type);
  }
  return types;
}

/**
 * An attribute named with a prefix: the whole name first, then any attribute
 * with the same local name (TtmlLyrics.kt:127-141). BitChord needs this
 * because Android's DOM files `ttm:agent` under `agent`; here it simply makes
 * the lookup independent of the prefix a document chose.
 */
function qualifiedAttr(element, name) {
  const exact = element.attrs.get(name);
  if (exact != null && exact !== '') return exact;
  const local = localName(name);
  for (const [attr, value] of element.attrs) {
    if (attr === local || localName(attr) === local) return value;
  }
  return '';
}

const isLineBreak = (el) => el.type === 'element' && localName(el.name) === 'br';
const isBlank = (s) => s.trim() === '';

// ---------------------------------------------------------------------------
// A small tolerant XML reader: elements, attributes, text, CDATA, comments,
// processing instructions and DOCTYPE. Enough for TTML; not a general parser.

/**
 * @typedef {{ type: 'text', text: string }} TextNode
 * @typedef {{ type: 'element', name: string, attrs: Map<string,string>,
 *             children: Array<ElementNode|TextNode>, parent: ElementNode|null }} ElementNode
 */

const NAME_START = /[A-Za-z_:À-￿]/;

/** @returns {ElementNode} a synthetic document root */
function parseXml(xml) {
  const root = element('#document', new Map(), null);
  let current = root;
  let pending = ''; // raw character data since the last piece of markup
  let i = 0;

  const flushText = () => {
    if (pending !== '') current.children.push({ type: 'text', text: decodeEntities(pending) });
    pending = '';
  };

  while (i < xml.length) {
    const lt = xml.indexOf('<', i);
    if (lt < 0) {
      pending += xml.slice(i);
      break;
    }
    pending += xml.slice(i, lt);

    if (xml.startsWith('<!--', lt)) {
      const close = xml.indexOf('-->', lt + 4);
      if (close < 0) break;
      flushText();
      i = close + 3;
    } else if (xml.startsWith('<![CDATA[', lt)) {
      const close = xml.indexOf(']]>', lt + 9);
      if (close < 0) break;
      flushText();
      current.children.push({ type: 'text', text: xml.slice(lt + 9, close) });
      i = close + 3;
    } else if (xml.startsWith('<?', lt)) {
      const close = xml.indexOf('?>', lt + 2);
      if (close < 0) break;
      flushText();
      i = close + 2;
    } else if (xml.startsWith('<!', lt)) {
      const close = declarationEnd(xml, lt + 2);
      if (close < 0) break;
      flushText();
      i = close;
    } else if (xml[lt + 1] !== '/' && !NAME_START.test(xml[lt + 1] ?? '')) {
      pending += '<'; // a bare "<" in text: not markup
      i = lt + 1;
    } else {
      const gt = tagEnd(xml, lt + 1);
      if (gt < 0) break; // truncated tag: nothing after it can be trusted
      flushText();
      const body = xml.slice(lt + 1, gt);
      i = gt + 1;
      if (body.startsWith('/')) {
        current = closeElement(current, body.slice(1).trim());
        continue;
      }
      const selfClosing = body.endsWith('/');
      const { name, attrs } = readTag(selfClosing ? body.slice(0, -1) : body);
      const el = element(name, attrs, current);
      current.children.push(el);
      if (!selfClosing) current = el;
    }
  }
  flushText();
  return root;
}

function element(name, attrs, parent) {
  return { type: 'element', name, attrs, children: [], parent };
}

/** Index of the `>` closing a tag, skipping quoted attribute values; -1 if none. */
function tagEnd(xml, from) {
  let quote = null;
  for (let i = from; i < xml.length; i++) {
    const c = xml[i];
    if (quote) {
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === '>') {
      return i;
    }
  }
  return -1;
}

/** Index just past a `<!...>` declaration, including a DOCTYPE's [internal subset]; -1 if none. */
function declarationEnd(xml, from) {
  let depth = 0;
  let quote = null;
  for (let i = from; i < xml.length; i++) {
    const c = xml[i];
    if (quote) {
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === '[') {
      depth += 1;
    } else if (c === ']') {
      depth = Math.max(0, depth - 1);
    } else if (c === '>' && depth === 0) {
      return i + 1;
    }
  }
  return -1;
}

const TAG_NAME = /^\s*([^\s/>]+)/;
const ATTRIBUTE = /([^\s=/]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g;

function readTag(body) {
  const nameMatch = TAG_NAME.exec(body);
  const name = nameMatch ? nameMatch[1] : '';
  const attrs = new Map();
  for (const m of body.slice(nameMatch ? nameMatch[0].length : 0).matchAll(ATTRIBUTE)) {
    // First occurrence wins; a DOM parser would reject the duplicate outright.
    if (!attrs.has(m[1])) attrs.set(m[1], decodeEntities(m[2] ?? m[3] ?? m[4] ?? ''));
  }
  return { name, attrs };
}

/** Closes the nearest open element with this name; an end tag matching nothing is ignored. */
function closeElement(current, name) {
  for (let el = current; el && el.parent; el = el.parent) {
    if (el.name === name) return el.parent;
  }
  return current;
}

const NAMED_ENTITIES = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

function decodeEntities(text) {
  if (!text.includes('&')) return text;
  return text.replace(/&(#[xX][0-9a-fA-F]+|#\d+|[A-Za-z][A-Za-z0-9]*);/g, (whole, ref) => {
    if (ref[0] !== '#') return NAMED_ENTITIES[ref] ?? whole;
    const code = ref[1] === 'x' || ref[1] === 'X' ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
  });
}

function localName(name) {
  return name.slice(name.indexOf(':') + 1);
}

function textContent(node) {
  let text = '';
  for (const child of node.children) text += child.type === 'text' ? child.text : textContent(child);
  return text;
}

/** Elements in document order (pre-order), like DOM getElementsByTagName. */
function findAll(node, predicate, into = []) {
  for (const child of node.children) {
    if (child.type !== 'element') continue;
    if (predicate(child)) into.push(child);
    findAll(child, predicate, into);
  }
  return into;
}

function findFirst(node, predicate) {
  for (const child of node.children) {
    if (child.type !== 'element') continue;
    if (predicate(child)) return child;
    const nested = findFirst(child, predicate);
    if (nested) return nested;
  }
  return null;
}
