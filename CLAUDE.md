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
| `web/tracker.js` | The whole frontend: instrumentation, the scheduler layer, the low-zoom/viewport rules, the panel. ~12k lines, one ES module, `import { app } from "/scripts/app.js"`. |
| `web/window.html` | The separate window at `/ants_optimizer/window`: its own page (no canvas script), talking to the ComfyUI page through `/ants_optimizer/ui`. |
| `__init__.py` | The node class (does nothing, never executes) and nine best-effort routes: `GET /ants_tracker/gpu`, the five `/ants_optimizer/thumbs/*` routes, `/ants_optimizer/window` and `/ants_optimizer/ui`. |
| `tests/` | Zero-dependency test suite + a synthetic-browser harness + a demo. No npm, no jsdom, no browser. |
| `tools/pill-preview.mjs` | Renders the pill into `preview/` straight from the real CSS and glyph builders. |
| `tools/box-preview.mjs` | Renders the flat boxes at each `boxDetail` level into `preview/` by recording the real paint ops (`lodPaintNode`) and replaying them as SVG. |
| `preview/` | Generated. Never hand-edit; regenerate. |
| `README.md` | User-facing docs: install, use, every setting with its ladder and default, the tabs, the limits, credits. |
| `CHANGELOG.md` | Version history. Every release adds a "What changed in vX.Y.Z" section **at the top**. |
| `ANALYSIS.md` | What works, what failed and was fixed, and which ideas were retired; keep it honest and dated. |
| `LICENSE` / `THIRD_PARTY_NOTICES.md` | This project's MIT licence, and the upstream notices carried with the ported ideas (the NodeSnapshots notice verbatim; no other code is copied). |
| `REVIEW.md` | The v1 defect review with line references and the v2 fix for each. Read it before touching attribution or muting. |

## Commands

```bash
node tests/run-tests.mjs              # all 220 tests — must be green before any commit
node tests/run-tests.mjs <substring>  # one suite/test, e.g. ... pill
python3 tests/test_init.py            # the Python side (route parsing, node contract)
node tests/demo.mjs                   # prints what the panel says against a synthetic graph
node tools/pill-preview.mjs > preview/pill.html   # regenerate the pill page (exit != 0 if it drifts)
node tools/box-preview.mjs > preview/boxes.html   # flat boxes at each boxDetail level, from the real paint path
                                                  # (box previews show the flat paint, not snapshots: a capture's
                                                  #  bitmap has no pixels in the harness)
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
| `--- low-zoom drawing` | `LOD`, every predicate (`lodOn`, `lodFlatOn`, …), the DOM registry/sweep, link ink, and the retired-ladder tombstone (`LOD.thumbZoom = 0` — do not restore it). |
| `--- node snapshots` | The bitmap engine: signature, the keep-live set and every reason a node stays a box (with its name in the readout), size fitting and the ink probe, the capture into an offscreen canvas, the idle-lane pump, the budget (coarse-before-refused), and the reuse path called from the `drawNode` wrapper. Reads `LOD_SNAP_*` and the block comment above them first. |
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
9. **Docs**: a `CHANGELOG.md` entry, the README if a user-facing setting or
   number changed, and `memory.md` if it involved a decision.

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
- `h.enterVueNodes()` — switches the page to the Nodes 2.0 (Vue nodes) renderer
  for the rest of the test: the flag goes on `h.LiteGraph.vueNodesMode` (the same
  object the frontend writes), `drawNode()` early-returns, and each node gets a
  `.lg-node[data-node-id]` root plus the `.dom-widget` wrappers of any widget that
  was added with `addDOMWidget`, positioned in client pixels like
  `DomWidgets.vue` does it. Returns `{container, roots, wrappers, place(),
  rootFor(node), exit()}`; `exit()` puts the canvas renderer back on the same
  page. The fixture's shapes come from the upstream files listed in
  `ANALYSIS.md` — change it there first if it ever drifts.
- In that renderer the stand-in is the **blanking pathway**: below the threshold
  the node's own root element gets `LOD_VUE_ATTR` (`data-ants-vue-standin`, an
  `!important` `opacity: 0` rule) and `lodPaintNode` paints the same box the canvas
  renderer paints; `lodVueFramePlan` hands every element back when the setting,
  the zoom, the tool or the renderer changes, and a box is only painted after a
  *successful* marking (`lodVueBlank`). **The mark is `visibility`, not
  `opacity`** (v2.6.6, and this is the whole point of the pathway): the attribute
  carries `[data-ants-vue-standin] { opacity: 0 !important }` *and*
  `[data-ants-vue-standin] > * { visibility: hidden !important }`. An engine skips
  a hidden subtree in the paint phase, which is the only saving available in a
  renderer whose node drawing is the browser's own DOM painting; an opacity-0
  subtree is still painted (that is what v2.6.0–v2.6.5 shipped, and why the
  stand-ins could cost performance here). The element's own box stays visible and
  therefore hit-testable — selecting and dragging a node are bound on the root — so
  the *children* are hidden, never the root, and the layout is untouched: rects,
  text metrics and both observers still answer, which is where every number the
  box and the picture are made of comes from. Trade, stated in README/`LIMITS`:
  a widget inside a stand-in no longer takes its own clicks at that zoom, and the
  node's accessibility entry is that of a hidden subtree. **Never a class**: `LGraphNode.vue` binds
  `:class` on that element and Vue rewrites it on every re-render, so a class is
  dropped and the node comes back visible behind its box — that was the v2.6.3 bug,
  and the harness was blind to it until `exit()` started detaching the pane and the
  shim started reporting `isConnected` truthfully. The fovea's hide/inert marks on
  a node's own element are attributes too (`LOD_DOM_ATTR`, `LOD_DOM_INERT_ATTR`);
  only widget wrappers, which Vue does not own, still use classes. The readout/API
  name it: `lowZoom.snapshots.pathway` / `.bitmaps` / `.vuePaintSkipped` /
  `.vueBlanked` / `.vueBoxes` /
  `.vueRestored` / `.vueUnreached`. A test in that mode asserts the attribute, the
  box ink, the re-render survival and the hand-back; the harness shim supports tag
  selectors and `querySelector` for the nested-`<video>` and wrapper-`<img>` cases.
- `lodVueBoxContent` gives a Vue box the node's own content when the stand-in is
  *picture of the node*, from the two routes content takes to the page:
  `lodSnapDomInk` for widget-borne elements (textarea values re-painted, img and
  canvas blitted), `lodVueRootMetrics` for what the node renders itself
  (`img`/`canvas` children of the node's element, drawn at their laid-out
  position — `(childRect - rootRect)/zoom` in graph units, minus the title bar)
  `lodVueChromeBoxes`/`lodVueChromeInk` for its **structure** (v2.6.6: the
  element's own box, the header bar (`node-header-<id>`), the body panel
  (`node-body-<id>`) and every `.slot-dot`, each from its own rect and the
  background colour the browser computed, drawn biggest-first and rounded; a node
  with no header has none — a picture of the text and media alone had no surface
  under it, which is the "semi, not fully there" the user reported),
  and `lodVueTextLines`/`lodVueTextInk` for its **text** (v2.6.4: every leaf string
  with its laid-out box and computed font/colour, at most `LOD_VUE_TEXT_MAX` lines
  of `LOD_VUE_TEXT_CHARS` characters, each clipped to its own box — a picture of a
  Vue node without its labels read as a box). `lodVueContentInk` is the one place
  the live box and the capture both draw from, so they cannot drift apart.
  `lodPaintNode` takes optional `content` / `detailOverride` / `sizeOverride` and
  clips content to the node's box **and its title bar** (a DOM node's title is
  content like any other, and a clip on the body alone cut it off the picture);
  the canvas renderer passes none of them. Gauges: `lowZoom.snapshots.vueContent`
  / `.vueMedia` / `.vueText` / `.vueChrome` / `.vueChromeBoxes`.
  Three things here are load-bearing, learned the hard way in v2.6.3:
  (1) **the box is `lodVueBoxSize`** — the element's measured box, not `node.size`
  (`LGraphNode.vue` renders image nodes `IMAGE_PREVIEW_HEIGHT_RESERVE` = 232 px
  taller than their graph size and puts the picture in the overhang);
  (2) **the zoom is measured, in one order** (`lodVueDomScale`): the transform
  pane's own computed matrix first (one matrix for the whole graph, written by
  `useTransformState.ts` — m11 is the zoom), then `[data-testid=node-inner-wrapper]`
  (the element that carries the node's declared width — the root has only
  `min-width`, so its own width is whatever its content needs), then the root, and
  `canvas.ds.scale` only when nothing about the DOM can be read. That last one is
  why this matters: a capture sets it to 1 while the DOM keeps its transform, and
  dividing client pixels by the wrong zoom puts the content outside its box. The
  readout names the answer: `lowZoom.snapshots.vueScale` / `.vueScaleFrom`;
  (3) **the cache key is the node's own size only** — every stored number is
  node-local, so a pan or a zoom must cost *no* layout read (a key that included
  them meant one forced layout per boxed node per frame while the user dragged),
  and the refresh is rationed by `LOD_VUE_MEDIA_BUDGET` per frame. **The refresh
  is not a poll** (v2.6.5): `lodVueWatch` puts a `ResizeObserver` on the node's
  element and the elements inside it and a `MutationObserver` over its children
  and text, and a report deletes that node's measurement
  (`lodVueStaleNode`), so the next frame re-takes it; attributes are deliberately
  not observed (Vue rewrites `style`/`class` on hover, selection and every pane
  gesture), a watched node keeps a 5 s insurance read
  (`LOD_VUE_MEDIA_MS_WATCHED`), and a page without the observers keeps the 400/
  800 ms beat. Keep it that way: a `setAttribute` with the value the element
  already has is not free (Blink/WebKit run the attribute-changed path), the
  video verdict must stay cached (`LOD.snapVideo`; 30 s watched / 100 ms
  unwatched, and a capture probes fresh), and the steady state must cost the page
  nothing — three tests assert exactly zero writes, reads, queries and probes per
  frame at any node count.
  (4) **a capture waits for the node to stand still** (v2.6.6): `LOD_SNAP_SETTLE_MS`
  (300 ms) is a window opened when a node is first drawn as a stand-in and
  re-opened by every reported change or signature mismatch (`lodVueChanged`), and
  `lodVueSettleLeft` is the gate in the capture lane — `lodSnapTake` skips a node
  inside its window and the slice is scheduled for the moment it opens (never
  polled). The frontend mounts a node and fills it over the following passes
  (slots sync, layout, widgets, media decoding), so "capture immediately" is a
  picture of a half-built node. Canvas pathway: no window (its drawing is
  synchronous with the frame). Gauges: `vueSettleMs` / `.vueSettleArms` /
  `.vueSettleHeld`.
  (5) **a capture takes one measurement.** `lodVueRootMetrics(node, canvas, true)`
  → `lodSnapGeometry(node, canvas, dom.boxH)` → surface, box and ink from the same
  number, and the signature mixes that height, the text lines and the measured
  widget boxes (`lodVueWidgetBoxes`), so a picture is dropped and re-made when the
  node finishes rendering instead of being kept from the first look. Widget
  content is drawn where the browser laid the element out when the frontend has
  mounted it inside the node's own element (`WidgetDOM.vue`), and at the canvas
  row only when there is no such element.
  Elements the widget route drew are skipped, so nothing is drawn twice.
  **The plan and the draw loop ask one predicate** (`lodVuePathOn`): if the plan
  ever asks a *narrower* question than the draw loop — as it did while it required
  `LOD.snapOn` — it hands every blanked element back at the top of every frame
  while the draw loop blanks it again, and the user sees the whole canvas flicker
  (v2.6.4). A box is a stand-in; the picture setting decides what the box is made
  of, not whether anything stands in. **A capture with no element on the page is
  refused** (`vueNoElement`), because a bare box stored under the node's key is
  served to every later frame as if it were the node. **The pathway is part of a
  picture**: it is mixed into the signature and appended to the disk key
  (`lodSnapPathwayToken`, `…<pc|pv>`), so neither renderer is ever served the
  other's picture — RAM or file. If you touch this, keep it that way: a photograph
  of a DOM element is impossible (no browser API), and the harness shim supports
  `el._rect`, `h.rectReads`, `getComputedStyle` (display/pointer-events/transform
  matrix/font/colour — and, since v2.6.6, the box colours a stand-in reads:
  `backgroundColor`, `borderTopWidth`, `borderTopColor`, `borderTopLeftRadius`),
  `vue.growRoot()` for testing layout and `vue.addStructure(node, {title, inputs})`
  (v2.6.6) for the frontend's own node structure — surface, header, body panel and
  one row + dot per input, laid out in element-local units the way `LGraphNode.vue`
  lays it out, so the reader and the ink are pinned against the real shape. v2.6.5 added the
  two observers to the sandbox (on by default — a browser has them; a test can
  call `h.setDomObservers(false)` to exercise the timer fallback) with
  `withQuiet` so the fixture's own pan/zoom layout is not mistaken for a box
  change, `fireResize` for the changes a test makes by hand, and `h.ops` carries
  `attrWriteBy` so a test can hold the tool to "the mark is written once".

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
4. `CHANGELOG.md`: a new `## What changed in vX.Y.Z` section directly above the
   previous one, written as "the problem, then what changed, then what it cost";
   keep the test count in the README's Development block current.
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
