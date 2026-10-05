// Core behaviour tests: instrumentation, attribution math, mute, the redraw
// cap, windowing and the regression cases that motivated the rewrite.
// Every one of these corresponds to something the v1 code got wrong.

import { createHarness, FRAME_MS } from "./harness.mjs";
import { suite, test, assert, assertEqual, assertClose, assertGreater, assertLess, assertIncludes } from "./framework.mjs";

const EXT_NAME = "ANTs.NastyBastardsTracker.Core";

// Fresh harness with the tracker's own setup() already run.
async function boot() {
  const h = createHarness();
  for (const ext of h.app.extensions) if (ext.setup) await ext.setup();
  await h.flush();
  return h;
}

// Drive the canvas the way ComfyUI's rAF loop does: a redraw every `intervalMs`
// while the tracker's clock advances. Returns the number of draws issued.
function drawLoop(h, seconds, intervalMs = FRAME_MS, opts = {}) {
  const steps = Math.max(1, Math.round((seconds * 1000) / intervalMs));
  let issued = 0;
  for (let i = 0; i < steps; i++) {
    h.advance(intervalMs);
    if (opts.dirty !== false && h.canvas.setDirty) h.canvas.setDirty(true, true);
    h.canvas.draw();
    issued++;
  }
  return issued;
}

function hookRow(snapshot, label) {
  return snapshot.hooks.find((r) => r.label === label);
}

suite("instrumentation", () => {
  test("wraps beforeRegisterNodeDef draw hooks and times them", async () => {
    const h = await boot();
    let calls = 0;
    await h.registerExtension("MyPack", {
      beforeRegisterNodeDef(nodeType) {
        nodeType.prototype.onDrawForeground = function () {
          calls++;
          h.busy(0.5);
        };
      },
    });
    const NodeType = h.registerNodeType("MyNode");
    const node = h.makeNode(NodeType);
    h.canvas.nodes = [node];

    drawLoop(h, 1);
    const snap = h.tracker.snapshot;
    const row = hookRow(snap, "MyPack");
    assert(row, "MyPack row should exist");
    assertGreater(calls, 30, "hook should have been called ~60 times");
    assertGreater(row.msPerFrame, 0.3, "should report ~0.5ms/frame of hook cost");
    assertLess(row.msPerFrame, 0.8, "should not over-report");
    assertGreater(row.callsPerFrame, 0.8, "one call per frame");
    assertClose(row.msPerCall, 0.5, 0.0001, "ms/call must be the simulated cost exactly");
    assertEqual(row.kind, "ext");
  });

  test("adopts hooks that existed before the tracker loaded (pre-existing prototype)", async () => {
    const h = await boot();
    // A pack that registered its node type without ever going through
    // registerExtension's beforeRegisterNodeDef (or before this tool loaded).
    function LegacyNode() {}
    LegacyNode.type = "LegacyNode";
    LegacyNode.comfyClass = "LegacyNode";
    LegacyNode.prototype.onDrawForeground = function () {
      h.busy(0.75);
    };
    h.LiteGraph.registered_node_types.LegacyNode = LegacyNode;

    h.canvas.nodes = [h.makeNode(LegacyNode)];
    h.advance(2500); // the scan runs on an interval
    drawLoop(h, 1);

    const row = hookRow(h.tracker.snapshot, "(pre-existing) LegacyNode");
    assert(row, "pre-existing prototype hook should be adopted and named by node type");
    assertGreater(row.msPerFrame, 0.5, "its cost should be attributed rather than invisible");
  });

  test("adopts per-instance hooks (the this.onDrawForeground = ... pattern)", async () => {
    const h = await boot();
    const NodeType = h.registerNodeType("Previewish");
    const node = h.makeNode(NodeType);
    // Exactly how ComfyUI's own core nodes draw: an own-property hook assigned
    // in onNodeCreated, never touching the prototype.
    node.onDrawForeground = function () {
      h.busy(0.6);
    };
    h.canvas.nodes = [node];
    drawLoop(h, 1);

    const snap = h.tracker.snapshot;
    const row = snap.hooks.find((r) => r.label.includes("instance hook"));
    assert(row, "instance hook should be adopted, not left unattributed");
    assertGreater(row.msPerFrame, 0.4, "instance hook cost should be measured");
  });
});

suite("attribution math", () => {
  test("off-frame hook calls never inflate the frame (v1 regression)", async () => {
    const h = await boot();
    await h.registerExtension("OffFramePack", {
      beforeRegisterNodeDef(nodeType) {
        nodeType.prototype.onDrawForeground = function () {
          h.busy(0.4);
        };
      },
    });
    const NodeType = h.registerNodeType("OffFrameNode");
    const node = h.makeNode(NodeType);
    h.canvas.nodes = [node];
    drawLoop(h, 1);

    const before = h.tracker.snapshot.frame;
    // 200ms of hook work OUTSIDE any redraw, e.g. from onExecuted.
    for (let i = 0; i < 200; i++) node.onDrawForeground();

    const after = h.tracker.snapshot;
    assertClose(after.frame.meanFrameMs, before.meanFrameMs, 0.01, "off-frame work must not change the measured frame time");
    assertLess(after.frame.attrMsPerFrame, after.frame.meanFrameMs + 0.001, "attributed can never exceed the frame");
    assertLess(after.frame.otherMsPerFrame, after.frame.meanFrameMs + 0.001, "budget lines must stay physically possible");
    const row = hookRow(after, "OffFramePack");
    assertGreater(row.outsideMs, 70, "off-frame time should be reported in its own column");
    assertLess(row.outsideMs / row.outsideCalls, 1.5, "off-frame ms/call should be the real cost");
  });

  test("frame budget lines add up and chrome excludes hook time", async () => {
    const h = await boot();
    await h.registerExtension("BudgetPack", {
      beforeRegisterNodeDef(nodeType) {
        nodeType.prototype.onDrawForeground = function () {
          h.busy(1.0);
        };
      },
    });
    const NodeType = h.registerNodeType("BudgetNode");
    h.canvas.costs = { background: 0.5, connections: 2.0, chrome: 0.5 };
    h.canvas.nodes = [h.makeNode(NodeType), h.makeNode(NodeType)];
    drawLoop(h, 1);

    const f = h.tracker.snapshot.frame;
    // per frame: background 0.5 + connections 2.0 + 2 x (chrome 0.5 + hook 1.0)
    assertClose(f.meanFrameMs, 5.5, 0.01, "total frame time");
    assertClose(f.nodeMsPerFrame, 3.0, 0.01, "drawNode total (2 nodes x 1.5ms)");
    assertClose(f.attrMsPerFrame, 2.0, 0.01, "wrapped hook subset");
    assertClose(f.chromeMsPerFrame, 1.0, 0.01, "chrome = drawNode - hooks");
    assertClose(f.connMsPerFrame, 2.0, 0.01, "connections");
    assertClose(f.otherMsPerFrame, 0.5, 0.01, "everything else = background");
    assertClose(f.nodeShare + f.connShare + f.otherShare, 1, 0.005, "shares must cover the frame exactly");
  });

  test("fps is a real rate, and p95 comes from the frame-time distribution", async () => {
    const h = await boot();
    h.canvas.nodes = [];
    h.canvas.costs = { background: 0.5, connections: 0, chrome: 0 }; // fixed, known cost per frame
    for (let i = 0; i < 60; i++) {
      h.advance(1000 / 30);
      h.canvas.draw();
    }
    const f = h.tracker.snapshot.frame;
    assertClose(f.fps, 30, 1.5, "fps should be the observed redraw rate");
    assertGreater(f.p95, 0, "p95 must be populated");
    assert(f.p95 >= f.p50, "p95 >= p50");
  });

  test("idle extension reappears instead of vanishing forever (v1 regression)", async () => {
    const h = await boot();
    await h.registerExtension("QuietPack", {
      beforeRegisterNodeDef(nodeType) {
        nodeType.prototype.onDrawForeground = function () {
          h.busy(0.5);
        };
      },
    });
    const NodeType = h.registerNodeType("QuietNode");
    h.canvas.nodes = [h.makeNode(NodeType)];
    drawLoop(h, 1);
    assert(hookRow(h.tracker.snapshot, "QuietPack"), "row present while drawing");

    // Go quiet for a long time (user switched tabs), then come back.
    h.advance(12000);
    assert(!hookRow(h.tracker.snapshot, "QuietPack"), "row ages out of the window while idle");
    h.advance(1000);
    drawLoop(h, 1);
    const row = hookRow(h.tracker.snapshot, "QuietPack");
    assert(row, "row must come back when drawing resumes — v1 deleted the bucket and lost it for the session");
    assertGreater(row.msPerFrame, 0.3, "and it must still carry real numbers");
  });

  test("a stale graph's numbers age out instead of freezing (v1 regression)", async () => {
    const h = await boot();
    await h.registerExtension("SwitchPack", {
      beforeRegisterNodeDef(nodeType) {
        nodeType.prototype.onDrawForeground = function () {
          h.busy(0.5);
        };
      },
    });
    const NodeType = h.registerNodeType("SwitchNode");
    h.canvas.nodes = [h.makeNode(NodeType)];
    drawLoop(h, 1);
    assertGreater(h.tracker.snapshot.nodeTypes.length, 0, "node rows while drawing");

    // Switch to a different graph: no more draws at all.
    h.canvas.nodes = [];
    h.advance(15000);
    assertEqual(h.tracker.snapshot.nodeTypes.length, 0, "node-type rows must age out of the window");
    const hooksStillListed = h.tracker.snapshot.hooks.filter((r) => r.msPerFrame > 0 || r.outsideMs > 0);
    assertEqual(hooksStillListed.length, 0, "no hook should still report live cost after 15s idle");
  });
});

suite("mute", () => {
  test("muting skips the hook body entirely and is reversible", async () => {
    const h = await boot();
    let calls = 0;
    await h.registerExtension("MuteTarget", {
      beforeRegisterNodeDef(nodeType) {
        nodeType.prototype.onDrawForeground = function () {
          calls++;
          h.busy(0.5);
        };
      },
    });
    const NodeType = h.registerNodeType("MuteTargetNode");
    h.canvas.nodes = [h.makeNode(NodeType)];
    drawLoop(h, 0.5);
    const beforeMute = calls;
    assertGreater(beforeMute, 10, "hook ran before muting");

    h.tracker.mute("MuteTarget");
    h.tracker.reset();
    drawLoop(h, 0.5);
    assertEqual(calls, beforeMute, "a muted hook must not execute at all — measuring it as zero would defeat the A/B");

    const snap = h.tracker.snapshot;
    const row = hookRow(snap, "MuteTarget");
    assert(row, "a muted owner must stay listed so it can always be unmuted");
    assert(row.muted, "row marked muted");
    assertGreater(row.skipped, 10, "skipped calls should be counted so you can see it is still being invoked");

    h.tracker.unmute("MuteTarget");
    drawLoop(h, 0.5);
    assertGreater(calls, beforeMute, "unmuting restores the hook");
  });

  test("mutes survive a graph reconfigure, samples do not", async () => {
    const h = await boot();
    await h.registerExtension("PersistPack", {
      beforeRegisterNodeDef(nodeType) {
        nodeType.prototype.onDrawForeground = function () {
          h.busy(0.5);
        };
      },
    });
    const NodeType = h.registerNodeType("PersistNode");
    h.canvas.nodes = [h.makeNode(NodeType)];
    drawLoop(h, 1);
    h.tracker.mute("PersistPack");
    const ext = h.app.extensions.find((e) => e.name === EXT_NAME);
    ext.afterConfigureGraph();
    assertEqual(h.tracker.snapshot.frame.n, 0, "a new graph clears the samples");
    assert(h.tracker.snapshot.settings.muted.includes("PersistPack"), "but an explicit mute is a standing user choice");
  });
});

suite("redraw rate cap", () => {
  test("cap delays redraws instead of dropping them (v1 regression)", async () => {
    const h = await boot();
    h.tracker.setCap(100);
    const issued = drawLoop(h, 1, FRAME_MS); // 60 attempts over 1s
    const drawn = h.canvas.drawCalls;
    assertLess(drawn, issued / 2, "most attempts should be capped");
    assertGreater(drawn, 8, "a 100ms cap must still land ~10 redraws a second");

    // Nothing may be left permanently stale: the trailing redraw must fire.
    const before = h.canvas.drawCalls;
    h.advance(150);
    assertGreater(h.canvas.drawCalls, before, "the trailing redraw must actually happen");
    const counters = h.tracker.snapshot.self;
    assertGreater(h.tracker.snapshot.settings.capMs, 0, "cap is reported in the snapshot");
    assert(counters);
  });

  test("a 1fps cap still reports a usable fps (v1 reported 0)", async () => {
    const h = await boot();
    h.tracker.setCap(1000);
    drawLoop(h, 20, FRAME_MS);
    const f = h.tracker.snapshot.frame;
    assertEqual(f.windowMs, 10000, "a 1fps cap still fills the normal 10s window");
    assertGreater(f.n, 5, "should have several frames to work with");
    assertClose(f.fps, 1, 0.5, "fps should be roughly 1, not 0/NaN");
  });

  test("a 5s cap widens the frame window instead of reporting a bogus fps", async () => {
    const h = await boot();
    h.tracker.setCap(5000);
    drawLoop(h, 32, FRAME_MS);
    const f = h.tracker.snapshot.frame;
    assertEqual(f.windowMs, 30000, "fewer than 4 frames in 10s must widen the horizon");
    assertGreater(f.n, 3, "enough frames for a rate");
    assertClose(f.fps, 0.2, 0.08, "one redraw every 5s is 0.2 fps");
  });

  test("cap off means no interference", async () => {
    const h = await boot();
    h.tracker.setCap(0);
    const issued = drawLoop(h, 0.5, FRAME_MS);
    assertEqual(h.canvas.drawCalls, issued, "every draw passes through when the cap is off");
  });
});

suite("non-canvas lanes", () => {
  test("redraw requests are attributed to a caller", async () => {
    const h = await boot();
    for (let i = 0; i < 60; i++) {
      h.advance(1000 / 60); // requests spread over one real second
      h.canvas.setDirty(true, true);
    }
    const inv = h.tracker.snapshot.invalidation;
    assertClose(inv.perSec, 60, 4, "exact request rate should be measured");
    assertGreater(inv.sources.length, 0, "at least one sampled caller");
    const total = inv.sources.reduce((a, s) => a + s.sampled, 0);
    assertGreater(total, 0, "samples attributed");
  });

  test("parseCallerStack finds the caller and its extension pack", () => {
    const h = createHarness();
    const parse = h.sandbox.window.__antsTracker.parseCallerStack;
    const stack = [
      "Error",
      "    at LGraphNode.setDirtyCanvas (http://localhost:8188/scripts/app.js:1200:30)",
      "    at LGraphCanvas.setDirty (http://localhost:8188/extensions/tracker.js:900:5)",
      "    at updateStatus (http://localhost:8188/extensions/ComfyUI-Custom-Scripts/js/status.js:412:9)",
      "    at timerHandler (http://localhost:8188/extensions/ComfyUI-Custom-Scripts/js/status.js:500:3)",
    ].join("\n");
    const info = parse(stack);
    assert(info, "must resolve a caller");
    assertEqual(info.pack, "ComfyUI-Custom-Scripts", "the extension pack is what the user needs to name");
    assertInclude2(info.sig, "updateStatus");
    assertInclude2(info.line, "412");
  });

  test("long animation frames are attributed to script + invoker", async () => {
    const h = await boot();
    assert(h.tracker.snapshot.support.loaf, "harness advertises LoAF support");
    h.advance(4000); // let the observation window elapse so the rate has a real denominator
    h.emitPerformance("long-animation-frame", [
      {
        startTime: h.clock.now - 300,
        duration: 300,
        blockingDuration: 250,
        scripts: [
          {
            sourceURL: "http://localhost:8188/extensions/BadPack/js/heartbeat.js",
            sourceFunctionName: "pollStatus",
            invoker: "TimerHandler:setInterval",
            invokerType: "user-callback",
            duration: 280,
            forcedStyleAndLayoutDuration: 40,
          },
        ],
      },
    ]);
    const st = h.tracker.snapshot.stalls;
    // One 250ms-blocking stall inside the 4s window = 62.5 ms of blocking per second.
    assertClose(st.blockingMsPerSec, 62.5, 1, "blocking time per second of wall clock");
    assertClose(st.perSec, 0.25, 0.02, "stall rate");
    assertGreater(st.sources.length, 0, "stall source rows");
    const src = st.sources[0];
    assertEqual(src.pack, "BadPack", "the pack must be named");
    assertGreater(src.forcedLayoutMs, 0, "forced layout should be surfaced");
    assertInclude2(src.invoker, "setInterval");
  });

  test("Stalls rates age out after 4s but source rows are retained for 30s", async () => {
    const h = await boot();
    h.advance(4000);
    h.emitPerformance("long-animation-frame", [
      {
        startTime: h.clock.now - 100,
        duration: 200,
        blockingDuration: 160,
        scripts: [
          {
            sourceURL: "http://localhost:8188/extensions/SlowPack/js/poll.js",
            sourceFunctionName: "poll",
            invoker: "TimerHandler:setInterval",
            duration: 180,
            forcedStyleAndLayoutDuration: 0,
          },
        ],
      },
    ]);
    assertEqual(h.tracker.snapshot.stalls.sources.length, 1, "the event creates one source row");
    h.advance(5000);
    const quiet = h.tracker.snapshot.stalls;
    assertEqual(quiet.blockingMsPerSec, 0, "the recent 4s headline rate falls to zero when the event ages out");
    assertEqual(quiet.sources.length, 1, "but the source row is still retained after 5s");
    h.advance(26000);
    assertEqual(h.tracker.snapshot.stalls.sources.length, 0, "the row leaves only after its 30s retention window");
  });

  test("load tab reports a span, not a sum of overlapping durations (v1 regression)", async () => {
    const h = await boot();
    // 10 concurrently-fetched files: sum of durations 1000ms, real span 120ms.
    for (let i = 0; i < 10; i++) {
      h.addResource(`/extensions/HeavyPack/js/file${i}.js`, { startTime: i * 10, duration: 100, transferSize: 5000 });
    }
    const load = h.tracker.snapshot.load;
    assertEqual(load.length, 1, "one pack");
    const p = load[0];
    assertEqual(p.files, 10);
    assertClose(p.spanMs, 190, 5, "span = first start to last end");
    assertGreater(p.sumDuration, 900, "the raw sum is still available internally");
    assertLess(p.spanMs, p.sumDuration, "the reported number must not be the impossible sum");
  });
});

suite("pause / reset / self-cost", () => {
  test("pause freezes the snapshot and resume continues it", async () => {
    const h = await boot();
    h.canvas.nodes = [];
    drawLoop(h, 1);
    const framesBefore = h.tracker.snapshot.frame.n;
    assertGreater(framesBefore, 20, "frames recorded while live");

    h.tracker.pause();
    drawLoop(h, 1);
    assertEqual(h.tracker.snapshot.frame.n, framesBefore, "paused sampling records nothing");
    assertGreater(h.canvas.drawCalls, 100, "but rendering is untouched — every draw still happened");

    h.tracker.resume();
    drawLoop(h, 0.5);
    assertGreater(h.tracker.snapshot.frame.n, framesBefore, "resuming records again");
  });

  test("reset clears samples but keeps mutes and the cap", async () => {
    const h = await boot();
    drawLoop(h, 1);
    h.tracker.mute("Something");
    h.tracker.setCap(50);
    h.tracker.reset();
    const snap = h.tracker.snapshot;
    assertEqual(snap.frame.n, 0, "samples cleared");
    assertEqual(snap.settings.capMs, 50, "cap kept");
    assert(snap.settings.muted.includes("Something"), "mute kept");
  });

  test("reports its own cost and buffer footprint", async () => {
    const h = await boot();
    await h.registerExtension("FootprintPack", {
      beforeRegisterNodeDef(nodeType) {
        nodeType.prototype.onDrawForeground = function () {
          h.busy(0.2);
        };
      },
    });
    h.canvas.nodes = [h.makeNode(h.registerNodeType("FootprintNode"))];
    drawLoop(h, 2);
    const self = h.tracker.snapshot.self;
    assertGreater(self.buckets, 0, "buckets tracked");
    assertGreater(self.ringBytes, 0, "ring memory accounted for");
    assertLess(self.renderMsPerSec, 50, "the panel must not be a measurable cost (ms/s)");
  });

  test("the telemetry report is a complete plain-text snapshot", async () => {
    const h = await boot();
    h.canvas.nodes = [];
    drawLoop(h, 1);
    const report = h.tracker.report;
    for (const section of ["-- FRAME --", "-- EXTENSION / NODE-TYPE DRAW HOOKS", "-- NODE TYPES", "-- REDRAW REQUESTS", "-- STALLS", "-- LOAD", "-- MEMORY", "-- BENCHMARK", "-- TRACKER SELF-COST"]) {
      assertIncludes(report, section, "report section missing");
    }
    assertIncludes(report, "settings:", "report should state the settings it was captured with");
  });
});

function assertInclude2(haystack, needle) {
  if (!String(haystack).includes(needle)) {
    throw new Error(`expected ${JSON.stringify(String(haystack))} to include ${JSON.stringify(needle)}`);
  }
}

suite("nesting and self-attribution", () => {
  test("a hook that calls another wrapped hook is not counted twice", async () => {
    const h = await boot();
    await h.registerExtension("InnerPack", {
      beforeRegisterNodeDef(nodeType) {
        nodeType.prototype.onDrawForeground = function () {
          h.busy(1.0);
        };
      },
    });
    await h.registerExtension("OuterPack", {
      beforeRegisterNodeDef(nodeType) {
        const prev = nodeType.prototype.onDrawForeground;
        nodeType.prototype.onDrawForeground = function (...args) {
          busySelf();
          const r = prev ? prev.apply(this, args) : undefined;
          return r;
        };
        function busySelf() {
          h.busy(0.5);
        }
      },
    });
    const NodeType = h.registerNodeType("ComposedNode");
    h.canvas.nodes = [h.makeNode(NodeType)];
    drawLoop(h, 1);

    const f = h.tracker.snapshot.frame;
    // drawNode = chrome 0.25 + outer 0.5 + inner 1.0 (nested inside outer) = 1.75
    assertClose(f.nodeMsPerFrame, 1.75, 0.02, "node draw total");
    // Attributed must count the outermost hook only: 0.5 + 1.0 lumped as its
    // own call = 1.5, not 0.5 + (0.5+1.0) = 2.0.
    assertClose(f.attrMsPerFrame, 1.5, 0.02, "nested hook time counted once, at its leaf cost");
    assertClose(f.chromeMsPerFrame, 0.25, 0.02, "chrome still excludes every wrapped hook");
    assertLess(f.attrMsPerFrame, f.nodeMsPerFrame, "attributed stays a subset of drawNode");
  });

  test("the tracker's own forced tick is labelled as such, not blamed on an extension", async () => {
    const h = await boot();
    h.tracker.setSyntheticTick(100);
    h.advance(1000);
    const inv = h.tracker.snapshot.invalidation;
    assertGreater(inv.perSec, 5, "the synthetic tick drives real redraw requests");
    assertGreater(inv.sources.length, 0, "and they are attributed to something");
    assertIncludes(inv.sources[0].sig, "tracker", "the caller must be identified as this tool, never as a node pack");
    assertEqual(inv.sources[0].pack, null, "and certainly never attributed to an extension pack");
  });
});

suite("nested hook rows do not double count", () => {
  // The pattern that shows up in real graphs (and in the report that prompted
  // this): a node type's prototype hook is adopted, and the node instance has
  // its own hook that delegates to it. The frame total was already correct, but
  // both rows recorded the same milliseconds, so the table read as double the
  // truth.
  async function delegateFixture(h, cost) {
    await h.registerExtension("DelegatePack", {
      beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== "DelegateNode") return;
        nodeType.prototype.onDrawBackground = function () {
          h.busy(cost);
        };
      },
    });
    const Node = h.registerNodeType("DelegateNode");
    const node = h.makeNode(Node);
    node.onDrawBackground = function (...args) {
      return Node.prototype.onDrawBackground.apply(this, args);
    };
    h.canvas.nodes = [node];
  }

  test("rows add up to the frame's hook total", async () => {
    const h = await boot();
    await delegateFixture(h, 2);
    for (let i = 0; i < 60; i++) {
      h.advance(FRAME_MS);
      h.canvas.draw(true, true);
    }
    const snap = h.tracker.snapshot;
    assertGreater(snap.hooks.length, 1, "both hooks are still reported");
    const rowSum = snap.hooks.reduce((a, r) => a + (Number.isFinite(r.msPerFrame) ? r.msPerFrame : 0), 0);
    assertClose(rowSum, snap.frame.attrMsPerFrame, 0.1, "the Timing rows must add up to the frame's hook total");
    assertClose(snap.frame.attrMsPerFrame, 2, 0.1, "and the frame sees the hook work exactly once");
  });

  test("the nested hook says so instead of claiming the milliseconds", async () => {
    const h = await boot();
    await delegateFixture(h, 2);
    for (let i = 0; i < 60; i++) {
      h.advance(FRAME_MS);
      h.canvas.draw(true, true);
    }
    const rows = h.tracker.snapshot.hooks;
    // Which of the pair is the outer one depends on what the frontend calls
    // first (here: the instance hook, which delegates to the prototype method),
    // so identify them by what they report rather than by name.
    const nested = rows.find((r) => r.nestedCalls > 0);
    const outer = rows.find((r) => r.msPerFrame > 0);
    assert(outer && nested, "the delegating and the delegated hook are both listed");
    assert(outer.label !== nested.label, "and they are two different rows");
    assertClose(outer.msPerFrame, 2, 0.1, "the outermost hook carries the cost");
    assertEqual(nested.msPerFrame, 0, "the nested one carries none of it");
    assertGreater(nested.nestedCalls, 0, "but its calls are still reported");
    assertClose(nested.callsPerFrame, outer.callsPerFrame, 0.05, "each call happened once, in both rows");
    assert(!Number.isFinite(nested.msPerCall), "so its ms/call is unknown rather than zero");
  });
});

suite("scripted pan benchmark", () => {
  test("produces comparable A/B numbers and warns when the mutes differ", async () => {
    const h = await boot();
    const cost = { ms: 1.2 };
    await h.registerExtension("BenchPack", {
      beforeRegisterNodeDef(nodeType) {
        nodeType.prototype.onDrawForeground = function () {
          h.busy(cost.ms);
        };
      },
    });
    const NodeType = h.registerNodeType("BenchNode");
    h.canvas.nodes = [h.makeNode(NodeType)];
    // The fake canvas only redraws when driven; the benchmark requests a redraw
    // per animation frame, so drive the loop while it runs.
    const drive = () => {
      for (let i = 0; i < 220; i++) {
        h.advance(FRAME_MS);
        h.canvas.draw();
      }
    };

    h.tracker.benchmark(1000, "A");
    let moved = 0;
    const driveMoving = () => {
      for (let i = 0; i < 220; i++) {
        h.advance(FRAME_MS);
        h.canvas.draw();
        moved = Math.max(moved, Math.abs(h.canvas.ds.offset[0]), Math.abs(h.canvas.ds.offset[1]));
      }
    };
    driveMoving();
    let bench = h.tracker.snapshot.settings.benchmark;
    assert(bench && bench.A, "run A recorded");
    assertGreater(bench.A.frames, 30, "A measured real frames");
    assertGreater(bench.A.meanFrameMs, 0.5, "A measured the real frame cost");
    assertGreater(bench.A.travelX, 400, "the pan travels more than the old 40-unit fidget");
    assertEqual(bench.A.screens, 1.5, "one screen plus the default half-screen margin");
    assertEqual(bench.A.foveaOn, false, "foveation was off, and the result says so");
    assertEqual(h.canvas.ds.offset[0], 0, "the view is put back");
    assertEqual(h.canvas.ds.offset[1], 0, "both axes");
    assertGreater(moved, 400, "the offset actually moved during the run, not only on paper");

    // Mute the expensive pack, reset samples, measure again: B must be cheaper.
    h.tracker.mute("BenchPack");
    h.tracker.reset();
    h.tracker.benchmark(1000, "B");
    drive();
    bench = h.tracker.snapshot.settings.benchmark;
    assert(bench.B, "run B recorded");
    assertLess(bench.B.meanFrameMs, bench.A.meanFrameMs - 0.5, "the muted run must be measurably cheaper");
    assertEqual(bench.B.muted.length, 1, "the mute state is captured with the run");
    assertEqual(bench.A.muted.length, 0, "and A recorded that it was unmuted");

    // The Testing tab states the comparison in plain terms.
    h.tracker.open();
    const body = h.document.getElementById("ants-tracker-body");
    const tabs = h.document.getElementById("ants-tracker-tabs");
    for (const btn of tabs.children) if (btn.textContent === "Testing") btn.click();
    h.advance(60);
    const text = body.textContent;
    assertIncludes(text, "fps", "delta line shows the fps change");
    assertIncludes(text, "different mutes", "and warns that the two runs differ on purpose");
  });
});
