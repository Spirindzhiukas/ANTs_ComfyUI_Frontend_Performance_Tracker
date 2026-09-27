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

1. **Which of these is "the advanced stuff" you had in mind** — per-type policies
   (D), presets/portability (C), cross-session comparison (E), an API other packs
   can use (F), or the scheduler lanes (I)?
2. **May the tool write anything to disk?** Today it only writes localStorage.
   A report file (H2) is the natural next step, but it changes the "nothing
   server-side" property the README boasts about.
3. **Should other packs be able to report their own costs** (F2), with the caveat
   that a reported number is not a measured one?
4. **Is a per-type "flatten always" policy wanted even at 100% zoom** (D1), and if
   so, should it be per type or per pack?
