'use strict';

const { Worker } = require('worker_threads');
const path = require('path');

/**
 * Runs line-diff classification on a single reusable worker_threads Worker
 * so per-keystroke diffing never touches the main (UI) process's event loop.
 */
class DiffEngine {
  constructor() {
    this.worker = null;
    this.nextId = 1;
    this.pending = new Map();
  }

  ensureWorker() {
    if (this.worker) return;
    this.worker = new Worker(path.join(__dirname, 'diffWorker.js'));
    this.worker.on('message', (msg) => {
      const resolver = this.pending.get(msg.id);
      if (!resolver) return;
      this.pending.delete(msg.id);
      if (msg.error) resolver.reject(new Error(msg.error));
      else resolver.resolve(msg.markers);
    });
    this.worker.on('error', (err) => {
      for (const { reject } of this.pending.values()) reject(err);
      this.pending.clear();
      this.worker = null;
    });
    this.worker.on('exit', () => {
      this.worker = null;
    });
  }

  /**
   * @param {string} oldText
   * @param {string} newText
   * @returns {Promise<import('../../shared/gitDiffCore').LineMarker[]>}
   */
  computeLineDiff(oldText, newText) {
    this.ensureWorker();
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ id, oldText, newText });
    });
  }

  dispose() {
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
    this.pending.clear();
  }
}

module.exports = { DiffEngine };
