const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const pty = require('node-pty');
const gitService = require('./git/gitService');
const { DiffEngine } = require('./git/diffEngine');
const { DebugSession } = require('./debug/debugSession');

let mainWindow;

app.setName('Hator');

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    title: 'Hator',
    backgroundColor: '#1e1e1e',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  mainWindow.on('closed', () => {
    killAllPtys();
  });
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

app.on('before-quit', () => {
  killAllPtys();
  closeAllGitWatchers();
  diffEngine.dispose();
  activeDebugSession?.stop();
});

function readDirTree(dirPath) {
  const stats = fs.statSync(dirPath);
  const name = path.basename(dirPath);

  if (!stats.isDirectory()) {
    return { name, path: dirPath, type: 'file' };
  }

  const entries = fs
    .readdirSync(dirPath, { withFileTypes: true })
    .filter((entry) => !entry.name.startsWith('.git') && entry.name !== 'node_modules')
    .sort((a, b) => {
      if (a.isDirectory() === b.isDirectory()) return a.name.localeCompare(b.name);
      return a.isDirectory() ? -1 : 1;
    });

  return {
    name,
    path: dirPath,
    type: 'directory',
    children: entries.map((entry) => readDirTree(path.join(dirPath, entry.name))),
  };
}

ipcMain.handle('dialog:openFolder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return readDirTree(result.filePaths[0]);
});

ipcMain.handle('fs:readFile', async (_event, filePath) => {
  return fs.readFileSync(filePath, 'utf-8');
});

ipcMain.handle('fs:writeFile', async (_event, filePath, content) => {
  fs.writeFileSync(filePath, content, 'utf-8');
  return true;
});

ipcMain.handle('fs:readDirTree', async (_event, dirPath) => {
  return readDirTree(dirPath);
});

// --- Integrated Terminal (node-pty bridge) ----------------------------------
const SHELL_PRESETS =
  process.platform === 'win32'
    ? [
        { id: 'powershell', label: 'PowerShell', exe: 'powershell.exe', args: [] },
        { id: 'cmd', label: 'Command Prompt', exe: 'cmd.exe', args: [] },
      ]
    : [
        { id: 'zsh', label: 'zsh', exe: 'zsh', args: ['-l'] },
        { id: 'bash', label: 'bash', exe: 'bash', args: ['-l'] },
      ];

const ptyProcesses = new Map(); // id -> node-pty process
let nextPtyId = 1;

function killAllPtys() {
  ptyProcesses.forEach((proc) => {
    try {
      proc.kill();
    } catch {
      /* already exited */
    }
  });
  ptyProcesses.clear();
}

ipcMain.handle('terminal:getShellPresets', () => SHELL_PRESETS.map(({ id, label }) => ({ id, label })));

ipcMain.handle('terminal:create', (_event, { shellId, cols, rows } = {}) => {
  const preset = SHELL_PRESETS.find((s) => s.id === shellId) || SHELL_PRESETS[0];
  const id = String(nextPtyId++);

  const proc = pty.spawn(preset.exe, preset.args, {
    name: 'xterm-256color',
    cols: cols > 0 ? cols : 80,
    rows: rows > 0 ? rows : 24,
    cwd: os.homedir(),
    env: process.env,
    // Avoids node-pty's default Windows kill() path, which forks a helper
    // script to enumerate console processes via AttachConsole -- that call
    // fails inside Electron's console-less process and logs a scary (but
    // harmless, 5s-timeout-recovered) crash trace on every pty dispose.
    useConptyDll: process.platform === 'win32',
  });

  proc.onData((data) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('terminal:data', { id, data });
    }
  });

  proc.onExit(({ exitCode }) => {
    ptyProcesses.delete(id);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('terminal:exit', { id, exitCode });
    }
  });

  ptyProcesses.set(id, proc);
  return { id, shellId: preset.id };
});

ipcMain.on('terminal:input', (_event, { id, data }) => {
  ptyProcesses.get(id)?.write(data);
});

ipcMain.on('terminal:resize', (_event, { id, cols, rows }) => {
  const proc = ptyProcesses.get(id);
  if (proc && cols > 0 && rows > 0) {
    try {
      proc.resize(cols, rows);
    } catch {
      // Ignore transient resize errors while the panel is mid-animation.
    }
  }
});

ipcMain.on('terminal:dispose', (_event, id) => {
  const proc = ptyProcesses.get(id);
  if (proc) {
    proc.kill();
    ptyProcesses.delete(id);
  }
});

// --- Inline Git diff gutter --------------------------------------------------
const diffEngine = new DiffEngine();

// One fs.watch per repo root (not per file) so switching tabs within the same
// repo doesn't spawn duplicate watchers; watching the top-level `.git` dir
// catches HEAD/index writes from commits, checkouts, merges, and pulls.
const gitWatchers = new Map(); // repoRoot -> { watcher, debounceTimer }

function watchRepo(repoRoot) {
  if (!repoRoot || gitWatchers.has(repoRoot)) return;
  try {
    const watcher = fs.watch(path.join(repoRoot, '.git'), { persistent: false }, () => {
      const entry = gitWatchers.get(repoRoot);
      if (!entry) return;
      clearTimeout(entry.debounceTimer);
      entry.debounceTimer = setTimeout(() => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('git:repoChanged', { repoRoot });
        }
      }, 300);
    });
    gitWatchers.set(repoRoot, { watcher, debounceTimer: null });
  } catch {
    // Repo root vanished or .git is inaccessible; real-time refresh on
    // external changes just won't fire for this repo, which is non-fatal.
  }
}

function closeAllGitWatchers() {
  gitWatchers.forEach(({ watcher, debounceTimer }) => {
    clearTimeout(debounceTimer);
    try {
      watcher.close();
    } catch {
      /* already closed */
    }
  });
  gitWatchers.clear();
}

ipcMain.handle('git:getFileState', async (_event, filePath) => {
  const status = await gitService.getFileGitStatus(filePath);
  if (status.repoRoot) watchRepo(status.repoRoot);
  return status;
});

ipcMain.handle('git:getHeadContent', async (_event, { repoRoot, relativePath }) => {
  return gitService.getHeadFileContent(repoRoot, relativePath);
});

ipcMain.handle('git:computeDiff', async (_event, { oldText, newText }) => {
  return diffEngine.computeLineDiff(oldText, newText);
});

// --- Node.js debugger (CDP over V8 inspector) --------------------------------
let activeDebugSession = null;

function debugEmit(name, data) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(`debug:${name}`, data);
  }
}

ipcMain.handle('debug:start', async (_event, filePath, initialBpLines) => {
  activeDebugSession?.stop();
  activeDebugSession = null;

  const session = new DebugSession(debugEmit);
  activeDebugSession = session;

  try {
    await session.start(filePath, initialBpLines || []);
    return { ok: true };
  } catch (e) {
    activeDebugSession = null;
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('debug:stop', () => {
  activeDebugSession?.stop();
  activeDebugSession = null;
  return true;
});

ipcMain.handle('debug:setBreakpoint', async (_event, { filePath, lineNumber }) => {
  await activeDebugSession?.setBreakpoint(filePath, lineNumber);
  return true;
});

ipcMain.handle('debug:removeBreakpoint', async (_event, { filePath, lineNumber }) => {
  await activeDebugSession?.removeBreakpoint(filePath, lineNumber);
  return true;
});

ipcMain.handle('debug:resume',   () => activeDebugSession?.resume());
ipcMain.handle('debug:stepOver', () => activeDebugSession?.stepOver());
ipcMain.handle('debug:stepInto', () => activeDebugSession?.stepInto());
ipcMain.handle('debug:stepOut',  () => activeDebugSession?.stepOut());
