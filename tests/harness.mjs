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
  const document = createDocument();
  const localStorage = createStorage();
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
    graph: { _nodes: [], links: new Map() },
  };

  class FakeLGraphCanvas {
    constructor() {
      this.ds = { offset: new Float32Array([0, 0]), scale: 1 };
      this.canvas = { width: 1600, height: 900 };
      this.nodes = [];
      // Per-frame costs in ms, tunable per test.
      this.costs = { background: 0.3, connections: 1.5, chrome: 0.25 };
      this.drawCalls = 0;
      this.dirtyCalls = 0;
      this.ctx = {};
    }
    drawConnections() {
      busy(this.costs.connections);
    }
    drawNode(node) {
      busy(this.costs.chrome);
      if (node && typeof node.onDrawForeground === "function") node.onDrawForeground(this.ctx);
      if (node && typeof node.onDrawBackground === "function") node.onDrawBackground(this.ctx);
    }
    draw() {
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
  app.canvas = canvas;

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
  vm.createContext(sandbox);

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
    function NodeType() {
      this.type = name;
      this.comfyClass = name;
      this.mode = 0;
      this.visible = true;
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
    addResource,
    panel,
    textOf,
  };
}
