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

// One redraw, exactly, for the preview tests: a frame boundary and a paint.
function oneFrame(h) {
  h.advance(FRAME_MS);
  h.canvas.setDirty(true, true);
  h.canvas.draw();
}

suite("drawing: low-zoom mode paints less, and only when asked", () => {
  test("nothing is flattened by default: every node and every link goes through LiteGraph's own drawing", async () => {
    const h = await boot();
    bigGraph(h, 12);
    drawLoop(h, 0.2);
    assertEqual(h.tracker.lowZoom.state.minPx, 0, "nothing is simplified until it is switched on");
    assertEqual(h.tracker.lowZoom.previews.belowZoom, 0.6, "previews are the one part that is on, below 60% zoom");
    assertEqual(h.tracker.lowZoom.state.idleCapMs, 0, "and no redraw cap");
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


  test("the node threshold reaches far enough for a 4K screen", async () => {
    const h = await boot();
    h.window.devicePixelRatio = 1;
    // 1200 world units wide at zoom 0.10 = 120px on screen: unreadable, and at
    // 4K it is also far from the smallest thing on the canvas.
    bigGraph(h, 4, 0.1);
    h.canvas.nodes.forEach((n) => {
      n.size = [1200, 600];
    });
    const stretch = 120; // h.canvas.ds.scale is 0.1, so this is 120px on screen
    h.tracker.lowZoom.set({ minPx: 96 });
    h.canvas.ctx.ops.length = 0;
    drawLoop(h, 0.2);
    assertEqual(h.tracker.lowZoom.state.nodes, 0, "below the threshold a 120px node is still drawn in full");
    h.tracker.lowZoom.set({ minPx: 128 });
    drawLoop(h, 0.2);
    assertGreater(h.tracker.lowZoom.state.nodes, 0, `above it the same node is a rectangle (${stretch}px on screen)`);
    assert(h.tracker.lowZoom.limits.minPx.includes(256), "and the ladder goes to 256px, not just 32");
    const plan = h.tracker.lowZoom.state.plan;
    assertEqual(plan.medPx, 120, "the panel also measures what this zoom makes of a typical node");
    assertEqual(plan.needPx, 128, "and names the setting that would flatten it");

    // The setting that is too low for the screen has to say so, by name.
    h.tracker.lowZoom.set({ minPx: 96 });
    h.advance(FRAME_MS);
    h.canvas.setDirty(true, true);
    h.canvas.draw();
    await openNodesTab(h);
    assertIncludes(panelText(h), "the typical node is 120px wide on screen", "the panel points at the setting that would catch it");
  });

  test("a big preview is served from a thumbnail, and the resolution follows the zoom", async () => {
    const h = await boot();
    h.window.devicePixelRatio = 1;
    const img = { naturalWidth: 4096, naturalHeight: 3072 };
    bigGraph(h, 1, 0.6);
    h.canvas.links = [];
    h.canvas.nodes[0].type = "LoadImage";
    h.canvas.nodes[0].img = img;
    h.canvas.nodes[0].onDrawBackground = function (ctx) {
      ctx.drawImage(this.img, 0, 0, 400, 300);
    };
    h.canvas.costs.chrome = 0.01;
    h.tracker.lowZoom.set({ thumbZoom: 1 }); // thumbnails below 100% zoom

    h.canvas.ds.scale = 0.6; // 400 units x 0.6 = 240px on screen
    oneFrame(h);
    assertEqual(h.imageBitmaps.length, 1, "one thumbnail was asked for");
    assertEqual(h.imageBitmaps[0].width, 256, "256px for a box that is 240px wide on screen at 60% zoom");
    assertEqual(h.imageBitmaps[0].height, 192, "kept in proportion");
    assertEqual(h.imageBitmaps[0].quality, "low", "resized cheaply, not with a good filter");
    const firstFrame = h.canvas.ctx.ops.filter((o) => o[0] === "drawImage");
    assertEqual(firstFrame[firstFrame.length - 1][1], img, "the first frame still drew the full image");

    await h.flush(); // the copy resolves
    h.canvas.ctx.ops.length = 0;
    oneFrame(h);
    const after = h.canvas.ctx.ops.filter((o) => o[0] === "drawImage");
    assertEqual(after.length, 1, "and the next frame drew one image");
    assert(after[0][1] !== img, "from the cached copy, not the source");
    assertEqual(after[0][1].width, 256, "at the size the screen can show");
    // this call is the five-argument form: ops are ["drawImage", src, dx, dy, dw, dh]
    assertEqual(after[0][2], 0, "with the destination rectangle untouched");
    assertEqual(after[0][4], 400, "including its width in graph units");
    assertEqual(after[0][5], 300, "and its height");
    assertEqual(h.tracker.lowZoom.previews.served, 1, "and the panel counts it");

    // Zoomed further out the node covers fewer pixels, so the copy shrinks too.
    h.canvas.ds.scale = 0.1;
    h.tracker.lowZoom.set({ thumbZoom: 1 });
    oneFrame(h);
    const small = h.imageBitmaps[h.imageBitmaps.length - 1];
    assertEqual(small.width, 64, "64px on the long side at 10% zoom: one source image, two sizes on demand");
    assertEqual(h.tracker.lowZoom.previews.belowZoom, 1);
    await h.flush();
    h.canvas.ctx.ops.length = 0;
    oneFrame(h);
    const tiny = h.canvas.ctx.ops.filter((o) => o[0] === "drawImage");
    assertEqual(tiny[0][1].width, 64, "and the frame now uses the smaller copy");
    assertEqual(h.tracker.lowZoom.previews.built, 2, "two thumbnails cached, one per bucket");
  });

  test("readable zooms, small images and thumbnails themselves are left alone", async () => {
    const h = await boot();
    h.window.devicePixelRatio = 1;
    const img = { naturalWidth: 4096, naturalHeight: 4096 };
    const small = { naturalWidth: 128, naturalHeight: 128 };
    bigGraph(h, 2, 1);
    h.canvas.links = [];
    h.canvas.nodes[0].img = img;
    h.canvas.nodes[0].onDrawBackground = function (ctx) {
      // the nine-argument form: a crop of the source into the node's box
      ctx.drawImage(this.img, 1024, 768, 2048, 1536, 0, 0, 400, 400);
    };
    h.canvas.nodes[1].img = small;
    h.canvas.nodes[1].onDrawBackground = function (ctx) {
      ctx.drawImage(this.img, 0, 0, 100, 100);
    };
    h.canvas.costs.chrome = 0.01;
    h.tracker.lowZoom.set({ thumbZoom: 0.6 });

    h.canvas.ds.scale = 1; // readable: no thumbnail at all
    oneFrame(h);
    assertEqual(h.imageBitmaps.length, 0, "at full zoom every preview is drawn from its own image");

    h.canvas.ds.scale = 0.1; // now the threshold is met
    oneFrame(h);
    await h.flush();
    assertEqual(h.imageBitmaps.length, 1, "only the big image gets a copy");
    assertGreater(h.tracker.lowZoom.previews.skipped, 0, "the 128px source is left alone: copying it would gain nothing");
    h.canvas.ctx.ops.length = 0;
    oneFrame(h);
    const drawn = h.canvas.ctx.ops.filter((o) => o[0] === "drawImage");
    assertEqual(drawn.length, 2, "both nodes still draw an image");
    const sources = drawn.map((o) => o[1]);
    assertIncludes(sources, small, "the 128px one from its own source");
    const copy = sources.find((s) => s !== small && s !== img);
    assert(copy, "the 4096px one from a copy");
    assertEqual(copy.width, 64, "at the 64px bucket this zoom asks for");
    const cropped = drawn.find((o) => o.length === 10);
    assert(cropped, "the cropped call kept its nine-argument form");
    assertEqual(cropped[2], 16, "with the source rectangle scaled into the copy (1024 of 4096 -> 16 of 64)");
    assertEqual(cropped[5], 24, "height too (1536 of 4096 -> 24 of 64)");
    assertEqual(cropped[9], 400, "and the destination untouched");
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
