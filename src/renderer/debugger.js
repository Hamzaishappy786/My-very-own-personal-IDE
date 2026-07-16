/* global window, document, monaco */

/**
 * Node.js debugger UI — breakpoint gutter, debug panel, step controls.
 * Only handles .js/.mjs/.cjs files via Node's built-in V8/CDP inspector.
 * Call window.HatorDebugger.setupEditor(ed) from inside the Monaco
 * require() callback so monaco globals are available before we touch the API.
 */
(function () {
  'use strict';

  // --- DOM refs ---
  const debugBtn         = document.getElementById('debug-btn');
  const debugPanel       = document.getElementById('debug-panel');
  const debugResizer     = document.getElementById('debug-resizer');
  const debugCallStack   = document.getElementById('debug-call-stack');
  const debugVariables   = document.getElementById('debug-variables');
  const debugContinueBtn = document.getElementById('debug-continue-btn');
  const debugStepOverBtn = document.getElementById('debug-step-over-btn');
  const debugStepInBtn   = document.getElementById('debug-step-in-btn');
  const debugStepOutBtn  = document.getElementById('debug-step-out-btn');
  const debugStopBtn     = document.getElementById('debug-stop-btn');

  // --- State ---
  const bpLines  = new Map(); // filePath → Set<number> (1-based lines)
  const bpDecIds = new Map(); // filePath → string[]  (Monaco decoration IDs on model)
  let curLineDec     = [];    // current-line decoration IDs
  let curLineFile    = null;  // which file holds the current-line decoration
  let activeFilePath = null;
  let debugActive    = false;
  let isPaused       = false;
  let editorRef      = null;

  const DEBUGGABLE_EXTS = new Set(['js', 'mjs', 'cjs']);
  const DEBUG_HEIGHT_DEFAULT = 200;

  function isDebuggable(fp) {
    if (!fp) return false;
    const ext = fp.split('.').pop().toLowerCase();
    return DEBUGGABLE_EXTS.has(ext);
  }

  // Editor and model access — populated by setupEditor()
  function ed()       { return editorRef; }
  function getModel(fp) { return window.__hatorGetModel?.(fp); }

  // ─── Bootstrap ────────────────────────────────────────────────────────────

  function setupEditor(editor) {
    editorRef = editor;

    // Glyph-margin click → toggle breakpoint
    editor.onMouseDown((e) => {
      if (e.target.type !== monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN) return;
      const line = e.target.position?.lineNumber;
      if (line && activeFilePath) toggleBreakpoint(activeFilePath, line);
    });
  }

  // ─── Breakpoints ──────────────────────────────────────────────────────────

  function toggleBreakpoint(filePath, lineNumber) {
    if (!bpLines.has(filePath)) bpLines.set(filePath, new Set());
    const lines = bpLines.get(filePath);
    if (lines.has(lineNumber)) {
      lines.delete(lineNumber);
      if (debugActive) window.api.debug.removeBreakpoint(filePath, lineNumber).catch(() => {});
    } else {
      lines.add(lineNumber);
      if (debugActive) window.api.debug.setBreakpoint(filePath, lineNumber).catch(() => {});
    }
    refreshBpDecorations(filePath);
  }

  function refreshBpDecorations(filePath) {
    const model = getModel(filePath);
    if (!model) return;
    const lines = bpLines.get(filePath) || new Set();
    const newDecs = Array.from(lines).map((line) => ({
      range: new monaco.Range(line, 1, line, 1),
      options: {
        glyphMarginClassName: 'hator-bp-glyph',
        stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
      },
    }));
    const ids = model.deltaDecorations(bpDecIds.get(filePath) || [], newDecs);
    bpDecIds.set(filePath, ids);
  }

  // ─── Current-line highlight ────────────────────────────────────────────────

  function highlightLine(filePath, lineNumber) {
    clearHighlight();
    const model = getModel(filePath);
    if (!model) return;
    curLineFile = filePath;
    curLineDec = model.deltaDecorations([], [{
      range: new monaco.Range(lineNumber, 1, lineNumber, 1),
      options: {
        className:          'hator-debug-current-line',
        glyphMarginClassName: 'hator-debug-arrow',
        isWholeLine: true,
        stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
      },
    }]);
    // If this file is active, scroll to it
    if (ed() && ed().getModel() === model) {
      ed().revealLineInCenterIfOutsideViewport(lineNumber, monaco.editor.ScrollType.Smooth);
    }
  }

  function clearHighlight() {
    if (!curLineFile || !curLineDec.length) return;
    const model = getModel(curLineFile);
    if (model) model.deltaDecorations(curLineDec, []);
    curLineDec = [];
    curLineFile = null;
  }

  // ─── Session lifecycle ─────────────────────────────────────────────────────

  async function startDebug() {
    if (debugActive) { stopDebug(); return; }
    if (!isDebuggable(activeFilePath)) return;

    debugActive = true;
    isPaused = false;
    updateBtnState();

    const bpsForFile = Array.from(bpLines.get(activeFilePath) || []);
    window.HatorTerminalPanel?.show(); // show terminal so output is visible

    const result = await window.api.debug.start(activeFilePath, bpsForFile);
    if (!result.ok) {
      debugActive = false;
      updateBtnState();
      window.HatorTerminalPanel?.writeOutput(
        `\r\n\x1b[31m[Debug] Could not start: ${result.error}\x1b[0m\r\n`
      );
      return;
    }
    showDebugPanel();
  }

  async function stopDebug() {
    await window.api.debug.stop();
    onStopped();
  }

  function onStopped() {
    debugActive = false;
    isPaused = false;
    clearHighlight();
    hideDebugPanel();
    updateBtnState();
    updateStepBtns();
  }

  // ─── Debug panel ──────────────────────────────────────────────────────────

  function showDebugPanel() {
    if (!debugPanel || !debugResizer) return;
    debugPanel.style.height = `${DEBUG_HEIGHT_DEFAULT}px`;
    debugPanel.classList.add('visible');
    debugResizer.classList.add('visible');
  }

  function hideDebugPanel() {
    debugPanel?.classList.remove('visible');
    debugResizer?.classList.remove('visible');
    if (debugCallStack) debugCallStack.innerHTML = '';
    if (debugVariables) debugVariables.innerHTML = '';
  }

  // ─── IPC event handlers ───────────────────────────────────────────────────

  window.api.debug.onPaused(({ callFrames, variables }) => {
    isPaused = true;
    updateStepBtns();

    const top = callFrames[0];
    if (top) highlightLine(top.filePath, top.line);

    if (debugCallStack) {
      debugCallStack.innerHTML = '';
      callFrames.forEach((frame, i) => {
        const el = document.createElement('div');
        el.className = 'debug-frame' + (i === 0 ? ' active' : '');
        const file = frame.filePath.split(/[\\/]/).pop();
        el.textContent = `${frame.name}  (${file}:${frame.line})`;
        debugCallStack.appendChild(el);
      });
    }

    if (debugVariables) {
      debugVariables.innerHTML = '';
      variables.forEach(({ name, value, type }) => {
        const row = document.createElement('div');
        row.className = 'debug-var-row';
        row.innerHTML =
          `<span class="debug-var-name">${esc(name)}</span>` +
          `<span class="debug-var-sep"> = </span>` +
          `<span class="debug-var-value debug-var-type-${type}">${esc(value)}</span>`;
        debugVariables.appendChild(row);
      });
    }
  });

  window.api.debug.onResumed(() => {
    isPaused = false;
    clearHighlight();
    updateStepBtns();
    if (debugCallStack) debugCallStack.innerHTML = '';
    if (debugVariables) debugVariables.innerHTML = '';
  });

  window.api.debug.onOutput(({ text, category }) => {
    const color = category === 'stderr' ? '\x1b[33m' : '\x1b[0m';
    window.HatorTerminalPanel?.writeOutput(`${color}${text}\x1b[0m`);
  });

  window.api.debug.onStopped(() => onStopped());

  // ─── Button state ─────────────────────────────────────────────────────────

  function updateBtnState() {
    if (!debugBtn) return;
    const canDebug = isDebuggable(activeFilePath);
    debugBtn.disabled = !canDebug && !debugActive;

    document.getElementById('debug-icon-play')?.classList.toggle('hidden',  debugActive);
    document.getElementById('debug-icon-stop')?.classList.toggle('hidden', !debugActive);

    debugBtn.title = debugActive
      ? 'Stop debugging (Shift+F5)'
      : canDebug
        ? `Debug ${activeFilePath?.split(/[\\/]/).pop()}`
        : 'Open a .js file to enable Debug';
  }

  function updateStepBtns() {
    [debugContinueBtn, debugStepOverBtn, debugStepInBtn, debugStepOutBtn].forEach((btn) => {
      if (btn) btn.disabled = !isPaused;
    });
  }

  // ─── Public hook (called by renderer.js) ──────────────────────────────────

  function onActiveFileChanged(filePath) {
    activeFilePath = filePath;
    updateBtnState();
    if (filePath) refreshBpDecorations(filePath);
  }

  // ─── Debug controls ───────────────────────────────────────────────────────

  debugBtn?.addEventListener('click', startDebug);
  debugStopBtn?.addEventListener('click', stopDebug);
  debugContinueBtn?.addEventListener('click', () => window.api.debug.resume());
  debugStepOverBtn?.addEventListener('click', () => window.api.debug.stepOver());
  debugStepInBtn?.addEventListener('click',   () => window.api.debug.stepInto());
  debugStepOutBtn?.addEventListener('click',  () => window.api.debug.stepOut());

  // ─── Keyboard shortcuts ───────────────────────────────────────────────────

  document.addEventListener('keydown', (e) => {
    if (e.key === 'F5' && e.shiftKey) {
      e.preventDefault();
      if (debugActive) stopDebug();
    } else if (e.key === 'F5' && !e.shiftKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      if (debugActive && isPaused) window.api.debug.resume();
      else if (!debugActive) startDebug();
    } else if (e.key === 'F10' && debugActive && isPaused) {
      e.preventDefault();
      window.api.debug.stepOver();
    } else if (e.key === 'F11' && e.shiftKey && debugActive && isPaused) {
      e.preventDefault();
      window.api.debug.stepOut();
    } else if (e.key === 'F11' && !e.shiftKey && debugActive && isPaused) {
      e.preventDefault();
      window.api.debug.stepInto();
    }
  });

  // ─── Debug panel resize ───────────────────────────────────────────────────

  let dbgDrag = false, dbgStartY = 0, dbgStartH = 0;

  debugResizer?.addEventListener('mousedown', (e) => {
    dbgDrag = true;
    dbgStartY = e.clientY;
    dbgStartH = debugPanel.getBoundingClientRect().height;
    document.body.style.cursor = 'row-resize';
    e.preventDefault();
  });

  window.addEventListener('mousemove', (e) => {
    if (!dbgDrag) return;
    const delta  = dbgStartY - e.clientY;
    const maxH   = window.innerHeight * 0.5;
    const newH   = Math.min(maxH, Math.max(100, dbgStartH + delta));
    if (debugPanel) debugPanel.style.height = `${newH}px`;
  });

  window.addEventListener('mouseup', () => {
    if (dbgDrag) { dbgDrag = false; document.body.style.cursor = ''; }
  });

  // ─── Helpers ──────────────────────────────────────────────────────────────

  function esc(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  // ─── Expose ───────────────────────────────────────────────────────────────

  window.HatorDebugger = { setupEditor, onActiveFileChanged };
})();
