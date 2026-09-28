# CLAUDE.md — working on ANTs Nasty Bastards Tracker

A ComfyUI frontend extension that answers "which extension is costing me FPS while
panning this graph?" — measured from inside the page, with no DevTools and no
restart. One hand-written file does nearly all of it.

This file is the operating manual for anyone (human or agent) about to change the
code. `memory.md` is the history and the decisions behind it; `plan.md` is where
this is going. Read the golden rules before the code.

## Layout

| Path | What it is |
| --- | --- |
| `web/tracker.js` | The whole frontend: instrumentation, the scheduler layer, the low-zoom/viewport rules, the panel. ~9.5k lines, one ES module, `import { app } from "/scripts/app.js"`. |
| `__init__.py` | The node class (does nothing, never executes) and one optional read-only route `GET /ants_tracker/gpu`. |
| `tests/` | Zero-dependency test suite + a synthetic-browser harness + a demo. No npm, no jsdom, no browser. |
| `tools/pill-preview.mjs` | Renders the pill into `preview/` straight from the real CSS and glyph builders. |
| `tools/box-preview.mjs` | Renders the flat boxes at each `boxDetail` level into `preview/` by recording the real paint ops (`lodPaintNode`) and replaying them as SVG. |
| `preview/` | Generated. Never hand-edit; regenerate. |
| `README.md` | User-facing docs. Every release adds a "What changed in vX.Y.Z" section **at the top of the changelog**. |
| `REVIEW.md` | The v1 defect review with line references and the v2 fix for each. Read it before touching attribution or muting. |

## Commands

```bash
node tests/run-tests.mjs              # all tests — must be green before any commit
node tests/run-tests.mjs <substring>  # one suite/test, e.g. ... pill
python3 tests/test_init.py            # the Python side (route parsing, node contract)
node tests/demo.mjs                   # prints what the panel says against a synthetic graph
node tools/pill-preview.mjs > preview/pill.html   # regenerate the pill page (exit != 0 if it drifts)
node tools/box-preview.mjs > preview/boxes.html   # flat boxes at each boxDetail level, from the real paint path
node tools/box-preview.mjs --svg > preview/boxes.svg   # the same picture as SVG, for a PNG render (resvg + Pillow, optional)
```

There is no build step, no bundler, no dependency to install, and none may be
added: the extension ships by being copied into `ComfyUI/custom_nodes/`.

## Golden rules

These are not style preferences. Each one exists because breaking it produced a
bug that was reported by a user, and most have a regression test.

1. **One canvas redraw = one unit of work.** Every cost is `ms/frame`, `% of
   frame`, `ms/call` or a wall-clock rate. Never sum over an arbitrary window —
   that made v1's numbers move 4× with pan speed.
2. **A hook's time counts toward a frame only if it ran inside `canvas.draw()`.**
   Time in the same hook outside a frame goes to the off-frame column. Never let
   attributed exceed frame.
3. **Buckets are never deleted while a wrapped function points at them.** v1
   deleted quiet buckets, which made extensions vanish permanently and mutes
   impossible to undo.
4. **A muted owner always gets a row**, even at zero activity, with a way to
   unmute. A mute must never become invisible.
5. **`normal` is a strict no-op.** A source on the default policy gets the same
   call, the same arguments, the same ids from the platform functions.
6. **A setting changes only its own subject.** Node flattening is a *zoom*, never
   a pixel size; link settings touch links and nothing else; the fovea touches
   off-screen elements. Two settings must not interact through a side effect.
7. **Opt-in, remembered, reversible, fail-open.** Off by default; stored in
   `localStorage`; switching it off restores exactly the previous page; if a patch
   cannot be installed, say so and carry on rather than half-applying.
8. **Never invent a number.** If the page cannot measure it (GPU time, VRAM per
   extension, Firefox's `performance.memory`), the panel says so. The LIMITS
   block at the bottom of `tracker.js` is the canonical list — update it when you
   add a limitation.
9. **Never take away the user's way back.** The tool's own UI (`.ants-own`: the
   floating pill, the node's pill, the panel) is exempt from every sweep, gate and
   hover rule. It is never hidden by a setting, and never hidden by the master
   switch. The master switch hands back the *page*, not the controls.
10. **Read-only, except where the user asked for an effect.** Mute, the governor
    policies, the redraw cap and the drawing settings are explicit policies. No
    code path may silently change what ComfyUI draws or when.
11. **Panning is the case that matters.** A change that helps a static graph and
    costs anything while panning is a regression.
12. **Measure before claiming.** A new optimisation needs a number from the A/B
    harness (scripted pan, or `lowZoom.measureLinks`), on a graph that is actually
    slow. "It should be faster" is not a result.

## Architecture map of `web/tracker.js`

Read in this order to understand the file:

| Section (search for) | What lives there |
| --- | --- |
| `--- utils` / `--- ring buffer` | `Ring` series, percentiles, `nowMs`, DOM helper `el()`. |
| `--- shared state` | `S`: hooks, nodes, series, counters, mutes, `enabled`. |
| `--- 1. wrap extension registration` | The interceptor for `app.registerExtension` that wraps every other extension's `nodeCreated`/hook installs. |
| `--- 2. catch hooks never routed through beforeRegisterNodeDef` | Pre-existing prototypes and per-instance hooks. |
| `--- 3. canvas-level patches` | `draw` frame total, per-node-type cost, the three draw stages. |
| `--- low-zoom drawing` | `LOD`, every predicate (`lodOn`, `lodFlatOn`, …), the DOM registry/sweep, preview ladder, link ink. |
| `--- previews` | The thumbnail ladder (`LOD.thumbs`, a WeakMap per source; `createImageBitmap` with a canvas fallback). |
| `--- DOM boxes` | `view*`: the widget gate, the node-DOM registry, the event gate, fovea. |
| `--- the event gate` | `LOD.blockSet` and the document-capture listener. |
| `--- the node UI` | The pill: glyphs, `buildAntsNodeWidget`, `antsBuildTick`. |
| `--- the master switch` | `antsSetEnabled`, `antsReleasePage`, `antsSyncWidgets`, `ANTS_OWN_CLASS`, own-DOM helpers. |
| `--- the canvas widgets` | `getWidgetOnPos` gate. |
| `--- node hover hooks` | `onMouseEnter`/`onMouseMove` wrapping and forced leave. |
| `--- 4..6` | Invalidation caller sampling, long-stall observer, rAF cadence + memory sampler. |
| `--- install` | `setup()`: order matters — registration patch, then canvas patches, gates, panel. |
| `--- dispatch` | The governor's policy engine for timer/rAF callbacks. |
| `--- policies` | `govSetPolicy`, `govSuggest`, the autopilot ladder. |
| `--- metrics` / `--- frame traces` | What the panel reads. |
| `--- worker` | `GOV_WORKER_SRC`, the off-thread lane (`echo`, `sum`, `selftest`, `run`). |
| `--- panel` … `--- Governor tab` | The panel: summary bar, tabs, tables, controls. |
| `--- lifecycle` | Startup, sweep timers, refresh loop. |
| `--- corner button` | The floating pill (build, drag, persistence). |
| `--- snapshot & report` | The copyable report and the debug API. |
| `--- patch + register` | `patchRegisterExtension()` and the extension registration itself. |
| `--- LIMITS` | The honest list of what cannot be measured. |

**State objects.** `S` (measurements), `LOD` (drawing settings + what they did),
`GOV` (scheduler layer), `ui` (panel), `VIEW_*` constants (the settings matrix:
zooms, margins, scales, focus modes).

**The predicate layer.** Every drawing decision goes through a predicate that
starts with `if (!S.enabled) return false`. That is why the master switch is one
flag and not a hunt for call sites. When you add a decision, add it to a
predicate, not inline in a hot path.

## Adding a setting, end to end

1. **State**: a field on `LOD` (or `GOV.controls`) with a default that means *off*.
2. **Predicate**: a function that answers the question for the canvas on screen
   (`lodZoomOf(canvas)`, not the last frame's recorded zoom).
3. **Hot path**: consume the predicate; count what you did in a counter
   (`LOD.something`).
4. **Set/load/save**: accept it in `lodSet`, include it in the saved record
   (`LOD_STORE_KEY`), read it back in the loader with a sane fallback.
5. **Panel**: a control in the Tweaks tab, next to the other settings it belongs
   with, with a tooltip that says what it changes and what it does not.
6. **Readout**: a counter in the panel line for that feature group, so a user can
   see whether it ever fired.
7. **API**: expose it under `window.__antsTracker.lowZoom` (`state`, `limits`,
   `set`) so tests and scripts do not reach into internals.
8. **Tests**: one that the default changes nothing, one that switching it on
   changes exactly its own subject, one that switching it off restores.
9. **README**: the changelog section, and `memory.md` if it involved a decision.

## Testing

The suite runs `web/tracker.js` **unmodified** in Node against a fake browser and
a fake ComfyUI (`tests/harness.mjs`), with a clock you control (`h.advance(ms)`).
`FRAME_MS = 1000/60`.

Seams worth knowing:

- `h.registerExtension(name, setup)` / `h.registerNodeType(name, protoHooks)` /
  `h.makeNode(type)` — a registered type is a `FakeLGraphNode`, so it has
  `widgets`, `getWidgetOnPos`, the mouse hooks, `addWidget` and `addDOMWidget`.
- `h.node({pos, size, widgets})` — a bare node with the same seams.
- `h.canvas.hover(x, y)` — what the canvas does on mousemove: hit-test, enter
  hook, move hook, report the widget under the cursor.
- `h.canvas.draw()` — one drawn frame; the sweep and the per-draw passes run
  inside it. Each test file defines its own small `drawLoop(h, seconds)` helper
  for repeated frames.
- `h.document` — a shim with `querySelectorAll` (attribute + class selectors),
  real capture/bubble event propagation with `stopPropagation`, `getBoundingClientRect`.
  It has `createElementNS` (the pill's SVG needs it) but **no `innerHTML`
  parsing** — assert classes, `aria-checked` and titles, not glyph contents.
- `h.tracker` — the debug API; `h.tracker.lowZoom`, `h.tracker.governor`,
  `h.tracker.totals`, `h.tracker._state`, `h.tracker._panel`.
- `h.infos()/warnings()/errors()` — console capture. `errors()` must be empty in
  a passing test.

Rules for tests:

- Assert **behaviour on the page**, not implementation details: what the panel
  says, what a click does, what the canvas drew, what the DOM wears.
- Every "off" test needs a witness that the same code path *does* something when
  on; otherwise it passes for the wrong reason.
- Prefer a real seam (`getWidgetOnPos`, `_fire("click")`, `canvas.draw()`) over
  calling internals by name.
- Time-dependent tests advance the clock; never `setTimeout` in a test.

## Gotchas that have already cost time

- **`node --check web/tracker.js` is a lie.** The file is an ES module; `--check`
  on a `.js` file parses it as CommonJS, hits the `import`, and reports success no
  matter what follows. Always verify with a copy:
  `cp web/tracker.js /tmp/x.mjs && node --check /tmp/x.mjs`. This has hidden a
  syntax error that shipped into a release attempt exactly once.
- **Whole-function replacements can duplicate the function.** A patch that inserts
  a function before an anchor can leave two copies when a previous patch already
  inserted one; the second (later) definition silently wins. After editing, run
  `grep -n "^function " web/tracker.js | sed 's/.*function //;s/(.*//' | sort | uniq -d`
  and expect no output.
- **Anchors must be unique.** Prefer anchors that include a line only the new code
  has; check the count in the patch script and fail loudly if it is not 1.
- **The panel repaints on a timer** (`UI_REFRESH_MS = 500`, backed off when a
  render costs more). Rows are keyed and updated in place; never rebuild by
  `innerHTML` — scroll position and expanded rows must survive.
- **The demo builds before it attaches**: create the node, then push it into
  `canvas.nodes` and `canvas.graph._nodes`, or the sweep and the hit-test will not
  see it.
- **Tests must not depend on wall time**: `h.advance()` only moves the fake clock;
  a merged or capped redraw is not a drawn frame unless something draws.
- **Patch the prototype, not the instance**, when the frontend may recreate the
  object — but note that per-instance hooks exist (see `maybeWrapInstanceHooks`
  and `scanRegisteredTypes`) and must keep working.
- **The pill's geometry is one unit = one pixel** (`ANTS_GLYPH_BOX = 22`, viewBox
  `0 0 22 22`, `box-sizing: border-box`, ring centre line `r = 10.25`). Change one
  of those numbers and you have to change the others; `tools/pill-preview.mjs`
  renders the result so you can look at it rather than reason about it.

## Release checklist

1. `node tests/run-tests.mjs` green; `python3 tests/test_init.py` OK;
   `node tests/demo.mjs` exit 0.
2. `cp web/tracker.js /tmp/x.mjs && node --check /tmp/x.mjs`.
3. Bump `VERSION` in `web/tracker.js` (the panel, the report and the snapshot all
   read it from there).
4. README: a new `## What changed in vX.Y.Z` section directly above the previous
   one, written as "the problem, then what changed, then what it cost", plus the
   test count in the Development block.
5. `memory.md`: append to the version log; add any decision worth not re-litigating.
6. `node tools/pill-preview.mjs > preview/pill.html` if any pill CSS, glyph or
   control changed.
7. Commit message: the version, the one-line change, then the why and the checks.
8. Push to the branch and comment on the PR with the numbers (tests, demo, and any
   measurement that justifies the change).

## Environment notes

- The user runs Windows, display scale 200%, CPU-only target (no GPU
  attribution), and works on very large graphs (~1000 nodes). Any pixel maths must
  be done in CSS pixels; the display-scale probe reports what the frontend's
  rectangle is actually in.
- In this sandbox the branch ref can be reset behind the working tree between
  turns: `git fetch origin <branch>:refs/remotes/origin/<branch> -f` then
  `git reset --mixed origin/<branch>`. The working tree is the source of truth;
  origin holds the pushed history.
