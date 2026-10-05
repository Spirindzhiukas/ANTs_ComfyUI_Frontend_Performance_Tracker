// Scheduler-layer tests: the half of the tracker that does something about what
// it measures. These cover the two invariants the Governor promises —
//   1. a source with the "normal" policy is measured and otherwise untouched;
//   2. a limited source is slowed, never silenced and never broken (clear*
//      still cancels, a self-scheduling loop keeps its single chain, a callback
//      that was skipped still runs) —
// plus the redraw merge, the adaptive rAF mode with its input guard, the frame
// traces, the off-thread lane, and the fact that the tracker's own timers can
// never be limited by a policy.
//
// Timers here are registered through `h.sandbox.*`, which is the page's own
// global in the harness, exactly like an extension calling setInterval.

import vm from "node:vm";
import { createHarness, FRAME_MS } from "./harness.mjs";
import { suite, test, assert, assertEqual, assertClose, assertGreater, assertLess, assertIncludes } from "./framework.mjs";

async function boot(options) {
  const h = createHarness(options);
  for (const ext of h.app.extensions) if (ext.setup) await ext.setup();
  await h.flush();
  return h;
}

function row(h, namePart) {
  return h.tracker.governor.sources.find((r) => r.name === namePart || r.label.includes(namePart));
}

// Runs per second over a fresh window. Always re-reads the live source: a row
// object is a snapshot, and a snapshot taken before a policy was applied would
// make a limited source look unlimited.
function rateOver(h, name, ms) {
  const before = row(h, name).fires;
  h.advance(ms);
  return ((row(h, name).fires - before) / ms) * 1000;
}

suite("governor: measurement and untouched sources", () => {
  test("a heartbeat is measured per source, named, and left alone by default", async () => {
    const h = await boot();
    let n = 0;
    h.sandbox.setInterval(function clampHeartbeat() {
      n++;
      h.busy(2);
    }, 50);
    h.advance(2000);
    const r = row(h, "clampHeartbeat");
    assert(r, "the interval is registered as a source");
    assertEqual(r.kind, "interval");
    assertEqual(r.kindLabel, "setInterval");
    assertEqual(r.requestedMs, 50);
    assertEqual(r.policy, "full");
    assertEqual(r.ours, false);
    assertGreater(r.fires, 30, "~40 runs in 2s");
    assertGreater(r.msPerSec, 25, "2ms per run at ~20 runs/s is ~40ms/s");
    assertGreater(r.perRunMs, 1.5, "per-run cost is measured");
    // nothing is limited, so nothing is claimed to be saved
    assertEqual(h.tracker.governor.metrics.throttled, 0);
    assertEqual(r.skipped, 0, "no tick of an untouched source is skipped");
  });

  test("sources are attributed to the file that registered them", async () => {
    const h = await boot();
    // Registered the way an extension does it: from a script whose URL is what
    // the panel can print, so this checks the attribution path rather than the
    // test runner's own file names.
    h.sandbox.__antsCost = (ms) => h.busy(ms);
    h.sandbox.__antsRuns = {};
    vm.runInContext(
      `setInterval(function packHeartbeat() { __antsRuns.pack = (__antsRuns.pack || 0) + 1; __antsCost(1); }, 50);`,
      h.sandbox,
      { filename: "http://localhost:8188/extensions/SomePack/js/main.js" }
    );
    h.advance(400);
    const r = row(h, "packHeartbeat");
    assert(r, "the extension's heartbeat is registered");
    assertEqual(r.ours, false, "another script's timer is not exempt from limits");
    assertIncludes(r.file, "SomePack/js/main.js", "the row names the script that registered it");
    assert(h.tracker.governor.policy(r.key, "hz1"), "and it can therefore be limited");
  });

  test("the registry is bounded, so a registration storm cannot grow it forever", async () => {
    const h = await boot();
    for (let i = 0; i < 600; i++) h.sandbox.setTimeout(function () {}, 100 + i);
    assertLess(h.tracker.governor.state.sources.size, 402, "registry stays bounded");
  });

  test("the tracker's own timers are marked and can never be limited", async () => {
    const h = await boot();
    const ours = h.tracker.governor.sources.filter((r) => r.ours);
    assertGreater(ours.length, 0, "the tracker's own timers are flagged");
    const target = ours.find((r) => r.name !== "(anonymous)") || ours[0];
    assertEqual(h.tracker.governor.policy(target.key, "hz1"), false, "a policy on an own source is refused");
    const after = h.tracker.governor.sources.find((r) => r.key === target.key);
    assertEqual(after.policy, "full", "it stays untouched");
  });
});

suite("governor: limits slow sources without silencing them", () => {
  test("½ speed halves an interval's runs, and 'normal' restores them", async () => {
    const h = await boot();
    let n = 0;
    h.sandbox.setInterval(function pollThing() {
      n++;
      h.busy(1);
    }, 20);
    h.advance(1000);
    const r = row(h, "pollThing");
    const before = rateOver(h, "pollThing", 1000);
    assertGreater(before, 30, "~50 runs/s before the limit");

    assert(h.tracker.governor.policy(r.key, "half"), "the policy applies to the visible row");
    n = 0;
    const during = rateOver(h, "pollThing", 2000);
    assertLess(during, before * 0.7, "runs/s dropped");
    assertGreater(n, 15, "and it still runs: slowed, not silenced");
    const limited = row(h, "pollThing");
    assertEqual(limited.policy, "half");
    assertGreater(limited.effectiveMs, 30, "the effective gap is what the row says it is");
    assertGreater(limited.skipped, 0, "skipped ticks are counted");
    assertGreater(limited.savedMsPerSec, 0, "and converted into an estimated saving");

    assert(h.tracker.governor.policy(limited.key, "full"), "the limit can be lifted");
    const after = rateOver(h, "pollThing", 1000);
    assertClose(after, before, 12, "restoring normal restores the rate");
  });

  test("'pause' stops a heartbeat entirely and is reversible", async () => {
    const h = await boot();
    let n = 0;
    h.sandbox.setInterval(function pauseMe() {
      n++;
    }, 30);
    h.advance(600);
    const r = row(h, "pauseMe");
    assertGreater(r.fires, 5, "it was running");
    h.tracker.governor.policy(r.key, "pause");
    const frozen = row(h, "pauseMe").fires;
    h.advance(1000);
    assertEqual(row(h, "pauseMe").fires, frozen, "no runs while paused");
    h.tracker.governor.policy(r.key, "full");
    h.advance(300);
    assertGreater(row(h, "pauseMe").fires, frozen, "resuming brings it back");
  });

  test("a chained setTimeout is slowed by deferral and never dropped", async () => {
    const h = await boot();
    let n = 0;
    function chained() {
      n++;
      h.busy(1);
      h.sandbox.setTimeout(chained, 5);
    }
    h.sandbox.setTimeout(chained, 5);
    h.advance(1000);
    const r = row(h, "chained");
    assertGreater(r.fires, 50, "the chain runs fast before the limit");
    const f0 = r.fires;
    const reg0 = r.registrations;
    assert(h.tracker.governor.policy(r.key, "hz2"), "2/s limit");
    h.advance(5000);
    const r2 = row(h, "chained");
    const after = r2.fires - f0;
    assertLess(after, 20, "about 10 runs in 5s at 2/s");
    assertGreater(after, 3, "the chain is still alive");
    assertGreater(r2.deferred, 0, "skipped callbacks were deferred, not dropped");
    const regs = r2.registrations - reg0;
    assertLess(Math.abs(regs - after), 4, "one registration per run: no second chain");
  });

  test("clearInterval and clearTimeout still work, including on a deferred callback", async () => {
    const h = await boot();
    let n = 0;
    const id = h.sandbox.setInterval(function clearable() {
      n++;
      h.busy(0.5);
    }, 20);
    h.advance(200);
    h.sandbox.clearInterval(id);
    const frozen = n;
    h.advance(1000);
    assertEqual(n, frozen, "no further runs after clearInterval");

    // A one-shot callback that gets deferred must be cancellable through the id
    // the caller was handed — the deferred copy is not a second, invisible timer.
    let ran = 0;
    function oneShot() {
      ran++;
      h.busy(0.2);
    }
    h.sandbox.setTimeout(oneShot, 10);
    h.advance(20); // it ran once; the source now has a lastRunAt
    const r = row(h, "oneShot");
    assertGreater(r.fires, 0, "the callback ran");
    h.tracker.governor.policy(r.key, "half"); // >= 33ms gap
    const deferredId = h.sandbox.setTimeout(oneShot, 10);
    h.advance(12); // the timer fires, its dispatch is too soon, it is deferred
    assertEqual(ran, 1, "the deferred callback has not run yet");
    assertGreater(row(h, "oneShot").deferred, 0, "it was deferred");
    h.sandbox.clearTimeout(deferredId);
    h.advance(1000);
    assertEqual(ran, 1, "clearing the timer also cancels the deferred copy");

    // Without the cancellation the same path must still run the callback.
    h.sandbox.setTimeout(oneShot, 10);
    h.advance(500);
    assertEqual(ran, 2, "an uncancelled deferred callback runs when its window opens");
  });

  test("limits can be suggested from what was measured, and reset", async () => {
    const h = await boot();
    h.sandbox.setInterval(function expensiveThing() {
      h.busy(6);
    }, 20);
    h.advance(1500);
    const applied = h.tracker.governor.suggest();
    assert(applied.length > 0, "something was suggested");
    const r = row(h, "expensiveThing");
    assert(r.policy !== "full", "a limit was applied to the expensive source");
    h.tracker.governor.reset();
    assertEqual(row(h, "expensiveThing").policy, "full", "reset returns everything to untouched");
    assertEqual(h.tracker.governor.metrics.throttled, 0);
  });
});

suite("governor: rAF loops", () => {
  test("a self-scheduling rAF loop can be rate limited without killing it", async () => {
    const h = await boot();
    let frames = 0;
    function renderLoop() {
      frames++;
      h.busy(0.5);
      h.sandbox.requestAnimationFrame(renderLoop);
    }
    h.sandbox.requestAnimationFrame(renderLoop);
    h.advance(1000);
    const r = row(h, "renderLoop");
    assert(r, "the loop is a source");
    assertEqual(r.kind, "raf");
    const before = rateOver(h, "renderLoop", 1000);
    assertGreater(before, 40, "about 60 frames/s before the limit");

    assert(h.tracker.governor.policy(r.key, "quarter"), "quarter speed = one tick per ~66ms");
    const f0 = row(h, "renderLoop").fires;
    const reg0 = row(h, "renderLoop").registrations;
    h.advance(2000);
    const r2 = row(h, "renderLoop");
    const after = r2.fires - f0;
    assertLess(after, 40, "about 30 runs in 2s at ¼ speed");
    assertGreater(after, 10, "the loop is still alive");
    const regs = r2.registrations - reg0;
    assertLess(Math.abs(regs - after), 5, "one registration per run: no duplicate chain");
  });

  test("adaptive mode only bites while the thread is behind and nobody is interacting", async () => {
    const h = await boot();
    try {
      h.tracker.governor.control("rafMode", "adaptive");
      h.tracker.governor.control("rafMinHz", 10);
      h.tracker.governor.control("budgetMs", 12);
      let frames = 0;
      function adaptiveLoop() {
        frames++;
        h.busy(0.2);
        h.sandbox.requestAnimationFrame(adaptiveLoop);
      }
      h.sandbox.requestAnimationFrame(adaptiveLoop);
      h.advance(1000);
      const r = row(h, "adaptiveLoop");
      assertGreater(rateOver(h, "adaptiveLoop", 1000), 40, "a healthy thread runs the loop at full rate");
      assertEqual(h.tracker.governor.metrics.overBudget, false);

      // Pretend the main thread is blocked: a long animation frame is the same
      // signal the Stalls tab uses, and the governor reacts to it too.
      const stall = () => {
        h.emitPerformance("long-animation-frame", [
          {
            startTime: h.clock.now - 300,
            duration: 300,
            blockingDuration: 260,
            scripts: [{ sourceURL: "http://localhost:8188/assets/settingStore.js", sourceFunctionName: "renderFrame", duration: 280, forcedStyleAndLayoutDuration: 200 }],
          },
        ]);
      };
      // A blocked page keeps producing long frames, so the signal keeps firing
      // for as long as the problem lasts.
      const f0 = row(h, "adaptiveLoop").fires;
      for (let i = 0; i < 10; i++) {
        stall();
        h.advance(200);
      }
      const behind = row(h, "adaptiveLoop");
      const during = behind.fires - f0;
      assertLess(during, 40, "behind budget: ~15-20 ticks/s instead of 60");
      assertGreater(during, 4, "and still makes progress");
      assertGreater(behind.skipped, 0, "skips are counted");
      assertGreater(h.tracker.governor.state.counters.forced, 0, "the skip cap forced ticks through");
      assertEqual(h.tracker.governor.metrics.overBudget, true);

      // Input wins over the limiter: a user typing or dragging must not wait.
      stall();
      h.window.fire("mousemove");
      const duringInput = rateOver(h, "adaptiveLoop", 100);
      assertGreater(duringInput, 20, "input latency is not traded for smoothness");
    } finally {
      // Leave the default controls alone for the tests that follow.
      h.tracker.governor.reset();
    }
  });
});

suite("governor: redraw request merging", () => {
  test("requests that add nothing are merged; requests that add a flag still land", async () => {
    const h = await boot();
    try {
      h.tracker.governor.control("coalesce", true);
      h.advance(FRAME_MS);

      const b0 = h.canvas.dirtyCalls;
      h.canvas.setDirty(true, true);
      h.canvas.setDirty(true, true);
      h.canvas.setDirty(true, true);
      assertEqual(h.canvas.dirtyCalls - b0, 1, "only the first request reaches LiteGraph in this frame");
      assertEqual(h.tracker.governor.metrics.counters.coalesced, 2, "the other two are counted as merged");

      // A request that asks for something the frame has not asked for yet is
      // forwarded, merged with what the frame already has.
      h.advance(FRAME_MS);
      const b1 = h.canvas.dirtyCalls;
      h.canvas.setDirty(true, false);
      h.canvas.setDirty(false, true);
      assertEqual(h.canvas.dirtyCalls - b1, 2, "the new flag is forwarded");
      const pending = h.tracker.governor.state.redraw;
      assertEqual(pending.fg, true, "the merged request keeps the flags the frame already had");
      assertEqual(pending.bg, true, "and carries the new one");
    } finally {
      h.tracker.governor.control("coalesce", false);
    }
  });

  test("with merging off, every request is passed through untouched", async () => {
    const h = await boot();
    const b0 = h.canvas.dirtyCalls;
    h.advance(FRAME_MS);
    h.canvas.setDirty(true, true);
    h.canvas.setDirty(true, true);
    assertEqual(h.canvas.dirtyCalls - b0, 2, "no merging by default");
    assertEqual(h.tracker.governor.metrics.controls.coalesce, false);
  });
});

suite("governor: frame traces", () => {
  test("a long frame records its scripts, the ticks inside it and the redraw requests", async () => {
    const h = await boot();
    let n = 0;
    h.sandbox.setInterval(function nastyTick() {
      n++;
      h.busy(3);
    }, 20);
    h.advance(400);
    const start = h.clock.now;
    // Ask for a redraw from inside a real extension file, so the trace can name
    // the script that wanted the repaint rather than "the test runner".
    vm.runInContext("__canvas.setDirty(true, true);", Object.assign(h.sandbox, { __canvas: h.canvas }), {
      filename: "http://localhost:8188/extensions/SomePack/js/main.js",
    });
    h.advance(220); // eleven ticks of nastyTick inside the frame window
    h.emitPerformance("long-animation-frame", [
      {
        startTime: start,
        duration: 220,
        blockingDuration: 180,
        scripts: [
          {
            sourceURL: "http://localhost:8188/assets/settingStore-DDHzGrHr.js",
            sourceFunctionName: "renderFrame",
            invoker: "user-callback",
            duration: 200,
            forcedStyleAndLayoutDuration: 150,
          },
          {
            sourceURL: "http://localhost:8188/extensions/ANT_NODES/ant_loras_equalizer_curve.js",
            sourceFunctionName: "clamp",
            invoker: "TimerHandler:setInterval",
            duration: 14,
            forcedStyleAndLayoutDuration: 12,
          },
        ],
      },
    ]);
    await h.flush();
    const traces = h.tracker.governor.traces;
    assertGreater(traces.length, 0, "the long frame was captured");
    const tr = traces[0];
    assertEqual(tr.duration, 220);
    assertEqual(tr.blocking, 180);
    assertEqual(tr.layoutMs, 162, "forced layout is summed across scripts");
    assertEqual(tr.scripts[0].fn, "renderFrame", "the worst script is first");
    assertIncludes(tr.scripts[0].file, "settingStore");
    assertIncludes(tr.scripts[0].invoker, "user-callback");
    assert(tr.ticks.some((t) => t.label.includes("nastyTick")), "the heartbeat that ran inside the frame is listed");
    const tick = tr.ticks.find((t) => t.label.includes("nastyTick"));
    assertGreater(tick.count, 5, "with how many times it ran inside that frame");
    assertGreater(tick.ms, 10, "and what it cost inside that frame");
    assertEqual(tr.redraws, 1, "the redraw requests that arrived during the frame are counted");
    assert(tr.callers.length, "and the trace names who asked for it");
    assertIncludes(tr.callers[0].file, "SomePack/js/main.js", "by the script that called setDirty");
    assertEqual(tr.limited.length, 0, "nothing was limited yet");
  });

  test("a limit applied to a traced source shows up in the trace", async () => {
    const h = await boot();
    h.sandbox.setInterval(function tracedPoll() {
      h.busy(2);
    }, 20);
    h.advance(300);
    const r = row(h, "tracedPoll");
    h.tracker.governor.policy(r.key, "hz1");
    const start = h.clock.now;
    h.advance(120);
    h.emitPerformance("long-animation-frame", [
      {
        startTime: start,
        duration: 120,
        blockingDuration: 90,
        scripts: [{ sourceURL: "http://localhost:8188/assets/settingStore.js", sourceFunctionName: "renderFrame", invoker: "user-callback", duration: 110, forcedStyleAndLayoutDuration: 60 }],
      },
    ]);
    await h.flush();
    const tr = h.tracker.governor.traces[0];
    assert(tr, "a trace exists");
    assert(tr.limited.some((l) => l.includes("tracedPoll")), `the active limit is named in the trace (${JSON.stringify(tr.limited)})`);
  });

  test("frames shorter than the threshold are not traced, and tracing can be turned off", async () => {
    const h = await boot();
    h.emitPerformance("long-animation-frame", [
      { startTime: h.clock.now - 20, duration: 20, blockingDuration: 5, scripts: [{ sourceURL: "http://localhost:8188/x.js", sourceFunctionName: "quick", duration: 20 }] },
    ]);
    await h.flush();
    assertEqual(h.tracker.governor.traces.length, 0, "a 20ms frame is below the default 50ms threshold");
    h.tracker.governor.control("traceMinMs", 0);
    h.emitPerformance("long-animation-frame", [
      { startTime: h.clock.now - 400, duration: 400, blockingDuration: 300, scripts: [{ sourceURL: "http://localhost:8188/x.js", sourceFunctionName: "slow", duration: 400 }] },
    ]);
    await h.flush();
    assertEqual(h.tracker.governor.traces.length, 0, "tracing off means no capture at all");
    h.tracker.governor.control("traceMinMs", 50);
  });
});

suite("governor: off-thread lane", () => {
  test("with no Worker in the page the lane says so and still answers", async () => {
    const h = await boot();
    const m = h.tracker.governor.metrics;
    assertEqual(m.worker.available, false);
    assertIncludes(m.worker.why, "Worker");
    const res = await h.tracker.governor.offload("sum", [1, 2, 3, 4]);
    assertEqual(res.fellBack, true, "the fallback is reported, not hidden");
    assertEqual(res.value, 10, "the answer is the same either way");
    const selfTest = await h.tracker.governor.selfTest();
    assertEqual(selfTest.match, false, "nothing is claimed to run off-thread when it did not");
    assert(selfTest.error, "and the reason is reported");
  });

  test("the lane uses a Worker when the page has one, and counts the round trip", async () => {
    const h = await boot();
    const seen = [];
    class FakeWorker {
      constructor(url) {
        seen.push(["constructed", String(url).slice(0, 12)]);
      }
      postMessage(msg) {
        seen.push(["job", msg.job]);
        this.onmessage({ data: { id: msg.id, ok: true, value: msg.job === "echo" ? msg.arg : 42, ms: 7 } });
      }
    }
    h.sandbox.Worker = FakeWorker;
    h.sandbox.Blob = class {
      constructor(parts) {
        this.parts = parts;
      }
    };
    h.sandbox.URL = { createObjectURL: () => "blob:ants-governor" };
    h.tracker.governor.probeWorker();
    assertEqual(h.tracker.governor.metrics.worker.available, true, "the lane sees the worker");
    const res = await h.tracker.governor.offload("echo", { hello: "world" });
    assertEqual(res.value.hello, "world", "the reply comes back");
    assertGreater(h.tracker.governor.metrics.worker.jobs, 0, "the job is counted");
    assertGreater(h.tracker.governor.metrics.worker.offThreadMs, 0, "and so is the off-thread time it reported");
    assertEqual(seen[0][0], "constructed", "the worker starts on first use, not at page load");
  });

  test("master-off refuses new worker jobs and worker self-tests", async () => {
    const h = await boot();
    let posted = 0;
    class FakeWorker {
      constructor() {}
      postMessage(message) {
        posted++;
        this.onmessage({ data: { id: message.id, ok: true, value: 42, ms: 1 } });
      }
    }
    h.sandbox.Worker = FakeWorker;
    h.sandbox.Blob = class { constructor(parts) { this.parts = parts; } };
    h.sandbox.URL = { createObjectURL: () => "blob:ants-governor-off-test" };
    h.tracker.governor.probeWorker();
    const jobsBeforeOff = h.tracker.governor.metrics.worker.jobs;
    const postsBeforeOff = posted;

    h.tracker.lowZoom.setEnabled(false);
    const offload = await h.tracker.governor.offload("sum", [1, 2, 3]);
    assertEqual(offload.fellBack, true, "a direct call is reported as not offloaded");
    assertEqual(offload.value, null, "the disabled lane does not run the main-thread fallback either");
    assertIncludes(offload.reason, "optimizer is off", "the reason is explicit");
    assertEqual(posted, postsBeforeOff, "no worker message is sent while disabled");
    assertEqual(h.tracker.governor.metrics.worker.jobs, jobsBeforeOff, "no disabled job is counted");

    const selfTest = await h.tracker.governor.selfTest();
    assertEqual(selfTest.match, false, "the sanity check does not run while disabled");
    assertIncludes(selfTest.error, "not started", "the disabled state is reported rather than a false failure");
    assert(Number.isNaN(selfTest.mainMs), "the expensive main-thread twin is not run");
    assertEqual(posted, postsBeforeOff, "the self-test also leaves the worker idle");
    assertEqual(h.tracker.governor.metrics.worker.jobs, jobsBeforeOff, "the self-test adds no job");
  });

  test("the worker code itself computes the same answer as the main thread", async () => {
    const h = await boot();
    const src = h.tracker.governor.workerSource;
    const replies = [];
    const fakeSelf = { postMessage: (m) => replies.push(m) };
    const ctx = { self: fakeSelf, performance: { now: () => 1234 }, console };
    vm.createContext(ctx);
    vm.runInContext(src, ctx);

    fakeSelf.onmessage({ data: { id: 1, job: "selftest", arg: { n: 4000, seed: 99 } } });
    assertEqual(replies.length, 1, "the worker answered");
    assertEqual(replies[0].ok, true);
    const expected = h.tracker.governor.selfTestMain({ n: 4000, seed: 99 });
    assertEqual(replies[0].value.sum, expected.sum, "same sum as the main-thread twin");
    assertEqual(replies[0].value.first, expected.first);
    assertEqual(replies[0].value.last, expected.last);

    fakeSelf.onmessage({
      data: {
        id: 2,
        job: "run",
        arg: { source: "function (xs) { var s = 0; for (var i = 0; i < xs.length; i++) s += xs[i] * 2; return s; }", arg: [1, 2, 3] },
      },
    });
    assertEqual(replies[1].value, 12, "a self-contained function source runs off the main thread");

    fakeSelf.onmessage({ data: { id: 3, job: "nope", arg: null } });
    assertEqual(replies[2].ok, false, "an unknown job is an error, not a silent success");
  });
});

suite("governor: persistence", () => {
  test("limits survive a reload, keyed by what the row was called", async () => {
    const h = await boot();
    h.sandbox.setInterval(function persistentPoll() {
      h.busy(1);
    }, 25);
    h.advance(300);
    const r = row(h, "persistentPoll");
    assert(r, "the source exists");
    assert(h.tracker.governor.policy(r.key, "hz2"), "a limit is set");
    assertIncludes(h.localStorage.getItem("ants-governor-v1"), "hz2");

    // A second page load, same storage: the same code registers the same
    // heartbeat, and the saved limit has to find it again.
    const h2 = await boot({ storage: h.localStorage });
    h2.sandbox.setInterval(function persistentPoll() {
      h2.busy(1);
    }, 25);
    h2.advance(300);
    const r2 = row(h2, "persistentPoll");
    assert(r2, "the source exists on the second load");
    assertEqual(r2.policy, "hz2", "the saved limit re-attached");
    assertEqual(h2.tracker.governor.metrics.throttled, 1);
  });

  test("controls (budget, rAF mode, merging) are persisted too", async () => {
    const h = await boot();
    h.tracker.governor.control("budgetMs", 24);
    h.tracker.governor.control("rafMode", "adaptive");
    h.tracker.governor.control("coalesce", true);
    const h2 = await boot({ storage: h.localStorage });
    const c = h2.tracker.governor.metrics.controls;
    assertEqual(c.budgetMs, 24);
    assertEqual(c.rafMode, "adaptive");
    assertEqual(c.coalesce, true);
    h.tracker.governor.reset();
  });
});

suite("governor: it stays out of the way", () => {
  test("the governor reports its own overhead instead of hiding it", async () => {
    const h = await boot();
    h.sandbox.setInterval(function busyPoll() {
      h.busy(0.4);
    }, 20);
    h.advance(1200); // crosses the 1s self-cost rollover
    const m = h.tracker.governor.metrics;
    assert(Number.isFinite(m.overheadMsPerSec), "overhead is a number");
    assertLess(m.overheadMsPerSec, 20, "and it is small: wrapping timers is not a cost of its own");
  });

  test("a paused tracker still governs, but stops sampling", async () => {
    const h = await boot();
    let n = 0;
    h.sandbox.setInterval(function sampledPoll() {
      n++;
      h.busy(1);
    }, 20);
    h.advance(300);
    const r = row(h, "sampledPoll");
    h.tracker.pause();
    h.tracker.governor.policy(r.key, "hz1");
    const f0 = row(h, "sampledPoll").fires;
    h.advance(1500);
    assertGreater(row(h, "sampledPoll").fires - f0, 0, "the policy still applies while the panel is paused");
    h.advance(5000); // past the 4s window, so only unpaused samples could still be in it
    assertEqual(row(h, "sampledPoll").msPerSec, 0, "and no new samples are recorded while paused");
    h.tracker.resume();
  });
});

// ---------------------------------------------------------------------------
// The suite below exists because of a real regression: gating every source at
// its own asked-for delay, even with no limit requested, starved ComfyUI's
// repaint timer until the graph canvas went blank and unresponsive. Whatever
// else changes, "normal" has to keep meaning "measured, otherwise untouched".
suite("governor: it does not break the page", () => {
  test("with the defaults, nothing is skipped or deferred, however the page schedules its work", async () => {
    const h = await boot();
    let intervalRuns = 0;
    let chainRuns = 0;
    let rafRuns = 0;
    h.sandbox.setInterval(function repaintCheck() {
      intervalRuns++;
      h.busy(1);
    }, 100);
    const chain = () => {
      chainRuns++;
      h.busy(0.5);
      h.sandbox.setTimeout(chain, 50);
    };
    h.sandbox.setTimeout(chain, 50);
    const frame = () => {
      rafRuns++;
      h.sandbox.requestAnimationFrame(frame);
    };
    h.sandbox.requestAnimationFrame(frame);

    h.advance(2000);
    const c = h.tracker.governor.state.counters;
    assertEqual(c.skipped, 0, "nothing was skipped: the default policy is not a limit");
    assertEqual(c.deferred, 0, "and nothing was pushed through a deferred copy");
    assertGreater(intervalRuns, 17, "the interval runs at its own rate");
    assertLess(intervalRuns, 23, "which is 100ms, not slower");
    assertGreater(chainRuns, 34, "the chained timer keeps its own pace");
    assertLess(chainRuns, 44, "which is 50ms per link");
    assertGreater(rafRuns, 100, "the rAF loop still runs every frame");
  });

  test("two chains that share a name and a delay do not starve each other", async () => {
    const h = await boot();
    h.sandbox.__counts = { a: 0, b: 0 };
    h.sandbox.__antsCost = (ms) => h.busy(ms);
    vm.runInContext(
      `setInterval(function repaintCheck() { __counts.a++; __antsCost(1); }, 100);`,
      h.sandbox,
      { filename: "http://localhost:8188/assets/GraphView-one.js" }
    );
    vm.runInContext(
      `setInterval(function repaintCheck() { __counts.b++; __antsCost(1); }, 100);`,
      h.sandbox,
      { filename: "http://localhost:8188/assets/GraphView-two.js" }
    );
    h.advance(1000);
    // Both chains are one row in the table (same name, same delay), and with no
    // limit set that row must not cost either of them a single tick.
    assertGreater(h.sandbox.__counts.a, 8, "the first chain ran at its own rate");
    assertGreater(h.sandbox.__counts.b, 8, "and so did the second");
    assertEqual(h.tracker.governor.state.counters.skipped, 0, "no tick was swallowed by the shared row");
    const r = row(h, "repaintCheck");
    assertGreater(r.fires, 16, "the row accounts for both chains");
    assertGreater(r.registrations, 1, "and knows it holds more than one registration");
  });

  test("paused means dropped, not deferred into a 1ms loop", async () => {
    const h = await boot();
    let runs = 0;
    const chain = () => {
      runs++;
      h.sandbox.setTimeout(chain, 50);
    };
    h.sandbox.setTimeout(chain, 50);
    h.advance(300);
    const before = runs;
    const deferredBefore = h.tracker.governor.state.counters.deferred;
    h.tracker.governor.policy(row(h, "chain").key, "pause");
    h.advance(1000);
    assertEqual(runs, before, "a paused source stops running");
    assertEqual(
      h.tracker.governor.state.counters.deferred,
      deferredBefore,
      "and is not re-queued as an endless chain of deferred copies"
    );
  });

  test("a limited chain's deferrals are bounded, and each deferred copy runs exactly once", async () => {
    const h = await boot();
    let runs = 0;
    const frame = () => {
      runs++;
      h.sandbox.requestAnimationFrame(frame);
    };
    h.sandbox.requestAnimationFrame(frame);
    h.advance(200);
    const r = row(h, "frame");
    const deferred0 = r.deferred;
    h.tracker.governor.policy(r.key, "quarter");
    h.advance(1000);
    const after = row(h, "frame");
    const newRuns = runs - 0;
    assertLess(newRuns, 40, "the loop is slowed to roughly the quarter rate");
    assertGreater(newRuns, 5, "but it keeps making progress");
    const deferrals = after.deferred - deferred0;
    assertLess(deferrals, newRuns + 3, `deferrals stay bounded (${deferrals} for ${newRuns} runs)`);
    assertEqual(after.fires, runs, "the row counts every run exactly once, deferred ones included");
  });
});

suite("governor: fail open, and the way back", () => {
  // A hostile callback: reading `fn.name` throws. That is a stand-in for any
  // internal error, and it must not stop the timer from being registered.
  function hostile(fn) {
    return new Proxy(fn, {
      get(target, key) {
        if (key === "name") throw new Error("hostile name getter");
        return target[key];
      },
    });
  }

  test("a registration the layer cannot measure is still a registration", async () => {
    const h = await boot();
    let ran = 0;
    h.sandbox.setTimeout(hostile(function weird() { ran++; }), 20);
    h.advance(60);
    assertEqual(ran, 1, "the callback ran even though measuring it failed");
    assertGreater(h.tracker.governor.state.counters.errors, 0, "and the failure was reported, not swallowed");
    assertEqual(h.tracker.governor.metrics.disabled, false, "one error does not take the layer down");
  });

  test("after repeated internal errors it turns itself off and hands the page back", async () => {
    const h = await boot();
    const wrappedSetTimeout = h.sandbox.setTimeout;
    for (let i = 0; i < 3; i++) h.sandbox.setTimeout(hostile(function weird() {}), 30 + i);
    assertEqual(h.tracker.governor.metrics.disabled, true, "it gave up after the third error");
    assertIncludes(h.tracker.governor.metrics.offReason, "errors", "and says why");
    assertEqual(h.sandbox.setTimeout, h.tracker.governor.state.orig.setTimeout, "the browser's own setTimeout is back");
    assert(h.sandbox.setTimeout !== wrappedSetTimeout, "the wrapper is gone, not merely inert");

    // New registrations are ungoverned, and an old one still runs.
    let ran = 0;
    const before = h.tracker.governor.metrics.registered;
    h.sandbox.setTimeout(function afterwards() { ran++; }, 20);
    h.advance(60);
    assertEqual(ran, 1, "a timer registered afterwards still runs");
    assertEqual(h.tracker.governor.metrics.registered, before, "and is not even registered as a source");
  });

  test("the detached status and copied report say when the layer is off", async () => {
    const h = await boot();
    h.tracker.governor.off("turned off from the detached window");
    assertEqual(h.tracker.governor.metrics.disabled, true);
    const report = h.tracker.report;
    assertIncludes(report, "TURNED OFF", "the report leads with the layer state");
    assertIncludes(report, "turned off from the detached window", "and preserves the reason");
    h.tracker.open();
    assertEqual(h.panel(), null, "opening from the page never constructs the retired panel");
    assert(h.document.getElementById("ants-corner-btn")._cls.has("ants-window-blocked"), "a blocked detached launch stays visibly marked");
  });
});

suite("governor: relays, not a scapegoat", () => {
  test("the saved timer functions are called with the page's global as receiver", async () => {
    // Chrome throws "Illegal invocation" when setTimeout/clearTimeout are called
    // with `this` set to anything but the global object. The layer calls them as
    // methods of its own bookkeeping object, which is how it switched itself off
    // on a real page (3 dispatch errors, then fail-open). This shim behaves like
    // Chrome so the deferral path is exercised for real.
    const h = createHarness({ strictTimers: true });
    for (const ext of h.app.extensions) if (ext.setup) await ext.setup();
    await h.flush();

    let runs = 0;
    const chain = () => {
      runs++;
      h.busy(0.5);
      h.sandbox.setTimeout(chain, 10);
    };
    h.sandbox.setTimeout(chain, 10);
    h.advance(60);
    const r = row(h, "chain");
    h.tracker.governor.policy(r.key, "half"); // >= 33ms gap, so the chain gets deferred
    h.advance(300);
    assertGreater(row(h, "chain").deferred, 0, "the deferral path was exercised");
    assertEqual(h.tracker.governor.state.counters.errors, 0, "no internal error from calling the timer functions");
    assertEqual(h.tracker.governor.metrics.disabled, false, "so the layer is still on");
    assertGreater(runs, 8, "and the chain keeps running");
  });

  test("a frame relaying through the layer blames the source that ran inside it", async () => {
    const h = await boot();
    h.sandbox.__antsCost = (ms) => h.busy(ms);
    vm.runInContext(`setInterval(function packHeartbeat() { __antsCost(2); }, 20);`, h.sandbox, {
      filename: "http://localhost:8188/extensions/SomePack/js/main.js",
    });
    h.advance(200);
    const start = h.clock.now;
    h.advance(120);
    h.emitPerformance("long-animation-frame", [
      {
        startTime: start,
        duration: 300,
        blockingDuration: 260,
        scripts: [
          {
            sourceURL: "http://localhost:8188/extensions/ANTs_ComfyUI_Frontend_Performance_Tracker/tracker.js",
            sourceFunctionName: "(anonymous)",
            invokerType: "user-callback",
            invoker: "TimerHandler:setTimeout",
            duration: 300,
            forcedStyleAndLayoutDuration: 200,
          },
        ],
      },
    ]);
    await h.flush();
    const rows = h.tracker.snapshot.stalls.sources;
    const relayed = rows.find((r) => r.sig.includes("packHeartbeat"));
    assert(relayed, `the extension that ran inside the frame is named (${JSON.stringify(rows.map((r) => r.sig))})`);
    assertIncludes(relayed.sig, "SomePack/js/main.js", "by the file that registered it");
    assertIncludes(relayed.sig, "pass-through", "and the row says it was relayed, not that it was the offender");
    assert(!rows.some((r) => r.sig.includes("tracker.js")), "the profiler is not named as the offender");
  });

  test("with nothing measurable inside, it says so instead of claiming the time", async () => {
    const h = await boot();
    h.emitPerformance("long-animation-frame", [
      {
        startTime: h.clock.now - 900, // a window before any of this page's timers ran
        duration: 100,
        blockingDuration: 180,
        scripts: [
          {
            sourceURL: "http://localhost:8188/extensions/ANTs_ComfyUI_Frontend_Performance_Tracker/tracker.js",
            sourceFunctionName: "(anonymous)",
            invokerType: "user-callback",
            invoker: "TimerHandler:setInterval",
            duration: 200,
          },
        ],
      },
    ]);
    await h.flush();
    const rows = h.tracker.snapshot.stalls.sources;
    const row0 = rows.find((r) => r.sig.includes("(pass-through timer)"));
    assert(row0, `the row is marked as a relay with no measurable source (${JSON.stringify(rows.map((r) => r.sig))})`);
    assertEqual(row0.ours, true, "it is flagged as coming from this tool's own wrapper");
    assert(!/^\(anonymous\)/.test(row0.sig), "and is never shown as an anonymous offender in the tracker's file");
    assertEqual(row0.blockingMs, 200, "while still carrying the blocking time it caused");
  });
});

// ---------------------------------------------------------------------------
// The real page this was written against had two offenders running 1.3 and 3
// times a second because each run cost 300-470 ms. The old suggestion skipped
// both (it required 4 runs/s) and the half/quarter policies are no-ops for a
// chain like that, so the panel offered limits for a dozen 0.1 ms/s heartbeats
// and nothing happened where it mattered. These tests pin the new behaviour.
suite("governor: suggestions and the autopilot target what actually costs time", () => {
  // A runaway chain: asks for 10ms, blocks the thread for `work` ms per run, so
  // its real period is ~work ms and no multiplier of 10ms can slow it down.
  function registerRunaway(h, work, asked) {
    h.sandbox.__antsCost = (ms) => h.busy(ms);
    vm.runInContext(
      `(function chain() { __antsCost(${work}); setTimeout(chain, ${asked}); })();`,
      h.sandbox,
      { filename: "http://localhost:8188/assets/settingStore-DDHzGrHr.js" }
    );
  }

  test("a slow, expensive chain is suggested a cap that makes it cheaper, not a sticker", async () => {
    const h = await boot();
    registerRunaway(h, 300, 10); // ~310ms per run: the real page's shape
    h.advance(3000);
    const r = row(h, "chain");
    assertLess(r.runsPerSec, 4, `it runs fewer than 4 times a second (${fmt(r.runsPerSec)})`);
    assertGreater(r.msPerSec, 30, `but costs real time (${fmt(r.msPerSec)} ms/s)`);
    const costBefore = r.msPerSec;

    const applied = h.tracker.governor.suggest();
    assert(applied.length, `the suggestion engine did something (${JSON.stringify(applied)})`);
    const after = row(h, "chain");
    // The milder 2/s cap bites but would leave a 300ms-per-run chain at ~2/3 of
    // its old cost; the suggestion has to reach for what actually helps.
    assertEqual(after.policy, "hz1", "a 300ms-per-run chain is capped at 1/s, not at a 2/s sticker");
    assertIncludes(applied[0], "after)", "and the suggestion says what it expects the cost to become");

    const before = after.fires;
    h.advance(3000);
    const rate = ((row(h, "chain").fires - before) / 3000) * 1000;
    assertLess(rate, 1.5, `and the chain really did slow down (${fmt(rate)}/s)`);
    assertGreater(rate, 0.4, "without being silenced");
    const costAfter = ((row(h, "chain").ms || 0) / 3000) * 1000;
    assertLess(costAfter, costBefore * 0.8, `and it costs less per second (${fmt(costBefore)} → ${fmt(costAfter)} ms/s)`);
  });

  test("suggesting again does not re-tighten what is already tight enough", async () => {
    const h = await boot();
    registerRunaway(h, 300, 10);
    h.advance(3000);
    h.tracker.governor.suggest();
    assertEqual(row(h, "chain").policy, "hz1", "the first suggestion caps it at 1/s");
    const again = h.tracker.governor.suggest().filter((line) => line.includes("chain"));
    assertEqual(again.length, 0, `a second suggestion leaves the row alone (${JSON.stringify(again)})`);
    assertEqual(row(h, "chain").policy, "hz1", "and its policy is unchanged");
  });

  test("a fast cheap heartbeat still gets the mildest limit that bites it", async () => {
    const h = await boot();
    h.sandbox.__antsCost = (ms) => h.busy(ms);
    vm.runInContext(`setInterval(function beat() { __antsCost(6); }, 20);`, h.sandbox, {
      filename: "http://localhost:8188/extensions/SomePack/js/main.js",
    });
    h.advance(1000);
    h.tracker.governor.suggest();
    assertEqual(row(h, "beat").policy, "half", "half speed is the mildest option for a 20ms heartbeat");
  });

  test("nothing is suggested for sources that cost nothing, and the tracker is never limited", async () => {
    const h = await boot();
    h.sandbox.setInterval(function trivial() {}, 500);
    h.advance(3000);
    assertEqual(h.tracker.governor.suggest().length, 0, "a 500ms no-op heartbeat is left alone");
    for (const r of h.tracker.governor.sources) {
      if (!r.ours) continue;
      assertEqual(r.policy, "full", `${r.name} (the tracker's own) was left alone`);
    }
  });

  test("the autopilot is off by default and caps the worst source when switched on", async () => {
    const h = await boot();
    registerRunaway(h, 60, 10);
    h.sandbox.setInterval(function quietPoll() { h.busy(0.2); }, 40);
    h.advance(1500);
    assertEqual(h.tracker.governor.policy(row(h, "chain").key, "full"), false, "the runaway starts unlimited");
    h.advance(12000);
    assertEqual(h.tracker.governor.metrics.auto.on, false, "the autopilot is off by default");
    assertEqual(row(h, "chain").policy, "full", "and nothing was limited on its own");
    assertEqual(h.tracker.governor.metrics.auto.count, 0);

    h.tracker.governor.control("autoLimit", true);
    h.advance(6000); // one pilot interval, plus room for the row to re-measure
    const autopilotRow = row(h, "chain");
    assert(autopilotRow.policy !== "full", `the pilot limited the worst source (${autopilotRow.policy})`);
    assertEqual(autopilotRow.policy, "hz2", "with a cap that can bite its ~60ms period");
    assertEqual(row(h, "quietPoll").policy, "full", "the cheap heartbeat was left alone");
    const actions = h.tracker.governor.metrics.auto.actions;
    assertGreater(actions.length, 0, "and it recorded what it did");
    assertIncludes(actions[0].label, "settingStore", "naming the source it limited");
    assertGreater(actions[0].gapMs, 100, "with the gap it applied");
    assertGreater(actions[0].predictedMsPerSec, 0, "and what the cap should leave it costing");
    assertEqual(h.tracker.governor.metrics.auto.mine, 1, "the pilot remembers which limits are its own");
  });

  test("the pilot walks its own cap up the ladder while the row is still the worst", async () => {
    const h = await boot();
    registerRunaway(h, 300, 10);
    h.advance(4000);
    h.tracker.governor.control("autoLimit", true);
    h.tracker.governor.control("autoTargetMsPerSec", 100); // below what one cap can reach

    const costBefore = row(h, "chain").msPerSec;
    h.advance(6000);
    const first = h.tracker.governor.metrics.auto.actions;
    assert(first.length, "the pilot acted on the worst row");
    const oldest = first[first.length - 1];
    assertEqual(oldest.to, "hz2", "its first cap is the mildest one that bites");
    assertEqual(oldest.predictedMsPerSec, 600, "which it already knows will not be enough");

    h.advance(12000);
    const later = h.tracker.governor.metrics.auto.actions;
    assertEqual(later[0].to, "hz1", "the next rounds walk the same row up the ladder");
    assertGreater(later[0].gapMs, oldest.gapMs, `each step is a wider gap (${oldest.gapMs}ms → ${later[0].gapMs}ms)`);
    assertEqual(later[0].predictedMsPerSec, 300, "until the row costs what 1/s allows");
    h.advance(3000);
    const now = row(h, "chain").msPerSec;
    assertLess(now, costBefore * 0.6, `and the row really is cheaper (${fmt(costBefore)} → ${fmt(now)} ms/s)`);
    assertEqual(row(h, "chain").policy, "hz1", "1/s is the end of the ladder: it is not tightened further");
    const note = h.tracker.governor.metrics.auto.note;
    assertIncludes(note, "tightest cap", `and the panel says why it stopped (${note})`);
    assertIncludes(note, "fixing at its source", "pointing at the loop instead of pretending it is fixed");
  });

  test("the pilot leaves a limit that was set by hand alone", async () => {
    const h = await boot();
    h.sandbox.__antsCost = (ms) => h.busy(ms);
    vm.runInContext(`setInterval(function mine() { __antsCost(40); }, 50);`, h.sandbox, {
      filename: "http://localhost:8188/extensions/SomePack/js/main.js",
    });
    registerRunaway(h, 120, 10);
    h.advance(2000);
    const mineKey = row(h, "mine").key;
    h.tracker.governor.policy(mineKey, "quarter");
    h.advance(2000);
    h.tracker.governor.control("autoLimit", true);
    h.tracker.governor.control("autoTargetMsPerSec", 60);
    h.advance(20000);
    assertEqual(row(h, "mine").policy, "quarter", "a hand-set limit is never raised by the pilot");
    assert(row(h, "chain").policy !== "full", `while the row nobody has touched does get capped (${row(h, "chain").policy})`);
  });

  test("the autopilot never touches the tracker's own timers or a rAF loop", async () => {
    const h = await boot();
    h.sandbox.__antsCost = (ms) => h.busy(ms);
    vm.runInContext(`(function loop() { __antsCost(40); requestAnimationFrame(loop); })();`, h.sandbox, {
      filename: "http://localhost:8188/extensions/SomePack/js/main.js",
    });
    h.advance(1500);
    h.tracker.governor.control("autoLimit", true);
    h.advance(12000);
    const r = row(h, "loop");
    assertEqual(r.policy, "full", "a rAF loop keeps its own governor and is not capped by the autopilot");
    for (const own of h.tracker.governor.sources) {
      if (own.ours) assertEqual(own.policy, "full", "the tracker's own timers stay exempt");
    }
  });

  test("a limit that cannot bite says so instead of looking like it works", async () => {
    const h = await boot();
    registerRunaway(h, 80, 10);
    h.advance(1200);
    const r = row(h, "chain");
    h.tracker.governor.policy(r.key, "half"); // 33ms against an ~80ms chain: decoration
    h.advance(1200);
    const after = row(h, "chain");
    assertGreater(
      h.tracker.governor.metrics.inert.count,
      0,
      "the row is reported as unaffected by its own limit instead of claiming savings"
    );
    assertGreater(h.tracker.governor.metrics.inert.msPerSec, 20, "with how much it still costs per second");
    assertEqual(after.policy, "half", "the selected limit remains the source's current policy");
    assertIncludes(h.tracker.report, "unaffected by their own limit", "the headless report explains that a too-narrow limit cannot bite");
  });
});

function fmt(n) {
  return Number.isFinite(n) ? n.toFixed(2) : String(n);
}

suite("governor: the display lane", () => {
  test("a source that draws the canvas is on the display lane, and the lane gives way while you drag", async () => {
    const h = await boot();
    let runs = 0;
    h.sandbox.setInterval(function repaintTicker() {
      runs++;
      h.busy(6);
      h.canvas.setDirty(true, true);
      h.canvas.draw(); // a repaint ticker: its ticks are pixels on the screen
    }, 100);
    h.advance(300);
    const first = row(h, "repaintTicker");
    assert(first, "the ticker is registered as a source");
    assert(first.display, "and marked as part of the display lane, because it draws");
    assertGreater(first.drew, 0, "with the draws it made counted");

    // A limit the autopilot would have to refuse: this source is the thing that
    // repaints the page, so a cap below the display rate is a slideshow.
    assert(h.tracker.governor.policy(first.key, "hz1"), "a 1/s limit is applied for the test");
    const idleFrom = runs;
    h.advance(3000);
    const idleRuns = runs - idleFrom;
    assertLess(idleRuns, 8, `while nobody is touching the page the cap holds (${idleRuns} runs in 3s)`);

    // A drag: input arrives every 100ms, as it does while panning. The cap must
    // not be the reason the canvas stops repainting.
    const dragFrom = runs;
    for (let i = 0; i < 20; i++) {
      h.window.fire("pointermove");
      h.advance(100);
    }
    const dragRuns = runs - dragFrom;
    assertGreater(dragRuns, 12, `while dragging, the display lane runs at ~30/s at most, not 1/s (${dragRuns} in 2s)`);
    const lifted = row(h, "repaintTicker").inputLifted;
    assertGreater(lifted, 0, "and the ticks that only ran because of the lift are counted, not guessed");

    // The moment the drag stops, the limit is back.
    const afterFrom = runs;
    h.advance(3000);
    assertLess(runs - afterFrom, 8, "the cap is back as soon as the input stops");
  });

  test("the display lane is never the source the autopilot picks", async () => {
    const h = await boot();
    // Two heavy sources: one draws the canvas, one does not. Only the second is
    // a candidate for a cap.
    h.sandbox.setInterval(function drawingLoop() {
      h.busy(40);
      h.canvas.draw();
    }, 50);
    h.sandbox.setInterval(function busyWork() {
      h.busy(40);
    }, 50);
    h.advance(1500);
    const suggested = h.tracker.governor.suggest();
    assertEqual(row(h, "drawingLoop").display, true, "the drawing loop is display lane");
    assertEqual(row(h, "busyWork").display, false, "the other one is not");
    assert(
      suggested.every((s) => !s.includes("drawingLoop")),
      `no cap is offered for the thing that repaints the page (${JSON.stringify(suggested)})`
    );
    assertGreater(row(h, "busyWork").msPerSec, 100, "the non-drawing source is expensive enough to be suggested");
  });

  test("a source whose expensive runs fall outside the window is still ranked by what it really costs", async () => {
    const h = await boot();
    h.sandbox.setInterval(function heavyScan() {
      h.busy(120);
    }, 700);
    h.advance(1400); // two runs, so the mean run cost is real
    const r = row(h, "heavyScan");
    assertGreater(r.perRunMs, 100, `the run cost is measured (${r.perRunMs.toFixed(0)}ms)`);
    assertGreater(r.pressureMsPerSec, r.msPerSec * 0.9, "and the per-rate figure is at least what the window saw");
    assertGreater(r.pressureMsPerSec, 100, `≈120ms/run at 1.4/s is ≈170ms/s (${r.pressureMsPerSec.toFixed(0)})`);
  });
});
