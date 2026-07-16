/* global Terminal, FitAddon, window, document */

(function () {
  const panelEl = document.getElementById('terminal-panel');
  const resizerEl = document.getElementById('terminal-resizer');
  const mountEl = document.getElementById('terminal-mount');
  const shellSelect = document.getElementById('terminal-shell-select');
  const closeBtn = document.getElementById('terminal-close-btn');
  const toggleBtn = document.getElementById('terminal-toggle-btn');

  const MIN_HEIGHT = 120;
  const MAX_HEIGHT_RATIO = 0.7;
  const DEFAULT_HEIGHT = 260;

  let term = null;
  let fitAddon = null;
  let ptyId = null;
  let currentShellId = null;
  let disposeDataListener = null;
  let disposeExitListener = null;
  let isVisible = false;
  let creating = null;
  let pendingRun = null; // { buffer: string, resolve: (result) => void }

  // Interpreter used for each runnable extension, per shell family. Windows
  // shells (powershell/cmd) get the `python` launcher; posix shells get
  // `python3`, matching each platform's usual convention.
  const RUN_INTERPRETERS = {
    py: { win: 'python', posix: 'python3' },
    js: { win: 'node', posix: 'node' },
    sh: { win: 'bash', posix: 'bash' },
    rb: { win: 'ruby', posix: 'ruby' },
    php: { win: 'php', posix: 'php' },
    go: { win: 'go run', posix: 'go run' },
  };
  const EXIT_SENTINEL = 'HATOR_EXIT_CODE:';

  function extOf(filePath) {
    const base = filePath.split(/[\\/]/).pop();
    const dot = base.lastIndexOf('.');
    return dot === -1 ? '' : base.slice(dot + 1).toLowerCase();
  }

  function isRunnable(filePath) {
    return !!filePath && Object.prototype.hasOwnProperty.call(RUN_INTERPRETERS, extOf(filePath));
  }

  /**
   * Splits a full file path into its directory and filename, using
   * whichever separator the path actually uses (paths from Electron's
   * dialogs/fs APIs are OS-native, so a Windows path never mixes `/`).
   */
  function splitPath(filePath) {
    const sep = filePath.includes('\\') ? '\\' : '/';
    const parts = filePath.split(/[\\/]/);
    const fileName = parts.pop();
    const dirPath = parts.join(sep) || sep;
    return { dirPath, fileName, sep };
  }

  function buildRunCommands(filePath, shellId) {
    const { dirPath, fileName } = splitPath(filePath);
    const ext = extOf(filePath);
    const interpreterSet = RUN_INTERPRETERS[ext];
    if (!interpreterSet) return null;

    const isWin = shellId === 'powershell' || shellId === 'cmd';
    const interpreter = isWin ? interpreterSet.win : interpreterSet.posix;
    const runCmd = `${interpreter} "${fileName}"`;

    // Every branch below is written so no digit ever sits directly after
    // EXIT_SENTINEL in the command's own *source* text. The shell echoes
    // back exactly what was typed before it runs, so a literal like
    // `"HATOR_EXIT_CODE:0"` in the source would falsely match the very
    // instant it's echoed -- long before the real result exists. Keeping
    // only a variable reference (`$code`, `%errorlevel%`, `$?`) right after
    // the prefix means the pattern can only match once the shell actually
    // substitutes a real exit code into its printed output.
    let cdCmd;
    let sentinelCmd;
    if (shellId === 'cmd') {
      cdCmd = `cd /d "${dirPath}"`;
      sentinelCmd = `echo ${EXIT_SENTINEL}%errorlevel%`;
    } else if (shellId === 'powershell') {
      cdCmd = `cd "${dirPath}"`;
      sentinelCmd = `$__hatorCode = if ($?) { 0 } else { if ($LASTEXITCODE) { $LASTEXITCODE } else { 1 } }; Write-Output "${EXIT_SENTINEL}$__hatorCode"`;
    } else {
      cdCmd = `cd "${dirPath}"`;
      sentinelCmd = `echo "${EXIT_SENTINEL}$?"`;
    }

    return { cdCmd, runCmd, sentinelCmd };
  }

  function feedRunCapture(data) {
    if (!pendingRun) return;
    pendingRun.buffer += data;
    const idx = pendingRun.buffer.indexOf(EXIT_SENTINEL);
    if (idx === -1) return;
    const match = pendingRun.buffer.slice(idx).match(/HATOR_EXIT_CODE:(-?\d+)/);
    if (!match) return;

    const exitCode = Number(match[1]);
    const outputText = pendingRun.buffer.slice(0, idx);
    const resolve = pendingRun.resolve;
    pendingRun = null;
    resolve({ exitCode, outputText });
  }

  function cancelPendingRun() {
    if (!pendingRun) return;
    const resolve = pendingRun.resolve;
    pendingRun = null;
    resolve({ exitCode: null, outputText: '', interrupted: true });
  }

  /**
   * Runs a file the same way a person would at the prompt: `cd` into its
   * directory, then invoke the interpreter on just the filename. A third,
   * shell-appropriate line echoes a sentinel carrying the real exit code
   * (or PowerShell's `$?` when a command isn't found at all) so the caller
   * can tell success from failure without re-running the code separately.
   */
  function runFile(filePath) {
    if (!ptyId) return Promise.resolve({ exitCode: null, outputText: '', unsupported: true });
    const commands = buildRunCommands(filePath, currentShellId);
    if (!commands) return Promise.resolve({ exitCode: null, outputText: '', unsupported: true });

    cancelPendingRun();
    return new Promise((resolve) => {
      pendingRun = { buffer: '', resolve };
      window.api.terminal.input(ptyId, `${commands.cdCmd}\r`);
      window.api.terminal.input(ptyId, `${commands.runCmd}\r`);
      window.api.terminal.input(ptyId, `${commands.sentinelCmd}\r`);
    });
  }

  function interrupt() {
    if (ptyId) window.api.terminal.input(ptyId, '\x03');
    cancelPendingRun();
  }

  function currentXtermTheme() {
    const themeId = localStorage.getItem('hator-theme') || 'vs-dark';
    return (window.HatorThemes.XTERM_THEMES && window.HatorThemes.XTERM_THEMES[themeId]) || window.HatorThemes.XTERM_THEMES['vs-dark'];
  }

  function applyTheme(themeId) {
    if (!term) return;
    term.options.theme = (window.HatorThemes.XTERM_THEMES && window.HatorThemes.XTERM_THEMES[themeId]) || window.HatorThemes.XTERM_THEMES['vs-dark'];
  }

  async function spawnShell(shellId) {
    cancelPendingRun();

    if (ptyId) {
      window.api.terminal.dispose(ptyId);
      if (disposeDataListener) disposeDataListener();
      if (disposeExitListener) disposeExitListener();
      ptyId = null;
    }

    term.reset();
    const dims = fitAddon.proposeDimensions() || { cols: 80, rows: 24 };
    const result = await window.api.terminal.create({ shellId, cols: dims.cols, rows: dims.rows });
    ptyId = result.id;
    currentShellId = result.shellId;
    shellSelect.value = result.shellId;

    disposeDataListener = window.api.terminal.onData(({ id, data }) => {
      if (id === ptyId) {
        term.write(data);
        feedRunCapture(data);
      }
    });
    disposeExitListener = window.api.terminal.onExit(({ id }) => {
      if (id === ptyId) {
        term.write('\r\n\x1b[90m[process exited]\x1b[0m\r\n');
      }
    });
  }

  // ── "fun" easter egg ─────────────────────────────────────────────────────

  function launchConfetti() {
    const canvas = document.createElement('canvas');
    canvas.width  = window.innerWidth;
    canvas.height = window.innerHeight;
    Object.assign(canvas.style, {
      position:      'fixed',
      inset:         '0',
      pointerEvents: 'none',
      zIndex:        '9999',
    });
    document.body.appendChild(canvas);
    const ctx = canvas.getContext('2d');

    const COLORS = ['#ff79c6','#bd93f9','#8be9fd','#50fa7b','#f1fa8c','#ffb86c','#ff5555'];
    const pieces = Array.from({ length: 140 }, (_, i) => ({
      x:     Math.random() * canvas.width,
      y:     -10 - Math.random() * 300,
      vx:    (Math.random() - 0.5) * 9,
      vy:    Math.random() * 3 + 1,
      w:     7 + Math.random() * 7,
      h:     3 + Math.random() * 5,
      rot:   Math.random() * Math.PI * 2,
      rotV:  (Math.random() - 0.5) * 0.25,
      color: COLORS[i % COLORS.length],
    }));

    const start = performance.now();
    const DURATION = 4000;

    (function frame(now) {
      const t = (now - start) / DURATION;
      ctx.clearRect(0, 0, canvas.width, canvas.height);

      let alive = false;
      for (const p of pieces) {
        p.x   += p.vx;
        p.y   += p.vy;
        p.vy  += 0.18;   // gravity
        p.vx  *= 0.992;  // air drag
        p.rot += p.rotV;

        const alpha = t < 0.6 ? 1 : Math.max(0, 1 - (t - 0.6) / 0.4);
        if (p.y < canvas.height + 30) alive = true;

        ctx.save();
        ctx.globalAlpha = alpha;
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot);
        ctx.fillStyle = p.color;
        ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
        ctx.restore();
      }

      if (alive && t < 1) requestAnimationFrame(frame);
      else canvas.remove();
    })(start);
  }

  function triggerFunMode() {
    if (term) {
      term.write('\r\n');
      term.write('\x1b[35m  ✨  \x1b[0m');
      term.write('\x1b[1;36m F U N   M O D E   A C T I V A T E D \x1b[0m');
      term.write('\x1b[35m  ✨\x1b[0m\r\n');
    }
    launchConfetti();
  }

  // Buffer to detect "fun\r" typed at the terminal prompt
  let _funBuf = '';

  // Returns true if data should be forwarded to the pty, false to swallow it.
  function _trackFun(data) {
    if (data === '\x7f' || data === '\b') {
      _funBuf = _funBuf.slice(0, -1);
    } else if (data === '\r' || data === '\n') {
      if (_funBuf.trimEnd() === 'fun') {
        _funBuf = '';
        // Clear the "fun" already sitting on the prompt without running it.
        // CMD uses Escape to wipe the current line; PowerShell and posix
        // shells respond to Ctrl+U (\x15).
        if (ptyId) {
          const clearSeq = currentShellId === 'cmd' ? '\x1b' : '\x15';
          window.api.terminal.input(ptyId, clearSeq);
        }
        triggerFunMode();
        return false; // swallow the Enter — shell never sees it
      }
      _funBuf = '';
    } else if (data.length === 1 && data >= ' ') {
      _funBuf = (_funBuf + data).slice(-10);
    } else {
      _funBuf = ''; // reset on escape sequences / arrows
    }
    return true;
  }

  // ── Terminal creation ─────────────────────────────────────────────────────

  async function ensureTerminalCreated() {
    if (term) return;
    if (creating) return creating;

    creating = (async () => {
      term = new Terminal({
        fontSize: 13,
        fontFamily: 'Consolas, "Courier New", monospace',
        cursorBlink: true,
        scrollback: 5000,
        copyOnSelect: true,
        theme: currentXtermTheme(),
      });
      fitAddon = new FitAddon.FitAddon();
      term.loadAddon(fitAddon);
      term.open(mountEl);

      const presets = await window.api.terminal.getShellPresets();
      shellSelect.innerHTML = '';
      presets.forEach(({ id, label }) => {
        const opt = document.createElement('option');
        opt.value = id;
        opt.textContent = label;
        shellSelect.appendChild(opt);
      });

      await spawnShell(presets[0]?.id);

      // Ctrl+Shift+C → copy selection; Ctrl+Shift+V → paste.
      // Returning false tells xterm to swallow the event (don't send to pty).
      term.attachCustomKeyEventHandler((e) => {
        if (e.ctrlKey && e.shiftKey && e.code === 'KeyC' && e.type === 'keydown') {
          const sel = term.getSelection();
          if (sel) navigator.clipboard.writeText(sel).catch(() => {});
          return false;
        }
        if (e.ctrlKey && e.shiftKey && e.code === 'KeyV' && e.type === 'keydown') {
          navigator.clipboard.readText().then((text) => {
            if (ptyId && text) window.api.terminal.input(ptyId, text);
          }).catch(() => {});
          return false;
        }
        return true;
      });

      term.onData((data) => {
        if (_trackFun(data) && ptyId) window.api.terminal.input(ptyId, data);
      });

      term.onResize(({ cols, rows }) => {
        if (ptyId) window.api.terminal.resize(ptyId, cols, rows);
      });

      shellSelect.addEventListener('change', () => {
        spawnShell(shellSelect.value);
      });
    })();

    return creating;
  }

  function fit() {
    if (!term || !fitAddon || !isVisible) return;
    try {
      fitAddon.fit();
    } catch {
      // The panel may be mid-transition (zero height); skip this frame.
    }
  }

  async function showPanel() {
    panelEl.classList.add('visible');
    resizerEl.classList.add('visible');
    isVisible = true;
    toggleBtn?.classList.add('text-dracula-purple');
    await ensureTerminalCreated();
    requestAnimationFrame(() => {
      fit();
      term.focus();
    });
  }

  function hidePanel() {
    panelEl.classList.remove('visible');
    resizerEl.classList.remove('visible');
    isVisible = false;
    toggleBtn?.classList.remove('text-dracula-purple');
  }

  function togglePanel() {
    if (isVisible) hidePanel();
    else showPanel();
  }

  // --- Drag-to-resize -------------------------------------------------------
  let dragging = false;
  let dragStartY = 0;
  let dragStartHeight = 0;

  resizerEl.addEventListener('mousedown', (e) => {
    dragging = true;
    dragStartY = e.clientY;
    dragStartHeight = panelEl.getBoundingClientRect().height;
    document.body.style.cursor = 'row-resize';
    e.preventDefault();
  });

  window.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const delta = dragStartY - e.clientY;
    const maxHeight = window.innerHeight * MAX_HEIGHT_RATIO;
    const newHeight = Math.min(maxHeight, Math.max(MIN_HEIGHT, dragStartHeight + delta));
    panelEl.style.height = `${newHeight}px`;
    fit();
  });

  window.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    document.body.style.cursor = '';
  });

  window.addEventListener('resize', () => fit());

  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.key === '`') {
      e.preventDefault();
      togglePanel();
    }
  });

  closeBtn.addEventListener('click', hidePanel);
  toggleBtn?.addEventListener('click', togglePanel);

  panelEl.style.height = `${DEFAULT_HEIGHT}px`;

  function writeOutput(text) {
    if (term) term.write(text);
  }

  window.HatorTerminalPanel = {
    toggle: togglePanel,
    show: showPanel,
    hide: hidePanel,
    setTheme: applyTheme,
    writeOutput,
    isRunnable,
    runFile,
    interrupt,
  };
})();
