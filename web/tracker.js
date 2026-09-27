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

const VERSION = "2.0.0";
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
      if (drawThrottleMs > 0) {
        const gap = t0 - lastRealDrawAt;
        if (gap < drawThrottleMs) {
          S.counters.capped++;
          // v1 dropped this redraw permanently — the canvas could sit on stale
          // pixels until the next unrelated tick. Schedule exactly one trailing
          // redraw instead, so a cap becomes a rate limit, not data loss.
          scheduleTrailingDraw(this, drawThrottleMs - gap);
          return undefined;
        }
      }
      lastRealDrawAt = t0;
      S.counters.draws++;
      curNodeStageMs = 0;
      curConnStageMs = 0;
      curAttrMs = 0;
      drawDepth++;
      let ret;
      try {
        ret = originalDraw.apply(this, args);
      } finally {
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
      const t0 = performance.now();
      const ret = originalDrawNode.call(this, node, ctx, ...rest);
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

  if (typeof proto.setDirty === "function" && !proto.setDirty.__antsWrapped) {
    const originalSetDirty = proto.setDirty;
    const wrappedSetDirty = function (...args) {
      const t0 = performance.now();
      if (!S.paused) {
        S.invalidations.push(t0, 1);
        maybeSampleCaller(t0);
      }
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

  canvasPatched = true;
  return true;
}

function scheduleTrailingDraw(canvas, delayMs) {
  if (capTrailingTimer) return;
  S.counters.deferred++;
  capTrailingTimer = setTimeout(() => {
    capTrailingTimer = null;
    try {
      if (canvas && typeof canvas.draw === "function") canvas.draw(true, true);
    } catch (e) {
      warnOnce("trailing-draw-fail", `Trailing redraw after rate cap failed: ${e && e.message}`);
    }
  }, Math.max(1, Math.ceil(delayMs)));
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

const PLUMBING = /(setDirtyCanvas|setDirty|dirty_canvas|dirty_bgcanvas|__ants)/;

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
  for (const script of scripts) {
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
      if (!S.paused) S.raf.push(t, t - prev);
    }
    prev = t;
    S.renderTicks++;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

function installMemorySampler() {
  if (!performance.memory) return;
  const sample = () => {
    if (!S.paused && performance.memory) S.mem.push(nowMs(), performance.memory.usedJSHeapSize);
  };
  sample();
  setInterval(sample, 1000);
  setInterval(() => {
    try {
      performance.setResourceTimingBufferSize && performance.setResourceTimingBufferSize(2000);
    } catch (e) {
      /* ignore */
    }
  }, 30000);
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
const rowCaps = { timing: 120, nodes: 60, stalls: 60 };

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
    ["timing", "Timing"],
    ["nodes", "Nodes"],
    ["stalls", "Stalls"],
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
        setText(c[0], s.sig);
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
    setText(selfVals.render, `${fmtMs(sc.renderMsPerSec * 1000, 0)} µs/second (${S.counters.renderCount} panel renders so far)`);
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
    syntheticTickTimer = setInterval(() => {
      try {
        if (app.canvas && typeof app.canvas.setDirty === "function") app.canvas.setDirty(true, true);
        else if (app.canvas && typeof app.canvas.draw === "function") app.canvas.draw(true, true);
        else warnOnce("no-force-draw", "Can't force a redraw: app.canvas is not callable in this frontend version.");
      } catch (e) {
        warnOnce("synthetic-tick-error", `Forced redraw failed: ${e && e.message}`);
      }
    }, ms);
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
    requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

function graphNodeCount() {
  const g = app && app.graph;
  if (!g) return NaN;
  if (Array.isArray(g._nodes)) return g._nodes.length;
  if (Array.isArray(g.nodes)) return g.nodes.length;
  if (g._nodes instanceof Map) return g._nodes.size;
  return NaN;
}

// -------------------------------------------------------------- lifecycle --

function buildTabContents() {
  if (ui.state.timing) return;
  buildTimingTab(ui.tabs.timing);
  buildNodesTab(ui.tabs.nodes);
  buildStallsTab(ui.tabs.stalls);
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
    selfCost.lastRolloverAt = now2;
  }
}

function startRefresh() {
  stopRefresh();
  ui.refreshTimer = setInterval(() => {
    const t0 = performance.now();
    try {
      renderSummary();
      updateActiveTab();
    } catch (e) {
      warnOnce("render-fail", `Panel render failed: ${e && e.message}`);
      console.error(e);
    }
    selfCost.renderAccum += performance.now() - t0;
    S.counters.renderCount++;
  }, UI_REFRESH_MS);
}

function stopRefresh() {
  if (ui.refreshTimer) clearInterval(ui.refreshTimer);
  ui.refreshTimer = null;
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
    pressTimer = setTimeout(() => {
      dragging = true;
      node.style.cursor = "grabbing";
      node.style.opacity = "0.85";
    }, LONG_PRESS_MS);
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
    setTimeout(() => setText(buttonEl, original), 1600);
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
    canvasRetryTimer = setTimeout(() => {
      canvasRetryTimer = null;
      ensureCanvasPatched();
    }, 250);
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
      setSyntheticTick,
      benchmark: (ms, slot) => runScriptedPan(Number(ms) || 6000, slot || "A"),
      parseCallerStack,
      // Live row caps: lower them (or raise them) to trade panel render cost
      // against how much of a long list is on screen.
      rowCaps,
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
    buildCornerButton();
    installStallObserver();
    installRafMonitor();
    installMemorySampler();
    setInterval(sweepStaleData, SWEEP_MS);
    // Node types keep arriving as packs register, so re-scan for hooks that
    // never went through this tool's beforeRegisterNodeDef wrapper.
    setInterval(scanRegisteredTypes, 2000);
    setInterval(() => {
      if (ui.built && ui.panel.classList.contains("open") && ui.active === "gpu") refreshGpu();
    }, 2500);
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
