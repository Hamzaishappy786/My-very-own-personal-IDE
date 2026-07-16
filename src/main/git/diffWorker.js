'use strict';

const { parentPort } = require('worker_threads');
const { classifyDiff, splitLines } = require('../../shared/gitDiffCore');

parentPort.on('message', ({ id, oldText, newText }) => {
  try {
    const markers = classifyDiff(splitLines(oldText), splitLines(newText));
    parentPort.postMessage({ id, markers });
  } catch (err) {
    parentPort.postMessage({ id, error: err.message });
  }
});
