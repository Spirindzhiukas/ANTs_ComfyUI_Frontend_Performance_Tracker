# Changelog

Version history for ANTs_ComfyUI_Frontend_Performance_Tracker. Newest first.
The current behaviour is in `README.md`; the reasoning behind each release is in
`memory.md`; the rules for changing the code are in `CLAUDE.md`.

## What changed in v2.7.5

- **The warning badge is a live-fallback indicator only.** A flat box shown while a
  picture is not yet available gets the amber/black mark; a fully captured or
  cached picture does not. The capture path no longer paints it, and `hv-warning-
  fallback-only-2` changes the picture signature so old badge-bearing RAM/disk
  entries miss and are rebuilt. Regression checks the live fallback, the offscreen
  captured bitmap, and a later cached blit separately.

- **The recent-metric windows are explicit in the tabs.** Timing and node-type rows
  use a rolling 4-second window and naturally drop out after no activity; this is
  aging, not a reset. Stalls headline rates use the same 4 seconds, while source
  rows remain for 30 seconds after the last event and their source totals are
  cumulative. The retention policy is unchanged; a regression proves the rate ages
  out before the Stalls row does. The panel now says these windows where the user
  sees the rows.

- **Live report follow-up: no renderer-specific Governor removal was found.** The
  in-page panel builds its Governor tab in either renderer mode. Its clean defaults
  are normal per-source policies, rAF governor off, redraw coalescing off and
  autopilot off, but `ants-governor-v1` can restore user-selected policies. The
  separate-window page intentionally has only Node Rendering Settings, Status,
  Timing, Nodes and Stalls; it does not include Governor. The active browser's
  version, tab surface and stored Governor state still need checking.

- **Remaining live symptoms are not diagnosed here.** Vue textarea values still
  have no hard 2,000-character cut; they wrap and clip to their measured box, unlike
  the separate canvas DOM-widget route's 2,000-character / 12-line caps. The latest
  Nodes 2.0 truncation and odd captures still need a live report and paired image;
  the painter reconstructs DOM into canvas and is not a browser screenshot.
  No CPU-only Electron A/B or pixel comparison was run.

- **Verification:** `node tests/run-tests.mjs` — **247 passed**; `python3 tests/test_init.py` — **9 passed**; `node tests/demo.mjs`, ES-module syntax checks, preview regeneration and `git diff --check` all passed. No real Electron A/B or live pixel comparison was run.

## What changed in v2.7.4

- **Progress and errors now stay live over a held Nodes 2.0 picture.** The stand-in
  remains in place while a Vue node runs or errors; the current `node.progress` bar
  and `node.has_errors` stroke are drawn over the existing bitmap on each reuse.
  Those transient fields are excluded from the Vue picture signature and capture
  queue, so they are never frozen into the bitmap and do not trigger a recapture;
  clearing either mark removes it on the next draw. The classic canvas renderer
  still draws running/erroring nodes live. Video and link-drag handling still hands
  the Vue element back to the frontend. The separate Vue executing outline is not
  reconstructed by this change.

- **The high-voltage badge was corrected to live-fallback-only in v2.7.5.** The
  amber triangle, dark border and lightning bolt identify a live fallback box; a
  successfully captured or cached picture deliberately has no badge. The capture
  path skips it, and the signature token invalidates older badge-bearing RAM/disk
  entries so they miss and are rebuilt without the mark.

- **Text limits are now explicit per pathway.** Ordinary Vue DOM text is capped at
  2,000 characters per string; same-length edits inside that prefix are hashed in
  full and refresh the picture. Vue form values, especially textarea prompts, are
  passed to wrapping intact and clipped by available lines rather than hard-sliced
  at 2,000. The separate canvas DOM-widget composite still slices values at 2,000
  characters and keeps its 12-line limit. Regressions cover each route, including a
  textarea value beyond 2,000 characters that fits its enlarged box and is drawn
  through its tail sentinel.

- **Tests at the initial v2.7.4 pass: 246.** New coverage also proved that marks
  overlay a held picture without capture/signature churn and that a badge alone
  cannot validate blank content. The v2.7.5 follow-up adds explicit assertions
  that successful captures and cached blits never contain or receive the badge.
  Both `preview/boxes.html` and `preview/boxes.svg` render the badge on live fallback
  boxes; the preview tool serializes the painter's path operations so its amber
  triangle, dark outline and lightning bolt remain visible.

- **What is not claimed:** these are source/harness correctness results, not a live
  CPU-only Electron FPS or pixel-fidelity result. The supplied performance report
  had low-zoom drawing off, so it does not establish the user's estimated ~15 fps
  with stand-ins versus ~25 fps without. Dark control/background differences in
  Nodes 2.0 remain undiagnosed; both require a real-page comparison.

## What changed in v2.7.3

- **The theme signature was backwards: it reacted to class names and was blind to
  colours.** The capture lane drops the picture store when the page's palette
  moves, and the signature it compared was the roots' `className` plus their inline
  styles. So a page that toggles a *transient* class on `<body>` — a drag, a toast,
  a modal, anything Tailwind-flavoured — re-photographed every node, while a theme
  that changed through a **computed colour** was invisible to it. A probe
  (`/tmp/probe/theme.mjs`: 20-node scene, 40 warm-up frames, then 300 frames with
  `<body>` flipped every 50th) measured the wrong direction in both halves: a class
  flip ⇒ **120 captures / 6 clears / 15 600 rects**; a background colour moved ⇒
  **0 / 0 / 0**.

- **The resolved colours are the signature now; the names are only a doorbell.**
  `lodSnapThemeSig` builds a cheap key from the roots' class names and every inline
  style name/value; only when that key moves does it re-sample the roots'
  `getComputedStyle().backgroundColor|color` (guarded, so an unreadable palette is
  not a change) — and *that sample* is what the signature compares. Inline `--*`
  properties still go straight into the signature. A palette can also move while the
  capture lane is idle, so `lodVueFramePlan` re-samples on a 2 s beat and clears
  then if it must. New state: `snapThemeAt`, `snapThemeKey`, `snapThemeCols`.

- **After the fix the same probe measures the same two scenarios exactly
  inverted:** class ⇒ **0 captures / 0 clears / 1 300 rects**, colour ⇒ **120 / 6 /
  15 600**. The new test (*a class the page toggles is not a theme change, and a
  moved colour is*) fails on the pre-fix file and passes here; the suite is **240**.

- The pitfall is real enough that the reference implementation guards it from the
  other side: `NodeSnapshots`' `theme_signature()` filters root class names to
  `/(^|[-_])(dark|light|theme)([-_]|$)/i` for exactly this reason (see
  `docs/node-snapshots.md`, and note that it also ignores a colour that moves — the
  lesson here is to compare the resolved palette, not the names).

## What changed in v2.7.2

- **The Nodes 2.0 stand-in pathway's per-frame cost was a capture loop, and it is fixed — measured, not explained away.** The thirteenth report's numbers (75 nodes, 20 fps, 124 ms of stalls per second, most of the frame budget outside drawing) sent this pass into the capture lane itself with an instrumented harness instead of a theory: a synthetic Vue-nodes scene was driven frame by frame and the captures, the layout reads and the host time per frame were recorded, with and without the page changing anything. A quiet scene cost 0.91–1.36 ms/frame at 0.06 captures/frame. A scene where the page rewrites a widget value on every frame — a poller: the signature changes, the picture is dropped, the node re-enters the queue — cost **2.79–6.80 ms/frame at 1.39 captures/frame**, and twelve nodes with sixty live rows cost **15.37 ms/frame at 5.00 captures/frame**.

- **The mechanism was in the lane's own bookkeeping.** A *successful* capture clears the node's staleness and its entry in the settle map, and `lodVueSettleLeft`'s ceiling (`LOD_SNAP_SETTLE_MAX_MS`, 900 ms — the rule that lets a node that never stands still be photographed at all) was **one-shot**: once it had passed for a node, `lodSnapTake` had no reason left to defer it, so every later ask bought a full re-capture — and a page rewriting a widget value has an ask on every slice. Two smaller costs rode along: `lodVueShotWait`'s completeness gate forced a *fresh* measurement on every ask (so a deferred node paid a whole node's worth of computed styles and rects per slice — 4.2 measurements per frame in the harness), and the disk write ran on every picture of a churning node, which is the most expensive and least useful part of the capture: the file is a cache for the *next* page load, and the signature check makes a stale file a miss.

- **The fix, five edits, all in the lane.** (1) A **photo floor**: `LOD_SNAP_PHOTO_MS` (600 ms) — a node photographed a moment ago is postponed exactly like a node that has not stood still, and `lodSnapPhotoLeft` is folded into the picker's `Math.max(lodVueSettleLeft, lodSnapPhotoLeft)`, so the node **stays in the queue** and the slice sleeps for the larger window ("not yet, try again later, never *no*"). Rationing at the *enqueue* instead was tried first and reverted: a deferred node then became a *dropped* node, photographed again only if something else made it change — which the existing test *a change re-opens the settle window before the picture is replaced* catches. (2) The same floor is checked where the work happens (`lodSnapCaptureNode`), because the disk-ask path and a settings change reach the lane directly. (3) A successful capture **re-arms the settle window** (`LOD.vueSettle.delete(node)`), so the next change gets the same 300 ms grace the first one did — before this, past 900 ms a later change was photographed on the next slice, mid-render, which is the "captured too early" the user reported twice. (4) `lodVueShotWait` reads the **cached** measurement: the gate asks about a stamp, an age and the page's media, and forcing a measurement there made every deferred slice pay a layout read for a node it then refused to photograph; the capture itself still measures fresh. (5) `LOD_SNAP_DISK_MS` (5 s) rations the disk copy while a node churns.

- **Measured after the fix** (same harness, 180 frames per scenario): quiet 0.91–1.36 ms/frame; live values **0.92–1.53 ms/frame at 0.17 captures/frame** (from 2.79–6.80 at 1.39); twelve nodes with sixty rows **3.00 ms/frame at 0.20 captures/frame** (from 15.37 at 5.00). The picture is still made and still replaced as the node changes — it is made about ten times a minute instead of once per slice.

- **Tests: 239** (three new), and each one **fails on the pre-fix file**: *a node the page keeps changing is photographed at a floor, not once per slice* (20 asks over six seconds took 20 pictures before, at most 16 now — and the postponed picture is still taken once the node stops changing: the postponement is never a drop); *every change gets its own grace period, not only the first one* (a change made a second after the first picture is not photographed 120 ms later, though the ceiling that lets a burst be photographed has long passed — before the fix it was photographed on the next slice); *a node that keeps changing writes its file at a floor, not on every capture* (nine pictures of a churning node wrote eight files before, at most one now).

- **Readout.** No new counters: the existing ones already tell the story (`captured`, `vueLayoutReads`, `vueSettleHeld`, `diskSaved`). The panel's summary sentence for a held slice now names both reasons a slice can be held (`settling, or inside the floor between two pictures`), because it used to name only the settle window, and the LIMITS block says what the floor is and what it measured.

## What changed in v2.7.1

- **The picture now carries the node's own icons — the part of a node that has no element to read.** In this renderer an icon is not an element with a picture in it: the frontend's iconify Tailwind plugin compiles `icon-[comfy--comfy-c]` to `mask-image: url("data:image/svg+xml,…")` with `background-color: currentColor` and `mask-size: 100% 100%`, so the glyph exists only inside that data URL — no text, no children, no `<svg>`, and nothing in the markup that names it. A reader that stops at `textContent` therefore leaves a hole exactly where a node shows its badges, its control icons and its footer tabs, and a reader that drew the element's box instead would paint a solid blob of the icon's colour. The reader now takes the mask from the computed style it was already reading for the text (`lodVueTextStyle` returns the mask, the mask size, the background image and its size alongside the font), parses the SVG **once per data URL** (`lodVueIconParse`; the cache is a Map keyed by the URL, capped at 128, because a page reuses a handful of glyphs across hundreds of elements) and re-draws its shapes as a `Path2D` in the element's own box, scaled out of the icon's own `viewBox` (`lodVueIconInk`). A mask is drawn in the colour the mask clips out of — the element's own background, which is `currentColor` at the plugin's rule and is what the browser resolves it to — and a background-image icon carries its own colours, with `currentColor` in it meaning the element's text colour. Shapes with a primitive (path, circle, ellipse, rect, line, polyline, polygon, one level of `g`) are drawn; anything else — a raster mask, a mask that is *tiled* rather than stretched over the box, a `d` that is not path data, a context without `Path2D`, or one without `save`/`restore` (a transform that cannot be put back would move everything drawn after it) — is **counted and left as a hole**, never invented as a blob (`vueIconSkip`), and the glyphs drawn are counted (`vueIcons`). The shim and the harness gained what the tests needed to hold this: `computedStyle` now answers `maskImage`/`maskSize`/`backgroundImage`/`backgroundSize` (and the dashed spellings through `getPropertyValue`), and the sandbox has a `Path2D` that records the path data it was built from.

- **The badge row and the footer tabs are structure in the picture too.** `NodeBadges.vue` puts a test id on the Comfy badge alone and `NodeFooter.vue` on each tab; the surfaces the user sees are the pills those badges sit in and the band the tabs sit on. They are read by **relationship** rather than by class name — the anchor's own box, the anchor's siblings inside the badge row (capped at 8), the tab button and its parent — because the class names are generated Tailwind utilities that a frontend rebuild can rename under this reader without a single test noticing, while every picture would quietly lose those surfaces (`lodVueChromeBoxes`, two new kinds, `badge` and `footer`, drawn after the panel and under the node's content). An element already read as one kind is not measured again as another, so the Comfy badge is not both "the anchor" and "a sibling of the anchor".

- **The glyph is part of what makes a picture out of date.** The signature mixes each icon's box and its own **geometry**: a hash of the viewBox and every shape's path data, fill, stroke, width and fill-rule. The URL is deliberately *not* what is hashed — every icon in a set shares its SVG header and its closing bytes, and the signature's cheap long-string hash looks at the two ends, so two different glyphs hash alike (found while writing the test for exactly this: the check-mark `<path>` and the `<circle>` dot hashed equal, and the picture showing the first was kept when the page showed the second). Two URLs that spell the same glyph are the same glyph and correctly invalidate nothing.

- **What this does not claim.** An icon whose CSS the page injects *after* a picture was taken is not noticed until something else makes that node stale: a node whose element the page reports changes for is re-measured on those reports rather than on a timer (that is the 5 s beat, and it is what keeps the steady state free of DOM work), while a fresh measurement always reads the icons as they are then. On the built frontend the icon vocabulary is generated into the stylesheet, so it is there before the first node element is measured; the window exists for a dynamically added icon, and it closes on the node's next change. Recorded in `ANALYSIS.md`, not engineered around.

- **Tests: 236** (four new, all in the Nodes 2.0 suite): *a node's own icons are drawn into the picture, from the mask the page paints them with* (the path data, the box it is drawn in, the scale out of the viewBox, the colour the mask clips, and the panel's own sentence); *a picture carries the icon the page shows, and is remade with it when the page changes it* (the old glyph's picture is dropped, the new one carries the new glyph and not the old); *an icon the reader cannot read is a hole and a count, never a blob* (a raster mask, a tiled mask, an SVG whose only shape is text and a `d` that is not path data: no geometry, no green box where the icon is); *the badge pills and the footer tabs are surfaces in the picture, read from the page's own anchors* (each pill and the footer band at the rects the page laid them out in, in the colours the browser computed). **Mutation battery: nine anchored edits, nine caught** — the icons not read at all, the mask painted in the text colour instead of the element's background, a tiled mask accepted, the geometry key back to the URL's ends, the glyph removed from the signature, circles and rects not treated as shapes, the badge pills beside the anchor not read, the footer band above the tab not read, and a drawn glyph not counted as content.

## What changed in v2.7.0

- **The twelfth report asked for three things at once: stop the flicker on some nodes, stop photographing a node at the wrong moment, and rethink the capture as a plain screenshot of the node "as it is being shown by the frontend to the human user".** The first two had reproduced causes; the third turned out to be a question about what a page *can* do, answered below.

- **The flicker had three causes, all of them about who owns a node's element.** (1) The tool cached the element it dressed for a node and trusted it until it left the page — but this frontend reuses elements and rewrites the `data-node-id` they carry (a slot given to another node, a graph swapped under the same pane), so a cached element could belong to a *different* node: the box was painted for A while B's element was blanked or handed back, which is exactly a node fighting its own stand-in. `lodVueRootEl` now trusts a cached element only while `getAttribute("data-node-id")` still equals the node's own id (otherwise `vueStaleEls` is counted and the element is looked up again). (2) **The mark was re-applied on the next canvas draw, and a draw is neither guaranteed nor immediate** — between the frontend putting a node's element on the page and the next frame, the *real* node was on screen, and then the box took its place. The page says when an element arrives: `lodVuePaneWatch` puts one `childList` `MutationObserver` on the container the frontend renders its node elements into, reads the report's own `addedNodes`, resolves the child to a node through `data-node-id` (`lodVueNodeById`, a lookup cache rebuilt at most every 250 ms so a workflow load is one scan rather than hundreds) and re-marks that node **in the observer callback — a microtask after the DOM change, before the browser paints** (`vueRedressed`). A report that arrives without the added nodes is still answered: the standing-in nodes are swept directly, capped at 256 per report. (3) **A replacement can be delivered as two reports** — a removal in one task, the addition in the next, with a paint in between if nothing happens; a node that had just lost its element was therefore forgotten. It is now remembered for `LOD_VUE_ORPHAN_MS` (500 ms), so the element that arrives next is dressed on arrival (`lodVueOrphan`). The hand-back side of the same ledger is now explicit too: an element the frontend has taken off *this* node is handed back (so a reused element cannot come back invisible), an element it has given to **another** node keeps *that* node's mark (`lodVueClaimsOther`, compared as strings — `"7" === 7` is false, which is how the first cut of this handed back a mark it should have kept), and a stale element is never blanked. The pane itself can be remounted: `lodVuePaneStill()` re-attaches the watcher on the frame after the panes' elements arrive.

- **"Still captured at the wrong moment": a picture now waits for a node that has not finished.** The settle window (300 ms, re-opened by every change; ceiling 900 ms) already held a node that was being *written*; it did not hold one that was still *arriving*. `lodVueShotWait` is the completeness gate, and it names what it waits for: a node with no change stamp has nothing to wait for and passes at once; inside the window, a node whose element has no laid-out box yet (`vueWaitLayout`), whose own `<img>` reports `complete === false` (`vueWaitMedia`), or which has content of its own while the page's fonts are still loading (`vueWaitFonts`, `document.fonts.status === "loading"`; an absent API counts as ready) is left for the next slice and named in the readout (`waiting: its images are still arriving`). The ceiling still wins: past `LOD_SNAP_SETTLE_MAX_MS` a node that never settles is photographed anyway, because a picture of a node that is still arriving beats a box that never becomes one.

- **The page's fonts are now part of the picture's signature.** A picture drawn while the webfont is loading is drawn in the fallback font, and serving it afterwards would keep the wrong font for as long as the picture lives; the signature carries `fonts:ready` / `fonts:loading`, so that picture is thrown away and re-made the moment the page's fonts arrive. Pinned by a test that photographs a node through the ceiling in the fallback font, flips `document.fonts.status`, and watches the invalidated picture be re-made.

- **"Take simple screenshots of the nodes as they are being shown to the human" — re-read against what a page can actually do.** A pixel screenshot of a DOM element is not obtainable from page JavaScript: no browser API draws an element into a canvas. The one route that exists is a rasteriser — serialise the live node with `XMLSerializer`, inline its computed styles (`getDiffStyle`-style, as `modern-screenshot` does), wrap it in an SVG `<foreignObject>`, encode it as a data URL and `drawImage` the `createImageBitmap` of that. Its failure modes are known and are exactly the parts of this renderer that matter: the cascade has to be re-created by hand or the picture comes out unstyled, cross-origin media taints the surface, the webfont has to be embedded, and on the machine this tool is for (Electron with hardware acceleration disabled) a rasteriser pays a full tree rasterisation per capture — the frontend cost the stand-in pathway exists to remove. The prototype was written against documented behaviour and **could not be verified here** (no browser can be obtained in this environment for a pixel A/B), so it is not shipped; it is recorded in `plan.md` as speculative, to be tried only against a real page. What *is* shipped is the honest form of the same sentence: the picture is read from the element the user is looking at, it is taken only once that element is finished (layout, media, fonts — above), and the node's **state** is never frozen into it, because in this renderer a node that is running, has errors or is being dragged keeps its own element and the frontend draws its own progress bar, error stroke and executing outline (v2.6.9). The readout says all of it where the numbers are: the waits, the re-marks, the stale elements, and the DOM writes and layout reads the pathway costs.

- **Tests: 232** (four new), and the harness gained what those tests needed: `fireMutation(target, added, removed)` carries the `addedNodes`/`removedNodes` a `MutationRecord` really has (and the shim's `appendChild`/`insertBefore`/`removeChild`/`textContent` now pass the node through, so a fixture's own DOM building is distinguishable from the page reporting a change), `document.fonts` exists on the shim with a `status` a test can flip, and `withQuiet` is exported. The four: *an element the frontend replaces is marked again before it is painted, and the mark never lands on another node* (the re-mark happens in the same turn as the replacement, is counted, and is found again when the report does not name the added node); *an element the frontend replaces is handed back before the new one is marked*; *an element the frontend gives to another node keeps that node's mark* (the stale cached element is noticed, and its mark is left for the node it now names); *a node is photographed when it is finished, not while it is still arriving* (an `<img>` that has not arrived holds the picture and is named in the readout; a canvas in the same node does not; the ceiling still photographs it once the image has arrived; a page whose fonts are loading holds a node with content, and the picture made in the fallback font is dropped and re-made when they load). **Mutation battery: eight anchored edits, seven caught** — the completeness gate bypassed, the font token removed from the signature, the id check dropped, the orphan memory ignored, the hand-back removed, the claims-other guard removed, the sweep disabled, and the mark written every frame. The eighth — answering a report in the order it arrived instead of additions-first — *survives*, because the harness delivers one record per DOM operation while a browser batches the records of one task into one callback; the change is kept as the semantically right answer to "what is true now" and is recorded here as unobservable in this harness rather than claimed as bound.

## What changed in v2.6.9

- **Two things the eleventh report left open, both answered from the page rather than from this file: where "16 hidden element(s) of 75 boxed node(s)" comes from, and whether a box may honestly draw the node's execution state in the renderer where the node *is* a DOM element.**
- **The hidden count is a count of elements, and it is the page's own count.** `LOD.domHidden` counts the owner records whose mark is on — one element each, dressed through `viewDress`: the class `.ants-lod-box` on the DOM a node's widgets are built from (an image or video preview, a curve editor, a 3D viewport, a pack's own UI), the attribute `data-ants-dom-hidden` on a Vue node's root, whose class Vue rewrites wholesale on every re-render. A walk of the document for those two marks finds exactly the number the panel reports, and a test now holds the readout to the walk rather than to the counter: "N element(s) hidden" is a claim about the user's page, so it has to be checkable on the user's page. (In the Vue renderer the number is the attribute's, counted as `vueBlanked`; the canvas renderer's number is the widgets and previews its boxes stand in for.)
- **A stand-in never has to say anything about a run, and that is now verified in both renderers rather than assumed.** In the Vue renderer a node that is running, has errors or is being dragged **keeps its own element**: `lodVueFlatNode` refuses exactly the nodes `lodSnapLive` refuses, so the frontend draws its own progress bar, its own error stroke and its own executing outline, and no box is ever painted in place of that state. In the canvas renderer, where a box does stand for a running or erroring node, the two marks come from the node's own fields — `node.progress`, which the frontend's own bridge puts on the node object for every node in both renderers (`nodeProgressCanvasSync.ts`), and `node.has_errors` (`useNodeErrorFlagSync.ts`) — read per frame, never out of a picture: `lodSnapLive` refuses to *photograph* and to *blit* those nodes, so a bar frozen at the instant of a capture cannot outlive the run it belonged to.
- **One guarded function draws the two marks.** `lodSnapStateMarks` draws the progress bar and the error stroke, each guarded: a context that refuses one call (a hostile draw hook, a detaching surface) leaves the box painted instead of aborting the node's whole draw — before this an exception there fell through to the Vue pathway's "hand the element back" recovery, so one refused `fillRect` cost the node its stand-in for that frame.
- **The selection ring on a picture is drawn at the box the node was pictured in.** A node the frontend renders taller than its graph `size` (an image preview reserve, a pack's own content) is pictured at the element's measured body; the ring was outlined at the graph size, so selecting such a node drew the ring *inside* the node, and it changed size at the moment the picture replaced the live box. It now asks `lodVueBoxSize` — the same number the box painter and the capture use — so the ring is continuous across the swap.
- **Tests: 228.** The three new claims are asserted inside existing tests: the ring on a picture is more than 300 units tall on a node rendered 420 units taller than its graph size and is *not* the graph size (mutation-checked), the hidden count equals what a walk of the page finds, and the state marks belong to the canvas renderer (the Vue suite already holds that a running, erroring or video node keeps its own element). The mutation battery was extended by the ring's size: **eighteen anchored edits, all eighteen caught.**

## What changed in v2.6.8

- **The eleventh report asked the last question that was still open: does the frontend have its own zoom-based level of detail, so that a stand-in is a picture of a *simplified* node rather than of the node?** Checked against the frontend's own sources (`ComfyUI_frontend`, `main`) and answered: **no.** `LGraphNode.vue`'s root element binds only its size, its position, a z-index and an opacity; `TransformPane.vue` carries one transform for the whole graph; LiteGraph's `drawNode` early-returns in this renderer; the zoom is compositor work, so no element is re-laid out, no computed style changes with scale and no text is simplified at any zoom. Nothing about a node's text metrics, colours or layout is a function of zoom in this renderer — so the stand-in looking simpler than the node was never a level of detail, it was the picture losing colour, text, opacity and the rows a node is actually made of. The tool now says so from the page itself rather than from this document: `lodVueLodProbe` (element count under the node's element, the computed font size, `content-visibility`, the transform scale the measurement was divided by) is reported in the readout's picture clause, so the claim can be re-checked on the user's own machine, at their own zoom, in their own report.
- **"node colours become different" — the canvas cannot parse what Tailwind 4 computes.** The themed surfaces in this frontend are `oklch()`/`oklab()` strings (`--node-component-header-surface: var(--color-smoke-200)`, `--component-node-background: var(--color-charcoal-600)`), and assigning one to `fillStyle` is **silently ignored**: the previous fillStyle stays, so one node's surface came out in the *previous node's* colour, and a run of nodes read as one wrong palette. Every colour a stand-in draws is now translated to `rgba()` by a parser written for the syntaxes this page actually produces (hex 3/4/6/8, `rgb()`/`rgba()` with slashes or commas, `hsl()`, `hwb()`, `oklab()`, `oklch()`, `srgb`/`srgb-linear`), cached per string (`LOD_VUE_COLOR_CACHE` 512), with what it cannot read counted and sampled (`vueColorMiss`, `vueColorSample` in the readout) instead of silently left to the engine. Sites it does not read on purpose are named: `lab()`/`lch()`/`color(display-p3 …)` are counted as misses — a sample in the readout says which syntax was given up on.
- **Text was one unwrapped line in Arial, cut at the right edge.** A paragraph is one element with many laid-out lines, and the reader flattened it into a single string and drew that once, clipped to the box: a prompt came back as one row of text in the middle of an empty block, ending mid-word. Text is now wrapped into the element's own box (`lodSnapWrapText` keeps the newlines the browser kept and breaks a word wider than the box anywhere it must), drawn line by line, in the element's own font — family, weight, style, line height, letter spacing, `-webkit-line-clamp` — read from the page, with the rest of the text marked with an ellipsis the way the browser marks it. Measured on the fidelity rig (two recreated nodes, one of them muted): text lines 98 → 100, fonts `["11px Arial","12px Arial"]` → `["400 11px Inter, sans-serif","400 12px Arial"]`, and the prompt block went from one clipped line to the two lines its box has room for.
- **A muted node was drawn at full strength.** `LGraphNode.vue` gives the root `opacity: nodeOpacity` (the muted/dragged state of the node), and `opacity: 0`-style compositing is not something a canvas inherits from the element it is standing in for: a muted node was photographed as a normal one, and in the renderer where the element's own paint is skipped the picture *is* the dimming. The composited opacity is read with the same measurement as everything else (`lodVueOpacity`), carried in the record, drawn into the picture and the live box through the painter's own `alphaOverride` (combined with the box's alpha by `min`, never multiplied — and never by wrapping the painter in a preset `globalAlpha`, which the painter overwrites from its own state), and mixed into the picture's signature so a node that is muted later is re-photographed rather than kept. Fidelity rig: alphas `[1]` → `[0.5, 1]`.
- **The frontend's own widget rows were never read — only the DOM-widget route existed.** A row drawn by `WidgetGrid.vue` (`data-testid="node-widgets"`, one child per widget, the control inside a `lg-node-widget` element) has no `widget.element`, which is the only thing the old route looked for, so a real node's body was read as an empty flat panel with a title. Both routes are read now, in the same measurement pass: the grid's rows (through `children`, not a child-combinator selector — see the harness note below) and the `.lg-node-widget` elements, each with the surface, border and radius the browser computed for it. That is the mechanism behind "the node body is a flat panel".
- **Form and ARIA controls are drawn as the controls they are.** In this renderer a widget's value is not text: a number field is an `<input>`, a combo is a `<select>`, and the frontend's own reka sliders/switches are divs carrying `role="slider"`/`aria-checked` with the track and the thumb as child boxes. All of those are read (`lodVueFormItem`, `lodVueAriaItem`) and drawn by the text pass: a slider as a track with the knob where `aria-valuenow` says it is (in the colours measured off its own children), a checked box as a tick, a colour input as a swatch of the colour it holds, a field's value with the element's own alignment. Counted as `vueControlInk`. A swatch carries its colour under its own field, because the element's computed `color` is its *text* colour and the style pass fills that field on every item — which is how a swatch came out in the page's default text colour until a test caught it.
- **One element is drawn once, and a textarea is a block.** Two readers now know about form controls, and the DOM-widget route was drawing a measured text widget's value a second time — the same value twice, a unit apart, once in the page's styles and once as Arial on a `#222` bar the page never drew (the suite caught exactly that: *the widget's value is in the picture exactly once*). A measured element is read by the node's own text pass now; images and canvases still come from the DOM-widget route, since no text pass can draw those. And a textarea lays its text out from its own top — a 40-unit field drew its prompt in the middle of itself, because one line was centred in the box like a one-line field.
- **Tests: 228.** Six added and two rewritten. The added ones: *the readout describes pictures in this renderer when snapshots are on* (the copied report says pictures are made, and with the setting off says exactly the opposite instead of claiming both at once — the v2.6.7 sentence is only true while the setting is off), *a long label is wrapped into its own box, in the page's own font* (two lines from a 40-unit box, the second marked, `Inter` at 12px, the colour the browser computed, the first line at the element's own leading), *a colour the canvas cannot parse is translated, not dropped* (an `oklch` grey, an `oklch` with real chroma and hue, an `oklab`, and a `lab()` deliberately left unread; no raw unparsable string ever reaches a context; the miss is counted and sampled), *a node the frontend dims is pictured dimmed* (exactly one picture at alpha 0.5, and a fully opaque remake once the node is not dimmed), *a Vue-rendered widget's value is in the picture, in the control it lives in* (the row's label, the field's value, the row's and the field's own surfaces, a slider's track in the measured colour with its knob three quarters along, a tick and a swatch), and *every selector the reader asks the page for is one the page can actually answer*. The mutation battery is **seventeen anchored edits and all seventeen are caught** — the parser not parsing, an oklch losing its chroma and hue, a paragraph unwrapped, Arial restored, the page's line height ignored, the opacity unread and dropped, form values and ARIA sliders unread, a textarea centred, the grid's rows not enumerated, the duplicate drawing back, the swatch drawn in the text colour, no tick, the reader capped at four elements, a knob that ignores the value, and the harness's selector guard switched off.
- **The harness can now say when it is not looking.** The mutation battery needs to point the same suite at a copy of the tracker (`ANTS_TRACKER`), and the selector question needs an answer: a selector the shim's grammar cannot express used to come back as an empty list — exactly what a browser returns for a selector that matches nothing — so the reader could ask the page for something no test would ever see. The shim records those (`document._qsaUnsupported`) and a test asserts the list is empty for the selectors the reader uses, after proving the guard itself records a child-combinator selector it cannot express.

## What changed in v2.6.7

- **The tenth report: "still not there yet" — 75 nodes at 42 % zoom, fps 83 but p99 19.6 ms and a 249 ms worst frame, 498 stalls over 5.9 minutes of which 11.3 s is forced layout inside the frontend's own `renderFrame`, stand-ins at 42 % reduced to flat boxes, and a readout that said "(no picture is taken in this renderer)" beside "34386 served, 493 captured".** The report is right on every count, and the four causes are all in this release: the paint path dropped the picture on every change instead of holding it, the settle window could be slid shut forever, one slow capture blocked a node for the session, and the reader was capped at the size of a 12-row node.
- **A change keeps the picture now, and that is the "flat rectangles".** The paint path used to drop the bitmap the moment the signature mismatched — the node fell to the box ladder until a replacement arrived, and with the settle window on top of it, a node whose value changes often enough was *never* anything but a plain box. Measured on the harness: a value rewritten every 400 ms gave `pictured 1, 0, 1, 0 …` for as long as it changed. The complete picture of the moment before now stays on screen while its replacement is photographed (`LOD_SNAP_STALE_KEEP_MS`, 2000 ms), and the same A/B rig (24 nodes, the user's zoom, 30 s of virtual frames, values changing every 2 s per node) puts a plain box on screen in **17 of 1800 frames where v2.6.6 put one in 1020** — an average of **0.45 boxed nodes per frame against 7.14**, with 23.8 nodes blitted from their pictures against 20.4. A node still out of date after 2 s is not written off either: it gets its box back for `LOD_SNAP_CHURN_HOLD_MS` (2000 ms) and keeps being asked, and the readout names it.
- **The settle window is a grace period, not a veto.** v2.6.6 opened it on a change and re-opened it on the next one, so a node whose subtree is rewritten more often than the window (300 ms) could never be photographed — and with the old drop-on-change rule such a node showed a box for as long as it kept changing. `lodVueChanged` now stamps the *first* change of a burst as well as the last, and `LOD_SNAP_SETTLE_MAX_MS` (900 ms) photographs the node anyway. Bound by *a node that never stands still is photographed anyway, and never loses its picture*.
- **A slow capture buys a cooldown, not a life sentence.** One capture slower than `LOD_SNAP_SLOW_MS` (60 ms) used to block that node for the whole session — on a CPU-only machine with two 30-row nodes, that is a plain box forever, which is exactly the shape the report shows. The wait now doubles per slow attempt (10 s → 20 s → 40 s …, capped at `LOD_SNAP_SLOW_MAX_MS` 120 s), the node is always tried again, the readout counts the cooldowns (`cooldown`) and says when the next try is, and a node's reason in the readout is kept current instead of frozen at the first one.
- **The reader read a 12-row node's worth of a 30-row node.** `LOD_VUE_TEXT_MAX` was 16 lines, `LOD_VUE_TEXT_CHARS` 80, `LOD_SNAP_DOM_MAX` 12 elements, `LOD_VUE_CHROME_MAX` 32 boxes and the slot-dot sub-cap 24 — numbers chosen when the fixture was a 12-row node. A real node came out of the capture with its first 16 labels and nothing else: that is the mechanism behind "flat rectangles with values missing". Now 256 lines / 400 chars / 96 widget elements / 96 dots + 128 chrome boxes, and a 30-row node's 60 text leaves and 90 row boxes all reach the picture (measured: `fillText 60 where v2.6.6 drew 16`). A row's value that *fits* is no longer ellipsised either — the row's own line count was being handed to the wrapper as its truncation budget, which turned "a cat" into "a ca…".
- **The chrome and widget pass runs when a picture is made, not on every frame.** Over the same 30 s A/B window this is the rest of the visible DOM work: DOM queries **50562 → 14454**, widget rows drawn **40824 → 4716**. Combined with v2.6.5's per-frame work being zero, the tool's own per-frame DOM cost in this renderer is now nothing, on the steady state *and* on the churn.
- **The readout was saying two opposite things at once.** The Vue-nodes paragraph claimed pictures are never taken in that renderer — true when it was written (v2.6.0/v2.6.1), false since v2.6.3, and plainly contradicted by the serving count on the line below it. With snapshots on it now says what happens ("a picture of the node's box, its text and its widgets, remade when the node changes"); with the setting off it keeps the old sentence. The DOM-hiding count also names the boxed nodes it belongs to (`16 DOM element(s) of N boxed node(s) hidden`), and the "another try in …" note is refreshed when the cooldown doubles instead of promising a try that already happened.
- **What this does not claim.** The tool's own per-frame DOM work is zero (measured), and the remaining forced layout in the report is the *frontend's* own `renderFrame` re-measuring 75 live node subtrees — 11.3 s of 32.1 s. Our stand-ins keep those subtrees in layout by design (`visibility: hidden` skips the paint; `display: none` would remove the layout the frontend's own resize/measure passes read), so that cost is the frontend's and is recorded as the next candidate in `ANALYSIS.md` rather than claimed as fixed. Nothing here is verified against a live Vue-nodes page by this project; the user's page remains the live test.
- **Tests: 222.** Two added — *a tall node's own labels are read past the first sixteen* (30 rows: 60 text leaves read, 60 `fillText` in the picture, the old cap was 16) and *a node that never stands still is photographed anyway, and never loses its picture* (a value rewritten every 200 ms for eight rounds: pictured on every round, never a box, still photographed) — plus four rewritten from "the changed node is dropped" to the behaviour the report asked for: *a node that changes keeps its picture until the new one lands*, *a font of churn keeps the picture, and the box never comes back*, *the flicker counter does not count a change as a switch back to the box*, and *a slow capture buys a cooldown, not a life sentence*. The mutation battery is sixteen anchored edits and **all sixteen are caught** — the new ones bind the new promises (a held picture dropped on every change; the settle ceiling removed; a slow capture retried inside its cooldown; no cooldown at all; the reader back to sixteen lines; the row trimmed instead of the text).

## What changed in v2.6.6

- **The ninth report: the v2.6.5 fixes did not help — performance unchanged, pictures still "semi, not fully there" — and the answer this time is a mechanism, not a measurement.** The two questions the report asked were answered against the frontend's own sources (`LGraphNode.vue`, `NodeHeader.vue`, `NodeSlots.vue`, `useNodePointerInteractions.ts`, `useVueNodeResizeTracking.ts`, `useTransformSettling.ts`): the node's *paint* had never been taken away, and the capture could still run in the middle of the frontend assembling a node.
- **The mark was the wrong property.** v2.6.5 had driven the tool's own per-frame DOM work to zero (0 writes / 0 layout reads / 0 queries at 40, 60 and 150 nodes) and performance still dropped — so what was left could only be the frontend's own painting, which `opacity: 0` does *not* stop: an opacity-0 subtree stays in the render tree and is still painted. A stand-in in this renderer has to make the browser skip the node's paint, and the property an engine honours for that is `visibility`. The stand-in attribute now carries three rules: the element's own box stays transparent **and hit-testable** (selecting and dragging a node are bound on the root and never look at `event.target`), the element's **children** are `visibility: hidden` — the subtree is skipped in the paint phase, while every rect, text metric and observer stays exactly as it was, so the box, the picture and the re-measurement all keep reading the DOM. and the one exception is re-shown: a slot's dot, because `SlotConnectionDot.vue` is the element that carries the pointerdown which starts a link drag, and the canvas renderer keeps linking working through its own canvas hit test — the two pathways have to agree. The trade is stated in the README, the panel and `LIMITS` rather than hidden: a widget, a collapse button, an editable label or a resize handle inside a stand-in no longer receives its own clicks at that zoom (the pointer lands on the node, which is what the picture shows there), and the node's accessibility entry is that of a hidden subtree. The readout counts the nodes whose paint the frontend no longer owes (`vuePaintSkipped`).
- **The picture now carries the node, not just what was inside it.** The stand-in's frame, header bar, body panel and slot dots are DOM elements with a box and a computed colour like everything else, so they are read in the same single measurement (`lodVueChromeBoxes`, from the frontend's own `[data-testid=node-inner-wrapper]`, `node-header-<id>`, `node-body-<id>` and `.slot-dot`) and drawn by the ink function the live box and the capture share (`lodVueChromeInk`) — biggest first, rounded the way the browser rounded it, in the colour the browser computed. A node with no header (a reroute) simply has no header box. The same reader measures **each widget's own row** — the element the frontend mounts for a slider, an input or a combo, with its background, border and radius, in the same pass as its rect — and the same ink draws it under the widget's text, so a stand-in is not a node with a hole where its widgets were. This is the "semi 'not fully there'" the user kept seeing: the picture was the node's text and media with no node around them.
- **A node is photographed only after it has stood still.** The frontend renders a node in pieces — the component mounts, `NodeSlots` syncs slot offsets in a watcher, the layout store hands the size over, `NodeWidgets` renders the widgets, `NodeContent` mounts the node's media and an image appears when it decodes — and the tool's capture lane is (deliberately) its own, not the frontend's, so a capture that ran immediately after a change read the DOM between two of those passes. `LOD_SNAP_SETTLE_MS` (300 ms) is a **settle window**: opened when a node is first drawn as a stand-in, re-opened by every change the page reports or the signature notices, and enforced as a gate in the capture lane (`lodVueSettleLeft` → `lodSnapTake`) that schedules the next slice for the moment the window opens instead of polling. A burst of rendering now costs one picture at the end of it instead of one picture per step; nothing is read or written while a node is quiet (`vueSettleMs` / `vueSettleArms` / `vueSettleHeld` in the readout). Only the Vue pathway waits: in the canvas renderer a node's drawing is synchronous with the frame the capture is taken on.
- **A capture process "of our own", answered honestly: it is what this pathway already is, and it is the only possible one.** Page JavaScript cannot screenshot a DOM element, and the two library-shaped routes — an SVG `foreignObject` re-render or an html2canvas-style re-implementation — would re-rasterise the whole node tree on the CPU per capture, which on a machine with hardware acceleration off is the exact cost this pathway exists to remove (and would still mis-render real stylesheets). What the tool does instead: it reads what the browser laid out (every rect, every text metric), reads what the browser computed (every background colour, border width and radius), blits the pixels that exist, re-paints the strings that exist, counts what it cannot draw — and, from this release, takes the frontend's own paint away while the picture stands in, so the picture and the live node cannot disagree about what the user sees. The investigation also settles the "same tick / staggered redraw" question: the frontend has **no per-node animation tick** (nodes are Vue components; the transform is one property on one pane, `useTransformState.ts`), it paints a node in *mounting* passes rather than in tiers of pixels, and it has its own notion of a settled transform — `useTransformSettling(…, { settleDelay: 256 })`, toggling `will-change-transform` after a gesture — while its shared `ResizeObserver` (`useVueNodeResizeTracking.ts`) notes in its own comments that it "can repeat an unchanged entry". A browser's incremental rasterisation is not observable from page JavaScript and is not what the tool reads: it reads laid-out geometry, so the only real "partial capture" was the timing hole, and the window closes it.
- **Tests: 220.** Five added, all in the Nodes 2.0 suite: *the stand-in takes the live DOM out of the paint and leaves it in the layout* (the stylesheet's rules are read out of the page — the children hidden, the node's own box **not** hidden, the slot dots re-shown — the structure stays in the DOM, and a box that changes inside a stand-in is still reported); *the picture carries the node's own structure, not only its content* (the frame is drawn at the element's own rect in the live box and in the picture, the slot dot is an arc, and the reader reads four structural boxes); *a node is photographed only after it has stood still* (nothing captured inside the window, the lane reports the wait, the picture lands after it); *a change re-opens the settle window before the picture is replaced* (the stale picture is dropped, no replacement inside the window, a fresh one after); *a widget's own row is in the picture, not a hole where the widget was* (the row is drawn at its measured box with the browser's radius in the live box and in the picture, and the lane counts it). A ten-mutation battery was run over the tracker — the gate bypassed, the re-arming removed, the structure not drawn, the stylesheet rule removed, the slot dots not drawn, the first-time window never opened, the structure reader reduced to the frame, the widget row's surface not read, the widget rows not drawn, the slot-dot pointer exception removed — and **all ten are caught**. The harness gained `vue.addStructure()` (the frontend's own node structure, laid out the way the browser lays it out, with the browser's box colours in the shim's computed style), so the reader and the ink are exercised against the shape `LGraphNode.vue` really renders.
- **Two stale claims removed while this was verified.** The panel said that in this renderer "the bitmap half (capture, ratio, budget, disk) stays idle, because no browser API draws a DOM element into a canvas" — untrue since v2.6.3, when the pathway began drawing and storing pictures; it now says what actually happens (they need the flatten threshold, and they are made, stored and keyed like any other picture). And the comment above the readout's picture paragraph, which claimed the Vue renderer has no pictures by design, is gone.

## What changed in v2.6.5

- **The eighth report's two halves were measured before anything was changed: the stand-ins cost the frame in the Nodes 2.0 renderer, and a picture could be taken before the node had finished rendering.** Both were reproduced on the harness with counters, both had a cause, and the fix for each is bound by a test.
- **Why the stand-ins cost frames, part 1: the tool wrote to the page on every frame.** The blanking mark (`data-ants-vue-standin`) was set on every boxed node on every frame — and an `setAttribute` for a value the element already carries is *not* free: Blink and WebKit run the attribute-changed path (observable side effects, style invalidation) even for a data attribute, which is why a client that skipped the no-op write went from 500 layouts to 0. The mark now reads `hasAttribute` first and is written only on the transition (`LOD.vueDomWrites` counts the writes). The other per-frame write was the video verdict: "does this node hold a `<video>`?" was answered by `el.querySelector("video")` per widget per node per frame — 80 DOM queries per frame at 40 nodes, every one of them a subtree walk. It is cached per node (`LOD.snapVideo`, `LOD_VUE_VIDEO_MS` = 100 ms, and 30 s on a page with the observers below, where a video appearing *is* a reported change), and a capture still probes fresh, so a video is never photographed.
- **Why the stand-ins cost frames, part 2: the tool asked the page for its layout on a timer.** The measurement of each node's element was refreshed on a 400 ms beat (800 ms with a picture held) so the tool could notice a change — i.e. a forced style-and-layout read on every boxed node, forever, to answer a question the page already knows the answer to. The tool now **watches**: one `ResizeObserver` over the node's element and the elements inside it, one `MutationObserver` over its children and text (`lodVueWatch` / `lodVueWatchInside`), and the change drops that node's stored measurement (`lodVueStaleNode`) — the next frame re-measures it through the same per-frame ration. Attributes are deliberately not observed: the frontend rewrites `style`/`class` constantly (hover, selection, the pane transform on every gesture) and re-measuring on those would be the timer again with worse manners. A node under observation keeps a 5 s insurance read (`LOD_VUE_MEDIA_MS_WATCHED`) for the change no observer reports, and a page *without* the observers falls back to the old beat with the same ration. Measured in the Vue-nodes renderer, steady state, before → after: at 40 boxed nodes **attribute writes per frame 40 (every one of them a re-write of a mark that had not changed) → 0, DOM queries per frame 82.4 → 0, layout reads per frame 2.4 → 0**; at 60 nodes 60 / 122 / 2 → 0 / 0 / 0; at 150 nodes 150 / 302.1 / 4.5 → 0 / 0 / 0. The tool's remaining per-frame cost is the blits it was asked to make.
- **A picture can no longer be taken of a node that has not finished rendering.** The signature that decides whether a stored picture is still a picture of this node mixed the node's own fields, the media it renders and its text — but not the **height the frontend actually rendered it at** and not the **rows the browser laid its widgets out in**, so a node whose content arrived after the picture (which is every node on a real page) kept the first, half-rendered picture for the rest of the session; and the capture surface was sized from the cached measurement while the ink was read from a fresh one, so content that arrived between the two was painted at an origin the surface did not cover — the "photographed too early" the user saw. The signature now mixes the element's rendered height, the widget rows and the text lines, and a capture takes **one** measurement: `lodVueRootMetrics(node, canvas, true)` → `lodSnapGeometry(node, canvas, dom.boxH)` → the surface, the box and the ink all come from that one number. Widget content is drawn in **the box the browser laid the element out in** (`lodVueWidgetBoxes`, from the elements the frontend mounts inside the node's own element, as `WidgetDOM.vue` does) rather than at the canvas row the widget would have if the canvas renderer were drawing it — a distinction the tests make visible: a field whose element sits at y 52 is painted at 55 in the picture (its own inset), where the canvas row the widget reports would put it at 73.
- **Tests: 215.** Six added, all in the Nodes 2.0 suite: *a picture is re-made when the rest of the node arrives, not kept from the first look* (a one-node fixture; the first picture is a bare box with no `fillText`, then the node's spans arrive — the picture is dropped, re-made, both strings are in the new one, and the frame blits it); *a node the frontend renders taller than its graph size is pictured at that height* (the element grows 420 units, content lands in the part that just arrived, a widget change drops the picture at once — the new surface is taller than 110 + 420 and carries the content); *the steady state costs the page no DOM work at all* (after a warm-up frame, three frames inside the probe window: 0 writes, 0 re-writes, 0 layout reads, 0 DOM queries, 0 computed styles, 0 probes, 0 captures, and every frame served from the pictures); *the page is asked for nothing while nothing changes, and reports it when something does* (fourteen frames over three seconds with three pictured nodes: not one layout read, DOM query or computed style, and not one re-measure — then a line appended to a node's element is reported by the page, drops that node's measurement, and the next frame re-makes the picture); *a widget the frontend mounts inside the node is drawn where the browser put it* (the element's laid-out box, not the widget's canvas row, in the picture and in its signature); *a node element the frontend replaces is watched like the one it replaced* (the new element is blanked on the next frame, a line appended to it is reported by the page at once, and the picture made from the element that is gone is dropped). A mutation battery of ten anchored edits was run over the tracker: **nine are caught** — reports ignored → the observer test; a reported change not dropping the measurement → four tests; the measured widget boxes unused → the widget test; the measured widget boxes out of the signature → the widget test; the mark written every frame → two tests; the video verdict uncached → two tests; the node's text out of the signature → two tests; the element's height out of the signature → the height test; the replaced element not watched again → the replacement test. The tenth — the capture asking for the geometry without passing the height it just measured — is *semantically equivalent* today and is recorded as such rather than claimed as bound: the fresh measurement is in the cache before the geometry asks for it, so both spellings read the same number. (The same is true of mutating only one of the two call sites that keep the watch on the element the frontend presents: in every scenario the tests build, the other one runs.) The harness gained the two observers (opt-in to the tests, on by default, with `withQuiet` around the pane's own layout so a pan or a zoom is not mistaken for a box change, and `growRoot` reporting a real box change), an `attrWriteBy` histogram, and the element/rect plumbing the tests need; the mutation-checked count is in `ANALYSIS.md`.

## What changed in v2.6.4

- **The pictures were boxes and the canvas flickered — the seventh report, and both halves were reproduced before anything was changed.** In the Nodes 2.0 renderer the images appeared but read as "captured box previews"; in the canvas workspace there were "cached boxes only, no proper stand-ins" while the tracker reported them in use; and switching the stand-in mode to anything other than *picture of the node* made every node flicker between a box and the full preview across the whole canvas.
- **A picture now carries the node's text.** A box, a title bar and (at best) an image is what a person calls a box. In this renderer the node's text *is* DOM text and cannot be photographed — but every string, the box the browser laid it out in and the styles it computed for it are readable while the node is blanked (`opacity: 0` keeps the layout). `lodVueTextLines` reads them in the same single measurement the media pass already made (at most `LOD_VUE_TEXT_MAX` = 16 lines of `LOD_VUE_TEXT_CHARS` = 80 characters), and `lodVueTextInk` re-paints each one clipped to its own box, in the theme's colour and the browser's font size. The node's **title** is one of those lines — it lives in the element's title bar, above the body — so the content clip in `lodPaintNode` now covers the body *and* the title bar: a clip on the body alone cut the node's own name off its picture. The live box and the capture call one function (`lodVueContentInk`), so the picture can never drift from the box it replaces.
- **The zoom a measurement is divided by is measured from the right element now.** v2.6.3's rule was "the element's own width over the node's width in graph units" — but the node's *root* has no explicit width at all (`g_LGraphNode.vue` gives only `min-width`; the declared width is on `[data-testid=node-inner-wrapper]`), so its own width is whatever its content needs. Where that differs from the declared width, every number derived from the measurement (the box height, the media rows, the text) lands away from where it belongs, which is how a picture comes out looking like the box it should have replaced. `lodVueDomScale` asks in the order most likely to be right: the frontend's own transform pane (one computed matrix for the whole graph, `scale3d(z,z,z)` — m11 *is* the zoom), then the element that carries the node's declared width, then the node's root, and only then `canvas.ds.scale` (which a capture rewrites to 1 while the DOM keeps the frontend's transform). The readout says which one answered (`vueScale`, `vueScaleFrom`).
- **A capture with no element was a bare box, stored as the node's picture.** The picture *is* the element; with it off the page — the frontend mounts only what it renders, and a re-render replaces elements — the capture could only draw the box, and a box stored under the node's key is served to every later frame as if it were the node. `lodSnapCaptureNode` refuses and counts (`vueNoElement`); the node keeps its live box until an element exists.
- **The disk key could not tell the two renderers apart.** The key was `<signature>r<ratio>t<theme>`; the RAM cache compares the signature, but a *file* written from a drawn Vue picture could satisfy a canvas-renderer request — which is exactly how a canvas workspace ends up showing "cached boxes only": the box picture the Vue renderer had written was served there. The pathway is now in both (the signature mixes it, the file name ends `<pc|pv>`), so a picture is never served across renderers in either direction, and a file written before the token is re-made rather than trusted.
- **The flicker was two answers to one question.** The frame plan wanted a *picture* (`LOD.snapOn`), the draw loop only needed the zoom (`lodFlatOn`). With any other stand-in mode the plan decided, every frame, that nothing stood in — handing every blanked element back at the top of the frame — while the draw loop blanked them again to paint the box, so any frame the frontend rendered in between showed the node in full. One predicate (`lodVuePathOn`) is asked by both now, and it deliberately does not mention the picture setting: a box *is* a stand-in. The plan is idempotent, so in the steady state it does nothing and the elements are handed back only when the pathway genuinely stops (the tool or the flatten zoom goes, the renderer changes, the node stops being flat). The reproduction, for the record, read `cleared="setting"` and `vueRestored` +3 on *every* frame; the fixed build reads `cleared=""`, `vueRestored` unchanged, the elements blanked and each box drawn once per node per frame.
- **Tests: 209.** Five added: the node's own text (title and widget label) is painted in the live box and in the stored picture, at the node-local position the browser gave it, with the clip reaching into the title bar; a node whose element is off the page gets a box and no picture, both when the element never appeared and when it left between the blank and the idle lane; a stand-in mode that is not a picture leaves the stand-ins standing (no hand-back, no clear, no growth, the same boxes every frame) and switching back to pictures captures again; the zoom a picture is measured in follows the frontend's transform pane and the same node-local geometry comes out at 10 % and at 40 % zoom; a picture drawn in one renderer is never served to the other, in either direction. Mutation checks bind every one: the plan requiring the picture setting → the mode test fails; the text route skipped → the text test fails; the zoom back to `canvas.ds.scale` → three tests fail; the pathway token dropped from the key → three fail; the no-element refusal removed → the refusal test fails; the title-bar clip narrowed to the body → the text test fails; the text keeping the title-bar offset → the text test fails.

## What changed in v2.6.3

- **The Nodes 2.0 pathway was doing nothing on a live page, and the report said exactly that: boxes, no pictures, and no files in the thumbnails folder even after emptying it.** Two independent causes, both now fixed and both pinned by tests. **(1) The blanking was a CSS class.** `LGraphNode.vue` binds `:class` on the element a node is rendered into — `cn('group/node lg-node absolute isolate touch-none text-xs', …)` — and Vue rewrites `class` (and `style`) wholesale whenever it re-renders the node. A tool-added class is therefore dropped a frame or two later, so the node came back fully visible *behind* the box this tool was painting, and the "text stand-ins" the user suspected were the frontend's own text showing through. The mark is now the attribute `data-ants-vue-standin` with an `!important` `opacity: 0` rule; the harness could never have caught this, because nothing in it rewrote `className`. The fovea's hide mark and the inert mark on a node's own element were moved to attributes for the same reason (`data-ants-dom-hidden`, `data-ants-dom-inert`); widget wrappers, which Vue does not own, keep their classes. **(2) The picture half was switched off.** `lodSnapBitmaps()` returned `lodSnapOn(canvas) && !lodVueNodesMode()`, so in that renderer nothing was captured, no mip was made and no disk file was ever written — the "0 B of 4096 MiB" and the empty folder. Bitmaps are allowed in both renderers now, and `lodSnapRender` paints a Vue capture with `lodVueCapturePaint` (box + title/state marks + the widget text the frontend mounts as DOM + the node's own `<img>`/`<canvas>` rows) instead of calling LiteGraph's `drawNode`. Everything downstream is identical: ratio ladder, mips, RAM budget, the `…r<ratio>t<theme>` disk key.
- **A picture is not carried across a renderer change.** The pathway is named per frame and the pump releases what the other renderer made before building again, because the box, the padding and the content route all differ.
- **The box now covers the box the frontend actually rendered.** `LGraphNode.vue` renders an image node `IMAGE_PREVIEW_HEIGHT_RESERVE` (220 + 8 + 4 px, `imagePreviewLayout.ts`) taller than its graph size when it shows a picture and has an expanding widget, and subtracts that growth from the layout height on resize — so the DOM really is taller than `node.size`, and the picture lives in the overhang. A stand-in built from `node.size` blanked the node and then clipped off the picture being looked for; the element's own rect is the measurement now.
- **The zoom used to convert that measurement is measured, not assumed.** A capture sets `canvas.ds.scale = 1` so the picture is zoom-free, while the DOM keeps the frontend's transform; dividing the element's client-pixel rect by that 1 produced numbers scaled by the current zoom — an image measured at 10 % zoom was drawn a tenth of its size, off the top edge of its own box (and so, in practice, not in the picture at all). The zoom now comes from the element's own width over the node's width in graph units.
- **One layout read per node, rationed per frame.** Every stored number is node-local, so the cache key is the node's own size — not the pan or the zoom, which cancel out of `(childRect − rootRect) / zoom`. Panning and zooming therefore cost no layout read at all (and cannot turn into a forced layout per boxed node per frame while the user drags the canvas), while the 400 ms backstop refresh is rationed to a few node layouts per frame. An unreachable node is counted (`vueUnreached`) instead of silently box-less.
- **An element the frontend unmounts has its mark taken off.** The whole pane is `v-if`, so switching renderer detaches every node element; the element the tool last dressed is remembered for that case, so an element Vue reuses later cannot come back invisible.
- **Tests: 204, and the harness made honest.** New: the blanking survives a Vue re-render (class and style rewritten wholesale) and the tool finds the node's new element when it is replaced; a Vue capture exists, contains the node's own image at the layout's row and size, and is written to disk (three PUTs, keyed by ratio and theme); a pathway change releases the held pictures and re-makes them; the box covers a node rendered taller than its graph size; the media layout is re-read on a budget and never once per node per frame; a pan and a zoom cost no layout read. The DOM shim now reports `isConnected` truthfully and the harness's node element carries the title bar's height, both of which the bug depended on. Mutation checks bind all seven: blanking back to a class → 5 failures; the pathway adopted as a change (which cleared the queue on the first pump) → 33; bitmaps allowed only in the canvas renderer → 3; no media pass in a Vue capture → 1; hand-back skipping an unmounted element → 1; the durable element map unwritten → 1; no DOM box size → 1; zoom assumed from the canvas → 2; no frame ration → 1.

## What changed in v2.6.2

- **Image nodes in the Nodes 2.0 renderer have pictures in their boxes now — the report was exact, and the cause is in the frontend's own sources.** A node's content reaches the page by two routes, and the Vue pathway only knew one of them. **Widget-borne** content (a prompt's `<textarea>`, anything added with `addDOMWidget`) is mounted into the node's DOM by `WidgetDOM.vue` and was always found through `widget.element` — which is why text nodes worked first. **The frontend's image preview** is a *canvas-drawn* widget (`ImagePreviewWidget.drawWidget`, registered `surfaces: { canvas: 'shown', vueNode: 'never', panel: 'never' }`): in the canvas renderer it puts the images on the canvas and the capture takes them, but in the Vue-nodes renderer the frontend mounts it nowhere and `drawNode` draws no widget either, so nothing had it. What the frontend *does* render there is `ImagePreview.vue`: the node's images as `<img>` elements inside the node's own DOM. The box now walks the node's element for `img`/`canvas` and draws them at the position the browser laid them out in.
- **The geometry is read from the layout, not guessed.** `opacity: 0` (the blanking) keeps every box intact, so `getBoundingClientRect` is answerable while a node is a stand-in; the node's element and its children sit in the frontend's one transformed pane, so the difference between their client rects divided by the zoom is a distance in graph units. The read happens on a change — zoom, position, size, the elements and their sources — with a 400 ms backstop, so the steady state costs one key comparison per drawn box and no layout read at all (a test counts layout reads and holds the cache to that). Content is clipped to the node's box, and an element the widget route already drew is never drawn twice.
- **What this does and does not fix.** Images the frontend renders (loaders, mask previews, galleries, anything a Vue node draws itself) now appear in the boxes, as do `<canvas>` elements a custom node renders. A pack that draws its preview with a *canvas* widget and renders no DOM — unlike the frontend's own preview — still has nothing on the page for the box to carry; `ANALYSIS.md` records that as the honest remaining gap rather than inventing ink.
- Four tests added (201 total): the node's own image drawn at its laid-out position; a canvas drawn and an unloaded image left out; the layout read on a change and not per frame; and an element both routes can see drawn exactly once. Mutation checks bind them (media pass disabled → 4 failures; dedupe removed → 1 failure).

## What changed in v2.6.1

- **A box in the Vue-nodes renderer now carries the node, not just its colour.** The stand-in setting is *picture of the node*, and in that renderer a photograph is impossible — no browser API draws a DOM element into a canvas (not `drawImage`, not `createImageBitmap`, not `captureStream`), and the canvas renderer's capture works only because LiteGraph itself draws the node through the same `drawNode` seam this tool wraps. What *is* drawable is the node's content, and that is what a person recognises a node by: an image preview is an `<img>`, a mask editor or a 3D viewport is a `<canvas>`, a prompt is text. So the box is now drawn at the picture level (title bar, error ring, progress, dimming) with the node's own images and canvases composited into it pixel for pixel and its text fields re-painted in the theme's colours — the same composite the canvas renderer's *capture* makes, at the same rows, aimed at the frame instead of an offscreen bitmap. A pack's own HTML stays blank and counted; a video node is still never blanked at all.
- **No capture, no signature, no idle lane: the boxes are drawn live.** *(v2.6.3: pictures are made in this renderer too — see v2.6.3)* A dropped-in image or a typed word is in the box on the next drawn frame by itself, which is one thing this pathway does better than the canvas renderer's pictures.
- **Why not a vendored DOM-to-canvas library**: an SVG `<foreignObject>` serialisation cannot fetch external resources, so the node's previews — the whole point — come back blank unless every image is fetched and inlined as a data URL; a library would also cost the project's zero-dependency property and still mis-render theme variables, shadows and cross-origin images. Recorded in `ANALYSIS.md` so the decision is not re-litigated from scratch.
- **The readout and the API follow**: the Status tab says what the boxes are made of and how many content items were drawn on the last frame; `lowZoom.snapshots.vueContent` is that gauge; the box-detail paragraph is not printed when the picture level is what is standing in, because the paragraph describes the other ladder.
- Four tests added (197 total): an image at the widget's row with the picture-level title bar; a text value that follows an edit on the next frame; a wrapper with two images in it left blank and uncounted; and the setting off meaning the box ladder with no content. Mutation checks bind them.

## What changed in v2.6.0

- **The stand-in setting now acts in the Nodes 2.0 (Vue-nodes) renderer, through a second pathway.** There, a node *is* a DOM element and the canvas draws no node chrome, so the canvas renderer's picture has nothing to replace and cannot even be taken (a DOM node cannot be drawn into a bitmap). The tool now chooses between two mechanisms from the frontend's own flag on every call: **canvas** — a picture of the node, blitted where the canvas would have drawn it; **Vue-nodes** — the node's own element is *blanked* (one class, `opacity: 0`, so it keeps its place, its layout, its children and its pointer events) and the canvas paints the same box in the same place, with the same detail ladder. LiteGraph still calls `drawNode` for every visible node in that renderer — it is how slot metrics stay in sync — so the box lands exactly where a picture lands in the canvas renderer.
- **What that saves, and what it deliberately does not do.** The frontend already composites every node in one transformed container (`useTransformState.ts`: "O(1) transform updates regardless of node count"), so the renderer's frame cost is node *pixels*, not transform work — which is what blanking removes. Interaction is untouched: the element is still there, so clicking, dragging, selecting and link-dragging work exactly as in full detail. `display: none` (collapsed box) and `content-visibility: hidden` (takes the node's slots out of hit-testing) were both rejected for that reason.
- **Safety rails, because a blanked node is invisible if anything goes wrong.** A box is painted only for an element this tool has really blanked — a node whose `[data-node-id]` element cannot be found keeps its own drawing, because two pictures of the same node is worse than no stand-in. Every blanked element is handed back when the zoom leaves the threshold, when the setting or the tool is switched off, when the renderer changes, and on an error path; the per-frame plan compares one boolean in the steady state, so nothing walks the graph per frame and a stale class cannot survive a frame. The readout and the API name the pathway (`lowZoom.snapshots.pathway`, `bitmaps`, `vueBlanked`, `vueBoxes`, `vueRestored`, `vueCleared`).
- **The capture, resolution, budget and disk settings report themselves idle there**, with the reason ("a DOM node cannot be photographed"), instead of appearing broken. *(Corrected in v2.6.3: that was wrong on both counts — the blanking was a class on an element Vue rewrites, so the pathway never took effect on a live page, and a DOM element cannot be photographed but a picture of the node can still be **drawn** into the capture surface. Both are fixed; see v2.6.3.)* The keep-live list, the box ladder, link thinning, the idle redraw cap and the widget/focus settings all keep working in both renderers. The `picture of the node` stand-in choice falls back to the *state* box in this renderer, and says so.
- **Four tests added, three rewritten** (193 total). The rewritten ones are the v2.5.5 tests that pinned "the engine reports itself off in this renderer" — true then, deliberately different now. New: the box + blanking in one frame; the hand-back above the threshold; a running, erroring or video node keeping its own element; an unreachable element getting no box; the setting and the master switch handing every element back.
- **A gap in the test harness closed**: the DOM shim had no `querySelector` and no tag selectors, so the nested `<video>` and wrapper-`<img>` paths the docs describe could not be exercised. Both now work in the shim, and the new tests use them.

## What changed in v2.5.6

- **A stand-in picture now contains the node's DOM content.** In both frontends a widget's content lives in an element over the canvas — a prompt is a `<textarea>`, an image preview an `<img>`, a 3D viewport a `<canvas>` — and the canvas row underneath is blank (ComfyUI paints a placeholder there only in its own low-quality mode). Pictures of text and image nodes therefore showed the node's chrome and nothing else, which is what a user reported: the stand-in is there, but no image and no text in it. The capture now composites what can honestly be drawn: images and canvases pixel for pixel, a text field's value re-painted in the theme's widget colours (page JavaScript cannot screenshot rendered text, and the readout says so), and a pack's own HTML left blank and counted. A node showing a video is never photographed at all.
- **A picture is re-made when its DOM content changes.** The signature now covers what the elements are showing — an image's source, `complete` flag and size, a canvas's size, a text field's value — so dropping in a new image, typing in a prompt or a mask editor redrawing invalidates the picture and the idle lane photographs the node again.
- **Capture ratios below 1× were not being honoured.** `lodSnapRender` clamped the ratio to a minimum of 1, so 0.25× and 0.5× were drawn at 1× (four to sixteen times the memory the budget had been told to reserve for them) while the picture's name said otherwise. Both the render and the ink probe now use the ratio they were given.
- **The disk cache is keyed by what is inside the file.** A file's name now carries the node's signature *plus the capture resolution it was drawn at and a hash of the theme* — the two things a file outlives that the in-RAM signature deliberately leaves out. Before this, a page starting at 0.25× loaded yesterday's 1× files under the same name (sixteen times the memory, and no re-capture because a record existed), a page starting at 2× was served 0.25× pictures and never asked for better ones, and a picture drawn in a light theme was served in a dark one. Changing the resolution now re-keys and re-captures in both directions, which is what the setting promises.
- **The disk counters and the "already asked" bookkeeping follow.** A picture the budget forced coarser than your setting is not written at all (it is not what the setting asked for), a bitmap evicted for budget can be loaded from its file again instead of being re-photographed, and the readout names the ratio and the theme as part of the key.
- Ten tests added, five of them playing the thumb store's own part (a fake disk with one file per node id, replaced on write and served only for the exact key) so the frontend's half of the contract is pinned: what it asks for, what it writes, and what it refuses to be served. 189 tests green.

## What changed in v2.5.5

- **Nodes 2.0 (the Vue-nodes frontend) is verified against the frontend's own sources, and the settings that could never act there no longer pretend to.** In that renderer `LGraphCanvas.drawNode()` returns immediately: the canvas draws links, groups and the grid, and every node is a DOM element (`[data-node-id]`, positioned by `transform`). The stand-in engine now reads the same flag the frontend sets from **Nodes 2.0** (`LiteGraph.vueNodesMode`, written by `useVueFeatureFlags.ts`), and reports itself off instead of walking the graph and photographing nodes that are never drawn.
- **The idle lane no longer fills with blank captures.** Finishing a run walks the graph and asks for pictures; in Vue-nodes mode each of those captures would have produced an empty bitmap and been written off as "draws nothing into the canvas" and blocked for the session. The enqueue path checks the same condition as everything else, so nothing is captured, held, queued or written to disk.
- **The DOM half only runs where it has something to do.** The once-a-second sweep, the per-frame focus pass and the registry are skipped when the only thing switched on is node flattening (which that renderer makes a no-op); the focus half — *widgets stop answering*, the off-screen/fovea culling, the margins and the come-back budget — still works, because it acts on DOM elements and the pointer, and the node's own root element is still never hidden.
- **A page that switches renderer mid-session hands its pictures back.** With a warm cache (or a queue with work in it) and Nodes 2.0 then switched on in ComfyUI's settings, nothing could ever paint those bitmaps again, and they stayed in memory for as long as the page lived. The slice that drains the lane now releases the whole cache on that transition, exactly as the setting being switched off does, and counts it as a clear.
- **The readout names the renderer instead of blaming a setting.** The Status tab's first line now says nodes are DOM elements in this mode and which settings that leaves idle; the flatten line says the same thing in place rather than "snapshots are on but not painting anything", and it no longer offers "collapsed boxes or this tool's own node" as the explanation for a decision this renderer made. The copyable report text says it too.
- **The answer is read per frame, not latched at load.** Switching Nodes 2.0 off in ComfyUI's settings brings flattening and the picture engine back on the same page, without a reload — pinned by a test.
- Seven tests added for this renderer, built on a fixture that reproduces the frontend's own shapes (the `data-node-id` roots, the `[data-testid="dom-widgets"]` layer with client-pixel `left`/`top`, the `hideOnZoom` default, and `drawNode`'s early return). 179 tests green.

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
