// Detached optimizer UI and headless in-page controls.
// The ComfyUI document must retain only the switch and detached-window gear;
// all settings, metrics, and diagnostics belong to web/window.html.

import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { createHarness } from "./harness.mjs";
import { suite, test, assert, assertEqual, assertGreater, assertIncludes } from "./framework.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const WINDOW_HTML = path.join(ROOT, "web", "window.html");

async function boot(options) {
  const h = createHarness(options);
  for (const ext of h.app.extensions) if (ext.setup) await ext.setup();
  await h.flush();
  return h;
}

function noInlinePanel(h, message) {
  assertEqual(h.panel(), null, message || "the retired in-page panel is never constructed");
  assertEqual(h.document.getElementById("ants-tracker-tabs"), null, "there is no in-page tab bar");
  assertEqual(h.document.getElementById("ants-tracker-body"), null, "there is no hidden in-page settings body");
}

suite("detached optimizer UI", () => {
  test("startup leaves only the floating switch and detached-window gear", async () => {
    const h = await boot();
    const pill = h.document.getElementById("ants-corner-pill");
    assert(pill, "the headless floating control is available immediately");
    assert(pill._cls.has("ants-own"), "the optimizer control is protected from its own drawing gates");
    const buttons = pill.children.filter((n) => n.tagName === "BUTTON");
    assertEqual(buttons.length, 2, "only the power switch and gear are shown in-page");
    assert(buttons[0]._cls.has("ants-node-btn-tick"), "the first control is the power switch");
    assert(buttons[1]._cls.has("ants-node-btn-gear"), "the second control launches the detached window");
    noInlinePanel(h);
  });

  test("a blocked detached-window launch is visible and never falls back to an in-page panel", async () => {
    const h = await boot(); // window.open is unavailable in this harness
    const gear = h.document.getElementById("ants-corner-btn");
    assert(gear, "gear exists");
    gear.click();
    assert(gear._cls.has("ants-window-blocked"), "the gear gets a visible blocked marker");
    assertIncludes(gear.title, "detached optimizer window was blocked", "the tooltip gives a useful failure reason");
    assert(gear.textContent.includes("!") === false, "the gear glyph remains intact; the warning badge is CSS-drawn");
    noInlinePanel(h, "a blocked launch does not create or open a fallback panel");
    assert(h.warnings().some((w) => w.includes("detached optimizer window was blocked")), "the failure is also logged for shell diagnostics");
  });

  test("the gear opens and focuses a real detached route, and close does not reveal a panel", async () => {
    const h = await boot({ openWindow: true });
    const gear = h.document.getElementById("ants-corner-btn");
    gear.click();
    assertEqual(h.openedWindows.length, 1, "one child window is opened");
    assertEqual(h.openedWindows[0].url, "/ants_optimizer/window", "the detached UI uses the extension route");
    assertEqual(h.openedWindows[0].name, "ants-optimizer", "a stable name allows focusing the existing window");
    assertIncludes(h.openedWindows[0].features, "resizable=yes", "the detached surface is resizable");
    gear.click();
    assertEqual(h.openedWindows.length, 1, "a second click focuses instead of duplicating the UI");
    assert(h.openedWindows[0].focused, "the existing detached window is brought forward");
    assertEqual(h.tracker.close(), true, "the explicit close API closes the child");
    assertEqual(h.openedWindows[0].closed, true);
    noInlinePanel(h);
  });

  test("the optimizer node stays headless and no longer docks settings into its body", async () => {
    const h = await boot({ openWindow: true });
    const NodeType = h.registerNodeType("ANTsNastyBastardsTracker");
    const node = h.makeNode(NodeType);
    node.size = [480, 320];
    node.onNodeCreated();
    assertEqual(node.resizable, true, "the existing workflow node remains resizable");
    assert(!node._antsHost, "no hidden settings host is attached to the graph node");
    const controls = (node._domWidgets || []).filter((w) => w.name === "ants_controls");
    assertEqual(controls.length, 1, "the node carries one compact control widget");
    const buttons = controls[0].element.children.filter((n) => n.tagName === "BUTTON");
    assertEqual(buttons.length, 2, "the node has only power and gear controls");
    assert(buttons[0]._cls.has("ants-node-btn-tick"));
    assert(buttons[1]._cls.has("ants-node-btn-gear"));
    node.size = [700, 500];
    const computed = node.computeSize();
    assert(computed[0] >= node.size[0] && computed[1] >= node.size[1], "the workflow node's size floor never shrinks a user-set size");
    const out = [0, 0];
    assertEqual(node.computeSize(out), out, "the supported computeSize output parameter is reused");
    assertEqual(out[0], computed[0]);
    assertEqual(out[1], computed[1]);
    noInlinePanel(h, "resizing the optimizer node cannot dock or construct a panel");
  });

  test("a remote detached-window settings revision updates the page without applying its own echo", async () => {
    const h = await boot();
    h.tracker.link.apply({
      ok: true,
      rev: 1,
      origin: "window",
      settings: {
        flatBelow: 0.2,
        snapshots: false,
        boxDetail: "title",
        drawThrottleMs: 33,
        syntheticTickMs: 0,
        governor: { controls: { coalesce: true, autoLimit: false }, policies: {} },
      },
    });
    assertEqual(h.tracker.lowZoom.state.flatBelow, 0.2, "drawing settings are applied");
    assertEqual(h.tracker.lowZoom.state.snapOn, false);
    assertEqual(h.tracker.lowZoom.state.boxDetail, "title");
    assertEqual(h.tracker.snapshot.settings.capMs, 33, "Testing controls are applied on the ComfyUI page");
    assertEqual(h.tracker.governor.metrics.controls.coalesce, true, "Governor controls are applied");
    h.tracker.link.apply({ ok: true, rev: 2, origin: "page", settings: { flatBelow: 0.5 } });
    assertEqual(h.tracker.lowZoom.state.flatBelow, 0.2, "a page-origin echo is not reapplied as a user change");
  });

  test("closing the detached window stops temporary testing modes", async () => {
    const h = await boot({ openWindow: true });
    assertEqual(h.tracker.open(), true, "the detached window opens");
    h.tracker.link.apply({
      ok: true,
      rev: 1,
      origin: "window",
      settings: Object.assign({}, h.tracker.link.settings(), { drawThrottleMs: 33, syntheticTickMs: 100 }),
    });
    assertEqual(h.tracker.snapshot.settings.capMs, 33);
    assertEqual(h.tracker.snapshot.settings.synthTickMs, 100);
    assertEqual(h.tracker.close(), true);
    assertEqual(h.tracker.snapshot.settings.capMs, 0, "the session-only draw cap is reset");
    assertEqual(h.tracker.snapshot.settings.synthTickMs, 0, "forced synthetic redraws stop on close");
    noInlinePanel(h);
  });

  test("master-off suspends testing and Governor effects, and cancels a running pan", async () => {
    const h = await boot();
    h.tracker.setSyntheticTick(50);
    h.tracker.benchmark(1000, "A");
    assert(h.tracker.snapshot.testing.benchActive, "the scripted pan starts while enabled");
    h.tracker.lowZoom.setEnabled(false);
    const dirtyAtOff = h.canvas.dirtyCalls;
    assertEqual(h.tracker.snapshot.testing.benchActive, null, "master-off cancels and restores the benchmark viewport");
    h.advance(200);
    assertEqual(h.canvas.dirtyCalls, dirtyAtOff, "the synthetic redraw timer is stopped while off");
    assertEqual(h.tracker.snapshot.settings.synthTickMs, 50, "the selected interval remains visible, but is suspended");
    h.tracker.lowZoom.setEnabled(true);
    h.advance(100);
    assertGreater(h.canvas.dirtyCalls, dirtyAtOff, "turning the optimizer on resumes the selected testing mode");
    noInlinePanel(h);
  });

  test("the detached page owns all migrated tabs and its inline script parses", async () => {
    const html = fs.readFileSync(WINDOW_HTML, "utf8");
    assertIncludes(html, 'id="ants-window"', "the detached window is a standalone page");
    assertIncludes(html, "/ants_optimizer/ui", "page settings and telemetry use the bridge");
    assert(!html.includes("window.opener"), "the detached window does not inspect the canvas document");
    assert(!html.includes("tracker.js"), "the detached window does not load the ComfyUI canvas tracker");
    for (const tab of ["governor", "load", "memory", "gpu", "testing"]) {
      assertIncludes(html, `data-tab="${tab}"`, `${tab} moved to the detached UI`);
      assertIncludes(html, `id="pane-${tab}"`, `${tab} has a detached pane`);
    }
    for (const command of ["governor-reset", "governor-suggest", "governor-off", "worker-self-test", "benchmark", "memory-baseline", "unmute-all"]) {
      assertIncludes(html, command, `${command} action is available in the detached UI`);
    }
    assertIncludes(html, 'id="close"', "the detached window has a close control");
    assert(!html.includes("in-page panel opens instead"), "blocked-window copy no longer promises an in-page fallback");
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
    assertEqual(scripts.length, 1, "the detached UI has one inline controller");
    new vm.Script(scripts[0], { filename: "web/window.html inline script" });
  });
});
