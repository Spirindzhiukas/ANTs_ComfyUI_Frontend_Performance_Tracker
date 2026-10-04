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
    const tweaks = buttons.find((b) => {
      const t = String(b.textContent).toLowerCase();
      return t.includes("rendering") || t.includes("tweaks");
    });
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
  test("a fresh install replaces nodes below 50%, and off restores LiteGraph's own drawing", async () => {
    const h = await boot();
    assertEqual(h.tracker.lowZoom.state.flatBelow, 0.5, "the default zoom is 50%");
    assertEqual(h.tracker.lowZoom.state.snapOn, true, "and the stand-in is a picture of the node");
    assertEqual(h.tracker.lowZoom.state.snapRatio, 1, "captured at 1x");
    assertEqual(h.tracker.lowZoom.state.thumbZoom, 0, "the separate image-preview ladder is retired");
    bigGraph(h, 12);
    h.tracker.lowZoom.set({ flatBelow: 0, snapshots: false });
    drawLoop(h, 0.2);
    assertEqual(h.tracker.lowZoom.state.nodes, 0, "off means nothing is replaced");
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
    h.tracker.lowZoom.set({ flatBelow: 0, snapshots: false }); // the baseline is a full draw
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
    assertIncludes(panelText(h), "Replace node previews with bitmap stand-ins at zoom levels", "and the control is named for what it does");
    assertIncludes(panelText(h), "below 20%", "and it reads as a zoom");
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

  test("an image preview is not given a second thumbnail path", async () => {
    const h = await boot();
    h.window.devicePixelRatio = 1;
    const img = { naturalWidth: 4096, naturalHeight: 3072 };
    bigGraph(h, 1, 1);
    h.canvas.links = [];
    h.canvas.nodes[0].type = "LoadImage";
    h.canvas.nodes[0].img = img;
    h.canvas.nodes[0].onDrawBackground = function (ctx) {
      ctx.drawImage(this.img, 0, 0, 400, 300);
    };
    h.canvas.costs.chrome = 0.01;
    // The old ladder is ignored. A live node draws its own image.
    h.tracker.lowZoom.set({ flatBelow: 0, snapshots: false, thumbZoom: 1 });
    oneFrame(h);
    await h.flush();
    assertEqual(h.imageBitmaps.length, 0, "no second copy of the preview is asked for");
    assertEqual(h.tracker.lowZoom.state.thumbZoom, 0, "and the setting cannot be turned back on");
    const drawn = h.canvas.ctx.ops.filter((o) => o[0] === "drawImage");
    assert(drawn.some((o) => o[1] === img), "the node's own image is what gets drawn");
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
    assert(vueRoot.hasAttribute("data-ants-dom-hidden"), "and the Vue node by an attribute Vue does not rewrite");

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

  // ------------------------------------------------- the node's own controls --
  // The pill on the tracker's node is the one piece of UI that has to survive every
  // setting: it is where the master switch lives. And the switch has to be a real
  // off — not a quieter tracker, but a page that is ComfyUI's own again.

  test("the floating pill: a switch and a gear, and neither goes away when the tool is switched off", async () => {
    const h = await boot();
    h.window.devicePixelRatio = 1;
    const pill = h.document.getElementById("ants-corner-pill");
    assert(pill, "the floating pill is on the page from the moment the tracker starts");
    assert(pill._cls.has("ants-own"), "and marked as this tool's own");
    const buttons = pill.children.filter((c) => c.tagName === "BUTTON");
    assertEqual(buttons.length, 2, "two controls in the one frame");
    assert(buttons[0]._cls.has("ants-node-btn-tick"), "the switch first");
    assert(buttons[1]._cls.has("ants-node-btn-gear"), "the gear after");
    assertEqual(h.document.getElementById("ants-corner-btn"), buttons[1], "the button that always opened the panel is the gear");

    // The gear opens the panel; it is not the switch.
    buttons[1]._fire("click");
    await h.flush();
    assert(h.panel() && h.panel()._cls.has("open"), "clicking the gear opens the panel");
    assertEqual(h.tracker.lowZoom.enabled, true, "and does not switch anything off");

    // The switch switches, and nothing of this tool's UI goes anywhere.
    buttons[0]._fire("click");
    assertEqual(h.tracker.lowZoom.enabled, false, "the floating switch turns the hooks and the optimisations off");
    assert(!pill._cls.has("ants-lod-box") && !pill._cls.has("ants-lod-inert"), "neither control is hidden or made inert");
    assert(!pill._cls.has("ants-hidden-by-switch"), "and the pill is not taken off the screen");
    assertEqual(buttons[0].getAttribute("aria-checked"), "false", "the switch reads off");
    assert(h.panel() && h.panel()._cls.has("open"), "the panel that was open stays open");

    buttons[0]._fire("click");
    assertEqual(h.tracker.lowZoom.enabled, true, "and the same switch turns it back on");
    assertEqual(buttons[0].getAttribute("aria-checked"), "true", "reading on again");
    assert(pill._cls.has("ants-own"), "still this tool's own");
  });

  test("dragging the floating pill moves it and flips nothing", async () => {
    const h = await boot();
    h.window.devicePixelRatio = 1;
    const pill = h.document.getElementById("ants-corner-pill");
    const tick = pill.children.filter((c) => c.tagName === "BUTTON")[0];

    // A press, a hold past the long-press threshold, a move, a release: the pill's
    // own drag, then the click the browser delivers afterwards.
    pill._fire("mousedown", { clientX: 100, clientY: 100 });
    h.advance(400);
    h.window.fire("mousemove", { clientX: 140, clientY: 130 });
    h.window.fire("mouseup", {});
    assert(pill.style.top !== "" || pill.style.left !== "", "the pill was moved");

    tick._fire("click");
    assertEqual(h.tracker.lowZoom.enabled, true, "the drag did not flip the switch it started on");
    assert(!h.panel() || !h.panel()._cls.has("open"), "and did not open the panel either");
  });

  test("the node's pill: a switch and a gear, and no low-zoom sweep may touch it", async () => {
    const h = await boot();
    h.window.devicePixelRatio = 1;
    // The node the extension builds its UI on.
    const NodeType = h.registerNodeType("ANTsNastyBastardsTracker");
    const node = h.makeNode(NodeType);
    node.pos = [0, 0];
    node.size = [200, 100];
    node.onNodeCreated();
    assertEqual(node.resizable, true, "the graph node is resizable");
    node.size = [480, 320];
    const kept = node.computeSize();
    assertGreater(kept[0], 400, "a width the user set is not snapped back");
    assertGreater(kept[1], 280, "nor is the height — both axes");
    node.onResize([480, 360]);
    assert(h.panel() && h.panel().parentNode === node._antsHost, "a large node holds the settings, so they can reflow with it");
    assert(h.panel()._cls.has("ants-docked"), "and the panel is docked, not a second copy");
    node.onResize([200, 40]);
    assert(h.panel().parentNode === h.document.body, "shrinking the node floats the panel again");
    // A normal node next to it, with a DOM widget of its own: the sweep needs
    // something it *is* allowed to switch off, or "it left ours alone" proves
    // nothing.
    const other = h.node({ pos: [400, 0], size: [200, 100] });
    const otherWrap = h.document.createElement("div");
    otherWrap.className = "dom-widget";
    const otherInner = h.document.createElement("canvas");
    otherWrap.appendChild(otherInner);
    h.document.body.appendChild(otherWrap);
    other.widgets = [{ name: "preview", element: otherInner, options: {} }];
    h.canvas.nodes = [node, other];
    h.canvas.graph._nodes = h.canvas.nodes;

    const widget = (node._domWidgets || [])[0];
    assert(widget, "the node got a DOM widget for its controls");
    const pill = widget.element;
    const wrapper = widget.wrapper;
    assert(pill._cls.has("ants-own"), "the pill is marked as this tool's own");
    assert(pill._cls.has("ants-node-pill"), "and is the pill that frames the two controls");
    const buttons = pill.children.filter((c) => c.tagName === "BUTTON");
    assertEqual(buttons.length, 2, "two controls: the switch first, the gear after");
    assert(buttons[0]._cls.has("ants-node-btn-tick"), "the first is the switch");
    assert(buttons[1]._cls.has("ants-node-btn-gear"), "the second is the gear");
    assertEqual(widget.options.hideOnZoom, false, "the frontend's own low-quality mode is told to keep it");

    // Every setting on, zoomed out, and the node off screen to boot: the pill is
    // exactly the element every other rule in this file would hide.
    h.canvas.ds.scale = 0.1;
    node.pos = [9000, 4000];
    h.tracker.lowZoom.set({ flatBelow: 0.5, inertBelow: 0.6, fovea: true });
    h.canvas.setDirty(true, true);
    h.canvas.draw();
    const focus = h.tracker.lowZoom.focus;
    assertGreater(focus.inertElements + h.tracker.lowZoom.dom.hidden, 0, "the sweep did switch other things off");
    assert(otherWrap._cls.has("ants-lod-box"), "the ordinary node's widget is the thing it switched off");
    const floatPill = h.document.getElementById("ants-corner-pill");
    assert(floatPill, "the floating pill exists");
    assert(!floatPill._cls.has("ants-lod-box") && !floatPill._cls.has("ants-lod-inert"), "and the sweep did not touch that either");
    assert(!pill._cls.has("ants-lod-box"), "the pill is not hidden");
    assert(!pill._cls.has("ants-lod-inert"), "and not made inert");
    assert(!wrapper._cls.has("ants-lod-box"), "nor is the wrapper the frontend put it in");
    assert(!wrapper._cls.has("ants-lod-inert"), "which is the element a class would land on");
    assertEqual(
      focus.blockedElements,
      1,
      "and the only element in the gate's set is the other node's widget \u2014 never this tool's own"
    );

    // Which means the switch still works: the event gate does not swallow it and
    // the click reaches the handler.
    h.tracker.lowZoom.setEnabled(true);
    buttons[0]._fire("click");
    assertEqual(h.tracker.lowZoom.enabled, false, "clicking the switch turns the tracker off");

    // And it is the way back.
    buttons[0]._fire("click");
    assertEqual(h.tracker.lowZoom.enabled, true, "and clicking it again turns it back on");
    assertEqual(h.tracker.lowZoom.state.flatBelow, 0.5, "with the settings untouched");
    assertEqual(h.tracker.lowZoom.state.inertBelow, 0.6);
    assertEqual(h.tracker.lowZoom.focus.fovea, true);
    h.tracker.lowZoom.off();
  });

  test("switching the tracker off leaves the page to ComfyUI, and switching it on restores the settings", async () => {
    const h = await boot();
    h.window.devicePixelRatio = 1;
    bigGraph(h, 6, 0.1);
    const wrapper = h.document.createElement("div");
    wrapper.className = "dom-widget";
    const inner = h.document.createElement("canvas");
    wrapper.appendChild(inner);
    h.document.body.appendChild(wrapper);
    h.canvas.nodes[0].widgets = [{ name: "preview", element: inner, options: {} }];

    h.tracker.lowZoom.set({ flatBelow: 0.2, detailZoom: 0.6, inertBelow: 0.4, fovea: true });
    drawLoop(h, 0.2);
    assert(h.tracker.lowZoom.on, "the settings are in force");
    assert(wrapper._cls.has("ants-lod-box"), "and they are doing something to the page");
    assertLess(h.canvas.linkSettings.slice(-1)[0].width, 3, "links are being drawn thin");

    // Off.
    assertEqual(h.tracker.lowZoom.setEnabled(false), false, "the switch takes effect");
    assertEqual(h.tracker.lowZoom.on, false, "nothing in the drawing settings is in force any more");
    assert(!wrapper._cls.has("ants-lod-box"), "and what was hidden is handed back");
    assert(!wrapper._cls.has("ants-lod-inert"), "including the inert half");
    assertEqual(h.tracker.lowZoom.focus.blockedElements, 0, "the event gate's set is empty");
    assertEqual(h.tracker.lowZoom.state.flatBelow, 0.2, "while the settings themselves are untouched");

    // Nothing is measured, nothing is deferred, nothing is drawn differently.
    const before = h.tracker.totals;
    drawLoop(h, 0.5);
    assertEqual(h.tracker.totals.frames, before.frames, "no frame is recorded while it is off");
    assertEqual(h.tracker.totals.hookCalls, before.hookCalls, "and no wrapped hook is being timed");
    assertEqual(h.tracker.lowZoom.state.ab, null, "and no measurement is running");
    assertEqual(h.canvas.linkSettings.slice(-1)[0].width, 3, "links are drawn at ComfyUI's own width again");
    // Even at a zoom below the focus setting, with the tool off, a widget on a node
    // answers: the gate passes everything through.
    const real = h.node({ pos: [0, 0], size: [200, 100], widgets: [{ name: "steps", last_y: 10, computedHeight: 20 }] });
    h.canvas.nodes.push(real);
    h.canvas.graph._nodes = h.canvas.nodes;
    h.canvas.setDirty(true, true);
    h.canvas.draw();
    assertEqual(real.getWidgetOnPos(100, 20), real.widgets[0], "and a node's own widget answers again \u2014 nothing of this tool's is in the way");

    // On again: the same settings, in force.
    assertEqual(h.tracker.lowZoom.setEnabled(true), true, "switched back on");
    h.canvas.ds.scale = 0.1;
    drawLoop(h, 0.2);
    assert(h.tracker.lowZoom.on, "the settings are in force again");
    assert(wrapper._cls.has("ants-lod-box"), "and are hiding what they were hiding");
    assertLess(h.canvas.linkSettings.slice(-1)[0].width, 3, "and thinning the links again");
    h.tracker.lowZoom.off();
  });

  test("the panel says what the switch means, and its own button drives it", async () => {
    const h = await boot();
    h.window.devicePixelRatio = 1;
    bigGraph(h, 4, 0.1);
    await openTweaksTab(h); // built while the tool is still on
    h.tracker.lowZoom.setEnabled(false);
    await h.flush();
    const text = panelText(h);
    assertIncludes(text, "The hooks and the optimisations are switched off.", "the panel says so plainly");
    assertIncludes(text, "turns them back on with exactly the settings you had", "and says how to get back");
    assertIncludes(text, "⏻ On", "with the header button offering it");
    assertEqual(h.tracker.lowZoom.enabled, false, "and the API agrees");

    // The header button is the same switch.
    const power = h.panel().descendants().find((n) => n.textContent === "⏻ On");
    assert(power, "the button is on screen");
    power._fire("click");
    assertEqual(h.tracker.lowZoom.enabled, true, "clicking it switches the tracker back on");
    assertIncludes(panelText(h), "⏻ Off", "and the button offers the other direction again");
  });

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
    assertEqual(h2.tracker.lowZoom.state.thumbZoom, 0, "the separate preview setting is retired and not restored");
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
    assertIncludes(text, "below 20%", "and shows what the mode is set to");
    assertIncludes(text, "node draw", "with the saving measured by the tracker itself");
  });
});

// A flat box that says nothing is a placeholder the user cannot read: at 10% zoom
// a node with a validation error looks exactly like a healthy one, and a muted
// node looks exactly like a live one. This ladder lets a box carry marks that
// come from the node's own fields. Four promises:
//   1. `plain` (the default) paints exactly what v2.1.16 painted;
//   2. each level adds only its own marks, and never changes which nodes are flat;
//   3. every mark comes from a field the frontend itself reads — an error stroke
//      at its own width and padding, a progress bar at its own width, its own
//      dimming alphas — so a box cannot claim something the node does not say;
//   4. switching it back to plain, or the master switch off, restores the exact
//      previous paint.
suite("drawing: a flat box can say what it stands for, and only when asked", () => {
  // Nodes with the fields the marks come from. `bigGraph`'s nodes are bare
  // objects, which is all the flat path reads.
  function markedGraph(h, extras) {
    h.canvas.ds.scale = 0.1;
    h.canvas.ds.offset[0] = 0;
    h.canvas.ds.offset[1] = 0;
    h.canvas.links = [];
    h.canvas.nodes = [
      { type: "KSampler", pos: [0, 0], size: [200, 100], selected: false, color: "#3f6f9f", bgcolor: "#2b2b2b" },
      { type: "KSampler", pos: [240, 0], size: [200, 100], selected: false, color: "#7f3f3f", bgcolor: "#2b2b2b", has_errors: true },
      { type: "KSampler", pos: [480, 0], size: [200, 100], selected: false, color: "#3f9f6f", bgcolor: "#2b2b2b", progress: 0.5 },
      { type: "KSampler", pos: [720, 0], size: [200, 100], selected: false, color: "#6f6f6f", bgcolor: "#2b2b2b", mode: 2 },
      { type: "KSampler", pos: [960, 0], size: [200, 100], selected: false, color: "#6f6f3f", bgcolor: "#2b2b2b", mode: 4 },
      { type: "KSampler", pos: [1200, 0], size: [200, 100], selected: false, color: "#9f3f9f", bgcolor: "#2b2b2b", flags: { ghost: true } },
    ];
    Object.assign(h.canvas.nodes[0], extras || {});
  }

  // The ops of one frame, and the alpha each fillRect ran at.
  function paint(h, zoom = 0.1) {
    h.canvas.ds.scale = zoom;
    h.canvas.ctx.ops.length = 0;
    h.canvas.setDirty(true, true);
    const alphas = [];
    const ctx = h.canvas.ctx;
    const realFill = ctx.fillRect;
    ctx.fillRect = function (...args) {
      alphas.push(this.globalAlpha);
      return realFill.apply(this, args);
    };
    h.canvas.draw();
    ctx.fillRect = realFill;
    return { ops: ctx.ops.slice(), alphas };
  }
  const count = (ops, name) => ops.filter((o) => o[0] === name).length;

  test("plain is the default, and it is exactly what v2.1.16 painted", async () => {
    const h = await boot();
    markedGraph(h);
    // The stand-in default is a picture. This test is about the painted fill, so the picture is off.
    h.tracker.lowZoom.set({ flatBelow: 0, snapshots: false });
    drawLoop(h, 0.2);
    assertEqual(h.tracker.lowZoom.state.boxDetail, "plain", "a box says nothing until it is asked to");
    assert(h.tracker.lowZoom.limits.boxDetail.includes("state"), "and the ladder is offered in full");

    h.tracker.lowZoom.set({ flatBelow: 0.2 });
    const on = paint(h);
    // One fill per node and nothing else: no title bar, no error ring, no bar,
    // no dimming — the marks are what the level above adds.
    assertEqual(count(on.ops, "fillRect"), 6, "one rectangle per node, exactly as before");
    assertEqual(count(on.ops, "strokeRect"), 0, "and no strokes: an error or a selection would be one");
    assert(on.alphas.every((a) => a === 1), "and nothing is drawn dimmed");
    assertEqual(h.tracker.lowZoom.state.boxTitles, 0, "the counters agree that no marks were drawn");
    assertEqual(h.tracker.lowZoom.state.boxErrors, 0);
    assertEqual(h.tracker.lowZoom.state.boxBars, 0);
    assertEqual(h.tracker.lowZoom.state.boxMuted, 0);
    assertGreater(h.canvas.nodeDraws, 0, "and the nodes were still drawn, by LiteGraph, in the frames before the setting");
  });

  test("`title` adds the node's own title bar, above the body where LiteGraph draws it", async () => {
    const h = await boot();
    markedGraph(h);
    h.tracker.lowZoom.set({ flatBelow: 0.2, boxDetail: "title" });
    const frame = paint(h);
    const fills = frame.ops.filter((o) => o[0] === "fillRect");
    assertEqual(fills.length, 12, "one body plus one title bar per node");
    const titles = fills.filter((o) => o[2] < 0); // drawn at a negative y: above the body
    assertEqual(titles.length, 6, "and every title bar sits above its node, not inside it");
    assertEqual(titles[1][4], 30, "at LiteGraph's own title height (30 graph units)");
    assertEqual(titles[1][3], 200, "as wide as the node it stands for");
    assertEqual(h.tracker.lowZoom.state.boxTitles, 6, "counted, so the panel can price it");
    assertEqual(h.tracker.lowZoom.state.boxErrors, 0, "and nothing else came with it");
    assertEqual(h.tracker.lowZoom.state.boxBars, 0);
    assertEqual(h.tracker.lowZoom.state.boxMuted, 0);
    // Nothing about *which* nodes are flat changed: the ladder is not a threshold.
    assertEqual(h.tracker.lowZoom.flat.flatNodes, 6, "every node is still a box");
    // And a short node is not nothing but title.
    h.canvas.nodes = [{ type: "KSampler", pos: [0, 0], size: [200, 20], selected: false, color: "#3f6f9f" }];
    const small = paint(h).ops.filter((o) => o[0] === "fillRect" && o[2] < 0);
    assertEqual(small[0][4], 8, "a 20-unit-tall node gets an 8-unit title bar, clamped to two fifths of it");
  });

  test("`state` adds the frontend's own error stroke, progress bar and dimming", async () => {
    const h = await boot();
    markedGraph(h);
    h.tracker.lowZoom.set({ flatBelow: 0.2, boxDetail: "state" });
    const frame = paint(h);

    // The error ring: the frontend's own colour, width and padding (LGraphNode
    // draws `has_errors` as a stroke 10 units wide, 12 units outside the node).
    const ring = frame.ops.filter((o) => o[0] === "strokeRect" && o[1] === -12);
    assertEqual(ring.length, 1, "the one node with has_errors gets a ring");
    assertEqual(ring[0][2], -12, "starting 12 units outside the box");
    assertEqual(ring[0][3], 224, "and 24 units wider than the node (200 + 12 + 12)");
    assertEqual(h.canvas.ctx.strokeStyle, "#E00", "in LiteGraph's own error colour");
    assertEqual(h.tracker.lowZoom.state.boxErrors, 1, "counted");

    // The progress bar: the frontend draws it from the top-left, `progress` wide.
    const bars = frame.ops.filter((o) => o[0] === "fillRect" && o[1] === 0 && o[2] === 0 && o[3] < 200 && o[3] > 0);
    assertEqual(bars.length, 1, "the one node that reports progress gets a bar");
    assertEqual(bars[0][3], 100, "half of its width, which is the progress it reported");
    assertEqual(h.tracker.lowZoom.state.boxBars, 1, "counted");

    // Dimming: the frontend's own alphas, read from the node's own fields. Each
    // dimmed node contributes its body and its title bar, so a node is two fills.
    const dim = frame.alphas.filter((a) => a < 1);
    const dimNodes = (alpha) => dim.filter((a) => a === alpha).length / 2;
    assertEqual(dim.length, 6, "the muted, bypassed and ghosted nodes draw dimmed, body and title");
    assertEqual(dimNodes(0.4), 1, "a muted node at the frontend's 0.4");
    assertEqual(dimNodes(0.2), 1, "a bypassed node at 0.2");
    assertEqual(dimNodes(0.3), 1, "a ghosted node at 0.3");
    assertEqual(h.tracker.lowZoom.state.boxMuted, 3, "counted per node, not per fill");

    // A node that is fine, running, or muted is never given a mark it did not ask
    // for: no error ring on the running node, no bar on the healthy one.
    assertEqual(frame.ops.filter((o) => o[0] === "strokeRect" && o[1] === -12).length, 1, "one error ring, not six");
  });

  test("the ladder only ever changes a box, never which nodes are boxes, and off restores the paint", async () => {
    const h = await boot();
    markedGraph(h);
    h.tracker.lowZoom.set({ flatBelow: 0.2, boxDetail: "state", snapshots: false });
    drawLoop(h, 0.2);
    const flatNodes = h.tracker.lowZoom.flat.flatNodes;

    // Above the flatten threshold nothing changes at all: the ladder is about a
    // box, and there is no box here.
    const close = paint(h, 0.5);
    assertEqual(close.ops.filter((o) => o[0] === "fillRect" && o[2] < 0).length, 0, "no title bar above the threshold");
    assertEqual(close.ops.filter((o) => o[0] === "strokeRect" && o[1] === -12).length, 0, "no error ring above it");

    // And switching the ladder off puts the paint back exactly as it was.
    h.canvas.ds.scale = 0.1;
    h.tracker.lowZoom.set({ boxDetail: "plain" });
    const plainFrame = paint(h);
    assertEqual(count(plainFrame.ops, "fillRect"), 6, "one rectangle per node again");
    assertEqual(count(plainFrame.ops, "strokeRect"), 0, "no marks");
    assert(plainFrame.alphas.every((a) => a === 1), "nothing dimmed");
    assertEqual(h.tracker.lowZoom.flat.flatNodes, flatNodes, "and the same nodes are flat as before the ladder was touched");

    // The master switch is above the ladder: off, nothing is painted by this
    // path at all.
    h.tracker.lowZoom.set({ boxDetail: "state" });
    h.tracker.lowZoom.setEnabled(false);
    const offFrame = paint(h);
    assertEqual(count(offFrame.ops, "strokeRect"), 0, "switched off, no box is painted by the tracker");
    assertEqual(h.canvas.nodeDraws > 0, true, "and LiteGraph's own drawing is back");
  });

  test("the panel and the API report the ladder, and the readout prices the marks", async () => {
    const h = await boot();
    markedGraph(h);
    h.tracker.lowZoom.set({ flatBelow: 0.2, snapshots: false });
    drawLoop(h, 0.2);
    await openTweaksTab(h);
    const text = panelText(h);
    assertIncludes(text, "plain fill", "the control offers the levels");
    assertIncludes(text, "title bar colour", "including the title bar");
    assertIncludes(text, "title, error ring, progress, muted", "and the state marks");
    assertIncludes(text, "the boxes are plain", "and the readout says what the boxes could show");

    h.tracker.lowZoom.set({ boxDetail: "state" });
    drawLoop(h, 0.2);
    h.advance(600); // the panel refreshes on its own tick, not on the canvas's
    await h.flush();
    const after = panelText(h);
    assertIncludes(after, 'box detail "state"', "the readout names the level in force");
    // The counters are per paint and cumulative, like every other counter here, so
    // the readout has to be compared with what the API reports, not with a number
    // this test guessed.
    const marks = h.tracker.lowZoom.flat;
    assertGreater(marks.boxTitles, 6, `the marks are counted over every painted frame (${marks.boxTitles} title bars)`);
    assertIncludes(after, `${marks.boxTitles} title bar(s)`, "and the readout prices them");
    assertIncludes(after, `${marks.boxErrors} error ring(s)`, "ring by ring");
    assertIncludes(after, `${marks.boxBars} progress bar(s)`, "bar by bar");
    assertIncludes(after, `${marks.boxMuted} dimmed`, "and the dimming");

    // The API is the seam tests and scripts use: state, limits, and the marks.
    const api = h.tracker.lowZoom;
    assertEqual(api.flat.boxDetail, "state", "the API reports the level");
    assertEqual(api.flat.boxTitles, marks.boxTitles, "and the counters the readout quoted");
    assertEqual(api.limits.boxDetail.join(","), "plain,title,state", "with the ladder exposed");
    // A value from nowhere (a saved record, a script) lands on the do-nothing one.
    api.set({ boxDetail: "sparkles" });
    assertEqual(api.flat.boxDetail, "plain", "an unknown level falls back to the plain box");
  });
});

// Node snapshots: a flat box can be a picture of the node it stands for. The
// engine is the interesting part, and these are its promises:
//   1. off by default: nothing is captured, nothing is blitted, no canvas is made;
//   2. a capture runs on the idle lane (never while somebody is touching the page),
//      through the node's own draw path, into its own canvas, at graph scale;
//   3. reuse is one drawImage of that canvas, and only for a node whose signature
//      still matches;
//   4. the nodes that must stay live stay live — broken, running, dragged.
//      Hover and selection keep the picture. A DOM widget or a
//      function-valued property is still captured: the picture is the canvas part;
//   5. a capture that was slow buys a doubling cooldown — never a session block;
//   6. a capture's cost is this tool's, not the pack's: hooks run, attribution
//      stands aside, and the time lands in the snapshot's own counter;
//   7. off (or the flatten setting at zero) releases every bitmap and paints
//      boxes again, byte for byte.
suite("drawing: node snapshots — a box that is a picture of the node", () => {
  // A graph whose nodes all go flat at the zoom under test, with one node type
  // carrying an instrumented prototype hook (so the attribution tests have a
  // bucket to look at).
  const SNAP_SIG_WINDOW_MS = 100; // the tracker's own LOD_SNAP_SIG_MS: how long a bitmap may be trusted unchecked
  const SnapThing = { type: "SnapThing", hookMs: 0 };
  function snapGraph(h, count = 3, fields = {}) {
    h.canvas.ds.scale = 0.1;
    h.canvas.ds.offset[0] = 0;
    h.canvas.ds.offset[1] = 0;
    h.canvas.links = [];
    const nodes = [];
    for (let i = 0; i < count; i++) {
      const n = h.node({ type: "SnapThing", pos: [i * 240, 0], size: [200, 100], widgets: [] });
      n.type = "SnapThing";
      Object.assign(n, fields);
      nodes.push(n);
    }
    h.canvas.nodes = nodes;
    h.app.graph._nodes = nodes;
    return nodes;
  }
  function hookBlock(h) {
    // The bucket for the wrapped prototype hook, if the type was registered.
    const snap = h.tracker.snapshot();
    return snap;
  }
  const draw = (h, n = 1) => {
    for (let i = 0; i < n; i++) {
      h.advance(FRAME_MS);
      h.canvas.setDirty(true, true);
      h.canvas.draw();
    }
  };
  // The idle lane: a slice is scheduled with setTimeout and the harness clock
  // drives it. Nothing else has to be faked.
  const idle = async (h, ms = 1000) => {
    h.advance(ms);
    await h.flush();
    h.advance(ms);
    await h.flush();
  };
  const blits = (h) => h.canvas.ctx.ops.filter((o) => o[0] === "drawImage");
  const boxes = (h) => h.canvas.ctx.ops.filter((o) => o[0] === "fillRect" && Number(o[3]) === 200);
  const snapApi = (h) => h.tracker.lowZoom.snapshots;

  test("off by default: no captures, no bitmaps, no canvases", async () => {
    const h = await boot();
    snapGraph(h, 4);
    h.tracker.lowZoom.set({ flatBelow: 0.2, snapshots: false }); // boxes, with pictures left off
    draw(h, 2);
    await idle(h);
    const api = snapApi(h);
    assertEqual(api.wanted, false, "snapshots are off unless asked for");
    assertEqual(api.captured, 0, "nothing was captured");
    assertEqual(api.drawn, 0, "and nothing was served from a picture");
    assertEqual(h.canvases.length, 0, "no offscreen canvas was even created");
    assertEqual(blits(h).length, 0, "and the live canvas was never blitted into");
    assertEqual(boxes(h).length, 4 * 2, "every node is the plain rectangle it was before");
  });

  test("an idle slice captures the nodes that were painted as boxes, and the next frame blits them", async () => {
    const h = await boot();
    const nodes = snapGraph(h, 3);
    h.tracker.lowZoom.set({ flatBelow: 0.2, boxDetail: "plain", snapshots: true });
    draw(h, 1);
    assertEqual(h.canvases.length, 0, "nothing is captured during a frame");
    assertEqual(snapApi(h).queue, 3, "the three boxed nodes are queued for the idle lane");
    await idle(h);
    const api = snapApi(h);
    assertEqual(api.captured, 3, "and all three were captured while idle");
    assertEqual(h.canvases.length, 9, "each capture got a 1x canvas plus a half and a quarter copy");
    assertGreater(api.bytes, 0, "with a byte cost that is counted");

    // The capture drew the node: the offscreen context has the node's own body
    // fill (the width/height the node reports), at graph scale 1 with the node's
    // origin translated to the padded corner.
    const off = h.canvases[0]._ctx;
    // The harness's fake node draws nothing of its own, so the capture canvas is
    // mostly empty — but the transform and the save/restore bookkeeping are the
    // capture's, and the ops below prove the real draw path ran into *this*
    // context rather than the visible one.
    assert(off.ops.length > 0, "the capture drew into its own context");
    const setT = off.ops.filter((o) => o[0] === "setTransform")[0];
    assert(setT, "the capture sets the scale explicitly instead of inheriting the zoom");
    assertEqual(setT[1], h.tracker.lowZoom.snapshots.ratio, "at the capture ratio");
    assertEqual(h.canvas.ds.scale, 0.1, "and the live canvas is still at the zoom it was at");

    // The next frame is served from the bitmaps: three blits, no boxes.
    h.canvas.ctx.ops.length = 0;
    draw(h, 1);
    const blit = blits(h);
    assertEqual(blit.length, 3, "one drawImage per node");
    assert(h.canvases.includes(blit[0][1]), "the image is one of the stored canvases");
    assert(Math.max(blit[0][1].width, blit[0][1].height) >= 248 * 0.1, "the copy still covers the pixels on screen");
    assert(blit[0][1].width < h.canvases[0].width, "and at this zoom it is a smaller copy, not the 1x capture");
    assertEqual(blit[0][2], -24, "placed at the left of the padded rect");
    assertEqual(blit[0][3], -54, "and above the body: the title bar and padding");
    assertEqual(blit[0][4], 248, "as wide as the node plus its padding");
    assertEqual(blit[0][5], 178, "and tall enough for the body, the title bar and the padding");
    assertEqual(boxes(h).length, 0, "no rectangle was painted for any of them");
    assertEqual(snapApi(h).drawn, 3, "and the reuse is counted");
  });

  test("the blit uses the smallest copy that still covers the screen", async () => {
    const h = await boot();
    h.window.devicePixelRatio = 2; // their display scale
    snapGraph(h, 1);
    h.tracker.lowZoom.set({ flatBelow: 0.5, snapshots: true, snapRatio: 1 });
    draw(h, 1);
    await idle(h);
    const capture = h.canvases[0];
    const pick = () => {
      h.canvas.ctx.ops.length = 0;
      draw(h, 1);
      return blits(h)[0][1];
    };
    // 248 graph units. At 10% and dpr 2 the screen shows about 50 device pixels.
    // A quarter of 248 is 62, which still covers that, so the quarter copy is used.
    h.canvas.ds.scale = 0.1;
    const far = pick();
    assert(far.width < capture.width / 2, "at 10% the quarter copy is enough");
    assert(Math.max(far.width, far.height) >= 248 * 0.1 * 2, "and it still covers the device pixels");
    // At 20% and dpr 2 the screen shows about 100 device pixels. 62 is short, so
    // the half copy is used. The quarter copy would be soft here, and is not.
    h.canvas.ds.scale = 0.2;
    const mid = pick();
    assert(mid.width > far.width, "at 20% the quarter copy is too small");
    assert(mid.width < capture.width, "and the full capture is not needed yet");
    assert(Math.max(mid.width, mid.height) >= 248 * 0.2 * 2, "the half copy covers the screen");
  });

  test("nothing is captured while the page is being used", async () => {
    const h = await boot();
    snapGraph(h, 2);
    h.tracker.lowZoom.set({ flatBelow: 0.2, snapshots: true });
    draw(h, 1);
    assertEqual(snapApi(h).queue, 2, "queued");
    // Somebody moves the pointer: the lane must wait, not capture.
    h.window.fire("pointermove");
    h.advance(FRAME_MS);
    await h.flush();
    assertEqual(snapApi(h).captured, 0, "an input event keeps the capture lane shut");
    // Once the page is quiet for the idle window, it proceeds.
    await idle(h, 1000);
    assertEqual(snapApi(h).captured, 2, "and it resumes when the page goes quiet");
  });

  test("the always-live set is never served from a bitmap", async () => {
    const h = await boot();
    const nodes = snapGraph(h, 6);
    nodes[0].selected = true; // being worked on
    nodes[1].mouseOver = {}; // under the pointer: a hover keeps the picture, it does not drop to a box
    nodes[2].has_errors = true; // broken
    nodes[3].progress = 0.5; // running
    nodes[4].progress = 0.001; // executing, however briefly
    h.tracker.lowZoom.set({ flatBelow: 0.2, snapshots: true });
    draw(h, 1);
    await idle(h);
    // Only the untouched node is a candidate; the others are refused at capture
    // time as well as at reuse time, so no bitmap of a transient state can exist.
    // A ghosted node is deliberately *not* in this set: ghosting only changes the
    // drawing, so the captured bitmap already carries its dimming.
    assertEqual(snapApi(h).captured, 3, "hover and selection are pictured; error and progress stay live");
    h.canvas.ctx.ops.length = 0;
    draw(h, 1);
    assertEqual(blits(h).length, 3, "the selected node, the hovered one and the untouched one are pictures");
    assertEqual(boxes(h).length, 3, "error and the two progress nodes stay live");

    // Selecting a node that already has a picture must not swap it for a box.
    const drawnBefore = snapApi(h).drawn;
    nodes[5].selected = true;
    h.canvas.ctx.ops.length = 0;
    draw(h, 1);
    assertEqual(snapApi(h).drawn, drawnBefore + 3, "selection does not drop the picture");
    assertEqual(blits(h).length, 3, "the newly selected node is still a picture");
    assertEqual(boxes(h).length, 3, "only error and progress are boxes");

    // The ghost case on its own, on a fresh graph: a ghosted node *is* captured
    // and served from its picture, because a ghost's dimming is part of the
    // drawing that was captured.
    const ghost = snapGraph(h, 1)[0];
    ghost.flags = { ghost: true };
    const capturedBefore = snapApi(h).captured;
    draw(h, 1);
    await idle(h);
    assertEqual(snapApi(h).captured, capturedBefore + 1, "the ghost was captured");
    h.canvas.ctx.ops.length = 0;
    draw(h, 1);
    assertEqual(blits(h).length, 1, "and is served from its own picture");
    assertEqual(boxes(h).length, 0, "not painted as a box");
  });

  test("selecting a pictured node keeps the picture", async () => {
    const h = await boot();
    const nodes = snapGraph(h, 2);
    h.canvas.ds.scale = 0.4; // under the 50% setting: thumbnails are on
    h.tracker.lowZoom.set({ flatBelow: 0.5, snapshots: true });
    draw(h, 1);
    await idle(h);
    nodes[0].selected = true;
    h.canvas.ctx.ops.length = 0;
    draw(h, 1);
    assertEqual(blits(h).length, 2, "the selected node stays a picture");
    assertEqual(boxes(h).length, 0, "selection does not paint a box over it");
    const rings = h.canvas.ctx.ops.filter((o) => o[0] === "strokeRect");
    assert(rings.length >= 1, "selection is a ring drawn on the picture");
  });

  test("an image drawn a microtask after the node is in the copy the screen blits", async () => {
    const h = await boot();
    h.window.devicePixelRatio = 2; // their display scale: past ~25% the quarter copy is used
    const nodes = snapGraph(h, 1);
    const img = { width: 80, height: 80, naturalWidth: 80, naturalHeight: 80, complete: true, src: "preview.png" };
    nodes[0].imgs = [img];
    // ComfyUI's image preview does not draw the picture inside drawNode. It queues
    // that drawImage and returns. The capture used to copy the half and quarter
    // canvases before that turn, so those copies — the ones used past ~25% — had
    // the frame and not the photograph.
    nodes[0].onDrawBackground = (ctx) => {
      h.sandbox.queueMicrotask(() => {
        ctx.__antsImage = true;
        ctx.drawImage(img, 12, 28, 80, 60);
      });
    };
    h.canvas.ds.scale = 0.1;
    h.tracker.lowZoom.set({ flatBelow: 0.5, snapshots: true, snapRatio: 1 });
    draw(h, 1);
    await idle(h);
    h.canvas.ctx.ops.length = 0;
    draw(h, 1);
    const blit = blits(h)[0];
    assert(blit, "the node was served from a picture");
    const src = blit[1];
    assert(src && src._ctx, "the blit source is one of the stored canvases");
    const copies = src._ctx.ops.filter((o) => o[0] === "drawImage" && o[1] && o[1]._ctx);
    const copy = copies[copies.length - 1];
    assert(copy && copy.imageReady, "the smaller copy was taken after the node's image had been drawn");
  });

  test("an image already queued before the capture still lands in the smaller copy", async () => {
    const h = await boot();
    h.window.devicePixelRatio = 2;
    const nodes = snapGraph(h, 1);
    const img = { width: 80, height: 80, naturalWidth: 80, naturalHeight: 80, complete: true, src: "preview.png" };
    nodes[0].imgs = [img];
    // Closed over before the capture replaces queueMicrotask, so this is the
    // flusher ComfyUI already scheduled: the capture cannot collect it.
    const q = h.sandbox.queueMicrotask;
    nodes[0].onDrawBackground = (ctx) => {
      q(() => {
        ctx.__antsImage = true;
        ctx.drawImage(img, 12, 28, 80, 60);
      });
    };
    h.canvas.ds.scale = 0.1;
    h.tracker.lowZoom.set({ flatBelow: 0.5, snapshots: true, snapRatio: 1 });
    draw(h, 1);
    await idle(h);
    h.canvas.ctx.ops.length = 0;
    draw(h, 1);
    const blit = blits(h)[0];
    const copies = blit[1]._ctx.ops.filter((o) => o[0] === "drawImage" && o[1] && o[1]._ctx);
    assert(copies.length && copies[copies.length - 1].imageReady, "the copy was redrawn after the already-queued image landed");
  });

  test("dragging a pictured node keeps the picture, a link drag does not", async () => {
    const h = await boot();
    const nodes = snapGraph(h, 2);
    h.tracker.lowZoom.set({ flatBelow: 0.2, snapshots: true });
    draw(h, 1);
    await idle(h);
    assertEqual(snapApi(h).captured, 2, "both captured");

    h.canvas.isDragging = true; // a node is being dragged
    h.canvas.ctx.ops.length = 0;
    draw(h, 1);
    assertEqual(blits(h).length, 2, "while dragging, the pictures stay — a drag is not a box");
    h.canvas.isDragging = false;

    h.canvas.connecting_node = nodes[0];
    h.canvas.ctx.ops.length = 0;
    draw(h, 1);
    assertEqual(blits(h).length, 0, "a link drag still draws live");
    h.canvas.connecting_node = null;

    // Panning and zooming are camera moves: the picture is still valid.
    h.canvas.ds.offset[0] = -500;
    h.canvas.ds.scale = 0.08;
    h.canvas.ctx.ops.length = 0;
    draw(h, 1);
    assertEqual(blits(h).length, 2, "a pan and a zoom reuse every bitmap");
    assertEqual(snapApi(h).invalidated, 0, "and invalidate nothing");
  });

  test("the higher linked threshold keeps pictures while dragging, in either widget mode", async () => {
    const h = await boot();
    snapGraph(h, 2);
    h.tracker.lowZoom.set({ flatBelow: 0.2, inertBelow: 0.5, linkZoom: true, snapshots: true, focusDom: "inert" });
    h.canvas.ds.scale = 0.3; // past 20%, not past 50%
    draw(h, 1);
    await idle(h);
    assertEqual(h.tracker.lowZoom.flat.on, true, "linked, the higher zoom is the picture zone");
    assertEqual(h.tracker.lowZoom.flat.pictureBelow, 0.5, "and the readout says which one won");
    h.canvas.isDragging = true;
    h.canvas.ctx.ops.length = 0;
    draw(h, 1);
    assertGreater(blits(h).length, 0, "dragging past the widget zoom still shows pictures");
    h.canvas.isDragging = false;

    h.tracker.lowZoom.set({ focusDom: "hide" });
    h.canvas.isDragging = true;
    h.canvas.ctx.ops.length = 0;
    draw(h, 1);
    assertGreater(blits(h).length, 0, "and the same when widgets are hidden outright");
    h.canvas.isDragging = false;

    h.tracker.lowZoom.set({ linkZoom: false, flatBelow: 0.2, inertBelow: 0.5 });
    h.canvas.ds.scale = 0.3;
    draw(h, 1);
    assertEqual(h.tracker.lowZoom.flat.on, false, "unlinked, only the preview zoom replaces nodes");
    assertEqual(h.tracker.lowZoom.state.flatBelow, 0.2, "the preview setting was not rewritten");
    assertEqual(h.tracker.lowZoom.state.inertBelow, 0.5, "and the widget setting was left alone");
  });

  test("a run releases stand-ins only when system RAM is high, and does not touch disk files", async () => {
    const h = await boot();
    const nodes = snapGraph(h, 2);
    nodes[0].id = 11;
    nodes[1].id = 12;
    nodes[1].pos = [40000, 0];
    h.tracker.lowZoom.set({ flatBelow: 0.2, snapshots: true, diskOn: true });
    draw(h, 1);
    await idle(h);
    const before = snapApi(h).bytes;
    assertGreater(before, 0, "pictures are held");

    h.fetchRoutes.set("/system_stats", { system: { ram_total: 64e9, ram_free: 40e9 } });
    const fine = await h.tracker.ramCheck();
    assertEqual(fine.purged, 0, "under 85% nothing is released");
    assertEqual(snapApi(h).bytes, before, "and the pictures stay");

    h.fetchRoutes.set("/system_stats", { devices: [{ name: "gpu" }] });
    const unknown = await h.tracker.ramCheck();
    assertEqual(unknown.purged, 0, "a stats payload with no RAM reading releases nothing");
    assertEqual(snapApi(h).bytes, before, "the pictures are still there");
    assertIncludes(snapApi(h).ramNote, "nothing was released", "and the panel is told why");

    h.fetchRoutes.set("/system_stats", { system: { ram_total: 64e9, ram_free: 6e9 } });
    const off = await h.tracker.runStart();
    assertGreater(off.purged, 0, "at 85% the off-screen stand-in leaves memory");
    assertGreater(snapApi(h).bytes, 0, "the on-screen one stays");
    assertEqual(snapApi(h).ramLast, "off-screen", "and that is the release that happened");

    h.fetchRoutes.set("/system_stats", { system: { ram_total: 64e9, ram_free: 1e9 } });
    const full = await h.tracker.ramCheck();
    assertGreater(full.purged, 0, "at 95% the on-screen stand-in leaves memory too");
    assertEqual(snapApi(h).bytes, 0, "memory is clear");
    assertEqual(snapApi(h).ramLast, "full", "disk files were not the thing released");

    h.fetchRoutes.set("/system_stats", { system: { ram_total: 64e9, ram_free: 40e9 } });
    const back = await h.tracker.runFinish();
    await h.flush();
    assertGreater(back, 0, "when the run finishes the lane asks for the pictures again");
    assertGreater(snapApi(h).queue + (snapApi(h).held || 0), 0, "and something is loading or queued, not left blank");
  });

  test("a node that changes keeps its picture until the new one lands", async () => {
    const h = await boot();
    const nodes = snapGraph(h, 1);
    nodes[0].widgets = [{ type: "number", name: "steps", value: 20 }];
    h.tracker.lowZoom.set({ flatBelow: 0.2, snapshots: true });
    draw(h, 1);
    await idle(h);
    h.canvas.ctx.ops.length = 0;
    draw(h, 1);
    assertEqual(blits(h).length, 1, "served from the picture while nothing changes");

    nodes[0].widgets[0].value = 30; // something that changes what the node draws
    h.advance(SNAP_SIG_WINDOW_MS); // past the window in which the old signature would still be trusted
    h.canvas.ctx.ops.length = 0;
    draw(h, 1);
    // What is held is a *complete* picture of the moment before. Dropping it here
    // and letting the box ladder stand in put a plain rectangle on screen for as
    // long as the node kept changing — the flash every changing node showed.
    assertEqual(blits(h).length, 1, "the changed node is still served from its picture");
    assertEqual(boxes(h).length, 0, "and no plain box is painted over it");
    assertEqual(snapApi(h).invalidated, 1, "the picture is known to be out of date");
    assertGreater(snapApi(h).staleHeld, 0, "the readout counts the hold");
    assertEqual(snapApi(h).queue, 1, "and a fresh capture was asked for, with the canvas in hand");
    await idle(h);
    assertEqual(snapApi(h).captured, 2, "which happened");
  });

  test("a slow capture buys a cooldown, not a life sentence", async () => {
    const h = await boot();
    const nodes = snapGraph(h, 3);
    // One node whose own drawing is expensive. Past the slow-capture cutoff it used
    // to be blocked for the whole session — on a CPU-only machine with big nodes
    // that is a plain box forever. Now the wait doubles per slow attempt, and the
    // node is always tried again.
    nodes[1].onDrawBackground = () => h.busy(70);
    h.tracker.lowZoom.set({ flatBelow: 0.2, snapshots: true });
    draw(h, 1);
    await idle(h);
    const api = snapApi(h);
    assertEqual(api.captured, 2, "the two cheap nodes were captured");
    assertEqual(api.slow, 1, "the expensive one was measured");
    assertEqual(h.canvases.filter((c) => c.width === 0).length, 1, "the bitmap it drew was released again");
    assertEqual(api.bytes > 0, true, "and only the two cheap nodes are held");
    h.canvas.ctx.ops.length = 0;
    draw(h, 1);
    assertEqual(boxes(h).length, 1, "while it waits, that node is the plain box it would have been");
    await idle(h);
    assertEqual(snapApi(h).captured, 2, "and it is not re-photographed inside the cooldown");
    // Past the cooldown it is tried again; the second slow capture doubles the wait
    // rather than taking the node away for good.
    h.advance(10500);
    draw(h, 1);
    await idle(h);
    assertEqual(snapApi(h).slow, 2, "past the cooldown it is measured again");
    assertEqual(snapApi(h).captured, 2, "and the retry costs nobody a picture");
    assertEqual(snapApi(h).cooldown > 0, true, "the readout shows a node waiting out a cooldown");
    assert(snapApi(h).why.some((w) => /another try in 20s/.test(String(w.why))), "and says when the next try is");
  });

  test("a capture's time is this tool's, not the pack's", async () => {
    const h = await boot();
    // The way a real pack installs a hook: through beforeRegisterNodeDef, which is
    // where this tool wraps it. (Assigning the prototype method afterwards would
    // install a hook the tracker never saw, which would make this test prove
    // nothing at all.)
    await h.registerExtension("SnapPack", {
      beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== "SnapHookThing") return;
        nodeType.prototype.onDrawBackground = function () {
          h.busy(2);
        };
      },
    });
    const Thing = h.registerNodeType("SnapHookThing");
    h.canvas.ds.scale = 0.1;
    h.canvas.links = [];
    const nodes = [h.makeNode(Thing), h.makeNode(Thing)];
    for (const n of nodes) {
      n.type = "SnapHookThing";
      n.pos = [0, 0];
      n.size = [200, 100];
    }
    h.canvas.nodes = nodes;
    h.app.graph._nodes = nodes;

    h.tracker.lowZoom.set({ flatBelow: 0, snapshots: true });
    draw(h, 3); // drawn live first, so the hook has attributed calls to protect
    // The hook's bucket after three live frames' worth of attribution.
    // The pack's row, as the Timing tab sees it: calls attributed inside frames,
    // outside frames, and nested. A capture must move none of them.
    const hookCalls = () => {
      const rows = (h.tracker.snapshot.hooks || []).filter((r) => r.label === "SnapPack");
      return rows.reduce(
        (n, r) => n + (Number(r.insideCalls) || 0) + (Number(r.outsideCalls) || 0) + (Number(r.nestedCalls) || 0),
        0
      );
    };
    const before = hookCalls();
    assertGreater(before, 0, "the live frames attributed the hook, as they should");
    // Now the nodes become boxes with snapshots on: the captures will run the same
    // hook, and it must not show up on the pack's row.
    h.tracker.lowZoom.set({ flatBelow: 0.2 });
    draw(h, 1);
    await idle(h);
    assertEqual(snapApi(h).captured, 2, "the two nodes were captured");
    assertEqual(hookCalls(), before, "and the captures added no attributed calls to the pack's row");
    assertGreater(snapApi(h).captureMs, 0, "their cost is in the snapshot counter instead");
  });

  // Upstream (NodeSnapshots) keeps any node with a DOM widget, a function-valued
  // value or a long string live *forever*, and its own issue #1 is the user report
  // that custom nodes then never get a picture. v2.4.0 draws the line where the
  // canvas does instead: if the canvas can put ink on a surface for this node, it
  // gets a picture, and the parts the browser draws over it are counted apart.
  test("the browser's half of a node is not a reason to leave it a box", async () => {
    const h = await boot();
    const nodes = snapGraph(h, 3);
    nodes[0].addDOMWidget("preview", "image", h.document.createElement("div"), {});
    nodes[1].properties = { mode: () => "changing" };
    nodes[2].widgets = [{ name: "payload", value: "x".repeat(20000), type: "string" }];
    h.tracker.lowZoom.set({ flatBelow: 0.2, snapshots: true });
    draw(h, 1);
    await idle(h);
    const api = snapApi(h);
    assertEqual(api.captured, 3, "all three were captured: a DOM widget, a function and a 20 kB string");
    assertEqual(api.keptLive, 0, "nothing was kept live on purpose");
    assertEqual(api.partial, 1, "and the DOM-widget picture is marked as the canvas part only");
    h.canvas.ctx.ops.length = 0;
    draw(h, 1);
    assertEqual(boxes(h).length, 0, "so the next frame is served from three pictures");

    // A long string is hashed by its ends, so a change at the tail of one must
    // still invalidate the picture (its head is what the canvas draws, its tail is
    // where a growing payload moves).
    nodes[2].widgets[0].value = "x".repeat(19999) + "y";
    await idle(h);
    h.canvas.ctx.ops.length = 0;
    draw(h, 1);
    assertGreater(snapApi(h).invalidated, 0, "and a change at the far end of it is still noticed");
  });

  test("a node too tall for the cap is fitted, not skipped", async () => {
    const h = await boot();
    const nodes = snapGraph(h, 2);
    // 1,278 padded units tall: 2x would be 2,556 px, past the 2,048 px cap, so the
    // picture is taken at 1x instead of the node being skipped (which is what both
    // this tool and upstream did until v2.4.0 — at 10% zoom 1x is still ten times
    // the pixels the screen shows).
    nodes[0].size = [300, 1200];
    h.tracker.lowZoom.set({ flatBelow: 0.2, snapshots: true, snapRatio: 2 });
    draw(h, 1);
    await idle(h);
    const api = snapApi(h);
    assertEqual(api.captured, 2, "the tall node was captured too");
    assertEqual(api.large, 0, "nothing was skipped as too big");
    assertEqual(api.fit, 1, "one capture is counted as fitted below the ratio");
    const fitted = h.canvases.filter((c) => c.height === 1278);
    assertEqual(fitted.length, 1, "at the size the cap allows");
    const setT = fitted[0]._ctx.ops.filter((o) => o[0] === "setTransform")[0];
    assertEqual(setT[1], 1, "drawn at graph scale 1, not the 2x that was asked for");
    h.canvas.ctx.ops.length = 0;
    draw(h, 1);
    assertEqual(boxes(h).length, 0, "and it is served from its picture like any other node");
  });

  test("a node no ratio can fit keeps its box, and is tried once", async () => {
    const h = await boot();
    const nodes = snapGraph(h, 2);
    nodes[0].size = [400, 2100]; // 2,178 padded units: past the cap at 1x already
    h.tracker.lowZoom.set({ flatBelow: 0.2, snapshots: true });
    draw(h, 1);
    await idle(h);
    const api = snapApi(h);
    assertEqual(api.captured, 1, "only the node that fits was captured");
    assertEqual(api.large, 1, "the too-big node is counted once, as a node");
    assertEqual(h.canvases.length, 3, "only the node that fits was photographed, with its half and quarter copies");
    assert(api.why.some((e) => /2100 units tall/.test(e.why)), "with its size in the readout's reasons");
    h.advance(600); // the panel refresh
    await h.flush();
    await openTweaksTab(h);
    const text = panelText(h);
    assertIncludes(text, "not pictured:", "the readout names what will not get a picture");
    assertIncludes(text, "2100 units tall", "with the reason, and the node's own size");
    // Time and drawing do not turn it into an attempt-per-slice: it is blocked, so
    // the lane never spends another draw on it (v2.3.1 retried it every slice and
    // the counter read like 375 nodes).
    h.advance(10000);
    draw(h, 3);
    await idle(h, 3000);
    assertEqual(snapApi(h).large, 1, "still one attempt, not one per slice");
    assertEqual(h.canvases.length, 3, "and still no canvas for the node that does not fit");
  });

  test("a node whose own draw leaves the canvas empty keeps its box", async () => {
    // A node whose whole visual is a DOM element can draw nothing into a canvas at
    // all. A transparent picture would *erase* it at the zoom where pictures are
    // used, so the probe catches that and the box stays.
    const h = await boot({ ink: "none" });
    snapGraph(h, 2);
    h.tracker.lowZoom.set({ flatBelow: 0.2, snapshots: true });
    draw(h, 1);
    await idle(h);
    const api = snapApi(h);
    assertEqual(api.captured, 0, "nothing was stored");
    assertEqual(api.blank, 2, "both nodes are counted as drawing nothing");
    assertEqual(h.canvases[0].width, 0, "and the canvas they were drawn into was released");
    h.canvas.ctx.ops.length = 0;
    draw(h, 1);
    assertEqual(boxes(h).length, 2, "the boxes stay, which is the honest stand-in");
  });

  test("a font of churn keeps the picture, and the box never comes back", async () => {
    const h = await boot();
    const nodes = snapGraph(h, 1);
    h.tracker.lowZoom.set({ flatBelow: 0.2, snapshots: true });
    draw(h, 1);
    await idle(h);
    assertEqual(snapApi(h).captured, 1, "captured once");
    h.canvas.ctx.ops.length = 0;
    draw(h, 1);
    assertEqual(snapApi(h).flips, 1, "one switch into the picture");
    // Something rewrites a value the node draws, faster than the settle window the
    // lane waits out: the change lands after each capture and before each reuse,
    // which is the shape a polling extension has.
    for (let i = 0; i < 4; i++) {
      h.advance(200); // inside the settle window the change just re-armed
      nodes[0].widgets = [{ name: "polled", value: `v${i}`, type: "string" }];
      h.canvas.ctx.ops.length = 0;
      draw(h, 1); // ...and the value changed again before this draw
    }
    const api = snapApi(h);
    assertGreater(api.invalidated, 0, "the changes were seen");
    assertEqual(blits(h).length, 1, "and the node still shows its picture");
    assertEqual(boxes(h).length, 0, "never a box for it");
    assertEqual(api.flips, 1, "so nothing flickered between the two");
    await idle(h);
    assertGreater(snapApi(h).captured, 1, "the picture is refreshed once the value stops moving");
    h.canvas.ctx.ops.length = 0;
    draw(h, 1);
    assertEqual(boxes(h).length, 0, "and the box is still not what the user sees");
  });

  test("when the budget cannot hold your ratio, a coarse picture beats none", async () => {
    const h = await boot();
    // Big nodes at 3x fill the 256 MiB floor. A node that does not fit at 3x is
    // taken coarser if 1x fits, and refused only if even that does not. The mip
    // copies are in the same budget, so the exact count is lower than a 1x-only
    // cache, and the policy is what this test holds.
    h.canvas.ds.scale = 0.1;
    h.canvas.links = [];
    const nodes = [];
    for (let i = 0; i < 25; i++) {
      const n = h.node({ type: "SnapThing", pos: [i * 700, 0], size: [600, 400] });
      n.type = "SnapThing";
      nodes.push(n);
    }
    for (let i = 0; i < 2; i++) {
      const n = h.node({ type: "SnapThing", pos: [20000 + i * 300, 0], size: [200, 100] });
      n.type = "SnapThing";
      nodes.push(n);
    }
    h.canvas.nodes = nodes;
    h.app.graph._nodes = nodes;
    h.tracker.lowZoom.set({ flatBelow: 0.2, snapshots: true, snapRatio: 3, snapMb: 256 });
    draw(h, 1);
    await idle(h, 8000);
    const api = snapApi(h);
    // The half and quarter copies are counted in the same budget, so fewer 3x
    // pictures fit than when a capture was only its 1x bitmap. The policy is
    // unchanged: nothing on screen is released, and a coarser picture beats none.
    assertGreater(api.coarse, 0, "a node that would not fit at 3x was taken coarser, not skipped");
    assertGreater(api.full, 0, "and a node that fitted at no size was refused");
    assertEqual(api.evicted, 0, "nothing was taken off the screen for them");
    assertGreater(api.pictured, 0, "the ones that fit kept their pictures");
    assert(api.bytes <= 256 * 1024 * 1024, "the mip chain is inside the budget, not added on top of it");
  });

  test("a full budget refuses captures instead of evicting what is on screen", async () => {
    const h = await boot();
    // Big nodes at 3x: about 11 MB each, so the ladder's floor (256 MiB) fills
    // after roughly twenty of them.
    h.canvas.ds.scale = 0.1;
    h.canvas.links = [];
    const nodes = [];
    for (let i = 0; i < 40; i++) {
      const n = h.node({ type: "SnapThing", pos: [i * 700, 0], size: [600, 400] });
      n.type = "SnapThing";
      nodes.push(n);
    }
    h.canvas.nodes = nodes;
    h.app.graph._nodes = nodes;
    h.tracker.lowZoom.set({ flatBelow: 0.2, snapshots: true, snapRatio: 3, snapMb: 256 });
    draw(h, 1);
    await idle(h, 8000);
    const api = snapApi(h);
    const budget = api.budgetMb * 1024 * 1024;
    assertGreater(api.captured, 10, `several were captured (${api.captured})`);
    assertGreater(api.full, 0, "and the ones that did not fit were refused");
    assertEqual(api.evicted, 0, "without taking a single bitmap off the screen");
    assertLess(api.bytes, budget + 1, `what is held stays inside the budget (${api.bytes} of ${budget} bytes)`);
    // And the refusal is stable: another pass of the lane changes nothing.
    const captured = api.captured;
    h.advance(3000);
    await h.flush();
    draw(h, 1);
    await idle(h, 3000);
    assertEqual(snapApi(h).captured, captured, "the lane does not spin on nodes it cannot hold");
  });

  test("bitmaps nobody is drawing any more are what makes room", async () => {
    const h = await boot();
    h.canvas.ds.scale = 0.1;
    h.canvas.links = [];
    const nodes = [];
    for (let i = 0; i < 40; i++) {
      const n = h.node({ type: "SnapThing", pos: [i * 700, 0], size: [600, 400] });
      n.type = "SnapThing";
      nodes.push(n);
    }
    h.canvas.nodes = nodes;
    h.app.graph._nodes = nodes;
    h.tracker.lowZoom.set({ flatBelow: 0.2, snapshots: true, snapRatio: 3, snapMb: 256 });
    draw(h, 1);
    await idle(h, 8000);
    assertGreater(snapApi(h).full, 0, "the budget filled up");

    // The same shape as panning away: most of the graph stops being drawn (here,
    // collapsed nodes are exempt from the flat path), so their bitmaps are no
    // longer in use and become the eviction pool.
    for (let i = 0; i < 30; i++) nodes[i].flags = { collapsed: true };
    // A refused node is retried when it is drawn again and its hold has expired —
    // the same two conditions a real page meets on its next frame. The first
    // attempt here lands while the collapsed bitmaps are still inside the guard
    // window, so it is refused once more; the second lands after it.
    h.advance(6000);
    draw(h, 2);
    await idle(h, 3000);
    h.advance(6000);
    draw(h, 1);
    await idle(h, 6000);
    const api = snapApi(h);
    assertGreater(api.evicted, 0, `the cold bitmaps were released to make room (${api.evicted})`);
    assertLess(api.bytes, api.budgetMb * 1024 * 1024 + 1, "and the budget still holds");
    const live = h.canvases.filter((c) => c.width > 0).length;
    assertGreater(live, 0, "with pictures still held for the nodes that are being drawn");
  });

  test("the budget ladder is 256 MiB to 8 GiB, and nothing below the floor survives", async () => {
    const h = await boot();
    const api = h.tracker.lowZoom;
    assertEqual(api.limits.snapBudgets.join(","), "256,512,1024,2048,4096,8192", "the ladder, doubling to 8 GiB");
    assertEqual(api.snapshots.budgetMb, 4096, "with a 4096 MiB default when nothing is saved");
    // A value below the floor — from a saved v2.3.0 record, or a script — is clamped
    // up to it rather than honoured: below 256 MiB a large graph only thrashes.
    api.set({ snapMb: 32 });
    assertEqual(api.snapshots.budgetMb, 256, "32 MiB lands on the floor");
    api.set({ snapMb: 8192 });
    assertEqual(api.snapshots.budgetMb, 8192, "8192 is a step, not a clamp");
    api.set({ snapMb: 20000 });
    assertEqual(api.snapshots.budgetMb, 8192, "and the ceiling is 8 GiB");
    api.set({ snapMb: 1000 });
    assertEqual(api.snapshots.budgetMb, 1024, "a value between steps lands on the nearest one");
    // The saved record is read back through the same clamp.
    api.set({ snapshots: true, snapMb: 64, flatBelow: 0.2 });
    const h2 = await boot({ storage: h.localStorage });
    assertEqual(h2.tracker.lowZoom.snapshots.budgetMb, 256, "a saved sub-floor budget becomes the floor on the next load");
    assertEqual(h2.tracker.lowZoom.snapshots.wanted, true, "and the feature is remembered");
    // An explicit saved step below the new default is not promoted to 4096.
    h2.tracker.lowZoom.set({ snapMb: 512 });
    const h3 = await boot({ storage: h.localStorage });
    assertEqual(h3.tracker.lowZoom.snapshots.budgetMb, 512, "a saved 512 stays 512");
    h.localStorage.setItem("ants.lowZoom.v1", JSON.stringify({ flatBelow: 0.2, snapshots: true }));
    const h4 = await boot({ storage: h.localStorage });
    assertEqual(h4.tracker.lowZoom.snapshots.budgetMb, 4096, "a missing budget key is the new default");
    h4.tracker.lowZoom.set({ snapRatio: 0.25 });
    assertEqual(h4.tracker.lowZoom.snapshots.ratio, 0.25, "0.25x is a capture step, not snapped up to 1x");
    h4.tracker.lowZoom.set({ snapRatio: 0.5 });
    assertEqual(h4.tracker.lowZoom.snapshots.ratio, 0.5, "and 0.5x stays 0.5x");
  });

  test("a shadow-flag change pauses reuse without throwing the pictures away", async () => {
    const h = await boot();
    snapGraph(h, 2);
    h.tracker.lowZoom.set({ flatBelow: 0.2, snapshots: true });
    draw(h, 1);
    await idle(h);
    assertEqual(snapApi(h).captured, 2, "captured");
    h.canvas.ctx.ops.length = 0;
    draw(h, 1);
    assertEqual(blits(h).length, 2, "and served from the pictures");

    // Another extension turning shadows off for a gesture: the pictures were taken
    // with shadows on, so the box is what the page is drawing right now.
    h.canvas.render_shadows = false;
    h.canvas.ctx.ops.length = 0;
    draw(h, 1);
    assertEqual(blits(h).length, 0, "no picture is used while the flag disagrees");
    assertEqual(boxes(h).length, 2, "the boxes are painted instead");
    assertEqual(snapApi(h).flagHeld, 2, "counted as held, not as a fault");
    assertEqual(snapApi(h).captured, 2, "and nothing was recaptured");
    assertEqual(snapApi(h).invalidated, 0, "nothing was dropped either");

    // The gesture ends, the flag comes back, and the pictures are simply there.
    h.canvas.render_shadows = true;
    h.canvas.ctx.ops.length = 0;
    draw(h, 1);
    assertEqual(blits(h).length, 2, "reuse resumes with no recapture");
    assertEqual(snapApi(h).captured, 2, "still two captures, not four");
  });

  test("the flicker counter does not count a change as a switch back to the box", async () => {
    const h = await boot();
    const nodes = snapGraph(h, 1);
    nodes[0].widgets = [{ type: "number", name: "steps", value: 20 }];
    h.tracker.lowZoom.set({ flatBelow: 0.2, snapshots: true });
    draw(h, 1);
    await idle(h);
    h.canvas.ctx.ops.length = 0;
    draw(h, 1);
    assertEqual(blits(h).length, 1, "served from a picture");
    assertEqual(snapApi(h).flips, 1, "the first paint of a picture counts as one switch (box → picture)");

    nodes[0].widgets[0].value = 30; // the node changes: the picture stays, its replacement is queued
    h.advance(SNAP_SIG_WINDOW_MS);
    h.canvas.ctx.ops.length = 0;
    draw(h, 1);
    assertEqual(blits(h).length, 1, "the picture is still painted");
    assertEqual(boxes(h).length, 0, "and no box");
    assertEqual(snapApi(h).flips, 1, "so no switch is counted — this is the number that used to climb for every change");
  });

  test("off releases everything and paints exactly what it painted before", async () => {
    const h = await boot();
    snapGraph(h, 3);
    h.tracker.lowZoom.set({ flatBelow: 0.2, snapshots: true });
    draw(h, 1);
    await idle(h);
    assertEqual(snapApi(h).captured, 3, "captured");

    h.tracker.lowZoom.set({ snapshots: false });
    assertEqual(snapApi(h).bytes, 0, "switching off releases the memory");
    assertEqual(h.canvases.filter((c) => c.width === 0).length, 9, "and zeroes every canvas, including the half and quarter copies");
    h.canvas.ctx.ops.length = 0;
    draw(h, 1);
    assertEqual(blits(h).length, 0, "nothing is served from a picture any more");
    assertEqual(boxes(h).length, 3, "and the plain rectangles are back");
  });

  test("the flatten setting going to zero puts the pictures away too", async () => {
    const h = await boot();
    snapGraph(h, 2);
    h.tracker.lowZoom.set({ flatBelow: 0.2, snapshots: true });
    draw(h, 1);
    await idle(h);
    assertGreater(snapApi(h).bytes, 0, "holding bitmaps");
    h.tracker.lowZoom.set({ flatBelow: 0 });
    assertEqual(snapApi(h).bytes, 0, "with no boxes to replace, they are released");
    assertEqual(snapApi(h).wanted, true, "the setting the user chose is still on");
    assertEqual(snapApi(h).on, false, "it is simply doing nothing, and says so");
  });

  test("a fault in the reuse path hands the page back instead of trying per node", async () => {
    const h = await boot();
    snapGraph(h, 2);
    h.tracker.lowZoom.set({ flatBelow: 0.2, snapshots: true });
    draw(h, 1);
    await idle(h);
    // Break the blit itself: the canvas refuses to draw the image.
    const ctx = h.canvas.ctx;
    const real = ctx.drawImage;
    ctx.drawImage = function () {
      throw new Error("nope");
    };
    draw(h, 1);
    ctx.drawImage = real;
    const api = snapApi(h);
    assertEqual(api.wanted, false, "the mode turned itself off");
    assertEqual(api.on, false, "and is doing nothing");
    assertIncludes(h.tracker.lowZoom.state.error, "reuse failed", "with the reason in the panel's own error line");
    assertEqual(api.bytes, 0, "and every bitmap released");
  });

  test("the panel and the API report what the engine did", async () => {
    const h = await boot();
    snapGraph(h, 3);
    h.tracker.lowZoom.set({ flatBelow: 0.2, snapshots: true });
    draw(h, 1);
    await idle(h);
    h.advance(600); // the panel refreshes on its own tick
    await h.flush();
    await openTweaksTab(h);
    const text = panelText(h);
    assertIncludes(text, "picture of the node", "the control offers it");
    assertIncludes(text, "capture 1x per graph unit", "with the ratio it will capture at");
    assertIncludes(text, "Stand-in memory (ram) budget", "the budget is named for what it holds");
    assertIncludes(text, "4096 MiB", "and the default step");
    assertIncludes(text, "Stand-in capture resolution", "the capture setting is named");
    assertIncludes(text, "Keep stand-in previews on disk", "and the disk setting");
    assertIncludes(text, "remembered node(s) have a picture", "the readout leads with how much of the graph is pictured");
    const api = h.tracker.lowZoom;
    assertEqual(api.snapshots.wanted, true, "the API says it is wanted");
    assertEqual(api.limits.snapRatios.join(","), "0.25,0.5,1,2,3", "and exposes the ladders");
    assertEqual(api.limits.snapBudgets.join(","), "256,512,1024,2048,4096,8192", "including the budget ladder");
    assertEqual(api.snapshots.installed, true, "with the canvas seam in place");
    // A type the user excludes is kept live on purpose, and counted as such
    // rather than as a failure (v2.4.0: this is now the *only* way a node the
    // canvas can draw is left without a picture, besides the churn guard).
    api.set({ snapExclude: ["SnapThing"] });
    assertEqual(api.snapshots.exclude.join(","), "SnapThing", "the list is kept");
    api.set({ snapshots: false });
    api.set({ snapshots: true });
    await idle(h);
    assertEqual(api.snapshots.captured, 3, "a fresh page state captures again");
    h.tracker.lowZoom.set({ snapshots: false });
  });

  test("the keep-live list is a control, not an API-only setting", async () => {
    const h = await boot();
    snapGraph(h, 3);
    h.tracker.lowZoom.set({ flatBelow: 0.2, snapshots: true });
    draw(h, 1);
    await idle(h);
    h.advance(600); // the panel refreshes on its own tick
    await h.flush();
    await openTweaksTab(h);
    assertIncludes(panelText(h), "Keep these node types live", "the setting is in the panel");
    const field = h
      .panel()
      .descendants()
      .find((n) => n.tagName === "INPUT" && String(n.type).toLowerCase() === "text");
    assert(field, "and it is a text field, not a dropdown of types the tool guessed");
    field.value = " SnapThing , , OtherThing ";
    field._fire("change");
    await h.flush();
    assertEqual(h.tracker.lowZoom.state.snapExclude.join(","), "SnapThing,OtherThing", "typing a list applies it, trimmed and without blanks");
    assertEqual(field.value, "SnapThing, OtherThing", "and the field shows what was accepted");
    // A type on the list is kept live *on purpose* and says so, rather than
    // being counted as a capture that failed. The capture path is what counts
    // it, so a box has to be painted for the node to reach that path — and a
    // picture that already existed has to be dropped, or the list would appear
    // to do nothing until the node next changed.
    const capturedBefore = h.tracker.lowZoom.snapshots.captured;
    draw(h, 1);
    await idle(h);
    h.advance(600);
    await h.flush();
    assertGreater(h.tracker.lowZoom.snapshots.keptLive, 0, "the engine counts it as kept live on purpose, not as a failed capture");
    assertEqual(h.tracker.lowZoom.snapshots.captured, capturedBefore, "and no new picture is taken for a type on the list");
    // And an empty box clears it again.
    field.value = "";
    field._fire("change");
    assertEqual(h.tracker.lowZoom.state.snapExclude.length, 0, "clearing the field clears the list");
  });
});

// The two ways a snapshot store can quietly go wrong on a long-lived page: memory
// nobody is using any more, and a node that no longer exists. Both are handled by
// machinery that already runs — the master switch and the once-a-second sweep —
// so they are pinned here rather than left to a reading of the code.
suite("drawing: node snapshots — what releases a bitmap besides the budget", () => {
  function graph(h, count) {
    h.canvas.ds.scale = 0.1;
    h.canvas.links = [];
    const nodes = [];
    for (let i = 0; i < count; i++) {
      const n = h.node({ type: "SnapThing", pos: [i * 240, 0], size: [200, 100] });
      n.type = "SnapThing";
      nodes.push(n);
    }
    h.canvas.nodes = nodes;
    h.app.graph._nodes = nodes;
    return nodes;
  }
  const idle = async (h, ms = 1000) => {
    h.advance(ms);
    await h.flush();
    h.advance(ms);
    await h.flush();
  };
  const api = (h) => h.tracker.lowZoom.snapshots;

  test("the master switch hands the memory back with the page", async () => {
    const h = await boot();
    graph(h, 3);
    h.tracker.lowZoom.set({ flatBelow: 0.2, snapshots: true });
    h.advance(FRAME_MS);
    h.canvas.setDirty(true, true);
    h.canvas.draw();
    await idle(h);
    assertGreater(api(h).bytes, 0, "holding bitmaps while switched on");
    assertEqual(h.tracker.lowZoom.setEnabled(false), false, "the switch goes off");
    assertEqual(api(h).bytes, 0, "and the bitmaps go with it");
    assertEqual(h.canvases.filter((c) => c.width === 0).length, 9, "every canvas zeroed, including the half and quarter copies");
    assertEqual(h.tracker.lowZoom.setEnabled(true), true, "switched back on");
    // A drawn frame is what puts nodes back in the queue — the same way the first
    // capture happened.
    h.advance(FRAME_MS);
    h.canvas.setDirty(true, true);
    h.canvas.draw();
    await idle(h);
    assertGreater(api(h).captured, 3, "and the next idle lane captures again");
  });

  test("a node that leaves the graph does not keep its bitmap alive", async () => {
    const h = await boot();
    const nodes = graph(h, 3);
    h.tracker.lowZoom.set({ flatBelow: 0.2, snapshots: true });
    h.advance(FRAME_MS);
    h.canvas.setDirty(true, true);
    h.canvas.draw();
    await idle(h);
    const before = api(h).bytes;
    assertGreater(before, 0, "three bitmaps held");
    // The node is deleted the way the frontend deletes one: out of the graph.
    h.canvas.nodes = h.canvas.nodes.filter((n) => n !== nodes[0]);
    h.app.graph._nodes = h.canvas.nodes;
    h.advance(1200); // the sweep's own interval
    await h.flush();
    assertGreater(api(h).pruned, 0, "the sweep pruned the record");
    assertLess(api(h).bytes, before, "and released its pixels");
  });
});

// ---------------------------------------------------------------------------
// Nodes 2.0 (the Vue-nodes renderer). This is the mode the tool must survive
// without painting anything: `LiteGraph.vueNodesMode` is set from
// `Comfy.VueNodes.Enabled`, `LGraphCanvas.drawNode()` returns early, every node
// is a DOM element, and DOM widgets sit in the `[data-testid="dom-widgets"]`
// layer positioned by the frontend's own converter.
//
// What is pinned here, in the order the questions get asked:
//   1. the mode is *detected* (the whole no-painting rule hangs off one flag);
//   2. nothing is painted behind a DOM node, and no node DOM is hidden because
//      of a setting that cannot act on this renderer;
//   3. the settings that do act on this renderer — link ink, the idle cap, the
//      governor, viewport focus — still work, and the measurement is unaffected;
//   4. the stand-in engine does not spend a slice, a byte or a disk write on
//      pictures this renderer can never draw back;
//   5. the panel says which renderer it is looking at, and why the setting that
//      cannot act here is quiet — a control that silently does nothing is worse
//      than one that explains itself.
suite("drawing: the Nodes 2.0 (Vue nodes) frontend", () => {
  const draw = (h, n = 1) => {
    for (let i = 0; i < n; i++) {
      h.advance(FRAME_MS);
      h.canvas.setDirty(true, true);
      h.canvas.draw();
    }
  };
  const idle = async (h, ms = 1000) => {
    h.advance(ms);
    await h.flush();
    h.advance(ms);
    await h.flush();
  };
  const fills = (h) => h.canvas.ctx.ops.filter((o) => o[0] === "fillRect");
  const snapApi = (h) => h.tracker.lowZoom.snapshots;

  // A Vue-nodes page: three nodes, each with a DOM widget (the shape an image
  // preview or a 3D viewport has), all of them rendered as elements.
  function vueGraph(h, count = 3) {
    h.canvas.ds.scale = 0.1; // well below the 50% default: the canvas mode would flatten
    h.canvas.ds.offset[0] = 0;
    h.canvas.ds.offset[1] = 0;
    h.canvas.links = [];
    const nodes = [];
    for (let i = 0; i < count; i++) {
      const n = h.node({ type: "KSampler", pos: [i * 240, 0], size: [200, 100], widgets: [] });
      const el = h.document.createElement("canvas");
      h.document.body.appendChild(el);
      n.addDOMWidget("preview", "img", el, { hideOnZoom: false });
      nodes.push(n);
    }
    h.canvas.nodes = nodes;
    h.app.graph._nodes = nodes;
    for (let i = 0; i < count; i++) h.canvas.links.push({ color: "#888888", from: [0, 0], to: [10, 10] });
    const vue = h.enterVueNodes();
    return { nodes, vue };
  }

  // The stylesheet rule the blanking keys on, read out of the page the way the
  // browser reads it. A test asserts it, because "the attribute is set" and "the
  // browser hides the element" are two different claims and only the pair is the
  // feature.
  const blankRule = (h) => {
    const styles = h.document.querySelectorAll("style") || [];
    return styles.some((el) => {
      const css = String(el.textContent || "");
      return css.includes("[data-ants-vue-standin]") && css.includes("opacity: 0 !important");
    });
  };

  test("the mode is detected, the element is blanked, and the stand-in becomes a picture", async () => {
    const h = await boot();
    const { nodes, vue } = vueGraph(h, 3);
    assertEqual(h.LiteGraph.vueNodesMode, true, "the frontend says which renderer it is (LiteGraph.vueNodesMode)");
    assertEqual(h.tracker.lowZoom.vueNodes, true, "and the tool reads the same flag, not a guess");
    h.tracker.lowZoom.set({ flatBelow: 0.5, snapshots: true });
    const before = fills(h).length;
    draw(h, 3);
    // Before the idle lane has a picture, the box is drawn live — with the node's
    // own content in it, which is what the picture will be a freeze of.
    assertGreater(h.tracker.lowZoom.state.nodes, 0, "boxes are painted for the nodes the frontend renders as elements");
    assertGreater(fills(h).length, before, "and each box is ink on the canvas");
    for (const n of nodes) {
      const root = vue.rootFor(n);
      assert(root, "each node is a DOM element carrying data-node-id");
      assert(root.hasAttribute("data-ants-vue-standin"), "the node's own element is blanked while its box stands in");
      assert(!root.classList.contains("ants-lod-box"), "blanked is not hidden: the element keeps its place and its pointer events");
    }
    const first = snapApi(h);
    assertEqual(first.pathway, "vue", "the pathway is named, so the panel and a script cannot disagree about it");
    assertEqual(first.vueBlanked, 3, "and the readout knows how many elements are blanked");
    assert(blankRule(h), "the stylesheet carries the !important rule the attribute keys on, so Vue cannot outrank it");
    // Then the idle lane makes the picture: this tool draws the box and the
    // node's content into an offscreen surface (no browser API can photograph a
    // DOM element), and it is stored like the canvas renderer's pictures.
    await idle(h);
    const api = snapApi(h);
    assertEqual(api.captured, 3, "each node's stand-in was captured");
    assertGreater(api.bytes, 0, "and the memory it holds is counted");
    assertEqual(api.blank, 0, "none of them was written off as blank: the box is always ink");
    assertGreater(h.canvases.length, 0, "a capture surface was made");
    // The next frame serves the stored picture instead of redrawing the content.
    const served = snapApi(h).drawn;
    h.canvas.ctx.ops.length = 0;
    draw(h, 2);
    assertGreater(snapApi(h).drawn, served, "the stored picture is blitted to the screen");
    assertEqual(snapApi(h).vueContent, 0, "and the live content draw is skipped while a picture exists");
  });

  test("the settings that act on DOM and on links still work", async () => {
    const h = await boot();
    const { nodes, vue } = vueGraph(h, 3);
    // Link ink is a canvas change: links are still drawn by the canvas here.
    // Spline style first: this is the path that keeps the curve and thins the
    // stroke, and it goes through the canvas' own link renderer.
    // (No idle cap here: a merged redraw would skip a frame's links entirely and
    // that is a different feature's test. This one is about ink reaching the canvas.)
    h.tracker.lowZoom.set({ flatBelow: 0, detailZoom: 0.6 });
    h.canvas.ctx.ops.length = 0;
    h.canvas.linkSettings.length = 0;
    draw(h, 1);
    assertGreater(h.tracker.lowZoom.detail.thinLinks, 0, "link thinning still reaches the ink");
    assertGreater(h.canvas.linkSettings.length, 0, "and it went through the canvas' own link drawing");
    assert(
      h.canvas.linkSettings.every((s) => s.width === 1 && s.border === false),
      "every link stroked thin, without its outline"
    );
    // Straight lines are the other canvas link setting, and it is reached too —
    // this one draws the link itself and skips the canvas renderer entirely.
    h.tracker.lowZoom.set({ linkStyle: "straight" });
    const straightBefore = h.tracker.lowZoom.state.links;
    const canvasDraws = h.canvas.linkDraws;
    draw(h, 2);
    assertGreater(h.tracker.lowZoom.state.links, straightBefore, "the straight-line setting draws links itself in this renderer");
    assertEqual(h.canvas.linkDraws, canvasDraws, "and the canvas' own link renderer is not called while it does");

    // Viewport focus: "widgets stop answering" acts on elements, so it works here.
    h.tracker.lowZoom.set({ inertBelow: 0.2, focusDom: "hide" });
    h.advance(1200);
    await h.flush();
    draw(h, 2);
    const wrapper = vue.wrappers.get(nodes[0].widgets[0].element);
    assert(wrapper, "the DOM widget is in the layer the frontend positions");
    assert(wrapper.classList.contains("ants-lod-box"), "its element is switched off below the widget zoom");
    assert(!vue.rootFor(nodes[0]).classList.contains("ants-lod-box"), "the node itself still is not: only its widgets are");
    assertEqual(h.tracker.lowZoom.dom.hidden, 3, "the readout counts all three widget wrappers, each through its widget's own element");
    assertGreater(h.tracker.lowZoom.focus.inertElements, 0, "the engine's inert counter moved");

    // The other route into the registry: a component widget (what a 3D viewport
    // is) has no element of its own, so its wrapper is reachable only through the
    // frontend's DOM widget layer, and the readout keeps that count separate.
    const comp = h.node({ type: "Preview3D", pos: [700, 0], size: [200, 100], widgets: [] });
    const layerEl = h.document.querySelectorAll('[data-testid="dom-widgets"]')[0];
    const compWrapper = h.document.createElement("div");
    compWrapper.className = "dom-widget size-full";
    layerEl.appendChild(compWrapper);
    comp.widgets.push({ name: "view", type: "component", component: {}, node: comp, wrapper: compWrapper });
    h.canvas.nodes.push(comp);
    h.app.graph._nodes.push(comp);
    h.advance(1200);
    await h.flush();
    draw(h, 1);
    assert(compWrapper.classList.contains("ants-lod-box"), "a component widget with no element of its own is reached through the layer");
    assertEqual(h.tracker.lowZoom.dom.layer, 1, "and the readout counts that one as the DOM widget layer");

    // Coming back: above the zoom the widget is handed back.
    h.canvas.ds.scale = 0.5;
    vue.place();
    h.tracker.lowZoom.set({ inertBelow: 0.2 });
    h.advance(1200);
    await h.flush();
    draw(h, 2);
    assert(!wrapper.classList.contains("ants-lod-box"), "and handed back when the node is readable again");
    assert(!wrapper.classList.contains("ants-lod-inert"), "including its inert class");
  });

  test("the blanking survives the frontend re-rendering the node", async () => {
    const h = await boot();
    const { nodes, vue } = vueGraph(h, 3);
    h.tracker.lowZoom.set({ flatBelow: 0.5, snapshots: true });
    draw(h, 2);
    const root = vue.rootFor(nodes[0]);
    assert(root.hasAttribute("data-ants-vue-standin"), "blanked to start with");
    // A re-render, as Vue does it: the node root's class and style are written
    // wholesale. This is the bug that made Nodes 2.0 show no stand-ins at all —
    // the blanking was a class, Vue owned that property, and every re-render
    // silently handed the node back while a box was painted behind it.
    root.className = "lg-node absolute selected";
    root.style.cssText = "transform: translate(0px, -30px); z-index: 3;";
    assert(root.hasAttribute("data-ants-vue-standin"), "the mark is not a class, so a re-render cannot drop it");
    assert(blankRule(h), "and the rule that hides it is !important, so a Vue class cannot outrank it");
    draw(h, 2);
    assert(root.hasAttribute("data-ants-vue-standin"), "still blanked a frame later");
    assertGreater(h.tracker.lowZoom.state.nodes, 0, "and the box is still painted for it");
    // The other half of a re-render: the frontend unmounts the element and mounts
    // a new one for the same node. The box must follow it, not sit over a node
    // that is now drawing itself again.
    const fresh = h.document.createElement("div");
    fresh.className = "lg-node absolute";
    fresh.setAttribute("data-node-id", String(nodes[0].id));
    root.parentNode.appendChild(fresh);
    root.remove();
    assert(!root.isConnected, "the old element is off the page");
    draw(h, 2);
    assert(fresh.hasAttribute("data-ants-vue-standin"), "the tool finds the node's new element and blanks that too");
    // And handing back has to reach an element that is not on the page any more:
    // if the frontend puts it back later, it must not come back invisible.
    h.tracker.lowZoom.set({ flatBelow: 0 });
    h.advance(1200);
    await h.flush();
    assert(!fresh.hasAttribute("data-ants-vue-standin"), "and hands it back when the setting is turned off");
  });

  test("a node the frontend renders taller than its graph size gets a box that covers it", async () => {
    const h = await boot();
    const { nodes, vue } = vueGraph(h, 1);
    stripWidgets(nodes);
    // `LGraphNode.vue`: an image node with an expanding widget is rendered
    // IMAGE_PREVIEW_HEIGHT_RESERVE = 220 + 8 + 4 px taller than its graph size,
    // and the picture lives in that reserve. A stand-in the size of `node.size`
    // would blank the node and then clip off exactly the picture the user is
    // looking for.
    const GROWTH = 232;
    const img = h.document.createElement("img");
    Object.assign(img, { naturalWidth: 512, naturalHeight: 512, complete: true, src: "big.png", currentSrc: "big.png" });
    vue.addMedia(nodes[0], img, { x: 10, y: 104, w: 180, h: GROWTH - 12 }); // 104 = 100 + a 4px gap
    vue.growRoot(nodes[0], GROWTH);
    h.tracker.lowZoom.set({ flatBelow: 0.5, boxDetail: "plain", snapshots: true });
    draw(h, 1); // the frame that measures the element
    h.canvas.ctx.ops.length = 0;
    draw(h, 1);
    const body = h.canvas.ctx.ops.filter((o) => o[0] === "fillRect" && Number(o[3]) === 200 && Number(o[4]) === 100 + GROWTH);
    assertGreater(body.length, 0, "the stand-in is the box the frontend rendered, not the graph size");
    assertEqual(h.canvas.ctx.ops.filter((o) => o[0] === "fillRect" && Number(o[4]) === 100).length, 0, "and not the shorter one");
    // The picture the idle lane makes is the same box: the image sits at 104,
    // below the node's 100-unit graph height, and is inside the capture.
    await idle(h);
    const capt = h.canvases.filter((c) => c._ctx && c._ctx.ops.some((o) => o[0] === "drawImage" && o[1] === img));
    assertGreater(capt.length, 0, "the node's own picture is inside the stand-in made for it");
    const op = capt[0]._ctx.ops.find((o) => o[0] === "drawImage" && o[1] === img);
    assertGreater(op[3], 100, "at the row the frontend gave it, below the graph height");
    assertGreater(capt[0].height, 100 + GROWTH, "and the capture surface is tall enough to hold it");
  });

  test("the media layout is re-read on a budget, never once per node per frame", async () => {
    const h = await boot();
    // This is the page *without* the observers — the fallback path, where the tool
    // has to ask on a timer whether anything moved. (The observer path is the one a
    // browser takes; the next test covers it, and it asks nothing at all.)
    h.setDomObservers(false);
    const { nodes, vue } = vueGraph(h, 12);
    for (const n of nodes) {
      const img = h.document.createElement("img");
      Object.assign(img, { naturalWidth: 256, naturalHeight: 256, complete: true, src: "p.png", currentSrc: "p.png" });
      vue.addMedia(n, img, { x: 10, y: 40, w: 150, h: 150 });
    }
    h.tracker.lowZoom.set({ flatBelow: 0.5, snapshots: true });
    draw(h, 2);
    // Past the backstop, every boxed node would ask for its layout back at once.
    // Reading a rect is a forced layout, and the draw loop is the frame budget
    // this tool exists to protect, so the backstop reads are rationed: with a
    // dozen nodes a frame may not spend one probe per node.
    h.advance(600);
    h.canvas.setDirty(true, true);
    const before = h.rectReads;
    h.canvas.draw();
    const reads = h.rectReads - before;
    assertGreater(reads, 0, "the backstop did re-read some of them");
    assert(reads < nodes.length * 2, `re-reads stayed inside the frame's ration (${reads} rect reads for ${nodes.length} nodes)`);
    // Panning and zooming move the element and everything inside it by the same
    // transform, so every number this pass reads (a child's rect minus the node's,
    // over the zoom) is unchanged. A key that included the pan or the zoom would
    // mean a forced layout per boxed node per frame while the user drags — so a
    // pan must cost nothing at all.
    h.advance(600);
    draw(h, 2); // let the ration work through the whole set first
    h.canvas.ds.offset[0] = 500;
    h.canvas.ds.offset[1] = 300;
    h.canvas.ds.scale = 0.3;
    vue.place();
    h.canvas.setDirty(true, true);
    const beforePan = h.rectReads;
    h.canvas.draw();
    assertEqual(h.rectReads - beforePan, 0, "a pan and a zoom cost no layout read");
    // The node's own size is the key. Change it and that node — and only that
    // node — is re-read at once, because its content really did move.
    nodes[0].size = [300, 200];
    vue.place();
    h.canvas.setDirty(true, true);
    const beforeSize = h.rectReads;
    h.canvas.draw();
    const sizeReads = h.rectReads - beforeSize;
    assertGreater(sizeReads, 0, "the node whose size changed was re-read");
    assert(sizeReads < nodes.length * 2 - 1, `and only it: the rest kept their measurements (${sizeReads} reads)`);
  });

  test("a picture in this renderer is the box plus the node's own content, and it reaches the disk", async () => {
    const h = await boot();
    const { nodes, vue } = vueGraph(h, 3);
    const img = h.document.createElement("img");
    Object.assign(img, { naturalWidth: 512, naturalHeight: 512, complete: true, src: "shot.png", currentSrc: "shot.png" });
    vue.addMedia(nodes[0], img, { x: 10, y: 40, w: 180, h: 220 });
    // The server's half, played by the test: one file per node id, written on PUT.
    const puts = [];
    h.fetchRoutes.set("/ants_optimizer/thumbs/sweep", { removed: 0 });
    h.fetchRoutes.set("/ants_optimizer/thumbs/info", { dir: "/tmp", count: 0 });
    h.fetchRoutes.set("/ants_optimizer/thumbs/*", (req) => {
      if (req.method === "PUT") {
        puts.push({ url: req.url, body: req.body });
        return { ok: true, status: 204, json: async () => ({}) };
      }
      return { ok: false, status: 404, json: async () => ({}), blob: async () => null };
    });
    h.tracker.lowZoom.set({ flatBelow: 0.5, snapshots: true, diskOn: true });
    draw(h, 2);
    await idle(h);
    const api = snapApi(h);
    assertGreater(api.captured, 0, "the stand-ins were captured in this renderer too");
    // The node's own picture is in the capture surface, at the row the layout gave
    // it — the half a widget-only composite could never see.
    const withImage = h.canvases.filter((c) => c._ctx && c._ctx.ops.some((o) => o[0] === "drawImage" && o[1] === img));
    assertGreater(withImage.length, 0, "the node's own image is inside the picture");
    const mediaOp = withImage[0]._ctx.ops.find((o) => o[0] === "drawImage" && o[1] === img);
    assertEqual(Math.round(mediaOp[3]), 40, "drawn at the row the layout gave it, in the node's own units");
    assertEqual(Math.round(mediaOp[4]), 180, "and at the size the layout gave it");
    assertEqual(api.diskSaved, 3, "and every picture was written to the stand-in store");
    assertEqual(puts.length, 3, "one file per node, as the canvas renderer writes them");
    assert(puts.every((p) => /sig=[^&]*r1t[0-9a-z]+pv$/.test(p.url)), "keyed by the capture resolution, the theme and the pathway it was drawn in");
  });

  test("an off-screen DOM node is not hidden while it is on screen, and the fovea still culls", async () => {
    const h = await boot();
    const { nodes, vue } = vueGraph(h, 3);
    // Node 2 is far outside the viewport (the graph is 1600x900 CSS px at scale 0.1).
    nodes[2].pos = [40000, 0];
    vue.place();
    h.tracker.lowZoom.set({ flatBelow: 0, fovea: true, foveaMargin: 0.5, foveaRestore: 1 });
    h.advance(1200);
    await h.flush();
    draw(h, 2);
    assert(vue.rootFor(nodes[2]).hasAttribute("data-ants-dom-hidden"), "a far off-screen node's element is taken out of the picture");
    assert(!vue.rootFor(nodes[0]).classList.contains("ants-lod-box"), "an on-screen node's element is never hidden");
    // Bring it back: it must come back at once, because it is on screen now.
    nodes[2].pos = [0, 200];
    vue.place();
    draw(h, 2);
    assert(!vue.rootFor(nodes[2]).hasAttribute("data-ants-dom-hidden"), "and it is handed back the moment it returns to the screen");
    // Off, everything is handed back.
    h.tracker.lowZoom.off();
    assertEqual(h.tracker.lowZoom.dom.hidden, 0, "turning the settings off leaves none of somebody else's DOM hidden");
  });

  test("the panel names the renderer instead of blaming the flatten setting", async () => {
    const h = await boot();
    vueGraph(h, 3);
    h.tracker.lowZoom.set({ flatBelow: 0.5, snapshots: true });
    draw(h, 1);
    h.advance(1200);
    await h.flush();
    await openTweaksTab(h);
    const text = panelText(h);
    assertIncludes(text, "Vue nodes", "the readout says which renderer this is");
    assert(!text.includes("collapsed boxes or this tool's own node, which are never flattened"), "and does not blame collapsed nodes for a decision this renderer made");
    assert(!text.includes("snapshots are on but not painting anything"), "nor the flatten setting, which is switched on and below its zoom");
    assertIncludes(text, "node element(s) marked", "it says what a stand-in is in this renderer");
    assertIncludes(text, "the browser skips the paint of those subtrees", "and says what the mark costs the frontend: the paint, not the layout, so the numbers still come from the DOM");
    // The copyable report is read by people who never open the panel, so it has
    // to be as honest as the panel is.
    const report = h.tracker.report;
    assert(!report.includes("every node a rectangle"), "the report does not claim nodes are rectangles here");
    assert(!report.includes("node stand-ins idle"), "nor that the stand-ins are idle");
  });

  test("a picture belongs to the renderer it was drawn in: switching renderers re-makes them", async () => {
    const h = await boot();
    const nodes = [];
    for (let i = 0; i < 2; i++) nodes.push(h.node({ type: "KSampler", pos: [i * 240, 0], size: [200, 100], widgets: [] }));
    h.canvas.nodes = nodes;
    h.app.graph._nodes = nodes;
    h.canvas.ds.scale = 0.1;
    h.tracker.lowZoom.set({ flatBelow: 0.5, snapshots: true });
    draw(h, 2);
    await idle(h);
    const canvasCaptured = snapApi(h).captured;
    assertGreater(canvasCaptured, 0, "the canvas renderer captured pictures for these nodes");
    assertGreater(snapApi(h).held, 0, "and is holding them");
    // The flag flips on the live page (useVueFeatureFlags watches the setting).
    // A picture is the node's box in the renderer it was made in — different pad,
    // different title bar, different content route — so the old ones are released
    // and made again rather than reused.
    const vue = h.enterVueNodes();
    draw(h, 2);
    await idle(h);
    const inVue = snapApi(h);
    assertEqual(inVue.pathway, "vue", "the pathway changed with the renderer");
    assertGreater(inVue.captured, canvasCaptured, "and new pictures were made for this renderer");
    assertGreater(inVue.clears, 0, "the switch released the pictures the other renderer had made");
    vue.exit();
    draw(h, 2);
    await idle(h);
    assertGreater(snapApi(h).captured, inVue.captured, "switching back makes canvas pictures again");
  });

  test("switching the renderer back on the same page brings the stand-ins back, without a reload", async () => {
    const h = await boot();
    const { nodes, vue } = vueGraph(h, 3);
    h.tracker.lowZoom.set({ flatBelow: 0.5, snapshots: true });
    h.canvas.ds.scale = 0.4; // below the setting: both pathways act at this zoom
    draw(h, 2);
    assertGreater(h.tracker.lowZoom.state.nodes, 0, "boxes are painted while the nodes are DOM elements");
    assertEqual(h.tracker.lowZoom.snapshots.pathway, "vue", "through the Vue pathway");
    assert(vue.rootFor(nodes[0]).hasAttribute("data-ants-vue-standin"), "and the node's element is blanked with it");
    // The frontend watches its own setting and flips the flag on the live
    // LiteGraph object (useVueFeatureFlags.ts), so this answer has to be read per
    // frame rather than latched when the page loaded.
    vue.exit();
    draw(h, 2);
    assertGreater(h.tracker.lowZoom.state.nodes, 0, "switching the renderer off brings node flattening straight back");
    assertEqual(h.tracker.lowZoom.snapshots.pathway, "canvas", "the canvas pathway takes over on the same page");
    assert(!vue.rootFor(nodes[0]).hasAttribute("data-ants-vue-standin"), "and every element this tool blanked is handed back");
    assertGreater(h.tracker.lowZoom.snapshots.vueRestored, 0, "the hand-back is counted");
  });

  test("above the threshold the elements are handed back, and no box is painted", async () => {
    const h = await boot();
    const { nodes, vue } = vueGraph(h, 3);
    h.tracker.lowZoom.set({ flatBelow: 0.5, snapshots: true });
    draw(h, 2);
    assert(vue.rootFor(nodes[0]).hasAttribute("data-ants-vue-standin"), "blanked below the threshold");
    h.canvas.ds.scale = 0.6; // above it
    const before = fills(h).length;
    const simplified = h.tracker.lowZoom.state.nodes; // cumulative: the boxes above it are counted
    draw(h, 2);
    for (const n of nodes) assert(!vue.rootFor(n).hasAttribute("data-ants-vue-standin"), "the element is handed back above the threshold");
    assertEqual(fills(h).length, before, "and no box is painted for a node that draws itself");
    assertEqual(h.tracker.lowZoom.state.nodes, simplified, "and not one more node draw is counted as simplified");
  });

  test("a node that is running, erroring or playing a video keeps its own element", async () => {
    const h = await boot();
    const { nodes } = vueGraph(h, 3);
    h.tracker.lowZoom.set({ flatBelow: 0.5, snapshots: true });
    nodes[0].progress = 0.5; // a running node draws its own bar
    nodes[1].has_errors = true; // an error stroke is live state
    const video = h.document.createElement("video");
    const host = h.document.createElement("div");
    host.appendChild(video);
    nodes[2].addDOMWidget("preview", "video", host, { hideOnZoom: false });
    draw(h, 2);
    const api = snapApi(h);
    assertEqual(api.vueBlanked, 0, "none of the three is blanked");
    assertEqual(api.vueBoxes, 0, "and no box is painted over a node that draws itself");
  });

  // The fixture gives every node a canvas DOM widget (a 3D viewport's shape), so
  // a test that wants to count content exactly takes those back off first.
  const stripWidgets = (nodes) => {
    for (const n of nodes) {
      n.widgets.length = 0;
      if (n._domWidgets) n._domWidgets.length = 0;
    }
  };

  test("a box carries the node's own image, at the widget's row and at the picture level", async () => {
    const h = await boot();
    const { nodes } = vueGraph(h, 2);
    stripWidgets(nodes);
    const img = h.document.createElement("img");
    Object.assign(img, { naturalWidth: 64, naturalHeight: 64, complete: true, src: "a.png", currentSrc: "a.png" });
    nodes[0].addDOMWidget("image", "image", img, { hideOnZoom: false, y: 20, computedHeight: 60 });
    h.tracker.lowZoom.set({ flatBelow: 0.5, snapshots: true });
    h.canvas.ctx.ops.length = 0;
    draw(h, 1);
    const drawn = h.canvas.ctx.ops.filter((o) => o[0] === "drawImage" && o[1] === img);
    assertEqual(drawn.length, 1, "the node's own image is drawn into its box");
    const op = drawn[0];
    // The same row the canvas renderer's capture composites it at — margin 10,
    // widget.y 20, height 60, node width 200: one geometry, both renderers.
    assertEqual(op[2], 10, "x is the widget margin");
    assertEqual(op[3], 30, "y is the margin plus the widget's own row");
    assertEqual(op[4], 180, "and the width is the node's, minus the margin twice");
    assertEqual(op[5], 40, "with the height the widget reports, minus the margin twice");
    assertEqual(h.tracker.lowZoom.snapshots.vueContent, 1, "the gauge counts the content drawn on the frame");
    // The stand-in setting is "picture of the node", so the box is the picture
    // level: a title bar drawn above the body, not a plain fill.
    assert(
      h.canvas.ctx.ops.some((o) => o[0] === "fillRect" && o[2] < 0),
      "the picture level is used: the node's title bar is drawn above its body"
    );
  });

  test("a box carries a text widget's value, and follows an edit on the next frame", async () => {
    const h = await boot();
    const { nodes } = vueGraph(h, 2);
    stripWidgets(nodes);
    const ta = h.document.createElement("textarea");
    ta.value = "a photo of a cat";
    nodes[0].addDOMWidget("text", "text", ta, { hideOnZoom: true, computedHeight: 80 });
    h.tracker.lowZoom.set({ flatBelow: 0.5, snapshots: true });
    h.canvas.ctx.ops.length = 0;
    draw(h, 1);
    const first = h.canvas.ctx.ops.filter((o) => o[0] === "fillText" && String(o[1]).includes("cat"));
    assertEqual(first.length, 1, "the widget's value is painted into the box");
    assertEqual(h.tracker.lowZoom.snapshots.vueContent, 1, "counted as content");
    // No capture, no signature, no invalidation: the box is drawn from what the
    // widget holds right now, so an edit shows up on the next frame by itself.
    ta.value = "a photo of a dog";
    h.canvas.ctx.ops.length = 0;
    draw(h, 1);
    assertEqual(h.canvas.ctx.ops.filter((o) => o[0] === "fillText" && String(o[1]).includes("dog")).length, 1, "the edit is in the box on the next drawn frame");
    assertEqual(h.canvas.ctx.ops.filter((o) => o[0] === "fillText" && String(o[1]).includes("cat")).length, 0, "and the old text is gone");
  });

  test("a box leaves a pack's own HTML blank, and a node with no content is just a box", async () => {
    const h = await boot();
    const { nodes } = vueGraph(h, 2);
    stripWidgets(nodes);
    const div = h.document.createElement("div");
    div.appendChild(h.document.createElement("img")); // two images in a wrapper: a guess, so nothing is drawn
    div.appendChild(h.document.createElement("img"));
    nodes[0].addDOMWidget("custom", "div", div, { hideOnZoom: false });
    h.tracker.lowZoom.set({ flatBelow: 0.5, snapshots: true });
    h.canvas.ctx.ops.length = 0;
    draw(h, 1);
    assertEqual(h.canvas.ctx.ops.filter((o) => o[0] === "drawImage").length, 0, "a wrapper with two images in it is not guessed at");
    assertEqual(h.tracker.lowZoom.snapshots.vueContent, 0, "and nothing is counted as content");
    assertGreater(h.canvas.ctx.ops.filter((o) => o[0] === "fillRect").length, 0, "the node is still a box");
  });

  test("the stand-in setting off means the box ladder, with no content in the boxes", async () => {
    const h = await boot();
    const { nodes } = vueGraph(h, 2);
    stripWidgets(nodes);
    const img = h.document.createElement("img");
    Object.assign(img, { naturalWidth: 64, naturalHeight: 64, complete: true, src: "a.png", currentSrc: "a.png" });
    nodes[0].addDOMWidget("image", "image", img, { hideOnZoom: false, y: 20, computedHeight: 60 });
    h.tracker.lowZoom.set({ flatBelow: 0.5, snapshots: false, boxDetail: "title" });
    h.canvas.ctx.ops.length = 0;
    draw(h, 1);
    assertEqual(h.canvas.ctx.ops.filter((o) => o[0] === "drawImage" && o[1] === img).length, 0, "no content is drawn for a box detail level");
    assertEqual(h.tracker.lowZoom.snapshots.vueContent, 0, "and the gauge says so");
    assertGreater(h.canvas.ctx.ops.filter((o) => o[0] === "fillRect").length, 0, "the title-level box is still drawn");
  });

  test("a node's own rendered image is in its box, at the position the layout gives it", async () => {
    const h = await boot();
    const { nodes, vue } = vueGraph(h, 2);
    stripWidgets(nodes);
    // The shape ImagePreview.vue has: the node renders its own <img> inside its
    // own DOM, mounted nowhere near a widget — so the widget route cannot see it.
    const img = h.document.createElement("img");
    Object.assign(img, { naturalWidth: 512, naturalHeight: 512, complete: true, src: "shot.png", currentSrc: "shot.png" });
    vue.addMedia(nodes[0], img, { x: 10, y: 40, w: 180, h: 220 });
    h.tracker.lowZoom.set({ flatBelow: 0.5, snapshots: true });
    h.canvas.ctx.ops.length = 0;
    draw(h, 1);
    const drawn = h.canvas.ctx.ops.filter((o) => o[0] === "drawImage" && o[1] === img);
    assertEqual(drawn.length, 1, "the node's own image is drawn into its box");
    const op = drawn[0];
    // Node-local units, recovered from layout: the node's element sits one title
    // bar above the node's own origin in that pane, and the conversion takes that
    // off — so what comes back is the position the fixture laid the image out at.
    assertEqual(op[2], 10, "x is the position the layout gave it, in the node's own units");
    assertEqual(op[3], 40, "y is the same, 40 below the node's origin");
    assertEqual(op[4], 180, "and the width is the element's own");
    assertEqual(op[5], 220, "with the height the layout gave it");
    assertEqual(h.tracker.lowZoom.snapshots.vueMedia, 1, "the gauge counts the node's own media drawn");
    assertEqual(h.tracker.lowZoom.snapshots.vueContent, 1, "and the content total with it");
  });

  test("the layout is read on a change, not on every frame", async () => {
    const h = await boot();
    const { nodes, vue } = vueGraph(h, 2);
    stripWidgets(nodes);
    const img = h.document.createElement("img");
    Object.assign(img, { naturalWidth: 64, naturalHeight: 64, complete: true, src: "a.png", currentSrc: "a.png" });
    vue.addMedia(nodes[0], img, { x: 10, y: 40, w: 100, h: 100 });
    h.tracker.lowZoom.set({ flatBelow: 0.5, snapshots: true });
    draw(h, 2);
    const readsAfterFirst = h.rectReads;
    draw(h, 4); // nothing about the node has changed
    assertEqual(h.rectReads, readsAfterFirst, "four more frames with an unchanged node read no layout at all");
    // A zoom is *not* a change to anything stored here: the numbers are node-local
    // (a child's rect minus the node's own, over the zoom), so the transform
    // cancels out. Reading layout while the user scrolls the wheel would be one
    // forced layout per boxed node per frame, which is the cost this tool exists to
    // remove.
    h.canvas.ds.scale = 0.35;
    vue.place();
    draw(h, 1);
    assertEqual(h.rectReads, readsAfterFirst, "a zoom reads nothing, because nothing node-local moved");
    // The node's own size is the change that matters, and it is read at once.
    nodes[0].size = [260, 140];
    vue.place();
    draw(h, 1);
    assertGreater(h.rectReads, readsAfterFirst, "a node that was resized re-reads the layout");
  });

  test("a picture is the node, not a box in its place", async () => {
    const h = await boot();
    const { nodes, vue } = vueGraph(h, 2);
    stripWidgets(nodes);
    // The node's own rendered text. In this renderer a widget's label and its
    // value are DOM text inside the node's element, and no browser API photographs
    // an element — so the text is *read* and re-painted. Without it a picture is a
    // coloured rectangle with the node's shape, which is what a user calls a box.
    const root = vue.rootFor(nodes[0]);
    const label = h.document.createElement("span");
    label.textContent = "steps 20";
    label.style.fontSize = "14px";
    label.style.color = "rgb(255, 0, 0)";
    root.appendChild(label);
    label._rect = { left: root._rect.left + 12 * 0.1, top: root._rect.top + (30 + 44) * 0.1, width: 140 * 0.1, height: 16 * 0.1 };
    // …and the node's title, which the frontend renders in the element's own title
    // bar — above the body, where the canvas draws a node's title. A picture that
    // clipped to the body alone would cut the node's name off it.
    const title = h.document.createElement("span");
    title.textContent = "KSampler";
    root.insertBefore(title, label);
    title._rect = { left: root._rect.left + 26 * 0.1, top: root._rect.top + 8 * 0.1, width: 70 * 0.1, height: 14 * 0.1 };
    h.tracker.lowZoom.set({ flatBelow: 0.5, snapshots: true });
    h.canvas.ctx.ops.length = 0;
    draw(h, 1);
    const live = h.canvas.ctx.ops.filter((o) => o[0] === "fillText");
    assertEqual(live.length, 2, "the node's own text is painted into the live box");
    const line = (text) => live.find((o) => o[1] === text);
    assert(line, "the widget's label is there");
    assert(line("KSampler"), "and so is the title, in the title bar above the body");
    assert(line("KSampler")[3] < 0, "drawn where the title bar is, not inside the body");
    assertEqual(line("steps 20")[1], "steps 20", "with the string the DOM holds");
    // …where the browser laid it out: node-local, with the title bar taken off the
    // top — the space the canvas draws a node's body in. (The label sits 74 px from
    // the element's top, which is 44 px into the body; a single line is drawn from
    // the top of its own line box, which is where the glyphs start.) A picture that
    // painted the element's client position instead would put every label one title
    // bar too low.
    const body = line("steps 20");
    assertEqual(`${Math.round(body[2])},${Math.round(body[3])}`, "14,44", "at the position the browser gave it, in the node's own units");
    const bar = line("KSampler");
    assertEqual(`${Math.round(bar[2])},${Math.round(bar[3])}`, "28,-22", "and the title where its own box is, one title bar up");
    assertGreater(snapApi(h).vueText, 0, "and the readout counts the lines it could read");
    assert(h.canvas.ctx.ops.some((o) => o[0] === "clip"), "clipped to the box the text belongs in");
    // …and the clip covers the title bar as well as the body: a clip on the body
    // alone cuts the node's own title off its picture, which a browser does and a
    // recording context does not.
    const clips = h.canvas.ctx.ops.filter((o) => o[0] === "rect");
    assert(
      clips.some((o) => o[2] <= -28 && o[2] + o[4] >= 100),
      "the clip reaches up into the title bar, where the title is drawn"
    );
    await idle(h);
    const cap = h.canvases.find((c) => c._ctx && c._ctx.ops.some((o) => o[0] === "fillText" && o[1] === "steps 20"));
    assert(cap, "and the picture the tool stores carries it too, not just the live box");
    assert(cap._ctx.ops.some((o) => o[0] === "fillText" && o[1] === "KSampler"), "the title included");
  });

  test("a node whose element is off the page is given a box, never stored as a picture", async () => {
    const h = await boot();
    const { nodes, vue } = vueGraph(h, 2);
    stripWidgets(nodes);
    // The frontend mounts only what it renders, so an element can be off the page
    // while the node is still in the graph. Everything a picture is made of lives
    // in that element, so a box is all that can be drawn for this node — and a box
    // stored under the node's key would be served to every later frame as if it
    // were a picture of the node, which is the "cached boxes" a user must never see.
    vue.rootFor(nodes[0]).remove();
    h.tracker.lowZoom.set({ flatBelow: 0.5, snapshots: true });
    h.canvas.ctx.ops.length = 0;
    draw(h, 2);
    await idle(h);
    const api = snapApi(h);
    assertEqual(api.captured, 1, "only the node whose element is on the page was photographed");
    assertGreater(api.vueUnreached, 0, "the node without an element is counted as unreachable");
    assertEqual(api.pictured, 1, "and no picture is held for it");
    assert(
      h.canvas.ctx.ops.some((o) => o[0] === "fillRect" && Math.round(o[3]) === 200),
      "the node still gets a box of its own size to stand in for it"
    );
    // The other half of the rule, and the one that stored a bare box: the element
    // is on the page when the box is drawn and leaves it while the capture is
    // waiting for its idle slot — a re-render, or the user switching renderers.
    // The capture has to refuse, because what it could draw by then is the box.
    const h2 = await boot();
    const g2 = vueGraph(h2, 2);
    stripWidgets(g2.nodes);
    h2.tracker.lowZoom.set({ flatBelow: 0.5, snapshots: true });
    draw(h2, 1);
    assertEqual(snapApi(h2).vueBlanked, 2, "both nodes are blanked and asked for a picture");
    g2.vue.rootFor(g2.nodes[0]).remove();
    await idle(h2);
    const api2 = snapApi(h2);
    assertGreater(api2.vueNoElement, 0, "the capture was refused, not made from a box");
    assertEqual(api2.pictured, 1, "and the node without an element has no picture stored");
    assertEqual(api2.captured, 1, "only the node that could be reached was photographed");
  });

  test("a stand-in mode that is not a picture leaves the stand-ins standing", async () => {
    const h = await boot();
    const { nodes, vue } = vueGraph(h, 3);
    stripWidgets(nodes);
    h.tracker.lowZoom.set({ flatBelow: 0.5, snapshots: true });
    draw(h, 2);
    const blanked = () => nodes.filter((n) => vue.rootFor(n).hasAttribute("data-ants-vue-standin")).length;
    assertEqual(blanked(), 3, "all three nodes are blanked while the stand-ins are on");
    // What the panel's stand-in select does when the user picks anything other than
    // "picture of the node": the pictures go, the box ladder takes over. The
    // stand-ins must simply change shape. The failure this pins is the frame plan
    // and the draw loop disagreeing about whether anything stands in at all: the
    // plan handed every element back at the top of every frame, the draw loop
    // blanked it again to paint the box, and the frames the frontend got in between
    // showed the node in full — nodes flickering between a box and the frontend's
    // own node across the whole canvas.
    h.tracker.lowZoom.set({ snapshots: false, boxDetail: "title" });
    const before = snapApi(h);
    const restored0 = before.vueRestored;
    const cleared0 = before.vueCleared;
    h.canvas.ctx.ops.length = 0;
    draw(h, 1);
    const oneFrame = fills(h).length;
    assertGreater(oneFrame, 0, "the boxes are still drawn");
    h.canvas.ctx.ops.length = 0;
    draw(h, 6);
    const api = snapApi(h);
    assertEqual(blanked(), 3, "the elements stay handed over to the tool");
    assertEqual(api.vueRestored - restored0, 0, "nothing is handed back, frame after frame");
    assertEqual(api.vueCleared, cleared0, "and nothing is cleared, frame after frame");
    assertEqual(api.vueMedia, 0, "no content is composited in a mode that is not pictures");
    assertEqual(api.captured, 0, "and no picture is attempted for them");
    assertEqual(fills(h).length, oneFrame * 6, "every frame costs the same boxes — no growth, no redraw storm");
    // And back: the pictures return without a frame of anything else in between.
    h.tracker.lowZoom.set({ snapshots: true });
    draw(h, 2);
    await idle(h);
    assertGreater(snapApi(h).captured, 0, "switching back to pictures captures again");
    assertEqual(blanked(), 3, "and the elements are still the tool's to stand in for");
  });

  test("a picture is re-made when the rest of the node arrives, not kept from the first look", async () => {
    const h = await boot();
    const { nodes, vue } = vueGraph(h, 1);
    stripWidgets(nodes);
    const n = nodes[0];
    const root = vue.rootFor(n);
    // The element exists first; the frontend renders the node's text into it a
    // moment later. On a real page that gap is always there — Vue mounts the shell
    // and fills it in — and a capture taken in that gap is a picture of a bare box.
    // What made it permanent was that nothing in the signature changed when the
    // text arrived, so the stale picture was served for the rest of the session.
    h.tracker.lowZoom.set({ flatBelow: 0.5, snapshots: true });
    draw(h, 1);
    await idle(h);
    const api0 = snapApi(h);
    assertEqual(api0.captured, 1, "the node was pictured while its element was still empty");
    assertEqual(api0.pictured, 1, "and that first picture is the one being drawn");
    const first = h.canvases.filter((c) => c.width > 100 && c._ctx);
    assert(
      !first.some((c) => c._ctx.ops.some((o) => o[0] === "fillText")),
      "and that picture has no text in it, because there was none to draw"
    );
    // Now the node's own text arrives (a title and a widget label).
    for (const [txt, left, top] of [["KSampler", 26, 8], ["steps 20", 12, 74]]) {
      const span = h.document.createElement("span");
      span.textContent = txt;
      span.style.fontSize = "12px";
      root.appendChild(span);
      span._rect = { left: root._rect.left + left * 0.1, top: root._rect.top + top * 0.1, width: 60 * 0.1, height: 14 * 0.1 };
    }
    vue.place();
    for (let i = 0; i < 4; i++) draw(h, 1);
    await idle(h);
    await idle(h);
    const api1 = snapApi(h);
    assertGreater(api1.invalidated, 0, "the picture taken before the text was dropped, not kept");
    assertGreater(api1.captured, 1, "and a new one was drawn");
    const withText = h.canvases.filter((c) => c._ctx && c._ctx.ops.some((o) => o[0] === "fillText" && o[1] === "steps 20"));
    assert(withText.length > 0, "the new picture carries the node's text");
    assert(
      withText[0]._ctx.ops.some((o) => o[0] === "fillText" && o[1] === "KSampler"),
      "and its title, in the title bar"
    );
    // What is on screen now is that picture: the frame blits, it does not draw the
    // box with content live.
    h.canvas.ctx.ops.length = 0;
    draw(h, 1);
    assertEqual(fills(h).length, 0, "the box is not painted any more — the picture is");
  });

  test("a node the frontend renders taller than its graph size is pictured at that height", async () => {
    const h = await boot();
    const { nodes, vue } = vueGraph(h, 1);
    stripWidgets(nodes);
    const n = nodes[0];
    const img = h.document.createElement("img");
    Object.assign(img, { naturalWidth: 256, naturalHeight: 256, complete: true, src: "shot.png", currentSrc: "shot.png" });
    vue.addMedia(n, img, { x: 10, y: 40, w: 180, h: 220 });
    h.tracker.lowZoom.set({ flatBelow: 0.5, snapshots: true });
    draw(h, 2);
    await idle(h);
    const surfacesFor = (el) =>
      h.canvases.filter((c) => c._ctx && c._ctx.ops.some((o) => o[0] === "drawImage" && o[1] === el)).map((c) => c.height);
    const before = surfacesFor(img);
    assert(before.length > 0, "the node's image is in a picture");
    assertGreater(Math.max(...before), 110 + 30, "and the surface covers the element's own height, not just the graph size");
    // The frontend grows the element (ImagePreview's reserve appears, or a second
    // image lands below the first). Nothing else changes — so the *height* is the
    // only thing that can invalidate the picture, and it has to: a surface sized from
    // a stale measurement clips exactly what arrived late, and a picture that is
    // never re-made at all is the "photographed too early" a user sees.
    vue.growRoot(n, 232);
    h.advance(1000); // the measurement is now old: the backstop is what notices it
    await h.flush();
    draw(h, 3);
    await idle(h);
    assertGreater(snapApi(h).invalidated, 0, "the short picture was dropped when the element grew");
    assertEqual(snapApi(h).captured, 2, "and the node was pictured again");
    const taller = surfacesFor(img);
    assertGreater(
      Math.max(...taller),
      Math.max(...before),
      `the new surface is taller than the old one (${Math.max(...before)} → ${Math.max(...taller)})`
    );
    // Now the harder half: the element grows *and* the picture is dropped at the same
    // instant for a different reason (content arrived, a widget value changed), so the
    // capture is not waiting on the backstop to notice the height. The surface, the box
    // and the ink come from one measurement, or the part that just arrived is clipped
    // off the picture by the surface that was sized before it existed.
    h.advance(1000);
    await h.flush();
    draw(h, 1); // one frame refreshes the measurement
    const low = h.document.createElement("img");
    Object.assign(low, { naturalWidth: 128, naturalHeight: 128, complete: true, src: "low.png", currentSrc: "low.png" });
    vue.growRoot(n, 420); // the element is now ~560 units tall
    vue.addMedia(n, low, { x: 10, y: 470, w: 120, h: 100 }); // content in the part that just arrived
    n.widgets.push({ name: "steps", type: "number", value: 21 }); // what drops the picture at once
    draw(h, 8);
    await idle(h, 300);
    assertGreater(snapApi(h).captured, 2, "the node was pictured again, for the content that arrived");
    const newest = surfacesFor(low);
    assert(newest.length > 0, "the content in the part that just arrived is drawn into a picture");
    assertGreater(
      Math.max(...newest),
      110 + 420,
      `and the surface holds it (${Math.max(...newest)}px), rather than the height the element had before`
    );
    h.canvas.ctx.ops.length = 0;
    draw(h, 1);
    assertEqual(fills(h).length, 0, "and the tall picture is what the frame draws — no box, no clipped content");
  });

  test("the page is asked for nothing while nothing changes, and reports it when something does", async () => {
    const h = await boot();
    const { nodes, vue } = vueGraph(h, 3);
    for (const n of nodes) {
      const img = h.document.createElement("img");
      Object.assign(img, { naturalWidth: 128, naturalHeight: 128, complete: true, src: "a.png", currentSrc: "a.png" });
      vue.addMedia(n, img, { x: 10, y: 40, w: 120, h: 120 });
    }
    h.tracker.lowZoom.set({ flatBelow: 0.5, snapshots: true });
    draw(h, 2);
    await idle(h);
    // Let the idle lane finish with every node before the steady state is measured:
    // the frames below are the ones that must cost nothing, and a capture still in
    // the queue is a real cost, just not the one this test is about.
    for (let i = 0; i < 8 && snapApi(h).captured < nodes.length; i++) await idle(h);
    const held = snapApi(h).captured;
    assertEqual(held, nodes.length, "every node was pictured before the steady state begins");
    // Three seconds of frames — past every window this tool used to wake up in (the
    // 400 ms backstop, the 100 ms video verdict). The nodes have not changed, and the
    // page is not asked to prove it: no layout read, no DOM query, no computed style,
    // no re-measure of anything.
    draw(h, 1); // nothing pending: the window starts from a frame that has run
    const before = {
      rects: h.ops.rects,
      qsa: h.ops.qsa,
      gcs: h.ops.gcs,
      w: h.tracker.lowZoom.snapshots.vueDomWrites,
      reads: h.tracker.lowZoom.snapshots.vueLayoutReads,
      probes: h.tracker.lowZoom.snapshots.vueProbes,
    };
    for (let i = 0; i < 14; i++) {
      h.advance(200);
      await h.flush();
      draw(h, 1);
    }
    assertEqual(h.ops.rects - before.rects, 0, "three seconds of frames read no layout at all");
    assertEqual(h.ops.qsa - before.qsa, 0, "and ran no DOM query");
    assertEqual(h.ops.gcs - before.gcs, 0, "and read no computed style");
    assertEqual(h.tracker.lowZoom.snapshots.vueDomWrites - before.w, 0, "and wrote nothing to the page");
    assertEqual(h.tracker.lowZoom.snapshots.vueLayoutReads - before.reads, 0, "the tool did not re-measure a node");
    assertEqual(h.tracker.lowZoom.snapshots.vueProbes - before.probes, 0, "nor probe a widget for a video");
    assertEqual(snapApi(h).captured, held, "and no picture was re-made");
    // Now the page changes: a line the frontend draws into the node's element. No
    // frame has run since, and the tool already knows — because the page said so,
    // which is the whole point of the observers.
    const root = vue.rootFor(nodes[0]);
    const span = h.document.createElement("span");
    span.textContent = "steps 20";
    root.appendChild(span);
    span._rect = { left: root._rect.left + 6, top: root._rect.top + 40, width: 60, height: 14 };
    assertGreater(h.tracker.lowZoom.state.vueStale, 0, "the change was reported, not polled for");
    // The picture is dropped by the frame that next compares signatures, and that
    // comparison is gated (LOD_SNAP_SIG_MS, 100 ms) because hashing a node's state is
    // not free. So: past the gate, then a frame.
    h.advance(150);
    await h.flush();
    draw(h, 2);
    await idle(h);
    assertGreater(h.tracker.lowZoom.snapshots.invalidated, 0, "and the picture taken without that line was dropped");
    assertGreater(snapApi(h).captured, held, "and a new one was made for it");
    assertGreater(h.ops.rects - before.rects, 0, "reading layout only now, because something moved");
  });

  test("a node element the frontend replaces is watched like the one it replaced", async () => {
    const h = await boot();
    const { nodes, vue } = vueGraph(h, 1);
    stripWidgets(nodes);
    const n = nodes[0];
    const img = h.document.createElement("img");
    Object.assign(img, { naturalWidth: 128, naturalHeight: 128, complete: true, src: "a.png", currentSrc: "a.png" });
    vue.addMedia(n, img, { x: 10, y: 40, w: 120, h: 120 });
    h.tracker.lowZoom.set({ flatBelow: 0.5, snapshots: true });
    draw(h, 2);
    await idle(h);
    assertEqual(snapApi(h).captured, 1, "the node was pictured");
    // The frontend re-renders the node: the element the tool dressed is gone and a
    // new one with the same node id takes its place.
    const fresh = vue.replaceRoot(n);
    draw(h, 1);
    assert(fresh.hasAttribute("data-ants-vue-standin"), "the new element is the one that gets blanked");
    // A line the frontend draws into the *new* element, with no frame in between.
    const span = h.document.createElement("span");
    span.textContent = "steps 20";
    fresh.appendChild(span);
    span._rect = { left: fresh._rect.left + 6, top: fresh._rect.top + 40, width: 60, height: 14 };
    assertGreater(h.tracker.lowZoom.state.vueStale, 0, "a change inside the new element is reported");
    h.advance(150);
    await h.flush();
    draw(h, 2);
    await idle(h);
    assertGreater(snapApi(h).invalidated, 0, "and the picture made from the element that is gone is dropped");
    assertGreater(snapApi(h).captured, 1, "and a new one is made from the element that is there");
  });

  test("a widget the frontend mounts inside the node is drawn where the browser put it", async () => {
    const h = await boot();
    const { nodes, vue } = vueGraph(h, 1);
    const n = nodes[0];
    stripWidgets(nodes);
    const ta = h.document.createElement("textarea");
    ta.value = "a cat";
    n.addDOMWidget("text", "text", ta, { hideOnZoom: true, y: 20, computedHeight: 60, margin: 10 });
    // What the frontend does with a widget in this renderer: `WidgetDOM.vue` mounts
    // the element *inside the node's own element*, and the browser lays it out. The
    // row fields a canvas-drawn widget would use are not where it ends up — here
    // they disagree on purpose, and the picture has to follow the browser.
    const root = vue.rootFor(n);
    root.appendChild(ta);
    ta._rect = { left: root._rect.left + 12 * 0.1, top: root._rect.top + (30 + 52) * 0.1, width: 100 * 0.1, height: 40 * 0.1 };
    h.tracker.lowZoom.set({ flatBelow: 0.5, snapshots: true });
    draw(h, 2);
    await idle(h);
    // One element, one drawing. The text pass reads this control and paints it in the
    // page's own font and colours, so the DOM-widget route must not paint it as well:
    // the same value twice, a unit apart, is not a picture of a node.
    const cats = () =>
      h.canvases.flatMap((c) => (c._ctx ? c._ctx.ops.filter((o) => o[0] === "fillText" && String(o[1]).includes("cat")).map((o) => Object.assign({ canvas: c }, o)) : []));
    assertEqual(cats().length, 1, "the widget's value is in the picture exactly once");
    const op = cats()[0];
    assertEqual(Math.round(op[2]), 14, "at the x the element was laid out at (12), plus the field's own inset (2)");
    // The element is 40 units tall and the textarea's own text starts at its top:
    // element top 52 + the field's own inset 2 (plus the half-leading, which is zero
    // here because the page's line height and the font's content box agree). A field's
    // line is *not* centred in a box this tall — that is what drew a prompt in the
    // middle of its own field.
    assertEqual(Math.round(op[3]), 54, "and at the top of the field, not centred in it");
    // The layout moves (the frontend re-arranges, a label above grows). The picture
    // follows: the measured box is part of what a picture *is*.
    ta._rect = { left: root._rect.left + 12 * 0.1, top: root._rect.top + (30 + 90) * 0.1, width: 100 * 0.1, height: 40 * 0.1 };
    h.advance(1000);
    await h.flush();
    draw(h, 3);
    await idle(h);
    assertGreater(snapApi(h).invalidated, 0, "the picture taken at the old position was dropped");
    // Per *picture*, not per scene: the stale one is still in the harness's canvas
    // list — what must never happen is one picture carrying the value twice.
    const perCanvas = (y) =>
      h.canvases.map((c) =>
        c._ctx ? c._ctx.ops.filter((o) => o[0] === "fillText" && String(o[1]).includes("cat") && Math.round(o[3]) === y).length : 0
      );
    assertEqual(Math.max(...perCanvas(92)), 1, "the new picture has the value exactly once, not once per route");
    assertEqual(perCanvas(92).reduce((a, b) => a + b, 0), 1, "put where the element is now (top 90, plus the same inset)");
  });

  test("every selector the reader asks the page for is one the page can actually answer", async () => {
    const h = await boot();
    const { nodes, vue } = vueGraph(h, 1);
    const n = nodes[0];
    stripWidgets(nodes);
    // The shape of a node in this renderer, as the reader reads it: a header, a body,
    // a widget grid with a row in it, a slot dot. Each of those is asked for by
    // selector. A selector a browser cannot parse throws; a selector *this* harness
    // cannot express returns nothing — the same empty answer as a node with no such
    // part, so a picture could lose a part and no test would ever say so. The harness
    // records every selector it had to guess at, so this can be asserted instead.
    const root = vue.rootFor(n);
    const S = 0.1;
    const part = (tag, testid, y, cls) => {
      const el = h.document.createElement(tag);
      if (testid) el.setAttribute("data-testid", testid);
      if (cls) el.className = cls;
      el._rect = { left: root._rect.left, top: root._rect.top + (30 + y) * S, width: 200 * S, height: 20 * S };
      root.appendChild(el);
      return el;
    };
    part("div", "node-inner-wrapper", 0);
    part("div", "node-header-" + n.id, 0);
    part("div", "node-body-" + n.id, 20);
    const grid = part("div", "node-widgets", 24);
    for (let i = 0; i < 2; i++) {
      const row = h.document.createElement("div");
      row.className = "lg-node-widget";
      row._rect = { left: root._rect.left + 2 * S, top: root._rect.top + (30 + 26 + i * 18) * S, width: 190 * S, height: 16 * S };
      grid.appendChild(row);
    }
    part("span", null, 60, "slot-dot");
    // The guard itself, first: a selector this harness cannot express has to leave a
    // mark, or the assertion below could never fail and a reader could ask the page
    // for something no test ever sees.
    const probe = h.document.createElement("div");
    root.appendChild(probe);
    probe.querySelectorAll('[data-testid="node-widgets"] > *');
    assertEqual(h.document._qsaUnsupported.length, 1, "a selector the harness cannot express is recorded, not silently empty");
    h.document._qsaUnsupported.length = 0;
    h.tracker.lowZoom.set({ flatBelow: 0.5, snapshots: true });
    draw(h, 2);
    await idle(h);
    assertEqual(
      h.document._qsaUnsupported.length,
      0,
      "no selector the reader used had to be guessed at: " + h.document._qsaUnsupported.join(" | ")
    );
  });

  test("a Vue-rendered widget's value is in the picture, in the control it lives in", async () => {
    const h = await boot();
    const { nodes, vue } = vueGraph(h, 1);
    const n = nodes[0];
    stripWidgets(nodes);
    const root = vue.rootFor(n);
    const S = 0.1;
    // The shape `WidgetGrid.vue` really renders: a grid (`data-testid=node-widgets`)
    // with one row per widget, the control in a `lg-node-widget` element. A
    // Vue-rendered widget is a reka component — a number field is an `<input>`, a
    // slider is a div with `role="slider"` and `aria-valuenow` — so its *value* is not
    // text: it is `value`/`aria-*`, and a reader that skipped form controls left the
    // row drawn as an empty background.
    const grid = h.document.createElement("div");
    grid.setAttribute("data-testid", "node-widgets");
    root.appendChild(grid);
    const mkRow = (y, label, control) => {
      const row = h.document.createElement("div");
      const lab = h.document.createElement("span");
      lab.textContent = label;
      row.appendChild(lab);
      row.appendChild(control);
      grid.appendChild(row);
      row._rect = { left: root._rect.left + 4 * S, top: root._rect.top + (30 + y) * S, width: 190 * S, height: 18 * S };
      lab._rect = { left: root._rect.left + 6 * S, top: root._rect.top + (30 + y + 4) * S, width: 50 * S, height: 10 * S };
      // The row the frontend lays the widget out in: a grid child with its own
      // surface and no class of its own. Reading only the control's own element would
      // miss it, and on a real page that is the panel a node's body is made of.
      row.style.backgroundColor = "rgb(17, 19, 24)";
      return row;
    };
    const field = h.document.createElement("input");
    field.value = "24";
    field.style.backgroundColor = "rgb(24, 28, 36)";
    field.style.color = "rgb(230, 235, 240)";
    const holder = h.document.createElement("div");
    holder.className = "lg-node-widget";
    holder.style.backgroundColor = "rgb(24, 28, 36)";
    holder.appendChild(field);
    const row1 = mkRow(10, "steps", holder);
    holder._rect = { left: root._rect.left + 70 * S, top: root._rect.top + (30 + 10) * S, width: 110 * S, height: 18 * S };
    field._rect = { left: root._rect.left + 72 * S, top: root._rect.top + (30 + 13) * S, width: 100 * S, height: 12 * S };
    const slider = h.document.createElement("div");
    slider.setAttribute("role", "slider");
    slider.setAttribute("aria-valuenow", "0.75");
    slider.setAttribute("aria-valuemin", "0");
    slider.setAttribute("aria-valuemax", "1");
    slider.style.color = "rgb(120, 140, 170)";
    const row2 = mkRow(34, "denoise", slider);
    // The other two shapes the frontend's own widgets take: a checkbox (a tick, not a
    // value string) and a colour input (a swatch of the colour chosen).
    const tick = h.document.createElement("input");
    tick.type = "checkbox";
    tick.checked = true;
    tick.style.color = "rgb(90, 200, 120)";
    const row3 = mkRow(56, "enabled", tick);
    const swatchInput = h.document.createElement("input");
    swatchInput.type = "color";
    swatchInput.value = "#ff0000";
    const row4 = mkRow(78, "tint", swatchInput);
    void row1;
    void row2;
    void row3;
    void row4;
    slider._rect = { left: root._rect.left + 70 * S, top: root._rect.top + (30 + 34) * S, width: 110 * S, height: 18 * S };
    tick._rect = { left: root._rect.left + 70 * S, top: root._rect.top + (30 + 58) * S, width: 10 * S, height: 10 * S };
    swatchInput._rect = { left: root._rect.left + 70 * S, top: root._rect.top + (30 + 80) * S, width: 24 * S, height: 12 * S };
    h.tracker.lowZoom.set({ flatBelow: 0.5, snapshots: true });
    draw(h, 2);
    await idle(h);
    const pic = h.canvases.filter((c) => c._ctx && c._ctx.ops.some((o) => o[0] === "fillText"))[0];
    assert(pic, "the node was pictured");
    const texts = pic._ctx.ops.filter((o) => o[0] === "fillText").map((o) => String(o[1]));
    assert(texts.includes("steps"), "the row's label is there");
    assert(texts.includes("24"), "and the field's value, which is not the element's text");
    // The control's own surface, measured from the element the frontend mounts.
    const fills = pic._ctx.paintLog.filter((p) => /fill/.test(p.op)).map((p) => p.fill);
    assert(fills.includes("rgba(24, 28, 36, 1)"), "the field's own background is drawn");
    assert(fills.includes("rgba(17, 19, 24, 1)"), "and the widget row's own surface, read from the grid the frontend renders");
    // The slider shows its position, not a number: a track with a knob three quarters
    // along it.
    const sliderFills = pic._ctx.paintLog.filter((p) => /fill/.test(p.op) && p.fill === "rgba(120, 140, 170, 1)");
    assert(sliderFills.length > 0, "the slider's track is drawn in the colour the browser computed");
    const knob = pic._ctx.ops.find((o) => o[0] === "arc");
    assert(knob, "with a knob for the value");
    assertGreater(pic._ctx.ops.filter((o) => o[0] === "arc").length, 0, "drawn as a round knob");
    // The knob is where the *value* is: the slider's box runs from x 70 to x 180 in
    // node units and the value is 0.75, so the knob sits in the last quarter. A knob
    // pinned at the left edge would be a slider that shows the wrong number.
    const knobX = Number(knob[1]);
    assertGreater(knobX, 136, "the knob sits three quarters along the track, not at its start");
    assertLess(knobX, 170, "and not past the end of it");
    // A checked box is a tick, drawn on the surface; a colour input is a swatch of
    // the colour itself.
    assert(
      pic._ctx.ops.some((o) => o[0] === "stroke"),
      "a checked box is drawn with its tick"
    );
    assert(
      pic._ctx.paintLog.some((p) => /fill/.test(p.op) && p.fill === "rgba(255, 0, 0, 1)"),
      "a colour input is drawn in the colour it holds"
    );
    assertGreater(snapApi(h).vueControlInk || 0, 3, "and the readout counts the controls it drew");
  });

  test("a long label is wrapped into its own box, in the page's own font", async () => {
    const h = await boot();
    const { nodes, vue } = vueGraph(h, 1);
    const n = nodes[0];
    stripWidgets(nodes);
    const root = vue.rootFor(n);
    const S = 0.1;
    // A prompt block: one element, one long string, laid out by the browser over
    // several lines. The read used to flatten it into a single line and draw that
    // line clipped to the box — one row of text in the middle of an empty block,
    // cut at the right edge. That is the "text gets cut off" a user sees.
    const para = h.document.createElement("div");
    para.textContent = "a long prompt line that has to wrap inside its own box";
    para.style.fontSize = "12px";
    para.style.fontFamily = "Inter, sans-serif";
    para.style.lineHeight = "18px";
    para.style.color = "rgb(200, 210, 220)";
    root.appendChild(para);
    para._rect = { left: root._rect.left + 10 * S, top: root._rect.top + (30 + 20) * S, width: 100 * S, height: 40 * S };
    h.tracker.lowZoom.set({ flatBelow: 0.5, snapshots: true });
    draw(h, 2);
    await idle(h);
    const pic = h.canvases.filter((c) => c._ctx && c._ctx.ops.some((o) => o[0] === "fillText"))[0];
    assert(pic, "the text reached the picture");
    const lines = pic._ctx.ops.filter((o) => o[0] === "fillText");
    // 40 units of box at an 18px line height: two lines fit, and two are drawn.
    assertEqual(lines.length, 2, "as many lines as the box has room for");
    for (const l of lines) {
      assertGreater(l[1].length, 1, "each drawn line carries text");
      assertLess(String(l[1]).length, 20, "and no line is the whole unwrapped string");
    }
    assertIncludes(String(lines[1][1]), "\u2026", "the last visible line is marked as the cut one");
    // The font is the page's: same family, same size. A picture drawn in LiteGraph's
    // font is a picture of a node nobody has.
    assertIncludes(String(lines[0][4]), "Inter", "drawn in the element's own font family");
    assertIncludes(String(lines[0][4]), "12px", "at the size the browser computed");
    assertEqual(String(lines[0][5]), "rgba(200, 210, 220, 1)", "in the colour the browser computed");
    // Where the line boxes are: the element sits 20 units into the node's body, its
    // two lines are centred in the 40-unit box (2 units of slack) and the first one
    // leads in by half the leftover line height (1.5) — y 24, the next one 18 down.
    assertEqual(`${Math.round(lines[0][2])},${Math.round(lines[0][3])}`, "12,24", "the first line at its own box");
    assertEqual(Math.round(lines[1][3] - lines[0][3]), 18, "and the next one a line height down");
  });

  test("a colour the canvas cannot parse is translated, not dropped", async () => {
    const h = await boot();
    const { nodes, vue } = vueGraph(h, 1);
    const n = nodes[0];
    stripWidgets(nodes);
    vue.addStructure(n, { title: "Scheduler", inputs: ["model"], header: "oklch(0.7 0.15 150)" });
    const root = vue.rootFor(n);
    const S = 0.1;
    const wrap = root.querySelectorAll('[data-testid="node-inner-wrapper"]')[0];
    const body = root.querySelectorAll(`[data-testid="node-body-${n.id}"]`)[0];
    const dot = root.querySelectorAll(".slot-dot")[0];
    // What Tailwind 4 computes for a themed surface: an oklch/oklab string, which is
    // not a syntax a canvas parses. Assigning one is silently ignored — the previous
    // fillStyle stays — which is how one node's colour becomes another's.
    wrap.style.backgroundColor = "oklch(1 0 0)"; // white
    dot.style.backgroundColor = "oklab(0.6 0.1 -0.05)"; // a colour with real chroma
    body.style.backgroundColor = "lab(50% 40 -30)"; // a space this tool does not read
    h.tracker.lowZoom.set({ flatBelow: 0.5, snapshots: true });
    // The live box first, before any picture exists: it draws the node's own
    // structure live, so the translated colour has to be right there too.
    h.canvas.ctx.paintLog.length = 0;
    draw(h, 1);
    const liveFills = h.canvas.ctx.paintLog.filter((p) => p.op === "fill" || p.op === "fillRect").map((p) => p.fill);
    assert(liveFills.includes("rgba(255, 255, 255, 1)"), "the live box paints the translated colour");
    draw(h, 1);
    await idle(h);
    const pic = h.canvases.filter((c) => c._ctx && c._ctx.paintLog.some((p) => p.op === "fill" || p.op === "fillRect"))[0];
    assert(pic, "the node's structure was painted");
    const fills = pic._ctx.paintLog.filter((p) => p.op === "fill" || p.op === "fillRect").map((p) => p.fill);
    assert(fills.includes("rgba(255, 255, 255, 1)"), "the oklch surface is painted as the rgb the browser meant");
    // A grey round-trips trivially, so the conversion is pinned on colours that carry
    // chroma and a hue: reading them as grey, or dropping the chroma, has to fail here.
    assert(fills.includes("rgba(76, 184, 106, 1)"), "an oklch colour with chroma and a hue is converted, not read as grey");
    assert(fills.includes("rgba(168, 102, 156, 1)"), "and so is an oklab one");
    assert(!fills.some((f) => String(f).includes("lab(")), "no raw unparsable string is ever handed to the canvas");
    assertGreater(snapApi(h).vueColorMiss || 0, 0, "and the colour it could not read is counted");
    assert(
      (snapApi(h).vueColorSample || []).some((x) => String(x).includes("lab(")),
      "with a sample, so the readout can say which syntax was missed"
    );
    // …and the picture draws it the same way. (With the pictures *off* the node is
    // the box ladder the user chose, no content — that is the documented promise, not
    // a colour question.)
  });

  test("a node the frontend dims is pictured dimmed", async () => {
    const h = await boot();
    const { nodes, vue } = vueGraph(h, 2);
    const [a, b] = nodes;
    stripWidgets(nodes);
    const rootA = vue.rootFor(a);
    const S = 0.1;
    // `LGraphNode.vue` composites the whole node with `opacity: nodeOpacity` — the
    // `Comfy.Node.Opacity` setting, times 0.6 while the node is dragged and 0.5 while
    // it is muted or bypassed. The picture *replaces* the element, so a picture that
    // ignores it does not just look wrong: the dimming never happens at all.
    rootA.style.opacity = "0.5";
    const span = h.document.createElement("span");
    span.textContent = "steps 20";
    rootA.appendChild(span);
    span._rect = { left: rootA._rect.left + 12 * S, top: rootA._rect.top + (30 + 44) * S, width: 140 * S, height: 16 * S };
    h.tracker.lowZoom.set({ flatBelow: 0.5, snapshots: true });
    draw(h, 2);
    await idle(h);
    const dim = (c) => c._ctx.paintLog.filter((p) => p.alpha < 0.99);
    const pics = h.canvases.filter((c) => c._ctx && c._ctx.ops.some((o) => o[0] === "fillText"));
    const dimmed = pics.filter((c) => dim(c).length > 0);
    assertEqual(dimmed.length, 1, "exactly one picture was drawn at a reduced alpha");
    assertClose(dimmed[0]._ctx.paintLog.find((p) => p.alpha < 0.99).alpha, 0.5, 0.01, "the node's own opacity");
    assertEqual(snapApi(h).pictured, 2, "and both nodes are pictured");
    // And the opacity is part of what the picture is: changing it remakes it.
    const before = snapApi(h).captured;
    rootA.style.opacity = "1";
    // A node's opacity is not a change the page reports (the tool watches children
    // and boxes, deliberately not attributes — the frontend rewrites class and style
    // on hover, on selection and on every pane gesture), so it reaches the picture on
    // the insurance read. That read is the documented lag, and this is it.
    h.advance(6000);
    await h.flush();
    draw(h, 2);
    await idle(h);
    assertGreater(snapApi(h).captured - before, 0, "the picture is remade when the node stops being dimmed");
    const fresh = h.canvases.filter(
      (c) => c._ctx && c._ctx.ops.some((o) => o[0] === "fillText" && String(o[1]) === "steps 20" && c._ctx.paintLog.some((p) => p.alpha === 1))
    );
    assert(fresh.length > 0, "and the new picture is fully opaque");
    assertEqual(dim(fresh[fresh.length - 1]).length, 0, "nothing in it is drawn dimmed");
  });

  test("the readout describes pictures in this renderer when snapshots are on", async () => {
    const h = await boot();
    const { vue } = vueGraph(h, 1);
    void vue;
    h.tracker.lowZoom.set({ flatBelow: 0.5, snapshots: true });
    draw(h, 2);
    await idle(h);
    // The panel used to say "(no picture is taken in this renderer — the bitmap half
    // of the engine is idle)" while the same line reported pictures being served and
    // captured. The user read both at once. The report is the tool's own claim about
    // itself, so the claim is held to the setting.
    h.tracker.open();
    const copyBtn = h.document.body.descendants().find((n) => n._cls && n._cls.has("ants-hbtn") && n.textContent.includes("Copy"));
    assert(copyBtn, "the panel has a copy button");
    copyBtn.click();
    await h.flush();
    const report = h.clipboardWrites[h.clipboardWrites.length - 1] || "";
    assertIncludes(report, "node stand-ins are pictures", "the Vue paragraph says pictures are made");
    assert(!report.includes("no picture is taken in this renderer"), "and does not claim the opposite");
    // The other branch has to stay true as well: with the pictures off, that is
    // exactly what happens, and the sentence now says which setting turned it off.
    h.tracker.lowZoom.set({ snapshots: false });
    h.advance(500);
    await h.flush();
    copyBtn.click();
    await h.flush();
    const off = h.clipboardWrites[h.clipboardWrites.length - 1] || "";
    assertIncludes(off, "no picture is taken while the snapshots setting is off", "with the setting off it says so");
  });

  test("a tall node's own labels are read past the first sixteen", async () => {
    const h = await boot();
    const { nodes, vue } = vueGraph(h, 1);
    const n = nodes[0];
    stripWidgets(nodes);
    vue.addStructure(n, { title: "ANT's Advanced Scheduler Advanced", inputs: ["model"] });
    // Thirty rows of label + value: the shape of the node a user works in. The
    // reader used to stop at 16 text leaves and 32 chrome boxes, which is how a
    // node with real content came back as "flat rectangles with values missing".
    const S = 0.1;
    let leaves = 0;
    for (let i = 0; i < 30; i++) {
      const row = h.document.createElement("div");
      row.className = "widget-row";
      row.style.backgroundColor = "rgb(31, 37, 47)";
      const label = h.document.createElement("span");
      label.textContent = "label" + i;
      const value = h.document.createElement("span");
      value.textContent = String(i * 1.5);
      row.appendChild(label);
      row.appendChild(value);
      vue.addMedia(n, row, { x: 8, y: 60 + i * 26, w: 184, h: 22 });
      n.widgets.push({ name: "w" + i, element: row, node: n });
      const rr = vue.rootFor(n)._rect;
      label._rect = { left: rr.left + 6 * S, top: rr.top + (60 + i * 26 + 4) * S, width: 90 * S, height: 14 * S };
      value._rect = { left: rr.left + 100 * S, top: rr.top + (60 + i * 26 + 4) * S, width: 80 * S, height: 14 * S };
      leaves += 2;
    }
    h.tracker.lowZoom.set({ flatBelow: 0.5, snapshots: true });
    draw(h, 2);
    await idle(h);
    const api = snapApi(h);
    assertEqual(api.pictured, 1, "the node is a picture, not a box");
    assertEqual(api.vueText, leaves, "every text leaf the browser laid out is read");
    assertGreater(api.vueWidgetInk, 60, "every widget row is drawn");
    const pic = h.canvases.filter((c) => c._ctx && c._ctx.ops.some((o) => o[0] === "roundRect"))[0];
    assert(pic, "there is a picture");
    const drawn = pic._ctx.ops.filter((o) => o[0] === "fillText").length;
    assertEqual(drawn, leaves, "and every one of them is in the picture (the old cap was 16)");
  });

  test("a node that never stands still is photographed anyway, and never loses its picture", async () => {
    const h = await boot();
    const { nodes, vue } = vueGraph(h, 1);
    const n = nodes[0];
    stripWidgets(nodes);
    vue.addStructure(n, { title: "Scheduler", inputs: ["model"] });
    const S = 0.1;
    const rows = [];
    for (let i = 0; i < 3; i++) {
      const row = h.document.createElement("div");
      row.className = "widget-row";
      const value = h.document.createElement("span");
      value.textContent = "value " + i;
      row.appendChild(value);
      vue.addMedia(n, row, { x: 8, y: 60 + i * 26, w: 184, h: 22 });
      n.widgets.push({ name: "w" + i, element: row, node: n });
      const rr = vue.rootFor(n)._rect;
      value._rect = { left: rr.left + 14 * S, top: rr.top + (60 + i * 26 + 4) * S, width: 80 * S, height: 14 * S };
      rows.push(value);
    }
    h.tracker.lowZoom.set({ flatBelow: 0.5, snapshots: true });
    draw(h, 2);
    await idle(h);
    assertEqual(snapApi(h).pictured, 1, "pictured once");
    const before = snapApi(h).captured;
    const boxesBefore = snapApi(h).vueBoxes; // painting the node as a box, ever
    // A value rewritten every 200ms: shorter than the settle window, over and over.
    // The window is a grace period, not a veto — and the picture of the moment
    // before stays up while the replacement is made.
    for (let k = 1; k <= 8; k++) {
      rows[0].textContent = "value " + k;
      h.advance(200);
      h.canvas.ctx.ops.length = 0;
      draw(h, 1);
      assertEqual(snapApi(h).pictured, 1, "still the picture, never a box, at round " + k);
      assertEqual(snapApi(h).vueBoxes, boxesBefore, "and no box flash ever");
    }
    assertGreater(snapApi(h).captured - before, 0, "it was photographed despite never standing still");
    assertEqual(snapApi(h).churn, 0, "and the churn counter never fired: it is not a lost cause");
    assertEqual(snapApi(h).slow, 0, "nor was it judged too slow");
  });

  test("the steady state costs the page no DOM work at all", async () => {
    const h = await boot();
    const { nodes, vue } = vueGraph(h, 3); // the fixture's nodes keep their DOM widgets
    for (const n of nodes) {
      const span = h.document.createElement("span");
      span.textContent = "steps 20";
      span.style.fontSize = "12px";
      vue.rootFor(n).appendChild(span);
      span._rect = { left: vue.rootFor(n)._rect.left, top: vue.rootFor(n)._rect.top + 74 * 0.1, width: 60 * 0.1, height: 14 * 0.1 };
    }
    h.tracker.lowZoom.set({ flatBelow: 0.5, snapshots: true });
    for (let i = 0; i < 4; i++) draw(h, 1);
    await idle(h);
    await idle(h);
    assertEqual(snapApi(h).pictured, 3, "all three nodes have pictures (the steady state)");
    // One frame to absorb whatever the idle backstop left owing, then nothing about
    // the nodes changes again. Everything this tool does per frame is measurable
    // now, and in the steady state it has to be *nothing*: the mark is written once
    // on the transition (a repeated write is a DOM mutation the browser has to look
    // at, and with a stylesheet rule matching that attribute it can cost a style
    // pass — which the tool's own layout read then turns into a real layout), the
    // video verdict is remembered between probes, and the layout is not read while
    // the measurement is fresh.
    draw(h, 1);
    const before = { ...h.ops, attrWriteBy: { ...h.ops.attrWriteBy }, qsaBy: { ...h.ops.qsaBy } };
    const s0 = snapApi(h);
    const frames = 3; // well inside the probe's 100 ms window, so a per-frame probe shows up
    draw(h, frames);
    const after = { ...h.ops, attrWriteBy: { ...h.ops.attrWriteBy }, qsaBy: { ...h.ops.qsaBy } };
    assertEqual(
      (after.attrWriteBy["data-ants-vue-standin"] || 0) - (before.attrWriteBy["data-ants-vue-standin"] || 0),
      0,
      "the blanking mark is not re-written on any frame"
    );
    assertEqual(after.attrRewrites - before.attrRewrites, 0, "and nothing else is written with the value it already had");
    assertEqual(after.rects - before.rects, 0, "and the layout is not read while the measurement is fresh");
    assertEqual(
      after.qsa - before.qsa,
      0,
      "and the inside of a node's element is not searched again: a widget element already known to hold no video is remembered"
    );
    assertEqual(snapApi(h).vueProbes - s0.vueProbes, 0, "the video probe is not run per frame");
    const s1 = snapApi(h);
    assertEqual(s1.captured - s0.captured, 0, "nothing is re-captured");
    assertEqual(s1.drawn - s0.drawn, frames * 3, "and every frame draws the stored picture for every node");
    assertEqual(s1.vueBoxes - s0.vueBoxes, 0, "no box is painted while the picture is there");
    assertEqual(after.gcs - before.gcs, 0, "and no computed style is asked for");
  });

  test("the zoom a picture is measured in is the frontend's own, and it holds at any zoom", async () => {
    const h = await boot();
    const { nodes, vue } = vueGraph(h, 2);
    stripWidgets(nodes);
    const img = h.document.createElement("img");
    Object.assign(img, { naturalWidth: 256, naturalHeight: 256, complete: true, src: "shot.png", currentSrc: "shot.png" });
    vue.addMedia(nodes[0], img, { x: 10, y: 40, w: 180, h: 220 });
    const geometry = () => {
      const caps = h.canvases.filter((c) => c._ctx && c._ctx.ops.some((o) => o[0] === "drawImage" && o[1] === img));
      if (!caps.length) return null;
      caps.sort((a, b) => b.width - a.width); // the picture itself, not one of its mips
      const op = caps[0]._ctx.ops.find((o) => o[0] === "drawImage" && o[1] === img);
      return [Math.round(op[2]), Math.round(op[3]), Math.round(op[4]), Math.round(op[5])];
    };
    h.tracker.lowZoom.set({ flatBelow: 0.5, snapshots: true });
    draw(h, 1);
    await idle(h);
    const at10 = geometry();
    assert(at10, "the node's own image is in the picture at 10% zoom");
    assertEqual(at10.join(","), "10,40,180,220", "at the node-local geometry the layout gave it");
    assertEqual(snapApi(h).vueScaleFrom, "pane", "the zoom comes off the frontend's own transform pane");
    assertEqual(snapApi(h).vueScale, 0.1, "and it is the zoom the DOM is really laid out at");
    // Four times the zoom. The element is four times as large on the client and the
    // picture has to come out the same, because the zoom it divides by is the DOM's
    // own. The canvas scale is the one number this can never be: the capture
    // rewrites it to 1 to draw zoom-free while the element keeps the frontend's
    // transform, and a picture divided by the wrong zoom lands outside its own box.
    h.canvas.ds.scale = 0.4;
    vue.place();
    img.currentSrc = "shot2.png";
    img.src = "shot2.png"; // the node's content changed: the old picture is stale
    draw(h, 2);
    await idle(h);
    assertEqual(snapApi(h).vueScaleFrom, "pane", "still the pane's zoom");
    assertEqual(snapApi(h).vueScale, 0.4, "and it followed the zoom");
    const at40 = geometry();
    assert(at40, "the image is in the picture at 40% zoom too");
    assertEqual(at40.join(","), "10,40,180,220", "and it is drawn at the same geometry it had at 10%");
  });

  test("a canvas a node renders itself is drawn too, and an unloaded image is not", async () => {
    const h = await boot();
    const { nodes, vue } = vueGraph(h, 2);
    stripWidgets(nodes);
    const cv = h.document.createElement("canvas");
    cv.width = 300;
    cv.height = 200;
    vue.addMedia(nodes[0], cv, { x: 20, y: 30, w: 160, h: 120 }); // a 3D viewport's shape
    const pending = h.document.createElement("img");
    Object.assign(pending, { naturalWidth: 0, naturalHeight: 0, complete: false, src: "later.png", currentSrc: "later.png" });
    vue.addMedia(nodes[0], pending, { x: 20, y: 160, w: 160, h: 100 });
    h.tracker.lowZoom.set({ flatBelow: 0.5, snapshots: true });
    h.canvas.ctx.ops.length = 0;
    draw(h, 1);
    assertEqual(h.canvas.ctx.ops.filter((o) => o[0] === "drawImage" && o[1] === cv).length, 1, "a canvas the node renders itself is drawn");
    assertEqual(h.canvas.ctx.ops.filter((o) => o[0] === "drawImage" && o[1] === pending).length, 0, "an image that has not arrived is not");
    assertEqual(h.tracker.lowZoom.snapshots.vueMedia, 1, "one media item drawn");
    // The node's box clips its content: nothing spills out of a node.
    assert(h.canvas.ctx.ops.some((o) => o[0] === "clip"), "the content is clipped to the node's box");
  });

  test("an element both routes can see is drawn exactly once", async () => {
    const h = await boot();
    const { nodes, vue } = vueGraph(h, 2);
    stripWidgets(nodes);
    // One image that is both the widget's own element and a child of the node's
    // DOM — the two routes overlap on it. The widget route knows its row; the
    // media pass knows its layout; drawing both would put it in twice.
    const img = h.document.createElement("img");
    Object.assign(img, { naturalWidth: 64, naturalHeight: 64, complete: true, src: "a.png", currentSrc: "a.png" });
    vue.addMedia(nodes[0], img, { x: 10, y: 30, w: 180, h: 40 });
    nodes[0].widgets.push({ name: "preview", element: img, y: 20, computedHeight: 60, margin: 10, node: nodes[0] });
    h.tracker.lowZoom.set({ flatBelow: 0.5, snapshots: true });
    h.canvas.ctx.ops.length = 0;
    draw(h, 1);
    assertEqual(h.canvas.ctx.ops.filter((o) => o[0] === "drawImage" && o[1] === img).length, 1, "the image is drawn exactly once");
  });

  test("a node whose element cannot be reached keeps its own drawing", async () => {
    const h = await boot();
    const { nodes, vue } = vueGraph(h, 2);
    h.tracker.lowZoom.set({ flatBelow: 0.5, snapshots: true });
    // A node that arrived after the frontend built its element list: there is no
    // [data-node-id] for it, so there is nothing to blank — and a box is only
    // painted for an element that really stopped drawing. Two pictures of the
    // same node is the one outcome worse than no stand-in.
    const late = h.node({ type: "KSampler", pos: [500, 0], size: [200, 100], widgets: [] });
    late.id = 77;
    h.canvas.nodes.push(late);
    h.app.graph._nodes.push(late);
    draw(h, 1);
    const api = snapApi(h);
    assertEqual(api.vueBlanked, 2, "the two reachable nodes are blanked");
    assertEqual(api.vueBoxes, 2, "and exactly their boxes are painted");
    assert(!vue.rootFor(nodes[0]).classList.contains("ants-lod-box"), "blanking still is not hiding");
  });

  test("turning the setting or the master switch off hands every element back", async () => {
    const h = await boot();
    const { nodes, vue } = vueGraph(h, 3);
    h.tracker.lowZoom.set({ flatBelow: 0.5, snapshots: true });
    draw(h, 2);
    assert(vue.rootFor(nodes[0]).hasAttribute("data-ants-vue-standin"), "blanked");
    h.tracker.lowZoom.set({ snapshots: false });
    for (const n of nodes) assert(!vue.rootFor(n).hasAttribute("data-ants-vue-standin"), "switching the stand-in off hands the elements back at once, not on the next frame");
    h.tracker.lowZoom.set({ snapshots: true });
    draw(h, 2);
    assert(vue.rootFor(nodes[0]).hasAttribute("data-ants-vue-standin"), "blanked again");
    h.tracker.lowZoom.setEnabled(false);
    for (const n of nodes) assert(!vue.rootFor(n).hasAttribute("data-ants-vue-standin"), "and the master switch hands them back too");
    assertGreater(h.tracker.lowZoom.snapshots.vueRestored, 0, "the hand-backs are counted");
  });

  // Why this test is the one that matters for what a user feels: in this renderer
  // the node *is* DOM, so a stand-in has to take the frontend's own painting away
  // to be worth anything. `opacity: 0` does not (Blink/WebKit keep the subtree in
  // the render tree), which is how the tool could cost performance here while
  // saving it in the legacy renderer. `visibility: hidden` on the children is what
  // an engine skips in the paint phase — and taking the paint away must not take
  // the *layout* away, because every number the stand-in is made of comes from it.
  test("the stand-in takes the live DOM out of the paint and leaves it in the layout", async () => {
    const h = await boot();
    const { nodes, vue } = vueGraph(h, 2);
    const struct = vue.addStructure(nodes[0], { title: "KSampler", inputs: ["model"] });
    h.tracker.lowZoom.set({ flatBelow: 0.5, snapshots: true, diskOn: false });
    draw(h, 2);
    await idle(h);
    const api = snapApi(h);
    assertEqual(api.pictured, 2, "both nodes have their picture");
    assertEqual(api.vuePaintSkipped, api.vueBlanked, "the readout counts the subtrees the browser is told not to paint");
    assertEqual(api.vuePaintSkipped, 2, "which is every node drawn as a stand-in");
    const css = (h.document.querySelectorAll("style") || []).map((el) => String(el.textContent || "")).join("\n");
    assert(css.includes("[data-ants-vue-standin] > *"), "the stylesheet targets the node's children");
    assert(css.includes("visibility: hidden !important"), "with the one property a paint phase actually honours");
    // And the node's own box stays visible: without it the node would stop being
    // hit-testable, and selecting or dragging a node at that zoom would stop
    // working — a stand-in may replace the pixels, not the node.
    assert(!/\[data-ants-vue-standin\]\s*\{[^}]*visibility/.test(css), "the node's own box is not hidden, only its contents");
    // One exception has to survive, and it is a functional one: a link drag starts
    // on the slot dot (`SlotConnectionDot.vue` carries the pointerdown), so the dot
    // is re-shown inside the hidden subtree — a few pixels that the picture draws
    // anyway, kept alive so linking a stand-in still works.
    assert(
      /\[data-ants-vue-standin\] \.slot-dot\s*\{[^}]*visibility: visible/.test(css),
      "and the slot dots — the one pointer target a link drag needs — stay live"
    );
    assertEqual(struct.surface.parentNode, vue.rootFor(nodes[0]), "the node's own structure is still in the DOM");
    const stale0 = api.vueStale;
    vue.growRoot(nodes[0], 232); // the frontend reserves room inside the node
    assertGreater(snapApi(h).vueStale, stale0, "and a box that changes is still reported: what was taken away is the paint, not the layout");
  });

  // The picture has to carry the node, and a node in this renderer is its frame,
  // its header bar, its body panel and its slot dots as much as it is its text and
  // its media. A picture of the content alone is the "semi — not fully there" a
  // user reported twice: the node's own surface was never drawn, so the stand-in
  // could only ever look like a sketch floating on the canvas.
  test("the picture carries the node's own structure, not only its content", async () => {
    const h = await boot();
    const { nodes, vue } = vueGraph(h, 1);
    const n = nodes[0];
    const struct = vue.addStructure(n, { title: "KSampler", inputs: ["model"] });
    h.tracker.lowZoom.set({ flatBelow: 0.5, snapshots: true, diskOn: false });
    // Before a picture exists the box draws the structure live, from the same ink
    // function: the node's frame is the element's own box, one title bar above the
    // node's origin, rounded the way the browser rounded it.
    const before = fills(h).length;
    draw(h, 1);
    assertGreater(fills(h).length, before, "the live box paints the node's structure, not only its text");
    const live = h.canvas.ctx.ops.filter((o) => o[0] === "roundRect");
    assert(
      live.some((o) => o[1] === 0 && o[2] === -30 && o[3] === 200 && o[4] === 130),
      "the frame is drawn where the browser laid the element out"
    );
    // And the picture is a freeze of exactly that.
    await idle(h);
    const api = snapApi(h);
    assertEqual(api.captured, 1, "the node is photographed");
    assertEqual(api.vueChromeBoxes, 4, "the frame, the body panel, the header bar and the slot dot are read out of the DOM");
    assertGreater(api.vueChrome, 0, "and drawn into the picture in the colours the browser computed for them");
    const pics = h.canvases.filter((c) => c._ctx && c._ctx.ops.some((o) => o[0] === "roundRect" && o[2] === -30));
    assertEqual(pics.length, 1, "the picture has the node's frame in it");
    assert(
      pics[0]._ctx.ops.some((o) => o[0] === "arc"),
      "and the slot dots are circles at the position the renderer put them, not invented geometry"
    );
    // A slot turning up later changes the node's *structure* and nothing else — the
    // same text, the same box — and the picture has to follow it, or the stand-in
    // keeps a node that no longer exists. This is the half of the signature that
    // carries the structure.
    const captured = api.captured;
    struct.addDot(3);
    draw(h, 1);
    h.advance(600);
    await h.flush();
    assertGreater(snapApi(h).invalidated, 0, "a new slot drops the picture: the node is not the node that was photographed");
    assertGreater(snapApi(h).captured, captured, "and the new picture carries it");
  });

  // A node's widgets are DOM elements in this renderer, and a stand-in hides the
  // node's DOM while it stands in for it — so the row has to be *in the picture*:
  // the box the browser laid out, its own colour, its border and its radius. A node
  // whose widgets are a hole in its picture is not a stand-in, it is a broken node.
  test("a widget's own row is in the picture, not a hole where the widget was", async () => {
    const h = await boot();
    const { nodes, vue } = vueGraph(h, 1);
    const n = nodes[0];
    stripWidgets(nodes);
    const row = h.document.createElement("div");
    row.className = "widget-row";
    row.style.backgroundColor = "rgb(31, 37, 47)";
    row.style.borderTopWidth = "1px";
    row.style.borderTopColor = "rgb(91, 97, 117)";
    row.style.borderTopLeftRadius = "4px";
    vue.addMedia(n, row, { x: 12, y: 44, w: 176, h: 22 });
    n.widgets.push({ name: "steps", type: "number", element: row, node: n });
    h.tracker.lowZoom.set({ flatBelow: 0.5, snapshots: true, diskOn: false });
    draw(h, 1);
    const live = h.canvas.ctx.ops.filter((o) => o[0] === "roundRect");
    const near = (a, b) => Math.abs(Number(a) - b) < 0.01;
    assert(
      live.some((o) => near(o[1], 12) && near(o[2], 44) && near(o[3], 176) && near(o[4], 22) && near(o[5], 4)),
      "the live box draws the widget's own row, at its measured box, with the browser's radius"
    );
    await idle(h);
    assertEqual(snapApi(h).captured, 1, "the node is photographed");
    assertGreater(snapApi(h).vueWidgetInk, 0, "and the lane counts the row as part of the picture");
    const pics = h.canvases.filter((c) => c._ctx && c._ctx.ops.some((o) => o[0] === "roundRect" && near(o[2], 44) && near(o[3], 176)));
    assertEqual(pics.length, 1, "the picture carries the widget's row, not an empty panel");
  });

  // A node is mounted and then *filled*: the frontend writes its parts over the
  // frames after that, and an image arrives when it arrives. A capture taken at the
  // first opportunity is a picture of a node that is still being built — the
  // "photographed too early" a user reported, twice. The window is the grace
  // period that answer asks for.
  test("a node is photographed only after it has stood still", async () => {
    const h = await boot();
    const { nodes, vue } = vueGraph(h, 1);
    h.tracker.lowZoom.set({ flatBelow: 0.5, snapshots: true, diskOn: false });
    draw(h, 1); // the frame that draws the node as a stand-in, and opens its window
    assertGreater(snapApi(h).vueSettleArms, 0, "the node's settle window opened when it was first drawn as a stand-in");
    assertEqual(snapApi(h).vueSettleMs, 300, "and it is the window the readout says it is");
    h.advance(120);
    await h.flush();
    assertEqual(snapApi(h).captured, 0, "nothing is photographed inside the window");
    assertGreater(snapApi(h).vueSettleHeld, 0, "and the capture lane says it waited rather than being idle");
    h.advance(600);
    await h.flush();
    assertEqual(snapApi(h).captured, 1, "the picture is taken once the node has stood still");
    assertGreater(vue.rootFor(nodes[0]).hasAttribute("data-ants-vue-standin"), 0, "and the node has been a stand-in the whole time");
  });

  // The other half of the same rule: a node that changes does not get photographed
  // where it stands — the window re-opens, and the picture that no longer matches
  // is replaced by one taken after the node has settled again.
  test("a change re-opens the settle window before the picture is replaced", async () => {
    const h = await boot();
    const { nodes, vue } = vueGraph(h, 1);
    const n = nodes[0];
    h.tracker.lowZoom.set({ flatBelow: 0.5, snapshots: true, diskOn: false });
    draw(h, 1);
    h.advance(600);
    await h.flush();
    assertEqual(snapApi(h).captured, 1, "the node is pictured once it has stood still");
    const armed = snapApi(h).vueSettleArms;
    // The node changes: an image arrives inside it, which is what "still rendering"
    // looks like from here.
    const img = h.document.createElement("img");
    Object.assign(img, { naturalWidth: 64, naturalHeight: 64, complete: true, src: "late.png" });
    vue.addMedia(n, img, { x: 10, y: 40, w: 60, h: 60 });
    draw(h, 1);
    h.advance(150); // past the signature's own 100 ms window
    await h.flush();
    draw(h, 1); // this frame compares the signature and drops the picture
    const mid = snapApi(h);
    assertGreater(mid.invalidated, 0, "the picture that no longer matches the node is dropped");
    assertGreater(mid.vueSettleArms, armed, "the change re-opened the settle window");
    assertEqual(mid.captured, 1, "and no replacement is taken inside it");
    h.advance(600);
    await h.flush();
    assertGreater(snapApi(h).captured, 1, "a fresh picture is taken once the node has stood still again");
  });

});

// The picture store on disk. One file per node id, named by the node's signature
// *plus* the two things a file outlives that the in-RAM signature leaves out: the
// capture ratio the pixels were drawn at, and the theme they were drawn in. These
// tests play the thumb store's part (the route code is in __init__.py and is
// tested by tests/test_init.py) so the frontend's half of the contract is pinned:
// what it asks for, what it writes, and what it refuses to be served.
suite("drawing: the stand-in cache on disk — keyed by what is inside the file", () => {
  const draw = (h, n = 1) => {
    for (let i = 0; i < n; i++) {
      h.advance(FRAME_MS);
      h.canvas.setDirty(true, true);
      h.canvas.draw();
    }
  };
  const idle = async (h, ms = 1000) => {
    h.advance(ms);
    await h.flush();
    h.advance(ms);
    await h.flush();
  };
  const snapApi = (h) => h.tracker.lowZoom.snapshots;

  // A stand-in for the server's half: one file per node id, replaced on write,
  // served only for the exact key it was written under.
  function fakeDisk(h) {
    const files = new Map(); // id -> { sig, blob }
    h.fetchRoutes.set("/ants_optimizer/thumbs/sweep", { removed: 0 });
    h.fetchRoutes.set("/ants_optimizer/thumbs/info", { dir: "/tmp", count: 0 });
    h.fetchRoutes.set("/ants_optimizer/thumbs/*", (req) => {
      const m = /\/thumbs\/([^/?]+)(?:\?sig=(.*))?$/.exec(req.url);
      if (!m) return { ok: false, status: 404, json: async () => ({}), blob: async () => null };
      const id = decodeURIComponent(m[1]);
      const sig = m[2] ? decodeURIComponent(m[2]) : "";
      if (req.method === "PUT") {
        files.set(id, { sig, blob: req.body });
        return { ok: true, status: 204, json: async () => ({}) };
      }
      if (req.method === "DELETE") {
        files.delete(id);
        return { ok: true, status: 200, json: async () => ({ removed: 1 }) };
      }
      const f = files.get(id);
      if (!f || f.sig !== sig) return { ok: false, status: 404, json: async () => ({}), blob: async () => null };
      return { ok: true, status: 200, json: async () => ({}), blob: async () => f.blob };
    });
    return files;
  }
  const asksFor = (h) => h.fetchUrls().filter((c) => c.method === "GET" && c.url.includes("/ants_optimizer/thumbs/"));
  const putsFor = (h) => h.fetchUrls().filter((c) => c.method === "PUT" && c.url.includes("/ants_optimizer/thumbs/"));
  const sigOf = (url) => {
    const raw = /sig=([^&]*)/.exec(url);
    return raw ? decodeURIComponent(raw[1]) : "";
  };
  const oneNode = (h) => {
    h.canvas.ds.scale = 0.1;
    h.canvas.links = [];
    const n = h.node({ type: "SnapThing", pos: [0, 0], size: [200, 100], widgets: [] });
    n.id = 3; // the disk file is named after it, so a node without one has no file
    h.canvas.nodes = [n];
    h.app.graph._nodes = [n];
    return n;
  };

  test("a ratio below 1 is drawn at that ratio, not at 1x with a smaller name", async () => {
    const h = await boot();
    const n = oneNode(h);
    h.tracker.lowZoom.set({ flatBelow: 0.5, snapshots: true, diskOn: false, snapRatio: 0.25 });
    draw(h, 1);
    await idle(h);
    const api = snapApi(h);
    assertEqual(api.captured, 1, "the node was captured");
    // The capture surface: geometry is 200x100 plus padding, so a quarter-size
    // picture is a quarter of the pixels. At 1x it was 248x192 whatever the name
    // said, which is sixteen times the memory the budget had been told to keep.
    const cap = h.canvases.find((c) => c._ctx && c.width > 0 && c.width < 100);
    assert(cap, "the picture was drawn on a canvas smaller than the node");
    assertLess(cap.width, 100, `a 248-unit-wide row at 0.25x is about 62px, not ${cap.width}px`);
    assertLess(api.bytes, 100 * 100 * 4 * 2, "and the budget is charged what was actually allocated");
    assertEqual(n.imgs, undefined, "the node itself is unchanged");
  });

  test("the file is written under the ratio and the theme it was drawn with", async () => {
    const h = await boot();
    fakeDisk(h);
    oneNode(h);
    h.tracker.lowZoom.set({ flatBelow: 0.5, snapshots: true, diskOn: true, snapRatio: 1 });
    draw(h, 1);
    await idle(h);
    const puts = putsFor(h);
    assertGreater(puts.length, 0, "the picture was written to disk");
    const sig = sigOf(puts[0].url);
    assert(/r1t[0-9a-z]+pc$/.test(sig), `the key carries the ratio, the theme and the pathway: ${sig}`);
    // A theme change makes every stored picture a lie, and the key has to say so
    // or the next page load is served pictures drawn in the old theme.
    const before = sigOf(asksFor(h)[0].url);
    h.LiteGraph.NODE_TITLE_COLOR = "#ff0000";
    h.advance(3000);
    await h.flush();
    h.tracker.lowZoom.set({ snapRatio: 1 }); // re-arm the queue without changing anything else
    draw(h, 1);
    await idle(h);
    const after = sigOf(asksFor(h)[asksFor(h).length - 1].url);
    assert(before !== after, "a theme change re-keys the pictures");
  });

  test("a picture drawn in one renderer is never served to the other", async () => {
    const h = await boot();
    const files = fakeDisk(h);
    const n = oneNode(h);
    h.tracker.lowZoom.set({ flatBelow: 0.5, snapshots: true, diskOn: true, snapRatio: 1 });
    draw(h, 1);
    await idle(h);
    assertEqual(snapApi(h).captured, 1, "the canvas renderer photographed the node");
    const first = files.get(String(n.id));
    assert(first && /pc$/.test(first.sig), `the file says which renderer drew it (${first && first.sig})`);
    // The user switches to Nodes 2.0 with the same node in the same graph. The file
    // on disk is a photograph of the canvas; in that renderer a picture is this
    // tool's drawing of the node's DOM. They are different pictures, and a store
    // that cannot tell them apart serves one renderer's node to the other — which
    // is what a user sees as "cached boxes, no proper stand-ins".
    const vue = h.enterVueNodes();
    n.pos = [10, 10];
    vue.place();
    h.canvas.ctx.ops.length = 0;
    draw(h, 2);
    await idle(h);
    const api = snapApi(h);
    assertEqual(api.pathway, "vue", "the pathway switched with the renderer");
    assertEqual(api.captured, 2, "and the node was pictured again in this renderer");
    assertEqual(api.diskLoaded, 0, "the other renderer's file was never served as this renderer's picture");
    const puts = putsFor(h);
    assertGreater(puts.length, 1, "both pictures were written");
    assert(puts.every((p) => /(pc|pv)$/.test(sigOf(p.url))), "each under a key that names the pathway that drew it");
    assert(/pv$/.test(sigOf(puts[puts.length - 1].url)), "the new one is the Vue-nodes picture");
    // And back the other way, which is the direction a canvas-workspace user hit:
    // the Vue-nodes picture must not be served as a photograph of the canvas.
    vue.exit();
    n.pos = [20, 20];
    h.canvas.ctx.ops.length = 0;
    draw(h, 2);
    await idle(h);
    const api2 = snapApi(h);
    assertEqual(api2.pathway, "canvas", "the pathway followed the renderer back");
    assertEqual(api2.captured, 3, "and the node was photographed again");
    assertEqual(api2.diskLoaded, 0, "the picture drawn from the DOM was never served as the canvas's own");
    const back = putsFor(h);
    assert(/pc$/.test(sigOf(back[back.length - 1].url)), "the newest file is the canvas photograph");
  });

  test("changing the capture resolution re-asks in both directions, and a matching file is served", async () => {
    const h = await boot();
    const files = fakeDisk(h);
    const n = oneNode(h);
    const askedWith = (tag) => asksFor(h).filter((c) => sigOf(c.url).includes(tag));
    h.tracker.lowZoom.set({ flatBelow: 0.5, snapshots: true, diskOn: true, snapRatio: 1 });
    draw(h, 1);
    await idle(h);
    assertGreater(askedWith("r1t").length, 0, "the first load asked for a 1x picture");
    const first = files.get(String(n.id));
    assert(first && /r1t/.test(first.sig), `and one was written under a 1x key (${first && first.sig})`);
    assertEqual(snapApi(h).diskLoaded, 0, "nothing was on disk to load the first time");

    // Down: 0.25x. The stored 1x file is not what the setting asked for, so it
    // must not be served — a new key is asked for, misses, and is captured.
    h.tracker.lowZoom.set({ snapRatio: 0.25 });
    draw(h, 1);
    await idle(h);
    assertGreater(askedWith("r0.25t").length, 0, "the page asked the disk again after the ratio changed");
    assertEqual(snapApi(h).diskLoaded, 0, "and the 1x file was not accepted for it");
    const quarter = files.get(String(n.id));
    assert(quarter && /r0\.25t/.test(quarter.sig), `the file was replaced with the 0.25x picture (${quarter && quarter.sig})`);

    // Back up: 1x. The 0.25x file cannot satisfy it either, so this is a fresh
    // capture and the file ends up matching the setting again.
    const captured = snapApi(h).captured;
    h.tracker.lowZoom.set({ snapRatio: 1 });
    draw(h, 1);
    await idle(h);
    assertGreater(snapApi(h).captured, captured, "back at 1x, the quarter-size picture did not satisfy it: a capture was made");
    const back = files.get(String(n.id));
    assert(back && /r1t/.test(back.sig), `and the file is a 1x picture again (${back && back.sig})`);
  });

  test("a file for another ratio is a miss, and a file for this one is loaded and used", async () => {
    const h = await boot();
    const files = fakeDisk(h);
    const n = oneNode(h);
    // What a previous session left behind, at the *other* ratio.
    files.set(String(n.id), { sig: "stale-key-r3tzzz", blob: { type: "image/png", width: 744, height: 576 } });
    h.tracker.lowZoom.set({ flatBelow: 0.5, snapshots: true, diskOn: true, snapRatio: 1 });
    draw(h, 1);
    await idle(h);
    assertEqual(snapApi(h).diskLoaded, 0, "the 3x file was refused for a 1x page");
    assertGreater(snapApi(h).captured, 0, "so the node was photographed instead");
    assertGreater(putsFor(h).length, 0, "and the page wrote its own file");

    // Now the same page again, with the file this setting asked for in place.
    const sig = files.get(String(n.id)).sig;
    assert(/r1t/.test(sig), "the 1x file is what was written");
    const h2 = await boot({ storage: h.localStorage });
    const files2 = fakeDisk(h2);
    const n2 = oneNode(h2);
    files2.set(String(n2.id), files.get(String(n.id)));
    h2.tracker.lowZoom.set({ flatBelow: 0.5, snapshots: true, diskOn: true, snapRatio: 1 });
    draw(h2, 1);
    await h2.flush();
    assertEqual(snapApi(h2).diskLoaded, 1, "the matching file was loaded");
    assertEqual(snapApi(h2).captured, 0, "and nothing had to be captured");
    h2.canvas.ctx.ops.length = 0;
    draw(h2, 1);
    assert(
      h2.canvas.ctx.ops.filter((o) => o[0] === "drawImage").length > 0,
      "the node is drawn from the loaded picture"
    );
  });

  test("a picture the budget forced coarser than the setting is not written to disk", async () => {
    const h = await boot();
    fakeDisk(h);
    h.canvas.ds.scale = 0.1;
    h.canvas.links = [];
    const nodes = [];
    for (let i = 0; i < 25; i++) {
      const n = h.node({ type: "SnapThing", pos: [i * 700, 0], size: [600, 400], widgets: [] });
      n.id = 100 + i;
      nodes.push(n);
    }
    h.canvas.nodes = nodes;
    h.app.graph._nodes = nodes;
    // 3x on 600x400 nodes fills the floor; what fits is kept, and what does not is
    // taken coarser (1x) rather than skipped.
    h.tracker.lowZoom.set({ flatBelow: 0.2, snapshots: true, diskOn: true, snapRatio: 3, snapMb: 256 });
    draw(h, 1);
    await idle(h, 8000);
    const api = snapApi(h);
    assertGreater(api.coarse, 0, "at least one picture was taken coarser than the setting");
    const putKeys = putsFor(h).map((c) => sigOf(c.url));
    assert(putKeys.length > 0, "the ones at the setting's ratio were written");
    assert(
      putKeys.every((k) => /r3t/.test(k)),
      `and every file says 3x, because a coarser picture must not sit under the 3x name (${putKeys.join(", ")})`
    );
  });
});

// A stand-in picture is the node as the canvas would have drawn it *plus* what
// the browser draws over the canvas: a prompt textarea, an image preview, a 3D
// viewport. The canvas row under a DOM widget is blank (the frontend paints a
// placeholder only in its own low-quality mode), so without this the picture of a
// text or image node was the node's chrome and nothing else.
suite("drawing: what a stand-in picture contains", () => {
  const draw = (h, n = 1) => {
    for (let i = 0; i < n; i++) {
      h.advance(FRAME_MS);
      h.canvas.setDirty(true, true);
      h.canvas.draw();
    }
  };
  const idle = async (h, ms = 1000) => {
    h.advance(ms);
    await h.flush();
    h.advance(ms);
    await h.flush();
  };
  const snapApi = (h) => h.tracker.lowZoom.snapshots;
  const boxes = (h) => h.canvas.ctx.ops.filter((o) => o[0] === "fillRect" && Number(o[3]) === 200);
  const capturesWith = (h, test) => h.canvases.filter((c) => c._ctx && c._ctx.ops.some(test));

  function gateBooter() {
    return { flatBelow: 0.5, snapshots: true, diskOn: false };
  }
  function domNode(h, type, size = [200, 100]) {
    h.canvas.ds.scale = 0.1;
    h.canvas.links = [];
    const n = h.node({ type, pos: [0, 0], size, widgets: [] });
    n.id = 11;
    h.canvas.nodes = [n];
    h.app.graph._nodes = [n];
    return n;
  }

  test("an image preview in the node's DOM is drawn into the picture, at the widget's row", async () => {
    const h = await boot();
    const n = domNode(h, "LoadImage");
    const img = h.document.createElement("img");
    Object.assign(img, { naturalWidth: 64, naturalHeight: 64, complete: true, src: "a.png", currentSrc: "a.png" });
    n.addDOMWidget("image", "image", img, { hideOnZoom: false, y: 20, computedHeight: 60 });
    h.tracker.lowZoom.set(gateBooter());
    draw(h, 1);
    await idle(h);
    assertEqual(snapApi(h).captured, 1, "the node was captured");
    const pics = capturesWith(h, (o) => o[0] === "drawImage" && o[1] === img);
    assertEqual(pics.length, 1, "the preview image is in the picture");
    const op = pics[0]._ctx.ops.find((o) => o[0] === "drawImage" && o[1] === img);
    // The row DomWidgets.vue positions it on: margin 10, widget.y 20, height 60.
    assertEqual(op[2], 10, "x is the widget margin");
    assertEqual(op[3], 30, "y is the margin plus the widget's own row");
    assertEqual(op[4], 180, "and the width is the node's, minus the margin twice");
    assertEqual(op[5], 40, "with the height the widget reports, minus the margin twice");
    assertGreater(snapApi(h).domInk, 0, "and the readout counts it as DOM content drawn in");
    assertEqual(snapApi(h).domText, 0, "nothing here was re-painted text");
  });

  test("a text widget's value is painted into the picture, and editing it makes a new one", async () => {
    const h = await boot();
    const n = domNode(h, "CLIPTextEncode");
    const ta = h.document.createElement("textarea");
    ta.value = "a photo of a cat";
    n.addDOMWidget("text", "text", ta, { hideOnZoom: true, computedHeight: 80 });
    h.tracker.lowZoom.set(gateBooter());
    draw(h, 1);
    await idle(h);
    assertEqual(snapApi(h).captured, 1, "the node was captured");
    const first = capturesWith(h, (o) => o[0] === "fillText" && String(o[1]).includes("cat"));
    assertEqual(first.length, 1, "the text the widget holds is in the picture");
    assertGreater(snapApi(h).domText, 0, "and the readout says it was re-painted, not screenshotted");

    // The text changes: the signature carries the element's value, so the picture
    // is dropped on the next drawn frame and a new one is taken. This is the
    // "regenerate the stand-in when the node changes" the user asked for, for the
    // case the node's own fields do not cover.
    ta.value = "a photo of a dog";
    h.advance(200); // past the signature's 100ms window
    draw(h, 1);
    await idle(h);
    assertGreater(snapApi(h).invalidated, 0, "the old picture was dropped");
    assertEqual(
      capturesWith(h, (o) => o[0] === "fillText" && String(o[1]).includes("dog")).length,
      1,
      "and the new picture has the new text in it"
    );
  });

  test("an image that has not loaded yet is left out, and drawn in when it arrives", async () => {
    const h = await boot();
    const n = domNode(h, "LoadImage");
    const img = h.document.createElement("img");
    Object.assign(img, { naturalWidth: 0, naturalHeight: 0, complete: false, src: "b.png" });
    n.addDOMWidget("image", "image", img, { hideOnZoom: false });
    h.tracker.lowZoom.set(gateBooter());
    draw(h, 1);
    await idle(h);
    assertEqual(snapApi(h).captured, 1, "the node is pictured even before its image arrives");
    assertEqual(capturesWith(h, (o) => o[0] === "drawImage" && o[1] === img).length, 0, "with a blank where the image will be");
    assertGreater(snapApi(h).domSkipped, 0, "and the readout counts the content it could not draw");

    // `complete` is part of the signature: the picture is re-made when it lands.
    Object.assign(img, { naturalWidth: 64, naturalHeight: 64, complete: true });
    h.advance(200);
    draw(h, 1);
    await idle(h);
    assertEqual(capturesWith(h, (o) => o[0] === "drawImage" && o[1] === img).length, 1, "the image is drawn in once it is there");
  });

  test("a node playing a video is never photographed, however idle it is", async () => {
    const h = await boot();
    const n = domNode(h, "LoadVideo");
    const video = h.document.createElement("video");
    video.src = "clip.mp4";
    n.addDOMWidget("video", "video", video, { hideOnZoom: false });
    h.tracker.lowZoom.set(gateBooter());
    draw(h, 2);
    await idle(h);
    assertEqual(snapApi(h).captured, 0, "no picture was taken of a video");
    assertEqual(snapApi(h).held, 0, "and none is held");
    assertGreater(boxes(h).length, 0, "the node keeps its box instead");
  });

  test("a widget whose content cannot be drawn is left blank and counted, not invented", async () => {
    const h = await boot();
    const n = domNode(h, "SomeCustomNode");
    const div = h.document.createElement("div");
    div.textContent = "fancy HTML widget";
    n.addDOMWidget("custom", "dom", div, { hideOnZoom: false });
    h.tracker.lowZoom.set(gateBooter());
    draw(h, 1);
    await idle(h);
    assertEqual(snapApi(h).captured, 1, "the node is still pictured");
    assertEqual(snapApi(h).domInk, 0, "with nothing invented for the HTML widget");
    assertGreater(snapApi(h).domSkipped, 0, "and it is counted as content that could not be drawn");
  });
});
