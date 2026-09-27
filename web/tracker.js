// ANTs Nasty Bastards Tracker — frontend profiler for ComfyUI
// =============================================================
// Runs from page load. Times every extension's draw-related node
// hooks, tracks unattributed canvas-draw time, tracks resource load
// cost per extension, and shows a floating, sortable overlay.
//
// This file makes assumptions about ComfyUI's frontend internals
// (LiteGraph-based classic canvas: nodeType.prototype.onDrawForeground
// etc., app.canvas being an LGraphCanvas instance). If a future
// ComfyUI frontend version changes these, the console will say so
// loudly rather than failing silently — see WARN_ONCE below.

import { app } from "/scripts/app.js";

const EXT_NAME = "ANTs.NastyBastardsTracker.Core";
const NODE_NAME = "ANTsNastyBastardsTracker";

// ---------------------------------------------------------------
// Small utils
// ---------------------------------------------------------------

const warnedOnce = new Set();
function warnOnce(key, msg) {
  if (warnedOnce.has(key)) return;
  warnedOnce.add(key);
  console.warn(`[ANTs Tracker] ${msg}`);
}

function fmtMs(n) {
  if (!Number.isFinite(n)) return "-";
  return n >= 10 ? n.toFixed(1) : n.toFixed(2);
}

function fmtBytes(n) {
  if (!Number.isFinite(n)) return "-";
  const units = ["B", "KB", "MB", "GB"];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(1)} ${units[i]}`;
}

// Extract a human-readable "extension source" name from an extension
// object being registered. Falls back to a generated tag if unnamed.
let anonCounter = 0;
function extLabel(extObj) {
  if (extObj && typeof extObj.name === "string" && extObj.name.trim()) {
    return extObj.name.trim();
  }
  anonCounter += 1;
  return `(unnamed extension #${anonCounter})`;
}

// ---------------------------------------------------------------
// Stats storage
// ---------------------------------------------------------------
// Keyed by `${extensionLabel}::${hookName}`. Each bucket tracks a
// rolling window so the panel shows "recent" cost, not a lifetime
// average that never reflects a fix you just made.

const ROLLING_WINDOW_MS = 4000; // how far back "recent avg" looks

function newBucket(extLabel, hookName) {
  return {
    ext: extLabel,
    hook: hookName,
    calls: [], // {t, dt}
    totalCalls: 0,
    muted: false,
  };
}

const hookStats = new Map(); // key -> bucket
const mutedExtensions = new Set(); // extension labels currently muted

function getBucket(extLabel, hookName) {
  const key = `${extLabel}::${hookName}`;
  let b = hookStats.get(key);
  if (!b) {
    b = newBucket(extLabel, hookName);
    hookStats.set(key, b);
  }
  return b;
}

function recordCall(bucket, dt) {
  const now = performance.now();
  bucket.calls.push({ t: now, dt });
  bucket.totalCalls += 1;
  // trim old entries
  const cutoff = now - ROLLING_WINDOW_MS;
  while (bucket.calls.length && bucket.calls[0].t < cutoff) {
    bucket.calls.shift();
  }
}

function bucketRecentTotalMs(bucket) {
  let sum = 0;
  for (const c of bucket.calls) sum += c.dt;
  return sum;
}

function bucketRecentAvgMs(bucket) {
  if (!bucket.calls.length) return 0;
  return bucketRecentTotalMs(bucket) / bucket.calls.length;
}

// Per-extension aggregate (sum across all its hooks), computed on demand.
function perExtensionTotals() {
  const totals = new Map(); // extLabel -> {recentMs, calls, muted}
  for (const bucket of hookStats.values()) {
    let entry = totals.get(bucket.ext);
    if (!entry) {
      entry = { recentMs: 0, calls: 0, muted: mutedExtensions.has(bucket.ext) };
      totals.set(bucket.ext, entry);
    }
    entry.recentMs += bucketRecentTotalMs(bucket);
    entry.calls += bucket.calls.length;
  }
  return totals;
}

// ---------------------------------------------------------------
// Frame-level tracking (total draw() cost vs. attributed cost)
// ---------------------------------------------------------------

let currentFrameAttributedMs = 0;
const frameHistory = []; // {t, total, attributed}

function frameRecordAttributed(dt) {
  currentFrameAttributedMs += dt;
}

function frameRecordTotal(totalDt) {
  const now = performance.now();
  frameHistory.push({
    t: now,
    total: totalDt,
    attributed: currentFrameAttributedMs,
  });
  currentFrameAttributedMs = 0;
  const cutoff = now - ROLLING_WINDOW_MS;
  while (frameHistory.length && frameHistory[0].t < cutoff) {
    frameHistory.shift();
  }
}

function frameSummary() {
  if (!frameHistory.length) {
    return { avgTotalMs: 0, avgAttributedMs: 0, avgUnattributedMs: 0, fps: 0, frames: 0 };
  }
  let total = 0;
  let attributed = 0;
  for (const f of frameHistory) {
    total += f.total;
    attributed += f.attributed;
  }
  const n = frameHistory.length;
  const avgTotalMs = total / n;
  const avgAttributedMs = attributed / n;
  const avgUnattributedMs = Math.max(0, avgTotalMs - avgAttributedMs);
  const windowSeconds = (frameHistory[n - 1].t - frameHistory[0].t) / 1000;
  const fps = windowSeconds > 0 ? n / windowSeconds : 0;
  return { avgTotalMs, avgAttributedMs, avgUnattributedMs, fps, frames: n };
}

// ---------------------------------------------------------------
// Per-node-TYPE render cost (separate lane from extension-hook
// attribution above). This times LiteGraph's own drawNode() call in
// full, which includes any extension's onDraw* hook as a SUBSET of
// that time. Deliberately NOT merged into the Timing tab's numbers —
// merging would double-count whatever an extension already reported
// there. This lane exists to answer a different question: "which
// node type is expensive to render at all," including LiteGraph's
// own chrome-drawing cost (borders, titles, slots, embedded bitmaps),
// which is usually most of what "unattributed" time actually is.
// ---------------------------------------------------------------

const nodeDrawStats = new Map(); // typeName -> {calls: [{t, dt}]}

function getNodeDrawBucket(typeName) {
  let b = nodeDrawStats.get(typeName);
  if (!b) {
    b = { calls: [] };
    nodeDrawStats.set(typeName, b);
  }
  return b;
}

function recordNodeDraw(typeName, dt) {
  const b = getNodeDrawBucket(typeName);
  const now = performance.now();
  b.calls.push({ t: now, dt });
  const cutoff = now - ROLLING_WINDOW_MS;
  while (b.calls.length && b.calls[0].t < cutoff) b.calls.shift();
}

// BUG FIX: a bucket's rolling-window trim above only ever runs when that
// SAME type/extension receives a fresh call. A type that stops being drawn
// entirely (you switched ComfyUI tabs/graphs, or muted something) never
// gets touched again, so its old entries — and the whole row — would sit
// there forever looking exactly as "hot" as the moment you left it, well
// past the 4-second window that every other row obeys. This periodic sweep
// trims EVERY bucket by wall-clock time regardless of activity, and drops
// buckets that end up empty, so a switched-away-from graph's data actually
// disappears from both tabs within one rolling window instead of never.
const STALE_SWEEP_MS = 1000;

function trimBucketByCutoff(bucket) {
  const cutoff = performance.now() - ROLLING_WINDOW_MS;
  while (bucket.calls.length && bucket.calls[0].t < cutoff) bucket.calls.shift();
}

function sweepStaleBuckets() {
  for (const [key, bucket] of hookStats.entries()) {
    trimBucketByCutoff(bucket);
    if (bucket.calls.length === 0) hookStats.delete(key);
  }
  for (const [type, bucket] of nodeDrawStats.entries()) {
    trimBucketByCutoff(bucket);
    if (bucket.calls.length === 0) nodeDrawStats.delete(type);
  }
}

setInterval(sweepStaleBuckets, STALE_SWEEP_MS);

// If ComfyUI fires a real graph (re)configure — a fresh workflow load, not
// necessarily every tab click — clear everything immediately rather than
// waiting out the sweep above. Belt-and-suspenders with the sweep: this
// gives an instant clean reset when it fires, the sweep guarantees eventual
// correctness even if it doesn't fire for a given kind of tab switch.
function resetAllStats() {
  hookStats.clear();
  nodeDrawStats.clear();
  frameHistory.length = 0;
  currentFrameAttributedMs = 0;
  // Deliberately NOT clearing mutedExtensions — that's a standing user
  // choice about a named extension, not something scoped to one graph.
}

// If most node types' call counts in the window are exact multiples of
// some shared small number, that's not N independent per-type timers —
// it's one graph-wide invalidation tick (e.g. a status/telemetry
// heartbeat calling a global setDirtyCanvas) multiplied by however many
// instances of each type happen to be visible. Detect and surface that
// directly instead of flagging each type as individually suspicious.
//
// NOTE: this deliberately does NOT compute one running GCD across every
// row. A single outlier (a node that was only partly visible during the
// window, entering/leaving the viewport mid-way through) can collapse a
// naive whole-set GCD to 1 even when the large majority of rows clearly
// share a common tick — so instead this tries each distinct value seen
// as a candidate unit and keeps whichever one explains the most rows as
// an exact multiple, which tolerates a handful of non-conforming rows.
function bestSharedUnit(counts) {
  const distinct = [...new Set(counts)];
  let best = null;
  for (const candidate of distinct) {
    if (candidate <= 1) continue;
    const matches = counts.filter((c) => c % candidate === 0).length;
    if (!best || matches > best.matches || (matches === best.matches && candidate < best.candidate)) {
      best = { candidate, matches };
    }
  }
  return best;
}

function detectSharedTick(rows) {
  const counts = rows.map((r) => r.calls).filter((c) => c > 0);
  if (counts.length < 3) return null;
  const best = bestSharedUnit(counts);
  if (!best) return null;
  if (best.matches / counts.length < 0.6) return null;
  const totalFrames = frameSummary().frames;
  // Only interesting if the shared unit is well below the frame count —
  // otherwise "everyone shares a factor of 1 tick per frame" is just
  // normal per-frame painting, not a separate external clock.
  if (totalFrames > 0 && best.candidate >= totalFrames * 0.8) return null;
  return {
    unit: best.candidate,
    matching: best.matches,
    total: counts.length,
    intervalMs: ROLLING_WINDOW_MS / best.candidate,
  };
}

// --- Debounce/hysteresis for the banner --------------------------------
// Recomputing detectSharedTick fresh on every 500ms table refresh, against
// a noisy rolling window, made the banner flicker in and out on borderline
// data. Decouple: recompute at most every TICK_RECHECK_MS, and only change
// what's actually DISPLAYED after a few consecutive consistent reads.
const TICK_RECHECK_MS = 2000;
const TICK_HITS_TO_SHOW = 2;
const TICK_MISSES_TO_HIDE = 3;

let tickBannerState = null; // last CONFIRMED {unit, matching, total, intervalMs} or null
let tickHitStreak = 0;
let tickMissStreak = 0;
let lastTickCheck = 0;

function updateTickBanner(rows) {
  const now = performance.now();
  if (now - lastTickCheck < TICK_RECHECK_MS) return tickBannerState;
  lastTickCheck = now;
  const detected = detectSharedTick(rows);
  if (detected) {
    tickMissStreak = 0;
    tickHitStreak += 1;
    if (tickHitStreak >= TICK_HITS_TO_SHOW) tickBannerState = detected;
  } else {
    tickHitStreak = 0;
    tickMissStreak += 1;
    if (tickMissStreak >= TICK_MISSES_TO_HIDE) tickBannerState = null;
  }
  return tickBannerState;
}

function nodeDrawTotals() {
  const totals = [];
  for (const [type, b] of nodeDrawStats.entries()) {
    let sum = 0;
    for (const c of b.calls) sum += c.dt;
    if (sum > 0 || b.calls.length > 0) {
      totals.push({ type, ms: sum, calls: b.calls.length });
    }
  }
  return totals.sort((a, b) => b.ms - a.ms);
}

// ---------------------------------------------------------------
// The hooks we care about timing. These are the ones LiteGraph calls
// once per node, once (or more) per frame while anything is dirty —
// i.e. the ones that actually cost you FPS while panning/zooming.
// ---------------------------------------------------------------

const DRAW_HOOKS = [
  "onDrawForeground",
  "onDrawBackground",
  "onDrawCollapsed",
  "onBounding",
];

// Wrap a single hook function with a timer tagged to extLabelStr.
// Respects the mute set: if the owning extension is muted, the
// original function is skipped entirely (not just timed at zero —
// actually skipped, so you can measure the FPS gain of removing it).
function wrapHook(fn, extLabelStr, hookName) {
  if (typeof fn !== "function" || fn.__antsWrapped) return fn;
  const bucket = getBucket(extLabelStr, hookName);
  const wrapped = function (...args) {
    if (mutedExtensions.has(extLabelStr)) {
      return undefined; // skip entirely — this is the point of "mute"
    }
    const t0 = performance.now();
    const ret = fn.apply(this, args);
    const dt = performance.now() - t0;
    recordCall(bucket, dt);
    frameRecordAttributed(dt);
    return ret;
  };
  wrapped.__antsWrapped = true;
  wrapped.__antsOriginal = fn;
  wrapped.__antsExt = extLabelStr;
  return wrapped;
}

// After an extension's beforeRegisterNodeDef has run against a given
// nodeType, check each draw-ish hook: if it changed (this extension
// set/overwrote it), wrap the new one and tag it with this extension.
// Permanent diagnostic: how many (extension, hookName) pairs have ever
// actually been wrapped this session, AND their identities — answers a
// question that otherwise requires guessing every time the Timing tab is
// empty: "did nothing fire recently, or does nothing here override these
// hooks at all, and if it does, which extensions specifically?"
let totalHooksWrapped = 0;
const everWrappedHooks = new Set(); // "extLabel::hookName", never cleared by the sweep/reset

function instrumentNodeTypeAfterHook(nodeType, before, extLabelStr) {
  for (const hookName of DRAW_HOOKS) {
    const after = nodeType.prototype[hookName];
    if (after && after !== before[hookName] && !after.__antsWrapped) {
      nodeType.prototype[hookName] = wrapHook(after, extLabelStr, hookName);
      totalHooksWrapped += 1;
      everWrappedHooks.add(`${extLabelStr}::${hookName}`);
    }
  }
}

// ---------------------------------------------------------------
// The core patch: wrap app.registerExtension so every OTHER
// extension's beforeRegisterNodeDef gets instrumented automatically.
// Must run before any other extension's web JS calls registerExtension
// — this is why this folder is prefixed 0000_.
// ---------------------------------------------------------------

const ORIGINAL_REGISTER = app.registerExtension.bind(app);
let patched = false;

function patchRegisterExtension() {
  if (patched) return;
  patched = true;

  app.registerExtension = function (extObj) {
    // Don't instrument ourselves.
    if (extObj && extObj.name === EXT_NAME) {
      return ORIGINAL_REGISTER(extObj);
    }

    const label = extLabel(extObj);
    const originalBeforeRegister = extObj && extObj.beforeRegisterNodeDef;

    if (typeof originalBeforeRegister === "function") {
      extObj.beforeRegisterNodeDef = function (nodeType, nodeData, appRef) {
        const before = {};
        for (const hookName of DRAW_HOOKS) {
          before[hookName] = nodeType.prototype[hookName];
        }
        const result = originalBeforeRegister.call(this, nodeType, nodeData, appRef);
        instrumentNodeTypeAfterHook(nodeType, before, label);
        return result;
      };
    }

    return ORIGINAL_REGISTER(extObj);
  };
}

patchRegisterExtension();

// ---------------------------------------------------------------
// Frame-total patch: wrap the canvas's own draw() so we know real
// total-per-frame cost, independent of anything above. This is what
// lets the panel report "unattributed" time — extensions that patch
// LGraphCanvas/LGraphNode prototypes directly instead of going through
// registerExtension's beforeRegisterNodeDef won't show up by name, but
// their cost still shows up here as a gap between total and attributed.
// ---------------------------------------------------------------

let canvasPatched = false;

// ---------------------------------------------------------------
// Testing overrides — both OFF by default, both explicitly opt-in from
// the Testing tab. Neither persists across a page reload.
// ---------------------------------------------------------------

// 1) Canvas redraw rate CAP: skip real draw() calls that arrive sooner
// than this many ms after the last one actually executed. Applies to
// every caller of draw() — panning, ComfyUI's own tick, the synthetic
// generator below — since it sits at the single real entry point.
let drawThrottleMs = 0; // 0 = off (normal browser/ComfyUI behavior)
let lastRealDrawAt = 0;

// 2) Synthetic forced-tick generator: calls app.canvas.draw() on its own
// fixed interval, independent of anything else, as a known reference
// point to compare against whatever organic tick the Nodes tab finds.
let syntheticTickMs = 0; // 0 = off
let syntheticTickTimer = null;

function setSyntheticTick(ms) {
  syntheticTickMs = ms;
  if (syntheticTickTimer) {
    clearInterval(syntheticTickTimer);
    syntheticTickTimer = null;
  }
  if (ms > 0) {
    syntheticTickTimer = setInterval(() => {
      try {
        if (app.canvas && typeof app.canvas.draw === "function") {
          app.canvas.draw(true, true); // force flags — harmless if ignored
        } else {
          warnOnce("no-force-draw", "Can't force a redraw — app.canvas.draw isn't callable directly in this frontend version.");
        }
      } catch (e) {
        warnOnce("synthetic-tick-error", `Forced redraw failed: ${e && e.message}`);
      }
    }, ms);
  }
}

function patchCanvasDrawOnce() {
  if (canvasPatched) return;
  if (!app.canvas || !app.canvas.constructor || !app.canvas.constructor.prototype) {
    warnOnce(
      "no-canvas",
      "app.canvas not available yet — frame-total timing not installed. " +
        "This build's frontend may not expose a classic LGraphCanvas instance."
    );
    return;
  }
  const proto = app.canvas.constructor.prototype;
  if (typeof proto.draw !== "function") {
    warnOnce(
      "no-draw-fn",
      "app.canvas.constructor.prototype.draw not found — this ComfyUI frontend " +
        "version may have changed its canvas draw entry point. Per-extension " +
        "hook timing still works; total-frame / unattributed numbers will not."
    );
  } else {
    const originalDraw = proto.draw;
    proto.draw = function (...args) {
      if (drawThrottleMs > 0) {
        const now = performance.now();
        if (now - lastRealDrawAt < drawThrottleMs) {
          return undefined; // capped — this tick is deliberately skipped
        }
        lastRealDrawAt = now;
      }
      const t0 = performance.now();
      const ret = originalDraw.apply(this, args);
      const dt = performance.now() - t0;
      frameRecordTotal(dt);
      return ret;
    };
  }

  if (typeof proto.drawNode === "function" && !proto.drawNode.__antsWrapped) {
    const originalDrawNode = proto.drawNode;
    const wrappedDrawNode = function (node, ctx, ...rest) {
      const t0 = performance.now();
      const ret = originalDrawNode.call(this, node, ctx, ...rest);
      const dt = performance.now() - t0;
      const typeName =
        (node && (node.type || (node.constructor && node.constructor.type))) || "unknown";
      recordNodeDraw(typeName, dt);
      return ret;
    };
    wrappedDrawNode.__antsWrapped = true;
    proto.drawNode = wrappedDrawNode;
  } else if (typeof proto.drawNode !== "function") {
    warnOnce(
      "no-drawnode-fn",
      "app.canvas.constructor.prototype.drawNode not found — per-node-type " +
        "render cost (Nodes tab) unavailable. Extension-hook timing (Timing tab) " +
        "still works independently of this."
    );
  }

  canvasPatched = true;
}

// ---------------------------------------------------------------
// Resource load cost per extension (independent of the above —
// this just reads the browser's own Resource Timing entries for
// anything served under /extensions/<pack>/).
// ---------------------------------------------------------------

function resourceLoadSummary() {
  const entries = performance.getEntriesByType("resource");
  const byPack = new Map(); // packName -> {bytes, ms, count}
  for (const e of entries) {
    const m = e.name.match(/\/extensions\/([^/]+)\//);
    if (!m) continue;
    const pack = decodeURIComponent(m[1]);
    let entry = byPack.get(pack);
    if (!entry) {
      entry = { bytes: 0, ms: 0, count: 0 };
      byPack.set(pack, entry);
    }
    entry.bytes += e.transferSize || e.encodedBodySize || 0;
    entry.ms += e.duration || 0;
    entry.count += 1;
  }
  return byPack;
}

// ---------------------------------------------------------------
// Overlay panel — plain DOM, no framework dependency, so it works
// regardless of whether the rest of the frontend is on Vue or not.
// ---------------------------------------------------------------

let panelEl = null;
let cornerBtnEl = null;
let refreshTimer = null;
let activeTab = "timing";

const STYLE = `
#ants-tracker-panel {
  position: fixed;
  top: 60px;
  right: 20px;
  width: 540px;
  max-height: 70vh;
  background: #1a1a1e;
  border: 1px solid #3a3a42;
  border-radius: 8px;
  box-shadow: 0 8px 24px rgba(0,0,0,0.5);
  color: #ddd;
  font: 12px/1.4 -apple-system, Segoe UI, sans-serif;
  z-index: 99999;
  display: none;
  flex-direction: column;
  overflow: hidden;
}
#ants-tracker-panel.open { display: flex; }
#ants-tracker-header {
  cursor: move;
  padding: 8px 10px;
  background: #26262c;
  border-bottom: 1px solid #3a3a42;
  display: flex;
  align-items: center;
  justify-content: space-between;
  user-select: none;
}
#ants-tracker-header b { color: #f0a020; }
#ants-tracker-header .ants-close {
  cursor: pointer;
  color: #aaa;
  padding: 2px 6px;
  border-radius: 4px;
}
#ants-tracker-header .ants-close:hover { background: #3a3a42; color: #fff; }
#ants-tracker-header .ants-copy {
  cursor: pointer;
  color: #aaa;
  padding: 2px 6px;
  border-radius: 4px;
  font-size: 11px;
  margin-right: 4px;
}
#ants-tracker-header .ants-copy:hover { background: #3a3a42; color: #fff; }
#ants-tracker-tabs {
  display: flex;
  border-bottom: 1px solid #3a3a42;
  background: #202024;
}
#ants-tracker-tabs button {
  flex: 1;
  background: none;
  border: none;
  color: #999;
  padding: 6px 4px;
  cursor: pointer;
  font-size: 11px;
  border-bottom: 2px solid transparent;
}
#ants-tracker-tabs button.active {
  color: #f0a020;
  border-bottom-color: #f0a020;
}
#ants-tracker-body {
  padding: 8px 10px;
  overflow-y: auto;
}
#ants-tracker-summary {
  padding: 6px 10px;
  background: #202024;
  border-bottom: 1px solid #3a3a42;
  display: flex;
  gap: 14px;
  font-variant-numeric: tabular-nums;
}
#ants-tracker-summary span b { color: #fff; }
table.ants-table { width: 100%; border-collapse: collapse; }
table.ants-table th {
  text-align: left;
  color: #888;
  font-weight: 500;
  padding: 3px 6px;
  border-bottom: 1px solid #333;
  position: sticky;
  top: 0;
  background: #1a1a1e;
}
table.ants-table td {
  padding: 3px 6px;
  border-bottom: 1px solid #262629;
  font-variant-numeric: tabular-nums;
}
table.ants-table tr.ants-muted td { opacity: 0.4; text-decoration: line-through; }
table.ants-table tr.ants-hot td.ants-ms { color: #ff6b6b; font-weight: 600; }
table.ants-table tr.ants-warm td.ants-ms { color: #f0a020; }
.ants-mute-btn {
  background: #2c2c33;
  border: 1px solid #444;
  color: #ccc;
  border-radius: 4px;
  padding: 1px 6px;
  cursor: pointer;
  font-size: 10px;
}
.ants-mute-btn:hover { background: #3a3a42; }
.ants-mute-btn.active { background: #6b2c2c; border-color: #a04a4a; color: #fff; }
#ants-corner-btn {
  position: fixed;
  bottom: 16px;
  right: 16px;
  width: 34px;
  height: 34px;
  border-radius: 50%;
  background: #26262c;
  border: 1px solid #444;
  color: #f0a020;
  font-size: 16px;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  z-index: 99998;
  box-shadow: 0 2px 8px rgba(0,0,0,0.4);
}
#ants-corner-btn:hover { background: #33333a; }
.ants-note {
  color: #888;
  font-size: 11px;
  margin: 6px 0;
  line-height: 1.5;
}
.ants-select {
  background: #202024;
  color: #eee;
  border: 1px solid #444;
  border-radius: 4px;
  padding: 4px 8px;
  font-size: 12px;
  width: 100%;
  max-width: 320px;
}
.ants-chip-row {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin: 8px 0;
}
.ants-chip {
  background: #26262c;
  border: 1px solid #3a3a42;
  border-radius: 12px;
  padding: 3px 10px;
  font-size: 11px;
  color: #ccc;
  white-space: nowrap;
}
.ants-chip b { color: #f0a020; margin-left: 4px; }
`;

function injectStyle() {
  if (document.getElementById("ants-tracker-style")) return;
  const style = document.createElement("style");
  style.id = "ants-tracker-style";
  style.textContent = STYLE;
  document.head.appendChild(style);
}

function makeDraggable(handle, target) {
  let dragging = false;
  let startX, startY, startRight, startTop;
  handle.addEventListener("mousedown", (e) => {
    if (e.target.closest(".ants-close")) return;
    dragging = true;
    startX = e.clientX;
    startY = e.clientY;
    const rect = target.getBoundingClientRect();
    startRight = window.innerWidth - rect.right;
    startTop = rect.top;
    e.preventDefault();
  });
  window.addEventListener("mousemove", (e) => {
    if (!dragging) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    target.style.right = `${Math.max(0, startRight - dx)}px`;
    target.style.top = `${Math.max(0, startTop + dy)}px`;
  });
  window.addEventListener("mouseup", () => (dragging = false));
}

function buildPanel() {
  if (panelEl) return panelEl;
  injectStyle();

  panelEl = document.createElement("div");
  panelEl.id = "ants-tracker-panel";
  panelEl.innerHTML = `
    <div id="ants-tracker-header">
      <span><b>ANTs</b> Nasty Bastards Tracker</span>
      <span>
        <span class="ants-copy" title="Copy a plain-text snapshot of every tab (for pasting to Claude/a bug report instead of a screenshot)">📋 Copy</span>
        <span class="ants-close" title="Close">✕</span>
      </span>
    </div>
    <div id="ants-tracker-summary"></div>
    <div id="ants-tracker-tabs">
      <button data-tab="timing" class="active">Timing</button>
      <button data-tab="nodes">Nodes</button>
      <button data-tab="load">Load</button>
      <button data-tab="memory">Memory</button>
      <button data-tab="gpu">GPU / VRAM</button>
      <button data-tab="testing">Testing</button>
    </div>
    <div id="ants-tracker-body"></div>
  `;
  document.body.appendChild(panelEl);

  panelEl.querySelector(".ants-close").addEventListener("click", () => togglePanel(false));
  panelEl.querySelector(".ants-copy").addEventListener("click", (e) => copyTelemetryReport(e.currentTarget));
  makeDraggable(panelEl.querySelector("#ants-tracker-header"), panelEl);

  panelEl.querySelectorAll("#ants-tracker-tabs button").forEach((btn) => {
    btn.addEventListener("click", () => {
      activeTab = btn.dataset.tab;
      panelEl.querySelectorAll("#ants-tracker-tabs button").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      renderBody();
    });
  });

  return panelEl;
}

const CORNER_POS_KEY = "ants-tracker-corner-pos";
const LONG_PRESS_MS = 280;

function loadCornerPos() {
  try {
    const raw = localStorage.getItem(CORNER_POS_KEY);
    if (!raw) return null;
    const pos = JSON.parse(raw);
    if (typeof pos.top === "number" && typeof pos.left === "number") return pos;
  } catch (e) {
    // ignore — falls back to default CSS bottom-right position
  }
  return null;
}

function saveCornerPos(top, left) {
  try {
    localStorage.setItem(CORNER_POS_KEY, JSON.stringify({ top, left }));
  } catch (e) {
    // storage unavailable/full — position just won't persist, non-fatal
  }
}

// Quick click opens/closes the panel. Press-and-hold past LONG_PRESS_MS
// switches to drag mode instead, so you can park this wherever it
// doesn't collide with ComfyUI's own minimap/queue UI — including up
// near the top bar, since this is a free-floating fixed-position
// element and "dock" here just means "drag it up there and let go."
function wireCornerButton(el) {
  let pressTimer = null;
  let dragging = false;
  let movedDuringDrag = false;
  let suppressNextClick = false;
  let startX, startY, startTop, startLeft;

  el.addEventListener("mousedown", (e) => {
    dragging = false;
    movedDuringDrag = false;
    startX = e.clientX;
    startY = e.clientY;
    const rect = el.getBoundingClientRect();
    startTop = rect.top;
    startLeft = rect.left;
    clearTimeout(pressTimer);
    pressTimer = setTimeout(() => {
      dragging = true;
      el.style.cursor = "grabbing";
      el.style.opacity = "0.85";
    }, LONG_PRESS_MS);
    e.preventDefault();
  });

  window.addEventListener("mousemove", (e) => {
    if (!dragging) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) movedDuringDrag = true;
    const newTop = Math.max(0, Math.min(window.innerHeight - el.offsetHeight, startTop + dy));
    const newLeft = Math.max(0, Math.min(window.innerWidth - el.offsetWidth, startLeft + dx));
    el.style.top = `${newTop}px`;
    el.style.left = `${newLeft}px`;
    el.style.bottom = "auto";
    el.style.right = "auto";
  });

  window.addEventListener("mouseup", () => {
    clearTimeout(pressTimer);
    if (dragging) {
      dragging = false;
      el.style.cursor = "pointer";
      el.style.opacity = "1";
      if (movedDuringDrag) {
        suppressNextClick = true; // this drag's release shouldn't also toggle the panel
        const rect = el.getBoundingClientRect();
        saveCornerPos(rect.top, rect.left);
      }
    }
  });

  el.addEventListener("click", () => {
    if (suppressNextClick) {
      suppressNextClick = false;
      return;
    }
    togglePanel();
  });
}

function buildCornerButton() {
  if (cornerBtnEl) return cornerBtnEl;
  injectStyle();
  cornerBtnEl = document.createElement("div");
  cornerBtnEl.id = "ants-corner-btn";
  cornerBtnEl.title = "ANTs Nasty Bastards Tracker — click to open, press-and-hold to move";
  cornerBtnEl.textContent = "🔧";
  const savedPos = loadCornerPos();
  if (savedPos) {
    cornerBtnEl.style.top = `${savedPos.top}px`;
    cornerBtnEl.style.left = `${savedPos.left}px`;
    cornerBtnEl.style.bottom = "auto";
    cornerBtnEl.style.right = "auto";
  }
  wireCornerButton(cornerBtnEl);
  document.body.appendChild(cornerBtnEl);
  return cornerBtnEl;
}

function togglePanel(force) {
  buildPanel();
  const shouldOpen = force !== undefined ? force : !panelEl.classList.contains("open");
  panelEl.classList.toggle("open", shouldOpen);
  if (shouldOpen) {
    startRefresh();
  } else {
    stopRefresh();
  }
}

function startRefresh() {
  stopRefresh();
  renderBody();
  refreshTimer = setInterval(() => renderBody(true), 500);
}

function stopRefresh() {
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = null;
}

function toggleMute(extLabelStr) {
  if (mutedExtensions.has(extLabelStr)) {
    mutedExtensions.delete(extLabelStr);
  } else {
    mutedExtensions.add(extLabelStr);
  }
  renderBody();
}

function renderSummary() {
  const s = frameSummary();
  const el = panelEl.querySelector("#ants-tracker-summary");
  el.innerHTML = `
    <span>fps <b>${s.fps ? s.fps.toFixed(0) : "-"}</b></span>
    <span>frame <b>${fmtMs(s.avgTotalMs)}ms</b></span>
    <span>attributed <b>${fmtMs(s.avgAttributedMs)}ms</b></span>
    <span>unattributed <b>${fmtMs(s.avgUnattributedMs)}ms</b></span>
  `;
}

// Group wrapped-hook identities by extension namespace (the part before
// the first dot, e.g. "Pixaroma" from "Pixaroma.AIPrompt::onDrawForeground")
// so 200+ individual hooks collapse into a scannable handful of counts
// instead of one giant run-on list.
function summarizeWrappedHooks() {
  const counts = new Map();
  for (const key of everWrappedHooks) {
    const ext = key.split("::")[0];
    const ns = ext.split(".")[0] || ext;
    counts.set(ns, (counts.get(ns) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]);
}

function renderTimingTab() {
  const totals = perExtensionTotals();
  const rows = [...totals.entries()].sort((a, b) => b[1].recentMs - a[1].recentMs);

  let html = `
    <table class="ants-table">
      <thead><tr>
        <th>Extension</th><th>ms / ${(ROLLING_WINDOW_MS / 1000).toFixed(0)}s</th>
        <th>avg ms/call</th><th>calls</th><th></th>
      </tr></thead>
      <tbody>
  `;

  if (!rows.length) {
    if (totalHooksWrapped === 0) {
      html += `<tr><td colspan="5" style="color:#666;">No extension in this session overrides onDrawForeground/onDrawBackground/onDrawCollapsed/onBounding directly (0 hooks wrapped) — check the Nodes tab instead, since a heavy node's cost may be inside LiteGraph's own per-type draw, a custom widget's own draw(), or a centralized redraw heartbeat rather than a per-node hook.</td></tr>`;
    } else {
      const groups = summarizeWrappedHooks();
      const chips = groups
        .map(([ns, count]) => `<span class="ants-chip">${escapeHtml(ns)} <b>${count}</b></span>`)
        .join("");
      html += `
        <tr><td colspan="5">
          <p class="ants-note" style="margin-top:0;">
            ${totalHooksWrapped} hook(s) wrapped this session across ${groups.length} extension(s),
            but none have fired in the last ${(ROLLING_WINDOW_MS / 1000).toFixed(0)}s — pan the graph,
            or check whether whatever used to call these was refactored to draw some other way
            (e.g. a widget's own <code>draw()</code>, or a centralized heartbeat — see the Nodes tab).
          </p>
          <div class="ants-chip-row">${chips}</div>
          <p class="ants-note">Full per-hook names are in the 📋 Copy report, not repeated here.</p>
        </td></tr>
      `;
    }
  }

  for (const [ext, data] of rows) {
    const avgMs = data.calls ? data.recentMs / data.calls : 0;
    const hotClass = data.recentMs > 200 ? "ants-hot" : data.recentMs > 50 ? "ants-warm" : "";
    const muted = mutedExtensions.has(ext);
    html += `
      <tr class="${muted ? "ants-muted" : ""} ${hotClass}">
        <td>${escapeHtml(ext)}</td>
        <td class="ants-ms">${fmtMs(data.recentMs)}</td>
        <td>${fmtMs(avgMs)}</td>
        <td>${data.calls}</td>
        <td><button class="ants-mute-btn ${muted ? "active" : ""}" data-ext="${escapeAttr(ext)}">
          ${muted ? "Unmute" : "Mute"}
        </button></td>
      </tr>
    `;
  }

  html += `</tbody></table>
    <p class="ants-note">
      "Mute" fully skips that extension's draw hooks (onDrawForeground / onDrawBackground /
      onDrawCollapsed / onBounding) so you can see the FPS gain of removing it, live,
      without restarting ComfyUI. "Unattributed" in the summary bar above is canvas
      draw-time not accounted for by any tracked hook — usually an extension that
      patches LiteGraph's prototypes directly instead of using beforeRegisterNodeDef.
    </p>
  `;

  const body = panelEl.querySelector("#ants-tracker-body");
  body.innerHTML = html;
  body.querySelectorAll(".ants-mute-btn").forEach((btn) => {
    btn.addEventListener("click", () => toggleMute(btn.dataset.ext));
  });
}

function renderNodesTab() {
  const rows = nodeDrawTotals();
  const frames = frameSummary().frames;
  const tick = updateTickBanner(rows);

  let html = "";
  if (tick) {
    html += `
      <div class="ants-note" style="background:#2a2410; border:1px solid #5a4a1a; border-radius:6px; padding:8px 10px; margin-bottom:8px;">
        <b style="color:#f0a020;">Shared tick detected:</b> ${tick.matching}/${tick.total} node types have
        call counts that are exact multiples of <b>${tick.unit}</b> in this window — consistent with
        one graph-wide redraw happening roughly every <b>${tick.intervalMs.toFixed(0)}ms</b>
        (≈${(1000 / tick.intervalMs).toFixed(1)}/sec), not each type running its own independent timer.
        A type's count here is just (visible instances) × ${tick.unit}. Look for one periodic
        <code>setInterval</code>/heartbeat elsewhere (a status or telemetry refresh is the usual
        suspect) that calls a <i>global</i> canvas invalidate on every tick instead of scoping the
        redraw to just the node whose value actually changed — that's usually the fixable part,
        not the individual node types listed below.
      </div>
    `;
  }

  html += `
    <table class="ants-table">
      <thead><tr>
        <th>Node type</th><th>ms / ${(ROLLING_WINDOW_MS / 1000).toFixed(0)}s</th>
        <th>calls</th><th>calls/frame</th>
      </tr></thead>
      <tbody>
  `;
  if (!rows.length) {
    html += `<tr><td colspan="4" style="color:#666;">No node-render activity recorded yet — pan the graph a bit.</td></tr>`;
  }
  for (const r of rows.slice(0, 40)) {
    const hotClass = r.ms > 200 ? "ants-hot" : r.ms > 50 ? "ants-warm" : "";
    const perFrame = frames > 0 ? r.calls / frames : 0;
    // Only flag as its OWN independent timer if it does NOT fit the
    // shared-tick pattern above (i.e. not an exact multiple of the
    // detected unit) — otherwise it's just one more instance riding the
    // same graph-wide clock, not a rogue loop of its own.
    const fitsSharedTick = tick && r.calls % tick.unit === 0;
    const offPaint = !fitsSharedTick && (frames === 0 ? r.calls > 0 : perFrame < 0.3 && r.calls >= 5);
    html += `
      <tr class="${hotClass}">
        <td>${escapeHtml(r.type)}${offPaint ? ' <span title="Call rate doesn\'t track frame count and doesn\'t fit the shared tick above — likely its own independent timer/interval." style="color:#f0a020;">⏱</span>' : ""}</td>
        <td class="ants-ms">${fmtMs(r.ms)}</td>
        <td>${r.calls}</td>
        <td>${frames > 0 ? perFrame.toFixed(2) : "-"}</td>
      </tr>
    `;
  }
  html += `</tbody></table>
    <p class="ants-note">
      This times LiteGraph's own per-node draw call in full — borders, title bar,
      slots, widgets, and any embedded preview bitmap — for every node TYPE on
      screen. It <b>includes</b> whatever the Timing tab already reports for that
      node's own extension hooks as a subset, so don't add the two tabs together.
      This is usually where most of "unattributed" time in the summary bar actually
      lives: it's rarely a rogue extension, it's LiteGraph's own chrome-drawing cost
      multiplied by however many nodes of that type are on screen. A type sitting
      at the top here with an image-preview widget is worth checking first —
      <b>calls/frame</b> should land near a small whole number (once or so per
      visible instance, per repaint) if a type is purely paint-driven. A ⏱ marks a
      type whose call rate doesn't track the frame count at all — that's the
      signature of a <code>setInterval</code>/<code>setTimeout</code>-style refresh
      loop running on its own clock rather than a draw hook, and its actual firing
      rate can be sensitive to system-wide timer resolution settings if you've
      changed those (e.g. via ISLC/GlobalTimerResolutionRequests) — freezing the
      canvas entirely (no pan/zoom) and watching whether its count keeps climbing
      confirms it either way.
    </p>
  `;
  panelEl.querySelector("#ants-tracker-body").innerHTML = html;
}

function renderLoadTab() {
  const byPack = resourceLoadSummary();
  const rows = [...byPack.entries()].sort((a, b) => b[1].bytes - a[1].bytes);
  let html = `
    <table class="ants-table">
      <thead><tr><th>Extension pack</th><th>Size</th><th>Load time</th><th>Files</th></tr></thead>
      <tbody>
  `;
  if (!rows.length) {
    html += `<tr><td colspan="4" style="color:#666;">No /extensions/ resources recorded (or the browser cleared its Resource Timing buffer).</td></tr>`;
  }
  for (const [pack, data] of rows) {
    html += `
      <tr>
        <td>${escapeHtml(pack)}</td>
        <td>${fmtBytes(data.bytes)}</td>
        <td>${fmtMs(data.ms)}ms</td>
        <td>${data.count}</td>
      </tr>
    `;
  }
  html += `</tbody></table>
    <p class="ants-note">
      This is startup/page-load cost (JS + assets fetched), independent of the Timing
      tab's runtime draw cost. A pack can be heavy to load but cheap to run, or the
      reverse — check both before blaming one number.
    </p>
  `;
  panelEl.querySelector("#ants-tracker-body").innerHTML = html;
}

let memBaseline = null;

function renderMemoryTab() {
  const mem = performance.memory; // Chromium-only, non-standard
  const body = panelEl.querySelector("#ants-tracker-body");

  if (!mem) {
    body.innerHTML = `
      <p class="ants-note">
        performance.memory isn't available in this browser (it's a Chromium-only,
        non-standard API — Firefox doesn't expose it to page JS at all). No JS heap
        readout is possible here on this browser.
      </p>
    `;
    return;
  }

  body.innerHTML = `
    <table class="ants-table">
      <tbody>
        <tr><td>JS heap used</td><td>${fmtBytes(mem.usedJSHeapSize)}</td></tr>
        <tr><td>JS heap total</td><td>${fmtBytes(mem.totalJSHeapSize)}</td></tr>
        <tr><td>JS heap limit</td><td>${fmtBytes(mem.jsHeapSizeLimit)}</td></tr>
        ${memBaseline !== null ? `<tr><td>Since baseline</td><td>${fmtBytes(mem.usedJSHeapSize - memBaseline)}</td></tr>` : ""}
      </tbody>
    </table>
    <p class="ants-note">
      There's no per-extension heap breakdown possible from page JS — the browser
      doesn't expose that. To bisect a memory hog: click "Set baseline" below, mute
      a suspect extension in the Timing tab, wait a bit, then check the delta here.
    </p>
    <button class="ants-mute-btn" id="ants-mem-baseline">Set baseline</button>
  `;
  body.querySelector("#ants-mem-baseline").addEventListener("click", () => {
    memBaseline = performance.memory.usedJSHeapSize;
    renderMemoryTab();
  });
}

function renderGpuTab() {
  panelEl.querySelector("#ants-tracker-body").innerHTML = `
    <p class="ants-note">
      Per-extension GPU/VRAM usage cannot be read from page JavaScript at all —
      no web API exposes it, in any browser, for privacy/security reasons.
      This isn't a missing feature here; it's a hard sandbox boundary.
      <br><br>
      For a rough, correlated (not attributed) view: run a small script alongside
      ComfyUI that polls <code>nvidia-smi --query-gpu=memory.used --format=csv -l 1</code>
      into a log with timestamps, then eyeball it against a mute/unmute test done here
      in the Timing tab at a known time. That tells you "VRAM jumped when I toggled
      this extension," which is the closest honest answer this can give you.
    </p>
  `;
}

const THROTTLE_PRESETS = [
  { label: "Off (normal browser/ComfyUI behavior)", ms: 0 },
  { label: "0.5ms (matches your OS timer tweak — no real display can hit this; functionally the same as Off)", ms: 0.5 },
  { label: "60 fps cap (~16ms)", ms: 16 },
  { label: "30 fps cap (~33ms)", ms: 33 },
  { label: "15 fps cap (~66ms)", ms: 66 },
  { label: "10 fps cap (100ms)", ms: 100 },
  { label: "5 fps cap (200ms)", ms: 200 },
  { label: "2 fps cap (500ms) — loose", ms: 500 },
  { label: "1 fps cap (1000ms) — very loose", ms: 1000 },
  { label: "1 redraw / 2s — super loose", ms: 2000 },
  { label: "1 redraw / 3s", ms: 3000 },
  { label: "1 redraw / 5s", ms: 5000 },
  { label: "1 redraw / 10s — extreme", ms: 10000 },
];

const SYNTH_TICK_PRESETS = [
  { label: "Off", ms: 0 },
  { label: "1 redraw / 10s — extreme loose", ms: 10000 },
  { label: "1 redraw / 5s", ms: 5000 },
  { label: "1 redraw / 3s", ms: 3000 },
  { label: "1 redraw / 2s — super loose", ms: 2000 },
  { label: "Loose — every 1000ms (~1/sec)", ms: 1000 },
  { label: "every 500ms (~2/sec)", ms: 500 },
  { label: "every 250ms (~4/sec)", ms: 250 },
  { label: "every 100ms (~10/sec)", ms: 100 },
  { label: "Fast — every 50ms (~20/sec)", ms: 50 },
  { label: "Extreme — every 16ms (~60/sec)", ms: 16 },
  { label: "0.5ms — matches your OS timer tweak (see note below)", ms: 0.5 },
];

function renderTestingTab() {
  const body = panelEl.querySelector("#ants-tracker-body");
  body.innerHTML = `
    <p class="ants-note" style="color:#f0a020;">
      <b>Testing overrides — off by default, deliberately invasive.</b> These change
      how often the canvas actually redraws, for calibration and stress-testing.
      Neither persists across a page reload. Leave both on their default for normal use.
    </p>
    <p class="ants-note">
      <b>Testing tip:</b> let the graph sit completely untouched for a few full
      seconds before reading a result or hitting Copy. A slow cap naturally forces
      that wait on you; a fast cap doesn't — so comparing a just-touched fast-cap
      reading against a settled slow-cap one will look like the cap did something
      it didn't. Same interaction state, every time, is what makes the presets
      comparable to each other.
    </p>

    <div style="margin-bottom:16px;">
      <label style="display:block; margin-bottom:4px; color:#ccc;">Canvas redraw rate cap</label>
      <select id="ants-throttle-select" class="ants-select">
        ${THROTTLE_PRESETS.map(
          (p) => `<option value="${p.ms}" ${p.ms === drawThrottleMs ? "selected" : ""}>${p.label}</option>`
        ).join("")}
      </select>
      <p class="ants-note">
        Skips any real redraw that arrives sooner than this interval after the last
        one — the canvas simply won't repaint more often than the cap, regardless of
        what's asking for it (panning, ComfyUI's own tick, the generator below). The
        <b>fps</b> number in the summary bar should drop to roughly match whatever
        cap you pick — that's confirmation it's working, not a bug. This is also a
        genuine mitigation, not just a diagnostic: if a heavy graph feels fine at,
        say, a 15fps cap, that's a real, low-risk way to cut redraw cost on huge
        workflows without touching any node's own code. The 0.5ms option is included
        for symmetry with your system-wide timer tweak, but it's a floor no real
        display can exceed anyway — expect it to behave identically to Off.
      </p>
    </div>

    <div>
      <label style="display:block; margin-bottom:4px; color:#ccc;">Synthetic forced-tick generator</label>
      <select id="ants-synth-select" class="ants-select">
        ${SYNTH_TICK_PRESETS.map(
          (p) => `<option value="${p.ms}" ${p.ms === syntheticTickMs ? "selected" : ""}>${p.label}</option>`
        ).join("")}
      </select>
      <p class="ants-note">
        Forces an extra full redraw at exactly this interval, independent of
        anything else in the page — a known, controlled tick to compare against
        whatever organic pattern the Nodes tab's shared-tick detector finds (use
        this to sanity-check the detector, or to see how cost scales linearly with
        tick rate in isolation). This goes through the <i>same</i> redraw path as
        the cap above, so an active cap will also throttle these forced ticks —
        set the cap to Off first if you want to measure an uncapped synthetic
        tick's true cost. At the very fast end (16ms and especially 0.5ms), JS is
        single-threaded and each full redraw of a graph this size can take tens to
        hundreds of ms on its own — a sub-millisecond interval can't literally fire
        that often, it just means "redraw back-to-back with zero idle gap," capped
        by however fast a real redraw actually completes, not by the number you
        picked. Expect the tab to feel sluggish while this is set that low; that's
        the point of the extreme presets, not a malfunction.
      </p>
    </div>
  `;
  body.querySelector("#ants-throttle-select").addEventListener("change", (e) => {
    drawThrottleMs = Number(e.target.value);
  });
  body.querySelector("#ants-synth-select").addEventListener("change", (e) => {
    setSyntheticTick(Number(e.target.value));
  });
}

// ---------------------------------------------------------------
// Copy-to-clipboard telemetry dump — a plain-text snapshot of every tab
// in one go, so this can be pasted as text instead of a screenshot.
// ---------------------------------------------------------------

function buildTelemetryReport() {
  const lines = [];
  const s = frameSummary();
  lines.push(`ANTs Nasty Bastards Tracker snapshot — ${new Date().toISOString()}`);
  lines.push(
    `fps ${s.fps.toFixed(0)}  frame ${fmtMs(s.avgTotalMs)}ms  attributed ${fmtMs(s.avgAttributedMs)}ms  unattributed ${fmtMs(s.avgUnattributedMs)}ms`
  );
  lines.push(
    `Testing overrides: redraw cap = ${drawThrottleMs > 0 ? drawThrottleMs + "ms" : "off"}, synthetic tick = ${syntheticTickMs > 0 ? syntheticTickMs + "ms" : "off"}`
  );
  lines.push(`Hooks wrapped this session: ${totalHooksWrapped}`);
  if (everWrappedHooks.size) {
    lines.push(`Wrapped: ${[...everWrappedHooks].sort().join(", ")}`);
  }

  lines.push("");
  lines.push("-- Timing (extension draw hooks: onDrawForeground/onDrawBackground/onDrawCollapsed/onBounding) --");
  const totals = [...perExtensionTotals().entries()].sort((a, b) => b[1].recentMs - a[1].recentMs);
  if (!totals.length) lines.push("(no draw-hook activity recorded)");
  for (const [ext, data] of totals) {
    const avg = data.calls ? data.recentMs / data.calls : 0;
    lines.push(
      `${ext}\t${fmtMs(data.recentMs)}ms\t${fmtMs(avg)}ms/call\t${data.calls} calls${mutedExtensions.has(ext) ? "\t[MUTED]" : ""}`
    );
  }

  lines.push("");
  lines.push("-- Nodes (per-type drawNode cost, includes any Timing-tab hook cost above as a subset) --");
  if (tickBannerState) {
    lines.push(
      `Shared tick: ${tickBannerState.matching}/${tickBannerState.total} types are exact multiples of ${tickBannerState.unit} (~${tickBannerState.intervalMs.toFixed(0)}ms interval, ~${(1000 / tickBannerState.intervalMs).toFixed(1)}/sec)`
    );
  }
  const rows = nodeDrawTotals();
  const frames = s.frames;
  if (!rows.length) lines.push("(no node-render activity recorded)");
  for (const r of rows) {
    const perFrame = frames > 0 ? r.calls / frames : 0;
    const fitsTick = tickBannerState && r.calls % tickBannerState.unit === 0;
    lines.push(
      `${r.type}\t${fmtMs(r.ms)}ms\t${r.calls} calls\t${perFrame.toFixed(2)}/frame${!fitsTick && tickBannerState ? "\t[does not fit shared tick]" : ""}`
    );
  }

  lines.push("");
  lines.push("-- Load (resource timing per /extensions/ pack) --");
  const byPack = [...resourceLoadSummary().entries()].sort((a, b) => b[1].bytes - a[1].bytes);
  if (!byPack.length) lines.push("(no /extensions/ resource entries found)");
  for (const [pack, data] of byPack) {
    lines.push(`${pack}\t${fmtBytes(data.bytes)}\t${fmtMs(data.ms)}ms\t${data.count} files`);
  }

  lines.push("");
  lines.push("-- Memory --");
  if (performance.memory) {
    const mem = performance.memory;
    lines.push(
      `JS heap used ${fmtBytes(mem.usedJSHeapSize)} / total ${fmtBytes(mem.totalJSHeapSize)} / limit ${fmtBytes(mem.jsHeapSizeLimit)}`
    );
  } else {
    lines.push("(performance.memory unavailable in this browser)");
  }

  return lines.join("\n");
}

async function copyTelemetryReport(buttonEl) {
  const text = buildTelemetryReport();
  const originalLabel = "📋 Copy";
  const showResult = (label) => {
    buttonEl.textContent = label;
    setTimeout(() => {
      buttonEl.textContent = originalLabel;
    }, 1500);
  };
  try {
    await navigator.clipboard.writeText(text);
    showResult("Copied!");
  } catch (e) {
    // Clipboard API can fail (permissions, non-secure context). Fall back
    // to a temporary selected textarea so the user can Ctrl+C manually.
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
      showResult("Copied (fallback)");
    } catch (e2) {
      showResult("Copy failed — see console");
      console.error("[ANTs Tracker] clipboard copy failed:", e, e2);
    }
  }
}

function renderBody(isPeriodic) {
  if (!panelEl || !panelEl.classList.contains("open")) return;
  renderSummary();
  if (activeTab === "timing") renderTimingTab();
  else if (activeTab === "nodes") renderNodesTab();
  else if (activeTab === "load") renderLoadTab();
  else if (activeTab === "memory") renderMemoryTab();
  else if (activeTab === "gpu") renderGpuTab();
  else if (activeTab === "testing") {
    // Nothing here changes except via direct user interaction with the
    // selects — rebuilding on the periodic tick would blow away an
    // open dropdown mid-click. Only (re)render on an explicit switch.
    if (!isPeriodic) renderTestingTab();
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}
function escapeAttr(s) {
  return escapeHtml(s).replace(/`/g, "&#96;");
}

// ---------------------------------------------------------------
// Register our own extension: sets up the canvas-draw patch once the
// app is ready, and gives the tracker node its button widget.
// ---------------------------------------------------------------

app.registerExtension({
  name: EXT_NAME,

  async setup() {
    patchCanvasDrawOnce();
    buildCornerButton();
  },

  // Fires on a fresh workflow load (not guaranteed for every kind of tab
  // switch between already-open graphs — the periodic sweep above is the
  // fallback for that case). When it does fire, clear immediately rather
  // than waiting out the rolling window.
  afterConfigureGraph() {
    resetAllStats();
  },

  beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== NODE_NAME) return;
    const onNodeCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const ret = onNodeCreated ? onNodeCreated.apply(this, arguments) : undefined;
      this.addWidget("button", "Open Tracker", null, () => togglePanel());
      return ret;
    };
  },
});
