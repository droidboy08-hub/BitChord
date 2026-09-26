import { test } from 'node:test';
import assert from 'node:assert/strict';
import { line, isWordSynced, isLineSynced, plainLines } from '../lyrics/model.js';

test('sync classification', () => {
  assert.equal(isWordSynced([line(0, 'a')]), false);
  assert.equal(isLineSynced([line(1000, 'a')]), true);
  assert.equal(isWordSynced([line(1000, 'a', [{ startMs: 1000, endMs: 1200, text: 'a' }])]), true);
});

test('plainLines keeps single blank lines as stanza breaks', () => {
  const out = plainLines('one\r\ntwo\n\n\nthree');
  assert.deepEqual(out.map((l) => l.text), ['one', 'two', '', 'three']);
  assert.ok(out.every((l) => l.timeMs === 0));
});
