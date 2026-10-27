/**
 * Minimal fake DOM for node --test. Implements only what public/js/{view,app}.js
 * touch: tree building, classList, dataset, ids, textContent, and a
 * bubbling-ish event dispatch. Not a general DOM.
 */

let idMap = new Map();

class FakeClassList {
  constructor() { this.set = new Set(); }
  add(...cs) { cs.forEach((c) => c && String(c).split(/\s+/).forEach((x) => this.set.add(x))); }
  remove(...cs) { cs.forEach((c) => this.set.delete(c)); }
  contains(c) { return this.set.has(c); }
  toggle(c, force) {
    const want = force === undefined ? !this.set.has(c) : Boolean(force);
    if (want) this.set.add(c); else this.set.delete(c);
    return want;
  }
}

export class FakeElement {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.parentNode = null;
    this.dataset = {};
    this.attributes = {};
    this.classList = new FakeClassList();
    this._text = "";
    this._id = "";
    this.hidden = false;
    this.value = "";
    this.style = {};
    this._listeners = {};
  }

  get id() { return this._id; }
  set id(v) {
    if (this._id) idMap.delete(this._id);
    this._id = String(v);
    if (this._id) idMap.set(this._id, this);
  }

  get className() { return [...this.classList.set].join(" "); }
  set className(v) {
    this.classList.set = new Set(String(v).split(/\s+/).filter(Boolean));
  }

  get textContent() {
    return this._text + this.children.map((c) => c.textContent).join("");
  }
  set textContent(v) {
    this._text = v == null ? "" : String(v);
    this.children = [];
  }

  get parentElement() { return this.parentNode; }

  appendChild(child) {
    child.parentNode = this;
    this.children.push(child);
    return child;
  }

  setAttribute(k, v) {
    this.attributes[k] = String(v);
    if (k === "id") this.id = v;
    if (k === "class") this.className = v;   // mirror the real DOM
  }
  getAttribute(k) { return this.attributes[k] ?? null; }

  addEventListener(type, fn) {
    (this._listeners[type] ||= []).push(fn);
  }

  /** Subtree DFS; supports "#id", ".class", and comma-separated lists of those. */
  querySelector(sel) {
    return descend(this, matches(sel));
  }

  querySelectorAll(sel) {
    const out = [];
    collect(this, matches(sel), out);
    return out;
  }

  /** Fire an event that bubbles from this node up through its ancestors. */
  dispatch(type, init = {}) {
    const ev = { type, target: this, preventDefault() {}, ...init };
    let n = this;
    while (n) {
      for (const fn of (n._listeners && n._listeners[type]) || []) fn(ev);
      n = n.parentNode;
    }
    return ev;
  }
}

function descend(root, pred) {
  for (const c of root.children) {
    if (pred(c)) return c;
    const hit = descend(c, pred);
    if (hit) return hit;
  }
  return null;
}

/** Build a predicate from "#id", ".class", "tag", or a comma-separated list. */
function matches(sel) {
  const parts = String(sel).split(",").map((s) => s.trim()).filter(Boolean);
  return (n) => parts.some((p) => {
    if (p[0] === "#") return n.id === p.slice(1);
    if (p[0] === ".") return n.classList.contains(p.slice(1));
    return n.tagName === p.toUpperCase();
  });
}

function collect(root, pred, out) {
  for (const c of root.children) {
    if (pred(c)) out.push(c);
    collect(c, pred, out);
  }
  return out;
}

/** Fresh globals + fetch recorder. Call BEFORE importing app.js. */
export function installEnv() {
  idMap = new Map();

  const root = new FakeElement("div");
  root.id = "app";

  const docListeners = {};
  const documentStub = {
    readyState: "complete",
    body: new FakeElement("body"),
    documentElement: root,
    getElementById: (id) => idMap.get(id) || null,
    createElement: (t) => new FakeElement(t),
    createElementNS: (_ns, t) => new FakeElement(t),
    querySelector: (sel) => root.querySelector(sel),
    querySelectorAll: (sel) => root.querySelectorAll(sel),
    addEventListener: (type, fn) => { (docListeners[type] ||= []).push(fn); },
  };

  const windowListeners = {};
  const env = {
    root,
    document: documentStub,
    opened: [],
    navigations: [],
    fetchCalls: [],
    fetchRoutes: [],
    localStorage: makeStorage(),
    sessionStorage: makeStorage(),
  };

  env.window = {
    location: { origin: "http://localhost:8089", href: "http://localhost:8089/" },
    open: (url, name, feats) => {
      env.opened.push({ url, name, feats });
      return { closed: false };
    },
    addEventListener: (type, fn) => { (windowListeners[type] ||= []).push(fn); },
    /** Test helper: dispatch a cross-window message. */
    emit: (type, ev) => (windowListeners[type] || []).forEach((fn) => fn(ev)),
  };

  // location.href assignments are navigations; record instead of moving.
  let href = env.window.location.href;
  Object.defineProperty(env.window.location, "href", {
    get: () => href,
    set: (v) => { href = v; env.navigations.push(v); },
  });

  env.fetch = async (url, opts) => {
    env.fetchCalls.push({ url: String(url), opts });
    for (const route of env.fetchRoutes) {
      const r = route(String(url), opts);
      if (r) {
        const body = typeof r === "function" ? r() : r;
        return { ok: body.ok !== false, status: body.status || 200, json: async () => body.json || {} };
      }
    }
    return { ok: false, status: 404, json: async () => ({ error: `no route for ${url}` }) };
  };

  globalThis.document = documentStub;
  globalThis.window = env.window;
  globalThis.localStorage = env.localStorage;
  globalThis.sessionStorage = env.sessionStorage;
  globalThis.fetch = env.fetch;

  return env;
}

function makeStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(String(k), String(v)); },
    removeItem: (k) => { m.delete(k); },
    clear: () => { m.clear(); },
    key: (i) => [...m.keys()][i] ?? null,
    get length() { return m.size; },
  };
}
