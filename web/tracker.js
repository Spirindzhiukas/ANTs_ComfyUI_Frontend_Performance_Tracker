// ANTs Nasty Bastards Tracker — frontend profiler for ComfyUI
// ==========================================================
// v2. Answers, in order of how often you need them:
//   1. "How fast is the canvas actually redrawing, and how much of each frame
//      is spent where?"          -> summary bar + Nodes tab frame budget
//   2. "Which extension/node type is burning those frames?"  -> Timing + Nodes
//   3. "What is eating frames that is NOT canvas drawing at all?"
//      (a heartbeat setInterval, layout thrash, GC, a fetch in a loop)
//                                 -> Stalls tab + invalidation table
//   4. "If I muted/skipped this, what would I gain?" -> Mute + scripted
//      pan benchmark (Testing tab), measured as ms-per-frame, not ms-per-4s.
//
// Design rules that this file follows deliberately:
//   * One canvas redraw = one unit of work. Almost every number is expressed
//     per drawn frame ("ms/frame", "% of frame"), or over a real wall-clock
//     rate ("redraws/s"), never as a raw sum over an arbitrary window - that
//     is what made v1's numbers jump 4x with pan speed.
//   * Hook time only counts toward a frame if the hook actually ran inside
//     canvas draw(). Time spent in the same hooks outside a frame is kept in
//     a separate "off-frame" column instead of silently inflating frames.
//   * Buckets are never deleted while a wrapped function still points at them
//     (v1 did, which made extensions vanish permanently after 4s of quiet).
//   * The panel never rebuilds via innerHTML on a timer: rows are keyed and
//     updated in place, so scroll position and expanded rows survive refreshes.
//   * Everything the panel cannot measure is said out loud (see LIMITS at the
//     bottom of this file) rather than guessed at.

import { app } from "/scripts/app.js";

const VERSION = "2.1.8";
const EXT_NAME = "ANTs.NastyBastardsTracker.Core";
const NODE_NAME = "ANTsNastyBastardsTracker";

// --- windows ---------------------------------------------------------------
// Recent-cost window for hooks/node types. Short on purpose: "what is costing
// me frames RIGHT NOW", not a lifetime average that never reflects a fix.
const WINDOW_MS = 4000;
// Frame stats use a longer horizon, because a redraw cap of 1-5 fps (which the
// Testing tab happily offers) puts fewer than 2 frames in 4s.
const FRAME_WINDOW_MS = 10000;
const FRAME_KEEP_MS = 30000;
const MIN_FRAMES_FOR_RATE = 4;
const SWEEP_MS = 1000;
const UI_REFRESH_MS = 500;
const SELF_SAMPLE_MS = 1000; // tracker's own cost accounting

// --- ring buffer sizing ----------------------------------------------------
const RING_CAP_INITIAL = 64;
const RING_CAP_MAX = 4096;
const MAX_CALLERS = 80;
const MAX_STALL_SOURCES = 80;
const STACK_SAMPLES_PER_SEC = 20;
const MAX_LOAF_SAMPLES = 600;

// ---------------------------------------------------------------- utils ----

const warnedOnce = new Set();
function warnOnce(key, msg) {
  if (warnedOnce.has(key)) return;
  warnedOnce.add(key);
  console.warn(`[ANTs Tracker] ${msg}`);
}

function fmtMs(n, digits) {
  if (!Number.isFinite(n)) return "—";
  const d = digits !== undefined ? digits : n >= 10 ? 1 : 2;
  return n.toFixed(d);
}

function fmtBytes(n) {
  if (!Number.isFinite(n) || n < 0) return "—";
  const units = ["B", "KB", "MB", "GB"];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

// Numbers arriving from JSON: a missing field, a string, or NaN must never be
// rendered as a plausible-looking number.
function numOrNull(v) {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function fmtPct(frac) {
  if (!Number.isFinite(frac)) return "—";
  const p = frac * 100;
  return `${p >= 10 ? p.toFixed(0) : p.toFixed(1)}%`;
}

function fmtRate(perSec) {
  if (!Number.isFinite(perSec)) return "—";
  if (perSec === 0) return "0";
  if (perSec < 0.1) return perSec.toFixed(2);
  if (perSec < 10) return perSec.toFixed(1);
  return perSec.toFixed(0);
}

// "/extensions/ComfyUI-Foo/web/js/bar.js" -> "ComfyUI-Foo"
function packFromUrl(url) {
  if (!url) return null;
  const m = String(url).match(/\/extensions\/([^/?#]+)\//);
  return m ? decodeURIComponent(m[1]) : null;
}

function shortUrl(url) {
  if (!url) return "(inline)";
  let s = String(url);
  s = s.replace(/^https?:\/\/[^/]+/, "");
  s = s.replace(/^\/+/, "");
  const parts = s.split("/");
  if (parts.length > 3) s = ".../" + parts.slice(-3).join("/");
  return s.split("?")[0];
}

// ------------------------------------------------------------- ring buffer --
// Fixed-size typed ring. Float64Array means no per-sample object allocation
// and no GC pressure from the profiler itself (v1 pushed 3 objects per hook
// call and shift()ed them, which is both O(n) per call and allocation-heavy).
//
//   sum  - maintained incrementally, valid for the live range
//   n    - live sample count in the ring (NOT the count since some cutoff;
//          use aggregate() for windowed views)
class Ring {
  constructor(initial) {
    this.cap = initial || RING_CAP_INITIAL;
    this.t = new Float64Array(this.cap);
    this.v = new Float64Array(this.cap);
    this.head = 0;
    this.n = 0;
    this.sum = 0;
  }

  get bytes() {
    return this.cap * 16;
  }

  clear() {
    this.head = 0;
    this.n = 0;
    this.sum = 0;
  }

  // index of the i-th oldest live sample (i = 0 -> oldest)
  _idx(i) {
    return (this.head - this.n + i + this.cap * 2) % this.cap;
  }

  _grow() {
    const cap = Math.min(this.cap * 2, RING_CAP_MAX);
    const t = new Float64Array(cap);
    const v = new Float64Array(cap);
    for (let i = 0; i < this.n; i++) {
      const idx = this._idx(i);
      t[i] = this.t[idx];
      v[i] = this.v[idx];
    }
    this.t = t;
    this.v = v;
    this.cap = cap;
    this.head = this.n;
  }

  push(t, v) {
    if (this.n === this.cap) {
      if (this.cap < RING_CAP_MAX) {
        this._grow();
      } else {
        this.sum -= this.v[this.head]; // evicting oldest
      }
    }
    this.t[this.head] = t;
    this.v[this.head] = v;
    this.head = (this.head + 1) % this.cap;
    if (this.n < this.cap) this.n++;
    this.sum += v;
  }

  // Drop samples older than cutoff. Only ever removes from the oldest end.
  trimBefore(cutoff) {
    while (this.n > 0) {
      const idx = this._idx(0);
      if (this.t[idx] >= cutoff) break;
      this.sum -= this.v[idx];
      this.n--;
    }
  }

  lastT() {
    if (!this.n) return NaN;
    return this.t[this._idx(this.n - 1)];
  }

  firstT() {
    if (!this.n) return NaN;
    return this.t[this._idx(0)];
  }

  // Windowed summary. O(n) over the live range; called from panel renders and
  // reports, never from the hot path.
  // quantiles: optional array like [0.95] -> result.q[0]
  aggregate(sinceT, quantiles) {
    const res = {
      n: 0,
      sum: 0,
      mean: 0,
      max: 0,
      min: 0,
      first: NaN,
      last: NaN,
      span: 0,
      q: null,
    };
    if (!this.n) return res;
    const wantQ = !!(quantiles && quantiles.length);
    let scratch = null;
    let scratchN = 0;
    if (wantQ) {
      scratch = getScratch(this.n);
    }
    let max = -Infinity;
    let min = Infinity;
    let n = 0;
    let sum = 0;
    let last = NaN;
    let first = NaN;
    for (let i = this.n - 1; i >= 0; i--) {
      const idx = this._idx(i);
      const t = this.t[idx];
      if (t < sinceT) break;
      const v = this.v[idx];
      if (n === 0) last = t;
      first = t;
      n++;
      sum += v;
      if (v > max) max = v;
      if (v < min) min = v;
      if (scratch) scratch[scratchN++] = v;
    }
    res.n = n;
    res.sum = sum;
    res.mean = n ? sum / n : 0;
    res.max = n ? max : 0;
    res.min = n ? min : 0;
    res.first = first;
    res.last = last;
    res.span = n > 1 ? last - first : 0;
    if (wantQ && n > 0) {
      const slice = scratch.subarray(0, scratchN);
      slice.sort();
      res.q = quantiles.map((q) => slice[Math.min(slice.length - 1, Math.max(0, Math.round(q * (slice.length - 1))))]);
    }
    return res;
  }

  countSince(sinceT) {
    let n = 0;
    for (let i = this.n - 1; i >= 0; i--) {
      if (this.t[this._idx(i)] < sinceT) break;
      n++;
    }
    return n;
  }
}

let scratchBuf = new Float64Array(1024);
function getScratch(need) {
  if (scratchBuf.length < need) {
    let len = scratchBuf.length;
    while (len < need) len *= 2;
    scratchBuf = new Float64Array(len);
  }
  return scratchBuf;
}

// ------------------------------------------------------------ shared state --

function newHookBucket(label, hook, kind) {
  return {
    label, // extension name, or "(pre-existing) NodeType", or "Type · instance hook"
    hook,
    kind: kind || "ext", // "ext" | "type"
    inside: new Ring(), // calls that happened inside canvas draw()
    outside: null, // lazily created Ring for calls outside a frame
    calls: 0, // lifetime calls (inside + outside)
    skipped: 0, // calls skipped because the label is muted
    firstSeen: performance.now(),
  };
}

function newSeries(initial) {
  return new Ring(initial);
}

const S = {
  version: VERSION,
  startedAt: performance.now(),
  paused: false,
  hooks: new Map(), // "label::hook" -> bucket   (never deleted while wrapped)
  nodes: new Map(), // typeName -> {type, series: Ring, calls}
  muted: new Set(), // labels
  everWrapped: new Set(), // "label::hook"
  extSeen: new Set(), // every extension name ever registered
  typeOwners: new Map(), // nodeTypeName -> Set(label)
  scannedTypes: new Set(),
  counters: {
    draws: 0,
    frames: 0,
    capped: 0,
    deferred: 0,
    framesTotal: 0, // lifetime draws (never reset by the window)
    wrappedHooks: 0,
    preTrackedHooks: 0,
    instanceHooks: 0,
    skippedWhileMuted: 0,
    selfMs: 0,
    renderMs: 0,
    renderCount: 0,
    sweepMs: 0,
  },
  // metrics
  frames: newSeries(1024), // (t, total draw ms)
  frameAttr: newSeries(1024), // (t, hook ms attributed inside that frame)
  frameNodeStage: newSeries(512), // (t, sum of drawNode ms inside that frame)
  frameConnStage: newSeries(512), // (t, sum of drawConnections ms inside that frame)
  raf: newSeries(512), // (t, ms since previous rAF callback)
  invalidations: newSeries(2048), // (t, 1) per canvas.setDirty() call
  stalls: newSeries(512), // (t, blocking ms of a stall)
  mem: newSeries(256), // (t, usedJSHeapSize)
  callers: new Map(), // invalidation caller signature -> stats
  stallSources: new Map(), // stall source signature -> stats
  stallCount: 0,
  stallWorstMs: 0,
  renderTicks: 0, // rAF callbacks seen
  lastDrawAt: 0,
  bench: null, // last scripted-pan benchmark result
  benchActive: null,
  env: { loaf: false, longtask: false },
};

// Per-frame accumulators (reset at the end of every wrapped draw()).
let drawDepth = 0;
let hookDepth = 0; // >0 while inside a wrapped hook, so nested hooks count once
let curAttrMs = 0;
let curNodeStageMs = 0;
let curConnStageMs = 0;

let drawThrottleMs = 0; // Testing tab: redraw rate cap (0 = off)
let capTrailingTimer = null;
let lastRealDrawAt = 0;
let syntheticTickMs = 0;
let syntheticTickTimer = null;
let stackSampleTokens = 0;
let lastStackSampleAt = 0;

function nowMs() {
  return performance.now();
}

function labelKey(label, hook) {
  return `${label}::${hook}`;
}

// ============================================================================
// METRICS — everything the panel shows is derived here, from rings only.
// ============================================================================

const selfCost = {
  sweepMs: 0, // tracker bookkeeping cost, ms per second (rolled over each sweep)
  renderMs: 0, // panel render cost, ms per second
  sweepAccum: 0,
  renderAccum: 0,
  lastRolloverAt: performance.now(),
};

// While sampling is paused the panel is supposed to show a FROZEN snapshot, so
// read paths must not age samples out from under it.
function trimIfLive(ring, cutoff) {
  if (!S.paused) ring.trimBefore(cutoff);
}

function frameMetrics() {
  const now = nowMs();
  // trim to the keep-horizon so a long idle doesn't leave stale frames around
  for (const ring of [S.frames, S.frameAttr, S.frameNodeStage, S.frameConnStage]) trimIfLive(ring, now - FRAME_KEEP_MS);

  let win = FRAME_WINDOW_MS;
  let agg = S.frames.aggregate(now - win);
  // Loose caps (5 fps and below, plus a paused/idle canvas) don't produce
  // enough frames in 10s for a rate. Fall back to the full 30s horizon, and
  // report which window was actually used so the number stays honest.
  if (agg.n < MIN_FRAMES_FOR_RATE) {
    const wide = S.frames.aggregate(now - FRAME_KEEP_MS);
    if (wide.n > agg.n) {
      agg = wide;
      win = FRAME_KEEP_MS;
    }
  }
  const a = agg;
  const attr = S.frameAttr.aggregate(now - win);
  const nodeStage = S.frameNodeStage.aggregate(now - win);
  const connStage = S.frameConnStage.aggregate(now - win);

  const mean = a.n ? a.sum / a.n : 0;
  // Rate over the observed span. (n-1) intervals for n samples.
  const fps = a.n > 1 && a.span > 50 ? ((a.n - 1) * 1000) / a.span : NaN;
  const intervalMs = a.n > 1 ? a.span / (a.n - 1) : NaN;

  const attrMsPerFrame = a.n ? attr.sum / a.n : 0;
  const nodeMsPerFrame = a.n ? nodeStage.sum / a.n : 0;
  const connMsPerFrame = a.n ? connStage.sum / a.n : 0;
  // drawNode() includes any wrapped draw hook as a subset; LiteGraph's own
  // chrome/widget/bitmap work is the remainder.
  const chromeMsPerFrame = Math.max(0, nodeMsPerFrame - attrMsPerFrame);
  const otherMsPerFrame = Math.max(0, mean - nodeMsPerFrame - connMsPerFrame);
  const unaccountedMs = Math.max(0, mean - nodeMsPerFrame - connMsPerFrame);

  return {
    ok: a.n > 0,
    n: a.n,
    windowMs: win,
    spanMs: a.span,
    meanFrameMs: mean,
    maxFrameMs: a.max,
    fps,
    intervalMs,
    attrMsPerFrame,
    nodeMsPerFrame,
    connMsPerFrame,
    chromeMsPerFrame,
    otherMsPerFrame,
    unaccountedMs,
    attrShare: mean > 0 ? attrMsPerFrame / mean : 0,
    nodeShare: mean > 0 ? nodeMsPerFrame / mean : 0,
    connShare: mean > 0 ? connMsPerFrame / mean : 0,
    chromeShare: mean > 0 ? chromeMsPerFrame / mean : 0,
    otherShare: mean > 0 ? otherMsPerFrame / mean : 0,
    idle: a.n === 0 || (a.span > 0 ? a.n / (a.span / 1000) < 2 : true),
  };
}

// Frame-time percentiles need their own pass (aggregate() with quantiles),
// kept separate so the cheap path above stays cheap on 2 Hz renders.
function framePercentiles() {
  const now = nowMs();
  const win = FRAME_WINDOW_MS;
  const agg = S.frames.aggregate(now - win, [0.5, 0.95, 0.99]);
  if (!agg.n || !agg.q) return { p50: NaN, p95: NaN, p99: NaN, n: agg.n, windowMs: win };
  return { p50: agg.q[0], p95: agg.q[1], p99: agg.q[2], n: agg.n, windowMs: win };
}

// How often the canvas is (re)drawing relative to the display's own cadence.
// >1 means the canvas paints more than once per displayed frame: pure waste
// that no extension is responsible for on its own.
function rafMetrics() {
  const now = nowMs();
  trimIfLive(S.raf, now - FRAME_KEEP_MS);
  const rafAgg = S.raf.aggregate(now - FRAME_WINDOW_MS);
  const framesInWin = S.frames.countSince(now - Math.max(FRAME_WINDOW_MS, 1000));
  const rafInWin = rafAgg.n;
  const displayHz = rafAgg.n > 2 && rafAgg.span > 0 ? ((rafAgg.n - 1) * 1000) / rafAgg.span : NaN;
  const drawsPerRaf = rafInWin > 0 ? framesInWin / rafInWin : NaN;
  return {
    displayHz,
    rafCount: rafInWin,
    framesInWin,
    drawsPerRaf,
    wastedPerRaf: Number.isFinite(drawsPerRaf) ? Math.max(0, drawsPerRaf - 1) : 0,
  };
}

// ---------------------------------------------------------------------------
// Per-extension (and per-hook) totals, normalized per drawn frame.
// ---------------------------------------------------------------------------
function hookRows() {
  const now = nowMs();
  const framesInWindow = S.frames.countSince(now - WINDOW_MS);
  const windowMeanFrameMs = framesInWindow
    ? S.frames.aggregate(now - WINDOW_MS).sum / framesInWindow
    : 0;

  const byLabel = new Map();
  for (const [key, bucket] of S.hooks.entries()) {
    trimIfLive(bucket.inside, now - WINDOW_MS);
    if (bucket.outside) trimIfLive(bucket.outside, now - WINDOW_MS);
    if (bucket.nested) trimIfLive(bucket.nested, now - WINDOW_MS);
    const insideMs = bucket.inside.sum;
    const insideCalls = bucket.inside.n;
    const outsideMs = bucket.outside ? bucket.outside.sum : 0;
    const outsideCalls = bucket.outside ? bucket.outside.n : 0;
    const nestedCalls = bucket.nested ? bucket.nested.n : 0;
    if (!insideCalls && !outsideCalls && !nestedCalls && !S.muted.has(bucket.label)) continue;

    let row = byLabel.get(bucket.label);
    if (!row) {
      row = {
        label: bucket.label,
        kind: bucket.kind,
        insideMs: 0,
        insideCalls: 0,
        outsideMs: 0,
        outsideCalls: 0,
        nestedCalls: 0,
        skipped: 0,
        lifetimeCalls: 0,
        hooks: [],
        muted: S.muted.has(bucket.label),
        bestMsPerCall: Infinity,
      };
      byLabel.set(bucket.label, row);
    }
    row.insideMs += insideMs;
    row.insideCalls += insideCalls;
    row.outsideMs += outsideMs;
    row.outsideCalls += outsideCalls;
    row.nestedCalls += nestedCalls;
    row.skipped += bucket.skipped;
    row.lifetimeCalls += bucket.calls;
    const msPerCall = insideCalls ? insideMs / insideCalls : NaN;
    row.hooks.push({
      hook: bucket.hook,
      insideMs,
      insideCalls,
      outsideMs,
      outsideCalls,
      nestedCalls,
      msPerCall,
      skipped: bucket.skipped,
      muted: row.muted,
    });
    if (Number.isFinite(msPerCall) && msPerCall < row.bestMsPerCall) row.bestMsPerCall = msPerCall;
  }

  // Muted labels with no live bucket at all (e.g. muted, then the extension
  // stopped drawing entirely) still get a row with an Unmute button, so a mute
  // can never become invisible/unkillable — v1 could lose it completely.
  for (const label of S.muted) {
    if (!byLabel.has(label)) {
      byLabel.set(label, {
        label,
        kind: "ext",
        insideMs: 0,
        insideCalls: 0,
        outsideMs: 0,
        outsideCalls: 0,
        nestedCalls: 0,
        skipped: 0,
        lifetimeCalls: 0,
        hooks: [],
        muted: true,
        bestMsPerCall: NaN,
      });
    }
  }

  const rows = [...byLabel.values()];
  for (const row of rows) {
    row.msPerFrame = framesInWindow > 0 ? row.insideMs / framesInWindow : NaN;
    row.share = windowMeanFrameMs > 0 ? row.msPerFrame / windowMeanFrameMs : NaN;
    // Every invocation counts as a call, nested ones included — the call really
    // happened. Only the milliseconds are owned by the outer hook.
    row.callsPerFrame = framesInWindow > 0 ? (row.insideCalls + row.nestedCalls) / framesInWindow : NaN;
    row.msPerCall = row.insideCalls ? row.insideMs / row.insideCalls : NaN;
    row.hooks.sort((a, b) => b.insideMs - a.insideMs);
  }
  rows.sort((a, b) => (b.msPerFrame || 0) - (a.msPerFrame || 0) || (b.outsideMs || 0) - (a.outsideMs || 0));
  return { rows, framesInWindow, windowMeanFrameMs };
}

function nodeRows() {
  const now = nowMs();
  const framesInWindow = S.frames.countSince(now - WINDOW_MS);
  const rows = [];
  for (const [type, bucket] of S.nodes.entries()) {
    trimIfLive(bucket.series, now - WINDOW_MS);
    if (!bucket.series.n) continue;
    const agg = bucket.series.aggregate(now - WINDOW_MS, [0.95]);
    rows.push({
      type,
      ms: agg.sum,
      calls: agg.n,
      msPerCall: agg.n ? agg.sum / agg.n : NaN,
      p95: agg.q ? agg.q[0] : NaN,
      max: agg.max,
      msPerFrame: framesInWindow > 0 ? agg.sum / framesInWindow : NaN,
      callsPerFrame: framesInWindow > 0 ? agg.n / framesInWindow : NaN,
    });
  }
  rows.sort((a, b) => b.ms - a.ms);
  return rows;
}

// ---------------------------------------------------------------------------
// Canvas invalidations: WHO is asking for a redraw, and how often. This is the
// replacement for v1's "shared tick" GCD guessing game: instead of inferring a
// mystery clock from call counts, we watch the single funnel every redraw
// request goes through (LGraphCanvas.setDirty) and sample its call stack.
// ---------------------------------------------------------------------------
function invalidationMetrics() {
  const now = nowMs();
  trimIfLive(S.invalidations, now - FRAME_KEEP_MS);
  const agg = S.invalidations.aggregate(now - WINDOW_MS);
  const span = agg.span > 0 ? agg.span : WINDOW_MS;
  // Denominator for every "per second" figure: at least one second of
  // observation (so a single request in the first 200ms of page life cannot
  // read as 5,000/s) and at most the window itself.
  const observedMs = Math.max(span, Math.min(WINDOW_MS, Math.max(now - S.startedAt, 1000)));
  const perSec = agg.n ? (agg.n / observedMs) * 1000 : 0;
  // Requests per *displayed* frame is a count ratio, not a rate ratio: it stays
  // honest while the display itself is dropping frames.
  const rafTicks = S.raf ? S.raf.countSince(now - WINDOW_MS) : 0;
  const perRaf = rafTicks > 0 ? agg.n / rafTicks : NaN;

  const cutoff = now - WINDOW_MS;
  const samplesInWindow = S.samples ? S.samples.countSince(cutoff) : 0;
  const sources = [...S.callers.values()]
    .map((c) => {
      const inWindow = c.ring.countSince(cutoff);
      return {
        ...c,
        sampled: inWindow,
        sampledLifetime: c.sampled,
        estPerSec: samplesInWindow > 0 ? (inWindow / samplesInWindow) * perSec : NaN,
        share: samplesInWindow > 0 ? inWindow / samplesInWindow : NaN,
      };
    })
    .filter((c) => c.sampled > 0)
    .sort((a, b) => b.sampled - a.sampled);
  return { perSec, perRaf, samples: agg.n, samplesInWindow, sources };
}

function selfCostMetrics() {
  const uptime = (nowMs() - S.startedAt) / 1000;
  let ringBytes = 0;
  let buckets = 0;
  for (const b of S.hooks.values()) {
    buckets++;
    ringBytes += b.inside.bytes + (b.outside ? b.outside.bytes : 0);
  }
  for (const b of S.nodes.values()) {
    buckets++;
    ringBytes += b.series.bytes;
  }
  ringBytes +=
    S.frames.bytes + S.frameAttr.bytes + S.frameNodeStage.bytes + S.frameConnStage.bytes + S.raf.bytes + S.invalidations.bytes + S.stalls.bytes + S.mem.bytes;
  return {
    uptime,
    buckets,
    ringBytes,
    renderMsPerSec: selfCost.renderMs,
    sweepMsPerSec: selfCost.sweepMs,
    wrappedHooks: S.counters.wrappedHooks,
  };
}

// ============================================================================
// INSTRUMENTATION
// ============================================================================

// --- 1. wrap extension registration so every OTHER extension's draw hooks get
//        tagged with its name ------------------------------------------------

const ORIGINAL_REGISTER = app.registerExtension.bind(app);
let registerPatched = false;

const DRAW_HOOKS = ["onDrawForeground", "onDrawBackground", "onDrawCollapsed", "onBounding"];

function extLabel(extObj) {
  if (extObj && typeof extObj.name === "string" && extObj.name.trim()) return extObj.name.trim();
  return "(unnamed extension)";
}

function wrapHook(fn, label, hookName, kind) {
  if (typeof fn !== "function" || fn.__antsWrapped) return fn;
  // One bucket per (label, hook). The bucket is created once and kept forever:
  // wrapped callbacks hold this reference, so deleting it from S.hooks (as v1
  // did after 4s of quiet) would make every later call land in an orphaned
  // object that the panel can never see again.
  const key = labelKey(label, hookName);
  let bucket = S.hooks.get(key);
  if (!bucket) {
    bucket = newHookBucket(label, hookName, kind || "ext");
    S.hooks.set(key, bucket);
  }
  const wrapped = function (...args) {
    if (S.paused) return fn.apply(this, args); // pause = no timing, behavior unchanged
    if (S.muted.has(label)) {
      bucket.skipped++;
      S.counters.skippedWhileMuted++;
      return undefined; // skip entirely: this is what makes "mute" a real A/B test
    }
    const t0 = performance.now();
    hookDepth++;
    let ret;
    try {
      ret = fn.apply(this, args);
    } finally {
      hookDepth--;
    }
    const dt = performance.now() - t0;
    bucket.calls++;
    if (hookDepth > 0) {
      // Called from inside another wrapped hook — the pattern that produces
      // paired rows on real graphs, where a node's own hook delegates to the
      // (already wrapped) prototype method, or an extension wraps another
      // extension's hook. The outer call's measured time already includes this
      // one, so recording the milliseconds here too made the Timing rows add up
      // to double the frame they describe. Count the call, claim no time.
      if (!bucket.nested) bucket.nested = new Ring();
      bucket.nested.push(t0, 0);
    } else if (drawDepth > 0) {
      // Outermost hook, inside a canvas draw: this is the frame's attributed
      // time. Nested hooks never reach here (see above), so the budget cannot
      // be inflated twice by the same milliseconds.
      bucket.inside.push(t0, dt);
      curAttrMs += dt;
    } else {
      // Called outside canvas draw() — an onExecuted/onConfigure hook, a
      // setInterval, a DOM event. v1 added this to the frame that happened to
      // be in flight, letting "attributed" exceed "frame" and zeroing the
      // unattributed number. Keep it in its own lane.
      if (!bucket.outside) bucket.outside = new Ring();
      bucket.outside.push(t0, dt);
    }
    return ret;
  };
  wrapped.__antsWrapped = true;
  wrapped.__antsOriginal = fn;
  wrapped.__antsLabel = label;
  return wrapped;
}

function noteTypeOwner(nodeTypeName, label) {
  if (!nodeTypeName) return;
  let set = S.typeOwners.get(nodeTypeName);
  if (!set) {
    set = new Set();
    S.typeOwners.set(nodeTypeName, set);
  }
  set.add(label);
}

function instrumentNodeType(nodeType, before, label) {
  if (!nodeType || !nodeType.prototype) return;
  const typeName = nodeType.comfyClass || nodeType.type || (nodeType.title || "").trim();
  for (const hookName of DRAW_HOOKS) {
    const after = nodeType.prototype[hookName];
    if (after && after !== before[hookName] && !after.__antsWrapped) {
      nodeType.prototype[hookName] = wrapHook(after, label, hookName, "ext");
      S.counters.wrappedHooks++;
      S.everWrapped.add(labelKey(label, hookName));
      noteTypeOwner(typeName, label);
    } else if (after && after.__antsWrapped) {
      noteTypeOwner(typeName, label);
    }
  }
}

function patchRegisterExtension() {
  if (registerPatched) return;
  registerPatched = true;
  app.registerExtension = function (extObj) {
    if (!extObj || extObj.name === EXT_NAME) return ORIGINAL_REGISTER(extObj);

    const label = extLabel(extObj);
    S.extSeen.add(label);
    const original = extObj.beforeRegisterNodeDef;
    if (typeof original === "function") {
      extObj.beforeRegisterNodeDef = function (nodeType, nodeData, appRef) {
        const before = {};
        for (const hookName of DRAW_HOOKS) before[hookName] = nodeType.prototype ? nodeType.prototype[hookName] : undefined;
        const result = original.call(this, nodeType, nodeData, appRef);
        try {
          instrumentNodeType(nodeType, before, label);
        } catch (e) {
          warnOnce("instrument-fail", `Could not instrument ${label}: ${e && e.message}`);
        }
        return result;
      };
    }
    return ORIGINAL_REGISTER(extObj);
  };
}

// --- 2. catch hooks that were never routed through beforeRegisterNodeDef -----
// (a) prototypes that already had a draw hook before this tool loaded, and
// (b) per-INSTANCE hooks, e.g. `this.onDrawForeground = ...` set inside
//     onNodeCreated — which is exactly how ComfyUI's own core nodes (Preview
//     Image, etc.) and a lot of extensions draw. v1 attributed neither, so
//     their cost silently landed in "unattributed".
function scanRegisteredTypes() {
  const LG = globalThis.LiteGraph;
  if (!LG || !LG.registered_node_types) return;
  for (const name of Object.keys(LG.registered_node_types)) {
    if (S.scannedTypes.has(name)) continue;
    S.scannedTypes.add(name);
    const nodeType = LG.registered_node_types[name];
    const proto = nodeType && nodeType.prototype;
    if (!proto) continue;
    for (const hookName of DRAW_HOOKS) {
      const fn = proto[hookName];
      if (typeof fn === "function" && !fn.__antsWrapped) {
        proto[hookName] = wrapHook(fn, `(pre-existing) ${name}`, hookName, "type");
        S.counters.preTrackedHooks++;
        S.counters.wrappedHooks++;
        S.everWrapped.add(labelKey(`(pre-existing) ${name}`, hookName));
      }
    }
  }
}

function maybeWrapInstanceHooks(node) {
  if (!node) return;
  const proto = node.constructor && node.constructor.prototype;
  const typeName = node.type || node.comfyClass || "unknown";
  const owners = S.typeOwners.get(typeName);
  const ownerLabel = owners && owners.size ? `${[...owners].join("+")} · instance hook` : `(unattributed) ${typeName} · instance hook`;
  for (const hookName of DRAW_HOOKS) {
    const fn = node[hookName];
    if (typeof fn !== "function" || fn.__antsWrapped) continue;
    if (proto && proto[hookName] === fn) continue; // prototype hook, already wrapped
    node[hookName] = wrapHook(fn, ownerLabel, hookName, "type");
    S.counters.instanceHooks++;
    S.counters.wrappedHooks++;
    S.everWrapped.add(labelKey(ownerLabel, hookName));
  }
}

// --- 3. canvas-level patches: frame total, per-node-type cost, draw stages,
//        and the redraw-request funnel --------------------------------------

// --------------------------------------------------------- low-zoom drawing ---
// The measurement this block exists for: a 1040-node graph at zoom 0.10 spent
// ~235 of every 280ms frame inside drawNode() and drawConnections() and redrew
// several times a second, with the whole graph on screen. Culling cannot help a
// graph that is entirely visible and no timer limit touches a draw, so what is
// left is drawing less per frame:
//   * a node that lands a dozen pixels wide is painted as one flat rectangle
//     instead of LiteGraph's border, gradient, title, slots, widgets and
//     previews;
//   * links are painted as straight lines while most nodes are that small;
//   * and while nobody is touching the page the redraw rate is capped, because
//     the frame nobody is looking at is the cheapest frame on the page.
// All three are opt-in and off by default. Any exception turns the mode back off
// with the reason in the panel: a rendering change this tool cannot explain
// would be worse than a slow frame.
const LOD = {
  minPx: 0, // simplify nodes narrower than this on screen (0 = off)
  idleCapMs: 0, // while untouched, at most one redraw per this many ms (0 = off)
  nodes: 0, // node draws replaced by a rectangle
  links: 0, // link draws replaced by a straight line
  ms: 0, // time spent inside the simplified paths
  capped: 0, // redraws merged away by the idle cap
  error: "",
  baseline: null, // the frame budget as it was when the mode went on
  plan: { links: false, tiny: 0, sampled: 0, total: 0, at: 0 },
  // Preview bitmaps. A 4096px image drawn into a 40px box on screen costs the
  // full-size upload and blit every redraw; past the zoom you set, the draw is
  // served from a cached copy of about the resolution the screen can show.
  thumbZoom: 0.6, // substitute below this zoom (0 = never); 60% by default
  inNode: false, // true only while a node is being drawn
  imgSeen: 0, // drawImage calls for image-shaped sources inside a node
  imgThumb: 0, // served from a cached thumbnail
  imgFull: 0, // drawn full size because the thumbnail was not ready
  imgSkipped: 0, // left alone (small source, or nothing to gain)
  thumbs: null, // WeakMap<source, Map<bucket, record>>
  produced: new WeakSet(), // bitmaps and canvases this ladder made
  thumbQueue: [], // insertion order, for the size cap
  thumbsBuilt: 0,
  thumbBytes: 0,
  thumbFailures: 0,
  zoom: 0,
  // Zoomed-out detail. Past a zoom the user sets, links lose their outline and
  // are stroked 1px wide, and the frontend is put into its own low-quality mode
  // (no node shadows, no rounded corners, and widgets that asked to hide when
  // zoomed out stay hidden). Curves are kept: what changes is how much ink is
  // laid down, not the shape of the link.
  detailZoom: 0.6, // below this zoom detail is reduced (0 = full detail)
  // How links are drawn when the graph is being flattened.
  //   "auto"     — straight lines while most of the graph is rectangles (the
  //                v2.1.4 behaviour, kept as the default so nothing changes for
  //                anyone who never touches it);
  //   "spline"   — never straighten; keep every curve and let the thinning
  //                setting above decide how much ink they use;
  //   "straight" — always straight, for graphs drawn with straight links.
  linkStyle: "auto",
  thinLinks: 0, // link segments stroked thin so far
  lqMissing: false, // the frontend does not expose its low-quality flag
  domMarked: null, // Set of elements we are hiding right now
  domWidgets: null, // Map<widget, original hideOnZoom> for the ones we flipped
  domHidden: 0, // elements hidden because their node is a box
  domNodes: 0, // nodes whose DOM content is hidden
  domStilled: 0, // widgets also taken out of the per-frame layout pass
  sweptZoom: NaN, // the zoom the DOM was last swept at
  sweptPx: -1, // and the threshold
};

// Sizes a node can land at on screen. The upper half of this ladder exists for
// 4K: at zoom 0.10 with 200-unit nodes, "under 32px" catches almost nothing and
// the expensive nodes are still painted in full.
const LOD_MIN_PX = [0, 8, 12, 16, 24, 32, 48, 64, 96, 128, 192, 256];
const LOD_IDLE_CAP_MS = [0, 250, 500, 1000];
const LOD_IDLE_INPUT_MS = 400; // how long one touch keeps the cap lifted
const LOD_LINK_SHARE = 0.6; // "most nodes are tiny" => links can be too
// Zoom levels at which previews may be served from a thumbnail.
const LOD_THUMB_ZOOMS = [0, 1, 0.8, 0.6, 0.4, 0.2];
const LOD_THUMB_LADDER = [64, 128, 256, 512, 1024, 2048]; // longest side, px
const LOD_THUMB_MIN_SRC = 256; // sources smaller than this are not worth copying
const LOD_THUMB_MAX = 48; // thumbnails kept before the oldest is dropped
const LOD_THUMB_MAX_BYTES = 64 * 1024 * 1024; // and a byte budget, because 48 large copies are a lot of memory
// Zoom levels below which links and node detail are reduced.
const LOD_DETAIL_ZOOMS = [0, 1, 0.8, 0.6, 0.4, 0.2];
const LOD_LINK_WIDTH = 1; // graph units; LiteGraph's own default is 3
const LOD_DOM_CLASS = "ants-lod-box"; // elements hidden while their node is a box
const LOD_DOM_SWEEP_MS = 1000; // how often newly added nodes/widgets are picked up
// Link drawing, as a setting rather than a side effect of the node threshold.
const LOD_LINK_STYLES = ["auto", "spline", "straight"];
// Settings survive a reload: they are the user's choice about their own page,
// and re-picking four dropdowns after every ComfyUI restart is not a feature.
const LOD_STORE_KEY = "ants.lowZoom.v1";

function lodOn() {
  return LOD.minPx > 0 || LOD.idleCapMs > 0 || LOD.thumbZoom > 0 || LOD.detailZoom > 0;
}

function lodDetailOn() {
  return LOD.detailZoom > 0 && LOD.zoom > 0 && LOD.zoom < LOD.detailZoom;
}

// Something on screen is being drawn as a rectangle this frame. The plan is
// sampled at the top of the frame, so this is the current frame's answer, not
// last frame's.
// Straight links are a *drawing* choice, and v2.1.4 tied it to the node
// threshold: flatten most of the graph and links went straight with it. That is
// wrong for a workflow built out of curves, so it is now its own setting, with
// the old behaviour available as "auto".
function lodLinksStraight() {
  if (LOD.linkStyle === "straight") return true;
  if (LOD.linkStyle === "spline") return false;
  return LOD.minPx > 0 && LOD.plan.links;
}

function lodBoxifyOn() {
  return LOD.minPx > 0 && LOD.plan.tiny > 0;
}

// One frame drawn the cheap way — link outlines skipped, node detail reduced,
// and (see lodSweepDom) the DOM content of boxed nodes out of the layout pass.
// True when either setting asks for it.
function lodCheapFrameOn() {
  return lodDetailOn() || lodBoxifyOn();
}

function lodPreviewsOn() {
  return LOD.thumbZoom > 0 && LOD.zoom > 0 && LOD.zoom < LOD.thumbZoom;
}

// This frontend can render nodes as Vue DOM overlays, in which case LiteGraph
// draws no node chrome at all — painting rectangles for them would put the
// canvas *behind* the DOM nodes it is meant to replace.
function lodVueNodesMode() {
  try {
    const LG =
      (typeof globalThis !== "undefined" && globalThis.LiteGraph) ||
      (typeof window !== "undefined" && window.LiteGraph) ||
      null;
    return !!(LG && LG.vueNodesMode);
  } catch (e) {
    return false;
  }
}

// The draw loop's own node list, whichever of the three places this frontend
// version keeps it in.
function lodGraphNodes(canvas) {
  const cands = [
    canvas && canvas.graph && canvas.graph._nodes,
    typeof app !== "undefined" && app && app.graph && app.graph._nodes,
    canvas && canvas.nodes,
  ];
  for (const c of cands) if (c && c.length) return c;
  return cands[0] || cands[2] || null;
}

// How wide a node lands on screen, in pixels — which is what decides whether
// anything it draws can be seen at all.
function lodNodePx(node, canvas) {
  const scale = (canvas && canvas.ds && Number(canvas.ds.scale)) || 1;
  const size = node && (node.renderingSize || node.size);
  if (!size) return Infinity;
  const w = Math.abs(Number(size[0])) || 0;
  const h = Math.abs(Number(size[1])) || 0;
  return Math.max(w, h) * scale;
}

// Once per frame: are the nodes too small to be worth drawing properly, and is
// that true of the graph as a whole? (Links have no size of their own, so the
// zoom has to stand in for it.)
function lodPlanFrame(canvas) {
  const plan = LOD.plan;
  plan.at = nowMs();
  LOD.zoom = (canvas && canvas.ds && Number(canvas.ds.scale)) || 0;
  // Which nodes are boxes changes with the zoom, so does the set of DOM
  // elements that belong to them. Sweeping on the change (and not every frame)
  // keeps this at the cost of a zoom, not of a redraw.
  if (LOD.minPx > 0 && (LOD.zoom !== LOD.sweptZoom || LOD.minPx !== LOD.sweptPx)) {
    try {
      lodSweepDom(canvas);
    } catch (e) {
      /* never fatal */
    }
  }
  plan.links = false;
  plan.tiny = 0;
  plan.sampled = 0;
  plan.total = 0;
  plan.medPx = 0;
  plan.needPx = 0;
  if (!(LOD.minPx > 0)) return plan;
  const nodes = lodGraphNodes(canvas);
  if (!nodes || !nodes.length) return plan;
  const total = nodes.length;
  const stride = Math.max(1, Math.floor(total / 64)); // 64 samples is plenty for a share
  const widths = [];
  for (let i = 0; i < total; i += stride) {
    const px = lodNodePx(nodes[i], canvas);
    if (px < LOD.minPx) plan.tiny++;
    widths.push(px);
    plan.sampled++;
  }
  if (widths.length) {
    widths.sort((a, b) => a - b);
    plan.medPx = Math.round(widths[widths.length >> 1]);
    // The setting that would flatten the typical node at this zoom, taken from
    // the same ladder the user picks from. What counts as "tiny" is a property
    // of the zoom, not of the graph, and this is the number that makes it
    // obvious: at 10% on a 4K screen it is 48 or 64, not 32.
    for (const v of LOD_MIN_PX) {
      if (v > 0 && v >= plan.medPx) { plan.needPx = v; break; }
    }
  }
  plan.total = total;
  plan.links = plan.tiny / Math.max(1, plan.sampled) >= LOD_LINK_SHARE;
  return plan;
}

// The cheap stand-in for a node. The caller has already translated the context
// to the node's origin, which is why this paints at 0,0.
function lodPaintNode(node, canvas, ctx) {
  const size = (node && (node.renderingSize || node.size)) || [0, 0];
  const w = Math.abs(Number(size[0])) || 0;
  const h = Math.abs(Number(size[1])) || 0;
  const fill = node.renderingBgColor || node.bgcolor || node.renderingColor || node.color || "#4a4a4a";
  const scale = (canvas && canvas.ds && Number(canvas.ds.scale)) || 1;
  ctx.globalAlpha = 1;
  ctx.shadowColor = "transparent";
  ctx.fillStyle = fill;
  ctx.fillRect(0, 0, w, h);
  if (node.selected) {
    ctx.strokeStyle = "#ffb300";
    ctx.lineWidth = 1 / scale;
    ctx.strokeRect(0, 0, w, h);
  }
}

function lodPaintLink(ctx, a, b, color) {
  ctx.beginPath();
  ctx.moveTo(a[0], a[1]);
  ctx.lineTo(b[0], b[1]);
  ctx.strokeStyle = color || "#9a9a9a";
  ctx.lineWidth = 1;
  ctx.stroke();
}

// ------------------------------------------------------------- previews -----
// Which resolution does the screen need? A node draws in graph units, so the
// destination rectangle has to be multiplied by the zoom and the device pixel
// ratio before it means anything on screen.
function lodBucketFor(px, sourceLong) {
  for (const b of LOD_THUMB_LADDER) if (b >= px) return Math.min(b, sourceLong);
  return sourceLong;
}

function lodImageSize(img) {
  if (!img) return null;
  const w = Number(img.naturalWidth || img.videoWidth || img.width) || 0;
  const h = Number(img.naturalHeight || img.videoHeight || img.height) || 0;
  if (!(w > 0) || !(h > 0)) return null;
  return { w, h };
}

function lodDpr() {
  try {
    const dpr = Number(typeof window !== "undefined" && window.devicePixelRatio);
    return Number.isFinite(dpr) && dpr > 0 ? dpr : 1;
  } catch (e) {
    return 1;
  }
}

function lodEvictThumbs() {
  while (LOD.thumbQueue.length > LOD_THUMB_MAX || LOD.thumbBytes > LOD_THUMB_MAX_BYTES) {
    const old = LOD.thumbQueue.shift();
    const per = LOD.thumbs && LOD.thumbs.get(old.src);
    const rec = per && per.get(old.bucket);
    if (rec && rec.ready) LOD.thumbBytes = Math.max(0, LOD.thumbBytes - (rec.bytes || 0));
    if (per) per.delete(old.bucket);
  }
}

function lodBuildThumb(img, size, bucket, rec, per) {
  const k = Math.min(1, bucket / Math.max(size.w, size.h));
  const tw = Math.max(1, Math.round(size.w * k));
  const th = Math.max(1, Math.round(size.h * k));
  const done = (bitmap) => {
    rec.bitmap = bitmap;
    rec.ready = true;
    LOD.produced.add(bitmap);
    rec.bytes = tw * th * 4;
    LOD.thumbsBuilt++;
    LOD.thumbBytes += rec.bytes;
    lodEvictThumbs();
  };
  try {
    if (typeof createImageBitmap === "function") {
      Promise.resolve(createImageBitmap(img, { resizeWidth: tw, resizeHeight: th, resizeQuality: "low" }))
        .then(done)
        .catch(() => {
          LOD.thumbFailures++;
          per.delete(bucket);
        });
      return;
    }
  } catch (e) {
    /* no createImageBitmap: fall through to the canvas path */
  }
  try {
    const c = document.createElement("canvas");
    c.width = tw;
    c.height = th;
    const cctx = c.getContext("2d");
    if (!cctx) throw new Error("no 2d context for thumbnails");
    cctx.drawImage(img, 0, 0, tw, th);
    done(c);
  } catch (e) {
    LOD.thumbFailures++;
    per.delete(bucket);
  }
}

// The thumbnail for this source at this size, or null while it is being built.
function lodThumbFor(img, size, bucket) {
  if (!LOD.thumbs) LOD.thumbs = new WeakMap();
  let per = LOD.thumbs.get(img);
  if (!per) {
    per = new Map();
    LOD.thumbs.set(img, per);
  }
  const rec = per.get(bucket);
  if (rec) return rec.ready ? rec.bitmap : null;
  const pending = { ready: false, bitmap: null, bytes: 0, src: img, bucket };
  per.set(bucket, pending);
  LOD.thumbQueue.push({ src: img, bucket });
  lodBuildThumb(img, size, bucket, pending, per);
  return null;
}

// A drop-in replacement for one drawImage() call, or null to leave it alone.
function lodThumbArgs(args) {
  if (!lodPreviewsOn()) return null;
  const img = args[0];
  if (!img || typeof img !== "object") return null;
  // Thumbnails of thumbnails are pointless: anything we produced is already the
  // resolution the screen asked for.
  if (LOD.produced && LOD.produced.has(img)) return null;
  const size = lodImageSize(img);
  if (!size) return null;
  const long = Math.max(size.w, size.h);
  if (long < LOD_THUMB_MIN_SRC) {
    LOD.imgSkipped++;
    return null;
  }
  const nine = args.length >= 9;
  const dw = Number(nine ? args[7] : args[3]) || 0;
  const dh = Number(nine ? args[8] : args[4]) || 0;
  const need = Math.max(Math.abs(dw), Math.abs(dh)) * (LOD.zoom > 0 ? LOD.zoom : 1) * lodDpr();
  const bucket = lodBucketFor(need, long);
  if (!(bucket > 0) || bucket >= long) {
    LOD.imgSkipped++;
    return null;
  }
  LOD.imgSeen++;
  const thumb = lodThumbFor(img, size, bucket);
  if (!thumb) {
    LOD.imgFull++;
    return null;
  }
  LOD.imgThumb++;
  if (nine) {
    const k = thumb.width / Math.max(1, size.w);
    return [thumb, args[1] * k, args[2] * k, args[3] * k, args[4] * k, args[5], args[6], dw, dh];
  }
  return [thumb, args[1], args[2], dw, dh];
}

let lodDomSweepTimer = null;

// Nodes and widgets arrive while the page is running (a workflow load, an
// execution result). One pass a second keeps the hidden set honest without
// touching anything when the mode is off.
function lodInstallDomSweep() {
  if (lodDomSweepTimer) return;
  try {
    lodDomSweepTimer = govOwn(() =>
      setInterval(() => {
        try {
          if (LOD.minPx > 0) lodSweepDom(app.canvas);
        } catch (e) {
          /* never fatal */
        }
      }, LOD_DOM_SWEEP_MS)
    );
  } catch (e) {
    /* no timers: the sweep still runs whenever the zoom or the setting changes */
  }
}

let lodDrawImagePatched = false;

// Only image draws that happen *inside* a node are touched: the graph's own
// bitmaps (background grid, per-node-type icons) are already small and are not
// what costs a frame. Installed once, and inert while the mode is off.
function lodInstallDrawImage() {
  if (lodDrawImagePatched) return true;
  try {
    const proto = typeof CanvasRenderingContext2D !== "undefined" && CanvasRenderingContext2D.prototype;
    if (!proto || typeof proto.drawImage !== "function") return false;
    const original = proto.drawImage;
    proto.drawImage = function (...args) {
      if (LOD.inNode && LOD.thumbZoom > 0) {
        try {
          const sub = lodThumbArgs(args);
          if (sub) return original.apply(this, sub);
        } catch (err) {
          LOD.thumbFailures++;
          if (LOD.thumbFailures > 8) lodSet({ thumbZoom: 0 });
        }
      }
      return original.apply(this, args);
    };
    lodDrawImagePatched = true;
    return true;
  } catch (e) {
    return false;
  }
}

// The frontend has its own low-quality rendering: `_isLowQuality` is what
// `low_quality` reads, and below its own threshold (Settings -> LiteGraph,
// "Zoom Node Level of Detail") it stops drawing node shadows and rounded
// corners, stops stroking a dark outline under every link, and lets DOM widgets
// that asked to hide when zoomed out hide. Its threshold is a font size, so on a
// 4K screen at 10% zoom it may or may not have engaged; this brings the same
// rendering forward to the zoom the user picked, for the duration of one frame.
// Returns a function that puts the flag back, or null if there was nothing to do.
function lodLowQualityFrame(canvas) {
  try {
    if (!canvas || !("_isLowQuality" in canvas)) {
      LOD.lqMissing = true;
      return null;
    }
    const prev = canvas._isLowQuality;
    if (prev === true) return null; // the frontend is already drawing this way
    canvas._isLowQuality = true;
    return () => {
      try {
        canvas._isLowQuality = prev;
      } catch (e) {
        /* it was writable a moment ago; if that changed, the next frame fails open */
      }
    };
  } catch (e) {
    LOD.lqMissing = true;
    return null;
  }
}

// ------------------------------------------------------------- DOM boxes ----
// A node whose visuals are DOM (a Vue node, or any node with a DOM widget: an
// image preview, a video, a curve editor, a custom panel) keeps that DOM on top
// of the canvas at every zoom. Flattening the canvas node into a rectangle while
// its DOM content stays at full size leaves the worst of both, so the elements
// belonging to a boxed node are hidden with one CSS class, and unhidden the
// moment it stops being a box. Nothing is moved, re-parented or edited: the
// class is added and removed, and the browser does the rest.
function lodDomTargets(node) {
  const out = [];
  try {
    const widgets = node && node.widgets;
    if (!widgets || !widgets.length) return out;
    for (const w of widgets) {
      if (!w) continue;
      const el = w.element || w.inputEl;
      const hasEl = el && typeof el === "object" && typeof el.classList === "object";
      // `component` is how the frontend's ComponentWidgetImpl carries the Vue
      // component it renders (3D viewers, camera info, anything added through
      // addWidget). No element to reach for, but the widget is in the store and
      // its wrapper is positioned on every draw — the flag is the handle.
      const isComponent = !hasEl && typeof w.component !== "undefined";
      if (!hasEl && !isComponent) continue;
      const target = hasEl ? (typeof el.closest === "function" && el.closest(".dom-widget")) || el : null;
      out.push({ el: target && target.classList ? target : null, widget: w });
    }
  } catch (e) {
    /* a widget with a hostile element getter is simply not hidden */
  }
  return out;
}

// Hiding an element with CSS stops it being *painted*; it does not stop the
// frontend positioning it. Every DOM widget of every node goes through the
// widget store on every drawn frame — position, size, z-order — and for a graph
// of a thousand nodes that is a thousand Vue components' worth of layout work
// per redraw, all of it for content that is currently a rectangle. ComfyUI's own
// escape hatch is `hideOnZoom`, which its store consults before doing any of
// that. Widgets that asked for it are left alone; the ones that did not (image
// and video previews pass `hideOnZoom: false` deliberately) get it while their
// node is a box, and get their own value back the moment it is not. If the flip
// ever fails, the CSS class has already hidden the element, so the fallback is
// exactly the old behaviour.
function lodStillWidget(widget, want) {
  const map = LOD.domWidgets || (LOD.domWidgets = new Map());
  const opts = widget && widget.options;
  if (!opts || typeof opts !== "object") return false;
  try {
    if (want) {
      if (map.has(widget)) return false; // already taken out by an earlier sweep
      if (opts.hideOnZoom === true) return false; // already its own answer, not our doing
      map.set(widget, opts.hideOnZoom);
      opts.hideOnZoom = true;
      return true;
    }
    if (!map.has(widget)) return false;
    opts.hideOnZoom = map.get(widget);
    map.delete(widget);
    return true;
  } catch (e) {
    // A frozen options object is a valid answer: the element is still hidden by
    // the class, the layout pass just keeps running for it.
    return false;
  }
}

// Vue-rendered nodes have no canvas visuals at all: the node *is* the DOM
// element carrying data-node-id. Their root is hidden too, and the rectangle
// this file paints takes its place.
function lodDomRoots() {
  try {
    if (typeof document === "undefined" || typeof document.querySelectorAll !== "function") return [];
    return document.querySelectorAll("[data-node-id]") || [];
  } catch (e) {
    return [];
  }
}

function lodNodeById(canvas, id) {
  try {
    const graph = canvas && canvas.graph;
    if (graph && typeof graph.getNodeById === "function") {
      const found = graph.getNodeById(Number(id));
      if (found) return found;
    }
    const nodes = lodGraphNodes(canvas);
    for (const n of nodes) if (n && String(n.id) === String(id)) return n;
  } catch (e) {
    /* no graph: nothing to hide */
  }
  return null;
}

function lodSweepDom(canvas) {
  const marked = LOD.domMarked || (LOD.domMarked = new Set());
  const keep = new Set();
  let nodes = 0;
  try {
    if (canvas && LOD.minPx > 0) {
      for (const node of lodGraphNodes(canvas) || []) {
        if (!node || !(lodNodePx(node, canvas) < LOD.minPx)) continue;
        let any = false;
        for (const t of lodDomTargets(node)) {
          if (t.el) {
            t.el.classList.add(LOD_DOM_CLASS);
            keep.add(t.el);
          }
          lodStillWidget(t.widget, true); // returns true only when it changed something
          any = true;
        }
        if (any) nodes++;
      }
      for (const el of lodDomRoots()) {
        const id = el && typeof el.getAttribute === "function" ? el.getAttribute("data-node-id") : null;
        if (id === null || id === undefined) continue;
        const node = lodNodeById(canvas, id);
        if (!node || !(lodNodePx(node, canvas) < LOD.minPx)) continue;
        if (el.classList) {
          el.classList.add(LOD_DOM_CLASS);
          keep.add(el);
          nodes++;
        }
      }
    }
  } catch (e) {
    /* hiding DOM is a courtesy: if the page's DOM is not what we expect, skip it */
  }
  // Widgets whose node is no longer a box go back to asking for their own
  // placement on the next frame.
  if (LOD.domWidgets && LOD.domWidgets.size) {
    for (const node of lodGraphNodes(canvas) || []) {
      const box = !!node && LOD.minPx > 0 && lodNodePx(node, canvas) < LOD.minPx;
      if (box) continue;
      for (const w of node.widgets || []) if (LOD.domWidgets.has(w)) lodStillWidget(w, false);
    }
  }
  let changed = keep.size !== marked.size;
  for (const el of keep) if (!marked.has(el)) changed = true;
  for (const el of marked) {
    if (!keep.has(el)) {
      try {
        el.classList.remove(LOD_DOM_CLASS);
      } catch (e) {
        /* element is gone; dropping it from the set is enough */
      }
    }
  }
  LOD.domMarked = keep;
  LOD.domHidden = keep.size;
  LOD.domNodes = nodes;
  LOD.domStilled = LOD.domWidgets ? LOD.domWidgets.size : 0;
  LOD.sweptZoom = LOD.zoom;
  LOD.sweptPx = LOD.minPx;
  return changed;
}

// The redraw cap. A hard cap would make dragging feel broken, so it is only in
// force while nobody has touched the page for a moment; any pointer, wheel or
// key event lifts it instantly (the scheduler layer already watches for those).
function lodDrawCapMs(t) {
  if (LOD.idleCapMs > 0 && !govInputRecently(t, LOD_IDLE_INPUT_MS)) return LOD.idleCapMs;
  return drawThrottleMs > 0 ? drawThrottleMs : 0;
}

function lodSaveSettings() {
  try {
    if (typeof localStorage === "undefined" || !localStorage) return;
    localStorage.setItem(
      LOD_STORE_KEY,
      JSON.stringify({
        minPx: LOD.minPx,
        detailZoom: LOD.detailZoom,
        thumbZoom: LOD.thumbZoom,
        idleCapMs: LOD.idleCapMs,
        linkStyle: LOD.linkStyle,
      })
    );
  } catch (e) {
    /* a browser with storage switched off just does not remember */
  }
}

// Called once at startup, before the panel is built, so the selects show what is
// actually in effect. Nothing is enabled that the user did not enable: this
// restores their own last choice, and an untouched install has nothing saved.
function lodLoadSettings() {
  try {
    if (typeof localStorage === "undefined" || !localStorage) return false;
    const raw = localStorage.getItem(LOD_STORE_KEY);
    if (!raw) return false;
    const saved = JSON.parse(raw);
    if (!saved || typeof saved !== "object") return false;
    lodSet({
      minPx: Number(saved.minPx) || 0,
      detailZoom: saved.detailZoom === undefined ? 0 : Number(saved.detailZoom) || 0,
      thumbZoom: saved.thumbZoom === undefined ? 0.6 : Number(saved.thumbZoom) || 0,
      idleCapMs: Number(saved.idleCapMs) || 0,
      linkStyle: saved.linkStyle || "auto",
    });
    return true;
  } catch (e) {
    return false;
  }
}

function lodAbort(err) {
  LOD.error = (err && err.message) || String(err);
  LOD.minPx = 0;
  LOD.idleCapMs = 0;
  LOD.detailZoom = 0;
  LOD.baseline = null;
  try {
    lodSweepDom(app.canvas);
  } catch (e) {
    /* unhiding is best-effort; the class is gone with the reload either way */
  }
  try {
    warnOnce("lod-abort", `low-zoom drawing turned itself off after an error: ${LOD.error}`);
  } catch (e) {
    /* nothing useful left to do */
  }
}

// What the frames drawn *since the mode was switched on* cost, which is the
// question a user is asking. The frame budget the tracker reports elsewhere is a
// 10s window, so reading it seconds after a switch shows the old path mixed in.
function lodSinceSwitch() {
  if (!LOD.baseline || !LOD.baseline.at) return null;
  const from = LOD.baseline.at;
  const n = S.frames.aggregate(from).n;
  if (!n) return null;
  return {
    n,
    nodeMsPerFrame: S.frameNodeStage.aggregate(from).sum / n,
    connMsPerFrame: S.frameConnStage.aggregate(from).sum / n,
    meanFrameMs: S.frames.aggregate(from).sum / n,
  };
}

function lodCaptureBaseline() {
  try {
    const fm = frameMetrics();
    LOD.baseline = {
      at: nowMs(),
      nodeMsPerFrame: fm.ok ? fm.nodeMsPerFrame : NaN,
      connMsPerFrame: fm.ok ? fm.connMsPerFrame : NaN,
      meanFrameMs: fm.ok ? fm.meanFrameMs : NaN,
      fps: fm.ok ? fm.fps : NaN,
    };
  } catch (e) {
    LOD.baseline = null;
  }
}

function lodSet(opts) {
  const o = opts || {};
  const was = lodOn();
  if ("minPx" in o) LOD.minPx = Math.max(0, Number(o.minPx) || 0);
  if ("idleCapMs" in o) LOD.idleCapMs = Math.max(0, Number(o.idleCapMs) || 0);
  if ("thumbZoom" in o) {
    LOD.thumbZoom = Math.max(0, Math.min(1, Number(o.thumbZoom) || 0));
    if (LOD.thumbZoom > 0) lodInstallDrawImage();
  }
  if ("detailZoom" in o) LOD.detailZoom = Math.max(0, Math.min(1, Number(o.detailZoom) || 0));
  if ("linkStyle" in o) {
    const style = String(o.linkStyle);
    LOD.linkStyle = LOD_LINK_STYLES.includes(style) ? style : "auto";
  }
  if (LOD.minPx > 0) lodInstallDomSweep();
  const now = lodOn();
  if (now) LOD.error = "";
  // The first change is the moment worth measuring from, whether or not the mode
  // was already partly on (previews are on by default).
  if (now && !LOD.baseline) lodCaptureBaseline();
  if (!now && was) LOD.baseline = null;
  if (LOD.idleCapMs > 0) govInstallInputGuard();
  // A threshold change has to take effect now, not on the next frame the canvas
  // happens to draw: the marks follow the setting, whatever the zoom is.
  try {
    lodSweepDom(app.canvas);
  } catch (e) {
    /* the sweep never throws, but setup is not worth a broken toggle */
  }
  // Remembered across sessions (see LOD_STORE_KEY). The change is already in
  // effect by now, so a storage that refuses to save cannot take it back.
  lodSaveSettings();
  return now;
}

// ComfyUI has its own level-of-detail switch: `LiteGraph.Canvas.MinFontSizeForLOD`
// (Settings -> LiteGraph, default 8px, and 0 switches its LOD off entirely),
// which flips `canvas.low_quality` on below a zoom threshold and then only skips
// shadows and rounded corners. Worth showing next to ours, because "my frames are
// still slow with LOD on" is a fair question and the answer is that this LOD
// changes shapes, not how many nodes get drawn.
function lodFrontendLod(canvas) {
  try {
    const c = canvas || (typeof app !== "undefined" && app && app.canvas) || null;
    if (!c) return null;
    const min = Number(c.min_font_size_for_lod);
    return {
      minFontSize: Number.isFinite(min) ? min : null,
      lowQuality: !!c.low_quality,
    };
  } catch (e) {
    return null;
  }
}

// Is the whole graph on screen? If it is, culling cannot save anything, and the
// levers left are cheaper per-node drawing (above) and fewer redraws — which is
// the answer to "why does a culling scan not help my frames?".
function lodVisibility(canvas) {
  try {
    const c = canvas || (typeof app !== "undefined" && app && app.canvas) || null;
    const el = c && (c.canvas || c);
    const nodes = lodGraphNodes(c);
    if (!c || !nodes || !nodes.length) return null;
    const ds = c.ds || {};
    const scale = Number(ds.scale) || 1;
    const off = ds.offset || [0, 0];
    const dpr = (typeof window !== "undefined" && Number(window.devicePixelRatio)) || 1;
    // The backing store is sized in device pixels; the world span is in CSS px
    // per unit of scale, like LiteGraph's own visible-area maths.
    const width = ((el && Number(el.width)) || 0) / (dpr > 1 ? dpr : 1);
    const height = ((el && Number(el.height)) || 0) / (dpr > 1 ? dpr : 1);
    let x0;
    let y0;
    let x1;
    let y1;
    const va = ds.visible_area;
    if (va && Number.isFinite(Number(va[0])) && Number.isFinite(Number(va[2]))) {
      x0 = Number(va[0]);
      y0 = Number(va[1]);
      x1 = Number(va[2]);
      y1 = Number(va[3]);
    } else {
      x0 = -Number(off[0] || 0);
      y0 = -Number(off[1] || 0);
      x1 = x0 + width / scale;
      y1 = y0 + height / scale;
    }
    let visible = 0;
    let sumPx = 0;
    for (const n of nodes) {
      const size = n && (n.renderingSize || n.size);
      if (!size) continue;
      const w = Math.abs(Number(size[0])) || 0;
      const h = Math.abs(Number(size[1])) || 0;
      const pos = (n && n.pos) || [0, 0];
      const nx = Number(pos[0]) || 0;
      const ny = Number(pos[1]) || 0;
      sumPx += Math.max(w, h) * scale;
      if (nx + w >= x0 && nx <= x1 && ny + h >= y0 && ny <= y1) visible++;
    }
    const total = nodes.length;
    return {
      total,
      visible,
      share: total ? visible / total : 0,
      meanPx: total ? sumPx / total : 0,
      scale,
      zoomedOut: scale < 0.35,
    };
  } catch (e) {
    return null;
  }
}

let canvasPatched = false;
let canvasRetries = 0;

function patchCanvasDraw() {
  if (canvasPatched) return true;
  if (!app.canvas || !app.canvas.constructor || !app.canvas.constructor.prototype) return false;
  const proto = app.canvas.constructor.prototype;

  if (typeof proto.draw !== "function") {
    warnOnce(
      "no-draw-fn",
      "LGraphCanvas.prototype.draw not found — this frontend version changed its canvas entry point. " +
        "Frame totals, the frame budget, fps and unattributed time will be unavailable; " +
        "per-extension hook timing still works."
    );
  } else if (!proto.draw.__antsWrapped) {
    const originalDraw = proto.draw;
    const wrappedDraw = function (...args) {
      const t0 = performance.now();
      // The Testing tab's hard cap, or the low-zoom idle cap — which only counts
      // as idle until somebody touches the page again.
      const capMs = lodDrawCapMs(t0);
      if (capMs > 0) {
        const gap = t0 - lastRealDrawAt;
        if (gap < capMs) {
          S.counters.capped++;
          if (LOD.idleCapMs > 0 && capMs === LOD.idleCapMs) LOD.capped++;
          // v1 dropped this redraw permanently — the canvas could sit on stale
          // pixels until the next unrelated tick. Schedule exactly one trailing
          // redraw instead, so a cap becomes a rate limit, not data loss.
          scheduleTrailingDraw(this, capMs - gap);
          return undefined;
        }
      }
      lastRealDrawAt = t0;
      S.counters.draws++;
      curNodeStageMs = 0;
      curConnStageMs = 0;
      curAttrMs = 0;
      // Whoever is inside this draw is on the display lane: a source that draws
      // is a source whose skipped ticks the user can see (see GOV_DISPLAY_FLOOR_MS).
      const drawOwner = GOV.running;
      if (drawOwner && !drawOwner.ours) {
        if (!drawOwner.display) drawOwner.display = true;
        drawOwner.drew = (drawOwner.drew || 0) + 1;
      }
      // The plan also carries the zoom, which the preview ladder needs even when
      // no node is being flattened.
      if (lodOn()) lodPlanFrame(this);
      drawDepth++;
      // One frame drawn the way the frontend draws when it is zoomed far out:
      // no node shadows, no rounded corners, no outline under every link. The
      // flag is put back as soon as the frame is over, so nothing this tool did
      // outlives the redraw it was for.
      const restoreLq = lodCheapFrameOn() ? lodLowQualityFrame(this) : null;
      let ret;
      try {
        ret = originalDraw.apply(this, args);
      } finally {
        if (restoreLq) restoreLq();
        drawDepth--;
        const dt = performance.now() - t0;
        S.counters.framesTotal++;
        if (!S.paused) {
          S.frames.push(t0, dt);
          S.frameAttr.push(t0, curAttrMs);
          S.frameNodeStage.push(t0, curNodeStageMs);
          S.frameConnStage.push(t0, curConnStageMs);
          S.counters.frames++;
        }
      }
      return ret;
    };
    wrappedDraw.__antsWrapped = true;
    proto.draw = wrappedDraw;
  }

  if (typeof proto.drawNode === "function" && !proto.drawNode.__antsWrapped) {
    const originalDrawNode = proto.drawNode;
    const wrappedDrawNode = function (node, ctx, ...rest) {
      maybeWrapInstanceHooks(node);
      if (ctx && LOD.minPx > 0 && !lodVueNodesMode() && lodNodePx(node, this) < LOD.minPx) {
        const lt0 = performance.now();
        try {
          this.current_node = node;
          lodPaintNode(node, this, ctx);
        } catch (err) {
          lodAbort(err);
          return originalDrawNode.call(this, node, ctx, ...rest);
        }
        const ldt = performance.now() - lt0;
        LOD.nodes++;
        LOD.ms += ldt;
        // Counted as node rendering, because that is what it replaces: the frame
        // budget then shows the saving instead of hiding it. Per-node-type
        // averages are left alone — they are about LiteGraph's own drawing.
        if (!S.paused) curNodeStageMs += ldt;
        return undefined;
      }
      const t0 = performance.now();
      const outerInNode = LOD.inNode;
      LOD.inNode = true; // preview substitution is only for what a node draws
      let ret;
      try {
        ret = originalDrawNode.call(this, node, ctx, ...rest);
      } finally {
        LOD.inNode = outerInNode;
      }
      const dt = performance.now() - t0;
      if (!S.paused) {
        const typeName = (node && (node.type || (node.constructor && node.constructor.type))) || "unknown";
        let bucket = S.nodes.get(typeName);
        if (!bucket) {
          bucket = { type: typeName, series: new Ring(), calls: 0 };
          S.nodes.set(typeName, bucket);
        }
        bucket.series.push(t0, dt);
        bucket.calls++;
        curNodeStageMs += dt;
      }
      return ret;
    };
    wrappedDrawNode.__antsWrapped = true;
    proto.drawNode = wrappedDrawNode;
  } else if (typeof proto.drawNode !== "function") {
    warnOnce(
      "no-drawnode-fn",
      "LGraphCanvas.prototype.drawNode not found — per-node-type render cost (Nodes tab) unavailable. " +
        "Extension hook timing still works."
    );
  }

  if (typeof proto.drawConnections === "function" && !proto.drawConnections.__antsWrapped) {
    const originalDrawConnections = proto.drawConnections;
    const wrappedDrawConnections = function (...args) {
      const t0 = performance.now();
      const ret = originalDrawConnections.apply(this, args);
      const dt = performance.now() - t0;
      if (!S.paused) curConnStageMs += dt;
      return ret;
    };
    wrappedDrawConnections.__antsWrapped = true;
    proto.drawConnections = wrappedDrawConnections;
  }

  if (typeof proto.renderLink === "function" && !proto.renderLink.__antsWrapped) {
    const originalRenderLink = proto.renderLink;
    const wrappedRenderLink = function (...args) {
      const ctx = args[0];
      const a = args[1];
      const b = args[2];
      const link = args[3];
      if (ctx && a && b && lodLinksStraight()) {
        const lt0 = performance.now();
        try {
          lodPaintLink(ctx, a, b, args[6] || (link && link.color) || null);
        } catch (err) {
          lodAbort(err);
          return originalRenderLink.apply(this, args);
        }
        LOD.links++;
        LOD.ms += performance.now() - lt0;
        return undefined;
      }
      // Told to keep the curves but draw them cheaply. What costs the pixels is
      // the width of the stroke and the dark outline drawn under it (a second
      // stroke 4 units wider, so on a long link the outline is most of the ink).
      // Both live on the canvas object, so they are set for this one call and
      // put straight back — hit-testing, dragging and the panel never see them.
      if (ctx && a && b && lodDetailOn() && LOD.linkStyle !== "straight") {
        let restore = null;
        try {
          const width = this.connections_width;
          const border = this.render_connections_border;
          this.connections_width = LOD_LINK_WIDTH;
          this.render_connections_border = false;
          restore = () => {
            this.connections_width = width;
            this.render_connections_border = border;
          };
          const ret = originalRenderLink.apply(this, args);
          LOD.thinLinks++;
          return ret;
        } catch (err) {
          lodAbort(err);
        } finally {
          if (restore) restore();
        }
      }
      return originalRenderLink.apply(this, args);
    };
    wrappedRenderLink.__antsWrapped = true;
    proto.renderLink = wrappedRenderLink;
  } else if (typeof proto.renderLink !== "function") {
    warnOnce(
      "no-renderlink",
      "LGraphCanvas.prototype.renderLink not found — low-zoom mode can simplify nodes but not links on this frontend version."
    );
  }

  if (typeof proto.setDirty === "function" && !proto.setDirty.__antsWrapped) {
    const originalSetDirty = proto.setDirty;
    const wrappedSetDirty = function (...args) {
      const t0 = performance.now();
      if (!S.paused) {
        S.invalidations.push(t0, 1);
        maybeSampleCaller(t0);
      }
      if (GOV.controls.coalesce) return govCoalesceRedraw(originalSetDirty, this, args);
      return originalSetDirty.apply(this, args);
    };
    wrappedSetDirty.__antsWrapped = true;
    proto.setDirty = wrappedSetDirty;
  } else if (typeof proto.setDirty !== "function") {
    warnOnce(
      "no-setdirty",
      "LGraphCanvas.prototype.setDirty not found — redraw-request attribution (who is asking for redraws) unavailable. " +
        "Frame/hook timing is unaffected."
    );
  }

  lodInstallDrawImage();

  canvasPatched = true;
  return true;
}

function scheduleTrailingDraw(canvas, delayMs) {
  if (capTrailingTimer) return;
  S.counters.deferred++;
  capTrailingTimer = govOwn(() => setTimeout(() => {
    capTrailingTimer = null;
    try {
      if (canvas && typeof canvas.draw === "function") canvas.draw(true, true);
    } catch (e) {
      warnOnce("trailing-draw-fail", `Trailing redraw after rate cap failed: ${e && e.message}`);
    }
  }, Math.max(1, Math.ceil(delayMs))));
}

// --- 4. invalidation caller sampling ---------------------------------------
// A full stack per call is far too expensive for something called hundreds of
// times a second, so this samples at a fixed rate and multiplies by the exact
// call count that the wrapper keeps.

const SELF_HINT = (() => {
  try {
    const stack = new Error().stack || "";
    const matches = stack.match(/([^/\s():]+\.js)/g);
    if (matches && matches.length) return matches[matches.length - 1];
  } catch (e) {
    /* ignore */
  }
  return "tracker.js";
})();

const PLUMBING = /(setDirtyCanvas|setDirty|dirty_canvas|dirty_bgcanvas|__ants|govWrapperFrame)/;

// A URL that is this file. The install folder may be renamed (the README suggests
// a `0000_` prefix), so the file name is the stable part; SELF_HINT covers the
// harness and any bundle that renames it.
function isSelfUrl(url) {
  if (!url) return false;
  const s = String(url);
  return s.includes(SELF_HINT) || /(^|\/)tracker\.js(\?|$)/.test(s);
}

// Pure + exported for tests: turn a stack string into a caller signature.
function parseCallerStack(stack) {
  if (!stack) return null;
  const lines = String(stack).split("\n");
  let fallback = null;
  let selfFrame = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line.startsWith("at ")) continue;
    const body = line.slice(3);
    let fn = "";
    let loc = body;
    const withFn = body.match(/^(\S+)\s+\((.+)\)$/);
    if (withFn) {
      fn = withFn[1];
      loc = withFn[2];
    }
    const m = loc.match(/^(.*?):(\d+):(\d+)$/);
    const url = m ? m[1] : loc;
    const lineNo = m ? m[2] : "";
    if (url.startsWith("node:") || url.startsWith("native")) continue;
    if (PLUMBING.test(fn) || PLUMBING.test(url)) continue;
    if (url.includes(SELF_HINT)) {
      // Our own file: either the setDirty wrapper itself or this tool's own
      // synthetic tick / benchmark. Never report it as an extension caller, but
      // keep it as a last resort so the table can say "that was me".
      if (!selfFrame) selfFrame = { file: shortUrl(url), line: lineNo, fn: fn || "(anonymous)" };
      continue;
    }
    const pack = packFromUrl(url);
    const sig = `${fn || "(anonymous)"} @ ${shortUrl(url)}:${lineNo}`;
    const candidate = { sig, pack, file: shortUrl(url), line: lineNo, fn: fn || "(anonymous)" };
    if (pack) return candidate; // a caller inside a custom node pack: the best answer
    // A URL a page script would actually have (ComfyUI core, a CDN bundle).
    const isPageScript = /^(https?:|blob:|\/)/.test(url);
    if (isPageScript && !fallback) fallback = candidate;
    // Anything else (browser internals, an embedder's own frames) is not
    // something to blame an extension for: keep it only as a last resort.
    if (!isPageScript && !selfFrame) selfFrame = candidate;
  }
  if (fallback) return fallback;
  if (selfFrame) {
    return {
      sig: "(this tracker's own synthetic tick / benchmark)",
      pack: null,
      file: selfFrame.file,
      line: selfFrame.line,
      fn: selfFrame.fn,
    };
  }
  return null;
}

function maybeSampleCaller(t) {
  if (stackSampleTokens < 1) {
    const gap = t - lastStackSampleAt;
    const refill = (STACK_SAMPLES_PER_SEC * gap) / 1000;
    stackSampleTokens = Math.min(1, stackSampleTokens + refill);
    if (stackSampleTokens < 1) return;
  }
  stackSampleTokens -= 1;
  lastStackSampleAt = t;
  let info = null;
  try {
    info = parseCallerStack(new Error().stack);
  } catch (e) {
    return;
  }
  if (!info) return;
  if (!S.samples) S.samples = new Ring(1024);
  S.samples.push(t, 1);
  let entry = S.callers.get(info.sig);
  if (!entry) {
    if (S.callers.size >= MAX_CALLERS) return;
    entry = { ...info, sampled: 0, ring: new Ring(128), firstSeen: t, lastSeen: t };
    S.callers.set(info.sig, entry);
  }
  entry.sampled++;
  entry.ring.push(t, 1);
  entry.lastSeen = t;
}

// --- 5. long stalls: the costs that are not canvas drawing at all -----------
// Long Animation Frames (Chrome 123+) name the script, the function AND the
// invoker ("TimerHandler:setInterval" is the classic heartbeat culprit).
// Falls back to plain longtask entries elsewhere.

let stallObserver = null;

function installStallObserver() {
  try {
    stallObserver = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) recordStall(entry);
    });
    stallObserver.observe({ type: "long-animation-frame", buffered: true });
    S.env.loaf = true;
    return;
  } catch (e) {
    /* fall through */
  }
  try {
    stallObserver = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) recordStall(entry, "longtask");
    });
    stallObserver.observe({ type: "longtask", buffered: true });
    S.env.longtask = true;
  } catch (e) {
    warnOnce(
      "no-stalls",
      "This browser supports neither Long Animation Frames nor longtask entries, so the Stalls tab " +
        "(non-canvas main-thread cost) will stay empty. Chromium 123+ gives the best attribution."
    );
  }
}

function recordStall(entry, kind) {
  if (S.paused) return;
  const duration = entry.duration || 0;
  if (Number.isFinite(entry.blockingDuration)) {
    GOV.lastBlockMs = entry.blockingDuration;
    GOV.lastBlockAt = nowMs();
  } else if (duration > 50) {
    GOV.lastBlockMs = Math.max(0, duration - 50);
    GOV.lastBlockAt = nowMs();
  }
  try {
    govRecordTrace(entry);
  } catch (e) {
    warnOnce("gov-trace", `Frame trace failed: ${e && e.message}`);
  }
  // Chrome's LoAF blockingDuration is the part attributable to the main thread
  // being blocked; the longtask fallback convention is duration - 50ms.
  const blocking = Number.isFinite(entry.blockingDuration)
    ? entry.blockingDuration
    : Math.max(0, duration - 50);
  const t = (entry.startTime || 0) + duration;
  S.stalls.push(t, blocking);
  S.stallCount++;
  if (duration > S.stallWorstMs) S.stallWorstMs = duration;

  const scripts = entry.scripts && entry.scripts.length ? entry.scripts : null;
  if (!scripts) {
    // No script attribution (Firefox longtask, or a LoAF with no scripts).
    bumpStallSource({
      sig: `${kind || "task"} (no script attribution)`,
      pack: null,
      invoker: kind || "task",
    }, blocking, duration, 0);
    return;
  }
  // Split out this tool's own frames. Chrome attributes a script frame's
  // duration inclusively, so a pass-through wrapper that merely calls the page's
  // callback inherits that callback's whole cost: on a real page, 891 frames and
  // 300 seconds of blocking were attributed to `(anonymous) @ tracker.js` when
  // the time belonged to the extensions whose timers were being relayed.
  const selfFrames = [];
  const realFrames = [];
  for (const script of scripts) {
    const url = script.sourceURL || "";
    if (isSelfUrl(url)) selfFrames.push(script);
    else realFrames.push(script);
  }
  for (const script of realFrames) {
    const url = script.sourceURL || "";
    const fn = script.sourceFunctionName || "(anonymous)";
    const invoker = [script.invokerType, script.invoker].filter(Boolean).join(" ") || "";
    const pack = packFromUrl(url);
    const sig = `${fn} @ ${shortUrl(url)}${invoker ? ` [${invoker}]` : ""}`;
    bumpStallSource(
      { sig, pack, invoker, file: shortUrl(url), fn, url },
      script.duration || 0,
      script.duration || 0,
      script.forcedStyleAndLayoutDuration || 0
    );
  }
  if (selfFrames.length && !realFrames.length) {
    const worstSelf = selfFrames.reduce((a, b) => ((b.duration || 0) > (a.duration || 0) ? b : a));
    const invoker = [worstSelf.invokerType, worstSelf.invoker].filter(Boolean).join(" ") || kind || "task";
    const cost = worstSelf.duration || blocking;
    const blame = govBlameInFrame(entry.startTime || 0, (entry.startTime || 0) + duration);
    if (blame) {
      // The governor measured what ran inside the frame, so name that instead of
      // naming the wrapper: this is the same answer the trace card gives.
      bumpStallSource(
        {
          sig: `${govSourceLabel(blame.src)}${invoker ? ` [${invoker}]` : ""} (via the tracker's pass-through)`,
          pack: packFromUrl(blame.src.file || ""),
          invoker,
          file: blame.src.file || "",
          fn: blame.src.name,
          url: "",
          ours: !!blame.src.ours,
          // The frame's cost belongs to the canvas repaint this source drives,
          // which is drawing, not a stall in the tab's "not canvas drawing"
          // sense. Tagged so the two are not read as the same thing.
          display: !!blame.src.display,
        },
        cost,
        cost,
        worstSelf.forcedStyleAndLayoutDuration || 0
      );
    } else {
      // Nothing measurable ran inside it: say that, rather than claiming the time
      // as this tool's own. A frame the tracker really spent its own time in
      // still shows up as its own source (marked ours), from the governed rows.
      bumpStallSource(
        {
          sig: `(pass-through timer) @ ${shortUrl(worstSelf.sourceURL || "")}${invoker ? ` [${invoker}]` : ""}`,
          pack: null,
          invoker,
          file: "",
          fn: "(pass-through)",
          url: "",
          ours: true,
        },
        cost,
        cost,
        0
      );
    }
  }
}

function bumpStallSource(info, blockingMs, durationMs, forcedLayoutMs) {
  let entry = S.stallSources.get(info.sig);
  if (!entry) {
    if (S.stallSources.size >= MAX_STALL_SOURCES) return;
    entry = { ...info, count: 0, blockingMs: 0, worstMs: 0, forcedLayoutMs: 0, lastSeen: 0 };
    S.stallSources.set(info.sig, entry);
  }
  entry.count++;
  entry.blockingMs += blockingMs;
  entry.forcedLayoutMs += forcedLayoutMs;
  if (durationMs > entry.worstMs) entry.worstMs = durationMs;
  entry.lastSeen = nowMs();
}

function stallMetrics() {
  const now = nowMs();
  trimIfLive(S.stalls, now - FRAME_KEEP_MS);
  const agg = S.stalls.aggregate(now - WINDOW_MS);
  // Rate denominators: the observed span of the samples, never longer than the
  // window and never shorter than the time actually spent observing. A single
  // stall 2s after page load is 0.5/s, not 0.25/s (which is what dividing by a
  // window that had not elapsed yet would claim).
  const observedMs = Math.max(agg.span, Math.min(WINDOW_MS, Math.max(now - S.startedAt, 1000)));
  const perSec = agg.n ? (agg.n / observedMs) * 1000 : 0;
  const blockingMsPerSec = agg.n ? (agg.sum / observedMs) * 1000 : 0;
  const rows = [...S.stallSources.values()]
    .filter((s) => now - s.lastSeen < 30000)
    .sort((a, b) => b.blockingMs - a.blockingMs);
  const lifetimeBlocking = rows.reduce((acc, r) => acc + r.blockingMs, 0);
  return { perSec, blockingMsPerSec, worst: S.stallWorstMs, total: S.stallCount, rows, lifetimeBlocking, windowMs: observedMs };
}

// --- 6. rAF cadence monitor + memory sampler --------------------------------

function installRafMonitor() {
  if (typeof requestAnimationFrame !== "function") return;
  let prev = NaN;
  const tick = (ts) => {
    const t = performance.now();
    if (!Number.isNaN(prev)) {
      GOV.lastFrameGap = t - prev;
      if (!S.paused) S.raf.push(t, t - prev);
    }
    prev = t;
    S.renderTicks++;
    govOwn(() => requestAnimationFrame(tick));
  };
    govOwn(() => requestAnimationFrame(tick));
}

function installMemorySampler() {
  if (!performance.memory) return;
  const sample = () => {
    if (!S.paused && performance.memory) S.mem.push(nowMs(), performance.memory.usedJSHeapSize);
  };
  sample();
  govOwn(() => setInterval(sample, 1000));
  govOwn(() => setInterval(() => {
    try {
      performance.setResourceTimingBufferSize && performance.setResourceTimingBufferSize(2000);
    } catch (e) {
      /* ignore */
    }
  }, 30000));
  try {
    if (performance.setResourceTimingBufferSize) performance.setResourceTimingBufferSize(2000);
  } catch (e) {
    /* ignore */
  }
}

function resourceLoadSummary() {
  let entries = [];
  try {
    entries = performance.getEntriesByType("resource") || [];
  } catch (e) {
    return { byPack: new Map(), totals: null };
  }
  const byPack = new Map();
  let allBytes = 0;
  let allStart = Infinity;
  let allEnd = -Infinity;
  let resourceCount = 0;
  for (const e of entries) {
    resourceCount++;
    const bytes = e.transferSize || e.encodedBodySize || e.decodedBodySize || 0;
    allBytes += bytes;
    if (e.startTime) allStart = Math.min(allStart, e.startTime);
    allEnd = Math.max(allEnd, e.startTime + e.duration);
    const pack = packFromUrl(e.name);
    if (!pack) continue;
    let entry = byPack.get(pack);
    if (!entry) {
      entry = { pack, bytes: 0, sumDuration: 0, files: 0, cached: 0, start: Infinity, end: -Infinity, slowest: 0 };
      byPack.set(pack, entry);
    }
    entry.bytes += bytes;
    entry.sumDuration += e.duration || 0;
    entry.files += 1;
    if (!e.transferSize) entry.cached += 1;
    entry.start = Math.min(entry.start, e.startTime || 0);
    entry.end = Math.max(entry.end, (e.startTime || 0) + (e.duration || 0));
    if ((e.duration || 0) > entry.slowest) entry.slowest = e.duration || 0;
  }
  for (const entry of byPack.values()) {
    entry.spanMs = entry.end > entry.start ? entry.end - entry.start : 0;
    entry.avgMs = entry.files ? entry.sumDuration / entry.files : 0;
  }
  return {
    byPack,
    totals: {
      resourceCount,
      bytes: allBytes,
      spanMs: allEnd > allStart ? allEnd - allStart : 0,
    },
  };
}

// ============================================================================
// SECTION 7 — THE GOVERNOR: a scheduler layer over the page's own tick sources
// ============================================================================
// The rest of this file answers "what costs frames". This half answers "and now
// what" — because naming a 3-second setInterval does not stop it, and a panel
// that only measures a blocked main thread is a spectator.
//
// What it sits between: the page's own tick sources and the browser.
//   * Every setInterval / setTimeout / requestAnimationFrame registered after
//     this module loads is measured per source (registration site, delay, cost)
//     and can be given a policy: normal, ½ speed, ¼ speed, 2/s, 1/s, pause.
//   * Redraw requests (LGraphCanvas.setDirty) that arrive more than once in the
//     same display frame are merged instead of each being honoured.
//   * An adaptive rAF mode lowers the callback rate while the main thread is
//     behind its frame budget AND nobody is interacting, with a hard floor so a
//     loop can never starve.
//   * A worker lane for pure compute, with the honest boundary spelled out in
//     LIMITS at the bottom: Vue's render, the DOM and canvas pixels cannot move
//     off the main thread at all.
//
// Two invariants the implementation never breaks:
//   1. A source with the "normal" policy is measured and otherwise untouched:
//      same call, same arguments, same return value, and the ids returned by
//      setInterval/setTimeout/requestAnimationFrame are the browser's own, so
//      clearInterval/clearTimeout/cancelAnimationFrame keep working untouched.
//   2. A limited source is slowed, never silenced. A skipped interval tick is
//      covered by the next tick; a skipped one-shot or chained timeout/rAF
//      callback is re-scheduled for when its window opens; the adaptive rAF
//      mode force-runs a callback after a bounded number of skips.
//
// Everything here is opt-in. With default settings the only difference to the
// page is the measurement itself (plus whatever it shows in the Stalls tab).

const GOV_ATTR_PER_SEC = 25; // registration-stack samples per second (attribution)
const GOV_MAX_SOURCES = 400; // bounded registry: beyond this, sources share a bucket
const GOV_RAF_REQUESTED_MS = 1000 / 60;
const GOV_PERSIST_KEY = "ants-governor-v1";
const GOV_IDLE_MS = 150; // no input for this long counts as "nobody is interacting"

// A policy turns "how often the source wants to run" into "how often it may".
// The gap is a minimum spacing between runs; "normal" imposes none at all.
const GOV_POLICIES = [
  { id: "full", label: "normal", gap: 0, untouched: true },
  { id: "half", label: "½ speed", factor: 2, floorMs: 33 },
  { id: "quarter", label: "¼ speed", factor: 4, floorMs: 66 },
  { id: "hz2", label: "2 /s", gap: 500 },
  { id: "hz1", label: "1 /s", gap: 1000 },
  { id: "pause", label: "pause", pause: true },
];
const GOV_POLICY_BY_ID = new Map(GOV_POLICIES.map((p) => [p.id, p]));

const GOV_KIND_LABEL = { interval: "setInterval", timeout: "setTimeout", raf: "rAF" };

const GOV = {
  installed: false,
  installError: null,
  orig: null,
  internalDepth: 0, // >0 while this file registers one of its own timers
  running: null, // the source whose callback is on the stack right now
  sources: new Map(), // key -> source (shared by equal registrations)
  live: new Map(), // browser timer id -> source, so clear*() can cancel deferrals
  pendingByRegistration: null, // timer id -> {handle, src}: a deferred copy of that registration
  savedPolicies: null, // from localStorage, applied as sources appear
  attrTokens: 0,
  lastAttrAt: 0,
  counters: { skipped: 0, deferred: 0, coalesced: 0, redrawReqs: 0, forced: 0, errors: 0, autolimited: 0, inputLifted: 0 },
  auto: { measuredMsPerSec: 0, reachableMsPerSec: 0, note: "", lastAt: 0, actions: [], mine: [] },
  disabled: false,
  offReason: "",
  runningReg: null,
  skipRing: new Ring(256),
  coalescedRing: new Ring(256),
  overheadMs: 0,
  overheadPerSec: 0,
  lastFrameGap: 0,
  lastBlockMs: 0,
  lastBlockAt: -1e9,
  lastInputAt: -1e9,
  inputSeen: false,
  rafSkippedInARow: 0,
  overBudget: false,
  redraw: null, // {frame, fg, bg} — the current frame's merged redraw request
  traces: [],
  traceVersion: 0,
  selfTest: null,
  controls: {
    budgetMs: 12,
    rafMode: "off", // "off" | "adaptive"
    rafMinHz: 20,
    coalesce: false,
    inputGuard: true,
    adaptiveSkipMax: 3,
    traceMinMs: 50,
    traceCap: 40,
    // Autopilot: off by default. When on, the layer itself caps the worst
    // offender every few seconds until the sources it can reach stop burning
    // more than autoTargetMsPerSec between them. It is the answer to "I opened
    // the panel, saw a 646 ms/s row, and did not want to pick a policy by hand".
    autoLimit: false,
    autoTargetMsPerSec: 250,
    autoMinMsPerSec: 30,
  },
  worker: { available: false, why: "not probed", jobs: 0, mainMs: 0, offThreadMs: 0, lastError: null },
};

function govPolicy(src) {
  return GOV_POLICY_BY_ID.get(src.policy) || GOV_POLICY_BY_ID.get("full");
}

// Minimum spacing between runs for this source under its current policy.
// A source owned by this file is never gated, whatever a policy says: the
// profiler slowing its own refresh down is handled (and tunable) elsewhere and
// must not depend on a table row a user can click.
function govMinGap(src) {
  if (src.ours) return 0;
  const pol = govPolicy(src);
  // "normal" has to mean exactly what the tab says: measured, otherwise
  // untouched. Gating a source at its own asked-for delay looks harmless and is
  // not - the browser fires "100ms" timers a millisecond early sometimes, and a
  // repaint interval that loses those ticks stops repainting (see the note on
  // registrations in govNewReg).
  if (pol.untouched) return 0;
  if (pol.pause) return Infinity;
  if (pol.gap) return pol.gap;
  const requested = src.requestedMs > 0 ? src.requestedMs : GOV_RAF_REQUESTED_MS;
  return Math.max(requested * (pol.factor || 1), pol.floorMs || 0);
}

// How far apart this source's runs actually land. A timer that asks for 10ms
// but takes 300ms of work runs every ~300ms, and a limit has to be wider than
// that to change anything - which is exactly why "half speed" (33ms here) is a
// no-op on a runaway chain, and why the suggestion used to look useless.
function govObservedPeriodMs(src) {
  const ring = src.ring;
  if (!ring || ring.n < 2) return 0;
  const span = ring.lastT() - ring.firstT();
  if (!(span > 0)) return 0;
  return span / (ring.n - 1);
}

// The gap a policy would impose on this source, without applying it.
function govGapForPolicy(src, pol) {
  if (!pol || pol.untouched) return 0;
  if (pol.pause) return Infinity;
  if (pol.gap) return pol.gap;
  const requested = src.requestedMs > 0 ? src.requestedMs : GOV_RAF_REQUESTED_MS;
  return Math.max(requested * (pol.factor || 1), pol.floorMs || 0);
}

const GOV_AUTO_LADDER = ["half", "quarter", "hz2", "hz1"];

// Cost per second a policy would leave a source at: its measured cost per run at
// the new rate, capped by the rate it has right now (a limit can only slow a
// source down, never speed it up, so the current rate is a safe ceiling).
function govPredictedMsPerSec(perRunMs, gapMs, currentRatePerSec) {
  if (!(perRunMs > 0) || !(gapMs > 0) || !Number.isFinite(gapMs)) return 0;
  const rate = currentRatePerSec > 0 ? Math.min(1000 / gapMs, currentRatePerSec) : 1000 / gapMs;
  return rate * perRunMs;
}

// The limit to hand a source, walking the ladder from the mild end. A candidate
// has to do two things, and both rules come from the same real page:
//   * it has to *bite* — a 33ms cap cannot slow anything that already runs once
//     every 300ms, so multipliers are skipped for a runaway chain;
//   * it has to *pay* — a cap that bites but leaves the source at 97% of what it
//     was costing (a 316ms-per-run chain capped at 2/s) is a sticker, not a
//     limit. With a goal the walk continues past such a candidate; without one
//     the first candidate that bites is enough.
// `opts.current` is the policy already in place: the walk then only accepts a
// real step up from it, so a row is never re-tightened to where it already is.
function govPickPolicy(src, opts) {
  const o = opts || {};
  const cur = o.current ? GOV_POLICY_BY_ID.get(o.current) : null;
  const curGap = cur ? govGapForPolicy(src, cur) : 0;
  const period = o.periodMs > 0 ? o.periodMs : govObservedPeriodMs(src);
  const goal = o.goalMsPerSec > 0 ? o.goalMsPerSec : 0;
  let mildest = null;
  for (const id of GOV_AUTO_LADDER) {
    const gap = govGapForPolicy(src, GOV_POLICY_BY_ID.get(id));
    if (!Number.isFinite(gap)) continue;
    if (curGap && !(gap > curGap * 1.15)) continue; // not a step up from what is there
    if (period > 0 && gap < period * 1.15) continue; // would not slow it down
    if (!mildest) mildest = id;
    if (!goal) return id;
    if (govPredictedMsPerSec(o.perRunMs, gap, o.ratePerSec) <= goal) return id;
  }
  return mildest; // nothing on the ladder reaches the goal: the mildest bite will do
}

// Would this row's current limit actually change anything? Used by the table so
// a limit that cannot bite says so instead of looking like a working limit.
function govLimitIsNoop(row) {
  if (row.ours || row.policy === "full" || row.kind === "raf") return false;
  if (!(row.perRunMs > 0) || !(row.effectiveMs > 0)) return false;
  return row.effectiveMs < row.perRunMs * 1.15;
}

function govEffectiveMs(src) {
  const gap = govMinGap(src);
  if (!Number.isFinite(gap)) return NaN;
  if (gap <= 0) return Math.max(1, Math.round(src.requestedMs || GOV_RAF_REQUESTED_MS));
  return Math.round(gap);
}

function govDisplayKey(src) {
  const where = src.file ? ` @ ${src.file}` : "";
  return `${src.kind}|${src.name}${where}`;
}

function govSourceLabel(src) {
  const where = src.file ? ` @ ${src.file}${src.line ? `:${src.line}` : ""}` : "";
  return `${src.name}${where}`;
}

// ------------------------------------------------------------- install -----
// Wrapped at module load, not in setup(): core and other extensions register
// their heartbeats during startup, and a source registered before the wrapper
// exists is a source this layer can never see.

function govOwn(fn) {
  GOV.internalDepth++;
  try {
    return fn();
  } finally {
    GOV.internalDepth--;
  }
}

function govTrack(kind, fn, requestedMs) {
  const name = (fn && fn.name) || "(anonymous)";
  const ms = kind === "raf" ? 0 : Math.max(0, Number(requestedMs) || 0);
  const key = `${kind}|${name}|${ms}`;
  let src = GOV.sources.get(key);
  if (src) {
    if (src.provisional && !src.ours) govAttribute(src);
    return src;
  }
  if (GOV.sources.size >= GOV_MAX_SOURCES) {
    const overflowKey = `${kind}|(registry full)`;
    src = GOV.sources.get(overflowKey);
    if (src) return src;
    src = govNewSource(overflowKey, kind, "(registry full)", ms);
    GOV.sources.set(overflowKey, src);
    return src;
  }
  src = govNewSource(key, kind, name, ms);
  GOV.sources.set(key, src);
  govApplySaved(src);
  govAttribute(src);
  return src;
}

// One registration is one timer, or one rAF chain. The *limit* belongs to the
// row (a user tunes "checkAndRepaint" and expects that row's runs/s to fall, and
// one heavy function used by three graph views is one offender, not three), but
// the *deferred copy* is per registration: a row can hold several chains, and a
// single shared deferral slot let one chain's pending copy starve the others.
function govNewReg(src) {
  return { src, pending: null, pendingId: null, pendingFn: null, reRegistered: false };
}

function govNewSource(key, kind, name, requestedMs) {
  return {
    key,
    kind,
    name,
    file: null,
    line: "",
    requestedMs,
    fires: 0,
    ms: 0,
    worst: 0,
    ring: new Ring(64),
    skipped: 0,
    deferred: 0,
    registrations: 0,
    ours: GOV.internalDepth > 0,
    provisional: true,
    attribution: "pending",
    policy: "full",
    firstSeen: nowMs(),
    lastRunAt: -1e9,
    lastFnMs: 0,
    samples: 0,
    policySetAt: 0,
    firesAtPolicySet: 0,
  };
}

// Attribution of a new source: the stack at registration time names the file
// and line that called setInterval/setTimeout/requestAnimationFrame. Sampling
// (not every registration) keeps the profiler's own cost invisible: a heartbeat
// registers once and is usually attributed on the first try, while a debounce
// storm costs at most a couple of stacks per second.
function govAttribute(src) {
  const t = nowMs();
  const gap = t - GOV.lastAttrAt;
  GOV.attrTokens = Math.min(2, GOV.attrTokens + (GOV_ATTR_PER_SEC * gap) / 1000);
  if (GOV.attrTokens < 1) return;
  GOV.attrTokens -= 1;
  GOV.lastAttrAt = t;
  if (src.kind === "interval") {
    // An interval registers once and then lives for the session, so it must be
    // attributed on that one chance. Intervals are counted in tens, not
    // thousands, so paying for a stack each time is not a hot-path cost.
    GOV.attrTokens = Math.min(2, GOV.attrTokens + 1);
  }
  let info = null;
  try {
    info = parseCallerStack(new Error().stack);
  } catch (e) {
    return;
  }
  src.samples++;
  if (!info || !info.file) return;
  const beforeKey = govDisplayKey(src);
  src.file = info.file;
  src.line = info.line || "";
  src.provisional = false;
  src.attribution = "registration stack";
  if (info.fn && info.fn !== "(anonymous)" && src.name === "(anonymous)") src.name = info.fn;
  govApplySaved(src, beforeKey);
}

// A saved limit is keyed by what the row said when it was set. Rows gain their
// file name as attribution arrives, so a policy saved against the unattributed
// key is re-attached the moment the source can be named.
function govApplySaved(src, provisionalKey) {
  if (!GOV.savedPolicies || src.ours) return;
  const want = GOV.savedPolicies[govDisplayKey(src)] || (provisionalKey ? GOV.savedPolicies[provisionalKey] : null);
  if (!want || !GOV_POLICY_BY_ID.has(want) || src.policy === want) return;
  src.policy = want;
  src.policySetAt = nowMs();
  src.firesAtPolicySet = src.fires;
}

// Fail open, then get out of the way. This layer replaces setTimeout,
// setInterval and requestAnimationFrame inside somebody else's application: an
// exception in here must never stop a callback from running, and after a few
// internal errors the layer has to remove itself rather than keep gambling with
// a UI it cannot see. The panel and the report both say when that happened, and
// the panel has the same button for when the user decides it, not the counter.
const GOV_FAIL_OPEN_AFTER = 3;

function govFailOpen(where, err) {
  GOV.counters.errors++;
  const msg = (err && err.message) || String(err);
  warnOnce(`gov-error-${where}`, `Scheduler layer error in ${where}: ${msg}`);
  if (GOV.counters.errors >= GOV_FAIL_OPEN_AFTER) {
    govUninstall(`its own ${GOV.counters.errors} errors (last: ${where} — ${msg})`);
  }
}

function govUninstall(reason) {
  if (GOV.disabled) return false;
  GOV.disabled = true;
  GOV.offReason = reason || "turned off";
  try {
    const g = typeof globalThis !== "undefined" && globalThis ? globalThis : null;
    const targets = [];
    if (g) targets.push(g);
    try {
      if (typeof window !== "undefined" && window && window !== g) targets.push(window);
    } catch (e) {
      /* an embedder with a hostile window proxy */
    }
    const keys = ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "requestAnimationFrame", "cancelAnimationFrame"];
    for (const target of targets) {
      for (const k of keys) {
        if (GOV.orig && typeof GOV.orig[k] === "function") {
          try {
            target[k] = GOV.orig[k];
          } catch (e) {
            /* read-only host object: the pass-through in govRun still applies */
          }
        }
      }
    }
    // Anything the page still has registered goes through the wrapper, which is
    // now a straight call to the real callback; drop the deferrals we queued.
    for (const reg of GOV.live.values()) {
      if (reg && reg.pending !== null) {
        try {
          if (GOV.orig && GOV.orig.clearTimeout) GOV.orig.clearTimeout(reg.pending);
        } catch (e) {
          /* already fired */
        }
        reg.pending = null;
      }
    }
    GOV.live.clear();
    if (GOV.pendingByRegistration) GOV.pendingByRegistration.clear();
    GOV.overBudget = false;
    GOV.adaptiveForced = false;
    warnOnce("gov-off", `Scheduler layer turned off: ${GOV.offReason}. The page's own timers are back to untouched.`);
  } catch (e) {
    /* nothing left to restore */
  }
  return true;
}

function govInstall() {
  if (GOV.installed || GOV.installError) return;
  try {
    let g = null;
    try {
      g = typeof globalThis !== "undefined" && globalThis ? globalThis : null;
    } catch (e) {
      g = null;
    }
    if (!g || typeof g.setTimeout !== "function") return;
    // Bound to the page's global. Chrome throws "Illegal invocation" if
    // setTimeout/clearTimeout are called with `this` set to anything but the
    // global object, and this layer calls them as methods of its own bookkeeping
    // object - which is exactly how it switched itself off on a real page
    // (three dispatch errors, then fail-open). Chrome allows the unbound form
    // only when `this` is undefined, so the wrapped calls still pass the page's
    // own `this` through untouched.
    const bound = (fn) => (typeof fn === "function" ? fn.bind(g) : null);
    GOV.orig = {
      setTimeout: bound(g.setTimeout),
      clearTimeout: bound(g.clearTimeout),
      setInterval: bound(g.setInterval),
      clearInterval: bound(g.clearInterval),
      requestAnimationFrame: bound(g.requestAnimationFrame),
      cancelAnimationFrame: bound(g.cancelAnimationFrame),
    };
    const targets = [g];
    try {
      if (typeof window !== "undefined" && window && window !== g) targets.push(window);
    } catch (e) {
      /* an embedder with a hostile window proxy: globalThis alone is enough */
    }
    for (const target of targets) {
      if (typeof target.setTimeout === "function") target.setTimeout = govWrapRegister(target.setTimeout, "timeout");
      if (typeof target.setInterval === "function") target.setInterval = govWrapRegister(target.setInterval, "interval");
      if (typeof target.clearTimeout === "function") target.clearTimeout = govWrapClear(target.clearTimeout);
      if (typeof target.clearInterval === "function") target.clearInterval = govWrapClear(target.clearInterval);
      if (typeof target.requestAnimationFrame === "function") target.requestAnimationFrame = govWrapRaf(target.requestAnimationFrame);
      if (typeof target.cancelAnimationFrame === "function") target.cancelAnimationFrame = govWrapCancel(target.cancelAnimationFrame);
    }
    govInstallInputGuard();
    govProbeWorker();
    govLoad();
    // The autopilot runs on its own exempt timer: it has to work with the panel
    // closed, and it must never be slowed by the thing it is tuning.
    govOwn(() => setInterval(() => govAutoPilot(), GOV_AUTO_INTERVAL_MS));
    GOV.installed = true;
  } catch (e) {
    GOV.installError = e && e.message ? e.message : String(e);
    warnOnce("gov-install", `Scheduler layer not installed: ${GOV.installError}`);
  }
}

function govWrapRegister(orig, kind) {
  if (orig.__antsGovWrapped) return orig;
  const wrapped = function govWrapperFrame(fn, ms, ...rest) {
    if (typeof fn !== "function") return orig.apply(this, [fn, ms, ...rest]);
    let src = null;
    let reg = null;
    try {
      src = govTrack(kind, fn, ms);
      if (src.ours) return orig.call(this, fn, ms, ...rest);
      reg = govNewReg(src);
      if (GOV.runningReg) GOV.runningReg.reRegistered = true;
    } catch (e) {
      // Fail open: this is somebody else's application, and a profiler that
      // cannot measure a timer must still let it be registered.
      govFailOpen("timer registration", e);
      return orig.call(this, fn, ms, ...rest);
    }
    const real = orig.call(
      this,
      function () {
        GOV.live.delete(real);
        return govRun(src, reg, fn, this, arguments, real);
      },
      ms,
      ...rest
    );
    src.registrations++;
    if (real !== undefined && real !== null) GOV.live.set(real, reg);
    return real;
  };
  wrapped.__antsGovWrapped = true;
  return wrapped;
}

function govWrapClear(orig) {
  if (orig.__antsGovWrapped) return orig;
  const wrapped = function (id) {
    try {
      govCancelDeferral(id);
      const reg = GOV.live.get(id);
      if (reg) {
        GOV.live.delete(id);
        // A skipped one-shot callback is sitting in this registration's deferred
        // slot: if the caller cancels the timer, the deferred run goes with it.
        if (reg.pending !== null) {
          if (GOV.orig && GOV.orig.clearTimeout) GOV.orig.clearTimeout(reg.pending);
          reg.pending = null;
        }
      }
    } catch (e) {
      govFailOpen("clear", e);
    }
    return orig.call(this, id);
  };
  wrapped.__antsGovWrapped = true;
  return wrapped;
}

function govWrapCancel(orig) {
  if (orig.__antsGovWrapped) return orig;
  const wrapped = function (id) {
    try {
      govCancelDeferral(id);
      GOV.live.delete(id);
    } catch (e) {
      govFailOpen("cancelAnimationFrame", e);
    }
    return orig.call(this, id);
  };
  wrapped.__antsGovWrapped = true;
  return wrapped;
}

// rAF is wrapped for the same reason as timers, and it is how a self-scheduling
// render loop becomes governable: a loop that calls requestAnimationFrame from
// inside itself re-registers through this wrapper on its next tick, so a loop
// that started before this module loaded is still measured and limitable from
// the tick after that.
function govWrapRaf(orig) {
  if (orig.__antsGovWrapped) return orig;
  const wrapped = function govWrapperFrame(cb) {
    if (typeof cb !== "function") return orig.call(this, cb);
    let src = null;
    let reg = null;
    try {
      src = govTrack("raf", cb, 0);
      if (src.ours) return orig.call(this, cb);
      reg = govNewReg(src);
      if (GOV.runningReg) GOV.runningReg.reRegistered = true;
    } catch (e) {
      govFailOpen("rAF registration", e);
      return orig.call(this, cb);
    }
    const handle = orig.call(this, function (ts) {
      GOV.live.delete(handle);
      return govRun(src, reg, cb, this, [ts], handle);
    });
    src.registrations++;
    if (handle !== undefined && handle !== null) GOV.live.set(handle, reg);
    return handle;
  };
  wrapped.__antsGovWrapped = true;
  return wrapped;
}

// ------------------------------------------------------------- dispatch ----

function govRun(src, reg, fn, thisArg, args, registrationId) {
  // Once this layer has taken itself out (or been switched off from the panel)
  // it must be nothing but a pass-through: these wrappers stay installed on
  // timers the page registered before it gave up.
  if (GOV.disabled || !reg) return fn.apply(thisArg, args);
  const tEnter = performance.now();
  let gap = govMinGap(src);
  let adaptive = false;
  GOV.adaptiveForced = false;
  if (src.kind === "raf" && GOV.controls.rafMode === "adaptive" && govAdaptiveWants(src, tEnter)) {
    const adaptiveGap = govAdaptiveGap();
    if (adaptiveGap > gap) {
      gap = adaptiveGap;
      adaptive = true;
    }
  }
  const cappedGap = gap;
  if (
    gap > GOV_DISPLAY_FLOOR_MS &&
    src.display &&
    GOV.controls.inputGuard &&
    govInputRecently(tEnter)
  ) {
    // Dragging a 4K canvas is exactly the moment a repaint cap turns into a
    // slideshow. The cap comes back as soon as the pointer stops.
    gap = GOV_DISPLAY_FLOOR_MS;
  }
  try {
    if (gap > 0 && tEnter - src.lastRunAt < gap) {
      const late = tEnter - src.lastRunAt;
      src.skipped++;
      GOV.counters.skipped++;
      if (adaptive) GOV.rafSkippedInARow++;
      if (!S.paused) GOV.skipRing.push(tEnter, 1);
      // A paused source is dropped, never deferred: "wait forever" handed to
      // setTimeout() comes back as a 1ms timer, which is the opposite of pause.
      const waivable = adaptive || Number.isFinite(gap);
      if (waivable && (src.kind === "timeout" || src.kind === "raf")) {
        govDefer(reg, src, fn, thisArg, args, Math.max(1, gap - late), registrationId);
      }
      GOV.overheadMs += Math.max(0, performance.now() - tEnter);
      return undefined;
    }
    if (adaptive) GOV.rafSkippedInARow = 0;
    if (gap < cappedGap && tEnter - src.lastRunAt < cappedGap) {
      // It would have been skipped by the cap and it is running because a human
      // is interacting: counted, because that is the answer to "is the drag
      // slow, or is my own limit the thing making it slow".
      src.inputLifted = (src.inputLifted || 0) + 1;
      GOV.counters.inputLifted++;
    }
    if (GOV.adaptiveForced && reg.pending !== null && reg.pendingFn === fn && reg.pendingId !== null) {
      // The progress guarantee is about to run this exact callback, so the copy
      // deferred earlier would be a second run of it. One callback, one run.
      govCancelDeferral(reg.pendingId);
    }
  } catch (e) {
    govFailOpen("dispatch", e);
  }
  const out = govExecute(src, reg, fn, thisArg, args);
  try {
    // The callback's own time is counted as the callback's, not as this layer's.
    GOV.overheadMs += Math.max(0, performance.now() - tEnter - (src.lastFnMs || 0));
  } catch (e) {
    /* accounting only */
  }
  return out;
}

// Adaptive mode is allowed to bite only when the main thread is missing its
// budget AND no human is interacting, and only for a bounded number of ticks in
// a row, so a self-scheduling loop keeps making progress no matter what.
function govAdaptiveWants(src, t) {
  if (src.ours) return false;
  if (!govBehindBudget()) {
    GOV.rafSkippedInARow = 0;
    return false;
  }
  if (GOV.controls.inputGuard && govInputRecently(t)) return false;
  if (GOV.rafSkippedInARow >= Math.max(1, Number(GOV.controls.adaptiveSkipMax) || 3)) {
    GOV.rafSkippedInARow = 0;
    GOV.counters.forced++;
    GOV.adaptiveForced = true; // the run about to happen is the progress guarantee
    return false;
  }
  return true;
}

function govAdaptiveGap() {
  return 1000 / Math.max(1, Number(GOV.controls.rafMinHz) || 20);
}

function govBehindBudget() {
  const budget = Math.max(1, Number(GOV.controls.budgetMs) || 12);
  const gap = GOV.lastFrameGap;
  // Two independent signals, because either one alone can be blind: the gap
  // between display frames (what the browser is actually managing), and a
  // recent long animation frame (the main thread was demonstrably blocked).
  const gapBehind = Number.isFinite(gap) && gap > Math.max(16.7, budget) * 1.5;
  const blockBehind = GOV.lastBlockMs > budget && nowMs() - GOV.lastBlockAt < 1500;
  const behind = gapBehind || blockBehind;
  GOV.overBudget = behind;
  return behind;
}

function govExecute(src, reg, fn, thisArg, args) {
  const t0 = performance.now();
  if (reg) reg.reRegistered = false;
  src.lastRunAt = t0; // also for a deferred run: it is still a run
  const prev = GOV.running;
  const prevReg = GOV.runningReg;
  GOV.running = src;
  GOV.runningReg = reg;
  let ret;
  try {
    ret = fn.apply(thisArg, args);
  } finally {
    GOV.running = prev;
    GOV.runningReg = prevReg;
    try {
      const dt = performance.now() - t0;
      src.lastFnMs = dt;
      src.fires++;
      src.ms += dt;
      if (dt > src.worst) src.worst = dt;
      if (!S.paused) src.ring.push(t0, dt);
      if (reg && reg.pending !== null && reg.reRegistered) {
        // The callback keeps itself alive, so our deferred copy would become a
        // second chain for the same loop: cancel it and let the loop's own
        // registration win.
        if (GOV.orig && GOV.orig.clearTimeout) GOV.orig.clearTimeout(reg.pending);
        reg.pending = null;
        reg.pendingId = null;
        reg.pendingFn = null;
      }
    } catch (e) {
      govFailOpen("bookkeeping", e);
    }
  }
  return ret;
}

// Deferral uses the *original* timer functions, so a re-scheduled callback is
// never counted twice and never governed twice.
function govDefer(reg, src, fn, thisArg, args, delayMs, registrationId) {
  // One deferred copy per registration: a limited source can be late, but it can
  // never queue up work faster than the thing it is replacing did.
  if (!reg || reg.pending !== null || !Number.isFinite(delayMs) || !GOV.orig || !GOV.orig.setTimeout) return;
  GOV.counters.deferred++;
  src.deferred++;
  const handle = GOV.orig.setTimeout(() => {
    if (registrationId !== undefined && registrationId !== null) GOV.pendingByRegistration.delete(registrationId);
    reg.pending = null;
    reg.pendingId = null;
    reg.pendingFn = null;
    govExecute(src, reg, fn, thisArg, args);
  }, Math.max(1, Math.ceil(delayMs)));
  reg.pending = handle;
  reg.pendingId = registrationId === undefined ? null : registrationId;
  reg.pendingFn = fn;
  if (registrationId !== undefined && registrationId !== null) {
    if (!GOV.pendingByRegistration) GOV.pendingByRegistration = new Map();
    GOV.pendingByRegistration.set(registrationId, { handle, reg, src });
  }
}

// Cancel a deferred copy through the id the caller was given. Without this, a
// callback the caller cancelled would still run when its window opened, which
// is the kind of "governor broke my extension" bug that makes a tool unusable.
function govCancelDeferral(id) {
  if (!GOV.pendingByRegistration) return false;
  const rec = GOV.pendingByRegistration.get(id);
  if (!rec) return false;
  GOV.pendingByRegistration.delete(id);
  try {
    if (GOV.orig && GOV.orig.clearTimeout) GOV.orig.clearTimeout(rec.handle);
  } catch (e) {
    /* it already fired */
  }
  if (rec.reg && rec.reg.pending === rec.handle) {
    rec.reg.pending = null;
    rec.reg.pendingId = null;
    rec.reg.pendingFn = null;
  }
  return true;
}

// ---------------------------------------------------------- input guard ----
// Adaptive mode may only slow things down when nobody is typing, dragging or
// wheeling: input latency is the one cost a smoother graph may not pay for.

// A limit is a bet that the tick it skips is a tick nobody sees. That bet holds
// for a heartbeat that polls state and fails for anything that *draws*: cap the
// tick that repaints the canvas and the canvas stops repainting, which is the
// one thing a redraw cap must never be mistaken for. So a source that has ever
// run the canvas draw inside itself is marked as part of the display lane, and
// while somebody is actually dragging or typing, its cap is lifted down to this
// floor — about 30 redraws a second, the slowest a drag can look continuous.
// The moment the input stops, the limit is back exactly as it was.
const GOV_DISPLAY_FLOOR_MS = 33;

let govInputGuardInstalled = false;

function govInstallInputGuard() {
  if (govInputGuardInstalled) return;
  try {
    if (typeof window === "undefined" || !window || typeof window.addEventListener !== "function") return;
    const note = () => {
      GOV.lastInputAt = nowMs();
      GOV.inputSeen = true;
    };
    // Pointer events cover modern browsers; mouse events still arrive on their
    // own in older/embedded ones, and either is proof that somebody is there.
    for (const type of ["pointerdown", "pointermove", "mousedown", "mousemove", "keydown", "wheel", "touchstart"]) {
      window.addEventListener(type, note, { passive: true });
    }
    govInputGuardInstalled = true;
  } catch (e) {
    /* an embedder without window events just means the guard stays off */
  }
}

function govInputRecently(t, windowMs) {
  if (!GOV.inputSeen) return false;
  const ms = windowMs > 0 ? windowMs : GOV_IDLE_MS;
  return t - GOV.lastInputAt < ms;
}

// ------------------------------------------------- redraw request merging ---
// Called from the setDirty wrapper. LiteGraph only ever *sets* dirty flags from
// the truthy arguments it is handed, so within one display frame the union of
// the requests is all the canvas needs: the first request goes straight through,
// a later one only carries flags that were not requested yet, and a request that
// adds nothing is dropped and counted. A merged request never clears a flag, so
// the worst case is one extra redraw, never a stale canvas.

function govCoalesceRedraw(original, canvas, args) {
  const fg = args.length > 0 ? !!args[0] : true;
  const bg = args.length > 1 ? !!args[1] : false;
  const frame = S.renderTicks;
  const pending = GOV.redraw;
  if (!pending || pending.frame !== frame) {
    GOV.redraw = { frame, fg, bg };
    return original.apply(canvas, args);
  }
  GOV.counters.redrawReqs++;
  const needFg = fg && !pending.fg;
  const needBg = bg && !pending.bg;
  if (!needFg && !needBg) {
    GOV.counters.coalesced++;
    if (!S.paused) GOV.coalescedRing.push(performance.now(), 1);
    return undefined;
  }
  if (needFg) pending.fg = true;
  if (needBg) pending.bg = true;
  return original.call(canvas, pending.fg, pending.bg);
}

// ------------------------------------------------------------- policies ----

function govSetPolicy(displayKey, policyId) {
  const pol = GOV_POLICY_BY_ID.get(policyId);
  if (!pol) return false;
  let touched = 0;
  for (const src of GOV.sources.values()) {
    if (govDisplayKey(src) !== displayKey) continue;
    if (src.ours && pol.id !== "full") continue; // this file's own timers stay out of it
    if (src.policy === pol.id) continue;
    src.policy = pol.id;
    src.policySetAt = nowMs();
    src.firesAtPolicySet = src.fires;
    touched++;
  }
  if (touched || pol.id === "full") govSave();
  return touched > 0;
}

function govSetControl(key, value) {
  if (!(key in GOV.controls)) return false;
  GOV.controls[key] = value;
  if (key === "rafMode" || key === "rafMinHz" || key === "adaptiveSkipMax") GOV.rafSkippedInARow = 0;
  govSave();
  return true;
}

// Suggested limits: derived from what this session actually measured, and only
// applied to a source the panel can see burning real milliseconds.
//
// Two rules, both learned from a real page. The ranking is by measured cost per
// second, NOT by run rate: the worst offenders on that page ran 1-3 times a
// second because each run took 300-470ms, and the old "at least 4 runs/s" guard
// skipped both of them while offering limits to a dozen 0.1 ms/s heartbeats. And
// the policy has to be one that can bite: for a source whose runs are 300ms
// apart, "half speed" (33ms) is a no-op, so the ladder skips to a real cap.
function govSuggest() {
  const rows = govRows();
  const applied = [];
  for (const r of rows) {
    if (r.ours || r.kind === "raf") continue;
    // The display lane is exempt from *suggestions*: a redraw source capped
    // below the rate its page asks for is a broken page, not a faster one.
    if (r.display) continue;
    const pressure = Math.max(r.msPerSec, r.pressureMsPerSec || 0);
    if (pressure < 5) continue; // it has to be costing something real
    const src = govHeaviestSource(r);
    if (!src) continue;
    // Aim to at least halve what this row costs, and never below the floor (a
    // source that is already cheap gets the mildest limit that bites).
    const goal = Math.max(GOV.controls.autoMinMsPerSec, pressure / 2);
    const wasNoop = r.policy !== "full" && govLimitIsNoop(r);
    const id = govPickPolicy(src, {
      current: r.policy === "full" ? null : r.policy,
      goalMsPerSec: goal,
      perRunMs: r.perRunMs,
      ratePerSec: r.runsPerSec,
    });
    if (!id) continue; // already at the tightest limit that would change anything
    const gap = govGapForPolicy(src, GOV_POLICY_BY_ID.get(id));
    const predicted = Math.round(govPredictedMsPerSec(r.perRunMs, gap, r.runsPerSec));
    if (!govSetPolicy(r.key, id)) continue;
    // The window figure is what it cost in the last few seconds; the pressure
    // figure is what its mean run costs at the rate it is running. When they
    // disagree the second is the honest one, so both are shown.
    const spread =
      r.pressureMsPerSec > r.msPerSec * 2
        ? `; ${fmtMs(r.perRunMs)}/run × ${fmtRate(r.runsPerSec)}/s ≈ ${Math.round(r.pressureMsPerSec)} ms/s at its current rate`
        : "";
    applied.push(
      `${r.name} → ${GOV_POLICY_BY_ID.get(id).label} ` +
        `(was ${Math.round(r.msPerSec)} ms/s${spread}, ≈${predicted} after` +
        `${wasNoop ? "; the limit that was there could not bite" : ""})`
    );
  }
  return applied;
}

// The member of a grouped row that has actually run the most, for reading a
// live ring (the row itself is only a snapshot).
function govHeaviestSource(row) {
  const members = row.sources;
  if (!members || !members.length) return null;
  let best = null;
  for (const s of members) if (!best || s.fires > best.fires) best = s;
  return best;
}

// ------------------------------------------------------------- autopilot ----
// Opt-in. Every GOV_AUTO_INTERVAL_MS it looks at the sources it is allowed to
// touch (not ours, not rAF - those have their own governor - and not anything
// already limited), and if they are burning more than autoTargetMsPerSec it
// caps the worst one with the mildest policy that actually bites. One row per
// round, never re-tightening a row it already moved, and it says what it did in
// the panel and in the copied report. "Reset to untouched" turns it off.
const GOV_AUTO_INTERVAL_MS = 5000;

function govAutoPilot() {
  if (GOV.disabled || !GOV.controls.autoLimit || S.paused) return GOV.auto.note;
  GOV.auto.lastAt = nowMs();
  const rows = govRows();
  const candidates = [];
  let measured = 0;
  let reachable = 0;
  for (const r of rows) {
    if (r.ours || r.kind === "raf") continue;
    measured += r.msPerSec;
    // Rows the pilot limited itself stay in play: the first cap that bites
    // usually is not the last one needed, and a chain whose *work* is longer
    // than the gap between its runs (a 316ms render at 2/s) has to be walked
    // up the ladder until it is actually cheaper. Limits set by hand are left
    // alone — the pilot does not touch other people's work.
    const mine = r.policy !== "full" && GOV.auto.mine.indexOf(r.key) >= 0;
    if (r.policy === "full") reachable += r.msPerSec;
    else if (!mine) continue;
    if (r.msPerSec < GOV.controls.autoMinMsPerSec) continue;
    candidates.push(r);
  }
  GOV.auto.measuredMsPerSec = measured;
  GOV.auto.reachableMsPerSec = reachable;
  const target = Math.max(1, Number(GOV.controls.autoTargetMsPerSec) || 250);
  if (measured <= target) {
    GOV.auto.note = `under target (${Math.round(measured)} of ${target} ms/s)`;
    return GOV.auto.note;
  }
  // The worst row the pilot may still act on, and the next limit up for it.
  let worst = null;
  let id = null;
  let blocked = null;
  for (const r of candidates) {
    const src = govHeaviestSource(r);
    if (!src) continue;
    // What this row would have to cost for the *page* to be at target: no point
    // capping it harder than that (the mildest cap that reaches the goal wins).
    const goal = Math.max(GOV.controls.autoMinMsPerSec, target - (measured - r.msPerSec));
    const next = govPickPolicy(src, {
      current: r.policy === "full" ? null : r.policy,
      goalMsPerSec: goal,
      perRunMs: r.perRunMs,
      ratePerSec: r.runsPerSec,
    });
    if (next) {
      worst = r;
      id = next;
      break;
    }
    if (!blocked) blocked = r;
  }
  if (!worst) {
    GOV.auto.note = blocked
      ? `over target (${Math.round(measured)} of ${target} ms/s); ${blocked.name} is at the tightest cap a limit can use ` +
        `(${Math.round(blocked.msPerSec)} ms/s left) — that loop needs fixing at its source`
      : `over target (${Math.round(measured)} of ${target} ms/s) but nothing left to limit`;
    return GOV.auto.note;
  }
  const src = govHeaviestSource(worst);
  if (!govSetPolicy(worst.key, id)) {
    GOV.auto.note = `could not limit ${worst.name}`;
    return GOV.auto.note;
  }
  GOV.counters.autolimited++;
  if (GOV.auto.mine.indexOf(worst.key) < 0) GOV.auto.mine.push(worst.key);
  const gapMs = govGapForPolicy(src, GOV_POLICY_BY_ID.get(id));
  const action = {
    at: GOV.auto.lastAt,
    key: worst.key,
    label: worst.label,
    to: id,
    label2: (GOV_POLICY_BY_ID.get(id) || {}).label || id,
    measuredMsPerSec: Math.round(worst.msPerSec),
    gapMs: Math.round(gapMs),
    predictedMsPerSec: Math.round(govPredictedMsPerSec(worst.perRunMs, gapMs, worst.runsPerSec)),
  };
  GOV.auto.actions.unshift(action);
  if (GOV.auto.actions.length > 12) GOV.auto.actions.length = 12;
  GOV.auto.note =
    `limited ${worst.name} to ${action.label2} (it was burning ${action.measuredMsPerSec} ms/s, ` +
    `≈${action.predictedMsPerSec} after — still ${Math.round(Math.max(0, measured - worst.msPerSec + action.predictedMsPerSec))} ms/s in total)`;
  return GOV.auto.note;
}

function govReset() {
  for (const src of GOV.sources.values()) {
    src.policy = "full";
    src.policySetAt = 0;
    src.firesAtPolicySet = 0;
  }
  Object.assign(GOV.controls, {
    budgetMs: 12,
    rafMode: "off",
    rafMinHz: 20,
    coalesce: false,
    inputGuard: true,
    adaptiveSkipMax: 3,
    traceMinMs: 50,
    traceCap: 40,
    autoLimit: false,
    autoTargetMsPerSec: 250,
    autoMinMsPerSec: 30,
  });
  GOV.auto.actions.length = 0;
  GOV.auto.mine.length = 0;
  GOV.auto.note = "";
  GOV.rafSkippedInARow = 0;
  GOV.redraw = null;
  govSave();
}

function govSave() {
  try {
    if (typeof localStorage === "undefined" || !localStorage) return;
    const policies = {};
    for (const src of GOV.sources.values()) {
      if (src.policy !== "full") policies[govDisplayKey(src)] = src.policy;
    }
    GOV.savedPolicies = policies;
    localStorage.setItem(GOV_PERSIST_KEY, JSON.stringify({ controls: GOV.controls, policies }));
  } catch (e) {
    /* storage unavailable: tuning just does not survive a reload */
  }
}

function govLoad() {
  let data = null;
  try {
    if (typeof localStorage === "undefined" || !localStorage) return;
    const raw = localStorage.getItem(GOV_PERSIST_KEY);
    if (!raw) return;
    data = JSON.parse(raw);
  } catch (e) {
    return;
  }
  if (!data) return;
  if (data.controls) {
    for (const key in GOV.controls) {
      if (data.controls[key] === undefined) continue;
      GOV.controls[key] = data.controls[key];
    }
  }
  if (data.policies && typeof data.policies === "object") {
    GOV.savedPolicies = {};
    for (const [key, id] of Object.entries(data.policies)) {
      if (!GOV_POLICY_BY_ID.has(id)) {
        warnOnce(`gov-policy-${key}`, `Saved limit for "${key}" was not applied: unknown policy "${id}".`);
        continue;
      }
      GOV.savedPolicies[key] = id;
      govSetPolicy(key, id);
    }
  }
}

// -------------------------------------------------------------- metrics ----

function govRows() {
  const now = nowMs();
  const observedMs = Math.max(1000, Math.min(WINDOW_MS, Math.max(now - S.startedAt, 1000)));
  const groups = new Map();
  for (const src of GOV.sources.values()) {
    const key = govDisplayKey(src);
    let g = groups.get(key);
    if (!g) {
      g = {
        key,
        kind: src.kind,
        name: src.name,
        file: src.file,
        line: src.line,
        provisional: true,
        ours: true,
        requestedMs: src.requestedMs,
        registrations: 0,
        members: 0,
        fires: 0,
        ms: 0,
        worst: 0,
        skipped: 0,
        deferred: 0,
        sink: [],
        policySrc: src,
      };
      groups.set(key, g);
    }
    g.members++;
    g.registrations += src.registrations || 1;
    g.fires += src.fires;
    g.ms += src.ms;
    if (src.worst > g.worst) g.worst = src.worst;
    g.skipped += src.skipped;
    g.deferred += src.deferred;
    g.provisional = g.provisional && src.provisional;
    g.ours = g.ours && src.ours;
    g.sink.push(src);
  }
  const rows = [];
  for (const g of groups.values()) {
    // Windowed cost: only sources that ran inside the window are walked, so an
    // idle registry costs nothing to summarise.
    let winN = 0;
    let winMs = 0;
    for (const src of g.sink) {
      if (!src.ring.n) continue;
      if (!(src.ring.lastT() >= now - WINDOW_MS)) continue;
      const agg = src.ring.aggregate(now - WINDOW_MS);
      winN += agg.n;
      winMs += agg.sum;
    }
    const src = g.policySrc;
    const pol = GOV_POLICY_BY_ID.get(src.policy) || GOV_POLICY_BY_ID.get("full");
    const row = {
      key: g.key,
      label: g.name + (g.file ? ` @ ${g.file}${g.line ? `:${g.line}` : ""}` : ""),
      name: g.name,
      file: g.file || "",
      line: g.line || "",
      kind: g.kind,
      kindLabel: GOV_KIND_LABEL[g.kind] || g.kind,
      requestedMs: g.requestedMs,
      effectiveMs: pol.id === "full" ? Math.round(g.requestedMs || GOV_RAF_REQUESTED_MS) : govEffectiveMs(src),
      policy: pol.id,
      policyLabel: pol.label,
      ours: g.ours,
      provisional: g.provisional,
      registrations: g.registrations,
      fires: g.fires,
      worst: g.worst,
      skipped: g.skipped,
      deferred: g.deferred,
      runsPerSec: winN > 0 ? (winN / observedMs) * 1000 : 0,
      msPerSec: winMs > 0 ? (winMs / observedMs) * 1000 : 0,
      perRunMs: g.fires > 0 ? g.ms / g.fires : NaN,
      // What this source costs per second *at its current rate*, from its mean
      // run cost over its whole life. The window figure misses the scan that
      // only does real work every few seconds (its cheap early-exit runs land in
      // the window instead), and that is exactly the source worth capping.
      pressureMsPerSec: g.fires > 0 ? (g.ms / g.fires) * (winN > 0 ? (winN / observedMs) * 1000 : 0) : 0,
      // A grouped row is display-lane if any registration behind it ever drew
      // the canvas: the row exists to describe the source, and "this one can
      // repaint the page" is a property of it, not of the group bookkeeping.
      display: g.sink.some((x) => x.display),
      drew: g.sink.reduce((n, x) => n + (x.drew || 0), 0),
      inputLifted: g.sink.reduce((n, x) => n + (x.inputLifted || 0), 0),
      savedMsPerSec: 0,
      sourceRateBefore: NaN,
      sourceRateAfter: NaN,
    };
    // Non-enumerable: the panel and the autopilot need the live sources behind a
    // grouped row, but the snapshot must not serialize rings into the report.
    Object.defineProperty(row, "sources", { value: g.sink, enumerable: false });
    if (pol.id !== "full" && !g.ours && g.fires > 0) {
      // Estimate only: the ticks that did not run cannot be timed, so this is
      // the skipped rate times the mean cost of the ticks that did run.
      const lifetimeSec = Math.max(1, (now - src.firstSeen) / 1000);
      row.savedMsPerSec = (g.skipped / lifetimeSec) * (g.ms / g.fires);
      if (src.policySetAt) {
        const beforeSec = Math.max(0.25, (src.policySetAt - src.firstSeen) / 1000);
        const afterSec = Math.max(0.25, (now - src.policySetAt) / 1000);
        row.sourceRateBefore = src.firesAtPolicySet / beforeSec;
        row.sourceRateAfter = (src.fires - src.firesAtPolicySet) / afterSec;
      }
    }
    rows.push(row);
  }
  rows.sort((a, b) => b.msPerSec - a.msPerSec || b.fires - a.fires);
  return rows;
}

function govMetrics() {
  const now = nowMs();
  const rows = govRows();
  const observedMs = Math.max(1000, Math.min(WINDOW_MS, Math.max(now - S.startedAt, 1000)));
  const coalesced = GOV.coalescedRing.aggregate(now - WINDOW_MS).sum;
  let throttled = 0;
  let savedMsPerSec = 0;
  let inertCount = 0;
  let inertMsPerSec = 0;
  for (const r of rows) {
    if (r.policy !== "full" && !r.ours) {
      throttled++;
      // A limit that is narrower than the source's own period does nothing at
      // all: it never skips a tick, and the "estimated savings" for that row
      // would be fiction. Reported as a whole-row property, because that is what
      // it is.
      if (govLimitIsNoop(r)) {
        inertCount++;
        inertMsPerSec += r.msPerSec;
      }
    }
    savedMsPerSec += r.savedMsPerSec;
  }
  return {
    installed: GOV.installed,
    installError: GOV.installError,
    disabled: GOV.disabled,
    offReason: GOV.offReason,
    sources: rows,
    sourceCount: rows.length,
    throttled,
    inert: { count: inertCount, msPerSec: inertMsPerSec },
    registered: GOV.sources.size,
    ours: rows.filter((r) => r.ours).length,
    counters: { ...GOV.counters },
    skippedPerSec: (GOV.skipRing.aggregate(now - WINDOW_MS).sum / observedMs) * 1000,
    coalescedPerSec: (coalesced / observedMs) * 1000,
    savedMsPerSec,
    overheadMsPerSec: GOV.overheadPerSec,
    overBudget: GOV.overBudget,
    lastFrameGap: GOV.lastFrameGap,
    controls: { ...GOV.controls },
    worker: { ...GOV.worker },
    traceCount: GOV.traces.length,
    traceVersion: GOV.traceVersion,
    auto: {
      on: !!GOV.controls.autoLimit,
      targetMsPerSec: GOV.controls.autoTargetMsPerSec,
      minMsPerSec: GOV.controls.autoMinMsPerSec,
      measuredMsPerSec: GOV.auto.measuredMsPerSec,
      reachableMsPerSec: GOV.auto.reachableMsPerSec,
      mine: GOV.auto.mine.length,
      note: GOV.auto.note,
      actions: GOV.auto.actions.slice(0, 6),
      count: GOV.counters.autolimited,
      inert: inertCount,
    },
    selfTest: GOV.selfTest,
    policies: GOV_POLICIES,
  };
}

// ---------------------------------------------------------- frame traces ---
// The question the Stalls tab cannot answer: "this 1.3-second frame was
// attributed to renderFrame — but what else was in it?" A trace records, for
// every long animation frame, the scripts the browser named (with forced layout
// and invoker), which governed sources ran inside it with their measured cost,
// and how many redraw requests arrived (and were merged) while it was blocked.

// The heaviest governed source that ran inside a frame window. Used to attribute
// a frame whose only named script is this layer's own pass-through wrapper: the
// wrapper's inclusive duration is the page's cost, and this says whose it was.
function govBlameInFrame(start, end) {
  let best = null;
  for (const src of GOV.sources.values()) {
    if (!src.ring || !src.ring.n) continue;
    const range = ringRange(src.ring, start, end);
    if (!range.n) continue;
    if (!best || range.sum > best.ms) best = { src, ms: range.sum, runs: range.n };
  }
  return best;
}

function ringRange(ring, t0, t1) {
  if (!ring || !ring.n) return { n: 0, sum: 0 };
  const start = ring.aggregate(t0);
  const end = ring.aggregate(t1);
  return { n: start.n - end.n, sum: start.sum - end.sum };
}

function govRecordTrace(entry) {
  if (S.paused || !(GOV.controls.traceMinMs > 0)) return;
  const start = entry.startTime || 0;
  const duration = entry.duration || 0;
  if (duration < GOV.controls.traceMinMs) return;
  const end = start + duration;
  const scripts = [];
  let layoutMs = 0;
  for (const script of entry.scripts || []) {
    const ms = script.duration || 0;
    const forced = script.forcedStyleAndLayoutDuration || 0;
    layoutMs += forced;
    scripts.push({
      fn: script.sourceFunctionName || "(anonymous)",
      file: script.sourceURL ? shortUrl(script.sourceURL) : "(no url)",
      url: script.sourceURL || "",
      ms,
      layoutMs: forced,
      invoker: [script.invokerType, script.invoker].filter(Boolean).join(" ") || "",
    });
  }
  scripts.sort((a, b) => b.ms - a.ms);

  const ticks = [];
  for (const src of GOV.sources.values()) {
    if (!src.ring.n) continue;
    const range = ringRange(src.ring, start, end);
    if (!range.n) continue;
    ticks.push({
      key: govDisplayKey(src),
      label: govSourceLabel(src),
      kind: src.kind,
      count: range.n,
      ms: range.sum,
      policy: src.policy,
      ours: src.ours,
    });
  }
  ticks.sort((a, b) => b.ms - a.ms);

  // Who asked for the redraw inside this window. This is the answer to "what
  // mutates state under the Vue render loop": the requests themselves are
  // counted exactly, and their callers are sampled (~20/s), so this is the
  // measured sample, not a guess.
  const callers = [];
  for (const c of S.callers.values()) {
    const range = ringRange(c.ring, start, end);
    if (!range.n) continue;
    callers.push({ label: c.sig, file: c.file, count: range.n });
  }
  callers.sort((a, b) => b.count - a.count);
  if (callers.length > 3) callers.length = 3;

  const trace = {
    id: GOV.traceVersion + 1,
    start,
    duration,
    end,
    blocking: Number.isFinite(entry.blockingDuration) ? entry.blockingDuration : Math.max(0, duration - 50),
    layoutMs,
    scripts,
    ticks,
    redraws: ringRange(S.invalidations, start, end).n,
    coalesced: ringRange(GOV.coalescedRing, start, end).n,
    callers,
    limited: ticks.filter((t) => t.policy !== "full").map((t) => `${t.label} → ${(GOV_POLICY_BY_ID.get(t.policy) || {}).label || t.policy}`),
    overBudget: GOV.overBudget,
  };
  GOV.traces.unshift(trace);
  if (GOV.traces.length > Math.max(1, Number(GOV.controls.traceCap) || 40)) GOV.traces.length = Math.max(1, Number(GOV.controls.traceCap) || 40);
  GOV.traceVersion++;
}

// ---------------------------------------------------------------- worker ---
// Pure compute only, and only when the browser offers Worker + Blob. The worker
// source is a plain string so it can be unit-tested under node (see
// tests/governor.test.mjs) instead of taken on faith. Nothing here touches the
// DOM, Vue or the canvas: see LIMITS for why that is not a limitation of this
// implementation but of the platform.

const GOV_WORKER_SRC = [
  "// ANTs tracker governor worker: pure compute jobs only, no DOM, no Vue, no canvas.",
  "var JOBS = {",
  "  echo: function (arg) { return arg; },",
  "  sum: function (arg) {",
  "    var xs = arg || [];",
  "    var s = 0;",
  "    for (var i = 0; i < xs.length; i++) s += xs[i];",
  "    return s;",
  "  },",
  "  selftest: function (arg) {",
  "    // Deterministic workload: a seeded LCG into a big array, sorted, summed.",
  "    // The main thread runs exactly the same function for comparison.",
  "    var n = (arg && arg.n) || 120000;",
  "    var seed = (arg && arg.seed) || 123456789;",
  "    var xs = new Array(n);",
  "    for (var i = 0; i < n; i++) {",
  "      seed = (seed * 1103515245 + 12345) % 2147483648;",
  "      xs[i] = seed;",
  "    }",
  "    xs.sort(function (a, b) { return a - b; });",
  "    var sum = 0;",
  "    for (var j = 0; j < n; j++) sum += xs[j];",
  "    return { n: n, sum: sum, first: xs[0], last: xs[n - 1] };",
  "  },",
  "  run: function (arg) {",
  "    var fn = (0, eval)('(' + arg.source + ')');",
  "    return fn(arg.arg);",
  "  },",
  "};",
  "self.onmessage = function (e) {",
  "  var msg = e.data || {};",
  "  var now = function () { return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now(); };",
  "  var t0 = now();",
  "  try {",
  "    var job = JOBS[msg.job];",
  "    if (!job) throw new Error('unknown job: ' + msg.job);",
  "    var value = job(msg.arg);",
  "    self.postMessage({ id: msg.id, ok: true, value: value, ms: now() - t0 });",
  "  } catch (err) {",
  "    self.postMessage({ id: msg.id, ok: false, error: (err && err.message) || String(err) });",
  "  }",
  "};",
].join("\n");

const GOV_SELFTEST_ARGS = { n: 120000, seed: 123456789 };

// The identical workload, on the main thread, for an apples-to-apples number.
function govSelfTestMainThread(arg) {
  const n = (arg && arg.n) || GOV_SELFTEST_ARGS.n;
  let seed = (arg && arg.seed) || GOV_SELFTEST_ARGS.seed;
  const xs = new Array(n);
  for (let i = 0; i < n; i++) {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    xs[i] = seed;
  }
  xs.sort((a, b) => a - b);
  let sum = 0;
  for (let j = 0; j < n; j++) sum += xs[j];
  return { n, sum, first: xs[0], last: xs[n - 1] };
}

// Feature-detect only: no worker thread is created until something actually
// asks for off-thread work, because a profiler has no business spawning a
// thread the page did not ask for.
function govProbeWorker() {
  let available = false;
  let why = "no Worker/Blob/URL.createObjectURL in this environment (the lane stays on the main thread)";
  try {
    if (
      typeof Worker === "function" &&
      typeof Blob === "function" &&
      typeof URL !== "undefined" &&
      URL &&
      typeof URL.createObjectURL === "function"
    ) {
      available = true;
      why = "ready (the worker starts on first use)";
    }
  } catch (e) {
    available = false;
    why = e && e.message ? e.message : String(e);
  }
  GOV.worker.available = available;
  GOV.worker.why = why;
}

function govWorkerReady() {
  if (!GOV.worker.available) return false;
  try {
    if (!GOV.workerHandle) {
      const url = URL.createObjectURL(new Blob([GOV_WORKER_SRC], { type: "text/javascript" }));
      GOV.workerHandle = new Worker(url);
    }
  } catch (e) {
    GOV.worker.available = false;
    GOV.worker.why = `worker could not start: ${(e && e.message) || e}`;
    GOV.workerHandle = null;
    return false;
  }
  if (!GOV.workerPending) {
    GOV.workerPending = new Map();
    GOV.workerNextId = 1;
    GOV.workerHandle.onmessage = (e) => {
      const msg = (e && e.data) || {};
      const pending = GOV.workerPending.get(msg.id);
      if (!pending) return;
      GOV.workerPending.delete(msg.id);
      if (msg.ok) pending.resolve(msg);
      else pending.reject(new Error(msg.error || "worker job failed"));
    };
    GOV.workerHandle.onerror = (e) => {
      GOV.worker.lastError = (e && e.message) || "worker error";
      for (const [, pending] of GOV.workerPending) pending.reject(new Error(GOV.worker.lastError));
      GOV.workerPending.clear();
    };
  }
  return true;
}

// Off-thread lane. Arguments and results must be structured-cloneable, and a
// function passed here must be self-contained (no closures) — see LIMITS.
// A missing worker is not an error: the lane falls back to the main thread and
// says so, so a caller cannot silently get a different answer.
function govOffload(job, arg) {
  const isFn = typeof job === "function";
  if (!govWorkerReady()) {
    if (isFn) return Promise.resolve({ fellBack: true, value: job(arg), reason: GOV.worker.why });
    if (job === "selftest") return Promise.resolve({ fellBack: true, value: govSelfTestMainThread(arg), reason: GOV.worker.why });
    if (job === "echo") return Promise.resolve({ fellBack: true, value: arg, reason: GOV.worker.why });
    if (job === "sum") {
      const xs = arg || [];
      let s = 0;
      for (let i = 0; i < xs.length; i++) s += xs[i];
      return Promise.resolve({ fellBack: true, value: s, reason: GOV.worker.why });
    }
    return Promise.reject(new Error(`off-thread lane unavailable: ${GOV.worker.why}`));
  }
  const payload = isFn ? { job: "run", arg: { source: String(job), arg } } : { job, arg };
  const id = GOV.workerNextId++;
  GOV.worker.jobs++;
  const t0 = performance.now();
  return new Promise((resolve, reject) => {
    GOV.workerPending.set(id, {
      resolve: (msg) => {
        GOV.worker.mainMs += performance.now() - t0;
        GOV.worker.offThreadMs += msg.ms || 0;
        resolve(msg);
      },
      reject: (err) => {
        GOV.worker.lastError = (err && err.message) || String(err);
        reject(err);
      },
    });
    GOV.workerHandle.postMessage(Object.assign({ id }, payload));
  });
}

// The same deterministic workload on both threads, answers compared, so "the
// off-thread lane works" is a measurement rather than a claim.
async function govRunSelfTest() {
  const t0 = performance.now();
  const main = govSelfTestMainThread(GOV_SELFTEST_ARGS);
  const mainMs = performance.now() - t0;
  let off = null;
  let error = null;
  try {
    const res = await govOffload("selftest", GOV_SELFTEST_ARGS);
    if (res.fellBack) error = res.reason;
    else off = res.value;
  } catch (e) {
    error = (e && e.message) || String(e);
  }
  const match = !!(off && off.sum === main.sum && off.n === main.n && off.first === main.first && off.last === main.last);
  GOV.selfTest = {
    at: new Date().toISOString(),
    mainMs,
    workerMs: off ? GOV.worker.offThreadMs : NaN,
    match,
    error,
    available: GOV.worker.available,
    n: main.n,
  };
  return GOV.selfTest;
}

govInstall();

// ============================================================================
// OVERLAY UI
// ============================================================================
// Built entirely with createElement and updated in place. v1 re-set innerHTML
// every 500ms, which reset scroll position (a long list could not be read),
// reordered rows under the pointer (aiming at a Mute button was a coin flip)
// and blew away an open <select> on the Testing tab.

const PANEL_Z = 99999;

const STYLE = `
#ants-tracker-panel {
  position: fixed; top: 60px; right: 20px; width: 640px; max-height: 82vh;
  background: #1a1a1e; border: 1px solid #3a3a42; border-radius: 8px;
  box-shadow: 0 8px 24px rgba(0,0,0,0.5); color: #ddd;
  font: 12px/1.4 -apple-system, "Segoe UI", sans-serif;
  z-index: ${PANEL_Z}; display: none; flex-direction: column; overflow: hidden;
}
#ants-tracker-panel.open { display: flex; }
#ants-tracker-header {
  cursor: move; padding: 6px 10px; background: #26262c;
  border-bottom: 1px solid #3a3a42; display: flex; align-items: center;
  justify-content: space-between; user-select: none; gap: 8px;
}
#ants-tracker-header b { color: #f0a020; }
#ants-tracker-header .ants-actions { display: flex; align-items: center; gap: 4px; }
.ants-hbtn {
  cursor: pointer; color: #aaa; padding: 2px 7px; border-radius: 4px;
  font-size: 11px; border: 1px solid transparent; white-space: nowrap;
}
.ants-hbtn:hover { background: #3a3a42; color: #fff; }
.ants-hbtn.active { background: #4a3a10; color: #f0a020; border-color: #6a5520; }
#ants-tracker-summary {
  padding: 6px 10px; background: #202024; border-bottom: 1px solid #3a3a42;
  display: flex; flex-direction: column; gap: 5px; font-variant-numeric: tabular-nums;
}
.ants-sum-row { display: flex; flex-wrap: wrap; gap: 4px 6px; }
.ants-pill {
  background: #26262c; border: 1px solid #34343c; border-radius: 4px;
  padding: 1px 6px; color: #8b8b96; font-size: 11px; white-space: nowrap;
}
.ants-pill b { color: #fff; margin-left: 3px; font-weight: 600; }
.ants-pill.ants-warn { border-color: #6a5520; color: #c9a24a; }
.ants-pill.ants-warn b { color: #f0a020; }
.ants-pill.ants-bad { border-color: #7a3030; color: #d08a8a; }
.ants-pill.ants-bad b { color: #ff6b6b; }
.ants-pill.ants-ok b { color: #7ed07e; }
#ants-tracker-tabs { display: flex; border-bottom: 1px solid #3a3a42; background: #202024; }
#ants-tracker-tabs button {
  flex: 1; background: none; border: none; color: #999; padding: 6px 2px;
  cursor: pointer; font-size: 11px; border-bottom: 2px solid transparent;
}
#ants-tracker-tabs button.active { color: #f0a020; border-bottom-color: #f0a020; }
#ants-tracker-tabs button .ants-badge {
  display: inline-block; background: #7a3030; color: #fff; border-radius: 8px;
  padding: 0 5px; margin-left: 3px; font-size: 10px; line-height: 14px;
}
#ants-tracker-body { padding: 8px 10px; overflow-y: auto; }
.ants-tab { display: none; }
.ants-tab.active { display: block; }
table.ants-table { width: 100%; border-collapse: collapse; }
table.ants-table th {
  text-align: left; color: #888; font-weight: 500; padding: 3px 6px;
  border-bottom: 1px solid #333; position: sticky; top: 0; background: #1a1a1e; z-index: 1;
}
table.ants-table td {
  padding: 3px 6px; border-bottom: 1px solid #262629;
  font-variant-numeric: tabular-nums; vertical-align: top;
}
table.ants-table td.ants-num, table.ants-table th.ants-num { text-align: right; }
table.ants-table tr.ants-row:hover { background: #22222a; }
table.ants-table tr.ants-muted td { opacity: 0.45; }
table.ants-table tr.ants-hot td.ants-ms { color: #ff6b6b; font-weight: 600; }
table.ants-table tr.ants-warm td.ants-ms { color: #f0a020; }
tr.ants-details > td { background: #17171b; padding: 6px 10px 10px 22px; }
tr.ants-details table.ants-sub th { color: #777; position: static; background: none; }
tr.ants-details table.ants-sub td { color: #bbb; }
.ants-btn {
  background: #2c2c33; border: 1px solid #444; color: #ccc; border-radius: 4px;
  padding: 1px 7px; cursor: pointer; font-size: 10px; white-space: nowrap;
}
.ants-btn:hover { background: #3a3a42; color: #fff; }
.ants-btn.active { background: #6b2c2c; border-color: #a04a4a; color: #fff; }
.ants-btn.primary { background: #33465c; border-color: #46688c; color: #dfe9f5; }
.ants-caret { cursor: pointer; color: #777; user-select: none; display: inline-block; width: 10px; }
.ants-table th.ants-sortable { cursor: pointer; }
.ants-table th.ants-sortable:hover { color: #f0a020; }
.ants-table th.ants-sorted { color: #f0a020; }
.ants-more { margin-top: 4px; }
.ants-caret:hover { color: #f0a020; }
.ants-tag {
  font-size: 10px; color: #8b8b96; border: 1px solid #3a3a42; border-radius: 3px;
  padding: 0 4px; margin-left: 5px; white-space: nowrap;
}
.ants-note { color: #8b8b96; font-size: 11px; margin: 8px 0 2px; line-height: 1.5; }
.ants-note code { color: #c9a24a; }
.ants-note b { color: #ddd; }
.ants-callout {
  border: 1px solid #3a3a42; border-radius: 6px; padding: 7px 9px; margin-bottom: 8px;
  background: #202024; font-size: 11px; color: #a8a8b2; line-height: 1.5;
}
.ants-callout.warn { background: #2a2410; border-color: #5a4a1a; }
.ants-callout.bad { background: #2a1414; border-color: #5a2020; }
.ants-callout b { color: #f0a020; }
.ants-empty { color: #777; font-size: 11px; padding: 4px 2px; }
.ants-select {
  background: #202024; color: #eee; border: 1px solid #444; border-radius: 4px;
  padding: 4px 8px; font-size: 12px; width: 100%; max-width: 380px;
}
/* Elements of a node that is currently drawn as a rectangle: see lodSweepDom. */
.ants-lod-box { display: none !important; }
.ants-section-title {
  color: #ccc; font-size: 11px; font-weight: 600; margin: 12px 0 4px;
  text-transform: uppercase; letter-spacing: 0.05em;
}
.ants-kv { width: 100%; border-collapse: collapse; font-variant-numeric: tabular-nums; }
.ants-kv td { padding: 2px 2px; border: none; }
.ants-kv td.ants-kv-label { color: #8b8b96; width: 46%; }
.ants-kv td.ants-kv-value { color: #eee; }
.ants-bar { height: 6px; background: #2c2c33; border-radius: 3px; overflow: hidden; margin-top: 3px; }
.ants-bar > div { height: 100%; background: #f0a020; }
.ants-spark { display: flex; align-items: flex-end; gap: 1px; height: 40px; margin: 4px 0 2px; }
.ants-spark > div { flex: 1; background: #46688c; min-height: 1px; }
.ants-spark > div.ants-spark-hot { background: #f0a020; }
#ants-corner-btn {
  position: fixed; bottom: 16px; right: 16px; width: 34px; height: 34px;
  border-radius: 50%; background: #26262c; border: 1px solid #444; color: #f0a020;
  font-size: 16px; display: flex; align-items: center; justify-content: center;
  cursor: pointer; z-index: 99998; box-shadow: 0 2px 8px rgba(0,0,0,0.4);
}
#ants-corner-btn:hover { background: #33333a; }
.ants-copyrow { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
`;

function injectStyle() {
  if (document.getElementById("ants-tracker-style")) return;
  const style = document.createElement("style");
  style.id = "ants-tracker-style";
  style.textContent = STYLE;
  document.head.appendChild(style);
}

// tiny DOM helper: el("div", {class, text, title, style, on}) -> element
function el(tag, opts) {
  const node = document.createElement(tag);
  if (!opts) return node;
  if (opts.class) node.className = opts.class;
  if (opts.id) node.id = opts.id;
  if (opts.text !== undefined && opts.text !== null) node.textContent = String(opts.text);
  if (opts.title) node.title = opts.title;
  if (opts.style) for (const k in opts.style) node.style[k] = opts.style[k];
  if (opts.on) for (const k in opts.on) node.addEventListener(k, opts.on[k]);
  return node;
}

function td(opts) {
  return el("td", opts);
}

function setText(node, text) {
  const s = String(text);
  if (node.textContent !== s) node.textContent = s;
}

function pill(label) {
  const root = el("span", { class: "ants-pill" });
  root.appendChild(document.createTextNode(label));
  const value = el("b", { text: "—" });
  root.appendChild(value);
  root.title = "";
  return { el: root, value, label };
}

function setPill(p, text, tone) {
  setText(p.value, text);
  const cls = tone ? `ants-pill ${tone}` : "ants-pill";
  if (p.el.className !== cls) p.el.className = cls;
}

function makeTable(headers) {
  const table = el("table", { class: "ants-table" });
  const thead = el("thead");
  const tr = el("tr");
  const ths = [];
  for (const h of headers) {
    const th = el("th", { text: h.label, class: h.right ? "ants-num" : null });
    ths.push(th);
    tr.appendChild(th);
  }
  thead.appendChild(tr);
  const tbody = el("tbody");
  table.appendChild(thead);
  table.appendChild(tbody);
  return { table, thead, tbody, ths, headers };
}

// --- sorting ---------------------------------------------------------------
// Click a header to sort by that column, click again to reverse it, click a
// third time to go back to the table's default order.
//
// Two rules make this behave on live data:
//   * sorting uses the underlying numbers, never the formatted text — as text,
//     "1,234.5ms" sorts before "9.2ms", and a column of "—" has no order at all;
//   * rows with no value for the chosen column sink to the bottom in BOTH
//     directions, because a row showing "—" is unmeasured, not the cheapest
//     thing on screen.
function makeSorter(headers, getters, options) {
  const opts = options || {};
  const defaultKey = opts.defaultKey || null;
  const dirFor = (key) => {
    const h = headers.find((x) => x.key === key);
    return h && h.text ? 1 : -1; // names read A→Z, costs read biggest-first
  };
  const defaultDir = opts.defaultDir || dirFor(defaultKey);
  const state = { key: defaultKey, dir: defaultDir };
  const sets = [];

  function decorate() {
    for (const ths of sets) {
      for (let i = 0; i < ths.length; i++) {
        const th = ths[i];
        const h = headers[i];
        if (!th || !h || !h.key) continue;
        const active = state.key === h.key;
        if (active) th.classList.add("ants-sorted");
        else th.classList.remove("ants-sorted");
        setText(th, active ? `${h.label} ${state.dir > 0 ? "▲" : "▼"}` : h.label);
      }
    }
  }

  function cycle(key) {
    if (!key) return;
    if (state.key !== key) {
      state.key = key;
      state.dir = dirFor(key);
    } else if (state.dir === dirFor(key)) {
      state.dir = -dirFor(key);
    } else {
      state.key = defaultKey;
      state.dir = defaultDir;
    }
    decorate();
    if (opts.onChange) opts.onChange();
  }

  function attach(ths) {
    sets.push(ths);
    for (let i = 0; i < ths.length; i++) {
      const th = ths[i];
      const h = headers[i];
      if (!th || !h || !h.key || th.__antsSortKey) continue;
      th.__antsSortKey = h.key;
      th.classList.add("ants-sortable");
      th.title = `Sort by ${h.label}. Click again to reverse, a third time for the default order.`;
      th.addEventListener("click", () => cycle(h.key));
    }
    decorate();
  }

  function sort(items) {
    const get = getters[state.key];
    if (!get) return items;
    const out = items.slice();
    out.sort((a, b) => {
      const av = get(a);
      const bv = get(b);
      const aMissing = av === null || av === undefined || (typeof av === "number" && !Number.isFinite(av));
      const bMissing = bv === null || bv === undefined || (typeof bv === "number" && !Number.isFinite(bv));
      if (aMissing && bMissing) return 0;
      if (aMissing) return 1;
      if (bMissing) return -1;
      if (typeof av === "string" || typeof bv === "string") return String(av).localeCompare(String(bv)) * state.dir;
      return (av - bv) * state.dir;
    });
    return out;
  }

  const api = { state, attach, sort, decorate, cycle };
  api.reset = () => {
    state.key = defaultKey;
    state.dir = defaultDir;
    decorate();
  };
  return api;
}

// Row caps. A graph with a thousand nodes produces six hundred owners and four
// hundred node types; rendering all of them twice a second costs the page real
// milliseconds (the Stalls tab will happily name this panel for it) and nobody
// reads row 400 anyway. Tables render the most expensive N rows, say how many
// are hidden, and offer "Show all" if you actually want the whole list.
const rowCaps = { timing: 120, nodes: 60, stalls: 60, governor: 60 };

function makeRowCapper(container, capKey, noun, onChange) {
  const wrap = el("div", { class: "ants-note ants-more" });
  const note = el("span");
  const btn = el("button", { class: "ants-btn", text: "Show all rows" });
  const api = { all: false };
  btn.addEventListener("click", () => {
    api.all = !api.all;
    setText(btn, api.all ? "Back to the most expensive rows" : "Show all rows");
    if (onChange) onChange();
  });
  wrap.appendChild(note);
  wrap.appendChild(document.createTextNode(" "));
  wrap.appendChild(btn);
  container.appendChild(wrap);
  api.apply = (rows) => {
    const cap = api.all ? Infinity : rowCaps[capKey] || rows.length;
    if (rows.length <= cap) {
      // Nothing hidden: hide the whole line, including the button. A "Show all
      // rows" button next to three visible rows is just noise.
      setText(note, "");
      wrap.style.display = "none";
      return rows;
    }
    setText(note, `Showing ${cap} of ${rows.length} ${noun}, most expensive first by the current sort.`);
    wrap.style.display = "";
    return rows.slice(0, cap);
  };
  return api;
}

// Keyed, order-stable row set. Rows keep their identity across refreshes, so
// only their values change: scroll position, expanded detail rows and the
// user's aim at a button all survive. Row ORDER is re-applied every refresh
// except while the pointer is inside the list.
class RowSet {
  constructor(tbody, build) {
    this.tbody = tbody;
    this.build = build;
    this.rows = new Map();
    this.deferReorder = false;
  }

  sync(items, keyOf, update) {
    const seen = new Set();
    let prev = null;
    for (const item of items) {
      const key = keyOf(item);
      if (key === undefined || key === null) continue;
      seen.add(key);
      let row = this.rows.get(key);
      if (!row) {
        const built = this.build(item);
        // A build() may return either a bare array of <tr> nodes or an object
        // carrying extra per-row state (cells, expansion flag) plus `nodes`.
        row = Array.isArray(built) ? { nodes: built } : built;
        row.key = key;
        this.rows.set(key, row);
      }
      update(row, item);
      if (!this.deferReorder) this._place(row, prev);
      prev = row.nodes[row.nodes.length - 1];
    }
    for (const [key, row] of [...this.rows]) {
      if (seen.has(key)) continue;
      for (const n of row.nodes) n.remove();
      this.rows.delete(key);
    }
  }

  _place(row, prevNode) {
    let ref = prevNode ? prevNode.nextSibling : this.tbody.firstChild;
    for (const node of row.nodes) {
      if (node === ref) {
        ref = ref.nextSibling;
        continue;
      }
      this.tbody.insertBefore(node, ref);
    }
  }
}

function listBody() {
  return document.getElementById("ants-tracker-body");
}

function makeSpark(barCount) {
  const root = el("div", { class: "ants-spark" });
  const bars = [];
  for (let i = 0; i < barCount; i++) {
    const b = el("div");
    root.appendChild(b);
    bars.push(b);
  }
  return {
    el: root,
    set(values, hotAbove) {
      let max = 1e-9;
      for (const v of values) if (v > max) max = v;
      for (let i = 0; i < bars.length; i++) {
        const v = values[i];
        const h = Number.isFinite(v) && v > 0 ? Math.max(3, Math.round((v / max) * 100)) : 0;
        const style = `${h}%`;
        if (bars[i].style.height !== style) bars[i].style.height = style;
        const cls = hotAbove && v >= hotAbove ? "ants-spark-hot" : "";
        if (bars[i].className !== cls) bars[i].className = cls;
      }
    },
  };
}

// --------------------------------------------------------------- panel -----

const ui = {
  panel: null,
  pills: {},
  tabs: {},
  tabBtns: {},
  state: {},
  active: "timing",
  refreshTimer: null,
  prevScroll: {},
  built: false,
  pauseBtn: null,
};

function buildPanel() {
  if (ui.built) return ui.panel;
  injectStyle();

  const panel = el("div", { id: "ants-tracker-panel" });
  ui.panel = panel;

  const header = el("div", { id: "ants-tracker-header" });
  const title = el("span");
  title.appendChild(el("b", { text: "ANTs" }));
  title.appendChild(document.createTextNode(` Nasty Bastards Tracker v${VERSION}`));
  const actions = el("div", { class: "ants-actions" });
  const copyBtn = el("span", {
    class: "ants-hbtn",
    text: "📋 Copy",
    title: "Copy a plain-text snapshot of every tab, for pasting into a chat or bug report",
  });
  ui.pauseBtn = el("span", {
    class: "ants-hbtn",
    text: "⏸ Pause",
    title: "Freeze sampling so the numbers stop moving while you read them. Rendering is untouched.",
  });
  const resetBtn = el("span", { class: "ants-hbtn", text: "⟲ Reset", title: "Clear all recorded samples (keeps mutes and settings)" });
  const closeBtn = el("span", { class: "ants-hbtn", text: "✕", title: "Close" });
  actions.appendChild(copyBtn);
  actions.appendChild(ui.pauseBtn);
  actions.appendChild(resetBtn);
  actions.appendChild(closeBtn);
  header.appendChild(title);
  header.appendChild(actions);
  panel.appendChild(header);

  const summary = el("div", { id: "ants-tracker-summary" });
  const row1 = el("div", { class: "ants-sum-row" });
  const row2 = el("div", { class: "ants-sum-row" });
  for (const [key, label] of [
    ["fps", "fps"],
    ["frame", "frame"],
    ["p95", "p95"],
    ["display", "display"],
    ["drawsRaf", "draws/rAF"],
    ["redrawReq", "redraw req"],
    ["stalls", "stalls"],
  ]) {
    ui.pills[key] = pill(label);
    row1.appendChild(ui.pills[key].el);
  }
  for (const [key, label] of [
    ["nodeShare", "node draws"],
    ["attrShare", "└ ext hooks"],
    ["chromeShare", "└ litgraph chrome"],
    ["connShare", "connections"],
    ["otherShare", "other"],
    ["overhead", "tracker"],
    ["limiter", "limiter"],
  ]) {
    ui.pills[key] = pill(label);
    row2.appendChild(ui.pills[key].el);
  }
  summary.appendChild(row1);
  summary.appendChild(row2);
  panel.appendChild(summary);

  const tabsBar = el("div", { id: "ants-tracker-tabs" });
  const tabsBody = el("div", { id: "ants-tracker-body" });
  for (const [name, label] of [
    ["tweaks", "Tweaks"],
    ["timing", "Timing"],
    ["nodes", "Nodes"],
    ["stalls", "Stalls"],
    ["governor", "Governor"],
    ["load", "Load"],
    ["memory", "Memory"],
    ["gpu", "GPU / VRAM"],
    ["testing", "Testing"],
  ]) {
    const btn = el("button", { text: label });
    btn.addEventListener("click", () => setTab(name));
    ui.tabBtns[name] = btn;
    tabsBar.appendChild(btn);
    const container = el("div", { class: "ants-tab" });
    ui.tabs[name] = container;
    tabsBody.appendChild(container);
  }
  panel.appendChild(tabsBar);
  panel.appendChild(tabsBody);
  document.body.appendChild(panel);

  // Rows must not reorder while the pointer is inside the list: the value you
  // are watching keeps updating, but the button you are aiming at stays put.
  tabsBody.addEventListener("mouseenter", () => {
    const st = ui.state[ui.active];
    if (st && st.rowSet) st.rowSet.deferReorder = true;
  });
  tabsBody.addEventListener("mouseleave", () => {
    const st = ui.state[ui.active];
    if (st && st.rowSet) st.rowSet.deferReorder = false;
    if (st && st.update) st.update();
  });

  copyBtn.addEventListener("click", (e) => copyTelemetryReport(e.currentTarget));
  ui.pauseBtn.addEventListener("click", () => togglePause());
  resetBtn.addEventListener("click", () => resetAllStats(true));
  closeBtn.addEventListener("click", () => togglePanel(false));
  makeDraggable(header, panel);

  ui.built = true;
  return panel;
}

function setTab(name) {
  // Deliberately unchanged refresh cadence: switching tabs just shows a
  // different prebuilt body.
  if (ui.active === name) return;
  const body = listBody();
  if (body) ui.prevScroll[ui.active] = body.scrollTop || 0;
  ui.active = name;
  for (const key in ui.tabs) {
    const on = key === name;
    ui.tabs[key].classList.toggle("active", on);
    ui.tabBtns[key].classList.toggle("active", on);
  }
  const st = ui.state[name];
  if (st && st.update) st.update();
  if (body) body.scrollTop = ui.prevScroll[name] || 0;
  if (name === "gpu") refreshGpu();
}

function makeDraggable(handle, target) {
  let dragging = false;
  let startX = 0;
  let startY = 0;
  let startRight = 0;
  let startTop = 0;
  handle.addEventListener("mousedown", (e) => {
    if (e.target && typeof e.target.closest === "function" && e.target.closest(".ants-hbtn")) return;
    dragging = true;
    startX = e.clientX;
    startY = e.clientY;
    const rect = target.getBoundingClientRect();
    startRight = (window.innerWidth || 0) - rect.right;
    startTop = rect.top;
    if (e.preventDefault) e.preventDefault();
  });
  window.addEventListener("mousemove", (e) => {
    if (!dragging) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    target.style.right = `${Math.max(0, startRight - dx)}px`;
    target.style.top = `${Math.max(0, startTop + dy)}px`;
  });
  window.addEventListener("mouseup", () => {
    dragging = false;
  });
}

// ------------------------------------------------------------ summary bar --

function renderSummary() {
  const fm = frameMetrics();
  const pct = framePercentiles();
  const raf = rafMetrics();
  const inv = invalidationMetrics();
  const st = stallMetrics();
  const sc = selfCostMetrics();

  setPill(ui.pills.fps, Number.isFinite(fm.fps) ? fm.fps.toFixed(0) : "(idle)", fm.idle ? null : fm.fps < 20 ? "ants-bad" : fm.fps < 45 ? "ants-warn" : "ants-ok");
  setPill(ui.pills.frame, fm.ok ? `${fmtMs(fm.meanFrameMs)}ms` : "—", fm.meanFrameMs > 33 ? "ants-bad" : fm.meanFrameMs > 16 ? "ants-warn" : null);
  setPill(ui.pills.p95, pct.n ? `${fmtMs(pct.p95)}ms` : "—", pct.p95 > 50 ? "ants-bad" : pct.p95 > 25 ? "ants-warn" : null);
  setPill(ui.pills.display, Number.isFinite(raf.displayHz) ? `${raf.displayHz.toFixed(0)}Hz` : "—");
  const dpsTone = Number.isFinite(raf.drawsPerRaf) && raf.drawsPerRaf > 1.25 ? "ants-warn" : null;
  setPill(ui.pills.drawsRaf, Number.isFinite(raf.drawsPerRaf) ? raf.drawsPerRaf.toFixed(2) : "—", dpsTone);
  const displayRef = Number.isFinite(raf.displayHz) ? raf.displayHz * 1.25 : 999;
  setPill(ui.pills.redrawReq, `${fmtRate(inv.perSec)}/s`, inv.perSec > displayRef ? "ants-warn" : null);
  setPill(ui.pills.stalls, `${fmtRate(st.blockingMsPerSec)}ms/s`, st.blockingMsPerSec > 100 ? "ants-bad" : st.blockingMsPerSec > 30 ? "ants-warn" : null);

  setPill(ui.pills.nodeShare, fm.ok ? fmtPct(fm.nodeShare) : "—");
  setPill(ui.pills.attrShare, fm.ok ? fmtPct(fm.attrShare) : "—", fm.attrShare > 0.35 ? "ants-warn" : null);
  setPill(ui.pills.chromeShare, fm.ok ? fmtPct(fm.chromeShare) : "—", fm.chromeShare > 0.5 ? "ants-warn" : null);
  setPill(ui.pills.connShare, fm.ok ? fmtPct(fm.connShare) : "—");
  setPill(ui.pills.otherShare, fm.ok ? fmtPct(fm.otherShare) : "—", fm.otherShare > 0.2 ? "ants-warn" : null);
  setPill(ui.pills.overhead, `${fmtMs((sc.renderMsPerSec + sc.sweepMsPerSec) * 1000, 0)}µs/s`);
  const gm = govMetrics();
  setPill(
    ui.pills.limiter,
    gm.disabled
      ? "turned off"
      : gm.throttled
        ? `${gm.throttled} src · ${fmtRate(gm.skippedPerSec)}/s`
        : gm.sourceCount
          ? "off"
          : "—",
    gm.disabled ? "ants-bad" : gm.throttled ? "ants-warn" : null
  );


  const tips = ui.pills;
  tips.fps.el.title = "Canvas redraws per second of wall clock, over the last 10s (30s when a loose cap or an idle canvas gives fewer than 4 frames).";
  tips.frame.el.title = "Mean time inside canvas.draw(), i.e. one redraw. This is the work that decides your frame rate.";
  tips.p95.el.title = "95th percentile frame time — the hitching you actually feel, which the mean hides.";
  tips.display.el.title = "requestAnimationFrame cadence: the display's own refresh rate as the browser sees it.";
  tips.drawsRaf.el.title = "Canvas redraws per displayed frame. Above ~1, the canvas is repainting more often than the screen refreshes.";
  tips.redrawReq.el.title = "canvas.setDirty() calls per second — redraw *requests*. See the Nodes tab for the sampled callers.";
  tips.stalls.el.title = "Main-thread blocking time per second outside canvas drawing (Stalls tab).";
  tips.nodeShare.el.title = "Share of the mean frame inside drawNode() — all node rendering.";
  tips.attrShare.el.title = "Share of the mean frame inside wrapped draw hooks (onDrawForeground / onDrawBackground / onDrawCollapsed / onBounding).";
  tips.chromeShare.el.title = "Node drawing minus wrapped hooks: LiteGraph's borders, titles, slots, widgets, embedded bitmaps.";
  tips.connShare.el.title = "Share of the mean frame inside drawConnections().";
  tips.otherShare.el.title = "Frame time outside drawNode() and drawConnections(): background grid, groups, selection overlays, canvas-level draw hooks — or a prototype-patched render path.";
  tips.overhead.el.title =
    `The tracker's own cost: panel rendering ${fmtMs(sc.renderMsPerSec * 1000, 0)}µs/s, bookkeeping ${fmtMs(sc.sweepMsPerSec * 1000, 0)}µs/s, ` +
    `${sc.wrappedHooks} wrapped hooks, ${sc.buckets} buckets holding ${fmtBytes(sc.ringBytes)} of ring buffers. ` +
    "Per-call wrapper overhead is not included; it sits at roughly 0.1µs per timed call.";
}

// ---------------------------------------------------------------- tabs -----

function updateActiveTab() {
  const st = ui.state[ui.active];
  if (st && st.update) st.update();
  if (ui.tabBtns.stalls) {
    const showBadge = stallMetrics().blockingMsPerSec > 40;
    const badge = ui.tabBtns.stalls.__badge;
    if (showBadge && !badge) {
      const b = el("span", { class: "ants-badge", text: "!" });
      ui.tabBtns.stalls.appendChild(b);
      ui.tabBtns.stalls.__badge = b;
    } else if (!showBadge && badge) {
      badge.remove();
      ui.tabBtns.stalls.__badge = null;
    }
  }
}

function timingContextLine() {
  const bits = [];
  bits.push(`${S.counters.wrappedHooks} hook(s) wrapped`);
  if (S.counters.preTrackedHooks) bits.push(`${S.counters.preTrackedHooks} pre-existing prototype hook(s) adopted`);
  if (S.counters.instanceHooks) bits.push(`${S.counters.instanceHooks} instance hook(s) adopted`);
  if (S.extSeen.size) bits.push(`${S.extSeen.size} extension(s) registered`);
  bits.push(S.muted.size ? `${S.muted.size} muted` : "nothing muted");
  if (S.paused) bits.push("PAUSED — values frozen");
  return bits.join(" · ");
}

function timingEmptyText() {
  if (S.paused) {
    return "Sampling is paused, so nothing new is being recorded — this panel shows the frozen last snapshot. Resume to start again.";
  }
  if (S.hooks.size === 0) {
    return (
      "No draw hooks were found at all this session: no extension overrode onDrawForeground / onDrawBackground / " +
      "onDrawCollapsed / onBounding through beforeRegisterNodeDef, and no pre-existing or per-instance hook has been seen yet. " +
      "That is a finding, not an empty panel — the cost is elsewhere, so check the Nodes tab (per-type LiteGraph chrome) and the " +
      "Stalls tab (main-thread cost that is not canvas drawing at all)."
    );
  }
  const owners = [...new Set([...S.hooks.values()].map((b) => b.label))].sort();
  const shown = owners.slice(0, 14);
  return (
    `${S.hooks.size} hook(s) are wrapped for ${owners.length} owner(s), but none of them ran inside a redraw in the last ` +
    `${(WINDOW_MS / 1000).toFixed(0)}s, and none has off-frame time either. Pan or zoom the graph. If it stays empty while you pan, ` +
    `these owners are no longer drawing through these hooks — look for a widget draw(), an instance hook, or a heartbeat. ` +
    `Owners wrapped: ${shown.join(", ")}${owners.length > shown.length ? `, +${owners.length - shown.length} more` : ""}.`
  );
}

function buildTimingTab(container) {
  const context = el("div", { class: "ants-note" });
  const empty = el("div", { class: "ants-empty" });
  const table = makeTable([
    { label: "Owner", key: "label", text: true },
    { label: "ms/frame", right: true, key: "ms" },
    { label: "% of frame", right: true, key: "share" },
    { label: "calls/frame", right: true, key: "calls" },
    { label: "ms/call", right: true, key: "perCall" },
    { label: "off-frame ms", right: true, key: "off" },
    { label: "", right: true },
  ]);
  const note = el("p", { class: "ants-note" });
  note.textContent =
    "Click any column header to sort by it (again to reverse, a third time for the default: most expensive first). " +
    "Cost per drawn frame is the number that does not change just because you panned faster. " +
    "\"Mute\" skips that owner's draw hooks outright, so the FPS change you then measure is real rather than merely unmeasured, " +
    "and it is reversible instantly. Off-frame ms is hook time that ran outside a canvas redraw (onExecuted, a timer, a DOM event): " +
    "it is deliberately kept out of ms/frame, but if it is large it is stealing main-thread time that frames need. " +
    "Click a row's ▸ for the per-hook breakdown. A row tagged \"nested\" was called from inside another wrapped hook " +
    "(normally a node's own hook delegating to the prototype method): its calls are real, but its milliseconds are already " +
    "inside the outer hook, so they are not counted twice.";
  container.appendChild(context);
  container.appendChild(empty);
  container.appendChild(table.table);
  const capper = makeRowCapper(container, "timing", "owners", () => update());
  container.appendChild(note);

  // Hook rows share one sort order across every expanded row, so the whole tab
  // reads consistently.
  let framesInWindowNow = 0;
  const hookSorter = makeSorter(
    [
      { label: "Hook", key: "hook", text: true },
      { label: "ms/frame", right: true, key: "ms" },
      { label: "calls", right: true, key: "calls" },
      { label: "ms/call", right: true, key: "perCall" },
      { label: "off-frame ms", right: true, key: "off" },
      { label: "skipped", right: true, key: "skipped" },
    ],
    {
      hook: (h) => h.hook,
      ms: (h) => (framesInWindowNow ? h.insideMs / framesInWindowNow : null),
      calls: (h) => h.insideCalls,
      perCall: (h) => h.msPerCall,
      off: (h) => (h.outsideMs > 0 ? h.outsideMs : null),
      skipped: (h) => (h.skipped > 0 ? h.skipped : null),
    },
    { defaultKey: "ms", onChange: () => update() }
  );

  const sorter = makeSorter(
    table.headers,
    {
      label: (r) => r.label,
      ms: (r) => r.msPerFrame,
      share: (r) => r.share,
      calls: (r) => r.callsPerFrame,
      perCall: (r) => r.msPerCall,
      off: (r) => (r.outsideMs > 0 ? r.outsideMs : null),
    },
    {
      defaultKey: "ms",
      // A header click happens with the pointer inside the panel, where rows are
      // normally frozen in place; sorting is an explicit request, so apply it
      // immediately and then keep the freeze until the pointer leaves.
      onChange: () => {
        rowSet.deferReorder = false;
        update();
        rowSet.deferReorder = true;
      },
    }
  );
  sorter.attach(table.ths);

  const rowSet = new RowSet(table.tbody, () => {
    const caretCell = td();
    const caret = el("span", { class: "ants-caret", text: "▸" });
    caretCell.appendChild(caret);
    const nameCell = td();
    const msCell = td({ class: "ants-ms ants-num" });
    const shareCell = td({ class: "ants-num" });
    const callsCell = td({ class: "ants-num" });
    const perCallCell = td({ class: "ants-num" });
    const offCell = td({ class: "ants-num" });
    const muteCell = td({ class: "ants-num" });
    const btn = el("button", { class: "ants-btn" });
    muteCell.appendChild(btn);
    const main = el("tr", { class: "ants-row" });
    for (const c of [caretCell, nameCell, msCell, shareCell, callsCell, perCallCell, offCell, muteCell]) main.appendChild(c);

    const details = el("tr", { class: "ants-details" });
    const dcell = td();
    details.appendChild(dcell);
    const summaryLine = el("div", { class: "ants-note" });
    const sub = makeTable([
      { label: "Hook", key: "hook", text: true },
      { label: "ms/frame", right: true, key: "ms" },
      { label: "calls", right: true, key: "calls" },
      { label: "ms/call", right: true, key: "perCall" },
      { label: "off-frame ms", right: true, key: "off" },
      { label: "skipped", right: true, key: "skipped" },
    ]);
    hookSorter.attach(sub.ths);
    dcell.appendChild(summaryLine);
    dcell.appendChild(sub.table);
    const subRows = new RowSet(sub.tbody, () => {
      const r = el("tr");
      for (let i = 0; i < 6; i++) r.appendChild(td({ class: i > 0 ? "ants-num" : null }));
      return [r];
    });
    let open = false;
    caret.addEventListener("click", () => {
      open = !open;
      details.style.display = open ? "" : "none";
      caret.textContent = open ? "▾" : "▸";
    });
    details.style.display = "none";
    return { nodes: [main, details], caret, nameCell, msCell, shareCell, callsCell, perCallCell, offCell, btn, summaryLine, subRows, muted: false, isOpen: () => open };
  });

  function updateRow(row, r) {
    setText(row.nameCell, "");
    row.nameCell.appendChild(row.caret);
    row.nameCell.appendChild(document.createTextNode(r.label));
    if (r.kind !== "ext") {
      row.nameCell.appendChild(el("span", { class: "ants-tag", text: r.label.startsWith("(pre-existing)") ? "adopted" : "instance" }));
    }
    if (r.muted) row.nameCell.appendChild(el("span", { class: "ants-tag", text: "muted" }));
    if (r.nestedCalls > 0) {
      const tag = el("span", { class: "ants-tag", text: "nested" });
      tag.title =
        `${r.nestedCalls} call(s) in the window came from inside another wrapped hook — usually a node's own hook delegating to ` +
        "the prototype method, or one extension wrapping another. The outer hook's time already includes them, so they are counted " +
        "as calls but not as milliseconds: that is what keeps this table adding up to the frame budget instead of doubling it.";
      row.nameCell.appendChild(tag);
    }
    setText(row.msCell, Number.isFinite(r.msPerFrame) ? fmtMs(r.msPerFrame) : "—");
    setText(row.shareCell, Number.isFinite(r.share) ? fmtPct(r.share) : "—");
    setText(row.callsCell, Number.isFinite(r.callsPerFrame) ? r.callsPerFrame.toFixed(r.callsPerFrame < 10 ? 2 : 0) : "—");
    setText(row.perCallCell, fmtMs(r.msPerCall, 3));
    if (r.nestedCalls > 0) {
      row.perCallCell.title =
        "No ms/call for a hook that never owns any time: its cost is inside the outer hook it was called from.";
    }
    setText(row.offCell, r.outsideMs > 0 ? fmtMs(r.outsideMs) : "—");
    if (r.outsideCalls > 0) {
      row.offCell.title = `${r.outsideCalls} call(s) outside a redraw (onExecuted / timer / DOM event driven), ${fmtMs(r.outsideMs / r.outsideCalls, 3)} ms/call.`;
    }
    const cls = `${r.muted ? "ants-muted" : ""}${r.share > 0.15 ? " ants-hot" : r.share > 0.05 ? " ants-warm" : ""}`.trim();
    if (row.msCell.parentNode.className !== cls) row.msCell.parentNode.className = cls;
    const label = r.muted ? "Unmute" : r.kind === "ext" ? "Mute" : "Skip";
    setText(row.btn, label);
    row.btn.className = `ants-btn ${r.muted ? "active" : ""}`;
    row.btn.title =
      r.kind === "ext"
        ? "Skip every wrapped draw hook belonging to this extension so you can measure the real gain. Reversible instantly."
        : "Skip this node type's wrapped hook only. This owner was discovered as a pre-existing or instance hook, so muting it does not silence a whole extension.";
    row.btn.onclick = () => toggleMute(r.label);
    setText(
      row.summaryLine,
      [
        `${fmtMs(r.insideMs)}ms inside redraws in the window`,
        r.outsideMs > 0 ? `${fmtMs(r.outsideMs)}ms off-frame` : null,
        r.nestedCalls ? `${r.nestedCalls} nested call(s) counted on the outer hook` : null,
        r.skipped ? `${r.skipped} call(s) skipped while muted` : null,
        r.lifetimeCalls ? `${r.lifetimeCalls} lifetime calls` : null,
      ]
        .filter(Boolean)
        .join(" · ")
    );
  }

  function update() {
    const { rows, framesInWindow } = hookRows();
    framesInWindowNow = framesInWindow;
    const visible = sorter.sort(
      rows.filter((r) => r.insideCalls > 0 || r.outsideCalls > 0 || r.nestedCalls > 0 || r.muted)
    );
    setText(context, timingContextLine());
    setText(empty, visible.length ? "" : timingEmptyText());
    empty.style.display = visible.length ? "none" : "";
    table.table.style.display = visible.length ? "" : "none";
    rowSet.sync(
      capper.apply(visible),
      (r) => r.label,
      (row, r) => {
        updateRow(row, r);
        if (row.isOpen()) {
          row.subRows.sync(
            hookSorter.sort(r.hooks),
            (h) => h.hook,
            (subRow, h) => {
              const c = subRow.nodes[0].children;
              setText(c[0], h.hook);
              setText(c[1], framesInWindow ? fmtMs(h.insideMs / framesInWindow) : "—");
              setText(c[2], h.nestedCalls ? `${h.insideCalls} + ${h.nestedCalls} nested` : h.insideCalls);
              if (h.nestedCalls) c[2].title = "Total calls, plus the ones that came from inside another wrapped hook (counted as calls, timed on the outer hook).";
              setText(c[3], fmtMs(h.msPerCall, 3));
              setText(c[4], h.outsideMs > 0 ? fmtMs(h.outsideMs) : "—");
              setText(c[5], h.skipped ? h.skipped : "—");
            }
          );
        }
      }
    );
  }

  ui.state.timing = { rowSet, update, sorter };
}

// --- Nodes -----------------------------------------------------------------

// --- Tweaks -----------------------------------------------------------------
// The canvas-rendering settings, on their own tab and at the front of the row:
// they are the part of this tool a person comes to *change*, where the other
// tabs answer questions. Kept in one block so the settings and the numbers they
// moved are read together.

function buildTweaksTab(container) {
  // ------------------------------------------------------ low-zoom drawing ---
  // Opt-in, because it changes what the canvas paints. It exists because the
  // budget above is usually not a scheduling problem: on a big graph at low
  // zoom, the cost is a thousand nodes drawn properly several times a second,
  // and culling cannot remove a node that is inside the viewport.
  container.appendChild(el("div", { class: "ants-section-title", text: "Low-zoom drawing (experiment)" }));

  const lodPxSel = el("select", { class: "ants-select", style: { width: "auto", maxWidth: "240px" } });
  for (const px of LOD_MIN_PX) {
    const opt = el("option", { text: px === 0 ? "draw every node in full" : `nodes under ${px}px — one flat rectangle` });
    opt.value = String(px);
    lodPxSel.appendChild(opt);
  }
  lodPxSel.value = String(LOD.minPx);
  lodPxSel.title =
    "Nodes that land smaller than this on screen are painted as their background colour only: no border, title, slots, " +
    "widgets or previews. Nothing about the graph changes — only how it is painted, and only for nodes too small to read.";
  lodPxSel.addEventListener("change", () => {
    lodSet({ minPx: Number(lodPxSel.value) });
    lodUpdate();
  });

  const lodIdleSel = el("select", { class: "ants-select", style: { width: "auto", maxWidth: "240px" } });
  for (const ms of LOD_IDLE_CAP_MS) {
    const opt = el("option", { text: ms === 0 ? "redraw as often as asked" : `${Math.round(1000 / ms)}/s while nothing is touched` });
    opt.value = String(ms);
    lodIdleSel.appendChild(opt);
  }
  lodIdleSel.value = String(LOD.idleCapMs);
  lodIdleSel.title =
    "While no pointer, wheel or key event has arrived for a moment, redraws are rate-limited to this — a rate limit, not " +
    "data loss: the last request of a burst still gets one trailing redraw. Touch the page and the cap is lifted instantly.";
  lodIdleSel.addEventListener("change", () => {
    lodSet({ idleCapMs: Number(lodIdleSel.value) });
    lodUpdate();
  });

  const lodLinkSel = el("select", { class: "ants-select", style: { width: "auto", maxWidth: "260px" } });
  for (const [id, text] of [
    ["auto", "links: straight while the graph is rectangles"],
    ["spline", "links: keep every curve"],
    ["straight", "links: always straight lines"],
  ]) {
    const opt = el("option", { text });
    opt.value = id;
    lodLinkSel.appendChild(opt);
  }
  lodLinkSel.value = LOD.linkStyle;
  lodLinkSel.title =
    "What links are drawn as while the node setting above is flattening the graph. \"Straight while the graph is rectangles\" is how " +
    "this worked from v2.1.4: once most of the sample is flat, links are replaced by straight lines, which is cheap but destroys the " +
    "shape of a workflow drawn with curves. \"Keep every curve\" never straightens a link \u2014 combine it with the thinning setting " +
    "below to pay less for the curves instead. \"Always straight lines\" is for graphs that were drawn with straight links to begin " +
    "with. The three settings are independent: flattening decides what a node costs, this decides the shape of a link, and thinning " +
    "decides how much ink that shape uses.";
  lodLinkSel.addEventListener("change", () => {
    lodSet({ linkStyle: lodLinkSel.value });
    lodUpdate();
  });

  const lodDetailSel = el("select", { class: "ants-select", style: { width: "auto", maxWidth: "260px" } });
  for (const z of LOD_DETAIL_ZOOMS) {
    const opt = el("option", {
      text: z === 0 ? "full link and node detail" : `links thinned below ${Math.round(z * 100)}% zoom`,
    });
    opt.value = String(z);
    lodDetailSel.appendChild(opt);
  }
  lodDetailSel.value = String(LOD.detailZoom);
  lodDetailSel.title =
    "Below this zoom, links are stroked 1px wide instead of 3 and lose the dark outline drawn under them (a second stroke 4 units " +
    "wider, which on a long link is most of the ink) \u2014 the curves are kept exactly as they are, because straight lines destroy " +
    "the shape of a workflow built out of splines. Those frames are also drawn with the frontend's own low-quality mode on: no " +
    "node shadows and no rounded corners. Neither change touches hit-testing, dragging or what a node actually is \u2014 and both " +
    "are handed back as soon as the frame is drawn.";
  lodDetailSel.addEventListener("change", () => {
    lodSet({ detailZoom: Number(lodDetailSel.value) });
    lodUpdate();
  });

  const lodThumbSel = el("select", { class: "ants-select", style: { width: "auto", maxWidth: "240px" } });
  for (const z of LOD_THUMB_ZOOMS) {
    const opt = el("option", {
      text: z === 0 ? "previews drawn full size" : `previews as thumbnails below ${Math.round(z * 100)}% zoom`,
    });
    opt.value = String(z);
    lodThumbSel.appendChild(opt);
  }
  lodThumbSel.value = String(LOD.thumbZoom);
  lodThumbSel.title =
    "Image, preview and compare nodes keep a full-resolution bitmap on the canvas and blit it into a box that may be forty " +
    "pixels wide. Below this zoom they are served from a cached copy of about the resolution the screen can show (64, 128, " +
    "256, 512, 1024 or 2048px on the long side), scaled to the same rectangle. The graph is not touched — only the bitmap that " +
    "gets uploaded per redraw, and the first frame after a zoom change still draws the full image while the copy is made.";
  lodThumbSel.addEventListener("change", () => {
    lodSet({ thumbZoom: Number(lodThumbSel.value) });
    lodUpdate();
  });

  const lodOffBtn = el("button", { class: "ants-btn", text: "Back to full drawing" });
  lodOffBtn.title =
    "Turn all of them off \u2014 flattening, link thinning, thumbnails and the redraw cap \u2014 and let ComfyUI draw the canvas " +
    "exactly as it wants, including any DOM content this tool was hiding.";
  lodOffBtn.addEventListener("click", () => {
    lodSet({ minPx: 0, idleCapMs: 0, thumbZoom: 0, detailZoom: 0, linkStyle: "auto" });
    lodPxSel.value = "0";
    lodLinkSel.value = "auto";
    lodDetailSel.value = "0";
    lodThumbSel.value = "0";
    lodIdleSel.value = "0";
    lodUpdate();
  });

  const lodRow = el("div", { style: { display: "flex", flexWrap: "wrap", gap: "10px", alignItems: "center", margin: "4px 0" } });
  lodRow.appendChild(lodPxSel);
  lodRow.appendChild(lodLinkSel);
  lodRow.appendChild(lodDetailSel);
  lodRow.appendChild(lodThumbSel);
  lodRow.appendChild(lodIdleSel);
  lodRow.appendChild(lodOffBtn);
  container.appendChild(lodRow);
  const lodLine = el("div", { class: "ants-note", style: { whiteSpace: "pre-wrap" } });
  container.appendChild(lodLine);
  container.appendChild(
    el("p", {
      class: "ants-note",
      text:
        "Why this exists: a timer limit (the Governor tab) can only make a source run less often, and on a graph that is entirely " +
        "inside the viewport a culling scan has nothing to remove either. What is left is the cost of one redraw — this block " +
        "attacks that directly. It is off by default, it never edits the graph, it is lifted the moment you click \"Back to full " +
        "drawing\", and if any part of it throws it switches itself off rather than leave the canvas in a state this tool cannot " +
        "explain. Compare the ms/frame numbers above before and after switching it on: they are measured by the same wrapping of " +
        "drawNode/drawConnections that produced them, not by a stopwatch held next to the screen. " +
        "The preview setting is separate and works on its own: image, preview and compare nodes blit a full-resolution bitmap " +
        "into whatever box the node occupies, and at low zoom that box is a few dozen pixels \u2014 the thumbnail ladder follows the " +
        "screen (about 512px around 60% zoom down to 64px around 10%), so what changes is how much image data is uploaded per " +
        "redraw, not what the node shows. " +
        "The three settings are independent and meant to be used together. The node setting decides what a node costs \u2014 below it, " +
        "a node is one flat rectangle, and everything that lives on top of that node (image and video previews, curve editors, 3D " +
        "viewports, custom Vue or JS node UIs) is hidden with it and taken out of the per-frame layout pass. The link setting decides " +
        "the shape of a link: ComfyUI's curves, or straight lines. The thinning setting decides how much ink a curve uses \u2014 below " +
        "its zoom links are stroked 1px wide instead of 3 and lose the dark outline drawn under them, which on a long link is most of " +
        "the pixels, and the curves stay exactly where they were. Those frames are drawn with the frontend's own low-quality mode on as " +
        "well (no node shadows, no rounded corners). Everything here is remembered across sessions and handed back by \"Back to full " +
        "drawing\".",
    })
  );

  function lodUpdate() {
    const fm = frameMetrics();
    const bits = [];
    const vis = lodVisibility(app.canvas);
    if (vis && vis.total) {
      bits.push(
        `nodes ${vis.total} · on screen ${vis.visible} (${fmtPct(vis.share)}) at zoom ${vis.scale.toFixed(2)} · ` +
          `~${vis.meanPx.toFixed(0)}px wide each (estimate)`
      );
      if (vis.share >= 0.9 && vis.zoomedOut) {
        bits.push(
          "the whole graph is on screen, so culling cannot save anything here — the only levers left are cheaper drawing per " +
            "node (below) and fewer redraws (the cap)"
        );
      }
      const theirLod = lodFrontendLod(app.canvas);
      if (theirLod && theirLod.minFontSize === 0) {
        bits.push(
          "frontend LOD is switched off (Settings → LiteGraph → \"Zoom Node Level of Detail\" = 0): turning it up to " +
            "24px brings ComfyUI's own low-quality node rendering in sooner — it skips shadows and rounded corners, not nodes"
        );
      } else if (theirLod && theirLod.minFontSize === null) {
        bits.push("frontend LOD: this frontend version does not expose its LOD threshold on the canvas, so there is nothing to read here");
      } else if (theirLod) {
        bits.push(
          `frontend LOD threshold ${theirLod.minFontSize}px — ComfyUI's own low-quality rendering is ` +
            `${theirLod.lowQuality ? "active" : "not active"} at this zoom (it changes how a node is painted, not whether it is)`
        );
      }
    }
    if (lodOn()) {
      const b = LOD.baseline;
      const bits2 = [`simplified ${LOD.nodes} node draw(s) and ${LOD.links} link draw(s) so far`];
      if (LOD.capped) bits2.push(`${LOD.capped} redraw(s) merged by the idle cap`);
      const since = lodSinceSwitch();
      if (b && b.at) {
        const ago = Math.max(0, Math.round((nowMs() - b.at) / 1000));
        if (since) {
          bits2.push(
            `since the switch (${since.n} frame(s) in ${ago}s): node drawing ${fmtMs(b.nodeMsPerFrame)} → ${fmtMs(since.nodeMsPerFrame)} ms/frame · ` +
              `links ${fmtMs(b.connMsPerFrame)} → ${fmtMs(since.connMsPerFrame)} · whole frame ${fmtMs(b.meanFrameMs)} → ${fmtMs(since.meanFrameMs)} ms`
          );
        } else {
          bits2.push(`switched on ${ago}s ago — no frame has been drawn since, so there is nothing to compare yet`);
        }
      }
      // How much of the graph the node setting actually catches, and whether it
      // is catching anything that costs money. Both numbers come from the same
      // per-frame sample the drawing uses.
      if (LOD.minPx > 0 && LOD.plan.sampled) {
        const share = LOD.plan.tiny / Math.max(1, LOD.plan.sampled);
        bits2.push(
          `≈${Math.round(share * 100)}% of the graph (${LOD.plan.tiny}/${LOD.plan.sampled} sampled, ${LOD.plan.total} nodes) is painted flat ` +
            `at this zoom with "nodes under ${LOD.minPx}px"`
        );
        if (LOD.plan.needPx > LOD.minPx) {
          bits2.push(
            `the typical node is ${LOD.plan.medPx}px wide on screen at this zoom, so "nodes under ${LOD.plan.needPx}px" is the setting ` +
              `that would flatten most of the graph`
          );
        }
        if (since && share > 0.2 && Number.isFinite(b.nodeMsPerFrame) && b.nodeMsPerFrame > 0 && since.nodeMsPerFrame > b.nodeMsPerFrame * 0.9) {
          bits2.push(
            `and node drawing has not moved (${fmtMs(b.nodeMsPerFrame)} → ${fmtMs(since.nodeMsPerFrame)} ms/frame): what is left is in the ` +
              `nodes this setting does not catch — raise it and watch this line`
          );
        }
      }
      if (LOD.detailZoom > 0) {
        if (lodDetailOn()) {
          const frames = Math.max(1, since ? since.n : 1);
          if (lodLinksStraight()) {
            // Straight links used to be a side effect of the node threshold, so
            // a panel that only said "most of the graph is rectangles" left the
            // user guessing which setting to change. Name it.
            bits2.push(
              `zoomed out: ${LOD.links} link draw(s) on the straight-line path, because the link setting is ` +
                (LOD.linkStyle === "straight" ? "\"always straight lines\"" : "\"straight while the graph is rectangles\"") +
                ` \u2014 the thinning setting applies to links ComfyUI draws as curves, so switch the link setting to "keep every ` +
                `curve" to pay less for the curves instead of losing their shape`
            );
          } else {
            bits2.push(
              `zoomed out: ${LOD.thinLinks} link segment(s) stroked 1px without their outline ` +
                `(${(LOD.thinLinks / frames).toFixed(1)}/frame, curves kept)` +
                (LOD.lqMissing
                  ? " \u00b7 this frontend version does not expose its low-quality flag, so node shadows and rounded corners are unchanged"
                  : " \u00b7 node shadows and rounded corners are off for the frame")
            );
          }
        } else {
          bits2.push(
            `zoomed in: links and node detail are drawn in full above ${Math.round(LOD.detailZoom * 100)}% zoom`
          );
        }
      }
      if (LOD.minPx > 0) {
        if (LOD.domHidden) {
          bits2.push(
            `${LOD.domHidden} DOM element(s) of ${LOD.domNodes} boxed node(s) hidden ` +
              `(image and video previews, curve editors, custom node UIs)` +
              (LOD.domStilled
                ? `, ${LOD.domStilled} widget(s) also out of the per-frame layout pass`
                : "") +
              ` \u2014 they come back the moment the node does`
          );
        } else if (LOD.plan.tiny > 0) {
          bits2.push("no DOM content to hide on the nodes this setting catches (their visuals are canvas-drawn)");
        }
      }
      if (LOD.thumbZoom > 0) {
        const frames = Math.max(1, since ? since.n : 1);
        if (lodPreviewsOn()) {
          bits2.push(
            `previews: ${LOD.imgThumb} of ${LOD.imgSeen} image draw(s) served from a cached thumbnail ` +
              `(${(LOD.imgThumb / frames).toFixed(1)}/frame) · ${LOD.thumbsBuilt} cached, ≈${fmtBytes(LOD.thumbBytes)}` +
              `${LOD.imgFull ? ` · ${LOD.imgFull} drawn full size while a thumbnail was made` : ""}` +
              `${LOD.imgSkipped ? ` · ${LOD.imgSkipped} draw(s) left alone (source already small)` : ""}` +
              `${LOD.thumbFailures ? ` · ${LOD.thumbFailures} failed` : ""}`
          );
        } else {
          bits2.push(
            `previews: drawn full size at this zoom (${LOD.zoom.toFixed(2)}) — thumbnails start below ${Math.round(LOD.thumbZoom * 100)}%`
          );
        }
      }
      bits.push(bits2.join(" · "));
    } else {
      bits.push("off — the canvas is drawn exactly as ComfyUI draws it");
    }
      if (!LOD.minPx && !LOD.idleCapMs && LOD.thumbZoom > 0) {
        bits.push(
          "nothing but the previews is switched on: they are the part that helps at every zoom, and \"Back to full drawing\" turns them off too"
        );
      }
    if (LOD.error) bits.push(`turned itself off after an error: ${LOD.error}`);
    lodLine.textContent = bits.join("\n");
  }

  ui.state.tweaks = { update: lodUpdate };
}

// --- Nodes ------------------------------------------------------------------

function buildNodesTab(container) {
  const budgetCallout = el("div", { class: "ants-callout" });
  const budgetTable = el("table", { class: "ants-kv" });
  const budgetRows = {};
  for (const [key, label] of [
    ["total", "Whole frame (canvas.draw)"],
    ["nodeDraw", "↳ drawNode() — all node rendering"],
    ["hooks", "↳ wrapped draw hooks (subset of drawNode)"],
    ["chrome", "↳ LiteGraph chrome / widgets / bitmaps"],
    ["conns", "↳ drawConnections()"],
    ["other", "↳ everything else (grid, groups, overlays)"],
    ["pcts", "frame time p50 / p95 / p99"],
  ]) {
    const tr = el("tr");
    tr.appendChild(td({ class: "ants-kv-label", text: label }));
    const v = td({ class: "ants-kv-value" });
    tr.appendChild(v);
    budgetTable.appendChild(tr);
    budgetRows[key] = v;
  }
  const rateLine = el("div", { class: "ants-note" });
  budgetCallout.appendChild(budgetTable);
  budgetCallout.appendChild(rateLine);

  const invLine = el("div", { class: "ants-note" });
  const invTable = makeTable([
    { label: "Redraw request caller (sampled)" },
    { label: "pack" },
    { label: "est. /s", right: true },
    { label: "share", right: true },
    { label: "samples", right: true },
  ]);

  const types = makeTable([
    { label: "Node type", key: "type", text: true },
    { label: "ms/frame", right: true, key: "ms" },
    { label: "% of frame", right: true, key: "share" },
    { label: "calls/frame", right: true, key: "calls" },
    { label: "ms/call", right: true, key: "perCall" },
    { label: "p95 call", right: true, key: "p95" },
  ]);
  const typeNote = el("p", { class: "ants-note" });
  typeNote.textContent =
    "Click any column header to sort by it (again to reverse, a third time for the default: most expensive first). " +
    "drawNode() time includes every wrapped hook as a subset, so do not add this table to the Timing tab. " +
    "\"calls/frame\" is calls per redraw of the canvas, so for a type that is painted every frame it is close to the number of " +
    "instances on screen; a value well below 1 means most of this type is off-screen or culled on a given redraw, which is cheap " +
    "by definition. Use \"% of frame\" and \"ms/call\" to find the expensive ones: a high ms/call with a low calls/frame is one " +
    "heavy node, a low ms/call with a high calls/frame is many cheap nodes.";

  container.appendChild(budgetCallout);
  container.appendChild(el("div", { class: "ants-section-title", text: "Who is asking for redraws" }));
  container.appendChild(invLine);
  container.appendChild(invTable.table);
  container.appendChild(
    el("p", {
      class: "ants-note",
      text:
        "Every redraw request funnels through canvas.setDirty(), so this table answers the question v1 could only guess at " +
        "(it tried to infer a hidden clock from node call counts, and could never name a culprit). The rate is exact; the caller " +
        "column is sampled at ~20/s and scaled, so read it as a share. A source stuck at a fixed share with a TimerHandler " +
        "invoker is the classic \"all my nodes redraw 20x/second no matter what\" bug.",
    })
  );
  container.appendChild(el("div", { class: "ants-section-title", text: "Per node type" }));
  container.appendChild(types.table);
  container.appendChild(typeNote);

  const typeCapper = makeRowCapper(container, "nodes", "node types", () => update());
  const typeSorter = makeSorter(
    types.headers,
    {
      type: (r) => r.type,
      ms: (r) => r.msPerFrame,
      share: (r) => (frameMetrics().meanFrameMs > 0 ? r.msPerFrame / frameMetrics().meanFrameMs : null),
      calls: (r) => r.callsPerFrame,
      perCall: (r) => r.msPerCall,
      p95: (r) => r.p95,
    },
    {
      defaultKey: "ms",
      onChange: () => {
        typeRows.deferReorder = false;
        update();
        typeRows.deferReorder = true;
      },
    }
  );
  typeSorter.attach(types.ths);
  const invSorter = makeSorter(
    invTable.headers,
    {
      sig: (s) => s.sig,
      pack: (s) => s.pack,
      est: (s) => s.estPerSec,
      share: (s) => s.share,
      samples: (s) => s.sampled,
    },
    { defaultKey: "est", onChange: () => update() }
  );
  invSorter.attach(invTable.ths);

  const typeRows = new RowSet(types.tbody, () => {
    const tr = el("tr", { class: "ants-row" });
    const name = td();
    const ms = td({ class: "ants-ms ants-num" });
    const share = td({ class: "ants-num" });
    const calls = td({ class: "ants-num" });
    const perCall = td({ class: "ants-num" });
    const p95 = td({ class: "ants-num" });
    for (const c of [name, ms, share, calls, perCall, p95]) tr.appendChild(c);
    return [tr];
  });
  const invRows = new RowSet(invTable.tbody, () => {
    const tr = el("tr");
    const src = td();
    const pack = td();
    const est = td({ class: "ants-num" });
    const share = td({ class: "ants-num" });
    const samples = td({ class: "ants-num" });
    for (const c of [src, pack, est, share, samples]) tr.appendChild(c);
    return [tr];
  });

  function set(key, text, tone) {
    setText(budgetRows[key], text);
    if (tone) budgetRows[key].style.color = tone;
  }

  function update() {
    const fm = frameMetrics();
    const pct = framePercentiles();
    const raf = rafMetrics();
    if (!fm.ok) {
      budgetCallout.className = "ants-callout warn";
      for (const k of ["total", "nodeDraw", "hooks", "chrome", "conns", "other", "pcts"]) set(k, "—");
      rateLine.textContent =
        "No canvas frames recorded yet. Pan or zoom the graph, or force a redraw from the Testing tab. If this stays empty while " +
        "you pan, this frontend version may not expose LGraphCanvas.draw() — check the browser console for [ANTs Tracker] warnings.";
    } else {
      budgetCallout.className = fm.otherShare > 0.25 ? "ants-callout warn" : "ants-callout";
      set("total", `${fmtMs(fm.meanFrameMs)} ms over ${fm.n} frame(s) (${fmtRate(fm.fps)} fps, ${(fm.windowMs / 1000).toFixed(0)}s window)`);
      set("nodeDraw", `${fmtMs(fm.nodeMsPerFrame)} ms  ${fmtPct(fm.nodeShare)}`);
      set("hooks", `${fmtMs(fm.attrMsPerFrame)} ms  ${fmtPct(fm.attrShare)}`);
      set("chrome", `${fmtMs(fm.chromeMsPerFrame)} ms  ${fmtPct(fm.chromeShare)}`);
      set("conns", `${fmtMs(fm.connMsPerFrame)} ms  ${fmtPct(fm.connShare)}`);
      set("other", `${fmtMs(fm.otherMsPerFrame)} ms  ${fmtPct(fm.otherShare)}`);
      set("pcts", pct.n ? `${fmtMs(pct.p50)} / ${fmtMs(pct.p95)} / ${fmtMs(pct.p99)} ms` : "—");
      const bits = [];
      if (Number.isFinite(raf.displayHz)) bits.push(`display ${raf.displayHz.toFixed(0)}Hz`);
      if (Number.isFinite(raf.drawsPerRaf)) bits.push(`${raf.drawsPerRaf.toFixed(2)} redraws per displayed frame`);
      if (Number.isFinite(raf.drawsPerRaf) && raf.drawsPerRaf > 1.25) {
        bits.push(`≈${fmtPct(1 - 1 / raf.drawsPerRaf)} of redraws are redundant (more paints than the screen shows) — capping the redraw rate is the fix`);
      }
      if (fm.otherShare > 0.25) {
        bits.push("a quarter or more of the frame is outside drawNode/drawConnections: background grid, groups, canvas-level draw hooks, or a prototype-patched render path");
      }
      rateLine.textContent = bits.join(" · ");
    }

    const inv = invalidationMetrics();
    const invBits = [`${fmtRate(inv.perSec)} redraw requests/s`];
    if (Number.isFinite(inv.perRaf)) invBits.push(`≈${inv.perRaf.toFixed(2)} per displayed frame`);
    invBits.push(inv.sources.length ? `top caller: ${inv.sources[0].sig}` : "no caller sampled yet");
    setText(invLine, invBits.join(" · "));
    invRows.sync(
      invSorter.sort(inv.sources).slice(0, 12),
      (s) => s.sig,
      (row, s) => {
        const c = row.nodes[0].children;
        setText(c[0], s.sig);
        setText(c[1], s.pack || "—");
        setText(c[2], Number.isFinite(s.estPerSec) ? fmtRate(s.estPerSec) : "—");
        setText(c[3], Number.isFinite(s.share) ? fmtPct(s.share) : "—");
        setText(c[4], s.sampled);
      }
    );

    const rows = typeSorter.sort(nodeRows());
    typeRows.sync(
      typeCapper.apply(rows),
      (r) => r.type,
      (row, r) => {
        const c = row.nodes[0].children;
        const share = fm.meanFrameMs > 0 ? r.msPerFrame / fm.meanFrameMs : NaN;
        setText(c[0], r.type);
        const perFrame = r.callsPerFrame;
        setText(c[1], Number.isFinite(r.msPerFrame) ? fmtMs(r.msPerFrame) : "—");
        setText(c[2], Number.isFinite(share) ? fmtPct(share) : "—");
        setText(c[3], Number.isFinite(perFrame) ? perFrame.toFixed(2) : "—");
        setText(c[4], fmtMs(r.msPerCall, 3));
        setText(c[5], fmtMs(r.p95, 2));
        const cls = share > 0.15 ? "ants-hot" : share > 0.05 ? "ants-warm" : "";
        if (row.nodes[0].className !== cls) row.nodes[0].className = cls;
      }
    );
  }

  ui.state.nodes = { rowSet: typeRows, update, sorter: typeSorter };
}

// --- Stalls ----------------------------------------------------------------

function buildStallsTab(container) {
  const callout = el("div", { class: "ants-callout" });
  const kv = el("table", { class: "ants-kv" });
  const vals = {};
  for (const [key, label] of [
    ["blocking", "Main-thread blocking"],
    ["count", "Stall rate"],
    ["worst", "Worst stall this session"],
    ["share", "Share of wall clock"],
    ["support", "Attribution source"],
  ]) {
    const tr = el("tr");
    tr.appendChild(td({ class: "ants-kv-label", text: label }));
    const v = td({ class: "ants-kv-value" });
    tr.appendChild(v);
    kv.appendChild(tr);
    vals[key] = v;
  }
  callout.appendChild(kv);

  const table = makeTable([
    { label: "Script / function", key: "sig", text: true },
    { label: "pack", key: "pack", text: true },
    { label: "trigger", key: "trigger", text: true },
    { label: "count", right: true, key: "count" },
    { label: "blocking", right: true, key: "blocking" },
    { label: "% of blocking", right: true, key: "share" },
    { label: "ms/stall", right: true, key: "perStall" },
    { label: "worst", right: true, key: "worst" },
    { label: "forced layout", right: true, key: "layout" },
  ]);
  const empty = el("div", { class: "ants-empty" });
  const note = el("p", { class: "ants-note" });
  note.textContent =
    "Click any column header to sort by it (again to reverse, a third time for the default: most blocking first). " +
    "This lane is deliberately not canvas drawing. It is main-thread time that no draw hook owns: a heartbeat setInterval, a " +
    "fetch/DOM polling loop, forced layout thrash, a big GC, a Vue re-render, or this panel itself (look for " +
    "extensions/ANTs_ComfyUI_Frontend_Performance_Tracker/tracker.js and compare it to the figures in the Memory tab's self-cost " +
    "block). The distinction matters for the fix: if blocking is high while the Nodes tab's frame budget is small, capping the " +
    "redraw rate treats a symptom, and the actual fix is in whatever owns this script. \"trigger\" is the Long Animation Frame " +
    "invoker (TimerHandler:setInterval, event-listener, microtask, user-callback...). Script-level attribution needs Chrome 123+; " +
    "older Chromium reports task durations without naming the script, and Firefox/Safari expose no API for this at all.";
  container.appendChild(callout);
  container.appendChild(empty);
  container.appendChild(table.table);
  const capper = makeRowCapper(container, "stalls", "scripts", () => update());
  container.appendChild(note);

  const sorter = makeSorter(
    table.headers,
    {
      sig: (s) => s.sig,
      pack: (s) => s.pack,
      trigger: (s) => s.invoker,
      count: (s) => s.count,
      blocking: (s) => s.blockingMs,
      share: (s) => (shareOfBlocking > 0 ? s.blockingMs / shareOfBlocking : null),
      perStall: (s) => (s.count > 0 ? s.blockingMs / s.count : null),
      worst: (s) => s.worstMs,
      layout: (s) => (s.forcedLayoutMs > 0 ? s.forcedLayoutMs : null),
    },
    {
      defaultKey: "blocking",
      onChange: () => {
        rows.deferReorder = false;
        update();
        rows.deferReorder = true;
      },
    }
  );
  sorter.attach(table.ths);

  let shareOfBlocking = 0;
  const rows = new RowSet(table.tbody, () => {
    const tr = el("tr");
    for (const i of [0, 1, 2, 3, 4, 5, 6, 7, 8]) {
      const numeric = i >= 3;
      const cell = td({ class: numeric ? "ants-num" : null });
      if (i === 4) cell.classList.add("ants-ms");
      tr.appendChild(cell);
    }
    return [tr];
  });

  function update() {
    const st = stallMetrics();
    shareOfBlocking = st.lifetimeBlocking;
    setText(vals.blocking, `${fmtRate(st.blockingMsPerSec)} ms of blocking per second of wall clock`);
    setText(vals.count, `${st.perSec.toFixed(1)} per second (${st.total} total this session)`);
    setText(vals.worst, st.worst ? `${fmtMs(st.worst, 0)} ms` : "—");
    setText(vals.share, `${fmtPct(st.blockingMsPerSec / 1000)} of every second is spent blocked`);
    setText(
      vals.support,
      S.env.loaf ? "Long Animation Frames (script + function + invoker)" : S.env.longtask ? "longtask entries only (this browser reports no script attribution)" : "unavailable in this browser"
    );
    callout.className = st.blockingMsPerSec > 100 ? "ants-callout bad" : st.blockingMsPerSec > 30 ? "ants-callout warn" : "ants-callout";
    setText(
      empty,
      st.total === 0
        ? "No stalls recorded. Either the main thread is healthy, or this browser exposes no long-task API (see \"Attribution source\" above)."
        : ""
    );
    empty.style.display = st.total === 0 ? "" : "none";
    rows.sync(
      capper.apply(sorter.sort(st.rows)),
      (s) => s.sig,
      (row, s) => {
        const c = row.nodes[0].children;
        setText(c[0], "");
        c[0].appendChild(document.createTextNode(s.sig));
        if (s.display) {
          const tag = el("span", { class: "ants-tag", text: "canvas repaint" });
          tag.title =
            "This is the source that draws the canvas, so the blocking time here is drawing time that the frame budget also counts \u2014 " +
            "not a stall in the \"something other than drawing blocked the thread\" sense. The Governor's display lane keeps it " +
            "uncapped while you interact.";
          c[0].appendChild(tag);
        }
        setText(c[1], s.pack || "—");
        setText(c[2], s.invoker || "—");
        setText(c[3], s.count);
        setText(c[4], `${fmtMs(s.blockingMs, 0)} ms`);
        setText(c[5], shareOfBlocking > 0 ? fmtPct(s.blockingMs / shareOfBlocking) : "—");
        c[5].title = "This script's share of all blocking time attributed in the last 30 seconds.";
        setText(c[6], s.count > 0 ? `${fmtMs(s.blockingMs / s.count, 1)} ms` : "—");
        c[6].title = "Average blocking time per occurrence (blocking ÷ count). A high count with a low ms/stall is a cheap heartbeat; a low count with a high ms/stall is one heavy operation worth a DevTools trace.";
        setText(c[7], `${fmtMs(s.worstMs, 0)} ms`);
        setText(c[8], s.forcedLayoutMs > 0 ? `${fmtMs(s.forcedLayoutMs, 0)} ms` : "—");
        if (s.forcedLayoutMs > 0) c[8].title = "Forced style/layout recalculation inside this script — usually a DOM read after a write (layout thrash).";
      }
    );
  }

  ui.state.stalls = { rowSet: rows, update, sorter };
}

// --- Load ------------------------------------------------------------------

function buildLoadTab(container) {
  const callout = el("div", { class: "ants-callout" });
  const kv = el("table", { class: "ants-kv" });
  const vals = {};
  for (const [key, label] of [
    ["resources", "Resources timed by the browser"],
    ["bytes", "Total transferred"],
    ["span", "Page load span (first → last)"],
  ]) {
    const tr = el("tr");
    tr.appendChild(td({ class: "ants-kv-label", text: label }));
    const v = td({ class: "ants-kv-value" });
    tr.appendChild(v);
    kv.appendChild(tr);
    vals[key] = v;
  }
  callout.appendChild(kv);

  const table = makeTable([
    { label: "Extension pack" },
    { label: "transferred", right: true },
    { label: "files", right: true },
    { label: "size unknown (cached)", right: true },
    { label: "load span", right: true },
    { label: "slowest file", right: true },
    { label: "avg file", right: true },
  ]);
  const note = el("p", { class: "ants-note" });
  note.textContent =
    "Startup cost only. \"load span\" is when the pack's first file began fetching to when its last one finished, not a sum of " +
    "durations: these requests overlap, so summing them (which reports a \"load time\" longer than the page load itself) tells you " +
    "nothing. A pack with many files, a long span and a high slowest-file time is the one blocking first paint; byte count alone is " +
    "not the cost that matters. Cached files report no transfer size, hence the separate column. Runtime cost lives in the Timing, " +
    "Nodes and Stalls tabs — nothing here can tell you that a pack is expensive to run.";
  container.appendChild(callout);
  container.appendChild(table.table);
  container.appendChild(note);

  const rows = new RowSet(table.tbody, () => {
    const tr = el("tr");
    for (let i = 0; i < 7; i++) tr.appendChild(td({ class: i > 0 ? "ants-num" : null }));
    return [tr];
  });

  function update() {
    const { byPack, totals } = resourceLoadSummary();
    const list = [...byPack.values()].sort((a, b) => b.bytes - a.bytes || b.spanMs - a.spanMs);
    setText(vals.resources, totals ? `${totals.resourceCount} (all of them; only /extensions/ ones are grouped below)` : "—");
    setText(vals.bytes, totals ? fmtBytes(totals.bytes) : "—");
    setText(vals.span, totals && totals.spanMs ? `${fmtMs(totals.spanMs, 0)} ms` : "—");
    rows.sync(
      list,
      (p) => p.pack,
      (row, p) => {
        const c = row.nodes[0].children;
        setText(c[0], p.pack);
        setText(c[1], fmtBytes(p.bytes));
        setText(c[2], p.files);
        setText(c[3], p.cached ? p.cached : "—");
        setText(c[4], `${fmtMs(p.spanMs, 0)} ms`);
        setText(c[5], `${fmtMs(p.slowest, 0)} ms`);
        setText(c[6], `${fmtMs(p.avgMs, 0)} ms`);
        c[4].title =
          "First request start → last response end for this pack. Concurrent fetches overlap, so this is the pack's real wall-clock contribution at startup.";
        if (p.cached) c[3].title = "Files whose transfer size the browser did not report (served from cache). Their bytes are unknowable from page JS.";
      }
    );
  }

  ui.state.load = { rowSet: rows, update };
}

// --- Memory ----------------------------------------------------------------

let memBaseline = null;
let memBaselineAt = 0;

function buildMemoryTab(container) {
  const callout = el("div", { class: "ants-callout" });
  const kv = el("table", { class: "ants-kv" });
  const vals = {};
  for (const [key, label] of [
    ["used", "JS heap used"],
    ["total", "JS heap allocated"],
    ["limit", "JS heap limit"],
    ["pressure", "Heap pressure"],
    ["baseline", "Since baseline"],
    ["rate", "Trend (last 60s)"],
    ["range", "Range (last 2 min)"],
  ]) {
    const tr = el("tr");
    tr.appendChild(td({ class: "ants-kv-label", text: label }));
    const v = td({ class: "ants-kv-value" });
    tr.appendChild(v);
    kv.appendChild(tr);
    vals[key] = v;
  }
  const bar = el("div", { class: "ants-bar" });
  const barFill = el("div");
  bar.appendChild(barFill);
  const spark = makeSpark(60);
  const btnRow = el("div", { class: "ants-copyrow", style: { marginTop: "6px" } });
  const baseBtn = el("button", { class: "ants-btn", text: "Set baseline" });
  const clearBtn = el("button", { class: "ants-btn", text: "Clear baseline" });
  btnRow.appendChild(baseBtn);
  btnRow.appendChild(clearBtn);
  callout.appendChild(kv);
  callout.appendChild(bar);
  callout.appendChild(spark.el);
  callout.appendChild(btnRow);

  const selfKv = el("table", { class: "ants-kv" });
  const selfVals = {};
  for (const [key, label] of [
    ["buckets", "Tracked buckets"],
    ["rings", "Ring-buffer memory"],
    ["render", "Panel render cost"],
    ["sweep", "Bookkeeping cost"],
    ["hooks", "Instrumented hooks"],
  ]) {
    const tr = el("tr");
    tr.appendChild(td({ class: "ants-kv-label", text: label }));
    const v = td({ class: "ants-kv-value" });
    tr.appendChild(v);
    selfKv.appendChild(tr);
    selfVals[key] = v;
  }

  const note = el("p", { class: "ants-note" });
  note.textContent =
    "There is no per-extension heap breakdown, and no tool can honestly produce one: the browser does not expose per-object or " +
    "per-script memory to page JS. What is measurable is a trend (if the heap climbs while the graph sits idle, that is a leak, not " +
    "a cache) and an A/B (baseline → mute a suspect in the Timing tab → wait → compare). Chromium only: performance.memory is a " +
    "non-standard API and Firefox does not expose it at all. Force a GC from DevTools' Memory panel before trusting small deltas.";
  container.appendChild(callout);
  container.appendChild(el("div", { class: "ants-section-title", text: "The tracker's own footprint" }));
  container.appendChild(selfKv);
  container.appendChild(note);

  baseBtn.addEventListener("click", () => {
    if (performance.memory) {
      memBaseline = performance.memory.usedJSHeapSize;
      memBaselineAt = nowMs();
      update();
    }
  });
  clearBtn.addEventListener("click", () => {
    memBaseline = null;
    update();
  });

  function update() {
    const sc = selfCostMetrics();
    setText(selfVals.buckets, sc.buckets);
    setText(selfVals.rings, fmtBytes(sc.ringBytes));
    setText(
      selfVals.render,
      `${fmtMs(sc.renderMsPerSec * 1000, 0)} µs/second (${S.counters.renderCount} panel renders so far` +
        `${uiRefreshMs > UI_REFRESH_MS ? `, refresh slowed to every ${(uiRefreshMs / 1000).toFixed(1)}s to stay out of the way` : ""})`
    );
    setText(selfVals.sweep, `${fmtMs(sc.sweepMsPerSec * 1000, 0)} µs/second`);
    setText(selfVals.hooks, `${sc.wrappedHooks} wrapped — each adds two performance.now() calls and one ring write per invocation`);
    selfVals.rings.title = "Typed-array ring buffers behind every metric. Buckets grow under load and are never deleted while a wrapped hook still points at them.";

    const mem = performance.memory;
    if (!mem) {
      callout.className = "ants-callout warn";
      for (const key in vals) setText(vals[key], "—");
      setText(vals.used, "unavailable (performance.memory is Chromium-only)");
      return;
    }
    callout.className = "ants-callout";
    const used = mem.usedJSHeapSize;
    setText(vals.used, fmtBytes(used));
    setText(vals.total, fmtBytes(mem.totalJSHeapSize));
    setText(vals.limit, fmtBytes(mem.jsHeapSizeLimit));
    const pressure = mem.jsHeapSizeLimit ? used / mem.jsHeapSizeLimit : 0;
    setText(vals.pressure, fmtPct(pressure));
    barFill.style.width = `${Math.max(1, Math.min(100, pressure * 100)).toFixed(1)}%`;
    barFill.style.background = pressure > 0.7 ? "#ff6b6b" : pressure > 0.4 ? "#f0a020" : "#46688c";
    if (memBaseline !== null) {
      const delta = used - memBaseline;
      const secs = (nowMs() - memBaselineAt) / 1000;
      setText(vals.baseline, `${delta >= 0 ? "+" : "−"}${fmtBytes(Math.abs(delta))} over ${secs.toFixed(0)}s`);
    } else {
      setText(vals.baseline, "not set");
    }
    const now = nowMs();
    trimIfLive(S.mem, now - 120000);
    const recent = S.mem.aggregate(now - 60000);
    if (recent.n > 2 && recent.span > 1000) {
      const mbPerMin = (recent.last - recent.first) / 1048576 / (recent.span / 60000);
      setText(vals.rate, `${mbPerMin >= 0 ? "+" : "−"}${Math.abs(mbPerMin).toFixed(2)} MB/min (${recent.n} samples)`);
      vals.rate.style.color = mbPerMin > 2 ? "#ff6b6b" : mbPerMin > 0.5 ? "#f0a020" : null;
      vals.rate.title =
        "Measured over the last 60s of samples. A steady climb while the graph is idle is a leak; a rise that plateaus is a cache " +
        "filling up and is usually fine.";
    } else {
      setText(vals.rate, "not enough samples yet");
    }
    const all = S.mem.aggregate(now - 120000);
    setText(vals.range, all.n ? `${fmtBytes(all.min)} … ${fmtBytes(all.max)}` : "—");
    const samples = [];
    const step = all.n / 60;
    for (let i = 0; i < 60; i++) {
      const idx = Math.floor(i * step);
      samples.push(idx < S.mem.n ? S.mem.v[S.mem._idx(idx)] : 0);
    }
    spark.set(samples);
  }

  ui.state.memory = { update };
}

// --- GPU -------------------------------------------------------------------

const gpuState = { system: null, nvidia: null, fetchedAt: 0, error: null, inFlight: false };

async function refreshGpu() {
  if (gpuState.inFlight) return;
  gpuState.inFlight = true;
  try {
    const res = await fetch("/system_stats");
    if (res && res.ok) {
      gpuState.system = await res.json();
      gpuState.error = null;
    } else {
      gpuState.error = `ComfyUI answered ${res ? res.status : "?"} for /system_stats`;
    }
  } catch (e) {
    gpuState.error = `Could not reach /system_stats: ${e && e.message}`;
  }
  try {
    const res = await fetch("/ants_tracker/gpu");
    if (res && res.ok) {
      const body = await res.json();
      gpuState.nvidia = body && body.available ? body : { note: (body && body.reason) || "nvidia-smi reported nothing" };
    } else {
      gpuState.nvidia = null; // route not installed (404) or older backend — not an error
    }
  } catch (e) {
    gpuState.nvidia = null;
  }
  gpuState.fetchedAt = Date.now();
  gpuState.inFlight = false;
  if (ui.state.gpu) ui.state.gpu.update();
}

function buildGpuTab(container) {
  const callout = el("div", { class: "ants-callout" });
  const devices = el("div");
  const refreshRow = el("div", { class: "ants-copyrow", style: { marginTop: "6px" } });
  const refreshBtn = el("button", { class: "ants-btn primary", text: "Refresh now" });
  const status = el("span", { class: "ants-note" });
  refreshRow.appendChild(refreshBtn);
  refreshRow.appendChild(status);
  const note = el("p", { class: "ants-note" });
  note.textContent =
    "Per-extension VRAM attribution is not possible from page JavaScript — that is a sandbox boundary, not a missing feature, and " +
    "no browser extension changes it. What is possible, and is on this tab: ComfyUI's own /system_stats (torch's view per device), " +
    "plus an optional server-side nvidia-smi snapshot if this folder's backend route is present. Actionable readings: a headroom " +
    "under ~10% means the driver will start evicting to system RAM, which shows up as multi-hundred-millisecond frames and is not a " +
    "JavaScript problem at all; a large gap between torch \"allocated\" and the driver's \"used\" means fragmentation is holding " +
    "memory hostage, and that is fixed on the Python side (PYTORCH_CUDA_ALLOC_CONF, --reserve-vram), not in any node's frontend code.";
  container.appendChild(callout);
  container.appendChild(devices);
  container.appendChild(refreshRow);
  container.appendChild(note);
  refreshBtn.addEventListener("click", () => {
    setText(status, "Refreshing…");
    refreshGpu();
  });

  function kvRow(parent, label, value, opts) {
    const tr = el("tr");
    tr.appendChild(td({ class: "ants-kv-label", text: label }));
    const v = td({ class: "ants-kv-value", text: value });
    tr.appendChild(v);
    if (opts && opts.title) v.title = opts.title;
    parent.appendChild(tr);
    if (opts && Number.isFinite(opts.bar)) {
      const b = el("div", { class: "ants-bar" });
      const fill = el("div");
      fill.style.width = `${Math.max(1, Math.min(100, opts.bar * 100)).toFixed(1)}%`;
      fill.style.background = opts.bar > 0.9 ? "#ff6b6b" : opts.bar > 0.75 ? "#f0a020" : "#46688c";
      b.appendChild(fill);
      const trBar = el("tr");
      trBar.appendChild(td());
      const cell = td();
      cell.appendChild(b);
      trBar.appendChild(cell);
      parent.appendChild(trBar);
    }
    return v;
  }

  function update() {
    devices.textContent = "";
    callout.textContent = "";
    if (!gpuState.system) {
      callout.className = gpuState.error ? "ants-callout warn" : "ants-callout";
      callout.appendChild(el("div", { text: gpuState.error || "No data yet. Opening this tab triggers a fetch; use Refresh now to retry." }));
    } else {
      callout.className = "ants-callout";
      const devs = gpuState.system.devices || [];
      if (!devs.length) {
        callout.appendChild(el("div", { text: "ComfyUI reported no devices in /system_stats." }));
      }
      const d0 = devs[0];
      if (d0 && d0.vram_total) {
        const headroom = d0.vram_free / d0.vram_total;
        callout.appendChild(
          el("div", {
            text:
              `Headroom: ${fmtBytes(d0.vram_free)} free of ${fmtBytes(d0.vram_total)} (${fmtPct(headroom)}). ` +
              (headroom < 0.1
                ? "Under 10% — the driver is likely to start evicting to system RAM. Slow frames caused this way look identical to a JavaScript problem from inside the page, so rule this out first."
                : "Comfortable. A slow frame right now is CPU/JS side, not VRAM pressure."),
          })
        );
      }
    }
    if (gpuState.system) {
      const kv = el("table", { class: "ants-kv" });
      for (const d of gpuState.system.devices || []) {
        const header = el("tr");
        header.appendChild(td({ class: "ants-kv-label", text: `${d.name || "device"}${d.type ? ` (${d.type})` : ""}` }));
        header.appendChild(td());
        kv.appendChild(header);
        const used = (d.vram_total || 0) - (d.vram_free || 0);
        kvRow(kv, "VRAM used", `${fmtBytes(used)} / ${fmtBytes(d.vram_total || 0)}`, {
          bar: d.vram_total ? used / d.vram_total : undefined,
          title:
            "ComfyUI's own numbers (vram_total - vram_free). vram_free counts torch's idle pool as free, so this is the figure that answers " +
            "'can another model load right now'; it is not the driver's used-bytes reading.",
        });
        // ComfyUI reports torch_vram_total as what torch has RESERVED from the
        // driver, and torch_vram_free as the unused part of that pool, so
        // in-use = total - free. (Real /system_stats payloads: 12.9GB device,
        // torch_vram_total 1.17GB, torch_vram_free 0.19GB.)
        const torchReserved = numOrNull(d.torch_vram_total);
        const torchFree = numOrNull(d.torch_vram_free);
        if (torchReserved !== null) {
          const inUse = torchFree !== null ? Math.max(0, torchReserved - torchFree) : null;
          kvRow(
            kv,
            "torch pool",
            inUse !== null
              ? `${fmtBytes(inUse)} in use · ${fmtBytes(torchReserved)} reserved · ${fmtBytes(torchFree)} idle`
              : `${fmtBytes(torchReserved)} reserved`,
            {
              title:
                "torch's caching allocator, as ComfyUI reports it (torch_vram_total = reserved from the driver, torch_vram_free = unused inside " +
                "that pool). \"in use\" is reserved - idle: the tensors actually held. A large idle figure is normal caching, not a leak.",
            }
          );
          if (inUse !== null && used > 0) {
            const outside = used - inUse;
            if (outside > 0) {
              kvRow(kv, "not torch", `${fmtBytes(outside)}`, {
                title:
                  "ComfyUI's used figure minus torch's tensors: CUDA context, cuDNN/cuBLAS workspaces, other processes, display, or fragmentation. " +
                  "A large value with a small torch pool means the pressure on the card is not coming from ComfyUI at all.",
              });
            }
          }
        }
      }
      devices.appendChild(kv);
    }
    if (gpuState.nvidia && !gpuState.nvidia.note) {
      const nv = gpuState.nvidia;
      const kv2 = el("table", { class: "ants-kv", style: { marginTop: "6px" } });
      for (const g of nv.gpus || []) {
        kvRow(kv2, "nvidia-smi", `${g.name || "GPU"} · utilisation ${g.utilization_gpu ?? "—"}%`);
        kvRow(kv2, "temperature / power", `${g.temperature_gpu ?? "—"}°C / ${g.power_draw ?? "—"}W of ${g.power_limit ?? "—"}W`);
        kvRow(kv2, "memory", `${g.memory_used ?? "—"} / ${g.memory_total ?? "—"} MiB`);
      }
      for (const p of nv.processes || []) {
        kvRow(kv2, `process ${p.pid ?? ""}`, `${p.name || "?"} · ${p.used_memory ?? "?"} MiB`);
      }
      devices.appendChild(kv2);
    } else if (gpuState.nvidia && gpuState.nvidia.note) {
      devices.appendChild(
        el("p", { class: "ants-note", text: `nvidia-smi side-channel: ${gpuState.nvidia.note} (/system_stats above still works.)` })
      );
    }
    setText(
      status,
      gpuState.fetchedAt ? `Updated ${((Date.now() - gpuState.fetchedAt) / 1000).toFixed(0)}s ago` : "Not fetched yet"
    );
  }

  ui.state.gpu = { update };
}

// --- Testing ---------------------------------------------------------------

const THROTTLE_PRESETS = [
  { label: "Off (normal browser/ComfyUI behavior)", ms: 0 },
  { label: "60 fps cap (~16ms)", ms: 16 },
  { label: "30 fps cap (~33ms)", ms: 33 },
  { label: "15 fps cap (~66ms)", ms: 66 },
  { label: "10 fps cap (100ms)", ms: 100 },
  { label: "5 fps cap (200ms)", ms: 200 },
  { label: "2 fps cap (500ms)", ms: 500 },
  { label: "1 fps (1000ms)", ms: 1000 },
  { label: "1 redraw / 2s", ms: 2000 },
  { label: "1 redraw / 3s", ms: 3000 },
  { label: "1 redraw / 5s", ms: 5000 },
  { label: "1 redraw / 10s — extreme", ms: 10000 },
];

const SYNTH_TICK_PRESETS = [
  { label: "Off", ms: 0 },
  { label: "1 redraw / 5s", ms: 5000 },
  { label: "every 1000ms (~1/s)", ms: 1000 },
  { label: "every 500ms (~2/s)", ms: 500 },
  { label: "every 250ms (~4/s)", ms: 250 },
  { label: "every 100ms (~10/s)", ms: 100 },
  { label: "every 50ms (~20/s)", ms: 50 },
  { label: "every 16ms (~60/s)", ms: 16 },
];

const BENCH_PRESETS = [
  { label: "3 seconds", ms: 3000, picked: false },
  { label: "6 seconds (default)", ms: 6000, picked: true },
  { label: "10 seconds", ms: 10000, picked: false },
];

function setSyntheticTick(ms) {
  syntheticTickMs = ms;
  if (syntheticTickTimer) {
    clearInterval(syntheticTickTimer);
    syntheticTickTimer = null;
  }
  if (ms > 0) {
    syntheticTickTimer = govOwn(() => setInterval(() => {
      try {
        if (app.canvas && typeof app.canvas.setDirty === "function") app.canvas.setDirty(true, true);
        else if (app.canvas && typeof app.canvas.draw === "function") app.canvas.draw(true, true);
        else warnOnce("no-force-draw", "Can't force a redraw: app.canvas is not callable in this frontend version.");
      } catch (e) {
        warnOnce("synthetic-tick-error", `Forced redraw failed: ${e && e.message}`);
      }
    }, ms));
  }
}

function benchLine(r) {
  if (!r) return "not run yet";
  return (
    `${r.frames} frames over ${(r.spanMs / 1000).toFixed(1)}s · mean ${fmtMs(r.meanFrameMs)} ms/frame · p95 ${fmtMs(r.p95)} ms · ` +
    `${fmtMs(r.fps, 1)} fps · hooks ${fmtPct(r.attrShare)}`
  );
}

function buildTestingTab(container) {
  const capWrap = el("div", { style: { marginBottom: "14px" } });
  capWrap.appendChild(el("label", { text: "Canvas redraw rate cap", style: { display: "block", marginBottom: "4px", color: "#ccc" } }));
  const capSelect = el("select", { class: "ants-select" });
  for (const p of THROTTLE_PRESETS) {
    const opt = el("option", { text: p.label });
    opt.value = String(p.ms);
    capSelect.appendChild(opt);
  }
  capSelect.value = String(drawThrottleMs);
  capSelect.addEventListener("change", () => {
    drawThrottleMs = Number(capSelect.value);
    if (drawThrottleMs === 0 && capTrailingTimer) {
      clearTimeout(capTrailingTimer);
      capTrailingTimer = null;
    }
    update();
  });
  capWrap.appendChild(capSelect);
  capWrap.appendChild(
    el("p", {
      class: "ants-note",
      text:
        "Skips a redraw arriving sooner than this interval after the last real one, then schedules exactly one trailing redraw, so " +
        "redraws are delayed rather than dropped (dropping them could leave the canvas on stale pixels indefinitely). That makes this " +
        "a genuine mitigation for huge graphs, not only a diagnostic. The fps pill should settle near the cap you pick; when a cap of " +
        "1-5 fps gives fewer than 4 frames in 10s, the frame numbers automatically widen to a 30s window so they stay meaningful.",
    })
  );

  const tickWrap = el("div", { style: { marginBottom: "14px" } });
  tickWrap.appendChild(el("label", { text: "Synthetic forced-tick generator", style: { display: "block", marginBottom: "4px", color: "#ccc" } }));
  const tickSelect = el("select", { class: "ants-select" });
  for (const p of SYNTH_TICK_PRESETS) {
    const opt = el("option", { text: p.label });
    opt.value = String(p.ms);
    tickSelect.appendChild(opt);
  }
  tickSelect.value = String(syntheticTickMs);
  tickSelect.addEventListener("change", () => {
    setSyntheticTick(Number(tickSelect.value));
    update();
  });
  tickWrap.appendChild(tickSelect);
  tickWrap.appendChild(
    el("p", {
      class: "ants-note",
      text:
        "Forces a full redraw on a fixed clock, through the same setDirty funnel as everything else, so it is visible to this tool's " +
        "own instrumentation: watch the \"redraw req\" pill and the Nodes tab's caller table react. Useful to check how cost scales with " +
        "redraw rate in isolation, or as a known reference tick next to a real heartbeat. At 16ms with a large graph, JS is single " +
        "threaded and a full redraw can take longer than the interval: that means \"redraw back to back\", not \"60 times a second\".",
    })
  );

  const counters = el("table", { class: "ants-kv" });
  const cvals = {};
  for (const [key, label] of [
    ["draws", "Canvas redraws (lifetime)"],
    ["capped", "Redraws rate-capped"],
    ["deferred", "Trailing redraws scheduled"],
    ["muted", "Hook calls skipped by mutes"],
    ["hooks", "Wrapped hooks"],
  ]) {
    const tr = el("tr");
    tr.appendChild(td({ class: "ants-kv-label", text: label }));
    const v = td({ class: "ants-kv-value" });
    tr.appendChild(v);
    counters.appendChild(tr);
    cvals[key] = v;
  }

  const benchIntro = el("p", { class: "ants-note" });
  benchIntro.textContent =
    "Hand measurement is not comparable between runs: how fast you dragged changes a per-4s sum by 4x, and a slow cap forces a " +
    "window-filling wait that a fast one does not. This runs an identical pan for a fixed number of seconds and reports mean ms/frame, " +
    "p95 and fps over exactly that span, so \"mute a suspect → run A, unmute → run B\" becomes a real before/after. It only moves the " +
    "viewport (no graph mutation) and puts it back where it started.";
  const benchRow = el("div", { class: "ants-copyrow" });
  const benchSelect = el("select", { class: "ants-select", style: { maxWidth: "190px" } });
  for (const p of BENCH_PRESETS) {
    const opt = el("option", { text: p.label });
    opt.value = String(p.ms);
    benchSelect.appendChild(opt);
  }
  benchSelect.value = "6000";
  const benchBtnA = el("button", { class: "ants-btn primary", text: "▶ Run as A" });
  const benchBtnB = el("button", { class: "ants-btn", text: "▶ Run as B (compare)" });
  benchRow.appendChild(benchSelect);
  benchRow.appendChild(benchBtnA);
  benchRow.appendChild(benchBtnB);
  const benchStatus = el("div", { class: "ants-note" });
  const benchTable = el("table", { class: "ants-kv" });
  const benchRows = {};
  for (const [key, label] of [
    ["state", "Current state"],
    ["a", "Run A"],
    ["b", "Run B"],
    ["delta", "B vs A"],
  ]) {
    const tr = el("tr");
    tr.appendChild(td({ class: "ants-kv-label", text: label }));
    const v = td({ class: "ants-kv-value" });
    tr.appendChild(v);
    benchTable.appendChild(tr);
    benchRows[key] = v;
  }

  const stateRow = el("div", { class: "ants-copyrow", style: { marginTop: "10px" } });
  const pauseBtn = el("button", { class: "ants-btn", text: "⏸ Pause sampling" });
  const resetBtn = el("button", { class: "ants-btn", text: "⟲ Reset samples" });
  const unmuteBtn = el("button", { class: "ants-btn", text: "🔊 Unmute everything" });
  stateRow.appendChild(pauseBtn);
  stateRow.appendChild(resetBtn);
  stateRow.appendChild(unmuteBtn);

  container.appendChild(capWrap);
  container.appendChild(tickWrap);
  container.appendChild(el("div", { class: "ants-section-title", text: "Counters" }));
  container.appendChild(counters);
  container.appendChild(el("div", { class: "ants-section-title", text: "Scripted pan benchmark" }));
  container.appendChild(benchIntro);
  container.appendChild(benchRow);
  container.appendChild(benchStatus);
  container.appendChild(benchTable);
  container.appendChild(el("div", { class: "ants-section-title", text: "Sampling state" }));
  container.appendChild(stateRow);
  container.appendChild(
    el("p", {
      class: "ants-note",
      text:
        "Pause freezes sampling so a jumpy table can be read; rendering is untouched (the drawing you see keeps happening, it just is " +
        "not being timed). Reset clears every sample while keeping your mutes and the cap setting, which is what you want before a " +
        "clean A/B.",
    })
  );

  pauseBtn.addEventListener("click", () => togglePause());
  resetBtn.addEventListener("click", () => resetAllStats(true));
  unmuteBtn.addEventListener("click", () => clearMutes());
  benchBtnA.addEventListener("click", () => runScriptedPan(Number(benchSelect.value), "A"));
  benchBtnB.addEventListener("click", () => runScriptedPan(Number(benchSelect.value), "B"));

  function update() {
    setText(cvals.draws, S.counters.framesTotal);
    setText(cvals.capped, S.counters.capped);
    setText(cvals.deferred, S.counters.deferred);
    setText(cvals.muted, S.counters.skippedWhileMuted);
    setText(cvals.hooks, `${S.counters.wrappedHooks} (${S.counters.preTrackedHooks} pre-existing, ${S.counters.instanceHooks} instance)`);
    setText(pauseBtn, S.paused ? "▶ Resume sampling" : "⏸ Pause sampling");
    pauseBtn.className = `ants-btn ${S.paused ? "active" : ""}`;
    const stateText = [
      S.muted.size ? `muted: ${[...S.muted].join(", ")}` : "nothing muted",
      drawThrottleMs ? `cap ${drawThrottleMs}ms` : "cap off",
      syntheticTickMs ? `synth tick ${syntheticTickMs}ms` : "no synth tick",
      S.paused ? "PAUSED" : "sampling",
    ];
    setText(benchRows.state, stateText.join(" · "));
    const A = S.bench && S.bench.A;
    const B = S.bench && S.bench.B;
    setText(benchRows.a, benchLine(A));
    setText(benchRows.b, benchLine(B));
    if (A && B) {
      const dFps = B.fps - A.fps;
      const dMs = B.meanFrameMs - A.meanFrameMs;
      const pctChange = A.meanFrameMs > 0 ? (dMs / A.meanFrameMs) * 100 : NaN;
      setText(
        benchRows.delta,
        `${dFps >= 0 ? "+" : "−"}${Math.abs(dFps).toFixed(1)} fps · ${dMs >= 0 ? "+" : "−"}${fmtMs(Math.abs(dMs))} ms/frame ` +
          `(${Number.isFinite(pctChange) ? `${Math.abs(pctChange).toFixed(0)}% ${dMs < 0 ? "cheaper" : "more expensive"}` : "—"})`
      );
      benchRows.delta.style.color = dMs < -0.5 ? "#7ed07e" : dMs > 0.5 ? "#ff6b6b" : null;
      const sameMutes = A.muted.length === B.muted.length && A.muted.join("|") === B.muted.join("|");
      if (!sameMutes) {
        setText(benchRows.delta, `${benchRows.delta.textContent}  ⚠ A and B were captured with different mutes — that difference is what you just measured.`);
      }
    } else {
      setText(benchRows.delta, "run both to compare");
      benchRows.delta.style.color = null;
    }
    setText(
      benchStatus,
      S.benchActive
        ? `Running… ${((nowMs() - S.benchActive.t0) / 1000).toFixed(1)}s of ${(S.benchActive.durationMs / 1000).toFixed(0)}s — leave the graph alone`
        : ""
    );
  }

  ui.state.testing = { update };
}

function runScriptedPan(durationMs, slot) {
  const canvas = app.canvas;
  if (!canvas || !canvas.ds || typeof requestAnimationFrame !== "function") {
    warnOnce("no-bench", "Scripted pan benchmark unavailable: app.canvas.ds was not found in this frontend version.");
    return;
  }
  if (S.benchActive) return;
  const ds = canvas.ds;
  const t0 = nowMs();
  const x0 = ds.offset ? ds.offset[0] : 0;
  const y0 = ds.offset ? ds.offset[1] : 0;
  S.benchActive = { t0, durationMs };
  if (ui.state.testing) ui.state.testing.update();

  const finish = () => {
    if (ds.offset) {
      ds.offset[0] = x0;
      ds.offset[1] = y0;
    }
    const agg = S.frames.aggregate(t0, [0.95]);
    const attr = S.frameAttr.aggregate(t0);
    const mean = agg.n ? agg.sum / agg.n : 0;
    const result = {
      at: Date.now(),
      frames: agg.n,
      spanMs: agg.span,
      meanFrameMs: mean,
      p95: agg.q ? agg.q[0] : NaN,
      fps: agg.span > 0 && agg.n > 1 ? ((agg.n - 1) * 1000) / agg.span : NaN,
      attrShare: mean > 0 ? attr.sum / agg.n / mean : NaN,
      muted: [...S.muted],
      capMs: drawThrottleMs,
      synthMs: syntheticTickMs,
      nodes: graphNodeCount(),
    };
    if (!S.bench) S.bench = { A: null, B: null };
    S.bench[slot] = result;
    S.benchActive = null;
    if (typeof canvas.setDirty === "function") canvas.setDirty(true, true);
    if (ui.state.testing) ui.state.testing.update();
  };

  const step = () => {
    const elapsed = nowMs() - t0;
    if (ds.offset) {
      const phase = (elapsed / durationMs) * Math.PI * 2;
      ds.offset[0] = x0 + Math.sin(phase) * 40;
      ds.offset[1] = y0 + Math.sin(phase * 2) * 15;
    }
    if (typeof canvas.setDirty === "function") canvas.setDirty(true, true);
    else if (typeof canvas.draw === "function") canvas.draw(true, true);
    if (elapsed >= durationMs) {
      finish();
      return;
    }
    govOwn(() => requestAnimationFrame(step));
  };
    govOwn(() => requestAnimationFrame(step));
}

function graphNodeCount() {
  const g = app && app.graph;
  if (!g) return NaN;
  if (Array.isArray(g._nodes)) return g._nodes.length;
  if (Array.isArray(g.nodes)) return g.nodes.length;
  if (g._nodes instanceof Map) return g._nodes.size;
  return NaN;
}

// --- Governor (the scheduler layer) ----------------------------------------
// One tab, in this order: what the limiter is doing, the knobs, every tick
// source the page schedules with what it costs and what it is allowed to do,
// the off-thread lane, and the long frames with what was inside them. The
// trace card is the answer to "renderFrame took 1.3s — what else was in it?",
// and the table above it is what you can do about it.

const GOV_BUDGET_PRESETS = [8, 12, 16, 24];
const GOV_RAF_MIN_HZ = [60, 30, 20, 10];
const GOV_AUTO_TARGETS = [
  { ms: 150, label: "150 ms/s (strict)" },
  { ms: 250, label: "250 ms/s (default)" },
  { ms: 400, label: "400 ms/s" },
  { ms: 600, label: "600 ms/s (gentle)" },
];
const GOV_AUTO_MIN = [
  { ms: 15, label: "15 ms/s (touch almost anything)" },
  { ms: 30, label: "30 ms/s (default)" },
  { ms: 60, label: "60 ms/s (only the worst)" },
];
const GOV_TRACE_PRESETS = [
  { ms: 30, label: "capture frames over 30 ms" },
  { ms: 50, label: "capture frames over 50 ms (default)" },
  { ms: 100, label: "capture frames over 100 ms" },
  { ms: 0, label: "don't capture" },
];

function buildGovernorTab(container) {
  const callout = el("div", { class: "ants-callout" });
  const kv = el("table", { class: "ants-kv" });
  const vals = {};
  for (const [key, label] of [
    ["state", "Scheduler layer"],
    ["sources", "Tick sources seen"],
    ["limited", "Sources under a limit"],
    ["skipped", "Ticks skipped"],
    ["deferred", "Callbacks deferred (not dropped)"],
    ["merged", "Redraw requests merged (when merging is on)"],
    ["saved", "Estimated ms/s kept off the main thread"],
    ["overhead", "Governor's own bookkeeping"],
    ["raf", "rAF governor"],
  ]) {
    const tr = el("tr");
    tr.appendChild(td({ class: "ants-kv-label", text: label }));
    const v = td({ class: "ants-kv-value" });
    tr.appendChild(v);
    kv.appendChild(tr);
    vals[key] = v;
  }
  callout.appendChild(kv);
  container.appendChild(callout);

  const note = el("p", { class: "ants-note" });
  note.textContent =
    "Every setInterval / setTimeout / requestAnimationFrame the page registers after this module loads is measured by source and can be " +
    "slowed down here — normal, ½ speed, ¼ speed, 2/s, 1/s, or paused. Two rules make it safe to use: a source on \"normal\" is measured " +
    "and otherwise untouched (same call, same arguments, same ids, so clearInterval/clearTimeout keep working), and a limited source is " +
    "slowed rather than silenced (a skipped interval tick is covered by the next one; a skipped one-shot or chained callback is " +
    "re-scheduled for when its window opens). The tracker's own timers are exempt and are marked as such. This changes behaviour on " +
    "purpose: a poll you limit runs less often. Nothing here can move Vue's render, the DOM or canvas drawing off the main thread — see " +
    "the note at the bottom of this tab for what a worker lane can and cannot take.";
  container.appendChild(note);

  // --- controls -------------------------------------------------------------
  const controls = el("div", { class: "ants-copyrow", style: { marginTop: "8px", gap: "10px" } });

  function selectControl(label, options, read, onChange) {
    const wrap = el("div", { style: { display: "flex", alignItems: "center", gap: "5px" } });
    wrap.appendChild(el("span", { text: label, style: { color: "#8b8b96" } }));
    const sel = el("select", { class: "ants-select", style: { width: "auto", maxWidth: "220px" } });
    for (const o of options) {
      const opt = el("option", { text: o.label });
      opt.value = String(o.value);
      sel.appendChild(opt);
    }
    sel.value = String(read());
    sel.addEventListener("change", () => {
      onChange(sel.value);
      update();
    });
    wrap.appendChild(sel);
    controls.appendChild(wrap);
    return sel;
  }

  const selBudget = selectControl(
    "frame budget",
    GOV_BUDGET_PRESETS.map((ms) => ({ value: ms, label: `${ms} ms` })),
    () => GOV.controls.budgetMs,
    (v) => govSetControl("budgetMs", Number(v))
  );
  const selRafMode = selectControl(
    "rAF governor",
    [
      { value: "off", label: "off (measure only)" },
      { value: "adaptive", label: "adaptive (slow down when behind)" },
    ],
    () => GOV.controls.rafMode,
    (v) => govSetControl("rafMode", v)
  );
  const selRafFloor = selectControl(
    "rAF floor",
    GOV_RAF_MIN_HZ.map((hz) => ({ value: hz, label: `${hz} Hz` })),
    () => GOV.controls.rafMinHz,
    (v) => govSetControl("rafMinHz", Number(v))
  );
  const selCoalesce = selectControl(
    "merge redraw requests",
    [
      { value: "off", label: "off" },
      { value: "on", label: "on (one redraw per frame)" },
    ],
    () => (GOV.controls.coalesce ? "on" : "off"),
    (v) => govSetControl("coalesce", v === "on")
  );
  const selInputGuard = selectControl(
    "input guard",
    [
      { value: "on", label: "on (never slow input)" },
      { value: "off", label: "off" },
    ],
    () => (GOV.controls.inputGuard ? "on" : "off"),
    (v) => govSetControl("inputGuard", v === "on")
  );
  const selAuto = selectControl(
    "autopilot",
    [
      { value: "off", label: "off (you pick the limits)" },
      { value: "on", label: "on (cap the worst source every 5s)" },
    ],
    () => (GOV.controls.autoLimit ? "on" : "off"),
    (v) => {
      govSetControl("autoLimit", v === "on");
      if (v === "on") govAutoPilot();
    }
  );
  const selAutoTarget = selectControl(
    "autopilot target",
    GOV_AUTO_TARGETS.map((p) => ({ value: p.ms, label: p.label })),
    () => GOV.controls.autoTargetMsPerSec,
    (v) => govSetControl("autoTargetMsPerSec", Number(v))
  );
  const selAutoMin = selectControl(
    "autopilot floor",
    GOV_AUTO_MIN.map((p) => ({ value: p.ms, label: p.label })),
    () => GOV.controls.autoMinMsPerSec,
    (v) => govSetControl("autoMinMsPerSec", Number(v))
  );
  const selTrace = selectControl(
    "frame traces",
    GOV_TRACE_PRESETS.map((p) => ({ value: p.ms, label: p.label })),
    () => GOV.controls.traceMinMs,
    (v) => govSetControl("traceMinMs", Number(v))
  );
  container.appendChild(controls);

  const btnRow = el("div", { class: "ants-copyrow", style: { marginTop: "6px" } });
  const suggestBtn = el("button", {
    class: "ants-btn primary",
    text: "Suggest limits from this session",
    title: "Limit the sources this session actually measured burning milliseconds. Everything else is left alone, and nothing is applied twice.",
  });
  const resetBtn = el("button", { class: "ants-btn", text: "Reset to untouched", title: "Every policy back to normal, every control back to its default (turns the autopilot off too)" });
  const offBtn = el("button", {
    class: "ants-btn",
    text: "Turn the layer off",
    title: "Restore the browser's own setTimeout / setInterval / requestAnimationFrame and stop governing anything, now and for this page load",
  });
  const result = el("span", { class: "ants-note", style: { margin: "0" } });
  const autoLine = el("div", { class: "ants-note", style: { marginTop: "4px" } });
  btnRow.appendChild(suggestBtn);
  btnRow.appendChild(resetBtn);
  btnRow.appendChild(offBtn);
  btnRow.appendChild(result);
  container.appendChild(btnRow);
  container.appendChild(autoLine);

  suggestBtn.addEventListener("click", () => {
    const applied = govSuggest();
    setText(
      result,
      applied.length
        ? `applied: ${applied.join(", ")}`
        : "nothing worth limiting right now (nothing is burning real time that a limit could slow down)"
    );
    update();
  });
  resetBtn.addEventListener("click", () => {
    govReset();
    setText(result, "all limits lifted; the page is back to untouched");
    update();
  });
  offBtn.addEventListener("click", () => {
    const did = govUninstall("turned off from the panel");
    setText(
      result,
      did
        ? "the layer is off: the browser's own timers are back and nothing here is governed any more (reload to bring it back)"
        : `already off (${GOV.offReason})`
    );
    update();
  });

  // --- tick sources ---------------------------------------------------------
  container.appendChild(el("div", { class: "ants-section-title", text: "Tick sources" }));
  const table = makeTable([
    { label: "Source", key: "label", text: true },
    { label: "kind", key: "kind", text: true },
    { label: "asked", right: true, key: "requested" },
    { label: "allowed", right: true, key: "effective", text: true },
    { label: "runs/s", right: true, key: "runs" },
    { label: "ms/s", right: true, key: "ms" },
    { label: "ms/run", right: true, key: "perRun" },
    { label: "worst", right: true, key: "worst" },
    { label: "skipped", right: true, key: "skipped" },
    { label: "limit", key: "limit", text: true },
  ]);
  const empty = el("div", { class: "ants-empty" });
  empty.textContent =
    "No tick sources have been seen yet. That is a finding in itself: this page schedules its work through something other than " +
    "setInterval / setTimeout / requestAnimationFrame (microtasks, promise chains, or WebSocket events), and those cannot be governed " +
    "from page JavaScript at all.";
  container.appendChild(empty);
  container.appendChild(table.table);
  const capper = makeRowCapper(container, "governor", "tick sources", () => update());

  const tableNote = el("p", { class: "ants-note" });
  tableNote.textContent =
    "\"asked\" is the delay the source registered with; \"allowed\" is the shortest gap its current limit permits. runs/s and ms/s are " +
    "measured over the same 4-second window as the rest of the panel, so a source that just calmed down stops shouting. \"skipped\" is " +
    "lifetime, and the estimated saving is exactly that: the ticks that did not run cannot be timed, so it is the skipped rate times the " +
    "mean cost of the ticks that did run. A row with no file name has not been sampled yet — attribution costs a stack, so it is sampled " +
    "rather than paid on every registration.";
  container.appendChild(tableNote);

  const sorter = makeSorter(
    table.headers,
    {
      label: (r) => r.label,
      kind: (r) => r.kindLabel,
      requested: (r) => r.requestedMs,
      effective: (r) => (Number.isFinite(r.effectiveMs) ? r.effectiveMs : Infinity),
      runs: (r) => r.runsPerSec,
      ms: (r) => r.msPerSec,
      perRun: (r) => r.perRunMs,
      worst: (r) => r.worst,
      skipped: (r) => r.skipped,
      limit: (r) => r.policyLabel,
    },
    {
      defaultKey: "ms",
      onChange: () => {
        rows.deferReorder = false;
        update();
        rows.deferReorder = true;
      },
    }
  );
  sorter.attach(table.ths);

  const rows = new RowSet(table.tbody, () => {
    const tr = el("tr");
    for (let i = 0; i < 10; i++) tr.appendChild(td({ class: i >= 2 && i <= 8 ? "ants-num" : null }));
    const sel = el("select", { class: "ants-btn", style: { maxWidth: "120px" } });
    for (const p of GOV_POLICIES) {
      const opt = el("option", { text: p.label });
      opt.value = p.id;
      sel.appendChild(opt);
    }
    tr.children[9].appendChild(sel);
    return { nodes: [tr], cells: tr.children, sel, lastKey: null };
  });

  // --- worker lane ----------------------------------------------------------
  const workerCallout = el("div", { class: "ants-callout" });
  const workerKv = el("table", { class: "ants-kv" });
  const workerVals = {};
  for (const [key, label] of [
    ["state", "Off-thread lane"],
    ["jobs", "Jobs run"],
    ["off", "Measured off-thread"],
    ["main", "Main-thread time spent (round trip included)"],
    ["result", "Last sanity check"],
  ]) {
    const tr = el("tr");
    tr.appendChild(td({ class: "ants-kv-label", text: label }));
    const v = td({ class: "ants-kv-value" });
    tr.appendChild(v);
    workerKv.appendChild(tr);
    workerVals[key] = v;
  }
  const sanityBtn = el("button", {
    class: "ants-btn",
    text: "Run off-thread sanity check",
    title: "Runs one deterministic workload on both threads and compares the answers, so 'the worker lane works' is a measurement rather than a claim.",
  });
  workerCallout.appendChild(el("div", { class: "ants-section-title", text: "Off-thread lane" }));
  workerCallout.appendChild(workerKv);
  workerCallout.appendChild(sanityBtn);
  workerCallout.appendChild(
    el("p", {
      class: "ants-note",
      text:
        "Only pure compute can leave the main thread: Vue's render, the DOM and canvas drawing are main-thread-only by specification, and " +
        "OffscreenCanvas only helps an application that created its canvas that way (ComfyUI does not). Arguments and results have to be " +
        "structured-cloneable and a function offloaded this way cannot capture closures. When the page has no Worker, the lane says so and " +
        "answers on the main thread instead of pretending.",
    })
  );
  container.appendChild(workerCallout);
  sanityBtn.addEventListener("click", async () => {
    setText(workerVals.result, "running…");
    const res = await govRunSelfTest();
    setText(
      workerVals.result,
      res.match
        ? `identical answers (n=${res.n}): main thread ${fmtMs(res.mainMs, 1)}ms vs worker ${fmtMs(res.workerMs, 1)}ms`
        : `not available: ${res.error || "unknown reason"}`
    );
    update();
  });

  // --- frame traces ---------------------------------------------------------
  container.appendChild(el("div", { class: "ants-section-title", text: "Long-frame traces" }));
  const traceTable = makeTable([
    { label: "dur", right: true },
    { label: "blocking", right: true },
    { label: "forced layout", right: true },
    { label: "worst script inside" },
    { label: "governed ticks inside", right: true },
    { label: "redraw requests", right: true },
    { label: "", right: true },
  ]);
  const traceBody = traceTable.tbody;
  const traceNote = el("p", { class: "ants-note" });
  traceNote.textContent =
    "One row per long animation frame, worst first for the frame it describes. This is the card that answers \"renderFrame burned 1.3 " +
    "seconds — what else was in it?\": the scripts the browser named (with forced layout and the invoker that started them), which " +
    "governed tick sources ran inside the frame with what they cost, and how many redraw requests arrived while it was blocked. If a " +
    "source you limited stops appearing here, the limit is working. Expand a row for the per-script and per-source breakdown.";
  const traceBtnRow = el("div", { class: "ants-copyrow", style: { marginTop: "6px" } });
  const clearTraces = el("button", { class: "ants-btn", text: "Clear traces" });
  const traceCount = el("span", { class: "ants-note", style: { margin: "0" } });
  traceBtnRow.appendChild(clearTraces);
  traceBtnRow.appendChild(traceCount);
  container.appendChild(traceTable.table);
  container.appendChild(traceBtnRow);
  container.appendChild(traceNote);
  clearTraces.addEventListener("click", () => {
    GOV.traces.length = 0;
    GOV.traceVersion++; // makes the renderer rebuild even though no new frame arrived
    update();
  });

  const openTraces = new Set();
  let renderedTraces = -1;

  function renderTraces() {
    if (GOV.traceVersion === renderedTraces) return;
    renderedTraces = GOV.traceVersion;
    // Traces only change when a long frame is captured (or when they are
    // cleared), so a rebuild here cannot fight with the pointer the way a
    // per-refresh innerHTML rebuild would.
    while (traceBody.children.length) traceBody.removeChild(traceBody.children[0]);
    const list = GOV.traces.slice(0, 12);
    setText(traceCount, GOV.traces.length ? `${GOV.traces.length} captured (showing ${list.length})` : "none captured yet");
    for (const tr of list) {
      const open = openTraces.has(tr.id);
      const row = el("tr", { class: "ants-row" });
      row.appendChild(td({ class: "ants-num", text: `${fmtMs(tr.duration, 0)}ms` }));
      row.appendChild(td({ class: "ants-num", text: `${fmtMs(tr.blocking, 0)}ms` }));
      row.appendChild(td({ class: "ants-num", text: tr.layoutMs ? `${fmtMs(tr.layoutMs, 0)}ms` : "\u2014" }));
      const top = tr.scripts[0];
      const topCell = td({ text: top ? `${top.fn} @ ${top.file}` : "(no script attribution)" });
      if (top && top.invoker) topCell.title = `started by: ${top.invoker}`;
      row.appendChild(topCell);
      const tickMs = tr.ticks.reduce((acc, t) => acc + t.ms, 0);
      row.appendChild(
        td({ class: "ants-num", text: tr.ticks.length ? `${tr.ticks.reduce((a, t) => a + t.count, 0)} (${fmtMs(tickMs, 0)}ms)` : "\u2014" })
      );
      row.appendChild(
        td({ class: "ants-num", text: tr.coalesced ? `${tr.redraws} (${tr.coalesced} merged)` : String(tr.redraws) })
      );
      const caretCell = td({ class: "ants-num" });
      const caret = el("span", { class: "ants-caret", text: open ? "\u25be" : "\u25b8" });
      caretCell.appendChild(caret);
      caretCell.title = "Expand for the per-script and per-source breakdown of this frame";
      row.appendChild(caretCell);

      const detailsRow = el("tr", { class: "ants-details" });
      detailsRow.style.display = open ? "" : "none";
      const cell = td();
      detailsRow.appendChild(cell);
      for (const s of tr.scripts) {
        cell.appendChild(
          el("div", {
            text:
              `${s.fn} @ ${s.file} \u2014 ${fmtMs(s.ms, 1)}ms` +
              `${s.layoutMs ? `, ${fmtMs(s.layoutMs, 1)}ms forced layout` : ""}` +
              `${s.invoker ? ` [${s.invoker}]` : ""}`,
          })
        );
      }
      if (tr.ticks.length) {
        cell.appendChild(el("div", { style: { marginTop: "5px", color: "#8b8b96" }, text: "governed sources that ran inside this frame:" }));
        for (const t of tr.ticks) {
          cell.appendChild(
            el("div", {
              text:
                `${t.label} \u2014 ran ${t.count}\u00d7, ${fmtMs(t.ms, 1)}ms total` +
                `${t.policy !== "full" ? `, limit: ${(GOV_POLICY_BY_ID.get(t.policy) || {}).label}` : ""}`,
            })
          );
        }
      }
      if (tr.callers && tr.callers.length) {
        cell.appendChild(
          el("div", {
            style: { marginTop: "5px" },
            text: `state was mutated / a redraw was asked for by: ${tr.callers.map((c) => `${c.label} ×${c.count}`).join(", ")}`,
          })
        );
      }
      cell.appendChild(
        el("div", {
          style: { marginTop: "5px", color: "#8b8b96" },
          text:
            `${tr.redraws} redraw request(s) arrived during it, ${tr.coalesced} were merged away` +
            `${tr.limited.length ? `; limits active for: ${tr.limited.join("; ")}` : ""}` +
            `${tr.overBudget ? "; the thread was already behind budget" : ""}`,
        })
      );
      caret.addEventListener("click", () => {
        if (openTraces.has(tr.id)) openTraces.delete(tr.id);
        else openTraces.add(tr.id);
        const nowOpen = openTraces.has(tr.id);
        setText(caret, nowOpen ? "▾" : "▸");
        detailsRow.style.display = nowOpen ? "" : "none";
      });
      traceBody.appendChild(row);
      traceBody.appendChild(detailsRow);
    }
  }

  container.appendChild(
    el("p", {
      class: "ants-note",
      text:
        "What this layer cannot do, so nobody has to reverse-engineer it: only callbacks that reach the page's own timer and rAF entry " +
        "points can be governed (a microtask, a promise chain, browser layout/paint and a loop that never re-registers itself are out of " +
        "reach); a limit changes behaviour by design; and the \"kept off the main thread\" figure is an estimate from the ticks that did " +
        "run. The strongest card here is the combination: limit a source, then watch it disappear from the traces below. " +
        "One exemption is built in, because a redraw cap that hides itself inside a drag is worse than no cap: a source that has ever " +
        "run the canvas draw inside itself is on the display lane (marked \"display\" in the table), it is never suggested a limit by " +
        "the autopilot, and while a pointer, wheel or key event is arriving its cap is lifted to about 30 runs a second \u2014 back to " +
        "its limit the moment you stop. What a drag cost is then a fact, not a suspicion: the lift is counted and reported.",
    })
  );

  function syncSelect(sel, value) {
    const v = String(value);
    if (sel.value !== v) sel.value = v;
  }

  function update() {
    const m = govMetrics();
    syncSelect(selBudget, GOV.controls.budgetMs);
    syncSelect(selRafMode, GOV.controls.rafMode);
    syncSelect(selRafFloor, GOV.controls.rafMinHz);
    syncSelect(selCoalesce, GOV.controls.coalesce ? "on" : "off");
    syncSelect(selInputGuard, GOV.controls.inputGuard ? "on" : "off");
    syncSelect(selTrace, GOV.controls.traceMinMs);
    setText(
      vals.state,
      m.disabled
        ? `TURNED OFF — ${m.offReason}`
        : m.installed
          ? m.installError
            ? `not installed: ${m.installError}`
            : `installed${m.counters.errors ? ` (${m.counters.errors} internal error(s), fail-open after 3)` : ""}`
          : "not installed"
    );
    if (m.disabled) callout.className = "ants-callout warn";
    const au = m.auto;
    if (au.on) {
      autoLine.textContent =
        `autopilot: target ${au.targetMsPerSec} ms/s of limitable cost, measured ${Math.round(au.measuredMsPerSec)} ms/s, ` +
        `floor ${au.minMsPerSec} ms/s` +
        `${au.note ? ` — ${au.note}` : ""}` +
        (au.actions.length
          ? `\n${au.actions.map((a) => `${a.label} → ${a.label2} (was ${a.measuredMsPerSec} ms/s, cap ${a.gapMs}ms, ≈${a.predictedMsPerSec} after)`).join("\n")}`
          : "");
      autoLine.style.whiteSpace = "pre-wrap";
    } else {
      autoLine.textContent = au.count
        ? `autopilot is off; it applied ${au.count} limit(s) before you turned it off (Reset clears them)`
        : "";
    }
    if (m.inert && m.inert.count) {
      autoLine.textContent +=
        `${autoLine.textContent ? "\n" : ""}` +
        `${m.inert.count} limited source(s) are unaffected by their own limit — it is narrower than the gap between their runs already ` +
        `(${fmtRate(m.inert.msPerSec)} ms/s still burning). Pick 2/s or 1/s for a chain that slow.`;
      autoLine.style.whiteSpace = "pre-wrap";
    }
    setText(vals.sources, `${m.sourceCount}${m.registered > m.sourceCount ? ` rows (${m.registered} registrations)` : ""}`);
    setText(vals.limited, m.throttled ? `${m.throttled}` : "none");
    setText(vals.skipped, `${m.counters.skipped} (${fmtRate(m.skippedPerSec)}/s)`);
    setText(vals.deferred, String(m.counters.deferred));
    setText(
      vals.merged,
      !m.controls.coalesce
        ? "merging is off"
        : `${m.counters.coalesced} of ${m.counters.coalesced + m.counters.redrawReqs} (${fmtRate(m.coalescedPerSec)}/s) — the rest added a flag the frame had not asked for yet`
    );
    setText(vals.saved, m.throttled ? `≈ ${fmtMs(m.savedMsPerSec)} ms/s` : "—");
    setText(vals.overhead, `${fmtMs(m.overheadMsPerSec * 1000, 0)}µs/s`);
    setText(
      vals.raf,
      m.controls.rafMode === "off"
        ? "off (measuring only)"
        : `${m.controls.rafMode}, ${m.controls.rafMinHz}Hz floor${m.overBudget ? " — thread behind budget" : ""}`
    );

    const visible = capper.apply(sorter.sort(m.sources));
    rows.sync(
      visible,
      (r) => r.key,
      (row, r) => {
        const c = row.cells;
        setText(
          c[0],
          (r.ours ? `${r.name} (this tracker)` : r.name + (r.file ? ` @ ${r.file}${r.line ? `:${r.line}` : ""}` : " @ (not sampled yet)")) +
            (r.display ? " · display" : "")
        );
        c[0].title = r.ours
          ? "This is the tracker's own timer: it is measured but can never be limited."
          : `${r.kindLabel}${r.registrations > 1 ? `, ${r.registrations} registrations` : ""}${r.provisional ? "; attribution is sampled, so the file may appear shortly" : ""}` +
            (r.display
              ? `.\nThis one drew the canvas ${r.drew ? `${r.drew} time(s)` : ""} inside its own callback, so it is on the display lane: ` +
                `the autopilot will not suggest a limit for it, and while you are dragging or typing its cap is lifted to ~30 runs/s.`
              : "");
        setText(c[1], r.kindLabel);
        setText(c[2], `${fmtMs(r.requestedMs || GOV_RAF_REQUESTED_MS, r.requestedMs && r.requestedMs < 100 ? 1 : 0)}ms`);
        const noop = govLimitIsNoop(r);
        setText(
          c[3],
          !Number.isFinite(r.effectiveMs)
            ? "paused"
            : noop
              ? `${fmtMs(r.effectiveMs, 0)}ms — no effect`
              : `${fmtMs(r.effectiveMs, 0)}ms`
        );
        c[3].title = noop
          ? `This limit cannot bite: the source's runs are ~${fmtMs(r.perRunMs, 0)}ms apart already, so a ${fmtMs(r.effectiveMs, 0)}ms minimum gap changes nothing. Use 2/s or 1/s for a chain that is this slow.`
          : "The shortest gap the current limit permits. If it is wider than the source's own period, the limit starts to bite.";
        setText(c[4], r.runsPerSec ? fmtRate(r.runsPerSec) : "—");
        setText(c[5], r.msPerSec ? fmtMs(r.msPerSec) : "—");
        setText(c[6], Number.isFinite(r.perRunMs) ? fmtMs(r.perRunMs, 3) : "—");
        c[5].title =
          `Measured in the last 4s: ${fmtMs(r.msPerSec)}ms/s. At its current rate that is ≈${fmtMs(r.pressureMsPerSec, 0)}ms/s ` +
          `(mean ${fmtMs(r.perRunMs, 1)}ms × ${fmtRate(r.runsPerSec)}/s) — the two disagree when the expensive runs are older than the window.`;
        setText(c[7], r.worst ? `${fmtMs(r.worst, 1)}ms` : "—");
        setText(c[8], r.skipped ? String(r.skipped) : "—");
        if (Number.isFinite(r.sourceRateBefore) && Number.isFinite(r.sourceRateAfter) && r.fires > 3) {
          c[4].title = `${fmtRate(r.sourceRateBefore)}/s before the limit, ${fmtRate(r.sourceRateAfter)}/s since`;
        }
        const sel = row.sel;
        const want = r.policy;
        if (sel.value !== want) sel.value = want;
        sel.disabled = r.ours;
        sel.title = r.ours
          ? "The tracker's own timers are exempt from every policy."
          : `Limit ${r.name}: delay instead of skip, never silence — a skipped interval tick is covered by the next one and a skipped one-shot callback still runs.`;
        if (row.lastKey !== r.key) {
          row.lastKey = r.key;
          sel.onchange = null;
          sel.addEventListener("change", () => {
            govSetPolicy(r.key, sel.value);
            update();
          });
        }
        const tr = row.nodes[0];
        tr.className = r.policy !== "full" && !r.ours ? "ants-row ants-warm" : "ants-row";
      }
    );
    empty.style.display = visible.length ? "none" : "";
    table.table.style.display = visible.length ? "" : "none";

    const w = m.worker;
    setText(workerVals.state, w.available ? "available (Worker + Blob)" : `unavailable — ${w.why}`);
    setText(workerVals.jobs, String(w.jobs));
    setText(workerVals.off, w.jobs ? `${fmtMs(w.offThreadMs, 1)}ms` : "—");
    setText(workerVals.main, w.jobs ? `${fmtMs(w.mainMs, 1)}ms` : "—");
    if (GOV.selfTest && !workerVals.result.textContent) {
      setText(
        workerVals.result,
        GOV.selfTest.match ? `identical answers: main ${fmtMs(GOV.selfTest.mainMs, 1)}ms vs worker ${fmtMs(GOV.selfTest.workerMs, 1)}ms` : `not available: ${GOV.selfTest.error || "unknown reason"}`
      );
    }

    renderTraces();
  }

  ui.state.governor = { rowSet: rows, update, sorter };
}

// -------------------------------------------------------------- lifecycle --

function buildTabContents() {
  if (ui.state.timing) return;
  buildTweaksTab(ui.tabs.tweaks);
  buildTimingTab(ui.tabs.timing);
  buildNodesTab(ui.tabs.nodes);
  buildStallsTab(ui.tabs.stalls);
  buildGovernorTab(ui.tabs.governor);
  buildLoadTab(ui.tabs.load);
  buildMemoryTab(ui.tabs.memory);
  buildGpuTab(ui.tabs.gpu);
  buildTestingTab(ui.tabs.testing);
  ui.tabs.timing.classList.add("active");
  ui.tabBtns.timing.classList.add("active");
}

// Periodic sweep. Two jobs, both about keeping the window honest:
//   * trim bucketed rings by wall-clock time even when their owner stopped
//     being called (v1 could not age out an idle extension at all);
//   * roll the tracker's own cost counters over so the panel can show them.
// It never deletes a hook bucket: a wrapped hook holds that object, and v1's
// delete-after-4-seconds-of-quiet is precisely why an extension could vanish
// from the Timing tab for the rest of the session while still drawing.
function sweepStaleData() {
  const t0 = performance.now();
  const now = nowMs();
  if (!S.paused) {
    for (const bucket of S.hooks.values()) {
      bucket.inside.trimBefore(now - WINDOW_MS);
      if (bucket.outside) bucket.outside.trimBefore(now - WINDOW_MS);
    }
    for (const [type, bucket] of S.nodes) {
      bucket.series.trimBefore(now - WINDOW_MS);
      // Node buckets are looked up by type on every draw, so unlike hook
      // buckets they can safely be dropped once empty and idle.
      if (!bucket.series.n && !bucket.calls) S.nodes.delete(type);
    }
    trimIfLive(S.invalidations, now - FRAME_KEEP_MS);
    if (S.samples) S.samples.trimBefore(now - WINDOW_MS);
    for (const [sig, caller] of S.callers) {
      caller.ring.trimBefore(now - WINDOW_MS);
      if (!caller.ring.n && now - caller.lastSeen > 60000) S.callers.delete(sig);
    }
    for (const [sig, src] of S.stallSources) {
      if (now - src.lastSeen > 120000) S.stallSources.delete(sig);
    }
    trimIfLive(GOV.skipRing, now - WINDOW_MS);
    trimIfLive(GOV.coalescedRing, now - WINDOW_MS);
    for (const govSrc of GOV.sources.values()) if (govSrc.ring.n) govSrc.ring.trimBefore(now - WINDOW_MS);
    GOV.redraw = null;
  }
  selfCost.sweepAccum += performance.now() - t0;
  const now2 = nowMs();
  const elapsed = now2 - (selfCost.lastRolloverAt || now2);
  if (elapsed >= 1000) {
    const perSecond = 1000 / elapsed;
    selfCost.renderMs = (selfCost.renderAccum || 0) * perSecond;
    selfCost.sweepMs = (selfCost.sweepAccum || 0) * perSecond;
    selfCost.renderAccum = 0;
    selfCost.sweepAccum = 0;
    GOV.overheadPerSec = (GOV.overheadMs || 0) * perSecond;
    GOV.overheadMs = 0;
    selfCost.lastRolloverAt = now2;
  }
}

// How often to redraw the panel, decided from what the last pass actually cost.
// A graph that produces hundreds of rows can make one full update cost more than
// a frame, and a profiler that causes the stalls it reports is worse than one
// that updates half as often. Tiers rather than a formula, so the behaviour is
// obvious and testable: half of a 60fps frame is where it starts backing off.
function refreshIntervalFor(renderMs) {
  if (!Number.isFinite(renderMs)) return UI_REFRESH_MS;
  if (renderMs > 12) return 2000;
  if (renderMs > 6) return 1000;
  return UI_REFRESH_MS;
}

let uiRefreshMs = UI_REFRESH_MS;

function startRefresh() {
  stopRefresh();
  const tick = () => {
    const t0 = performance.now();
    try {
      renderSummary();
      updateActiveTab();
    } catch (e) {
      warnOnce("render-fail", `Panel render failed: ${e && e.message}`);
      console.error(e);
    }
    const cost = performance.now() - t0;
    selfCost.renderAccum += cost;
    S.counters.renderCount++;
    uiRefreshMs = refreshIntervalFor(cost);
    ui.refreshTimer = govOwn(() => setTimeout(tick, uiRefreshMs));
  };
  ui.refreshTimer = govOwn(() => setTimeout(tick, uiRefreshMs));
}

function stopRefresh() {
  if (ui.refreshTimer) clearTimeout(ui.refreshTimer);
  ui.refreshTimer = null;
  uiRefreshMs = UI_REFRESH_MS;
}

function togglePanel(force) {
  buildPanel();
  buildTabContents();
  const shouldOpen = force !== undefined ? force : !ui.panel.classList.contains("open");
  ui.panel.classList.toggle("open", shouldOpen);
  if (shouldOpen) {
    renderSummary();
    updateActiveTab();
    startRefresh();
    if (ui.active === "gpu") refreshGpu();
  } else {
    stopRefresh();
  }
}

function togglePause() {
  S.paused = !S.paused;
  if (ui.built && ui.pauseBtn) {
    setText(ui.pauseBtn, S.paused ? "▶ Resume" : "⏸ Pause");
    ui.pauseBtn.classList.toggle("active", S.paused);
  }
  console.info(
    S.paused
      ? "[ANTs Tracker] Sampling paused: the numbers are now a frozen snapshot. Rendering is completely unaffected."
      : "[ANTs Tracker] Sampling resumed."
  );
  if (ui.built && ui.panel.classList.contains("open")) {
    renderSummary();
    updateActiveTab();
  }
}

function toggleMute(label) {
  if (S.muted.has(label)) {
    S.muted.delete(label);
  } else {
    S.muted.add(label);
    console.info(
      `[ANTs Tracker] Muting "${label}": every wrapped draw hook it owns is now skipped outright. Drawing may visibly change — that is ` +
        "the point. Use the Testing tab's scripted pan benchmark for A/B numbers rather than eyeballing it."
    );
  }
  if (ui.built && ui.panel.classList.contains("open")) {
    renderSummary();
    updateActiveTab();
  }
}

function clearMutes() {
  S.muted.clear();
  if (ui.built && ui.panel.classList.contains("open")) updateActiveTab();
}

function resetAllStats() {
  for (const bucket of S.hooks.values()) {
    bucket.inside.clear();
    if (bucket.outside) bucket.outside.clear();
    bucket.skipped = 0;
  }
  for (const bucket of S.nodes.values()) bucket.series.clear();
  for (const ring of [S.frames, S.frameAttr, S.frameNodeStage, S.frameConnStage, S.raf, S.invalidations, S.stalls, S.mem]) {
    ring.clear();
  }
  for (const caller of S.callers.values()) caller.ring.clear();
  if (S.samples) S.samples.clear();
  S.stallSources.clear();
  S.callers.clear();
  S.stallCount = 0;
  S.stallWorstMs = 0;
  console.info("[ANTs Tracker] Samples cleared. Mutes and testing settings kept.");
  if (ui.built && ui.panel.classList.contains("open")) {
    renderSummary();
    updateActiveTab();
  }
}

// ---------------------------------------------------------- corner button --

const CORNER_POS_KEY = "ants-tracker-corner-pos";
const LONG_PRESS_MS = 280;
let cornerBtnEl = null;

function loadCornerPos() {
  try {
    const raw = localStorage.getItem(CORNER_POS_KEY);
    if (!raw) return null;
    const pos = JSON.parse(raw);
    if (typeof pos.top === "number" && typeof pos.left === "number") return pos;
  } catch (e) {
    /* storage unavailable — the CSS default position is used instead */
  }
  return null;
}

function saveCornerPos(top, left) {
  try {
    localStorage.setItem(CORNER_POS_KEY, JSON.stringify({ top, left }));
  } catch (e) {
    /* non-fatal: the position just will not survive a reload */
  }
}

function wireCornerButton(node) {
  let pressTimer = null;
  let dragging = false;
  let movedDuringDrag = false;
  let suppressClick = false;
  let startX = 0;
  let startY = 0;
  let startTop = 0;
  let startLeft = 0;

  node.addEventListener("mousedown", (e) => {
    dragging = false;
    movedDuringDrag = false;
    startX = e.clientX;
    startY = e.clientY;
    const rect = node.getBoundingClientRect();
    startTop = rect.top;
    startLeft = rect.left;
    clearTimeout(pressTimer);
    pressTimer = govOwn(() => setTimeout(() => {
      dragging = true;
      node.style.cursor = "grabbing";
      node.style.opacity = "0.85";
    }, LONG_PRESS_MS));
    if (e.preventDefault) e.preventDefault();
  });

  window.addEventListener("mousemove", (e) => {
    if (!dragging) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) movedDuringDrag = true;
    const newTop = Math.max(0, Math.min((window.innerHeight || 0) - 34, startTop + dy));
    const newLeft = Math.max(0, Math.min((window.innerWidth || 0) - 34, startLeft + dx));
    node.style.top = `${newTop}px`;
    node.style.left = `${newLeft}px`;
    node.style.bottom = "auto";
    node.style.right = "auto";
  });

  window.addEventListener("mouseup", () => {
    clearTimeout(pressTimer);
    if (!dragging) return;
    dragging = false;
    node.style.cursor = "pointer";
    node.style.opacity = "1";
    if (movedDuringDrag) {
      suppressClick = true; // a drag must not also toggle the panel
      const rect = node.getBoundingClientRect();
      saveCornerPos(rect.top, rect.left);
    }
  });

  node.addEventListener("click", () => {
    if (suppressClick) {
      suppressClick = false;
      return;
    }
    togglePanel();
  });
}

function buildCornerButton() {
  if (cornerBtnEl) return cornerBtnEl;
  injectStyle();
  cornerBtnEl = el("div", {
    id: "ants-corner-btn",
    text: "🔧",
    title: "ANTs Nasty Bastards Tracker — click to open, press and hold to move",
  });
  const saved = loadCornerPos();
  if (saved) {
    cornerBtnEl.style.top = `${saved.top}px`;
    cornerBtnEl.style.left = `${saved.left}px`;
    cornerBtnEl.style.bottom = "auto";
    cornerBtnEl.style.right = "auto";
  }
  wireCornerButton(cornerBtnEl);
  document.body.appendChild(cornerBtnEl);
  return cornerBtnEl;
}

// ------------------------------------------------------- snapshot & report --

function environmentInfo() {
  const links = app && app.graph && app.graph.links;
  let linkCount = NaN;
  if (links) {
    if (typeof links.size === "number") linkCount = links.size;
    else if (Array.isArray(links)) linkCount = links.length;
    else if (typeof links === "object") linkCount = Object.keys(links).length;
  }
  return {
    ua: typeof navigator !== "undefined" ? navigator.userAgent : "unknown",
    dpr: typeof window !== "undefined" ? window.devicePixelRatio : NaN,
    cores: typeof navigator !== "undefined" ? navigator.hardwareConcurrency : NaN,
    nodes: graphNodeCount(),
    links: linkCount,
    zoom: app && app.canvas && app.canvas.ds ? app.canvas.ds.scale : NaN,
    canvas: app && app.canvas ? `${app.canvas.canvas?.width || "?"}x${app.canvas.canvas?.height || "?"}` : "n/a",
  };
}

function buildSnapshot() {
  const fm = frameMetrics();
  const pct = framePercentiles();
  const raf = rafMetrics();
  const hooks = hookRows();
  const inv = invalidationMetrics();
  const stalls = stallMetrics();
  const load = [...resourceLoadSummary().byPack.values()].sort((a, b) => b.bytes - a.bytes);
  const mem = performance.memory;
  return {
    version: VERSION,
    generatedAt: new Date().toISOString(),
    env: environmentInfo(),
    settings: {
      windowMs: WINDOW_MS,
      frameWindowMs: fm.windowMs,
      paused: S.paused,
      capMs: drawThrottleMs,
      synthTickMs: syntheticTickMs,
      muted: [...S.muted],
      benchmark: S.bench,
    },
    frame: { ...fm, p50: pct.p50, p95: pct.p95, p99: pct.p99, ...raf },
    hooks: hooks.rows.map((r) => ({ ...r, hooks: r.hooks })),
    nodeTypes: nodeRows(),
    invalidation: { perSec: inv.perSec, perRaf: inv.perRaf, sources: inv.sources.slice(0, 12) },
    stalls: { perSec: stalls.perSec, blockingMsPerSec: stalls.blockingMsPerSec, worst: stalls.worst, total: stalls.total, sources: stalls.rows.slice(0, 12) },
    load: load.slice(0, 30),
    memory: mem
      ? {
          used: mem.usedJSHeapSize,
          total: mem.totalJSHeapSize,
          limit: mem.jsHeapSizeLimit,
          baselineDelta: memBaseline === null ? null : mem.usedJSHeapSize - memBaseline,
        }
      : null,
    self: selfCostMetrics(),
    governor: govMetrics(),
    support: { ...S.env, performanceMemory: !!mem },
  };
}

function buildTelemetryReport() {
  const lines = [];
  const s = buildSnapshot();
  const fm = s.frame;

  lines.push(`ANTs Nasty Bastards Tracker v${s.version} snapshot — ${s.generatedAt}`);
  lines.push(
    `env: ${s.env.ua} | dpr ${s.env.dpr} | ${s.env.cores} cores | graph ${s.env.nodes} nodes / ${s.env.links} links | zoom ${fmtMs(s.env.zoom, 2)} | canvas ${s.env.canvas}`
  );
  lines.push(
    `settings: window ${(s.settings.windowMs / 1000).toFixed(0)}s | frame window ${(s.settings.frameWindowMs / 1000).toFixed(0)}s | ` +
      `${s.settings.paused ? "PAUSED" : "sampling"} | cap ${s.settings.capMs ? `${s.settings.capMs}ms` : "off"} | ` +
      `synth tick ${s.settings.synthTickMs ? `${s.settings.synthTickMs}ms` : "off"} | muted: ${s.settings.muted.length ? s.settings.muted.join(", ") : "(none)"}`
  );
  lines.push(`attribution support: LoAF ${s.support.loaf ? "yes" : "no"}, longtask ${s.support.longtask ? "yes" : "no"}, performance.memory ${s.support.performanceMemory ? "yes" : "no"}`);

  lines.push("");
  lines.push("-- FRAME --");
  if (!fm.ok) {
    lines.push("(no frames recorded yet — pan the graph, or check the console for [ANTs Tracker] warnings about canvas.draw)");
  } else {
    lines.push(
      `fps ${fmtRate(fm.fps)} | mean ${fmtMs(fm.meanFrameMs)}ms | p50 ${fmtMs(fm.p50)} | p95 ${fmtMs(fm.p95)} | p99 ${fmtMs(fm.p99)} | max ${fmtMs(fm.maxFrameMs)}ms`
    );
    lines.push(
      `display ${Number.isFinite(fm.displayHz) ? fm.displayHz.toFixed(1) + "Hz" : "?"} | ${Number.isFinite(fm.drawsPerRaf) ? fm.drawsPerRaf.toFixed(2) : "?"} redraws per displayed frame`
    );
    lines.push(
      `low-zoom drawing: ${
        lodOn()
          ? `on (nodes < ${LOD.minPx}px as one rectangle, links ${LOD.plan.links ? "straight" : "as drawn"}, idle redraw cap ${LOD.idleCapMs || "off"}ms) ` +
            `— ${LOD.nodes} node draw(s) and ${LOD.links} link draw(s) simplified, ${LOD.capped} redraw(s) merged` +
            (LOD.thumbZoom > 0
              ? `, previews ${LOD.imgThumb}/${LOD.imgSeen} served from thumbnails (${LOD.thumbsBuilt} cached, ${fmtBytes(LOD.thumbBytes)}) below ${Math.round(LOD.thumbZoom * 100)}% zoom`
              : "") +
            (LOD.detailZoom > 0
              ? LOD.thinLinks > 0
                ? `, links ${LOD.thinLinks} segment(s) drawn 1px without outlines below ${Math.round(LOD.detailZoom * 100)}% zoom`
                : lodLinksStraight()
                  ? `, links drawn straight (${LOD.linkStyle === "straight" ? "link setting: always straight" : "link setting: straight while the graph is rectangles"})`
                  : ""
              : "") +
            (LOD.domHidden
              ? `, ${LOD.domHidden} DOM element(s) of boxed nodes hidden` +
                (LOD.domStilled ? ` (${LOD.domStilled} out of the per-frame widget layout pass)` : "")
              : "") +
            (() => {
              const since = lodSinceSwitch();
              if (!since || !LOD.baseline) return "";
              return `; since the switch (${since.n} frames): node drawing ${fmtMs(LOD.baseline.nodeMsPerFrame)} → ${fmtMs(since.nodeMsPerFrame)} ms/frame, links ${fmtMs(LOD.baseline.connMsPerFrame)} → ${fmtMs(since.connMsPerFrame)}, frame ${fmtMs(LOD.baseline.meanFrameMs)} → ${fmtMs(since.meanFrameMs)} ms`;
            })()
          : "off (the canvas is drawn exactly as ComfyUI draws it)"
      }${LOD.error ? ` [turned itself off after an error: ${LOD.error}]` : ""} | ` +
      `budget per frame: drawNode ${fmtMs(fm.nodeMsPerFrame)}ms (${fmtPct(fm.nodeShare)}) ` +
        `[hooks ${fmtMs(fm.attrMsPerFrame)}ms ${fmtPct(fm.attrShare)}, litgraph chrome ${fmtMs(fm.chromeMsPerFrame)}ms ${fmtPct(fm.chromeShare)}] | ` +
        `drawConnections ${fmtMs(fm.connMsPerFrame)}ms (${fmtPct(fm.connShare)}) | everything else ${fmtMs(fm.otherMsPerFrame)}ms (${fmtPct(fm.otherShare)})`
    );
  }

  lines.push("");
  lines.push("-- EXTENSION / NODE-TYPE DRAW HOOKS (per drawn frame, in the last window) --");
  if (!s.hooks.length) lines.push("(no hook activity)");
  for (const r of s.hooks) {
    lines.push(
      `${r.label}${r.muted ? " [MUTED]" : ""}\t${fmtMs(r.msPerFrame)}ms/frame\t${fmtPct(r.share)}\t${fmtMs(r.callsPerFrame)} calls/frame\t` +
        `${fmtMs(r.msPerCall, 3)}ms/call\t${r.outsideMs > 0 ? fmtMs(r.outsideMs) + "ms off-frame" : ""}` +
        `${r.skipped ? `\t${r.skipped} skipped` : ""}`
    );
    for (const h of r.hooks) {
      lines.push(`    ${h.hook}\t${fmtMs(h.insideMs)}ms in window\t${h.insideCalls} calls\t${fmtMs(h.msPerCall, 3)}ms/call`);
    }
  }

  lines.push("");
  lines.push("-- NODE TYPES BY RENDER COST (includes hook cost above as a subset) --");
  if (!s.nodeTypes.length) lines.push("(no node draws recorded)");
  for (const r of s.nodeTypes.slice(0, 40)) {
    lines.push(`${r.type}\t${fmtMs(r.msPerFrame)}ms/frame\t${fmtMs(r.callsPerFrame)} calls/frame\t${fmtMs(r.msPerCall, 3)}ms/call\tp95 ${fmtMs(r.p95)}ms`);
  }

  lines.push("");
  lines.push("-- REDRAW REQUESTS (canvas.setDirty) --");
  lines.push(
    `${fmtRate(s.invalidation.perSec)}/s${Number.isFinite(s.invalidation.perRaf) ? ` (~${s.invalidation.perRaf.toFixed(2)} per displayed frame)` : ""}` +
      " — callers below are sampled at ~20/s and scaled:"
  );
  if (!s.invalidation.sources.length) lines.push("(no caller sampled)");
  for (const c of s.invalidation.sources) {
    lines.push(`  ${c.sig}\t${c.pack || "pack unknown"}\t~${fmtRate(c.estPerSec)}/s\t${fmtPct(c.share)} share\t${c.sampled} samples`);
  }

  lines.push("");
  lines.push("-- STALLS (main-thread blocking that is NOT canvas drawing) --");
  lines.push(`${fmtRate(s.stalls.blockingMsPerSec)}ms blocking/s | ${s.stalls.perSec.toFixed(2)}/s | worst ${fmtMs(s.stalls.worst, 0)}ms | ${s.stalls.total} total`);
  if (!s.stalls.sources.length) lines.push("(no stalls recorded)");
  for (const c of s.stalls.sources) {
    lines.push(
      `  ${c.sig}\t${c.pack || "pack unknown"}\ttrigger: ${c.invoker || "?"}\t${c.count}x\t${fmtMs(c.blockingMs, 0)}ms blocking` +
        `${c.count > 0 ? `\t${fmtMs(c.blockingMs / c.count, 1)}ms/stall` : ""}\tworst ${fmtMs(c.worstMs, 0)}ms` +
        `${c.forcedLayoutMs > 0 ? `\tforced layout ${fmtMs(c.forcedLayoutMs, 0)}ms` : ""}`
    );
  }

  lines.push("");
  lines.push("-- LOAD (/extensions/ packs, startup only) --");
  if (!s.load.length) lines.push("(no /extensions/ resource entries)");
  for (const p of s.load) {
    lines.push(`${p.pack}\t${fmtBytes(p.bytes)}\t${p.files} files\tspan ${fmtMs(p.spanMs, 0)}ms\tslowest ${fmtMs(p.slowest, 0)}ms`);
  }

  lines.push("");
  lines.push("-- MEMORY --");
  if (!s.memory) {
    lines.push("(performance.memory unavailable — Chromium-only API)");
  } else {
    lines.push(
      `JS heap used ${fmtBytes(s.memory.used)} / allocated ${fmtBytes(s.memory.total)} / limit ${fmtBytes(s.memory.limit)}` +
        `${s.memory.baselineDelta !== null ? ` | since baseline ${fmtBytes(s.memory.baselineDelta)}` : ""}`
    );
  }

  lines.push("");
  lines.push("-- SCHEDULER (governor: tick sources this page schedules) --");
  const gv = s.governor;
  if (!gv || !gv.installed) {
    lines.push(gv && gv.installError ? `(not installed: ${gv.installError})` : "(not installed)");
  } else if (gv.disabled) {
    lines.push(`TURNED OFF — ${gv.offReason}. Nothing is being limited; the page's own timers are untouched (reload to reinstall it).`);
    lines.push(`  ${gv.sourceCount} source(s) had been seen, ${gv.counters.skipped} tick(s) skipped, ${gv.counters.deferred} deferred before it stopped.`);
  } else {
    lines.push(
      `${gv.sourceCount} source(s), ${gv.throttled} limited | ${gv.counters.skipped} ticks skipped (${fmtRate(gv.skippedPerSec)}/s) | ` +
        `${gv.counters.deferred} deferred | ${gv.counters.coalesced} redraw request(s) merged | ` +
        `${gv.counters.inputLifted} display-lane tick(s) let through while the input guard was recent | rAF mode ${gv.controls.rafMode}` +
        `${gv.controls.rafMode === "adaptive" ? ` at ${gv.controls.rafMinHz}Hz floor` : ""} | ` +
        `estimated ${fmtMs(gv.savedMsPerSec)}ms/s kept off the main thread | governor's own overhead ${fmtMs(gv.overheadMsPerSec * 1000, 0)}µs/s`
    );
    for (const r of gv.sources.slice(0, 12)) {
      if (!r.fires && !r.msPerSec) continue;
      lines.push(
        `  ${r.label}\t${r.kindLabel} every ${fmtMs(r.requestedMs || 16.7, 1)}ms\t${r.policyLabel}` +
          `${r.policy !== "full" ? ` (limit ${fmtMs(r.effectiveMs, 0)}ms)` : ""}\t${fmtRate(r.runsPerSec)}/s\t${fmtMs(r.msPerSec)}ms/s\t` +
          `${fmtMs(r.perRunMs, 3)}ms/run\t${fmtMs(r.worst)}ms worst\t${r.skipped} skipped` +
          `${Number.isFinite(r.sourceRateBefore) && Number.isFinite(r.sourceRateAfter) ? `\twas ${fmtRate(r.sourceRateBefore)}/s before the limit, now ${fmtRate(r.sourceRateAfter)}/s` : ""}`
      );
    }
    if (!gv.sources.length) lines.push("(no tick sources seen: the page registered none through the wrapped globals)");
    lines.push(
      `  traces: ${gv.traceCount} long frame(s) captured | worker lane: ${gv.worker.available ? "available" : `unavailable (${gv.worker.why})`}` +
        `${gv.worker.jobs ? ` | ${gv.worker.jobs} job(s), ${fmtMs(gv.worker.offThreadMs)}ms off-thread, ${fmtMs(gv.worker.mainMs)}ms of main-thread time` : ""}`
    );
    for (const tr of GOV.traces.slice(0, 5)) {
      const top = tr.scripts[0];
      lines.push(
        `  long frame ${fmtMs(tr.duration, 0)}ms (${fmtMs(tr.blocking, 0)}ms blocking, ${fmtMs(tr.layoutMs, 0)}ms forced layout)` +
          `${top ? `: ${top.fn} @ ${top.file} ${fmtMs(top.ms, 0)}ms${top.invoker ? ` [${top.invoker}]` : ""}` : ": no script attribution"}`
      );
      if (tr.ticks.length) {
        lines.push(`    inside it: ${tr.ticks.slice(0, 4).map((t) => `${t.label} ×${t.count} (${fmtMs(t.ms, 0)}ms)`).join(", ")}`);
      }
      if (tr.callers && tr.callers.length) {
        lines.push(`    asked for by: ${tr.callers.map((c) => `${c.label} ×${c.count}`).join(", ")}`);
      }
      lines.push(`    ${tr.redraws} redraw request(s), ${tr.coalesced} merged away${tr.limited.length ? `, limits active: ${tr.limited.join("; ")}` : ""}`);
    }
  }

  {
    const au = gv.auto || {};
    if (au.on) {
      lines.push(
        `  autopilot: ON, target ${au.targetMsPerSec} ms/s of limited-source cost | measured ${Math.round(au.measuredMsPerSec || 0)} ms/s | ` +
          `${au.count || 0} limit(s) applied${au.note ? ` | ${au.note}` : ""}`
      );
      for (const a of au.actions || [])
        lines.push(`    it limited ${a.label} to ${a.label2} (was burning ${a.measuredMsPerSec} ms/s, cap ${a.gapMs}ms, ≈${a.predictedMsPerSec} ms/s after)`);
    }
    if (gv.inert && gv.inert.count) {
      lines.push(
        `  ${gv.inert.count} limited source(s) are not affected by their own limit: it is narrower than how far apart their runs already are ` +
          `(${Math.round(gv.inert.msPerSec)} ms/s still on the main thread). Use 2/s or 1/s for a chain that slow.`
      );
    }
  }

  lines.push("");
  lines.push("-- BENCHMARK (scripted pan) --");
  const A = s.settings.benchmark && s.settings.benchmark.A;
  const B = s.settings.benchmark && s.settings.benchmark.B;
  lines.push(`A: ${benchLine(A)}`);
  lines.push(`B: ${benchLine(B)}`);

  lines.push("");
  lines.push("-- TRACKER SELF-COST --");
  lines.push(
    `${s.self.wrappedHooks} hooks wrapped | ${s.self.buckets} buckets | ${fmtBytes(s.self.ringBytes)} ring buffers | ` +
      `panel ${fmtMs(s.self.renderMsPerSec * 1000, 0)}µs/s | bookkeeping ${fmtMs(s.self.sweepMsPerSec * 1000, 0)}µs/s | up ${(s.self.uptime / 60).toFixed(1)}min`
  );

  return lines.join("\n");
}

async function copyTelemetryReport(buttonEl) {
  const text = buildTelemetryReport();
  const original = "📋 Copy";
  const show = (label) => {
    if (!buttonEl) return;
    setText(buttonEl, label);
    govOwn(() => setTimeout(() => setText(buttonEl, original), 1600));
  };
  try {
    if (!navigator.clipboard || !navigator.clipboard.writeText) throw new Error("clipboard API unavailable");
    await navigator.clipboard.writeText(text);
    show("Copied!");
    return;
  } catch (e) {
    /* fall through to the legacy path */
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    if (typeof document.execCommand === "function") document.execCommand("copy");
    document.body.removeChild(ta);
    show("Copied (fallback)");
  } catch (e) {
    show("Copy failed — see console");
    console.error("[ANTs Tracker] clipboard copy failed:", e);
  }
}

// ------------------------------------------------------- patch + register --

// v1 called its canvas patch once from setup() and marked it done even when
// app.canvas did not exist yet, which permanently disabled frame timing with no
// retry. Here a failed attempt stays unpatched and is retried briefly.
let canvasRetryTimer = null;

function ensureCanvasPatched() {
  if (patchCanvasDraw()) return true;
  canvasRetries++;
  if (canvasRetries > 80) {
    warnOnce(
      "canvas-give-up",
      "app.canvas never appeared, so frame totals / the frame budget / per-node-type cost stay unavailable. " +
        "Per-extension hook timing and the Stalls tab still work."
    );
    return false;
  }
  if (!canvasRetryTimer) {
    canvasRetryTimer = govOwn(() => setTimeout(() => {
      canvasRetryTimer = null;
      ensureCanvasPatched();
    }, 250));
  }
  return false;
}

// Test/debug surface. Kept small and read-mostly; the test harness drives the
// module through this rather than reaching into internals by name.
function installDebugApi() {
  try {
    if (typeof window === "undefined") return;
    window.__antsTracker = {
      version: VERSION,
      get snapshot() {
        return buildSnapshot();
      },
      get report() {
        return buildTelemetryReport();
      },
      open: () => togglePanel(true),
      close: () => togglePanel(false),
      toggle: () => togglePanel(),
      pause: () => {
        if (!S.paused) togglePause();
      },
      resume: () => {
        if (S.paused) togglePause();
      },
      mute: (label) => {
        if (!S.muted.has(label)) toggleMute(label);
      },
      unmute: (label) => {
        if (S.muted.has(label)) toggleMute(label);
      },
      clearMutes,
      reset: () => resetAllStats(),
      setCap: (ms) => {
        drawThrottleMs = Number(ms) || 0;
      },
      // Low-zoom drawing: the opt-in that makes the canvas cheaper per frame
      // instead of less frequent. Also driven from the Nodes tab.
      lowZoom: {
        get state() {
          return LOD;
        },
        get visibility() {
          return lodVisibility(app.canvas);
        },
        get limits() {
          return {
            minPx: LOD_MIN_PX.slice(),
            idleCapMs: LOD_IDLE_CAP_MS.slice(),
            thumbZoom: LOD_THUMB_ZOOMS.slice(),
            thumbLadder: LOD_THUMB_LADDER.slice(),
            detailZoom: LOD_DETAIL_ZOOMS.slice(),
            linkWidth: LOD_LINK_WIDTH,
          };
        },
        get detail() {
          return {
            on: lodDetailOn(),
            belowZoom: LOD.detailZoom,
            thinLinks: LOD.thinLinks,
            linkWidth: LOD_LINK_WIDTH,
            lowQualityForced: lodDetailOn() && !LOD.lqMissing,
            lowQualityAvailable: !LOD.lqMissing,
          };
        },
        get dom() {
          return {
            hidden: LOD.domHidden,
            nodes: LOD.domNodes,
            marked: LOD.domMarked ? LOD.domMarked.size : 0,
            stilled: LOD.domStilled,
            // The widgets themselves, for anyone who wants to see what was
            // touched rather than take the count on faith.
            widgets: LOD.domWidgets ? [...LOD.domWidgets.keys()] : [],
          };
        },
        get previews() {
          return {
            on: lodPreviewsOn(),
            zoom: LOD.zoom,
            belowZoom: LOD.thumbZoom,
            served: LOD.imgThumb,
            seen: LOD.imgSeen,
            fullSize: LOD.imgFull,
            skipped: LOD.imgSkipped,
            built: LOD.thumbsBuilt,
            bytes: LOD.thumbBytes,
            failures: LOD.thumbFailures,
          };
        },
        get frontendLod() {
          return lodFrontendLod(app.canvas);
        },
        set: (opts) => lodSet(opts),
        off: () => lodSet({ minPx: 0, idleCapMs: 0, thumbZoom: 0, detailZoom: 0 }),
      },
      setSyntheticTick,
      benchmark: (ms, slot) => runScriptedPan(Number(ms) || 6000, slot || "A"),
      parseCallerStack,
      refreshIntervalFor,
      // Live row caps: lower them (or raise them) to trade panel render cost
      // against how much of a long list is on screen.
      rowCaps,
      // The scheduler layer: set limits, tune the rAF governor, read what it
      // measured, and use the off-thread lane. Everything here is also exposed
      // in the Governor tab; the API exists so tests (and other extensions) do
      // not have to reach into internals by name.
      governor: {
        get metrics() {
          return govMetrics();
        },
        get sources() {
          return govRows();
        },
        get traces() {
          return GOV.traces.slice();
        },
        get state() {
          return GOV;
        },
        get workerSource() {
          return GOV_WORKER_SRC;
        },
        policy: (key, id) => govSetPolicy(key, id),
        control: (key, value) => govSetControl(key, value),
        suggest: () => govSuggest(),
        autoPilot: () => govAutoPilot(),
        pickPolicy: (key) => {
          const row = govRows().find((r) => r.key === key || r.label.includes(key));
          const s = row ? govHeaviestSource(row) : null;
          return s ? govPickPolicy(s) : null;
        },
        reset: () => govReset(),
        off: (reason) => govUninstall(reason),
        probeWorker: () => govProbeWorker(),
        selfTest: () => govRunSelfTest(),
        selfTestMain: (arg) => govSelfTestMainThread(arg),
        offload: (job, arg) => govOffload(job, arg),
        own: (fn) => govOwn(fn),
      },
      // Internal state, for tests and for debugging the tracker itself.
      get _state() {
        return S;
      },
      get _panel() {
        return ui;
      },
    };
  } catch (e) {
    /* a headless/hostile environment without window — nothing to install */
  }
}

patchRegisterExtension();
installDebugApi();

app.registerExtension({
  name: EXT_NAME,

  async setup() {
    ensureCanvasPatched();
    lodLoadSettings();
    buildCornerButton();
    installStallObserver();
    installRafMonitor();
    installMemorySampler();
    govOwn(() => setInterval(sweepStaleData, SWEEP_MS));
    // Node types keep arriving as packs register, so re-scan for hooks that
    // never went through this tool's beforeRegisterNodeDef wrapper.
    govOwn(() => setInterval(scanRegisteredTypes, 2000));
    govOwn(() => setInterval(() => {
      if (ui.built && ui.panel.classList.contains("open") && ui.active === "gpu") refreshGpu();
    }, 2500));
    console.info(
      `[ANTs Tracker] v${VERSION} running. Open the panel with the 🔧 button (or the node's Open Tracker widget); ` +
        "window.__antsTracker.snapshot / .report give the same data from the console."
    );
  },

  afterConfigureGraph() {
    resetAllStats();
  },

  beforeRegisterNodeDef(nodeType, nodeData) {
    if (!nodeData || nodeData.name !== NODE_NAME) return;
    const onNodeCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const ret = onNodeCreated ? onNodeCreated.apply(this, arguments) : undefined;
      this.addWidget("button", "Open Tracker", null, () => {
        togglePanel();
        try {
          this.setDirtyCanvas(true, true);
        } catch (e) {
          /* cosmetic only */
        }
      });
      return ret;
    };
  },
});

// ---------------------------------------------------------------- LIMITS ---
//
// What this tool deliberately does NOT claim to measure, so nobody has to
// reverse-engineer the limits from the numbers:
//
//  * Anything drawn by a widget's own draw() method, by a Vue component (the
//    Nodes 2.0 style frontend), or by a canvas method that is not wrapped here
//    is not attributed by name. It still lands in the frame budget's
//    "everything else" line, and if it blocks the main thread it also lands in
//    the Stalls tab — but the panel cannot name it.
//  * Timing is per redraw of the whole canvas, so a hook's cost is exact but
//    its "share of frame" is a share of the mean frame in the window, not of
//    the frame it happened to run in.
//  * Redraw requests are attributed by sampled stacks (~20/s) plus an exact
//    total rate. A source that requests redraws in rare bursts can be missed
//    between samples, and callers are never resolved to a specific custom node
//    pack unless their script lives under /extensions/.
//  * Single-threaded assumption: if the browser is compositing on another
//    thread, the frame cost measured here is still the JS/draw cost only.
//  * GPU time, GPU memory per extension, and VRAM attribution are not
//    obtainable from page JavaScript at all, in any browser. The GPU tab says
//    what it can show instead of inventing a number.
//  * Firefox exposes neither performance.memory nor long tasks, so the Memory
//    and Stalls tabs stay empty there by design (the panel says so).
//  * Muting changes what is drawn, by definition. A muted extension may also
//    take a different code path on the next call (caches, internal state), so
//    treat a muted/unmuted delta as an upper bound rather than an exact price.
//  * The scheduler layer can only govern callbacks that reach the page's own
//    setInterval / setTimeout / requestAnimationFrame: microtasks, promise
//    chains, browser-internal work (style, layout, paint, the compositor's own
//    threads) and callbacks registered before this module loaded on a loop that
//    never re-registers are outside its reach. Attribution of a source is
//    sampled at registration, so a source can be listed as a name only until a
//    sample lands on it.
//  * Limiting a source changes behaviour by design: a poll runs less often, and
//    a "pause" policy stops it entirely. Every tick the panel could not time
//    (because it never ran) means the "ms/s kept off the main thread" figure is
//    an estimate built from the ticks that did run, not a measurement.
//  * Only pure compute can leave the main thread. Vue's render, the DOM, and
//    canvas drawing cannot: they are main-thread-only by specification, and
//    OffscreenCanvas only helps an application that created its canvas that way
//    (ComfyUI does not). The worker lane exists for the pure-math parts, and it
//    says so when it falls back to the main thread.
//  * Worker functions cannot capture closures, which is why the lane takes a
//    job name (or a self-contained function source) plus structured-cloneable
//    arguments and nothing else.
