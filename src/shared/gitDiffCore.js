'use strict';

/**
 * Pure, Electron-free diff logic shared by the main-process worker thread
 * and the unit tests. No Node built-ins beyond plain JS are used here so it
 * can run inside a worker_threads Worker with zero setup.
 *
 * @typedef {'equal'|'insert'|'delete'} DiffOpType
 * @typedef {{ type: DiffOpType, oldIndex?: number, newIndex?: number, oldLine?: string, newLine?: string }} DiffOp
 * @typedef {'added'|'modified'|'deleted'} MarkerType
 * @typedef {{ line: number, type: MarkerType, deletedCount?: number }} LineMarker
 */

/**
 * Classic Myers O(ND) diff over two arrays of lines. Returns an ordered edit
 * script of `equal`/`insert`/`delete` operations that turns `oldLines` into
 * `newLines`.
 * @param {string[]} oldLines
 * @param {string[]} newLines
 * @returns {DiffOp[]}
 */
function myersDiff(oldLines, newLines) {
  const n = oldLines.length;
  const m = newLines.length;
  const max = n + m;
  if (max === 0) return [];

  const offset = max;
  const vSize = 2 * max + 1;
  let v = new Array(vSize).fill(0);
  const trace = [];

  let found = false;

  search:
  for (let d = 0; d <= max; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x;
      if (k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])) {
        x = v[offset + k + 1];
      } else {
        x = v[offset + k - 1] + 1;
      }
      let y = x - k;

      while (x < n && y < m && oldLines[x] === newLines[y]) {
        x++;
        y++;
      }

      v[offset + k] = x;

      if (x >= n && y >= m) {
        found = true;
        break search;
      }
    }
  }

  if (!found) {
    // Defensive fallback; the loop above always finds a path within `max` steps.
    trace.push(v.slice());
  }

  const ops = [];
  let x = n;
  let y = m;

  for (let d = trace.length - 1; d >= 0 && (x > 0 || y > 0); d--) {
    const vPrev = trace[d];
    const k = x - y;

    let prevK;
    if (k === -d || (k !== d && vPrev[offset + k - 1] < vPrev[offset + k + 1])) {
      prevK = k + 1;
    } else {
      prevK = k - 1;
    }

    const prevX = vPrev[offset + prevK];
    const prevY = prevX - prevK;

    while (x > prevX && y > prevY) {
      ops.push({ type: 'equal', oldIndex: x - 1, newIndex: y - 1, oldLine: oldLines[x - 1], newLine: newLines[y - 1] });
      x--;
      y--;
    }

    if (d > 0) {
      if (x === prevX) {
        ops.push({ type: 'insert', newIndex: y - 1, newLine: newLines[y - 1] });
        y--;
      } else {
        ops.push({ type: 'delete', oldIndex: x - 1, oldLine: oldLines[x - 1] });
        x--;
      }
    }
  }

  ops.reverse();
  return ops;
}

/**
 * Diffs two line arrays, trimming the common prefix/suffix first so Myers
 * diff only ever runs over the region that actually changed. This is what
 * keeps single-keystroke edits in a large file cheap: a one-character edit
 * on line 500 of a 5000-line file reduces to a diff over ~1 line, not 5000.
 * @param {string[]} oldLines
 * @param {string[]} newLines
 * @returns {DiffOp[]}
 */
function diffLines(oldLines, newLines) {
  const minLen = Math.min(oldLines.length, newLines.length);

  let prefix = 0;
  while (prefix < minLen && oldLines[prefix] === newLines[prefix]) prefix++;

  let suffix = 0;
  while (
    suffix < minLen - prefix &&
    oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) {
    suffix++;
  }

  const oldMid = oldLines.slice(prefix, oldLines.length - suffix);
  const newMid = newLines.slice(prefix, newLines.length - suffix);
  const midOps = myersDiff(oldMid, newMid);

  const ops = [];
  for (let i = 0; i < prefix; i++) {
    ops.push({ type: 'equal', oldIndex: i, newIndex: i, oldLine: oldLines[i], newLine: newLines[i] });
  }
  for (const op of midOps) {
    ops.push({
      type: op.type,
      oldIndex: op.oldIndex !== undefined ? op.oldIndex + prefix : undefined,
      newIndex: op.newIndex !== undefined ? op.newIndex + prefix : undefined,
      oldLine: op.oldLine,
      newLine: op.newLine,
    });
  }
  const oldLen = oldLines.length;
  const newLen = newLines.length;
  for (let i = 0; i < suffix; i++) {
    const oi = oldLen - suffix + i;
    const ni = newLen - suffix + i;
    ops.push({ type: 'equal', oldIndex: oi, newIndex: ni, oldLine: oldLines[oi], newLine: newLines[ni] });
  }
  return ops;
}

/**
 * Groups a diff edit script into hunks and classifies each resulting new-file
 * line as added/modified, plus deleted-line anchor markers -- the same
 * heuristic VS Code's gutter uses: paired delete+insert lines within a hunk
 * are "modified", surplus inserts are "added", and surplus deletes collapse
 * into a single caret marker anchored at the line following the hunk.
 * @param {string[]} oldLines
 * @param {string[]} newLines
 * @returns {LineMarker[]}
 */
function classifyDiff(oldLines, newLines) {
  const ops = diffLines(oldLines, newLines);
  const markers = [];

  let i = 0;
  while (i < ops.length) {
    if (ops[i].type === 'equal') {
      i++;
      continue;
    }

    const deletions = [];
    const insertions = [];
    while (i < ops.length && ops[i].type !== 'equal') {
      if (ops[i].type === 'delete') deletions.push(ops[i]);
      else insertions.push(ops[i]);
      i++;
    }

    const modifiedCount = Math.min(deletions.length, insertions.length);
    for (let k = 0; k < modifiedCount; k++) {
      markers.push({ line: insertions[k].newIndex + 1, type: 'modified' });
    }
    for (let k = modifiedCount; k < insertions.length; k++) {
      markers.push({ line: insertions[k].newIndex + 1, type: 'added' });
    }

    if (deletions.length > modifiedCount) {
      let anchorLine;
      if (i < ops.length) {
        anchorLine = ops[i].newIndex + 1;
      } else if (insertions.length > 0) {
        anchorLine = insertions[insertions.length - 1].newIndex + 2;
      } else {
        anchorLine = newLines.length + 1;
      }
      markers.push({
        line: Math.max(1, anchorLine),
        type: 'deleted',
        deletedCount: deletions.length - modifiedCount,
      });
    }
  }

  return markers;
}

/**
 * Splits text into lines the same way regardless of the platform line-ending
 * style, so a repo checked out with CRLF diffs cleanly against LF buffers.
 * @param {string} text
 * @returns {string[]}
 */
function splitLines(text) {
  if (text === '') return [];
  return text.split(/\r\n|\r|\n/);
}

module.exports = { myersDiff, diffLines, classifyDiff, splitLines };
