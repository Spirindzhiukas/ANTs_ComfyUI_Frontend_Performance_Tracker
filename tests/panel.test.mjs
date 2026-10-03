// Panel behaviour tests: the UI half of the rewrite. These cover the v1
// complaints directly — innerHTML rebuilding that reset scroll, rows that
// reordered under the pointer, a Testing tab whose dropdown was destroyed
// every 500ms, and an empty panel that could not explain itself.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHarness, FRAME_MS } from "./harness.mjs";
import { suite, test, assert, assertEqual, assertGreater, assertLess, assertIncludes } from "./framework.mjs";

async function boot() {
  const h = createHarness();
  for (const ext of h.app.extensions) if (ext.setup) await ext.setup();
  await h.flush();
  return h;
}

function findAll(h, pred) {
  return h.document.body.descendants().filter(pred);
}
function byId(h, id) {
  return h.document.getElementById(id);
}
function byClass(h, cls) {
  return findAll(h, (n) => n._cls && n._cls.has(cls));
}
// Rows of the <tbody> of the n-th .ants-table inside a tab (the Nodes and
// Testing tabs have several tables, so the index matters).
function tableRows(h, tab, which = 0) {
  const body = byId(h, "ants-tracker-body");
  const idx = tabIndexOf(h, tab);
  const tables = body.children[idx].descendants().filter((n) => n.tagName === "TABLE" && n._cls && n._cls.has("ants-table"));
  const table = tables[which];
  if (!table) return [];
  return table.children
    .find((c) => c.tagName === "TBODY")
    .children.filter((tr) => (tr._cls ? !tr._cls.has("ants-details") : true))
    .map((tr) => tr.children.map((cell) => cell.textContent));
}

function headersOf(h, tab, which = 0) {
  const body = byId(h, "ants-tracker-body");
  const idx = tabIndexOf(h, tab);
  const tables = body.children[idx].descendants().filter((n) => n.tagName === "TABLE" && n._cls && n._cls.has("ants-table"));
  const thead = tables[which].children.find((c) => c.tagName === "THEAD");
  return thead.children[0].children;
}

// Click a header by its label; the active column carries a ▲/▼ in its text.
function clickHeader(h, tab, label, which = 0) {
  const th = headersOf(h, tab, which).find((x) => x.textContent.replace(/[▲▼]/g, "").trim() === label);
  assert(th, `header "${label}" exists on the ${tab} tab (table ${which})`);
  th.click();
}

// Owners with costs chosen so that "most expensive per frame" and "alphabetical"
// are different orders — otherwise a sort test can pass with sorting broken.
//   ZetaPack:  1 instance  x 9ms  = 9ms/frame, 9.0ms/call
//   AlphaPack: 10 instances x 0.6ms = 6ms/frame, 0.6ms/call
async function ownerFixture(h, owners) {
  const list = owners || [
    { pack: "ZetaPack", type: "ZetaNode", cost: 9, count: 1 },
    { pack: "AlphaPack", type: "AlphaNode", cost: 0.6, count: 10 },
  ];
  const nodes = [];
  for (const o of list) {
    await h.registerExtension(o.pack, {
      beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== o.type) return;
        nodeType.prototype.onDrawForeground = function () {
          h.busy(o.cost);
        };
      },
    });
    const Type = h.registerNodeType(o.type);
    for (let i = 0; i < (o.count || 1); i++) nodes.push(h.makeNode(Type));
  }
  h.canvas.nodes = nodes;
  return list;
}

async function openTab(h, tab) {
  h.tracker.open();
  clickTab(h, tab);
  h.advance(600);
  await h.flush();
  await new Promise((r) => setImmediate(r));
}

function rowOf(h, name) {
  return h.tracker.governor.sources.find((r) => r.name === name || r.label.includes(name));
}

function tabButtons(h) {
  const bar = byId(h, "ants-tracker-tabs");
  return bar ? bar.children.filter((c) => c.tagName === "BUTTON") : [];
}
function clickTab(h, name) {
  // By label, not by index: the tab row changes, and a test that silently clicks
  // the wrong tab is worse than one that fails.
  const want = { tweaks: "tweaks", timing: "timing", nodes: "nodes", stalls: "stalls", governor: "governor", load: "load", memory: "memory", gpu: "gpu", testing: "testing" }[name] || name;
  const btn = tabButtons(h).find((b) => String(b.textContent).toLowerCase().includes(want));
  if (!btn) throw new Error(`no tab labelled ${name} in the panel`);
  btn.click();
}

function tabIndexOf(h, tab) {
  const want = { tweaks: "tweaks", timing: "timing", nodes: "nodes", stalls: "stalls", governor: "governor", load: "load", memory: "memory", gpu: "gpu", testing: "testing" }[tab] || tab;
  return tabButtons(h).findIndex((b) => String(b.textContent).toLowerCase().includes(want));
}
function drawLoop(h, seconds, intervalMs = FRAME_MS) {
  const steps = Math.max(1, Math.round((seconds * 1000) / intervalMs));
  for (let i = 0; i < steps; i++) {
    h.advance(intervalMs);
    h.canvas.draw();
  }
}

async function withExtension(h, name, costRef, typeName) {
  await h.registerExtension(name, {
    beforeRegisterNodeDef(nodeType) {
      nodeType.prototype.onDrawForeground = function () {
        h.busy(costRef.ms);
      };
    },
  });
  const NodeType = h.registerNodeType(typeName);
  return h.makeNode(NodeType);
}

suite("panel", () => {
  test("opens from the corner button and closes again", async () => {
    const h = await boot();
    const corner = byId(h, "ants-corner-btn");
    assert(corner, "corner button exists after setup");
    corner.click();
    assert(byId(h, "ants-tracker-panel")._cls.has("open"), "panel opens");
    corner.click();
    assert(!byId(h, "ants-tracker-panel")._cls.has("open"), "panel closes");
  });

  test("every tab renders without an exception and has content", async () => {
    const h = await boot();
    const cost = { ms: 0.5 };
    h.canvas.nodes = [await withExtension(h, "SomePack", cost, "SomeNode")];
    h.addResource("/extensions/SomePack/js/a.js", { startTime: 0, duration: 12 });
    h.fetchRoutes.set("/system_stats", {
      devices: [{ name: "NVIDIA GeForce RTX 4090", type: "cuda", vram_total: 24e9, vram_free: 6e9, torch_vram_total: 18e9, torch_vram_free: 5e9 }],
    });
    h.fetchRoutes.set("/ants_tracker/gpu", { available: true, gpus: [{ name: "RTX 4090", utilization_gpu: 12, memory_used: 18000, memory_total: 24564 }], processes: [] });

    h.tracker.open();
    drawLoop(h, 1);
    h.advance(600); // let a refresh tick land

    for (const name of ["status", "timing", "nodes", "stalls", "governor", "load", "memory", "gpu", "testing"]) {
      clickTab(h, name);
      h.advance(600);
      const container = byId(h, "ants-tracker-body").children.find((c) => c._cls.has("active"));
      assert(container, `tab ${name} has an active container`);
      assertGreater(container.textContent.length, 0, `tab ${name} renders text`);
    }
    assertEqual(h.errors().length, 0, `no render errors: ${h.errors().join(" | ")}`);
  });

  test("Timing tab names the extension with a per-frame cost", async () => {
    const h = await boot();
    const cost = { ms: 0.8 };
    h.canvas.nodes = [await withExtension(h, "HeavyPack", cost, "HeavyNode")];
    h.tracker.open();
    clickTab(h, "timing");
    drawLoop(h, 1);
    h.advance(600);
    const text = byId(h, "ants-tracker-body").textContent;
    assertIncludes(text, "HeavyPack", "extension named");
    assertIncludes(text, "ms/frame", "column header explains the unit");
    assertIncludes(text, "Mute", "mute control present");
    assertIncludes(text, "hook(s) wrapped", "context line states what is instrumented");
  });

  test("nags about redundant redraws when drawing more than once per frame", async () => {
    const h = await boot();
    h.canvas.costs = { background: 0, connections: 0, chrome: 0 }; // isolate cadence from simulated work
    h.tracker.open();
    // Two draws per rAF frame: the classic "something is forcing a second paint".
    for (let i = 0; i < 120; i++) {
      h.advance(FRAME_MS);
      h.canvas.draw();
      h.canvas.draw();
    }
    h.advance(600);
    const text = h.document.body.textContent;
    assertIncludes(text, "redraws", "draws-per-frame metric is shown");
    assertGreater(h.tracker.snapshot.frame.drawsPerRaf, 1.5, "harness should look like it double-draws");
  });

  test("refresh does not rebuild rows, lose scroll position, or move rows under the pointer", async () => {
    const h = await boot();
    const cheap = { ms: 0.2 };
    const pricey = { ms: 1.6 };
    h.canvas.nodes = [await withExtension(h, "CheapPack", cheap, "CheapNode"), await withExtension(h, "PriceyPack", pricey, "PriceyNode")];
    h.tracker.open();
    clickTab(h, "timing");
    drawLoop(h, 1);
    h.advance(600);

    const body = byId(h, "ants-tracker-body");
    const timingTable = byClass(h, "ants-table")[0];
    const tbody = timingTable.children[1];
    const priceyRow = tbody.children[0];
    assertIncludes(priceyRow.textContent, "PriceyPack", "expensive owner sorts first");
    assertEqual(tbody.children.length, 4, "two owners x (main row + collapsed details row)");
    body.scrollTop = 120;

    // Pointer inside the list: order must freeze even as values keep updating.
    body._fire("mouseenter", {});
    h.advance(2000);
    assertEqual(tbody.children[0], priceyRow, "the row under the pointer must not move");
    assertEqual(body.scrollTop, 120, "scroll position survives a refresh");

    // Swap the costs, let the rolling window refill, then let the pointer leave:
    // the order may change but the row objects must not.
    pricey.ms = 0.1;
    cheap.ms = 2.0;
    drawLoop(h, 5);
    body._fire("mouseleave", {});
    h.advance(600);
    assertEqual(tbody.children.length, 4, "still two owners");
    assert(tbody.children.includes(priceyRow), "the old row object survived the reorder (rows are updated, never rebuilt)");
    assertIncludes(tbody.children[0].textContent, "CheapPack", "after the pointer leaves, order follows cost again");
  });

  test("Testing tab keeps its <select> elements across refreshes", async () => {
    const h = await boot();
    h.tracker.open();
    clickTab(h, "testing");
    h.advance(100);
    const testing = byId(h, "ants-tracker-body").children.find((c) => c._cls.has("active"));
    const selectsBefore = testing.descendants().filter((n) => n.tagName === "SELECT");
    assertEqual(selectsBefore.length, 3, "cap + synthetic tick + benchmark duration selects");
    h.advance(2000); // four refresh ticks
    const testingAfter = byId(h, "ants-tracker-body").children.find((c) => c._cls.has("active"));
    const selectsAfter = testingAfter.descendants().filter((n) => n.tagName === "SELECT");
    assertEqual(selectsAfter.length, 3, "still three selects");
    assertEqual(selectsAfter[0], selectsBefore[0], "the cap dropdown must be the same element (v1 rebuilt the tab and closed it mid-click)");
    assertEqual(selectsAfter[1], selectsBefore[1], "same for the tick dropdown");
    assertEqual(selectsAfter[2], selectsBefore[2], "same for the benchmark duration dropdown");
  });

  test("empty Timing tab explains itself instead of showing nothing", async () => {
    const h = await boot();
    h.tracker.open();
    clickTab(h, "timing");
    h.advance(600);
    const text = byId(h, "ants-tracker-body").textContent;
    assertIncludes(text, "No draw hooks were found", "says what it does not know, and where to look instead");
    assertIncludes(text, "Stalls", "points at the lane that would catch non-canvas cost");
  });

  test("Copy button produces the text report in the clipboard", async () => {
    const h = await boot();
    h.canvas.nodes = [];
    drawLoop(h, 0.5);
    h.tracker.open();
    h.advance(300);
    const copyBtn = byClass(h, "ants-hbtn").find((n) => n.textContent.includes("Copy"));
    assert(copyBtn, "copy button exists");
    copyBtn.click();
    await h.flush();
    assertGreater(h.clipboardWrites.length, 0, "clipboard received the report");
    assertIncludes(h.clipboardWrites[0], "-- FRAME --", "and it is the full report");
  });

  test("pause from the header freezes the numbers and marks the panel", async () => {
    const h = await boot();
    h.tracker.open();
    clickTab(h, "timing");
    drawLoop(h, 0.5);
    const frames = h.tracker.snapshot.frame.n;
    const pauseBtn = byClass(h, "ants-hbtn").find((n) => n.textContent.includes("Pause"));
    pauseBtn.click();
    h.advance(600);
    drawLoop(h, 0.5);
    assertEqual(h.tracker.snapshot.frame.n, frames, "numbers frozen");
    assertIncludes(byId(h, "ants-tracker-body").textContent, "PAUSED", "panel says why nothing is moving");
  });

  test("GPU tab uses /system_stats and survives a missing nvidia-smi route", async () => {
    const h = await boot();
    h.fetchRoutes.set("/system_stats", {
      devices: [{ name: "NVIDIA GeForce RTX 3060", type: "cuda", vram_total: 12e9, vram_free: 3e9, torch_vram_total: 8e9, torch_vram_free: 3e9 }],
    });
    h.tracker.open();
    clickTab(h, "gpu");
    await h.flush();
    h.advance(300);
    const text = byId(h, "ants-tracker-body").textContent;
    assertIncludes(text, "RTX 3060", "device named");
    assertIncludes(text, "Headroom", "honest interpretation of the numbers");
    assertEqual(h.errors().length, 0, "a 404 on the optional route must not be an error");
  });

  test("GPU tab reads /system_stats the way ComfyUI defines it", async () => {
    // Real payload shape and magnitudes (from ComfyUI OOM reports): on a 12.9GB
    // card torch_vram_total is torch's RESERVED pool (1.17GB), not the device
    // total, and torch_vram_free (0.19GB) is the unused part of that pool. So
    // "allocated" = total - free, and it must never be rendered as the total.
    const h = await boot();
    h.fetchRoutes.set("/system_stats", {
      devices: [
        {
          name: "cuda:0 NVIDIA GeForce RTX 2060",
          type: "cuda",
          vram_total: 12884443136,
          vram_free: 10727621930,
          torch_vram_total: 1174405120,
          torch_vram_free: 192578858,
        },
      ],
    });
    h.tracker.open();
    clickTab(h, "gpu");
    await h.flush();
    h.advance(300);
    const text = byId(h, "ants-tracker-body").textContent;
    assertIncludes(text, "VRAM used", "ComfyUI's own used figure");
    assertIncludes(text, "torch pool", "torch's caching pool is named as a pool");
    assertIncludes(text, "936.3 MB in use", "in use is reserved minus idle, not reserved");
    assert(!text.includes("torch allocated"), "the mislabel that read reserved as allocated is gone");
    assertIncludes(text, "not torch", "the remainder is attributed honestly");
  });

  test("Timing headers sort by every column, with unmeasured rows last", async () => {
    const h = await boot();
    await ownerFixture(h);
    drawLoop(h, 3);
    await openTab(h, "timing");

    const owner = (i) => tableRows(h, "timing")[i][1];
    assert(owner(0).includes("ZetaPack"), "default order is most expensive per drawn frame first");
    assert(owner(1).includes("AlphaPack"), "and the cheaper-per-frame owner is second");

    // ms/call asks a different question, and must produce a different order.
    clickHeader(h, "timing", "ms/call");
    assert(owner(0).includes("ZetaPack"), "sorting by ms/call leads with the 9ms single call");
    clickHeader(h, "timing", "ms/call");
    assert(owner(0).includes("AlphaPack"), "second click reverses the order");
    clickHeader(h, "timing", "ms/call");
    assert(owner(0).includes("ZetaPack"), "third click is back to the default order");

    clickHeader(h, "timing", "Owner");
    assert(owner(0).includes("AlphaPack"), "plain A→Z for a name column");
    clickHeader(h, "timing", "Owner");
    assert(owner(0).includes("ZetaPack"), "reversed A→Z");
    clickHeader(h, "timing", "Owner");
    assert(owner(0).includes("ZetaPack"), "and back to the default order");
  });

  test("sorting by a column nobody measured keeps those rows last", async () => {
    const h = await boot();
    await ownerFixture(h);
    drawLoop(h, 3);
    // Call one owner's wrapped hook outside any redraw: that is off-frame work.
    const ZetaNode = h.LiteGraph.registered_node_types.ZetaNode;
    for (let i = 0; i < 4; i++) ZetaNode.prototype.onDrawForeground.call({});
    h.advance(300);
    await openTab(h, "timing");

    const rows = () => tableRows(h, "timing");
    clickHeader(h, "timing", "off-frame ms");
    assert(rows()[0][1].includes("ZetaPack"), "the only measured off-frame value sorts first");
    assert(rows()[1][6] === "—", "the other row has no off-frame value and is rendered as a dash");
    clickHeader(h, "timing", "off-frame ms");
    assert(rows()[0][1].includes("ZetaPack"), "reversing the sort still keeps the unmeasured row last");
    // 4 off-frame calls at 9ms each must not have been folded into the frame:
    // ms/frame is the one in-frame call per redraw, not 45ms.
    const zRow = rows().find((r) => r[1].includes("ZetaPack"));
    assertLess(Number(zRow[2]), 15, "off-frame time is not counted as part of a frame");
    assertGreater(Number(zRow[6]), 20, "and it is reported in its own column instead");
  });

  test("header clicks reorder rows even though the pointer is inside the panel", async () => {
    const h = await boot();
    await ownerFixture(h);
    drawLoop(h, 3);
    await openTab(h, "timing");
    // Hovering the tab body sets deferReorder, which is what stops rows moving
    // under the pointer during the periodic refresh.
    byId(h, "ants-tracker-body")._fire("mouseenter");
    const before = tableRows(h, "timing")[0][1];
    clickHeader(h, "timing", "Owner");
    const after = tableRows(h, "timing")[0][1];
    assert(after !== before, "an explicit sort click applies immediately");
    assert(after.includes("AlphaPack"), "and the new order is in place");
    h.advance(1000);
    await h.flush();
    assertEqual(tableRows(h, "timing")[0][1], after, "the pointer freeze is restored afterwards");
  });

  test("Stalls table is sortable and reports per-stall cost and share", async () => {
    const h = await boot();
    await openTab(h, "stalls");
    h.advance(4000);
    const loaf = (fn, duration, blocking, layout) => ({
      startTime: h.clock.now - 100,
      duration,
      blockingDuration: blocking,
      scripts: [
        {
          sourceURL: `http://localhost:8188/extensions/${fn}pack/js/${fn}.js`,
          sourceFunctionName: fn,
          invoker: "TimerHandler:setInterval",
          duration: blocking,
          forcedStyleAndLayoutDuration: layout,
        },
      ],
    });
    // Slow and rare vs fast and frequent, so the two orders disagree.
    h.emitPerformance("long-animation-frame", [loaf("rare", 400, 380, 0)]);
    for (let i = 0; i < 8; i++) h.emitPerformance("long-animation-frame", [loaf("often", 90, 70, 40)]);
    h.advance(600);
    await h.flush();

    const rows = () => tableRows(h, "stalls");
    assertGreater(rows().length, 1, "both scripts are listed");
    assert(rows()[0][0].includes("often"), "default order is by total blocking time");
    assertGreater(rows()[0][3], rows()[1][3], "count is a column");
    assert(rows()[0][5].endsWith("%"), "share of all blocking is a column");
    assert(rows()[0][6].endsWith("ms"), "average ms per stall is a column");

    clickHeader(h, "stalls", "ms/stall");
    assert(rows()[0][0].includes("rare"), "one heavy stall sorts first by ms/stall");
    clickHeader(h, "stalls", "forced layout");
    assert(rows()[0][0].includes("often"), "forced-layout sort points at the thrashing script");
    clickHeader(h, "stalls", "forced layout");
    assert(rows()[0][0].includes("often"), "reversing it keeps the measured row first");
    assert(rows()[1][0].includes("rare"), "because the script with no forced layout is unmeasured, not zero");
  });

  test("long tables say how many rows they are hiding, and can show them all", async () => {
    const h = await boot();
    await ownerFixture(h);
    drawLoop(h, 3);
    await openTab(h, "timing");
    const caps = h.sandbox.window.__antsTracker.rowCaps;
    assertEqual(caps.timing, 120, "the cap is exposed so it can be tuned");
    assertEqual(tableRows(h, "timing").length, 2, "two owners fit under the cap");
    caps.timing = 1;
    h.advance(600);
    await h.flush();
    const body = byId(h, "ants-tracker-body");
    const more = body.descendants().find((n) => n._cls && n._cls.has("ants-more"));
    assert(more, "a truncation note exists");
    assert(more.style.display !== "none", "and is visible when rows are hidden");
    assertIncludes(more.textContent, "Showing 1 of 2", "it says how many rows are hidden");
    assertEqual(tableRows(h, "timing").length, 1, "only the capped rows are rendered");
    more.children.find((c) => c.tagName === "BUTTON").click();
    h.advance(600);
    await h.flush();
    assertEqual(tableRows(h, "timing").length, 2, "Show all renders every row again");
    caps.timing = 120;
  });

  test("node types are capped and sortable by per-call cost", async () => {
    const h = await boot();
    // HeavyNode: 2 instances x 6ms = 12ms/frame, 6ms/call.
    // ManyNode:  1 instance  x 3ms =  3ms/frame, 3ms/call.
    await ownerFixture(h, [
      { pack: "HeavyPack", type: "HeavyThing", cost: 6, count: 2 }, // 12ms/frame, 6ms/call
      { pack: "ManyPack", type: "CheapThing", cost: 3, count: 1 }, //  3ms/frame, 3ms/call
    ]);
    drawLoop(h, 3);
    await openTab(h, "nodes");

    const types = () => tableRows(h, "nodes", 1);
    assert(types()[0][0].includes("HeavyThing"), "default order is most expensive per frame first");
    assertGreater(Number(types()[0][4]), 5, "ms/call is reported");
    clickHeader(h, "nodes", "ms/call", 1);
    assert(types()[0][0].includes("HeavyThing"), "sorted by ms/call, the 6ms call still leads");
    clickHeader(h, "nodes", "ms/call", 1);
    assert(types()[0][0].includes("CheapThing"), "reversing puts the cheap call first");
    clickHeader(h, "nodes", "Node type", 1);
    assert(types()[0][0].includes("CheapThing"), "A→Z is available too (CheapThing < HeavyThing)");
  });

  test("the panel slows its own refresh down when a pass costs real time", async () => {
    const h = await boot();
    const interval = h.sandbox.window.__antsTracker.refreshIntervalFor;
    assertEqual(interval(0.4), 500, "cheap pass keeps the normal cadence");
    assertEqual(interval(7), 1000, "half a frame per pass halves the refresh rate");
    assertEqual(interval(30), 2000, "a pass that costs more than a frame backs off further");
    assertEqual(interval(NaN), 500, "unknown cost does not change anything");
    // The refresh is a self-scheduling timeout, so the real risk is the chain
    // dying; a frozen panel would be worse than a slow one.
    h.tracker.open();
    const state = h.sandbox.window.__antsTracker._state;
    const before = state.counters.renderCount;
    h.advance(3000);
    await h.flush();
    assertGreater(state.counters.renderCount - before, 3, "the panel keeps refreshing on its own");
  });

  test("node widget button opens the panel", async () => {
    const h = await boot();
    const ext = h.app.extensions.find((e) => e.name === "ANTs.NastyBastardsTracker.Core");
    // Register the tracker's own node type the way ComfyUI does.
    function TrackerNode() {
      this.widgets = [];
      this.addWidget = (type, label, value, cb) => this.widgets.push({ type, label, value, cb });
    }
    ext.beforeRegisterNodeDef(TrackerNode, { name: "ANTsNastyBastardsTracker" }, h.app);
    const node = new TrackerNode();
    node.onNodeCreated && node.onNodeCreated();
    assertEqual(node.widgets.length, 1, "the tracker node carries exactly one button widget");
    assertEqual(node.widgets[0].label, "Open Tracker");
    node.widgets[0].cb();
    assert(byId(h, "ants-tracker-panel")._cls.has("open"), "widget opens the panel");
  });
});

suite("panel: the Governor tab", () => {
  test("it lists tick sources and can limit one through its own control", async () => {
    const h = await boot();
    h.sandbox.setInterval(function panelPoll() {
      h.busy(2);
    }, 20);
    h.advance(600);
    await openTab(h, "governor");
    const rows = tableRows(h, "governor");
    const poll = rows.find((r) => r[0].includes("panelPoll"));
    assert(poll, `the heartbeat is listed (${JSON.stringify(rows.map((r) => r[0]))})`);
    assertEqual(poll[1], "setInterval", "the kind column says how it is scheduled");
    assertEqual(poll[2], "20.0ms", "the asked-for delay is shown");
    assert(poll[5] !== "—", "its measured ms/s is shown");
    assert(poll[9].startsWith("normal"), "and it starts untouched");

    // The limit control is the point of the tab: pick one and it applies.
    const select = byId(h, "ants-tracker-body")
      .descendants()
      .find((n) => n.tagName === "SELECT" && n.value === "full" && n.children.some((o) => o.value === "hz1"));
    assert(select, "a per-source limit control exists");
    select.value = "hz1";
    select._fire("change", {});
    h.advance(300);
    assertEqual(rowOf(h, "panelPoll").policy, "hz1", "the policy is applied to the real source");
    // The <select> itself is the readout: its textContent lists every option.
    const applied = byId(h, "ants-tracker-body")
      .descendants()
      .find((n) => n.tagName === "SELECT" && n.value === "hz1");
    assert(applied, "the row's control now shows 1 /s");
    assertEqual(rowOf(h, "panelPoll").policyLabel, "1 /s");
  });

  test("the controls change the governor, and reset puts it back", async () => {
    const h = await boot();
    await openTab(h, "governor");
    const selects = byId(h, "ants-tracker-body").descendants().filter((n) => n.tagName === "SELECT");
    const merge = selects.find((s) => s.children.some((o) => o.value === "on" && o.textContent.includes("one redraw")));
    assert(merge, "the redraw-merging control exists");
    merge.value = "on";
    merge._fire("change", {});
    assertEqual(h.tracker.governor.metrics.controls.coalesce, true, "merging is on");

    const resetBtn = byId(h, "ants-tracker-body").descendants().find((n) => n.tagName === "BUTTON" && n.textContent.includes("Reset to untouched"));
    assert(resetBtn, "a reset button exists");
    resetBtn.click();
    assertEqual(h.tracker.governor.metrics.controls.coalesce, false, "reset restores the defaults");
  });

  test("the trace card shows what was inside a long frame", async () => {
    const h = await boot();
    h.sandbox.setInterval(function insideFramePoll() {
      h.busy(2);
    }, 20);
    h.advance(400);
    await openTab(h, "governor");
    const start = h.clock.now;
    h.advance(200);
    h.emitPerformance("long-animation-frame", [
      {
        startTime: start,
        duration: 200,
        blockingDuration: 160,
        scripts: [
          {
            sourceURL: "http://localhost:8188/assets/settingStore-DDHzGrHr.js",
            sourceFunctionName: "renderFrame",
            invoker: "user-callback",
            duration: 180,
            forcedStyleAndLayoutDuration: 120,
          },
        ],
      },
    ]);
    await h.flush();
    h.advance(600);
    await h.flush();
    const text = byId(h, "ants-tracker-body").textContent;
    assertIncludes(text, "renderFrame", "the offending script is named in the trace row");
    assertIncludes(text, "forced layout", "forced layout is reported");
    assertIncludes(text, "insideFramePoll", "and the governed source that ran inside the frame is listed");
  });

  test("the panel opens on Node Rendering Settings, with Status next to it", async () => {
    const h = await boot();
    h.tracker.open();
    const buttons = tabButtons(h);
    const active = buttons.find((b) => b._cls.has("active"));
    assert(active && active.textContent.includes("Node Rendering"), "the default tab is the rendering settings");
    const rendering = buttons.findIndex((b) => b.textContent.includes("Node Rendering"));
    const status = buttons.findIndex((b) => b.textContent === "Status");
    assertEqual(status, rendering + 1, "Status sits immediately after it");
    clickTab(h, "status");
    const statusBody = byId(h, "ants-tracker-body").children.find((c) => c._cls.has("active"));
    assertIncludes(statusBody.textContent, "Status", "the readout lives on that tab");
    const tweaks = byId(h, "ants-tracker-body").children[rendering];
    assert(!tweaks.textContent.includes("widget threshold linked") || statusBody !== tweaks, "the status body is its own tab");
  });

  test("the panel resizes in the dragged direction", async () => {
    const h = await boot();
    h.tracker.open();
    const panel = h.panel();
    const grip = byId(h, "ants-tracker-resize");
    assert(grip, "the panel has a resize grip");
    grip._fire("mousedown", { clientX: 100, clientY: 100, preventDefault() {}, stopPropagation() {} });
    const left = panel.style.left;
    const top = panel.style.top;
    assertEqual(panel.style.right, "auto", "the grip is anchored on the left, not the right");
    h.window.fire("mousemove", { clientX: 180, clientY: 160 });
    h.window.fire("mouseup", {});
    assertEqual(panel.style.width, "720px", "width follows the drag");
    assertEqual(panel.style.height, "580px", "and so does height");
    assertEqual(panel.style.left, left, "dragging the corner right does not move the left edge");
    assertEqual(panel.style.top, top, "dragging the corner down does not move the top edge");
    assertEqual(panel.style.right, "auto", "a resize does not put the anchor back on the right");
    assertIncludes(h.document.getElementById("ants-tracker-style").textContent, "container-type", "narrow panels restack their rows");

    const header = byId(h, "ants-tracker-header");
    header._fire("mousedown", { clientX: 400, clientY: 80, preventDefault() {} });
    const dragged = panel.style.left;
    h.window.fire("mousemove", { clientX: 430, clientY: 100 });
    h.window.fire("mouseup", {});
    assertEqual(panel.style.left, `${Math.round(parseFloat(dragged) + 30)}px`, "a header drag moves the left edge with the pointer");
    assertEqual(panel.style.right, "auto", "and does not re-anchor on the right");
  });

  test("the separate window is its own page, centered, and the panel is only the fallback", async () => {
    const html = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "web", "window.html"), "utf8");
    assert(html.includes('id="ants-window"'), "the window is a real page");
    assert(html.includes("/ants_optimizer/ui"), "it talks to the page through the route");
    assert(!html.includes("window.opener"), "it does not hold the canvas document");
    assert(!html.includes("tracker.js"), "and it does not load the canvas script");

    const h = await boot();
    const calls = [];
    const moved = [];
    let focused = 0;
    const child = {
      closed: false,
      focus() { focused += 1; },
      moveTo(x, y) { moved.push(["move", x, y]); },
      resizeTo(w, ht) { moved.push(["size", w, ht]); },
    };
    h.window.screenX = 80;
    h.window.screenY = 40;
    h.window.outerWidth = 1400;
    h.window.outerHeight = 1000;
    h.window.open = (url, name, features) => {
      calls.push({ url, name, features });
      return child;
    };
    h.tracker.open();
    assertEqual(calls.length, 1, "the gear's open path asks the browser once");
    assertEqual(calls[0].url, "/ants_optimizer/window", "a real route, not an empty document");
    assertEqual(calls[0].name, "ants-optimizer");
    assert(!h.panel() || !h.panel()._cls.has("open"), "the in-page panel stays closed");
    assert(!h.panel() || h.panel().parentNode === h.document.body, "and is not moved into the popup");
    const width = Number(String(calls[0].features).match(/width=(\d+)/)[1]);
    const height = Number(String(calls[0].features).match(/height=(\d+)/)[1]);
    const left = Number(String(calls[0].features).match(/left=(-?\d+)/)[1]);
    const top = Number(String(calls[0].features).match(/top=(-?\d+)/)[1]);
    assertEqual(left, Math.round(80 + (1400 - width) / 2), "left centers the window on the ComfyUI window");
    assertEqual(top, Math.round(40 + (1000 - height) / 2), "top does too");
    assertEqual(moved[0][0], "move");
    assertEqual(moved[0][1], left);
    assertEqual(moved[0][2], top);
    h.tracker.open();
    assertEqual(calls.length, 1, "a second open focuses the window that is already there");
    assertGreater(focused, 1, "and asks it to the front");

    const blocked = await boot();
    blocked.window.open = () => null;
    blocked.tracker.open();
    const panel = blocked.panel();
    assert(panel && panel._cls.has("open"), "a blocked popup opens the in-page panel");
    assert(panel.parentNode === blocked.document.body, "and leaves it on this page");
    assertIncludes(panel.textContent, "blocked", "and says so");
  });

  test("a change posted by the window changes the page, and the page's own echo does not", async () => {
    const h = await boot();
    h.tracker.link.apply({
      ok: true,
      rev: 1,
      origin: "window",
      settings: { flatBelow: 0.2, snapshots: false, boxDetail: "title" },
    });
    assertEqual(h.tracker.lowZoom.state.flatBelow, 0.2, "the window's setting is the page's setting");
    assertEqual(h.tracker.lowZoom.state.snapOn, false, "and it can turn the pictures off");
    assertEqual(h.tracker.lowZoom.state.boxDetail, "title");
    h.tracker.link.apply({
      ok: true,
      rev: 2,
      origin: "page",
      settings: { flatBelow: 0.5 },
    });
    assertEqual(h.tracker.lowZoom.state.flatBelow, 0.2, "the page does not apply its own echo");
    h.tracker.link.apply({ ok: true, rev: 2, origin: "window", command: "measure-links", commandRev: 1 });
    assert(h.tracker.lowZoom.state.ab && h.tracker.lowZoom.state.ab.text, "a window command starts the link measurement");
  });
});
