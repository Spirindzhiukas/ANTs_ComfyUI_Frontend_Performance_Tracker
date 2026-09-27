# ANTs Nasty Bastards Tracker

A frontend-side profiler for ComfyUI. Answers "which extension is
actually costing me FPS while panning this graph?" without needing
Chrome DevTools open, and without restarting ComfyUI to bisect.

Version 2.0. This is a rewrite: the semantics changed (costs are now per
drawn frame, not per 4-second window), five new tabs exist, and a
handful of v1 bugs that could make the panel lie are fixed. If you are
coming from v1, read **"What changed in v2"** at the bottom.
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

A per-node-type table follows (cost per *drawn* node of that type, so a
type used 50 times is not penalised for existing), plus a sampled
`canvas.setDirty()` caller table — see Stalls below.

### Stalls tab

Frame cost is not the only way to lose FPS, so this tab reports
main-thread blocking *outside* the draw path, from Long Animation
Frames (Chrome 123+) with a `longtask` fallback:

- **blocking ms/s** and **stalls/s**, the honest headline numbers.
- **where** — script URL, function name, source line, and the
  extension pack when the script lives under `/extensions/`.
- **invoker** — e.g. `TimerHandler:setInterval`, which names the
  mechanism behind a heartbeat.
- **forced layout ms** — style/layout time inside the long frame,
  which is the signature of a DOM-thrashing extension.
- **redraw requests/s by caller** — `canvas.setDirty()` wrapped
  exactly (the request rate is precise) and its call stack sampled
  ~20×/second to say *who* is asking for redraws. A rogue heartbeat
  shows up here by name instead of as "something is ticking".

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
node tests/run-tests.mjs          # 37 tests, no dependencies, no browser
node tests/run-tests.mjs timing   # filter by name fragment
python3 tests/test_init.py        # backend route parsing + graceful fallbacks
node tests/demo.mjs               # print what the panel says, with no ComfyUI
```

`tests/demo.mjs` drives a synthetic graph (two packs, four node types, a
status heartbeat, one long animation frame per second) through the real
tracker and prints the summary bar, all seven tabs and the text report —
the fastest way to see exactly what the panel reports without installing
anything, and a useful before/after when changing the UI.

The JS suite loads `web/tracker.js` into a fake browser and a fake
ComfyUI/LiteGraph with a controllable clock, then asserts the numbers
(per-frame attribution, budget additivity, mute semantics, cap
deferral, fps under loose caps, instance/pre-existing hook adoption,
stall and redraw attribution, panel row identity, and the A/B
benchmark) rather than only the code paths.

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
allocating one object per hook call and shifting arrays, so the profiler
is cheaper while profiling than it was.
