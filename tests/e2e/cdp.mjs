// Minimal CDP client for headless Chrome (Node >= 22, global WebSocket).
// Usage: import { launch, connect } from './cdp.mjs'

export async function listTargets(port) {
  const res = await fetch(`http://127.0.0.1:${port}/json/list`);
  return res.json();
}

export class CDP {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
    this.consoleEvents = [];
    ws.addEventListener('message', (ev) => {
      let msg;
      try { msg = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString()); } catch { return; }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject, timer } = this.pending.get(msg.id);
        clearTimeout(timer);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(`${msg.error.message} (${JSON.stringify(msg.error.data ?? '')})`));
        else resolve(msg.result);
      } else if (msg.method) {
        this.consoleEvents.push(msg);
        const hs = this.listeners.get(msg.method) || [];
        for (const h of hs) { try { h(msg.params); } catch (e) { console.error('listener err', e); } }
        const all = this.listeners.get('*') || [];
        for (const h of all) { try { h(msg); } catch {} }
      }
    });
  }

  send(method, params = {}, timeoutMs = 30000) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP timeout: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  on(method, handler) {
    if (!this.listeners.has(method)) this.listeners.set(method, []);
    this.listeners.get(method).push(handler);
    return this;
  }

  async evaluate(expression, { awaitPromise = false, returnByValue = true } = {}) {
    const r = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise,
      returnByValue,
      userGesture: true,
    });
    if (r.exceptionDetails) {
      const d = r.exceptionDetails;
      throw new Error(`evaluate exception: ${d.text} ${d.exception?.description ?? ''}`);
    }
    return r.result?.value;
  }

  /** Poll a JS expression until truthy; returns its value. */
  async waitFor(expression, { timeout = 20000, interval = 200, label = expression } = {}) {
    const deadline = Date.now() + timeout;
    let lastErr;
    while (Date.now() < deadline) {
      try {
        const v = await this.evaluate(expression);
        if (v) return v;
      } catch (e) { lastErr = e; }
      await new Promise((r) => setTimeout(r, interval));
    }
    throw new Error(`waitFor timeout: ${label}${lastErr ? ` (last error: ${lastErr.message})` : ''}`);
  }

  async screenshot(path, { format = 'png', clip } = {}) {
    const params = { format, captureBeyondViewport: false };
    if (clip) params.clip = clip;
    const { data } = await this.send('Page.captureScreenshot', params);
    const { writeFileSync } = await import('node:fs');
    writeFileSync(path, Buffer.from(data, 'base64'));
    return path;
  }

  close() { try { this.ws.close(); } catch {} }
}

export async function connect(port = 9311, targetFilter = null) {
  const targets = await listTargets(port);
  const pages = targets.filter((t) => t.type === 'page');
  const t = targetFilter ? pages.find(targetFilter) : pages[0];
  if (!t) throw new Error(`no page target on ${port}: ${JSON.stringify(targets.map(x => x.type + ':' + x.url))}`);
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', (e) => reject(new Error('ws error')), { once: true });
  });
  const cdp = new CDP(ws);
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  await cdp.send('Log.enable');
  await cdp.send('Network.enable');
  return { cdp, target: t };
}

export async function newPage(port, url) {
  const res = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' });
  return res.json();
}
