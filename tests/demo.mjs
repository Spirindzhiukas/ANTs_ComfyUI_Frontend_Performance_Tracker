// Prints what the v2 panel actually says, without ComfyUI, a browser, or a GPU.
//
//   node tests/demo.mjs
//
// The graph is synthetic (four node types, two extension packs, a status
// heartbeat and a long animation frame per second), but every number below is
// produced by web/tracker.js going through its real code paths: real hook
// wrapping, real per-frame accounting, real sampled stacks, real panel DOM.
// Use it to see what the panel reports and to eyeball changes to the UI.
//
// Nothing here is a benchmark of ComfyUI itself — the costs are simulated with
// the harness clock (`h.busy`), so treat the magnitudes as illustrative and the
// structure as the point.

import vm from "node:vm";
import { createHarness, FRAME_MS } from "./harness.mjs";

const h = createHarness();

// ---------------------------------------------------------------- scenario ---
// Two packs with different costs, one node type instrumented by each.
const nasty = { fg: 1.6, bg: 0.5 }; // per node, per frame
const nice = { fg: 0.06, bg: 0.25 };

function pack(name, cost, owns) {
  return h.registerExtension(name, {
    beforeRegisterNodeDef(nodeType, nodeData) {
      if (!owns.includes(nodeData.name)) return;
      nodeType.prototype.onDrawForeground = function () {
        h.busy(cost.fg);
      };
      nodeType.prototype.onDrawBackground = function () {
        h.busy(cost.bg);
      };
    },
  });
}
await pack("NastyBastards", nasty, ["NastyBastardsThing", "NastyBastardsOtherThing"]);
await pack("NicePack", nice, ["NiceWidget"]);

const NastyA = h.registerNodeType("NastyBastardsThing");
const NastyB = h.registerNodeType("NastyBastardsOtherThing");
const NiceThing = h.registerNodeType("NiceWidget");

// A core-style node that draws with its own instance hook — invisible to
// anything that only wraps node prototypes (the v1 blind spot).
const Preview = h.registerNodeType("PreviewImage");
const preview = h.makeNode(Preview);
preview.onDrawForeground = function () {
  h.busy(0.45);
};
preview.onDrawBackground = function () {
  h.busy(0.15);
};

const nodes = [h.makeNode(NastyA), h.makeNode(NastyA), h.makeNode(NastyB), h.makeNode(NiceThing), preview];

// The pattern that produces paired rows in real graphs: a node's own hook
// delegates to the (already wrapped) prototype method. The Timing tab must show
// the cost once, on the outer hook, with a "nested" tag on the inner one.
const niceNode = nodes[3];
niceNode.onDrawBackground = function (...args) {
  return NiceThing.prototype.onDrawBackground.apply(this, args);
};
h.canvas.nodes = nodes;
h.app.graph._nodes = nodes; // what the panel counts and the Nodes tab walks

h.canvas.costs = { background: 0.35, connections: 1.2, chrome: 0.4 };

// Staggered start times, because that is what makes "load span" different from
// "sum of durations" (the v1 bug this lane now avoids).
for (const [url, startTime, duration, transferSize] of [
  ["http://localhost:8188/extensions/NastyBastards/js/main.js", 0, 42, 184000],
  ["http://localhost:8188/extensions/NastyBastards/js/status.js", 38, 12, 26000],
  ["http://localhost:8188/extensions/NastyBastards/js/panel.css", 44, 3, 4200],
  ["http://localhost:8188/extensions/NicePack/js/nice.js", 18, 9, 19000],
]) {
  h.addResource(url, { startTime, duration, transferSize, encodedBodySize: transferSize });
}

h.fetchRoutes.set("/system_stats", {
  devices: [{ name: "cuda:0 NVIDIA GeForce RTX 4090", vram_total: 25757220864, vram_free: 24159000000, torch_vram_total: 4200000000, torch_vram_free: 3900000000 }],
});
h.fetchRoutes.set("/ants_tracker/gpu", {
  available: true,
  gpus: [{ index: 0, name: "NVIDIA GeForce RTX 4090", utilization_gpu: 14, memory_used: 1598, memory_total: 24564, temperature_gpu: 61, power_draw: 96.4, power_limit: 450 }],
  processes: [{ pid: 4211, name: "python3", used_memory: 1590 }],
});

// --------------------------------------------------------- the bad citizen ---
// A page script that asks for a redraw on its own clock. Its real URL is what
// the panel attributes the requests to, via the sampled setDirty stack.
vm.runInContext(
  `globalThis.__nastyTick = function () { __ants.app.canvas.setDirty(true, true); };`,
  h.sandbox,
  { filename: "http://localhost:8188/extensions/NastyBastards/js/status.js" }
);

// A heartbeat from an extension that burns real time on every tick, and forces
// layout while it is at it — the pattern the Governor exists for, and the one
// the report that prompted this layer actually found (`clamp` in a curve
// equalizer extension, 3 seconds of forced style/layout over a session).
h.sandbox.__antsCost = (ms) => h.busy(ms);
vm.runInContext(
  `setInterval(function clamp() { __antsCost(3.2); }, 20);`,
  h.sandbox,
  { filename: "http://localhost:8188/extensions/ANT_NODES/ant_loras_equalizer_curve.js" }
);

// ------------------------------------------------------------------- drive ---
for (const ext of h.app.extensions) if (ext.setup) await ext.setup();
await h.flush();
h.document.getElementById("ants-corner-btn").click(); // open the panel

let nextStallAt = 0;
function run(wallMs) {
  const until = h.clock.now + wallMs;
  let i = 0;
  while (h.clock.now < until) {
    if (i++ % 3 === 0) {
      h.sandbox.__nastyTick(); // ~20 redraw requests/second
      h.sandbox.__nastyTick(); // and a second source asking for the same frame
    }
    if (h.clock.now >= nextStallAt) {
      nextStallAt = h.clock.now + 1000;
      // one second of blocked main thread, from the same page script
      h.emitPerformance("long-animation-frame", [
        {
          startTime: h.clock.now - 140,
          duration: 140,
          blockingDuration: 95,
          scripts: [
            {
              sourceURL: "http://localhost:8188/assets/settingStore-DDHzGrHr.js",
              sourceFunctionName: "renderFrame",
              invoker: "user-callback",
              duration: 90,
              forcedStyleAndLayoutDuration: 55,
            },
            {
              sourceURL: "http://localhost:8188/extensions/ANT_NODES/ant_loras_equalizer_curve.js",
              sourceFunctionName: "clamp",
              invoker: "TimerHandler:setInterval",
              duration: 42,
              forcedStyleAndLayoutDuration: 30,
            },
            {
              sourceURL: "http://localhost:8188/extensions/NastyBastards/js/status.js",
              sourceFunctionName: "refreshStatusBadge",
              invoker: "TimerHandler:setInterval",
              duration: 130,
              forcedStyleAndLayoutDuration: 70,
            },
          ],
        },
      ]);
    }
    h.performanceShim.memory.usedJSHeapSize += 4096; // a slow climb, as a demo trend
    // Jitter, so the p95/p99 rows are not identical to the mean (a real graph
    // never draws every node at exactly the same cost).
    h.canvas.costs.chrome = 0.4 + (i % 17) * 0.06;
    h.canvas.costs.background = i % 23 === 0 ? 1.4 : 0.35;
    h.advance(FRAME_MS);
    h.canvas.draw(true, true);
  }
}

async function pump() {
  await h.flush();
  await new Promise((r) => setImmediate(r));
}

run(6000); // six seconds of realistic traffic (everything untouched: "normal")
await pump();

// Then the scheduler layer does something about it: the extension heartbeat is
// dropped to a quarter speed and redraw requests are merged, and the page runs
// for two more seconds so the Governor tab below shows the same source measured
// at a quarter of its runs, with the skipped ticks counted rather than hidden.
const gov = h.tracker.governor;
const clampSource = gov.sources.find((r) => r.name === "clamp");
if (clampSource) gov.policy(clampSource.key, "quarter");
gov.control("coalesce", true);

// A repaint timer of the kind the autopilot exists for: it asks for every 100ms
// but each run costs 20ms, so it is a real 167 ms/s of main thread. The autopilot
// is pointed at the same 150 ms/s target a user would pick, and gets one interval
// to notice and cap it.
vm.runInContext(
  `setInterval(function checkAndRepaint() { __antsCost(20); }, 100);`,
  h.sandbox,
  { filename: "http://localhost:8188/assets/vendor-vueuse-gYZjo854.js" }
);
gov.control("autoLimit", true);
gov.control("autoTargetMsPerSec", 150);
run(2000);
await pump();
run(6000); // one autopilot round, plus room for the table to re-measure
await pump();
// ------------------------------------------------------------------- print ---
const WIDTH = 100;
const rule = (ch = "-") => ch.repeat(WIDTH);
function bullets(title) {
  console.log(`\n${rule("=")}\n${title}\n${rule("=")}`);
}

// The shim has no layout engine, so "render" here means: walk the subtree and
// emit one line per block, joining inline children into their parent's line.
const INLINE = new Set(["SPAN", "B", "CODE", "EM", "I", "SMALL", "A", "BR"]);
const pad = (d) => "  ".repeat(d);

function textWithoutTables(node) {
  if (node.tagName === "TABLE") return "";
  if (node.tagName === "SELECT") return node.value || "(unset)";
  return [node._text, ...node.children.map(textWithoutTables)].join(" ").replace(/\s+/g, " ").trim();
}

function linesOf(node, depth = 0) {
  const tag = node.tagName;
  // The shim has no layout, so hidden blocks are skipped by hand: the printer
  // should show what the user sees, not what is merely in the DOM.
  if (node.style && node.style.display === "none") return [];
  if (node._cls && node._cls.has("ants-more") && node.style && node.style.display === "none") return [];
  if (tag === "TABLE" || tag === "THEAD" || tag === "TBODY") {
    return node.children.flatMap((c) => linesOf(c, depth));
  }
  if (tag === "TR") {
    const out = [`${pad(depth)}| ${node.children.map((c) => textWithoutTables(c)).join(" | ")} |`];
    for (const cell of node.children) {
      for (const nested of cell.children) if (nested.tagName === "TABLE") out.push(...linesOf(nested, depth + 1));
    }
    return out;
  }
  if (tag === "SELECT") return [`${pad(depth)}[ select: ${node.value || "(unset)"} ]`];
  const inline = node.children.filter((c) => INLINE.has(c.tagName));
  const blocks = node.children.filter((c) => !INLINE.has(c.tagName));
  const out = [];
  const own = [node._text, ...inline.map((c) => c.textContent)].join(" ").replace(/\s+/g, " ").trim();
  if (own) out.push(`${pad(depth)}${own}`);
  for (const b of blocks) out.push(...linesOf(b, depth + 1));
  return out;
}

function dump(container) {
  if (!container) return;
  for (const line of linesOf(container)) if (line.trim()) console.log(line);
}

// Expand the two heaviest owners, plus anything tagged nested, so the per-hook
// breakdown (including the nested-call accounting) is in the output.
const rowsToOpen = h.document.body
  .descendants()
  .filter((n) => n.tagName === "TR")
  .filter((tr, i) => i < 2 || tr.textContent.includes("nested"));
for (const tr of rowsToOpen) {
  const caret = tr.descendants().find((n) => n._cls && n._cls.has("ants-caret"));
  if (caret) caret.click();
}
await pump();

// ------------------------------------------------------- low-zoom drawing ---
// The other half of the answer for a big graph: at zoom 0.10 every node is on
// screen (so culling cannot remove anything) and the frame is dominated by
// drawing them properly. Six nodes that land ~20px wide, links between them, and
// the mode switched on — the Nodes tab and the report below then show the frame
// budget with the cheap path in it.
h.canvas.ds.scale = 0.1;
h.canvas.nodes = [];
h.canvas.links = [];
for (let i = 0; i < 6; i++) {
  h.canvas.nodes.push({ type: "KSampler", pos: [i * 240, 0], size: [200, 100], selected: false });
  h.canvas.links.push({ color: "#888888", from: [i * 240, 0], to: [i * 240 + 200, 100] });
}
h.app.graph._nodes = h.canvas.nodes; // in ComfyUI the graph the canvas draws is canvas.graph
h.tracker.lowZoom.set({ minPx: 24, idleCapMs: 500, thumbZoom: 0.6 });

// One node with a 4096px image in it, drawn the way a preview/load/compare node
// draws: the first frame paints the full bitmap, the next one is served from the
// copy the ladder made for this zoom.
const demoImg = { naturalWidth: 4096, naturalHeight: 4096 };
// Big enough that the node itself is not flattened by the setting above — this
// is about what happens to the image *inside* a node that is still drawn.
h.canvas.nodes[0].size = [600, 300];
h.canvas.nodes[0].img = demoImg;
h.canvas.nodes[0].onDrawBackground = function (ctx) {
  ctx.drawImage(this.img, 0, 0, 400, 200);
};
for (let i = 0; i < 2; i++) {
  h.advance(FRAME_MS);
  h.canvas.setDirty(true, true);
  h.canvas.draw();
}
run(500);
await pump();

bullets("SUMMARY BAR (always visible)");
dump(h.document.getElementById("ants-tracker-summary"));

const TABS = ["timing", "nodes", "stalls", "governor", "load", "memory", "gpu", "testing"];
const tabBar = h.document.getElementById("ants-tracker-tabs");
const body = h.document.getElementById("ants-tracker-body");
for (let i = 0; i < TABS.length; i++) {
  tabBar.children[i].click();
  run(i === 6 ? 2600 : 700); // the GPU tab polls /system_stats every 2.5s while open
  await pump();
  if (TABS[i] === "governor") {
    // Collapsed detail rows are skipped by the printer, and the trace detail
    // ("this frame's scripts, the ticks inside it, who asked for the redraw") is
    // the point of the card, so open the first few here.
    const carets = body.children[i].descendants().filter((n) => n._cls && n._cls.has("ants-caret"));
    for (const caret of carets.slice(0, 3)) caret.click();
    await pump();
  }
  bullets(`${TABS[i].toUpperCase()} TAB`);
  dump(body.children[i]);
}

// The one-click text report, exactly as the Copy button produces it.
const copyBtn = h.document.body.descendants().find((n) => n._cls && n._cls.has("ants-hbtn") && n.textContent.includes("Copy"));
copyBtn.click();
await pump();
bullets("TEXT REPORT (Copy button)");
console.log(h.clipboardWrites[h.clipboardWrites.length - 1] || "(clipboard empty)");

console.log(
  "\nnote: the tail of the run above has limits applied — the extension's `clamp` heartbeat capped by" +
    "\n      hand at quarter speed, and the repaint timer capped by the AUTOPILOT (target 150 ms/s, one" +
    "\n      round every 5s) — so the GOVERNOR TAB above shows both: a source limited by hand, and the" +
    "\n      autopilot's own line saying which source it capped, at what gap, and what it was costing." +
    "\nnote: the LOW-ZOOM DRAWING section of the Nodes tab and the report line above are the other" +
    "\n      answer for this kind of page: every node is inside the viewport at zoom 0.10, so culling has" +
    "\n      nothing to remove and the cost is drawing a thousand nodes properly several times a second." +
    "\n      The mode paints nodes that land a few pixels wide as one rectangle, straightens links, and" +
    "\n      caps redraws while nobody is touching the page — opt-in, and off the moment you say so." +
    "\n      Its preview setting is the other half: image, preview and compare nodes blit a full-resolution bitmap every" +
    "\n      redraw, so below the zoom you set (60% by default) those draws are served from a cached copy of about the" +
    "\n      resolution the screen can show — 64px on the long side at 10% zoom, 512px around 60% for a big node." +
    "\nnote: in this simulation the clock only advances with h.advance(), so the tracker's own" +
    "\n      per-render cost reads 0 — a real browser spends real time rendering the panel." +
    "\n      Everything else above is what web/tracker.js computes from the synthetic traffic."
);

if (h.errors().length) {
  bullets("TRACKER ERRORS (should be empty)");
  for (const e of h.errors()) console.log(e);
}
