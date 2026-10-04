// Minimal DOM for running web/tracker.js under plain `node`, no dependencies.
// Deliberately small: it implements exactly the surface the tracker uses, so
// anything it touches that is NOT implemented here fails loudly instead of
// silently returning undefined.

// The document the current shim tree belongs to. Read by `isConnected` to answer
// the only question the tracker asks of it: is this element still on the page?
let documentNode = null;

class Node {
  constructor(tag) {
    this.tagName = tag ? tag.toUpperCase() : undefined;
    this.nodeType = tag ? 1 : 3;
    this.children = [];
    this.parentNode = null;
    // Real DOM state the tracker reads: an element the frontend unmounted is not
    // the element to dress any more, however well it still answers.
    Object.defineProperty(this, "isConnected", {
      // In a document, not merely attached to something: the frontend detaching a
      // whole pane takes every node element off the page, and that is the state
      // the tracker has to notice.
      get: () => {
        let n = this;
        while (n.parentNode) n = n.parentNode;
        return n === documentNode;
      },
    });
    if (tag && documentNode && documentNode._counts) documentNode._counts.elements++;
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
    fireMutation(this);
  }

  appendChild(child) {
    if (child.parentNode) child.parentNode.removeChild(child);
    child.parentNode = this;
    this.children.push(child);
    fireMutation(this, child);
    return child;
  }
  insertBefore(child, ref) {
    if (ref === null || ref === undefined) return this.appendChild(child);
    const i = this.children.indexOf(ref);
    if (i < 0) return this.appendChild(child);
    if (child.parentNode) child.parentNode.removeChild(child);
    child.parentNode = this;
    this.children.splice(i, 0, child);
    fireMutation(this, child);
    return child;
  }
  removeChild(child) {
    const i = this.children.indexOf(child);
    if (i >= 0) {
      this.children.splice(i, 1);
      child.parentNode = null;
      fireMutation(this, null, child);
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

  removeAttribute(k) {
    if (this._doc && this._doc._counts) {
      this._doc._counts.attrWrites++;
      const by = this._doc._counts.attrWriteBy || (this._doc._counts.attrWriteBy = {});
      by[k] = (by[k] || 0) + 1;
    }
    delete this._attrs[k];
  }
  hasAttribute(k) {
    if (this._doc && this._doc._counts) this._doc._counts.attrReads++;
    return Object.prototype.hasOwnProperty.call(this._attrs, k);
  }
  setAttribute(k, v) {
    // What a browser charges for: writing the attribute the element already has
    // is still an attribute change to Blink (it invalidates style for the
    // element), so it is counted here even though the value does not move.
    if (this._doc && this._doc._counts) {
      this._doc._counts.attrWrites++;
      if (this._attrs[k] === String(v)) this._doc._counts.attrRewrites++;
      const by = this._doc._counts.attrWriteBy || (this._doc._counts.attrWriteBy = {});
      by[k] = (by[k] || 0) + 1;
    }
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

  // The box, and — when a test has switched the observers on — a real signal that
  // the box changed. In the browser this is what ResizeObserver is for; here it is
  // the assignment itself, which is the only way a box changes without a real layout
  // engine. The tracker is not told *what* changed, only that its measurement of
  // this element is no longer good.
  get _rect() {
    return this.__rect;
  }
  set _rect(v) {
    this.__rect = v;
    fireResize(this);
  }

  // A test can lay an element out (`el._rect = {left, top, width, height}`, what
  // the harness's Vue-nodes fixture does from real node geometry) and anything
  // that reads layout sees it. Without one, the element has no box — which is
  // also what the real DOM says about a detached or hidden element.
  getBoundingClientRect() {
    if (this._doc && this._doc._counts) this._doc._counts.rects++;
    if (this._doc && this._doc._rectReads !== undefined) this._doc._rectReads++;
    const r = this.__rect;
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
    if (this._doc && this._doc._counts) {
      this._doc._counts.qsa++;
      const key = `${String(this.tagName || this.nodeType)}:${String(selector)}`;
      const by = this._doc._counts.qsaBy || (this._doc._counts.qsaBy = {});
      by[key] = (by[key] || 0) + 1;
    }
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
      // The universal selector: how a walk of a node's own subtree starts when the
      // walker cannot use `children` (a widget element is not always an element).
      if (part === "*") {
        tests.push(() => true);
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
      // A selector this shim cannot express is *recorded*, not silently dropped: a
      // selector that returns nothing on the harness and something on a real page is
      // a behaviour difference no test would ever see, and a reader that keeps asking
      // for one is reading a different page than the tests do.
      if (this._doc && this._doc._qsaUnsupported && this._doc._qsaUnsupported.indexOf(sel) < 0) {
        this._doc._qsaUnsupported.push(sel);
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

// What the page's own computed style would say, as far as anything here reads it:
// whether a marked element is really off (the two rules this tool's stylesheet
// writes: a boxed element is `display: none`, an inert one does not answer
// pointers), and the font/colour of a text element. Anything a test set inline
// wins, exactly as it does in a browser.
// `getComputedStyle().transform` in a browser is the *resolved* matrix, not the
// string that was written, and everything that reads it depends on that: the
// frontend writes `scale3d(z,z,z) translate3d(x,y,0)` and the tool reads m11 as the
// zoom. Resolving the handful of forms the frontend actually writes keeps the shim
// honest about the one number being measured.
function resolveTransform(t) {
  const src = String(t || "").trim();
  if (!src || src === "none") return "none";
  if (/^matrix3?\(/.test(src)) return src; // already resolved
  const s3 = /scale3?d?\(\s*([-0-9.]+)/.exec(src);
  const s1 = /scale\(\s*([-0-9.]+)/.exec(src);
  const m1 = s3 ? Number(s3[1]) : s1 ? Number(s1[1]) : 0;
  const s = Number.isFinite(m1) && m1 ? m1 : 0;
  if (!s) return "matrix(1, 0, 0, 1, 0, 0)";
  const tr3 = /translate3d\(\s*([-0-9.]+)px,\s*([-0-9.]+)px/.exec(src);
  const tr2 = /translate\(\s*([-0-9.]+)px(?:,\s*([-0-9.]+)px)?/.exec(src);
  const tx = Number((tr3 ? tr3[1] : tr2 ? tr2[1] : 0)) || 0;
  const ty = Number((tr3 ? tr3[2] : tr2 && tr2[2] ? tr2[2] : 0)) || 0;
  return `matrix3d(${s}, 0, 0, 0, 0, ${s}, 0, 0, 0, 0, ${s}, 0, ${tx}, ${ty}, 0, 1)`;
}

export function computedStyle(el) {
  const cls = el && el._cls ? el._cls : new Set();
  const style = (el && el.style) || {};
  return {
    display: style.display || (cls.has("ants-lod-box") ? "none" : "block"),
    visibility: style.visibility || "visible",
    opacity: style.opacity || "1",
    pointerEvents: style.pointerEvents || (cls.has("ants-lod-inert") ? "none" : "auto"),
    transform: resolveTransform(style.transform),
    fontSize: style.fontSize || "12px",
    color: style.color || "rgb(220, 220, 230)",
    fontFamily: style.fontFamily || "Arial",
    fontWeight: style.fontWeight || "400",
    fontStyle: style.fontStyle || "normal",
    lineHeight: style.lineHeight || "normal",
    letterSpacing: style.letterSpacing || "0px",
    // The one native level-of-detail switch, read by the tracker's probe. A shim
    // cannot implement `content-visibility`, so it reports what was *set* — which is
    // exactly what the probe is asking (is this property in the CSSOM at all).
    contentVisibility: style.contentVisibility || "visible",
    // The box colours a browser actually resolves for an element, which is what a
    // stand-in reads to draw a node's own structure (the coloured surface, the
    // header bar, the body panel, a slot's dot). A test sets them on the fixture;
    // the defaults are the CSS initial values, so an element with no colour is not
    // painted rather than painted black.
    backgroundColor: style.backgroundColor || "rgba(0, 0, 0, 0)",
    borderTopWidth: style.borderTopWidth || "0px",
    borderTopColor: style.borderTopColor || "rgba(0, 0, 0, 0)",
    borderTopLeftRadius: style.borderTopLeftRadius || "0px",
    // The image properties a node's icons live in. The frontend's iconify plugin
    // compiles `icon-[comfy--info]` to `mask-image: url("data:image/svg+xml,…")`,
    // so a reader that cannot see this property sees no icon at all — and a page
    // that draws its glyphs this way is a page whose pictures need it. A test sets
    // them on the fixture, exactly as `style.maskImage = "url(...)"` would.
    maskImage: style.maskImage || "",
    maskSize: style.maskSize || "",
    backgroundImage: style.backgroundImage || "",
    backgroundSize: style.backgroundSize || "",
  };
  // A browser answers the dashed spellings too, and one of them is the only
  // spelling that exists for a while (`-webkit-mask-image`), so the shim serves
  // both from one table instead of leaving the reader with a route that only works
  // on one engine.
  const dashed = (name) => {
    const key = String(name || "").replace(/^-[a-z]+-/, "");
    const camel = key.replace(/-([a-z])/g, (m, c) => c.toUpperCase());
    if (camel === "webkitLineClamp" || camel === "lineClamp") return style.webkitLineClamp || style.lineClamp || "";
    if (camel === "webkitMaskImage") return out.maskImage;
    if (camel === "webkitMaskSize") return out.maskSize;
    return Object.prototype.hasOwnProperty.call(out, camel) ? out[camel] : "";
  };
  out.getPropertyValue = dashed;
  Object.defineProperty(out, "webkitMaskImage", { value: out.maskImage, enumerable: false });
  Object.defineProperty(out, "webkitMaskSize", { value: out.maskSize, enumerable: false });
  return out;
}

export function createDocument(options = {}) {
  const doc = new Node("#document");
  documentNode = doc;
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
  // Everything a browser charges the main thread for, in one place: a benchmark
  // reads these per frame to find where a stand-in costs more than it saves.
  doc._counts = {
    elements: 0,
    attrWrites: 0,
    attrRewrites: 0,
    attrReads: 0,
    attrWriteBy: {},
    rects: 0,
    qsa: 0,
    qsaBy: {},
    gcs: 0,
  };
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
  // The page's own font loading state, as a browser exposes it. The tool reads it
  // before it photographs a node: while the page's font is still loading, the
  // element's computed font stack is the fallback, and a picture drawn with it would
  // keep the wrong font for the session. A test sets `status` to model both states.
  doc.fonts = {
    status: "loaded",
    ready: Promise.resolve(),
    check: () => true,
    addEventListener: () => {},
    removeEventListener: () => {},
  };
  doc.execCommand = () => true;
  // Counted, so a test can hold the tracker to "the page is discovered on a
  // budget, not per frame": a pan must not re-walk the DOM.
  const baseQsa = Node.prototype.querySelectorAll;
  doc._qsaCalls = 0;
  doc._qsaUnsupported = []; // selectors the shim's grammar could not express
  doc.querySelectorAll = function (selector) {
    doc._qsaCalls++;
    return baseQsa.call(this, selector);
  };
  return doc;
}

// ---------------------------------------------------------------- observers ---
// The two browser observers the tracker uses to learn that a node element changed,
// so it does not have to read layout on a timer to find out. Tests opt in: with no
// observers on the page the tracker falls back to the periodic read, which is what
// most of the suite exercises. With them, a mutation inside an observed subtree or
// a new box on an observed element reports itself, exactly as in the browser.
const mutationObservers = new Set();
const resizeObservers = new Set();

// A pane transform (a pan, a zoom) moves and scales every element inside it by the
// same factor, and a real ResizeObserver does not fire for that: it watches the
// element's own box, which a transform does not change. So the harness lays out its
// fixture inside `withQuiet`, and an element whose box really changed announces it.
let quiet = 0;
export function withQuiet(fn) {
  quiet++;
  try {
    return fn();
  } finally {
    quiet--;
  }
}

function observedBy(obs, target, subtree) {
  for (const t of obs._targets) {
    if (t === target) return true;
    if (!subtree && !obs._subtree) continue;
    let n = target;
    while (n) {
      if (n === t) return true;
      n = n.parentNode;
    }
  }
  return false;
}

// A childList report, with the nodes that arrived and left — what a browser's
// MutationRecord carries, so a listener can act on the *added* subtree instead of
// scanning. Both lists are always present (a report with no nodes added is a real
// report); a caller that wants the shape of an implementation which omits them can
// call this with no nodes at all.
export function fireMutation(target, added, removed) {
  if (quiet || !mutationObservers.size || !target) return;
  const entry = {
    target,
    type: "childList",
    addedNodes: added ? [added] : [],
    removedNodes: removed ? [removed] : [],
  };
  for (const o of [...mutationObservers]) {
    if (observedBy(o, target, true)) o._deliver([entry]);
  }
}

export function fireResize(target) {
  if (quiet || !resizeObservers.size || !target) return;
  for (const o of [...resizeObservers]) {
    if (observedBy(o, target, false)) o._deliver([{ target, type: "resize", contentRect: target.getBoundingClientRect() }]);
  }
}

class MutationObserverShim {
  constructor(cb) {
    this._cb = cb;
    this._targets = [];
    this._subtree = false;
  }
  observe(target, options) {
    if (options && options.subtree) this._subtree = true;
    if (!this._targets.includes(target)) this._targets.push(target);
    mutationObservers.add(this);
  }
  unobserve(target) {
    this._targets = this._targets.filter((t) => t !== target);
    if (!this._targets.length) mutationObservers.delete(this);
  }
  disconnect() {
    this._targets = [];
    mutationObservers.delete(this);
  }
  takeRecords() {
    return [];
  }
  _deliver(entries) {
    try {
      this._cb(entries, this);
    } catch (e) {
      /* a page observer that throws does not break the DOM op that reported */
    }
  }
}

class ResizeObserverShim {
  constructor(cb) {
    this._cb = cb;
    this._targets = [];
  }
  observe(target) {
    if (!this._targets.includes(target)) this._targets.push(target);
    resizeObservers.add(this);
  }
  unobserve(target) {
    this._targets = this._targets.filter((t) => t !== target);
    if (!this._targets.length) resizeObservers.delete(this);
  }
  disconnect() {
    this._targets = [];
    resizeObservers.delete(this);
  }
  _deliver(entries) {
    try {
      this._cb(entries, this);
    } catch (e) {
      /* ditto */
    }
  }
}

export function observerClasses() {
  return { MutationObserver: MutationObserverShim, ResizeObserver: ResizeObserverShim };
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
