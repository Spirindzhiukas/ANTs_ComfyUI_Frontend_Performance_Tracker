// Test harness: a fake browser + fake ComfyUI/LiteGraph that web/tracker.js can
// be loaded into unmodified, with a controllable clock so multi-second windows
// can be simulated instantly and deterministically.
//
// Nothing in here is imported by the tracker; it only provides the globals the
// tracker expects, so a missing global shows up as a test failure rather than
// being papered over.

import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { computedStyle, createDocument, createStorage, fireMutation, fireResize, observerClasses, withQuiet } from "./dom-shim.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
// The tracker under test. `ANTS_TRACKER` points the same suite at a copy of the
// file — which is how the mutation battery asks "would these tests notice if this
// line were wrong?" without touching the tree under test.
const TRACKER_PATH = process.env.ANTS_TRACKER || path.join(HERE, "..", "web", "tracker.js");
export const FRAME_MS = 1000 / 60;

export function createHarness(options = {}) {
  const opts = Object.assign({ loaf: true, memory: true, resources: true }, options);

  // ---------------------------------------------------------------- clock --
  const clock = { now: 1000, timers: [], nextId: 1 };
  const timerById = (id) => clock.timers.find((t) => t.id === id);
  const clear = (id) => {
    const i = clock.timers.findIndex((t) => t.id === id);
    if (i >= 0) clock.timers.splice(i, 1);
  };
  const schedule = (fn, delay, interval) => {
    const t = { id: clock.nextId++, at: clock.now + Math.max(0, Number(delay) || 0), fn, interval };
    clock.timers.push(t);
    return t.id;
  };
  const setTimeoutFake = (fn, delay) => schedule(fn, delay, null);
  const setIntervalFake = (fn, delay) => schedule(fn, delay, Math.max(1, Number(delay) || 1));
  // requestAnimationFrame: one callback per display frame, driven by the clock.
  const rafQueue = [];
  const requestAnimationFrameFake = (cb) => {
    const id = schedule(() => {
      rafQueue.splice(rafQueue.indexOf(id), 1);
      cb(clock.now);
    }, FRAME_MS, null);
    rafQueue.push(id);
    return id;
  };
  const cancelAnimationFrameFake = (id) => clear(id);

  function advance(ms) {
    const target = clock.now + ms;
    let guard = 0;
    for (;;) {
      let due = null;
      for (const t of clock.timers) {
        if (t.at > target) continue;
        if (!due || t.at < due.at || (t.at === due.at && t.id < due.id)) due = t;
      }
      if (!due) break;
      if (++guard > 200000) throw new Error("timer runaway — a test scheduled an infinite loop");
      clock.now = due.at;
      if (due.interval) due.at = clock.now + due.interval;
      else clear(due.id);
      due.fn();
    }
    clock.now = target;
  }

  // Simulated synchronous work: advances the clock, so performance.now() deltas
  // inside the tracker are exactly the costs the test asked for.
  const busy = (ms) => {
    clock.now += ms;
  };

  // ------------------------------------------------------------ perf API ---
  const resourceEntries = [];
  const performanceShim = {
    now: () => clock.now,
    getEntriesByType: (type) => (type === "resource" && opts.resources ? resourceEntries.slice() : []),
    setResourceTimingBufferSize: () => {},
    timeOrigin: 0,
  };
  if (opts.memory) {
    performanceShim.memory = { usedJSHeapSize: 40 * 1024 * 1024, totalJSHeapSize: 80 * 1024 * 1024, jsHeapSizeLimit: 2048 * 1024 * 1024 };
  }

  const observers = [];
  class PerformanceObserverShim {
    constructor(cb) {
      this._cb = cb;
    }
    observe(config) {
      const type = config && config.type;
      if (type === "long-animation-frame" && !opts.loaf) throw new TypeError("unsupported entry type");
      if (type === "longtask" && opts.loaf) throw new TypeError("longtask is superseded in this fake browser");
      this._type = type;
      observers.push(this);
    }
    disconnect() {
      const i = observers.indexOf(this);
      if (i >= 0) observers.splice(i, 1);
    }
  }
  const emitPerformance = (type, entries) => {
    for (const obs of observers.slice()) {
      if (obs._type !== type) continue;
      obs._cb({ getEntries: () => entries });
    }
  };

  // ---------------------------------------------------------------- DOM ----
  const document = createDocument({ ctxFactory: () => makeStubCtx() });
  const localStorage = opts.storage || createStorage();
  const clipboardWrites = [];
  const navigatorShim = {
    userAgent: "Mozilla/5.0 (TestBrowser) Chrome/130.0.0.0 Safari/537.36",
    hardwareConcurrency: 16,
    clipboard: {
      writeText: async (text) => {
        clipboardWrites.push(text);
      },
    },
  };
  const windowShim = {
    innerWidth: 1920,
    innerHeight: 1080,
    devicePixelRatio: 1.5,
    listeners: new Map(),
    addEventListener(type, fn) {
      if (!this.listeners.has(type)) this.listeners.set(type, []);
      this.listeners.get(type).push(fn);
    },
    removeEventListener(type, fn) {
      const list = this.listeners.get(type);
      if (!list) return;
      const i = list.indexOf(fn);
      if (i >= 0) list.splice(i, 1);
    },
    fire(type, props) {
      for (const fn of (this.listeners.get(type) || []).slice()) {
        fn(Object.assign({ type, preventDefault() {}, stopPropagation() {} }, props || {}));
      }
    },
  };

  // ---------------------------------------------------------- fake ComfyUI --
  const consoleCalls = [];
  const fakeConsole = {
    log: (...a) => consoleCalls.push(["log", a.join(" ")]),
    info: (...a) => consoleCalls.push(["info", a.join(" ")]),
    warn: (...a) => consoleCalls.push(["warn", a.join(" ")]),
    error: (...a) => { consoleCalls.push(["error", a.map((x) => (x && x.message) || String(x)).join(" ")]); if (process.env.ANTS_TRACE) for (const x of a) if (x && x.stack) console.log("STACK>\n" + x.stack); },
    debug: () => {},
  };

  const app = {
    extensions: [],
    registerExtension(ext) {
      this.extensions.push(ext);
      return Promise.resolve();
    },
    graph: null, // installed below: the fake graph class, so the hit-test gate has a seam
  };

  // A 2D context stub that records the calls a draw path made: enough to tell a
  // cheap rectangle from LiteGraph's own chrome, a straight line from a bezier
  // spline, and a full-size image from a thumbnail. It is a real class on
  // purpose: the tracker patches CanvasRenderingContext2D.prototype.drawImage,
  // which is also how a browser exposes it.
  class FakeCanvasRenderingContext2D {
    constructor(ink) {
      this.ops = [];
      this.ink = ink !== false; // opaque pixels unless a test asks for a blank draw
      this.globalAlpha = 1;
      // Every drawing call with the paint state it ran under: a picture's colours,
      // its transparency and its fonts are things a test has to be able to see, and
      // the ops list itself stays the shape every older assertion expects.
      this.paintLog = [];
      this.shadowColor = "";
      this.fillStyle = "";
      this.strokeStyle = "";
      this.lineWidth = 1;
      this.font = "";
    }
    drawImage(...args) {
      const rec = ["drawImage", ...args];
      // A copy of another canvas can say whether that canvas already held a
      // deferred image draw. The stamp is set by the test, not by the tracker.
      const src = args[0];
      if (src && src._ctx && src._ctx.__antsImage) rec.imageReady = true;
      this.ops.push(rec);
    }
    // The same approximation lodSnapMeasureText falls back to, parsed from the
    // current font, so wrapping is deterministic in both branches.
    measureText(text) {
      const m = /(\d+(?:\.\d+)?)px/.exec(this.font || "");
      const size = m ? Number(m[1]) : 14;
      return { width: String(text).length * size * 0.55 };
    }
    getImageData(x, y, w, h) {
      // What the snapshot engine's ink probe reads. Opaque by default, so the
      // probe's happy path runs in every test that captures anything; a test can
      // boot with { ink: "none" } to make every capture look blank.
      const data = new Uint8ClampedArray(w * h * 4);
      if (this.ink) data.fill(255);
      return { data, width: w, height: h };
    }
  }
  for (const name of [
    "fillRect",
    "setTransform",
    "strokeRect",
    "beginPath",
    "moveTo",
    "lineTo",
    "closePath",
    "bezierCurveTo",
    "arc",
    "rect",
    "roundRect",
    "clip",
    "fill",
    "stroke",
    "save",
    "restore",
    "translate",
    "scale",
    "clearRect",
    // The DOM-widget composite paints a text widget's value; the ops list is how
    // a test sees that it reached the picture.
  ]) {
    FakeCanvasRenderingContext2D.prototype[name] = function (...args) {
      this.ops.push([name, ...args]);
      if (this.paintLog) this.paintLog.push({ op: name, fill: this.fillStyle, alpha: this.globalAlpha, font: this.font });
    };
  }
  // `fillText` records the font and the paint colour that were current when it ran:
  // a picture's text is only the node's text if it was drawn in the node's own font
  // and colour, and both are things a test has to be able to see. They land in slots
  // 5 and 6, after the string and its position — every older assertion reads 0..3.
  FakeCanvasRenderingContext2D.prototype.fillText = function (text, x, y, ...rest) {
    this.ops.push(["fillText", text, x, y, ...rest, this.font || "", this.fillStyle || ""]);
    if (this.paintLog) this.paintLog.push({ op: "fillText", text, fill: this.fillStyle, alpha: this.globalAlpha, font: this.font });
  };
  const makeStubCtx = () => new FakeCanvasRenderingContext2D(opts.ink !== "none");

  // `Path2D` is the one route icon geometry has to the canvas: the frontend's
  // iconify plugin compiles an icon to a masked element, so a stand-in that wants
  // the glyph builds its path from the SVG the page's own CSS carries and hands it
  // to `fill`/`stroke`. The shim keeps the path data so a test can say *what* was
  // drawn, not merely that something was; a browser's `Path2D` ignores path data it
  // cannot parse (an empty path, no throw), which is what this does too.
  class Path2DShim {
    constructor(d) {
      this.d = d == null ? "" : String(d);
      this._ops = [this.d];
    }
    addPath(p) {
      if (p && p.d) this._ops.push(p.d);
    }
  }

  // createImageBitmap with the resize options, recording what was asked for.
  // A blob that came out of this document's own canvas carries the canvas it came
  // from, so the disk round trip (canvas -> toBlob -> PUT -> GET -> blob ->
  // createImageBitmap -> canvas) can be exercised end to end in a test: the
  // pixels are not re-encoded here, but the dimensions — which is what the
  // capture ratio, the mip chain and the budget are all decided from — are real.
  const imageBitmaps = [];
  function createImageBitmapStub(img, opts) {
    const optsObj = opts || {};
    const from = img && img.__antsCanvasNode;
    const w = Number(optsObj.resizeWidth) || Number(from && from.width) || Number(img && (img.naturalWidth || img.width)) || 0;
    const h = Number(optsObj.resizeHeight) || Number(from && from.height) || Number(img && (img.naturalHeight || img.height)) || 0;
    imageBitmaps.push({ src: img, width: w, height: h, quality: optsObj.resizeQuality || null });
    return Promise.resolve({ width: w, height: h, close() {}, __antsThumbOf: img });
  }

  // The graph class. The frontend's only node hit-test entry point is
  // LGraph.getNodeOnPos (LGraphCanvas calls it per pointer event), and that is
  // where the tracker's focus mode gates it — so the fake has to have it.
  // A node class with the two seams the frontend actually uses to decide whether a
  // widget answers the pointer: `getWidgetOnPos` for the widgets drawn on the
  // canvas, and the mouse hooks a 3D viewport hangs its "is the pointer over me"
  // flag on. Instances are what `h.node()` hands out.
  class FakeLGraphNode {
    constructor(opts = {}) {
      this.type = opts.type || "KSampler";
      this.pos = opts.pos ? [...opts.pos] : [0, 0];
      this.size = opts.size ? [...opts.size] : [200, 100];
      this.selected = false;
      this.widgets = opts.widgets || [];
      this.mouseOver = null;
      this.enters = 0;
      this.leaves = 0;
      this.moves = 0;
    }
    // The canvas widget API, as far as a test needs it: a widget with a position
    // whose hit-test is arithmetic, and the callback a click would run.
    addWidget(type, name, value, callback, options) {
      const widget = { type, name, value, callback, options: options || {}, last_y: this.widgets.length * 22, computedHeight: 20 };
      this.widgets.push(widget);
      return widget;
    }
    // The DOM widget API: the frontend renders a positioned wrapper into its layer
    // and puts the element inside it. This mirrors that structure, because that
    // structure is what a low-zoom sweep has to walk past.
    addDOMWidget(name, type, element, options) {
      let layer = document.querySelectorAll('[data-testid="dom-widgets"]')[0] || null;
      if (!layer) {
        layer = document.createElement("div");
        layer.className = "isolate";
        layer._attrs["data-testid"] = "dom-widgets";
        document.body.appendChild(layer);
      }
      const wrapper = document.createElement("div");
      wrapper.className = "dom-widget size-full";
      wrapper.appendChild(element);
      layer.appendChild(wrapper);
      // The row this widget occupies, in node units: `DomWidgets.vue` positions
      // the wrapper at `node.pos + margin` and sizes it from these two fields
      // (`widget.width ?? node.width`, `widget.computedHeight ?? 50`), so a test
      // that cares where the content lands sets them the way a real widget does.
      const opts = options || {};
      const widget = {
        name,
        type,
        element,
        options: opts,
        node: this,
        wrapper,
        y: Number(opts.y) || 0,
        computedHeight: opts.computedHeight != null ? Number(opts.computedHeight) : 50,
        margin: opts.margin != null ? Number(opts.margin) : 10,
        width: opts.width != null ? Number(opts.width) : undefined,
      };
      this.widgets.push(widget);
      this._domWidgets = this._domWidgets || [];
      this._domWidgets.push(widget);
      return widget;
    }
    getWidgetOnPos(x, y) {
      const nx = Number(this.pos[0]) || 0;
      const ny = Number(this.pos[1]) || 0;
      const w = Math.abs(Number(this.size[0])) || 0;
      for (const widget of this.widgets || []) {
        if (widget.last_y === undefined) continue;
        const top = ny + widget.last_y;
        const height = Number(widget.computedHeight) || 20;
        if (x >= nx && x <= nx + w && y >= top && y <= top + height) return widget;
      }
      return undefined;
    }
    onMouseEnter() {
      this.enters++;
    }
    onMouseLeave() {
      this.leaves++;
    }
    onMouseMove() {
      this.moves++;
    }
    isPointInside(x, y) {
      const nx = Number(this.pos[0]) || 0;
      const ny = Number(this.pos[1]) || 0;
      const w = Math.abs(Number(this.size[0])) || 0;
      const hh = Math.abs(Number(this.size[1])) || 0;
      return x >= nx && x <= nx + w && y >= ny && y <= ny + hh;
    }
  }

  class FakeLGraph {
    constructor() {
      this._nodes = [];
      this.links = new Map();
      this.hitTests = 0;
    }
    getNodeOnPos(x, y, nodeList) {
      this.hitTests++;
      const nodes = nodeList && nodeList.length ? nodeList : this._nodes;
      for (let i = nodes.length - 1; i >= 0; i--) {
        const node = nodes[i];
        const size = node.size || node.renderingSize;
        if (!size) continue;
        const w = Math.abs(Number(size[0])) || 0;
        const hh = Math.abs(Number(size[1])) || 0;
        const nx = Number(node.pos && node.pos[0]) || 0;
        const ny = Number(node.pos && node.pos[1]) || 0;
        if (x >= nx && x <= nx + w && y >= ny && y <= ny + hh) return node;
      }
      return null;
    }
  }

  class FakeLGraphCanvas {
    constructor() {
      this.ds = { offset: new Float32Array([0, 0]), scale: 1 };
      // The canvas element: `width`/`height` are the backing store (device
      // pixels) and clientWidth/clientHeight its CSS box. They are equal here,
      // which is a 100% display; a test that wants a Windows display scale sets
      // width/height to a multiple and devicePixelRatio alongside it.
      this.canvas = { width: 1600, height: 900, clientWidth: 1600, clientHeight: 900 };
      this.nodes = [];
      this.links = [];
      this.nodeDraws = 0;
      this.linkDraws = 0;
      // Per-frame costs in ms, tunable per test.
      this.costs = { background: 0.3, connections: 1.5, chrome: 0.25, link: 0.05 };
      this.drawCalls = 0;
      this.dirtyCalls = 0;
      this.ctx = makeStubCtx();
      // What the frontend computes each drawn frame: the graph-space area on
      // screen. The visible-node set the tracker reads for focus mode is this
      // in production; here it is derived the same way, from the viewport.
      this.visible_area = [0, 0, 1600, 900];
      this.recomputeVisibleArea();
      // The frontend's own canvas fields, so a wrapper that changes them for the
      // duration of one call can be caught doing it (and caught putting it back).
      this.connections_width = 3;
      this.render_connections_border = true;
      // LiteGraph's own flag (LGraphCanvas.render_shadows, true by default): the
      // node-snapshot capture compares it at reuse time, because another extension
      // can flip it for the duration of a gesture.
      this.render_shadows = true;
      this._isLowQuality = false;
      this.linkSettings = []; // what each link was rendered with
      this.nodeLowQuality = []; // what the canvas flag was for each node draw
    }
    // What the real DragAndScale.computeVisibleArea does on every drawn frame:
    // the area is the canvas's CSS box divided by the draw scale, offset by the
    // pan. The width/height of the element are device pixels, so the CSS box is
    // what the maths uses — a test that wants a display scale sets
    // canvas.width/clientWidth apart and devicePixelRatio with them.
    recomputeVisibleArea() {
      const scale = Number(this.ds.scale) || 1;
      const css = this.canvas.clientWidth || this.canvas.width;
      const cssH = this.canvas.clientHeight || this.canvas.height;
      this.visible_area = [-(Number(this.ds.offset[0]) || 0), -(Number(this.ds.offset[1]) || 0), css / scale, cssH / scale];
      if (this.ds) this.ds.visible_area = this.visible_area;
      return this.visible_area;
    }
    // What the canvas does on mousemove: find the node through the graph, tell it
    // the mouse entered (once), call its move hook, and report the widget under
    // the cursor — the same order LGraphCanvas.processMouseMove uses.
    hover(x, y) {
      const graph = this.graph;
      const node = graph && typeof graph.getNodeOnPos === "function" ? graph.getNodeOnPos(x, y) : null;
      if (!node) return null;
      if (!node.mouseOver) {
        node.mouseOver = {};
        this.node_over = node;
        if (typeof node.onMouseEnter === "function") node.onMouseEnter(null);
      }
      if (typeof node.onMouseMove === "function") node.onMouseMove(null, [x, y], this);
      return typeof node.getWidgetOnPos === "function" ? node.getWidgetOnPos(x, y, true) : undefined;
    }
    drawConnections() {
      busy(this.costs.connections);
      for (const link of this.links) {
        this.renderLink(this.ctx, link.from, link.to, link, false, 0, link.color, 0, 0, {});
      }
    }
    renderLink(ctx, a, b) {
      this.linkDraws++;
      this.linkSettings.push({
        width: this.connections_width,
        border: this.render_connections_border,
        lowQuality: this._isLowQuality,
      });
      // Ink costs pixels, and pixels cost time: a 1px stroke is cheaper than the
      // 3px one, and a link drawn with its dark outline under it is a second,
      // wider stroke again. Without this the simulation would say every link
      // setting is free, which is the thing the panel exists to measure.
      const widths = 1;
      const ink = this.render_connections_border ? 2.6 : 1;
      busy((this.costs.link || 0) * widths * ink * (this.connections_width / 3));
      ctx.beginPath();
      ctx.moveTo(a[0], a[1]);
      ctx.bezierCurveTo(a[0] + 40, a[1], b[0] - 40, b[1], b[0], b[1]);
      ctx.stroke();
    }
    drawNode(node, ctx) {
      this.nodeDraws++;
      // Nodes 2.0: `LGraphCanvas.drawNode()` returns early when
      // `LiteGraph.vueNodesMode` is set — the node is a DOM element and the
      // canvas draws none of it. The call still happens (the canvas walks its
      // node list), so a wrapper around it still runs; what stops is the work.
      if (LiteGraphShim.vueNodesMode) return;
      this.nodeLowQuality.push(this._isLowQuality);
      busy(this.costs.chrome);
      // LiteGraph draws into the context it was handed. A capture hands its own
      // canvas; ignoring that and always painting this.ctx would hide a picture
      // that only exists on the offscreen surface.
      const target = ctx || this.ctx;
      if (node && typeof node.onDrawForeground === "function") node.onDrawForeground(target);
      if (node && typeof node.onDrawBackground === "function") node.onDrawBackground(target);
    }
    draw() {
      this.recomputeVisibleArea();
      this.drawCalls++;
      busy(this.costs.background);
      this.drawConnections();
      for (const node of this.nodes) this.drawNode(node, this.ctx);
    }
    setDirty() {
      this.dirtyCalls++;
    }
  }
  const canvas = new FakeLGraphCanvas();
  app.graph = new FakeLGraph(); // the graph class, so the hit-test gate has its seam
  canvas.graph = app.graph; // LiteGraph keeps the graph on the canvas, and so does this fake
  app.canvas = canvas;
  canvas.node_over = undefined;

  const LiteGraphShim = { registered_node_types: {}, LGraphCanvas: FakeLGraphCanvas };

  // ---------------------------------------------------------- fetch stub ---
  // Routes are keyed by path (`/ants_optimizer/thumbs/3`), which is what most
  // tests want, or by the whole URL when a test is about the query — the disk
  // cache keys its files by what is in that query, so those tests read the calls
  // out of `fetchUrls` and can serve a blob for one exact key. A route value that
  // is a function is called with `{ url, method, body }` and its return value is
  // used as the response, so a test can play the thumb store's part completely.
  const fetchRoutes = new Map();
  let fetchCalls = 0;
  const fetchUrls = []; // every call, in order: { url, method, body }
  const fetchShim = async (url, init) => {
    fetchCalls++;
    const full = String(url);
    const key = full.split("?")[0];
    const req = { url: full, method: (init && init.method) || "GET", body: init && init.body };
    fetchUrls.push(req);
    let route = fetchRoutes.has(full) ? fetchRoutes.get(full) : fetchRoutes.has(key) ? fetchRoutes.get(key) : undefined;
    if (route === undefined) {
      // A key ending in `*` is a prefix route: one handler for a family of URLs
      // (the thumb store is one route per node id, and a test does not want to
      // register one per id).
      for (const [k, v] of fetchRoutes) {
        if (k.endsWith("*") && key.startsWith(k.slice(0, -1))) {
          route = v;
          break;
        }
      }
    }
    if (typeof route === "function") {
      const res = route(req);
      if (res !== undefined) return res;
    } else if (route && route.__blob) {
      return { ok: true, status: 200, json: async () => ({}), blob: async () => route.__blob };
    } else if (route !== undefined) {
      return { ok: true, status: 200, json: async () => route };
    }
    return { ok: false, status: 404, json: async () => ({}), blob: async () => null };
  };

  // ------------------------------------------------------------- sandbox ---
  const sandbox = {
    __ants: { app },
    document,
    window: windowShim,
    navigator: navigatorShim,
    localStorage,
    performance: performanceShim,
    console: fakeConsole,
    setTimeout: setTimeoutFake,
    clearTimeout: clear,
    setInterval: setIntervalFake,
    clearInterval: clear,
    requestAnimationFrame: requestAnimationFrameFake,
    cancelAnimationFrame: cancelAnimationFrameFake,
    PerformanceObserver: PerformanceObserverShim,
    fetch: fetchShim,
    Error,
    Math,
    Date,
    JSON,
    Promise,
    Object,
    Array,
    Number,
    String,
    Boolean,
    Set,
    Map,
    Float64Array,
    Float32Array,
    isNaN,
    isFinite,
    parseInt,
    parseFloat,
    decodeURIComponent,
    encodeURIComponent,
    queueMicrotask,
    globalThis: null,
  };
  sandbox.globalThis = sandbox;
  sandbox.globalThis.LiteGraph = LiteGraphShim;
  sandbox.window.LiteGraph = LiteGraphShim;
  sandbox.CanvasRenderingContext2D = FakeCanvasRenderingContext2D;
  sandbox.window.CanvasRenderingContext2D = FakeCanvasRenderingContext2D;
  // The page's own computed style: the tracker reads two things from it (whether a
  // marked element is really off, and the font/colour of text it re-paints).
  sandbox.getComputedStyle = (el) => computedStyle(el);
  sandbox.window.getComputedStyle = (el) => computedStyle(el);
  sandbox.Path2D = Path2DShim;
  sandbox.window.Path2D = Path2DShim;
  sandbox.createImageBitmap = createImageBitmapStub;
  sandbox.window.createImageBitmap = createImageBitmapStub;
  // The two observers a real page has, so the tracker can watch the node elements
  // instead of re-measuring them on a timer. On by default (a browser always has
  // them); a test that wants the fallback path switches them off.
  const observerShims = observerClasses();
  const setDomObservers = (on) => {
    for (const k of ["ResizeObserver", "MutationObserver"]) {
      if (on) {
        sandbox[k] = observerShims[k];
        sandbox.window[k] = observerShims[k];
      } else {
        delete sandbox[k];
        delete sandbox.window[k];
      }
    }
  };
  setDomObservers(true);
  vm.createContext(sandbox);

  // Opt-in: make the fake timer functions behave like Chrome's, which throws
  // "Illegal invocation" when setTimeout/clearTimeout are called with `this` set
  // to anything but the global object. Installed before the tracker runs, so the
  // functions it saves and calls later are the strict ones.
  if (opts.strictTimers) {
    // The context's own global object: a bare `setTimeout(...)` call arrives with
    // this as the receiver, and it is not the same object as the raw sandbox.
    const ctxGlobal = vm.runInContext("globalThis", sandbox);
    const strict = (fn, name) =>
      function strictTimer(...args) {
        if (this !== undefined && this !== ctxGlobal && this !== sandbox) {
          throw new TypeError(`Illegal invocation (${name})`);
        }
        return fn.apply(sandbox, args);
      };
    sandbox.setTimeout = strict(sandbox.setTimeout, "setTimeout");
    sandbox.clearTimeout = strict(sandbox.clearTimeout, "clearTimeout");
    sandbox.setInterval = strict(sandbox.setInterval, "setInterval");
    sandbox.clearInterval = strict(sandbox.clearInterval, "clearInterval");
  }

  const source = fs.readFileSync(TRACKER_PATH, "utf8");
  if (!source.includes('import { app } from "/scripts/app.js";')) {
    throw new Error("web/tracker.js no longer starts from the expected import line — the test loader needs updating");
  }
  const patched = source.replace('import { app } from "/scripts/app.js";', "const { app } = __ants;");
  const script = new vm.Script(patched, { filename: "tracker.js" });
  script.runInContext(sandbox);

  // ------------------------------------------------------------- helpers ---
  function registerExtension(name, hooks) {
    return app.registerExtension(Object.assign({ name }, hooks));
  }

  function registerNodeType(name, protoHooks) {
    // A registered node type in this harness is a FakeLGraphNode with the type
    // fields a real one carries, so the widget seams (canvas widgets, DOM widgets,
    // the mouse hooks) exist on it exactly as on a real node.
    class NodeType extends FakeLGraphNode {
      constructor(opts) {
        super(Object.assign({ type: name }, opts || {}));
        this.type = name;
        this.comfyClass = name;
        this.mode = 0;
        this.visible = true;
      }
    }
    NodeType.type = name;
    NodeType.comfyClass = name;
    NodeType.title = name;
    Object.assign(NodeType.prototype, protoHooks || {});
    LiteGraphShim.registered_node_types[name] = NodeType;
    for (const ext of app.extensions.slice()) {
      if (ext.beforeRegisterNodeDef) ext.beforeRegisterNodeDef(NodeType, { name }, app);
    }
    return NodeType;
  }

  function makeNode(NodeType) {
    const node = new NodeType();
    node.type = NodeType.type || NodeType.comfyClass;
    return node;
  }

  // A node the frontend's own seams apply to: widgets drawn on the canvas
  // (getWidgetOnPos) and the mouse hooks a 3D viewport hangs its hover flag on.
  function node(opts) {
    return new FakeLGraphNode(opts);
  }

  // ------------------------------------------------- Nodes 2.0 (Vue) mode ---
  // The renderer this tool has to survive without painting anything: every node
  // is a DOM element and the canvas draws none of it. Built to the frontend's own
  // shapes, with the source of each one, so this cannot drift from the real page:
  //
  //   * `LiteGraph.vueNodesMode` is set from the `Comfy.VueNodes.Enabled` setting
  //     (useVueFeatureFlags.ts) and `LiteGraph` is put on `window`
  //     (useGlobalLitegraph.ts).
  //   * Each node is `<div class="lg-node absolute" data-node-id="N" tabindex="0">`
  //     positioned by `transform: translate(x, y)` — no left/top
  //     (LGraphNode.vue).
  //   * DOM widgets live in the `[data-testid="dom-widgets"]` layer, one
  //     `.dom-widget` per widget, `position: fixed` with `left`/`top` in client
  //     pixels plus `transform: scale(<zoom>)` (DomWidgets.vue +
  //     useAbsolutePosition({ useTransform: true })).
  //   * The conversion is the frontend's own: client = (graph + offset) * scale
  //     + canvas rect (useCanvasPositionConversion.ts), which is what the
  //     tracker's ownership arithmetic has to invert.
  //
  // `place()` re-positions the wrappers the way the frontend does on every drawn
  // frame, so a test can pan and zoom and then ask what the tracker made of it.
  function enterVueNodes() {
    LiteGraphShim.vueNodesMode = true;
    const container = document.createElement("div");
    container.className = "vue-nodes";
    document.body.appendChild(container);
    // The frontend's own structure (TransformPane.vue): one element carrying the
    // camera transform, every node inside it, and the nodes positioned by their own
    // `translate`. Its computed matrix is how the tool measures the zoom the DOM is
    // really laid out at — the one number a capture cannot take from the canvas,
    // which a capture rewrites to 1.
    const pane = document.createElement("div");
    pane.setAttribute("data-testid", "transform-pane");
    container.appendChild(pane);
    const roots = new Map(); // node id (string) -> element
    const wrappers = new Map(); // widget element -> its .dom-widget wrapper
    const nodes = () => (canvas.nodes && canvas.nodes.length ? canvas.nodes : app.graph._nodes) || [];
    let nextId = 1;
    for (const n of nodes()) {
      if (n.id === undefined || n.id === null || n.id === "") n.id = nextId++;
      const root = document.createElement("div");
      root.className = "lg-node absolute";
      root.setAttribute("data-node-id", String(n.id));
      root.style.transform = `translate(${n.pos[0]}px, ${n.pos[1] - 30}px)`;
      pane.appendChild(root);
      roots.set(String(n.id), root);
    }
    // What the node renders *itself* — the shape ImagePreview.vue has: a
    // container inside the node's own DOM holding the node's images, laid out by
    // the browser, not mounted through a widget. `box` is in node-local units
    // (the same space the canvas draws a node in), which is what the client rect
    // is derived from below.
    const growth = new Map(); // node id -> extra node-local height the frontend adds
    const media = []; // { el, node, box }
    // The structure `LGraphNode.vue` renders inside the node element: the coloured
    // surface, the header bar, the body panel and a row per slot with its
    // connection dot. `box` is *element*-local (y = 0 is the top of the node
    // element, one title bar above the node's own origin), which is the space the
    // browser lays these out in and the space the tool's reader inverts.
    const structure = []; // { el, node, box }
    const addMedia = (node, el, box) => {
      const root = roots.get(String(node.id));
      if (root) root.appendChild(el);
      else container.appendChild(el);
      media.push({ el, node, box: { x: Number(box.x) || 0, y: Number(box.y) || 0, w: Number(box.w) || 0, h: Number(box.h) || 0 } });
      place();
      return el;
    };

    const place = () => withQuiet(() => {
      const scale = Number(canvas.ds.scale) || 1;
      const ox = Number(canvas.ds.offset[0]) || 0;
      const oy = Number(canvas.ds.offset[1]) || 0;
      // The camera transform lives on the pane: `scale3d(z,z,z)
      // translate3d(x,y,0)`, exactly the string useTransformState.ts writes, so the
      // tool's measurement of the DOM zoom is exercised the way the page does it.
      pane.style.transform = `scale3d(${scale}, ${scale}, ${scale}) translate3d(${ox * scale}px, ${oy * scale}px, 0)`;
      let originX = 0;
      let originY = 0;
      try {
        const r = canvas.canvas && typeof canvas.canvas.getBoundingClientRect === "function" ? canvas.canvas.getBoundingClientRect() : null;
        originX = r ? Number(r.left) || 0 : 0;
        originY = r ? Number(r.top) || 0 : 0;
      } catch (e) {
        /* the shim's rect is always 0,0 */
      }
      // The frontend's own conversion: client = (graph + offset) * scale + rect.
      // A node element is placed one title bar above the node's origin, which is
      // exactly what LGraphNode.vue's transform does.
      for (const n of nodes()) {
        const root = roots.get(String(n.id));
        if (root) {
          root._rect = {
            left: (n.pos[0] + ox) * scale + originX,
            top: (n.pos[1] - 30 + oy) * scale + originY,
            width: (Math.abs(Number(n.size && n.size[0])) || 0) * scale,
            // The element LGraphNode.vue renders is the title bar *and* the body:
            // its height is what the tool measures the real rendered box from.
            // `growRoot` adds the frontend's own reserve below that (image nodes
            // are rendered IMAGE_PREVIEW_HEIGHT_RESERVE = 232 px taller than their
            // graph size).
            height: ((Math.abs(Number(n.size && n.size[1])) || 0) + 30 + (growth.get(String(n.id)) || 0)) * scale,
          };
        }
      }
      for (const m of media) {
        const n = m.node;
        const root = roots.get(String(n.id));
        if (!root || !root._rect) continue;
        m.el._rect = {
          left: (n.pos[0] + m.box.x + ox) * scale + originX,
          top: (n.pos[1] + m.box.y + oy) * scale + originY,
          width: m.box.w * scale,
          height: m.box.h * scale,
        };
      }
      for (const s of structure) {
        const n = s.node;
        const root = roots.get(String(n.id));
        if (!root || !root._rect) continue;
        s.el._rect = {
          left: (n.pos[0] + s.box.x + ox) * scale + originX,
          top: (n.pos[1] - 30 + s.box.y + oy) * scale + originY,
          width: s.box.w * scale,
          height: s.box.h * scale,
        };
      }
      for (const n of nodes()) {
        for (const w of n._domWidgets || []) {
          if (!w.wrapper) continue;
          const margin = Number(w.margin) || 10; // BaseDOMWidgetImpl.DEFAULT_MARGIN
          const gx = Number(n.pos[0]) + margin;
          const gy = Number(n.pos[1]) + margin + (Number(w.y) || 0);
          w.wrapper.style.position = "fixed";
          w.wrapper.style.left = `${(gx + ox) * scale + originX}px`;
          w.wrapper.style.top = `${(gy + oy) * scale + originY}px`;
          w.wrapper.style.transform = `scale(${scale})`;
          wrappers.set(w.element, w.wrapper);
        }
      }
    });
    place();
    return {
      container,
      roots,
      wrappers,
      place,
      rootFor: (n) => roots.get(String(n.id)) || null,
      // The frontend's own node structure, so a test can hold the tool to drawing
      // it: everything inside the node element that is not text, not an image and
      // not a widget — the surface, the header, the body panel, the slot dots.
      // Returns the pieces so a test can move one and see the picture follow.
      addStructure: (n, opts = {}) => {
        const root = roots.get(String(n.id));
        if (!root) return null;
        const w = Math.abs(Number(opts.w || (n.size && n.size[0]))) || 200;
        const h = (Math.abs(Number(n.size && n.size[1])) || 100) + 30 + (growth.get(String(n.id)) || 0);
        const inputs = opts.inputs || ["image", "model"];
        const keep = [];
        const put = (el, box) => {
          el._localBox = box;
          structure.push({ el, node: n, box });
          keep.push(el);
          return el;
        };
        const surface = put(document.createElement("div"), { x: 0, y: 0, w, h });
        surface.setAttribute("data-testid", "node-inner-wrapper");
        surface.style.backgroundColor = opts.surface || "rgb(40, 40, 48)";
        surface.style.borderTopWidth = "1px";
        surface.style.borderTopColor = "rgb(18, 18, 22)";
        surface.style.borderTopLeftRadius = "6px";
        root.appendChild(surface);
        const header = put(document.createElement("div"), { x: 0, y: 0, w, h: 30 });
        header.setAttribute("data-testid", `node-header-${n.id}`);
        header.style.backgroundColor = opts.header || "rgb(64, 84, 116)";
        header.appendChild(document.createTextNode(String(opts.title || n.title || n.type || "Node")));
        surface.appendChild(header);
        const body = put(document.createElement("div"), { x: 0, y: 30, w, h: Math.max(0, h - 30) });
        body.setAttribute("data-testid", `node-body-${n.id}`);
        body.style.backgroundColor = opts.body || "rgb(30, 30, 36)";
        surface.appendChild(body);
        const dots = [];
        inputs.forEach((name, i) => {
          const row = put(document.createElement("div"), { x: 0, y: 34 + i * 20, w, h: 20 });
          row.className = "lg-slot lg-slot--input";
          body.appendChild(row);
          const dot = put(document.createElement("div"), { x: 0, y: 34 + i * 20, w: 12, h: 20 });
          dot.className = "slot-dot";
          dot.style.backgroundColor = "rgb(150, 160, 180)";
          row.appendChild(dot);
          const label = put(document.createElement("div"), { x: 12, y: 34 + i * 20, w: w - 12, h: 20 });
          label.appendChild(document.createTextNode(String(name)));
          row.appendChild(label);
          dots.push(dot);
        });
        // One more slot later on, the way a promoted widget or a new input turns
        // up: a dot and nothing else, so a test can move the node's *structure*
        // without moving its text or its size.
        const addDot = (row = 3) => {
          const dot = put(document.createElement("div"), { x: 0, y: 34 + Number(row) * 20, w: 12, h: 20 });
          dot.className = "slot-dot";
          dot.style.backgroundColor = "rgb(150, 160, 180)";
          body.appendChild(dot);
          dots.push(dot);
          place();
          fireMutation(root); // the page reports the new child inside the node
          return dot;
        };
        place();
        // The frontend reported it: a new subtree inside the node is a change, and
        // the observer the tool put on the node's subtree is what says so.
        fireMutation(root);
        return { root, surface, header, body, dots, addDot, keep };
      },
      addMedia,
      media,
      // The frontend lays an image node out taller than its graph size. The tool
      // has to cover the element, so the harness can say so.
      // What the frontend does when it re-creates a node's element: the old one
      // leaves the page and a new one takes its place carrying the same node id (a
      // re-render, or a remount after the pane was torn down and rebuilt). The
      // node's own content moves with it, and the new element is not blanked yet.
      replaceRoot: (n) => {
        const old = roots.get(String(n.id));
        const root = document.createElement("div");
        root.className = "lg-node absolute";
        root.setAttribute("data-node-id", String(n.id));
        root.style.transform = `translate(${n.pos[0]}px, ${n.pos[1] - 30}px)`;
        for (const m of media) if (m.node === n && old && m.el.parentNode === old) root.appendChild(m.el);
        for (const s of structure) if (s.node === n && old && s.el.parentNode === old) root.appendChild(s.el);
        if (old) old.remove();
        pane.appendChild(root);
        roots.set(String(n.id), root);
        place();
        return root;
      },
      growRoot: (n, px) => {
        growth.set(String(n.id), Number(px) || 0);
        place();
        // The element's own box changed (the frontend reserved more room inside the
        // node), which is what a ResizeObserver reports — and what the tool needs to
        // hear, since no frame would otherwise ask for the new height.
        const root = roots.get(String(n.id));
        if (root) fireResize(root);
      },
      // What the frontend does with a widget while its node is off screen
      // (DomWidgets.vue's `isNodeVisible`) — a test can hand it back.
      exit: () => {
        LiteGraphShim.vueNodesMode = false;
        // GraphCanvas.vue renders the whole pane with `v-if`: switching the
        // renderer off *unmounts* every node element — the elements leave the page,
        // they are not merely hidden. That is the state the tool has to clean up
        // after: a mark left on a detached element is a node that comes back
        // invisible if the frontend puts the same element back, and a capture made
        // from a detached element is a picture of nothing. (The shim's
        // `isConnected` answers "in the document", so this is a real detachment.)
        for (const [, root] of roots) root.remove();
        if (container.parentNode) container.parentNode.removeChild(container);
        container.remove();
        for (const m of media) m.el.remove();
      },
    };
  }

  function addResource(url, { startTime = 0, duration = 10, transferSize = 1000, encodedBodySize = 1000 } = {}) {
    resourceEntries.push({ name: url, startTime, duration, transferSize, encodedBodySize, decodedBodySize: encodedBodySize });
  }

  const tracker = sandbox.window.__antsTracker;

  function panel() {
    return document.getElementById("ants-tracker-panel");
  }
  function textOf(node) {
    if (!node) return "";
    return node.descendants()
      .map((n) => (n.children.length ? "" : n.textContent))
      .concat([node.textContent])
      .join(" ");
  }

  async function flush() {
    for (let i = 0; i < 8; i++) await Promise.resolve();
    advance(0);
    for (let i = 0; i < 8; i++) await Promise.resolve();
  }

  return {
    clock,
    advance,
    busy,
    flush,
    FRAME_MS,
    app,
    canvas,
    canvases: document._canvases, // offscreen canvases (node snapshots' bitmaps)
    imageBitmaps,
    LiteGraph: LiteGraphShim,
    document,
    window: windowShim,
    localStorage,
    sandbox,
    tracker,
    observers,
    setDomObservers,
    emitPerformance,
    performanceShim,
    resourceEntries,
    clipboardWrites,
    consoleCalls,
    warnings: () => consoleCalls.filter(([lvl]) => lvl === "warn").map(([, msg]) => msg),
    errors: () => consoleCalls.filter(([lvl]) => lvl === "error").map(([, msg]) => msg),
    infos: () => consoleCalls.filter(([lvl]) => lvl === "info").map(([, msg]) => msg),
    // A DOM change, reported the way the page reports it — with the nodes that
    // arrived, or, called with nothing, the way an implementation that omits them
    // would (a listener that only sweeps has to cope with both).
    fireMutation: (target, added, removed) => fireMutation(target, added, removed),
    // Runs `fn` with every observer report suppressed: what the fixture does to set
    // a scene up is not a change the page would report.
    withQuiet: (fn) => withQuiet(fn),
    fetchRoutes,
    fetchCalls: () => fetchCalls,
    fetchUrls: () => fetchUrls.slice(),
    registerExtension,
    registerNodeType,
    makeNode,
    node,
    enterVueNodes,
    get rectReads() {
      return document._rectReads || 0;
    },
    // The per-document operations a browser would charge for (see dom-shim.mjs):
    // a benchmark diffs these to price a frame.
    get ops() {
      return document._counts;
    },
    addResource,
    panel,
    textOf,
  };
}
