/* global require, monaco */

require.config({
  paths: { vs: '../../node_modules/monaco-editor/min/vs' },
});

const fileTreeEl = document.getElementById('file-tree');
const folderNameEl = document.getElementById('folder-name');
const openFolderBtn = document.getElementById('open-folder-btn');
const tabsEl = document.getElementById('tabs');
const editorContainer = document.getElementById('editor-container');
const sidebarEl = document.getElementById('sidebar');
const sidebarToggleBtn = document.getElementById('sidebar-toggle-btn');
const sidebarToggleIcon = sidebarToggleBtn.querySelector('svg');
const settingsBtn = document.getElementById('settings-btn');
const settingsModal = document.getElementById('settings-modal');
const settingsCloseBtn = document.getElementById('settings-close-btn');
const settingsSearchInput = document.getElementById('settings-search');
const settingsBody = document.getElementById('settings-body');
const settingsEmptyEl = document.getElementById('settings-empty');
const themeMenuList = document.getElementById('theme-menu-list');
const statusLeftEl = document.getElementById('status-left');
const saveToastEl = document.getElementById('save-toast');

const AUTO_SAVE_DELAY_MS = 2000;
const THEME_STORAGE_KEY = 'hator-theme';
const TAB_ANIM_MS = 150;

const LANGUAGE_BY_EXT = {
  js: 'javascript',
  jsx: 'javascript',
  ts: 'typescript',
  tsx: 'typescript',
  json: 'json',
  html: 'html',
  css: 'css',
  scss: 'scss',
  md: 'markdown',
  py: 'python',
  java: 'java',
  c: 'c',
  cpp: 'cpp',
  h: 'cpp',
  cs: 'csharp',
  go: 'go',
  rs: 'rust',
  php: 'php',
  rb: 'ruby',
  sh: 'shell',
  yml: 'yaml',
  yaml: 'yaml',
  xml: 'xml',
  sql: 'sql',
};

function languageForFile(filePath) {
  const ext = filePath.split('.').pop().toLowerCase();
  return LANGUAGE_BY_EXT[ext] || 'plaintext';
}

// open files keyed by path: { model, viewState, dirty }
const openFiles = new Map();
let activeFilePath = null;
let editor = null;
let autoSaveTimer = null;
let lastOpenedPath = null;

require(['vs/editor/editor.main'], () => {
  window.HatorThemes.defineCustomThemes(monaco);

  const savedTheme = localStorage.getItem(THEME_STORAGE_KEY) || 'vs-dark';

  editor = monaco.editor.create(editorContainer, {
    theme: savedTheme,
    automaticLayout: true,
    fontSize: 13,
    minimap: { enabled: true },
    glyphMargin: true,
    value: '',
  });

  // Expose for debugger.js (which loads before this require() callback runs)
  window.__hatorEditor = editor;
  window.__hatorGetModel = (fp) => openFiles.get(fp)?.model;
  window.HatorDebugger?.setupEditor(editor);
  window.HatorCharPop?.setupEditor(editor);

  editor.onDidChangeModelContent(() => {
    if (!activeFilePath) return;
    const entry = openFiles.get(activeFilePath);
    if (entry && !entry.dirty) {
      entry.dirty = true;
      renderTabs();
    }
    scheduleAutoSave(activeFilePath);
    window.HatorGitDiff?.onContentChanged(activeFilePath);
  });

  editor.onDidChangeCursorPosition((e) => {
    statusLeftEl.textContent = `Ln ${e.position.lineNumber}, Col ${e.position.column}`;
  });

  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
    saveActiveFile();
  });

  setupThemeMenu(savedTheme);
  setupSettingsModal();
});

// Extra searchable keywords per theme, beyond the theme's own label, so a
// search for e.g. "code" or "purple" still surfaces the right theme.
const THEME_SEARCH_ALIASES = {
  'vs-dark': 'dark vs code default',
  vs: 'light bright default',
  dracula: 'purple pink dark',
  'one-dark-pro': 'atom dark',
};

function setupThemeMenu(savedTheme) {
  let currentTheme = savedTheme;

  function renderThemeMenu() {
    themeMenuList.innerHTML = '';
    window.HatorThemes.HATOR_THEMES.forEach(({ id, label }) => {
      const item = document.createElement('div');
      item.className = 'theme-menu-item settings-item' + (id === currentTheme ? ' active' : '');
      item.dataset.keywords = `theme color scheme appearance ${label} ${THEME_SEARCH_ALIASES[id] || ''}`.toLowerCase();

      const text = document.createElement('span');
      text.textContent = label;
      item.appendChild(text);

      if (id === currentTheme) {
        const check = document.createElement('span');
        check.innerHTML =
          '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" class="w-3.5 h-3.5"><path d="M13.78 4.22a.75.75 0 0 1 0 1.06l-7.25 7.25a.75.75 0 0 1-1.06 0L2.22 9.28a.75.75 0 0 1 1.06-1.06L6 10.94l6.72-6.72a.75.75 0 0 1 1.06 0Z"/></svg>';
        item.appendChild(check);
      }

      item.addEventListener('click', () => {
        currentTheme = id;
        monaco.editor.setTheme(id);
        localStorage.setItem(THEME_STORAGE_KEY, id);
        renderThemeMenu();
        window.HatorTerminalPanel?.setTheme(id);
      });

      themeMenuList.appendChild(item);
    });
  }

  renderThemeMenu();
}

function setupSettingsModal() {
  function openSettingsModal() {
    settingsModal.classList.add('open');
    settingsSearchInput.value = '';
    filterSettings('');
    requestAnimationFrame(() => settingsSearchInput.focus());
  }

  function closeSettingsModal() {
    settingsModal.classList.remove('open');
  }

  function filterSettings(query) {
    const q = query.trim().toLowerCase();
    let anyVisible = false;

    settingsBody.querySelectorAll('.settings-item').forEach((item) => {
      const visible = !q || (item.dataset.keywords || '').includes(q);
      item.classList.toggle('hidden', !visible);
      if (visible) anyVisible = true;
    });

    settingsBody.querySelectorAll('.settings-section').forEach((section) => {
      const hasVisible = !!section.querySelector('.settings-item:not(.hidden)');
      section.classList.toggle('hidden', !hasVisible);
    });

    settingsEmptyEl.classList.toggle('hidden', anyVisible);
  }

  settingsBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    openSettingsModal();
  });

  settingsCloseBtn.addEventListener('click', closeSettingsModal);

  settingsModal.addEventListener('click', (e) => {
    if (e.target === settingsModal) closeSettingsModal();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && settingsModal.classList.contains('open')) {
      closeSettingsModal();
    }
  });

  settingsSearchInput.addEventListener('input', () => filterSettings(settingsSearchInput.value));
}

function showSavedToast() {
  saveToastEl.classList.remove('opacity-0', 'translate-y-0.5');
  saveToastEl.classList.add('opacity-100', 'translate-y-0');
  clearTimeout(showSavedToast._timer);
  showSavedToast._timer = setTimeout(() => {
    saveToastEl.classList.remove('opacity-100', 'translate-y-0');
    saveToastEl.classList.add('opacity-0', 'translate-y-0.5');
  }, 1400);
}

function scheduleAutoSave(filePath) {
  if (autoSaveTimer) clearTimeout(autoSaveTimer);
  autoSaveTimer = setTimeout(() => {
    autoSaveTimer = null;
    saveFile(filePath);
  }, AUTO_SAVE_DELAY_MS);
}

async function saveFile(filePath) {
  const entry = openFiles.get(filePath);
  if (!entry || !entry.dirty) return;
  await window.api.writeFile(filePath, entry.model.getValue());
  entry.dirty = false;
  renderTabs();
  showSavedToast();
  window.HatorGitDiff?.onFileSaved(filePath);
}

async function saveActiveFile() {
  if (!activeFilePath) return;
  if (autoSaveTimer) {
    clearTimeout(autoSaveTimer);
    autoSaveTimer = null;
  }
  await saveFile(activeFilePath);
}

function renderTabs() {
  tabsEl.innerHTML = '';
  for (const [filePath, entry] of openFiles) {
    const tab = document.createElement('div');
    tab.className = 'tab' + (filePath === activeFilePath ? ' active' : '') + (entry.dirty ? ' dirty' : '');

    const label = document.createElement('span');
    label.textContent = filePath.split(/[\\/]/).pop();
    tab.appendChild(label);

    if (entry.dirty) {
      const dot = document.createElement('span');
      dot.className = 'dirty-dot';
      dot.textContent = '●';
      tab.appendChild(dot);
    }

    const closeBtn = document.createElement('span');
    closeBtn.className = 'close-btn';
    closeBtn.textContent = '✕';
    closeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      animateTabExit(tab, () => closeFile(filePath));
    });
    tab.appendChild(closeBtn);

    tab.addEventListener('click', () => activateFile(filePath));
    tabsEl.appendChild(tab);

    if (filePath === lastOpenedPath) {
      tab.classList.add('tab-enter');
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          tab.classList.remove('tab-enter');
        });
      });
      lastOpenedPath = null;
    }
  }
}

function animateTabExit(tabEl, onDone) {
  tabEl.classList.add('tab-exit');
  tabEl.style.pointerEvents = 'none';
  setTimeout(onDone, TAB_ANIM_MS);
}

function closeFile(filePath) {
  const entry = openFiles.get(filePath);
  if (!entry) return;
  window.HatorGitDiff?.onFileClosed(filePath);
  entry.model.dispose();
  openFiles.delete(filePath);

  if (activeFilePath === filePath) {
    const remaining = Array.from(openFiles.keys());
    activeFilePath = remaining.length ? remaining[remaining.length - 1] : null;
    if (activeFilePath) {
      activateFile(activeFilePath);
    } else if (editor) {
      editor.setModel(null);
      window.HatorRunner?.onActiveFileChanged(null);
      window.HatorDebugger?.onActiveFileChanged(null);
    }
  }
  renderTabs();
}

function activateFile(filePath) {
  const entry = openFiles.get(filePath);
  if (!entry || !editor) return;
  if (activeFilePath) {
    const prev = openFiles.get(activeFilePath);
    if (prev) prev.viewState = editor.saveViewState();
  }
  activeFilePath = filePath;
  editor.setModel(entry.model);
  if (entry.viewState) editor.restoreViewState(entry.viewState);
  editor.focus();
  renderTabs();
  highlightSelectedNode(filePath);
  window.HatorGitDiff?.onActiveFileChanged(filePath);
  window.HatorRunner?.onActiveFileChanged(filePath);
  window.HatorDebugger?.onActiveFileChanged(filePath);
}

async function openFile(filePath) {
  if (!editor) {
    // wait for editor to initialize, then retry
    setTimeout(() => openFile(filePath), 100);
    return;
  }
  if (openFiles.has(filePath)) {
    activateFile(filePath);
    return;
  }
  const content = await window.api.readFile(filePath);
  const model = monaco.editor.createModel(content, languageForFile(filePath));
  openFiles.set(filePath, { model, viewState: null, dirty: false });
  lastOpenedPath = filePath;
  activateFile(filePath);
  window.HatorGitDiff?.onFileOpened(filePath, model);
}

function highlightSelectedNode(filePath) {
  document.querySelectorAll('.tree-node.selected').forEach((el) => el.classList.remove('selected'));
  const node = fileTreeEl.querySelector(`.tree-node[data-path="${CSS.escape(filePath)}"]`);
  if (node) node.classList.add('selected');
}

function buildTreeNode(node, depth) {
  const wrapper = document.createElement('div');
  const isDir = node.type === 'directory';

  const row = document.createElement('div');
  row.className = 'tree-node';
  row.style.paddingLeft = `${8 + depth * 14}px`;
  row.dataset.path = node.path;

  // Chevron (dirs only) — rotates when expanded
  const chevron = document.createElement('span');
  chevron.className = 'tree-chevron';
  if (isDir) {
    chevron.innerHTML = `<svg viewBox="0 0 8 8" xmlns="http://www.w3.org/2000/svg" width="8" height="8"><path d="M1.5 2.5l2.5 2.5 2.5-2.5" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
    chevron.style.transform = 'rotate(-90deg)';
  }
  row.appendChild(chevron);

  // File / folder icon
  const iconEl = document.createElement('span');
  iconEl.className = 'tree-file-icon';
  iconEl.innerHTML = window.HatorFileIcons
    ? window.HatorFileIcons.getIconSvg(node.name, isDir, false)
    : '';
  row.appendChild(iconEl);

  const label = document.createElement('span');
  label.textContent = node.name;
  row.appendChild(label);

  wrapper.appendChild(row);

  if (isDir) {
    const childrenEl = document.createElement('div');
    childrenEl.className = 'tree-children';
    node.children.forEach((child) => {
      childrenEl.appendChild(buildTreeNode(child, depth + 1));
    });
    wrapper.appendChild(childrenEl);

    row.addEventListener('click', () => {
      const expanded = childrenEl.classList.toggle('expanded');
      chevron.style.transform = expanded ? 'rotate(0deg)' : 'rotate(-90deg)';
      if (window.HatorFileIcons) {
        iconEl.innerHTML = window.HatorFileIcons.getIconSvg(node.name, true, expanded);
      }
    });
  } else {
    row.addEventListener('click', () => openFile(node.path));
  }

  return wrapper;
}

function renderFileTree(rootNode) {
  fileTreeEl.innerHTML = '';
  folderNameEl.textContent = rootNode.name;
  folderNameEl.title = rootNode.path;

  const rootChildren = document.createElement('div');
  rootChildren.className = 'tree-children expanded';
  rootNode.children.forEach((child) => {
    rootChildren.appendChild(buildTreeNode(child, 0));
  });
  fileTreeEl.appendChild(rootChildren);
}

openFolderBtn.addEventListener('click', async () => {
  const tree = await window.api.openFolder();
  if (tree) renderFileTree(tree);
});

let sidebarCollapsed = false;
sidebarToggleBtn.addEventListener('click', () => {
  sidebarCollapsed = !sidebarCollapsed;
  if (sidebarCollapsed) {
    sidebarEl.style.width = '0px';
    sidebarEl.style.minWidth = '0px';
    sidebarEl.style.borderRightWidth = '0px';
    sidebarEl.style.opacity = '0';
    sidebarToggleIcon.style.transform = 'rotate(180deg)';
  } else {
    sidebarEl.style.width = '240px';
    sidebarEl.style.minWidth = '240px';
    sidebarEl.style.borderRightWidth = '1px';
    sidebarEl.style.opacity = '1';
    sidebarToggleIcon.style.transform = 'rotate(0deg)';
  }
});
