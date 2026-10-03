// Minimal DOM for running web/tracker.js under plain `node`, no dependencies.
// Deliberately small: it implements exactly the surface the tracker uses, so
// anything it touches that is NOT implemented here fails loudly instead of
// silently returning undefined.

class Node {
  constructor(tag) {
    this.tagName = tag ? tag.toUpperCase() : undefined;
    this.nodeType = tag ? 1 : 3;
    this.children = [];
    this.parentNode = null;
    this._text = tag ? "" : "";
    this._cls = new Set();
    this._attrs = {};
    this._listeners = new Map();
    this.style = {};
    this.title = "";
    this.id = "";
    this.value = "";
    this.scrollTop = 0;
    this.offsetWidth = 0;
    this.offsetHeight = 0;
  }

  get className() {
    return [...this._cls].join(" ");
  }
  set className(v) {
    this._cls = new Set(String(v).split(/\s+/).filter(Boolean));
  }

  get classList() {
    const self = this;
    return {
      add: (c) => self._cls.add(c),
      remove: (c) => self._cls.delete(c),
      contains: (c) => self._cls.has(c),
      toggle: (c, force) => {
        const on = force === undefined ? !self._cls.has(c) : !!force;
        if (on) self._cls.add(c);
        else self._cls.delete(c);
        return on;
      },
    };
  }

  get textContent() {
    if (!this.children.length) return this._text;
    return this._text + this.children.map((c) => c.textContent).join("");
  }
  set textContent(v) {
    this._text = String(v);
    for (const c of this.children) c.parentNode = null;
    this.children = [];
  }

  appendChild(child) {
    if (child.parentNode) child.parentNode.removeChild(child);
    child.parentNode = this;
    this.children.push(child);
    return child;
  }
  insertBefore(child, ref) {
    if (ref === null || ref === undefined) return this.appendChild(child);
    const i = this.children.indexOf(ref);
    if (i < 0) return this.appendChild(child);
    if (child.parentNode) child.parentNode.removeChild(child);
    child.parentNode = this;
    this.children.splice(i, 0, child);
    return child;
  }
  removeChild(child) {
    const i = this.children.indexOf(child);
    if (i >= 0) {
      this.children.splice(i, 1);
      child.parentNode = null;
    }
    return child;
  }
  remove() {
    if (this.parentNode) this.parentNode.removeChild(this);
  }
  get firstChild() {
    return this.children[0] || null;
  }
  get nextSibling() {
    if (!this.parentNode) return null;
    const i = this.parentNode.children.indexOf(this);
    return this.parentNode.children[i + 1] || null;
  }

  setAttribute(k, v) {
    this._attrs[k] = String(v);
  }
  getAttribute(k) {
    return Object.prototype.hasOwnProperty.call(this._attrs, k) ? this._attrs[k] : null;
  }

  addEventListener(type, fn, options) {
    if (!this._listeners.has(type)) this._listeners.set(type, []);
    const capture = options === true || (options && options.capture === true);
    this._listeners.get(type).push({ fn, capture });
  }
  removeEventListener(type, fn, options) {
    const list = this._listeners.get(type);
    if (!list) return;
    const capture = options === true || (options && options.capture === true);
    const i = list.findIndex((l) => l.fn === fn && l.capture === capture);
    if (i >= 0) list.splice(i, 1);
  }
  // A real dispatch: capture from the document down to the target, then bubble
  // back up, with stopPropagation honoured — which is the only way to test the
  // gate that swallows events aimed at switched-off elements.
  _fire(type, props) {
    const path = [];
    for (let n = this; n; n = n.parentNode) path.push(n);
    const ev = Object.assign(
      {
        type,
        target: this,
        currentTarget: null,
        defaultPrevented: false,
        cancelable: true,
        preventDefault() {
          this.defaultPrevented = true;
        },
        stopPropagation() {
          this._stopped = true;
        },
      },
      props || {}
    );
    const call = (node, entry) => {
      if (ev._stopped) return;
      ev.currentTarget = node;
      entry.fn.call(node, ev);
    };
    // root -> target, capture only
    for (let i = path.length - 1; i >= 1; i--) {
      for (const entry of (path[i]._listeners.get(type) || []).slice()) if (entry.capture) call(path[i], entry);
    }
    for (const entry of (this._listeners.get(type) || []).slice()) if (entry.capture) call(this, entry);
    // target -> root, bubble only
    for (const entry of (this._listeners.get(type) || []).slice()) if (!entry.capture) call(this, entry);
    for (let i = 1; i < path.length; i++) {
      for (const entry of (path[i]._listeners.get(type) || []).slice()) if (!entry.capture) call(path[i], entry);
    }
    return ev;
  }
  dispatchEvent(ev) {
    return this._fire(ev.type, ev);
  }
  click() {
    this._fire("click", {});
  }
  select() {}
  focus() {}

  closest(sel) {
    const cls = String(sel).replace(/^\./, "");
    let node = this;
    while (node) {
      if (node._cls && node._cls.has(cls)) return node;
      node = node.parentNode;
    }
    return null;
  }

  // A test can lay an element out (`el._rect = {left, top, width, height}`, what
  // the harness's Vue-nodes fixture does from real node geometry) and anything
  // that reads layout sees it. Without one, the element has no box — which is
  // also what the real DOM says about a detached or hidden element.
  getBoundingClientRect() {
    if (this._doc && this._doc._rectReads !== undefined) this._doc._rectReads++;
    const r = this._rect;
    if (!r) return { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 };
    return {
      left: Number(r.left) || 0,
      top: Number(r.top) || 0,
      right: (Number(r.left) || 0) + (Number(r.width) || 0),
      bottom: (Number(r.top) || 0) + (Number(r.height) || 0),
      width: Number(r.width) || 0,
      height: Number(r.height) || 0,
    };
  }

  // What the tracker asks for: an attribute (with or without a value), a class,
  // and the two chained. Anything else returns nothing rather than guessing.
  querySelectorAll(selector) {
    const sel = String(selector || "").trim();
    const parts = sel.split(/(?=\[|\.)/).filter(Boolean);
    if (!parts.length) return [];
    const tests = [];
    for (const part of parts) {
      const attr = /^\[([\w:-]+)(?:=(?:"([^"]*)"|'([^']*)'|([^\]]+)))?\]$/.exec(part);
      if (attr) {
        const name = attr[1];
        const want = attr[2] !== undefined ? attr[2] : attr[3] !== undefined ? attr[3] : attr[4];
        tests.push((n) =>
          Object.prototype.hasOwnProperty.call(n._attrs, name) && (want === undefined || String(n._attrs[name]) === String(want))
        );
        continue;
      }
      const cls = /^\.([\w-]+)$/.exec(part);
      if (cls) {
        tests.push((n) => n._cls && n._cls.has(cls[1]));
        continue;
      }
      // Tag names, one or a comma-separated list: what the tracker asks for when
      // it looks inside a widget's element (`img,canvas`, `video`) — the shapes
      // the real DOM offers and the wrapper cases the docs describe.
      const tags = /^[a-z][\w-]*(\s*,\s*[a-z][\w-]*)*$/i.exec(part);
      if (tags) {
        const want = part.split(",").map((t) => t.trim().toUpperCase()).filter(Boolean);
        tests.push((n) => n.nodeType === 1 && want.includes(String(n.tagName).toUpperCase()));
        continue;
      }
      return [];
    }
    return this.descendants().filter((n) => n.nodeType === 1 && tests.every((t) => t(n)));
  }

  // The singular form, which the tracker uses to look *inside* a widget's element
  // (a nested `<video>`, the `<img>` in a wrapper) — the real DOM has it, so the
  // shim has it too, or those paths are never exercised.
  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }

  descendants() {
    const out = [];
    for (const c of this.children) {
      out.push(c);
      out.push(...c.descendants());
    }
    return out;
  }
}

export function createDocument(options = {}) {
  const doc = new Node("#document");
  const head = new Node("head");
  const body = new Node("body");
  doc.appendChild(head);
  doc.appendChild(body);
  doc.head = head;
  doc.body = body;
  // Canvases are the one element a test needs more from than a tag name: the
  // tracker draws offscreen bitmaps (node snapshots), and a bitmap's *content* is
  // produced by drawing into a context. `ctxFactory` is how the harness hands out
  // its recording context, so a test can assert what a capture drew and what the
  // reuse path blitted. Without a factory, `getContext` returns null and anything
  // built on it fails open — which is also the contract a real page needs.
  const ctxFactory = options.ctxFactory || null;
  doc._canvases = [];
  doc._rectReads = 0; // how much layout the page read, so a test can hold the cache to it
  doc.createElement = (tag) => {
    const node = new Node(tag);
    node._doc = doc;
    if (String(tag).toLowerCase() === "canvas") {
      node.width = 300;
      node.height = 150;
      node.getContext = (kind) => {
        if (String(kind) !== "2d" || !ctxFactory) return null;
        if (!node._ctx) {
          node._ctx = ctxFactory(node);
          doc._canvases.push(node);
        }
        return node._ctx;
      };
      // Real canvases have toBlob, and the tracker's disk cache is built on it.
      // The blob carries the canvas it came from instead of encoded pixels: a
      // test can then follow a picture to a file and back (the dimensions — what
      // the ratio and the budget are decided from — survive the trip).
      node.toBlob = (cb, type) => {
        if (typeof cb !== "function") return;
        Promise.resolve().then(() => cb({ type: type || "image/png", __antsCanvasNode: node }));
      };
    }
    return node;
  };
  // SVG elements are built with a namespace in the real DOM; the tracker draws its
  // glyphs that way, so the shim has to answer the same question.
  doc.createElementNS = (ns, tag) => new Node(tag);
  doc.createTextNode = (text) => {
    const n = new Node(null);
    n._text = String(text);
    return n;
  };
  doc.getElementById = (id) => doc.descendants().find((n) => n.id === id || n._attrs.id === id) || null;
  doc.execCommand = () => true;
  // Counted, so a test can hold the tracker to "the page is discovered on a
  // budget, not per frame": a pan must not re-walk the DOM.
  const baseQsa = Node.prototype.querySelectorAll;
  doc._qsaCalls = 0;
  doc.querySelectorAll = function (selector) {
    doc._qsaCalls++;
    return baseQsa.call(this, selector);
  };
  return doc;
}

export function createStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    _map: map,
  };
}
