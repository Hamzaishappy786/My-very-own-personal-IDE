'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { classifyDiff, diffLines, splitLines } = require('../src/shared/gitDiffCore');

function lines(text) {
  return splitLines(text);
}

test('identical content produces no markers', () => {
  const text = 'a\nb\nc';
  const markers = classifyDiff(lines(text), lines(text));
  assert.deepEqual(markers, []);
});

test('a single appended line is marked added', () => {
  const oldText = 'a\nb\nc';
  const newText = 'a\nb\nc\nd';
  const markers = classifyDiff(lines(oldText), lines(newText));
  assert.deepEqual(markers, [{ line: 4, type: 'added' }]);
});

test('a single inserted line in the middle is marked added, surrounding lines untouched', () => {
  const oldText = 'a\nb\nc';
  const newText = 'a\nX\nb\nc';
  const markers = classifyDiff(lines(oldText), lines(newText));
  assert.deepEqual(markers, [{ line: 2, type: 'added' }]);
});

test('editing a line in place is marked modified (paired delete+insert)', () => {
  const oldText = 'a\nb\nc';
  const newText = 'a\nB\nc';
  const markers = classifyDiff(lines(oldText), lines(newText));
  assert.deepEqual(markers, [{ line: 2, type: 'modified' }]);
});

test('a hunk with more insertions than deletions splits into modified + added', () => {
  const oldText = 'a\nb\nc';
  const newText = 'a\nB1\nB2\nc';
  const markers = classifyDiff(lines(oldText), lines(newText));
  assert.deepEqual(markers, [
    { line: 2, type: 'modified' },
    { line: 3, type: 'added' },
  ]);
});

test('a single deleted line surfaces one deleted marker anchored at the following line', () => {
  const oldText = 'a\nb\nc';
  const newText = 'a\nc';
  const markers = classifyDiff(lines(oldText), lines(newText));
  assert.deepEqual(markers, [{ line: 2, type: 'deleted', deletedCount: 1 }]);
});

test('multi-line deletion collapses into a single deleted marker with the correct count', () => {
  const oldText = 'a\nb\nc\nd\ne';
  const newText = 'a\ne';
  const markers = classifyDiff(lines(oldText), lines(newText));
  assert.deepEqual(markers, [{ line: 2, type: 'deleted', deletedCount: 3 }]);
});

test('deletion at end of file anchors past the last remaining line', () => {
  const oldText = 'a\nb\nc';
  const newText = 'a';
  const markers = classifyDiff(lines(oldText), lines(newText));
  assert.deepEqual(markers, [{ line: 2, type: 'deleted', deletedCount: 2 }]);
});

test('deleting every line of a non-empty file anchors at line 1', () => {
  const oldText = 'a\nb';
  const newText = '';
  const markers = classifyDiff(lines(oldText), lines(newText));
  assert.deepEqual(markers, [{ line: 1, type: 'deleted', deletedCount: 2 }]);
});

test('brand new content against an empty HEAD blob marks every line added', () => {
  const oldText = '';
  const newText = 'a\nb\nc';
  const markers = classifyDiff(lines(oldText), lines(newText));
  assert.deepEqual(markers, [
    { line: 1, type: 'added' },
    { line: 2, type: 'added' },
    { line: 3, type: 'added' },
  ]);
});

test('rapid single-keystroke typing only ever touches the edited line', () => {
  // Simulates typing "hello" character-by-character into an otherwise
  // untouched 3-line file and re-diffing against the same HEAD content
  // after every keystroke, the way the debounced buffer-change hook does.
  const head = 'line1\nline2\nline3';
  const target = 'line1\nhello\nline3';
  let current = 'line1\n\nline3';
  const typed = 'hello';

  for (let i = 1; i <= typed.length; i++) {
    const partial = typed.slice(0, i);
    current = `line1\n${partial}\nline3`;
    const markers = classifyDiff(lines(head), lines(current));
    assert.deepEqual(markers, [{ line: 2, type: 'modified' }]);
  }

  assert.equal(current, target);
});

test('diffLines trims common prefix and suffix so only the changed middle is diffed', () => {
  const oldLines = ['a', 'b', 'c', 'd', 'e'];
  const newLines = ['a', 'b', 'X', 'd', 'e'];
  const ops = diffLines(oldLines, newLines);
  const nonEqual = ops.filter((op) => op.type !== 'equal');
  assert.deepEqual(nonEqual, [
    { type: 'delete', oldIndex: 2, oldLine: 'c', newIndex: undefined, newLine: undefined },
    { type: 'insert', newIndex: 2, newLine: 'X', oldIndex: undefined, oldLine: undefined },
  ]);
});

test('splitLines treats an empty string as zero lines, not one', () => {
  assert.deepEqual(splitLines(''), []);
});

test('splitLines normalizes CRLF and CR line endings alongside LF', () => {
  assert.deepEqual(splitLines('a\r\nb\rc\nd'), ['a', 'b', 'c', 'd']);
});
