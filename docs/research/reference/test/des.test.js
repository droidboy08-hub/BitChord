// Tests for sources/des.js (mirrors the DES/ECB/PKCS5Padding call in
// data/jiosaavn/JioSaavnService.kt), against published DES vectors and OpenSSL output.
// Independent JavaScript re-implementation of the mechanism documented in
// BITCHORD_ENGINE_RESEARCH.md (BitChord itself is GPL-3.0; InnerTubeX is GPL-3.0).
//
// Single-block vectors: FIPS 81 / NBS SP 500-20 / J. Orlin Grabbe's worked
// example; every one was re-checked with `openssl enc -des-ecb -nopad
// -provider legacy`. Padded fixtures were produced by the same command without
// -nopad (i.e. PKCS#5), with the JioSaavn key "38346591".

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { desEncrypt, desDecrypt, DesError } from '../sources/des.js';

const hex = (h) => Uint8Array.from(h.match(/../g) ?? [], (x) => Number.parseInt(x, 16));
const toHex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('').toUpperCase();
const b64 = (bytes) => Buffer.from(bytes).toString('base64');
const fromB64 = (s) => new Uint8Array(Buffer.from(s, 'base64'));

const VECTORS = [
  // [key, plaintext, ciphertext]
  ['133457799BBCDFF1', '0123456789ABCDEF', '85E813540F0AB405'], // Grabbe, "The DES Algorithm Illustrated"
  ['0E329232EA6D0D73', '8787878787878787', '0000000000000000'],
  ['0123456789ABCDEF', '4E6F772069732074', '3FA40E8A984D4815'], // FIPS 81 ECB example ("Now is t")
  ['0101010101010101', '8000000000000000', '95F8A5E5DD31D900'], // NBS variable-plaintext test
  ['0101010101010101', '95F8A5E5DD31D900', '8000000000000000'], // …and its inverse
  ['8001010101010101', '0000000000000000', '95A8D72813DAA94D'], // NBS variable-key test
  ['7CA110454A1A6E57', '01A1D6D039776742', '690F5B0D9A26939B'], // NIST SP 800-17 sample
  ['FEDCBA9876543210', '0123456789ABCDEF', 'ED39D950FA74BCC4'],
];

test('single-block encryption matches the standard vectors', () => {
  for (const [key, plain, cipher] of VECTORS) {
    assert.equal(toHex(desEncrypt(hex(key), hex(plain), { padding: false })), cipher, `key ${key}`);
  }
});

test('single-block decryption inverts the standard vectors', () => {
  for (const [key, plain, cipher] of VECTORS) {
    assert.equal(toHex(desDecrypt(hex(key), hex(cipher), { padding: false })), plain, `key ${key}`);
  }
});

test('the complementation property holds: E(~K, ~P) = ~E(K, P)', () => {
  const invert = (bytes) => bytes.map((b) => b ^ 0xff);
  for (const [key, plain, cipher] of VECTORS) {
    const out = desEncrypt(invert(hex(key)), invert(hex(plain)), { padding: false });
    assert.equal(toHex(invert(out)), cipher);
  }
});

test('key parity bits are ignored, as in every DES implementation', () => {
  const key = hex('133457799BBCDFF1');
  const flipped = key.map((b) => b ^ 1); // bit 8 of each byte is parity
  assert.equal(
    toHex(desEncrypt(flipped, hex('0123456789ABCDEF'), { padding: false })),
    '85E813540F0AB405',
  );
});

test('PKCS#5 padding matches OpenSSL for short, aligned and multi-block input', () => {
  const key = '38346591';
  const fixtures = [
    ['ab', 'HZhzuK/qSRA='], // 6 bytes of 0x06
    ['12345678', '81SBY3r0THcYFOzGrFvJ/w=='], // aligned: a whole block of 0x08
    [
      'https://aac.saavncdn.com/815/2b2bb1d9d8d0ec5b8f4d6c21c1fda85b_96.mp4',
      'ID2ieOjCrwfgWvL5sXl4B1ImC5QfbsDyGgo96tPdy18TWbpZbksO0sY7aMNQNcyNGwdi5xI8ab93bGqNaDm60Rw7tS9a8Gtq',
    ],
  ];
  for (const [plain, cipher] of fixtures) {
    assert.equal(b64(desEncrypt(key, plain)), cipher, plain);
    assert.equal(new TextDecoder().decode(desDecrypt(key, fromB64(cipher))), plain, plain);
  }
});

test('ECB: identical plaintext blocks give identical ciphertext blocks (the shared JioSaavn prefix)', () => {
  const a = desEncrypt('38346591', 'https://aac.saavncdn.com/001/deadbeef_48.mp4');
  const b = desEncrypt('38346591', 'https://aac.saavncdn.com/815/2b2bb1d9d8d0ec5b8f4d6c21c1fda85b_96.mp4');
  // "https://aac.saavncdn.com/" is 25 bytes: the first 3 blocks (24 bytes) coincide.
  assert.equal(b64(a.subarray(0, 24)), b64(b.subarray(0, 24)));
  assert.ok(b64(a).startsWith('ID2ieOjCrwfgWvL5sXl4B1ImC5QfbsDy'));
});

test('round trip for every length 0..40 with random keys', () => {
  for (let n = 0; n <= 40; n++) {
    const key = Uint8Array.from({ length: 8 }, () => Math.floor(Math.random() * 256));
    const data = Uint8Array.from({ length: n }, () => Math.floor(Math.random() * 256));
    const sealed = desEncrypt(key, data);
    assert.equal(sealed.length, (Math.floor(n / 8) + 1) * 8, `ciphertext length for ${n}`);
    assert.deepEqual(desDecrypt(key, sealed), data);
  }
});

test('a string key is its UTF-8 bytes and only the first 8 bytes are used (JCE)', () => {
  const asString = desEncrypt('38346591', 'hello');
  const asBytes = desEncrypt(new TextEncoder().encode('38346591'), 'hello');
  const longer = desEncrypt('38346591-and-more', 'hello');
  assert.deepEqual(asString, asBytes);
  assert.deepEqual(asString, longer);
});

test('string keys and data work without TextEncoder (older React Native)', () => {
  const expected = b64(desEncrypt('38346591', 'https://aac.saavncdn.com/x_96.mp4 ✓'));
  const saved = globalThis.TextEncoder;
  globalThis.TextEncoder = undefined;
  try {
    assert.equal(b64(desEncrypt('38346591', 'https://aac.saavncdn.com/x_96.mp4 ✓')), expected);
  } finally {
    globalThis.TextEncoder = saved;
  }
});

test('empty ciphertext decrypts to empty output (as Java does)', () => {
  assert.equal(desDecrypt('38346591', new Uint8Array(0)).length, 0);
});

test('malformed input is rejected with DesError', () => {
  assert.throws(() => desDecrypt('38346591', new Uint8Array(7)), DesError); // not a multiple of 8
  assert.throws(() => desEncrypt('short', 'x'), DesError); // key under 8 bytes
  assert.throws(() => desEncrypt('38346591', new Uint8Array(3), { padding: false }), DesError);
  // A block whose last byte is 0x00 after decryption is invalid PKCS#5.
  const zeroPadded = desEncrypt('38346591', new Uint8Array(8), { padding: false });
  assert.throws(() => desDecrypt('38346591', zeroPadded), DesError);
  // Inconsistent padding bytes (…0x01 0x02) are invalid too.
  const inconsistent = desEncrypt('38346591', Uint8Array.from([1, 2, 3, 4, 5, 6, 1, 2]), { padding: false });
  assert.throws(() => desDecrypt('38346591', inconsistent), DesError);
});

test('the module does not touch node:crypto (it must run on React Native)', () => {
  const source = readFileSync(new URL('../sources/des.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /from ['"](?:node:)?crypto['"]|require\(['"](?:node:)?crypto['"]\)/);
});
