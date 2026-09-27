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

async function boot(options) {
  // `options.storage` is how a test says "this is a second page load": the same
  // browser storage, a fresh tracker.
  const h = createHarness(options);
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

// The panel is built lazily: open it from the corner button, then the tab that
// owns the drawing settings (v2.1.8 moved them out of the Nodes tab and to the
// front of the tab row).
async function openTweaksTab(h) {
  const corner = h.document.getElementById("ants-corner-btn");
  if (corner) corner.click();
  await h.flush();
  const bar = h.document.getElementById("ants-tracker-tabs");
  if (bar) {
    const buttons = bar.children.filter((c) => c.tagName === "BUTTON");
    const tweaks = buttons.find((b) => String(b.textContent).toLowerCase().includes("tweaks"));
    if (tweaks) tweaks.click();
    else if (buttons[0]) buttons[0].click();
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
    assertEqual(h.tracker.lowZoom.state.flatBelow, 0, "nothing is simplified until it is switched on");
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
    h.tracker.lowZoom.set({ flatBelow: 0.2 }); // zoom 0.1 is below it: every node is a rectangle
    const draws = drawLoop(h, 0.2);
    const f = h.tracker.snapshot.frame;
    assertLess(f.nodeMsPerFrame, 6, `the frame budget drops (${f.nodeMsPerFrame.toFixed(2)} ms/frame)`);
    assertEqual(h.tracker.lowZoom.state.nodes, 40 * draws, "every one of those node draws was replaced");
    const rects = h.canvas.ctx.ops.filter((o) => o[0] === "fillRect").length;
    assertGreater(rects, 0, "with a flat rectangle");
    const chrome = h.canvas.ctx.ops.filter((o) => o[0] === "roundRect").length;
    assertEqual(chrome, 0, "and none of the node chrome that makes a node readable at a zoom where it is not");
  });

  test("straight links happen when the link setting asks for them, and at no other time", async () => {
    const h = await boot();
    h.canvas.costs = { background: 0.2, connections: 1.0, chrome: 0.5, link: 0.4 };
    bigGraph(h, 20, 0.1);

    // The node setting is on — and links are still ComfyUI's curves, because a
    // node setting has no say in how a link is drawn.
    h.tracker.lowZoom.set({ flatBelow: 0.2, linkStyle: "spline" });
    const before = h.canvas.linkDraws;
    drawLoop(h, 0.2);
    assertEqual(h.tracker.lowZoom.state.links, 0, "the straight-line path was not used");
    assertGreater(h.canvas.linkDraws, before, "LiteGraph drew the links, curves and all");
    assertGreater(
      h.canvas.ctx.ops.filter((o) => o[0] === "bezierCurveTo").length,
      0,
      "curves at 10% zoom with the graph flattened"
    );

    // Same zoom, same node setting, only the link setting changed.
    h.tracker.lowZoom.set({ linkStyle: "straight" });
    const mid = h.canvas.linkDraws;
    drawLoop(h, 0.2);
    assertGreater(h.tracker.lowZoom.state.links, 0, "now the straight path draws them");
    assertEqual(h.canvas.linkDraws, mid, "and LiteGraph's renderer did not run");

    // And it stays straight when zoomed in, because that is what was asked for.
    h.canvas.ds.scale = 1;
    const proper = h.canvas.linkDraws;
    drawLoop(h, 0.2);
    assertEqual(h.canvas.linkDraws, proper, "still straight at 100% zoom");
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
    h.tracker.lowZoom.set({ flatBelow: 0.2 });
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
    assertEqual(h.tracker.lowZoom.state.flatBelow, 0, "and the mode turned itself off");
    boom = false;
    const before = h.canvas.nodeDraws;
    drawLoop(h, 0.2);
    assertGreater(h.canvas.nodeDraws, before, "while the original draw path kept running");
  });

  test("a frontend that renders nodes as Vue overlays is not painted over", async () => {
    const h = await boot();
    bigGraph(h, 4, 0.1);
    h.window.LiteGraph.vueNodesMode = true; // LiteGraph draws no node chrome in this mode
    h.tracker.lowZoom.set({ flatBelow: 0.2 });
    const fillRects = () => h.canvas.ctx.ops.filter((o) => o[0] === "fillRect").length;
    const before = fillRects();
    drawLoop(h, 0.2);
    assertEqual(h.tracker.lowZoom.state.nodes, 0, "nothing is painted for nodes the canvas does not draw");
    assertEqual(fillRects(), before, "and no rectangles appear behind the DOM nodes");
  });


  test("the rule is a zoom, not a node size: a huge node and a tiny one get the same answer", async () => {
    const h = await boot();
    h.window.devicePixelRatio = 1;
    // One node 1200 units wide, one 40 units wide, both at zoom 0.10 — 120px and
    // 4px on screen. Under a per-node pixel rule these are two different
    // decisions; under a zoom rule they are the same node.
    bigGraph(h, 8, 0.1);
    h.canvas.nodes[0].size = [1200, 600];
    h.canvas.nodes[1].size = [40, 20];

    h.tracker.lowZoom.set({ flatBelow: 0.05 }); // below the zoom: nothing is flat
    h.canvas.ctx.ops.length = 0;
    drawLoop(h, 0.2);
    assertEqual(h.tracker.lowZoom.state.nodes, 0, "at zoom 0.10 with the setting at 5%, not even the 4px node is flattened");

    h.tracker.lowZoom.set({ flatBelow: 0.2 }); // above it: everything is
    h.canvas.ctx.ops.length = 0;
    const draws = drawLoop(h, 0.2);
    assertEqual(h.tracker.lowZoom.state.nodes, 8 * draws, "every node is a rectangle, including the 120px one");
    assertEqual(
      h.canvas.ctx.ops.filter((o) => o[0] === "roundRect").length,
      0,
      "and none of the node chrome that a size rule would have kept on the big node"
    );
    assert(h.tracker.lowZoom.limits.flatZoom.includes(0.5), "the ladder is zooms, and it goes to 50%");
    const plan = h.tracker.lowZoom.state.plan;
    assertEqual(plan.total, 8, "the plan counts the graph");
    assertEqual(plan.flat, 8, "and how much of it is flat — no sampling, it is one decision per frame");
    assertGreater(plan.medPx, 0, "while still reporting what a typical node measures on screen here");
    assertEqual(h.tracker.lowZoom.flat.belowZoom, 0.2, "the API says which zoom the flat state starts below");
    assertEqual(h.tracker.lowZoom.flat.on, true, "and that it is on");

    // The panel says it in the same terms.
    h.advance(FRAME_MS);
    h.canvas.setDirty(true, true);
    h.canvas.draw();
    await openTweaksTab(h);
    assertIncludes(panelText(h), "is below your 20% setting", "the panel names the zoom and the setting");
    assertIncludes(panelText(h), "flat nodes below 20% zoom", "and the control reads as a zoom");
  });

  test("a node that changes its own size cannot flicker in and out of the flat state", async () => {
    const h = await boot();
    h.window.devicePixelRatio = 1;
    // What a JS node with dynamic UI does: it greys or hides a widget and its
    // own size changes — from 500 units wide to 60 — while the camera stands
    // still. A pixel threshold sees a different node after the change; the zoom
    // does not move, so neither does the decision.
    bigGraph(h, 4, 0.5); // 200 units x 0.5 = 100px on screen
    h.canvas.nodes[0].widgets = [
      { name: "inactive", element: h.document.createElement("div"), options: {} },
    ];
    h.tracker.lowZoom.set({ flatBelow: 0.2 }); // zoom 0.5 is above it: full detail
    drawLoop(h, 0.2);
    assertEqual(h.tracker.lowZoom.state.nodes, 0, "drawing in full at this zoom");

    h.canvas.nodes[0].size = [60, 30]; // the node's own UI just shrank itself to 30px on screen
    h.advance(1100); // let the once-a-second DOM sweep run over the changed node
    drawLoop(h, 0.2);
    assertEqual(h.tracker.lowZoom.state.nodes, 0, "and it stays in full: the zoom did not cross the setting");
    assertEqual(h.tracker.lowZoom.dom.hidden, 0, "its DOM content is not hidden either");
    assertEqual(h.canvas.nodes[0].widgets[0].options.hideOnZoom, undefined, "and its widget's own setting is untouched");

    // Zoom out past the setting and everything flips, once.
    h.canvas.ds.scale = 0.1;
    const before = h.tracker.lowZoom.state.nodes;
    const out = drawLoop(h, 0.2);
    assertEqual(h.tracker.lowZoom.state.nodes - before, 4 * out, "below the setting every node is flat, whatever it measures");
    assertEqual(h.tracker.lowZoom.flat.on, true);
    // And back.
    h.canvas.ds.scale = 0.5;
    const flatCount = h.tracker.lowZoom.state.nodes;
    drawLoop(h, 0.2);
    assertEqual(h.tracker.lowZoom.state.nodes, flatCount, "and zooming back in restores every node");
  });

  test("a v2.1.8 pixel setting is carried over once, and the panel says why", async () => {
    const h = await boot();
    // A record in the shape v2.1.8 wrote: minPx, no flatBelow.
    h.localStorage.setItem("ants.lowZoom.v1", JSON.stringify({ minPx: 64, detailZoom: 0.6, thumbZoom: 0.6, idleCapMs: 500, linkStyle: "auto" }));
    const h2 = await boot({ storage: h.localStorage });
    assertEqual(h2.tracker.lowZoom.state.flatBelow, 0.2, "64px on a typical 350px node is 18% of the zoom, so 20%");
    assertEqual(h2.tracker.lowZoom.state.detailZoom, 0.6, "the rest of the record carried over untouched");
    assertEqual(h2.tracker.lowZoom.state.idleCapMs, 500);
    assertEqual(h2.tracker.lowZoom.flat.carriedOverFromPx, 64, "and the old number is kept for the note");

    bigGraph(h2, 4, 0.1);
    drawLoop(h2, 0.2);
    await openTweaksTab(h2);
    const text = panelText(h2);
    assertIncludes(text, "carried over from v2.1.8", "the panel explains itself rather than silently changing a setting");
    assertIncludes(text, "nodes under 64px", "quoting the old setting");
    assertIncludes(text, "dynamic UIs", "and why the rule changed");

    // Choosing a value is what dismisses the note.
    h2.tracker.lowZoom.set({ flatBelow: 0.15 });
    assertEqual(h2.tracker.lowZoom.state.flatBelow, 0.15, "a setting off the ladder is snapped to the nearest zoom");
    assertEqual(h2.tracker.lowZoom.flat.carriedOverFromPx, 0, "and the note is gone");
    h2.advance(600); // the open panel refreshes on its own timer
    await h2.flush();
    await openTweaksTab(h2);
    assert(!panelText(h2).includes("carried over from v2.1.8"), "the panel no longer mentions it");
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


  test("links keep their curves below the zoom, and lose their ink instead", async () => {
    const h = await boot();
    h.window.devicePixelRatio = 1;
    bigGraph(h, 6, 0.1);
    h.tracker.lowZoom.set({ detailZoom: 0.6 });
    h.canvas.ctx.ops.length = 0;
    drawLoop(h, 0.1);

    assertGreater(h.canvas.linkSettings.length, 0, "links were rendered");
    assert(
      h.canvas.linkSettings.every((s) => s.width === 1 && s.border === false),
      "every one of them 1px wide, with no outline stroke"
    );
    const beziers = h.canvas.ctx.ops.filter((o) => o[0] === "bezierCurveTo").length;
    assertGreater(beziers, 0, "and still drawn as splines: the shape of the link is not what changes");
    assertEqual(h.tracker.lowZoom.detail.thinLinks, h.canvas.linkDraws, "the panel counts them");
    assertEqual(h.canvas.connections_width, 3, "the canvas setting is put back after the call");
    assertEqual(h.canvas.render_connections_border, true, "both of them");

    // Zoomed in past the threshold, nothing is degraded.
    const before = h.canvas.linkSettings.length;
    h.canvas.ds.scale = 0.8;
    drawLoop(h, 0.1);
    const after = h.canvas.linkSettings.slice(before);
    assert(after.length > 0, "links were rendered at 80% zoom too");
    assert(after.every((s) => s.width === 3 && s.border === true), "and drawn the way ComfyUI draws them");
    assertEqual(h.tracker.lowZoom.detail.on, false, "the panel says so");

    // With the node setting flattening the graph as well, the links are still
    // curves and the readout still describes the thinning as ink only: the two
    // settings do not reach into each other's subject any more.
    h.canvas.ds.scale = 0.1;
    h.tracker.lowZoom.set({ flatBelow: 0.2 });
    drawLoop(h, 0.1);
    drawLoop(h, 0.1);
    await openTweaksTab(h);
    const text = panelText(h);
    assertIncludes(text, "changes link ink and nothing else", "the panel describes the thinning by what it changes");
    assert(!text.includes("straight-line path"), "and never mentions a path the node setting used to be able to switch on");
  });

  test("the panel separates link ink from the frontend's own per-link bookkeeping", async () => {
    const h = await boot();
    h.window.devicePixelRatio = 1;
    // A connections stage that costs far more than the strokes inside it: this
    // is the shape of the real page (the frontend walks every input slot of
    // every node, whichever links are on screen).
    h.canvas.costs = { background: 0.1, connections: 6, chrome: 0.2, link: 0.5 };
    bigGraph(h, 12, 0.1);
    h.tracker.lowZoom.set({ detailZoom: 1, flatBelow: 0 }); // thin the ink, keep the curves
    drawLoop(h, 1.2);
    assertGreater(h.tracker.lowZoom.state.linkCalls, 0, "links were drawn");
    assertGreater(h.tracker.lowZoom.state.linkMs, 0, "and the ink was timed");

    await openTweaksTab(h);
    h.advance(600);
    await h.flush();
    const text = panelText(h);
    assertIncludes(text, "the strokes themselves are", "the panel splits the connections stage");
    assertIncludes(
      text,
      "walking every input slot of every node",
      "and names what the rest of it is, so no ink setting is credited with it"
    );
    assertIncludes(text, "a link ink setting can only reach the first part", "stated as a limit, not a promise");
  });

  test("the measure button compares the link setting against itself, on this page", async () => {
    const h = await boot();
    h.window.devicePixelRatio = 1;
    // Thinned frames are cheap; full-ink frames are not. The measurement has to
    // find that difference without being told about it.
    bigGraph(h, 8, 0.1);
    // The canvas charges for ink by the stroke: 3px with a dark outline under it
    // costs several times what a 1px outline-free stroke does (see tests/harness).
    h.canvas.costs = { background: 0, connections: 0, chrome: 0, link: 0.5 };
    h.tracker.lowZoom.set({ detailZoom: 1, flatBelow: 0 });
    h.advance(2200); // the baseline window the readout compares against
    h.advance(2200);
    const ab = h.tracker.lowZoom.measureLinks();
    assertEqual(ab.on.frames, 0, "the measurement starts with nothing counted");
    // Three on/off pairs, one second each. The harness clock only moves when a
    // test moves it, so frames are drawn by hand.
    for (let i = 0; i < 24; i++) {
      h.advance(650);
      h.canvas.setDirty(true, true);
      h.canvas.draw();
    }
    assert(h.tracker.lowZoom.state.ab.done, "the measurement finishes on its own");
    assertGreater(h.tracker.lowZoom.state.ab.on.frames, 0, "thinned frames were counted");
    assertGreater(h.tracker.lowZoom.state.ab.off.frames, 0, "and full-ink frames too");
    assertEqual(h.tracker.lowZoom.state.detailZoom, 1, "the setting is put back exactly as it was");
    await openTweaksTab(h);
    h.advance(600);
    await h.flush();
    assertIncludes(panelText(h), "thinning measured on this page", "and the panel reports the verdict");
    assertIncludes(panelText(h), "ms/frame", "with numbers");
    const done = h.tracker.lowZoom.state.ab;
    assert(
      done.on.ms / Math.max(1, done.on.frames) < done.off.ms / Math.max(1, done.off.frames),
      "and the cheaper half is the thinned one, which is what it was asked to find out"
    );
  });

  test("link thinning changes link ink and nothing else about the frame", async () => {
    const h = await boot();
    h.window.devicePixelRatio = 1;
    bigGraph(h, 4, 0.1);
    h.tracker.lowZoom.set({ detailZoom: 1, flatBelow: 0 }); // ink only: every node drawn in full
    h.canvas.nodeLowQuality.length = 0;
    h.canvas.linkSettings.length = 0;
    h.canvas.ctx.ops.length = 0;
    drawLoop(h, 0.2);

    assertGreater(h.canvas.linkSettings.length, 0, "links were drawn");
    assert(
      h.canvas.linkSettings.every((s) => s.width === 1 && s.border === false),
      "thinner, without their outline: the one thing this setting is for"
    );
    assertGreater(h.canvas.nodeLowQuality.length, 0, "nodes were drawn by LiteGraph's own path");
    assert(
      h.canvas.nodeLowQuality.every((v) => v === false),
      "and not one of them inside a borrowed low-quality frame — the flag that paints nodes half-flat is not this setting's to touch"
    );
    assertEqual(h.canvas._isLowQuality, false, "the canvas flag itself is exactly as ComfyUI left it");
    assertEqual(h.tracker.lowZoom.state.nodes, 0, "nothing was flattened");
    assertEqual(h.tracker.lowZoom.dom.hidden, 0, "and no DOM content was hidden");
    assertGreater(h.canvas.nodeDraws, 0, "LiteGraph's own node path ran for every node");
    assertGreater(h.canvas.ctx.ops.filter((o) => o[0] === "bezierCurveTo").length, 0, "and the curves are still curves");

    // And the readout says so, in those words.
    h.advance(FRAME_MS);
    h.canvas.setDirty(true, true);
    h.canvas.draw();
    await openTweaksTab(h);
    const text = panelText(h);
    assertIncludes(text, "changes link ink and nothing else", "the panel makes the promise explicit");
    assertIncludes(text, "exactly as ComfyUI left them", "and spells out what it does not touch");
  });

  test("the DOM content of a boxed node is hidden, and comes back when it is not a box", async () => {
    const h = await boot();
    h.window.devicePixelRatio = 1;
    bigGraph(h, 2, 0.1); // 200 units x 0.1 = 20px on screen
    // A DOM widget the way an extension adds one: an element inside a .dom-widget
    // wrapper that ComfyUI positions over the canvas.
    const wrapper = h.document.createElement("div");
    wrapper.className = "dom-widget";
    const inner = h.document.createElement("canvas");
    wrapper.appendChild(inner);
    h.document.body.appendChild(wrapper);
    h.canvas.nodes[0].widgets = [{ name: "preview", element: inner }];
    // And a Vue-rendered node, whose whole visual is one DOM element.
    const vueRoot = h.document.createElement("div");
    vueRoot.setAttribute("data-node-id", "7");
    h.document.body.appendChild(vueRoot);
    h.canvas.nodes[1].id = 7;
    h.app.graph._nodes = h.canvas.nodes;

    assertEqual(h.tracker.lowZoom.dom.hidden, 0, "nothing is hidden while nothing is boxed");
    h.tracker.lowZoom.set({ flatBelow: 0.2 });
    assertEqual(h.tracker.lowZoom.dom.hidden, 2, "both the widget and the Vue node are hidden");
    assertEqual(h.tracker.lowZoom.dom.nodes, 2, "belonging to two boxed nodes");
    assert(wrapper.classList.contains("ants-lod-box"), "the widget is hidden through its .dom-widget wrapper");
    assert(vueRoot.classList.contains("ants-lod-box"), "and the Vue node by its own element");

    // Zoom in far enough that the node is worth drawing properly again.
    h.canvas.ds.scale = 0.5; // 200 x 0.5 = 100px > 32px
    drawLoop(h, 0.1);
    assertEqual(h.tracker.lowZoom.dom.hidden, 0, "nothing is hidden at a readable zoom");
    assert(!wrapper.classList.contains("ants-lod-box"), "the widget is visible again");
    assert(!vueRoot.classList.contains("ants-lod-box"), "so is the Vue node");

    // And turning the mode off clears whatever is left.
    h.canvas.ds.scale = 0.1;
    h.tracker.lowZoom.set({ flatBelow: 0.2, detailZoom: 0.6 });
    drawLoop(h, 0.1);
    assertGreater(h.tracker.lowZoom.dom.hidden, 0, "boxed again");
    h.tracker.lowZoom.off();
    assertEqual(h.tracker.lowZoom.dom.hidden, 0, "nothing of somebody else's page is left hidden");
    assert(!wrapper.classList.contains("ants-lod-box"));
  });


  // ------------------------------------------------------- viewport focus ---
  // Two claims to hold: below the zoom node *widgets* stop answering the pointer
  // (and a 3D viewport stops being hovered, which is when it renders), while the
  // nodes themselves stay selectable, draggable and editable; and off-screen node
  // DOM is boxed and inert at any zoom, coming back on a budget rather than all at
  // once, because coming back is the expensive direction.

  test("node widgets stop answering the pointer below the zoom, and the nodes themselves do not", async () => {
    const h = await boot();
    h.window.devicePixelRatio = 1;
    bigGraph(h, 4, 0.1);
    const wrapper = h.document.createElement("div");
    wrapper.className = "dom-widget";
    const inner = h.document.createElement("canvas");
    wrapper.appendChild(inner);
    h.document.body.appendChild(wrapper);
    h.canvas.nodes[0].widgets = [{ name: "viewport", element: inner, options: {} }];

    // Off by default: nothing is switched off, and the frontend's own node
    // hit-test is left exactly as the frontend wrote it.
    h.tracker.lowZoom.set({ inertBelow: 0 });
    const first = h.canvas.graph.getNodeOnPos(10, 10, h.canvas.nodes);
    assert(first && first.type === "KSampler", "the node under the cursor is found as usual");
    assert(!wrapper._cls.has("ants-lod-inert"), "and nothing is switched off in the DOM");

    // Below the zoom the widget UI goes, and only the widget UI.
    h.tracker.lowZoom.set({ inertBelow: 0.4 });
    assertEqual(h.tracker.lowZoom.focus.inertOn, true, "the zoom is below the setting");
    assert(
      wrapper._cls.has("ants-lod-inert"),
      "the node's DOM widget is switched off \u2014 no hover reporting, no tooltip, no click, no drag onto it, no wheel capture"
    );
    assertGreater(h.tracker.lowZoom.focus.inertElements, 0, "and it is counted");
    const second = h.canvas.graph.getNodeOnPos(10, 10, h.canvas.nodes);
    assert(second && second.type === "KSampler", "but the node itself is still found: it selects, drags and edits as before");

    // The panel's own node is never switched off, whatever the zoom.
    const ownWrapper = h.document.createElement("div");
    ownWrapper.className = "dom-widget";
    const ownInner = h.document.createElement("canvas");
    ownWrapper.appendChild(ownInner);
    h.document.body.appendChild(ownWrapper);
    const own = { type: "ANTsNastyBastardsTracker", pos: [0, 0], size: [200, 100], selected: false, widgets: [{ name: "panel", element: ownInner, options: {} }] };
    h.canvas.nodes.push(own);
    h.canvas.graph._nodes = h.canvas.nodes;
    h.tracker.lowZoom.sweep();
    assert(!ownWrapper._cls.has("ants-lod-inert"), "this tool's own node stays usable at every zoom");

    // Above the zoom everything is live again.
    h.canvas.ds.scale = 0.5;
    h.tracker.lowZoom.set({ inertBelow: 0.4 });
    assertEqual(h.tracker.lowZoom.focus.inertOn, false, "above the setting nothing is inert");
    assert(!wrapper._cls.has("ants-lod-inert"), "and the class is gone");

    // Switching the mode off gives the page back untouched.
    h.canvas.ds.scale = 0.1;
    h.tracker.lowZoom.off();
    assertEqual(h.tracker.lowZoom.state.inertBelow, 0, "the setting is off");
    assertEqual(h.tracker.lowZoom.focus.inertElements, 0, "and nothing is left switched off");
    assert(!wrapper._cls.has("ants-lod-inert"));
  });

  test("the panel says what focus mode is doing, in the same terms the test uses", async () => {
    const h = await boot();
    h.window.devicePixelRatio = 1;
    bigGraph(h, 4, 0.1);
    h.tracker.lowZoom.set({ inertBelow: 0.4, fovea: true });
    drawLoop(h, 0.2);
    await openTweaksTab(h);
    const text = panelText(h);
    assertIncludes(text, "node widgets switched off below 40% zoom", "the panel names the mode and the zoom");
    assertIncludes(text, "stay selectable", "and promises what it does not take away");
    assertIncludes(text, "foveated:", "and reports the off-screen half");
    assertIncludes(text, "display scale:", "with the display-scale check it ran at startup");
    assertIncludes(text, "the viewport maths agree", "saying whether the two agree");
  });

  test("focus mode reaches a 3D viewport, which has no element for a node to point at", async () => {
    const h = await boot();
    h.window.devicePixelRatio = 1;
    bigGraph(h, 3, 0.1);
    // The shape the core 3D nodes use: a ComponentWidgetImpl in the DOM widget
    // layer, with nothing on the widget object that points at its DOM. This is the
    // case that was missed before: a sweep that walks node.widgets cannot see it.
    const viewer = { name: "model_file", type: "load3D", component: {}, options: {} };
    h.canvas.nodes[0].widgets = [viewer];
    const layer = h.document.createElement("div");
    layer._attrs = { "data-testid": "dom-widgets" };
    const wrapper = h.document.createElement("div");
    wrapper.className = "dom-widget size-full";
    const pos = h.canvas.nodes[0].pos;
    wrapper.style.left = `${(pos[0] + h.canvas.ds.offset[0]) * h.canvas.ds.scale}px`;
    wrapper.style.top = `${(pos[1] + h.canvas.ds.offset[1]) * h.canvas.ds.scale}px`;
    layer.appendChild(wrapper);
    h.document.body.appendChild(layer);

    // The node-flattening setting is off: this is focus mode's own doing, and it
    // hides as well as inertes \u2014 a hidden element cannot be clicked, hovered or
    // scrolled onto however the page sets its own pointer-events.
    h.tracker.lowZoom.set({ flatBelow: 0, inertBelow: 0.4 });
    assert(!h.tracker.lowZoom.state.flatBelow, "the node setting is off");
    assert(
      wrapper._cls.has("ants-lod-inert"),
      "the viewport's wrapper is switched off, and a viewport that cannot be hovered stops rendering its scene"
    );
    assert(wrapper._cls.has("ants-lod-box"), "and hidden outright, which is what makes it unreachable");

    h.canvas.ds.scale = 0.5;
    h.tracker.lowZoom.sweep();
    assert(!wrapper._cls.has("ants-lod-inert"), "and above the zoom it is handed back");
  });

  test("foveated: off-screen node DOM is boxed and inert at any zoom, and comes back on a budget", async () => {
    const h = await boot();
    h.window.devicePixelRatio = 1;
    bigGraph(h, 4, 1); // 100% zoom: the node setting plays no part in this
    h.canvas.nodes.forEach((n, i) => {
      n.pos = [i * 300, 100];
    });
    h.canvas.nodes[3].pos = [9000, 4000]; // several screens away
    const wraps = [];
    const inners = [];
    for (let i = 0; i < 4; i++) {
      const w = h.document.createElement("div");
      w.className = "dom-widget";
      const inner = h.document.createElement("canvas");
      w.appendChild(inner);
      h.document.body.appendChild(w);
      wraps.push(w);
      inners.push(inner);
    }
    h.canvas.nodes.forEach((n, i) => {
      n.widgets = [{ name: "preview", element: inners[i], options: {} }];
    });
    h.canvas.ds.offset[0] = 0;
    h.canvas.ds.offset[1] = 0;
    // Half a screen of margin is the default: the harness canvas is 1600x900 at
    // 100% zoom, so "far" starts at 2400 graph units to the right.
    assertEqual(h.tracker.lowZoom.focus.margin, 0.5, "the default margin is half a screen");

    h.tracker.lowZoom.set({ flatBelow: 0, fovea: true });
    assertEqual(h.tracker.lowZoom.state.flatBelow, 0, "no node is flattened: this is not the node setting");
    assert(!wraps[0]._cls.has("ants-lod-box"), "the node on screen keeps its DOM content");
    assert(wraps[3]._cls.has("ants-lod-box"), "the node several screens away is boxed");
    assert(wraps[3]._cls.has("ants-lod-inert"), "and switched off: off screen is off in both directions");
    assertEqual(h.tracker.lowZoom.focus.foveaElements, 1, "one element, and the panel counts it");

    // The margin is the safety, and it is measured from the visible area: a node
    // just past the right edge is inside the margin, so it is left alone.
    h.canvas.nodes[3].pos = [1700, 100];
    h.canvas.setDirty(true, true);
    h.canvas.draw();
    assert(!wraps[3]._cls.has("ants-lod-box"), "just off screen is still drawn in full \u2014 it is about to be visible");

    // Two nodes come back into the margin band together: they are handed back one
    // per drawn frame, so the rest stays boxed while the frames go by.
    assertEqual(h.tracker.lowZoom.focus.restorePerFrame, 1, "one element per drawn frame is the default");
    h.canvas.nodes[2].pos = [9000, 4000];
    h.canvas.nodes[3].pos = [9000, 4000];
    h.canvas.setDirty(true, true);
    h.canvas.draw();
    assertEqual(h.tracker.lowZoom.focus.foveaElements, 2, "both are far, and both are boxed");
    h.canvas.nodes[3].pos = [2100, 100];
    h.canvas.nodes[2].pos = [2300, 100];
    h.canvas.setDirty(true, true);
    h.canvas.draw();
    assertEqual(
      h.tracker.lowZoom.focus.foveaElements,
      1,
      "one comes back per drawn frame \u2014 the rest stays boxed, which is what makes the saving worth having"
    );
    assertEqual(h.tracker.lowZoom.focus.queued, 1, "and the panel can say how many are waiting");
    h.canvas.setDirty(true, true);
    h.canvas.draw();
    assertEqual(h.tracker.lowZoom.focus.foveaElements, 0, "the next frame hands the other one back");
    assertGreater(h.tracker.lowZoom.focus.cameBack, 0, "and the count of handbacks moved");

    // Nothing that is on screen ever waits: a boxed node that comes back into
    // view is handed back immediately, whatever the budget says.
    h.canvas.nodes[2].pos = [9000, 4000];
    h.canvas.nodes[3].pos = [2200, 100];
    h.canvas.setDirty(true, true);
    h.canvas.draw();
    assertEqual(h.tracker.lowZoom.focus.foveaElements, 1, "one far node is boxed again");
    h.canvas.nodes[3].pos = [400, 100]; // straight into the visible area
    h.canvas.nodes[2].pos = [2200, 100]; // and one in the margin, queued
    h.tracker.lowZoom.set({ foveaRestore: 1 });
    h.canvas.setDirty(true, true);
    h.canvas.draw();
    assert(!wraps[3]._cls.has("ants-lod-box"), "the one on screen is back at once \u2014 a visible widget is never left blank");

    // And it survives a reload with the other settings.
    h.tracker.lowZoom.set({ foveaMargin: 1, foveaRestore: 4 });
    const h2 = await boot({ storage: h.localStorage });
    assertEqual(h2.tracker.lowZoom.state.fovea, true, "the foveated toggle is remembered");
    assertEqual(h2.tracker.lowZoom.focus.margin, 1, "with the margin it was saved with");
    assertEqual(h2.tracker.lowZoom.focus.restorePerFrame, 4, "and the rate elements are handed back at");
  });

  test("a pan does not re-walk the page: the DOM is discovered on a budget, not per frame", async () => {
    const h = await boot();
    h.window.devicePixelRatio = 1;
    bigGraph(h, 30, 1);
    // Thirty wrappers in the frontend's DOM widget layer, one per node — the shape
    // a graph full of 3D viewers or custom node UIs has.
    const layer = h.document.createElement("div");
    layer._attrs = { "data-testid": "dom-widgets" };
    h.document.body.appendChild(layer);
    h.canvas.nodes.forEach((n) => {
      const w = h.document.createElement("div");
      w.className = "dom-widget";
      layer.appendChild(w);
      n._wrap = w;
    });
    const place = () =>
      h.canvas.nodes.forEach((n) => {
        n._wrap.style.left = `${(n.pos[0] + h.canvas.ds.offset[0]) * h.canvas.ds.scale}px`;
        n._wrap.style.top = `${(n.pos[1] + h.canvas.ds.offset[1]) * h.canvas.ds.scale}px`;
      });
    place();
    h.tracker.lowZoom.set({ flatBelow: 0, fovea: true });
    const base = h.document._qsaCalls;
    // Pan, move the wrappers the way the frontend does, draw. Time does not
    // advance, so the once-a-second sweep does not come around: what is measured
    // is the cost of a pan.
    for (let i = 0; i < 40; i++) {
      h.canvas.ds.offset[0] -= 120;
      place();
      h.canvas.setDirty(true, true);
      h.canvas.draw();
    }
    const spent = h.document._qsaCalls - base;
    // One sweep at most: the setting change lands before the first drawn frame, so
    // the frame after it re-reads the page once and then never again.
    assertLess(spent, 4, `40 drawn frames of panning cost ${spent} page queries, not one per frame`);
    assertGreater(
      h.tracker.lowZoom.focus.foveaElements,
      0,
      "and the panning still boxes what went off screen, from the registry the sweep built"
    );

    // Pan back: the nodes on screen are handed back at once, the rest on the
    // budget, and it converges.
    // 4800 units out, 4800 back: the same viewport as before the pan.
    for (let i = 0; i < 48; i++) {
      h.canvas.ds.offset[0] += 100;
      place();
      h.canvas.setDirty(true, true);
      h.canvas.draw();
    }
    assertEqual(h.tracker.lowZoom.focus.foveaElements, 0, "with the screen back where it started, nothing is left boxed");
    assertLess(
      h.document._qsaCalls - base,
      4,
      "and the way back cost no per-frame page queries either: what the frames do is arithmetic over what the sweep found"
    );
  });

  // The two halves that no CSS class can reach, and the page the first v2.1.13
  // report came from: widgets drawn on the canvas, and a 3D viewport whose render
  // loop hangs off the *node's* hover flag rather than off the DOM.

  test("canvas widgets stop answering the pointer below the zoom, while the node still selects", async () => {
    const h = await boot();
    h.window.devicePixelRatio = 1;
    h.canvas.ds.scale = 0.1;
    h.canvas.ds.offset[0] = 0;
    h.canvas.ds.offset[1] = 0;
    // A slider: drawn on the canvas, hit-tested by arithmetic, not an element.
    const slider = { name: "steps", last_y: 10, computedHeight: 20 };
    const n = h.node({ pos: [0, 0], size: [200, 100], widgets: [slider] });
    h.canvas.nodes = [n];
    h.canvas.graph._nodes = h.canvas.nodes;

    assertEqual(n.getWidgetOnPos(100, 20), slider, "the widget is hit-tested normally while the mode is off");
    assertEqual(h.tracker.lowZoom.focus.canvasWidgetsBlocked, 0, "and nothing is counted");

    h.tracker.lowZoom.set({ inertBelow: 0.4 });
    h.canvas.setDirty(true, true);
    h.canvas.draw(); // the gates are re-checked on the sweep, and installed per frame
    assertEqual(n.getWidgetOnPos(100, 20), undefined, "below the zoom the same point finds no widget: no click, no drag, no hover report");
    assertEqual(h.canvas.graph.getNodeOnPos(100, 20), n, "and the node under it is still found \u2014 selection and dragging are untouched");
    assertGreater(h.tracker.lowZoom.focus.canvasWidgetsBlocked, 0, "the block is counted, so the panel can show it");
    assertGreater(h.tracker.lowZoom.focus.canvasWidgetsSeen, 0, "against the calls it saw");

    // Above the zoom, the widget answers again.
    h.canvas.ds.scale = 0.5;
    h.tracker.lowZoom.set({ inertBelow: 0.4 });
    assertEqual(n.getWidgetOnPos(100, 20), slider, "above the setting the widget is live again");

    // The foveated half reaches the canvas widgets too: at any zoom, a node that
    // is off screen does not answer either \u2014 nothing is there to point at.
    const far = h.node({ pos: [9000, 4000], size: [200, 100], widgets: [{ name: "steps", last_y: 10, computedHeight: 20 }] });
    h.canvas.nodes.push(far);
    h.canvas.graph._nodes = h.canvas.nodes;
    h.tracker.lowZoom.set({ inertBelow: 0, fovea: true });
    h.canvas.setDirty(true, true);
    h.canvas.draw();
    assertEqual(far.getWidgetOnPos(9100, 4020), undefined, "a node several screens away answers no widget");
    assertEqual(n.getWidgetOnPos(100, 20), slider, "while the node on screen is untouched");

    // Switching it off hands the widget back.
    h.canvas.ds.scale = 0.1;
    h.tracker.lowZoom.off();
    assertEqual(n.getWidgetOnPos(100, 20), slider, "and switching the mode off restores the method");
  });

  test("a 3D viewport's hover flag never goes true while its node is switched off", async () => {
    const h = await boot();
    h.window.devicePixelRatio = 1;
    h.canvas.ds.scale = 0.1;
    h.canvas.ds.offset[0] = 0;
    h.canvas.ds.offset[1] = 0;
    const n = h.node({ pos: [0, 0], size: [200, 100] });
    // The shape the core 3D nodes use: the extension chains the node's mouse
    // hooks, and the viewport's render loop asks whether the pointer is over it.
    let onNode = false;
    n.onMouseEnter = () => {
      onNode = true;
      n.enters++;
    };
    n.onMouseLeave = () => {
      onNode = false;
      n.leaves++;
    };
    h.canvas.nodes = [n];
    h.canvas.graph._nodes = h.canvas.nodes;

    // Mode off: the canvas's own hover path reaches the node as usual.
    h.canvas.hover(50, 50);
    assertEqual(onNode, true, "with the mode off the node is told the pointer is over it");

    // Mode on, at a zoom where nobody can use the viewport: the same hover path
    // must not reach it, because that flag is what makes it render a frame.
    h.canvas.node_over = undefined;
    n.mouseOver = null;
    n.onMouseLeave(); // the pointer leaves, the way the canvas reports it
    assertEqual(onNode, false, "nothing is hovered before the mode is switched on");
    h.tracker.lowZoom.set({ inertBelow: 0.4 });
    h.canvas.setDirty(true, true);
    h.canvas.draw();
    const before = n.enters;
    h.canvas.hover(50, 50);
    assertEqual(n.enters, before, "the enter hook is held back");
    assertEqual(onNode, false, "so the viewport's flag never becomes true and its render loop stays idle");
    assertGreater(h.tracker.lowZoom.focus.hoverBlocked, 0, "and the panel can count what was held back");

    // Hovering and *then* switching the mode on: the leave is forced, so a flag
    // that was already true cannot stay stuck.
    h.tracker.lowZoom.off();
    h.canvas.setDirty(true, true);
    h.canvas.draw(); // a frame with the mode off clears what it had held back
    h.canvas.hover(50, 50);
    assertEqual(onNode, true, "hovered while the mode is off");
    h.tracker.lowZoom.set({ inertBelow: 0.4 });
    h.canvas.setDirty(true, true);
    h.canvas.draw();
    assertEqual(onNode, false, "switching the mode on tells the node the pointer is gone");
    assertGreater(n.leaves, 0, "with an actual leave call, which is what clears the flag");
  });

  test("a node's DOM is hidden below the zoom even when its owner cannot be worked out", async () => {
    const h = await boot();
    h.window.devicePixelRatio = 1;
    h.canvas.ds.scale = 0.1;
    bigGraph(h, 4, 0.1);
    // A wrapper in the page whose position matches no node at all: the maths that
    // resolves ownership cannot place it, which on a page with an unexpected
    // display scale is exactly what happens. The focus half does not need to know
    // which node it belongs to, so it must still be switched off.
    const orphan = h.document.createElement("div");
    orphan.className = "dom-widget size-full";
    orphan.style.left = "12345px";
    orphan.style.top = "6789px";
    h.document.body.appendChild(orphan);

    h.tracker.lowZoom.set({ flatBelow: 0, inertBelow: 0.4 });
    assert(orphan._cls.has("ants-lod-box"), "it is hidden");
    assert(orphan._cls.has("ants-lod-inert"), "and inert");

    h.canvas.ds.scale = 0.5;
    h.tracker.lowZoom.sweep();
    assert(!orphan._cls.has("ants-lod-box"), "and it comes back above the zoom");

    // The other way round: with only the foveated half on, an element whose owner
    // is unknown is left alone, because that decision needs a node to measure.
    h.canvas.ds.scale = 0.1;
    h.tracker.lowZoom.set({ inertBelow: 0, fovea: true });
    h.tracker.lowZoom.sweep();
    assert(!orphan._cls.has("ants-lod-box"), "the off-screen half does not guess at ownership");
  });

  test("the event gate swallows what is aimed at a switched-off element, and nothing else", async () => {
    const h = await boot();
    h.window.devicePixelRatio = 1;
    h.canvas.ds.scale = 0.1;
    bigGraph(h, 4, 0.1);
    const wrapper = h.document.createElement("div");
    wrapper.className = "dom-widget";
    const button = h.document.createElement("button");
    wrapper.appendChild(button);
    h.document.body.appendChild(wrapper);
    h.canvas.nodes[0].widgets = [{ name: "viewport", element: button, options: {} }];
    let clicks = 0;
    button.addEventListener("click", () => {
      clicks++;
    });

    // Off: the click arrives.
    button._fire("click");
    assertEqual(clicks, 1, "with the mode off the page's own handlers run");

    h.tracker.lowZoom.set({ inertBelow: 0.4 });
    button._fire("click");
    assertEqual(clicks, 1, "and with the mode on the click never reaches them, whatever the CSS says");
    assertGreater(h.tracker.lowZoom.focus.eventsBlocked, 0, "it is counted");

    // A click somewhere else in the page is not this tool's business.
    const other = h.document.createElement("button");
    h.document.body.appendChild(other);
    let otherClicks = 0;
    other.addEventListener("click", () => {
      otherClicks++;
    });
    h.tracker.lowZoom.set({ inertBelow: 0.4 });
    other._fire("click");
    assertEqual(otherClicks, 1, "an element that is not a node's DOM is left completely alone");

    // And the canvas keeps working: the gate is blind to anything not marked.
    h.canvas.ds.scale = 0.1;
    h.tracker.lowZoom.off();
    button._fire("click");
    assertEqual(clicks, 2, "switching the mode off hands the page back");
  });

  test("the display-scale check reads the screen, and the viewport maths stays in CSS pixels", async () => {
    const h = await boot();
    // A 4K Windows display at 200%: the canvas backing store is twice the box the
    // element occupies, which is exactly what a maths that divides by the backing
    // store gets wrong.
    h.window.devicePixelRatio = 2;
    h.canvas.canvas.width = 3200;
    h.canvas.canvas.height = 1800;
    h.canvas.ds.scale = 1;
    h.canvas.ds.offset[0] = 0;
    h.canvas.ds.offset[1] = 0;
    // The frontend's own visible area, in CSS pixels, like the real one.
    h.canvas.visible_area = [0, 0, 1600, 900];
    let probe = h.tracker.lowZoom.checkDisplay();
    assertEqual(probe.win, 2, "the browser's own answer is 2x");
    assertEqual(probe.backing, 2, "and the canvas backing store agrees");
    assertEqual(probe.factor, 1, "the frontend's visible area agrees with our own computation");
    assertEqual(probe.unit, "css", "so its rectangle is in CSS pixels, and nothing needs correcting");

    // The case the check exists for: a frontend that reported its visible area in
    // device pixels. The maths must use the CSS box, not the reported number.
    h.canvas.visible_area = [0, 0, 3200, 1800];
    probe = h.tracker.lowZoom.checkDisplay();
    assertEqual(probe.factor, 2, "the disagreement is reported as a factor of two");
    assertEqual(probe.unit, "device-pixel", "and named as the unit mismatch it is");
    bigGraph(h, 2, 1);
    h.canvas.nodes[1].pos = [2600, 100]; // inside the reported rectangle, off the real one (and past the half-screen margin)
    const w = h.document.createElement("div");
    w.className = "dom-widget";
    const inner = h.document.createElement("canvas");
    w.appendChild(inner);
    h.document.body.appendChild(w);
    h.canvas.nodes[1].widgets = [{ name: "preview", element: inner, options: {} }];
    h.tracker.lowZoom.set({ flatBelow: 0, fovea: true });
    assert(
      w._cls.has("ants-lod-box"),
      "a node the frontend's own rectangle would call visible is treated as off screen \u2014 because it is"
    );

    // And the manual override is there for anyone who disagrees with the read.
    h.tracker.lowZoom.set({ displayScale: 1.5 });
    probe = h.tracker.lowZoom.checkDisplay();
    assertEqual(probe.manual, 1.5, "a pinned scale is used instead of the browser's");
    assertEqual(probe.effective, 1.5, "and it is what the maths divides the backing store by");
    h.tracker.lowZoom.set({ displayScale: 0 });
  });

  test("a boxed node's DOM widget also stops being laid out every frame, and gets its own setting back", async () => {
    const h = await boot();
    h.window.devicePixelRatio = 1;
    bigGraph(h, 2, 0.1);
    const wrapper = h.document.createElement("div");
    wrapper.className = "dom-widget";
    const inner = h.document.createElement("canvas");
    wrapper.appendChild(inner);
    h.document.body.appendChild(wrapper);
    // An image preview: ComfyUI registers these with hideOnZoom false precisely
    // because a picture is worth seeing while zoomed out.
    const widget = { name: "preview", element: inner, options: { hideOnZoom: false } };
    h.canvas.nodes[0].widgets = [widget];

    h.tracker.lowZoom.set({ flatBelow: 0.2 });
    assertEqual(widget.options.hideOnZoom, true, "the store is told to skip it while its node is a rectangle");
    assertEqual(h.tracker.lowZoom.dom.widgets.length, 1, "the widget itself is exposed, not just a count");
    assertEqual(h.tracker.lowZoom.dom.markedWidgets, 1, "and it is counted as flagged");
    // The frontend only honours that flag in its own low-quality mode — which is
    // exactly what this tracker must not switch on to hide a widget, so the
    // panel must not claim the widget is out of the per-frame pass when it is
    // not.
    assertEqual(h.tracker.lowZoom.dom.stilled, 0, "but nothing is claimed while the frontend's own low-quality mode is off");
    h.canvas._isLowQuality = true; // the frontend's own LOD, switched on by the user
    h.tracker.lowZoom.sweep();
    assertEqual(h.tracker.lowZoom.dom.stilled, 1, "with the frontend's LOD on, the flag is what is doing the hiding");
    h.canvas._isLowQuality = false;

    // Zoom in: the widget is the frontend's business again.
    h.canvas.ds.scale = 0.5;
    drawLoop(h, 0.1);
    assertEqual(widget.options.hideOnZoom, false, "its own answer is restored");
    assertEqual(h.tracker.lowZoom.dom.stilled, 0);

    // A widget that already asked to hide on zoom is left exactly as it was.
    const own = { name: "text", element: inner, options: { hideOnZoom: true } };
    h.canvas.nodes[0].widgets = [own];
    h.canvas.ds.scale = 0.1;
    h.tracker.lowZoom.set({ flatBelow: 0.2 });
    drawLoop(h, 0.1);
    assertEqual(own.options.hideOnZoom, true, "unchanged while boxed");
    assertEqual(h.tracker.lowZoom.dom.stilled, 0, "and not claimed as work this tool did");
    h.canvas.ds.scale = 0.5;
    drawLoop(h, 0.1);
    assertEqual(own.options.hideOnZoom, true, "still unchanged after zooming in");

    // Switching the mode off hands everything back.
    h.canvas.ds.scale = 0.1;
    h.canvas.nodes[0].widgets = [widget];
    h.tracker.lowZoom.set({ flatBelow: 0.2 });
    h.tracker.lowZoom.off();
    assertEqual(widget.options.hideOnZoom, false, "nothing of somebody else's widget options is left changed");
  });


  test("link style is its own setting: curves can be kept while the graph is flattened", async () => {
    const h = await boot();
    h.window.devicePixelRatio = 1;
    bigGraph(h, 6, 0.1); // 20px nodes at zoom 0.1: everything is a rectangle
    h.tracker.lowZoom.set({ flatBelow: 0.2, detailZoom: 0.6, linkStyle: "spline" });
    h.canvas.ctx.ops.length = 0;
    h.canvas.linkSettings.length = 0;
    drawLoop(h, 0.1);

    assertGreater(h.canvas.linkSettings.length, 0, "links were rendered");
    assert(
      h.canvas.linkSettings.every((s) => s.width === 1 && s.border === false),
      "thinned, because the link setting asks for curves"
    );
    assertGreater(
      h.canvas.ctx.ops.filter((o) => o[0] === "bezierCurveTo").length,
      0,
      "and drawn as curves even though the whole graph is rectangles"
    );
    assertEqual(h.tracker.lowZoom.state.links, 0, "nothing took the straight-line path");
    assertEqual(h.tracker.lowZoom.state.linkStyle, "spline");

    // "straight" is the explicit opt-in, and it wins over thinning.
    h.tracker.lowZoom.set({ linkStyle: "straight" });
    h.canvas.ctx.ops.length = 0;
    drawLoop(h, 0.1);
    assertEqual(h.canvas.ctx.ops.filter((o) => o[0] === "bezierCurveTo").length, 0, "no curves when straight is asked for");
    assertGreater(h.tracker.lowZoom.state.links, 0, "the straight path did the drawing");

    // The old "auto" answer is gone: asking for it means curves, and the panel
    // says the setting changed hands rather than silently reinterpreting it.
    h.tracker.lowZoom.set({ linkStyle: "auto" });
    assertEqual(h.tracker.lowZoom.state.linkStyle, "spline", "an \"auto\" link setting becomes \"keep every curve\"");
    assertEqual(h.tracker.lowZoom.flat.autoLinkCarried, true, "and it is flagged for the panel");
    await openTweaksTab(h); // opens the panel and builds the tab
    h.advance(600);
    await h.flush();
    h.canvas.setDirty(true, true);
    h.canvas.draw();
    assertIncludes(panelText(h), "waiting to be picked", "the panel explains it");
    // Picking a value is what dismisses it.
    h.tracker.lowZoom.set({ linkStyle: "spline" });
    assertEqual(h.tracker.lowZoom.flat.autoLinkCarried, false, "choosing dismisses it");
    // The panel refreshes its own readout on a timer; let it run once.
    h.advance(600);
    await h.flush();
    h.canvas.setDirty(true, true);
    h.canvas.draw();
    assert(!panelText(h).includes("waiting to be picked"), "and the note is gone");

    // With flattening off, curves are what you get, and nothing about that
    // changes because the node setting moved.
    h.tracker.lowZoom.set({ flatBelow: 0 });
    h.canvas.ctx.ops.length = 0;
    h.canvas.linkSettings.length = 0;
    drawLoop(h, 0.1);
    assertGreater(h.canvas.ctx.ops.filter((o) => o[0] === "bezierCurveTo").length, 0, "curves with the node setting off");
  });

  test("a component widget with no element at all is hidden through the frontend's DOM widget layer", async () => {
    const h = await boot();
    h.window.devicePixelRatio = 1;
    bigGraph(h, 2, 0.1);
    h.canvas.ds.offset[0] = 0;
    h.canvas.ds.offset[1] = 0;
    // What the core 3D nodes put on screen: a wrapper in the DOM widget layer,
    // positioned at its node's origin (client pixels: the canvas is at 0,0 in
    // this harness), holding the Vue component. Nothing on the widget object
    // points at it.
    const layer = h.document.createElement("div");
    const wrapper = h.document.createElement("div");
    wrapper.className = "dom-widget size-full";
    const { left, top } = (() => {
      const pos = h.canvas.nodes[1].pos;
      const scale = h.canvas.ds.scale;
      return { left: (pos[0] + h.canvas.ds.offset[0]) * scale, top: (pos[1] + h.canvas.ds.offset[1]) * scale };
    })();
    wrapper.style.left = `${left}px`;
    wrapper.style.top = `${top}px`;
    layer.appendChild(wrapper);
    h.document.body.appendChild(layer);
    // The tracker finds it by the attribute the frontend puts on that layer.
    layer._attrs = { "data-testid": "dom-widgets" };

    h.tracker.lowZoom.set({ flatBelow: 0.2 });
    assert(wrapper._cls.has("ants-lod-box"), "the wrapper is hidden with the same class as any other DOM content");
    assertEqual(h.tracker.lowZoom.dom.layer, 1, "and it is counted separately from the element-backed widgets");
    assertEqual(h.tracker.lowZoom.dom.hidden, 1, "it is part of the total hidden count");

    // Zoom back in: the wrapper comes back, because the node is drawn in full.
    h.canvas.ds.scale = 0.5;
    h.tracker.lowZoom.sweep();
    assert(!wrapper._cls.has("ants-lod-box"), "and it is handed back the moment the node is");
    assertEqual(h.tracker.lowZoom.dom.layer, 0);
  });

  test("a Vue-component widget (a 3D viewport) is boxed too, without needing an element handle", async () => {
    const h = await boot();
    h.window.devicePixelRatio = 1;
    bigGraph(h, 2, 0.1);
    // The shape the core 3D nodes use: a ComponentWidgetImpl has no `element` —
    // the frontend renders its wrapper — so the only handle is the widget.
    const viewer = { name: "model_file", type: "load3D", component: {}, options: {} };
    h.canvas.nodes[0].widgets = [viewer];

    h.tracker.lowZoom.set({ flatBelow: 0.2 });
    assertEqual(viewer.options.hideOnZoom, true, "the widget is told to stand down while its node is a rectangle");
    assertEqual(h.tracker.lowZoom.dom.markedWidgets, 1, "and it is counted, element or no element");

    h.canvas.ds.scale = 0.5;
    drawLoop(h, 0.1);
    assertEqual(viewer.options.hideOnZoom, undefined, "the option it never had is removed again, not set to false");
    assertEqual(h.tracker.lowZoom.dom.markedWidgets, 0);
  });

  test("the drawing settings are the user's, and survive a reload", async () => {
    const h = await boot();
    h.tracker.lowZoom.set({ flatBelow: 0.3, detailZoom: 0.4, thumbZoom: 0.8, idleCapMs: 500, linkStyle: "spline" });
    const saved = h.localStorage.getItem("ants.lowZoom.v1");
    assert(saved, "the choice is written down");
    assertIncludes(saved, "\"spline\"");

    // A second page load with the same storage: the same settings are in effect
    // before anything draws, and the panel's controls show them.
    const h2 = await boot({ storage: h.localStorage });
    assertEqual(h2.tracker.lowZoom.state.flatBelow, 0.3, "the zoom threshold came back");
    assertEqual(h2.tracker.lowZoom.state.detailZoom, 0.4, "so did the link thinning");
    assertEqual(h2.tracker.lowZoom.state.thumbZoom, 0.8, "and the previews");
    assertEqual(h2.tracker.lowZoom.state.idleCapMs, 500, "and the idle cap");
    assertEqual(h2.tracker.lowZoom.state.linkStyle, "spline", "and the link style");
    await openTweaksTab(h2);
    assertIncludes(panelText(h2), "links: keep every curve", "the control reflects it, so the panel is not lying about the state");

    // "Back to full drawing" is the way back to an untouched page.
    h2.tracker.lowZoom.off();
    const h3 = await boot({ storage: h2.localStorage });
    assertEqual(h3.tracker.lowZoom.state.flatBelow, 0, "nothing is re-enabled after a reset");
    assertEqual(h3.tracker.lowZoom.state.thumbZoom, 0, "including the previews");
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
    h.tracker.lowZoom.set({ flatBelow: 0.2 });
    drawLoop(h, 0.2);
    h.canvas.min_font_size_for_lod = 0; // the frontend's own LOD is switched off
    h.canvas.low_quality = false;
    await openTweaksTab(h); // the tab is built when it is opened, so this reads the current state
    const text = panelText(h);
    assertIncludes(text, "culling cannot save anything here", "the panel draws the conclusion, not just the number");
    assertIncludes(text, "frontend LOD is switched off", "and names the frontend's own LOD switch instead of leaving it hidden");
    assertIncludes(text, "flat nodes below 20% zoom", "and shows what the mode is set to");
    assertIncludes(text, "node draw", "with the saving measured by the tracker itself");
  });
});
