'use strict';

// Chrome DevTools Protocol client over WebSocket.
// Node 22 ships a global WebSocket so no `ws` package is needed.
class CDPClient {
  constructor() {
    this.ws = null;
    this.nextId = 1;
    this.pending = new Map(); // id → {resolve, reject}
    this.handlers = new Map(); // method → fn[]
  }

  connect(url) {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(url);
      this.ws.onopen = resolve;
      this.ws.onerror = (e) => reject(new Error(`CDP connect failed: ${e.message || 'unknown'}`));
      this.ws.onmessage = ({ data }) => this._recv(JSON.parse(data));
      this.ws.onclose = () => {
        for (const { reject: r } of this.pending.values()) {
          r(new Error('CDP disconnected'));
        }
        this.pending.clear();
        this._fire('_close', {});
      };
    });
  }

  _recv(msg) {
    if (msg.id != null) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message));
      else p.resolve(msg.result ?? {});
    } else if (msg.method) {
      this._fire(msg.method, msg.params ?? {});
    }
  }

  _fire(event, params) {
    (this.handlers.get(event) || []).forEach((fn) => fn(params));
  }

  on(event, fn) {
    if (!this.handlers.has(event)) this.handlers.set(event, []);
    this.handlers.get(event).push(fn);
    return () => {
      const arr = this.handlers.get(event);
      if (arr) {
        const i = arr.indexOf(fn);
        if (i !== -1) arr.splice(i, 1);
      }
    };
  }

  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        return reject(new Error('CDP not connected'));
      }
      const id = this.nextId++;
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  close() {
    try { this.ws?.close(); } catch { /* already closed */ }
    this.ws = null;
  }
}

module.exports = { CDPClient };
