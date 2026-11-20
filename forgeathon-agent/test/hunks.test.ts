import test from 'node:test';
import assert from 'node:assert/strict';
import { computeHunks, renderHunks, applyEdits, splitLines } from '../src/review/hunks';

const orig = 'a\nb\nc\nd\ne\nf\ng\n';

test('no change -> no hunks', () => {
  assert.equal(computeHunks(orig, orig).length, 0);
});

test('two separate edits -> two hunks; all included reproduces proposal', () => {
  const prop = 'a\nB\nc\nd\ne\nF\nF2\ng\n';
  const hunks = computeHunks(orig, prop);
  assert.equal(hunks.length, 2);
  assert.equal(renderHunks(orig, hunks, () => true).text, prop);
  assert.equal(renderHunks(orig, hunks, () => false).text, orig);
});

test('partial accept applies only chosen hunk', () => {
  const prop = 'a\nB\nc\nd\ne\nF\ng\n';
  const hunks = computeHunks(orig, prop);
  const only2 = renderHunks(orig, hunks, (h) => h.id === 1).text;
  assert.equal(only2, 'a\nb\nc\nd\ne\nF\ng\n');
  const only1 = renderHunks(orig, hunks, (h) => h.id === 0).text;
  assert.equal(only1, 'a\nB\nc\nd\ne\nf\ng\n');
});

test('pure insertion and pure deletion', () => {
  const ins = computeHunks(orig, 'a\nb\nNEW\nc\nd\ne\nf\ng\n');
  assert.equal(ins.length, 1);
  assert.equal(ins[0].oldLines.length, 0);
  assert.equal(renderHunks(orig, ins, () => true).text, 'a\nb\nNEW\nc\nd\ne\nf\ng\n');
  const del = computeHunks(orig, 'a\nb\nd\ne\nf\ng\n');
  assert.equal(del.length, 1);
  assert.equal(renderHunks(orig, del, () => true).text, 'a\nb\nd\ne\nf\ng\n');
});

test('new file (empty original) and starts map', () => {
  const hunks = computeHunks('', 'x\ny\n');
  assert.equal(hunks.length, 1);
  const r = renderHunks('', hunks, () => true);
  assert.equal(r.text, 'x\ny\n');
  assert.equal(r.starts.get(0), 0);
});

test('starts reflect earlier included/excluded hunks', () => {
  const prop = 'a\nB\nB2\nB3\nc\nd\ne\nF\ng\n';
  const hunks = computeHunks(orig, prop);
  const all = renderHunks(orig, hunks, () => true);
  assert.equal(all.starts.get(1), 7);
  const noFirst = renderHunks(orig, hunks, (h) => h.id === 1);
  assert.equal(noFirst.starts.get(1), 5);
});

test('file without trailing newline round-trips', () => {
  const o = 'a\nb';
  const p = 'a\nB';
  const h = computeHunks(o, p);
  assert.equal(renderHunks(o, h, () => true).text, p);
  assert.deepEqual(splitLines('x\ny'), ['x\n', 'y']);
});

test('applyEdits: ok, not found, ambiguous, CRLF', () => {
  assert.deepEqual(applyEdits('foo bar', [{ old_str: 'foo', new_str: 'baz' }]), { ok: true, content: 'baz bar' });
  const nf = applyEdits('foo', [{ old_str: 'zzz', new_str: 'x' }]);
  assert.equal(nf.ok, false);
  const amb = applyEdits('x x', [{ old_str: 'x', new_str: 'y' }]);
  assert.equal(amb.ok, false);
  const crlf = applyEdits('a\r\nb\r\n', [{ old_str: 'a\nb', new_str: 'a\nc' }]);
  assert.deepEqual(crlf, { ok: true, content: 'a\r\nc\r\n' });
});
