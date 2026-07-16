const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  openFolder: () => ipcRenderer.invoke('dialog:openFolder'),
  readFile: (filePath) => ipcRenderer.invoke('fs:readFile', filePath),
  writeFile: (filePath, content) => ipcRenderer.invoke('fs:writeFile', filePath, content),
  readDirTree: (dirPath) => ipcRenderer.invoke('fs:readDirTree', dirPath),

  git: {
    getFileState: (filePath) => ipcRenderer.invoke('git:getFileState', filePath),
    getHeadContent: (repoRoot, relativePath) => ipcRenderer.invoke('git:getHeadContent', { repoRoot, relativePath }),
    computeDiff: (oldText, newText) => ipcRenderer.invoke('git:computeDiff', { oldText, newText }),
    onRepoChanged: (callback) => {
      const listener = (_event, payload) => callback(payload);
      ipcRenderer.on('git:repoChanged', listener);
      return () => ipcRenderer.removeListener('git:repoChanged', listener);
    },
  },

  debug: {
    start:           (filePath, bpLines) => ipcRenderer.invoke('debug:start', filePath, bpLines),
    stop:            ()                  => ipcRenderer.invoke('debug:stop'),
    setBreakpoint:   (fp, ln)            => ipcRenderer.invoke('debug:setBreakpoint',   { filePath: fp, lineNumber: ln }),
    removeBreakpoint:(fp, ln)            => ipcRenderer.invoke('debug:removeBreakpoint', { filePath: fp, lineNumber: ln }),
    resume:          ()                  => ipcRenderer.invoke('debug:resume'),
    stepOver:        ()                  => ipcRenderer.invoke('debug:stepOver'),
    stepInto:        ()                  => ipcRenderer.invoke('debug:stepInto'),
    stepOut:         ()                  => ipcRenderer.invoke('debug:stepOut'),
    onPaused:  (cb) => { const fn = (_, d) => cb(d); ipcRenderer.on('debug:paused',  fn); return () => ipcRenderer.removeListener('debug:paused',  fn); },
    onResumed: (cb) => { const fn = (_, d) => cb(d); ipcRenderer.on('debug:resumed', fn); return () => ipcRenderer.removeListener('debug:resumed', fn); },
    onOutput:  (cb) => { const fn = (_, d) => cb(d); ipcRenderer.on('debug:output',  fn); return () => ipcRenderer.removeListener('debug:output',  fn); },
    onStopped: (cb) => { const fn = (_, d) => cb(d); ipcRenderer.on('debug:stopped', fn); return () => ipcRenderer.removeListener('debug:stopped', fn); },
  },

  terminal: {
    getShellPresets: () => ipcRenderer.invoke('terminal:getShellPresets'),
    create: (opts) => ipcRenderer.invoke('terminal:create', opts),
    input: (id, data) => ipcRenderer.send('terminal:input', { id, data }),
    resize: (id, cols, rows) => ipcRenderer.send('terminal:resize', { id, cols, rows }),
    dispose: (id) => ipcRenderer.send('terminal:dispose', id),
    onData: (callback) => {
      const listener = (_event, payload) => callback(payload);
      ipcRenderer.on('terminal:data', listener);
      return () => ipcRenderer.removeListener('terminal:data', listener);
    },
    onExit: (callback) => {
      const listener = (_event, payload) => callback(payload);
      ipcRenderer.on('terminal:exit', listener);
      return () => ipcRenderer.removeListener('terminal:exit', listener);
    },
  },
});
