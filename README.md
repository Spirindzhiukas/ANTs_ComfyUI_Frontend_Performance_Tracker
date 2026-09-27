# ANTs Nasty Bastards Tracker

A frontend-side profiler for ComfyUI. Answers "which extension is
actually costing me FPS while panning this graph?" without needing
Chrome DevTools open, and without restarting ComfyUI to bisect.

Version 2.1. The v2 rewrite changed the semantics (costs are now per
drawn frame, not per 4-second window), added five tabs, and fixed a
handful of v1 bugs that could make the panel lie. 2.1 adds an eighth
tab that can **act** on what the others find: a tunable scheduler layer
over the page's own timers, rAF callbacks and redraw requests. If you
are coming from v1, read **"What changed in v2"** at the bottom.
`REVIEW.md` in this repo documents the v1 defects with line references.

## Install

Drop this whole folder into `ComfyUI/custom_nodes/` so it sits at:

```
ComfyUI/custom_nodes/0000_ANTs_nasty_bastards_tracker/
    __init__.py
    web/tracker.js
```

The `0000_` prefix is deliberate — it makes this load before other
custom nodes' web directories (alphabetically), which it needs to do
in order to catch every other extension's `registerExtension` call.
Don't rename it unless you also rename it to something that still
sorts first.

Restart ComfyUI. No dependencies, nothing to `pip install`, no build
step. Nothing is persisted server-side; the only thing written to disk
anywhere is the panel button's screen position (browser `localStorage`).

## Use

The tracker starts recording automatically the moment the page loads —
you don't need to place any node for it to work. Two ways to open the
panel:

1. A small 🔧 button appears pinned to the screen at all times. A
   quick click opens/closes the panel. Press and hold it for a moment,
   then drag — it switches into move mode instead of clicking, and
   remembers wherever you drop it (via `localStorage`), even across
   page reloads. Handy since its default spot can collide with
   ComfyUI's own minimap/queue UI depending on your layout; drag it
   up near the top bar or wherever's actually clear on your screen.
2. Or drag in the **"ANTs Nasty Bastards Tracker"** node (category
   `ANTs/debug`) and click its **Open Tracker** button. The node does
   nothing else — no inputs, no outputs, never executes.

Panel header buttons:

- **📋 Copy** — dumps a plain-text snapshot of every tab to the
  clipboard in one go, meant for pasting into a chat or bug report
  instead of a screenshot.
- **⏸ Pause** — freezes sampling. Drawing keeps happening; it just
  stops being timed, so a jumpy table holds still long enough to read.
  Meters are marked stale while paused.
- **⟲ Reset** — clears every recorded sample. Mutes, the redraw cap
  and the panel's own position are kept, so you can reset between
  experiments without redoing your setup.

## Reading the numbers

Every cost in the Timing and Nodes tabs is given in **four units**, and
the first is the one to reason with:

| Unit | Meaning |
| --- | --- |
| `ms/frame` | milliseconds of work added to the average drawn frame |
| `% fr` | that cost as a share of the average frame in the same window |
| `ms/call` | cost of one invocation (spikes vs. steady load) |
| `calls/fr` | how often it runs per displayed frame |

`ms/frame` and `% fr` are what let you compare a row to the 16.6ms
budget of a 60fps frame, to another graph, or to the same graph a
minute ago. They do not change if you pan faster; v1's window sums did.

Rates (`fps`, `requests/s`, stalls/s) are wall-clock and say so.

Windows, if you need them: hook and node-type costs cover the last 4
seconds. Frame statistics cover 10 seconds, and automatically widen to
30 seconds when a redraw cap leaves fewer than 4 frames in the window —
so a 1 fps or 5-second cap still produces meaningful `fps` and p95
numbers instead of `0`. The panel prints which window it used.

### Sorting and long lists

Every column header in the Timing, Nodes and Stalls tables is a sort
button: click to sort by that column, click again to reverse, click a
third time to go back to the table's default (most expensive first).

Two details that matter on live data:

- Sorting uses the underlying numbers, never the displayed text.
  As text, `1,234.5ms` sorts before `9.2ms`.
- A row with no value for the chosen column (`—`) sorts **last in both
  directions**. A dash means unmeasured, not cheap — a node pack that
  never reported off-frame time should not outrank one that did.

Ordering is frozen while the pointer is inside the table, so rows do not
move out from under your cursor during the twice-a-second refresh; an
explicit header click still applies immediately.

A thousand-node graph produces several hundred owners and node types.
Rendering all of them twice a second costs real milliseconds, so the
tables render the most expensive 120 owners / 60 node types / 60 scripts
and print how many are hidden, with a **Show all rows** button that lifts
the cap for that tab. The caps live on `window.__antsTracker.rowCaps`
(`{ timing, nodes, stalls }`), so a console can lower them further — the
Stalls tab will happily show you what this panel costs if you get greedy.

The panel also measures its own refresh and backs off when a pass costs
real time: over 6ms per pass it refreshes every second, over 12ms every
two seconds, and it speeds back up when the list gets short again. The
Memory tab's "tracker's own footprint" line says when this is happening.

### Timing tab

Rows are *other* extensions (this tracker never lists itself).
Columns: `ms/frame`, `% fr`, `ms/call`, `calls/fr`, plus `off-frame ms`
— hook time that ran outside a canvas draw (from `onExecuted`, a timer,
a DOM event). Off-frame time is real cost but it is not part of a
frame, so it is kept out of the budget instead of being silently folded
into the next frame the way v1 did.

Red = above 15% of the frame, orange = above 5%, both relative to the
frame budget rather than an absolute millisecond count.

Expand a row (▸) for the per-hook breakdown: which hook
(`onDrawForeground`, `onDrawBackground`, `onDrawCollapsed`,
`onBounding`), per-hook `ms/frame`, calls, and off-frame numbers.

Node types that assign their **own** `this.onDrawForeground = ...`
inside `onNodeCreated` — a common pattern, invisible to v1 — are adopted
while drawing and listed as `(unattributed) <Type> · instance hook`
(named after the extension when that can be inferred). Hooks that were
already present on a node prototype before this extension loaded are
adopted too, and labelled `(pre-existing) <Type>`.

When an instance hook *delegates* to the prototype method (or one
extension wraps another's hook), the same work appears in two rows. The
outer row carries the milliseconds and the inner one is tagged
**nested**: its calls are counted, its time is not, because the outer
hook's measured time already contains it. That is what keeps the table
adding up to the frame budget instead of reporting double the truth —
and it is why a row can legitimately show `calls/frame 2.0` with
`ms/call —`.

### Nodes tab

Where the frame actually went, measured around LiteGraph's own calls
rather than through extension hooks:

- **drawNode** — per-node chrome: title bar, borders, slots, widgets,
  embedded preview bitmaps. Split into `wrapped hooks` (the part the
  Timing tab already accounts for) and `LiteGraph chrome` (everything
  else in `drawNode`).
- **drawConnections** — link rendering, usually negligible on a big
  graph and usually a surprise when it isn't.
- **everything else** — the rest of the frame. If this line is big,
  the cost is in a canvas method this tool does not wrap, a widget's
  own `draw()`, or a Nodes-2.0/Vue component; the Stalls tab is the
  next place to look.

A per-node-type table follows, sortable by any column. `calls/frame` is
calls per redraw of the canvas, so for a type painted every frame it is
close to the number of instances on screen, and a value well below 1
means most of that type is off-screen or culled on a given redraw. The
interesting pair is `% of frame` (how much of the budget this type eats)
and `ms/call` (whether that is one heavy node or many cheap ones). A
sampled `canvas.setDirty()` caller table follows — see Stalls below.

### Stalls tab

Frame cost is not the only way to lose FPS, so this tab reports
main-thread blocking *outside* the draw path, from Long Animation
Frames (Chrome 123+) with a `longtask` fallback. Columns, all sortable:

- **blocking ms/s** and **stalls/s**, the honest headline numbers.
- **where** — script URL, function name, source line, and the
  extension pack when the script lives under `/extensions/`. Scripts
  from ComfyUI's own bundle appear as `assets/<file>.js` with pack
  `unknown`, which is itself the answer: it is the frontend, not a custom
  node pack.
- **invoker** — e.g. `TimerHandler:setInterval`, which names the
  mechanism behind a heartbeat.
- **count / blocking / % of blocking / ms per stall / worst** — a high
  count with a low ms-per-stall is a cheap heartbeat; a low count with a
  high ms-per-stall is one expensive operation worth a DevTools trace.
- **forced layout ms** — style/layout time inside the long frame,
  which is the signature of a DOM-thrashing extension.
- **redraw requests/s by caller** — `canvas.setDirty()` wrapped
  exactly (the request rate is precise) and its call stack sampled
  ~20×/second to say *who* is asking for redraws. A rogue heartbeat
  shows up here by name instead of as "something is ticking".

This tab also names **this panel** when the panel itself stalls the
thread — look for `ANTs_ComfyUI_Frontend_Performance_Tracker/tracker.js`
— and the Memory tab's "tracker's own footprint" block gives the
per-second cost. If those numbers are not small, say so: it is a bug.

### Governor tab

The Stalls tab tells you *what* blocked the main thread; this tab is the
one that can do something about it. Every `setInterval`, `setTimeout`
and `requestAnimationFrame` the page registers after this module loads
is measured by source — function name, the file that registered it, the
delay it asked for — and each source can be given a limit:

| Limit | Effect |
| --- | --- |
| normal | measured only: same call, same arguments, same ids |
| ½ speed / ¼ speed | one run per 2× / 4× the delay it asked for (floored at 33ms / 66ms) |
| 2/s, 1/s | one run per 500ms / 1000ms |
| paused | the callback is not run at all |

Two rules make it safe to leave switched on:

- **A source on "normal" is untouched.** Same arguments, same `this`,
  and the ids returned by `setInterval`/`setTimeout` are the browser's
  own, so `clearInterval`, `clearTimeout` and `cancelAnimationFrame`
  keep working exactly as before. That is why the table can report
  "was 50/s before the limit, now 12/s" without having changed anything
  until you asked it to.
- **A limited source is slowed, never silenced.** A skipped interval
  tick is covered by the next one; a skipped one-shot or chained
  `setTimeout`/rAF callback is re-scheduled for when its window opens,
  and a callback that re-registers itself is respected, so a loop
  cannot be killed or duplicated by accident. The only exception is
  "paused", which is exactly what it says.

Above the table: the frame budget, the rAF governor (`off` = measure
only, `adaptive` = skip rAF ticks while the main thread is behind the
budget and mouse/keyboard are quiet, or a fixed floor in Hz), redraw
merging, the input guard, and the trace threshold. Limits and controls
live in `localStorage` (`ants-governor-v1`) so a tuning session survives
a reload; **Reset to untouched** clears them, and **Suggest limits from
this session** proposes a limit per source from its measured cost —
nothing is applied until you pick it.

**Autopilot** (off by default) is for the case this tab was built
around: you open it, see one row burning 646 ms/s with 0 skipped, and the
question is which policy to pick. With the autopilot on, the layer caps
the worst source it is allowed to touch every five seconds until the
limitable sources are under the target you set (150/250/400/600 ms/s),
then stops and prints what it did — *"limited renderFrame to 2/s (it was
burning 646 ms/s, ≈600 after — still 1208 ms/s in total)"*. When the row
it just capped is still the worst thing on the page it steps the same row
up the ladder next round, so a 316ms-per-run chain ends at 1/s rather
than sitting at a 2/s cap that changed nothing; when a row reaches 1/s
and is *still* too expensive, it says so — *"renderFrame is at the
tightest cap a limit can use (300 ms/s left) — that loop needs fixing at
its source"* — instead of pretending the problem is handled. It never
touches the tracker's own timers, never touches rAF loops (those have
their own governor), never touches a limit you set by hand, and **Reset
to untouched** turns it off and lifts everything.

Two rules make the difference between a limit that works and one that
only looks like it does, and both came out of a real CPU-rendered page:

- **A limit has to be wider than the source's own period to bite.** A
  timer that asks for 10ms but takes 300ms of work runs every ~300ms, so
  "half speed" (33ms) and "quarter speed" (66ms) change *nothing* for it —
  only `2/s` or `1/s` do. The table now says so on the row's `allowed`
  cell (`33ms — no effect`), and the autopilot and **Suggest limits**
  both skip the multipliers and go straight to a cap for a source like
  that (measured against its own runs, not against the delay it asked
  for).
- **The ranking is by cost, not by rate.** Both real offenders on that
  page ran 1.3–3 times a second, so anything that filtered on "runs
  often" missed them entirely and offered limits to a dozen 0.1 ms/s
  heartbeats instead.
- **A limit that bites but does not help is a sticker.** A cap that
  leaves a source at 97% of what it cost before (a 316ms-per-run chain
  capped at 2/s) looks like a working limit in every table. So both the
  suggestion engine and the autopilot aim at a *cost* instead of at a
  gap: the suggestion engine at half of what the row is burning, the
  autopilot at whatever brings the page to the target you set. The
  mildest limit that reaches that cost wins, and neither goes below the
  floor (30 ms/s by default) — a 20ms heartbeat still gets half speed,
  while a runaway chain gets 1/s, because nothing milder is worth the
  behaviour change it costs a page whose extension owns that loop.

**Low-zoom drawing** is the answer when the problem is not *when* the
canvas draws but *what* it draws. At low zoom on a big graph, every node
is inside the viewport (so a culling scan has nothing to remove), each
one is a few dozen pixels wide (so its title, slots, widgets and preview
are invisible anyway), and a redraw costs hundreds of milliseconds — at
which point there is nothing to schedule: the cost is the drawing itself.
The mode paints every node as a flat rectangle below a zoom you pick,
degrades the links (thinner strokes, curves kept), hides the DOM content
of the nodes it boxed, and rate-limits redraws while nobody is touching
the page.

**Redraw merging** is the other half of the same idea. `setDirty`
requests were already counted exactly (and the Testing tab's cap can
delay them); with merging on, requests inside one frame are combined:
the first goes through, later ones only pass on flags the frame has not
asked for yet, and a request that asks for nothing new is dropped and
counted. Nothing is ever cleared, so the worst case is one extra redraw
— never a stale canvas.

**Long-frame traces** record frames over a threshold (50ms default) with
the scripts the browser named inside them, their forced layout, which
governed sources ran inside that window with what cost, which limits
were active, and which script asked for a redraw while the frame was
blocked ("state was mutated / a redraw was asked for by"). This is the
card for one of your own `renderFrame @ .../settingStore-*.js` frames:
the Scripts tab names the frame, this card says what else was in it and
who made it long. Click a row to expand it.

**Off-thread lane**: a worker is offered for pure computation, with a
sanity check that runs the same seeded sort-and-sum on both threads and
compares the answer. The boundary is worth being blunt about: Vue's
render, the DOM and canvas drawing cannot leave the main thread — no
scheduler can move them, and `OffscreenCanvas` only helps an application
that created its canvas that way (ComfyUI does not). That is why the
answer to a 280ms redraw is not a thread but *less drawing*: see
**low-zoom drawing** in the Tweaks tab, which paints every node as one
rectangle below the zoom you pick, thins links instead of straightening
them, hides the DOM content of the nodes it boxed, and rate-limits
redraws while nobody is touching the page. What a scheduler
layer *can* do is serialise and rate-limit the main thread's competing
tick sources, which is what this tab is for.

**"normal" means no gate at all.** A source on `normal` is not rate
checked even against the delay it asked for: the browser fires "100ms"
timers a millisecond or two early under load, and a repaint interval
that loses those ticks stops repainting. Limits are per *row* (tuning a
row is how you tell this tracker that one heavy function used by three
graph views is one offender), while the deferred copy that a skipped
tick needs is per *chain*, so one chain's pending copy can never starve
another's.

**It fails open, and it can be switched off.** A profiler that replaces
`setTimeout` is patch-level surgery on somebody else's application, so
every wrapper catches its own errors, a callback that could not be
measured is still registered and still runs, and after three internal
errors the layer restores the browser's own timer functions and stops
governing anything — the panel and the copied report both say so, and
**Turn the layer off** does the same on demand. The Governor also
measures and reports its own bookkeeping cost, and the tracker's own
timers are exempt from limits (marked as such in the table). Without
`Worker`/`Blob` support the lane says so and answers on the main thread
instead of pretending.

### Load tab

Page-load cost per extension pack from the browser's own Resource
Timing data, reported as a **span** (first request → last response, so
parallel fetches are not summed into an impossible number the way v1
did) with file count, slowest file, and cache-served count. A pack can
be heavy to load and cheap to run, or the other way around.

### Memory tab

JS heap (Chromium only — Firefox does not expose
`performance.memory` to page JS at all, by design). Set a baseline,
then mute a suspect and watch the trend — **MB/min** and a sparkline,
so you can see whether a muting experiment changed the slope instead of
comparing two noisy snapshots. No per-extension breakdown is possible
here; that is a browser boundary, not a missing feature.

### GPU / VRAM tab

Genuinely unobtainable from page JavaScript: *per-extension* VRAM.
That is stated in the tab rather than faked. What the tab does show,
all of it real:

- Per-device VRAM totals and free space, and the VRAM headroom
  percentage (turns red under 10%), from ComfyUI's own `/system_stats`.
- Torch's allocated/reserved view next to the driver's numbers; a large
  gap between them is normal caching, a growing `reserved` with flat
  `allocated` is fragmentation.
- Optional nvidia-smi side-channel: utilization, temperature, power,
  and per-process VRAM, via the `/ants_tracker/gpu` route added by this
  extension (see below). If nvidia-smi is missing, the tab says why
  instead of showing nothing.

## Optional backend route

`__init__.py` registers one read-only route:

```
GET /ants_tracker/gpu
```

It runs `nvidia-smi` (2-second in-process cache, 5-second timeout) and
returns either

```json
{"available": true, "gpus": [...], "processes": [...]}
```

or `{"available": false, "reason": "..."}` — no NVIDIA tooling, a
timeout, or no GPUs are all reported as a reason, never as a crash.
Absolute paths and `[N/A]` fields are handled; unparseable numbers
become `null` instead of `NaN` or a fabricated 0. `/system_stats` is
used first and always works even when this route does not, so the tab
degrades field by field.

## Testing tab

Four tools, all opt-in, none persisted across a reload:

- **Canvas redraw rate cap** (Off … 1 redraw / 10s) — delays any real
  redraw arriving sooner than the chosen interval, regardless of what
  asked for it. Unlike v1, a capped redraw is **deferred, not
  dropped**: exactly one trailing redraw is scheduled so the canvas
  cannot be left showing stale pixels, and the Testing tab counts
  capped vs. deferred redraws so you can see the mechanism working.
  The fps number in the summary bar should settle near your pick; that
  is it working, not a bug. This doubles as a genuine, low-risk
  mitigation for huge graphs — if a workflow feels fine capped at
  15fps, that is immediate relief with no node-code changes.
- **Synthetic forced-tick generator** — forces a full redraw at a
  fixed, known interval. It shares the redraw path above, so an active
  cap throttles these ticks too; set the cap to Off first if you want
  to measure the raw cost of a tick.
- **Scripted pan benchmark (A/B)** — the honest way to answer "did that
  change help?". It pans the real canvas along a fixed sine path for
  3/6/10 seconds, forces the redraws itself, and reports mean ms/frame,
  p95, fps and attributed share **over exactly that span**, so two runs
  are comparable even though your hand is not. Run A (current state),
  mute something, run B, and the delta line says how many fps and
  ms/frame you gained — with a warning if A and B were not captured
  under the same mutes. The graph is restored to its original offset
  and the node count is recorded with each run.
- **Mute list / clear** — everything currently muted, with one-click
  unmute, plus the live count of node types being drawn.

## Muting: what it does and does not do

**Mute** on a Timing row skips that extension's draw hooks outright —
`return undefined`, no timing, nothing drawn by those hooks. This is
the bisection tool: mute a suspect and watch the fps number change.

- Muted owners keep their row (marked `muted`, with a **skipped N
  calls** counter) even if they go completely idle, so a mute can
  always be undone. v1 could delete a muted extension's row after 4
  seconds of silence, leaving the hooks permanently skipped with no
  visible way to unmute short of a page reload.
- Muting changes what is drawn by definition, and an extension can take
  a different code path afterwards (caches, internal state). Treat a
  muted/unmuted delta as an upper bound on that extension's cost, not
  an exact price list. The scripted benchmark records the mute set for
  exactly this reason.
- Mute state is per page load. Nothing is written to disk.

## What this can't catch

- Anything drawn by a widget's own `draw()`, by a Vue/HTML node (the
  Nodes 2.0 style frontend), or by a canvas method this tool does not
  wrap is not attributed *by name*. It still lands in the Nodes tab's
  "everything else" line, and if it blocks the main thread it lands in
  Stalls with a file and function. It just cannot be named by extension.
- Per-extension GPU memory. Not obtainable in any browser; the GPU tab
  does not invent it.
- `fps` and frame cost here are JS/canvas cost. Compositor and GPU time
  are not visible from the page.
- Redraw callers are sampled (~20/s), so a source that requests
  redraws in rare bursts can be missed between samples. The total
  request *rate* is exact.
- Firefox exposes neither `performance.memory` nor long tasks; the
  Memory and Stalls tabs say so rather than showing zeroes.
- A hook's share of frame is a share of the *mean* frame in the same
  window, not of the specific frame it ran in.
- The Governor can only see what is registered after this module loads.
  A long-lived timer created at page bootstrap that never re-registers
  is invisible to it (ComfyUI's own rAF loops re-register every frame,
  so they are picked up).
- Nothing can move Vue's render, the DOM or canvas drawing off the main
  thread. The Governor removes work from the main thread by making
  offenders run less often, not by parallelising them.

## Compatibility note

This assumes the classic LiteGraph canvas frontend
(`app.canvas.constructor.prototype.draw`, `.drawNode`,
`.drawConnections`, `.setDirty`, and `nodeType.prototype.onDraw*`). If a
ComfyUI frontend version changes these internals, each patch point
degrades on its own *and the panel says which one failed*:

- losing `draw` costs you frame totals, fps, the budget and unattributed
  time,
- losing `drawNode`/`drawConnections` costs you the Nodes tab's split,
- losing `setDirty` costs you redraw-caller attribution,
- per-extension hook timing keeps working regardless of any of them.

Canvas patching is retried for ~20 seconds after load (v1 tried once and
gave up if the canvas was not ready), and a console warning is still
logged for DevTools.

## Development

```
node tests/run-tests.mjs          # 116 tests, no dependencies, no browser
node tests/run-tests.mjs timing   # filter by name fragment
python3 tests/test_init.py        # backend route parsing + graceful fallbacks
node tests/demo.mjs               # print what the panel says, with no ComfyUI
```

`tests/demo.mjs` drives a synthetic graph (two packs, four node types, a
status heartbeat, one long animation frame per second) through the real
tracker and prints the summary bar, all eight tabs and the text report —
the fastest way to see exactly what the panel reports without installing
anything, and a useful before/after when changing the UI.

The JS suite loads `web/tracker.js` into a fake browser and a fake
ComfyUI/LiteGraph with a controllable clock, then asserts the numbers
(per-frame attribution, budget additivity, mute semantics, cap
deferral, fps under loose caps, instance/pre-existing hook adoption,
stall and redraw attribution, panel row identity, and the A/B
benchmark) rather than only the code paths. The Governor has its own
suite: limits applied to a real foreign heartbeat, the "slowed, never
silenced" guarantees (a deferred callback still runs; a source that
re-registers itself is not duplicated), adaptive rAF with the input
guard, merging semantics, persistence, the trace contents, and the
worker lane's fallback when there is no `Worker` — plus a suite that
exists to keep the layer from breaking the page it measures: nothing is
skipped or deferred while nothing is limited, several chains sharing one
row do not starve each other, and internal errors fail open and end in
the layer turning itself off — and a suite that keeps it from becoming
the scapegoat: relayed frames are attributed to the source measured
inside them, and the saved timer functions are called with a receiver
Chrome accepts (the fake timers can be made Chrome-strict for that) — and
a suite for the parts that have to target the *right* source: a
suggestion for a slow, expensive chain has to be a cap that can bite it,
a cheap heartbeat still gets the mildest limit, and the autopilot has to
leave rAF loops and the tracker's own timers alone. Two fakes exist because
the drawing work needs them: `makeStubCtx()` is a *class* whose prototype is
installed as the sandbox's `CanvasRenderingContext2D` (the preview ladder
patches `drawImage` there, the same way a browser exposes it), and
`createImageBitmap` records the resize it was asked to perform instead of
resizing anything.

## What changed in v2.1.11

- **Component widgets are hidden through the frontend's DOM widget layer.** The
  core 3D nodes (`Save 3D (Advanced)`, `Save 3D Model`, `Preview 3D`, point
  clouds) build their viewport as a `ComponentWidgetImpl`, and the frontend
  renders it in a separate layer — one wrapper per widget, positioned at its
  node's origin, with nothing on the widget object pointing at it. v2.1.10
  stopped setting the canvas's low-quality flag, and that flag turned out to be
  the *only* thing that made `hideOnZoom` hide anything (`DomWidgets.vue` reads
  `hideOnZoom && lowQuality`), so those viewports went back to floating over
  their own flattened rectangles. The sweep now finds the wrappers directly:
  each one is positioned at its node's origin in client pixels, so the owning
  node is found by containment in graph coordinates, and the same
  `.ants-lod-box` class that hides every other DOM widget is applied. No element
  handle, no per-widget layout read, and it is handed back on the same sweep
  that unboxes the node.
- **The panel stops claiming work it is not doing.** `hideOnZoom` only takes
  effect in the frontend's low-quality mode, which this tool deliberately no
  longer switches on, so the readout now separates the two: elements hidden by
  class (real, now including the 3D viewports), and widgets carrying the
  hide-on-zoom flag (real only when the frontend's own LOD is on).
- **The links line tells you where the connections stage actually goes.** Every
  `renderLink` call is now timed, so the panel can split the stage in two: the
  strokes themselves (what a link setting can change) and the rest — the
  frontend walking every input slot of every node in the graph before it decides
  which links are on screen, which no ink setting can reach. On a graph with a
  thousand nodes that second part is the larger one, and pretending otherwise
  would be the dishonest part of a performance panel.
- **"Measure link thinning" — the panel answers "does this actually help?" with
  a measurement instead of a claim.** It alternates the setting on and off,
  1.2 s each, three times over, and compares the connections stage of the same
  page against itself, then reports the delta in ms/frame with the frame counts.
  Nothing is saved, nothing else changes, and the setting is put back when it
  finishes. If the difference is inside the noise it says so.

## What changed in v2.1.10

- **Link thinning is a link setting, and nothing else.** It used to put the canvas
  into the frontend's low-quality mode for the frame it was thinning: that skips
  node shadows and rounded corners, and it is the same flag ComfyUI consults
  before placing widgets that asked to hide when zoomed out. On a page whose zoom
  sits below the thinning threshold, the visible result was *nodes looking
  half-flattened all the time* — a link setting quietly repainting nodes. The
  flag is no longer touched at all. The setting now changes exactly two things,
  for the one call that draws a link: the stroke is 1px instead of 3, and the dark
  outline under it is skipped. Both are put back immediately.
- **Straight links are opt-in, and no longer follow the node setting.** The link
  dropdown had an `auto` answer — "straight while the graph is rectangles" — which
  meant the *node* setting decided the shape of a link. That is gone: the choices
  are **keep every curve** (the default, and what ComfyUI draws) and **always
  straight lines**. A saved `auto` becomes "keep every curve" and the panel says
  the setting changed hands. So flattening never straightens a link, and thinning
  never touches a node: each setting changes its own subject and nothing else.
- The panel's readout for these settings now states that promise in words, and
  the test suite holds it to it: nodes are asserted to be drawn by LiteGraph's
  own path, outside any borrowed low-quality frame, with the canvas flag exactly
  as ComfyUI left it, while links are thinned.

## What changed in v2.1.9

- **The node threshold is a zoom now, not a node size.** "Nodes under 64px" asked
  the wrong question. A node's size on screen is not a property of the camera: a
  JS node that hides, greys or adds a widget while you work changes its own size,
  so a pixel rule paints the same node flat on one frame and draws it in full on
  the next — and the nodes that move are exactly the ones with dynamic UIs, whose
  widgets are the thing you were looking at. The setting is now **flat nodes below
  N% zoom** (5% to 50%, off by default): one decision per frame, taken from the
  camera, applied to every node the same way, and nothing at all is touched above
  the zoom. A node being small can no longer flatten anything on its own. The
  zoom rule also removes the sampling: the panel can say exactly how many nodes
  are rectangles instead of estimating a share from 64 samples.
- **Links follow the same trigger.** `auto` (the default) means "straight while
  the graph is rectangles" — the v2.1.4 behaviour, now tied to the same zoom
  instead of to a sample of node widths, so the link style and the node style
  cannot disagree about whether the graph is being flattened.
- **Collapsed nodes and this tool's own node are never flattened**, and the node
  you have selected keeps its outline, so a rectangle at 10% zoom still tells you
  what is selected.
- **A pixel setting carries over once, and says so.** If `localStorage` holds a
  v2.1.8 record, its `minPx` is translated to the nearest zoom below (64px on a
  typical 350px node is 18%, so 20%), and the panel explains the change with the
  old number quoted until you pick a value yourself. Nothing else about the mode
  changes, and an install with no saved record behaves exactly as before.
- **The whole-graph note names what is still walking the graph.** When the graph
  is fully on screen — so culling has nothing to remove — the panel now lists any
  periodic source whose worst run is over 120 ms by name, with its worst time and
  rate, because a scan that costs 800 ms in one go is worth capping even when its
  average looks small.

## What changed in v2.1.8

- **A tab of its own, first in the row: Tweaks.** The drawing settings used to
  live halfway down the Nodes tab, under a budget table they have nothing to do
  with. They are now the first tab — the one place a person goes to *change*
  something, with the other tabs answering questions — and the Nodes tab keeps
  what it is for: where the frame went, per node type, and who asks for redraws.
- **Link drawing is its own setting.** v2.1.4 tied straight links to the node
  threshold: flatten most of the graph and the links went straight with it, which
  is exactly the shape a workflow built out of curves cannot survive. There is
  now a link-style dropdown — **straight while the graph is rectangles** (the old
  behaviour, and still the default), **keep every curve**, or **always straight
  lines** — independent of the node threshold and of the thinning setting. The
  three are meant to be combined: flattening decides what a node costs, the link
  style decides a link's shape, thinning decides how much ink that shape uses.
  "Keep every curve" with thinning on is the combination the old design made
  impossible.
- **Vue-component widgets are boxed with their node.** The core 3D nodes
  (`Save 3D (Advanced)`, `Save 3D Model`, `Preview 3D`, point clouds) build their
  viewport as a `ComponentWidgetImpl`, which — unlike an image or a curve editor
  — has **no `element` of its own**: the frontend renders the wrapper in its DOM
  widget layer. So v2.1.6's element hook never saw them, and a boxed node kept a
  live 3D viewport on top of its rectangle. The sweep now recognises component
  widgets by their `component` and stands them down through the same
  `hideOnZoom` flag, which is what the widget store consults before positioning
  anything. Nodes whose visuals are canvas-drawn (not DOM) are untouched, and
  everything is restored when the node is drawn properly again.
- **The settings are remembered across sessions.** The five drawing settings are
  written to `localStorage` (`ants.lowZoom.v1`) as you change them and restored
  on the next page load, before the first frame draws, so the panel's controls
  and the canvas agree from the start. An install nobody has configured has
  nothing saved and behaves exactly as before; "Back to full drawing" clears the
  saved state along with the settings.
- **Stalls that are the canvas repaint say so.** The Stalls tab is titled
  "main-thread blocking that is NOT canvas drawing", and on a page with the
  drawing optimised the biggest row is often the repaint itself — a display-lane
  source, tagged **canvas repaint** in the table, so drawing time and genuine
  stalls are not read as the same thing.

## What changed in v2.1.7

- **A cap on the thing that repaints the page is now lifted while you are
  dragging.** A limit is a bet that the tick it skips is a tick nobody sees.
  That bet holds for a heartbeat polling state and fails hard for anything that
  draws: on a 4K graph the source that repaints the canvas is a timer, and
  capping it to 1/s turns a pan into a slideshow — the page asks for a redraw
  on every pointer move and gets one per second. So a source that has ever run
  the canvas draw *inside itself* is marked as part of the **display lane**
  (shown as `· display` in the Governor table). Two things follow: the
  autopilot never suggests a limit for a display-lane source, and while a
  pointer, wheel or key event has arrived recently its cap is lifted to about
  30 runs a second, back to the limit the moment the input stops. The ticks that
  ran only because of that lift are counted and reported, which turns "is my
  drag slow, or is my own limit the thing making it slow?" into a number.
- **A boxed node's DOM widget now also leaves the per-frame layout pass.** v2.1.6
  hid the elements of a boxed node with one CSS class. That stops them being
  *painted*, but not the frontend stepping through every DOM widget of every
  node on every drawn frame to set its position and z-order — on a graph of a
  thousand DOM widgets that is a thousand components' worth of layout work per
  redraw, for content that is currently a rectangle. ComfyUI's own escape hatch
  is `hideOnZoom`, which its widget store consults before doing any of that:
  while a node is a rectangle, its widgets get that flag (the ones that already
  asked for it are left alone, and image and video previews deliberately ask for
  the opposite), and they get their own value back the moment the node is drawn
  properly again. If the option object is frozen the class still hides the
  element, so the fallback is exactly the old behaviour. The panel reports how
  many widgets left that pass, and the API exposes the widget objects themselves
  rather than only a count.
- **Cost per second, not just cost in the last four seconds.** A scan that runs
  every 700ms and does real work on some of its runs can look cheap in a
  4-second window (its early-exit runs land there) and be expensive in fact.
  Rows now carry the figure that catches it: mean run cost × current rate. The
  autopilot and the suggestions rank by the larger of the two, the Governor
  table's tooltip shows both, and the reason line of an applied limit says when
  they disagree. This is how a third-party culling pass that costs ~150ms/s
  while reporting single-digit ms/s gets offered a limit instead of being
  skipped for looking cheap.

## What changed in v2.1.6

- **Links are degraded, not straightened.** The old "links straight"
  option is the one thing a spline-based workflow cannot survive: the
  author placed the nodes to be read through the curves, so replacing
  them with lines is a different graph, not a cheaper one. The new
  setting — **links thinned below N% zoom**, 60% by default — keeps
  every curve exactly where it was and changes how much ink it takes to
  lay them down: strokes are 1px wide instead of 3, and the dark outline
  ComfyUI draws under each link is skipped. That outline is a *second
  full stroke* 4 units wider than the link (`render_connections_border`,
  on by default), so on a long link it is most of the pixels the redraw
  spends. Both are set on the canvas for the duration of that one
  `renderLink` call and put back before it returns, so hit-testing,
  dragging, selection and the panel never see the change. Measured on the
  4K graph this was built for: 976 links cost ~101ms/frame as splines and
  ~22ms as straight lines, and the difference between those two numbers
  is the outline plus the extra width — this recovers a large part of it
  *with the shapes intact*. Curves whose endpoints are close together
  barely change at all; that is the point. The straight-line option
  remains, but it is now described for what it is: a mode for graphs
  already built out of straight links, where most nodes are rectangles
  anyway.
- **The DOM content of a boxed node is hidden with it.** Nodes whose
  visuals are DOM — Nodes 2.0/Vue nodes, and any node with a DOM widget
  (image and video previews, curve editors, custom node UIs) — live in
  absolutely-positioned elements *on top of* the canvas and were
  completely unaffected by flattening: the node became a rectangle and
  its contents stayed at full size on top of it, which is the worst of
  both. While a node is drawn as a rectangle, its elements get one CSS
  class (`ants-lod-box`, `display: none`), and the class is removed the
  moment the node is drawn properly again — zoom in, raise the threshold,
  switch the mode off, or let it fail open, and the page is exactly as it
  was. Nothing is moved, re-parented or edited; Vue nodes are found by
  their `data-node-id` attribute and DOM widgets through the `.dom-widget`
  wrapper ComfyUI positions. The panel and the report say how many
  elements of how many nodes are hidden, so "nothing happened" is never
  the only evidence. The set is re-checked when the zoom or the setting
  changes and once a second, so nodes and widgets that arrive later (a
  workflow load, an execution result) are picked up too.
- **The frontend's own low-quality rendering is brought forward to your
  zoom.** ComfyUI already has a cheaper drawing path — no node shadows,
  no rounded corners, no link outline — gated on a font-size threshold
  ("Zoom Node Level of Detail", 8px by default) that on a 4K screen at
  10% zoom may or may not have engaged on its own. Below the zoom you
  pick (60% by default), this tool now switches that flag on for the
  duration of each frame and hands it back in a `finally` block, so what
  you see is what ComfyUI itself
  draws when you zoom out far enough. If a frontend version does not
  expose the flag, the panel says so instead of pretending: the link
  thinning above does not depend on it.
- **The panel says what it did.** A new line in the low-zoom block
  reports link segments thinned per frame and whether the low-quality
  path is in use; a second reports DOM elements hidden, or that there
  was no DOM content to hide on the nodes this threshold catches (their
  visuals are canvas-drawn). The text report carries both. The preview
  counters stay where they were — 489 of 496 image draws served from
  thumbnails on the 4K test page, which is the answer to "do thumbnails
  even work": they do, and what they recover is bounded by how much of
  the frame the previews are; on a graph painted mostly by node chrome
  that is a smaller number than it looks.

## What changed in v2.1.5

- **Nodes under N px now reaches 4K.** The ladder was 8/12/16/24/32px, which
  assumed a node lands at 32px or less when the graph is zoomed out. On a 4K
  screen at 10% zoom a node is around 43px wide, so the setting caught almost
  nothing and the report looked like the mode had no effect. The ladder is now
  0/8/12/16/24/32/48/64/96/128/192/256px, covering that case and the ones past
  it. The panel also stops leaving you to guess: it reports what share of the
  graph the current setting catches at the current zoom, and, when it catches
  little, the width of a typical node and the setting that would flatten most
  of the graph. *"Nodes under" is a property of the zoom, not of the graph* —
  at 10% on a 4K screen the answer is 48 or 64, not 32.
- **New: image previews are served from thumbnails** (on by default at 60%
  zoom, one dropdown to change or switch off). Image, preview, load and compare
  nodes blit a full-resolution bitmap into whatever box the node occupies —
  a 4096px image into a 40px box, several times a second. Below the zoom you
  set, those draws are served from a cached copy at about the resolution the
  screen can show, taken from a ladder of 64/128/256/512/1024/2048px on the
  long side: 64px at 10% zoom, 512px around 60% for a big node. So the same
  image can have several copies, one per size the zoom asks for, and never a
  copy of a copy. Only image draws that happen *inside* a node are touched
  (the graph's own icons and grid are not), only when the destination is
  smaller than the source, and only until the copy exists: the frame that
  discovers a new image still draws the full one, so what you see never goes
  blank. The cache holds at most 48 thumbnails and 64 MB (oldest first out), it
  reports how many draws it served, how many it skipped and how much memory it
  is holding, and eight failures switch it off rather than keep retrying.

## What changed in v2.1.4

- **New: low-zoom drawing** (Nodes tab, off by default). The frame budget
  on a big graph at low zoom is not a scheduling problem — it is a
  thousand nodes being drawn properly several times a second, and at
  zoom 0.10 the whole graph is inside the viewport, so culling has
  nothing to remove. Three levers, one switch, all of them reversible
  and all of them measured by the same wrapping of `drawNode` /
  `drawConnections` that produced the numbers they change:
  - nodes that land under N px on screen are painted as one flat
    rectangle (N = 8/12/16/24/32, or off),
  - links are painted as straight lines while most of the graph is that
    small, and go back to LiteGraph's renderer the moment you zoom in,
  - and while no pointer, wheel or key event has arrived for a moment,
    redraws are rate-limited (4/s, 2/s, 1/s, or off) — a rate limit, not
    data loss: the last request of a burst still gets one trailing
    redraw, and the first touch lifts the cap instantly.
  Anything that throws inside the cheap path switches the whole mode off
  and falls back to the original draw call, with the reason printed in
  the panel: a rendering change a tool cannot explain must never be left
  half-applied on somebody's canvas.
- **The frontend's own LOD is shown next to ours.** ComfyUI has a
  `LiteGraph.Canvas.MinFontSizeForLOD` setting (default 8px, `0`
  switches it off) that flips `canvas.low_quality` below a zoom
  threshold — and when it is on, it still only skips shadows and
  rounded corners, it does not draw fewer nodes. The block reads the
  canvas and says which state it is in, because *"my frames are slow
  with LOD on"* deserves an answer rather than a shrug.
- **New: a culling reality check.** The same block reports how many nodes
  are inside the viewport at the current zoom and how wide they land on
  screen, and says the quiet part out loud when ~all of them are visible:
  *"the whole graph is on screen, so culling cannot save anything here"*.
  That is the answer to "why does my culling extension not help my
  frames?" — and it is measured, not assumed.

## What changed in v2.1.3

- **Fixed: limits that could not bite looked like they worked, and the
  ones that mattered were never suggested.** A source whose runs are
  300ms apart is unaffected by "half speed" (33ms) — and on a real
  CPU-rendered page the two worst offenders (a Vue render chain at
  646 ms/s and a culling scan at 474 ms per run) were exactly that shape.
  Both were also invisible to **Suggest limits**, which required 4 runs/s
  and so offered limits to a dozen 0.1 ms/s heartbeats instead. The
  suggestion engine now ranks by measured cost per second, picks the
  mildest policy whose gap is actually wider than the source's observed
  period (skipping the multipliers when they cannot bite), and the table
  marks such a limit as `no effect`, with the panel and the report
  saying how many limited sources are in that state and how much they
  still cost.
- **New: autopilot** (off by default) — cap the worst source it may
  touch every five seconds until the limitable sources are under a
  target you set (150–600 ms/s), then stop. A row it capped that is
  still the worst stays in play and is stepped up the ladder (2/s → 1/s)
  until it is cheaper or the ladder runs out; a row that reaches the
  tightest cap and is still expensive is reported as needing a fix at
  its source, with what it still costs. Limits set by hand are never
  touched, and every action is logged in the panel and in the copied
  report — with the cost it measured and the cost the cap should leave.

## What changed in v2.1.2

- **Fixed: relayed frames were blamed on this tool.** With every timer of
  the page passing through the layer, Chrome attributed each of those
  frames' *whole* cost to the wrapper in `tracker.js` (it reports a
  script frame's duration inclusively) — on a real page: 891 frames and
  300 s of blocking credited to `(anonymous) @ tracker.js` while the time
  belonged to the extensions whose timers were being relayed. Frames whose
  only named script is this file are now attributed to the source the
  Governor measured *inside* that frame, labelled `(via the tracker's
  pass-through)`; with nothing measurable inside, the row says
  `(pass-through timer)` instead of claiming the time.
- **Fixed: "Illegal invocation" switched the layer off.** The saved
  originals were called as methods of the layer's own bookkeeping object,
  and Chrome throws `Illegal invocation` for `setTimeout`/`clearTimeout`
  called with any other receiver. The originals are now bound to the
  page's global — the fail-open path did its job (the page kept working),
  but it should never have been needed. The `limiter` pill and the copied
  report now give the turned-off state its own wording.

## What changed in v2.1.1

- **Fixed: the scheduler layer could stop the workspace from drawing.**
  A source on `normal` was still gated at the delay it asked for, so a
  100ms repaint interval that fires a millisecond early lost those ticks
  — and when several chains share one row (the same function registered
  by more than one graph view), the shared gate starved them outright:
  measured on a real page, 21,699 ticks skipped, 12,752 deferred, and a
  graph canvas that never repainted. `normal` now means no gate at all,
  and the deferred copy that a skipped tick needs is per chain instead of
  one shared slot. Regression tests cover all three scheduling styles
  (interval, chained timeout, self-scheduling rAF) and assert that
  nothing is skipped or deferred while nothing is limited.
- **Fail open, and a way out.** Every wrapper now catches its own
  errors: an internal failure never stops a callback from running or a
  timer from being registered, and after three errors the layer restores
  the browser's own timer functions and turns itself off. The panel
  reports when that happened, the report leads with `TURNED OFF`, and a
  new **Turn the layer off** button does it on demand.

## What changed in v2.1

- **New Governor tab** (see above): per-source limits on the page's own
  timers and rAF callbacks, an adaptive rAF gate with an input guard,
  redraw-request merging, long-frame traces, and an off-thread lane.
  Everything is opt-in and persistent; with the defaults the only
  difference is that these sources are measured.
- **Traces name the caller.** A long frame now records which script
  asked for a redraw while it was blocked, so a frame attributed to
  ComfyUI's own `renderFrame` can be traced back to the extension that
  triggered it (and to the ticks that ran inside it).

## What changed in v2

Fixed (all of these had regression tests written against the v1
behaviour first; see `REVIEW.md` for line references):

- **Muting could permanently hide an extension.** v1 deleted a
  silent extension's stats bucket after a few seconds; wrapped hooks
  kept writing into the orphaned bucket, so the row — and the Unmute
  button with it — was gone for the rest of the session while the hooks
  stayed skipped.
- **Hook time outside a frame was attributed to the next frame**, could
  make "attributed" exceed "frame", and could force "unattributed" to
  clamp at 0.00ms. Off-frame time is now its own column.
- **The unit was milliseconds per 4 seconds**, so every row's number
  scaled with how fast you panned and could not be compared to a frame
  budget. Now `ms/frame` and `% of frame`, with window sums only in the
  detail view and the text report.
- **`fps` was 0 or wrong under the loose caps the Testing tab offers.**
  Now computed from intervals over a 10s window that widens to 30s.
- **The panel rebuilt itself via `innerHTML` every 500ms** — scroll
  position reset, rows moved under the pointer, focused controls were
  destroyed. Rows are now updated in place.
- **The redraw cap dropped frames** instead of deferring them; one
  trailing redraw is now guaranteed.
- **The canvas patch was attempted once**; now retried, and failures
  are reported in the panel.
- **The shared-tick detector guessed** a period from call-count
  multiples. Replaced by measurement: exact `setDirty` request rate
  plus sampled call stacks and Long Animation Frame invokers.
- **Load times summed concurrent fetches**, which could exceed the page
  load itself. Now a span.
- **Instance hooks and pre-existing hooks were invisible.** Now adopted
  and labelled.
- **No percentiles, no stalls lane, no self-cost check, no pause.**
  All present now: p50/p95/p99 frame time, the Stalls tab, the
  tracker's own footprint (wrapped hooks, ring memory, panel cost per
  second) in the report, and Pause/Reset.

Also new: ring buffers are typed arrays written in place instead of
allocating one object per hook call and shifting arrays, and long tables
render the top rows with an explicit count of what is hidden (a
10,000-hook graph made the panel itself a visible entry in the Stalls
tab, which is a bug report against this tool, so the row caps are
deliberate and tunable).
