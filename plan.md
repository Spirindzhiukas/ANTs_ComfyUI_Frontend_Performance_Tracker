# plan.md — where this goes next

The measuring is done and the acting has started. The tool now knows which
extension is burning frames, what a mute would be worth, and how to make a
1000-node graph draw cheaper without lying about it. What is missing is the
*integration* layer: making those findings portable, verifiable on the user's own
machine, attributable per pack, and available to other extensions without them
having to be recompiled into this one.

Every item below says what exists, the first step, the risk, and how it would be
verified. Sizes are rough: **S** ≈ an afternoon, **M** ≈ a day or two, **L** ≈ a
week of careful work with tests.

Ground rules for anything added: the golden rules in `CLAUDE.md` (units, opt-in,
reversible, fail-open, never invent a number, never take away the way back), plus:
**no new dependencies**, **nothing that changes what ComfyUI draws without an
explicit user policy**, and **every claim backed by a number from the A/B
harness or a test**.

---

## Track A — Trust: make the tool verifiable on the user's own machine (**do first**)

Everything the tool claims about a page is currently console-logged and shown in
the panel; the user verifies by screenshot. That works, but it is slow and it has
already missed two real bugs (the lost gearbox, the hidden UI). The display-scale
probe, in particular, has never been confirmed on the machine it was written for
(Windows, 200%).

**A1. A "verify this page" action (S).** One button that runs every check the tool
has and prints a verdict per line: display unit (CSS vs device pixels), widgets
answering while off, viewports live while off, own UI untouched, gates installed,
fovea queue draining. Output: the same text in the panel and in the clipboard
report, so a screenshot or a paste is enough to judge it.

- *First step*: a function that calls `viewDisplayProbe(force)`, runs one sweep,
  reads `lowZoom.state`, `focus.*` and the counters, and formats `PASS/FAIL/UNKNOWN`
  per line with the raw numbers.
- *Risk*: low. It only reads.
- *Verified by*: a test that asserts the verdict lines exist and that a
  deliberately broken gate (uninstalled in the test) turns its line to `FAIL`.

**A2. Field check on the 200% machine (S, needs the user).** Run the build there
with a ~1000-node graph at 10% zoom, flatten + focus + fovea on, and read A1's
verdict plus the counts (`canvasWidgetsSeen/Blocked`, `hoverBlocked`,
`eventsBlocked`, `registered`, `foveaElements`). If `unit` comes back
`device-pixel`, that is the interesting result and it is already handled by the
CSS-box maths — but it should be *recorded* somewhere.

**A3. A startup line that can be turned off (S).** The tool already logs a warning
when the display unit is wrong. Extend it to log one compact line when it starts
(`vX running; display 200% (css); gates installed; N packs`), and give a setting to
keep it quiet. Answers "did it even load?" without opening the panel.

## Track B — Make every setting prove itself (**do second**)

Only two things in the tool have a measured "was it worth it": the scripted pan
A/B and the link-ink measurement (`lowZoom.measureLinks`). The rest of the drawing
settings (flatten, previews, idle cap, fovea, focus) show counters — how much they
*did* — but not what they *saved*, which is the number a user actually wants.

**B1. A generic measure-my-setting harness (M).** Generalise the link
measurement: alternate the setting on/off for N seconds each, several rounds,
compare mean `ms/frame` and p95 over exactly those spans, and report a verdict
with a confidence note ("saved 12.1 ms/frame over 6 rounds; noise band ±1.4").
Attach it to every control in the Tweaks tab as a small "measure" affordance, and
store the record per setting.

- *First step*: lift `lodAbStart`/`lodAbFrame` into a reusable
  `abMeasure({get, set, rounds, msPerPhase})` and port the link case to it.
- *Risk*: medium — it changes state on a timer. Must be cancellable, must restore
  the original state on every exit path, and must never run while the master
  switch is off.
- *Verified by*: a test with a synthetic frame cost that differs by setting, asserting
  the verdict's sign and that the setting is restored.

**B2. A cost ledger (S, after B1).** One table: setting → measured saving →
when it was measured. It is the answer to "which of these nine knobs is actually
doing anything on my graph", and it is honest about the ones never measured.

**B3. Auto-revert on a bad measurement (M, optional).** If a setting measures as
a *cost* on this graph (fovea was exactly this case before v2.1.13), say so loudly
and offer one click to turn it off. Never automatic — that would be a policy the
user did not ask for.

## Track C — Portability: presets, sessions, bug reports (**do third**)

Three things are persisted today, in three localStorage keys with three shapes.
A user tuning a heavy workflow wants one named thing they can keep, share and
re-apply — and a maintainer wants one file that contains everything needed to
reproduce a report.

**C1. Named presets (M).** Save the whole tuning state (drawing + view + governor
policies + controls) as a named JSON preset: apply, export, import, delete.
Include a `notes` field for what the workflow was.

**C2. Preset applied at start, opt-in (S).** The user asked early on for "run it
once at ComfyUI start, else a visible option": exactly this — a checkbox per
preset, applied on load, with the applied preset named in the panel and in the
console line. Off by default, remembered.

**C3. A one-file bug report (S).** The Copy button gives text. Add "Download
report": a JSON with the snapshot, the governor state and policies, environment,
the preset in force, and the last N frame traces. Redact nothing silently —
include what is in it, and say so.

- *Risk*: low; all three are new surface, no behaviour change.
- *Verified by*: round-trip tests (export → import → identical state), and a test
  that applying a preset with the master switch off does not silently enable
  anything (the switch stays off; the preset waits, or asks).

## Track D — Per-pack policies: from "the extension" to "this pack's nodes" (M–L)

Muting is per extension label; the drawing settings are global. The report that
started this whole line of work was about *3D nodes* (a node type), not about a
whole pack. The Governor already has a per-source model with policies — the
drawing side does not.

**D1. Node-type rows get a policy menu (M).** In the Nodes tab, next to each type:
`nothing / mute / flatten always / off-screen off / click-through`. "Flatten always"
means the node paints as a rectangle regardless of zoom, which is what a user with
forty 3D viewports actually wants at 100% zoom.

**D2. Pack-level rollup (M).** Group node types by the pack that registered them
(`typeOwners` already maps type → owner) and let a policy apply to the group.

**D3. Per-type safety rails (S).** Policies are per node type, never per node
instance; they are listed in one table with a count of how many nodes each affects;
and "reset to untouched" clears them all. A policy that would affect the tracker's
own node is refused.

- *Risk*: medium — this is the first feature that changes drawing *by node type*,
  so it must not reintroduce the coupling that v2.1.10 removed. Keep it in the
  predicate layer, one decision per draw, and count what it did.
- *Verified by*: tests where two types are present and only the selected one
  changes; plus a measurement (B1) on a graph with many nodes of that type.

## Track E — Cross-session memory: regression detection (M)

The tool forgets everything on reload. "This workflow was 22 ms/frame last week
and is 44 now" is the natural next question after "who is eating my frames", and
it is the question a pack update raises.

**E1. Run records (M).** On demand (or at the end of a scripted pan), store a
record in IndexedDB: workflow name (if the page exposes one), node/link count,
zoom, mean/p95 frame, top five rows by `ms/frame`, packs and their versions if
available. Cap the store (e.g. 50 records) and show it in the Load tab.

**E2. Compare (S, after E1).** A "compare with…" that diffs a record against now:
which rows got worse, by how much, and whether the top offender changed. This is
the honest version of "did the update make it slower".

- *Risk*: low for E1/E2 (read-only history, explicit records). Careful with
  storage limits and with `file://`-style environments where IndexedDB is absent —
  degrade to an in-memory list and say so.
- *Verified by*: a fake-IDB or a thin storage interface with a memory implementation
  in tests; comparator tests with crafted records.

## Track F — An API other extensions can use (L)

Right now the only way to be measured well is to be a ComfyUI extension whose
draw hooks the tracker can wrap. Anything else (a pack's own worker, a custom
render loop, a cost that happens outside `draw()`) can only be guessed at, and the
LIMITS block says so.

**F1. Document the read API (S).** `window.__antsTracker` already exposes
snapshot/report/totals/lowZoom/governor. Write it up as a stable surface with a
version, and add a test that fails when a documented key disappears.

**F2. A publish-side API (L).** `window.__antsTracker.reportCost({label, ms,
kind})` — a way for a pack to tell the tracker about work it knows about, which
lands in its own row, marked `reported` (not measured). The distinction matters:
a reported number must never be presented as this tool's measurement. Same for a
`registerPhase(name)` for a coarse "we are doing X now" span.

**F3. A tiny README section for pack authors (S).** How to be measured: draw
inside `onDrawForeground`/`drawNode` where the existing wrap can see you; if you
cannot, report it and say by how much. Include the contract (what the tracker
promises: no interference when `normal`, no invented numbers).

- *Risk*: medium — an API is a promise. Keep it read-mostly and additive; version
  it; never let a reported number inflate a measured total without a marker.

## Track G — The tool's own cost, and off-thread aggregation (M)

The panel already backs off when its own render gets expensive (`refreshIntervalFor`),
and the snapshot carries the tool's own cost (`snapshot.self`, from `selfCostMetrics`).
It is not yet shown as a first-class number the way extension costs are.

**G1. A "tracker" row in the Timing tab (S).** Its own cost, next to the
extensions it is measuring, with the same units. If the profiler is the second
most expensive thing on the page, the user should be able to see that without
asking.

**G2. Aggregation in the worker (M).** Percentiles, snapshot building and report
formatting are pure computation over plain arrays — the worker lane exists exactly
for this (`GOV_WORKER_SRC`). Move the heavier parts there, keeping a main-thread
fallback, and measure the difference with B1's harness.

- *Verified by*: identical results from both paths in tests (same snapshot text
  from the worker and main-thread implementations), and a self-cost drop in the
  demo.

## Track H — Backend integration, still read-only (M–L)

The one route (`/ants_tracker/gpu`) is the pattern: optional, read-only, honest
about absence.

**H1. Packs and versions (S).** A route that lists installed custom node packs and
their versions (from `custom_nodes/*/` metadata), so a report says which versions
produced the numbers. Read-only, cached, and it reports its own absence.

**H2. A session report store (M, opt-in).** A route that accepts a report from the
frontend and writes it under the extension's own directory (never into ComfyUI's
own files), so the maintainer can collect numbers from a user without a
screenshot. Off by default, requires an explicit button, and it says where the
file went.

**H3. A node that shows the last stored report (M).** Turns a report file into
something visible in the graph. Low priority; only worth it if H2 is used.

- *Risk*: anything that writes is a different category from everything else here.
  It must be opt-in per action, write only under the extension's own folder, and
  never touch workflow files or ComfyUI settings.

## Track I — Scheduler layer v2 (L, only with evidence)

The governor can slow a source, merge redraws, and skip rAF ticks adaptively. What
it cannot do is reason about *lanes*: display work versus background work versus
the tracker's own timers. `GOV_DISPLAY_FLOOR_MS` is a first attempt.

**I1. Display-lane budget (M).** Give the display lane (anything that draws) a
protected share: background sources are skipped *first* when the frame is over
budget, and the panel shows which decisions were made and what they saved.

**I2. Deadline-aware skipping (L).** Skip a background tick only if it will not
push a frame past its deadline, using the measured frame cost rather than a fixed
gap.

**I3. "Protect the pan" mode (M).** A single switch that, while the canvas is being
dragged, applies the mildest policy to every background source that has ever cost
more than X on this page. It must be measured before/after with the scripted pan,
and it must be off by default.

- *Risk*: high — this is the part that changes timing behaviour. Every item needs
  an A/B number on a slow graph, a fail-open path, and a test that `normal` is
  still a no-op.
- *Verified by*: the scripted pan A/B (exists), plus tests for the decision
  function itself.

## Track J — Speculative; ask before building

- **Workflow cost annotation**: write a sidecar file next to a workflow recording
  per-type costs from the last run, so a graph can be opened with "these three
  types cost 60% of your frames" pre-attached. Needs H2 and a rule for where the
  file lives.
- **A "what changed" detector**: diff two snapshots (after a pack update) to name
  which row grew. E2 covers the useful half.
- **Node badges**: draw a small cost badge on the worst node types on the canvas.
  Cute; costs draw time; likely only worth it behind the flatten threshold. Would
  need a measurement to justify.

## Track K — Node stand-ins: from boxes to bitmaps (M–L)

The flatten path draws a grey rectangle (`lodPaintNode`). It is honest work — it
removes nearly all of a node's draw cost — but it tells the user nothing: not
which node it was, not which type, not whether it is selected, executing or
broken. That is the "dumb semi useless boxes" complaint, and it is fair.

[NodeSnapshots](https://github.com/SparknightLLC/ComfyUI-NodeSnapshots)
(SparknightLLC / EricBCoding, MIT) solves the same problem with real bitmaps:
captured in small idle batches, reused while panning, zooming, dragging and
resizing, with a signature check so a stale image is never shown. It is the right
engine. Its storage strategy is what does not survive a large graph: captures are
taken at a fixed 2 px per graph unit, so a 1000×400 node becomes 2000×800 RGBA —
about 6.4 MB — and the default 256 MiB budget therefore covers roughly forty
nodes. Its own README and reports show the consequences (long warm-up, nodes left
live when the budget runs out). Our version keeps the engine, changes the storage
strategy, and credits every byte of it (Track M).

**K7. Pictures that contain the node (v2.5.6).** A capture is the canvas plus
what can honestly be drawn of the node's DOM widgets: images and canvases pixel
for pixel, a text field's value re-painted in the theme's colours, a pack's HTML
left blank and counted, and a video node never photographed. The signature
covers the elements' own content, so a new image or an edited prompt makes a new
picture. The disk cache is keyed by what is inside the file — the node's
signature plus the capture resolution and a theme hash — which is what makes the
resolution setting behave in both directions. Evidence and the tests are in
`ANALYSIS.md`.

**K8. The Vue-nodes stand-in — built (v2.6.0).** The same setting, the other
mechanism: below the zoom threshold each node's own element is blanked (`opacity:
0`, keyed on the `data-ants-vue-standin` attribute rather than a class since
v2.6.3 — the frontend rewrites that element's `class` and `style` on every
re-render — and it keeps its layout and its pointer events, so interaction is
unchanged) and the canvas paints the same box in the same place,
through the seam LiteGraph still calls in that renderer (`drawNode` with the
context in node-local space). The pathway is chosen per call from
`LiteGraph.vueNodesMode`, a box is painted only after a real blanking, and every
blanked element is handed back on the frame the setting, the zoom, the tool or the
renderer changes. **v2.6.3 closed two defects this plan had recorded as design:**
the mark is an *attribute* (`data-ants-vue-standin`, `!important` rule) because
Vue rewrites the element's `class` and `style` on every re-render, and the
capture/ratio/budget/disk half is **not** idle in this renderer — a picture is
*drawn* into the capture surface (`lodVueCapturePaint`), so the ratio ladder, the
mips, the RAM budget and the disk files behave exactly as in the canvas renderer.
**v2.6.4 closed the two defects the seventh report named.** A picture now carries
the node's own text (read out of the DOM — every string, its box and its computed
styles — and re-painted, title included, with the content clip reaching into the
title bar), the zoom it is measured in comes off the frontend's own transform pane
first and `canvas.ds.scale` only as a last resort, a capture whose element is not
on the page is refused rather than stored as a bare box, and the pathway is part
of the picture's signature *and* of its file name (`…<pc|pv>`) so neither
renderer can ever be served the other's picture. The flicker was the frame plan
and the draw loop asking two different questions: the plan wanted the picture
setting, the draw loop only the zoom, so with any other stand-in mode the plan
handed the whole set of elements back every frame while the draw loop blanked
them again. One predicate (`lodVuePathOn`) is asked by both now, and a box counts
as standing in.
**v2.6.5 answered the eighth report's two questions with measurements.** The frame
cost of the stand-ins was the tool's own per-frame work, not the blits: 40 mark
re-writes and 82 DOM queries a frame at 40 nodes (38 and 80 of them no-ops the
browser charged for), plus a layout read per boxed node on a 400/800 ms timer. The
mark is now written only on the transition, the video verdict is cached, and the
measurement is *reported* rather than polled (`ResizeObserver` + `MutationObserver`
over the node's element, a report dropping that node's measurement), so the steady
state costs the page zero writes, reads, queries and probes at any node count —
40/82.4/2 → 0/0/0 per frame at 40 nodes, 60/122/2 → 0/0/0 at 60. The early picture
was two numbers that should have been one: the signature now mixes the height the
frontend rendered the element at and the rows the browser laid its widgets out in,
and a capture takes a single measurement, so surface, box and ink agree and a node
that finishes rendering after its first look is re-pictured instead of kept
half-drawn.

**v2.6.6 answered the ninth report, and the answer was a mechanism rather than a
measurement.** Three things. **(1) The mark was the wrong property.** v2.6.5 had
already measured the tool's own per-frame cost to zero and the performance still
dropped, so the cost left could only be the frontend's own painting — which
`opacity: 0` does not stop (an opacity-0 subtree stays in the render tree and is
still painted). The stand-in attribute now hides the element's *children* with
`visibility: hidden`, which an engine skips in the paint phase, while the element
itself keeps its box, its layout, its observers and its hit-testing; a frame at low
zoom no longer owes the browser a single node's DOM paint. The trade is stated,
not hidden: a widget inside a stand-in does not take its own clicks at that zoom,
and the node's accessibility entry is that of a hidden subtree. **(2) The picture
was missing the node.** The frame, the header bar, the body panel, every widget's
own row and the slot dots are read from the frontend's own structure
(`node-inner-wrapper`, `node-header-<id>`, `node-body-<id>`, each widget's element,
`.slot-dot`) and drawn by the same ink the live box uses — the surface the content
sits on was simply absent, which is what "semi, not fully there" described. **(3) The capture was not waiting.** Upstream
has no per-node tick; a node is assembled over several passes (mount, slot sync,
layout, widgets, media decoding), and the capture lane is deliberately its own, so
a capture right after a change read the DOM between two of those passes. A settle
window (`LOD_SNAP_SETTLE_MS` = 300 ms, opened when a node is first drawn as a
stand-in and re-opened by every change, enforced as a lane gate) makes a burst of
rendering cost one picture at the end. The "capture process of our own" the report
offered is what this pathway already is: DOM-to-canvas does not exist, and the
library routes would re-rasterise the node tree per capture on the CPU — the cost
the pathway exists to remove.

What the boxes carry (v2.6.1, completed in v2.6.2, made to work in v2.6.3): the
node's own content, drawn live from the two routes it takes to the page —
widget-borne elements (`WidgetDOM.vue` mounts `widget.element` into the node) and
everything the node renders itself (`ImagePreview.vue`'s `<img>` elements, a
custom node's `<canvas>`), the latter drawn at its laid-out position through
`lodVueRootMetrics` (rect arithmetic in node-local units, cached on the node's own
size, rationed per frame). A *photograph* of the node remains impossible: no
browser API draws a DOM element into a canvas, and the `<foreignObject>` route
cannot fetch the images that matter. Recorded in `ANALYSIS.md` with the two
rejected routes, so nobody re-opens it without new information. The box is the
*element's* box (image nodes are rendered 232 px taller than their graph size),
and the zoom used to convert the measurements is measured from the element, never
read from `canvas.ds.scale` — a capture sets that to 1.

Remaining gap, deliberately not closed: a pack whose preview is a *canvas* widget
(`drawWidget`) with no DOM rendering has nothing on the page for the box to
carry in this renderer — unlike the frontend's own preview, which `ImagePreview.vue`
also renders as DOM. Closing it would mean running a pack's canvas draw against
the live frame context for every blanked node, which is exactly the per-frame
cost this pathway exists to remove.

Open, and deliberately not guessed at: **how much this saves on a real heavy
Vue-nodes graph — and whether the v2.6.3–v2.6.6 fixes are enough on the user's own
page.** Since v2.6.6 the saving has a mechanism as well as a count: the frontend's
own painting of the stand-in nodes is skipped (`visibility`, and `vuePaintSkipped`
counts it), the picture carries the node's structure, and the capture waits for the
node to settle; since v2.6.7 it is not dropped while it is out of date either, so
the saving is not paid back as a box on screen (1020 of 1800 frames with a box in
the A/B, 17 after; an average of 7.14 boxed nodes a frame against 0.45, and 23.8
blits a frame against 20.4). v2.6.8 closed the fidelity half of the same question:
the frontend has no zoom-based level of detail (verified against `LGraphNode.vue`,
`TransformPane.vue` and `drawNode`, and reported from the page by `lodVueLodProbe`),
and what made a stand-in look unlike the node was the picture itself — Tailwind 4
`oklch()`/`oklab()` colours a canvas silently ignores, text drawn as one Arial line,
a muted node drawn at full strength, and the frontend's own widget rows never read
(now read, with the control's value drawn as the control it is). What is still not measurable from here is the rasteriser's bill on
the user's machine (Electron, GPU/hardware acceleration off) — DevTools' paint
flashing is the direct way to see it, and the frame budget plus the Stalls tab are
the tool's own instruments. Each report has been a state the harness could model only after the fact:
a class Vue rewrote, a picture half that was off, a picture with no text in it, a
plan fighting the setting once per frame, a picture taken before the node had
finished rendering, a poll the page could have answered itself. The user's page
remains the live test. The nine live reports so far (v2.5.6 "pictures with no
content"; v2.6.0 "nothing in Nodes 2.0"; v2.6.2 "only text nodes have content";
v2.6.3 "no pictures and no disk files at all"; v2.6.4 "captured box previews,
cached boxes in the canvas workspace, and a canvas that flickers when the stand-in
mode is not pictures"; v2.6.5 "photographed too early, and the stand-ins drop the
frame rate"; v2.6.6 "the performance hit is the same, and the stand-ins still look
half-rendered"; v2.6.7 "still not there yet: flat rectangles at 42 % and the
performance hit unchanged"; v2.6.8 "we are still half-way there — and does the
frontend have its own zoom-based LOD?") each found something the harness could not, and the harness has been
strengthened by each one — the last pass added the two change observers (with
`withQuiet` so a pan or a zoom is not mistaken for a box change), a Vue re-render
that rewrites `className`, an `isConnected` that tells the truth, the element's
real height, the frontend's transform pane (so the DOM zoom is exercised the way
the page writes it), a `getComputedStyle` that resolves transforms the way a
browser reports them, a shim that *says* when a selector is one its own grammar
cannot express (`document._qsaUnsupported` — the v2.6.8 pass found the reader had
been asking for the widget grid's rows with a child-combinator selector the tests
silently answered with nothing), and `ANTS_TRACKER` so the suite can be pointed at
a copy of the tracker for the mutation battery.
A stand-in picture in this renderer is drawn, not photographed. The frontend composites all nodes in one transformed container
(O(1) pan/zoom by design — `useTransformState.ts`), so panning and zooming are not
where the cost is; v2.6.5 measured the rest and **withdrew the "fewer node pixels"
claim**: `opacity: 0` keeps the element rendering, so the saving is not
established, while the *cost* is now zero per frame (no attribute writes, layout
reads, DOM queries or computed styles at 40, 60 and 150 nodes). Whether it saves
frames on a given graph is what the tool's own frame budget and its Stalls tab
measure on that page — and if the frame rate still drops, the honest next step is
to price the blits and the blanked DOM's paint with those instruments rather than
to add another mark that would cost the node its hit-testing. A second
open question: the frontend is growing an ECS-based renderer (`arrangeForLegacyRender`,
`hitTargetAuthority`, `canvasRedrawBudget`), which may itself introduce a
low-quality node mode — if it does, this pathway should hand that work over rather
than compete with it.

**Renderer compatibility — checked against the frontend, not assumed
(v2.5.5).** On ComfyUI's newer frontend (Nodes 2.0 / Vue nodes,
`LiteGraph.vueNodesMode`) every node is a DOM element and `drawNode` returns
immediately, so a stand-in box would be painted *behind* the thing it replaces
and a capture of it would be blank. The engine now reads the same flag the
frontend sets, reports itself off there rather than queueing blank captures,
and the readout names the renderer instead of blaming a setting; the focus
half (widgets stop answering, off-screen culling) still works, and the link
settings are canvas-side and unaffected. The upstream contract this was
checked against, file by file, is in `ANALYSIS.md`. Not otherwise a change to
this track: nothing about the capture design depends on which renderer the
page uses.

**K1. The capture engine, ported and credited (M) — DELIVERED in v2.3.0.**
Shipped as designed, with three decisions the code argues for and this file
records: (a) a snapshot replaces a *flat box*, never a live node, so the flatten
threshold stays the only thing that decides which nodes stop being drawn in full
(golden rule 6) — which also means this step is a readability feature, and the
performance case (replacing live nodes during movement) is a claim that still
needs K3's numbers; (b) the capture draws into its own offscreen canvas rather
than the visible one, so there is no sixteen-property canvas state to copy and
restore; (c) a capture runs the packs' hooks but attribution stands aside while
`inCapture` is set, so the time lands in `snapMs` instead of in the Timing tab's
row for a pack that did nothing wrong. Panning and zooming deliberately reuse
(the camera moved, the node did not); dragging a node does not. Ported these
pieces, with a source note on the block naming upstream:

- `node_signature()` — a JSON of everything that changes what a node draws:
  title, size, flags, mode, colours, shape, collapsed width, subgraph version,
  input/output counts, widget values, and the canvas render flags. Position,
  zoom and subgraph entry are deliberately *not* in it, so pausing mid-pan never
  invalidates a capture. Longer reuse interval (~100 ms) while the user is
  interacting.
- ~~Never cache this node: any widget with an `element`, a widget of type
  `dom`/`custom`, function-valued properties, strings over 4 kB.~~ **This plan was
  wrong and v2.4.0 replaced it** (see K1.1): the refusal list is upstream's
  conservative guess, and the request's named gap was exactly the nodes on it. What
  shipped instead is the canvas as the judge — every node `drawNode` can put ink on
  a surface for is captured, the browser-drawn part of it is not in the picture and
  is counted apart, and the honest limits that remain (nothing drawn into the
  canvas, too big at any ratio, too slow, changing faster than it can be
  photographed) are each *proved* by a measurement and named in the readout. A
  per-type override (Track D) is still the right escape hatch for a type the user
  wants kept live, and it now has one meaning: keep this type live on purpose.
- A DOM-widget node's picture is the canvas part only — the browser's own rendering
  of that element is deliberately not baked in (out of scope). Those pictures are
  counted as "the canvas part only" in the readout rather than hidden in a
  refusal.
- Always live: selected, hovered, carrying an error, executing or queued,
  link-connector active, actively dragged; plus the user's per-type excludes
  (Track D) as first-class settings instead of a comma-separated text field.
- Slow-capture verdict: a node whose own capture took longer than the cutoff
  stays live for the session. **Default 60 ms, not their 32 ms** — their issue #1
  recommends exactly that raise for large custom nodes.
- Context hygiene: copy the mutable `ctx` state before capture and restore it
  after; force `ds.scale = 1` and `_isLowQuality = false` during capture (a
  capture must never bake the *current* zoom or a temporary LOD state into a
  reusable image); set `shadowColor` transparent before every `drawImage` so a
  shadow is never blended into the bitmap.

*Why ours can be cheaper:* capture and reuse both hang off the `drawNode`
wrapper we already own (`web/tracker.js`, ~line 3186), and batching runs on the
governor's idle lane (`govInputRecently`, `GOV.controls.budgetMs`, the `rafMode`
coalescer, the input guard) instead of a second scheduler with its own idle
clock, `requestIdleCallback` and timers. One idle lane, one set of numbers in the
panel.

*Risk:* the largest single change in this plan. Every part must fail open into
the flat box, never throw inside `drawNode`, and switching it off must restore
the exact previous behaviour (`normal` = strict no-op). The one place we must not
follow NodeSnapshots is capture-into-the-live-canvas: a capture drawn through the
visible context is only invisible because it happens while idle, and the idle
lane can be pre-empted by a frame. Prefer a reusable offscreen canvas per capture
size, and measure whether that costs more than their approach.

*Delivered as:* 16 tests in `tests/drawing.test.mjs` (off by default; capture
and blit; the idle lane waits for input to stop; the always-live set; drag vs
pan; a changed widget drops the bitmap; the slow-capture block; no attribution
during a capture; the refused set; budget eviction; every release path; the
reuse fault path; the panel and API), plus a demo section and the `LIMITS`
entries. The harness grew offscreen-canvas support for it (`createDocument({
ctxFactory })`, `setTransform` recorded, `h.canvases`).

**K2. Zoom-bucketed bitmaps, not a fixed capture scale (M) — NEXT.** Note from
the first real report: at zoom 0.19 with everything on screen, per-zoom capture
scaling matters less than getting *every* node a picture, and 2x already gives the
page more detail than the frontend's own low-quality path at that zoom. K2's
bucketing should be designed against that: it is about readable zooms (where the
budget has room and the pictures are few), not about the ten-percent view. The capture is
taken at the scale of the zoom bucket it will be used in, and reuse is one
`drawImage` from that box to the on-screen one. At the flatten zooms a node is
drawn into roughly a hundred by forty screen pixels, so a bitmap of that size is
on the order of 64 kB — even a thousand of them is tens of megabytes, not
hundreds. At readable zooms the few visible nodes are the only ones worth
capturing, where the budget has room. When a bucket is too wide to cover (a node
spanning many zoom levels, or a graph in constant zoom motion), the flat box
remains the fallback — the flatten path is not replaced, it becomes the floor.
Reuse our `lodBucketFor` buckets and the `LOD.thumbs` WeakMap / `thumbBytes`
accounting rather than adding a second cache with a second budget.

*Numbers here are estimates to be confirmed by K3, not figures to put in the
panel.*

**K1.1 Coverage: every node the canvas can draw gets a picture (S) — DELIVERED in
v2.4.0.** The second real report answered K1's first open question by itself: at
zoom 0.10 with the whole graph on screen, 625,156 draws came from pictures, but the
nodes the user noticed as empty boxes were exactly the 206 *refused* (a DOM widget,
a function, a long string — upstream's conservative line) plus the ones behind a
"375 too large" counter that was counting *attempts*, which hid the fact that only a
couple of dozen nodes were involved. v2.4.0 moved the rule to where the canvas is
(if `drawNode` can put ink on a surface, the node is photographed), kept a box only
for what is provable (nothing drawn into the canvas — five 8x8 probes — too big at
any ratio, too slow to capture, changing faster than the lane can photograph it, or
on the user's own keep-live list), fitted tall nodes to the largest ratio that fits
the cap instead of skipping them, and made a budget refusal try 1x first. The
readout now leads with `N of M remembered node(s) have a picture` and *names* the
nodes that will not get one. That last part is the point: the previous two reports
were diagnosable only from counters, and this one was diagnosable from one bucket.

**K3. Prove it, then set the default (M) — PARTLY DELIVERED in v2.3.1 and again in
v2.4.0.** The
first real report arrived after K1 shipped (1,041 nodes, zoom 0.19, 256 MiB
budget): 7,040 captures for 1,041 nodes, 255.6 MB held at the cap, 156,393 draws
served from pictures — and visible flicker, which the numbers identify as eviction
churn. Fixed in v2.3.1 (frame-based "in use", refuse-don't-evict, ladder 256 MiB →
2 GiB), and the panel now counts refusals and picture/box switches so the next
report can confirm it instead of describing it. v2.4.0 covered the
coverage half of the question — the report's 1.7 GB of a 2 GiB budget at 2x, with
1,041 nodes, says the ratio *is* the coverage knob on a graph this size (at 1x the
same budget holds four times the pictures, and a flattened node is drawn at half
size or less, so 1x still oversamples the screen). What is still open: hit rate
against graph size, whether the ratio default should stay 2, and the per-zoom
frame-time A/B on a real graph (the report gives the shape but not the A/B: node
drawing 2.06 ms/frame and connections 26.5 ms/frame at 0.19 zoom). Measurement
recipe, now that the readout carries the number: on the real workflow, switch 1x
and 2x and read `N of M remembered node(s) have a picture` plus the report's
`snapshots` line (bytes held, refusals, coarse pictures, flips) at 10% and 50%.
The memory budget is a knob; the default comes from measurements like this one.
A synthetic replica of the reported graph shape (1,041 nodes, ~11% heavy custom
nodes, ~11% DOM-widget/image nodes, tall monsters; `tests/harness.mjs`, run in
September 2026) says the shape of the answer: at 2x the same graph holds 1,039 of
1,041 pictures for 1.1 GB, and at the *default* 512 MiB the same 2x setting
pictures only 474 of 1,041 — while 1x holds all 1,039 for 291 MB, inside the
default budget. So on a large graph the ratio is not a quality knob, it is the
coverage knob. Not yet measured on the real workflow, and not a claim about it.

One consequence of that measurement is already visible and is the next candidate:
"coarser, not nothing" only fires when there is a gap in the budget. When the
budget is full to the brim, a new node gets 1x *or* nothing — no room either way.
A whole-cache re-resolution (persistent pressure down-shifts stored pictures
instead of refusing incoming ones) is the cheaper-on-memory answer, and it is a
cache-wide policy that needs its own measurement before it is built (K2/K3 share
that work: K2's buckets are the same question asked per zoom). The panel reports
what the cache actually did, in the same units as everything else: reuse hit
rate, misses by reason (no capture yet, signature changed, too slow, excluded
type, over budget), bytes held, capture-time distribution — and the same A/B the
flatten threshold already had: frame time with bitmaps vs flat boxes vs live, at
10%, 25%, 50% and 100% zoom. This is also where the honest limit goes into the
README: bitmaps help movement; they do nothing for a still frame that is slow for
another reason.

**K4. Informative boxes as the floor, not the ceiling (S) — DELIVERED in v2.2.0.**
A `box detail` ladder (`plain` / `title` / `state`) next to the flatten threshold:
the node's own title-bar colour above the body, then an error ring
(`has_errors`), a progress bar (`progress`) and muted/bypassed/ghost dimming
(`mode`, `flags.ghost`), all at the frontend's own numbers and all counted in the
panel. `plain` is exactly the old paint. What was deliberately *not* built, and
why: no "executing" mark (this frontend carries no per-node execution field —
`node.progress` is the only one, and it is drawn); no slot dots (LiteGraph's slot
positions are only computed when a node is drawn in full, and this path exists so
that it is not — evenly-spaced dots would be a picture of a layout that is not
there; the bitmap path in K2 draws the real slots instead). Relevant detail from
the frontend source: below its own LOD threshold (`low_quality`, which at 200%
Windows display scale is reached at ≈0.40 zoom — see `memory.md`) LiteGraph
already skips title text, badges and widget text, which is part of why the boxes
looked so empty at 10%. Colour and state are what carry information at those
zooms, and they are also the fallback the bitmap engine (K1–K3) must keep.

**K5. The gesture LOD hold (S).** NodeSnapshots' "Simplify live nodes during
navigation" is one line of LiteGraph state: hold `min_font_size_for_lod` high for
the duration of a gesture, then put it back — touching only its own value, and
leaving a user-raised threshold alone. It only matters for nodes that are *live*
at readable zooms; at 10% zoom this frontend is already low-quality by its own
default, so the lever does nothing there. Small and reversible; the numbers
decide whether it stays.

**K6. A link-layer bitmap is a link setting (M).** Their `links.mjs` caches the
visible connection layer plus an overscan margin and reuses it while panning and
zooming. Genuinely useful — but under the standing rule it is a *link* subject,
must never be entangled with node stand-ins, and must prove its own value in the
link A/B (the thinned-link work already has that harness). Deliberately after K2,
and only if K2 shows that bitmap reuse survives real graphs.

## Track L — Console: attribution before silencing (M)

[DisableBrowserLogs](https://github.com/SparknightLLC/ComfyUI-DisableBrowserLogs)
(SparknightLLC, MIT, 78 lines) replaces `console.log`/`error`/`warn`/`info`/
`debug`/`trace` with no-ops, permanently (`writable: false`,
`configurable: false`) and re-applies itself if `globalThis.console` is
reassigned. It exists because of a measured case in NodeSnapshots' issue #1: one
`console.log` per wheel event took a large workflow to 5 FPS *with DevTools
closed*. That cost is real — the browser serialises and buffers the message
regardless of whether the console UI is open — and it is invisible to a pure
frame profiler.

What we will not copy is the switch: a non-configurable no-op cannot be undone
without a reload, which breaks "off restores exact old behaviour". Our version,
as a mode in the TWEAKS tab:

- **off** (default) / **count only** / **count + rate-limit** (last message per
  owner per interval, plus "and N more") / **mute per owner** / **mute all**.
- Wrapping keeps the original functions and their descriptors, so off restores
  the exact previous objects. `error` and `warn` are counted but only muteable
  behind an explicit second confirmation, because silencing them hides real
  problems.
- **Attribution is the part we already own.** The same `parseCallerStack()` /
  `packFromUrl()` machinery that names the pack behind an invalidation storm
  names the owner behind a log storm: "console: 8,400 calls in 60 s — 96% from
  <pack>". The user mutes that pack instead of blinding the console.
- Our own ten `console` call sites go through the saved originals, so the tool
  can never silence its own diagnostics.

*Risk:* low mechanically; the load-bearing part is the text. A user who mutes
everything and then files a bug report has no console to offer, so the panel says
so next to the switch.

*Verified by:* tests for call counting, owner attribution, rate-limit emission
count, exact restoration of the original functions and property descriptors, and
the reassignment trap (replacing `globalThis.console`, then still counting, and
still reverting).

## Track M — Provenance: licence and credit (S, with K1 and L)

MIT permits reuse provided the copyright notice travels with the code; the honest
version is stronger than the legal minimum, and the user asked for credit
"everywhere it matters":

- A source header in every file that carries ported code, naming the upstream
  repository, the author (EricBCoding / SparknightLLC) and the licence.
- A Credits section in the README that says plainly what was taken, what was
  changed, and what was deliberately left out.
- `THIRD_PARTY_NOTICES.md` carrying both MIT notices, with a note that
  NodeSnapshots also ships `PHOSPHOR-LICENSE.txt` for a camera icon we are not
  taking.
- The same text in the commit body and the PR description.
- While that file exists, this repo should carry its own `LICENSE` — it currently
  has none, which is a poor look for a project that is about to embed someone
  else's notice.

**Done (v2.5.4):** `LICENSE` (MIT, this repository),
`THIRD_PARTY_NOTICES.md` with the NodeSnapshots notice verbatim (and the
PHOSPHOR note), the README **Credits** section, and the same text in this
pass's commit message. What was actually taken is smaller than the plan
assumed: no code was copied from either upstream project — the stand-in
engine is a re-implementation of the idea on this file's own seams, and the
console mode is still unbuilt. DisableBrowserLogs carries no licence file at
its root, so it is credited as an idea only; `THIRD_PARTY_NOTICES.md` says
that plainly rather than shipping a notice it cannot vouch for. A source
header naming the upstream work sits above the snapshot engine in
`web/tracker.js`.

## What this must not become

- Not a workflow runner, not a queue manager, not an execution profiler — the
  backend already has those, and pretending to see execution from the page would
  break the "never invent a number" rule.
- Not a tool that changes the user's graph or workflows. The only writes are its
  own localStorage, an explicitly requested report file under its own folder, and
  the timer policies the user picked.
- Not dependent on npm, a bundler, or a browser feature without a fallback.
- Not clever about other extensions' internals: measure, or ask them to report.

## Suggested order

0. **K + M, then L** — the current request (2026-09-28). **K4 delivered
   (v2.2.0)**, **K1 delivered (v2.3.0)**, **K1.1 coverage delivered (v2.4.0)**;
   K2 → K3 next, with the ratio-vs-coverage measurement K3 now spells out. M's notices wait for
   the user's decision on whether upstream code is kept at all (Q5): the K1
   implementation is this file's own, with the design credited in a comment, so
   nothing legally needs a notice yet. K5/K6 only after K2 has numbers. Track L
   after K3, in the same round as agreed.
1. **A1 + A3** (verify page / startup line) — small, and they make everything after
   this checkable on the real machine. A2 needs one run from the user.
2. **B1 + B2** (measure any setting / ledger) — turns nine knobs into evidence.
3. **C1–C3** (presets, start-once, one-file report) — the portability the user asked
   for, and the thing that makes bug reports cheap.
4. **D1–D3** (per-type policies) — the feature that fits the actual complaint
   ("3D nodes at 100% zoom") without making the user mute a whole pack.
5. **G1** (the tracker's own cost row) — small, and it keeps this tool honest.
6. Everything else by evidence: E if cross-session comparison is wanted, F once a
   pack wants to participate, H once collecting reports matters, I only with A/B
   numbers in hand.

## Open questions for the user

1. ~~**Which of these is "the advanced stuff" you had in mind**~~ — **answered
   2026-09-28**: the node stand-ins (Track K) plus the console mode (Track L), with
   provenance (Track M) in the same round. Kept for the record.
2. **May the tool write anything to disk?** Today it only writes localStorage.
   A report file (H2) is the natural next step, but it changes the "nothing
   server-side" property the README boasts about.
3. **Should other packs be able to report their own costs** (F2), with the caveat
   that a reported number is not a measured one?
4. **Is a per-type "flatten always" policy wanted even at 100% zoom** (D1), and if
   so, should it be per type or per pack?
5. **Confirm the licence position** (Track M): carrying MIT code with the notices
   is permitted, but embedding someone else's copyright notice is a decision the
   repository owner should make explicitly. And if this repo gets its own
   `LICENSE`, which one — MIT, to match the ecosystem?
