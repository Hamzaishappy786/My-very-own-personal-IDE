/* global monaco, window */

/**
 * Inline Git diff gutter. Tracks each open buffer against its HEAD blob and
 * renders added/modified/deleted markers as Monaco line decorations. All
 * Git I/O and the actual line-diffing run in the main process (see
 * src/main/git/*); this module only orchestrates *when* to ask for a new
 * diff and turns the resulting markers into decorations on the model.
 */
(function () {
  const MAX_FILE_SIZE_BYTES = 5 * 1024 * 1024;
  const DEBOUNCE_MS = 500;

  // filePath -> entry. Kept keyed by path (not model) so open/close/save
  // hooks in renderer.js can address entries without holding a model ref.
  const files = new Map();
  // filePath -> monotonically increasing token, bumped on every open/close
  // so an in-flight IPC round-trip from a stale open can't clobber state
  // for a file that was closed (or reopened) while it was awaiting.
  const openGenerations = new Map();

  let activePath = null;

  function bumpGeneration(filePath) {
    const next = (openGenerations.get(filePath) || 0) + 1;
    openGenerations.set(filePath, next);
    return next;
  }

  function classNameFor(type) {
    if (type === 'added') return 'hator-git-added';
    if (type === 'modified') return 'hator-git-modified';
    return 'hator-git-deleted';
  }

  function applyDecorations(entry, markers) {
    if (entry.model.isDisposed()) return;
    const lineCount = Math.max(1, entry.model.getLineCount());
    const decorations = markers.map((marker) => {
      const line = Math.min(Math.max(1, marker.line), lineCount);
      return {
        range: new monaco.Range(line, 1, line, 1),
        options: {
          isWholeLine: true,
          linesDecorationsClassName: classNameFor(marker.type),
        },
      };
    });
    entry.decorationIds = entry.model.deltaDecorations(entry.decorationIds, decorations);
  }

  function clearDecorations(entry) {
    if (!entry.model.isDisposed()) {
      entry.model.deltaDecorations(entry.decorationIds, []);
    }
    entry.decorationIds = [];
  }

  async function recompute(filePath) {
    const entry = files.get(filePath);
    if (!entry || entry.disabled || entry.model.isDisposed()) return;
    const gen = entry.gen;

    let markers;
    try {
      markers = await window.api.git.computeDiff(entry.headContent, entry.model.getValue());
    } catch {
      return;
    }

    if (openGenerations.get(filePath) !== gen) return; // file closed/reopened mid-flight
    const stillEntry = files.get(filePath);
    if (!stillEntry || stillEntry !== entry) return;
    applyDecorations(entry, markers);
  }

  async function enableForFile(filePath, model, gen) {
    const sizeBytes = new Blob([model.getValue()]).size;
    if (sizeBytes > MAX_FILE_SIZE_BYTES) {
      files.set(filePath, { model, gen, disabled: true, decorationIds: [] });
      return;
    }

    const state = await window.api.git.getFileState(filePath);
    if (openGenerations.get(filePath) !== gen) return;

    if (!state.isRepo || !state.hasHead || !state.tracked) {
      files.set(filePath, { model, gen, disabled: true, decorationIds: [] });
      return;
    }

    const headContent = await window.api.git.getHeadContent(state.repoRoot, state.relativePath);
    if (openGenerations.get(filePath) !== gen) return;

    if (headContent === null) {
      files.set(filePath, { model, gen, disabled: true, decorationIds: [] });
      return;
    }

    files.set(filePath, {
      model,
      gen,
      disabled: false,
      repoRoot: state.repoRoot,
      relativePath: state.relativePath,
      headContent,
      decorationIds: [],
      debounceTimer: null,
    });

    await recompute(filePath);
  }

  function onFileOpened(filePath, model) {
    const gen = bumpGeneration(filePath);
    enableForFile(filePath, model, gen);
  }

  function onActiveFileChanged(filePath) {
    activePath = filePath;
  }

  function onContentChanged(filePath) {
    const entry = files.get(filePath);
    if (!entry || entry.disabled) return;
    clearTimeout(entry.debounceTimer);
    entry.debounceTimer = setTimeout(() => {
      entry.debounceTimer = null;
      recompute(filePath);
    }, DEBOUNCE_MS);
  }

  function onFileSaved(filePath) {
    const entry = files.get(filePath);
    if (!entry || entry.disabled) return;
    clearTimeout(entry.debounceTimer);
    entry.debounceTimer = null;
    recompute(filePath);
  }

  function onFileClosed(filePath) {
    const entry = files.get(filePath);
    bumpGeneration(filePath); // invalidate any in-flight enable/recompute for this path
    if (!entry) return;
    clearTimeout(entry.debounceTimer);
    if (!entry.disabled) clearDecorations(entry);
    files.delete(filePath);
    if (activePath === filePath) activePath = null;
  }

  async function refreshFromDisk(filePath, entry) {
    const headContent = await window.api.git.getHeadContent(entry.repoRoot, entry.relativePath);
    if (files.get(filePath) !== entry) return; // closed mid-flight
    if (headContent === null) {
      entry.disabled = true;
      clearDecorations(entry);
      return;
    }
    entry.headContent = headContent;
    await recompute(filePath);
  }

  // Fired by main.js when `.git` changes for a repo an open file lives in
  // (commit, checkout, merge, pull) so external history changes -- not just
  // in-buffer edits -- refresh the gutter without waiting on the user to type.
  function onRepoChanged({ repoRoot }) {
    for (const [filePath, entry] of files) {
      if (entry.disabled || entry.repoRoot !== repoRoot) continue;
      refreshFromDisk(filePath, entry);
    }
  }

  window.addEventListener('focus', () => {
    if (!activePath) return;
    const entry = files.get(activePath);
    if (!entry || entry.disabled) return;
    refreshFromDisk(activePath, entry);
  });

  if (window.api?.git?.onRepoChanged) {
    window.api.git.onRepoChanged(onRepoChanged);
  }

  window.HatorGitDiff = {
    onFileOpened,
    onActiveFileChanged,
    onContentChanged,
    onFileSaved,
    onFileClosed,
  };
})();
