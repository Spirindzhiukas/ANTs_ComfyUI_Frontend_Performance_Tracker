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
import { createDocument, createStorage } from "./dom-shim.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TRACKER_PATH = path.join(HERE, "..", "web", "tracker.js");
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
    constructor() {
      this.ops = [];
      this.globalAlpha = 1;
      this.shadowColor = "";
      this.fillStyle = "";
      this.strokeStyle = "";
      this.lineWidth = 1;
      this.font = "";
    }
    drawImage(...args) {
      this.ops.push(["drawImage", ...args]);
    }
  }
  for (const name of [
    "fillRect",
    "setTransform",
    "strokeRect",
    "beginPath",
    "moveTo",
    "lineTo",
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
  ]) {
    FakeCanvasRenderingContext2D.prototype[name] = function (...args) {
      this.ops.push([name, ...args]);
    };
  }
  const makeStubCtx = () => new FakeCanvasRenderingContext2D();

  // createImageBitmap with the resize options, recording what was asked for.
  const imageBitmaps = [];
  function createImageBitmapStub(img, opts) {
    const optsObj = opts || {};
    const w = Number(optsObj.resizeWidth) || Number(img && (img.naturalWidth || img.width)) || 0;
    const h = Number(optsObj.resizeHeight) || Number(img && (img.naturalHeight || img.height)) || 0;
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
      const widget = { name, type, element, options: options || {}, node: this, wrapper };
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
    drawNode(node) {
      this.nodeDraws++;
      this.nodeLowQuality.push(this._isLowQuality);
      busy(this.costs.chrome);
      if (node && typeof node.onDrawForeground === "function") node.onDrawForeground(this.ctx);
      if (node && typeof node.onDrawBackground === "function") node.onDrawBackground(this.ctx);
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
  const fetchRoutes = new Map();
  let fetchCalls = 0;
  const fetchShim = async (url) => {
    fetchCalls++;
    const key = String(url).split("?")[0];
    if (fetchRoutes.has(key)) {
      const body = fetchRoutes.get(key);
      return { ok: true, status: 200, json: async () => body };
    }
    return { ok: false, status: 404, json: async () => ({}) };
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
    globalThis: null,
  };
  sandbox.globalThis = sandbox;
  sandbox.globalThis.LiteGraph = LiteGraphShim;
  sandbox.window.LiteGraph = LiteGraphShim;
  sandbox.CanvasRenderingContext2D = FakeCanvasRenderingContext2D;
  sandbox.window.CanvasRenderingContext2D = FakeCanvasRenderingContext2D;
  sandbox.createImageBitmap = createImageBitmapStub;
  sandbox.window.createImageBitmap = createImageBitmapStub;
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
    emitPerformance,
    performanceShim,
    resourceEntries,
    clipboardWrites,
    consoleCalls,
    warnings: () => consoleCalls.filter(([lvl]) => lvl === "warn").map(([, msg]) => msg),
    errors: () => consoleCalls.filter(([lvl]) => lvl === "error").map(([, msg]) => msg),
    infos: () => consoleCalls.filter(([lvl]) => lvl === "info").map(([, msg]) => msg),
    fetchRoutes,
    fetchCalls: () => fetchCalls,
    registerExtension,
    registerNodeType,
    makeNode,
    node,
    addResource,
    panel,
    textOf,
  };
}
