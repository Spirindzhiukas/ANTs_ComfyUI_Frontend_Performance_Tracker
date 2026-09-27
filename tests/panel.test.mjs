// Panel behaviour tests: the UI half of the rewrite. These cover the v1
// complaints directly — innerHTML rebuilding that reset scroll, rows that
// reordered under the pointer, a Testing tab whose dropdown was destroyed
// every 500ms, and an empty panel that could not explain itself.

import { createHarness, FRAME_MS } from "./harness.mjs";
import { suite, test, assert, assertEqual, assertGreater, assertIncludes } from "./framework.mjs";

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
function tabButtons(h) {
  const bar = byId(h, "ants-tracker-tabs");
  return bar ? bar.children.filter((c) => c.tagName === "BUTTON") : [];
}
function clickTab(h, name) {
  const labels = { timing: 0, nodes: 1, stalls: 2, load: 3, memory: 4, gpu: 5, testing: 6 };
  tabButtons(h)[labels[name]].click();
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

    for (const name of ["timing", "nodes", "stalls", "load", "memory", "gpu", "testing"]) {
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
