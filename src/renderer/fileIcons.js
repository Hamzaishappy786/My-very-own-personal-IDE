/* global window */
(function () {
  'use strict';

  // Compact colored-square icon for most languages
  function sq(text, bg, fg, rx) {
    const fs = text.length > 2 ? 7 : 9;
    const y  = text.length > 2 ? 11 : 12;
    return `<svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" width="14" height="14"><rect width="16" height="16" rx="${rx || 2}" fill="${bg}"/><text x="8" y="${y}" font-size="${fs}" font-family="'Segoe UI',system-ui,sans-serif" font-weight="700" fill="${fg || '#fff'}" text-anchor="middle">${text}</text></svg>`;
  }

  // Python — custom snake image from assets/snake.png
  const PY = `<img src="../../assets/snake.png" width="14" height="14" style="object-fit:contain;display:block;" draggable="false"/>`;

  // Folder — closed (darker yellow) and open (lighter)
  const FOLDER_CLOSED = `<svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" width="14" height="14">
    <path fill="#d4a944" d="M1.75 4A1.75 1.75 0 0 0 0 5.75v6.5C0 13.22.78 14 1.75 14h12.5A1.75 1.75 0 0 0 16 12.25v-5.5A1.75 1.75 0 0 0 14.25 5h-5.5a.25.25 0 0 1-.2-.1l-.9-1.2A1.75 1.75 0 0 0 6.25 3H1.75Z"/>
  </svg>`;

  const FOLDER_OPEN = `<svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" width="14" height="14">
    <path fill="#e8c07c" d="M1.75 4A1.75 1.75 0 0 0 0 5.75v6.5C0 13.22.78 14 1.75 14h12.5A1.75 1.75 0 0 0 16 12.25v-5.5A1.75 1.75 0 0 0 14.25 5h-5.5a.25.25 0 0 1-.2-.1l-.9-1.2A1.75 1.75 0 0 0 6.25 3H1.75Z"/>
    <path fill="rgba(0,0,0,0.2)" d="M0 9.5h16v2.75A1.75 1.75 0 0 1 14.25 14H1.75A1.75 1.75 0 0 1 0 12.25V9.5Z"/>
  </svg>`;

  // Generic file — document with folded corner
  const FILE = `<svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" width="14" height="14">
    <path fill="#6272a4" d="M4 2a2 2 0 0 1 2-2h4.586A1.5 1.5 0 0 1 11.9.44l2.16 2.16A1.5 1.5 0 0 1 14.56 4l-.01 10a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V2Z"/>
    <path fill="rgba(255,255,255,0.15)" d="M11 .5V3.5a.5.5 0 0 0 .5.5H14.5"/>
  </svg>`;

  const EXT_MAP = {
    // JavaScript family
    js:   sq('JS',  '#f7df1e', '#323330'),
    mjs:  sq('JS',  '#f7df1e', '#323330'),
    cjs:  sq('JS',  '#f7df1e', '#323330'),
    ts:   sq('TS',  '#3178c6'),
    tsx:  sq('TSX', '#3178c6'),
    jsx:  sq('JSX', '#61dafb', '#222'),
    // Python
    py: PY, pyw: PY,
    // Web
    html: sq('HTM', '#e34f26'),
    htm:  sq('HTM', '#e34f26'),
    css:  sq('CSS', '#1572b6'),
    scss: sq('SCSS','#c6538c'),
    sass: sq('SASS','#c6538c'),
    less: sq('LESS','#1d365d'),
    // Data / config
    json:  sq('{}',  '#f5a623'),
    jsonc: sq('{}',  '#f5a623'),
    yaml:  sq('YML', '#cb171e'),
    yml:   sq('YML', '#cb171e'),
    toml:  sq('TOM', '#9c4121'),
    xml:   sq('XML', '#f60'),
    svg:   sq('SVG', '#f60'),
    sql:   sq('SQL', '#00758f'),
    // Docs
    md:       sq('MD',  '#083fa1'),
    markdown: sq('MD',  '#083fa1'),
    // Systems languages
    c:    sq('C',   '#a8b9cc', '#222'),
    h:    sq('H',   '#a8b9cc', '#222'),
    cpp:  sq('C++', '#00599c'),
    cc:   sq('C++', '#00599c'),
    cs:   sq('C#',  '#178600'),
    go:   sq('Go',  '#00acd7'),
    rs:   sq('RS',  '#b94b00'),
    // Scripting
    rb:   sq('RB',  '#cc342d'),
    php:  sq('PHP', '#8892be'),
    sh:   sq('SH',  '#4eaa25'),
    bash: sq('SH',  '#4eaa25'),
    zsh:  sq('SH',  '#4eaa25'),
    fish: sq('SH',  '#4eaa25'),
    ps1:  sq('PS',  '#012456'),
    bat:  sq('BAT', '#3a7'),
    cmd:  sq('BAT', '#3a7'),
    // JVM / Mobile
    java:   sq('JAV', '#ed8b00'),
    kt:     sq('KT',  '#7f52ff'),
    swift:  sq('SW',  '#f05138'),
    dart:   sq('DT',  '#00b4ab'),
    // Frameworks
    vue:    sq('VUE', '#42b883'),
    svelte: sq('SV',  '#ff3e00'),
    // Lock / env
    env:  sq('ENV', '#ecd53f', '#333'),
    lock: sq('LCK', '#6272a4'),
    ini:  sq('INI', '#6272a4'),
    cfg:  sq('CFG', '#6272a4'),
  };

  function getIconSvg(name, isDir, isOpen) {
    if (isDir) return isOpen ? FOLDER_OPEN : FOLDER_CLOSED;

    const lower = name.toLowerCase();
    if (lower === '.gitignore' || lower === '.gitattributes') return sq('GIT', '#f14e32');
    if (lower === '.env' || lower.startsWith('.env.')) return EXT_MAP.env;

    const dot = lower.lastIndexOf('.');
    if (dot !== -1) {
      const ext = lower.slice(dot + 1);
      if (EXT_MAP[ext]) return EXT_MAP[ext];
    }
    return FILE;
  }

  window.HatorFileIcons = { getIconSvg };
})();
