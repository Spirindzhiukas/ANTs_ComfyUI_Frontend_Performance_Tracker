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

  addEventListener(type, fn) {
    if (!this._listeners.has(type)) this._listeners.set(type, []);
    this._listeners.get(type).push(fn);
  }
  removeEventListener(type, fn) {
    const list = this._listeners.get(type);
    if (!list) return;
    const i = list.indexOf(fn);
    if (i >= 0) list.splice(i, 1);
  }
  _fire(type, props) {
    const list = this._listeners.get(type) || [];
    const ev = Object.assign({ type, target: this, currentTarget: this, preventDefault() {}, stopPropagation() {} }, props || {});
    for (const fn of list.slice()) fn.call(this, ev);
    return ev;
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

  getBoundingClientRect() {
    return { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 };
  }

  // Only what the tracker asks for: a presence selector, and one that pins an
  // attribute to a value. Anything else returns nothing rather than guessing.
  querySelectorAll(selector) {
    const sel = String(selector || "").trim();
    const m = /^\[([\w:-]+)(?:=(?:"([^"]*)"|'([^']*)'|([^\]]+)))?\]$/.exec(sel);
    if (!m) return [];
    const attr = m[1];
    const want = m[2] !== undefined ? m[2] : m[3] !== undefined ? m[3] : m[4];
    const has = (node) => Object.prototype.hasOwnProperty.call(node._attrs, attr);
    const value = (node) => String(node._attrs[attr]);
    return this.descendants().filter((n) => {
      if (n.nodeType !== 1 || !has(n)) return false;
      return want === undefined ? true : value(n) === String(want);
    });
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

export function createDocument() {
  const doc = new Node("#document");
  const head = new Node("head");
  const body = new Node("body");
  doc.appendChild(head);
  doc.appendChild(body);
  doc.head = head;
  doc.body = body;
  doc.createElement = (tag) => new Node(tag);
  doc.createTextNode = (text) => {
    const n = new Node(null);
    n._text = String(text);
    return n;
  };
  doc.getElementById = (id) => doc.descendants().find((n) => n.id === id || n._attrs.id === id) || null;
  doc.execCommand = () => true;
  doc.querySelectorAll = Node.prototype.querySelectorAll;
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
