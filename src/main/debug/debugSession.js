'use strict';

const { spawn } = require('child_process');
const path = require('path');
const { CDPClient } = require('./cdpClient');

class DebugSession {
  constructor(emit) {
    this.emit = emit;           // (name, data) → IPC to renderer
    this.proc = null;
    this.cdp = null;
    this.scriptUrls = new Map(); // scriptId → url
    this.bpIds = new Map();      // `${url}:${line0}` → CDP breakpointId
    this._done = false;
  }

  // Spawn Node with --inspect-brk=0, connect CDP, set initial breakpoints, then start.
  start(filePath, initialBpLines = []) {
    const dir = path.dirname(filePath);
    const file = path.basename(filePath);

    return new Promise((resolve, reject) => {
      this.proc = spawn('node', ['--inspect-brk=0', file], {
        cwd: dir,
        env: { ...process.env },
        shell: false,
      });

      let resolved = false;

      const tryConnect = async (text) => {
        const m = text.match(/Debugger listening on (ws:\/\/\S+)/);
        if (!m) return;
        try {
          await this._connect(m[1], filePath, initialBpLines);
          resolved = true;
          resolve();
        } catch (e) {
          reject(e);
        }
      };

      this.proc.stderr.on('data', (chunk) => {
        const text = chunk.toString();
        if (!resolved) tryConnect(text);
        // Hide the inspector banner lines from the terminal output
        const hide = text.startsWith('Debugger listening') || text.includes('For help, see:');
        if (!hide) this.emit('output', { text, category: 'stderr' });
      });

      this.proc.stdout.on('data', (chunk) => {
        this.emit('output', { text: chunk.toString(), category: 'stdout' });
      });

      this.proc.on('error', (err) => {
        if (!resolved) reject(err);
        else this.emit('stopped', { error: err.message });
      });

      this.proc.on('exit', (code) => {
        if (!resolved) {
          reject(new Error(`node exited (${code}) before debugger inspector was ready`));
        } else {
          this._done = true;
          this.emit('stopped', { exitCode: code });
        }
      });

      setTimeout(() => {
        if (!resolved) reject(new Error('Timeout: no Node.js inspector URL after 8 s'));
      }, 8000);
    });
  }

  async _connect(wsUrl, filePath, initialBpLines) {
    this.cdp = new CDPClient();
    await this.cdp.connect(wsUrl);

    this.cdp.on('Debugger.scriptParsed', ({ scriptId, url }) => {
      if (url) this.scriptUrls.set(scriptId, url);
    });

    this.cdp.on('Debugger.paused', async (params) => {
      const frames = this._resolveFrames(params.callFrames);
      const vars = await this._getLocals(params.callFrames[0]).catch(() => []);
      this.emit('paused', { callFrames: frames, variables: vars });
    });

    this.cdp.on('Debugger.resumed', () => this.emit('resumed', {}));

    this.cdp.on('_close', () => {
      if (!this._done) this.emit('stopped', {});
    });

    await this.cdp.send('Runtime.enable');
    await this.cdp.send('Debugger.enable', { maxScriptsCacheSize: 10_000_000 });

    for (const line of initialBpLines) {
      await this._doSetBp(filePath, line).catch(() => {});
    }

    await this.cdp.send('Runtime.runIfWaitingForDebugger');
  }

  _toUrl(filePath) {
    if (process.platform === 'win32') {
      return 'file:///' + filePath.replace(/\\/g, '/');
    }
    return 'file://' + filePath;
  }

  _fromUrl(url) {
    try {
      const u = new URL(url);
      return process.platform === 'win32'
        ? decodeURIComponent(u.pathname.slice(1)).replace(/\//g, '\\')
        : decodeURIComponent(u.pathname);
    } catch {
      return url;
    }
  }

  _resolveFrames(cdpFrames) {
    return cdpFrames.map((f) => ({
      name: f.functionName || '(anonymous)',
      filePath: this._fromUrl(this.scriptUrls.get(f.location.scriptId) || ''),
      line: f.location.lineNumber + 1,   // CDP is 0-based
      column: f.location.columnNumber + 1,
      frameId: f.callFrameId,
    }));
  }

  async _getLocals(frame) {
    if (!frame) return [];
    const out = [];
    for (const scope of frame.scopeChain) {
      if (scope.type !== 'local' && scope.type !== 'closure') continue;
      const { result: props } = await this.cdp.send('Runtime.getProperties', {
        objectId: scope.object.objectId,
        ownProperties: true,
        generatePreview: true,
      });
      for (const p of props) {
        if (p.name.startsWith('__') || p.name === 'this') continue;
        const v = p.value;
        out.push({
          name: p.name,
          value: v?.preview?.description ?? v?.description ?? String(v?.value ?? 'undefined'),
          type: v?.type ?? 'undefined',
        });
      }
    }
    return out;
  }

  async _doSetBp(filePath, line) {
    const url = this._toUrl(filePath);
    const key = `${url}:${line - 1}`;
    if (this.bpIds.has(key)) return;
    const { breakpointId } = await this.cdp.send('Debugger.setBreakpointByUrl', {
      url,
      lineNumber: line - 1,
      columnNumber: 0,
    });
    this.bpIds.set(key, breakpointId);
  }

  async setBreakpoint(filePath, line) {
    if (!this.cdp) return;
    await this._doSetBp(filePath, line).catch(() => {});
  }

  async removeBreakpoint(filePath, line) {
    if (!this.cdp) return;
    const url = this._toUrl(filePath);
    const key = `${url}:${line - 1}`;
    const bpId = this.bpIds.get(key);
    if (!bpId) return;
    await this.cdp.send('Debugger.removeBreakpoint', { breakpointId: bpId }).catch(() => {});
    this.bpIds.delete(key);
  }

  resume()    { return this.cdp?.send('Debugger.resume').catch(() => {}); }
  stepOver()  { return this.cdp?.send('Debugger.stepOver').catch(() => {}); }
  stepInto()  { return this.cdp?.send('Debugger.stepInto').catch(() => {}); }
  stepOut()   { return this.cdp?.send('Debugger.stepOut').catch(() => {}); }

  stop() {
    this._done = true;
    this.cdp?.close();
    this.cdp = null;
    try { this.proc?.kill(); } catch { /* already exited */ }
    this.proc = null;
  }
}

module.exports = { DebugSession };
