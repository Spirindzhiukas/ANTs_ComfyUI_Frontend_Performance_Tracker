# What works, what fails, and what was taken out

An audit of the repository as of v2.6.7, done by reading the sources rather
than the docs, running the suites, and running the demo. Every claim below
has a file and (where it matters) a line reference. Found defects were fixed
in the same pass; retired ideas were removed rather than documented as if
they still existed.

## How this was checked

```bash
node tests/run-tests.mjs        # 222 passing (172 before the stand-in passes; fifty added)
node tests/run-tests.mjs "Nodes 2.0"        # the thirty-seven that cover that renderer
node tests/run-tests.mjs "cache on disk"    # the six that cover the picture store
node tests/run-tests.mjs "stand-in picture" # the five that cover what a picture holds
python3 tests/test_init.py      # Ran 9 tests ... OK
node tests/demo.mjs             # exit 0, prints every tab
cp web/tracker.js /tmp/x.mjs && node --check /tmp/x.mjs   # ES-module syntax
grep -n "^function " web/tracker.js | sed 's/.*function //;s/(.*//' | sort | uniq -d   # no duplicates
```

Ground truth was, in order: `web/tracker.js` (~12k lines, the whole
frontend), `__init__.py` (the node and the nine routes), `web/window.html`
(the separate page), the test suite, and `node tests/demo.mjs` output. The
README was treated as a suspect, not a spec — it described v2.1.

## What works

### Backend (`__init__.py`)

- The node is a no-op: `CATEGORY = "ANTs"`, no inputs, no outputs, no
  execution; it exists only to carry the canvas pill (`__init__.py:522-539`).
  Graphs saved under the old class key still load — the alias and both
  mappings are asserted in `tests/test_init.py:34-37`.
- Nine routes are registered best-effort (`__init__.py:456-504`), so a
  ComfyUI version that already has one of them does not break the import:
  the GPU probe, five thumbnail routes, the window page and the two halves of
  the `/ants_optimizer/ui` link. The UI link is memory only — a revision, an
  origin, the settings and the last report — and a malformed POST is a 400,
  not an exception.
- The thumbnail store is guarded where it touches disk: a 7-day age sweep,
  an 8 MB per-file cap, a directory under ComfyUI's temp, and a fallback
  that simply serves no pictures when the folder cannot be found. The
  `tests/test_init.py` suite exercises the path handling, the read/write and
  the sweep against a temporary directory.

### Frontend measurement

- `app.registerExtension` is wrapped before any other extension loads
  (`web/tracker.js`, `patchRegisterExtension`), so every later extension's
  `beforeRegisterNodeDef` is instrumented by name. Hooks that would otherwise
  be invisible — pre-existing prototypes and per-instance
  `this.onDrawForeground = …` — are adopted while drawing and attributed.
- Costs are normalised per drawn frame, with hook time outside `canvas.draw()`
  kept in a separate off-frame column; the redraw-request rate comes from a
  wrapped `setDirty()` with callers from sampled stacks; stalls come from
  Long Animation Frames with a `longtask` fallback.
- The scheduler layer wraps the page's own timer/rAF functions, leaves
  `normal` as a strict no-op (same ids, so `clearInterval` still works),
  slows rather than silences, and exempts the tracker's own timers.
- The window/page link is symmetric: the window applies settings only when
  the revision changed and the origin is not `"window"`; the page applies
  only when the origin is `"window"`, runs a command when `commandRev`
  changes and the origin is not `"page"`, and does not publish while a change
  is being applied (`antsUiApplyRemote`, `antsUiApplySettings`,
  `antsUiPublishSettings`).
- The stand-in engine counts every outcome it can name (served, missing,
  refused for budget, too big, blank, too slow, churned, coarser than the
  ratio, kept live) and the reason is printed in the panel, not just kept
  internally.
- All of the above is covered by the suite, including the separate window
  (opened centred, focused on a second open, panel as the popup-blocked
  fallback), the echo rules, the DOM hiding and restoration, and the claim
  that no second copy of an image preview is ever asked for
  (`tests/drawing.test.mjs:342`).

## What was broken, and what was done about it

| # | Defect | Evidence | Fix |
| --- | --- | --- | --- |
| 1 | **The keep-live list had no door.** The snapshot engine has honoured `snapExclude` since v2.4.0 and the readout says "kept live by your list (T)", but there was no control anywhere in the UI: the only way to add a type was the console. | `snapExclude` was reachable only through `lowZoom.set` / the API. | A text field on both surfaces — panel ("Keep these node types live") and window (`id="keep"`) — normalising the list and counting the types it removes as kept-live-on-purpose. Test: *"the keep-live list is a control, not an API-only setting"*. |
| 2 | **Adding a type to the list did nothing until that node changed.** A node whose picture had already been captured kept being served it: `lodSnapEnqueue` skips records that exist and are not blocked. | Reproduced in the new test: `captured` stayed put and the picture was still drawn. | `lodSet` now drops the records of **newly added** types (`lodSnapDrop(node, "kept live by your list (T)")`), so the effect is immediate and only the added type is re-evaluated. |
| 3 | **The demo mislabelled and skipped tabs.** `TABS` omitted `status`, so every heading from `TIMING` on named the wrong tab, and the Tweaks tab was printed as "TWEAKS TAB" after the panel renamed it "Node Rendering Settings". | `tests/demo.mjs` clicked `tabBar.children[i]` by index against a shorter list. | The list is complete, the label is read from the panel's own button, and the badge is not printed as part of the name. |
| 4 | **The demo explained a feature that no longer exists** — a paragraph about the retired image-preview thumbnail ladder (64px at 10 % zoom, 512px around 60 %), printed after every run. | `tests/demo.mjs:719-721` before the fix. | Replaced with what the stand-in actually is: below the zoom you pick, a captured picture is drawn as one `drawImage`, captured once while the page is idle. |
| 5 | **A source comment claimed behaviour the code does not have:** the file header said links are painted straight "while the graph is rectangles". That coupling was removed in v2.2 — `lodLinksStraight()` looks only at `linkStyle`. | `web/tracker.js` header vs `lodLinksStraight`. | The header now says a link's shape is the user's own choice. Two more stale comments ("thumbnail", "the preview ladder needs") were corrected. |
| 6 | **The README described v2.1**: five tabs (there are ten), a folder that no longer exists, one backend route (there are nine), "nothing else is written server-side", 161 tests, a tab name retired two releases ago, and no credits at all. | Compare README body with the code and `CHANGELOG.md`. | Rewritten from the code: install, use, ten tabs, every setting with its real ladder and default, the window link, the routes, the tests, and a Credits section. The version history moved to `CHANGELOG.md` so the README stops being 900 lines of archaeology. |
| 7 | **No licence and no third-party notices.** The project embeds an idea that comes with an MIT notice, and carried no `LICENSE` of its own. | No `LICENSE`, no notices file (plan.md, Track M). | Added `LICENSE` (MIT), `THIRD_PARTY_NOTICES.md` with the upstream MIT notice verbatim, and the README credits saying exactly what was taken and what was not. |
| 8 | **The window and the page could disagree about a setting with nothing to catch it** — a control that posts a key the page ignores is a control that silently does nothing. | No test compared the two key sets. | New test *"the window and the page agree on which settings exist"*: every key the window posts must be published by the page, and every published key must have a field the window paints. |

## Nodes 2.0 (the Vue-nodes frontend), verified against the frontend's own code

The question was whether this tool's drawing rules are still *true* on
ComfyUI's newer frontend. They were not, in three places. The contract was
read from the frontend's sources rather than inferred from behaviour:

| Upstream file (Comfy-Org/ComfyUI_frontend, `main`) | What it says |
| --- | --- |
| `src/composables/useVueFeatureFlags.ts` | `LiteGraph.vueNodesMode = settingStore.get('Comfy.VueNodes.Enabled')`, re-applied by a watcher — so the flag changes on a live page. |
| `src/composables/useGlobalLitegraph.ts` | `window.LiteGraph = LiteGraph`, so the flag is reachable from an extension. |
| `src/renderer/extensions/vueNodes/components/LGraphNode.vue` | Each node is `<div class="group/node lg-node absolute" data-node-id=…>` positioned by `transform: translate(x, y)`; no `left`/`top`. |
| `src/components/graph/DomWidgets.vue` + `widgets/DomWidget.vue` | DOM widgets live in `[data-testid="dom-widgets"]`, one `.dom-widget` per widget, `visible` from the node's own visibility; the wrapper is positioned in client pixels. |
| `src/composables/element/useCanvasPositionConversion.ts` | `client = (graph + offset) * scale + canvasRect.left/top` — the arithmetic the tracker's ownership maths inverts. |
| `src/scripts/domWidget.ts` | `addDOMWidget` defaults `hideOnZoom: true`; `BaseDOMWidgetImpl.draw` paints a placeholder when that and low quality are both set. |
| `useNodeImage.ts` / `useNodeAnimatedImage.ts` | Core video and animated previews pass `hideOnZoom: false` and never surface in a Vue node. |
| `LGraphCanvas.drawNode` (LiteGraph) | Returns immediately when `LiteGraph.vueNodesMode` is true. |

What that means for this tool, and what had to change:

| # | Finding | Evidence | Fix |
| --- | --- | --- | --- |
| 1 | **The stand-in engine was aimed at nodes the canvas never draws.** `lodFlatNode` already refused every node in Vue mode (correctly), so `lodFlatOn` was true, `lodSnapOn` was true, and the once-a-second lane still walked the graph queueing captures. A capture there draws nothing, so it would be written off as "draws nothing into the canvas" and blocked for the session — a dead end that also polluted the counters. | Reproduced in the fixture: 4 captures queued from `runFinish` alone. | `lodSnapOn()` returns false when the renderer is Vue nodes, with the reason in the code and in the Status line; the enqueue path inherits the guard. Test: *"the stand-in engine does not photograph nodes this renderer cannot draw back"*. |
| 2 | **The readout blamed the wrong thing.** With flattening switched on and the zoom below it, the Status tab said "snapshots are on but not painting anything: they replace flat boxes, so they need the flatten setting above switched on" — the opposite of the truth — and the flat line offered "collapsed boxes or this tool's own node" as the reason for `0 of 3` nodes flattened. | Panel text in the fixture before the fix. | A Vue-nodes sentence in the Status readout (renderer named in the first line, idle settings explained where their numbers would be) and the same in the copyable report. Test: *"the panel names the renderer instead of blaming the flatten setting"*. |
| 3 | **The DOM half did work whose answer was guaranteed to be "nothing changed".** With only node flattening switched on, the once-a-second sweep still built the registry and the per-frame pass still walked it; in Vue mode a flat decision cannot mark anything. | `lodSweepDom` / `viewApplyFocus` had no renderer awareness. | One predicate, `lodDomWanted()`, used by the sweep, the frame plan, the settings-apply path and the switch-on path: the focus half (widgets stop answering, the fovea) counts, the stand-in half only counts when this renderer draws nodes. Tests cover both halves — including a component widget (a 3D viewport), which is only reachable through the DOM widget layer. |
| 4 | **A warm cache survived the switch into this renderer.** The slice that drains the capture lane already stopped when the engine was off, but the bitmaps it had already taken (and a queue with work in it) stayed in memory for a page that can never paint them — a renderer switch is not a reload. | Reproduced: two held bitmaps and their bytes stayed after `enterVueNodes()`. | The slice releases the cache on that transition, the same release as switching the setting off, and counts it as a clear. Test: *"a page that switches to this renderer hands back the pictures it can no longer paint"*. |
| 5 | **Nothing pinned the flag to the live page.** A rule that latched the renderer at load would look correct in every test that sets the mode once. | — | The flag is read per call, and a test switches the renderer back *on the same page* and holds flattening and the picture engine to returning. |

### Do stand-ins work *in* the Vue-nodes renderer? Boxes that carry the node

This was asked twice: first whether it could work at all (v2.5.5: no, and the
settings said so), then — after the frontend's own sources settled the mechanics
— whether a second pathway could make the same settings act there, chosen
automatically. **It can, and since v2.6.0 it does** — and since v2.6.1 the boxes
it draws carry the node's own content — with one thing that remains impossible
(a photograph of the node) and a mechanism that is deliberately not the canvas
renderer's.

**What is impossible, and stays impossible: a photograph of the node.** The
canvas renderer takes one by drawing the node into an offscreen canvas through
its own `drawNode` seam — LiteGraph draws the node, so the tool gets a real
screenshot for free. In this renderer `drawNode` draws nothing (it returns after
`_setConcreteSlots()` and `arrange()` — `LGraphCanvas.ts`) and the node is a DOM
element, and **no browser API draws a DOM element into a canvas**: not
`drawImage`, not `createImageBitmap` (its source list is images, video, canvas,
blobs and ImageData), not `captureStream`. The two routes that exist are worse
than they look. An SVG `<foreignObject>` serialisation (what the DOM-to-canvas
libraries do) cannot load the images that matter: an SVG used as an image may not
fetch external resources, so the node's previews — the whole point — come back
blank unless every image is fetched and inlined as a data URL first. A vendored
DOM-to-canvas library would buy a real picture at the cost of the project's
zero-dependency property, plus per-node serialisation cost on the idle lane, and
it would still mis-render theme variables, shadows and cross-origin images. So
the *offscreen* half — stored pictures, the capture resolution, the RAM budget,
the disk cache — stays idle here and the readout says why. The tool does not
pretend the setting is broken, and it does not pretend a synthetic chrome is a
photograph.

**The user's report, reproduced and explained: text nodes had content, nothing
else did.** The symptom was precise — "some custom text nodes and CLIP Text
Encode (Prompt) seem to have them but nothing else" — and the upstream sources
say why, exactly.

| Route a node's content takes to the page | In the Vue-nodes renderer | What a box could see |
| --- | --- | --- |
| **DOM widgets** (`multilineTextarea` for a prompt, anything added with `addDOMWidget`): the widget owns an element | `WidgetDOM.vue` mounts `widget.element` **into the node's DOM** (`domEl.replaceChildren(widget.element)`) | `node.widgets[i].element` — the widget route. **Text worked from the first pass.** |
| **Canvas-drawn widgets** (the image preview: `ImagePreviewWidget.drawWidget` → `renderPreview(ctx, node, y, computedHeight, node.imgs, width)`) | Registered `surfaces: { canvas: 'shown', vueNode: 'never', panel: 'never' }`, so the Vue renderer mounts it **nowhere**, and `drawNode` returns before drawing widgets — the canvas does not draw it either | nothing: no element, and the canvas is blank. This is why image nodes had no picture. |
| **The frontend's own Vue preview** (`ImagePreview.vue`): `<img>` elements inside the node's DOM, one per image, grid or single view | Rendered **inside the node's element** | not through a widget — but reachable by walking the node's own element, which is the fix. |

So the shape of the bug: the canvas renderer's *capture* never had this problem
(the canvas-drawn widget puts the images on the canvas, and the capture takes the
canvas), and a Vue box could not see them because it looked only where widgets
put things. What it needed was to look where the *node* puts things.

**The fix (v2.6.2).** `lodVueMediaBoxes` walks the node's own element for `img`
and `canvas` children and draws them in the box at the position the browser laid
them out in. Two properties make that honest rather than clever: the stand-in
mark keeps every box intact (v2.6.2 blanked with `opacity: 0`; since v2.6.6 the
children are `visibility: hidden`, which keeps the layout *and* stops the paint),
so the layout is readable while a node is a stand-in;
and the node's element and its children sit in the frontend's one transformed
pane, so the difference between two client rects divided by the zoom is a
distance in graph units (`(childRect - rootRect) / scale`, minus the title bar the
node's element starts above the node's origin). The read happens on a change —
zoom, node position, node size, the elements and their sources — with a 400 ms
backstop for a child that resized on its own, so the steady state is one key
comparison per drawn box and no layout read at all (pinned by a test that counts
layout reads). Elements the widget route already drew are skipped, so an image
shown by both routes is drawn once. The content is clipped to the node's box,
because nothing spills out of a node.

**The node's structure is part of the node (v2.6.6).** A picture built from text
and media alone has no surface under it: the node's coloured frame, its header bar
(the one that carries the title), the body panel inside it and the connection dot
of every slot are DOM elements with a box and a computed colour like everything
else, so they are read in the same single measurement — the frontend's own
`[data-testid=node-inner-wrapper]`, `node-header-<id>`, `node-body-<id>` and
`.slot-dot` — and drawn by the same ink function the live box and the capture
share (`lodVueChromeBoxes` → `lodVueChromeInk`), biggest first, each rounded the
way the browser rounded it. A node with no header (a reroute) simply has no
header box to draw. This is what the user was describing as "semi, not fully
there": the stand-in was the node's *content* with no node around it.

**What the boxes carry instead, and why that is the honest maximum.** A node's *content* is not chrome: an image preview is an `<img>` (or, in the
canvas renderer, an image drawn by a widget), a mask editor or a 3D viewport is a
`<canvas>`, a prompt is a `<textarea>` whose value is text. Those things *are*
drawable, and they are what a person recognises a node by at 10% zoom. So the box
stands in at the picture level — title bar, error ring, progress, dimming — with
the node's own content drawn into it, live, from whichever route the content took
to the page (the table above): the widget route for elements a widget owns, the
layout route for everything the node renders itself. It needs no signature, no
invalidation and no idle lane — a dropped-in image or a typed word appears on the
next drawn frame by itself. What it is not is a screenshot: it is the node's own
pixels where they exist (an `<img>`/`<canvas>` blitted pixel for pixel) and the
tool's drawing where they do not (text re-painted from the value a field holds, a
pack's HTML blank and counted), and the readout says exactly that.

**How the blanking works.** The two things that do exist are the node's element
and the canvas, so the stand-in is made of those:

1. **The element is marked** — an attribute on the element the frontend renders
   the node into (`data-ants-vue-standin`), carrying two `!important` rules: the
   element's own box is `opacity: 0`, and its **children are
   `visibility: hidden`** (v2.6.6; until then the attribute carried `opacity: 0`
   alone, which takes no paint away at all — see the ninth-report section below). **Not a class**: `LGraphNode.vue` binds `:class`
   on that element (`cn('group/node lg-node absolute isolate touch-none text-xs', …)`)
   and Vue rewrites `class` wholesale on every re-render, so a tool-added class is
   dropped within a frame or two and the node comes back visible *behind* its box.
   That was the actual state of the v2.6.0–v2.6.2 pathway on a live page: the box
   was painted, and the node was painted too. The same reasoning moved the fovea's
   hide mark and the inert mark on a node's own element to attributes
   (`data-ants-dom-hidden`, `data-ants-dom-inert`); widget wrappers, which Vue does
   not own, keep their classes. The mechanism was chosen for what it does *not*
   do: the element keeps its layout box, keeps its children (slots, widgets,
   resize handles — *kept* means kept in the DOM and in layout), and its own box
   keeps its pointer events, so selecting and dragging a node behave as they do in
   full detail; a slot's dot is the one child re-shown inside the hidden subtree,
   because that is where a link drag starts (`SlotConnectionDot.vue` carries the
   pointerdown) and the canvas renderer keeps linking through its canvas hit test. What it *does* is take the paint away: an
   engine skips a hidden subtree in the paint phase, so a stand-in costs the
   frontend nothing to draw while everything the tool measures still answers. The
   trade is stated rather than hidden — a widget *inside* a stand-in no longer
   receives its own clicks at that zoom, and the node's accessibility-tree entry
   is that of a hidden subtree. (`display: none` would collapse the box;
   `content-visibility: hidden` would take the subtree's layout away with the
   paint and blank the rects the frontend's own `useVueNodeResizeTracking.ts`
   reads; a hidden subtree is the one that keeps them.)
2. **The canvas paints the box in its place.** LiteGraph still calls `drawNode`
   for every visible node in this renderer (line ~5204: `ctx.translate(px, py)`
   then `this.drawNode(node, ctx)`, with `drawNode` returning early), so this
   tool's existing seam fires with the context already in node-local space and
   the box lands exactly where a picture lands in the canvas renderer — the same
   detail ladder, the same colours, the same progress bar and error ring.

**Why this is the right target — and how v2.6.6 turned the claim into a
mechanism (the correction is in the ninth-report section below).** The frontend's
own `useTransformState.ts` states its design: all nodes live in one transformed
container, "O(1) transform updates regardless of node count", so panning and
zooming are already compositor work; what a zoomed-out heavy graph then spends its
frame on is node pixels. The canvas renderer's saving (cheaper *canvas* drawing)
does not exist in this renderer — its `drawNode` draws no node chrome at all — so
the only saving available here is the frontend's own DOM painting, and a stand-in
has to make the browser skip it. v2.6.5 measured the tool's own per-frame cost
down to zero and correctly noted that `opacity: 0` takes no paint away; the honest
reading of that was not "therefore nothing can be claimed", it was "therefore the
mark is the wrong mark". Since v2.6.6 the node's contents are `visibility: hidden`
(an engine skips a hidden subtree's paint) while the element stays in the layout,
in the observers and hit-testable, and the count of nodes whose paint the frontend
no longer owes (`vuePaintSkipped`) is in the readout beside the measured cost:
with the stand-ins on, a frame writes nothing, reads no layout, runs no DOM query
and reads no computed style (at 40, 60 and 150 nodes), a held picture means the
node's content is not re-drawn every frame, and the node's DOM painting is not the
page's work any more. What page JavaScript still cannot measure is the rasteriser's
own bill on a given machine — that is the frame budget's, the Stalls tab's and
DevTools' paint flashing's job on that page. Same setting, same threshold, same
boxes, two different mechanisms — and one honest claim each.

**Pictures too, and the disk files with them (v2.6.3).** The mistaken belief that
a Vue-nodes stand-in cannot have a picture was never about the browser: it was
`lodSnapBitmaps()` returning `false` in that renderer, which switched off the
capture, the mip chain and the disk write together — the user's test (empty the
thumbnails folder, switch to Nodes 2.0, watch it stay empty while legacy
repopulates instantly) is what that looks like from outside. Bitmaps are allowed
in both renderers now, and `lodSnapRender` paints a Vue capture with
`lodVueCapturePaint` instead of calling LiteGraph's `drawNode`: the box, its title
bar and state marks, the widget text the frontend mounts as DOM, and the node's
own `<img>`/`<canvas>` elements at the rows the layout gave them, drawn into the
same surface. Everything downstream is then identical — ratio ladder, mips, RAM
budget and the `…r<ratio>t<theme>` disk key — so the folder repopulates in Nodes
2.0 exactly as it does in legacy. A picture is not carried across a renderer
change: the pathway change clears what was held and makes them again, because the
box, the padding and the content route all differ.

**The box is the element's box, not the graph size.** `LGraphNode.vue` renders an
image node with `IMAGE_PREVIEW_HEIGHT_RESERVE` (`220 + 8 + 4`, from
`imagePreviewLayout.ts`) added to its height when it shows a picture and has an
expanding widget, and `imagePreviewGrowth` is subtracted from the layout height on
resize — so the DOM is genuinely taller than `node.size`, and the picture lives in
the overhang. A stand-in built from `node.size` blanked the node and then clipped
off the picture being looked for: the second live-page reason for "boxes only, no
images". The element's own rect is the measurement now (`rect.height / zoom −
title`), clamped to a sane band around the graph size.

**And the zoom used to convert it is measured, not assumed.** A capture sets
`canvas.ds.scale = 1` so the picture is zoom-free, but the DOM keeps whatever
transform the frontend gave it; dividing the element's client-pixel rect by that 1
produced node-local numbers scaled by the current zoom — an image measured at 10 %
zoom came out a tenth of its size, off the top edge of its own box. The zoom is
now derived from the element's own width over the node's width in graph units, so
it is the DOM's real zoom whatever the canvas is set to at that instant.

**The layout read is one per node, rationed.** Every number stored is node-local,
so the cache key is the node's own size — deliberately not the pan or the zoom,
which cancel out of `(childRect − rootRect) / zoom`. Panning and zooming therefore
cost no layout read at all, and the 400 ms backstop refresh (for a child that
resized on its own) is rationed to a few node layouts per frame, so a graph with
hundreds of boxes cannot turn it into a forced layout per node per frame — the
frame budget this whole tool exists to protect. A first measurement per node and
every capture read unconditionally.

**Guarantees that make it safe.** A box is painted only for an element this tool
has really blanked: a node whose element cannot be reached keeps its own drawing
(two pictures of one node is the one outcome worse than no stand-in). Every
blanked element is handed back when the zoom leaves the threshold, when the
setting or the tool is switched off, when the renderer changes, and on an error
path — the per-frame plan compares one boolean in the steady state, so nothing
walks the graph per frame and a stale mark cannot survive a frame. An element the
frontend unmounted mid-flight (the whole pane is `v-if`) has its mark taken off
too — the element the tool last dressed is remembered for exactly that — so an
element Vue puts back later cannot come back invisible.

**The eighth report: stand-ins that cost frames, and pictures taken too early
(v2.6.5).** Measured on the harness before anything was changed; each half had a
cause, and each cause has a test.

*The frame cost was the tool's own per-frame work.* Counted in the
Vue-nodes renderer, steady state, before the fix: at 40 boxed nodes **40
attribute writes a frame** — every one of them a re-write of a mark that had not
changed — **82.4 DOM queries** (80 of them `el.querySelector("video")`, once per
widget per node: subtree walks) and **2.4 layout reads**; at 150 nodes 150 /
302.1 / 4.5. With stand-ins off all of those numbers are zero, which is what made
the drop visible to the user in the first place.

1. **An attribute write is not free, even when the value is unchanged.** Blink
   and WebKit run the attribute-changed path — observable side effects and style
   invalidation — for a data attribute written with the value it already has
   (WebKit bug 115116; a client that skipped the no-op write reports 500 layouts
   → 0 and 30.7 → 6.9 ms over 1000 elements). The blanking mark now reads
   `hasAttribute` first and is written only on the transition
   (`LOD.vueDomWrites` counts it). A CSSOM style *declaration* set to its current
   value, by contrast, is collapsed and ignored — but the mark cannot be a style,
   because Vue owns the element's `style` and rewrites it.
2. **The video verdict was a poll.** "Does this node hold a `<video>`?" is a
   question about elements, and elements do not change without a DOM change; it
   is cached per node (`LOD.snapVideo`) for 100 ms on a page without the
   observers and for 30 s on a page with them, where the change itself drops the
   verdict, and a capture still probes fresh — a video must never be
   photographed.
3. **The measurement was polled too.** The element's layout was re-read on a
   400 ms beat (800 ms while a picture was held) for every boxed node, forever.
   The page already knows when it changes: one `ResizeObserver` over the node's
   element and the elements inside it, one `MutationObserver` over its children
   and text, and a report drops that node's measurement, which the next frame
   re-takes through the same per-frame ration (`LOD_VUE_MEDIA_BUDGET`).
   Attributes are deliberately not observed: the frontend rewrites `style` and
   `class` on hover, on selection and on every pane gesture. A watched node keeps
   a 5 s insurance read for the change no observer reports; a page without the
   observers keeps the old beat. **After: 0 / 0 / 0 per frame** at 40 nodes, at 60
   (60/122/2 → 0/0/0) and at 150 (150/302.1/4.5 → 0/0/0), leaving the blits as the
   tool's only per-frame cost.
   The one caveat, stated because it is measurable: a `ResizeObserver` does not
   fire for a transform, so panning and zooming still cost nothing (the stored
   numbers are node-local), which the harness models by laying its fixture out
   inside `withQuiet`.

*The early picture was two numbers that should have been one.* The signature
mixed the node's fields, its media and its text, but not **the height the
frontend actually rendered the element at** — so a node whose content arrives a
moment after its element (every node on a real page: a title, a label, a preview)
kept the first, bare picture for the session. And a capture sized its surface
from the *cached* measurement while reading the ink from a *fresh* one, so
content that arrived between the two was painted at an origin the surface did not
cover. The signature now mixes the element's rendered height, the widget rows and
the text lines, and a capture takes **one** measurement —
`lodVueRootMetrics(node, canvas, true)` → `lodSnapGeometry(node, canvas, dom.boxH)`
— so the surface, the box and the ink all come from the same number. Widget
content is drawn in **the box the browser laid it out in** (`lodVueWidgetBoxes`,
`w.element`/`w.inputEl` when the frontend has mounted it inside the node's own
element, as `WidgetDOM.vue` does) with the canvas row as the fallback for the
renderer that authors those rows itself.
*Evidence:* `/tmp/grow4.mjs` (before: an element grown 420 units, with content in
the new part, left the old picture standing and the old surface 110 units tall;
after: `invalidated 1 captured 2`, surface 608 px, content drawn at y 470) and the
two new tests, which assert the surface height and the painted row rather than
the intent. Ten anchored mutations were run; nine are caught (listed in
`CHANGELOG.md`), and the tenth — passing the just-measured height to the geometry
or letting the geometry read it from the cache — is *semantically equivalent*
because the fresh measurement is cached first, so it is recorded as such instead
of being claimed as bound.

**The element is watched, not assumed to stay put.** The frontend replaces a
node's element while the node stays boxed (a re-render, a remount after the pane
is rebuilt), which is the state the v2.6.3 report came from. `lodVueBlank`
already re-looks-up the element by `data-node-id`; v2.6.5 also re-registers the
watchers on whichever element it finds (`lodVueWatchKeep`), so a change inside
the *new* element drops the measurement at once rather than waiting for the
insurance read, and the measurement taken from the element that is gone goes with
it (`hit.root !== root` re-measures). Pinned by a test that replaces the element,
draws one frame, appends a line to the new element and asserts the picture is
re-made. The harness grew `vue.replaceRoot(node)` for it, which moves the node's
media into the new element exactly as the frontend does.

**The seventh report: pictures that were boxes, and a canvas that flickered
(v2.6.4).** Both defects named in it were reproduced or located in the sources
before anything was changed.

*In the Vue renderer the pictures now existed but "were captured box previews",
and in the canvas workspace there were "cached boxes only, no proper
stand-ins", which the tracker reported as in use.* Four causes, all fixed:

1. **The picture had no text in it.** A box, a title bar and (at best) an image
   is most of what a user calls a box. In this renderer the node's text *is* DOM
   text and cannot be photographed — but every string, its laid-out box and the
   styles the browser computed for it are readable while the node is a
   stand-in (the mark takes the painting, never the box). `lodVueTextLines` reads them in the same
   single measurement the media pass already made, capped at
   `LOD_VUE_TEXT_MAX` = 16 lines of `LOD_VUE_TEXT_CHARS` = 80 characters, and
   `lodVueTextInk` re-paints each one clipped to its own box. The node's title
   is one of those lines — above the body, where the canvas draws a node's
   title — so the content clip in `lodPaintNode` now covers the title bar as
   well as the body; a clip on the body alone cut the node's name off its own
   picture. The live box and the capture call one function
   (`lodVueContentInk`) so the picture cannot drift from the box.
2. **The zoom a measurement is divided by was read from the wrong place.** The
   v2.6.3 rule was "the element's own width over the node's width in graph
   units" — but the node's *root* element carries only `min-width`
   (`g_LGraphNode.vue` gives only `min-width`; the declared width lives on
   `[data-testid=node-inner-wrapper]`), so the root's width is whatever its
   content needs rather than the width the frontend declared — and every number
   derived from a measurement taken at the wrong zoom (the box height, the media
   rows, the text) lands away from where it belongs. `lodVueDomScale` now asks in the order most likely to be
   right: the transform pane's own computed matrix (`scale3d(z,z,z)`, m11 — one
   number for the whole graph, written by `useTransformState.ts`), then the
   element that carries the node's declared width, then the root, and only then
   `canvas.ds.scale` — which a capture rewrites to 1 while the DOM keeps the
   frontend's transform. The readout names which one answered
   (`vueScale`/`vueScaleFrom`).
3. **A capture with no element was a bare box, stored as the node's picture.**
   The picture *is* the element; with it off the page (the frontend mounts only
   what it renders, and re-renders replace elements) the capture could only
   draw the box — and a box stored under the node's key is served to every
   later frame as if it were the node. `lodSnapCaptureNode` now refuses
   (`vueNoElement`), and the node keeps its live box until an element exists.
4. **The disk key could not tell the two renderers apart.** The key was
   `<signature>r<ratio>t<theme>`; the *signature* differed between pathways
   (that is what the cache is keyed on in RAM) but a file written from a drawn
   Vue picture could satisfy a canvas-renderer request and vice versa. The
   pathway is now part of both — the signature mixes it, and the file name ends
   `<pc|pv>` — so a picture is never served across renderers, and a file from
   before the token is re-made instead of trusted. This is the mechanism behind
   "cached boxes only" in the canvas workspace: the Vue-made box picture was
   being served there.

*Switching the stand-in mode to anything other than "picture of the node" made
every node flicker between box and full preview across the canvas.* The frame
plan and the draw loop asked two different questions: the plan wanted a
*picture* (`LOD.snapOn`), the draw loop only needed the zoom
(`lodFlatOn`). With any other mode the plan decided, every frame, that nothing
stood in — handing every blanked element back at the top of the frame — and the
draw loop blanked them again to paint the box, so any frame the frontend
rendered in between showed the node in full. One predicate
(`lodVuePathOn`) is now asked by both, and it deliberately does not mention the
picture setting: a box *is* a stand-in. The plan is idempotent, so in the steady
state it does nothing; the elements are handed back only when the pathway
genuinely stops (the tool or the flatten zoom goes, the renderer changes, the
node stops being flat). `/tmp` reproduction of the old behaviour, for the
record: `cleared="setting"` and `vueRestored` +3 on *every* frame with the mode
off — over a thousand redundant hand-backs a minute on a graph of three hundred
nodes. The reading of the same counters in the fixed build is
`cleared=""`, `vueRestored` unchanged, elements blanked, boxes drawn once per
node per frame. (No new tests here beyond the ones below — this was already
covered by the existing capture change tests.)

Five tests added, one of them twice over (the refusal has two halves):

* the node's own text — title and widget label — is painted in the live box and
  in the stored picture, at the node-local position the browser laid it out in,
  with the clip reaching into the title bar;
* a node whose element is off the page gets a box and no picture, both when the
  element never appeared and when it left between the blank and the idle lane;
* a stand-in mode that is not a picture leaves the stand-ins standing (no
  hand-back, no clear, no growth, the same boxes every frame) and switching back
  to pictures captures again;
* the zoom a picture is measured in follows the frontend's own transform pane
  and the same node-local geometry comes out at 10 % and at 40 % zoom;
* a picture drawn in one renderer is never served to the other, in either
  direction.

Mutation checks bind them: the plan requiring the picture setting → the
mode test fails; the text route skipped → the text test fails; the zoom back to
`canvas.ds.scale` → three tests fail (including the media-row ones); the
pathway token dropped from the key → three fail; the no-element refusal removed
→ the refusal test fails; the title-bar clip narrowed to the body → the text
test fails; the text keeping the title-bar offset → the text test fails.

**What is not verified.** The mechanism is verified against the frontend's
sources and the harness (thirty-seven tests now cover that renderer); it had not
been run against a live Vue-nodes page by this project when the fourth report
arrived, and that report is exactly why the defects above were invisible from
here — the harness put a class on an element nothing rewrote, it reported
pictures "off" in that renderer as a *decision* rather than a bug, and it had no
text in a node's element for a picture to omit. It has still not been run against
a live page by this project: the user's page is the live test, and the size of the saving on a real heavy graph is not measured here — the
tool's own frame budget and Stalls tab can measure it on the page. Two honest
nuances: while a node is a stand-in its accessibility-tree entry is that of a
hidden subtree, and a widget inside a stand-in does not receive its own clicks at
that zoom (the pointer lands on the node, which is what the picture shows there).

**The ninth report (v2.6.6): the paint was never taken away, and a picture could
be taken mid-render.** The user reported that the v2.6.5 fixes helped not at all —
performance unchanged, and the stand-ins still captured "in the same semi 'not
fully there' way" — and asked three things: give the capture a grace period, check
whether the capture tick rides the frontend's own tick and whether the frontend
redraws nodes in a staggered way, and, if that is the cause, build a capture
process of our own. All three were answered against the frontend's sources
(`LGraphNode.vue`, `NodeHeader.vue`, `NodeSlots.vue`, `NodeContent.vue`,
`ImagePreview.vue`, `useNodePointerInteractions.ts`, `useVueNodeResizeTracking.ts`,
`useTransformSettling.ts`) and the harness.

*The performance half was a wrong mark, not a missing optimisation.* v2.6.5 had
already driven the tool's own per-frame DOM work to zero (40/60/150 nodes: 0
writes, 0 layout reads, 0 queries), and the performance still dropped — so the
remaining cost could only be the frontend's own painting, which the mark was
supposed to remove and did not. `opacity: 0` keeps a subtree in the render tree
and keeps painting it. The engine honours the other property: `visibility:
hidden`, carried by the stand-in attribute's children (v2.6.6), while the element
itself keeps its place, its layout, its observers and its hit-testing — so a frame
at low zoom no longer owes the browser a single node's DOM paint, and the numbers
the tool reads (rects, text metrics, change reports) still come from the DOM. Two
consequences are recorded rather than glossed: `vuePaintSkipped` counts the nodes
the frontend no longer has to paint, and what a stand-in trades away is the
*painted* node — a widget inside a stand-in no longer takes its own clicks at that
zoom, and its accessibility entry is that of a hidden subtree.

*The timing half was ours, and the frontend's "tiers" are its mounting order.*
The frontend has **no per-node animation tick**: nodes are Vue components, the
transform is one property on one pane (`useTransformState.ts`), and the browser
paints them on its own schedule. What the frontend does have is an *assembly
order*: `LGraphNode.vue` mounts, `NodeSlots` syncs slot offsets in a watcher, the
layout store hands the size over, `NodeWidgets` renders the widgets, `NodeContent`
mounts the node's media and an image appears when it decodes, `LivePreview` covers
an executing node, `useVueNodeResizeTracking.ts` re-measures elements through a
shared `ResizeObserver` (and its own code comments note that the observer "can
repeat an unchanged entry"), and `useTransformSettling(…, { settleDelay: 256 })`
is the frontend's own notion of a transform having settled. So there are tiers —
of *rendering passes*, not of pixels — and the tool's capture does not ride them:
it runs on its own idle lane by design (running inside the frontend's frame is
what the lane exists to avoid). A capture that ran immediately after a change
therefore read the DOM between two of those passes: a picture of a half-built
node. The fix is a **settle window**: `LOD_SNAP_SETTLE_MS` (300 ms) opened when a
node is first drawn as a stand-in, re-opened by every change the page reports or
the signature notices, enforced as a gate in the capture lane (`lodVueSettleLeft`
→ `lodSnapTake`), scheduled to the moment the window opens rather than polled. A
burst of rendering now costs one picture at the end of it instead of one picture
per step, and nothing is read or written while a node is quiet.

*A capture process "of our own" is what the pathway already is — and it is the
only possible one.* Page JavaScript cannot screenshot a DOM element (no
`drawImage`, no `createImageBitmap`, no `captureStream`); the two library-shaped
routes (an SVG `foreignObject` re-render or an html2canvas-style re-implementation)
would re-rasterise the whole node tree on the CPU per capture — on a machine with
hardware acceleration off, that is the cost this pathway exists to remove — and
would still mis-render real stylesheets. What the tool does instead is a capture
of its own in the sense the user meant: it reads what the browser laid out
(every rect and text metric) and what the browser computed (every background
colour, border and radius), blits the pixels that exist (`<img>`, `<canvas>`),
re-paints the strings that exist, counts what it cannot draw, and — since v2.6.6 —
takes the frontend's own paint away while the picture stands in. That is
"screenshot the node the way the user sees it" by construction: the picture and
the live node can no longer disagree, because the live node is not painted.

*Five tests, and the mutations that bind them.* The new tests: the paint-skip rule
is in the stylesheet — the children hidden, the node's own box not, the slot dots
re-shown — and the element's layout is untouched (a box that changes inside a
stand-in is still reported); the picture carries the node's structure
(frame at the element's own rect, dots as arcs) both live and in the capture; a
widget's own row is in the picture at its measured box with the browser's radius,
in the live box and in the picture; a node is photographed only after the window
(nothing captured inside it, the lane reports the wait, the picture lands after
it); and a change re-opens the window (the picture is dropped, no replacement
inside the window, a fresh one after it). A ten-mutation battery was run over the
tracker — the gate bypassed, the re-arming removed, the structure not drawn, the
stylesheet rule removed, the slot dots not drawn, the first-time window never
opened, the structure reader reduced to the frame, the widget row's surface not
read, the widget rows not drawn, the slot-dot pointer exception removed — and
**all ten are caught**.

**The tenth report (v2.6.7): the picture was being taken away from the node, and
the reader was sized for a fixture.** The page snapshot — 75 nodes at 42 % zoom,
fps 83 with p99 19.6 ms and a 249 ms worst frame, 498 stalls totalling 32.1 s of
blocking of which 11.3 s is forced layout inside the frontend's own `renderFrame`,
stand-ins at 42 % reduced to flat boxes, and a readout that said "(no picture is
taken in this renderer)" beside "34386 served, 493 captured" — was read against two
harness probes that reproduced the mechanism exactly.

*The picture was dropped on every change.* The intent of dropping the bitmap on a
signature mismatch was "never show a stale picture"; the effect was that a node
whose value changes often enough is never anything but a box, because the bitmap is
thrown away the moment it is out of date — and the v2.6.6 settle window holds the
replacement back on top of that. One node, two strings rewritten every 400 ms, a
frame per step: `pictured` alternated 1/0 for the whole run. The picture of the
moment before is *complete*; it now stays up while the replacement is made
(`LOD_SNAP_STALE_KEEP_MS`, 2000 ms), the box comes back only past that (for
`LOD_SNAP_CHURN_HOLD_MS`, 2000 ms), and the node is still asked again rather than
written off. Through the whole engine (24 nodes at the user's zoom, 30 s of frames,
each node's values changing every 2 s): v2.6.6 painted a box in **1020 of 1800
frames**, v2.6.7 in **17**.

*The settle window could be slid shut forever.* It was re-armed by every change, so
a node rewritten more often than 300 ms was never photographed — and with the rule
above, such a node showed a box for as long as it kept changing. `lodVueChanged`
now carries the first change of the burst as well as the last, and
`LOD_SNAP_SETTLE_MAX_MS` (900 ms) lets the capture through: a grace period, not a
veto.

*One slow capture was a life sentence.* `dt > LOD_SNAP_SLOW_MS` (60 ms) called
`lodSnapBlockNode` — "it stays live for the session". On a CPU-only machine with a
30-row node that is a plain box forever, which is the shape the report shows. It is
a doubling cooldown now (10 s → 20 s → 40 s …, capped at 120 s), the node is always
retried, and the readout counts the cooldowns and says when the next try is.

*The reader was the size of the fixture.* `LOD_VUE_TEXT_MAX` 16,
`LOD_VUE_TEXT_CHARS` 80, `LOD_SNAP_DOM_MAX` 12, `LOD_VUE_CHROME_MAX` 32 and the
slot-dot sub-cap 24 describe a 12-row node, not a node people work in: a 30-row
node came out of the capture with its first sixteen labels and nothing else, which
is the "flat rectangles with values missing" the user reported. The caps are
256 / 400 / 96 / 128 / 96 now (probe: `fillText 60` where v2.6.6 drew 16, all 90 row
boxes drawn), the widget and text pass runs when a picture is made rather than on
every frame (DOM queries over the A/B window: 50562 → 14454; widget rows drawn
40824 → 4716), and a value that fits is no longer ellipsised by the row's own line
budget. Two readout statements were false and are fixed: the Vue paragraph's "(no
picture is taken in this renderer)" beside a serving count (a v2.6.0/v2.6.1
leftover — with snapshots on it now describes what happens, off it keeps the old
sentence), and the DOM-hiding count now names the boxed nodes it belongs to. Two
tests added, four rewritten from "the changed node is dropped" to the behaviour the
report asked for, and the sixteen-mutation battery is all caught.

**What this pass does not claim.** The tool's own per-frame DOM work is zero
(measured, steady state and churn), and the forced layout left in the report is the
*frontend's* own `renderFrame` re-measuring 75 live node subtrees — 11.3 s of
32.1 s. Our stand-ins keep those subtrees in layout deliberately: `visibility:
hidden` skips the paint, while `display: none` would remove the layout the
frontend's own resize and measure passes read. Making that trade would have to be
measured against a `display: none` variant first, on the user's own page, which is
the live test this project still does not have.

Two things the Nodes 2.0 pass confirmed rather than changed: the Vue node's
**root element is never hidden or inerted** (`via: "root"` records are exempt from
the stand-in classes, and only widget wrappers are marked), and the canvas
settings that still reach ink — link thinning, straight links, the idle cap —
behave identically in both renderers.

The fixture (`tests/harness.mjs`, `enterVueNodes()`) is built to the upstream
shapes quoted above: `data-node-id` roots, the `dom-widgets` layer,
client-pixel `left`/`top` with `transform: scale()`, and `drawNode()`
returning early. It is a model of the contract, not a browser: no real
Vue-nodes page was executed in this pass (see *Still open*).

## The stand-in pictures: what a capture actually contains, and where the cache went wrong

The user's report was specific: image loaders and mask editors show a stand-in
with the node's UI but no image in it, text nodes (including the default
`CLIPTextEncode`) show no text at all, and the capture resolution and the disk
cache do not behave when the setting changes. All of it was real, and one item
was worse than reported.

**Why a picture had no image and no text in it.** A node's widgets live in DOM
elements *over* the canvas in both frontends, and the canvas row under them is
blank: `BaseDOMWidgetImpl.draw` (`src/scripts/domWidget.ts`) paints a
`WIDGET_BGCOLOR` placeholder **only** when the frontend's own low-quality mode
is on, and otherwise draws nothing. So a capture — which is the canvas — was the
node's chrome and nothing else for exactly the node types that are *made* of DOM
content: a prompt textarea, an image preview (`<img>`), a mask editor or a 3D
viewport (`<canvas>`). The picture was honest and useless.

| # | Finding | Evidence | Fix |
| --- | --- | --- | --- |
| 1 | **A capture ratio below 1x was not honoured.** `lodSnapRender` (and the ink probe) clamped the ratio with `Math.max(1, ratio)`, so 0.25x and 0.5x — settings since v2.5.2 — were drawn at 1x. The budget had been asked to reserve a quarter of the memory, the picture was allocated sixteen times it, and the readout called it "0.25x". | A 248x192-unit capture at `snapRatio: 0.25` produced a canvas smaller than 100px after the fix and 248px before it. | One `lodSnapPixelRatio()` used by the render and the ink probe, so they cannot disagree about the surface. Test: *"a ratio below 1 is drawn at that ratio, not at 1x with a smaller name"*. |
| 2 | **The disk file was keyed by the node signature alone.** The signature deliberately leaves out the capture ratio and the theme (in RAM both changes clear the whole cache), but a file outlives both: a page starting at 0.25x loaded yesterday's 1x files under the same name — and because a record then existed, it never re-captured them; a page starting at 2x was served 0.25x pictures and never asked for better; a picture drawn in a light theme was served in a dark one. | The disk key test shows the same node asked for with the same signature at ratio 1 and 0.25 in one session. | The disk key is `signature + r<ratio> + t<hash of the theme constants>`, used by the ask, the save and the install's verification. A change of either re-keys, so the setting is followed in both directions. Tests: *"the file is written under the ratio and the theme it was drawn with"*, *"changing the capture resolution re-asks in both directions"*, *"a file for another ratio is a miss, and a file for this one is loaded and used"*. |
| 3 | **A disk-loaded record claimed `ratio: 1` whatever the file held** (`rec.ratio = 1`), so nothing downstream could ever tell what it was looking at — and the save path would have written a picture the budget had coarsened under the *setting's* name. | Both are visible in the record and in the file name. | The ratio comes out of the file's own key; a picture the budget forced coarser than the setting is not written at all ("a file says what is inside it"). Test: *"a picture the budget forced coarser than the setting is not written to disk"*. |
| 4 | **Nothing put the node's DOM content into the picture.** No compositing existed: images and text were simply absent, and `snapPartial` only told the user that the picture was "the canvas part only". | The capture's own draw calls, in the harness: no `drawImage` of the node's `<img>`, no text of a `<textarea>`. | `lodSnapDomInk` draws, after the ink probe and before the mip chain and the file: images and canvases pixel for pixel; a text field's value re-painted in the theme's widget colours (page JavaScript cannot screenshot rendered text — the readout counts those separately and says so); a pack's own HTML left blank and counted. Geometry is the frontend's own rule (`node.pos + margin`, `widget.y`, `width ?? node.width`, `computedHeight ?? 50`) from `DomWidgets.vue` — no layout read, and it still works while this tool's own class has the wrapper hidden, which is the state a flat node is in. Tests: the five in *"what a stand-in picture contains"*. |
| 5 | **Nothing made a picture stale when its DOM content changed.** The signature covered the node's fields and `node.imgs`, but not the elements: a new image in a loader widget or edited text in a field that had not synced could keep an old picture indefinitely. | The image-arrival test: the picture with a blank spot lived on until the element was hashed. | The signature covers what the elements are showing (an image's `src`/`complete`/size, a canvas's size, a text field's value). Test: *"a text widget's value is painted into the picture, and editing it makes a new one"* and the image-arrival half of the test above. |
| 6 | **A video node could be photographed.** A still picture of a playing video is one frame presented as if it were the node. | — | `lodSnapHasVideo` keeps a node with a video element (or one inside a widget's element) live for the session. Test: *"a node playing a video is never photographed, however idle it is"*. |
| 7 | **An eviction could not be satisfied from disk.** `lodSnapEvict` released a bitmap for budget without forgetting the "already asked" mark, so the node was re-photographed even though its file existed (the RAM purge already did this correctly). | — | The eviction forgets the mark, like the purge does. |

Honest limits recorded in the code and the docs: the text is re-painted, not
screenshotted; a picture containing an image from another origin is tainted by
the browser, which allows it to be blitted but not read back, so that one
picture works in memory and cannot be written to disk (it is not counted as a
disk failure either); a pack's own HTML widget stays blank; and a pack that
keeps its preview element off the widget list (`widget.element` /
`widget.inputEl` is the frontend's own contract) is not reachable. The lookup
follows the frontend's own routes — `node.widgets[i].element`, then a single
`img`/`canvas` inside that element — and draws nothing when either would be a
guess.

## Retired: things that could not work, and were taken out

- **The image-preview thumbnail ladder (v2.1.5).** It kept a second,
  downscaled copy of an image that is *already* a bitmap, per redraw, with
  its own cache, its own storage and its own zoom. The node stand-in
  superseded it in v2.5.0 because the picture of the node is the thumbnail:
  one mechanism instead of two, and no hidden second copy of the picture the
  user is looking at. The implementation was removed; what stays is the
  tombstone (`LOD.thumbZoom = 0`, `lowZoom.previews` →
  `{on:false, retired:true}`) so a saved record or an old script gets an
  answer instead of `undefined`, and three tests pin the fact that it cannot
  be switched back on (`tests/drawing.test.mjs:97`, `326-343`, `1397-1417`).
- **`linkStyle: "auto"`.** A link changed shape because a *node* setting
  crossed a threshold — the exact coupling that the three drawing settings
  are supposed to not have. A saved `"auto"` becomes `"spline"` with a note.
- **"Nodes under Npx".** A per-node pixel rule flips a node in and out of the
  stand-in while its own UI changes size under the pointer. It was replaced
  by a zoom, and a saved pixel value is translated once and shown as what it
  became.
- **Borrowing ComfyUI's frame-level low-quality flag.** It changed what the
  frontend painted (shadows, outlines) rather than only what this tool
  paints, so it could not be scoped to "a link's ink" or "a node's stand-in".
- **The `drawImage` monkey-patch.** It wrapped every blit on the page,
  including other extensions' own blits, which it could not attribute to
  anything — so its time was both double-counted and mislabelled. The node
  stand-in wraps the *node draw* instead, and nothing here patches
  `drawImage`. Related non-promises are stated as limits rather than built:
  a capture cannot leave the main thread (a worker cannot call `drawNode`),
  and the worker lane is kept for pure compute only, saying so when it falls
  back.
- **Dead helpers and constants** removed in the same pass: the unreachable
  boxify/previews toggles, the RAM-reload helper, `LOD.inNode`, the retired
  `img*`/`thumb*` state fields, `LOD_THUMB_*`, `VIEW_INERT_DEFAULT`,
  `SELF_SAMPLE_MS`, `MAX_LOAF_SAMPLES`. (`LOD.thumbZoom` is deliberately kept:
  it is the tombstone above, and tests read it.)

## Limits that are not bugs

The canonical list is the LIMITS block at the bottom of `web/tracker.js` and
is summarised in the README's "What this cannot catch": unnamed widget/Vue
draws, sampled redraw callers (~20/s), no GPU or per-extension VRAM from
page JavaScript, no memory/long-task APIs on Firefox, the scheduler's
inability to reach microtasks or browser-internal work, and the ≤100 ms
staleness of a snapshot signature. These are stated in the UI where they
apply, not just in the docs.

## Features that are honest but smaller than they look

- **The off-thread lane** (`Load` tab) is a working worker with a fallback and
  a deterministic self-test, but its only shipped job is that self-test plus
  the `__antsTracker.worker.offload` API — nothing the page does is actually
  moved off the main thread yet. That is deliberate and stated in the panel
  and the LIMITS block (Vue's render, the DOM and canvas drawing cannot leave
  the main thread; `plan.md`, Track G2, is where real work — aggregation —
  would go). It is not a false claim, but a reader should not expect a speed-up
  from it today.
- **The GPU tab's torch figures** come from ComfyUI's `/system_stats`, not from
  this tool; the per-extension attribution question it cannot answer is stated
  in the tab rather than approximated.

## Still open

- **Firefox and Safari behaviour** is design-verified, not run-verified here:
  the code paths that read `performance.memory` and long tasks are guarded
  and the panel prints "not available" instead of a number, but no browser
  other than the Node harness was executed in this pass.
- **The Vue-nodes stand-in has not been run against a live page *by this
  project*.** It is verified against the frontend's sources and the harness
  (thirty-nine tests), and its failure modes are contained by construction (a box
  only ever follows a real blanking, and every blanked element is handed back on
  the frame the setting stops applying) — but the user's page is the live test, and
  it has already caught four defects this harness could not: a class that Vue
  rewrote, the picture half switched off as if it were a decision, a picture with
  no text in it and a zoom measured off the wrong element, and — the seventh
  report — a plan that fought the stand-in setting once per frame. The size of the
  saving and the feel of a blanked-but-interactive node are things only a real
  heavy graph can show. The tool measures both: the frame budget, the Stalls tab
  and `lowZoom.snapshots.vueBlanked` / `vueBoxes` / `vueMedia` / `vueContent` /
  `vueText` / `vueScale` / `vueScaleFrom` / `vueRestored` / `vueCleared` /
  `vueUnreached` / `vueNoElement`, and — since v2.6.6 — `vuePaintSkipped` (nodes
  whose paint the frontend no longer owes), `vueChrome` / `vueChromeBoxes` (the
  node's structure drawn), `vueSettleMs` / `vueSettleArms` / `vueSettleHeld` (the
  settle window, and how many capture slices it held back), and — since v2.6.7 —
  `staleHeld` (pictures kept on screen while their replacement was photographed)
  and `cooldown` (slow-capture cooldowns entered).
- **The Vue box's media positions and its height come from layout**, read when the
  node's own size changes and otherwise at most every 400 ms, with those refreshes
  rationed per frame. Node-local numbers do not change with the camera (a pan is
  not a change, and a zoom is caught by the ration), so a pan reads nothing at
  all. A child that resizes with no signal at all (a font loading, a CSS
  animation) can therefore be drawn where it was for a while, and on a graph with
  hundreds of boxed nodes the ration spreads the refresh over a second or so. The
  alternative — reading layout every frame for every blanked node — is the cost
  this whole feature exists to avoid. A capture always reads fresh, and because
  the box a capture draws is sized from that same read, a picture can never
  disagree with the box it replaces.
- **A pack whose preview is a canvas *widget* with no DOM** (unlike the frontend's
  own preview, which renders `<img>` elements inside the node) still has nothing on
  the page for a Vue box or a Vue picture to carry: `surfaces: { vueNode: 'never' }`
  means the frontend mounts it nowhere and `drawNode` draws no widgets in that
  renderer, so nothing exists to draw. Such a node gets a box with its other
  content and no preview; the readout counts what it could not draw. Making it
  appear would mean the pack rendering DOM, which is the pack's decision, not this
  tool's.
- **A picture with a cross-origin image in it cannot be written to disk.** The
  browser taints the canvas; blitting still works, so the picture is used from
  memory, and the write is skipped without counting as a disk failure. Not
  exercised in this pass (the harness's images are all same-origin fictions).
- **A pack's *canvas-drawn* widget content is still invisible in the Vue-nodes
  renderer** — the widget has no element to walk and the canvas draws no widget,
  so a pack that draws its preview with `drawWidget` (as the frontend's own image
  preview does) shows a box with no picture there. The frontend's own preview is
  covered because the frontend also renders it in the DOM (`ImagePreview.vue`);
  a pack that does not gets nothing, and the box says so by being empty rather
  than by inventing ink. A pack that wants the box to carry its content can add a
  DOM widget; the tool cannot take what was never on the page.
- **A pixel screenshot of a Vue node is not obtainable** without a DOM-to-canvas
  library (or an SVG `foreignObject` trick), which would mis-render real
  stylesheets and cross-origin images, and which on a GPU-less machine would
  rasterise the whole node tree per capture — the cost this pathway exists to
  remove. What a stand-in *is* instead (since v2.6.3, structure included since
  v2.6.6) is the node re-drawn from the browser's own numbers: every rect and
  text metric the layout gives, every background colour the browser computed
  (a widget's own row included, since v2.6.6: the element the frontend mounts,
  drawn with its box, border and radius under the widget's text),
  every `<img>`/`<canvas>` blitted pixel for pixel, with the parts that are
  neither (a pack's own HTML) blank and counted. A screenshot of a node the
  browser no longer paints is also no longer needed: the picture is the only copy
  of that node on the screen. The remaining picture-shaped question — an `<img>`
  overlay positioned over a node — is not taken: it would add a per-frame
  transform copy per node to save less than the mark does (`plan.md`, Track K).
- **The console-attribution mode** (plan.md, Track L) is still unbuilt. The
  credit for the idea stands; the honest thing is that nothing in the shipped
  code depends on it.
- **Upstream differences** are deliberate and documented: this tool waits
  60 ms before it declares a capture too slow (upstream cuts at 32 ms), and
  it refuses a node by measurement ("whatever the canvas draws") rather than
  by an upstream list of node types.
