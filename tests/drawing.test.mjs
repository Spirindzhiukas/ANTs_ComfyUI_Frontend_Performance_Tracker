// Low-zoom drawing: the opt-in that makes one canvas redraw cheaper instead of
// making redraws rarer. Three promises are pinned here:
//   1. it is off by default, and off means the canvas is painted exactly the way
//      ComfyUI paints it;
//   2. when it is on, the cheap path is used only for what cannot be read at this
//      zoom, and the frame budget — measured by the same wrapping of
//      drawNode/drawConnections — shows the saving;
//   3. anything that throws switches the whole mode off and falls back to the
//      original draw path, because a rendering change this tool cannot explain
//      must never be left half-applied on somebody's canvas.

import { createHarness, FRAME_MS } from "./harness.mjs";
import { suite, test, assert, assertEqual, assertClose, assertGreater, assertLess, assertIncludes } from "./framework.mjs";

async function boot() {
  const h = createHarness();
  for (const ext of h.app.extensions) if (ext.setup) await ext.setup();
  await h.flush();
  return h;
}

// Drive the canvas the way ComfyUI's rAF loop does.
function drawLoop(h, seconds, intervalMs = FRAME_MS) {
  const steps = Math.max(1, Math.round((seconds * 1000) / intervalMs));
  for (let i = 0; i < steps; i++) {
    h.advance(intervalMs);
    h.canvas.setDirty(true, true);
    h.canvas.draw();
  }
  return steps;
}

// The shape the feature was built for: lots of nodes, all of them on screen
// (zoom 0.10), each landing a couple of dozen pixels wide.
function bigGraph(h, count = 40, scale = 0.1) {
  h.canvas.ds.scale = scale;
  h.canvas.ds.offset[0] = 0;
  h.canvas.ds.offset[1] = 0;
  h.canvas.nodes = [];
  h.canvas.links = [];
  for (let i = 0; i < count; i++) {
    h.canvas.nodes.push({
      type: "KSampler",
      pos: [(i % 10) * 240, Math.floor(i / 10) * 140],
      size: [200, 100],
      selected: false,
    });
  }
  for (let i = 0; i < count; i++) h.canvas.links.push({ color: "#888888", from: [0, 0], to: [10, 10] });
}

function panelText(h) {
  const panel = h.panel();
  if (!panel) return "";
  return panel
    .descendants()
    .map((n) => (n.children.length ? "" : n.textContent))
    .join(" ");
}

// The panel is built lazily: open it from the corner button, then the Nodes tab.
async function openNodesTab(h) {
  const corner = h.document.getElementById("ants-corner-btn");
  if (corner) corner.click();
  await h.flush();
  const bar = h.document.getElementById("ants-tracker-tabs");
  if (bar) {
    const buttons = bar.children.filter((c) => c.tagName === "BUTTON");
    if (buttons[1]) buttons[1].click();
  }
  await h.flush();
  return h.panel();
}

suite("drawing: low-zoom mode paints less, and only when asked", () => {
  test("off by default: every node and every link goes through LiteGraph's own drawing", async () => {
    const h = await boot();
    bigGraph(h, 12);
    drawLoop(h, 0.2);
    assertEqual(h.tracker.lowZoom.state.minPx, 0, "nothing is simplified until it is switched on");
    assertEqual(h.tracker.lowZoom.state.nodes, 0);
    assertEqual(h.tracker.lowZoom.state.links, 0);
    assertGreater(h.canvas.nodeDraws, 0, "the original node draw path ran");
    assertEqual(h.canvas.linkDraws, h.canvas.links.length * 12, "and every link went through LiteGraph's renderer");
    const bez = h.canvas.ctx.ops.filter((o) => o[0] === "bezierCurveTo").length;
    assertGreater(bez, 0, "with splines, which is what the cheap path replaces");
  });

  test("nodes too small to read are painted as one rectangle, and the budget shows it", async () => {
    const h = await boot();
    h.canvas.costs = { background: 0.5, connections: 1.0, chrome: 1.5, link: 0 };
    bigGraph(h, 40, 0.1); // 200 units x 0.1 = 20px on screen
    drawLoop(h, 0.2);
    assertClose(h.tracker.snapshot.frame.nodeMsPerFrame, 60, 3, "40 nodes at 1.5ms each, drawn in full");

    h.tracker.reset();
    h.canvas.ctx.ops.length = 0; // only what happens from here is the cheap path
    h.tracker.lowZoom.set({ minPx: 24 }); // 20px < 24px
    const draws = drawLoop(h, 0.2);
    const f = h.tracker.snapshot.frame;
    assertLess(f.nodeMsPerFrame, 6, `the frame budget drops (${f.nodeMsPerFrame.toFixed(2)} ms/frame)`);
    assertEqual(h.tracker.lowZoom.state.nodes, 40 * draws, "every one of those node draws was replaced");
    const rects = h.canvas.ctx.ops.filter((o) => o[0] === "fillRect").length;
    assertGreater(rects, 0, "with a flat rectangle");
    const titles = h.canvas.ctx.ops.filter((o) => o[0] === "roundRect" || o[0] === "bezierCurveTo").length;
    assertEqual(titles, 0, "and none of the chrome that makes a node readable at a zoom where it is not");
  });

  test("links are drawn as straight lines while most of the graph is that small, and properly again when zoomed in", async () => {
    const h = await boot();
    h.canvas.costs = { background: 0.2, connections: 1.0, chrome: 0.5, link: 0.4 };
    bigGraph(h, 20, 0.1);
    h.tracker.lowZoom.set({ minPx: 24 });
    const before = h.canvas.linkDraws;
    drawLoop(h, 0.2);
    assertGreater(h.tracker.lowZoom.state.links, 0, "the cheap link path was used");
    assertEqual(h.canvas.linkDraws, before, "and LiteGraph's own link renderer did not run");

    h.canvas.ds.scale = 1; // readable zoom: nodes are 200px wide now
    const proper = h.canvas.linkDraws;
    drawLoop(h, 0.2);
    assertGreater(h.canvas.linkDraws, proper, "zoomed in, links go back through LiteGraph's renderer");
  });

  test("the idle cap merges redraws while nothing is touched and gets out of the way instantly", async () => {
    const h = await boot();
    h.tracker.lowZoom.set({ idleCapMs: 500 });
    h.advance(2000); // nobody has touched the page for a while
    let issued = 0;
    for (let i = 0; i < 20; i++) {
      h.advance(100);
      h.canvas.setDirty(true, true);
      h.canvas.draw();
      issued++;
    }
    assertLess(h.canvas.drawCalls, issued / 2, `a burst of redraws is capped (${h.canvas.drawCalls} of ${issued})`);
    assertGreater(h.tracker.lowZoom.state.capped, 0, "and the merged ones are counted");

    const before = h.canvas.drawCalls;
    h.window.fire("pointermove"); // somebody is here again
    h.advance(FRAME_MS);
    h.canvas.setDirty(true, true);
    h.canvas.draw();
    assertEqual(h.canvas.drawCalls, before + 1, "input lifts the cap immediately");
  });

  test("an error in the cheap path switches the mode off instead of leaving the canvas half-drawn", async () => {
    const h = await boot();
    bigGraph(h, 4, 0.1);
    h.tracker.lowZoom.set({ minPx: 24 });
    let boom = true;
    h.canvas.ctx = new Proxy(
      {},
      {
        get: () => () => {},
        set: () => {
          if (boom) throw new Error("the context was lost");
          return true;
        },
      }
    );
    drawLoop(h, 0.2);
    assertIncludes(h.tracker.lowZoom.state.error, "the context was lost", "the reason is recorded for the panel");
    assertEqual(h.tracker.lowZoom.state.minPx, 0, "and the mode turned itself off");
    boom = false;
    const before = h.canvas.nodeDraws;
    drawLoop(h, 0.2);
    assertGreater(h.canvas.nodeDraws, before, "while the original draw path kept running");
  });

  test("a frontend that renders nodes as Vue overlays is not painted over", async () => {
    const h = await boot();
    bigGraph(h, 4, 0.1);
    h.window.LiteGraph.vueNodesMode = true; // LiteGraph draws no node chrome in this mode
    h.tracker.lowZoom.set({ minPx: 24 });
    const fillRects = () => h.canvas.ctx.ops.filter((o) => o[0] === "fillRect").length;
    const before = fillRects();
    drawLoop(h, 0.2);
    assertEqual(h.tracker.lowZoom.state.nodes, 0, "nothing is painted for nodes the canvas does not draw");
    assertEqual(fillRects(), before, "and no rectangles appear behind the DOM nodes");
  });

  test("the panel says whether culling could help at this zoom, and what the mode is doing", async () => {
    const h = await boot();
    h.window.devicePixelRatio = 1;
    bigGraph(h, 30, 0.1);
    const wide = h.tracker.lowZoom.visibility;
    assertEqual(wide.total, 30);
    assertGreater(wide.share, 0.9, `at zoom 0.10 the graph is on screen (${wide.visible} of ${wide.total})`);
    assert(wide.zoomedOut, "and the tracker knows this is a zoomed-out view");
    assertLess(wide.meanPx, 30, `with each node a few pixels wide (${wide.meanPx.toFixed(0)}px)`);

    h.canvas.ds.scale = 2; // the same graph, zoomed in past the viewport
    const close = h.tracker.lowZoom.visibility;
    assertLess(close.share, 0.6, `zoomed in, most of the graph is off-screen (${close.visible} of ${close.total})`);

    h.canvas.ds.scale = 0.1;
    drawLoop(h, 0.2);
    h.tracker.lowZoom.set({ minPx: 24 });
    drawLoop(h, 0.2);
    h.canvas.min_font_size_for_lod = 0; // the frontend's own LOD is switched off
    h.canvas.low_quality = false;
    await openNodesTab(h); // the tab is built when it is opened, so this reads the current state
    const text = panelText(h);
    assertIncludes(text, "culling cannot save anything here", "the panel draws the conclusion, not just the number");
    assertIncludes(text, "frontend LOD is switched off", "and names the frontend's own LOD switch instead of leaving it hidden");
    assertIncludes(text, "nodes under 24px", "and shows what the mode is set to");
    assertIncludes(text, "node draw", "with the saving measured by the tracker itself");
  });
});
