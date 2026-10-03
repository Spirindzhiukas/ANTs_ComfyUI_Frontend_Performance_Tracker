# memory.md — what this project is, why it is like this, and what was learned

A running record for whoever picks this up next (including me). `CLAUDE.md` is the
rules for changing the code; `plan.md` is where it is going. This file is the past:
what was built, what was rejected, and what the evidence was.

Last updated at **v2.5.6**, 189 tests green, PR #2 on
`Spirindzhiukas/ANTs_ComfyUI_Frontend_Performance_Tracker`.

---

## 1. Where it stands

| | |
| --- | --- |
| Version | 2.5.6 (`web/tracker.js` `VERSION`) |
| Tests | 189 (`node tests/run-tests.mjs`), plus `tests/test_init.py` |
| Frontend | `web/tracker.js`, one ES module, no dependencies. The separate window is `web/window.html`, served at `/ants_optimizer/window`, not loaded as an extension. |
| Backend | `__init__.py` — node `ANTs_Frontend_Optimizer` (old class key kept as an alias), nine best-effort routes (GPU, five thumbnail routes, the window page, `/ants_optimizer/ui`), and thumbnail read/write under ComfyUI's temp folder |
| Panel | 10 tabs: Node Rendering Settings, Status, Timing, Nodes, Stalls, Governor, Load, Memory, GPU / VRAM, Testing |
| Entry points | floating pill `[switch][gear]` (always on screen), the node's own pill, and `window.__antsTracker`. The gear opens the separate window; the in-page panel is the fallback when the popup is blocked. |
| Persisted | `ants.lowZoom.v1` (drawing + view settings), `ants-governor-v1` (scheduler limits), `ants-tracker-corner-pos` (pill position) |

The tool measures, in the order the questions get asked: frame cost and where it
went (Nodes), which extension/node type is burning the frames (Timing + Nodes),
what is eating frames that is not canvas drawing at all (Stalls + invalidation
callers), and what a change would be worth (mute + scripted pan A/B). Then there
is a scheduler layer that can act on what it finds (Governor), and a set of
drawing settings that make one redraw cheaper on graphs too big to draw in detail
(Node Rendering Settings: node stand-ins, link ink, idle cap, viewport focus).

That last group is where the recent work has been, because a ~1000-node graph at
10% zoom is the user's actual situation and no amount of measurement fixes it —
something has to be drawn less or hit-tested less.

## 2. Version log

The commit log is the full record; this is the "why", newest first.

**v2.5.6 — the picture now contains the node, and the disk cache is keyed by what is inside the file.** The report was that image loaders and mask editors show a stand-in with the node's UI and no image in it, and that text nodes (even `CLIPTextEncode`) show no text; and that the capture resolution and the disk cache do not follow a change. All of it was real. A node's widgets live in DOM elements *over* the canvas in both frontends, and the canvas row under them is blank — `BaseDOMWidgetImpl.draw` in `src/scripts/domWidget.ts` paints a placeholder only in the frontend's own low-quality mode — so a capture, which is the canvas, was the node's chrome and nothing else for exactly the node types made of DOM content. `lodSnapDomInk` now composites, after the ink probe and before the mip chain and the disk file: images and canvases pixel for pixel; a text field's *value* re-painted in LiteGraph's widget colours, wrapped and clipped to the row (page JavaScript cannot screenshot rendered text, so the readout counts those separately and says so); a pack's own HTML left blank and counted; and a node showing a video is never photographed. The geometry is the frontend's own rule from `DomWidgets.vue` (`node.pos + margin`, `widget.y`, `width ?? node.width`, `computedHeight ?? 50`) — no layout read, and it still works while this tool's own class has the wrapper hidden, which is the state a flat node is in. The signature now covers what the elements show (an image's `src`/`complete`/size, a canvas's size, a text field's value), so a new image or an edited prompt forces a new picture — the "regenerate the stand-in when the node changes" the user asked for, for the case the node's own fields do not cover. Two genuine defects came out of verifying the cache while doing it. **`lodSnapRender` clamped the capture ratio with `Math.max(1, ratio)`**, so 0.25x and 0.5x were drawn at 1x — four to sixteen times the memory the budget had been told to reserve — while the disk name and the readout said otherwise; one `lodSnapPixelRatio()` now feeds both the render and the ink probe. And **the disk file was keyed by the node signature alone**, which deliberately leaves out the ratio and the theme because in RAM both changes clear the whole cache; a file outlives both, so a page starting at 0.25x loaded yesterday's 1x files (and never re-captured them, because a record existed), a page starting at 2x was served 0.25x pictures, and a light-theme file was served in a dark theme. The key is now `signature + r<ratio> + t<hash of the theme>`, used by the ask, the save and the install's verification, so a change of either is followed in both directions; a picture the budget forced coarser is not written at all, and an eviction now forgets its "already asked" mark so the file can be read back instead of re-photographed. Ten tests cover this, five of them playing the thumb store's part — a fake disk with one file per node id, replaced on write and served only for the exact key — so the frontend's half of the contract is pinned. On the user's other question: stand-ins cannot be made to work in the Vue-nodes renderer by reading the flag differently (the canvas draws no node, so there is nothing to blit into); a DOM-overlay design is written up in `ANALYSIS.md` and `plan.md` (K8) with its open questions, and the recommendation is to measure what the node DOM actually costs there before building it.

**v2.5.5 — the Nodes 2.0 (Vue nodes) frontend, verified against the frontend's own code.** ComfyUI's newer frontend renders every node as a DOM element (`LiteGraph.vueNodesMode`, set from the `Comfy.VueNodes.Enabled` setting by `useVueFeatureFlags.ts`), and `LGraphCanvas.drawNode` returns immediately there: the canvas draws links, groups and the grid only. The tool already refused to paint a rectangle behind a DOM node (`lodFlatNode`), but three things did not follow from that. The stand-in engine still reported itself on and the once-a-second lane still queued captures — every one of which would have produced a blank bitmap and been written off as "draws nothing into the canvas" and blocked for the session, so finishing a run was enough to fill the idle lane with dead ends; `lodSnapOn()` now answers false in this renderer and the enqueue path inherits it. The readout blamed the wrong setting ("snapshots are on but not painting anything: they need the flatten setting above switched on" — it *was* switched on and below its zoom) and offered "collapsed boxes or this tool's own node" as the reason `0 of N` nodes were flattened; the Status tab now names the renderer in its first line and explains the idle settings where their numbers would be, and so does the copyable report. And the DOM half kept building its registry and walking it per frame to reach a decision that cannot change in this mode; one predicate, `lodDomWanted()`, is now used by the sweep, the frame plan, the settings-apply and switch-on paths, while the focus half (widgets stop answering, the off-screen/fovea culling) still counts and still works — it acts on DOM elements and the pointer, and the node's own root element is still never hidden. The flag is read per call rather than latched, so switching Nodes 2.0 off in ComfyUI's settings takes effect on the same page. A fourth defect only turned up because the switch was modelled as a live event rather than a page-load fact: a warm cache (or a queue with work in it) stayed in memory after the move to the DOM renderer, where no box can ever be painted from it — the drain slice now releases the cache on that transition, the same release as switching the setting off.  Seven tests cover this, on a fixture built to the upstream shapes (`data-node-id` roots, the `dom-widgets` layer with client-pixel `left`/`top`, `drawNode` early-returning, `addDOMWidget`'s `hideOnZoom` default); the contract table with the upstream file for each claim is in `ANALYSIS.md` — including the honest limit that no real Vue-nodes page was executed, only the fixture.

**v2.5.4 — audit, README rewrite, and the keep-live list gets a door.** The README still described v2.1 (five tabs, the old install folder, one route, "nothing else is written server-side", 161 tests) and carried no credits, so it was rewritten from the code and the version history moved to `CHANGELOG.md` — 900 lines of archaeology were the reason the body could drift unnoticed. `LICENSE` and `THIRD_PARTY_NOTICES.md` now exist (plan.md Track M), with the NodeSnapshots MIT notice verbatim. Two real defects turned up while verifying the code: `snapExclude` had no UI at all (a mechanism with no door — the readout said "kept live by your list" and the only way in was the console), and adding a type did nothing until that node changed because an existing record was still served (fixed by dropping only the newly excluded types' records in `lodSet`). The demo was printing the wrong tab names (it skipped `status` and indexed the bar), was still explaining the retired preview ladder, and called the tab "Tweaks"; `tracker.js`'s header comment claimed links go straight while nodes are rectangles, which stopped being true when `linkStyle` was decoupled. All fixed. A new test pins the window/page setting-key agreement in both directions, so a control that posts a key the page ignores cannot ship silently. Nothing was taken out of the drawing engine in this pass — the dead ladder, boxify and drawImage code had already been removed; `ANALYSIS.md` records the evidence and the retired ideas.

**v2.5.3 — the window is a page, and the corner grows the way it is dragged.** The fallback panel was right-anchored, so widening it moved the left edge. It is pinned on the left and the top before the size changes; a header drag writes left, not right. The Window button no longer moves the panel into `about:blank`. The gear opens `/ants_optimizer/window`, centered on the ComfyUI window. That page does not load the canvas script and does not hold the canvas document. Settings and telemetry go through `/ants_optimizer/ui`: a revision and an origin, same shape as the uploaded `examples/pop_up_window` console, so a change in the window and a change on the page are one setting and neither side applies its own echo. Telemetry does not bump the revision. The page posts it only while the window is asking, on a timer that already existed, so startup does not spend an attribution token. If the browser blocks the popup, the in-page panel opens and says so. It is a browser window, not a second OS process, and not a worker. Vue node mode may still ignore a LiteGraph resize flag; the grip does not depend on that.

**v2.5.2 — drag keeps the picture, and the higher zoom wins.** A node drag no longer swaps a pictured node for a box. A link drag, a running bar and an error still draw live. The new switch under Widgets stop answering is on by default; while it is on, pictures follow the higher of the preview zoom and the widget-stop zoom, in both How widgets go modes. Turning it off leaves the two dropdowns independent. Capture adds 0.25x and 0.5x; 1x stays the default, and automatic coarsening still stops at 1x unless the user asked for smaller. The budget ladder adds 4096 and 8192. A missing `snapMb` is 4096; an explicit saved 256/512/1024/2048 stays. Execute and Run-to-node read `/system_stats` `system.ram_total` / `ram_free`: 85% used releases off-screen stand-ins, 95% releases all of them, disk files stay, and the lane asks for them again when the run finishes. No reading, no release. The panel opens on Node Rendering Settings; Status is the next tab. The floating panel has a both-axis grip and restacks below 460px. The graph node is marked resizable and docks the panel when grown; Vue node mode may ignore a LiteGraph `resizable` flag, and the grip does not depend on it. Window is `window.open` of this same panel, not a second process. A worker still cannot call `drawNode`; the idle gap is 32ms and on-screen nodes are photographed first.

**v2.4.1 — the scripted pan was too short to see foveation.** A fresh-process
report (browser and server restarted, rgthree fast toggles off, software
rendering, same maximized window, zoom 0.10, 1040 nodes) confirmed the idle
win is not leftover state: mean 4.10 ms, p95 3.70, display 112 Hz, `setDirty`
0/s. The same paste's scripted pan was 175 ms/frame both runs, hooks 0%, and
the two runs matched because nothing was changed between them — and because
the pan only moved ±40 graph units, about 4 CSS pixels at that zoom. Foveation
boxes a node past half a screen. That fidget never left the viewport. The
sweep is now one screen plus the margin, and the result names the distance and
the peak number of elements hidden, so the next A/B can actually be about that
setting.

**v2.4.0 — the picture is whatever the canvas draws, and the rest is named.**
Second report after K1, from the same 1,041-node graph at zoom 0.10: 625,156
draws served from pictures, 799 captures, 1.7 GB of a 2 GiB budget held — and
"most of the empty (our legacy simple box) ones are either image load nodes or
some of my nodes". The buckets in that report were the diagnosis: 206 *refused*
(DOM widget, function, long string) and "375 too large" — which was not 375
nodes, it was a couple of dozen tall nodes re-attempted on every single slice,
because the refusal counted attempts and left no record to block on. Five changes:
(a) the refusal rule is gone — a DOM/custom widget, a function-valued value or a
long string are all capturable, because the first two are canvas ink or a
browser-drawn overlay and the third was only ever a hashing cost; the pictures of
nodes the browser partly draws are counted as "the canvas part only" and the
readout says so. (b) A five-probe ink check (five 8x8 `getImageData` reads per
capture) keeps a box for a node whose own draw leaves the canvas empty, because a
transparent picture would erase it — the one new failure mode this coverage change
could have introduced. (c) The dimension cap fits the capture to the largest
ladder ratio instead of refusing (a node up to about 1,994 units tall gets a 1x
picture), and a node too big at any ratio is blocked once and *named* with its
height. (d) The churn guard: a node whose picture is dropped before it is drawn
three times in a row keeps its box, and is named. (e) "Coarser, not nothing": a
capture the budget would refuse is re-tried at 1x before being refused, since a
refusal still costs the node's whole draw and then throws it away. The readout now
leads with `N of M remembered node(s) have a picture` and lists names, which is
what makes the *next* report actionable. Images a node draws into itself joined
the signature (count, `complete`, size, source ends), so an image node photographed
before its image loaded is re-photographed after it loads. 5 new tests; the test
that pinned the old refusal rule became the test that pins the new coverage rule.

**v2.3.1 — the flicker was the eviction policy.** First real report after K1
shipped: a 1,041-node graph at zoom 0.19, 256 MiB budget, 255.6 MB held, 7,040
captures for 1,041 nodes, 156,393 draws served from pictures, and the user's words
"box previews and the images flicker on and off constantly". The diagnosis is in
the ratio: the cache was thrashing at its cap because LRU eviction on a graph that
is entirely on screen evicts what is being looked at. Three changes: (a) "in use"
is now a *frame* epoch, not a stopwatch — a bitmap is protected while its node is
being drawn (a time window failed a test that mattered: while the page is idle no
frames are drawn, so on-screen bitmaps aged out); (b) a full budget refuses new
captures instead of evicting in-use ones, with a 5s retry hold per node so the lane
cannot spin; (c) the ladder is 256 MiB → 2 GiB (doubling) with a 512 MiB default,
and sub-256 values are clamped up, because nothing useful fit below that. Two bugs
surfaced while testing: a refused/slow capture subtracted its own size from a total
it was never added to, and a selection change invalidated a bitmap needlessly.
A flicker counter (switches between picture and box) now makes this measurable.
Also: `render_shadows` left the per-node signature and is compared at reuse time
instead — another extension (NodeSnapshots) flips it per gesture, and hashing it
threw the whole cache away twice a gesture.

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

**A picture is whatever the canvas draws — no more, no less.** The rule for
whether a node can be photographed is not a list of things that look scary (a DOM
widget, a custom widget, a function, a long string — all of which upstream refuses)
but the question "can `drawNode` put ink on a surface for this node?". Everything
else follows from it: the browser-drawn part of a node is not in the picture and
the readout counts those pictures apart; a node whose own draw leaves the canvas
transparent keeps its box, because erasing a node is worse than the rectangle it
replaced; a node too tall for the cap is fitted to a lower ratio rather than
skipped; and a node that changes before every picture can be drawn keeps its box
and gets its name in the readout. Two consequences worth keeping: a "too large"
counter must count *nodes*, never attempts (v2.3.1's counter said 375 when the
truth was a couple of dozen nodes tried repeatedly), and every reason a node has no
picture must be attached to a named node, or the number is not actionable.

**A refused capture is not free.** It runs the node's full draw path and then
throws the canvas away, so "refuse when the budget is full" paid the expensive
part and kept nothing. Hence "coarser, not nothing": try 1x before refusing, and
keep the refusal for the case where even a quarter of the pixels do not fit. The
1x picture is not much of a compromise where it is used: a flattened node is drawn
at half size or less, so 1x still oversamples the screen.

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

**"In use" is a frame, not a clock.** Eviction protection is `snapFrame - rec.usedFrame
< LOD_SNAP_GUARD_FRAMES`, where `snapFrame` counts drawn frames. A millisecond
window was the first attempt and it was wrong in a way only a test caught: while
the page sits idle nothing increments wall-clock usage, so bitmaps that were still
on screen became evictable, and the user would come back to a recapture storm. The
frame rule has the property that matters — the eviction pool is exactly the nodes
that have stopped being drawn (off screen, or a graph switched away from) — and it
costs one integer compare.

**A full budget refuses; it does not evict in-use pictures.** Releasing a bitmap
whose node is being drawn is what flicker is, and recapturing it later releases
another one, so the failure mode is a loop. The stable answer is to stop capturing
and let the extra nodes stay boxes, counted in the panel as refusals. It follows
that on a graph larger than the budget the *set* of pictured nodes is fixed by
draw order rather than rotating — stated here because "why is node X always a box"
is a fair question with that answer.

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
  real source (`tools/pill-preview.mjs`, `tools/box-preview.mjs`) rather than drawn
  by hand, so it cannot drift from the extension. `box-preview.mjs` reads
  `LOD_SNAP_PAD`/`LOD_SNAP_TITLE_H` out of the source for its capture-geometry
  panel, so even the one hand-drawn picture states the code's own numbers.
- **Check the parent before committing** in a long-lived agent session: the local
  branch ref can be handed back at an older commit than the working tree (the
  objects and the remote are fine — it is the ref that resets). `git log --oneline
  -2` before the commit; if the parent is wrong, `git reset --soft <last real
  commit>` and commit again, then confirm `git diff --stat <old-sha> HEAD` is
  empty. This happened once with v2.3.0 and cost nothing because the tree, not the
  history, is the source of truth.
