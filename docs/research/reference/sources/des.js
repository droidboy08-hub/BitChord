// Pure-JavaScript DES (ECB, PKCS#5/PKCS#7 padding): decrypt, plus encrypt for tests.
//
// Mirrors the cipher call in BitChord (commit fe198ac):
//   app/src/main/java/com/music/bitchord/data/jiosaavn/JioSaavnService.kt  decryptUrl (:152-166)
//     Cipher.getInstance("DES/ECB/PKCS5Padding") with SecretKeySpec("38346591", "DES")
//
// Independent JavaScript re-implementation of the mechanism documented in
// BITCHORD_ENGINE_RESEARCH.md (BitChord itself is GPL-3.0; InnerTubeX, which
// this file does not use, is GPL-3.0 too — see its LICENSE / README "License").
//
// Why a hand-written DES exists at all:
//   * React Native (Hermes/JSC) ships no DES, and no WebCrypto DES either
//     (WebCrypto never had it).
//   * Node 17+ links OpenSSL 3, which moved DES to the "legacy" provider:
//     crypto.createDecipheriv('des-ecb', …) throws ERR_OSSL_EVP_UNSUPPORTED
//     unless the process was started with --openssl-legacy-provider.
//   So a client that must read JioSaavn's `encrypted_media_url` everywhere
//   needs its own few hundred lines of DES. This is that, and nothing more.
//
// Security note: DES is broken and ECB leaks structure (every JioSaavn URL
// encrypts to the same "ID2ieOjCrwfgWvL5sXl4B1ImC5QfbsDy" prefix because they
// all start "https://aac.saavncdn.com/"). Here it is a public obfuscation
// protocol with a public key, not security. Do not use this for anything else.
//
// Implementation: the textbook FIPS 46-3 algorithm on 32-bit halves.
//   * Key schedule: PC-1, 16 rotations, PC-2 -> 16 x eight 6-bit subkey chunks.
//   * Rounds: the E expansion is done by rotating R right by one bit and taking
//     eight overlapping 6-bit windows; S-box and P permutation are fused into
//     eight 64-entry "SP" tables built once at module load.
//   * IP / FP are generic bit permutations (64 steps per block; fine for the
//     few dozen blocks a URL has).
// Parity bits (bit 8 of each key byte) are ignored, as in every DES, so JCE's
// "keys are not parity-checked" behaviour is matched.

/** Thrown for wrong key size, ciphertext not a multiple of 8, or bad padding. */
export class DesError extends Error {
  constructor(message) {
    super(message);
    this.name = 'DesError';
  }
}

// ---- FIPS 46-3 tables (1-indexed bit positions, bit 1 = MSB) ---------------

const IP = [
  58, 50, 42, 34, 26, 18, 10, 2, 60, 52, 44, 36, 28, 20, 12, 4,
  62, 54, 46, 38, 30, 22, 14, 6, 64, 56, 48, 40, 32, 24, 16, 8,
  57, 49, 41, 33, 25, 17, 9, 1, 59, 51, 43, 35, 27, 19, 11, 3,
  61, 53, 45, 37, 29, 21, 13, 5, 63, 55, 47, 39, 31, 23, 15, 7,
];

const FP = [
  40, 8, 48, 16, 56, 24, 64, 32, 39, 7, 47, 15, 55, 23, 63, 31,
  38, 6, 46, 14, 54, 22, 62, 30, 37, 5, 45, 13, 53, 21, 61, 29,
  36, 4, 44, 12, 52, 20, 60, 28, 35, 3, 43, 11, 51, 19, 59, 27,
  34, 2, 42, 10, 50, 18, 58, 26, 33, 1, 41, 9, 49, 17, 57, 25,
];

const P = [
  16, 7, 20, 21, 29, 12, 28, 17, 1, 15, 23, 26, 5, 18, 31, 10,
  2, 8, 24, 14, 32, 27, 3, 9, 19, 13, 30, 6, 22, 11, 4, 25,
];

const PC1 = [
  57, 49, 41, 33, 25, 17, 9, 1, 58, 50, 42, 34, 26, 18,
  10, 2, 59, 51, 43, 35, 27, 19, 11, 3, 60, 52, 44, 36,
  63, 55, 47, 39, 31, 23, 15, 7, 62, 54, 46, 38, 30, 22,
  14, 6, 61, 53, 45, 37, 29, 21, 13, 5, 28, 20, 12, 4,
];

const PC2 = [
  14, 17, 11, 24, 1, 5, 3, 28, 15, 6, 21, 10,
  23, 19, 12, 4, 26, 8, 16, 7, 27, 20, 13, 2,
  41, 52, 31, 37, 47, 55, 30, 40, 51, 45, 33, 48,
  44, 49, 39, 56, 34, 53, 46, 42, 50, 36, 29, 32,
];

const SHIFTS = [1, 1, 2, 2, 2, 2, 2, 2, 1, 2, 2, 2, 2, 2, 2, 1];

// S-boxes, 4 rows x 16 columns each, row-major.
const SBOX = [
  [14, 4, 13, 1, 2, 15, 11, 8, 3, 10, 6, 12, 5, 9, 0, 7,
    0, 15, 7, 4, 14, 2, 13, 1, 10, 6, 12, 11, 9, 5, 3, 8,
    4, 1, 14, 8, 13, 6, 2, 11, 15, 12, 9, 7, 3, 10, 5, 0,
    15, 12, 8, 2, 4, 9, 1, 7, 5, 11, 3, 14, 10, 0, 6, 13],
  [15, 1, 8, 14, 6, 11, 3, 4, 9, 7, 2, 13, 12, 0, 5, 10,
    3, 13, 4, 7, 15, 2, 8, 14, 12, 0, 1, 10, 6, 9, 11, 5,
    0, 14, 7, 11, 10, 4, 13, 1, 5, 8, 12, 6, 9, 3, 2, 15,
    13, 8, 10, 1, 3, 15, 4, 2, 11, 6, 7, 12, 0, 5, 14, 9],
  [10, 0, 9, 14, 6, 3, 15, 5, 1, 13, 12, 7, 11, 4, 2, 8,
    13, 7, 0, 9, 3, 4, 6, 10, 2, 8, 5, 14, 12, 11, 15, 1,
    13, 6, 4, 9, 8, 15, 3, 0, 11, 1, 2, 12, 5, 10, 14, 7,
    1, 10, 13, 0, 6, 9, 8, 7, 4, 15, 14, 3, 11, 5, 2, 12],
  [7, 13, 14, 3, 0, 6, 9, 10, 1, 2, 8, 5, 11, 12, 4, 15,
    13, 8, 11, 5, 6, 15, 0, 3, 4, 7, 2, 12, 1, 10, 14, 9,
    10, 6, 9, 0, 12, 11, 7, 13, 15, 1, 3, 14, 5, 2, 8, 4,
    3, 15, 0, 6, 10, 1, 13, 8, 9, 4, 5, 11, 12, 7, 2, 14],
  [2, 12, 4, 1, 7, 10, 11, 6, 8, 5, 3, 15, 13, 0, 14, 9,
    14, 11, 2, 12, 4, 7, 13, 1, 5, 0, 15, 10, 3, 9, 8, 6,
    4, 2, 1, 11, 10, 13, 7, 8, 15, 9, 12, 5, 6, 3, 0, 14,
    11, 8, 12, 7, 1, 14, 2, 13, 6, 15, 0, 9, 10, 4, 5, 3],
  [12, 1, 10, 15, 9, 2, 6, 8, 0, 13, 3, 4, 14, 7, 5, 11,
    10, 15, 4, 2, 7, 12, 9, 5, 6, 1, 13, 14, 0, 11, 3, 8,
    9, 14, 15, 5, 2, 8, 12, 3, 7, 0, 4, 10, 1, 13, 11, 6,
    4, 3, 2, 12, 9, 5, 15, 10, 11, 14, 1, 7, 6, 0, 8, 13],
  [4, 11, 2, 14, 15, 0, 8, 13, 3, 12, 9, 7, 5, 10, 6, 1,
    13, 0, 11, 7, 4, 9, 1, 10, 14, 3, 5, 12, 2, 15, 8, 6,
    1, 4, 11, 13, 12, 3, 7, 14, 10, 15, 6, 8, 0, 5, 9, 2,
    6, 11, 13, 8, 1, 4, 10, 7, 9, 5, 0, 15, 14, 2, 3, 12],
  [13, 2, 8, 4, 6, 15, 11, 1, 10, 9, 3, 14, 5, 0, 12, 7,
    1, 15, 13, 8, 10, 3, 7, 4, 12, 5, 6, 11, 0, 14, 9, 2,
    7, 11, 4, 1, 9, 12, 14, 2, 0, 6, 10, 13, 15, 3, 5, 8,
    2, 1, 14, 7, 4, 10, 8, 13, 15, 12, 9, 0, 3, 5, 6, 11],
];

/** Permute a 32-bit word by a 32-entry table. */
function permute32(word, table) {
  let out = 0;
  for (let i = 0; i < 32; i++) out = (out << 1) | ((word >>> (32 - table[i])) & 1);
  return out >>> 0;
}

/** Permute a 64-bit block held as two 32-bit halves by a 64-entry table. */
function permute64(hi, lo, table) {
  let oh = 0;
  let ol = 0;
  for (let i = 0; i < 64; i++) {
    const n = table[i];
    const bit = n <= 32 ? (hi >>> (32 - n)) & 1 : (lo >>> (64 - n)) & 1;
    if (i < 32) oh = (oh << 1) | bit;
    else ol = (ol << 1) | bit;
  }
  return [oh >>> 0, ol >>> 0];
}

// SP[i][x]: S-box i applied to the 6-bit input x, its 4-bit output placed in
// nibble i of the word, then pushed through P. OR-ing the eight is f()'s output.
const SP = SBOX.map((box, i) => {
  const table = new Uint32Array(64);
  for (let x = 0; x < 64; x++) {
    const row = ((x >> 4) & 2) | (x & 1); // outer bits b1 b6
    const col = (x >> 1) & 15; // inner bits b2..b5
    table[x] = permute32(box[row * 16 + col] << (28 - 4 * i), P);
  }
  return table;
});

/** The Feistel function f(R, K) for one round. `k` is eight 6-bit subkey chunks. */
function feistel(r, k) {
  // Rotating R right by one lines its bits up as [32, 1, 2, …, 31], so E's
  // eight groups (32 1 2 3 4 5 | 4 5 6 7 8 9 | … | 28 29 30 31 32 1) are
  // overlapping 6-bit windows every 4 bits; the last one wraps around.
  const x = ((r >>> 1) | (r << 31)) >>> 0;
  return (
    SP[0][((x >>> 26) & 63) ^ k[0]] |
    SP[1][((x >>> 22) & 63) ^ k[1]] |
    SP[2][((x >>> 18) & 63) ^ k[2]] |
    SP[3][((x >>> 14) & 63) ^ k[3]] |
    SP[4][((x >>> 10) & 63) ^ k[4]] |
    SP[5][((x >>> 6) & 63) ^ k[5]] |
    SP[6][((x >>> 2) & 63) ^ k[6]] |
    SP[7][(((x & 15) << 2) | (x >>> 30)) ^ k[7]]
  ) >>> 0;
}

/** 16 round subkeys, each as eight 6-bit chunks, from 8 key bytes. */
function keySchedule(key) {
  const bit = (n) => (key[(n - 1) >> 3] >> (7 - ((n - 1) & 7))) & 1;
  let c = 0;
  let d = 0;
  for (let i = 0; i < 28; i++) c = (c << 1) | bit(PC1[i]);
  for (let i = 28; i < 56; i++) d = (d << 1) | bit(PC1[i]);
  const subkeys = [];
  for (let round = 0; round < 16; round++) {
    const s = SHIFTS[round];
    c = ((c << s) | (c >>> (28 - s))) & 0x0fffffff;
    d = ((d << s) | (d >>> (28 - s))) & 0x0fffffff;
    const chunks = new Uint8Array(8);
    for (let j = 0; j < 8; j++) {
      let v = 0;
      for (let b = 0; b < 6; b++) {
        const n = PC2[j * 6 + b]; // 1..56 over C||D
        v = (v << 1) | (n <= 28 ? (c >>> (28 - n)) & 1 : (d >>> (56 - n)) & 1);
      }
      chunks[j] = v;
    }
    subkeys.push(chunks);
  }
  return subkeys;
}

// Tiny memo: a client only ever uses one or two keys.
const scheduleCache = new Map();
function scheduleFor(key) {
  const id = Array.prototype.join.call(key, ',');
  let subkeys = scheduleCache.get(id);
  if (!subkeys) {
    if (scheduleCache.size >= 8) scheduleCache.clear();
    subkeys = keySchedule(key);
    scheduleCache.set(id, subkeys);
  }
  return subkeys;
}

/** Encrypt or decrypt one 8-byte block of `src` at `off` into `dst` at the same offset. */
function cryptBlock(src, dst, off, subkeys, decrypt) {
  const hi = ((src[off] << 24) | (src[off + 1] << 16) | (src[off + 2] << 8) | src[off + 3]) >>> 0;
  const lo = ((src[off + 4] << 24) | (src[off + 5] << 16) | (src[off + 6] << 8) | src[off + 7]) >>> 0;
  let [l, r] = permute64(hi, lo, IP);
  for (let round = 0; round < 16; round++) {
    const next = (l ^ feistel(r, subkeys[decrypt ? 15 - round : round])) >>> 0;
    l = r;
    r = next;
  }
  // The pre-output block is R16 L16 (the last round does not swap).
  const [oh, ol] = permute64(r, l, FP);
  dst[off] = oh >>> 24; dst[off + 1] = (oh >>> 16) & 255; dst[off + 2] = (oh >>> 8) & 255; dst[off + 3] = oh & 255;
  dst[off + 4] = ol >>> 24; dst[off + 5] = (ol >>> 16) & 255; dst[off + 6] = (ol >>> 8) & 255; dst[off + 7] = ol & 255;
}

/** UTF-8 encode without relying on TextEncoder (absent on some RN engines). */
function utf8Bytes(text) {
  if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(text);
  const out = [];
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    if (cp < 0x80) out.push(cp);
    else if (cp < 0x800) out.push(0xc0 | (cp >> 6), 0x80 | (cp & 63));
    else if (cp < 0x10000) out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
    else out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 63), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
  }
  return Uint8Array.from(out);
}

/**
 * Normalise a key the way `SecretKeySpec(key.toByteArray(UTF_8), "DES")` +
 * JCE's DES cipher do: UTF-8 bytes for a string, and the first 8 bytes used.
 */
function keyBytes(key) {
  const bytes = typeof key === 'string' ? utf8Bytes(key) : key;
  if (!(bytes instanceof Uint8Array) || bytes.length < 8) {
    throw new DesError('DES key must be at least 8 bytes (a string or a Uint8Array)');
  }
  return bytes.subarray(0, 8);
}

function asBytes(data) {
  if (data instanceof Uint8Array) return data;
  if (typeof data === 'string') return utf8Bytes(data);
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  throw new DesError('data must be a Uint8Array, ArrayBuffer view, ArrayBuffer or string');
}

/**
 * DES-ECB encrypt. With `padding` (the default) PKCS#5/#7 padding is added,
 * which is what Java's "DES/ECB/PKCS5Padding" does.
 * @param {string|Uint8Array} key 8 bytes (a string is UTF-8 encoded)
 * @param {Uint8Array|string} data
 * @param {{padding?: boolean}} [options]
 * @returns {Uint8Array}
 */
export function desEncrypt(key, data, { padding = true } = {}) {
  const subkeys = scheduleFor(keyBytes(key));
  const input = asBytes(data);
  let block;
  if (padding) {
    const pad = 8 - (input.length % 8); // 1..8: a full block when already aligned
    block = new Uint8Array(input.length + pad);
    block.set(input);
    block.fill(pad, input.length);
  } else {
    if (input.length % 8 !== 0) throw new DesError(`input length ${input.length} is not a multiple of 8`);
    block = Uint8Array.from(input);
  }
  for (let off = 0; off < block.length; off += 8) cryptBlock(block, block, off, subkeys, false);
  return block;
}

/**
 * DES-ECB decrypt. With `padding` (the default) PKCS#5/#7 padding is checked
 * and removed; a malformed pad throws DesError, as BadPaddingException does in
 * Java. Empty input decrypts to empty output, also as in Java.
 * @param {string|Uint8Array} key
 * @param {Uint8Array|ArrayBuffer} data
 * @param {{padding?: boolean}} [options]
 * @returns {Uint8Array}
 */
export function desDecrypt(key, data, { padding = true } = {}) {
  const subkeys = scheduleFor(keyBytes(key));
  const input = asBytes(data);
  if (input.length % 8 !== 0) throw new DesError(`ciphertext length ${input.length} is not a multiple of 8`);
  const out = new Uint8Array(input.length);
  for (let off = 0; off < input.length; off += 8) cryptBlock(input, out, off, subkeys, true);
  if (!padding || out.length === 0) return out;
  const pad = out[out.length - 1];
  if (pad < 1 || pad > 8) throw new DesError('bad PKCS#5 padding');
  for (let i = out.length - pad; i < out.length; i++) {
    if (out[i] !== pad) throw new DesError('bad PKCS#5 padding');
  }
  return out.subarray(0, out.length - pad);
}
