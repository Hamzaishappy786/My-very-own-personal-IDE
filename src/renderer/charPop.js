/* global window, document, localStorage */

/**
 * Character Pop — when enabled, each typed character briefly floats upward
 * and fades out above the cursor in the Monaco editor. Purely cosmetic.
 * Toggle via Settings > Appearance > Character Pop.
 */
(function () {
  'use strict';

  const STORAGE_KEY = 'hator-char-pop';

  // Color by character category (Dracula palette)
  const COLOR = {
    letter:  '#bd93f9', // purple  — a-z A-Z _
    number:  '#50fa7b', // green   — 0-9
    string:  '#f1fa8c', // yellow  — ' " `
    bracket: '#8be9fd', // cyan    — ( ) [ ] { } < >
    symbol:  '#ff79c6', // pink    — everything else
    space:   '#6272a4', // comment — space (shown as ·)
  };

  function charColor(ch) {
    if (/[a-zA-Z_]/.test(ch))  return COLOR.letter;
    if (/[0-9]/.test(ch))       return COLOR.number;
    if (/['"`]/.test(ch))       return COLOR.string;
    if (/[()[\]{}<>]/.test(ch)) return COLOR.bracket;
    if (ch === ' ')             return COLOR.space;
    return COLOR.symbol;
  }

  let enabled = localStorage.getItem(STORAGE_KEY) !== 'false'; // on by default
  let editor  = null;
  let layer   = null;

  // ── Spawn one floating character ──────────────────────────────────────────

  function spawnPop(char, line, col) {
    if (!layer || !editor) return;

    const px = editor.getScrolledVisiblePosition({ lineNumber: line, column: col });
    if (!px) return;

    const glyph = char === ' ' ? '·' : char;
    const el    = document.createElement('span');
    el.textContent = glyph;

    Object.assign(el.style, {
      position:       'absolute',
      left:           `${px.left}px`,
      top:            `${px.top}px`,
      fontFamily:     'Consolas, "Courier New", monospace',
      fontSize:       '13px',
      fontWeight:     '600',
      color:          charColor(char),
      pointerEvents:  'none',
      userSelect:     'none',
      whiteSpace:     'pre',
      lineHeight:     '1',
      willChange:     'transform, opacity',
    });

    layer.appendChild(el);

    // Three-keyframe spring: pop up, slow down, fade
    el.animate(
      [
        { opacity: 1,   transform: 'translateY(0px)   scale(1)'   },
        { opacity: 0.9, transform: 'translateY(-20px)  scale(1.35)', offset: 0.35 },
        { opacity: 0,   transform: 'translateY(-44px)  scale(1.55)' },
      ],
      {
        duration: 580,
        easing:   'cubic-bezier(0.16, 1, 0.3, 1)', // snappy ease-out
        fill:     'forwards',
      }
    ).onfinish = () => el.remove();
  }

  // ── Editor setup (called from renderer.js after Monaco is ready) ──────────

  function setupEditor(ed) {
    editor = ed;

    const container = document.getElementById('editor-container');
    if (!container) return;
    container.style.position = 'relative';

    layer = document.createElement('div');
    layer.id = 'char-pop-layer';
    Object.assign(layer.style, {
      position:      'absolute',
      inset:         '0',
      pointerEvents: 'none',
      overflow:      'hidden',
      zIndex:        '50',
    });
    container.appendChild(layer);

    // Fire on every content change, but only for single printable characters
    editor.onDidChangeModelContent((e) => {
      if (!enabled) return;
      for (const change of e.changes) {
        const text = change.text;
        if (text.length !== 1 || text === '\n' || text === '\r' || text === '\t') continue;
        spawnPop(text, change.range.startLineNumber, change.range.startColumn);
      }
    });
  }

  // ── Settings toggle wiring ────────────────────────────────────────────────

  function syncToggle() {
    const tog  = document.getElementById('char-pop-toggle');
    const knob = tog?.querySelector('.toggle-knob');
    if (!tog) return;
    tog.classList.toggle('on', enabled);
    if (knob) knob.style.transform = enabled ? 'translateX(18px)' : 'translateX(4px)';
  }

  // Wire the toggle click (called once DOM is ready)
  const tog = document.getElementById('char-pop-toggle');
  if (tog) {
    syncToggle();
    tog.addEventListener('click', () => {
      enabled = !enabled;
      localStorage.setItem(STORAGE_KEY, String(enabled));
      syncToggle();
    });
  }

  window.HatorCharPop = { setupEditor };
})();
