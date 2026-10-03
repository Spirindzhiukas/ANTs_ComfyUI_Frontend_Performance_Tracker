# Changelog

Version history for ANTs_ComfyUI_Frontend_Performance_Tracker. Newest first.
The current behaviour is in `README.md`; the reasoning behind each release is in
`memory.md`; the rules for changing the code are in `CLAUDE.md`.

## What changed in v2.5.4

- The keep-live list has a control. `snapExclude` has been honoured since v2.4.0 and the readout said "kept live by your list", but the only way to add a type was the console. There is now a "Keep these node types live" field in Node Rendering Settings (and in the window), taking a comma-separated list of node types.
- Adding a type to the list now takes effect at once. A node whose picture had already been captured kept being served it, because the queue skips a record that already exists — so the control appeared to do nothing until that node changed. `lodSet` now drops the records of the newly added types only (the counts show them under "kept live on purpose", not as failed captures), and the rest of the graph is not recaptured.
- The image-preview thumbnail ladder's remaining implementation was deleted. The setting was retired in v2.5.0 and unreachable since; `LOD.thumbZoom` stays as a tombstone (a saved record still gets 0, and the setting cannot be turned back on — three tests pin that), and `lowZoom.previews` still answers `{on:false, retired:true}` instead of `undefined`.
- `tests/demo.mjs` printed the wrong tab names: its tab list was missing Status, so it clicked one button and printed another button's heading, and it still printed a paragraph explaining the retired thumbnail ladder (64px at 10% zoom, 512px at 60%). The list is complete, the label comes from the panel's own button, and the note now describes the stand-in picture.
- Source comments that no longer matched the code were corrected: the file header claimed links go straight "while the graph is rectangles" (that coupling was removed when `linkStyle` was decoupled), and two comments still described the retired preview ladder as live.
- Documentation is now split and current: the README was rewritten from the code (ten tabs, every setting's real ladder and default, the nine routes, the window link, the limits, 172 tests), the version history moved here to `CHANGELOG.md`, and a **Credits** section, `LICENSE` and `THIRD_PARTY_NOTICES.md` were added. `ANALYSIS.md` records what works, the defects that were found and fixed, and the ideas that were retired.
- One test added: the window and the page must agree on every setting key in both directions — a control that posts a key the page ignores can no longer ship silently. 172 tests green.

## What changed in v2.5.3

- The corner grip grows the edge you drag. The panel is anchored on the left and the top, so a drag to the right makes it wider to the right. Dragging the header moves that same left edge, and does not put the anchor back on the right.
- Window is no longer this panel moved into an empty document. It is a separate page at `/ants_optimizer/window`, centered on the ComfyUI window. The gear opens that page. The panel on this page opens only if the browser blocks the popup.
- The page and the window share `/ants_optimizer/ui`. A settings change carries a revision and who made it, so neither side applies its own echo, and a live number does not count as a settings change. The window is not on the canvas. The page posts telemetry only while that window is asking.

## What changed in v2.5.2

- Dragging a pictured node keeps the picture. A link drag, a running bar and an error still draw live. The switch under Widgets stop answering, on by default, links that zoom to the preview zoom; the higher one wins, in both How widgets go modes.
- Stand-in capture resolution adds 0.25x and 0.5x. 1x stays the default. Stand-in memory adds 4096 and 8192; a missing saved budget is 4096, a saved 256/512/1024/2048 stays.
- Execute and Run-to-node, when `/system_stats` reports system RAM: off-screen stand-ins leave memory at 85% used, all of them at 95%. Disk files stay and are asked for again when the run finishes. No reading, no release.
- The panel opens on Node Rendering Settings. Status is the next tab. The panel has a resize grip on both axes, and rows stack when it is narrow. The graph node is marked resizable on both axes; growing it docks the panel into the node. Vue node mode may still ignore a LiteGraph resize flag — the grip does not depend on that.
- Window opens this same panel in its own browser window, for a second monitor. It is not a second ComfyUI. A blocked popup leaves the panel here and says so.

## What changed in v2.5.1

- Selecting a node no longer swaps its picture for a painted box. The picture stays, and a ring is drawn on it. Drag, a running bar and an error still draw live.
- Image-node photographs were missing from the smaller copies, which are what the screen uses past about 25% zoom on a 200% display. ComfyUI draws that photograph a moment after the node itself. The copies now wait for it. Thumbnails of image nodes already on disk are photographed again; other nodes' files are left as they are.

## What changed in v2.5.0

- The node is **ANTs_Frontend_Optimizer**. Graphs saved with the old class key still load; that key is an alias. The Tweaks tab is **Node Rendering Settings**, one row per setting.
- Image previews are no longer a second system. Below the zoom you set, the node is replaced by a picture of itself — the same mechanism the boxes used. Hover keeps that picture. Select, drag, a running bar or an error still draws live, and the node stays clickable.
- Fresh installs replace nodes below 50% and capture at 1x. A saved choice is left alone. Half and quarter copies are made from the capture and chosen by on-screen device pixels. Canvas2D has no mipmap format, so the copy is picked here rather than sampled from one.
- Pictures are kept on disk under ComfyUI's temp folder, keyed by node id and a signature. A change overwrites the file, deleting the node deletes it, and files older than a week are removed. If the route is missing, the memory cache continues.

## What changed in v2.4.1

- **The scripted pan was a fidget, and it could not measure foveation.** It moved the view by ±40 by ±15 graph units — about 4 by 1.5 CSS pixels at zoom 0.10 — and put it back. A node never left the viewport, so the off-screen margin (half a screen by default) never came into it, and two runs of it could not show what that setting costs or saves. The sweep is now one screen plus the margin you have set, the result says how many screens it swept and the peak number of elements foveation hid, and the view is still put back where it started. Ten times the old fidget would still have been inside the margin. Run A and B with that setting the only thing changed between them.

## What changed in v2.4.0

- **Every node the canvas can draw gets a picture, not just the ones a
  conservative guess trusts.** The refusal rule this feature was built with came
  from the tool it learned from (ComfyUI-NodeSnapshots), whose own issue #1 is the
  report that custom nodes then never get a picture: a widget that is a DOM
  element, a `dom`/`custom` widget type, a function-valued value, a string over
  4 kB — all of them were refused for the session. The line is now drawn where the
  canvas is: if the node's own draw path can put ink on a surface for it, it is
  captured. What the browser draws *over* the node (an image preview, a DOM
  widget, a 3D viewport) cannot be in a bitmap of the canvas, so those pictures
  are counted as **"the canvas part only"** — the node's frame, title, slots and
  whatever the canvas still draws, which is what a box was standing in for anyway.
- **A node that draws nothing into a canvas keeps its box.** A node whose whole
  visual is a DOM element can leave a canvas transparent, and a transparent
  picture would *erase* it at the zoom where pictures are used — worse than the
  rectangle it replaced. Five 8x8 pixel probes of the capture (about a kilobyte of
  reads, on the idle lane) decide that, the canvas is released again, and the
  readout says how many nodes are like this. Anything unmeasurable answers "there
  is ink": the probe must never be the reason a node disappears.
- **A tall node is fitted, not skipped.** The dimension cap (2,048 px per side)
  used to end a node's chances for the session, and — worse — the refusal was
  re-attempted on every capture slice, so a real report's "375 too large to
  capture" was a couple of dozen nodes tried many times. Now the largest ladder
  ratio that fits the cap is used instead (1x for a node up to about 1,994 units
  tall), those pictures are counted, and a node too big at *any* ratio is blocked
  once and named in the readout with its height. At the zooms where nodes are
  flattened a 1x picture still has more pixels than the screen shows, so fitting a
  monster node is worth far more than skipping it.
- **A node whose drawing changes faster than the idle lane can photograph it keeps
  its box** — three pictures dropped before a single one was drawn — and the
  readout names it. That is the honest answer for a node something rewrites every
  frame (a polling extension): a fresh picture of it cannot exist, and capturing
  it once per slice forever is work with nothing to show for it.
- **When the budget cannot hold the ratio you asked for, a coarse picture beats
  none.** A capture that the budget would refuse is re-tried at 1x (a quarter of
  the memory) and only refused if even that does not fit. Refusing used to mean
  running the node's whole draw and then throwing the result away, so coarse is
  the cheaper answer as well as the more useful one — and the readout counts them
  apart from the fits.
- **The readout leads with the number that is actually being asked for**:
  `N of M remembered node(s) have a picture`, then the reasons (too slow, too big,
  nothing drawn, changing, kept live by your list, refusals for budget) and, for
  the first time, the **names** of the nodes that will not get one. A node's
  drawing also counts its own images in the signature now (an image node
  photographed before its image loaded is re-photographed once it has), and long
  strings are hashed by their ends, which is what made the old 4 kB refusal look
  like a reason when it was only a cost.
- **Worth knowing before choosing the ratio** (this is the measurement, not a
  default): at the zooms where nodes are flattened a picture is drawn at half size
  or less, so 1x already carries more pixels than the screen shows — 2x and 3x buy
  sharpness only for a picture that is being reused in the foveated margin at a
  high zoom, and cost four and nine times the memory. Since coverage is bounded by
  the budget, the ratio is also what decides how much of a large graph can be
  pictured at all; watch `have a picture` while switching 1x/2x on a real
  workflow. That comparison is plan.md's K3.
- **New tests** (5, 161 total): the browser's half of a node is not a reason to
  leave it a box (a DOM widget, a function-valued property and a 20 kB string are
  all captured, and a change at the far end of the long string still invalidates);
  a node too tall for the cap is fitted, at the size the cap allows; a node no
  ratio can fit keeps its box and is tried exactly once, with its height named; a
  node whose own draw leaves the canvas empty keeps its box and gives the canvas
  back; a font of churn leaves a node a box instead of a capture per slice; and a
  full budget with room for a coarse copy produces coarse pictures, not refusals.

## What changed in v2.3.1

- **The flicker was the budget's eviction policy, and it is fixed.** A real report
  from a 1,041-node graph showed 7,040 captures for 1,041 nodes with 255.6 MB held
  of a 256 MiB budget — the cache thrashing at its cap. The old policy released
  the *least recently used* bitmap; with the whole graph on screen every bitmap is
  touched every frame, so "least recently used" meant "drawn earliest in this
  frame", i.e. something visible. Each new capture therefore took a picture off
  the screen, the node fell back to a box, got queued again, was captured, and
  evicted another one. That loop is the flicker.
- **A picture that is being drawn is now never released.** "In use" is measured in
  *drawn frames*, not in milliseconds: a bitmap is in use while its node is being
  drawn, and stops being protected a frame or two after it is not. When the budget
  is full of in-use pictures, new captures are refused and the panel counts them
  (`N capture(s) refused`); the nodes that could not be captured stay boxes, which
  is stable. What makes room is pictures of nodes that have stopped being drawn —
  off screen, or in a graph you switched away from.
- **The budget ladder is 256 MiB → 2 GiB in the same doubling steps** (256, 512,
  1024, 2048), with 512 MiB as the default. Everything below 256 MiB was removed:
  nothing useful fit, and the thrashing above is what the old floor produced. A
  saved or scripted value below the floor now lands on it. A budget you lower
  yourself is enforced immediately, in-use pictures included — you asked for the
  number. Note what this memory is: canvas surfaces outside the JS heap, which the
  Memory tab (a heap report) cannot see, so the number stays one you pick.
- **The canvas's own shadow flag left the per-node signature.** Another extension
  (NodeSnapshots' "simplify live nodes during navigation") flips `render_shadows`
  around every gesture, and hashing it meant throwing every bitmap in the cache
  away twice a gesture. It is now compared cheaply at reuse time instead: a
  mismatch pauses reuse for that node (the box is drawn, the picture kept), so
  when the gesture ends the pictures are simply back, with no recapture.
- **Two bugs found while fixing this, both by the new tests:** a refused or
  too-slow capture subtracted its own size from the byte total it had never been
  added to (the budget under-reported itself, and the slower path made it worse);
  and a selection change used to invalidate a node's bitmap for no reason, since a
  selected node is drawn live anyway.
- **A flicker counter, so this is measurable rather than asserted.** The panel's
  readout now counts every switch of a node between picture and box, plus the
  refusals, the held-because-shadows-changed cases and what is held. A high
  switch count is what the report above would have shown; after this change it
  should stay near zero.
- **New tests** (4): a full budget refuses captures instead of evicting what is on
  screen, and does not spin; bitmaps nobody is drawing any more are what makes
  room; the ladder is 256 MiB to 2 GiB with a floor that saved values land on; a
  shadow-flag change pauses reuse and throws nothing away; and the flicker counter
  counts a change of state.

## What changed in v2.3.0

- **A flat box can now be a picture of the node it stands for.** New **node
  snapshots** setting in the Tweaks tab (off by default): the nodes the flatten
  threshold turns into rectangles are captured once while the page is idle —
  drawn through their own draw path into their own offscreen canvas, at the
  capture ratio you pick — and later frames blit that picture with one
  `drawImage` instead of painting a fill. Panning and zooming keep reusing the
  pictures on purpose: the camera moved, the node did not.
- **It replaces boxes, never live nodes.** The flatten threshold is still the
  only setting that decides which nodes stop being drawn in full, so snapshots
  can never change what a zoom you have not already flattened looks like. A node
  that is selected, hovered, carrying a validation error, running (`progress`),
  or being dragged stays live and is drawn by ComfyUI — a bitmap of a transient
  state cannot exist, because those nodes are not captured at all.
- **A node the canvas cannot own is never captured.** As shipped in v2.3.0 this
  was upstream's line: a widget that is a DOM element, a `dom`/`custom` widget
  type, a function-valued widget or property, or a string over 4 kB was refused
  for good. **v2.4.0 moved that line to where the canvas is** — such nodes are
  captured now, the browser-drawn part of them is not in the picture, those
  pictures are counted as "the canvas part only", and what keeps a box is the
  smaller, provable set of reasons (nothing drawn into the canvas, too big at any
  ratio, too slow to capture, changing faster than it can be photographed, or a
  type you put on the keep-live list).
- **Staleness is bounded and stated.** A picture is only used while the node's
  signature — title, size, flags, mode, colours, connections, widget values,
  progress, error state, the canvas's own render flags, the theme — still
  matches, re-checked at most every 100 ms per node. Anything the tool can see
  cheaply is checked every frame instead. A node whose own capture took longer
  than 60 ms is blocked for the session rather than stalling the page twice.
- **A capture's cost is the tool's, not the pack's.** The capture runs the
  node's real draw path, including other extensions' hooks, but attribution
  steps aside while it runs and the time lands in the snapshot's own counter
  (`captureMs`). Without that, a capture would show up in the Timing tab as the
  pack being slow.
- **The idle lane is the one this tool already had.** Captures are batched under
  the same budget as everything else in the Governor tab, pause the moment
  there is input (pointer, wheel, key), and slice with a gap between them, so a
  thousand-node graph is captured over a second or two rather than in one
  visible pause. No second scheduler.
- **Memory is bounded and given back.** The bitmap budget (256 MiB to 2 GiB,
  default 512 MiB since v2.3.1) is enforced by eviction, and releasing a bitmap
  zeroes its canvas so the pixels return to the browser. A picture that is being
  drawn is never released to make room (v2.3.1), a capture that does not fit is
  tried at 1x before being refused (v2.4.0), and the readout counts refusals,
  coarse pictures, fits and releases separately. Bitmaps are also
  released when you switch snapshots off, when the tool's master switch goes off,
  when the flatten threshold goes to zero, when the graph's theme changes, and
  for nodes that have left the graph.
- **Everything fails open.** A fault in the reuse path turns the feature off and
  paints boxes, with the reason in the panel's own error line; a fault in a
  capture blocks that node and, after five in a row, turns the feature off the
  same way.
- **A picture of the box itself**, generated from the real paint path:
  `preview/boxes.html` (open it in a browser) and `preview/boxes.png`, plus the
  fourth panel showing what a snapshot bitmap covers — the body, LiteGraph's
  30-unit title bar, 24 units of padding, and the frontend's own error stroke
  landing inside that rectangle. Regenerate with `node tools/box-preview.mjs`.
- **Honest limits, written down** (also in the LIMITS block at the bottom of
  `web/tracker.js`): a signature is re-checked every 100 ms, so a change can be
  shown stale for up to that long; a picture is the node at the moment it was
  captured, so a node whose live drawing animates without changing a signature
  field shows that frozen frame; and zoomed in past the capture ratio a picture
  is softer than live drawing — which is why the ratio is a setting and why the
  nodes you are working with are never served from one.
- The capture ratio (1x/2x/3x per graph unit) and the budget are provisional
  defaults: the next step measures hit rate, bytes and frame time on real graphs
  and sets them from numbers (plan.md, Track K3). The budget ladder changed in
  v2.3.1, above, after the first real numbers arrived, and v2.4.0 added the
  fit-to-cap and coarse-instead-of-refused rules; the ratio question is now also a
  coverage question, because how many nodes can hold a picture is the budget
  divided by the pixels per picture.
- **New tests** (16): off by default (no captures, no canvases, no blits); an
  idle slice captures what was boxed and the next frame blits it, at the padded
  rect and the chosen ratio; nothing is captured while the page is being used;
  the always-live set is never served from a picture (and a ghosted node is,
  because its dimming is part of the drawing); dragging keeps nodes live while
  panning and zooming reuse everything; a changed widget drops the picture;
  a slow capture blocks that node for good; a capture runs other extensions'
  hooks without attributing their time to them; DOM-widget and
  function-valued nodes are refused; the budget evicts and zeroes canvases;
  switching off, zeroing the threshold and the master switch all release the
  memory; a deleted node's record is pruned by the sweep; a fault in the reuse
  path hands the page back with the reason in the panel.
- Deliberately **not** built in this step: snapshots replacing *live* nodes
  during movement. That is the version with a performance claim attached, and it
  needs the measurement first (K3) rather than a promising default.

## What changed in v2.2.0

- **The flat boxes now say what they stand for.** Painting 1,000 nodes as grey
  rectangles removes nearly all of a node's draw cost, but it also removes the
  node: at 10% zoom a node with a validation error looked exactly like a healthy
  one, a muted node looked live, and nothing on screen said which node was which.
  A new **box detail** setting next to the flatten threshold offers three levels:
  `plain` (exactly what was painted before), `title` (each box gets the node's own
  title-bar colour, drawn above the body where LiteGraph draws it, at its own
  30-unit height), and `state` (adds the marks that vanish at this zoom a
  validation-error ring, the progress bar of the node that is running, and the
  dimming of a muted, bypassed or ghosted node).
- **Every mark is the frontend's own, at the frontend's own numbers.** The error
  ring is LiteGraph's error stroke (`#E00`, 10 units wide, 12 units outside the
  node — the same geometry the full-detail node gets), the progress bar is the
  frontend's own bar (green, as wide as `progress` says, with a floor of a few
  screen pixels so it survives a low zoom), and the dimming uses its own alphas
  (muted 40%, bypassed 20%, ghosted 30%). Nothing is inferred from a colour or a
  name, and a node that says nothing gets no mark.
- **It cannot change which nodes are boxes.** The ladder is about a box that
  already exists: it does nothing while the zoom setting is off, nothing above
  the flatten threshold, and switching it back to `plain` restores the previous
  paint exactly. The panel counts every mark it drew (`N title bar(s)`, `N error
  ring(s)`, `N progress bar(s)`, `N dimmed`), so the price of a mark is a number
  rather than an assumption.
- The copyable report's settings line now names the box-detail level, and a
  small text bug is fixed with it (`idle redraw cap offms` reads `off`).
- **New tests** (5): the default paints one rectangle per node and nothing else;
  `title` adds a bar above the body at LiteGraph's own height, clamped so a short
  node does not become nothing but title; `state` adds exactly one ring, one bar
  and three dimmings to a graph where exactly one node has each condition; the
  ladder never changes which nodes are flat and going back to `plain` restores
  the paint byte for byte; and the panel and the API report the level and price
  the marks. The demo prints one frame of each level's marks.

## What changed in v2.1.16

- **The pill belongs on the floating button, not only on the node.** v2.1.15 put
  it on the node's DOM widget, which is a place the frontend can still take away
  from it (it is the same layer every other widget lives in, and at low zoom the
  node itself stops being drawn). The floating control — the thing that has always
  been pinned to the screen — is now the pill: `[switch][gear]`, the same builder,
  the same geometry, the same handlers as the node's widget. The old 🔧 emoji is
  the drawn gear glyph, so both places look and behave identically.
- **Switching the tool off no longer takes the tool's own UI with it.**
  v2.1.15 closed the panel and hid the corner button when the switch went off,
  which left the screen empty except for the node's pill — the worst possible
  moment to make someone hunt for the way back. Now: the pill stays exactly where
  it is (marked `.ants-own`, so no sweep, gate or hover rule of this tool can box
  it, inert it or swallow a click aimed at it), the panel stays open if it was
  open, and both the panel's banner and the panel's own ⏻ button say what
  happened. What the switch does is hand the *page* back — hooks, sampling,
  deferrals, the redraw cap, the low-zoom drawing, the DOM it dressed — and
  nothing else.
- **The switch is described as what it switches off**, in the tooltips, the
  banner and here: the hooks and the optimisations. Its state is the same
  `S.enabled` as before, so everything v2.1.15 gated is still gated.
- Dragging the pill is still a drag: a press that moves past the long-press
  threshold does not flip the switch it started on, and does not toggle the panel.
- While the switch is off the panel keeps repainting itself, so its controls and
  the banner stay truthful. That repaint is the panel's own cost, not a
  measurement: nothing is sampled, and every number it shows is the frozen last
  one from before the switch went off.
- **New tests** (2): the floating pill carries the switch and the gear, the gear
  opens the panel without switching anything off, the switch toggles without the
  pill being hidden or the open panel being closed; and dragging the pill moves it
  while flipping nothing. The low-zoom sweep test now also asserts the floating
  pill is untouched by a sweep that hides an ordinary node's widget next to it.

## What changed in v2.1.15

- **The node's own controls are back, and they are the way in and out of the whole
  tool.** *(v2.1.16 moved the primary copy of this pill to the floating button; the
  node keeps its widget.)* v2.1.14's focus mode fixed the widgets but took the tracker's *own* widget
  with it: below the flatten zoom the node is a rectangle, the frontend stops drawing
  its header and its canvas-drawn button, and the node DOM that used to carry the
  gear was hidden by the same sweep that hid everybody else's. There is now a pill on
  the node — `[switch][gear]`, one rounded frame, round ends — and it is exempt from
  every rule this extension has: it is marked `.ants-own` and the sweeps, the widget
  gate, the hover hooks and the event gate all skip it by construction, so at 10% zoom
  with every setting on it is the one live element on the page.
- **The switch is a real off, not a quieter tracker.** Clicking the checkbox sets the
  master switch (`S.enabled`) and, with it off: nothing is wrapped, nothing is sampled
  or timed, no redraw is capped or deferred, no drawing setting is applied (every
  low-zoom class is removed and node DOM is handed back), no hover hook is held back
  and the event gate's set is empty, the raf monitor and the memory sampler stop.
  (That release also closed the panel and hid the corner button for one version —
  v2.1.16 takes that back: the tool's own UI stays put.) What is *not* touched is
  your settings, the pill, and ComfyUI: the page goes back to being exactly ComfyUI's own, and the
  checkbox — or ⏻ On in the panel — brings everything back with the settings you had.
  The panel stays openable (the gear still works) and says so in a banner.
- **Both controls are the same size and the same colour, by geometry rather than by
  eye.** The button box is 22px with `box-sizing: border-box`, and the glyph is drawn
  in a 22-unit viewBox where one unit is one pixel — so the switch's ring, drawn as a
  1.5px border *inside* the box, has its centre line at r = (22 − 1.5) / 2 = 10.25,
  and the gear's teeth end on exactly that circle in exactly that 1.5px line. Both are
  `#AE7719` in every state: hover only moves the background behind them.
  - Unchecked, nothing of ours is painted inside the ring — the ComfyUI theme's own
    background shows through — and the ring is the accent colour.
  - Checked, the interior becomes `#0D2A2A`, and the ring and the checkmark stay the
    accent.
- **Nothing in the suite could look at the pill**, so `tools/pill-preview.mjs` renders
  it — the real CSS and the real glyph builders extracted from `web/tracker.js` — into
  a page you can open (`preview/pill.html`, and `preview/pill-4x.png` /
  `preview/pill-8x.png` if you would rather just look at a picture). It exits non-zero
  if the extraction stops matching, so the picture cannot quietly disagree with the
  extension.
- **New tests** (3): the pill survives a sweep that hides everything else and its
  switch still toggles the tool; switching off hands the page back (links drawn at
  ComfyUI's own width, elements un-hidden, nothing recorded, no widget gate left in
  the way) and switching on restores the same settings; and the panel's banner and its
  own ⏻ button say and do what the checkbox does.

## What changed in v2.1.14

- **Why v2.1.13's focus mode did not stop the widgets, in one line each.** The
  report from the real page was "all node widgets are still clickable at 10%
  zoom, and the 3D viewports are still fully interactive", with the panel showing
  144 elements carrying the inert class. All three of these were true at once:
  - **Most widgets are not DOM elements at all.** A slider, a combo, a text box or
    a button is drawn *on the canvas* and hit-tested by arithmetic:
    `LGraphNode.getWidgetOnPos(x, y)` walks the node's widgets and returns the one
    under the cursor. No CSS class can reach that — which is why a page can have
    every node's DOM switched off and every widget still answering the pointer.
  - **A 3D viewport's render loop is driven by the *node's* hover flag.** The
    extension chains `node.onMouseEnter`/`onMouseLeave` when the node is created
    (see `useLoad3d`), and the canvas calls those from its own hit-testing — not
    from DOM events. Its `isActive()` is
    `mouseOnNode || mouseOnScene || mouseOnViewer || recording || !initialRenderDone
    || animationPlaying`, so `pointer-events: none` on the wrapper could never make
    `mouseOnNode` false. Switching the DOM off stops `mouseOnScene`; the canvas
    hover path keeps `mouseOnNode` alive and the Three.js frame keeps being drawn.
  - **An element whose owner cannot be worked out was skipped entirely.** The
    registry resolved a wrapper to a node by position arithmetic, and only looked
    at the layer for nodes it was already flattening — so a page where the
    arithmetic comes out differently (a display scale, a transformed container)
    ended up with live viewports and a panel that still reported work done.
- **Four mechanisms now, and they do not depend on each other.**
  1. **The canvas widget gate.** `LGraphNode.prototype.getWidgetOnPos` answers
     "no widget" below the focus zoom and for any node past the fovea margin. That
     is the one gate that can be closed without taking the node with it:
     `processMouseDown` asks for a widget *first* and only then falls through to
     dragging the node, and mousemove asks for the widget under the cursor to build
     its hover report. So a slider cannot be grabbed, dragged, hovered or
     scrolled — and the node still selects, drags, edits and opens its menu. The
     panel reports `blocked / seen`.
  2. **The node hover hooks.** `onMouseEnter` and `onMouseMove` are wrapped per
     node and held back while its widgets are off, so a 3D viewport's
     "pointer is over me" flag never becomes true and its render loop stays idle.
     `onMouseLeave` is deliberately *not* held back (it is what clears the flag),
     and when a node is switched off while the pointer is on it the leave is called
     by the tool — otherwise the flag would stay stuck and the viewport would keep
     rendering forever. The canvas's own hover bookkeeping (`node.mouseOver`,
     `canvas.node_over`) is cleared at the same time, so the two states cannot
     disagree.
  3. **Node DOM is hidden outright, not just made inert** (a new "widgets: hidden
     outright / inert only" control, hidden by default). An element with
     `display: none` cannot be clicked, hovered, dragged onto, scrolled into or
     entered at all, whatever its own CSS says — and the registry now finds these
     elements by `.dom-widget` anywhere in the page, and *does not require* an
     owner: the focus half switches off every node-DOM element, because "which node
     is this" is only needed for the per-node decisions (flattening, off-screen).
  4. **The event gate.** While an element is switched off, the events that would
     start or continue an interaction with it (pointer, mouse, click, contextmenu,
     wheel) are stopped in the capture phase at the document, before any handler
     anywhere can see them — counted, and reported. This is the part that does not
     depend on the page's CSS or on a framework leaving this tool's classes alone.
     It is blind to everything else by construction: the test is a set lookup on
     the target's ancestors, and the set is empty whenever nothing is switched off.
- **Honest verification, in the panel.** On the once-a-second sweep the tool reads
  `getComputedStyle` for a sample of the elements it believes it switched off and
  reports how many the *page* agrees about (`N of the sampled ones confirmed by the
  page's own computed style`, plus `M still reachable` when the answer is no). A
  readout that only counted what this tool wrote would be describing its
  intentions, not the page.
- The readout line now names all four counts, and the demonstration in
  `tests/demo.mjs` prints the same numbers with none of the page present.

## What changed in v2.1.13

- **Viewport focus reaches the 3D nodes this time, and stops taking the nodes
  with it.** Two corrections to v2.1.12's focus mode, both from the report that
  the 3D nodes were still clickable and the ordinary nodes had lost their
  selectability:
  - **A node is no longer made unclickable.** The frontend's own node hit-test
    (`LGraph.getNodeOnPos`) is left exactly as ComfyUI wrote it, so nodes still
    select, drag, edit and open their menus at any zoom. What is switched off is
    the *widget* UI: the class now lands on the widget's wrapper plus everything
    inside it (`pointer-events: none !important`, descendants included, because a
    child that sets `pointer-events: auto` overrides an inert ancestor — and the
    frontend's own widget layer sets it inline on the very wrappers we touch).
  - **The 3D viewports are reachable at all.** The core 3D nodes are
    `ComponentWidgetImpl`s: the widget object has no `element` to walk from, and
    its DOM is a wrapper the frontend renders into the DOM widget layer. The old
    sweep walked `node.widgets` and then only looked at the layer for nodes it was
    already flattening, so with the node-flattening setting off a 3D viewport was
    invisible to it. There is now one registry of node DOM — built from widget
    elements, Vue node roots and the layer wrappers — and it is consulted for
    every node, flattened or not.
- **Why the 3D nodes care, specifically.** ComfyUI's 3D viewer decides whether to
  render by asking whether the pointer is over it (`isLoad3dActive` =
  `mouseOnNode || mouseOnScene || mouseOnViewer || recording || !initialRenderDone
  || animationPlaying`), and its render loop runs a Three.js frame per rAF tick
  while that is true. So merely moving the mouse across a 3D node makes it render
  its scene every frame *on top of* the canvas redraw, and its wheel handler
  captures scrolling to zoom the model instead of the graph. `pointer-events:
  none` turns both off at the source: the viewer is told the pointer is not over
  it, so it stops rendering; the wheel goes to the canvas, so the graph zooms.
- **Foveation costs less than it saves, this time.** The first version re-walked
  the DOM widget layer every 250 ms while the view moved, which is the one thing
  that must not happen inside a pan. Now the layer is read once a second and
  ownership is cached per element (an unchanged wrapper costs a float comparison),
  while the per-frame work is arithmetic over the registry with a class written
  only where the answer changed. Two more knobs:
  - **margin: ½ a screen by default** (¼, ½, 1, 2), instead of a full viewport;
  - **coming back is rationed: one element per drawn frame by default** (1, 4, or
    all at once). Going away is a class on something nobody is looking at;
    coming back re-runs layout for that widget and re-measures a 3D renderer, so
    it is the expensive direction — and whatever is *on screen* is handed back
    immediately regardless of the budget, so a visible widget is never blank.
- **The display-scale check, run at startup.** Windows display scaling (System →
  Display → Scale, 200% on a 4K screen) makes the canvas backing store larger than
  the element it is drawn in, and anything that divides by the backing store is
  out by exactly that factor. The check reads `window.devicePixelRatio`, the
  canvas backing store against its own CSS box, and the frontend's own
  `visible_area` against this tool's independent computation of it — then says
  which unit that rectangle is in. The maths itself no longer depends on the
  answer: the viewport comes from the canvas's *CSS* box and the draw state,
  LiteGraph's own arithmetic in the unit that cannot be scaled. The check runs
  once at startup, once a second with the sweep, whenever the panel refreshes,
  and it is in the readout and in `snapshot().lowZoom.focus.display`. If it reads
  wrong, "display scale" can be pinned by hand (auto / 100%…300%).
- Everything here is off by default, remembered across sessions, and handed back
  by "Back to full drawing".

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
