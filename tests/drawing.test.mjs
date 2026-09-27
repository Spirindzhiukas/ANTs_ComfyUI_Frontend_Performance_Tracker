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
    const titles = h.canvas.ctx.ops.filter((o) => o[0] === "roundRect" || o[0] === "bezierCurveTo").length;
    assertEqual(titles, 0, "and none of the chrome that makes a node readable at a zoom where it is not");
  });

  test("links are drawn as straight lines while most of the graph is that small, and properly again when zoomed in", async () => {
    const h = await boot();
    h.canvas.costs = { background: 0.2, connections: 1.0, chrome: 0.5, link: 0.4 };
    bigGraph(h, 20, 0.1);
    h.tracker.lowZoom.set({ flatBelow: 0.2 });
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
      h.canvas.ctx.ops.filter((o) => o[0] === "roundRect" || o[0] === "bezierCurveTo").length,
      0,
      "and none of the chrome that a size rule would have kept on the big node"
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

    // With flattening on and most of the graph rectangles, links are taken over
    // by the straight-line path — which is a different thing from the thinning
    // setting doing nothing, and the panel has to say so.
    h.canvas.ds.scale = 0.1;
    h.tracker.lowZoom.set({ flatBelow: 0.2 });
    drawLoop(h, 0.1);
    drawLoop(h, 0.1);
    await openTweaksTab(h);
    const text = panelText(h);
    assertIncludes(text, "straight-line path", "the panel names the path links are actually on");
    assertIncludes(text, "the thinning setting applies", "and says how to see the thinning instead");
  });

  test("the frontend's own low-quality rendering is borrowed for the frame, then handed back", async () => {
    const h = await boot();
    bigGraph(h, 4, 0.1);
    h.canvas._isLowQuality = false;
    h.tracker.lowZoom.set({ detailZoom: 0.6 });
    h.canvas.nodeLowQuality.length = 0;
    drawLoop(h, 0.1);
    assertGreater(h.canvas.nodeLowQuality.length, 0, "nodes were drawn");
    assert(h.canvas.nodeLowQuality.every((v) => v === true), "each one inside the low-quality frame");
    assertEqual(h.canvas._isLowQuality, false, "and the flag is back where the frontend left it");
    assertEqual(h.tracker.lowZoom.detail.lowQualityForced, true, "the panel says the low-quality path is in use");

    // A frontend that does not expose the flag is reported, not assumed.
    const h2 = await boot();
    bigGraph(h2, 4, 0.1);
    delete h2.canvas._isLowQuality;
    h2.tracker.lowZoom.set({ detailZoom: 0.6 });
    drawLoop(h2, 0.1);
    assertEqual(h2.tracker.lowZoom.detail.lowQualityAvailable, false, "this frontend cannot be put in that mode");
    assertGreater(h2.canvas.linkSettings.length, 0, "links are still degraded, which does not need the flag");
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
    assertEqual(h.tracker.lowZoom.dom.stilled, 1, "and the panel counts it");
    assertEqual(h.tracker.lowZoom.dom.widgets.length, 1, "the widget itself is exposed, not just a count");

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

    // "auto" is the old behaviour: straight only because most of the graph is flat.
    h.tracker.lowZoom.set({ linkStyle: "auto" });
    h.canvas.ctx.ops.length = 0;
    drawLoop(h, 0.1);
    assertEqual(h.canvas.ctx.ops.filter((o) => o[0] === "bezierCurveTo").length, 0, "auto goes straight while the graph is rectangles");
    // With flattening off there is nothing to be straightened for.
    h.tracker.lowZoom.set({ flatBelow: 0 });
    h.canvas.ctx.ops.length = 0;
    h.canvas.linkSettings.length = 0;
    drawLoop(h, 0.1);
    assertGreater(h.canvas.ctx.ops.filter((o) => o[0] === "bezierCurveTo").length, 0, "and curves come back with the threshold at 0");
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
    assertEqual(h.tracker.lowZoom.dom.stilled, 1, "and it is counted, element or no element");

    h.canvas.ds.scale = 0.5;
    drawLoop(h, 0.1);
    assertEqual(viewer.options.hideOnZoom, undefined, "the option it never had is removed again, not set to false");
    assertEqual(h.tracker.lowZoom.dom.stilled, 0);
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
