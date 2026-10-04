// ANTs Frontend Optimizer — frontend profiler for ComfyUI
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

const VERSION = "2.6.9";
const EXT_NAME = "ANTs.NastyBastardsTracker.Core";
// The class key ComfyUI stores in a workflow. The old key is still recognised so
// a graph saved before the rename does not lose this node.
const NODE_NAME = "ANTs_Frontend_Optimizer";
const NODE_NAME_ALIAS = "ANTsNastyBastardsTracker";

function lodOwnNode(node) {
  const t = node && (node.type || node.comfyClass);
  return t === NODE_NAME || t === NODE_NAME_ALIAS;
}

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

// --- ring buffer sizing ----------------------------------------------------
const RING_CAP_INITIAL = 64;
const RING_CAP_MAX = 4096;
const MAX_CALLERS = 80;
const MAX_STALL_SOURCES = 80;
const STACK_SAMPLES_PER_SEC = 20;

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
  // The master switch, driven by the checkbox on the tracker's own node. Off means
  // off: no wrapped hooks, no scheduler deferrals, no sampling, no redraw cap, no
  // low-zoom drawing, no DOM touched — the page is ComfyUI's own again, and the
  // settings are kept so switching back on restores exactly what was there.
  enabled: true,
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
  frameLinkStage: newSeries(512), // (t, sum of renderLink ms inside that frame)
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
let curLinkStageMs = 0;

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
  for (const ring of [S.frames, S.frameAttr, S.frameNodeStage, S.frameConnStage, S.frameLinkStage]) trimIfLive(ring, now - FRAME_KEEP_MS);

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
  const linkStage = S.frameLinkStage.aggregate(now - win);

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
    S.frames.bytes + S.frameAttr.bytes + S.frameNodeStage.bytes + S.frameConnStage.bytes + S.frameLinkStage.bytes + S.raf.bytes + S.invalidations.bytes + S.stalls.bytes + S.mem.bytes;
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
    if (!S.enabled) return fn.apply(this, args); // switched off = nothing but the call
    if (S.paused) return fn.apply(this, args); // pause = no timing, behavior unchanged
    // A node snapshot capture runs the node's own draw path on purpose. That time
    // is this tool's, and it is counted in LOD.snapMs — attributing it to the pack
    // that owns the hook would show a capture as the pack being slow, which is the
    // one kind of lie this file must not tell.
    if (LOD.inCapture) return fn.apply(this, args);
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
//   * below a zoom the user picks, every node is painted as one flat rectangle
//     instead of LiteGraph's border, gradient, title, slots, widgets and
//     previews — and the DOM content of those nodes goes with it;
//   * a link's shape is the user's own choice (straight lines only when asked
//     for), and link ink can be thinned below a zoom without touching nodes;
//   * and while nobody is touching the page the redraw rate is capped, because
//     the frame nobody is looking at is the cheapest frame on the page.
// Replacing a node is on at 50% for a fresh install: that is the zoom a large
// screen stops being able to read a live node. A saved "off" stays off, and
// "Back to full drawing" is the way back. Any exception turns the mode back off
// with the reason in the panel: a rendering change this tool cannot explain
// would be worse than a slow frame.
const LOD = {
  flatBelow: 0.5, // replace every node with a stand-in below this zoom (0 = off)
  legacyPx: 0, // a v2.1.8 "nodes under Npx" setting, carried over, shown once
  idleCapMs: 0, // while untouched, at most one redraw per this many ms (0 = off)
  nodes: 0, // node draws replaced by a rectangle
  links: 0, // link draws replaced by a straight line
  ms: 0, // time spent inside the simplified paths
  capped: 0, // redraws merged away by the idle cap
  error: "",
  baseline: null, // the frame budget as it was when the mode went on
  plan: { links: false, flat: 0, total: 0, medPx: 0, at: 0 },
  // What the flat boxes were allowed to say, and what they did say. Counters are
  // per paint, like LOD.nodes, so the panel can price the marks it asked for.
  boxDetail: "plain", // the default of the LOD_BOX_DETAIL ladder, which is defined with it below
  boxTitles: 0, // title bars drawn on flat boxes
  boxErrors: 0, // error strokes drawn on flat boxes
  boxBars: 0, // progress bars drawn on flat boxes
  boxMuted: 0, // boxes drawn dimmed (muted, bypassed or ghosted)
  // Node snapshots — the ladder above taken one step further: the box is a
  // picture of the node. The literals here are LOD_SNAP_* defaults, which are
  // defined further down with the rest of this block's constants.
  snapOn: true, // the stand-in is a picture of the node; a fill is the fallback
  snapRatio: 1, // capture pixels per graph unit. 1x is enough below 50% zoom
  snapMb: 4096, // byte budget for stored bitmaps; the literal is LOD_SNAP_BUDGET_DEFAULT
  linkZoom: true, // widget-stop zoom and the picture zoom share the higher of the two
  snapFrame: 0, // drawn frames since load: what "in use" is measured in
  snaps: null, // Map<node, record> in reuse order (a Map iterates in insertion order)
  snapQueue: null, // Set<node> waiting for a capture, insertion order
  snapBytes: 0, // bytes held by stored bitmaps
  snapDrawn: 0, // node draws served from a stored bitmap
  snapMisses: 0, // flat draws with no usable bitmap (painted as a box instead)
  snapCaptured: 0,
  snapMs: 0, // time spent inside captures — this tool's cost, kept out of the frame lanes
  snapSlow: 0, // captures that were slower than the budget (each buys a cooldown)
  snapCooldown: 0, // slow-capture cooldowns entered (each doubles the next wait)
  snapStaleHeld: 0, // pictures kept on screen while their replacement was photographed
  snapFailed: 0, // captures that threw
  snapLarge: 0, // nodes left as boxes: too big for a capture at any ratio
  snapEvicted: 0,
  snapInvalid: 0, // bitmaps dropped because the node changed
  snapKept: 0, // kept live on purpose: this tool's own node, a type you excluded
  snapPartial: 0, // pictures of nodes that have DOM widgets (the canvas part is not all of them)
  snapDomInk: 0, // DOM widget contents drawn into pictures (images, canvases, text)
  vueWidgetInk: 0, // widget rows whose own box and colour a picture carries (gauge)
  vueControlInk: 0, // form controls drawn as themselves: a slider's track and knob, a checkbox's tick, a colour swatch (gauge)
  snapDomText: 0, // of those, text widgets re-painted from their value
  snapDomSkipped: 0, // widget contents that could not be drawn (HTML, or an image not loaded yet)
  snapFit: 0, // captures made coarser than your ratio so they fit the size cap
  snapCoarse: 0, // captures made coarser than your ratio because the budget was full
  snapChurn: 0, // nodes left as boxes: they changed on every attempt
  snapBlank: 0, // nodes whose own draw leaves the canvas empty: nothing to photograph
  snapDrops: null, // WeakMap<node, drops since it was last drawn from a picture>
  snapWhy: null, // [{type, title, why}] — the names behind those counters
  snapWhySeen: null, // WeakMap<node, its entry>, so one node is named once and its reason stays current
  snapPruned: 0, // records dropped because their node left the graph
  snapClears: 0, // whole-cache clears (theme change, off, threshold gone, renderer switched)
  snapFull: 0, // captures skipped: the budget was full of bitmaps still in use
  snapFlagHeld: 0, // boxes painted because the canvas's shadow flag changed since capture
  snapFlips: 0, // times a node switched between picture and box — the flicker counter
  snapModes: null, // WeakMap<node, "snap"|"box">, kept across records so a flip is seen
  snapFailStreak: 0,
  snapTheme: "",
  snapPumping: false,
  snapTimer: null,
  snapExclude: [], // node types the user has asked to keep live
  inCapture: false, // true only while a capture draws: attribution steps aside
  // The image-preview thumbnail ladder (v2.1.5) was retired in v2.5.0: the node
  // picture *is* the thumbnail. The whole drawImage substitution was removed
  // after being unreachable for two releases; this tombstone stays so a saved
  // record cannot bring it back and `state.thumbZoom` still answers 0.
  thumbZoom: 0,
  diskOn: true, // load and store those pictures under ComfyUI's temp folder
  diskAsked: null, // Set of id+sig already requested this page
  diskDead: false, // the route failed enough times; stay in memory
  diskFail: 0,
  diskLoaded: 0,
  diskSaved: 0,
  diskDir: "",
  diskSwept: false,
  snapMipDrawn: 0, // blits that used a half or quarter copy
  snapMipSkipped: 0, // pictures kept at 1x because the budget could not hold the chain
  zoom: 0,
  // Link ink. Past a zoom the user sets, links are stroked 1px wide instead of 3
  // and lose the dark outline drawn under them — a change to the *stroke*, made
  // for the one call that draws that link, and to nothing else. Curves are kept,
  // because straightening a link is a different decision (see linkStyle), and
  // nothing here touches nodes, their widgets, or the frame's own quality flag.
  detailZoom: 0.6, // below this zoom link ink is reduced (0 = full detail)
  // Link shape, and only link shape. Two explicit answers:
  //   "spline"   — ComfyUI's curves, always, whatever zoom and whatever the node
  //                setting says (the default);
  //   "straight" — straight lines, always, for graphs drawn that way.
  // There is deliberately no "auto": a link's shape changing because the *node*
  // setting crossed a threshold is the coupling that made the old mode look like
  // it was flattening nodes on its own.
  linkStyle: "spline",
  thinLinks: 0, // link segments stroked thin so far
  linkMs: 0, // time inside renderLink calls (the ink itself)
  linkCalls: 0, // renderLink calls made (links actually drawn)
  domMarked: null, // Set of elements we are hiding right now
  domLayer: 0, // wrappers hidden through the DOM widget layer
  domMarkedWidgets: 0, // widgets carrying our hideOnZoom flag
  domWidgets: null, // Map<widget, original hideOnZoom> for the ones we flipped
  domHidden: 0, // elements hidden because their node is a box
  domNodes: 0, // nodes whose DOM content is hidden
  domStilled: 0, // widgets the frontend will actually honour hideOnZoom for
  // Focus mode. Two independent halves: the zoom at which node UI is switched
  // off, and whether off-screen nodes get the same treatment at any zoom.
  inertBelow: 0, // node UI is switched off below this zoom (0 = off)
  fovea: false, // off-screen DOM content is taken out of the picture at any zoom
  inertEls: 0, // elements carrying the inert class right now
  foveaEls: 0, // elements hidden because their node is far off screen
  // Written as literals because this object is built before the ladders below
  // are declared; the ladders are what the panel and the API offer.
  foveaMargin: 0.5, // how far off screen counts as far (viewports) — see VIEW_FOVEA_MARGINS
  foveaRestore: 1, // elements brought back per drawn frame — see VIEW_FOVEA_RESTORES
  foveaQueue: 0, // elements waiting their turn to come back
  foveaCameBack: 0, // elements handed back since the mode was switched on
  focusDom: "hide", // what "switched off" means for node DOM (see VIEW_FOCUS_DOM)
  blockSet: null, // Set of elements currently switched off, for the event gate
  hoverOff: null, // Set of nodes whose hover hooks are being held back
  canvasWidgetHits: 0, // widget hit-tests seen on the canvas while the mode was on
  canvasWidgetsBlocked: 0, // and answered with "no widget"
  hoverBlocked: 0, // node hover callbacks held back
  eventsBlocked: 0, // pointer events swallowed before they reached a switched-off element
  domVerified: 0, // elements this tool looked at with getComputedStyle and found off
  domBroken: 0, // ... and found still reachable, which is what the event gate is for
  domOwners: null, // Map<element, record>: every node DOM element we may hide
  vueFlat: null, // Set of nodes whose Vue element this tool has blanked
  vueUnreached: 0, // nodes whose element could not be found to blank
  vueNoElement: 0, // captures refused because the node's element was not on the page
  vueScaleNow: 0, // the DOM zoom measured for the last node measurement
  vueScaleFrom: "", // how it was measured: pane | inner | root | canvas
  vueTextNow: 0, // text lines the boxes/captures read out of the node's own DOM
  vueChromeNow: 0, // structural boxes the last measurement read out of the node's own DOM (not per frame)
  vueDomWrites: 0, // DOM mutations this tool made to the page (marks written, not re-written)
  vueLayoutReads: 0, // layout reads (each one can force a style-and-layout pass)
  vueProbes: 0, // video probes run inside a node's widget elements
  vueWatch: 0, // elements brought under the change observers (one observer per kind)
  vueStale: 0, // measurements dropped by a change the page reported
  vueChrome: 0, // structural DOM boxes (frame, header, body, slot dots) drawn into boxes/captures
  vueSettleArms: 0, // settle windows opened or restarted (a node that just changed)
  vueSettleHeld: 0, // capture slices postponed because the queue was still settling
  vuePaintSkipped: 0, // nodes whose subtree the browser is told to skip painting (gauge)
  vueElSeq: null, // WeakMap<element, serial>: what the signature uses to see a replaced element
  vueElNext: 0,
  vuePathway: "", // which pathway the held pictures were made for
  vueRoots: null, // Map<node, element>: what the frontend renders a Vue node into
  vueFlatOn: null, // last frame's answer to "are the boxes standing in?"
  vueBoxes: 0, // boxes painted in place of a Vue node's own element
  vueContentNow: 0, // box contents drawn on the last frame (a gauge, not a total)
  vueMediaNow: 0, // of those, the node's own images and canvases drawn from layout
  vueMedia: null, // Map<node, {root, key, at, items}>: the layout read, cached per node
  vueRestored: 0, // elements handed back (threshold, setting, tool, renderer)
  vueCleared: "", // why the last full hand-back happened, for the readout
  displayScale: 0, // 0 = read it from the browser, otherwise the device-pixel ratio
  display: null, // what the display-scale check found last time it ran
  sweptZoom: NaN, // the zoom the DOM was last swept at
  sweptKey: "", // and the flat decision it was swept for
  autoLinkCarried: false, // a v2.1.9 "auto" link setting was carried over
  // A measured answer to "does this setting do anything on my page": the two
  // states are alternated, one second each, and the frame budget is compared.
  ab: null, // { phase, rounds, saved, s0, s1, text }
};

// The zoom below which every node is painted as a rectangle. A zoom, not a node
// size: a node whose own UI hides, greys or adds a widget changes its size while
// you are looking at it, so a per-node pixel rule classifies the same node
// differently from one frame to the next — and the ones that move are exactly the
// JS-UI and dynamic-UI nodes, which then get flattened while their neighbours stay
// detailed. A zoom is a property of the camera: every node is treated the same
// way, one decision per frame, and the flips happen when *you* change the zoom.
const LOD_FLAT_ZOOM = [0, 0.05, 0.1, 0.15, 0.2, 0.25, 0.3, 0.4, 0.5];
// A v1 setting was a pixel width. Carrying one over needs a node width to divide
// by; this is the median node on a 4K ComfyUI workflow (measured, not invented).
const LOD_TYPICAL_NODE_PX = 350;
// A flat box that says nothing is a placeholder the user cannot read. This ladder
// is how much a box may say. `plain` is exactly the v2.1.16 box — one rectangle
// plus the selection ring — and every mark above it comes from a real field on
// the node, the same ones the frontend's own rendering reads:
//   * `title` — the node's own title-bar colour, drawn where LiteGraph draws the
//     title bar (above the body, NODE_TITLE_HEIGHT tall), so a box reads as the
//     node it stands for and carries that type's colour from the theme;
//   * `state` — the frontend's own error stroke, its own progress bar, and its
//     own alpha for a muted, bypassed or ghosted node.
// This ladder can only change what an already-flat box looks like. It cannot
// flatten a node that would otherwise be drawn in full: that is the zoom
// setting's decision and nothing else's (golden rule 6).
const LOD_BOX_DETAIL = ["plain", "title", "state"];
const LOD_BOX_DETAIL_DEFAULT = "plain";
const LOD_BOX_TITLE_H = 30; // graph units — LiteGraph's NODE_TITLE_HEIGHT
const LOD_BOX_TITLE_MAX = 0.4; // never more than this share of the node's height
const LOD_BOX_ERROR_COLOR = "#E00"; // LiteGraph's NODE_ERROR_COLOUR
const LOD_BOX_ERROR_PAD = 12; // graph units, the frontend's own error padding
const LOD_BOX_ERROR_WIDTH = 10; // graph units, the frontend's own error stroke
const LOD_BOX_PROGRESS_COLOR = "green"; // the colour the frontend's own bar uses
const LOD_BOX_PROGRESS_PX = 3; // a bar is at least this tall in CSS pixels
// Node snapshots: a flat box can also be a *picture of the node it stands for*,
// captured once while the page is idle and blitted back on later frames.
//
// The design follows ComfyUI-NodeSnapshots (SparknightLLC / EricBCoding, MIT):
// capture a node through its own draw path, key it on a signature of everything
// that changes what it draws, keep it only while the page is idle, and fall back
// to something cheap the moment it cannot be trusted. The implementation here is
// this file's own — same seams (`drawNode`), same idle lane and budget as the
// rest of the tool, no upstream code — so the licence decision stays open
// (plan.md, Track M). What is deliberately different:
//   * a snapshot replaces a *flat box*, never a live node. The flatten threshold
//     stays the only thing that decides which nodes stop being drawn in full, so
//     no zoom this tool does not already touch can change appearance (golden
//     rule 6). Reuse while panning is the point — panning moves the camera, not
//     the node — so a canvas pan does not disable it, and neither does dragging a
//     node. A link drag, a running bar and an error still draw live.
//   * the capture draws into its own offscreen canvas rather than the visible
//     one. The live context is never touched, so there is no canvas state to
//     restore (upstream had to copy sixteen properties and put them back).
//   * a capture's cost is counted as this tool's own (`LOD.snapMs`), not as the
//     node's: the hooks run, but the attribution wrapper steps aside while
//     `inCapture` is set. Otherwise a capture would show up in the Timing tab as
//     the pack being slow, which would be a lie.
//   * *every* node the canvas draws gets a picture, not just the ones upstream
//     trusts (v2.4.0). A DOM widget or an image preview is drawn by the browser
//     over the node, so the picture is the canvas part and the readout counts
//     those pictures apart; a node that draws nothing into a canvas at all is
//     caught by a five-patch ink probe and keeps its box, because a transparent
//     picture would erase it. A tall node is captured at the largest ratio that
//     fits the dimension cap instead of being skipped. A node whose drawing
//     changes before every picture can be drawn keeps its box (the churn guard),
//     and the readout names it — that name is the actionable part.
// The ratio and the budget are provisional: the plan measures before fixing them
// (K3), and the numbers are in the panel rather than in a claim.
const LOD_SNAP_RATIOS = [0.25, 0.5, 1, 2, 3]; // capture pixels per graph unit
const LOD_SNAP_RATIO_DEFAULT = 1; // 1x stays the default; 0.25x and 0.5x are choices, not the fallback
// The budget ladder starts at 256 MiB and doubles to 8 GiB. Below 256 was removed
// after a real report: a 1,041-node graph at 256 MiB held 255.6 MB, and every new
// capture evicted a bitmap that was on screen (7,040 captures for 1,041 nodes),
// which is visible as boxes and pictures flickering on and off. The floor is still
// that smallest step. A missing saved budget is 4096; an explicit saved 256, 512,
// 1024 or 2048 is left alone. This memory is canvas surfaces outside the JS heap.
const LOD_SNAP_BUDGETS = [256, 512, 1024, 2048, 4096, 8192]; // MiB held by stored bitmaps
const LOD_SNAP_BUDGET_DEFAULT = 4096;
// "In use" is measured in drawn frames, not in milliseconds. A time window looked
// right and failed a test that mattered: while the page is idle no frame is drawn
// at all, so bitmaps that are still on screen aged out and became evictable the
// moment the user came back. A frame counter cannot be fooled that way — a bitmap
// is in use while the node it belongs to is being drawn, and a node that stops
// being drawn (it went off screen, or the graph was switched) stops being
// protected after a frame or two, which is precisely the eviction pool.
const LOD_SNAP_GUARD_FRAMES = 2;
// A node whose capture was refused because the budget was full of in-use bitmaps
// waits this long before being tried again, so the lane cannot spin on it.
const LOD_SNAP_HOLD_MS = 5000;
const LOD_SNAP_PAD = 24; // graph units of margin around the node, so hooks that
// draw outside the body (selection rings, glow) are not cut off
const LOD_SNAP_TITLE_H = 30; // graph units above the body: LiteGraph's title bar
const LOD_SNAP_MAX_DIM = 2048; // px; a capture is fitted down to this, or the node stays a box
const LOD_SNAP_SLOW_MS = 60; // slower than this: stop, cool down, and try again later
const LOD_SNAP_SIG_MS = 100; // a signature is re-checked at most this often
const LOD_SNAP_IDLE_MS = 400; // input within this many ms stops the capture lane
const LOD_SNAP_GAP_MS = 32; // between capture slices, once the page is idle
// Execute / Run and Run-to-node. System RAM, not the canvas budget. A missing
// reading does not invent a number and does not release anything.
const LOD_RAM_OFF = 0.85; // off-screen stand-ins leave memory
const LOD_RAM_FULL = 0.95; // every in-memory stand-in leaves; disk files stay
const LOD_SNAP_QUEUE_MAX = 4096; // candidates remembered at once
const LOD_SNAP_FAIL_MAX = 5; // capture failures in a row before the mode gives up
const LOD_SNAP_TYPES_MAX = 64; // never-snapshot type list cap (a policy, not a dump)
// A node whose picture is thrown away before it has ever been drawn from, again
// and again, is a node whose drawing changes faster than the idle lane can
// re-photograph it (a poller writing widget values, for instance). Three strikes
// and it keeps its box for the session — and the readout names it, which is the
// one thing a box cannot say for itself.
// How many nodes the readout may name as "not pictured, and why".
const LOD_SNAP_WHY_MAX = 6;
// Images a node draws into itself are part of its picture; the walk is capped
// because a node with a hundred of them is not worth a hundred field reads.
const LOD_SNAP_IMGS_MAX = 8;
const LOD_IDLE_CAP_MS = [0, 250, 500, 1000];
const LOD_IDLE_INPUT_MS = 400; // how long one touch keeps the cap lifted
// Zoom levels below which links and node detail are reduced.
const LOD_DETAIL_ZOOMS = [0, 1, 0.8, 0.6, 0.4, 0.2];
const LOD_LINK_WIDTH = 1; // graph units; LiteGraph's own default is 3
const LOD_FULL_LINK_WIDTH = 3; // what ComfyUI draws when nothing is thinned
const LOD_DOM_CLASS = "ants-lod-box"; // elements hidden while their node is a box
// A Vue node's own element, blanked while the canvas paints a box in its place.
// `opacity: 0` is the whole mechanism: the element stops being drawn, keeps its
// layout box and keeps its pointer events, so its slots, its context menu, its
// resize handles and its drag still work — the element is there, it just does not
// paint. Nothing about the frontend's own state is touched.
//
// It is an *attribute*, not a class, and that is not a detail. Vue owns both the
// `class` and the `style` of that element (`:class` and `:style` on
// LGraphNode.vue's root): a re-render that changes the class string writes
// `el.className` and silently drops anything this tool added to it, which is
// exactly what a user saw — boxes painted behind nodes that were still drawing
// themselves, and (because the frontend's own text and previews stayed visible) a
// standing suspicion that the text stand-ins had worked all along. Vue never
// touches an attribute it does not know, so `data-ants-vue-standin` survives it,
// and the stylesheet rule carries `!important` so the frontend's inline
// `opacity` cannot outrank it either.
const LOD_VUE_ATTR = "data-ants-vue-standin";
// The same hazard for the older settings: a Vue node's *root* is hidden by the
// fovea and made inert when its widgets stop answering, and a class written on it
// is dropped the next time Vue re-renders the node. The attributes below are not
// Vue's to rewrite, and the rules that read them carry `!important`.
const LOD_DOM_ATTR = "data-ants-dom-hidden";
const LOD_DOM_INERT_ATTR = "data-ants-dom-inert";
// How long a Vue box may draw a layout read that is older than the node's own
// state. Long enough that the reads happen on a change rather than on a frame,
// short enough that a child which resized on its own comes right quickly.
const LOD_VUE_MEDIA_MS = 400;
// How many node layouts may be re-read for media in one frame. A node whose
// layout key is unchanged is re-read at most every LOD_VUE_MEDIA_MS, but on a
// heavy workflow that is still one forced layout per node per 400 ms — paid in
// the draw loop, which is the frame budget this whole tool exists to protect.
// The backstop reads are therefore rationed per frame (a node is refreshed every
// second or so on a huge graph) while a *changed* layout key is always honoured
// at once: a box whose content moved with the node is drawn wrong, and wrong is
// worse than late. Captures read unconditionally — one layout per picture is
// part of making the picture.
const LOD_VUE_MEDIA_BUDGET = 6;
// How much of a node's own rendered text one measurement may carry, and how long a
// single string may be. A node's DOM text is its widget labels and values as the
// frontend draws them; the cap keeps a node with a hundred spans (or one with a
// 40 kB string in it) from turning the read into a walk of the whole subtree.
// How much of a node a reconstruction will read and draw. These were caps chosen
// for the *cost* of a read — 16 strings and 12 widget rows per node — and on a
// real node they are what made a picture look like a sketch: the node the user
// photographed has ~30 widget rows with a label and a value each, so two thirds of
// it was never read at all. A measure happens once per capture (never per frame)
// and the read is batched, so the caps are now set where a real node ends rather
// than where the first card felt cheap.
const LOD_VUE_TEXT_MAX = 256; // strings read from a node's DOM, per measurement
const LOD_VUE_TEXT_CHARS = 400; // per string (a label is short; a caption is not)
// How long a "no video in this node" answer stands before it is re-probed. The
// guarantee it protects (a video is never photographed) is enforced freshly at
// capture time; this window is only about a *held* picture of a node that has just
// swapped a widget's element for a video.
const LOD_VUE_VIDEO_MS = 100;
// …and the same verdict when the page can *report* a video appearing (the mutation
// observer sees the element arrive): the verdict is then not a poll, it is a fact with
// a stamp, and it only has to be re-taken if the change was reported some other way.
// A <video> can only appear in a node's element by being inserted into it, and an
// insertion is a change the page reports — so on a watched page the verdict stands
// until the page says otherwise, and the stamp is only a backstop for the case where
// the observers are quiet about something they should not be.
const LOD_VUE_VIDEO_MS_WATCHED = 30000;
// The layout backstop for a node whose picture is already held. While a picture is
// what is drawn, the measurement is only needed to notice that the *element*
// changed shape (which re-makes the picture) — so it is re-read at a slower beat
// than a node whose live box is being drawn from it. A capture always reads fresh.
const LOD_VUE_MEDIA_MS_IDLE = 800;
// …and how long it stands when the browser has told the tool it can watch the node
// instead of asking about it: a resize or a change inside the element invalidates the
// measurement directly, so the periodic read is only insurance against a change no
// observer reports (an absolutely-positioned child that resizes without resizing its
// parent, a font that loads).
const LOD_VUE_MEDIA_MS_WATCHED = 5000;
// How long a Vue node's element has to stand still before the first picture of it
// is taken. A node is mounted and then *filled* — the frontend renders the header,
// the slots, the widgets and the node's own media over the frames after that, and
// an image arrives when it arrives — so a picture taken at the first opportunity
// is a picture of a node that is still being built, which is what a user described
// as "photographed too early for them to be captured fully". The window restarts
// every time the node's signature changes, so a burst of rendering costs one
// picture at the end of it instead of one picture per step. Only the Vue pathway
// waits: in the canvas renderer the node's drawing is synchronous with the frame
// the capture is taken on.
const LOD_SNAP_SETTLE_MS = 300;
// The window is a floor on lateness, never a gate that can be held shut: a node
// whose subtree is rewritten more often than the window (a running node's value,
// an extension that rewrites titles) would otherwise never be photographed at
// all. The ceiling is measured from the first change of a burst.
const LOD_SNAP_SETTLE_MAX_MS = 900;
// How long a picture that no longer matches the node may stay on screen while
// the replacement is photographed. A complete picture of a moment ago is not a
// lie the way an empty box is: on a node with one changing value the old rule —
// drop the picture the moment the node changes — made the stand-in flip between
// its picture and a plain box on every change.
const LOD_SNAP_STALE_KEEP_MS = 2000;
// A capture slower than this buys a cooldown, not a life sentence. One slow
// capture used to block the node for the session, which on a big node (and a
// CPU-only machine) means a plain box forever.
const LOD_SNAP_SLOW_COOLDOWN_MS = 10000;
const LOD_SNAP_SLOW_MAX_MS = 120000;
// A node whose pictures keep arriving already out of date is photographed less
// often, never never: the hold is what replaces the old "three drops and it is
// blocked for the session".
const LOD_SNAP_CHURN_HOLD_MS = 2000;
const LOD_INERT_CLASS = "ants-lod-inert"; // elements switched off while their node is inert
// Below this zoom nobody can read a node, let alone use one, so its UI is
// switched off rather than paid for on every pointer event.
const VIEW_INERT_ZOOMS = [0, 0.2, 0.3, 0.4, 0.5, 0.6];
// Foveated: how far outside the viewport a node must be before its DOM content is
// taken out of the picture entirely. Half a screen by default: that is enough
// margin that a node crossing it under a pan takes longer to arrive than the
// sweep takes to notice, while keeping the live set close to what is actually
// being looked at.
const VIEW_FOVEA_MARGINS = [0.25, 0.5, 1, 2]; // in viewports
const VIEW_FOVEA_MARGIN_DEFAULT = 0.5;
// How many nodes may come back to full DOM content per drawn frame. Coming back
// is the expensive direction — a wrapper returning to `display: block` re-runs
// Vue's layout pass for that widget, and a 3D viewport re-measures its renderer —
// so it is deliberately slower than going away, which is just a class. 0 means
// "all at once", for anyone who would rather have it back immediately.
const VIEW_FOVEA_RESTORES = [1, 4, 0];
// Windows display scale (100%, 150%, 200%) is readable from the browser, and the
// canvas backing store is sized in device pixels while every coordinate this file
// reasons about is in CSS pixels. Auto is the answer unless someone says
// otherwise; the panel reports what was detected rather than assuming it.
const VIEW_DISPLAY_SCALES = [0, 1, 1.25, 1.5, 2, 2.5, 3];
const VIEW_SWEEP_MS = 1000; // how often the registry of node DOM is refreshed
// What "switched off" means for a node's DOM: hidden outright, or left on screen
// with the pointer taken away from it. Hiding is the stronger one — an element
// with display:none cannot be clicked, hovered, scrolled or dragged onto whatever
// its CSS says, and a 3D viewport in it cannot be entered — so it is the default;
// inert-only is there for anyone who wants to see the widgets they cannot use.
const VIEW_FOCUS_DOM = ["hide", "inert"];
const VIEW_FOCUS_DOM_DEFAULT = "hide";
// Events that must never reach a switched-off element. Everything that starts or
// continues an interaction, and nothing that ends one: the leave/out events are
// what tell a hovered widget that the pointer is gone, so they are left alone.
const VIEW_BLOCK_EVENTS = [
  "pointerover", "pointerdown", "pointerup", "pointermove",
  "mouseover", "mouseenter", "mousedown", "mouseup", "mousemove",
  "click", "dblclick", "contextmenu", "wheel",
];
// The frontend renders every DOM widget — image previews, curve editors, and the
// Vue components behind the core 3D nodes — in this layer, one wrapper per
// widget. A wrapper is what is on screen; the widget object behind it may have no
// element to reach for at all.
const LOD_DOM_LAYER = '[data-testid="dom-widgets"]';
// Link drawing, as a setting rather than a side effect of the node threshold.
const LOD_LINK_STYLES = ["spline", "straight"];
// Settings survive a reload: they are the user's choice about their own page,
// and re-picking four dropdowns after every ComfyUI restart is not a feature.
const LOD_STORE_KEY = "ants.lowZoom.v1";

// Every decision in this file goes through one of these predicates, which is why
// the master switch is a single flag rather than a hunt for call sites: switched
// off, they all answer "no" and the page is drawn exactly as ComfyUI draws it.
function lodOn() {
  if (!S.enabled) return false;
  return LOD.flatBelow > 0 || LOD.idleCapMs > 0 || LOD.detailZoom > 0 || LOD.inertBelow > 0 || LOD.fovea || LOD.snapOn;
}

function antsEnabled() {
  return !!S.enabled;
}

// The zoom as the canvas has it *now*. LOD.zoom is the value the last drawn
// frame recorded, which is not the same thing: a setting change, or the once-a-
// second DOM sweep, can land between two frames, and a decision that read the
// stale number would do nothing until something else asked for a redraw.
function lodZoomOf(canvas) {
  try {
    const c = canvas || (typeof app !== "undefined" && app && app.canvas) || null;
    const z = c && c.ds ? Number(c.ds.scale) : NaN;
    if (Number.isFinite(z) && z > 0) return z;
  } catch (e) {
    /* fall through to the recorded zoom */
  }
  return LOD.zoom;
}

// The zoom below which a node is a stand-in. Linked (the default), that is the
// higher of the picture setting and the "widgets stop answering" setting, so a
// drag past either one still shows pictures. Unlinked, only the picture setting.
function lodPictureBelow() {
  const flat = Number(LOD.flatBelow) || 0;
  if (!LOD.linkZoom) return flat;
  return Math.max(flat, Number(LOD.inertBelow) || 0);
}

function lodFlatOn(canvas) {
  if (!S.enabled) return false;
  const below = lodPictureBelow();
  if (!(below > 0)) return false;
  const z = lodZoomOf(canvas);
  return z > 0 && z < below;
}

// Is this node painted as a rectangle right now? Exempt: a collapsed node is
// already a small box (LiteGraph draws the title only), the tool's own node so
// the panel always stays reachable, and anything at all while this frontend is
// drawing nodes as Vue DOM overlays — there LiteGraph draws no node chrome, so a
// rectangle would land *behind* the thing it is meant to replace.
function lodFlatNode(node, canvas) {
  if (!lodFlatOn(canvas)) return false;
  if (!node) return false;
  if (node.flags && node.flags.collapsed) return false;
  if (lodOwnNode(node)) return false;
  if (lodVueNodesMode()) return false;
  return true;
}

// Is node UI switched off at this zoom? Asked of the canvas currently on screen,
// like every other zoom decision here.
function viewInertOn(canvas) {
  if (!S.enabled) return false;
  if (!(LOD.inertBelow > 0)) return false;
  const z = lodZoomOf(canvas);
  return z > 0 && z < LOD.inertBelow;
}

// The canvas's own box, in CSS pixels. This is the unit every position the
// frontend reports for its DOM widgets is in (see useAbsolutePosition), and the
// unit LiteGraph's own visible-area arithmetic divides by the draw scale — so it
// is the one measurement a 200% display cannot distort. getBoundingClientRect is
// the fallback for an element that has no client box yet.
function viewCssSize(el) {
  if (!el) return null;
  const w = Number(el.clientWidth) || 0;
  const h = Number(el.clientHeight) || 0;
  if (w > 0 && h > 0) return [w, h];
  if (typeof el.getBoundingClientRect === "function") {
    try {
      const r = el.getBoundingClientRect();
      const rw = Number(r.width) || 0;
      const rh = Number(r.height) || 0;
      if (rw > 0 && rh > 0) return [rw, rh];
    } catch (e) {
      /* no box: the caller falls back to what the frontend reports */
    }
  }
  return null;
}

// Device pixels per CSS pixel, as the display-scale check sees it: the browser's
// own number unless the user pinned one in the panel.
function viewDisplayScale() {
  const manual = Number(LOD.displayScale) || 0;
  if (manual > 0) return manual;
  try {
    return Number(typeof window !== "undefined" && window.devicePixelRatio) || 1;
  } catch (e) {
    return 1;
  }
}

// The area the canvas is showing, in graph units, computed the way LiteGraph
// computes it (computeVisibleArea) but from the canvas's *CSS* box: a display at
// 200% makes the backing store twice as wide as the element, and anything that
// divides by the backing store is then twice the size it should be. When the
// frontend's own visible_area agrees with this computation it is used instead —
// it also accounts for a viewport that is not the whole element — and when the
// two disagree by more than a few percent ours is used and the panel reports the
// ratio, which is exactly the display-scale mismatch this exists to catch.
function viewViewport(canvas) {
  const ds = canvas && canvas.ds;
  if (!ds) return null;
  const scale = Number(ds.scale) || 0;
  if (!(scale > 0)) return null;
  const off = ds.offset || [0, 0];
  const ox = Number(off[0]) || 0;
  const oy = Number(off[1]) || 0;
  const el = canvas && canvas.canvas;
  const css = viewCssSize(el);
  const px = css ? css[0] : (el && Number(el.width) > 0 ? Number(el.width) / viewDisplayScale() : 0);
  const py = css ? css[1] : (el && Number(el.height) > 0 ? Number(el.height) / viewDisplayScale() : 0);
  if (!(px > 0 && py > 0)) {
    // No box to measure: the frontend's own rectangle is better than nothing.
    const va = viewReportedArea(canvas);
    return va ? { x: va[0], y: va[1], w: va[2], h: va[3], src: "reported" } : null;
  }
  const x = -ox;
  const y = -oy;
  const w = px / scale;
  const h = py / scale;
  // The frontend's own rectangles are *candidates*, never the authority: their
  // unit is not guaranteed (a 200% display is enough to change it — see
  // viewDisplayProbe), and this tool's whole job here is to not be the thing that
  // is out by that factor. Either one is used only when it agrees with the canvas
  // box within a few percent, which is also how a genuinely smaller viewport is
  // told apart from a differently-scaled one.
  const near = (n, m) => n / m > 0.95 && n / m < 1.05;
  const rect = (canvas && canvas.viewport) || null;
  if (rect && Number(rect[2]) > 0 && Number(rect[3]) > 0 && near(Number(rect[2]) / scale, w)) {
    return {
      x: -ox + (Number(rect[0]) || 0) / scale,
      y: -oy + (Number(rect[1]) || 0) / scale,
      w: Number(rect[2]) / scale,
      h: Number(rect[3]) / scale,
      src: "viewport",
    };
  }
  const va = viewReportedArea(canvas);
  if (va && near(va[2], w)) return { x: va[0], y: va[1], w: va[2], h: va[3], src: "reported" };
  return { x, y, w, h, src: "css" };
}

function viewReportedArea(canvas) {
  const va = (canvas && canvas.visible_area) || (canvas && canvas.ds && canvas.ds.visible_area) || null;
  if (!va) return null;
  const w = Number(va[2]);
  const h = Number(va[3]);
  if (!(w > 0) || !(h > 0)) return null;
  return [Number(va[0]) || 0, Number(va[1]) || 0, w, h];
}

// What the display-scale check found: the browser's ratio, the canvas backing
// store against its own CSS box, and the frontend's visible-area width against
// ours. 1.00 on the last line means the two are in the same unit. Run when the
// page starts, when the canvas is resized, and on every registry sweep.
function viewDisplayProbe(canvas, force) {
  const now = nowMs();
  let win = 1;
  try {
    win = Number(typeof window !== "undefined" && window.devicePixelRatio) || 1;
  } catch (e) {
    win = 1;
  }
  const el = canvas && canvas.canvas;
  const css = viewCssSize(el);
  const backing = el && css ? (Number(el.width) || 0) / css[0] : 0;
  const va = viewReportedArea(canvas);
  const own = viewViewport(canvas);
  const factor = own && va && own.w > 0 ? va[2] / own.w : 0;
  const manual = Number(LOD.displayScale) || 0;
  const effective = viewDisplayScale();
  const agree = factor > 0.95 && factor < 1.05;
  // A factor that is the display scale (or its reciprocal) is the mismatch this
  // check is looking for: the frontend's rectangle is in device pixels. Anything
  // else — a stale rectangle from a frame the canvas has not drawn since, or one
  // describing a viewport that is not the whole element — is named as such rather
  // than dressed up as a display problem.
  let unit = "unknown";
  if (factor) {
    if (agree) unit = "css";
    else if (effective > 0 && (Math.abs(factor - effective) < 0.05 || Math.abs(factor - 1 / effective) < 0.05)) unit = "device-pixel";
    else unit = "not-current";
  }
  // Recomputed on every call rather than cached: it runs once a second, at
  // startup and on a sweep, and a stale factor here would be a readout that lies
  // about the numbers it is there to show.
  LOD.display = {
    at: now,
    win,
    manual,
    effective: viewDisplayScale(),
    css: css ? Math.round(css[0]) : 0,
    height: css ? Math.round(css[1]) : 0,
    backing: Number(backing.toFixed(3)),
    reported: va ? Math.round(va[2]) : 0,
    ours: own ? Math.round(own.w) : 0,
    factor: Number(factor.toFixed(3)),
    // Which unit the frontend's own visible area is in, as measured here:
    // "css" when it agrees with this tool's own computation, "device-pixel"
    // when it disagrees by exactly the display scale, "not-current" when it
    // disagrees for some other reason (a stale rectangle, a sub-viewport).
    unit,
    agree,
    src: own ? own.src : "none",
  };
  return LOD.display;
}

// The area the canvas is showing, in graph units, inflated by `pad` viewports.
function viewArea(canvas, pad) {
  const vp = viewViewport(canvas);
  if (!vp) return null;
  const px = vp.w * (Number(pad) || 0);
  const py = vp.h * (Number(pad) || 0);
  return { x: vp.x - px, y: vp.y - py, w: vp.w + px * 2, h: vp.h + py * 2 };
}

// A node's rectangle in graph units, or null when it has no size yet.
function viewNodeRect(node) {
  const size = node && (node.size || node.renderingSize);
  if (!size) return null;
  return {
    x: Number(node.pos && node.pos[0]) || 0,
    y: Number(node.pos && node.pos[1]) || 0,
    w: Math.abs(Number(size[0])) || 0,
    h: Math.abs(Number(size[1])) || 0,
  };
}

// Is this node entirely outside the given area?
function viewOutsideArea(node, area) {
  const r = viewNodeRect(node);
  if (!r || !area) return false;
  return r.x + r.w < area.x || r.x > area.x + area.w || r.y + r.h < area.y || r.y > area.y + area.h;
}

// Does it overlap the area at all? Used for the one case that must never be
// delayed: an element that is on screen coming back.
function viewTouchesArea(node, area) {
  const r = viewNodeRect(node);
  if (!r || !area) return false;
  return r.x < area.x + area.w && r.x + r.w > area.x && r.y < area.y + area.h && r.y + r.h > area.y;
}

// Squared distance from the node to the area's centre, so a queue of elements
// coming back can be ordered nearest-first without a square root per node.
function viewDistance2(node, area) {
  const r = viewNodeRect(node);
  if (!r || !area) return Infinity;
  const dx = r.x + r.w / 2 - (area.x + area.w / 2);
  const dy = r.y + r.h / 2 - (area.y + area.h / 2);
  return dx * dx + dy * dy;
}

function lodDetailOn(canvas) {
  if (!S.enabled) return false;
  if (!(LOD.detailZoom > 0)) return false;
  const z = lodZoomOf(canvas);
  return z > 0 && z < LOD.detailZoom;
}

// Link shape, and nothing else. This used to have an "auto" answer that followed
// the node setting — flatten the graph and links went straight with it — which
// meant a link changed shape because a *node* setting crossed a threshold. That
// is exactly the coupling the three settings are supposed to not have, so it is
// gone: straight lines happen when the user says so, and at no other time.
function lodLinksStraight() {
  if (!S.enabled) return false;
  return LOD.linkStyle === "straight";
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

// How wide a node lands on screen, in pixels. Only reported now — what decides
// the flat state is the zoom (see LOD_FLAT_ZOOM), because a node's own UI can
// change its size while the camera stands still.
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
  // Which nodes are rectangles changes only with the zoom (and with nodes
  // arriving), so the DOM sweep runs on that change rather than every frame:
  // this stays at the cost of a zoom, not of a redraw.
  if (lodDomWanted() && LOD.zoom !== LOD.sweptZoom) {
    try {
      lodSweepDom(canvas);
    } catch (e) {
      /* never fatal */
    }
  }
  // The foveated half moves with the viewport, not with the zoom, so it runs with
  // the frame: one arithmetic pass over the registry of node DOM elements, and a
  // class written only where the answer changed. What it deliberately does *not*
  // do is re-discover the page — that is the once-a-second sweep — because
  // walking the DOM widget layer inside a pan is what made the first version of
  // this cost more than it saved.
  if ((lodOn() && lodDomWanted()) || (LOD.domOwners && LOD.domOwners.size)) {
    try {
      viewApplyFocus(canvas);
    } catch (e) {
      /* never fatal */
    }
    // The canvas calls a node's mouse hooks from its own hit-testing, and a 3D
    // viewport's render loop hangs off exactly that flag — so it is held back
    // here, per frame, with the same answer the DOM half uses.
    try {
      viewSuppressHover(canvas);
    } catch (e) {
      /* never fatal */
    }
  }
  plan.links = false;
  plan.flat = 0;
  plan.total = 0;
  plan.medPx = 0;
  if (!(LOD.flatBelow > 0)) return plan;
  const nodes = lodGraphNodes(canvas);
  if (!nodes || !nodes.length) return plan;
  const total = nodes.length;
  const stride = Math.max(1, Math.floor(total / 64)); // 64 samples is plenty for a median
  const widths = [];
  for (let i = 0; i < total; i++) {
    if (lodFlatNode(nodes[i], canvas)) plan.flat++;
    if (i % stride === 0) widths.push(lodNodePx(nodes[i], canvas));
  }
  if (widths.length) {
    widths.sort((a, b) => a - b);
    plan.medPx = Math.round(widths[widths.length >> 1]);
  }
  plan.total = total;
  // Links are whatever the link setting says, at every zoom. This is reported so
  // the readout can say which path they are on, not to decide it.
  plan.links = lodLinksStraight();
  return plan;
}

// Is a node muted, bypassed or ghosted, and by how much does the frontend dim it?
// Its own numbers, read from its own fields (getNodeModeAlpha): ghost 0.3,
// bypassed 0.2, muted 0.4. Never guessed from a colour.
function lodBoxAlpha(node) {
  try {
    if (node && node.flags && node.flags.ghost) return 0.3;
    const mode = Number(node && node.mode) || 0;
    if (mode === 4) return 0.2; // LGraphEventMode.BYPASS
    if (mode === 2) return 0.4; // LGraphEventMode.NEVER, "mute"
  } catch (e) {
    /* a node without a mode is a node in play */
  }
  return 1;
}

// The cheap stand-in for a node. The caller has already translated the context
// to the node's origin, which is why this paints at 0,0. What it may paint is the
// box-detail ladder above: the fill and the selection ring always, the title bar
// and the state marks only when the user has asked for them.
// The two marks a flat box can carry that say something *about* the node rather than
// showing a piece of it: the progress bar it is running with and the stroke it wears
// when it has errors. Both come from the node's own fields — `node.progress`, which
// the frontend's own bridge keeps current for the node object (`nodeProgressCanvasSync.ts`
// copies the execution store's progress state onto every node it adds, in both
// renderers), and `node.has_errors`, kept by `useNodeErrorFlagSync.ts`. Neither is a
// DOM read, and neither can go stale: `lodSnapLive` refuses to photograph *and*
// refuses to blit a node whose `progress` is set or which has errors, so those nodes
// are drawn as a box, every frame, from the live value. (A picture of a running node
// would carry the bar of the instant it was taken, still there after the run.)
//
// In the Vue-nodes renderer neither mark is ever needed: `lodVueFlatNode` refuses the
// same nodes `lodSnapLive` does, so a running or erroring node keeps its own element
// and the frontend draws the mark itself (its own bar, its own error ring). These are
// the canvas renderer's marks, where the box does stand for such a node.
function lodSnapStateMarks(ctx, node, spec) {
  const out = { bars: 0, errors: 0 };
  if (!ctx || !node || typeof ctx.fillRect !== "function") return out;
  const x = Number(spec && spec.x) || 0;
  const y = Number(spec && spec.y) || 0;
  const w = Number(spec && spec.w) || 0;
  const h = Number(spec && spec.h) || 0;
  if (!(w > 0) || !(h > 0)) return out;
  const scale = Math.max(0.0001, Number(spec && spec.scale) || 1);
  // A node that is running: a bar from the top-left corner, `progress` of the width
  // wide, with a CSS-pixel floor so it is still there at 10% zoom.
  const progress = Number(node.progress);
  if (Number.isFinite(progress) && progress > 0) {
    const barH = Math.min(Math.max(6, LOD_BOX_PROGRESS_PX / scale), h * LOD_BOX_TITLE_MAX);
    try {
      ctx.fillStyle = LOD_BOX_PROGRESS_COLOR;
      ctx.fillRect(x, y, w * Math.min(1, progress), barH);
      out.bars++;
    } catch (e) {
      /* a bar that cannot be filled is not a reason to drop the box */
    }
  }
  // A node with validation errors: the frontend's own stroke, at its own width and
  // padding, so the mark looks the same here as it does in full detail.
  if (node.has_errors && typeof ctx.strokeRect === "function") {
    try {
      ctx.strokeStyle = LOD_BOX_ERROR_COLOR;
      ctx.lineWidth = LOD_BOX_ERROR_WIDTH;
      ctx.strokeRect(x - LOD_BOX_ERROR_PAD, y - LOD_BOX_ERROR_PAD, w + LOD_BOX_ERROR_PAD * 2, h + LOD_BOX_ERROR_PAD * 2);
      out.errors++;
    } catch (e) {
      /* same */
    }
  }
  return out;
}

function lodPaintNode(node, canvas, ctx, content, detailOverride, sizeOverride, alphaOverride) {
  const size = sizeOverride || lodVueBoxSize(node, canvas) || (node && (node.renderingSize || node.size)) || [0, 0];
  const w = Math.abs(Number(size[0])) || 0;
  const h = Math.abs(Number(size[1])) || 0;
  const fill = node.renderingBgColor || node.bgcolor || node.renderingColor || node.color || "#4a4a4a";
  const scale = (canvas && canvas.ds && Number(canvas.ds.scale)) || 1;
  // The ladder is only ever consulted while the tool is on; switched off, nothing
  // here runs at all (the flat path is one of the predicates that answers "no").
  // `detailOverride` is the Vue-nodes picture level (see the Vue pathway below):
  // where the canvas renderer blits a photograph, this one draws the node's own
  // marks and its real content, which is the same intent by other means.
  const detail = !S.enabled ? LOD_BOX_DETAIL_DEFAULT : detailOverride || LOD.boxDetail;
  // Dimming belongs to `state`. Below it every box looks like every other box,
  // which is what v2.1.16 painted and what an off-by-default tool must keep.
  // `alphaOverride` is the *page's* composited opacity, which the canvas pathway
  // cannot see: in this renderer `LGraphNode.vue` puts the node's own opacity on the
  // element's style (the node-opacity setting, times 0.6 while it is dragged and 0.5
  // while it is muted or bypassed) and the browser composites the whole subtree with
  // it. `lodBoxAlpha` is the canvas renderer's answer to the same question (the
  // ghost/mute/bypass modes), so the two are combined by taking the lower — never
  // multiplied, which would dim a muted node twice.
  const own = detail === LOD_BOX_DETAIL[2] ? lodBoxAlpha(node) : 1;
  const wanted = Number(alphaOverride);
  const alpha = Number.isFinite(wanted) ? Math.max(0.05, Math.min(own, wanted)) : own;
  const drawable = w > 0 && h > 0;
  ctx.shadowColor = "transparent";
  ctx.globalAlpha = alpha;
  ctx.fillStyle = fill;
  ctx.fillRect(0, 0, w, h);
  // The title bar, where LiteGraph draws it: above the body, not inside it — and
  // clamped so a short node does not become nothing but title.
  const titleH = Math.min(LOD_BOX_TITLE_H, h * LOD_BOX_TITLE_MAX);
  if (drawable && detail !== LOD_BOX_DETAIL_DEFAULT) {
    if (alpha < 1) LOD.boxMuted++;
    ctx.fillStyle = node.renderingColor || node.color || fill;
    ctx.fillRect(0, -titleH, w, titleH);
    LOD.boxTitles++;
  }
  // The node's own content, where the caller has some it can honestly draw. It
  // goes on the body, under the marks: an error ring or a progress bar is about
  // the node, not part of its picture. Clipped to the node's own box — body *and*
  // title bar, because in the Vue-nodes pathway the node's title is DOM text like
  // any other and a clip on the body alone would cut it off the picture — so
  // nothing spills out of a node either way.
  if (drawable && content) {
    try {
      if (typeof ctx.save === "function") ctx.save();
      if (typeof ctx.beginPath === "function" && typeof ctx.rect === "function" && typeof ctx.clip === "function") {
        ctx.beginPath();
        ctx.rect(0, -titleH, w, h + titleH);
        ctx.clip();
      }
      content();
      if (typeof ctx.restore === "function") ctx.restore();
    } catch (e) {
      try {
        if (typeof ctx.restore === "function") ctx.restore();
      } catch (e2) {
        /* nothing left to restore */
      }
      /* content that cannot be drawn leaves the box as it was */
    }
  }
  if (drawable && detail === LOD_BOX_DETAIL[2]) {
    const marks = lodSnapStateMarks(ctx, node, { x: 0, y: 0, w, h, scale });
    LOD.boxBars += marks.bars;
    LOD.boxErrors += marks.errors;
  }
  if (node.selected) {
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = "#ffb300";
    ctx.lineWidth = 1 / scale;
    ctx.strokeRect(0, 0, w, h);
  }
  ctx.globalAlpha = 1;
}

function lodPaintLink(ctx, a, b, color) {
  ctx.beginPath();
  ctx.moveTo(a[0], a[1]);
  ctx.lineTo(b[0], b[1]);
  ctx.strokeStyle = color || "#9a9a9a";
  ctx.lineWidth = 1;
  ctx.stroke();
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
          if (!S.enabled) return;
          if (lodDomWanted()) lodSweepDom(app.canvas);
          // The snapshot store needs the same kind of heartbeat: a node deleted
          // from the graph must not keep a bitmap alive, and a theme change must
          // be noticed even on a page nobody is touching. Once a second is enough
          // for both, and it is the timer that is already running.
          if (LOD.snapOn && LOD.snaps && LOD.snaps.size) lodSnapSlice();
        } catch (e) {
          /* never fatal */
        }
      }, VIEW_SWEEP_MS)
    );
  } catch (e) {
    /* no timers: the sweep still runs whenever the zoom or the setting changes */
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
      map.set(widget, {
        had: Object.prototype.hasOwnProperty.call(opts, "hideOnZoom"),
        on: opts.hideOnZoom,
      });
      opts.hideOnZoom = true;
      return true;
    }
    if (!map.has(widget)) return false;
    const rec = map.get(widget);
    // Hand back exactly what was there: a widget that never had the option gets
    // it removed, not set to undefined.
    if (rec && rec.had) opts.hideOnZoom = rec.on;
    else delete opts.hideOnZoom;
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

// Every wrapper in the DOM widget layer, and the node it belongs to. O(wrappers
// x nodes) comparisons in plain numbers, run on a zoom change and once a second,
// not per frame. The wrapper
// is positioned at its node's origin plus the widget's offset, in client pixels
// (see the frontend's useAbsolutePosition), so the node can be found by a
// containment test in graph coordinates — no layout read per widget, and it works
// for component widgets, which have no element of their own to key on.
//
// Kept in step with the notes above: what a wrapper costs, and that this hides
// nothing itself — the per-redraw pass below writes the classes,
// from this registry, which is what keeps a pan from walking any of this.
function lodDomLayer() {
  try {
    if (typeof document === "undefined" || typeof document.querySelectorAll !== "function") return null;
    return document.querySelectorAll(LOD_DOM_LAYER)[0] || null;
  } catch (e) {
    return null;
  }
}

function viewOwnerRecord(owners, el, node, via) {
  let rec = owners.get(el);
  if (!rec) {
    // `flat` is the node-flattening setting's flag, `fovea` the off-screen one,
    // and `boxed`/`inerted` what the element is actually wearing — so a class is
    // written once per state change and never twice for the same state.
    rec = { node, via, left: NaN, top: NaN, flat: false, fovea: false, boxed: false, inerted: false };
    owners.set(el, rec);
  } else {
    if (node) rec.node = node;
    rec.via = via;
  }
  return rec;
}

// Dress one element: the class for the parts of a node (widget wrappers and the
// DOM they are built from), the attribute for a Vue node's own root, whose class
// Vue rewrites on re-render. Inert and hidden are separate marks with separate
// rules; the caller decides which one it is asking for.
function viewDress(el, rec, attr, cls, on) {
  const isRoot = !!rec && rec.via === "root";
  if (isRoot && el && typeof el.setAttribute === "function") {
    if (on) el.setAttribute(attr, "1");
    else el.removeAttribute(attr);
    return;
  }
  if (on) el.classList.add(cls);
  else el.classList.remove(cls);
}

function viewReleaseElement(el, rec) {
  try {
    if (rec && rec.boxed) viewDress(el, rec, LOD_DOM_ATTR, LOD_DOM_CLASS, false);
    if (rec && rec.inerted) viewDress(el, rec, LOD_DOM_INERT_ATTR, LOD_INERT_CLASS, false);
  } catch (e) {
    /* element is gone; dropping the record is enough */
  }
  if (rec) {
    rec.boxed = false;
    rec.inerted = false;
    rec.flat = false;
    rec.fovea = false;
  }
  if (LOD.blockSet) LOD.blockSet.delete(el);
}


// Is this element — or anything above it — this tool's own UI? The registry skips
// these outright: the switch on the node must work at 10% zoom with every setting
// on, which is exactly when everything around it is being switched off.
function viewOwnAncestor(el, maxDepth) {
  let n = el;
  let depth = 0;
  const limit = Number(maxDepth) || 16;
  while (n && depth++ < limit) {
    try {
      if (n.classList && typeof n.classList.contains === "function" && n.classList.contains(ANTS_OWN_CLASS)) return true;
    } catch (e) {
      /* an element without a classList is not ours */
    }
    n = n.parentNode;
  }
  return false;
}

// Does anything inside this element (to a shallow depth) belong to this tool?
// That is the DOM widget layer's wrapper around the pill, which the frontend
// creates after the element exists.
function viewOwnInside(el, depth) {
  if (!el || !el.children || !el.children.length) return false;
  if (depth <= 0) return false;
  for (const child of el.children) {
    try {
      if (child.classList && typeof child.classList.contains === "function" && child.classList.contains(ANTS_OWN_CLASS)) return true;
    } catch (e) {
      /* keep looking */
    }
    if (viewOwnInside(child, depth - 1)) return true;
  }
  return false;
}

function viewIsOwnDom(el) {
  if (!el) return false;
  return viewOwnAncestor(el, 16) || viewOwnInside(el, 4);
}

// Every element in the page that belongs to a node, and which node that is.
//
// Three ways in, because the frontend offers three: a widget with an element of
// its own (DOM widgets), a Vue-rendered node (the node *is* the element), and the
// wrappers in the DOM widget layer — which is where the *component* widgets live,
// the ones with no element of their own at all, and the core 3D viewports are
// component widgets. A sweep that only walked `node.widgets` could never see one.
//
// The wrappers are positioned by their own inline left/top in client pixels (see
// the frontend's useAbsolutePosition), so ownership is arithmetic, not a layout
// read — and it is cached per element, so an unchanged wrapper costs a float
// comparison. Ownership is also optional: an element whose owner cannot be worked
// out is still *switched off* when the whole graph is switched off (the focus
// zoom), because that decision does not need to know which node it is. That is
// deliberate — a page where the position arithmetic comes out wrong (a display at
// 200%, a layer inside a transformed container) must not end up with live 3D
// viewports.
function lodDomRegistrySweep(canvas) {
  const owners = LOD.domOwners || (LOD.domOwners = new Map());
  const nodes = lodGraphNodes(canvas) || [];
  if (!nodes.length) return 0;
  const seen = new Set();
  // 1. Widgets that have an element of their own: no maths at all.
  for (const node of nodes) {
    if (!node) continue;
    for (const t of lodDomTargets(node)) {
      if (!t.el || !t.el.classList) continue;
      if (viewIsOwnDom(t.el)) continue; // never ours to hide
      if (owners.has(t.el) && owners.get(t.el).via === "dom") continue; // already known, exact route
      seen.add(t.el);
      viewOwnerRecord(owners, t.el, node, "widget");
    }
  }
  // 2. Vue-rendered nodes: the node itself is the element.
  for (const el of lodDomRoots()) {
    if (!el || !el.classList) continue;
    const id = typeof el.getAttribute === "function" ? el.getAttribute("data-node-id") : null;
    if (id === null || id === undefined) continue;
    const node = lodNodeById(canvas, id);
    if (!node) continue;
    seen.add(el);
    viewOwnerRecord(owners, el, node, "root");
    (LOD.vueRoots || (LOD.vueRoots = new Map())).set(node, el);
  }
  // 3. Every wrapper in the page, wherever it is: the component widgets — the 3D
  //    viewports among them — are only ever reachable this way.
  const layer = lodDomLayer();
  let layerCount = 0;
  let wrappers = [];
  try {
    wrappers = typeof document !== "undefined" && typeof document.querySelectorAll === "function"
      ? document.querySelectorAll(".dom-widget") || []
      : [];
  } catch (e) {
    wrappers = [];
  }
  if (wrappers.length) {
    const ds = (canvas && canvas.ds) || null;
    const scale = ds ? Number(ds.scale) || 1 : 1;
    const offset = (ds && ds.offset) || [0, 0];
    const ox = Number(offset[0]) || 0;
    const oy = Number(offset[1]) || 0;
    let originX = NaN;
    let originY = NaN;
    for (const el of wrappers) {
      if (!el || !el.classList) continue;
      if (viewIsOwnDom(el)) continue; // this tool's own pill, wrapper and all
      const rec = owners.get(el);
      // Already known through an exact route: keep that, just remember the place.
      if (rec && (rec.via === "widget" || rec.via === "root")) {
        seen.add(el);
        continue;
      }
      const left = parseFloat(el.style && el.style.left);
      const top = parseFloat(el.style && el.style.top);
      const moved = !rec || rec.left !== left || rec.top !== top;
      const via = layer && el.parentNode === layer ? "layer" : "dom";
      if (!moved && rec) {
        seen.add(el);
        if (rec.via === "layer" || rec.via === "dom") layerCount++;
        continue;
      }
      // One layout read for the whole sweep, not one per widget.
      if (!Number.isFinite(originX)) {
        const canvasEl = canvas && canvas.canvas;
        try {
          const rect = canvasEl && typeof canvasEl.getBoundingClientRect === "function" ? canvasEl.getBoundingClientRect() : null;
          originX = rect ? Number(rect.left) || 0 : 0;
          originY = rect ? Number(rect.top) || 0 : 0;
        } catch (e) {
          originX = 0;
          originY = 0;
        }
      }
      let owner = null;
      if (Number.isFinite(left) && Number.isFinite(top)) {
        const gx = (left - originX) / scale - ox;
        const gy = (top - originY) / scale - oy;
        // Topmost node wins: the last one in the draw order whose rectangle
        // contains the wrapper's origin, which is the node it is drawn on top of.
        for (const node of nodes) {
          const r = viewNodeRect(node);
          if (!r) continue;
          if (gx >= r.x && gx <= r.x + r.w && gy >= r.y && gy <= r.y + r.h) owner = node;
        }
      }
      const next = viewOwnerRecord(owners, el, owner || (rec && rec.node) || null, via);
      next.left = left;
      next.top = top;
      seen.add(el);
      layerCount++;
    }
  }
  // 4. Nodes and elements that are gone: hand the element back and forget it.
  const live = new Set(nodes);
  for (const [el, rec] of [...owners]) {
    if (seen.has(el) && (!rec.node || live.has(rec.node))) continue;
    viewReleaseElement(el, rec);
    owners.delete(el);
  }
  return layerCount;
}

// The per-redraw half. Everything here is arithmetic over the registry: no
// layout reads, no graph walk, and a class is written only where the answer
// changed. That is the whole point — the expensive direction is an element
// *coming back* (a wrapper returning to `display: block` re-runs Vue's layout for
// that widget, and a 3D viewport re-measures its renderer), so coming back is
// rationed, while going away is a class on an element nobody is looking at.
function viewApplyFocus(canvas) {
  const owners = LOD.domOwners;
  const wanted = S.enabled && lodDomWanted();
  const blockSet = LOD.blockSet || (LOD.blockSet = new Set());
  if (!owners || !owners.size) {
    LOD.inertEls = 0;
    LOD.foveaEls = 0;
    LOD.foveaQueue = 0;
    return 0;
  }
  if (!wanted) {
    // Every setting is off: hand the page back, forget the registry, and let the
    // per-frame pass cost nothing at all until something is switched on again.
    let released = 0;
    for (const [el, rec] of owners) {
      viewReleaseElement(el, rec);
      released++;
    }
    owners.clear();
    blockSet.clear();
    if (LOD.domMarked) LOD.domMarked.clear();
    LOD.domHidden = 0;
    LOD.domNodes = 0;
    LOD.domLayer = 0;
    LOD.inertEls = 0;
    LOD.foveaEls = 0;
    LOD.foveaQueue = 0;
    return released;
  }
  const inertOn = viewInertOn(canvas);
  const flatOn = lodFlatOn(canvas);
  const foveaOn = !!LOD.fovea;
  const hideDom = LOD.focusDom !== "inert";
  const area = foveaOn ? viewArea(canvas, LOD.foveaMargin) : null;
  const screen = foveaOn ? viewArea(canvas, 0) : null;
  // Handed to the canvas widget gate, which is asked per pointer event and should
  // not be the thing that measures the canvas on every mousemove.
  LOD.frameAreas = { canvas, margin: area, screen };
  const back = [];
  for (const rec of owners.values()) {
    const node = rec.node;
    rec.flat = flatOn && node ? lodFlatNode(node, canvas) : false;
    if (!foveaOn || !node) {
      rec.fovea = false;
      continue;
    }
    if (viewOutsideArea(node, area)) {
      rec.fovea = true;
      continue;
    }
    if (!rec.fovea) continue;
    // It is off the far list. Anything overlapping the screen comes back this
    // instant — a blank widget in front of you is not a saving — and the rest
    // waits its turn.
    if (viewTouchesArea(node, screen)) {
      rec.fovea = false;
      LOD.foveaCameBack++;
      continue;
    }
    back.push(rec);
  }
  if (back.length) {
    const budget = Math.max(0, Math.floor(Number(LOD.foveaRestore) || 0));
    if (budget === 0 || back.length <= budget) {
      for (const rec of back) {
        rec.fovea = false;
        LOD.foveaCameBack++;
      }
    } else {
      // Nearest to the middle of the screen first: the elements the user is
      // panning towards are the ones worth spending the frame's allowance on.
      back.sort((a, b) => viewDistance2(a.node, screen) - viewDistance2(b.node, screen));
      for (let i = 0; i < budget; i++) {
        back[i].fovea = false;
        LOD.foveaCameBack++;
      }
    }
  }
  let queue = 0;
  let boxed = 0;
  let inert = 0;
  let fovea = 0;
  let layerBoxed = 0;
  let changed = 0;
  // Which nodes are drawn as rectangles right now, and how many of the hidden
  // elements came in through the DOM widget layer — the two numbers the panel
  // reports as "nodes" and "layer".
  const flatNodes = flatOn ? new Set() : null;
  const marked = LOD.domMarked || (LOD.domMarked = new Set());
  for (const [el, rec] of owners) {
    // Everything this tool switches off is a *part of a node* — its widgets and
    // the DOM they are built from — never the node's own selectable body. With
    // the canvas gates answering "no widget" and the hover hooks held back, a node
    // at any zoom still selects, drags, edits and opens its menu. Vue-rendered
    // nodes are the exception to the exception: there the node *is* the element,
    // so it is left alone entirely — switching it off would be switching the node
    // off, and the widget-level gates are what cover that rendering mode.
    const own = rec.node && lodOwnNode(rec.node);
    const widgetish = rec.via !== "root" && !own && !viewOwnAncestor(el, 8);
    const wantBox = rec.flat || rec.fovea || (inertOn && hideDom && widgetish);
    const wantInert = rec.fovea || (inertOn && widgetish);
    if (wantBox !== rec.boxed || wantInert !== rec.inerted) {
      try {
        if (wantBox !== rec.boxed) {
          viewDress(el, rec, LOD_DOM_ATTR, LOD_DOM_CLASS, wantBox);
          rec.boxed = wantBox;
        }
        if (wantInert !== rec.inerted) {
          viewDress(el, rec, LOD_DOM_INERT_ATTR, LOD_INERT_CLASS, wantInert);
          rec.inerted = wantInert;
        }
        changed++;
      } catch (e) {
        /* an element that cannot be dressed is pruned by the next sweep */
      }
    }
    if (rec.boxed || rec.inerted) blockSet.add(el);
    else blockSet.delete(el);
    if (rec.boxed) {
      boxed++;
      if (rec.via === "layer" || rec.via === "dom") layerBoxed++;
      marked.add(el);
    } else {
      marked.delete(el);
    }
    if (rec.inerted) inert++;
    if (rec.fovea) {
      fovea++;
      queue++;
    }
    if (flatNodes && rec.flat) flatNodes.add(rec.node);
  }
  LOD.domNodes = flatNodes ? flatNodes.size : 0;
  LOD.domLayer = layerBoxed;
  LOD.domHidden = boxed;
  LOD.inertEls = inert;
  LOD.foveaEls = fovea;
  LOD.foveaQueue = queue;
  return changed;
}

// The per-redraw half. Everything here is arithmetic over the registry: no
// layout reads, no graph walk, and a class is written only where the answer
// changed. That is the whole point — the expensive direction is an element
// *coming back* (a wrapper returning to `display: block` re-runs Vue's layout for
// that widget, and a 3D viewport re-measures its renderer), so coming back is
// rationed, while going away is a class on an element nobody is looking at.

// ------------------------------------------------------------ the event gate ---
// The last resort, and the only part of this that does not depend on the page's
// CSS or on Vue leaving our classes alone. While an element is switched off, the
// events that would start or continue an interaction *with it* are stopped in the
// capture phase, before any handler anywhere can see them. Nobody else's code has
// to cooperate: a click, a drag, a wheel tick or a pointer enter aimed at a
// switched-off widget is swallowed, counted, and the panel says how many.
//
// It is deliberately blind to everything else — the canvas, the panels, links,
// groups, our own UI — because against those it does nothing at all: the test is
// a set lookup on the target's ancestors, and the set is empty whenever nothing is
// switched off.
function viewEventBlocked(target) {
  const set = LOD.blockSet;
  if (!set || !set.size || !target) return false;
  let el = target;
  let depth = 0;
  while (el && el !== document && depth++ < 64) {
    if (el.nodeType === 1 && set.has(el)) return true;
    el = el.parentNode;
  }
  return false;
}

function viewGateEvent(ev) {
  try {
    if (!ev || !ev.target || ev.target.nodeType !== 1) return;
    if (!viewEventBlocked(ev.target)) return;
    LOD.eventsBlocked++;
    ev.stopPropagation();
    if (ev.cancelable !== false && typeof ev.preventDefault === "function") ev.preventDefault();
  } catch (e) {
    /* an event that cannot be inspected is left alone */
  }
}

let viewEventGateOn = false;

function viewInstallEventGate() {
  if (!S.enabled) return false;
  if (viewEventGateOn || !(LOD.inertBelow > 0 || LOD.fovea)) return viewEventGateOn;
  if (typeof document === "undefined" || typeof document.addEventListener !== "function") return false;
  for (const type of VIEW_BLOCK_EVENTS) {
    try {
      document.addEventListener(type, viewGateEvent, true);
    } catch (e) {
      /* one missing event type is not a reason to skip the rest */
    }
  }
  viewEventGateOn = true;
  return true;
}

// What the page's own computed style says about an element this tool believes it
// has switched off. This is the honest half of the claim: a class can be written
// and then wiped by a framework's re-render, and a panel that only counts what it
// wrote would be describing its own intentions rather than the page. Run on the
// once-a-second sweep, on a sample, because it is a style read.
function viewVerifyMarked(limit) {
  const set = LOD.blockSet;
  if (!set || !set.size) {
    LOD.domVerified = 0;
    LOD.domBroken = 0;
    return 0;
  }
  if (typeof getComputedStyle !== "function") return 0;
  let ok = 0;
  let broken = 0;
  let n = 0;
  const max = Number(limit) || 5;
  for (const el of set) {
    if (n++ >= max) break;
    try {
      const cs = getComputedStyle(el);
      if (!cs) continue;
      if (cs.display === "none" || cs.pointerEvents === "none") ok++;
      else broken++;
    } catch (e) {
      /* an element without a style: not counted either way */
    }
  }
  LOD.domVerified = ok;
  LOD.domBroken = broken;
  return ok;
}

// ------------------------------------------------------------ the node UI ---
// The pill on this tool's own node: [ switch ][ gear ]. Round, drawn in the same
// line as the tool's own colours, and marked .ants-own so that no part of the
// low-zoom machinery can hide, inert or gate it — a switch that disappears exactly
// when the graph is zoomed out would be useless.
const ANTS_ACCENT = "#AE7719";
const ANTS_SWITCH_FILL = "#0D2A2A"; // the checked interior
const ANTS_GLYPH_LINE = 1.5; // one line weight for the gear, the ring and the check

const ANTS_WIDGETS = new Set(); // sync functions, one per live node

// One glyph box for both controls, and one unit is one CSS pixel: the button is
// 22px square with a 1.5px ring drawn *inside* it (box-sizing: border-box), so the
// ring's centre line is at r = (22 - 1.5) / 2 = 10.25. The gear is drawn on that
// same circle, in the same 1.5px line — the two controls are the same size and the
// same weight because the geometry makes them so, not because two numbers were
// picked to look alike.
const ANTS_GLYPH_BOX = 22; // px, and the viewBox, so 1 unit = 1px
const ANTS_GLYPH_R = 10.25; // the switch ring's centre line, and the gear's tips
function antsSvg(inner, extraClass) {
  const svg = document.createElementNS ? document.createElementNS("http://www.w3.org/2000/svg", "svg") : null;
  if (!svg) return null;
  svg.setAttribute("viewBox", `0 0 ${ANTS_GLYPH_BOX} ${ANTS_GLYPH_BOX}`);
  svg.setAttribute("width", String(ANTS_GLYPH_BOX));
  svg.setAttribute("height", String(ANTS_GLYPH_BOX));
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", ANTS_ACCENT);
  svg.setAttribute("stroke-width", String(ANTS_GLYPH_LINE));
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  if (extraClass) svg.setAttribute("class", extraClass);
  svg.innerHTML = inner;
  return svg;
}

// A gearbox drawn as a silhouette: eight teeth around a ring, in the accent.
function antsGearSvg() {
  const c = ANTS_GLYPH_BOX / 2;
  const body = ANTS_GLYPH_R - 1.9;
  const teeth = [];
  for (let i = 0; i < 8; i++) {
    // Offset by half a tooth so the silhouette has a tooth straight up, and the
    // teeth straddle the ring the switch draws.
    const a = (i / 8) * Math.PI * 2 + Math.PI / 8;
    const x0 = c + Math.cos(a) * body;
    const y0 = c + Math.sin(a) * body;
    const x1 = c + Math.cos(a) * ANTS_GLYPH_R;
    const y1 = c + Math.sin(a) * ANTS_GLYPH_R;
    teeth.push(`<line x1="${x0.toFixed(2)}" y1="${y0.toFixed(2)}" x2="${x1.toFixed(2)}" y2="${y1.toFixed(2)}"/>`);
  }
  // The teeth, then the body they sit on, then the hub.
  return antsSvg(`<circle cx="${c}" cy="${c}" r="${body.toFixed(2)}"/>${teeth.join("")}<circle cx="${c}" cy="${c}" r="3"/>`);
}

function antsCheckSvg() {
  // Sized to the interior of the ring, so the checkmark is drawn inside the switch
  // rather than across it, and clear of the ring's own line.
  return antsSvg('<path d="M6.6 11.2 L9.7 14.2 L15.4 7.9"/>');
}

// A drag on a pill must not also count as a click on what the drag started on:
// the floating pill is draggable, so the tick has to know when a press turned
// into a move. The flag is set by the drag wiring below and read here.
function antsClickSuppressed(el) {
  let n = el;
  let depth = 0;
  while (n && depth++ < 8) {
    if (n._antsSuppressClick) {
      n._antsSuppressClick = false;
      return true;
    }
    n = n.parentNode;
  }
  return false;
}

// The switch, as it appears on both pills. One piece of code, so the node's tick
// and the floating one cannot drift apart — they are the same control, wired to
// the same master switch.
function antsBuildTick(pill) {
  const tick = el("button", { class: "ants-node-btn ants-node-btn-tick", type: "button" });
  tick.setAttribute("role", "checkbox");
  const glyph = antsCheckSvg();
  if (glyph) tick.appendChild(glyph);

  // The switch says what it is plainly: it is not "pause the numbers", it is
  // "stop the hooks and the optimisations" — the numbers stop moving because
  // nothing is being measured any more.
  const sync = () => {
    const on = antsEnabled();
    tick.setAttribute("aria-checked", on ? "true" : "false");
    tick.style.background = on ? ANTS_SWITCH_FILL : "transparent"; // no fill of ours while unchecked
    tick.style.borderColor = ANTS_ACCENT;
    tick.title = on
      ? "Tracker is ON. Click to switch the hooks and the optimisations off: nothing wrapped, nothing sampled, no scheduler deferrals, no " +
        "redraw cap, no low-zoom drawing, no DOM touched. Your settings are kept."
      : "Tracker is OFF. Hooks and optimisations are off. Click to switch them back on with the settings you had.";
  };
  sync();
  ANTS_WIDGETS.add(sync);

  tick.addEventListener("click", (ev) => {
    try {
      ev.stopPropagation();
    } catch (e) {
      /* the click still counts */
    }
    if (antsClickSuppressed(tick)) return; // that press was a drag of the pill
    antsSetEnabled(!antsEnabled());
  });
  return tick;
}

// The one element the frontend positions for this widget. Everything the switch
// does happens inside it, and nothing outside this tool knows it exists.
function buildAntsNodeWidget() {
  const pill = el("div", { class: `ants-node-pill ${ANTS_OWN_CLASS}` });
  pill.title = "ANTs Frontend Optimizer — the switch on the left turns the hooks and the optimisations off, the gear opens the separate window";

  const tick = antsBuildTick(pill);
  const gear = el("button", { class: "ants-node-btn ants-node-btn-gear", type: "button" });

  // The switch first, the gear after — the order the frame draws them in.
  pill.appendChild(tick);
  pill.appendChild(gear);
  const gearGlyph = antsGearSvg();
  if (gearGlyph) gear.appendChild(gearGlyph);

  gear.addEventListener("click", (ev) => {
    try {
      ev.stopPropagation();
    } catch (e) {
      /* the click still counts */
    }
    antsOpenFromGear();
  });
  // Presses and drags on the pill are ours: letting them through would start a
  // node drag when someone meant to flip the switch.
  for (const type of ["pointerdown", "mousedown", "pointerup", "wheel", "contextmenu"]) {
    pill.addEventListener(type, (ev) => {
      const target = ev.target;
      if (target && target.tagName === "BUTTON") {
        try {
          ev.stopPropagation();
        } catch (e) {
          /* nothing to stop */
        }
      }
    });
  }
  return pill;
}

// The graph node was sized to the pill and, on some frontends, only allowed to
// grow on one axis. A free minimum and a computeSize that does not shrink a
// size the user already set is what both axes need. Vue node mode may ignore a
// LiteGraph `resizable` flag; the floating panel's own grip does not depend on it.
function antsUnlockNode(node) {
  try {
    node.resizable = true;
    const prev = node.computeSize;
    node.computeSize = function (out) {
      let base = [220, 48];
      try {
        if (typeof prev === "function") {
          const got = prev.apply(this, arguments);
          if (got && got.length >= 2) base = [Number(got[0]) || base[0], Number(got[1]) || base[1]];
        }
      } catch (e) {
        /* the floor stands */
      }
      const cur = this.size || base;
      const w = Math.max(180, base[0] || 0, Number(cur[0]) || 0);
      const h = Math.max(36, base[1] || 0, Number(cur[1]) || 0);
      if (out && out.length >= 2) {
        out[0] = w;
        out[1] = h;
        return out;
      }
      return [w, h];
    };
    if (typeof node.addDOMWidget === "function" && !node._antsHost) {
      const host = document.createElement("div");
      host.className = "ants-own ants-node-host";
      host.style.width = "100%";
      host.style.minHeight = "0";
      const widget = node.addDOMWidget("ants_host", "ants-ui", host, {
        serialize: false,
        hideOnZoom: false,
      });
      if (widget) {
        widget.computeLayoutSize = () => ({ minWidth: 180, minHeight: 0, maxWidth: 4096, maxHeight: 4096 });
      }
      node._antsHost = host;
    }
    const prevResize = node.onResize;
    node.onResize = function (size) {
      let ret;
      try {
        if (typeof prevResize === "function") ret = prevResize.apply(this, arguments);
      } catch (e) {
        /* the reflow still runs */
      }
      antsReflowNode(this, size);
      return ret;
    };
  } catch (e) {
    /* the floating panel still resizes on its own grip */
  }
}

function antsReflowNode(node, size) {
  try {
    buildPanel();
    const host = node && node._antsHost;
    if (!host || !ui.panel) return;
    const w = (size && Number(size[0])) || (node.size && Number(node.size[0])) || 0;
    const h = (size && Number(size[1])) || (node.size && Number(node.size[1])) || 0;
    if (w >= 280 && h >= 160) {
      host.appendChild(ui.panel);
      ui.panel.classList.add("open");
      ui.panel.classList.add("ants-docked");
      ui.panel.classList.remove("ants-popped");
      ui.panel.style.width = "100%";
      ui.panel.style.height = `${Math.max(160, Math.round(h - 28))}px`;
      ui.docked = node;
      return;
    }
    if (ui.docked === node) {
      ui.docked = null;
      ui.panel.classList.remove("ants-docked");
      ui.panel.style.width = "";
      ui.panel.style.height = "";
      document.body.appendChild(ui.panel);
    }
  } catch (e) {
    /* docking is optional; the grip on the floating panel still works */
  }
}

// Attaching the pill to a node, through whichever API this frontend version has.
function antsAttachNodeWidget(node) {
  const pill = buildAntsNodeWidget();
  try {
    if (typeof node.addDOMWidget === "function") {
      const widget = node.addDOMWidget("ants_controls", "ants-ui", pill, {
        serialize: false,
        hideOnZoom: false, // the frontend's own LOD must not take the switch away
        selectOn: [], // clicking the switch is not "select this node"
      });
      if (widget) return pill;
    }
  } catch (e) {
    /* the fallback below is a canvas button, which is worse but not nothing */
  }
  try {
    node.addWidget("button", "Open Tracker", null, () => antsOpenFromGear());
  } catch (e) {
    /* a node with no widget API at all: the corner button is the only UI left */
  }
  return null;
}

// ------------------------------------------------------- the master switch ---
// The checkbox on this tool's own node. Off means the page is ComfyUI's own
// again: every predicate above answers "no", the scheduler hands calls straight
// through, no sample is recorded, no redraw is capped, and every element this
// tool dressed is handed back. The *settings* are not touched — switching back on
// restores exactly what was there, which is the difference between this and the
// individual toggles.

const ANTS_OWN_CLASS = "ants-own";

// Everything this tool has changed about the page, undone: classes removed, the
// `hideOnZoom` flags it flipped put back, the gates' sets emptied. Deliberately
// blunt — it is the path that has to be right, not the one that has to be quick.
function antsReleasePage() {
  let released = 0;
  try {
    const owners = LOD.domOwners;
    if (owners) {
      for (const [el, rec] of owners) {
        viewReleaseElement(el, rec);
        released++;
      }
      owners.clear();
    }
    if (LOD.domMarked) LOD.domMarked.clear();
    if (LOD.blockSet) LOD.blockSet.clear();
    if (LOD.domWidgets && LOD.domWidgets.size) {
      for (const w of [...LOD.domWidgets.keys()]) lodStillWidget(w, false);
    }
    LOD.hoverOff = null;
    LOD.frameAreas = null;
    LOD.domHidden = 0;
    LOD.domNodes = 0;
    LOD.domLayer = 0;
    LOD.inertEls = 0;
    LOD.foveaEls = 0;
    LOD.foveaQueue = 0;
    LOD.blockedSet = null;
  } catch (e) {
    /* the release is best-effort by nature: a page that throws here is a page
       whose elements are already gone */
  }
  return released;
}

function antsSyncWidgets() {
  for (const sync of ANTS_WIDGETS) {
    try {
      sync();
    } catch (e) {
      /* a node can be gone at any moment */
    }
  }
}

function antsSetEnabled(on) {
  const next = !!on;
  if (next === !!S.enabled) return antsEnabled();
  S.enabled = next;
  if (!next) {
    antsReleasePage();
    // The page gets the drawing back, and the browser gets the memory back: a
    // stored bitmap is only useful to a tool that is running, and switching on
    // again recaptures on the next idle lane.
    if (LOD.snapOn) lodSnapClear("master switch");
    lodVueUnblankAll("tool off");
    // Nothing of this tool's own UI goes away: the floating pill carries the
    // switch that turns it back on, and closing the panel under someone who is
    // reading it would be its own small bug. The page is what gets handed back.
    console.info(
      "[ANTs Tracker] Switched off: no hooks wrapped, nothing sampled, no scheduler deferrals, no redraw cap, no low-zoom drawing, no DOM " +
        "touched. The switch on the floating button (and the panel's own On button) switches it back on with the settings you had."
    );
  } else {
    try {
      if (lodDomWanted()) {
        lodInstallDomSweep();
        lodSweepDom(app.canvas);
      }
      viewInstallWidgetGate();
      viewInstallEventGate();
    } catch (e) {
      /* never fatal */
    }
    console.info("[ANTs Tracker] Switched back on: the settings that were in force are in force again.");
  }
  antsSyncWidgets();
  // The banner and the header button have to say what happened before anyone
  // looks at them again — and an open panel is left open, showing them.
  try {
    if (ui.built) {
      renderSummary();
      if (ui.panel && ui.panel.classList.contains("open")) updateActiveTab();
    }
  } catch (e) {
    /* never fatal */
  }
  if (!antsUiSilent) antsUiPublishSettings();
  return antsEnabled();
}

// ------------------------------------------------------- the canvas widgets ---
// Not every widget is a DOM element. In this frontend a slider, a combo, a text
// box or a button is drawn *on the canvas* and hit-tested by arithmetic:
// `LGraphNode.getWidgetOnPos(x, y)` walks the node's widgets and returns the one
// whose rectangle contains the point. It is asked on mousedown (so the widget can
// be clicked or dragged), on mousemove (so hover reports and tooltips can be
// built) and by the canvas's own helper for the wheel. No CSS class can reach any
// of that, which is why a page can have every node's DOM switched off and still
// have every widget answering the pointer.
//
// It is also the one gate that can be closed without taking the node with it:
// `processMouseDown` asks for a widget *first* and only then falls through to
// dragging the node, and mousemove asks for the widget under the cursor to build
// its hover report. Answering "no widget" therefore means: the thing drawn on the
// node cannot be grabbed or reported on, while the node itself still selects,
// drags, opens its menu and edits exactly as before.
//
// The tracker's own node is exempt — its buttons are the panel's own controls.
function viewWidgetsOff(node, canvas) {
  if (!S.enabled) return false;
  if (!node) return false;
  if (lodOwnNode(node)) return false;
  const c = canvas || (typeof app !== "undefined" && app && app.canvas) || null;
  if (viewInertOn(c)) return true;
  if (!LOD.fovea) return false;
  // The areas the frame pass already worked out for this drawn frame, so a
  // mousemove does not measure the canvas again: this is asked per pointer event.
  const areas = LOD.frameAreas;
  const area = areas && areas.canvas === c ? areas.margin : viewArea(c, LOD.foveaMargin);
  return viewOutsideArea(node, area);
}

function viewWrapGetWidgetOnPos(proto) {
  if (!proto || typeof proto.getWidgetOnPos !== "function") return false;
  if (proto.getWidgetOnPos.__antsWidgetGate) return true;
  const original = proto.getWidgetOnPos;
  const gated = function (x, y, ...rest) {
    if (viewWidgetsOff(this)) {
      LOD.canvasWidgetHits++;
      LOD.canvasWidgetsBlocked++;
      return undefined;
    }
    return original.call(this, x, y, ...rest);
  };
  gated.__antsWidgetGate = true;
  gated.__antsOriginal = original;
  try {
    proto.getWidgetOnPos = gated;
  } catch (e) {
    return false;
  }
  return true;
}

// Where the method lives is found rather than assumed: the global LiteGraph, or
// the prototype chain of any node the graph is holding (nodes from extensions are
// subclasses, and they all inherit this one method).
function viewInstallWidgetGate(canvas) {
  if (!S.enabled || !(LOD.inertBelow > 0 || LOD.fovea)) return false;
  let ok = false;
  try {
    const g = typeof window !== "undefined" && window.LiteGraph;
    if (g && g.LGraphNode && g.LGraphNode.prototype) ok = viewWrapGetWidgetOnPos(g.LGraphNode.prototype) || ok;
  } catch (e) {
    /* no global LiteGraph: the node's own prototype is next */
  }
  try {
    const nodes = lodGraphNodes(canvas || (typeof app !== "undefined" && app && app.canvas));
    for (const node of nodes || []) {
      let proto = node && Object.getPrototypeOf(node);
      let depth = 0;
      while (proto && proto !== Object.prototype && depth++ < 8) {
        if (typeof proto.getWidgetOnPos === "function") {
          ok = viewWrapGetWidgetOnPos(proto) || ok;
          break;
        }
        proto = Object.getPrototypeOf(proto);
      }
    }
  } catch (e) {
    /* without the gate widgets stay live: the mode is smaller, not broken */
  }
  return ok;
}

// ---------------------------------------------------------- node hover hooks ---
// A 3D viewport decides whether to render by asking whether the pointer is over
// it, and that answer comes from the *node's* mouse hooks — `node.onMouseEnter` /
// `onMouseLeave`, chained by the extension when the node is created — which the
// canvas calls from its own hit-testing, not from the DOM. So switching the DOM
// off cannot stop it: the canvas still walks over the node, still calls the hook,
// and the render loop still runs a Three.js frame per rAF tick for a viewport
// nobody can see.
//
// The hooks are wrapped per node, and while the node's widgets are off the enter
// and move calls are held back. `onMouseLeave` is deliberately *not* held back: it
// is what clears the flag, so it must always be allowed through — and when a node
// goes off while the pointer is already on it, the leave is called by this code so
// the flag cannot stay stuck on.
const VIEW_HOVER_HOOKS = ["onMouseEnter", "onMouseMove"];

function viewWrapNodeHover(node) {
  if (!node) return false;
  let wrapped = false;
  for (const hook of VIEW_HOVER_HOOKS) {
    const current = node[hook];
    if (typeof current !== "function") continue;
    if (current.__antsHoverGate) continue; // already ours
    const gated = function (...args) {
      if (viewWidgetsOff(this)) {
        LOD.hoverBlocked++;
        // The canvas has already recorded the node as hovered by the time it calls
        // this hook, and a widget that is switched off is not hovered. Clearing the
        // bookkeeping here keeps the two in step: without it the node would stay
        // marked as "mouse over" while the page says the pointer is not on it, and
        // the next real hover would be read as a continuation of the old one.
        try {
          this.mouseOver = null;
          const c = (typeof app !== "undefined" && app && app.canvas) || null;
          if (c && c.node_over === this) c.node_over = undefined;
        } catch (e) {
          /* bookkeeping is a courtesy; the hook is the point */
        }
        return undefined;
      }
      return current.apply(this, args);
    };
    gated.__antsHoverGate = true;
    gated.__antsOriginal = current;
    try {
      node[hook] = gated;
      wrapped = true;
    } catch (e) {
      /* a frozen node keeps its hooks; it simply stays as it was */
    }
  }
  return wrapped;
}

// Called per drawn frame: wrap what needs wrapping (cheap — the flag is on the
// function), and force a leave on any node that has just been switched off while
// the pointer was sitting on it.
function viewSuppressHover(canvas) {
  if (!S.enabled || !(LOD.inertBelow > 0 || LOD.fovea)) return 0;
  const c = canvas || (typeof app !== "undefined" && app && app.canvas) || null;
  const nodes = lodGraphNodes(c) || [];
  const off = LOD.hoverOff || (LOD.hoverOff = new Set());
  let held = 0;
  for (const node of nodes) {
    if (!node) continue;
    const isOff = viewWidgetsOff(node, c);
    if (!isOff) {
      off.delete(node);
      continue;
    }
    viewWrapNodeHover(node);
    held++;
    if (off.has(node)) continue;
    off.add(node);
    // It was live a moment ago. If the pointer is on it, tell it the pointer is
    // gone: for a 3D viewport that single call is the difference between a render
    // loop that keeps ticking and one that stops.
    try {
      const hovered = (c && c.node_over === node) || node.mouseOver;
      if (hovered) {
        if (typeof node.onMouseLeave === "function") node.onMouseLeave(null);
        node.mouseOver = null;
        if (c && c.node_over === node) c.node_over = undefined;
      }
    } catch (e) {
      /* an extension's leave hook that throws is not worth breaking a frame for */
    }
  }
  return held;
}

// Node hit-testing is the frontend's own O(visible nodes) walk — every pointer
// move asks "which node is under the cursor", backwards through the draw order,
// calling isPointInside until one says yes. Below the focus zoom nobody can see
// what they would be clicking, so the walk is answered with "nothing" instead:
// no hover, no tooltip, no node drag, no selection — and no per-move cost.
// The tracker's own node is exempt even here, so the panel stays reachable.


// Gated wherever the frontend keeps it: the graph class is the seam the canvas
// actually calls (LGraphCanvas does `graph.getNodeOnPos(...)` at event time, so
// a prototype patch takes effect immediately), and the live graph instance is
// patched too, because a subgraph is a different class.

// The DOM half of focus mode. Everything that answers the pointer lives in the
// DOM widget layer and the Vue node roots: a class that says "not now" is enough
// to stop hover reporting, tooltips, click handlers, drag-and-drop targets and
// wheel capture — and, for a 3D viewport, to stop it deciding to render.

function lodSweepDom(canvas) {
  let nodes = 0;
  // The node-flattening half: widgets that asked the frontend to skip them while
  // zoomed out (`hideOnZoom`) are still flagged on a zoom change, because that is
  // the flag the frontend's own widget store consults. What is *hidden* is now one
  // decision for every element in the registry — see viewApplyFocus — so a widget
  // never has two owners fighting over its class.
  try {
    if (canvas && lodFlatOn(canvas)) {
      for (const node of lodGraphNodes(canvas) || []) {
        if (!lodFlatNode(node, canvas)) continue;
        let any = false;
        for (const t of lodDomTargets(node)) {
          lodStillWidget(t.widget, true); // returns true only when it changed something
          any = true;
        }
        if (any) nodes++;
      }
    }
  } catch (e) {
    /* hiding DOM is a courtesy: if the page's DOM is not what we expect, skip it */
  }
  // The way back for those flags: while the zoom is below the setting every node
  // is a box, so every widget we touched is still one and stays touched. Above
  // it, all of them go back to asking for their own placement on the next drawn
  // frame. (Deciding this from the zoom rather than from each widget's node is
  // also what makes it work for widgets that carry no `node` back reference —
  // the component widgets the core 3D nodes are built from.)
  if (LOD.domWidgets && LOD.domWidgets.size && !lodFlatOn(canvas)) {
    for (const w of [...LOD.domWidgets.keys()]) lodStillWidget(w, false);
  }
  // Who owns which element — including the DOM widget layer, which is the only
  // route to the component widgets (the 3D viewports) — and then what that means
  // right now.
  try {
    lodDomRegistrySweep(canvas);
  } catch (e) {
    /* never fatal */
  }
  let changed = 0;
  try {
    changed = viewApplyFocus(canvas);
  } catch (e) {
    /* never fatal */
  }
  try {
    viewDisplayProbe(canvas, false);
  } catch (e) {
    /* the check is a report, not a dependency */
  }
  // Both gates and the seam they are installed on are re-checked here: a graph
  // instance can be swapped, node classes arrive with packs, and an extension can
  // re-chain a node's hooks after this tool last looked.
  try {
    viewInstallWidgetGate(canvas);
    viewInstallEventGate();
  } catch (e) {
    /* never fatal */
  }
  try {
    viewVerifyMarked(5);
  } catch (e) {
    /* the check is a report, not a dependency */
  }
  LOD.domMarkedWidgets = LOD.domWidgets ? LOD.domWidgets.size : 0;
  // The flag only hides anything while the frontend is drawing in its own
  // low-quality mode (its DOM widget layer checks `hideOnZoom && lowQuality`),
  // so that — and not the count of widgets we flagged — is what is out of the
  // per-frame widget pass.
  LOD.domStilled = lodFrontendLowQuality(canvas) ? LOD.domMarkedWidgets : 0;
  LOD.sweptZoom = LOD.zoom;
  LOD.sweptKey = lodFlatOn(canvas) ? "flat" : "full";
  return changed > 0;
}

// The redraw cap. A hard cap would make dragging feel broken, so it is only in
// force while nobody has touched the page for a moment; any pointer, wheel or
// key event lifts it instantly (the scheduler layer already watches for those).
function lodDrawCapMs(t) {
  if (!S.enabled) return 0;
  if (LOD.idleCapMs > 0 && !govInputRecently(t, LOD_IDLE_INPUT_MS)) return LOD.idleCapMs;
  return drawThrottleMs > 0 ? drawThrottleMs : 0;
}

function lodSaveSettings() {
  try {
    if (typeof localStorage === "undefined" || !localStorage) return;
    localStorage.setItem(
      LOD_STORE_KEY,
      JSON.stringify({
        flatBelow: LOD.flatBelow,
        boxDetail: LOD.boxDetail,
        snapshots: !!LOD.snapOn,
        snapRatio: LOD.snapRatio,
        snapMb: LOD.snapMb,
        snapExclude: LOD.snapExclude.slice(),
        detailZoom: LOD.detailZoom,
        thumbZoom: 0,
        diskOn: !!LOD.diskOn,
        linkZoom: !!LOD.linkZoom,
        idleCapMs: LOD.idleCapMs,
        linkStyle: LOD.linkStyle,
        inertBelow: LOD.inertBelow,
        fovea: !!LOD.fovea,
        focusDom: LOD.focusDom,
        foveaMargin: LOD.foveaMargin,
        foveaRestore: LOD.foveaRestore,
        displayScale: LOD.displayScale,
      })
    );
  } catch (e) {
    /* a browser with storage switched off just does not remember */
  }
  if (!antsUiSilent) antsUiPublishSettings();
}

// Called once at startup, before the panel is built, so the selects show what is
// actually in effect. Nothing is enabled that the user did not enable: this
// restores their own last choice, and an untouched install has nothing saved.
// A v1 record held "nodes under Npx". The rule is a zoom now, so the old number
// is translated once — divided by the width of a typical node — and the panel
// says so until the user picks a value themselves.
function lodZoomForPx(px) {
  const want = Number(px) / LOD_TYPICAL_NODE_PX;
  for (const z of LOD_FLAT_ZOOM) if (z > 0 && z >= want) return z;
  return LOD_FLAT_ZOOM[LOD_FLAT_ZOOM.length - 1];
}

function lodLoadSettings() {
  try {
    if (typeof localStorage === "undefined" || !localStorage) return false;
    const raw = localStorage.getItem(LOD_STORE_KEY);
    if (!raw) return false;
    const saved = JSON.parse(raw);
    if (!saved || typeof saved !== "object") return false;
    const legacyPx = saved.flatBelow === undefined ? Number(saved.minPx) || 0 : 0;
    const linkZoom = saved.linkZoom === undefined ? true : !!saved.linkZoom;
    let flatBelow = saved.flatBelow === undefined
      ? (legacyPx > 0 ? lodZoomForPx(legacyPx) : 0.5)
      : Number(saved.flatBelow) || 0;
    let inertBelow = saved.inertBelow === undefined ? 0 : Number(saved.inertBelow) || 0;
    // Missing key means the new default: the higher threshold wins, and the two
    // dropdowns agree. An explicit false is left alone.
    if (linkZoom) {
      const z = Math.max(flatBelow, inertBelow);
      flatBelow = z;
      inertBelow = z;
    }
    lodSet({
      flatBelow,
      legacyPx,
      boxDetail: saved.boxDetail === undefined ? LOD_BOX_DETAIL_DEFAULT : String(saved.boxDetail),
      snapshots: saved.snapshots === undefined ? true : !!saved.snapshots,
      snapRatio: saved.snapRatio === undefined ? LOD_SNAP_RATIO_DEFAULT : Number(saved.snapRatio) || 1,
      snapMb: saved.snapMb === undefined ? LOD_SNAP_BUDGET_DEFAULT : Number(saved.snapMb) || 0,
      snapExclude: Array.isArray(saved.snapExclude) ? saved.snapExclude : [],
      detailZoom: saved.detailZoom === undefined ? 0 : Number(saved.detailZoom) || 0,
      thumbZoom: 0, // the drawImage ladder is retired; a saved value is not brought back
      diskOn: saved.diskOn === undefined ? true : !!saved.diskOn,
      idleCapMs: Number(saved.idleCapMs) || 0,
      // Anything that is not an explicit "straight" means curves. A v2.1.9
      // "auto" record becomes "spline" and raises the note above.
      linkStyle: saved.linkStyle === "straight" ? "straight" : "spline",
      linkZoom,
      inertBelow,
      fovea: !!saved.fovea,
      focusDom: saved.focusDom === undefined ? VIEW_FOCUS_DOM_DEFAULT : String(saved.focusDom),
      foveaMargin: saved.foveaMargin === undefined ? VIEW_FOVEA_MARGIN_DEFAULT : Number(saved.foveaMargin) || 0,
      foveaRestore: saved.foveaRestore === undefined ? VIEW_FOVEA_RESTORES[0] : Number(saved.foveaRestore) || 0,
      displayScale: saved.displayScale === undefined ? 0 : Number(saved.displayScale) || 0,
      autoLinkCarried: saved.linkStyle === "auto",
    });
    return true;
  } catch (e) {
    return false;
  }
}

// Per-node-type render cost: what the Nodes tab's table is built from. In the
// canvas renderer that is LiteGraph's own drawing; in the Vue-nodes renderer it
// is the frontend's own per-node layout pass (it draws no chrome there), which is
// why the readout names the renderer next to the table.
function lodNoteNodeDraw(node, t0, dt) {
  if (S.paused) return;
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

function lodAbort(err) {
  LOD.error = (err && err.message) || String(err);
  LOD.flatBelow = 0;
  LOD.idleCapMs = 0;
  LOD.detailZoom = 0;
  LOD.baseline = null;
  try {
    lodSweepDom(app.canvas);
    lodVueUnblankAll("error");
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
    linkMsPerFrame: S.frameLinkStage.aggregate(from).sum / n,
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

// Does the link setting actually buy anything on this page? Ink is only part of
// what the connections stage costs — the frontend walks every input slot of
// every node before it decides which links are on screen — so the honest way to
// answer it is to alternate the setting and compare the same page against
// itself, rather than to guess from a before/after pair taken minutes apart.
const LOD_AB_ROUNDS = 3; // on/off pairs
const LOD_AB_PHASE_MS = 1200;
const LOD_AB_MIN_FRAMES = 3; // below this the comparison is not worth printing

function lodAbStart() {
  LOD.ab = {
    phase: 0, // 0 = thinning on, 1 = thinning off
    rounds: LOD_AB_ROUNDS,
    last: nowMs(),
    on: { ms: 0, frames: 0 },
    off: { ms: 0, frames: 0 },
    saved: LOD.detailZoom,
    text: `measuring: ${LOD_AB_ROUNDS} second(s) of each, one after the other\u2026`,
  };
  lodAbApply();
  return LOD.ab;
}

function lodAbApply() {
  // The setting is moved directly, not through lodSet: nothing here should be
  // saved to storage or count as a user change. The "on" half is thinning below
  // every zoom, so the comparison is the setting at its strongest — a threshold
  // the user's own zoom happens to sit above would measure nothing.
  LOD.detailZoom = LOD.ab.phase === 0 ? 1 : 0;
}

function lodAbStop(text) {
  const ab = LOD.ab;
  if (!ab) return;
  LOD.detailZoom = ab.saved;
  ab.text = text;
  ab.done = true;
  lodSaveSettings();
}

// One call per drawn frame, with that frame's own connections time: the two
// phases are measured from the same code path, on the same page, seconds apart.
function lodAbFrame(connMs) {
  const ab = LOD.ab;
  if (!ab || ab.done) return;
  const t = nowMs();
  const bucket = ab.phase === 0 ? ab.on : ab.off;
  bucket.ms += Math.max(0, Number(connMs) || 0);
  bucket.frames++;
  if (t - ab.last < LOD_AB_PHASE_MS) return;
  ab.last = t;
  ab.phase = (ab.phase + 1) % 2;
  if (ab.phase === 0) {
    ab.rounds--;
    if (ab.rounds <= 0) {
      const onAvg = ab.on.frames ? ab.on.ms / ab.on.frames : 0;
      const offAvg = ab.off.frames ? ab.off.ms / ab.off.frames : 0;
      const delta = offAvg - onAvg;
      const pct = offAvg > 0 ? (delta / offAvg) * 100 : 0;
      const enough = ab.on.frames >= LOD_AB_MIN_FRAMES && ab.off.frames >= LOD_AB_MIN_FRAMES;
      lodAbStop(
        enough
          ? `thinning measured on this page: links ${fmtMs(onAvg, 1)} ms/frame thinned below 100% vs ${fmtMs(offAvg, 1)} ms/frame in full ink ` +
            `(${ab.on.frames}/${ab.off.frames} frames) \u2014 ${delta >= 0 ? "saves" : "costs"} ${fmtMs(Math.abs(delta), 1)} ms/frame ` +
            `(${Math.abs(pct).toFixed(0)}% of the connections stage)`
          : `not enough frames to compare (${ab.on.frames} thinned, ${ab.off.frames} full) \u2014 draw or pan the graph for a moment and try again`
      );
      return;
    }
  }
  lodAbApply();
}

function lodSet(opts) {
  const o = opts || {};
  const was = lodOn();
  if ("flatBelow" in o) {
    const prevFlat = LOD.flatBelow;
    const z = Math.max(0, Math.min(1, Number(o.flatBelow) || 0));
    // Snap to the ladder: a value that is not on it came from somewhere else
    // (a saved record, a script), and the panel has to agree with the state.
    LOD.flatBelow = z === 0 ? 0 : LOD_FLAT_ZOOM.reduce((best, v) => (Math.abs(v - z) < Math.abs(best - z) ? v : best), LOD_FLAT_ZOOM[0]) || z;
    if (o.legacyPx === undefined) LOD.legacyPx = 0; // the user has chosen; drop the note
    // No boxes, nothing for a snapshot to replace: release them rather than hold
    // memory for pictures nothing is asking for.
    if (prevFlat > 0 && LOD.flatBelow === 0 && LOD.snapOn) lodSnapClear("threshold off");
  }
  if ("legacyPx" in o) LOD.legacyPx = Math.max(0, Number(o.legacyPx) || 0);
  // What a flat box may say about the node it stands for. Anything not on the
  // ladder falls back to the plain box, which is the do-nothing value.
  if ("boxDetail" in o) {
    const level = String(o.boxDetail);
    LOD.boxDetail = LOD_BOX_DETAIL.includes(level) ? level : LOD_BOX_DETAIL_DEFAULT;
  }
  // Node snapshots. Turning it off releases every stored bitmap — "off restores
  // the previous page" includes the memory it was holding.
  if ("snapshots" in o) {
    const on = !!o.snapshots;
    if (!on && LOD.snapOn) lodSnapClear("off");
    LOD.snapOn = on;
    if (!on) lodSnapCancel();
  }
  if ("snapRatio" in o) {
    const prevRatio = LOD.snapRatio;
    const r = Number(o.snapRatio) || LOD_SNAP_RATIO_DEFAULT;
    // Snapped to the ladder so the panel and the state cannot disagree.
    LOD.snapRatio = LOD_SNAP_RATIOS.reduce((best, v) => (Math.abs(v - r) < Math.abs(best - r) ? v : best), LOD_SNAP_RATIOS[0]);
    // A new ratio makes every stored picture a lie. The window posts the ratio
    // through the same call the panel uses, so the clear lives here, not only
    // on the panel's change handler.
    if (LOD.snapOn && LOD.snapRatio !== prevRatio) lodSnapClear("ratio");
  }
  if ("snapMb" in o) {
    const mb = Number(o.snapMb) || LOD_SNAP_BUDGET_DEFAULT;
    // Snapped to the ladder, so the panel and the state cannot disagree about a
    // number the user is looking at. Anything below the smallest step becomes it.
    LOD.snapMb = LOD_SNAP_BUDGETS.reduce((best, v) => (Math.abs(v - mb) < Math.abs(best - mb) ? v : best), LOD_SNAP_BUDGETS[0]);
    // A budget the user has just picked takes effect now, in-use bitmaps included:
    // they asked for the number. (Captures then stop until something goes cold,
    // which is the stable outcome.) The clamp above is the ladder's own floor: a
    // saved or scripted value below 256 MiB lands on 256.
    lodSnapEvict(true);
  }
  if ("snapExclude" in o) {
    const list = Array.isArray(o.snapExclude) ? o.snapExclude : [];
    const next = list.map((t) => String(t)).filter(Boolean).slice(0, LOD_SNAP_TYPES_MAX);
    const prev = LOD.snapExclude || [];
    const changed = next.join("\u0000") !== prev.join("\u0000");
    LOD.snapExclude = next;
    // A type just added to the list has to stop being served from a picture now,
    // not whenever its next capture happens: a control that appears to do
    // nothing is worse than no control. Only the newly excluded types' records
    // are dropped, so adding one type does not recapture the rest of the graph —
    // and their nodes count as "kept live on purpose", not as failed captures.
    if (changed && LOD.snaps && LOD.snaps.size) {
      for (const t of next) {
        if (prev.indexOf(t) >= 0) continue;
        for (const node of [...LOD.snaps.keys()]) {
          const type = String((node && (node.type || node.comfyClass)) || "");
          if (type === t) lodSnapDrop(node, `kept live by your list (${t})`);
        }
      }
    }
  }
  if ("autoLinkCarried" in o) LOD.autoLinkCarried = !!o.autoLinkCarried;
  // v1 and v2.1.8 scripts passed a pixel width. Kept working: translated.
  if ("minPx" in o) {
    const px = Math.max(0, Number(o.minPx) || 0);
    LOD.flatBelow = px > 0 ? lodZoomForPx(px) : 0;
  }
  if ("idleCapMs" in o) LOD.idleCapMs = Math.max(0, Number(o.idleCapMs) || 0);
  if ("thumbZoom" in o) {
    // Retired in v2.5.0. The node picture is the thumbnail. A scripted value is
    // ignored so the old drawImage substitution cannot come back on.
    LOD.thumbZoom = 0;
  }
  if ("diskOn" in o) LOD.diskOn = !!o.diskOn;
  if ("detailZoom" in o) LOD.detailZoom = Math.max(0, Math.min(1, Number(o.detailZoom) || 0));
  if ("inertBelow" in o) {
    const z = Math.max(0, Math.min(1, Number(o.inertBelow) || 0));
    LOD.inertBelow = z === 0 ? 0 : VIEW_INERT_ZOOMS.reduce((best, v) => (Math.abs(v - z) < Math.abs(best - z) ? v : best), VIEW_INERT_ZOOMS[0]) || z;
  }
  if ("fovea" in o) LOD.fovea = !!o.fovea;
  if ("linkZoom" in o) LOD.linkZoom = !!o.linkZoom;
  // A focus setting changing is exactly when a node can go from "hovered" to
  // "switched off", so the record of which nodes are already held back is dropped
  // and the next drawn frame re-evaluates them — which is what forces the leave
  // on whichever node the pointer happens to be sitting on.
  if ("inertBelow" in o || "fovea" in o) LOD.hoverOff = null;
  if ("foveaMargin" in o) {
    const m = Math.max(0, Math.min(4, Number(o.foveaMargin) || 0));
    // Snapped to the ladder, so the panel and the state cannot disagree.
    LOD.foveaMargin = VIEW_FOVEA_MARGINS.reduce((best, v) => (Math.abs(v - m) < Math.abs(best - m) ? v : best), VIEW_FOVEA_MARGIN_DEFAULT);
  }
  if ("foveaRestore" in o) {
    const r = Math.max(0, Math.floor(Number(o.foveaRestore) || 0));
    LOD.foveaRestore = VIEW_FOVEA_RESTORES.includes(r) ? r : VIEW_FOVEA_RESTORES[0];
  }
  if ("displayScale" in o) {
    const d = Number(o.displayScale) || 0;
    LOD.displayScale = VIEW_DISPLAY_SCALES.includes(d) ? d : 0;
    LOD.display = null; // the check re-runs with the new ratio
  }
  if ("focusDom" in o) {
    const m = String(o.focusDom);
    LOD.focusDom = VIEW_FOCUS_DOM.includes(m) ? m : VIEW_FOCUS_DOM_DEFAULT;
  }
  if ("linkStyle" in o) {
    const style = String(o.linkStyle);
    // "auto" from v2.1.9 and earlier meant "follow the node setting", which is
    // exactly the coupling being removed: it becomes curves, and a note says
    // what happened.
    if (style === "auto") {
      LOD.linkStyle = "spline";
      if (o.autoLinkCarried === undefined) LOD.autoLinkCarried = true;
    } else {
      LOD.linkStyle = LOD_LINK_STYLES.includes(style) ? style : "spline";
      if (o.autoLinkCarried === undefined) LOD.autoLinkCarried = false;
    }
  }
  if (LOD.flatBelow > 0 || LOD.inertBelow > 0 || LOD.fovea || LOD.snapOn) lodInstallDomSweep();
  if (LOD.inertBelow > 0 || LOD.fovea || LOD.flatBelow > 0) {
    // The canvas-side gate and the event gate are both inert until something is
    // switched on, and both are needed the moment it is.
    viewInstallWidgetGate();
    viewInstallEventGate();
  }
  const now = lodOn();
  if (now) LOD.error = "";
  // The first change is the moment worth measuring from, whether or not the mode
  // was already on (stand-in pictures are on by default).
  if (now && !LOD.baseline) lodCaptureBaseline();
  if (!now && was) LOD.baseline = null;
  if (LOD.idleCapMs > 0 || LOD.snapOn) govInstallInputGuard();
  // A threshold change has to take effect now, not on the next frame the canvas
  // happens to draw: the marks follow the setting, whatever the zoom is.
  try {
    lodSweepDom(app.canvas);
    lodVueUnblankAll("setting");
    // ... and the hover half immediately, not on the next drawn frame: a redraw
    // can be merged by the idle cap, and until one is drawn a 3D viewport whose
    // node has just been switched off would keep its "pointer is over me" flag.
    viewSuppressHover(app.canvas);
  } catch (e) {
    /* the sweep never throws, but setup is not worth a broken toggle */
  }
  // Remembered across sessions (see LOD_STORE_KEY). The change is already in
  // effect by now, so a storage that refuses to save cannot take it back.
  lodSaveSettings();
  return now;
}

// (The frame-level low-quality borrow that used to live here is gone. Setting the
// canvas's low-quality flag for a frame is not a link setting: it changes how
// every *node* is painted (no shadows, no rounded corners) and it is the same
// flag the frontend consults before placing widgets that asked to hide when
// zoomed out. On a page whose zoom sits below the thinning threshold, that is
// "nodes look half-flattened all the time" — reported from a real page, and the
// right answer is that a link setting may only change link ink.)

// ComfyUI has its own level-of-detail switch: `LiteGraph.Canvas.MinFontSizeForLOD`
// (Settings -> LiteGraph, default 8px, and 0 switches its LOD off entirely),
// which flips `canvas.low_quality` on below a zoom threshold and then only skips
// shadows and rounded corners. Worth showing next to ours, because "my frames are
// still slow with LOD on" is a fair question and the answer is that this LOD
// changes shapes, not how many nodes get drawn.
function lodFrontendLowQuality(canvas) {
  try {
    const c = canvas || (typeof app !== "undefined" && app && app.canvas) || null;
    return !!(c && (c.low_quality || c._isLowQuality));
  } catch (e) {
    return false;
  }
}

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
    const nodes = lodGraphNodes(c);
    if (!c || !nodes || !nodes.length) return null;
    const ds = c.ds || {};
    const scale = Number(ds.scale) || 1;
    // The area the canvas is showing, from the same source as every other
    // decision in this file: the draw state and the canvas's own *CSS* box. The
    // backing store is sized in device pixels, so on a display at 200% anything
    // that divides by it is twice the size it should be — and the frontend's own
    // visible area is only as fresh as the last frame it drew.
    const area = viewArea(c, 0);
    let x0;
    let y0;
    let x1;
    let y1;
    if (area) {
      x0 = area.x;
      y0 = area.y;
      x1 = area.x + area.w;
      y1 = area.y + area.h;
    } else {
      const va = ds.visible_area;
      if (!va || !(Number(va[2]) > 0)) return null;
      x0 = Number(va[0]) || 0;
      y0 = Number(va[1]) || 0;
      x1 = x0 + Number(va[2]);
      y1 = y0 + Number(va[3]);
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
      // The master switch is off: this is a plain draw call. No cap, no
      // scheduling, no bookkeeping — not even the cheap kind.
      const capMs = S.enabled ? lodDrawCapMs(t0) : 0;
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
      // A drawn frame is the clock the snapshot store keeps time by: a bitmap is
      // "in use" while its node is being drawn, and only a frame can say that.
      if (S.enabled && LOD.snapOn) LOD.snapFrame++;
      curNodeStageMs = 0;
      curConnStageMs = 0;
      curLinkStageMs = 0;
      curAttrMs = 0;
      // Whoever is inside this draw is on the display lane: a source that draws
      // is a source whose skipped ticks the user can see (see GOV_DISPLAY_FLOOR_MS).
      const drawOwner = GOV.running;
      if (drawOwner && !drawOwner.ours) {
        if (!drawOwner.display) drawOwner.display = true;
        drawOwner.drew = (drawOwner.drew || 0) + 1;
      }
      // The plan also carries the zoom: focus, the fovea and the picture decision
      // all read it even when no node is being flattened.
      if (S.enabled && lodOn()) lodPlanFrame(this);
      lodVueFramePlan(this);
      drawDepth++;
      let ret;
      try {
        ret = originalDraw.apply(this, args);
      } finally {
        drawDepth--;
        const dt = performance.now() - t0;
        S.counters.framesTotal++;
        if (S.enabled && !S.paused) {
          S.frames.push(t0, dt);
          S.frameAttr.push(t0, curAttrMs);
          S.frameNodeStage.push(t0, curNodeStageMs);
          S.frameConnStage.push(t0, curConnStageMs);
          S.frameLinkStage.push(t0, curLinkStageMs);
          lodAbFrame(curConnStageMs);
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
      if (ctx && lodFlatNode(node, this)) {
        const lt0 = performance.now();
        let snapped = false;
        try {
          this.current_node = node;
          // A stored bitmap of this node, if one can be trusted right now — the
          // box below is the fallback, never the other way round.
          if (lodSnapOn(this)) {
            try {
              snapped = lodSnapPaint(node, this, ctx);
            } catch (err) {
              // The reuse path runs on every drawn node: a fault here is not
              // something to keep retrying. Hand the boxes back and say why.
              lodSnapAbort(`reuse failed (${err && err.message ? err.message : String(err)})`);
              snapped = false;
            }
            lodSnapNoteMode(node, snapped ? "snap" : "box");
          }
          if (!snapped) lodPaintNode(node, this, ctx);
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
        // Either way this node is one a picture would be worth having for: ask the
        // idle lane for one (a no-op once it has a bitmap).
        if (!snapped) lodSnapEnqueue(node, this);
        return undefined;
      }
      // The Vue-nodes pathway. LiteGraph still calls this for every visible node
      // in this renderer — it keeps slot metrics in sync and returns before
      // drawing any chrome — so the box lands exactly where a picture lands in
      // the canvas renderer. The frontend's own draw runs first because its
      // `arrange()` is what the box's geometry reads afterwards.
      if (ctx && lodVueFlatNode(node, this)) {
        const tv = performance.now();
        const retV = originalDrawNode.call(this, node, ctx, ...rest);
        const dtv = performance.now() - tv;
        lodNoteNodeDraw(node, tv, dtv);
        if (lodVueBlank(node, true)) {
          // A stored picture first: it is the box plus the node's content, frozen
          // when it was made, and one blit is cheaper than redrawing the content
          // on every frame — which is the whole point of the picture.
          let drew = false;
          if (lodSnapBitmaps(this)) {
            try {
              this.current_node = node;
              drew = lodSnapPaint(node, this, ctx);
            } catch (err) {
              lodSnapAbort(`reuse failed (${err && err.message ? err.message : String(err)})`);
              drew = false;
            }
          }
          if (drew) {
            LOD.nodes++;
            LOD.ms += dtv;
            if (!S.paused) curNodeStageMs += dtv;
          } else {
            try {
              this.current_node = node;
              // The stand-in setting is "picture of the node": with no picture
              // yet, that is the state-level box (title bar, error ring, progress,
              // dimming) with the node's own content drawn into it — the same
              // thing the capture will freeze and this box draws live until then.
              // With the setting off, the box ladder the user chose is drawn
              // exactly as documented, no content.
              const picture = !!LOD.snapOn;
              // The page's own composited opacity, from the cached measurement (a
              // read, never a per-frame measurement): the live box and the picture it
              // becomes have to be the same node.
              const meta = LOD.vueMedia ? LOD.vueMedia.get(node) : null;
              lodPaintNode(node, this, ctx, picture ? () => lodVueBoxContent(node, this, ctx) : null, picture ? LOD_BOX_DETAIL[2] : null, null, meta ? meta.opacity : undefined);
              LOD.vueBoxes++;
              LOD.nodes++;
              LOD.ms += dtv;
              if (!S.paused) curNodeStageMs += dtv;
            } catch (err) {
              lodVueBlank(node, false); // its own drawing comes back
              lodAbort(err);
            }
          }
          // Ask the idle lane for a picture either way: a no-op once one exists.
          lodSnapEnqueue(node, this);
        }
        return retV;
      }
      const t0 = performance.now();
      const ret = originalDrawNode.call(this, node, ctx, ...rest);
      const dt = performance.now() - t0;
      lodNoteNodeDraw(node, t0, dt);
      return ret;
    };
    wrappedDrawNode.__antsWrapped = true;
    proto.drawNode = wrappedDrawNode;
    // A capture must draw the node, not this file's wrapper around it: the wrapper
    // counts frame draws and frames, and a capture is neither. This is the seam.
    lodSnapOriginalDrawNode = originalDrawNode;
    lodSnapInstalled = true;
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
      if (!ctx || !a || !b) return originalRenderLink.apply(this, args);
      // Every call is timed, whichever path it takes. The difference between
      // this total and the whole connections stage is the part of the link cost
      // no ink setting can reach: the frontend walking every input slot of every
      // node in the graph before it decides a link is even on screen.
      const lr0 = performance.now();
      let ret;
      try {
        if (lodLinksStraight()) {
          lodPaintLink(ctx, a, b, args[6] || (link && link.color) || null);
          LOD.links++;
          return undefined;
        }
        // Told to keep the curves but draw them cheaply. What costs pixels is
        // the width of the stroke and the dark outline drawn under it (a second
        // stroke 4 units wider, so on a long link the outline is most of the
        // ink). Both live on the canvas object, so they are set for this one
        // call and put straight back — hit-testing, dragging and the panel never
        // see them.
        if (lodDetailOn(this) && LOD.linkStyle !== "straight") {
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
            ret = originalRenderLink.apply(this, args);
            LOD.thinLinks++;
            return ret;
          } finally {
            if (restore) restore();
          }
        }
        return originalRenderLink.apply(this, args);
      } catch (err) {
        lodAbort(err);
        return originalRenderLink.apply(this, args);
      } finally {
        const dt = performance.now() - lr0;
        LOD.linkMs += dt;
        LOD.linkCalls++;
        if (!S.paused) curLinkStageMs += dt;
      }
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

  // The drawImage thumbnail ladder was retired in v2.5.0. The picture of the node
  // is the thumbnail, and it replaces the node. Wrapping every drawImage on the
  // page was the second system doing the same job.

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

// -------------------------------------------------------- node snapshots ---
// The engine the whole block above was built towards: a flat box that is a
// picture of the node it stands for. Read LOD_SNAP_* and the note next to them
// first — the design, what it deliberately does differently from upstream
// (ComfyUI-NodeSnapshots), and what is provisional.
//
// The lifecycle of one bitmap:
//   draw (flat path)      a node is painted as a box, and put in the queue
//   idle slice            the governor's lane, under the panel's own budget:
//                         the node is drawn into an offscreen canvas once
//   later draws           one drawImage from that canvas instead of the box
//   any doubt             the node changes, is selected, hovered, broken or
//                         running, or the capture was slow: back to the box,
//                         and the bitmap is dropped or never made
//   the budget fills      the least recently used bitmap is released
// Every decision is a field read (selection, hover, error, progress, drag): the
// expensive check — the signature — is rationed to once per LOD_SNAP_SIG_MS per
// node, which is the one staleness window this design accepts and states.

// The two module-level seams the installer fills in. `original` is the unwrapped
// drawNode, so a capture cannot re-enter this file's own wrapper and be counted
// as a frame draw; `installed` says whether the canvas seams are in place at all.
let lodSnapOriginalDrawNode = null;
let lodSnapInstalled = false;

function lodSnapOn(canvas) {
  if (!S.enabled) return false;
  if (!LOD.snapOn) return false;
  // A snapshot replaces a flat *box*. With nothing being flattened there is
  // nothing for it to replace, and no node's appearance changes because of this
  // setting: the flatten threshold stays the only thing that decides that.
  if (!lodFlatOn(canvas)) return false;
  return true;
}

// Which of the two stand-in pathways this page gets. Read from the frontend's own
// flag on every call, never latched, so switching renderers takes effect on the
// same page: "canvas" — a picture of the node, blitted where the canvas would have
// drawn it; "vue" — the node's own element blanked and the same box painted by the
// canvas in its place; "off" — the tool, the setting, or the zoom is above it.
function lodSnapPathway(canvas) {
  if (!lodSnapOn(canvas)) return "off";
  return lodVueNodesMode() ? "vue" : "canvas";
}

// Are stored pictures wanted, and useful, on this page? Both renderers, for the
// same reason and by different means: a picture is what stands in for a node
// below the threshold. In the canvas renderer it is a photograph of the node the
// canvas draws; in the Vue-nodes renderer the canvas draws no node, so the tool
// draws the box and the node's own content into the capture itself
// (lodVueCapturePaint) — the same surface, the same mips, the same disk files,
// the same budget. What cannot be had there is a screenshot of the node's *chrome*
// (no browser API draws a DOM element into a canvas), and the readout says so.
function lodSnapBitmaps(canvas) {
  return lodSnapOn(canvas);
}

// Does the DOM half of the drawing settings have anything to do on this page?
// The focus half (widgets stop answering, the fovea) acts on DOM elements. The
// stand-in half now needs the registry in *both* renderers: the canvas renderer
// hides a node's widgets under its box, and the Vue-nodes renderer blanks the
// node's own element — and both have to know which element belongs to which node.
function lodDomWanted() {
  if (LOD.inertBelow > 0 || LOD.fovea) return true;
  return LOD.flatBelow > 0;
}

// Is this node one that must be drawn by ComfyUI, right now? Every answer here is
// a field the frontend maintains itself. Anything uncertain answers "live": a
// stale picture is a worse failure than a slow frame.
function lodSnapLive(node, canvas) {
  try {
    if (!node) return true;
    // Hover is not live, and neither is selection or a node drag. Those used to
    // drop a pictured node back to a painted box. The picture stays, and it moves
    // with the node. A selected node gets a ring on top of it (see the blit).
    // A link drag, a running bar and an error still draw live. The node stays
    // clickable either way.
    if (node.has_errors) return true; // the error stroke is live state
    if (Number(node.progress) > 0) return true; // a running node draws a bar
    // A video widget is never a still picture, however idle the graph is.
    if (lodSnapHasVideo(node)) return true;
    const c = canvas || null;
    if (c) {
      if (c.connecting_node) return true; // a link is being dragged from a node
      const lc = c.linkConnector;
      if (lc && lc.renderLinks && lc.renderLinks.length) return true;
      if (lc && lc.isConnecting) return true;
    }
  } catch (e) {
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// The Vue-nodes pathway (Nodes 2.0). The canvas renderer replaces a box the
// canvas would have drawn with a picture of the node. This renderer has no such
// box: the node *is* a DOM element (`[data-node-id]`, positioned inside the
// frontend's transform pane) and `LGraphCanvas.drawNode()` returns before drawing
// any chrome. So the stand-in is made of the two things that do exist:
//
//   1. the element is marked — an attribute, and with it two `!important` rules —
//      so the browser stops painting that node's DOM. The node's *children* are
//      `visibility: hidden`, which is the one property an engine honours by
//      skipping a subtree in the paint phase; the node's own box keeps its place
//      (and is transparent), so it is still hit-testable — selecting and dragging
//      a node are bound on the root and never look at `event.target` — and the
//      slot dots are the one thing inside left live, because that is where a link
//      drag starts. The element
//      itself stays in the page, in the layout and in the frontend's own
//      observers: only the painting is taken away. (v2.6.0–v2.6.5 used
//      `opacity: 0` alone, which takes nothing away — the subtree is still
//      painted — and that is why the stand-ins could cost performance here.)
//   2. the canvas paints the same box the canvas renderer would paint, in the
//      same place and with the same detail ladder — LiteGraph still calls
//      `drawNode` for every visible node in this renderer (to keep slot metrics
//      in sync), so this tool's existing seam fires with the context already in
//      node-local space.
//
// What a box carries here is not a photograph (a DOM node cannot be drawn into a
// bitmap — no browser API does it, and the canvas renderer's capture works only
// because LiteGraph itself draws the node) but the node's own content, drawn
// live from two sources, because a node's content reaches the page by two routes:
//
//   * widgets that carry their own element (a prompt's textarea, a pack's
//     component widget) are mounted into the node's DOM by the frontend's
//     WidgetDOM.vue, and their row geometry is the frontend's own rule;
//   * everything the node renders itself — the frontend's ImagePreview.vue puts
//     the node's pictures in <img> elements inside the node, and a custom node
//     may render a <canvas> — is found by walking the node's element and drawn at
//     the position the browser laid it out in, which the stand-in mark keeps
//     readable: visibility takes the painting away, never the layout (a hidden
//     element still answers `getBoundingClientRect`, and every observer still
//     reports it).
//
// The second route is why this exists at all: the legacy image preview *widget*
// is canvas-drawn (`surfaces: { canvas: 'shown', vueNode: 'never' }`), so in this
// renderer it is mounted nowhere and the canvas draws no widget — the images in
// the node's DOM are the only copy on the page. Text fields were never affected
// (they are widget-borne), which is exactly why text stood-ins worked first. The offscreen half — the stored pictures, the capture resolution and
// the disk cache — belongs to the canvas renderer and is reported idle here.
// What the mark is worth: this *is* the saving, and it is the reason the mark is
// `visibility` rather than `opacity`. In this renderer the node's drawing is the
// browser's own DOM painting — with hardware acceleration off, on the CPU — so a
// stand-in that leaves the node painted adds cost without removing any. A hidden
// subtree is skipped in the paint phase, so what a frame at low zoom has to
// rasterise becomes the canvas blits and nothing else, while the element stays in
// the DOM, in layout and in every observer, which is where all the tool's numbers
// come from. See LIMITS for what is and is not measurable about it from here.
// Is the Vue stand-in pathway doing anything this frame? **One answer, asked in
// one place.** The draw loop asks it of every node it draws; the frame plan asks
// it once for the whole set of blanked elements. The two disagreeing is not a
// subtle bug on a live page — it is nodes flickering: the last time they did
// (v2.6.0–v2.6.3, the plan demanded the *picture* setting while the draw loop only
// needed the zoom) a non-picture stand-in mode handed every element back at the top
// of every frame, the draw loop blanked them again and painted the boxes, and any
// frame where the frontend rendered between the two showed the node in full.
function lodVuePathOn(canvas) {
  return !!(lodVueNodesMode() && lodFlatOn(canvas));
}

function lodVueFlatNode(node, canvas) {
  if (!lodVuePathOn(canvas)) return false;
  if (!node) return false;
  if (node.flags && node.flags.collapsed) return false; // already a small box
  if (lodOwnNode(node)) return false; // the panel has to stay reachable
  // A node whose state is live keeps its own element, and with it every mark the
  // frontend draws about that state: its progress bar, its error stroke and the
  // outline it puts around the node that is executing. That is why a Vue stand-in
  // never has to say anything about a run — it is never used while one is on.
  if (lodSnapLive(node, canvas)) return false; // running, erroring, dragging, video
  return true;
}

// The element the frontend renders a node into. Read from the registry the DOM
// sweep keeps (`data-node-id`), with a direct lookup the first time a node is
// blanked and a re-lookup when the frontend rebuilds the element.
function lodVueRootEl(node) {
  try {
    const cache = LOD.vueRoots || (LOD.vueRoots = new Map());
    const hit = cache.get(node);
    if (hit && (hit.isConnected === undefined || hit.isConnected)) return hit;
    const id = node && node.id;
    if (id === undefined || id === null) return null;
    if (typeof document === "undefined" || typeof document.querySelector !== "function") return null;
    // The node the user sees is a child of the frontend's transform pane. Asked
    // for that one first: `[data-node-id]` also appears on a drag preview, and a
    // blanking (or a box) landing on the wrong element is a node that looks live
    // while a box sits behind it.
    const sel = '[data-node-id="' + String(id).replace(/"/g, "") + '"]';
    let el = null;
    try {
      const pane = document.querySelector('[data-testid="transform-pane"]');
      if (pane && typeof pane.querySelector === "function") el = pane.querySelector(sel);
    } catch (e) {
      el = null;
    }
    if (!el) el = document.querySelector(sel);
    if (el) cache.set(node, el);
    else cache.delete(node);
    return el || null;
  } catch (e) {
    return null;
  }
}

// Blank (or hand back) one node's element. Answers whether a box may be painted:
// a box stands in for an element this tool has really blanked, never for one it
// could not reach — a box over a node that is still drawing itself would be two
// pictures of the same node.
function lodVueBlank(node, on) {
  const els = LOD.vueEls || (LOD.vueEls = new Map()); // the element each node was dressed on
  let el = lodVueRootEl(node);
  if (!el && !on) {
    // Handing back. The element may have been unmounted rather than hidden — a
    // re-render, or the frontend switching renderers (`GraphCanvas.vue` renders
    // the whole pane with `v-if`). The mark still has to come off it: an element
    // the frontend puts back on the page would come back invisible, and nothing
    // would ever lift it. The lookup cache cannot answer this — it drops an
    // element the moment it leaves the page — so the element the tool last
    // dressed is kept for exactly this.
    el = els.get(node) || null;
  }
  const set = LOD.vueFlat || (LOD.vueFlat = new Set());
  if (!el || typeof el.setAttribute !== "function") {
    set.delete(node);
    // Nothing of this node is on screen any more: the layout read it left behind
    // goes with it, so the cache only ever holds nodes that are stand-ins.
    if (LOD.vueMedia) LOD.vueMedia.delete(node);
    if (on) LOD.vueUnreached++;
    return false;
  }
  // The mark is written *once*, on the transition, and read (not written) on every
  // frame after that. This is not a micro-optimisation: an attribute write is a DOM
  // mutation, the stylesheet has a rule that matches this attribute, and a write
  // therefore invalidates style for the element — every frame, for every boxed
  // node, which is exactly the state the tool promises *not* to be in ("the
  // per-frame plan is one comparison in the steady state"). Worse, the next
  // `getBoundingClientRect` the tool reads then forces a real style-and-layout pass,
  // so the tool was charging the page for the whole graph's layout at the zoom it
  // exists to make cheap. Reading costs nothing; writing the same value is not free
  // in any engine (the JS is skipped, WebKit/Blink run the attribute-changed path).
  let has = false;
  try {
    has = typeof el.hasAttribute === "function" ? !!el.hasAttribute(LOD_VUE_ATTR) : false;
  } catch (e) {
    has = false;
  }
  if (has === !!on) {
    // Already where it was asked to be: bookkeeping only.
    if (on) {
      set.add(node);
      els.set(node, el);
      lodVueWatchKeep(node, el);
    } else {
      set.delete(node);
      els.delete(node);
      lodVueUnwatch(node, el);
    }
    LOD.vuePaintSkipped = set.size; // the readout asks the set, it does not guess
    return true;
  }
  try {
    if (on) el.setAttribute(LOD_VUE_ATTR, "1");
    else el.removeAttribute(LOD_VUE_ATTR);
    LOD.vueDomWrites++;
  } catch (e) {
    return false;
  }
  if (on) {
    set.add(node);
    els.set(node, el);
    lodVueWatchKeep(node, el);
  } else {
    set.delete(node);
    els.delete(node);
    lodVueUnwatch(node, el);
  }
  LOD.vuePaintSkipped = set.size; // the readout asks the set, it does not guess
  return true; // the attribute is where it was asked to be, in either direction
}

// ------------------------------------------------- watching the node elements ---
// A measurement has to be *invalidated* when the thing it measured changes, and the
// tool's first answer was to re-measure on a timer — which means reading layout,
// forever, for every boxed node, to find out whether anything moved. The page already
// knows: a subtree that changes reports it, and an element whose box changes reports
// that. One observer of each kind covers every node (an observer takes many targets),
// the callback throws the node's measurement away, and the next draw re-measures it
// through the same per-frame ration — so a graph where nothing changes costs no
// layout read at all, however many nodes are in it.
// The tenth report asked whether the frontend already has a level of detail —
// whether it renders a node *because* the canvas is at 42 %, so that a capture reads
// a reduced node and a picture can never look like the real thing.
//
// It does not, and this is checked from two sides. Upstream: the renderer's own
// components carry no zoom in any of their shapes — `LGraphNode.vue` positions the
// node (`translate(...)`), sets its size, its opacity and its `data-node-id`; the
// pane holds *one* transform (`useTransformState.ts`), and zooming a DOM tree is a
// compositor operation: the layout, the text metrics and the computed colours of a
// node do not change with it. `LiteGraph.drawNode` early-returns in this renderer,
// so LiteGraph's own `low_quality`/`show_info` tiers never run either. So a
// stand-in's reads are always at full detail — which is exactly why a picture whose
// text was cut off could not have been "captured at 42 %".
//
// And the engine side, measured rather than assumed: `content-visibility: auto` is
// the one native DOM level-of-detail switch (it lets an engine *skip* the layout,
// paint and style of off-screen content inside a scroll container). If the frontend
// had an LOD of its own it would be built from this, so the probe below answers
// whether the engine this page runs in even honours it. Reported in the readout, so
// the answer travels with the snapshot.
function lodVueLodProbe() {
  if (LOD.vueLodProbe !== null && LOD.vueLodProbe !== undefined) return LOD.vueLodProbe;
  let ok = false;
  let why = "";
  try {
    const doc = typeof document !== "undefined" ? document : null;
    if (!doc || typeof doc.createElement !== "function" || typeof getComputedStyle !== "function") {
      why = "no document";
    } else {
      const el = doc.createElement("div");
      el.style.contentVisibility = "auto";
      el.style.containIntrinsicSize = "1px 1px";
      el.style.width = "1px";
      el.style.height = "1px";
      el.style.overflow = "hidden";
      if (!el.style.contentVisibility) {
        why = "not in CSSOM";
      } else {
        const holder = doc.createElement("div");
        holder.style.position = "absolute";
        holder.style.left = "-9999px";
        holder.style.top = "0";
        holder.style.width = "1px";
        holder.style.height = "1px";
        holder.appendChild(el);
        (doc.body || doc.documentElement || doc).appendChild(holder);
        const cs = getComputedStyle(el);
        ok = !!cs && String(cs.contentVisibility || "") === "auto";
        if (!ok) why = String((cs && cs.contentVisibility) || "unset");
        try {
          if (holder.parentNode && typeof holder.parentNode.removeChild === "function") holder.parentNode.removeChild(holder);
        } catch (e) {
          /* leaving one hidden pixel behind is not worth a fault */
        }
      }
    }
  } catch (e) {
    why = "probe threw";
  }
  LOD.vueLodProbe = { ok, why };
  return LOD.vueLodProbe;
}

function lodVueWatchOn() {
  const hasRO = typeof ResizeObserver === "function";
  const hasMO = typeof MutationObserver === "function";
  return hasRO || hasMO;
}

// Is this node's element watched? Then the page is the one reporting changes, and the
// periodic read is insurance rather than the source of truth.
function lodVueWatched(node) {
  return !!(node && LOD.vueNodeEls && LOD.vueNodeEls.has(node) && lodVueWatchOn());
}

// Watch *this* element. The frontend replaces elements under a node — a re-render,
// an unmount and remount — while the node stays boxed, and a change inside the new
// element would otherwise be noticed only by the insurance read. The old element is
// released and the measurement goes with it, because a measurement of the element
// that is gone says nothing about the one that is there.
function lodVueWatchKeep(node, el) {
  if (!node || !el) return;
  if (LOD.vueNodeEls && LOD.vueNodeEls.has(node)) {
    const set = LOD.vueNodeEls.get(node);
    if (set.has(el)) return; // already watching this very element
    lodVueUnwatch(node, el);
  }
  lodVueWatch(node, el);
}

// How many elements inside one node are watched individually. A node element holds
// its header, its slots and its widgets — a dozen elements at most in practice; the
// cap is there so a custom node that renders a thousand elements cannot turn a scan
// into a stall.
const LOD_VUE_WATCH_MAX = 24;

function lodVueWatch(node, el) {
  if (!node || !el || typeof el !== "object") return;
  if (!lodVueWatchOn()) return; // no observers on this page: the timer is the answer
  if (!LOD.vueElNodes) LOD.vueElNodes = new Map();
  if (!LOD.vueNodeEls) LOD.vueNodeEls = new Map();
  if (LOD.vueNodeEls.has(node)) return; // already watching this node's element
  try {
    if (!LOD.vueRO && typeof ResizeObserver === "function") {
      LOD.vueRO = new ResizeObserver((entries) => {
        for (const e of entries) lodVueStaleEl(e && e.target);
      });
    }
    if (!LOD.vueMO && typeof MutationObserver === "function") {
      // Children and text only, deliberately not attributes: the frontend rewrites
      // style and class on its elements constantly (hover, selection, the pane's
      // transform on every gesture), and re-measuring on those would be the timer
      // again with worse manners. A change that moves a box without touching the DOM
      // is the resize observer's job, and the periodic read is the last resort.
      LOD.vueMO = new MutationObserver((entries) => {
        for (const e of entries) {
          const target = e && e.target;
          const owner = lodVueNodeFor(target);
          if (!owner) continue;
          lodVueStaleNode(owner);
          // New children came with the change: watch them too, or a widget that
          // appears after the first look would move unwatched for the session.
          lodVueWatchInside(owner, lodVueNodeEl(owner, target));
        }
      });
    }
    lodVueWatchInside(node, el);
  } catch (e) {
    /* an element that cannot be watched keeps the timer */
  }
}

// Watch the element and the elements inside it. The resize observer is attached to
// each one: a widget whose row moves without resizing the node is a box change the
// node's own box does not report, and in this renderer the widgets live inside the
// node's element.
function lodVueWatchInside(node, el) {
  if (!el || typeof el !== "object") return;
  const set = LOD.vueNodeEls.get(node) || new Set();
  LOD.vueNodeEls.set(node, set);
  const add = (child) => {
    if (!child || typeof child !== "object" || set.has(child)) return;
    set.add(child);
    LOD.vueElNodes.set(child, node);
    try {
      if (LOD.vueRO) LOD.vueRO.observe(child);
    } catch (e) {
      /* one unwatchable element is not a reason to stop */
    }
  };
  add(el);
  try {
    if (LOD.vueMO && !set.has("mo")) {
      LOD.vueMO.observe(el, { childList: true, characterData: true, subtree: true });
      set.add("mo"); // the marker: the root's mutation watch is on
    }
  } catch (e) {
    /* the change is not watched; the timer is still there */
  }
  let kids = null;
  try {
    kids = typeof el.querySelectorAll === "function" ? el.querySelectorAll("*") : null;
  } catch (e) {
    kids = null;
  }
  if (kids) {
    const cap = Math.min(kids.length, LOD_VUE_WATCH_MAX);
    for (let i = 0; i < cap; i++) {
      const child = kids[i];
      if (!child || typeof child !== "object" || !child.tagName) continue;
      add(child);
    }
  }
  LOD.vueWatch++;
}

function lodVueUnwatch(node, el) {
  const set = node && LOD.vueNodeEls ? LOD.vueNodeEls.get(node) : null;
  if (set) {
    for (const child of set) {
      if (typeof child === "string") continue;
      try {
        if (LOD.vueRO) LOD.vueRO.unobserve(child);
      } catch (e) {
        /* gone already */
      }
      if (LOD.vueElNodes) LOD.vueElNodes.delete(child);
    }
    set.clear();
    LOD.vueNodeEls.delete(node);
  }
  if (el) {
    try {
      if (LOD.vueRO) LOD.vueRO.unobserve(el);
      if (LOD.vueMO) LOD.vueMO.unobserve(el);
    } catch (e) {
      /* nothing to stop */
    }
    if (LOD.vueElNodes) LOD.vueElNodes.delete(el);
  }
  if (node && LOD.vueMedia) LOD.vueMedia.delete(node);
}

// Which node does this element belong to? The walk answers for anything inside the
// node's element, including elements that are not watched themselves.
function lodVueNodeFor(el) {
  const map = LOD.vueElNodes;
  let n = el;
  while (n && !(map && map.has(n))) n = n.parentNode;
  return n && map ? map.get(n) : null;
}

// The element the tool took the node's picture from: the watched one, or the closest
// watched ancestor of whatever reported the change.
function lodVueNodeEl(node, el) {
  if (!node || !LOD.vueNodeEls) return null;
  const set = LOD.vueNodeEls.get(node);
  if (!set) return null;
  if (set.has(el)) return el;
  let n = el;
  while (n && !set.has(n)) n = n.parentNode;
  return n && set.has(n) ? n : null;
}

// Drop the node's measurement. Dropping (rather than marking) is the whole mechanism:
// the next caller that needs the numbers re-reads them, and everything downstream —
// the box, the ink, the signature, the picture — follows from that one read.
function lodVueStaleNode(node) {
  if (!node) return;
  // A change starts (or restarts) the settle window: the node is being redrawn
  // right now, and a picture taken during that is a picture of the node half-way
  // through being built. See lodVueSettleLeft.
  lodVueChanged(node);
  if (LOD.vueMedia) LOD.vueMedia.delete(node);
  // The verdict "this node holds a video" was reached by looking at the elements
  // that are in it; a change to those elements is what it depends on, so the verdict
  // goes with the measurement rather than living out its TTL.
  if (LOD.snapVideo && node.widgets) {
    for (const w of node.widgets) {
      const el = w && (w.element || w.inputEl);
      if (el && typeof el === "object") LOD.snapVideo.delete(el);
    }
  }
  LOD.vueStale++;
}

// A change was reported for an element inside a node's subtree.
function lodVueStaleEl(el) {
  lodVueStaleNode(lodVueNodeFor(el));
}

// ------------------------------------------------------------ the settle window ---
// The frontend renders a node in pieces: the component mounts, the layout store
// hands the size over, the widgets and the node's own media arrive when they
// arrive (an image is decoded after the element that will show it exists), and
// each of those is a separate pass over the node's DOM. A capture taken at the
// first opportunity therefore photographs a node that is still being built — the
// "captured too early to be fully there" the user reported, twice. So: a node has
// to stand still before it is photographed, and any reported change restarts the
// window, which turns a burst of rendering into one picture at the end of it
// instead of one picture per step.
//
// The window is a *floor* on lateness, never a race: the capture lane already runs
// on the idle gap, and this only ever delays it. Nothing is read and nothing is
// written while a node is quiet: one WeakMap lookup per queued node per slice.
const LOD_SNAP_SETTLE_MS_NOTE = "a node is photographed only after it has stood still";
function lodVueChanged(node) {
  if (!node || !lodVueNodesMode()) return 0;
  if (!LOD.vueSettle) LOD.vueSettle = new WeakMap();
  const t = nowMs();
  const prev = LOD.vueSettle.get(node);
  // The stamp carries the *first* change of a burst as well as the last: `at` is
  // the floor (the node has to stand still for the window), `first` is the
  // ceiling (a node that never stands still still gets photographed).
  LOD.vueSettle.set(node, prev ? { at: t, first: prev.first || t } : { at: t, first: t });
  LOD.vueSettleArms++;
  return t;
}

// How much longer this node has to stand still. 0 in the canvas renderer, where a
// node's drawing is synchronous with the frame the capture is taken on.
function lodVueSettleLeft(node, t) {
  if (!lodVueNodesMode()) return 0;
  const stamp = LOD.vueSettle ? LOD.vueSettle.get(node) : 0;
  if (!stamp) return 0;
  const now = t || nowMs();
  const at = typeof stamp === "number" ? stamp : Number(stamp.at) || 0;
  const first = typeof stamp === "number" ? stamp : Number(stamp.first) || at;
  const left = LOD_SNAP_SETTLE_MS - (now - at);
  if (left <= 0) return 0;
  // The ceiling: past this, a node that keeps changing is photographed anyway.
  // Without it a node whose subtree is rewritten more often than the window is
  // never photographed at all — and, with the old drop-on-change rule, showed a
  // plain box for as long as it kept changing.
  if (now - first >= LOD_SNAP_SETTLE_MAX_MS) return 0;
  return left;
}

// A stable number per element, for the signature. A replaced <img> is a different
// object at the same selector, and a picture made from the old one is not a
// picture of the new one even when every string on it matches.
function lodVueElSeq(el) {
  if (!el || typeof el !== "object") return 0;
  let m = LOD.vueElSeq;
  if (!m) m = LOD.vueElSeq = new WeakMap();
  let n = m.get(el);
  if (!n) {
    n = (LOD.vueElNext = (LOD.vueElNext || 0) + 1);
    m.set(el, n);
  }
  return n;
}

// The node's own rendered media, at the position the browser laid it out in.
//
// This is the half the widget route cannot see. In this renderer the frontend
// renders a node's pictures *itself* — `ImagePreview.vue` puts the node's images
// in `<img>` elements inside the node's DOM, and a custom node may render a
// `<canvas>` (a 3D viewport, a curve editor) — while the legacy preview *widget*
// is a canvas-drawn one with `surfaces: { canvas: 'shown', vueNode: 'never' }`,
// so it is mounted nowhere here. The canvas renderer's capture never has this
// problem: the widget's own `drawWidget` puts those images on the canvas and the
// capture takes the canvas. Here the canvas draws no widget, so the box draws the
// elements themselves.
//
// Geometry is read from the layout rather than guessed. `opacity: 0` (the
// blanking) keeps every box intact, so `getBoundingClientRect` is answerable
// while the node is a stand-in; both the node's element and its children sit in
// the frontend's one transformed pane, so their difference divided by the zoom is
// a distance in graph units. The read happens only when the node's own layout key
// changes (zoom, position, size, the elements and their sources), so the steady
// state costs nothing: a key comparison per drawn box, no layout read.
// The zoom the frontend's DOM is *actually* laid out at. Measured, never assumed,
// and measured in the order that is most likely to be right:
//
//   1. the transform pane's own computed matrix. The frontend writes
//      `scale3d(z,z,z) translate3d(x,y,0)` on `[data-testid=transform-pane]`, so
//      m11 of that matrix *is* the zoom. Exact, and independent of anything about
//      the node — which is why it is the first answer;
//   2. the element that carries the node's declared width,
//      `[data-testid=node-inner-wrapper]` (`w-(--node-width)`), over the node's
//      width in graph units. The node's *root* only has `min-width`, so its own
//      width is whatever its content needs — a node whose content is wider or
//      narrower than the graph size would make the root the wrong ruler;
//   3. the root element over the node's graph width — the weakest answer, and the
//      one this used to take for granted;
//   4. `canvas.ds.scale` — and a capture *rewrites* that to 1 so the picture is
//      zoom-free while the DOM keeps the transform the frontend gave it, so this
//      is only used when nothing about the DOM could be measured at all.
//
// Getting this wrong is not cosmetic: every number a Vue box draws is a client-pixel
// rect divided by this zoom. Divide a node's content by the wrong zoom and it is
// drawn at the wrong size, somewhere outside the box, which is why a picture could
// come out as a bare box.
function lodVueMatrixScale(style) {
  const t = style && style.transform;
  if (!t || t === "none") return 0;
  const m3 = /matrix3d\(([^)]+)\)/.exec(String(t));
  const m2 = /matrix\(([^)]+)\)/.exec(String(t));
  const m = m3 || m2;
  if (!m) return 0;
  const parts = m[1].split(",").map((v) => Number(String(v).trim()));
  const sx = Math.abs(parts[0]);
  return Number.isFinite(sx) && sx > 0 ? sx : 0;
}

function lodVuePaneScale() {
  if (typeof document === "undefined" || typeof document.querySelector !== "function") return 0;
  if (typeof getComputedStyle !== "function") return 0;
  try {
    const pane = document.querySelector('[data-testid="transform-pane"]');
    if (!pane) return 0;
    return lodVueMatrixScale(getComputedStyle(pane));
  } catch (e) {
    return 0;
  }
}

function lodVueSaneScale(v) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0.01 && n <= 8 ? n : 0;
}

function lodVueDomScale(node, canvas, root, rect, wUnits) {
  const canvasScale = lodVueSaneScale(Number(canvas && canvas.ds && canvas.ds.scale)) || 1;
  const fromPane = lodVueSaneScale(lodVuePaneScale());
  if (fromPane) return { scale: fromPane, from: "pane" };
  const wpx = Number(rect && rect.width) || 0;
  if (root && wUnits > 1 && typeof root.querySelector === "function") {
    try {
      const inner = root.querySelector('[data-testid="node-inner-wrapper"]');
      const iw = Number(inner && inner.getBoundingClientRect && inner.getBoundingClientRect().width) || 0;
      const ratio = lodVueSaneScale(iw / wUnits);
      if (ratio) return { scale: ratio, from: "inner" };
    } catch (e) {
      /* no inner wrapper to measure: the root is the next best ruler */
    }
  }
  const ratio = lodVueSaneScale(wpx / wUnits);
  if (ratio) return { scale: ratio, from: "root" };
  return { scale: canvasScale, from: "canvas" };
}

// One ration per frame, shared by every node asking for a backstop re-read.
function lodVueMediaBudget() {
  const left = LOD.vueMediaLeft;
  if (left === undefined) return true; // no frame in progress: nothing to ration
  if (left <= 0) return false;
  LOD.vueMediaLeft = left - 1;
  return true;
}

// The styles the browser computed for one text element, or honest fallbacks when
// this page (or the test harness) cannot answer. The size is in CSS pixels, which
// is also the node-local size: a font rendered at zoom z is z times as tall, and a
// node-local unit is 1/z of a client pixel, so the two z's cancel.
function lodVueTextStyle(el, boxH) {
  let size = 0;
  let color = "";
  let family = "";
  let weight = "";
  let style = "";
  let lineH = 0;
  let spacing = 0;
  let clampLines = 0;
  try {
    if (typeof getComputedStyle === "function") {
      const cs = getComputedStyle(el);
      const fs = parseFloat(cs && cs.fontSize);
      if (Number.isFinite(fs) && fs > 0 && fs < 64) size = fs;
      const c = cs && cs.color;
      if (c && typeof c === "string" && c !== "rgba(0, 0, 0, 0)") color = c;
      // The page's own font, not LiteGraph's. A picture drawn in Arial is a picture
      // of a node nobody has: the frontend renders its text in its own stack, and at
      // the zooms stand-ins live at, the letterforms are most of what carries.
      const fam = cs && cs.fontFamily;
      if (fam && typeof fam === "string") family = fam;
      const w = cs && Number(cs.fontWeight);
      if (Number.isFinite(w) && w > 0) weight = String(Math.round(w));
      const st = cs && cs.fontStyle;
      if (st && st !== "normal") style = String(st);
      // Chromium resolves a numeric line-height to px and leaves `normal` alone.
      const lh = parseFloat(cs && cs.lineHeight);
      if (Number.isFinite(lh) && lh > 0 && lh < 128) lineH = lh;
      const ls = parseFloat(cs && cs.letterSpacing);
      if (Number.isFinite(ls)) spacing = Math.max(-2, Math.min(8, ls));
      // `line-clamp: 3` (Tailwind's line-clamp-3) really does stop the browser after
      // three lines; a picture that draws ten because the string is long is a picture
      // the browser never painted.
      if (cs && typeof cs.getPropertyValue === "function") {
        const lc = parseInt(String(cs.getPropertyValue("-webkit-line-clamp") || ""), 10);
        if (Number.isFinite(lc) && lc > 0 && lc < 64) clampLines = lc;
      }
    }
  } catch (e) {
    /* the fallbacks below are the answer, not a guess about the theme */
  }
  if (!(size > 0)) size = Math.max(8, Math.min(16, Number(boxH) || 12));
  const LG = typeof LiteGraph !== "undefined" && LiteGraph ? LiteGraph : null;
  if (!color) color = (LG && LG.WIDGET_TEXT_COLOR) || "#DDD";
  if (!family) family = (LG && LG.NODE_FONT) || "Arial";
  if (!(lineH > 0)) lineH = size * 1.25;
  return { size, color, family, weight, style, lineH, spacing, clampLines };
}

// One item from a form control, in the same shape the ink already draws: the
// control's box, its computed text style, and what the control is *showing*.
// Everything here is read from the element, never guessed: a number field's value,
// a select's chosen option, a checkbox's checked state, a colour input's colour, a
// range input's position. (The frontend's Vue widgets are reka components — a
// `Slider` is a div with `role="slider"` and a thumb, a `NumberField` is an
// `<input>` — so both shapes have to be read for a picture to show the values the
// user sees.)
function lodVueBoxOf(el, rr, domScale, title) {
  let r = null;
  try {
    r = typeof el.getBoundingClientRect === "function" ? el.getBoundingClientRect() : null;
  } catch (e) {
    r = null;
  }
  if (!r) return null;
  const w = Number(r.width) / domScale;
  const h = Number(r.height) / domScale;
  if (!(w > 1) || !(h > 1)) return null;
  const x = (Number(r.left) - Number(rr.left)) / domScale;
  const y = (Number(r.top) - Number(rr.top)) / domScale - title;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { x, y, w, h };
}

function lodVueNumAttr(el, name, fallback) {
  try {
    const raw = el && typeof el.getAttribute === "function" ? el.getAttribute(name) : null;
    const n = parseFloat(String(raw == null ? "" : raw));
    return Number.isFinite(n) ? n : fallback;
  } catch (e) {
    return fallback;
  }
}

function lodVueFormItem(el, tag) {
  let type = "";
  try {
    type = String((el && el.type) || el.getAttribute("type") || "").toLowerCase();
  } catch (e) {
    type = "";
  }
  if (type === "password") return null; // never read, let alone draw, a password
  if (type === "checkbox" || type === "radio") {
    let checked = false;
    try {
      checked = !!el.checked;
      if (!checked) {
        const aria = el.getAttribute("aria-checked");
        checked = aria === "true";
      }
    } catch (e) {
      checked = false;
    }
    return { kind: "check", checked };
  }
  if (type === "color") {
    let color = "";
    try {
      color = String(el.value || "");
    } catch (e) {
      color = "";
    }
    // Carried under its own name: this is the colour the *control* holds, and the
    // element's own computed `color` is a different thing (it is the text colour, and
    // the text style pass fills that field on every item). One field for both is how a
    // swatch came out in the page's default text colour instead of the colour chosen.
    return { kind: "swatch", swatch: color };
  }
  if (type === "range") {
    let value = 0;
    let min = 0;
    let max = 100;
    try {
      value = Number(el.value);
      min = Number(el.min || 0);
      max = Number(el.max || 100);
    } catch (e) {
      value = 0;
    }
    return { kind: "range", value, min, max };
  }
  let raw = "";
  try {
    if (tag === "SELECT") {
      const opts = el.selectedOptions;
      const chosen = opts && opts.length ? opts[0] : null;
      raw = chosen ? String(chosen.textContent || chosen.label || chosen.value || "") : String(el.value || "");
    } else {
      raw = String(el.value == null ? "" : el.value);
    }
  } catch (e) {
    raw = "";
  }
  raw = raw.replace(/[^\S\n]+/g, " ").trim();
  if (!raw) return null;
  // A textarea is a block of text, not a one-line field: its first line sits at its
  // own top and the rest flows down, which is what the element shows. A one-line
  // input centres its single line in the row, and a row is what a picture of a
  // taller `block` box got wrong — a prompt drawn in the middle of its own box.
  return { kind: "text", text: raw, align: lodVueTextAlign(el), block: tag === "TEXTAREA" };
}

// The same item, from the ARIA shape a reka component renders: a slider is a div
// with `role="slider"` and `aria-valuenow`, a checkbox or a switch carries
// `aria-checked`, a combobox carries its chosen value in a readonly input or a span.
function lodVueAriaItem(el) {
  let role = "";
  try {
    role = String((el && typeof el.getAttribute === "function" && el.getAttribute("role")) || "").toLowerCase();
  } catch (e) {
    role = "";
  }
  if (!role) return null;
  if (role === "slider") {
    // The parts a slider is made of are its own children in this renderer (a track
    // and a thumb), each with a box and a computed colour, so they are read rather
    // than invented: the widest child with a paintable surface is the track, a small
    // one after it is the thumb.
    const item = {
      kind: "range",
      value: lodVueNumAttr(el, "aria-valuenow", 0),
      min: lodVueNumAttr(el, "aria-valuemin", 0),
      max: lodVueNumAttr(el, "aria-valuemax", 100),
      track: "",
      thumb: "",
      thumbW: 0,
    };
    try {
      const kids = el.children || [];
      for (let i = 0; i < kids.length && i < 4; i++) {
        const kid = kids[i];
        if (!kid || !kid.tagName) continue;
        const st = lodVueChromeStyle(kid);
        const box = kid.getBoundingClientRect && kid.getBoundingClientRect();
        const w = box ? Number(box.width) : 0;
        const h = box ? Number(box.height) : 0;
        if (st.fill && !item.track && w > 0) item.track = st.fill;
        else if ((st.fill || st.border) && !item.thumb && w > 0) {
          item.thumb = st.fill || st.border;
          item.thumbW = Math.max(2, Math.min(w, h || w));
        }
      }
    } catch (e) {
      /* a slider without readable parts is drawn from the fallbacks */
    }
    return item;
  }
  if (role === "checkbox" || role === "switch" || role === "radio") {
    let checked = false;
    try {
      checked = String(el.getAttribute("aria-checked") || "") === "true";
    } catch (e) {
      checked = false;
    }
    return { kind: "check", checked };
  }
  return null;
}

// The text style every item shares, copied onto it (so the ink reads one shape).
function lodVueTextStyleInto(item, style) {
  item.size = style.size;
  item.color = style.color;
  item.family = style.family;
  item.weight = style.weight;
  item.style = style.style;
  item.lineH = style.lineH;
  item.spacing = style.spacing;
  item.clampLines = style.clampLines;
}

function lodVueTextAlign(el) {
  try {
    if (typeof getComputedStyle === "function") {
      const cs = getComputedStyle(el);
      const ta = cs && String(cs.textAlign || "");
      if (ta === "right" || ta === "center") return ta;
    }
  } catch (e) {
    /* left is what a browser does with an unset alignment */
  }
  return "left";
}

// The text the frontend renders inside a node: widget labels, the values it draws
// itself, the title, badges. In this renderer that text is DOM text, and no browser
// API screenshots it — but every string, its laid-out box and the styles the
// browser computed for it *are* readable, and painting them with the canvas is what
// makes a Vue stand-in look like the node instead of like a coloured rectangle.
//
// Read in the same pass as the node's media, from the same single measurement:
// node-local units, so the draw itself is a handful of fillText calls and costs
// nothing per frame.
function lodVueTextLines(root, rr, domScale, title) {
  const out = [];
  try {
    const els = root.querySelectorAll("*") || [];
    for (const el of els) {
      if (out.length >= LOD_VUE_TEXT_MAX) break;
      const tag = String((el && el.tagName) || "").toUpperCase();
      if (tag === "IMG" || tag === "CANVAS") continue; // drawn as pictures
      const box = lodVueBoxOf(el, rr, domScale, title);
      if (!box) continue; // hidden, collapsed or not laid out yet
      const style = lodVueTextStyle(el, box.h);
      // A form control's *value* is not its text: `textContent` of an input is its
      // default value, which is why these were skipped outright — and in this
      // renderer a widget's value *is* a form control (a number field's input, a
      // select's chosen option, a slider's thumb), so skipping them left a node's
      // rows drawn as empty backgrounds. What the user reads there is `value`,
      // `aria-*` and the checked/range state, all of which are readable.
      const form = tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
      if (form) {
        const item = lodVueFormItem(el, tag);
        if (!item) continue;
        item.x = box.x;
        item.y = box.y;
        item.w = box.w;
        item.h = box.h;
        lodVueTextStyleInto(item, style);
        out.push(item);
        continue;
      }
      // Reka components (the frontend's own sliders, checkboxes, switches) are divs
      // with ARIA roles rather than form controls.
      const aria = lodVueAriaItem(el);
      if (aria) {
        aria.x = box.x;
        aria.y = box.y;
        aria.w = box.w;
        aria.h = box.h;
        lodVueTextStyleInto(aria, style);
        out.push(aria);
        continue;
      }
      if (el.children && el.children.length) continue; // a leaf is where the text is
      let raw = "";
      try {
        raw = String(el.textContent == null ? "" : el.textContent);
      } catch (e) {
        raw = "";
      }
      // Horizontal runs collapse, newlines do not: a caption or a prompt block the
      // browser wrapped itself keeps its own breaks, and flattening them turns a
      // paragraph into one line of text the node never showed.
      raw = raw.replace(/[^\S\n]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
      if (!raw) continue;
      if (raw.length > LOD_VUE_TEXT_CHARS) raw = raw.slice(0, LOD_VUE_TEXT_CHARS);
      const align = lodVueTextAlign(el);
      // Everything the ink needs to draw the string the way the browser did: the
      // size, the colour, the family, the weight, the line height and the clamp the
      // element asked for. (A picture that draws Arial at 12px where the page drew
      // Inter at 11px is a picture of a node nobody has.)
      const item = { kind: "text", text: raw, align, x: box.x, y: box.y, w: box.w, h: box.h };
      lodVueTextStyleInto(item, style);
      out.push(item);
    }
  } catch (e) {
    /* text that cannot be read leaves the box as it was */
  }
  return out;
}

// Paint the node's structure: the frame, the header bar, the body panel, the slot
// dots. Drawn in that order (biggest first), each as a rounded rectangle or a
// circle, in the colours the browser computed for the element. The live box draws
// them and so does the capture, through this one function.
function lodVueChromeInk(ctx, chrome, out, key) {
  if (!chrome || !chrome.length || !ctx || typeof ctx.fillRect !== "function") return out;
  const into = key || "chrome"; // which gauge the caller wants counted
  const order = { frame: 0, panel: 1, widget: 2, ring: 3, header: 4, dot: 5 };
  const list = chrome.slice().sort((a, b) => (order[a.kind] || 9) - (order[b.kind] || 9));
  for (const c of list) {
    if (!(c.w > 0) || !(c.h > 0)) continue;
    try {
      const r = Math.max(0, Math.min(c.radius || 0, Math.min(c.w, c.h) / 2));
      if (typeof ctx.beginPath === "function") ctx.beginPath();
      if (c.kind === "dot") {
        const cx = c.x + c.w / 2;
        const cy = c.y + c.h / 2;
        const rad = Math.max(0.5, Math.min(c.w, c.h) / 2);
        if (typeof ctx.arc === "function") {
          ctx.arc(cx, cy, rad, 0, Math.PI * 2);
          if (c.fill) {
            ctx.fillStyle = c.fill;
            ctx.fill();
          }
          if (c.border && c.borderW > 0) {
            ctx.strokeStyle = c.border;
            ctx.lineWidth = c.borderW;
            ctx.stroke();
          }
          out[into] = (out[into] || 0) + 1;
        } else if (c.fill) {
          ctx.fillStyle = c.fill;
          ctx.fillRect(c.x, c.y, c.w, c.h);
          out[into] = (out[into] || 0) + 1;
        }
        continue;
      }
      if (r > 0 && typeof ctx.roundRect === "function") ctx.roundRect(c.x, c.y, c.w, c.h, r);
      else if (r > 0 && typeof ctx.arcTo === "function") {
        ctx.moveTo(c.x + r, c.y);
        ctx.arcTo(c.x + c.w, c.y, c.x + c.w, c.y + c.h, r);
        ctx.arcTo(c.x + c.w, c.y + c.h, c.x, c.y + c.h, r);
        ctx.arcTo(c.x, c.y + c.h, c.x, c.y, r);
        ctx.arcTo(c.x, c.y, c.x + c.w, c.y, r);
        ctx.closePath();
      } else {
        ctx.rect(c.x, c.y, c.w, c.h);
      }
      const strokeOnly = c.kind === "ring"; // an outline element has no fill of its own
      if (c.fill && !strokeOnly) {
        ctx.fillStyle = c.fill;
        ctx.fill();
        out[into] = (out[into] || 0) + 1;
      }
      if (c.border && c.borderW > 0) {
        ctx.strokeStyle = c.border;
        ctx.lineWidth = c.borderW;
        ctx.stroke();
        out[into] = (out[into] || 0) + 1;
      }
    } catch (e) {
      /* one structural box that cannot be drawn does not spoil the picture */
    }
  }
  return out;
}

// Paint those lines. Each is clipped to the element's own box — a browser clips a
// long label to its element too — and drawn on the middle of that box, which is
// where a single line of text sits in it.
function lodVueTextInk(ctx, lines, out) {
  if (!ctx || !lines || !lines.length) return 0;
  const LG = typeof LiteGraph !== "undefined" && LiteGraph ? LiteGraph : null;
  let drew = 0;
  for (const it of lines) {
    try {
      // The three control shapes a Vue node shows values in that are not text: a
      // colour input (a swatch), a checkbox/switch (a tick), a slider (a track with
      // a knob where the value is). Drawing them as their own shapes is what makes a
      // picture of a node with widgets look like the node instead of like a list.
      if (it.kind === "swatch") {
        const c = lodVueColor(it.swatch || it.color);
        if (c) {
          ctx.fillStyle = c;
          const r = Math.max(0, Math.min(Number(it.h) / 2 || 0, 4));
          if (r > 0 && typeof ctx.roundRect === "function" && typeof ctx.beginPath === "function") {
            ctx.beginPath();
            ctx.roundRect(it.x, it.y, it.w, it.h, r);
            ctx.fill();
          } else if (typeof ctx.fillRect === "function") {
            ctx.fillRect(it.x, it.y, it.w, it.h);
          }
          if (out) {
            out.ink = (out.ink || 0) + 1;
            out.control = (out.control || 0) + 1;
          }
          drew++;
        }
        continue;
      }
      if (it.kind === "check") {
        const s = Math.max(4, Math.min(Number(it.w) || 8, Number(it.h) || 8));
        const x = it.x + (Number(it.w) - s) / 2;
        const y = it.y + (Number(it.h) - s) / 2;
        if (it.checked) {
          ctx.fillStyle = lodVueColor(it.color) || "#ddd";
          if (typeof ctx.fillRect === "function") ctx.fillRect(x, y, s, s);
          // the tick, in the surface's own colour so it reads on the fill
          ctx.strokeStyle = "rgba(0, 0, 0, 0.75)";
          ctx.lineWidth = Math.max(1, s / 6);
          if (typeof ctx.beginPath === "function" && typeof ctx.moveTo === "function") {
            ctx.beginPath();
            ctx.moveTo(x + s * 0.22, y + s * 0.55);
            ctx.lineTo(x + s * 0.42, y + s * 0.75);
            ctx.lineTo(x + s * 0.78, y + s * 0.28);
            if (typeof ctx.stroke === "function") ctx.stroke();
          }
        } else if (typeof ctx.strokeRect === "function") {
          ctx.strokeStyle = lodVueColor(it.color) || "#888";
          ctx.lineWidth = 1;
          ctx.strokeRect(x + 0.5, y + 0.5, Math.max(1, s - 1), Math.max(1, s - 1));
        }
        if (out) {
          out.ink = (out.ink || 0) + 1;
          out.control = (out.control || 0) + 1;
        }
        drew++;
        continue;
      }
      if (it.kind === "range") {
        const min = Number.isFinite(Number(it.min)) ? Number(it.min) : 0;
        const max = Number.isFinite(Number(it.max)) ? Number(it.max) : 100;
        const value = Number.isFinite(Number(it.value)) ? Number(it.value) : min;
        const t = max > min ? Math.max(0, Math.min(1, (value - min) / (max - min))) : 0;
        const trackY = it.y + it.h / 2;
        const trackH = Math.max(1, Math.min(4, it.h / 4));
        ctx.fillStyle = (it.track ? lodVueColor(it.track) : "") || lodVueColor(it.color) || "rgba(255, 255, 255, 0.35)";
        if (typeof ctx.fillRect === "function") ctx.fillRect(it.x, trackY - trackH / 2, it.w, trackH);
        // The knob sits where the value is, the way a slider shows it.
        const knob = it.thumbW > 0 ? Math.min(it.h, it.thumbW) : Math.min(it.h, Math.max(6, it.h * 0.7));
        const kx = it.x + t * Math.max(0, it.w - knob);
        ctx.fillStyle = (it.thumb ? lodVueColor(it.thumb) : "") || "rgba(255, 255, 255, 0.85)";
        if (typeof ctx.beginPath === "function" && typeof ctx.arc === "function") {
          ctx.beginPath();
          ctx.arc(kx + knob / 2, trackY, Math.max(1, knob / 2), 0, Math.PI * 2);
          if (typeof ctx.fill === "function") ctx.fill();
        } else if (typeof ctx.fillRect === "function") {
          ctx.fillRect(kx, trackY - knob / 2, knob, knob);
        }
        if (out) {
          out.ink = (out.ink || 0) + 1;
          out.control = (out.control || 0) + 1;
        }
        drew++;
        continue;
      }
      const size = Math.max(6, Math.min(48, Number(it.size) || 12));
      const family = it.family || (LG && LG.NODE_FONT) || "Arial";
      const lineH = Number(it.lineH) > 0 ? Number(it.lineH) : size * 1.25;
      if (typeof ctx.save === "function") ctx.save();
      if (typeof ctx.beginPath === "function" && typeof ctx.rect === "function" && typeof ctx.clip === "function") {
        ctx.beginPath();
        ctx.rect(it.x, it.y, it.w, it.h);
        ctx.clip();
      }
      ctx.fillStyle = lodVueColor(it.color) || it.color;
      // The page's font, at the page's weight and style, with the spacing it asked
      // for — a picture of a node whose text is Arial is not a picture of the node.
      const font = [it.style || "", it.weight || "", `${size}px`, family].join(" ").replace(/\s+/g, " ").trim();
      ctx.font = font;
      if ("letterSpacing" in ctx) {
        try {
          ctx.letterSpacing = `${Number(it.spacing) || 0}px`;
        } catch (e) {
          /* an engine without letterSpacing draws the same text, a hair differently */
        }
      }
      ctx.textAlign = it.align === "right" ? "right" : it.align === "center" ? "center" : "left";
      if ("textBaseline" in ctx) ctx.textBaseline = "top";
      // One `fillText` per *leaf* is what a browser does not do: a paragraph is one
      // element with many laid-out lines, and drawing it as one line clipped to the
      // box is exactly the "text gets cut off" a user sees — one line of a prompt,
      // cut at the right edge, in the middle of an empty block. The string is wrapped
      // to the box it was laid out in, in the font it was laid out with, and as many
      // lines are drawn as the box has room for; the rest is marked the way the
      // wrapper marks it.
      const pad = 2;
      const room = Math.max(1, Math.min(64, Number(it.clampLines) || Math.floor((it.h - pad) / lineH) || 1));
      const wrapped = lodSnapWrapText(it.text, Math.max(4, it.w - pad * 2), room + 1, size, ctx);
      if (wrapped.length > room) {
        const last = wrapped[room - 1];
        wrapped[room - 1] = last && last.length > 1 ? `${last.slice(0, last.length - 1)}\u2026` : "\u2026";
      }
      const drawn = wrapped.length > room ? wrapped.slice(0, room) : wrapped;
      // Where the browser puts the first line: its line box starts at the top of
      // the measured box and leads into the glyphs by half the leftover between the
      // line height and the font's own content height. A single line in a taller row
      // is centred inside it, which is what the row looks like.
      const contentH = size * 1.25;
      const half = Math.max(0, (lineH - contentH) / 2);
      const top = it.block
        ? it.y + pad + half // a block element's own top, the way the browser starts it
        : it.y + Math.max(0, (it.h - drawn.length * lineH) / 2) + half;
      const tx = it.align === "right" ? it.x + it.w - pad : it.align === "center" ? it.x + it.w / 2 : it.x + pad;
      if (typeof ctx.fillText === "function") {
        for (let i = 0; i < drawn.length; i++) ctx.fillText(drawn[i], tx, top + i * lineH);
      }
      if (typeof ctx.restore === "function") ctx.restore();
      if (out) {
        out.ink = (out.ink || 0) + 1;
        out.text = (out.text || 0) + 1;
      }
      drew++;
    } catch (e) {
      try {
        if (typeof ctx.restore === "function") ctx.restore();
      } catch (e2) {
        /* nothing left to restore */
      }
      if (out) out.skipped = (out.skipped || 0) + 1;
    }
  }
  return drew;
}

// Is this element inside that one? (The shim's DOM has no `contains`, and the real
// one is not free either — the walk stops at the root, which is one or two hops for
// a widget element.)
function lodVueInside(el, root) {
  let n = el && el.parentNode;
  while (n) {
    if (n === root) return true;
    n = n.parentNode;
  }
  return false;
}

// The laid-out box of every widget element the frontend has mounted inside the
// node's own DOM, in node-local units. Widgets whose content the media pass already
// carries (an `<img>` or a `<canvas>` inside the root) are skipped here: one element
// is drawn once, by whichever route measured it.
function lodVueWidgetBoxes(node, root, rr, domScale, title) {
  const out = [];
  const widgets = (node && node.widgets) || [];
  for (let i = 0; i < widgets.length && i < LOD_SNAP_DOM_MAX; i++) {
    const w = widgets[i];
    if (!w) continue;
    let el = w.element || w.inputEl;
    if (!el || typeof el !== "object" || !el.tagName) continue;
    if (w.hidden) continue;
    if (!lodVueInside(el, root)) continue; // mounted by the page somewhere else
    let r = null;
    try {
      r = typeof el.getBoundingClientRect === "function" ? el.getBoundingClientRect() : null;
    } catch (e) {
      r = null;
    }
    if (!r) continue;
    const bw = Number(r.width) / domScale;
    const bh = Number(r.height) / domScale;
    if (!(bw > 1) || !(bh > 1)) continue;
    const x = (Number(r.left) - Number(rr.left)) / domScale;
    const y = (Number(r.top) - Number(rr.top)) / domScale - title;
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    // The widget's own surface, measured in the same pass: in this renderer a
    // widget *is* a DOM element (an input, a row, a slider's wrapper), and at the
    // zoom the stand-ins live at, its box and colour are most of what the user sees
    // of it. Read here rather than in a second pass, so the row's rect and its
    // colour can never belong to two different layouts.
    const st = lodVueChromeStyle(el);
    out.push({ el, kind: "widget", x, y, w: bw, h: bh, fill: st.fill, border: st.border, borderW: st.borderW, radius: st.radius });
  }
  return out;
}

// The node's *structure*, as the frontend draws it: the coloured frame, the header
// bar, the body panel inside it and the slot dots on its edges. These are DOM
// elements with a background colour and a rounded box, and a picture built only
// from text, images and a title bar is the sketch a user called "semi — not fully
// there". Measured in the same pass as everything else (one rect per element, one
// computed style for the colours), drawn in the same ink function the live box and
// the capture share, so the two can never disagree.
//
// The selectors are the frontend's own structure (`LGraphNode.vue`,
// `NodeHeader.vue`, `InputSlot.vue`): `[data-testid=node-inner-wrapper]` carries
// the node's colour (`nodeData.color` inline), `[data-testid^=node-body-]` is the
// body surface, `[data-testid^=node-header-]` the title bar, and a slot's dot is
// `.slot-dot`. Anything absent is skipped — a node without a header (a reroute) has
// no header box, and that is not an error.
const LOD_VUE_CHROME_MAX = 128; // a real node has two dots per row it carries

function lodVueChromeBoxes(node, root, rr, domScale, title) {
  const out = [];
  // The node's own header and body, by the id in the frontend's own test id: a
  // prefix match would happily read another node's body.
  const id = node && node.id !== undefined && node.id !== null ? String(node.id) : "";
  const spec = [
    ['[data-testid="node-inner-wrapper"]', "frame", 1],
    [`[data-testid="node-body-${id}"]`, "panel", 1],
    [`[data-testid="node-header-${id}"]`, "header", 1],
    // The widget rows the frontend renders itself (`WidgetGrid.vue`: a grid with
    // `data-testid="node-widgets"`, one row per widget, the control in a
    // `lg-node-widget` element). This is the route that exists on a real page: the
    // `widget.element` route below is the *DOM-widget* route (`WidgetDOM.vue`) and a
    // Vue-rendered widget — a reka slider, a number field, a combo — has no such
    // element, so before this the row surfaces of a real node were never read, which
    // is what a node's body looking like an empty flat panel was.
    ['[data-testid="node-widgets"]', "widgets", 96],
    [".lg-node-widget", "widget", 96],
    // The selection outline is deliberately *not* read here: it is drawn on top of
    // the picture at blit time (`lodSnapSelectionRing`), for both pathways, so
    // reading it into the capture would draw it twice and make a click cost a
    // recapture. (The *executing* outline is its own element and is a known gap: a
    // node that starts running keeps the picture it had until something else about
    // it changes.)
    [".slot-dot", "dot", 96],
  ];
  for (const [sel, kind, cap] of spec) {
    let els = null;
    try {
      els = root.querySelectorAll(sel) || [];
    } catch (e) {
      els = null;
    }
    // The grid the frontend renders its widgets in: its rows are its children, read
    // through `children` rather than a child-combinator selector — a selector the
    // page has to parse is a selector that can silently match nothing, and a row that
    // is never read is a widget that never appears in the picture.
    if (sel === '[data-testid="node-widgets"]' && els && els.length && els[0] && els[0].children) {
      els = els[0].children;
    }
    if (!els || !els.length) continue;
    const n = Math.min(els.length, cap);
    for (let i = 0; i < n; i++) {
      const el = els[i];
      if (!el || out.length >= LOD_VUE_CHROME_MAX) break;
      let r = null;
      try {
        r = typeof el.getBoundingClientRect === "function" ? el.getBoundingClientRect() : null;
      } catch (e) {
        r = null;
      }
      if (!r) continue;
      const w = Number(r.width) / domScale;
      const h = Number(r.height) / domScale;
      if (!(w > 0.5) || !(h > 0.5)) continue;
      const x = (Number(r.left) - Number(rr.left)) / domScale;
      const y = (Number(r.top) - Number(rr.top)) / domScale - title;
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      const st = lodVueChromeStyle(el);
      out.push({ el, kind, x, y, w, h, fill: st.fill, border: st.border, borderW: st.borderW, radius: st.radius });
    }
  }
  return out;
}

// One computed style per structural element, and *only* what the browser computed:
// a Tailwind class like `bg-component-node-background` resolves through the theme's
// custom property, so `backgroundColor` already carries the colour the element is
// painted in. There is deliberately no colour of our own to fall back to — an
// element that computes to transparent paints nothing, and inventing a colour for
// it would paint a box the frontend does not (the header bar, for instance, is
// usually just the wrapper's own surface showing through).
// How opaque the frontend is compositing this node right now. `LGraphNode.vue` puts
// the node's opacity on the element's own `style` (`opacity: nodeOpacity`, from the
// `Comfy.Node.Opacity` setting, times 0.6 while the node is being dragged and 0.5
// while it is muted or bypassed), and the whole subtree is composited with it. A
// picture that ignores it draws a muted node at full strength, a dragged-away node
// as if it were still in place, and — because the picture *replaces* the element —
// no dimming happens at all where the user expects to see it.
function lodVueOpacity(el) {
  let op = 1;
  try {
    const inline = el && el.style ? parseFloat(el.style.opacity) : NaN;
    if (Number.isFinite(inline)) op = inline;
    else if (typeof getComputedStyle === "function") {
      const cs = getComputedStyle(el);
      const c = cs ? parseFloat(cs.opacity) : NaN;
      if (Number.isFinite(c)) op = c;
    }
  } catch (e) {
    /* unreadable: fully opaque is what a node is unless the page says otherwise */
  }
  if (!Number.isFinite(op)) op = 1;
  return Math.max(0, Math.min(1, op));
}

function lodVueChromeStyle(el) {
  const out = { fill: "", border: "", borderW: 0, radius: 0 };
  try {
    const cs = typeof getComputedStyle === "function" ? getComputedStyle(el) : null;
    if (cs) {
      out.fill = lodVuePaint(cs.backgroundColor);
      const bw = parseFloat(cs.borderTopWidth || "0") || 0;
      if (bw > 0 && lodVuePaintable(cs.borderTopColor)) {
        out.borderW = bw;
        out.border = lodVuePaint(cs.borderTopColor);
      }
      const rad = parseFloat(cs.borderTopLeftRadius || "0") || 0;
      out.radius = Number.isFinite(rad) ? Math.max(0, Math.min(24, rad)) : 0;
    }
  } catch (e) {
    /* unreadable style: no chrome for this element, which is never a failure */
  }
  return out;
}

// ---------------------------------------------------------------- colour ---
// A computed colour string is what the *browser* said; whether the canvas can
// paint it is a different question. `rgb()`, `rgba()` and hex always could. But
// this frontend is built on Tailwind 4 (`tailwindcss` 4.3 in its package.json),
// whose opacity modifiers compile to `color-mix()` — so a class like
// `bg-primary-500/10` (which `LGraphNode.vue` applies while a node is dragged
// over) computes to an `oklab(...)` or `color(srgb ...)` string, and any pack
// whose CSS uses `oklch()` computes to that too. Assigning a string the canvas
// cannot parse is *not* an error: the assignment is silently ignored and the
// previous fillStyle stays — which is how one node's colour becomes another
// node's colour in a picture, and what a user sees as "the colours are
// different". So every string is parsed here, by hand, into `rgba(...)`:
// exactly the colour the browser computed, in the one syntax every canvas has
// always understood. Unparsable strings are counted and sampled (`vueColorMiss`
// / `vueColorSample`) and paint nothing, rather than painting the wrong colour.
const LOD_VUE_COLOR_CACHE = 512;

function lodVueColorCount(raw) {
  if (!raw) return;
  LOD.vueColorMiss = (LOD.vueColorMiss || 0) + 1;
  if (!LOD.vueColorSample) LOD.vueColorSample = [];
  const t = String(raw).slice(0, 60);
  if (LOD.vueColorSample.indexOf(t) < 0 && LOD.vueColorSample.length < 4) LOD.vueColorSample.push(t);
}

function lodVueClamp01(x) {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

// linear-light sRGB (0..1) -> 8-bit channels, with the transfer function the
// browser uses. Values outside the gamut are clamped, which is what a canvas
// without a wide-gamut backing store does with them anyway.
function lodVueLinearToByte(v) {
  const s = v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(Math.max(0, v), 1 / 2.4) - 0.055;
  return Math.round(lodVueClamp01(s) * 255);
}

function lodVueOklabToRgb(L, a, b) {
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.291485548 * b;
  const l = l_ * l_ * l_;
  const m = m_ * m_ * m_;
  const s = s_ * s_ * s_;
  return [
    lodVueLinearToByte(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    lodVueLinearToByte(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    lodVueLinearToByte(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  ];
}

function lodVueHslToRgb(h, s, l) {
  const hue = ((h % 360) + 360) % 360;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = l - c / 2;
  const seg = Math.floor(hue / 60) % 6;
  const rgb = [
    [c, x, 0],
    [x, c, 0],
    [0, c, x],
    [0, x, c],
    [x, 0, c],
    [c, 0, x],
  ][seg];
  return [Math.round((rgb[0] + m) * 255), Math.round((rgb[1] + m) * 255), Math.round((rgb[2] + m) * 255)];
}

// `none` is a real value in CSS Color 4 and means "no contribution".
function lodVueNum(tok, scale) {
  const t = String(tok == null ? "" : tok).trim();
  if (!t || t === "none") return 0;
  const n = parseFloat(t);
  if (!Number.isFinite(n)) return NaN;
  if (/%$/.test(t)) return (n / 100) * (scale === undefined ? 1 : scale);
  return n;
}

function lodVueAlpha(tok) {
  if (tok == null || tok === "") return 1;
  const n = lodVueNum(tok, 1);
  return Number.isFinite(n) ? lodVueClamp01(n) : 1;
}

// One string in, `rgba(r, g, b, a)` out — or "" when this tool cannot read it.
function lodVueColor(raw) {
  const src = String(raw == null ? "" : raw).trim();
  const low = src.toLowerCase();
  if (!src || low === "none" || low === "initial" || low === "inherit" || low === "inherit") return "";
  if (low === "transparent") return "rgba(0, 0, 0, 0)";
  if (!LOD.vueColorCache) LOD.vueColorCache = new Map();
  const hit = LOD.vueColorCache.get(low);
  if (hit !== undefined) return hit;
  let out = "";
  try {
    out = lodVueColorParse(low);
  } catch (e) {
    out = "";
  }
  if (!out) lodVueColorCount(src);
  if (LOD.vueColorCache.size > LOD_VUE_COLOR_CACHE) LOD.vueColorCache.clear();
  LOD.vueColorCache.set(low, out);
  return out;
}

function lodVueColorParse(low) {
  const hex = /^#([0-9a-f]{3,8})$/.exec(low);
  if (hex) {
    const h = hex[1];
    const to = (t) => parseInt(t, 16);
    if (h.length === 3 || h.length === 4) {
      return `rgba(${to(h[0] + h[0])}, ${to(h[1] + h[1])}, ${to(h[2] + h[2])}, ${h.length === 4 ? (to(h[3] + h[3]) / 255).toFixed(3) : 1})`;
    }
    if (h.length === 6 || h.length === 8) {
      return `rgba(${to(h.slice(0, 2))}, ${to(h.slice(2, 4))}, ${to(h.slice(4, 6))}, ${h.length === 8 ? (to(h.slice(6, 8)) / 255).toFixed(3) : 1})`;
    }
    return "";
  }
  const fn = /^([a-z-]+)\(([^)]*)\)$/.exec(low);
  if (!fn) return "";
  const name = fn[1];
  const parts = fn[2].split("/");
  const body = parts[0].trim();
  const alpha = lodVueAlpha(parts.length > 1 ? parts[1] : null);
  const toks = body.replace(/,/g, " ").split(/\s+/).filter((t) => t.length);
  const rgbOut = (r, g, b, a) => {
    const al = Number.isFinite(a) ? String(Number(lodVueClamp01(a).toFixed(3))) : "1";
    return `rgba(${Math.round(lodVueClamp01(r / 255) * 255)}, ${Math.round(lodVueClamp01(g / 255) * 255)}, ${Math.round(lodVueClamp01(b / 255) * 255)}, ${al})`;
  };
  const chan = (t) => {
    const t0 = String(t == null ? "" : t).trim();
    if (!t0 || t0 === "none") return 0;
    return /%$/.test(t0) ? (parseFloat(t0) / 100) * 255 : parseFloat(t0);
  };
  if (name === "rgb" || name === "rgba") {
    if (toks.length < 3) return "";
    return rgbOut(chan(toks[0]), chan(toks[1]), chan(toks[2]), alpha);
  }
  if (name === "hsl" || name === "hsla") {
    if (toks.length < 3) return "";
    const h = lodVueNum(toks[0], 360);
    const s = lodVueNum(toks[1], 1);
    const l = lodVueNum(toks[2], 1);
    if (![h, s, l].every(Number.isFinite)) return "";
    const [r, g, b] = lodVueHslToRgb(h, lodVueClamp01(s), lodVueClamp01(l));
    return rgbOut(r, g, b, alpha);
  }
  if (name === "hwb") {
    if (toks.length < 3) return "";
    const h = lodVueNum(toks[0], 360);
    const w = lodVueClamp01(lodVueNum(toks[1], 1));
    const bl = lodVueClamp01(lodVueNum(toks[2], 1));
    const [r0, g0, b0] = lodVueHslToRgb(h, 1, 0.5);
    const mix = (c) => {
      const v = (c / 255) * (1 - w - bl) + w;
      return lodVueClamp01(v) * 255;
    };
    return rgbOut(mix(r0), mix(g0), mix(b0), alpha);
  }
  if (name === "oklab" || name === "oklch") {
    if (toks.length < 3) return "";
    const L = lodVueNum(toks[0], 1);
    if (!Number.isFinite(L)) return "";
    let a, b;
    if (name === "oklch") {
      const C = lodVueNum(toks[1], 0.4);
      const H = lodVueNum(toks[2], 360);
      const rad = (H * Math.PI) / 180;
      a = C * Math.cos(rad);
      b = C * Math.sin(rad);
    } else {
      a = lodVueNum(toks[1], 0.4);
      b = lodVueNum(toks[2], 0.4);
    }
    if (![a, b].every(Number.isFinite)) return "";
    const [r, g, bl2] = lodVueOklabToRgb(L, a, b);
    return rgbOut(r, g, bl2, alpha);
  }
  if (name === "color") {
    // `color(srgb-linear …)` and `color(srgb …)`; the wide-gamut spaces are left
    // to the canvas (or counted as unread) rather than approximated badly.
    const space = String(toks[0] || "").toLowerCase();
    if ((space === "srgb" || space === "srgb-linear") && toks.length >= 4 && typeof fn[2] !== "undefined") {
      const vals = [toks[1], toks[2], toks[3]].map((t) => {
        const n = lodVueNum(t, 1);
        return Number.isFinite(n) ? n : NaN;
      });
      if (vals.some((n) => !Number.isFinite(n))) return "";
      const bytes = vals.map((v) => (space === "srgb-linear" ? lodVueLinearToByte(v) : Math.round(lodVueClamp01(v) * 255)));
      return rgbOut(bytes[0], bytes[1], bytes[2], alpha);
    }
    return "";
  }
  return "";
}

// A colour a surface can be painted in: the normalised string, or "" for
// transparent / unreadable. (The raw string is never handed to the canvas: a
// string it cannot parse is silently ignored and the previous colour leaks.)
function lodVuePaint(color) {
  return lodVueColor(color);
}

// A colour worth painting: not transparent, not an unset value.
function lodVuePaintable(color) {
  const c = String(color || "").trim().toLowerCase();
  if (!c) return false;
  if (c === "transparent" || c === "none" || c === "initial" || c === "inherit") return false;
  if (c === "rgba(0, 0, 0, 0)" || c === "rgba(0,0,0,0)") return false;
  return true;
}

function lodVueRootMetrics(node, canvas, force) {
  const root = lodVueRootEl(node);
  if (!root || typeof root.querySelectorAll !== "function") return null;
  const scale = Number(canvas && canvas.ds && canvas.ds.scale) || 1;
  const size = (node && (node.renderingSize || node.size)) || [0, 0];
  const wUnits = Math.abs(Number(size[0])) || 0;
  // The key is the node's own size, deliberately not the zoom or the pan: every
  // number measured here is *node-local* (a child's rect minus the node's own,
  // divided by the zoom), so panning and zooming do not move them. A key that
  // changed on every pan would mean one forced layout per boxed node per frame
  // while the user drags the canvas — the frame budget this tool exists for.
  const key = [Number(size[0]) || 0, Number(size[1]) || 0].join("|");
  // Which zoom the numbers were measured at is recorded, not compared: dividing
  // the difference between two rects by the zoom cancels it out, so a zoom leaves
  // every stored number correct. The periodic refresh catches the subpixel drift a
  // transform can leave behind.
  if (!LOD.vueMedia) LOD.vueMedia = new Map();
  const cache = LOD.vueMedia;
  const hit = cache.get(node);
  const now = nowMs();
  // A node whose layout key is unchanged is re-read at most this often: cheap
  // insurance against a child that changed size without touching the node.
  if (!force && hit && hit.root === root && hit.key === key) {
    // A node with a picture held is measured at the slower beat: what is on screen
    // is the picture, and this read exists to notice that the *element* changed
    // shape. A node with no picture is drawn live from these numbers, so it keeps
    // the tight beat.
    const snap = LOD.snaps ? LOD.snaps.get(node) : null;
    const watched = lodVueWatched(node);
    const beat = watched
      ? LOD_VUE_MEDIA_MS_WATCHED
      : snap && snap.canvas
        ? LOD_VUE_MEDIA_MS_IDLE
        : LOD_VUE_MEDIA_MS;
    if (now - hit.at < beat) return hit;
    if (!lodVueMediaBudget()) return hit; // this frame's ration is spent
  }
  LOD.vueLayoutReads++; // one measurement: a root rect plus the elements inside it
  let els = [];
  try {
    els = root.querySelectorAll("img,canvas") || [];
  } catch (e) {
    els = [];
  }
  const title = Number((typeof LiteGraph !== "undefined" && LiteGraph && LiteGraph.NODE_TITLE_HEIGHT) || 30);
  let rr = null;
  try {
    rr = typeof root.getBoundingClientRect === "function" ? root.getBoundingClientRect() : null;
  } catch (e) {
    rr = null;
  }
  // The zoom the *element* is actually laid out at — see lodVueDomScale. Nothing
  // here reads `canvas.ds.scale` unless the DOM itself could not be measured: a
  // capture sets that to 1 while the DOM keeps the transform the frontend gave it,
  // and dividing a client-pixel rect by the wrong zoom puts the content at the
  // wrong size, outside the box it belongs in.
  const measured = lodVueDomScale(node, canvas, root, rr, wUnits);
  const domScale = measured.scale;
  LOD.vueScaleNow = domScale;
  LOD.vueScaleFrom = measured.from;
  const items = [];
  let boxH = 0;
  if (rr) {
    // The element's own height, in node-local units. The graph size is not the
    // rendered size here: `LGraphNode.vue` adds IMAGE_PREVIEW_HEIGHT_RESERVE
    // (220 + 8 + 4 px — imagePreviewLayout.ts) to a node's element when it shows
    // a picture and has an expanding widget, so a box built from `node.size`
    // clips exactly the picture the user asked to see.
    const domH = Number(rr.height) / domScale - title;
    if (Number.isFinite(domH) && domH > 1) boxH = domH;
    for (const el of els) {
      const tag = String((el && el.tagName) || "").toUpperCase();
      if (tag !== "IMG" && tag !== "CANVAS") continue;
      let r = null;
      try {
        r = typeof el.getBoundingClientRect === "function" ? el.getBoundingClientRect() : null;
      } catch (e) {
        r = null;
      }
      if (!r) continue;
      const w = Number(r.width) / domScale;
      const h = Number(r.height) / domScale;
      // A box with no area is a hidden or detached element: nothing to draw.
      if (!(w > 1) || !(h > 1)) continue;
      const x = (Number(r.left) - Number(rr.left)) / domScale;
      // The node's element starts one title bar above the node's own origin, and
      // the box is drawn at that origin (LiteGraph translates to node.pos).
      const y = (Number(r.top) - Number(rr.top)) / domScale - title;
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      items.push({ el, x, y, w, h });
    }
  }
  const texts = rr ? lodVueTextLines(root, rr, domScale, title) : [];
  // The widgets the frontend mounts *inside* the node's element (WidgetDOM.vue does
  // `domEl.replaceChildren(widget.element)` in this renderer). Their rows are laid
  // out by the browser, not by LiteGraph's `arrange()` — in this renderer the canvas
  // never draws a widget — so where a widget's content belongs in the picture is a
  // measurement, exactly like the node's own images. Drawing them at the canvas
  // rows a widget would only have if the canvas renderer were drawing is how a
  // picture ends up with its prompt text in the wrong place, or stacked at the top.
  const wboxes = rr ? lodVueWidgetBoxes(node, root, rr, domScale, title) : [];
  // The node's own structure — frame, header, body panel, slot dots — measured in
  // the same pass: a picture without them is a sketch of the node, not the node.
  const chrome = rr ? lodVueChromeBoxes(node, root, rr, domScale, title) : [];
  LOD.vueChromeNow = chrome.length; // what the last measurement read, kept until the next one
  const rec = { root, key, scale: domScale, at: now, items, boxH, texts, wboxes, chrome, opacity: lodVueOpacity(root) };
  cache.set(node, rec);
  return rec;
}

// The media list alone, for the callers that only draw it.
function lodVueMediaBoxes(node, canvas, force) {
  const rec = lodVueRootMetrics(node, canvas, force);
  return rec ? rec.items : null;
}

// The box a Vue node's stand-in has to cover: the box the frontend actually
// rendered. Never a fresh measurement — this is called per boxed node per frame,
// while painting, and the measurement is owned by lodVueRootMetrics (which the
// signature, the content draw and every capture already ask for). No
// measurement yet means the graph size, which is what the canvas renderer would
// have drawn.
function lodVueBoxSize(node, canvas, boxH) {
  const size = (node && (node.renderingSize || node.size)) || [0, 0];
  const w = Math.abs(Number(size[0])) || 0;
  const h = Math.abs(Number(size[1])) || 0;
  if (!lodVueNodesMode() || !node) return [w, h];
  // A caller that has just measured the element passes the number it measured; a
  // caller that has not reads the cached one. The capture passes it, which is what
  // makes the surface, the box and the ink come from one measurement.
  const rec = LOD.vueMedia ? LOD.vueMedia.get(node) : null;
  const domH = Number.isFinite(Number(boxH)) && Number(boxH) > 0 ? Number(boxH) : rec && Number(rec.boxH);
  // A sane band around the graph size: the frontend's reserve is a couple of
  // hundred pixels, so a measurement many times the node's own height is a layout
  // this tool misread (a zoom mid-flight, a collapsed element) and the graph size
  // is the safer answer.
  if (!(domH > h + 2) || domH > h * 4 + 1024) return [w, h];
  return [w, domH];
}

// The picture a Vue-nodes box is made of. In the canvas renderer a capture is
// LiteGraph drawing the node into an offscreen canvas; here LiteGraph draws
// nothing, so the tool draws what the live box draws — the box, its title bar and
// state marks, and the node's own content — into the capture surface. Same
// geometry, same ratio, same mip chain, same disk file, so a picture made in this
// renderer is a picture in every way except that its chrome is drawn by this tool
// rather than photographed from LiteGraph.
function lodVueCapturePaint(node, canvas, ctx, geom) {
  const out = { ink: 0, text: 0, skipped: 0, els: [] };
  try {
    // One measurement for the whole capture: the surface was sized from `geom`, so
    // the box is drawn at exactly the surface's body (not at whatever the layout
    // says a moment later), and the ink is read from the same fresh measurement.
    const metrics = lodVueRootMetrics(node, canvas, true);
    const size = geom ? [geom.bodyW, geom.bodyH] : metrics && metrics.boxH > 0 ? [(node && (node.renderingSize || node.size) || [0, 0])[0], metrics.boxH] : null;
    // The node's composited opacity, read with the measurement this capture is built
    // from (never per frame), goes into the picture through the painter: a muted node
    // stays muted, a node being dragged becomes the faint ghost the frontend makes it,
    // and the effect survives on the canvas because the picture is what is drawn
    // there. (The picture replaces the element, so a picture that ignored this would
    // not just look wrong — the dimming would never happen at all.)
    const op = metrics && Number.isFinite(Number(metrics.opacity)) ? Number(metrics.opacity) : NaN;
    lodPaintNode(
      node,
      canvas,
      ctx,
      // The same ink the live box paints, through the same function — the picture
      // is what the box would have drawn, frozen. The measurement above filled the
      // cache this reads, so it is one pass, not two.
      () => lodVueContentInk(node, canvas, ctx, out),
      LOD_BOX_DETAIL[2],
      size,
      op
    );
  } catch (e) {
    /* the box is painted first; content that cannot be drawn is skipped */
  }
  return out;
}

// What can honestly be drawn of a Vue node's content, in the box that stands in
// for it. This is the same composite the canvas renderer's *capture* makes — an
// image or a canvas pixel for pixel, a text field's value re-painted in the
// theme's colours, a pack's own HTML left blank — aimed at the live frame canvas
// instead of an offscreen bitmap. That is the closest thing to a picture this
// renderer can have: what the node shows is drawn where the node is. No browser
// API draws a DOM element into a canvas, so the parts that are neither an image,
// a canvas nor a plain string stay blank and are counted.
function lodVueBoxContent(node, canvas, ctx) {
  const out = lodVueContentInk(node, canvas, ctx);
  if (out.ink) LOD.vueContentNow += out.ink;
  if (out.media) LOD.vueMediaNow += out.media;
  if (out.text) LOD.vueTextNow += out.text;
  return out.ink;
}

// Everything a Vue node's content is made of, in one place, so the live box and the
// picture drawn for it can never drift apart. Three routes, in the order a browser
// would paint them:
//
//   1. the text the frontend renders inside the node — labels and values it draws
//      itself, the title, badges — re-painted from the strings the DOM holds, at
//      the positions the browser laid them out in;
//   2. the widgets that carry their own element (a prompt's textarea and anything a
//      pack added), at the row geometry the frontend positions them by;
//   3. the node's own rendered pictures and canvases, at the position the browser
//      laid them out in. What an earlier route already drew is skipped, so nothing
//      is drawn twice.
function lodVueContentInk(node, canvas, ctx, into) {
  const out = into || { ink: 0, text: 0, skipped: 0, els: [] };
  const metrics = lodVueRootMetrics(node, canvas);
  if (metrics) {
    const before = out.chrome || 0;
    lodVueChromeInk(ctx, metrics.chrome, out);
    LOD.vueChrome += (out.chrome || 0) - before; // the readout asks how much of the node is in the picture
  }
  if (metrics && metrics.wboxes && metrics.wboxes.length) {
    const beforeW = out.widget || 0;
    lodVueChromeInk(ctx, metrics.wboxes, out, "widget");
    LOD.vueWidgetInk += (out.widget || 0) - beforeW; // how much of the node's widget row is in the picture
  }
  if (metrics) {
    const beforeC = out.control || 0;
    lodVueTextInk(ctx, metrics.texts, out);
    LOD.vueControlInk += (out.control || 0) - beforeC; // values drawn as their own control (a slider, a tick, a swatch)
  }
  lodSnapDomInk(node, ctx, canvas, out, metrics ? metrics.wboxes : null);
  const boxes = metrics ? metrics.items : null;
  if (boxes) {
    for (const it of boxes) {
      const el = it.el;
      if (out.els.indexOf(el) >= 0) continue;
      const wpx = Number(el.naturalWidth || el.width) || 0;
      const hpx = Number(el.naturalHeight || el.height) || 0;
      if (!(wpx > 0) || !(hpx > 0)) {
        out.skipped++; // an image that has not arrived yet, or a canvas with no surface
        continue;
      }
      try {
        ctx.drawImage(el, it.x, it.y, it.w, it.h);
        out.ink++;
        out.media = (out.media || 0) + 1;
      } catch (e) {
        out.skipped++;
      }
    }
  }
  return out;
}

// Hand every blanked element back. Called when the zoom leaves the setting, when
// the renderer changes, and when the tool or the setting is switched off: this
// tool must never leave a node invisible because a setting moved under it.
function lodVueUnblankAll(reason) {
  const set = LOD.vueFlat;
  if (!set || !set.size) return 0;
  let n = 0;
  for (const node of [...set]) if (lodVueBlank(node, false)) n++;
  if (n) {
    LOD.vueRestored += n;
    LOD.vueCleared = String(reason || "off");
  }
  return n;
}

// Once a frame, before the canvas draws. Blanking itself happens on the node the
// canvas is drawing, so nothing walks the graph here in the steady state; this
// only turns the whole set back when the boxes stop standing in for anything.
// Above the threshold (or with the setting or the tool off) the sweep is a single
// comparison, which is what makes a stale class impossible to leave behind.
function lodVueFramePlan(canvas) {
  LOD.vueContentNow = 0; // gauges of the last frame, not running totals
  LOD.vueMediaNow = 0;
  LOD.vueTextNow = 0;
  LOD.vueMediaLeft = LOD_VUE_MEDIA_BUDGET; // this frame's layout-read ration
  // The same predicate the draw loop uses, not a second opinion about it.
  const flat = lodVuePathOn(canvas);
  const prev = LOD.vueFlatOn;
  LOD.vueFlatOn = flat;
  const set = LOD.vueFlat;
  if (!set || !set.size) return 0;
  if (flat && prev === true) return 0; // steady state: the drawn node decides
  let n = 0;
  for (const node of [...set]) {
    if (flat && lodVueFlatNode(node, canvas)) continue; // still standing in
    if (lodVueBlank(node, false)) n++;
  }
  if (n) {
    LOD.vueRestored += n;
    LOD.vueCleared = flat ? "one of them came back" : LOD.snapOn ? "zoom" : "setting";
  }
  return n;
}

// Can this node be photographed at all — and if not, why not? Only two answers
// keep a node live on purpose now: this tool's own node, and a type the user asked
// to keep live. Everything else the canvas draws is captured.
//
// This is deliberately *less* conservative than the tool this feature learned from
// (ComfyUI-NodeSnapshots keeps a node with a DOM widget, a function-valued value
// or a very long string live for good — and its own issue #1 is the report that
// custom nodes then never get a picture). A DOM widget or an image preview is
// drawn by the browser *over* the node, so the picture is the canvas part — the
// frame, the title, the slots, and whatever the canvas still draws — and the
// readout counts those pictures separately. A very long string only ever made the
// signature dearer to hash, which is a hashing problem, not an honest reason to
// keep a node live; and a `custom` widget is canvas ink by definition. What a node
// does with a value somebody rewrites under us is the churn guard's business.
function lodSnapKeepLive(node) {
  try {
    if (!node) return "";
    if (lodOwnNode(node)) return "this tool's own node";
    const type = node.type || node.comfyClass;
    if (type && LOD.snapExclude.indexOf(String(type)) >= 0) return `kept live by your list (${type})`;
  } catch (e) {
    /* an unreadable node is captured, and fails there where the panel can count it */
  }
  return "";
}

// Is part of this node drawn by the browser instead of the canvas? Then the
// capture has to composite that part in (lodSnapDomInk), and the readout says
// what it managed to draw and what it could not — a picture with a blank where an
// image preview sits is still a better stand-in than a rectangle, and one with
// the image in it is better again.
function lodSnapPartial(node) {
  const widgets = node && node.widgets;
  if (!widgets) return false;
  for (let i = 0; i < widgets.length; i++) {
    const w = widgets[i];
    if (!w) continue;
    if (w.element) return true; // an element drawn over the node
    if (w.type === "dom") return true; // the frontend's own DOM-widget marker
  }
  return false;
}

// The padded rectangle a capture covers, in graph units, and the body the node
// itself reports. Position and zoom are deliberately absent: they are the camera,
// not the node.
function lodSnapGeometry(node, canvas, boxH) {
  const size = lodVueBoxSize(node, canvas, boxH) || (node && (node.renderingSize || node.size));
  if (!size) return null;
  const w = Math.abs(Number(size[0])) || 0;
  const h = Math.abs(Number(size[1])) || 0;
  if (!(w > 0) || !(h > 0)) return null;
  return {
    x: -LOD_SNAP_PAD,
    y: -LOD_SNAP_TITLE_H - LOD_SNAP_PAD,
    w: w + LOD_SNAP_PAD * 2,
    h: h + LOD_SNAP_TITLE_H + LOD_SNAP_PAD * 2,
    bodyW: w,
    bodyH: h,
  };
}

// The largest ratio on the ladder that keeps the capture inside the dimension cap,
// never more than the user asked for. A tall node used to be skipped outright
// (upstream's behaviour, and this tool's until v2.3.1, where it was re-attempted
// on every slice). At 10% zoom a node captured at 1x still has ten times the
// pixels the screen shows, so fitting it is worth far more than skipping it, and
// the readout counts how many were fitted. 0 means no ratio fits: too big.
// Automatic coarsening stops at 1x unless the user asked for a smaller capture.
// 0.25x and 0.5x are settings, not the fallback that fills a tight budget.
function lodSnapCoarseFloor(want) {
  const asked = Number(want);
  return asked > 0 && asked < 1 ? asked : 1;
}

function lodSnapFitRatio(geom, want) {
  const asked = Number(want) || 1;
  const ratio = Math.max(LOD_SNAP_RATIOS[0], Math.min(LOD_SNAP_RATIOS[LOD_SNAP_RATIOS.length - 1], asked));
  const floor = lodSnapCoarseFloor(asked);
  const longest = Math.max(geom.w, geom.h);
  if (!(longest > 0)) return 0;
  for (let i = LOD_SNAP_RATIOS.length - 1; i >= 0; i--) {
    const r = LOD_SNAP_RATIOS[i];
    if (r > ratio + 1e-9) continue;
    if (r + 1e-9 < floor) continue;
    if (Math.ceil(longest * r) <= LOD_SNAP_MAX_DIM) return r;
  }
  return 0;
}

function lodSnapBytesFor(geom, ratio) {
  return Math.ceil(geom.w * ratio) * Math.ceil(geom.h * ratio) * 4;
}

// The pixels-per-graph-unit a capture is actually drawn at. This used to be
// `Math.max(1, ratio)` — correct while every ratio on the ladder was 1 or more,
// and a silent lie the moment 0.25x and 0.5x became settings (v2.5.2): the canvas
// was built at 1x whatever the user asked, so the picture cost four to sixteen
// times the memory the budget had been told to reserve for it, and the setting
// below 1x did nothing at all. Both the render and the ink probe use this, so
// they always agree about the surface they are looking at.
function lodSnapPixelRatio(ratio) {
  const r = Number(ratio);
  if (!Number.isFinite(r) || r <= 0) return LOD_SNAP_RATIO_DEFAULT;
  return Math.min(LOD_SNAP_RATIOS[LOD_SNAP_RATIOS.length - 1], Math.max(LOD_SNAP_RATIOS[0], r));
}

// One record, marked so the node is never attempted again this session, plus the
// reason. Six different answers end here, so they end here in one place.
function lodSnapBlockNode(node, rec, why) {
  let r = rec;
  if (!r) {
    r = { sig: "", checkedAt: 0, bytes: 0, canvas: null };
    LOD.snaps.set(node, r);
  }
  r.blocked = true;
  r.why = why;
  return r;
}

// The names behind the "not pictured" counters. A count says how many; the name
// says *which*, and at a thousand nodes that is the difference between a number
// the user cannot act on and one they can.
function lodSnapNoteWhy(node, why) {
  try {
    if (!LOD.snapWhySeen) LOD.snapWhySeen = new WeakMap();
    if (!LOD.snapWhy) LOD.snapWhy = [];
    const text = String(why);
    const seen = LOD.snapWhySeen.get(node);
    if (seen) {
      // The node is named once, but its reason has to stay current: a cooldown that
      // doubled would otherwise leave the readout promising a try that already
      // happened ("another try in 10s" after the retry is scheduled for 20s).
      seen.why = text;
      return;
    }
    if (LOD.snapWhy.length >= LOD_SNAP_WHY_MAX) return;
    const entry = {
      type: String(node.type || node.comfyClass || "?"),
      title: String(node.title || ""),
      why: text,
    };
    LOD.snapWhySeen.set(node, entry);
    LOD.snapWhy.push(entry);
  } catch (e) {
    /* naming a node is never worth a fault */
  }
}

// How much of what this mode remembered actually has a picture right now — the
// number a user is really asking for when they ask how far it got. Walked on the
// readout's own clock, never per frame.
function lodSnapPictured() {
  let n = 0;
  if (LOD.snaps) {
    for (const [, rec] of LOD.snaps) if (rec.canvas) n++;
  }
  return n;
}

// The names behind the counters, for the panel and the copied report.
function lodSnapWhyText() {
  if (!LOD.snapWhy || !LOD.snapWhy.length) return "";
  const names = LOD.snapWhy.map((e) => `"${e.title || e.type}" (${e.why})`);
  const more = LOD.snapWhy.length >= LOD_SNAP_WHY_MAX ? ", and the counters above have the rest" : "";
  return `not pictured: ${names.join(", ")}${more}`;
}

// Everything that changes what a node draws, hashed without allocating. Upstream
// builds a JSON string per node; this is a rolling hash instead, because at a
// thousand nodes the string is the expensive part.
//
// Deliberately NOT in here: position, the pan, and the zoom. Those change while
// you look at the node and change nothing about the picture — including them
// would throw the work away on every frame of a pan, which is exactly when it is
// worth having. `progress`, `has_errors` and the node's own flags are in, even
// though those nodes stay live anyway, so a bitmap can never be used after one of
// them starts.
function lodSnapSignature(node, canvas) {
  let h = 2166136261;
  const mix = (n) => {
    h ^= n | 0;
    h = Math.imul(h, 16777619);
  };
  const num = (v) => {
    const n = Number(v);
    if (Number.isFinite(n)) mix(Math.round(n * 100));
    else mix(0);
  };
  // A long string is hashed by its length and its two ends: the head because that
  // is the part a node's canvas actually draws (a text widget is clipped to its
  // row), and the tail because that is where a growing payload changes. Walking a
  // 40 kB data URL or a serialized link graph in full on every re-check was the
  // real reason this tool used to refuse such nodes outright; refusing was never
  // about the picture.
  const str = (v) => {
    const s = v == null ? "" : String(v);
    mix(s.length);
    if (s.length <= 512) {
      for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 16777619);
      }
      return;
    }
    for (let i = 0; i < 256; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    for (let i = s.length - 64; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
  };
  const flag = (v) => mix(v ? 1 : 0);

  str(node.title);
  const size = node.renderingSize || node.size;
  num(size && size[0]);
  num(size && size[1]);
  const flags = node.flags || {};
  flag(flags.collapsed);
  flag(flags.ghost);
  flag(flags.pinned);
  num(node.mode);
  num(node.shape !== undefined ? node.shape : node.renderingShape);
  num(node.title_mode);
  str(node.renderingColor || node.color);
  str(node.renderingBgColor || node.bgcolor);
  str(node.boxcolor);
  flag(node.has_errors);
  num(node.progress);
  // `selected` is deliberately absent. The ring is drawn on top of the picture
  // at blit time, and the capture clears the flag so it is not baked in. In the
  // signature it would mean dropping and recapturing a bitmap every click.
  // Connections, without walking them: a slot count changes when a link is added
  // or removed, and the count is the cheap part of that.
  num(node.inputs ? node.inputs.length : 0);
  num(node.outputs ? node.outputs.length : 0);
  str(node._collapsed_width);
  // In the Vue-nodes renderer the node's own pictures and canvases are drawn into
  // its stand-in (see lodVueMediaBoxes), so they have to invalidate it the same
  // way a widget value does: a new image in a loader, a mask editor redrawing,
  // an element replaced. The serial catches a replacement whose strings match;
  // the numbers catch the layout moving.
  if (lodVueNodesMode()) {
    // One measurement, asked for once: what the node's element is showing. This is
    // the picture's content, so it is the picture's signature — and *everything* a
    // Vue picture draws belongs here. What was missing was the node's own text and
    // the element's rendered height: a node whose title and labels render a moment
    // after the element exists (which is every node on a real page) was photographed
    // as a bare box and, because nothing about it changed as far as the signature
    // was concerned, that first picture was served for the rest of the session.
    // That is the "captured too early, never fully" a user sees.
    const metrics = lodVueRootMetrics(node, canvas, false);
    num(metrics && metrics.boxH ? metrics.boxH : 0);
    // The composited opacity is part of the picture now (it is baked into the
    // capture), so it invalidates it: mute, bypass and the drag ghost each change
    // what the picture has to look like.
    num(metrics && metrics.opacity !== undefined ? metrics.opacity : 1);
    const items = metrics ? metrics.items : null;
    num(items ? items.length : 0);
    // The structure is part of the picture: a frame that arrives, a header that
    // moves or a slot dot that turns up makes a different node. Each number is
    // mixed into the hash, not written into a string, so carrying the whole
    // structure costs a few multiplies per check.
    const chrome = (metrics && metrics.chrome) || null;
    num(chrome ? chrome.length : 0);
    if (chrome) {
      for (let i = 0; i < chrome.length && i < LOD_VUE_CHROME_MAX; i++) {
        const c = chrome[i];
        num(c && c.x);
        num(c && c.y);
        num(c && c.w);
        num(c && c.h);
      }
    }
    const wboxes = (metrics && metrics.wboxes) || null;
    num(wboxes ? wboxes.length : 0);
    if (wboxes) {
      for (let i = 0; i < wboxes.length && i < LOD_SNAP_DOM_MAX; i++) {
        const b = wboxes[i];
        // Where the browser put a widget row: a picture drawn before the frontend had
        // laid the widgets out would carry them at row 0 for the rest of the session.
        num(b && b.x);
        num(b && b.y);
        num(b && b.w);
        num(b && b.h);
      }
    }
    const lines = (metrics && metrics.texts) || null;
    num(lines ? lines.length : 0);
    if (lines) {
      for (let i = 0; i < lines.length && i < LOD_VUE_TEXT_MAX; i++) {
        const tx = lines[i];
        // The string is what the picture shows, so it is what invalidates it. Hashed
        // by its ends rather than in full: a label is one line, and a very long one
        // differs where the reader looks (the head) and where it grows (the tail).
        str(tx && tx.text);
        num(tx && tx.x);
        num(tx && tx.y);
        num(tx && tx.size);
      }
    }
    if (items) {
      for (let i = 0; i < items.length && i < LOD_SNAP_DOM_MAX; i++) {
        const it = items[i];
        const el = it.el;
        num(lodVueElSeq(el));
        num(it.x);
        num(it.y);
        num(it.w);
        num(it.h);
        if (el) {
          str(el.currentSrc || el.src);
          flag(el.complete);
          num(el.naturalWidth || el.width);
          num(el.naturalHeight || el.height);
        }
      }
    }
  }
  const sub = node.subgraph;
  num(sub && sub._version);

  const widgets = node.widgets;
  if (widgets) {
    num(widgets.length);
    for (let i = 0; i < widgets.length; i++) {
      const w = widgets[i];
      if (!w) continue;
      str(w.name);
      str(w.type);
      const v = w.value;
      if (typeof v === "number") num(v);
      else if (typeof v === "boolean") flag(v);
      else if (typeof v === "string") str(v);
      else if (typeof v === "function") str(Function.prototype.toString.call(v));
      else str(v === undefined || v === null ? "" : "[object]");
      flag(w.disabled);
      flag(w.hidden);
      str(w.options && w.options.values ? "enum" : "");
    }
  }

  // Images a node draws into itself are not widget values, but they *are* what its
  // picture shows: an image node photographed before its image loaded would keep
  // an empty frame in the picture for as long as the signature matched. `complete`
  // is the moment the drawing changes, and the source is hashed by its ends (a
  // data URL is long, and its ends are what differ).
  // The DOM widgets are part of the picture (lodSnapDomInk draws them in), so
  // what they are *showing* has to invalidate it the same way a widget value
  // does. `w.value` covers what the frontend syncs; this covers the rest — an
  // image whose source changed, a canvas that resized, a textarea whose text has
  // not been committed to the widget yet. Bounded per widget, and hashed by the
  // same head-and-tail rule as any other string.
  if (widgets) {
    for (let i = 0; i < widgets.length && i < LOD_SNAP_DOM_MAX; i++) {
      const w2 = widgets[i];
      const el = w2 && (w2.element || w2.inputEl);
      if (!el || typeof el !== "object" || !el.tagName) continue;
      const tag = String(el.tagName).toUpperCase();
      mix(tag.length);
      if (tag === "IMG") {
        str(el.currentSrc || el.src);
        flag(el.complete);
        num(el.naturalWidth);
        num(el.naturalHeight);
      } else if (tag === "CANVAS") {
        num(el.width);
        num(el.height);
      } else if (tag === "TEXTAREA" || tag === "INPUT") {
        str(el.value);
      }
      // The row the composite draws this element at. `lodSnapWidgetBox` reads the
      // frontend's own layout (`y`, `computedHeight`, `width`, `margin`), and that
      // layout is not final the moment the element exists — a capture taken before
      // `arrange()` has settled would bake every widget at row 0, and the picture
      // would never be re-made.
      num(w2.y !== undefined ? w2.y : w2.last_y);
      num(w2.computedHeight);
      num(w2.width);
      num(w2.margin);
      flag(!!el.hidden);
    }
  }

  const imgs = node.imgs || node.images;
  if (imgs && imgs.length) {
    // v2.5.1: the capture waits one turn so a preview that draws its image in a
    // microtask is in the bitmap. Files saved before that wait match this node's
    // images and still have an empty frame. This token makes those files miss,
    // so the next idle lane photographs them again. Nodes with no image are
    // unchanged, and their files still hit.
    str("img-defer-1");
    mix(imgs.length);
    const imax = Math.min(imgs.length, LOD_SNAP_IMGS_MAX);
    for (let i = 0; i < imax; i++) {
      const im = imgs[i];
      flag(im && im.complete);
      num(im && (im.naturalWidth || im.width));
      num(im && (im.naturalHeight || im.height));
      str(im && (im.currentSrc || im.src));
    }
  }

  // What is deliberately NOT hashed here, and why:
  //   * the canvas's own flags and the LiteGraph theme constants. They are not the
  //     node's state, and another extension flips `render_shadows` around every
  //     gesture (see NodeSnapshots' "simplify during navigation"), so hashing them
  //     would invalidate every bitmap in the cache twice a gesture. A change that
  //     matters is caught cheaply at reuse time instead (lodSnapPaint compares the
  //     shadow flag and falls back to the box), and a real theme change clears the
  //     whole cache once, from lodSnapThemeSig on the sweep.
  //   * the camera: position, pan and zoom. A node does not change because you
  //     looked at it from somewhere else, and a pan is exactly when these
  //     pictures are worth having.
  // The renderer is part of the signature, not an accident of it: in the canvas
  // renderer a picture is LiteGraph's own drawing, in the Vue renderer it is this
  // tool's drawing of the node's DOM, and the two are different pictures in every
  // way that matters (box, padding, content route). Mixing the pathway in means a
  // picture made in one can never be trusted in the other, whatever order the user
  // switches renderers in.
  str(lodVueNodesMode() ? "pathway-vue" : "pathway-canvas");
  void canvas;
  return (h >>> 0).toString(36);
}

// A whole-theme signature, checked on the idle lane rather than per node. A theme
// change repaints every node differently, so every stored bitmap is worthless —
// and finding that out one signature at a time would cost a frame of boxes each.
function lodSnapThemeSig() {
  try {
    let s = "";
    if (typeof LiteGraph !== "undefined" && LiteGraph) {
      for (const k of [
        "NODE_DEFAULT_COLOR",
        "NODE_DEFAULT_BGCOLOR",
        "NODE_TITLE_COLOR",
        "NODE_SELECTED_TITLE_COLOR",
        "NODE_TEXT_COLOR",
        "NODE_ERROR_COLOUR",
        "NODE_TEXT_SIZE",
        "NODE_TITLE_HEIGHT",
        "nodeOpacity",
        "nodeLightness",
        "DEFAULT_SHADOW_COLOR",
      ]) {
        s += `${k}=${LiteGraph[k]};`;
      }
    }
    const doc = typeof document !== "undefined" && document ? document : null;
    for (const el of [doc && doc.documentElement, doc && doc.body]) {
      if (!el) continue;
      s += `${el.className || ""}|`;
      const style = el.style;
      if (style) {
        // Inline custom properties (`--p-*`): the palettes set these inline, which
        // is why reading them does not need getComputedStyle.
        for (const k of Object.keys(style)) if (k.indexOf("--") === 0) s += `${k}:${style[k]};`;
      }
    }
    return s;
  } catch (e) {
    return "";
  }
}

// Was this bitmap drawn in the last LOD_SNAP_GUARD_FRAMES frames? If so it is on
// screen and must never be released to make room for something else.
function lodSnapProtected(rec) {
  const f = Number(rec && rec.usedFrame);
  if (!Number.isFinite(f)) return false;
  return LOD.snapFrame - f < LOD_SNAP_GUARD_FRAMES;
}

function lodSnapEnsure() {
  if (!LOD.snaps) LOD.snaps = new Map();
  if (!LOD.snapQueue) LOD.snapQueue = new Set();
  return true;
}

function lodSnapZeroCanvas(el) {
  if (!el) return;
  try {
    el.width = 0;
    el.height = 0;
  } catch (e) {
    /* a canvas that refuses to shrink is still dropped from the cache */
  }
}

function lodSnapRelease(rec) {
  if (!rec) return;
  if (rec.mips) {
    for (const key of Object.keys(rec.mips)) {
      if (rec.mips[key] && rec.mips[key] !== rec.canvas) lodSnapZeroCanvas(rec.mips[key]);
    }
    rec.mips = null;
  }
  lodSnapZeroCanvas(rec.canvas);
  LOD.snapBytes = Math.max(0, LOD.snapBytes - (Number(rec.bytes) || 0));
  rec.canvas = null;
  rec.bytes = 0;
  rec.sig = "";
}

// A rendered bitmap that is *not* going to be stored: zero the canvas so the pixels
// go back, and touch nothing else. `lodSnapRelease` is for a *record* — it also
// subtracts the bytes from the budget, and calling it on something that was never
// added (a freshly rendered capture) leaves the budget under-reporting itself.
function lodSnapDiscard(made) {
  if (!made || !made.canvas) return;
  try {
    made.canvas.width = 0;
    made.canvas.height = 0;
  } catch (e) {
    /* dropping the reference is all that is left */
  }
  made.canvas = null;
}

function lodSnapDrop(node, why) {
  const rec = LOD.snaps && LOD.snaps.get(node);
  if (!rec) return null;
  if (rec.canvas) lodSnapRelease(rec);
  rec.why = why || rec.why;
  LOD.snaps.delete(node);
  return rec;
}

// A RAM release must be able to load the same file again. Forgetting the "already
// asked" mark does not delete the file.
function lodThumbDiskForget(node) {
  if (!LOD.diskAsked) return;
  let id = "";
  try {
    id = lodThumbId(node);
  } catch (e) {
    return;
  }
  if (!id) return;
  for (const key of [...LOD.diskAsked]) {
    if (String(key).startsWith(id + "\0")) LOD.diskAsked.delete(key);
  }
}

// System RAM from ComfyUI's own /system_stats. No reading, no release.
async function lodRamSample() {
  try {
    if (typeof fetch !== "function") {
      LOD.ramUsed = null;
      LOD.ramNote = "system RAM unknown — no fetch, so nothing was released";
      return null;
    }
    const res = await fetch("/system_stats");
    if (!res || !res.ok || typeof res.json !== "function") {
      LOD.ramUsed = null;
      LOD.ramNote = "system RAM unknown — /system_stats did not answer, so nothing was released";
      return null;
    }
    const body = await res.json();
    const sys = body && body.system;
    const total = Number(sys && sys.ram_total) || 0;
    const free = Number(sys && (sys.ram_free != null ? sys.ram_free : sys.ram_available));
    if (!(total > 0) || !Number.isFinite(free) || free < 0 || free > total) {
      LOD.ramUsed = null;
      LOD.ramNote = "system RAM unknown — /system_stats had no ram_total and ram_free, so nothing was released";
      return null;
    }
    const used = 1 - free / total;
    LOD.ramUsed = used;
    LOD.ramNote = "";
    return used;
  } catch (e) {
    LOD.ramUsed = null;
    LOD.ramNote = "system RAM unknown — the stats request failed, so nothing was released";
    return null;
  }
}

function lodSnapPurgeRam(all) {
  if (!LOD.snaps) return 0;
  const canvas = typeof app !== "undefined" && app ? app.canvas : null;
  const area = !all && canvas ? viewArea(canvas, 0) : null;
  if (!all && !area) return 0; // cannot tell off-screen from on-screen: release nothing
  let n = 0;
  for (const node of [...LOD.snaps.keys()]) {
    const rec = LOD.snaps.get(node);
    if (!rec || !rec.canvas) continue;
    if (!all && viewTouchesArea(node, area)) continue;
    lodThumbDiskForget(node);
    lodSnapDrop(node, all ? "ram full" : "ram off-screen");
    n++;
  }
  if (n) {
    LOD.ramPurged = (LOD.ramPurged || 0) + n;
    LOD.ramLast = all ? "full" : "off-screen";
  }
  return n;
}

async function lodRamCheck() {
  const used = await lodRamSample();
  if (used == null) return { used: null, purged: 0 };
  if (used >= LOD_RAM_FULL) return { used, purged: lodSnapPurgeRam(true) };
  if (used >= LOD_RAM_OFF) return { used, purged: lodSnapPurgeRam(false) };
  return { used, purged: 0 };
}

async function lodRamFinish() {
  LOD.ramRunning = false;
  const used = await lodRamSample();
  const canvas = typeof app !== "undefined" && app ? app.canvas : null;
  if (!canvas || !lodSnapBitmaps(canvas)) return 0;
  const nodes = lodGraphNodes(canvas);
  if (!nodes) return 0;
  const area = viewArea(canvas, 0);
  const tight = used != null && used >= LOD_RAM_OFF;
  let n = 0;
  for (const node of nodes) {
    const rec = LOD.snaps && LOD.snaps.get(node);
    if (rec && rec.canvas) continue;
    // Still tight: bring back what is on screen. The rest stays on disk until
    // the view asks for it. A miss is photographed again on the idle lane.
    if (tight && area && !viewTouchesArea(node, area)) continue;
    lodSnapEnqueue(node, canvas);
    n++;
  }
  LOD.ramReloaded = (LOD.ramReloaded || 0) + n;
  return n;
}

function lodRamRun(starting) {
  if (!starting) return lodRamFinish();
  LOD.ramRunning = true;
  if (!LOD.ramTimer) {
    try {
      LOD.ramTimer = govOwn(() => setInterval(() => {
        if (LOD.ramRunning) lodRamCheck();
      }, 2000));
    } catch (e) {
      /* one check on start is still the policy */
    }
  }
  return lodRamCheck();
}

function lodInstallRamWatch() {
  try {
    const api = app && app.api;
    if (!api || typeof api.addEventListener !== "function" || LOD.ramWatch) {
      if (!LOD.ramWatch) LOD.ramNote = LOD.ramNote || "run watch: no execution events on this page, so a run will not release stand-ins";
      return false;
    }
    LOD.ramWatch = true;
    api.addEventListener("execution_start", () => {
      try { lodRamRun(true); } catch (e) { /* fail open */ }
    });
    const end = () => {
      try { lodRamFinish(); } catch (e) { /* fail open */ }
    };
    api.addEventListener("execution_success", end);
    api.addEventListener("execution_error", end);
    api.addEventListener("execution_interrupted", end);
    return true;
  } catch (e) {
    return false;
  }
}

// Everything, because the stored bitmaps describe a theme that no longer exists.
function lodSnapClear(reason) {
  lodSnapEnsure();
  for (const [, rec] of LOD.snaps) lodSnapRelease(rec);
  LOD.snaps.clear();
  LOD.snapQueue.clear();
  LOD.snapBytes = 0;
  LOD.snapPumping = false;
  // A cleared cache is a fresh start for the bookkeeping too: which nodes were
  // left as boxes, and why, is about the bitmaps that no longer exist.
  LOD.snapDrops = null;
  LOD.snapWhy = null;
  LOD.snapWhySeen = null;
  if (reason) LOD.snapClears++;
}

// Enforce the budget. `force` is for a user who has just lowered it: then the
// number they picked wins, and even a bitmap in use is released (the node falls
// back to its box, and captures stop until something goes cold). Without `force`
// this only ever touches bitmaps nobody has looked at for LOD_SNAP_HOT_MS, which
// is the whole point: evicting a picture that is on screen is what flicker is.
function lodSnapEvict(force) {
  lodSnapEnsure();
  const budget = Math.max(1, Number(LOD.snapMb) || 1) * 1024 * 1024;
  if (LOD.snapBytes <= budget) return;
  for (const [node, rec] of LOD.snaps) {
    if (LOD.snapBytes <= budget) break;
    if (!rec.canvas) continue; // a record can exist before its bitmap does
    if (!force && lodSnapProtected(rec)) continue; // in use: never released
    // Same rule as the RAM release: a bitmap that leaves memory must be able to
    // come back from its file, or the eviction would cost a fresh capture of a
    // node that already has a perfectly good picture on disk.
    lodThumbDiskForget(node);
    lodSnapRelease(rec);
    LOD.snaps.delete(node);
    LOD.snapEvicted++;
  }
}

// Is there room for `bytes` more? Frees cold bitmaps first (insertion order is
// reuse order, so the front of the Map is the least recently *drawn*); if nothing
// cold is available, the answer is no and the caller must not store anything.
// Refusing a new capture is the stable outcome: the nodes already pictured keep
// their pictures, and the ones that could not be captured simply stay boxes.
//
// `dry` answers the same question without releasing anything, so the capture path
// can decide *which size to draw* before drawing it: that is the difference
// between a coarse picture and none at all, and the reason a node that cannot be
// held at the user's ratio is still offered the coarsest one that does fit.
function lodSnapMakeRoom(bytes, dry) {
  lodSnapEnsure();
  const budget = Math.max(1, Number(LOD.snapMb) || 1) * 1024 * 1024;
  let held = Math.max(0, Number(LOD.snapBytes) || 0);
  for (const [node, rec] of LOD.snaps) {
    if (held + bytes <= budget) return true;
    if (!rec.canvas) continue;
    if (lodSnapProtected(rec)) continue;
    held -= Number(rec.bytes) || 0;
    if (dry) continue;
    lodSnapRelease(rec);
    LOD.snaps.delete(node);
    LOD.snapEvicted++;
  }
  return held + bytes <= budget;
}

// The graph changes while the page is open; a record whose node is gone is dead
// weight. Only pruned when the graph on screen is non-empty, so switching into a
// subgraph does not wipe the bitmaps of the graph it came from.
function lodSnapPrune(canvas) {
  if (!LOD.snaps || !LOD.snaps.size) return;
  const nodes = lodGraphNodes(canvas);
  if (!nodes || !nodes.length) return;
  const live = new Set(nodes);
  for (const [node, rec] of LOD.snaps) {
    if (live.has(node)) continue;
    if (rec.canvas) lodSnapRelease(rec);
    LOD.snaps.delete(node);
    if (LOD.snapQueue) LOD.snapQueue.delete(node);
    lodThumbDiskDelete(node);
    LOD.snapPruned++;
  }
}

// ------------------------------------------------------------ the capture ---
// Draw the node once, into its own canvas, at the capture ratio. Nothing here
// touches the visible canvas, so there is no state to hand back afterwards — the
// only shared state is the canvas object the node's draw code reads (its scale,
// its quality flag), and that is put back in a `finally`.
// Does this capture have anything in it? A node whose whole visual is a DOM
// element can draw nothing at all into a canvas, and a transparent picture would
// make that node *vanish* at the zoom where pictures are used — worse than the box
// it replaces. Reading the bitmap back would cost megabytes and a walk over
// millions of pixels per node, so this reads five small patches instead: the
// corners of the body, its centre, and the title bar. Anything unmeasurable (no
// getImageData, a tainted canvas, a probe that throws) answers "there is ink":
// this probe must never be the reason a node disappears.
function lodSnapInk(el, geom, ratio) {
  try {
    const cctx = el && typeof el.getContext === "function" ? el.getContext("2d") : null;
    if (!cctx || typeof cctx.getImageData !== "function") return true;
    // The same ratio the capture was drawn at (see lodSnapPixelRatio): probing a
    // 0.25x surface with 1x coordinates reads outside it and would call every
    // small picture blank.
    const r = lodSnapPixelRatio(ratio);
    const bodyX = -geom.x * r;
    const bodyY = -geom.y * r;
    const bodyW = geom.bodyW * r;
    const bodyH = geom.bodyH * r;
    const spots = [
      [bodyX + 2, bodyY + 2],
      [bodyX + Math.max(0, bodyW - 10), bodyY + 2],
      [bodyX + Math.max(0, bodyW - 10), bodyY + Math.max(0, bodyH - 10)],
      [bodyX + Math.max(0, bodyW / 2 - 4), bodyY + Math.max(0, bodyH / 2 - 4)],
      [bodyX + Math.max(0, bodyW / 2 - 4), bodyY - LOD_SNAP_TITLE_H * r + 6],
    ];
    for (let i = 0; i < spots.length; i++) {
      const x = Math.max(0, Math.round(spots[i][0]));
      const y = Math.max(0, Math.round(spots[i][1]));
      const data = cctx.getImageData(x, y, 8, 8);
      const pix = data && data.data;
      if (!pix) continue;
      for (let p = 3; p < pix.length; p += 4) {
        if (pix[p] > 8) return true;
      }
    }
    return false;
  } catch (e) {
    return true;
  }
}

// ------------------------------------------------------------- the DOM half ---
// What a picture is missing without this: the DOM widgets. In both renderers
// ComfyUI puts a widget's content in an element over the canvas — a multiline
// text widget (CLIPTextEncode's prompt) is a textarea, an image preview is an
// <img>, a 3D viewport is a canvas — and the canvas row underneath is blank
// (BaseDOMWidgetImpl.draw paints a placeholder only in the frontend's own
// low-quality mode). So a capture of a text or image node showed the node's
// chrome and nothing else, which is what the user reported: the stand-in is
// there, but the image or the text inside the node is not.
//
// Three kinds of content, three answers, and each one says what it is:
//   * <img> and <canvas> — drawn into the picture pixel for pixel. Their own
//     pixels are the truth; nothing is invented.
//   * <textarea> and <input> — page JavaScript cannot screenshot rendered text,
//     so the *value* is re-painted the way LiteGraph paints its own text widgets
//     (same colours, same clip). It is a rendering of the text the widget holds,
//     not a copy of the browser's, and the readout counts it as such.
//   * anything else (a pack's own HTML) — left blank and counted. Drawing a
//     picture of arbitrary DOM would be inventing ink.
// A video, or an element holding one, is never photographed at all: see
// lodSnapLive.
const LOD_SNAP_WIDGET_MARGIN = 10; // BaseDOMWidgetImpl.DEFAULT_MARGIN
const LOD_SNAP_WIDGET_H = 50; // the frontend's `computedHeight ?? 50`
const LOD_SNAP_DOM_MAX = 96; // widget elements looked at per node, per capture
const LOD_SNAP_TEXT_CHARS = 2000; // characters of a text widget that are painted
const LOD_SNAP_TEXT_LINES = 12; // and lines; past that it is clipped like the row is

function lodSnapElementKind(el) {
  const tag = String((el && el.tagName) || "").toUpperCase();
  if (tag === "IMG") return "image";
  if (tag === "CANVAS") return "canvas";
  if (tag === "TEXTAREA") return "text";
  if (tag === "INPUT") {
    const t = String(el.type || "text").toLowerCase();
    if (t === "checkbox" || t === "radio" || t === "range" || t === "file" || t === "color" || t === "button" || t === "submit") return "other";
    return "text";
  }
  return "other";
}

// The row a DOM widget occupies, in node units — the same arithmetic
// DomWidgets.vue uses to position the wrapper (`node.pos + margin`,
// `widget.width ?? node.width`, `widget.computedHeight ?? 50`). The capture draws
// in node units, so this needs no canvas rectangle, no zoom and no layout read —
// and it keeps working while this tool's own classes have the wrapper hidden,
// which is exactly the state a flat node is in when its picture is taken.
function lodSnapWidgetBox(node, w, boxes) {
  // A measured box (Vue-nodes pathway) wins over the canvas rows: it is where the
  // browser put the element, which is where the picture has to put its content.
  if (boxes && boxes.length) {
    const el = w && (w.element || w.inputEl);
    for (const b of boxes) {
      if (b && b.el === el) return { x: b.x, y: b.y, w: b.w, h: b.h };
    }
  }
  const margin = Number.isFinite(Number(w && w.margin)) ? Math.max(0, Number(w.margin)) : LOD_SNAP_WIDGET_MARGIN;
  const size = (node && (node.renderingSize || node.size)) || [0, 0];
  const nodeW = Math.abs(Number(size[0])) || 0;
  const wq = Number(w && w.width);
  const width = wq > 0 ? wq : nodeW;
  const wy = Number.isFinite(Number(w && w.y)) ? Number(w.y) : Number(w && w.last_y) || 0;
  const ch = Number(w && w.computedHeight);
  const height = ch > 0 ? ch : LOD_SNAP_WIDGET_H;
  return { x: margin, y: margin + wy, w: width - margin * 2, h: height - margin * 2 };
}

function lodSnapMeasureText(cctx, text, size) {
  try {
    if (cctx && typeof cctx.measureText === "function") {
      const m = cctx.measureText(String(text));
      const w = Number(m && m.width);
      if (Number.isFinite(w) && w > 0) return w;
    }
  } catch (e) {
    /* the estimate below is the fallback, not a guess about the font */
  }
  return String(text).length * size * 0.55;
}

// Words wrapped to the row, at most `maxLines` of them, with the last line marked
// with an ellipsis when the text does not fit — the same thing the browser does to
// a textarea's overflow, done by hand because there is no other way to get it.
function lodSnapWrapText(raw, maxW, maxLines, size, cctx) {
  const text = String(raw == null ? "" : raw).replace(/\r\n?/g, "\n");
  const out = [];
  const paragraphs = text.split("\n");
  for (let p = 0; p < paragraphs.length && out.length < maxLines; p++) {
    const words = paragraphs[p].split(/\s+/).filter(Boolean);
    if (!words.length) {
      out.push("");
      continue;
    }
    let line = "";
    for (let i = 0; i < words.length && out.length < maxLines; i++) {
      let word = words[i];
      // A single word wider than the box — a path, a URL, a token — is what the
      // browser breaks with `overflow-wrap: anywhere`, and it is also what a picture
      // clips at the right edge when the reproduction cannot. Chop it by measure.
      if (lodSnapMeasureText(cctx, word, size) > maxW) {
        if (line) {
          out.push(line);
          line = "";
        }
        let chunk = "";
        for (const ch of word) {
          if (chunk && lodSnapMeasureText(cctx, chunk + ch, size) > maxW) {
            out.push(chunk);
            chunk = ch;
            if (out.length >= maxLines) break;
          } else {
            chunk += ch;
          }
        }
        word = chunk;
      }
      const next = line ? `${line} ${word}` : word;
      if (line && lodSnapMeasureText(cctx, next, size) > maxW) {
        out.push(line);
        line = word;
      } else {
        line = next;
      }
    }
    if (line && out.length < maxLines) out.push(line);
  }
  if ((text.length > LOD_SNAP_TEXT_CHARS || out.length >= maxLines) && out.length) {
    const last = out[out.length - 1];
    out[out.length - 1] = last.length > 1 ? `${last.slice(0, Math.max(1, last.length - 1))}\u2026` : "\u2026";
  }
  return out;
}

// A text widget's value, painted into the row. Returns false when there is
// nothing to paint, which leaves the row as the canvas drew it.
function lodSnapTextInk(el, cctx, box) {
  let raw = "";
  try {
    raw = el.value != null ? String(el.value) : String(el.textContent || "");
  } catch (e) {
    return false;
  }
  if (!raw.trim()) return false;
  const LG = typeof LiteGraph !== "undefined" && LiteGraph ? LiteGraph : null;
  const size = Math.max(8, Math.min(24, Number(LG && LG.NODE_TEXT_SIZE) || 14));
  const font = `${size}px ${(LG && LG.NODE_FONT) || "Arial"}`;
  const bg = (LG && LG.WIDGET_BGCOLOR) || "#222";
  const line = (LG && LG.WIDGET_OUTLINE_COLOR) || "#666";
  const fg = (LG && LG.WIDGET_TEXT_COLOR) || "#DDD";
  try {
    if (typeof cctx.save === "function") cctx.save();
    if (typeof cctx.beginPath === "function" && typeof cctx.clip === "function") {
      cctx.beginPath();
      cctx.rect(box.x, box.y, box.w, box.h);
      cctx.clip();
    }
    cctx.fillStyle = bg;
    cctx.fillRect(box.x, box.y, box.w, box.h);
    if (typeof cctx.strokeRect === "function") {
      cctx.strokeStyle = line;
      cctx.lineWidth = 1;
      cctx.strokeRect(box.x + 0.5, box.y + 0.5, Math.max(1, box.w - 1), Math.max(1, box.h - 1));
    }
    cctx.fillStyle = fg;
    cctx.font = font;
    cctx.textAlign = "left";
    if ("textBaseline" in cctx) cctx.textBaseline = "top";
    const lineH = size * 1.25;
    // As many lines as the row actually has room for (a tall text node shows a
    // prompt, not a caption), never more than the clip can hold. The *wrap* is
    // still asked for the full budget — handing the wrapper a smaller line budget
    // makes it mark the text as truncated after one line, which is where a
    // value that plainly fit came back as "a ca…". The visible rows are what is
    // trimmed, and the trim is marked the way the wrapper marks its own.
    const room = Math.max(1, Math.min(64, Math.floor((Number(box.h) - 6) / lineH) || 1));
    const wrapped = lodSnapWrapText(raw.slice(0, LOD_SNAP_TEXT_CHARS), Math.max(4, box.w - 6), LOD_SNAP_TEXT_LINES, size, cctx);
    if (wrapped.length > room) {
      const last = wrapped[room - 1];
      wrapped[room - 1] = last && last.length > 1 ? `${last.slice(0, last.length - 1)}\u2026` : "\u2026";
    }
    const lines = wrapped.length > room ? wrapped.slice(0, room) : wrapped;
    for (let i = 0; i < lines.length; i++) {
      if (typeof cctx.fillText === "function") cctx.fillText(lines[i], box.x + 3, box.y + 3 + i * lineH);
    }
  } catch (e) {
    return false;
  } finally {
    try {
      if (typeof cctx.restore === "function") cctx.restore();
    } catch (e) {
      /* the ink is already on the surface */
    }
  }
  return true;
}

// Every DOM widget of this node, drawn into the capture. Reports what it drew and
// what it could not, so the readout can say both.
function lodSnapDomInk(node, cctx, canvas, into, boxes) {
  const out = into || { ink: 0, text: 0, skipped: 0 };
  if (!out.els) out.els = []; // what was blitted, so another pass does not draw it twice
  if (!cctx || typeof cctx.drawImage !== "function") return out;
  const widgets = (node && node.widgets) || [];
  void canvas;
  // `boxes` is the measured box of each widget element, when the caller has one
  // (the Vue-nodes pathway, where the browser lays the widgets out inside the
  // node's element). Absent, the canvas rows are used, which is right in the
  // renderer where LiteGraph authors them.
  //
  // A measured box is also how this route knows the element sits inside the node's
  // own DOM — which is where the node's text pass reads it, in the page's own font,
  // colours and column. Drawing a control here as well would put the same value on
  // the picture twice: once as the page drew it and once as Arial on a `#222` bar
  // the page never drew. Images and canvases still come from here, because no text
  // pass can draw those.
  const measured = boxes && boxes.length
    ? (el) => {
        for (const b of boxes) if (b && b.el === el) return true;
        return false;
      }
    : null;
  for (let i = 0; i < widgets.length && i < LOD_SNAP_DOM_MAX; i++) {
    const w = widgets[i];
    if (!w) continue;
    let el = w.element || w.inputEl;
    if (!el || typeof el !== "object" || !el.tagName) continue;
    if (w.hidden) continue;
    const box = lodSnapWidgetBox(node, w, boxes);
    if (!(box.w > 0) || !(box.h > 0)) continue;
    let kind = lodSnapElementKind(el);
    if (kind === "other") {
      // A wrapper with the real thing inside it: one element is enough to trust,
      // two would be a guess about which one the user is looking at.
      try {
        if (typeof el.querySelector === "function") {
          const inner = el.querySelector("img,canvas");
          if (inner && inner !== el) {
            const innerKind = lodSnapElementKind(inner);
            if (innerKind === "image" || innerKind === "canvas") {
              el = inner;
              kind = innerKind;
            }
          }
        }
      } catch (e) {
        /* a hostile lookup leaves it as HTML we cannot draw */
      }
    }
    try {
      if (kind === "image" || kind === "canvas") {
        const wpx = Number(el.naturalWidth || el.width) || 0;
        const hpx = Number(el.naturalHeight || el.height) || 0;
        // An image that has not arrived yet would draw as nothing; the signature
        // carries its `complete` flag, so the picture is re-made when it lands.
        if (!(wpx > 0) || !(hpx > 0)) {
          out.skipped++;
          continue;
        }
        cctx.drawImage(el, box.x, box.y, box.w, box.h);
        out.ink++;
        if (out.els && out.els.indexOf(el) < 0) out.els.push(el);
      } else if (kind === "text") {
        if (measured && measured(el)) continue; // read and drawn by the node's own text pass
        if (lodSnapTextInk(el, cctx, box)) {
          out.ink++;
          out.text++;
        } else {
          out.skipped++;
        }
      } else {
        out.skipped++;
      }
    } catch (e) {
      out.skipped++;
    }
  }
  return out;
}

// A node showing a video is never photographed: a picture of a video is one
// frame presented as if it were the node, and the user asked for exactly that
// line to hold — "if it doesn't play video" it may be captured.
// Is there a video inside this node? Asked by every reuse decision — twice per
// node per frame — and answered by walking each widget's element, which is a DOM
// query the page pays for. The answer is cached for a moment and re-probed for
// real before anything is photographed: a video that appears is a widget that
// swapped its element or mounted one. On a page with the observers this is a
// formality — the change is reported and the verdict is dropped with the
// measurement — but on a page without them the window in which a held picture could
// be blitted for a node that has just gained a video has to stay short, hence the
// short TTL.
function lodSnapHasVideo(node) {
  if (!node) return false;
  if (!LOD.snapVideo) LOD.snapVideo = new WeakMap();
  const t = nowMs();
  const hit = LOD.snapVideo.get(node);
  const ttl = lodVueWatched(node) ? LOD_VUE_VIDEO_MS_WATCHED : LOD_VUE_VIDEO_MS;
  if (hit && t - hit.at < ttl) return hit.video;
  const video = lodSnapHasVideoProbe(node);
  LOD.snapVideo.set(node, { at: t, video });
  LOD.vueProbes++;
  return video;
}

function lodSnapHasVideoProbe(node) {
  const widgets = node && node.widgets;
  if (!widgets) return false;
  for (let i = 0; i < widgets.length && i < LOD_SNAP_DOM_MAX; i++) {
    const w = widgets[i];
    const el = w && (w.element || w.inputEl);
    if (!el || typeof el !== "object" || !el.tagName) continue;
    if (String(el.tagName).toUpperCase() === "VIDEO") return true;
    try {
      if (typeof el.querySelector === "function" && el.querySelector("video")) return true;
    } catch (e) {
      /* a hostile lookup is not a video */
    }
  }
  return false;
}

function lodSnapRender(node, canvas, geom, ratio) {
  if (!lodSnapOriginalDrawNode || !geom) return null;
  const r = lodSnapPixelRatio(ratio);
  const px = Math.ceil(geom.w * r);
  const py = Math.ceil(geom.h * r);
  const doc = typeof document !== "undefined" ? document : null;
  if (!doc || typeof doc.createElement !== "function") return null;
  const el = doc.createElement("canvas");
  if (!el || typeof el.getContext !== "function") return null;
  el.width = px;
  el.height = py;
  const cctx = el.getContext("2d");
  if (!cctx) return null;
  if (typeof cctx.setTransform === "function") cctx.setTransform(r, 0, 0, r, -geom.x * r, -geom.y * r);
  else if (typeof cctx.scale === "function") {
    cctx.scale(r, r);
    if (typeof cctx.translate === "function") cctx.translate(-geom.x, -geom.y);
  }

  const ds = canvas && canvas.ds;
  const prevScale = ds ? ds.scale : undefined;
  const prevLow = canvas ? canvas._isLowQuality : undefined;
  const prevCurrent = canvas ? canvas.current_node : undefined;
  // The ring is drawn on the blit, not baked into a picture that will still be
  // shown after the node is deselected. Cleared only for this draw.
  let prevSelected;
  let clearedSelected = false;
  try {
    prevSelected = node.selected;
    if (prevSelected) {
      node.selected = false;
      clearedSelected = true;
    }
  } catch (e) {
    /* a selected flag that cannot be written is left as it is */
  }
  LOD.inCapture = true;
  let vueInk = null;
  try {
    // A capture is always the full-detail drawing at graph scale: the zoom and the
    // frontend's own low-quality mode must not be baked into a reusable image.
    if (ds) ds.scale = 1;
    if (canvas && "_isLowQuality" in canvas) canvas._isLowQuality = false;
    if (canvas) canvas.current_node = node;
    // ComfyUI's image preview does not draw the photograph here. It pushes the
    // drawImage onto a list and queueMicrotask's a flusher. Collect those turns
    // and run them before this function returns, so the canvas this capture
    // hands back already contains the picture. A flusher that was queued before
    // this draw is not in the list; the copies are redrawn one turn later for
    // that case (lodSnapRefreshMips).
    const queued = [];
    const prevQ = globalThis.queueMicrotask;
    let swapped = false;
    try {
      globalThis.queueMicrotask = (cb) => {
        if (typeof cb === "function") queued.push(cb);
      };
      swapped = true;
    } catch (e) {
      /* if the global cannot be replaced, the later redraw of the copies is the net */
    }
    try {
      if (lodVueNodesMode()) vueInk = lodVueCapturePaint(node, canvas, cctx, geom);
      else lodSnapOriginalDrawNode.call(canvas, node, cctx);
    } finally {
      if (swapped) {
        try {
          globalThis.queueMicrotask = prevQ;
        } catch (e) {
          /* the draw is done; restoring the scheduler must not hide its result */
        }
      }
    }
    for (let i = 0; i < queued.length && i < 8; i++) {
      try {
        queued[i]();
      } catch (e) {
        /* a deferred draw that throws is the node's problem; the frame is still kept */
      }
    }
  } finally {
    LOD.inCapture = false;
    if (ds && prevScale !== undefined) ds.scale = prevScale;
    if (canvas && prevLow !== undefined && "_isLowQuality" in canvas) canvas._isLowQuality = prevLow;
    if (canvas && prevCurrent !== undefined) canvas.current_node = prevCurrent;
    if (clearedSelected) {
      try {
        node.selected = prevSelected;
      } catch (e) {
        /* the flag was ours to put back; if it cannot be, the live ring still draws */
      }
    }
  }
  return { canvas: el, ctx: cctx, x: geom.x, y: geom.y, w: geom.w, h: geom.h, ratio: r, bytes: px * py * 4, vueInk };
}

// One turn of the microtask queue, then `fn`. ComfyUI's image preview does not
// draw the photograph inside drawNode: it queues that drawImage and returns, on
// the same context, so the pixels land after the call that asked for them. The
// half and quarter copies are made from that canvas. Copying before the turn
// means those copies — the ones the screen uses past about 25% zoom on a 200%
// display — have the frame and not the picture. A turn already queued (the
// preview's own flusher) runs first, which is the order this wants.
function lodSnapDefer(fn) {
  try {
    const q = typeof queueMicrotask === "function" ? queueMicrotask : null;
    if (q) {
      q(fn);
      return;
    }
  } catch (e) {
    /* fall through to a promise turn */
  }
  try {
    Promise.resolve().then(fn);
  } catch (e) {
    try {
      fn();
    } catch (err) {
      /* the commit reports its own failure */
    }
  }
}

function lodSnapAbort(reason) {
  LOD.snapOn = false;
  lodSnapClear("abort");
  LOD.error = `node snapshots turned themselves off: ${reason}`;
  lodSnapCancel();
}

function lodSnapCancel() {
  if (LOD.snapTimer != null) {
    try {
      clearTimeout(LOD.snapTimer);
    } catch (e) {
      /* nothing to cancel with */
    }
    LOD.snapTimer = null;
  }
  LOD.snapPumping = false;
}

function lodSnapCaptureNode(node, canvas) {
  lodSnapEnsure();
  let rec = LOD.snaps.get(node);
  if (rec && rec.diskPending) return false; // a disk load is in flight; don't photograph twice
  if (rec && (rec.blocked || rec.failed)) return false;
  // A *held* picture is not a reason to refuse its own replacement — that is what
  // the lane was asked for. A picture that still matches the node is, because
  // there is nothing to re-photograph. (This line used to refuse every node with a
  // canvas, so the re-capture a change asked for was silently dropped.)
  if (rec && rec.canvas && !rec.staleAt) return false;
  // A node waiting out a slow-capture cooldown is not photographed, however it got
  // asked: the ask comes again by itself when the wait is over (a paint finds it
  // un-pictured), and this is the line that keeps the lane from hammering a node
  // whose own draw is too expensive to run.
  if (rec && rec.cooldownUntil && nowMs() < rec.cooldownUntil) return false;
  if (lodSnapHasVideoProbe(node)) {
    // A video is never photographed: a still frame presented as the node is the
    // one thing the user asked to be excluded, and this check is the fresh one —
    // the draw path answers from a short-lived cache.
    lodSnapBlockNode(node, lodSnapEnsure(), "a video widget");
    LOD.snapKept++;
    lodSnapNoteWhy(node, "a video widget");
    return false;
  }
  const whyLive = lodSnapKeepLive(node);
  if (whyLive) {
    lodSnapBlockNode(node, rec, whyLive);
    LOD.snapKept++;
    lodSnapNoteWhy(node, whyLive);
    return false;
  }
  if (lodSnapLive(node, canvas)) return false; // nothing to capture: it is being drawn live
  if (lodVueNodesMode() && !lodVueRootEl(node)) {
    // In this renderer a picture *is* the node's DOM: the box, its text and the
    // elements it renders. With the element off the page (the frontend mounts only
    // what it renders, and a node can be between renderers) the capture would be a
    // bare box — and a bare box stored under this node's key is served to every
    // later frame as if it were a picture of the node, which is exactly the
    // "cached boxes" a user should never see. Refused, counted, and left
    // un-pictured so a later slice can do it properly once the element is back.
    LOD.vueNoElement++;
    lodSnapNoteWhy(node, "element not on the page");
    return false;
  }
  // In this renderer the picture *is* the measurement. Take it once, here, and use
  // that one number for the surface, the box and the ink: sizing the surface from
  // the cached number and painting from a fresh one clips exactly the part that
  // arrived late (the frontend renders an image node `IMAGE_PREVIEW_HEIGHT_RESERVE`
  // taller than its graph size and puts the picture in the overhang, so "the part
  // that arrived late" is often the content the user asked to see).
  const dom = lodVueNodesMode() ? lodVueRootMetrics(node, canvas, true) : null;
  const geom = lodSnapGeometry(node, canvas, dom && dom.boxH > 0 ? dom.boxH : 0);
  if (!geom) return false;
  const want = Number(LOD.snapRatio) || LOD_SNAP_RATIO_DEFAULT;
  const fit = lodSnapFitRatio(geom, want);
  if (!fit) {
    // No ratio on the ladder keeps this node inside the dimension cap: it is
    // bigger than any picture this cache is allowed to hold. Blocked, so it is not
    // re-attempted on every slice for the rest of the session, and named in the
    // readout — a count of attempts told the user nothing about which node it was.
    lodSnapBlockNode(node, rec, `too big for a ${LOD_SNAP_MAX_DIM}px capture`);
    LOD.snapLarge++;
    lodSnapNoteWhy(node, `too big (${Math.round(geom.bodyH)} units tall)`);
    return false;
  }
  // Which ratio actually gets drawn: the one that fits the cap, and — if the
  // budget cannot hold *that* — the coarsest one that does, rather than nothing. A
  // refused capture still costs the node's whole draw and is then thrown away, so
  // "coarser" is the cheaper answer as well as the more useful one. Only if even
  // the coarsest cannot be held is the capture refused.
  let ratio = fit;
  let bytes = lodSnapBytesFor(geom, ratio);
  let coarse = false;
  const coarseFloor = lodSnapCoarseFloor(want);
  if (!lodSnapMakeRoom(bytes, true) && ratio > coarseFloor) {
    const small = lodSnapBytesFor(geom, coarseFloor);
    if (lodSnapMakeRoom(small, true)) {
      ratio = coarseFloor;
      bytes = small;
      coarse = true;
    }
  }
  if (!lodSnapMakeRoom(bytes, true)) {
    // The budget is full of bitmaps that are being looked at, and not even the
    // coarsest copy fits. Refusing is still the honest answer: releasing a picture
    // that is on screen is what flicker looks like.
    LOD.snapFull++;
    if (!rec) {
      rec = { sig: "", checkedAt: 0, bytes: 0, canvas: null };
      LOD.snaps.set(node, rec);
    }
    rec.budgetFullAt = nowMs();
    return false;
  }
  const sig = lodSnapSignature(node, canvas);
  const t0 = nowMs();
  let made = null;
  try {
    made = lodSnapRender(node, canvas, geom, ratio);
  } catch (err) {
    LOD.snapFailed++;
    LOD.snapFailStreak++;
    if (!rec) {
      rec = { sig: "", checkedAt: 0, bytes: 0, canvas: null };
      LOD.snaps.set(node, rec);
    }
    rec.failed = true;
    rec.why = `failed: ${err && err.message ? err.message : String(err)}`;
    if (LOD.snapFailStreak >= LOD_SNAP_FAIL_MAX) lodSnapAbort(`capture failed ${LOD.snapFailStreak} times in a row (${rec.why})`);
    return false;
  }
  const dt = nowMs() - t0;
  if (!made) {
    LOD.snapMs += dt; // no canvas support in this environment: nothing to count
    return false;
  }
  if (dt > LOD_SNAP_SLOW_MS) {
    LOD.snapMs += dt;
    // A slow capture buys a cooldown, not a life sentence. This used to block the
    // node for the session — "one slow capture is enough evidence" — and on a big
    // node on a CPU-only machine that is a plain box forever, which is exactly
    // what a user with two 30-row nodes was looking at. The wait doubles per slow
    // attempt and is capped: the node is always tried again.
    LOD.snapSlow++;
    LOD.snapCooldown++;
    lodSnapDiscard(made);
    const tries = (Number(rec && rec.slowTries) || 0) + 1;
    const wait = Math.min(LOD_SNAP_SLOW_MAX_MS, LOD_SNAP_SLOW_COOLDOWN_MS * Math.pow(2, tries - 1));
    if (!rec) {
      // A node whose very first capture is slow has no record yet. The cooldown has
      // to live somewhere or the next paint asks again immediately.
      rec = { sig: "", checkedAt: 0, bytes: 0, canvas: null };
      LOD.snaps.set(node, rec);
    }
    rec.slowTries = tries;
    rec.cooldownUntil = nowMs() + wait;
    lodSnapNoteWhy(node, `too slow to photograph (${Math.round(dt)}ms) — another try in ${Math.round(wait / 1000)}s`);
    return false;
  }
  // The probe is this tool's own cost like the draw is, so it lands in the same
  // counter; it is deliberately *not* part of the slow-capture verdict above,
  // which is a judgement about the node's draw path.
  const ink = lodSnapInk(made.canvas, geom, ratio);
  LOD.snapMs += nowMs() - t0;
  if (!ink) {
    // The node drew nothing the canvas can keep (its whole visual is a DOM
    // element). A transparent picture would erase the node on screen, so the box
    // — which at least draws the node's own rectangle — stays, and the readout
    // says why.
    lodSnapDiscard(made);
    lodSnapBlockNode(node, rec, "drew nothing into the canvas");
    LOD.snapBlank++;
    lodSnapNoteWhy(node, "draws nothing into the canvas (all DOM)");
    return false;
  }
  // The node's DOM widgets are drawn into the picture now — after the ink probe,
  // so a node whose whole visual is DOM still keeps its box (a picture of nothing
  // but a composited widget, blitted over nothing, would be a sticker floating on
  // the canvas) — and before the mip chain and the file are made from it, so the
  // smaller copies and the disk PNG contain it too.
  // In the canvas renderer the widget composite runs here, after the ink probe;
  // in the Vue-nodes renderer the painter already did it (that is what the
  // picture is), so its counts are picked up rather than drawn a second time.
  let domInk = made.vueInk || null;
  if (!domInk && lodSnapPartial(node)) {
    const dc0 = nowMs();
    domInk = lodSnapDomInk(node, made.ctx, canvas);
    LOD.snapMs += nowMs() - dc0;
  }
  if (!lodSnapMakeRoom(made.bytes)) {
    // The budget is full of bitmaps that are being looked at. Refusing is the
    // honest answer: releasing one would take a picture off the screen, and
    // recapturing it later would release another — which is exactly the flicker
    // this guard exists to stop.
    lodSnapDiscard(made);
    LOD.snapFull++;
    if (!rec) {
      rec = { sig: "", checkedAt: 0, bytes: 0, canvas: null };
      LOD.snaps.set(node, rec);
    }
    rec.budgetFullAt = nowMs();
    return false;
  }
  if (!rec) {
    rec = { sig: "", checkedAt: 0, bytes: 0, canvas: null };
  } else {
    LOD.snaps.delete(node); // re-insert: this is now the most recently used
  }
  rec.canvas = made.canvas;
  rec.x = made.x;
  rec.y = made.y;
  rec.w = made.w;
  rec.h = made.h;
  rec.bytes = made.bytes;
  rec.sig = sig;
  rec.checkedAt = nowMs();
  rec.at = rec.checkedAt;
  rec.usedFrame = LOD.snapFrame; // in use: the frame that asked for it
  // The canvas's own shadow flag is remembered, not put in the signature: another
  // extension (NodeSnapshots' "simplify during navigation") flips it around every
  // gesture, and a signature that included it would throw every bitmap away
  // twice a gesture. A mismatch only pauses reuse for that node.
  rec.shadows = !!(canvas && canvas.render_shadows);
  rec.ratio = made.ratio;
  rec.blocked = false;
  rec.failed = false;
  rec.staleAt = 0; // the picture that is up is the node again
  rec.slowTries = 0; // and the capture was inside its budget this time
  rec.cooldownUntil = 0;
  LOD.snaps.set(node, rec);
  LOD.snapBytes += rec.bytes;
  LOD.snapCaptured++;
  LOD.snapFailStreak = 0;
  lodSnapAttachMips(rec);
  // The disk file is the bitmap after any image draw that was already queued
  // before this capture (that one is not in the list we drained). One turn, then
  // the copies are redrawn from the canvas and the file is written.
  lodSnapDefer(() => lodSnapSettleImages(node, rec, made.canvas));
  if (coarse) LOD.snapCoarse++;
  else if (made.ratio < want) LOD.snapFit++;
  if (lodSnapPartial(node)) LOD.snapPartial++;
  if (domInk) {
    if (domInk.ink) LOD.snapDomInk += domInk.ink;
    if (domInk.text) LOD.snapDomText += domInk.text;
    if (domInk.skipped) LOD.snapDomSkipped += domInk.skipped;
  }
  return true;
}

// Redraw the half and quarter copies from the capture, then write the file.
// Safe to run late: if this picture was dropped or replaced, it does nothing.
function lodSnapSettleImages(node, rec, canvas) {
  if (!rec || rec.canvas !== canvas) return;
  lodSnapRefreshMips(rec);
  try {
    lodThumbDiskSave(node, rec);
  } catch (e) {
    /* the memory picture is already in use; a disk miss is the old path */
  }
}

function lodSnapRefreshMips(rec) {
  if (!rec || !rec.mips || !rec.canvas) return;
  const src = rec.canvas;
  for (const scale of [0.5, 0.25]) {
    const c = rec.mips[scale];
    if (!c || c === src || !(c.width > 0) || !(c.height > 0)) continue;
    try {
      const ctx = typeof c.getContext === "function" ? c.getContext("2d") : null;
      if (!ctx || typeof ctx.drawImage !== "function") continue;
      if (typeof ctx.clearRect === "function") ctx.clearRect(0, 0, c.width, c.height);
      if ("imageSmoothingEnabled" in ctx) ctx.imageSmoothingEnabled = true;
      if ("imageSmoothingQuality" in ctx) ctx.imageSmoothingQuality = "low";
      ctx.drawImage(src, 0, 0, c.width, c.height);
    } catch (e) {
      /* the copy made at capture time remains */
    }
  }
}

// A picture thrown away because the node changed before it could be used. A node
// that does this every single time is a node whose drawing is being rewritten
// faster than the idle lane can photograph it — a poller writing widget values,
// for instance — and it keeps its box instead of costing a capture per slice for
// the rest of the session. The counter lives on the node, not on the record, so it
// survives the record being dropped (it is reset by a successful reuse, which is
// what "the lane is keeping up" looks like).
function lodSnapSchedule(delay) {
  if (LOD.snapTimer != null) return;
  try {
    LOD.snapTimer = govOwn(() =>
      setTimeout(() => {
        LOD.snapTimer = null;
        lodSnapSlice();
      }, Math.max(0, Math.round(delay) || 0))
    );
  } catch (e) {
    LOD.snapTimer = null;
    LOD.snapPumping = false;
  }
}

function lodSnapPump() {
  if (LOD.snapPumping) return;
  LOD.snapPumping = true;
  lodSnapSchedule(0);
}

// One idle slice. The lane is the one the rest of this tool already has: the
// governor's budget, the same input guard that lifts the redraw cap, and a gap
// between slices so a big graph is captured over a second or two rather than in
// one visible pause. No second scheduler, no second idle clock.
function lodSnapSlice() {
  const canvas = typeof app !== "undefined" && app ? app.canvas : null;
  if (!lodSnapBitmaps(canvas)) {
    LOD.snapPumping = false;
    return;
  }
  // A picture is the node's box in the renderer it was made in: different pad,
  // different title bar, different content route. A page that switches renderers
  // (the frontend's flag is read per call, so that happens live) lets the old
  // pictures go and makes new ones on the idle lane — the same release as
  // switching the setting off, for the same reason.
  const pathway = lodVueNodesMode() ? "vue" : "canvas";
  if (LOD.vuePathway !== pathway) {
    // The first pump adopts the pathway it finds: nothing has been made yet, so
    // there is nothing to release. A *change* after that is a change of geometry.
    const had = !!LOD.vuePathway && ((LOD.snaps && LOD.snaps.size) || (LOD.snapQueue && LOD.snapQueue.size));
    LOD.vuePathway = pathway;
    if (had) lodSnapClear("renderer changed");
  }
  lodSnapEnsure();
  const t0 = nowMs();
  if (govInputRecently(t0, LOD_SNAP_IDLE_MS)) {
    lodSnapSchedule(LOD_SNAP_GAP_MS); // somebody is using the page: wait
    return;
  }
  const theme = lodSnapThemeSig();
  if (!LOD.snapTheme) LOD.snapTheme = theme;
  else if (LOD.snapTheme !== theme) {
    LOD.snapTheme = theme;
    lodSnapClear("theme"); // palette or font changed: every bitmap is a lie
  }
  lodSnapPrune(canvas);
  const budget = Math.max(1, Number(GOV.controls.budgetMs) || 12);
  let wait = 0;
  while (LOD.snapQueue.size) {
    if (nowMs() - t0 >= budget || govInputRecently(nowMs(), LOD_SNAP_IDLE_MS)) break;
    const pick = lodSnapTake(canvas, t0);
    if (!pick.node) {
      // Everything left is still settling. The next slice is scheduled for the
      // moment the first of them is allowed to be photographed, not before.
      wait = pick.wait || LOD_SNAP_GAP_MS;
      LOD.vueSettleHeld++;
      break;
    }
    lodSnapCaptureNode(pick.node, canvas);
  }
  if (LOD.snapQueue.size) lodSnapSchedule(Math.max(LOD_SNAP_GAP_MS, Math.ceil(wait) || 0));
  else LOD.snapPumping = false;
}

// On-screen nodes first. The queue is a Set, so this is a scan, not a second
// scheduler. A worker cannot call the node's own draw — that is the slow part.
function lodSnapTake(canvas, t) {
  const area = viewArea(canvas, 0);
  const now = t || nowMs();
  let first = null;
  let wait = 0;
  for (const node of LOD.snapQueue) {
    // A node that changed less than the settle window ago is not photographed yet.
    // On-screen nodes are preferred among those that *are* ready; a node waiting
    // out its window is remembered only for how long the slice should sleep.
    const left = lodVueSettleLeft(node, now);
    if (left > 0) {
      if (!wait || left < wait) wait = left;
      continue;
    }
    if (!first) first = node;
    if (area && viewTouchesArea(node, area)) {
      LOD.snapQueue.delete(node);
      return { node, wait: 0 };
    }
  }
  if (first) {
    LOD.snapQueue.delete(first);
    return { node: first, wait: 0 };
  }
  return { node: null, wait };
}

// Called from the draw path for a node that has just been painted as a box: it is
// a candidate. Cheap in the steady state (one map lookup for a node that already
// has a bitmap) and never runs while the mode is off.
// Canvas2D has no mipmap format drawImage can sample, and a WebGL mip chain
// cannot be handed to LiteGraph's 2D canvas. The 1x capture is downscaled here
// to 1/2 and 1/4, and the blit picks the smallest copy whose longest side still
// covers the on-screen device pixels. 1/4 is used only when the screen cannot
// show the extra pixels — around 10% zoom and below on a 200% display, not at 20%.
function lodSnapMips(canvas) {
  const mips = { 1: canvas };
  if (!canvas || !canvas.width || !canvas.height) return mips;
  const doc = typeof document !== "undefined" ? document : null;
  if (!doc || typeof doc.createElement !== "function") return mips;
  for (const scale of [0.5, 0.25]) {
    const w = Math.max(1, Math.round(canvas.width * scale));
    const h = Math.max(1, Math.round(canvas.height * scale));
    if (w >= canvas.width && h >= canvas.height) continue;
    try {
      const c = doc.createElement("canvas");
      c.width = w;
      c.height = h;
      const ctx = c.getContext("2d");
      if (!ctx || typeof ctx.drawImage !== "function") continue;
      if ("imageSmoothingEnabled" in ctx) ctx.imageSmoothingEnabled = true;
      if ("imageSmoothingQuality" in ctx) ctx.imageSmoothingQuality = "low";
      ctx.drawImage(canvas, 0, 0, w, h);
      mips[scale] = c;
    } catch (e) {
      /* a missing level means the blit uses the next larger copy */
    }
  }
  return mips;
}

function lodSnapPick(rec, canvas) {
  const full = rec && rec.canvas;
  if (!full) return null;
  const mips = rec.mips;
  if (!mips) return full;
  let zoom = 1;
  try {
    zoom = lodZoomOf(canvas);
  } catch (e) {
    zoom = 1;
  }
  let dpr = 1;
  try {
    dpr = Number(viewDisplayScale()) || 1;
  } catch (e) {
    dpr = 1;
  }
  const need = Math.max(1, Math.max(Number(rec.w) || 0, Number(rec.h) || 0) * (zoom > 0 ? zoom : 1) * dpr);
  let best = full;
  let bestSide = Math.max(full.width || 0, full.height || 0);
  for (const scale of [0.25, 0.5]) {
    const c = mips[scale];
    if (!c) continue;
    const side = Math.max(c.width || 0, c.height || 0);
    if (side >= need && side < bestSide) {
      best = c;
      bestSide = side;
    }
  }
  return best;
}

function lodSnapAttachMips(rec) {
  if (!rec || !rec.canvas || rec.mips) return;
  const mips = lodSnapMips(rec.canvas);
  let extra = 0;
  for (const scale of [0.5, 0.25]) {
    const c = mips[scale];
    if (c) extra += c.width * c.height * 4;
  }
  if (!extra) {
    rec.mips = mips;
    return;
  }
  // The 1x picture is already in the budget. The chain is kept only if the extra
  // fits without taking a picture off the screen.
  if (!lodSnapMakeRoom(extra)) {
    for (const scale of [0.5, 0.25]) lodSnapZeroCanvas(mips[scale]);
    LOD.snapMipSkipped++;
    return;
  }
  rec.mips = mips;
  rec.bytes = (Number(rec.bytes) || 0) + extra;
  LOD.snapBytes += extra;
}

const THUMB_DISK_PREFIX = "/ants_optimizer/thumbs";

// The name a picture is stored under has to say what is *inside* it. The node
// signature alone does not: it deliberately leaves the capture ratio and the
// theme out (see lodSnapSignature), because in RAM a ratio change and a theme
// change both clear the whole cache — there is nothing stale to catch. A file
// outlives both. A page that starts at 0.25x used to be served yesterday's 1x
// files under the same name (sixteen times the memory the user had just asked to
// spend, and no re-capture, because a record existed); a page that started at 2x
// was served 0.25x pictures and never asked for better ones; and a file written
// in a light theme was served in a dark one. The ratio and a hash of the theme
// are therefore part of the disk key, which also means a change of either one
// re-keys it — the change is followed in both directions, which is what the
// setting promises.
function lodSnapToken(text) {
  let h = 2166136261;
  const s = String(text == null ? "" : text);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

function lodSnapRatioToken(ratio) {
  const r = Number(ratio);
  const known = LOD_SNAP_RATIOS.indexOf(r) >= 0 ? r : LOD_SNAP_RATIO_DEFAULT;
  return String(known).replace(/[^0-9.]/g, "");
}

function lodSnapThemeToken() {
  try {
    if (!LOD.snapTheme) LOD.snapTheme = lodSnapThemeSig();
    return lodSnapToken(LOD.snapTheme);
  } catch (e) {
    return "0";
  }
}

function lodSnapDiskSig(node, canvas, ratio) {
  const base = lodSnapSignature(node, canvas);
  if (!base) return "";
  // …plus the pathway, spelled out at the end of the key. The signature already
  // mixes it, but a key is read by humans and by the server's own bookkeeping, and
  // the failure this prevents is worth naming: a *drawn* Vue picture and a
  // *photographed* canvas picture are different pictures, and a file written by one
  // must never be served to the other. A file whose key predates this token is read
  // as a miss (lodSnapDiskRatio answers the default ratio, and the ask includes the
  // token) and is re-made, exactly like the pre-2.5.6 files with no ratio in them.
  return `${base}r${lodSnapRatioToken(ratio)}t${lodSnapThemeToken()}${lodSnapPathwayToken()}`;
}

// Which pathway a file was written in: "pc" for the canvas renderer, "pv" for the
// Vue-nodes renderer. One character, because it rides in a file name.
function lodSnapPathwayToken() {
  return lodVueNodesMode() ? "pv" : "pc";
}

// The ratio a stored file was drawn at, read back out of its own key. A file
// whose key has no ratio token (written before this existed) — or no pathway token
// (written before v2.6.4) — reads as the default and is re-made on the next
// capture rather than trusted.
function lodSnapDiskRatio(sig) {
  const m = /r([0-9]+(?:\.[0-9]+)?)t[0-9a-z]+(?:p[vc])?$/.exec(String(sig || ""));
  const r = m ? Number(m[1]) : 0;
  return LOD_SNAP_RATIOS.indexOf(r) >= 0 ? r : LOD_SNAP_RATIO_DEFAULT;
}

function lodThumbId(node) {
  try {
    if (!node || node.id == null || node.id === "") return "";
    return String(node.id).replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80);
  } catch (e) {
    return "";
  }
}

function lodThumbDiskNoteFail() {
  LOD.diskFail = (LOD.diskFail || 0) + 1;
  if (LOD.diskFail > 8) LOD.diskDead = true;
}

function lodThumbDiskSweep() {
  if (!LOD.diskOn || LOD.diskSwept) return;
  LOD.diskSwept = true;
  try {
    if (typeof fetch !== "function") return;
    fetch(THUMB_DISK_PREFIX + "/sweep", { method: "POST" }).catch(() => {});
    fetch(THUMB_DISK_PREFIX + "/info")
      .then((res) => (res && res.ok && typeof res.json === "function" ? res.json() : null))
      .then((body) => {
        if (body && body.dir) LOD.diskDir = String(body.dir);
      })
      .catch(() => {});
  } catch (e) {
    /* no route: the memory cache continues */
  }
}

function lodThumbDiskDelete(node) {
  if (!LOD.diskOn) return;
  const id = lodThumbId(node);
  if (!id) return;
  try {
    if (typeof fetch !== "function") return;
    fetch(THUMB_DISK_PREFIX + "/" + encodeURIComponent(id), { method: "DELETE" }).catch(() => {});
  } catch (e) {
    /* a missing route does not keep a deleted node's picture on screen */
  }
}

function lodThumbDiskSave(node, rec) {
  if (!LOD.diskOn || LOD.diskDead || !rec || !rec.canvas || !rec.sig || rec.fromDisk) return;
  const id = lodThumbId(node);
  if (!id) return;
  const canvas = rec.canvas;
  // A picture the budget forced coarser than the setting is not written: the file
  // would carry the setting's name and somebody else's pixels, and the next page
  // would load it as if the setting had produced it. It stays in RAM for this
  // session and is re-made when it is asked for again — the same rule as the
  // capture itself, which only ever promises what it drew.
  const want = lodSnapPixelRatio(LOD.snapRatio);
  if (lodSnapPixelRatio(rec.ratio) !== want) return;
  const sig = lodSnapDiskSig(node, null, want);
  const send = (blob) => {
    if (!blob) return;
    try {
      fetch(THUMB_DISK_PREFIX + "/" + encodeURIComponent(id) + "?sig=" + encodeURIComponent(sig), {
        method: "PUT",
        body: blob,
        headers: { "Content-Type": blob.type || "image/png" },
      })
        .then((res) => {
          if (res && res.ok) LOD.diskSaved++;
          else lodThumbDiskNoteFail();
        })
        .catch(() => lodThumbDiskNoteFail());
    } catch (e) {
      lodThumbDiskNoteFail();
    }
  };
  try {
    if (typeof canvas.toBlob === "function") {
      canvas.toBlob(send, "image/png");
    }
  } catch (e) {
    /* no toBlob: the memory picture still stands */
  }
}

function lodThumbDiskInstall(node, canvas, sig, blob) {
  const paint = (bmp) => {
    try {
      let live = "";
      // The file's own key is the check: node state *and* the ratio and theme the
      // file was drawn for. Comparing the bare node signature would accept a file
      // this page has no business using (that is the whole point of the token in
      // the name); comparing the whole key also catches a theme change between
      // the request and the answer.
      try {
        live = lodSnapDiskSig(node, canvas, lodSnapDiskRatio(sig));
      } catch (e) {
        return;
      }
      if (live !== sig) return;
      const cur = LOD.snaps && LOD.snaps.get(node);
      if (cur && cur.canvas) return;
      const doc = typeof document !== "undefined" ? document : null;
      if (!doc) return;
      const el = doc.createElement("canvas");
      const w = Number(bmp && (bmp.width || bmp.naturalWidth)) || 0;
      const h = Number(bmp && (bmp.height || bmp.naturalHeight)) || 0;
      if (!w || !h) return;
      el.width = w;
      el.height = h;
      const ctx = el.getContext("2d");
      if (!ctx) return;
      ctx.drawImage(bmp, 0, 0);
      const geom = lodSnapGeometry(node, canvas);
      if (!geom) return;
      const mips = lodSnapMips(el);
      let bytes = w * h * 4;
      for (const scale of [0.5, 0.25]) {
        const c = mips[scale];
        if (c) bytes += c.width * c.height * 4;
      }
      if (!lodSnapMakeRoom(bytes)) {
        lodSnapZeroCanvas(el);
        return;
      }
      const rec = cur || { sig: "", checkedAt: 0, bytes: 0, canvas: null };
      rec.canvas = el;
      rec.mips = mips;
      rec.x = geom.x;
      rec.y = geom.y;
      rec.w = geom.w;
      rec.h = geom.h;
      rec.bytes = bytes;
      rec.sig = sig;
      rec.checkedAt = nowMs();
      rec.at = rec.checkedAt;
      rec.usedFrame = LOD.snapFrame;
      rec.shadows = !!(canvas && canvas.render_shadows);
      // What the file was drawn at, read from its key — not a hardcoded 1, which
      // is what it used to say for every file no matter which ratio it held.
      rec.ratio = lodSnapDiskRatio(sig);
      rec.blocked = false;
      rec.failed = false;
      rec.diskPending = false;
      rec.fromDisk = true;
      lodSnapEnsure();
      LOD.snaps.delete(node);
      LOD.snaps.set(node, rec);
      LOD.snapBytes += bytes;
      LOD.diskLoaded++;
      if (LOD.snapQueue) LOD.snapQueue.delete(node);
      try {
        if (bmp && typeof bmp.close === "function") bmp.close();
      } catch (e) {
        /* the canvas holds the pixels */
      }
    } catch (e) {
      /* a bad file is a miss: the idle lane will photograph */
    }
  };
  try {
    if (typeof createImageBitmap === "function") {
      Promise.resolve(createImageBitmap(blob)).then(paint).catch(() => {});
    }
  } catch (e) {
    /* no decoder: capture instead */
  }
}

function lodThumbDiskAsk(node, canvas) {
  if (!LOD.diskOn || LOD.diskDead) return false;
  const id = lodThumbId(node);
  if (!id) return false;
  // Asked before the key is built: a node that already has a picture, or a read
  // already in flight, has nothing to ask for — and building the key means hashing
  // everything the node is showing. The draw path asks once per frame for every
  // boxed node, so this is the difference between "one Map lookup" and "hash the
  // node, then look it up".
  if (LOD.snaps) {
    const rec0 = LOD.snaps.get(node);
    if (rec0 && (rec0.canvas || rec0.diskPending)) return false;
  }
  let sig = "";
  try {
    // The key of the picture this page would *use*: the ratio the setting asks
    // for, in the theme the page is in right now. Anything stored for another
    // ratio or another theme is a miss, which is what makes changing the setting
    // do something in both directions — and the "already asked" mark below is
    // keyed the same way, so a change re-arms the disk read too.
    sig = lodSnapDiskSig(node, canvas, LOD.snapRatio);
  } catch (e) {
    return false;
  }
  if (!sig) return false;
  if (!LOD.diskAsked) LOD.diskAsked = new Set();
  const key = id + "\0" + sig;
  if (LOD.diskAsked.has(key)) return false;
  LOD.diskAsked.add(key);
  lodSnapEnsure();
  let rec = LOD.snaps.get(node);
  if (rec && rec.canvas) return false;
  if (!rec) {
    rec = { sig: "", checkedAt: 0, bytes: 0, canvas: null, diskPending: true };
    LOD.snaps.set(node, rec);
  } else {
    rec.diskPending = true;
  }
  let pending = null;
  try {
    if (typeof fetch !== "function") {
      rec.diskPending = false;
      return false;
    }
    pending = fetch(THUMB_DISK_PREFIX + "/" + encodeURIComponent(id) + "?sig=" + encodeURIComponent(sig));
  } catch (e) {
    rec.diskPending = false;
    return false;
  }
  Promise.resolve(pending)
    .then((res) => {
      if (!res || !res.ok || typeof res.blob !== "function") return null;
      return res.blob();
    })
    .then((blob) => {
      rec.diskPending = false;
      if (!blob) {
        if (LOD.snapQueue) LOD.snapQueue.add(node);
        lodSnapPump();
        return;
      }
      lodThumbDiskInstall(node, canvas, sig, blob);
    })
    .catch(() => {
      rec.diskPending = false;
      lodThumbDiskNoteFail();
      if (LOD.snapQueue) LOD.snapQueue.add(node);
      lodSnapPump();
    });
  return true;
}

function lodSnapEnqueue(node, canvas, restale) {
  if (!lodSnapBitmaps(canvas)) return;
  lodSnapEnsure();
  // A node the Vue lane has never seen starts its window now — the frame it was
  // first drawn as a stand-in is the frame it appeared. Only the *first* time: the
  // box path calls this every frame while a node has no picture, and re-arming
  // here would postpone the first capture for as long as the box is on screen.
  if (lodVueNodesMode() && !(LOD.vueSettle && LOD.vueSettle.has(node))) lodVueChanged(node);
  const rec = LOD.snaps.get(node);
  if (rec && rec.diskPending) return;
  // A node whose picture is being replaced is asked for *with* its canvas in
  // hand: that is the re-capture a change triggers now, instead of dropping the
  // picture and drawing a box until a new one arrives.
  if (rec && (rec.blocked || rec.failed)) return;
  if (rec && rec.canvas && !restale) return;
  if (rec && rec.canvas && rec.restaleHoldUntil && nowMs() < rec.restaleHoldUntil) return;
  if (rec && rec.cooldownUntil && nowMs() < rec.cooldownUntil) return;
  if (!rec || !rec.canvas) {
    if (lodThumbDiskAsk(node, canvas)) return;
  }
  // A node refused for budget waits: retrying it every slice would burn the lane
  // and change nothing until something goes cold.
  if (rec && Number.isFinite(rec.budgetFullAt) && nowMs() - rec.budgetFullAt < LOD_SNAP_HOLD_MS) return;
  if (LOD.snapQueue.has(node)) return;
  if (LOD.snapQueue.size >= LOD_SNAP_QUEUE_MAX) return;
  LOD.snapQueue.add(node);
  lodSnapPump();
}

// The ring the box path draws when a node is selected, drawn on top of a picture so
// selection does not have to throw the picture away. Same colour and width as the
// box, in the node's own coordinates (the blit context is already there), and the
// same *size* as the box — `lodVueBoxSize`, so a node the frontend renders taller
// than its graph size is ringed where the user sees it.
function lodSnapSelectionRing(node, canvas, ctx) {
  try {
    const size = lodVueBoxSize(node, canvas) || (node && (node.renderingSize || node.size)) || [0, 0];
    const w = Math.abs(Number(size[0])) || 0;
    const h = Math.abs(Number(size[1])) || 0;
    if (!(w > 0) || !(h > 0) || !ctx || typeof ctx.strokeRect !== "function") return;
    const scale = (canvas && canvas.ds && Number(canvas.ds.scale)) || 1;
    if (typeof ctx.save === "function") ctx.save();
    ctx.shadowColor = "transparent";
    ctx.globalAlpha = 1;
    ctx.strokeStyle = "#ffb300";
    ctx.lineWidth = 1 / (scale > 0 ? scale : 1);
    ctx.strokeRect(0, 0, w, h);
    if (typeof ctx.restore === "function") ctx.restore();
  } catch (e) {
    /* a ring that cannot be drawn is not a reason to drop the picture */
  }
}

// The reuse path, called from inside the drawNode wrapper for a node that would
// otherwise be a flat box. Answers "yes, I drew it" or "no, paint the box".
function lodSnapPaint(node, canvas, ctx) {
  lodSnapEnsure();
  const rec = LOD.snaps.get(node);
  if (!rec || !rec.canvas) {
    LOD.snapMisses++;
    return false;
  }
  if (lodSnapLive(node, canvas)) {
    LOD.snapMisses++;
    return false;
  }
  const t = nowMs();
  if (t - (Number(rec.checkedAt) || 0) >= LOD_SNAP_SIG_MS) {
    rec.checkedAt = t;
    let sig = null;
    try {
      sig = lodSnapSignature(node, canvas);
    } catch (e) {
      lodSnapDrop(node, "signature failed");
      LOD.snapInvalid++;
      LOD.snapMisses++;
      return false;
    }
    if (sig !== rec.sig) {
      // The node changed — but what is held is a *complete* picture of the moment
      // before, and the old rule (drop it here, let the box ladder stand in) is
      // what made a node with one changing value flip between its picture and a
      // plain box on every change. Measured on the harness: a value rewritten
      // every 400 ms gave `pictured 1, 0, 1, 0 …` for as long as it changed.
      // So the picture stays up while the replacement is photographed, and it is
      // only given back if it stays out of date past LOD_SNAP_STALE_KEEP_MS —
      // which means the node is changing faster than the lane can photograph it,
      // and then it is photographed *less often* rather than never.
      lodVueChanged(node); // the node just changed: let it finish before the next try
      if (!rec.staleAt) rec.staleAt = t;
      LOD.snapInvalid++;
      const stale = t - rec.staleAt;
      if (stale <= LOD_SNAP_STALE_KEEP_MS) {
        LOD.snapStaleHeld++;
        lodSnapEnqueue(node, canvas, true); // and ask for a fresh one
        // falls through: the held picture is blitted below
      } else {
        // Changing faster than it can be photographed: give the box back for a
        // moment and stop asking so often (never "blocked for the session").
        LOD.snapMisses++;
        LOD.snapChurn++;
        rec.restaleHoldUntil = t + LOD_SNAP_CHURN_HOLD_MS;
        lodSnapNoteWhy(node, "changing faster than it can be photographed");
        return false;
      }
    } else if (rec.staleAt) {
      rec.staleAt = 0; // it matches again: nothing stale to show
    }
  }
  // The canvas's own shadow flag is compared, cheaply, on every reuse. If another
  // extension has turned shadows off for the duration of a gesture, the picture
  // (taken with them on) is not what the page is drawing right now: the box is
  // honest, and the bitmap is kept rather than thrown away — so the gesture ends
  // and the pictures are back without a single recapture.
  if (rec.shadows !== !!(canvas && canvas.render_shadows)) {
    LOD.snapFlagHeld++;
    LOD.snapMisses++;
    return false;
  }
  ctx.shadowColor = "transparent"; // the image carries its own shadows
  ctx.globalAlpha = 1; // and its own alpha (a muted node was captured dimmed)
  const src = lodSnapPick(rec, canvas);
  ctx.drawImage(src || rec.canvas, rec.x, rec.y, rec.w, rec.h);
  // The selection ring, around the box the node was pictured in — the same size the
  // live box had (`lodVueBoxSize`), which in the Vue renderer is the element's own
  // measured body rather than the node's graph size. Without that the ring would
  // jump, and sit inside the node the user just selected, on the frame the picture
  // replaced the live box. Nothing else belongs on a blit: a picture is only ever
  // served for a node with no progress and no errors (`lodSnapLive`), so there is no
  // state mark for a picture to be missing.
  if (node.selected) lodSnapSelectionRing(node, canvas, ctx);
  if (src && src !== rec.canvas) LOD.snapMipDrawn++;
  rec.usedFrame = LOD.snapFrame; // this frame is looking at it
  // Reuse order: the most recently used bitmap is the last to be evicted.
  LOD.snaps.delete(node);
  LOD.snaps.set(node, rec);
  LOD.snapDrawn++;
  return true;
}

// A node's picture came and went. Counted per node in a WeakMap rather than on the
// record, so an eviction (which deletes the record) is still visible as the switch
// it is: a high number here is the flicker a user reported, measured.
function lodSnapNoteMode(node, mode) {
  if (!node) return;
  if (!LOD.snapModes) LOD.snapModes = new WeakMap();
  const prev = LOD.snapModes.get(node);
  if (prev && prev !== mode) LOD.snapFlips++;
  LOD.snapModes.set(node, mode);
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
      if (!S.paused && S.enabled) S.raf.push(t, t - prev);
    }
    prev = t;
    if (!S.enabled) {
      govOwn(() => requestAnimationFrame(tick));
      return;
    }
    S.renderTicks++;
    govOwn(() => requestAnimationFrame(tick));
  };
    govOwn(() => requestAnimationFrame(tick));
}

function installMemorySampler() {
  if (!performance.memory) return;
  const sample = () => {
    if (S.enabled && !S.paused && performance.memory) S.mem.push(nowMs(), performance.memory.usedJSHeapSize);
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
  if (GOV.disabled || !S.enabled || !reg) return fn.apply(thisArg, args);
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

// Sources whose worst run is big enough to be felt, whatever their average is.
// A scan that walks every node on an interval is cheap most of the time and
// terrible sometimes; the average hides it, the worst run does not.
function govSpikySources(minWorstMs, minRuns) {
  try {
    return govRows()
      .filter((r) => !r.ours && !r.display && r.fires >= (minRuns || 3) && Number(r.worst) >= (minWorstMs || 120))
      .sort((a, b) => b.worst - a.worst);
  } catch (e) {
    return [];
  }
}

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
  position: fixed; top: 60px; left: 20px; right: auto; bottom: auto; width: 640px; height: 72vh;
  min-width: 320px; min-height: 220px; max-height: none;
  background: #1a1a1e; border: 1px solid #3a3a42; border-radius: 8px;
  box-shadow: 0 8px 24px rgba(0,0,0,0.5); color: #ddd;
  font: 12px/1.4 -apple-system, "Segoe UI", sans-serif;
  z-index: ${PANEL_Z}; display: none; flex-direction: column; overflow: hidden;
  container-type: inline-size; container-name: ants;
}
#ants-tracker-panel.open { display: flex; }
#ants-tracker-panel.ants-popped,
#ants-tracker-panel.ants-docked {
  position: relative; top: auto; right: auto; width: 100%; height: 100%;
  max-height: none; border-radius: 0; box-shadow: none;
}
#ants-tracker-resize {
  position: absolute; right: 0; bottom: 0; width: 16px; height: 16px;
  cursor: nwse-resize; z-index: 3;
  background: linear-gradient(135deg, transparent 50%, #6a5520 50%);
}
#ants-tracker-header {
  cursor: move; padding: 6px 10px; background: #26262c;
  border-bottom: 1px solid #3a3a42; display: flex; align-items: center;
  justify-content: space-between; user-select: none; gap: 8px; flex-wrap: wrap;
}
#ants-tracker-header b { color: #f0a020; }
#ants-tracker-header .ants-actions { display: flex; align-items: center; gap: 4px; flex-wrap: wrap; }
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
#ants-tracker-tabs { display: flex; flex-wrap: wrap; border-bottom: 1px solid #3a3a42; background: #202024; }
#ants-tracker-tabs button {
  flex: 1 1 auto; background: none; border: none; color: #999; padding: 6px 4px;
  cursor: pointer; font-size: 11px; border-bottom: 2px solid transparent;
  white-space: normal; line-height: 1.2;
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
.ants-inline { display: inline-flex; align-items: center; gap: 6px; margin: 4px 12px 4px 0; cursor: pointer; }
.ants-inline input[type="checkbox"] { width: 13px; height: 13px; accent-color: #6ea8fe; cursor: pointer; }
.ants-row .ants-inline { margin: 0; }
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
/* One setting, one row: name, control, a short line under both. The long text
   lives on the name's hover, the way a profile inspector lays a setting out. */
.ants-set {
  display: grid; grid-template-columns: minmax(148px, 34%) minmax(160px, 1fr);
  gap: 2px 12px; align-items: center;
  padding: 8px 0; border-bottom: 1px solid #2a2a32;
}
.ants-set-name { color: #eee; font-size: 12px; font-weight: 600; }
.ants-set-ctrl { min-width: 0; }
.ants-set-ctrl .ants-select { max-width: 100%; }
.ants-set-desc { grid-column: 1 / -1; color: #8b8b96; font-size: 11px; line-height: 1.35; margin: 0; }
@container ants (max-width: 460px) {
  .ants-set { grid-template-columns: 1fr; }
  .ants-sum-row { flex-direction: column; align-items: flex-start; }
}
/* Elements of a node that is currently drawn as a rectangle: see lodSweepDom. */
.ants-lod-box { display: none !important; }
/* A Vue node the canvas is drawing as a stand-in. The picture on the canvas *is*
   the node now, so its DOM must stop costing the page anything — and this is the
   one place where the tool can win in this renderer.
   opacity: 0 was the first answer and it is the wrong tool: Blink/WebKit keep an
   opacity-0 subtree in the render tree and still paint it (that is the finding that
   withdrew the "fewer node pixels" claim), so in Nodes 2.0 the tool added its
   pictures and its captures on top of a frontend that went on painting every node —
   cost with no saving, the opposite of what it does in the legacy renderer, where
   the expensive drawing was LiteGraph's own drawNode and the box replaced it.
   On a machine with hardware acceleration off that residual painting is real CPU
   work on every frame.
   visibility: hidden on the children is what actually takes the paint away: an
   engine skips a hidden subtree in the paint phase entirely, and *only* the paint
   — the elements stay in the DOM and in layout, so every rect, text metric,
   observer and re-measurement the tool and the frontend rely on is unchanged. The
   node's own box stays visible, so the node is still where the user left it as far
   as hit testing is concerned: selection and dragging keep working through the
   stand-in, which is the part of a node that is still usable at that zoom.
   With the picture drawn in the node's own structure (lodVueChromeInk) the user
   does not lose anything by this: the frame, the title bar, the body panel, the
   row of every widget the frontend mounts, the slot dots, the text and the media
   are all *in* the stand-in. */
[data-ants-vue-standin] { opacity: 0 !important; }
[data-ants-vue-standin] > * { visibility: hidden !important; }
/* One exception, and only one: a slot's dot. SlotConnectionDot.vue is the
   element that carries the pointerdown/click that *starts a link drag*, and
   linking a node has to keep working at low zoom exactly as it does in the canvas
   renderer — where LiteGraph hit-tests the slot on the canvas. The dot is a few
   pixels square, it is drawn into the picture at the same rect in the same colour,
   and hiding it would take a connection away from the user to save a circle. A
   visible descendant of a hidden ancestor is painted and hit-tested, which is
   exactly what is wanted here. */
[data-ants-vue-standin] .slot-dot { visibility: visible !important; }
/* Same reason as the stand-in attribute: a Vue-rendered node's root has its
   class rewritten by Vue on every re-render, so what hides it for the fovea and
   what makes it stop answering live on attributes the frontend never touches. */
[data-ants-dom-hidden] { display: none !important; }
[data-ants-dom-inert] { pointer-events: none !important; }
.ants-off-note {
  border-left: 3px solid #AE7719; padding: 6px 8px; margin: 6px 0;
  background: rgba(174, 119, 25, 0.08); color: #e8e8ee;
}
/* The tracker's own node UI: a pill holding a round switch and the gear that
   opens the panel. Marked with .ants-own, which every low-zoom sweep skips — this
   is the control that switches the tool off, so it must be reachable at 10% zoom
   with every setting on, on a page where nothing else is. */
.ants-node-pill {
  display: inline-flex; align-items: center; gap: 6px;
  padding: 3px; margin: 5px 0;
  border: 1px solid rgba(174, 119, 25, 0.55);
  border-radius: 999px;
  background: rgba(0, 0, 0, 0.12);
  width: max-content; box-sizing: border-box;
}
.ants-node-pill button {
  /* 22px including the ring, and the same 22px the glyph is drawn in: one unit of
     the glyph's viewBox is one pixel, so the gear's tips and the ring's centre line
     are the same circle. */
  width: 22px; height: 22px; padding: 0; margin: 0; box-sizing: border-box;
  display: inline-flex; align-items: center; justify-content: center;
  border-radius: 50%;
  background: transparent;
  cursor: pointer;
  line-height: 0;
  font: inherit;
  -webkit-appearance: none; appearance: none;
}
.ants-node-btn-gear { border: none; }
.ants-node-btn-gear svg { stroke: #AE7719; }
.ants-node-btn-tick {
  /* The ring is the same line as the gear's silhouette, in the same colour. */
  border: 1.5px solid #AE7719 !important;
  background: transparent; /* unchecked: the theme's own background, no fill of ours */
}
.ants-node-btn-tick svg { stroke: #AE7719; }
.ants-node-btn-tick[aria-checked="true"] {
  /* Checked: the inside becomes the dark fill, ring and checkmark stay the accent. */
  background: #0D2A2A !important;
}
/* Hovering never changes the accent: both controls are #AE7719, checked or not,
   hovered or not. Only the background behind them moves. */
.ants-node-btn:hover { background: rgba(174, 119, 25, 0.16); }
.ants-node-btn-tick:hover { border-color: #AE7719 !important; }
.ants-node-btn-tick[aria-checked="true"]:hover { background: #0D2A2A !important; }
/* Focus mode: the node's DOM UI is switched off — no hover, no click, no wheel
   capture, no tooltips — while it is too small on screen to be used, or while it
   is far enough off screen not to be looked at. Only the *widgets* go: the node
   itself still selects, drags and opens its menu, and the canvas still pans and
   zooms. This is not only about the user's own mouse: a 3D viewport decides
   whether to render by asking whether the pointer is over it (see load3d's
   isLoad3dActive), so an inert widget stops redrawing a Three.js scene nobody is
   looking at. The descendant rule is deliberate: pointer-events:none on an
   ancestor is overridden by a descendant that sets auto on itself, and the
   frontend's widget layer sets pointer-events inline on the very wrappers this
   class lands on. */
.ants-lod-inert, .ants-lod-inert * { pointer-events: none !important; user-select: none !important; }
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
/* The floating pill: the switch and the gear, pinned to the screen. Wherever it
   is dragged, it stays — and no setting and no click on the switch ever takes it
   away, because it is the way back. */
#ants-corner-pill {
  position: fixed; bottom: 16px; right: 16px; z-index: 99998;
  margin: 0; cursor: pointer; box-shadow: 0 2px 8px rgba(0,0,0,0.4);
  /* Slightly more solid than the node's pill: this one floats over the canvas,
     which can be anything. */
  background: rgba(24, 24, 28, 0.9);
}
#ants-corner-pill .ants-node-btn { cursor: pointer; }
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
  if (opts.type) node.type = opts.type;
  if (opts.checked !== undefined) node.checked = !!opts.checked;
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
  active: "tweaks",
  refreshTimer: null,
  prevScroll: {},
  built: false,
  pauseBtn: null,
};

// The separate window. examples/pop_up_window opens a real page at its own
// route and syncs with the node through a small API (a revision and an origin,
// so neither side is the master). This is that pattern: /ants_optimizer/window
// is the page, /ants_optimizer/ui is the link. The page is not moved into the
// popup, and the popup does not run on the canvas. A blocked popup is the only
// reason the in-page panel opens.
const ANTS_WINDOW_URL = "/ants_optimizer/window";
const ANTS_WINDOW_NAME = "ants-optimizer";
const ANTS_WINDOW_W = 980;
const ANTS_WINDOW_H = 840;
const ANTS_WINDOW_BLOCKED = "The browser blocked the separate window. This panel is the fallback. Allow pop-ups for this site, then use Window.";
let antsUiSilent = false;
let antsUiRev = 0;
let antsUiCommandRev = 0;
let antsUiTimer = null;
let antsUiHot = false;
let antsUiOpened = false;
let antsUiReport = "";

function antsUiLimits() {
  return {
    flatZoom: LOD_FLAT_ZOOM.slice(),
    inertZoom: VIEW_INERT_ZOOMS.slice(),
    focusDom: VIEW_FOCUS_DOM.slice(),
    foveaMargins: VIEW_FOVEA_MARGINS.slice(),
    foveaRestores: VIEW_FOVEA_RESTORES.slice(),
    displayScales: VIEW_DISPLAY_SCALES.slice(),
    idleCapMs: LOD_IDLE_CAP_MS.slice(),
    detailZoom: LOD_DETAIL_ZOOMS.slice(),
    boxDetail: LOD_BOX_DETAIL.slice(),
    snapRatios: LOD_SNAP_RATIOS.slice(),
    snapBudgets: LOD_SNAP_BUDGETS.slice(),
    linkWidth: LOD_LINK_WIDTH,
    linkStyles: LOD_LINK_STYLES.slice(),
  };
}

function antsUiSettings() {
  return {
    flatBelow: LOD.flatBelow,
    boxDetail: LOD.boxDetail,
    snapshots: !!LOD.snapOn,
    snapRatio: LOD.snapRatio,
    snapMb: LOD.snapMb,
    snapExclude: LOD.snapExclude ? LOD.snapExclude.slice() : [],
    detailZoom: LOD.detailZoom,
    diskOn: !!LOD.diskOn,
    linkZoom: !!LOD.linkZoom,
    idleCapMs: LOD.idleCapMs,
    linkStyle: LOD.linkStyle,
    inertBelow: LOD.inertBelow,
    fovea: !!LOD.fovea,
    focusDom: LOD.focusDom,
    foveaMargin: LOD.foveaMargin,
    foveaRestore: LOD.foveaRestore,
    displayScale: LOD.displayScale,
    enabled: antsEnabled(),
    paused: !!S.paused,
  };
}

function antsUiTelemetry() {
  let snapshot = null;
  try {
    snapshot = buildSnapshot();
  } catch (e) {
    snapshot = null;
  }
  const tel = {
    snapshot,
    drawing: {
      version: VERSION,
      enabled: antsEnabled(),
      paused: !!S.paused,
      zoom: lodZoomOf(),
      flatBelow: LOD.flatBelow,
      snapOn: !!LOD.snapOn,
      snapDrawn: LOD.snapDrawn,
      snapCaptured: LOD.snapCaptured,
      snapBytes: LOD.snapBytes,
      snapMb: LOD.snapMb,
      snapMisses: LOD.snapMisses,
      diskOn: !!LOD.diskOn,
      diskLoaded: LOD.diskLoaded,
      diskSaved: LOD.diskSaved,
      diskDir: LOD.diskDir || "",
      ab: LOD.ab && LOD.ab.text ? String(LOD.ab.text) : "",
    },
  };
  if (antsUiReport) {
    tel.report = antsUiReport;
    antsUiReport = "";
  }
  return tel;
}

function antsUiPost(body) {
  try {
    const payload = JSON.stringify(body);
    const p = fetch("/ants_optimizer/ui", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: payload,
    });
    if (p && typeof p.then === "function") return p.then(() => null).catch(() => null);
  } catch (e) {
    /* the route is optional; the page still applies the change locally */
  }
  return Promise.resolve(null);
}

function antsUiPublishSettings() {
  if (antsUiSilent) return;
  try {
    antsUiPost({ origin: "page", settings: antsUiSettings(), limits: antsUiLimits() });
  } catch (e) {
    /* a publish must not take a setting change back */
  }
}

function antsUiPublishTelemetry() {
  try {
    return antsUiPost({ origin: "page", telemetry: antsUiTelemetry(), limits: antsUiLimits() });
  } catch (e) {
    return Promise.resolve(null);
  }
}

function antsUiApplySettings(settings) {
  if (!settings || typeof settings !== "object") return;
  const o = {};
  for (const key of [
    "flatBelow", "boxDetail", "snapshots", "snapRatio", "snapMb", "snapExclude",
    "detailZoom", "diskOn", "idleCapMs", "linkStyle", "linkZoom", "inertBelow",
    "fovea", "focusDom", "foveaMargin", "foveaRestore", "displayScale",
  ]) {
    if (key in settings) o[key] = settings[key];
  }
  antsUiSilent = true;
  try {
    if ("enabled" in settings && !!settings.enabled !== antsEnabled()) antsSetEnabled(!!settings.enabled);
    if (Object.keys(o).length) lodSet(o);
    if ("paused" in settings && !!settings.paused !== !!S.paused) togglePause();
  } catch (e) {
    /* a bad payload must not break the page that is drawing */
  } finally {
    antsUiSilent = false;
  }
}

function antsUiApplyRemote(body) {
  if (!body || typeof body !== "object" || body.ok === false) return;
  const rev = Number(body.rev) || 0;
  if (rev !== antsUiRev && body.origin === "window" && body.settings) {
    antsUiRev = rev;
    antsUiApplySettings(body.settings);
  } else if (rev !== antsUiRev) {
    antsUiRev = rev;
  }
  const cr = Number(body.commandRev) || 0;
  if (cr === antsUiCommandRev || body.origin === "page" || !body.command) return;
  antsUiCommandRev = cr;
  const label = String(body.commandLabel || "");
  try {
    if (body.command === "measure-links") lodAbStart();
    else if (body.command === "reset") resetAllStats();
    else if (body.command === "report") antsUiReport = buildTelemetryReport();
    else if (body.command === "mute" && label && !S.muted.has(label)) toggleMute(label);
    else if (body.command === "unmute" && label && S.muted.has(label)) toggleMute(label);
  } catch (e) {
    /* the command can be sent again */
  }
}

function antsWindowLive() {
  const child = ui.popout;
  if (child && child.closed) ui.popout = null;
  if (ui.popout && !ui.popout.closed) return true;
  return antsUiOpened || antsUiHot;
}

function antsUiSchedule() {
  if (antsUiTimer) return;
  const arm = () => {
    antsUiTimer = null;
    Promise.resolve(antsUiPump()).then(() => {
      if (antsUiOpened || (ui.popout && !ui.popout.closed)) antsUiSchedule();
    });
  };
  try {
    antsUiTimer = govOwn(() => setTimeout(arm, antsWindowLive() ? 500 : 2000));
  } catch (e) {
    antsUiTimer = setTimeout(arm, antsWindowLive() ? 500 : 2000);
  }
}

async function antsUiPump() {
  try {
    const res = await fetch("/ants_optimizer/ui?from=page");
    if (res && res.ok && typeof res.json === "function") {
      const body = await res.json();
      antsUiApplyRemote(body);
      const age = body && body.heardAge;
      antsUiHot = typeof age === "number" && age >= 0 && age < 3;
      if (ui.popout && ui.popout.closed) {
        ui.popout = null;
        antsUiOpened = false;
      }
      if (antsWindowLive()) await antsUiPublishTelemetry();
    }
  } catch (e) {
    /* no route, no bus — the in-page panel still works */
  }
}

function antsUiStart() {
  antsUiSchedule();
}

function antsSayBlocked(text) {
  LOD.popoutNote = text || "";
  if (ui.popNote) {
    ui.popNote.style.display = text ? "" : "none";
    ui.popNote.textContent = text || "";
  }
}

function antsWindowBox() {
  const w = ANTS_WINDOW_W;
  const h = ANTS_WINDOW_H;
  const sx = Number(window.screenX != null ? window.screenX : window.screenLeft) || 0;
  const sy = Number(window.screenY != null ? window.screenY : window.screenTop) || 0;
  const ow = Number(window.outerWidth) || Number(window.innerWidth) || 1280;
  const oh = Number(window.outerHeight) || Number(window.innerHeight) || 800;
  return {
    w,
    h,
    left: Math.round(sx + (ow - w) / 2),
    top: Math.round(sy + (oh - h) / 2),
  };
}

function antsFocusWindow() {
  const child = ui.popout;
  if (!child || child.closed) {
    if (child && child.closed) ui.popout = null;
    return false;
  }
  try {
    if (typeof child.focus === "function") child.focus();
  } catch (e) {
    /* focusing is optional; the window is already open */
  }
  return true;
}

function antsTryOpenWindow() {
  if (antsFocusWindow()) return true;
  if (typeof window.open !== "function") return false;
  const box = antsWindowBox();
  const features = `popup=yes,resizable=yes,width=${box.w},height=${box.h},left=${box.left},top=${box.top}`;
  let child = null;
  try {
    child = window.open(ANTS_WINDOW_URL, ANTS_WINDOW_NAME, features);
  } catch (e) {
    child = null;
  }
  if (!child) return false;
  try {
    if (typeof child.moveTo === "function") child.moveTo(box.left, box.top);
    if (typeof child.resizeTo === "function") child.resizeTo(box.w, box.h);
    if (typeof child.focus === "function") child.focus();
  } catch (e) {
    /* features already asked for the same box */
  }
  ui.popout = child;
  antsUiOpened = true;
  antsSayBlocked("");
  try {
    antsUiPublishSettings();
    antsUiPublishTelemetry();
  } catch (e) {
    /* the window polls; a missed first post is not a failed open */
  }
  antsUiStart();
  if (ui.panel && ui.panel.classList.contains("open") && !ui.panel.classList.contains("ants-docked")) {
    togglePanel(false);
  }
  return true;
}

function antsOpenFromGear() {
  if (antsFocusWindow()) return;
  if (typeof window.open === "function") {
    if (antsTryOpenWindow()) return;
    togglePanel(true);
    antsSayBlocked(ANTS_WINDOW_BLOCKED);
    return;
  }
  togglePanel();
}

function antsOpenFromApi() {
  if (antsFocusWindow()) return;
  if (typeof window.open === "function") {
    if (antsTryOpenWindow()) return;
    togglePanel(true);
    antsSayBlocked(ANTS_WINDOW_BLOCKED);
    return;
  }
  togglePanel(true);
}

function antsPopout() {
  if (antsTryOpenWindow()) return true;
  togglePanel(true);
  antsSayBlocked(ANTS_WINDOW_BLOCKED);
  return false;
}

// A right-anchored panel grows to the left when its width changes, which is the
// opposite of the corner being dragged. Pin left and top first, then change
// only width and height, so the dragged corner is the one that moves.
function antsPanelBox(panel) {
  let left = parseFloat(panel.style.left);
  let top = parseFloat(panel.style.top);
  let width = parseFloat(panel.style.width);
  let height = parseFloat(panel.style.height);
  try {
    if (typeof panel.getBoundingClientRect === "function") {
      const rect = panel.getBoundingClientRect();
      if (rect && rect.width > 0 && rect.height > 0) {
        if (Number.isFinite(rect.left)) left = rect.left;
        if (Number.isFinite(rect.top)) top = rect.top;
        width = rect.width;
        height = rect.height;
      }
    }
  } catch (e) {
    /* style is enough when the box cannot be measured */
  }
  if (!Number.isFinite(width) || width <= 0) width = 640;
  if (!Number.isFinite(height) || height <= 0) height = 520;
  if (!Number.isFinite(left)) {
    const right = parseFloat(panel.style.right);
    const vw = (typeof window !== "undefined" && window.innerWidth) || 1280;
    left = Number.isFinite(right) ? vw - right - width : Math.max(8, vw - width - 20);
  }
  if (!Number.isFinite(top)) top = 60;
  return { left, top, width, height };
}

function antsPinPanel(panel) {
  if (!panel || (panel.classList && panel.classList.contains("ants-docked"))) return null;
  const box = antsPanelBox(panel);
  panel.style.left = `${Math.round(box.left)}px`;
  panel.style.top = `${Math.round(box.top)}px`;
  panel.style.right = "auto";
  panel.style.bottom = "auto";
  return box;
}

function antsRememberPanel(panel) {
  try {
    const box = {
      left: panel.style.left,
      top: panel.style.top,
      w: panel.style.width,
      h: panel.style.height,
    };
    localStorage.setItem("ants-tracker-panel-box", JSON.stringify(box));
    localStorage.setItem("ants-tracker-panel-size", JSON.stringify({ w: box.w, h: box.h }));
  } catch (e) {
    /* remembering the size is optional */
  }
}

function antsPlacePanel(panel) {
  if (!panel || (panel.classList && panel.classList.contains("ants-docked"))) return;
  let saved = null;
  try {
    const raw = localStorage.getItem("ants-tracker-panel-box") || localStorage.getItem("ants-tracker-panel-size");
    if (raw) saved = JSON.parse(raw);
  } catch (e) {
    saved = null;
  }
  if (saved && saved.w) panel.style.width = String(saved.w);
  if (saved && saved.h) {
    panel.style.height = String(saved.h);
    panel.style.maxHeight = "none";
  }
  if (saved && saved.left) {
    panel.style.left = String(saved.left);
    panel.style.top = saved.top ? String(saved.top) : "60px";
  } else {
    const width = parseFloat(panel.style.width) || 640;
    const vw = (typeof window !== "undefined" && window.innerWidth) || 1280;
    panel.style.left = `${Math.max(8, Math.round(vw - width - 20))}px`;
    if (!panel.style.top) panel.style.top = "60px";
  }
  panel.style.right = "auto";
  panel.style.bottom = "auto";
}

function antsInstallResize(panel) {
  const grip = el("div", {
    id: "ants-tracker-resize",
    title: "Drag to resize. The corner you drag is the corner that moves.",
  });
  panel.appendChild(grip);
  let dragging = false;
  let startX = 0;
  let startY = 0;
  let startW = 640;
  let startH = 520;
  let startLeft = 0;
  let startTop = 0;
  grip.addEventListener("mousedown", (e) => {
    dragging = true;
    startX = e.clientX;
    startY = e.clientY;
    const pinned = antsPinPanel(panel) || antsPanelBox(panel);
    startW = pinned.width || 640;
    startH = pinned.height || 520;
    startLeft = pinned.left;
    startTop = pinned.top;
    if (e.preventDefault) e.preventDefault();
    if (e.stopPropagation) e.stopPropagation();
  });
  window.addEventListener("mousemove", (e) => {
    if (!dragging) return;
    const w = Math.max(320, Math.min(1600, startW + (e.clientX - startX)));
    const h = Math.max(220, Math.min(1400, startH + (e.clientY - startY)));
    panel.style.width = `${Math.round(w)}px`;
    panel.style.height = `${Math.round(h)}px`;
    panel.style.maxHeight = "none";
    // Left and top stay where the press put them. Width grows to the right,
    // height grows down — the same direction as the pointer.
    panel.style.left = `${Math.round(startLeft)}px`;
    panel.style.top = `${Math.round(startTop)}px`;
    panel.style.right = "auto";
    panel.style.bottom = "auto";
  });
  window.addEventListener("mouseup", () => {
    if (!dragging) return;
    dragging = false;
    antsRememberPanel(panel);
  });
}

function buildPanel() {
  if (ui.built) return ui.panel;
  injectStyle();

  const panel = el("div", { id: "ants-tracker-panel", class: ANTS_OWN_CLASS });
  ui.panel = panel;

  const header = el("div", { id: "ants-tracker-header" });
  const title = el("span");
  title.appendChild(el("b", { text: "ANTs" }));
  title.appendChild(document.createTextNode(` Frontend Optimizer v${VERSION}`));
  const actions = el("div", { class: "ants-actions" });
  const copyBtn = el("span", {
    class: "ants-hbtn",
    text: "📋 Copy",
    title: "Copy a plain-text snapshot of every tab, for pasting into a chat or bug report",
  });
  ui.powerBtn = el("span", {
    class: "ants-hbtn",
    text: "⏻ Off",
    title:
      "Switch the hooks and the optimisations off: no hooks wrapped, no sampling, no scheduler deferrals, no redraw cap, no low-zoom drawing, " +
      "no DOM touched. Same switch as the checkbox on the floating button (and on the tracker's own node). Your settings are kept, and come " +
      "back when you switch it on again.",
  });
  ui.pauseBtn = el("span", {
    class: "ants-hbtn",
    text: "⏸ Pause",
    title: "Freeze sampling so the numbers stop moving while you read them. Rendering is untouched.",
  });
  const resetBtn = el("span", { class: "ants-hbtn", text: "⟲ Reset", title: "Clear all recorded samples (keeps mutes and settings)" });
  const windowBtn = el("span", {
    class: "ants-hbtn",
    text: "Window",
    title:
      "Open the separate window. It is its own page, not this panel moved, and not a second ComfyUI. If the browser blocks it, this panel stays and says so.",
  });
  const closeBtn = el("span", { class: "ants-hbtn", text: "✕", title: "Close" });
  actions.appendChild(copyBtn);
  actions.appendChild(ui.powerBtn);
  actions.appendChild(ui.pauseBtn);
  actions.appendChild(resetBtn);
  actions.appendChild(windowBtn);
  actions.appendChild(closeBtn);
  header.appendChild(title);
  header.appendChild(actions);
  panel.appendChild(header);

  // The state banner. With the tracker switched off the panel still opens (the
  // gear on the node is the way back), and this is what it says instead of a wall
  // of frozen numbers.
  ui.offBanner = el("div", { id: "ants-tracker-off-banner", class: "ants-note" });
  ui.offBanner.style.display = "none";
  panel.appendChild(ui.offBanner);

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
    ["tweaks", "Node Rendering Settings"],
    ["status", "Status"],
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
  windowBtn.addEventListener("click", () => antsPopout());
  ui.popNote = el("div", { id: "ants-tracker-popnote", class: "ants-note", style: { display: "none" } });
  panel.appendChild(ui.popNote);
  antsInstallResize(panel);
  antsPlacePanel(panel);
  resetBtn.addEventListener("click", () => resetAllStats(true));
  if (ui.powerBtn) {
    ui.powerBtn.addEventListener("click", () => {
      antsSetEnabled(!antsEnabled());
    });
  }
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
  let startLeft = 0;
  let startTop = 0;
  handle.addEventListener("mousedown", (e) => {
    if (e.target && typeof e.target.closest === "function" && e.target.closest(".ants-hbtn")) return;
    if (target.classList && target.classList.contains("ants-docked")) return;
    dragging = true;
    startX = e.clientX;
    startY = e.clientY;
    const pinned = antsPinPanel(target) || { left: 0, top: 0 };
    startLeft = pinned.left;
    startTop = pinned.top;
    if (e.preventDefault) e.preventDefault();
  });
  window.addEventListener("mousemove", (e) => {
    if (!dragging) return;
    target.style.left = `${Math.round(startLeft + (e.clientX - startX))}px`;
    target.style.top = `${Math.round(Math.max(0, startTop + (e.clientY - startY)))}px`;
    target.style.right = "auto";
    target.style.bottom = "auto";
  });
  window.addEventListener("mouseup", () => {
    if (!dragging) return;
    dragging = false;
    antsRememberPanel(target);
  });
}

// ------------------------------------------------------------ summary bar --

function renderSummary() {
  if (ui.offBanner) {
    setText(
      ui.offBanner,
      S.enabled
        ? ""
        : "The hooks and the optimisations are switched off. Nothing is wrapped, sampled, deferred or drawn differently: this page is ComfyUI's " +
          "own, and the numbers below are the last ones recorded before it went off. The switch next to the gear on the floating button — " +
          "or ⏻ On here — turns them back on with exactly the settings you had."
    );
    ui.offBanner.style.display = S.enabled ? "none" : "block";
    ui.offBanner.classList.toggle("ants-off-note", !S.enabled);
  }
  if (ui.powerBtn) {
    setText(ui.powerBtn, S.enabled ? "⏻ Off" : "⏻ On");
    ui.powerBtn.classList.toggle("active", !S.enabled);
  }
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

function buildStatusTab(container) {
  container.appendChild(el("div", { class: "ants-section-title", text: "Status" }));
  const lodLine = el("div", { class: "ants-note", style: { whiteSpace: "pre-wrap" } });
  container.appendChild(lodLine);
  ui.lodLine = lodLine;
  ui.state.status = {
    update: () => {
      if (ui.lodUpdate) ui.lodUpdate();
    },
  };
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
  container.appendChild(el("div", { class: "ants-section-title", text: "Node rendering" }));

  function settingRow(name, control, desc, hover) {
    const row = el("div", { class: "ants-set" });
    const label = el("div", { class: "ants-set-name", text: name });
    if (hover) {
      label.title = hover;
      if (control) control.title = hover;
    }
    row.appendChild(label);
    const ctrl = el("div", { class: "ants-set-ctrl" });
    if (control) ctrl.appendChild(control);
    row.appendChild(ctrl);
    if (desc) row.appendChild(el("div", { class: "ants-set-desc", text: desc }));
    container.appendChild(row);
    return row;
  }

  const lodFlatSel = el("select", { class: "ants-select" });
  for (const z of LOD_FLAT_ZOOM) {
    const opt = el("option", {
      text: z === 0 ? "off — draw every node" : `below ${Math.round(z * 100)}%`,
    });
    opt.value = String(z);
    lodFlatSel.appendChild(opt);
  }
  lodFlatSel.value = String(LOD.flatBelow);
  lodFlatSel.addEventListener("change", () => {
    const z = Number(lodFlatSel.value) || 0;
    if (LOD.linkZoom) lodSet({ flatBelow: z, inertBelow: z });
    else lodSet({ flatBelow: z });
    lodUpdate();
  });
  settingRow(
    "Replace node previews with bitmap stand-ins at zoom levels",
    lodFlatSel,
    "Below this zoom a node is one picture instead of a live draw. Hover, selection and a drag keep the picture. A selected node gets a ring, not a box. A link drag, a running bar or an error still draws live.",
    "A zoom, not a node size. Past this percentage means zoomed out below it. A node whose own UI hides or adds a widget changes size while you look at it, and a per-node pixel rule then flips that node in and out of the stand-in. A zoom classifies every node the same way, once per frame. Collapsed nodes and this tool's own node are never replaced. Nothing about the graph changes. Off, or Back to full drawing, restores ComfyUI's own draw. The node stays clickable either way. While the link below is on, this zoom and the widget-stop zoom are the same, and the higher one wins."
  );

  const lodStandSel = el("select", { class: "ants-select" });
  for (const [id, text] of [
    ["plain", "plain fill"],
    ["title", "title bar colour"],
    ["state", "title, error ring, progress, muted"],
    ["picture", "picture of the node"],
  ]) {
    const opt = el("option", { text });
    opt.value = id;
    lodStandSel.appendChild(opt);
  }
  lodStandSel.value = LOD.snapOn ? "picture" : LOD.boxDetail;
  lodStandSel.addEventListener("change", () => {
    const v = lodStandSel.value;
    if (v === "picture") lodSet({ snapshots: true });
    else lodSet({ snapshots: false, boxDetail: v });
    lodUpdate();
  });
  settingRow(
    "Stand-in",
    lodStandSel,
    "What replaces the node. A picture is a bitmap of the node itself. Until one is ready, the painted fill stands in.",
    "Plain, title and state are painted rectangles. They never decide which nodes are replaced — the zoom above does. A picture is captured once while the page is idle and drawn in the node's place, the same way a box was. Image previews are not a second system: the picture is the preview, and it replaces the node, not a box inside it. A node that draws nothing into the canvas keeps the fill, because a transparent picture would erase it. Switching to a fill releases the stored bitmaps."
  );

  // The keep-live list. The snapshot engine has honoured `snapExclude` since
  // v2.4.0 and the readout names it ("kept live by your list"), but until now
  // the only way to add a type was the console — a mechanism with no door.
  const snapKeepInput = el("input", { class: "ants-select", type: "text" });
  snapKeepInput.placeholder = "PreviewImage, VHS_VideoCombine, …";
  snapKeepInput.value = (LOD.snapExclude || []).join(", ");
  const commitSnapKeep = () => {
    const list = String(snapKeepInput.value || "")
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
    lodSet({ snapExclude: list });
    // lodSet trims and caps; show exactly what was accepted, not what was typed.
    snapKeepInput.value = (LOD.snapExclude || []).join(", ");
    lodUpdate();
  };
  snapKeepInput.addEventListener("change", commitSnapKeep);
  snapKeepInput.addEventListener("blur", commitSnapKeep);
  settingRow(
    "Keep these node types live",
    snapKeepInput,
    "Comma-separated node types that are never served from a picture: they keep their painted fill, or draw live, however far you zoom out.",
    "A type on this list is counted apart from a failure — the readout's \"kept live on purpose\" is this setting doing its job. It is the escape hatch for a type whose picture is wrong for a reason this tool cannot see (a node that reads state it does not draw, a canvas that other code writes asynchronously). Matching is exact and case-sensitive, against the type name on the node."
  );

  const snapRatioSel = el("select", { class: "ants-select" });
  for (const r of LOD_SNAP_RATIOS) {
    const opt = el("option", { text: `capture ${r}x per graph unit` });
    opt.value = String(r);
    snapRatioSel.appendChild(opt);
  }
  snapRatioSel.value = String(LOD.snapRatio);
  snapRatioSel.addEventListener("change", () => {
    lodSet({ snapRatio: Number(snapRatioSel.value) || 0 });
    if (LOD.snapOn) lodSnapClear("ratio");
    lodUpdate();
  });
  settingRow(
    "Stand-in capture resolution",
    snapRatioSel,
    "Pixels per graph unit in the photograph. 1x is the default. 0.25x and 0.5x are choices for a large graph. Half and quarter copies of whatever you capture are still made for the screen.",
    "The graph canvas is Canvas2D. It has no mipmap format drawImage can sample, and a WebGL mip chain cannot be handed to it. The 1x capture is downscaled here to 1/2 and 1/4, and the blit uses the smallest copy whose longest side still covers the on-screen device pixels: node size times zoom times display scale. At 20% zoom on a 200% display a typical node needs the half copy. The quarter copy is only used when the screen cannot show those extra pixels, which is around 10% and below. 2x and 3x cost four and nine times the memory and only help near 100% zoom."
  );

  const snapMbSel = el("select", { class: "ants-select" });
  for (const mb of LOD_SNAP_BUDGETS) {
    const opt = el("option", { text: `${mb} MiB` });
    opt.value = String(mb);
    snapMbSel.appendChild(opt);
  }
  snapMbSel.value = String(LOD.snapMb);
  snapMbSel.addEventListener("change", () => {
    lodSet({ snapMb: Number(snapMbSel.value) || 0 });
    lodUpdate();
  });
  settingRow(
    "Stand-in memory (ram) budget",
    snapMbSel,
    "How much RAM the stand-in pictures may hold. A picture on screen is not released to make room for another picture.",
    "4096 MiB is the default only when nothing is saved. A saved 256, 512, 1024 or 2048 stays. 8192 is the top of the ladder. Releasing a picture that is being drawn is what flicker looks like, so a full budget refuses a new capture instead. This is canvas memory outside the JS heap, so the Memory tab cannot see it. On Execute or Run-to-node, if system RAM is at 85% the off-screen stand-ins leave memory; at 95% all of them do. Disk files stay, and are loaded back when the run finishes. If /system_stats does not report RAM, nothing is released."
  );

  const diskSel = el("select", { class: "ants-select" });
  for (const [id, text] of [
    ["on", "on"],
    ["off", "off — memory only"],
  ]) {
    const opt = el("option", { text });
    opt.value = id;
    diskSel.appendChild(opt);
  }
  diskSel.value = LOD.diskOn ? "on" : "off";
  diskSel.addEventListener("change", () => {
    lodSet({ diskOn: diskSel.value === "on" });
    lodUpdate();
  });
  settingRow(
    "Keep stand-in previews on disk",
    diskSel,
    "Loaded from ComfyUI's temp/ANTs_Frontend_Optimizer_THUMBNAILS next time, keyed by node id and a signature of what it draws. A change overwrites the file. Deleting the node deletes the file. Files older than a week are removed.",
    "The page cannot write a folder itself. The route writes under the running ComfyUI temp directory. The folder is detected from ComfyUI's own temp path, or from this pack's location if that import is missing. A signature mismatch is not shown: the node is photographed again and the old file is replaced. If the route is missing, the memory cache continues and nothing is written."
  );

  const lodIdleSel = el("select", { class: "ants-select" });
  for (const ms of LOD_IDLE_CAP_MS) {
    const opt = el("option", { text: ms === 0 ? "redraw as often as asked" : `${Math.round(1000 / ms)}/s while nothing is touched` });
    opt.value = String(ms);
    lodIdleSel.appendChild(opt);
  }
  lodIdleSel.value = String(LOD.idleCapMs);
  lodIdleSel.addEventListener("change", () => {
    lodSet({ idleCapMs: Number(lodIdleSel.value) });
    lodUpdate();
  });
  settingRow(
    "Idle redraw cap",
    lodIdleSel,
    "While nobody is touching the page, redraws are limited to this rate. Touch the page and the cap lifts at once.",
    "A rate limit, not data loss: the last request of a burst still gets one trailing redraw. It does not change what a node or a link looks like."
  );

  container.appendChild(el("div", { class: "ants-section-title", text: "Links" }));

  const lodLinkSel = el("select", { class: "ants-select" });
  for (const [id, text] of [
    ["spline", "links: keep every curve"],
    ["straight", "links: always straight lines"],
  ]) {
    const opt = el("option", { text });
    opt.value = id;
    lodLinkSel.appendChild(opt);
  }
  lodLinkSel.value = LOD.linkStyle;
  lodLinkSel.addEventListener("change", () => {
    lodSet({ linkStyle: lodLinkSel.value });
    lodUpdate();
  });
  settingRow(
    "Link shape",
    lodLinkSel,
    "The shape of a link, and only that. It never paints a node.",
    "Keep every curve draws links the way ComfyUI draws them, at every zoom, whatever the node setting is doing. Always straight lines is for graphs that were drawn with straight links to begin with."
  );

  const lodDetailSel = el("select", { class: "ants-select" });
  for (const z of LOD_DETAIL_ZOOMS) {
    const opt = el("option", {
      text: z === 0 ? "full link and node detail" : `links thinned below ${Math.round(z * 100)}% zoom`,
    });
    opt.value = String(z);
    lodDetailSel.appendChild(opt);
  }
  lodDetailSel.value = String(LOD.detailZoom);
  lodDetailSel.addEventListener("change", () => {
    lodSet({ detailZoom: Number(lodDetailSel.value) });
    lodUpdate();
  });
  settingRow(
    "Link thinning",
    lodDetailSel,
    "Below this zoom, links are stroked 1px wide instead of 3 and lose the dark outline. The curves stay where they were. Link ink and nothing else.",
    "This setting changes link ink and nothing else: it does not flatten a node, does not hide a widget, and does not touch the frame's own quality flag. The two values are put back as soon as the link is drawn. It does not reach the frontend walking every input slot of every node before it decides which links are on screen."
  );

  const lodAbBtn = el("button", { class: "ants-btn", text: "Measure link thinning" });
  lodAbBtn.addEventListener("click", () => {
    if (LOD.ab && !LOD.ab.done) return;
    lodAbStart();
    lodUpdate();
  });
  settingRow(
    "Measure it",
    lodAbBtn,
    "Alternates thinning on and off on this page and compares the two halves. Nothing is saved. The setting is put back at the end.",
    "Answers whether this setting is doing anything here by measuring instead of arguing. One second each, three times over, on the connections stage of the frame budget."
  );

  container.appendChild(el("div", { class: "ants-section-title", text: "Viewport focus" }));

  const viewInertSel = el("select", { class: "ants-select" });
  for (const z of VIEW_INERT_ZOOMS) {
    const opt = el("option", { text: z === 0 ? "never (nodes stay live)" : `below ${Math.round(z * 100)}% zoom` });
    opt.value = String(z);
    viewInertSel.appendChild(opt);
  }
  viewInertSel.value = String(LOD.inertBelow);
  viewInertSel.addEventListener("change", () => {
    const z = Number(viewInertSel.value) || 0;
    if (LOD.linkZoom) lodSet({ inertBelow: z, flatBelow: z });
    else lodSet({ inertBelow: z });
    lodUpdate();
  });
  settingRow(
    "Widgets stop answering",
    viewInertSel,
    "Below this zoom a node's widgets ignore the pointer. The nodes themselves stay selectable, draggable and editable.",
    "No hover reports, no tooltips, no clicks on a widget, no drag onto one, no wheel capture — so scrolling over a node zooms the graph instead of the thing on it. The nodes themselves stay live: they still select, drag, edit and open their menu. A 3D viewport that is asked whether the pointer is over it says no, so it stops re-rendering its scene. This applies in both How widgets go modes."
  );

  const linkBox = el("input", { type: "checkbox" });
  linkBox.checked = !!LOD.linkZoom;
  linkBox.addEventListener("change", () => {
    if (linkBox.checked) {
      const z = Math.max(Number(LOD.flatBelow) || 0, Number(LOD.inertBelow) || 0);
      lodSet({ linkZoom: true, flatBelow: z, inertBelow: z });
    } else {
      lodSet({ linkZoom: false });
    }
    lodUpdate();
  });
  settingRow(
    "Widget's threshold linked to the Nodes preview threshold",
    linkBox,
    "On by default. The higher of the two zooms wins, so a drag past either one still shows pictures.",
    "Past a percentage means zoomed out below it. While this is on, changing either dropdown sets both to the value you just picked, and turning it on takes the higher of the two. Off, each dropdown is its own. Either way a pictured node stays a picture while you drag it, in both How widgets go modes. Nodes stay selectable, draggable and editable. A link being dragged still draws live."
  );

  const viewFoveaSel = el("select", { class: "ants-select" });
  for (const [id, text] of [
    ["off", "off"],
    ["on", "on"],
  ]) {
    const opt = el("option", { text });
    opt.value = id;
    viewFoveaSel.appendChild(opt);
  }
  viewFoveaSel.value = LOD.fovea ? "on" : "off";
  viewFoveaSel.addEventListener("change", () => {
    lodSet({ fovea: viewFoveaSel.value === "on" });
    lodUpdate();
  });
  settingRow(
    "Off-screen nodes",
    viewFoveaSel,
    "Off-screen nodes get the same boxed, inert treatment at every zoom, past the margin on the next row.",
    "Going away is a class on something nobody is looking at. Coming back re-runs layout for that widget, which is why only a few come back per drawn frame. Anything actually on screen comes back at once, so a visible widget is never blank."
  );

  const viewMarginSel = el("select", { class: "ants-select" });
  for (const m of VIEW_FOVEA_MARGINS) {
    const opt = el("option", { text: m === 0.5 ? "margin: ½ screen" : `margin: ${m === 0.25 ? "¼" : m} screen${m > 1 ? "s" : ""}` });
    opt.value = String(m);
    viewMarginSel.appendChild(opt);
  }
  viewMarginSel.value = String(LOD.foveaMargin);
  viewMarginSel.addEventListener("change", () => {
    lodSet({ foveaMargin: Number(viewMarginSel.value) || 0 });
    lodUpdate();
  });
  settingRow(
    "Off-screen margin",
    viewMarginSel,
    "How far outside the visible area a node has to be before its widgets are taken away. Half a screen by default.",
    "Smaller margins box more, which is less work and more boxes. Larger margins are gentler on the eye and box less."
  );

  const viewRestoreSel = el("select", { class: "ants-select" });
  for (const r of VIEW_FOVEA_RESTORES) {
    const opt = el("option", { text: r === 0 ? "come back: all at once" : `come back: ${r} per frame` });
    opt.value = String(r);
    viewRestoreSel.appendChild(opt);
  }
  viewRestoreSel.value = String(LOD.foveaRestore);
  viewRestoreSel.addEventListener("change", () => {
    lodSet({ foveaRestore: Number(viewRestoreSel.value) || 0 });
    lodUpdate();
  });
  settingRow(
    "Come back",
    viewRestoreSel,
    "How many off-screen nodes may be handed back per drawn frame. Whatever is on screen comes back immediately.",
    "Coming back is the expensive direction, so it is rationed. The slower it is, the more of the graph stays boxed while you pan. Nothing you can see is left blank."
  );

  const viewScaleSel = el("select", { class: "ants-select" });
  for (const d of VIEW_DISPLAY_SCALES) {
    const opt = el("option", { text: d === 0 ? "display scale: auto" : `display scale: ${Math.round(d * 100)}%` });
    opt.value = String(d);
    viewScaleSel.appendChild(opt);
  }
  viewScaleSel.value = String(LOD.displayScale);
  viewScaleSel.addEventListener("change", () => {
    lodSet({ displayScale: Number(viewScaleSel.value) || 0 });
    lodUpdate();
  });
  settingRow(
    "Display scale",
    viewScaleSel,
    "Windows display scaling, often 200% on a 4K screen. Auto reads it once at start and re-checks it. Pin it if the status line disagrees.",
    "The device-pixel ratio of the canvas. Display scaling makes the canvas backing store larger than the element it is drawn in, and anything that does not account for it is out by that factor."
  );

  const viewDomSel = el("select", { class: "ants-select" });
  for (const m of VIEW_FOCUS_DOM) {
    const opt = el("option", { text: m === "hide" ? "widgets: hidden outright" : "widgets: inert only" });
    opt.value = m;
    viewDomSel.appendChild(opt);
  }
  viewDomSel.value = LOD.focusDom;
  viewDomSel.addEventListener("change", () => {
    lodSet({ focusDom: viewDomSel.value });
    lodUpdate();
  });
  settingRow(
    "How widgets go",
    viewDomSel,
    "Hidden outright cannot be clicked or hovered, whatever its own CSS says. Inert only takes pointer events away and leaves the widget on screen.",
    "Hidden is the stronger of the two. Inert is gentler to look at, and enough for a page whose CSS cooperates."
  );

  const lodOffBtn = el("button", { class: "ants-btn", text: "Back to full drawing" });
  lodOffBtn.addEventListener("click", () => {
    lodSet({
      flatBelow: 0,
      boxDetail: "plain",
      snapshots: false,
      idleCapMs: 0,
      thumbZoom: 0,
      detailZoom: 0,
      linkStyle: "spline",
      inertBelow: 0,
      fovea: false,
    });
    lodFlatSel.value = "0";
    lodStandSel.value = "plain";
    lodLinkSel.value = "spline";
    lodDetailSel.value = "0";
    lodIdleSel.value = "0";
    viewInertSel.value = "0";
    viewFoveaSel.value = "off";
    lodUpdate();
  });
  settingRow(
    "Way back",
    lodOffBtn,
    "Turns the drawing changes off and lets ComfyUI paint the canvas. The disk cache is left as you set it.",
    "Flattening, the stand-in, link thinning, link shape and viewport focus go back to a full draw. Pictures already on disk stay until a node changes, a node is deleted, or the weekly sweep removes a file older than a week."
  );

  function lodUpdate() {
    // The display-scale check is refreshed here as well as on the sweep: it is a
    // readout, and a readout derived from the viewport should be derived from the
    // viewport as it is when it is read. It is two reads of the canvas's own box,
    // on the panel's refresh, not on the canvas's.
    try {
      viewDisplayProbe(app.canvas, false);
    } catch (e) {
      /* the readout falls back to whatever the last probe found */
    }
    const syncSel = (sel, value) => {
      if (!sel) return;
      const next = String(value);
      if (sel.value === next) return;
      try {
        if (typeof document !== "undefined" && document.activeElement === sel) return;
      } catch (e) {
        /* a document with no active element just gets the value */
      }
      sel.value = next;
    };
    syncSel(lodFlatSel, LOD.flatBelow);
    syncSel(lodStandSel, LOD.snapOn ? "picture" : LOD.boxDetail);
    syncSel(snapRatioSel, LOD.snapRatio);
    syncSel(snapMbSel, LOD.snapMb);
    syncSel(diskSel, LOD.diskOn ? "on" : "off");
    syncSel(lodIdleSel, LOD.idleCapMs);
    syncSel(lodLinkSel, LOD.linkStyle);
    syncSel(lodDetailSel, LOD.detailZoom);
    syncSel(viewInertSel, LOD.inertBelow);
    syncSel(viewFoveaSel, LOD.fovea ? "on" : "off");
    syncSel(viewMarginSel, LOD.foveaMargin);
    syncSel(viewRestoreSel, LOD.foveaRestore);
    syncSel(viewScaleSel, LOD.displayScale);
    syncSel(viewDomSel, LOD.focusDom);
    if (linkBox) linkBox.checked = !!LOD.linkZoom;
    const fm = frameMetrics();
    const bits = [];
    const vis = lodVisibility(app.canvas);
    if (vis && vis.total) {
      bits.push(
        `nodes ${vis.total} · on screen ${vis.visible} (${fmtPct(vis.share)}) at zoom ${vis.scale.toFixed(2)} · ` +
          `~${vis.meanPx.toFixed(0)}px wide each (estimate)`
      );
      if (vis.share >= 0.9 && vis.zoomedOut) {
        // Culling has nothing to remove, so a periodic scan that walks every
        // node is pure cost. Name it, with its numbers, instead of leaving the
        // user to match a function name against a stall table.
        const spiky = govSpikySources(120, 3);
        const named = spiky
          .slice(0, 2)
          .map((r) => `\u201c${r.name}\u201d (worst ${fmtMs(r.worst, 0)} ms, ${fmtRate(r.runsPerSec)}/s)`);
        bits.push(
          "the whole graph is on screen, so culling cannot save anything here — the only levers left are cheaper drawing per " +
            "node (below) and fewer redraws (the cap)" +
            (named.length
              ? ` · but ${spiky.length === 1 ? "a periodic source is" : `${spiky.length} periodic sources are`} still walking the whole ` +
                `graph: ${named.join(", ")} \u2014 a scan like that has nothing to find while everything is visible, so capping it in the ` +
                `Governor tab (or switching it off in the pack that owns it) removes it from the frame budget entirely`
              : "")
        );
      }
      if (lodVueNodesMode()) {
        // Which renderer this is decides what most of the drawing settings can
        // do, so it belongs at the top of the readout rather than in a tooltip.
        // The stand-in setting is not idle here: it is the blanking pathway, and
        // the readout has to say so in the same breath as the renderer.
        bits.push(
          "renderer: nodes are DOM elements (Nodes 2.0 / Vue nodes mode) — the canvas draws links, groups and the grid only, so there is no node chrome " +
            "for it to draw cheaper" +
            (LOD.flatBelow > 0 && LOD.snapOn
              ? `. The stand-in setting acts here by blanking: below ${Math.round(LOD.flatBelow * 100)}% zoom each node's own element stops painting ` +
                `(one attribute on it, ${LOD.vueFlat ? LOD.vueFlat.size : 0} marked right now — that many nodes have stopped painting, ` +
                `"visibility" on their contents so the engine skips them and their own box still hit-testable. An attribute, because the frontend rewrites that element's ` +
                `class and style whenever it re-renders the node and anything kept there is silently thrown away) and the canvas paints that node's box in the ` +
                `same place, with the same detail ladder as the canvas renderer — and the measured cost is stated, not a hoped-for saving ` +
                `spends its frame. ` +
                (lodSnapBitmaps() && LOD.snaps && LOD.snaps.size
                  ? `Pictures are made here too (${LOD.snaps.size} held): the tool draws the box and the node's own content into the capture surface, so the ` +
                    `capture resolution, the mip chain and the disk cache all apply. The content is what could be read out of the node's own DOM — the text the ` +
                    `frontend renders (${LOD.vueTextNow} lines on the last frame), the images and canvases it renders, and the widgets that carry an element; a ` +
                    `pack's widget that is none of those is left blank in the picture and counted` +
                    (LOD.vueScaleFrom === "canvas"
                      ? `. The DOM zoom could not be measured on this page (no transform pane and no readable node element), so it is being taken from the ` +
                        `canvas scale — if the boxes look wrong, that is why`
                      : "")
                  : `Pictures, the capture resolution and the disk cache work here too — the tool draws the box and the node's own content into the capture ` +
                    `surface, since no browser API photographs the element itself; switch the stand-ins on to make them`)
              : "")
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
      // The flat state is one decision per frame, so this is exact: either the
      // zoom is below the setting and every node is a rectangle, or nothing is.
      if (LOD.flatBelow > 0) {
        const pct = (z) => `${(z * 100).toFixed(z < 0.1 ? 1 : 0)}%`;
        if (lodVueNodesMode()) {
          // The same setting, the other pathway: there is no canvas node to
          // replace and no bitmap to take, so what a stand-in means here is an
          // element that stops painting and a box the canvas draws in its place.
          bits2.push(
            !LOD.snapOn
              ? `zoom ${pct(LOD.zoom)} is below your ${pct(LOD.flatBelow)} setting, but the stand-in setting itself is off: the ${LOD.plan.total} ` +
                `node(s) here are DOM elements, so nothing is marked and no box is painted`
              : `zoom ${pct(LOD.zoom)} is below your ${pct(LOD.flatBelow)} setting: ${LOD.vueBoxes} box(es) painted and ` +
                `${LOD.vueFlat ? LOD.vueFlat.size : 0} node element(s) marked — the browser skips the paint of those subtrees ` +
                `(visibility, so their boxes, their text metrics and every observer still answer) and the canvas draws their boxes. ` +
                (LOD.snapOn
                  ? `Each box carries what the node is showing, and so does the picture the idle lane draws of it: the node's own text (its title, ` +
                    `labels and values, read from the DOM and re-painted at the position the browser laid them out in), the pictures and canvases it ` +
                    `renders itself (${LOD.vueMediaNow} of the ${LOD.vueContentNow} content item(s) on the last frame), and the widget elements the ` +
                    `frontend mounts — with a pack's own HTML left blank and counted. The node's *structure* goes in the same way: the element's own ` +
                    `box (the coloured surface), the header bar that carries the title, the body panel under it, the row of every widget the frontend ` +
                    `mounts there (its own box, border and radius) and the connection dot of every slot, each at the rect the browser gave it and in the ` +
                    `colours the browser computed for it (${LOD.vueChrome} structural box(es) and ${LOD.vueWidgetInk} widget row(s) drawn so far). What is not obtainable is a pixel *screenshot* (no browser API draws a DOM element into a canvas; the ` +
                    `canvas renderer's capture works only because LiteGraph itself draws the node), so the picture is *drawn* into the same capture ` +
                    `surface: the ratio ladder, the mips, the RAM budget and the ` +
                    `thumbnails folder all apply to it` +
                    (lodSnapBitmaps() || !LOD.snaps || !LOD.snaps.size
                      ? ""
                      : `. Pictures are being made here: ${LOD.snaps.size} held, ${LOD.snapCaptured} captured so far`) +
                    `. While a node is a stand-in the browser is told to skip its DOM's paint (visibility, not opacity: an opacity-0 subtree is ` +
                    `still painted) — ${LOD.vueFlat ? LOD.vueFlat.size : 0} subtree(s) right now — and a node is photographed only after it has stood ` +
                    `still (${LOD_SNAP_SETTLE_MS}ms, re-opened by every change it reports, ${LOD.vueSettleHeld} capture slice(s) waited so far). This ` +
                    `pathway's cost to the page so far: ${LOD.vueDomWrites} DOM write(s) (a mark is written once, never re-written) and ` +
                    `${LOD.vueLayoutReads} layout read(s) — both stop moving in the steady state` +
                    (lodVueWatchOn()
                      ? `, because the page reports its own changes (${LOD.vueStale} drop(s) of a stale measurement so far) instead of being asked on a timer`
                      : ` — this page has no change observers, so the tool asks on a timer and rations how much it asks`)
                  : `The stand-in setting is off: these are your chosen box detail, with no content drawn into them`) +
                `. Link ink, the idle redraw cap and the governor are unaffected`
          );
        } else if (lodFlatOn()) {
          bits2.push(
            `zoom ${pct(LOD.zoom)} is below your ${pct(LOD.flatBelow)} setting: ${LOD.plan.flat} of ${LOD.plan.total} node(s) painted as flat rectangles` +
              (LOD.plan.total > LOD.plan.flat
                ? ` (the other ${LOD.plan.total - LOD.plan.flat} are collapsed boxes or this tool's own node, which are never flattened)`
                : "") +
              (LOD.plan.medPx ? ` · the typical node is ≈${LOD.plan.medPx}px on screen here` : "")
          );
        } else {
          bits2.push(
            `zoom ${pct(LOD.zoom)} is above your ${pct(LOD.flatBelow)} setting: every node is drawn in full` +
              (LOD.plan.medPx ? ` (the typical node is ≈${LOD.plan.medPx}px on screen here)` : "")
          );
        }
        // What the boxes are made of: a stored picture of the node, or the fill.
        // Every number here is a count of something that happened, and the two
        // that could be mistaken for a claim (bytes, capture time) are measured.
        // Gated on the bitmap half: on a page that cannot hold a bitmap at all
        // there are no boxes and no pictures to report, and "0 of 0 remembered
        // nodes have a picture" would describe an engine that is deliberately
        // idle. Both renderers do make pictures, so this is about the page, not
        // about the pathway.
        if (lodSnapBitmaps()) {
          const pictured = lodSnapPictured();
          const parts = [
            `${pictured} of ${LOD.snaps ? LOD.snaps.size : 0} remembered node(s) have a picture`,
            `${LOD.snapDrawn} draw(s) served from stored bitmaps`,
            `${LOD.snapCaptured} captured (${fmtBytes(LOD.snapBytes)} of ${LOD.snapMb} MiB held)`,
            `${LOD.snapMisses} box(es) painted while a picture was missing`,
          ];
          if (LOD.snapQueue && LOD.snapQueue.size) parts.push(`${LOD.snapQueue.size} waiting for the idle lane`);
          if (LOD.snapMs > 0) parts.push(`${fmtMs(LOD.snapMs)} spent capturing so far`);
          if (LOD.snapPartial) {
            // A node's widgets live in DOM elements in both renderers (a prompt
            // textarea, an image preview, a 3D viewport). The picture now carries
            // what can honestly be drawn of them, so say what that was rather
            // than leaving the old "canvas part only" claim standing.
            parts.push(
              `${LOD.snapPartial} pictured node(s) have DOM widgets: ${LOD.snapDomInk} widget content(s) are drawn into those pictures ` +
                `(${LOD.snapDomText} of them text re-painted from the widget's value, not a screenshot of the browser's rendering)`
            );
            if (LOD.snapDomSkipped) {
              parts.push(
                `${LOD.snapDomSkipped} widget content(s) could not be drawn (a pack's own HTML, or an image that had not loaded when the picture was ` +
                  `taken) — those stay blank in the picture and the DOM still covers them while the node is live`
              );
            }
          }
          if (LOD.snapFit) {
            parts.push(
              `${LOD.snapFit} picture(s) are coarser than your ratio so they would fit the ${LOD_SNAP_MAX_DIM}px cap: a tall node is fitted, not skipped`
            );
          }
          if (LOD.snapCoarse) {
            parts.push(`${LOD.snapCoarse} picture(s) are coarser than your ratio because the budget was full — coarser, not nothing`);
          }
          if (LOD.snapSlow) parts.push(`${LOD.snapSlow} node(s) stay live: their own capture was slower than ${LOD_SNAP_SLOW_MS}ms`);
          if (LOD.snapLarge) parts.push(`${LOD.snapLarge} node(s) stay boxes: too big for a ${LOD_SNAP_MAX_DIM}px capture at any ratio`);
          if (LOD.snapBlank) {
            parts.push(
              `${LOD.snapBlank} node(s) stay boxes: they draw nothing into a canvas at all (their whole visual is DOM), so a picture would erase them`
            );
          }
          if (LOD.snapChurn) parts.push(`${LOD.snapChurn} node(s) stay boxes: their drawing changed before every picture could be drawn`);
          if (LOD.snapKept) parts.push(`${LOD.snapKept} kept live on purpose (this tool's own node, or a type on your list)`);
          if (LOD.snapInvalid) parts.push(`${LOD.snapInvalid} dropped after their node changed`);
          if (LOD.snapEvicted) parts.push(`${LOD.snapEvicted} released by the budget`);
          if (LOD.snapFull) {
            parts.push(
              `${LOD.snapFull} capture(s) refused: the budget is full of bitmaps that are being looked at, and not even a ` +
                `1x copy fits — releasing one of those is what flicker looks like, so the lane stops instead (raise the budget, ` +
                `or capture at 1x, or at the smaller step you picked)`
            );
          }
          if (LOD.snapFlagHeld) {
            parts.push(`${LOD.snapFlagHeld} box(es) drawn while the canvas's shadow setting disagreed with the capture (reuse paused, pictures kept)`);
          }
          if (LOD.snapFlips > 0) {
            parts.push(
              `${LOD.snapFlips} switch(es) between picture and box so far — a high number here is visible flicker, and the reasons above say what ` +
                `is causing it`
            );
          }
          if (LOD.snapPruned) parts.push(`${LOD.snapPruned} pruned (node left the graph)`);
          if (LOD.diskLoaded) parts.push(`${LOD.diskLoaded} loaded from disk`);
          if (LOD.diskSaved) parts.push(`${LOD.diskSaved} written to disk`);
          if (LOD.diskDir) parts.push(`folder ${LOD.diskDir}`);
          if (LOD.ramPurged) parts.push(`${LOD.ramPurged} released for system RAM (${LOD.ramLast || "run"}); disk files kept`);
          if (LOD.ramNote) parts.push(LOD.ramNote);
          if (LOD.snapQueue && LOD.snapQueue.size) {
            parts.push(
              `${LOD.snapQueue.size} still to photograph on the idle lane. The node's own draw cannot move to a worker; the lane yields between slices so a drag is not blocked`
            );
          }
          if (LOD.snapMipDrawn) parts.push(`${LOD.snapMipDrawn} draw(s) used a half or quarter copy`);
          if (LOD.snapFailed) parts.push(`${LOD.snapFailed} capture(s) failed`);
          bits2.push(`snapshots: ${parts.join(", ")}`);
          const named = lodSnapWhyText();
          if (named) bits2.push(named);
          if (LOD.snapMs > 0 && since && since.n > 0) {
            bits2.push(
              `and the captures were run on the idle lane, not in a frame: their ${fmtMs(LOD.snapMs)} is this tool's own cost, ` +
                `counted apart from the packs whose draw hooks they ran`
            );
          }
        } else if (LOD.snapOn) {
          bits2.push(
            lodVueNodesMode()
              ? "stand-ins are on, but the flatten-below threshold above is off: nothing is below it, so no node is drawn as a stand-in here. " +
                "The capture half is not idle in this renderer — a stand-in is drawn from the node's own DOM (its text, its media, its widgets and " +
                "its frame, header and body panel) and stored in RAM and on disk like any other picture; the boxes and their pictures need that " +
                "threshold switched on, and a zoom below it"
              : "snapshots are on but not painting anything: they replace flat boxes, so they need the flatten setting above switched on " +
                "(and a zoom below it)"
          );
        }
        // What the boxes said, and what saying it cost: the counters are per
        // paint, so "1,027 boxes × 2 marks" is the honest price of the ladder.
        // The box-detail paragraph describes the canvas renderer's ladder. In the
        // Vue-nodes renderer the picture level replaces the box entirely (the box
        // carries the node's content), and the paragraph above has already said
        // what those boxes are made of.
        if (lodFlatOn() && !(lodVueNodesMode() && LOD.snapOn)) {
          if (LOD.boxDetail === "plain") {
            bits2.push(
              `the boxes are plain — the box-detail setting next to this one can put each node's own title colour, error ring, ` +
                `progress bar and muted dimming on them (it never changes which nodes are boxes)`
            );
          } else {
            const marks = [
              LOD.boxTitles ? `${LOD.boxTitles} title bar(s)` : "",
              LOD.boxErrors ? `${LOD.boxErrors} error ring(s)` : "",
              LOD.boxBars ? `${LOD.boxBars} progress bar(s)` : "",
              LOD.boxMuted ? `${LOD.boxMuted} dimmed` : "",
            ].filter(Boolean);
            bits2.push(
              `box detail "${LOD.boxDetail}": drawn so far ${marks.length ? marks.join(", ") : "nothing"}` +
                (marks.length ? ` — each mark is one more rectangle per node per frame` : "")
            );
          }
        }
        if (since && LOD.plan.flat > 0 && Number.isFinite(b.nodeMsPerFrame) && b.nodeMsPerFrame > 0 && since.nodeMsPerFrame > b.nodeMsPerFrame * 0.9) {
          bits2.push(
            `and node drawing has not moved (${fmtMs(b.nodeMsPerFrame)} → ${fmtMs(since.nodeMsPerFrame)} ms/frame): the flat rectangles ` +
              `are already the cheap part, so what is left is outside drawNode — the Connections and Other figures above say where`
          );
        }
      }
      // Where the connections stage actually goes. The ink is what a link
      // setting can change; the rest of the stage is the frontend walking every
      // input slot of every node in the graph, which no setting here can shrink.
      if (since && since.n >= 3 && since.linkMsPerFrame > 0) {
        const connPer = since.connMsPerFrame;
        const ink = Math.min(connPer, since.linkMsPerFrame);
        if (connPer > 0.5) {
          const drawn = LOD.linkCalls / since.n;
          const perLink = drawn > 0 ? since.linkMsPerFrame / drawn : 0;
          bits2.push(
            `connections ${fmtMs(connPer, 1)} ms/frame: the strokes themselves are ${fmtMs(ink, 1)} ms ` +
              `(${drawn.toFixed(1)} link draw(s)/frame at ${fmtMs(perLink, 3)} ms each), and the other ` +
              `${fmtMs(Math.max(0, connPer - ink), 1)} ms is the frontend walking every input slot of every node before it decides which links ` +
              `are on screen \u2014 a link ink setting can only reach the first part`
          );
        }
      }
      if (LOD.ab) {
        bits2.push(LOD.ab.text);
      }
      if (LOD.inertBelow > 0 || LOD.fovea) {
        const bits3 = [];
        if (LOD.inertBelow > 0) {
          const pct = Math.round(LOD.inertBelow * 100);
          if (viewInertOn()) {
            const hid = LOD.focusDom === "hide";
            bits3.push(
              `node widgets switched off below ${pct}% zoom, by four mechanisms that do not depend on each other: ` +
                `${LOD.domHidden} element(s) ${hid ? "hidden outright and inert" : "made inert"} (${LOD.domVerified} of the sampled ones confirmed by the ` +
                `page's own computed style${LOD.domBroken ? `, ${LOD.domBroken} still reachable` : ""}), ${LOD.canvasWidgetsBlocked} of ` +
                `${LOD.canvasWidgetHits} widget hit-test(s) on the canvas answered with "no widget" (so a slider cannot be grabbed or hovered and the ` +
                `node still selects and drags), ${LOD.hoverBlocked} node hover callback(s) held back \u2014 which is the flag a 3D viewport's render loop ` +
                `asks about \u2014 and ${LOD.eventsBlocked} pointer event(s) swallowed at the document before they could reach a switched-off widget`
            );
          } else {
            bits3.push(`nodes stay live at this zoom (widgets are switched off below ${pct}%)`);
          }
        }
        if (LOD.fovea) {
          bits3.push(
            `foveated: ${LOD.foveaEls} element(s) of nodes further than ${LOD.foveaMargin} screen(s) from the viewport hidden and inert ` +
              `(${LOD.foveaQueue} waiting to come back${LOD.foveaRestore === 0 ? ", handing back all at once" : `, ${LOD.foveaRestore} per frame`})` +
              (LOD.foveaEls === 0 && LOD.plan.total > 0
                ? " \u2014 right now every node is inside that margin, which is why the count is zero"
                : "")
          );
        }
        const disp = LOD.display;
        if (disp) {
          const verdict = disp.agree
            ? "the viewport maths agree (1.00\u00d7), so no display-scale correction is needed"
            : disp.unit === "device-pixel"
              ? `they differ by exactly the display scale (${disp.factor}\u00d7): the frontend's rectangle is in device pixels while every position this ` +
                `tool works in is in CSS pixels, so this tool does its own maths from the canvas box`
              : `they differ by ${disp.factor}\u00d7, which is not the display scale \u2014 so that rectangle is not describing this viewport (a frame the ` +
                `canvas has not drawn since, or a viewport that is not the whole element). This tool does its own maths from the canvas box either way`;
          bits3.push(
            `display scale: browser ${disp.win}\u00d7${disp.manual ? ` (pinned to ${disp.manual}\u00d7 by hand)` : ""}, canvas backing store ` +
              `${disp.backing || "?"}\u00d7 its ${disp.css || "?"}px CSS box, frontend visible area ${disp.reported || "?"} vs our own ` +
              `${disp.ours || "?"} graph units \u2014 ${verdict}`
          );
        }
        if (bits3.length) bits2.push(bits3.join(" \u00b7 "));
      }
      if (LOD.detailZoom > 0) {
        const frames = Math.max(1, since ? since.n : 1);
        if (lodLinksStraight()) {
          bits2.push(
            `${LOD.links} link draw(s) on the straight-line path (${(LOD.links / frames).toFixed(1)}/frame) \u2014 the link setting is ` +
              `"always straight lines", so the thinning setting has nothing to thin. Nodes are not affected either way.`
          );
        } else if (lodDetailOn()) {
          bits2.push(
            `below ${Math.round(LOD.detailZoom * 100)}% zoom: ${LOD.thinLinks} link segment(s) stroked ${LOD_LINK_WIDTH}px instead of ` +
              `${LOD_FULL_LINK_WIDTH}px and without their outline (${(LOD.thinLinks / frames).toFixed(1)}/frame, curves kept). This changes ` +
              `link ink and nothing else: nodes, their widgets and the frame's own quality flag are exactly as ComfyUI left them.`
          );
        } else {
          bits2.push(`links drawn with full ink above ${Math.round(LOD.detailZoom * 100)}% zoom (${LOD.thinLinks} thinned so far)`);
        }
      }
      if (LOD.flatBelow > 0) {
        if (LOD.domHidden) {
          bits2.push(
            `${LOD.domHidden} DOM element(s) of ${LOD.domNodes} boxed node(s) hidden ` +
              `(image and video previews, curve editors, 3D viewports, custom node UIs)` +
              (LOD.domLayer ? `, ${LOD.domLayer} of them through the frontend's DOM widget layer` : "") +
              ` \u2014 they come back the moment the node does` +
              (LOD.domStilled
                ? ` \u00b7 ${LOD.domStilled} widget(s) also carrying a hide-on-zoom flag the frontend is honouring right now`
                : LOD.domMarkedWidgets
                  ? ` \u00b7 ${LOD.domMarkedWidgets} widget(s) carry a hide-on-zoom flag as well, which the frontend only consults in its own ` +
                    `low-quality mode (off at this setting) \u2014 the class above is what is doing the hiding`
                  : "")
          );
        } else if (lodFlatOn() && LOD.plan.flat > 0) {
          bits2.push("the nodes painted flat at this zoom have no DOM content to hide (their visuals are canvas-drawn)");
        }
      }
      bits.push(bits2.join(" · "));
    } else {
      bits.push("off — the canvas is drawn exactly as ComfyUI draws it");
    }
    if (LOD.legacyPx) {
      bits.push(
        `carried over from v2.1.8: your setting was "nodes under ${LOD.legacyPx}px". The rule is a zoom now, so it is "flat nodes below ` +
          `${Math.round(LOD.flatBelow * 100)}% zoom" — every node below it is a rectangle, whatever size that node is. That is the fix for the ` +
          `nodes with JS or dynamic UIs: a node that hides or greys a widget changes its own size, and a per-node pixel rule then flips it in and ` +
          `out of the flat state while its neighbours stay detailed. Pick any value above to dismiss this note.`
      );
    }
    if (LOD.autoLinkCarried) {
      bits.push(
        `waiting to be picked: your link setting was "straight while the graph is rectangles", which let the *node* setting decide a ` +
          `link's shape. That answer is gone \u2014 links are "keep every curve" unless you ask for straight lines \u2014 so no setting here ` +
          `changes anything but its own subject. Choose a link value to dismiss this note.`
      );
    }
    if (LOD.error) bits.push(`turned itself off after an error: ${LOD.error}`);
    if (LOD.linkZoom) {
      bits.push(
        `widget threshold linked to the preview threshold: pictures follow the higher of the two (${Math.round(lodPictureBelow() * 100)}%)`
      );
    }
    if (ui.lodLine) ui.lodLine.textContent = bits.join("\n");
  }

  ui.lodUpdate = lodUpdate;
  ui.state.tweaks = {
    update: () => {
      if (lodAbBtn) lodAbBtn.textContent = LOD.ab && !LOD.ab.done ? "Measuring\u2026" : "Measure link thinning";
      lodUpdate();
    },
  };
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
  let extra = "";
  if (Number.isFinite(r.screens)) extra += ` · swept ${r.screens.toFixed(1)} screen(s)`;
  if (r.foveaOn === true) extra += ` · fovea peak ${r.foveaPeak || 0} hidden`;
  else if (r.foveaOn === false) extra += " · fovea off";
  return (
    `${r.frames} frames over ${(r.spanMs / 1000).toFixed(1)}s · mean ${fmtMs(r.meanFrameMs)} ms/frame · p95 ${fmtMs(r.p95)} ms · ` +
    `${fmtMs(r.fps, 1)} fps · hooks ${fmtPct(r.attrShare)}${extra}`
  );
}

// How far the scripted pan travels, in graph units. The old figure was ±40 by
// ±15: at zoom 0.10 that is about 4 by 1.5 CSS pixels, and a node never leaves
// the viewport, so foveation — which boxes a node only once it is more than
// `foveaMargin` screens past the edge — cannot engage and cannot be measured.
// Ten times that fidget is still inside the margin (about 40 CSS pixels against
// a half-screen of roughly 960). A node that starts in the middle of the view
// has to cross half a screen to the edge and then the margin before it counts
// as far, so the sweep is one screen plus the margin, and the view is put back.
function benchSpan(canvas) {
  const vp = viewViewport(canvas);
  const margin = Number(LOD.foveaMargin);
  const screens = 1 + (Number.isFinite(margin) && margin > 0 ? margin : 0.5);
  if (!vp || !(vp.w > 0) || !(vp.h > 0)) return { x: 400, y: 150, screens: NaN };
  return { x: vp.w * screens, y: vp.h * screens, screens };
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
    "viewport (no graph mutation) and puts it back where it started. The sweep is one screen plus your off-screen margin — a few " +
    "dozen graph units never leaves the viewport, so it cannot show what foveation costs or saves. Change only that setting between A and B.";
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
  const span = benchSpan(canvas);
  let foveaPeak = 0;
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
      screens: span.screens,
      travelX: span.x,
      travelY: span.y,
      foveaOn: !!LOD.fovea,
      foveaPeak,
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
      ds.offset[0] = x0 + Math.sin(phase) * span.x;
      ds.offset[1] = y0 + Math.sin(phase * 2) * span.y;
    }
    if (LOD.foveaEls > foveaPeak) foveaPeak = LOD.foveaEls;
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
  buildStatusTab(ui.tabs.status);
  buildTimingTab(ui.tabs.timing);
  buildNodesTab(ui.tabs.nodes);
  buildStallsTab(ui.tabs.stalls);
  buildGovernorTab(ui.tabs.governor);
  buildLoadTab(ui.tabs.load);
  buildMemoryTab(ui.tabs.memory);
  buildGpuTab(ui.tabs.gpu);
  buildTestingTab(ui.tabs.testing);
  ui.tabs.tweaks.classList.add("active");
  ui.tabBtns.tweaks.classList.add("active");
  ui.active = "tweaks";
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
    // Opening the panel, from the node or the floating gear, lands on the
    // rendering settings. A tab picked while it is open stays until it closes.
    ui.active = "";
    setTab("tweaks");
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
  if (!antsUiSilent) antsUiPublishSettings();
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
      // ...and must not flip the switch either, if the drag started on the tick.
      node._antsSuppressClick = true;
      const rect = node.getBoundingClientRect();
      saveCornerPos(rect.top, rect.left);
    }
  });

  node.addEventListener("click", () => {
    if (suppressClick) {
      suppressClick = false;
      return;
    }
    antsOpenFromGear();
  });
}

// The floating control: the switch and the button that opens the panel, in one
// frame, pinned to the screen. This is the pair that has to survive everything —
// so it is marked `.ants-own` (no sweep, gate or hover rule of this tool can
// touch it) and it is *not* hidden when the tool is switched off, because it is
// where the switch that turns it back on lives.
function buildCornerPill() {
  if (cornerBtnEl) return cornerBtnEl;
  injectStyle();
  const pill = el("div", { id: "ants-corner-pill", class: `ants-node-pill ${ANTS_OWN_CLASS}` });
  pill.title = "ANTs Frontend Optimizer — the switch turns the hooks and the optimisations off, the gear opens the separate window";
  const tick = antsBuildTick(pill);
  const gear = el("button", {
    id: "ants-corner-btn",
    class: "ants-node-btn ants-node-btn-gear",
    type: "button",
    title: "ANTs Frontend Optimizer — click to open the separate window, press and hold to move this button. If the browser blocks the window, the panel on this page opens instead.",
  });
  const glyph = antsGearSvg();
  if (glyph) gear.appendChild(glyph);
  gear.addEventListener("click", (ev) => {
    try {
      ev.stopPropagation();
    } catch (e) {
      /* the click still counts */
    }
    if (antsClickSuppressed(gear)) return; // that press was a drag of the pill
    antsOpenFromGear();
  });
  // The switch first, the gear after — the order the frame draws them in.
  pill.appendChild(tick);
  pill.appendChild(gear);
  const saved = loadCornerPos();
  if (saved) {
    pill.style.top = `${saved.top}px`;
    pill.style.left = `${saved.left}px`;
    pill.style.bottom = "auto";
    pill.style.right = "auto";
  }
  wireCornerButton(pill);
  document.body.appendChild(pill);
  cornerBtnEl = pill;
  return pill;
}

function buildCornerButton() {
  return buildCornerPill();
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
    enabled: antsEnabled(),
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

  lines.push(`ANTs Frontend Optimizer v${s.version} snapshot — ${s.generatedAt}`);
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
          ? `on (${
              lodVueNodesMode()
                ? (LOD.snapOn
                    ? `node stand-ins are pictures: below ${Math.round(LOD.flatBelow * 100)}% zoom each node's own element stops painting and the canvas blits the picture taken of it ` +
                      `(the bitmap half of the engine is active — a picture of the node's box, its text and its widgets, remade when the node changes; the frontend itself has no level of detail — a zoom is one compositor transform, so every read is at full detail, and node LOD here is ${(() => { const p = lodVueLodProbe(); return p.ok ? "available to the page (content-visibility is honoured) but unused by the frontend" : `unavailable (content-visibility: ${p.why})`; })()})`
                    : `node stand-ins are boxes: below ${Math.round(LOD.flatBelow * 100)}% zoom each node's own element stops painting and the canvas draws its box ` +
                      `(no picture is taken while the snapshots setting is off — the bitmap half of the engine is idle; the widget and focus settings below still act)`)
                : `every node a rectangle below ${Math.round(LOD.flatBelow * 100)}% zoom${LOD.legacyPx ? `, carried over from "nodes under ${LOD.legacyPx}px"` : ""}`
            }, links ${lodLinksStraight() ? "straight (link setting)" : "as drawn"}, idle redraw cap ${LOD.idleCapMs ? LOD.idleCapMs + "ms" : "off"}, box detail ${LOD.boxDetail}, ` +
            `snapshots ${LOD.snapOn ? `on (${LOD.snapDrawn} served, ${LOD.snapCaptured} captured, ${fmtBytes(LOD.snapBytes)} of ${LOD.snapMb} MiB${LOD.snapStaleHeld ? `, ${LOD.snapStaleHeld} kept while a fresh one was made` : ""}${LOD.snapCooldown ? `, ${LOD.snapCooldown} slow-capture cooldown(s)` : ""}${LOD.vueSettleHeld ? `, ${LOD.vueSettleHeld} slice(s) held for the settle window` : ""})` : "off"}) ` +
            `— ${LOD.nodes} node draw(s) and ${LOD.links} link draw(s) simplified, ${LOD.capped} redraw(s) merged` +
            (LOD.linkCalls > 0 && LOD.linkMs > 0
              ? `, link strokes ${fmtMs((LOD.linkMs / Math.max(1, LOD.linkCalls)) * 1000, 0)}\u00b5s each over ${LOD.linkCalls} call(s) ` +
                `(the rest of the connections stage is the frontend's own per-slot walk)`
              : "") +
            (LOD.detailZoom > 0
              ? LOD.thinLinks > 0
                ? `, links ${LOD.thinLinks} segment(s) drawn 1px without outlines below ${Math.round(LOD.detailZoom * 100)}% zoom`
                : lodLinksStraight()
                  ? `, links drawn straight (${LOD.linkStyle === "straight" ? "link setting: always straight" : "link setting: straight while the graph is rectangles"})`
                  : ""
              : "") +
            (LOD.domHidden
              ? `, ${LOD.domHidden} DOM element(s) of ${LOD.domNodes} boxed node(s) hidden` +
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
      // What has been recorded so far, for a script or a test that wants to hold
      // the master switch to "nothing is measured while it is off".
      get totals() {
        let hookCalls = 0;
        try {
          for (const bucket of S.hooks.values()) hookCalls += bucket.calls || 0;
        } catch (e) {
          /* a bucket list that is mid-update is not worth a throw */
        }
        return {
          frames: S.counters.frames,
          framesTotal: S.counters.framesTotal,
          draws: S.counters.draws,
          hookCalls,
        };
      },
      open: () => antsOpenFromApi(),
      close: () => togglePanel(false),
      popout: () => antsPopout(),
      // The separate window's control link, so a test can apply a payload the
      // window would have posted without standing up the route.
      link: {
        settings: () => antsUiSettings(),
        limits: () => antsUiLimits(),
        apply: (body) => antsUiApplyRemote(body),
      },
      ramCheck: () => lodRamCheck(),
      runStart: () => lodRamRun(true),
      runFinish: () => lodRamFinish(),
      toggle: () => antsOpenFromGear(),
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
          return antsUiLimits();
        },
        get detail() {
          return {
            on: lodDetailOn(),
            linkMs: LOD.linkMs,
            linkCalls: LOD.linkCalls,
            ab: LOD.ab,
            belowZoom: LOD.detailZoom,
            thinLinks: LOD.thinLinks,
            linkWidth: LOD_LINK_WIDTH,
            // What the thinning setting may not touch, exposed so a test can
            // hold it to that.
            linkStyle: LOD.linkStyle,
            straight: lodLinksStraight(),
          };
        },
        get dom() {
          return {
            hidden: LOD.domHidden,
            nodes: LOD.domNodes,
            marked: LOD.domMarked ? LOD.domMarked.size : 0,
            stilled: LOD.domStilled,
            // Hidden through the frontend's DOM widget layer (component widgets
            // with no element of their own, like the core 3D viewports).
            layer: LOD.domLayer,
            // Widgets carrying our hideOnZoom flag. The frontend honours that
            // flag only in its own low-quality mode, which is what `stilled`
            // counts; this is the flag itself, so a panel can say which of the
            // two is doing the hiding.
            markedWidgets: LOD.domMarkedWidgets,
            frontendLowQuality: lodFrontendLowQuality(app.canvas),
            // The widgets themselves, for anyone who wants to see what was
            // touched rather than take the count on faith.
            widgets: LOD.domWidgets ? [...LOD.domWidgets.keys()] : [],
          };
        },
        // The image-preview thumbnail ladder was retired in v2.5.0 and its
        // implementation removed; this stays so a script gets an answer rather
        // than undefined, and the answer is the truth: it is not there.
        get previews() {
          return { on: false, retired: true, zoom: LOD.zoom };
        },
        get frontendLod() {
          return lodFrontendLod(app.canvas);
        },
        // Which renderer the page is using. `Comfy.VueNodes.Enabled` puts this on
        // LiteGraph (useVueFeatureFlags) and this tool reads the same flag, so a
        // script gets the same answer the drawing rules acted on rather than a
        // second guess at it.
        get vueNodes() {
          return lodVueNodesMode();
        },
        // The snapshot engine's own state: what it holds, what it did, and why it
        // stopped doing it. `records` is the size of the node map (a node with no
        // bitmap still gets a record: that is where "refused" and "blocked" live).
        get snapshots() {
          return {
            on: lodSnapOn(),
            // Which of the two pathways is standing in, and what it is doing.
            pathway: lodSnapPathway(),
            bitmaps: lodSnapBitmaps(),
            vueBlanked: LOD.vueFlat ? LOD.vueFlat.size : 0,
            // The node's own structure — frame, header, body panel, slot dots —
            // read out of the DOM and drawn into the boxes and the pictures. A
            // picture without it is the sketch a user described as "semi".
            vueChrome: LOD.vueChrome,
            vueChromeBoxes: LOD.vueChromeNow,
            // Colour strings the canvas could not be handed raw: how many, and the
            // first few - so a page whose theme uses a syntax this tool does not
            // read is *visible* in the readout instead of quietly painting another
            // element's colour.
            vueColorMiss: LOD.vueColorMiss || 0,
            vueColorSample: LOD.vueColorSample ? LOD.vueColorSample.slice() : [],
            staleHeld: LOD.snapStaleHeld,
            cooldown: LOD.snapCooldown,
            vueWidgetInk: LOD.vueWidgetInk,
            vueControlInk: LOD.vueControlInk,
            // What the stand-in does to the frontend's own painting: how many nodes
            // have their DOM subtree taken out of the paint phase while their
            // picture stands in (visibility, which the engine honours, rather than
            // opacity, which it does not), and the settle window a node has to be
            // quiet for before it is photographed.
            vuePaintSkipped: LOD.vueFlat ? LOD.vueFlat.size : 0,
            vueSettleMs: LOD_SNAP_SETTLE_MS,
            vueSettleArms: LOD.vueSettleArms,
            vueSettleHeld: LOD.vueSettleHeld,
            vueContent: LOD.vueContentNow,
            vueMedia: LOD.vueMediaNow,
            vueUnreached: LOD.vueUnreached,
            // What a Vue stand-in could actually read out of the node: the text
            // lines drawn on the last frame, the zoom the DOM measurement was taken
            // at and how it was taken (pane matrix, the element that carries the
            // node's declared width, the node's root, or — the weakest answer, used
            // only when nothing about the DOM could be read — the canvas scale).
            vueText: LOD.vueTextNow,
            // What this tool costs the page per frame, in DOM terms: mutations it
            // made (a mark is written once per transition, never re-written) and
            // layout reads (each one can force a style-and-layout pass). In the
            // steady state — stand-ins on, pictures held, nothing changing — both
            // stop moving, which is the promise the Nodes 2.0 pathway makes.
            vueDomWrites: LOD.vueDomWrites,
            vueLayoutReads: LOD.vueLayoutReads,
            vueProbes: LOD.vueProbes,
            // Whether the page reports its own changes to this tool (a browser with
            // ResizeObserver/MutationObserver) or whether the tool has to ask on a
            // timer, and how many measurements the page's reports have dropped. With
            // the observers, the timer is insurance and the steady state asks nothing.
            vueWatch: LOD.vueWatch,
            vueWatched: lodVueWatchOn(),
            vueStale: LOD.vueStale,
            vueScale: Math.round((Number(LOD.vueScaleNow) || 0) * 1000) / 1000,
            vueScaleFrom: LOD.vueScaleFrom || "",
            vueNoElement: LOD.vueNoElement,
            vueBoxes: LOD.vueBoxes,
            vueRestored: LOD.vueRestored,
            vueCleared: LOD.vueCleared,
            wanted: !!LOD.snapOn,
            ratio: LOD.snapRatio,
            budgetMb: LOD.snapMb,
            bytes: LOD.snapBytes,
            held: LOD.snaps ? LOD.snaps.size : 0,
            records: LOD.snaps ? LOD.snaps.size : 0,
            queue: LOD.snapQueue ? LOD.snapQueue.size : 0,
            drawn: LOD.snapDrawn,
            misses: LOD.snapMisses,
            captured: LOD.snapCaptured,
            captureMs: LOD.snapMs,
            slow: LOD.snapSlow,
            failed: LOD.snapFailed,
            large: LOD.snapLarge,
            evicted: LOD.snapEvicted,
            invalidated: LOD.snapInvalid,
            keptLive: LOD.snapKept,
            // The disk half, so a script (or a test) can hold the cache to what it
            // claims: one file per node, keyed by the ratio and theme inside it.
            diskOn: !!LOD.diskOn,
            diskLoaded: LOD.diskLoaded,
            diskSaved: LOD.diskSaved,
            diskFail: LOD.diskFail,
            diskDead: !!LOD.diskDead,
            domInk: LOD.snapDomInk,
            domText: LOD.snapDomText,
            domSkipped: LOD.snapDomSkipped,
            partial: LOD.snapPartial,
            fit: LOD.snapFit,
            coarse: LOD.snapCoarse,
            churn: LOD.snapChurn,
            blank: LOD.snapBlank,
            pictured: lodSnapPictured(),
            why: (LOD.snapWhy || []).map((e) => ({ type: e.type, title: e.title, why: e.why })),
            pruned: LOD.snapPruned,
            clears: LOD.snapClears,
            full: LOD.snapFull,
            flagHeld: LOD.snapFlagHeld,
            flips: LOD.snapFlips,
            guardFrames: LOD_SNAP_GUARD_FRAMES,
            frame: LOD.snapFrame,
            exclude: LOD.snapExclude.slice(),
            installed: lodSnapInstalled,
            ramUsed: LOD.ramUsed,
            ramPurged: LOD.ramPurged || 0,
            ramNote: LOD.ramNote || "",
            ramLast: LOD.ramLast || "",
          };
        },
        get flat() {
          return {
            on: lodFlatOn(),
            belowZoom: LOD.flatBelow,
            pictureBelow: lodPictureBelow(),
            linkZoom: !!LOD.linkZoom,
            zoom: lodZoomOf(),
            // What the setting would have been under the old per-node pixel
            // rule, for anyone comparing a v2.1.8 snapshot with a new one.
            flatNodes: LOD.plan.flat,
            graphNodes: LOD.plan.total,
            typicalNodePx: LOD.plan.medPx,
            carriedOverFromPx: LOD.legacyPx,
            autoLinkCarried: LOD.autoLinkCarried,
            // What the boxes were allowed to say, and what they actually drew:
            // per-paint counters, like LOD.nodes, so the price of a mark is
            // visible rather than assumed.
            boxDetail: LOD.boxDetail,
            boxTitles: LOD.boxTitles,
            boxErrors: LOD.boxErrors,
            boxBars: LOD.boxBars,
            boxMuted: LOD.boxMuted,
          };
        },
        set: (opts) => lodSet(opts),
        ramCheck: () => lodRamCheck(),
        runStart: () => lodRamRun(true),
        runFinish: () => lodRamFinish(),
        // Starts the on/off measurement of the link setting and returns its
        // state; the verdict lands in `state.ab.text` when it finishes.
        measureLinks: () => lodAbStart(),
        // Is any of the drawing settings doing anything *right now*? (They can all
        // be set and still be out of force, either because the zoom is above every
        // threshold or because the master switch is off.)
        get on() {
          return lodOn();
        },
        get focus() {
          return {
            // Whether the whole tool is switched on at all (the floating switch,
            // and the one on the tracker's own node).
            enabled: antsEnabled(),
            // The node-zoom half: widget UI switched off below this zoom. The
            // nodes themselves keep selecting, dragging and opening — only the
            // DOM content on them stops answering the pointer.
            inertOn: viewInertOn(app.canvas),
            inertBelow: LOD.inertBelow,
            inertElements: LOD.inertEls,
            // What "switched off" means for the DOM: hidden outright, or inert.
            dom: LOD.focusDom,
            // The canvas half: widget hit-tests answered with "no widget", and
            // the hover callbacks on nodes that were held back.
            canvasWidgetsSeen: LOD.canvasWidgetHits,
            canvasWidgetsBlocked: LOD.canvasWidgetsBlocked,
            hoverBlocked: LOD.hoverBlocked,
            // The event gate, and what the page's own computed style said about
            // the elements this tool believes it switched off.
            eventsBlocked: LOD.eventsBlocked,
            blockedElements: LOD.blockSet ? LOD.blockSet.size : 0,
            verifiedOff: LOD.domVerified,
            stillReachable: LOD.domBroken,
            // The foveated half: how far off screen counts as far, how many
            // elements may come back per drawn frame, and what is queued.
            fovea: !!LOD.fovea,
            margin: LOD.foveaMargin,
            restorePerFrame: LOD.foveaRestore,
            foveaElements: LOD.foveaEls,
            queued: LOD.foveaQueue,
            cameBack: LOD.foveaCameBack,
            registered: LOD.domOwners ? LOD.domOwners.size : 0,
            // What the display-scale check found, so a caller can see the ratio
            // this page's viewport maths is being done at.
            display: LOD.display,
          };
        },
        // Re-runs the DOM sweep. The tracker does this itself on a zoom or a
        // setting change; this is here so a test (or a script) can ask for it.
        sweep: () => {
          try {
            return lodSweepDom(app.canvas);
          } catch (e) {
            return false;
          }
        },
        off: () => lodSet({ flatBelow: 0, boxDetail: "plain", snapshots: false, idleCapMs: 0, thumbZoom: 0, detailZoom: 0, linkStyle: "spline", inertBelow: 0, fovea: false }),
        // The master switch: the same one the checkbox on the tracker's own node
        // and the ⏻ button in the panel drive.
        get enabled() {
          return antsEnabled();
        },
        setEnabled: (on) => antsSetEnabled(on),
        // Re-runs the display-scale check on demand (it also runs at startup,
        // once a second, and on every sweep) and hands back what it found.
        checkDisplay: () => {
          try {
            return viewDisplayProbe(app.canvas, true);
          } catch (e) {
            return null;
          }
        },
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
    // A saved focus setting has to be in force before the first frame, not after
    // the first sweep: these are the seams that make it real.
    try {
      viewInstallWidgetGate();
      viewInstallEventGate();
    } catch (e) {
      /* never fatal */
    }
    // The display-scale check, once the page exists: what the browser reports,
    // what the canvas backing store says, and whether the frontend's own visible
    // area is in CSS pixels or device pixels. Nothing depends on the answer — the
    // maths reads the canvas's CSS box when it can — but a mismatch is the kind of
    // thing that must be said out loud rather than guessed at, so it is logged
    // when it happens and reported in the panel either way.
    try {
      const probe = viewDisplayProbe(app.canvas, true);
      if (probe && probe.unit === "device-pixel") {
        console.warn(
          `[ANTs Tracker] display scale: the browser reports ${probe.win}\u00d7, the canvas backing store is ${probe.backing}\u00d7 its ` +
            `CSS box, and the frontend's visible area is ${probe.factor}\u00d7 our own computation of it (${probe.reported} vs ${probe.ours} graph ` +
            `units) \u2014 so its rectangle is in ${probe.unit} units. The tracker does its own maths from the CSS box.`
        );
      }
    } catch (e) {
      /* the check is a report, not a dependency */
    }
    buildCornerButton();
    installStallObserver();
    installRafMonitor();
    installMemorySampler();
    govOwn(() => setInterval(sweepStaleData, SWEEP_MS));
    // Node types keep arriving as packs register, so re-scan for hooks that
    // never went through this tool's beforeRegisterNodeDef wrapper.
    // The same interval that scans for late node types also asks whether the
    // separate window is open. No extra timer: a timer registered at startup
    // spends one of the attribution tokens the governor has for other packs.
    govOwn(() => setInterval(() => {
      scanRegisteredTypes();
      if (!antsUiTimer) antsUiPump();
    }, 2000));
    govOwn(() => setInterval(() => {
      if (ui.built && ui.panel.classList.contains("open") && ui.active === "gpu") refreshGpu();
    }, 2500));
    try {
      lodThumbDiskSweep();
    } catch (e) {
      /* the disk cache is optional; a missing route leaves the memory cache */
    }
    try {
      lodInstallRamWatch();
    } catch (e) {
      /* a run with no execution events simply does not release stand-ins */
    }
    console.info(
      `[ANTs Tracker] v${VERSION} running. The gear opens the separate window; if the browser blocks it, the panel on this page opens instead. ` +
        "window.__antsTracker.snapshot / .report give the same data from the console."
    );
  },

  afterConfigureGraph() {
    resetAllStats();
  },

  beforeRegisterNodeDef(nodeType, nodeData) {
    if (!nodeData || (nodeData.name !== NODE_NAME && nodeData.name !== NODE_NAME_ALIAS)) return;
    const onNodeCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const ret = onNodeCreated ? onNodeCreated.apply(this, arguments) : undefined;
      // The pill: a master switch and the gear that opens the panel, side by side
      // in one rounded frame. Marked .ants-own, so no low-zoom sweep can hide it —
      // it is the control that switches the tool off, so it has to be there when
      // everything else has been switched off.
      antsAttachNodeWidget(this);
      antsUnlockNode(this);
      try {
        this.setDirtyCanvas(true, true);
      } catch (e) {
        /* cosmetic only */
      }
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
//  * ComfyUI's Vue-nodes frontend (Nodes 2.0) draws no node chrome on the
//    canvas: LiteGraph's drawNode returns immediately and each node is a DOM
//    element. The stand-in setting still acts there, through the other pathway,
//    and *the mark is the mechanism*: the node's own element carries an
//    *attribute* (`data-ants-vue-standin`) with an `!important` rule rather than a
//    class, because `LGraphNode.vue` binds `:class` on that element and rewrites
//    it wholesale on every re-render, so a tool class is silently thrown away and
//    the node comes back visible behind its box. The same reasoning applies to the
//    fovea's hide mark on a node's own element (`data-ants-dom-hidden`) and the
//    inert mark (`data-ants-dom-inert`).
//    Two rules hang off the attribute. The element's *children* are
//    `visibility: hidden`, which an engine skips in the paint phase — that is the
//    saving, and with hardware acceleration off it is CPU work on every frame
//    that a stand-in must not leave behind. The element's own box keeps
//    `opacity: 0`: it paints nothing anyway, and it must stay hit-testable,
//    because in this renderer selecting and dragging a node are that DOM. A third
//    rule re-shows the slot dots: a link drag starts on the dot
//    (`SlotConnectionDot.vue` carries the pointerdown), and the canvas renderer
//    keeps linking working through its own canvas hit test, so the two pathways
//    have to agree. So what a stand-in trades away is the *painted* node, not the
//    node: a widget, a collapse button, an editable label or a resize handle inside
//    a boxed node does not receive its own clicks at that zoom (the pointer goes to
//    the node, which is what the user sees there), and the accessibility tree entry
//    for the node is that of a hidden subtree while the picture stands in.
//    Measured, and pinned by tests: the frontend's paint for those nodes stops
//    (the count is `vuePaintSkipped`), the layout is untouched — rects, text
//    metrics and every observer keep answering, so a change inside a stand-in is
//    still reported and the picture is re-made — and a frame in the steady state
//    costs the page no attribute writes, no layout reads, no DOM queries and no
//    computed styles at 40, 60 and 150 nodes. What page JavaScript cannot measure
//    is the rasteriser's own bill; that is what the frame budget, the Stalls tab
//    and DevTools' paint flashing show on the machine the graph runs on.
//  * A stand-in never carries a node's execution state, in either renderer, and
//    the panel's "N element(s) hidden" is the page's own count. In the Vue
//    renderer a node whose state is live (a progress value, errors, a drag, a
//    video) is never boxed at all — `lodVueFlatNode` refuses the same nodes
//    `lodSnapLive` refuses, so the element stays and the frontend draws its own
//    bar, its own error stroke and its own outline around the node that is
//    executing. In the canvas renderer a box does stand for such a node, and the
//    two marks are read from `node.progress`/`node.has_errors` — fields the
//    frontend itself mirrors onto the node object in both renderers
//    (`nodeProgressCanvasSync.ts`, `useNodeErrorFlagSync.ts`) — on every frame:
//    neither is ever photographed nor blitted (see `lodSnapLive`), so a bar of the
//    instant of a capture cannot be served after the run it belonged to. The
//    hidden count is per *element* dressed, one class (`.ants-lod-box`) or one
//    attribute (`data-ants-dom-hidden`) each, and equals what a walk of the page
//    for those two marks finds. (The Vue-nodes pathway's stand-in mark is a third
//    one — the attribute `data-ants-vue-standin` on the node's root, counted as
//    `vueBlanked` — and the panel names the renderer it is reporting on.)
//  * A picture is only taken once its node has stopped changing: a settle window
//    (LOD_SNAP_SETTLE_MS, 300ms) opened when a node is first drawn as a stand-in
//    and re-opened by every change the page reports — or by a signature that no
//    longer matches. The frontend renders a node in pieces (the component mounts,
//    the layout store hands the size over, the widgets and the node's own media
//    arrive as they are decoded), so a capture taken at the first opportunity is a
//    picture of a node that is still being built; that is a *when*, not a
//    screenshot API, and it is what a user meant by "photographed too early".
//    Nothing is read or written while a node is quiet: the window is a floor on
//    how late the lane may be, never a poll.
//  * What a Vue-nodes stand-in cannot be is a *screenshot*: no browser API
//    draws a DOM element into a canvas (not drawImage, not createImageBitmap,
//    not captureStream). The picture is therefore *drawn* — the box, its title
//    bar and state marks, the node's own structure and widget rows in the
//    colours the browser computed, the text wrapped into the box the browser
//    laid it out in and drawn in the element's own font, the values of its form
//    and ARIA controls drawn as the controls they are, the node's composited
//    opacity, and the node's own `<img>`/`<canvas>` elements at the rows the
//    layout gave them — into the same capture surface the canvas renderer uses,
//    with the same capture resolution, mip chain, RAM budget and disk files.
//    Every colour goes through `lodVueColor` first: this frontend's themed
//    surfaces are Tailwind 4 `oklch()`/`oklab()` strings, which a canvas
//    `fillStyle` ignores *silently* (the previous colour stays, so a node wears
//    the previous node's palette). The parts that are neither an image, a canvas
//    nor plain text (a pack's own HTML) stay blank in the picture and are
//    counted. A picture made in one renderer is not reused in the other:
//    switching renderers releases what was held and makes the pictures again,
//    because the box, the padding and the content route all differ. There is no
//    zoom-dependent level of detail to reproduce, either: this frontend binds a
//    node's size, position, z-index and opacity and nothing else, transforms the
//    whole graph with one pane, and draws no node with LiteGraph in this mode —
//    a zoom is compositor work, so the DOM the reader measures is the same DOM at
//    every zoom (`lodVueLodProbe` reports that from the page).
//  * The box a Vue-nodes stand-in covers is measured from the element, not
//    taken from `node.size`: `LGraphNode.vue` renders an image node
//    IMAGE_PREVIEW_HEIGHT_RESERVE = 220 + 8 + 4 px taller than its graph size,
//    and the picture lives in that reserve. A box the size of `node.size` would
//    clip off exactly the picture being looked for. The measurement divides the
//    element's client-pixel rect by the zoom the *element* is laid out at
//    (measured from its own width, not read from canvas.ds.scale — a capture
//    sets that to 1 while the DOM keeps its transform), so a capture during a
//    zoom still puts the content where it belongs.
//  * That measurement is one read per node, and it is taken when the page
//    *reports* a change rather than on a timer (ResizeObserver + MutationObserver
//    over the element; the harness models both), with a 5 s insurance read
//    (LOD_VUE_MEDIA_MS_WATCHED) for a change no observer reports. A page without
//    those observers falls back to the LOD_VUE_MEDIA_MS / LOD_VUE_MEDIA_MS_IDLE
//    beat. Either way the refreshes are rationed to LOD_VUE_MEDIA_BUDGET node
//    layouts per frame, so a graph with hundreds of boxed nodes cannot turn the
//    refresh into one forced layout per node per frame — and in the steady state
//    (nothing changing, pictures held) a frame asks the page for nothing at all:
//    no attribute write, no layout read, no DOM query, no computed style. Panning and zooming cost no read at all:
//    every number stored is node-local. Link thinning, the idle redraw cap, the widget/focus settings
//    and the governor are unaffected. A box in that renderer is also never
//    painted over a node whose element this tool could not reach (a node whose
//    `[data-node-id]` element is missing keeps its own drawing, and is counted).
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
//    (ComfyUI does not). A stand-in photograph is that draw — a worker cannot
//    call it. The idle lane yields between slices so a drag is not blocked; it
//    does not multithread the photograph. The worker lane exists for the
//    pure-math parts, and it says so when it falls back to the main thread.
//  * The Window button opens /ants_optimizer/window: its own page, served by
//    this extension, for a second monitor. It is not a second ComfyUI process
//    and not a worker. It talks to the ComfyUI page through /ants_optimizer/ui
//    (a revision and an origin, so neither side is the master), which means it
//    shows the live numbers only while the ComfyUI page is open and answering;
//    with that page gone the window says so instead of pretending. A blocked
//    popup leaves the in-page panel as the fallback and says why.
//  * Worker functions cannot capture closures, which is why the lane takes a
//    job name (or a self-contained function source) plus structured-cloneable
//    arguments and nothing else.
//  * In the Vue-nodes renderer a stand-in is a marked element plus a box: the
//    element keeps its layout, its observers and its pointer events (its
//    children do not paint, the node's own box is transparent and still
//    hit-testable, and the slot dots stay live because that is where a link drag
//    starts), so selecting, dragging and linking a node are unchanged while a
//    widget *inside* a stand-in no longer receives its own clicks at that zoom,
//    and the node's accessibility tree entry is that of a hidden subtree. Not
//    exercised in this pass against a live Vue-nodes page — verified against the
//    frontend's sources (`LGraphNode.vue`, `NodeHeader.vue`, `NodeSlots.vue`,
//    `useNodePointerInteractions.ts`, `useVueNodeResizeTracking.ts`) and the
//    harness.
//  * A stand-in picture is the canvas drawing of the node plus what this tool
//    could honestly draw of its DOM widgets (an image or a canvas pixel for
//    pixel; a text field's value re-painted, because page JavaScript cannot
//    screenshot rendered text; a pack's own HTML left blank and counted). A
//    video, and an element holding one, is never photographed. A picture that
//    includes an image from another origin is tainted by the browser, which is
//    allowed to blit but not to read back: such a picture works in memory and
//    simply cannot be written to disk.
//  * Node snapshots reuse a bitmap that was checked against the node's signature
//    at most LOD_SNAP_SIG_MS ago (100ms), so a change that happens between two
//    checks can be shown stale for that long. Anything the panel can see cheaply
//    — selection, hover, an error, progress, a drag — is checked every frame
//    instead and never uses a bitmap. A bitmap is also a *picture of the node at
//    the moment it was captured*: while a node's own live drawing animates
//    without changing any field in the signature (a shader-like hook with its own
//    clock), the picture is the frame it was taken from, not a moving image.
//  * A capture is drawn at the capture ratio (default 1 pixel per graph unit)
//    and scaled into the node's box on screen. Zoomed in past that, a snapshot is
//    softer than the live drawing — which is why a node that is being worked at,
//    selected or hovered is never served from one, and why the ratio is a
//    setting rather than a constant. The ratio is also the coverage knob on a
//    large graph: the budget divided by the pixels per picture decides how many
//    nodes can hold one at all.
