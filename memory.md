# memory.md — what this project is, why it is like this, and what was learned

A running record for whoever picks this up next (including me). `CLAUDE.md` is the
rules for changing the code; `plan.md` is where it is going. This file is the past:
what was built, what was rejected, and what the evidence was.

Last updated at **v2.3.0**, 152 tests green, PR #1 on
`Spirindzhiukas/ANTs_ComfyUI_Frontend_Performance_Tracker`.

---

## 1. Where it stands

| | |
| --- | --- |
| Version | 2.3.0 (`web/tracker.js` `VERSION`) |
| Tests | 152 (`node tests/run-tests.mjs`), plus `tests/test_init.py` |
| Frontend | `web/tracker.js`, ~9.5k lines, one ES module, no dependencies |
| Backend | `__init__.py` — a no-op node + one optional read-only route |
| Panel | 9 tabs: Tweaks, Timing, Nodes, Stalls, Governor, Load, Memory, GPU / VRAM, Testing |
| Entry points | floating pill `[switch][gear]` (always on screen), the node's own pill, and `window.__antsTracker` |
| Persisted | `ants.lowZoom.v1` (drawing + view settings), `ants-governor-v1` (scheduler limits), `ants-tracker-corner-pos` (pill position) |

The tool measures, in the order the questions get asked: frame cost and where it
went (Nodes), which extension/node type is burning the frames (Timing + Nodes),
what is eating frames that is not canvas drawing at all (Stalls + invalidation
callers), and what a change would be worth (mute + scripted pan A/B). Then there
is a scheduler layer that can act on what it finds (Governor), and a set of
drawing settings that make one redraw cheaper on graphs too big to draw in detail
(Tweaks: node flattening, link ink, preview thumbnails, idle cap, viewport focus).

That last group is where the recent work has been, because a ~1000-node graph at
10% zoom is the user's actual situation and no amount of measurement fixes it —
something has to be drawn less or hit-tested less.

## 2. Version log

The commit log is the full record; this is the "why", newest first.

**v2.3.0 — a box can be a picture of its node (plan.md Track K1).** The snapshot
engine, off by default, in the Tweaks tab: the nodes the flatten threshold turns
into boxes are captured once on the idle lane — drawn through their own draw path
into their own offscreen canvas — and later frames blit that picture with one
`drawImage`. Ported in design from ComfyUI-NodeSnapshots (SparknightLLC /
EricBCoding, MIT) and re-implemented on this file's own seams, budget and idle
lane; no upstream code, so the licence decision is still open (Track M). Three
deliberate differences from upstream, all argued in the code: (a) a snapshot
replaces a *flat box*, never a live node — the flatten threshold stays the only
thing that decides which nodes stop being drawn in full, which keeps golden rule
6 intact and keeps this a readability feature rather than a performance claim;
(b) the capture draws into its own canvas instead of the visible one, so there is
no canvas state to copy and restore; (c) a capture's time is counted as this
tool's (`snapMs`) and attribution stands aside while `inCapture` is set, because
otherwise the Timing tab would blame the pack whose hook the capture ran. The
speed case — replacing *live* nodes during movement — is deliberately not built
yet: it needs K3's measurement first.

**v2.2.0 — the flat boxes say what they stand for.** The flatten path painted one
grey rectangle per node, which removes the node's cost and its identity with it:
at 10% zoom a node with a validation error looked like a healthy one, a muted node
looked live, and the user's own words for the result were "dumb semi useless
boxes". A **box detail** ladder sits next to the flatten threshold: `plain` (what
v2.1.16 painted), `title` (the node's own title-bar colour, drawn above the body
where LiteGraph draws its title, at `NODE_TITLE_HEIGHT`), and `state` (error ring,
progress bar, muted/bypassed/ghost dimming). This is the first half of plan.md
Track K; the bitmaps (K1–K3) come next, and this ladder is also their fallback
floor (K4), so the same user-visible vocabulary survives the change of engine.

**v2.1.16 — the pill belongs on the floating button.** v2.1.15 had put the master
switch on the node's DOM widget, which is a place the frontend can take away
(it lives in the same layer every other widget lives in). And switching the tool
off hid the panel and the corner button — leaving the screen empty at exactly the
moment someone wanted the way back. Now the floating control *is* the pill,
built by the same code as the node's widget; switching off hands back the page and
nothing else; the panel stays open and says what happened.

**v2.1.15 — the node's own controls come back.** v2.1.14's focus mode took the
tracker's own widget with it: below the flatten zoom the node is a rectangle, its
canvas-drawn button is not painted, and its DOM was hidden by the same sweep that
hid everyone else's. The replacement: a pill marked `.ants-own` that every sweep,
gate and hover rule skips by construction, and a master switch (`S.enabled`) that
gates every predicate, the hook wrapper, the scheduler, the redraw cap, the frame
recorder, the rAF monitor, the samplers and both gate installs.

**v2.1.14 — the four mechanisms.** The report was "all node widgets are still
clickable at 10% zoom, and the 3D viewports are still fully interactive", with 144
elements carrying the inert class. Three separate reasons, all true at once:
(a) most widgets are canvas-drawn and hit-tested by arithmetic
(`LGraphNode.getWidgetOnPos`), so no CSS class can reach them; (b) a 3D viewport's
render loop is driven by the *node's* hover flag (`onMouseEnter` →
`updateStatusMouseOnNode`), which the canvas calls from its own hit-testing, not
from DOM events — so `pointer-events: none` could never make it false;
(c) an element whose owner could not be worked out was skipped entirely, so a
page where the position arithmetic comes out differently (200% display) ended up
with live viewports and a panel reporting work done. The fix is four independent
mechanisms: the canvas widget gate, node hover hooks held back (with a forced
leave so a flag can never stick), node DOM hidden outright by default, and a
document-capture event gate. Plus an honest verification: `getComputedStyle` on a
sample, reported as `verifiedOff` / `stillReachable`.

**v2.1.13 — reach the 3D viewports, keep the nodes clickable, stop making
foveation cost more than it saved.** The frontend's node hit-test is left exactly
as ComfyUI wrote it, so nodes still select/drag/edit at any zoom; only the widget
UI is switched off. The DOM registry now finds `.dom-widget` anywhere and does not
require an owner. The fovea restore is rationed (1 per drawn frame by default) so
bringing elements back cannot cost a frame.

**v2.1.12 — viewport focus.** First version of "switch off node UI when nobody can
use it". It worked for ordinary widgets and missed the two mechanisms above.

**v2.1.11 — reach the 3D viewports, and measure what link thinning is worth.**
The core 3D nodes are `ComponentWidgetImpl`s: the widget object has no `element`
at all, and its DOM is a wrapper the frontend renders into the DOM widget layer.
Also added the A/B measurement for the link setting (`measureLinks`), because a
setting that changes what is drawn has to prove it was worth it.

**v2.1.10 — link settings touch links, and nothing else.** Straightening links had
been coupled to the node threshold, which made it look like the tool was
flattening nodes on its own. `linkStyle` became its own setting with two explicit
answers, and deliberately no `auto`.

**v2.1.9 — the node threshold is a zoom, not a node size.** A per-node pixel rule
classifies the same node differently from frame to frame (a node that hides UI or
adds a widget changes size while you look at it), and the nodes that move are
exactly the JS-UI and dynamic-UI ones. A zoom is a property of the camera: one
decision per frame, the same for every node, and it flips when *you* change the
zoom.

**v2.1.8 — Tweaks tab, link style as its own setting, component widgets boxed,
settings remembered.** Also the point where the drawing settings became a first
class thing with persistence (`ants.lowZoom.v1`).

**v2.1.7 — the governor's display lane, and boxed nodes' DOM widgets out of the
layout pass.** A source that draws is a source whose skipped ticks the user can
see; the scheduler treats display work differently from background work.

**v2.1.6 — degrade links instead of straightening them; box the DOM content of
flattened nodes.** Making a link thin is a smaller lie than making it straight;
and flattening a node has to take its DOM with it or the rectangle lands behind
live content.

**Earlier (no version in the name):** low-zoom drawing ("make one redraw cheap
instead of rare"), 4K node sizes and stopping full-size preview uploads, limits
aimed at cost rather than gaps, the autopilot ladder, "normal must mean no gate"
(a regression that stopped ComfyUI drawing), the governor itself, the panel
back-off, sortable tables and row caps, VRAM parsing per ComfyUI's own fields,
the GPU route, the test suite, and the v2 rewrite with `REVIEW.md`.

## 3. Decisions worth not re-litigating

**Units.** Per drawn frame, not per window. v1's numbers moved 4× with pan speed
because they summed over 4 seconds. `ms/frame`, `% fr`, `ms/call`, `calls/fr`, and
wall-clock only for rates (fps, req/s, stalls/s) with the unit printed.

**Buckets are immortal while wrapped.** Keep 1 KB forever rather than let an
extension disappear from the panel after four quiet seconds (v1's worst bug).

**Muting can never hide itself.** A muted owner keeps a row with an Unmute button
and a `skipped N` counter.

**`normal` really is a normal call.** Same arguments, same `this`, the browser's
own ids so `clearInterval`/`cancelAnimationFrame` keep working. The table can
report "was 50/s, now 12/s" without having changed anything until asked.

**The box-detail ladder reads fields, not names.** Node stand-in marks come from
`has_errors`, `progress`, `mode` (2 = muted, 4 = bypassed), `flags.ghost` — the
same fields the frontend's own `drawNode`, `drawProgressBar` and `getNodeModeAlpha`
read, at its own numbers (`#E00` error stroke 10 units wide and 12 units out, green
progress bar, alphas 0.4/0.2/0.3). Two things follow from that rule: no mark is
ever inferred from a node's name or colour, and there is no "executing" mark —
ComfyUI's execution highlighting is not a per-node field in this frontend (nothing
in `LGraphNode`/`LGraphCanvas` carries it; `node.progress` is the only per-node
execution state that exists), so inventing one would be inventing state. A node
that says nothing gets no mark.

**A snapshot is only used where the box would have been.** The engine could
reuse a picture at any zoom (upstream does), but that would make a zoom the tool
never touched look different, so it is gated on the flatten threshold: boxes in,
pictures out. Consequences to keep in mind: this is a readability feature under
the threshold, not a speed feature, and the numbers to decide whether it should
also replace live nodes during movement do not exist yet (plan.md K3). The
follow-on decision is a measurement, not a preference.

**Two rate windows, stated rather than hidden.** Per frame, the cheap fields
(selection, hover, error, progress, drag) are checked every draw and a node in
any of those states is never served from a bitmap. The expensive check — the
signature, ~30 field reads and a rolling hash — is rationed to once per
`LOD_SNAP_SIG_MS` (100 ms) per node, which is the one accepted staleness window;
it is in LIMITS and in the README. A node whose capture took longer than
`LOD_SNAP_SLOW_MS` (60 ms, not upstream's 32 — their own issue recommends the
raise for large custom nodes) is blocked for the session.

**A limited source is slowed, never silenced.** Skipped interval ticks are covered
by the next one; a skipped one-shot or chained callback is re-scheduled for when
its window opens; a self-re-registering callback is respected. Only `pause` stops.

**The event gate is blind by construction.** It is a set lookup on the target's
ancestors, and the set is empty whenever nothing is switched off, so it cannot
swallow events aimed anywhere else.

**`.ants-own` is untouchable.** No sweep, gate, hover rule or setting may touch
the tool's own UI, and the master switch must never remove the control that
switches it back on. This was learned the hard way twice (§5).

**Ownership is optional for the focus half.** "Which node is this?" is only needed
for per-node decisions (flattening, off-screen). "Switch off every node-DOM
element" needs no owner — which is what makes a 200% display, or a transformed
container, not matter.

**The display-scale probe is a report, not a dependency.** It runs at startup,
once a second and on every sweep, and logs a warning when the frontend's visible
area is in device pixels instead of CSS pixels. The maths reads the canvas's CSS
box when it can, so nothing depends on the answer.

**Two ways to look at the pill (v2.1.15/16).** The floating pill is the one that
cannot be taken away, and the node carries the same pair for when that node is
what you are looking at. Both are built by `antsBuildTick` + the shared gear
handler so the copies cannot drift.

**The pill's geometry is arithmetic, not taste.** `ANTS_GLYPH_BOX = 22` with
`viewBox="0 0 22 22"` (1 unit = 1px), `box-sizing: border-box` on a 22px button,
so the switch's 1.5px border is drawn inside the box and its centre line sits at
`r = (22 − 1.5)/2 = 10.25` — exactly where the gear's teeth end, in the same 1.5px
line. Unchecked paints nothing inside the ring; checked fills `#0D2A2A`; both are
`#AE7719` in every state, hover only moves the background.

## 4. Rejected approaches (do not retry)

- **`pointer-events: none` on node DOM as the way to stop widgets.** It cannot
  reach canvas-drawn widgets, and it cannot make a 3D viewport's node-level hover
  flag false. That was v2.1.12's whole premise; v2.1.14 replaced it with the four
  independent mechanisms.
- **Making the *node* unclickable to stop its widgets.** It took node selection
  and dragging with it (reported immediately). The widget gate is the way.
- **Per-node pixel threshold for flattening.** See v2.1.9 above.
- **Coupling link straightening to the node setting.** Reported as "it flattens my
  nodes by itself"; v2.1.10 split them.
- **Deleting stale buckets.** Permanently lost extensions and mutes (v1).
- **Rendering links with `render_connections_border` off plus changing the frame
  quality flag.** Changes the whole canvas instead of the link.
- **Hiding the panel or the corner button while the master switch is off.**
  v2.1.15 did it; the user's reaction was immediate and correct ("once turned off
  there the whole UI and the wrench button disappears completely").
- **Putting the primary switch only on the node's DOM widget.** A DOM widget lives
  in a layer the frontend can take away (and at low zoom, in a node that is not
  drawn). Hence v2.1.16.
- **Guessing what a widget costs by instrumenting Vue components.** Not reachable
  from an extension; those costs are named in LIMITS and land in "everything else".
- **Faking GPU numbers.** Page JavaScript cannot get them. The GPU tab shows the
  backend route's `nvidia-smi` output, ComfyUI's `/system_stats` VRAM fields, and
  says what is missing.
- **An `auto` link style.** "A link's shape changing because the *node* setting
  crossed a threshold" is precisely the coupling users hated.

## 5. The pill, and what went wrong twice (worth reading before touching UI)

The node's gearbox was the only way to open the panel besides the corner button.
Then v2.1.14's focus mode hid all node DOM below the flatten zoom — including the
tracker's own — and the frontend stops drawing a node's canvas widget button when
the node is only a rectangle. Result: at 10% zoom the tracker lost its own control
while switching everything else off. That is a class of bug, not an incident:
**the tool's UI must be exempt from the tool's own rules, by construction.**
`.ants-own` and `viewIsOwnDom()` are that construction; every registry route and
marking pass checks it.

The second time was v2.1.15's switch hiding the corner button and closing the
panel. Same class, other direction. The rule now: the master switch releases the
*page*; it never releases the controls.

## 6. Environment and measurements

The user's machine and reports, all of which drove priorities:

- Windows, **display scale 200%**, CPU-only target. Any pixel maths must be in CSS
  pixels; this is why the display probe exists and why ownership-optional DOM
  switching matters.
- Large graphs: at 10% zoom, **1027 of 1041 nodes flattened**; the modal frame was
  **44.7 ms** (connections ~60%, other ~37%), fps ~15. Thinning links measured
  **30.4 → 23.1 ms/frame**. Eclipse/other extension culling off; governor limits
  off during those reports.
- The frontend's own LOD threshold is derived, not fixed:
  `min_font_size_for_lod / (14 × √devicePixelRatio)`. At the default setting of 8
  and a 200% display (dpr 2) that is **≈0.40 zoom**, so at 10% zoom ComfyUI is
  *already* drawing low-quality — no title text, badges, widget text or shadows —
  and any "simplify nodes during gestures" lever only has an effect between 0.40
  and 1.0 zoom. Below 0.40, savings have to come from not drawing the node at all
  (our flatten path, and the node snapshots in plan.md Track K).
- The user verifies by screenshot, and reports in terms of what they see on the
  page ("still clickable", "the wrench is gone"). Design changes accordingly:
  say what the page will look like, and prove it with the demo's printed numbers
  and a rendered preview when a picture is the only way to check.

## 7. Known weaknesses and open questions

- **The 200% display case has never been confirmed on the real machine** with the
  current build. The probe reports what it finds; nothing has verified that a
  focus-mode sweep on that machine leaves no viewport live. This is the single
  highest-value field check outstanding.
- **Fovea reversion is deliberately slow** (1 element per drawn frame, up to 4
  available). Coming back early costs exactly what the mode exists to save. If a
  user reports "the node is there but its preview takes a moment", that is the
  design, not a bug.
- **While the master switch is off the panel still repaints itself** so its
  controls and banner stay truthful. Nothing is sampled (every number is frozen),
  but it is not zero work. Making the panel go dark while off is a one-line change
  if anyone wants it.
- **The event gate cannot see a non-marked element** — by design — so if the
  frontend re-parents a widget the moment a click starts, the gate's first event
  may already have been delivered. Not observed; worth remembering.
- **Firefox** exposes neither `performance.memory` nor long tasks; Memory and
  Stalls stay empty there and the panel says so.
- **Attribution of redraw callers is sampled (~20/s)**, so a rare burst can be
  missed, and callers are only resolved to a pack when the script lives under
  `/extensions/`.
- **The pill's look has been rendered but never seen in a real ComfyUI.** The
  preview page is generated from the real CSS and glyph builders, and that is the
  best that can be done without a browser in the dev environment; the user did
  approve the rendered picture, but a real-page check is still owed.
- **No per-node-type policy exists yet** — mutes and drawing settings are per
  extension or global. See `plan.md`.

## 8. How this code got written (process notes)

- Every release is: tests green → version bump → README changelog section →
  `memory.md` → commit → push → PR comment with the numbers.
- Changes arrive as small scripted patches with assertions on anchor uniqueness;
  a patch that finds its anchor twice aborts rather than guessing (see
  `CLAUDE.md`'s gotchas, which exist because this went wrong twice).
- The test suite grows with the fix, not after it: a bug report becomes a failing
  test first where possible.
- Where a picture was the only way to check a look, the look is generated from the
  real source (`tools/pill-preview.mjs`) rather than drawn by hand, so it cannot
  drift from the extension.
